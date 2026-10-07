"""API 调试（仿 Postman）：服务端代发 HTTP 请求，绕开浏览器 CORS。

POST /api/http/send
    body: {
      method,                                  # GET / POST / PUT / PATCH / DELETE / HEAD / OPTIONS
      url,                                     # 完整 URL（查询串由前端拼好）
      headers: { "Key": "Value", ... },        # 含认证头与 Content-Type
      body,                                    # 字符串（GET / HEAD 忽略）
      timeout?,                                # 秒，默认 30，服务端夹到 1 ~ 120
      followRedirects?, verifySsl?, proxy?
    }
    resp: {
      ok, url, status, statusText, redirected,
      headers: [[k, v], ...],                  # 保留重复头（Set-Cookie 等）
      contentType, size, truncated, elapsedMs,
      encoding: "text" | "base64", text, bodyB64
    }

POST /api/http/export   导出成加密文件
    body: { requests, groups, password? }
        password 留空 = 用 .env 的默认口令（EXPORT_PASSWORD，留空回退 SECRET_SALT），
        此时 resp.keySource="default"，文件在本机导入时免输口令
    resp: { file, sensitive, keySource, count } # file 是完整的 JSON 文本，由前端落盘

POST /api/http/import   导入并解密
    body: { payload, password? }               # payload 可以是对象，也可以是文件原文
    resp: { requests, groups, decrypted, keySource }
    文件 keySource=default 时先试默认口令、失败再试传入的 password（改过 .env 的旧文件靠手输兜底）；
    密文解不开时回 400 + error_code="bad_password"（前端据此改为手输口令）

导出/导入的关键字段加解密见 services/ide/httpexport.py 与 services/common/export_crypto.py。
鉴权复用 auth.py 的 session（/api/* 未登录由 before_request 统一拦截）。
细节与安全约束见 services/ide/httpreq.py。
"""
import json

from flask import Blueprint, jsonify, request

from ... import config
from ...log import get_logger
from ...services.ide import httpexport, httpreq

_log = get_logger()
bp = Blueprint("httpreq", __name__)


def _default_export_password() -> str:
    """导出弹窗里不填口令时用的默认口令：.env 的 EXPORT_PASSWORD（留空回退 SECRET_SALT）。
    两者都没配就返回空串 —— 此时导出必须手填口令（空口令等于明文，不能默默放行）。"""
    return (getattr(config, "EXPORT_PASSWORD", "") or "").strip()


@bp.route("/api/http/send", methods=["POST"])
def api_http_send():
    data = request.get_json(silent=True) or {}
    url = str(data.get("url") or "").strip()
    if not url:
        return jsonify({"error": "请先填写请求 URL"}), 400

    method = str(data.get("method") or "GET").upper()
    headers = data.get("headers") if isinstance(data.get("headers"), dict) else {}
    body = data.get("body")
    body = "" if body is None else (body if isinstance(body, str) else str(body))

    res = httpreq.send(
        method=method,
        url=url,
        headers=headers,
        body=body,
        timeout=data.get("timeout") or 30,
        follow_redirects=bool(data.get("followRedirects", True)),
        verify_ssl=bool(data.get("verifySsl", True)),
        proxy=str(data.get("proxy") or ""),
    )
    if res.get("error"):
        return jsonify({"error": res["error"]}), 502

    _log.info("POST /api/http/send %s %s -> %s", method, url, res.get("status"))
    return jsonify(res)


@bp.route("/api/http/export", methods=["POST"])
def api_http_export():
    """把请求集合导出成 JSON 文本：关键字段用口令加密，其余字段保持明文。"""
    data = request.get_json(silent=True) or {}
    reqs = data.get("requests")
    if not isinstance(reqs, list) or not reqs:
        return jsonify({"error": "没有可导出的请求"}), 400
    if len(reqs) > httpexport.MAX_REQUESTS:
        return jsonify({"error": "请求太多（单次最多 %d 条）" % httpexport.MAX_REQUESTS}), 400

    password = str(data.get("password") or "")
    if not password:
        # 没填口令 → 用 .env 的默认口令（本机导入时免输口令）
        password = _default_export_password()
        if not password:
            return jsonify({"error": "服务端没有配置默认口令，请填写导出密码",
                            "error_code": "no_default_password"}), 400
        key_source = httpexport.KEY_SOURCE_DEFAULT
    else:
        key_source = httpexport.KEY_SOURCE_CUSTOM
    if len(password) > httpexport.MAX_PASSWORD:
        return jsonify({"error": "密码过长（最多 %d 个字符）" % httpexport.MAX_PASSWORD}), 400

    groups = data.get("groups")
    doc = httpexport.build_export(reqs, groups if isinstance(groups, list) else [], password, key_source)
    # 日志只记数量与口令来源：口令本身与请求内容（可能含令牌）都不落日志
    _log.info("POST /api/http/export %d 个请求，加密 %d 处关键字段（口令来源：%s）",
              len(reqs), len(doc["sensitive"]), doc["keySource"])
    return jsonify({
        "file": json.dumps(doc, ensure_ascii=False, indent=2),   # 落盘交给前端，服务端不碰文件系统
        "sensitive": doc["sensitive"],
        "keySource": doc["keySource"],
        "count": len(reqs),
    })


@bp.route("/api/http/import", methods=["POST"])
def api_http_import():
    """解析导出的文件并解开关键字段。只负责解码与清洗，合并进本机存储由前端做。"""
    data = request.get_json(silent=True) or {}
    payload = data.get("payload")
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except ValueError:
            return jsonify({"error": "文件不是合法的 JSON"}), 400
    if isinstance(payload, list):
        payload = {"version": 1, "requests": payload, "groups": []}   # 旧版导出格式：裸数组、全明文
    if not isinstance(payload, dict) or not isinstance(payload.get("requests"), list):
        return jsonify({"error": "这不是本工具导出的请求文件"}), 400

    reqs = payload["requests"]
    if len(reqs) > httpexport.MAX_REQUESTS:
        return jsonify({"error": "文件里的请求太多（最多 %d 条）" % httpexport.MAX_REQUESTS}), 400

    password = str(data.get("password") or "")
    if len(password) > httpexport.MAX_PASSWORD:
        return jsonify({"error": "密码过长（最多 %d 个字符）" % httpexport.MAX_PASSWORD}), 400

    # 候选口令按「文件声明的来源」排：
    #   · keySource=default → 先试 .env 的默认口令，失败再试用户手输的
    #     （中途改过 .env 的旧文件，用户手输「当时的默认口令」仍能救回来）
    #   · keySource=custom  → 只试用户手输的
    # 逐个试，全部密文都解开才算通过。
    source = str(payload.get("keySource") or "")
    candidates = []
    if source == httpexport.KEY_SOURCE_DEFAULT:
        default_pw = _default_export_password()
        if default_pw:
            candidates.append(default_pw)
    if password and password not in candidates:
        candidates.append(password)
    # 没有候选口令也要跑一遍：明文文件（旧格式 / 本次没有关键字段）用空口令即可通过，
    # 而真有密文时会在下面以 failed>0 收场，仍会落到「口令不正确」。
    candidates = candidates or [""]

    plain, stat = None, {"ok": 0, "failed": 0}
    for cand in candidates:
        plain, stat = httpexport.unseal_requests(reqs, cand)
        if not stat["failed"]:
            break
    if plain is None or stat["failed"]:
        # 整单失败：解不开就是口令不对（或文件被改过）。不能把「有的字段解出来、
        # 有的变成空串」的数据写进本机存储 —— 那样等于静默丢凭据。
        _log.warning("POST /api/http/import 解密失败（口令来源：%s，共试了 %d 个口令）",
                     source or "未标注", len(candidates))
        return jsonify({"error": "密码不正确，或文件已损坏", "error_code": "bad_password"}), 400

    out = httpexport.normalize_requests(plain)
    _log.info("POST /api/http/import 导入 %d 个请求，解密 %d 处关键字段（口令来源：%s）",
              len(out), stat["ok"], source or "明文")
    return jsonify({
        "requests": out,
        "groups": httpexport.normalize_groups(payload.get("groups")),
        "decrypted": stat["ok"],
        "keySource": source,
    })

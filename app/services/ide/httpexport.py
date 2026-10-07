"""API 调试的导出 / 导入：只加密「关键字段」，其余字段保持明文可读。

关键字段怎么认（字段名去掉 - _ 空格后小写，取子串匹配）：
    authorization / cookie / token / secret / password / passwd / apikey /
    accesskey / privatekey / credential / sessionid / signature / auth / jwt / bearer
覆盖面：请求头、URL 查询参数、表单字段、JSON 请求体（递归到任意层级），
       以及「认证」页签里的 token / 用户名 / 密码（这三个不看名字，一律加密 ——
       Basic 凭据常把 token 放在用户名位，例如 GitHub 的 user:token 组合）。

导入时反向解开的口径更宽：不看字段名，只要值以 encp:v1: 开头就解。
    这样手改过的文件、以后新增的关键字段名，都能正常还原。

两处「不讲精确」的地方，都是有意的：
  · JSON 请求体命中关键字段时，正文会按 2 空格缩进重新序列化（做不到只替换某些值
    又原样保留格式）；一处都没命中则一字不动，原格式完整保留。
  · JSON 正文不是合法 JSON（带注释 / 尾逗号）时定位不到单个字段，整段加密：
    宁可这一条读不了，也不能让 token 明文躺在文件里。

明文导出（旧版本生成的裸数组文件）仍可导入：里面没有密文，password 传空即可。

用哪个口令（文件里的 keySource 字段，只记「来源」不记口令本身）：
  · keySource = "default" —— 用的服务端 .env 默认口令（config.EXPORT_PASSWORD，
    留空则回退 SECRET_SALT）。同机导入时后端自己用默认口令解开，用户无需输口令；
    但如果中途换过 .env，旧文件仍需用户手输「当时的口令」。
  · keySource = "custom" —— 用户在导出弹窗里手填的口令，导入必须输同一个。
"""
import copy
import json
import re

from datetime import datetime, timezone
from urllib.parse import quote, unquote

from ...log import get_logger
from ..common import export_crypto

_log = get_logger()

FORMAT = "file-flask.api.requests"
VERSION = 2
CIPHER = "encp:v1"                  # 与 export_crypto._PREFIX 对应，写进文件元信息
MAX_REQUESTS = 2000                 # 单份文件最多接受的请求数（防止超大文件把内存 / 本机存储撑爆）
MAX_PASSWORD = 256
METHODS = ("GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS")
# 口令来源，写进文件的 keySource 字段：导入时据此决定「用服务端默认口令」还是「要用户输口令」
KEY_SOURCE_DEFAULT = "default"
KEY_SOURCE_CUSTOM = "custom"
_BODY_MODES = ("none", "json", "text", "form")
_AUTH_TYPES = ("none", "bearer", "basic")

# 关键字段名提示（小写、已去掉非字母数字，用子串匹配）。
# 改这里请同步前端导出弹窗里的说明文案（js/32 的 apiExportAll）。
_SENSITIVE_HINTS = (
    "authorization", "cookie", "token", "secret", "password", "passwd",
    "apikey", "accesskey", "privatekey", "credential", "sessionid",
    "signature", "auth", "jwt", "bearer",
)


# ---------------------------------------------------------------- 通用小工具
def sensitive_key(name) -> bool:
    """字段名是否属于「关键字段」。"""
    if not name:
        return False
    key = re.sub(r"[^a-z0-9]", "", str(name).lower())
    if not key:
        return False
    return any(hint in key for hint in _SENSITIVE_HINTS)


def _text(value) -> str:
    if value is None:
        return ""
    return value if isinstance(value, str) else str(value)


# ---------------------------------------------------------------- 导出：加密
def _rows_seal(rows, password, labels, where):
    """按行加密（请求头 / 查询参数 / 表单）。未勾选的行也加密：
    它在浏览器里同样存着令牌，留在文件里一样是泄露。"""
    for row in rows or []:
        if not isinstance(row, dict):
            continue
        val = row.get("v")
        if isinstance(val, str) and val and sensitive_key(row.get("k")):
            row["v"] = export_crypto.seal(password, val)
            labels.append(where + " " + _text(row.get("k")))


def _url_seal(url, password, labels):
    """URL 里的查询串按「段」处理：只替换关键参数的值，其余原样保留，
    避免 parse_qsl + urlencode 往返把编码改写掉。"""
    if not isinstance(url, str) or "?" not in url:
        return url
    base, _, query = url.partition("?")
    if not query:
        return url
    parts, changed = [], False
    for seg in query.split("&"):
        key, sep, val = seg.partition("=")
        if sep and val and sensitive_key(unquote(key)):
            parts.append(key + "=" + quote(export_crypto.seal(password, unquote(val)), safe=""))
            labels.append("URL 参数 " + unquote(key))
            changed = True
        else:
            parts.append(seg)
    return base + "?" + "&".join(parts) if changed else url


def _json_seal(node, path, password, labels):
    """递归加密 JSON 里关键字段的值。"""
    if isinstance(node, dict):
        out = {}
        for key, val in node.items():
            child = path + "." + _text(key)
            if isinstance(val, str) and val and sensitive_key(key):
                out[key] = export_crypto.seal(password, val)
                labels.append("请求体 " + child)
            else:
                out[key] = _json_seal(val, child, password, labels)
        return out
    if isinstance(node, list):
        return [_json_seal(v, path + "[" + str(i) + "]", password, labels) for i, v in enumerate(node)]
    return node


def _body_seal(body, password, labels):
    if not isinstance(body, dict):
        return
    mode = body.get("mode")
    if mode == "form":
        _rows_seal(body.get("form"), password, labels, "表单")
        return
    if mode != "json":
        return                      # text / none：没有任何字段名可依据，无从判断哪里是凭据
    raw = body.get("raw")
    if not isinstance(raw, str) or not raw.strip():
        return
    try:
        node = json.loads(raw)
    except ValueError:
        body["raw"] = export_crypto.seal(password, raw)
        labels.append("请求体（整段：不是标准 JSON）")
        return
    hits = []
    node = _json_seal(node, "$", password, hits)
    if hits:                        # 一处都没命中就别动，保住用户原本的格式
        labels.extend(hits)
        body["raw"] = json.dumps(node, ensure_ascii=False, indent=2)


def _req_seal(req, password, labels):
    _rows_seal(req.get("headers"), password, labels, "请求头")
    _rows_seal(req.get("params"), password, labels, "参数")
    req["url"] = _url_seal(req.get("url"), password, labels)
    _body_seal(req.get("body"), password, labels)
    auth = req.get("auth")
    if isinstance(auth, dict):
        kind = auth.get("type")
        if kind == "bearer" and auth.get("token"):
            auth["token"] = export_crypto.seal(password, auth["token"])
            labels.append("认证 token")
        elif kind == "basic":
            for field, label in (("username", "认证 用户名"), ("password", "认证 密码")):
                if auth.get(field):
                    auth[field] = export_crypto.seal(password, auth[field])
                    labels.append(label)


def build_export(requests, groups, password, key_source=KEY_SOURCE_CUSTOM, now=None):
    """返回要写入文件的 dict。deepcopy 后再加密 —— 绝不改动调用方（本机存储）的数据。

    key_source 只记录「口令从哪来」（服务端默认 / 用户手填），不记录口令本身。
    """
    sealed = copy.deepcopy(requests or [])
    labels = []
    for req in sealed:
        if isinstance(req, dict):
            _req_seal(req, password, labels)
    stamp = (now or datetime.now(timezone.utc)).strftime("%Y-%m-%dT%H:%M:%SZ")
    return {
        "format": FORMAT,
        "version": VERSION,
        "exportedAt": stamp,
        "cipher": CIPHER,           # 关键字段用的密文方案；sensitive 为空表示本次没有任何字段需要加密
        "kdf": export_crypto.KDF_LABEL,
        "keySource": KEY_SOURCE_DEFAULT if key_source == KEY_SOURCE_DEFAULT else KEY_SOURCE_CUSTOM,
        "sensitive": labels,        # 只列字段名，不含任何值
        "groups": [{"id": _text(g.get("id")), "name": _text(g.get("name"))}
                   for g in (groups or []) if isinstance(g, dict)],
        "requests": sealed,
    }


# ---------------------------------------------------------------- 导入：解密
def _take(value, password, stat):
    """解一个值：不是密文原样返回。解不开就记一笔 failed，
    由调用方整单失败 —— 不允许「解了一半」的数据写进本机存储。"""
    if not export_crypto.is_sealed(value):
        return value
    plain = export_crypto.unseal(password, value)
    if plain is None:
        stat["failed"] += 1
        return ""
    stat["ok"] += 1
    return plain


def _rows_unseal(rows, password, stat):
    for row in rows or []:
        if isinstance(row, dict) and isinstance(row.get("v"), str):
            row["v"] = _take(row["v"], password, stat)


def _json_unseal(node, password, stat):
    if isinstance(node, dict):
        return {k: _json_unseal(v, password, stat) for k, v in node.items()}
    if isinstance(node, list):
        return [_json_unseal(v, password, stat) for v in node]
    if isinstance(node, str):
        return _take(node, password, stat)
    return node


def _url_unseal(url, password, stat):
    if not isinstance(url, str) or "?" not in url:
        return url
    base, _, query = url.partition("?")
    if not query:
        return url
    parts = []
    for seg in query.split("&"):
        key, sep, val = seg.partition("=")
        raw = unquote(val)
        if sep and val and export_crypto.is_sealed(raw):
            plain = export_crypto.unseal(password, raw)
            if plain is None:
                stat["failed"] += 1
                parts.append(seg)
            else:
                stat["ok"] += 1
                parts.append(key + "=" + quote(plain, safe=""))
        else:
            parts.append(seg)
    return base + "?" + "&".join(parts)


def _body_unseal(body, password, stat):
    if not isinstance(body, dict):
        return
    if body.get("mode") == "form":
        _rows_unseal(body.get("form"), password, stat)
        return
    raw = body.get("raw")
    if not isinstance(raw, str) or not raw:
        return
    if export_crypto.is_sealed(raw.strip()):
        body["raw"] = _take(raw.strip(), password, stat)        # 整段加密
        return
    if CIPHER + ":" not in raw:
        return
    try:                                                        # 正文是 JSON 文本，只有部分值被加密
        body["raw"] = json.dumps(_json_unseal(json.loads(raw), password, stat),
                                 ensure_ascii=False, indent=2)
    except ValueError:
        stat["failed"] += 1


def _req_unseal(req, password, stat):
    _rows_unseal(req.get("headers"), password, stat)
    _rows_unseal(req.get("params"), password, stat)
    req["url"] = _url_unseal(req.get("url"), password, stat)
    _body_unseal(req.get("body"), password, stat)
    auth = req.get("auth")
    if isinstance(auth, dict):
        for field in ("token", "username", "password"):
            if isinstance(auth.get(field), str):
                auth[field] = _take(auth[field], password, stat)


def unseal_requests(requests, password):
    """解开所有密文。返回 (明文请求列表, {"ok": 解开数量, "failed": 失败数量})。"""
    out = copy.deepcopy(requests or [])
    stat = {"ok": 0, "failed": 0}
    for req in out:
        if isinstance(req, dict):
            _req_unseal(req, password, stat)
    return out, stat


# ---------------------------------------------------------------- 导入：清洗
def _norm_rows(raw):
    """行数组规范化：丢掉非对象项，缺字段补空串，on 默认勾选。"""
    out = []
    for row in raw if isinstance(raw, list) else []:
        if not isinstance(row, dict):
            continue
        out.append({"on": bool(row.get("on", True)), "k": _text(row.get("k")), "v": _text(row.get("v"))})
    return out


def normalize_req(raw):
    """把外部文件里的一条请求清洗成本机的存储结构（白名单字段，多余的一律丢弃）。"""
    raw = raw if isinstance(raw, dict) else {}
    method = _text(raw.get("method")).upper()
    body = raw.get("body") if isinstance(raw.get("body"), dict) else {}
    mode = _text(body.get("mode"))
    auth = raw.get("auth") if isinstance(raw.get("auth"), dict) else {}
    atype = _text(auth.get("type"))
    return {
        "name": _text(raw.get("name"))[:200] or "导入的请求",
        "method": method if method in METHODS else "GET",
        "url": _text(raw.get("url")),
        "params": _norm_rows(raw.get("params")),
        "headers": _norm_rows(raw.get("headers")),
        "body": {
            "mode": mode if mode in _BODY_MODES else "none",
            "raw": _text(body.get("raw")),
            "form": _norm_rows(body.get("form")),
        },
        "auth": {
            "type": atype if atype in _AUTH_TYPES else "none",
            "token": _text(auth.get("token")),
            "username": _text(auth.get("username")),
            "password": _text(auth.get("password")),
        },
        "gid": _text(raw.get("gid")),        # 由前端按分组名映射成本地 gid
    }


def normalize_requests(requests):
    return [normalize_req(r) for r in (requests or []) if isinstance(r, dict)]


def normalize_groups(groups):
    """分组只要 id + 名字：导入时按名字复用本地已有分组，不搬折叠状态之类的展示状态。"""
    out = []
    for g in groups if isinstance(groups, list) else []:
        if not isinstance(g, dict):
            continue
        gid, name = _text(g.get("id")), _text(g.get("name")).strip()
        if gid and name:
            out.append({"id": gid, "name": name[:60]})
    return out

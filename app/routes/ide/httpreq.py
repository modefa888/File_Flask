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

鉴权复用 auth.py 的 session（/api/* 未登录由 before_request 统一拦截）。
细节与安全约束见 services/ide/httpreq.py。
"""
from flask import Blueprint, jsonify, request

from ...log import get_logger
from ...services.ide import httpreq

_log = get_logger()
bp = Blueprint("httpreq", __name__)


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

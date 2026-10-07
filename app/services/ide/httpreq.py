"""HTTP 请求调试（仿 Postman）的服务端转发。

浏览器里直接 fetch 第三方接口会被 CORS 拦下，所以统一由本服务代发请求：
  - 只允许 http / https，请求体按 UTF-8 编码；
  - 响应体最多读 5 MB，超出部分丢弃并置 truncated=true；
  - 文本按响应声明的 charset 解码；图片 / 音视频 / PDF 等二进制按 base64 回传；
  - 4xx / 5xx 仍当作「正常响应」返回（前端要展示状态码与响应体），
    只有网络层错误（DNS、连不上、超时）才返回 error。

注意：这是本地开发工具的「请求转发」，与 Postman 一样允许访问任意 http/https 地址，
没有做 SSRF 白名单，只依赖「必须已登录」这一层保护，并限制超时与响应体大小。
"""
from __future__ import annotations

import base64
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request

from ...log import get_logger

_log = get_logger()

MAX_BODY = 5 * 1024 * 1024          # 响应体读取上限：5 MB
MAX_TIMEOUT = 120                   # 单次请求超时上限（秒）
DEFAULT_TIMEOUT = 30

# 这些 content-type 视为二进制，按 base64 回传（前端可预览图片或下载）
_BINARY_PREFIX = ("image/", "audio/", "video/", "font/")
_BINARY_EXACT = (
    "application/octet-stream", "application/pdf", "application/zip",
    "application/gzip", "application/x-tar", "application/wasm",
    "application/x-7z-compressed", "application/vnd.ms-fontobject",
)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """不自动跟随 3xx：把重定向响应本身返回，前端可以看到 Location。"""

    def redirect_request(self, req, fp, code, msg, headers, newurl):   # noqa: D102
        return None


def _is_binary(content_type: str) -> bool:
    ct = (content_type or "").split(";")[0].strip().lower()
    if not ct:
        return False
    return ct.startswith(_BINARY_PREFIX) or ct in _BINARY_EXACT


def _pick_charset(resp, content_type: str) -> str:
    """从响应头解析字符集；解析不出来就回退 utf-8。"""
    charset = ""
    try:
        if getattr(resp, "headers", None) is not None:
            charset = resp.headers.get_content_charset() or ""
    except Exception:
        charset = ""
    if not charset and "charset=" in (content_type or "").lower():
        charset = content_type.lower().split("charset=")[-1].split(";")[0].strip().strip('"')
    return charset or "utf-8"


def send(method="GET", url="", headers=None, body="", timeout=DEFAULT_TIMEOUT,
         follow_redirects=True, verify_ssl=True, proxy="") -> dict:
    """代发一次 HTTP 请求，返回统一结构。

    成功：{ok, url, status, status_text, headers:[[k,v]], content_type, size,
           truncated, elapsed_ms, redirected, encoding, text, body_b64}
    失败：{error}
    """
    url = (url or "").strip()
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("http", "https"):
        return {"error": "仅支持 http / https 链接"}
    if not parsed.netloc:
        return {"error": "URL 不完整，缺少主机名"}

    method = (method or "GET").upper()

    try:
        timeout = int(float(timeout))
    except (TypeError, ValueError):
        timeout = DEFAULT_TIMEOUT
    timeout = max(1, min(MAX_TIMEOUT, timeout))

    hd = {}
    for k, v in (headers or {}).items():
        k = str(k).strip()
        if k:
            hd[k] = str(v)

    data = None
    if body and method not in ("GET", "HEAD"):
        data = body.encode("utf-8") if isinstance(body, str) else bytes(body)

    handlers = []
    # 显式传 ProxyHandler({})：否则 urllib 会读取环境代理变量，导致「直连」的预期落空
    handlers.append(urllib.request.ProxyHandler({"http": proxy, "https": proxy} if proxy else {}))
    handlers.append(urllib.request.HTTPRedirectHandler() if follow_redirects else _NoRedirect())
    if verify_ssl:
        handlers.append(urllib.request.HTTPSHandler())
    else:
        handlers.append(urllib.request.HTTPSHandler(context=ssl._create_unverified_context()))

    opener = urllib.request.build_opener(*handlers)
    req = urllib.request.Request(url, data=data, method=method, headers=hd)

    t0 = time.time()
    try:
        resp = opener.open(req, timeout=timeout)
    except urllib.error.HTTPError as e:
        resp = e                    # 4xx / 5xx：协议层正常返回，交给前端展示
    except Exception as e:          # URLError / socket.timeout / ssl.SSLError …
        return {"error": "请求失败：" + str(e)}

    try:
        status = getattr(resp, "status", None) or getattr(resp, "code", 0)
        reason = getattr(resp, "reason", "") or ""
        final_url = resp.geturl() if hasattr(resp, "geturl") else url
        raw = resp.read(MAX_BODY + 1)
    finally:
        try:
            resp.close()
        except Exception:
            pass
    elapsed = int((time.time() - t0) * 1000)

    truncated = len(raw) > MAX_BODY
    if truncated:
        raw = raw[:MAX_BODY]

    hdrs = getattr(resp, "headers", None)
    hlist = [[str(k), str(v)] for k, v in hdrs.items()] if hdrs else []
    content_type = ""
    for k, v in hlist:
        if k.lower() == "content-type":
            content_type = v
            break

    out = {
        "ok": True,
        "url": final_url,
        "status": status,
        "status_text": reason,
        "headers": hlist,
        "content_type": content_type,
        "size": len(raw),
        "truncated": truncated,
        "elapsed_ms": elapsed,
        "redirected": bool(final_url and final_url != url),
    }
    if _is_binary(content_type):
        out["encoding"] = "base64"
        out["text"] = ""
        out["body_b64"] = base64.b64encode(raw).decode("ascii")
    else:
        charset = _pick_charset(resp, content_type)
        try:
            text = raw.decode(charset, errors="replace")
        except LookupError:
            text = raw.decode("utf-8", errors="replace")
        out["encoding"] = "text"
        out["text"] = text
        out["body_b64"] = ""
    return out

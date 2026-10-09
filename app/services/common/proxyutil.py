"""出站请求的代理工具（「设置 → 网络/代理」、插件转发、API 调试与 Telegram 通知共用）。

统一支持这些代理写法（只填 host:port 时按 http 代理处理）：

    http://127.0.0.1:7890
    https://proxy.example.com:8443
    socks5://user:pass@127.0.0.1:1080     本机解析域名后连 IP
    socks5h://127.0.0.1:1080              域名交给代理解析

对外接口：
    normalize_proxy(raw)                校验并归一化代理地址（非法抛 ValueError）
    parse_proxy(proxy)                  -> (scheme, host, port, user, password)
    resolve_proxy(mode, proxy)          按模式解析最终代理：none / manual / system
    parse_no_proxy(raw)                 拆分「不走代理」列表
    host_bypasses(host, rules)          判断某主机是否命中例外（命中即直连）
    site_filtered(host, mode, rules)    网站过滤：黑名单拦截 / 白名单放行
    friendly_error(exc, url)            把网络层异常翻成中文提示
    http_status_text(code)              HTTP 状态码的中文说明
    build_opener(...)                   构建 urllib opener（含 SOCKS5、证书校验、重定向开关）

纯标准库实现，不依赖 PySocks / requests。
"""
from __future__ import annotations

import errno
import fnmatch
import http.client
import socket
import ssl
import struct
import urllib.error
import urllib.parse
import urllib.request

# 支持的代理协议；socks5 = 本机解析域名，socks5h = 交给代理解析
PROXY_SCHEMES = ("http", "https", "socks5", "socks5h")

# SOCKS5 协商失败时服务端返回码的中文说明
SOCKS5_ERR = {
    0x01: "一般性失败", 0x02: "规则不允许连接", 0x03: "网络不可达", 0x04: "主机不可达",
    0x05: "连接被拒绝", 0x06: "TTL 超时", 0x07: "代理不支持 CONNECT", 0x08: "地址类型不支持",
}


# ---------------------------------------------------------------------------
# 地址解析
# ---------------------------------------------------------------------------

def normalize_proxy(raw) -> str:
    """归一化代理地址；空字符串表示直连。写法不对时抛 ValueError（前端会弹提示）。"""
    s = str(raw or "").strip().rstrip("/")
    if not s:
        return ""
    if "://" not in s:
        # 只填 host:port 时按 http 代理处理，省得用户记协议名
        s = "http://" + s
    u = urllib.parse.urlsplit(s)
    if u.scheme.lower() not in PROXY_SCHEMES:
        raise ValueError("代理地址只支持 http:// https:// socks5:// socks5h:// 开头（当前是 %s://）" % u.scheme)
    if not u.hostname:
        raise ValueError("代理地址缺少主机名，应形如 http://127.0.0.1:7890")
    if not u.port:
        raise ValueError("代理地址缺少端口，应形如 http://127.0.0.1:7890")
    return s


def parse_proxy(proxy: str):
    """拆出 (scheme, host, port, user, password)；scheme 全小写。"""
    u = urllib.parse.urlsplit(proxy)
    scheme = u.scheme.lower()
    port = u.port or (1080 if scheme.startswith("socks") else 8080)
    user = urllib.parse.unquote(u.username) if u.username else ""
    pwd = urllib.parse.unquote(u.password) if u.password else ""
    return scheme, (u.hostname or ""), port, user, pwd


def resolve_proxy(mode: str = "", proxy="") -> str:
    """按「设置 → 网络/代理」里的模式解析出最终要用的代理地址。

    mode: none   → 直连（返回空串）
          system → 读环境变量 http_proxy / https_proxy / all_proxy
          manual / 空 → 用传入的 proxy 地址
    """
    mode = str(mode or "").strip().lower()
    if mode == "none":
        return ""
    if mode == "system":
        env = urllib.request.getproxies()
        chosen = env.get("https") or env.get("http") or env.get("all") or ""
        return normalize_proxy(chosen)
    return normalize_proxy(proxy)


# ---------------------------------------------------------------------------
# 「不走代理」例外列表
# ---------------------------------------------------------------------------

def parse_no_proxy(raw) -> list:
    """把 "localhost, 127.0.0.1, *.corp.com" 拆成规则列表（小写、去空格、去通配前缀）。"""
    out = []
    for part in str(raw or "").replace(";", ",").split(","):
        r = part.strip().lower().lstrip("*.")
        if r:
            out.append(r)
    return out


def _host_only(host: str) -> str:
    """从 host[:port] / [ipv6]:port 里取出纯主机名。"""
    h = str(host or "").strip().lower()
    if h.startswith("["):
        return h[1:].split("]", 1)[0]
    if h.count(":") == 1:
        return h.rsplit(":", 1)[0]
    return h


def host_bypasses(host: str, rules) -> bool:
    """主机（可带端口）命中任一例外规则 → True（应直连）。"""
    if not rules:
        return False
    h = _host_only(host)
    if not h:
        return False
    for r in rules:
        if not r:
            continue
        if h == r or h.endswith("." + r):
            return True
        if fnmatch.fnmatch(h, r):
            return True
    return False


# ---------------------------------------------------------------------------
# 网站过滤：黑名单 / 白名单
# ---------------------------------------------------------------------------

# off 不启用 / block 名单内禁止 / allow 仅名单内允许
FILTER_MODES = ("off", "block", "allow")

FILTER_MODE_TEXT = {"off": "不启用", "block": "黑名单", "allow": "白名单"}


def normalize_filter_mode(raw) -> str:
    """把任意输入规整成 off / block / allow（无法识别时按 off 处理）。"""
    m = str(raw or "").strip().lower()
    return m if m in FILTER_MODES else "off"


def site_filtered(host: str, mode="off", rules=()) -> tuple:
    """按网站过滤规则判断该主机能否访问，返回 (是否拦截, 中文原因)。

    mode: off 不限制 / block 名单内禁止访问 / allow 仅名单内允许访问
    rules: 名单，可传 "a.com,*.b.com" 字符串，也可传已拆好的列表
    """
    mode = normalize_filter_mode(mode)
    if mode == "off":
        return False, ""
    if isinstance(rules, str):
        rules = parse_no_proxy(rules)
    if not rules:
        return False, ""
    hit = host_bypasses(host, rules)     # 与「不走代理」共用一套匹配规则
    if mode == "block" and hit:
        return True, "该网站已被「网站过滤」列入黑名单"
    if mode == "allow" and not hit:
        return True, "该网站不在「网站过滤」的白名单内"
    return False, ""


# ---------------------------------------------------------------------------
# 错误提示中文化（前端直接展示，不暴露 urlopen 的英文堆栈）
# ---------------------------------------------------------------------------

def _errno_map() -> dict:
    out = {}
    for name, text in (
        ("ENETUNREACH", "网络不可达（本机没有到该地址的路由）"),
        ("ENETDOWN", "本机网络已断开"),
        ("ENETRESET", "网络连接被重置"),
        ("EHOSTUNREACH", "无法路由到目标主机"),
        ("EHOSTDOWN", "目标主机已关闭"),
        ("ECONNREFUSED", "目标拒绝连接（端口未开放或被防火墙拦截）"),
        ("ECONNRESET", "连接被对方重置"),
        ("ECONNABORTED", "连接被中止"),
        ("ETIMEDOUT", "连接超时"),
        ("EPIPE", "连接已断开"),
        ("EADDRNOTAVAIL", "本机地址不可用"),
        ("EAFNOSUPPORT", "地址类型不受支持"),
        ("EACCES", "网络访问被系统或防火墙拒绝"),
        ("EPERM", "网络访问被系统或防火墙拒绝"),
        ("EMSGSIZE", "数据包过大，链路无法传输"),
    ):
        code = getattr(errno, name, None)
        if code is not None:
            out.setdefault(code, text)
    return out


_ERRNO_TEXT = _errno_map()

# HTTP 状态码的中文说明（用于错误提示，尽量覆盖常见语义）
_HTTP_TEXT = {
    400: "请求参数有误", 401: "未授权，需要登录或携带 Token", 403: "拒绝访问",
    404: "接口或资源不存在", 405: "请求方法不被允许", 406: "服务端无法返回符合要求的内容",
    407: "代理要求身份认证", 408: "服务端等待请求超时", 409: "请求冲突",
    413: "请求体过大", 415: "不支持的媒体类型", 418: "服务端拒绝响应",
    422: "参数校验不通过", 429: "请求过于频繁，请稍后再试",
    500: "服务端内部错误", 501: "服务端不支持该功能", 502: "网关错误（上游或代理异常）",
    503: "服务暂不可用", 504: "网关超时（上游或代理无响应）", 507: "服务端存储不足",
}

# SSL 报错关键词 → 中文说明（顺序敏感，先匹配更具体的）
_SSL_HINTS = (
    ("self-signed certificate", "证书是自签名的，系统不信任"),
    ("self signed certificate", "证书是自签名的，系统不信任"),
    ("unable to get local issuer certificate", "缺少本地根证书，无法验证证书链"),
    ("certificate has expired", "证书已过期"),
    ("hostname mismatch", "证书绑定的域名与访问的域名不一致"),
    ("doesn't match", "证书绑定的域名与访问的域名不一致"),
    ("wrong version number", "对方端口不是 HTTPS（协议版本不匹配）"),
    ("sslv3 alert handshake failure", "SSL 握手失败，对方可能不支持当前协议或加密套件"),
    ("connection reset by peer", "SSL 握手时连接被对方重置"),
    ("certificate verify failed", "证书校验失败"),
)


def _ssl_text(exc) -> str:
    """把 SSL 异常翻成中文。"""
    vm = str(getattr(exc, "verify_message", "") or "")
    raw = (vm or str(exc)).lower()
    for key, text in _SSL_HINTS:
        if key in raw:
            return text
    return "证书或加密协议不匹配（%s）" % (vm or str(exc))


def _host_of(url) -> str:
    """从 URL 里取出主机名（取不到返回空串）。"""
    try:
        return urllib.parse.urlsplit(str(url or "")).hostname or ""
    except ValueError:
        return ""


def _target_text(url: str) -> str:
    """从 URL 里取出主机名，拼成「（example.com）」这样的后缀。"""
    h = _host_of(url)
    return ("（%s）" % h) if h else ""


# 英文错误短语 → 中文（urllib 有时只给一句英文 reason，没有 errno）
_PHRASE_HINTS = (
    ("timed out", "连接超时"),
    ("time out", "连接超时"),
    ("connection refused", "目标拒绝连接（端口未开放或被防火墙拦截）"),
    ("network is unreachable", "网络不可达（本机没有到该地址的路由）"),
    ("no route to host", "无法路由到目标主机"),
    ("connection reset by peer", "连接被对方重置"),
    ("temporary failure in name resolution", "域名解析失败"),
    ("name or service not known", "域名解析失败"),
    ("nodename nor servname provided", "域名解析失败"),
    ("getaddrinfo failed", "域名解析失败"),
    ("unknown url type", "不支持的协议类型"),
    ("certificate verify failed", "SSL 证书校验失败"),
)


def _phrase_text(msg: str) -> str:
    """按关键词把英文错误句子翻成中文；没有命中则返回空串。"""
    low = str(msg or "").lower()
    for key, zh in _PHRASE_HINTS:
        if key in low:
            return zh
    return ""


def http_status_text(code) -> str:
    """HTTP 状态码 → 「HTTP 404 接口或资源不存在」。"""
    try:
        code = int(code)
    except (TypeError, ValueError):
        return "请求失败"
    text = _HTTP_TEXT.get(code)
    return "HTTP %s %s" % (code, text) if text else "HTTP %s" % code


def friendly_error(exc, url: str = "") -> str:
    """把 socket / ssl / urllib 抛出的英文异常翻成中文提示。

    已经是中文的异常（例如 SOCKS5 协商失败）原样返回，避免二次包装。
    """
    # 1) HTTPError：协议层错误，单独给状态码说明
    if isinstance(exc, urllib.error.HTTPError):
        return http_status_text(getattr(exc, "code", 0))

    target = _target_text(url)

    # 2) URLError 的真实原因在 reason 里：是异常就递归，是字符串就翻译
    reason = getattr(exc, "reason", None)
    if reason is not None and reason is not exc:
        if isinstance(reason, (str, bytes)):
            text = str(reason, "utf-8", "replace") if isinstance(reason, bytes) else str(reason)
            text = text.strip()
            if text:
                return "%s%s" % (_phrase_text(text) or "请求失败", target)
        else:
            return friendly_error(reason, url)

    # 3) 域名解析
    if isinstance(exc, socket.gaierror):
        return "无法解析域名%s：请检查网址拼写、本机网络，或所选代理是否支持域名解析" % target

    # 4) 超时
    if isinstance(exc, (socket.timeout, TimeoutError)):
        return "连接超时%s：对方在超时时间内没有响应，可检查网络、代理地址或调大「请求超时」" % target

    # 5) SSL
    if isinstance(exc, ssl.SSLCertVerificationError):
        return "SSL 证书校验失败%s：%s；可在本页勾选「跳过 SSL 证书校验」后重试" % (target, _ssl_text(exc))
    if isinstance(exc, ssl.SSLError):
        return "SSL 握手失败%s：%s" % (target, _ssl_text(exc))

    # 6) 连接类错误
    if isinstance(exc, ConnectionRefusedError):
        return "目标拒绝连接%s：请确认主机与端口是否正确、代理服务是否已启动" % target
    if isinstance(exc, ConnectionResetError):
        return "连接被对方重置%s：目标服务器或代理主动断开了连接" % target
    if isinstance(exc, ConnectionAbortedError):
        return "连接被中止%s：%s" % (target, str(exc) or "网络中断")
    if isinstance(exc, BrokenPipeError):
        return "连接已断开%s：%s" % (target, str(exc) or "对方提前关闭了连接")

    # 7) 普通 OSError：带 errno 时给中文说明；没有 errno 的多半是本模块抛的中文错误
    if isinstance(exc, OSError):
        eno = getattr(exc, "errno", None)
        msg = str(exc).strip()
        if eno is None:
            zh = _phrase_text(msg)
            if zh:
                return "%s%s" % (zh, target)
            return msg or ("网络错误%s" % target)
        text = _ERRNO_TEXT.get(eno)
        if text:
            host = _host_of(url)
            return "%s%s（错误码 %s）" % (text, ("：无法访问 %s" % host) if host else "", eno)
        return "网络错误%s：%s（错误码 %s）" % (target, _phrase_text(msg) or msg or "未知原因", eno)

    msg = str(exc).strip()
    zh = _phrase_text(msg)
    if zh:
        return "%s%s" % (zh, target)
    return ("请求失败%s：%s" % (target, msg)) if msg else ("请求失败%s" % target)


# ---------------------------------------------------------------------------
# SOCKS5 客户端（纯标准库，不依赖 PySocks）
# ---------------------------------------------------------------------------

def _recv_exact(sock: socket.socket, n: int) -> bytes:
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise OSError("代理提前关闭了连接")
        buf += chunk
    return buf


def socks5_connect(proxy_host: str, proxy_port: int, host: str, port: int,
                   timeout, username: str = "", password: str = "",
                   resolve_local: bool = False) -> socket.socket:
    """建立一条经由 SOCKS5 代理的 TCP 连接。"""
    t = timeout if isinstance(timeout, (int, float)) else 30
    s = socket.create_connection((proxy_host, proxy_port), t)
    s.settimeout(t)
    try:
        # 1) 握手：声明支持的认证方式
        s.sendall(b"\x05\x02\x00\x02" if username else b"\x05\x01\x00")
        resp = _recv_exact(s, 2)
        if resp[0] != 0x05:
            raise OSError("该端口不是 SOCKS5 代理（返回版本 0x%02x）" % resp[0])
        method = resp[1]
        if method == 0x02:
            if not username:
                raise OSError("代理要求用户名 / 密码认证，请写成 socks5://用户:密码@主机:端口")
            ub, pb = username.encode("utf-8"), (password or "").encode("utf-8")
            s.sendall(b"\x01" + bytes([len(ub)]) + ub + bytes([len(pb)]) + pb)
            if _recv_exact(s, 2)[1] != 0x00:
                raise OSError("代理认证失败（用户名或密码不正确）")
        elif method != 0x00:
            raise OSError("代理不接受「无认证」连接（方式 0x%02x）" % method)

        # 2) CONNECT 请求：默认把域名交给代理解析（等价 socks5h）
        if resolve_local:
            info = socket.getaddrinfo(host, port, 0, socket.SOCK_STREAM)
            if not info:
                raise OSError("本机无法解析域名 %s" % host)
            fam, _, _, _, addr = info[0]
            dst = (b"\x04" + socket.inet_pton(socket.AF_INET6, addr[0])) if fam == socket.AF_INET6 \
                else (b"\x01" + socket.inet_aton(addr[0]))
        else:
            try:
                hb = host.encode("ascii")
            except UnicodeEncodeError:
                hb = host.encode("idna")
            dst = b"\x03" + bytes([len(hb)]) + hb
        s.sendall(b"\x05\x01\x00" + dst + struct.pack(">H", int(port)))

        head = _recv_exact(s, 4)
        if head[1] != 0x00:
            raise OSError("代理返回：%s（0x%02x）" % (SOCKS5_ERR.get(head[1], "未知错误"), head[1]))
        atyp = head[3]
        if atyp == 0x01:
            _recv_exact(s, 4)
        elif atyp == 0x03:
            _recv_exact(s, _recv_exact(s, 1)[0])
        elif atyp == 0x04:
            _recv_exact(s, 16)
        _recv_exact(s, 2)
        return s
    except Exception:
        try:
            s.close()
        except Exception:
            pass
        raise


# ---------------------------------------------------------------------------
# urllib opener
# ---------------------------------------------------------------------------

class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """不自动跟随 3xx：把重定向响应本身返回。"""

    def redirect_request(self, req, fp, code, msg, headers, newurl):   # noqa: D102
        return None


class _BypassProxyHandler(urllib.request.ProxyHandler):
    """在 ProxyHandler 之上叠加「不走代理」例外：命中例外的主机直连。

    注意：ProxyHandler.proxy_open 内部调的是模块级的 proxy_bypass()（只认 no_proxy 环境变量），
    所以这里必须整个覆写 proxy_open，而不能只覆写 proxy_bypass。
    """

    def __init__(self, proxies, rules):
        super().__init__(proxies)
        self._rules = rules

    def proxy_open(self, req, proxy, type):   # noqa: D102
        if req.host and host_bypasses(req.host, self._rules):
            return None       # 交给后面默认的 HTTP/HTTPS handler 直连
        return super().proxy_open(req, proxy, type)


def _socks_handlers(proxy: str, rules, context) -> list:
    """为 SOCKS5 代理构建 http / https 两个 handler。"""
    scheme, phost, pport, puser, ppass = parse_proxy(proxy)
    resolve_local = (scheme == "socks5")   # 只有 socks5h 把域名交给代理

    def _connect(conn):
        if host_bypasses(conn.host, rules):
            conn.sock = socket.create_connection((conn.host, conn.port), conn.timeout)
        else:
            conn.sock = socks5_connect(phost, pport, conn.host, conn.port, conn.timeout,
                                       puser, ppass, resolve_local)
        try:
            conn.sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        except OSError:
            pass

    class _SocksHTTP(http.client.HTTPConnection):
        def connect(self):
            _connect(self)

    class _SocksHTTPS(http.client.HTTPSConnection):
        def connect(self):
            _connect(self)
            self.sock = self._context.wrap_socket(self.sock, server_hostname=self.host)

    class _HTTP(urllib.request.HTTPHandler):
        def http_open(self, r):
            return self.do_open(_SocksHTTP, r)

    class _HTTPS(urllib.request.HTTPSHandler):
        def https_open(self, r):
            return self.do_open(_SocksHTTPS, r, context=context)

    # ProxyHandler({}) 显式关掉环境变量代理，避免和本设置互相打架
    return [urllib.request.ProxyHandler({}), _HTTP(), _HTTPS()]


def build_opener(proxy: str = "", no_proxy="", insecure: bool = False,
                 follow_redirects: bool = True):
    """按代理 / 例外列表 / 证书校验 / 重定向开关构建一个 urllib opener。

    proxy 为空 → 构建「真正直连」的 opener（显式关闭环境变量代理）。
    非法代理地址抛 ValueError。
    """
    proxy = normalize_proxy(proxy)
    rules = parse_no_proxy(no_proxy)
    context = ssl._create_unverified_context() if insecure else None

    handlers = []
    if proxy:
        if parse_proxy(proxy)[0].startswith("socks"):
            handlers.extend(_socks_handlers(proxy, rules, context))
        else:
            handlers.append(_BypassProxyHandler({"http": proxy, "https": proxy}, rules))
    else:
        # 显式传空 ProxyHandler：否则 urllib 会读取环境代理变量，导致「直连」的预期落空
        handlers.append(urllib.request.ProxyHandler({}))
    handlers.append(urllib.request.HTTPRedirectHandler() if follow_redirects else _NoRedirect())
    if context is not None:
        handlers.append(urllib.request.HTTPSHandler(context=context))
    return urllib.request.build_opener(*handlers)

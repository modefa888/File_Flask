"""V2Ray / Xray 底层能力：内核探测与下载、分享链接解析、Xray 运行配置生成。

对外接口：
    detect_cores()                    探测本机可用的 xray / v2ray（含版本）
    find_core()                       取一个可用内核路径（找不到返回空串）
    download_core(url, arch)          一键下载官方内核压缩包并解压到 data 目录
    lan_ip()                          取本机局域网 IPv4（供「其他用户使用」提示）
    parse_share_link(uri)             解析 vmess:// vless:// trojan:// ss:// 分享链接
    node_to_share(node)               把节点还原成分享链接（列表复制用）
    build_config(node, opts)          按节点 + 入站选项生成 Xray JSON 配置

只依赖标准库；解析失败的分享链接抛 ValueError（中文说明）。
"""
from __future__ import annotations

import base64
import binascii
import io
import json
import os
import platform
import re
import shutil
import socket
import stat
import subprocess
import urllib.parse
import urllib.request
import zipfile

# ---------------------------------------------------------------------------
# 内核探测 / 下载
# ---------------------------------------------------------------------------

# 探测顺序：PATH → 常见安装位置（含 v2rayN 自带内核目录）
_CORE_DIRS = (
    "/usr/local/bin", "/usr/bin", "/opt/xray", "/opt/v2ray",
)
_HOME = os.path.expanduser("~")
_CORE_DIRS_HOME = (
    os.path.join(_HOME, "bin"),
    os.path.join(_HOME, ".local", "bin"),
    os.path.join(_HOME, ".local", "share", "v2rayN", "bin", "xray"),
    os.path.join(_HOME, ".local", "share", "v2rayN", "bin", "v2ray"),
    os.path.join(_HOME, ".local", "share", "v2rayN", "bin"),
    os.path.join(_HOME, ".config", "xray"),
)

# 官方内核下载地址（GitHub Release 直链，可在模块设置里覆盖）
_XRAY_RELEASE = "https://github.com/XTLS/Xray-core/releases/latest/download/Xray-{plat}-{arch}.zip"

# GitHub 直连慢 / 不可达时的加速镜像前缀（依次尝试，哪个通用哪个；留空项 = 官方直连）。
# 把用户实测最稳的 ghfast.top / gh-proxy.com 放在直连之后优先重试。
_MIRRORS = (
    "",
    "https://ghfast.top/",
    "https://gh-proxy.com/",
    "https://ghproxy.net/",
    "https://ghproxy.cc/",
    "https://gh.llkk.cc/",
    "https://github.moeyy.xyz/",
)

# 版本号取法：`xray version` 首行形如 "Xray 26.3.27 (Xray, Penetrates Everything.) ..."
_VER_RE = re.compile(r"(?:Xray|V2Ray|v2ray)\s+([0-9][0-9A-Za-z.\-]*)")


def _notify(cb, *a):
    """安全调用进度回调：前端断开 / 回调自身报错都不能影响主流程。"""
    if not cb:
        return
    try:
        cb(*a)
    except Exception:                          # noqa: BLE001
        pass


def _plat_arch() -> tuple:
    """返回 (平台, 架构) 供下载地址拼装：linux/amd64、linux/arm64-v8a 等。"""
    sysname = (platform.system() or "").lower()
    plat = {"linux": "linux", "darwin": "macos", "windows": "windows"}.get(sysname, sysname)
    m = (platform.machine() or "").lower()
    if m in ("x86_64", "amd64"):
        arch = "64" if plat != "macos" else "64-v8a"
    elif m in ("aarch64", "arm64"):
        arch = "arm64-v8a"
    elif m.startswith("armv7") or m == "arm":
        arch = "arm32-v7a"
    elif m in ("i386", "i686", "x86"):
        arch = "32"
    else:
        arch = "64"
    return plat, arch


def _probe(path: str) -> str:
    """跑一次 `版本` 命令，成功返回版本号字符串，失败返回空串。"""
    if not path or not os.path.isfile(path) or not os.access(path, os.X_OK):
        return ""
    try:
        p = subprocess.run([path, "version"], capture_output=True, text=True, timeout=6)
    except (OSError, subprocess.SubprocessError):
        return ""
    out = (p.stdout or "") + (p.stderr or "")
    m = _VER_RE.search(out)
    if m:
        return m.group(1)
    for line in out.splitlines():
        line = line.strip()
        if line:
            return line.split()[0] if len(line.split()) > 1 else line
    return ""


def detect_cores(progress=None, extra=()) -> list:
    """探测本机可用的内核，返回 [{name, path, version, ok}]（按可用性优先排序）。

    progress 为可选回调 (已完成数, 总数, 当前路径)：探测点先收集再逐个校验，
    所以总数在开始前就确定，前端可以据此画出真实的进度。
    extra 为额外候选目录（如应用自带的 data/v2ray/core 安装目录）——
    内核装在这些地方时不会被视为「系统里没有可用内核」。
    """
    cands = []
    for name in ("xray", "v2ray"):
        w = shutil.which(name)
        if w:
            cands.append(w)
    for d in tuple(_CORE_DIRS) + tuple(_CORE_DIRS_HOME) + tuple(extra):
        for name in ("xray", "v2ray"):
            p = os.path.join(d, name)
            if p not in cands:
                cands.append(p)
    out = []
    total = len(cands)
    for i, p in enumerate(cands):
        _notify(progress, i, total, p)
        ver = _probe(p)
        if ver:
            out.append({"name": os.path.basename(p), "path": p, "version": ver, "ok": True})
    _notify(progress, total, total, "")
    return out


def find_core(manual: str = "") -> str:
    """取可用内核路径：优先用户手动指定的，其次自动探测；都没有返回空串。"""
    manual = str(manual or "").strip()
    if manual and _probe(manual):
        return manual
    cores = detect_cores()
    return cores[0]["path"] if cores else ""


def core_version(path: str) -> str:
    """取内核版本号（取不到返回空串）。"""
    return _probe(path)


def platform_arch() -> tuple:
    """当前平台 / 架构（拼下载地址用）。"""
    return _plat_arch()


def download_core(dest_dir: str, url: str = "", progress=None, on_phase=None, on_log=None) -> str:
    """下载官方内核并解压到 dest_dir，返回可执行文件路径。

    url 留空则按当前平台 / 架构拼官方 Release 直链，并在直连失败时自动切换加速镜像；
    url 非空则只用用户给的地址（不再额外回退）。
    progress 为可选回调 (已收字节, 总字节)；on_phase 为可选回调 (阶段名)，
    阶段依次为 download → extract → done；on_log 为可选回调 (日志行)。
    失败抛 ValueError（中文说明）。
    """
    plat, arch = _plat_arch()
    url = str(url or "").strip()
    if url:
        targets = [url]
    else:
        official = _XRAY_RELEASE.format(plat=plat, arch=arch)
        targets = [m + official for m in _MIRRORS]
    os.makedirs(dest_dir, exist_ok=True)

    buf = None
    last_err = ""
    for target in targets:
        host = urllib.parse.urlsplit(target).netloc
        label = "GitHub 官方直连" if host == "github.com" else "加速镜像 " + host
        _notify(on_log, "尝试下载源：" + label)
        try:
            req = urllib.request.Request(target, headers={"User-Agent": "FileFlask-V2Ray/1.0"})
            with urllib.request.urlopen(req, timeout=45) as resp:
                total = int(resp.headers.get("Content-Length") or 0)
                _notify(on_phase, "download")
                buf = io.BytesIO()
                got = 0
                while True:
                    chunk = resp.read(64 * 1024)
                    if not chunk:
                        break
                    buf.write(chunk)
                    got += len(chunk)
                    _notify(progress, got, total)
            if got < 1024:
                raise ValueError("响应内容只有 %s 字节，不像内核压缩包" % got)
            _notify(on_log, "下载完成：%s 字节（来自 %s）" % (got, label))
            break
        except Exception as e:             # noqa: BLE001
            buf = None
            last_err = str(e) or e.__class__.__name__
            _notify(on_log, "该源下载失败：" + last_err)
            continue
    if buf is None:
        raise ValueError("所有下载源都失败了（最后错误：%s）。可检查网络，"
                         "或在设置里改下载地址 / 手动指定内核路径" % last_err)

    _notify(on_phase, "extract")
    try:
        with zipfile.ZipFile(buf) as zf:
            zf.extractall(dest_dir)
    except zipfile.BadZipFile:
        raise ValueError("下载到的不是有效的 zip 压缩包（可能被网络代理改写，请检查下载地址）")

    # 官方包内可执行文件名固定为 xray（Windows 为 xray.exe）
    exe = os.path.join(dest_dir, "xray.exe" if os.name == "nt" else "xray")
    if not os.path.isfile(exe):
        for root, _dirs, files in os.walk(dest_dir):
            for f in files:
                if f in ("xray", "xray.exe", "v2ray", "v2ray.exe"):
                    exe = os.path.join(root, f)
                    break
    if not os.path.isfile(exe):
        raise ValueError("压缩包内没有找到 xray 可执行文件")
    try:
        os.chmod(exe, os.stat(exe).st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    except OSError:
        pass
    _notify(on_phase, "done")
    return exe


def list_versions(limit: int = 30) -> list:
    """拉取 Xray-core 近期发布版本列表（GitHub Releases API）。

    api.github.com 直连失败时自动换加速镜像前缀重试；全部失败抛 ValueError。
    返回 [{tag, version, published}]，最新在前。
    """
    n = max(1, min(int(limit or 30), 100))
    api = "https://api.github.com/repos/XTLS/Xray-core/releases?per_page=" + str(n)
    last_err = ""
    for base in _MIRRORS:
        try:
            req = urllib.request.Request(base + api, headers={
                "User-Agent": "FileFlask-V2Ray/1.0",
                "Accept": "application/vnd.github+json"})
            with urllib.request.urlopen(req, timeout=12) as resp:
                data = json.loads(resp.read().decode("utf-8", "replace"))
            out = []
            for r in data if isinstance(data, list) else []:
                tag = str((r or {}).get("tag_name") or "").strip()
                if not tag:
                    continue
                out.append({"tag": tag, "version": tag.lstrip("v"),
                            "published": str((r or {}).get("published_at") or "")[:10]})
            if out:
                return out
            last_err = "API 响应中没有版本信息"
        except Exception as e:             # noqa: BLE001
            last_err = str(e) or e.__class__.__name__
            continue
    raise ValueError("获取版本列表失败（最后错误：%s）。GitHub API 可能暂时不可达，请稍后重试" % last_err)


def release_url(version: str) -> str:
    """指定版本的官方内核 zip 下载地址；版本号非法抛 ValueError。"""
    ver = str(version or "").strip().lstrip("vV")
    if not re.fullmatch(r"[0-9][0-9A-Za-z.\-]*", ver):
        raise ValueError("无效的版本号：%s" % version)
    plat, arch = _plat_arch()
    return "https://github.com/XTLS/Xray-core/releases/download/v%s/Xray-%s-%s.zip" % (ver, plat, arch)


def lan_ip() -> str:
    """取本机对外可用的局域网 IPv4（取不到返回空串）。

    用「连一个外部地址但不真正发包」的经典办法拿到默认出口网卡的地址。
    """
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except OSError:
        return ""
    finally:
        s.close()


# ---------------------------------------------------------------------------
# 分享链接解析
# ---------------------------------------------------------------------------

def _b64d(text: str) -> str:
    """宽松 base64 解码：兼容 URL-safe 字符集与缺失的 padding。"""
    s = re.sub(r"\s+", "", str(text or ""))
    s = s.replace("-", "+").replace("_", "/")
    s += "=" * ((4 - len(s) % 4) % 4)
    try:
        return base64.b64decode(s).decode("utf-8", "replace")
    except (binascii.Error, ValueError) as e:
        raise ValueError("base64 解码失败：%s" % e)


def _as_int(v, default=0) -> int:
    try:
        return int(str(v).strip())
    except (TypeError, ValueError):
        return default


def _split_alpn(v) -> list:
    if not v:
        return []
    if isinstance(v, (list, tuple)):
        return [str(x) for x in v if x]
    return [x for x in str(v).replace(";", ",").split(",") if x]


def _stream_of(q: dict) -> dict:
    """由分享链接的 query 参数得出节点用的传输参数（net / header / path / host / sni 等）。"""
    net = (q.get("type") or q.get("net") or "tcp").lower()
    if net in ("http", "h2"):
        net = "h2"
    if net == "raw":
        net = "tcp"
    node = {
        "net": net,
        "header": (q.get("headerType") or q.get("type2") or "").lower(),
        "path": q.get("path") or q.get("serviceName") or "",
        "host": q.get("host") or "",
        "sni": q.get("sni") or q.get("peer") or "",
        "alpn": _split_alpn(q.get("alpn")),
        "fp": q.get("fp") or "",
        "insecure": str(q.get("allowInsecure") or q.get("insecure") or "") in ("1", "true"),
        "pbk": q.get("pbk") or "",
        "sid": q.get("sid") or "",
        "spx": q.get("spx") or "",
        "flow": q.get("flow") or "",
    }
    sec = (q.get("security") or "").lower()
    if sec in ("tls", "xtls"):
        node["tls"] = "tls"
    elif sec == "reality":
        node["tls"] = "reality"
    else:
        node["tls"] = "none"
    return node


def parse_share_link(uri: str) -> dict:
    """解析一条分享链接，返回节点 dict；无法识别时抛 ValueError。"""
    raw = str(uri or "").strip()
    if not raw:
        raise ValueError("分享链接为空")
    low = raw.lower()
    if low.startswith("vmess://"):
        node = _parse_vmess(raw)
    elif low.startswith("vless://"):
        node = _parse_vless(raw)
    elif low.startswith("trojan://"):
        node = _parse_trojan(raw)
    elif low.startswith("ss://"):
        node = _parse_ss(raw)
    else:
        raise ValueError("暂不支持该协议（支持 vmess:// vless:// trojan:// ss://）")
    node["raw"] = raw
    return node


def _base(proto: str, name: str, server: str, port) -> dict:
    if not server or not port:
        raise ValueError("分享链接缺少服务器地址或端口")
    return {
        "proto": proto, "name": name or ("%s:%s" % (server, port)),
        "server": server, "port": _as_int(port), "remark": "",
    }


def _parse_vmess(raw: str) -> dict:
    """vmess://base64({...)  —— 主体是 base64 编码的 JSON。"""
    body = raw[8:]
    # 有些客户端带 fragment 名称，先切掉
    body = body.split("#", 1)[0]
    try:
        j = json.loads(_b64d(body))
    except ValueError:
        raise ValueError("vmess 链接不是有效的 base64(JSON)：请确认链接完整")
    if not isinstance(j, dict):
        raise ValueError("vmess 链接内容格式不对")
    node = _base("vmess", str(j.get("ps") or j.get("remarks") or ""),
                 str(j.get("add") or ""), j.get("port"))
    node.update({
        "uuid": str(j.get("id") or "").strip(),
        "aid": _as_int(j.get("aid") or j.get("alterId") or 0),
        "scy": str(j.get("scy") or j.get("security") or "auto"),
        "net": str(j.get("net") or "tcp").lower(),
        "header": str(j.get("type") or "").lower(),
        "path": str(j.get("path") or ""),
        "host": str(j.get("host") or ""),
        "sni": str(j.get("sni") or ""),
        "alpn": _split_alpn(j.get("alpn")),
        "fp": str(j.get("fp") or ""),
        "tls": "tls" if str(j.get("tls") or "").lower() in ("tls", "reality") else "none",
        "insecure": False,
    })
    if not node["uuid"]:
        raise ValueError("vmess 链接缺少 id（uuid）")
    if node["net"] in ("http", "h2"):
        node["net"] = "h2"
    return node


def _parse_vless(raw: str) -> dict:
    """vless://uuid@host:port?params#name"""
    u = urllib.parse.urlsplit(raw)
    node = _base("vless", urllib.parse.unquote(u.fragment or ""), u.hostname, u.port)
    q = {k: v[0] for k, v in urllib.parse.parse_qs(u.query).items()}
    node.update({
        "uuid": urllib.parse.unquote(u.username or ""),
        "flow": q.get("flow") or "",
    })
    node.update(_stream_of(q))
    if not node["uuid"]:
        raise ValueError("vless 链接缺少 uuid")
    return node


def _parse_trojan(raw: str) -> dict:
    """trojan://password@host:port?params#name"""
    u = urllib.parse.urlsplit(raw)
    node = _base("trojan", urllib.parse.unquote(u.fragment or ""), u.hostname, u.port)
    q = {k: v[0] for k, v in urllib.parse.parse_qs(u.query).items()}
    node.update({"password": urllib.parse.unquote(u.username or "")})
    node.update(_stream_of(q))
    # trojan 默认走 tls
    if node.get("tls") == "none" and str(q.get("security") or "").lower() != "none":
        node["tls"] = "tls"
    if not node["password"]:
        raise ValueError("trojan 链接缺少密码")
    return node


def _parse_ss(raw: str) -> dict:
    """ss:// 两种写法：
        ss://base64(method:password)@host:port#name
        ss://base64(method:password@host:port)#name     （旧版整体编码）
    """
    u = urllib.parse.urlsplit(raw)
    name = urllib.parse.unquote(u.fragment or "")
    netloc = raw.split("://", 1)[1].split("#", 1)[0].split("?", 1)[0]
    method = password = ""
    host = u.hostname
    port = u.port
    if u.username and host:
        # 新写法：userinfo 是 base64(method:password)
        info = _b64d(urllib.parse.unquote(u.username))
        if ":" in info:
            method, password = info.split(":", 1)
    else:
        # 旧写法：整体 base64
        info = _b64d(netloc)
        if "@" not in info:
            raise ValueError("ss 链接格式不对")
        cred, hostport = info.rsplit("@", 1)
        if ":" in cred:
            method, password = cred.split(":", 1)
        if ":" in hostport:
            host, port = hostport.rsplit(":", 1)
    node = _base("ss", name, host, port)
    node.update({"method": (method or "").strip(), "password": password or ""})
    if not node["method"]:
        raise ValueError("ss 链接缺少加密方式")
    return node


def node_to_share(node: dict) -> str:
    """把节点还原成分享链接（订阅内容里逐条保存的原串优先直接用）。"""
    raw = str(node.get("raw") or "").strip()
    if raw:
        return raw
    proto = node.get("proto")
    name = urllib.parse.quote(str(node.get("name") or ""), safe="")
    host, port = node.get("server"), node.get("port")
    if proto == "vmess":
        j = {"v": "2", "ps": node.get("name") or "", "add": host, "port": str(port),
             "id": node.get("uuid") or "", "aid": str(node.get("aid") or 0),
             "scy": node.get("scy") or "auto", "net": node.get("net") or "tcp",
             "type": node.get("header") or "none", "host": node.get("host") or "",
             "path": node.get("path") or "", "tls": node.get("tls") or "none",
             "sni": node.get("sni") or "", "fp": node.get("fp") or ""}
        b = base64.b64encode(json.dumps(j, ensure_ascii=False).encode("utf-8")).decode()
        return "vmess://" + b
    if proto == "vless":
        q = _query_of(node)
        return "vless://%s@%s:%s?%s#%s" % (node.get("uuid") or "", host, port, q, name)
    if proto == "trojan":
        q = _query_of(node)
        return "trojan://%s@%s:%s?%s#%s" % (urllib.parse.quote(node.get("password") or "", safe=""),
                                            host, port, q, name)
    if proto == "ss":
        cred = base64.b64encode(("%s:%s" % (node.get("method") or "",
                                            node.get("password") or "")).encode()).decode()
        return "ss://%s@%s:%s#%s" % (cred.replace("=", ""), host, port, name)
    return ""


def _query_of(node: dict) -> str:
    """由节点拼出 vless / trojan 的 query 串。"""
    q = {"type": node.get("net") or "tcp", "security": node.get("tls") or "none"}
    for k, src in (("sni", "sni"), ("host", "host"), ("path", "path"),
                   ("fp", "fp"), ("pbk", "pbk"), ("sid", "sid"), ("flow", "flow")):
        v = node.get(src)
        if v:
            q[k] = v
    if node.get("alpn"):
        q["alpn"] = ",".join(node["alpn"])
    if node.get("insecure"):
        q["allowInsecure"] = "1"
    return urllib.parse.urlencode(q)


# ---------------------------------------------------------------------------
# Xray 配置生成
# ---------------------------------------------------------------------------

_LOG_LEVELS = ("debug", "info", "warning", "error", "none")


def _stream_settings(node: dict) -> dict:
    """由节点得出 outbound 的 streamSettings。"""
    net = str(node.get("net") or "tcp").lower()
    st = {"network": net}
    if net == "ws":
        ws = {"path": node.get("path") or "/"}
        if node.get("host"):
            ws["headers"] = {"Host": node["host"]}
        st["wsSettings"] = ws
    elif net == "grpc":
        st["grpcSettings"] = {"serviceName": node.get("path") or ""}
    elif net == "h2":
        h2 = {"path": node.get("path") or "/"}
        if node.get("host"):
            h2["host"] = [node["host"]]
        st["httpSettings"] = h2
    elif net == "tcp" and str(node.get("header") or "") == "http":
        st["tcpSettings"] = {
            "header": {"type": "http", "request": {
                "path": [node.get("path") or "/"],
                "headers": {"Host": [node["host"]] if node.get("host") else []},
            }}
        }
    sec = str(node.get("tls") or "none").lower()
    if sec == "tls":
        tls = {"serverName": node.get("sni") or node.get("host") or node.get("server") or "",
               "allowInsecure": bool(node.get("insecure"))}
        if node.get("alpn"):
            tls["alpn"] = node["alpn"]
        if node.get("fp"):
            tls["fingerprint"] = node["fp"]
        st["security"] = "tls"
        st["tlsSettings"] = tls
    elif sec == "reality":
        st["security"] = "reality"
        st["realitySettings"] = {
            "serverName": node.get("sni") or node.get("host") or "",
            "publicKey": node.get("pbk") or "",
            "shortId": node.get("sid") or "",
            "fingerprint": node.get("fp") or "chrome",
            "spiderX": node.get("spx") or "/",
        }
    return st


def build_outbound(node: dict) -> dict:
    """按节点生成一条 Xray outbound。"""
    proto = str(node.get("proto") or "").lower()
    addr, port = node.get("server"), _as_int(node.get("port"))
    if not addr or not port:
        raise ValueError("节点缺少服务器地址或端口")
    if proto == "vmess":
        ob = {"protocol": "vmess", "settings": {"vnext": [{
            "address": addr, "port": port,
            "users": [{"id": node.get("uuid") or "", "alterId": _as_int(node.get("aid")),
                       "security": node.get("scy") or "auto"}],
        }]}}
    elif proto == "vless":
        user = {"id": node.get("uuid") or "", "encryption": "none"}
        if node.get("flow"):
            user["flow"] = node["flow"]
        ob = {"protocol": "vless", "settings": {"vnext": [{
            "address": addr, "port": port, "users": [user],
        }]}}
    elif proto == "trojan":
        ob = {"protocol": "trojan", "settings": {"servers": [{
            "address": addr, "port": port, "password": node.get("password") or "",
        }]}}
    elif proto == "ss":
        ob = {"protocol": "shadowsocks", "settings": {"servers": [{
            "address": addr, "port": port, "method": node.get("method") or "",
            "password": node.get("password") or "",
        }]}}
    else:
        raise ValueError("不支持的协议：%s" % (proto or "(空)"))
    ob["streamSettings"] = _stream_settings(node)
    ob["tag"] = "proxy"
    return ob


def build_config(node: dict, opts: dict) -> dict:
    """生成完整 Xray 配置。

    opts（均由模块设置给出）：
        socks_port  SOCKS5 入站端口（默认 10808）
        socks_listen  入站监听地址（0.0.0.0 = 供局域网其他用户使用）
        socks_user / socks_pass  非空则要求用户名密码认证
        http_port    HTTP 入站端口（0 = 不开启）
        log_level    日志级别
    """
    port = _as_int(opts.get("socks_port") or 10808) or 10808
    listen = str(opts.get("socks_listen") or "0.0.0.0")
    user = str(opts.get("socks_user") or "").strip()
    pwd = str(opts.get("socks_pass") or "")

    # 统计 API（实时网速 / 流量统计的数据源）：127.0.0.1 上的 dokodemo-door，
    # 只收本机的 StatsService 查询；端口与业务端口冲突时顺延，0 = 不开启。
    api_port = _as_int(opts.get("api_port") or 0)
    if api_port:
        used = {port, _as_int(opts.get("http_port") or 0)}
        while api_port in used:
            api_port += 1

    socks = {"tag": "socks-in", "listen": listen, "port": port, "protocol": "socks",
             "settings": {"udp": True}}
    if user:
        socks["settings"]["auth"] = "password"
        socks["settings"]["accounts"] = [{"user": user, "pass": pwd}]
    else:
        socks["settings"]["auth"] = "noauth"
    inbounds = [socks]

    hp = _as_int(opts.get("http_port") or 0)
    if hp:
        http = {"tag": "http-in", "listen": listen, "port": hp, "protocol": "http",
                "settings": {}}
        if user:
            http["settings"]["accounts"] = [{"user": user, "pass": pwd}]
        inbounds.append(http)

    level = str(opts.get("log_level") or "warning").lower()
    if level not in _LOG_LEVELS:
        level = "warning"

    cfg = {
        "log": {"loglevel": level, "access": "none", "error": ""},
        "inbounds": inbounds,
        "outbounds": [
            build_outbound(node),
            {"tag": "direct", "protocol": "freedom"},
            {"tag": "block", "protocol": "blackhole"},
        ],
        "routing": {
            "domainStrategy": "AsIs",
            "rules": [
                # 局域网 / 本机地址直连，避免把内网访问也绕进代理。
                # 这里刻意不用 geoip:private —— 它依赖内核同目录的 geoip.dat，
                # 精简安装常常没有该文件，会导致配置校验直接失败。
                {"type": "field", "outboundTag": "direct",
                 "domain": ["localhost"],
                 "ip": ["127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16",
                        "169.254.0.0/16", "::1/128", "fc00::/7", "fe80::/10"]},
            ],
        },
    }

    if api_port:
        cfg["stats"] = {}
        # 关键：Xray 默认不记录按 outbound 的流量计数，必须显式打开，
        # 否则 statsquery 永远返回空、实时网速 / 流量统计全是 0
        cfg["policy"] = {"system": {"statsOutboundUplink": True,
                                    "statsOutboundDownlink": True}}
        cfg["api"] = {"tag": "api", "services": ["StatsService"]}
        cfg["inbounds"].append({"tag": "api-in", "listen": "127.0.0.1", "port": api_port,
                                "protocol": "dokodemo-door",
                                "settings": {"address": "127.0.0.1"}})
        cfg["routing"]["rules"].insert(0, {"type": "field", "inboundTag": ["api-in"],
                                           "outboundTag": "api"})
    return cfg


# ---------------------------------------------------------------------------
# 订阅内容解析
# ---------------------------------------------------------------------------

def parse_subscription(content: str) -> list:
    """解析订阅内容，返回分享链接字符串列表。

    支持：整体 base64 编码的订阅、纯文本多行链接（一行一条）。
    """
    text = str(content or "").strip()
    if not text:
        return []
    # 整体 base64：解码后应包含协议前缀
    if "://" not in text:
        try:
            text = _b64d(text)
        except ValueError:
            return []
    links = []
    for line in text.replace("\r", "\n").split("\n"):
        line = line.strip()
        if not line:
            continue
        low = line.lower()
        if low.startswith(("vmess://", "vless://", "trojan://", "ss://")):
            links.append(line)
    return links

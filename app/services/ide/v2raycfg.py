"""V2Ray / Xray / sing-box 底层能力：内核探测与下载、分享链接解析、运行配置生成。

对外接口：
    detect_cores()                    探测本机可用的 xray / v2ray / sing-box（含版本）
    find_core(manual, prefer)         取一个可用内核路径（找不到返回空串）
    core_kind(path)                   判断内核类型：xray / v2ray / sing-box
    download_core(dest, url, kind)    一键下载官方内核压缩包并解压到 data 目录
    lan_ip()                          取本机局域网 IPv4（供「其他用户使用」提示）
    parse_share_link(uri)             解析 vmess:// vless:// trojan:// ss:// 分享链接
    node_to_share(node)               把节点还原成分享链接（列表复制用）
    build_config(node, opts)          按节点 + 入站选项生成内核配置（按类型分派）

两种内核的配置格式完全不同：Xray / V2Ray 用 protocol + settings + streamSettings，
sing-box 用 type + tls + transport，所以生成配置前先按 core_kind() 判定类型。

只依赖标准库（走 SOCKS5 兜底代理时才会延迟导入 common.proxyutil）；
解析失败 / 下载失败一律抛 ValueError（中文说明）。

GitHub 相关请求的尝试顺序：探测可达的代理 → 直连 → 各加速镜像 → 探测不通的代理。
代理由 v2raymgr 通过 set_fallback_proxies() 注入（订阅拉取代理 + 当前节点的本机 socks）：
直连 GitHub 常常能连上但极慢、中途断流，所以在有可用代理时直接优先走代理。
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
import tarfile
import urllib.error
import urllib.parse
import urllib.request
import zipfile

# ---------------------------------------------------------------------------
# 内核探测 / 下载
# ---------------------------------------------------------------------------

# 探测顺序：PATH → 常见安装位置（含 v2rayN 自带内核目录）
_CORE_DIRS = (
    "/usr/local/bin", "/usr/bin", "/opt/xray", "/opt/v2ray", "/opt/sing-box",
)
_HOME = os.path.expanduser("~")
_CORE_DIRS_HOME = (
    os.path.join(_HOME, "bin"),
    os.path.join(_HOME, ".local", "bin"),
    os.path.join(_HOME, ".local", "share", "v2rayN", "bin", "xray"),
    os.path.join(_HOME, ".local", "share", "v2rayN", "bin", "v2ray"),
    os.path.join(_HOME, ".local", "share", "v2rayN", "bin"),
    os.path.join(_HOME, ".config", "xray"),
    os.path.join(_HOME, ".config", "sing-box"),
)

# 支持的内核类型（kind）与可执行文件名：探测时按这些名字挨个找
_CORE_NAMES = ("xray", "v2ray", "sing-box")

# 官方内核下载地址（GitHub Release 直链，可在模块设置里覆盖）
_XRAY_RELEASE = "https://github.com/XTLS/Xray-core/releases/latest/download/Xray-{plat}-{arch}.zip"
# sing-box 的资产名里带版本号，没有 latest 直链，需要先查 API 拿最新 tag
_SINGBOX_RELEASE = ("https://github.com/SagerNet/sing-box/releases/download/v{ver}/"
                    "sing-box-{ver}-{os}-{arch}{ext}")

# kind → GitHub 仓库（查最新版本 / 版本列表用）
_REPOS = {"xray": "XTLS/Xray-core", "v2ray": "XTLS/Xray-core", "sing-box": "SagerNet/sing-box"}

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

# 版本号取法：
#   xray / v2ray → "Xray 26.3.27 (Xray, Penetrates Everything.) ..."
#   sing-box     → "sing-box version 1.12.4"
_VER_RE = re.compile(r"(?:Xray|V2Ray|v2ray|sing-box)\s+(?:version\s+)?([0-9][0-9A-Za-z.\-]*)", re.I)


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


def _version_output(path: str) -> str:
    """跑一次 `版本` 命令，返回原始输出（失败返回空串）。"""
    if not path or not os.path.isfile(path) or not os.access(path, os.X_OK):
        return ""
    try:
        p = subprocess.run([path, "version"], capture_output=True, text=True, timeout=6)
    except (OSError, subprocess.SubprocessError):
        return ""
    return (p.stdout or "") + (p.stderr or "")


def _probe(path: str) -> str:
    """跑一次 `版本` 命令，成功返回版本号字符串，失败返回空串。"""
    out = _version_output(path)
    if not out:
        return ""
    m = _VER_RE.search(out)
    if m:
        return m.group(1)
    for line in out.splitlines():
        line = line.strip()
        if line:
            return line.split()[0] if len(line.split()) > 1 else line
    return ""


def kind_by_name(path: str) -> str:
    """只按可执行文件名判断内核类型（不启动进程）；判断不出返回空串。"""
    base = os.path.basename(str(path or "")).lower()
    if not base:
        return ""
    if "sing-box" in base or base.startswith("singbox"):
        return "sing-box"
    if "xray" in base:
        return "xray"
    if "v2ray" in base:
        return "v2ray"
    return ""


def core_kind(path: str) -> str:
    """判断内核类型：sing-box / xray / v2ray（无内核返回空串，判断不出时按 xray 处理）。

    先看可执行文件名（data/v2ray/versions 里的多版本目录也按名字区分），
    名字不直观时再跑一次 `version` 看输出。
    """
    kind = kind_by_name(path)
    if kind:
        return kind
    if not str(path or "").strip():
        return ""
    out = _version_output(path)
    if not out:
        return ""
    low = out.lower()
    for k in ("sing-box", "xray", "v2ray"):
        if k in low:
            return k
    return "xray"


def detect_cores(progress=None, extra=(), only: str = "") -> list:
    """探测本机可用的内核，返回 [{name, path, version, ok, kind}]（按可用性优先排序）。

    progress 为可选回调 (已完成数, 总数, 当前路径)：探测点先收集再逐个校验，
    所以总数在开始前就确定，前端可以据此画出真实的进度。
    extra 为额外候选目录（如应用自带的 data/v2ray/core 安装目录）——
    内核装在这些地方时不会被视为「系统里没有可用内核」。
    only 限定只探测某一类内核（xray = Xray/V2Ray 系，sing-box = sing-box），
    前端按当前 Tab 传进来，避免日志里出现一堆「跟我没关系」的路径。
    """
    names = _CORE_NAMES
    if only == "sing-box":
        names = ("sing-box",)
    elif only in ("xray", "v2ray"):
        names = ("xray", "v2ray")
    def _match(kind: str) -> bool:
        """only 为空 = 不限类型；xray 含 v2ray，sing-box 只认自己。"""
        if not only:
            return True
        if only == "sing-box":
            return kind == "sing-box"
        return kind in ("xray", "v2ray")

    def _wanted(p: str) -> bool:
        """指定了 only 时，直接给出的文件也要按类型过滤。"""
        k = kind_by_name(p)
        return _match(k) if k else True     # 名字看不出类型就交给 version 输出判定

    cands = []
    for name in names:
        w = shutil.which(name)
        if w and w not in cands:
            cands.append(w)
    for d in tuple(_CORE_DIRS) + tuple(_CORE_DIRS_HOME) + tuple(extra):
        if os.path.isfile(d):               # 用户手动指定的是「文件」而不是目录
            if d not in cands and _wanted(d):
                cands.append(d)
            continue
        for name in names:
            p = os.path.join(d, name)
            if p not in cands:
                cands.append(p)
    out = []
    total = len(cands)
    for i, p in enumerate(cands):
        _notify(progress, i, total, p)
        ver = _probe(p)
        if ver:
            k = kind_by_name(p) or core_kind(p)
            if not _match(k):
                continue                    # 名字看不出类型、但实际是别种内核 → 丢弃
            out.append({"name": os.path.basename(p), "path": p, "version": ver, "ok": True,
                        "kind": k})
    _notify(progress, total, total, "")
    return out


def find_core(manual: str = "", prefer: str = "") -> str:
    """取可用内核路径：优先用户手动指定的，其次自动探测；都没有返回空串。

    prefer 指定优先的内核类型（xray / sing-box）：自动探测时优先取该类型，
    没装该类型时退回任意可用内核，避免「切了类型但系统里只装了另一种」时彻底不可用。
    """
    manual = str(manual or "").strip()
    if manual and _probe(manual):
        return manual
    cores = detect_cores()
    if prefer:
        for c in cores:
            if c.get("kind") == prefer:
                return c["path"]
    return cores[0]["path"] if cores else ""


def core_version(path: str) -> str:
    """取内核版本号（取不到返回空串）。"""
    return _probe(path)


def platform_arch() -> tuple:
    """当前平台 / 架构（拼下载地址用）。"""
    return _plat_arch()


def _sb_plat_arch() -> tuple:
    """sing-box 的资产命名：返回 (系统, 架构, 扩展名)，如 ("linux", "amd64", ".tar.gz")。"""
    plat, arch = _plat_arch()
    osname = {"linux": "linux", "macos": "darwin", "windows": "windows"}.get(plat, plat)
    name = {"64": "amd64", "32": "386",
            "arm64-v8a": "arm64", "arm32-v7a": "armv7"}.get(arch, "amd64")
    return osname, name, ".zip" if osname == "windows" else ".tar.gz"


def _extract_archive(data: bytes, dest_dir: str):
    """按文件头判断压缩格式（zip / tar.gz）并解压；格式不对抛 ValueError。

    Xray 官方包是 zip，sing-box 官方包在 Linux / macOS 是 tar.gz、Windows 是 zip。
    """
    if data[:2] == b"\x1f\x8b":
        try:
            with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tf:
                try:
                    tf.extractall(dest_dir, filter="data")   # 3.12+：过滤越界路径
                except TypeError:                            # 老版本 Python 不支持 filter
                    tf.extractall(dest_dir)
        except (tarfile.TarError, EOFError, OSError) as e:
            raise ValueError("下载到的 tar.gz 解压失败：%s" % e)
        return
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            zf.extractall(dest_dir)
    except zipfile.BadZipFile:
        raise ValueError("下载到的不是有效的 zip / tar.gz 压缩包（可能被网络代理改写，请检查下载地址）")


def _find_local_exe(dest_dir: str, kind: str) -> str:
    """在解压目录里找内核可执行文件；在子目录里找到时复制到 dest_dir 根下，保证路径稳定。"""
    if kind == "sing-box":
        want = ("sing-box", "sing-box.exe")
    else:
        want = ("xray", "xray.exe", "v2ray", "v2ray.exe")
    for name in want:
        p = os.path.join(dest_dir, name)
        if os.path.isfile(p):
            return p
    for root, _dirs, files in os.walk(dest_dir):
        for f in files:
            if f not in want:
                continue
            src = os.path.join(root, f)
            dst = os.path.join(dest_dir, f)
            if os.path.abspath(src) == os.path.abspath(dst):
                return src
            try:
                shutil.copy2(src, dst)
                return dst
            except OSError:
                return src
    return ""


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """禁用自动跳转：用来从 releases/latest 的 302 里取 tag（GitHub API 不通时的兜底）。"""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_FETCH_UA = "Mozilla/5.0 (compatible; FileFlask-V2Ray/1.0)"

# 直连 / 镜像全部失败后用于重试的兜底代理（由 v2raymgr 注入：订阅拉取代理 + 当前节点的本机 socks）
_EXTRA_PROXIES = ()


def set_fallback_proxies(proxies=()):
    """设置「直连 / 镜像都失败后」用于重试的代理列表（去重、去空）。"""
    global _EXTRA_PROXIES
    seen = []
    for p in proxies or ():
        p = str(p or "").strip()
        if p and p not in seen:
            seen.append(p)
    _EXTRA_PROXIES = tuple(seen)


def get_fallback_proxies() -> tuple:
    """当前生效的兜底代理（调试 / 日志用）。"""
    return _EXTRA_PROXIES


def _proxy_alive(proxy: str, timeout: float = 1.5) -> bool:
    """TCP 探一下代理端口是否在监听（只看连通性，不做协议握手）。"""
    raw = str(proxy or "").strip()
    if not raw:
        return False
    if "://" not in raw:
        raw = "http://" + raw
    try:
        u = urllib.parse.urlsplit(raw)
        port = u.port or (1080 if (u.scheme or "").lower().startswith("socks") else 8080)
    except ValueError:
        return False
    if not u.hostname or not port:
        return False
    s = None
    try:
        s = socket.create_connection((u.hostname, int(port)), timeout)
        return True
    except OSError:
        return False
    finally:
        if s is not None:
            try:
                s.close()
            except OSError:
                pass


def _attempts(url: str) -> list:
    """(代理, 目标地址) 的尝试序列。

    探测到可达代理时优先走代理（国内直连 GitHub 经常又慢又容易断），
    否则先直连 + 各加速镜像，最后再试那些探测不通的代理。
    """
    usable = [p for p in _EXTRA_PROXIES if _proxy_alive(p)]
    out = [(p, url) for p in usable]              # 走代理时不再套镜像，代理本身就能出去
    out += [("", m + url) for m in _MIRRORS]
    out += [(p, url) for p in _EXTRA_PROXIES if p not in usable]
    return out


def _proxy_opener(proxy: str, follow_redirects: bool = True):
    """按代理构建 opener（延迟导入：本模块单独加载时不依赖包上下文）。"""
    from ..common import proxyutil          # noqa: PLC0415
    return proxyutil.build_opener(proxy=proxy, follow_redirects=follow_redirects)


def _open(url: str, proxy: str = "", timeout: int = 12, follow_redirects: bool = True,
          accept: str = "*/*", headers: dict = None):
    """打开 URL 返回响应对象。

    proxy 为空 → 沿用系统 / 环境变量代理（与原行为一致）；
    非空 → 显式用该代理（http / https / socks5 / socks5h 都支持）。
    headers 用于断点续传的 Range / If-Range。
    """
    if proxy:
        opener = _proxy_opener(proxy, follow_redirects)
    elif follow_redirects:
        opener = urllib.request.build_opener()
    else:
        opener = urllib.request.build_opener(_NoRedirect)
    h = {"User-Agent": _FETCH_UA, "Accept": accept}
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, headers=h)
    return opener.open(req, timeout=timeout)


def _fetch_text(url: str, timeout: int = 12) -> str:
    """抓一段文本（直连 → 镜像 → 兜底代理依次试）；全失败抛 ValueError。"""
    last_err = ""
    for proxy, target in _attempts(url):
        try:
            with _open(target, proxy, timeout) as resp:
                return resp.read(4 * 1024 * 1024).decode("utf-8", "replace")
        except Exception as e:                 # noqa: BLE001
            last_err = str(e) or e.__class__.__name__
    raise ValueError(last_err or "请求失败")


def _redirect_target(url: str) -> str:
    """取 3xx 的 Location（不跟随跳转），直连 / 镜像 / 兜底代理依次试；全失败返回空串。"""
    for proxy, target in _attempts(url):
        try:
            with _open(target, proxy, 15, follow_redirects=False) as resp:
                return resp.geturl()
        except urllib.error.HTTPError as e:
            if 300 <= e.code < 400:
                return str(e.headers.get("Location") or "")
        except Exception:                      # noqa: BLE001
            pass
    return ""


def official_url(kind: str = "xray", version: str = "") -> str:
    """官方压缩包直链（sing-box 的资产名带版本号，需要先定版本）。"""
    if str(kind or "") == "sing-box":
        return release_url(version or latest_version("sing-box"), "sing-box")
    plat, arch = _plat_arch()
    return _XRAY_RELEASE.format(plat=plat, arch=arch)


def resolve_source(src: str, kind: str = "xray") -> list:
    """把用户填的「下载源」展开成实际要请求的地址列表。

    支持三种写法（都能直接填官网 releases 总目录，不用记资产文件名）：
      1. 完整压缩包地址      https://.../sing-box-1.13.19-linux-amd64.tar.gz
      2. 镜像前缀            https://ghfast.top/     （拼上官方地址，其余镜像继续兜底）
      3. releases 页面/标签  https://github.com/SagerNet/sing-box/releases[/tag/v1.13.19]
    """
    src = str(src or "").strip()
    if not src:
        return []
    if re.search(r"\.(zip|tar\.gz|tgz)$", src, re.I) or "/releases/download/" in src:
        return [src]                       # 已经是具体的下载链接（可能带查询串），原样用
    if src.endswith("/"):
        official = official_url(kind)
        return [src + official] + [m + official for m in _MIRRORS if m and m != src]
    m = re.search(r"/releases(?:/tag/(v?[0-9][^/?#]*))?", src, re.I)
    if m:
        ver = str(m.group(1) or "").strip().lstrip("vV") or latest_version(kind)
        return [release_url(ver, kind)]
    return [src]          # 认不出的地址原样试一次


# --- 断点续传：下到一半的包先落在 dest_dir 下的临时文件，失败后再点就接着下 ---

_PART_FILE = "_download.part"
_PART_META = "_download.json"
_PART_CHUNK = 64 * 1024


def _part_paths(dest_dir: str) -> tuple:
    return os.path.join(dest_dir, _PART_FILE), os.path.join(dest_dir, _PART_META)


def _part_remove(path: str):
    try:
        os.remove(path)
    except OSError:
        pass


def _part_load(part: str, meta: str, key: str) -> tuple:
    """读断点，返回 (已下载字节, 总字节, ETag)。

    与当前下载目标（key = 压缩包的正式地址）不一致时，说明换过版本 / 换过包，
    残留文件直接清掉，避免把两个版本的数据拼在一起。
    """
    data = {}
    try:
        with open(meta, "r", encoding="utf-8") as f:
            data = json.load(f) or {}
    except (OSError, ValueError):
        data = {}
    if not isinstance(data, dict) or str(data.get("key") or "") != key:
        _part_remove(part)
        _part_remove(meta)
        return 0, 0, ""
    size = os.path.getsize(part) if os.path.isfile(part) else 0
    try:
        total = int(data.get("total") or 0)
    except (TypeError, ValueError):
        total = 0
    if total and size and size > total:        # 残留比目标还大，肯定不对
        _part_remove(part)
        _part_remove(meta)
        return 0, 0, ""
    return size, total, str(data.get("etag") or "")


def _part_save_meta(meta: str, key: str, total: int, etag: str = ""):
    try:
        with open(meta, "w", encoding="utf-8") as f:
            json.dump({"key": key, "total": int(total or 0), "etag": etag or ""}, f)
    except OSError:
        pass


def _resp_total(resp, offset: int) -> int:
    """算「整个文件」的大小：206 看 Content-Range，200 用 Content-Length。"""
    m = re.search(r"/(\d+)\s*$", str(resp.headers.get("Content-Range") or ""))
    if m:
        return int(m.group(1))
    try:
        cl = int(resp.headers.get("Content-Length") or 0)
    except (TypeError, ValueError):
        cl = 0
    return (cl + int(offset or 0)) if cl else 0


def _fetch_into(part: str, meta: str, key: str, target: str, proxy: str, offset: int,
                etag: str = "", progress=None, on_phase=None) -> tuple:
    """下载一次到临时文件（带 Range 续传），返回 (已下载字节, 文件总字节, 新 ETag)。"""
    headers = {}
    if offset:
        headers["Range"] = "bytes=%d-" % offset
        if etag:
            headers["If-Range"] = etag     # 内容变了就让服务端整份重发，避免拼出坏包
    with _open(target, proxy, 45, headers=headers or None) as resp:
        code = int(getattr(resp, "status", 0) or resp.getcode() or 200)
        if offset and code != 206:          # 对方不支持续传 / 资源已变 → 从头下
            offset = 0
        total = _resp_total(resp, offset)
        new_etag = str(resp.headers.get("ETag") or resp.headers.get("Last-Modified") or "")
        _part_save_meta(meta, key, total, new_etag)   # 先存，异常退出也能续
        _notify(on_phase, "download")
        got = offset
        with open(part, "ab" if offset else "wb") as f:
            while True:
                chunk = resp.read(_PART_CHUNK)
                if not chunk:
                    break
                f.write(chunk)
                got += len(chunk)
                _notify(progress, got, total)
    return got, total, new_etag


def download_core(dest_dir: str, url: str = "", progress=None, on_phase=None, on_log=None,
                  kind: str = "xray") -> str:
    """下载官方内核并解压到 dest_dir，返回可执行文件路径。

    kind 指定内核类型（xray / sing-box），决定默认下载地址与包内可执行文件名。
    url 留空则按当前平台 / 架构拼官方 Release 直链（自动取最新版），
    并在直连失败时自动切换加速镜像；url 非空则按 resolve_source() 的规则解析
    （完整压缩包地址 / 镜像前缀 / releases 页面或标签页）。
    progress 为可选回调 (已收字节, 总字节)；on_phase 为可选回调 (阶段名)，
    阶段依次为 download → extract → done；on_log 为可选回调 (日志行)。

    支持断点续传：已下载的字节存在 dest_dir/_download.part，本次所有源都失败时保留，
    下次点下载会带 Range 从断点继续（换源 / 换包会自动丢弃旧残留）。
    失败抛 ValueError（中文说明）。
    """
    kind = "sing-box" if str(kind or "") == "sing-box" else "xray"
    url = str(url or "").strip()
    srcs = resolve_source(url, kind)
    if srcs:
        official = srcs[0]
        pairs = [("", s) for s in srcs]
    else:
        official = official_url(kind)
        pairs = [("", m + official) for m in _MIRRORS]
    # 代理优先级：探测到「可达」的代理就直接优先走它——直连 GitHub 往往能连上但
    # 速度极慢、下到一半断流，白白浪费时间；一个都不通才退回「直连 + 镜像 + 代理兜底」
    if _EXTRA_PROXIES:
        usable = [p for p in _EXTRA_PROXIES if _proxy_alive(p)]
        if usable:
            pairs = [(p, official) for p in usable] + pairs
            _notify(on_log, "检测到可用代理，优先经代理下载：" + "、".join(usable))
        else:
            pairs += [(p, official) for p in _EXTRA_PROXIES]
    os.makedirs(dest_dir, exist_ok=True)

    part, meta = _part_paths(dest_dir)
    offset, total, etag = _part_load(part, meta, official)
    if offset:
        _notify(on_log, "发现未完成的下载：已有 %s，从断点继续" % _size_text(offset))

    last_err = ""
    for proxy, target in pairs:
        host = urllib.parse.urlsplit(target).netloc
        if proxy:
            label = "经代理 " + proxy
        elif host == "github.com":
            label = "GitHub 官方直连"
        elif srcs and target in srcs:
            label = "自定义下载地址"
        else:
            label = "加速镜像 " + host
        if offset:
            label += "（续传，从 %s 起）" % _size_text(offset)
        _notify(on_log, "尝试下载源：" + label)
        try:
            got, t, new_etag = _fetch_into(part, meta, official, target, proxy, offset,
                                           etag, progress, on_phase)
            offset, total = got, (t or total)
            etag = new_etag or etag
            if total and got < total:
                raise ValueError("连接提前结束（已下 %s / %s）"
                                 % (_size_text(got), _size_text(total)))
            if got < 1024 and not total:
                # 长度未知又只有几百字节：多半是错误页而不是内核包
                raise ValueError("响应内容只有 %s 字节，不像内核压缩包" % got)
            with open(part, "rb") as f:
                head = f.read(2)
            # 镜像偶尔会把 404 页面当成功返回：只认 zip / gzip 的文件头
            if head not in (b"PK", b"\x1f\x8b"):
                _part_remove(part)
                _part_remove(meta)
                offset, total = 0, 0
                raise ValueError("响应不是压缩包（多半是镜像返回的错误页），换下一个源")
            _notify(on_log, "下载完成：%s 字节（来自 %s）" % (got, label))
            break
        except Exception as e:             # noqa: BLE001
            last_err = str(e) or e.__class__.__name__
            _notify(on_log, "该源下载失败：" + last_err)
            # 已经落盘的字节留着，换下一个源接着续
            offset, total, etag = _part_load(part, meta, official)
            continue

    size = os.path.getsize(part) if os.path.isfile(part) else 0
    if not size or (total and size < total):
        raise ValueError("所有下载源都失败了（最后错误：%s）。已下载 %s，"
                         "重新点「一键下载」会从断点继续"
                         % (last_err or "未知", _size_text(size)))

    _notify(on_phase, "extract")
    try:
        with open(part, "rb") as f:
            _extract_archive(f.read(), dest_dir)
    except ValueError:
        _part_remove(part)                 # 包本身坏了就别留着继续续传
        _part_remove(meta)
        raise
    _part_remove(part)
    _part_remove(meta)

    exe = _find_local_exe(dest_dir, kind)
    if not exe:
        raise ValueError("压缩包内没有找到 %s 可执行文件" % kind)
    try:
        os.chmod(exe, os.stat(exe).st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    except OSError:
        pass
    _notify(on_phase, "done")
    return exe


def _size_text(n) -> str:
    """字节数 → 「13.9 MB」这样的可读文本（日志 / 错误提示用）。"""
    try:
        n = float(n or 0)
    except (TypeError, ValueError):
        return "0 B"
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return ("%d %s" % (n, unit)) if unit == "B" else ("%.1f %s" % (n, unit))
        n /= 1024.0
    return "%.1f GB" % n


def _gh_api(url: str):
    """GET 一个 GitHub API 地址（直连 → 镜像 → 兜底代理依次试），返回解析后的 JSON。"""
    last_err = ""
    for proxy, target in _attempts(url):
        try:
            with _open(target, proxy, 12, accept="application/vnd.github+json") as resp:
                return json.loads(resp.read(4 * 1024 * 1024).decode("utf-8", "replace"))
        except Exception as e:                 # noqa: BLE001
            last_err = str(e) or e.__class__.__name__
    raise ValueError(last_err or "GitHub API 暂时不可达")


def list_versions(limit: int = 30, kind: str = "xray") -> list:
    """拉取内核近期发布版本列表。

    kind: xray / sing-box。优先走 GitHub Releases API（带加速镜像重试）；
    API 不可达时退回抓 releases 总目录的 HTML（此时 published 为空）；
    两条路都失败才抛 ValueError。返回 [{tag, version, published}]，最新在前。
    """
    n = max(1, min(int(limit or 30), 100))
    repo = _REPOS.get(str(kind or "xray"), _REPOS["xray"])
    last_err = ""
    try:
        data = _gh_api("https://api.github.com/repos/%s/releases?per_page=%d" % (repo, n))
    except ValueError as e:
        last_err = str(e)
        data = None
    out = []
    for r in data if isinstance(data, list) else []:
        tag = str((r or {}).get("tag_name") or "").strip()
        if not tag:
            continue
        out.append({"tag": tag, "version": tag.lstrip("v"),
                    "published": str((r or {}).get("published_at") or "")[:10]})
    if not out:
        out = _versions_from_page(repo, n)      # API 不通：直接抓 releases 总目录
    if not out:
        raise ValueError("获取版本列表失败（最后错误：%s）。GitHub API / 网页都不可达，"
                         "可直接把 releases 页面地址填进下载源" % (last_err or "未知"))
    return out


def _versions_from_page(repo: str, n: int) -> list:
    """GitHub API 不可达时，从 releases 的 Atom 订阅 / 总目录里抓 tag 兜底。

    拿不到发布日期（published 留空）。超时压到 6 秒，避免接口被拖住几十秒。
    """
    for url in ("https://github.com/%s/releases.atom" % repo,
                "https://github.com/%s/releases" % repo):
        try:
            text = _fetch_text(url, timeout=6)     # 内部已按「直连 → 镜像 → 兜底代理」尝试
        except ValueError:
            continue
        tags = []
        for m in re.finditer(r"/releases/tag/([^\"'?#<>\s]+)", text or ""):
            tag = m.group(1).strip()
            if tag and tag not in tags:
                tags.append(tag)
        if tags:
            return [{"tag": t, "version": t.lstrip("vV"), "published": ""} for t in tags[:n]]
    return []


def latest_version(kind: str = "xray") -> str:
    """取最新正式版版本号（用于拼 sing-box 的下载地址）；失败抛 ValueError。

    先走 GitHub API；API 不可达（被墙 / 限流）时退回 `releases/latest` 的 302 跳转拿 tag。
    """
    repo = _REPOS.get(str(kind or "xray"), _REPOS["xray"])
    tag = ""
    try:
        data = _gh_api("https://api.github.com/repos/%s/releases/latest" % repo)
        if isinstance(data, dict):
            tag = str(data.get("tag_name") or "").strip()
    except ValueError:
        tag = ""
    if not tag:
        for base in _MIRRORS:
            try:
                loc = _redirect_target(base + "https://github.com/%s/releases/latest" % repo)
            except Exception:                  # noqa: BLE001
                continue
            m = re.search(r"/releases/tag/([^/?#]+)", loc or "")
            if m:
                tag = m.group(1).strip()
                break
    if not tag:
        raise ValueError("获取最新版本号失败（GitHub API 与 releases 页面都不可达）。"
                         "可在设置里把 releases 页面地址或完整压缩包地址填进下载源")
    return tag.lstrip("vV")


def release_url(version: str, kind: str = "xray") -> str:
    """指定版本的官方内核下载地址；版本号非法抛 ValueError。"""
    ver = str(version or "").strip().lstrip("vV")
    if not re.fullmatch(r"[0-9][0-9A-Za-z.\-]*", ver):
        raise ValueError("无效的版本号：%s" % version)
    if str(kind or "") == "sing-box":
        osname, arch, ext = _sb_plat_arch()
        return _SINGBOX_RELEASE.format(ver=ver, os=osname, arch=arch, ext=ext)
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
    """生成完整内核配置：按 opts['core_path'] 的内核类型分派到 Xray / sing-box。

    opts（均由模块设置给出）：
        core_path    选定的内核可执行文件（决定生成哪种配置格式）
        socks_port   SOCKS5 入站端口（默认 10808）
        socks_listen 入站监听地址（0.0.0.0 = 供局域网其他用户使用）
        socks_user / socks_pass  非空则要求用户名密码认证
        http_port    HTTP 入站端口（0 = 不开启）
        api_port     统计接口端口（0 = 不开启）
        log_level    日志级别
    """
    if core_kind(str(opts.get("core_path") or "")) == "sing-box":
        return build_singbox_config(node, opts)
    return _build_xray_config(node, opts)


def _build_xray_config(node: dict, opts: dict) -> dict:
    """生成完整 Xray / V2Ray 配置（入参说明见 build_config）。"""
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
# sing-box 配置生成
# ---------------------------------------------------------------------------

# Xray 的日志级别 → sing-box 的级别（sing-box 没有 none，用 error 顶上）
_SB_LOG_LEVELS = {"debug": "debug", "info": "info", "warning": "warn", "warn": "warn",
                  "error": "error", "none": "error", "fatal": "fatal", "panic": "panic"}


def _sb_tls(node: dict) -> dict:
    """节点 → sing-box 的 tls 段（未启用 TLS 返回空 dict，调用方不要写进配置）。"""
    sec = str(node.get("tls") or "none").lower()
    if sec not in ("tls", "reality"):
        return {}
    tls = {"enabled": True,
           "server_name": node.get("sni") or node.get("host") or node.get("server") or "",
           "insecure": bool(node.get("insecure"))}
    if node.get("alpn"):
        tls["alpn"] = list(node["alpn"])
    fp = str(node.get("fp") or "")
    if sec == "reality":
        # reality 必须带 utls；指纹留空时按 chrome 处理（服务端一般按 chrome 下发参数）
        tls["utls"] = {"enabled": True, "fingerprint": fp or "chrome"}
        tls["reality"] = {"enabled": True,
                          "public_key": str(node.get("pbk") or ""),
                          "short_id": str(node.get("sid") or "")}
    elif fp:
        tls["utls"] = {"enabled": True, "fingerprint": fp}
    return tls


def _sb_transport(node: dict) -> dict:
    """节点 → sing-box 的 transport 段（tcp 裸连返回空 dict）。"""
    net = str(node.get("net") or "tcp").lower()
    path = str(node.get("path") or "")
    host = str(node.get("host") or "")
    if net == "ws":
        tr = {"type": "ws", "path": path or "/"}
        if host:
            tr["headers"] = {"Host": host}
        return tr
    if net == "grpc":
        return {"type": "grpc", "service_name": path}
    if net == "h2":
        tr = {"type": "http", "path": path or "/"}
        if host:
            tr["host"] = [host]
        return tr
    if net == "tcp" and str(node.get("header") or "").lower() == "http":
        # 注意 sing-box 的 http transport 里 path 只能是字符串（不能像 Xray 那样用数组）
        tr = {"type": "http", "method": "GET", "path": path or "/"}
        if host:
            tr["host"] = [host]
        return tr
    return {}


def build_singbox_outbound(node: dict) -> dict:
    """按节点生成一条 sing-box outbound。"""
    proto = str(node.get("proto") or "").lower()
    addr, port = node.get("server"), _as_int(node.get("port"))
    if not addr or not port:
        raise ValueError("节点缺少服务器地址或端口")
    ob = {"tag": "proxy", "server": addr, "server_port": port}
    if proto == "vmess":
        ob["type"] = "vmess"
        ob["uuid"] = str(node.get("uuid") or "")
        ob["security"] = str(node.get("scy") or "auto") or "auto"
        aid = _as_int(node.get("aid"))
        if aid:
            ob["alter_id"] = aid
    elif proto == "vless":
        ob["type"] = "vless"
        ob["uuid"] = str(node.get("uuid") or "")
        if node.get("flow"):
            ob["flow"] = str(node["flow"])
    elif proto == "trojan":
        ob["type"] = "trojan"
        ob["password"] = str(node.get("password") or "")
    elif proto == "ss":
        ob["type"] = "shadowsocks"
        ob["method"] = str(node.get("method") or "")
        ob["password"] = str(node.get("password") or "")
    else:
        raise ValueError("不支持的协议：%s" % (proto or "(空)"))
    tls = _sb_tls(node)
    if tls:
        ob["tls"] = tls
    tr = _sb_transport(node)
    if tr:
        ob["transport"] = tr
    return ob


def build_singbox_config(node: dict, opts: dict) -> dict:
    """生成完整的 sing-box 配置。

    与 Xray 配置的差异要点：
      · 入站是 type + listen_port，认证用 users 数组；
      · 只有 proxy / direct 两条出站，默认出口由 route.final 指定；
      · 统计走 experimental.clash_api（Xray 那边是 StatsService + api）。
    """
    port = _as_int(opts.get("socks_port") or 10808) or 10808
    listen = str(opts.get("socks_listen") or "0.0.0.0")
    user = str(opts.get("socks_user") or "").strip()
    pwd = str(opts.get("socks_pass") or "")
    hp = _as_int(opts.get("http_port") or 0)
    api_port = _as_int(opts.get("api_port") or 0)
    if api_port:
        used = {port, hp}
        while api_port in used:
            api_port += 1

    socks = {"type": "socks", "tag": "socks-in", "listen": listen, "listen_port": port}
    if user:
        socks["users"] = [{"username": user, "password": pwd}]
    inbounds = [socks]

    if hp:
        http = {"type": "http", "tag": "http-in", "listen": listen, "listen_port": hp}
        if user:
            http["users"] = [{"username": user, "password": pwd}]
        inbounds.append(http)

    level = _SB_LOG_LEVELS.get(str(opts.get("log_level") or "warning").lower(), "warn")

    cfg = {
        "log": {"level": level, "timestamp": True},
        "inbounds": inbounds,
        "outbounds": [
            build_singbox_outbound(node),
            {"type": "direct", "tag": "direct"},
        ],
        "route": {
            "rules": [
                # 局域网 / 本机地址直连，避免把内网访问也绕进代理。
                # 这里只用 ip_cidr（不依赖 sing-box 1.11 才有的 action 写法）。
                {"ip_cidr": ["127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12",
                             "192.168.0.0/16", "169.254.0.0/16",
                             "::1/128", "fc00::/7", "fe80::/10"],
                 "outbound": "direct"},
            ],
            "final": "proxy",
            "auto_detect_interface": True,
        },
    }
    if api_port:
        # 实时网速 / 流量统计的数据源：clash_api 的 /connections 里带累计上下行
        cfg["experimental"] = {"clash_api": {"external_controller": "127.0.0.1:%d" % api_port}}
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

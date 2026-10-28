"""IPTV / M3U 播放列表：解析 + HLS 转发。

GET /api/iptv/playlist?path=/abs/iptv-fe.m3u
    解析本地的 m3u / m3u8 播放列表，返回频道清单（含分组、台标、播放地址）：
    {ok, path, total, groups: [{name, count}], items: [{name, group, logo, url, kind}]}
    kind: hls（HLS 直播流，前端交给 hls.js）/ media（mp4 等直连媒体）/ file（本地相对路径文件）。

GET /api/iptv/proxy?url=http(s)://...
    HLS 转发（解决两个浏览器侧硬限制）：
    1. 跨域：很多直播源不带 Access-Control-Allow-Origin，hls.js 的 XHR 会被拦；
    2. 混合内容：页面是 https 时浏览器直接拒绝加载 http 流。
    文本类（.m3u8 / m3u）会把里面的子播放列表、分片、密钥（EXT-X-KEY）、
    EXT-X-MAP 的 URI 全部改写成走本代理的地址，因此多级 m3u8 也能正常嵌套；
    分片等二进制内容按 64KB 分块流式转发，不占内存。

说明：代理只放行 http / https，避免变成任意协议（file:// 等）的读取通道。
"""
import os
import re
import urllib.error
import urllib.parse
import urllib.request

from flask import Blueprint, Response, jsonify, request

from ...log import get_logger
from ...services.common.filecore import safe_path

_log = get_logger()
bp = Blueprint("iptv", __name__)

# 播放列表文件读取上限：正常 IPTV 源几千个频道也就几 MB
_MAX_PLAYLIST_BYTES = 16 * 1024 * 1024
# m3u8 文本读取上限（单次）
_MAX_M3U8_BYTES = 4 * 1024 * 1024
# 上游请求超时（秒）：直播分片偶尔慢，但也不能一直挂着
_UPSTREAM_TIMEOUT = 20
# 伪装成常见播放器 UA：部分直播源会拒绝空 UA / 陌生 UA
_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
       "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")

# #EXTINF 行里的 key="value" 属性
_ATTR_RE = re.compile(r'([A-Za-z0-9_-]+)\s*=\s*"([^"]*)"')
# m3u8 里带 URI="..." 的标签（EXT-X-KEY / EXT-X-MAP / EXT-X-MEDIA 等）
_URI_ATTR_RE = re.compile(r'(URI=")([^"]*)(")')

# 可直接交给 <video> 播放的普通媒体后缀（其余一律按 HLS 处理）
_MEDIA_EXTS = {"mp4", "webm", "mkv", "m4v", "mov", "flv", "avi", "mp3",
               "aac", "m4a", "ogg", "wav", "ts"}


# ======================================================================
# 播放列表解析
# ======================================================================
def _split_extinf(line: str):
    """拆 #EXTINF 行 → (属性字典, 频道名)。

    形如：#EXTINF:-1 tvg-id="CCTV1" group-title="央视",CCTV1综合
    频道名取「最后一个引号外的逗号」之后的内容（名字里可能还有逗号），
    属性用正则整行扫，名字里的引号不影响。
    """
    body = line[len("#EXTINF"):]
    attrs = {k.lower(): v for k, v in _ATTR_RE.findall(body)}
    name = ""
    in_quote = False
    cut = -1
    for i, ch in enumerate(body):
        if ch == '"':
            in_quote = not in_quote
        elif ch == "," and not in_quote:
            cut = i          # 记最后一个，属性里的逗号在前，名字里的逗号也要保留
    if cut >= 0:
        name = body[cut + 1:].strip()
    return attrs, name


def _url_kind(url: str, is_file: bool = False) -> str:
    """判断播放地址类型：本地文件 / 普通媒体 / HLS。"""
    if is_file:
        return "file"
    path = urllib.parse.urlsplit(url).path or ""
    ext = os.path.splitext(path)[1].lstrip(".").lower()
    return "media" if ext in _MEDIA_EXTS else "hls"


def _normalize_url(raw: str, base_dir: str):
    """把 m3u 里的一行地址规整成可播放地址 → (url, kind) ；无法识别返回 (None, None)。

    · http(s):// → 原样
    · //host/path → 补 http:
    · 其余（相对路径 / 绝对文件路径）→ 相对播放列表所在目录解析，命中本地文件时用 kind=file
    解析不出本地文件的（rtmp / rtsp / 失效路径等浏览器放不了）直接丢掉，不留死频道。
    """
    u = (raw or "").strip()
    if not u:
        return None, None
    low = u.lower()
    if low.startswith(("http://", "https://")):
        return u, _url_kind(u)
    if low.startswith("//"):
        u = "http:" + u
        return u, _url_kind(u)
    # 本地相对 / 绝对路径：相对路径按播放列表所在目录解析
    cand = u if os.path.isabs(u) else os.path.join(base_dir, u)
    cand = os.path.normpath(cand.split("?")[0])
    if os.path.isfile(cand):
        return cand, _url_kind(cand, is_file=True)
    return None, None


def parse_m3u(text: str, base_dir: str = "/"):
    """解析 m3u / m3u8 文本 → (items, groups)。

    items: [{name, group, logo, url, kind}]
    groups: [{name, count}]（按首次出现顺序，前端据此渲染分组）
    """
    items = []
    pending = None            # 上一个 #EXTINF 解析出的元信息，等下一条地址行配对
    cur_group = ""            # 老格式 #EXTGRP: 设置的默认分组
    for raw in text.splitlines():
        line = raw.strip().lstrip("\ufeff")
        if not line:
            continue
        if line.upper().startswith("#EXTINF"):
            attrs, name = _split_extinf(line)
            pending = {"name": name, "attrs": attrs}
            continue
        if line.upper().startswith("#EXTGRP:"):
            cur_group = line.split(":", 1)[1].strip()
            continue
        if line.startswith("#"):
            continue          # 其它标签（#EXTM3U / #EXT-X-… / 注释）跳过
        url, kind = _normalize_url(line, base_dir)
        if not url:
            continue
        attrs = (pending or {}).get("attrs") or {}
        name = (pending or {}).get("name") or ""
        if not name:                       # 没有 #EXTINF 的裸地址（纯 m3u8 分片列表）不建频道
            pending = None
            continue
        group = (attrs.get("group-title") or cur_group or "").strip() or "未分组"
        items.append({
            "name": name,
            "group": group,
            "logo": (attrs.get("tvg-logo") or "").strip(),
            "tvg_id": (attrs.get("tvg-id") or "").strip(),
            "url": url,
            "kind": kind,
        })
        pending = None

    groups = []
    seen = {}
    for it in items:
        g = it["group"]
        if g not in seen:
            seen[g] = {"name": g, "count": 0}
            groups.append(seen[g])
        seen[g]["count"] += 1
    return items, groups


def _read_text_file(path: str):
    """读播放列表文件 → (text, error)。"""
    if not os.path.isfile(path):
        return None, "文件不存在：%s" % path
    size = os.path.getsize(path)
    if size > _MAX_PLAYLIST_BYTES:
        return None, "播放列表过大（%.1f MB），超过 %d MB 上限" % (
            size / 1048576.0, _MAX_PLAYLIST_BYTES // 1048576)
    try:
        with open(path, "rb") as f:
            data = f.read()
    except (OSError, PermissionError) as e:
        return None, "无法读取文件：%s" % e
    return data.decode("utf-8", "replace").lstrip("\ufeff"), None


# ======================================================================
# 路由
# ======================================================================
@bp.route("/api/iptv/playlist", methods=["GET", "POST"])
def api_iptv_playlist():
    """解析 m3u 播放列表 → 频道清单（IDE 播放列表播放器用）。

    GET  ?path=…            读磁盘上的文件
    POST {path, text?}      优先用请求里带来的文本（编辑器缓冲区），
                            这样「刚在编辑器里改完还没保存」的内容点播放也立刻生效
    """
    data = (request.get_json(silent=True) or {}) if request.method == "POST" else {}
    target = safe_path(data.get("path") or request.args.get("path") or "")
    text = data.get("text")
    if isinstance(text, str) and text.strip():
        text = text.lstrip("\ufeff")
    else:
        text, err = _read_text_file(target)
        if err:
            return jsonify({"ok": False, "error": err}), 404
    base_dir = os.path.dirname(target) or "/"
    items, groups = parse_m3u(text, base_dir)
    if not items:
        return jsonify({
            "ok": False,
            "error": "没有解析到频道：该文件可能是单码率 m3u8（分片列表），不是 IPTV 频道列表",
            "path": target,
        }), 200
    _log.info("解析播放列表 %s -> %d 个频道 / %d 个分组",
              target, len(items), len(groups))
    return jsonify({
        "ok": True,
        "path": target,
        "name": os.path.basename(target),
        "total": len(items),
        "groups": groups,
        "items": items,
    })


def _proxy_url(target: str) -> str:
    """把上游地址包成本代理地址（绝对路径，hls.js 解析相对地址时也不会跑偏）。"""
    return "/api/iptv/proxy?url=" + urllib.parse.quote(target, safe="")


def _rewrite_playlist(text: str, base_url: str) -> str:
    """把 m3u8 里的相对 / 绝对地址全部改写成走代理的地址。

    · 普通行 = 分片或子播放列表地址
    · 标签行里的 URI="..." = 密钥 / 初始化分片 / 备用媒体地址
    """
    out = []
    for line in text.splitlines():
        s = line.strip()
        if not s:
            out.append(line)
            continue
        if s.startswith("#"):
            def _sub(m):
                abs_u = urllib.parse.urljoin(base_url, m.group(2))
                return m.group(1) + _proxy_url(abs_u) + m.group(3)
            out.append(_URI_ATTR_RE.sub(_sub, line))
        else:
            out.append(_proxy_url(urllib.parse.urljoin(base_url, s)))
    return "\n".join(out) + "\n"


def _open_upstream(url: str):
    req = urllib.request.Request(url, headers={
        "User-Agent": _UA,
        "Accept": "*/*",
        "Connection": "close",
    })
    return urllib.request.urlopen(req, timeout=_UPSTREAM_TIMEOUT)


@bp.route("/api/iptv/proxy")
def api_iptv_proxy():
    """HLS / 媒体流转发：文本按 m3u8 改写地址，二进制分块透传。"""
    target = (request.args.get("url") or "").strip()
    if not target.lower().startswith(("http://", "https://")):
        return jsonify({"ok": False, "error": "只支持 http / https 地址"}), 400
    try:
        resp = _open_upstream(target)
    except urllib.error.HTTPError as e:
        _log.warning("GET /api/iptv/proxy 上游 HTTP %s: %s", e.code, target)
        return jsonify({"ok": False,
                        "error": "上游返回 HTTP %s（该频道可能已失效或需要鉴权）" % e.code}), 502
    except Exception as e:                                  # noqa: BLE001
        _log.warning("GET /api/iptv/proxy 连接失败: %s (%s)", target, e)
        return jsonify({"ok": False, "error": "连接上游失败：%s" % e}), 502

    ctype = (resp.headers.get("Content-Type") or "").lower()
    head = b""
    try:
        if "mpegurl" in ctype or "m3u" in ctype:
            body = resp.read(_MAX_M3U8_BYTES)
            text = body.decode("utf-8", "replace")
            out = _rewrite_playlist(text, resp.geturl() or target)
            r = Response(out, mimetype="application/vnd.apple.mpegurl")
            r.headers["Cache-Control"] = "no-store"
            return r
        # 先读一小段判断是不是 m3u8（很多源 Content-Type 是 text/plain 甚至 octet-stream）
        head = resp.read(4096)
        if head.lstrip().upper().startswith(b"#EXTM3U"):
            rest = resp.read(_MAX_M3U8_BYTES)
            text = (head + rest).decode("utf-8", "replace")
            out = _rewrite_playlist(text, resp.geturl() or target)
            r = Response(out, mimetype="application/vnd.apple.mpegurl")
            r.headers["Cache-Control"] = "no-store"
            return r

        def _gen():
            try:
                chunk = head
                while chunk:
                    yield chunk
                    chunk = resp.read(64 * 1024)
            finally:
                try:
                    resp.close()
                except Exception:                           # noqa: BLE001
                    pass

        r = Response(_gen(), content_type=ctype or "application/octet-stream")
        r.headers["Cache-Control"] = "no-store"
        return r
    except Exception as e:                                  # noqa: BLE001
        try:
            resp.close()
        except Exception:                                   # noqa: BLE001
            pass
        _log.warning("GET /api/iptv/proxy 转发失败: %s (%s)", target, e)
        return jsonify({"ok": False, "error": "转发失败：%s" % e}), 502

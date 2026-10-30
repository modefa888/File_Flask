"""网络下载引擎：HTTP/HTTPS 多线程分段 · FTP 断点续传 · 磁力 / BT（aria2c）· m3u8 拼 MP4。

和「本机文件下载」的区别：
  · 本机文件：文件已经在服务器上，下载中心只负责打包 / 流式下发；
  · 网络下载：由服务器主动去互联网取文件（就是 FDM / IDM 的服务端版），
    多线程分段 + 断点续传把文件抓到「保存目录」，抓完就能直接在文件管理器里用，
    也能再从下载中心拉到本机（/api/dl/stream/<id>，同样支持 Range 续传）。

HTTP 侧完全用标准库实现（不依赖 curl / wget）：
  1. probe()  探测：跟随重定向、读 Content-Length / Accept-Ranges / Content-Disposition；
  2. 支持 Range 且文件够大 → 切成 N 段，多个线程各自 `Range: bytes=a-b` 写独立 .part；
  3. 每段进度实时累加，暂停 / 断网 / 重启后从各段已下载位置继续；
  4. 全部完成后按顺序合并成最终文件（合并期间状态 = merging）。
磁力 / BT 交给 aria2c（若已安装），进度从它的控制台输出解析。

m3u8（HLS）：
  1. 解析播放列表（master 自动挑最高码率），拿到全部 ts / m4s 分片；
  2. 多线程并发下载分片（每个分片下完原子改名，中断后跳过已完成的继续）；
  3. 下载完用 ffmpeg concat 无损拼接封装成 MP4；没装 ffmpeg 则二进制拼接为 TS；
  4. AES-128 加密流直接交给 ffmpeg 整体下载解密（需要 ffmpeg）。
"""
import ftplib
import json
import os
import re
import shutil
import ssl
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

from ...log import get_logger
from . import downloads as dl
from . import proxyutil

_log = get_logger()

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")
_CHUNK = 256 * 1024


def _size_txt(n):
    """字节数 → 可读文本（B / KB / MB / GB）。"""
    f = float(n or 0)
    for u in ("B", "KB", "MB", "GB"):
        if f < 1024 or u == "GB":
            return ("%d %s" % (int(f), u)) if u == "B" else ("%.1f %s" % (f, u))
        f /= 1024
    return "%d B" % int(n or 0)
_MIN_SEG = 256 * 1024          # 小于这个大小的文件不切段
_MAX_THREADS = 32

SRV_ACTIVE = ("probing", "downloading", "merging")

_CTRL = {}                     # tid -> "pause" / "cancel"
_CTRL_LOCK = threading.Lock()
_RUNNING = set()
_RUN_LOCK = threading.Lock()
_PROCS = {}                    # tid -> aria2 子进程


class _Stopped(Exception):
    pass


# ----------------------------------------------------------------------
# 基础工具
# ----------------------------------------------------------------------
def _ctrl(tid):
    with _CTRL_LOCK:
        return _CTRL.get(tid) or ""


def _set_ctrl(tid, val):
    with _CTRL_LOCK:
        if val:
            _CTRL[tid] = val
        else:
            _CTRL.pop(tid, None)


def is_running(tid):
    with _RUN_LOCK:
        return tid in _RUNNING


def aria2_path():
    return shutil.which("aria2c") or ""


def ffmpeg_path():
    return shutil.which("ffmpeg") or ""


def env_info():
    return {"aria2": aria2_path(), "ffmpeg": ffmpeg_path(),
            "curl": shutil.which("curl") or "",
            "wget": shutil.which("wget") or "", "ftp": True, "python": True}


# ----------------------------------------------------------------------
# 代理兜底：任务级 opts.proxy 优先，其次下载设置里的「网络下载代理」，
# 最后自动检测内置 v2ray / xray 的 HTTP 入站（本机某些站点直连会被重置，
# 浏览器走代理能播、服务器直连下载失败，就是这种情况）。
# ----------------------------------------------------------------------
def _host_local(url):
    """目标是否本机 / 局域网地址（这类地址不该走代理）。"""
    try:
        h = urllib.parse.urlsplit(url or "").hostname or ""
    except ValueError:
        return False
    if not h or h in ("localhost", "::1") or h.endswith(".local"):
        return True
    try:
        import ipaddress
        return ipaddress.ip_address(h).is_private
    except ValueError:
        return False


def _v2ray_http_proxy():
    """内置 v2ray / xray 正在跑且开了 HTTP 入站时，返回 http://127.0.0.1:端口。"""
    try:
        from ..ide import v2raymgr
        st = v2raymgr.status()
        if st.get("running"):
            port = int((st.get("inbound") or {}).get("http_port") or 0)
            if port:
                return "http://127.0.0.1:%d" % port
    except Exception:
        pass
    return ""


def _effective_proxy(opts, url=""):
    """算出该任务最终应使用的代理：任务级 > 下载设置 > 内置 v2ray HTTP 入站。"""
    opts = opts or {}
    if opts.get("direct"):
        return ""
    p = str(opts.get("proxy") or "").strip()
    if p:
        return p
    if _host_local(url):
        return ""
    try:
        p = str(dl.get_settings().get("proxy") or "").strip()
        if p:
            return p
    except Exception:
        pass
    return _v2ray_http_proxy()


def _opener(opts):
    handlers = []
    proxy = str((opts or {}).get("proxy") or "").strip()
    if proxy:
        handlers.append(urllib.request.ProxyHandler({"http": proxy, "https": proxy}))
    elif (opts or {}).get("direct"):
        handlers.append(urllib.request.ProxyHandler({}))     # 强制直连，忽略环境变量里的代理
    if (opts or {}).get("insecure"):
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        handlers.append(urllib.request.HTTPSHandler(context=ctx))
    return urllib.request.build_opener(*handlers)


def _headers(opts):
    opts = opts or {}
    h = {
        "User-Agent": str(opts.get("user_agent") or UA),
        "Accept": "*/*",
        # 关键：要求不压缩，否则 Content-Length 与字节区间都会对不上
        "Accept-Encoding": "identity",
        "Connection": "keep-alive",
    }
    if opts.get("referer"):
        h["Referer"] = str(opts["referer"])
    if opts.get("cookie"):
        h["Cookie"] = str(opts["cookie"])
    return h


def _unit(s):
    """把 aria2 的 1.2MiB / 512KiB 之类转成字节。"""
    m = re.match(r"([\d.]+)\s*([KMGT]?)i?B", str(s or ""), re.I)
    if not m:
        return 0
    try:
        n = float(m.group(1))
    except ValueError:
        return 0
    mul = {"": 1, "K": 1024, "M": 1024 ** 2, "G": 1024 ** 3, "T": 1024 ** 4}
    return int(n * mul.get((m.group(2) or "").upper(), 1))


def _name_from_cd(cd):
    if not cd:
        return ""
    m = re.search(r"filename\*\s*=\s*([^']*)''([^;]+)", cd, re.I)
    if m:
        return urllib.parse.unquote(m.group(2).strip().strip('"'))
    m = re.search(r'filename\s*=\s*"([^"]+)"', cd, re.I) or re.search(r"filename\s*=\s*([^;]+)", cd, re.I)
    if m:
        return urllib.parse.unquote(m.group(1).strip().strip('"'))
    return ""


def _name_from_url(url, fallback="download.bin"):
    try:
        path = urllib.parse.urlsplit(url).path or ""
        name = urllib.parse.unquote(os.path.basename(path.rstrip("/")))
    except Exception:
        name = ""
    return name or fallback


def _unique_path(folder, name):
    os.makedirs(folder, exist_ok=True)
    p = os.path.join(folder, name)
    if not os.path.exists(p):
        return p
    stem, ext = os.path.splitext(name)
    i = 1
    while True:
        cand = os.path.join(folder, "%s-%d%s" % (stem, i, ext))
        if not os.path.exists(cand):
            return cand
        i += 1


# ----------------------------------------------------------------------
# 链接探测
# ----------------------------------------------------------------------
def _fill(info, resp, url):
    hdrs = resp.headers
    info["final_url"] = resp.geturl() or url
    info["type"] = (hdrs.get("Content-Type") or "").split(";")[0].strip()
    cr = hdrs.get("Content-Range") or ""
    if cr and "/" in cr:
        try:
            info["size"] = int(cr.rsplit("/", 1)[1])
            info["range"] = True
        except (TypeError, ValueError):
            pass
    if not info.get("size"):
        try:
            info["size"] = int(hdrs.get("Content-Length") or 0)
        except (TypeError, ValueError):
            info["size"] = 0
    if (hdrs.get("Accept-Ranges") or "").lower() == "bytes":
        info["range"] = True
    name = _name_from_cd(hdrs.get("Content-Disposition"))
    if name:
        info["name"] = name


def _is_hls(url):
    low = (url or "").lower()
    return ".m3u8" in low


def _fetch_text(url, opts, timeout=30):
    req = urllib.request.Request(url, headers=_headers(opts))
    with _opener(opts).open(req, timeout=timeout) as r:
        return r.read(4 * 1024 * 1024).decode("utf-8", "replace"), (r.geturl() or url)


def _fetch_bytes(url, opts, timeout=30):
    req = urllib.request.Request(url, headers=_headers(opts))
    with _opener(opts).open(req, timeout=timeout) as r:
        return r.read(16 * 1024 * 1024)


def _hls_playlist(url, opts=None, depth=0):
    """解析 m3u8：master 自动挑最高码率的子列表，直到拿到媒体播放列表。

    返回 {media, segs, enc, init, duration, endlist}；
    enc 非 None 表示是加密流（AES-128 等），init 是 fMP4 的初始化分片。
    """
    opts = opts or {}
    text, final = _fetch_text(url, opts)
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    if any(ln.startswith("#EXT-X-STREAM-INF") for ln in lines):
        if depth >= 3:
            raise RuntimeError("m3u8 嵌套层级过深，解析失败")
        best_bw, best_uri, bw = -1, "", 0
        for ln in lines:
            if ln.startswith("#EXT-X-STREAM-INF"):
                m = re.search(r"BANDWIDTH=(\d+)", ln)
                bw = int(m.group(1)) if m else 0
            elif not ln.startswith("#"):
                if bw >= best_bw:
                    best_bw, best_uri = bw, ln
                bw = 0
        if not best_uri:
            raise RuntimeError("m3u8 主播放列表里没有可用子流")
        return _hls_playlist(urllib.parse.urljoin(final, best_uri), opts, depth + 1)

    segs, enc, init, duration, endlist = [], None, None, 0.0, False
    key_line = ""
    for ln in lines:
        if ln.startswith("#EXT-X-KEY") or ln.startswith("#EXT-X-SESSION-KEY"):
            m = re.search(r"METHOD=([A-Za-z0-9-]+)", ln)
            method = (m.group(1) if m else "NONE").upper()
            if method == "NONE":
                enc = None
            else:
                u = re.search(r'URI="([^"]+)"', ln)
                enc = urllib.parse.urljoin(final, u.group(1)) if u else "?"
                if not key_line:
                    key_line = ln          # 原样保留 KEY 行，拼接解密时要用
        elif ln.startswith("#EXT-X-MAP"):
            m = re.search(r'URI="([^"]+)"', ln)
            if m:
                init = urllib.parse.urljoin(final, m.group(1))
        elif ln == "#EXT-X-ENDLIST":
            endlist = True
        elif ln.startswith("#EXTINF"):
            m = re.search(r"#EXTINF:([\d.]+)", ln)
            if m:
                try:
                    duration += float(m.group(1))
                except ValueError:
                    pass
        elif not ln.startswith("#"):
            segs.append(urllib.parse.urljoin(final, ln))
    return {"media": final, "segs": segs, "enc": enc, "init": init,
            "duration": duration, "endlist": endlist, "key_line": key_line}


def _hls_stem(url):
    stem = _name_from_url(url, "video")
    stem = re.sub(r"\.m3u8$", "", stem, flags=re.I)
    return dl._safe_name(stem or "video")


def _probe_hls(url, opts=None):
    pl = _hls_playlist(url, opts)
    if not pl["segs"]:
        raise RuntimeError("m3u8 中没有可用分片（可能是直播流或链接已失效）")
    ff = bool(ffmpeg_path())
    return {"name": _hls_stem(url) + (".mp4" if ff else ".ts"),
            "size": 0, "range": False, "type": "application/vnd.apple.mpegurl",
            "final_url": url, "hls": True, "segs": len(pl["segs"]),
            "duration": round(pl.get("duration") or 0, 1), "ffmpeg": ff,
            "enc": bool(pl.get("enc"))}


def probe(url, opts=None, timeout=20):
    """探测链接信息：{name, size, range, type, final_url}。失败抛异常。"""
    opts = opts or {}
    scheme = urllib.parse.urlsplit(url).scheme.lower()
    if scheme != "ftp" and _is_hls(url):
        return _probe_hls(url, opts)
    info = {"name": "", "size": 0, "range": False, "type": "", "final_url": url}
    if scheme == "ftp":
        info.update(_probe_ftp(url, timeout=timeout))
        info["name"] = info.get("name") or _name_from_url(url)
        return info

    opener = _opener(opts)
    hdrs = _headers(opts)
    try:
        req = urllib.request.Request(url, headers=hdrs, method="HEAD")
        with opener.open(req, timeout=timeout) as r:
            _fill(info, r, url)
    except urllib.error.HTTPError as e:
        if e.code not in (400, 403, 405, 501):
            raise
    except Exception:
        pass

    if not info["size"] or not info["range"]:
        h2 = dict(hdrs)
        h2["Range"] = "bytes=0-0"
        try:
            req = urllib.request.Request(url, headers=h2)
            with opener.open(req, timeout=timeout) as r:
                _fill(info, r, url)
                if r.status == 206:
                    info["range"] = True
                try:
                    r.read(1)
                except Exception:
                    pass
        except urllib.error.HTTPError as e:
            if e.code == 416:
                info["range"] = True
            elif e.code not in (400, 403, 405, 501):
                raise
    # 没写 .m3u8 后缀、但实际返回的是 HLS 播放列表 → 转成 m3u8 探测
    if (re.search(r"mpegurl", info.get("type") or "", re.I)
            or (info.get("name") or "").lower().endswith(".m3u8")):
        return _probe_hls(info.get("final_url") or url, opts)
    if not info["name"]:
        info["name"] = _name_from_url(info["final_url"], _name_from_url(url))
    info["name"] = dl._safe_name(info["name"])
    return info


def _probe_ftp(url, timeout=20):
    u = urllib.parse.urlsplit(url)
    path = urllib.parse.unquote(u.path or "/")
    ftp = ftplib.FTP()
    try:
        ftp.connect(u.hostname, u.port or 21, timeout=timeout)
        ftp.login(urllib.parse.unquote(u.username or "anonymous"),
                  urllib.parse.unquote(u.password or "anonymous@"))
        ftp.voidcmd("TYPE I")
        try:
            size = int(ftp.size(path) or 0)
        except Exception:
            size = 0
    finally:
        try:
            ftp.close()
        except Exception:
            pass
    return {"size": size, "range": bool(size), "type": "ftp", "name": os.path.basename(path),
            "final_url": url}


# ----------------------------------------------------------------------
# 创建任务
# ----------------------------------------------------------------------
def create_task(url, save_dir="", filename="", threads=0, opts=None, user="", ip="", name=""):
    """新建网络下载任务（服务端主动下载）。返回任务 dict。"""
    url = (url or "").strip()
    if not url:
        raise ValueError("请输入下载链接")
    low = url.lower()
    if low.startswith("magnet:"):
        kind = "torrent"
    elif _is_hls(url):
        kind = "hls"
    elif low.startswith(("http://", "https://", "ftp://")):
        kind = "url"
    elif low.startswith("file://"):
        raise ValueError("本机文件请用「本机文件」方式选择，不要填 file:// 链接")
    else:
        raise ValueError("暂不支持该协议（支持 http / https / ftp / magnet）")

    cfg = dl.get_settings()
    folder = os.path.abspath(os.path.expanduser(save_dir or cfg.get("save_dir") or cfg.get("artifact_dir")
                                                or dl.ARTIFACT_ROOT))
    try:
        os.makedirs(folder, exist_ok=True)
    except OSError as e:
        raise ValueError("保存目录不可用：%s" % e)
    try:
        n = int(threads or cfg.get("threads") or 8)
    except (TypeError, ValueError):
        n = 8
    n = max(1, min(_MAX_THREADS, n))
    opts = dict(opts or {})
    px = _effective_proxy(opts, url)
    if px and not str(opts.get("proxy") or "").strip():
        opts["proxy"] = px
    if filename:
        opts["filename"] = dl._safe_name(filename)

    tid = dl._new_id()
    if kind == "hls":
        def_name = _hls_stem(url) + (".mp4" if ffmpeg_path() else ".ts")
    else:
        def_name = _name_from_url(url)
    note = ("磁力 / BT · %d 线程" % n) if kind == "torrent" else (
        "HLS · 分片下载后自动拼接 MP4" if kind == "hls" else "多线程 %d · 服务器端下载" % n)
    row = {
        "id": tid, "ts": dl._now_ts(), "kind": kind, "name": filename or def_name,
        "src": [], "src_dir": "", "save_dir": folder, "artifact": "",
        "size": 0, "done": 0, "status": "probing", "phase": "正在解析链接…",
        "error": "", "user": user or "", "ip": ip or "", "hits": 0,
        "note": note,
        "opts": opts, "url": url, "threads": n, "segs": [], "meta": {},
        "srv_done": 0, "srv_size": 0, "speed": 0,
    }
    dl._insert(row)
    dl.ensure_sweeper()
    threading.Thread(target=_run, args=(tid,), daemon=True, name="dl-url-%s" % tid).start()
    return dl.get(tid)


def resume(tid):
    """继续下载（断点续传）：把任务重新丢进线程池。"""
    t = dl.get(tid)
    if not t:
        return None
    _set_ctrl(tid, "")
    if is_running(tid):
        return t
    dl._update(tid, status="downloading", phase="", error="", speed=0)
    threading.Thread(target=_run, args=(tid,), daemon=True, name="dl-url-%s" % tid).start()
    return dl.get(tid)


def pause(tid):
    _set_ctrl(tid, "pause")
    p = _PROCS.get(tid)
    if p and p.poll() is None:
        try:
            p.terminate()
        except Exception:
            pass


def cancel(tid):
    _set_ctrl(tid, "cancel")
    p = _PROCS.get(tid)
    if p and p.poll() is None:
        try:
            p.kill()
        except Exception:
            pass


def cleanup(tid):
    """删掉分片目录（删除任务 / 清空记录时调用）。"""
    cancel(tid)
    shutil.rmtree(os.path.join(dl.ARTIFACT_ROOT, tid), ignore_errors=True)


def reconcile():
    """进程重启后：库里还是「下载中」但其实没有线程在跑的任务 → 标成已暂停，等用户继续。"""
    try:
        conn = dl.store_conn()
        try:
            rows = conn.execute(
                "SELECT id, status FROM dl_tasks WHERE status IN ('probing','downloading','merging')"
            ).fetchall()
        finally:
            conn.close()
    except Exception:
        return
    for r in rows:
        if not is_running(r["id"]):
            dl._update(r["id"], status="paused", phase="", speed=0,
                       error="" if r["status"] != "probing" else "解析被中断，请重新开始")


# ----------------------------------------------------------------------
# 调度
# ----------------------------------------------------------------------
def _run(tid):
    with _RUN_LOCK:
        _RUNNING.add(tid)
    try:
        t = dl.get(tid)
        if not t:
            return
        # 兜底代理：老任务 / 失败重试时若任务里没填代理，按「设置 → 下载」补上并落库
        opts0 = dict(t.get("opts") or {})
        px = _effective_proxy(opts0, t.get("url") or "")
        if px and not str(opts0.get("proxy") or "").strip():
            opts0["proxy"] = px
            try:
                dl._update(tid, opts=opts0)
            except Exception:
                pass
            t["opts"] = opts0
        scheme = urllib.parse.urlsplit(t.get("url") or "").scheme.lower()
        if scheme == "magnet":
            _run_torrent(tid, t)
        elif t.get("kind") == "hls":
            _run_hls(tid, t)
        elif scheme == "ftp":
            _run_ftp(tid, t)
        else:
            _run_http(tid, t)
    except _Stopped:
        pass
    except Exception as e:
        _log.warning("网络下载 %s 失败：%s", tid, e)
        dl._update(tid, status="failed", phase="", speed=0, error=str(e)[:300])
    finally:
        with _RUN_LOCK:
            _RUNNING.discard(tid)
        _PROCS.pop(tid, None)
        _set_ctrl(tid, None)


def _make_segs(size, n, existing=None):
    """把文件切成 n 段；若上次的分段一致，沿用各段已下载进度（断点续传）。"""
    if size <= 0:
        return [{"i": 0, "start": 0, "end": -1, "done": 0}]
    n = max(1, min(int(n or 1), (_MAX_THREADS if size >= _MIN_SEG else 1),
                   max(1, size // _MIN_SEG)))
    base = size // n
    segs = []
    for i in range(n):
        start = i * base
        end = (size - 1) if i == n - 1 else ((i + 1) * base - 1)
        segs.append({"i": i, "start": start, "end": end, "done": 0})
    old = {}
    for s in (existing or []):
        if isinstance(s, dict):
            try:
                old[int(s.get("i", -1))] = s
            except (TypeError, ValueError):
                pass
    for s in segs:
        o = old.get(s["i"])
        if not o:
            continue
        try:
            if int(o.get("start", -1)) == s["start"] and int(o.get("end", -1)) == s["end"]:
                total = s["end"] - s["start"] + 1
                s["done"] = max(0, min(total, int(o.get("done") or 0)))
        except (TypeError, ValueError):
            pass
    return segs


def _part(dir_path, i):
    return os.path.join(dir_path, "%03d.part" % i)


def _seg_worker(tid, url, opts, seg, parts_dir, errors, stop_evt):
    path = _part(parts_dir, seg["i"])
    retries = max(1, min(10, int((opts or {}).get("retries") or 3)))
    attempt = 0
    total = (seg["end"] - seg["start"] + 1) if seg["end"] >= 0 else -1
    while True:
        if stop_evt.is_set() or _ctrl(tid):
            return
        if total >= 0 and seg["done"] >= total:
            return
        if seg["done"] > 0 and not os.path.exists(path):
            seg["done"] = 0                     # 分片文件被清理过：从头来
        try:
            pos = seg["start"] + seg["done"]
            h = _headers(opts)
            h["Range"] = ("bytes=%d-%d" % (pos, seg["end"])) if seg["end"] >= 0 else ("bytes=%d-" % pos)
            req = urllib.request.Request(url, headers=h)
            with _opener(opts).open(req, timeout=30) as resp:
                if resp.status == 200 and (seg["i"] > 0 or seg["done"] > 0):
                    raise RuntimeError("服务器未按 Range 返回分片（可能不支持多线程）")
                mode = "r+b" if os.path.exists(path) else "wb"
                with open(path, mode) as f:
                    if seg["done"]:
                        f.seek(seg["done"])
                    while True:
                        if stop_evt.is_set() or _ctrl(tid):
                            return
                        buf = resp.read(_CHUNK)
                        if not buf:
                            break
                        f.write(buf)
                        seg["done"] += len(buf)
                        if total >= 0 and seg["done"] >= total:
                            return
            return
        except urllib.error.HTTPError as e:
            if e.code == 416:
                return                          # 这一段已经是完整的
            attempt += 1
            if attempt > retries:
                msg = proxyutil.http_status_text(e.code)
                if e.code == 403:
                    msg += ("（链接可能已过期，或站点校验 Referer / Cookie / IP；"
                            "请回网站重新复制新链接，必要时在高级选项里填写 Referer）")
                errors.append("分片 %d：%s" % (seg["i"], msg))
                return
            time.sleep(min(5, attempt))
        except Exception as e:
            attempt += 1
            if attempt > retries:
                errors.append("分片 %d：%s" % (seg["i"], proxyutil.friendly_error(e, url)))
                return
            time.sleep(min(5, attempt))


def _merge(segs, parts_dir, out_path):
    tmp = out_path + ".dlmerge"
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    with open(tmp, "wb") as out:
        for s in sorted(segs, key=lambda x: x["i"]):
            p = _part(parts_dir, s["i"])
            if not os.path.exists(p):
                continue
            with open(p, "rb") as src:
                shutil.copyfileobj(src, out, 1024 * 1024)
    os.replace(tmp, out_path)
    shutil.rmtree(parts_dir, ignore_errors=True)


# ----------------------------------------------------------------------
# HTTP / HTTPS
# ----------------------------------------------------------------------
def _run_http(tid, t):
    opts = dict(t.get("opts") or {})
    url = t.get("url") or ""
    meta = dict(t.get("meta") or {})

    if not meta.get("probed"):
        dl._update(tid, status="probing", phase="正在解析链接…", speed=0)
        info = probe(url, opts)
        # 探测后发现其实是 HLS 播放列表（链接没写 .m3u8）→ 转 HLS 流程
        if info.get("hls"):
            dl._update(tid, kind="hls")
            return _run_hls(tid, dl.get(tid) or t)
        name = dl._safe_name(opts.get("filename") or info.get("name") or "download.bin")
        out_path = _unique_path(t.get("save_dir") or dl.ARTIFACT_ROOT, name)
        meta = {"probed": 1, "size": int(info.get("size") or 0),
                "range": bool(info.get("range")), "type": info.get("type") or "",
                "final_url": info.get("final_url") or url}
        dl._update(tid, name=name, artifact=out_path, meta=meta,
                   srv_size=meta["size"], status="downloading", phase="")
        t = dl.get(tid) or t
    else:
        out_path = t.get("artifact") or ""
        if not out_path:
            name = dl._safe_name(opts.get("filename") or t.get("name") or "download.bin")
            out_path = _unique_path(t.get("save_dir") or dl.ARTIFACT_ROOT, name)
            dl._update(tid, artifact=out_path)

    size = int(meta.get("size") or 0)
    rng = bool(meta.get("range"))
    threads = max(1, int(t.get("threads") or 8)) if rng else 1
    if not rng:
        threads = 1
    segs = _make_segs(size, threads, t.get("segs"))
    if not rng:
        segs = [{"i": 0, "start": 0, "end": (size - 1) if size > 0 else -1, "done": 0}]
    parts_dir = os.path.join(dl.ARTIFACT_ROOT, tid)
    os.makedirs(parts_dir, exist_ok=True)

    base = sum(s["done"] for s in segs)
    dl._update(tid, segs=segs, srv_done=base, srv_size=size, speed=0,
               status="downloading", phase="", error="")

    errors, stop_evt, ths = [], threading.Event(), []
    for s in segs:
        if s["end"] >= 0 and s["done"] >= (s["end"] - s["start"] + 1):
            continue
        th = threading.Thread(target=_seg_worker,
                              args=(tid, url, opts, s, parts_dir, errors, stop_evt),
                              daemon=True, name="dl-seg-%s-%d" % (tid, s["i"]))
        th.start()
        ths.append(th)

    last_done, last_t = base, time.time()
    spd = 0
    while any(th.is_alive() for th in ths):
        time.sleep(0.5)
        c = _ctrl(tid)
        if c in ("pause", "cancel"):
            stop_evt.set()
            break
        done = sum(s["done"] for s in segs)
        now = time.time()
        dt = now - last_t
        speed = int((done - last_done) / dt) if dt > 0.05 else 0
        last_done, last_t = done, now
        # 平滑：瞬时 0（分片间隙 / 采样错位）按指数衰减，避免速度和剩余时间忽隐忽现
        spd = speed if speed > 0 else int(spd * 0.5)
        dl._update(tid, srv_done=done, speed=max(0, spd), segs=segs)

    for th in ths:
        th.join(timeout=5)
    done = sum(s["done"] for s in segs)
    c = _ctrl(tid)
    if c == "cancel":
        shutil.rmtree(parts_dir, ignore_errors=True)
        dl._update(tid, segs=segs, srv_done=done, speed=0, status="canceled", phase="")
        return
    if c == "pause":
        dl._update(tid, segs=segs, srv_done=done, speed=0, status="paused", phase="")
        return
    if errors:
        dl._update(tid, segs=segs, srv_done=done, speed=0, status="failed",
                   phase="", error=str(errors[0])[:300])
        return

    dl._update(tid, segs=segs, srv_done=done, speed=0, status="merging", phase="正在合并分片…")
    _merge(segs, parts_dir, out_path)
    try:
        final = os.path.getsize(out_path)
    except OSError:
        final = done
    dl._update(tid, status="ready", phase="", size=final, srv_size=final, srv_done=final,
               done=0, artifact=out_path,
               note="%s · 服务器端 %d 线程完成" % (meta.get("type") or "文件", len(segs)))


# ----------------------------------------------------------------------
# m3u8 / HLS：分片多线程下载 → ffmpeg 拼接封装 MP4
# ----------------------------------------------------------------------
def _hls_playlist_path(tid):
    return os.path.join(dl.ARTIFACT_ROOT, tid, "playlist.json")


def _hls_segs_path(tid):
    return os.path.join(dl.ARTIFACT_ROOT, tid, "segs.json")


# m3u8 分片下载台账：tid -> {"mode","total","segs": {i: {"st","tries","err","size"}}}
# 运行中实时更新；暂停 / 失败时落盘 segs.json，任务查看接口先读内存再回退文件
_SEGS_STAT = {}
_SEGS_STAT_LOCK = threading.Lock()


def _segs_stat_init(tid, total, parts_dir, done_idx=()):
    """初始化分片台账；磁盘上已存在的完整分片直接标成 ok（断点续传）。"""
    segs = {}
    for i in range(total):
        segs[i] = {"st": "ok", "tries": 0} if i in done_idx else {"st": "wait", "tries": 0}
    v = {"mode": "segs", "total": total, "segs": segs}
    with _SEGS_STAT_LOCK:
        _SEGS_STAT[tid] = v
    _segs_stat_save(tid, v, parts_dir)
    return v


def _segs_stat_entry(tid, key):
    """取某个分片的状态 dict（就地修改用）；台账不存在时返回 None。"""
    with _SEGS_STAT_LOCK:
        v = _SEGS_STAT.get(tid)
        if v is None:
            return None
        return (v["segs"].setdefault(key, {"st": "wait", "tries": 0}))


def _segs_stat_retries(tid):
    """触发过重试的分片数。"""
    with _SEGS_STAT_LOCK:
        v = _SEGS_STAT.get(tid)
        if not v:
            return 0
        return sum(1 for x in (v.get("segs") or {}).values()
                   if isinstance(x, dict) and (x.get("tries") or 0) > 0)


def _segs_stat_save(tid, v=None, parts_dir=""):
    """台账落盘：暂停 / 失败后仍能查看，重启进程也能从文件读回。"""
    try:
        parts_dir = parts_dir or os.path.join(dl.ARTIFACT_ROOT, tid)
        os.makedirs(parts_dir, exist_ok=True)
        if v is None:
            with _SEGS_STAT_LOCK:
                v = _SEGS_STAT.get(tid)
            if v is None:
                return
        with open(_hls_segs_path(tid), "w", encoding="utf-8") as f:
            json.dump(v, f)
    except Exception:
        pass


def _segs_stat_pop(tid):
    with _SEGS_STAT_LOCK:
        _SEGS_STAT.pop(tid, None)


def segs_view(tid):
    """给查看接口用的分片台账：先取进程内实时数据，回退读断点文件。"""
    with _SEGS_STAT_LOCK:
        v = _SEGS_STAT.get(tid)
        if v is not None:
            out = {"mode": v.get("mode"), "total": v.get("total") or 0,
                   "segs": {str(k): dict(x) for k, x in (v.get("segs") or {}).items()}}
            # ffmpeg 模式的整体拉流指标（弹窗的进度条 / 已处理时长 / 速度等）
            for k in ("percent", "out_time", "speed", "bitrate", "size", "ts"):
                if k in v:
                    out[k] = v[k]
            return out
    p = _hls_segs_path(tid)
    if os.path.isfile(p):
        try:
            with open(p, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return None


def _ff_head_args(opts, url=""):
    """把 Referer / Cookie / UA 变成 ffmpeg 的 -headers 参数。
    没填 Referer 时自动补同源地址（https://host/）——多数 CDN 防盗链只校验 Referer 是否同源。"""
    opts = opts or {}
    ref = str(opts.get("referer") or "").strip()
    if not ref and url:
        try:
            u = urllib.parse.urlsplit(url)
            if u.scheme and u.netloc:
                ref = "%s://%s/" % (u.scheme, u.netloc)
        except Exception:
            ref = ""
    cookie = str(opts.get("cookie") or "").strip()
    args = []
    if ref or cookie:
        parts = []
        if ref:
            parts.append("Referer: %s\r\n" % ref)
        if cookie:
            parts.append("Cookie: %s\r\n" % cookie)
        args += ["-headers", "".join(parts)]
    if opts.get("user_agent"):
        args += ["-user_agent", str(opts["user_agent"])]
    return args


def _ff_err_text(tail):
    """从 ffmpeg stderr 里挑出真正有信息量的那句（去掉 [hls @ 0x55...] 之类的地址噪音）。"""
    lines = [l.strip() for l in str(tail or "").splitlines() if l.strip()]
    clean = []
    for l in lines:
        l2 = re.sub(r"\[[^\]]*@\s*0x[0-9a-fA-F]+\]\s*", "", l).strip()
        clean.append(l2 or l)
    keys = ("error", "failed", "forbidden", "403", "404", "401", "invalid",
            "denied", "timed out", "not found", "cannot", "unsupported", "decrypt")
    hits = [l for l in clean if any(k in l.lower() for k in keys)]
    pick = hits[-1] if hits else (clean[-1] if clean else "")
    return pick[:180]


def _ff_env(opts):
    env = dict(os.environ)
    proxy = str((opts or {}).get("proxy") or "").strip()
    if proxy:
        env["http_proxy"] = proxy
        env["https_proxy"] = proxy
    return env


def _run_hls(tid, t):
    opts = dict(t.get("opts") or {})
    url = t.get("url") or ""
    ff = ffmpeg_path()
    parts_dir = os.path.join(dl.ARTIFACT_ROOT, tid)
    meta = dict(t.get("meta") or {})

    # 1) 拿播放列表：优先用上次断点留下的（重启 / 继续时不用重新解析）
    pl = None
    if meta.get("ok"):
        try:
            with open(_hls_playlist_path(tid), "r", encoding="utf-8") as f:
                pl = json.load(f)
        except Exception:
            pl = None
    if not pl:
        dl._update(tid, status="probing", phase="正在解析 m3u8 播放列表…", speed=0)
        pl = _hls_playlist(url, opts)
        if not pl["segs"]:
            raise RuntimeError("m3u8 中没有可用分片（可能是直播流或链接已失效）")
        if not pl.get("endlist"):
            raise RuntimeError("疑似直播流（HLS 无 ENDLIST），暂不支持下载")
        try:
            os.makedirs(parts_dir, exist_ok=True)
            with open(_hls_playlist_path(tid), "w", encoding="utf-8") as f:
                json.dump(pl, f)
        except OSError:
            pass
        name = dl._safe_name(opts.get("filename") or t.get("name") or "video")
        stem, ext = os.path.splitext(name)
        if ext.lower() not in (".mp4", ".ts", ".mkv", ".mov", ".flv"):
            name = (stem or "video") + (".mp4" if ff else ".ts")
        out_path = _unique_path(t.get("save_dir") or dl.ARTIFACT_ROOT, name)
        meta = {"ok": 1, "total": len(pl["segs"]), "enc": bool(pl.get("enc")),
                "init": pl.get("init") or "", "duration": round(pl.get("duration") or 0, 1),
                "ff": bool(ff)}
        dl._update(tid, kind="hls", name=name, artifact=out_path, meta=meta,
                   status="downloading", phase="", error="",
                   srv_done=0, srv_size=0, speed=0)
        t = dl.get(tid) or t
    elif pl.get("enc") and not pl.get("key_line"):
        # 旧版本断点播放列表没保存 KEY 行（没法本地解密）→ 重新解析一次
        try:
            pl2 = _hls_playlist(url, opts)
            if pl2.get("segs"):
                pl = pl2
                try:
                    os.makedirs(parts_dir, exist_ok=True)
                    with open(_hls_playlist_path(tid), "w", encoding="utf-8") as f:
                        json.dump(pl, f)
                except OSError:
                    pass
        except Exception:
            pass

    # 加密流（AES-128）：有 ffmpeg 且拿到了 KEY 行 → 自己多线程下载分片（可断点续传），
    # 最后用本地播放列表让 ffmpeg 解密拼接；否则退回 ffmpeg 整体拉流（不可续传）
    if pl.get("enc") and (not ff or not pl.get("key_line")):
        return _run_hls_ffmpeg(tid, t, pl)

    segs = pl["segs"]
    total = len(segs)
    out_path = t.get("artifact") or _unique_path(
        t.get("save_dir") or dl.ARTIFACT_ROOT,
        dl._safe_name(opts.get("filename") or t.get("name") or "video.ts"))

    # 2) 统计已完成分片（断点续传：完整分片直接跳过）
    lock = threading.Lock()
    state = {"next": 0, "done_cnt": 0, "fin_bytes": 0, "bytes": 0, "errs": []}
    stop_evt = threading.Event()

    def seg_path(i):
        return os.path.join(parts_dir, "seg_%05d.ts" % i)

    done_idx = []
    for i in range(total):
        p = seg_path(i)
        if os.path.exists(p):
            try:
                sz = os.path.getsize(p)
            except OSError:
                sz = 0
            done_idx.append(i)
            state["done_cnt"] += 1
            state["fin_bytes"] += sz
            state["bytes"] += sz
    state["next"] = state["done_cnt"]

    # 分片台账（查看切片下载 / 重试情况用）
    _segs_stat_init(tid, total, parts_dir, done_idx)

    # fMP4 初始化分片（#EXT-X-MAP）
    # init 分片通常只有几百字节，若计入"平均分片大小"会把总大小估算严重拉低，
    # 因此单独记录 init_bytes，估算时用普通分片的平均值。
    init_path, init_bytes = "", 0
    if meta.get("init") or pl.get("init"):
        init_url = meta.get("init") or pl.get("init")
        init_path = os.path.join(parts_dir, "seg_init")
        init_stat = _segs_stat_entry(tid, "init")
        if not os.path.exists(init_path):
            dl._update(tid, status="downloading", phase="正在下载初始化分片…", speed=0)
            if not _hls_fetch(tid, init_url, opts, init_path, state, lock, stop_evt,
                              stat=init_stat):
                raise RuntimeError("初始化分片（EXT-X-MAP）下载失败")
            init_bytes = int(init_stat.get("size") or 0)

    def hls_est_total():
        seg_cnt = state["done_cnt"] - (1 if init_bytes else 0)
        seg_avg = (state["fin_bytes"] - init_bytes) / seg_cnt if seg_cnt > 0 else 0
        est = int(seg_avg * total + init_bytes)
        if est and est < state["bytes"]:
            est = state["bytes"] + 1      # 估算不应小于已下载字节
        return max(0, est)

    est_size = hls_est_total()
    dl._update(tid, status="downloading", phase="", error="", speed=0,
               srv_done=state["bytes"], srv_size=est_size,
               note="HLS · 分片 %d/%d" % (state["done_cnt"], total))

    # 3) 多线程并发下载分片（先到先得，谁空闲谁领下一段）
    def worker():
        while True:
            if stop_evt.is_set() or _ctrl(tid):
                return
            with lock:
                if state["errs"]:
                    return
                i = state["next"]
                state["next"] += 1
            if i >= total:
                return
            p = seg_path(i)
            if os.path.exists(p):
                continue
            if not _hls_fetch(tid, segs[i], opts, p, state, lock, stop_evt,
                              stat=_segs_stat_entry(tid, i)):
                return

    nw = max(1, min(_MAX_THREADS, int(t.get("threads") or 8), total))
    ths = [threading.Thread(target=worker, daemon=True, name="dl-hls-%s" % tid)
           for _ in range(nw)]
    for th in ths:
        th.start()

    last_bytes, last_t = state["bytes"], time.time()
    last_save = 0.0
    spd = 0
    while any(th.is_alive() for th in ths):
        time.sleep(0.5)
        c = _ctrl(tid)
        if c in ("pause", "cancel"):
            stop_evt.set()
            break
        now = time.time()
        dt = now - last_t
        speed = int((state["bytes"] - last_bytes) / dt) if dt > 0.05 else 0
        last_bytes, last_t = state["bytes"], now
        spd = speed if speed > 0 else int(spd * 0.5)      # 同 HTTP：瞬时 0 平滑衰减
        fin = state["done_cnt"]
        est = hls_est_total()
        rt = _segs_stat_retries(tid)
        dl._update(tid, srv_done=state["bytes"], srv_size=est, speed=max(0, spd),
                   note="HLS · 分片 %d/%d" % (fin, total) + (" · 重试 %d 片" % rt if rt else ""))
        if now - last_save > 2:
            last_save = now
            _segs_stat_save(tid)
    for th in ths:
        th.join(timeout=5)

    c = _ctrl(tid)
    if c == "cancel":
        shutil.rmtree(parts_dir, ignore_errors=True)
        _segs_stat_pop(tid)
        dl._update(tid, speed=0, srv_done=state["bytes"], status="canceled", phase="")
        return
    if c == "pause":
        _segs_stat_save(tid)
        rt = _segs_stat_retries(tid)
        dl._update(tid, speed=0, srv_done=state["bytes"], status="paused", phase="",
                   note="HLS · 分片 %d/%d" % (state["done_cnt"], total) +
                        (" · 重试 %d 片" % rt if rt else ""))
        return
    if state["errs"]:
        _segs_stat_save(tid)
        dl._update(tid, speed=0, status="failed", phase="",
                   error=str(state["errs"][0])[:300])
        return

    # 4) 拼接封装：ffmpeg concat 无损转 MP4；没 ffmpeg 就二进制拼 TS
    dl._update(tid, status="merging", speed=0, srv_size=state["bytes"],
               srv_done=state["bytes"], note="HLS · %d 分片" % total,
               phase="正在拼接封装…" if ff else "正在拼接 TS…")
    final_path = _hls_merge(parts_dir, total, init_path, out_path, ff,
                            key_line=pl.get("key_line") or "", opts=opts, src_url=url)
    if not final_path:
        dl._update(tid, status="failed", phase="", speed=0,
                   error="分片拼接失败（ffmpeg 返回错误" +
                         ("，且密钥获取或解密未成功）" if pl.get("key_line") else "，且 TS 兜底也未成功）"))
        return
    if final_path != out_path:                      # ffmpeg 失败兜底成了 .ts
        out_path = final_path
        dl._update(tid, name=os.path.basename(out_path), artifact=out_path)
    try:
        final = os.path.getsize(out_path)
    except OSError:
        final = state["bytes"]
    shutil.rmtree(parts_dir, ignore_errors=True)
    _segs_stat_pop(tid)
    is_mp4 = out_path.lower().endswith(".mp4")
    dl._update(tid, status="ready", phase="", size=final, srv_size=final,
               srv_done=final, done=0, speed=0, artifact=out_path,
               note=("HLS · %d 分片 · 拼接 MP4" if is_mp4 else "HLS · %d 分片 · 拼接 TS") % total)


def _hls_fetch(tid, seg_url, opts, path, state, lock, stop_evt, retries=3, stat=None):
    """下载单个分片：写 .tmp → 原子改名，保证「存在即完整」，可断点续传。
    stat 为该分片在台账里的状态 dict（可空），每次尝试 / 重试 / 成败都会记录。"""
    tmp = path + ".tmp"
    for attempt in range(1, retries + 1):
        if stop_evt.is_set() or _ctrl(tid):
            return False
        if stat is not None:
            with lock:
                stat["st"] = "run" if attempt == 1 else "retry"
                stat["tries"] = attempt - 1
        try:
            req = urllib.request.Request(seg_url, headers=_headers(opts))
            with _opener(opts).open(req, timeout=30) as r, open(tmp, "wb") as f:
                while True:
                    if stop_evt.is_set() or _ctrl(tid):
                        try:
                            os.remove(tmp)
                        except OSError:
                            pass
                        return False
                    buf = r.read(_CHUNK)
                    if not buf:
                        break
                    f.write(buf)
                    with lock:
                        state["bytes"] += len(buf)
            os.replace(tmp, path)
            with lock:
                state["done_cnt"] += 1
                sz = os.path.getsize(path)
                state["fin_bytes"] += sz
                if stat is not None:
                    stat["st"] = "ok"
                    stat["tries"] = attempt - 1
                    stat["size"] = sz
                    stat.pop("err", None)
            return True
        except Exception as e:
            try:
                os.remove(tmp)
            except OSError:
                pass
            if attempt >= retries:
                with lock:
                    state["errs"].append("分片下载失败：%s" % proxyutil.friendly_error(e, seg_url))
                    if stat is not None:
                        stat["st"] = "fail"
                        stat["tries"] = attempt
                        stat["err"] = str(e)[:160]
                return False
            with lock:
                if stat is not None:
                    stat["st"] = "retry"
                    stat["tries"] = attempt
                    stat["err"] = str(e)[:160]
            time.sleep(min(5, attempt))
    return False


def _hls_merge(parts_dir, total, init_path, out_path, ff, key_line="", opts=None, src_url=""):
    """拼接：优先 ffmpeg 无损封装 MP4，失败退回二进制拼 TS。
    key_line 非空表示分片是 AES-128 加密的：写一个指向本地分片的 m3u8（带上原 KEY 行），
    交给 ffmpeg 的 HLS demuxer 一边取密钥一边解密拼接（必须成功，加密分片没法二进制直拼）。"""
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    entries = ([init_path] if init_path and os.path.exists(init_path) else []) + \
              [os.path.join(parts_dir, "seg_%05d.ts" % i) for i in range(total)]
    entries = [p for p in entries if os.path.exists(p)]
    if not entries:
        return ""
    stem, ext = os.path.splitext(out_path)
    tmp_out = stem + ".dlmerge" + (ext or ".mp4")
    fmt = ["-f", "mp4"] if ext.lower() in ("", ".mp4", ".mov") else []

    if ff and key_line:
        # 密钥自己下载到本地（带请求头 / 代理），ffmpeg 全程只读本地文件：
        # 避免 -headers 等 HTTP 选项作用在本地文件输入上导致「Option not found」
        km = re.search(r'URI="([^"]+)"', key_line)
        if not km:
            return ""
        try:
            key_url = urllib.parse.urljoin(src_url or "", km.group(1))
            key_path = os.path.join(parts_dir, "enc.key")
            with open(key_path, "wb") as kf:
                kf.write(_fetch_bytes(key_url, opts))
            key_line = key_line[:km.start(1)] + key_path + key_line[km.end(1):]
        except Exception as e:
            _log.warning("下载解密密钥失败：%s", e)
            return ""
        lst = os.path.join(parts_dir, "decrypt.m3u8")
        with open(lst, "w", encoding="utf-8") as f:
            f.write("#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n"
                    "#EXT-X-MEDIA-SEQUENCE:0\n")
            f.write(key_line + "\n")
            if init_path and os.path.exists(init_path):
                f.write('#EXT-X-MAP:URI="%s"\n' % init_path.replace('"', "%22"))
            for p in entries:
                f.write("#EXTINF:6.0,\n%s\n" % p)
            f.write("#EXT-X-ENDLIST\n")
        cmd = [ff, "-y", "-nostdin", "-loglevel", "error",
               "-protocol_whitelist", "file,crypto,data",
               "-allowed_extensions", "ALL", "-i", lst, "-c", "copy",
               "-bsf:a", "aac_adtstoasc"] + fmt + ["-movflags", "+faststart", tmp_out]
        try:
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=3600, env=_ff_env(opts))
            if r.returncode == 0 and os.path.exists(tmp_out) and os.path.getsize(tmp_out) > 0:
                os.replace(tmp_out, out_path)
                return out_path
            _log.warning("ffmpeg 解密拼接失败：%s", (r.stderr or "")[-300:])
        except Exception:
            pass
        try:
            os.remove(tmp_out)
        except OSError:
            pass
        return ""          # 加密分片没法二进制直拼，也没有 TS 兜底

    if ff:
        lst = os.path.join(parts_dir, "concat.txt")
        with open(lst, "w", encoding="utf-8") as f:
            for p in entries:
                f.write("file '%s'\n" % p.replace("'", "'\\''"))
        for extra in (["-bsf:a", "aac_adtstoasc"], []):
            cmd = [ff, "-y", "-nostdin", "-loglevel", "error",
                   "-f", "concat", "-safe", "0", "-i", lst,
                   "-c", "copy"] + fmt + extra + ["-movflags", "+faststart", tmp_out]
            try:
                r = subprocess.run(cmd, capture_output=True, text=True, timeout=3600)
                if r.returncode == 0 and os.path.exists(tmp_out) and os.path.getsize(tmp_out) > 0:
                    os.replace(tmp_out, out_path)
                    return out_path
            except Exception:
                pass
            try:
                os.remove(tmp_out)
            except OSError:
                pass

    # 兜底：二进制顺序拼接为 TS（主流播放器都能播）
    ts_out = os.path.splitext(out_path)[0] + ".ts"
    tmp = ts_out + ".dlmerge"
    try:
        with open(tmp, "wb") as out:
            for p in entries:
                with open(p, "rb") as src:
                    shutil.copyfileobj(src, out, 1024 * 1024)
        os.replace(tmp, ts_out)
        return ts_out if ts_out != out_path else out_path
    except Exception:
        try:
            os.remove(tmp)
        except OSError:
            pass
        return ""


def _run_hls_ffmpeg(tid, t, pl):
    """加密 HLS（AES-128）：直接交给 ffmpeg 整体下载解密 + 封装 MP4。"""
    ff = ffmpeg_path()
    if not ff:
        dl._update(tid, status="failed", phase="", speed=0,
                   error="服务器未安装 ffmpeg，无法下载加密 HLS（请先安装 ffmpeg）")
        return
    opts = dict(t.get("opts") or {})
    url = t.get("url") or ""
    out_path = t.get("artifact") or _unique_path(
        t.get("save_dir") or dl.ARTIFACT_ROOT,
        dl._safe_name(opts.get("filename") or t.get("name") or "video.mp4"))
    stem, ext = os.path.splitext(out_path)
    if ext.lower() not in (".mp4", ".ts", ".mkv", ".mov"):
        out_path = stem + ".mp4"
    _stem, _ext = os.path.splitext(out_path)
    tmp_out = _stem + ".dlmerge" + (_ext or ".mp4")
    fmt = ["-f", "mp4"] if _ext.lower() in ("", ".mp4", ".mov") else []
    duration = float(pl.get("duration") or 0) or 0.0
    # 加密流没有独立分片：台账记录 ffmpeg 的整体拉流指标给查看弹窗展示
    with _SEGS_STAT_LOCK:
        _SEGS_STAT[tid] = {"mode": "ffmpeg", "total": duration, "segs": {},
                           "percent": 0, "out_time": "", "speed": "",
                           "bitrate": "", "size": "", "ts": 0.0}

    # -headers / -user_agent 必须放在 -i 之前才对输入生效
    head = _ff_head_args(opts, url)
    cmd = [ff, "-y", "-nostdin", "-loglevel", "error", "-progress", "pipe:1"] + head + \
          ["-allowed_extensions", "ALL",      # 分片扩展名五花八门（.ts/.m4s/.jpg…）时不至于被拒
           "-http_persistent", "0",           # 部分 CDN 长连接复用会 403
           "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5",
           "-i", url, "-c", "copy", "-bsf:a", "aac_adtstoasc"] + fmt + \
          ["-movflags", "+faststart", tmp_out]

    dl._update(tid, status="downloading", phase="正在下载加密 HLS 流（ffmpeg）…", speed=0,
               srv_done=0, srv_size=(10000 if duration > 0 else 0))   # 万分比：让主进度条动起来
    # stderr 落到临时文件：失败时把 ffmpeg 的真实报错回填到任务上（PIPE 不读会阻塞/丢信息）
    err_path = os.path.join(dl.ARTIFACT_ROOT, tid + ".fferr.log")
    try:
        os.makedirs(os.path.dirname(err_path) or ".", exist_ok=True)
    except OSError:
        pass
    try:
        err_f = open(err_path, "w+", encoding="utf-8", errors="replace")
    except OSError:
        err_f = None
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE,
                            stderr=(err_f if err_f is not None else subprocess.DEVNULL),
                            text=True, bufsize=1, errors="replace", env=_ff_env(opts))
    _PROCS[tid] = proc
    last = [0]
    prog = {"size": 0}              # ffmpeg 已写入输出文件的字节数（total_size）
    tick = {"t": 0.0, "b": 0}       # 上次速度采样
    try:
        for line in proc.stdout:
            if _ctrl(tid):
                break
            # 解析 ffmpeg progress 输出（key=value 行），刷新台账指标
            kv = re.match(r"([a-z_]+)=(.*)", line.strip())
            if kv:
                k, val = kv.group(1), kv.group(2).strip()
                if k == "total_size":
                    try:
                        prog["size"] = int(val)
                    except ValueError:
                        pass
                with _SEGS_STAT_LOCK:
                    st = _SEGS_STAT.get(tid)
                    if st is not None:
                        st["ts"] = time.time()
                        st["percent"] = last[0]
                        if k == "out_time":
                            st["out_time"] = val.split(".")[0]
                        elif k == "speed":
                            st["speed"] = val
                        elif k == "bitrate":
                            st["bitrate"] = val
                        elif k == "total_size":
                            st["size"] = val
            # 进度与大小统计：已下载字节 ÷ 已处理时长 × 总时长 估算总大小
            m = re.search(r"out_time(?:_us|_ms)?=(\d+)", line)
            b = prog["size"]
            if duration > 0:
                if m:
                    frac = min(0.99, int(m.group(1)) / 1e6 / duration)
                    pct = int(frac * 100)
                    if pct >= last[0] + 1:
                        last[0] = pct
                        now = time.time()
                        sp = 0
                        if b > 0 and now > tick["t"]:
                            sp = max(0, int((b - tick["b"]) / (now - tick["t"])))
                        tick["t"], tick["b"] = now, b
                        if b > 0:
                            # 字节模式：srv_done/srv_size 为真实/估算字节数，前端显示大小与速度
                            est = max(int(b / max(frac, 0.01)), b + 1)
                            dl._update(tid, note="HLS 加密流 · %d%%" % pct,
                                       phase="ffmpeg 拉流 %d%%" % pct,
                                       srv_done=b, srv_size=est, speed=sp)
                        else:
                            # total_size 未知时退回万分比，仅显示百分比
                            dl._update(tid, note="HLS 加密流 · %d%%" % pct,
                                       phase="ffmpeg 拉流 %d%%" % pct,
                                       srv_done=int(frac * 10000), srv_size=10000, speed=0)
            elif b > 0 and b >= tick["b"] + 262144:      # 总时长未知：每 256KB 刷新一次已下载字节
                now = time.time()
                sp = max(0, int((b - tick["b"]) / (now - tick["t"]))) if now > tick["t"] else 0
                tick["t"], tick["b"] = now, b
                dl._update(tid, srv_done=b, srv_size=0, speed=sp,
                           note="HLS 加密流 · 已下载 %s" % _size_txt(b))
        proc.wait(timeout=30)
    except Exception as e:
        _log.warning("ffmpeg HLS 任务 %s 异常：%s", tid, e)
    finally:
        if proc.poll() is None:
            try:
                proc.kill()
            except Exception:
                pass
        try:
            if err_f is not None:
                err_f.close()
        except Exception:
            pass
        try:
            proc.stderr.close()
        except Exception:
            pass

    c = _ctrl(tid)
    if c == "cancel":
        shutil.rmtree(os.path.join(dl.ARTIFACT_ROOT, tid), ignore_errors=True)
        try:
            os.remove(tmp_out)
        except OSError:
            pass
        try:
            os.remove(err_path)
        except OSError:
            pass
        _segs_stat_pop(tid)
        dl._update(tid, status="canceled", phase="", speed=0)
        return
    if c == "pause":
        try:
            os.remove(tmp_out)
        except OSError:
            pass
        try:
            os.remove(err_path)
        except OSError:
            pass
        dl._update(tid, status="paused", phase="", speed=0,
                   note="HLS 加密流 · 继续将重新下载")
        return

    ok = proc.returncode == 0 and os.path.exists(tmp_out) and os.path.getsize(tmp_out) > 0
    if not ok:
        try:
            os.remove(tmp_out)
        except OSError:
            pass
        # 把 ffmpeg 的真实报错回填到任务，前端卡片 / 记录里可直接看到失败原因
        tail = ""
        try:
            with open(err_path, "r", encoding="utf-8", errors="replace") as f:
                tail = f.read()[-1200:].strip()
        except OSError:
            pass
        low = tail.lower()
        msg = "ffmpeg 下载加密流失败"
        if "reset" in low or "broken pipe" in low or "eof" in low:
            msg += ("：密钥 / 分片连接被服务器重置，通常是播放链接的签名已过期，"
                    "请回网站重新复制新链接后再新建任务；"
                    "若浏览器能播放而服务器始终被重置，多为直连被网络拦截，"
                    "请在下载中心设置里配置可用代理后再重试")
        elif "403" in low or "forbidden" in low:
            msg += "：服务器拒绝访问（403），链接可能已过期或需要 Referer / Cookie"
        elif "404" in low or "not found" in low:
            msg += "：链接或分片已失效（404），请重新获取链接"
        elif "cannot decrypt" in low or "invalid data" in low or "decrypt" in low:
            msg += ("：解密失败（密钥没取到 / 链接已过期）或流不受支持（DRM）；"
                    "旧链接重试无效，请重新复制播放链接")
        elif "timed out" in low or "timeout" in low:
            msg += "：网络超时"
        detail = _ff_err_text(tail)
        if detail:
            msg += "｜" + detail
        elif not tail:
            msg += "（流可能已失效或不被支持）"
        try:
            os.remove(err_path)
        except OSError:
            pass
        dl._update(tid, status="failed", phase="", speed=0, error=msg[:300])
        return
    try:
        os.remove(err_path)
    except OSError:
        pass
    os.replace(tmp_out, out_path)
    try:
        final = os.path.getsize(out_path)
    except OSError:
        final = 0
    shutil.rmtree(os.path.join(dl.ARTIFACT_ROOT, tid), ignore_errors=True)
    _segs_stat_pop(tid)
    dl._update(tid, status="ready", phase="", size=final, srv_size=final,
               srv_done=final, done=0, speed=0, artifact=out_path,
               name=os.path.basename(out_path), note="HLS 加密流 · ffmpeg 拼接 MP4")


# ----------------------------------------------------------------------
# FTP
# ----------------------------------------------------------------------
def _run_ftp(tid, t):
    opts = dict(t.get("opts") or {})
    u = urllib.parse.urlsplit(t.get("url") or "")
    path = urllib.parse.unquote(u.path or "/")
    name = dl._safe_name(opts.get("filename") or os.path.basename(path) or "download.bin")
    out_path = t.get("artifact") or _unique_path(t.get("save_dir") or dl.ARTIFACT_ROOT, name)

    part = os.path.join(dl.ARTIFACT_ROOT, tid + ".part")
    os.makedirs(os.path.dirname(part), exist_ok=True)
    done = int(t.get("srv_done") or 0) if os.path.exists(part) else 0

    ftp = ftplib.FTP()
    ftp.connect(u.hostname, u.port or 21, timeout=30)
    ftp.login(urllib.parse.unquote(u.username or "anonymous"),
              urllib.parse.unquote(u.password or "anonymous@"))
    ftp.voidcmd("TYPE I")
    try:
        size = int(ftp.size(path) or 0)
    except Exception:
        size = 0
    if size and done > size:
        done = 0
    dl._update(tid, name=name, artifact=out_path, srv_size=size, srv_done=done,
               status="downloading", phase="", error="", threads=1, speed=0)
    last = [time.time(), done]
    spd = 0

    try:
        with open(part, "ab" if done else "wb") as f:
            def _cb(buf):
                nonlocal spd
                if _ctrl(tid) in ("pause", "cancel"):
                    raise _Stopped()
                f.write(buf)
                done += len(buf)
                now = time.time()
                if now - last[0] >= 1.0:
                    raw = int((done - last[1]) / (now - last[0]))
                    spd = raw if raw > 0 else int(spd * 0.5)   # 瞬时 0 平滑衰减
                    dl._update(tid, srv_done=done, speed=max(0, spd))
                    last[0], last[1] = now, done
            ftp.retrbinary("RETR " + path, _cb, blocksize=_CHUNK, rest=(done or None))
    except _Stopped:
        dl._update(tid, srv_done=done, speed=0,
                   status=("canceled" if _ctrl(tid) == "cancel" else "paused"), phase="")
        return
    finally:
        try:
            ftp.close()
        except Exception:
            pass

    dl._update(tid, status="merging", phase="正在保存文件…", srv_done=done, speed=0)
    try:
        os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
        shutil.move(part, out_path)
    except Exception as e:
        dl._update(tid, status="failed", phase="", error="保存失败：%s" % e)
        return
    final = os.path.getsize(out_path)
    dl._update(tid, status="ready", phase="", size=final, srv_size=final, srv_done=final,
               done=0, artifact=out_path, note="FTP · 单连接完成")


# ----------------------------------------------------------------------
# 磁力 / BT（aria2c）
# ----------------------------------------------------------------------
def _run_torrent(tid, t):
    aria = aria2_path()
    if not aria:
        raise RuntimeError("未检测到 aria2c：磁力 / BT 需要先安装 aria2"
                           "（Ubuntu/Debian：sudo apt install aria2；macOS：brew install aria2）")
    folder = t.get("save_dir") or dl.ARTIFACT_ROOT
    os.makedirs(folder, exist_ok=True)
    threads = max(1, int(t.get("threads") or 8))
    opts = dict(t.get("opts") or {})
    meta = dict(t.get("meta") or {})

    def _find_meta_torrent():
        """aria2 --bt-save-metadata 保存的种子元数据文件（取最新的一个）。"""
        try:
            tors = [os.path.join(folder, f) for f in os.listdir(folder)
                    if f.endswith(".torrent") and os.path.isfile(os.path.join(folder, f))]
        except OSError:
            return ""
        return max(tors, key=os.path.getmtime) if tors else ""

    # 断点续传：优先用上次保存的种子元数据（跳过磁力元数据重新获取），
    # 已下载数据由 aria2 依据 .aria2 控制文件 / 分片哈希校验接续
    meta_tor = str(meta.get("torrent") or "")
    if meta_tor and not os.path.isfile(meta_tor):
        meta_tor = ""
    resumed = bool(meta_tor)
    before = set(os.listdir(folder))

    cmd = [aria, "--seed-time=0", "--summary-interval=1", "--console-log-level=notice",
           "--show-console-readout=true", "--file-allocation=none",
           "--auto-file-renaming=false", "--allow-overwrite=true", "--check-integrity=true",
           "--bt-save-metadata=true",
           "--max-connection-per-server=%d" % min(16, threads), "--split=%d" % min(16, threads),
           "--dir", folder]
    if opts.get("proxy"):
        cmd.append("--all-proxy=" + str(opts["proxy"]))
    if opts.get("user_agent"):
        cmd.append("--user-agent=" + str(opts["user_agent"]))
    cmd.append(meta_tor or (t.get("url") or ""))

    dl._update(tid, status="downloading", error="", speed=0,
               phase="正在校验已下载数据…" if resumed else "正在连接节点…")
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, bufsize=1, errors="replace")
    _PROCS[tid] = proc
    final_path = ""
    last_meta_chk = 0.0

    try:
        for line in proc.stdout:
            if _ctrl(tid):
                break
            m = re.search(r"([\d.]+[KMGT]?i?B)/([\d.]+[KMGT]?i?B)\((\d+)%\)", line)
            if m:
                dl._update(tid, srv_done=_unit(m.group(1)), srv_size=_unit(m.group(2)),
                           note="磁力 / BT · %s%%" % m.group(3))
            ms = re.search(r"DL:([\d.]+[KMGT]?i?B)", line)
            if ms:
                dl._update(tid, speed=_unit(ms.group(1)))
            md = re.search(r"Download complete:\s*(.+?)\s*$", line)
            if md:
                final_path = md.group(1).strip()
            # 元数据落地后及时记到任务上，下次继续就不必重新获取
            now = time.time()
            if now - last_meta_chk > 5:
                last_meta_chk = now
                if not meta.get("torrent"):
                    tor = _find_meta_torrent()
                    if tor:
                        meta["torrent"] = tor
                        dl._update(tid, meta=meta)
        proc.wait(timeout=10)
    except Exception as e:
        _log.warning("aria2 任务 %s 异常：%s", tid, e)
    finally:
        if proc.poll() is None:
            try:
                proc.kill()
            except Exception:
                pass

    c = _ctrl(tid)
    if c == "cancel":
        dl._update(tid, status="canceled", phase="", speed=0)
        return
    if c == "pause":
        if not meta.get("torrent"):
            tor = _find_meta_torrent()
            if tor:
                meta["torrent"] = tor
        dl._update(tid, meta=meta, status="paused", phase="", speed=0,
                   note="磁力 / BT · 已暂停（继续将从断点接续）")
        return

    # 产物：优先用 aria2 报告的完成路径；继续下载时文件不是本次新增的，
    # 退而取目录里最大的数据文件（排除 .aria2 控制文件与 .torrent 元数据）
    if not final_path or not os.path.exists(final_path):
        after = [f for f in os.listdir(folder) if f not in before and not f.endswith(".aria2")]
        cands = [os.path.join(folder, f) for f in after if os.path.isfile(os.path.join(folder, f))]
        if not cands:
            allf = [f for f in os.listdir(folder)
                    if not f.endswith(".aria2") and not f.endswith(".torrent")]
            cands = [os.path.join(folder, f) for f in allf if os.path.isfile(os.path.join(folder, f))]
        final_path = max(cands, key=os.path.getsize) if cands else ""
    if not final_path or not os.path.exists(final_path):
        dl._update(tid, status="failed", phase="", speed=0,
                   error="BT 下载未产出文件（可能没有可用节点，或种子已失效）")
        return
    try:
        final = os.path.getsize(final_path)
    except OSError:
        final = 0
    dl._update(tid, status="ready", phase="", name=os.path.basename(final_path),
               artifact=final_path, size=final, srv_size=final, srv_done=final, done=0,
               speed=0, note="磁力 / BT · 完成")

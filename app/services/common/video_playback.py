"""视频起播优化：兼容性判断 + 后台生成可直连的缓存副本。

两个高频问题在这里统一处理：
1. MP4 的 moov atom 在文件尾部时，浏览器必须先请求文件尾再回头取数据，大文件起播很慢；
   后台用 ``ffmpeg -c copy -movflags +faststart`` 重排一份缓存副本（无损、不改画质）。
2. HEVC/10bit/AVI 等浏览器解不了的编码，原本每次播放都要走实时转码；后台生成
   H.264/AAC + faststart 的 mp4 缓存，之后打开即可直连、支持 Range 拖动。

缓存键包含源文件绝对路径、mtime 和 size；源文件变化后自动失效。
"""
import hashlib
import json
import logging
import os
import struct
import subprocess
import threading
import time

from ... import config
from ...config import FFMPEG_BIN, FFPROBE_BIN

_log = logging.getLogger("fm")

_CACHE_DIR = config._PLAYBACK_CACHE_DIR
_MAX_BYTES = config._PLAYBACK_CACHE_MAX_BYTES
_MAX_FILES = config._PLAYBACK_CACHE_MAX_FILES

_INFO_CACHE = {}          # sig -> (expire_at, info)
_INFO_LOCK = threading.Lock()
_INFO_TTL_OK = 600
_INFO_TTL_FAIL = 60
_INFO_MAX = 1000

_BUILD_SEM = threading.Semaphore(1)   # 后台缓存一次只做一个，避免抢 CPU/磁盘
_INFLIGHT = set()
_QUEUED = set()
_INFLIGHT_LOCK = threading.Lock()
_CACHE_LOCK = threading.Lock()

# 浏览器（Chromium）在 mp4/webm 中普遍支持的编码
_OK_VIDEO_CODECS = {"h264", "vp8", "vp9", "av1"}
_OK_AUDIO_CODECS = {"aac", "mp3", "opus", "vorbis", None}


def _sig(path):
    try:
        st = os.stat(path)
    except OSError:
        return None
    return "%s|%d|%d" % (os.path.abspath(path), int(st.st_mtime), st.st_size)


def probe_info(path):
    """轻量探测流编码（只读头部，结果缓存 10 分钟）；失败返回空字典。"""
    sig = _sig(path)
    if sig is None:
        return {}
    now = time.time()
    with _INFO_LOCK:
        ent = _INFO_CACHE.get(sig)
        if ent and ent[0] > now:
            return dict(ent[1])

    info = {}
    try:
        out = subprocess.run(
            [FFPROBE_BIN, "-v", "error", "-show_entries",
             "stream=codec_type,codec_name,pix_fmt,width,height:format=format_name,duration",
             "-of", "json", path],
            capture_output=True, timeout=6,
        ).stdout.decode("utf-8", "ignore")
        data = json.loads(out or "{}")
        streams = data.get("streams") or []
        video = next((s for s in streams if s.get("codec_type") == "video"), None)
        if video is None:
            video = next((s for s in streams if s.get("width")), None)
        audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
        info = {
            "video_codec": (video or {}).get("codec_name"),
            "pix_fmt": (video or {}).get("pix_fmt"),
            "width": (video or {}).get("width"),
            "height": (video or {}).get("height"),
            "audio_codec": (audio or {}).get("codec_name"),
            "container": (data.get("format") or {}).get("format_name", ""),
            "duration": (data.get("format") or {}).get("duration"),
        }
    except Exception:
        info = {}

    with _INFO_LOCK:
        if len(_INFO_CACHE) > _INFO_MAX:
            _INFO_CACHE.clear()
        ttl = _INFO_TTL_OK if info.get("video_codec") else _INFO_TTL_FAIL
        _INFO_CACHE[sig] = (time.time() + ttl, info)
    return dict(info)


def needs_transcode(info, path):
    """判断浏览器能否直接解码；探测不到编码时保持原行为（交给前端 error 兜底）。"""
    ext = os.path.splitext(str(path))[1].lower().lstrip(".")
    if ext not in {"mp4", "m4v", "mov", "webm", "ogv", "ogg"}:
        return True
    codec = (info or {}).get("video_codec")
    if not codec:
        return False
    if codec not in _OK_VIDEO_CODECS:
        return True
    # 10bit / yuv444 等 H.264 变种多数浏览器放不出来
    if codec == "h264" and (info.get("pix_fmt") or "") not in {"yuv420p", "yuvj420p"}:
        return True
    if (info.get("audio_codec") or None) not in _OK_AUDIO_CODECS:
        return True
    return False


def moov_at_end(path):
    """扫描 MP4 顶层 atom，判断 moov 是否排在 mdat 之后（需整文件游玩才能起播）。"""
    ext = os.path.splitext(str(path))[1].lower().lstrip(".")
    if ext not in {"mp4", "m4v", "mov"}:
        return False
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as f:
            pos = 0
            saw_mdat = False
            while pos < size:
                f.seek(pos)
                head = f.read(8)
                if len(head) < 8:
                    return False
                length = struct.unpack(">I", head[:4])[0]
                typ = head[4:8]
                header = 8
                if length == 1:
                    ext_head = f.read(8)
                    if len(ext_head) < 8:
                        return False
                    length = struct.unpack(">Q", ext_head)[0]
                    header = 16
                elif length == 0:
                    length = size - pos
                if typ == b"mdat":
                    saw_mdat = True
                elif typ == b"moov":
                    return saw_mdat
                if length < header:
                    return False
                pos += length
    except OSError:
        return False
    return False


def _cache_file(path, kind):
    sig = _sig(path)
    if sig is None:
        return None, None
    key = hashlib.sha1(("%s|%s" % (kind, sig)).encode("utf-8", "ignore")).hexdigest()
    return os.path.join(_CACHE_DIR, key + ".mp4"), key


def find_cache(path):
    """返回已生成的缓存文件（优先转码副本，画质兼容更稳），未命中返回 (None, None)。"""
    for kind in ("transcode", "faststart"):
        p, _ = _cache_file(path, kind)
        if p and os.path.isfile(p) and os.path.getsize(p) > 0:
            return p, kind
    return None, None


def best_playback_path(path):
    """给 /api/stream 使用：命中缓存时直接发送缓存文件，否则仍发送源文件。"""
    cached, _ = find_cache(path)
    return cached or path


def _cleanup_locked():
    entries = []
    try:
        with os.scandir(_CACHE_DIR) as it:
            for e in it:
                if not e.name.endswith(".mp4"):
                    continue
                try:
                    st = e.stat()
                except OSError:
                    continue
                entries.append((st.st_mtime, st.st_size, e.path))
    except OSError:
        return
    entries.sort()
    total = sum(x[1] for x in entries)
    while entries and (total > _MAX_BYTES or len(entries) > _MAX_FILES):
        _, size, p = entries.pop(0)
        try:
            os.remove(p)
            total -= size
        except OSError:
            pass


def _build_worker(path, kind, key):
    final = os.path.join(_CACHE_DIR, key + ".mp4")
    tmp = final + ".tmp.%d" % os.getpid()
    # 实时转码正在占用 CPU 时，稍等再建缓存，避免抢资源让当前播放更卡
    if kind == "transcode":
        time.sleep(8)
    try:
        with _BUILD_SEM:
            if os.path.exists(final):
                return
            if kind == "faststart":
                cmd = [
                    FFMPEG_BIN, "-hide_banner", "-loglevel", "error",
                    "-i", path, "-map", "0:v:0", "-map", "0:a?", "-c", "copy",
                    "-movflags", "+faststart", "-f", "mp4", tmp,
                ]
            else:
                cmd = [
                    FFMPEG_BIN, "-hide_banner", "-loglevel", "error",
                    "-fflags", "+genpts+discardcorrupt", "-err_detect", "ignore_err",
                    "-i", path,
                    "-map", "0:v:0", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
                    "-pix_fmt", "yuv420p", "-vf", "scale='min(iw,1280)':-2,format=yuv420p",
                    "-map", "0:a?", "-c:a", "aac", "-b:a", "128k", "-ac", "2",
                    "-movflags", "+faststart", "-f", "mp4", tmp,
                ]
            result = subprocess.run(cmd, stdout=subprocess.DEVNULL,
                                    stderr=subprocess.PIPE, timeout=7200)
            if result.returncode == 0 and os.path.isfile(tmp) and os.path.getsize(tmp) > 0:
                os.replace(tmp, final)
                with _CACHE_LOCK:
                    _cleanup_locked()
                _log.info("视频播放缓存已生成: %s (%s)", final, kind)
            else:
                err = result.stderr.decode("utf-8", "ignore").strip()[-500:]
                _log.warning("视频播放缓存生成失败 (%s) %s: %s", kind, path, err)
    except Exception as e:
        _log.warning("视频播放缓存生成异常 (%s) %s: %s", kind, path, e)
    finally:
        try:
            if os.path.exists(tmp):
                os.remove(tmp)
        except OSError:
            pass
        with _INFLIGHT_LOCK:
            _INFLIGHT.discard(key)


def request_optimize(path, info=None):
    """后台开始生成缓存副本；返回要生成的类型（None 表示无需生成）。"""
    sig = _sig(path)
    if sig is None:
        return None
    info = info if info is not None else probe_info(path)
    kind = "transcode" if needs_transcode(info, path) else (
        "faststart" if moov_at_end(path) else None)
    if not kind:
        return None
    _, key = _cache_file(path, kind)
    if not key:
        return None
    with _INFLIGHT_LOCK:
        if key in _INFLIGHT or os.path.exists(os.path.join(_CACHE_DIR, key + ".mp4")):
            return kind
        _INFLIGHT.add(key)
    threading.Thread(target=_build_worker, args=(path, kind, key), daemon=True,
                     name="video-cache-" + key[:8]).start()
    return kind


def request_optimize_async(path):
    """非阻塞地安排后台优化（供实时转码入口调用，不增加起播等待）。"""
    sig = _sig(path)
    if sig is None:
        return
    with _INFLIGHT_LOCK:
        if sig in _QUEUED:
            return
        _QUEUED.add(sig)

    def _run():
        try:
            request_optimize(path)
        finally:
            with _INFLIGHT_LOCK:
                _QUEUED.discard(sig)

    threading.Thread(target=_run, daemon=True, name="video-cache-probe").start()


def playback_info(path):
    """给播放器用：是否需要转码、优化副本是否就绪。"""
    info = probe_info(path)
    need = needs_transcode(info, path)
    cached, cached_kind = find_cache(path)
    if cached:
        return {
            "need_transcode": need,
            "ready": True,
            "cached": cached_kind,
            "video_codec": info.get("video_codec"),
        }
    building = request_optimize(path, info)
    return {
        "need_transcode": need,
        "ready": False,
        "building": bool(building),
        "building_kind": building,
        "video_codec": info.get("video_codec"),
    }

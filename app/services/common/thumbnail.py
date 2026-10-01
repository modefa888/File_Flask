"""缩略图生成：图片用 Pillow 缩放，视频用 ffmpeg 提取帧。

为避免每次进入目录都重复抽帧 / 重复读取，缩略图结果会做两级缓存：
1. 内存缓存（LRU，进程内快速命中）
2. 磁盘缓存（跨进程/重启复用，键由文件路径 + mtime + size 决定）
源文件未修改时（mtime、size 不变）缓存始终有效；文件被替换或修改后自动失效重建。
"""
import os
import io
import hashlib
import tempfile
import subprocess
import threading
from collections import OrderedDict
import mimetypes

from ...config import (
    _IMAGE_EXTS, _VIDEO_EXTS, FFMPEG_BIN,
    _THUMB_CACHE_DIR, _THUMB_CACHE_MAX_ENTRIES, _THUMB_MEM_CACHE_MAX,
)

# 图片缩略图最长边（像素）。兼顾网格小图清晰度与预览大图加载速度。
_THUMB_IMAGE_SIZE = (512, 512)


# 视频缩略图生成（ffmpeg 抽帧）较为消耗 CPU / 磁盘 I/O。若前端一次性请求过多视频缩略图，
# 会并发启动大量 ffmpeg 进程占满资源，拖慢 /api/stream 的视频播放。
# 因此用全局信号量限制同一时刻最多运行的视频抽帧数量。
_VIDEO_THUMB_MAX_WORKER = 3
_VIDEO_THUMB_SEM = threading.Semaphore(_VIDEO_THUMB_MAX_WORKER)

# 内存缓存：cache_key -> (data, content_type)
# 容量由 config._THUMB_MEM_CACHE_MAX 控制；设为 0 时内存缓存完全关闭（仅靠磁盘+HTTP 缓存）。
_MEM_CACHE_MAX = _THUMB_MEM_CACHE_MAX
_MEM_CACHE = OrderedDict()
_MEM_CACHE_LOCK = threading.Lock()


# ========== 缓存键 / 存取 ==========
def _make_cache_key(file_path):
    """由 绝对路径 + mtime + size 生成缓存键；文件不可读取时返回 None

    带 "v2" 版本前缀：键格式变化后旧缓存条目自动作废（如截断式缩略图 → Pillow 真缩略图）。
    """
    try:
        st = os.stat(file_path)
    except OSError:
        return None
    raw = "v2|%s|%d|%d" % (os.path.abspath(file_path), int(st.st_mtime), int(st.st_size))
    return hashlib.sha1(raw.encode("utf-8", "ignore")).hexdigest()


def _mem_get(key):
    if _MEM_CACHE_MAX <= 0:
        return None
    with _MEM_CACHE_LOCK:
        item = _MEM_CACHE.get(key)
        if item is None:
            return None
        _MEM_CACHE.move_to_end(key)  # LRU：命中后移到队尾
        return item


def _mem_put(key, value):
    if _MEM_CACHE_MAX <= 0:
        return
    with _MEM_CACHE_LOCK:
        _MEM_CACHE[key] = value
        _MEM_CACHE.move_to_end(key)
        while len(_MEM_CACHE) > _MEM_CACHE_MAX:
            _MEM_CACHE.popitem(last=False)


def _disk_path(key):
    return os.path.join(_THUMB_CACHE_DIR, key + ".bin")


def _disk_get(key):
    """读取磁盘缓存，返回 (data, content_type) 或 None"""
    path = _disk_path(key)
    try:
        with open(path, "rb") as f:
            head = f.readline()          # 首行存 content_type
            data = f.read()
        if not data:
            return None
        content_type = head.decode("utf-8", "ignore").strip() or "image/jpeg"
        return data, content_type
    except (OSError, PermissionError):
        return None


def _disk_put(key, data, content_type):
    """写入磁盘缓存（原子替换，避免并发读到半成品）"""
    path = _disk_path(key)
    tmp = path + ".tmp%d" % os.getpid()
    try:
        with open(tmp, "wb") as f:
            f.write((content_type or "image/jpeg").encode("utf-8") + b"\n")
            f.write(data)
        os.replace(tmp, path)
    except (OSError, PermissionError):
        try:
            os.remove(tmp)
        except OSError:
            pass
    _prune_disk_cache()


def _prune_disk_cache():
    """条目超上限时，按 mtime 最旧清理（简单 LRU，失败不影响主流程）"""
    try:
        entries = []
        with os.scandir(_THUMB_CACHE_DIR) as it:
            for e in it:
                if e.name.endswith(".bin"):
                    try:
                        entries.append((e.stat().st_mtime, e.path))
                    except OSError:
                        continue
        if len(entries) <= _THUMB_CACHE_MAX_ENTRIES:
            return
        entries.sort()  # 最旧在前
        for _, p in entries[:len(entries) - _THUMB_CACHE_MAX_ENTRIES]:
            try:
                os.remove(p)
            except OSError:
                pass
    except OSError:
        pass


def _clear_disk_cache():
    """清空磁盘缩略图缓存（供手动清理使用）"""
    try:
        with os.scandir(_THUMB_CACHE_DIR) as it:
            for e in it:
                try:
                    os.remove(e.path)
                except OSError:
                    pass
    except OSError:
        pass
    with _MEM_CACHE_LOCK:
        _MEM_CACHE.clear()


# ========== 对外接口 ==========
def _get_thumbnail_bytes(file_path, use_cache=True):
    """获取文件缩略图（图片直接返回，视频用 ffmpeg 提取帧）

    返回 (data, content_type)；不支持或失败返回 (None, None)。
    命中内存 / 磁盘缓存时不再重复读取或抽帧。
    """
    ext = os.path.splitext(file_path)[1].lower().lstrip(".")
    if ext not in _IMAGE_EXTS and ext not in _VIDEO_EXTS:
        return None, None

    mime_type, _ = mimetypes.guess_type(file_path)
    if not mime_type:
        mime_type = "application/octet-stream"

    cache_key = _make_cache_key(file_path) if use_cache else None

    # 1) 内存缓存
    if cache_key:
        hit = _mem_get(cache_key)
        if hit is not None:
            return hit
        # 2) 磁盘缓存
        hit = _disk_get(cache_key)
        if hit is not None:
            _mem_put(cache_key, hit)
            return hit

    # 3) 实际生成；generated 标记结果是否为新生成的缩略图（决定是否写入缓存）
    generated = False
    if ext in _IMAGE_EXTS:
        data = _generate_image_thumb(file_path)
        if data is not None:
            result = (data, "image/jpeg")
            generated = True
        else:
            # Pillow 不可用或解码失败：回退返回原图完整内容。
            # 绝不能只读前 N 字节 —— 截断会让浏览器只渲染出图片顶部一条，
            # 甚至整块黑屏/空白。
            try:
                with open(file_path, "rb") as f:
                    result = (f.read(), mime_type)
            except (OSError, PermissionError):
                return None, None
    else:
        result = _extract_video_frame(file_path)
        generated = bool(result and result[0])

    if cache_key and generated and result and result[0]:
        _mem_put(cache_key, result)
        _disk_put(cache_key, result[0], result[1])
    return result


def _generate_image_thumb(file_path):
    """用 Pillow 生成图片缩略图（JPEG，最长边 512px，自动纠正 EXIF 方向）。

    成功返回 JPEG 字节；Pillow 未安装或解码失败返回 None（由调用方回退原图）。
    """
    try:
        from PIL import Image, ImageOps
    except ImportError:
        return None
    try:
        with Image.open(file_path) as im:
            im = ImageOps.exif_transpose(im)   # 按 EXIF 摆正方向
            if im.mode not in ("RGB", "L"):
                im = im.convert("RGB")         # CMYK / P / RGBA → RGB
            im.thumbnail(_THUMB_IMAGE_SIZE, Image.LANCZOS)
            buf = io.BytesIO()
            im.save(buf, "JPEG", quality=82)
            return buf.getvalue()
    except Exception:
        # 损坏文件 / 不支持的格式 / 超大图内存不足等，一律回退
        return None


def _extract_video_frame(video_path):
    """用 ffmpeg 从视频提取一帧作为缩略图（受全局并发信号量控制）"""
    # 若并发抽帧已饱和，则放弃本次缩略图，避免占用资源影响播放
    if not _VIDEO_THUMB_SEM.acquire(timeout=5):
        return None, None
    try:
        # 使用系统临时目录
        tmp_dir = tempfile.gettempdir()
        tmp_file = os.path.join(
            tmp_dir,
            "fm_thumb_%s_%d.jpg" % (hashlib.sha1(video_path.encode("utf-8", "ignore")).hexdigest()[:12], os.getpid()),
        )
        cmd = [
            FFMPEG_BIN, "-y",
            "-ss", "0.5",
            "-i", video_path,
            "-frames:v", "1",
            "-q:v", "3",
            tmp_file,
        ]
        result = subprocess.run(cmd, capture_output=True, timeout=15)
        if result.returncode == 0 and os.path.isfile(tmp_file) and os.path.getsize(tmp_file) > 0:
            with open(tmp_file, "rb") as f:
                data = f.read()
            try:
                os.remove(tmp_file)
            except OSError:
                pass
            return data, "image/jpeg"
    except (OSError, PermissionError, subprocess.TimeoutExpired, FileNotFoundError):
        pass
    finally:
        _VIDEO_THUMB_SEM.release()
    return None, None

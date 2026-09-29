#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
文件管理可视化工具（增强版）
支持自由切换任意文件夹（包括系统盘），路径自动保存在浏览器本地。
启动后自动在浏览器中打开，默认显示上次保存的路径。
"""

import os
import sys
import json
import shutil
import base64
import tempfile
import subprocess
import mimetypes
import argparse
import time
import webbrowser
import logging

_log = logging.getLogger("fm")
_log.setLevel(logging.INFO)
_handler = logging.StreamHandler()
_handler.setFormatter(logging.Formatter("[%(asctime)s] %(levelname)s %(message)s"))
_log.addHandler(_handler)
import threading
from datetime import datetime
from urllib.parse import quote

try:
    from flask import Flask, render_template_string, request, jsonify, send_file, Response as FlaskResponse, make_response, g
except ImportError:
    print("错误: 未安装 Flask，请运行: pip install flask")
    sys.exit(1)

app = Flask(__name__)
app.config["SECRET_KEY"] = "file-manager-secret"

DEFAULT_START_PATH = "/"  # 系统根目录

# 目录大小缓存文件（持久化到磁盘，基于 mtime 判断是否需要重新计算）
_DIR_SIZE_CACHE_FILE = os.path.join(os.path.expanduser("~"), ".file_manager_cache.json")
_DIR_SIZE_CACHE = {}  # { dir_path: {"size": int, "dir_mtime": float} }

# 目录列表缓存文件（持久化完整列表，目录未变动则秒回）
_LIST_CACHE_FILE = os.path.join(os.path.expanduser("~"), ".file_manager_list_cache.json")
_LIST_CACHE = {}  # { dir_path: {"mtime": float, "items": [...]} }

# 回收站配置
_TRASH_DIR = os.path.join("/tmp", ".file_manager_trash")
os.makedirs(_TRASH_DIR, exist_ok=True)
_DELETE_HISTORY_FILE = os.path.join("/tmp", ".file_manager_delete_history.json")
_DELETE_HISTORY_LOCK = threading.Lock()


def _load_delete_history():
    """加载删除历史记录"""
    try:
        with open(_DELETE_HISTORY_FILE, "r", encoding="utf-8") as _f:
            return json.load(_f)
    except (OSError, json.JSONDecodeError):
        return []


def _save_delete_history(history):
    """保存删除历史记录"""
    try:
        with open(_DELETE_HISTORY_FILE, "w", encoding="utf-8") as _f:
            json.dump(history, _f, ensure_ascii=False)
    except OSError:
        pass


def _get_trash_item_path(trash_id):
    """获取回收站中某条记录的路径"""
    return os.path.join(_TRASH_DIR, trash_id)


def _safe_filename(name):
    """将文件名转为安全的回收站文件名，避免冲突"""
    import re
    safe = re.sub(r'[<>:"/\|?*\n\t]', '_', name)
    safe = safe.strip('.')
    return safe[:180] or "unnamed"


# 启动时加载缓存
try:
    with open(_DIR_SIZE_CACHE_FILE, "r", encoding="utf-8") as _f:
        _DIR_SIZE_CACHE = json.load(_f)
except (OSError, json.JSONDecodeError):
    _DIR_SIZE_CACHE = {}

try:
    with open(_LIST_CACHE_FILE, "r", encoding="utf-8") as _f:
        _LIST_CACHE = json.load(_f)
except (OSError, json.JSONDecodeError):
    _LIST_CACHE = {}

# 控制目录列表时是否计算每个条目的大小。
# 目录大小计算（du -sb 遍历）耗时巨大：对每个子目录都触发一次会阻塞数分钟，
# 导致 UI 卡死、其他请求（点击、切路径）无法处理。
# 默认关闭：list_directory 走缓存命中则秒回，未命中只收集文件 stat，子目录 size 标记为未知。
# 调用方可通过 set_list_get_sizes(True) 显式要求计算（例如 /api/properties 之类的单点查询）。
_list_get_sizes = False

def set_list_get_sizes(val):
    g.list_get_sizes = bool(val)

# ========== 工具函数 ==========
def safe_path(user_path):
    if not user_path:
        return DEFAULT_START_PATH
    abs_path = os.path.abspath(os.path.normpath(user_path))
    return abs_path

def format_size(size_bytes):
    if size_bytes < 1024:
        return f"{size_bytes} B"
    elif size_bytes < 1024 * 1024:
        return f"{size_bytes / 1024:.1f} KB"
    elif size_bytes < 1024 * 1024 * 1024:
        return f"{size_bytes / 1024 / 1024:.1f} MB"
    else:
        return f"{size_bytes / 1024 / 1024 / 1024:.2f} GB"

def _save_cache():
    """将目录大小缓存持久化到磁盘"""
    try:
        with open(_DIR_SIZE_CACHE_FILE, "w", encoding="utf-8") as _f:
            json.dump(_DIR_SIZE_CACHE, _f, ensure_ascii=False)
    except OSError:
        pass


def _save_list_cache():
    """将目录列表缓存持久化到磁盘"""
    try:
        with open(_LIST_CACHE_FILE, "w", encoding="utf-8") as _f:
            json.dump(_LIST_CACHE, _f, ensure_ascii=False)
    except OSError:
        pass


def _invalidate_list_cache(path):
    """删除指定目录的列表缓存（文件操作后调用）"""
    _LIST_CACHE.pop(path, None)
    _save_list_cache()

def _invalidate_dir_size(dir_path):
    """删除指定目录的大小缓存"""
    _DIR_SIZE_CACHE.pop(dir_path, None)
    _DIR_SIZE_CACHE.pop(dir_path.replace("\\", "/"), None)
    _save_cache()

def get_dir_size(dir_path):
    """基于 mtime 的持久化缓存：目录未变动则秒回，有变动才重新计算。返回 None 表示无法计算。"""
    try:
        current_mtime = os.stat(dir_path).st_mtime
    except OSError:
        return None

    cached = _DIR_SIZE_CACHE.get(dir_path)
    if cached and abs(cached.get("dir_mtime", 0) - current_mtime) < 0.1 and cached.get("size") is not None:
        return cached.get("size", 0)

    result = None
    try:
        if sys.platform.startswith("win"):
            result = _get_dir_size_windows(dir_path)
        else:
            result = _get_dir_size_unix(dir_path)
    except Exception:
        pass

    _DIR_SIZE_CACHE[dir_path] = {"size": result, "dir_mtime": current_mtime}
    _save_cache()
    return result

def _get_dir_size_unix(dir_path, timeout=5):
    """Linux/macOS: du -sb（C 实现，单目录通常毫秒级）"""
    try:
        out = subprocess.run(
            ["du", "-sb", dir_path],
            capture_output=True, text=True, timeout=timeout
        ).stdout
        return int(out.split()[0]) if out else 0
    except subprocess.TimeoutExpired:
        return None

def _get_dir_size_windows(dir_path):
    """Windows: dir /s /-c 解析汇总大小"""
    out = subprocess.run(
        ["cmd", "/c", "dir", "/s", "/-c", dir_path],
        capture_output=True, text=True, timeout=5
    ).stdout
    for line in out.splitlines():
        low = line.strip().lower()
        if "bytes" in low or "字节" in low:
            # " 3,456,789,012 bytes" 或类似格式
            parts = line.replace(",", "").split()
            for p in reversed(parts):
                try:
                    return int(p)
                except ValueError:
                    continue
    return 0

def _get_dir_size_from_index(dir_path):
    """从索引中递归计算目录大小。返回 None 表示目录不在索引中（需降级到 du）。"""
    try:
        conn = _get_index_conn()
        try:
            path_norm = os.path.normpath(dir_path).replace("\\", "/")
            # 先检查目录是否存在于索引
            dir_row = conn.execute(
                "SELECT 1 FROM index_files WHERE abs_path = ? AND is_dir = 1",
                (path_norm,)
            ).fetchone()
            if not dir_row:
                return None  # 目录不在索引中，需 du
            # 查该目录下所有文件大小总和
            row = conn.execute(
                "SELECT COALESCE(SUM(size), 0) FROM index_files WHERE is_dir = 0 AND (abs_path = ? OR abs_path LIKE ?)",
                (path_norm, path_norm.rstrip("/") + "/%")
            ).fetchone()
            return int(row[0] or 0)
        finally:
            conn.close()
    except Exception:
        pass
    return None


def get_file_info(file_path, base_path, compute_size=True):
    try:
        stat = os.stat(file_path)
        is_dir = os.path.isdir(file_path)
        ext = os.path.splitext(file_path)[1].lower()
        if ext.startswith("."):
            ext = ext[1:]
        file_type = "目录" if is_dir else (ext.upper() if ext else "未知")
        rel_path = os.path.relpath(file_path, base_path) if base_path else file_path
        if rel_path == ".":
            rel_path = ""
        # 文件大小：文件直接用 stat，目录优先查索引（索引命中则毫秒级），查不到才 du。
        # 注意：compute_size=False 时跳过目录 du 遍历（避免在目录列表时阻塞数分钟）。
        unknown_size = False
        if not is_dir:
            file_size = stat.st_size
        else:
            if not compute_size:
                file_size = None
                unknown_size = True
            else:
                # 先查内存缓存（毫秒），缓存没有才查索引或 du
                file_size = get_dir_size(file_path)
                if file_size is None:
                    # 缓存未命中：尝试索引 SUM（首次慢，之后被 get_dir_size 缓存）
                    file_size = _get_dir_size_from_index(file_path)
                if file_size is None:
                    unknown_size = True
        return {
            "name": os.path.basename(file_path),
            "path": rel_path.replace("\\", "/"),
            "is_dir": is_dir,
            "size": file_size if not unknown_size else 0,
            "size_str": "大小未知" if unknown_size else format_size(file_size),
            "type": file_type,
            "mtime": datetime.fromtimestamp(stat.st_mtime).strftime("%Y-%m-%d %H:%M:%S"),
            "ext": ext,
        }
    except (OSError, PermissionError):
        return None

def list_directory(path, get_sizes=False):
    """带缓存的目录列表：目录 mtime 未变则秒回。

    get_sizes 控制是否对每个目录条目计算大小。
    - get_sizes=True：遍历每个子目录计算 du（慢，用于单点查询）。
    - get_sizes=False（默认）：目录大小走缓存 / 索引，未命中则标"大小未知"（快，用于列表加载）。
    """
    try:
        dir_mtime = os.stat(path).st_mtime
    except OSError:
        return []

    cached = _LIST_CACHE.get(path)
    if cached and abs(cached.get("mtime", 0) - dir_mtime) < 0.1:
        return cached["items"]

    items = []
    try:
        entries = os.listdir(path)
    except (OSError, PermissionError):
        return items
    for entry in entries:
        if entry.startswith("."):
            continue
        full_path = os.path.join(path, entry)
        info = get_file_info(full_path, path, compute_size=get_sizes)
        if info:
            items.append(info)
    items.sort(key=lambda x: (not x["is_dir"], x["name"].lower()))

    _LIST_CACHE[path] = {"mtime": dir_mtime, "items": items}
    _save_list_cache()
    return items

# ========== 路由 ==========
@app.route("/")
def index():
    _log.info("GET /")
    resp = make_response(render_template_string(HTML_TEMPLATE))
    resp.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate, max-age=0'
    resp.headers['Pragma'] = 'no-cache'
    resp.headers['Expires'] = '0'
    return resp

@app.route("/api/system")
def api_system():
    _log.info("GET /api/system")
    home = os.path.expanduser("~")
    if sys.platform.startswith("win"):
        root = os.environ.get("SystemDrive", "C:") + "\\"
        # Windows 桌面路径
        desktop = os.path.join(home, "Desktop")
    else:
        root = "/"
        # Linux 桌面路径（支持常见中文/英文路径）
        desktop = os.path.join(home, "Desktop")
        if not os.path.isdir(desktop):
            desktop = os.path.join(home, "桌面")
        if not os.path.isdir(desktop):
            desktop = home  # 回退到主目录
    return jsonify({"home": home, "root": root, "desktop": desktop})

@app.route("/api/files")
def api_files():
    _log.info("GET /api/files path=%s", request.args.get("path", ""))
    rel_path = request.args.get("path", "")
    target_path = safe_path(rel_path)
    if not os.path.isdir(target_path):
        return jsonify({"error": f"路径不存在或不是目录: {target_path}"}), 400

    # 分页参数（客户端可传 limit/offset）
    try:
        limit = int(request.args.get("limit", 0))
        if limit < 0:
            limit = 0
    except (TypeError, ValueError):
        limit = 0
    try:
        offset = int(request.args.get("offset", 0))
        if offset < 0:
            offset = 0
    except (TypeError, ValueError):
        offset = 0

    # 目录列表：计算目录大小（优先走索引毫秒级，未命中才 du）
    items = list_directory(target_path, get_sizes=True)
    total_size = sum(item["size"] for item in items if item.get("size", 0) >= 0)
    total_files = sum(1 for item in items if not item["is_dir"])
    total_dirs = sum(1 for item in items if item["is_dir"])
    abs_path = os.path.abspath(target_path)

    total_items = len(items)
    items_page = items[offset:offset + limit] if limit > 0 else items
    has_more = (offset + limit) < total_items if limit > 0 else False

    return jsonify({
        "current_path": rel_path,
        "current_path_abs": abs_path,
        "items": items_page,
        "total_items": total_items,
        "offset": offset,
        "limit": limit,
        "has_more": has_more,
        "stats": {
            "total_files": total_files,
            "total_dirs": total_dirs,
            "total_size": total_size,
            "total_size_str": format_size(total_size),
        },
        "parent_path": os.path.dirname(target_path) if os.path.dirname(target_path) != target_path else None,
    })

# 支持的文本预览扩展
_TEXT_EXTS = {"txt", "md", "py", "js", "ts", "jsx", "tsx", "html", "htm", "css", "scss", "less", "json", "xml", "yml", "yaml", "ini", "cfg", "conf", "env", "sh", "bat", "ps1", "rs", "go", "java", "c", "cpp", "h", "hpp", "cs", "rb", "php", "sql", "log", "csv", "toml"}
# 无扩展名但应按文本打开的文件名（小写）
_TEXT_FILENAMES = {".gitignore", ".editorconfig", ".dockerignore", "makefile", "dockerfile"}
_IMAGE_EXTS = {"png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "ico"}
_VIDEO_EXTS = {"mp4", "webm", "mkv", "avi", "mov", "m4v", "ogg", "flv"}
# 可内嵌预览的扩展
_PREVIEW_EXTS = _TEXT_EXTS | _IMAGE_EXTS | _VIDEO_EXTS
# 文件大小限制（文本/图片，视频无此限制——流式传输）
_PREVIEW_MAX_BYTES = 5 * 1024 * 1024  # 5MB
# 流式传输块大小
_STREAM_CHUNK_SIZE = 1024 * 1024  # 1MB

@app.route("/api/preview")
def api_preview():
    _log.info("GET /api/preview")
    rel_path = request.args.get("path", "")
    target_path = os.path.abspath(os.path.normpath(rel_path))
    if not os.path.isfile(target_path):
        return jsonify({"error": "路径不存在或不是文件"}), 400
    try:
        stat = os.stat(target_path)
        ext = os.path.splitext(target_path)[1].lower().lstrip(".")
        filename = os.path.basename(target_path).lower()
        is_text = ext in _TEXT_EXTS or filename in _TEXT_FILENAMES
        mime_type, _ = mimetypes.guess_type(target_path)
        if not mime_type:
            mime_type = "application/octet-stream"
        # 文本/图片限制 5MB
        if ext not in _VIDEO_EXTS and stat.st_size > _PREVIEW_MAX_BYTES:
            return jsonify({"error": f"文件过大，最大支持 {format_size(_PREVIEW_MAX_BYTES)}"}), 413
        # 视频：不限制大小，用流式传输，返回 stream URL
        if ext in _VIDEO_EXTS:
            return jsonify({
                "type": "video",
                "ext": ext,
                "stream_url": f"/api/stream?path={quote(target_path)}",
                "content_type": mime_type or f"video/{ext}",
                "size": stat.st_size,
                "size_str": format_size(stat.st_size),
            })
        # 文本/图片：base64 内联
        with open(target_path, "rb") as f:
            data = f.read()
        if is_text:
            import base64
            return jsonify({
                "type": "text",
                "ext": ext,
                "content": base64.b64encode(data).decode("utf-8"),
                "content_type": mime_type,
            })
        elif ext in _IMAGE_EXTS:
            import base64
            return jsonify({
                "type": "image",
                "ext": ext,
                "content": base64.b64encode(data).decode("utf-8"),
                "content_type": mime_type,
            })
        else:
            return jsonify({"error": f"不支持的预览类型: {ext}"}), 400
    except (OSError, PermissionError) as e:
        return jsonify({"error": f"无法读取文件: {str(e)}"}), 500


def _get_file_path_from_request(req):
    """从请求参数安全地提取文件绝对路径"""
    rel_path = req.args.get("path", "")
    target_path = os.path.abspath(os.path.normpath(rel_path))
    if not os.path.isfile(target_path):
        return None
    return target_path


def _get_thumbnail_bytes(file_path):
    """获取文件缩略图（图片直接返回，视频用 ffmpeg 提取帧）"""
    ext = os.path.splitext(file_path)[1].lower().lstrip(".")
    mime_type, _ = mimetypes.guess_type(file_path)
    if not mime_type:
        mime_type = "application/octet-stream"

    # 图片：直接读取
    if ext in _IMAGE_EXTS:
        with open(file_path, "rb") as f:
            data = f.read(_THUMBNAIL_MAX_BYTES)
        return data, mime_type

    # 视频：提取帧
    if ext in _VIDEO_EXTS:
        return _extract_video_frame(file_path)

    return None, None


def _extract_video_frame(video_path):
    """用 ffmpeg 从视频提取一帧作为缩略图"""
    try:
        # 使用系统临时目录
        tmp_dir = tempfile.gettempdir()
        tmp_file = os.path.join(tmp_dir, f"fm_thumb_{os.path.basename(video_path)}.jpg")
        cmd = [
            "ffmpeg", "-y",
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
    return None, None


# 缩略图大小限制
_THUMBNAIL_MAX_BYTES = 500 * 1024  # 500KB

@app.route("/api/thumbnail")
def api_thumbnail():
    _log.info("GET /api/thumbnail")
    """获取文件缩略图（图片直接返回，视频提取帧）"""
    target_path = _get_file_path_from_request(request)
    if target_path is None:
        return jsonify({"error": "文件不存在"}), 404

    data, content_type = _get_thumbnail_bytes(target_path)
    if data is None:
        return jsonify({"error": "无法生成缩略图"}), 400

    return FlaskResponse(
        data,
        status=200,
        content_type=content_type
    )


@app.route("/api/stream")
def api_stream():
    _log.info("GET /api/stream")
    """视频流式传输，支持 HTTP Range 请求（可暂停/拖进度/缓冲播放）"""
    target_path = _get_file_path_from_request(request)
    if target_path is None:
        return jsonify({"error": "文件不存在"}), 404

    ext = os.path.splitext(target_path)[1].lower().lstrip(".")
    if ext not in _VIDEO_EXTS:
        return jsonify({"error": "该文件类型不支持流式播放"}), 400

    try:
        mime_type, _ = mimetypes.guess_type(target_path)
        if not mime_type:
            mime_type = f"video/{ext}"

        # conditional=True 由 Flask/Werkzeug 标准实现处理 Range 请求：
        # 无 Range → 200 全量；"bytes=0-" / "100-200" / "-500"（后缀区间，探测
        # mp4 片尾 moov 用）→ 206 正确分片；非法区间 → 416。
        resp = send_file(target_path, mimetype=mime_type, conditional=True)
        resp.headers["Accept-Ranges"] = "bytes"
        return resp

    except (OSError, PermissionError) as e:
        return jsonify({"error": f"无法读取文件: {str(e)}"}), 500

def _update_index_after_delete(deleted_abs_paths):
    """删除后更新索引：移除已删记录，重新计算统计"""
    try:
        conn = _get_index_conn()
        conn.execute("BEGIN")
        for abs_path in deleted_abs_paths:
            path_norm = os.path.normpath(abs_path).replace("\\", "/")
            # 目录：删除自身及所有子记录
            conn.execute("DELETE FROM index_files WHERE abs_path = ? OR abs_path LIKE ?",
                         (path_norm, path_norm.rstrip("/") + "/%"))
        conn.commit()
        tf = conn.execute("SELECT COUNT(*) FROM index_files WHERE is_dir=0").fetchone()[0]
        td = conn.execute("SELECT COUNT(*) FROM index_files WHERE is_dir=1").fetchone()[0]
        ts = conn.execute("SELECT COALESCE(SUM(size), 0) FROM index_files WHERE is_dir=0").fetchone()[0]
        conn.execute("INSERT OR REPLACE INTO index_meta VALUES ('total_files', ?)", (str(tf),))
        conn.execute("INSERT OR REPLACE INTO index_meta VALUES ('total_dirs', ?)", (str(td),))
        conn.execute("INSERT OR REPLACE INTO index_meta VALUES ('total_size', ?)", (str(ts),))
        conn.commit()
        _INDEX_META["total_files"] = tf
        _INDEX_META["total_dirs"] = td
        _INDEX_META["total_size"] = ts
    except Exception as e:
        _log.error("更新索引失败: %s", e)
    finally:
        try:
            conn.close()
        except Exception:
            pass


def _invalidate_all_dir_sizes(deleted_abs_paths):
    """删除后清除受影响目录的大小缓存（自身 + 所有祖先）"""
    for abs_path in deleted_abs_paths:
        path = os.path.normpath(abs_path)
        _DIR_SIZE_CACHE.pop(path, None)
        _DIR_SIZE_CACHE.pop(path.replace("\\", "/"), None)
        parent = os.path.dirname(path)
        while parent and parent != os.path.dirname(parent):
            _DIR_SIZE_CACHE.pop(parent, None)
            _DIR_SIZE_CACHE.pop(parent.replace("\\", "/"), None)
            parent = os.path.dirname(parent)


@app.route("/api/zip/contents")
def api_zip_contents():
    """列出 zip 文件中的文件清单。可选参数 dir=xxx 只列出该子目录下的直接子项。"""
    _log.info("GET /api/zip/contents")
    zip_path = request.args.get("path", "")
    dir_param = request.args.get("dir", "")
    if not zip_path:
        return jsonify({"error": "未指定 zip 文件路径"}), 400
    zip_path = os.path.abspath(os.path.normpath(zip_path))
    if not os.path.isfile(zip_path):
        return jsonify({"error": "文件不存在"}), 400
    if not zip_path.lower().endswith('.zip'):
        return jsonify({"error": "不是 zip 文件"}), 400
    dir_param = dir_param.strip().rstrip('/')

    try:
        import zipfile
        entries = []
        seen_dirs = set()
        all_names = []  # 全量文件名列表（含完整路径），用于判断目录是否为空
        all_file_sizes = {}  # full_path -> file_size
        all_compressed_sizes = {}  # full_path -> compress_size
        with zipfile.ZipFile(zip_path, 'r') as zf:
            for info in zf.infolist():
                raw_name = info.filename
                name = raw_name.rstrip('/')
                all_names.append(name)
                if not info.is_dir() and not raw_name.endswith('/'):
                    full_path = (dir_param + '/' if dir_param else '') + (name[len(dir_param) + 1:] if dir_param and name.startswith(dir_param + '/') else name)
                    if full_path not in all_file_sizes:
                        all_file_sizes[full_path] = info.file_size
                        all_compressed_sizes[full_path] = info.compress_size
                if dir_param:
                    if not name.startswith(dir_param + '/'):
                        continue
                    rest = name[len(dir_param) + 1:]
                    if not rest:
                        continue  # skip the parent directory entry itself
                    if '/' in rest:
                        top = rest.split('/')[0]
                        if top and top not in seen_dirs:
                            seen_dirs.add(top)
                            entries.append({
                                "name": top, "size": 0, "compressed": 0,
                                "is_dir": True, "icon": 'bi-folder-fill',
                                "type": 'directory', "ext": '',
                            })
                        continue
                elif '/' in raw_name:
                    top = raw_name.split('/')[0]
                    if top and top not in seen_dirs:
                        seen_dirs.add(top)
                        entries.append({
                            "name": top, "size": 0, "compressed": 0,
                            "is_dir": True, "icon": 'bi-folder-fill',
                            "type": 'directory', "ext": '',
                        })
                    continue
                # 处理直接子项（文件 or 顶层目录条目）
                size = info.file_size
                compressed = info.compress_size
                is_dir = info.is_dir()
                if is_dir:
                    icon = 'bi-folder-fill'
                    entry_type = 'directory'
                else:
                    ext = (raw_name.split('.')[-1] if '.' in raw_name else '').lower()
                    entry_type = 'file'
                    if ext in ('png','jpg','jpeg','gif','svg','webp'):
                        icon = 'bi-file-image'
                    elif ext in ('mp4','webm','mkv','avi','mov'):
                        icon = 'bi-file-play'
                    elif ext in ('mp3','wav','ogg','flac'):
                        icon = 'bi-file-music'
                    elif ext in ('zip','rar','7z','tar','gz'):
                        icon = 'bi-file-zip'
                    elif ext in ('py','js','ts','html','css','json','xml','md','txt','log','csv','sql','ini','yml'):
                        icon = 'bi-file-code'
                    elif ext in ('pdf',):
                        icon = 'bi-file-earmark-pdf'
                    else:
                        icon = 'bi-file-earmark'
                # 显示名：用相对路径（去掉已过滤的前缀）
                display_name = (name[len(dir_param) + 1:] if dir_param and name.startswith(dir_param + '/') else name)
                entries.append({
                    "name": display_name,
                    "size": size, "compressed": compressed,
                    "is_dir": is_dir, "icon": icon,
                    "type": entry_type,
                    "ext": ext if not is_dir else '',
                })
        zip_size = os.path.getsize(zip_path)
        # 为每个目录条目计算 is_empty + 递归大小
        for e in entries:
            if e['is_dir']:
                dir_name = e['name']
                dir_path_full = (dir_param + '/' if dir_param else '') + dir_name
                has_children = any(n.startswith(dir_path_full + '/') for n in all_names)
                e['is_empty'] = not has_children
                if not e['is_empty']:
                    e['size'] = sum(v for k, v in all_file_sizes.items() if k.startswith(dir_path_full + '/'))
                    e['compressed'] = sum(v for k, v in all_compressed_sizes.items() if k.startswith(dir_path_full + '/'))
        # 按名称去重（显式目录条目 + 虚拟目录条目同名时，保留非空的那个）
        dedup = {}
        for e in entries:
            if e['name'] in dedup:
                # 优先保留非空的
                if e.get('is_empty') is False and dedup[e['name']].get('is_empty') is not False:
                    dedup[e['name']] = e
                continue
            dedup[e['name']] = e
        entries = list(dedup.values())
        total_uncompressed = sum(e['size'] for e in entries if not e['is_dir'])
        return jsonify({
            "success": True,
            "zip_path": zip_path,
            "zip_name": os.path.basename(zip_path),
            "zip_size": zip_size,
            "zip_size_str": format_size_safe(zip_size),
            "total_uncompressed": total_uncompressed,
            "total_uncompressed_str": format_size_safe(total_uncompressed),
            "entry_count": len(entries),
            "entries": entries,
        })
    except zipfile.BadZipFile:
        return jsonify({"error": "无效的 zip 文件"}), 400
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/zip/file")
def api_zip_file():
    """从 zip 文件中下载单个文件"""
    _log.info("GET /api/zip/file")
    zip_path = request.args.get("zip_path", "")
    entry_name = request.args.get("entry", "")
    if not zip_path or not entry_name:
        return jsonify({"error": "缺少参数"}), 400
    zip_path = os.path.abspath(os.path.normpath(zip_path))
    if not os.path.isfile(zip_path):
        return jsonify({"error": "zip 文件不存在"}), 400

    try:
        import zipfile
        with zipfile.ZipFile(zip_path, 'r') as zf:
            try:
                data = zf.read(entry_name)
            except KeyError:
                return jsonify({"error": f"文件中没有: {entry_name}"}), 404

            info = zf.getinfo(entry_name)
            if info.is_dir():
                return jsonify({"error": "目录无法下载"}), 400

            content_type, _ = mimetypes.guess_type(entry_name)
            content_type = content_type or 'application/octet-stream'
            download_name = info.filename
            if download_name.startswith('/') or download_name.startswith('\\'):
                download_name = download_name.lstrip('/\\')

            resp = FlaskResponse(data, mimetype=content_type)
            resp.headers['Content-Disposition'] = f'attachment; filename*="UTF-8\'\'{quote(download_name)}"; filename="{quote(download_name)}"'
            return resp
    except zipfile.BadZipFile:
        return jsonify({"error": "无效的 zip 文件"}), 400
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/zip/extract")
def api_zip_extract():
    """下载解压后的压缩包"""
    _log.info("GET /api/zip/extract")
    zip_path = request.args.get("zip_path", "")
    if not zip_path:
        return jsonify({"error": "缺少参数"}), 400
    zip_path = os.path.abspath(os.path.normpath(zip_path))
    if not os.path.isfile(zip_path):
        return jsonify({"error": "文件不存在"}), 400

    try:
        import zipfile
        import io
        with zipfile.ZipFile(zip_path, 'r') as zf:
            # 重新打包，确保所有路径扁平化
            buf = io.BytesIO()
            with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as out:
                for name in zf.namelist():
                    if name.endswith('/') or name.endswith('\\'):
                        continue
                    data = zf.read(name)
                    # 取最后一层文件名
                    base = os.path.basename(name)
                    if not base:
                        base = 'unnamed_file'
                    out.writestr(base, data)
            buf.seek(0)
            zip_name = os.path.basename(zip_path).replace('.zip', '_extracted.zip')
            resp = FlaskResponse(buf.read(), mimetype='application/zip')
            resp.headers['Content-Disposition'] = f'attachment; filename*="UTF-8\'\'{quote(zip_name)}"; filename="{quote(zip_name)}"'
            return resp
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/zip/preview")
def api_zip_preview():
    """读取 zip 中单个文件（base64 内联，用于在线预览）"""
    _log.info("GET /api/zip/preview")
    zip_path = request.args.get("zip_path", "")
    entry_name = request.args.get("entry", "")
    if not zip_path or not entry_name:
        return jsonify({"error": "缺少参数"}), 400
    zip_path = os.path.abspath(os.path.normpath(zip_path))
    if not os.path.isfile(zip_path):
        return jsonify({"error": "zip 文件不存在"}), 400

    try:
        import zipfile
        import base64
        with zipfile.ZipFile(zip_path, 'r') as zf:
            try:
                info = zf.getinfo(entry_name)
            except KeyError:
                return jsonify({"error": f"文件中没有: {entry_name}"}), 404
            if info.is_dir():
                return jsonify({"error": "目录无法预览"}), 400
            data = zf.read(entry_name)
            ext = (info.filename.split('.')[-1] if '.' in info.filename else '').lower()
            content_type, _ = mimetypes.guess_type(entry_name)
            content_type = content_type or 'application/octet-stream'
            return jsonify({
                "success": True,
                "ext": ext,
                "content_type": content_type,
                "size": len(data),
                "size_str": format_size(len(data)),
                "content": base64.b64encode(data).decode("utf-8"),
            })
    except zipfile.BadZipFile:
        return jsonify({"error": "无效的 zip 文件"}), 400
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/zip/create", methods=["POST"])
def api_zip_create():
    """把多个文件/目录压缩为一个 zip 文件，保存在目标目录（默认为父目录）"""
    _log.info("POST /api/zip/create")
    data = request.get_json()
    if not data:
        return jsonify({"error": "无效请求"}), 400
    paths = data.get("paths", [])
    if not paths:
        return jsonify({"error": "未指定要压缩的文件"}), 400
    dest_dir = data.get("dest_dir", "")
    name_hint = (data.get("name", "") or "压缩包").strip()
    if not dest_dir or not os.path.isdir(dest_dir):
        dest_dir = os.path.abspath(os.path.normpath(paths[0]))
        while dest_dir and os.path.isfile(dest_dir):
            dest_dir = os.path.dirname(dest_dir)
        if not os.path.isdir(dest_dir):
            return jsonify({"error": "无法确定保存目录"}), 400

    # 校验每个路径存在且不能把 zip 自身压缩进去
    abs_paths = []
    for p in paths:
        ap = os.path.abspath(os.path.normpath(p))
        if not os.path.exists(ap):
            return jsonify({"error": f"路径不存在: {p}"}), 400
        abs_paths.append(ap)

    # 生成目标 zip 文件名（避免同名冲突）
    if not name_hint or name_hint.endswith('.zip'):
        base = name_hint
    else:
        base = name_hint + ".zip"
    if not base.endswith('.zip'):
        base += '.zip'
    target = os.path.join(dest_dir, base)
    if not target.endswith('.zip'):
        target += '.zip'
    counter = 1
    while os.path.exists(target):
        target = os.path.join(dest_dir, f"{base[:-4]}_{counter}.zip")
        counter += 1

    # 把目标也规范化，避免自身被压缩进自身
    target = os.path.abspath(target)

    try:
        import zipfile
        total = 0
        with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED) as zf:
            for ap in abs_paths:
                if os.path.isdir(ap):
                    for root, dirs, files in os.walk(ap):
                        for f in files:
                            fp = os.path.join(root, f)
                            arc = os.path.relpath(fp, os.path.dirname(ap))
                            zf.write(fp, arc)
                            total += 1
                else:
                    arc = os.path.relpath(ap, dest_dir)
                    zf.write(ap, arc)
                    total += 1
        _invalidate_list_cache(dest_dir)
        final_size = os.path.getsize(target)
        return jsonify({
            "success": True,
            "path": target,
            "name": os.path.basename(target),
            "size": final_size,
            "size_str": format_size(final_size),
            "files": total,
        })
    except Exception as e:
        try:
            if os.path.exists(target):
                os.remove(target)
        except OSError:
            pass
        return jsonify({"error": str(e)}), 500


@app.route("/api/zip/nested")
def api_zip_nested():
    """把 zip 内的某个文件当作 zip 读取，返回其目录清单（用于嵌套压缩包查看）。
    entry 格式: outer_entry[/inner_subdir]，例如 hello.zip/sub 表示查看 hello.zip 内 sub 目录下的文件。"""
    _log.info("GET /api/zip/nested")
    zip_path = request.args.get("zip_path", "")
    entry = request.args.get("entry", "")
    if not zip_path or not entry:
        return jsonify({"error": "缺少参数"}), 400
    zip_path = os.path.abspath(os.path.normpath(zip_path))
    if not os.path.isfile(zip_path):
        return jsonify({"error": "zip 文件不存在"}), 400

    try:
        import zipfile
        import io
        parts = entry.split('/', 1)
        outer_entry = parts[0]
        inner_dir = (parts[1] if len(parts) > 1 else '').rstrip('/')

        with zipfile.ZipFile(zip_path, 'r') as zf:
            try:
                data = zf.read(outer_entry)
            except KeyError:
                return jsonify({"error": f"文件中没有: {outer_entry}"}), 404

        entries = []
        prefix = inner_dir + '/' if inner_dir else ''
        zip_size = len(data)
        seen_dirs = set()
        all_inner_names = []
        inner_file_sizes = {}
        inner_compressed_sizes = {}
        with zipfile.ZipFile(io.BytesIO(data), 'r') as inner:
            for info in inner.infolist():
                name = info.filename
                all_inner_names.append(name.rstrip('/'))
                if not info.is_dir() and not info.filename.endswith('/'):
                    rel = name[len(prefix):] if name.startswith(prefix) else name
                    if rel not in inner_file_sizes:
                        inner_file_sizes[rel] = info.file_size
                        inner_compressed_sizes[rel] = info.compress_size
                if not name.startswith(prefix):
                    continue
                rest = name[len(prefix):]
                if not rest:
                    continue  # skip the parent directory entry itself
                # 只有确实还有更深路径时，才收集虚拟目录
                if '/' in rest:
                    top = rest.split('/')[0]
                    if top and top not in seen_dirs:
                        seen_dirs.add(top)
                        entries.append({
                            "name": top,
                            "size": 0,
                            "compressed": 0,
                            "is_dir": True,
                            "icon": 'bi-folder-fill',
                            "type": 'directory',
                            "ext": '',
                        })
                    continue  # only show direct children
                size = info.file_size
                compressed = info.compress_size
                is_dir = info.is_dir()
                if is_dir:
                    icon = 'bi-folder-fill'
                    entry_type = 'directory'
                else:
                    ext = (name.split('.')[-1] if '.' in name else '').lower()
                    entry_type = 'file'
                    if ext in ('png','jpg','jpeg','gif','svg','webp'):
                        icon = 'bi-file-image'
                    elif ext in ('mp4','webm','mkv','avi','mov'):
                        icon = 'bi-file-play'
                    elif ext in ('mp3','wav','ogg','flac'):
                        icon = 'bi-file-music'
                    elif ext in ('zip','rar','7z','tar','gz'):
                        icon = 'bi-file-zip'
                    elif ext in ('py','js','ts','html','css','json','xml','md','txt','log','csv','sql','ini','yml'):
                        icon = 'bi-file-code'
                    elif ext in ('pdf',):
                        icon = 'bi-file-earmark-pdf'
                    else:
                        icon = 'bi-file-earmark'
                entries.append({
                    "name": rest,
                    "size": size,
                    "compressed": compressed,
                    "is_dir": is_dir,
                    "icon": icon,
                    "type": entry_type,
                    "ext": ext if not is_dir else '',
                })
        # 计算 is_empty + 递归大小
        for e in entries:
            if e['is_dir']:
                dir_path_full = e['name']
                has_children = any(n.startswith(dir_path_full + '/') for n in all_inner_names)
                e['is_empty'] = not has_children
                if not e['is_empty']:
                    e['size'] = sum(v for k, v in inner_file_sizes.items() if k.startswith(dir_path_full + '/'))
                    e['compressed'] = sum(v for k, v in inner_compressed_sizes.items() if k.startswith(dir_path_full + '/'))
        # 按名称去重（显式目录条目 + 虚拟目录条目同名时，保留非空的那个）
        dedup = {}
        for e in entries:
            if e['name'] in dedup:
                if e.get('is_empty') is False and dedup[e['name']].get('is_empty') is not False:
                    dedup[e['name']] = e
                continue
            dedup[e['name']] = e
        entries = list(dedup.values())
        total_uncompressed = sum(e['size'] for e in entries if not e['is_dir'])
        return jsonify({
            "success": True,
            "zip_name": os.path.basename(outer_entry),
            "zip_size": zip_size,
            "zip_size_str": format_size_safe(zip_size),
            "total_uncompressed": total_uncompressed,
            "total_uncompressed_str": format_size_safe(total_uncompressed),
            "entry_count": len(entries),
            "entries": entries,
        })
    except zipfile.BadZipFile:
        return jsonify({"error": "嵌套文件不是有效的 zip 文件"}), 400
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/zip/nested/preview")
def api_zip_nested_preview():
    """读取嵌套 zip 内单个文件（base64 内联）。entry 格式: outer_entry/inner_path"""
    _log.info("GET /api/zip/nested/preview")
    zip_path = request.args.get("zip_path", "")
    entry = request.args.get("entry", "")
    if not zip_path or not entry:
        return jsonify({"error": "缺少参数"}), 400
    zip_path = os.path.abspath(os.path.normpath(zip_path))
    if not os.path.isfile(zip_path):
        return jsonify({"error": "zip 文件不存在"}), 400
    try:
        import zipfile
        import io
        import base64
        parts = entry.split('/', 1)
        outer_entry = parts[0]
        inner_name = parts[1] if len(parts) > 1 else os.path.basename(outer_entry)
        with zipfile.ZipFile(zip_path, 'r') as zf:
            try:
                data = zf.read(outer_entry)
            except KeyError:
                return jsonify({"error": f"文件中没有: {outer_entry}"}), 404
        with zipfile.ZipFile(io.BytesIO(data), 'r') as inner:
            try:
                inner_data = inner.read(inner_name)
            except KeyError:
                return jsonify({"error": f"嵌套 zip 中未找到: {inner_name}"}), 404
            ext = (inner_name.split('.')[-1] if '.' in inner_name else '').lower()
            content_type, _ = mimetypes.guess_type(inner_name)
            content_type = content_type or 'application/octet-stream'
            return jsonify({
                "success": True,
                "ext": ext,
                "content_type": content_type,
                "size": len(inner_data),
                "size_str": format_size(len(inner_data)),
                "content": base64.b64encode(inner_data).decode("utf-8"),
            })
    except zipfile.BadZipFile:
        return jsonify({"error": "无效的 zip 文件"}), 400
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/zip/nested/file")
def api_zip_nested_file():
    """从嵌套 zip 下载单个文件"""
    _log.info("GET /api/zip/nested/file")
    zip_path = request.args.get("zip_path", "")
    entry = request.args.get("entry", "")
    if not zip_path or not entry:
        return jsonify({"error": "缺少参数"}), 400
    zip_path = os.path.abspath(os.path.normpath(zip_path))
    if not os.path.isfile(zip_path):
        return jsonify({"error": "zip 文件不存在"}), 400
    try:
        import zipfile
        import io
        parts = entry.split('/', 1)
        outer_entry = parts[0]
        inner_name = parts[1] if len(parts) > 1 else os.path.basename(outer_entry)
        with zipfile.ZipFile(zip_path, 'r') as zf:
            try:
                data = zf.read(outer_entry)
            except KeyError:
                return jsonify({"error": f"文件中没有: {outer_entry}"}), 404
        with zipfile.ZipFile(io.BytesIO(data), 'r') as inner:
            try:
                inner_data = inner.read(inner_name)
            except KeyError:
                return jsonify({"error": f"嵌套 zip 中未找到: {inner_name}"}), 404
            content_type, _ = mimetypes.guess_type(inner_name)
            content_type = content_type or 'application/octet-stream'
            resp = FlaskResponse(inner_data, mimetype=content_type)
            resp.headers['Content-Disposition'] = f'attachment; filename*="UTF-8\'\'{quote(inner_name)}"; filename="{quote(inner_name)}"'
            return resp
    except zipfile.BadZipFile:
        return jsonify({"error": "无效的 zip 文件"}), 400
    except Exception as e:
        return jsonify({"error": str(e)}), 500


def format_size_safe(size):
    """安全格式化文件大小（API 端使用，避免导入 JS 函数）"""
    if size < 1024:
        return f"{size} B"
    elif size < 1024 * 1024:
        return f"{size / 1024:.1f} KB"
    elif size < 1024 * 1024 * 1024:
        return f"{size / 1024 / 1024:.1f} MB"
    else:
        return f"{size / 1024 / 1024 / 1024:.2f} GB"


@app.route("/api/delete", methods=["POST"])
def api_delete():
    _log.info("POST /api/delete")
    data = request.get_json()
    if not data:
        return jsonify({"error": "无效请求"}), 400
    paths = data.get("paths", [])
    if not paths:
        return jsonify({"error": "未指定文件"}), 400
    deleted = []
    errors = []
    deleted_abs = []
    trash_items = []
    for rel_path in paths:
        target_path = os.path.abspath(os.path.normpath(rel_path))
        if not os.path.exists(target_path):
            errors.append(f"{rel_path}: 文件不存在")
            continue
        script_path = os.path.abspath(__file__)
        if target_path == script_path:
            errors.append(f"{rel_path}: 不能删除脚本自身")
            continue
        try:
            # 生成唯一 trash id
            trash_id = str(int(time.time() * 1000)) + "_" + str(abs(hash(target_path)) % 100000)
            trash_path = _get_trash_item_path(trash_id)
            is_dir = os.path.isdir(target_path)
            file_size = os.path.getsize(target_path) if not is_dir else 0

            # 移动到回收站（跨设备时回退为复制+删除）
            moved = False
            try:
                if is_dir:
                    shutil.move(target_path, trash_path)
                else:
                    os.rename(target_path, trash_path)
                moved = True
            except OSError as e:
                if e.errno == 18 or 'cross-device' in str(e).lower():
                    # 跨文件系统：复制后删除原文件
                    try:
                        if is_dir:
                            shutil.copytree(target_path, trash_path)
                        else:
                            shutil.copy2(target_path, trash_path)
                        # 删除原文件
                        if is_dir:
                            shutil.rmtree(target_path, ignore_errors=True)
                        else:
                            os.remove(target_path)
                        moved = True
                    except Exception as e2:
                        raise e2  # 重新抛出，走下面的错误处理
                else:
                    raise  # 非跨设备错误，直接抛出

            deleted.append(rel_path)
            deleted_abs.append(target_path)
            _invalidate_list_cache(os.path.dirname(target_path))

            # 记录删除历史
            trash_items.append({
                "id": trash_id,
                "original_path": target_path,
                "trash_path": trash_path,
                "name": os.path.basename(target_path),
                "is_dir": is_dir,
                "size": file_size,
                "deleted_at": int(time.time()),
            })
        except Exception as e:
            errors.append(f"{rel_path}: {str(e)}")

    # 更新索引：删除对应记录，重新计算祖先目录大小
    if deleted_abs:
        _update_index_after_delete(deleted_abs)
        _invalidate_all_dir_sizes(deleted_abs)

    # 保存删除历史
    if trash_items:
        with _DELETE_HISTORY_LOCK:
            history = _load_delete_history()
            history.extend(trash_items)
            # 保留最近 500 条
            if len(history) > 500:
                history = history[-500:]
            _save_delete_history(history)

    return jsonify({"success": True, "deleted": deleted, "errors": errors, "trash_items": trash_items})


@app.route("/api/undo-delete", methods=["POST"])
def api_undo_delete():
    """从回收站恢复文件或目录到原路径（5秒回退功能）"""
    _log.info("POST /api/undo-delete")
    data = request.get_json()
    if not data:
        return jsonify({"error": "无效请求"}), 400
    trash_id = data.get("trash_id", "")
    if not trash_id:
        return jsonify({"error": "未指定 trash_id"}), 400

    trash_path = _get_trash_item_path(trash_id)
    if not os.path.exists(trash_path):
        return jsonify({"error": f"回收站中找不到该项目: {trash_id}"}), 400

    with _DELETE_HISTORY_LOCK:
        history = _load_delete_history()

    record = None
    for i, item in enumerate(history):
        if item.get("id") == trash_id:
            record = item
            history.pop(i)
            break

    if record is None:
        # 回收站文件存在但历史记录丢失，尝试通过路径恢复
        record = {"original_path": trash_path, "trash_path": trash_path}

    original_path = record.get("original_path", "")
    try:
        # 确保父目录存在
        parent_dir = os.path.dirname(original_path)
        os.makedirs(parent_dir, exist_ok=True)

        # 检查原路径是否已存在（防止冲突）
        if os.path.exists(original_path):
            # 原路径被占用，移动到回收站的原始位置
            safe_name = _safe_filename(os.path.basename(original_path))
            fallback = os.path.join(parent_dir, safe_name + "_恢复冲突_" + str(int(time.time())))
            if os.path.isdir(trash_path):
                shutil.move(trash_path, fallback)
            else:
                os.rename(trash_path, fallback)
            return jsonify({"success": False, "error": "原路径已被占用，已恢复为: " + fallback})

        # 恢复文件到原位置
        if os.path.isdir(trash_path):
            shutil.move(trash_path, original_path)
        else:
            os.rename(trash_path, original_path)

        _invalidate_list_cache(parent_dir)

        # 更新索引：重新插入恢复的文件
        try:
            conn = _get_index_conn()
            st = os.stat(original_path)
            is_dir = os.path.isdir(trash_path)
            ext = os.path.splitext(os.path.basename(original_path))[1].lower().lstrip(".")
            conn.execute(
                "INSERT OR REPLACE INTO index_files (abs_path, name, ext, size, mtime, is_dir, parent_dir) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (original_path, os.path.basename(original_path), ext if not is_dir else '',
                 0 if is_dir else st.st_size, st.st_mtime, is_dir, os.path.dirname(original_path))
            )
            conn.commit()
            conn.close()
        except Exception:
            pass

        # 持久化更新后的历史记录
        with _DELETE_HISTORY_LOCK:
            _save_delete_history(history)

        return jsonify({"success": True, "message": "已恢复: " + original_path})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/delete-history")
def api_delete_history():
    """获取删除历史记录"""
    _log.info("GET /api/delete-history")
    with _DELETE_HISTORY_LOCK:
        history = _load_delete_history()
    # 反转：最新的在前
    history.reverse()
    # 检查回收站文件是否仍存在
    for item in history:
        item["exists"] = os.path.exists(item.get("trash_path", ""))
    return jsonify({"items": history, "count": len(history)})


@app.route("/api/delete-history/clear", methods=["POST"])
def api_clear_delete_history():
    """清空回收站和删除历史"""
    _log.info("POST /api/delete-history/clear")
    with _DELETE_HISTORY_LOCK:
        history = _load_delete_history()

    removed = 0
    errors = 0
    for item in history:
        trash_path = item.get("trash_path", "")
        if os.path.exists(trash_path):
            try:
                if os.path.isdir(trash_path):
                    shutil.rmtree(trash_path, ignore_errors=True)
                else:
                    os.remove(trash_path)
                removed += 1
            except Exception:
                errors += 1

    with _DELETE_HISTORY_LOCK:
        _save_delete_history([])

    return jsonify({"success": True, "removed": removed, "errors": errors})


@app.route("/api/delete-history/one", methods=["DELETE"])
def api_delete_history_one():
    """永久删除回收站中的单个项目"""
    _log.info("DELETE /api/delete-history/one")
    data = request.get_json()
    if not data:
        return jsonify({"error": "无效请求"}), 400
    trash_id = data.get("trash_id", "")
    if not trash_id:
        return jsonify({"error": "未指定 trash_id"}), 400

    trash_path = _get_trash_item_path(trash_id)

    with _DELETE_HISTORY_LOCK:
        history = _load_delete_history()

    record = None
    for i, item in enumerate(history):
        if item.get("id") == trash_id:
            record = item
            history.pop(i)
            break

    if record is None:
        return jsonify({"error": "历史记录中找不到该项目"}), 404

    try:
        if os.path.exists(trash_path):
            if os.path.isdir(trash_path):
                shutil.rmtree(trash_path, ignore_errors=True)
            else:
                os.remove(trash_path)

        with _DELETE_HISTORY_LOCK:
            _save_delete_history(history)

        return jsonify({"success": True, "removed": record.get("name", trash_id)})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ========== 文件创建/编辑 API ==========
@app.route("/api/files/create", methods=["POST"])
def api_files_create():
    _log.info("POST /api/files/create")
    data = request.get_json()
    if not data:
        return jsonify({"error": "无效请求"}), 400
    path = data.get("path", "").strip()
    name = data.get("name", "").strip()
    is_dir = data.get("is_dir", False)
    if not name:
        return jsonify({"error": "名称不能为空"}), 400
    forbidden = ['<', '>', ':', '"', '|', '?', '*']
    for ch in forbidden:
        if ch in name:
            return jsonify({"error": f"名称不能包含 {ch}"}), 400
    if os.path.sep in name:
        return jsonify({"error": "名称不能包含路径分隔符"}), 400

    target_dir = safe_path(path)
    if not os.path.isdir(target_dir):
        return jsonify({"error": f"目录不存在: {target_dir}"}), 400
    full_path = os.path.abspath(os.path.normpath(os.path.join(target_dir, name)))
    if os.path.exists(full_path):
        return jsonify({"error": f"已存在: {name}"}), 400

    try:
        if is_dir:
            os.makedirs(full_path, exist_ok=True)
        else:
            with open(full_path, 'w', encoding='utf-8') as f:
                pass  # 创建空文件
        _invalidate_list_cache(target_dir)
        _invalidate_dir_size(target_dir)
        return jsonify({"success": True, "path": full_path, "name": name, "is_dir": is_dir})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/files/save", methods=["POST"])
def api_files_save():
    _log.info("POST /api/files/save")
    data = request.get_json()
    if not data:
        return jsonify({"error": "无效请求"}), 400
    path = data.get("path", "").strip()
    content = data.get("content", "")
    if not path:
        return jsonify({"error": "未指定路径"}), 400

    full_path = os.path.abspath(os.path.normpath(path))
    parent_dir = os.path.dirname(full_path)

    # 保护自身
    script_path = os.path.abspath(__file__)
    if full_path == script_path:
        return jsonify({"error": "不能修改脚本自身"}), 400

    try:
        # 确保父目录存在
        if parent_dir and not os.path.isdir(parent_dir):
            os.makedirs(parent_dir, exist_ok=True)
        # 确保不是目录
        if os.path.isdir(full_path):
            return jsonify({"error": "不能写入目录"}), 400
        with open(full_path, 'w', encoding='utf-8') as f:
            f.write(content)
        _invalidate_list_cache(parent_dir)
        _invalidate_dir_size(parent_dir)
        return jsonify({"success": True, "path": full_path, "size": os.path.getsize(full_path)})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/rename", methods=["POST"])
def api_rename():
    data = request.get_json()
    if not data:
        return jsonify({"error": "无效请求"}), 400
    old_path = os.path.abspath(os.path.normpath(data.get("path", "")))
    new_name = data.get("new_name", "").strip()
    if not new_name:
        return jsonify({"error": "名称不能为空"}), 400
    forbidden = ['<', '>', ':', '"', '|', '?', '*', '\\', '/']
    for ch in forbidden:
        if ch in new_name:
            return jsonify({"error": f"名称不能包含 {ch}"}), 400
    if os.path.sep in new_name:
        return jsonify({"error": "名称不能包含路径分隔符"}), 400
    if not os.path.exists(old_path):
        return jsonify({"error": "文件不存在"}), 404
    parent = os.path.dirname(old_path)
    new_path = os.path.join(parent, new_name)
    if os.path.exists(new_path):
        return jsonify({"error": f"目标名称 '{new_name}' 已存在"}), 400
    os.rename(old_path, new_path)
    _invalidate_list_cache(parent)
    _invalidate_list_cache(os.path.dirname(new_path))
    return jsonify({"success": True, "new_path": new_path})


@app.route("/api/move", methods=["POST"])
def api_move():
    data = request.get_json()
    if not data:
        return jsonify({"error": "无效请求"}), 400
    src = os.path.abspath(os.path.normpath(data.get("path", "")))
    dest_dir = os.path.abspath(os.path.normpath(data.get("dest_dir", "")))
    if not os.path.exists(src):
        return jsonify({"error": "源文件不存在"}), 404
    if not os.path.isdir(dest_dir):
        return jsonify({"error": "目标目录不存在"}), 400
    dest = os.path.join(dest_dir, os.path.basename(src))
    if os.path.exists(dest):
        return jsonify({"error": f"目标 '{os.path.basename(src)}' 已存在"}), 400
    shutil.move(src, dest_dir)
    _invalidate_list_cache(os.path.dirname(src))
    _invalidate_list_cache(dest_dir)
    return jsonify({"success": True})


@app.route("/api/copy", methods=["POST"])
def api_copy():
    data = request.get_json()
    if not data:
        return jsonify({"error": "无效请求"}), 400
    src = os.path.abspath(os.path.normpath(data.get("path", "")))
    dest_dir = os.path.abspath(os.path.normpath(data.get("dest_dir", "")))
    if not os.path.exists(src):
        return jsonify({"error": "源文件不存在"}), 404
    if not os.path.isdir(dest_dir):
        return jsonify({"error": "目标目录不存在"}), 400
    dest = os.path.join(dest_dir, os.path.basename(src))
    if os.path.exists(dest):
        return jsonify({"error": f"目标 '{os.path.basename(src)}' 已存在"}), 400
    if os.path.isdir(src):
        shutil.copytree(src, dest)
    else:
        shutil.copy2(src, dest)
    _invalidate_list_cache(dest_dir)
    return jsonify({"success": True})


@app.route("/api/new-folder", methods=["POST"])
def api_new_folder():
    data = request.get_json()
    if not data:
        return jsonify({"error": "无效请求"}), 400
    parent = os.path.abspath(os.path.normpath(data.get("parent", "")))
    name = data.get("name", "").strip()
    if not name:
        return jsonify({"error": "名称不能为空"}), 400
    if not os.path.isdir(parent):
        return jsonify({"error": "父目录不存在"}), 400
    new_dir = os.path.join(parent, name)
    if os.path.exists(new_dir):
        return jsonify({"error": f"'{name}' 已存在"}), 400
    os.makedirs(new_dir, exist_ok=True)
    _invalidate_list_cache(parent)
    return jsonify({"success": True})


@app.route("/api/properties")
def api_properties():
    rel_path = request.args.get("path", "")
    target_path = os.path.abspath(os.path.normpath(rel_path))
    if not os.path.exists(target_path):
        return jsonify({"error": "路径不存在"}), 404
    stat = os.stat(target_path)
    ext = os.path.splitext(target_path)[1].lower().lstrip(".")
    mime_type, _ = mimetypes.guess_type(target_path)
    is_dir = os.path.isdir(target_path)

    if is_dir:
        dir_info = _get_dir_info(target_path)
        return jsonify({
            "name": os.path.basename(target_path),
            "path": target_path,
            "parent": os.path.dirname(target_path),
            "size": dir_info["size"],
            "size_str": _human_size(dir_info["size"]),
            "total_files": dir_info["total_files"],
            "total_dirs": dir_info["total_dirs"],
            "sub_dirs": dir_info["sub_dirs"],
            "sub_files": dir_info["sub_files"],
            "is_dir": True,
            "created": datetime.fromtimestamp(stat.st_ctime).strftime("%Y-%m-%d %H:%M:%S"),
            "modified": datetime.fromtimestamp(stat.st_mtime).strftime("%Y-%m-%d %H:%M:%S"),
            "permissions": oct(stat.st_mode)[-3:],
            "mime_type": "folder",
        })

    return jsonify({
        "name": os.path.basename(target_path),
        "path": target_path,
        "parent": os.path.dirname(target_path),
        "size": stat.st_size,
        "size_str": _human_size(stat.st_size),
        "ext": ext,
        "is_dir": False,
        "created": datetime.fromtimestamp(stat.st_ctime).strftime("%Y-%m-%d %H:%M:%S"),
        "modified": datetime.fromtimestamp(stat.st_mtime).strftime("%Y-%m-%d %H:%M:%S"),
        "permissions": oct(stat.st_mode)[-3:],
        "mime_type": mime_type or "unknown",
    })


def _get_dir_info(dir_path):
    """获取目录信息：总大小、递归文件数、递归目录数、直接子目录数、直接文件数"""
    total_size = 0
    total_files = 0
    total_dirs = 0
    sub_dirs = 0
    sub_files = 0
    try:
        for root, dirs, files in os.walk(dir_path):
            for f in files:
                fp = os.path.join(root, f)
                try:
                    total_size += os.stat(fp).st_size
                    total_files += 1
                except (OSError, PermissionError):
                    pass
            for d in dirs:
                total_dirs += 1
            # 直接子项
            if root == dir_path:
                sub_dirs = len([d for d in dirs if not d.startswith('.')])
                sub_files = len(files)
    except (OSError, PermissionError):
        pass
    return {
        "size": total_size,
        "total_files": total_files,
        "total_dirs": total_dirs,
        "sub_dirs": sub_dirs,
        "sub_files": sub_files,
    }


def _human_size(size_bytes):
    """格式化文件大小"""
    for unit in ['B', 'KB', 'MB', 'GB', 'TB']:
        if size_bytes < 1024:
            return f"{size_bytes:.1f} {unit}" if unit != 'B' else f"{int(size_bytes)} B"
        size_bytes /= 1024
    return f"{size_bytes:.1f} PB"


# ========== 持久化索引（SQLite）==========
import sqlite3

_INDEX_DB_FILE = os.path.join(os.path.expanduser("~"), ".file_manager_index.db")
_INDEX_DB_NEW = _INDEX_DB_FILE + ".new"
_INDEX_LOCK = threading.Lock()
_INDEX_META = {"total_files": 0, "total_dirs": 0, "total_size": 0, "last_scan": None, "status": "idle", "progress": 0, "status_detail": ""}
_SCAN_EVENT = threading.Event()  # 触发重新扫描的信号
_INDEX_BUILD_LOCK = threading.Lock()


def _get_index_conn(db_path=None):
    """打开索引 DB 连接。只读文件系统自动降级到 immutable 模式。"""
    path = db_path or _INDEX_DB_FILE
    try:
        conn = sqlite3.connect(path, timeout=30)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        return conn
    except sqlite3.OperationalError:
        # 只读文件系统：用 immutable 模式只读打开
        try:
            conn = sqlite3.connect(f"file:{path}?mode=ro&immutable=1", uri=True, timeout=30)
            return conn
        except sqlite3.OperationalError:
            raise


def _init_index_db(db_path=None):
    conn = _get_index_conn(db_path)
    try:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS index_files (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                abs_path TEXT UNIQUE NOT NULL,
                name TEXT NOT NULL,
                ext TEXT DEFAULT '',
                size INTEGER DEFAULT 0,
                mtime REAL DEFAULT 0,
                is_dir INTEGER DEFAULT 0,
                parent_dir TEXT DEFAULT ''
            );
            CREATE INDEX IF NOT EXISTS idx_name ON index_files(name);
            CREATE INDEX IF NOT EXISTS idx_ext ON index_files(ext);
            CREATE INDEX IF NOT EXISTS idx_parent ON index_files(parent_dir);
            CREATE TABLE IF NOT EXISTS index_meta (
                key TEXT PRIMARY KEY,
                value TEXT
            );
        """)
        conn.commit()
    finally:
        conn.close()


def _index_has_data(db_path=None):
    """检查索引 DB 是否已有数据"""
    try:
        conn = _get_index_conn(db_path)
        try:
            row = conn.execute("SELECT COUNT(*) FROM index_files WHERE is_dir=0").fetchone()
            return row and row[0] > 0
        finally:
            conn.close()
    except Exception:
        return False


def _load_index_meta():
    """从已有索引 DB 加载元信息"""
    conn = _get_index_conn()
    try:
        rows = conn.execute("SELECT key, value FROM index_meta").fetchall()
        meta = dict(rows)
        _INDEX_META["total_files"] = int(meta.get("total_files", 0))
        _INDEX_META["total_dirs"] = int(meta.get("total_dirs", 0))
        _INDEX_META["total_size"] = int(meta.get("total_size", 0))
        _INDEX_META["last_scan"] = meta.get("last_scan", "从未扫描")
        _INDEX_META["status"] = "idle"
        _INDEX_META["progress"] = 100
        has_data = _INDEX_META["total_files"] > 0
        conn.close()
        return has_data
    except Exception:
        conn.close()
        return False


def _scan_root(root, stop_event, conn, max_results=2000000):
    """遍历根目录，将结果写入索引。返回 (count, errors)。conn 由调用方传入（主 DB 或临时 DB）
    进度更新：写入 _INDEX_META["progress"]，0-90 段（扫描阶段），由 _build_index 追加 90-100（后处理）
    """
    _VIRT_FS_PREFIXES = ("/proc", "/sys", "/dev", "/run", "/snap", "/boot", "/dev/shm")
    _MAX_FILE_SIZE = 256 * 1024 * 1024 * 1024  # 超过 256GB 视为虚拟文件

    count = 0
    errors = 0
    try:
        conn.execute("BEGIN")
        for dirpath, dirnames, filenames in os.walk(root):
            if stop_event.is_set():
                break
            dirnames[:] = [d for d in dirnames if not d.startswith(".")]
            dirpath_norm = os.path.normpath(dirpath).replace("\\", "/")

            if not sys.platform.startswith("win"):
                is_virt = any(dirpath_norm == p or dirpath_norm.startswith(p + "/") for p in _VIRT_FS_PREFIXES)
                if is_virt:
                    dirnames[:] = []
                    continue

            try:
                st = os.stat(dirpath)
                conn.execute(
                    "INSERT OR REPLACE INTO index_files (abs_path, name, ext, size, mtime, is_dir, parent_dir) VALUES (?, ?, '', 0, ?, 1, ?)",
                    (dirpath_norm, os.path.basename(dirpath), st.st_mtime, os.path.dirname(dirpath_norm))
                )
                count += 1
            except (OSError, PermissionError):
                errors += 1
                continue

            for fname in filenames:
                if stop_event.is_set():
                    break
                fpath = os.path.join(dirpath, fname)
                fpath_norm = os.path.normpath(fpath).replace("\\", "/")
                try:
                    st = os.stat(fpath)
                    if st.st_size > _MAX_FILE_SIZE:
                        continue
                    ext = os.path.splitext(fname)[1].lower().lstrip(".")
                    conn.execute(
                        "INSERT OR REPLACE INTO index_files (abs_path, name, ext, size, mtime, is_dir, parent_dir) VALUES (?, ?, ?, ?, ?, 0, ?)",
                        (fpath_norm, fname, ext, st.st_size, st.st_mtime, os.path.dirname(fpath_norm))
                    )
                    count += 1
                except (OSError, PermissionError):
                    errors += 1
                    continue
            # 每 5000 项更新一次进度；扫描阶段占用 0-90% 进度
            if count % 5000 == 0:
                conn.commit()
                # 每 50K 项 ≈ 1% 进度；约 5M 项时到 90%（典型全盘最大）
                _INDEX_META["progress"] = min(90, count // 50000)
        conn.commit()
    except Exception as e:
        try:
            conn.rollback()
        except Exception:
            pass
        return count, f"error: {str(e)}"
    return count, None


def _query_index(keyword, ext_filter, type_filter, limit=5000):
    """从索引中查询，返回文件信息列表"""
    conn = _get_index_conn()
    try:
        keyword_l = keyword.lower()
        ext_l = ext_filter.lower().lstrip(".") if ext_filter else ""

        where_clauses = []
        params = []

        # 关键字匹配文件名
        if keyword:
            where_clauses.append("(name LIKE ?)")
            params.append(f"%{keyword}%")

        # 扩展名过滤
        if ext_l:
            where_clauses.append("(ext = ?)")
            params.append(ext_l)

        # 类型过滤
        if type_filter == "文件":
            where_clauses.append("(is_dir = 0)")
        elif type_filter == "目录":
            where_clauses.append("(is_dir = 1)")

        where_sql = " AND ".join(where_clauses) if where_clauses else "1=1"
        params.append(limit)

        rows = conn.execute(
            f"SELECT abs_path, name, ext, size, mtime, is_dir FROM index_files WHERE {where_sql} ORDER BY name LIMIT ?",
            params
        ).fetchall()

        results = []
        for row in rows:
            abs_path, name, ext, size, mtime, is_dir = row
            info = {
                "name": name,
                "path": abs_path,
                "abs_path": abs_path,
                "rel_path": abs_path,
                "is_dir": bool(is_dir),
                "size": size or 0,
                "size_str": format_size(size or 0),
                "type": "目录" if is_dir else (ext.upper() if ext else "未知"),
                "mtime": datetime.fromtimestamp(mtime).strftime("%Y-%m-%d %H:%M:%S") if mtime else "-",
                "ext": ext or "",
            }
            results.append(info)
        return results
    finally:
        conn.close()


def _get_index_meta():
    """获取索引元信息"""
    status = _INDEX_META.get("status", "idle")
    progress = _INDEX_META.get("progress", 0)
    status_detail = _INDEX_META.get("status_detail", "")

    if status == "scanning":
        return {
            "total_files": _INDEX_META.get("total_files", 0),
            "total_dirs": _INDEX_META.get("total_dirs", 0),
            "total_size": _INDEX_META.get("total_size", 0),
            "total_size_str": format_size(_INDEX_META.get("total_size", 0)),
            "last_scan": "扫描中...",
            "status": "scanning",
            "progress": progress,
            "status_detail": status_detail,
        }

    conn = _get_index_conn()
    try:
        rows = conn.execute("SELECT key, value FROM index_meta").fetchall()
        meta = dict(rows)
        last_scan = meta.get("last_scan", "从未扫描")
        total_files = int(meta.get("total_files", 0))
        total_dirs = int(meta.get("total_dirs", 0))
        total_size = int(meta.get("total_size", 0))

        if total_files == 0 and last_scan == "从未扫描":
            last_scan = "等待中..."

        return {
            "total_files": total_files,
            "total_dirs": total_dirs,
            "total_size": total_size,
            "total_size_str": format_size(total_size),
            "last_scan": last_scan,
            "status": status,
            "progress": progress,
            "status_detail": status_detail,
        }
    finally:
        conn.close()


def _build_index(roots):
    """构建索引（写入临时 DB，完成后原子替换主 DB，不删除旧索引）
    进度分段：
      0-90%：文件扫描（由 _scan_root 更新）
      90%：扫描完成，准备统计
      92%：正在统计文件总数和大小
      95%：正在计算类型分布
      98%：正在替换索引 DB
      100%：完成
    status_detail 字段说明当前阶段，UI 可显示文字提示
    """
    if not _INDEX_BUILD_LOCK.acquire(timeout=1):
        return {"status": "busy", "message": "索引构建中..."}

    if os.path.exists(_INDEX_DB_NEW):
        try:
            os.remove(_INDEX_DB_NEW)
        except Exception:
            pass

    _init_index_db(_INDEX_DB_NEW)
    stop_event = threading.Event()

    def _worker():
        try:
            _INDEX_META["status"] = "scanning"
            _INDEX_META["progress"] = 0
            _INDEX_META["status_detail"] = "正在扫描文件..."
            total_count = 0
            all_errors = []
            roots_list = [r.strip() for r in roots.split(";") if r.strip()]
            if not roots_list:
                if sys.platform.startswith("win"):
                    roots_list = [os.environ.get("SystemDrive", "C:") + "\\"]
                else:
                    roots_list = ["/"]

            tconn = _get_index_conn(_INDEX_DB_NEW)
            for root in roots_list:
                if stop_event.is_set():
                    break
                root = os.path.abspath(os.path.normpath(root))
                if not os.path.isdir(root):
                    all_errors.append(f"{root}: 目录不存在")
                    continue
                _INDEX_META["status_detail"] = f"正在扫描 {os.path.basename(root.rstrip('/\\\\'))}..."
                count, err = _scan_root(root, stop_event, tconn)
                total_count += count
                if err:
                    all_errors.append(f"{root}: {err}")
                if stop_event.is_set():
                    all_errors.append("扫描已取消")
                    break

            tconn.close()
            _INDEX_META["progress"] = 90
            _INDEX_META["status_detail"] = "正在统计文件大小..."

            nconn = _get_index_conn(_INDEX_DB_NEW)
            try:
                _INDEX_META["status_detail"] = "正在统计文件总数..."
                total_files = nconn.execute("SELECT COUNT(*) FROM index_files WHERE is_dir=0").fetchone()[0]
                total_dirs = nconn.execute("SELECT COUNT(*) FROM index_files WHERE is_dir=1").fetchone()[0]
                _INDEX_META["progress"] = 92
                _INDEX_META["status_detail"] = "正在计算大小统计..."
                total_size = nconn.execute("SELECT COALESCE(SUM(size), 0) FROM index_files WHERE is_dir=0").fetchone()[0]
                nconn.execute("INSERT OR REPLACE INTO index_meta VALUES ('total_files', ?)", (str(total_files),))
                nconn.execute("INSERT OR REPLACE INTO index_meta VALUES ('total_dirs', ?)", (str(total_dirs),))
                nconn.execute("INSERT OR REPLACE INTO index_meta VALUES ('total_size', ?)", (str(total_size),))
                nconn.execute("INSERT OR REPLACE INTO index_meta VALUES ('last_scan', ?)", (datetime.now().strftime("%Y-%m-%d %H:%M:%S"),))
                nconn.commit()

                _INDEX_META["progress"] = 95
                _INDEX_META["status_detail"] = "正在计算文件分布..."
                _compute_detail_stats(nconn)

                _INDEX_META["progress"] = 98
                _INDEX_META["status_detail"] = "正在更新索引..."
            finally:
                nconn.close()

            if total_files == 0 and not all_errors:
                _log.warning("索引扫描完成但无文件（可能是权限不足）")
            elif all_errors:
                _log.warning("索引扫描完成，共 %d 条错误: %s", len(all_errors), all_errors[0])

            if total_files > 0:
                try:
                    _DIR_SIZE_CACHE.clear()
                    if os.path.exists(_INDEX_DB_FILE):
                        os.remove(_INDEX_DB_FILE)
                    if os.path.exists(_INDEX_DB_FILE + ".wal"):
                        os.remove(_INDEX_DB_FILE + ".wal")
                    _INDEX_META["status_detail"] = "正在替换索引 DB..."
                    os.rename(_INDEX_DB_NEW, _INDEX_DB_FILE)
                    _log.info("索引构建完成，已替换主索引: %d 文件, %d 目录", total_files, total_dirs)
                except Exception as e:
                    _log.error("索引替换失败: %s", e)
                    try:
                        os.rename(_INDEX_DB_NEW, _INDEX_DB_FILE)
                    except Exception:
                        pass
                    _INDEX_META["status"] = "error"
                    _INDEX_META["status_detail"] = "索引替换失败"
                    return

                _INDEX_META["total_files"] = total_files
                _INDEX_META["total_dirs"] = total_dirs
                _INDEX_META["total_size"] = total_size
                _INDEX_META["status"] = "idle"
                _INDEX_META["progress"] = 100
                _INDEX_META["status_detail"] = "索引构建完成"
                _INDEX_META["last_scan"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                _invalidate_detail_cache()
            else:
                try:
                    if os.path.exists(_INDEX_DB_NEW):
                        os.remove(_INDEX_DB_NEW)
                except Exception:
                    pass
                _INDEX_META["status"] = "error"
                _INDEX_META["progress"] = 0
                _INDEX_META["status_detail"] = "扫描完成但无有效数据"

        except Exception as e:
            _log.error("索引扫描异常: %s", e)
            _INDEX_META["status"] = "error"
            _INDEX_META["progress"] = 0
            _INDEX_META["status_detail"] = f"扫描异常: {e}"
            try:
                if os.path.exists(_INDEX_DB_NEW):
                    os.remove(_INDEX_DB_NEW)
            except Exception:
                pass
        finally:
            _INDEX_BUILD_LOCK.release()

    t = threading.Thread(target=_worker, daemon=True)
    t.start()
    return {"status": "started"}

def _cancel_index_scan():
    """取消正在进行的扫描"""
    _SCAN_EVENT.set()


def _schedule_index_scan(interval_minutes=30):
    """后台扫描调度器：仅响应 SCAN_EVENT 信号（手动触发或 API 触发），不做自动定时扫描"""
    def _scheduler():
        if sys.platform.startswith("win"):
            roots = os.environ.get("SystemDrive", "C:") + "\\"
        else:
            roots = "/"
        while True:
            _SCAN_EVENT.wait(timeout=interval_minutes * 60)
            _SCAN_EVENT.clear()
            if _INDEX_META.get("status") == "scanning":
                continue
            try:
                _build_index(roots)
            except Exception:
                pass

    t = threading.Thread(target=_scheduler, daemon=True)
    t.start()
    return t


# 初始化索引数据库
_init_index_db()
# 检查是否已有持久化索引，有则加载，无则首次扫描
_index_loaded = _load_index_meta()
if _index_loaded:
    _log.info("已加载持久化索引: %d 文件, %d 目录, 上次扫描: %s", _INDEX_META["total_files"], _INDEX_META["total_dirs"], _INDEX_META["last_scan"])
    _INDEX_META["status"] = "idle"

# 启动后台扫描调度器（仅响应手动触发，不做自动定时扫描）
_scan_thread = _schedule_index_scan(30)

if not _index_loaded:
    _log.info("未找到已有索引，启动首次索引扫描...")
    def _delayed_first_scan():
        import time as _t
        _t.sleep(2)
        _build_index("")

    _thread_first = threading.Thread(target=_delayed_first_scan, daemon=True)
    _thread_first.start()


# ========== 全盘搜索 ==========
_SEARCH_RESULTS = {}  # token -> {"items":[...], "done":bool, "error":str|None, "count":int, "duration":float, "cancelled":bool}
_SEARCH_LOCK = threading.Lock()


def _search_walk(root, keyword, ext_filter, type_filter, timeout, stop_event, max_results):
    """在 root 下遍历，收集匹配项。stop_event 可中断，超时由调用方控制。"""
    items = []
    keyword_l = keyword.lower()
    ext_l = ext_filter.lower().lstrip(".") if ext_filter else ""
    # type_filter: "目录" / "文件" / ""
    try:
        for dirpath, dirnames, filenames in os.walk(root):
            if stop_event.is_set():
                return items, "search_cancelled"
            # 跳过不可访问子目录（避免走死循环或权限错误）
            dirnames[:] = [d for d in dirnames if not d.startswith(".")]
            # 匹配目录
            for d in list(dirnames):
                dp = os.path.join(dirpath, d)
                if type_filter != "文件":
                    if keyword_l in d.lower():
                        try:
                            info = get_file_info(dp, root)
                            if info:
                                info["abs_path"] = dp.replace("\\", "/")
                                items.append(info)
                        except Exception:
                            pass
            for f in filenames:
                if stop_event.is_set():
                    return items, "search_cancelled"
                fp = os.path.join(dirpath, f)
                if type_filter != "目录":
                    # 扩展名过滤
                    if ext_l:
                        fext = os.path.splitext(f)[1].lower().lstrip(".")
                        if fext != ext_l:
                            continue
                    # 关键字过滤
                    if keyword_l and keyword_l not in f.lower():
                        continue
                    try:
                        info = get_file_info(fp, root)
                        if info:
                            info["abs_path"] = fp.replace("\\", "/")
                            items.append(info)
                    except Exception:
                        pass
            if len(items) >= max_results:
                return items, "search_limit"
    except (OSError, PermissionError) as e:
        return items, f"error: {str(e)}"
    return items, "ok"


@app.route("/api/search")
def api_search():
    _log.info("GET /api/search keyword=%s", request.args.get("keyword", ""))
    """全盘搜索：优先使用索引，索引不可用时回退到文件系统遍历。"""
    root = request.args.get("root", "").strip()
    keyword = request.args.get("keyword", "").strip()
    ext_filter = request.args.get("ext", "").strip()
    type_filter = request.args.get("type", "").strip()  # "目录" / "文件"
    timeout = request.args.get("timeout", "60")
    use_index = request.args.get("use_index", "auto")  # auto / force / never

    if not keyword:
        return jsonify({"error": "搜索关键字不能为空"}), 400

    try:
        timeout = int(timeout)
        if timeout < 5 or timeout > 300:
            timeout = 60
    except (ValueError, TypeError):
        timeout = 60

    # 优先尝试索引
    if use_index != "never":
        meta = _get_index_meta()
        if meta["total_files"] > 0 and use_index in ("auto", "force"):
            t0 = time.monotonic()
            items = _query_index(keyword, ext_filter, type_filter, limit=5000)
            dur = round(time.monotonic() - t0, 2)
            return jsonify({
                "source": "index",
                "count": len(items),
                "duration": dur,
                "items": items,
                "done": True,
            })

    # 回退到文件系统遍历
    if not root:
        if sys.platform.startswith("win"):
            root = os.environ.get("SystemDrive", "C:") + "\\"
        else:
            root = "/"
    root = os.path.abspath(os.path.normpath(root))
    if not os.path.isdir(root):
        return jsonify({"error": f"搜索根目录不存在: {root}"}), 400

    import uuid
    token = uuid.uuid4().hex[:16]
    with _SEARCH_LOCK:
        _SEARCH_RESULTS[token] = {"items": [], "done": False, "error": None, "count": 0, "duration": 0, "cancelled": False}

    stop_event = threading.Event()
    def _run():
        try:
            t0 = time.monotonic()
            items, status = _search_walk(root, keyword, ext_filter, type_filter, timeout, stop_event, max_results=5000)
            dur = time.monotonic() - t0
            err = None
            if status == "error:":
                err = status
            elif status == "search_cancelled":
                err = None
            elif status == "search_limit":
                err = "已达到结果上限 (5000)"
            with _SEARCH_LOCK:
                _SEARCH_RESULTS[token]["items"] = items
                _SEARCH_RESULTS[token]["count"] = len(items)
                _SEARCH_RESULTS[token]["done"] = True
                _SEARCH_RESULTS[token]["error"] = err
                _SEARCH_RESULTS[token]["duration"] = dur
        except Exception as e:
            with _SEARCH_LOCK:
                _SEARCH_RESULTS[token]["done"] = True
                _SEARCH_RESULTS[token]["error"] = f"error: {str(e)}"

    t = threading.Thread(target=_run, args=(), daemon=True)
    t.start()
    return jsonify({"token": token, "source": "walk", "status": "running"})
@app.route("/api/search/<token>")
def api_search_status(token):
    _log.info("GET /api/search/%s", token)
    """返回搜索进度与结果"""
    with _SEARCH_LOCK:
        rec = _SEARCH_RESULTS.get(token)
    if rec is None:
        return jsonify({"error": "无效或已过期的搜索任务"}), 404
    return jsonify({
        "done": rec["done"],
        "count": rec["count"],
        "duration": rec["duration"],
        "error": rec.get("error"),
        "items": rec["items"],
    })


# ========== 索引管理 API ==========

# 进程内存缓存：详情统计数据，避免每次 API 调用都查 DB
_INDEX_DETAIL_MEMORY_CACHE = {}
_INDEX_DETAIL_CACHE_LOCK = threading.Lock()
_INDEX_DETAIL_CACHE_EXPIRY = 600  # 10 分钟过期


def _compute_detail_stats_in_memory():
    """实时计算索引详情统计，返回结果字典（不写入 DB）。用于内存缓存。"""
    result = {"top_dirs": [], "type_distribution": [], "top_files": []}
    # 虚拟文件系统前缀，统计时排除
    _VIRT_PREFIXES = "('/proc', '/sys', '/dev', '/run', '/snap', '/boot')"
    conn = _get_index_conn()
    try:
        top_dirs = conn.execute(
            f"""SELECT parent_dir, COUNT(*) as file_count, SUM(size) as dir_size
               FROM index_files WHERE is_dir=0 AND parent_dir != ''
               AND parent_dir NOT IN { _VIRT_PREFIXES }
               AND parent_dir NOT LIKE '/proc/%' AND parent_dir NOT LIKE '/sys/%'
               AND parent_dir NOT LIKE '/dev/%' AND parent_dir NOT LIKE '/run/%'
               GROUP BY parent_dir ORDER BY dir_size DESC LIMIT 15"""
        ).fetchall()
        result["top_dirs"] = [
            {"path": r[0], "name": r[0].rsplit('/', 1)[-1] or r[0], "file_count": r[1], "size": r[2]}
            for r in top_dirs
        ]

        type_rows = conn.execute(
            f"""SELECT COALESCE(ext, '(无后缀)'), COUNT(*) as cnt, SUM(size) as total_size
               FROM index_files WHERE is_dir=0
               AND abs_path NOT LIKE '/proc/%' AND abs_path NOT LIKE '/sys/%'
               AND abs_path NOT LIKE '/dev/%' AND abs_path NOT LIKE '/run/%'
               GROUP BY ext ORDER BY cnt DESC LIMIT 20"""
        ).fetchall()
        result["type_distribution"] = [
            {"ext": r[0], "count": r[1], "size": r[2]}
            for r in type_rows
        ]

        top_files = conn.execute(
            f"""SELECT name, ext, size, parent_dir
               FROM index_files WHERE is_dir=0
               AND abs_path NOT LIKE '/proc/%' AND abs_path NOT LIKE '/sys/%'
               AND abs_path NOT LIKE '/dev/%' AND abs_path NOT LIKE '/run/%'
               ORDER BY size DESC LIMIT 10"""
        ).fetchall()
        result["top_files"] = [
            {"name": r[0], "ext": r[1], "size": r[2], "parent": r[3]}
            for r in top_files
        ]
    except Exception as e:
        _log.error("实时计算索引详情失败: %s", e)
    finally:
        conn.close()
    return result


def _compute_detail_stats(conn):
    """预计算索引详情统计并写入 index_meta 表，供 API 快速读取"""
    # 虚拟文件系统过滤条件（排除旧索引中残留的 /proc 等数据）
    _VFILT = "AND abs_path NOT LIKE '/proc/%' AND abs_path NOT LIKE '/sys/%' AND abs_path NOT LIKE '/dev/%' AND abs_path NOT LIKE '/run/%'"
    try:
        top_dirs = conn.execute(
            f"""SELECT parent_dir, COUNT(*) as file_count, SUM(size) as dir_size
               FROM index_files WHERE is_dir=0 AND parent_dir != ''
               AND parent_dir NOT LIKE '/proc/%' AND parent_dir NOT LIKE '/sys/%'
               AND parent_dir NOT LIKE '/dev/%' AND parent_dir NOT LIKE '/run/%'
               GROUP BY parent_dir ORDER BY dir_size DESC LIMIT 15"""
        ).fetchall()
        top_dirs_data = [
            {"path": r[0], "name": r[0].rsplit('/', 1)[-1] or r[0], "file_count": r[1], "size": r[2]}
            for r in top_dirs
        ]

        type_rows = conn.execute(
            f"""SELECT COALESCE(ext, '(无后缀)'), COUNT(*) as cnt, SUM(size) as total_size
               FROM index_files WHERE is_dir=0 {_VFILT}
               GROUP BY ext ORDER BY cnt DESC LIMIT 20"""
        ).fetchall()
        type_dist_data = [
            {"ext": r[0], "count": r[1], "size": r[2]}
            for r in type_rows
        ]

        top_files = conn.execute(
            f"""SELECT name, ext, size, parent_dir
               FROM index_files WHERE is_dir=0 {_VFILT}
               ORDER BY size DESC LIMIT 10"""
        ).fetchall()
        top_files_data = [
            {"name": r[0], "ext": r[1], "size": r[2], "parent": r[3]}
            for r in top_files
        ]

        conn.execute("INSERT OR REPLACE INTO index_meta VALUES (?, ?)", ('top_dirs', json.dumps(top_dirs_data, ensure_ascii=False)))
        conn.execute("INSERT OR REPLACE INTO index_meta VALUES (?, ?)", ('type_distribution', json.dumps(type_dist_data, ensure_ascii=False)))
        conn.execute("INSERT OR REPLACE INTO index_meta VALUES (?, ?)", ('top_files', json.dumps(top_files_data, ensure_ascii=False)))
        conn.commit()
        _log.info("索引详情统计已更新")
        return True
    except Exception as e:
        _log.error("计算索引详情统计失败: %s", e)
        return False


def _load_detail_stats():
    """加载索引详情统计。优先读进程内存缓存，其次读 DB 预计算数据。"""
    now = time.time()

    # 1. 进程内存缓存
    with _INDEX_DETAIL_CACHE_LOCK:
        cached = _INDEX_DETAIL_MEMORY_CACHE.get("data")
        cached_time = _INDEX_DETAIL_MEMORY_CACHE.get("time", 0)
        if cached and (now - cached_time) < _INDEX_DETAIL_CACHE_EXPIRY:
            return cached

    # 2. DB 预计算数据（检查是否含旧的虚拟filesystem条目）
    result = {"top_dirs": [], "type_distribution": [], "top_files": []}
    conn = _get_index_conn()
    try:
        rows = conn.execute("SELECT key, value FROM index_meta").fetchall()
        meta = dict(rows)
        for key in ("top_dirs", "type_distribution", "top_files"):
            raw = meta.get(key)
            if raw:
                try:
                    result[key] = json.loads(raw)
                except (json.JSONDecodeError, TypeError):
                    result[key] = []
    finally:
        conn.close()

    # 3. 检查是否有旧的虚拟文件系统数据需要清理
    _HAS_OLD_VIRT_DATA = False
    for item in result.get("top_dirs", []):
        p = item.get("path", "")
        if p.startswith("/proc") or p.startswith("/sys") or p.startswith("/dev") or p.startswith("/run"):
            _HAS_OLD_VIRT_DATA = True
            break
    for item in result.get("top_files", []):
        p = item.get("parent", "")
        if p.startswith("/proc") or p.startswith("/sys") or p.startswith("/dev") or p.startswith("/run"):
            _HAS_OLD_VIRT_DATA = True
            break

    if not _HAS_OLD_VIRT_DATA and (result["top_dirs"] or result["type_distribution"] or result["top_files"]):
        with _INDEX_DETAIL_CACHE_LOCK:
            _INDEX_DETAIL_MEMORY_CACHE["data"] = result
            _INDEX_DETAIL_MEMORY_CACHE["time"] = now
        return result

    # 4. 缓存为空或含旧数据：用过滤后的查询重新计算
    if _HAS_OLD_VIRT_DATA:
        _log.info("检测到旧索引含虚拟文件系统数据，已自动过滤")

    result = _compute_detail_stats_in_memory()

    if result["top_dirs"] or result["type_distribution"] or result["top_files"]:
        with _INDEX_DETAIL_CACHE_LOCK:
            _INDEX_DETAIL_MEMORY_CACHE["data"] = result
            _INDEX_DETAIL_MEMORY_CACHE["time"] = now
        # 尝试持久化到 DB（只读文件系统会失败，忽略）
        try:
            conn = _get_index_conn()
            _compute_detail_stats(conn)
            conn.close()
        except Exception:
            pass

    return result


def _invalidate_detail_cache():
    """索引重建后清空详情缓存"""
    with _INDEX_DETAIL_CACHE_LOCK:
        _INDEX_DETAIL_MEMORY_CACHE.clear()


@app.route("/api/index/meta")
def api_index_meta():
    _log.info("GET /api/index/meta")
    """获取索引元信息"""
    return jsonify(_get_index_meta())


@app.route("/api/index/detail")
def api_index_detail():
    _log.info("GET /api/index/detail")
    """获取索引详细信息（多级缓存：进程内存 → DB预计算 → 实时计算）"""
    meta = _get_index_meta()
    detail = dict(meta)

    if meta.get("status") == "scanning":
        return jsonify(detail)

    cached = _load_detail_stats()
    detail["top_dirs"] = [dict(d, size_str=format_size(d["size"])) for d in cached.get("top_dirs", [])]
    detail["type_distribution"] = [dict(d, size_str=format_size(d["size"])) for d in cached.get("type_distribution", [])]
    detail["top_files"] = [dict(d, size_str=format_size(d["size"])) for d in cached.get("top_files", [])]

    return jsonify(detail)


@app.route("/api/index/build", methods=["POST"])
def api_index_build():
    _log.info("POST /api/index/build")
    """手动触发索引构建"""
    data = request.get_json(silent=True) or {}
    roots = data.get("roots", "").strip()
    result = _build_index(roots)
    return jsonify(result)


@app.route("/api/index/cancel", methods=["POST"])
def api_index_cancel():
    _log.info("POST /api/index/cancel")
    """取消索引扫描"""
    _cancel_index_scan()
    return jsonify({"success": True, "status": "cancelled"})


@app.route("/api/index/status")
def api_index_status():
    _log.info("GET /api/index/status")
    """获取索引扫描状态"""
    return jsonify({
        "status": _INDEX_META.get("status", "idle"),
        "progress": _INDEX_META.get("progress", 0),
        "status_detail": _INDEX_META.get("status_detail", ""),
        "total_files": _INDEX_META.get("total_files", 0),
    })


# ========== HTML 模板（修复版） ==========
HTML_TEMPLATE = r"""
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>文件管理可视化</title>
    <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>📁</text></svg>">
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.0/font/bootstrap-icons.css">
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/codemirror@5.65.16/lib/codemirror.min.css">
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/codemirror@5.65.16/theme/material-darker.min.css">
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/codemirror@5.65.16/addon/hint/show-hint.min.css">
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/simplemde@1.11.2/dist/simplemde.min.css">
    <script src="https://cdn.jsdelivr.net/npm/codemirror@5.65.16/lib/codemirror.min.js"></script>
    <style>
        :root { --bg-dark: #f8f9fc; }
        body { background-color: var(--bg-dark); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
        .navbar-brand { font-weight: 600; }
        .file-table { background: white; border-radius: 12px; box-shadow: 0 2px 12px rgba(0,0,0,0.06); overflow: hidden; }
        .file-table thead th { background: #f1f4f9; border-bottom: 2px solid #e2e8f0; font-weight: 600; color: #1a202c; cursor: pointer; user-select: none; position: sticky; top: 0; z-index: 10; }
        .file-table thead th:hover { background: #e8edf5; }
        .file-table tbody tr { transition: background 0.15s; }
        .file-table tbody tr:hover { background: #f7fafc; }
        .file-table tbody tr.selected { background: #ebf5ff; }
        .file-icon { font-size: 1.2rem; margin-right: 6px; }
        .dir-link { color: #2b6cb0; text-decoration: none; font-weight: 500; cursor: pointer; }
        .dir-link:hover { text-decoration: underline; }
        .file-name { font-weight: 500; }
        .file-size { font-family: "SF Mono", "Menlo", monospace; font-size: 0.9rem; color: #4a5568; }
        .file-type-badge { font-size: 0.75rem; padding: 2px 10px; border-radius: 20px; background: #edf2f7; color: #2d3748; font-weight: 500; }
        .file-type-badge.dir { background: #e6f0fa; color: #2b6cb0; }
        .stats-bar { background: white; border-radius: 12px; padding: 12px 20px; box-shadow: 0 1px 6px rgba(0,0,0,0.05); }
        .stats-bar .stat-item { margin-right: 24px; }
        .stats-bar .stat-label { color: #718096; font-size: 0.85rem; }
        .stats-bar .stat-value { font-weight: 600; color: #1a202c; font-size: 1rem; }
        .btn-delete { color: #e53e3e; border-color: #fed7d7; padding: 2px 10px; font-size: 0.8rem; border-radius: 20px; transition: all 0.2s; }
        .btn-delete:hover { background: #e53e3e; color: white; border-color: #e53e3e; }
        .btn-delete-sm { padding: 0 8px; font-size: 0.75rem; }
        .breadcrumb-item a { color: #2b6cb0; text-decoration: none; }
        .breadcrumb-item a:hover { text-decoration: underline; }
        .empty-state { padding: 60px 20px; text-align: center; color: #a0aec0; }
        .empty-state i { font-size: 3rem; margin-bottom: 16px; display: block; }
        .filter-input { max-width: 180px; }
        /* 加载态：整个表格变灰，等待光标，顶部显示进度条 */
        .fm-loading-bar { background: #f8fafc; }
        tbody.is-loading, tbody.is-loading td, tbody.is-loading a, tbody.is-loading span, tbody.is-loading input:not([type=checkbox]), tbody.is-loading button {
            cursor: wait !important;
            color: #64748b !important;
        }
        tbody.is-loading a:hover, tbody.is-loading .file-name-clickable:hover, tbody.is-loading .dir-link:hover {
            text-decoration: none !important;
            color: #64748b !important;
        }
        .table-container { max-height: calc(100vh - 280px); overflow-y: auto; }
        .table-container::-webkit-scrollbar { width: 6px; height: 6px; }
        .table-container::-webkit-scrollbar-track { background: #f1f1f1; border-radius: 4px; }
        .table-container::-webkit-scrollbar-thumb { background: #c1c9d6; border-radius: 4px; }
        .table-container::-webkit-scrollbar-thumb:hover { background: #a0aec0; }
        .path-input-group { max-width: 600px; flex: 1; }
        .toast-container { z-index: 9999; }
        .checkbox-col { width: 40px; }
        .action-col { width: 80px; }
        .sort-indicator { font-size: 0.7rem; margin-left: 4px; opacity: 0.5; }
        .sort-indicator.active { opacity: 1; color: #2b6cb0; }
        .quick-btn { white-space: nowrap; }
        /* 自定义弹窗 */
        .custom-toast { position: fixed; top: 24px; left: 50%; transform: translateX(-50%); z-index: 10000; padding: 14px 24px; border-radius: 12px; box-shadow: 0 8px 24px rgba(0,0,0,0.16); display: flex; align-items: center; gap: 12px; min-width: 280px; max-width: 480px; animation: toastSlide 0.3s ease; font-size: 0.9rem; }
        @keyframes toastSlide { from { opacity: 0; transform: translateX(-50%) translateY(-16px); } to { opacity: 1; transform: translateX(-50%) translateY(0); } }
        .custom-toast .toast-icon { font-size: 1.4rem; flex-shrink: 0; }
        .custom-toast.success { background: #16a34a; color: white; }
        .custom-toast.danger { background: #dc2626; color: white; }
        .custom-toast.warning { background: #f59e0b; color: white; }
        .custom-toast.info { background: #2563eb; color: white; }
        .custom-modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.4); z-index: 10001; display: flex; align-items: center; justify-content: center; animation: fadeIn 0.15s ease; }
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
        .custom-modal { background: white; border-radius: 16px; box-shadow: 0 20px 60px rgba(0,0,0,0.2); padding: 28px 32px; max-width: 420px; width: 90%; animation: modalPop 0.2s ease; }
        @keyframes modalPop { from { opacity: 0; transform: scale(0.9); } to { opacity: 1; transform: scale(1); } }
        .custom-modal .modal-title { font-size: 1.05rem; font-weight: 600; margin-bottom: 10px; display: flex; align-items: center; gap: 8px; }
        .custom-modal .modal-body { font-size: 0.9rem; color: #4a5568; line-height: 1.6; margin-bottom: 20px; }
        .custom-modal .modal-footer { display: flex; justify-content: flex-end; gap: 10px; }
        .custom-modal .modal-footer .btn { padding: 6px 18px; border-radius: 8px; font-size: 0.85rem; font-weight: 500; border: none; cursor: pointer; }
        .custom-modal .modal-footer .btn-cancel { background: #f1f5f9; color: #475569; }
        .custom-modal .modal-footer .btn-cancel:hover { background: #e2e8f0; }
        .custom-modal .modal-footer .btn-confirm { background: #dc2626; color: white; }
        .custom-modal .modal-footer .btn-confirm:hover { background: #b91c1c; }
        .custom-modal .modal-footer .btn-ok { background: #2563eb; color: white; }
        .custom-modal .modal-footer .btn-ok:hover { background: #1d4ed8; }
        @media (max-width: 768px) {
            .stats-bar .stat-item { margin-right: 12px; font-size: 0.85rem; }
            .filter-input { max-width: 120px; }
            .path-input-group { max-width: 100%; }
            .quick-btn { font-size: 0.8rem; padding: 0.25rem 0.5rem; }
        }
        /* 文件预览弹窗 */
        .preview-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 10002; display: flex; align-items: center; justify-content: center; animation: fadeIn 0.15s ease; padding: 20px; }
        .preview-modal { background: white; border-radius: 16px; box-shadow: 0 24px 80px rgba(0,0,0,0.25); width: 90vw; max-width: 900px; height: 85vh; display: flex; flex-direction: column; overflow: hidden; animation: modalPop 0.2s ease; }
        .preview-header { display: flex; flex-direction: column; align-items: stretch; justify-content: space-between; padding: 12px 20px; background: #f8fafc; border-bottom: 1px solid #e2e8f0; flex-shrink: 0; }
        .preview-header .preview-title { font-size: 0.9rem; font-weight: 600; color: #1a202c; display: flex; align-items: center; gap: 8px; overflow: hidden; }
        .preview-header .file-path { color: #718096; font-weight: 400; font-size: 0.75rem; font-family: monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .preview-header .preview-actions { display: flex; gap: 6px; }
        .preview-header .preview-actions .btn { padding: 4px 12px; border-radius: 6px; font-size: 0.78rem; border: none; cursor: pointer; }
        .preview-header .preview-actions .btn-copy { background: #f1f5f9; color: #475569; }
        .preview-header .preview-actions .btn-copy:hover { background: #e2e8f0; }
        .preview-header .preview-actions .btn-close-preview { background: #fee2e2; color: #dc2626; }
        .preview-header .preview-actions .btn-close-preview:hover { background: #fecaca; }
        .preview-body { flex: 1; overflow: auto; position: relative; }
        .preview-body.preview-text { padding: 20px; }
        .preview-body.preview-text pre { margin: 0; font-family: "SF Mono", "Menlo", "Consolas", monospace; font-size: 0.85rem; line-height: 1.6; white-space: pre-wrap; word-break: break-word; color: #1a202c; }
        .preview-body.preview-image { display: flex; align-items: center; justify-content: center; background: #f8fafc; }
        .preview-body.preview-image img { max-width: 100%; max-height: 100%; object-fit: contain; border-radius: 4px; }
        .preview-body.preview-video { display: flex; align-items: center; justify-content: center; background: #000; }
        .preview-body.preview-video video { max-width: 100%; max-height: 100%; object-fit: contain; }
        .preview-body.preview-loading { display: flex; align-items: center; justify-content: center; min-height: 200px; }
        .preview-body.preview-loading .spinner-border { color: #2563eb; }
        .preview-body.preview-error { display: flex; align-items: center; justify-content: center; padding: 40px; color: #dc2626; flex-direction: column; gap: 8px; }
        .preview-body.preview-error i { font-size: 2rem; }
        /* ========== 压缩包查看器 ========== */
        .zip-modal { background: white; border-radius: 16px; box-shadow: 0 24px 80px rgba(0,0,0,0.25); width: 92vw; max-width: 960px; height: 86vh; display: flex; flex-direction: column; overflow: hidden; animation: modalPop 0.2s ease; }
        .zip-header { display: flex; flex-direction: column; padding: 12px 20px; background: #f8fafc; border-bottom: 1px solid #e2e8f0; flex-shrink: 0; }
        .zip-header .zip-title-row { display: flex; align-items: center; justify-content: space-between; flex: 1; min-width: 0; }
        .zip-header .zip-title { font-size: 0.95rem; font-weight: 600; color: #1a202c; display: flex; align-items: center; gap: 8px; overflow: hidden; }
        .zip-header .zip-meta { color: #718096; font-size: 0.78rem; font-family: monospace; margin: 4px 0 0 26px; }
        .zip-header .zip-actions { display: flex; gap: 6px; align-items: center; }
        .zip-header .zip-actions .btn { padding: 4px 12px; border-radius: 6px; font-size: 0.78rem; border: none; cursor: pointer; }
        .zip-header .zip-actions .btn-extract { background: #059669; color: white; }
        .zip-header .zip-actions .btn-extract:hover { background: #047857; }
        .zip-header .zip-actions .btn-close-zip { background: #fee2e2; color: #dc2626; }
        .zip-header .zip-actions .btn-close-zip:hover { background: #fecaca; }
        .zip-toolbar { display: flex; align-items: center; gap: 10px; padding: 8px 20px; border-bottom: 1px solid #e2e8f0; background: #ffffff; flex-shrink: 0; }
        .zip-toolbar .breadcrumb-item { font-size: 0.78rem; color: #718096; }
        .zip-toolbar .breadcrumb-item a { color: #2563eb; text-decoration: none; cursor: pointer; }
        .zip-toolbar .breadcrumb-item.active { color: #1a202c; font-weight: 600; }
        .zip-toolbar .breadcrumb-sep { color: #cbd5e0; }
        .zip-body { flex: 1; overflow: auto; padding: 0; }
        .zip-table { width: 100%; border-collapse: collapse; }
        .zip-table thead th { background: #f1f4f9; font-size: 0.78rem; color: #4a5568; font-weight: 600; padding: 8px 12px; border-bottom: 1px solid #e2e8f0; position: sticky; top: 0; z-index: 2; text-align: left; }
        .zip-table .zip-sortable { cursor: pointer; user-select: none; transition: color 0.15s; }
        .zip-table .zip-sortable:hover { color: #2563eb; }
        .zip-table .zip-sortable.sort-asc { color: #2563eb; }
        .zip-table .zip-sortable.sort-desc { color: #2563eb; }
        .zip-table tbody tr { transition: background 0.12s; }
        .zip-table tbody tr:hover { background: #f7fafc; }
        .zip-table td { padding: 6px 12px; font-size: 0.83rem; border-bottom: 1px solid #f1f5f9; vertical-align: middle; }
        .zip-table .zip-name-cell { display: flex; align-items: center; gap: 6px; min-width: 0; }
        .zip-table .zip-name-cell .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; color: #1a202c; cursor: pointer; }
        .zip-table .zip-name-cell .name:hover { color: #2563eb; }
        .zip-table .zip-name-cell .name.dir-name { color: #2b6cb0; }
        .zip-table .zip-name-cell .name.dir-empty { color: #94a3b8; cursor: default; font-style: italic; }
        .zip-table .zip-name-cell .name.dir-empty::after { content: '（空）'; color: #94a3b8; font-size: 0.72rem; margin-left: 4px; }
        .zip-table .zip-name-cell .name.clickable-name { color: #1a202c; border-bottom: 1px dashed #cbd5e0; padding-bottom: 1px; }
        .zip-table .zip-name-cell .name.clickable-name:hover { color: #2563eb; border-bottom-color: #2563eb; }
        .zip-table .zip-size { font-family: monospace; color: #4a5568; font-size: 0.78rem; }
        .zip-table .zip-actions-cell { display: flex; gap: 4px; justify-content: flex-end; }
        .zip-table .zip-actions-cell .btn { padding: 2px 8px; font-size: 0.72rem; border-radius: 4px; border: none; cursor: pointer; }
        .zip-table .btn-zip-preview { background: #f1f5f9; color: #2563eb; }
        .zip-table .btn-zip-preview:hover { background: #e2e8f0; }
        .zip-table .btn-zip-download { background: #f0fdf4; color: #059669; }
        .zip-table .btn-zip-download:hover { background: #dcfce7; }
        .zip-table .btn-zip-open { background: #eff6ff; color: #2563eb; }
        .zip-table .btn-zip-open:hover { background: #dbeafe; }
        .zip-empty { display: flex; align-items: center; justify-content: center; height: 200px; color: #a0aec0; flex-direction: column; gap: 8px; }
        .zip-empty i { font-size: 2.5rem; }
        .zip-loading { display: flex; align-items: center; justify-content: center; height: 200px; color: #2563eb; flex-direction: column; gap: 8px; }
        .zip-error { display: flex; align-items: center; justify-content: center; height: 200px; color: #dc2626; flex-direction: column; gap: 8px; }
        /* 压缩文件输入弹窗 */
        .zip-name-input { width: 100%; padding: 8px 12px; border: 1px solid #e2e8f0; border-radius: 8px; font-size: 0.9rem; outline: none; }
        .zip-name-input:focus { border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37,99,235,0.15); }
        .zip-name-hint { font-size: 0.75rem; color: #718096; margin-top: 4px; }
        .file-name-clickable { cursor: pointer; }
        .file-name-clickable:hover { color: #2b6cb0; }
        /* 视图切换按钮 */
        .view-toggle-group { display: inline-flex; gap: 2px; background: #f1f5f9; border-radius: 8px; padding: 2px; }
        .view-toggle-group .btn-view { padding: 4px 10px; border-radius: 6px; font-size: 0.8rem; border: none; cursor: pointer; background: transparent; color: #64748b; display: flex; align-items: center; gap: 4px; }
        .view-toggle-group .btn-view:hover { background: white; color: #1a202c; }
        .view-toggle-group .btn-view.active { background: white; color: #2563eb; font-weight: 600; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
        .view-toggle-group .btn-view i { font-size: 0.85rem; }
        /* 列表视图（默认，已有） */
        .view-list { display: block; }
        .view-icon { display: none; }
        .view-tree { display: none; }
        /* 图标网格视图 */
        .icon-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(110px, 1fr)); gap: 8px; padding: 8px 0; }
        .icon-item { position: relative; padding: 14px 8px 10px; border-radius: 10px; background: white; border: 1px solid #e2e8f0; text-align: center; cursor: pointer; transition: all 0.15s; display: flex; flex-direction: column; align-items: center; gap: 6px; }
        .icon-item:hover { border-color: #2b6cb0; box-shadow: 0 2px 8px rgba(43,108,176,0.12); transform: translateY(-1px); }
        .icon-item.selected { border-color: #2b6cb0; background: #ebf5ff; box-shadow: 0 0 0 2px rgba(43,108,176,0.15); }
        .icon-item .icon-preview { font-size: 2.4rem; line-height: 1; margin-bottom: 4px; }
        .icon-item .icon-name { font-size: 0.78rem; font-weight: 500; color: #1a202c; display: -webkit-box; -webkit-line-clamp: 1; -webkit-box-orient: vertical; overflow: hidden; word-break: break-all; line-height: 1.3; }
        .icon-item .icon-meta { font-size: 0.7rem; color: #718096; display: flex; flex-direction: column; gap: 1px; }
        .icon-item .icon-meta .icon-size { font-family: "SF Mono", monospace; }
        .icon-item .icon-check { position: absolute; top: 6px; left: 6px; width: 16px; height: 16px; }
        .icon-item .icon-delete { position: absolute; top: 4px; right: 4px; width: 22px; height: 22px; border: none; background: #fee2e2; color: #dc2626; border-radius: 50%; font-size: 0.7rem; cursor: pointer; opacity: 0; transition: opacity 0.15s; display: flex; align-items: center; justify-content: center; }
        .icon-item:hover .icon-delete { opacity: 1; }
        .icon-item .icon-delete:hover { background: #dc2626; color: white; }
        .icon-item.clickable { cursor: pointer; }
        .icon-item.clickable .icon-name { color: #2b6cb0; }
        .icon-item.clickable:hover .icon-name { text-decoration: underline; }
        /* ========== 图标大小：小/中/大 ========== */
        .icon-grid.sm { grid-template-columns: repeat(auto-fill, minmax(110px, 1fr)); gap: 8px; }
        .icon-grid.md { grid-template-columns: repeat(auto-fill, minmax(145px, 1fr)); gap: 10px; }
        .icon-grid.lg { grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 12px; }
        .icon-item.sm { padding: 12px 8px 10px; gap: 6px; }
        .icon-item.sm .icon-thumb { width: 64px; height: 52px; }
        .icon-item.sm .icon-thumb .thumb-icon { font-size: 1.6rem; }
        .icon-item.sm .icon-name { font-size: 0.78rem; }
        .icon-item.sm .icon-meta { font-size: 0.68rem; }
        .icon-item.md { padding: 16px 10px 12px; gap: 8px; }
        .icon-item.md .icon-thumb { width: 88px; height: 72px; }
        .icon-item.md .icon-thumb .thumb-icon { font-size: 2rem; }
        .icon-item.md .icon-name { font-size: 0.88rem; }
        .icon-item.md .icon-meta { font-size: 0.75rem; }
        .icon-item.lg { padding: 20px 12px 16px; gap: 10px; }
        .icon-item.lg .icon-thumb { width: 116px; height: 92px; }
        .icon-item.lg .icon-thumb .thumb-icon { font-size: 2.5rem; }
        .icon-item.lg .icon-name { font-size: 1rem; font-weight: 600; }
        .icon-item.lg .icon-meta { font-size: 0.85rem; }
        .icon-item.lg .icon-check { width: 18px; height: 18px; }
        /* 图标大小切换按钮组（默认隐藏，仅图标视图显示） */
        .icon-size-group { display: none; align-items: center; gap: 2px; padding: 3px; border-radius: 8px; background: #f1f5f9; border: 1px solid #e2e8f0; }
        .icon-size-group.show-icon-size { display: inline-flex; }
        .icon-size-group .icon-size-btn { padding: 3px 8px; border-radius: 6px; font-size: 0.75rem; border: none; cursor: pointer; background: transparent; color: #64748b; display: flex; align-items: center; gap: 3px; transition: all 0.15s; }
        .icon-size-group .icon-size-btn:hover { background: white; color: #1a202c; }
        .icon-size-group .icon-size-btn.active { background: white; color: #2563eb; font-weight: 600; box-shadow: 0 1px 2px rgba(0,0,0,0.08); }
        .icon-size-group .icon-size-btn i { font-size: 0.85rem; }
        /* ========== 图标视图悬浮预览 ========== */
        .icon-hover-preview {
            position: fixed;
            z-index: 10000;
            max-width: 360px;
            background: #fff;
            border: 1px solid #e2e8f0;
            border-radius: 10px;
            box-shadow: 0 8px 24px rgba(0,0,0,0.18);
            padding: 8px;
            pointer-events: none;
            opacity: 0;
            transition: opacity 0.12s ease;
            display: flex;
            flex-direction: column;
            gap: 6px;
        }
        .icon-hover-preview.visible { opacity: 1; }
        .icon-hover-preview .ihp-img {
            width: 100%;
            max-width: 340px;
            max-height: 260px;
            object-fit: contain;
            border-radius: 6px;
            background: #000;
            display: block;
        }
        .icon-hover-preview .ihp-meta {
            padding: 4px 2px 0;
            display: flex;
            flex-direction: column;
            gap: 2px;
        }
        .icon-hover-preview .ihp-name {
            font-size: 0.8rem;
            font-weight: 600;
            color: #1a202c;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .icon-hover-preview .ihp-info {
            font-size: 0.7rem;
            color: #64748b;
            display: flex;
            gap: 8px;
            flex-wrap: wrap;
        }
        /* 选择模式：默认隐藏复选框，选择模式下才显示 */
        body:not(.select-mode) .item-checkbox,
        body:not(.select-mode) .icon-check,
        body:not(.select-mode) .tree-checkbox { display: none; }
        body:not(.select-mode) .checkbox-col { display: none; }
        body:not(.select-mode) .item-checkbox + td { padding-left: 8px; }
        /* 选择模式按钮 */
        .btn-select-mode { padding: 4px 10px; border-radius: 6px; font-size: 0.8rem; border: 1px solid #e2e8f0; cursor: pointer; background: white; color: #64748b; display: flex; align-items: center; gap: 4px; }
        .btn-select-mode:hover { background: #f1f5f9; color: #1a202c; }
        .btn-select-mode.active { background: #2563eb; color: white; border-color: #2563eb; }
        .btn-select-mode i { font-size: 0.85rem; }
        /* 图标缩略图 */
        .icon-thumb { width: 68px; height: 56px; border-radius: 6px; overflow: hidden; margin-bottom: 4px; display: flex; align-items: center; justify-content: center; background: #f1f5f9; position: relative; }
        .icon-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
        .icon-thumb .thumb-badge { position: absolute; bottom: 2px; right: 2px; background: rgba(0,0,0,0.75); color: white; font-size: 0.6rem; padding: 1px 4px; border-radius: 3px; font-weight: 600; }
        .icon-thumb .thumb-icon { font-size: 1.8rem; color: #94a3b8; }
        /* 更多操作按钮 */
        .more-btn { background: none; border: 1px solid #e2e8f0; color: #64748b; width: 24px; height: 24px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; cursor: pointer; font-size: 0.75rem; padding: 0; transition: all 0.15s; flex-shrink: 0; }
        .more-btn:hover { background: #f1f5f9; color: #1a202c; border-color: #cbd5e1; }
        .more-btn.active { background: #2563eb; color: white; border-color: #2563eb; }
        .icon-item .icon-more { position: absolute; top: 4px; right: 4px; width: 22px; height: 22px; opacity: 0; }
        .icon-item:hover .icon-more { opacity: 1; }
        .icon-item .icon-more { background: transparent; border: none; color: #94a3b8; font-size: 0.9rem; display: flex; align-items: center; justify-content: center; cursor: pointer; border-radius: 50%; padding: 0; }
        .icon-item .icon-more:hover { background: #f1f5f9; color: #1a202c; }
        .tree-line .tree-more { margin-left: 6px; width: 18px; height: 18px; opacity: 0; }
        .tree-line:hover .tree-more { opacity: 1; }
        .tree-line .tree-more { background: none; border: 1px solid #e2e8f0; color: #94a3b8; border-radius: 4px; font-size: 0.6rem; display: flex; align-items: center; justify-content: center; cursor: pointer; padding: 0; transition: all 0.15s; flex-shrink: 0; }
        .tree-line .tree-more:hover { background: #f1f5f9; color: #1a202c; border-color: #cbd5e1; }
        /* 操作菜单 */
        .action-menu { position: fixed; z-index: 10003; min-width: 180px; background: white; border-radius: 10px; box-shadow: 0 8px 30px rgba(0,0,0,0.15); border: 1px solid #e2e8f0; padding: 4px; display: none; animation: menuFade 0.15s ease; }
        @keyframes menuFade { from { opacity: 0; transform: scale(0.95); } to { opacity: 1; transform: scale(1); } }
        .action-menu .menu-item { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-radius: 6px; cursor: pointer; font-size: 0.85rem; color: #1a202c; border: none; background: none; width: 100%; text-align: left; transition: background 0.1s; }
        .action-menu .menu-item:hover { background: #f1f5f9; color: #2563eb; }
        .action-menu .menu-item.danger:hover { background: #fee2e2; color: #dc2626; }
        .action-menu .menu-item i { font-size: 1rem; width: 20px; text-align: center; color: #64748b; }
        .action-menu .menu-item.danger i { color: #dc2626; }
        .action-menu .menu-divider { height: 1px; background: #e2e8f0; margin: 4px 8px; }
        /* 文件信息面板 */
        .prop-panel { background: white; border-radius: 12px; box-shadow: 0 20px 60px rgba(0,0,0,0.2); width: 440px; max-height: 80vh; display: flex; flex-direction: column; overflow: hidden; }
        .prop-header { display: flex; align-items: center; justify-content: space-between; padding: 16px 20px; background: #f8fafc; border-bottom: 1px solid #e2e8f0; }
        .prop-header .prop-title { font-weight: 600; font-size: 0.95rem; display: flex; align-items: center; gap: 8px; }
        .prop-header .prop-close { background: none; border: none; font-size: 1.2rem; color: #94a3b8; cursor: pointer; padding: 4px 8px; border-radius: 6px; }
        .prop-header .prop-close:hover { background: #f1f5f9; color: #1a202c; }
        .prop-body { padding: 16px 20px; overflow-y: auto; }
        .prop-row { display: flex; padding: 8px 0; border-bottom: 1px solid #f1f5f9; }
        .prop-row:last-child { border-bottom: none; }
        .prop-label { width: 90px; font-size: 0.8rem; color: #718096; flex-shrink: 0; }
        .prop-value { flex: 1; font-size: 0.85rem; color: #1a202c; word-break: break-all; font-family: "SF Mono", "Menlo", monospace; }
        .prop-value.clickable { cursor: pointer; color: #2563eb; }
        .prop-value.clickable:hover { text-decoration: underline; }
        .prop-divider { height: 1px; background: #e2e8f0; margin: 8px 0; }
        .prop-value i { margin-right: 4px; font-size: 0.85rem; }
        /* 移动/复制到对话框 */
        .mv-modal { background: white; border-radius: 16px; box-shadow: 0 20px 60px rgba(0,0,0,0.2); width: 440px; padding: 24px 28px; animation: modalPop 0.2s ease; }
        .mv-modal .mv-title { font-size: 1.05rem; font-weight: 600; margin-bottom: 12px; display: flex; align-items: center; gap: 8px; }
        .mv-modal .mv-info { font-size: 0.82rem; color: #718096; padding: 10px 14px; background: #f8fafc; border-radius: 8px; margin-bottom: 14px; }
        .mv-modal .mv-info code { font-family: "SF Mono", "Menlo", monospace; color: #2563eb; font-size: 0.8rem; }
        .mv-modal .mv-path-input { display: flex; gap: 8px; margin-bottom: 14px; }
        .mv-modal .mv-path-input input { flex: 1; font-family: "SF Mono", "Menlo", monospace; font-size: 0.82rem; }
        .mv-modal .mv-path-input .btn { padding: 6px 14px; border-radius: 6px; font-size: 0.82rem; border: none; cursor: pointer; }
        .mv-modal .mv-path-input .btn-go { background: #2563eb; color: white; }
        .mv-modal .mv-path-input .btn-go:hover { background: #1d4ed8; }
        .mv-modal .mv-preview { font-size: 0.82rem; color: #4a5568; padding: 8px 12px; background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 6px; margin-bottom: 14px; word-break: break-all; }
        .mv-modal .mv-footer { display: flex; justify-content: flex-end; gap: 8px; }
        .mv-modal .mv-footer .btn { padding: 8px 20px; border-radius: 8px; font-size: 0.85rem; border: none; cursor: pointer; }
        .mv-modal .mv-footer .btn-cancel { background: #f1f5f9; color: #475569; }
        .mv-modal .mv-footer .btn-cancel:hover { background: #e2e8f0; }
        .mv-modal .mv-footer .btn-ok { background: #2563eb; color: white; }
        .mv-modal .mv-footer .btn-ok:hover { background: #1d4ed8; }
        /* 树型视图 */
        .tree-view { font-family: "SF Mono", "Menlo", monospace; font-size: 0.85rem; padding: 12px 16px; background: white; border-radius: 12px; box-shadow: 0 2px 12px rgba(0,0,0,0.06); }
        .tree-line { display: flex; align-items: center; gap: 4px; padding: 3px 0; border-radius: 4px; cursor: pointer; }
        .tree-line:hover { background: #f7fafc; }
        .tree-line.selected { background: #ebf5ff; }
        .tree-line .tree-toggle { width: 18px; height: 18px; display: flex; align-items: center; justify-content: center; font-size: 0.65rem; color: #94a3b8; flex-shrink: 0; user-select: none; }
        .tree-line .tree-toggle.expanded { transform: rotate(90deg); }
        .tree-line .tree-toggle.leaf { visibility: hidden; }
        .tree-line .tree-icon { font-size: 0.85rem; flex-shrink: 0; }
        .tree-line .tree-name { font-weight: 500; color: #1a202c; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .tree-line .tree-name.clickable { color: #2b6cb0; cursor: pointer; }
        .tree-line .tree-name.clickable:hover { text-decoration: underline; }
        .tree-line .tree-meta { margin-left: auto; font-size: 0.72rem; color: #94a3b8; flex-shrink: 0; font-family: "SF Mono", monospace; }
        .tree-line .tree-delete { margin-left: 8px; width: 20px; height: 20px; border: none; background: #fee2e2; color: #dc2626; border-radius: 50%; font-size: 0.65rem; cursor: pointer; opacity: 0; transition: opacity 0.15s; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
        .tree-line:hover .tree-delete { opacity: 1; }
        .tree-line .tree-delete:hover { background: #dc2626; color: white; }
        .tree-children { padding-left: 22px; border-left: 1px dashed #e2e8f0; margin-left: 9px; }
        .tree-children.collapsed { display: none; }
        .tree-line .tree-checkbox { width: 16px; height: 16px; margin-right: 4px; flex-shrink: 0; }
         /* 5秒回退 Toast */
        .undo-toast-container { position: fixed; bottom: 16px; right: 16px; z-index: 99999; display: flex; flex-direction: column-reverse; gap: 8px; max-width: 380px; }
        .undo-toast { background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; box-shadow: 0 8px 24px rgba(0,0,0,0.12); padding: 12px 16px; display: flex; align-items: center; gap: 10px; animation: slideInRight 0.25s ease; min-width: 280px; }
        .undo-toast .undo-icon { font-size: 1.4rem; flex-shrink: 0; }
        .undo-toast .undo-content { flex: 1; min-width: 0; }
        .undo-toast .undo-title { font-size: 0.85rem; font-weight: 600; color: #1a202c; display: flex; align-items: center; gap: 6px; }
        .undo-toast .undo-title .undo-countdown { font-family: "SF Mono", "Menlo", monospace; font-size: 0.75rem; background: #fee2e2; color: #dc2626; padding: 1px 7px; border-radius: 10px; font-weight: 700; }
        .undo-toast .undo-msg { font-size: 0.78rem; color: #718096; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .undo-toast .undo-btn { flex-shrink: 0; padding: 6px 14px; border-radius: 8px; font-size: 0.82rem; font-weight: 600; border: none; cursor: pointer; background: linear-gradient(135deg, #2563eb, #1d4ed8); color: white; box-shadow: 0 2px 6px rgba(37,99,235,0.3); transition: all 0.15s; display: flex; align-items: center; gap: 4px; }
        .undo-toast .undo-btn:hover { box-shadow: 0 4px 10px rgba(37,99,235,0.4); transform: translateY(-1px); }
        .undo-toast .undo-btn:disabled { background: #93c5fd; box-shadow: none; transform: none; cursor: not-allowed; }
        .undo-toast .undo-progress { position: absolute; bottom: 0; left: 0; height: 3px; background: linear-gradient(90deg, #2563eb, #1d4ed8); border-radius: 0 0 12px 12px; transition: width 0.1s linear; }
        .undo-toast { position: relative; overflow: hidden; }

        /* 删除历史面板 */
        .delhist-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.35); z-index: 9990; display: flex; justify-content: flex-end; animation: fadeIn 0.2s ease; }
        .delhist-panel { width: 420px; max-width: 90vw; height: 100vh; background: white; box-shadow: -8px 0 30px rgba(0,0,0,0.15); display: flex; flex-direction: column; animation: slideInRight 0.25s ease; overflow: hidden; }
        .delhist-panel .panel-header { display: flex; align-items: center; justify-content: space-between; padding: 14px 20px; background: linear-gradient(135deg, #7f1d1d, #dc2626); color: white; flex-shrink: 0; }
        .delhist-panel .panel-header .panel-title { font-size: 1rem; font-weight: 600; display: flex; align-items: center; gap: 8px; }
        .delhist-panel .panel-header .panel-close { background: rgba(255,255,255,0.15); border: 1px solid rgba(255,255,255,0.25); color: white; width: 30px; height: 30px; border-radius: 8px; cursor: pointer; font-size: 0.9rem; display: flex; align-items: center; justify-content: center; transition: all 0.15s; }
        .delhist-panel .panel-header .panel-close:hover { background: rgba(255,255,255,0.3); }
        .delhist-panel .panel-body { flex: 1; overflow-y: auto; padding: 12px 14px; }
        .delhist-panel .panel-body::-webkit-scrollbar { width: 5px; }
        .delhist-panel .panel-body::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 4px; }
        .delhist-panel .panel-footer { padding: 10px 14px; border-top: 1px solid #e2e8f0; background: #f8fafc; flex-shrink: 0; display: flex; gap: 8px; }
        .delhist-empty { text-align: center; padding: 40px 20px; color: #94a3b8; font-size: 0.85rem; }
        .delhist-empty i { font-size: 2.2rem; display: block; margin-bottom: 8px; }
        .delhist-item { display: flex; align-items: flex-start; gap: 10px; padding: 10px 12px; border: 1px solid #e2e8f0; border-radius: 10px; margin-bottom: 8px; background: #f8fafc; transition: all 0.15s; }
        .delhist-item:hover { background: #fff; border-color: #2563eb; box-shadow: 0 2px 8px rgba(37,99,235,0.08); }
        .delhist-item .dh-icon { font-size: 1.3rem; flex-shrink: 0; width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; background: #edf2f7; border-radius: 8px; }
        .delhist-item .dh-icon.dir { color: #d69e2e; background: #fefcbf; }
        .delhist-item .dh-info { flex: 1; min-width: 0; }
        .delhist-item .dh-name { font-size: 0.82rem; font-weight: 600; color: #1a202c; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .delhist-item .dh-path { font-size: 0.72rem; color: #718096; font-family: "SF Mono", "Menlo", monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-top: 2px; }
        .delhist-item .dh-meta { font-size: 0.7rem; color: #94a3b8; margin-top: 2px; display: flex; gap: 8px; align-items: center; }
        .delhist-item .dh-meta .dh-time { display: flex; align-items: center; gap: 3px; }
        .delhist-item .dh-meta .dh-size { display: flex; align-items: center; gap: 3px; }
        .delhist-item .dh-actions { flex-shrink: 0; display: flex; flex-direction: column; gap: 4px; }
        .delhist-item .dh-actions .btn { padding: 4px 10px; border-radius: 6px; font-size: 0.72rem; border: none; cursor: pointer; font-weight: 600; display: flex; align-items: center; gap: 3px; transition: all 0.12s; min-width: 60px; justify-content: center; }
        .delhist-item .dh-actions .btn-restore { background: #2563eb; color: white; }
        .delhist-item .dh-actions .btn-restore:hover { background: #1d4ed8; }
        .delhist-item .dh-actions .btn-remove { background: #fee2e2; color: #dc2626; border: 1px solid #fecaca; }
        .delhist-item .dh-actions .btn-remove:hover { background: #dc2626; color: white; }
        .delhist-item .dh-actions .btn:disabled { opacity: 0.4; cursor: not-allowed; }
        .delhist-item .dh-status { font-size: 0.7rem; color: #94a3b8; flex-shrink: 0; align-self: flex-start; padding-top: 2px; }
        .delhist-item .dh-status.lost { color: #dc2626; }
        .delhist-btn-clear { flex: 1; padding: 8px 16px; border-radius: 8px; font-size: 0.82rem; font-weight: 500; border: none; cursor: pointer; background: #fee2e2; color: #dc2626; border: 1px solid #fecaca; display: flex; align-items: center; gap: 5px; transition: all 0.15s; }
        .delhist-btn-clear:hover { background: #dc2626; color: white; }
        .delhist-btn-clear:disabled { background: #f1f5f9; color: #94a3b8; border-color: #e2e8f0; cursor: not-allowed; }
        .delhist-count-badge { position: absolute; top: -5px; right: -5px; background: #dc2626; color: white; font-size: 0.65rem; font-weight: 700; padding: 1px 6px; border-radius: 10px; min-width: 18px; text-align: center; }
        .delhist-count-badge.empty { display: none; }
        .trash-btn-wrap { position: relative; }
        /* 删除历史面板按钮 */

        .search-modal { background: white; border-radius: 18px; box-shadow: 0 24px 80px rgba(0,0,0,0.28); width: 1080px; max-width: 96vw; max-height: 90vh; display: flex; flex-direction: column; overflow: hidden; animation: modalPop 0.2s ease; }
        .search-header { display: flex; align-items: center; justify-content: space-between; padding: 16px 22px; background: linear-gradient(135deg, #1e3a5f 0%, #2563eb 100%); color: white; flex-shrink: 0; box-shadow: 0 2px 10px rgba(37,99,235,0.3); }
        .search-header .search-title { font-weight: 700; font-size: 1.05rem; display: flex; align-items: center; gap: 10px; letter-spacing: 0.3px; }
        .search-header .search-title i { font-size: 1.3rem; }
        .search-header .search-subtitle { font-size: 0.75rem; color: rgba(255,255,255,0.7); margin-left: 12px; }
        .search-header .search-close { background: rgba(255,255,255,0.12); border: 1px solid rgba(255,255,255,0.2); color: white; padding: 6px 14px; border-radius: 8px; cursor: pointer; font-size: 0.82rem; font-weight: 500; display: flex; align-items: center; gap: 5px; transition: all 0.2s; }
        .search-header .search-close:hover { background: rgba(255,255,255,0.25); border-color: rgba(255,255,255,0.4); }
        .search-body { padding: 16px 22px; background: #f8fafc; border-bottom: 1px solid #e2e8f0; flex-shrink: 0; }
        .search-params { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-bottom: 12px; }
        .search-params .label { font-size: 0.82rem; color: #4a5568; font-weight: 600; display: flex; align-items: center; gap: 4px; }
        .search-root-input { display: flex; gap: 6px; flex: 1; min-width: 260px; align-items: center; }
        .search-root-input input { font-family: "SF Mono", "Menlo", monospace; font-size: 0.83rem; padding: 6px 10px; border: 1px solid #cbd5e1; border-radius: 8px; transition: border-color 0.2s, box-shadow 0.2s; }
        .search-root-input input:focus { border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37,99,235,0.1); outline: none; }
        .search-root-input .btn { padding: 6px 14px; border-radius: 8px; font-size: 0.82rem; border: none; cursor: pointer; white-space: nowrap; font-weight: 500; display: flex; align-items: center; gap: 5px; transition: all 0.2s; }
        .search-root-input .btn-run { background: linear-gradient(135deg, #2563eb, #1d4ed8); color: white; box-shadow: 0 2px 6px rgba(37,99,235,0.3); }
        .search-root-input .btn-run:hover { box-shadow: 0 4px 12px rgba(37,99,235,0.4); transform: translateY(-1px); }
        .search-root-input .btn-run:disabled { background: #93c5fd; cursor: not-allowed; box-shadow: none; transform: none; }
        .search-root-input .btn-cancel { background: #fee2e2; color: #dc2626; border: 1px solid #fecaca; }
        .search-root-input .btn-cancel:hover { background: #fecaca; }
        .search-root-input .btn-cancel:disabled { background: #f8fafc; color: #cbd5e1; border-color: #e2e8f0; cursor: not-allowed; }
        .search-root-input .btn-clear { background: #f1f5f9; color: #475569; border: 1px solid #e2e8f0; padding: 6px 10px; }
        .search-root-input .btn-clear:hover { background: #e2e8f0; }
        .search-meta { display: flex; gap: 16px; align-items: center; flex-wrap: wrap; font-size: 0.82rem; color: #4a5568; padding: 8px 14px; background: #f0f4ff; border-radius: 8px; border: 1px solid #dbe4ff; }
        .search-meta .meta-item { display: inline-flex; align-items: center; gap: 5px; }
        .search-meta .meta-item strong { color: #1a202c; font-weight: 700; font-size: 0.9rem; }
        .search-meta .meta-loading { color: #2563eb; animation: pulse 1.4s infinite; font-weight: 600; }
        @keyframes pulse { 0%,100% { opacity: 0.5; } 50% { opacity: 1; } }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        .search-results { flex: 1; overflow: auto; min-height: 120px; background: white; padding: 0; }
        .search-empty { padding: 50px 20px; text-align: center; color: #a0aec0; display: flex; flex-direction: column; align-items: center; }
        .search-empty i { font-size: 2.5rem; margin-bottom: 12px; color: #cbd5e1; }
        .search-empty p { font-size: 0.9rem; }
        .search-results .search-table { width: 100%; border-collapse: collapse; }
        .search-results .search-table thead th { background: linear-gradient(135deg, #f8fafc, #f1f4f9); border-bottom: 2px solid #e2e8f0; font-weight: 700; color: #1a202c; position: sticky; top: 0; z-index: 10; font-size: 0.83rem; padding: 10px 14px; text-align: left; letter-spacing: 0.3px; text-transform: uppercase; }
        .search-results .search-table tbody td { padding: 10px 14px; font-size: 0.85rem; border-bottom: 1px solid #f1f5f9; vertical-align: middle; }
        .search-results .search-table tbody tr:hover { background: #f7fafc; box-shadow: inset 3px 0 0 #2563eb; }
        .search-results .search-name { font-weight: 600; color: #2b6cb0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 220px; display: inline-block; vertical-align: middle; font-size: 0.88rem; }
        .search-results .search-name i { margin-right: 4px; font-size: 1rem; }
        .search-results .search-path { font-family: "SF Mono", "Menlo", monospace; font-size: 0.78rem; color: #4a5568; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 200px; display: inline-block; }
        .search-results .search-size { font-family: "SF Mono", "Menlo", monospace; font-size: 0.82rem; color: #4a5568; white-space: nowrap; font-weight: 500; }
        .search-results .search-type-badge { font-size: 0.73rem; padding: 3px 12px; border-radius: 20px; background: #edf2f7; color: #2d3748; font-weight: 600; white-space: nowrap; letter-spacing: 0.3px; }
        .search-results .search-type-badge.dir { background: #e6f0fa; color: #2b6cb0; }
        .search-results .search-type-badge.text { background: #f0fdf4; color: #16a34a; }
        .search-results .search-type-badge.image { background: #fef3c7; color: #d97706; }
        .search-results .search-type-badge.video { background: #fce7f3; color: #db2777; }
        .search-results .search-when { font-size: 0.78rem; color: #718096; white-space: nowrap; }
        .search-results .search-open { padding: 4px 14px; border-radius: 6px; font-size: 0.78rem; border: 1px solid #bfdbfe; cursor: pointer; white-space: nowrap; background: #eff6ff; color: #2563eb; font-weight: 600; transition: all 0.15s; min-width: 56px; }
        .search-results .search-open:hover { background: #2563eb; color: white; border-color: #2563eb; box-shadow: 0 2px 4px rgba(37,99,235,0.3); }
        .search-results .search-preview { padding: 4px 14px; border-radius: 6px; font-size: 0.78rem; border: 1px solid #a7f3d0; cursor: pointer; white-space: nowrap; background: #f0fdf4; color: #16a34a; font-weight: 600; transition: all 0.15s; margin-left: 6px; min-width: 56px; }
        .search-results .search-preview:hover { background: #16a34a; color: white; border-color: #16a34a; box-shadow: 0 2px 4px rgba(22,163,74,0.3); }
        .search-progress { height: 3px; background: #e2e8f0; margin: 8px 22px 0; border-radius: 2px; overflow: hidden; display: none; }
        .search-progress.active { display: block; }
        .search-progress-bar { height: 100%; background: linear-gradient(90deg, #2563eb, #1d4ed8); border-radius: 2px; transition: width 0.3s; animation: search-progress-anim 1.5s ease infinite; width: 30%; }
        @keyframes search-progress-anim { 0% { margin-left: -30%; } 100% { margin-left: 100%; } }
        .search-batch { display: flex; align-items: center; justify-content: space-between; padding: 8px 22px; background: #f0fdf4; border-top: 1px solid #e2e8f0; border-bottom: 1px solid #e2e8f0; flex-shrink: 0; gap: 10px; }
        .search-batch .batch-left { display: flex; align-items: center; gap: 12px; font-size: 0.82rem; color: #4a5568; }
        .search-batch .batch-left .batch-count { font-weight: 700; color: #16a34a; font-size: 0.9rem; }
        .search-batch .batch-left .batch-note { color: #718096; font-size: 0.75rem; }
        .search-batch .batch-right { display: flex; gap: 8px; }
        .search-batch .batch-open { background: linear-gradient(135deg, #16a34a, #15803d); color: white; border: none; padding: 6px 14px; border-radius: 8px; font-size: 0.82rem; font-weight: 600; cursor: pointer; transition: all 0.2s; box-shadow: 0 2px 4px rgba(22,163,74,0.2); }
        .search-batch .batch-open:hover { box-shadow: 0 4px 8px rgba(22,163,74,0.3); transform: translateY(-1px); }
        .search-batch .batch-open:disabled { background: #94a3b8; box-shadow: none; transform: none; cursor: not-allowed; }
        .search-batch .batch-deselect { background: #f1f5f9; color: #475569; border: 1px solid #e2e8f0; padding: 6px 12px; border-radius: 8px; font-size: 0.8rem; cursor: pointer; transition: all 0.2s; }
        .search-batch .batch-deselect:hover { background: #e2e8f0; }
        .search-results .search-table tbody tr.selected { background: #eff6ff !important; box-shadow: inset 3px 0 0 #2563eb; }
        .search-results .search-checkbox { width: 16px; height: 16px; cursor: pointer; accent-color: #2563eb; }
        .search-results .search-table thead th.search-cb { width: 36px; padding-left: 20px; }
        .search-results .search-actions { display: flex; gap: 6px; align-items: center; white-space: nowrap; }
        /* 路径可点击 */
        .search-results .search-path { cursor: pointer; text-decoration: underline; text-decoration-color: rgba(37,99,235,0.2); text-underline-offset: 2px; }
        .search-results .search-path:hover { color: #2563eb; text-decoration-color: #2563eb; }
        .search-results .search-name { cursor: pointer; }
        .search-results .search-name:hover { color: #2563eb; }
        /* 收缩到右上角的浮动按钮 */
        .search-collapsed { position: fixed; top: 72px; right: 24px; z-index: 9999; width: 52px; height: 52px; border-radius: 50%; background: linear-gradient(135deg, #2563eb, #1d4ed8); color: white; display: flex; align-items: center; justify-content: center; cursor: pointer; box-shadow: 0 6px 20px rgba(37,99,235,0.4), 0 0 0 3px rgba(255,255,255,0.8); transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1); border: 2px solid white; }
        .search-collapsed:hover { transform: scale(1.12); box-shadow: 0 10px 30px rgba(37,99,235,0.5), 0 0 0 4px rgba(255,255,255,0.9); }
        .search-collapsed i { font-size: 1.3rem; }
        .search-collapsed .collapsed-badge { position: absolute; top: -6px; right: -6px; background: #dc2626; color: white; font-size: 0.68rem; font-weight: 700; padding: 2px 7px; border-radius: 10px; min-width: 22px; text-align: center; line-height: 1.2; box-shadow: 0 2px 4px rgba(220,38,38,0.3); }
        .search-collapsed .collapsed-badge.empty { display: none; }
        .search-collapsed-tip { position: fixed; top: 134px; right: 18px; z-index: 9998; background: #1e293b; color: #e2e8f0; font-size: 0.7rem; padding: 4px 10px; border-radius: 6px; white-space: nowrap; opacity: 0; transition: opacity 0.3s; pointer-events: none; }
        .search-collapsed:hover + .search-collapsed-tip, .search-collapsed-tip:hover { opacity: 1; }
        /* 索引详情面板 */
        .index-detail-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.35); z-index: 9990; display: flex; justify-content: flex-end; animation: fadeIn 0.2s ease; }
        .index-detail-panel { width: 460px; max-width: 90vw; height: 100vh; background: white; box-shadow: -8px 0 30px rgba(0,0,0,0.15); display: flex; flex-direction: column; animation: slideInRight 0.25s ease; overflow: hidden; }
        @keyframes slideInRight { from { transform: translateX(100%); } to { transform: translateX(0); } }
        .index-detail-panel .panel-header { display: flex; align-items: center; justify-content: space-between; padding: 14px 20px; background: linear-gradient(135deg, #1e3a5f, #2563eb); color: white; flex-shrink: 0; }
        .index-detail-panel .panel-header .panel-title { font-size: 1rem; font-weight: 600; display: flex; align-items: center; gap: 8px; }
        .index-detail-panel .panel-header .panel-close { background: rgba(255,255,255,0.15); border: 1px solid rgba(255,255,255,0.25); color: white; width: 30px; height: 30px; border-radius: 8px; cursor: pointer; font-size: 0.9rem; display: flex; align-items: center; justify-content: center; transition: all 0.15s; }
        .index-detail-panel .panel-header .panel-close:hover { background: rgba(255,255,255,0.3); }
        .index-detail-panel .panel-body { flex: 1; overflow-y: auto; padding: 16px 20px; }
        .index-detail-panel .panel-body::-webkit-scrollbar { width: 5px; }
        .index-detail-panel .panel-body::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 4px; }
        .index-detail-panel .panel-footer { padding: 12px 20px; border-top: 1px solid #e2e8f0; background: #f8fafc; flex-shrink: 0; display: flex; gap: 8px; justify-content: flex-end; }
        .idx-section { margin-bottom: 18px; }
        .idx-section:last-child { margin-bottom: 0; }
        .idx-section-title { font-size: 0.85rem; font-weight: 600; color: #1a202c; display: flex; align-items: center; gap: 6px; margin-bottom: 10px; padding-bottom: 6px; border-bottom: 1px solid #f1f5f9; }
        .idx-section-title i { font-size: 0.9rem; color: #2563eb; }
        .idx-stats-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 4px; }
        .idx-stat-card { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 10px 14px; }
        .idx-stat-card .stat-label { font-size: 0.72rem; color: #718096; font-weight: 500; margin-bottom: 2px; display: flex; align-items: center; gap: 4px; }
        .idx-stat-card .stat-value { font-size: 1.05rem; font-weight: 700; color: #1a202c; font-family: "SF Mono", "Menlo", monospace; }
        .idx-stat-card .stat-sub { font-size: 0.7rem; color: #94a3b8; margin-top: 1px; }
        .idx-stat-card.full-width { grid-column: 1 / -1; }
        .idx-stat-card.success { background: #f0fdf4; border-color: #bbf7d0; }
        .idx-stat-card.success .stat-value { color: #16a34a; }
        .idx-stat-card.info { background: #eff6ff; border-color: #bfdbfe; }
        .idx-stat-card.info .stat-value { color: #2563eb; }
        .idx-table { width: 100%; border-collapse: collapse; font-size: 0.78rem; }
        .idx-table th { text-align: left; padding: 5px 8px; background: #f1f5f9; color: #475569; font-weight: 600; font-size: 0.72rem; border-bottom: 1px solid #e2e8f0; white-space: nowrap; }
        .idx-table th.num { text-align: right; }
        .idx-table td { padding: 5px 8px; border-bottom: 1px solid #f8fafc; color: #1a202c; }
        .idx-table td.num { text-align: right; font-family: "SF Mono", "Menlo", monospace; font-size: 0.76rem; color: #4a5568; }
        .idx-table tr:hover td { background: #f7fafc; }
        .idx-table .path-cell { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #2563eb; cursor: pointer; }
        .idx-table .path-cell:hover { text-decoration: underline; }
        .idx-table .ext-badge { display: inline-block; min-width: 32px; padding: 1px 6px; border-radius: 4px; background: #edf2f7; color: #2d3748; font-size: 0.68rem; font-weight: 600; text-align: center; }
        .idx-progress-bar { width: 100%; height: 8px; background: #e2e8f0; border-radius: 4px; overflow: hidden; margin-top: 4px; }
        .idx-progress-bar .progress-fill { height: 100%; background: linear-gradient(90deg, #2563eb, #1d4ed8); border-radius: 4px; transition: width 0.4s ease; }
        .idx-empty { text-align: center; padding: 24px 8px; color: #94a3b8; font-size: 0.82rem; }
        .idx-empty i { font-size: 1.8rem; display: block; margin-bottom: 6px; }
        .idx-btn { padding: 6px 16px; border-radius: 8px; font-size: 0.82rem; font-weight: 500; border: none; cursor: pointer; display: inline-flex; align-items: center; gap: 5px; transition: all 0.15s; }
        .idx-btn-primary { background: linear-gradient(135deg, #2563eb, #1d4ed8); color: white; box-shadow: 0 2px 4px rgba(37,99,235,0.25); }
        .idx-btn-primary:hover { box-shadow: 0 4px 8px rgba(37,99,235,0.35); transform: translateY(-1px); }
        .idx-btn-primary:disabled { background: #93c5fd; box-shadow: none; transform: none; cursor: not-allowed; }
        .idx-btn-cancel { background: #fee2e2; color: #dc2626; border: 1px solid #fecaca; }
        .idx-btn-cancel:hover { background: #fecaca; }
        /* 新建按钮下拉 */
        .btn-create-new { font-size: 0.8rem; padding: 4px 12px; }
        .btn-create-new i { margin-right: 2px; }
        .btn-group .dropdown-item { font-size: 0.82rem; padding: 6px 14px; }
        .btn-group .dropdown-item i { margin-right: 6px; }
        /* 编辑器弹窗 */
        .editor-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.4); z-index: 9995; display: flex; align-items: center; justify-content: center; animation: fadeIn 0.2s ease; }
        .editor-modal { background: white; border-radius: 14px; box-shadow: 0 24px 80px rgba(0,0,0,0.28); width: 90vw; max-width: 1100px; height: 85vh; display: flex; flex-direction: column; overflow: hidden; animation: modalPop 0.2s ease; }
        .editor-header { display: flex; flex-direction: column; align-items: stretch; padding: 10px 18px; background: linear-gradient(135deg, #1e3a5f, #2563eb); color: white; flex-shrink: 0; }
        .editor-header .ed-title { font-size: 0.92rem; font-weight: 600; display: flex; align-items: center; justify-content: space-between; gap: 8px; overflow: hidden; }
        .editor-header .ed-title .ed-name-part { display: flex; align-items: center; gap: 8px; overflow: hidden; flex: 1; min-width: 0; }
        .editor-header .ed-title i { font-size: 1rem; flex-shrink: 0; }
        .editor-header .ed-title .ed-filename { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .editor-header .ed-path { font-size: 0.7rem; color: rgba(255,255,255,0.8); font-family: monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 4px 0 0 26px; display: block; }
        .editor-header .ed-actions { display: flex; gap: 6px; align-items: center; flex-shrink: 0; }
        .editor-header .ed-actions .btn { padding: 5px 12px; border-radius: 7px; font-size: 0.78rem; border: none; cursor: pointer; display: flex; align-items: center; gap: 4px; transition: all 0.15s; }
        .editor-header .ed-save-btn { background: #10b981; color: white; }
        .editor-header .ed-save-btn:hover { background: #059669; }
        .editor-header .ed-save-btn:disabled { background: #6ee7b7; cursor: not-allowed; }
        .editor-header .ed-close-btn { background: rgba(255,255,255,0.15); color: white; border: 1px solid rgba(255,255,255,0.25); }
        .editor-header .ed-close-btn:hover { background: rgba(255,255,255,0.3); }
        .editor-header .ed-status { font-size: 0.72rem; color: #fbbf24; font-style: italic; }
        /* SimpleMDE Markdown 编辑器样式 */
        .ed-md-wrapper { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
        .ed-md-wrapper .CodeMirror { flex: 1; height: 100%; min-height: 300px; }
        .ed-md-wrapper .editor-toolbar { flex-shrink: 0; }
        .ed-md-wrapper .editor-preview, .ed-md-wrapper .CodeMirror-cursor { color: #1a202c !important; }
        .ed-md-wrapper .editor-preview-side { border-left: 1px solid #e2e8f0; padding: 12px 16px; background: #fafbfc; font-size: 0.88rem; line-height: 1.6; }
        .ed-md-wrapper .editor-preview-side h1 { font-size: 1.4em; border-bottom: 2px solid #e2e8f0; padding-bottom: 6px; }
        .ed-md-wrapper .editor-preview-side h2 { font-size: 1.2em; border-bottom: 1px solid #e2e8f0; padding-bottom: 4px; }
        .ed-md-wrapper .editor-preview-side pre { background: #1e3a5f; color: #e2e8f0; padding: 12px; border-radius: 6px; overflow-x: auto; }
        .ed-md-wrapper .editor-preview-side code { font-family: "SF Mono","Menlo",monospace; font-size: 0.85em; }
        .ed-md-wrapper .editor-preview-side blockquote { border-left: 4px solid #2563eb; padding-left: 12px; color: #475569; margin-left: 0; }
        .ed-md-wrapper .editor-preview-side table { border-collapse: collapse; width: 100%; font-size: 0.85rem; }
        .ed-md-wrapper .editor-preview-side table th, .ed-md-wrapper .editor-preview-side table td { border: 1px solid #e2e8f0; padding: 6px 10px; text-align: left; }
        .ed-md-wrapper .editor-preview-side table th { background: #f1f5f9; font-weight: 600; }
        .ed-md-wrapper .editor-preview-side ul, .ed-md-wrapper .editor-preview-side ol { padding-left: 20px; }
        .ed-md-wrapper .editor-preview-side img { max-width: 100%; border-radius: 4px; }
        .ed-md-wrapper .editor-preview-side hr { border: none; border-top: 2px solid #e2e8f0; margin: 16px 0; }
        .editor-body { flex: 1; display: flex; overflow: hidden; min-height: 0; }
        .editor-panel { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
        .editor-panel-label { font-size: 0.72rem; font-weight: 600; color: #64748b; padding: 4px 12px; background: #f1f5f9; border-bottom: 1px solid #e2e8f0; display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
        .editor-split { display: flex; flex: 1; min-height: 0; }
        .editor-split .CodeMirror { flex: 1; min-width: 0; }
        .editor-split .cm-editor-pane { width: 50%; overflow: visible; border-right: 1px solid #e2e8f0; display: flex; flex-direction: column; }
        .editor-split .cm-preview-pane { width: 50%; overflow-y: auto; padding: 12px 16px; background: #fafbfc; display: flex; flex-direction: column; }
        .editor-split .cm-preview-pane .cm-rendered { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; font-size: 0.88rem; line-height: 1.6; color: #1a202c; word-break: break-word; }
        .editor-split .cm-preview-pane .cm-rendered h1, .editor-split .cm-preview-pane .cm-rendered h2, .editor-split .cm-preview-pane .cm-rendered h3 { margin-top: 1.2em; margin-bottom: 0.4em; font-weight: 600; }
        .editor-split .cm-preview-pane .cm-rendered h1 { font-size: 1.4em; border-bottom: 2px solid #e2e8f0; padding-bottom: 6px; }
        .editor-split .cm-preview-pane .cm-rendered h2 { font-size: 1.2em; border-bottom: 1px solid #e2e8f0; padding-bottom: 4px; }
        .editor-split .cm-preview-pane .cm-rendered h3 { font-size: 1.05em; }
        .editor-split .cm-preview-pane .cm-rendered p { margin: 0.5em 0; }
        .editor-split .cm-preview-pane .cm-rendered code { font-family: "SF Mono","Menlo",monospace; font-size: 0.82em; background: #f1f5f9; padding: 1px 5px; border-radius: 3px; color: #d63384; }
        .editor-split .cm-preview-pane .cm-rendered pre { background: #1e293b; color: #e2e8f0; padding: 10px 14px; border-radius: 8px; overflow-x: auto; margin: 0.8em 0; font-size: 0.8rem; line-height: 1.5; }
        .editor-split .cm-preview-pane .cm-rendered pre code { background: none; color: inherit; padding: 0; }
        .editor-split .cm-preview-pane .cm-rendered ul, .editor-split .cm-preview-pane .cm-rendered ol { padding-left: 20px; margin: 0.5em 0; }
        .editor-split .cm-preview-pane .cm-rendered li { margin: 0.2em 0; }
        .editor-split .cm-preview-pane .cm-rendered blockquote { border-left: 4px solid #2563eb; padding: 4px 12px; margin: 0.5em 0; background: #eff6ff; border-radius: 0 6px 6px 0; color: #475569; }
        .editor-split .cm-preview-pane .cm-rendered img { max-width: 100%; border-radius: 6px; margin: 0.5em 0; }
        .editor-split .cm-preview-pane .cm-rendered table { border-collapse: collapse; margin: 0.8em 0; font-size: 0.82rem; }
        .editor-split .cm-preview-pane .cm-rendered th, .editor-split .cm-preview-pane .cm-rendered td { border: 1px solid #e2e8f0; padding: 4px 10px; text-align: left; }
        .editor-split .cm-preview-pane .cm-rendered th { background: #f1f5f9; font-weight: 600; }
        .editor-split .cm-preview-pane .cm-rendered hr { border: none; border-top: 2px solid #e2e8f0; margin: 1.2em 0; }
        .editor-split .cm-preview-pane .cm-rendered a { color: #2563eb; text-decoration: none; }
        .editor-split .cm-preview-pane .cm-rendered a:hover { text-decoration: underline; }
        .editor-split .cm-preview-pane .cm-rendered strong { font-weight: 700; color: #0f172a; }
        .editor-split .cm-preview-pane .cm-rendered em { font-style: italic; color: #475569; }
        .editor-split .cm-preview-pane .cm-rendered .task-list-item { list-style: none; margin-left: -20px; }
        .editor-split .cm-preview-pane .cm-rendered .task-list-item input { margin-right: 4px; }
        .editor-full { width: 100%; }
        .editor-full .CodeMirror { height: 100%; }
        /* 编辑器查找替换面板 */
        .ed-search-panel { position: absolute; top: 0; left: 0; right: 0; z-index: 50; background: #1e293b; color: #e2e8f0; padding: 8px 14px; display: none; flex-direction: column; gap: 6px; box-shadow: 0 2px 8px rgba(0,0,0,0.3); border-bottom: 1px solid #334155; }
        .ed-search-panel.visible { display: flex; }
        .ed-search-row { display: flex; align-items: center; gap: 8px; }
        .ed-search-row .ed-search-label { font-size: 0.72rem; color: #94a3b8; width: 16px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
        .ed-search-row .ed-search-input { flex: 1; min-width: 0; padding: 4px 8px; border-radius: 5px; border: 1px solid #475569; background: #0f172a; color: #e2e8f0; font-size: 0.8rem; font-family: "SF Mono","Menlo",monospace; outline: none; }
        .ed-search-row .ed-search-input:focus { border-color: #2563eb; box-shadow: 0 0 0 2px rgba(37,99,235,0.3); }
        .ed-search-row .ed-search-input::placeholder { color: #64748b; }
        .ed-search-info { font-size: 0.7rem; color: #94a3b8; white-space: nowrap; min-width: 80px; text-align: right; }
        .ed-search-info.error { color: #f87171; }
        .ed-search-btn { padding: 3px 8px; border-radius: 4px; border: 1px solid #475569; background: #334155; color: #e2e8f0; font-size: 0.72rem; cursor: pointer; display: inline-flex; align-items: center; gap: 3px; transition: all 0.1s; white-space: nowrap; }
        .ed-search-btn:hover { background: #475569; border-color: #64748b; }
        .ed-search-btn.active { background: #2563eb; border-color: #2563eb; color: white; }
        .ed-search-btn.danger:hover { background: #991b1b; border-color: #dc2626; color: white; }
        .ed-search-btn i { font-size: 0.75rem; }
        .ed-search-checks { display: flex; align-items: center; gap: 12px; padding-left: 24px; }
        .ed-search-checks label { font-size: 0.72rem; color: #94a3b8; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; user-select: none; }
        .ed-search-checks input[type="checkbox"] { width: 13px; height: 13px; accent-color: #2563eb; cursor: pointer; }
        .cm-search-match { background: #3730a3; color: white; border-radius: 2px; }
        .cm-search-match-cursor { background: #f59e0b; color: black; border-radius: 2px; font-weight: 700; }
        .CodeMirror-cursor { border-left-color: #e2e8f0 !important; }
        .ed-shortcuts-tooltip { font-size: 0.68rem; color: #64748b; padding: 0 4px; }
        /* 编辑器面板容器调整 */
        .editor-panel, .cm-editor-pane, .cm-preview-pane { position: relative; }
    </style>
</head>
<body>
    <div class="toast-container position-fixed bottom-0 end-0 p-3"></div>
    <div id="customToastContainer"></div>
    <div id="customModalContainer"></div>
    <div id="previewContainer"></div>
    <div id="searchContainer"></div>
    <div id="indexDetailPanel"></div>
    <div id="deleteHistoryPanel"></div>
    <div id="undoToastContainer" class="undo-toast-container"></div>
    <div id="editorContainer"></div>
    <nav class="navbar navbar-expand-lg navbar-light bg-white shadow-sm sticky-top">
        <div class="container-fluid px-4">
            <span class="navbar-brand"><i class="bi bi-folder2-open text-primary"></i> 文件管理可视化</span>
            <div class="d-flex align-items-center gap-2">
                <span class="badge bg-light text-dark border" id="fileCountBadge">加载中...</span>
                <span class="badge bg-light text-dark border" id="indexBadge" title="点击重建索引"><i class="bi bi-database"></i> <span id="indexBadgeText">索引: --</span></span>
                <button class="btn btn-outline-secondary btn-sm trash-btn-wrap" id="deleteHistoryBtn" title="删除历史">
                    <i class="bi bi-clock-history"></i> 回收站
                    <span class="delhist-count-badge empty" id="delhistCountBadge">0</span>
                </button>
                <button class="btn btn-outline-secondary btn-sm" id="refreshBtn" title="刷新"><i class="bi bi-arrow-clockwise"></i></button>
                <button class="btn btn-outline-danger btn-sm" id="batchDeleteBtn" disabled title="删除选中"><i class="bi bi-trash3"></i> 删除选中</button>
                <button class="btn btn-outline-primary btn-sm" id="batchCompressBtn" disabled title="压缩选中"><i class="bi bi-file-zip"></i> 压缩选中</button>
            </div>
        </div>
    </nav>
    <div class="container-fluid px-4 py-3">
        <div class="row g-2 mb-3 align-items-center">
            <div class="col-md-7">
                <div class="d-flex flex-wrap gap-2 align-items-center">
                    <div class="input-group input-group-sm path-input-group">
                        <input type="text" class="form-control" id="pathInput" placeholder="输入绝对路径，如 C:/ 或 /home" />
                        <button class="btn btn-outline-primary" id="goPathBtn" type="button">进入</button>
                    </div>
                    <div class="d-flex gap-1">
                        <button class="btn btn-outline-secondary btn-sm quick-btn" id="homeBtn">🏠 主页</button>
                        <button class="btn btn-outline-secondary btn-sm quick-btn" id="systemRootBtn">💾 系统盘</button>
                    </div>
                    <div class="view-toggle-group" title="切换视图">
                        <button class="btn-view active" data-view="list" title="列表视图"><i class="bi bi-list-ul"></i></button>
                        <button class="btn-view" data-view="icon" title="图标视图"><i class="bi bi-grid-3x3-gap"></i></button>
                        <button class="btn-view" data-view="tree" title="树型视图"><i class="bi bi-diagram-3"></i></button>
                    </div>
                    <div class="icon-size-group" id="iconSizeGroup" title="图标大小（仅图标视图生效）">
                        <button class="icon-size-btn active" data-size="sm" title="小"><i class="bi bi-arrows-angle-contract"></i><span>小</span></button>
                        <button class="icon-size-btn" data-size="md" title="中"><i class="bi bi-arrows-fullscreen"></i><span>中</span></button>
                        <button class="icon-size-btn" data-size="lg" title="大"><i class="bi bi-arrows-angle-expand"></i><span>大</span></button>
                    </div>
                    <button class="btn-select-mode" id="selectModeBtn" title="选择模式"><i class="bi bi-check2-square"></i> 选择</button>
                    <div class="btn-group" title="新建">
                        <button class="btn btn-select-mode btn-create-new" id="createNewBtn" data-bs-toggle="dropdown" aria-expanded="false">
                            <i class="bi bi-plus-circle"></i> 新建
                        </button>
                        <ul class="dropdown-menu dropdown-menu-end" style="min-width:140px;">
                            <li><a class="dropdown-item" href="#" id="newFileMenuItem"><i class="bi bi-file-earmark-plus"></i> 文件</a></li>
                            <li><a class="dropdown-item" href="#" id="newFolderMenuItem"><i class="bi bi-folder-plus"></i> 文件夹</a></li>
                        </ul>
                    </div>
                    <button class="btn-select-mode" id="searchBtn" title="全盘搜索"><i class="bi bi-search"></i> 搜索</button>
                </div>
            </div>
            <div class="col-md-5 d-flex gap-2 flex-wrap justify-content-md-end">
                <input type="text" class="form-control form-control-sm filter-input" id="filterInput" placeholder="🔍 筛选文件名" />
                <select class="form-select form-select-sm" id="typeFilter" style="max-width:120px;">
                    <option value="">所有类型</option>
                    <option value="目录">📁 目录</option>
                </select>
            </div>
        </div>
        <div class="mb-2">
            <nav aria-label="breadcrumb">
                <ol class="breadcrumb mb-0" id="breadcrumb">
                    <li class="breadcrumb-item"><a href="#" data-path="loading">加载中...</a></li>
                </ol>
            </nav>
        </div>
        <div class="stats-bar mb-3 d-flex flex-wrap align-items-center">
            <span class="stat-item"><span class="stat-label">📄 文件</span><span class="stat-value" id="totalFiles">0</span></span>
            <span class="stat-item"><span class="stat-label">📁 目录</span><span class="stat-value" id="totalDirs">0</span></span>
            <span class="stat-item"><span class="stat-label">💾 总大小</span><span class="stat-value" id="totalSize">0</span></span>
            <button class="btn btn-outline-secondary btn-sm ms-auto" id="parentDirBtn" title="返回父文件夹" style="margin-right:8px;"><i class="bi bi-arrow-up"></i> 上级目录</button>
            <span class="stat-item text-muted small" id="currentPathDisplay">/</span>
        </div>
        <div class="file-table">
            <div class="table-container">
                <!-- 列表视图 -->
                <div class="view-list" id="viewList">
                    <table class="table table-hover mb-0" id="fileTable">
                        <thead>
                            <tr>
                                <th class="checkbox-col"><input class="form-check-input" type="checkbox" id="selectAll" title="全选" /></th>
                                <th data-sort="name" class="sortable">名称 <span class="sort-indicator" id="sort-name">⇅</span></th>
                                <th data-sort="size" class="sortable text-end" style="width:100px;">大小 <span class="sort-indicator" id="sort-size">⇅</span></th>
                                <th data-sort="type" class="sortable" style="width:100px;">类型 <span class="sort-indicator" id="sort-type">⇅</span></th>
                                <th data-sort="mtime" class="sortable" style="width:160px;">修改时间 <span class="sort-indicator" id="sort-mtime">⇅</span></th>
                                <th class="action-col text-center">操作</th>
                            </tr>
                        </thead>
                        <tbody id="fileBody">
                            <tr><td colspan="6"><div class="empty-state"><i class="bi bi-inbox"></i><p class="mb-0">加载中...</p></div></td></tr>
                        </tbody>
                    </table>
                </div>
                <!-- 图标视图 -->
                <div class="view-icon" id="viewIcon">
                    <div class="icon-grid" id="iconGrid"></div>
                </div>
                <!-- 树型视图 -->
                <div class="view-tree" id="viewTree">
                    <div class="tree-view" id="treeContainer"></div>
                </div>
            </div>
        </div>
        <div class="mt-2 text-muted small d-flex justify-content-between">
            <span>💡 点击表头排序 · 勾选文件后可「删除选中」/「压缩选中」</span>
            <span id="selectedCount">已选 0 个</span>
        </div>
    </div>

    <script>
    console.log('[TOP-LEVEL] Script block is being parsed');

    // ========== 全局状态 ==========
    let currentPath = '';
    let parentPath = '';  // 上级目录绝对路径，用于 ".." 行导航
    let fileItems = [];
    let selectedPaths = new Set();
    let sortField = 'name';
    let sortAsc = true;
    let viewMode = localStorage.getItem('fileManager_viewMode') || 'list';
    let selectMode = localStorage.getItem('fileManager_selectMode') === 'true';
    const STORAGE_KEY = 'fileManager_lastPath';
    const STORAGE_VIEW_KEY = 'fileManager_viewMode';
    // 缩略图缓存：path -> dataURL
    const _thumbnailCache = {};
    let systemInfo = { home: '', root: '' };

    // 调试面板：在页面右下角显示初始化状态
    // debug panel removed

    // 缩略图加载
    function _loadIconThumbnails(grid) {
        const thumbs = grid.querySelectorAll('.icon-thumb[data-thumb-path]');
        thumbs.forEach(thumbEl => {
            const path = thumbEl.dataset.thumbPath;
            // 如果缓存命中，立即渲染
            if (_thumbnailCache[path]) {
                _renderThumb(thumbEl, _thumbnailCache[path]);
                return;
            }
            // 并发限制：同时最多 4 个请求
            fetch(`/api/thumbnail?path=${encodeURIComponent(path)}`)
                .then(r => {
                    if (!r.ok) return null;
                    return r.blob();
                })
                .then(blob => {
                    if (!blob) return;
                    const reader = new FileReader();
                    reader.onloadend = () => {
                        _thumbnailCache[path] = reader.result;
                        _renderThumb(thumbEl, reader.result);
                    };
                    reader.readAsDataURL(blob);
                })
                .catch(() => {});
        });
    }

    function _renderThumb(thumbEl, dataUrl) {
        const icon = thumbEl.querySelector('.thumb-icon');
        if (icon) icon.innerHTML = `<img src="${dataUrl}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:6px;" />`;
    }

    // ========== 图标视图：悬浮预览（大图） ==========
    const _hoverPreview = document.createElement('div');
    _hoverPreview.className = 'icon-hover-preview';
    _hoverPreview.innerHTML = `
        <img class="ihp-img" alt="" />
        <div class="ihp-meta">
            <div class="ihp-name"></div>
            <div class="ihp-info"><span class="ihp-size"></span><span class="ihp-date"></span></div>
        </div>`;
    document.body.appendChild(_hoverPreview);
    let _hoverHideTimer = null;
    let _hoverHideDelay = 220; // ms

    function _showHoverPreview(card, path, name, sizeStr, mtime) {
        clearTimeout(_hoverHideTimer);
        // 若缩略图已缓存，立即显示
        const dataUrl = _thumbnailCache[path];
        const img = _hoverPreview.querySelector('.ihp-img');
        const nameEl = _hoverPreview.querySelector('.ihp-name');
        const sizeEl = _hoverPreview.querySelector('.ihp-size');
        const dateEl = _hoverPreview.querySelector('.ihp-date');
        if (dataUrl) {
            img.src = dataUrl;
        } else {
            // 请求缩略图并缓存
            fetch(`/api/thumbnail?path=${encodeURIComponent(path)}`)
                .then(r => r.ok ? r.blob() : null)
                .then(blob => {
                    if (!blob || _hoverPreview._path !== path) return;
                    const reader = new FileReader();
                    reader.onloadend = () => {
                        _thumbnailCache[path] = reader.result;
                        if (_hoverPreview._path === path) {
                            img.src = reader.result;
                        }
                    };
                    reader.readAsDataURL(blob);
                })
                .catch(() => {});
            img.src = '';
        }
        _hoverPreview._path = path;
        nameEl.textContent = name;
        sizeEl.textContent = sizeStr || '';
        dateEl.textContent = mtime || '';
        _positionHoverPreview(card);
        _hoverPreview.classList.add('visible');
    }

    function _hideHoverPreview() {
        _hoverHideTimer = setTimeout(() => {
            _hoverPreview.classList.remove('visible');
            _hoverPreview._path = null;
        }, _hoverHideDelay);
    }

    function _positionHoverPreview(card) {
        const rect = card.getBoundingClientRect();
        let top = rect.bottom + 8;
        let left = rect.left + rect.width / 2 - 180;
        if (left < 8) left = 8;
        if (left + 360 > window.innerWidth - 8) left = window.innerWidth - 368;
        if (top + 280 > window.innerHeight) {
            top = rect.top - 280;
            if (top < 8) top = rect.bottom + 8;
        }
        _hoverPreview.style.top = top + 'px';
        _hoverPreview.style.left = left + 'px';
    }

    // 页面滚动/缩放时隐藏悬浮预览
    window.addEventListener('scroll', () => {
        if (_hoverPreview.classList.contains('visible')) {
            _hoverPreview.classList.remove('visible');
            _hoverPreview._path = null;
        }
    }, { passive: true });

    // 当 icon-view 渲染时，为带缩略图的卡片绑定悬浮预览
    function _bindHoverPreviews(grid) {
        const cards = grid.querySelectorAll('.icon-item[data-thumb-abs-path]');
        cards.forEach(card => {
            const absPath = card.dataset.thumbAbsPath;
            const nameEl = card.querySelector('.icon-name');
            const sizeEl = card.querySelector('.icon-size');
            const name = nameEl ? nameEl.textContent : '';
            const sizeStr = sizeEl ? sizeEl.textContent : '';
            // mtime 从 fileItems 取
            const absNorm = absPath.replace(/\\/g, '/').replace(/\/+/g, '/');
            let mtime = '';
            for (const it of fileItems) {
                const p = currentPath ? (currentPath + '/' + it.path).replace(/\\/g,'/').replace(/\/+/g,'/') : it.path;
                if (p === absNorm) { mtime = it.mtime || ''; break; }
            }
            if (card._boundHover) return;
            card._boundHover = true;
            card.addEventListener('mouseenter', (e) => {
                _showHoverPreview(card, absPath, name, sizeStr, mtime);
            });
            card.addEventListener('mouseleave', () => {
                _hideHoverPreview();
            });
        });
    }

    // ========== 工具 ==========
    function formatSize(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
        return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
    }

    function getFileIcon(item) {
        if (item.is_dir) return '<i class="bi bi-folder-fill text-warning file-icon"></i>';
        const ext = item.ext || '';
        const icons = {
            'pdf': 'bi-filetype-pdf text-danger', 'jpg': 'bi-file-image text-success', 'jpeg': 'bi-file-image text-success',
            'png': 'bi-file-image text-success', 'gif': 'bi-file-image text-success', 'svg': 'bi-file-image text-success',
            'mp4': 'bi-file-play text-primary', 'avi': 'bi-file-play text-primary', 'mov': 'bi-file-play text-primary',
            'mkv': 'bi-file-play text-primary', 'mp4': 'bi-file-play text-primary', 'mp3': 'bi-file-music text-primary', 'wav': 'bi-file-music text-primary',
            'zip': 'bi-file-zip text-secondary', 'rar': 'bi-file-zip text-secondary', '7z': 'bi-file-zip text-secondary',
            'tar': 'bi-file-zip text-secondary', 'gz': 'bi-file-zip text-secondary', 'exe': 'bi-file-exe text-danger',
            'msi': 'bi-file-exe text-danger', 'dmg': 'bi-file-exe text-danger', 'py': 'bi-file-code text-info',
            'js': 'bi-file-code text-warning', 'html': 'bi-file-code text-danger', 'css': 'bi-file-code text-info',
            'json': 'bi-file-code text-secondary', 'xml': 'bi-file-code text-secondary', 'txt': 'bi-file-text text-secondary',
            'md': 'bi-file-text text-secondary', 'doc': 'bi-file-word text-primary', 'docx': 'bi-file-word text-primary',
            'xls': 'bi-file-excel text-success', 'xlsx': 'bi-file-excel text-success', 'ppt': 'bi-file-ppt text-danger',
            'pptx': 'bi-file-ppt text-danger'
        };
        const icon = icons[ext.toLowerCase()] || 'bi-file-earmark';
        return `<i class="bi ${icon} file-icon"></i>`;
    }

    function getTypeBadge(item) {
        if (item.is_dir) return `<span class="file-type-badge dir">📁 目录</span>`;
        return `<span class="file-type-badge">${item.type || '未知'}</span>`;
    }

    // ========== 压缩包查看器 ==========
    let _zipOuterPath = '';     // 外层 zip 绝对路径
    let _zipNestedEntry = '';   // 嵌套时的外层 entry（非空表示正在看嵌套 zip）
    let _currentZipEntry = '';  // 当前浏览的虚拟目录
    let _currentZipEntries = [];
    let _zipSortKey = 'default';  // 排序字段: 'default' | 'size' | 'type'
    let _zipSortDir = 1;          // 排序方向: 1 升序, -1 降序

    function _isZip(ext) {
        return ['zip','rar','7z','tar','gz','tgz','bz2','xz'].includes((ext || '').toLowerCase());
    }

    function _b64(s) { return btoa(unescape(encodeURIComponent(s))); }
    function _b64d(s) { return decodeURIComponent(escape(atob(s))); }

    function openZipViewer(absPath, startEntry, outerPath, nestedEntry) {
        const container = document.getElementById('previewContainer');
        _zipOuterPath = outerPath || '';
        _zipNestedEntry = nestedEntry || '';
        _currentZipPath = absPath;
        _currentZipEntry = startEntry || '';
        _zipSortKey = 'default';
        _zipSortDir = 1;
        const isNested = !!outerPath;
        const displayName = absPath.split('/').pop();
        const nestedHint = isNested ? `<span style="font-size:0.72rem;color:#718096;margin-left:6px;">· 嵌套在 <i class="bi bi-file-zip"></i> 内</span>` : '';
        container.innerHTML = `
            <div class="preview-overlay">
                <div class="zip-modal">
                    <div class="zip-header">
                        <div class="zip-title-row">
                            <div class="zip-title"><i class="bi bi-file-zip"></i><span id="zipTitleName">${_escHtml(displayName)}</span>${nestedHint}</div>
                            <div class="zip-actions">
                                <button class="btn btn-extract" id="zipExtractBtn"><i class="bi bi-unarchive"></i> 下载解压</button>
                                <button class="btn btn-close-zip" id="zipCloseBtn"><i class="bi bi-x-lg"></i></button>
                            </div>
                        </div>
                        <span class="zip-meta" id="zipMetaLine"></span>
                    </div>
                    <div class="zip-toolbar" id="zipBreadcrumb"></div>
                    <div class="zip-body" id="zipBody">
                        <div class="zip-loading"><div class="spinner-border" role="status"></div><span>正在加载压缩包内容…</span></div>
                    </div>
                </div>
            </div>
        `;
        container.querySelector('.preview-overlay').addEventListener('click', (e) => {
            if (e.target.classList.contains('preview-overlay')) closePreview();
        });
        document.getElementById('zipCloseBtn').addEventListener('click', closePreview);
        document.getElementById('zipExtractBtn').addEventListener('click', () => {
            if (isNested) {
                window.open(`/api/zip/file?zip_path=${encodeURIComponent(outerPath)}&entry=${encodeURIComponent(nestedEntry)}`, '_blank');
            } else {
                window.open(`/api/zip/extract?zip_path=${encodeURIComponent(absPath)}`, '_blank');
            }
        });
        document.addEventListener('keydown', function onZKey(e) {
            if (e.key === 'Escape') { closePreview(); document.removeEventListener('keydown', onZKey); }
        });
        _loadZipContents(absPath, startEntry || '');
    }

    function _loadZipContents(zipPath, entry) {
        const body = document.getElementById('zipBody');
        const meta = document.getElementById('zipMetaLine');
        if (body) body.innerHTML = '<div class="zip-loading"><div class="spinner-border" role="status"></div><span>正在加载…</span></div>';
        const cleanEntry = (entry || '').replace(/\/+$/, '');
        const url = (_zipOuterPath
            ? `/api/zip/nested?zip_path=${encodeURIComponent(_zipOuterPath)}&entry=${encodeURIComponent(_zipNestedEntry + (cleanEntry ? '/' + cleanEntry : ''))}`
            : `/api/zip/contents?path=${encodeURIComponent(zipPath)}${cleanEntry ? `&dir=${encodeURIComponent(cleanEntry)}` : ''}`);
        fetch(url)
            .then(r => r.json())
            .then(data => {
                if (data.error) {
                    if (body) body.innerHTML = `<div class="zip-error"><i class="bi bi-exclamation-circle"></i><span>${_escHtml(data.error)}</span></div>`;
                    return;
                }
                _currentZipEntries = data.entries || [];
                meta.innerHTML = `${data.zip_size_str} · ${data.entry_count} 项 · 原始 ${data.total_uncompressed_str}`;
                _renderZipList(data.entries, cleanEntry);
            })
            .catch(err => {
                if (body) body.innerHTML = `<div class="zip-error"><i class="bi bi-exclamation-circle"></i><span>加载失败: ${err.message}</span></div>`;
            });
    }

    function _renderZipList(entries, currentEntry) {
        const body = document.getElementById('zipBody');
        if (!body) return;
        if (!entries || entries.length === 0) {
            body.innerHTML = '<div class="zip-empty"><i class="bi bi-inbox"></i><span>压缩包内无文件</span></div>';
            _renderZipBreadcrumb('');
            return;
        }
        // 后端已经按 dir 参数过滤，直接使用返回的 entries（名称已是相对当前目录的）
        let visible = entries;
        // 应用排序
        const sortKey = _zipSortKey || 'default';
        const sortDir = _zipSortDir || 1;
        const sorted = [...visible];
        if (sortKey === 'size') {
            sorted.sort((a, b) => sortDir * ((a.size || 0) - (b.size || 0)));
        } else if (sortKey === 'type') {
            sorted.sort((a, b) => {
                const ta = (a.ext || (a.is_dir ? '' : 'zzz')).toLowerCase();
                const tb = (b.ext || (b.is_dir ? '' : 'zzz')).toLowerCase();
                const da = a.is_dir ? 0 : 1;
                const db = b.is_dir ? 0 : 1;
                if (da !== db) return sortDir * (da - db);
                return sortDir * ta.localeCompare(tb);
            });
        } else {
            sorted.sort((a, b) => {
                if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
                return a.name.localeCompare(b.name);
            });
        }

        const sortHeader = (field, label) => {
            const cls = sortKey === field ? (sortDir === 1 ? 'sort-asc' : 'sort-desc') : '';
            const arrow = sortKey === field ? (sortDir === 1 ? ' ↑' : ' ↓') : '';
            return `<th class="zip-sortable ${cls}" data-sort="${field}">${label}${arrow}</th>`;
        };

        let html = `<table class="zip-table"><thead><tr>
            <th style="width:60px;">类型</th>
            <th>名称</th>
            ${sortHeader('size', '大小')}
            <th style="width:130px;">压缩后</th>
            ${sortHeader('type', '类型')}
            <th style="width:200px;">操作</th>
        </tr></thead><tbody>`;
        if (currentEntry) {
            const parentEntry = currentEntry.substring(0, currentEntry.lastIndexOf('/')) || '';
            html += `<tr data-is-dir="true">
                <td><i class="bi bi-folder2-open"></i></td>
                <td class="zip-name-cell"><i class="bi bi-arrow-90deg-up"></i><span class="name dir-name" data-zip-entry="${_escAttr(parentEntry)}">..</span></td>
                <td class="zip-size">-</td>
                <td class="zip-size">-</td>
                <td class="zip-size">-</td>
                <td class="zip-actions-cell"><button class="btn btn-zip-open" data-zip-entry="${_escAttr(parentEntry)}"><i class="bi bi-folder2-open"></i> 进入</button></td>
            </tr>`;
        }
        for (const e of visible) {
            const isDir = !!e.is_dir;
            const icon = isDir ? '<i class="bi bi-folder-fill text-warning"></i>' : `<i class="${e.icon || 'bi bi-file-earmark'}"></i>`;
            const sizeStr = e.size != null ? _humanSize(e.size) : '-';
            const compStr = e.compressed != null ? _humanSize(e.compressed) : '-';
            // 显示名是相对于当前目录的，拼接为完整相对路径
            const fullEntry = currentEntry ? (currentEntry + '/' + e.name) : e.name;
            const entryEsc = _escAttr(fullEntry);
            const nameEsc = _escHtml(e.name);
            const ext = (e.ext || '').toLowerCase();
            const isZipEntry = _isZip(ext);
            // 预览按钮：仅对可预览的文件显示
            const canPreview = _canPreview(ext);
            // 空文件夹不显示「进入」按钮
            const isEmptyDir = isDir && e.is_empty === true;
            // 类型显示
            const typeText = isDir ? '文件夹' : (ext ? ext.toUpperCase() : '未知');

            html += `<tr data-zip-entry="${entryEsc}" data-is-dir="${isDir}" data-is-empty="${isEmptyDir}">
                <td>${icon}</td>
                <td class="zip-name-cell"><span class="name ${isDir ? (isEmptyDir ? 'dir-name dir-empty' : 'dir-name') : (canPreview ? 'clickable-name' : '')}" data-zip-entry="${entryEsc}" data-ext="${ext}">${nameEsc}</span></td>
                <td class="zip-size">${sizeStr}</td>
                <td class="zip-size">${compStr}</td>
                <td><span class="file-type-badge">${typeText}</span></td>
                <td class="zip-actions-cell">
                    ${isDir ? (isEmptyDir ? '' : `<button class="btn btn-zip-open" data-zip-entry="${entryEsc}"><i class="bi bi-folder2-open"></i> 进入</button>`) :
                      (isZipEntry ?
                        `<button class="btn btn-zip-open" data-zip-entry="${entryEsc}"><i class="bi bi-box-arrow-in-right"></i> 打开</button>
                         <button class="btn btn-zip-download" data-zip-entry="${entryEsc}"><i class="bi bi-download"></i> 下载</button>` :
                        (canPreview ?
                          `<button class="btn btn-zip-preview" data-zip-entry="${entryEsc}"><i class="bi bi-eye"></i> 预览</button>
                           <button class="btn btn-zip-download" data-zip-entry="${entryEsc}"><i class="bi bi-download"></i> 下载</button>` :
                          `<button class="btn btn-zip-download" data-zip-entry="${entryEsc}"><i class="bi bi-download"></i> 下载</button>`
                        )
                      )}
                </td>
            </tr>`;
        }
        html += '</tbody></table>';
        body.innerHTML = html;

        // 排序头点击 —— 直接读全局变量（不用闭包捕获的局部 sortKey），防止闭包状态不一致
        body.querySelectorAll('.zip-sortable').forEach(th => {
            th.addEventListener('click', () => {
                const field = th.dataset.sort;
                if (_zipSortKey === field) {
                    _zipSortDir = -_zipSortDir;
                } else {
                    _zipSortKey = field;
                    _zipSortDir = 1;
                }
                _renderZipList(visible, currentEntry);
            });
        });

        body.querySelectorAll('[data-zip-entry]').forEach(el => {
            const entry = el.dataset.zipEntry;
            const targetRow = el.closest('tr');
            const isDir = targetRow && targetRow.dataset.isDir === 'true';
            const isEmpty = targetRow && targetRow.dataset.isEmpty === 'true';
            el.addEventListener('click', (e) => { e.stopPropagation();
                if (isDir) {
                    if (isEmpty) return;  // 空文件夹：禁止点击
                    _navigateZipEntry(entry);
                    return;
                }
                // 可预览文件：点击文件名也可打开预览
                const ext = el.dataset.ext || '';
                if (_canPreview(ext)) { _previewZipEntry(entry); }
            });
        });
        body.querySelectorAll('.btn-zip-open').forEach(btn => {
            btn.addEventListener('click', (e) => { e.stopPropagation(); _navigateZipEntry(btn.dataset.zipEntry); });
        });
        body.querySelectorAll('.btn-zip-preview').forEach(btn => {
            btn.addEventListener('click', (e) => { e.stopPropagation(); _previewZipEntry(btn.dataset.zipEntry); });
        });
        body.querySelectorAll('.btn-zip-download').forEach(btn => {
            btn.addEventListener('click', (e) => { e.stopPropagation(); _downloadZipEntry(btn.dataset.zipEntry); });
        });
        _renderZipBreadcrumb(currentEntry);
    }

    function _navigateZipEntry(entry) {
        const cleanEntry = entry.replace(/\/+$/, '');
        if (_isZip((entry.split('.').pop() || '').toLowerCase())) {
            openZipViewer(cleanEntry, '', _zipOuterPath ? (_zipNestedEntry ? _zipNestedEntry + '/' + cleanEntry : cleanEntry) : _currentZipPath, _zipOuterPath ? '' : cleanEntry);
            return;
        }
        _currentZipEntry = cleanEntry;
        _loadZipContents(_currentZipPath, cleanEntry);
    }

    function _previewZipEntry(entry) {
        const cleanEntry = entry.replace(/\/+$/, '');
        const fullEntry = _zipNestedEntry ? (_zipNestedEntry + '/' + cleanEntry) : cleanEntry;
        const url = _zipOuterPath
            ? `/api/zip/nested/preview?zip_path=${encodeURIComponent(_zipOuterPath)}&entry=${encodeURIComponent(fullEntry)}`
            : `/api/zip/preview?zip_path=${encodeURIComponent(_currentZipPath)}&entry=${encodeURIComponent(cleanEntry)}`;
        fetch(url)
            .then(r => r.json())
            .then(data => {
                if (data.error) { showToast('错误', data.error, 'danger'); return; }
                const ext = (data.ext || '').toLowerCase();
                if (_TEXT_EXTS.has(ext)) {
                    const bytes = Uint8Array.from(atob(data.content), c => c.charCodeAt(0));
                    const decoded = new TextDecoder('utf-8').decode(bytes);
                    _showInlineZipPreview(entry, `<pre>${_escapeHtml(decoded)}</pre>`, data.size_str);
                } else if (_IMAGE_EXTS.has(ext)) {
                    _showInlineZipPreview(entry, `<img src="data:${data.content_type || 'image/png'};base64,${data.content}" style="max-width:100%;max-height:60vh;object-fit:contain;border-radius:6px;" />`, data.size_str);
                } else if (_VIDEO_EXTS.has(ext)) {
                    showToast('提示', '压缩包内视频文件请通过「下载」保存后再播放', 'info');
                } else {
                    _downloadZipEntry(entry);
                    showToast('提示', '该类型不支持在线预览，已触发下载', 'info');
                }
            })
            .catch(err => { showToast('错误', err.message, 'danger'); });
    }

    function _showInlineZipPreview(entry, inner, sizeStr) {
        const body = document.getElementById('zipBody');
        if (!body) return;
        const name = entry.split('/').pop();
        body.innerHTML = `
            <div style="padding:16px;">
                <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
                    <div style="display:flex;align-items:center;gap:8px;flex:1;min-width:0;">
                        <button class="btn" style="background:#f1f5f9;color:#475569;padding:4px 10px;border-radius:6px;border:none;cursor:pointer;font-size:0.78rem;" id="zipBackBtn"><i class="bi bi-arrow-left"></i> 返回列表</button>
                        <span style="font-weight:600;color:#1a202c;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${_escHtml(name)}</span>
                        <span style="font-size:0.72rem;color:#718096;">${sizeStr || ''}</span>
                    </div>
                    <button class="btn" style="background:#f0fdf4;color:#059669;padding:4px 10px;border-radius:6px;border:none;cursor:pointer;font-size:0.78rem;" data-zip-entry="${_escAttr(entry)}"><i class="bi bi-download"></i> 下载</button>
                </div>
                <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:12px;overflow:auto;max-height:calc(86vh - 210px);">
                    ${inner}
                </div>
            </div>`;
        body.querySelector('#zipBackBtn').addEventListener('click', () => _renderZipList(_currentZipEntries, _currentZipEntry));
        body.querySelector('[data-zip-entry]').addEventListener('click', (e) => { e.stopPropagation(); _downloadZipEntry(entry); });
    }

    function _downloadZipEntry(entry) {
        const cleanEntry = entry.replace(/\/+$/, '');
        const fullEntry = _zipNestedEntry ? (_zipNestedEntry + '/' + cleanEntry) : cleanEntry;
        const url = _zipOuterPath
            ? `/api/zip/nested/file?zip_path=${encodeURIComponent(_zipOuterPath)}&entry=${encodeURIComponent(fullEntry)}`
            : `/api/zip/file?zip_path=${encodeURIComponent(_currentZipPath)}&entry=${encodeURIComponent(cleanEntry)}`;
        window.open(url, '_blank');
    }

    function _renderZipBreadcrumb(entry) {
        const bc = document.getElementById('zipBreadcrumb');
        if (!bc) return;
        let parts = [];
        if (entry) parts = entry.split('/').filter(Boolean);
        let html = `<span class="breadcrumb-item"><i class="bi bi-file-zip"></i> <a data-zip-bc="">压缩包</a></span>`;
        let cumulative = '';
        for (let i = 0; i < parts.length; i++) {
            cumulative += (cumulative ? '/' : '') + parts[i];
            const isLast = i === parts.length - 1;
            if (isLast) html += `<span class="breadcrumb-sep">/</span><span class="breadcrumb-item active">${_escHtml(parts[i])}</span>`;
            else html += `<span class="breadcrumb-sep">/</span><span class="breadcrumb-item"><a data-zip-bc="${_escAttr(cumulative)}">${_escHtml(parts[i])}</a></span>`;
        }
        bc.innerHTML = html;
        bc.querySelectorAll('[data-zip-bc]').forEach(a => {
            a.addEventListener('click', () => {
                const target = a.dataset.zipBc || '';
                _currentZipEntry = target;
                _loadZipContents(_currentZipPath, target);
            });
        });
    }

    function _humanSize(b) {
        if (b < 1024) return b + ' B';
        if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
        return (b / 1024 / 1024).toFixed(1) + ' MB';
    }

    // ========== 压缩文件（选文件/目录打包） ==========
    function compressSelected(paths, destDir) {
        const defaultName = `压缩包_${new Date().toISOString().slice(0,10)}`;
        const container = document.getElementById('previewContainer');
        container.innerHTML = `
            <div class="preview-overlay">
                <div class="zip-modal" style="width:460px;height:auto;">
                    <div class="zip-header">
                        <div class="zip-title-row">
                            <div class="zip-title"><i class="bi bi-file-zip-fill"></i><span>压缩文件</span></div>
                            <div class="zip-actions"><button class="btn btn-close-zip" id="zipCloseBtn"><i class="bi bi-x-lg"></i></button></div>
                        </div>
                    </div>
                    <div style="padding:8px 20px 18px;">
                        <label style="font-size:0.78rem;color:#4a5568;display:block;margin-bottom:4px;">压缩文件名</label>
                        <input class="zip-name-input" id="zipNewName" value="${defaultName}" />
                        <div class="zip-name-hint">将在 <span id="zipDestHint">${_escHtml(destDir || '-')}</span> 下生成</div>
                        <div style="font-size:0.78rem;color:#718096;margin-top:8px;">共 <b>${paths.length}</b> 项待压缩</div>
                        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px;">
                            <button class="btn" style="background:#f1f5f9;color:#475569;padding:6px 14px;border-radius:8px;border:none;cursor:pointer;font-size:0.85rem;" id="zipCancelBtn">取消</button>
                            <button class="btn" style="background:#2563eb;color:white;padding:6px 14px;border-radius:8px;border:none;cursor:pointer;font-size:0.85rem;" id="zipConfirmBtn"><i class="bi bi-file-zip"></i> 开始压缩</button>
                        </div>
                    </div>
                </div>
            </div>`;
        document.getElementById('zipCloseBtn').addEventListener('click', closePreview);
        document.getElementById('zipCancelBtn').addEventListener('click', closePreview);
        document.getElementById('zipConfirmBtn').addEventListener('click', () => {
            const name = (document.getElementById('zipNewName').value || '').trim() || defaultName;
            closePreview();
            _doCompress(paths, destDir, name);
        });
    }

    function _doCompress(paths, destDir, name) {
        const body = document.getElementById('zipBody');
        // 用一个临时提示承载进度
        showToast('处理中', '正在压缩文件…', 'info');
        fetch('/api/zip/create', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ paths: paths, dest_dir: destDir || '', name })
        }).then(r => r.json()).then(data => {
            if (data.error) { showToast('错误', data.error, 'danger'); return; }
            showToast('成功', `已生成压缩包 ${data.name}（${data.size_str}，共 ${data.files} 个文件）`, 'success');
            loadFiles(currentPath);
        }).catch(e => { showToast('错误', e.message, 'danger'); });
    }

    // ========== 文件预览 ==========
    const _TEXT_EXTS = new Set(['txt','md','py','js','ts','jsx','tsx','html','htm','css','scss','less','json','xml','yml','yaml','ini','cfg','conf','env','sh','bat','ps1','rs','go','java','c','cpp','h','hpp','cs','rb','php','sql','log','csv','toml']);
    const _IMAGE_EXTS = new Set(['png','jpg','jpeg','gif','svg','webp','bmp','ico']);
    const _VIDEO_EXTS = new Set(['mp4','webm','mkv','avi','mov','m4v','ogg','flv']);

    function _canPreview(ext) {
        const e = (ext || '').toLowerCase();
        return _TEXT_EXTS.has(e) || _IMAGE_EXTS.has(e) || _VIDEO_EXTS.has(e);
    }

    function _escapeHtml(str) {
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function previewFile(absPath) {
        const ext = (absPath.split('.').pop() || '').toLowerCase();
        if (_isZip(ext)) {
            openZipViewer(absPath, '');
            return;
        }
        if (!_canPreview(ext)) return;
        const container = document.getElementById('previewContainer');
        const extLabel = ext ? ext.toUpperCase() : '未知';
        const fileName = absPath.split('/').pop();
        const isTextFile = _TEXT_EXTS.has(ext);
        container.innerHTML = `
            <div class="preview-overlay">
                <div class="preview-modal">
                    <div class="preview-header">
                        <div style="display:flex;align-items:center;justify-content:space-between;flex:1;min-width:0;">
                            <div class="preview-title" style="display:flex;align-items:center;gap:8px;overflow:hidden;">
                                <span><i class="bi bi-eye"></i></span>
                                <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${fileName}</span>
                            </div>
                            <div class="preview-actions">
                                ${isTextFile ? `<button class="btn" id="previewEditBtn" style="background:#2563eb;color:white;padding:4px 10px;border-radius:6px;border:none;cursor:pointer;font-size:0.78rem;display:flex;align-items:center;gap:4px;"><i class="bi bi-pencil-square"></i> 编辑</button>` : ''}
                                <button class="btn btn-copy" id="previewCopyBtn"><i class="bi bi-clipboard"></i> 复制</button>
                                <button class="btn btn-close-preview" id="previewCloseBtn"><i class="bi bi-x-lg"></i></button>
                            </div>
                        </div>
                        <span class="file-path" style="display:block;width:100%;font-size:0.7rem;color:#718096;font-family:monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:4px 0 0 26px;">.${extLabel} · ${absPath}</span>
                    </div>
                    <div class="preview-body preview-loading">
                        <div class="spinner-border" role="status"></div>
                    </div>
                </div>
            </div>
        `;
        document.getElementById('previewCloseBtn').addEventListener('click', closePreview);
        document.getElementById('previewCopyBtn').addEventListener('click', _copyPreview);
        if (isTextFile) {
            document.getElementById('previewEditBtn').addEventListener('click', () => {
                closePreview();
                openEditor(absPath, false);
            });
        }
        container.querySelector('.preview-overlay').addEventListener('click', (e) => {
            if (e.target.classList.contains('preview-overlay')) closePreview();
        });
        document.addEventListener('keydown', function onPvKey(e) {
            if (e.key === 'Escape') { closePreview(); document.removeEventListener('keydown', onPvKey); }
        });
        const body = container.querySelector('.preview-body');
        fetch(`/api/preview?path=${encodeURIComponent(absPath)}`)
            .then(r => r.json())
            .then(data => {
                if (data.error) {
                    body.className = 'preview-body preview-error';
                    body.innerHTML = `<i class="bi bi-exclamation-circle"></i><span>${data.error}</span>`;
                    document.getElementById('previewCopyBtn').style.display = 'none';
                    return;
                }
                if (data.type === 'image') {
                    document.getElementById('previewCopyBtn').style.display = 'none';
                    body.className = 'preview-body preview-image';
                    body.innerHTML = `<img src="data:${data.content_type || 'image/png'};base64,${data.content}" alt="${fileName}" />`;
                } else if (data.type === 'video') {
                    document.getElementById('previewCopyBtn').style.display = 'none';
                    body.className = 'preview-body preview-video';
                    body.innerHTML = `
                        <div class="video-info" style="position:absolute;top:10px;left:10px;background:rgba(0,0,0,0.7);color:white;padding:4px 10px;border-radius:6px;font-size:0.75rem;z-index:10;">
                            ${data.size_str || ''}
                        </div>
                        <video controls autoplay style="width:100%;height:100%;">
                            <source src="${data.stream_url}" type="${data.content_type}">
                            您的浏览器不支持视频播放
                        </video>`;
                } else {
                    body.className = 'preview-body preview-text';
                    const bytes = Uint8Array.from(atob(data.content), c => c.charCodeAt(0));
                    const decoded = new TextDecoder('utf-8').decode(bytes);
                    body.innerHTML = `<pre>${_escapeHtml(decoded)}</pre>`;
                    document.getElementById('previewCopyBtn').style.display = '';
                }
            })
            .catch(err => {
                body.className = 'preview-body preview-error';
                body.innerHTML = `<i class="bi bi-exclamation-circle"></i><span>加载失败: ${err.message}</span>`;
                document.getElementById('previewCopyBtn').style.display = 'none';
            });
    }

    function closePreview() {
        _closeMenus();
        const container = document.getElementById('previewContainer');
        container.innerHTML = '';
    }

    // ========== 全盘搜索 ==========
    let _searchToken = null;
    let _searchPollTimer = null;
    let _searchRunning = false;

    function showSearchModal() {
        const container = document.getElementById('searchContainer');
        const overlay = document.getElementById('searchOverlay');

        // 已存在则直接显示（保留历史搜索结果）
        if (overlay) {
            overlay.style.display = 'flex';
            const collBtn = document.getElementById('searchCollapsedBtn');
            if (collBtn) collBtn.style.display = 'none';
            return;
        }

        container.innerHTML = `
            <div class="custom-modal-overlay" id="searchOverlay">
                <div class="search-modal">
                    <div class="search-header">
                        <span class="search-title"><i class="bi bi-search"></i> 全盘搜索<span class="search-subtitle">基于本地索引，毫秒级响应</span></span>
                        <button class="search-close" id="searchCloseBtn" title="收起至右上角"><i class="bi bi-arrows-angle-contract"></i> 收起</button>
                    </div>
                    <div class="search-body">
                        <div class="search-params">
                            <div class="search-root-input">
                                <span class="label"><i class="bi bi-folder2-open"></i></span>
                                <input type="text" id="searchRootInput" placeholder="搜索根目录（默认系统盘）" />
                                <span class="label" style="margin-left:6px;"><i class="bi bi-search"></i></span>
                                <input type="text" id="searchKeyInput" class="flex-grow-1" placeholder="搜索关键字（文件名）" style="min-width:160px;" />
                                <select id="searchTypeFilter" style="max-width:90px;font-size:0.82rem;padding:6px 8px;border:1px solid #cbd5e1;border-radius:8px;">
                                    <option value="">全部</option>
                                    <option value="文件">文件</option>
                                    <option value="目录">目录</option>
                                </select>
                            </div>
                            <button class="btn btn-run" id="searchRunBtn"><i class="bi bi-search"></i> 搜索</button>
                            <button class="btn btn-clear" id="searchClearBtn" title="清空输入框"><i class="bi bi-x-circle"></i></button>
                        </div>
                        <div class="search-meta">
                            <span class="meta-item" id="searchStatusMeta"><span class="text-muted">等待搜索...</span></span>
                            <span class="meta-item"><i class="bi bi-clock"></i> 耗时: <strong id="searchDuration">--</strong> 秒</span>
                            <span class="meta-item"><i class="bi bi-list-ul"></i> 命中: <strong id="searchCount">0</strong> 个</span>
                            <span class="meta-item"><i class="bi bi-database"></i> 来源: <strong id="searchSource">--</strong></span>
                        </div>
                    </div>
                    <div class="search-progress" id="searchProgress"><div class="search-progress-bar"></div></div>
                    <div class="search-batch" id="searchBatch" style="display:none;">
                        <div class="batch-left">
                            <span><i class="bi bi-check2-square"></i> 已选 <span class="batch-count" id="batchCount">0</span> 项</span>
                            <span class="batch-note">点击「批量打开」跳转到第一个文件所在目录</span>
                        </div>
                        <div class="batch-right">
                            <button class="batch-open" id="batchOpenBtn" disabled><i class="bi bi-folder2-open"></i> 批量打开所在位置</button>
                            <button class="batch-deselect" id="batchDeselectBtn"><i class="bi bi-x-square"></i> 取消</button>
                        </div>
                    </div>
                    <div class="search-results" id="searchResults">
                        <div class="search-empty"><i class="bi bi-search"></i><p class="mb-0">在上方填写关键字后点击「搜索」</p></div>
                    </div>
                </div>
            </div>
            <div class="search-collapsed" id="searchCollapsedBtn" style="display:none;" title="展开搜索结果"><i class="bi bi-search"></i><span class="collapsed-badge" id="searchCollapsedBadge">0</span></div>
            <div class="search-collapsed-tip" id="searchCollapsedTip">点击展开搜索结果</div>
        `;

        const rootVal = systemInfo.root || currentPath || '/';
        document.getElementById('searchRootInput').value = rootVal;

        // 事件绑定
        const ov = document.getElementById('searchOverlay');
        ov.addEventListener('click', (e) => { if (e.target === ov) _collapseSearch(); });
        document.getElementById('searchCloseBtn').addEventListener('click', _collapseSearch);
        document.getElementById('searchClearBtn').addEventListener('click', _clearSearchResults);
        document.getElementById('searchCollapsedBtn').addEventListener('click', _expandSearch);

        document.getElementById('searchRunBtn').addEventListener('click', startSearch);
        document.getElementById('batchOpenBtn').addEventListener('click', _batchOpenLocations);
        document.getElementById('batchDeselectBtn').addEventListener('click', _batchDeselect);
        document.getElementById('searchKeyInput').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') startSearch();
        });
    }

    function _collapseSearch() {
        cancelSearch(false);
        const overlay = document.getElementById('searchOverlay');
        if (overlay) overlay.style.display = 'none';
        const collBtn = document.getElementById('searchCollapsedBtn');
        if (collBtn) {
            collBtn.style.display = 'flex';
            const badge = document.getElementById('searchCollapsedBadge');
            if (badge) {
                if (_searchItems && _searchItems.length > 0) {
                    badge.textContent = _searchItems.length;
                    badge.classList.remove('empty');
                } else {
                    badge.textContent = '0';
                    badge.classList.add('empty');
                }
            }
        }
    }

    function _expandSearch() {
        const collBtn = document.getElementById('searchCollapsedBtn');
        if (collBtn) collBtn.style.display = 'none';
        const overlay = document.getElementById('searchOverlay');
        if (overlay) overlay.style.display = 'flex';
    }

    function cancelSearch(stopPolling) {
        const timer = _searchPollTimer;
        if (timer) { clearInterval(timer); _searchPollTimer = null; }
        _searchToken = null;
        _searchRunning = false;
        const progress = document.getElementById('searchProgress');
        if (progress) progress.classList.remove('active');
        const runBtn = document.getElementById('searchRunBtn');
        if (runBtn) { runBtn.disabled = false; runBtn.innerHTML = '<i class="bi bi-search"></i> 搜索'; }
    }

    function _clearSearchResults() {
        cancelSearch(true);
        const meta = document.getElementById('searchStatusMeta');
        if (meta) meta.innerHTML = '<span class="text-muted">等待搜索...</span>';
        const dur = document.getElementById('searchDuration');
        if (dur) dur.textContent = '--';
        const cnt = document.getElementById('searchCount');
        if (cnt) cnt.textContent = '0';
        const src = document.getElementById('searchSource');
        if (src) src.textContent = '--';
        document.getElementById('searchKeyInput').value = '';
        document.getElementById('searchKeyInput').focus();
    }

    function startSearch() {
        const keyword = document.getElementById('searchKeyInput').value.trim();
        if (!keyword) { showToast('提示', '请输入搜索关键字', 'warning'); document.getElementById('searchKeyInput').focus(); return; }
        // 如果处于收缩状态，先展开
        _expandSearch();
        cancelSearch(true);
        document.getElementById('searchDuration').textContent = '--';
        document.getElementById('searchCount').textContent = '0';
        document.getElementById('searchSource').textContent = '--';
        document.getElementById('searchStatusMeta').innerHTML = '<span class="meta-loading"><i class="bi bi-arrow-repeat spin" style="display:inline-block;animation:spin 1s linear infinite;"></i> 正在搜索...</span>';
        document.getElementById('searchProgress').classList.add('active');
        document.getElementById('searchResults').innerHTML = '<div class="search-empty"><div class="spinner-border text-primary" role="status"></div><p class="mb-0 mt-2">搜索中，请稍候...</p></div>';
        document.getElementById('searchRunBtn').disabled = true;
        document.getElementById('searchRunBtn').innerHTML = '<i class="bi bi-arrow-repeat" style="display:inline-block;animation:spin 1s linear infinite;"></i> 搜索中';

        const root = document.getElementById('searchRootInput').value.trim();
        const typeF = document.getElementById('searchTypeFilter').value;

        fetch(`/api/search?root=${encodeURIComponent(root)}&keyword=${encodeURIComponent(keyword)}&type=${encodeURIComponent(typeF)}`)
            .then(r => r.json())
            .then(data => {
                if (data.error) {
                    _searchPollTimer = null;
                    document.getElementById('searchStatusMeta').innerHTML = '<span class="text-danger"><i class="bi bi-exclamation-circle"></i> 错误</span>';
                    document.getElementById('searchResults').innerHTML = `<div class="search-empty"><i class="bi bi-exclamation-triangle text-danger"></i><p class="mb-0">${data.error}</p></div>`;
                    _resetSearchButtons();
                    return;
                }
                // 索引直接返回（无需轮询）
                if (data.done === true) {
                    document.getElementById('searchProgress').classList.remove('active');
                    document.getElementById('searchCount').textContent = data.count || 0;
                    document.getElementById('searchDuration').textContent = data.duration || 0;
                    document.getElementById('searchSource').textContent = data.source === 'index' ? '索引' : '实时';
                    const sourceLabel = data.source === 'index' ? ' (索引，毫秒级)' : ' (实时扫描)';
                    document.getElementById('searchStatusMeta').innerHTML = `<span class="text-success"><i class="bi bi-check-circle"></i> 搜索完成${sourceLabel}</span>`;
                    _renderSearchResults(data.items || []);
                    _resetSearchButtons();
                    return;
                }
                // 异步轮询
                _searchToken = data.token;
                _searchRunning = true;
                _searchPollTimer = setInterval(pollSearch, 300);
            })
            .catch(e => {
                _searchPollTimer = null;
                document.getElementById('searchStatusMeta').innerHTML = '<span class="text-danger"><i class="bi bi-exclamation-circle"></i> 错误</span>';
                document.getElementById('searchResults').innerHTML = `<div class="search-empty"><i class="bi bi-exclamation-triangle text-danger"></i><p class="mb-0">发起搜索失败: ${e.message}</p></div>`;
                _resetSearchButtons();
            });
    }

    function _resetSearchButtons() {
        const runBtn = document.getElementById('searchRunBtn');
        if (runBtn) { runBtn.disabled = false; runBtn.innerHTML = '<i class="bi bi-search"></i> 搜索'; }
        _searchRunning = false;
    }

    function pollSearch() {
        if (!_searchToken || !_searchRunning) return;
        fetch(`/api/search/${_searchToken}`)
            .then(r => r.json())
            .then(data => {
                if (data.error) {
                    // token 失效等，静默处理
                    if (data.error === "无效或已过期的搜索任务") {
                        _stopPolling();
                    }
                    return;
                }
                const count = data.count || 0;
                const dur = data.duration || 0;
                document.getElementById('searchCount').textContent = count;
                document.getElementById('searchDuration').textContent = dur;
                if (data.done) {
                    _stopPolling();
                    document.getElementById('searchProgress').classList.remove('active');
                    const runBtn = document.getElementById('searchRunBtn');
                    if (runBtn) { runBtn.disabled = false; runBtn.innerHTML = '<i class="bi bi-search"></i> 搜索'; }
                    if (data.error) {
                        document.getElementById('searchStatusMeta').innerHTML = '<span class="text-warning"><i class="bi bi-exclamation-triangle"></i> 搜索完成（有异常）</span>';
                    } else {
                        document.getElementById('searchSource').textContent = '实时';
                        document.getElementById('searchStatusMeta').innerHTML = '<span class="text-success"><i class="bi bi-check-circle"></i> 搜索完成 (实时扫描)</span>';
                    }
                    _renderSearchResults(data.items || []);
                }
            })
            .catch(() => {});
    }

    function _stopPolling() {
        if (_searchPollTimer) { clearInterval(_searchPollTimer); _searchPollTimer = null; }
        _searchRunning = false;
    }

    function _renderSearchResults(items) {
        _searchItems = items || [];
        _selectedSearchPaths.clear();
        const el = document.getElementById('searchResults');
        _showBatchBar(false);
        if (!items || items.length === 0) {
            el.innerHTML = '<div class="search-empty"><i class="bi bi-inbox"></i><p class="mb-0">未找到匹配的文件</p></div>';
            return;
        }
        const sorted = [...items].sort((a, b) => (a.is_dir ? -1 : 1) || a.name.localeCompare(b.name));
        let html = `<table class="search-table"><thead><tr>
            <th class="search-cb"><input type="checkbox" class="search-checkbox" id="searchSelectAll" title="全选"/></th>
            <th style="width:26%">名称</th>
            <th style="width:18%">路径</th>
            <th style="width:75px;text-align:right;">大小</th>
            <th style="width:75px;">类型</th>
            <th style="width:140px;">修改时间</th>
            <th style="width:180px;">操作</th>
        </tr></thead><tbody>`;
        for (const item of sorted) {
            const isDir = item.is_dir;
            const ext = (item.ext || '').toLowerCase();
            let badgeClass = isDir ? 'search-type-badge dir' : 'search-type-badge';
            let typeText = isDir ? '目录' : (ext ? ext.toUpperCase() : '未知');
            if (!isDir) {
                if (ext === 'txt' || ext === 'md' || ext === 'py' || ext === 'js' || ext === 'json') badgeClass += ' text';
                else if (ext === 'jpg' || ext === 'png' || ext === 'gif' || ext === 'svg' || ext === 'webp') badgeClass += ' image';
                else if (ext === 'mp4' || ext === 'avi' || ext === 'mkv' || ext === 'mov') badgeClass += ' video';
            }
            const absPath = item.abs_path || item.path;
            const displayName = item.name || '(未知)';
            const displayPath = absPath || '';
            const when = item.mtime || '-';
            const sizeStr = item.size_str || (isDir ? '-' : formatSize(item.size || 0));
            let parentPath = absPath;
            if (absPath) {
                const idx = absPath.lastIndexOf('/');
                const idx2 = absPath.lastIndexOf(String.fromCharCode(92));
                const bestIdx = idx >= 0 ? (idx2 > idx ? idx2 : idx) : idx2;
                parentPath = bestIdx >= 0 ? absPath.substring(0, bestIdx) : absPath;
            }
            html += `<tr class="search-row" data-abs-path="${_escAttr(absPath)}" data-parent-path="${_escAttr(parentPath)}">
                <td><input type="checkbox" class="search-checkbox search-item-cb" data-path="${_escAttr(absPath)}"/></td>
                <td><i class="${_getSearchIconClass(item)}"></i> <span class="search-name" title="${_escAttr(displayName)}">${_escHtml(displayName)}</span></td>
                <td><span class="search-path" data-full-path="${_escAttr(displayPath)}" title="点击复制路径">${_escHtml(displayPath)}</span></td>
                <td class="text-end search-size">${_escHtml(sizeStr)}</td>
                <td><span class="${badgeClass}">${_escHtml(typeText)}</span></td>
                <td class="search-when">${_escHtml(when)}</td>
                <td class="search-actions">
                    <button class="search-open" data-parent-path="${_escAttr(parentPath)}" title="进入所在文件夹"><i class="bi bi-folder2-open"></i> 打开</button>
                    ${!isDir ? `<button class="search-preview" data-preview-path="${_escAttr(absPath)}" title="预览文件"><i class="bi bi-eye"></i> 预览</button>` : ''}
                </td>
            </tr>`;
        }
        html += '</tbody></table>';
        el.innerHTML = html;
        // 「打开」按钮：跳转文件所在位置（弹窗保持打开）
        el.querySelectorAll('[data-parent-path]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                navigateTo(btn.dataset.parentPath);
            });
        });
        // 路径列：点击复制完整路径
        el.querySelectorAll('.search-path').forEach(span => {
            span.addEventListener('click', (e) => {
                e.stopPropagation();
                const p = span.dataset.fullPath || span.textContent;
                navigator.clipboard.writeText(p).then(() => {
                    showToast('成功', '路径已复制到剪贴板: ' + p.substring(0, 60), 'success');
                }).catch(() => {
                    showToast('提示', '完整路径: ' + p, 'info');
                });
            });
        });
        // 行点击：跳转到文件所在目录（排除按钮和复选框）
        el.querySelectorAll('.search-row').forEach(row => {
            row.addEventListener('click', (e) => {
                if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON') return;
                const parentPath = row.dataset.parentPath;
                if (parentPath) navigateTo(parentPath);
            });
        });
        el.querySelectorAll('[data-preview-path]').forEach(btn => {
            btn.addEventListener('click', () => {
                const p = btn.dataset.previewPath;
                const ext = (p.split('.').pop() || '').toLowerCase();
                if (_canPreview(ext)) previewFile(p);
                else showToast('提示', '该文件类型不支持预览', 'warning');
            });
        });
        const selectAll = el.querySelector('#searchSelectAll');
        if (selectAll) {
            selectAll.addEventListener('change', (e) => {
                const checked = e.target.checked;
                el.querySelectorAll('.search-item-cb').forEach(cb => {
                    cb.checked = checked;
                    const p = cb.dataset.path;
                    if (checked) _selectedSearchPaths.add(p);
                    else _selectedSearchPaths.delete(p);
                });
                _updateSearchBatch();
            });
        }
        el.querySelectorAll('.search-item-cb').forEach(cb => {
            cb.addEventListener('change', (e) => {
                const p = cb.dataset.path;
                const row = cb.closest('tr');
                if (e.target.checked) { _selectedSearchPaths.add(p); row.classList.add('selected'); }
                else { _selectedSearchPaths.delete(p); row.classList.remove('selected'); }
                _updateSearchBatch();
                const total = el.querySelectorAll('.search-item-cb').length;
                const sa = el.querySelector('#searchSelectAll');
                if (sa) sa.checked = _selectedSearchPaths.size === total && total > 0;
            });
        });
    }

    let _searchItems = [];
    let _selectedSearchPaths = new Set();

    function _showBatchBar(show) {
        const bar = document.getElementById('searchBatch');
        if (bar) bar.style.display = show ? 'flex' : 'none';
    }

    function _updateSearchBatch() {
        const count = _selectedSearchPaths.size;
        const countEl = document.getElementById('batchCount');
        const openBtn = document.getElementById('batchOpenBtn');
        if (countEl) countEl.textContent = count;
        if (openBtn) openBtn.disabled = count === 0;
        _showBatchBar(count > 0);
    }

    function _batchDeselect() {
        _selectedSearchPaths.clear();
        const el = document.getElementById('searchResults');
        if (el) {
            el.querySelectorAll('.search-item-cb').forEach(cb => { cb.checked = false; });
            el.querySelectorAll('#searchSelectAll').forEach(cb => { cb.checked = false; });
            el.querySelectorAll('tr.selected').forEach(r => { r.classList.remove('selected'); });
        }
        _showBatchBar(false);
    }

    function _batchOpenLocations() {
        if (_selectedSearchPaths.size === 0) return;
        const paths = Array.from(_selectedSearchPaths);
        for (const p of paths) {
            for (const item of _searchItems) {
                if ((item.abs_path || item.path) === p) {
                    const absPath = item.abs_path || item.path;
                    let parentPath = absPath;
                    if (absPath) {
                        const idx = absPath.lastIndexOf('/');
                        const idx2 = absPath.lastIndexOf(String.fromCharCode(92));
                        const bestIdx = idx >= 0 ? (idx2 > idx ? idx2 : idx) : idx2;
                        parentPath = bestIdx >= 0 ? absPath.substring(0, bestIdx) : absPath;
                    }
                    navigateTo(parentPath);
                    if (_selectedSearchPaths.size > 1) {
                        showToast('提示', '已跳转到第 1 个文件所在目录，其余 ' + (_selectedSearchPaths.size - 1) + ' 个项留在搜索结果中继续操作', 'info');
                    }
                    return;
                }
            }
        }
    }

    function _getIconForSearch(item) {
        return item.is_dir ? '📁' : '📄';
    }

    function _getSearchIconClass(item) {
        if (item.is_dir) return 'bi bi-folder-fill text-warning';
        const ext = (item.ext || '').toLowerCase();
        const icons = {'pdf':'bi-filetype-pdf text-danger','jpg':'bi-file-image text-success','jpeg':'bi-file-image text-success','png':'bi-file-image text-success','gif':'bi-file-image text-success','svg':'bi-file-image text-success','mp4':'bi-file-play text-primary','avi':'bi-file-play text-primary','mov':'bi-file-play text-primary','mkv':'bi-file-play text-primary','mp3':'bi-file-music text-primary','wav':'bi-file-music text-primary','zip':'bi-file-zip text-secondary','rar':'bi-file-zip text-secondary','7z':'bi-file-zip text-secondary','py':'bi-file-code text-info','js':'bi-file-code text-warning','html':'bi-file-code text-danger','css':'bi-file-code text-info','json':'bi-file-code text-secondary','txt':'bi-file-text text-secondary','md':'bi-file-text text-secondary'};
        return `bi ${icons[ext] || 'bi-file-earmark'}`;
    }

    function _escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
    function _escAttr(s) { return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }


    function _copyPreview() {
        const pre = document.querySelector('.preview-body pre');
        if (pre) {
            navigator.clipboard.writeText(pre.textContent).then(() => {
                showToast('成功', '文本已复制到剪切板', 'success');
            }).catch(() => {
                showToast('失败', '复制失败', 'danger');
            });
        }
    }

    // ========== 视图切换 ==========
    function switchView(mode) {
        _closeMenus();
        viewMode = mode;
        localStorage.setItem(STORAGE_VIEW_KEY, mode);
        document.getElementById('viewList').style.display = (mode === 'list') ? 'block' : 'none';
        document.getElementById('viewIcon').style.display = (mode === 'icon') ? 'block' : 'none';
        document.getElementById('viewTree').style.display = (mode === 'tree') ? 'block' : 'none';
        document.querySelectorAll('.btn-view').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.view === mode);
        });
        const sizeGroup = document.getElementById('iconSizeGroup');
        if (sizeGroup) {
            sizeGroup.classList.toggle('show-icon-size', mode === 'icon');
        }
        applyFiltersAndSort();
    }

    // ========== 图标大小切换 ==========
    const STORAGE_ICON_SIZE_KEY = 'fileManager_iconSize';
    let iconSize = localStorage.getItem(STORAGE_ICON_SIZE_KEY) || 'sm';

    function switchIconSize(size) {
        if (!['sm', 'md', 'lg'].includes(size)) size = 'sm';
        iconSize = size;
        localStorage.setItem(STORAGE_ICON_SIZE_KEY, size);
        const group = document.getElementById('iconSizeGroup');
        if (group) {
            group.querySelectorAll('.icon-size-btn').forEach(btn => {
                btn.classList.toggle('active', btn.dataset.size === size);
            });
        }
        // 更新网格列宽
        const grid = document.getElementById('iconGrid');
        if (grid) {
            grid.classList.remove('sm', 'md', 'lg');
            grid.classList.add(size);
        }
        // 重新渲染以应用新的 icon-item 大小类
        if (viewMode === 'icon') {
            applyFiltersAndSort();
        }
    }

    function toggleSelectMode() {
        selectMode = !selectMode;
        localStorage.setItem('fileManager_selectMode', selectMode.toString());
        document.body.classList.toggle('select-mode', selectMode);
        document.getElementById('selectModeBtn').classList.toggle('active', selectMode);
        // 选择模式关闭时清空已选
        if (!selectMode) {
            selectedPaths.clear();
            document.querySelectorAll('.item-checkbox, .icon-check, .tree-checkbox').forEach(el => {
                el.checked = false;
            });
            document.querySelectorAll('.selected').forEach(el => el.classList.remove('selected'));
            document.getElementById('selectAll').checked = false;
            document.getElementById('selectAll').indeterminate = false;
            updateSelectedCount();
            updateBatchDeleteBtn();
        }
    }

    // ========== 上级目录行 ==========
    function _buildParentRow() {
        // 上级目录的显示名（取父目录的最后一段）
        const pName = parentPath.split('/').filter(Boolean).pop() || parentPath.split('\\').filter(Boolean).pop() || parentPath || '..';
        return `
            <tr class="parent-row" data-parent-row="true">
                <td class="checkbox-col"><input class="form-check-input item-checkbox parent-cb" type="checkbox" disabled aria-hidden="true"/></td>
                <td>
                    <i class="bi bi-arrow-90deg-up" style="color:#718096;"></i>
                    <a class="dir-link parent-link" data-path="${_escAttr(parentPath)}" style="color:#64748b;font-weight:500;font-size:0.85rem;">.. &rarr; ${_escHtml(pName)}</a>
                </td>
                <td class="text-end file-size">-</td>
                <td><span class="file-type-badge dir">上级目录</span></td>
                <td style="font-size:0.85rem; color:#a0aec0;">-</td>
                <td class="text-center"></td>
            </tr>`;
    }

    function _buildParentIcon(size) {
        size = size || iconSize;
        const pName = parentPath.split('/').filter(Boolean).pop() || parentPath.split('\\').filter(Boolean).pop() || parentPath || '..';
        return `
            <div class="icon-item ${size} parent-row clickable" data-path="${_escAttr(parentPath)}" data-parent-item="true">
                <input class="form-check-input item-checkbox icon-check parent-cb" type="checkbox" disabled aria-hidden="true"/>
                <button class="icon-more" style="display:none;"></button>
                <div class="icon-thumb"><span class="thumb-icon"><i class="bi bi-arrow-90deg-up" style="color:#718096;font-size:1.8rem;"></i></span></div>
                <span class="icon-name" data-path="${_escAttr(parentPath)}" data-ext="" title="点击返回上级目录" style="color:#64748b;font-weight:500;">.. &rarr; ${_escHtml(pName)}</span>
                <span class="icon-meta"><span class="icon-size">上级目录</span></span>
            </div>`;
    }

    // ========== 列表视图 ==========
    function renderTable(items) {
        const tbody = document.getElementById('fileBody');
        if (!items || items.length === 0) {
            const parentRow = parentPath ? _buildParentRow() : '';
            tbody.innerHTML = parentRow + `<tr><td colspan="${selectMode ? 6 : 5}"><div class="empty-state"><i class="bi bi-inbox"></i><p class="mb-0">此目录为空</p></div></td></tr>`;
            return;
        }
        const html = _buildTableHtml(items);
        if (items.length < 200) {
            tbody.innerHTML = html;
            _bindTableEvents(tbody);
            return;
        }
        // 大列表：用临时 <table><tbody> 解析 HTML，首屏 200 行立即渲染，剩余分片追加
        // 不能用 <div>.innerHTML 解析 <tr>（浏览器会套一层 <table>，childNodes 拿不到行）
        const tmpTable = document.createElement('table');
        tmpTable.innerHTML = `<tbody>${html}</tbody>`;
        const tmpTbody = tmpTable.querySelector('tbody');
        const nodes = Array.from(tmpTbody ? tmpTbody.childNodes : []);
        tbody.innerHTML = '';
        const first = 200;
        for (let i = 0; i < first && i < nodes.length; i++) tbody.appendChild(nodes[i]);
        const rest = nodes.slice(first);
        if (rest.length === 0) { _bindTableEvents(tbody); return; }
        const chunk = 200;
        let j = 0;
        function step() {
            const end = Math.min(j + chunk, rest.length);
            for (; j < end; j++) tbody.appendChild(rest[j]);
            if (j < rest.length) setTimeout(step, 0);
            else _bindTableEvents(tbody);
        }
        setTimeout(step, 0);
    }

    function _buildTableHtml(items) {
        let html = '';
        if (parentPath) html += _buildParentRow();
        for (const item of items) {
            const absPath = currentPath ? (currentPath + '/' + item.path).replace(/\\/g,'/').replace(/\\\\+/g,'/') : item.path;
            const isSelected = selectedPaths.has(absPath);
            const iconHtml = getFileIcon(item);
            const typeBadge = getTypeBadge(item);
            let nameHtml;
            if (item.is_dir) {
                nameHtml = `<a class="dir-link" data-path="${absPath}">${iconHtml} ${item.name}</a>`;
            } else {
                const ext = (item.ext || '').toLowerCase();
                const previewable = _canPreview(ext);
                const isZip = _isZip(ext);
                const nameClass = (previewable || isZip) ? 'file-name file-name-clickable' : 'file-name';
                nameHtml = `${iconHtml} <span class="${nameClass}" data-path="${absPath}" data-ext="${ext}" data-zip="${isZip}" title="${previewable || isZip ? '点击查看' : '不支持预览'}">${item.name}</span>`;
            }
            const moreBtn = '<button class="more-btn" data-action-path="' + absPath + '" data-is-dir="' + item.is_dir + '" title="更多操作"><i class="bi bi-three-dots"></i></button>';
            html += `<tr class="${isSelected ? 'selected' : ''}" data-path="${absPath}">
                <td class="checkbox-col"><input class="form-check-input item-checkbox" type="checkbox" name="files" value="${absPath}" data-path="${absPath}" ${isSelected ? 'checked' : ''} /></td>
                <td>${nameHtml}</td><td class="text-end file-size">${item.size_str || '-'}</td>
                <td>${typeBadge}</td>
                <td style="font-size:0.85rem;color:#4a5568;">${item.mtime || '-'}</td>
                <td class="text-center">${moreBtn}</td>
            </tr>`;
        }
        return html;
    }

    function _bindTableEvents(tbody) {
        tbody.querySelectorAll('.dir-link').forEach(el => {
            el.addEventListener('click', (e) => { e.preventDefault(); navigateTo(el.dataset.path); });
        });
        tbody.querySelectorAll('.file-name-clickable').forEach(el => {
            el.addEventListener('click', (e) => { e.stopPropagation(); previewFile(el.dataset.path); });
        });
        tbody.querySelectorAll('.item-checkbox').forEach(el => {
            el.addEventListener('change', (e) => {
                const path = el.dataset.path;
                if (el.checked) selectedPaths.add(path);
                else selectedPaths.delete(path);
                el.closest('tr').classList.toggle('selected', el.checked);
                updateSelectedCount();
                updateBatchDeleteBtn();
                updateSelectAllState();
            });
        });
        tbody.querySelectorAll('.more-btn').forEach(el => {
            el.addEventListener('click', (e) => { e.stopPropagation(); showActionMenu(el, el.dataset.actionPath, el.dataset.isDir === 'true'); });
        });
    }

    function updateSelectedCount() {
        document.getElementById('selectedCount').textContent = `已选 ${selectedPaths.size} 个`;
    }
    function updateBatchDeleteBtn() {
        const btn = document.getElementById('batchDeleteBtn');
        btn.disabled = selectedPaths.size === 0;
        btn.innerHTML = selectedPaths.size > 0 ? `🗑 删除选中 (${selectedPaths.size})` : '<i class="bi bi-trash3"></i> 删除选中';
        const cb = document.getElementById('batchCompressBtn');
        if (cb) {
            cb.disabled = selectedPaths.size === 0;
            cb.innerHTML = selectedPaths.size > 0 ? `<i class="bi bi-file-zip"></i> 压缩选中 (${selectedPaths.size})` : '<i class="bi bi-file-zip"></i> 压缩选中';
        }
    }
    function updateSelectAllState() {
        const checkboxes = document.querySelectorAll('.item-checkbox:not(.parent-cb)');
        const checked = document.querySelectorAll('.item-checkbox:not(.parent-cb):checked');
        const selectAll = document.getElementById('selectAll');
        if (checkboxes.length === 0) { selectAll.checked = false; selectAll.indeterminate = false; return; }
        if (checked.length === checkboxes.length) { selectAll.checked = true; selectAll.indeterminate = false; }
        else if (checked.length === 0) { selectAll.checked = false; selectAll.indeterminate = false; }
        else { selectAll.checked = false; selectAll.indeterminate = true; }
    }

    // ========== 图标视图 ==========
    function renderIconView(items) {
        const grid = document.getElementById('iconGrid');
        if (grid) {
            grid.classList.remove('sm', 'md', 'lg');
            grid.classList.add(iconSize);
        }
        if (!items || items.length === 0) {
            const parentHtml = parentPath ? _buildParentIcon(iconSize) : '';
            grid.innerHTML = parentHtml + `<div style="grid-column:1/-1;text-align:center;padding:40px;color:#a0aec0;"><i class="bi bi-inbox" style="font-size:2rem;display:block;margin-bottom:8px;"></i>此目录为空</div>`;
            updateSelectedCount(); updateBatchDeleteBtn();
            return;
        }
        let html = '';
        if (parentPath) html += _buildParentIcon(iconSize);
        for (const item of items) {
            const absPath = currentPath ? (currentPath + '/' + item.path).replace(/\\/g,'/').replace(/\\\\+/g,'/') : item.path;
            const isSelected = selectedPaths.has(absPath);
            const ext = (item.ext || '').toLowerCase();
            const isImage = _IMAGE_EXTS.has(ext);
            const isVideo = _VIDEO_EXTS.has(ext);
            const previewable = _canPreview(ext);
            const isZip = _isZip(ext);
            const sizeStr = item.size_str || '-';
            const sizeText = item.is_dir ? (sizeStr !== '-' ? sizeStr : '') : sizeStr;
            const itemClass = (isSelected ? 'selected ' : '') + ((previewable || isZip) ? 'clickable ' : '') + iconSize + ' ';
            const nameTitle = (previewable || isZip) ? '点击查看' : '';
            const moreBtn = `<button class="icon-more" data-action-path="${absPath}" data-is-dir="${item.is_dir}" title="更多操作"><i class="bi bi-three-dots"></i></button>`;
            const iconClass = item.is_dir ? 'bi bi-folder-fill text-warning' : (function() {
                const icons = {'pdf':'bi-filetype-pdf text-danger','jpg':'bi-file-image text-success','jpeg':'bi-file-image text-success','png':'bi-file-image text-success','gif':'bi-file-image text-success','svg':'bi-file-image text-success','mp4':'bi-file-play text-primary','avi':'bi-file-play text-primary','mov':'bi-file-play text-primary','mkv':'bi-file-play text-primary','mp3':'bi-file-music text-primary','wav':'bi-file-music text-primary','zip':'bi-file-zip text-secondary','rar':'bi-file-zip text-secondary','7z':'bi-file-zip text-secondary','py':'bi-file-code text-info','js':'bi-file-code text-warning','html':'bi-file-code text-danger','css':'bi-file-code text-info','json':'bi-file-code text-secondary','txt':'bi-file-text text-secondary','md':'bi-file-text text-secondary'};
                return icons[ext] || 'bi-file-earmark';
            })();
            // 缩略图：图片/视频显示缩略图，其余显示图标
            const thumbPath = isImage || isVideo ? absPath : null;
            const thumbInner = `<span class="thumb-icon"><i class="bi ${iconClass}"></i></span>${isVideo ? `<span class="thumb-badge">${ext.toUpperCase()}</span>` : ''}`;
            const thumbTag = thumbPath
                ? `<div class="icon-thumb" data-thumb-path="${thumbPath}" data-thumb-type="${isImage ? 'image' : 'video'}">${thumbInner}</div>`
                : `<div class="icon-thumb">${thumbInner}</div>`;
            html += `
                <div class="icon-item ${itemClass}" data-path="${absPath}" data-thumb-abs-path="${isImage || isVideo ? absPath : ''}">
                    <input class="form-check-input item-checkbox icon-check" type="checkbox" name="files" value="${absPath}" data-path="${absPath}" ${isSelected ? 'checked' : ''} />
                    ${moreBtn}
                    ${thumbTag}
                    <span class="icon-name" data-path="${absPath}" data-ext="${ext}" title="${nameTitle}">${item.name}</span>
                    <span class="icon-meta"><span class="icon-size">${sizeText}</span></span>
                </div>
            `;
        }
        grid.innerHTML = html;
        // 加载缩略图
        _loadIconThumbnails(grid);
        // 为图片/视频卡片绑定悬浮预览
        _bindHoverPreviews(grid);
        // 绑定事件
        document.querySelectorAll('.icon-item').forEach(el => {
            const absPath = el.dataset.path;
            const ext = (el.querySelector('.icon-name') || {}).dataset?.ext || '';
            const checkbox = el.querySelector('.item-checkbox');
            const nameEl = el.querySelector('.icon-name');
            const moreBtn = el.querySelector('.icon-more');
            const isParentRow = el.dataset.parentItem === 'true';
            // 点击卡片本身
            el.addEventListener('click', (e) => {
                if (e.target.tagName === 'INPUT' || e.target.closest('.icon-more')) return;
                if (isParentRow) { navigateTo(absPath); return; }
                const item = fileItems.find(it => {
                    const p = currentPath ? (currentPath + '/' + it.path).replace(/\\/g,'/').replace(/\\\\+/g,'/') : it.path;
                    return p === absPath;
                });
                if (item && item.is_dir) { navigateTo(absPath); return; }
                if (_canPreview(nameEl.dataset.ext) || _isZip(nameEl.dataset.ext)) { previewFile(absPath); return; }
            });
            // 复选框
            checkbox.addEventListener('change', (e) => {
                e.stopPropagation();
                if (isParentRow) return;
                if (checkbox.checked) selectedPaths.add(absPath); else selectedPaths.delete(absPath);
                el.classList.toggle('selected', checkbox.checked);
                updateSelectedCount(); updateBatchDeleteBtn();
            });
            // 更多按钮
            if (moreBtn && !isParentRow) moreBtn.addEventListener('click', (e) => { e.stopPropagation(); showActionMenu(moreBtn, absPath, moreBtn.dataset.isDir === 'true'); });
            // 文件名点击查看（含 zip）
            if (nameEl && nameEl.dataset.ext && (_canPreview(nameEl.dataset.ext) || _isZip(nameEl.dataset.ext)) && !isParentRow) {
                nameEl.addEventListener('click', (e) => { e.stopPropagation(); previewFile(absPath); });
            }
        });
        updateSelectedCount(); updateBatchDeleteBtn();
    }

    // ========== 树型视图 ==========
    function renderTreeView(items) {
        const container = document.getElementById('treeContainer');
        if (!items || items.length === 0) {
            container.innerHTML = `<div style="text-align:center;padding:40px;color:#a0aec0;"><i class="bi bi-inbox" style="font-size:2rem;display:block;margin-bottom:8px;"></i>此目录为空</div>`;
            updateSelectedCount(); updateBatchDeleteBtn();
            return;
        }
        let html = '';
        for (const item of items) {
            const absPath = currentPath ? (currentPath + '/' + item.path).replace(/\\/g,'/').replace(/\\\\+/g,'/') : item.path;
            const isSelected = selectedPaths.has(absPath);
            const isDir = item.is_dir;
            const ext = (item.ext || '').toLowerCase();
            const previewable = isDir ? false : _canPreview(ext);
            const iconClass = isDir ? 'bi bi-folder-fill text-warning tree-icon' : (function() {
                const icons = {'pdf':'bi-filetype-pdf text-danger','jpg':'bi-file-image text-success','jpeg':'bi-file-image text-success','png':'bi-file-image text-success','gif':'bi-file-image text-success','svg':'bi-file-image text-success','mp4':'bi-file-play text-primary','avi':'bi-file-play text-primary','mov':'bi-file-play text-primary','mkv':'bi-file-play text-primary','mp3':'bi-file-music text-primary','wav':'bi-file-music text-primary','zip':'bi-file-zip text-secondary','rar':'bi-file-zip text-secondary','7z':'bi-file-zip text-secondary','py':'bi-file-code text-info','js':'bi-file-code text-warning','html':'bi-file-code text-danger','css':'bi-file-code text-info','json':'bi-file-code text-secondary','txt':'bi-file-text text-secondary','md':'bi-file-text text-secondary'};
                const cls = icons[ext] || 'bi-file-earmark';
                return `bi ${cls} tree-icon`;
            })();
            const sizeStr = item.size_str || '';
            const metaText = item.is_dir ? sizeStr : sizeStr;
            const lineClass = `tree-line${isSelected ? ' selected' : ''}`;
            const nameClass = previewable ? 'tree-name clickable' : 'tree-name';
            const toggleClass = isDir ? 'tree-toggle expanded' : 'tree-toggle leaf';
            const nameTag = previewable ? `<span class="${nameClass}" data-path="${absPath}" data-ext="${ext}" title="点击预览">${item.name}</span>` : `<span class="tree-name">${item.name}</span>`;
            const moreBtn = `<button class="tree-more" data-action-path="${absPath}" data-is-dir="${item.is_dir}" title="更多操作"><i class="bi bi-three-dots"></i></button>`;
            html += `
                <div class="${lineClass}" data-path="${absPath}">
                    <input class="form-check-input item-checkbox tree-checkbox" type="checkbox" name="files" value="${absPath}" data-path="${absPath}" ${isSelected ? 'checked' : ''} />
                    <span class="${toggleClass}">▶</span>
                    <i class="${iconClass}"></i>
                    ${nameTag}
                    ${metaText ? `<span class="tree-meta">${metaText}</span>` : ''}
                    ${moreBtn}
                </div>
                <div class="tree-children" data-parent="${absPath}"></div>
            `;
        }
        container.innerHTML = html;
        // 绑定事件
        document.querySelectorAll('.tree-line').forEach(el => {
            const absPath = el.dataset.path;
            const toggle = el.querySelector('.tree-toggle');
            const checkbox = el.querySelector('.item-checkbox');
            const nameEl = el.querySelector('.tree-name.clickable');
            const moreBtn = el.querySelector('.tree-more');
            const children = container.querySelector(`[data-parent="${absPath}"]`);
            let expanded = false;
            // Toggle 展开/折叠
            toggle.addEventListener('click', (e) => {
                e.stopPropagation();
                if (toggle.classList.contains('leaf')) return;
                expanded = !expanded;
                toggle.classList.toggle('expanded', expanded);
                children.classList.toggle('collapsed', !expanded);
                if (expanded && !children.dataset.loaded) {
                    children.dataset.loaded = 'true';
                    loadTreeChildren(absPath, children);
                }
            });
            // 复选框
            checkbox.addEventListener('change', (e) => {
                e.stopPropagation();
                if (checkbox.checked) selectedPaths.add(absPath); else selectedPaths.delete(absPath);
                el.classList.toggle('selected', checkbox.checked);
                updateSelectedCount(); updateBatchDeleteBtn();
            });
            // 整行点击（展开目录）
            el.addEventListener('click', (e) => {
                if (e.target.tagName === 'INPUT' || e.target.closest('.tree-more')) return;
                if (e.target.classList.contains('tree-toggle')) return;
                if (e.target.classList.contains('tree-name.clickable')) { previewFile(absPath); return; }
                // 目录导航
                const item = fileItems.find(it => {
                    const p = currentPath ? (currentPath + '/' + it.path).replace(/\\/g,'/').replace(/\\\\+/g,'/') : it.path;
                    return p === absPath;
                });
                if (item && item.is_dir) { navigateTo(absPath); }
            });
            // 预览
            if (nameEl && nameEl.dataset.ext) {
                nameEl.addEventListener('click', (e) => { e.stopPropagation(); previewFile(absPath); });
            }
            // 更多
            if (moreBtn) moreBtn.addEventListener('click', (e) => { e.stopPropagation(); showActionMenu(moreBtn, absPath, moreBtn.dataset.isDir === 'true'); });
        });
        updateSelectedCount(); updateBatchDeleteBtn();
    }

    async function loadTreeChildren(absPath, container) {
        try {
            const resp = await fetch(`/api/files?path=${encodeURIComponent(absPath)}`);
            const data = await resp.json();
            if (data.error) { container.innerHTML = `<div style="padding:4px 0;color:#dc2626;font-size:0.8rem;">${data.error}</div>`; return; }
            let html = '';
            for (const item of data.items) {
                const childAbsPath = absPath + '/' + item.path;
                const isDir = item.is_dir;
                const ext = (item.ext || '').toLowerCase();
                const previewable = isDir ? false : _canPreview(ext);
                const iconClass = isDir ? 'bi bi-folder-fill text-warning tree-icon' : 'bi bi-file-earmark tree-icon';
                const sizeStr = item.size_str || '';
                const nameTag = previewable ? `<span class="tree-name clickable" data-path="${childAbsPath}" data-ext="${ext}">${item.name}</span>` : `<span class="tree-name">${item.name}</span>`;
                html += `
                    <div class="tree-line" data-path="${childAbsPath}">
                        <input class="form-check-input item-checkbox tree-checkbox" type="checkbox" name="files" value="${childAbsPath}" data-path="${childAbsPath}" />
                        <span class="tree-toggle${isDir ? ' expanded' : ' leaf'}">▶</span>
                        <i class="${iconClass}"></i>
                        ${nameTag}
                        ${sizeStr ? `<span class="tree-meta">${sizeStr}</span>` : ''}
                        <button class="tree-more" data-action-path="${childAbsPath}" data-is-dir="${item.is_dir}" title="更多操作"><i class="bi bi-three-dots"></i></button>
                    </div>
                    <div class="tree-children" data-parent="${childAbsPath}"></div>
                `;
            }
            if (html === '') {
                container.innerHTML = '<div style="padding:4px 0;color:#a0aec0;font-size:0.8rem;">(空)</div>';
                return;
            }
            container.innerHTML = html;
            // 绑定子节点事件
            container.querySelectorAll('.tree-line').forEach(el => {
                const childAbs = el.dataset.path;
                const toggle = el.querySelector('.tree-toggle');
                const checkbox = el.querySelector('.item-checkbox');
                const nameEl = el.querySelector('.tree-name.clickable');
                const childContainer = container.querySelector(`[data-parent="${childAbs}"]`);
                const moreBtn = el.querySelector('.tree-more');
                let childExpanded = false;
                toggle.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (toggle.classList.contains('leaf')) return;
                    childExpanded = !childExpanded;
                    toggle.classList.toggle('expanded', childExpanded);
                    childContainer.classList.toggle('collapsed', !childExpanded);
                    if (childExpanded && !childContainer.dataset.loaded) {
                        childContainer.dataset.loaded = 'true';
                        loadTreeChildren(childAbs, childContainer);
                    }
                });
                checkbox.addEventListener('change', (e) => {
                    e.stopPropagation();
                    if (checkbox.checked) selectedPaths.add(childAbs); else selectedPaths.delete(childAbs);
                    el.classList.toggle('selected', checkbox.checked);
                    updateSelectedCount(); updateBatchDeleteBtn();
                });
                el.addEventListener('click', (e) => {
                    if (e.target.tagName === 'INPUT' || e.target.closest('.tree-more') || e.target.classList.contains('tree-toggle')) return;
                    if (e.target.classList.contains('tree-name.clickable')) { previewFile(childAbs); return; }
                    navigateTo(childAbs);
                });
                if (nameEl && nameEl.dataset.ext) {
                    nameEl.addEventListener('click', (e) => { e.stopPropagation(); previewFile(childAbs); });
                }
                if (moreBtn) moreBtn.addEventListener('click', (e) => { e.stopPropagation(); showActionMenu(moreBtn, childAbs, moreBtn.dataset.isDir === 'true'); });
            });
        } catch (e) {
            container.innerHTML = `<div style="padding:4px 0;color:#dc2626;font-size:0.8rem;">加载失败</div>`;
        }
    }

    let _currentFetchController = null;
    let _isNavigating = false;

    function _abortPendingFetch() {
        if (_currentFetchController) {
            try { _currentFetchController.abort(); } catch (e) { /* ignore */ }
            _currentFetchController = null;
        }
    }

    function _setLoading(loading, path) {
        _isNavigating = loading;
        const tbl = document.getElementById('fileBody');
        if (tbl) {
            tbl.classList.toggle('is-loading', loading);
            const existing = tbl.querySelector('.fm-loading-bar');
            if (loading && !existing) {
                const rows = selectMode ? 6 : 5;
                tbl.insertAdjacentHTML('afterbegin',
                    `<tr class="fm-loading-bar" data-fm-loading="true"><td colspan="${rows}">
                        <div style="display:flex;align-items:center;gap:8px;padding:10px 8px;color:#475569;font-size:0.85rem;">
                            <div class="spinner-border spinner-border-sm text-primary" role="status" style="width:1rem;height:1rem;"></div>
                            <span>正在加载目录…${path ? (' 「' + path.substring(0, 80) + (path.length > 80 ? '…' : '') + '」') : ''}</span>
                        </div>
                    </td></tr>`);
            } else if (!loading && existing) {
                existing.remove();
            }
        }
    }

    // ========== 数据加载 ==========
    async function loadFiles(path) {
        _closeMenus();
        _abortPendingFetch();
        const ctrl = new AbortController();
        _currentFetchController = ctrl;
        _setLoading(true, path);
        try {
            const url = path
                ? `/api/files?path=${encodeURIComponent(path)}&limit=0&offset=0`
                : '/api/files?limit=0&offset=0';
            const resp = await fetch(url, { signal: ctrl.signal });
            if (!resp.ok && resp.status !== 400) {
                throw new Error(`请求失败 (HTTP ${resp.status})`);
            }
            const data = await resp.json();
            _currentFetchController = null;
            _setLoading(false, '');
            if (data.error) {
                showToast('错误', data.error, 'danger');
                // 显示错误行到表格
                const tbody = document.getElementById('fileBody');
                if (tbody) {
                    tbody.innerHTML = `<tr><td colspan="${selectMode ? 6 : 5}" style="padding:20px;text-align:center;color:#dc2626;">${_escHtml(data.error)}</td></tr>`;
                }
                return;
            }
            if (data.items == null) {
                showToast('错误', '服务器返回数据异常', 'danger');
                return;
            }
            currentPath = data.current_path_abs || '';
            fileItems = data.items || [];
            selectedPaths.clear();
            // 保存当前类型筛选值，更新下拉框后恢复
            const prevTypeVal = document.getElementById('typeFilter') ? document.getElementById('typeFilter').value : '';
            _updateTypeFilter(fileItems);
            if (prevTypeVal && document.getElementById('typeFilter')) {
                const opt = document.getElementById('typeFilter').querySelector(`option[value="${prevTypeVal}"]`);
                if (opt) document.getElementById('typeFilter').value = prevTypeVal;
            }
            document.getElementById('totalFiles').textContent = data.stats.total_files;
            document.getElementById('totalDirs').textContent = data.stats.total_dirs;
            document.getElementById('totalSize').textContent = data.stats.total_size_str;
            document.getElementById('fileCountBadge').textContent = `${data.total_items != null ? data.total_items : data.items.length} 项`;
            document.getElementById('currentPathDisplay').textContent = currentPath;
            document.getElementById('pathInput').value = currentPath;
            updateBreadcrumb(currentPath);
            // 上级目录按钮
            const parentBtn = document.getElementById('parentDirBtn');
            if (parentBtn) {
                const pData = data.parent_path || '';
                parentPath = pData;
                if (pData) {
                    parentBtn.disabled = false;
                    parentBtn.dataset.target = pData;
                    parentBtn.title = '返回上级目录: ' + pData;
                } else {
                    parentBtn.disabled = true;
                    parentBtn.title = '已是根目录';
                }
            }
            localStorage.setItem(STORAGE_KEY, currentPath);
            applyFiltersAndSort();
            document.getElementById('selectAll').checked = false;
            document.getElementById('selectAll').indeterminate = false;
        } catch (e) {
            _currentFetchController = null;
            _setLoading(false, '');
            if (e && e.name === 'AbortError') {
                // 已切换路径，忽略旧的加载结果
                return;
            }
            showToast('错误', '加载文件列表失败: ' + (e.message || String(e)), 'danger');
        }
    }

    function updateBreadcrumb(absPath) {
        const breadcrumb = document.getElementById('breadcrumb');
        const sysRoot = systemInfo.root || (navigator.platform.toLowerCase().includes('win') ? 'C:\\\\' : '/');
        let parts = (absPath || '').split(/[\\/]/).filter(p => p);
        // 根目录项使用真实系统根路径
        let html = `<li class="breadcrumb-item"><a href="#" data-path="${_escAttr(sysRoot)}"><i class="bi bi-hdd"></i> ${_escHtml(sysRoot)}</a></li>`;
        if (parts.length > 0) {
            let cumulative = '';
            if (navigator.platform.toLowerCase().includes('win')) {
                cumulative = parts[0] + '\\\\';
                html += `<li class="breadcrumb-item"><a href="#" data-path="${_escAttr(cumulative)}">${_escHtml(parts[0])}</a></li>`;
                parts = parts.slice(1);
            } else {
                cumulative = '/';
            }
            for (let i = 0; i < parts.length; i++) {
                cumulative += (i === 0 && cumulative === '/') ? '' : '/';
                cumulative += parts[i];
                const isLast = i === parts.length - 1;
                if (isLast) html += `<li class="breadcrumb-item active">${_escHtml(parts[i])}</li>`;
                else html += `<li class="breadcrumb-item"><a href="#" data-path="${_escAttr(cumulative)}">${_escHtml(parts[i])}</a></li>`;
            }
        }
        breadcrumb.innerHTML = html;
        breadcrumb.querySelectorAll('a[data-path]').forEach(el => {
            el.addEventListener('click', (e) => { e.preventDefault(); navigateTo(el.dataset.path); });
        });
    }

    function navigateTo(path) {
        if (path === 'loading' || path === 'undefined' || path === 'null' || path == null) return;
        // 已经在同一路径加载中，直接取消旧的，启动新的
        if (path === currentPath && _isNavigating) {
            _abortPendingFetch();
            return;
        }
        _abortPendingFetch();
        loadFiles(path || '');
    }

    // ========== 排序与筛选 ==========
    function applyFiltersAndSort() {
        let items = [...fileItems];
        const filterText = document.getElementById('filterInput').value.toLowerCase().trim();
        const typeFilter = document.getElementById('typeFilter').value;
        if (filterText) items = items.filter(item => item.name.toLowerCase().includes(filterText));
        if (typeFilter === '目录') items = items.filter(item => item.is_dir);
        else if (typeFilter) items = items.filter(item => !item.is_dir && (item.type || '').toLowerCase() === typeFilter.toLowerCase());
        items.sort((a, b) => {
            // 第一层分组：目录始终在前
            if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
            let valA, valB;
            switch (sortField) {
                case 'name': valA = a.name.toLowerCase(); valB = b.name.toLowerCase(); break;
                case 'size': valA = Number(a.size || 0); valB = Number(b.size || 0); break;
                case 'type': valA = (a.type || 'zzz').toLowerCase(); valB = (b.type || 'zzz').toLowerCase(); break;
                case 'mtime': valA = a.mtime || ''; valB = b.mtime || ''; break;
                default: valA = a.name.toLowerCase(); valB = b.name.toLowerCase();
            }
            if (valA < valB) return sortAsc ? -1 : 1;
            if (valA > valB) return sortAsc ? 1 : -1;
            // 同值按名称次排序保证稳定
            if (sortField !== 'name') {
                if (a.name.toLowerCase() < b.name.toLowerCase()) return sortAsc ? -1 : 1;
                if (a.name.toLowerCase() > b.name.toLowerCase()) return sortAsc ? 1 : -1;
            }
            return 0;
        });
        document.querySelectorAll('.sort-indicator').forEach(el => el.classList.remove('active'));
        const indicator = document.getElementById(`sort-${sortField}`);
        if (indicator) { indicator.textContent = sortAsc ? '↑' : '↓'; indicator.classList.add('active'); }
        if (viewMode === 'icon') { renderIconView(items); }
        else if (viewMode === 'tree') { renderTreeView(items); }
        else { renderTable(items); }
    }

    // ========== 动态类型筛选 ==========
    function _updateTypeFilter(items) {
        const select = document.getElementById('typeFilter');
        if (!select) return;
        // 收集当前目录下的文件扩展名及数量（排除目录）
        const extCounts = {};
        for (const item of items) {
            if (item.is_dir) continue;
            const ext = (item.type || '').toLowerCase();
            if (!ext || ext === '未知') continue;
            extCounts[ext] = (extCounts[ext] || 0) + 1;
        }
        // 按字母排序
        const exts = Object.keys(extCounts).sort();
        // 构建下拉选项
        let html = '<option value="">所有类型</option>';
        // 目录选项
        const dirCount = items.filter(i => i.is_dir).length;
        if (dirCount > 0) {
            html += `<option value="目录">📁 目录 (${dirCount})</option>`;
        }
        // 文件扩展名选项
        for (const ext of exts) {
            const label = ext;
            const count = extCounts[ext];
            html += `<option value="${ext}">.${label} (${count})</option>`;
        }
        select.innerHTML = html;
        // 在 loadFiles 中恢复之前选中的值
    }

    // ========== 删除 ==========
    async function deleteFiles(paths) {
        if (!paths || paths.length === 0) return;
        const count = paths.length;
        let dirItems = [];
        let fileItems_ = [];
        for (const p of paths) {
            const item = fileItems.find(f => (f.abs_path || '') === p);
            if (item && item.is_dir) {
                dirItems.push(item);
            } else {
                fileItems_.push(p);
            }
        }
        let confirmMsg = '';
        if (dirItems.length > 0) {
            let msg = '[Warning] 以下项目包含文件夹，删除后所有子文件将移入回收站（5秒内可撤销）:\n\n';
            for (const d of dirItems) {
                msg += '[Folder] ' + d.name + (d.size > 0 ? ' (' + formatSize(d.size) + ')' : '') + '\n';
            }
            if (fileItems_.length > 0) msg += '\n[File] 另 ' + fileItems_.length + ' 个文件\n';
            msg += '\n可点击「撤销」恢复，或等待 5 秒后过期。继续？';
            confirmMsg = msg;
        } else {
            confirmMsg = count === 1
                ? '确定要删除 "' + paths[0] + '" 吗？已移入回收站，5秒内可撤销。'
                : '确定要删除选中的 ' + count + ' 个文件吗？已移入回收站，5秒内可撤销。';
        }
        const confirmed = await showConfirm(confirmMsg);
        if (!confirmed) return;
        try {
            const resp = await fetch('/api/delete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ paths })
            });
            const result = await resp.json();
            const deletedCount = (result.deleted || []).length;
            const trashItems = result.trash_items || [];
            if (deletedCount > 0) {
                const errCount = (result.errors || []).length;
                let successMsg = '已删除 ' + deletedCount + ' 个（移入回收站）';
                if (errCount > 0) successMsg += '，' + errCount + ' 个失败';
                // 显示成功提示
                showToast('成功', successMsg, 'success');
                // 显示撤销 Toast（带倒计时）
                if (trashItems.length > 0) {
                    showUndoToast(trashItems);
                }
            }
            if (result.errors && result.errors.length > 0) {
                showToast('警告', '部分删除失败:\n' + result.errors.join('\n'), 'warning');
            }
            selectedPaths.clear();
            loadFiles(currentPath);
        } catch (e) {
            showToast('错误', '删除失败: ' + e.message, 'danger');
        }
    }

    // ========== 5秒回退 Toast ==========
    let _undoTimeouts = [];

    function showUndoToast(trashItems) {
        const container = document.getElementById('undoToastContainer');
        const count = trashItems.length;
        let displayName = '';
        if (count === 1) {
            displayName = trashItems[0].name;
        } else if (count <= 3) {
            displayName = trashItems.map(t => t.name).join('、');
        } else {
            displayName = trashItems[0].name + ' 等 ' + count + ' 项';
        }

        const toast = document.createElement('div');
        toast.className = 'undo-toast';
        toast.innerHTML = `
            <span class="undo-icon">🗑️</span>
            <div class="undo-content">
                <div class="undo-title"><span class="undo-countdown" id="udc_${trashItems[0].id}">5s</span></div>
                <div class="undo-msg">已删除 ${count} 项: ${displayName}</div>
            </div>
            <button class="undo-btn" id="undobtn_${trashItems[0].id}">
                <i class="bi bi-arrow-counterclockwise"></i> 撤销
            </button>
            <div class="undo-progress" style="width:100%"></div>
        `;
        container.appendChild(toast);

        const trashIds = trashItems.map(t => t.id);
        let remaining = 5;
        const countdownEl = toast.querySelector('.undo-countdown');
        const progressEl = toast.querySelector('.undo-progress');
        const undoBtn = toast.querySelector('.undo-btn');

        const undoAction = async () => {
            let allSuccess = true;
            for (const tid of trashIds) {
                try {
                    const r = await fetch('/api/undo-delete', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ trash_id: tid })
                    });
                    const data = await r.json();
                    if (!data.success) { allSuccess = false; }
                } catch(e) { allSuccess = false; }
            }
            if (allSuccess) {
                showToast('恢复成功', '已恢复 ' + count + ' 项到原位置', 'success');
                loadFiles(currentPath);
                loadDeleteHistoryCount();
            } else {
                showToast('恢复失败', '部分项目恢复失败', 'warning');
            }
            toast.remove();
            clearInterval(intervalId);
        };

        undoBtn.addEventListener('click', () => {
            undoAction();
        });

        const intervalId = setInterval(() => {
            remaining -= 0.1;
            if (remaining <= 0) {
                clearInterval(intervalId);
                toast.remove();
                return;
            }
            const pct = (remaining / 5) * 100;
            progressEl.style.width = pct + '%';
            const sec = Math.ceil(remaining);
            countdownEl.textContent = sec + 's';
            countdownEl.style.background = sec <= 2 ? '#dc2626' : '#fee2e2';
            countdownEl.style.color = sec <= 2 ? 'white' : '#dc2626';
        }, 100);

        // 限制最多显示 3 个 toast
        while (container.children.length > 3) {
            container.firstChild.remove();
        }
    }

    // ========== 文件编辑器 ==========
    let _editorInstance = null;
    let _simpleMDE = null;
    let _editorFilePath = '';
    let _editorIsMarkdown = false;
    let _editorPreviewTimer = null;

    function _getEditorMode(ext) {
        const map = {
            'js':'javascript','ts':'javascript','jsx':'javascript','tsx':'javascript',
            'html':'htmlmixed','htm':'htmlmixed','css':'css','scss':'css','less':'css',
            'json':'javascript','xml':'xml','svg':'xml',
            'py':'python','rb':'ruby','lua':'lua','sql':'sql','go':'go',
            'rs':'clike','c':'clike','cpp':'clike','h':'clike','java':'clike','cs':'clike',
            'php':'php','md':'markdown','yml':'yaml','yaml':'yaml',
            'ini':'ini','cfg':'ini','conf':'ini',
            'properties':'properties','sh':'shell','bash':'shell','bat':'shell','ps1':'shell',
            'txt':'text','log':'text','conf':'text','env':'text',
        };
        return map[ext] || 'text/plain';
    }

    function _renderMarkdown(text) {
        // 简易 Markdown 渲染器
        let html = text;
        // 代码块
        html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
            const langAttr = lang ? ` class="language-${lang}"` : '';
            return `<pre><code${langAttr}>${_escHtml(code.replace(/\n$/, ''))}</code></pre>`;
        });
        // 行内代码
        html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
        // 标题
        html = html.replace(/^######\s+(.+)$/gm, '<h6>$1</h6>');
        html = html.replace(/^#####\s+(.+)$/gm, '<h5>$1</h5>');
        html = html.replace(/^####\s+(.+)$/gm, '<h4>$1</h4>');
        html = html.replace(/^###\s+(.+)$/gm, '<h3>$1</h3>');
        html = html.replace(/^##\s+(.+)$/gm, '<h2>$1</h2>');
        html = html.replace(/^#\s+(.+)$/gm, '<h1>$1</h1>');
        // 粗体和斜体
        html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
        html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
        // 引用
        html = html.replace(/^>\s+(.+)$/gm, '<blockquote>$1</blockquote>');
        // 分割线
        html = html.replace(/^---$/gm, '<hr>');
        // 图片
        html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1">');
        // 链接
        html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
        // 无序列表
        html = html.replace(/^(\s*)[-*+]\s+(.+)$/gm, (_, indent, content) => {
            return `<li>${content}</li>`;
        });
        // 有序列表
        html = html.replace(/^(\s*)\d+\.\s+(.+)$/gm, (_, indent, content) => {
            return `<li>${content}</li>`;
        });
        // 包裹连续的 li 到 ul
        html = html.replace(/((?:<li>.+<\/li>\n?)+)/g, '<ul>$1</ul>');
        // 段落：连续非空白行
        html = html.replace(/^(?!<[uh]|<hr|<h|<pre|<blockquote|<img|<a|<strong|<em|<code)(.+)$/gm, '<p>$1</p>');
        // 任务列表
        html = html.replace(/<li>\[(\s|x)\]\s+(.+)<\/li>/g, '<li class="task-list-item"><input type="checkbox" disabled$1checked>$2</li>');
        return html;
    }

    function _updateEditorPreview() {
        if (!_editorIsMarkdown) return;
        const previewEl = document.getElementById('editorPreviewRender');
        const editor = _editorInstance;
        if (!previewEl || !editor) return;
        if (_editorPreviewTimer) clearTimeout(_editorPreviewTimer);
        _editorPreviewTimer = setTimeout(() => {
            const text = editor.getValue();
            previewEl.innerHTML = _renderMarkdown(text);
        }, 300);
    }

    function openEditor(filePath, isNewFile) {
        const container = document.getElementById('editorContainer');
        const ext = (filePath.split('.').pop() || '').toLowerCase();
        _editorIsMarkdown = ext === 'md';
        _editorFilePath = filePath;
        const fileName = filePath.split('/').pop() || (filePath.split('\\').pop() || '未命名');
        const displayName = isNewFile ? (fileName + '（新文件）') : fileName;
        const saveBtnId = isNewFile ? 'edSaveBtnNew' : 'edSaveBtn';

        container.innerHTML = `
            <div class="editor-overlay">
                <div class="editor-modal">
                    <div class="editor-header">
                        <div class="ed-title">
                            <div class="ed-name-part">
                                <i class="bi bi-pencil-square"></i>
                                <span class="ed-filename">${displayName}</span>
                            </div>
                            <div class="ed-actions">
                                <span class="ed-status" id="edStatus">未保存</span>
                                <button class="btn" id="edSearchBtn" style="padding:5px 10px;border-radius:7px;font-size:0.78rem;border:none;cursor:pointer;background:#475569;color:#e2e8f0;"><i class="bi bi-search"></i> 查找</button>
                                <button class="btn ed-save-btn" id="${saveBtnId}"><i class="bi bi-check-lg"></i> 保存</button>
                                <button class="btn ed-close-btn" id="edCloseBtn"><i class="bi bi-x-lg"></i></button>
                            </div>
                        </div>
                        <span class="ed-path">${filePath}</span>
                    </div>
                    <div class="editor-body">
                                                 ${_editorIsMarkdown ? `
                             <div class="editor-panel editor-full">
                                 <div class="ed-search-panel" id="edSearchPanel">
                                     <div class="ed-search-row">
                                         <span class="ed-search-label"><i class="bi bi-search"></i></span>
                                         <input type="text" class="ed-search-input" id="edSearchInput" placeholder="查找..." />
                                         <span class="ed-search-info" id="edSearchInfo">--</span>
                                         <button class="ed-search-btn" id="edPrevBtn" title="上一个"><i class="bi bi-chevron-up"></i></button>
                                         <button class="ed-search-btn" id="edNextBtn" title="下一个"><i class="bi bi-chevron-down"></i></button>
                                         <button class="ed-search-btn" id="edToggleReplaceBtn" title="替换"><i class="bi bi-arrow-left-right"></i></button>
                                         <button class="ed-search-btn danger" id="edCloseSearchBtn" title="关闭"><i class="bi bi-x-lg"></i></button>
                                     </div>
                                     <div class="ed-search-row" id="edReplaceRow" style="display:none;">
                                         <span class="ed-search-label"><i class="bi bi-pencil"></i></span>
                                         <input type="text" class="ed-search-input" id="edReplaceInput" placeholder="替换为..." />
                                         <button class="ed-search-btn" id="edReplaceOneBtn"><i class="bi bi-pencil"></i> 替换</button>
                                         <button class="ed-search-btn" id="edReplaceAllBtn"><i class="bi bi-pencil-square"></i> 全部</button>
                                     </div>
                                     <div class="ed-search-checks">
                                         <label><input type="checkbox" id="edMatchCase" /> 区分大小写</label>
                                         <label><input type="checkbox" id="edWholeWord" /> 全字匹配</label>
                                     </div>
                                 </div>
                                 <div class="editor-panel-label"><i class="bi bi-code-slash"></i> Markdown 编辑器（SimpleMDE）</div>
                                 <div class="ed-md-wrapper" style="flex:1;min-height:0;display:flex;flex-direction:column;">
                                     <textarea id="editorCodeMirror" class="ed-md-textarea" style="width:100%;height:100%;"></textarea>
                                 </div>
                             </div>
                         ` : `
                            <div class="editor-panel editor-full">
                                <div class="ed-search-panel" id="edSearchPanel">
                                    <div class="ed-search-row">
                                        <span class="ed-search-label"><i class="bi bi-search"></i></span>
                                        <input type="text" class="ed-search-input" id="edSearchInput" placeholder="查找..." />
                                        <span class="ed-search-info" id="edSearchInfo">--</span>
                                        <button class="ed-search-btn" id="edPrevBtn" title="上一个"><i class="bi bi-chevron-up"></i></button>
                                        <button class="ed-search-btn" id="edNextBtn" title="下一个"><i class="bi bi-chevron-down"></i></button>
                                        <button class="ed-search-btn" id="edToggleReplaceBtn" title="替换"><i class="bi bi-arrow-left-right"></i></button>
                                        <button class="ed-search-btn danger" id="edCloseSearchBtn" title="关闭"><i class="bi bi-x-lg"></i></button>
                                    </div>
                                    <div class="ed-search-row" id="edReplaceRow" style="display:none;">
                                        <span class="ed-search-label"><i class="bi bi-pencil"></i></span>
                                        <input type="text" class="ed-search-input" id="edReplaceInput" placeholder="替换为..." />
                                        <button class="ed-search-btn" id="edReplaceOneBtn"><i class="bi bi-pencil"></i> 替换</button>
                                        <button class="ed-search-btn" id="edReplaceAllBtn"><i class="bi bi-pencil-square"></i> 全部</button>
                                    </div>
                                    <div class="ed-search-checks">
                                        <label><input type="checkbox" id="edMatchCase" /> 区分大小写</label>
                                        <label><input type="checkbox" id="edWholeWord" /> 全字匹配</label>
                                    </div>
                                </div>
                                <div class="editor-panel-label"><i class="bi bi-code-slash"></i> 编辑 ${ext ? '.' + ext : '文件'}</div>
                                <div id="editorCodeMirror" style="flex:1;min-height:0;"></div>
                            </div>
                        `}
                    </div>
                </div>
            </div>
        `;

        container.querySelector('.editor-overlay').addEventListener('click', (e) => {
            if (e.target.classList.contains('editor-overlay')) closeEditor();
        });
        document.getElementById('edCloseBtn').addEventListener('click', closeEditor);

        // 查找面板事件绑定
        const searchPanel = document.getElementById('edSearchPanel');
        const searchInput = document.getElementById('edSearchInput');
        const replaceInput = document.getElementById('edReplaceInput');
        const _searchVisible = () => searchPanel.classList.contains('visible');

        document.getElementById('edSearchBtn').addEventListener('click', () => _openSearchPanel(searchPanel));
        document.getElementById('edCloseSearchBtn').addEventListener('click', () => _closeSearchPanel(searchPanel));
        document.getElementById('edPrevBtn').addEventListener('click', () => { _findInEditor(false); searchInput.focus(); });
        document.getElementById('edNextBtn').addEventListener('click', () => { _findInEditor(true); searchInput.focus(); });
        document.getElementById('edToggleReplaceBtn').addEventListener('click', () => {
            const row = document.getElementById('edReplaceRow');
            const v = row.style.display !== 'none';
            row.style.display = v ? 'none' : 'flex';
            if (!v) replaceInput.focus();
        });
        document.getElementById('edReplaceOneBtn').addEventListener('click', () => { _replaceInEditor(false); searchInput.focus(); });
        document.getElementById('edReplaceAllBtn').addEventListener('click', () => { _replaceInEditor(true); searchInput.focus(); });
        searchInput.addEventListener('input', () => {
            const val = searchInput.value;
            if (!val) { _clearSearchHighlights(); _updateSearchInfo('', 0); return; }
            if (_editorReady() && _editorInstance.getValue().length > 0) {
                _doFind(val);
            } else {
                _pendingSearchText = val;
                _updateSearchInfo('等待内容...', 0);
                _editorReadyPoll();
            }
        });
        searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowDown') { _findInEditor(true); e.preventDefault(); }
            else if (e.key === 'ArrowUp') { _findInEditor(false); e.preventDefault(); }
            else if (e.key === 'Enter') { _findInEditor(!e.shiftKey); e.preventDefault(); }
            else if (e.key === 'Escape') { _closeSearchPanel(searchPanel); }
        });
        replaceInput.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowDown') { _findInEditor(true); e.preventDefault(); }
            else if (e.key === 'ArrowUp') { _findInEditor(false); e.preventDefault(); }
            else if (e.key === 'Enter' && e.ctrlKey && !e.shiftKey) { _replaceInEditor(false); e.preventDefault(); }
            else if (e.key === 'Enter' && e.ctrlKey && e.shiftKey) { _replaceInEditor(true); e.preventDefault(); }
            else if (e.key === 'Escape') { _closeSearchPanel(searchPanel); }
        });

        // 全局快捷键（编辑器内时监听）
        document.addEventListener('keydown', function onEdKey(e) {
            const isSearchFocused = document.activeElement === searchInput || document.activeElement === replaceInput;

            if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                e.preventDefault(); _saveEditorContent();
            } else if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
                e.preventDefault(); _openSearchPanel(searchPanel);
            } else if ((e.ctrlKey || e.metaKey) && e.key === 'h') {
                e.preventDefault(); _openSearchPanel(searchPanel, true);
            } else if (e.key === 'Escape') {
                if (_searchVisible()) _closeSearchPanel(searchPanel);
                else { closeEditor(); document.removeEventListener('keydown', onEdKey); }
            } else if ((e.ctrlKey || e.metaKey) && e.key === 'l') {
                e.preventDefault(); _goToLine();
            } else if (isSearchFocused && _searchMarkers.length > 0) {
                // 仅搜索框有焦点时拦截方向键
                if (e.key === 'ArrowDown') { _findInEditor(true); e.preventDefault(); }
                else if (e.key === 'ArrowUp') { _findInEditor(false); e.preventDefault(); }
                else if (e.key === 'Enter') {
                    _findInEditor(e.shiftKey ? false : true); e.preventDefault();
                }
            }
        });

        // 初始化 CodeMirror
        const mode = _getEditorMode(ext);
        const editorEl = document.getElementById('editorCodeMirror');

        if (isNewFile) {
            // 新文件：空编辑器，立即初始化
            _initCodeMirror(editorEl, '', mode);
        } else {
            // 已有文件：立即初始化空编辑器，用户可立即操作
            _initCodeMirror(editorEl, '', mode);
            // 异步加载内容后更新
            fetch(`/api/preview?path=${encodeURIComponent(filePath)}`)
                .then(r => r.json())
                .then(data => {
                    let content = '';
                    if (data.error) {
                        showToast('错误', '无法加载文件: ' + data.error, 'danger');
                        closeEditor();
                        return;
                    }
                    if (data.type === 'text') {
                        const bytes = Uint8Array.from(atob(data.content), c => c.charCodeAt(0));
                        content = new TextDecoder('utf-8').decode(bytes);
                    } else {
                        showToast('提示', '该文件类型不支持文本编辑', 'warning');
                        closeEditor();
                        return;
                    }
                    if (_simpleMDE) {
                        _simpleMDE.value(content);
                    } else if (_editorInstance) {
                        _editorInstance.setValue(content);
                    }
                    if (_editorIsMarkdown && _simpleMDE) {
                        // SimpleMDE 自动渲染预览
                    } else if (_editorIsMarkdown && _editorInstance) {
                        _updateEditorPreview();
                    }
                    // 文件内容已加载，触发待搜索
                    if (_pendingSearchText && _editorInstance && _editorInstance.getValue().length > 0) {
                        _doFind(_pendingSearchText);
                        _pendingSearchText = '';
                        if (_readyPollTimer) { clearInterval(_readyPollTimer); _readyPollTimer = null; }
                    }
                })
                .catch(() => {
                    showToast('错误', '文件加载失败', 'danger');
                    closeEditor();
                });
        }

        document.getElementById(saveBtnId).addEventListener('click', () => _saveEditorContent(isNewFile));
    }

    function _initCodeMirror(element, initialContent, mode) {
        try {
            if (_editorInstance) {
                _editorInstance.toTextArea && _editorInstance.toTextArea();
                _editorInstance = null;
            }
            if (_simpleMDE) {
                try { _simpleMDE.toTextArea(); } catch(e){}
                _simpleMDE = null;
            }
            if (typeof CodeMirror === 'undefined') {
                element.innerHTML = '<div class="cm-placeholder"><i class="bi bi-hourglass-split"></i> CodeMirror 未加载</div>';
                return;
            }
            if (_editorIsMarkdown) {
                // Markdown: use SimpleMDE if loaded, otherwise fall back to plain CodeMirror
                if (typeof SimpleMDE !== 'undefined') {
                    _simpleMDE = new SimpleMDE({
                        element: element,
                        spellChecker: false,
                        status: false,
                        autosave: { enabled: false },
                        placeholder: '在此输入 Markdown 内容...',
                        toolbar: [
                            'bold', 'italic', 'heading', '|',
                            'quote', 'unordered-list', 'ordered-list', '|',
                            'link', 'image', 'code', 'table', 'hr', '|',
                            'preview', 'side-by-side', 'fullscreen', '|',
                            'guide'
                        ]
                    });
                    _editorInstance = _simpleMDE.codemirror;
                    if (_editorInstance) _editorInstance.setOption('theme', 'material-darker');
                    if (_pendingSearchText && _editorInstance.getValue().length > 0) {
                        _doFind(_pendingSearchText);
                        _pendingSearchText = '';
                        if (_readyPollTimer) { clearInterval(_readyPollTimer); _readyPollTimer = null; }
                    }
                    return;
                } else {
                    // SimpleMDE 尚未加载，用普通 CodeMirror 占位
                    // 创建 wrapper div 供 CodeMirror 使用
                    const wrapper = document.createElement('div');
                    wrapper.style.cssText = 'width:100%;height:100%;position:absolute;top:0;left:0;';
                    element.style.display = 'none';
                    element.parentNode.insertBefore(wrapper, element);
                    _editorInstance = CodeMirror(wrapper, {
                        value: initialContent,
                        mode: 'markdown',
                        theme: 'material-darker',
                        lineNumbers: true,
                        autoRefresh: true,
                        lineWrapping: true,
                        tabSize: 4,
                        indentUnit: 4,
                    });
                    if (!window._simpleMDEReady) {
                        window._simpleMDEReady = () => {
                            if (_editorInstance && _editorIsMarkdown) {
                                try {
                                    if (_editorInstance) { _editorInstance.toTextArea && _editorInstance.toTextArea(); _editorInstance = null; }
                                    _simpleMDE = new SimpleMDE({
                                        element: element,
                                        spellChecker: false,
                                        status: false,
                                        autosave: { enabled: false },
                                        toolbar: [
                                            'bold', 'italic', 'heading', '|',
                                            'quote', 'unordered-list', 'ordered-list', '|',
                                            'link', 'image', 'code', 'table', 'hr', '|',
                                            'preview', 'side-by-side', 'fullscreen', '|',
                                            'guide'
                                        ]
                                    });
                                    _editorInstance = _simpleMDE.codemirror;
                                    if (_editorInstance) _editorInstance.setOption('theme', 'material-darker');
                                    wrapper.remove();
                                } catch(e) { console.error('SimpleMDE upgrade failed:', e); }
                            }
                        };
                        window.addEventListener('simplemde_loaded', () => {
                            if (window._simpleMDEReady) window._simpleMDEReady();
                        }, { once: true });
                    }
                    return;
                }
            }
            _editorInstance = CodeMirror(element, {
                value: initialContent,
                mode: mode,
                theme: 'material-darker',
                lineNumbers: true,
                autoRefresh: true,
                lineWrapping: true,
                tabSize: 4,
                indentUnit: 4,
            });
            if (_editorIsMarkdown) {
                _editorInstance.on('change', () => {
                    _updateEditorPreview();
                    if (_pendingSearchText) {
                        _doFind(_pendingSearchText);
                        _pendingSearchText = '';
                        if (_readyPollTimer) { clearInterval(_readyPollTimer); _readyPollTimer = null; }
                    }
                });
            } else {
                _editorInstance.on('change', () => {
                    if (_pendingSearchText) {
                        _doFind(_pendingSearchText);
                        _pendingSearchText = '';
                        if (_readyPollTimer) { clearInterval(_readyPollTimer); _readyPollTimer = null; }
                    }
                });
            }
            // 编辑器就绪，触发待搜索（如果有内容）
            if (_pendingSearchText && _editorInstance.getValue().length > 0) {
                _doFind(_pendingSearchText);
                _pendingSearchText = '';
                if (_readyPollTimer) { clearInterval(_readyPollTimer); _readyPollTimer = null; }
            }
        } catch(e) {
            console.error('_initCodeMirror failed:', e);
            element.innerHTML = '<div class="cm-placeholder"><i class="bi bi-exclamation-circle"></i> 初始化失败: ' + e.message + '</div>';
        }
    }

    function _saveEditorContent(isNewFile) {
        if (!_editorInstance && !_simpleMDE) { showToast('提示', '编辑器未初始化', 'warning'); return; }
        const content = _simpleMDE ? _simpleMDE.value() : (_editorInstance ? _editorInstance.getValue() : '');

        // 新文件：文件已由后端创建（空文件），现在只需保存编辑器内容
        // 已有文件：直接覆盖保存
        const btn = document.querySelector('.ed-save-btn');
        if (btn) { btn.disabled = true; btn.innerHTML = '<i class="bi bi-hourglass-split"></i> 保存中...'; }
        const statusEl = document.getElementById('edStatus');
        if (statusEl) statusEl.textContent = '保存中...';

        fetch('/api/files/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: _editorFilePath, content })
        })
            .then(r => r.json())
            .then(data => {
                if (data.error) {
                    showToast('错误', '保存失败: ' + data.error, 'danger');
                    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="bi bi-check-lg"></i> 保存'; }
                    if (statusEl) statusEl.textContent = '保存失败';
                    return;
                }
                showToast('成功', isNewFile ? ('文件已创建并保存: ' + _editorFilePath) : '已保存', 'success');
                if (statusEl) { statusEl.textContent = '已保存 ✓'; statusEl.style.color = '#10b981'; }
                if (btn) { btn.disabled = false; btn.innerHTML = '<i class="bi bi-check-lg"></i> 保存'; }
                loadFiles(currentPath);
            })
            .catch(e => {
                showToast('错误', '保存失败: ' + e.message, 'danger');
                if (btn) { btn.disabled = false; btn.innerHTML = '<i class="bi bi-check-lg"></i> 保存'; }
                if (statusEl) statusEl.textContent = '保存失败';
            });
    }

    function closeEditor() {
        if (_editorPreviewTimer) { clearTimeout(_editorPreviewTimer); _editorPreviewTimer = null; }
        _clearSearchHighlights();
        if (_simpleMDE) { try { _simpleMDE.toTextArea(); } catch(e){} _simpleMDE = null; }
        if (_editorInstance) { _editorInstance.toTextArea && _editorInstance.toTextArea(); _editorInstance = null; }
        const container = document.getElementById('editorContainer');
        container.innerHTML = '';
    }

    // ========== 编辑器查找/替换 ==========
    let _searchMarkers = [];
    let _searchCurrentMarker = null;
    let _searchCurrentIdx = 0;
    let _searchTotalCount = 0;
    let _pendingSearchText = '';
    let _readyPollTimer = null;

    function _editorReady() {
        return _editorInstance && typeof _editorInstance.getValue === 'function';
    }
    function _editorReadyPoll() {
        if (_readyPollTimer) return;
        let tries = 0;
        _readyPollTimer = setInterval(() => {
            tries++;
            if (_editorReady() && _editorInstance.getValue().length > 0) {
                clearInterval(_readyPollTimer);
                _readyPollTimer = null;
                if (_pendingSearchText) _doFind(_pendingSearchText);
            } else if (tries > 50) {
                clearInterval(_readyPollTimer);
                _readyPollTimer = null;
            }
        }, 100);
    }

    function _clearSearchHighlights() {
        for (const s of _searchMarkers) { try { if (s.marker) s.marker.clear(); } catch(e){} }
        _searchMarkers = [];
        _searchCurrentMarker = null;
        _searchCurrentIdx = 0;
        _searchTotalCount = 0;
    }

    function _buildSearchRegex(text, wholeWord) {
        if (!text) return null;
        const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const pattern = wholeWord ? '\\b' + escaped + '\\b' : escaped;
        const flags = 'g';
        return new RegExp(pattern, flags);
    }

    function _doFind(text) {
        // 编辑器未就绪：记录待搜索，轮询重试
        if (!_editorReady()) {
            _pendingSearchText = text;
            _editorReadyPoll();
            _updateSearchInfo('加载...', 0);
            return;
        }
        const editor = _editorInstance;
        _clearSearchHighlights();
        if (!text || !text.trim()) {
            _updateSearchInfo('', 0);
            return;
        }
        _pendingSearchText = text;

        const content = editor.getValue();
        // 内容为空（等待文件加载），记录待搜索并轮询
        if (!content || content.length === 0) {
            _updateSearchInfo('等待内容...', 0);
            _editorReadyPoll();
            return;
        }

        const matchCase = document.getElementById('edMatchCase').checked;
        const matchWhole = document.getElementById('edWholeWord').checked;

        // 手动实现搜索：getValue + posFromIndex + markText
        const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const pattern = matchWhole ? '\\b' + escaped + '\\b' : escaped;
        const flags = 'g' + (matchCase ? '' : 'i');
        const regex = new RegExp(pattern, flags);
        const matches = [];
        let m;
        while ((m = regex.exec(content)) !== null) {
            matches.push({ fromIdx: m.index, toIdx: m.index + m[0].length });
        }

        if (matches.length === 0) {
            _updateSearchInfo('未找到', 0);
            return;
        }

        // 高亮所有匹配
        for (const match of matches) {
            const from = editor.posFromIndex(match.fromIdx);
            const to = editor.posFromIndex(match.toIdx);
            const marker = editor.markText(from, to, { className: 'cm-search-match' });
            _searchMarkers.push({ from, to, marker });
        }

        _searchTotalCount = matches.length;
        _searchCurrentIdx = 1;
        _searchCurrentMarker = _searchMarkers[0];

        // 第一个为当前光标高亮（橙色）
        const first = _searchMarkers[0];
        first.marker.clear();
        _searchMarkers[0] = { from: first.from, to: first.to, marker: editor.markText(first.from, first.to, { className: 'cm-search-match-cursor' }) };
        editor.scrollIntoView(first.from, 50);
        _updateSearchInfo('1/' + matches.length, 1);
    }

    function _findInEditor(forward) {
        const si = document.getElementById('edSearchInput');
        if (!_editorReady() || !si || !si.value) return;

        // 如果还没搜索过（或内容为空），先执行搜索
        if (_searchMarkers.length === 0) {
            _doFind(si.value);
            if (_searchMarkers.length === 0) return;
        }

        const editor = _editorInstance;

        // 恢复上一个当前为普通高亮
        if (_searchCurrentIdx) {
            const prev = _searchMarkers[_searchCurrentIdx - 1];
            if (prev) {
                prev.marker.clear();
                _searchMarkers[_searchCurrentIdx - 1] = { from: prev.from, to: prev.to, marker: editor.markText(prev.from, prev.to, { className: 'cm-search-match' }) };
            }
        }

        _searchCurrentIdx += (forward ? 1 : -1);
        if (_searchCurrentIdx > _searchMarkers.length) _searchCurrentIdx = 1;
        if (_searchCurrentIdx < 1) _searchCurrentIdx = _searchMarkers.length;

        const cur = _searchMarkers[_searchCurrentIdx - 1];
        if (!cur) return;
        cur.marker.clear();
        _searchMarkers[_searchCurrentIdx - 1] = { from: cur.from, to: cur.to, marker: editor.markText(cur.from, cur.to, { className: 'cm-search-match-cursor' }) };
        _searchCurrentMarker = _searchMarkers[_searchCurrentIdx - 1];
        editor.scrollIntoView(_searchCurrentMarker.from, 50);
        _updateSearchInfo(_searchCurrentIdx + '/' + _searchMarkers.length, _searchCurrentIdx);
    }

    function _replaceInEditor(replaceAll) {
        if (!_editorReady()) { showToast('提示', '编辑器未就绪', 'warning'); return; }
        const editor = _editorInstance;
        const searchInput = document.getElementById('edSearchInput');
        const replaceInput = document.getElementById('edReplaceInput');
        if (!editor || !searchInput.value) { showToast('提示', '请输入查找内容', 'warning'); searchInput.focus(); return; }

        const matchCase = document.getElementById('edMatchCase').checked;
        const matchWhole = document.getElementById('edWholeWord').checked;
        const findText = searchInput.value;
        const replaceText = replaceInput.value;

        if (replaceAll) {
            const escaped = findText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const pattern = matchWhole ? '\\b' + escaped + '\\b' : escaped;
            const flags = 'g' + (matchCase ? '' : 'i');
            const regex = new RegExp(pattern, flags);
            const newContent = editor.getValue().replace(regex, replaceText);
            editor.setValue(newContent);
            if (_editorIsMarkdown) _updateEditorPreview();
            _doFind(findText);
            _updateSearchInfo('全部替换完成', _searchMarkers.length);
            showToast('成功', '已替换所有匹配项', 'success');
        } else {
            if (_searchMarkers.length === 0) { showToast('提示', '未找到匹配', 'warning'); searchInput.focus(); return; }
            const cur = _searchMarkers[_searchCurrentIdx - 1];
            if (!cur) return;
            editor.replaceRange(replaceText, cur.from, cur.to);
            _doFind(findText);
            if (_editorIsMarkdown) _updateEditorPreview();
        }
    }

    function _replaceAllWholeWord(text, findText, replaceText, matchCase) {
        const escaped = findText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const flags = 'g' + (matchCase ? '' : 'i');
        const regex = new RegExp('\\b' + escaped + '\\b', flags);
        return text.replace(regex, replaceText);
    }

    function _updateSearchInfo(text, current) {
        const el = document.getElementById('edSearchInfo');
        if (!el) return;
        el.textContent = text;
        el.className = 'ed-search-info' + (current === 0 ? ' error' : '');
    }

    function _openSearchPanel(panel, showReplace) {
        if (!panel) return;
        panel.classList.add('visible');
        const searchInput = document.getElementById('edSearchInput');
        const infoEl = document.getElementById('edSearchInfo');
        if (infoEl) infoEl.textContent = '--';

        if (_editorReady()) {
            const sel = _editorInstance.getSelection();
            if (sel) { searchInput.value = sel; searchInput.select(); }
        }
        searchInput.focus();

        if (showReplace) {
            document.getElementById('edReplaceRow').style.display = 'flex';
            document.getElementById('edReplaceInput').focus();
        }

        if (searchInput.value) {
            if (_editorReady() && _editorInstance.getValue().length > 0) {
                _doFind(searchInput.value);
            } else {
                _pendingSearchText = searchInput.value;
                _updateSearchInfo('等待内容...', 0);
                _editorReadyPoll();
            }
        }
    }

    function _closeSearchPanel(panel) {
        if (!panel) return;
        panel.classList.remove('visible');
        _clearSearchHighlights();
        if (_editorInstance) _editorInstance.focus();
    }
    function _goToLine() {
        const editor = _editorInstance;
        if (!editor) return;
        const total = editor.lineCount();
        const overlay = document.createElement('div');
        overlay.className = 'custom-modal-overlay';
        overlay.innerHTML = `
            <div class="custom-modal" style="max-width:320px;padding:20px 24px;">
                <div class="modal-title"><i class="bi bi-arrow-down-up"></i> 跳转到行</div>
                <div class="modal-body">
                    <input type="number" class="form-control" id="edGoLineInput" min="1" max="${total}" style="font-family:monospace;font-size:0.85rem;" />
                    <span style="font-size:0.72rem;color:#94a3b8;margin-top:4px;display:block;">共 ${total} 行</span>
                </div>
                <div class="modal-footer">
                    <button class="btn btn-cancel" id="edGoCancel">取消</button>
                    <button class="btn btn-ok" id="edGoOk">跳转</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);
        const input = overlay.querySelector('#edGoLineInput');
        input.focus(); input.select();
        const jump = () => {
            const line = parseInt(input.value, 10);
            if (line >= 1 && line <= total) {
                editor.setCursor({line: line - 1, ch: 0});
                editor.scrollIntoView({line: line - 1, ch: 0}, 80);
                overlay.remove();
            }
        };
        overlay.querySelector('#edGoOk').addEventListener('click', jump);
        overlay.querySelector('#edGoCancel').addEventListener('click', () => overlay.remove());
        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') jump(); if (e.key === 'Escape') overlay.remove(); });
    }

    // ========== 新建文件/文件夹 ==========
    function showNewFileDialog(isDir) {
        const defaultName = isDir ? '新文件夹' : '新文件.txt';
        const placeholder = isDir ? '输入文件夹名称' : '输入文件名（如 note.txt）';
        const icon = isDir ? '📁' : '📄';
        // 收集当前目录下已有的文件名
        const existingNames = new Set();
        for (const item of fileItems) {
            existingNames.add(item.name);
        }
        showInputDialog(icon + ' 新建' + (isDir ? '文件夹' : '文件'), placeholder, defaultName, (name) => {
            if (!name || !name.trim()) return;
            name = name.trim();
            if (!isDir && !name.includes('.')) {
                name += '.txt';
            }
            createFileOrDir(name, isDir);
        }, (name) => {
            if (!name || !name.trim()) {
                return { valid: false, message: '名称不能为空' };
            }
            const cleanName = isDir && !name.includes('.') ? name : (name.includes('.') ? name : (name + (isDir ? '' : '.txt')));
            const checkName = isDir && !cleanName.includes('.') ? name.trim() : cleanName;
            if (existingNames.has(checkName)) {
                return { valid: false, message: '「' + checkName + '」已存在，请换一个名称' };
            }
            return { valid: true };
        });
    }

    function createFileOrDir(name, isDir) {
        fetch('/api/files/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: currentPath, name, is_dir: isDir })
        })
            .then(r => r.json())
            .then(data => {
                if (data.error) {
                    showToast('错误', data.error, 'danger');
                    return;
                }
                showToast('成功', (isDir ? '文件夹 ' : '文件 ') + name + ' 已创建', 'success');
                loadFiles(currentPath);
                // 如果是新文件，直接打开编辑器
                if (!isDir) {
                    openEditor(data.path, true);
                }
            })
            .catch(e => showToast('错误', e.message, 'danger'));
    }

    // ========== 自定义弹窗 ==========
    const _toastIcons = { success: '✅', danger: '❌', warning: '⚠️', info: 'ℹ️' };

    function showToast(title, message, type = 'info') {
        const container = document.getElementById('customToastContainer');
        const icon = _toastIcons[type] || _toastIcons.info;
        const toast = document.createElement('div');
        toast.className = `custom-toast ${type}`;
        toast.innerHTML = `
            <span class="toast-icon">${icon}</span>
            <div>
                <strong>${title}</strong>
                <div style="margin-top:2px;opacity:0.9;font-size:0.85rem;">${message.replace(/\n/g, '<br>')}</div>
            </div>
        `;
        container.appendChild(toast);
        setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transform = 'translateX(-50%) translateY(-8px)';
            toast.style.transition = 'all 0.25s ease';
            setTimeout(() => toast.remove(), 250);
        }, 3000);
    }

    function showConfirm(message) {
        return new Promise((resolve) => {
            const container = document.getElementById('customModalContainer');
            const overlay = document.createElement('div');
            overlay.className = 'custom-modal-overlay';
            overlay.innerHTML = `
                <div class="custom-modal">
                    <div class="modal-title">⚠️ 确认操作</div>
                    <div class="modal-body">${message}</div>
                    <div class="modal-footer">
                        <button class="btn btn-cancel" data-result="false">取消</button>
                        <button class="btn btn-confirm" data-result="true">确认删除</button>
                    </div>
                </div>
            `;
            container.appendChild(overlay);
            const close = () => {
                if (document.body.contains(overlay)) overlay.remove();
            };
            overlay.querySelectorAll('[data-result]').forEach(btn => {
                btn.addEventListener('click', () => {
                    close();
                    resolve(btn.dataset.result === 'true');
                });
            });
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) { close(); resolve(false); }
            });
            document.addEventListener('keydown', function onKey(e) {
                if (e.key === 'Escape') { close(); resolve(false); document.removeEventListener('keydown', onKey); }
            });
        });
    }

    // ========== 事件绑定 ==========
    function initEvents() {
        document.getElementById('refreshBtn').addEventListener('click', () => loadFiles(currentPath));
        // 上级目录按钮
        document.getElementById('parentDirBtn').addEventListener('click', () => {
            const target = document.getElementById('parentDirBtn').dataset.target;
            if (target) navigateTo(target);
        });
        document.getElementById('selectAll').addEventListener('change', (e) => {
            const checked = e.target.checked;
            document.querySelectorAll('.item-checkbox:not(.parent-cb)').forEach(el => {
                el.checked = checked;
                const path = el.dataset.path;
                if (checked) selectedPaths.add(path);
                else selectedPaths.delete(path);
                el.closest('tr').classList.toggle('selected', checked);
            });
            updateSelectedCount();
            updateBatchDeleteBtn();
        });
        document.getElementById('batchDeleteBtn').addEventListener('click', () => deleteFiles(Array.from(selectedPaths)));
        document.getElementById('batchCompressBtn').addEventListener('click', () => {
            if (selectedPaths.size === 0) return;
            const paths = Array.from(selectedPaths);
            // 目标目录：取第一个路径的父目录
            let destDir = paths[0];
            if (!paths[0].endsWith('/') && !paths[0].endsWith('\\')) {
                const idx = paths[0].lastIndexOf('/');
                const idx2 = paths[0].lastIndexOf('\\');
                const best = idx >= 0 ? (idx2 > idx ? idx2 : idx) : idx2;
                destDir = best >= 0 ? paths[0].substring(0, best) : paths[0];
            }
            compressSelected(paths, destDir);
        });
        document.getElementById('filterInput').addEventListener('input', applyFiltersAndSort);
        document.getElementById('typeFilter').addEventListener('change', applyFiltersAndSort);
        document.getElementById('goPathBtn').addEventListener('click', () => {
            const path = document.getElementById('pathInput').value.trim();
            navigateTo(path);
        });
        document.getElementById('pathInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') document.getElementById('goPathBtn').click(); });
        document.querySelectorAll('.sortable').forEach(el => {
            el.addEventListener('click', () => {
                const field = el.dataset.sort;
                if (field === sortField) sortAsc = !sortAsc;
                else { sortField = field; sortAsc = true; }
                applyFiltersAndSort();
            });
        });
        // 快捷键
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                document.querySelectorAll('.item-checkbox').forEach(el => {
                    el.checked = false;
                    selectedPaths.delete(el.dataset.path);
                    el.closest('tr').classList.remove('selected');
                });
                updateSelectedCount();
                updateBatchDeleteBtn();
                document.getElementById('selectAll').checked = false;
                document.getElementById('selectAll').indeterminate = false;
            }
            if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
                e.preventDefault();
                document.querySelectorAll('.item-checkbox').forEach(el => {
                    el.checked = true;
                    selectedPaths.add(el.dataset.path);
                    el.closest('tr').classList.add('selected');
                });
                updateSelectedCount();
                updateBatchDeleteBtn();
                document.getElementById('selectAll').checked = true;
                document.getElementById('selectAll').indeterminate = false;
            }
        });
        // 视图切换
        document.querySelectorAll('.btn-view').forEach(btn => {
            btn.addEventListener('click', () => switchView(btn.dataset.view));
        });
        // 图标大小切换
        document.querySelectorAll('.icon-size-btn').forEach(btn => {
            btn.addEventListener('click', () => switchIconSize(btn.dataset.size));
        });
        // 选择模式
        document.getElementById('selectModeBtn').addEventListener('click', toggleSelectMode);
        // 全盘搜索
        document.getElementById('searchBtn').addEventListener('click', () => showSearchModal());
        // 新建文件/文件夹
        document.getElementById('newFileMenuItem').addEventListener('click', (e) => { e.preventDefault(); showNewFileDialog(false); });
        document.getElementById('newFolderMenuItem').addEventListener('click', (e) => { e.preventDefault(); showNewFileDialog(true); });
        // 删除历史面板
        document.getElementById('deleteHistoryBtn').addEventListener('click', () => showDeleteHistory());
    }

    // ========== 快捷按钮（使用 systemInfo） ==========
    function bindQuickButtons() {
        document.getElementById('homeBtn').addEventListener('click', () => {
            if (systemInfo.desktop) navigateTo(systemInfo.desktop);
            else if (systemInfo.home) navigateTo(systemInfo.home);
            else showToast('提示', '无法获取桌面路径', 'warning');
        });
        document.getElementById('systemRootBtn').addEventListener('click', () => {
            if (systemInfo.root) navigateTo(systemInfo.root);
            else showToast('提示', '无法获取系统盘', 'warning');
        });
    }

    // ========== 初始化 ==========
    async function initApp() {
        try {
            const resp = await fetch('/api/system');
            const data = await resp.json();
            systemInfo = data;
            bindQuickButtons();
            bindIndexBadge();
            switchView(viewMode);
            switchIconSize(iconSize);
            toggleSelectMode();
            if (selectMode) toggleSelectMode();
            let startPath = localStorage.getItem(STORAGE_KEY);
            if (!startPath) startPath = systemInfo.root || '/';
            loadFiles(startPath);
            loadDeleteHistoryCount();
        } catch (e) {
            console.error('[initApp]', e);
            showToast('警告', '无法获取系统信息：' + e.message, 'warning');
            bindQuickButtons();
            bindIndexBadge();
            switchView(viewMode);
            switchIconSize(iconSize);
            toggleSelectMode();
            if (selectMode) toggleSelectMode();
            let startPath = localStorage.getItem(STORAGE_KEY);
            if (!startPath) startPath = '';
            loadFiles(startPath);
            loadDeleteHistoryCount();
        }
    }

    // ========== 索引状态 ==========
    let _indexPollTimer = null;

    function bindIndexBadge() {
        const badge = document.getElementById('indexBadge');
        if (!badge) return;
        badge.addEventListener('click', () => {
            showIndexDetail();
        });
        // 启动轮询
        startIndexPolling();
    }

    // ========== 索引详情面板 ==========
    let _indexPanelRef = null;

    function showIndexDetail() {
        const container = document.getElementById('indexDetailPanel');
        if (!container) return;

        // 如果面板已打开，先关闭
        if (container.childElementCount > 0) {
            closeIndexDetail();
        }

        const overlay = document.createElement('div');
        overlay.className = 'index-detail-overlay';

        const panel = document.createElement('div');
        panel.className = 'index-detail-panel';
        panel.innerHTML = `
            <div class="panel-header">
                <span class="panel-title"><i class="bi bi-database"></i> 索引详情</span>
                <button class="panel-close" title="关闭"><i class="bi bi-x-lg"></i></button>
            </div>
            <div class="panel-body">
                <div class="idx-section">
                    <div class="idx-stats-grid">
                        <div class="idx-stat-card"><div class="stat-label"><i class="bi bi-file-earmark"></i> 文件数</div><div class="stat-value" id="idxFileCount">--</div></div>
                        <div class="idx-stat-card"><div class="stat-label"><i class="bi bi-folder"></i> 目录数</div><div class="stat-value" id="idxDirCount">--</div></div>
                        <div class="idx-stat-card full-width"><div class="stat-label"><i class="bi bi-hdd"></i> 总大小</div><div class="stat-value" id="idxTotalSize">--</div></div>
                        <div class="idx-stat-card info"><div class="stat-label"><i class="bi bi-clock"></i> 上次扫描</div><div class="stat-value" id="idxLastScan">--</div></div>
                        <div class="idx-stat-card"><div class="stat-label"><i class="bi bi-gear"></i> 状态</div><div class="stat-value" id="idxStatus">--</div></div>
                    </div>
                    <div id="idxProgressArea" style="display:none;"><div style="font-size:0.75rem;color:#475569;margin-bottom:2px;">扫描进度: <strong id="idxProgressText">0%</strong></div><div class="idx-progress-bar"><div class="progress-fill" id="idxProgressFill" style="width:0%;"></div></div></div>
                </div>
                <div class="idx-section">
                    <div class="idx-section-title"><i class="bi bi-bar-chart"></i> 占用空间 Top 15 目录</div>
                    <div id="idxTopDirs"></div>
                </div>
                <div class="idx-section">
                    <div class="idx-section-title"><i class="bi bi-tags"></i> 文件类型分布</div>
                    <div id="idxTypeDist"></div>
                </div>
                <div class="idx-section">
                    <div class="idx-section-title"><i class="bi bi-file-earmark-plus"></i> 最大文件 Top 10</div>
                    <div id="idxTopFiles"></div>
                </div>
            </div>
            <div class="panel-footer">
                <button class="idx-btn idx-btn-primary" id="idxRebuildBtn"><i class="bi bi-arrow-clockwise"></i> 重建索引</button>
                <button class="idx-btn idx-btn-cancel" id="idxCancelBtn" style="display:none;"><i class="bi bi-x-lg"></i> 取消扫描</button>
            </div>
        `;

        overlay.appendChild(panel);
        container.appendChild(overlay);
        _indexPanelRef = overlay;

        // 关闭按钮
        overlay.querySelector('.panel-close').addEventListener('click', closeIndexDetail);
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) closeIndexDetail();
        });

        // 重建索引按钮
        overlay.querySelector('#idxRebuildBtn').addEventListener('click', _handleIndexRebuild);
        overlay.querySelector('#idxCancelBtn').addEventListener('click', _handleIndexCancel);

        // 加载数据
        _loadIndexDetail();
    }

    function closeIndexDetail() {
        const container = document.getElementById('indexDetailPanel');
        if (!container) return;
        container.innerHTML = '';
        _indexPanelRef = null;
    }

    // ========== 删除历史面板 ==========
    function showDeleteHistory() {
        const container = document.getElementById('deleteHistoryPanel');
        if (!container) return;
        container.innerHTML = `
            <div class="delhist-overlay">
                <div class="delhist-panel">
                    <div class="panel-header">
                        <span class="panel-title"><i class="bi bi-clock-history"></i> 删除历史（回收站）</span>
                        <button class="panel-close" title="关闭"><i class="bi bi-x-lg"></i></button>
                    </div>
                    <div class="panel-body" id="delhistBody">
                        <div class="delhist-empty"><i class="bi bi-hourglass-split"></i>加载中...</div>
                    </div>
                    <div class="panel-footer">
                        <button class="delhist-btn-clear" id="delhistClearBtn" disabled><i class="bi bi-trash3"></i> 清空回收站</button>
                    </div>
                </div>
            </div>
        `;
        container.querySelector('.panel-close').addEventListener('click', closeDeleteHistory);
        container.querySelector('.delhist-overlay').addEventListener('click', (e) => {
            if (e.target === container.querySelector('.delhist-overlay')) closeDeleteHistory();
        });
        document.getElementById('delhistClearBtn').addEventListener('click', clearDeleteHistory);
        _loadDeleteHistoryList();
    }

    function closeDeleteHistory() {
        const container = document.getElementById('deleteHistoryPanel');
        if (container) container.innerHTML = '';
    }

    function _formatTimeAgo(ts) {
        if (!ts) return '--';
        const diff = Math.floor((Date.now() / 1000) - ts);
        if (diff < 60) return diff + '秒前';
        if (diff < 3600) return Math.floor(diff / 60) + '分钟前';
        if (diff < 86400) return Math.floor(diff / 3600) + '小时前';
        return Math.floor(diff / 86400) + '天前';
    }

    function _loadDeleteHistoryList() {
        fetch('/api/delete-history')
            .then(r => r.json())
            .then(data => {
                const body = document.getElementById('delhistBody');
                const clearBtn = document.getElementById('delhistClearBtn');
                const badge = document.getElementById('delhistCountBadge');
                if (!body) return;
                const items = data.items || [];
                const count = data.count || 0;

                // 更新顶部徽章
                if (badge) {
                    badge.textContent = count > 0 ? (count > 99 ? '99+' : count) : '0';
                    badge.classList.toggle('empty', count === 0);
                }

                if (items.length === 0) {
                    body.innerHTML = '<div class="delhist-empty"><i class="bi bi-check-circle"></i>回收站为空</div>';
                    if (clearBtn) clearBtn.disabled = true;
                    return;
                }

                if (clearBtn) clearBtn.disabled = false;

                let html = '';
                for (const item of items) {
                    const iconClass = item.is_dir ? 'bi bi-folder-fill dh-icon dir' : 'bi bi-file-earmark dh-icon';
                    const timeStr = _formatTimeAgo(item.deleted_at);
                    const sizeStr = item.size > 0 ? formatSize(item.size) : (item.is_dir ? '目录' : '0 B');
                    const pathDisp = item.original_path.replace(/^[^:]+:/, '').replace(/^\/+/, '');
                    const exists = item.exists !== false;
                    const statusClass = exists ? '' : 'lost';
                    const statusText = exists ? '可恢复' : '文件已丢失';
                    html += `
                        <div class="delhist-item">
                            <span class="${iconClass}"></span>
                            <div class="dh-info">
                                <div class="dh-name">${item.name}</div>
                                <div class="dh-path">${item.original_path}</div>
                                <div class="dh-meta">
                                    <span class="dh-time"><i class="bi bi-clock"></i> ${timeStr}</span>
                                    <span class="dh-size"><i class="bi bi-hdd"></i> ${sizeStr}</span>
                                    <span class="dh-status ${statusClass}"><i class="bi bi-${exists ? 'check-circle' : 'x-circle'}"></i> ${statusText}</span>
                                </div>
                            </div>
                            <div class="dh-actions">
                                <button class="btn btn-restore" data-tid="${item.id}" ${exists ? '' : 'disabled'} title="恢复"><i class="bi bi-arrow-counterclockwise"></i> 恢复</button>
                                <button class="btn btn-remove" data-tid="${item.id}" title="永久删除"><i class="bi bi-trash3"></i> 删除</button>
                            </div>
                        </div>
                    `;
                }
                body.innerHTML = html;

                // 绑定恢复按钮
                body.querySelectorAll('.btn-restore').forEach(btn => {
                    btn.addEventListener('click', () => {
                        restoreFromTrash(btn.dataset.tid, btn);
                    });
                });
                // 绑定删除按钮
                body.querySelectorAll('.btn-remove').forEach(btn => {
                    btn.addEventListener('click', () => {
                        permanentlyDeleteItem(btn.dataset.tid, btn);
                    });
                });
            })
            .catch(e => {
                const body = document.getElementById('delhistBody');
                if (body) body.innerHTML = '<div class="delhist-empty"><i class="bi bi-exclamation-triangle"></i>加载失败</div>';
            });
    }

    function _loadDeleteHistoryCount() {
        fetch('/api/delete-history')
            .then(r => r.json())
            .then(data => {
                const badge = document.getElementById('delhistCountBadge');
                if (!badge) return;
                const count = data.count || 0;
                badge.textContent = count > 0 ? (count > 99 ? '99+' : count) : '0';
                badge.classList.toggle('empty', count === 0);
            })
            .catch(() => {});
    }

    function loadDeleteHistoryCount() {
        _loadDeleteHistoryCount();
    }

    async function restoreFromTrash(trashId, btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="bi bi-hourglass-split"></i> 恢复中...';
        try {
            const resp = await fetch('/api/undo-delete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ trash_id: trashId })
            });
            const data = await resp.json();
            if (data.success) {
                showToast('恢复成功', data.message || '已恢复', 'success');
                loadFiles(currentPath);
                _loadDeleteHistoryList();
            } else {
                showToast('恢复失败', data.error || '恢复失败', 'warning');
                btn.disabled = false;
                btn.innerHTML = '<i class="bi bi-arrow-counterclockwise"></i> 恢复';
            }
        } catch(e) {
            showToast('错误', '恢复失败: ' + e.message, 'danger');
            btn.disabled = false;
            btn.innerHTML = '<i class="bi bi-arrow-counterclockwise"></i> 恢复';
        }
    }

    async function permanentlyDeleteItem(trashId, btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="bi bi-trash3"></i> 删除中...';
        try {
            const resp = await fetch('/api/delete-history/one', {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ trash_id: trashId })
            });
            const data = await resp.json();
            if (data.success) {
                showToast('已删除', '已永久删除: ' + data.removed, 'info');
                _loadDeleteHistoryList();
            } else {
                showToast('错误', data.error || '删除失败', 'danger');
                btn.disabled = false;
                btn.innerHTML = '<i class="bi bi-trash3"></i> 删除';
            }
        } catch(e) {
            showToast('错误', '删除失败: ' + e.message, 'danger');
            btn.disabled = false;
            btn.innerHTML = '<i class="bi bi-trash3"></i> 删除';
        }
    }

    async function clearDeleteHistory() {
        const confirmed = await showConfirm('确定要清空回收站吗？这将永久删除所有已删除的文件/目录，无法恢复！');
        if (!confirmed) return;
        const btn = document.getElementById('delhistClearBtn');
        btn.disabled = true;
        btn.innerHTML = '<i class="bi bi-hourglass-split"></i> 清理中...';
        try {
            const resp = await fetch('/api/delete-history/clear', { method: 'POST' });
            const data = await resp.json();
            if (data.success) {
                showToast('已清空', '已永久删除 ' + data.removed + ' 项' + (data.errors > 0 ? '，' + data.errors + ' 项失败' : ''), 'success');
                _loadDeleteHistoryList();
            } else {
                showToast('错误', data.error || '清空失败', 'danger');
                btn.disabled = false;
                btn.innerHTML = '<i class="bi bi-trash3"></i> 清空回收站';
            }
        } catch(e) {
            showToast('错误', '清空失败: ' + e.message, 'danger');
            btn.disabled = false;
            btn.innerHTML = '<i class="bi bi-trash3"></i> 清空回收站';
        }
    }

    function _handleIndexRebuild() {
        const status = document.getElementById('idxStatus').textContent;
        if (status === '扫描中...') return;

        showConfirm('确定要重建索引吗？重建将重新扫描所有文件并更新统计信息，耗时较长。')
            .then(confirmed => {
                if (!confirmed) return;
                const rebuildBtn = document.getElementById('idxRebuildBtn');
                const cancelBtn = document.getElementById('idxCancelBtn');
                rebuildBtn.disabled = true;
                rebuildBtn.innerHTML = '<i class="bi bi-arrow-repeat spin" style="display:inline-block;animation:spin 1s linear infinite;"></i> 启动中...';
                cancelBtn.style.display = '';

                fetch('/api/index/build', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ roots: '' }) })
                    .then(r => r.json())
                    .then(data => {
                        rebuildBtn.disabled = false;
                        rebuildBtn.innerHTML = '<i class="bi bi-arrow-clockwise"></i> 重建索引';
                        if (data.error) { showToast('错误', data.error, 'danger'); return; }
                        showToast('成功', '索引构建已启动', 'success');
                        startIndexPolling();
                        setTimeout(_loadIndexDetail, 1000);
                    })
                    .catch(e => {
                        rebuildBtn.disabled = false;
                        rebuildBtn.innerHTML = '<i class="bi bi-arrow-clockwise"></i> 重建索引';
                        showToast('错误', e.message, 'danger');
                    });
            });
    }

    function _handleIndexCancel() {
        fetch('/api/index/cancel', { method: 'POST' })
            .then(r => r.json())
            .then(() => {
                const cancelBtn = document.getElementById('idxCancelBtn');
                if (cancelBtn) cancelBtn.style.display = 'none';
                showToast('提示', '已取消索引扫描', 'info');
                setTimeout(_loadIndexDetail, 500);
            })
            .catch(() => {});
    }

    function _loadIndexDetail() {
        fetch('/api/index/detail')
            .then(r => r.json())
            .then(renderIndexDetail)
            .catch(() => {});
    }

    function renderIndexDetail(data) {
        const status = data.status || 'idle';
        const progress = data.progress || 0;
        const totalFiles = data.total_files || 0;
        const totalDirs = data.total_dirs || 0;
        const totalSizeStr = data.total_size_str || '--';
        const lastScan = data.last_scan || '--';
        const statusDetail = data.status_detail || '';

        document.getElementById('idxFileCount').textContent = totalFiles.toLocaleString();
        document.getElementById('idxDirCount').textContent = totalDirs.toLocaleString();
        document.getElementById('idxTotalSize').textContent = totalSizeStr;
        document.getElementById('idxLastScan').textContent = lastScan;

        // 状态
        const statusEl = document.getElementById('idxStatus');
        const progressArea = document.getElementById('idxProgressArea');
        const cancelBtn = document.getElementById('idxCancelBtn');
        if (status === 'scanning') {
            statusEl.textContent = '扫描中... ' + (statusDetail || '');
            progressArea.style.display = '';
            document.getElementById('idxProgressText').textContent = progress + '% ' + (statusDetail || '扫描中');
            document.getElementById('idxProgressFill').style.width = progress + '%';
            cancelBtn.style.display = '';
        } else if (status === 'error') {
            statusEl.textContent = '❌ 失败';
            progressArea.style.display = 'none';
            cancelBtn.style.display = 'none';
        } else {
            statusEl.textContent = '✅ 就绪';
            progressArea.style.display = 'none';
            cancelBtn.style.display = 'none';
        }

        // Top 15 目录
        const topDirsEl = document.getElementById('idxTopDirs');
        const topDirs = data.top_dirs || [];
        if (topDirs.length === 0) {
            topDirsEl.innerHTML = '<div class="idx-empty"><i class="bi bi-inbox"></i>暂无数据</div>';
        } else {
            let html = '<table class="idx-table"><thead><tr><th>#</th><th>目录</th><th>文件数</th><th class="num">大小</th></tr></thead><tbody>';
            topDirs.forEach((item, idx) => {
                html += `<tr><td class="num">${idx + 1}</td><td class="path-cell" data-path="${_escAttr(item.path)}">${_escHtml(item.name)}</td><td class="num">${item.file_count.toLocaleString()}</td><td class="num">${item.size_str}</td></tr>`;
            });
            html += '</tbody></table>';
            topDirsEl.innerHTML = html;
            // 路径点击导航
            topDirsEl.querySelectorAll('.path-cell').forEach(el => {
                el.addEventListener('click', () => {
                    closeIndexDetail();
                    navigateTo(el.dataset.path);
                });
            });
        }

        // 类型分布
        const typeDistEl = document.getElementById('idxTypeDist');
        const typeDist = data.type_distribution || [];
        if (typeDist.length === 0) {
            typeDistEl.innerHTML = '<div class="idx-empty"><i class="bi bi-inbox"></i>暂无数据</div>';
        } else {
            let html = '<table class="idx-table"><thead><tr><th>后缀</th><th>数量</th><th class="num">总大小</th></tr></thead><tbody>';
            typeDist.forEach(item => {
                html += `<tr><td><span class="ext-badge">${_escHtml(item.ext)}</span></td><td class="num">${item.count.toLocaleString()}</td><td class="num">${item.size_str}</td></tr>`;
            });
            html += '</tbody></table>';
            typeDistEl.innerHTML = html;
        }

        // 最大文件 Top 10
        const topFilesEl = document.getElementById('idxTopFiles');
        const topFiles = data.top_files || [];
        if (topFiles.length === 0) {
            topFilesEl.innerHTML = '<div class="idx-empty"><i class="bi bi-inbox"></i>暂无数据</div>';
        } else {
            let html = '<table class="idx-table"><thead><tr><th>文件名</th><th>后缀</th><th class="num">大小</th></tr></thead><tbody>';
            topFiles.forEach(item => {
                html += `<tr><td class="path-cell" data-path="${_escAttr(item.parent)}">${_escHtml(item.name)}</td><td><span class="ext-badge">${_escHtml(item.ext)}</span></td><td class="num">${item.size_str}</td></tr>`;
            });
            html += '</tbody></table>';
            topFilesEl.innerHTML = html;
            topFilesEl.querySelectorAll('.path-cell').forEach(el => {
                el.addEventListener('click', () => {
                    closeIndexDetail();
                    navigateTo(el.dataset.path);
                });
            });
        }
    }

    // ========== 操作菜单 ==========

    function startIndexPolling() {
        if (_indexPollTimer) clearInterval(_indexPollTimer);
        _indexPollTimer = setInterval(updateIndexBadge, 5000);
        updateIndexBadge();
    }

    function updateIndexBadge() {
        fetch('/api/index/meta')
            .then(r => r.json())
            .then(data => {
                const badge = document.getElementById('indexBadge');
                const text = document.getElementById('indexBadgeText');
                if (!badge || !text) return;
                const status = data.status || 'idle';
                const lastScan = data.last_scan || '--';
                const totalFiles = data.total_files || 0;
                const progress = data.progress || 0;
                const statusDetail = data.status_detail || '';
                if (status === 'scanning') {
                    const detail = statusDetail ? ' ' + statusDetail : '';
                    text.textContent = '扫描中... ' + totalFiles.toLocaleString() + ' 个文件' + (progress > 0 ? ' (' + progress + '%)' : '') + detail;
                    badge.className = 'badge bg-warning text-dark border';
                    badge.title = '扫描中...（' + (statusDetail || '正在进行') + '）';
                } else if (status === 'error') {
                    text.textContent = '扫描失败';
                    badge.className = 'badge bg-danger text-white border';
                    if (statusDetail) badge.title = statusDetail;
                } else if (totalFiles === 0 && (lastScan === '从未扫描' || lastScan === '等待中...')) {
                    text.textContent = '未扫描 (点击重建)';
                    badge.className = 'badge bg-light text-muted border';
                } else {
                    text.textContent = totalFiles.toLocaleString() + ' 个文件 (' + lastScan + ')';
                    badge.className = 'badge bg-success text-white border';
                }
            })
            .catch(() => {});
    }

    // ========== 操作菜单 ==========
    let _activeMenu = null;

    function _closeMenus() {
        if (_activeMenu) { _activeMenu.remove(); _activeMenu = null; }
        document.querySelectorAll('.more-btn.active').forEach(b => b.classList.remove('active'));
    }

    function showActionMenu(btn, absPath, isDir) {
        _closeMenus();
        const rect = btn.getBoundingClientRect();
        const menu = document.createElement('div');
        menu.className = 'action-menu';
        menu.style.display = 'block';

        // 构建菜单项
        const items = [
            { icon: 'bi bi-pencil', label: '重命名', action: 'rename', cls: '' },
            { icon: 'bi bi-copy', label: '复制文件名', action: 'copy-name', cls: '' },
            { icon: 'bi bi-link-45deg', label: '复制完整路径', action: 'copy-path', cls: '' },
        ];

        if (!isDir) {
            items.push({ icon: 'bi bi-folder-symlink', label: '打开所在文件夹', action: 'open-parent', cls: '' });
            const ext = _getExtFromPath(absPath);
            if (_TEXT_EXTS.has(ext) || _IMAGE_EXTS.has(ext) || _isZip(ext)) {
                items.push({ icon: 'bi bi-download', label: '下载文件', action: 'download', cls: '' });
            }
            if (_TEXT_EXTS.has(ext)) {
                items.push({ icon: 'bi bi-pencil-square', label: '编辑', action: 'edit', cls: '' });
            }
            items.push({ icon: 'bi bi-file-zip', label: '压缩', action: 'compress', cls: '' });
        } else {
            items.push({ icon: 'bi bi-folder-plus', label: '新建子文件夹', action: 'new-folder', cls: '' });
            items.push({ icon: 'bi bi-file-zip', label: '压缩此文件夹', action: 'compress', cls: '' });
        }

        items.push({ divider: true });
        items.push({ icon: 'bi bi-info-circle', label: '文件信息', action: 'properties', cls: '' });

        if (!isDir) {
            items.push({ icon: 'bi bi-arrow-right', label: '移动到...', action: 'move', cls: '' });
            items.push({ icon: 'bi bi-plus-square', label: '复制到...', action: 'copy-to', cls: '' });
            items.push({ divider: true });
            items.push({ icon: 'bi bi-trash3', label: '删除', action: 'delete', cls: 'danger' });
        }

        items.forEach(item => {
            if (item.divider) {
                const div = document.createElement('div');
                div.className = 'menu-divider';
                menu.appendChild(div);
            } else {
                const el = document.createElement('button');
                el.className = `menu-item ${item.cls}`;
                el.innerHTML = `<i class="${item.icon}"></i><span>${item.label}</span>`;
                el.addEventListener('click', () => { _closeMenus(); handleAction(item.action, absPath, isDir); });
                menu.appendChild(el);
            }
        });

        document.body.appendChild(menu);

        // ===== 自动定位：检测溢出并翻转方向 =====
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const menuRect = menu.getBoundingClientRect();
        const menuW = menuRect.width;
        const menuH = menuRect.height;
        const btnCenterX = rect.left + rect.width / 2;
        const btnBottomY = rect.bottom;
        const btnTopY = rect.top;
        const padding = 4;

        // 水平定位：菜单尽量以按钮中心居中，溢出时贴边
        let left = btnCenterX - menuW / 2;
        if (left < padding) left = padding;                     // 左溢出 → 贴左
        if (left + menuW > vw - padding) left = vw - menuW - padding;  // 右溢出 → 贴右
        menu.style.left = left + 'px';

        // 垂直定位：优先向下，溢出则向上
        let top;
        const spaceBelow = vh - btnBottomY - padding;
        const spaceAbove = btnTopY - padding;
        if (spaceBelow >= menuH) {
            top = btnBottomY + 6;
        } else if (spaceAbove >= menuH) {
            top = btnTopY - menuH - 6;
        } else {
            top = Math.max(0, btnTopY - menuH - 6);
        }
        menu.style.top = top + 'px';

        _activeMenu = menu;
        btn.classList.add('active');
        setTimeout(() => { document.addEventListener('click', _clickOutsideMenu, { once: true }); }, 10);
    }

    function _clickOutsideMenu(e) {
        if (_activeMenu && !_activeMenu.contains(e.target) && !e.target.closest('.more-btn')) {
            _closeMenus();
        }
    }

    function _getExtFromPath(path) {
        const parts = path.split('/');
        const name = parts[parts.length - 1];
        const dotIdx = name.lastIndexOf('.');
        return dotIdx >= 0 ? name.substring(dotIdx + 1).toLowerCase() : '';
    }

    function handleAction(action, absPath, isDir) {
        switch (action) {
            case 'rename': showRenameDialog(absPath); break;
            case 'copy-name': _copyToClipboard(absPath.split('/').pop(), '文件名已复制'); break;
            case 'copy-path': _copyToClipboard(absPath, '路径已复制'); break;
            case 'open-parent': _openInExplorer(absPath); break;
            case 'download': _downloadFile(absPath); break;
            case 'new-folder': showNewFolderDialog(absPath); break;
            case 'properties': showPropertiesDialog(absPath); break;
            case 'move': showMoveCopyDialog(absPath, 'move'); break;
            case 'copy-to': showMoveCopyDialog(absPath, 'copy'); break;
            case 'delete': deleteFiles([absPath]); break;
            case 'edit': openEditor(absPath, false); break;
            case 'compress': compressSelected([absPath], isDir ? absPath : absPath.substring(0, absPath.lastIndexOf('/'))); break;
        }
    }

    function _copyToClipboard(text, successMsg) {
        navigator.clipboard.writeText(text).then(() => {
            showToast('成功', successMsg, 'success');
        }).catch(() => {
            const ta = document.createElement('textarea');
            ta.value = text; document.body.appendChild(ta); ta.select();
            document.execCommand('copy'); document.body.removeChild(ta);
            showToast('成功', successMsg, 'success');
        });
    }

    function _openInExplorer(absPath) {
        const parent = absPath.substring(0, absPath.lastIndexOf('/'));
        _copyToClipboard(parent, '已复制到剪切板');
        try {
            const win = window.open('file://' + parent, '_blank');
            if (!win) showToast('提示', '请在新窗口中打开: ' + parent, 'info');
        } catch(e) {
            showToast('提示', '已复制父目录路径: ' + parent, 'info');
        }
    }

    function _downloadFile(absPath) {
        window.open(`/api/stream?path=${encodeURIComponent(absPath)}`, '_blank');
    }

    // ========== 重命名对话框 ==========
    function showRenameDialog(absPath) {
        const name = absPath.split('/').pop();
        const extIdx = name.lastIndexOf('.');
        const baseName = extIdx >= 0 ? name.substring(0, extIdx) : name;
        const ext = extIdx >= 0 ? name.substring(extIdx) : '';
        showInputDialog('重命名', '新文件名', baseName, (newName) => {
            newName = (newName || '').trim();
            if (!newName) { showToast('错误', '名称不能为空', 'danger'); return false; }
            const finalName = ext ? newName + ext : newName;
            fetch('/api/rename', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ path: absPath, new_name: finalName }) })
                .then(r => r.json()).then(data => {
                    if (data.error) { showToast('错误', data.error, 'danger'); return; }
                    showToast('成功', `已重命名为 ${finalName}`, 'success');
                    loadFiles(currentPath);
                }).catch(e => { showToast('错误', e.message, 'danger'); });
        });
    }

    // ========== 新建子文件夹 ==========
    function showNewFolderDialog(parentPath) {
        showInputDialog('新建文件夹', '文件夹名称', '新文件夹', (name) => {
            name = (name || '').trim();
            if (!name) { showToast('错误', '名称不能为空', 'danger'); return false; }
            fetch('/api/new-folder', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ parent: parentPath, name }) })
                .then(r => r.json()).then(data => {
                    if (data.error) { showToast('错误', data.error, 'danger'); return; }
                    showToast('成功', `已创建文件夹 ${name}`, 'success');
                    loadFiles(currentPath);
                }).catch(e => { showToast('错误', e.message, 'danger'); });
        });
    }

    // ========== 文件信息面板 ==========
    function showPropertiesDialog(absPath) {
        fetch(`/api/properties?path=${encodeURIComponent(absPath)}`)
            .then(r => r.json()).then(data => {
                if (data.error) { showToast('错误', data.error, 'danger'); return; }
                _showPropPanel(data);
            }).catch(e => { showToast('错误', e.message, 'danger'); });
    }

    function _showPropPanel(data) {
        const isDir = data.is_dir;
        let bodyRows = '';
        bodyRows += `<div class="prop-row"><span class="prop-label">名称</span><span class="prop-value clickable" data-copy="${data.name}">${data.name}</span></div>`;
        bodyRows += `<div class="prop-row"><span class="prop-label">类型</span><span class="prop-value">${isDir ? '文件夹' : (data.mime_type || '未知')}</span></div>`;
        bodyRows += `<div class="prop-row"><span class="prop-label">大小</span><span class="prop-value">${data.size_str}</span></div>`;
        bodyRows += `<div class="prop-row"><span class="prop-label">路径</span><span class="prop-value clickable" data-copy="${data.path}">${data.path}</span></div>`;
        bodyRows += `<div class="prop-row"><span class="prop-label">所在目录</span><span class="prop-value clickable" data-copy="${data.parent}">${data.parent}</span></div>`;
        bodyRows += `<div class="prop-row"><span class="prop-label">创建时间</span><span class="prop-value">${data.created}</span></div>`;
        bodyRows += `<div class="prop-row"><span class="prop-label">修改时间</span><span class="prop-value">${data.modified}</span></div>`;
        bodyRows += `<div class="prop-row"><span class="prop-label">权限</span><span class="prop-value">${data.permissions || '-'}</span></div>`;

        if (isDir) {
            bodyRows += `<div class="prop-divider"></div>`;
            bodyRows += `<div class="prop-row"><span class="prop-label">子文件夹</span><span class="prop-value"><i class="bi bi-folder-fill text-warning"></i> ${data.sub_dirs || 0} 个</span></div>`;
            bodyRows += `<div class="prop-row"><span class="prop-label">子文件</span><span class="prop-value"><i class="bi bi-file-earmark"></i> ${data.sub_files || 0} 个</span></div>`;
            bodyRows += `<div class="prop-row"><span class="prop-label">总文件夹</span><span class="prop-value">${data.total_dirs || 0} 个</span></div>`;
            bodyRows += `<div class="prop-row"><span class="prop-label">总文件</span><span class="prop-value">${data.total_files || 0} 个</span></div>`;
        }

        const overlay = document.createElement('div');
        overlay.className = 'custom-modal-overlay';
        overlay.innerHTML = `
            <div class="prop-panel">
                <div class="prop-header">
                    <span class="prop-title"><i class="bi ${isDir ? 'bi-folder-fill' : 'bi-file-earmark'}"></i> ${isDir ? '文件夹信息' : '文件信息'}</span>
                    <button class="prop-close" title="关闭"><i class="bi bi-x-lg"></i></button>
                </div>
                <div class="prop-body">
                    ${bodyRows}
                </div>
            </div>
        `;
        document.body.appendChild(overlay);
        overlay.querySelector('.prop-close').addEventListener('click', () => overlay.remove());
        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
        overlay.querySelectorAll('.prop-value.clickable').forEach(el => {
            el.addEventListener('click', () => { _copyToClipboard(el.dataset.copy, '已复制到剪切板'); });
        });
    }

    // ========== 移动/复制到 ==========
    function showMoveCopyDialog(absPath, mode) {
        const isMove = mode === 'move';
        const title = isMove ? '移动到' : '复制到';
        const name = absPath.split('/').pop();
        const overlay = document.createElement('div');
        overlay.className = 'custom-modal-overlay';
        overlay.innerHTML = `
            <div class="mv-modal">
                <div class="mv-title"><i class="bi ${isMove ? 'bi-arrow-right' : 'bi-plus-square'}"></i> ${title}</div>
                <div class="mv-info">正在${title}: <code>${name}</code></div>
                <div class="mv-path-input">
                    <input type="text" id="mvDestInput" placeholder="目标目录绝对路径，如 /home/user/Downloads" />
                    <button class="btn btn-go" id="mvBrowseBtn">浏览</button>
                </div>
                <div class="mv-preview" id="mvPreview" style="display:none;"></div>
                <div class="mv-footer">
                    <button class="btn btn-cancel" id="mvCancel">取消</button>
                    <button class="btn btn-ok" id="mvOk" disabled>${isMove ? '移动' : '复制'}</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        const input = overlay.querySelector('#mvDestInput');
        const preview = overlay.querySelector('#mvPreview');
        const okBtn = overlay.querySelector('#mvOk');

        input.addEventListener('input', () => {
            const val = input.value.trim();
            if (val) {
                preview.textContent = `目标路径: ${val}/${name}`;
                preview.style.display = '';
                okBtn.disabled = false;
            } else {
                preview.style.display = 'none';
                okBtn.disabled = true;
            }
        });

        overlay.querySelector('#mvBrowseBtn').addEventListener('click', () => {
            navigateTo(input.value.trim());
            input.value = currentPath;
            input.dispatchEvent(new Event('input'));
        });

        okBtn.addEventListener('click', () => {
            const destDir = input.value.trim();
            if (!destDir) return;
            overlay.remove();
            fetch(`/api/${isMove ? 'move' : 'copy'}`, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ path: absPath, dest_dir: destDir })
            }).then(r => r.json()).then(data => {
                if (data.error) { showToast('错误', data.error, 'danger'); return; }
                showToast('成功', `已${isMove ? '移动' : '复制'}到 ${destDir}`, 'success');
                loadFiles(currentPath);
            }).catch(e => { showToast('错误', e.message, 'danger'); });
        });

        overlay.querySelector('#mvCancel').addEventListener('click', () => overlay.remove());
        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    }

    // ========== 通用输入对话框 ==========
    function showInputDialog(title, label, defaultVal, onConfirm, validate) {
        const overlay = document.createElement('div');
        overlay.className = 'custom-modal-overlay';
        overlay.innerHTML = `
            <div class="custom-modal">
                <div class="modal-title"><i class="bi bi-pencil"></i> ${title}</div>
                <div class="modal-body">
                    <label style="display:block;font-size:0.8rem;color:#718096;margin-bottom:6px;">${label}</label>
                    <input type="text" class="form-control" id="inputDialogValue" style="font-family:monospace;font-size:0.85rem;" value="${_escapeHtml(defaultVal)}" />
                    <div id="inputDialogError" style="font-size:0.78rem;color:#dc2626;margin-top:6px;display:none;"></div>
                </div>
                <div class="modal-footer">
                    <button class="btn btn-cancel" id="inputCancel">取消</button>
                    <button class="btn btn-ok" id="inputOk">确定</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);
        const input = overlay.querySelector('#inputDialogValue');
        const okBtn = overlay.querySelector('#inputOk');
        const errEl = overlay.querySelector('#inputDialogError');
        input.focus(); input.select();

        // 验证函数
        let isValid = true;
        const runValidation = () => {
            if (!validate) { isValid = true; errEl.style.display = 'none'; okBtn.disabled = false; return; }
            const result = validate(input.value);
            if (result.valid) {
                isValid = true;
                errEl.style.display = 'none';
                okBtn.disabled = false;
            } else {
                isValid = false;
                errEl.textContent = result.message;
                errEl.style.display = 'block';
                okBtn.disabled = true;
            }
        };

        const confirm = () => {
            if (!isValid) return;
            const val = input.value;
            if (onConfirm(val) === false) return;
            overlay.remove();
        };

        overlay.querySelector('#inputOk').addEventListener('click', confirm);
        overlay.querySelector('#inputCancel').addEventListener('click', () => overlay.remove());
        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
        input.addEventListener('input', runValidation);
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && isValid) confirm(); });

        // 初始验证
        runValidation();
    }

    // ========== 错误捕获（页面级） ==========
    window.addEventListener('error', (e) => {
        const errDiv = document.createElement('div');
        errDiv.style.cssText = 'position:fixed;top:0;left:0;right:0;background:#dc2626;color:white;padding:8px 16px;font-size:0.85rem;z-index:99999;text-align:center;';
        errDiv.textContent = 'JS 错误: ' + (e.message || '未知错误') + ' (' + (e.filename || '') + ':' + (e.lineno || '') + ')';
        document.body.appendChild(errDiv);
        console.error('JS Error:', e.message, e.filename + ':' + e.lineno);
    });

    // 立即执行初始化（不依赖 window.onload，也不等 Bootstrap）
    try {
        initEvents();
        } catch(e) {
        console.error('[initEvents]', e);
        }
    try {
        initApp();
        } catch(e) {
        console.error('[initApp]', e);
        }
    // Bootstrap 异步加载，不影响初始化
    (function() {
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js';
        script.onload = () => {
        };
        script.onerror = () => {
        };
        document.head.appendChild(script);
    })();
    // CodeMirror 语言模式异步加载 + SimpleMDE 异步加载
    (function() {
        const langs = ['css','javascript','htmlmixed','xml','clike','python','ruby','lua','sql','go','rust','php','markdown','yaml','ini','properties','shell'];
        let i = 0;
        function loadLangs() {
            if (i >= langs.length) { return; }
            const s = document.createElement('script');
            s.src = 'https://cdn.jsdelivr.net/npm/codemirror@5.65.16/mode/' + (langs[i] === 'css' ? 'css/css.min.js' : langs[i] === 'javascript' ? 'javascript/javascript.min.js' : langs[i] === 'htmlmixed' ? 'htmlembedded/htmlembedded.min.js' : langs[i] === 'xml' ? 'xml/xml.min.js' : langs[i] === 'clike' ? 'clike/clike.min.js' : langs[i] === 'python' ? 'python/python.min.js' : langs[i] === 'ruby' ? 'ruby/ruby.min.js' : langs[i] === 'lua' ? 'lua/lua.min.js' : langs[i] === 'sql' ? 'sql/sql.min.js' : langs[i] === 'go' ? 'go/go.min.js' : langs[i] === 'rust' ? 'clike/clike.min.js' : langs[i] === 'php' ? 'php/php.min.js' : langs[i] === 'markdown' ? 'markdown/markdown.min.js' : langs[i] === 'yaml' ? 'yaml/yaml.min.js' : langs[i] === 'ini' ? 'ini/ini.min.js' : langs[i] === 'properties' ? 'properties/properties.min.js' : langs[i] === 'shell' ? 'shell/shell.min.js' : 'text/plain.min.js');
            s.onload = () => { i++; loadLangs(); };
            s.onerror = () => { i++; loadLangs(); };
            document.head.appendChild(s);
        }
        loadLangs();
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/simplemde@1.11.2/dist/simplemde.min.js';
        s.onload = () => {
            // SimpleMDE 就绪，触发待搜索
            if (_pendingSearchText) { _doFind(_pendingSearchText); _pendingSearchText = ''; }
            // 通知等待中的编辑器
            window.dispatchEvent(new Event('simplemde_loaded'));
            if (window._simpleMDEReady) window._simpleMDEReady();
        };
        document.head.appendChild(s);
    })();
    </script>
</body>
</html>
"""

# ========== 主程序 ==========
def open_browser(port):
    webbrowser.open(f"http://localhost:{port}")

def main():
    parser = argparse.ArgumentParser(description="文件管理可视化工具（增强版）")
    parser.add_argument("--port", "-P", type=int, default=5000, help="服务端口 (默认: 5000)")
    parser.add_argument("--no-browser", action="store_true", help="不自动打开浏览器")
    args = parser.parse_args()

    print(f"📁 默认起始路径: {DEFAULT_START_PATH}")
    print(f"🌐 服务地址: http://0.0.0.0:{args.port}（本机: http://localhost:{args.port}）")
    print("💡 在浏览器中可自由切换任意文件夹，路径会自动保存")
    print("按 Ctrl+C 停止服务")

    if not args.no_browser:
        threading.Timer(1.0, open_browser, args=[args.port]).start()

    try:
        app.run(host="0.0.0.0", port=args.port, debug=False, threaded=True)
    except KeyboardInterrupt:
        print("\n服务已停止")
    except OSError as e:
        if "Address already in use" in str(e):
            print(f"错误: 端口 {args.port} 已被占用，请使用 --port 指定其他端口")
        else:
            print(f"错误: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()
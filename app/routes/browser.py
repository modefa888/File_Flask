"""浏览/预览/缩略图/视频流转发路由。"""
import os
import sys
import json
import time
import threading
import mimetypes
import base64

from flask import Blueprint, request, jsonify, send_file, render_template, Response as FlaskResponse
from urllib.parse import quote

from ..config import (
    _TEXT_EXTS, _IMAGE_EXTS, _VIDEO_EXTS,
    _AUDIO_EXTS,
    _PREVIEW_MAX_BYTES, _TEXT_PREVIEW_MAX_BYTES,
    _THUMB_CACHE_DIR, _TEXT_FILENAMES,
)
from ..log import get_logger
from ..services.filecore import (
    safe_path, format_size, list_directory, _SIZE_PENDING, _SIZE_PENDING_LOCK,
    _DIR_SIZE_CACHE, _ensure_dir_size_async,
)
from ..services.thumbnail import (
    _get_thumbnail_bytes, _extract_video_frame, _clear_disk_cache as _clear_thumb_cache,
)


_log = get_logger()
bp = Blueprint("browser", __name__)





# ======================================================================
# 最近打开的文件夹（服务端持久化，跨设备 / 跨浏览器共享）
# ======================================================================
_RECENT_DIR_FILE = ".file_recent_folders.json"
_RECENT_MAX = 8                              # 最多保留的条数
_RECENT_LOCK = threading.Lock()


def _recent_path() -> str:
    from ..config import _DATA_ROOT
    return os.path.join(_DATA_ROOT, _RECENT_DIR_FILE)


def _recent_load() -> list:
    try:
        with open(_recent_path(), "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return []
    if not isinstance(data, list):
        return []
    out = []
    for it in data:
        if isinstance(it, dict) and it.get("path"):
            out.append({"path": str(it["path"]), "opened_at": float(it.get("opened_at") or 0)})
    return out


def _recent_save(items: list) -> None:
    tmp = _recent_path() + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(items, f, ensure_ascii=False, indent=2)
        os.replace(tmp, _recent_path())
    except OSError as e:
        _log.warning("保存最近打开记录失败：%s", e)


@bp.route("/api/recent/folders")
def api_recent_folders():
    """最近打开的文件夹列表（含是否存在，便于前端标记失效项）。"""
    with _RECENT_LOCK:
        items = _recent_load()
    for it in items:
        it["exists"] = os.path.isdir(it["path"])
        it["name"] = os.path.basename(it["path"].rstrip("/")) or it["path"]
    return jsonify({"ok": True, "folders": items})


@bp.route("/api/recent/folders", methods=["POST"])
def api_recent_folders_add():
    """记录一次打开：去重置顶，最多保留 _RECENT_MAX 条。"""
    data = request.get_json(silent=True) or {}
    path = (data.get("path") or "").strip()
    if not path:
        return jsonify({"error": "缺少路径"}), 400
    path = os.path.abspath(os.path.normpath(path))
    with _RECENT_LOCK:
        items = _recent_load()
        items = [x for x in items if x["path"] != path]
        items.insert(0, {"path": path, "opened_at": time.time()})
        items = items[:_RECENT_MAX]
        _recent_save(items)
    return jsonify({"ok": True, "folders": items})


@bp.route("/api/recent/folders/remove", methods=["POST"])
def api_recent_folders_remove():
    """移除一条记录（路径失效时使用）。"""
    data = request.get_json(silent=True) or {}
    path = (data.get("path") or "").strip()
    if not path:
        return jsonify({"error": "缺少路径"}), 400
    path = os.path.abspath(os.path.normpath(path))
    with _RECENT_LOCK:
        items = [x for x in _recent_load() if x["path"] != path]
        _recent_save(items)
    return jsonify({"ok": True, "folders": items})


@bp.route("/api/system")
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


@bp.route("/api/size-status")
def api_size_status():
    """查询目录列表中仍在后台计算大小的子目录（前端轮询用，秒回）"""
    _log.info("GET /api/size-status path=%s", request.args.get("path", ""))
    target_path = safe_path(request.args.get("path", ""))
    if not os.path.isdir(target_path):
        return jsonify({"error": "路径不存在"}), 400
    show_hidden = request.args.get("hidden", "0") == "1"
    items = list_directory(target_path, get_sizes=False, show_hidden=show_hidden)
    # 直接查全局后台计算集合，避免依赖列表缓存快照
    target_abs = os.path.abspath(target_path)
    with _SIZE_PENDING_LOCK:
        pending = [os.path.basename(p) for p in _SIZE_PENDING
                   if os.path.dirname(os.path.abspath(p)) == target_abs]
    # 附带已算好的子目录大小，供前端本地更新条目（避免完成后全量请求 /api/files）
    sizes = {}
    for it in items:
        if not it.get("is_dir"):
            continue
        entry = _DIR_SIZE_CACHE.get(os.path.join(target_abs, it["name"]))
        if entry and isinstance(entry.get("size"), (int, float)) and entry["size"] >= 0:
            sizes[it["name"]] = entry["size"]
    return jsonify({"pending": pending, "total": len(items), "sizes": sizes})


@bp.route("/api/files")
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

    show_hidden = request.args.get("hidden", "0") == "1"
    # 目录列表：浏览时不同步计算目录大小（避免挂载盘 du 拖慢请求，已缓存/索引命中的仍带回）。
    # 未命中缓存的目录标记为 size_pending，下面启动后台 du，前端轮询 /api/size-status 异步补全。
    items = list_directory(target_path, get_sizes=False, show_hidden=show_hidden)
    target_abs_dir = abs_path = os.path.abspath(target_path)
    for it in items:
        if it.get("is_dir") and it.get("size_pending"):
            _ensure_dir_size_async(os.path.join(target_abs_dir, it["name"]))
    total_size = sum(item["size"] for item in items if item.get("size", 0) >= 0)
    total_files = sum(1 for item in items if not item["is_dir"])
    total_dirs = sum(1 for item in items if item["is_dir"])

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


@bp.route("/api/preview")
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
        # 文本/图片限制：文本放宽到 20MB，图片 5MB
        _limit = _TEXT_PREVIEW_MAX_BYTES if is_text else _PREVIEW_MAX_BYTES
        if ext not in _VIDEO_EXTS and stat.st_size > _limit:
            return jsonify({"error": f"文件过大，最大支持 {format_size(_limit)}"}), 413
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
        # 文本：raw=1 时直接返回纯文本（不套 JSON/base64），大文件加载快很多（IDE 使用）
        if is_text and request.args.get("raw") == "1":
            with open(target_path, "r", encoding="utf-8", errors="replace", newline="") as f:
                text = f.read()
            resp = FlaskResponse(text, status=200, mimetype="text/plain")
            resp.headers["X-Preview-Type"] = "text"
            resp.headers["X-Preview-Ext"] = ext
            resp.headers["X-File-Size"] = str(stat.st_size)
            resp.headers["Cache-Control"] = "no-store"
            return resp
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


@bp.route("/api/raw/<path:fspath>")
def api_raw_path(fspath):
    """按原始内容与正确 MIME 返回文件。

    供 IDE 的 HTML 预览使用：iframe 内注入 <base href="/api/raw/<目录>/">，
    页面里的相对资源（js/css/img）就会请求 /api/raw/... 而被正确加载。
    fspath 为绝对路径去掉开头斜杠的形式（每段已在前端做 URL 编码）。

    例外：Markdown 文件直接返回渲染好的居中预览页（分享链接在浏览器里
    打开即是排版效果）；需要纯文本时加 ?raw=1。
    """
    full = os.path.abspath(os.sep + fspath)
    if not os.path.isfile(full):
        return jsonify({"error": "文件不存在"}), 404
    ext = os.path.splitext(full)[1].lower().lstrip(".")
    if ext in ("md", "markdown"):
        try:
            with open(full, "r", encoding="utf-8", errors="replace") as f:
                text = f.read()
        except (OSError, PermissionError) as e:
            return jsonify({"error": f"无法读取文件: {str(e)}"}), 500
        # ?raw=1 → 纯文本；否则返回渲染好的居中预览页
        if request.args.get("raw") == "1":
            resp = FlaskResponse(text, status=200, mimetype="text/plain")
            resp.headers["Cache-Control"] = "no-store"
            return resp
        resp = FlaskResponse(render_template(
            "markdown_view.html",
            content=text,
            title=os.path.basename(full),
        ), status=200, mimetype="text/html")
        resp.headers["Cache-Control"] = "no-store"
        return resp
    mime, _ = mimetypes.guess_type(full)
    if not mime:
        mime = "application/octet-stream"
    try:
        resp = send_file(full, mimetype=mime, as_attachment=False, conditional=True)
        resp.headers["Cache-Control"] = "no-store"
        return resp
    except (OSError, PermissionError) as e:
        return jsonify({"error": f"无法读取文件: {str(e)}"}), 500


def _get_file_path_from_request(req):
    """从请求参数安全地提取文件绝对路径"""
    rel_path = req.args.get("path", "")
    target_path = os.path.abspath(os.path.normpath(rel_path))
    if not os.path.isfile(target_path):
        return None
    return target_path


# ========== 收藏夹（常用文件夹，持久化到 data/favorites.json） ==========
_FAV_LOCK = threading.Lock()
_FAV_MAX = 50


def _fav_file():
    from ..config import _DATA_ROOT
    return os.path.join(_DATA_ROOT, "favorites.json")


def _load_favs():
    try:
        with open(_fav_file(), "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except (OSError, ValueError):
        return []


def _save_favs(items):
    from ..config import _DATA_ROOT
    os.makedirs(_DATA_ROOT, exist_ok=True)
    tmp = _fav_file() + ".tmp%d" % os.getpid()
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(items, f, ensure_ascii=False, indent=1)
    os.replace(tmp, _fav_file())


def _groups_file():
    from ..config import _DATA_ROOT
    return os.path.join(_DATA_ROOT, "fav_groups.json")


def _load_groups():
    """分组展示顺序（拖动排序后持久化）；"__ungrouped__" 表示「其他」分区的位置"""
    try:
        with open(_groups_file(), "r", encoding="utf-8") as f:
            data = json.load(f)
        return [str(g) for g in data] if isinstance(data, list) else []
    except (OSError, ValueError):
        return []


def _save_groups(groups):
    from ..config import _DATA_ROOT
    os.makedirs(_DATA_ROOT, exist_ok=True)
    tmp = _groups_file() + ".tmp%d" % os.getpid()
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(groups, f, ensure_ascii=False, indent=1)
    os.replace(tmp, _groups_file())


def _ensure_group(groups, name):
    """登记分组（保持顺序），新分组追加到末尾"""
    if name and name not in groups:
        groups.append(name)


@bp.route("/api/favorites")
def api_fav_list():
    """收藏夹列表：{items: [{path, name, added, group?, is_dir}], groups: [分组顺序]}"""
    items = []
    for it in _load_favs():
        p = it.get("path", "")
        rec = dict(it)
        rec["is_dir"] = os.path.isdir(p) if p else False
        items.append(rec)
    return jsonify({"items": items, "groups": _load_groups()})


@bp.route("/api/favorites", methods=["POST"])
def api_fav_add():
    body = request.get_json(silent=True) or {}
    path = (body.get("path") or "").strip()
    full = os.path.abspath(os.path.normpath(path)) if path else ""
    if not full or not os.path.exists(full):
        return jsonify({"error": "路径不存在"}), 400
    group = (body.get("group") or "").strip()[:50]
    with _FAV_LOCK:
        items = _load_favs()
        items = [it for it in items if os.path.normpath(it.get("path", "")) != os.path.normpath(full)]
        rec = {
            "path": full,
            "name": os.path.basename(full) or full,
            "added": int(time.time()),
        }
        if group:
            rec["group"] = group
        items.insert(0, rec)
        _save_favs(items[:_FAV_MAX])
        if group:
            groups = _load_groups()
            _ensure_group(groups, group)
            _save_groups(groups)
    return jsonify({"ok": True})


@bp.route("/api/favorites", methods=["DELETE"])
def api_fav_del():
    body = request.get_json(silent=True) or {}
    path = (body.get("path") or "").strip()
    if not path:
        return jsonify({"error": "path 不能为空"}), 400
    with _FAV_LOCK:
        items = [it for it in _load_favs()
                 if os.path.normpath(it.get("path", "")) != os.path.normpath(path)]
        _save_favs(items)
    return jsonify({"ok": True})


@bp.route("/api/favorites", methods=["PUT"])
def api_fav_set_group():
    """修改单条收藏的分组（group 传空 = 移入「其他」）"""
    body = request.get_json(silent=True) or {}
    path = (body.get("path") or "").strip()
    group = (body.get("group") or "").strip()[:50]
    if not path:
        return jsonify({"error": "path 不能为空"}), 400
    with _FAV_LOCK:
        items = _load_favs()
        hit = False
        for it in items:
            if os.path.normpath(it.get("path", "")) == os.path.normpath(path):
                if group:
                    it["group"] = group
                else:
                    it.pop("group", None)
                hit = True
        if not hit:
            return jsonify({"error": "收藏不存在"}), 404
        _save_favs(items)
        if group:
            groups = _load_groups()
            _ensure_group(groups, group)
            _save_groups(groups)
    return jsonify({"ok": True})


@bp.route("/api/favorites/group", methods=["POST", "PUT", "DELETE"])
def api_fav_group():
    """POST: 新建分组（{name}）/ 重命名分组（{old, name}）
    PUT: 保存分组拖动排序（{groups: [...]}，可含 "__ungrouped__" 标记「其他」位置）
    DELETE: 删除分组（{name}，收藏保留变为未分组）"""
    if request.method == "PUT":
        body = request.get_json(silent=True) or {}
        groups = []
        for g in (body.get("groups") or []):
            g = str(g).strip()[:50]
            if g and g not in groups:
                groups.append(g)
        _save_groups(groups)
        return jsonify({"ok": True})
    body = request.get_json(silent=True) or {}
    name = (body.get("name") or "").strip()[:50]
    if not name:
        return jsonify({"error": "分组名不能为空"}), 400
    with _FAV_LOCK:
        items = _load_favs()
        groups = _load_groups()
        if request.method == "POST":
            old = (body.get("old") or "").strip()
            if old:
                # 重命名分组
                changed = 0
                for it in items:
                    if (it.get("group") or "") == old:
                        it["group"] = name
                        changed += 1
                if not changed and old not in groups:
                    return jsonify({"error": "分组不存在"}), 404
                had = old in groups
                groups = [name if g == old else g for g in groups]
                if not had and name not in groups:
                    groups.append(name)
            else:
                # 新建空分组
                if name in groups or any((it.get("group") or "") == name for it in items):
                    return jsonify({"error": "分组已存在"}), 400
                _ensure_group(groups, name)
        else:
            # 删除分组：收藏保留（变为未分组）
            changed = 0
            for it in items:
                if (it.get("group") or "") == name:
                    it.pop("group", None)
                    changed += 1
            if not changed and name not in groups:
                return jsonify({"error": "分组不存在"}), 404
            groups = [g for g in groups if g != name]
        _save_favs(items)
        _save_groups(groups)
    return jsonify({"ok": True})


def _make_thumb_etag(target_path):
    """根据文件的 mtime + size 生成 ETag，文件未修改时浏览器可直接复用缓存"""
    try:
        st = os.stat(target_path)
        return '"%x-%x"' % (int(st.st_mtime), int(st.st_size))
    except OSError:
        return None


@bp.route("/api/thumbnail")
def api_thumbnail():
    """获取文件缩略图（图片直接返回，视频提取帧）

    支持强缓存：源文件未修改（mtime/size 不变）时返回 304，
    浏览器不再重复请求解码，避免每次刷新都走 ffmpeg 抽帧。
    """
    target_path = _get_file_path_from_request(request)
    if target_path is None:
        _log.info("GET /api/thumbnail -> 404 (文件不存在)")
        return jsonify({"error": "文件不存在"}), 404

    etag = _make_thumb_etag(target_path)
    # 协商缓存：命中即返回 304，不传输数据
    if etag and request.headers.get("If-None-Match") == etag:
        resp = FlaskResponse(status=304)
        resp.headers["ETag"] = etag
        resp.headers["Cache-Control"] = "public, max-age=604800"
        return resp

    data, content_type = _get_thumbnail_bytes(target_path)
    if data is None:
        return jsonify({"error": "无法生成缩略图"}), 400

    resp = FlaskResponse(data, status=200, content_type=content_type)
    # 强缓存 7 天；文件改变时 ETag 变化会自动失效，故缓存期可设较长
    resp.headers["Cache-Control"] = "public, max-age=604800"
    if etag:
        resp.headers["ETag"] = etag
    return resp


def _thumb_cache_stats():
    """统计磁盘缩略图缓存条目数与占用大小"""
    count = 0
    total = 0
    try:
        with os.scandir(_THUMB_CACHE_DIR) as it:
            for e in it:
                if not e.name.endswith(".bin"):
                    continue
                try:
                    total += e.stat().st_size
                    count += 1
                except OSError:
                    continue
    except OSError:
        pass
    return count, total


@bp.route("/api/thumbnail/cache")
def api_thumbnail_cache_info():
    """查询缩略图缓存占用情况"""
    count, total = _thumb_cache_stats()
    return jsonify({
        "entries": count,
        "size": total,
        "size_str": format_size(total) if total else "0 B",
        "dir": _THUMB_CACHE_DIR,
    })


@bp.route("/api/thumbnail/cache/clear", methods=["POST"])
def api_thumbnail_cache_clear():
    """清空缩略图缓存（内存 + 磁盘），下次访问会重新生成"""
    _clear_thumb_cache()
    return jsonify({"ok": True, "message": "缩略图缓存已清空"})


@bp.route("/api/raw")
def api_raw():
    """原图直出（图片预览缩放用）：send_file 条件请求支持 Range / 304"""
    target_path = _get_file_path_from_request(request)
    if target_path is None:
        return jsonify({"error": "文件不存在"}), 404

    ext = os.path.splitext(target_path)[1].lower().lstrip(".")
    if ext not in _IMAGE_EXTS:
        return jsonify({"error": "该文件类型不支持"}), 400

    try:
        mime_type, _ = mimetypes.guess_type(target_path)
        if not mime_type:
            mime_type = f"image/{ext}"
        resp = send_file(target_path, mimetype=mime_type, conditional=True)
        resp.headers["Accept-Ranges"] = "bytes"
        return resp
    except (OSError, PermissionError) as e:
        return jsonify({"error": f"无法读取文件: {str(e)}"}), 500


@bp.route("/api/stream")
def api_stream():
    _log.info("GET /api/stream")
    """音视频流式传输，支持 HTTP Range 请求（可暂停/拖进度/缓冲播放）"""
    target_path = _get_file_path_from_request(request)
    if target_path is None:
        return jsonify({"error": "文件不存在"}), 404

    ext = os.path.splitext(target_path)[1].lower().lstrip(".")
    is_audio = ext in _AUDIO_EXTS
    if ext not in _VIDEO_EXTS and not is_audio:
        return jsonify({"error": "该文件类型不支持流式播放"}), 400

    try:
        mime_type, _ = mimetypes.guess_type(target_path)
        if not mime_type:
            mime_type = (f"audio/{ext}" if is_audio else f"video/{ext}")

        # conditional=True 由 Flask/Werkzeug 标准实现处理 Range 请求：
        # 无 Range → 200 全量；"bytes=0-" / "100-200" / "-500"（后缀区间，探测
        # mp4 片尾 moov 用）→ 206 正确分片；非法区间 → 416。
        # 旧手写解析不认后缀区间，导致播放器拿不到片尾数据而反复重试。
        resp = send_file(target_path, mimetype=mime_type, conditional=True)
        resp.headers["Accept-Ranges"] = "bytes"
        return resp

    except (OSError, PermissionError) as e:
        return jsonify({"error": f"无法读取文件: {str(e)}"}), 500


@bp.route("/api/download")
def api_download():
    """通用附件下载：send_file 自动带 Content-Length，前端据此计算实时进度"""
    _log.info("GET /api/download")
    target_path = _get_file_path_from_request(request)
    if target_path is None:
        return jsonify({"error": "文件不存在"}), 404
    if not os.path.isfile(target_path):
        return jsonify({"error": "仅支持下载文件"}), 400
    try:
        return send_file(target_path, as_attachment=True, conditional=True)
    except (OSError, PermissionError) as e:
        return jsonify({"error": f"无法读取文件: {str(e)}"}), 500

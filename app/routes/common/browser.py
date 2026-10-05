"""浏览/预览/缩略图/视频流转发路由。"""
import os
import re
import sys
import json
import time
import threading
import subprocess
import mimetypes
import base64

from flask import Blueprint, request, jsonify, send_file, render_template, Response as FlaskResponse
from urllib.parse import quote

from ...config import (
    _TEXT_EXTS, _IMAGE_EXTS, _VIDEO_EXTS,
    _AUDIO_EXTS,
    _PREVIEW_MAX_BYTES, _TEXT_PREVIEW_MAX_BYTES,
    _THUMB_CACHE_DIR, _TEXT_FILENAMES, _DOTFILE_TEXT_STEMS, _STORAGE_DIR,
    FFMPEG_BIN,
)
from ...log import get_logger
from ...services.common.filecore import (
    safe_path, format_size, list_directory, _SIZE_PENDING, _SIZE_PENDING_LOCK,
    _DIR_SIZE_CACHE, _ensure_dir_size_async,
)
from ...services.common.thumbnail import (
    _get_thumbnail_bytes, _get_preview_bytes, _extract_video_frame,
    _clear_disk_cache as _clear_thumb_cache, get_video_duration,
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
    return os.path.join(_STORAGE_DIR, _RECENT_DIR_FILE)


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
        # 路径已失效（目录被删除 / 重命名等）：自动逐级向上回退到最近存在的上级目录，
        # 不再直接报错。前端也会做同一回退，这里作为兜底，让任意客户端（移动端 / IDE / API）都受益。
        cur = target_path
        while cur and not os.path.isdir(cur):
            parent = os.path.dirname(cur)
            if parent == cur:
                break
            cur = parent
        if not cur or not os.path.isdir(cur):
            return jsonify({"error": f"路径不存在或不是目录: {target_path}"}), 400
        target_path = cur
        rel_path = target_path   # 让返回的当前路径反映实际目录

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
        # 链式扩展名匹配：app.log.20260826 / debug.json.bak 这类多段后缀，
        # 只要任一段是已知文本/图片类型就按对应类型处理（日志按天轮转场景）
        segments = [s for s in filename.split(".") if s]
        # 点开头文件（.env / .env.example / .npmrc 等）：splitext 取不到扩展名，
        # 按首段名匹配点文件集合视为文本（.env.example 这类带后缀的变体也命中）
        is_dotfile_text = filename.startswith(".") and segments and segments[0] in _DOTFILE_TEXT_STEMS
        is_text = (ext in _TEXT_EXTS or filename in _TEXT_FILENAMES
                   or any(seg in _TEXT_EXTS for seg in segments[1:])
                   or is_dotfile_text)
        is_image = ext in _IMAGE_EXTS or any(seg in _IMAGE_EXTS for seg in segments[1:])
        mime_type, _ = mimetypes.guess_type(target_path)
        if not mime_type:
            mime_type = "application/octet-stream"
        # SQLite 数据库：不做大小限制，返回表清单；数据行由 /api/sqlite/rows 按表分页取
        if ext in _SQLITE_EXTS:
            try:
                tables, stat2 = _sqlite_read_tables(target_path)
            except Exception as e:
                return jsonify({"error": f"无法读取数据库: {str(e)}"}), 500
            return jsonify({
                "type": "sqlite",
                "ext": ext,
                "tables": tables,
                "size": stat2.st_size,
                "size_str": format_size(stat2.st_size),
            })
        # 文本/图片限制：文本 20MB，图片 50MB
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
        # 图片：raw=1 时直接返回图片字节（IDE 内嵌预览使用，前端 <img> 直接引用）
        if is_image and request.args.get("raw") == "1":
            with open(target_path, "rb") as f:
                data = f.read()
            resp = FlaskResponse(data, mimetype=mime_type)
            resp.headers["X-Preview-Type"] = "image"
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
        elif is_image:
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


# ======================================================================
# SQLite 数据库只读预览（db / sqlite / sqlite3 / db3）
# ======================================================================
_SQLITE_EXTS = {"db", "sqlite", "sqlite3", "db3"}
_SQLITE_TABLE_MAX = 200          # 最多列出的表/视图数
_SQLITE_ROWS_DEFAULT = 100       # 每页默认行数
_SQLITE_ROWS_MAX = 500           # 每页最大行数
_SQLITE_CELL_MAX = 1000          # 单元格显示截断长度（避免超大 BLOB/文本撑爆响应）


def _is_sqlite_file(ext):
    return ext in _SQLITE_EXTS


def _sqlite_connect_ro(target_path):
    """以只读 URI 模式打开 SQLite，绝不写入（含 -wal/-shm 伴生文件的库也能安全打开）"""
    import sqlite3
    uri = "file:" + quote(target_path, safe="/") + "?mode=ro"
    con = sqlite3.connect(uri, uri=True, timeout=3)
    return con


def _sqlite_list_tables(cur):
    """列出用户表与视图（排除 sqlite_ 内部表），返回 [(name, type)]"""
    return [(r[0], r[1]) for r in cur.execute(
        "SELECT name, type FROM sqlite_master "
        "WHERE type IN ('table','view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' "
        "ORDER BY type, name").fetchall()]


def _sqlite_quote_ident(name):
    return '"' + str(name).replace('"', '""') + '"'


def _sqlite_cell(v):
    """单元格值序列化：BLOB 尝试文本解码，其余转字符串；超长截断"""
    if v is None or isinstance(v, (int, float)):
        return v
    if isinstance(v, bytes):
        try:
            v = v.decode("utf-8")
        except UnicodeDecodeError:
            v = v[:64].hex() + ("…" if len(v) > 64 else "")
            return f"<BLOB {v}>"
    s = str(v)
    if len(s) > _SQLITE_CELL_MAX:
        s = s[:_SQLITE_CELL_MAX] + f"…（共 {len(s)} 字符）"
    return s


@bp.route("/api/sqlite/tables")
def api_sqlite_tables():
    """列出 SQLite 数据库中的表与视图（含行数与列名）"""
    rel_path = request.args.get("path", "")
    target_path = os.path.abspath(os.path.normpath(rel_path))
    if not os.path.isfile(target_path):
        return jsonify({"error": "文件不存在"}), 404
    if not _is_sqlite_file(os.path.splitext(target_path)[1].lower().lstrip(".")):
        return jsonify({"error": "不是 SQLite 数据库文件"}), 400
    try:
        tables, stat = _sqlite_read_tables(target_path)
        return jsonify({
            "tables": tables,
            "size": stat.st_size,
            "size_str": format_size(stat.st_size),
        })
    except Exception as e:
        return jsonify({"error": f"无法读取数据库: {str(e)}"}), 500


def _sqlite_read_tables(target_path):
    """读取库中全部用户表/视图的行数与列名，返回 (tables, stat)"""
    stat = os.stat(target_path)
    con = _sqlite_connect_ro(target_path)
    cur = con.cursor()
    tables = []
    for name, ttype in _sqlite_list_tables(cur)[:_SQLITE_TABLE_MAX]:
        qn = _sqlite_quote_ident(name)
        try:
            rows = cur.execute(f"SELECT COUNT(*) FROM {qn}").fetchone()[0]
        except Exception:
            rows = None   # 损坏的表（如 page 泄漏）不阻塞整体列表
        try:
            columns = [r[1] for r in cur.execute(f"PRAGMA table_info({qn})").fetchall()]
        except Exception:
            columns = []
        tables.append({"name": name, "kind": ttype, "rows": rows, "columns": columns})
    con.close()
    return tables, stat


@bp.route("/api/sqlite/rows")
def api_sqlite_rows():
    """分页读取某个表/视图的数据（只读）"""
    rel_path = request.args.get("path", "")
    target_path = os.path.abspath(os.path.normpath(rel_path))
    if not os.path.isfile(target_path):
        return jsonify({"error": "文件不存在"}), 404
    table = request.args.get("table", "")
    try:
        limit = min(max(int(request.args.get("limit", _SQLITE_ROWS_DEFAULT)), 1), _SQLITE_ROWS_MAX)
        offset = max(int(request.args.get("offset", 0)), 0)
    except (TypeError, ValueError):
        limit, offset = _SQLITE_ROWS_DEFAULT, 0
    try:
        con = _sqlite_connect_ro(target_path)
        cur = con.cursor()
        # 表名必须真实存在于 sqlite_master，杜绝注入
        real_names = [r[0] for r in cur.execute(
            "SELECT name FROM sqlite_master WHERE type IN ('table','view')")]
        if table not in real_names:
            con.close()
            return jsonify({"error": "表不存在"}), 400
        qn = _sqlite_quote_ident(table)
        columns = [r[1] for r in cur.execute(f"PRAGMA table_info({qn})").fetchall()]
        total = cur.execute(f"SELECT COUNT(*) FROM {qn}").fetchone()[0]
        cur2 = con.execute(f"SELECT * FROM {qn} LIMIT ? OFFSET ?", (limit, offset))
        rows = [[_sqlite_cell(v) for v in row] for row in cur2.fetchall()]
        con.close()
        return jsonify({
            "table": table,
            "columns": columns,
            "rows": rows,
            "total": total,
            "limit": limit,
            "offset": offset,
        })
    except Exception as e:
        return jsonify({"error": f"读取数据失败: {str(e)}"}), 500


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


# ========== 收藏夹（常用文件夹，持久化到 data/storage/favorites.json） ==========
_FAV_LOCK = threading.Lock()
_FAV_MAX = 50


def _fav_file():
    return os.path.join(_STORAGE_DIR, "favorites.json")


def _load_favs():
    try:
        with open(_fav_file(), "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except (OSError, ValueError):
        return []


def _save_favs(items):
    os.makedirs(_STORAGE_DIR, exist_ok=True)
    tmp = _fav_file() + ".tmp%d" % os.getpid()
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(items, f, ensure_ascii=False, indent=1)
    os.replace(tmp, _fav_file())


def _groups_file():
    return os.path.join(_STORAGE_DIR, "fav_groups.json")


def _load_groups():
    """分组展示顺序（拖动排序后持久化）；"__ungrouped__" 表示「其他」分区的位置"""
    try:
        with open(_groups_file(), "r", encoding="utf-8") as f:
            data = json.load(f)
        return [str(g) for g in data] if isinstance(data, list) else []
    except (OSError, ValueError):
        return []


def _save_groups(groups):
    os.makedirs(_STORAGE_DIR, exist_ok=True)
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


@bp.route("/api/video_duration")
def api_video_duration():
    """获取视频时长（秒），供播放列表异步显示；服务端内存缓存，文件未变时秒回"""
    target_path = _get_file_path_from_request(request)
    if target_path is None:
        return jsonify({"error": "文件不存在"}), 404
    ext = os.path.splitext(target_path)[1].lower().lstrip(".")
    if ext not in _VIDEO_EXTS:
        return jsonify({"error": "不是视频文件"}), 400
    dur = get_video_duration(target_path)
    if dur is None:
        return jsonify({"error": "无法获取时长"}), 404
    return jsonify({"duration": round(dur, 1)})


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
        _log.warning("GET /api/raw -> 404 (path=%s)", request.args.get("path", "")[:200])
        return jsonify({"error": "文件不存在"}), 404

    ext = os.path.splitext(target_path)[1].lower().lstrip(".")
    # 除图片外允许 lrc 歌词文本（音乐播放器加载同名歌词用）
    if ext not in _IMAGE_EXTS and ext != "lrc":
        _log.warning("GET /api/raw -> 400 不支持的扩展名: %s (%s)", ext, target_path)
        return jsonify({"error": "该文件类型不支持"}), 400

    try:
        mime_type, _ = mimetypes.guess_type(target_path)
        if not mime_type:
            mime_type = (f"image/{ext}" if ext in _IMAGE_EXTS else "text/plain; charset=utf-8")
        # 原图直出必须禁用缓存/304，避免浏览器复用旧的降采样图
        resp = send_file(target_path, mimetype=mime_type, conditional=False)
        resp.headers["Accept-Ranges"] = "bytes"
        resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate"
        resp.headers["Pragma"] = "no-cache"
        resp.headers["Expires"] = "0"
        return resp
    except (OSError, PermissionError) as e:
        _log.error("GET /api/raw -> 无法读取文件 %s: %s", target_path, e)
        return jsonify({"error": f"无法读取文件: {str(e)}"}), 500


@bp.route("/api/image")
def api_image():
    """图片预览大图：按最长边等比缩放的清晰版（默认 2560px、JPEG 质量 88）。

    动辄几十 MB 的原图（长截图 / 大 GIF）直接给移动端会长时间转圈甚至加载失败，
    这里由服务端降采样后再下发，结果走缩略图同款缓存（带尺寸前缀）。
    原图小于 3MB 时直接原图直出，保留动图效果。
    """
    target_path = _get_file_path_from_request(request)
    if target_path is None:
        _log.info("GET /api/image -> 404 (文件不存在)")
        return jsonify({"error": "文件不存在"}), 404
    try:
        max_side = int(request.args.get("max", 2560))
    except (ValueError, TypeError):
        max_side = 2560
    max_side = max(320, min(4096, max_side))

    # 协商缓存：源文件未修改时直接 304，避免重复解码/传输大图
    etag = _make_thumb_etag(target_path)
    if etag and request.headers.get("If-None-Match") == etag:
        resp = FlaskResponse(status=304)
        resp.headers["ETag"] = etag
        resp.headers["Cache-Control"] = "private, max-age=604800"
        return resp

    data, content_type = _get_preview_bytes(target_path, max_side=max_side)
    if data is None:
        # 降级：若 Pillow 处理失败或文件无法读取，直接返回原图
        try:
            mime_type, _ = mimetypes.guess_type(target_path)
            if not mime_type:
                mime_type = "application/octet-stream"
            with open(target_path, "rb") as f:
                data = f.read()
            content_type = mime_type
        except (OSError, PermissionError) as e:
            _log.warning("GET /api/image -> 无法读取文件: %s", e)
            return jsonify({"error": "该文件类型不支持预览"}), 400
    resp = FlaskResponse(data, status=200, content_type=content_type)
    resp.headers["Cache-Control"] = "private, max-age=604800"
    if etag:
        resp.headers["ETag"] = etag
    return resp


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
        # 允许浏览器缓存 Range 分片（同视频二次打开/回拖时命中本地缓存），
        # 减少重复 206 请求，起播更快
        resp.headers["Cache-Control"] = "public, max-age=86400"
        return resp

    except (OSError, PermissionError) as e:
        return jsonify({"error": f"无法读取文件: {str(e)}"}), 500


# ======================================================================
# 视频实时转码兜底：浏览器解不了视频轨（HEVC/H.265、10bit H.264 等——
# 症状是有声音有时长但没有画面）时，服务端用 ffmpeg 实时转成
# H.264/AAC 的 fMP4 流给播放器。支持 ss 参数（秒或 hh:mm:ss）定位起播。
# ======================================================================
_TRANCODE_SEM = threading.BoundedSemaphore(2)   # 最多同时 2 路转码，防止 CPU 打满


def _parse_ss(v):
    """校验 ss 参数：纯秒数（"12.5"）或 hh:mm:ss(.ms)；合法返回原文，非法返回 None"""
    v = (v or "").strip() or "0"
    if re.fullmatch(r"\d+(\.\d+)?", v) or re.fullmatch(r"(\d{1,3}:)?\d{1,2}:\d{1,2}(\.\d+)?", v):
        return v
    return None


@bp.route("/api/stream_transcode")
def api_stream_transcode():
    target_path = _get_file_path_from_request(request)
    if target_path is None:
        return jsonify({"error": "文件不存在"}), 404
    ext = os.path.splitext(target_path)[1].lower().lstrip(".")
    if ext not in _VIDEO_EXTS:
        return jsonify({"error": "该文件类型不支持转码播放"}), 400
    ss = _parse_ss(request.args.get("ss"))
    if ss is None:
        return jsonify({"error": "ss 参数非法"}), 400

    cmd = [
        FFMPEG_BIN, "-hide_banner", "-loglevel", "error",
        "-ss", ss, "-i", target_path,
        # 视频：H.264 兼容 8bit，1280 内缩放 + veryfast 控制转码延迟与 CPU 占用
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "26",
        "-pix_fmt", "yuv420p", "-vf", "scale='min(iw,1280)':-2",
        # 音频：AAC 立体声（浏览器全支持）
        "-c:a", "aac", "-b:a", "128k", "-ac", "2",
        # fMP4 分片输出：边转边播，无需等整体转完
        "-movflags", "frag_keyframe+empty_moov+default_base_moof",
        "-f", "mp4", "pipe:1",
    ]

    def generate():
        with _TRANCODE_SEM:                 # 并发上限，超出的排队等待
            proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            try:
                while True:
                    chunk = proc.stdout.read(64 * 1024)
                    if not chunk:
                        break
                    yield chunk
            finally:
                # 客户端断开 / 切换视频 → 立即杀掉 ffmpeg，不留后台转码进程
                try:
                    if proc.poll() is None:
                        proc.kill()
                except Exception:
                    pass
                try:
                    if proc.stdout:
                        proc.stdout.close()
                except Exception:
                    pass

    resp = FlaskResponse(generate(), mimetype="video/mp4")
    resp.headers["Cache-Control"] = "no-store"   # 转码结果不缓存（带 ss 定位，且不可 Range）
    resp.headers["X-Transcoded"] = "1"
    return resp


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


# ======================================================================
# 电子表格查看 / 编辑（xlsx / xlsm / xls / et / csv / tsv）
#   xlsx/xlsm/xltx/xltm：openpyxl 读写（保留其余工作表与格式）
#   xls / et（WPS 表格）：xlrd 只读（BIFF8），不支持写回，需另存为 xlsx
#   csv / tsv：标准库读写
#   数据以二维数组返回；超大表按行列上限截断，避免响应过大
# ======================================================================
_SHEET_WRITE_EXTS = {"xlsx", "xlsm", "xltx", "xltm"}
_SHEET_RO_EXTS = {"xls", "et", "ett"}
_SHEET_CSV_EXTS = {"csv", "tsv"}
_SHEET_ALL_EXTS = _SHEET_WRITE_EXTS | _SHEET_RO_EXTS | _SHEET_CSV_EXTS
_SHEET_MAX_ROWS = 3000
_SHEET_MAX_COLS = 300


def _sheet_ext_of(path):
    return os.path.splitext(path)[1].lower().lstrip(".")


def _sheet_cell_str(v):
    """单元格值 → 前端可显示字符串（整数浮点去掉 .0）。"""
    if v is None:
        return ""
    if isinstance(v, bool):
        return "TRUE" if v else "FALSE"
    if isinstance(v, float):
        return str(int(v)) if v.is_integer() else repr(v)
    return str(v)


def _sheet_coerce(v):
    """字符串转回单元格值：空→None，纯整数/浮点→数字，其余→字符串。"""
    if v is None or isinstance(v, (int, float, bool)):
        return v
    s = str(v).strip()
    if s == "":
        return None
    try:
        return int(s)
    except ValueError:
        pass
    try:
        return float(s)
    except ValueError:
        pass
    return s


def _sheet_read_xlsx(path, sheet_name):
    import openpyxl
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    try:
        names = list(wb.sheetnames)
        ws = wb[sheet_name] if sheet_name in names else wb[names[0]]
        data, truncated = [], False
        for i, row in enumerate(ws.iter_rows(values_only=True)):
            if i >= _SHEET_MAX_ROWS:
                truncated = True
                break
            data.append([_sheet_cell_str(v) for v in row[:_SHEET_MAX_COLS]])
        return names, ws.title, data, truncated
    finally:
        wb.close()


def _sheet_read_xls(path, sheet_name):
    """xls / et（WPS BIFF8）：xlrd 读取，只读。"""
    import xlrd
    with open(path, "rb") as f:
        wb = xlrd.open_workbook(file_contents=f.read())
    names = wb.sheet_names()
    ws = wb.sheet_by_name(sheet_name) if sheet_name in names else wb.sheet_by_index(0)
    rows = min(ws.nrows, _SHEET_MAX_ROWS)
    cols = min(ws.ncols, _SHEET_MAX_COLS)
    data = [[_sheet_cell_str(ws.cell_value(r, c)) for c in range(cols)] for r in range(rows)]
    truncated = ws.nrows > _SHEET_MAX_ROWS or ws.ncols > _SHEET_MAX_COLS
    return names, ws.name, data, truncated


def _sheet_read_csv(path, ext):
    import csv as _csv
    with open(path, "r", encoding="utf-8-sig", errors="replace", newline="") as f:
        reader = _csv.reader(f, delimiter=("\t" if ext == "tsv" else ","))
        data, truncated = [], False
        for i, row in enumerate(reader):
            if i >= _SHEET_MAX_ROWS:
                truncated = True
                break
            data.append([str(v) for v in row[:_SHEET_MAX_COLS]])
    return ["Sheet1"], "Sheet1", data, truncated


@bp.route("/api/sheet/read")
def api_sheet_read():
    """读取表格文件，返回工作表清单 + 当前表二维数据。"""
    rel_path = request.args.get("path", "")
    target_path = os.path.abspath(os.path.normpath(rel_path))
    if not os.path.isfile(target_path):
        return jsonify({"error": "文件不存在"}), 404
    ext = _sheet_ext_of(target_path)
    if ext not in _SHEET_ALL_EXTS:
        return jsonify({"error": "不支持的表格类型: " + ext}), 400
    sheet_name = request.args.get("sheet") or None
    try:
        if ext in _SHEET_WRITE_EXTS:
            names, active, data, trunc = _sheet_read_xlsx(target_path, sheet_name)
        elif ext in _SHEET_RO_EXTS:
            names, active, data, trunc = _sheet_read_xls(target_path, sheet_name)
        else:
            names, active, data, trunc = _sheet_read_csv(target_path, ext)
    except ImportError as e:
        return jsonify({"error": "缺少解析库（%s），请安装 openpyxl / xlrd" % e.name}), 500
    except Exception as e:
        return jsonify({"error": "读取表格失败：" + str(e)}), 500
    writable = ext in _SHEET_WRITE_EXTS or ext in _SHEET_CSV_EXTS
    return jsonify({
        "ok": True,
        "ext": ext,
        "sheets": names,
        "active": active,
        "rows": len(data),
        "cols": max((len(r) for r in data), default=0),
        "data": data,
        "truncated": trunc,
        "writable": writable,
        "is_csv": ext in _SHEET_CSV_EXTS,
        "max_rows": _SHEET_MAX_ROWS,
        "max_cols": _SHEET_MAX_COLS,
    })


@bp.route("/api/sheet/write", methods=["POST"])
def api_sheet_write():
    """保存表格编辑：changes=[[r,c,v]...] 单元格补丁；csv/tsv 可传 data 全量。"""
    body = request.get_json(silent=True) or {}
    target_path = os.path.abspath(os.path.normpath(body.get("path", "")))
    if not os.path.isfile(target_path):
        return jsonify({"error": "文件不存在"}), 404
    ext = _sheet_ext_of(target_path)
    sheet_name = body.get("sheet") or None
    changes = body.get("changes") or []
    data = body.get("data")
    if ext in _SHEET_RO_EXTS:
        return jsonify({"error": "该格式（.%s）为只读，不支持直接保存，请另存为 .xlsx 后再编辑" % ext}), 400
    try:
        if ext in _SHEET_WRITE_EXTS:
            _sheet_write_xlsx(target_path, sheet_name, changes, data)
        elif ext in _SHEET_CSV_EXTS:
            _sheet_write_csv(target_path, ext, data, changes)
        else:
            return jsonify({"error": "不支持的表格类型: " + ext}), 400
    except ImportError as e:
        return jsonify({"error": "缺少解析库（%s），请安装 openpyxl" % e.name}), 500
    except Exception as e:
        return jsonify({"error": "保存表格失败：" + str(e)}), 500
    return jsonify({"ok": True})


def _sheet_write_xlsx(path, sheet_name, changes, data):
    import openpyxl
    wb = openpyxl.load_workbook(path, data_only=False)
    names = wb.sheetnames
    ws = wb[sheet_name] if sheet_name in names else wb[names[0]]
    if data is not None:
        if ws.max_row > 0:
            ws.delete_rows(1, ws.max_row)
        for r, row in enumerate(data, start=1):
            for c, v in enumerate(row, start=1):
                ws.cell(row=r, column=c).value = _sheet_coerce(v)
    for ch in changes:
        try:
            r, c, v = int(ch[0]) + 1, int(ch[1]) + 1, ch[2]
        except (TypeError, ValueError, IndexError):
            continue
        ws.cell(row=r, column=c).value = _sheet_coerce(v)
    wb.save(path)


def _sheet_write_csv(path, ext, data, changes):
    import csv as _csv
    if data is None:
        _, _, data, _ = _sheet_read_csv(path, ext)
        for ch in changes:
            try:
                r, c, v = int(ch[0]), int(ch[1]), ch[2]
            except (TypeError, ValueError, IndexError):
                continue
            while len(data) <= r:
                data.append([])
            while len(data[r]) <= c:
                data[r].append("")
            data[r][c] = "" if v is None else str(v)
    with open(path, "w", encoding="utf-8", newline="") as f:
        w = _csv.writer(f, delimiter=("\t" if ext == "tsv" else ","))
        for row in data:
            w.writerow(["" if v is None else v for v in row])

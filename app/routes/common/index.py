"""全盘搜索与索引管理路由。"""
import os
import sys
import time
import threading
import uuid

from flask import Blueprint, request, jsonify

from ...log import get_logger
from ...services.common.indexer import (
    _build_index, _cancel_index_scan, _get_index_meta, _query_index,
    _search_walk, _load_detail_stats, _load_scanning_detail_stats, _get_chart_stats,
    _query_media_collection,
    _INDEX_META, _SEARCH_RESULTS, _SEARCH_LOCK,
)
from ...services.common.filecore import format_size


_log = get_logger()
bp = Blueprint("index", __name__)





@bp.route("/api/search")
def api_search():
    _log.info("GET /api/search keyword=%s", request.args.get("keyword", ""))
    """全盘搜索：优先使用索引，索引不可用时回退到文件系统遍历。"""
    root = request.args.get("root", "").strip()
    keyword = request.args.get("keyword", "").strip()
    ext_filter = request.args.get("ext", "").strip()
    type_filter = request.args.get("type", "").strip()  # "目录" / "文件"
    timeout = request.args.get("timeout", "60")
    use_index = request.args.get("use_index", "auto")  # auto / force / never
    # 需要跳过的目录名（逗号分隔），IDE 搜索用它排除 node_modules/dist 等
    skip_dirs = [s.strip() for s in request.args.get("skip", "").split(",") if s.strip()]
    skip_l = {s.lower() for s in skip_dirs}
    # case=1 表示关键字区分大小写（默认不区分）
    case_sensitive = request.args.get("case", "").strip() in ("1", "true", "yes", "on")
    # 文件大小筛选（字节，0 = 该侧不限），只作用于文件
    try:
        min_size = max(0, int(request.args.get("min_size", 0) or 0))
    except (ValueError, TypeError):
        min_size = 0
    try:
        max_size = max(0, int(request.args.get("max_size", 0) or 0))
    except (ValueError, TypeError):
        max_size = 0

    if not keyword:
        return jsonify({"error": "搜索关键字不能为空"}), 400

    try:
        timeout = int(timeout)
        if timeout < 5 or timeout > 300:
            timeout = 60
    except (ValueError, TypeError):
        timeout = 60

    # 优先尝试索引（索引用 SQL LIKE，无法保证区分大小写，故 case=1 时直接走遍历）
    if use_index != "never" and not case_sensitive:
        meta = _get_index_meta()
        if meta["total_files"] > 0 and use_index in ("auto", "force"):
            t0 = time.monotonic()
            items = _query_index(keyword, ext_filter, type_filter, limit=5000,
                                 min_size=min_size, max_size=max_size)
            # 限定搜索根目录时，过滤索引结果
            if root:
                root_abs = os.path.abspath(os.path.normpath(root))
                if not os.path.isdir(root_abs):
                    return jsonify({"error": f"搜索根目录不存在: {root}"}), 400
                root_n = os.path.normcase(root_abs)
                prefix_n = os.path.normcase(root_abs.rstrip(os.sep) + os.sep)
                filtered = []
                for it in items:
                    p = str(it.get("path", "")).rstrip(os.sep)
                    if os.path.normcase(p) == root_n or os.path.normcase(p).startswith(prefix_n):
                        filtered.append(it)
                items = filtered
            if skip_l:
                def _has_skip(it):
                    segs = str(it.get("path", "")).replace("\\", "/").split("/")
                    return any(s.lower() in skip_l for s in segs)
                items = [it for it in items if not _has_skip(it)]
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
            items, status = _search_walk(root, keyword, ext_filter, type_filter, timeout, stop_event,
                                         max_results=5000, skip_dirs=skip_dirs,
                                         case_sensitive=case_sensitive,
                                         min_size=min_size, max_size=max_size)
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


@bp.route("/api/search/<token>")
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


@bp.route("/api/index/meta")
def api_index_meta():
    _log.info("GET /api/index/meta")
    """获取索引元信息"""
    return jsonify(_get_index_meta())


@bp.route("/api/index/detail")
def api_index_detail():
    _log.info("GET /api/index/detail")
    """获取索引详细信息（多级缓存：进程内存 → DB预计算 → 实时计算）"""
    meta = _get_index_meta()
    detail = dict(meta)

    # 扫描期间：优先用旧索引统计（无旧索引时从临时库节流计算实时统计），
    # 配合前端 2 秒轮询实现动态更新；新索引完成替换后切换为最终数据
    try:
        if meta.get("status") == "scanning":
            cached = _load_scanning_detail_stats()
        else:
            cached = _load_detail_stats()
    except Exception:
        cached = {}
    detail["top_dirs"] = [dict(d, size_str=format_size(d["size"])) for d in cached.get("top_dirs", [])]
    detail["type_distribution"] = [dict(d, size_str=format_size(d["size"])) for d in cached.get("type_distribution", [])]
    detail["top_files"] = [dict(d, size_str=format_size(d["size"])) for d in cached.get("top_files", [])]

    return jsonify(detail)


@bp.route("/api/index/charts")
def api_index_charts():
    _log.info("GET /api/index/charts")
    """可视化图表统计数据（类型分布/大小分布/时间分布/Top 目录/最大文件）"""
    return jsonify(_get_chart_stats())


@bp.route("/api/media/collection")
def api_media_collection():
    _log.info("GET /api/media/collection type=%s", request.args.get("type", "all"))
    """媒体集合（视频/音频/图片），基于索引聚合，按大小倒序分页查询。
    参数：type / keyword / page(从1开始) / page_size(默认48, 上限200)
    """
    media_type = (request.args.get("type", "all").strip() or "all").lower()
    if media_type not in ("all", "video", "audio", "image"):
        media_type = "all"
    keyword = request.args.get("keyword", "").strip()
    try:
        page = max(1, int(request.args.get("page", 1)))
    except (ValueError, TypeError):
        page = 1
    try:
        page_size = min(200, max(1, int(request.args.get("page_size", 48))))
    except (ValueError, TypeError):
        page_size = 48
    # 大小过滤（字节，0 = 不限）
    try:
        min_size = max(0, int(request.args.get("min_size", 0) or 0))
    except (ValueError, TypeError):
        min_size = 0
    try:
        max_size = max(0, int(request.args.get("max_size", 0) or 0))
    except (ValueError, TypeError):
        max_size = 0
    # 分类级区间：形如 video:1048576-0,image:102400-0（0 = 该侧不限），
    # 让「全部」视图按各分类自己的规则过滤后合并统计
    cat_filters = {}
    for part in (request.args.get("filters", "") or "").split(","):
        part = part.strip()
        if ":" not in part:
            continue
        cat, _, rng = part.partition(":")
        cat = cat.strip().lower()
        if cat not in ("video", "audio", "image"):
            continue
        mn_s, _, mx_s = rng.partition("-")
        try:
            cmn = max(0, int(float(mn_s or 0)))
            cmx = max(0, int(float(mx_s or 0)))
        except (ValueError, TypeError):
            continue
        if cmn or cmx:
            cat_filters[cat] = (cmn, cmx)
    return jsonify(_query_media_collection(media_type, keyword, page, page_size,
                                           min_size, max_size, cat_filters))


@bp.route("/api/index/build", methods=["POST"])
def api_index_build():
    _log.info("POST /api/index/build")
    """手动触发索引构建"""
    data = request.get_json(silent=True) or {}
    roots = data.get("roots", "").strip()
    result = _build_index(roots)
    return jsonify(result)


@bp.route("/api/index/cancel", methods=["POST"])
def api_index_cancel():
    _log.info("POST /api/index/cancel")
    """取消索引扫描"""
    _cancel_index_scan()
    return jsonify({"success": True, "status": "cancelled"})


@bp.route("/api/index/status")
def api_index_status():
    _log.info("GET /api/index/status")
    """获取索引扫描状态"""
    return jsonify({
        "status": _INDEX_META.get("status", "idle"),
        "progress": _INDEX_META.get("progress", 0),
        "status_detail": _INDEX_META.get("status_detail", ""),
        "total_files": _INDEX_META.get("total_files", 0),
        "scanned_files": _INDEX_META.get("scanned_files", 0),
    })

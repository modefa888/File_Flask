"""全盘搜索与索引管理路由。"""
import os
import sys
import time
import threading
import uuid

from flask import Blueprint, request, jsonify

from ...log import get_logger
from ...services.common.indexer import (
    _build_index, _cancel_index_scan, _clear_index, _get_index_meta, _query_index,
    _search_walk, _load_detail_stats, _load_scanning_detail_stats, _get_chart_stats,
    _query_media_collection,
    _INDEX_META, _SEARCH_RESULTS, _SEARCH_LOCK,
)
from ...services.common.filecore import format_size


_log = get_logger()
bp = Blueprint("index", __name__)

_SEARCH_TTL = 600.0          # 搜索记录保留 10 分钟（轮询结束 / 页面关掉后无需长留）
_INDEX_SEARCH_CACHE = {}     # (关键字/筛选/根目录/索引代次) -> (时间, items, error)
_INDEX_SEARCH_TTL = 180.0    # 相同条件的索引搜索结果复用 3 分钟
_INDEX_SEARCH_MAX = 16


def _new_search_token(source):
    """登记一个搜索任务并返回 token（顺带清理过期记录，避免内存无限增长）。"""
    token = uuid.uuid4().hex[:16]
    now = time.time()
    with _SEARCH_LOCK:
        for k in [k for k, v in _SEARCH_RESULTS.items()
                  if now - v.get("created", 0) > _SEARCH_TTL]:
            _SEARCH_RESULTS.pop(k, None)
        _SEARCH_RESULTS[token] = {
            "items": [], "done": False, "error": None, "count": 0,
            "duration": 0, "cancelled": False, "source": source, "created": now,
        }
    return token


def _match_skip(path, skip_l):
    """路径中是否包含需要跳过的目录（node_modules / dist …）。"""
    if not skip_l:
        return False
    segs = str(path).replace("\\", "/").split("/")
    return any(s.lower() in skip_l for s in segs)





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
            if root:
                root_abs = os.path.abspath(os.path.normpath(root))
                if not os.path.isdir(root_abs):
                    return jsonify({"error": f"搜索根目录不存在: {root}"}), 400

            # 索引库有几百万行，LIKE '%关键字%' 是整表扫描，单次可能要几十秒。
            # 这里改成和「实时遍历」一样的任务制：先返回 token，前端轮询取结果，
            # 避免浏览器 20 秒 AbortController 超时后误报「搜索请求超时」。
            token = _new_search_token("index")

            def _run_index():
                t0 = time.monotonic()
                items, err = [], None
                last_push = [0.0]

                def _on_progress(n):
                    # 最多每 0.3 秒写一次，避免频繁抢 _SEARCH_LOCK
                    now = time.monotonic()
                    if now - last_push[0] < 0.3:
                        return
                    last_push[0] = now
                    with _SEARCH_LOCK:
                        rec = _SEARCH_RESULTS.get(token)
                        if rec is not None:
                            rec["scanned"] = n
                            rec["duration"] = round(now - t0, 2)

                def _on_tick():
                    # 扫描期间的心跳：没有匹配项时，前端至少能看到「耗时」在走
                    now = time.monotonic()
                    if now - last_push[0] < 0.4:
                        return
                    last_push[0] = now
                    with _SEARCH_LOCK:
                        rec = _SEARCH_RESULTS.get(token)
                        if rec is not None:
                            rec["duration"] = round(now - t0, 2)

                # 相同条件（同一索引代次）的搜索短时间内复用结果：
                # 全盘扫一遍要几十秒，用户重复点「搜索」不该再等一次
                cache_key = (keyword.lower(), ext_filter, type_filter, min_size, max_size,
                             root, tuple(sorted(skip_l)), meta.get("total_files"))
                try:
                    hit = _INDEX_SEARCH_CACHE.get(cache_key)
                    if hit and time.time() - hit[0] < _INDEX_SEARCH_TTL:
                        items, err = hit[1], hit[2]
                    else:
                        # 结果上限 1000：再往上意义不大，但会把「常见关键字」拖成整表扫描
                        items, timed_out = _query_index(
                            keyword, ext_filter, type_filter, limit=1000,
                            min_size=min_size, max_size=max_size,
                            root=root, timeout=timeout, on_progress=_on_progress,
                            on_tick=_on_tick)
                        if skip_l:
                            items = [it for it in items if not _match_skip(it.get("path", ""), skip_l)]
                        if timed_out:
                            err = "搜索超时，已显示部分结果"
                        else:
                            if len(_INDEX_SEARCH_CACHE) > _INDEX_SEARCH_MAX:
                                _INDEX_SEARCH_CACHE.clear()
                            _INDEX_SEARCH_CACHE[cache_key] = (time.time(), items, err)
                except Exception as e:
                    _log.warning("索引搜索失败：%s", e)
                    err = f"error: {e}"
                with _SEARCH_LOCK:
                    rec = _SEARCH_RESULTS.get(token)
                    if rec is not None:
                        rec["items"] = items
                        rec["count"] = len(items)
                        rec["done"] = True
                        rec["error"] = err
                        rec["duration"] = round(time.monotonic() - t0, 2)

            threading.Thread(target=_run_index, daemon=True).start()
            return jsonify({"token": token, "source": "index", "status": "running"})

    # 回退到文件系统遍历
    if not root:
        if sys.platform.startswith("win"):
            root = os.environ.get("SystemDrive", "C:") + "\\"
        else:
            root = "/"
    root = os.path.abspath(os.path.normpath(root))
    if not os.path.isdir(root):
        return jsonify({"error": f"搜索根目录不存在: {root}"}), 400

    token = _new_search_token("walk")

    stop_event = threading.Event()
    timed_out = threading.Event()

    def _expire():
        timed_out.set()
        stop_event.set()

    timer = threading.Timer(timeout, _expire)
    timer.daemon = True
    timer.start()

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
                err = "搜索超时，已显示部分结果" if timed_out.is_set() else None
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
        finally:
            timer.cancel()

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
        "source": rec.get("source", "walk"),
        "count": rec["count"],
        "scanned": rec.get("scanned", 0),
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
    detail["size_buckets"] = [dict(d, size_str=format_size(d["size"])) for d in cached.get("size_buckets", [])]

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
    # 按具体扩展名过滤（如 webm,mp4），仅当扩展名属于目标分类时才生效
    ext_filter = (request.args.get("ext", "") or "").strip().lower()
    return jsonify(_query_media_collection(media_type, keyword, page, page_size,
                                           min_size, max_size, cat_filters,
                                           ext_filter=ext_filter or None))


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


@bp.route("/api/index/clear", methods=["POST"])
def api_index_clear():
    _log.info("POST /api/index/clear")
    """清空索引数据库（主库 + 临时库 + WAL/SHM），清空后不会自动重建，
    只有再次手动触发 /api/index/build 完成扫描才会重新生成。"""
    result = _clear_index()
    if not result.get("success"):
        return jsonify(result), 409
    return jsonify(result)


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

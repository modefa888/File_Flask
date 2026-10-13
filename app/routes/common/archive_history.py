"""压缩 / 解压历史路由。"""
from flask import Blueprint, jsonify, request

from ...log import get_logger
from ...services.common.archive_history import (
    _ARCHIVE_HISTORY_LOCK,
    _load as _load_archive_history,
    _save as _save_archive_history,
)

bp = Blueprint("archive_history", __name__)
_log = get_logger()


def _row_match(row, q):
    """不区分大小写地在所有基础类型字段中做子串匹配（用于关键字搜索）。"""
    if not q:
        return True
    for v in row.values():
        if isinstance(v, (str, int, float, bool)):
            if q in str(v).lower():
                return True
    return False


@bp.route("/api/archive-history")
def api_archive_history():
    """获取压缩 / 解压历史（支持关键字搜索与分页）。"""
    _log.info("GET /api/archive-history")
    q = (request.args.get("q") or "").strip().lower()
    try:
        page = max(1, int(request.args.get("page", 1)))
        size = max(1, min(200, int(request.args.get("page_size", 10))))
    except (TypeError, ValueError):
        page, size = 1, 10
    with _ARCHIVE_HISTORY_LOCK:
        items = _load_archive_history()
    items.reverse()
    if q:
        items = [i for i in items if _row_match(i, q)]
    total = len(items)
    start = (page - 1) * size
    return jsonify({"items": items[start:start + size], "total": total, "count": total})


@bp.route("/api/archive-history/one", methods=["DELETE"])
def api_archive_history_one():
    _log.info("DELETE /api/archive-history/one")
    data = request.get_json(silent=True) or {}
    rid = (data.get("id") or "").strip()
    if not rid:
        return jsonify({"error": "缺少记录 ID"}), 400
    with _ARCHIVE_HISTORY_LOCK:
        items = _load_archive_history()
        kept = [x for x in items if x.get("id") != rid]
        if len(kept) == len(items):
            return jsonify({"error": "记录不存在"}), 404
        _save_archive_history(kept)
    return jsonify({"success": True})


@bp.route("/api/archive-history/clear", methods=["POST"])
def api_archive_history_clear():
    _log.info("POST /api/archive-history/clear")
    with _ARCHIVE_HISTORY_LOCK:
        removed = len(_load_archive_history())
        _save_archive_history([])
    return jsonify({"success": True, "removed": removed})

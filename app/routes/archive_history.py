"""压缩 / 解压历史路由。"""
from flask import Blueprint, jsonify, request

from ..log import get_logger
from ..services.archive_history import (
    _ARCHIVE_HISTORY_LOCK,
    _load as _load_archive_history,
    _save as _save_archive_history,
)

bp = Blueprint("archive_history", __name__)
_log = get_logger()


@bp.route("/api/archive-history")
def api_archive_history():
    _log.info("GET /api/archive-history")
    with _ARCHIVE_HISTORY_LOCK:
        items = _load_archive_history()
    items.reverse()
    return jsonify({"items": items, "count": len(items)})


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

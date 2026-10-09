"""文件说明（自定义）接口。

special_hints.json 提供内置「基础说明」（只读，随代码维护）；这里读写界面上补充的说明（存 store.db，
与基础说明在前端合并、自定义优先）。

GET    /api/file_hints            列出全部自定义说明 {hints: {name: text}}
POST   /api/file_hints            保存 / 更新一条 {name, hint}；hint 为空 = 删除该自定义项
DELETE /api/file_hints?name=xxx   删除一条自定义说明
"""
from flask import Blueprint, request, jsonify

from ...services.common import hints_db

bp = Blueprint("file_hints", __name__)


@bp.route("/api/file_hints", methods=["GET"])
def api_file_hints_list():
    return jsonify({"hints": hints_db.load_hints()})


@bp.route("/api/file_hints", methods=["POST"])
def api_file_hints_save():
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()
    if not name:
        return jsonify({"error": "缺少 name 参数"}), 400
    hints_db.set_hint(name, data.get("hint") or "")
    return jsonify({"ok": True, "hints": hints_db.load_hints()})


@bp.route("/api/file_hints", methods=["DELETE"])
def api_file_hints_delete():
    name = (request.args.get("name") or "").strip()
    if not name:
        return jsonify({"error": "缺少 name 参数"}), 400
    hints_db.delete_hint(name)
    return jsonify({"ok": True, "hints": hints_db.load_hints()})

"""AI 对话历史 REST API：后端持久化（SQLite）。

GET  /api/ai/sessions                会话列表（不含消息）+ 当前会话 id
GET  /api/ai/sessions/<id>           单会话完整内容（含消息）
POST /api/ai/sessions                新建/追加保存会话：{id, title, extra, msgs:[{mid,role,text,images,reasoning,meta}], deleted:[mid...]}
DELETE /api/ai/sessions/<id>         删除会话及其消息
POST /api/ai/cur                     设置当前会话 {id}

鉴权复用 auth.py 的 session（仅登录用户可访问，before_request 已拦截）。
用户隔离：所有查询都绑定 session["username"]。
"""
from flask import Blueprint, request, jsonify, g

from ... import config
from ...log import get_logger
from ...services.ide import chatdb


_log = get_logger()
bp = Blueprint("chat_history", __name__)


def _uid() -> str:
    return g.get("username") or request.environ.get("REMOTE_USER") or config.AUTH_USERNAME


@bp.route("/api/ai/sessions", methods=["GET"])
def api_sessions_list():
    uid = _uid()
    sessions = chatdb.list_conversations(uid)
    cur = chatdb.get_current(uid)
    # 当前会话若已不存在则回退到最新一条
    if cur and not any(s["id"] == cur for s in sessions):
        cur = sessions[0]["id"] if sessions else ""
    return jsonify({"sessions": sessions, "cur": cur})


@bp.route("/api/ai/sessions/<conv_id>", methods=["GET"])
def api_session_get(conv_id):
    uid = _uid()
    conv = chatdb.get_conversation(uid, conv_id)
    if not conv:
        return jsonify({"error": "会话不存在"}), 404
    return jsonify(conv)


@bp.route("/api/ai/sessions", methods=["POST"])
def api_session_save():
    uid = _uid()
    data = request.get_json(silent=True) or {}
    conv_id = str(data.get("id") or "").strip()
    if not conv_id:
        return jsonify({"error": "缺少会话 id"}), 400
    title = str(data.get("title") or "").strip()[:200]
    extra = data.get("extra") or {}
    if not isinstance(extra, dict):
        extra = {}
    msgs = data.get("msgs") or []
    if not isinstance(msgs, list):
        msgs = []
    deleted = data.get("deleted") or []
    if not isinstance(deleted, list):
        deleted = []
    deleted = [str(x) for x in deleted if x]
    try:
        res = chatdb.upsert_conversation(uid, conv_id, title, extra, msgs, deleted)
    except Exception as e:  # 数据库异常不应 500 崩溃
        _log.warning("保存 AI 会话失败: %s", e)
        return jsonify({"error": "保存失败：" + str(e)}), 500
    return jsonify(res)


@bp.route("/api/ai/sessions/<conv_id>", methods=["DELETE"])
def api_session_delete(conv_id):
    uid = _uid()
    ok = chatdb.delete_conversation(uid, conv_id)
    if not ok:
        return jsonify({"error": "会话不存在"}), 404
    # 若删除的是当前会话，清空记录
    cur = chatdb.get_current(uid)
    if cur == conv_id:
        chatdb.set_current(uid, "")
    return jsonify({"ok": True})


@bp.route("/api/ai/cur", methods=["POST"])
def api_set_cur():
    uid = _uid()
    data = request.get_json(silent=True) or {}
    conv_id = str(data.get("id") or "").strip()
    chatdb.set_current(uid, conv_id)
    return jsonify({"ok": True, "cur": conv_id})

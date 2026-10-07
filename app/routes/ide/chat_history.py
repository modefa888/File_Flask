"""AI 对话历史 REST API：后端持久化（SQLite）。

GET  /api/ai/sessions                会话列表（不含消息）+ 当前会话 id
GET  /api/ai/sessions/<id>           单会话完整内容（含消息）
POST /api/ai/sessions                新建/追加保存会话：{id, title, extra, root, msgs:[{mid,role,text,images,reasoning,meta}], deleted:[mid...]}
DELETE /api/ai/sessions/<id>         删除会话及其消息
POST /api/ai/sessions/adopt          把还没绑定项目的旧会话划归当前项目 {root}
POST /api/ai/cur                     设置当前会话 {id, root}

对话按【项目根目录】隔离：请求统一用 root 参数（查询串或 JSON 体）指定项目，
前端传 IDE 的 ROOT。不同项目各自的对话列表、当前会话互不影响。
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


def _root(data=None) -> str:
    """项目根目录：优先取 JSON 体，其次查询串；缺省为空串（未绑定项目）。"""
    if isinstance(data, dict) and data.get("root") is not None:
        return str(data.get("root") or "")
    return request.args.get("root") or ""


@bp.route("/api/ai/sessions", methods=["GET"])
def api_sessions_list():
    uid = _uid()
    root = _root()
    sessions = chatdb.list_conversations(uid, root)
    cur = chatdb.get_current(uid, root)
    # 当前会话若已不存在（或属于别的项目）则回退到该项目最新一条
    if cur and not any(s["id"] == cur for s in sessions):
        cur = sessions[0]["id"] if sessions else ""
    return jsonify({"sessions": sessions, "cur": cur, "root": root})


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
        res = chatdb.upsert_conversation(uid, conv_id, title, extra, msgs, deleted, _root(data))
    except Exception as e:  # 数据库异常不应 500 崩溃
        _log.warning("保存 AI 会话失败: %s", e)
        return jsonify({"error": "保存失败：" + str(e)}), 500
    return jsonify(res)


@bp.route("/api/ai/sessions/adopt", methods=["POST"])
def api_sessions_adopt():
    """把还没绑定项目的旧会话划归当前项目（前端每个项目只调一次）。"""
    uid = _uid()
    data = request.get_json(silent=True) or {}
    root = _root(data)
    try:
        n = chatdb.adopt_unassigned(uid, root)
    except Exception as e:
        _log.warning("采纳旧 AI 会话失败: %s", e)
        return jsonify({"error": "采纳失败：" + str(e)}), 500
    return jsonify({"ok": True, "adopted": n, "root": root})


@bp.route("/api/ai/sessions/<conv_id>", methods=["DELETE"])
def api_session_delete(conv_id):
    uid = _uid()
    ok = chatdb.delete_conversation(uid, conv_id)
    if not ok:
        return jsonify({"error": "会话不存在"}), 404
    # 若删除的是「当前会话」，把所有项目里指向它的记录一并清掉
    chatdb.forget_current(uid, conv_id)
    return jsonify({"ok": True})


@bp.route("/api/ai/cur", methods=["POST"])
def api_set_cur():
    uid = _uid()
    data = request.get_json(silent=True) or {}
    conv_id = str(data.get("id") or "").strip()
    chatdb.set_current(uid, conv_id, _root(data))
    return jsonify({"ok": True, "cur": conv_id})

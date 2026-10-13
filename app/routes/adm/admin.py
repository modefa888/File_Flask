"""后台管理控制台：页面 + 管理接口（仅管理员）。

页面
----
GET  /admin                    后台管理控制台

接口（均需管理员登录；非管理员由 auth 的全局校验统一拦截）
-----------------------------------------------------------
GET  /api/adm/overview         概览：业务计数 + 系统资源 + 存储占用 + 最近动态
GET  /api/adm/config           系统配置快照（只读、无密钥）
GET  /api/adm/logs             日志文件列表
GET  /api/adm/log              读取某个日志文件（尾部）
GET  /api/adm/users            用户列表
POST /api/adm/users            新建用户 {username, password, role}
POST /api/adm/users/update     修改角色 / 重置密码 {username, role?|password?}
POST /api/adm/users/ban        封禁 / 解封 {username, banned}
POST /api/adm/users/delete     删除用户 {username}

其余功能（分享 / 定时任务 / 后台任务 / 插件 / 数据库连接 / SSH / 通知 / AI 用量 /
文件说明 / 操作历史）直接复用各业务模块已有的 `/api/...` 接口，后台页只做聚合展示。
"""
from flask import Blueprint, jsonify, make_response, redirect, render_template, request

from ...log import get_logger
from ...services.adm import overview, users_admin

_log = get_logger()
bp = Blueprint("adm", __name__)


def _render_page(template, **ctx):
    """渲染页面并禁用缓存（与 pages._render_page 一致）。"""
    resp = make_response(render_template(template, **ctx))
    resp.headers["Cache-Control"] = "no-cache, no-store, must-revalidate, max-age=0"
    resp.headers["Pragma"] = "no-cache"
    resp.headers["Expires"] = "0"
    return resp


def _ok(payload=None, **extra):
    data = {"ok": True}
    if isinstance(payload, dict):
        data.update(payload)
    data.update(extra)
    return jsonify(data)


def _fail(msg, code=400):
    return jsonify({"error": msg}), code


# --------------------------------------------------------------------------- 页面
@bp.route("/admin")
def admin_page():
    from ..common.auth import is_admin, current_username
    if not is_admin():
        # 非管理员（协作者）误入：回到受限协作页
        _log.info("GET /admin 被拒绝（非管理员）")
        return redirect("/collab")
    _log.info("GET /admin")
    return _render_page("adm/admin.html", username=current_username())


# --------------------------------------------------------------------------- 概览
@bp.route("/api/adm/overview")
def api_overview():
    return jsonify(overview.dashboard())


@bp.route("/api/adm/config")
def api_config():
    return jsonify(overview.config_snapshot())


# --------------------------------------------------------------------------- 日志
@bp.route("/api/adm/logs")
def api_logs():
    from ..common.paginate import paginate
    data = overview.list_logs()
    page_items, total = paginate(data.get("items") or [], request)
    return jsonify({"items": page_items, "total": total, "dir": data.get("dir") or ""})


@bp.route("/api/adm/log")
def api_log():
    name = request.args.get("name", "")
    try:
        tail = int(request.args.get("tail") or 500)
    except (TypeError, ValueError):
        tail = 500
    res = overview.read_log(name, tail)
    if res.get("error"):
        return _fail(res["error"], 404)
    return jsonify(res)


# --------------------------------------------------------------------------- 用户管理
@bp.route("/api/adm/users", methods=["GET"])
def api_users():
    from ..common.paginate import paginate
    page_items, total = paginate(users_admin.list_users(), request)
    return jsonify({"users": page_items, "total": total})


@bp.route("/api/adm/users", methods=["POST"])
def api_users_create():
    data = request.get_json(silent=True) or {}
    username = (data.get("username") or "").strip()
    password = data.get("password") or ""
    role = data.get("role") or "member"
    if not username:
        return _fail("请填写用户名")
    err, user = users_admin.add_user(username, password, role)
    if err:
        return _fail(err)
    return _ok({"user": user})


@bp.route("/api/adm/users/update", methods=["POST"])
def api_users_update():
    from ..common.auth import current_username
    data = request.get_json(silent=True) or {}
    username = (data.get("username") or "").strip()
    if not username:
        return _fail("缺少用户名")
    if "role" in data:
        # 不允许修改自己账号的角色：避免管理员把自己降级后失去管理入口
        if username == current_username():
            return _fail("不能修改自己账号的角色")
        err = users_admin.set_role(username, data.get("role"))
        if err:
            return _fail(err)
    if data.get("password"):
        err = users_admin.set_password(username, data.get("password"))
        if err:
            return _fail(err)
    return _ok()


@bp.route("/api/adm/users/ban", methods=["POST"])
def api_users_ban():
    from ..common.auth import current_username
    data = request.get_json(silent=True) or {}
    username = (data.get("username") or "").strip()
    if not username:
        return _fail("缺少用户名")
    if username == current_username():
        return _fail("不能封禁自己正在使用的账号")
    err = users_admin.set_banned(username, bool(data.get("banned")))
    if err:
        return _fail(err)
    return _ok()


@bp.route("/api/adm/users/delete", methods=["POST"])
def api_users_delete():
    from ..common.auth import current_username
    data = request.get_json(silent=True) or {}
    username = (data.get("username") or "").strip()
    if not username:
        return _fail("缺少用户名")
    if username == current_username():
        return _fail("不能删除自己正在使用的账号")
    err = users_admin.delete_user(username)
    if err:
        return _fail(err)
    return _ok()

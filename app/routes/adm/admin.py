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
GET  /api/adm/apis             接口目录（数据库登记表：清单 + 访问级别）
GET  /api/adm/apis/summary     接口目录统计（按级别 / 模块汇总）
POST /api/adm/apis/sync        从 Flask 路由同步接口登记表
POST /api/adm/apis/cleanup     清理已失效的接口登记
POST /api/adm/apis/update      编辑接口登记 {path, method, desc?|access?|disabled?}
POST /api/adm/apis/permission  修改角色权限 {role, path, method, allowed}
POST /api/adm/apis/permission/materialize  生成默认权限快照（全量物化）
POST /api/adm/apis/permission/clear        清除默认权限快照
POST /api/adm/apis/stats/reset  清零接口请求统计
GET  /api/adm/permissions      权限视图（角色 → 可访问接口 + 权限矩阵）
GET  /api/adm/pages            页面清单（登录 / 分享 / IDE / 文件管理 / 协作 / 后台等）
GET  /api/adm/pages/summary    页面模块统计（总数 / 级别 / 分组）
POST /api/adm/pages/update     编辑页面登记 {path, desc?|access?|disabled?}

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


@bp.route("/api/adm/overview/resource")
def api_overview_resource():
    """仅系统资源快照（procinfo 后台线程每 2 秒采集，读缓存，供概览页轮询）。"""
    return jsonify(overview.system_resource())


@bp.route("/api/adm/config")
def api_config():
    return jsonify(overview.config_snapshot())


# --------------------------------------------------------------------------- 日志
@bp.route("/api/adm/logs")
def api_logs():
    from ..common.paginate import paginate
    data = overview.list_logs()
    all_items = data.get("items") or []
    summary = {"total_size": sum(x.get("size") or 0 for x in all_items),
               "latest_mtime": max([x.get("mtime") or 0 for x in all_items], default=0)}
    page_items, total = paginate(all_items, request)
    return jsonify({"items": page_items, "total": total, "dir": data.get("dir") or "",
                    "summary": summary})


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
@bp.route("/api/adm/users/summary")
def api_users_summary():
    """用户统计：总数 / 角色分布 / 状态分布 / 近 7 天新增（用户管理页顶部卡片）。"""
    return jsonify({"summary": users_admin.summary()})


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


# --------------------------------------------------------------------------- 系统设置（注册开关）
@bp.route("/api/adm/settings/register-open", methods=["POST"])
def api_set_register_open():
    """切换「是否允许前端自助注册」开关（store_meta 持久化，不重启生效）。"""
    from ...services.common.auth_settings import set_registration_open
    data = request.get_json(silent=True) or {}
    on = bool(data.get("open"))
    set_registration_open(on)
    _log.info("前端注册开关被设置为: %s", on)
    return _ok({"open": on})


# --------------------------------------------------------------------------- 接口目录 / 权限
@bp.route("/api/adm/apis")
def api_apis():
    """接口目录：全部后端 HTTP 接口（可 ?access= 过滤访问级别）。

    不传 page 时返回全量（供前端一次性加载后本地搜索 / 分页）；
    传 page 时按通用分页返回切片。
    """
    from ...services.adm import api_registry
    from ..common.paginate import paginate_opt
    rows = api_registry.list_interfaces()
    access = (request.args.get("access") or "").strip()
    if access in api_registry.ACCESS_META:
        rows = [r for r in rows if r["access"] == access]
    page_items, total = paginate_opt(rows, request)
    if total is None:
        return jsonify({"items": page_items, "total": len(page_items)})
    return jsonify({"items": page_items, "total": total})


@bp.route("/api/adm/apis/summary")
def api_apis_summary():
    """接口目录统计：总数 + 各级别条数 + 已停用 / 已改权限 + 按模块汇总。"""
    from ...services.adm import api_registry
    return jsonify(api_registry.summary())


@bp.route("/api/adm/apis/sync", methods=["POST"])
def api_apis_sync():
    """从 Flask 路由同步接口登记表（新增登记 / 刷新 / 标记失效）。"""
    from ...services.adm import api_registry
    return _ok({"sync": api_registry.sync_interfaces()})


@bp.route("/api/adm/apis/cleanup", methods=["POST"])
def api_apis_cleanup():
    """清理已失效（代码中已不存在）的接口登记。"""
    from ...services.adm import api_registry
    return _ok({"removed": api_registry.cleanup_orphans()})


@bp.route("/api/adm/apis/update", methods=["POST"])
def api_apis_update():
    """编辑接口登记：说明 / 访问级别 / 停用启用。

    body: {path, method, desc?, access?, disabled?}
    - access 传空串表示恢复默认级别；
    - 受保护接口（登录入口、后台接口等）不允许改级别 / 停用，返回 400。
    """
    from ...services.adm import api_registry
    data = request.get_json(silent=True) or {}
    path = (data.get("path") or "").strip()
    method = (data.get("method") or "GET").strip().upper()
    if not path:
        return _fail("缺少接口路径")
    err = api_registry.update_interface(
        path, method,
        desc=data.get("desc") if "desc" in data else None,
        access=data.get("access") if "access" in data else None,
        disabled=bool(data.get("disabled")) if "disabled" in data else None)
    if err:
        return _fail(err)
    return _ok()


@bp.route("/api/adm/apis/permission", methods=["POST"])
def api_apis_permission():
    """修改「角色 + 接口」权限。

    body: {role, path, method, allowed}
    - allowed 为 true / false 时写入权限表；为 null 时删除记录（恢复默认）。
    """
    from ...services.adm import api_registry
    data = request.get_json(silent=True) or {}
    role = (data.get("role") or "").strip()
    path = (data.get("path") or "").strip()
    method = (data.get("method") or "GET").strip().upper()
    if not path:
        return _fail("缺少接口路径")
    if "allowed" not in data:
        return _fail("缺少 allowed 参数")
    allowed = data.get("allowed")
    if allowed is not None:
        allowed = bool(allowed)
    err = api_registry.set_permission(role, path, method, allowed)
    if err:
        return _fail(err)
    return _ok()


@bp.route("/api/adm/apis/permission/materialize", methods=["POST"])
def api_apis_permission_materialize():
    """生成默认权限快照：把全部「角色×接口」按当前规则物化进 api_permission（仅查看用）。"""
    from ...services.adm import api_registry
    return _ok({"rows": api_registry.materialize_permissions()})


@bp.route("/api/adm/apis/permission/clear", methods=["POST"])
def api_apis_permission_clear():
    """清除默认权限快照（保留手动设置的权限）。"""
    from ...services.adm import api_registry
    return _ok({"removed": api_registry.clear_default_permissions()})


@bp.route("/api/adm/apis/stats/reset", methods=["POST"])
def api_apis_stats_reset():
    """清零接口请求统计。"""
    from ...services.adm import api_registry
    return _ok({"removed": api_registry.reset_stats()})


@bp.route("/api/adm/permissions")
def api_permissions():
    """权限视图：每个角色可访问的接口清单 + 权限矩阵。"""
    from ...services.adm import api_registry
    return jsonify(api_registry.permission_view())


# --------------------------------------------------------------------------- 页面模块
@bp.route("/api/adm/pages")
def api_pages():
    """页面清单：全部页面级路由（登录 / 分享 / IDE / 文件管理 / 协作 / 后台等）。

    数据来自接口登记表（api_interface，kind='页面'），叠加页面语义（友好名称 /
    分组 / 图标 / 预览地址）后返回，供「页面模块」展示与管理。
    """
    from ...services.adm import page_registry
    return jsonify({"items": page_registry.list_pages()})


@bp.route("/api/adm/pages/summary")
def api_pages_summary():
    """页面模块统计：总数 / 级别分布 / 停用 / 失效 / 分组汇总。"""
    from ...services.adm import page_registry
    return jsonify(page_registry.summary())


@bp.route("/api/adm/pages/update", methods=["POST"])
def api_pages_update():
    """编辑页面登记：说明 / 访问级别 / 停用启用。

    body: {path, desc?, access?, disabled?}
    - access 传空串表示恢复默认级别；
    - 受保护页面（登录入口、后台页面等）不允许改级别 / 停用，返回 400。
    """
    from ...services.adm import page_registry
    data = request.get_json(silent=True) or {}
    path = (data.get("path") or "").strip()
    if not path:
        return _fail("缺少页面路径")
    err = page_registry.update_page(
        path,
        desc=data.get("desc") if "desc" in data else None,
        access=data.get("access") if "access" in data else None,
        disabled=bool(data.get("disabled")) if "disabled" in data else None)
    if err:
        return _fail(err)
    return _ok()

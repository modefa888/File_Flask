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
import json
import re
import time

from flask import (
    Blueprint, jsonify, make_response, redirect, render_template, request, session,
)

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
    from ...services.common.users import verify_user, get_password_version
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
        new_password = data.get("password") or ""
        confirm = data.get("confirm") or ""
        if confirm and confirm != new_password:
            return _fail("两次输入的新密码不一致")
        # 修改自己账号的密码：必须先验证当前（旧）密码；重置他人密码由管理员权限兜底
        if username == current_username():
            old_password = data.get("old_password") or ""
            if not old_password:
                return _fail("请输入当前密码")
            if not verify_user(username, old_password):
                return _fail("当前密码不正确")
            if new_password == old_password:
                return _fail("新密码不能与当前密码相同")
        # 新密码不能与该账号正在使用的密码相同（重置他人时同样校验）
        if verify_user(username, new_password):
            return _fail("新密码不能与该账号的当前密码相同")
        err = users_admin.set_password(username, new_password)
        if err:
            return _fail(err)
        # 密码版本 +1：该账号在其它设备 / 浏览器上的旧登录会话自动失效
        # （auth._require_login 每次请求核对会话里的 pw_ver）。
        # 改的是自己时，顺手刷新当前会话的版本号，避免自己也被踢出。
        if username == current_username():
            session["pw_ver"] = get_password_version(username)
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


# --------------------------------------------------------------------------- 操作审计日志
@bp.route("/api/adm/oplogs")
def api_oplogs():
    """全站写操作日志（谁 / 时间 / 模块 / 动作 / 目标 / 结果 / IP），支持关键字搜索与分页。"""
    from ...services.common import oplog
    try:
        page = max(int(request.args.get("page", 1)), 1)
        size = min(max(int(request.args.get("page_size", 50)), 1), 200)
    except (TypeError, ValueError):
        page, size = 1, 50
    items, total = oplog.list_logs((request.args.get("q") or "").strip(), page, size)
    return jsonify({"items": items, "total": total, "stats": oplog.stats()})


@bp.route("/api/adm/oplogs/clear", methods=["POST"])
def api_oplogs_clear():
    """清空操作日志。"""
    from ...services.common import oplog
    return _ok({"removed": oplog.clear()})


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


@bp.route("/api/adm/pages/hide", methods=["POST"])
def api_pages_hide():
    """从页面清单里移除 / 恢复某个页面。body: {path, hidden?}

    只影响页面模块的展示，不动接口登记与鉴权；恢复用 hidden=false 或 /pages/restore。
    """
    from ...services.adm import page_registry
    data = request.get_json(silent=True) or {}
    err = page_registry.set_hidden(data.get("path"), bool(data.get("hidden", True)))
    if err:
        return _fail(err)
    return _ok({"hidden": page_registry.hidden_paths()})


@bp.route("/api/adm/pages/restore", methods=["POST"])
def api_pages_restore():
    """恢复全部被移除的页面。"""
    from ...services.adm import page_registry
    return _ok({"restored": page_registry.restore_hidden()})


@bp.route("/api/adm/pages/delete", methods=["POST"])
def api_pages_delete():
    """删除一条「已失效」页面登记（代码中已无此路由）。body: {path}"""
    from ...services.adm import page_registry
    data = request.get_json(silent=True) or {}
    err = page_registry.delete_orphan(data.get("path"))
    if err:
        return _fail(err)
    return _ok()


@bp.route("/api/adm/pages/cleanup", methods=["POST"])
def api_pages_cleanup():
    """清理全部「已失效」页面登记，只动页面行，不碰接口 / 通道。"""
    from ...services.adm import page_registry
    return _ok({"removed": page_registry.cleanup_orphans()})


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


# --------------------------------------------------------------------------- 自定义文件图标
# 规则存 store_meta（key = icons.custom），JSON 数组：
#   [{"match": "ext"|"name", "value": "py", "icon": "_python" | "bi-filetype-doc",
#     "color": "#519aba", "note": "说明"}]
# 桌面端文件管理器（index/js/04_工具.js）与 IDE 文件树（ide/js/00_preamble.js）
# 启动时各拉一次，命中规则的条目就用自定义图标覆盖内置图标。
_ICONS_META_KEY = "icons.custom"
_ICONS_MAX_RULES = 200
# 匹配值允许中文文件名（如「说明.doc」），只挡掉空白与路径分隔符
_ICONS_VALUE_RE = re.compile(r"^[^\s/\\:*?\"<>|]{1,64}$")
# 图标只接受字母 / 数字 / _ - （bi-xxx 或 Seti 图标键）
_ICONS_ICON_RE = re.compile(r"^(ali:|ai:)?[A-Za-z0-9_-]{1,64}$")   # 也允许 ali:icon-xxx / ai:ai_xxx
_ICONS_COLOR_RE = re.compile(r"^#[0-9A-Fa-f]{6}$")


def _custom_icons_load():
    from ...services.common.store_db import get_meta
    try:
        raw = get_meta(_ICONS_META_KEY, "") or ""
        data = json.loads(raw) if raw else []
    except Exception:
        data = []
    return data if isinstance(data, list) else []


def _custom_icons_clean(rules):
    """校验并规整规则。返回 (规则列表, 错误信息)；错误信息为空表示通过。"""
    out, seen = [], {}
    for i, r in enumerate(rules if isinstance(rules, list) else []):
        if not isinstance(r, dict):
            continue
        n = i + 1
        match = "name" if str(r.get("match") or "").strip() == "name" else "ext"
        value = str(r.get("value") or "").strip().lower()
        if match == "ext":
            value = value.lstrip(".")
        if not _ICONS_VALUE_RE.match(value):
            return None, "第 %d 条：匹配值不能为空，也不能含空格或 / \\ : * ? \" < > |（最长 64 字）" % n
        icon = re.sub(r"^bi\s+", "", str(r.get("icon") or "").strip())   # 允许直接粘贴 "bi bi-xxx"
        if not _ICONS_ICON_RE.match(icon):
            return None, "第 %d 条：图标填 Seti 图标键（如 _python）、Bootstrap 类名（如 bi-filetype-doc）、阿里图标（ali:icon-folder）或 AI 图标（ai:ai_xxx）" % n
        color = str(r.get("color") or "").strip()
        if color and not _ICONS_COLOR_RE.match(color):
            return None, "第 %d 条：颜色要写成 #RRGGBB" % n
        key = match + "|" + value
        if key in seen:
            return None, "第 %d 条：匹配「%s」和前面重复了" % (n, value)
        seen[key] = 1
        out.append({
            "match": match,
            "value": value,
            "icon": icon,
            "color": color.lower(),
            "note": str(r.get("note") or "").strip()[:60],
        })
        if len(out) >= _ICONS_MAX_RULES:
            break
    return out, ""


@bp.route("/api/icons/custom")
def api_icons_custom():
    """自定义图标规则 + 界面图标替换 + 阿里图标库 + 规则里用到的 AI 图标 SVG（只读）。"""
    rules = _custom_icons_load()
    return jsonify({
        "ok": True,
        "rules": rules,
        "ui": _custom_ui_load(),
        "iconfont": _iconfont_load(),
        "ai": _ai_svg_map_for_rules(rules),      # 只下发被规则引用到的那几个，避免拖大响应
    })


@bp.route("/api/adm/icons/custom", methods=["POST"])
def api_adm_icons_custom_save():
    """保存整份自定义图标规则（新增 / 修改 / 删除都走这里落库）。

    body: {rules: [{match, value, icon, color?, note?}]}
    """
    from ...services.common.store_db import set_meta
    data = request.get_json(silent=True) or {}
    rules, err = _custom_icons_clean(data.get("rules"))
    if err:
        return _fail(err)
    try:
        set_meta(_ICONS_META_KEY, json.dumps(rules, ensure_ascii=False))
    except Exception as e:
        _log.warning("保存自定义图标失败：%s", e)
        return _fail("保存失败：%s" % e, 500)
    _log.info("POST /api/adm/icons/custom rules=%d", len(rules))
    return _ok(rules=rules)


# --------------------------------------------------------------------------- 界面图标替换
# 与「文件图标规则」不同：这里替换的是界面上写死的 Bootstrap 功能图标（如数据库工具页签的
# bi-filetype-sql）。存 store_meta（key = icons.ui），JSON 数组：
#   [{"from": "bi-filetype-sql", "to": "bi-database-fill", "color": "#c09553", "note": "说明"}]
# 生效方式：GET /api/icons/ui.css 生成一段全局 CSS（覆盖 ::before 字形与颜色），
# 各页面（IDE / 文件管理 / 分享 / 后台）以 <link> 引入，保存后刷新页面即生效。
_ICONS_UI_META_KEY = "icons.ui"
_ICONS_UI_MAX = 200
# from / to 只接受 bi-xxx 类名（界面图标都是 Bootstrap 图标）
_ICONS_UI_CLS_RE = re.compile(r"^bi-[a-z0-9][a-z0-9-]{0,63}$")


def _custom_ui_load():
    from ...services.common.store_db import get_meta
    try:
        raw = get_meta(_ICONS_UI_META_KEY, "") or ""
        data = json.loads(raw) if raw else []
    except Exception:
        data = []
    return data if isinstance(data, list) else []


def _custom_ui_clean(items):
    """校验并规整界面图标替换规则。返回 (列表, 错误信息)；错误信息为空表示通过。"""
    out, seen = [], {}
    for i, r in enumerate(items if isinstance(items, list) else []):
        if not isinstance(r, dict):
            continue
        n = i + 1
        frm = str(r.get("from") or "").strip().lower()
        to = str(r.get("to") or "").strip().lower()
        if not _ICONS_UI_CLS_RE.match(frm) or not _ICONS_UI_CLS_RE.match(to):
            return None, "第 %d 条：图标要填 bi-xxx 类名（如 bi-filetype-sql）" % n
        color = str(r.get("color") or "").strip()
        if color and not _ICONS_COLOR_RE.match(color):
            return None, "第 %d 条：颜色要写成 #RRGGBB" % n
        if frm in seen:
            return None, "第 %d 条：原图标「%s」和前面重复了" % (n, frm)
        seen[frm] = 1
        out.append({
            "from": frm,
            "to": to,
            "color": color.lower(),
            "note": str(r.get("note") or "").strip()[:60],
        })
        if len(out) >= _ICONS_UI_MAX:
            break
    return out, ""


@bp.route("/api/adm/icons/ui", methods=["POST"])
def api_adm_icons_ui_save():
    """保存整份界面图标替换规则。body: {list: [{from, to, color?, note?}]}"""
    from ...services.common.store_db import set_meta
    data = request.get_json(silent=True) or {}
    items, err = _custom_ui_clean(data.get("list"))
    if err:
        return _fail(err)
    try:
        set_meta(_ICONS_UI_META_KEY, json.dumps(items, ensure_ascii=False))
    except Exception as e:
        _log.warning("保存界面图标替换失败：%s", e)
        return _fail("保存失败：%s" % e, 500)
    _log.info("POST /api/adm/icons/ui items=%d", len(items))
    return _ok(ui=items)


_BI_CP_CACHE = None


def _bi_codepoints():
    """从本地 bootstrap-icons.css 抽出 类名 → 字形码位（如 bi-database → f6b0），带缓存。"""
    global _BI_CP_CACHE
    if _BI_CP_CACHE is not None:
        return _BI_CP_CACHE
    out = {}
    try:
        import os
        p = os.path.join(os.path.dirname(__file__), "..", "..", "static",
                         "vendor", "bootstrap-icons", "bootstrap-icons.css")
        with open(os.path.normpath(p), "r", encoding="utf-8") as f:
            css = f.read()
        # css 里写的是 content: "\f7f5"（单反斜杠 + 码位）
        for m in re.finditer(r"\.([a-z0-9-]+)::before\s*\{[^}]*?content:\s*\"\\([0-9a-fA-F]+)\"", css):
            out[m.group(1)] = m.group(2)          # 只留码位（如 f7f5）
    except Exception as e:
        _log.warning("解析 bootstrap-icons.css 失败：%s", e)
    _BI_CP_CACHE = out
    return out


@bp.route("/api/icons/ui.css")
def api_icons_ui_css():
    """界面图标替换的全局 CSS：把 bi-xxx 的字形 / 颜色替换成规则指定的。"""
    cps = _bi_codepoints()
    lines = ["/* 由「所有图标 → 界面图标」生成，请勿手改 */"]
    for it in _custom_ui_load():
        sel = "." + it["from"]
        cp = cps.get(it["to"])
        if cp:
            lines.append('%s::before{content:"\\%s"!important;}' % (sel, cp))
        if it.get("color"):
            lines.append("%s{color:%s!important;}" % (sel, it["color"]))
    resp = make_response("\n".join(lines))
    resp.mimetype = "text/css"
    resp.headers["Cache-Control"] = "no-store"
    return resp


# --------------------------------------------------------------------------- 阿里图标库（iconfont）
# 配置存 store_meta（key = icons.iconfont）：[{"name": "我的图标库", "url": "https://at.alicdn.com/t/c/font_xxx.css"}]
# 只允许阿里图标库 CDN：注入的 CSS 会作用到页面里，限制来源避免被塞进任意样式。
_ICONFONT_META_KEY = "icons.iconfont"
_ICONFONT_MAX = 10


def _iconfont_url_ok(url: str) -> bool:
    from urllib.parse import urlparse
    try:
        u = urlparse(url)
    except Exception:
        return False
    if u.scheme not in ("http", "https"):
        return False
    host = (u.hostname or "").lower()
    return host == "at.alicdn.com" or host.endswith(".alicdn.com")


def _iconfont_load():
    from ...services.common.store_db import get_meta
    try:
        raw = get_meta(_ICONFONT_META_KEY, "") or ""
        data = json.loads(raw) if raw else []
    except Exception:
        data = []
    return [x for x in data if isinstance(x, dict) and x.get("url")] if isinstance(data, list) else []


def _iconfont_clean(links):
    """校验图标库列表。返回 (列表, 错误信息)。"""
    out, seen = [], set()
    for i, l in enumerate(links if isinstance(links, list) else []):
        if not isinstance(l, dict):
            continue
        url = str(l.get("url") or "").strip()
        if url.startswith("//"):
            url = "https:" + url
        if not _iconfont_url_ok(url):
            return None, "第 %d 个地址不对：只支持阿里图标库 CDN（https://at.alicdn.com/…css）" % (i + 1)
        if url in seen:
            continue
        seen.add(url)
        name = str(l.get("name") or "").strip()[:40] or ("图标库 %d" % (len(out) + 1))
        out.append({"name": name, "url": url})
        if len(out) >= _ICONFONT_MAX:
            break
    return out, ""


@bp.route("/api/icons/iconfont/css")
def api_icons_iconfont_css():
    """代理读取阿里图标库的 CSS，返回其中的图标类名（浏览器直连 CDN 会被 CORS 挡住）。"""
    import urllib.request
    url = (request.args.get("url") or "").strip()
    if url.startswith("//"):
        url = "https:" + url
    if not _iconfont_url_ok(url):
        return _fail("只允许阿里图标库 CDN 地址（at.alicdn.com）")
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=8) as resp:
            raw = resp.read(512 * 1024).decode("utf-8", "replace")
    except Exception as e:
        return _fail("拉取失败：%s" % e, 502)
    classes = sorted({m for m in re.findall(r"\.([A-Za-z0-9_-]+)::?before", raw)})
    # 去掉 .iconfont 这类容器类，只留下真正对应字形的类名
    keep = [c for c in classes if re.search(r"\." + re.escape(c) + r"::?before\s*\{[^}]*content\s*:", raw)]
    return jsonify({"ok": True, "classes": keep or classes})


@bp.route("/api/adm/icons/iconfont", methods=["POST"])
def api_adm_icons_iconfont_save():
    """保存阿里图标库列表。body: {links: [{name, url}]}"""
    from ...services.common.store_db import set_meta
    data = request.get_json(silent=True) or {}
    links, err = _iconfont_clean(data.get("links"))
    if err:
        return _fail(err)
    try:
        set_meta(_ICONFONT_META_KEY, json.dumps(links, ensure_ascii=False))
    except Exception as e:
        _log.warning("保存阿里图标库失败：%s", e)
        return _fail("保存失败：%s" % e, 500)
    _log.info("POST /api/adm/icons/iconfont links=%d", len(links))
    return _ok(links=links)


# --------------------------------------------------------------------------- AI 生成图标
# 用项目里已配置的 AI（chat 模块）把文字描述转成 24×24 单色 SVG 图标，存 store_meta（key = icons.ai）。
# 规则里用 ai:<id> 引用；/api/icons/custom 只下发「规则实际用到」的那几个 SVG，避免拖大响应。
_AI_ICON_META_KEY = "icons.ai"
_AI_ICON_MAX = 200
_AI_ICON_TIMEOUT = 120
_AI_ICON_STYLES = {
    "seti": (
        "Seti 图标主题风格：参照 VS Code 官方 Seti 文件图标的观感 —— 24×24 网格、干净克制的线条与简洁色块、"
        "造型扁平不立体，配色使用 Seti 常见的低饱和蓝 / 青 / 紫 / 黄（如 #519aba、#4ec9b0、#c586c0、#dcdcaa），"
        "整体像和 IDE 里那套文件图标出自同一套设计"
    ),
    "line": "常规线性：2px 均匀描边、圆角端点、不填充，简洁现代",
    "thin": "纤巧线性：1.5px 细线描边，轻盈精致，细节克制",
    "detail": "详细线性：1.5px 描边，可含内部结构细节（如键盘按键、桌面小图标）",
    "hairline": "极细微线：1px 极细描边，极简几何，留白多",
    "fill": "面性（实心）：纯色块填充、无描边，块面干净",
    "round": "简约圆形：以圆角图形为主体，柔和不尖锐",
    "minimal": "极简：只保留最能识别的 1~2 个几何形状",
    "doodle": "涂鸦风：随性手绘涂鸦，线条活泼、略有倾斜",
    "hand": "手绘风：略带手写笔触，圆润可爱",
    "sketch": "描画风：草稿式速写线条，轻快有手账感",
    "pixel": "像素风：8bit 方块像素，直角、无圆角",
}
_AI_ICON_SYS = (
    "你是专业的图标设计师。请根据描述生成 24x24 的**单色 SVG 图标**。"
    "只输出一个 JSON 数组，不要任何解释、不要 Markdown 代码围栏。"
    '每个元素形如 {"name":"简短中文名","svg":"<svg ...></svg>"}。'
    "硬性要求："
    "1) svg 必须带 viewBox=\"0 0 24 24\"，不要写 width / height；"
    "2) 不要 <script>、<foreignObject>、<image>、外链 href，不要事件属性；"
    "3) 颜色一律用 currentColor（fill=\"currentColor\" 或 stroke=\"currentColor\"）；"
    "4) 颜色 / 描边一律写成元素属性（fill / stroke / stroke-width），不要 <style>、CSS 类或 <use> 引用；"
    "5) 图形居中、四周留 2px 边距，缩到 16px 仍能辨认；每个图标至少有一个 path / rect / circle。"
)
# 危险内容：脚本/样式块整段删、危险标签删、"on*" 事件属性删、外链 href 删
_AI_ICON_SYS_KEEP = (
    "你是专业的图标设计师。请根据描述生成 24x24 的**彩色 SVG 图标**（可以有多种颜色）。"
    "只输出一个 JSON 数组，不要任何解释、不要 Markdown 代码围栏。"
    '每个元素形如 {"name":"简短中文名","svg":"<svg ...></svg>"}。'
    "硬性要求："
    "1) svg 必须带 viewBox=\"0 0 24 24\"，不要写 width / height；"
    "2) 不要 <script>、<foreignObject>、<image>、外链 href，不要事件属性；"
    "3) 颜色必须写成具体的十六进制色值（如 #2f81f7、#e91e63），**不要用 currentColor**；"
    "4) 配色贴近描述物体的常见颜色；颜色 / 描边一律写在元素属性上，不要 <style>、CSS 类或 <use> 引用；"
    "5) 图形居中、四周留 2px 边距，缩到 16px 仍能辨认；每个图标至少有一个 path / rect / circle。"
)
# 可绘制元素：清洗后一个都没有，说明是空壳（例如只剩被删掉的 <use>/<defs>），当作无效
_SVG_DRAWABLE = re.compile(r"<\s*(path|rect|circle|ellipse|polygon|polyline|line|text|tspan|g)\b", re.I)
_SVG_STRIP_BLOCKS = re.compile(
    r"<\s*(script|style|foreignObject|iframe)\b[\s\S]*?<\s*/\s*\1\s*>", re.I)
_SVG_STRIP_TAGS = re.compile(
    r"<\s*/?\s*(script|style|foreignObject|iframe|image|use|animate|animateTransform|set)\b[^>]*>", re.I)
_SVG_STRIP_ATTRS = re.compile(
    r"\son\w+\s*=\s*(\"[^\"]*\"|'[^']*'|[^\s>]+)", re.I)


def _ai_icon_svg_clean(svg, keep_color=False):
    """清洗模型返回的 SVG：只留 <svg>…</svg>，去掉脚本 / 外链 / 事件，限制体积。

    keep_color=True（「保留原色」）时不动配色；否则没写颜色的图形会补成 currentColor，
    让规则里的「颜色」和浅色 / 深色主题都能生效。
    """
    s = str(svg or "").strip()
    s = re.sub(r"```[a-zA-Z]*", "", s).strip()
    m = re.search(r"<svg\b[\s\S]*?</svg>", s, re.I)
    if not m:
        return ""
    s = m.group(0)
    s = _SVG_STRIP_BLOCKS.sub("", s)      # <script>…</script> 连内容一起删
    s = _SVG_STRIP_TAGS.sub("", s)
    s = _SVG_STRIP_ATTRS.sub("", s)
    s = re.sub(r"\s(?:xlink:)?href\s*=\s*([\"'])(?!#)[^\"']*\1", "", s, flags=re.I)   # 只保留 # 内部引用
    if re.search(r"javascript:|<\s*script|on\w+\s*=", s, re.I):
        return ""                          # 还有残留：直接丢弃，宁可让模型重画
    if len(s) > 20000:
        return ""
    if not _SVG_DRAWABLE.search(s):
        return ""          # 没有任何可绘制元素（只剩 defs/空壳）
    # 全是 fill="none" 又完全没有描边 —— 画出来是透明的，等于白图标
    _fills = re.findall(r"fill\s*=\s*([\"'])([^\"']*)\1", s, re.I)
    _has_stroke = bool(re.search(r"stroke\s*=\s*([\"'])(?!(?:none|transparent)\1)", s, re.I))
    if _fills and not _has_stroke and all(v.strip().lower() in ("none", "transparent") for _q, v in _fills):
        return ""
    # 只去掉根 <svg> 上的固定宽高（由页面按字号缩放），内部元素的 width/height 必须保留
    mo = re.match(r"<svg\b[^>]*>", s, re.I)
    if mo:
        head = re.sub(r"\s(width|height)\s*=\s*([\"'])[^\"']*\2", "", mo.group(0), flags=re.I)
        s = head + s[mo.end():]
    if "viewBox" not in s:
        s = s.replace("<svg", '<svg viewBox="0 0 24 24"', 1)
    # 模型没写任何颜色时，让图形继承外层 color —— 否则 SVG 默认黑色，规则里的「颜色」和浅色主题都不生效
    if (not keep_color) and "currentcolor" not in s.lower() and not re.search(r"#[0-9a-fA-F]{3,8}|rgba?\(|hsla?\(", s):
        mo2 = re.match(r"<svg\b[^>]*>", s, re.I)
        if mo2:
            head = mo2.group(0)
            low = head.lower()
            if "fill=" not in low and "stroke=" not in low:
                # 描边型图标补 stroke，实心型补 fill —— 两者都指向外层 color
                is_stroke = bool(re.search(r"stroke-(width|linecap|linejoin)\s*=", s, re.I))
                add = ' stroke="currentColor" fill="none"' if is_stroke else ' fill="currentColor"'
                tail = "/>" if head.endswith("/>") else ">"
                s = head[:-len(tail)] + add + tail + s[mo2.end():]
    return s


def _ai_icon_parse(text, want, keep_color=False):
    """从模型输出里解析出图标：优先按 JSON 数组，兜底直接抓 <svg>。"""
    s = re.sub(r"```[a-zA-Z]*", "", str(text or "")).strip()
    out = []
    m = re.search(r"\[[\s\S]*\]", s)
    if m:
        try:
            arr = json.loads(m.group(0))
        except Exception:
            arr = None
        if isinstance(arr, list):
            for it in arr:
                if not isinstance(it, dict):
                    continue
                svg = _ai_icon_svg_clean(it.get("svg"), keep_color)
                if svg:
                    out.append({"name": str(it.get("name") or "").strip()[:20], "svg": svg})
                if len(out) >= want:
                    break
    if not out:                                  # 模型没按 JSON 输出：直接抓 SVG 片段
        cands = re.findall(r"<svg\b[\s\S]*?</svg>", s, re.I)
        cands.sort(key=len, reverse=True)         # 最完整的排在前面（避免抓到残缺片段）
        for svg in cands[:max(want * 3, 6)]:
            c = _ai_icon_svg_clean(svg, keep_color)
            if c:
                out.append({"name": "", "svg": c})
            if len(out) >= want:
                break
    return out


def _ai_icons_load():
    from ...services.common.store_db import get_meta
    try:
        raw = get_meta(_AI_ICON_META_KEY, "") or ""
        data = json.loads(raw) if raw else []
    except Exception:
        data = []
    if not isinstance(data, list):
        return []
    return [x for x in data if isinstance(x, dict) and x.get("id") and x.get("svg")]


def _ai_icons_clean_list(icons):
    """校验并规整要保存的图标列表。返回 (列表, 错误信息)。"""
    import time as _t
    out, seen = [], set()
    for i, it in enumerate(icons if isinstance(icons, list) else []):
        if not isinstance(it, dict):
            continue
        keep = bool(it.get("keepColor"))
        svg = _ai_icon_svg_clean(it.get("svg"), keep)
        if not svg:
            return None, "第 %d 个图标不是有效的 SVG（可能含脚本，或体积过大）" % (i + 1)
        iid = str(it.get("id") or "").strip()
        if not re.match(r"^ai_[A-Za-z0-9]{4,24}$", iid):
            iid = "ai_%s" % format(abs(hash(svg + str(_t.time()))) % (1 << 40), "x")
        if iid in seen:
            continue
        seen.add(iid)
        out.append({
            "id": iid,
            "name": str(it.get("name") or "").strip()[:20] or "AI 图标",
            "prompt": str(it.get("prompt") or "").strip()[:200],
            "style": str(it.get("style") or "line")[:20],
            "svg": svg,
            "keepColor": keep,
            "created_at": int(it.get("created_at") or _t.time()),
        })
        if len(out) >= _AI_ICON_MAX:
            break
    return out, ""


def _ai_svg_map_for_rules(rules):
    """只把规则里引用到的 AI 图标 SVG 下发，没用到的不下。"""
    need = {str(r.get("icon") or "")[3:] for r in rules
            if str(r.get("icon") or "").startswith("ai:")}
    need.discard("")
    if not need:
        return {}
    # 读取时再洗一遍：老图标（早先存的黑色 / 无 currentColor）也能跟着规则颜色走，不用重新生成；
    # keep=True 的（生成时选了「保留原色」）不动配色，渲染端也不会再用规则颜色覆盖。
    out = {}
    for x in _ai_icons_load():
        if x["id"] in need:
            keep = bool(x.get("keepColor"))
            out[x["id"]] = {"svg": _ai_icon_svg_clean(x["svg"], keep) or x["svg"], "keep": keep}
    return out


@bp.route("/api/adm/icons/ai")
def api_adm_icons_ai_list():
    """AI 图标库（管理员用：管理页要全量）。"""
    return jsonify({"ok": True, "icons": _ai_icons_load()})


@bp.route("/api/adm/icons/ai/generate", methods=["POST"])
def api_adm_icons_ai_generate():
    """AI 生成图标：body {prompt, style?, count?}，返回未落库的候选图标。"""
    import urllib.request
    import urllib.error
    from ..ide.ai import (_brief, _estimate_msgs, _estimate_tokens, _load_cfg,
                          _log_ai_call, _sys_pick)
    data = request.get_json(silent=True) or {}
    prompt = str(data.get("prompt") or "").strip()
    if not prompt:
        return _fail("请先填写图标描述")
    style = str(data.get("style") or "line")
    style_desc = _AI_ICON_STYLES.get(style, _AI_ICON_STYLES["line"])
    keep_color = bool(data.get("keepColor"))
    try:
        want = max(1, min(4, int(data.get("count") or 4)))
    except (TypeError, ValueError):
        want = 4

    cfg = _load_cfg()
    provider, model, err = _sys_pick(cfg, "icon")     # 系统 AI 里可单独指定/停用「AI 生成图标」
    if err:
        return _fail("AI 还没配置好：%s（在 AI 设置里配一个可用模型即可）" % err, 400)

    base = provider["base_url"].rstrip("/")
    url = base if base.endswith("/chat/completions") else base + "/chat/completions"

    def _ask(sys_prompt, extra=""):
        """调一次模型，返回 choices[0].message.content（同时记一次「AI 生成图标」调用统计）。"""
        msg = "图标描述：%s\n风格：%s\n数量：%d 个" % (prompt[:200], style_desc, want)
        if extra:
            msg += "\n" + extra
        payload = json.dumps({
            "model": model, "stream": False, "temperature": 0.8,
            "messages": [{"role": "system", "content": sys_prompt},
                         {"role": "user", "content": msg}],
        }).encode("utf-8")
        req = urllib.request.Request(url, data=payload, method="POST", headers={
            "Content-Type": "application/json", "Authorization": "Bearer " + provider["api_key"]})
        t0 = time.time()
        try:
            resp = urllib.request.urlopen(req, timeout=_AI_ICON_TIMEOUT)
            obj = json.loads(resp.read().decode("utf-8", "replace"))
            text = (((obj.get("choices") or [{}])[0] or {}).get("message") or {}).get("content") or ""
            usage = obj.get("usage") or {}
            tin = int(usage.get("prompt_tokens") or 0)
            tout = int(usage.get("completion_tokens") or 0)
            est = False
            if not (tin or tout):
                tin = _estimate_msgs([{"role": "system", "content": sys_prompt},
                                      {"role": "user", "content": msg}])
                tout, est = _estimate_tokens(text), True
            _log_ai_call("icon", True, int((time.time() - t0) * 1000), "", model, tin, tout,
                         est, req=_brief(msg), resp=_brief(text))
            return text
        except Exception as e:
            _log_ai_call("icon", False, int((time.time() - t0) * 1000), str(e), model,
                         0, 0, False, req=_brief(msg), resp="")
            raise

    sys_prompt = _AI_ICON_SYS_KEEP if keep_color else _AI_ICON_SYS
    icons = []
    # 最多试两次：第一次出来的若是空壳 / 全透明（常见于模型用 <style> 上色），
    # 第二次明确要求把颜色写进属性、不要引用外部定义。
    for attempt in (1, 2):
        extra = "" if attempt == 1 else (
            "上一次的回答里没有能显示出来的图形。这次务必：颜色直接写成 fill / stroke 属性，"
            "不要用 <style> 或 CSS 类；不要用 <use> / <image> 引用外部内容；"
            "每个图标至少包含一个 path / rect / circle。")
        try:
            text = _ask(sys_prompt, extra)
        except urllib.error.HTTPError as e:
            return _fail("生成失败：接口返回 %s" % e.code, 502)
        except Exception as e:
            return _fail("生成失败：%s" % e, 502)
        try:
            _log.info("AI 图标原始输出(第 %d 次, %d 字): %s",
                      attempt, len(text), re.sub(r"\s+", " ", text)[:400])
        except Exception:
            pass
        icons = _ai_icon_parse(text, want, keep_color)
        if icons:
            break

    for _it in icons:
        _it["keepColor"] = keep_color
    if not icons:
        return _fail("模型没返回能画出来的 SVG（空壳或全透明），换个描述 / 风格，或换一个更强的模型再试", 502)
    _log.info("POST /api/adm/icons/ai/generate prompt=%s style=%s got=%d", prompt[:40], style, len(icons))
    return _ok(icons=icons)


@bp.route("/api/adm/icons/ai/svg", methods=["POST"])
def api_adm_icons_ai_svg():
    """校验 / 清洗一段「手动粘贴」进来的 SVG（不落库），前端用来预览。

    body {svg, keepColor?} -> {ok, svg}
    """
    data = request.get_json(silent=True) or {}
    raw = str(data.get("svg") or "")
    if not raw.strip():
        return _fail("请先粘贴 SVG 代码")
    if len(raw) > 60000:
        return _fail("SVG 太大了（超过 60KB），建议简化后再粘贴")
    svg = _ai_icon_svg_clean(raw, bool(data.get("keepColor")))
    if not svg:
        return _fail("这段内容不是可用的 SVG：需要有 <svg>…</svg>，并且至少包含一个图形元素"
                     "（path / rect / circle…）；只靠 <style>、<use> 或外链图片的会被清掉")
    return _ok(svg=svg)


@bp.route("/api/adm/icons/ai/save", methods=["POST"])
def api_adm_icons_ai_save():
    """保存 AI 图标库（整表替换，新增 / 删除都走这里）。body {icons: [...]}"""
    from ...services.common.store_db import set_meta
    data = request.get_json(silent=True) or {}
    icons, err = _ai_icons_clean_list(data.get("icons"))
    if err:
        return _fail(err)
    try:
        set_meta(_AI_ICON_META_KEY, json.dumps(icons, ensure_ascii=False))
    except Exception as e:
        _log.warning("保存 AI 图标失败：%s", e)
        return _fail("保存失败：%s" % e, 500)
    _log.info("POST /api/adm/icons/ai/save total=%d", len(icons))
    return _ok(icons=icons)

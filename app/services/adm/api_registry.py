"""后台管理：接口登记表 + 权限表（「接口模块 / 权限模块」的持久化与鉴权数据源）。

两张表都落在统一存储库 store.db：

  api_interface   接口登记表：一行一个「路径规则 + 方法」，保存接口清单与可编辑配置
                  （说明 / 访问级别 / 停用）。随代码路由变化自动同步：新增路由自动登记，
                  已移除的路由标记为「已失效（orphan）」而非删除，保留人工配置。
  api_permission  权限表：一行一个「角色 + 接口」的允许与否，覆盖默认的角色规则。

鉴权口径（auth._require_login 调用 lookup() / role_allowed()）：
  1. 接口被停用            -> 一律拒绝；
  2. 该「角色 + 接口」在 api_permission 有记录 -> 以记录为准；
  3. 否则按接口访问级别推导：public 所有角色可用；member 协作者 / 管理员可用；admin 仅管理员。

代码默认级别 access_level() 仅在「登记表里没有该接口」时兜底，正常情况下以数据库为准。
"""
import threading
import time

from flask import current_app

from ...log import get_logger
from ...routes.common.auth import (
    ACCESS_ADMIN, ACCESS_MEMBER, ACCESS_PUBLIC, access_level,
)
from ..common.store_db import get_meta, set_meta, store_conn, store_tx

_log = get_logger()

# --------------------------------------------------------------------------- 常量
ACCESS_META = {
    ACCESS_PUBLIC: {"id": ACCESS_PUBLIC, "label": "公开", "tone": "ok",
                    "desc": "无需登录即可访问（登录 / 注册 / 静态资源 / 分享页 / 协作通道）"},
    ACCESS_MEMBER: {"id": ACCESS_MEMBER, "label": "协作者", "tone": "info",
                    "desc": "登录后的协作者（member）即可访问"},
    ACCESS_ADMIN: {"id": ACCESS_ADMIN, "label": "仅管理员", "tone": "warn",
                   "desc": "仅管理员可访问"},
}
ACCESS_ORDER = [ACCESS_PUBLIC, ACCESS_MEMBER, ACCESS_ADMIN]
ACCESS_CHOICES = tuple(ACCESS_ORDER)

ROLE_ORDER = ["guest", "member", "admin"]
ROLE_META = [
    {"id": "guest", "name": "访客（未登录）", "icon": "bi-person", "tone": "mute",
     "desc": "未登录状态下可访问的接口（公开接口）"},
    {"id": "member", "name": "协作者", "icon": "bi-people", "tone": "info",
     "desc": "登录后的协作者（member）可访问的接口"},
    {"id": "admin", "name": "管理员", "icon": "bi-shield-lock", "tone": "ok",
     "desc": "管理员可访问全部接口"},
]

UNAUTHORIZED_HINT = ("访客被拒：跳转登录页；协作者被拒：接口返回 403、页面跳转受限协作页；"
                     "接口被停用：一律返回 403。")

# 蓝图 → 中文模块名
MODULE_NAMES = {
    "auth": "登录认证", "pages": "页面", "browser": "文件浏览", "zip": "压缩 / 解压",
    "delete": "删除与回收站", "archive_history": "归档历史", "fileops": "文件操作",
    "index": "全文索引", "progress_stream": "进度推送", "grep": "内容检索",
    "git": "Git 版本控制", "run": "运行 / 脚本执行", "port": "端口管理", "term": "终端会话",
    "env": "环境变量", "proc": "进程管理", "shares": "分享链接", "ai": "AI 能力",
    "agent": "AI 代理", "chat_history": "AI 会话历史", "pip": "Python 依赖", "npm": "Node 依赖",
    "plugins": "插件管理", "dbconn": "数据库连接", "httpreq": "HTTP 请求工具", "cron": "定时任务",
    "sshconn": "SSH 连接", "file_hints": "文件说明", "collab": "协作编辑", "adm": "后台管理",
}

# 首次登记时的默认说明（之后可在后台编辑；已编辑的不再覆盖）
RULE_DESC = {
    ("/admin", "GET"): "后台管理控制台页面",
    ("/api/adm/overview", "GET"): "概览：业务计数 + 系统资源 + 存储 + 最近动态",
    ("/api/adm/overview/resource", "GET"): "概览：仅系统资源快照（轻量，供页面轮询刷新）",
    ("/api/adm/config", "GET"): "系统配置快照（只读、无密钥）",
    ("/api/adm/logs", "GET"): "日志文件列表",
    ("/api/adm/log", "GET"): "读取日志文件尾部",
    ("/api/adm/users/summary", "GET"): "用户统计：总数 / 角色 / 状态 / 近 7 天新增",
    ("/api/adm/users", "GET"): "用户列表",
    ("/api/adm/users", "POST"): "新建用户",
    ("/api/adm/users/update", "POST"): "修改用户角色 / 重置密码",
    ("/api/adm/users/ban", "POST"): "封禁 / 解封用户",
    ("/api/adm/users/delete", "POST"): "删除用户",
    ("/api/adm/apis", "GET"): "接口目录列表",
    ("/api/adm/apis/summary", "GET"): "接口目录统计",
    ("/api/adm/apis/update", "POST"): "编辑接口登记（说明 / 级别 / 停用）",
    ("/api/adm/apis/permission", "POST"): "修改角色权限",
    ("/api/adm/apis/permission/materialize", "POST"): "生成全部角色权限的默认快照",
    ("/api/adm/apis/permission/clear", "POST"): "清除默认权限快照（保留手动设置）",
    ("/api/adm/apis/stats/reset", "POST"): "清零接口请求统计",
    ("/api/adm/apis/sync", "POST"): "从路由同步接口登记表",
    ("/api/shared/files", "GET"): "协作者：被分享文件清单 / 分享范围内目录",
    ("/api/adm/permissions", "GET"): "权限视图（角色 → 可访问接口）",
    ("/api/adm/pages", "GET"): "页面模块：全部页面级路由清单",
    ("/api/adm/pages/summary", "GET"): "页面模块：统计（总数 / 级别 / 分组）",
    ("/api/adm/pages/update", "POST"): "页面模块：编辑页面登记（说明 / 级别 / 停用）",
    ("/login", "*"): "登录页 / 提交登录",
    ("/register", "*"): "注册页 / 提交注册",
    ("/logout", "*"): "退出登录",
    ("/collab", "*"): "受限协作页（协作者）",
}

# 不允许停用 / 改权限的接口：避免把登录入口或管理入口锁死
_PROTECTED_RULES = {
    "/login", "/register", "/logout", "/admin",
    "/api/adm/apis", "/api/adm/apis/summary", "/api/adm/apis/update",
    "/api/adm/apis/permission", "/api/adm/apis/permission/materialize",
    "/api/adm/apis/permission/clear", "/api/adm/apis/stats/reset",
    "/api/adm/apis/sync", "/api/adm/apis/cleanup", "/api/adm/permissions",
    "/api/adm/pages", "/api/adm/pages/summary", "/api/adm/pages/update",
}
_PROTECTED_PREFIXES = ("/static", "/ws/")

# 权限表来源：手动设置（权威） / 默认快照（仅供参考，不参与鉴权）
SRC_MANUAL = "manual"
SRC_DEFAULT = "default"
_SNAPSHOT_KEY = "api_permission_snapshot"

_CACHE_TTL = 2.0
_lock = threading.RLock()
_cache = {"t": 0.0, "map": {}}
_synced = False


# --------------------------------------------------------------------------- 工具
def is_protected(rule):
    """受保护接口：禁止停用 / 改权限（登录入口、后台接口、静态资源、WS 通道）。"""
    rule = (rule or "").strip()
    return rule in _PROTECTED_RULES or rule.startswith(_PROTECTED_PREFIXES)


def role_allowed(role, level):
    """按访问级别推导某角色是否可访问（默认规则，未在权限表登记时使用）。"""
    if level == ACCESS_PUBLIC:
        return True
    if level == ACCESS_MEMBER:
        return role in ("member", "admin")
    return role == "admin"


def _kind(path):
    if path.startswith("/api/"):
        return "接口"
    if path.startswith("/ws/"):
        return "通道"
    if path.startswith("/static"):
        return "静态资源"
    return "页面"


def invalidate():
    """写入后立即失效缓存，让改动即时生效。"""
    with _lock:
        _cache["t"] = 0.0
        _cache["map"] = {}


def _snapshot_on():
    """是否开启了「默认权限快照」（开启后权限表会物化全部角色×接口行）。"""
    return str(get_meta(_SNAPSHOT_KEY) or "") == "1"


def _ensure_columns(conn):
    """老库补列：api_permission.source（区分手动设置 / 默认快照）。"""
    try:
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(api_permission)")}
        if cols and "source" not in cols:
            conn.execute("ALTER TABLE api_permission ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'")
    except Exception as e:
        _log.warning("给 api_permission 补列 source 失败：%s", e)


def _rebuild_defaults(conn):
    """重建「默认快照」行（仅当快照开启）：删除旧快照，按当前默认规则重新物化。

    手动设置（source='manual'）的行不受影响；INSERT OR IGNORE 会跳过已有手动的组合。
    """
    if not _snapshot_on():
        return 0
    now = time.time()
    conn.execute("DELETE FROM api_permission WHERE source=?", (SRC_DEFAULT,))
    for r in conn.execute("SELECT rule, method, access, access_default FROM api_interface WHERE orphan=0"):
        level = (r["access"] or "").strip() or (r["access_default"] or "").strip() or ACCESS_ADMIN
        if level not in ACCESS_META:
            level = ACCESS_ADMIN
        for role in ROLE_ORDER:
            conn.execute(
                "INSERT OR IGNORE INTO api_permission (role, rule, method, allowed, source, updated_at) "
                "VALUES (?,?,?,?,?,?)",
                (role, r["rule"], r["method"], 1 if role_allowed(role, level) else 0, SRC_DEFAULT, now))
    return int(conn.execute("SELECT COUNT(*) AS n FROM api_permission WHERE source=?",
                            (SRC_DEFAULT,)).fetchone()["n"] or 0)


# --------------------------------------------------------------------------- 同步
def _enumerate_routes():
    """从 Flask 路由表枚举全部接口（每个「路径 + 方法」一行）。"""
    rows = []
    for rule in current_app.url_map.iter_rules():
        ep = rule.endpoint or ""
        if ep == "static" or ep.endswith(".static") or rule.rule.startswith("/static"):
            continue
        methods = sorted(m for m in (rule.methods or ()) if m not in ("HEAD", "OPTIONS"))
        if not methods:
            continue
        bp = ep.split(".")[0] if "." in ep else ""
        params = ",".join(sorted(rule.arguments or []))
        for m in methods:
            rows.append({
                "rule": rule.rule, "method": m, "endpoint": ep,
                "module": bp, "module_name": MODULE_NAMES.get(bp, bp or "其他"),
                "kind": _kind(rule.rule), "params": params,
                "access_default": access_level(rule.rule, m),
                "desc": (RULE_DESC.get((rule.rule, m)) or RULE_DESC.get((rule.rule, "*")) or ""),
            })
    return rows


def _migrate_legacy_policy(conn):
    """把旧的 api_policy 表（上一版实现）合并进 api_interface 后删除。"""
    try:
        exists = conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='api_policy'").fetchone()
        if not exists:
            return
        for p in conn.execute("SELECT rule, method, access, disabled FROM api_policy"):
            conn.execute("UPDATE api_interface SET access=?, disabled=?, updated_at=? "
                         "WHERE rule=? AND method=?",
                         ((p["access"] or "").strip(), 1 if p["disabled"] else 0, time.time(),
                          p["rule"], p["method"]))
        conn.execute("DROP TABLE api_policy")
        _log.info("已将旧 api_policy 表合并进 api_interface 并删除")
    except Exception as e:
        _log.warning("迁移旧 api_policy 表失败：%s", e)


def sync_interfaces():
    """把当前路由表同步进 api_interface（新增登记、刷新代码字段、标记失效）。"""
    routes = _enumerate_routes()
    now = time.time()
    with store_tx() as conn:
        _ensure_columns(conn)
        conn.execute("UPDATE api_interface SET orphan=1")   # 先全部标记失效，再逐个恢复
        for r in routes:
            conn.execute(
                "INSERT OR IGNORE INTO api_interface "
                "(rule, method, endpoint, module, module_name, kind, params, desc, access, "
                " access_default, disabled, orphan, created_at, updated_at) "
                "VALUES (?,?,?,?,?,?,?,?,'',?,0,0,?,?)",
                (r["rule"], r["method"], r["endpoint"], r["module"], r["module_name"],
                 r["kind"], r["params"], r["desc"], r["access_default"], now, now))
            conn.execute(
                "UPDATE api_interface SET endpoint=?, module=?, module_name=?, kind=?, params=?, "
                "access_default=?, orphan=0, updated_at=? WHERE rule=? AND method=?",
                (r["endpoint"], r["module"], r["module_name"], r["kind"], r["params"],
                 r["access_default"], now, r["rule"], r["method"]))
        _migrate_legacy_policy(conn)
        _rebuild_defaults(conn)                             # 快照开启时同步刷新默认权限快照
        orphan = conn.execute("SELECT COUNT(*) AS n FROM api_interface WHERE orphan=1").fetchone()["n"]
    invalidate()
    _log.info("接口登记表已同步：共 %d 个接口，失效 %d 个", len(routes), orphan)
    return {"total": len(routes), "orphan": int(orphan or 0), "synced_at": now}


def ensure_synced(force=False):
    """确保登记表已同步（进程内只做一次；force=True 强制重同步）。"""
    global _synced
    if _synced and not force:
        return
    try:
        sync_interfaces()
        _synced = True
    except Exception as e:
        _log.warning("接口登记表同步失败：%s", e)


# --------------------------------------------------------------------------- 读取
def _row_out(row, perm, stat=None):
    """把 api_interface 行组装成前端需要的结构（并入角色权限与请求统计）。"""
    stat = stat or {}
    override = (row["access"] or "").strip()
    default = (row["access_default"] or "").strip()
    if default not in ACCESS_META:
        default = ACCESS_ADMIN
    level = override if override in ACCESS_META else default
    allowed, perm_override = {}, {}
    for role in ROLE_ORDER:
        p = perm.get(role)
        if p and p.get("source") == SRC_MANUAL:      # 仅「手动设置」才算权威 / 已改
            allowed[role] = bool(p.get("allowed"))
            perm_override[role] = True
        else:
            allowed[role] = role_allowed(role, level)
            perm_override[role] = False
    return {
        "path": row["rule"], "rule": row["rule"],
        "method": (row["method"] or "GET").upper(),
        "endpoint": row["endpoint"] or "", "module": row["module"] or "",
        "module_name": row["module_name"] or "", "kind": row["kind"] or "",
        "desc": row["desc"] or "",
        "params": [p for p in (row["params"] or "").split(",") if p],
        "access": level,
        "access_label": ACCESS_META[level]["label"], "access_tone": ACCESS_META[level]["tone"],
        "access_override": override, "access_default": default,
        "access_default_label": ACCESS_META[default]["label"],
        "overridden": bool(override),
        "disabled": bool(row["disabled"]), "orphan": bool(row["orphan"]),
        "can_manage": not is_protected(row["rule"]),
        "allowed": allowed, "perm_override": perm_override,
        # 请求统计（累计次数，含成功 / 失败）
        "total": int(stat.get("total") or 0),
        "ok": int(stat.get("ok") or 0),
        "fail": int(stat.get("fail") or 0),
        "last_at": stat.get("last_at") or 0,
        "last_status": int(stat.get("last_status") or 0),
        "updated_at": row["updated_at"] or 0,
    }


def list_interfaces():
    """接口目录（含失效行）；前端负责搜索 / 过滤 / 分页。"""
    ensure_synced()
    try:
        flush_stats()                    # 先把内存里累计的请求次数落库，保证页面数据最新
    except Exception as e:
        _log.warning("刷新接口请求统计失败：%s", e)
    stats = _stats_map()
    conn = store_conn()
    try:
        perms = {}
        for p in conn.execute("SELECT role, rule, method, allowed, source FROM api_permission"):
            perms.setdefault((p["rule"], (p["method"] or "GET").upper()), {})[p["role"]] = {
                "allowed": bool(p["allowed"]), "source": (p["source"] or SRC_MANUAL)}
        rows = [_row_out(r, perms.get((r["rule"], (r["method"] or "GET").upper()), {}),
                         stats.get((r["rule"], (r["method"] or "GET").upper())))
                for r in conn.execute("SELECT * FROM api_interface")]
    finally:
        conn.close()
    rows.sort(key=lambda x: (x["orphan"], x["module_name"], x["path"], x["method"]))
    return rows


def _module_rows(rows):
    """按模块汇总接口数：总数 + 各访问级别 + 已停用。"""
    mods = {}
    for r in rows:
        m = mods.setdefault(r["module"], {
            "module": r["module"], "name": r["module_name"], "total": 0, "disabled": 0,
            **{lvl: 0 for lvl in ACCESS_ORDER}})
        m["total"] += 1
        if r["disabled"]:
            m["disabled"] += 1
        else:
            m[r["access"]] += 1
    return sorted(mods.values(), key=lambda x: (-x["total"], x["name"]))


def _matrix(rows):
    """权限矩阵：每个模块下各角色「可访问」的接口数（停用接口不计入任何角色）。"""
    mods = {}
    for r in rows:
        m = mods.setdefault(r["module"], {
            "module": r["module"], "name": r["module_name"], "total": 0, "disabled": 0,
            **{role: 0 for role in ROLE_ORDER}})
        m["total"] += 1
        if r["disabled"]:
            m["disabled"] += 1
            continue
        for role in ROLE_ORDER:
            if r["allowed"].get(role):
                m[role] += 1
    return sorted(mods.values(), key=lambda x: (-x["total"], x["name"]))


def _stats(rows):
    levels = {lvl: sum(1 for r in rows if not r["disabled"] and r["access"] == lvl) for lvl in ACCESS_ORDER}
    return {
        "total": len(rows),
        "disabled": sum(1 for r in rows if r["disabled"]),
        "overridden": sum(1 for r in rows if r["overridden"]),
        "perm_overridden": sum(1 for r in rows if any(r["perm_override"].values())),
        "by_access": levels,
        "levels": [dict(ACCESS_META[k], count=levels[k]) for k in ACCESS_ORDER],
    }


def summary():
    """接口目录统计（不含失效行）。"""
    all_rows = list_interfaces()
    rows = [r for r in all_rows if not r["orphan"]]
    out = _stats(rows)
    out["orphan"] = len(all_rows) - len(rows)
    out["requests"] = sum(r["total"] for r in rows)
    out["failed"] = sum(r["fail"] for r in rows)
    out["modules"] = _module_rows(rows)
    out["roles"] = ROLE_META
    out["generated_at"] = int(time.time())
    return out


def permission_view():
    """权限视图：级别统计 + 全部接口（含各角色允许状态）+ 模块权限矩阵。"""
    all_rows = list_interfaces()
    rows = [r for r in all_rows if not r["orphan"]]
    out = _stats(rows)
    out["orphan"] = len(all_rows) - len(rows)
    out["roles"] = ROLE_META
    out["role_order"] = list(ROLE_ORDER)
    out["items"] = rows
    out["matrix"] = _matrix(rows)
    out["hint"] = UNAUTHORIZED_HINT
    out["snapshot"] = _snapshot_on()
    out["generated_at"] = int(time.time())
    return out


# --------------------------------------------------------------------------- 运行时鉴权
def _runtime_map():
    now = time.time()
    if now - _cache["t"] < _CACHE_TTL:
        return _cache["map"]
    try:
        m = {}
        conn = store_conn()
        try:
            for r in conn.execute("SELECT rule, method, access, access_default, disabled, orphan FROM api_interface"):
                m[(r["rule"], (r["method"] or "GET").upper())] = {
                    "access": (r["access"] or "").strip(),
                    "access_default": (r["access_default"] or "").strip(),
                    "disabled": bool(r["disabled"]),
                    "orphan": bool(r["orphan"]),
                    "manual": {},                    # 仅「手动设置」的权限参与鉴权
                }
            for p in conn.execute("SELECT role, rule, method, allowed, source FROM api_permission"):
                if (p["source"] or SRC_MANUAL) != SRC_MANUAL:
                    continue                          # 默认快照不参与鉴权
                ent = m.get((p["rule"], (p["method"] or "GET").upper()))
                if ent is not None:
                    ent["manual"][p["role"]] = bool(p["allowed"])
        finally:
            conn.close()
    except Exception as e:                       # 读库失败：沿用旧缓存，不影响服务
        _log.warning("读取接口登记 / 权限失败，沿用缓存：%s", e)
        return _cache["map"]
    _cache["map"] = m
    _cache["t"] = now
    return m


def lookup(rule, method="GET"):
    """取某接口的运行时候选登记（供鉴权）；未登记或已失效返回 None。"""
    ent = _runtime_map().get((rule or "", (method or "GET").upper()))
    if not ent or ent["orphan"]:
        return None
    return ent


# --------------------------------------------------------------------------- 写入
def _exists(rule, method):
    conn = store_conn()
    try:
        return conn.execute("SELECT 1 FROM api_interface WHERE rule=? AND method=?",
                            (rule, method)).fetchone() is not None
    finally:
        conn.close()


def update_interface(rule, method, desc=None, access=None, disabled=None):
    """编辑接口登记：说明 / 访问级别 / 停用。成功返回 None，失败返回错误信息。"""
    rule = (rule or "").strip()
    method = (method or "GET").strip().upper()
    if not rule:
        return "缺少接口路径"
    if not _exists(rule, method):
        return "接口不存在：%s %s" % (method, rule)
    sets, args = [], []
    if desc is not None:
        sets.append("desc=?")
        args.append(str(desc))
    if access is not None:
        access = (access or "").strip().lower()
        if access and access not in ACCESS_META:
            return "访问级别不合法"
        if is_protected(rule):
            return "该接口为受保护接口，不允许修改权限"
        sets.append("access=?")
        args.append(access)
    if disabled is not None:
        if is_protected(rule):
            return "该接口为受保护接口，不允许停用"
        sets.append("disabled=?")
        args.append(1 if disabled else 0)
    if not sets:
        return None
    sets.append("updated_at=?")
    args.append(time.time())
    args.extend([rule, method])
    with store_tx() as conn:
        conn.execute("UPDATE api_interface SET %s WHERE rule=? AND method=?" % ", ".join(sets), args)
        _rebuild_defaults(conn)                      # 快照开启时同步刷新默认权限快照
    invalidate()
    _log.info("接口登记已更新：%s %s %s", method, rule, "、".join(sets))
    return None


def _level_of(conn, rule, method):
    """取某接口的生效访问级别（覆盖优先，其次代码默认）。"""
    row = conn.execute("SELECT access, access_default FROM api_interface WHERE rule=? AND method=?",
                       (rule, method)).fetchone()
    if not row:
        return ACCESS_ADMIN
    level = (row["access"] or "").strip() or (row["access_default"] or "").strip() or ACCESS_ADMIN
    return level if level in ACCESS_META else ACCESS_ADMIN


def set_permission(role, rule, method, allowed):
    """设置「角色 + 接口」权限；allowed 为 None 时恢复默认。

    - allowed=True/False：写入手动设置（source='manual'，鉴权以它为准）；
    - allowed=None：删除手动记录；若开启了默认快照，则补回一行快照记录。
    """
    role = (role or "").strip()
    rule = (rule or "").strip()
    method = (method or "GET").strip().upper()
    if role not in ROLE_ORDER:
        return "角色不合法"
    if not _exists(rule, method):
        return "接口不存在：%s %s" % (method, rule)
    if is_protected(rule):
        return "该接口为受保护接口，不允许修改权限"
    now = time.time()
    with store_tx() as conn:
        if allowed is None:
            conn.execute("DELETE FROM api_permission WHERE role=? AND rule=? AND method=?",
                         (role, rule, method))
            if _snapshot_on():                       # 快照模式：恢复默认后补一行快照，保持表完整
                level = _level_of(conn, rule, method)
                conn.execute("INSERT OR REPLACE INTO api_permission "
                             "(role, rule, method, allowed, source, updated_at) VALUES (?,?,?,?,?,?)",
                             (role, rule, method, 1 if role_allowed(role, level) else 0, SRC_DEFAULT, now))
        else:
            conn.execute("INSERT OR REPLACE INTO api_permission "
                         "(role, rule, method, allowed, source, updated_at) VALUES (?,?,?,?,?,?)",
                         (role, rule, method, 1 if allowed else 0, SRC_MANUAL, now))
    invalidate()
    _log.info("接口权限已更新：%s %s %s -> %s", role, method, rule,
              "(默认)" if allowed is None else ("允许" if allowed else "禁止"))
    return None


def materialize_permissions():
    """生成「默认权限快照」：按当前规则把全部 角色×接口 物化进 api_permission（source='default'）。

    快照仅供参考 / 查库 / 导出，不参与鉴权；改接口级别后会随同步自动重建。
    """
    set_meta(_SNAPSHOT_KEY, "1")
    with store_tx() as conn:
        _ensure_columns(conn)
        n = _rebuild_defaults(conn)
    invalidate()
    _log.info("已生成默认权限快照：%d 行", n)
    return n


def clear_default_permissions():
    """清除默认权限快照（保留手动设置），返回删除行数。"""
    with store_tx() as conn:
        n = conn.execute("DELETE FROM api_permission WHERE source=?", (SRC_DEFAULT,)).rowcount
    set_meta(_SNAPSHOT_KEY, "0")
    invalidate()
    _log.info("已清除默认权限快照：%d 行", n or 0)
    return int(n or 0)


def cleanup_orphans():
    """清理已失效登记（连带删除其权限记录），返回清理条数。"""
    with store_tx() as conn:
        conn.execute("DELETE FROM api_permission WHERE EXISTS "
                     "(SELECT 1 FROM api_interface i WHERE i.orphan=1 "
                     " AND i.rule=api_permission.rule AND i.method=api_permission.method)")
        n = conn.execute("DELETE FROM api_interface WHERE orphan=1").rowcount
    invalidate()
    _log.info("已清理失效接口登记：%d 条", n or 0)
    return int(n or 0)


# --------------------------------------------------------------------------- 请求统计
# 说明：接口调用的计数在内存里累加（每来一个请求只做一次 dict 自增，不碰数据库），
# 后台线程每隔数秒批量落库（api_stats 表），避免高频写库拖慢每个请求。
_STATS_FLUSH_INTERVAL = 5.0
_stats_pending = {}
_stats_lock = threading.Lock()
_stats_flusher = None
_stats_atexit_done = False


def record_request(rule, method, status):
    """记录一次接口请求（含成功与失败）。只累加内存，随后由后台批量落库。"""
    global _stats_atexit_done
    if not rule or rule.startswith("/static"):
        return
    try:
        code = int(status or 0)
    except (TypeError, ValueError):
        code = 0
    key = (rule, (method or "GET").upper())
    with _stats_lock:
        e = _stats_pending.get(key)
        if e is None:
            e = _stats_pending[key] = {"total": 0, "ok": 0, "fail": 0, "last_at": 0.0, "last_status": 0}
        e["total"] += 1
        if 200 <= code < 400:
            e["ok"] += 1
        else:
            e["fail"] += 1
        e["last_at"] = time.time()
        e["last_status"] = code
    if not _stats_atexit_done:
        _stats_atexit_done = True
        try:
            import atexit
            atexit.register(_safe_flush_stats)
        except Exception:
            pass
    _ensure_stats_flusher()


def _safe_flush_stats():
    try:
        flush_stats()
    except Exception:
        pass


def _ensure_stats_flusher():
    global _stats_flusher
    if _stats_flusher is not None:
        return
    t = threading.Thread(target=_stats_flush_loop, name="api-stats", daemon=True)
    _stats_flusher = t
    t.start()


def _stats_flush_loop():
    while True:
        time.sleep(_STATS_FLUSH_INTERVAL)
        try:
            flush_stats()
        except Exception as e:
            _log.warning("接口请求统计落库失败（下一轮重试）：%s", e)


def flush_stats():
    """把内存中累计的请求次数批量写入 api_stats；返回本次写入的接口数。"""
    global _stats_pending
    with _stats_lock:
        if not _stats_pending:
            return 0
        batch = _stats_pending
        _stats_pending = {}
    try:
        with store_tx() as conn:
            for (rule, method), v in batch.items():
                cur = conn.execute(
                    "UPDATE api_stats SET total=total+?, ok=ok+?, fail=fail+?, "
                    "last_at=?, last_status=? WHERE rule=? AND method=?",
                    (v["total"], v["ok"], v["fail"], v["last_at"], v["last_status"], rule, method))
                if cur.rowcount == 0:
                    conn.execute(
                        "INSERT INTO api_stats (rule, method, total, ok, fail, last_at, last_status) "
                        "VALUES (?,?,?,?,?,?,?)",
                        (rule, method, v["total"], v["ok"], v["fail"], v["last_at"], v["last_status"]))
    except Exception:
        with _stats_lock:                       # 落库失败：合并回内存，下一轮重试
            for k, v in batch.items():
                cur = _stats_pending.get(k)
                if cur is None:
                    _stats_pending[k] = v
                else:
                    cur["total"] += v["total"]
                    cur["ok"] += v["ok"]
                    cur["fail"] += v["fail"]
                    if v["last_at"] > cur["last_at"]:
                        cur["last_at"] = v["last_at"]
                        cur["last_status"] = v["last_status"]
        raise
    return len(batch)


def _stats_map():
    """读取全部请求统计：{(rule, method): {...}}。"""
    conn = store_conn()
    try:
        return {(r["rule"], (r["method"] or "GET").upper()): {
            "total": int(r["total"] or 0), "ok": int(r["ok"] or 0), "fail": int(r["fail"] or 0),
            "last_at": r["last_at"] or 0, "last_status": int(r["last_status"] or 0),
        } for r in conn.execute("SELECT rule, method, total, ok, fail, last_at, last_status FROM api_stats")}
    finally:
        conn.close()


def reset_stats():
    """清零请求统计（内存 + 数据库），返回删除的统计行数。"""
    global _stats_pending
    with _stats_lock:
        _stats_pending = {}
    with store_tx() as conn:
        n = conn.execute("DELETE FROM api_stats").rowcount
    _log.info("已清零接口请求统计：%d 行", n or 0)
    return int(n or 0)

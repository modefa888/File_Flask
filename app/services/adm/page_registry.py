"""后台管理：页面模块 —— 系统里全部「页面」的清单与配置。

数据来源
--------
页面清单直接复用接口登记表（store.db · api_interface）里 kind='页面' 的行：
api_registry 在同步路由时已把非 /api、非 /ws、非 /static 的路由都登记为「页面」。
本模块不新增数据表，只在登记表之上叠加一层「页面语义」：

  - 友好名称 / 图标 / 分组 / 用途说明（PAGE_CATALOG，按 URL 规则静态配置）；
  - 把同一规则下的多个方法（如 /login 的 GET + POST）合并成一条「页面」；
  - 生成可直接打开的预览地址（带路径参数的页面不可直接打开）。

因此页面模块与接口模块 / 权限模块共用同一份权威数据：在这里改说明 / 访问级别 /
停用，与在接口模块里改的是同一行，鉴权口径完全一致（auth._require_login 按行判定）。
"""
import time

from ...log import get_logger
from . import api_registry

_log = get_logger()

# 分组展示顺序（未列出的分组排在最后，按名称排序）
GROUP_ORDER = ["文件管理", "编辑与协作", "分享", "账号与认证", "管理", "其他"]

# 页面目录：URL 规则 -> 友好名称 / 图标 / 分组 / 用途说明。
# 规则里可带 Flask 占位符（如 /share/<token>），与 api_interface.rule 一致。
PAGE_CATALOG = {
    "/": {"name": "文件管理首页", "icon": "bi-house-door", "group": "文件管理",
          "desc": "桌面端文件管理器首页；手机 UA 自动切换到移动版", "type": "页面"},
    "/desktop": {"name": "桌面端首页", "icon": "bi-window", "group": "文件管理",
                 "desc": "强制以桌面端打开的入口（/desktop）", "type": "页面"},
    "/m": {"name": "移动版首页", "icon": "bi-phone", "group": "文件管理",
           "desc": "强制以移动版打开的入口（/m）", "type": "页面"},
    "/mobile": {"name": "移动版首页（别名）", "icon": "bi-phone", "group": "文件管理",
                "desc": "移动版入口别名（/mobile）", "type": "页面"},
    "/ide": {"name": "在线 IDE 编辑页", "icon": "bi-code-square", "group": "编辑与协作",
             "desc": "类 VSCode 的在线开发页面（仅管理员，协作者转到协作页）", "type": "页面"},
    "/collab": {"name": "受限协作编辑页", "icon": "bi-people-fill", "group": "编辑与协作",
                "desc": "受邀协作者专属页：仅文件树 + 实时协作编辑", "type": "页面"},
    "/share/<token>": {"name": "分享访问页", "icon": "bi-share", "group": "分享",
                       "desc": "凭随机令牌访问被分享的文件 / 目录（可为密码模式）", "type": "页面"},
    "/share/<token>/qr": {"name": "分享二维码", "icon": "bi-qr-code", "group": "分享",
                          "desc": "分享链接二维码（PNG 资源）", "type": "资源"},
    "/share/<token>/cover": {"name": "分享封面图", "icon": "bi-image", "group": "分享",
                             "desc": "分享页封面 / 缩略图资源", "type": "资源"},
    "/share/<token>/lyrics": {"name": "分享歌词文本", "icon": "bi-music-note-list", "group": "分享",
                              "desc": "音频文件的歌词文本资源", "type": "资源"},
    "/share/<token>/raw": {"name": "分享原始文件", "icon": "bi-file-earmark", "group": "分享",
                           "desc": "分享范围内的原始文件内容", "type": "资源"},
    "/share/<token>/download": {"name": "分享下载", "icon": "bi-download", "group": "分享",
                                "desc": "分享文件下载入口", "type": "资源"},
    "/login": {"name": "登录页", "icon": "bi-box-arrow-in-right", "group": "账号与认证",
               "desc": "登录表单页与登录提交（GET + POST）", "type": "页面"},
    "/register": {"name": "注册页", "icon": "bi-person-plus", "group": "账号与认证",
                  "desc": "开放注册页与注册提交（GET + POST）", "type": "页面"},
    "/logout": {"name": "退出登录", "icon": "bi-box-arrow-right", "group": "账号与认证",
                "desc": "清除会话并跳回登录页", "type": "页面"},
    "/admin": {"name": "后台管理台", "icon": "bi-sliders", "group": "管理",
               "desc": "本后台控制台页面（仅管理员）", "type": "页面"},
}


def _catalog(rule):
    """取某规则的页面语义；未收录的返回空字典（由调用方兜底）。"""
    return PAGE_CATALOG.get(rule) or {}


def _preview_url(rule, type_):
    """生成可直接打开的预览地址；带路径参数或非页面资源返回空串。"""
    if not rule or "<" in rule or ">" in rule:
        return ""
    if type_ and type_ != "页面":
        return ""
    return rule


def _merge_rows(rows):
    """把同一规则的多个方法合并成一条「页面」记录。

    - methods：该规则支持的方法清单（排序）；
    - disabled：只要有一个方法被停用即视为停用（避免 GET 停 / POST 不停的歧义）；
    - 其余字段取首个方法行的值（同一规则的访问级别通常一致）。
    """
    merged = {}
    order = []
    for r in rows:
        rule = r.get("rule") or r.get("path") or ""
        if rule not in merged:
            merged[rule] = dict(r)
            merged[rule]["methods"] = []
            merged[rule]["disabled"] = False
            order.append(rule)
        item = merged[rule]
        m = (r.get("method") or "GET").upper()
        if m not in item["methods"]:
            item["methods"].append(m)
        if r.get("disabled"):
            item["disabled"] = True
    for rule in order:
        item = merged[rule]
        item["methods"].sort()
        item["method"] = "/".join(item["methods"])
    return [merged[rule] for rule in order]


def list_pages():
    """全部页面：接口登记表里 kind='页面' 的行，叠加页面语义后返回。"""
    api_registry.ensure_synced()
    rows = [r for r in api_registry.list_interfaces() if r.get("kind") == "页面"]
    pages = _merge_rows(rows)
    out = []
    for r in pages:
        rule = r.get("rule") or r.get("path") or ""
        cat = _catalog(rule)
        type_ = cat.get("type") or "页面"
        access = r.get("access") or ""
        out.append({
            "path": rule, "rule": rule,
            "name": cat.get("name") or rule,
            "icon": cat.get("icon") or ("bi-file-earmark" if type_ == "页面" else "bi-box"),
            "group": cat.get("group") or "其他",
            "note": cat.get("desc") or "",
            "type": type_,
            "href": _preview_url(rule, type_),
            "methods": r.get("methods") or [],
            "method": r.get("method") or "GET",
            "endpoint": r.get("endpoint") or "",
            "desc": r.get("desc") or "",
            "params": r.get("params") or [],
            "access": access,
            "access_label": r.get("access_label") or "",
            "access_tone": r.get("access_tone") or "mute",
            "access_override": r.get("access_override") or "",
            "access_default": r.get("access_default") or "",
            "access_default_label": r.get("access_default_label") or "",
            "overridden": bool(r.get("overridden")),
            "disabled": bool(r.get("disabled")),
            "orphan": bool(r.get("orphan")),
            "can_manage": bool(r.get("can_manage", True)),
            "total": int(r.get("total") or 0),
            "ok": int(r.get("ok") or 0),
            "fail": int(r.get("fail") or 0),
            "last_at": r.get("last_at") or 0,
            "last_status": int(r.get("last_status") or 0),
            "allowed": r.get("allowed") or {},
            "perm_override": r.get("perm_override") or {},
        })

    # 排序：分组顺序 -> 分组名 -> 路径；资源排在页面之后
    def sort_key(x):
        gi = GROUP_ORDER.index(x["group"]) if x["group"] in GROUP_ORDER else len(GROUP_ORDER)
        return (x["orphan"], gi, x["group"], 1 if x["type"] != "页面" else 0, x["path"])

    out.sort(key=sort_key)
    return out


def _groups(pages):
    """按分组汇总：数量 / 各级别 / 已停用。"""
    groups = {}
    for p in pages:
        g = groups.setdefault(p["group"], {
            "group": p["group"], "total": 0, "disabled": 0,
            "public": 0, "member": 0, "admin": 0})
        g["total"] += 1
        if p["disabled"]:
            g["disabled"] += 1
        elif p["access"] in ("public", "member", "admin"):
            g[p["access"]] += 1
    return sorted(groups.values(),
                  key=lambda x: (GROUP_ORDER.index(x["group"]) if x["group"] in GROUP_ORDER
                                 else len(GROUP_ORDER), x["group"]))


def summary():
    """页面模块统计：总数 / 级别分布 / 停用 / 失效 / 分组汇总。"""
    pages = list_pages()
    live = [p for p in pages if not p["orphan"]]
    levels = {lvl: sum(1 for p in live if not p["disabled"] and p["access"] == lvl)
              for lvl in api_registry.ACCESS_ORDER}
    level_meta = [dict(api_registry.ACCESS_META[k], count=levels.get(k, 0))
                  for k in api_registry.ACCESS_ORDER]
    return {
        "total": len(live),
        "orphan": len(pages) - len(live),
        "disabled": sum(1 for p in live if p["disabled"]),
        "overridden": sum(1 for p in live if p["overridden"]),
        "pages": sum(1 for p in live if p["type"] == "页面"),
        "resources": sum(1 for p in live if p["type"] != "页面"),
        "requests": sum(p["total"] for p in live),
        "failed": sum(p["fail"] for p in live),
        "by_access": levels,
        "levels": level_meta,
        "groups": _groups(live),
        "generated_at": int(time.time()),
    }


def update_page(rule, desc=None, access=None, disabled=None):
    """更新某页面的说明 / 访问级别 / 停用状态。

    一个页面可能对应多个 HTTP 方法（如 /login 有 GET 与 POST），
    这里对该规则下登记的全部方法一并修改，保证页面级操作整体一致。
    成功返回 None，失败返回错误信息（与 api_registry.update_interface 一致）。
    """
    rule = (rule or "").strip()
    if not rule:
        return "缺少页面路径"
    api_registry.ensure_synced()
    methods = sorted({
        (r.get("method") or "GET").upper()
        for r in api_registry.list_interfaces()
        if (r.get("rule") or r.get("path")) == rule and r.get("kind") == "页面"
    })
    if not methods:
        return "页面不存在：%s" % rule
    err = None
    for m in methods:
        e = api_registry.update_interface(rule, m, desc=desc, access=access, disabled=disabled)
        if e:
            err = e
    if err:
        return err
    _log.info("页面已更新：%s（%s）", rule, "、".join(methods))
    return None

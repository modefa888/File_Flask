"""运行环境 AI 安装方案（运行管理 → AI 安装）专用逻辑。

对应内置接口 POST /api/env/ai-install，只服务这一件事：
  使用者的需求描述（语言 / 版本 / 框架 / 服务）+ 本机快照 → 组织提问 →
  交给「设置 → 系统 AI」里 envinstall 模块选定的接口 / 模型 → 解析成结构化建议清单。

与 AI 助手面板完全分开：
  - 不读写对话记录（不往聊天里塞消息）；
  - 快照与提示词全部在服务端生成，前端只负责展示；
  - 只产出建议与命令文本，绝不执行：真正的一键安装走 envinstall 的白名单用户级方案
    （前端逐项调用 POST /api/env/install 并轮询日志），系统包 / 手动项只给命令供复制。
"""
import json
import re
import shutil

from . import envinstall, envprobe

_MAX_ITEMS = 8        # 一次最多建议多少项（多了安装队列太长、结论也散）
_MAX_CATALOG = 80     # 提示词里最多列多少个可选运行时

SYSTEM_PROMPT = """你是运行环境规划助手，服务对象是正在使用这个在线 IDE（项目 File_Flask，\
一个 Flask 编写的在线文件管理器 / IDE）的开发者。

使用者会用一句话描述他想做什么（语言、版本、框架、需要哪些服务）。你要结合「本机系统快照」\
与「可选运行时清单」，判断需要哪些运行时 / 工具，并给出安装方式。

只输出**一个 JSON 对象**，不要任何解释文字、不要 Markdown 代码围栏：
{
  "summary": "一句话结论：要装哪几件、用什么方式",
  "items": [
    {
      "id": "清单里的 id",
      "name": "显示名",
      "version": "建议版本，如 3.12 / LTS / 最新稳定版",
      "reason": "为什么需要它，不超过 30 字",
      "mode": "user | system | manual",
      "command": "mode 为 system / manual 时给一条可直接执行的命令；user 可留空"
    }
  ],
  "notes": ["1-3 条注意事项：镜像源、PATH 生效方式、版本冲突等"],
  "risk": "一句话风险提示"
}

规则：
- `id` 必须取自清单；清单里没有的能力（例如某个数据库服务）用 `"id": "custom"`，并在 `name` 里写清楚要装什么。
- 已经装好且版本满足需求的，**不要**放进 items；需要升级时才放，并在 reason 里说明。
- `mode` 的含义：`user` = 可用用户级方式装到 ~/.local（IDE 能一键装）；`system` = 需要管理员权限的系统包；\
`manual` = 只能手动装（下载安装包、启动服务等）。
- 优先 `user`：能用官方压缩包 / 安装脚本做到用户级的，就不要用系统包。
- 命令必须匹配快照里的操作系统与发行版；包名不确定就在 reason 里写「需确认包名」，不要编造。
- 命令要非交互（apt-get -y、dnf -y 等），不要 sudo -i / su -，不要破坏性命令（rm -rf /、mkfs、dd、chmod -R 777 /）。
- 最多 8 项，按重要性排序；如果不需要新装任何东西，`items` 给空数组。
- 全部用简体中文，不要寒暄。"""


# ------------------------------ 采集 ------------------------------
def _which(name: str) -> bool:
    try:
        return bool(shutil.which(name))
    except Exception:
        return False


def _pkg_managers() -> list:
    """本机可用的包管理器（顺序即优先级）。"""
    out = []
    for name, cmd in (("apt", "apt-get"), ("dnf", "dnf"), ("yum", "yum"), ("apk", "apk"),
                      ("pacman", "pacman"), ("zypper", "zypper"), ("brew", "brew")):
        if _which(cmd):
            out.append(name)
    return out or ["（没检测到常见包管理器）"]


def _tools() -> list:
    return [n for n in ("sudo", "curl", "wget", "git", "tar", "unzip", "python3", "make", "gcc")
            if _which(n)]


def _plan_list(rid: str) -> list:
    """内置安装方案（直接读常量表，不联网解析版本，避免接口变慢）。"""
    out = []
    for p in (envinstall.PLANS.get(rid) or []):
        label = str(p.get("label") or p.get("key") or "方案")
        item = {"key": str(p.get("key") or ""), "mode": str(p.get("mode") or ""), "label": label}
        if p.get("packages"):
            item["command"] = "sudo apt-get install -y " + " ".join(str(x) for x in p["packages"])
        out.append(item)
    return out


def snapshot(ids=None) -> dict:
    """采集一次「AI 安装」用快照：系统信息 + 已装 / 缺失 + 可选运行时清单。"""
    sysinfo = envprobe.system_info() or {}
    data = envprobe.probe_all(force=False) or {}
    items = data.get("items") or []

    catalog = [{
        "id": str(i.get("id") or ""),
        "label": i.get("label") or i.get("id") or "",
        "category": i.get("category") or "",
        "installed": bool(i.get("installed")),
        "version": i.get("version") or "",
    } for i in items if i.get("id")][:_MAX_CATALOG]

    return {
        "system": {
            "os": sysinfo.get("os") or "",
            "distro": sysinfo.get("distro") or "",
            "arch": sysinfo.get("arch") or "",
            "user": sysinfo.get("user") or "",
            "cpu": sysinfo.get("cpu") or "",
            "python": sysinfo.get("server_python") or "",
            "pkg_managers": _pkg_managers(),
            "tools": _tools(),
            "envs": [e for e in (sysinfo.get("envs") or []) if e.get("value")],
            "path_entries": (sysinfo.get("path_entries") or [])[:8],
        },
        "catalog": catalog,
        "catalog_map": {c["id"]: c for c in catalog},
        "installed_count": sum(1 for c in catalog if c["installed"]),
        "auto_install": envinstall.auto_install_enabled(),
        "detected_at": data.get("detected_at") or "",
        "focus_ids": [str(x).strip() for x in (ids or []) if str(x).strip()],
    }


# ------------------------------ 提问组织 ------------------------------
def build_messages(snap: dict, query: str = "") -> tuple:
    """把快照与需求组织成 (system 提示, 用户内容)；服务端是唯一真源。"""
    s = snap.get("system") or {}
    L = []
    L.append("[本机系统] %s %s · 架构 %s · 用户 %s · CPU %s 核" % (
        s.get("os") or "?", s.get("distro") or "", s.get("arch") or "?",
        s.get("user") or "?", s.get("cpu") or "?"))
    L.append("[可用包管理器] %s" % "、".join(s.get("pkg_managers") or []))
    L.append("[可用工具] %s" % ("、".join(s.get("tools") or []) or "（几乎都没有）"))
    L.append("[服务端 Python] %s" % (s.get("python") or "-"))
    envs = s.get("envs") or []
    if envs:
        L.append("[相关环境变量] " + "，".join("%s=%s" % (e.get("key"), e.get("value")) for e in envs))
    paths = s.get("path_entries") or []
    if paths:
        L.append("[PATH 前几项] " + " : ".join(str(p) for p in paths))
    L.append("")
    L.append("[一键安装] 本 IDE 的白名单用户级一键安装当前%s" % ("可用（装到 ~/.local，不需要管理员权限）"
                                                     if snap.get("auto_install") else "已关闭"))
    L.append("")
    L.append("[可选运行时清单]（id · 名称 · 分类 · 本机状态）")
    for c in (snap.get("catalog") or []):
        L.append("    - %s · %s · %s · %s" % (
            c.get("id"), c.get("label"), c.get("category") or "-",
            ("已安装 " + (c.get("version") or "")) if c.get("installed") else "未安装"))
    focus = snap.get("focus_ids") or []
    if focus:
        L.append("")
        L.append("[使用者在列表里点名的目标] " + "、".join(focus) + "（请优先考虑这些）")
    L.append("")
    L.append("[使用者的需求]")
    L.append(query.strip() or "（没有具体描述：请按本机缺失项给出常用开发环境建议）")
    L.append("")
    L.append("请只输出系统提示里要求的那个 JSON 对象。")
    return SYSTEM_PROMPT, "\n".join(L)


# ------------------------------ 结果解析 ------------------------------
def _norm_mode(v) -> str:
    v = str(v or "").strip().lower()
    return v if v in ("user", "system", "manual") else "manual"


# 模型常把 id 写成常见叫法（maven / jdk / nodejs…），这里兜一层别名与标签匹配
_ID_ALIAS = {
    "maven": "mvn", "jdk": "java", "jre": "java", "nodejs": "node", "node.js": "node",
    "python3": "python", "py": "python", "postgres": "psql", "postgresql": "psql",
    "pgsql": "psql", "mongodb": "mongo", "golang": "go", "rubygems": "gem",
    "docker compose": "docker-compose", "makefile": "make", "cpp": "gcc", "g++": "gcc",
}


def resolve_id(rid, name, cmap) -> str:
    """把模型给的 id / 名称对齐到清单里的 id；对不上返回空串（按「自定义」处理）。"""
    rid = str(rid or "").strip()
    if rid in cmap:
        return rid
    low = rid.lower()
    for k in cmap:
        if k.lower() == low:
            return k
    nm = str(name or "").strip().lower()
    if nm:
        for k, c in cmap.items():
            lbl = str(c.get("label") or "").lower()
            if lbl and (lbl == nm or lbl.startswith(nm) or nm in lbl):
                return k
    if low in _ID_ALIAS:
        k = _ID_ALIAS[low]
        if k in cmap:
            return k
    return ""


def parse_plan(text: str, snap: dict) -> dict:
    """把模型输出解析成结构化方案；解析不出来返回 None（调用方退化成纯文本展示）。"""
    t = (text or "").strip()
    if not t:
        return None
    t = re.sub(r"^```[a-zA-Z]*\s*", "", t)
    t = re.sub(r"\s*```$", "", t).strip()
    i, j = t.find("{"), t.rfind("}")
    if i < 0 or j <= i:
        return None
    try:
        obj = json.loads(t[i:j + 1])
    except Exception:
        return None
    if not isinstance(obj, dict):
        return None

    cmap = snap.get("catalog_map") or {}
    auto_ok = bool(snap.get("auto_install"))
    raw_items = obj.get("items")
    if isinstance(raw_items, dict):
        raw_items = [raw_items]
    if not isinstance(raw_items, list):
        raw_items = []

    items, seen = [], set()
    for r in raw_items:
        if not isinstance(r, dict):
            continue
        raw_id = str(r.get("id") or "").strip()
        name = str(r.get("name") or "").strip()
        rid = resolve_id(raw_id, name, cmap)          # 对齐到清单 id（maven → mvn 这类）
        cat = cmap.get(rid) or {}
        key = rid or name or raw_id
        if not key or key in seen:
            continue
        seen.add(key)
        plans = _plan_list(rid) if rid else []
        user_plan = next((p for p in plans if p["mode"] == "user"), None)
        mode = _norm_mode(r.get("mode"))
        cmd = str(r.get("command") or "").strip()
        if not cmd and plans:
            cmd = next((p.get("command") for p in plans if p.get("command")), "") or ""
        items.append({
            "id": rid,
            "name": name or cat.get("label") or rid,
            "label": cat.get("label") or name or rid,
            "category": cat.get("category") or "",
            "version": str(r.get("version") or "").strip(),
            "reason": str(r.get("reason") or "").strip()[:80],
            "mode": mode,
            "command": cmd,
            "plans": plans,
            "plan_key": (user_plan or {}).get("key", ""),
            # 只有「用户级方案 + 白名单一键安装开着」才能真正自动装
            "auto": bool(user_plan) and auto_ok,
            "installed": bool(cat.get("installed")),
            "installed_version": cat.get("version") or "",
        })
        if len(items) >= _MAX_ITEMS:
            break

    notes = obj.get("notes")
    if isinstance(notes, str):
        notes = [notes]
    if not isinstance(notes, list):
        notes = []

    return {
        "summary": str(obj.get("summary") or "").strip(),
        "items": items,
        "notes": [str(n).strip() for n in notes if str(n).strip()][:4],
        "risk": str(obj.get("risk") or "").strip(),
    }


def render_text(plan: dict) -> str:
    """把结构化方案渲染成 Markdown（前端在没有 items 时按纯文本展示 / 便于复制）。"""
    L = []
    if plan.get("summary"):
        L.append("**" + plan["summary"] + "**")
        L.append("")
    items = plan.get("items") or []
    if items:
        L.append("## 建议安装")
        for it in items:
            L.append("- %s%s —— %s（%s）" % (
                it.get("name"), (" " + it["version"]) if it.get("version") else "",
                it.get("reason") or "", "可一键安装" if it.get("auto") else "需手动 / 管理员权限"))
        L.append("")
    for it in items:
        if it.get("command") and not it.get("auto"):
            L.append("```bash")
            L.append(it["command"])
            L.append("```")
    notes = plan.get("notes") or []
    if notes:
        L.append("## 注意")
        for n in notes:
            L.append("- " + n)
    if plan.get("risk"):
        L.append("")
        L.append("> 风险提示：" + plan["risk"])
    return "\n".join(L).strip()


def clean_answer(text: str) -> str:
    """清掉模型常见的包裹壳（整体包在 ``` 里、前后寒暄）。"""
    t = (text or "").strip()
    if not t:
        return ""
    if t.startswith("```") and t.rstrip().endswith("```"):
        parts = t.split("\n", 1)
        if len(parts) == 2 and parts[0].strip().lstrip("`").lower() in (
                "", "markdown", "md", "text", "json"):
            body = parts[1]
            t = body[: body.rstrip().rfind("```")] if "```" in body else body
    return t.strip()

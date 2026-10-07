"""资源诊断（进程资源管理器 → AI 诊断）专用逻辑。

对应内置接口 POST /api/proc/diagnose，只服务这一件事：
  采集本机资源快照 → 组织提问 → 交给「设置 → 系统 AI」里为 proc 模块选定的接口/模型。

与 AI 助手面板完全分开：
  - 不读写对话记录（旧实现是把报告当成一条用户消息塞进 AI 面板）；
  - 快照、候选进程、提示词全部在服务端生成，前端只负责展示，避免两边阈值与文案不一致；
  - 只读采集，只产出建议文本；结束进程仍走 POST /api/proc/kill（前端逐个确认）。

安全约束沿用 procinfo：只读采集 + 只按 pid 结束进程，不接受任何命令文本。
"""
from . import procinfo

# 高占用阈值：与前端「一键优化」保持一致的语义（CPU ≥ 25% 或常驻内存 ≥ 500MB）
HOT_CPU = 25.0
HOT_MEM = 500 * 1024 * 1024
_TOP_N = 12                                            # 列表里最多列多少条进程
_PORT_N = 20                                           # 最多列多少个监听端口
_CMD_CHARS = 200                                       # 命令行截断长度（避免请求体过大）
_CAND_N = 20                                           # 最多返回多少个候选进程

SYSTEM_PROMPT = """你是一名运行在开发者本机的资源诊断助手，服务对象是正在使用这个在线 IDE（项目 File_Flask，\
一个 Flask 编写的在线文件管理器 / IDE）的开发者。

你会收到一份「本机此刻的资源快照」：整机 CPU / 内存 / 磁盘 / 网络、占用最高的进程、监听端口，\
以及已经筛好的「可安全结束的高占用进程」。请判断当前状态是否正常，并给出可以直接执行的处置建议。

输出要求（Markdown、简体中文、不要寒暄和自我介绍）：
1. 第一行给**一句话总体结论**（正常 / 需要注意 / 异常，以及最值得关注的一项）。
2. `## 可疑项`：逐条列出，每条一行 `- 名称（pid 1234）：现象 → 判断依据`；没有可疑项就写「无」。
3. `## 处理建议`：按优先级编号，每条写清楚「做什么、怎么做、预期收益」。涉及命令的用 ```bash 代码块给出。
4. 结尾用一行 `> 风险提示：……` 说明哪些进程不要动、原因是什么。

硬性约束：
- 只做分析和建议，绝对不要自行执行或让对方盲跑结束进程、删文件等破坏性操作；不要出现 `kill -9 1`、`sudo rm -rf /` 这类危险命令。
- 只依据快照数据下结论；数据不足时直接说明「还需要什么信息」，不要编造进程名、端口或数字。
- 标了「本服务」的进程是本 IDE 自己的进程链，必须单独说明，绝不能建议把 IDE 服务本身杀掉。
- 不要建议重启整机或重装系统作为首选方案。"""


# ------------------------------ 数值格式化（与前端展示口径一致） ------------------------------
def _size(n) -> str:
    n = float(n or 0)
    for u in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024 or u == "TB":
            return ("%d %s" % (round(n), u)) if u == "B" else ("%.1f %s" % (n, u))
        n /= 1024.0
    return "%.1f TB" % n


def _pct(v) -> str:
    v = float(v or 0)
    return ("%.0f%%" % v) if v >= 10 else ("%.1f%%" % v)


def _rate(v) -> str:
    v = float(v or 0)
    if v < 1024:
        return "%d B/s" % round(v)
    if v < 1024 * 1024:
        return "%.1f KB/s" % (v / 1024)
    return "%.2f MB/s" % (v / 1048576)


def _dur(sec) -> str:
    sec = max(0, int(sec or 0))
    d, h, m = sec // 86400, sec % 86400 // 3600, sec % 3600 // 60
    if d:
        return "%d 天 %d 小时" % (d, h)
    if h:
        return "%d 小时 %d 分" % (h, m)
    return "%d 分 %d 秒" % (m, sec % 60)


def _clock(ts) -> str:
    import time
    return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(ts or time.time()))


# ------------------------------ 快照 ------------------------------
def _row(r: dict, why: str = "") -> dict:
    """进程行：只保留展示与建议需要的字段（命令行截断，避免请求体过大）。"""
    return {
        "pid": r.get("pid"),
        "name": r.get("name") or "(未知)",
        "user": r.get("user") or "",
        "cpu": round(float(r.get("cpu") or 0.0), 1),
        "rss": int(r.get("rss") or 0),
        "threads": int(r.get("threads") or 0),
        "cmd": (r.get("cmd") or "")[:_CMD_CHARS],
        "in_app": bool(r.get("in_app")),
        "can_kill": bool(r.get("can_kill")),
        "kill_hint": r.get("kill_hint") or "",
        "why": why,
    }


def candidates(procs) -> list:
    """筛出「确实占资源、又能安全结束」的进程（一键优化与 AI 诊断共用同一套规则）。"""
    out = []
    for r in procs or []:
        if not r.get("can_kill") or r.get("in_app"):
            continue
        cpu, rss = float(r.get("cpu") or 0.0), int(r.get("rss") or 0)
        bits = []
        if cpu >= HOT_CPU:
            bits.append("CPU " + _pct(cpu))
        if rss >= HOT_MEM:
            bits.append("内存 " + _size(rss))
        if not bits:
            continue
        out.append(_row(r, " / ".join(bits)))
    out.sort(key=lambda x: -x["rss"])
    return out[:_CAND_N]


def snapshot() -> dict:
    """采集一次诊断用快照：整机指标 + 高占用进程 + 端口 + 候选进程。

    返回 dict；psutil 不可用等采集失败时带 error 字段（调用方直接提示用户）。
    """
    ov = procinfo.overview()
    if ov.get("error"):
        return {"error": ov["error"]}
    res = procinfo.processes(sort="cpu", limit=400)
    if res.get("error"):
        return {"error": res["error"]}
    procs = res.get("procs") or []
    ports = (procinfo.ports() or {}).get("ports") or []
    top_cpu = [_row(r) for r in procs[: _TOP_N * 2]]
    top_mem = [_row(r) for r in sorted(procs, key=lambda x: -int(x.get("rss") or 0))[:_TOP_N]]
    return {
        "time": ov.get("time"),
        "ov": ov,
        "proc_total": res.get("count") or 0,
        "top_cpu": top_cpu[:_TOP_N],
        "top_mem": top_mem,
        "ports": [{
            "port": p.get("port"), "proto": p.get("proto"), "addr": p.get("addr"),
            "name": p.get("name") or "", "pid": p.get("pid"),
            "mine": bool(p.get("mine")),
            "cmd": (p.get("cmd") or "")[:_CMD_CHARS],
        } for p in ports[:_PORT_N]],
        "port_total": len(ports),
        "candidates": candidates(procs),
    }


# ------------------------------ 提问组织 ------------------------------
def build_messages(snap: dict, focus: str = "") -> tuple:
    """把快照组织成 (system 提示, 用户内容)。服务端是唯一真源，前端不再拼报告。"""
    ov = snap.get("ov") or {}
    cpu, mem, disk, net = ov.get("cpu") or {}, ov.get("mem") or {}, ov.get("disk") or {}, ov.get("net") or {}
    self_ = ov.get("self") or {}
    counts = ov.get("counts") or {}
    L = []
    L.append("[采集时间] " + _clock(snap.get("time")))
    L.append("[整机 CPU] %s（%s 核%s）" % (
        _pct(cpu.get("percent")), cpu.get("cores") or 1,
        "，负载 " + " / ".join(str(x) for x in (cpu.get("load") or [])) if cpu.get("load") else ""))
    for g in cpu.get("groups") or []:
        L.append("    - %s：%s（%s 个进程）" % (g.get("name"), _pct(g.get("percent")), g.get("count")))
    L.append("[内存] %s，已用 %s / 共 %s%s" % (
        _pct(mem.get("percent")), _size(mem.get("used")), _size(mem.get("total")),
        "，交换 %s / %s（%s）" % (_size(mem.get("swap_used")), _size(mem.get("swap_total")),
                                  _pct(mem.get("swap_percent"))) if mem.get("swap_total") else ""))
    for g in mem.get("groups") or []:
        L.append("    - %s：%s（%s 个进程）" % (g.get("name"), _size(g.get("bytes")), g.get("count")))
    L.append("[磁盘] %s 已用 %s，可用 %s / 共 %s" % (
        _pct(disk.get("percent")), _size(disk.get("used")), _size(disk.get("free")), _size(disk.get("total"))))
    for p in (disk.get("parts") or [])[:5]:
        L.append("    - %s（%s）已用 %s %s" % (p.get("mount"), p.get("fstype") or "?",
                                             _pct(p.get("percent")), "· 工作区所在分区" if p.get("main") else ""))
    L.append("[网络] 上行 %s，下行 %s（开机累计 ↑ %s / ↓ %s）" % (
        _rate(net.get("up")), _rate(net.get("down")), _size(net.get("sent")), _size(net.get("recv"))))
    L.append("[进程总数] %s 个（本服务相关 %s 个 / 我的其他进程 %s 个 / 系统与其他用户 %s 个）" % (
        counts.get("total") or 0, counts.get("app") or 0, counts.get("mine") or 0, counts.get("sys") or 0))
    L.append("[系统已运行] %s" % _dur(ov.get("uptime")))
    L.append("[本服务自身] pid %s · 内存 %s · CPU %s · 线程 %s" % (
        self_.get("pid") or "-", _size(self_.get("rss")), _pct(self_.get("cpu")), self_.get("threads") or 0))
    L.append("")
    L.append("[CPU 占用最高的进程]")
    _append_procs(L, snap.get("top_cpu"))
    L.append("")
    L.append("[内存占用最高的进程]")
    _append_procs(L, snap.get("top_mem"))
    L.append("")
    L.append("[监听中的端口] 共 %s 个，前 %s 个：" % (snap.get("port_total") or 0, len(snap.get("ports") or [])))
    if snap.get("ports"):
        for p in snap["ports"]:
            L.append("    - %s/%s %s：%s（pid %s%s）" % (
                p.get("proto"), p.get("port"), p.get("addr") or "*", p.get("name") or "-",
                p.get("pid") or "-", "，我的进程" if p.get("mine") else ""))
    else:
        L.append("    - （没读到监听端口）")
    L.append("")
    cands = snap.get("candidates") or []
    L.append("[可安全结束的高占用进程]（CPU ≥ %s 或内存 ≥ %s，且属于当前用户、不属于本服务进程链）" % (
        _pct(HOT_CPU), _size(HOT_MEM)))
    if cands:
        for c in cands:
            L.append("    - pid %s %s：%s，用户 %s" % (c.get("pid"), c.get("name"), c.get("why"), c.get("user") or "-"))
    else:
        L.append("    - （没有符合阈值且可安全结束的进程）")
    if focus:
        L.append("")
        L.append("[使用者的补充关注点] " + focus)
    L.append("")
    L.append("请按系统提示要求的格式给出结论。")
    return SYSTEM_PROMPT, "\n".join(L)


def _append_procs(L: list, rows) -> None:
    rows = rows or []
    if not rows:
        L.append("    - （没取到进程列表）")
        return
    for r in rows:
        L.append("    - pid %s %s：CPU %s，内存 %s，线程 %s，用户 %s%s" % (
            r.get("pid"), r.get("name"), _pct(r.get("cpu")), _size(r.get("rss")), r.get("threads") or 0,
            r.get("user") or "-", "（本服务）" if r.get("in_app") else ""))


# ------------------------------ 结论清洗 ------------------------------
def clean_answer(text: str) -> str:
    """清掉模型常见的包裹壳：整体包在 ``` 围栏里、或前面带一句「好的」寒暄。"""
    t = (text or "").strip()
    if not t:
        return ""
    m = None
    if t.startswith("```") and t.rstrip().endswith("```"):
        first = t.split("\n", 1)
        if len(first) == 2 and first[0].strip().lstrip("`").lower() in (
                "", "markdown", "md", "text", "结论", "分析"):
            body = first[1]
            m = body[: body.rstrip().rfind("```")] if "```" in body else body
    if m is not None:
        t = m.strip()
    return t

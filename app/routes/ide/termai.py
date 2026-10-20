"""终端 AI 助手：自然语言 → 命令建议（含风险说明）→ 执行 → 输出解读。

交互参考腾讯云 OrcaTerm 的 AI Agent：用户在终端里直接说「查看当前ip」，
AI 先给「意图 + 风险判断 + 推荐命令 + 说明」，用户点「执行」后命令照常走
/api/term/exec 的安全校验（拦截 / 二次确认），执行完再把输出交给 AI 做结构化解读。

端点：
  GET  /api/term/ai/status    当前是否可用（未配置接口 / 已在系统 AI 里停用）
  POST /api/term/ai/plan      {input, cwd, history?}   → 命令建议（非流式）
  POST /api/term/ai/analyze   {question, command, stdout, stderr, exit_code, cwd, context?}
                              → SSE 流式解读（data: {"delta"} … data: [DONE]）

设计取舍：
  - 本模块只做「建议 / 解读」，不执行命令 —— 执行统一走 term.py，避免出现第二条
    绕过命令安全策略的执行路径。
  - 模型输出必须是 JSON，解析失败时退化为「只给说明、不给命令」，不让脏数据变成可执行命令。
  - 命令长度、输出长度都做硬截断，避免超长文本把下一次请求的上下文撑爆。
"""
import getpass
import json
import os
import platform
import re
import socket
import time
import urllib.error
import urllib.request

from flask import Blueprint, Response, jsonify, request

from ...log import get_logger
from ...services.common.safety import check_command
from ...services.common.store_db import store_conn, store_tx
from ...services.ide.web_search import search_web, format_results

_log = get_logger()
bp = Blueprint("termai", __name__)

_PLAN_TIMEOUT = 90                  # 生成命令建议的超时（联网搜索最多占 12 秒，剩下的给模型）
_LIVE_TIMEOUT = 180                 # 流式解读的读超时
_MAX_INPUT = 800                    # 用户自然语言输入上限
_MAX_CMD = 500                      # 生成的命令上限
_MAX_STDOUT = 6000                  # 回填给模型的输出上限（头尾各取一部分）
_MAX_CONTEXT = 1500                 # 上一轮上下文上限
_RETRY_STATUS = {429, 500, 502, 503, 504, 520, 522, 524}
_SESSION_TIMEOUT = 240              # 会话复盘的读超时（记录较长，给足时间）
_MAX_SESSION_RAW = 400_000          # 前端传来的原始会话文本上限
_SESSION_BUDGET = 18000             # 压缩后喂给模型的字符上限（约 8~9k token）
_MAX_LINE = 400                     # 单行上限（个别输出会一行几万字符，直接砍掉尾巴）

_PLAN_SYS = (
    "你是嵌入在 Web IDE 终端里的 Linux 运维助手。用户用一句自然语言描述他想在这台机器上做的事，"
    "你要把它翻译成一条可直接执行的 shell 命令，并给出风险判断。\n"
    "只输出一个 JSON 对象（不要 Markdown 围栏、不要任何解释文字、不要多余字段），字段如下：\n"
    '  "intent"：一句话复述用户想做什么（不超过 30 字）；\n'
    '  "risk"："low" | "medium" | "high"；\n'
    '  "reason"：风险判断依据（20~40 字，例如「这是一条只读的信息采集命令，不会修改系统状态」）；\n'
    '  "command"：一条命令；多条动作用 && 串联；只是提问、无需执行命令时给空字符串；\n'
    '  "explain"：这条命令做了什么（40~80 字），必要时补充替代做法；\n'
    '  "alternatives"：1~2 条可选命令的数组，没有就给 []。\n'
    "规则：\n"
    "1. 风险分级：只读查询（ls / cat / ip / df / ps / systemctl status 等）为 low；"
    "会改文件、装包、启停服务为 medium；删除数据、改权限、改系统配置、rm -rf、dd、mkfs、关机重启为 high。\n"
    "2. 优先只读方案；用户没有明确要求时不要加 sudo，不要用重定向直接改系统文件。\n"
    "3. 命令必须能在 bash 中一次跑通，不要出现占位符（如 <路径>）；信息不足时按当前目录与常见默认值推断。\n"
    "4. 绝不输出命令的执行结果，只输出命令本身。\n"
    "5. 联网：如果消息里带 [联网搜索结果]，命令中出现的下载地址 / 仓库地址 / 软件源 / 版本号"
    "必须优先采用搜索结果里来自官方站点（.org / .com 官网、官方 GitHub、官方文档）的信息，"
    "严禁凭记忆编造 URL；搜索结果与你的记忆冲突时以搜索结果为准；没有搜索结果时才用保守的通用做法。"
)

_LIVE_SYS = (
    "你是终端输出解读助手。用户刚在服务器上执行了一条命令，你要用简短中文把结果讲清楚。\n"
    "输出要求：\n"
    "1. 第一句先给结论：这次执行成功还是失败、得到了什么；\n"
    "2. 再用 1~4 条要点列出关键信息（IP、网卡、占用、进程、错误原因等），只写输出里真实存在的内容；\n"
    "3. 输出为空、报错或明显不符合预期时，指出可能原因，并给出下一步可执行的命令；\n"
    "4. 使用 Markdown（短标题、无序列表、行内代码），不要用代码块包住整段回答；"
    "不要复述原始输出，不要编造输出里没有的信息；\n"
    "5. 总长不超过 200 字。"
)

_SESSION_SYS = (
    "你是 Linux 运维专家，正在复盘一段 Web 终端里的完整会话记录（用户在终端里输入的命令，"
    "以及系统回显）。请通读整段记录后输出一份中文复盘，用 Markdown，结构固定为：\n"
    "**会话概览**：一句话说明这次会话做了什么、是否顺利（不超过 60 字）；\n"
    "**执行的命令**：按顺序列出关键命令，每条后面用半句话标注结果（成功 / 报错 / 未完成）；\n"
    "**发现的问题**：列出记录中真实出现的报错、警告与异常，引用原始关键字；没有就写「无明显异常」；\n"
    "**风险提示**：涉及装包、改配置、删文件、改权限、防火墙、对外开放端口等操作时说明风险与影响，"
    "纯只读查询不必展开；\n"
    "**建议下一步**：2~4 条可执行的检查或修复，用行内代码表示。\n"
    "要求：只依据记录内容做判断，不要编造记录里没有的输出；记录若出现「…（省略 N 行）…」表示"
    "中间被压缩，结论要据此说明依据可能不全；总长不超过 700 字；不要用代码块包住整段回答。"
)


def _ai():
    """延迟导入 AI 路由模块（避免与应用启动顺序耦合）。"""
    from . import ai as mod
    return mod


# ---------------------------------------------------------------- 工具函数
def _env_brief(cwd: str) -> str:
    """当前机器与工作目录的简要描述（给模型做判断依据，不含敏感信息）。"""
    bits = []
    try:
        bits.append("系统：" + (platform.system() or "Linux") + " " + (platform.release() or ""))
    except Exception:                                   # noqa: BLE001 - 环境探测失败不影响主流程
        pass
    try:
        with open("/etc/os-release", encoding="utf-8", errors="replace") as fp:
            for line in fp:
                if line.startswith("PRETTY_NAME="):
                    bits.append("发行版：" + line.split("=", 1)[1].strip().strip('"'))
                    break
    except OSError:
        pass
    try:
        bits.append("主机：" + socket.gethostname())
    except Exception:                                   # noqa: BLE001
        pass
    try:
        bits.append("用户：" + getpass.getuser())
    except Exception:                                   # noqa: BLE001
        bits.append("用户：" + os.environ.get("USER", "user"))
    bits.append("Shell：bash")
    if cwd:
        bits.append("当前目录：" + cwd)
    return "；".join(b for b in bits if b)


def _trim_mid(text: str, limit: int) -> str:
    """超长输出保留头尾：开头的表头与结尾的报错同样重要，中间省略。"""
    s = str(text or "")
    if len(s) <= limit:
        return s
    head = int(limit * 0.35)
    tail = limit - head
    return s[:head] + "\n…（中间省略 %d 字符）…\n" % (len(s) - limit) + s[-tail:]


_ANSI_RE = re.compile(
    r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)"          # OSC（标题 / 超链接）
    r"|\x1b\[[0-9;?]*[ -/]*[@-~]"                  # CSI（颜色 / 光标）
    r"|\x1b[()][A-Za-z0-9]"                        # 字符集切换
    r"|[\u0000-\u0008\u000b\u000c\u000e-\u001f]")  # 其余控制字符

# 报错 / 警告关键词：压缩长会话时这些行必须留下，模型才有判断依据
_ERR_LINE_RE = re.compile(
    r"(error|fail(?:ed|ure|s)?|denied|not found|no such file|command not found|cannot|"
    r"could ?not|refused|timeout|timed out|killed|segmentation|panic|fatal|"
    r"permission denied|EACCES|ENOENT|Traceback|No space left)", re.I)
_WARN_LINE_RE = re.compile(r"(warn|deprecated|unable|missing|skipped|insecure|conflict)", re.I)

# 命令行：提示符形如 root@host:~# cmd / [root@host ~]# cmd / user@host:/tmp$ cmd
_PROMPT_CMD_RE = re.compile(
    r"(?:^|\s)(?:\[[^\]\n]{1,80}\]|[^\s@\[\]]{1,40}@[^\s:\]]{1,64}:[^\s#$]{0,200})[#$]\s+(\S.*)$")


def _strip_ansi(text: str) -> str:
    """去掉终端控制序列（前端取的是 xterm 渲染后的文本，正常已无颜色，这里兜底）。"""
    return _ANSI_RE.sub("", str(text or ""))


def _prompt_command(line: str) -> str:
    """从一行里取出「提示符后面的命令」，不是命令行则返回空串。"""
    m = _PROMPT_CMD_RE.search(str(line or ""))
    return m.group(1).strip() if m else ""


def _condense_session(text: str, budget: int = _SESSION_BUDGET) -> str:
    """把整段终端会话压到预算内，同时保证命令与报错不被裁掉。

    会话动辄几百上千行、几 MB，直接塞给模型既费 token 也会把关键信息淹没。
    压缩规则：短会话原样保留；长会话留下所有「命令行 + 紧随其后几行」、所有含错误
    关键词的行、开头登录信息与结尾当前状态，中间省略处标出「省略 N 行」，
    让模型知道上下文不完整。
    """
    s = _strip_ansi(text)[:_MAX_SESSION_RAW]
    s = s.replace("\r\n", "\n").replace("\r", "\n")

    lines = []
    blank = 0
    for raw in s.split("\n"):
        ln = raw[:_MAX_LINE].rstrip()
        if ln.strip():
            blank = 0
            lines.append(ln)
        else:
            blank += 1
            if blank <= 1:                       # 连续空行只留一个
                lines.append("")

    size = sum(len(x) + 1 for x in lines)
    if size <= budget:
        return "\n".join(lines)

    n = len(lines)
    keep = set()
    for i, ln in enumerate(lines):
        if _prompt_command(ln):
            # 命令本身 + 紧随其后的输出（表头 / 结果通常就在前几行）
            for j in range(i, min(n, i + 8)):
                keep.add(j)
        if _ERR_LINE_RE.search(ln):
            for j in range(max(0, i - 1), min(n, i + 2)):
                keep.add(j)
        elif _WARN_LINE_RE.search(ln):
            keep.add(i)
    for j in range(0, min(n, 15)):               # 开头：登录信息 / 系统版本
        keep.add(j)
    for j in range(max(0, n - 80), n):           # 结尾：当前状态与最后的报错
        keep.add(j)

    picked, prev = [], -2
    for i in range(n):
        if i in keep:
            if prev >= 0 and i - prev > 1:
                picked.append("…（省略 %d 行）…" % (i - prev - 1))
            picked.append(lines[i])
            prev = i
    body = "\n".join(picked)
    if len(body) > budget:                       # 关键行本身就超预算：保留头尾
        body = _trim_mid(body, budget)
    return body


def _json_block(text: str):
    """从模型输出里取出第一个 JSON 对象；容忍围栏、前后废话与尾逗号。"""
    s = _ai()._strip_fence(text or "")
    m = re.search(r"\{[\s\S]*\}", s)
    if not m:
        return None
    raw = re.sub(r",\s*([}\]])", r"\1", m.group(0))      # 去掉尾逗号
    for cand in (raw, raw.replace("\n", " ")):
        try:
            obj = json.loads(cand)
        except ValueError:
            continue
        if isinstance(obj, dict):
            return obj
    return None


def _clean_cmd(value) -> str:
    """清洗模型给出的命令：去围栏/引号/`$` 前缀，只保留第一行。"""
    s = str(value or "").strip()
    s = re.sub(r"^```[a-zA-Z0-9_-]*\s*|\s*```$", "", s).strip()
    s = s.strip("`").replace("\u00a0", " ").strip()
    s = re.sub(r"^\$\s+", "", s)
    lines = [ln.strip() for ln in s.splitlines() if ln.strip()]
    if not lines:
        return ""
    return lines[0][:_MAX_CMD]


def _fallback_plan(text: str) -> dict:
    """模型没按 JSON 输出时的兜底：能从围栏里捞命令就捞，否则只当说明文字。"""
    raw = str(text or "")
    cmd = ""
    body = raw
    m = re.search(r"```[a-zA-Z0-9_-]*[ \t]*\n([\s\S]*?)```", raw)    # 取第一个围栏里的命令
    if m:
        cmd = _clean_cmd(m.group(1))
        body = (raw[:m.start()] + "\n" + raw[m.end():]).strip()
    else:
        body = _ai()._strip_fence(raw).strip()
        lines = [ln.strip() for ln in body.splitlines()]
        if lines and lines[0].lower() in ("bash", "sh", "shell", "console", "zsh"):
            lines = lines[1:]
        # 从前面几行里挑第一行「像命令」的：纯 ASCII、首词全小写、不以中文标点结尾
        for ln in lines[:4]:
            if not ln or re.search(r"[\u4e00-\u9fff]", ln):
                continue
            tok = ln.split()[0]
            if not re.match(r"^[a-z0-9_./~$][a-z0-9_.:/-]*$", tok):
                continue
            if ln.endswith((":", "：", ".", "。", ",")):
                continue
            cmd = _clean_cmd(ln)
            break
    return {
        "intent": "",
        "risk": "medium" if cmd else "low",
        "reason": "",
        "command": cmd,
        "explain": body[:600],
        "alternatives": [],
    }


def _plan_from_text(text: str) -> dict:
    obj = _json_block(text)
    if not isinstance(obj, dict):
        return _fallback_plan(text)

    def _s(key, limit=600):
        return str(obj.get(key) or "").strip()[:limit]

    risk = str(obj.get("risk") or "").strip().lower()
    if risk not in ("low", "medium", "high"):
        risk = "medium"
    alts = obj.get("alternatives")
    if not isinstance(alts, list):
        alts = []
    alts = [a for a in (_clean_cmd(x) for x in alts[:3]) if a]
    return {
        "intent": _s("intent", 80),
        "risk": risk,
        "reason": _s("reason", 200),
        "command": _clean_cmd(obj.get("command")),
        "explain": _s("explain", 800),
        "alternatives": alts,
    }


def _post_json(provider, model, messages, timeout):
    """非流式调用：返回 (正文, 错误)。"""
    base = provider["base_url"].rstrip("/")
    url = base if base.endswith("/chat/completions") else base + "/chat/completions"
    payload = json.dumps({"model": model, "messages": messages, "stream": False,
                          "temperature": 0.2}).encode("utf-8")
    req = urllib.request.Request(url, data=payload, method="POST", headers={
        "Content-Type": "application/json",
        "Authorization": "Bearer " + provider["api_key"],
    })
    try:
        resp = _ai()._open_stream(req, url, read_timeout=timeout)
    except urllib.error.HTTPError as e:
        try:
            detail = e.read().decode("utf-8", "replace")[:300]
        except OSError:
            detail = ""
        return "", "接口返回 %s：%s" % (e.code, detail or e.reason)
    except (socket.timeout, TimeoutError):
        return "", "连接 AI 接口超时（%d 秒），可稍后重试" % timeout
    except (urllib.error.URLError, OSError) as e:
        return "", "无法连接 AI 接口：%s" % e
    try:
        obj = json.loads(resp.read().decode("utf-8", "replace"))
    except (OSError, ValueError) as e:
        return "", "读取模型返回失败：%s" % e
    finally:
        try:
            resp.close()
        except OSError:
            pass
    choice = (obj.get("choices") or [{}])[0] or {}
    content = (choice.get("message") or {}).get("content")
    if isinstance(content, list):                       # 少数接口返回分段数组
        content = "".join(str(p.get("text") or "") for p in content if isinstance(p, dict))
    if not content:
        content = choice.get("text") or ""
    return str(content or ""), ""


# ---------------------------------------------------------------- 端点
@bp.route("/api/term/ai/status")
def api_term_ai_status():
    """终端 AI 是否可用（前端在开启 AI 模式前探一次，给出可读提示）。"""
    cfg = _ai()._load_cfg()
    provider, model, err = _ai()._sys_pick(cfg, "term")
    return jsonify({
        "ready": not err,
        "configured": bool(cfg.get("providers")),
        "provider": (provider or {}).get("name", ""),
        "model": model or "",
        "error": err,
    })


_HIST_KEEP = 2000                   # 历史表最多保留多少条（超出按 id 从旧到新删）


@bp.route("/api/term/ai/history", methods=["GET"])
def api_term_ai_history_list():
    """终端 AI 历史（按时间倒序）。`?host=` 只看该主机，省略则返回全部；`?limit=` 默认 50。"""
    host = str(request.args.get("host") or "").strip()[:120]
    try:
        limit = int(request.args.get("limit", 50))
    except (TypeError, ValueError):
        limit = 50
    limit = max(1, min(limit, 200))
    sql = ("SELECT id, ts, host, title, question, command, risk, ok, exit_code FROM term_ai_history ")
    args = ()
    if host:
        sql += "WHERE host=? ORDER BY id DESC LIMIT ?"
        args = (host, limit)
    else:
        sql += "ORDER BY id DESC LIMIT ?"
        args = (limit,)
    try:
        conn = store_conn()
        try:
            rows = conn.execute(sql, args).fetchall()
        finally:
            conn.close()
    except Exception as e:                                  # noqa: BLE001
        _log.warning("读取终端 AI 历史失败：%s", e)
        return jsonify({"error": "读取历史失败：%s" % e}), 500
    return jsonify({"items": [dict(r) for r in rows], "total": len(rows)})


@bp.route("/api/term/ai/history", methods=["POST"])
def api_term_ai_history_save():
    """保存一条历史（前端在执行完 / 执行失败后调用）。"""
    data = request.get_json(silent=True) or {}
    question = str(data.get("question") or "").strip()[:800]
    title = str(data.get("title") or "").strip()[:200]      # AI 生成的意图标题
    command = str(data.get("command") or "").strip()[:_MAX_CMD]
    if not question and not command:
        return jsonify({"error": "question / command 至少给一个"}), 400
    host = str(data.get("host") or "").strip()[:120]
    risk = str(data.get("risk") or "").strip()[:16]
    ok = 1 if data.get("ok") else 0
    try:
        exit_code = int(data.get("exit_code")) if data.get("exit_code") is not None else None
    except (TypeError, ValueError):
        exit_code = None
    ts = time.strftime("%Y-%m-%d %H:%M:%S")
    try:
        with store_tx() as conn:
            cur = conn.execute(
                "INSERT INTO term_ai_history (ts, host, title, question, command, risk, ok, exit_code) "
                "VALUES (?,?,?,?,?,?,?,?)",
                (ts, host, title, question, command, risk, ok, exit_code))
            hid = cur.lastrowid
            n = conn.execute("SELECT COUNT(*) AS n FROM term_ai_history").fetchone()["n"]
            if n > _HIST_KEEP:                              # 只留最近 N 条
                conn.execute("DELETE FROM term_ai_history WHERE id IN "
                             "(SELECT id FROM term_ai_history ORDER BY id ASC LIMIT ?)",
                             (n - _HIST_KEEP,))
    except Exception as e:                                  # noqa: BLE001
        _log.warning("保存终端 AI 历史失败：%s", e)
        return jsonify({"error": "保存失败：%s" % e}), 500
    return jsonify({"ok": True, "id": hid, "ts": ts})


@bp.route("/api/term/ai/history", methods=["DELETE"])
def api_term_ai_history_delete():
    """删历史：`?id=N` 删一条；`?host=` 清该主机；`?all=1` 全清。"""
    hid = request.args.get("id", type=int)
    host = str(request.args.get("host") or "").strip()[:120]
    all_flag = str(request.args.get("all") or "").lower() in ("1", "true", "yes")
    if not (hid or host or all_flag):
        return jsonify({"error": "缺少 id / host / all 参数"}), 400
    try:
        with store_tx() as conn:
            if hid:
                conn.execute("DELETE FROM term_ai_history WHERE id=?", (hid,))
            elif host:
                conn.execute("DELETE FROM term_ai_history WHERE host=?", (host,))
            else:
                conn.execute("DELETE FROM term_ai_history")
    except Exception as e:                                  # noqa: BLE001
        _log.warning("删除终端 AI 历史失败：%s", e)
        return jsonify({"error": "删除失败：%s" % e}), 500
    return jsonify({"ok": True})


@bp.route("/api/term/ai/plan", methods=["POST"])
def api_term_ai_plan():
    """自然语言 → {意图, 风险, 命令, 说明}（不执行）。"""
    data = request.get_json(silent=True) or {}
    text = str(data.get("input") or "").strip()
    if not text:
        return jsonify({"error": "请先描述你想做什么"}), 400
    if len(text) > _MAX_INPUT:
        return jsonify({"error": "描述过长（上限 %d 字）" % _MAX_INPUT}), 400

    cfg = _ai()._load_cfg()
    provider, model, err = _ai()._sys_pick(cfg, "term")
    if err:
        return _ai()._sys_err_response(err, need_config=not cfg.get("providers"))

    cwd = str(data.get("cwd") or "").strip()
    if cwd and not os.path.isdir(cwd):
        cwd = ""
    # 远程（SSH）终端会自带环境描述，此时以它为准，不要混入本机信息
    extra_env = str(data.get("env") or "").strip()[:300]
    hist = data.get("history")
    ctx = ""
    if isinstance(hist, list) and hist:
        rows = []
        for h in hist[-2:]:
            if not isinstance(h, dict):
                continue
            q = str(h.get("q") or "")[:120]
            c = str(h.get("cmd") or "")[:160]
            if q or c:
                rows.append("- 需求：%s（已执行：%s）" % (q or "-", c or "-"))
        if rows:
            ctx = "[最近几轮]\n" + "\n".join(rows) + "\n\n"

    if extra_env:
        env_desc = extra_env + (("；工作目录：" + cwd) if cwd else "")
    else:
        env_desc = _env_brief(cwd)

    # 联网搜索：涉及安装 / 下载 / 配置的请求先搜一下，把官方地址喂给模型，避免编造 URL
    web_on = bool(data.get("web_search", True))
    web_ctx = ""
    if web_on and re.search(r"安装|部署|下载|更新|升级|配置|搭建|install|setup|download|deploy|update|upgrade|https?://|git |clone|pip |npm |apt |yum |dnf |curl |wget ", text, re.I):
        try:
            results = search_web(text, max_results=4)
            bad = (not results) or (len(results) == 1 and results[0].get("error"))
            if not bad:
                web_ctx = "[联网搜索结果]\n" + format_results(results, max_chars=1800) + "\n\n"
                _log.info("终端 AI 联网：query=%s", text[:80])
        except Exception as e:  # noqa: BLE001 - 搜索失败不阻塞生成
            _log.warning("终端 AI 联网搜索失败：%s", e)

    messages = [
        {"role": "system", "content": _PLAN_SYS},
        {"role": "user", "content": "[当前环境] " + env_desc + "\n" + ctx + web_ctx + "[用户需求] " + text},
    ]
    t0 = time.time()
    content, call_err = _post_json(provider, model, messages, _PLAN_TIMEOUT)
    ms = int((time.time() - t0) * 1000)
    if call_err:
        _ai()._log_ai_call("term", False, ms, call_err, model, req=text, resp="")
        return jsonify({"error": call_err}), 502

    plan = _plan_from_text(content)
    plan["intent"] = plan["intent"] or text[:60]
    cmd = plan["command"]

    # 服务端兜底：把「命令安全策略」的判断一并告诉前端，界面直接显示拦截 / 需确认
    note, blocked, need_confirm = "", False, False
    verdict = check_command(cmd) if cmd else {"level": "ok", "reason": "", "part": ""}
    if verdict["level"] == "blocked":
        blocked = True
        plan["risk"] = "high"
        note = "该命令会被命令安全策略拦截：%s" % (verdict.get("reason") or "命中危险命令规则")
    elif verdict["level"] == "confirm":
        need_confirm = True
        note = "该命令属于高风险操作，执行前需要二次确认：%s" % (verdict.get("reason") or "")
    if plan["risk"] == "high" and not note:
        need_confirm = True
        note = "AI 判断为高风险操作，执行前请再确认一次。"

    _ai()._log_ai_call("term", True, ms, "", model,
                       _ai()._estimate_msgs(messages), _ai()._estimate_tokens(content), True,
                       req=text, resp=content)
    _log.info("终端 AI：cwd=%s risk=%s cmd=%s", cwd or "-", plan["risk"], (cmd or "-")[:120])
    return jsonify({
        "ok": True,
        "intent": plan["intent"],
        "risk": plan["risk"],
        "reason": plan["reason"],
        "command": cmd,
        "explain": plan["explain"],
        "alternatives": plan["alternatives"],
        "blocked": blocked,
        "need_confirm": need_confirm,
        "note": note,
        "model": model,
    })


@bp.route("/api/term/ai/analyze", methods=["POST"])
def api_term_ai_analyze():
    """命令执行结果 → SSE 流式解读（delta 逐字推送）。"""
    data = request.get_json(silent=True) or {}
    question = str(data.get("question") or "").strip()[:_MAX_INPUT]
    command = str(data.get("command") or "").strip()[:_MAX_CMD]
    stdout = str(data.get("stdout") or "")
    stderr = str(data.get("stderr") or "")
    cwd = str(data.get("cwd") or "").strip()
    context = str(data.get("context") or "")[:_MAX_CONTEXT]
    exit_code = data.get("exit_code")

    cfg = _ai()._load_cfg()
    provider, model, err = _ai()._sys_pick(cfg, "term")
    if err:
        return _ai()._sys_err_response(err, need_config=not cfg.get("providers"))

    parts = ["[用户需求] " + (question or "（未提供，按命令理解）"),
             "[执行的命令] " + (command or "-"),
             "[退出码] " + ("超时/未知" if exit_code is None else str(exit_code))]
    if cwd:
        parts.append("[当前目录] " + cwd)
    if context:
        parts.append("[上一轮]\n" + context)
    if stdout.strip():
        parts.append("[标准输出]\n" + _trim_mid(stdout, _MAX_STDOUT))
    if stderr.strip():
        parts.append("[标准错误]\n" + _trim_mid(stderr, _MAX_STDOUT // 2))
    if not stdout.strip() and not stderr.strip():
        parts.append("（命令没有任何输出）")
    user_content = "\n\n".join(parts)

    messages = [{"role": "system", "content": _LIVE_SYS},
                {"role": "user", "content": user_content}]
    base = provider["base_url"].rstrip("/")
    url = base if base.endswith("/chat/completions") else base + "/chat/completions"

    def _sse(obj):
        return _ai()._sse(obj)

    def gen():
        text_parts = []
        t0 = time.time()
        err_msg = ""
        attempt = 0
        while True:
            body = json.dumps({"model": model, "messages": messages, "stream": True,
                               "temperature": 0.3}).encode("utf-8")
            req = urllib.request.Request(url, data=body, method="POST", headers={
                "Content-Type": "application/json",
                "Authorization": "Bearer " + provider["api_key"],
                "Accept": "text/event-stream",
            })
            try:
                resp = _ai()._open_stream(req, url, read_timeout=_LIVE_TIMEOUT)
            except urllib.error.HTTPError as e:
                try:
                    detail = e.read().decode("utf-8", "replace")[:300]
                except OSError:
                    detail = ""
                if e.code in _RETRY_STATUS and attempt < 1:
                    attempt += 1
                    yield _sse({"type": "retry", "reason": "接口限流/暂不可用（HTTP %d），正在重试" % e.code})
                    time.sleep(2)
                    continue
                err_msg = "接口返回 %s：%s" % (e.code, detail or e.reason)
                yield _sse({"error": err_msg})
                break
            except (socket.timeout, TimeoutError):
                err_msg = "连接 AI 接口超时，可稍后重试"
                yield _sse({"error": err_msg})
                break
            except (urllib.error.URLError, OSError) as e:
                err_msg = "无法连接 AI 接口：%s" % e
                yield _sse({"error": err_msg})
                break

            try:
                for raw in resp:
                    line = raw.strip()
                    if not line.startswith(b"data:"):
                        continue
                    chunk = line[5:].strip()
                    if chunk == b"[DONE]":
                        break
                    try:
                        obj = json.loads(chunk.decode("utf-8", "replace"))
                    except ValueError:
                        continue
                    if isinstance(obj.get("error"), (str, dict)):
                        err_msg = str(obj["error"])
                        yield _sse({"error": err_msg})
                        continue
                    choices = obj.get("choices") or []
                    if not choices:
                        continue
                    delta = (choices[0] or {}).get("delta") or {}
                    piece = delta.get("content") or ""
                    if piece:
                        text_parts.append(piece)
                        yield _sse({"delta": piece})
            except (socket.timeout, TimeoutError) as e:
                err_msg = err_msg or ("读取超时：%s" % e)
            except (OSError, urllib.error.URLError) as e:
                err_msg = err_msg or ("连接中断：%s" % e)
            finally:
                try:
                    resp.close()
                except OSError:
                    pass
            break

        out = "".join(text_parts)
        _ai()._log_ai_call("term", not err_msg, int((time.time() - t0) * 1000), err_msg, model,
                           _ai()._estimate_msgs(messages), _ai()._estimate_tokens(out), True,
                           req=question or command, resp=out)
        yield b"data: [DONE]\n\n"

    return Response(gen(), mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ---------------------------------------------------------------- 整段会话复盘
def _stream_reply(provider, model, messages, req_label, module="term",
                  read_timeout=_LIVE_TIMEOUT):
    """通用 SSE 流式回复：逐字推送 delta，结束（成功或失败）后记录一次调用统计。

    与 /analyze 里那条手写流一致的行为：限流 / 5xx 自动重试一次、
    出错时推 {"error"} 而不是直接断流，最后统一补 data: [DONE]。
    """
    base = provider["base_url"].rstrip("/")
    url = base if base.endswith("/chat/completions") else base + "/chat/completions"

    def gen():
        text_parts = []
        t0 = time.time()
        err_msg = ""
        attempt = 0
        while True:
            body = json.dumps({"model": model, "messages": messages, "stream": True,
                               "temperature": 0.3}).encode("utf-8")
            req = urllib.request.Request(url, data=body, method="POST", headers={
                "Content-Type": "application/json",
                "Authorization": "Bearer " + provider["api_key"],
                "Accept": "text/event-stream",
            })
            try:
                resp = _ai()._open_stream(req, url, read_timeout=read_timeout)
            except urllib.error.HTTPError as e:
                try:
                    detail = e.read().decode("utf-8", "replace")[:300]
                except OSError:
                    detail = ""
                if e.code in _RETRY_STATUS and attempt < 1:
                    attempt += 1
                    yield _ai()._sse({"type": "retry",
                                      "reason": "接口限流/暂不可用（HTTP %d），正在重试" % e.code})
                    time.sleep(2)
                    continue
                err_msg = "接口返回 %s：%s" % (e.code, detail or e.reason)
                yield _ai()._sse({"error": err_msg})
                break
            except (socket.timeout, TimeoutError):
                err_msg = "连接 AI 接口超时，可稍后重试"
                yield _ai()._sse({"error": err_msg})
                break
            except (urllib.error.URLError, OSError) as e:
                err_msg = "无法连接 AI 接口：%s" % e
                yield _ai()._sse({"error": err_msg})
                break

            try:
                for raw in resp:
                    line = raw.strip()
                    if not line.startswith(b"data:"):
                        continue
                    chunk = line[5:].strip()
                    if chunk == b"[DONE]":
                        break
                    try:
                        obj = json.loads(chunk.decode("utf-8", "replace"))
                    except ValueError:
                        continue
                    if isinstance(obj.get("error"), (str, dict)):
                        err_msg = str(obj["error"])
                        yield _ai()._sse({"error": err_msg})
                        continue
                    choices = obj.get("choices") or []
                    if not choices:
                        continue
                    piece = ((choices[0] or {}).get("delta") or {}).get("content") or ""
                    if piece:
                        text_parts.append(piece)
                        yield _ai()._sse({"delta": piece})
            except (socket.timeout, TimeoutError) as e:
                err_msg = err_msg or ("读取超时：%s" % e)
            except (OSError, urllib.error.URLError) as e:
                err_msg = err_msg or ("连接中断：%s" % e)
            finally:
                try:
                    resp.close()
                except OSError:
                    pass
            break

        out = "".join(text_parts)
        _ai()._log_ai_call(module, not err_msg, int((time.time() - t0) * 1000), err_msg, model,
                           _ai()._estimate_msgs(messages), _ai()._estimate_tokens(out), True,
                           req=req_label, resp=out)
        yield b"data: [DONE]\n\n"

    return Response(gen(), mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@bp.route("/api/term/ai/session", methods=["POST"])
def api_term_ai_session():
    """当前终端会话的所有命令与系统回显 → SSE 流式复盘。

    与 /analyze 的区别：那里是「一条命令的输出」，这里是「整场会话」，
    因此先做压缩（保留命令与报错）再交给模型，并明确告知可能被截断。
    """
    data = request.get_json(silent=True) or {}
    transcript = str(data.get("transcript") or "")
    if not transcript.strip():
        return jsonify({"error": "当前会话还没有输出，先执行几条命令再分析"}), 400

    cfg = _ai()._load_cfg()
    provider, model, err = _ai()._sys_pick(cfg, "term")
    if err:
        return _ai()._sys_err_response(err, need_config=not cfg.get("providers"))

    host = str(data.get("host") or "").strip()[:120]
    env_desc = str(data.get("env") or "").strip()[:300]
    question = str(data.get("question") or "").strip()[:_MAX_INPUT]

    raw_lines = transcript.count("\n") + 1
    condensed = _condense_session(transcript)
    parts = [
        "[会话来源] " + (env_desc or host or "本机终端"),
        "[会话规模] 原始 %d 行 / %d 字符；下面是压缩后的记录（命令与报错优先保留）"
        % (raw_lines, len(transcript)),
    ]
    if question:
        parts.append("[用户关注点] " + question)
    parts.append("[会话记录]\n" + condensed)

    messages = [{"role": "system", "content": _SESSION_SYS},
                {"role": "user", "content": "\n\n".join(parts)}]
    _log.info("终端 AI 会话复盘：host=%s 行=%d 压缩后=%d 字符",
              host or "-", raw_lines, len(condensed))
    return _stream_reply(provider, model, messages,
                         req_label="[会话复盘] " + (host or "本机") + ("；" + question if question else ""),
                         read_timeout=_SESSION_TIMEOUT)

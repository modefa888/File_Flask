"""AI 智能体（Agent）：让模型自动读文件、改文件、搜索、执行命令，多轮直到任务完成。

POST /api/ai/agent           {repo, messages, perm, provider_id?, model?}   SSE 流式
POST /api/ai/agent/approve   {run_id, call_id, allow, always}               批准/拒绝待确认的调用

SSE 事件（data: {json}\\n\\n）：
    {"type":"run","run_id":"..."}                       本次运行 id（确认时回传）
    {"type":"delta","text":"..."}                       模型输出（流式）
    {"type":"step","call_id","tool","args"}             开始调用工具
    {"type":"ask","call_id","tool","args","reason"}     需要用户确认（如执行命令）
    {"type":"result","call_id","tool","ok","summary","detail","ms"}   工具结果
    {"type":"error","error":"..."}
    {"type":"done"}

权限（perm，与前端「AI 操作权限」一致）：
    readonly  只能读文件/搜索；写入与执行一律拒绝
    workspace 读任意；写只能落在项目内；执行命令需逐条确认
    full      读任意；写任意路径；执行命令不再确认（危险命令仍会被安全规则拦截）
"""
import json
import os
import re
import signal
import subprocess
import threading
import time
import urllib.error
import urllib.request
import uuid

from flask import Blueprint, jsonify, request, Response

from .. import config
from ..log import get_logger
from ..services.safety import check_command
from .ai import _clean_content, _load_cfg, _sse

_log = get_logger()
bp = Blueprint("agent", __name__)

_MAX_ROUNDS = 12                     # 最多工具轮数（防止死循环）
_CONNECT_TIMEOUT = 60                # 模型接口超时
_TOOL_CHARS = 20000                  # 单个工具结果回填给模型的字符上限
_ASK_TIMEOUT = 600                   # 等待用户确认的最长时间（秒）
_READ_CHARS = 40000                  # read_file 最多返回多少字符
_SEARCH_FILES = 4000                 # 搜索最多扫描多少文件
_SEARCH_HITS = 60                    # 搜索最多返回多少条命中
_LIST_MAX = 200                      # 目录最多列出多少项

_SKIP_DIRS = {".git", "node_modules", "__pycache__", ".venv", "venv", "env", "dist", "build",
              "out", ".idea", ".vscode", ".next", ".nuxt", ".cache", "target", "vendor",
              ".pytest_cache", ".mypy_cache", ".ruff_cache", "coverage", "htmlcov", "logs"}

_TOOLS = [
    {"type": "function", "function": {
        "name": "list_dir",
        "description": "列出目录下的文件与子目录（用于了解项目结构）",
        "parameters": {"type": "object", "properties": {
            "path": {"type": "string", "description": "目录路径：相对项目根的相对路径，或绝对路径；默认为项目根"}},
            "required": []}}},
    {"type": "function", "function": {
        "name": "read_file",
        "description": "读取文本文件内容，可选起止行号",
        "parameters": {"type": "object", "properties": {
            "path": {"type": "string", "description": "文件路径（相对项目根或绝对路径）"},
            "start": {"type": "integer", "description": "起始行号（从 1 开始，可选）"},
            "end": {"type": "integer", "description": "结束行号（含，可选）"}},
            "required": ["path"]}}},
    {"type": "function", "function": {
        "name": "write_file",
        "description": "创建或整体覆盖一个文本文件（整篇重写时使用）",
        "parameters": {"type": "object", "properties": {
            "path": {"type": "string", "description": "文件路径"},
            "content": {"type": "string", "description": "完整的文件内容"}},
            "required": ["path", "content"]}}},
    {"type": "function", "function": {
        "name": "edit_file",
        "description": "把文件中的一段文本精确替换为新文本（推荐用于局部修改，只需给出改动片段）",
        "parameters": {"type": "object", "properties": {
            "path": {"type": "string", "description": "文件路径"},
            "old_text": {"type": "string", "description": "要被替换的原文（必须与文件中完全一致，含缩进）"},
            "new_text": {"type": "string", "description": "替换后的新文本"}},
            "required": ["path", "old_text", "new_text"]}}},
    {"type": "function", "function": {
        "name": "search_files",
        "description": "在项目内按正则搜索文件内容，返回 文件:行号:内容",
        "parameters": {"type": "object", "properties": {
            "pattern": {"type": "string", "description": "正则表达式"},
            "path": {"type": "string", "description": "搜索目录（默认项目根）"},
            "max": {"type": "integer", "description": "最多返回多少条命中（默认 40）"}},
            "required": ["pattern"]}}},
    {"type": "function", "function": {
        "name": "run_command",
        "description": "在项目根目录执行一条 shell 命令并返回输出（如 git status、npm test、python -m py_compile …）",
        "parameters": {"type": "object", "properties": {
            "command": {"type": "string", "description": "要执行的命令"},
            "timeout": {"type": "integer", "description": "超时秒数（默认 60，最大 300）"}},
            "required": ["command"]}}},
]

_READ_TOOLS = {"list_dir", "read_file", "search_files"}
_WRITE_TOOLS = {"write_file", "edit_file"}

# 待用户确认的调用：{(run_id, call_id): {"ev": Event, "box": {...}}}
_PENDING = {}
_PENDING_LOCK = threading.Lock()


# ---------------------------------------------------------------- 基础工具
def _resolve(path, root):
    """路径解析：绝对路径原样，相对路径按项目根拼接。"""
    p = str(path or "").strip()
    if not p:
        return ""
    p = os.path.expanduser(p)
    if not os.path.isabs(p):
        p = os.path.join(root or os.getcwd(), p)
    return os.path.abspath(os.path.normpath(p))


def _inside(path, root):
    if not root:
        return True
    try:
        return os.path.commonpath([os.path.abspath(path), os.path.abspath(root)]) == os.path.abspath(root)
    except ValueError:
        return False


def _rel(path, root):
    if root and _inside(path, root):
        return os.path.relpath(path, root)
    return path


def _read_text(path, limit=_READ_CHARS):
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        return f.read(limit)


def _tool_list_dir(args, root, perm):
    path = _resolve(args.get("path") or ".", root)
    if not os.path.isdir(path):
        return False, "目录不存在：" + path, "", "目录不存在：" + path
    try:
        names = sorted(os.listdir(path))
    except OSError as e:
        return False, "无法读取目录：%s" % e, "", "无法读取目录：%s" % e
    lines = []
    for n in names[:_LIST_MAX]:
        full = os.path.join(path, n)
        if os.path.isdir(full):
            lines.append(n + "/")
        else:
            try:
                lines.append("%s  (%d B)" % (n, os.path.getsize(full)))
            except OSError:
                lines.append(n)
    body = "\n".join(lines) or "（空目录）"
    return (True, "%d 项" % len(lines), body[:4000],
            "目录 %s（%d 项）：\n%s" % (_rel(path, root), len(lines), body[:_TOOL_CHARS]))


def _tool_read_file(args, root, perm):
    path = _resolve(args.get("path"), root)
    if not path:
        return False, "缺少 path", "", "缺少 path"
    if not os.path.isfile(path):
        return False, "文件不存在：" + path, "", "文件不存在：" + path
    try:
        text = _read_text(path)
    except OSError as e:
        return False, "读取失败：%s" % e, "", "读取失败：%s" % e
    total = text.count("\n") + 1
    lines = text.split("\n")
    try:
        start = int(args.get("start") or 1)
        end = int(args.get("end") or len(lines))
    except (TypeError, ValueError):
        start, end = 1, len(lines)
    start = max(1, start)
    end = min(max(start, end), len(lines))
    part = lines[start - 1:end]
    numbered = "\n".join("%5d| %s" % (start + i, ln) for i, ln in enumerate(part))
    body = numbered[:_TOOL_CHARS]
    return (True, "%s · 第 %d-%d 行（共 %d 行）" % (_rel(path, root), start, end, total),
            body[:4000], "文件 %s（第 %d-%d 行，共 %d 行）：\n%s" % (_rel(path, root), start, end, total, body))


def _tool_write_file(args, root, perm):
    path = _resolve(args.get("path"), root)
    if not path:
        return False, "缺少 path", "", "缺少 path"
    content = str(args.get("content") or "")
    existed = os.path.isfile(path)
    try:
        d = os.path.dirname(path)
        if d:
            os.makedirs(d, exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(content)
    except OSError as e:
        return False, "写入失败：%s" % e, "", "写入失败：%s" % e
    n = content.count("\n") + 1
    msg = "%s %s（%d 行 / %d 字符）" % ("已覆盖" if existed else "已创建", _rel(path, root), n, len(content))
    return True, msg, path, "写入成功：" + msg


def _tool_edit_file(args, root, perm):
    path = _resolve(args.get("path"), root)
    old = str(args.get("old_text") or "")
    new = str(args.get("new_text") or "")
    if not path:
        return False, "缺少 path", "", "缺少 path"
    if not old:
        return False, "old_text 不能为空（需要与原文完全一致）", "", "old_text 不能为空"
    if not os.path.isfile(path):
        return False, "文件不存在：" + path, "", "文件不存在：" + path
    try:
        text = _read_text(path, limit=4 * 1024 * 1024)
    except OSError as e:
        return False, "读取失败：%s" % e, "", "读取失败：%s" % e
    count = text.count(old)
    if count == 0:
        return False, "未在文件中找到待替换内容（必须与原文完全一致，含缩进）", "", "未找到待替换内容"
    new_text = text.replace(old, new, 1)
    try:
        with open(path, "w", encoding="utf-8") as f:
            f.write(new_text)
    except OSError as e:
        return False, "写入失败：%s" % e, "", "写入失败：%s" % e
    extra = "" if count == 1 else "（原文件有 %d 处相同内容，只替换了第 1 处）" % count
    msg = "已修改 %s（替换 1 处，共 %d 行）%s" % (_rel(path, root), new_text.count("\n") + 1, extra)
    return True, msg, path, msg


def _tool_search_files(args, root, perm):
    pattern = str(args.get("pattern") or "")
    if not pattern:
        return False, "缺少 pattern", "", "缺少 pattern"
    try:
        rx = re.compile(pattern)
    except re.error as e:
        return False, "正则不合法：%s" % e, "", "正则不合法：%s" % e
    base = _resolve(args.get("path") or ".", root)
    if not os.path.isdir(base):
        return False, "目录不存在：" + base, "", "目录不存在：" + base
    try:
        limit = max(1, min(_SEARCH_HITS, int(args.get("max") or 40)))
    except (TypeError, ValueError):
        limit = 40
    hits, scanned = [], 0
    for dirpath, dirnames, filenames in os.walk(base):
        dirnames[:] = [d for d in dirnames if d not in _SKIP_DIRS and not d.startswith(".git")]
        for fn in filenames:
            scanned += 1
            if scanned > _SEARCH_FILES or len(hits) >= limit:
                break
            full = os.path.join(dirpath, fn)
            try:
                if os.path.getsize(full) > 2 * 1024 * 1024:
                    continue
                with open(full, "r", encoding="utf-8", errors="ignore") as f:
                    for i, line in enumerate(f, 1):
                        if rx.search(line):
                            hits.append("%s:%d: %s" % (_rel(full, root), i, line.rstrip()[:200]))
                            break
            except (OSError, UnicodeError):
                continue
        if len(hits) >= limit:
            break
    if not hits:
        return True, "没有匹配", "", "在 %s 下搜索 /%s/：没有匹配" % (_rel(base, root), pattern)
    body = "\n".join(hits)
    return True, "命中 %d 个文件" % len(hits), body[:4000], "在 %s 下搜索 /%s/（命中 %d）：\n%s" % (
        _rel(base, root), pattern, len(hits), body[:_TOOL_CHARS])


def _kill_tree(proc):
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
        proc.wait(timeout=3)
    except Exception:  # noqa: BLE001
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except Exception:  # noqa: BLE001
            pass


def _tool_run_command(args, root, perm):
    cmd = str(args.get("command") or "").strip()
    if not cmd:
        return False, "缺少 command", "", "缺少 command"
    if not getattr(config, "ENABLE_EXEC", True):
        return False, "已禁用命令执行（config.ENABLE_EXEC = False）", "", "已禁用命令执行"
    try:
        timeout = max(1, min(300, int(args.get("timeout") or 60)))
    except (TypeError, ValueError):
        timeout = 60
    try:
        proc = subprocess.Popen(["bash", "-lc", cmd], cwd=root or None,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                stdin=subprocess.DEVNULL, text=True, errors="replace",
                                env=dict(os.environ, PAGER="cat", GIT_PAGER="cat", GIT_TERMINAL_PROMPT="0"),
                                preexec_fn=os.setsid)
    except OSError as e:
        return False, "启动命令失败：%s" % e, "", "启动命令失败：%s" % e
    try:
        out = proc.communicate(timeout=timeout)[0] or ""
        code = proc.returncode
    except subprocess.TimeoutExpired:
        _kill_tree(proc)
        out = ""
        try:
            out = proc.communicate(timeout=2)[0] or ""
        except Exception:  # noqa: BLE001
            pass
        return False, "命令超时（%d 秒）已被终止" % timeout, out[-3000:], "$ %s\n（超时 %d 秒后被终止）\n%s" % (
            cmd, timeout, out[:_TOOL_CHARS])
    body = out[:_TOOL_CHARS]
    summary = "退出码 %d · %d 行输出" % (code, body.count("\n"))
    return code == 0, summary, body[-3000:], "$ %s\n%s" % (cmd, body)


_TOOL_FUNCS = {
    "list_dir": _tool_list_dir,
    "read_file": _tool_read_file,
    "write_file": _tool_write_file,
    "edit_file": _tool_edit_file,
    "search_files": _tool_search_files,
    "run_command": _tool_run_command,
}


def _gate(perm, name, args, root):
    """权限校验 → (allowed, refuse_reason, need_ask, ask_reason)。"""
    if perm == "readonly":
        if name in _WRITE_TOOLS or name == "run_command":
            return False, "当前权限为「仅可查看」：不能写入文件或执行命令（可在输入框左下角切换权限）", False, ""
        return True, "", False, ""
    if name in _WRITE_TOOLS:
        path = _resolve(args.get("path"), root)
        if perm != "full" and root and path and not _inside(path, root):
            return False, "超出工作区范围，已被权限拦截：%s" % path, False, ""
        return True, "", False, ""
    if name == "run_command":
        if not getattr(config, "ENABLE_EXEC", True):
            return False, "已禁用命令执行（config.ENABLE_EXEC = False）", False, ""
        verdict = check_command(str(args.get("command") or ""))
        if verdict["level"] == "blocked":
            return False, "已拦截危险命令：%s" % verdict["reason"], False, ""
        if perm == "full":
            return True, "", False, ""
        reason = "该命令有一定风险：%s" % verdict["reason"] if verdict["level"] == "confirm" else "执行命令前需要你确认"
        return True, "", True, reason
    return True, "", False, ""


# ---------------------------------------------------------------- Agent 主流程
def _agent_system(root, perm):
    perm_desc = {
        "readonly": "仅可查看 —— 只能读文件与搜索，写入和执行会被拒绝（可提示用户切换权限）",
        "workspace": "工作区内修改 —— 可以读写项目内的文件；执行命令前会先征求用户确认",
        "full": "完全权限 —— 可以读写任意路径；执行命令不再确认（危险命令仍会被安全规则拦截）",
    }.get(perm, "工作区内修改")
    return (
        "你是一个自托管文件管理器内置的编程智能体，可以通过工具自动读取文件、修改文件、搜索代码、执行命令来完成任务。\n"
        "当前项目根目录：%s\n"
        "当前权限：%s\n"
        "工作方式：\n"
        "1. 先读文件或搜索确认现状，再动手修改，不要凭空猜测文件内容；\n"
        "2. 局部修改优先用 edit_file（old_text 必须与原文完全一致，含缩进），整篇重写才用 write_file；\n"
        "3. 路径优先使用相对项目根的相对路径；\n"
        "4. 每次工具调用后根据真实结果决定下一步，不要编造工具结果；\n"
        "5. 任务完成后用简体中文简洁说明做了什么、涉及哪些文件、有无遗留问题；\n"
        "6. 需要用户提供信息（如密钥、路径偏好）时直接提问，不要臆造。"
        % (root or "/", perm_desc)
    )


def _stream_model(provider, model, convo):
    """调用模型（流式，带工具定义）：yield SSE 事件，返回 (文本, 工具调用列表)。"""
    base = provider["base_url"].rstrip("/")
    url = base if base.endswith("/chat/completions") else base + "/chat/completions"
    payload = json.dumps({"model": model, "stream": True, "messages": convo,
                          "tools": _TOOLS, "tool_choice": "auto"}).encode("utf-8")
    req = urllib.request.Request(url, data=payload, method="POST", headers={
        "Content-Type": "application/json",
        "Authorization": "Bearer " + provider["api_key"],
        "Accept": "text/event-stream",
    })
    text, calls = "", {}
    try:
        resp = urllib.request.urlopen(req, timeout=_CONNECT_TIMEOUT)
    except urllib.error.HTTPError as e:
        try:
            detail = e.read().decode("utf-8", "replace")[:400]
        except OSError:
            detail = ""
        yield _sse({"type": "error", "error": "接口返回 %s：%s" % (e.code, detail or e.reason)})
        return text, []
    except (urllib.error.URLError, OSError) as e:
        yield _sse({"type": "error", "error": "无法连接 AI 接口：%s" % e})
        return text, []
    try:
        for raw in resp:
            line = raw.strip()
            if not line.startswith(b"data:"):
                continue
            body = line[5:].strip()
            if body == b"[DONE]":
                break
            try:
                obj = json.loads(body.decode("utf-8"))
            except ValueError:
                continue
            if obj.get("error"):
                yield _sse({"type": "error", "error": str(obj["error"])})
                continue
            choices = obj.get("choices") or []
            if not choices:
                continue
            delta = (choices[0] or {}).get("delta") or {}
            piece = delta.get("content")
            if piece:
                text += piece
                yield _sse({"type": "delta", "text": piece})
            for tc in (delta.get("tool_calls") or []):
                slot = calls.setdefault(tc.get("index", 0), {"id": "", "name": "", "args_raw": ""})
                if tc.get("id"):
                    slot["id"] = tc["id"]
                fn = tc.get("function") or {}
                if fn.get("name"):
                    slot["name"] += fn["name"]
                if fn.get("arguments"):
                    slot["args_raw"] += fn["arguments"]
    except (OSError, urllib.error.URLError) as e:
        yield _sse({"type": "error", "error": "读取流中断：%s" % e})
    finally:
        try:
            resp.close()
        except OSError:
            pass
    out = []
    for idx in sorted(calls):
        c = calls[idx]
        if not c["name"]:
            continue
        try:
            args = json.loads(c["args_raw"] or "{}")
        except ValueError:
            args = {}
        if not isinstance(args, dict):
            args = {}
        out.append({"id": c["id"] or ("call_%s" % idx), "name": c["name"], "args": args,
                    "args_raw": c["args_raw"] or "{}"})
    return text, out


def _run_agent(run_id, provider, model, root, perm, msgs):
    convo = [{"role": "system", "content": _agent_system(root, perm)}] + msgs
    always_allow = set()
    for _round in range(_MAX_ROUNDS):
        result = yield from _stream_model(provider, model, convo)
        text, tool_calls = result
        if not tool_calls:
            return
        convo.append({"role": "assistant", "content": text or None,
                      "tool_calls": [{"id": c["id"], "type": "function",
                                      "function": {"name": c["name"], "arguments": c["args_raw"]}}
                                     for c in tool_calls]})
        for c in tool_calls:
            name, args = c["name"], c["args"]
            yield _sse({"type": "step", "call_id": c["id"], "tool": name, "args": args})
            t0 = time.time()
            allowed, refuse, need_ask, ask_reason = _gate(perm, name, args, root)
            if allowed and need_ask and name not in always_allow:
                key = (run_id, c["id"])
                ev = threading.Event()
                box = {"allow": False, "always": False}
                with _PENDING_LOCK:
                    _PENDING[key] = {"ev": ev, "box": box}
                yield _sse({"type": "ask", "call_id": c["id"], "tool": name, "args": args, "reason": ask_reason})
                done = ev.wait(timeout=_ASK_TIMEOUT)
                with _PENDING_LOCK:
                    _PENDING.pop(key, None)
                if done and box["allow"]:
                    if box["always"]:
                        always_allow.add(name)
                else:
                    allowed = False
                    refuse = "用户拒绝了该命令" if done else "等待用户确认超时（%d 秒）" % _ASK_TIMEOUT
            if not allowed:
                ms = int((time.time() - t0) * 1000)
                yield _sse({"type": "result", "call_id": c["id"], "tool": name, "ok": False,
                            "summary": refuse, "detail": "", "ms": ms, "denied": True})
                convo.append({"role": "tool", "tool_call_id": c["id"],
                              "content": "调用被拒绝：%s" % refuse})
                continue
            fn = _TOOL_FUNCS.get(name)
            if fn is None:
                ok, summary, detail, model_text = False, "未知工具：%s" % name, "", "未知工具：%s" % name
            else:
                try:
                    ok, summary, detail, model_text = fn(args, root, perm)
                except Exception as e:  # noqa: BLE001
                    ok, summary, detail, model_text = False, "工具执行异常：%s" % e, "", "工具执行异常：%s" % e
            ms = int((time.time() - t0) * 1000)
            _log.info("Agent 工具：%s %s → %s（%dms）", name, json.dumps(args, ensure_ascii=False)[:200],
                      "ok" if ok else "fail", ms)
            yield _sse({"type": "result", "call_id": c["id"], "tool": name, "ok": ok,
                        "summary": summary, "detail": detail, "ms": ms})
            convo.append({"role": "tool", "tool_call_id": c["id"],
                          "content": (model_text or summary or "")[:_TOOL_CHARS]})
    yield _sse({"type": "error", "error": "已达到最大工具调用轮数（%d），已停止" % _MAX_ROUNDS})


@bp.route("/api/ai/agent", methods=["POST"])
def api_ai_agent():
    cfg = _load_cfg()
    if not cfg["providers"]:
        return jsonify({"error": "尚未配置 AI 接口：请到「设置 → AI 助手」添加接口", "need_config": True}), 400
    data = request.get_json(silent=True) or {}
    want_pid = str(data.get("provider_id") or "")
    want_model = str(data.get("model") or "")
    provider = next((p for p in cfg["providers"] if p["id"] == want_pid), None)
    if provider is None:
        provider = next((p for p in cfg["providers"] if p["id"] == cfg["active"].get("provider")),
                        cfg["providers"][0])
    model = want_model or cfg["active"].get("model") or (provider["models"][0] if provider["models"] else "")
    if not model:
        return jsonify({"error": "尚未选择模型，请到「设置 → AI 助手」配置模型列表"}), 400

    msgs = data.get("messages") or []
    if not isinstance(msgs, list) or not msgs:
        return jsonify({"error": "messages 不能为空"}), 400
    clean = [{"role": str(m.get("role") or "user")[:16], "content": _clean_content(m.get("content"))}
             for m in msgs[:40]]
    repo = str(data.get("repo") or "")
    root = os.path.abspath(repo) if repo and os.path.isdir(repo) else ""
    perm = str(data.get("perm") or "workspace")
    if perm not in ("readonly", "workspace", "full"):
        perm = "workspace"
    run_id = uuid.uuid4().hex[:12]
    _log.info("Agent 启动：run=%s model=%s perm=%s root=%s msgs=%d", run_id, model, perm, root, len(clean))

    def gen():
        yield _sse({"type": "run", "run_id": run_id, "perm": perm, "model": model, "root": root})
        try:
            yield from _run_agent(run_id, provider, model, root, perm, clean)
        except Exception as e:  # noqa: BLE001
            _log.warning("Agent 异常：%s", e)
            yield _sse({"type": "error", "error": "智能体执行失败：%s" % e})
        finally:
            with _PENDING_LOCK:
                for k in [k for k in _PENDING if k[0] == run_id]:
                    _PENDING.pop(k, None)
            yield _sse({"type": "done"})

    return Response(gen(), mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@bp.route("/api/ai/agent/approve", methods=["POST"])
def api_ai_agent_approve():
    """批准 / 拒绝智能体待确认的工具调用。"""
    data = request.get_json(silent=True) or {}
    key = (str(data.get("run_id") or ""), str(data.get("call_id") or ""))
    with _PENDING_LOCK:
        st = _PENDING.get(key)
    if not st:
        return jsonify({"error": "该确认已失效（可能已超时或已处理）"}), 404
    st["box"]["allow"] = bool(data.get("allow"))
    st["box"]["always"] = bool(data.get("always"))
    st["ev"].set()
    return jsonify({"ok": True, "allow": st["box"]["allow"]})

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
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.request
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed

from flask import Blueprint, jsonify, request, Response

from .. import config
from ..log import get_logger
from ..services.safety import check_command
from .ai import _clean_content, _load_cfg, _open_stream, _sse

_log = get_logger()
bp = Blueprint("agent", __name__)

_MAX_ROUNDS = 12                     # 最多工具轮数（防止死循环）
_CONNECT_TIMEOUT = 15                # 建立连接超时（快速报错）
_READ_TIMEOUT = 300                  # 连上后等模型吐字的超时（慢模型首字可能要几十秒）
_TOOL_CHARS = 20000                  # 单个工具结果回填给模型的字符上限
_ASK_TIMEOUT = 600                   # 等待用户确认的最长时间（秒）
_READ_CHARS = 40000                  # read_file 最多返回多少字符
_SEARCH_FILES = 4000                 # 搜索最多扫描多少文件
_SEARCH_HITS = 60                    # 搜索最多返回多少条命中
_LIST_MAX = 200                      # 目录最多列出多少项
_MAX_PARALLEL = 8                    # 同一轮内并行执行的只读工具上限
_RECENT_ROUNDS = 2                   # 最近几轮的工具结果在上下文里保留全文
_OLD_TOOL_CHARS = 400                # 更早轮次的结果压缩后保留的字符数
_TREE_LINES = 120                    # 系统提示里项目结构的最大行数
_TREE_DEPTH = 2                      # 项目结构展开的层级

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
def _repo_tree(root, max_lines=_TREE_LINES, depth=_TREE_DEPTH):
    """生成项目结构摘要（放进系统提示）。模型据此直接定位文件，
    可以省掉任务开头那几轮「列目录 → 再列子目录」的探索往返。"""
    if not root or not os.path.isdir(root):
        return ""
    out = []
    queue = [(root, 0)]
    while queue and len(out) < max_lines:
        d, level = queue.pop(0)
        if level >= depth:
            continue
        try:
            names = os.listdir(d)
        except OSError:
            continue
        dirs = sorted(n for n in names if not n.startswith(".") and n not in _SKIP_DIRS
                      and os.path.isdir(os.path.join(d, n)))
        files = sorted(n for n in names if not n.startswith(".") and os.path.isfile(os.path.join(d, n)))
        for n in dirs + files:
            full = os.path.join(d, n)
            out.append("  " * level + n + ("/" if n in dirs else ""))
            if os.path.isdir(full):
                queue.append((full, level + 1))
            if len(out) >= max_lines:
                out.append("…（更多内容已省略）")
                break
    return "\n".join(out)


def _agent_system(root, perm):
    perm_desc = {
        "readonly": "仅可查看 —— 只能读文件与搜索，写入和执行会被拒绝（可提示用户切换权限）",
        "workspace": "工作区内修改 —— 可以读写项目内的文件；执行命令前会先征求用户确认",
        "full": "完全权限 —— 可以读写任意路径；执行命令不再确认（危险命令仍会被安全规则拦截）",
    }.get(perm, "工作区内修改")
    tree = _repo_tree(root)
    return (
        "你是一个自托管文件管理器内置的编程智能体，可以通过工具自动读取文件、修改文件、搜索代码、执行命令来完成任务。\n"
        "当前项目根目录：%s\n"
        "当前权限：%s\n"
        "项目结构（%d 层，忽略 .git/node_modules 等无关目录，供直接定位文件）：\n%s\n\n"
        "工作方式：\n"
        "1. 项目结构里已经能看到路径的文件，直接 read_file 打开，不要重复逐层 list_dir 探索；\n"
        "2. 需要读多个文件时，在同一条回复里一次性发起多个 read_file / search_files 调用"
        "（系统会并行执行，比逐个来回快得多）；\n"
        "3. 先读文件或搜索确认现状，再动手修改，不要凭空猜测文件内容；\n"
        "4. 局部修改优先用 edit_file（old_text 必须与原文完全一致，含缩进），整篇重写才用 write_file；\n"
        "5. 路径优先使用相对项目根的相对路径；\n"
        "6. 每次工具调用后根据真实结果决定下一步，不要编造工具结果；\n"
        "7. 任务完成后用简体中文简洁说明做了什么、涉及哪些文件、有无遗留问题；\n"
        "8. 需要用户提供信息（如密钥、路径偏好）时直接提问，不要臆造。"
        % (root or "/", perm_desc, _TREE_DEPTH, tree or "（无法读取项目结构，请用 list_dir 自行查看）")
    )


# 有些模型（商汤 SenseNova、部分开源权重）不走标准 tool_calls 字段，而是把调用写在
# 正文里：<tool_call><function=list_dir><parameter=path>app</parameter></function></tool_call>
# 这里做一层兼容解析，否则会出现「看着像在调工具、实际一步都没执行」。
_TEXT_CALL_RE = re.compile(r"<tool_call>(.*?)(?:</tool_call>|$)", re.S | re.I)
_TEXT_FUNC_RE = re.compile(r"<function[=:\s]+[\"']?([\w.\-]+)[\"']?\s*>(.*?)(?:</function>|$)", re.S | re.I)
_TEXT_ARG_RE = re.compile(r"<parameter[=:\s]+[\"']?([\w.\-]+)[\"']?\s*>(.*?)(?:</parameter>|(?=<parameter)|$)", re.S | re.I)
_TEXT_NAME_ATTR = re.compile(r"<(parameter|function)\s+name\s*=\s*[\"']([^\"']+)[\"']\s*>", re.I)
_TEXT_CALL_HINT = re.compile(r"<tool_calls?>|<function[=:\s]|<parameter[=:\s]", re.I)


def _parse_text_calls(text):
    """从正文里解析文本格式的工具调用；解析不到返回 []。"""
    if not text or not _TEXT_CALL_HINT.search(text):
        return []
    blocks = _TEXT_CALL_RE.findall(text) or [text]
    out = []
    for b in blocks:
        b = _TEXT_NAME_ATTR.sub(r"<\1=\2>", b)          # <parameter name="x"> → <parameter=x>
        for fm in _TEXT_FUNC_RE.finditer(b):
            name, body = fm.group(1).strip(), fm.group(2) or ""
            args = {}
            for am in _TEXT_ARG_RE.finditer(body):
                key, raw = am.group(1).strip(), (am.group(2) or "").strip()
                if not key:
                    continue
                try:
                    args[key] = json.loads(raw)          # 数字/布尔/对象按 JSON 解析
                except ValueError:
                    args[key] = raw.strip().strip("\"'").strip()
            if name:
                out.append({"id": "textcall_%d" % len(out), "name": name, "args": args,
                            "args_raw": json.dumps(args, ensure_ascii=False)})
    return out


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
        resp = _open_stream(req, url, _CONNECT_TIMEOUT, _READ_TIMEOUT)
    except urllib.error.HTTPError as e:
        try:
            detail = e.read().decode("utf-8", "replace")[:400]
        except OSError:
            detail = ""
        yield _sse({"type": "error", "error": "接口返回 %s：%s" % (e.code, detail or e.reason)})
        return text, []
    except (socket.timeout, TimeoutError):
        yield _sse({"type": "error", "error": "连接 AI 接口超时（%d 秒）：请检查接口地址与网络" % _CONNECT_TIMEOUT})
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
    if not out:                                   # 兼容：有些模型把调用写在正文里
        out = _parse_text_calls(text)
        if out:
            _log.info("Agent：模型用文本格式返回了 %d 个工具调用，已按兼容模式解析", len(out))
    return text, out


def _run_tool_job(name, args, root, perm):
    """执行单个工具（会被线程池并发调用，只做纯函数式处理）。"""
    fn = _TOOL_FUNCS.get(name)
    if fn is None:
        return False, "未知工具：%s" % name, "", "未知工具：%s" % name
    try:
        return fn(args, root, perm)
    except Exception as e:  # noqa: BLE001
        return False, "工具执行异常：%s" % e, "", "工具执行异常：%s" % e


def _trim_convo(convo, rounds_tool_idx):
    """上下文裁剪：只保留最近几轮工具结果的全文，更早的压缩成摘要。

    多轮任务里历史结果会越堆越多，导致每一轮请求的 prompt 越来越大、
    首字延迟越来越长；这里让旧的工具结果只留开头一小段，模型仍知道
    「当时读了哪个文件、大致是什么」，但不必每轮重发几万字。"""
    keep = set()
    for idxs in rounds_tool_idx[-_RECENT_ROUNDS:]:
        keep.update(idxs)
    trimmed = 0
    for i, m in enumerate(convo):
        if m.get("role") != "tool" or i in keep:
            continue
        body = m.get("content") or ""
        if len(body) <= _OLD_TOOL_CHARS:
            continue
        m["content"] = (body[:_OLD_TOOL_CHARS] +
                        "\n…（较早轮次的结果已省略 %d 字符）" % (len(body) - _OLD_TOOL_CHARS))
        trimmed += 1
    return trimmed


def _run_agent(run_id, provider, model, root, perm, msgs):
    convo = [{"role": "system", "content": _agent_system(root, perm)}] + msgs
    always_allow = set()
    rounds_tool_idx = []                 # 每轮追加的 tool 消息下标，用于上下文裁剪
    for _round in range(_MAX_ROUNDS):
        result = yield from _stream_model(provider, model, convo)
        text, tool_calls = result
        if not tool_calls:
            return
        convo.append({"role": "assistant", "content": text or None,
                      "tool_calls": [{"id": c["id"], "type": "function",
                                      "function": {"name": c["name"], "arguments": c["args_raw"]}}
                                     for c in tool_calls]})
        done = {}                        # call_id -> (ok, summary, detail, model_text, ms, denied)
        parallel, serial = [], []
        # ① 逐个发 step 事件 + 权限判定（需要确认的稍后仍按顺序处理）
        for c in tool_calls:
            name, args = c["name"], c["args"]
            yield _sse({"type": "step", "call_id": c["id"], "tool": name, "args": args})
            allowed, refuse, need_ask, ask_reason = _gate(perm, name, args, root)
            if not allowed:
                done[c["id"]] = (False, refuse, "", "调用被拒绝：%s" % refuse, 0, True)
                yield _sse({"type": "result", "call_id": c["id"], "tool": name, "ok": False,
                            "summary": refuse, "detail": "", "ms": 0, "denied": True})
                continue
            if need_ask and name not in always_allow:
                serial.append({"c": c, "ask": ask_reason})       # 需要用户确认：串行
            elif name in _READ_TOOLS:
                parallel.append({"c": c})                        # 只读工具：可并行
            else:
                serial.append({"c": c, "ask": ""})               # 写入 / 执行命令：串行，保证顺序
        # ② 只读工具并行执行（同一轮里读多个文件不再一个个排队）
        if parallel:
            with ThreadPoolExecutor(max_workers=min(_MAX_PARALLEL, len(parallel))) as pool:
                futs = {}
                for job in parallel:
                    futs[pool.submit(_run_tool_job, job["c"]["name"], job["c"]["args"], root, perm)] = (
                        job, time.time())
                for fut in as_completed(futs):
                    job, t_start = futs[fut]
                    c = job["c"]
                    ok, summary, detail, model_text = fut.result()
                    ms = int((time.time() - t_start) * 1000)
                    done[c["id"]] = (ok, summary, detail, model_text, ms, False)
                    _log.info("Agent 工具（并行）：%s %s → %s（%dms）", c["name"],
                              json.dumps(c["args"], ensure_ascii=False)[:200], "ok" if ok else "fail", ms)
                    yield _sse({"type": "result", "call_id": c["id"], "tool": c["name"], "ok": ok,
                                "summary": summary, "detail": detail, "ms": ms})
        # ③ 写文件 / 执行命令 / 需确认的调用：按模型给出的顺序串行执行
        for job in serial:
            c = job["c"]
            name, args = c["name"], c["args"]
            t_start = time.time()
            if job["ask"] and name not in always_allow:
                key = (run_id, c["id"])
                ev = threading.Event()
                box = {"allow": False, "always": False}
                with _PENDING_LOCK:
                    _PENDING[key] = {"ev": ev, "box": box}
                yield _sse({"type": "ask", "call_id": c["id"], "tool": name, "args": args,
                            "reason": job["ask"]})
                answered = ev.wait(timeout=_ASK_TIMEOUT)
                with _PENDING_LOCK:
                    _PENDING.pop(key, None)
                if not (answered and box["allow"]):
                    refuse = ("用户拒绝了该命令" if answered
                              else "等待用户确认超时（%d 秒）" % _ASK_TIMEOUT)
                    ms = int((time.time() - t_start) * 1000)
                    done[c["id"]] = (False, refuse, "", "调用被拒绝：%s" % refuse, ms, True)
                    yield _sse({"type": "result", "call_id": c["id"], "tool": name, "ok": False,
                                "summary": refuse, "detail": "", "ms": ms, "denied": True})
                    continue
                if box["always"]:
                    always_allow.add(name)
            ok, summary, detail, model_text = _run_tool_job(name, args, root, perm)
            ms = int((time.time() - t_start) * 1000)
            done[c["id"]] = (ok, summary, detail, model_text, ms, False)
            _log.info("Agent 工具：%s %s → %s（%dms）", name, json.dumps(args, ensure_ascii=False)[:200],
                      "ok" if ok else "fail", ms)
            yield _sse({"type": "result", "call_id": c["id"], "tool": name, "ok": ok,
                        "summary": summary, "detail": detail, "ms": ms})
        # ④ 按模型给出的顺序回填工具结果，并裁剪较早轮次的上下文
        idxs = []
        for c in tool_calls:
            rec = done.get(c["id"])
            if rec is None:
                continue
            idxs.append(len(convo))
            convo.append({"role": "tool", "tool_call_id": c["id"],
                          "content": (rec[3] or rec[1] or "")[:_TOOL_CHARS]})
        rounds_tool_idx.append(idxs)
        n_trim = _trim_convo(convo, rounds_tool_idx)
        if n_trim:
            _log.info("Agent 上下文裁剪：压缩了 %d 条较早轮次的工具结果（保留最近 %d 轮全文）",
                      n_trim, _RECENT_ROUNDS)
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

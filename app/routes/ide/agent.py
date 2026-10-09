"""AI 智能体（Agent）：让模型自动读文件、改文件、搜索、执行命令，多轮直到任务完成。

POST /api/ai/agent           {repo, messages, perm, provider_id?, model?}   SSE 流式
POST /api/ai/agent/approve   {run_id, call_id, allow, always, global}       批准/拒绝待确认的调用
                             global=true 时把该命令写入「设置 → 命令安全」的全局放行名单

SSE 事件（data: {json}\\n\\n）：
    {"type":"run","run_id":"..."}                       本次运行 id（确认时回传）
    {"type":"delta","text":"..."}                       模型输出（流式）
    {"type":"step","call_id","tool","args"}             开始调用工具
    {"type":"ask","call_id","tool","args","reason"}     需要用户确认（如执行命令）
    {"type":"result","call_id","tool","ok","summary","detail","ms"}   工具结果
    {"type":"todos","todos":[{"content","status"}...]}                任务清单更新（todo_write）
    {"type":"error","error":"..."}
    {"type":"done"}

权限（perm，与前端「AI 操作权限」一致）：
    readonly  只能读文件/搜索；写入与执行一律拒绝
    workspace 读任意；写只能落在项目内；执行命令需逐条确认
    full      读任意；写任意路径；执行命令不再确认（危险命令仍会被安全规则拦截）
"""
import base64
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

from ... import config
from ...log import get_logger
from ...services.common.safety import check_command, is_delete_command, is_allowed_command
from ...services.ide.web_search import search_web, format_results
from ...services.common import undo, cmdguard
from .ai import (_clean_content, _load_cfg, _sys_pick, _override_pick, _log_ai_call,
                 _estimate_msgs, _estimate_tokens,
                 _open_stream, _sse, _inject_system_time, _sys_err_response,
                 _inject_web_search, _SKILL_PROMPTS, _is_retryable_status, _is_retryable_text,
                 _retry_wait, _RETRY_MAX, _last_user_text, _fire_notify_async)

_log = get_logger()
bp = Blueprint("agent", __name__)

_MAX_ROUNDS = 0                      # 工具轮数上限（0 = 不限制，靠模型自己结束任务）
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
        "description": "读取文本文件内容，返回带行号的文本（格式「行号| 内容」）。"
                       "大文件不要整篇读取：先用 start/end 只读需要的行段（例如 start=50, end=74），"
                       "或先用 search_files 定位再按行段读取",
        "parameters": {"type": "object", "properties": {
            "path": {"type": "string", "description": "文件路径（相对项目根或绝对路径）"},
            "start": {"type": "integer", "description": "起始行号（从 1 开始，默认 1）"},
            "end": {"type": "integer", "description": "结束行号（含，默认文件末行）"}},
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
    {"type": "function", "function": {
        "name": "web_search",
        "description": "联网搜索实时信息（当前时间、新闻、文档、技术问题等）。当用户的问题可能涉及时效性、外部事件或需要最新资料时调用。",
        "parameters": {"type": "object", "properties": {
            "query": {"type": "string", "description": "搜索关键词（用简短、准确的中文或英文）"},
            "max_results": {"type": "integer", "description": "最多返回几条结果（默认 5，最大 10）"}},
            "required": ["query"]}}},
    {"type": "function", "function": {
        "name": "generate_image",
        "description": "根据文字描述生成图片（文生图）。当你需要为界面、文档、README 或演示生成配图，"
                      "或用户明确要求画图时调用。返回生成图片的查看地址（markdown 图片链接）。"
                      "依赖当前接口支持 OpenAI 格式的 /images/generations（如 OpenAI；不支持的接口会返回明确错误）。",
        "parameters": {"type": "object", "properties": {
            "prompt": {"type": "string", "description": "画面描述（尽量具体：主体、风格、构图、色调）"},
            "model": {"type": "string", "description": "图片模型名（可选）。默认 gpt-image-1；若当前接口不支持该模型，请换成接口提供的图片模型"},
            "size": {"type": "string", "description": "尺寸（可选，默认 1024x1024，如 512x512 / 1792x1024）"},
            "n": {"type": "integer", "description": "生成张数（可选，1-4，默认 1）"}},
            "required": ["prompt"]}}},
    {"type": "function", "function": {
        "name": "code_intel",
        "description": "本地代码智能（LSP 风格的轻量实现，无需外部语言服务进程）：在项目里"
                      "查找符号定义、查找引用、列出文件大纲、按名搜索符号。只读、不修改任何文件。",
        "parameters": {"type": "object", "properties": {
            "action": {"type": "string", "description": "操作：find_definition 找定义 / find_references 找引用 / outline 列大纲 / search_symbol 按名搜符号"},
            "query": {"type": "string", "description": "符号名（如 MyClass、do_task）或正则（search_symbol 时）"},
            "path": {"type": "string", "description": "范围：目录或文件（可选，默认项目根；outline 必须给一个文件）"}},
            "required": ["action", "query"]}}},
    {"type": "function", "function": {
        "name": "delegate_task",
        "description": "把一个边界清晰、相对独立的子任务交给子 Agent 独立完成（它会自己读文件、改文件、跑命令，"
                      "直到做完并把结果返回给你）。适合把大任务拆给子 Agent 分步推进。子 Agent 最多跑"
                      "「最大步数（子 Agent）」步，且不会再次派生子 Agent；危险命令会被它自动拒绝。",
        "parameters": {"type": "object", "properties": {
            "task": {"type": "string", "description": "给子 Agent 的任务说明（目标、范围、约束、验收标准）"},
            "scope_path": {"type": "string", "description": "子 Agent 的工作范围目录（可选，默认同项目根）"}},
            "required": ["task"]}}},
    {"type": "function", "function": {
        "name": "todo_write",
        "description": "创建或更新当前任务的「任务清单」（待办列表），用于把多步骤任务拆解并实时跟踪进度。"
                      "每次调用都传入【完整】清单（而不是增量），已完成 / 进行中 / 待办都包含在内。"
                      "当任务需要 3 步以上、涉及多个文件，或用户明确要求先列计划时使用；"
                      "简单的一两步任务无需清单。",
        "parameters": {"type": "object", "properties": {
            "todos": {"type": "array", "description": "完整的任务清单（按执行顺序排列）", "items": {
                "type": "object", "properties": {
                    "content": {"type": "string", "description": "任务内容（一句话，动词开头，如「改造 agent.py 支持解析」）"},
                    "status": {"type": "string", "enum": ["pending", "in_progress", "completed"],
                               "description": "状态：pending 待办 / in_progress 进行中（同一时刻最多一项）/ completed 已完成"}},
                "required": ["content", "status"]}}},
            "required": ["todos"]}}},
]

_READ_TOOLS = {"list_dir", "read_file", "search_files", "web_search", "code_intel"}
_WRITE_TOOLS = {"write_file", "edit_file"}
_TOOL_NAMES = {t["function"]["name"] for t in _TOOLS}

# 不同模型对工具的命名差异（Claude 风格 / 各类开源权重），统一映射到本项目的工具名
_TOOL_ALIASES = {
    "bash": "run_command", "shell": "run_command", "sh": "run_command", "zsh": "run_command",
    "terminal": "run_command", "run": "run_command", "execute": "run_command",
    "execute_command": "run_command", "run_command": "run_command", "command": "run_command",
    "read": "read_file", "cat": "read_file", "open_file": "read_file", "view": "read_file",
    "read_file": "read_file", "readfile": "read_file",
    "write": "write_file", "create": "write_file", "create_file": "write_file",
    "write_file": "write_file", "writefile": "write_file",
    "edit": "edit_file", "str_replace": "edit_file", "replace": "edit_file",
    "str_replace_editor": "edit_file", "edit_file": "edit_file", "apply_patch": "edit_file",
    "ls": "list_dir", "list": "list_dir", "list_files": "list_dir", "listdir": "list_dir",
    "list_dir": "list_dir",
    "grep": "search_files", "search": "search_files", "search_files": "search_files",
    "search_files_content": "search_files", "find": "search_files", "glob": "search_files",
    "web_search": "web_search", "websearch": "web_search", "search_web": "web_search",
    "todo_write": "todo_write", "todos": "todo_write", "todo": "todo_write",
    "task_list": "todo_write", "tasklist": "todo_write", "write_todos": "todo_write",
    "update_todos": "todo_write", "todowrite": "todo_write",
}
# 参数名差异：统一成本项目工具使用的键名
_ARG_ALIASES = {
    # 统一大小写（模型常写 Path / Content / Old_Text 等）
    "path": "path", "content": "content", "old_text": "old_text", "new_text": "new_text",
    "pattern": "pattern", "query": "query", "max": "max", "max_results": "max_results",
    "command": "command", "timeout": "timeout", "start": "start", "end": "end",
    # 常见别名
    "file_path": "path", "filepath": "path", "file_name": "path", "filename": "path",
    "file": "path", "dir": "path", "directory": "path", "folder": "path",
    "old_string": "old_text", "old_str": "old_text", "old_content": "old_text", "old": "old_text",
    "new_string": "new_text", "new_str": "new_text", "new_content": "new_text", "new": "new_text",
    "cmd": "command", "script": "command", "shell_command": "command",
    "start_line": "start", "end_line": "end",
    # 任务清单：模型可能用 tasks / items / list 等键名
    "todos": "todos", "tasks": "todos", "items": "todos", "todo_list": "todos",
    "task_list": "todos", "plan": "todos",
}
# 这些键只是说明性字段，不作为工具参数
_CALL_META_KEYS = {"name", "tool", "tool_name", "type", "function", "input", "arguments",
                   "parameters", "args", "description", "id", "thought", "reasoning"}


def _extract_first_json(s):
    """从字符串里截取第一个花括号平衡的 JSON 对象（忽略字符串内的括号）。"""
    start = s.find("{")
    if start < 0:
        return None
    depth, in_str, esc = 0, False, False
    for i in range(start, len(s)):
        ch = s[i]
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return s[start:i + 1]
    return None


def _loads_json(raw):
    """宽松 JSON 解析：直接解析失败时，尝试截取其中第一个 JSON 对象。"""
    if not raw:
        return None
    try:
        return json.loads(raw)
    except (ValueError, TypeError):
        pass
    sub = _extract_first_json(raw)
    if not sub:
        return None
    try:
        return json.loads(sub)
    except (ValueError, TypeError):
        return None


def _normalize_call(name, args):
    """把各种模型风格的工具名/参数名归一化到本项目工具；无法识别返回 (None, {})。"""
    if not name:
        return None, {}
    key = str(name).strip().lower().split(".")[-1].split("::")[-1].split("/")[-1]
    target = _TOOL_ALIASES.get(key, key)
    if target not in _TOOL_NAMES:
        return None, {}
    a = {}
    for k, v in (args or {}).items():
        lk = str(k).strip().lower()
        a[_ARG_ALIASES.get(lk, str(k))] = v
    if target == "run_command" and "command" not in a:
        for alt in ("cmd", "script", "shell_command", "bash"):
            if alt in a:
                a["command"] = a.pop(alt)
                break
    if target in ("search_files", "web_search"):
        want = "query" if target == "web_search" else "pattern"
        if want not in a:
            for alt in ("query", "pattern", "keyword", "q", "text", "regex"):
                if alt in a:
                    a[want] = a.pop(alt)
                    break
        cnt = "max_results" if target == "web_search" else "max"
        if cnt not in a:
            for alt in ("max", "max_results", "limit", "n", "count"):
                if alt in a:
                    a[cnt] = a.pop(alt)
                    break
    if target in ("read_file", "write_file", "edit_file", "list_dir") and "path" not in a:
        for alt in ("file", "filename", "file_name", "dir", "directory", "folder"):
            if alt in a:
                a["path"] = a.pop(alt)
                break
    return target, a


def _call_from_obj(obj):
    """从 JSON 对象里提取一次工具调用，无法识别返回 None。"""
    if not isinstance(obj, dict):
        return None
    name = obj.get("name") or obj.get("tool") or obj.get("tool_name") or obj.get("type")
    fn = obj.get("function")
    if not name and isinstance(fn, dict):
        name = fn.get("name")
    args = obj.get("input")
    if args is None:
        args = obj.get("arguments")
    if args is None:
        args = obj.get("parameters")
    if args is None:
        args = obj.get("args")
    if isinstance(args, str):
        args = _loads_json(args)
    if not isinstance(args, dict):
        args = {}
    extra = {k: v for k, v in obj.items() if k not in _CALL_META_KEYS}
    merged = dict(extra)
    merged.update(args)
    if isinstance(fn, dict):                       # {"function": {"name": ..., "arguments": {...}}}
        fargs = fn.get("arguments")
        if isinstance(fargs, str):
            fargs = _loads_json(fargs)
        if isinstance(fargs, dict):
            merged.update(fargs)
    target, norm = _normalize_call(name, merged)
    if not target:
        return None
    return {"id": "", "name": target, "args": norm, "args_raw": json.dumps(norm, ensure_ascii=False)}

# 待用户确认的调用：{(run_id, call_id): {"ev": Event, "box": {...}}}
_PENDING = {}
_PENDING_LOCK = threading.Lock()

# 每场运行累计的文件变更：run_id -> [{id, path, action}, ...]
# 停止/中断时最后一批 result 事件可能没送达前端，前端可按 run_id 来这里补拉
_RUN_CHANGES = {}
_RUN_CHANGES_ORDER = []
_RUN_CHANGES_MAX = 50


def _record_run_changes(run_id, changes):
    if not run_id or not changes:
        return
    with _PENDING_LOCK:
        if run_id not in _RUN_CHANGES:
            _RUN_CHANGES[run_id] = []
            _RUN_CHANGES_ORDER.append(run_id)
            while len(_RUN_CHANGES_ORDER) > _RUN_CHANGES_MAX:
                _RUN_CHANGES.pop(_RUN_CHANGES_ORDER.pop(0), None)
        lst = _RUN_CHANGES[run_id]
        seen = {c.get("id") for c in lst}
        for c in changes:
            if c.get("id") and c.get("id") not in seen:
                lst.append(c)


# 任务清单状态（与前端、模型约定的取值）
_TODO_MAX = 30
_TODO_DONE = {"done", "complete", "completed", "finished", "ok", "success", "true", "已完成", "完成"}
_TODO_DOING = {"in_progress", "in-progress", "inprogress", "doing", "active", "running",
               "working", "current", "进行中"}


def _norm_todos(raw):
    """把模型给出的任务清单归一化成 [{"content": str, "status": "pending|in_progress|completed"}]。

    兼容多种写法：纯字符串数组、[{content/task/text, status/state}]、或包在 {"todos": [...]} 里。
    """
    if isinstance(raw, dict):
        raw = raw.get("todos") or raw.get("tasks") or raw.get("items")
    if not isinstance(raw, list):
        return []
    out = []
    for it in raw[:_TODO_MAX]:
        if isinstance(it, str):
            content, status = it, ""
        elif isinstance(it, dict):
            content = (it.get("content") or it.get("task") or it.get("text")
                       or it.get("title") or it.get("desc") or "")
            status = str(it.get("status") or it.get("state") or it.get("done") or "")
        else:
            continue
        content = str(content).strip()
        if not content:
            continue
        st = status.strip().lower()
        if st in _TODO_DONE:
            st = "completed"
        elif st in _TODO_DOING:
            st = "in_progress"
        else:
            st = "pending"
        out.append({"content": content[:200], "status": st})
    return out


# ---------------------------------------------------------------- 基础工具
def _norm_abs(p):
    """绝对路径归一化：POSIX 下 abspath/normpath 不折叠开头的 //（模型经常写出 //home/...），
    这里统一折叠成单个 /，避免与真实根目录前缀不匹配被误判为越界。"""
    p = os.path.abspath(os.path.normpath(str(p or "")))
    while p.startswith("//"):
        p = p[1:]
    return p


def _resolve(path, root):
    """路径解析：绝对路径原样，相对路径按项目根拼接。"""
    p = str(path or "").strip()
    if not p:
        return ""
    p = os.path.expanduser(p)
    if not os.path.isabs(p):
        p = os.path.join(root or os.getcwd(), p)
    return _norm_abs(p)


def _inside(path, root):
    if not root:
        return True
    try:
        return os.path.commonpath([_norm_abs(path), _norm_abs(root)]) == _norm_abs(root)
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
        undo.snapshot(path)                   # 写入前记录原状，供回撤
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
        undo.snapshot(path)                   # 修改前记录原状，供回撤
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
    try:                                        # 执行前按命令里的路径做快照，供回撤
        _cmd_ids, _cmd_complete = undo.snapshot_for_command(cmd, root)
    except Exception:  # noqa: BLE001
        _cmd_complete = True
    _undo_note = "" if _cmd_complete else "（部分路径过大，未记录回撤快照）"
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
    if _undo_note:
        summary += _undo_note
    return code == 0, summary, body[-3000:], "$ %s\n%s" % (cmd, body)


def _tool_web_search(args, root, perm):
    """Agent 工具：联网搜索。"""
    query = str(args.get("query") or "").strip()
    if not query:
        return False, "缺少 query", "", "缺少 query"
    try:
        max_results = max(1, min(int(args.get("max_results") or 5), 10))
    except (TypeError, ValueError):
        max_results = 5
    try:
        results = search_web(query, max_results=max_results)
        text = format_results(results, max_chars=_TOOL_CHARS)
        summary = "联网搜索：%s" % query
        return True, summary, text[-3000:], "[联网搜索：%s]\n%s" % (query, text)
    except Exception as e:  # noqa: BLE001
        return False, "搜索失败", "", "联网搜索失败：%s" % e


def _tool_todo_write(args, root, perm):
    """Agent 工具：创建 / 更新任务清单。纯状态记录，不落盘、不碰文件，任何权限都允许。"""
    todos = _norm_todos(args.get("todos"))
    if not todos:
        return False, "清单为空", "", "todo_write 需要提供非空的 todos 数组（每项含 content 与 status）"
    done = sum(1 for t in todos if t["status"] == "completed")
    total = len(todos)
    cur = next((t["content"] for t in todos if t["status"] == "in_progress"), "")
    mark = {"completed": "[x]", "in_progress": "[>]", "pending": "[ ]"}
    body = "\n".join("%d. %s %s" % (i, mark[t["status"]], t["content"])
                     for i, t in enumerate(todos, 1))
    summary = "任务清单 %d/%d 已完成" % (done, total) + ("，当前：" + cur if cur else "")
    return True, summary, body, "任务清单已更新（%d/%d 完成）：\n%s" % (done, total, body)


_TOOL_FUNCS = {
    "list_dir": _tool_list_dir,
    "read_file": _tool_read_file,
    "write_file": _tool_write_file,
    "edit_file": _tool_edit_file,
    "search_files": _tool_search_files,
    "run_command": _tool_run_command,
    "web_search": _tool_web_search,
    "todo_write": _tool_todo_write,
}
# generate_image / code_intel 在文件下方定义，于模块加载末期注册到 _TOOL_FUNCS


# ---------------------------------------------------------------- 新增工具：图片生成 / 本地代码智能 / 子 Agent
def _tool_generate_image(args, root, perm, ctx=None):
    """调用当前接口的 OpenAI 格式 /images/generations，生成图片并落盘，回传查看地址。

    图片模型优先级：调用时显式 model > 设置里的默认模型(ctx.image_model) > gpt-image-1。
    """
    prompt = str(args.get("prompt") or "").strip()
    if not prompt:
        return False, "缺少 prompt", "", "缺少 prompt"
    cfg = _load_cfg()
    provider, model, err = _sys_pick(cfg, "agent")
    if err:
        return False, err, "", err
    base = provider["base_url"].rstrip("/")
    if base.endswith("/chat/completions"):
        base = base[: -len("/chat/completions")]
    img_model = str(args.get("model") or (ctx or {}).get("image_model") or "gpt-image-1").strip() or "gpt-image-1"
    size = str(args.get("size") or "1024x1024").strip() or "1024x1024"
    try:
        n = max(1, min(4, int(args.get("n") or 1)))
    except (TypeError, ValueError):
        n = 1
    body = {"model": img_model, "prompt": prompt, "n": n, "size": size, "response_format": "b64_json"}
    req = urllib.request.Request(base + "/images/generations", data=json.dumps(body).encode("utf-8"),
                                 method="POST", headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer " + provider["api_key"]})
    try:
        with urllib.request.urlopen(req, timeout=_READ_TIMEOUT) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = e.read().decode("utf-8", "ignore")[:800]
        except Exception:  # noqa: BLE001
            pass
        return False, "图片生成失败（HTTP %d）" % e.code, "", "图片生成接口返回错误：%s" % detail
    except Exception as e:  # noqa: BLE001
        return False, "图片生成请求失败：%s" % e, "", "图片生成请求失败：%s" % e
    items = (data.get("data") or [])[:n]
    if not items:
        return False, "接口未返回图片", "", "接口未返回图片：%s" % json.dumps(data, ensure_ascii=False)[:500]
    d = os.path.join(config.STORAGE_DIR, "ai_images")
    try:
        os.makedirs(d, exist_ok=True)
    except OSError:
        pass
    urls = []
    for i, it in enumerate(items):
        b64 = it.get("b64_json")
        url = it.get("url")
        if b64:
            try:
                fn = "%s_%d.png" % (uuid.uuid4().hex[:12], i)
                with open(os.path.join(d, fn), "wb") as f:
                    f.write(base64.b64decode(b64))
                urls.append("/api/ai/image/" + fn)
            except Exception:  # noqa: BLE001
                urls.append("")
        elif url:
            urls.append(url)
    urls = [u for u in urls if u]
    if not urls:
        return False, "图片已生成但无法保存/解析", "", "图片已生成但返回内容无法解析：%s" % json.dumps(data, ensure_ascii=False)[:300]
    summary = "已生成 %d 张图片" % len(urls)
    body_text = "图片生成成功（%d 张）。查看地址：\n%s\n\n提示：用 markdown ![](地址) 即可在回复里嵌入。" % (
        len(urls), "\n".join(urls))
    return True, summary, body_text, body_text[:_TOOL_CHARS]


def _tool_code_intel(args, root, perm, ctx=None):
    """本地代码智能（LSP 风格轻量实现）：定义 / 引用 / 大纲 / 按名搜符号。只读、不改文件。"""
    action = str(args.get("action") or "find_references").strip().lower()
    query = str(args.get("query") or "").strip()
    if not query:
        return False, "缺少 query", "", "缺少 query（要查的符号名）"
    base = _resolve(args.get("path") or ".", root)
    if not os.path.exists(base):
        return False, "路径不存在：%s" % base, "", "路径不存在：%s" % base
    sym = re.escape(query)
    def_rx = re.compile(
        r"^\s*(?:async\s+)?(?:def|class|function|func|fn|public\s+func|private\s+func|"
        r"protected\s+func|pub\s+fn|public\s+function|private\s+function)\s+%s\b" % sym)
    ref_rx = re.compile(r"(?<![A-Za-z0-9_])%s(?![A-Za-z0-9_])" % sym)
    if action == "outline":
        if not os.path.isfile(base):
            return False, "outline 需要指定一个文件（path）", "", "outline 需要指定一个文件（path）"
        # 大纲：列出文件里所有 def/class/函数/常量声明（不依赖 query）
        outline_rx = re.compile(
            r"^\s*(?:async\s+)?(?:def|class|function|func|fn|public|private|protected|const|let|var|pub)\b")
        hits = []
        try:
            with open(base, "r", encoding="utf-8", errors="ignore") as f:
                for i, line in enumerate(f, 1):
                    if outline_rx.match(line):
                        hits.append("%d: %s" % (i, line.strip()[:160]))
        except (OSError, UnicodeError) as e:
            return False, "读取失败：%s" % e, "", "读取失败：%s" % e
        if not hits:
            return True, "大纲无匹配", "", "文件 %s 内未找到 %s 的定义/声明" % (_rel(base, root), query)
        body = "\n".join(hits)
        return True, "大纲 %d 项" % len(hits), body, ("文件 %s 大纲（%d）：\n%s" % (_rel(base, root), len(hits), body))[:_TOOL_CHARS]
    if action == "find_definition":
        rx, label = def_rx, "定义"
    elif action in ("find_references", "search_symbol"):
        rx, label = ref_rx, "符号" if action == "search_symbol" else "引用"
    else:
        return False, "未知 action：%s" % action, "", \
            "未知 action：%s（支持 find_definition / find_references / outline / search_symbol）" % action
    hits, scanned = [], 0

    def _iter_files():
        if os.path.isfile(base):
            yield base
            return
        for dirpath, dirnames, filenames in os.walk(base):
            dirnames[:] = [x for x in dirnames if x not in _SKIP_DIRS and not x.startswith(".git")]
            for fn in filenames:
                full = os.path.join(dirpath, fn)
                if os.path.getsize(full) > 2 * 1024 * 1024:
                    continue
                yield full

    for full in _iter_files():
        scanned += 1
        if scanned > _SEARCH_FILES * 4:
            break
        try:
            with open(full, "r", encoding="utf-8", errors="ignore") as f:
                for i, line in enumerate(f, 1):
                    if rx.search(line):
                        hits.append("%s:%d: %s" % (_rel(full, root), i, line.rstrip()[:200]))
                        if len(hits) >= _SEARCH_HITS:
                            break
        except (OSError, UnicodeError):
            continue
        if len(hits) >= _SEARCH_HITS:
            break
    if not hits:
        return True, "无匹配", "", "在 %s 下 %s %s：无匹配" % (_rel(base, root), action, query)
    body = "\n".join(hits)
    return True, "%s 命中 %d 处" % (label, len(hits)), body[:4000], \
        ("在 %s 下 %s %s（命中 %d）：\n%s" % (_rel(base, root), action, query, len(hits), body))[:_TOOL_CHARS]


def _run_subagent(provider, model, root, perm, task, ctx):
    """子 Agent 内部循环（生成器）：复用 _stream_model 跑工具，最多 sub_max 步，不再派生子 Agent。

    每执行一步都会 yield 一个结构化事件 dict（kind∈start/step/result/final），
    供父级实时转发到前端；最终 return (final_text, log)。
    """
    sub_max = ctx.get("max_steps_sub") or 0
    convo = [{"role": "system", "content": _agent_system(root, perm, task_list=ctx.get("task_list", True),
                                                         web_tool=ctx.get("web_tool", True),
                                                         image_tool=ctx.get("image_tool", True),
                                                         lsp_tool=ctx.get("lsp_tool", True),
                                                         allow_sub=False)},
             {"role": "user", "content": "这是一个独立的子任务，请独立完成（最多 %s 步）。任务：%s"
              % ("不限" if not sub_max else sub_max, task)}]
    tool_list = [t for t in _TOOLS
                 if (ctx.get("web_tool", True) or t["function"]["name"] != "web_search")
                 and (ctx.get("image_tool", True) or t["function"]["name"] != "generate_image")
                 and (ctx.get("lsp_tool", True) or t["function"]["name"] != "code_intel")
                 and (ctx.get("task_list", True) or t["function"]["name"] != "todo_write")
                 and t["function"]["name"] != "delegate_task"]   # 子 Agent 不再派生子 Agent
    log = []
    _round = 0
    sid = 0
    yield {"kind": "start", "task": task}
    while True:
        _round += 1
        if sub_max and _round > sub_max:
            log.append("[子 Agent 已达到「最大步数（子 Agent）」上限 %d，自动停止]" % sub_max)
            break
        # 驱动模型：子 Agent 的推理 token 不逐个转发，只在产出工具调用时上报进度
        gen = _stream_model(provider, model, convo, tool_list)
        try:
            while True:
                next(gen)            # 丢弃子 Agent 的流式输出
        except StopIteration as e:
            text, tool_calls = e.value
        convo.append({"role": "assistant", "content": text or None,
                      "tool_calls": [{"id": c["id"], "type": "function",
                                      "function": {"name": c["name"], "arguments": c["args_raw"]}}
                                     for c in tool_calls]})
        if not tool_calls:
            break
        for c in tool_calls:
            name, cargs = c["name"], c["args"]
            sid += 1
            yield {"kind": "step", "sid": sid, "tool": name, "args": cargs}
            # 子 Agent 不能把确认弹给用户：sub_agent=True 让 _gate 自动裁决
            allowed, refuse, need_ask, ask_reason = _gate(perm, name, cargs, root,
                                                          ctx.get("auto_run", "safe"),
                                                          ctx.get("web_auto", True), sub_agent=True)
            if not allowed:
                res_text = "调用被拒绝：%s" % refuse
                s_summary = refuse
                s_ok = False
            else:
                s_ok, s_summary, detail, model_text = _run_tool_job(name, cargs, root, perm, ctx)
                res_text = model_text or s_summary
                if not s_ok and s_summary:
                    res_text = "工具执行失败：%s" % s_summary
            convo.append({"role": "tool", "tool_call_id": c["id"],
                          "content": (res_text or "")[:_TOOL_CHARS]})
            yield {"kind": "result", "sid": sid, "tool": name, "ok": bool(s_ok), "summary": s_summary or ""}
            log.append("[%s] %s" % (name, s_summary or (refuse if not allowed else "")))
    final = ""
    for m in reversed(convo):
        if m.get("role") == "assistant":
            final = m.get("content") or ""
            break
    yield {"kind": "final", "text": final}
    return final, "\n".join(log)


def _tool_delegate_task(args, root, perm, ctx):
    """主 Agent 调用：把一个子任务交给子 Agent 独立完成。

    作为生成器运行：逐个 yield 子 Agent 的内部事件 dict（父级包成 subagent SSE 实时转发到前端），
    最后 return (ok, summary, detail, model_text)。
    """
    task = str(args.get("task") or "").strip()
    if not task:
        yield {"kind": "error", "msg": "缺少 task"}
        return False, "缺少 task", "", "缺少 task（给子 Agent 的任务说明）"
    if not ctx or not ctx.get("provider"):
        yield {"kind": "error", "msg": "子 Agent 只能在 Agent 运行中调用"}
        return False, "子 Agent 只能在 Agent 运行中调用", "", "delegate_task 缺少运行上下文"
    root = _resolve(args.get("scope_path") or ".", ctx.get("root") or root)
    if not os.path.isdir(root):
        yield {"kind": "error", "msg": "scope_path 不是有效目录"}
        return False, "scope_path 不是有效目录", "", "子 Agent 范围目录不存在：%s" % root
    gen = _run_subagent(ctx["provider"], ctx["model"], root, perm, task, ctx)
    final_text, log = "", ""
    try:
        while True:
            yield next(gen)         # 转发子 Agent 内部事件
    except StopIteration as e:
        final_text, log = e.value
    if not final_text and not log:
        return False, "子 Agent 未产出结果", "", "子 Agent 未产出结果"
    summary = "子 Agent 完成（约 %d 步）" % (log.count("\n") + 1)
    return True, summary, log, (final_text or "(子 Agent 未给出文字结论)")[:_TOOL_CHARS]


# generate_image / code_intel 定义在上方，这里在模块加载末期注册（避免前向引用）
_TOOL_FUNCS["generate_image"] = _tool_generate_image
_TOOL_FUNCS["code_intel"] = _tool_code_intel


def tools_for_perm(perm, image_tool=True, lsp_tool=True):
    """普通对话可用的工具：读取类始终可用；写入类仅在非只读权限下开放；不暴露 run_command。

    generate_image / code_intel 按开关开放；delegate_task 仅 Agent 内部使用，不在这里暴露。
    """
    names = {"list_dir", "read_file", "search_files", "web_search", "todo_write"}
    if perm in ("workspace", "full"):
        names |= {"write_file", "edit_file"}
    if image_tool:
        names.add("generate_image")
    if lsp_tool:
        names.add("code_intel")
    return [t for t in _TOOLS if t["function"]["name"] in names]


def _gate(perm, name, args, root, auto_run="safe", web_auto=True, sub_agent=False):
    """权限校验 → (allowed, refuse_reason, need_ask, ask_reason)。

    auto_run 来自「设置 → 对话 → 自动运行模式」：
      - "all"：命令与写文件都不再逐条确认（仍拦截 blocked 级危险命令）；
      - "safe"（默认）：写文件直接执行；命令仅对高风险/破坏性逐条确认，安全命令直接跑；
      - "ask"：每次工具调用（写文件 + 任何命令）都先问用户。
    web_auto 来自「设置 → 对话 → 自动接受网络搜索结果」：关闭时联网搜索前先征求确认。
    """
    if perm == "readonly":
        if name in _WRITE_TOOLS or name == "run_command":
            return False, "当前权限为「仅可查看」：不能写入文件或执行命令（可在输入框左下角切换权限）", False, ""
        return True, "", False, ""
    if name in _WRITE_TOOLS:
        if auto_run == "ask":
            if sub_agent:
                return True, "", False, ""               # 子 Agent 被委派来写文件，自动放行
            return True, "", True, "当前为「每次询问」模式：写入文件需要你确认"
        path = _resolve(args.get("path"), root)
        if perm != "full" and root and path and not _inside(path, root):
            return False, "超出工作区范围，已被权限拦截：%s" % path, False, ""
        return True, "", False, ""
    if name == "run_command":
        if not getattr(config, "ENABLE_EXEC", True):
            return False, "已禁用命令执行（config.ENABLE_EXEC = False）", False, ""
        cmd = str(args.get("command") or "")
        if is_allowed_command(cmd):
            return True, "", False, ""                 # 已在「全局放行名单」：任何项目都直接执行
        verdict = check_command(cmd)
        if verdict["level"] == "blocked":
            return False, "已拦截危险命令：%s" % verdict["reason"], False, ""
        if sub_agent:
            # 子 Agent 不能把确认弹给用户（会死锁）：放行安全命令，自动拒绝一切需确认 / 删除命令
            is_del, del_reason = is_delete_command(cmd)
            if verdict["level"] == "confirm" or is_del:
                return False, "子 Agent 模式下不能执行需要用户确认的危险命令：%s" % (del_reason or verdict["reason"]), False, ""
            return True, "", False, ""
        if auto_run == "all" or perm == "full":
            return True, "", False, ""                 # 自动运行所有内容 / 完全权限：命令不再逐条确认
        if auto_run == "ask":
            return True, "", True, "当前为「每次询问」模式：执行命令需要你确认"
        is_del, del_reason = is_delete_command(cmd)
        if verdict["level"] == "confirm":
            return True, "", True, "该命令有一定风险：%s" % verdict["reason"]
        if is_del:
            return True, "", True, "%s：需要你确认后才会执行" % del_reason
        return True, "", False, ""                     # 安全命令直接执行
    if name == "web_search":
        if not web_auto:
            return True, "", True, "「自动接受网络搜索结果」已关闭：联网搜索前需你确认"
        return True, "", False, ""
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


_TODO_REMIND = (
    "\n\n[系统提醒] 这是一个包含多个步骤的任务，但你还没有建立任务清单。"
    "请立即调用 todo_write 记录你的执行计划（每项含 content 与 status，正在做的标 in_progress、"
    "其余标 pending），并在后续每完成一步时调用 todo_write 更新整份清单（把完成的标 completed）。"
    "如果确实只是一两步的简单任务，可忽略本提醒直接继续。"
)


def _agent_system(root, perm, skill=None, extra_prompts=None, extra_names=None, task_list=True, web_tool=True,
                 image_tool=True, lsp_tool=True, allow_sub=True):
    perm_desc = {
        "readonly": "仅可查看 —— 只能读文件与搜索，写入和执行会被拒绝（可提示用户切换权限）",
        "workspace": "工作区内修改 —— 可以读写项目内的文件；普通命令直接执行，删除 / 高风险命令执行前会先征求用户确认",
        "full": "完全权限 —— 可以读写任意路径；执行命令不再确认（危险命令仍会被安全规则拦截）",
    }.get(perm, "工作区内修改")
    tree = _repo_tree(root)
    base = (
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
        "8. 需要用户提供信息（如密钥、路径偏好）时直接提问，不要臆造；\n"
        "9. 读文件要「按需取段」：先用 search_files 定位，或先读开头几十行了解结构，"
        "再用 read_file 的 start/end 只读相关行段；超过 300 行的文件不要一次性整篇读取"
        "（既塞满上下文，也让回答变慢）；\n"
        "10. 如果用户消息里给出了 `文件名:起-止`（例如 test_cron.py:50-74）或附带了选中代码片段，"
        "就只读那个区间（read_file 的 start/end），不要从头读到尾。"
        % (root or "/", perm_desc, _TREE_DEPTH, tree or "（无法读取项目结构，请用 list_dir 自行查看）")
    )
    tool_lines = [
        "- list_dir(path)",
        "- read_file(path, start, end)",
        "- write_file(path, content)",
        "- edit_file(path, old_text, new_text)",
        "- search_files(pattern, path, max)",
        "- run_command(command, timeout)",
    ]
    if web_tool:
        tool_lines.append("- web_search(query, max_results)")
    if image_tool:
        tool_lines.append("- generate_image(prompt, size, n)")
    if lsp_tool:
        tool_lines.append("- code_intel(action, query, path)")
    if allow_sub:
        tool_lines.append("- delegate_task(task, scope_path)")
    if task_list:
        tool_lines.append('- todo_write(todos)   # todos=[{"content":"…","status":"pending|in_progress|completed"}]')
    base += (
        "\n\n工具调用格式：优先使用标准的函数调用（tool_calls）。"
        "如果你的接口不支持 function calling，可把调用写在正文里，系统会自动解析。严格使用下列工具名与参数名：\n"
        '<tool_use>{"name":"read_file","input":{"path":"app/xxx.py"}}</tool_use>\n'
        "可用工具：\n" + "\n".join(tool_lines) + "\n"
        "不要使用 bash/read/write/edit 等别名，也不要输出无法解析的自由格式。"
    )
    if task_list:
        base += (
            "\n\n任务清单（todo_write）：当任务包含多个步骤（需要改动多个文件、先排查再修改等）时，"
            "必须在【开始动手的第一步】就调用 todo_write 建立清单（每项一句话、动词开头，按执行顺序排列，"
            "第一项标 in_progress），可以和第一批工具调用放在同一条回复里。"
            "之后每完成一项就再次调用 todo_write 更新状态：传入【完整】清单，"
            "把正在做的标为 in_progress（同一时刻最多一项）、做完的标为 completed、其余为 pending；"
            "任务全部完成后把每一项都标为 completed。这样用户能在界面上实时看到任务进度。"
            "判断标准：只要预计需要 3 个以上动作，就一定先建清单；只有简单的一两步任务才无需清单，"
            "也不要为了完成任务而虚构清单。"
        )
    if skill:
        sids = skill if isinstance(skill, list) else [skill]
        prompts = [_SKILL_PROMPTS.get(str(sid)) for sid in sids if _SKILL_PROMPTS.get(str(sid))]
        if prompts:
            base += "\n\n" + "\n\n".join(prompts)
    if extra_prompts:
        extra = [str(p).strip() for p in extra_prompts if str(p).strip()]
        if extra:
            header = "[本轮激活的自定义 Skill]"
            names = [str(n).strip() for n in (extra_names or []) if str(n).strip()]
            if names:
                header += "\n技能名称：" + "、".join(names)
            base += "\n\n" + header + "\n" + "\n\n".join(extra)
    return base


# 有些模型（商汤 SenseNova、部分开源权重）不走标准 tool_calls 字段，而是把调用写在
# 正文里：<tool_call><function=list_dir><parameter=path>app</parameter></function></tool_call>
# 这里做一层兼容解析，否则会出现「看着像在调工具、实际一步都没执行」。
_TEXT_CALL_RE = re.compile(r"<tool_call>(.*?)(?:</tool_call>|$)", re.S | re.I)
_TEXT_FUNC_RE = re.compile(r"<function[=:\s]+[\"']?([\w.\-]+)[\"']?\s*>(.*?)(?:</function>|$)", re.S | re.I)
_TEXT_ARG_RE = re.compile(r"<parameter[=:\s]+[\"']?([\w.\-]+)[\"']?\s*>(.*?)(?:</parameter>|(?=<parameter)|$)", re.S | re.I)
_TEXT_NAME_ATTR = re.compile(r"<(parameter|function)\s+name\s*=\s*[\"']([^\"']+)[\"']\s*>", re.I)
# Claude / 部分开源权重风格：<tool_use>{"type":"bash","command":"..."}</tool_use>
_TEXT_USE_RE = re.compile(r"<tool_use>(.*?)(?:</tool_use>|$)", re.S | re.I)
_TEXT_CALL_HINT = re.compile(r"<tool_calls?>|<tool_use>|<function[=:\s]|<parameter[=:\s]", re.I)


def _parse_text_calls(text):
    """从正文里解析文本格式的工具调用；解析不到返回 []。

    兼容三种写法：
      1) Claude 风格：<tool_use>{"type":"bash","command":"ls -la"}</tool_use>
      2) 商汤/开源权重：<tool_call><function=list_dir><parameter=path>app</parameter></function></tool_call>
      3) 整段回复就是一个 JSON 对象/数组（含 name/type + 参数）
    """
    if not text:
        return []
    out = []
    # ① <tool_use>{json}</tool_use>（可能出现多次）
    for um in _TEXT_USE_RE.finditer(text):
        obj = _loads_json(um.group(1).strip())
        if obj is None:
            continue
        for o in (obj if isinstance(obj, list) else [obj]):
            c = _call_from_obj(o)
            if c:
                out.append(c)
    if out:
        return _reindex_text_calls(out)
    # ② <function=...> XML 风格
    if _TEXT_CALL_HINT.search(text):
        blocks = _TEXT_CALL_RE.findall(text) or [text]
        for b in blocks:
            b = _TEXT_NAME_ATTR.sub(r"<\1=\2>", b)      # <parameter name="x"> → <parameter=x>
            for fm in _TEXT_FUNC_RE.finditer(b):
                name, body = fm.group(1).strip(), fm.group(2) or ""
                args = {}
                for am in _TEXT_ARG_RE.finditer(body):
                    key, raw = am.group(1).strip(), (am.group(2) or "").strip()
                    if not key:
                        continue
                    try:
                        args[key] = json.loads(raw)      # 数字/布尔/对象按 JSON 解析
                    except ValueError:
                        args[key] = raw.strip().strip("\"'").strip()
                if not name:
                    continue
                target, norm = _normalize_call(name, args)
                if not target:
                    target, norm = name, args
                out.append({"id": "", "name": target, "args": norm,
                            "args_raw": json.dumps(norm, ensure_ascii=False)})
    if out:
        return _reindex_text_calls(out)
    # ③ 整段回复就是 JSON（去掉代码块围栏后尝试）
    cand = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip(), flags=re.I).strip()
    obj = _loads_json(cand)
    if obj is not None:
        for o in (obj if isinstance(obj, list) else [obj]):
            c = _call_from_obj(o)
            if c:
                out.append(c)
    return _reindex_text_calls(out)


def _reindex_text_calls(calls):
    for i, c in enumerate(calls):
        c["id"] = "textcall_%d" % i
    return calls


def _stream_model(provider, model, convo, tools=None):
    """调用模型（流式，带工具定义）：yield SSE 事件，返回 (文本, 工具调用列表)。"""
    base = provider["base_url"].rstrip("/")
    url = base if base.endswith("/chat/completions") else base + "/chat/completions"
    body = {"model": model, "stream": True, "messages": convo,
            "tools": tools or _TOOLS, "tool_choice": "auto"}
    payload = json.dumps(body).encode("utf-8")
    u_in, u_out = 0, 0                    # 本轮请求的 token 用量，结束后交回外层统计
    req = urllib.request.Request(url, data=payload, method="POST", headers={
        "Content-Type": "application/json",
        "Authorization": "Bearer " + provider["api_key"],
        "Accept": "text/event-stream",
    })
    text, calls = "", {}
    attempt = 0
    while True:                                   # 限流 / 临时错误自动等待重试
        try:
            resp = _open_stream(req, url, _CONNECT_TIMEOUT, _READ_TIMEOUT)
        except urllib.error.HTTPError as e:
            try:
                detail = e.read().decode("utf-8", "replace")[:400]
            except OSError:
                detail = ""
            if _is_retryable_status(e.code) and attempt < _RETRY_MAX:
                wait = _retry_wait(attempt, e)
                attempt += 1
                text, calls = "", {}
                yield _sse({"type": "retry", "attempt": attempt, "wait": round(wait, 1), "reset": True,
                            "reason": "接口限流/暂不可用（HTTP %s）" % e.code})
                time.sleep(wait)
                continue
            if _is_retryable_status(e.code):
                yield _sse({"type": "error", "error": "接口返回 %s：已自动重试 %d 次仍未成功，可稍后重试；"
                                                     "若为 tpm/rpm 限流，请减少上下文后重试。详情：%s"
                                                     % (e.code, _RETRY_MAX, detail or e.reason)})
            else:
                yield _sse({"type": "error", "error": "接口返回 %s：%s" % (e.code, detail or e.reason)})
            return text, []
        except (socket.timeout, TimeoutError):
            if attempt < _RETRY_MAX:
                wait = _retry_wait(attempt)
                attempt += 1
                text, calls = "", {}
                yield _sse({"type": "retry", "attempt": attempt, "wait": round(wait, 1), "reset": True,
                            "reason": "连接接口超时"})
                time.sleep(wait)
                continue
            yield _sse({"type": "error", "error": "连接 AI 接口超时（%d 秒）：请检查接口地址与网络" % _CONNECT_TIMEOUT})
            return text, []
        except (urllib.error.URLError, OSError) as e:
            if attempt < _RETRY_MAX:
                wait = _retry_wait(attempt)
                attempt += 1
                text, calls = "", {}
                yield _sse({"type": "retry", "attempt": attempt, "wait": round(wait, 1), "reset": True,
                            "reason": "网络异常，重试中"})
                time.sleep(wait)
                continue
            yield _sse({"type": "error", "error": "无法连接 AI 接口：%s" % e})
            return text, []
        broken = None
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
                    emsg = str(obj["error"])
                    if _is_retryable_text(emsg):
                        broken = RuntimeError(emsg)
                        break
                    yield _sse({"type": "error", "error": emsg})
                    continue
                u = obj.get("usage")
                if isinstance(u, dict):                  # 末尾的 usage chunk（choices 通常为空）
                    try:
                        u_in += int(u.get("prompt_tokens") or 0)
                        u_out += int(u.get("completion_tokens") or 0)
                    except (TypeError, ValueError):
                        pass
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
        except (socket.timeout, TimeoutError) as e:
            broken = e or RuntimeError("读取超时")
        except (OSError, urllib.error.URLError) as e:
            broken = e
        finally:
            try:
                resp.close()
            except OSError:
                pass
        if broken is not None:
            if attempt < _RETRY_MAX:
                wait = _retry_wait(attempt)
                attempt += 1
                text, calls = "", {}
                yield _sse({"type": "retry", "attempt": attempt, "wait": round(wait, 1), "reset": True,
                            "reason": "接口限流/连接中断，自动重试"})
                time.sleep(wait)
                continue
            yield _sse({"type": "error",
                        "error": "接口限流或连接中断，已自动重试 %d 次仍未成功：%s" % (_RETRY_MAX, broken)})
            return text, []
        break
    if u_in or u_out:                        # 本轮 token 用量交给外层累加统计
        yield _sse({"type": "usage", "model": model,
                    "usage": {"prompt_tokens": u_in, "completion_tokens": u_out,
                              "context_tokens": u_in}})   # 本轮输入规模 = 当前上下文占用
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


def _run_tool_job(name, args, root, perm, ctx=None):
    """执行单个工具（会被线程池并发调用，只做纯函数式处理）。

    ctx 携带本次运行的接口 / 模型 / 权限等上下文（图片默认模型、子 Agent 复用等）。
    """
    if name == "delegate_task":                 # 子 Agent：在无流式上下文时丢弃中间事件，仅返回最终结果
        gen = _tool_delegate_task(args, root, perm, ctx)
        try:
            while True:
                next(gen)
        except StopIteration as e:
            return e.value
        return False, "子 Agent 异常", "", "子 Agent 未返回结果"
    fn = _TOOL_FUNCS.get(name)
    if fn is None:
        return False, "未知工具：%s" % name, "", "未知工具：%s" % name
    try:
        # 仅把 ctx 传给声明了该参数的处理器（如 generate_image / code_intel）
        nargs = getattr(fn, "__code__", None)
        nargs = nargs.co_argcount if nargs is not None else 3
        if nargs >= 4:
            return fn(args, root, perm, ctx)
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


def _run_agent(run_id, provider, model, root, perm, msgs, skills=None, extra_prompts=None, extra_names=None,
               auto_run="safe", task_list=True, web_tool=True, web_auto=True, max_steps=0, max_steps_sub=0,
               image_tool=True, lsp_tool=True, allow_sub=True, image_model=""):
    convo = [{"role": "system", "content": _agent_system(root, perm, skills, extra_prompts, extra_names,
                                                         task_list, web_tool, image_tool, lsp_tool, allow_sub)}] + msgs
    tool_list = [t for t in _TOOLS
                 if (web_tool or t["function"]["name"] != "web_search")
                 and (image_tool or t["function"]["name"] != "generate_image")
                 and (lsp_tool or t["function"]["name"] != "code_intel")
                 and (task_list or t["function"]["name"] != "todo_write")
                 and (allow_sub or t["function"]["name"] != "delegate_task")]
    # 本次运行的上下文（供 delegate_task 子 Agent 复用同一接口 / 模型 / 权限）
    _ctx = {"provider": provider, "model": model, "auto_run": auto_run, "web_auto": web_auto,
            "web_tool": web_tool, "image_tool": image_tool, "lsp_tool": lsp_tool,
            "task_list": task_list, "max_steps_sub": max_steps_sub, "image_model": image_model,
            "perm": perm, "root": root}
    always_allow = set()
    rounds_tool_idx = []                 # 每轮追加的 tool 消息下标，用于上下文裁剪
    todo_seen = False                    # 本场运行模型是否已用过 todo_write
    todo_remind_round = 0                # 上次提醒模型建任务清单的轮次（0 = 还没提醒过）
    _round = 0
    # max_steps：主 Agent 最大工具轮数（0 = 不限制）；max_steps_sub：子 Agent 的最大步数（0 = 不限制）。
    while True:                          # 模型不再发起调用即自然结束
        _round += 1
        if max_steps and _round > max_steps:
            yield _sse({"type": "error",
                        "error": "已达到「最大步数（主 Agent）」上限（%d 步），已自动停止；"
                                 "可在 设置 → 对话 → Agent 中调整。" % max_steps})
            return
        result = yield from _stream_model(provider, model, convo, tool_list)
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
            if name == "todo_write":
                todo_seen = True
            yield _sse({"type": "step", "call_id": c["id"], "tool": name, "args": args})
            allowed, refuse, need_ask, ask_reason = _gate(perm, name, args, root, auto_run, web_auto)
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
                    futs[pool.submit(_run_tool_job, job["c"]["name"], job["c"]["args"], root, perm, _ctx)] = (
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
            if name == "delegate_task":                 # 子 Agent：实时转发内部事件，再回最终结果
                t_start = time.time()
                gen = _tool_delegate_task(args, root, perm, _ctx)
                try:
                    while True:
                        ev = next(gen)
                        yield _sse({"type": "subagent", "call_id": c["id"], "event": ev})
                except StopIteration as e:
                    ok, summary, detail, model_text = e.value
                    ms = int((time.time() - t_start) * 1000)
                    done[c["id"]] = (ok, summary, detail, model_text, ms, False)
                    _log.info("Agent 工具（子 Agent）：%s → %s（%dms）", c["name"],
                              "ok" if ok else "fail", ms)
                    yield _sse({"type": "result", "call_id": c["id"], "tool": "delegate_task", "ok": ok,
                                "summary": summary, "detail": detail, "ms": ms})
                continue
            t_start = time.time()
            if job["ask"] and name not in always_allow:
                key = (run_id, c["id"])
                ev = threading.Event()
                box = {"allow": False, "always": False}
                with _PENDING_LOCK:
                    # cmd 供「全局允许」把这条命令写进命令安全的白名单（approve 接口读取）
                    _PENDING[key] = {"ev": ev, "box": box, "tool": name,
                                     "cmd": str(args.get("command") or "")}
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
            undo.begin()
            ok, summary, detail, model_text = _run_tool_job(name, args, root, perm, _ctx)
            changes = undo.finish(root)              # 推断动作类型 + 生成差异，供「文件变更」模块
            _record_run_changes(run_id, changes)     # 按 run_id 累计，供停止后补拉
            if name == "todo_write" and ok:           # 任务清单：实时推给前端渲染进度
                yield _sse({"type": "todos", "todos": _norm_todos(args.get("todos"))})
            ms = int((time.time() - t_start) * 1000)
            done[c["id"]] = (ok, summary, detail, model_text, ms, False)
            _log.info("Agent 工具：%s %s → %s（%dms）", name, json.dumps(args, ensure_ascii=False)[:200],
                      "ok" if ok else "fail", ms)
            yield _sse({"type": "result", "call_id": c["id"], "tool": name, "ok": ok,
                        "summary": summary, "detail": detail, "ms": ms,
                        "changes": changes or None})
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
        # 任务清单提醒：多步任务若模型迟迟不调用 todo_write，就在最近一条工具结果末尾追加系统提醒，
        # 促使它在界面上建立/更新任务清单（每 3 轮最多提醒一次，避免刷屏）。
        if task_list and not todo_seen:
            total_calls = sum(len(x) for x in rounds_tool_idx)
            if idxs and (total_calls >= 3 or _round >= 2) and \
                    (todo_remind_round == 0 or _round - todo_remind_round >= 3):
                convo[idxs[-1]]["content"] = (convo[idxs[-1]]["content"] or "") + _TODO_REMIND
                todo_remind_round = _round
        n_trim = _trim_convo(convo, rounds_tool_idx)
        if n_trim:
            _log.info("Agent 上下文裁剪：压缩了 %d 条较早轮次的工具结果（保留最近 %d 轮全文）",
                      n_trim, _RECENT_ROUNDS)


@bp.route("/api/ai/run-changes", methods=["POST"])
def api_run_changes():
    """按 run_id 补拉一场运行的累计文件变更（停止/中断后前端调用）。"""
    data = request.get_json(silent=True) or {}
    run_id = str(data.get("run_id") or "")
    with _PENDING_LOCK:
        changes = list(_RUN_CHANGES.get(run_id) or [])
    return jsonify({"ok": True, "changes": changes})


@bp.route("/api/ai/agent", methods=["POST"])
def api_ai_agent():
    cfg = _load_cfg()
    data = request.get_json(silent=True) or {}
    provider, model, err = _sys_pick(cfg, "agent")
    if err:
        return _sys_err_response(err, need_config=not cfg.get("providers"))
    provider, model = _override_pick(cfg, provider, model, data)

    msgs = data.get("messages") or []
    if not isinstance(msgs, list) or not msgs:
        return jsonify({"error": "messages 不能为空"}), 400

    # 自动运行模式（来自「设置 → 对话 → 自动运行模式」），默认 "safe"
    auto_run = data.get("auto_run") or "safe"
    if auto_run not in ("all", "safe", "ask"):
        auto_run = "safe"
    # 「设置 → 对话」中的 Agent 相关开关 / 步数
    task_list = data.get("task_list", True) is not False
    web_tool = data.get("web_tool", True) is not False
    web_auto = data.get("web_auto", True) is not False
    try:
        max_steps = int(data.get("max_steps") or 0)
    except (TypeError, ValueError):
        max_steps = 0
    if max_steps < 0:
        max_steps = 0
    try:
        max_steps_sub = int(data.get("max_steps_sub") or 0)
    except (TypeError, ValueError):
        max_steps_sub = 0
    image_tool = data.get("image_tool", True) is not False
    lsp_tool = data.get("lsp_tool", True) is not False
    image_model = str(data.get("image_model") or "").strip()
    clean = [{"role": str(m.get("role") or "user")[:16], "content": _clean_content(m.get("content"))}
             for m in msgs[:40]]
    _inject_system_time(clean)
    if data.get("web_search") and web_tool:
        _inject_web_search(clean)
    repo = str(data.get("repo") or "")
    root = os.path.abspath(repo) if repo and os.path.isdir(repo) else ""
    perm = str(data.get("perm") or "workspace")
    if perm not in ("readonly", "workspace", "full"):
        perm = "workspace"
    skills = data.get("skills") or data.get("skill") or None
    raw_extra = data.get("skill_prompts") or []
    extra_prompts = [str(p) for p in raw_extra if str(p).strip()] if isinstance(raw_extra, list) else []
    raw_names = data.get("skill_names") or []
    extra_names = [str(n) for n in raw_names if str(n).strip()] if isinstance(raw_names, list) else []
    run_id = uuid.uuid4().hex[:12]
    _log.info("Agent 启动：run=%s model=%s perm=%s root=%s msgs=%d skills=%s extra=%d",
              run_id, model, perm, root, len(clean),
              ",".join(skills) if isinstance(skills, list) else (skills or "-"), len(extra_prompts))

    user_query = _last_user_text(clean)
    # 闭包共享：本次实际用到的模型与 token 用量（_stream_model 每轮 yield 一次 usage 事件）；
    # texts 收集回复正文，供上游没给 usage 时按字数兜底估算
    usage_meta = {"model": model, "in": 0, "out": 0, "texts": []}

    def gen():
        yield _sse({"type": "run", "run_id": run_id, "perm": perm, "model": model, "root": root})
        # 通知：外层包装，捕捉 delta 文本；异常也会触发
        text_parts = usage_meta["texts"]       # 同一份列表：通知与用量估算共用
        inner = _run_agent(run_id, provider, model, root, perm, clean, skills, extra_prompts, extra_names,
                           auto_run, task_list, web_tool, web_auto, max_steps, max_steps_sub,
                           image_tool, lsp_tool, allow_sub=True, image_model=image_model)
        try:
            for chunk in inner:
                # 抽取 delta 文本（SSE 字节："data: {...}"）
                try:
                    txt = chunk.decode("utf-8") if isinstance(chunk, bytes) else str(chunk)
                    for line in txt.splitlines():
                        if not line.startswith("data: "):
                            continue
                        try:
                            obj = json.loads(line[6:])
                        except (ValueError, TypeError):
                            continue
                        if obj.get("type") == "delta":
                            t = obj.get("text")
                            if t:
                                text_parts.append(t)
                        elif obj.get("type") == "usage":
                            uu = obj.get("usage") or {}
                            try:
                                usage_meta["in"] += int(uu.get("prompt_tokens") or 0)
                                usage_meta["out"] += int(uu.get("completion_tokens") or 0)
                            except (TypeError, ValueError):
                                pass
                            if obj.get("model"):
                                usage_meta["model"] = str(obj["model"])
                except Exception:
                    pass
                yield chunk
        except Exception as e:  # noqa: BLE001
            _log.warning("Agent 异常：%s", e)
            yield _sse({"type": "error", "error": "智能体执行失败：%s" % e})
        finally:
            with _PENDING_LOCK:
                for k in [k for k in _PENDING if k[0] == run_id]:
                    _PENDING.pop(k, None)
            # 通知：智能体完成（不管成功/异常都发，让用户看到"任务已终止"）
            if text_parts:
                answer_text = "".join(text_parts)
            else:
                answer_text = ""
            _fire_notify_async("agent", user_query, answer_text)
            yield _sse({"type": "done"})

    def _gen_counted():
        """包一层用于统计调用次数（成功与否只有把流读完才知道）"""
        t0 = time.time()
        err = ""
        try:
            for chunk in gen():
                if not err and b'"error"' in (chunk or b""):
                    err = "接口返回错误"
                yield chunk
        except Exception as e:  # noqa: BLE001
            err = str(e)
            raise
        finally:
            if usage_meta["in"] or usage_meta["out"]:
                tin, tout, est = usage_meta["in"], usage_meta["out"], False
            else:                                    # 上游没给 usage：按字数兜底估算
                tin = _estimate_msgs(clean)
                tout = _estimate_tokens("".join(usage_meta["texts"]))
                est = True
            _log_ai_call("agent", not err, int((time.time() - t0) * 1000), err, model,
                         tin, tout, est, req=user_query, resp="".join(usage_meta["texts"]))

    return Response(_gen_counted(), mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@bp.route("/api/ai/agent/approve", methods=["POST"])
def api_ai_agent_approve():
    """批准 / 拒绝智能体待确认的工具调用。

    global=True（前端「全局允许」）：同意本次执行，并把这条命令写进「设置 → 命令安全」的
    全局放行名单，之后在任何项目里遇到同一条命令都直接执行、不再弹确认。
    """
    data = request.get_json(silent=True) or {}
    key = (str(data.get("run_id") or ""), str(data.get("call_id") or ""))
    with _PENDING_LOCK:
        st = _PENDING.get(key)
    if not st:
        return jsonify({"error": "该确认已失效（可能已超时或已处理）"}), 404
    allow = bool(data.get("allow"))
    st["box"]["allow"] = allow
    st["box"]["always"] = bool(data.get("always"))
    added, warn = False, ""
    if allow and data.get("global"):
        cmd = str(st.get("cmd") or "").strip()
        if cmd:
            _sel, err = cmdguard.add_allow(cmd)
            if err:
                warn = err
            else:
                added = True
                _log.info("命令已加入全局放行名单：%s", cmd[:200])
    st["ev"].set()
    return jsonify({"ok": True, "allow": allow, "global_added": added, "warn": warn})

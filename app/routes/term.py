"""内置终端：在服务器上执行 shell 命令（会话内保持工作目录）。

POST /api/term/open   {cwd}             新建终端会话，返回会话 id 与工作目录
POST /api/term/exec   {id, command}     执行命令，返回输出与退出码（支持 cd 持久化）
POST /api/term/kill   {id}              终止当前正在执行的命令
POST /api/term/close  {id}              关闭会话

说明：这里不是真正的 PTY 交互式终端（不支持 vim/top 这类依赖 TTY 的全屏程序），
而是「命令 + 输出」模式，足以覆盖 git / npm / ls 等日常操作。
若需要真正的交互式终端，请把 config.ENABLE_EXEC 关闭后自行接入 web terminal。
"""
import getpass
import os
import shlex
import signal
import socket
import subprocess
import threading
import time
import uuid

from flask import Blueprint, request, jsonify

from .. import config
from ..log import get_logger
from ..services.safety import check_command, rules_summary


_log = get_logger()
bp = Blueprint("term", __name__)

_MAX_OUTPUT = 200 * 1024
_DEFAULT_TIMEOUT = 60
_MAX_TIMEOUT = 600
_SESSION_TTL = 6 * 3600

_SESSIONS = {}
_LOCK = threading.Lock()

# 每条命令执行前注入：让 ls / grep 等默认带颜色（模拟真实终端）
# 用函数而非 alias：alias 在解析期展开，同一段 -c 脚本里定义后不会立即生效
_PRELUDE = (
    "ls() { command ls --color=always \"$@\"; }; "
    "ll() { command ls -alF --color=always \"$@\"; }; "
    "la() { command ls -A --color=always \"$@\"; }; "
    "l() { command ls -CF --color=always \"$@\"; }; "
    "grep() { command grep --color=always \"$@\"; }; "
)


def _term_env() -> dict:
    """终端环境：彩色输出 + 禁用分页器（避免 git log 之类卡住）。

    同时合并「运行环境」面板里配置的自定义环境变量，并把自定义解释器目录前置到 PATH。
    """
    from ..services import envprobe
    env = envprobe.apply_custom_env(dict(os.environ))
    env.update({
        "TERM": "xterm-256color",
        "CLICOLOR_FORCE": "1",
        "PAGER": "cat",
        "GIT_PAGER": "cat",
        "GIT_TERMINAL_PROMPT": "0",
    })
    return env


def _fail(msg, code=400):
    return jsonify({"error": msg}), code


def _exec_allowed():
    return bool(getattr(config, "ENABLE_EXEC", True))


def _cleanup() -> None:
    """清理过期会话（惰性调用，避免额外线程）。"""
    now = time.time()
    with _LOCK:
        for sid in [k for k, v in _SESSIONS.items() if now - v["created"] > _SESSION_TTL]:
            _SESSIONS.pop(sid, None)


def _kill_proc(proc) -> None:
    if proc is None or proc.poll() is not None:
        return
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
    except OSError:
        try:
            proc.terminate()
        except OSError:
            pass
    try:
        proc.wait(timeout=3)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except OSError:
            pass


@bp.route("/api/term/open", methods=["POST"])
def api_term_open():
    if not _exec_allowed():
        return _fail("已禁用命令执行（config.ENABLE_EXEC = False）", 403)
    data = request.get_json(silent=True) or {}
    cwd = (data.get("cwd") or "").strip() or os.path.expanduser("~")
    if not os.path.isdir(cwd):
        return _fail("目录不存在")
    cwd = os.path.abspath(cwd)
    sid = uuid.uuid4().hex[:16]
    _cleanup()
    with _LOCK:
        _SESSIONS[sid] = {"cwd": cwd, "proc": None, "created": time.time()}
    _log.info("POST /api/term/open cwd=%s id=%s", cwd, sid)
    try:
        user = getpass.getuser()
    except Exception:
        user = os.environ.get("USER", "user")
    return jsonify({
        "ok": True, "id": sid, "cwd": cwd, "shell": "/bin/bash",
        "user": user,
        "host": socket.gethostname(),
        "home": os.path.expanduser("~"),
    })


@bp.route("/api/term/check", methods=["POST"])
def api_term_check():
    """只做安全校验，不执行（前端输入时提前提示）。"""
    data = request.get_json(silent=True) or {}
    return jsonify(check_command((data.get("command") or "")))


@bp.route("/api/term/rules")
def api_term_rules():
    """返回当前命令安全策略，供界面展示。"""
    return jsonify(rules_summary())


@bp.route("/api/term/exec", methods=["POST"])
def api_term_exec():
    if not _exec_allowed():
        return _fail("已禁用命令执行（config.ENABLE_EXEC = False）", 403)
    data = request.get_json(silent=True) or {}
    sid = data.get("id") or ""
    command = (data.get("command") or "").strip()
    with _LOCK:
        sess = _SESSIONS.get(sid)
    if sess is None:
        return _fail("终端会话已失效，请重新打开终端", 404)
    if not command:
        return _fail("命令不能为空")

    # 危险命令防护：服务端强制校验（前端二次确认只能作为体验优化，不能作为唯一防线）
    verdict = check_command(command)
    if verdict["level"] == "blocked":
        _log.warning("拦截危险命令: %s（%s）", command[:120], verdict["reason"])
        return jsonify({
            "error": f"已拦截危险命令：{verdict['reason']}",
            "blocked": True, "reason": verdict["reason"], "part": verdict["part"],
        }), 403
    if verdict["level"] == "confirm" and not data.get("force"):
        return jsonify({
            "error": f"该命令有一定风险，需要确认后执行：{verdict['reason']}",
            "need_confirm": True, "reason": verdict["reason"], "part": verdict["part"],
        }), 409

    try:
        timeout = int(data.get("timeout") or _DEFAULT_TIMEOUT)
    except (TypeError, ValueError):
        timeout = _DEFAULT_TIMEOUT
    timeout = max(1, min(_MAX_TIMEOUT, timeout))

    cwd = sess["cwd"]
    # 在子 shell 中先 cd 到会话目录，执行完再回传 $PWD，实现 cd 持久化
    script = (_PRELUDE + "cd " + shlex.quote(cwd) + " && { " + command +
              "\n}; printf '\\n__CWD__%s' \"$PWD\"")
    t0 = time.monotonic()
    try:
        proc = subprocess.Popen(["bash", "-lc", script], cwd=cwd, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, stdin=subprocess.DEVNULL,
                                env=_term_env(), preexec_fn=os.setsid)
    except OSError as e:
        return _fail(f"启动命令失败：{e}", 500)

    with _LOCK:
        sess["proc"] = proc
    timed_out = False
    try:
        out, err = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        timed_out = True
        _kill_proc(proc)
        try:
            out, err = proc.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            out, err = b"", b""
    finally:
        with _LOCK:
            sess["proc"] = None

    stdout = (out or b"")[:_MAX_OUTPUT].decode("utf-8", "replace")
    stderr = (err or b"")[:_MAX_OUTPUT].decode("utf-8", "replace")
    if len(out or b"") > _MAX_OUTPUT or len(err or b"") > _MAX_OUTPUT:
        stderr += "\n（输出过多，已截断）"

    # 取出末尾的工作目录标记并更新会话状态
    marker = "__CWD__"
    idx = stdout.rfind(marker)
    if idx >= 0:
        new_cwd = stdout[idx + len(marker):].strip()
        stdout = stdout[:idx]
        if new_cwd and os.path.isdir(new_cwd):
            sess["cwd"] = new_cwd
    stdout = stdout.rstrip("\n")

    return jsonify({
        "ok": (not timed_out) and proc.returncode == 0,
        "exit_code": None if timed_out else proc.returncode,
        "stdout": stdout,
        "stderr": stderr,
        "cwd": sess["cwd"],
        "duration": round(time.monotonic() - t0, 2),
        "timed_out": timed_out,
        "error": f"执行超时（超过 {timeout}s），已终止" if timed_out else None,
    })


@bp.route("/api/term/kill", methods=["POST"])
def api_term_kill():
    data = request.get_json(silent=True) or {}
    with _LOCK:
        sess = _SESSIONS.get(data.get("id") or "")
    if sess is None:
        return _fail("终端会话已失效", 404)
    proc = sess.get("proc")
    if proc is None or proc.poll() is not None:
        return jsonify({"ok": True, "killed": False})
    _kill_proc(proc)
    return jsonify({"ok": True, "killed": True})


@bp.route("/api/term/close", methods=["POST"])
def api_term_close():
    data = request.get_json(silent=True) or {}
    sid = data.get("id") or ""
    with _LOCK:
        sess = _SESSIONS.pop(sid, None)
    if sess:
        _kill_proc(sess.get("proc"))
    return jsonify({"ok": True})

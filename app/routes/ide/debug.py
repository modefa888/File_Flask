"""调试运行：在服务器端用 pdb 交互式调试当前 Python 文件。

与 /api/run（普通运行）的区别：普通运行把 stdin 接到 DEVNULL、输出直接写日志文件；
调试运行把子进程的 stdin/stdout/stderr 全接到一个 PTY，这样 pdb 才会进入交互式
命令行（`(Pdb)` 提示符），前端可以把 `n / s / c / p / b / q` 等命令写回这个 PTY。

GET  /api/debug/sessions                    调试会话列表（刷新页面后接回用）
POST /api/debug/start   {path, args, breakpoints[]}  启动 pdb，返回会话 id
GET  /api/debug/log?id=&offset=             增量输出 + 状态（轮询兜底）
GET  /api/debug/stream?id=&offset=          SSE 实时输出（首选），结束后推 done=true
POST /api/debug/input   {id, command}       向 pdb 发送一行（或多行）命令
POST /api/debug/interrupt {id}              发送 SIGINT（中断正在执行的长循环）
POST /api/debug/stop    {id}                终止整个调试进程组

实现要点：
- 会话在内存中，输出按「块」保存（pdb 的 `(Pdb) ` 提示符不带换行，按行切会丢提示符）；
  offset 是全局块序号，裁剪旧块时同步推进 base，所以前端断线重连用同一个 offset 不会错位；
- SSE 用 Condition 阻塞等待新输出，15s 无输出发心跳，进程结束推最后一帧后关闭；
- 启动断点：pdb 会在脚本第一行停下，等第一个提示符出现后把 `b 文件:行号` 与 `c`
  逐条写入 PTY，等价于用户在调试控制台手动敲了一遍；
- 进程用 os.setsid() 独立进程组，停止 / 中断直接对整个进程组发信号。

注意：pdb 的 `!` 与 `interact` 能执行任意 Python 代码，本模块与 /api/run 一样只应在
受信任环境使用；config.ENABLE_EXEC = False 时全部启动接口返回 403。
"""
import codecs
import errno
import json
import os
import re
import select
import shlex
import signal
import subprocess
import threading
import time
import uuid

try:
    import pty
except ImportError:                                   # Windows 无 pty，启动时明确报错
    pty = None

from flask import Blueprint, jsonify, request, Response

from ... import config
from ...log import get_logger
from ...services.ide import envprobe
from .run import _project_runtime                    # 复用 .venv 解析，保持与 F5 运行一致


_log = get_logger()
bp = Blueprint("debug", __name__)

_SESSIONS = {}
_LOCK = threading.RLock()
_MAX_SESSIONS = 8                                    # 同时保留的会话数（含已结束的）
_SESSION_TTL = 2 * 3600                              # 已结束会话的保留时长
_MAX_CHUNKS = 3000                                   # 单个会话保留的输出块数
_CHUNK_MAX = 64 * 1024                               # 单块最大字符数
_CMD_MAX = 4096                                      # 单次输入上限
_PROMPT_TAIL = re.compile(r"\((?:Pdb\+*|ipdb)\)\s*$")
_PROMPT_ANY = re.compile(r"\((?:Pdb\+*|ipdb)\)")


def _fail(msg, code=400):
    return jsonify({"error": msg}), code


class _Session:
    """一个 pdb 调试会话：PTY fd + 子进程 + 可增量读取的输出缓冲。"""

    def __init__(self, sid, target, cmd, cwd, breakpoints):
        self.id = sid
        self.target = target
        self.cmd = cmd
        self.cwd = cwd
        self.breakpoints = breakpoints
        self.pid = 0
        self.proc = None
        self.fd = -1
        self.chunks = []
        self.base = 0                                # 已丢弃的旧块数量
        self.rev = 0                                 # 输出版本号（SSE 等待用）
        self.cond = threading.Condition()
        self.io_lock = threading.Lock()
        self.tail = ""                               # 最近输出尾部，用于识别 (Pdb) 提示符
        self.paused = False                          # 是否停在 pdb 提示符
        self.bootstrapped = False                    # 启动断点是否已注入
        self.done = False
        self.exit_code = None
        self.error = ""
        self.started_at = time.time()
        self.last_active = self.started_at

    def append(self, text):
        """往输出缓冲追加一块文本，并更新「是否停在提示符」状态。"""
        text = text.replace("\r\n", "\n").replace("\r", "")
        if not text:
            return
        with self.cond:
            self.chunks.append(text[:_CHUNK_MAX])
            if len(self.chunks) > _MAX_CHUNKS:
                drop = len(self.chunks) - _MAX_CHUNKS
                del self.chunks[:drop]
                self.base += drop
            self.tail = (self.tail + text)[-120:]
            self.paused = bool(_PROMPT_TAIL.search(self.tail))
            self.rev += 1
            self.cond.notify_all()

    def snapshot(self, offset):
        """取 offset 之后的增量输出，返回 (chunks, 新 offset, rev)。"""
        with self.cond:
            start = max(0, offset - self.base)
            return list(self.chunks[start:]), self.base + len(self.chunks), self.rev

    def wait(self, rev, timeout):
        """阻塞到有新输出 / 会话结束；超时返回 False（用于发 SSE 心跳）。"""
        with self.cond:
            if self.done or self.rev != rev:
                return True
            self.cond.wait(timeout)
            return self.done or self.rev != rev

    def payload(self, chunks, offset):
        return {
            "id": self.id, "chunks": chunks, "offset": offset,
            "done": self.done, "running": not self.done,
            "exit_code": self.exit_code, "paused": self.paused,
            "bootstrapped": self.bootstrapped, "error": self.error,
            "pid": self.pid, "target": self.target, "cwd": self.cwd,
            "command": " ".join(self.cmd), "breakpoints": list(self.breakpoints),
            "duration": round(time.time() - self.started_at, 2),
        }

    def write(self, line):
        """把一行命令写入 PTY（pdb 从 stdin 读走）。"""
        with self.io_lock:
            if self.done or self.fd < 0:
                return False
            try:
                os.write(self.fd, (line + "\n").encode("utf-8"))
                self.last_active = time.time()
                return True
            except OSError as e:
                _log.debug("调试会话写入失败 id=%s: %s", self.id, e)
                return False

    def close_fd(self):
        with self.io_lock:
            if self.fd >= 0:
                try:
                    os.close(self.fd)
                except OSError:
                    pass
                self.fd = -1

    def finish(self, exit_code=None):
        with self.cond:
            if self.done:
                return
            self.done = True
            self.paused = False
            self.exit_code = exit_code if exit_code is not None else -1
            self.rev += 1
            self.cond.notify_all()
        self.close_fd()


def _get(sid):
    if not sid:
        return None
    with _LOCK:
        return _SESSIONS.get(sid)


def _gc():
    """清理过期会话，避免长时间开着 IDE 累积 PTY / 输出缓冲。"""
    now = time.time()
    with _LOCK:
        for sid, s in list(_SESSIONS.items()):
            if s.done and now - s.last_active > _SESSION_TTL:
                s.close_fd()
                _SESSIONS.pop(sid, None)


def _reader(s):
    """读线程：把 PTY 输出解码后写入会话缓冲；进程退出时做最后一次 drain。"""
    fd = s.fd
    decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
    while True:
        if s.done or s.fd != fd:                     # 被 stop 关掉：立刻退出，别再 select 可能已被复用的 fd
            break
        try:
            ready, _, _ = select.select([fd], [], [], 0.2)
            if ready:
                data = os.read(fd, 4096)
                if not data:
                    break
                s.append(decoder.decode(data))
                continue
        except (OSError, ValueError) as e:            # EIO：slave 关闭（进程退出）时的正常表现
            if isinstance(e, OSError) and e.errno not in (errno.EIO, errno.EBADF, errno.ENXIO):
                _log.debug("调试会话读取异常 id=%s: %s", s.id, e)
            break
        if s.proc is not None and s.proc.poll() is not None:
            for _ in range(10):                     # 退出前把残留输出读完
                try:
                    ready, _, _ = select.select([fd], [], [], 0.05)
                    if not ready:
                        break
                    data = os.read(fd, 4096)
                except (OSError, ValueError):
                    break
                if not data:
                    break
                s.append(decoder.decode(data))
            break
    try:
        s.append(decoder.decode(b"", final=True))
    except Exception:
        pass
    code = s.proc.poll() if s.proc is not None else None
    s.finish(code if code is not None else -1)
    s.last_active = time.time()


def _bootstrap(s, lines):
    """等 pdb 停在第一行后，注入断点命令并 continue。

    PTY 是行缓冲的：pdb 还没启动时写入的命令也会留在 tty 输入队列里，不会丢，
    因此这里用固定短延时即可，不需要解析输出去等提示符。
    """
    time.sleep(0.4)
    for line in lines:
        if s.done or not s.write(line):
            break
        time.sleep(0.08)
    s.bootstrapped = True


def _signal_group(s, sig):
    try:
        os.killpg(os.getpgid(s.proc.pid), sig)
        return True
    except (OSError, AttributeError):
        try:
            s.proc.send_signal(sig)
            return True
        except Exception:
            return False


# ======================================================================
# 接口
# ======================================================================
@bp.route("/api/debug/sessions")
def api_debug_sessions():
    """列出会话（前端刷新后按 id 接回正在调试的会话）。"""
    _gc()
    with _LOCK:
        items = [{
            "id": s.id, "target": s.target, "pid": s.pid,
            "running": not s.done, "paused": s.paused, "exit_code": s.exit_code,
            "started_at": s.started_at, "breakpoints": list(s.breakpoints),
        } for s in _SESSIONS.values()]
    items.sort(key=lambda x: x["started_at"], reverse=True)
    return jsonify({"ok": True, "sessions": items})


@bp.route("/api/debug/start", methods=["POST"])
def api_debug_start():
    if not getattr(config, "ENABLE_EXEC", True):
        return _fail("已禁用代码执行（config.ENABLE_EXEC = False）", 403)
    if pty is None:
        return _fail("当前系统不支持 PTY，无法启动交互式调试", 501)
    data = request.get_json(silent=True) or {}
    target = (data.get("path") or "").strip()
    if not target or not os.path.isfile(target):
        return _fail("文件不存在")
    ext = os.path.splitext(target)[1].lower().lstrip(".")
    if ext != "py":
        return _fail("调试运行目前仅支持 .py 文件（其它语言请用 F5 运行）")

    exe = envprobe.resolve_exe("python3") or "python3"
    proj_exe, path_prepend, _ = _project_runtime(target, "python3")
    if proj_exe:
        exe = proj_exe

    raw_args = data.get("args") or []
    if isinstance(raw_args, str):
        try:
            raw_args = shlex.split(raw_args)
        except ValueError:
            raw_args = raw_args.split()
    raw_args = [str(a) for a in raw_args][:64]

    raw_bp = data.get("breakpoints") or []
    if isinstance(raw_bp, str):
        raw_bp = raw_bp.replace(",", " ").split()
    breakpoints = []
    for item in raw_bp:
        try:
            n = int(item)
        except (TypeError, ValueError):
            continue
        if 1 <= n <= 1000000 and n not in breakpoints:
            breakpoints.append(n)
        if len(breakpoints) >= 50:
            break

    _gc()
    with _LOCK:
        if len(_SESSIONS) >= _MAX_SESSIONS:
            return _fail("调试会话过多，请先停止旧的调试（页面「调试」面板点停止）", 429)

    cwd = os.path.dirname(os.path.abspath(target)) or "."
    cmd = [exe, "-u", "-m", "pdb", target] + raw_args
    env = envprobe.apply_custom_env(os.environ.copy())
    env["PYTHONUNBUFFERED"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    env["TERM"] = "dumb"                             # 关掉 readline 的花哨转义，输出更干净
    env["FORCE_COLOR"] = "0"
    if path_prepend:
        env["PATH"] = path_prepend + os.pathsep + env.get("PATH", "")

    try:
        master, slave = pty.openpty()
        proc = subprocess.Popen(
            cmd, cwd=cwd, env=env,
            stdin=slave, stdout=slave, stderr=slave,
            preexec_fn=os.setsid, close_fds=True,
        )
        os.close(slave)
    except Exception as e:
        _log.warning("启动调试会话失败: %s", e)
        return _fail("启动调试失败：" + str(e), 500)

    sid = uuid.uuid4().hex[:12]
    s = _Session(sid, target, cmd, cwd, breakpoints)
    s.fd = master
    s.proc = proc
    s.pid = proc.pid
    with _LOCK:
        _SESSIONS[sid] = s
    threading.Thread(target=_reader, args=(s,), daemon=True).start()

    boot = ["b " + target + ":" + str(n) for n in breakpoints]
    if breakpoints:
        boot.append("c")                             # 有断点才自动继续；无断点则停在入口
    if boot:
        threading.Thread(target=_bootstrap, args=(s, boot), daemon=True).start()
    else:
        s.bootstrapped = True

    _log.info("POST /api/debug/start file=%s pid=%s breakpoints=%s", target, proc.pid, breakpoints)
    return jsonify({
        "ok": True, "id": sid, "pid": proc.pid, "pdb": True,
        "command": " ".join(cmd), "cwd": cwd,
        "target": target, "breakpoints": breakpoints,
    })


@bp.route("/api/debug/log")
def api_debug_log():
    """增量输出 + 状态（SSE 不可用时的轮询兜底，也用于刷新接回）。"""
    s = _get((request.args.get("id") or "").strip())
    if not s:
        return _fail("调试会话不存在或已过期", 404)
    try:
        offset = max(0, int(request.args.get("offset") or 0))
    except ValueError:
        offset = 0
    chunks, off, _ = s.snapshot(offset)
    s.last_active = time.time()
    return jsonify(s.payload(chunks, off))


@bp.route("/api/debug/stream")
def api_debug_stream():
    """SSE 实时输出：一条长连接推完整个调试过程，15s 无输出发心跳。"""
    s = _get((request.args.get("id") or "").strip())
    if not s:
        return _fail("调试会话不存在或已过期", 404)
    try:
        off = max(0, int(request.args.get("offset") or 0))
    except ValueError:
        off = 0

    def gen():
        yield ": connected\n\n"
        while True:
            chunks, off2, rev = s.snapshot(off)
            off = off2
            if chunks or s.done:
                yield "data: " + json.dumps(s.payload(chunks, off), ensure_ascii=False) + "\n\n"
                if s.done:
                    return
            if not s.wait(rev, 15.0):
                yield ": ping\n\n"

    return Response(gen(), mimetype="text/event-stream", headers={
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
        "Connection": "keep-alive",
    })


@bp.route("/api/debug/input", methods=["POST"])
def api_debug_input():
    """向 pdb 发送命令。command 可含换行（一次多行）；\u0003 视为 Ctrl+C。"""
    data = request.get_json(silent=True) or {}
    s = _get((data.get("id") or "").strip())
    if not s:
        return _fail("调试会话不存在或已过期", 404)
    if s.done:
        return _fail("调试会话已结束")
    command = str(data.get("command") or "")[:_CMD_MAX]
    if not command.strip():
        return _fail("命令为空")
    if "\u0003" in command:
        return api_debug_interrupt_impl(s)
    lines = command.replace("\r\n", "\n").replace("\r", "\n").split("\n")[:20]
    sent = 0
    for line in lines:
        if not line.strip():
            continue
        if not s.write(line):
            break
        sent += 1
    return jsonify({"ok": sent > 0, "sent": sent})


def api_debug_interrupt_impl(s):
    """SIGINT 给整个进程组：pdb 会中断当前执行并回到 (Pdb) 提示符。"""
    if s.done:
        return _fail("调试会话已结束")
    killed = _signal_group(s, signal.SIGINT)
    return jsonify({"ok": killed, "interrupted": killed})


@bp.route("/api/debug/interrupt", methods=["POST"])
def api_debug_interrupt():
    data = request.get_json(silent=True) or {}
    s = _get((data.get("id") or "").strip())
    if not s:
        return _fail("调试会话不存在或已过期", 404)
    return api_debug_interrupt_impl(s)


@bp.route("/api/debug/stop", methods=["POST"])
def api_debug_stop():
    data = request.get_json(silent=True) or {}
    s = _get((data.get("id") or "").strip())
    if not s:
        return jsonify({"ok": True, "already_done": True})
    if s.done:
        return jsonify({"ok": True, "already_done": True})
    _signal_group(s, signal.SIGTERM)

    def _force_kill():
        if s.proc is not None and s.proc.poll() is None:
            _signal_group(s, signal.SIGKILL)

    timer = threading.Timer(2.0, _force_kill)
    timer.daemon = True
    timer.start()
    s.finish(s.proc.poll() if s.proc.poll() is not None else -1)
    s.last_active = time.time()
    _log.info("POST /api/debug/stop id=%s pid=%s", s.id, s.pid)
    return jsonify({"ok": True, "killed": True})

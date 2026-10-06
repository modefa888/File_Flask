"""运行代码：按文件扩展名调用本机解释器执行，返回输出。

GET  /api/run/runtimes                      可用运行时列表（供面板展示）
POST /api/run  {path, args[], timeout}       前台运行：立即返回任务 id，日志实时推送，超时按 config 处理
POST /api/run  {path, args[], background:1}  后台运行：立即返回任务 id（适合 Web 服务等常驻程序）
GET  /api/run/stream?id=&offset=             SSE 实时日志流（首选，单条长连接、服务端主动推送）
GET  /api/run/log?id=&offset=                增量日志 + 状态（轮询兜底，SSE 不可用时使用）
GET  /api/run/tasks                          所有运行任务（含已结束，供后台任务管理面板使用）
POST /api/run/stop   {id}                    终止任务（整个进程组）
POST /api/run/remove {id}                    移除一条已结束的任务记录（连同日志文件）
POST /api/run/prune                          清理全部已结束的任务记录

持久化设计（这是「后台任务管理」的基础）：
- 子进程的 stdout/stderr 直接写入 data/run_logs/<task-id>.log：日志可回溯，
  且服务进程退出后子进程也不会因管道断开（EPIPE）而崩溃；
- 任务注册表写入 data/storage/.file_runner_tasks.json：服务 / 页面重启后仍能看到任务，
  对仍然存活的进程会自动「重新接管」，继续跟踪日志；
- 因此关掉浏览器页面、甚至重启本服务，后台程序都照常在跑。

注意：该接口会在服务器所在机器上执行代码，仅应在受信任的环境中使用。
"""
import json
import os
import shlex
import shutil
import signal
import subprocess
import threading
import time
import uuid

from flask import Blueprint, request, jsonify, Response

from ...log import get_logger
from ...services.common.store_db import store_conn, store_tx, migrate_legacy_list


_log = get_logger()
bp = Blueprint("run", __name__)


def _timeout_limits() -> tuple:
    """前台运行超时（秒）：默认值与上限均可在 config.py 中调整。"""
    from ... import config
    d = int(getattr(config, "RUN_TIMEOUT", 30) or 30)
    m = int(getattr(config, "RUN_TIMEOUT_MAX", 300) or 300)
    return max(1, d), max(d, m)


def _timeout_action() -> str:
    """前台超时后的动作：config.RUN_TIMEOUT_ACTION（background / kill）。"""
    from ... import config
    act = str(getattr(config, "RUN_TIMEOUT_ACTION", "background") or "background").lower()
    return act if act in ("background", "kill") else "background"


# 扩展名 → (解释器, 显示名)。解释器需存在于 PATH 中。
_RUNNERS = {
    "py": ("python3", "Python 3"),
    "js": ("node", "Node.js"),
    "mjs": ("node", "Node.js"),
    "cjs": ("node", "Node.js"),
    "sh": ("bash", "Bash"),
    "bash": ("bash", "Bash"),
    "rb": ("ruby", "Ruby"),
    "php": ("php", "PHP"),
    "pl": ("perl", "Perl"),
    "lua": ("lua", "Lua"),
    "r": ("Rscript", "R"),
}


def _fail(msg, code=400):
    return jsonify({"error": msg}), code


# ======================================================================
# 任务存储：日志文件 + JSON 注册表（持久化，跨页面 / 跨服务重启）
# ======================================================================
_RUN_DIR_NAME = "run_logs"                    # 日志目录（位于 data/ 下）
_REG_NAME = ".file_runner_tasks.json"         # 任务注册表
_TASK_TTL = 6 * 3600                          # 已结束记录保留时长（自动清理）
_MAX_LINES = 4000                             # 每个任务内存中保留的最大行数
_LINE_MAX = 4000                              # 单行最大长度

_TASKS = {}                                   # id -> _BgTask
_LOCK = threading.Lock()                      # 保护 _TASKS 与注册表文件
_loaded = False                               # 是否已从磁盘载入
_load_lock = threading.Lock()


def _data_root() -> str:
    from ... import config
    return config._DATA_ROOT


def _log_dir() -> str:
    d = os.path.join(_data_root(), _RUN_DIR_NAME)
    os.makedirs(d, exist_ok=True)
    return d


def _log_path(tid: str) -> str:
    return os.path.join(_log_dir(), tid + ".log")


def _reg_path() -> str:
    from ... import config
    return os.path.join(config._STORAGE_DIR, _REG_NAME)


def _read_registry() -> list:
    """运行任务注册表（一行一个任务，record 为任务字段 JSON）。"""
    try:
        conn = store_conn()
        try:
            rows = conn.execute("SELECT record FROM runner_tasks ORDER BY seq ASC").fetchall()
        finally:
            conn.close()
        out = []
        for r in rows:
            try:
                rec = json.loads(r["record"] or "{}")
            except ValueError:
                continue
            if isinstance(rec, dict):
                out.append(rec)
        return out
    except Exception:
        return []


def _write_registry_locked() -> None:
    """整表覆盖写入任务注册表（必须已持有 _LOCK）。"""
    payload = [t.to_record() for t in _TASKS.values()]
    _write_registry_rows(payload)


def _write_registry_rows(records) -> None:
    """把任务记录写成「一行一个任务」。"""
    try:
        with store_tx() as conn:
            conn.execute("DELETE FROM runner_tasks")
            for i, rec in enumerate(records or []):
                if not isinstance(rec, dict):
                    continue
                conn.execute(
                    "INSERT INTO runner_tasks (seq, id, record) VALUES (?,?,?)",
                    (i, str(rec.get("id") or ""), json.dumps(rec, ensure_ascii=False)))
    except Exception as e:
        _log.warning("保存运行任务注册表失败：%s", e)


# 旧版 .file_runner_tasks.json（或上一版 kv 键）一次性导入
migrate_legacy_list("table_migrated:runner_tasks", "runner_tasks",
                    _reg_path(), _write_registry_rows)


def _persist() -> None:
    with _LOCK:
        _write_registry_locked()


def _remove_log_file(task) -> None:
    try:
        if task and task.log_path and os.path.exists(task.log_path):
            os.remove(task.log_path)
    except OSError:
        pass


def _prune_locked() -> None:
    """清理过期的「已结束」任务（必须已持有 _LOCK）。"""
    now = time.time()
    for k in [k for k, v in _TASKS.items() if v.done and now - v.started > _TASK_TTL]:
        _remove_log_file(_TASKS.pop(k, None))


class _BgTask:
    """一个运行任务（前台 / 后台统一模型）。"""

    def __init__(self, tid, target, cmd, cwd, mode="bg", timeout=None,
                 started_at=None, pid=None, orphan=False):
        self.id = tid
        self.target = target
        self.cmd = list(cmd or [])
        self.cwd = cwd
        self.mode = mode                # "fg" 前台（有超时）/ "bg" 后台（常驻）
        self.timeout = timeout          # 剩余/当前超时秒数；后台为 None
        self.timeout_used = timeout     # 初始超时（用于提示文案）
        self.pid = pid
        self.proc = None                # 仅当本服务是它的父进程时存在
        self.orphan = orphan            # 服务重启后重新接管（非本进程的子进程）
        self.log_path = _log_path(tid)
        self.lines = []
        self.base = 0                   # 已丢弃的历史行数（offset 换算用）
        self.done = False
        self.exit_code = None
        self.error = ""
        self.stopped_by_user = False
        self.timed_out = False          # 是否因超时被自动终止
        self.promoted = False           # 是否因超时被自动转为后台运行
        self.started = float(started_at or time.time())
        self.ended_at = None            # 结束时刻：用于冻结「已结束」任务的运行时长
        # 日志推送用的条件变量：add() 时唤醒正在等新数据的 SSE 连接
        self.cond = threading.Condition()
        self.rev = 0

    # ---- 序列化 ------------------------------------------------------
    def to_record(self) -> dict:
        return {
            "id": self.id, "target": self.target, "cmd": self.cmd, "cwd": self.cwd,
            "mode": self.mode, "timeout": self.timeout, "timeout_used": self.timeout_used,
            "pid": self.pid, "started_at": self.started, "ended_at": self.ended_at,
            "promoted": self.promoted, "stopped_by_user": self.stopped_by_user,
            "timed_out": self.timed_out, "exit_code": self.exit_code, "done": self.done,
        }

    @classmethod
    def from_record(cls, rec: dict) -> "_BgTask":
        t = cls(rec.get("id") or uuid.uuid4().hex[:12],
                rec.get("target") or "", rec.get("cmd") or [], rec.get("cwd") or ".",
                mode=rec.get("mode") or "bg", timeout=rec.get("timeout"),
                started_at=rec.get("started_at"), pid=rec.get("pid"), orphan=True)
        t.timeout_used = rec.get("timeout_used")
        t.promoted = bool(rec.get("promoted"))
        t.stopped_by_user = bool(rec.get("stopped_by_user"))
        t.timed_out = bool(rec.get("timed_out"))
        t.ended_at = rec.get("ended_at")
        return t

    # ---- 输出缓冲 ----------------------------------------------------
    def add(self, text, cls=None):
        with self.cond:
            if len(self.lines) >= _MAX_LINES:
                drop = 1000
                del self.lines[:drop]
                self.base += drop
            self.lines.append({
                "t": round(time.time() - self.started, 2),
                "m": str(text)[:_LINE_MAX],
                "c": cls or "",
            })
            self.rev += 1
            self.cond.notify_all()

    def snapshot(self, offset: int) -> tuple:
        """取 offset 之后的新行：返回 (lines, 新 offset, 当前 rev)。

        rev 与快照一起取出，避免并发下漏掉刚好在这一刻写入的行。
        """
        with self.cond:
            if offset < self.base:
                offset = self.base
            return self.lines[offset - self.base:], self.base + len(self.lines), self.rev

    def is_done(self) -> bool:
        with self.cond:
            return self.done

    def wait(self, rev: int, timeout: float = 15.0) -> bool:
        """等待新行 / 结束；返回 True 表示有变化（无需发心跳）。"""
        with self.cond:
            if self.rev == rev and not self.done:
                self.cond.wait(timeout)
            return self.rev != rev or self.done

    def finish(self, exit_code=None):
        with self.cond:
            self.exit_code = exit_code
            self.done = True
            if not self.ended_at:
                self.ended_at = time.time()
            self.cond.notify_all()

    # ---- 状态 --------------------------------------------------------
    def is_alive(self) -> bool:
        """进程是否还在运行（本进程的子进程用 wait 判定，接管来的用 pid 探活）。"""
        if self.done:
            return False
        if self.proc is not None:
            return self.proc.poll() is None
        if not self.pid:
            return False
        try:
            os.kill(self.pid, 0)
        except ProcessLookupError:
            return False
        except PermissionError:
            return True
        except OSError:
            return False
        return True

    def promote_to_background(self) -> None:
        """超时后进程仍在运行：转为后台任务，不再计时（避免打断已启动的服务）。"""
        with self.cond:
            self.mode = "bg"
            self.timeout = None
            self.promoted = True
        self.add(f"⏱ 已超过 {self.timeout_used}s 仍在运行，已自动转为后台运行（不再计时，可在「后台任务」面板结束）", "head")
        _persist()

    def duration(self) -> float:
        # 已结束的任务用「结束时刻 - 启动时刻」冻结时长，不再随时间增长
        end = self.ended_at if self.done and self.ended_at else time.time()
        return round(max(0.0, end - self.started), 1)

    def payload(self, lines, offset) -> dict:
        return {
            "id": self.id, "lines": lines, "offset": offset,
            "done": self.done, "running": not self.done,
            "exit_code": self.exit_code,
            "mode": self.mode, "timeout": self.timeout, "timeout_used": self.timeout_used,
            "timed_out": self.timed_out, "stopped_by_user": self.stopped_by_user,
            "promoted": self.promoted, "orphan": self.orphan,
            "duration": self.duration(),
            "pid": self.pid, "log_path": self.log_path,
            "target": self.target, "command": " ".join(self.cmd), "cwd": self.cwd,
        }

    def brief(self) -> dict:
        alive = self.is_alive()
        try:
            size = os.path.getsize(self.log_path)
        except OSError:
            size = 0
        return {
            "id": self.id, "target": self.target, "name": os.path.basename(self.target or self.id),
            "command": " ".join(self.cmd), "cwd": self.cwd,
            "mode": self.mode, "pid": self.pid, "orphan": self.orphan,
            "running": alive, "exit_code": self.exit_code,
            "promoted": self.promoted, "timed_out": self.timed_out,
            "stopped_by_user": self.stopped_by_user,
            "started_at": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(self.started)),
            "duration": self.duration(), "lines": self.base + len(self.lines),
            "log_size": size, "log_path": self.log_path,
        }


# ======================================================================
# 进程控制
# ======================================================================
def _kill_group(proc) -> None:
    """终止整个进程组（避免只杀父进程而留下子进程占用端口）。"""
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


def _kill_pid(pid) -> None:
    """按 pid 终止进程组（用于服务重启后接管、已不是本进程子进程的任务）。

    与「端口占用」面板共用同一套结束逻辑（SIGTERM → 超时 SIGKILL）。
    """
    from ...services.ide.portinfo import kill_pid
    kill_pid(pid)


def _kill_task(task) -> None:
    if task is None or task.done:
        return
    if task.proc is not None:
        _kill_group(task.proc)
    else:
        _kill_pid(task.pid)


# ======================================================================
# 日志跟随（文件 → 内存缓冲 → SSE）
# ======================================================================
def _check_addr_in_use(task, line: str) -> None:
    """检测「端口被占用」报错并给出可操作的提示（每个任务只提示一次）。

    典型场景：上次启动的服务进程还活着（页面关了进程不死），
    新启动的 server.js 会因 EADDRINUSE 立即退出，看起来像「莫名其妙自动结束」。
    """
    if "EADDRINUSE" not in line and "address already in use" not in line.lower():
        return
    if getattr(task, "addr_warned", False):
        return
    task.addr_warned = True
    m = None
    for token in line.replace(":", " ").split():
        if token.isdigit() and 1 <= int(token) <= 65535:
            m = token
            break
    hint = f"⚠ 端口 {m} 已被占用" if m else "⚠ 端口已被占用"
    task.add(hint + "：上次启动的旧进程可能还在运行（所以你现在仍能访问），新进程因此启动失败退出。"
             "可在「后台任务」面板顶部搜索该端口，强制停止旧进程后再重新运行。", "err")


def _on_task_exit(task) -> None:
    code = task.exit_code
    if task.proc is not None:
        c = task.proc.poll()
        if c is None:
            try:
                c = task.proc.wait(timeout=3)
            except Exception:
                c = None
        code = c
    if task.stopped_by_user:
        task.add("— 已手动终止%s —" % ("" if code is None else f"（退出码 {code}）"), "dim")
    elif task.timed_out:
        task.add(f"— 执行超时（超过 {task.timeout_used}s），已自动终止 —", "err")
    elif code is None:
        task.add("— 进程已退出（服务重启后接管，退出码未知）—", "dim")
    else:
        task.add(f"— 进程已退出，代码 {code} —", "ok" if code == 0 else "err")
    task.finish(code)
    _persist()


def _tail_log(task) -> None:
    """跟随日志文件，把新增内容按行写入内存缓冲。

    子进程 stdout 直接落盘（不是管道），所以：服务重启 / 页面关闭都不影响子进程，
    重启后重新打开日志文件即可继续跟踪（包括历史输出）。
    """
    buf = ""
    fh = None
    try:
        fh = open(task.log_path, "rb")
        while True:
            chunk = fh.read()
            if chunk:
                buf += chunk.decode("utf-8", "replace")
                while "\n" in buf:
                    line, buf = buf.split("\n", 1)
                    task.add(line)
                    _check_addr_in_use(task, line)
                if len(buf) > _LINE_MAX * 2:      # 超长行（一直不换行）也要输出，避免看起来卡住
                    task.add(buf[:_LINE_MAX])
                    buf = buf[_LINE_MAX:]
                continue
            if task.is_alive():
                time.sleep(0.15)
                continue
            time.sleep(0.2)                       # 退出前可能还有尾部写入
            if fh.read():
                continue
            break
        if buf.strip():
            task.add(buf)
    except Exception as e:
        task.add(f"[日志读取中断] {e}", "dim")
    finally:
        if fh is not None:
            try:
                fh.close()
            except OSError:
                pass
        _on_task_exit(task)


def _watchdog(task) -> None:
    """前台超时看门狗：到点后按 config.RUN_TIMEOUT_ACTION 处理。

    默认 "background"：进程仍在运行（多为 Web 服务 / 常驻程序）时自动转为后台，
    不再计时，避免刚启动好、能正常访问的服务被超时杀掉；"kill" 则直接终止。
    """
    if not task.timeout:
        return
    deadline = task.started + task.timeout
    while not task.done:
        remain = deadline - time.time()
        if remain > 0:
            time.sleep(min(0.3, remain))
            continue
        if task.is_done() or not task.is_alive():
            return
        if _timeout_action() == "kill":
            task.timed_out = True
            _kill_task(task)
        else:
            task.promote_to_background()
        return


# ======================================================================
# 启动 / 接管
# ======================================================================
def _ensure_loaded() -> None:
    """首次访问时从磁盘恢复任务注册表；仍存活的进程重新挂上日志跟踪。"""
    global _loaded
    with _load_lock:
        if _loaded:
            return
        _loaded = True
    recs = _read_registry()
    restored = 0
    for rec in recs:
        try:
            task = _BgTask.from_record(rec)
        except Exception as e:
            _log.warning("恢复运行任务失败：%s", e)
            continue
        with _LOCK:
            # 本次进程内已经存在的任务（例如先跑了 /api/run 再打开面板）不能覆盖，
            # 否则会丢掉真正的 proc / 日志线程，导致面板看不到新日志。
            if task.id in _TASKS:
                continue
            _TASKS[task.id] = task
        restored += 1
        if task.is_alive():
            task.add("↻ 服务已重启，已重新接管该进程并继续跟踪日志（页面关闭不影响运行）", "dim")
        threading.Thread(target=_tail_log, args=(task,), daemon=True).start()
    if restored:
        _log.info("已恢复 %d 个运行任务", restored)
        _persist()


def _spawn_task(cmd, cwd, target, exe, raw_args, mode="bg", timeout=None):
    """启动进程并注册任务：成功返回 (task, None)，失败返回 (None, 错误响应)。"""
    from ...services.ide import envprobe
    env = envprobe.apply_custom_env(os.environ.copy())
    env["PYTHONUNBUFFERED"] = "1"                 # Python 输出不缓冲，日志才能实时看到
    env["FORCE_COLOR"] = "0"

    tid = uuid.uuid4().hex[:12]
    log_path = _log_path(tid)
    try:
        fh = open(log_path, "wb")
    except OSError as e:
        return None, _fail(f"创建日志文件失败：{e}", 500)
    try:
        proc = subprocess.Popen(cmd, cwd=cwd, stdout=fh, stderr=subprocess.STDOUT,
                                stdin=subprocess.DEVNULL, env=env, preexec_fn=os.setsid)
    except OSError as e:
        fh.close()
        return None, _fail(f"启动进程失败：{e}", 500)
    fh.close()                                    # 子进程已持有该 fd，父进程直接关闭

    task = _BgTask(tid, target, cmd, cwd, mode=mode, timeout=timeout, pid=proc.pid)
    task.proc = proc
    short = " ".join([os.path.basename(exe), os.path.basename(target)] + raw_args)
    task.add(("▶ 后台运行：" if mode == "bg" else "$ ") + short, "head")
    task.add(f"  pid={proc.pid} · cwd={cwd}", "dim")
    with _LOCK:
        _TASKS[tid] = task
        _prune_locked()
        _write_registry_locked()
    threading.Thread(target=_tail_log, args=(task,), daemon=True).start()
    if timeout:
        threading.Thread(target=_watchdog, args=(task,), daemon=True).start()
    return task, None


def _get_task(tid: str):
    _ensure_loaded()
    with _LOCK:
        return _TASKS.get(tid)


# ======================================================================
# 接口：日志
# ======================================================================
@bp.route("/api/run/log")
def api_run_log():
    """运行任务的增量输出与状态（轮询兜底）。"""
    tid = (request.args.get("id") or "").strip()
    try:
        offset = int(request.args.get("offset") or 0)
    except ValueError:
        offset = 0
    task = _get_task(tid)
    if not task:
        return _fail("任务不存在或已过期", 404)
    lines, offset, _ = task.snapshot(offset)
    return jsonify(task.payload(lines, offset))


@bp.route("/api/run/stream")
def api_run_stream():
    """SSE 实时日志流：一条长连接持续推送新增输出。

    - 只建立一次连接，日志再多也不会产生成百上千次请求；
    - 有新行立刻推送，15s 无输出发心跳保活；
    - 进程结束后推送最后一帧（done=true）并关闭。
    """
    tid = (request.args.get("id") or "").strip()
    try:
        offset = int(request.args.get("offset") or 0)
    except ValueError:
        offset = 0
    task = _get_task(tid)
    if not task:
        return _fail("任务不存在或已过期", 404)

    def gen():
        off = offset
        yield ": connected\n\n"
        while True:
            lines, off, rev = task.snapshot(off)
            if lines or task.is_done():
                yield "data: " + json.dumps(task.payload(lines, off), ensure_ascii=False) + "\n\n"
                if task.is_done():
                    return
            if not task.wait(rev, 15.0):
                yield ": ping\n\n"                 # 心跳（注释行，前端忽略）

    return Response(gen(), mimetype="text/event-stream", headers={
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",                 # 关掉反向代理缓冲，保证实时
        "Connection": "keep-alive",
    })


# ======================================================================
# 接口：任务管理
# ======================================================================
@bp.route("/api/run/tasks")
def api_run_tasks():
    """所有运行任务（含已结束），供「后台任务」管理面板使用。"""
    _ensure_loaded()
    # 顺带把每个任务进程监听的端口带上（卡片显示「端口 3000」）
    ports_by_pid = {}
    try:
        from ...services.ide import portinfo
        for p in portinfo.list_ports():
            pids = p.get("pids") or ([p["pid"]] if p.get("pid") else [])
            for pid in pids:
                ports_by_pid.setdefault(pid, set()).add(p["port"])
    except Exception as e:
        _log.warning("任务端口信息获取失败：%s", e)
    with _LOCK:
        items = []
        for t in _TASKS.values():
            b = t.brief()
            b["ports"] = sorted(ports_by_pid.get(t.pid, ()))
            items.append(b)
    items.sort(key=lambda x: (not x["running"], -x["duration"]))
    return jsonify({
        "ok": True, "tasks": items,
        "running": sum(1 for x in items if x["running"]),
        "total": len(items),
    })


@bp.route("/api/run/stop", methods=["POST"])
def api_run_stop():
    """终止任务（整个进程组；服务重启后接管的进程也能停）。"""
    data = request.get_json(silent=True) or {}
    tid = (data.get("id") or "").strip()
    task = _get_task(tid)
    if not task:
        return _fail("任务不存在或已过期", 404)
    if not task.is_alive():
        return jsonify({"ok": True, "already_done": True})
    task.stopped_by_user = True
    _persist()
    _log.info("POST /api/run/stop id=%s target=%s", tid, task.target)
    _kill_task(task)
    return jsonify({"ok": True, "killed": True})


@bp.route("/api/run/remove", methods=["POST"])
def api_run_remove():
    """移除一条已结束的任务记录（连同日志文件）。"""
    data = request.get_json(silent=True) or {}
    tid = (data.get("id") or "").strip()
    task = _get_task(tid)
    if not task:
        return _fail("任务不存在", 404)
    if task.is_alive():
        return _fail("任务仍在运行，请先停止再移除")
    with _LOCK:
        _TASKS.pop(tid, None)
        _write_registry_locked()
    _remove_log_file(task)
    return jsonify({"ok": True, "removed": True})


@bp.route("/api/run/prune", methods=["POST"])
def api_run_prune():
    """清理全部已结束的任务记录。"""
    _ensure_loaded()
    with _LOCK:
        gone = [k for k, v in _TASKS.items() if not v.is_alive()]
        tasks = [_TASKS.pop(k, None) for k in gone]
        _write_registry_locked()
    for t in tasks:
        _remove_log_file(t)
    return jsonify({"ok": True, "removed": len(gone)})


# ======================================================================
# 接口：运行时列表 / 启动
# ======================================================================
@bp.route("/api/run/runtimes")
def api_run_runtimes():
    """列出支持的运行时及其可用性。

    统一走 envprobe.resolve_exe（含自定义路径 + ~/.local/bin + nvm / cargo 等
    用户级目录），与 /api/run 实际执行时使用的是同一套解析逻辑，
    避免出现「面板说没装、其实能用」或反过来不一致的情况。
    """
    from ...services.ide import envprobe
    items = []
    seen = set()
    for ext, (exe, label) in _RUNNERS.items():
        if exe in seen:
            continue
        seen.add(exe)
        path = envprobe.resolve_exe(exe) or shutil.which(exe) or ""
        items.append({
            "exe": exe,
            "label": label,
            "exts": [e for e, (x, _) in _RUNNERS.items() if x == exe],
            "available": bool(path),
            "path": path,
        })
    items.sort(key=lambda x: (not x["available"], x["label"]))
    return jsonify({"ok": True, "runtimes": items})


@bp.route("/api/run", methods=["POST"])
def api_run():
    from ... import config
    if not getattr(config, "ENABLE_EXEC", True):
        return _fail("已禁用代码执行（config.ENABLE_EXEC = False）", 403)
    _ensure_loaded()                              # 先恢复历史任务，再启动新任务
    data = request.get_json(silent=True) or {}
    target = (data.get("path") or "").strip()
    if not target or not os.path.isfile(target):
        return _fail("文件不存在")
    ext = os.path.splitext(target)[1].lower().lstrip(".")
    runner = _RUNNERS.get(ext)
    if not runner:
        return _fail(f"暂不支持直接运行 .{ext} 文件" if ext else "暂不支持运行无扩展名的文件")

    exe, label = runner
    # 优先使用「运行环境」面板里配置的自定义解释器路径
    from ...services.ide import envprobe
    exe_path = envprobe.resolve_exe(exe)
    if not exe_path:
        return _fail(f"未安装 {label}（找不到命令 {exe}）")

    default_timeout, max_timeout = _timeout_limits()
    try:
        timeout = int(data.get("timeout") or default_timeout)
    except (TypeError, ValueError):
        timeout = default_timeout
    timeout = max(1, min(max_timeout, timeout))

    # 附加参数：字符串按 shell 规则切分，数组直接使用
    raw_args = data.get("args") or []
    if isinstance(raw_args, str):
        try:
            raw_args = shlex.split(raw_args)
        except ValueError:
            raw_args = raw_args.split()
    raw_args = [str(a) for a in raw_args]

    cwd = os.path.dirname(target) or "."
    cmd = [exe_path, target] + raw_args
    background = bool(data.get("background"))
    _log.info("POST /api/run file=%s exe=%s bg=%s", target, exe, background)

    # 后台运行：常驻进程，不超时、可随时终止，关页面 / 重启服务都继续跑
    if background:
        task, err = _spawn_task(cmd, cwd, target, exe, raw_args, mode="bg")
        if err:
            return err
        return jsonify({
            "ok": True, "background": True, "id": task.id, "pid": task.pid,
            "command": " ".join(cmd), "cwd": cwd, "log_path": task.log_path,
        })

    # 前台运行：立即返回任务 id，日志实时推送；超时按 config.RUN_TIMEOUT_ACTION 处理
    task, err = _spawn_task(cmd, cwd, target, exe, raw_args, mode="fg", timeout=timeout)
    if err:
        return err
    return jsonify({
        "ok": True, "stream": True, "id": task.id, "pid": task.pid,
        "timeout": timeout, "log_path": task.log_path,
        "command": " ".join([exe] + [os.path.basename(target)] + raw_args),
        "cwd": cwd,
    })

"""定时任务调度与执行（参考青龙面板）。

- 调度线程：每秒看一眼「当前分钟」是否命中某个启用任务的 cron，命中且这一分钟还没跑过就执行；
- 执行：用 bash -lc 在指定工作目录拉起子进程，stdout/stderr 直接落盘到
  data/cron_logs/<task_id>/<run_id>.log，前端按 offset 轮询增量读取；
- 记录：每次执行都在 cron_runs 里留一条（状态 / 退出码 / 耗时 / 日志路径），
  每个任务只保留最近 _KEEP_RUNS 条，超出的连同日志文件一起清掉；
- 安全：执行前统一走 services/common/safety.check_command，危险命令直接拒绝。

说明：执行中的进程是 setsid 起的独立进程组，服务重启后无法再接管，
启动时会把「上次还处于 running」的记录标记为 interrupted（中断）。
"""
import os
import signal
import subprocess
import threading
import time
import uuid
from datetime import datetime

from ... import config
from ...log import get_logger
from ..common.safety import check_command
from . import crondb
from . import cronutil

_log = get_logger()

LOG_DIR = os.path.join(config.DATA_ROOT, "cron_logs")
_KEEP_RUNS = 50                     # 每个任务保留的执行记录条数
_TICK = 5.0                         # 调度线程轮询间隔（秒）
_READ_MAX = 200 * 1024              # 单次最多返回多少字节日志

_LOCK = threading.RLock()
_RUNNING = {}                       # run_id -> {"proc", "task_id", "start", "log_path"}
_BY_TASK = {}                       # task_id -> run_id（同一任务不并发）
_LAST_FIRED = {}                    # task_id -> "YYYY-MM-DD HH:MM"（同一分钟只触发一次）
_THREAD = None
_STARTED = False


# ---------------------------------------------------------------- 内部工具
def _ensure_dir(path):
    try:
        os.makedirs(path, exist_ok=True)
    except OSError as e:
        _log.warning("创建定时任务日志目录失败 %s：%s", path, e)


def _kill_group(proc):
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
    except OSError:
        try:
            proc.terminate()
        except OSError:
            return
    try:
        proc.wait(timeout=3)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except OSError:
            try:
                proc.kill()
            except OSError:
                pass


def _remove_log(path):
    try:
        if path and os.path.isfile(path):
            os.remove(path)
    except OSError:
        pass


def _log_size(path):
    try:
        return os.path.getsize(path)
    except OSError:
        return 0


def _remove_task_dir(task_id):
    """删除任务后清掉它的空日志目录。"""
    try:
        os.rmdir(os.path.join(LOG_DIR, str(task_id)))
    except OSError:
        pass


# ---------------------------------------------------------------- 执行
def start_run(task_id, trigger="manual"):
    """启动一次执行；返回 {"run_id": ...} 或 {"error": ...}。"""
    task = crondb.get_task(task_id)
    if not task:
        return {"error": "任务不存在"}
    if not getattr(config, "ENABLE_EXEC", True):
        return {"error": "已禁用命令执行（config.ENABLE_EXEC = False）"}
    cmd = str(task.get("command") or "").strip()
    if not cmd:
        return {"error": "任务命令为空，请先在编辑里填写"}
    ok, tip = cronutil.validate(task.get("cron") or "")
    if not ok:
        return {"error": "cron 表达式非法：" + tip}
    with _LOCK:
        if task_id in _BY_TASK:
            return {"error": "该任务正在运行中，请先停止"}
    verdict = check_command(cmd)
    if verdict.get("level") == "blocked":
        return {"error": "已拦截危险命令：%s" % verdict.get("reason")}

    run_id = uuid.uuid4().hex[:12]
    task_dir = os.path.join(LOG_DIR, task_id)
    _ensure_dir(task_dir)
    log_path = os.path.join(task_dir, run_id + ".log")
    cwd = str(task.get("cwd") or "").strip() or None
    if cwd and not os.path.isdir(cwd):
        return {"error": "工作目录不存在：%s" % cwd}
    env = dict(os.environ)
    env.update({"PYTHONUNBUFFERED": "1", "FORCE_COLOR": "0",
                "PAGER": "cat", "GIT_PAGER": "cat", "GIT_TERMINAL_PROMPT": "0"})
    started = time.time()
    try:
        fh = open(log_path, "wb")
    except OSError as e:
        return {"error": "创建日志文件失败：%s" % e}
    try:
        proc = subprocess.Popen(["bash", "-lc", cmd], cwd=cwd, stdout=fh, stderr=subprocess.STDOUT,
                                stdin=subprocess.DEVNULL, env=env, preexec_fn=os.setsid)
    except OSError as e:
        fh.close()
        _remove_log(log_path)
        return {"error": "启动失败：%s" % e}
    fh.close()                                     # 子进程已持有该 fd
    try:
        with open(log_path, "ab") as w:
            w.write(("\n[%s] ▶ 开始执行（%s）\n$ %s\n" % (
                time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(started)),
                "手动" if trigger == "manual" else "定时", cmd)).encode("utf-8"))
    except OSError:
        pass

    crondb.insert_run(run_id, task_id, task.get("name") or "", trigger, log_path, started)
    with _LOCK:
        _RUNNING[run_id] = {"proc": proc, "task_id": task_id, "start": started, "log_path": log_path}
        _BY_TASK[task_id] = run_id
    threading.Thread(target=_watch, args=(run_id, task_id, proc, log_path, started),
                     name="cron-watch-%s" % run_id, daemon=True).start()
    _log.info("定时任务启动：%s（%s）run=%s pid=%s", task.get("name"), trigger, run_id, proc.pid)
    return {"run_id": run_id, "pid": proc.pid}


def _watch(run_id, task_id, proc, log_path, started):
    task = crondb.get_task(task_id) or {}
    try:
        timeout = int(task.get("timeout") or 0)
    except (TypeError, ValueError):
        timeout = 0
    status, code = "success", None
    try:
        if timeout > 0:
            code = proc.wait(timeout=timeout)
        else:
            code = proc.wait()
    except subprocess.TimeoutExpired:
        _kill_group(proc)
        status = "timeout"
        try:
            code = proc.wait(timeout=2)
        except Exception:                          # noqa: BLE001
            code = None
    except Exception as e:                         # noqa: BLE001
        _log.warning("定时任务等待异常：%s", e)
    if status != "timeout":
        if code == 0:
            status = "success"
        else:
            status = "fail"
    with _LOCK:
        rec = _RUNNING.pop(run_id, None)
        if rec and _BY_TASK.get(task_id) == run_id:
            _BY_TASK.pop(task_id, None)
        stopped = bool(rec and rec.get("stopped"))
    if stopped:
        status = "killed"
    ended = time.time()
    dur = int((ended - started) * 1000)
    try:
        with open(log_path, "ab") as w:
            tail = {"success": "✔ 执行完成",
                    "fail": "✘ 执行失败（退出码 %s）" % code,
                    "timeout": "⏱ 超时被终止",
                    "killed": "■ 已手动停止"}.get(status, status)
            w.write(("\n[%s] %s，耗时 %.1fs\n" % (
                time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(ended)), tail, dur / 1000.0)).encode("utf-8"))
    except OSError:
        pass
    crondb.finish_run(run_id, status, code, dur, _log_size(log_path), ended)
    crondb.bump_task_stats(task_id, status, dur, code, ended)
    for r in crondb.prune_runs(task_id, _KEEP_RUNS):     # 超出保留条数的记录：连日志一起删
        _remove_log(r.get("log_path"))
    _log.info("定时任务结束：%s run=%s status=%s code=%s（%dms）",
              task.get("name"), run_id, status, code, dur)


def stop_run(run_id):
    with _LOCK:
        rec = _RUNNING.get(run_id)
        if not rec:
            return {"error": "该执行已不在了（可能已结束）"}
        rec["stopped"] = True
        proc = rec["proc"]
    _kill_group(proc)
    return {"ok": True}


def stop_task(task_id):
    with _LOCK:
        run_id = _BY_TASK.get(task_id)
    if not run_id:
        return {"error": "该任务当前没有在运行"}
    return stop_run(run_id)


def is_running(task_id):
    with _LOCK:
        return task_id in _BY_TASK


def running_run_id(task_id):
    with _LOCK:
        return _BY_TASK.get(task_id)


# ---------------------------------------------------------------- 日志
def read_log(run_id, offset=0):
    """按 offset 增量读取日志；返回 {text, offset, size, running}。"""
    run = crondb.get_run(run_id)
    if not run:
        return {"error": "执行记录不存在"}
    path = run.get("log_path") or ""
    try:
        offset = max(0, int(offset or 0))
    except (TypeError, ValueError):
        offset = 0
    size = _log_size(path)
    text = ""
    if path and os.path.isfile(path):
        try:
            with open(path, "rb") as f:
                f.seek(min(offset, size))
                data = f.read(_READ_MAX)
            text = data.decode("utf-8", "replace")
            offset += len(data)
        except OSError as e:
            return {"error": "读取日志失败：%s" % e}
    with _LOCK:
        still = run_id in _RUNNING
    if not still and run.get("status") == "running":     # 进程已不在但状态没落库（极少见）
        still = False
    return {"text": text, "offset": offset, "size": size, "running": still,
            "status": "running" if still else run.get("status")}


# ---------------------------------------------------------------- 调度
def _tick():
    stamp = time.strftime("%Y-%m-%d %H:%M", time.localtime())
    dt = datetime.now().replace(second=0, microsecond=0)
    for t in crondb.list_tasks():
        if not t.get("enabled"):
            continue
        tid = t["id"]
        expr = t.get("cron") or ""
        try:
            if not cronutil.cron_matches(expr, dt):
                continue
        except cronutil.CronError:
            continue
        if _LAST_FIRED.get(tid) == stamp:
            continue
        _LAST_FIRED[tid] = stamp
        if is_running(tid):                            # 上一轮还没跑完：跳过本次
            _log.info("定时任务 %s 上一轮仍在运行，跳过本次触发", t.get("name"))
            continue
        res = start_run(tid, "cron")
        if res.get("error"):
            _log.warning("定时任务触发失败：%s（%s）", t.get("name"), res["error"])


def _loop():
    while True:
        try:
            _tick()
        except Exception as e:                         # noqa: BLE001
            _log.warning("定时调度异常：%s", e)
        # 睡到下一个整 5 秒，保证分钟边界不会错过
        time.sleep(_TICK - (time.time() % _TICK))


def _mark_interrupted():
    """启动时把上次遗留的 running 记录标记为中断（服务重启后无法接管旧进程）。"""
    for r in crondb.running_runs():
        dur = max(0, int((time.time() - float(r.get("started_at") or time.time())) * 1000))
        crondb.finish_run(r["id"], "killed", None, dur, _log_size(r.get("log_path")), time.time())


def ensure_scheduler():
    """启动调度线程（幂等，重复调用无副作用）。"""
    global _THREAD, _STARTED
    with _LOCK:
        if _STARTED:
            return
        _STARTED = True
    _ensure_dir(LOG_DIR)
    try:
        _mark_interrupted()
    except Exception as e:                             # noqa: BLE001
        _log.warning("清理中断的定时任务记录失败：%s", e)
    _THREAD = threading.Thread(target=_loop, name="cron-scheduler", daemon=True)
    _THREAD.start()
    _log.info("定时任务调度器已启动（每 %.0fs 检查一次）", _TICK)


def shutdown():
    """停止调度线程并终止所有在跑的定时任务（服务退出时调用）。"""
    global _STARTED
    with _LOCK:
        _STARTED = False
        procs = [r["proc"] for r in _RUNNING.values()]
        _RUNNING.clear()
        _BY_TASK.clear()
    for p in procs:
        _kill_group(p)

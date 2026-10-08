"""定时任务调度与执行（参考青龙面板）。

- 调度线程：每秒看一眼是否有启用任务命中 cron（5 段精确到分钟、6 段精确到秒），
  命中且该时刻还没触发过就执行；依赖任务未就绪时顺延到下一次触发；
- 执行：用 bash 在指定工作目录拉起子进程，支持前置 / 后置钩子（前置失败则跳过主命令），
  stdout/stderr 直接落盘到 data/cron_logs/<task_id>/<run_id>.log，前端按 offset 轮询增量读取；
- 重试：失败 / 超时后按任务配置的重试次数与间隔自动重试（手动停止不重试）；
- 通知：失败 / 超时 / 安排重试时按 cron_cfg 的 notify 配置推送（见 cronnotify.py）；
- 清理：每小时按「日志保留天数 + 每任务保留条数」自动清理执行记录与日志文件；
- 监控：monitor() 返回系统资源与正在运行任务的进程占用（复用 procinfo）；
- 安全：执行前统一走 services/common/safety.check_command，危险命令直接拒绝。

说明：执行中的进程是 setsid 起的独立进程组，服务重启后无法再接管，
启动时会把「上次还处于 running」的记录标记为 killed（中断）。
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
from . import cronnotify
from . import cronutil
from . import procinfo

_log = get_logger()

LOG_DIR = os.path.join(config.DATA_ROOT, "cron_logs")
_KEEP_RUNS = 50                     # 默认每个任务保留的执行记录条数（可在设置里改）
_LOG_DAYS = 0                       # 默认日志保留天数（0 = 永久保留，可在设置里改）
_TICK = 1.0                         # 调度线程轮询间隔（秒；秒级任务需要 1s 粒度）
_CLEANUP_EVERY = 3600.0             # 日志自动清理间隔（秒）
_READ_MAX = 200 * 1024              # 单次最多返回多少字节日志

_LOCK = threading.RLock()
_RUNNING = {}                       # run_id -> {"proc", "task_id", "start", "log_path", "stopped"}
_BY_TASK = {}                       # task_id -> run_id（同一任务不并发）
_LAST_FIRED = {}                    # task_id -> "YYYY-MM-DD HH:MM[:SS]"（同一时刻只触发一次）
_RETRIES = {}                       # task_id -> 已重试次数
_RETRY_TIMERS = {}                  # task_id -> set(Timer)（待执行的重试定时器）
_THREAD = None
_STARTED = False
_LAST_CLEANUP = 0.0


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


def _settings():
    """读取模块设置（日志清理天数 / 每任务保留条数），异常时用默认值。"""
    days, keep = _LOG_DAYS, _KEEP_RUNS
    try:
        days = int(crondb.get_setting("log_days", _LOG_DAYS))
    except (TypeError, ValueError):
        days = _LOG_DAYS
    try:
        keep = int(crondb.get_setting("keep_runs", _KEEP_RUNS))
    except (TypeError, ValueError):
        keep = _KEEP_RUNS
    return max(0, days), max(1, keep)


# ---------------------------------------------------------------- 钩子脚本
def _build_script(cmd, pre_hook, post_hook):
    """把 主命令 + 前后置钩子 组合成一段 bash 脚本。

    前置钩子失败（退出码非 0）时跳过主命令并以该退出码结束；
    主命令放进子 shell，避免命令里的 exit 提前结束整个脚本；
    后置钩子失败不影响本次执行状态（退出码取主命令的）。
    """
    lines = ["set +e"]
    if pre_hook:
        lines += [
            'echo "[钩子] ▶ 前置钩子"',
            "( " + pre_hook + "\n)",
            "pre_rc=$?",
            'echo "[钩子] 前置钩子退出码 $pre_rc"',
            'if [ "$pre_rc" -ne 0 ]; then echo "[钩子] ✘ 前置钩子失败，跳过主命令"; exit "$pre_rc"; fi',
        ]
    lines += ['echo "[cron] ▶ 开始执行主命令"', "( " + cmd + "\n)", "main_rc=$?"]
    if post_hook:
        lines += [
            'echo "[钩子] ▶ 后置钩子"',
            "( " + post_hook + "\n)",
            "post_rc=$?",
            'echo "[钩子] 后置钩子退出码 $post_rc"',
        ]
    lines.append('exit "$main_rc"')
    return "\n".join(lines)


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
    pre_hook = str(task.get("pre_hook") or "").strip()
    post_hook = str(task.get("post_hook") or "").strip()
    for label, hook in (("前置钩子", pre_hook), ("后置钩子", post_hook), ("主命令", cmd)):
        verdict = check_command(hook)
        if verdict.get("level") == "blocked":
            return {"error": "已拦截危险命令（%s）：%s" % (label, verdict.get("reason"))}

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
    script = _build_script(cmd, pre_hook, post_hook) if (pre_hook or post_hook) else cmd
    try:
        proc = subprocess.Popen(["bash", "-lc", script], cwd=cwd, stdout=fh,
                                stderr=subprocess.STDOUT,
                                stdin=subprocess.DEVNULL, env=env, preexec_fn=os.setsid)
    except OSError as e:
        fh.close()
        _remove_log(log_path)
        return {"error": "启动失败：%s" % e}
    fh.close()                                     # 子进程已持有该 fd
    hook_note = "，含前后置钩子" if (pre_hook or post_hook) else ""
    try:
        with open(log_path, "ab") as w:
            w.write(("\n[%s] ▶ 开始执行（%s%s）\n$ %s\n" % (
                time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(started)),
                "手动" if trigger == "manual" else ("重试" if trigger == "retry" else "定时"),
                hook_note, cmd)).encode("utf-8"))
    except OSError:
        pass

    # 新的一次「正式」触发：重试计数清零（重试触发本身不清）
    if trigger in ("cron", "manual"):
        with _LOCK:
            _RETRIES.pop(task_id, None)
    with _LOCK:
        attempt = _RETRIES.get(task_id, 0)
    crondb.insert_run(run_id, task_id, task.get("name") or "", trigger, log_path,
                      started, attempt)
    with _LOCK:
        _RUNNING[run_id] = {"proc": proc, "task_id": task_id, "start": started,
                            "log_path": log_path, "stopped": False}
        _BY_TASK[task_id] = run_id
    threading.Thread(target=_watch, args=(run_id, task_id, proc, log_path, started),
                     name="cron-watch-%s" % run_id, daemon=True).start()
    _log.info("定时任务启动：%s（%s%s）run=%s pid=%s", task.get("name"), trigger,
              hook_note, run_id, proc.pid)
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
    for r in crondb.prune_runs(task_id, _settings()[1]):     # 超出保留条数的记录：连日志一起删
        _remove_log(r.get("log_path"))
    _log.info("定时任务结束：%s run=%s status=%s code=%s（%dms）",
              task.get("name"), run_id, status, code, dur)
    if not stopped:
        if status == "success":
            with _LOCK:
                _RETRIES.pop(task_id, None)
            # 执行成功：events.success 开启时也会推送并留记录（send 内部自行判断开关）
            if task.get("notify"):
                cronnotify.send(
                    "定时任务执行成功 · %s" % (task.get("name") or task_id),
                    "任务「%s」执行成功。\n耗时：%.1fs\n时间：%s\n执行记录：%s" % (
                        task.get("name") or task_id, dur / 1000.0,
                        time.strftime("%Y-%m-%d %H:%M:%S"), run_id),
                    event="success",
                    vars_={"task": task.get("name") or task_id, "exit": "0",
                           "duration": "%.1fs" % (dur / 1000.0), "run": run_id, "attempt": ""})
        elif status in ("fail", "timeout"):
            _handle_failure(task, run_id, status, code, dur, log_path)


def _handle_failure(task, run_id, status, code, dur, log_path):
    """失败 / 超时后的收尾：安排重试（若配置了）+ 按配置推送通知。"""
    task_id = task.get("id")
    name = task.get("name") or task_id
    try:
        max_retries = max(0, int(task.get("max_retries") or 0))
    except (TypeError, ValueError):
        max_retries = 0
    try:
        interval = max(1, int(task.get("retry_interval") or 60))
    except (TypeError, ValueError):
        interval = 60
    attempt = _RETRIES.get(task_id, 0)
    title = "定时任务%s · %s" % ("超时" if status == "timeout" else "失败", name)
    body = ("任务「%s」执行%s。\n退出码：%s\n耗时：%.1fs\n时间：%s\n执行记录：%s" % (
        name, "超时被终止" if status == "timeout" else "失败", code, dur / 1000.0,
        time.strftime("%Y-%m-%d %H:%M:%S"), run_id))
    # 模板变量（通知模板见 cronnotify；{event} {date} {time} 由 send 兜底）
    vars_ = {"task": name, "exit": "无" if code is None else code,
             "duration": "%.1fs" % (dur / 1000.0), "run": run_id, "attempt": ""}
    # 1) 还有重试名额：安排下一次重试
    if max_retries > 0 and attempt < max_retries:
        nxt = attempt + 1
        with _LOCK:
            _RETRIES[task_id] = nxt
        timer = threading.Timer(interval, _retry_fire, (task_id, nxt))
        timer.daemon = True
        with _LOCK:
            _RETRY_TIMERS.setdefault(task_id, set()).add(timer)
        timer.start()
        tip = "将在 %d 秒后进行第 %d/%d 次重试" % (interval, nxt, max_retries)
        try:
            with open(log_path, "ab") as w:
                w.write(("[cron] ↻ %s\n" % tip).encode("utf-8"))
        except OSError:
            pass
        _log.info("定时任务将重试：%s run=%s（%s）", name, run_id, tip)
        vars_["attempt"] = "第 %d/%d 次" % (nxt, max_retries)
        cronnotify.send(title, body + "\n" + tip, event="retry", vars_=vars_)
        return
    # 2) 没有重试名额了（或没配重试）：推送失败 / 超时通知
    if task.get("notify"):
        cronnotify.send(title, body, event=status, vars_=vars_)


def _retry_fire(task_id, attempt):
    """重试定时器到点：任务还在且没在跑，就再执行一次。"""
    with _LOCK:
        timers = _RETRY_TIMERS.get(task_id)
        if timers:
            timers.discard(threading.current_thread())
            if not timers:
                _RETRY_TIMERS.pop(task_id, None)
    if not _STARTED:
        return
    task = crondb.get_task(task_id)
    if not task or not task.get("enabled"):
        _RETRIES.pop(task_id, None)
        return
    if is_running(task_id):                        # 用户手动跑起来了：放弃这次自动重试
        return
    res = start_run(task_id, "retry")
    if res.get("error"):
        _log.warning("定时任务重试启动失败：%s（%s）", task.get("name"), res["error"])


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


def cancel_retry(task_id):
    """取消某任务的待执行重试与计数（删除任务 / 手动干预时调用）。"""
    with _LOCK:
        _RETRIES.pop(task_id, None)
        timers = list(_RETRY_TIMERS.pop(task_id, None) or ())
    for t in timers:
        t.cancel()


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


# ---------------------------------------------------------------- 日志自动清理
def _cleanup():
    """按设置清理执行记录与日志文件：按天 + 每任务保留条数。"""
    days, keep = _settings()
    removed = 0
    if days > 0:
        deadline = time.time() - days * 86400
        for r in crondb.clear_runs_before(deadline):
            _remove_log(r.get("log_path"))
            removed += 1
    for t in crondb.list_tasks():
        for r in crondb.prune_runs(t["id"], keep):
            _remove_log(r.get("log_path"))
            removed += 1
    if removed:
        _log.info("定时任务日志自动清理：%d 条记录（保留 %d 天 / 每任务 %d 条）", removed, days, keep)


# ---------------------------------------------------------------- 资源监控
def monitor():
    """系统资源概况 + 正在运行的定时任务进程占用（复用 procinfo 的采样快照）。"""
    with _LOCK:
        items = [(rid, rec["task_id"], rec["proc"].pid, rec["start"])
                 for rid, rec in _RUNNING.items()]
    runs = []
    for rid, tid, pid, start in items:
        usage = procinfo.tree_usage(pid)
        runs.append({"run_id": rid, "task_id": tid, "pid": pid,
                     "elapsed": int((time.time() - start) * 1000),
                     "cpu": usage.get("cpu"), "rss": usage.get("rss"), "n": usage.get("n")})
    sysinfo = {}
    try:
        ov = procinfo.overview()
        if not ov.get("error"):
            cpu = ov.get("cpu") or {}
            mem = ov.get("mem") or {}
            sysinfo = {"cpu": cpu.get("percent"), "cores": cpu.get("cores"),
                       "load": cpu.get("load"), "mem_percent": mem.get("percent"),
                       "mem_used": mem.get("used"), "mem_total": mem.get("total")}
    except Exception as e:                             # noqa: BLE001
        _log.warning("定时任务资源监控异常：%s", e)
    return {"sys": sysinfo, "runs": runs}


# ---------------------------------------------------------------- 调度
def _deps_unmet(task):
    """检查任务依赖：返回未就绪的依赖描述列表（空 = 可以触发）。

    依赖语义：所依赖任务「最近一次执行」必须成功（且不在运行中）。
    从未跑过 / 最近一次失败 / 停用 / 不存在，都视为未就绪。
    """
    raw = str(task.get("depends_on") or "")
    ids = [s.strip() for s in raw.split(",") if s.strip()]
    if not ids:
        return []
    unmet = []
    for dep_id in ids:
        dep = crondb.get_task(dep_id)
        if not dep:
            unmet.append("依赖任务已不存在（%s）" % dep_id)
        elif is_running(dep_id):
            unmet.append("依赖任务「%s」正在运行" % (dep.get("name") or dep_id))
        elif not dep.get("enabled"):
            unmet.append("依赖任务「%s」已停用" % (dep.get("name") or dep_id))
        elif (dep.get("last_status") or "") != "success":
            unmet.append("依赖任务「%s」尚未成功执行" % (dep.get("name") or dep_id))
    return unmet


def _tick():
    now = datetime.now().replace(microsecond=0)
    for t in crondb.list_tasks():
        if not t.get("enabled"):
            continue
        tid = t["id"]
        try:
            c = cronutil.parse_cron(t.get("cron") or "")
        except cronutil.CronError:
            continue
        if not cronutil.cron_matches(c, now):
            continue
        # 防重复触发：分钟级任务按「分钟」记，秒级任务按「秒」记
        stamp = now.strftime("%Y-%m-%d %H:%M:%S" if c.seconds is not None else "%Y-%m-%d %H:%M")
        if _LAST_FIRED.get(tid) == stamp:
            continue
        _LAST_FIRED[tid] = stamp
        if is_running(tid):                            # 上一轮还没跑完：跳过本次
            _log.info("定时任务 %s 上一轮仍在运行，跳过本次触发", t.get("name"))
            continue
        unmet = _deps_unmet(t)
        if unmet:                                      # 依赖未就绪：顺延到下一次触发
            _log.info("定时任务 %s 依赖未就绪（%s），跳过本次触发", t.get("name"), "；".join(unmet))
            continue
        res = start_run(tid, "cron")
        if res.get("error"):
            _log.warning("定时任务触发失败：%s（%s）", t.get("name"), res["error"])


def _loop():
    global _LAST_CLEANUP
    while True:
        try:
            _tick()
        except Exception as e:                         # noqa: BLE001
            _log.warning("定时调度异常：%s", e)
        try:
            if time.time() - _LAST_CLEANUP >= _CLEANUP_EVERY:
                _LAST_CLEANUP = time.time()
                _cleanup()
        except Exception as e:                         # noqa: BLE001
            _log.warning("定时任务日志清理异常：%s", e)
        # 睡到下一个整秒，保证秒 / 分钟边界都不会错过
        time.sleep(_TICK - (time.time() % _TICK))


def _mark_interrupted():
    """启动时把上次遗留的 running 记录标记为中断（服务重启后无法接管旧进程）。"""
    for r in crondb.running_runs():
        dur = max(0, int((time.time() - float(r.get("started_at") or time.time())) * 1000))
        crondb.finish_run(r["id"], "killed", None, dur, _log_size(r.get("log_path")), time.time())


def ensure_scheduler():
    """启动调度线程（幂等，重复调用无副作用）。"""
    global _THREAD, _STARTED, _LAST_CLEANUP
    with _LOCK:
        if _STARTED:
            return
        _STARTED = True
        _LAST_CLEANUP = time.time()
    _ensure_dir(LOG_DIR)
    try:
        _mark_interrupted()
    except Exception as e:                             # noqa: BLE001
        _log.warning("清理中断的定时任务记录失败：%s", e)
    _THREAD = threading.Thread(target=_loop, name="cron-scheduler", daemon=True)
    _THREAD.start()
    _log.info("定时任务调度器已启动（每 %.0fs 检查一次，支持秒级 cron）", _TICK)


def shutdown():
    """停止调度线程并终止所有在跑的定时任务（服务退出时调用）。"""
    global _STARTED
    with _LOCK:
        _STARTED = False
        procs = [r["proc"] for r in _RUNNING.values()]
        _RUNNING.clear()
        _BY_TASK.clear()
        timers = [t for ts in _RETRY_TIMERS.values() for t in ts]
        _RETRY_TIMERS.clear()
    for t in timers:
        t.cancel()
    for p in procs:
        _kill_group(p)

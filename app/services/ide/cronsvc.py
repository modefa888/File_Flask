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
import json
import os
import re
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
_TAIL_READ = 96 * 1024              # 组装通知时最多读日志末尾多少字节
_NOTIFY_MAX_CHARS = 3500            # 单条通知里脚本输出最多保留多少字符（超出保留末尾）
_DRY_TIMEOUT_MAX = 120              # 试运行最长等待（秒），避免编辑弹窗里的请求无限挂起
_DRY_OUT_CHARS = 20000              # 试运行最多回传多少字符（超出保留末尾）
_JSON_VAR_MAX = 40                  # 通知模板最多展开多少个脚本输出的 JSON 字段
_JSON_VAL_MAX = 500                 # 单个 JSON 字段值最多保留多少字符
# 模板内置变量名：JSON 字段同名时跳过，避免把 {task} {event} 这些内置值顶掉
_TPL_RESERVED = ("task", "event", "status", "exit", "duration", "attempt", "run",
                 "date", "time", "output")

# 日志里框架自己写的标记行（这些不算脚本输出，不进通知）
_FRAME_HEAD = re.compile(r"^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] ▶ 开始执行")
_FRAME_TAIL = re.compile(r"^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] (✔|✘|⏱|■)")

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


# ---------------------------------------------------------------- 通知内容（可带脚本输出）
def _raw_tail(log_path, limit=None):
    """读日志末尾的脚本输出原文（不做字符截断），文件不存在 / 读失败返回空串。

    只读文件末尾 _TAIL_READ 字节（日志可能很大），去掉框架自己写的开始 / 结束
    标记与 [cron] / [钩子] 提示行，并去掉首尾空行。
    """
    limit = limit or _TAIL_READ
    try:
        size = os.path.getsize(log_path)
        with open(log_path, "rb") as f:
            if size > limit:
                f.seek(size - limit)
            data = f.read(limit)
    except (OSError, TypeError):
        return ""
    if size > limit:                            # 从中间截取：丢掉第一行（可能是半行）
        data = data.split(b"\n", 1)[-1]
    rows, skip_cmd = [], False
    for raw in data.decode("utf-8", "replace").splitlines():
        s = raw.rstrip()
        if skip_cmd:                            # 开始标记下面那行是 " $ 命令" 回显，不算输出
            skip_cmd = False
            if s.startswith("$ "):
                continue
        if _FRAME_HEAD.match(s):
            skip_cmd = True
            continue
        if _FRAME_TAIL.match(s) or s.startswith("[cron]") or s.startswith("[钩子]"):
            continue
        rows.append(s)
    while rows and not rows[0].strip():
        rows.pop(0)
    while rows and not rows[-1].strip():
        rows.pop()
    return "\n".join(rows)


def _tail_output(log_path, lines=20):
    """读取日志末尾的「脚本输出」，供通知正文使用；文件不存在 / 读失败返回空串。

    lines > 0 时只保留最后 lines 行（0 = 不限行，仍受 _NOTIFY_MAX_CHARS 约束）。
    """
    text = _raw_tail(log_path)
    rows = text.split("\n") if text else []
    try:
        n = max(0, int(lines or 0))
    except (TypeError, ValueError):
        n = 20
    trimmed = False
    if n and len(rows) > n:
        rows = rows[-n:]
        trimmed = True
    text = "\n".join(rows)
    if len(text) > _NOTIFY_MAX_CHARS:           # 太长：保留末尾（异常信息通常在最后）
        text = text[-_NOTIFY_MAX_CHARS:]
        trimmed = True
    if trimmed and text:
        text = "…（仅显示末尾部分）\n" + text
    return text


def _json_vars(text):
    """脚本输出是 JSON 对象时，把顶层字段展开成模板变量（如 {order_count}）。

    只接受合法标识符作键名（字母 / 下划线开头，≤40 字符）；
    值统一转成字符串（对象 / 数组转 JSON，布尔转 true/false，null 转空串）；
    输出前后有多余文字时，尝试截取最外层 {…} 再解析。
    """
    s = str(text or "").strip()
    if not s or len(s) > 256 * 1024:
        return {}
    data = None
    try:
        data = json.loads(s)
    except Exception:                                  # noqa: BLE001
        i, j = s.find("{"), s.rfind("}")
        if 0 <= i < j:
            try:
                data = json.loads(s[i:j + 1])
            except Exception:                          # noqa: BLE001
                data = None
    if not isinstance(data, dict):
        return {}
    out = {}
    for k, v in data.items():
        key = str(k).strip()
        if not re.match(r"^[A-Za-z_][A-Za-z0-9_]{0,39}$", key):
            continue
        if key in _TPL_RESERVED:                   # 内置变量名不参与展开
            continue
        if isinstance(v, (dict, list)):
            val = json.dumps(v, ensure_ascii=False)
        elif v is None:
            val = ""
        elif isinstance(v, bool):
            val = "true" if v else "false"
        else:
            val = str(v)
        if len(val) > _JSON_VAL_MAX:
            val = val[:_JSON_VAL_MAX] + "…"
        out[key] = val
        if len(out) >= _JSON_VAR_MAX:
            break
    return out


def _notify_preview(data, ok, code, dur, tail, fields):
    """按编辑框里的自定义模板渲染一条通知预览（不发送），用于确认变量替换结果。

    只在「自定义模板」模式下生成；模板留空时回退到「设置 → 定时任务通知」的全局模板，
    与真实发送的口径保持一致。
    """
    if str(data.get("notify_content") or "") != "custom":
        return None
    tpl_title = str(data.get("notify_title") or "").strip()
    tpl_body = str(data.get("notify_body") or "").strip()
    gtpl = {}
    try:
        gtpl = (cronnotify.get_cfg() or {}).get("template") or {}
    except Exception:                                  # noqa: BLE001
        gtpl = {}
    title_tpl = tpl_title or str(gtpl.get("title") or "").strip()
    body_tpl = tpl_body or str(gtpl.get("body") or "").strip()
    if not title_tpl and not body_tpl:
        return None
    vars_ = {"task": str(data.get("name") or "（未命名任务）"),
             "event": "执行成功" if ok else "执行失败",
             "status": "成功" if ok else "失败",
             "exit": "无" if code is None else code,
             "duration": "%.1fs" % (dur / 1000.0),
             "run": "（试运行）", "attempt": "",
             "date": time.strftime("%Y-%m-%d"), "time": time.strftime("%H:%M"),
             "output": tail or ""}
    for k, v in (fields or {}).items():
        vars_.setdefault(k, v)
    return {"title": cronnotify._render_tpl(title_tpl, vars_),
            "body": cronnotify._render_tpl(body_tpl, vars_)}


def _notify_parts(task, run_id, status, code, dur, log_path, tip=""):
    """按任务的通知内容配置组装 (title, body, vars_, tpl)。

    notify_content：
      status      仅执行结果（默认，与旧行为一致）
      output      执行结果 + 脚本输出末尾若干行
      output_only 仅脚本输出（脚本没输出时回退执行结果）
      custom      使用任务级模板 notify_title / notify_body（可引用 {output}）
    """
    name = task.get("name") or task.get("id") or ""
    mode = str(task.get("notify_content") or "status").strip().lower()
    if mode not in crondb.NOTIFY_MODES:
        mode = "status"
    try:
        lines = max(0, int(task.get("notify_lines") or 0))
    except (TypeError, ValueError):
        lines = 20
    tpl = {"title": str(task.get("notify_title") or ""),
           "body": str(task.get("notify_body") or "")}
    # custom 模式下只有模板真的引用了 {output} 才去读日志，避免白读大文件
    need_out = mode in ("output", "output_only") or (
        mode == "custom" and "{output}" in (tpl["title"] + tpl["body"]))
    output = _tail_output(log_path, lines) if need_out else ""
    if status == "success":
        head = "任务「%s」执行成功。\n耗时：%.1fs\n时间：%s\n执行记录：%s" % (
            name, dur / 1000.0, time.strftime("%Y-%m-%d %H:%M:%S"), run_id)
    else:
        head = "任务「%s」执行%s。\n退出码：%s\n耗时：%.1fs\n时间：%s\n执行记录：%s" % (
            name, "超时被终止" if status == "timeout" else "失败",
            "无" if code is None else code, dur / 1000.0,
            time.strftime("%Y-%m-%d %H:%M:%S"), run_id)
    if tip:
        head += "\n" + tip
    if mode == "output" and output:
        body = head + "\n\n▶ 脚本输出（%s）：\n%s" % (
            ("末尾 %d 行" % lines) if lines else "全部", output)
    elif mode == "output_only":
        body = output or head
    else:
        body = head
    # 已拼好脚本输出的正文不再走模板渲染（输出里可能带 { } 花括号，避免被当成变量）
    if mode in ("output", "output_only") and not tpl["body"]:
        tpl["body"] = body
        tpl["raw_body"] = True
    title = "定时任务%s · %s" % (
        {"success": "执行成功", "fail": "失败", "timeout": "超时"}.get(status, "已停止"), name)
    vars_ = {"task": name, "exit": "无" if code is None else code,
             "duration": "%.1fs" % (dur / 1000.0), "run": run_id, "attempt": "",
             "output": output,
             "status": {"success": "成功", "fail": "失败", "timeout": "超时",
                        "killed": "已停止"}.get(status, status)}
    # 自定义模板：脚本输出是 JSON 对象时，把顶层字段也做成变量（如 {order_count}）。
    # 用未做字符截断的原文解析，避免 JSON 被「末尾 N 行 / 长度上限」切坏。
    if mode == "custom" and log_path:
        for k, v in _json_vars(_raw_tail(log_path)).items():
            vars_.setdefault(k, v)                 # 内置变量优先，同名 JSON 字段不覆盖
    return title, body, vars_, tpl


# ---------------------------------------------------------------- 执行
def _run_env():
    """子进程环境：关掉缓冲 / 分页 / 交互提示，避免命令卡在等待输入。"""
    env = dict(os.environ)
    env.update({"PYTHONUNBUFFERED": "1", "FORCE_COLOR": "0",
                "PAGER": "cat", "GIT_PAGER": "cat", "GIT_TERMINAL_PROMPT": "0"})
    return env


def dry_run(data, lines=20):
    """试运行：用编辑框里当前的命令立刻跑一次，只返回输出给前端预览。

    与正式执行的区别：不写执行记录、不计统计、不发通知；
    超时上限 120 秒（防止编辑弹窗里的请求无限挂起），输出最多回传 2 万字符。
    返回 {ok, exit_code, duration, timed_out, output, tail, lines, truncated} 或 {error}。
    """
    data = data or {}
    if not getattr(config, "ENABLE_EXEC", True):
        return {"error": "已禁用命令执行（config.ENABLE_EXEC = False）"}
    cmd = str(data.get("command") or "").strip()
    if not cmd:
        return {"error": "执行命令为空"}
    pre_hook = str(data.get("pre_hook") or "").strip()
    post_hook = str(data.get("post_hook") or "").strip()
    for label, hook in (("前置钩子", pre_hook), ("后置钩子", post_hook), ("主命令", cmd)):
        verdict = check_command(hook)
        if verdict.get("level") == "blocked":
            return {"error": "已拦截危险命令（%s）：%s" % (label, verdict.get("reason"))}
    cwd = str(data.get("cwd") or "").strip() or None
    if cwd and not os.path.isdir(cwd):
        return {"error": "工作目录不存在：%s" % cwd}
    try:
        timeout = max(0, int(data.get("timeout") or 0))
    except (TypeError, ValueError):
        timeout = 0
    timeout = min(timeout, _DRY_TIMEOUT_MAX) if timeout else _DRY_TIMEOUT_MAX
    script = _build_script(cmd, pre_hook, post_hook) if (pre_hook or post_hook) else cmd
    started = time.time()
    try:
        proc = subprocess.Popen(["bash", "-lc", script], cwd=cwd,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                stdin=subprocess.DEVNULL, env=_run_env(),
                                preexec_fn=os.setsid)
    except OSError as e:
        return {"error": "启动失败：%s" % e}
    timed_out = False
    try:
        raw, _ = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        timed_out = True
        _kill_group(proc)
        try:
            raw, _ = proc.communicate(timeout=2)
        except Exception:                              # noqa: BLE001
            raw = b""
    dur = int((time.time() - started) * 1000)
    text = (raw or b"").decode("utf-8", "replace")
    try:
        n = max(0, min(int(lines or 0), 200))
    except (TypeError, ValueError):
        n = 20
    # 通知里会带上的那几行（与 _tail_output 的口径一致：末尾 n 行 + 字符上限）
    rows = text.replace("\r\n", "\n").split("\n")
    while rows and not rows[-1].strip():
        rows.pop()
    tail_rows = rows[-n:] if n else rows
    tail = "\n".join(tail_rows)
    if len(tail) > _NOTIFY_MAX_CHARS:
        tail = "…（仅显示末尾部分）\n" + tail[-_NOTIFY_MAX_CHARS:]
    fields = _json_vars(text)                          # 输出是 JSON 对象时可直接当模板变量用
    truncated = False
    if len(text) > _DRY_OUT_CHARS:                     # 预览别塞爆浏览器
        text = "…（仅显示末尾部分）\n" + text[-_DRY_OUT_CHARS:]
        truncated = True
    ok = (not timed_out) and proc.returncode == 0
    return {"ok": ok,
            "exit_code": proc.returncode, "duration": dur, "timed_out": timed_out,
            "output": text, "tail": tail, "lines": n, "truncated": truncated,
            "fields": fields,
            "preview": _notify_preview(data, ok, proc.returncode, dur, tail, fields)}


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
    env = _run_env()
    started = time.time()
    hook_note = "，含前后置钩子" if (pre_hook or post_hook) else ""
    try:
        fh = open(log_path, "wb")
    except OSError as e:
        return {"error": "创建日志文件失败：%s" % e}
    # 先写开始标记再拉起子进程：两个 fd 各记各的偏移，先启动的话子进程输出会把标记覆盖掉，
    # 表现为日志开头没有「开始执行」，多行命令的第二行还会混进脚本输出里（被当成通知内容）。
    try:
        fh.write(("\n[%s] ▶ 开始执行（%s%s）\n$ %s\n" % (
            time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(started)),
            "手动" if trigger == "manual" else ("重试" if trigger == "retry" else "定时"),
            hook_note, str(cmd).replace("\r", "").replace("\n", " "))).encode("utf-8"))
        fh.flush()
    except OSError:
        pass
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
                title, body, vars_, tpl = _notify_parts(
                    task, run_id, "success", 0 if code is None else code, dur, log_path)
                cronnotify.send(title, body, event="success", vars_=vars_, tpl=tpl,
                                channels=task.get("notify_channels"))
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
        # 通知正文按任务配置组装（可带脚本输出），模板变量由 send 统一渲染
        title, body, vars_, tpl = _notify_parts(task, run_id, status, code, dur, log_path, tip=tip)
        vars_["attempt"] = "第 %d/%d 次" % (nxt, max_retries)
        cronnotify.send(title, body, event="retry", vars_=vars_, tpl=tpl,
                        channels=task.get("notify_channels"))
        return
    # 2) 没有重试名额了（或没配重试）：推送失败 / 超时通知
    if task.get("notify"):
        title, body, vars_, tpl = _notify_parts(task, run_id, status, code, dur, log_path)
        cronnotify.send(title, body, event=status, vars_=vars_, tpl=tpl,
                        channels=task.get("notify_channels"))


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
        rid = _BY_TASK.get(task_id)
        if not rid:
            return None
        # 保险：进程其实已经退出（_watch 还没来得及收尾）就不再算「运行中」，
        # 避免界面 / 统计永远停在「运行中」不动。
        rec = _RUNNING.get(rid) or {}
        proc = rec.get("proc")
        try:
            if proc is not None and proc.poll() is not None:
                return None
        except Exception:                                  # noqa: BLE001
            pass
        return rid


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

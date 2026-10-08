"""定时任务（参考青龙面板）：任务的增删改查、启停、手动运行、执行记录与日志。

GET  /api/cron/tasks           任务列表（带下次运行时间、运行中状态）
POST /api/cron/save            新建 / 更新任务 {id?, name, cron(5或6段), command, cwd, enabled,
                               remark, timeout, max_retries, retry_interval, depends_on,
                               pre_hook, post_hook, notify}
POST /api/cron/delete          删除任务 {id}
POST /api/cron/toggle          启用 / 停用 {id, enabled}
POST /api/cron/run             立即运行一次 {id}
POST /api/cron/stop            停止正在运行的执行 {id | run_id}
GET  /api/cron/runs            执行记录 ?task_id=&limit=
GET  /api/cron/log             执行日志（增量）?run_id=&offset=
POST /api/cron/clear-runs      清空某任务的执行记录 {id}
POST /api/cron/validate        校验 cron 表达式并给出下次运行时间 {cron}
POST /api/cron/suggest         按文件推断命令 / 名称 / 工作目录，供「从文件新建定时任务」预填 {path}
GET  /api/cron/monitor         实时资源监控（系统 CPU / 内存 + 运行中任务的进程占用）
GET  /api/cron/settings        模块设置（日志清理 / 通知配置，密钥脱敏）
POST /api/cron/settings        保存模块设置 {log_days, keep_runs, notify:{...}}
POST /api/cron/notify-test     对指定渠道发测试通知 {channel}
GET  /api/cron/backup          导出全部任务与设置（JSON，供下载备份）
POST /api/cron/restore         恢复备份 {tasks:[...], settings:{...}, mode:"merge"|"replace"}
"""
import os
import shlex
import time

from flask import Blueprint, jsonify, request

from ...log import get_logger
from ...services.ide import crondb, cronnotify, cronsvc, cronutil
from ...services.common.safety import check_command

_log = get_logger()
bp = Blueprint("cron", __name__)


def _next_runs(expr, count=3):
    try:
        c = cronutil.parse_cron(expr)
    except cronutil.CronError:
        return []
    fmt = "%Y-%m-%d %H:%M:%S" if c.seconds is not None else "%Y-%m-%d %H:%M"
    try:
        return [d.strftime(fmt) for d in cronutil.next_runs(c, count=count)]
    except cronutil.CronError:
        return []


def _with_runtime(t):
    """补上界面要用的派生字段：下次运行时间、是否运行中。"""
    d = dict(t)
    d["next"] = _next_runs(t.get("cron") or "", 3) if t.get("enabled") else []
    running_id = cronsvc.running_run_id(t["id"])
    d["running"] = bool(running_id)
    d["run_id"] = running_id or ""
    return d


@bp.route("/api/cron/tasks")
def api_cron_tasks():
    tasks = [_with_runtime(t) for t in crondb.list_tasks()]
    tasks.sort(key=lambda x: (not x.get("enabled"), x.get("created_at") or 0))
    return jsonify({"ok": True, "tasks": tasks,
                    "running": sum(1 for t in tasks if t["running"])})


@bp.route("/api/cron/save", methods=["POST"])
def api_cron_save():
    data = request.get_json(silent=True) or {}
    name = str(data.get("name") or "").strip()
    expr = str(data.get("cron") or "").strip()
    command = str(data.get("command") or "").strip()
    if not name:
        return jsonify({"error": "请填写任务名称"})
    if not command:
        return jsonify({"error": "请填写要执行的命令"})
    ok, tip = cronutil.validate(expr)
    if not ok:
        return jsonify({"error": "cron 表达式非法：" + tip})
    cwd = str(data.get("cwd") or "").strip()
    if cwd and not os.path.isdir(cwd):
        return jsonify({"error": "工作目录不存在：%s" % cwd})
    try:
        timeout = max(0, int(data.get("timeout") or 0))
    except (TypeError, ValueError):
        timeout = 0
    try:
        max_retries = max(0, int(data.get("max_retries") or 0))
    except (TypeError, ValueError):
        max_retries = 0
    try:
        retry_interval = max(1, int(data.get("retry_interval") or 60))
    except (TypeError, ValueError):
        retry_interval = 60
    depends_on = data.get("depends_on") or []
    if isinstance(depends_on, str):
        depends_on = [s.strip() for s in depends_on.split(",") if s.strip()]
    depends_on = [str(s) for s in depends_on if str(s).strip()]
    pre_hook = str(data.get("pre_hook") or "").strip()
    post_hook = str(data.get("post_hook") or "").strip()
    notify = data.get("notify", True) is not False
    enabled = data.get("enabled", True) is not False
    remark = str(data.get("remark") or "").strip()
    tid = str(data.get("id") or "").strip()
    # 依赖任务必须真实存在（依赖自己等于死锁，直接拒绝）
    for dep in depends_on:
        if dep == tid:
            return jsonify({"error": "任务不能依赖自己"})
        if not crondb.get_task(dep):
            return jsonify({"error": "依赖的任务不存在或已被删除，请重新勾选"})
    # 钩子也要过一遍危险命令校验（与主命令同标准）
    for label, hook in (("前置钩子", pre_hook), ("后置钩子", post_hook)):
        verdict = check_command(hook)
        if verdict.get("level") == "blocked":
            return jsonify({"error": "%s被拦截：%s" % (label, verdict.get("reason"))})
    fields = dict(name=name, cron=expr, command=command, cwd=cwd, enabled=enabled,
                  remark=remark, timeout=timeout, max_retries=max_retries,
                  retry_interval=retry_interval, depends_on=",".join(depends_on),
                  pre_hook=pre_hook, post_hook=post_hook, notify=notify)
    if tid:
        if not crondb.get_task(tid):
            return jsonify({"error": "任务不存在"})
        task = crondb.update_task(tid, **fields)
    else:
        task = crondb.create_task(name, expr, command, cwd, enabled, remark, timeout,
                                  max_retries, retry_interval, ",".join(depends_on),
                                  pre_hook, post_hook, notify)
    return jsonify({"ok": True, "task": _with_runtime(task)})


@bp.route("/api/cron/delete", methods=["POST"])
def api_cron_delete():
    data = request.get_json(silent=True) or {}
    tid = str(data.get("id") or "").strip()
    if not crondb.get_task(tid):
        return jsonify({"error": "任务不存在"})
    if cronsvc.is_running(tid):
        cronsvc.stop_task(tid)
    cronsvc.cancel_retry(tid)                      # 取消还没到点的自动重试
    logs = crondb.delete_task(tid)
    for p in logs:
        cronsvc._remove_log(p)                     # 连同该任务的日志文件一起清理
    cronsvc._remove_task_dir(tid)
    return jsonify({"ok": True})


@bp.route("/api/cron/toggle", methods=["POST"])
def api_cron_toggle():
    data = request.get_json(silent=True) or {}
    tid = str(data.get("id") or "").strip()
    task = crondb.get_task(tid)
    if not task:
        return jsonify({"error": "任务不存在"})
    enabled = data.get("enabled")
    if enabled is None:
        enabled = not task.get("enabled")
    return jsonify({"ok": True, "task": _with_runtime(crondb.set_enabled(tid, bool(enabled)))})


@bp.route("/api/cron/run", methods=["POST"])
def api_cron_run():
    data = request.get_json(silent=True) or {}
    tid = str(data.get("id") or "").strip()
    res = cronsvc.start_run(tid, "manual")
    if res.get("error"):
        return jsonify(res)
    return jsonify({"ok": True, "run_id": res["run_id"]})


@bp.route("/api/cron/stop", methods=["POST"])
def api_cron_stop():
    data = request.get_json(silent=True) or {}
    run_id = str(data.get("run_id") or "").strip()
    tid = str(data.get("id") or "").strip()
    res = cronsvc.stop_run(run_id) if run_id else cronsvc.stop_task(tid)
    if res.get("error"):
        return jsonify(res)
    return jsonify({"ok": True})


@bp.route("/api/cron/runs")
def api_cron_runs():
    tid = (request.args.get("task_id") or "").strip()
    try:
        limit = int(request.args.get("limit") or 50)
    except ValueError:
        limit = 50
    runs = crondb.list_runs(tid or None, limit)
    return jsonify({"ok": True, "runs": runs})


@bp.route("/api/cron/log")
def api_cron_log():
    run_id = (request.args.get("run_id") or "").strip()
    try:
        offset = int(request.args.get("offset") or 0)
    except ValueError:
        offset = 0
    res = cronsvc.read_log(run_id, offset)
    if res.get("error"):
        return jsonify(res)
    return jsonify({"ok": True, **res})


@bp.route("/api/cron/clear-runs", methods=["POST"])
def api_cron_clear_runs():
    data = request.get_json(silent=True) or {}
    tid = str(data.get("id") or "").strip()
    if not crondb.get_task(tid):
        return jsonify({"error": "任务不存在"})
    removed = crondb.clear_runs(tid)               # 只清非运行中的记录
    for r in removed:
        cronsvc._remove_log(r.get("log_path"))
    return jsonify({"ok": True, "removed": len(removed)})


@bp.route("/api/cron/validate", methods=["POST"])
def api_cron_validate():
    data = request.get_json(silent=True) or {}
    expr = str(data.get("cron") or "").strip()
    ok, tip = cronutil.validate(expr)
    return jsonify({"ok": ok, "tip": tip, "next": _next_runs(expr, 3) if ok else []})


@bp.route("/api/cron/suggest", methods=["POST"])
def api_cron_suggest():
    """给「从文件新建定时任务」预填内容：按扩展名推断解释器 + 绝对路径 + 工作目录。

    复用运行模块的 _RUNNERS / _project_runtime，所以项目自带 venv、node_modules/.bin
    等「就近运行环境」的判断与 F5 运行完全一致（例如 .py 会用项目里的 .venv/bin/python）。
    """
    from ...services.ide import envprobe
    from . import run as runmod
    data = request.get_json(silent=True) or {}
    path = str(data.get("path") or "").strip()
    if not path or not os.path.isfile(path):
        return jsonify({"error": "文件不存在"})
    path = os.path.abspath(path)
    base = os.path.basename(path)
    stem = os.path.splitext(base)[0] or base
    ext = os.path.splitext(path)[1].lower().lstrip(".")
    cwd = os.path.dirname(path) or "."
    runner = runmod._RUNNERS.get(ext)
    label = ""
    if runner:
        exe, label = runner
        try:
            proj_exe, _prepend, _note = runmod._project_runtime(path, exe)
            interp = proj_exe or envprobe.resolve_exe(exe) or exe
        except Exception:                              # noqa: BLE001
            interp = exe
        command = "%s %s" % (shlex.quote(interp), shlex.quote(path))
    else:                                              # 未知类型：按可执行文件处理
        command = shlex.quote(path)
    return jsonify({"ok": True, "name": stem, "command": command, "cwd": cwd,
                    "runner": label, "ext": ext})


# ---------------------------------------------------------------- 资源监控
@bp.route("/api/cron/monitor")
def api_cron_monitor():
    """系统 CPU / 内存 + 正在运行的定时任务进程占用（供管理页监控条轮询）。"""
    res = cronsvc.monitor()
    return jsonify({"ok": True, **res})


# ---------------------------------------------------------------- 模块设置 / 通知
@bp.route("/api/cron/settings")
def api_cron_settings():
    """读取模块设置：日志清理 + 通知配置（密钥类字段脱敏）。"""
    return jsonify({
        "ok": True,
        "log_days": crondb.get_setting("log_days", 0),
        "keep_runs": crondb.get_setting("keep_runs", 50),
        "notify": cronnotify.sanitize_cfg(),
    })


@bp.route("/api/cron/settings", methods=["POST"])
def api_cron_settings_save():
    """保存模块设置：log_days（日志保留天数，0 不限）/ keep_runs（每任务保留条数）/ notify。"""
    data = request.get_json(silent=True) or {}
    if "log_days" in data:
        try:
            days = max(0, int(data.get("log_days") or 0))
        except (TypeError, ValueError):
            days = 0
        crondb.set_setting("log_days", days)
    if "keep_runs" in data:
        try:
            keep = max(1, int(data.get("keep_runs") or 50))
        except (TypeError, ValueError):
            keep = 50
        crondb.set_setting("keep_runs", keep)
    notify = data.get("notify")
    notify_saved = None
    if isinstance(notify, dict):
        notify_saved = cronnotify.save_cfg(notify)
    return jsonify({"ok": True,
                    "log_days": crondb.get_setting("log_days", 0),
                    "keep_runs": crondb.get_setting("keep_runs", 50),
                    "notify": notify_saved or cronnotify.sanitize_cfg()})


@bp.route("/api/cron/notify-test", methods=["POST"])
def api_cron_notify_test():
    """对指定渠道发一条测试通知（忽略总开关）。channel: desktop/email/dingtalk/telegram/pushplus/all"""
    data = request.get_json(silent=True) or {}
    res = cronnotify.test(data.get("channel") or "all")
    return jsonify({"ok": True, "results": res})


@bp.route("/api/cron/notify-history")
def api_cron_notify_history():
    """定时任务触发的通知记录（按来源过滤，最新在前，最多 50 条）。"""
    return jsonify({"ok": True, "records": cronnotify.history(50)})


# ---------------------------------------------------------------- 备份 / 恢复
@bp.route("/api/cron/backup")
def api_cron_backup():
    """导出全部任务与设置（JSON）。密钥类通知配置已脱敏，可安全保存 / 分享。"""
    return jsonify({
        "ok": True,
        "app": "File_Flask",
        "kind": "cron-backup",
        "version": 1,
        "exported_at": time.time(),
        "tasks": crondb.list_tasks(),
        "settings": {
            "log_days": crondb.get_setting("log_days", 0),
            "keep_runs": crondb.get_setting("keep_runs", 50),
        },
        "notify": cronnotify.sanitize_cfg(),
    })


def _coerce_task(raw):
    """把备份文件里的一条任务整理成合法字段；不合法返回 None。"""
    if not isinstance(raw, dict):
        return None
    name = str(raw.get("name") or "").strip()
    expr = str(raw.get("cron") or "").strip()
    command = str(raw.get("command") or "").strip()
    if not name or not command:
        return None
    ok, _tip = cronutil.validate(expr)
    if not ok:
        return None

    def _int(v, d, lo=0):
        try:
            return max(lo, int(v or 0))
        except (TypeError, ValueError):
            return d

    deps = raw.get("depends_on") or []
    if isinstance(deps, str):
        deps = [s.strip() for s in deps.split(",") if s.strip()]
    return {
        "tid": str(raw.get("id") or "").strip() or None,
        "name": name, "cron": expr, "command": command,
        "cwd": str(raw.get("cwd") or "").strip(),
        "enabled": bool(raw.get("enabled")),
        "remark": str(raw.get("remark") or "").strip(),
        "timeout": _int(raw.get("timeout"), 0),
        "max_retries": _int(raw.get("max_retries"), 0),
        "retry_interval": max(1, _int(raw.get("retry_interval"), 60)),
        "depends_on": ",".join(str(s) for s in deps if str(s).strip()),
        "pre_hook": str(raw.get("pre_hook") or "").strip(),
        "post_hook": str(raw.get("post_hook") or "").strip(),
        "notify": raw.get("notify", True) is not False,
    }


@bp.route("/api/cron/restore", methods=["POST"])
def api_cron_restore():
    """从备份 JSON 恢复。mode: merge（默认，保留现有任务）/ replace（先清空再导入）。

    导入时尽量保留原任务 id（未被占用时），这样任务间的依赖关系也能一并恢复。
    """
    data = request.get_json(silent=True) or {}
    tasks = data.get("tasks")
    if not isinstance(tasks, list) or not tasks:
        return jsonify({"error": "备份文件里没有任务数据"})
    mode = data.get("mode") or "merge"
    if mode == "replace":
        for t in crondb.list_tasks():
            tid = t["id"]
            if cronsvc.is_running(tid):
                cronsvc.stop_task(tid)
            cronsvc.cancel_retry(tid)
            for p in crondb.delete_task(tid):
                cronsvc._remove_log(p)
            cronsvc._remove_task_dir(tid)
    existing = {t["id"] for t in crondb.list_tasks()}
    imported, skipped = 0, 0
    for raw in tasks:
        f = _coerce_task(raw)
        if not f:
            skipped += 1
            continue
        tid = None
        if f["tid"] and f["tid"] not in existing:      # 原 id 未被占用：保留（依赖关系随之恢复）
            tid = f["tid"]
            existing.add(tid)
        crondb.create_task(f["name"], f["cron"], f["command"], cwd=f["cwd"],
                           enabled=f["enabled"], remark=f["remark"], timeout=f["timeout"],
                           max_retries=f["max_retries"], retry_interval=f["retry_interval"],
                           depends_on=f["depends_on"], pre_hook=f["pre_hook"],
                           post_hook=f["post_hook"], notify=f["notify"], tid=tid)
        imported += 1
    st = data.get("settings")
    if isinstance(st, dict):
        for key in ("log_days", "keep_runs"):
            if key in st:
                try:
                    crondb.set_setting(key, max(0, int(st[key] or 0)))
                except (TypeError, ValueError):
                    pass
    _log.info("定时任务备份恢复完成：导入 %d 个任务，跳过 %d 条（%s）", imported, skipped, mode)
    return jsonify({"ok": True, "imported": imported, "skipped": skipped, "mode": mode})

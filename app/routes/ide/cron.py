"""定时任务（参考青龙面板）：任务的增删改查、启停、手动运行、执行记录与日志。

GET  /api/cron/tasks           任务列表（带下次运行时间、运行中状态）
POST /api/cron/save            新建 / 更新任务 {id?, name, cron, command, cwd, enabled, remark, timeout}
POST /api/cron/delete          删除任务 {id}
POST /api/cron/toggle          启用 / 停用 {id, enabled}
POST /api/cron/run             立即运行一次 {id}
POST /api/cron/stop            停止正在运行的执行 {id | run_id}
GET  /api/cron/runs            执行记录 ?task_id=&limit=
GET  /api/cron/log             执行日志（增量）?run_id=&offset=
POST /api/cron/clear-runs      清空某任务的执行记录 {id}
POST /api/cron/validate        校验 cron 表达式并给出下次运行时间 {cron}
POST /api/cron/suggest         按文件推断命令 / 名称 / 工作目录，供「从文件新建定时任务」预填 {path}
"""
import os
import shlex

from flask import Blueprint, jsonify, request

from ...log import get_logger
from ...services.ide import crondb, cronsvc, cronutil

_log = get_logger()
bp = Blueprint("cron", __name__)


def _next_runs(expr, count=3):
    try:
        return [d.strftime("%Y-%m-%d %H:%M") for d in cronutil.next_runs(expr, count=count)]
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
    enabled = data.get("enabled", True) is not False
    remark = str(data.get("remark") or "").strip()
    tid = str(data.get("id") or "").strip()
    if tid:
        if not crondb.get_task(tid):
            return jsonify({"error": "任务不存在"})
        task = crondb.update_task(tid, name=name, cron=expr, command=command, cwd=cwd,
                                  enabled=enabled, remark=remark, timeout=timeout)
    else:
        task = crondb.create_task(name, expr, command, cwd, enabled, remark, timeout)
    return jsonify({"ok": True, "task": _with_runtime(task)})


@bp.route("/api/cron/delete", methods=["POST"])
def api_cron_delete():
    data = request.get_json(silent=True) or {}
    tid = str(data.get("id") or "").strip()
    if not crondb.get_task(tid):
        return jsonify({"error": "任务不存在"})
    if cronsvc.is_running(tid):
        cronsvc.stop_task(tid)
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

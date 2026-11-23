"""任务进度 SSE 流式接口：/api/progress/stream?task_id=xxx

一个长连接推送整个任务生命周期的进度，替代前端 400ms 一次的轮询。
统一聚合 删除 / 压缩 / 解压 三类任务（结构一致），并提供暂停 / 继续 / 停止控制。
"""
import json
import time

from flask import Blueprint, Response, jsonify, request

from ...log import get_logger

_log = get_logger()

bp = Blueprint("progress_stream", __name__)

_STREAM_INTERVAL = 0.3       # 服务端检测进度变化的间隔（秒）
_MAX_STREAM_SECONDS = 3600   # 单个流最长挂 1 小时，兜底防泄漏
_PAUSE_POLL = 0.12           # 暂停中 worker 的轮询间隔（秒）
_MAX_PAUSE_SECONDS = 1800    # 暂停超过 30 分钟没人恢复就自动停止（与任务注册表清理时长一致，避免线程永久挂起）


class TaskCanceled(Exception):
    """任务被用户停止：worker 抛出该异常即可结束当前任务。"""


def task_checkpoint(task, lock):
    """worker 循环中的检查点：暂停时原地阻塞，停止时抛 TaskCanceled。

    lock 为该任务注册表对应的锁，读取 paused / canceled 时必须持锁，
    避免与 /api/tasks/control 的写入互相踩踏。
    """
    while True:
        with lock:
            if task.get("canceled"):
                raise TaskCanceled()
            if not task.get("paused"):
                return
            paused_at = task.get("paused_at") or 0
        if paused_at and time.time() - paused_at > _MAX_PAUSE_SECONDS:
            with lock:
                task["paused"] = False
                task["canceled"] = True
            raise TaskCanceled()
        time.sleep(_PAUSE_POLL)


def iter_task_registries():
    """遍历所有任务注册表：(kind, tasks, lock)。

    与前端种类对应：zip=压缩、unzip=解压、delete=删除、move_copy=移动/复制。
    """
    from .delete import _DELETE_TASKS, _TASKS_LOCK
    from .zip import _ZIP_CREATE_TASKS, _ZIP_CREATE_LOCK, _UNZIP_TASKS, _UNZIP_LOCK
    from .fileops import _MOVE_COPY_TASKS, _MOVE_COPY_LOCK

    return (
        ("zip", _ZIP_CREATE_TASKS, _ZIP_CREATE_LOCK),
        ("unzip", _UNZIP_TASKS, _UNZIP_LOCK),
        ("delete", _DELETE_TASKS, _TASKS_LOCK),
        ("move_copy", _MOVE_COPY_TASKS, _MOVE_COPY_LOCK),
    )


def _snapshot(task_id, detail=False):
    """从三类任务注册表中读取快照，不存在返回 None。

    detail=True 时才附带移动 / 复制的逐条、逐文件明细（几百行 JSON 体积不小，
    只在移动 / 复制任务上按需传输）。
    """
    items_snap, files_snap = [], []
    for _kind, tasks, lock in iter_task_registries():
        with lock:
            task = tasks.get(task_id)
            if task is None:
                continue
            snap = dict(task)
            if detail:
                # 逐条 / 逐文件明细必须在锁内复制一份，
                # 否则序列化时正被 worker 改写会抛「dict changed size」
                items_snap = [dict(it) for it in (task.get("items") or [])]
                files_snap = [dict(f) for f in (task.get("files") or [])]
            break
    else:
        return None

    total_bytes = snap.get("total_bytes") or 0
    done_bytes = min(snap.get("done_bytes") or 0, total_bytes)
    total_files = snap.get("total_files") or 0
    done_files = min(snap.get("done_files") or 0, total_files)
    if total_bytes > 0:
        percent = done_bytes / total_bytes * 100
    elif total_files > 0:
        percent = done_files / total_files * 100
    else:
        percent = 100 if snap["status"] != "running" else 0
    errors = snap.get("errors") or []
    if not errors and snap.get("error"):
        errors = [snap["error"]]
    phase = snap.get("phase") or "running"
    out = {
        "status": snap["status"],
        # 删除任务分两段：scanning（统计文件）-> deleting（搬进回收站）
        "phase": phase,
        "current": snap.get("current", ""),
        # 删除任务：最近搬进回收站的条目（前端「实时删除进度表」）
        "recent": (snap.get("recent") or [])[-40:],
        "done_files": done_files,
        "total_files": total_files,
        "done_bytes": done_bytes,
        "total_bytes": total_bytes,
        # 统计阶段用「已扫描字节」估算剩余时间，删除阶段用「已删除字节」
        "scan_done": snap.get("scan_done") or 0,
        "processed_bytes": (snap.get("scan_bytes") or 0) if phase == "scanning" else done_bytes,
        "percent": round(percent, 1),
        # 用户暂停 / 停止状态（状态仍是 running，仅靠这两个开关驱动 worker）
        "paused": bool(snap.get("paused")),
        "canceled": bool(snap.get("canceled")),
        "errors": errors,
        "result": snap.get("result"),
    }
    if detail:
        # 移动 / 复制：顶层条目进度 + 每个文件的进度明细（前端「详情」展开用）
        out["items"] = items_snap
        out["files"] = files_snap
        out["detail_total"] = snap.get("detail_total") or total_files
    return out


def _gen(task_id, detail=False):
    last_sig = None
    deadline = time.time() + _MAX_STREAM_SECONDS
    while time.time() < deadline:
        snap = _snapshot(task_id, detail)
        if snap is None:
            if last_sig is None:
                # 任务从未存在：发一条错误后关闭
                yield "data: " + json.dumps(
                    {"error": "任务不存在或已过期"}, ensure_ascii=False) + "\n\n"
            return
        sig = (snap["status"], snap["percent"], snap["done_files"],
               snap["done_bytes"], snap["current"], len(snap["errors"]),
               len(snap.get("recent") or []),
               snap.get("paused"), snap.get("canceled"),
               snap.get("phase"), snap.get("scan_done"))
        if sig != last_sig or snap["status"] != "running":
            yield "data: " + json.dumps(snap, ensure_ascii=False) + "\n\n"
            last_sig = sig
        if snap["status"] != "running":
            return
        time.sleep(_STREAM_INTERVAL)


@bp.route("/api/progress/stream")
def api_progress_stream():
    """SSE：单连接实时推送任务进度，任务结束自动关闭。"""
    task_id = request.args.get("task_id", "")
    if not task_id:
        return jsonify({"error": "缺少 task_id"}), 400
    # detail=1：附带移动 / 复制的逐条、逐文件明细
    detail = (request.args.get("detail") or "") in ("1", "true", "yes")
    resp = Response(_gen(task_id, detail), mimetype="text/event-stream")
    resp.headers["Cache-Control"] = "no-cache"
    resp.headers["X-Accel-Buffering"] = "no"
    return resp


@bp.route("/api/tasks/control", methods=["POST"])
def api_tasks_control():
    """暂停 / 继续 / 停止一个后台任务。

    worker 在循环里调用 task_checkpoint()，这里只改开关：
      pause  -> paused=True（worker 在检查点原地等待）
      resume -> paused=False
      stop   -> canceled=True（worker 抛 TaskCanceled 并自行清理半成品）
    """
    data = request.get_json(silent=True) or {}
    task_id = (data.get("task_id") or "").strip()
    action = (data.get("action") or "").strip()
    if not task_id or action not in ("pause", "resume", "stop"):
        return jsonify({"error": "参数不合法"}), 400

    for _kind, tasks, lock in iter_task_registries():
        with lock:
            task = tasks.get(task_id)
            if task is None:
                continue
            if task.get("status") != "running" or task.get("canceled"):
                return jsonify({"error": "任务已结束，无法继续操作"}), 409
            if action == "pause":
                task["paused"] = True
                task["paused_at"] = time.time()
            elif action == "resume":
                task["paused"] = False
                task.pop("paused_at", None)
            else:
                task["canceled"] = True
                task["paused"] = False
                task.pop("paused_at", None)
            _log.info("task control: %s %s", task_id, action)
            return jsonify({
                "success": True,
                "task_id": task_id,
                "action": action,
                "paused": bool(task.get("paused")),
                "canceled": bool(task.get("canceled")),
            })
    return jsonify({"error": "任务不存在或已过期"}), 404

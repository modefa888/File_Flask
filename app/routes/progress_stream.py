"""任务进度 SSE 流式接口：/api/progress/stream?task_id=xxx

一个长连接推送整个任务生命周期的进度，替代前端 400ms 一次的轮询。
统一聚合 删除 / 压缩 / 解压 三类任务（结构一致）。
"""
import json
import time

from flask import Blueprint, Response, jsonify, request

from ..log import get_logger

_log = get_logger()

bp = Blueprint("progress_stream", __name__)

_STREAM_INTERVAL = 0.3       # 服务端检测进度变化的间隔（秒）
_MAX_STREAM_SECONDS = 3600   # 单个流最长挂 1 小时，兜底防泄漏


def _snapshot(task_id):
    """从三类任务注册表中读取快照，不存在返回 None。"""
    from .delete import _DELETE_TASKS, _TASKS_LOCK
    from .zip import _ZIP_CREATE_TASKS, _ZIP_CREATE_LOCK, _UNZIP_TASKS, _UNZIP_LOCK
    from .fileops import _MOVE_COPY_TASKS, _MOVE_COPY_LOCK

    for tasks, lock in (
        (_DELETE_TASKS, _TASKS_LOCK),
        (_ZIP_CREATE_TASKS, _ZIP_CREATE_LOCK),
        (_UNZIP_TASKS, _UNZIP_LOCK),
        (_MOVE_COPY_TASKS, _MOVE_COPY_LOCK),
    ):
        with lock:
            task = tasks.get(task_id)
            if task is None:
                continue
            snap = dict(task)
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
    return {
        "status": snap["status"],
        "current": snap.get("current", ""),
        "done_files": done_files,
        "total_files": total_files,
        "done_bytes": done_bytes,
        "total_bytes": total_bytes,
        "percent": round(percent, 1),
        "errors": errors,
        "result": snap.get("result"),
    }


def _gen(task_id):
    last_sig = None
    deadline = time.time() + _MAX_STREAM_SECONDS
    while time.time() < deadline:
        snap = _snapshot(task_id)
        if snap is None:
            if last_sig is None:
                # 任务从未存在：发一条错误后关闭
                yield "data: " + json.dumps(
                    {"error": "任务不存在或已过期"}, ensure_ascii=False) + "\n\n"
            return
        sig = (snap["status"], snap["percent"], snap["done_files"],
               snap["done_bytes"], snap["current"], len(snap["errors"]))
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
    resp = Response(_gen(task_id), mimetype="text/event-stream")
    resp.headers["Cache-Control"] = "no-cache"
    resp.headers["X-Accel-Buffering"] = "no"
    return resp

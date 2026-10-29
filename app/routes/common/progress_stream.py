"""任务进度 SSE 流式接口：/api/progress/stream?task_id=xxx

一个长连接推送整个任务生命周期的进度，替代前端 400ms 一次的轮询。
统一聚合 删除 / 压缩 / 解压 三类任务（结构一致）。
"""
import json
import time

from flask import Blueprint, Response, jsonify, request

from ...log import get_logger

_log = get_logger()

bp = Blueprint("progress_stream", __name__)

_STREAM_INTERVAL = 0.3       # 服务端检测进度变化的间隔（秒）
_MAX_STREAM_SECONDS = 3600   # 单个流最长挂 1 小时，兜底防泄漏


def _snapshot(task_id, detail=False):
    """从三类任务注册表中读取快照，不存在返回 None。

    detail=True 时才附带移动 / 复制的逐条、逐文件明细（几百行 JSON 体积不小，
    只在移动 / 复制任务上按需传输）。
    """
    from .delete import _DELETE_TASKS, _TASKS_LOCK
    from .zip import _ZIP_CREATE_TASKS, _ZIP_CREATE_LOCK, _UNZIP_TASKS, _UNZIP_LOCK
    from .fileops import _MOVE_COPY_TASKS, _MOVE_COPY_LOCK

    items_snap, files_snap = [], []
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
    out = {
        "status": snap["status"],
        "current": snap.get("current", ""),
        # 删除任务：最近搬进回收站的条目（前端「实时删除进度表」）
        "recent": (snap.get("recent") or [])[-40:],
        "done_files": done_files,
        "total_files": total_files,
        "done_bytes": done_bytes,
        "total_bytes": total_bytes,
        "percent": round(percent, 1),
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
               len(snap.get("recent") or []))
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

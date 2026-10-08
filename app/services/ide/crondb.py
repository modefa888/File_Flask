"""定时任务存储层（SQLite / store.db 的 cron_tasks + cron_runs 两张表）。

只做纯粹的增删改查，不涉及进程与文件；调度与执行见 cronsvc.py。
"""
import time
import uuid

from ...log import get_logger
from ..common.store_db import store_conn, store_tx

_log = get_logger()

_TASK_COLS = ("id", "name", "cron", "command", "cwd", "enabled", "remark", "timeout",
              "created_at", "updated_at", "last_at", "last_status", "last_ms", "last_exit",
              "run_count", "ok_count", "fail_count")


def _task_dict(row):
    if not row:
        return None
    d = {k: row[k] for k in _TASK_COLS}
    d["enabled"] = bool(d.get("enabled"))
    return d


def _run_dict(row):
    if not row:
        return None
    return {k: row[k] for k in row.keys()}


def _query(sql, args=()):
    conn = store_conn()
    try:
        return conn.execute(sql, args).fetchall()
    finally:
        conn.close()


# ---------------------------------------------------------------- 任务
def list_tasks():
    rows = _query("SELECT * FROM cron_tasks ORDER BY created_at ASC")
    return [_task_dict(r) for r in rows]


def get_task(tid):
    rows = _query("SELECT * FROM cron_tasks WHERE id=?", (str(tid or ""),))
    return _task_dict(rows[0]) if rows else None


def create_task(name, cron, command, cwd="", enabled=True, remark="", timeout=0):
    now = time.time()
    tid = uuid.uuid4().hex[:12]
    with store_tx() as conn:
        conn.execute(
            "INSERT INTO cron_tasks (id, name, cron, command, cwd, enabled, remark, timeout,"
            " created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
            (tid, name, cron, command, cwd, 1 if enabled else 0, remark, int(timeout or 0), now, now))
    return get_task(tid)


def update_task(tid, **fields):
    allowed = ("name", "cron", "command", "cwd", "enabled", "remark", "timeout")
    sets, args = [], []
    for k in allowed:
        if k not in fields:
            continue
        v = fields[k]
        sets.append(k + "=?")
        args.append(1 if (k == "enabled" and bool(v)) else (0 if k == "enabled" else v))
    if sets:
        sets.append("updated_at=?")
        args.append(time.time())
        args.append(str(tid))
        with store_tx() as conn:
            conn.execute("UPDATE cron_tasks SET " + ", ".join(sets) + " WHERE id=?", tuple(args))
    return get_task(tid)


def set_enabled(tid, enabled):
    with store_tx() as conn:
        conn.execute("UPDATE cron_tasks SET enabled=?, updated_at=? WHERE id=?",
                     (1 if enabled else 0, time.time(), str(tid)))
    return get_task(tid)


def delete_task(tid):
    """删除任务及其执行历史，返回被删记录的日志路径（供上层清理日志文件）。"""
    tid = str(tid)
    rows = _query("SELECT log_path FROM cron_runs WHERE task_id=?", (tid,))
    logs = [r["log_path"] for r in rows if r["log_path"]]
    with store_tx() as conn:
        conn.execute("DELETE FROM cron_tasks WHERE id=?", (tid,))
        conn.execute("DELETE FROM cron_runs WHERE task_id=?", (tid,))
    return logs


def bump_task_stats(tid, status, ms=0, exit_code=None, at=None):
    """任务跑完回写统计：最近一次状态 / 耗时 / 累计次数。"""
    ok = 1 if status == "success" else 0
    fail = 0 if status in ("success", "running", "killed") else 1
    with store_tx() as conn:
        conn.execute(
            "UPDATE cron_tasks SET last_at=?, last_status=?, last_ms=?, last_exit=?,"
            " run_count=run_count+1, ok_count=ok_count+?, fail_count=fail_count+? WHERE id=?",
            (float(at or time.time()), status, int(ms or 0), exit_code, ok, fail, str(tid)))


# ---------------------------------------------------------------- 执行历史
def insert_run(run_id, task_id, task_name, trigger, log_path, started_at=None):
    with store_tx() as conn:
        conn.execute(
            "INSERT INTO cron_runs (id, task_id, task_name, trigger, status, started_at, log_path)"
            " VALUES (?,?,?,?,?,?,?)",
            (run_id, str(task_id), task_name, trigger, "running",
             float(started_at or time.time()), log_path))


def finish_run(run_id, status, exit_code=None, duration=0, log_size=0, ended_at=None):
    with store_tx() as conn:
        conn.execute(
            "UPDATE cron_runs SET status=?, exit_code=?, duration=?, log_size=?, ended_at=? WHERE id=?",
            (status, exit_code, int(duration or 0), int(log_size or 0),
             float(ended_at or time.time()), run_id))


def list_runs(task_id=None, limit=50):
    limit = max(1, min(int(limit or 50), 200))
    if task_id:
        rows = _query("SELECT * FROM cron_runs WHERE task_id=? ORDER BY started_at DESC LIMIT ?",
                      (str(task_id), limit))
    else:
        rows = _query("SELECT * FROM cron_runs ORDER BY started_at DESC LIMIT ?", (limit,))
    return [_run_dict(r) for r in rows]


def get_run(run_id):
    rows = _query("SELECT * FROM cron_runs WHERE id=?", (str(run_id or ""),))
    return _run_dict(rows[0]) if rows else None


def running_runs():
    rows = _query("SELECT * FROM cron_runs WHERE status='running'")
    return [_run_dict(r) for r in rows]


def prune_runs(task_id, keep=50):
    """只保留某任务最近 keep 条执行记录，返回被删记录（供上层清理日志文件）。"""
    keep = max(1, int(keep or 50))
    rows = _query("SELECT id, log_path FROM cron_runs WHERE task_id=?"
                  " ORDER BY started_at DESC LIMIT -1 OFFSET ?", (str(task_id), keep))
    dropped = [{"id": r["id"], "log_path": r["log_path"]} for r in rows]
    if dropped:
        with store_tx() as conn:
            for r in dropped:
                conn.execute("DELETE FROM cron_runs WHERE id=?", (r["id"],))
    return dropped


def clear_runs(task_id):
    """清空某任务的执行记录（保留正在运行的那条），返回被删记录。"""
    rows = _query("SELECT id, log_path FROM cron_runs WHERE task_id=? AND status!='running'",
                  (str(task_id),))
    dropped = [{"id": r["id"], "log_path": r["log_path"]} for r in rows]
    if dropped:
        with store_tx() as conn:
            conn.execute("DELETE FROM cron_runs WHERE task_id=? AND status!='running'", (str(task_id),))
    return dropped

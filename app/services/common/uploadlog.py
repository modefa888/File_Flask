"""上传记录服务（store.db 的 upload_history 表）。

每条记录 = 一次分片上传「合并」的结果（成功或失败），
供文件管理顶栏「上传记录」抽屉查看。只保留最近 `_MAX_ROWS` 条，写入后顺手裁剪。
"""
import datetime

from ...log import get_logger
from .store_db import store_conn, store_tx


_log = get_logger()

_MAX_ROWS = 3000          # 最多保留多少条上传记录


def add_record(name="", rel="", target_dir="", path="", size=0,
               cost_ms=0, ok=True, error="", user="", ip=""):
    """写入一条上传记录；失败只记日志，绝不影响上传本身。"""
    try:
        ts = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        with store_tx() as conn:
            conn.execute(
                "INSERT INTO upload_history "
                "(ts, name, rel, dir, path, size, cost_ms, ok, error, user, ip) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (ts, name or "", rel or "", target_dir or "", path or "",
                 int(size or 0), int(cost_ms or 0), 1 if ok else 0,
                 error or "", user or "", ip or ""))
            # 裁剪：只留最近 N 条，避免库无限增长
            conn.execute(
                "DELETE FROM upload_history WHERE id <= "
                "(SELECT MAX(id) FROM upload_history) - ?", (_MAX_ROWS,))
    except Exception as e:
        _log.warning("写入上传记录失败: %s", e)


def list_records(q="", status="", page=1, page_size=50):
    """分页查询，返回 (总数, 当前页记录列表)。"""
    q = (q or "").strip()
    status = (status or "").strip()
    where, args = [], []
    if q:
        where.append("(name LIKE ? OR rel LIKE ? OR dir LIKE ?)")
        like = "%" + q + "%"
        args += [like, like, like]
    if status == "ok":
        where.append("ok = 1")
    elif status == "fail":
        where.append("ok = 0")
    w = ("WHERE " + " AND ".join(where)) if where else ""
    try:
        page = max(1, int(page or 1))
    except Exception:
        page = 1
    try:
        page_size = max(1, min(200, int(page_size or 50)))
    except Exception:
        page_size = 50
    try:
        conn = store_conn()
        try:
            total = conn.execute(
                "SELECT COUNT(1) FROM upload_history " + w, args).fetchone()[0]
            rows = conn.execute(
                "SELECT id, ts, name, rel, dir, path, size, cost_ms, ok, error, user, ip, missing "
                "FROM upload_history " + w + " ORDER BY id DESC LIMIT ? OFFSET ?",
                args + [page_size, (page - 1) * page_size]).fetchall()
        finally:
            conn.close()
        return int(total or 0), [dict(r) for r in rows]
    except Exception as e:
        _log.warning("读取上传记录失败: %s", e)
        return 0, []


def stats():
    """顶部汇总：总条数 / 成功 / 失败 / 总字节。"""
    try:
        conn = store_conn()
        try:
            row = conn.execute(
                "SELECT COUNT(1), "
                "COALESCE(SUM(CASE WHEN ok=1 THEN 1 ELSE 0 END),0), "
                "COALESCE(SUM(CASE WHEN ok=0 THEN 1 ELSE 0 END),0), "
                "COALESCE(SUM(size),0) FROM upload_history").fetchone()
        finally:
            conn.close()
        return {"total": int(row[0] or 0), "ok": int(row[1] or 0),
                "fail": int(row[2] or 0), "bytes": int(row[3] or 0)}
    except Exception:
        return {"total": 0, "ok": 0, "fail": 0, "bytes": 0}


def mark_missing(rec_id, missing=True):
    """标记 / 取消标记某条记录：文件已不在原位置（前端点记录跳转后确认找不到时调用）。"""
    try:
        rec_id = int(rec_id or 0)
    except Exception:
        return False
    if rec_id <= 0:
        return False
    try:
        with store_tx() as conn:
            conn.execute("UPDATE upload_history SET missing=? WHERE id=?",
                         (1 if missing else 0, rec_id))
        return True
    except Exception as e:
        _log.warning("标记上传记录 missing 失败: %s", e)
        return False


def clear_records():
    """清空全部上传记录。"""
    try:
        with store_tx() as conn:
            conn.execute("DELETE FROM upload_history")
        return True
    except Exception as e:
        _log.warning("清空上传记录失败: %s", e)
        return False

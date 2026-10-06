"""压缩 / 解压历史记录服务（SQLite：data/storage/store.db 的 archive_history 表）。"""
import os
import threading
import time
import uuid

from ...config import _STORAGE_DIR
from ...log import get_logger
from .store_db import store_conn, store_tx, migrate_json_once

_log = get_logger()
_ARCHIVE_HISTORY_FILE = os.path.join(_STORAGE_DIR, ".file_manager_archive_history.json")
_ARCHIVE_HISTORY_LOCK = threading.Lock()

# 只保留最近 N 条
_MAX_RECORDS = 300


def _load():
    """加载压缩/解压历史（按记录先后升序，与旧 JSON 数组顺序一致）。"""
    try:
        conn = store_conn()
        try:
            rows = conn.execute(
                "SELECT id, kind, name, path, detail, time FROM archive_history ORDER BY seq ASC"
            ).fetchall()
        finally:
            conn.close()
        return [{"id": r["id"], "kind": r["kind"], "name": r["name"],
                 "path": r["path"], "detail": r["detail"], "time": r["time"]} for r in rows]
    except Exception:
        return []


def _insert(conn, it):
    conn.execute(
        "INSERT OR REPLACE INTO archive_history (id, kind, name, path, detail, time) "
        "VALUES (?,?,?,?,?,?)",
        (it.get("id") or "", it.get("kind") or "", it.get("name") or "",
         it.get("path") or "", it.get("detail") or "", float(it.get("time") or 0)))


def _save(items):
    """整表覆盖写入（保持调用方原有的「列表读写」语义）。"""
    try:
        with store_tx() as conn:
            conn.execute("DELETE FROM archive_history")
            for it in items or []:
                if isinstance(it, dict):
                    _insert(conn, it)
    except Exception as e:
        _log.warning("写入压缩/解压历史失败: %s", e)


def _migrate_legacy_archive_history():
    """旧版 .file_manager_archive_history.json 一次性导入。"""
    def _import(conn, data):
        for it in (data if isinstance(data, list) else []):
            if isinstance(it, dict):
                _insert(conn, it)

    migrate_json_once("json_migrated:archive_history", _ARCHIVE_HISTORY_FILE, _import)


_migrate_legacy_archive_history()


def add_record(kind, name, path, detail=""):
    """记录一次归档操作：kind='zip' 压缩 / kind='unzip' 解压"""
    rid = uuid.uuid4().hex[:12]
    with _ARCHIVE_HISTORY_LOCK:
        with store_tx() as conn:
            conn.execute(
                "INSERT INTO archive_history (id, kind, name, path, detail, time) "
                "VALUES (?,?,?,?,?,?)",
                (rid, kind, name, path, detail, time.time()))
            # 只保留最近 _MAX_RECORDS 条
            conn.execute(
                "DELETE FROM archive_history WHERE seq NOT IN "
                "(SELECT seq FROM archive_history ORDER BY seq DESC LIMIT ?)",
                (_MAX_RECORDS,))

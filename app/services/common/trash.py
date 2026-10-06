"""回收站与删除历史服务（删除历史存 store.db 的 delete_history 表）。"""
import os
import re
import threading

from ...config import _TRASH_DIR, _DELETE_HISTORY_FILE
from ...log import get_logger
from .db import _get_index_conn
from .indexer import _INDEX_META
from .filecore import _pop_dir_size
from .store_db import store_conn, store_tx, migrate_json_once


_log = get_logger()
_DELETE_HISTORY_LOCK = threading.Lock()





def _load_delete_history():
    """加载删除历史记录（按删除先后升序，与旧 JSON 数组顺序一致）。"""
    try:
        conn = store_conn()
        try:
            rows = conn.execute(
                "SELECT id, original_path, trash_path, name, is_dir, size, deleted_at "
                "FROM delete_history ORDER BY seq ASC").fetchall()
        finally:
            conn.close()
        return [{
            "id": r["id"],
            "original_path": r["original_path"],
            "trash_path": r["trash_path"],
            "name": r["name"],
            "is_dir": bool(r["is_dir"]),
            "size": r["size"],
            "deleted_at": r["deleted_at"],
        } for r in rows]
    except Exception:
        return []


def _save_delete_history(history):
    """整表覆盖写入删除历史（保持调用方原有的「列表读写」语义）。"""
    try:
        with store_tx() as conn:
            conn.execute("DELETE FROM delete_history")
            for it in history or []:
                if not isinstance(it, dict):
                    continue
                conn.execute(
                    "INSERT OR REPLACE INTO delete_history "
                    "(id, original_path, trash_path, name, is_dir, size, deleted_at) "
                    "VALUES (?,?,?,?,?,?,?)",
                    (it.get("id") or "", it.get("original_path") or "",
                     it.get("trash_path") or "", it.get("name") or "",
                     1 if it.get("is_dir") else 0, int(it.get("size") or 0),
                     int(it.get("deleted_at") or 0)))
    except Exception as e:
        _log.warning("写入删除历史失败: %s", e)


def _migrate_legacy_delete_history():
    """旧版 .file_manager_delete_history.json 一次性导入。"""
    def _import(conn, data):
        for it in (data if isinstance(data, list) else []):
            if not isinstance(it, dict):
                continue
            conn.execute(
                "INSERT OR REPLACE INTO delete_history "
                "(id, original_path, trash_path, name, is_dir, size, deleted_at) "
                "VALUES (?,?,?,?,?,?,?)",
                (it.get("id") or "", it.get("original_path") or "",
                 it.get("trash_path") or "", it.get("name") or "",
                 1 if it.get("is_dir") else 0, int(it.get("size") or 0),
                 int(it.get("deleted_at") or 0)))

    migrate_json_once("json_migrated:delete_history", _DELETE_HISTORY_FILE, _import)


_migrate_legacy_delete_history()


def _get_trash_item_path(trash_id):
    """获取回收站中某条记录的路径"""
    return os.path.join(_TRASH_DIR, trash_id)


def _safe_filename(name):
    """将文件名转为安全的回收站文件名，避免冲突"""
    import re
    safe = re.sub(r'[<>:"/\|?*\n\t]', '_', name)
    safe = safe.strip('.')
    return safe[:180] or "unnamed"


def _update_index_after_delete(deleted_abs_paths):
    """删除后更新索引：移除已删记录，重新计算统计"""
    try:
        conn = _get_index_conn()
        conn.execute("BEGIN")
        for abs_path in deleted_abs_paths:
            path_norm = os.path.normpath(abs_path).replace("\\", "/")
            # 目录：删除自身及所有子记录
            conn.execute("DELETE FROM index_files WHERE abs_path = ? OR abs_path LIKE ?",
                         (path_norm, path_norm.rstrip("/") + "/%"))
        conn.commit()
        tf = conn.execute("SELECT COUNT(*) FROM index_files WHERE is_dir=0").fetchone()[0]
        td = conn.execute("SELECT COUNT(*) FROM index_files WHERE is_dir=1").fetchone()[0]
        ts = conn.execute("SELECT COALESCE(SUM(size), 0) FROM index_files WHERE is_dir=0").fetchone()[0]
        conn.execute("INSERT OR REPLACE INTO index_meta VALUES ('total_files', ?)", (str(tf),))
        conn.execute("INSERT OR REPLACE INTO index_meta VALUES ('total_dirs', ?)", (str(td),))
        conn.execute("INSERT OR REPLACE INTO index_meta VALUES ('total_size', ?)", (str(ts),))
        conn.commit()
        _INDEX_META["total_files"] = tf
        _INDEX_META["total_dirs"] = td
        _INDEX_META["total_size"] = ts
    except Exception as e:
        _log.error("更新索引失败: %s", e)
    finally:
        try:
            conn.close()
        except Exception:
            pass


def _invalidate_all_dir_sizes(deleted_abs_paths):
    """删除后清除受影响目录的大小缓存（自身 + 所有祖先）"""
    for abs_path in deleted_abs_paths:
        path = os.path.normpath(abs_path)
        _pop_dir_size(path)
        _pop_dir_size(path.replace("\\", "/"))
        parent = os.path.dirname(path)
        while parent and parent != os.path.dirname(parent):
            _pop_dir_size(parent)
            _pop_dir_size(parent.replace("\\", "/"))
            parent = os.path.dirname(parent)

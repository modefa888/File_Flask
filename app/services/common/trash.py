"""回收站与删除历史服务。"""
import os
import re
import json
import threading

from ...config import _TRASH_DIR, _DELETE_HISTORY_FILE
from ...log import get_logger
from .db import _get_index_conn
from .indexer import _INDEX_META
from .filecore import _DIR_SIZE_CACHE


_log = get_logger()
_DELETE_HISTORY_LOCK = threading.Lock()





def _load_delete_history():
    """加载删除历史记录"""
    try:
        with open(_DELETE_HISTORY_FILE, "r", encoding="utf-8") as _f:
            return json.load(_f)
    except (OSError, json.JSONDecodeError):
        return []


def _save_delete_history(history):
    """保存删除历史记录"""
    try:
        with open(_DELETE_HISTORY_FILE, "w", encoding="utf-8") as _f:
            json.dump(history, _f, ensure_ascii=False)
    except OSError:
        pass


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
        _DIR_SIZE_CACHE.pop(path, None)
        _DIR_SIZE_CACHE.pop(path.replace("\\", "/"), None)
        parent = os.path.dirname(path)
        while parent and parent != os.path.dirname(parent):
            _DIR_SIZE_CACHE.pop(parent, None)
            _DIR_SIZE_CACHE.pop(parent.replace("\\", "/"), None)
            parent = os.path.dirname(parent)

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


def _like_prefix(path):
    """「自身 + 子树」的 LIKE 前缀（转义 LIKE 通配符，避免路径里的 % / _ 误匹配）"""
    esc = path.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return esc + "/%"


# 命中 abs_path 唯一索引（_get_index_conn 已开 case_sensitive_like=ON）：
# 只扫描「被删的这个文件/目录及其子树」，不碰索引库里的其它行
_INDEX_COUNT_SQL = (
    "SELECT COALESCE(SUM(CASE WHEN is_dir=0 THEN 1 ELSE 0 END), 0),"
    "       COALESCE(SUM(CASE WHEN is_dir=1 THEN 1 ELSE 0 END), 0),"
    "       COALESCE(SUM(CASE WHEN is_dir=0 THEN size ELSE 0 END), 0) "
    "FROM index_files WHERE abs_path = ? OR abs_path LIKE ? ESCAPE '\\'"
)
_INDEX_DELETE_SQL = (
    "DELETE FROM index_files WHERE abs_path = ? OR abs_path LIKE ? ESCAPE '\\'"
)


def _adjust_index_meta(conn, d_files, d_dirs, d_bytes):
    """按增量修正索引合计（total_files / total_dirs / total_size）并同步内存镜像。

    不再全表 COUNT/SUM 重算，只做「读旧值 → 减掉本次删除量」。
    """
    rows = dict(conn.execute("SELECT key, value FROM index_meta").fetchall())

    def _cur(key, mem):
        try:
            return int(rows.get(key) if rows.get(key) is not None else mem)
        except (TypeError, ValueError):
            return int(mem or 0)

    tf = max(_cur("total_files", _INDEX_META.get("total_files", 0)) + d_files, 0)
    td = max(_cur("total_dirs", _INDEX_META.get("total_dirs", 0)) + d_dirs, 0)
    ts = max(_cur("total_size", _INDEX_META.get("total_size", 0)) + d_bytes, 0)
    for k, v in (("total_files", tf), ("total_dirs", td), ("total_size", ts)):
        conn.execute("INSERT OR REPLACE INTO index_meta VALUES (?, ?)", (k, str(v)))
    _INDEX_META["total_files"] = tf
    _INDEX_META["total_dirs"] = td
    _INDEX_META["total_size"] = ts


def _update_index_after_delete(deleted_abs_paths):
    """删除后更新索引：移除已删记录，并按「增量」修正统计。

    性能坑（历史现象：删一个空文件也要等 30~50 秒）：
    索引是「全盘搜索」用的全盘索引，实测可达 690 万行 / 3.8GB。原先这里删完记录后
    用三条全表聚合（COUNT(*) WHERE is_dir=0 / is_dir=1 / SUM(size)）重算总数，
    而 index_files 没有 is_dir 索引 —— 每次删除都要全表扫几 GB，热缓存就要 20 秒+，
    冷缓存 40 秒+，全部卡在删除请求里（其它读请求不受影响，所以表现为「只有删除卡住」）。

    现在改为：
      1) 先用 abs_path 唯一索引统计「本次真正删掉的行数 / 字节数」（代价只与子树规模相关）；
      2) 删掉这些行；
      3) 把统计量从 index_meta 的合计里减掉，不再重算全表。
    路径不在索引里（隐藏目录、未索引位置）时连 DELETE 都不发，直接跳过。
    """
    if not deleted_abs_paths:
        return
    try:
        conn = _get_index_conn()
    except Exception as e:
        _log.error("更新索引失败: %s", e)
        return
    try:
        conn.execute("BEGIN")
        d_files = d_dirs = d_bytes = 0
        for abs_path in deleted_abs_paths:
            path_norm = os.path.normpath(abs_path).replace("\\", "/")
            if not path_norm:
                continue
            args = (path_norm, _like_prefix(path_norm))
            row = conn.execute(_INDEX_COUNT_SQL, args).fetchone()
            n_files, n_dirs, n_bytes = (row[0] or 0), (row[1] or 0), (row[2] or 0)
            if not n_files and not n_dirs:
                continue                     # 索引里没有：无需 DELETE，也无需改合计
            conn.execute(_INDEX_DELETE_SQL, args)
            d_files += n_files
            d_dirs += n_dirs
            d_bytes += n_bytes
        if d_files or d_dirs:
            _adjust_index_meta(conn, -d_files, -d_dirs, -d_bytes)
        conn.commit()
    except Exception as e:
        try:
            conn.rollback()
        except Exception:
            pass
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

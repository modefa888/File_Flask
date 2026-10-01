"""全盘索引引擎：SQLite 索引、构建/扫描、检索、详情统计。"""
import os
import sys
import json
import time
import threading
from datetime import datetime

from ...config import _INDEX_DB_FILE, _INDEX_DB_NEW
from ...log import get_logger
from .db import _get_index_conn, _init_index_db, _index_has_data
from .filecore import format_size, get_file_info, _DIR_SIZE_CACHE


_log = get_logger()

# 索引全局状态
_INDEX_META = {
    "total_files": 0, "total_dirs": 0, "total_size": 0,
    "last_scan": None, "status": "idle", "progress": 0, "status_detail": "",
}
_INDEX_LOCK = threading.Lock()
_SCAN_EVENT = threading.Event()          # 重新扫描信号
_INDEX_BUILD_LOCK = threading.Lock()

# 全盘搜索运行态
_SEARCH_RESULTS = {}
_SEARCH_LOCK = threading.Lock()

# 索引详情统计缓存
_INDEX_DETAIL_MEMORY_CACHE = {}
_INDEX_DETAIL_CACHE_LOCK = threading.Lock()
_INDEX_DETAIL_CACHE_EXPIRY = 600         # 10 分钟过期





def _load_index_meta():
    """从已有索引 DB 加载元信息"""
    conn = _get_index_conn()
    try:
        rows = conn.execute("SELECT key, value FROM index_meta").fetchall()
        meta = dict(rows)
        _INDEX_META["total_files"] = int(meta.get("total_files", 0))
        _INDEX_META["total_dirs"] = int(meta.get("total_dirs", 0))
        _INDEX_META["total_size"] = int(meta.get("total_size", 0))
        _INDEX_META["last_scan"] = meta.get("last_scan", "从未扫描")
        _INDEX_META["status"] = "idle"
        _INDEX_META["progress"] = 100
        has_data = _INDEX_META["total_files"] > 0
        conn.close()
        return has_data
    except Exception:
        conn.close()
        return False


def _scan_root(root, stop_event, conn, max_results=2000000):
    """遍历根目录，将结果写入索引。返回 (count, errors)。conn 由调用方传入（主 DB 或临时 DB）
    进度更新：写入 _INDEX_META["progress"]，0-90 段（扫描阶段），由 _build_index 追加 90-100（后处理）
    """
    _VIRT_FS_PREFIXES = ("/proc", "/sys", "/dev", "/run", "/snap", "/boot", "/dev/shm")
    _MAX_FILE_SIZE = 256 * 1024 * 1024 * 1024  # 超过 256GB 视为虚拟文件

    count = 0
    errors = 0
    try:
        conn.execute("BEGIN")
        for dirpath, dirnames, filenames in os.walk(root):
            if stop_event.is_set():
                break
            dirnames[:] = [d for d in dirnames if not d.startswith(".")]
            dirpath_norm = os.path.normpath(dirpath).replace("\\", "/")

            if not sys.platform.startswith("win"):
                is_virt = any(dirpath_norm == p or dirpath_norm.startswith(p + "/") for p in _VIRT_FS_PREFIXES)
                if is_virt:
                    dirnames[:] = []
                    continue

            try:
                st = os.stat(dirpath)
                conn.execute(
                    "INSERT OR REPLACE INTO index_files (abs_path, name, ext, size, mtime, is_dir, parent_dir) VALUES (?, ?, '', 0, ?, 1, ?)",
                    (dirpath_norm, os.path.basename(dirpath), st.st_mtime, os.path.dirname(dirpath_norm))
                )
                count += 1
            except (OSError, PermissionError):
                errors += 1
                continue

            for fname in filenames:
                if stop_event.is_set():
                    break
                fpath = os.path.join(dirpath, fname)
                fpath_norm = os.path.normpath(fpath).replace("\\", "/")
                try:
                    st = os.stat(fpath)
                    if st.st_size > _MAX_FILE_SIZE:
                        continue
                    ext = os.path.splitext(fname)[1].lower().lstrip(".")
                    conn.execute(
                        "INSERT OR REPLACE INTO index_files (abs_path, name, ext, size, mtime, is_dir, parent_dir) VALUES (?, ?, ?, ?, ?, 0, ?)",
                        (fpath_norm, fname, ext, st.st_size, st.st_mtime, os.path.dirname(fpath_norm))
                    )
                    count += 1
                except (OSError, PermissionError):
                    errors += 1
                    continue
            # 每 5000 项更新一次进度；扫描阶段占用 0-90% 进度
            if count % 5000 == 0:
                conn.commit()
                # 每 50K 项 ≈ 1% 进度；约 5M 项时到 90%（典型全盘最大）
                _INDEX_META["progress"] = min(90, count // 50000)
        conn.commit()
    except Exception as e:
        try:
            conn.rollback()
        except Exception:
            pass
        return count, f"error: {str(e)}"
    return count, None


def _query_index(keyword, ext_filter, type_filter, limit=5000):
    """从索引中查询，返回文件信息列表"""
    conn = _get_index_conn()
    try:
        keyword_l = keyword.lower()
        ext_l = ext_filter.lower().lstrip(".") if ext_filter else ""

        where_clauses = []
        params = []

        # 关键字匹配文件名（显式 LOWER 保持大小写不敏感：
        # 连接层已开启 case_sensitive_like=ON 以优化前缀查询，不能依赖 LIKE 默认行为）
        if keyword:
            where_clauses.append("(LOWER(name) LIKE ?)")
            params.append(f"%{keyword_l}%")

        # 扩展名过滤
        if ext_l:
            where_clauses.append("(ext = ?)")
            params.append(ext_l)

        # 类型过滤
        if type_filter == "文件":
            where_clauses.append("(is_dir = 0)")
        elif type_filter == "目录":
            where_clauses.append("(is_dir = 1)")

        where_sql = " AND ".join(where_clauses) if where_clauses else "1=1"
        params.append(limit)

        rows = conn.execute(
            f"SELECT abs_path, name, ext, size, mtime, is_dir FROM index_files WHERE {where_sql} ORDER BY name LIMIT ?",
            params
        ).fetchall()

        results = []
        for row in rows:
            abs_path, name, ext, size, mtime, is_dir = row
            info = {
                "name": name,
                "path": abs_path,
                "abs_path": abs_path,
                "rel_path": abs_path,
                "is_dir": bool(is_dir),
                "size": size or 0,
                "size_str": format_size(size or 0),
                "type": "目录" if is_dir else (ext.upper() if ext else "未知"),
                "mtime": datetime.fromtimestamp(mtime).strftime("%Y-%m-%d %H:%M:%S") if mtime else "-",
                "ext": ext or "",
            }
            results.append(info)
        return results
    finally:
        conn.close()


def _get_index_meta():
    """获取索引元信息"""
    status = _INDEX_META.get("status", "idle")
    progress = _INDEX_META.get("progress", 0)
    status_detail = _INDEX_META.get("status_detail", "")

    if status == "scanning":
        return {
            "total_files": _INDEX_META.get("total_files", 0),
            "total_dirs": _INDEX_META.get("total_dirs", 0),
            "total_size": _INDEX_META.get("total_size", 0),
            "total_size_str": format_size(_INDEX_META.get("total_size", 0)),
            "last_scan": "扫描中...",
            "status": "scanning",
            "progress": progress,
            "status_detail": status_detail,
        }

    conn = _get_index_conn()
    try:
        rows = conn.execute("SELECT key, value FROM index_meta").fetchall()
        meta = dict(rows)
        last_scan = meta.get("last_scan", "从未扫描")
        total_files = int(meta.get("total_files", 0))
        total_dirs = int(meta.get("total_dirs", 0))
        total_size = int(meta.get("total_size", 0))

        if total_files == 0 and last_scan == "从未扫描":
            last_scan = "等待中..."

        return {
            "total_files": total_files,
            "total_dirs": total_dirs,
            "total_size": total_size,
            "total_size_str": format_size(total_size),
            "last_scan": last_scan,
            "status": status,
            "progress": progress,
            "status_detail": status_detail,
        }
    finally:
        conn.close()


def _build_index(roots):
    """构建索引（写入临时 DB，完成后原子替换主 DB，不删除旧索引）
    进度分段：
      0-90%：文件扫描（由 _scan_root 更新）
      90%：扫描完成，准备统计
      92%：正在统计文件总数和大小
      95%：正在计算类型分布
      98%：正在替换索引 DB
      100%：完成
    status_detail 字段说明当前阶段，UI 可显示文字提示
    """
    if not _INDEX_BUILD_LOCK.acquire(timeout=1):
        return {"status": "busy", "message": "索引构建中..."}

    if os.path.exists(_INDEX_DB_NEW):
        try:
            os.remove(_INDEX_DB_NEW)
        except Exception:
            pass

    _init_index_db(_INDEX_DB_NEW)
    stop_event = threading.Event()

    def _worker():
        try:
            _INDEX_META["status"] = "scanning"
            _INDEX_META["progress"] = 0
            _INDEX_META["status_detail"] = "正在扫描文件..."
            total_count = 0
            all_errors = []
            roots_list = [r.strip() for r in roots.split(";") if r.strip()]
            if not roots_list:
                if sys.platform.startswith("win"):
                    roots_list = [os.environ.get("SystemDrive", "C:") + "\\"]
                else:
                    roots_list = ["/"]

            tconn = _get_index_conn(_INDEX_DB_NEW)
            for root in roots_list:
                if stop_event.is_set():
                    break
                root = os.path.abspath(os.path.normpath(root))
                if not os.path.isdir(root):
                    all_errors.append(f"{root}: 目录不存在")
                    continue
                _INDEX_META["status_detail"] = f"正在扫描 {os.path.basename(root.rstrip('/\\\\'))}..."
                count, err = _scan_root(root, stop_event, tconn)
                total_count += count
                if err:
                    all_errors.append(f"{root}: {err}")
                if stop_event.is_set():
                    all_errors.append("扫描已取消")
                    break

            tconn.close()
            _INDEX_META["progress"] = 90
            _INDEX_META["status_detail"] = "正在统计文件大小..."

            nconn = _get_index_conn(_INDEX_DB_NEW)
            try:
                _INDEX_META["status_detail"] = "正在统计文件总数..."
                total_files = nconn.execute("SELECT COUNT(*) FROM index_files WHERE is_dir=0").fetchone()[0]
                total_dirs = nconn.execute("SELECT COUNT(*) FROM index_files WHERE is_dir=1").fetchone()[0]
                _INDEX_META["progress"] = 92
                _INDEX_META["status_detail"] = "正在计算大小统计..."
                total_size = nconn.execute("SELECT COALESCE(SUM(size), 0) FROM index_files WHERE is_dir=0").fetchone()[0]
                nconn.execute("INSERT OR REPLACE INTO index_meta VALUES ('total_files', ?)", (str(total_files),))
                nconn.execute("INSERT OR REPLACE INTO index_meta VALUES ('total_dirs', ?)", (str(total_dirs),))
                nconn.execute("INSERT OR REPLACE INTO index_meta VALUES ('total_size', ?)", (str(total_size),))
                nconn.execute("INSERT OR REPLACE INTO index_meta VALUES ('last_scan', ?)", (datetime.now().strftime("%Y-%m-%d %H:%M:%S"),))
                nconn.commit()

                _INDEX_META["progress"] = 95
                _INDEX_META["status_detail"] = "正在计算文件分布..."
                _compute_detail_stats(nconn)

                _INDEX_META["progress"] = 98
                _INDEX_META["status_detail"] = "正在更新索引..."
            finally:
                nconn.close()

            if total_files == 0 and not all_errors:
                _log.warning("索引扫描完成但无文件（可能是权限不足）")
            elif all_errors:
                _log.warning("索引扫描完成，共 %d 条错误: %s", len(all_errors), all_errors[0])

            if total_files > 0:
                try:
                    _DIR_SIZE_CACHE.clear()
                    if os.path.exists(_INDEX_DB_FILE):
                        os.remove(_INDEX_DB_FILE)
                    if os.path.exists(_INDEX_DB_FILE + ".wal"):
                        os.remove(_INDEX_DB_FILE + ".wal")
                    _INDEX_META["status_detail"] = "正在替换索引 DB..."
                    os.rename(_INDEX_DB_NEW, _INDEX_DB_FILE)
                    _log.info("索引构建完成，已替换主索引: %d 文件, %d 目录", total_files, total_dirs)
                except Exception as e:
                    _log.error("索引替换失败: %s", e)
                    try:
                        os.rename(_INDEX_DB_NEW, _INDEX_DB_FILE)
                    except Exception:
                        pass
                    _INDEX_META["status"] = "error"
                    _INDEX_META["status_detail"] = "索引替换失败"
                    return

                _INDEX_META["total_files"] = total_files
                _INDEX_META["total_dirs"] = total_dirs
                _INDEX_META["total_size"] = total_size
                _INDEX_META["status"] = "idle"
                _INDEX_META["progress"] = 100
                _INDEX_META["status_detail"] = "索引构建完成"
                _INDEX_META["last_scan"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                _invalidate_detail_cache()
            else:
                try:
                    if os.path.exists(_INDEX_DB_NEW):
                        os.remove(_INDEX_DB_NEW)
                except Exception:
                    pass
                _INDEX_META["status"] = "error"
                _INDEX_META["progress"] = 0
                _INDEX_META["status_detail"] = "扫描完成但无有效数据"

        except Exception as e:
            _log.error("索引扫描异常: %s", e)
            _INDEX_META["status"] = "error"
            _INDEX_META["progress"] = 0
            _INDEX_META["status_detail"] = f"扫描异常: {e}"
            try:
                if os.path.exists(_INDEX_DB_NEW):
                    os.remove(_INDEX_DB_NEW)
            except Exception:
                pass
        finally:
            _INDEX_BUILD_LOCK.release()

    t = threading.Thread(target=_worker, daemon=True)
    t.start()
    return {"status": "started"}


def _cancel_index_scan():
    """取消正在进行的扫描"""
    _SCAN_EVENT.set()


def _schedule_index_scan(interval_minutes=30):
    """后台扫描调度器：仅响应 SCAN_EVENT 信号（手动触发或 API 触发），不做自动定时扫描"""
    def _scheduler():
        if sys.platform.startswith("win"):
            roots = os.environ.get("SystemDrive", "C:") + "\\"
        else:
            roots = "/"
        while True:
            _SCAN_EVENT.wait(timeout=interval_minutes * 60)
            _SCAN_EVENT.clear()
            if _INDEX_META.get("status") == "scanning":
                continue
            try:
                _build_index(roots)
            except Exception:
                pass

    t = threading.Thread(target=_scheduler, daemon=True)
    t.start()
    return t


def _search_walk(root, keyword, ext_filter, type_filter, timeout, stop_event, max_results,
                 skip_dirs=(), case_sensitive=False):
    """在 root 下遍历，收集匹配项。stop_event 可中断，超时由调用方控制。

    skip_dirs: 需要跳过的目录名（不区分大小写），如 node_modules / dist，
               用于按需排除依赖与构建目录，默认不过滤（保持原有行为）。
    case_sensitive: 关键字是否区分大小写，默认 False（如输入 rea 可命中 README.md）；
                    匹配规则为「名称包含关键字」，因此部分关键字与全名都能命中。
    """
    items = []
    keyword_l = keyword if case_sensitive else keyword.lower()
    ext_l = ext_filter.lower().lstrip(".") if ext_filter else ""
    skip_l = {d.strip().lower() for d in (skip_dirs or ()) if d and d.strip()}

    def _hit(name):
        return keyword_l in (name if case_sensitive else name.lower())
    # type_filter: "目录" / "文件" / ""
    try:
        for dirpath, dirnames, filenames in os.walk(root):
            if stop_event.is_set():
                return items, "search_cancelled"
            # 跳过不可访问子目录（避免走死循环或权限错误）
            dirnames[:] = [d for d in dirnames if not d.startswith(".")]
            if skip_l:
                dirnames[:] = [d for d in dirnames if d.lower() not in skip_l]
            # 匹配目录
            for d in list(dirnames):
                dp = os.path.join(dirpath, d)
                if type_filter != "文件":
                    if not keyword or _hit(d):
                        try:
                            info = get_file_info(dp, root)
                            if info:
                                info["abs_path"] = dp.replace("\\", "/")
                                items.append(info)
                        except Exception:
                            pass
            for f in filenames:
                if stop_event.is_set():
                    return items, "search_cancelled"
                fp = os.path.join(dirpath, f)
                if type_filter != "目录":
                    # 扩展名过滤
                    if ext_l:
                        fext = os.path.splitext(f)[1].lower().lstrip(".")
                        if fext != ext_l:
                            continue
                    # 关键字过滤
                    if keyword and not _hit(f):
                        continue
                    try:
                        info = get_file_info(fp, root)
                        if info:
                            info["abs_path"] = fp.replace("\\", "/")
                            items.append(info)
                    except Exception:
                        pass
            if len(items) >= max_results:
                return items, "search_limit"
    except (OSError, PermissionError) as e:
        return items, f"error: {str(e)}"
    return items, "ok"


def _compute_detail_stats_in_memory():
    """实时计算索引详情统计，返回结果字典（不写入 DB）。用于内存缓存。"""
    result = {"top_dirs": [], "type_distribution": [], "top_files": []}
    # 虚拟文件系统前缀，统计时排除
    _VIRT_PREFIXES = "('/proc', '/sys', '/dev', '/run', '/snap', '/boot')"
    conn = _get_index_conn()
    try:
        top_dirs = conn.execute(
            f"""SELECT parent_dir, COUNT(*) as file_count, SUM(size) as dir_size
               FROM index_files WHERE is_dir=0 AND parent_dir != ''
               AND parent_dir NOT IN { _VIRT_PREFIXES }
               AND parent_dir NOT LIKE '/proc/%' AND parent_dir NOT LIKE '/sys/%'
               AND parent_dir NOT LIKE '/dev/%' AND parent_dir NOT LIKE '/run/%'
               GROUP BY parent_dir ORDER BY dir_size DESC LIMIT 15"""
        ).fetchall()
        result["top_dirs"] = [
            {"path": r[0], "name": r[0].rsplit('/', 1)[-1] or r[0], "file_count": r[1], "size": r[2]}
            for r in top_dirs
        ]

        type_rows = conn.execute(
            f"""SELECT COALESCE(ext, '(无后缀)'), COUNT(*) as cnt, SUM(size) as total_size
               FROM index_files WHERE is_dir=0
               AND abs_path NOT LIKE '/proc/%' AND abs_path NOT LIKE '/sys/%'
               AND abs_path NOT LIKE '/dev/%' AND abs_path NOT LIKE '/run/%'
               GROUP BY ext ORDER BY cnt DESC LIMIT 20"""
        ).fetchall()
        result["type_distribution"] = [
            {"ext": r[0], "count": r[1], "size": r[2]}
            for r in type_rows
        ]

        top_files = conn.execute(
            f"""SELECT name, ext, size, parent_dir
               FROM index_files WHERE is_dir=0
               AND abs_path NOT LIKE '/proc/%' AND abs_path NOT LIKE '/sys/%'
               AND abs_path NOT LIKE '/dev/%' AND abs_path NOT LIKE '/run/%'
               ORDER BY size DESC LIMIT 10"""
        ).fetchall()
        result["top_files"] = [
            {"name": r[0], "ext": r[1], "size": r[2], "parent": r[3]}
            for r in top_files
        ]
    except Exception as e:
        _log.error("实时计算索引详情失败: %s", e)
    finally:
        conn.close()
    return result


def _compute_detail_stats(conn):
    """预计算索引详情统计并写入 index_meta 表，供 API 快速读取"""
    # 虚拟文件系统过滤条件（排除旧索引中残留的 /proc 等数据）
    _VFILT = "AND abs_path NOT LIKE '/proc/%' AND abs_path NOT LIKE '/sys/%' AND abs_path NOT LIKE '/dev/%' AND abs_path NOT LIKE '/run/%'"
    try:
        top_dirs = conn.execute(
            f"""SELECT parent_dir, COUNT(*) as file_count, SUM(size) as dir_size
               FROM index_files WHERE is_dir=0 AND parent_dir != ''
               AND parent_dir NOT LIKE '/proc/%' AND parent_dir NOT LIKE '/sys/%'
               AND parent_dir NOT LIKE '/dev/%' AND parent_dir NOT LIKE '/run/%'
               GROUP BY parent_dir ORDER BY dir_size DESC LIMIT 15"""
        ).fetchall()
        top_dirs_data = [
            {"path": r[0], "name": r[0].rsplit('/', 1)[-1] or r[0], "file_count": r[1], "size": r[2]}
            for r in top_dirs
        ]

        type_rows = conn.execute(
            f"""SELECT COALESCE(ext, '(无后缀)'), COUNT(*) as cnt, SUM(size) as total_size
               FROM index_files WHERE is_dir=0 {_VFILT}
               GROUP BY ext ORDER BY cnt DESC LIMIT 20"""
        ).fetchall()
        type_dist_data = [
            {"ext": r[0], "count": r[1], "size": r[2]}
            for r in type_rows
        ]

        top_files = conn.execute(
            f"""SELECT name, ext, size, parent_dir
               FROM index_files WHERE is_dir=0 {_VFILT}
               ORDER BY size DESC LIMIT 10"""
        ).fetchall()
        top_files_data = [
            {"name": r[0], "ext": r[1], "size": r[2], "parent": r[3]}
            for r in top_files
        ]

        conn.execute("INSERT OR REPLACE INTO index_meta VALUES (?, ?)", ('top_dirs', json.dumps(top_dirs_data, ensure_ascii=False)))
        conn.execute("INSERT OR REPLACE INTO index_meta VALUES (?, ?)", ('type_distribution', json.dumps(type_dist_data, ensure_ascii=False)))
        conn.execute("INSERT OR REPLACE INTO index_meta VALUES (?, ?)", ('top_files', json.dumps(top_files_data, ensure_ascii=False)))
        conn.commit()
        _log.info("索引详情统计已更新")
        return True
    except Exception as e:
        _log.error("计算索引详情统计失败: %s", e)
        return False


def _load_detail_stats():
    """加载索引详情统计。优先读进程内存缓存，其次读 DB 预计算数据。"""
    now = time.time()

    # 1. 进程内存缓存
    with _INDEX_DETAIL_CACHE_LOCK:
        cached = _INDEX_DETAIL_MEMORY_CACHE.get("data")
        cached_time = _INDEX_DETAIL_MEMORY_CACHE.get("time", 0)
        if cached and (now - cached_time) < _INDEX_DETAIL_CACHE_EXPIRY:
            return cached

    # 2. DB 预计算数据（检查是否含旧的虚拟filesystem条目）
    result = {"top_dirs": [], "type_distribution": [], "top_files": []}
    conn = _get_index_conn()
    try:
        rows = conn.execute("SELECT key, value FROM index_meta").fetchall()
        meta = dict(rows)
        for key in ("top_dirs", "type_distribution", "top_files"):
            raw = meta.get(key)
            if raw:
                try:
                    result[key] = json.loads(raw)
                except (json.JSONDecodeError, TypeError):
                    result[key] = []
    finally:
        conn.close()

    # 3. 检查是否有旧的虚拟文件系统数据需要清理
    _HAS_OLD_VIRT_DATA = False
    for item in result.get("top_dirs", []):
        p = item.get("path", "")
        if p.startswith("/proc") or p.startswith("/sys") or p.startswith("/dev") or p.startswith("/run"):
            _HAS_OLD_VIRT_DATA = True
            break
    for item in result.get("top_files", []):
        p = item.get("parent", "")
        if p.startswith("/proc") or p.startswith("/sys") or p.startswith("/dev") or p.startswith("/run"):
            _HAS_OLD_VIRT_DATA = True
            break

    if not _HAS_OLD_VIRT_DATA and (result["top_dirs"] or result["type_distribution"] or result["top_files"]):
        with _INDEX_DETAIL_CACHE_LOCK:
            _INDEX_DETAIL_MEMORY_CACHE["data"] = result
            _INDEX_DETAIL_MEMORY_CACHE["time"] = now
        return result

    # 4. 缓存为空或含旧数据：用过滤后的查询重新计算
    if _HAS_OLD_VIRT_DATA:
        _log.info("检测到旧索引含虚拟文件系统数据，已自动过滤")

    result = _compute_detail_stats_in_memory()

    if result["top_dirs"] or result["type_distribution"] or result["top_files"]:
        with _INDEX_DETAIL_CACHE_LOCK:
            _INDEX_DETAIL_MEMORY_CACHE["data"] = result
            _INDEX_DETAIL_MEMORY_CACHE["time"] = now
        # 尝试持久化到 DB（只读文件系统会失败，忽略）
        try:
            conn = _get_index_conn()
            _compute_detail_stats(conn)
            conn.close()
        except Exception:
            pass

    return result


def _invalidate_detail_cache():
    """索引重建后清空详情缓存"""
    with _INDEX_DETAIL_CACHE_LOCK:
        _INDEX_DETAIL_MEMORY_CACHE.clear()

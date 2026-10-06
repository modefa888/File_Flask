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
from .filecore import format_size, get_file_info, _DIR_SIZE_CACHE, _in_pseudo_fs


_log = get_logger()

# 索引全局状态
_INDEX_META = {
    "total_files": 0, "total_dirs": 0, "total_size": 0,
    "last_scan": None, "status": "idle", "progress": 0, "status_detail": "",
    "scanned_files": 0,   # 本轮扫描实时已扫描文件数
    "scanned_dirs": 0,    # 本轮扫描实时已扫描目录数
    "scanned_size": 0,    # 本轮扫描实时累计文件大小
}
_INDEX_LOCK = threading.Lock()
_SCAN_EVENT = threading.Event()          # 触发重新扫描的信号
_CANCEL_EVENT = threading.Event()        # 取消当前扫描的信号（与触发信号分开，避免被调度器清掉）
_INDEX_BUILD_LOCK = threading.Lock()

# 全盘搜索运行态
_SEARCH_RESULTS = {}
_SEARCH_LOCK = threading.Lock()

# 索引详情统计缓存
_INDEX_DETAIL_MEMORY_CACHE = {}
_INDEX_DETAIL_CACHE_LOCK = threading.Lock()
_INDEX_DETAIL_CACHE_EXPIRY = 600         # 10 分钟过期

# 扫描期间实时详情缓存（从临时库聚合开销大，节流 20 秒一次）
_INDEX_SCANNING_DETAIL = {"time": 0.0, "data": None}
_INDEX_SCANNING_DETAIL_LOCK = threading.Lock()

# 可视化图表统计缓存（扫描中 20 秒 / 空闲 120 秒）
_INDEX_CHART_CACHE = {"time": 0.0, "data": None}
_INDEX_CHART_LOCK = threading.Lock()





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
        _INDEX_META["scanned_files"] = 0
        _INDEX_META["scanned_dirs"] = 0
        _INDEX_META["scanned_size"] = 0
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

    count = 0          # 总项数（含目录），用于进度
    file_count = 0     # 已扫描文件数
    dir_count = 0      # 已扫描目录数
    size_sum = 0       # 已扫描文件总大小
    errors = 0
    try:
        conn.execute("BEGIN")
        for dirpath, dirnames, filenames in os.walk(root):
            if stop_event.is_set():
                break
            # 跳过隐藏目录，以及 proc/sysfs/tmpfs 等伪文件系统
            # （/proc/kcore 这种 128TB 的虚拟文件既不该入库，也不该计入总大小）
            dirnames[:] = [
                d for d in dirnames
                if not d.startswith(".") and not _in_pseudo_fs(os.path.join(dirpath, d))
            ]
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
                dir_count += 1
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
                    file_count += 1
                    size_sum += st.st_size or 0
                except (OSError, PermissionError):
                    errors += 1
                    continue
            # 每 5000 项更新一次进度；扫描阶段占用 0-90% 进度
            if count % 5000 == 0:
                conn.commit()
                # 每 50K 项 ≈ 1% 进度；约 5M 项时到 90%（典型全盘最大）
                _INDEX_META["progress"] = min(90, count // 50000)
                _INDEX_META["scanned_files"] = file_count
                _INDEX_META["scanned_dirs"] = dir_count
                _INDEX_META["scanned_size"] = size_sum
        conn.commit()
        _INDEX_META["scanned_files"] = file_count
        _INDEX_META["scanned_dirs"] = dir_count
        _INDEX_META["scanned_size"] = size_sum
    except Exception as e:
        try:
            conn.rollback()
        except Exception:
            pass
        return count, f"error: {str(e)}"
    return count, None


def _query_index(keyword, ext_filter, type_filter, limit=5000, min_size=0, max_size=0):
    """从索引中查询，返回文件信息列表。
    min_size / max_size 为字节数，0 表示该侧不限（目录不参与大小过滤）。
    """
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

        # 大小过滤（只在文件上生效：目录 size 无意义）
        if min_size and int(min_size) > 0:
            where_clauses.append("(is_dir = 0 AND size >= ?)")
            params.append(int(min_size))
        if max_size and int(max_size) > 0:
            where_clauses.append("(is_dir = 0 AND size <= ?)")
            params.append(int(max_size))

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
        # 扫描期间展示实时累计统计（动态更新），total_files 等旧索引字段保持不动，
        # 新索引构建完成并替换后才整体切换为最终值
        sf = _INDEX_META.get("scanned_files", 0)
        sd = _INDEX_META.get("scanned_dirs", 0)
        ss = _INDEX_META.get("scanned_size", 0)
        return {
            "total_files": sf,
            "total_dirs": sd,
            "total_size": ss,
            "total_size_str": format_size(ss),
            "last_scan": "扫描中...",
            "scanned_files": sf,
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
    _CANCEL_EVENT.clear()        # 清掉上一轮可能残留的取消信号
    stop_event = _CANCEL_EVENT   # 与 /api/index/cancel 共用同一个信号，否则「取消扫描」不会生效

    def _worker():
        try:
            _INDEX_META["status"] = "scanning"
            _INDEX_META["progress"] = 0
            _INDEX_META["scanned_files"] = 0
            _INDEX_META["scanned_dirs"] = 0
            _INDEX_META["scanned_size"] = 0
            _INDEX_SCANNING_DETAIL["data"] = None
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

            if stop_event.is_set():
                # 用户取消：丢弃半成品临时库、保留原有索引，避免用不完整数据覆盖旧索引
                try:
                    if os.path.exists(_INDEX_DB_NEW):
                        os.remove(_INDEX_DB_NEW)
                    if os.path.exists(_INDEX_DB_NEW + ".wal"):
                        os.remove(_INDEX_DB_NEW + ".wal")
                except Exception:
                    pass
                _INDEX_META["status"] = "idle"
                _INDEX_META["progress"] = 0
                _INDEX_META["scanned_files"] = 0
                _INDEX_META["scanned_dirs"] = 0
                _INDEX_META["scanned_size"] = 0
                _INDEX_META["status_detail"] = "已取消扫描"
                return

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
                    _INDEX_META["status_detail"] = "正在替换索引 DB..."
                    # 清掉旧库残留的 WAL，避免替换后把旧 WAL 应用到新库
                    try:
                        if os.path.exists(_INDEX_DB_FILE + ".wal"):
                            os.remove(_INDEX_DB_FILE + ".wal")
                    except Exception:
                        pass
                    # 确保临时库的 WAL 已合并进主文件（连接关闭时通常已自动 checkpoint，这里兜底）
                    try:
                        if os.path.exists(_INDEX_DB_NEW + ".wal"):
                            _wconn = _get_index_conn(_INDEX_DB_NEW)
                            _wconn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
                            _wconn.close()
                    except Exception:
                        pass
                    # 原子替换：新库一次性顶替旧库（POSIX rename 原子生效）。
                    # 替换完成前旧索引始终完整可查；替换失败旧索引原封不动。
                    os.replace(_INDEX_DB_NEW, _INDEX_DB_FILE)
                    _log.info("索引构建完成，已替换主索引: %d 文件, %d 目录", total_files, total_dirs)
                except Exception as e:
                    _log.error("索引替换失败: %s", e)
                    try:
                        if os.path.exists(_INDEX_DB_NEW):
                            os.remove(_INDEX_DB_NEW)
                    except Exception:
                        pass
                    _INDEX_META["status"] = "error"
                    _INDEX_META["status_detail"] = "索引替换失败"
                    return

                _INDEX_META["total_files"] = total_files
                _INDEX_META["total_dirs"] = total_dirs
                _INDEX_META["total_size"] = total_size
                _INDEX_META["scanned_files"] = 0
                _INDEX_META["scanned_dirs"] = 0
                _INDEX_META["scanned_size"] = 0
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
    _CANCEL_EVENT.set()


def _schedule_index_scan():
    """后台扫描调度器：仅在收到 _SCAN_EVENT 信号（手动触发 / API 触发）时才执行扫描；
    不做定时自动扫描，避免重启后或每隔一段时间自动全盘索引——索引完全由用户在界面手动「重建索引」启动。"""
    def _scheduler():
        if sys.platform.startswith("win"):
            roots = os.environ.get("SystemDrive", "C:") + "\\"
        else:
            roots = "/"
        while True:
            _SCAN_EVENT.wait()            # 永久等待手动信号，不超时；没有信号则不扫描
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
                 skip_dirs=(), case_sensitive=False, min_size=0, max_size=0):
    """在 root 下遍历，收集匹配项。stop_event 可中断，超时由调用方控制。

    skip_dirs: 需要跳过的目录名（不区分大小写），如 node_modules / dist，
               用于按需排除依赖与构建目录，默认不过滤（保持原有行为）。
    case_sensitive: 关键字是否区分大小写，默认 False（如输入 rea 可命中 README.md）；
                    匹配规则为「名称包含关键字」，因此部分关键字与全名都能命中。
    min_size / max_size: 文件大小区间（字节，0 = 该侧不限），只作用于文件、不影响目录。
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
            # 跳过隐藏目录与伪文件系统（避免走死循环、权限错误或收录虚拟文件）
            dirnames[:] = [
                d for d in dirnames
                if not d.startswith(".") and not _in_pseudo_fs(os.path.join(dirpath, d))
            ]
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
                            sz = int(info.get("size") or 0)
                            if (min_size and int(min_size) > 0 and sz < int(min_size)) or \
                               (max_size and int(max_size) > 0 and sz > int(max_size)):
                                continue        # 命中关键字但不在大小区间内
                            info["abs_path"] = fp.replace("\\", "/")
                            items.append(info)
                    except Exception:
                        pass
            if len(items) >= max_results:
                return items, "search_limit"
    except (OSError, PermissionError) as e:
        return items, f"error: {str(e)}"
    return items, "ok"


def _compute_detail_stats_in_memory(db_path=None):
    """实时计算索引详情统计，返回结果字典（不写入 DB）。用于内存缓存。
    db_path 可传入临时库路径，用于扫描期间的实时统计。"""
    result = {"top_dirs": [], "type_distribution": [], "top_files": []}
    # 虚拟文件系统前缀，统计时排除
    _VIRT_PREFIXES = "('/proc', '/sys', '/dev', '/run', '/snap', '/boot')"
    conn = _get_index_conn(db_path)
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


def _load_scanning_detail_stats():
    """扫描期间的详情统计：旧索引有数据则用旧索引统计；
    无旧索引（首次构建）时从临时库节流计算实时统计。"""
    # 旧索引仍有数据：直接用旧索引统计（重建期间旧索引有效，开销最小）
    try:
        conn = _get_index_conn()
        try:
            row = conn.execute("SELECT value FROM index_meta WHERE key='total_files'").fetchone()
        finally:
            conn.close()
        if row and int(row[0] or 0) > 0:
            return _load_detail_stats()
    except Exception:
        pass

    # 无旧索引：从临时库计算实时统计，20 秒节流一次（全量聚合较重，不宜每次轮询都算）
    now = time.time()
    with _INDEX_SCANNING_DETAIL_LOCK:
        cached = _INDEX_SCANNING_DETAIL
        if cached["data"] is not None and (now - cached["time"]) < 20:
            return cached["data"]

    data = {"top_dirs": [], "type_distribution": [], "top_files": []}
    if os.path.exists(_INDEX_DB_NEW):
        try:
            data = _compute_detail_stats_in_memory(_INDEX_DB_NEW)
        except Exception as e:
            _log.warning("扫描期间实时统计失败: %s", e)

    with _INDEX_SCANNING_DETAIL_LOCK:
        _INDEX_SCANNING_DETAIL["time"] = time.time()
        _INDEX_SCANNING_DETAIL["data"] = data
    return data


def _compute_chart_stats(conn):
    """计算可视化图表数据（不写 DB）。conn 可为主库或临时库。"""
    result = {
        "type_distribution": [], "size_buckets": [], "mtime_buckets": [],
        "top_dirs": [], "top_files": [],
    }
    _VFILT = "AND abs_path NOT LIKE '/proc/%' AND abs_path NOT LIKE '/sys/%' AND abs_path NOT LIKE '/dev/%' AND abs_path NOT LIKE '/run/%'"
    try:
        # 1. 文件类型分布（按总大小 Top 12，其余合并为"其他"）
        rows = conn.execute(
            f"""SELECT COALESCE(NULLIF(ext, ''), '(无后缀)') AS e, COUNT(*) cnt, SUM(size) sz
               FROM index_files WHERE is_dir=0 {_VFILT}
               GROUP BY e ORDER BY sz DESC"""
        ).fetchall()
        total_size = sum(r[2] or 0 for r in rows)
        shown_size = 0
        for r in rows[:12]:
            result["type_distribution"].append({"ext": r[0], "count": r[1], "size": r[2] or 0})
            shown_size += r[2] or 0
        if len(rows) > 12:
            result["type_distribution"].append({
                "ext": "其他", "count": sum(r[1] for r in rows[12:]),
                "size": max(0, total_size - shown_size),
            })

        # 2. 文件大小分布（5 个区间：数量 + 总大小）
        row = conn.execute(
            f"""SELECT
               COALESCE(SUM(CASE WHEN size < 1048576 THEN 1 ELSE 0 END), 0),
               COALESCE(SUM(CASE WHEN size < 1048576 THEN size ELSE 0 END), 0),
               COALESCE(SUM(CASE WHEN size >= 1048576 AND size < 10485760 THEN 1 ELSE 0 END), 0),
               COALESCE(SUM(CASE WHEN size >= 1048576 AND size < 10485760 THEN size ELSE 0 END), 0),
               COALESCE(SUM(CASE WHEN size >= 10485760 AND size < 104857600 THEN 1 ELSE 0 END), 0),
               COALESCE(SUM(CASE WHEN size >= 10485760 AND size < 104857600 THEN size ELSE 0 END), 0),
               COALESCE(SUM(CASE WHEN size >= 104857600 AND size < 1073741824 THEN 1 ELSE 0 END), 0),
               COALESCE(SUM(CASE WHEN size >= 104857600 AND size < 1073741824 THEN size ELSE 0 END), 0),
               COALESCE(SUM(CASE WHEN size >= 1073741824 THEN 1 ELSE 0 END), 0),
               COALESCE(SUM(CASE WHEN size >= 1073741824 THEN size ELSE 0 END), 0)
               FROM index_files WHERE is_dir=0 {_VFILT}"""
        ).fetchone()
        if row:
            labels = ["< 1 MB", "1-10 MB", "10-100 MB", "100 MB-1 GB", "≥ 1 GB"]
            for i, label in enumerate(labels):
                result["size_buckets"].append({"label": label, "count": row[i * 2], "size": row[i * 2 + 1]})

        # 3. 修改时间分布
        now_ts = time.time()
        day = 86400.0
        t_day, t_week, t_month, t_year = now_ts - day, now_ts - 7 * day, now_ts - 30 * day, now_ts - 365 * day
        row = conn.execute(
            f"""SELECT
               COALESCE(SUM(CASE WHEN mtime >= ? THEN 1 ELSE 0 END), 0),
               COALESCE(SUM(CASE WHEN mtime >= ? AND mtime < ? THEN 1 ELSE 0 END), 0),
               COALESCE(SUM(CASE WHEN mtime >= ? AND mtime < ? THEN 1 ELSE 0 END), 0),
               COALESCE(SUM(CASE WHEN mtime >= ? AND mtime < ? THEN 1 ELSE 0 END), 0),
               COALESCE(SUM(CASE WHEN mtime < ? OR mtime IS NULL THEN 1 ELSE 0 END), 0)
               FROM index_files WHERE is_dir=0 {_VFILT}""",
            (t_day, t_week, t_day, t_month, t_week, t_year, t_month, t_year)
        ).fetchone()
        if row:
            labels = ["今天", "最近 7 天", "最近 30 天", "最近一年", "更早"]
            for i, label in enumerate(labels):
                result["mtime_buckets"].append({"label": label, "count": row[i]})

        # 4. 占用空间 Top 15 目录
        rows = conn.execute(
            f"""SELECT parent_dir, COUNT(*) as file_count, SUM(size) as dir_size
               FROM index_files WHERE is_dir=0 AND parent_dir != ''
               {_VFILT}
               GROUP BY parent_dir ORDER BY dir_size DESC LIMIT 15"""
        ).fetchall()
        result["top_dirs"] = [
            {"path": r[0], "name": r[0].rsplit('/', 1)[-1] or r[0], "file_count": r[1], "size": r[2] or 0}
            for r in rows
        ]

        # 5. 最大文件 Top 10
        rows = conn.execute(
            f"""SELECT name, ext, size, parent_dir
               FROM index_files WHERE is_dir=0 {_VFILT}
               ORDER BY size DESC LIMIT 10"""
        ).fetchall()
        result["top_files"] = [
            {"name": r[0], "ext": r[1], "size": r[2] or 0, "parent": r[3]}
            for r in rows
        ]
    except Exception as e:
        _log.warning("计算图表统计失败: %s", e)
    return result


def _get_chart_stats():
    """获取可视化图表数据（带缓存：扫描中 20 秒 / 空闲 120 秒）"""
    now = time.time()
    scanning = _INDEX_META.get("status") == "scanning"
    with _INDEX_CHART_LOCK:
        if _INDEX_CHART_CACHE["data"] is not None and (now - _INDEX_CHART_CACHE["time"]) < (20 if scanning else 120):
            return _INDEX_CHART_CACHE["data"]

    db_path = None
    # 无旧索引且正在扫描：从临时库实时计算
    try:
        conn = _get_index_conn()
        try:
            row = conn.execute("SELECT value FROM index_meta WHERE key='total_files'").fetchone()
        finally:
            conn.close()
        if not (row and int(row[0] or 0) > 0) and scanning and os.path.exists(_INDEX_DB_NEW):
            db_path = _INDEX_DB_NEW
    except Exception:
        pass

    data = {"type_distribution": [], "size_buckets": [], "mtime_buckets": [], "top_dirs": [], "top_files": []}
    try:
        conn = _get_index_conn(db_path)
        try:
            data = _compute_chart_stats(conn)
        finally:
            conn.close()
    except Exception as e:
        _log.warning("图表统计失败: %s", e)

    data["meta"] = {"status": "scanning" if scanning else "idle", "from_temp": db_path is not None}
    with _INDEX_CHART_LOCK:
        _INDEX_CHART_CACHE["time"] = time.time()
        _INDEX_CHART_CACHE["data"] = data
    return data


# 媒体集合：按类别归类的扩展名（注意避开与源码冲突的 ext，如 ts/ts 的 TypeScript）
_MEDIA_EXTS = {
    "video": ("mp4", "mkv", "avi", "mov", "wmv", "flv", "webm", "m4v", "rmvb", "mpg", "mpeg", "3gp"),
    "audio": ("mp3", "flac", "wav", "aac", "ogg", "m4a", "wma", "ape", "opus", "mp2"),
    "image": ("jpg", "jpeg", "png", "gif", "webp", "bmp", "heic", "svg", "tiff", "tif", "ico"),
}
_MEDIA_EXT_CAT = {e: cat for cat, exts in _MEDIA_EXTS.items() for e in exts}


def _query_media_collection(media_type="all", keyword="", page=1, page_size=48,
                            min_size=0, max_size=0, cat_filters=None):
    """按类型聚合索引中的媒体文件（视频/音频/图片），按大小倒序分页返回。
    标准分页：page 从 1 开始，返回 items / total / page / page_size / total_pages / has_more。
    min_size / max_size 为字节数，0 表示该侧不限，用于手动过滤掉过小/过大的文件。
    cat_filters: {类别: (min, max)}，分类各自的大小区间（0 表示该侧不限）。
    用于「全部」视图：视频只看 ≥1MB、图片只看 ≥0.1MB 等，各分类按自己的规则过滤后合并统计；
    没设置区间的类别保持全部保留。
    SQL 始终使用 LIMIT ? OFFSET ?，绝不会一次性返回全部数据。
    """
    exts = []
    for cat in ("video", "audio", "image"):
        if media_type in ("all", cat):
            exts.extend(_MEDIA_EXTS[cat])
    if not exts:
        return {"items": [], "total": 0, "page": page, "page_size": page_size,
                "total_pages": 0, "has_more": False}

    placeholders = ",".join("?" * len(exts))
    where = f"ext IN ({placeholders})"
    params = list(exts)
    if keyword:
        where += " AND LOWER(name) LIKE ?"
        params.append(f"%{keyword.lower()}%")
    if min_size and int(min_size) > 0:
        where += " AND size >= ?"
        params.append(int(min_size))
    if max_size and int(max_size) > 0:
        where += " AND size <= ?"
        params.append(int(max_size))

    # 分类级区间：每个类别只受自己那套区间约束，未设置的类别不受限
    if cat_filters:
        groups = []
        for cat in ("video", "audio", "image"):
            if media_type not in ("all", cat):
                continue
            cexts = _MEDIA_EXTS.get(cat) or []
            if not cexts:
                continue
            cond = f"ext IN ({','.join('?' * len(cexts))})"
            cparams = list(cexts)
            rng = cat_filters.get(cat)
            if rng:
                cmn, cmx = int(rng[0] or 0), int(rng[1] or 0)
                if cmn > 0:
                    cond += " AND size >= ?"
                    cparams.append(cmn)
                if cmx > 0:
                    cond += " AND size <= ?"
                    cparams.append(cmx)
            groups.append((cond, cparams))
        if groups:
            where += " AND (" + " OR ".join(g[0] for g in groups) + ")"
            for _, cp in groups:
                params.extend(cp)

    conn = _get_index_conn()
    try:
        total = conn.execute(f"SELECT COUNT(*) FROM index_files WHERE {where}", params).fetchone()[0]
        offset = (page - 1) * page_size
        # 仅取本页数据，硬上限防止异常参数拖垮服务
        rows = conn.execute(
            f"""SELECT abs_path, name, ext, size, mtime FROM index_files
               WHERE {where} ORDER BY size DESC LIMIT ? OFFSET ?""",
            params + [min(page_size, 200), offset]
        ).fetchall()
    finally:
        conn.close()

    items = []
    for abs_path, name, ext, size, mtime in rows:
        e = (ext or "").lower()
        items.append({
            "path": abs_path,
            "name": name,
            "ext": ext or "",
            "size": size or 0,
            "size_str": format_size(size or 0),
            "mtime": datetime.fromtimestamp(mtime).strftime("%Y-%m-%d %H:%M") if mtime else "-",
            "category": _MEDIA_EXT_CAT.get(e, "other"),
            "parent": os.path.dirname(abs_path),
        })
    total_pages = (total + page_size - 1) // page_size if total else 0
    return {
        "items": items,
        "total": total,
        "page": page,
        "page_size": page_size,
        "total_pages": total_pages,
        "has_more": page < total_pages,
    }


def _invalidate_detail_cache():
    """索引重建后清空详情缓存"""
    with _INDEX_DETAIL_CACHE_LOCK:
        _INDEX_DETAIL_MEMORY_CACHE.clear()
    with _INDEX_SCANNING_DETAIL_LOCK:
        _INDEX_SCANNING_DETAIL["data"] = None
    with _INDEX_CHART_LOCK:
        _INDEX_CHART_CACHE["data"] = None

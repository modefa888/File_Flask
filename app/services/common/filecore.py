"""文件系统核心：路径、大小、目录列表与缓存。"""
import os
import sys
import json
import time
import threading
import subprocess
from datetime import datetime

from ...config import DEFAULT_START_PATH, _DIR_SIZE_CACHE_FILE, _LIST_CACHE_FILE
from .db import _get_index_conn
from .store_db import store_conn, store_tx, migrate_json_once


# 目录大小缓存（基于 mtime 判断是否需要重新计算）
# 内存结构：path -> {"size": int|None, "dir_mtime": float, "ts": float}
_DIR_SIZE_CACHE = {}
# 目录列表缓存（目录未变动则秒回）：ckey -> {"v":3, "mtime":.., "items":[...], "partial":bool}
_LIST_CACHE = {}
# 待写回的脏行：key -> entry（None 表示该行已删除）
_DIR_SIZE_DIRTY = {}
_LIST_DIRTY = {}
# 列表缓存是否被整体清空（伪文件系统清理时）
_LIST_CLEAR_ALL = False


def _migrate_legacy_caches():
    """旧版 .file_manager_cache.json / .file_manager_list_cache.json 一次性导入 store.db。"""
    def _import_size(conn, data):
        if not isinstance(data, dict):
            return
        for path, e in data.items():
            if not isinstance(e, dict):
                continue
            conn.execute(
                "INSERT OR REPLACE INTO dir_size (path, size, dir_mtime, ts) VALUES (?,?,?,?)",
                (path, e.get("size"), e.get("dir_mtime", 0) or 0, e.get("ts", 0) or 0))

    def _import_list(conn, data):
        if not isinstance(data, dict):
            return
        for ckey, e in data.items():
            if not isinstance(e, dict):
                continue
            path, _, hidden = ckey.partition("\x00")
            if not path:
                continue
            conn.execute(
                "INSERT OR REPLACE INTO dir_list (path, show_hidden, mtime, partial, items) "
                "VALUES (?,?,?,?,?)",
                (path, 1 if hidden == "1" else 0, e.get("mtime", 0) or 0,
                 1 if e.get("partial") else 0,
                 json.dumps(e.get("items") or [], ensure_ascii=False)))

    migrate_json_once("json_migrated:dir_size", _DIR_SIZE_CACHE_FILE, _import_size)
    migrate_json_once("json_migrated:dir_list", _LIST_CACHE_FILE, _import_list)


def _load_caches_from_db():
    """启动时从 store.db 载入两份缓存（DB 是持久层，内存是热点加速层）。"""
    global _DIR_SIZE_CACHE, _LIST_CACHE
    try:
        conn = store_conn()
        try:
            _DIR_SIZE_CACHE = {
                r["path"]: {"size": r["size"], "dir_mtime": r["dir_mtime"], "ts": r["ts"]}
                for r in conn.execute("SELECT path, size, dir_mtime, ts FROM dir_size")
            }
            loaded = {}
            for r in conn.execute("SELECT path, show_hidden, mtime, partial, items FROM dir_list"):
                ckey = r["path"] + "\x00" + ("1" if r["show_hidden"] else "0")
                try:
                    items = json.loads(r["items"] or "[]")
                except ValueError:
                    items = []
                loaded[ckey] = {"v": 3, "mtime": r["mtime"], "items": items,
                                "partial": bool(r["partial"])}
            _LIST_CACHE = loaded
        finally:
            conn.close()
    except Exception:
        _DIR_SIZE_CACHE = {}
        _LIST_CACHE = {}


_migrate_legacy_caches()
_load_caches_from_db()


# ---------- 伪文件系统（proc / sysfs / tmpfs 等）----------
# 这些目录里的"文件大小"是虚拟值：/proc/kcore 恒为 128TB、/sys 下大量 4K 假文件……
# 统计磁盘占用必须排除，否则根目录总大小会被撑到上百 TB，跟真实磁盘容量对不上。
_PSEUDO_FS_TYPES = {
    "proc", "sysfs", "devtmpfs", "devpts", "tmpfs", "cgroup", "cgroup2",
    "securityfs", "debugfs", "tracefs", "pstore", "bpf", "configfs",
    "fusectl", "mqueue", "hugetlbfs", "ramfs", "binfmt_misc", "autofs",
    "efivarfs", "rpc_pipefs", "nsfs",
}
_PSEUDO_MOUNT_CACHE = {"ts": 0.0, "points": []}


def _pseudo_mount_points():
    """伪文件系统的挂载点（绝对路径、无尾斜杠）。非 Linux 或读取失败返回空表。
    结果缓存 30 秒，兼顾插拔外置盘后挂载点的变化。"""
    now = time.monotonic()
    if now - _PSEUDO_MOUNT_CACHE["ts"] < 30:
        return _PSEUDO_MOUNT_CACHE["points"]
    points = []
    if sys.platform.startswith("linux"):
        try:
            with open("/proc/mounts", "r", encoding="utf-8", errors="replace") as f:
                for line in f:
                    parts = line.split()
                    if len(parts) < 3 or parts[2] not in _PSEUDO_FS_TYPES:
                        continue
                    mp = parts[1].replace("\\040", " ").rstrip("/")
                    if mp and mp != "/":      # 根目录即使本身是 tmpfs 也照常统计
                        points.append(mp)
        except OSError:
            points = []
    _PSEUDO_MOUNT_CACHE["ts"] = now
    _PSEUDO_MOUNT_CACHE["points"] = points
    return points


def _in_pseudo_fs(path):
    """路径本身或其祖先落在伪文件系统里 → 这个"大小"没有磁盘意义"""
    path = (path or "").rstrip("/")
    if not path:
        return False
    for mp in _pseudo_mount_points():
        if path == mp or path.startswith(mp + "/"):
            return True
    return False





def safe_path(user_path):
    if not user_path:
        return DEFAULT_START_PATH
    abs_path = os.path.abspath(os.path.normpath(user_path))
    return abs_path


def format_size(size_bytes):
    if size_bytes < 1024:
        return f"{size_bytes} B"
    elif size_bytes < 1024 * 1024:
        return f"{size_bytes / 1024:.1f} KB"
    elif size_bytes < 1024 * 1024 * 1024:
        return f"{size_bytes / 1024 / 1024:.1f} MB"
    else:
        return f"{size_bytes / 1024 / 1024 / 1024:.2f} GB"


def _set_dir_size(path, entry):
    _DIR_SIZE_CACHE[path] = entry
    _DIR_SIZE_DIRTY[path] = entry


def _pop_dir_size(path):
    """从内存与 store.db 中移除一条目录大小缓存。"""
    if path in _DIR_SIZE_CACHE or path in _DIR_SIZE_DIRTY:
        _DIR_SIZE_CACHE.pop(path, None)
        _DIR_SIZE_DIRTY[path] = None


def _set_list_entry(ckey, entry):
    _LIST_CACHE[ckey] = entry
    _LIST_DIRTY[ckey] = entry


def _pop_list_entry(ckey):
    if ckey in _LIST_CACHE or ckey in _LIST_DIRTY:
        _LIST_CACHE.pop(ckey, None)
        _LIST_DIRTY[ckey] = None


def _save_cache():
    """把脏的目录大小缓存行级同步到 store.db（不再全量重写整个文件）。"""
    if not _DIR_SIZE_DIRTY:
        return
    try:
        with store_tx() as conn:
            for path, entry in list(_DIR_SIZE_DIRTY.items()):
                if entry is None:
                    conn.execute("DELETE FROM dir_size WHERE path=?", (path,))
                else:
                    conn.execute(
                        "INSERT INTO dir_size (path, size, dir_mtime, ts) VALUES (?,?,?,?) "
                        "ON CONFLICT(path) DO UPDATE SET size=excluded.size, "
                        "dir_mtime=excluded.dir_mtime, ts=excluded.ts",
                        (path, entry.get("size"), entry.get("dir_mtime", 0) or 0,
                         entry.get("ts", 0) or 0))
        _DIR_SIZE_DIRTY.clear()
    except Exception:
        pass


def _save_list_cache():
    """把脏的目录列表缓存行级同步到 store.db。"""
    global _LIST_CLEAR_ALL
    if not _LIST_DIRTY and not _LIST_CLEAR_ALL:
        return
    try:
        with store_tx() as conn:
            if _LIST_CLEAR_ALL:
                conn.execute("DELETE FROM dir_list")
                _LIST_CLEAR_ALL = False
                _LIST_DIRTY.clear()
                return
            for ckey, entry in list(_LIST_DIRTY.items()):
                path, _, hidden = ckey.partition("\x00")
                if not path:
                    continue
                sh = 1 if hidden == "1" else 0
                if entry is None:
                    conn.execute("DELETE FROM dir_list WHERE path=? AND show_hidden=?", (path, sh))
                else:
                    conn.execute(
                        "INSERT INTO dir_list (path, show_hidden, mtime, partial, items) "
                        "VALUES (?,?,?,?,?) ON CONFLICT(path, show_hidden) DO UPDATE SET "
                        "mtime=excluded.mtime, partial=excluded.partial, items=excluded.items",
                        (path, sh, entry.get("mtime", 0) or 0,
                         1 if entry.get("partial") else 0,
                         json.dumps(entry.get("items") or [], ensure_ascii=False)))
        _LIST_DIRTY.clear()
    except Exception:
        pass


def _invalidate_list_cache(path):
    """删除指定目录的列表缓存（文件操作后调用），同时清理两种 show_hidden 变体。"""
    for _f in (True, False):
        _pop_list_entry(_list_cache_key(path, _f))
    _pop_list_entry(path)  # 兼容旧版（无 show_hidden 后缀）缓存
    _save_list_cache()


def _invalidate_dir_size(dir_path):
    """删除指定目录的大小缓存"""
    _pop_dir_size(dir_path)
    _pop_dir_size(dir_path.replace("\\", "/"))
    _save_cache()


def _purge_pseudo_fs_cache():
    """清掉伪文件系统带来的脏统计：历史缓存里 /proc 之类的"大小"是虚拟值
    （/proc/kcore 恒为 128TB），会让根目录总大小显示成上百 TB。
    这里既清目录大小缓存，也清列表缓存——后者存的是目录项快照，同样带着旧数字。"""
    global _LIST_CLEAR_ALL
    dirty = False
    for mp in _pseudo_mount_points():
        if _DIR_SIZE_CACHE.get(mp) is not None:
            _pop_dir_size(mp)
            dirty = True
    if dirty:
        _save_cache()
    if _LIST_CACHE:
        _LIST_CACHE.clear()
        _LIST_DIRTY.clear()
        _LIST_CLEAR_ALL = True
        _save_list_cache()


_purge_pseudo_fs_cache()


# 目录大小缓存的有效期（秒）：目录 mtime 只反映"直接子项"的增删，
# 深层新增/删除文件不会更新它，所以再加一道时间上限，保证数字最多陈旧这么久。
_DIR_SIZE_TTL = 3600.0


def _dir_size_cache_hit(cached, current_mtime):
    """缓存是否可信：目录 mtime 未变，且没超过有效期。"""
    if not cached or cached.get("size") is None:
        return False
    if abs(cached.get("dir_mtime", 0) - current_mtime) >= 0.1:
        return False
    return (time.time() - cached.get("ts", 0)) < _DIR_SIZE_TTL


def get_dir_size(dir_path):
    """基于 mtime 的持久化缓存：目录未变动则秒回，有变动才重新计算。返回 None 表示无法计算。"""
    if _in_pseudo_fs(dir_path):
        return 0        # 伪文件系统不占磁盘，别去 du 那 128TB 的 kcore
    try:
        current_mtime = os.stat(dir_path).st_mtime
    except OSError:
        return None

    cached = _DIR_SIZE_CACHE.get(dir_path)
    if _dir_size_cache_hit(cached, current_mtime):
        return cached.get("size", 0)

    result = None
    try:
        if sys.platform.startswith("win"):
            result = _get_dir_size_windows(dir_path)
        else:
            result = _get_dir_size_unix(dir_path)
    except Exception:
        pass

    _set_dir_size(dir_path, {"size": result, "dir_mtime": current_mtime, "ts": time.time()})
    _save_cache()
    return result


def _get_dir_size_unix(dir_path, timeout=5):
    """Linux/macOS: du -sb（C 实现，单目录通常毫秒级）。
    额外用 --exclude 跳过伪文件系统，避免 /proc/kcore（128TB）这类虚拟大小污染统计。"""
    cmd = ["du", "-sb"]
    if sys.platform.startswith("linux"):
        for mp in _pseudo_mount_points():
            cmd.append("--exclude=" + mp)
    cmd.append(dir_path)
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout).stdout
        return int(out.split()[0]) if out.split() else 0
    except (subprocess.TimeoutExpired, OSError, ValueError):
        return None


def _get_dir_size_windows(dir_path):
    """Windows: dir /s /-c 解析汇总大小"""
    out = subprocess.run(
        ["cmd", "/c", "dir", "/s", "/-c", dir_path],
        capture_output=True, text=True, timeout=5
    ).stdout
    for line in out.splitlines():
        low = line.strip().lower()
        if "bytes" in low or "字节" in low:
            # " 3,456,789,012 bytes" 或类似格式
            parts = line.replace(",", "").split()
            for p in reversed(parts):
                try:
                    return int(p)
                except ValueError:
                    continue
    return 0


_local_index = threading.local()

def _get_index_conn_cached():
    """线程本地复用索引连接：list_directory 会给每个子目录查一次索引，
    反复新建/关闭连接开销很大，这里按线程复用单连接。"""
    conn = getattr(_local_index, "conn", None)
    if conn is None:
        conn = _get_index_conn()
        _local_index.conn = conn
    return conn


def _get_dir_size_from_index(dir_path):
    """从索引中递归计算目录大小。返回 None 表示目录不在索引中（需降级到 du）。"""
    path_norm = os.path.normpath(dir_path).replace("\\", "/")
    # 短 TTL 缓存：子树求和即使走索引也要聚合大量行（大目录可达数百毫秒），
    # 短时间内重复浏览同一目录不重复求和
    now = time.monotonic()
    hit = _INDEX_SIZE_CACHE.get(path_norm)
    if hit and (now - hit[1]) < _INDEX_SIZE_TTL:
        return hit[0]
    try:
        conn = _get_index_conn_cached()
        # 先检查目录是否存在于索引
        dir_row = conn.execute(
            "SELECT 1 FROM index_files WHERE abs_path = ? AND is_dir = 1",
            (path_norm,)
        ).fetchone()
        if not dir_row:
            return None  # 目录不在索引中，需 du
        # 查该目录下所有文件大小总和
        row = conn.execute(
            "SELECT COALESCE(SUM(size), 0) FROM index_files WHERE is_dir = 0 AND (abs_path = ? OR abs_path LIKE ?)",
            (path_norm, path_norm.rstrip("/") + "/%")
        ).fetchone()
        size = int(row[0] or 0)
        if len(_INDEX_SIZE_CACHE) > 4096:
            _INDEX_SIZE_CACHE.clear()
        _INDEX_SIZE_CACHE[path_norm] = (size, now)
        return size
    except Exception:
        pass
    return None


# 索引子树大小查询的进程内缓存：path -> (size, monotonic_ts)
_INDEX_SIZE_CACHE = {}
_INDEX_SIZE_TTL = 60.0


# ---------- 后台目录大小计算（避免列表请求被大目录 du 阻塞） ----------
_SIZE_PENDING_LOCK = threading.Lock()
_SIZE_PENDING = set()   # 正在后台计算的目录绝对路径
_SIZE_SEM = threading.Semaphore(8)   # 限制并发 du 数量，避免多目录同时 du 打爆磁盘 IO


def get_dir_size_cached(dir_path):
    """只查缓存与索引，绝不触发 du。返回 None 表示暂时未知。"""
    if _in_pseudo_fs(dir_path):
        return 0
    try:
        current_mtime = os.stat(dir_path).st_mtime
    except OSError:
        return None
    cached = _DIR_SIZE_CACHE.get(dir_path)
    if _dir_size_cache_hit(cached, current_mtime):
        return cached.get("size", 0)
    return _get_dir_size_from_index(dir_path)


def _bg_compute_dir_size(dir_path):
    """后台线程：du 计算目录大小并写入缓存，不阻塞任何请求"""
    try:
        with _SIZE_SEM:  # 限制并发 du，避免大量子目录同时 du 打爆磁盘 IO 导致请求超时
            size = _get_dir_size_unix(dir_path, timeout=60)
        if size is not None:
            try:
                mtime = os.stat(dir_path).st_mtime
            except OSError:
                mtime = 0
            _set_dir_size(dir_path, {"size": size, "dir_mtime": mtime, "ts": time.time()})
            _save_cache()
    finally:
        with _SIZE_PENDING_LOCK:
            _SIZE_PENDING.discard(dir_path)
        # 失效父目录的列表缓存（含两种 show_hidden 变体），下次加载列表即可带上真实大小
        for _f in (True, False):
            _pop_list_entry(_list_cache_key(os.path.dirname(dir_path), _f))
        _pop_list_entry(os.path.dirname(dir_path))


def _ensure_dir_size_async(dir_path):
    """确保目录大小正在（或已经）后台计算；返回 True 表示本次新启动了任务。
    限制待计算目录总数，避免海量子目录各自起一个线程堆积打爆内存。"""
    with _SIZE_PENDING_LOCK:
        if dir_path in _SIZE_PENDING:
            return False
        if len(_SIZE_PENDING) >= 64:  # 并发上限：其余目录留待下次访问/刷新再算
            return False
        _SIZE_PENDING.add(dir_path)
    threading.Thread(target=_bg_compute_dir_size, args=(dir_path,), daemon=True).start()
    return True


def get_file_info(file_path, base_path, compute_size=True):
    try:
        stat = os.stat(file_path)
        is_dir = os.path.isdir(file_path)
        ext = os.path.splitext(file_path)[1].lower()
        if ext.startswith("."):
            ext = ext[1:]
        file_type = "目录" if is_dir else (ext.upper() if ext else "未知")
        rel_path = os.path.relpath(file_path, base_path) if base_path else file_path
        if rel_path == ".":
            rel_path = ""
        # 文件大小：文件直接用 stat，目录优先查索引（索引命中则毫秒级），查不到才 du。
        # 注意：compute_size=False 时跳过目录 du 遍历（避免在目录列表时阻塞数分钟）。
        unknown_size = False
        size_pending = False
        if not is_dir:
            file_size = stat.st_size
        else:
            if not compute_size:
                # 浏览列表：只查缓存/索引（毫秒级），绝不同步 du。
                # 命中则直接给大小；未命中标记"待计算"，交由前端轮询、后端异步 du，保持列表秒开。
                file_size = get_dir_size_cached(file_path)
                if file_size is None:
                    unknown_size = True
                    size_pending = True
            else:
                # 单点查询（如属性页）：同样只查缓存/索引，未命中标空，不阻塞请求
                file_size = get_dir_size_cached(file_path)
                if file_size is None:
                    unknown_size = True
        info = {
            "name": os.path.basename(file_path),
            "path": rel_path.replace("\\", "/"),
            "is_dir": is_dir,
            "size": file_size if not unknown_size else 0,
            "size_str": "" if unknown_size else format_size(file_size),
            "size_pending": size_pending,
            "type": file_type,
            "mtime": datetime.fromtimestamp(stat.st_mtime).strftime("%Y-%m-%d %H:%M:%S"),
            "ext": ext,
        }
        # 创建时间：优先 st_birthtime（真创建时间），Linux 无该字段时用 st_ctime（inode 变更时间）近似
        try:
            _birth = getattr(stat, "st_birthtime", None)
            info["ctime"] = datetime.fromtimestamp(
                _birth if _birth else stat.st_ctime
            ).strftime("%Y-%m-%d %H:%M:%S")
        except (OSError, ValueError, OverflowError):
            pass
        if is_dir:
            # 下一级子项数量（文件夹/文件）：scandir 仅统计条目，无递归，开销极小
            try:
                n_dirs = n_files = 0
                with os.scandir(file_path) as it:
                    for e in it:
                        try:
                            if e.is_dir(follow_symlinks=False):
                                n_dirs += 1
                            else:
                                n_files += 1
                        except OSError:
                            pass
                info["n_dirs"] = n_dirs
                info["n_files"] = n_files
            except (OSError, PermissionError):
                pass   # 无权限等情况：不带计数字段，前端不显示徽标
        return info
    except (OSError, PermissionError):
        return None


def _list_cache_key(path, show_hidden):
    """列表缓存键：show_hidden 不同视为不同快照；用字符串键以便 JSON 持久化。"""
    return path + "\x00" + ("1" if show_hidden else "0")


def list_directory(path, get_sizes=False, show_hidden=False):
    """带缓存的目录列表：目录 mtime 未变则秒回。

    get_sizes 控制是否对每个目录条目计算大小。
    - get_sizes=True：遍历每个子目录计算 du（慢，用于单点查询）。
    - get_sizes=False（默认）：目录大小走缓存 / 索引，未命中则标"大小未知"（快，用于列表加载）。

    show_hidden 控制是否列出以点开头的隐藏文件（.gitignore、.env 等）。
    """
    try:
        dir_mtime = os.stat(path).st_mtime
    except OSError:
        return []

    ckey = _list_cache_key(path, show_hidden)
    # v3：条目含 n_dirs/n_files 子项计数与 ctime；旧版本缓存视为失效
    # 列表缓存命中即返回：目录大小由后台 du 异步补齐，无需重建列表，
    # 否则大目录（如 /home/zhangjie/Desktop）每次请求都重新遍历所有条目 + 查索引，极易超时
    cached = _LIST_CACHE.get(ckey)
    if cached and cached.get("v") == 3 and abs(cached.get("mtime", 0) - dir_mtime) < 0.1:
        return cached["items"]

    items = []
    try:
        entries = os.listdir(path)
    except (OSError, PermissionError):
        return items
    for entry in entries:
        if entry.startswith(".") and not show_hidden:
            continue
        full_path = os.path.join(path, entry)
        info = get_file_info(full_path, path, compute_size=get_sizes)
        if info:
            items.append(info)
    items.sort(key=lambda x: (not x["is_dir"], x["name"].lower()))

    # 凡列表中仍有"计算中…/大小未知"的目录，视为不完整快照：
    # get_sizes=True 时忽略缓存重建，以补齐大小（重建仅 scandir+缓存查询，毫秒级）
    _set_list_entry(ckey, {
        "v": 3, "mtime": dir_mtime, "items": items,
        "partial": any(x["is_dir"] and x.get("size_str") in ("大小未知", "计算中…") for x in items),
    })
    _save_list_cache()
    return items


def format_size_safe(size):
    """安全格式化文件大小（API 端使用，避免导入 JS 函数）"""
    if size < 1024:
        return f"{size} B"
    elif size < 1024 * 1024:
        return f"{size / 1024:.1f} KB"
    elif size < 1024 * 1024 * 1024:
        return f"{size / 1024 / 1024:.1f} MB"
    else:
        return f"{size / 1024 / 1024 / 1024:.2f} GB"


def _human_size(size_bytes):
    """格式化文件大小"""
    for unit in ['B', 'KB', 'MB', 'GB', 'TB']:
        if size_bytes < 1024:
            return f"{size_bytes:.1f} {unit}" if unit != 'B' else f"{int(size_bytes)} B"
        size_bytes /= 1024
    return f"{size_bytes:.1f} PB"

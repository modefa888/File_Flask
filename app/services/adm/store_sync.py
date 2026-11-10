"""store.db 数据同步 / 更新（后台「在线更新」页的 store.db 同步 Tab）。

设计要点
--------
- 只处理 data/storage/store.db，不触碰索引库与其它运行时数据。
- 快照导出用 sqlite3.Connection.backup()：WAL 中尚未合并的数据也会写进快照，
  得到一份可直接给另一台机器导入的一致 .db 文件。
- 同步不替换文件，而是 ATTACH 来源库后按「两边共有的表 + 共有的列」逐表搬运；
  服务正在运行时也能安全同步，不会出现旧连接还指向被替换文件的问题。
- 每次同步前自动备份当前库快照到 data/update_backup/store_*.db，并先执行
  init_store_db() 补齐新版本代码新增的表 / 列（表结构更新）。
- 耗时动作在后台线程执行，前端按 run_id 轮询 /api/adm/update/store/task。
"""
import os
import re
import sqlite3
import threading
import time
import uuid
import urllib.request
from urllib.parse import quote, urlparse

from ... import config
from ...log import get_logger
from ..common import store_db

_log = get_logger()

_STORE_DB = config._STORE_DB_FILE
_BACKUP_DIR = os.path.join(config.DATA_ROOT, "update_backup")
_UPLOAD_DIR = os.path.join(config.DATA_ROOT, "update_uploads")
_MAX_DB_BYTES = 512 * 1024 * 1024
_MAX_TASKS = 10
_KEEP_BACKUPS = 10
_SRC_PREFIX = "store_src_"
_SRC_TTL = 2 * 3600          # 校验过的来源文件保留 2 小时，期间可重复同步
_DIFF_MAX_ROWS = 200000      # 超过该行数不做逐行比对，只报行数差异

# 这些表是可重建的缓存 / 日志，默认不同步，避免把另一台机器的目录缓存、
# 操作日志、AI 用量统计盖到本机（业务数据如收藏夹、账号、配置一律同步）
_CACHE_TABLES = {
    "dir_size", "dir_list", "op_log", "db_write_log", "ai_usage", "ai_calls",
    "cron_runs", "api_stats", "video_covers", "ai_undo_snapshots",
}

_LOCK = threading.RLock()
_TASKS = {}
_KIND_OF = {
    "sync": "dbsync", "restore": "dbsync", "schema": "dbschema",
    "backup": "dbbackup", "delete": "dbdelete",
}


def _now():
    return time.time()


def _quote_ident(name):
    return '"' + str(name).replace('"', '""') + '"'


def _tables(conn, schema="main"):
    """返回 {表名: [列名...]}，排除 sqlite 内部表。"""
    rows = conn.execute(
        "SELECT name FROM %s.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%%'" % schema
    ).fetchall()
    out = {}
    for (name,) in rows:
        cols = conn.execute("PRAGMA %s.table_info(%s)" % (schema, _quote_ident(name))).fetchall()
        out[name] = [c[1] for c in cols]
    return out


def _expected_tables():
    """从 store_db 的建表脚本里取出「新版本应当存在」的表名。"""
    return set(re.findall(r"CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+(\w+)",
                          store_db._SCHEMA, re.I))


def _valid_tables(value):
    """前端传来的表过滤条件：只保留安全的标识符，空列表 = 同步全部共有表。"""
    if isinstance(value, (list, tuple)):
        raw = [str(x) for x in value]
    else:
        raw = str(value or "").replace("，", ",").split(",")
    return [x.strip() for x in raw if re.fullmatch(r"\w+", x.strip() or "")]


# --------------------------------------------------------------------------- 快照 / 备份
def snapshot(target):
    """生成 store.db 的一致性快照（含 WAL 里的数据）。"""
    src = store_db.store_conn()
    dst = None
    try:
        dst = sqlite3.connect(target, timeout=30)
        src.backup(dst)
    finally:
        if dst is not None:
            dst.close()
        src.close()


def export_path():
    os.makedirs(_UPLOAD_DIR, exist_ok=True)
    return os.path.join(_UPLOAD_DIR, "store_export_%s.db" % uuid.uuid4().hex[:10])


def upload_path():
    os.makedirs(_UPLOAD_DIR, exist_ok=True)
    return os.path.join(_UPLOAD_DIR, "store_upload_%s.db" % uuid.uuid4().hex[:10])


def new_source_path():
    """给「校验过的来源库」分配一个固定路径；token 即文件名里的随机串。

    用文件名而不是内存字典保存引用：服务重启后 token 依然可用，也不需要把
    几十 MB 的文件再上传一次才能执行同步。
    """
    prune_sources()
    os.makedirs(_UPLOAD_DIR, exist_ok=True)
    return os.path.join(_UPLOAD_DIR, "%s%s.db" % (_SRC_PREFIX, uuid.uuid4().hex[:16]))


def source_token(path):
    return os.path.basename(path)[len(_SRC_PREFIX):-3]


def source_path(token):
    """token → 来源文件路径；严格校验格式，杜绝目录穿越。"""
    token = (token or "").strip()
    if not re.fullmatch(r"[0-9a-f]{16}", token):
        return ""
    path = os.path.join(_UPLOAD_DIR, "%s%s.db" % (_SRC_PREFIX, token))
    return path if os.path.isfile(path) else ""


def prune_sources():
    """清理过期的来源文件（校验后 2 小时未使用）。"""
    try:
        now = _now()
        for name in os.listdir(_UPLOAD_DIR):
            if not (name.startswith(_SRC_PREFIX) and name.endswith(".db")):
                continue
            path = os.path.join(_UPLOAD_DIR, name)
            if now - os.path.getmtime(path) > _SRC_TTL:
                _remove_temp(path)
    except OSError:
        pass


def backup_path(name):
    """快照文件名校验：只允许 data/update_backup/store_*.db 的纯文件名。"""
    name = (name or "").strip()
    if (not name or name != os.path.basename(name) or "/" in name or "\\" in name
            or not name.startswith("store_") or not name.endswith(".db")):
        return ""
    return os.path.join(_BACKUP_DIR, name)


def backup_local(tag="manual"):
    """把当前库快照写到备份目录，返回绝对路径；只保留最近 _KEEP_BACKUPS 份。"""
    os.makedirs(_BACKUP_DIR, exist_ok=True)
    path = os.path.join(_BACKUP_DIR, "store_%s_%s.db" %
                        (tag, time.strftime("%Y%m%d_%H%M%S", time.localtime(_now()))))
    # 同一秒内重复备份会撞名，加短随机后缀
    if os.path.exists(path):
        path = path[:-3] + "_%s.db" % uuid.uuid4().hex[:4]
    snapshot(path)
    try:
        names = sorted(
            (n for n in os.listdir(_BACKUP_DIR) if n.startswith("store_") and n.endswith(".db")),
            key=lambda n: os.path.getmtime(os.path.join(_BACKUP_DIR, n)), reverse=True)
        for n in names[_KEEP_BACKUPS:]:
            try:
                os.remove(os.path.join(_BACKUP_DIR, n))
            except OSError:
                pass
    except OSError:
        pass
    return path


def list_backups():
    out = []
    try:
        names = os.listdir(_BACKUP_DIR)
    except OSError:
        return out
    for name in names:
        if not (name.startswith("store_") and name.endswith(".db")):
            continue
        path = os.path.join(_BACKUP_DIR, name)
        try:
            st = os.stat(path)
        except OSError:
            continue
        tag = "同步前自动" if name.startswith("store_pre_") else "手动备份"
        out.append({"name": name, "label": tag, "size": st.st_size, "ts": st.st_mtime})
    out.sort(key=lambda x: x["ts"], reverse=True)
    return out


def delete_backup(name):
    path = backup_path(name)
    if not path:
        return "快照文件名不合法"
    if not os.path.isfile(path):
        return "快照不存在"
    try:
        os.remove(path)
    except OSError as e:
        return "删除失败：%s" % e
    return ""


def upgrade_schema():
    """幂等执行 store_db 的建表 / 补列，返回本次新增的表与列。"""
    def snap():
        conn = store_db.store_conn()
        try:
            t = _tables(conn)
            return set(t), {(name, col) for name, cols in t.items() for col in cols}
        finally:
            conn.close()

    before_t, before_c = snap()
    store_db.init_store_db()
    after_t, after_c = snap()
    return {
        "tables": sorted(after_t - before_t),
        "columns": sorted("%s.%s" % x for x in (after_c - before_c)),
    }


def status():
    """本地 store.db 概览 + 快照列表，供页面初始化。"""
    conn = store_db.store_conn()
    try:
        tables = _tables(conn)
        rows = 0
        for name in tables:
            try:
                rows += conn.execute("SELECT COUNT(*) FROM %s" % _quote_ident(name)).fetchone()[0]
            except sqlite3.Error:
                pass
        missing = sorted(_expected_tables() - set(tables))
    finally:
        conn.close()

    def fsize(path):
        try:
            return os.path.getsize(path)
        except OSError:
            return 0

    def mtime(path):
        try:
            return os.path.getmtime(path)
        except OSError:
            return 0

    return {
        "ok": True,
        "path": _STORE_DB,
        "size": fsize(_STORE_DB),
        "mtime": mtime(_STORE_DB),
        "wal_size": fsize(_STORE_DB + "-wal"),
        "table_count": len(tables),
        "row_count": rows,
        "missing_tables": missing,
        "cache_tables": sorted(_CACHE_TABLES),
        "backup_dir": _BACKUP_DIR,
        "backups": list_backups(),
    }


# --------------------------------------------------------------------------- 后台任务
def _new_task(action):
    rid = "s" + uuid.uuid4().hex[:12]
    task = {
        "id": rid,
        "kind": _KIND_OF.get(action, "dbsync"),
        "action": action,
        "status": "running",
        "step": "init",
        "progress": 0,
        "events": [],
        "started_at": _now(),
        "finished_at": 0,
        "error": "",
        "result": {},
    }
    with _LOCK:
        _TASKS[rid] = task
        if len(_TASKS) > _MAX_TASKS:
            oldest = sorted(_TASKS.values(), key=lambda t: t["started_at"])[:-_MAX_TASKS]
            for t in oldest:
                _TASKS.pop(t["id"], None)
    return task


def _emit(task, text, level="info", progress=None, step=None):
    with _LOCK:
        task["events"].append({"t": _now(), "text": text, "level": level})
        if len(task["events"]) > 300:
            del task["events"][:len(task["events"]) - 300]
        if progress is not None:
            task["progress"] = max(0, min(100, int(progress)))
        if step:
            task["step"] = step
    _log.info("[store.db 同步] %s", text)


def _finish(task, status_, message="", error=""):
    with _LOCK:
        if message:
            task["events"].append({
                "t": _now(), "text": message,
                "level": "error" if status_ == "error" else "ok",
            })
        task["status"] = status_
        task["error"] = error
        task["finished_at"] = _now()
        if status_ == "done":
            task["progress"] = 100


def get_task(run_id):
    with _LOCK:
        task = _TASKS.get(run_id)
        if not task:
            return None
        snap = dict(task)
        snap["events"] = list(task["events"])
        return snap


def current_task():
    """页面刷新后用它续上正在执行的 store.db 任务进度。"""
    with _LOCK:
        running = [t for t in _TASKS.values() if t["status"] == "running"]
        if not running:
            return None
        task = max(running, key=lambda t: t["started_at"])
        snap = dict(task)
        snap["events"] = list(task["events"])
        return snap


def _source_tables(path):
    """校验来源是有效的 SQLite 库，并返回它的表结构。"""
    if not path or not os.path.isfile(path):
        raise RuntimeError("来源数据库文件不存在")
    if os.path.getsize(path) < 100:
        raise RuntimeError("来源文件太小，不是有效的 SQLite 数据库")
    with open(path, "rb") as f:
        if f.read(16) != b"SQLite format 3\x00":
            raise RuntimeError("来源不是 SQLite 数据库（请使用「下载快照」导出的 .db 文件）")
    conn = sqlite3.connect("file:%s?mode=ro" % quote(path), uri=True, timeout=15)
    try:
        tables = _tables(conn)
    finally:
        conn.close()
    if not tables:
        raise RuntimeError("来源数据库里没有可同步的表")
    return tables


def download_to(url, token, dest):
    """把远程 .db 快照下载到指定路径；只允许 http(s)，返回字节数。"""
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise RuntimeError("远程地址必须是 http(s):// 开头的完整 URL")
    headers = {"User-Agent": "File_Flask-store-sync"}
    if token:
        headers["Authorization"] = "Bearer " + token.strip()
    req = urllib.request.Request(url, headers=headers)
    total = 0
    with urllib.request.urlopen(req, timeout=60) as resp, open(dest, "wb") as f:
        while True:
            chunk = resp.read(256 * 1024)
            if not chunk:
                break
            total += len(chunk)
            if total > _MAX_DB_BYTES:
                raise RuntimeError("远程文件超过 512MB，已中止下载")
            f.write(chunk)
    return total


def _download(url, token, task):
    """一键同步（未经校验）时的远程下载，写入临时路径。"""
    path = export_path()
    try:
        total = download_to(url, token, path)
    except Exception:
        _remove_temp(path)      # 下载中断不留半个 .db
        raise
    _emit(task, "远程快照下载完成：%.2f MB" % (total / 1024 / 1024), level="ok")
    return path


def _remove_temp(path):
    for p in (path, path + "-wal", path + "-shm", path + "-journal"):
        try:
            if os.path.isfile(p):
                os.remove(p)
        except OSError:
            pass


def _count(conn, schema, table):
    return conn.execute("SELECT COUNT(*) FROM %s.%s" %
                        (schema, _quote_ident(table))).fetchone()[0]


def inspect(src, params, source_name=""):
    """校验来源库并逐表对比本地库，返回可视化差异报告（全程只读）。

    差异行数用「共有列上的 EXCEPT」计算：能看出来源比本地多了哪些内容、
    本地比来源多了哪些内容，而不只是笼统地比较总行数。
    """
    src_tables = _source_tables(src)
    mode = params.get("mode") or "merge"
    if mode not in ("merge", "replace", "overwrite"):
        raise RuntimeError("未知的同步模式：%s" % mode)
    skip_cache = bool(params.get("skip_cache", True))
    selected = set(params.get("tables") or [])

    conn = store_db.store_conn()
    try:
        conn.execute("PRAGMA busy_timeout=30000")
        conn.execute("ATTACH DATABASE ? AS src", (src,))
        local = _tables(conn, "main")
        tables = []
        for name in sorted(set(src_tables) | set(local)):
            lc, sc = local.get(name, []), src_tables.get(name, [])
            common = [c for c in sc if c in lc]
            src_only_cols = [c for c in sc if c not in lc]
            local_only_cols = [c for c in lc if c not in sc]
            lrows = _count(conn, "main", name) if name in local else 0
            srows = _count(conn, "src", name) if name in src_tables else 0

            src_diff = local_diff = -1        # -1 = 表太大，未做逐行比对
            qt = _quote_ident(name)
            if (name in local and name in src_tables and common
                    and lrows + srows <= _DIFF_MAX_ROWS):
                cols = ", ".join(_quote_ident(c) for c in common)
                try:
                    src_diff = conn.execute(
                        "SELECT COUNT(*) FROM (SELECT %s FROM src.%s EXCEPT SELECT %s FROM main.%s)"
                        % (cols, qt, cols, qt)).fetchone()[0]
                    local_diff = conn.execute(
                        "SELECT COUNT(*) FROM (SELECT %s FROM main.%s EXCEPT SELECT %s FROM src.%s)"
                        % (cols, qt, cols, qt)).fetchone()[0]
                except sqlite3.Error:
                    src_diff = local_diff = -1

            if name not in local:
                status = "src_only"
            elif name not in src_tables:
                status = "local_only"
            elif src_only_cols or local_only_cols:
                status = "schema"
            elif src_diff < 0:
                status = "large"
            elif src_diff == 0 and local_diff == 0:
                status = "same"
            else:
                status = "diff"

            reason = ""
            if selected and name not in selected:
                reason = "不在指定表范围"
            elif skip_cache and name.lower() in _CACHE_TABLES:
                reason = "缓存 / 日志表"
            elif name not in local:
                reason = "本机无此表"
            elif name not in src_tables:
                reason = "来源无此表"
            elif not common:
                reason = "无共有列"

            if reason:
                change = 0
            elif mode == "overwrite":
                change = lrows + srows      # 先清空本地，再导入来源
            elif src_diff >= 0:
                change = src_diff           # 来源中与本地不同的行
            else:
                change = max(srows - lrows, 0)

            tables.append({
                "name": name,
                "status": status,
                "local_rows": lrows,
                "src_rows": srows,
                "src_diff": src_diff,
                "local_diff": local_diff,
                "common_cols": len(common),
                "src_only_cols": src_only_cols[:8],
                "local_only_cols": local_only_cols[:8],
                "skip": bool(reason),
                "skip_reason": reason,
                "change": change,
            })
    finally:
        conn.close()

    def count(pred):
        return sum(1 for t in tables if pred(t))

    summary = {
        "src_tables": len(src_tables),
        "local_tables": len(local),
        "common": count(lambda t: t["status"] not in ("src_only", "local_only")),
        "diff": count(lambda t: t["status"] in ("diff", "large")),
        "schema": count(lambda t: t["status"] == "schema"),
        "src_only": count(lambda t: t["status"] == "src_only"),
        "local_only": count(lambda t: t["status"] == "local_only"),
        "same": count(lambda t: t["status"] == "same"),
        "skipped": count(lambda t: t["skip"]),
        "syncable": count(lambda t: not t["skip"]),
        "change": sum(t["change"] for t in tables if not t["skip"]),
        "estimated": count(lambda t: t["src_diff"] < 0 and
                           t["status"] not in ("src_only", "local_only")),
    }
    return {
        "ok": True,
        "source": {"name": source_name or os.path.basename(src),
                   "size": os.path.getsize(src), "tables": len(src_tables)},
        "local": {"tables": len(local)},
        "mode": mode,
        "skip_cache": skip_cache,
        "tables_filter": sorted(selected),
        "summary": summary,
        "tables": tables,
    }


def _merge(src, params, task, src_tables):
    """ATTACH 来源库，逐表把数据同步进本地 store.db。"""
    mode = params.get("mode") or "merge"
    if mode not in ("merge", "replace", "overwrite"):
        raise RuntimeError("未知的同步模式：%s" % mode)
    selected = set(params.get("tables") or [])
    skip_cache = bool(params.get("skip_cache", True))

    conn = store_db.store_conn()
    try:
        conn.execute("ATTACH DATABASE ? AS src", (src,))
        conn.execute("PRAGMA busy_timeout=30000")
        local = _tables(conn, "main")
        conn.execute("BEGIN")
        changed = 0
        done = 0
        skipped = 0
        for name in sorted(src_tables):
            if selected and name not in selected:
                continue
            if skip_cache and name.lower() in _CACHE_TABLES:
                skipped += 1
                continue
            if name not in local:
                _emit(task, "跳过 %s：本机没有这张表" % name, level="warn")
                continue
            cols = [c for c in src_tables[name] if c in local[name]]
            if not cols:
                continue
            qlist = ", ".join(_quote_ident(c) for c in cols)
            qt = _quote_ident(name)
            before = conn.total_changes
            if mode == "overwrite":
                conn.execute("DELETE FROM main.%s" % qt)
            verb = {"merge": "INSERT OR IGNORE", "replace": "INSERT OR REPLACE",
                    "overwrite": "INSERT"}[mode]
            conn.execute("%s INTO main.%s (%s) SELECT %s FROM src.%s" % (verb, qt, qlist, qlist, qt))
            delta = conn.total_changes - before
            changed += delta
            done += 1
            if delta:
                _emit(task, "%s：%d 行" % (name, delta), level="dim")
        conn.commit()
        if skipped:
            _emit(task, "按选项跳过 %d 张缓存 / 日志表" % skipped, level="dim")
        return {"mode": mode, "tables": done, "rows": changed, "skipped": skipped}
    except Exception:
        try:
            conn.rollback()
        except sqlite3.Error:
            pass
        raise
    finally:
        conn.close()


def _do_sync(task, params):
    src = params.get("src_path") or ""
    cleanup = []
    if not src and params.get("src_token"):
        # 已校验过的来源：直接用 token 定位文件，不重复上传 / 下载
        src = source_path(params["src_token"])
        if not src:
            raise RuntimeError("来源文件已过期，请重新校验后再同步")
    if params.get("url"):
        _emit(task, "正在下载远程 store.db 快照…", step="init")
        src = _download(params["url"], params.get("token", ""), task)
        cleanup.append(src)
    try:
        src_tables = _source_tables(src)
        _emit(task, "来源校验通过：%s（%d 张表）" %
              (os.path.basename(src), len(src_tables)), level="ok", progress=10, step="init")

        _emit(task, "正在备份当前 store.db…", step="backup")
        bak = backup_local("pre")
        _emit(task, "已备份当前库：%s" % os.path.basename(bak), level="ok", progress=30)
        task["result"] = {"backup": os.path.basename(bak)}

        _emit(task, "正在检查并更新表结构…", step="schema")
        added = upgrade_schema()
        _emit(task, "表结构检查完成：新增 %d 张表、%d 个列" %
              (len(added["tables"]), len(added["columns"])), progress=45, step="schema")

        _emit(task, "开始同步数据（模式：%s）…" % (params.get("mode") or "merge"), step="merge")
        result = _merge(src, params, task, src_tables)
        task["result"].update(result)
        _emit(task, "同步完成：%d 张表、%d 行变更" % (result["tables"], result["rows"]),
              level="ok", progress=95, step="merge")
        _emit(task, "数据已在当前服务中生效，无需重启", level="ok", progress=100, step="done")
    finally:
        for path in cleanup:
            _remove_temp(path)
        if params.get("cleanup_src") and params.get("src_path"):
            _remove_temp(params["src_path"])


def _do_backup(task, params):
    _emit(task, "正在生成当前 store.db 的一致快照…", step="init")
    path = backup_local("manual")
    task["result"] = {"backup": os.path.basename(path)}
    _emit(task, "快照已保存：%s" % os.path.basename(path), level="ok", progress=100, step="done")


def _do_schema(task, params):
    _emit(task, "正在检查 store.db 表结构…")
    added = upgrade_schema()
    task["result"] = added
    if added["tables"]:
        _emit(task, "补建表：" + "、".join(added["tables"]), level="ok")
    if added["columns"]:
        _emit(task, "补建列：" + "、".join(added["columns"][:20]), level="ok")
    _emit(task, "表结构已是最新（新增 %d 表 / %d 列）" %
          (len(added["tables"]), len(added["columns"])), level="ok", progress=100, step="done")


def _do_delete(task, params):
    name = params.get("name") or ""
    err = delete_backup(name)
    if err:
        raise RuntimeError(err)
    _emit(task, "已删除快照：%s" % name, level="ok", progress=100, step="done")


def normalize_params(params):
    """统一归一化前端参数（multipart 表单里都是字符串）。"""
    params = dict(params or {})
    raw_skip = params.get("skip_cache", True)
    params["skip_cache"] = (raw_skip if isinstance(raw_skip, bool)
                            else str(raw_skip).strip().lower() in ("1", "true", "yes", "on"))
    params["mode"] = str(params.get("mode") or "merge").strip().lower()
    params["tables"] = _valid_tables(params.get("tables"))
    params["src_token"] = str(params.get("src_token") or "").strip()
    return params


def start_task(action, params=None):
    """启动后台任务，返回 (run_id, 错误)。同一时间只允许一个 store.db 任务。"""
    params = normalize_params(params)
    if action not in _KIND_OF:
        return "", "未知操作：%s" % action
    with _LOCK:
        if any(t["status"] == "running" for t in _TASKS.values()):
            return "", "已有 store.db 任务正在执行，请等待完成"

    task = _new_task(action)

    def runner():
        try:
            if action in ("sync", "restore"):
                _do_sync(task, params)
            elif action == "backup":
                _do_backup(task, params)
            elif action == "schema":
                _do_schema(task, params)
            elif action == "delete":
                _do_delete(task, params)
            _finish(task, "done", "任务完成")
        except Exception as e:
            _log.exception("store.db %s 任务失败", action)
            _finish(task, "error", "失败：%s" % e, str(e))

    threading.Thread(target=runner, daemon=True).start()
    return task["id"], ""

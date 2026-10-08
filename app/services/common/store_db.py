"""统一存储层（SQLite，data/storage/store.db）。

把原先散落在 data/storage/*.json 的「高频增删改查」数据集中到一个库、按业务分表：

    video_covers     视频封面持久化索引（键 = sha1(视频名|大小)）
    dir_size         目录大小缓存
    dir_list         目录列表缓存（按 path + show_hidden 组合键）
    delete_history   删除（回收站）历史
    archive_history  压缩 / 解压历史
    plugin_registry  插件登记簿：插件状态
    plugin_history   插件登记簿：安装 / 卸载历史
    notify_history   通知历史（最新一条与游标放 store_meta）
    shares           分享记录（原独立库 data/storage/shares.db）
    ai_conversations / ai_messages / ai_prefs    AI 对话历史（原独立库 .file_manager_ai_chat.db）
    ai_undo_snapshots                           AI 文件改动快照（原独立库 .file_manager_ai_undo.db）
    ai_usage / ai_calls                        系统 AI 调用计数与明细
    store_meta       通用键值（含「旧 JSON / 旧库是否已导入」标记）

设计约定与 share_store.py 一致：
  - WAL + synchronous=NORMAL；每次操作独立连接，用完即关；
  - 写操作用 store_tx() 统一加锁 + 事务，避免「读-改-写」丢更新；
  - 建表用 CREATE TABLE IF NOT EXISTS 幂等完成，无独立迁移框架；
  - 旧 JSON 由各业务模块在导入时调用 migrate_json_once() 一次性导入，
    导入标记写进 store_meta，不会重复执行。
"""
import contextlib
import json
import os
import sqlite3
import threading

from ...config import _STORE_DB_FILE, AI_CHAT_LEGACY_DB, AI_UNDO_LEGACY_DB
from ...log import get_logger

_log = get_logger()

# 全局写锁：sqlite 自身能串行化单条语句，但「读-改-写」组合逻辑需要互斥
_lock = threading.RLock()

_SCHEMA = """
CREATE TABLE IF NOT EXISTS store_meta (
    key   TEXT PRIMARY KEY,
    value TEXT
);
-- 视频封面持久化索引
CREATE TABLE IF NOT EXISTS video_covers (
    key  TEXT PRIMARY KEY,
    name TEXT DEFAULT '',
    size INTEGER DEFAULT 0,
    file TEXT DEFAULT '',
    type TEXT DEFAULT ''
);
-- 目录大小缓存（size 允许为 NULL，表示「计算过但拿不到结果」）
CREATE TABLE IF NOT EXISTS dir_size (
    path      TEXT PRIMARY KEY,
    size      INTEGER,
    dir_mtime REAL DEFAULT 0,
    ts        REAL DEFAULT 0
);
-- 目录列表缓存
CREATE TABLE IF NOT EXISTS dir_list (
    path        TEXT NOT NULL,
    show_hidden INTEGER NOT NULL DEFAULT 0,
    mtime       REAL DEFAULT 0,
    partial     INTEGER DEFAULT 0,
    items       TEXT DEFAULT '[]',
    PRIMARY KEY (path, show_hidden)
);
-- 删除（回收站）历史
CREATE TABLE IF NOT EXISTS delete_history (
    seq           INTEGER PRIMARY KEY AUTOINCREMENT,
    id            TEXT UNIQUE,
    original_path TEXT DEFAULT '',
    trash_path    TEXT DEFAULT '',
    name          TEXT DEFAULT '',
    is_dir        INTEGER DEFAULT 0,
    size          INTEGER DEFAULT 0,
    deleted_at    INTEGER DEFAULT 0
);
-- 压缩 / 解压历史
CREATE TABLE IF NOT EXISTS archive_history (
    seq    INTEGER PRIMARY KEY AUTOINCREMENT,
    id     TEXT UNIQUE,
    kind   TEXT DEFAULT '',
    name   TEXT DEFAULT '',
    path   TEXT DEFAULT '',
    detail TEXT DEFAULT '',
    time   REAL DEFAULT 0
);
-- 插件登记簿：插件状态
CREATE TABLE IF NOT EXISTS plugin_registry (
    id             TEXT PRIMARY KEY,
    name           TEXT DEFAULT '',
    version        TEXT DEFAULT '0.0.0',
    status         TEXT DEFAULT '',
    installed_at   TEXT,
    uninstalled_at TEXT,
    updated_at     TEXT
);
-- 插件登记簿：安装 / 卸载历史
CREATE TABLE IF NOT EXISTS plugin_history (
    seq     INTEGER PRIMARY KEY AUTOINCREMENT,
    action  TEXT DEFAULT '',
    id      TEXT DEFAULT '',
    name    TEXT DEFAULT '',
    version TEXT DEFAULT '0.0.0',
    at      TEXT DEFAULT ''
);
-- 收藏夹（一行一个收藏；seq 决定展示顺序，越小越靠前）
CREATE TABLE IF NOT EXISTS favorites (
    seq        INTEGER PRIMARY KEY,
    path       TEXT NOT NULL,
    name       TEXT DEFAULT '',
    added      INTEGER DEFAULT 0,
    group_name TEXT DEFAULT ''
);
-- 收藏分组顺序（一行一个分组）
CREATE TABLE IF NOT EXISTS fav_groups (
    seq  INTEGER PRIMARY KEY,
    name TEXT NOT NULL
);
-- 最近打开的目录（一行一个目录；seq 越小越新）
CREATE TABLE IF NOT EXISTS recent_folders (
    seq       INTEGER PRIMARY KEY,
    path      TEXT NOT NULL,
    opened_at REAL DEFAULT 0
);
-- 运行任务注册表（一行一个任务）
CREATE TABLE IF NOT EXISTS runner_tasks (
    seq    INTEGER PRIMARY KEY,
    id     TEXT NOT NULL,
    record TEXT DEFAULT '{}'
);
-- 通知历史
CREATE TABLE IF NOT EXISTS notify_history (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id  TEXT,
    ts  INTEGER DEFAULT 0,
    rec TEXT DEFAULT '{}'
);
-- 运行环境自定义配置（一行一项：kind=overrides 解释器路径 / kind=env 环境变量）
CREATE TABLE IF NOT EXISTS env_cfg (
    kind  TEXT NOT NULL,
    name  TEXT NOT NULL,
    value TEXT DEFAULT '',
    PRIMARY KEY (kind, name)
);
-- Git 认证信息（一行一个字段：type / token）
CREATE TABLE IF NOT EXISTS git_creds (
    name  TEXT PRIMARY KEY,
    value TEXT DEFAULT ''
);
-- AI 接口（一行一个接口）
CREATE TABLE IF NOT EXISTS ai_providers (
    seq      INTEGER PRIMARY KEY,
    id       TEXT NOT NULL,
    name     TEXT DEFAULT '',
    base_url TEXT DEFAULT '',
    api_key  TEXT DEFAULT ''
);
-- AI 接口的模型列表（一行一个模型）
CREATE TABLE IF NOT EXISTS ai_models (
    seq         INTEGER PRIMARY KEY,
    provider_id TEXT NOT NULL,
    name        TEXT NOT NULL
);
-- AI 当前激活的接口 / 模型（单行）
CREATE TABLE IF NOT EXISTS ai_active (
    id       INTEGER PRIMARY KEY CHECK (id = 1),
    provider TEXT DEFAULT '',
    model    TEXT DEFAULT ''
);
-- 通知配置（一行一个配置项；key 为点号路径，如 smtp.host、channels.desktop）
CREATE TABLE IF NOT EXISTS notify_cfg (
    key   TEXT PRIMARY KEY,
    value TEXT DEFAULT ''
);
-- 命令安全设置（设置 → 命令安全）：单行 JSON，存总开关 / 分组开关 / 自定义正则
CREATE TABLE IF NOT EXISTS cmd_guard (
    key   TEXT PRIMARY KEY,
    value TEXT DEFAULT ''
);
-- 分享记录（原独立库 data/storage/shares.db）
CREATE TABLE IF NOT EXISTS shares (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    token         TEXT UNIQUE NOT NULL,
    abs_path      TEXT NOT NULL,
    name          TEXT NOT NULL,
    size          INTEGER DEFAULT 0,
    is_dir        INTEGER DEFAULT 0,
    password_hash TEXT DEFAULT '',
    expires_at    INTEGER DEFAULT 0,
    max_views     INTEGER DEFAULT 0,
    views         INTEGER DEFAULT 0,
    created_at    INTEGER DEFAULT 0,
    last_view_at  INTEGER DEFAULT 0,
    revoked       INTEGER DEFAULT 0,
    note          TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_shares_path ON shares(abs_path);
CREATE INDEX IF NOT EXISTS idx_shares_token ON shares(token);

-- 系统 AI 调用统计（设置 → 系统 AI 的模块清单显示次数）：按模块累计，一行一个模块
CREATE TABLE IF NOT EXISTS ai_usage (
    module     TEXT PRIMARY KEY,
    ok         INTEGER NOT NULL DEFAULT 0,
    fail       INTEGER NOT NULL DEFAULT 0,
    last_at    TEXT DEFAULT '',
    last_ms    INTEGER DEFAULT 0,
    last_error TEXT DEFAULT '',
    tokens_in  INTEGER NOT NULL DEFAULT 0,
    tokens_out INTEGER NOT NULL DEFAULT 0
);

-- 系统 AI 调用明细（最近的每一次调用一行，用于「按天」维度与调用记录查看）
-- model / tokens_* 记录本次实际使用的模型与用量（上游没返回 usage 时为 0）
CREATE TABLE IF NOT EXISTS ai_calls (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    module     TEXT NOT NULL,
    ok         INTEGER NOT NULL DEFAULT 1,
    ms         INTEGER DEFAULT 0,
    ts         TEXT NOT NULL DEFAULT '',
    day        TEXT NOT NULL DEFAULT '',
    error      TEXT DEFAULT '',
    model      TEXT DEFAULT '',
    tokens_in  INTEGER DEFAULT 0,
    tokens_out INTEGER DEFAULT 0,
    est        INTEGER DEFAULT 0,      -- 1 = 上游没返回 usage，用量是按字数估算的
    req        TEXT DEFAULT '',        -- 本次请求摘要（提问 / 参数，截断存）
    resp       TEXT DEFAULT ''         -- 本次响应摘要（回复 / 结果，截断存）
);
CREATE INDEX IF NOT EXISTS idx_ai_calls_mod ON ai_calls(module, id);
CREATE INDEX IF NOT EXISTS idx_ai_calls_day ON ai_calls(module, day);

-- AI 对话历史（原独立库 data/.file_manager_ai_chat.db，表结构保持一致以便直接搬运）
-- root：对话所属的项目根目录（IDE 的 ROOT）。空串 = 还没绑定项目（旧数据），
-- 首次进入某个项目时由 chatdb.adopt_unassigned() 一次性划归该项目，
-- 这样「打开另一个项目」看到的是各自独立的对话列表。
CREATE TABLE IF NOT EXISTS ai_conversations (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    title      TEXT DEFAULT '',
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL,
    extra      TEXT DEFAULT '',
    root       TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS ai_messages (
    conv_id   TEXT NOT NULL,
    mid       TEXT NOT NULL,
    user_id   TEXT NOT NULL,
    role      TEXT NOT NULL,
    text      TEXT DEFAULT '',
    images    TEXT DEFAULT '',
    reasoning TEXT DEFAULT '',
    meta      TEXT DEFAULT '',
    seq       INTEGER NOT NULL,
    created_at REAL NOT NULL,
    PRIMARY KEY (conv_id, mid)
);
CREATE INDEX IF NOT EXISTS idx_ai_conv_user ON ai_conversations(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_msg_user ON ai_messages(user_id, conv_id, seq);
-- cur_conv：旧版单值（兼容未绑定项目的场景）；cur_roots：{项目根目录: 当前会话 id}
CREATE TABLE IF NOT EXISTS ai_prefs (
    user_id   TEXT PRIMARY KEY,
    cur_conv  TEXT DEFAULT '',
    cur_roots TEXT DEFAULT '{}'
);

-- AI 文件改动快照（原独立库 data/.file_manager_ai_undo.db）
CREATE TABLE IF NOT EXISTS ai_undo_snapshots (
    cid        TEXT PRIMARY KEY,
    path       TEXT NOT NULL,
    kind       TEXT NOT NULL,
    before     BLOB,
    after      BLOB,
    action     TEXT DEFAULT '',
    diff       TEXT DEFAULT '',
    truncated  INTEGER DEFAULT 0,
    rel        TEXT DEFAULT '',
    data_len   INTEGER DEFAULT 0,
    created_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_undo_created ON ai_undo_snapshots(created_at);

-- 数据库连接工具：连接配置（密码用 services/common/secret.py 加密后落库）
CREATE TABLE IF NOT EXISTS db_conns (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL DEFAULT '',
    kind       TEXT NOT NULL DEFAULT 'sqlite',   -- sqlite / mysql / postgres
    host       TEXT DEFAULT '',
    port       INTEGER DEFAULT 0,
    username   TEXT DEFAULT '',
    password   TEXT DEFAULT '',                  -- enc:v1: 密文
    dbname     TEXT DEFAULT '',                  -- 库名；sqlite 时是数据库文件路径
    params     TEXT DEFAULT '',                  -- 额外连接参数
    created_at REAL NOT NULL DEFAULT 0,
    updated_at REAL NOT NULL DEFAULT 0
);

-- 数据库连接工具：写操作日志（新增 / 修改 / 删除 / 清空，前三种可回撤）
-- before_json：回撤要用的旧数据（修改=旧值、删除=整行）；after_json：新增时记下新行主键（回撤=删掉它）
CREATE TABLE IF NOT EXISTS db_write_log (
    id          TEXT PRIMARY KEY,
    conn_id     TEXT NOT NULL,
    kind        TEXT NOT NULL DEFAULT '',
    dbname      TEXT DEFAULT '',
    tbl_schema  TEXT DEFAULT '',
    tbl         TEXT DEFAULT '',
    op          TEXT NOT NULL,                   -- insert / update / delete / truncate
    summary     TEXT DEFAULT '',
    before_json TEXT DEFAULT '',
    after_json  TEXT DEFAULT '',
    undoable    INTEGER NOT NULL DEFAULT 1,
    undone      INTEGER NOT NULL DEFAULT 0,
    created_at  REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dbwrite_created ON db_write_log(created_at);

-- 定时任务（参考青龙面板）：一行一个任务
CREATE TABLE IF NOT EXISTS cron_tasks (
    id          TEXT PRIMARY KEY,
    name        TEXT DEFAULT '',
    cron        TEXT DEFAULT '',
    command     TEXT DEFAULT '',
    cwd         TEXT DEFAULT '',
    enabled     INTEGER NOT NULL DEFAULT 1,
    remark      TEXT DEFAULT '',
    timeout     INTEGER NOT NULL DEFAULT 0,      -- 0 = 不限时
    created_at  REAL NOT NULL DEFAULT 0,
    updated_at  REAL NOT NULL DEFAULT 0,
    last_at     REAL NOT NULL DEFAULT 0,
    last_status TEXT DEFAULT '',
    last_ms     INTEGER DEFAULT 0,
    last_exit   INTEGER,
    run_count   INTEGER NOT NULL DEFAULT 0,
    ok_count    INTEGER NOT NULL DEFAULT 0,
    fail_count  INTEGER NOT NULL DEFAULT 0
);
-- 定时任务的执行历史（每个任务保留最近若干条，历史日志文件随之清理）
CREATE TABLE IF NOT EXISTS cron_runs (
    id         TEXT PRIMARY KEY,
    task_id    TEXT NOT NULL,
    task_name  TEXT DEFAULT '',
    trigger    TEXT DEFAULT 'cron',              -- cron / manual
    status     TEXT DEFAULT 'running',           -- running / success / fail / killed / timeout
    exit_code  INTEGER,
    started_at REAL NOT NULL DEFAULT 0,
    ended_at   REAL NOT NULL DEFAULT 0,
    duration   INTEGER DEFAULT 0,
    log_path   TEXT DEFAULT '',
    log_size   INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_cron_runs_task ON cron_runs(task_id, started_at DESC);
"""


def store_conn():
    """打开 store.db 连接（调用方负责关闭）。WAL 下读不阻塞写。"""
    conn = sqlite3.connect(_STORE_DB_FILE, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    return conn


@contextlib.contextmanager
def store_tx():
    """写事务：加锁 + 打开连接 + 自动 commit/rollback + 关闭。"""
    with _lock:
        conn = store_conn()
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()


def init_store_db():
    """幂等建表（模块导入时执行一次）。"""
    with _lock:
        conn = store_conn()
        try:
            conn.executescript(_SCHEMA)
            _migrate_ai_columns(conn)          # 老库补上后加的 tokens / model 列
            conn.commit()
        finally:
            conn.close()


def _migrate_ai_columns(conn):
    """老库补列：ai_calls.model / tokens_in / tokens_out、ai_usage.tokens_in / tokens_out，
    以及「对话按项目隔离」用的 ai_conversations.root / ai_prefs.cur_roots。

    CREATE TABLE IF NOT EXISTS 对已存在的表不会补列，所以这里手工加；
    SQLite 的 ADD COLUMN 没有 IF NOT EXISTS，先查 PRAGMA，缺了才加（故可反复执行）。
    """
    for table, col, decl in (
        ("ai_calls", "model", "TEXT DEFAULT ''"),
        ("ai_calls", "tokens_in", "INTEGER DEFAULT 0"),
        ("ai_calls", "tokens_out", "INTEGER DEFAULT 0"),
        ("ai_calls", "est", "INTEGER DEFAULT 0"),
        ("ai_calls", "req", "TEXT DEFAULT ''"),
        ("ai_calls", "resp", "TEXT DEFAULT ''"),
        ("ai_usage", "tokens_in", "INTEGER DEFAULT 0"),
        ("ai_usage", "tokens_out", "INTEGER DEFAULT 0"),
        ("ai_conversations", "root", "TEXT DEFAULT ''"),
        ("ai_prefs", "cur_roots", "TEXT DEFAULT '{}'"),
    ):
        try:
            cols = {r["name"] for r in conn.execute("PRAGMA table_info(%s)" % table)}
            if cols and col not in cols:
                conn.execute("ALTER TABLE %s ADD COLUMN %s %s" % (table, col, decl))
        except Exception as e:
            _log.warning("给 %s 补列 %s 失败：%s", table, col, e)

    # 按项目查会话用的索引：必须等上面的 root 列补完才能建
    # （老库先跑 _SCHEMA 时还没有 root 列，索引写在 _SCHEMA 里会直接报错）
    try:
        conn.execute("CREATE INDEX IF NOT EXISTS idx_ai_conv_root "
                     "ON ai_conversations(user_id, root, updated_at DESC)")
    except Exception as e:
        _log.warning("创建会话按项目索引失败：%s", e)


# 常驻连接：进程内一直持有（不做实际读写，只在建表后打开一次）。
# 目的：让 SQLite 的 -wal / -shm 这两个内部文件【稳定存在】。
# 否则每次开关连接都会让它们出现 / 消失（WAL 模式下最后一个连接关闭时会
# 自动 checkpoint 并删掉它们），被前端「文件树自动刷新」当成目录内容变化，
# 于是每隔几秒整树重建一次 —— 表现为资源管理器列表不断抖动。
_keepalive_conn = None


def hold_wal_files():
    """建立常驻连接以稳定 -wal / -shm（重复调用无副作用）。"""
    global _keepalive_conn
    if _keepalive_conn is not None:
        return
    try:
        conn = store_conn()
        conn.execute("SELECT 1").fetchone()
        _keepalive_conn = conn
    except Exception:
        _keepalive_conn = None



def get_meta(key, default=None):
    with _lock:
        conn = store_conn()
        try:
            row = conn.execute("SELECT value FROM store_meta WHERE key=?", (key,)).fetchone()
            return row["value"] if row else default
        finally:
            conn.close()


def set_meta(key, value):
    with store_tx() as conn:
        conn.execute("INSERT OR REPLACE INTO store_meta (key, value) VALUES (?, ?)",
                     (key, str(value)))


def kv_get(key, default=None):
    """读取旧 kv_store 中的某个键（仅供一次性迁移用；表已删除时返回 default）。"""
    try:
        with _lock:
            conn = store_conn()
            try:
                row = conn.execute("SELECT value FROM kv_store WHERE key=?", (key,)).fetchone()
            finally:
                conn.close()
    except sqlite3.Error:
        return default
    if row is None:
        return default
    try:
        return json.loads(row["value"])
    except (TypeError, ValueError):
        return default


def kv_delete(key):
    """删除旧 kv_store 中的某个键（表已删除时静默忽略）。"""
    try:
        with store_tx() as conn:
            conn.execute("DELETE FROM kv_store WHERE key=?", (key,))
    except sqlite3.Error:
        pass


def flatten_cfg(obj, prefix="", out=None):
    """把嵌套配置展平成 {点号路径: JSON 标量文本}，供「一行一条」存表。"""
    if out is None:
        out = {}
    if isinstance(obj, dict):
        for k, v in obj.items():
            flatten_cfg(v, (prefix + "." + str(k)) if prefix else str(k), out)
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            flatten_cfg(v, (prefix + "." + str(i)) if prefix else str(i), out)
    else:
        out[prefix] = json.dumps(obj, ensure_ascii=False)
    return out


def unflatten_cfg(rows):
    """把 {点号路径: 文本} 还原成嵌套结构（纯数字 key 的层级还原为数组）。"""
    root = {}
    for path, raw in (rows or {}).items():
        try:
            val = json.loads(raw)
        except (TypeError, ValueError):
            val = raw
        segs = str(path).split(".")
        cur = root
        for s in segs[:-1]:
            nxt = cur.get(s)
            if not isinstance(nxt, dict):
                nxt = {}
                cur[s] = nxt
            cur = nxt
        cur[segs[-1]] = val
    return _dict_to_lists(root)


def _dict_to_lists(node):
    if isinstance(node, dict):
        conv = {k: _dict_to_lists(v) for k, v in node.items()}
        if conv and all(str(k).isdigit() for k in conv):
            return [conv[k] for k in sorted(conv, key=lambda x: int(x))]
        return conv
    return node


def finalize_kv_migration():
    """迁移收尾：kv_store 已无数据时删掉这张表（重复调用 / 表不存在都安全）。"""
    try:
        with store_tx() as conn:
            n = conn.execute("SELECT COUNT(*) FROM kv_store").fetchone()[0]
            if n == 0:
                conn.execute("DROP TABLE kv_store")
    except sqlite3.Error:
        pass


def migrate_legacy_list(marker, kv_key, json_path, saver):
    """把「列表型」旧存储一次性导入对应的新表（导入后删掉 kv 里的旧键）。

    迁移源优先取旧 JSON 文件，其次取上一版曾写进 kv_store 的旧键；
    标记写进 store_meta，只执行一次；导入异常则不标记，下次启动重试。
    """
    if get_meta(marker):
        return
    data = read_json(json_path)
    if not isinstance(data, list):
        data = kv_get(kv_key, None)
    if isinstance(data, list) and data:
        try:
            saver(data)
        except Exception as e:
            _log.warning("迁移 %s 失败：%s", marker, e)
            return
    kv_delete(kv_key)
    set_meta(marker, "1")
    finalize_kv_migration()


def migrate_legacy_dict(marker, kv_key, json_path, saver):
    """同 migrate_legacy_list，但迁移源是「对象型」配置。"""
    if get_meta(marker):
        return
    data = read_json(json_path)
    if not isinstance(data, dict):
        data = kv_get(kv_key, None)
    if isinstance(data, dict) and data:
        try:
            saver(data)
        except Exception as e:
            _log.warning("迁移 %s 失败：%s", marker, e)
            return
    kv_delete(kv_key)
    set_meta(marker, "1")
    finalize_kv_migration()


def read_json(path):
    """读取旧 JSON（不存在 / 解析失败返回 None）。"""
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def migrate_json_once(marker, json_path, handler):
    """把旧 JSON 一次性导入对应表。

    marker 未标记且 json_path 存在时，调用 handler(conn, data) 落库，
    成功后写标记；导入异常不写标记，下次启动重试。
    """
    if get_meta(marker):
        return
    data = read_json(json_path)
    if data is None:
        return                       # 文件不存在 / 解析失败：不标记，下次再看
    try:
        with store_tx() as conn:
            handler(conn, data)
            conn.execute("INSERT OR REPLACE INTO store_meta (key, value) VALUES (?, '1')",
                         (marker,))
        _log.info("已迁移旧 JSON 到 store.db：%s", marker)
    except Exception as e:            # 迁移失败不能影响启动
        _log.warning("迁移 %s 失败：%s", marker, e)


def migrate_sqlite_once(marker, db_path, tables, delete_after=True):
    """把旧的独立 SQLite 库里的表一次性并入 store.db。

    两边表结构一致，用 ATTACH + INSERT OR IGNORE 搬运（重复执行也不会产生重复数据），
    成功后写标记；delete_after=True 时连同 -wal/-shm 一起删掉旧库文件。
    """
    if get_meta(marker):
        return
    if not db_path or not os.path.isfile(db_path):
        return
    try:
        with _lock:
            conn = store_conn()
            try:
                conn.execute("ATTACH DATABASE ? AS legacy", (db_path,))
                for t in tables:
                    if not conn.execute("SELECT 1 FROM legacy.sqlite_master "
                                        "WHERE type='table' AND name=?", (t,)).fetchone():
                        continue                       # 旧库里没有这张表：跳过
                    main_cols = [r["name"] for r in conn.execute(f"PRAGMA main.table_info({t})")]
                    old_cols = [r["name"] for r in conn.execute(f"PRAGMA legacy.table_info({t})")]
                    use = [c for c in old_cols if c in main_cols]     # 只搬两边都有的列
                    if not use:
                        continue
                    cols = ", ".join('"' + c + '"' for c in use)
                    conn.execute(f"INSERT OR IGNORE INTO main.{t} ({cols}) "
                                 f"SELECT {cols} FROM legacy.{t}")
                conn.execute("INSERT OR REPLACE INTO store_meta (key, value) VALUES (?, '1')", (marker,))
                conn.commit()
            finally:
                conn.close()                       # 关闭连接即自动 DETACH
        _log.info("已迁移旧数据库到 store.db：%s（%s）", marker, "、".join(tables))
        if delete_after:
            for p in (db_path, db_path + "-wal", db_path + "-shm"):
                try:
                    if os.path.isfile(p):
                        os.remove(p)
                except OSError as e:
                    _log.warning("删除旧库文件失败 %s：%s", p, e)
    except Exception as e:            # 迁移失败不能影响启动
        _log.warning("迁移 %s 失败：%s", marker, e)


init_store_db()
hold_wal_files()
# 旧独立库一次性并入（表结构与本库一致，ATTACH + INSERT OR IGNORE 搬运，成功后删掉旧文件）
migrate_sqlite_once("table_migrated:ai_chat", AI_CHAT_LEGACY_DB,
                    ["ai_conversations", "ai_messages", "ai_prefs"])
migrate_sqlite_once("table_migrated:ai_undo", AI_UNDO_LEGACY_DB, ["ai_undo_snapshots"])

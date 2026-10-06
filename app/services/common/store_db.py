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
    store_meta       通用键值（含「旧 JSON 是否已导入」标记）

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

from ...config import _STORE_DB_FILE
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
-- 通知历史
CREATE TABLE IF NOT EXISTS notify_history (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id  TEXT,
    ts  INTEGER DEFAULT 0,
    rec TEXT DEFAULT '{}'
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
            conn.commit()
        finally:
            conn.close()


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


init_store_db()

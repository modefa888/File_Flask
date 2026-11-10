"""索引 SQLite 数据库连接层。"""
import os
import sqlite3
import threading

from ...config import _INDEX_DB_FILE


_INDEX_SCHEMA = """
    CREATE TABLE IF NOT EXISTS index_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        abs_path TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        ext TEXT DEFAULT '',
        size INTEGER DEFAULT 0,
        mtime REAL DEFAULT 0,
        is_dir INTEGER DEFAULT 0,
        parent_dir TEXT DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_name ON index_files(name);
    CREATE INDEX IF NOT EXISTS idx_ext ON index_files(ext);
    CREATE INDEX IF NOT EXISTS idx_parent ON index_files(parent_dir);
    CREATE TABLE IF NOT EXISTS index_meta (
        key TEXT PRIMARY KEY,
        value TEXT
    );
"""

# 索引库「代次」：清空或重建成功后递增，让线程本地缓存的旧连接自动失效重开
_INDEX_DB_GENERATION = 0
_INDEX_GEN_LOCK = threading.Lock()


def _index_db_exists():
    """磁盘上是否存在主索引库（清空后为 False）。"""
    return os.path.exists(_INDEX_DB_FILE)


def _index_db_generation():
    return _INDEX_DB_GENERATION


def _bump_index_db_generation():
    global _INDEX_DB_GENERATION
    with _INDEX_GEN_LOCK:
        _INDEX_DB_GENERATION += 1
        return _INDEX_DB_GENERATION


def _open_empty_index_conn():
    """索引库被清空时返回内存空库。

    sqlite3.connect(路径) 会在文件不存在时隐式创建一个空 db，因此清空后必须拦截：
    内存空库让所有读接口照常返回空结果，且绝不在磁盘上重新生成 .db；
    只有用户手动「重建索引」生成临时库并原子替换后主库文件才会重新出现。
    """
    conn = sqlite3.connect(":memory:", timeout=30)
    conn.execute("PRAGMA case_sensitive_like=ON")
    conn.executescript(_INDEX_SCHEMA)
    return conn





def _get_index_conn(db_path=None):
    """打开索引 DB 连接。只读文件系统自动降级到 immutable 模式。

    主库文件不存在（已清空 / 尚未创建）时返回内存空库：sqlite3.connect(路径) 会
    隐式创建空文件，这里必须拦截，否则清空后随便一次查询就会把索引库又建回来。
    显式传入 db_path（重建用的 .new 临时库）时照常创建磁盘文件。
    """
    path = db_path or _INDEX_DB_FILE
    if db_path is None and not _index_db_exists():
        return _open_empty_index_conn()
    try:
        conn = sqlite3.connect(path, timeout=30)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        # 大小写敏感的 LIKE 才能让 abs_path LIKE '前缀%' 走索引（默认 OFF 时是全表扫描，
        # 百万行索引库单次查询可达数秒，目录列表会被拖到超时）
        conn.execute("PRAGMA case_sensitive_like=ON")
        return conn
    except sqlite3.OperationalError:
        # 只读文件系统：用 immutable 模式只读打开
        try:
            conn = sqlite3.connect(f"file:{path}?mode=ro&immutable=1", uri=True, timeout=30)
            conn.execute("PRAGMA case_sensitive_like=ON")
            return conn
        except sqlite3.OperationalError:
            raise


def _init_index_db(db_path=None):
    # 主库已被清空时这里只会初始化一个内存空库，不会在磁盘重建任何 db 文件
    conn = _get_index_conn(db_path)
    try:
        conn.executescript(_INDEX_SCHEMA)
        conn.commit()
    finally:
        conn.close()


def _index_has_data(db_path=None):
    """检查索引 DB 是否已有数据"""
    try:
        conn = _get_index_conn(db_path)
        try:
            row = conn.execute("SELECT COUNT(*) FROM index_files WHERE is_dir=0").fetchone()
            return row and row[0] > 0
        finally:
            conn.close()
    except Exception:
        return False

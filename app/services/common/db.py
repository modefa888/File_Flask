"""索引 SQLite 数据库连接层。"""
import os
import sqlite3

from ...config import _INDEX_DB_FILE





def _get_index_conn(db_path=None):
    """打开索引 DB 连接。只读文件系统自动降级到 immutable 模式。"""
    path = db_path or _INDEX_DB_FILE
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
    conn = _get_index_conn(db_path)
    try:
        conn.executescript("""
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
        """)
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

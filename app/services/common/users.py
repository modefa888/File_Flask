"""本地用户账号存储：注册 / 校验 / 角色管理（存于统一存储库 store.db 的 users 表）。

设计说明
--------
- 原认证是单账号（config.AUTH_USERNAME / AUTH_PASSWORD），为「邀请共同编辑」等
  多人场景扩展出本地用户表。管理员账号在首次初始化时由 config 凭据播种（role=admin）。
- 注册的新用户 role=member：能登录进入系统（如通过邀请链接参与协作编辑）。
- 密码使用 werkzeug.security 的 PBKDF2 哈希存储，不落明文。
- 兼容性：若管理员凭据来自环境变量且与播种哈希不符（改了 .env），verify_user
  会回退比对 config 明文，保证老用法不被破坏。
"""

import hmac as _hmac
import re
import threading
import time

from werkzeug.security import check_password_hash, generate_password_hash

from ... import config
from ...log import get_logger
from .store_db import store_conn, store_tx

_log = get_logger()

_USERNAME_RE = re.compile(r"^[A-Za-z0-9_\u4e00-\u9fa5]{2,32}$")
_MIN_PASSWORD_LEN = 6

_lock = threading.Lock()
_table_ready = False


def _conn():
    return store_conn()


def _ensure_table():
    """幂等建表。只建表、不做任何会再回到本模块写路径的播种逻辑，
    避免「持锁等待自己」的死锁（此前 _init→播种→create_user→_init 曾死锁）。"""
    global _table_ready
    if _table_ready:
        return
    with _lock:
        if _table_ready:
            return
        conn = _conn()
        try:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS users (
                    username TEXT PRIMARY KEY,
                    pw_hash  TEXT NOT NULL,
                    role     TEXT NOT NULL DEFAULT 'member',
                    created  INTEGER NOT NULL
                )
                """
            )
            conn.commit()
        finally:
            conn.close()
        _table_ready = True


def _seed_admin():
    """把 config 里的管理员账号播种进用户表（已存在则跳过）。

    直接写 INSERT，不走 create_user()，因为 create_user 会调用 _ensure_table，
    而调用链 _ensure_table→_seed_admin→create_user→_ensure_table 会自我等待。
    """
    _ensure_table()
    try:
        conn = _conn()
        try:
            row = conn.execute(
                "SELECT 1 FROM users WHERE username = ?", (config.AUTH_USERNAME,)
            ).fetchone()
        finally:
            conn.close()
        if row is None:
            with store_tx() as c:
                c.execute(
                    "INSERT OR IGNORE INTO users (username, pw_hash, role, created)"
                    " VALUES (?, ?, 'admin', ?)",
                    (config.AUTH_USERNAME,
                     generate_password_hash(config.AUTH_PASSWORD), int(time.time())),
                )
            _log.info("已从配置播种管理员账号: %s", config.AUTH_USERNAME)
    except Exception as e:
        _log.warning("播种管理员账号失败（不影响启动）: %s", e)


# 模块导入时完成建表 + 播种（两者都幂等且异常不外抛）
_seed_admin()


def user_exists(username: str) -> bool:
    _ensure_table()
    conn = _conn()
    try:
        return conn.execute(
            "SELECT 1 FROM users WHERE username = ?", (username,)
        ).fetchone() is not None
    finally:
        conn.close()


def create_user(username: str, password: str, role: str = "member"):
    """注册新用户。成功返回 None；参数不合法返回错误信息字符串。"""
    username = (username or "").strip()
    if not _USERNAME_RE.match(username):
        return "用户名需为 2-32 位中文、字母、数字或下划线"
    if len(password or "") < _MIN_PASSWORD_LEN:
        return f"密码至少 {_MIN_PASSWORD_LEN} 位"
    if role not in ("admin", "member"):
        return "角色不合法"
    _ensure_table()
    with store_tx() as conn:
        if conn.execute(
            "SELECT 1 FROM users WHERE username = ?", (username,)
        ).fetchone():
            return "该用户名已被注册"
        conn.execute(
            "INSERT INTO users (username, pw_hash, role, created) VALUES (?, ?, ?, ?)",
            (username, generate_password_hash(password), role, int(time.time())),
        )
    _log.info("注册新用户: %s (role=%s)", username, role)
    return None


def verify_user(username: str, password: str):
    """校验用户名密码。成功返回 {"username", "role"}；失败返回 None。

    管理员账号额外回退比对 config 明文凭据：环境变量改过密码而
    用户表里还是旧哈希时，仍可正常登录（以 config 为准兜底）。
    """
    _ensure_table()
    username = (username or "").strip()
    conn = _conn()
    try:
        row = conn.execute(
            "SELECT pw_hash, role FROM users WHERE username = ?", (username,)
        ).fetchone()
    finally:
        conn.close()
    if row is not None:
        try:
            if check_password_hash(row["pw_hash"], password or ""):
                return {"username": username, "role": row["role"]}
        except Exception:
            pass
        if username == config.AUTH_USERNAME and _config_pw_ok(password):
            return {"username": username, "role": "admin"}
        return None
    # 用户表里查无此人：仍允许 config 管理员兜底（例如播种失败的场景）
    if username == config.AUTH_USERNAME and _config_pw_ok(password):
        return {"username": username, "role": "admin"}
    return None


def _config_pw_ok(password: str) -> bool:
    """与 config 管理员明文密码做防时序比较。"""
    return _hmac.compare_digest(password or "", config.AUTH_PASSWORD)


def count_users() -> int:
    _ensure_table()
    conn = _conn()
    try:
        return conn.execute("SELECT COUNT(*) AS n FROM users").fetchone()["n"]
    finally:
        conn.close()

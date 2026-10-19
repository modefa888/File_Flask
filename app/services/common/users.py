"""本地用户账号存储：注册 / 校验 / 角色管理（存于统一存储库 store.db 的 users 表）。

设计说明
--------
- 原认证是单账号（config.AUTH_USERNAME / AUTH_PASSWORD），为「邀请共同编辑」等
  多人场景扩展出本地用户表。管理员账号在首次初始化时由 config 凭据播种（role=admin）。
- 注册的新用户 role=member：能登录进入系统（如通过邀请链接参与协作编辑）。
- 密码使用 werkzeug.security 的 PBKDF2 哈希存储，不落明文。
- 登录只认用户表里的哈希：.env 的 AUTH_PASSWORD 仅在首次播种时生效一次，
  改密 / 后台重置后以系统内密码为准（否则旧初始密码仍能登录，强制改密失去意义）。
- 兜底：用户表查无此人（播种失败）时，才回退比对 config 明文凭据。
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
                    created  INTEGER NOT NULL,
                    banned   INTEGER NOT NULL DEFAULT 0,
                    must_change INTEGER NOT NULL DEFAULT 0,
                    pw_ver   INTEGER NOT NULL DEFAULT 0
                )
                """
            )
            # 老库补列：CREATE TABLE IF NOT EXISTS 不会给已存在的表加列
            cols = {r["name"] for r in conn.execute("PRAGMA table_info(users)")}
            for col, decl in (
                ("banned", "INTEGER NOT NULL DEFAULT 0"),
                # must_change：1 = 首次登录后必须先修改密码才能进入（默认管理员播种时为 1）
                ("must_change", "INTEGER NOT NULL DEFAULT 0"),
                # pw_ver：密码版本号，每次改密 / 重置 +1；登录会话记录版本，密码变更后旧会话全部失效
                ("pw_ver", "INTEGER NOT NULL DEFAULT 0"),
            ):
                if col in cols:
                    continue
                try:
                    conn.execute(f"ALTER TABLE users ADD COLUMN {col} {decl}")
                except Exception as e:
                    _log.warning("给 users 补 %s 列失败：%s", col, e)
            conn.commit()
        finally:
            conn.close()
        _table_ready = True


def _seed_admin():
    """把 config 里的管理员账号播种进用户表，并标记「初始密码待修改」。

    直接写 SQL，不走 create_user()，因为 create_user 会调用 _ensure_table，
    而调用链 _ensure_table→_seed_admin→create_user→_ensure_table 会自我等待。

    两种情况都会打上 must_change=1（首次登录后必须先改密码才能进入）：
      1. 全新库：账号由 config 凭据播种，密码就是初始密码；
      2. 已有库：账号存在但密码仍等于 config 里的初始密码（尚未改过），
         老库升级后同样按「首次运行」处理；改过密码的不受影响。
    """
    _ensure_table()
    try:
        conn = _conn()
        try:
            row = conn.execute(
                "SELECT pw_hash, must_change FROM users WHERE username = ?",
                (config.AUTH_USERNAME,)
            ).fetchone()
        finally:
            conn.close()
        if row is None:
            with store_tx() as c:
                # must_change=1：初始密码（无论来自 config 还是播种）必须先改一次，
                # 避免项目首次运行后一直使用默认口令对外提供服务。
                c.execute(
                    "INSERT OR IGNORE INTO users (username, pw_hash, role, created, must_change)"
                    " VALUES (?, ?, 'admin', ?, 1)",
                    (config.AUTH_USERNAME,
                     generate_password_hash(config.AUTH_PASSWORD), int(time.time())),
                )
            _log.info("已从配置播种管理员账号: %s", config.AUTH_USERNAME)
            return
        if int(row["must_change"] if "must_change" in row.keys() else 0):
            return                                   # 已标记，不重复写
        try:
            still_initial = check_password_hash(row["pw_hash"], config.AUTH_PASSWORD)
        except Exception:
            still_initial = False
        if still_initial:
            with store_tx() as c:
                c.execute("UPDATE users SET must_change = 1 WHERE username = ?",
                          (config.AUTH_USERNAME,))
            _log.info("管理员仍在使用初始密码，已标记登录后必须先修改: %s", config.AUTH_USERNAME)
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

    账号存在时【只认数据库里的密码哈希】，不再回退比对 config 明文凭据——
    否则改过密码后，旧的初始密码（.env 里的 AUTH_PASSWORD）仍能登录，
    「首次登录强制改密」就形同虚设。改密 / 后台重置后以系统内密码为准；
    .env 里的 AUTH_PASSWORD 只在首次播种时生效一次。
    """
    _ensure_table()
    username = (username or "").strip()
    conn = _conn()
    try:
        row = conn.execute(
            "SELECT pw_hash, role, banned, pw_ver FROM users WHERE username = ?", (username,)
        ).fetchone()
    finally:
        conn.close()
    if row is not None:
        # 已封禁账号：即使密码正确也拒绝登录
        if int(row["banned"] or 0):
            _log.warning("已封禁账号尝试登录：%s", username)
            return None
        try:
            if check_password_hash(row["pw_hash"], password or ""):
                ver = row["pw_ver"] if "pw_ver" in row.keys() else 0
                return {"username": username, "role": row["role"], "pw_ver": int(ver or 0)}
        except Exception:
            pass
        return None
    # 用户表里查无此人（如播种失败）：仍允许 config 管理员兜底
    if username == config.AUTH_USERNAME and _config_pw_ok(password):
        return {"username": username, "role": "admin", "pw_ver": 0}
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


def must_change_password(username: str) -> bool:
    """该账号登录后是否必须先修改密码才能进入系统。

    仅初始管理员（首次运行播种的账号）为 True；改过一次密码后即清除标记。
    用户表里查不到记录时（如播种失败、仅靠 config 凭据登录），
    默认管理员同样视为「未改过初始密码」，保证首次运行一定会被拦住。
    """
    username = (username or "").strip()
    if not username:
        return False
    _ensure_table()
    conn = _conn()
    try:
        row = conn.execute(
            "SELECT must_change FROM users WHERE username = ?", (username,)
        ).fetchone()
    finally:
        conn.close()
    if row is None:
        return username == config.AUTH_USERNAME
    return bool(int(row["must_change"] or 0))


def set_password_hash(username: str, password: str):
    """写入新密码哈希，并清除「必须改密」标记。成功返回 None，失败返回错误信息。"""
    username = (username or "").strip()
    if len(password or "") < _MIN_PASSWORD_LEN:
        return f"密码至少 {_MIN_PASSWORD_LEN} 位"
    _ensure_table()
    with store_tx() as conn:
        cur = conn.execute(
            "UPDATE users SET pw_hash = ?, must_change = 0, pw_ver = pw_ver + 1"
            " WHERE username = ?",
            (generate_password_hash(password), username),
        )
        if cur.rowcount == 0:
            return "用户不存在"
    _log.info("更新密码：%s", username)
    return None


def get_password_version(username: str) -> int:
    """账号当前的密码版本号（密码每次变更 +1）。账号不存在返回 -1。

    登录时把版本号写进会话，每个请求校验会话里的版本与库中是否一致——
    改密 / 后台重置后，该账号的旧登录会话自动失效。
    """
    username = (username or "").strip()
    if not username:
        return -1
    _ensure_table()
    conn = _conn()
    try:
        row = conn.execute(
            "SELECT pw_ver FROM users WHERE username = ?", (username,)
        ).fetchone()
    finally:
        conn.close()
    if row is None:
        return -1
    return int(row["pw_ver"] if "pw_ver" in row.keys() else 0)


def change_own_password(username: str, old_password: str, new_password: str):
    """用户自行修改密码：需校验原密码，且新密码不能与原密码相同。

    成功返回 None，失败返回错误信息字符串。
    """
    username = (username or "").strip()
    if not username:
        return "缺少用户名"
    if len(new_password or "") < _MIN_PASSWORD_LEN:
        return f"密码至少 {_MIN_PASSWORD_LEN} 位"
    if not verify_user(username, old_password):
        return "原密码不正确"
    if (new_password or "") == (old_password or ""):
        return "新密码不能与原密码相同"
    # 仅靠 config 凭据登录（用户表无记录）的管理员：改密时顺带落库
    if not user_exists(username):
        if username != config.AUTH_USERNAME:
            return "用户不存在"
        return create_user(username, new_password, "admin")
    return set_password_hash(username, new_password)


def is_banned(username: str) -> bool:
    """账号是否已被封禁（账号不存在返回 False）。"""
    _ensure_table()
    conn = _conn()
    try:
        row = conn.execute(
            "SELECT banned FROM users WHERE username = ?", ((username or "").strip(),)
        ).fetchone()
        return bool(row and int(row["banned"] or 0))
    finally:
        conn.close()


def set_banned(username: str, banned: bool):
    """封禁 / 解封账号。成功返回 None，失败返回错误信息。"""
    username = (username or "").strip()
    if not username:
        return "缺少用户名"
    _ensure_table()
    with store_tx() as conn:
        cur = conn.execute("UPDATE users SET banned = ? WHERE username = ?",
                           (1 if banned else 0, username))
        if cur.rowcount == 0:
            return "用户不存在"
    _log.info("账号封禁状态变更：%s -> %s", username, "已封禁" if banned else "正常")
    return None

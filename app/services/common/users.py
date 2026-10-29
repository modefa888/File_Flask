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
                    pw_ver   INTEGER NOT NULL DEFAULT 0,
                    last_login INTEGER NOT NULL DEFAULT 0,
                    last_api TEXT NOT NULL DEFAULT '',
                    last_api_at INTEGER NOT NULL DEFAULT 0
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
                # last_login：最近一次成功登录的时间戳（0 = 从未登录）
                ("last_login", "INTEGER NOT NULL DEFAULT 0"),
                # last_api / last_api_at：最近一次调用的接口（"GET /api/xxx"）及其时间戳
                ("last_api", "TEXT NOT NULL DEFAULT ''"),
                ("last_api_at", "INTEGER NOT NULL DEFAULT 0"),
                # 单设备登录：sess_sid = 当前唯一有效的会话 ID，sess_at 最近活跃时间，
                # sess_ua 登录设备（User-Agent）。新登录会覆盖，旧设备下次请求即失效。
                ("sess_sid", "TEXT NOT NULL DEFAULT ''"),
                ("sess_at", "INTEGER NOT NULL DEFAULT 0"),
                ("sess_ua", "TEXT NOT NULL DEFAULT ''"),
                ("sess_ip", "TEXT NOT NULL DEFAULT ''"),
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


# ------------------------------------------------------------------ 活跃度（最近登录 / 最近使用接口）
# 后台「用户管理」列表展示用。写失败只打日志、绝不影响业务流程（登录 / 接口调用照常）。
_API_TOUCH_GAP = 60        # 同一账号 + 同一接口，60 秒内只落库一次（避免每个请求都写库）
_api_seen = {}             # username -> (接口, 上次写入时间戳)
_api_seen_lock = threading.Lock()


def touch_login(username: str):
    """记录最近一次成功登录时间（登录 / 注册成功时调用）。"""
    username = (username or "").strip()
    if not username:
        return
    try:
        _ensure_table()
        with store_tx() as conn:
            conn.execute("UPDATE users SET last_login = ? WHERE username = ?",
                         (int(time.time()), username))
    except Exception as e:
        _log.warning("记录最近登录时间失败：%s", e)


# ------------------------------------------------------------------ 单设备登录
# 每个账号在 users 表里只保留一个「当前有效会话 ID」。新设备登录写入新 ID，
# 旧设备的会话 ID 对不上 -> 下次请求即被判定失效、退回登录页。
_SESSION_IDLE = 30 * 60          # 另一处超过 30 分钟没有动静，视为已离线（登录时不再要求确认）
_SESSION_TOUCH_GAP = 60          # 活跃时间落库节流：同一账号 60 秒最多写一次
_sess_touch = {}
_sess_touch_lock = threading.Lock()


def new_session_id() -> str:
    """生成随机的会话 ID（登录时写入 session 与用户表，作为「唯一在线设备」凭据）。"""
    import secrets
    return secrets.token_hex(16)


def get_session_info(username: str):
    """该账号「另一处正在登录」的会话信息；没有 / 已闲置超时返回 None。"""
    username = (username or "").strip()
    if not username:
        return None
    _ensure_table()
    conn = _conn()
    try:
        row = conn.execute(
            "SELECT sess_sid, sess_at, sess_ua, sess_ip FROM users WHERE username = ?", (username,)
        ).fetchone()
    finally:
        conn.close()
    if row is None:
        return None
    sid = row["sess_sid"] if "sess_sid" in row.keys() else ""
    at = int((row["sess_at"] if "sess_at" in row.keys() else 0) or 0)
    ua = (row["sess_ua"] if "sess_ua" in row.keys() else "") or ""
    ip = (row["sess_ip"] if "sess_ip" in row.keys() else "") or ""
    if not sid:
        return None
    if time.time() - at > _SESSION_IDLE:
        return None
    return {"sid": sid, "at": at, "ua": ua, "ip": ip}


def set_session(username: str, sid: str, ua: str = "", ip: str = ""):
    """登记该账号当前唯一有效的会话（登录成功 / 抢占登录时调用）。"""
    username = (username or "").strip()
    if not username or not sid:
        return
    try:
        _ensure_table()
        with store_tx() as conn:
            conn.execute(
                "UPDATE users SET sess_sid = ?, sess_at = ?, sess_ua = ?, sess_ip = ?"
                " WHERE username = ?",
                (sid, int(time.time()), (ua or "")[:200], (ip or "")[:64], username),
            )
        with _sess_touch_lock:
            _sess_touch[username] = int(time.time())
    except Exception as e:
        _log.warning("登记登录会话失败：%s", e)


def clear_session(username: str, sid: str = ""):
    """登出时清掉会话；带 sid 时只在仍是自己那一份时清（不误伤新设备）。"""
    username = (username or "").strip()
    if not username:
        return
    try:
        _ensure_table()
        with store_tx() as conn:
            if sid:
                conn.execute(
                    "UPDATE users SET sess_sid = '', sess_at = 0, sess_ua = ''"
                    " WHERE username = ? AND sess_sid = ?",
                    (username, sid),
                )
            else:
                conn.execute(
                    "UPDATE users SET sess_sid = '', sess_at = 0, sess_ua = '' WHERE username = ?",
                    (username,),
                )
        with _sess_touch_lock:
            _sess_touch.pop(username, None)
    except Exception as e:
        _log.warning("清除登录会话失败：%s", e)


def check_session(username: str, sid: str) -> bool:
    """会话是否仍为「当前唯一在线」的那一份。

    用户表里没有该账号（仅靠 config 凭据兜底登录）时不做限制，返回 True。
    命中时顺带刷新活跃时间（节流），闲置超时判定才准确。
    """
    username = (username or "").strip()
    if not username or not sid:
        return True
    try:
        _ensure_table()
        conn = _conn()
        try:
            row = conn.execute(
                "SELECT sess_sid FROM users WHERE username = ?", (username,)
            ).fetchone()
        finally:
            conn.close()
        if row is None:
            return True
        cur = (row["sess_sid"] if "sess_sid" in row.keys() else "") or ""
        if not cur:
            return True                      # 库里没登记（升级前的老会话）：放行
        if cur != sid:
            return False                     # 已被别处登录顶掉
        now = int(time.time())
        with _sess_touch_lock:
            last = _sess_touch.get(username, 0)
            if now - last < _SESSION_TOUCH_GAP:
                return True
            _sess_touch[username] = now
        with store_tx() as conn:
            conn.execute("UPDATE users SET sess_at = ? WHERE username = ? AND sess_sid = ?",
                         (now, username, sid))
        return True
    except Exception as e:
        _log.warning("校验登录会话失败（按通过处理）：%s", e)
        return True


def get_user(username: str):
    """按用户名取账号信息（不校验密码）；不存在返回 None。"""
    username = (username or "").strip()
    if not username:
        return None
    _ensure_table()
    conn = _conn()
    try:
        row = conn.execute(
            "SELECT username, role, banned, pw_ver FROM users WHERE username = ?", (username,)
        ).fetchone()
    finally:
        conn.close()
    if row is None:
        return None
    return {
        "username": row["username"],
        "role": row["role"],
        "banned": bool(int(row["banned"] or 0)),
        "pw_ver": int((row["pw_ver"] if "pw_ver" in row.keys() else 0) or 0),
    }


def touch_api(username: str, api: str):
    """记录最近一次调用的接口及时间（形如 "GET /api/adm/users"）。

    节流：同一账号 + 同一接口在 _API_TOUCH_GAP 秒内只写一次库；
    一旦换了接口立刻写入，保证列表里的「最后使用接口」是最新的那一个。
    """
    username = (username or "").strip()
    api = (api or "").strip()
    if not username or not api:
        return
    now = int(time.time())
    with _api_seen_lock:
        hit = _api_seen.get(username)
        if hit and hit[0] == api and now - hit[1] < _API_TOUCH_GAP:
            return
        _api_seen[username] = (api, now)
    try:
        _ensure_table()
        with store_tx() as conn:
            conn.execute(
                "UPDATE users SET last_api = ?, last_api_at = ? WHERE username = ?",
                (api[:200], now, username))
    except Exception as e:
        _log.warning("记录接口使用情况失败：%s", e)

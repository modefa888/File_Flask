"""后台管理：本地用户账号管理（列表 / 改角色 / 重置密码 / 删除）。

底层仍是统一存储库 store.db 的 users 表（见 services/common/users.py）。
这里只补充「管理端」需要的批量操作，并加上安全约束：
- 默认管理员（config.AUTH_USERNAME）不可降级、不可删除；
- 系统至少保留一个管理员，避免把自己锁在门外。
"""
import time

from ... import config
from ...log import get_logger
from ..common.store_db import store_conn, store_tx
from ..common.users import _ensure_table, create_user

_log = get_logger()

_MIN_PASSWORD_LEN = 6


def summary():
    """用户统计：总数 / 角色分布 / 状态分布 / 近 7 天新增（供后台用户管理页顶部卡片）。"""
    _ensure_table()
    out = {"total": 0, "admins": 0, "members": 0, "normal": 0, "banned": 0, "recent": 0}
    try:
        conn = store_conn()
        try:
            row = conn.execute(
                "SELECT COUNT(*) AS total, "
                "COALESCE(SUM(role='admin'),0) AS admins, "
                "COALESCE(SUM(role='member'),0) AS members, "
                "COALESCE(SUM(banned=0),0) AS normal, "
                "COALESCE(SUM(banned=1),0) AS banned, "
                "COALESCE(SUM(created >= ?),0) AS recent "
                "FROM users",
                (int(time.time()) - 7 * 86400,)).fetchone()
            if row is not None:
                for k in out:
                    out[k] = int(row[k] or 0)
        finally:
            conn.close()
    except Exception as e:
        _log.warning("汇总用户统计失败：%s", e)
    return out


def list_users():
    """返回全部用户，按创建时间升序（含封禁状态）。"""
    _ensure_table()
    conn = store_conn()
    try:
        rows = conn.execute(
            "SELECT username, role, created, banned FROM users ORDER BY created ASC").fetchall()
        return [{"username": r["username"], "role": r["role"],
                 "created": r["created"] or 0,
                 "banned": bool(r["banned"])} for r in rows]
    finally:
        conn.close()


def set_banned(username, banned):
    """封禁 / 解封账号；成功返回 None，失败返回错误信息。

    默认管理员（config.AUTH_USERNAME）不允许封禁，避免把自己锁在门外。
    """
    username = (username or "").strip()
    if username == config.AUTH_USERNAME:
        return "默认管理员账号不可封禁"
    from ..common.users import set_banned as _set_banned
    return _set_banned(username, banned)


def add_user(username, password, role="member"):
    """新建用户；成功返回 (None, 用户信息)，失败返回 (错误信息, None)。"""
    role = role if role in ("admin", "member") else "member"
    err = create_user(username, password, role)
    if err:
        return err, None
    return None, {"username": (username or "").strip(), "role": role}


def set_role(username, role):
    """修改角色；成功返回 None，失败返回错误信息。"""
    username = (username or "").strip()
    if role not in ("admin", "member"):
        return "角色不合法"
    if username == config.AUTH_USERNAME and role != "admin":
        return "默认管理员账号的角色不可降级"
    _ensure_table()
    with store_tx() as conn:
        cur = conn.execute("UPDATE users SET role=? WHERE username=?", (role, username))
        if cur.rowcount == 0:
            return "用户不存在"
    _log.info("后台修改用户角色：%s -> %s", username, role)
    return None


def set_password(username, password):
    """重置密码；成功返回 None，失败返回错误信息。

    走 users.set_password_hash：改密后一并清除「首次登录必须改密」标记，
    避免管理员在后台改过密码后，登录时仍被要求再改一次。
    """
    from ..common.users import set_password_hash
    username = (username or "").strip()
    if len(password or "") < _MIN_PASSWORD_LEN:
        return "密码至少 %d 位" % _MIN_PASSWORD_LEN
    err = set_password_hash(username, password)
    if err:
        return err
    _log.info("后台重置用户密码：%s", username)
    return None


def delete_user(username):
    """删除用户；成功返回 None，失败返回错误信息。"""
    username = (username or "").strip()
    if username == config.AUTH_USERNAME:
        return "默认管理员账号不可删除"
    _ensure_table()
    conn = store_conn()
    try:
        row = conn.execute("SELECT role FROM users WHERE username=?", (username,)).fetchone()
        if row is None:
            return "用户不存在"
        if row["role"] == "admin":
            n = conn.execute("SELECT COUNT(*) AS n FROM users WHERE role='admin'").fetchone()["n"]
            if int(n or 0) <= 1:
                return "至少保留一个管理员账号"
    finally:
        conn.close()
    with store_tx() as conn:
        conn.execute("DELETE FROM users WHERE username=?", (username,))
    _log.info("后台删除用户：%s", username)
    return None

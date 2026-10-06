"""分享记录存储层（SQLite）。

表 shares 位于统一的 store.db，保存短链 token、原文件绝对路径、访问密码哈希、
有效期、最大访问次数、访问量等，供 /api/share 系列与 /share/<token> 使用。

历史迁移（均只执行一次，标记写进 store_meta）：
  - 旧的独立库 data/storage/shares.db  → store.db 的 shares 表；
  - 更早的 .share_links.json           → 同上（shares 表为空时）。
"""
import hashlib
import json
import os
import secrets
import sqlite3
import threading
import time

from ...config import _SHARE_DB_FILE, _STORAGE_DIR
from ...log import get_logger
from .store_db import store_conn, store_tx, get_meta, set_meta

_log = get_logger()
_lock = threading.RLock()

# 有效的分享存活时间预设（秒），0 表示永久
EXPIRE_PRESETS = {
    "1h": 3600,
    "1d": 86400,
    "7d": 7 * 86400,
    "30d": 30 * 86400,
    "forever": 0,
}


def _conn():
    """本模块所有连接都走统一的 store.db（shares 表由 store_db 建好）。"""
    return store_conn()


def _migrate_from_shares_db():
    """把旧的独立 data/storage/shares.db 迁入 store.db（一次性，仅 shares 表为空时复制）。"""
    marker = "db_migrated:shares"
    if get_meta(marker):
        return
    legacy = _SHARE_DB_FILE
    if not os.path.isfile(legacy):
        set_meta(marker, "1")        # 没有旧库：直接标记，省得每次启动都查一遍
        return
    try:
        lconn = sqlite3.connect(legacy, timeout=15)
        lconn.row_factory = sqlite3.Row
        try:
            rows = [dict(r) for r in lconn.execute("SELECT * FROM shares")]
        finally:
            lconn.close()
    except sqlite3.Error as e:
        _log.warning("读取旧 shares.db 失败，稍后重试：%s", e)
        return
    cols = ("token", "abs_path", "name", "size", "is_dir", "password_hash", "expires_at",
            "max_views", "views", "created_at", "last_view_at", "revoked", "note")
    try:
        with store_tx() as conn:
            if not conn.execute("SELECT COUNT(*) FROM shares").fetchone()[0]:
                sql = ("INSERT OR IGNORE INTO shares (" + ",".join(cols) + ") VALUES ("
                       + ",".join(["?"] * len(cols)) + ")")
                for r in rows:
                    conn.execute(sql, tuple(r.get(c) for c in cols))
            conn.execute("INSERT OR REPLACE INTO store_meta (key, value) VALUES (?, '1')",
                         (marker,))
        if rows:
            _log.info("已把旧 shares.db 的 %d 条分享迁入 store.db", len(rows))
    except Exception as e:
        _log.warning("迁移旧 shares.db 失败：%s", e)


def _pw_hash(pw):
    if not pw:
        return ""
    return hashlib.sha256(("nanfang-share::" + str(pw)).encode("utf-8")).hexdigest()


def _row_to_dict(row):
    """对外结构：不带密码哈希，只暴露 has_password"""
    if row is None:
        return None
    d = dict(row)
    d["has_password"] = bool(d.get("password_hash"))
    d.pop("password_hash", None)
    return d


def create_share(abs_path, name, size=0, is_dir=False, password="",
                 expires_at=0, max_views=0, note=""):
    """创建分享；同一路径已有未撤销的分享时，复用 token 并更新设置。"""
    now = int(time.time())
    with _lock:
        conn = _conn()
        try:
            row = conn.execute(
                "SELECT * FROM shares WHERE abs_path=? AND revoked=0 ORDER BY id DESC LIMIT 1",
                (abs_path,)).fetchone()
            if row:
                conn.execute(
                    """UPDATE shares SET password_hash=?, expires_at=?, max_views=?,
                       note=?, name=?, size=?, is_dir=? WHERE id=?""",
                    (_pw_hash(password), int(expires_at or 0), int(max_views or 0),
                     note or "", name, int(size or 0), 1 if is_dir else 0, row["id"]))
                conn.commit()
                return _row_to_dict(conn.execute(
                    "SELECT * FROM shares WHERE id=?", (row["id"],)).fetchone())

            token = secrets.token_urlsafe(9)
            while conn.execute("SELECT 1 FROM shares WHERE token=?", (token,)).fetchone():
                token = secrets.token_urlsafe(9)
            cur = conn.execute(
                """INSERT INTO shares (token, abs_path, name, size, is_dir, password_hash,
                   expires_at, max_views, views, created_at, last_view_at, revoked, note)
                   VALUES (?,?,?,?,?,?,?,?,0,?,0,0,?)""",
                (token, abs_path, name, int(size or 0), 1 if is_dir else 0, _pw_hash(password),
                 int(expires_at or 0), int(max_views or 0), now, note or ""))
            conn.commit()
            _log.info("创建分享: %s -> %s", token, name)
            return _row_to_dict(conn.execute(
                "SELECT * FROM shares WHERE id=?", (cur.lastrowid,)).fetchone())
        finally:
            conn.close()


def list_shares(include_revoked=False):
    with _lock:
        conn = _conn()
        try:
            sql = "SELECT * FROM shares"
            if not include_revoked:
                sql += " WHERE revoked=0"
            sql += " ORDER BY created_at DESC, id DESC"
            return [_row_to_dict(r) for r in conn.execute(sql).fetchall()]
        finally:
            conn.close()


def get_share(token=None, share_id=None):
    """对外结构（不含密码哈希）"""
    with _lock:
        conn = _conn()
        try:
            if token:
                row = conn.execute("SELECT * FROM shares WHERE token=?", (token,)).fetchone()
            else:
                row = conn.execute("SELECT * FROM shares WHERE id=?", (share_id,)).fetchone()
            return _row_to_dict(row)
        finally:
            conn.close()


def get_share_secret(token=None, share_id=None):
    """含密码哈希，仅服务端校验使用"""
    with _lock:
        conn = _conn()
        try:
            if token:
                row = conn.execute("SELECT * FROM shares WHERE token=?", (token,)).fetchone()
            else:
                row = conn.execute("SELECT * FROM shares WHERE id=?", (share_id,)).fetchone()
            return dict(row) if row else None
        finally:
            conn.close()


def update_share(share_id, password=None, expires_at=None, max_views=None,
                 note=None, revoked=None, reset_views=False):
    """按需更新字段；未传入的字段保持原值。"""
    sets, params = [], []
    if password is not None:
        sets.append("password_hash=?")
        params.append(_pw_hash(password))
    if expires_at is not None:
        sets.append("expires_at=?")
        params.append(int(expires_at or 0))
    if max_views is not None:
        sets.append("max_views=?")
        params.append(int(max_views or 0))
    if note is not None:
        sets.append("note=?")
        params.append(note or "")
    if revoked is not None:
        sets.append("revoked=?")
        params.append(1 if revoked else 0)
    if reset_views:
        sets.append("views=0")
    if not sets:
        return get_share(share_id=share_id)
    with _lock:
        conn = _conn()
        try:
            conn.execute(f"UPDATE shares SET {', '.join(sets)} WHERE id=?",
                         params + [share_id])
            conn.commit()
            return _row_to_dict(conn.execute(
                "SELECT * FROM shares WHERE id=?", (share_id,)).fetchone())
        finally:
            conn.close()


def delete_share(share_id):
    with _lock:
        conn = _conn()
        try:
            cur = conn.execute("DELETE FROM shares WHERE id=?", (share_id,))
            conn.commit()
            return cur.rowcount > 0
        finally:
            conn.close()


def bump_view(token):
    with _lock:
        conn = _conn()
        try:
            conn.execute("UPDATE shares SET views=views+1, last_view_at=? WHERE token=?",
                         (int(time.time()), token))
            conn.commit()
        finally:
            conn.close()


def verify_password(token, password):
    """校验访问密码；未设置密码时恒为 True"""
    rec = get_share_secret(token=token)
    if not rec:
        return False
    ph = rec.get("password_hash") or ""
    if not ph:
        return True
    return _pw_hash(password or "") == ph


def share_state(rec):
    """返回 'ok' | 'revoked' | 'expired' | 'exhausted'（rec 为密文结构）"""
    if not rec or rec.get("revoked"):
        return "revoked"
    now = int(time.time())
    exp = int(rec.get("expires_at") or 0)
    if exp and now > exp:
        return "expired"
    mv = int(rec.get("max_views") or 0)
    if mv and int(rec.get("views") or 0) >= mv:
        return "exhausted"
    return "ok"


def _migrate_legacy_json():
    """把旧版 .share_links.json 里的分享一次性迁进 SQLite（仅表为空时执行）"""
    legacy = os.path.join(_STORAGE_DIR, ".share_links.json")
    if not os.path.isfile(legacy):
        return
    with _lock:
        conn = _conn()
        try:
            if conn.execute("SELECT COUNT(*) FROM shares").fetchone()[0]:
                return
            try:
                with open(legacy, "r", encoding="utf-8") as f:
                    data = json.load(f)
            except (OSError, ValueError):
                return
            if not isinstance(data, dict):
                return
            count = 0
            for token, v in data.items():
                if not isinstance(v, dict):
                    continue
                path = v.get("path") or ""
                if not path:
                    continue
                try:
                    size = os.path.getsize(path) if os.path.isfile(path) else 0
                except OSError:
                    size = 0
                conn.execute(
                    """INSERT OR IGNORE INTO shares (token, abs_path, name, size, is_dir,
                       password_hash, expires_at, max_views, views, created_at, last_view_at,
                       revoked, note)
                       VALUES (?,?,?,?,0,'',0,0,0,?,0,0,'')""",
                    (token, path, v.get("name") or os.path.basename(path),
                     size, int(v.get("created") or time.time())))
                count += 1
            conn.commit()
            if count:
                _log.info("已迁移旧版分享记录 %d 条", count)
        finally:
            conn.close()


_migrate_from_shares_db()
_migrate_legacy_json()

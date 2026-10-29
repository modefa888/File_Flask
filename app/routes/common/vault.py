"""保险箱：加密存放私密文件。

设计要点
--------
- 密码只在解锁时使用：用 PBKDF2-SHA256（20 万轮 + 随机盐）派生出 32 字节密钥，
  文件用 AES-256-GCM 加密后落盘（`data/vault/<id>.bin`，格式 `VLT1|nonce|ciphertext`）。
  服务端**不保存明文密码**，只保存密码哈希（用于解锁校验）与盐。
- 解锁状态只存在进程内存（30 分钟无操作自动锁定）：服务端重启 / 超时后需要重新输入密码，
  密钥不进 Cookie、不落库，避免会话被窃取后直接解密文件。
- 文件元信息（原名 / 大小 / 时间）存 store.db 的 vault_items 表。
"""
import hashlib
import io
import os
import threading
import time
import uuid

from flask import Blueprint, jsonify, request, session, send_file
from werkzeug.security import check_password_hash, generate_password_hash

from ... import config
from ...log import get_logger
from ...services.common.store_db import get_meta, set_meta, store_conn, store_tx

_log = get_logger()
bp = Blueprint("vault", __name__)

_VAULT_DIR = os.path.join(config.DATA_ROOT, "vault")
_META_SALT = "vault.salt"
_META_HASH = "vault.hash"
_UNLOCK_TTL = 60 * 60              # 解锁有效期（1 小时），期间有操作会续期
_MAX_FILE = 200 * 1024 * 1024      # 单个文件上限 200MB（解密在内存里做）
_KDF_ROUNDS = 200_000
_MIN_PW = 6

_lock = threading.Lock()
_unlocked = {}                     # session 标识 -> (密钥, 过期时间戳)
_fails = {}                        # session 标识 -> [失败次数, 首次失败时间]
_MAX_FAILS = 5
_FAIL_WINDOW = 10 * 60

_table_ready = False


# ---------------------------------------------------------------- 基础设施
def _ensure_table():
    global _table_ready
    if _table_ready:
        return
    with _lock:
        if _table_ready:
            return
        with store_tx() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS vault_items (
                    id      TEXT PRIMARY KEY,
                    name    TEXT NOT NULL,
                    size    INTEGER NOT NULL DEFAULT 0,
                    mtime   REAL NOT NULL DEFAULT 0,
                    created REAL NOT NULL DEFAULT 0,
                    kind    TEXT NOT NULL DEFAULT 'file',
                    path    TEXT NOT NULL DEFAULT '',
                    is_dir  INTEGER NOT NULL DEFAULT 0
                )
                """
            )
            # 老库补列：kind=file 是上传加密的文件，kind=path 只是「登记保护的路径」
            cols = {r["name"] for r in conn.execute("PRAGMA table_info(vault_items)")}
            for col, decl in (("kind", "TEXT NOT NULL DEFAULT 'file'"),
                              ("path", "TEXT NOT NULL DEFAULT ''"),
                              ("is_dir", "INTEGER NOT NULL DEFAULT 0")):
                if col not in cols:
                    conn.execute("ALTER TABLE vault_items ADD COLUMN %s %s" % (col, decl))
        _table_ready = True


def _vault_dir() -> str:
    os.makedirs(_VAULT_DIR, exist_ok=True)
    try:
        os.chmod(_VAULT_DIR, 0o700)
    except OSError:
        pass
    return _VAULT_DIR


def _sid() -> str:
    """当前会话标识：优先用登录时生成的 sid（单设备登录），否则退回用户名。"""
    return session.get("sid") or ("u:" + (session.get("username") or ""))


def _derive(password: str, salt_hex: str) -> bytes:
    return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"),
                               bytes.fromhex(salt_hex), _KDF_ROUNDS, dklen=32)


def _aesgcm():
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    return AESGCM


def _encrypt(key: bytes, data: bytes) -> bytes:
    nonce = os.urandom(12)
    return b"VLT1" + nonce + _aesgcm()(key).encrypt(nonce, data, b"vault")


def _decrypt(key: bytes, blob: bytes) -> bytes:
    if not blob.startswith(b"VLT1") or len(blob) < 20:
        raise ValueError("保险箱文件格式不正确")
    nonce, body = blob[4:16], blob[16:]
    return _aesgcm()(key).decrypt(nonce, body, b"vault")


def _enabled() -> bool:
    return bool(get_meta(_META_HASH, ""))


def _cache_put(key: bytes):
    with _lock:
        _unlocked[_sid()] = (key, time.time() + _UNLOCK_TTL)


def _cache_get(refresh: bool = True):
    """取当前会话的解锁密钥；过期 / 不存在返回 None。"""
    sid = _sid()
    with _lock:
        hit = _unlocked.get(sid)
        if not hit:
            return None
        key, until = hit
        if until < time.time():
            _unlocked.pop(sid, None)
            return None
        if refresh:
            _unlocked[sid] = (key, time.time() + _UNLOCK_TTL)
        return key


def _cache_drop():
    with _lock:
        _unlocked.pop(_sid(), None)


def _locked_response():
    return jsonify({"error": "保险箱已锁定，请先解锁", "locked": True}), 403


def _too_many_fails() -> bool:
    sid = _sid()
    with _lock:
        rec = _fails.get(sid)
        if not rec:
            return False
        cnt, since = rec
        if time.time() - since > _FAIL_WINDOW:
            _fails.pop(sid, None)
            return False
        return cnt >= _MAX_FAILS


def _bump_fail():
    sid = _sid()
    with _lock:
        rec = _fails.get(sid)
        now = time.time()
        if not rec or now - rec[1] > _FAIL_WINDOW:
            _fails[sid] = [1, now]
        else:
            rec[0] += 1


def _clear_fails():
    with _lock:
        _fails.pop(_sid(), None)


def _items():
    _ensure_table()
    conn = store_conn()
    try:
        rows = conn.execute(
            "SELECT id, name, size, mtime, created, kind, path, is_dir FROM vault_items"
            " ORDER BY created DESC"
        ).fetchall()
    finally:
        conn.close()
    return [{
        "id": r["id"], "name": r["name"], "size": r["size"],
        "mtime": r["mtime"], "created": r["created"],
        "kind": (r["kind"] or "file"), "path": (r["path"] or ""),
        "is_dir": bool(r["is_dir"] or 0),
    } for r in rows]


def hidden_paths():
    """锁定时需要隐藏的绝对路径集合（登记保护的条目）；已解锁时返回空集合。"""
    try:
        if _cache_get(refresh=False) is not None:
            return set()
        _ensure_table()
        conn = store_conn()
        try:
            rows = conn.execute(
                "SELECT path FROM vault_items WHERE kind = 'path' AND path <> ''"
            ).fetchall()
        finally:
            conn.close()
        return {r["path"] for r in rows if r["path"]}
    except Exception:
        return set()


def filter_hidden(items, dir_abs):
    """从某个目录的列表结果里剔除「保险箱保护中」的条目（锁定时）。"""
    hidden = hidden_paths()
    if not hidden:
        return items
    prefix = os.path.join(dir_abs, "")
    keep = []
    for it in items:
        full = os.path.join(dir_abs, it.get("name") or "")
        if full in hidden:
            continue
        # 保护的是上级目录时，子项也一并隐藏
        if any(full == h or full.startswith(h.rstrip(os.sep) + os.sep) for h in hidden):
            continue
        keep.append(it)
    return keep


# ---------------------------------------------------------------- 接口
# 直接访问受保护路径时兜底拦截（列表里已经隐藏，这里防止猜路径直接下载 / 预览）
_GUARDED_PREFIXES = ("/api/download", "/api/stream", "/api/preview", "/api/properties",
                     "/api/read", "/api/raw", "/api/zip/create", "/api/git/diff", "/api/files/save")


@bp.before_app_request
def _guard_protected_paths():
    try:
        p = request.path or ""
        if not p.startswith(_GUARDED_PREFIXES):
            return None
        target = (request.args.get("path") or request.args.get("file")
                  or request.args.get("name") or "")
        if not target and p.startswith("/api/raw/"):
            # 这个接口把路径放在 URL 里：/api/raw/<完整路径>
            from urllib.parse import unquote
            target = unquote(p[len("/api/raw/"):])
        if not target:
            return None
        target = os.path.abspath(os.path.normpath(target))
        hidden = hidden_paths()
        if not hidden:
            return None
        for h in hidden:
            if target == h or target.startswith(h.rstrip(os.sep) + os.sep):
                return jsonify({"error": "该文件在保险箱中，请先输入密码解锁", "vault_locked": True}), 403
    except Exception:
        return None
    return None


@bp.before_request
def _raise_body_limit():
    """上传接口单独放宽请求体上限：全局是 32MB，保险箱允许单文件 200MB。

    Flask 3.1+ 支持按请求覆盖 max_content_length，不影响其它接口的限制。
    """
    if request.method == "POST" and request.path == "/api/vault/upload":
        try:
            request.max_content_length = _MAX_FILE + 4 * 1024 * 1024
        except Exception:
            pass          # 老版本 Flask 不支持：回落到全局 32MB，超限时前端会看到 413


@bp.route("/api/vault/status")
def api_vault_status():
    """保险箱状态：是否已设置密码 / 当前是否处于解锁状态 / 文件数量。"""
    _ensure_table()
    unlocked = _cache_get(refresh=False) is not None
    count = 0
    if _enabled():
        conn = store_conn()
        try:
            row = conn.execute("SELECT COUNT(*) AS n FROM vault_items").fetchone()
            count = int(row["n"] if row else 0)
        finally:
            conn.close()
    return jsonify({"enabled": _enabled(), "unlocked": unlocked, "count": count})


@bp.route("/api/vault/setup", methods=["POST"])
def api_vault_setup():
    """首次使用：设置保险箱密码（只允许设置一次）。"""
    data = request.get_json(silent=True) or {}
    pw = str(data.get("password") or "")
    if _enabled():
        return jsonify({"error": "保险箱已初始化，请使用「修改密码」"}), 400
    if len(pw) < _MIN_PW:
        return jsonify({"error": "密码至少 %d 位" % _MIN_PW}), 400
    salt = os.urandom(16).hex()
    set_meta(_META_SALT, salt)
    set_meta(_META_HASH, generate_password_hash(pw))
    _vault_dir()
    _cache_put(_derive(pw, salt))
    _clear_fails()
    _log.info("保险箱已初始化")
    return jsonify({"ok": True, "items": _items()})


@bp.route("/api/vault/unlock", methods=["POST"])
def api_vault_unlock():
    """解锁：校验密码 → 派生密钥并缓存在内存（30 分钟）。"""
    data = request.get_json(silent=True) or {}
    pw = str(data.get("password") or "")
    if not _enabled():
        return jsonify({"error": "保险箱还没设置密码"}), 400
    if _too_many_fails():
        return jsonify({"error": "密码错误次数过多，请 10 分钟后再试"}), 429
    salt = get_meta(_META_SALT, "")
    if not salt or not check_password_hash(get_meta(_META_HASH, ""), pw):
        _bump_fail()
        _log.warning("保险箱解锁失败")
        return jsonify({"error": "密码不正确"}), 401
    _clear_fails()
    _cache_put(_derive(pw, salt))
    _log.info("保险箱已解锁")
    return jsonify({"ok": True, "items": _items()})


@bp.route("/api/vault/lock", methods=["POST"])
def api_vault_lock():
    _cache_drop()
    return jsonify({"ok": True})


@bp.route("/api/vault/list")
def api_vault_list():
    if not _enabled():
        return jsonify({"error": "保险箱还没设置密码"}), 400
    if _cache_get() is None:
        return _locked_response()
    return jsonify({"items": _items()})


@bp.route("/api/vault/upload", methods=["POST"])
def api_vault_upload():
    """上传并加密：文件内容只在内存里出现一次，落盘即密文。"""
    if not _enabled():
        return jsonify({"error": "保险箱还没设置密码"}), 400
    key = _cache_get()
    if key is None:
        return _locked_response()
    f = request.files.get("file")
    if not f or not f.filename:
        return jsonify({"error": "没有收到文件"}), 400
    data = f.read(_MAX_FILE + 1)
    if len(data) > _MAX_FILE:
        return jsonify({"error": "单个文件不能超过 200MB"}), 413
    name = os.path.basename(f.filename) or "未命名文件"
    item_id = uuid.uuid4().hex
    path = os.path.join(_vault_dir(), item_id + ".bin")
    try:
        with open(path, "wb") as out:
            out.write(_encrypt(key, data))
        os.chmod(path, 0o600)
    except Exception as e:
        _log.warning("写入保险箱失败：%s", e)
        try:
            os.remove(path)
        except OSError:
            pass
        return jsonify({"error": "写入失败：%s" % e}), 500
    _ensure_table()
    with store_tx() as conn:
        conn.execute(
            "INSERT INTO vault_items (id, name, size, mtime, created) VALUES (?, ?, ?, ?, ?)",
            (item_id, name[:200], len(data), time.time(), time.time()),
        )
    _log.info("保险箱新增文件：%s (%d 字节)", name, len(data))
    return jsonify({"ok": True, "items": _items()})


# 允许「加入保险箱」的路径护栏：不能把应用数据目录 / 保险箱自身搬进去
def _path_blocked(path: str) -> bool:
    root = os.path.realpath(config.DATA_ROOT)
    p = os.path.realpath(path)
    return p == root or p.startswith(root + os.sep)


@bp.route("/api/vault/add", methods=["POST"])
def api_vault_add():
    """把文件 / 文件夹「登记」进保险箱：只做访问保护，**不动电脑上的源文件**。

    - 文件仍在原位置，不加密、不移动、不删除；
    - 保险箱锁定期间，这些路径不会出现在文件列表里，也读不到内容；
    - 输入密码解锁（1 小时有效）后恢复正常显示与访问。
    """
    if not _enabled():
        return jsonify({"error": "保险箱还没设置密码", "need_setup": True}), 400
    data = request.get_json(silent=True) or {}
    paths = data.get("paths") or []
    if not isinstance(paths, list) or not paths:
        return jsonify({"error": "没有指定要加入的文件"}), 400

    _ensure_table()
    added, errors = 0, []
    for raw in paths:
        target = os.path.abspath(os.path.normpath(str(raw)))
        if not os.path.exists(target):
            errors.append("%s：文件不存在" % raw)
            continue
        if _path_blocked(target):
            errors.append("%s：不能把这个目录加入保险箱" % raw)
            continue
        try:
            is_dir = os.path.isdir(target)
            size = 0
            try:
                if not is_dir:
                    size = os.path.getsize(target)
            except OSError:
                pass
            with store_tx() as conn:
                exists = conn.execute(
                    "SELECT id FROM vault_items WHERE kind = 'path' AND path = ?", (target,)
                ).fetchone()
                if exists:
                    continue
                conn.execute(
                    "INSERT INTO vault_items (id, name, size, mtime, created, kind, path, is_dir)"
                    " VALUES (?, ?, ?, ?, ?, 'path', ?, ?)",
                    (uuid.uuid4().hex, (os.path.basename(target.rstrip(os.sep)) or target)[:200],
                     size, time.time(), time.time(), target, 1 if is_dir else 0),
                )
            added += 1
        except Exception as e:
            errors.append("%s：%s" % (raw, e))

    # 让目录列表缓存失效：刷新后这些条目立刻从列表中消失（源文件仍在磁盘上）
    try:
        from ...services.common.filecore import _invalidate_list_cache
        for raw in paths:
            _invalidate_list_cache(os.path.dirname(os.path.abspath(os.path.normpath(str(raw)))))
    except Exception as e:
        _log.warning("保险箱加入后刷新缓存失败：%s", e)

    _log.info("保险箱登记保护路径：%d 个（错误 %d）", added, len(errors))
    return jsonify({"ok": True, "added": added, "errors": errors, "items": _items()})


@bp.route("/api/vault/download/<item_id>")
def api_vault_download(item_id):
    if _cache_get() is None:
        return _locked_response()
    _ensure_table()
    conn = store_conn()
    try:
        row = conn.execute("SELECT name, size FROM vault_items WHERE id = ?", (item_id,)).fetchone()
    finally:
        conn.close()
    if not row:
        return jsonify({"error": "文件不存在"}), 404
    path = os.path.join(_VAULT_DIR, item_id + ".bin")
    if not os.path.isfile(path):
        return jsonify({"error": "文件已丢失"}), 404
    try:
        with open(path, "rb") as fh:
            plain = _decrypt(_cache_get(refresh=False), fh.read())
    except Exception as e:
        _log.warning("解密保险箱文件失败：%s", e)
        return jsonify({"error": "解密失败（密码可能已变更，请重新解锁）"}), 500
    return send_file(io.BytesIO(plain), as_attachment=True, download_name=row["name"])


@bp.route("/api/vault/delete", methods=["POST"])
def api_vault_delete():
    data = request.get_json(silent=True) or {}
    item_id = str(data.get("id") or "")
    if not item_id:
        return jsonify({"error": "缺少文件 id"}), 400
    if _cache_get() is None:
        return _locked_response()
    _ensure_table()
    with store_tx() as conn:
        conn.execute("DELETE FROM vault_items WHERE id = ?", (item_id,))
    try:
        os.remove(os.path.join(_VAULT_DIR, item_id + ".bin"))
    except OSError:
        pass
    _log.info("保险箱删除文件：%s", item_id)
    return jsonify({"ok": True, "items": _items()})


@bp.route("/api/vault/passwd", methods=["POST"])
def api_vault_passwd():
    """修改保险箱密码：校验旧密码后，用新密钥把所有文件重新加密。"""
    data = request.get_json(silent=True) or {}
    old = str(data.get("old") or "")
    new = str(data.get("new") or "")
    if len(new) < _MIN_PW:
        return jsonify({"error": "新密码至少 %d 位" % _MIN_PW}), 400
    if _too_many_fails():
        return jsonify({"error": "密码错误次数过多，请 10 分钟后再试"}), 429
    salt = get_meta(_META_SALT, "")
    if not salt or not check_password_hash(get_meta(_META_HASH, ""), old):
        _bump_fail()
        return jsonify({"error": "原密码不正确"}), 401
    old_key = _derive(old, salt)
    new_salt = os.urandom(16).hex()
    new_key = _derive(new, new_salt)

    # 逐个文件用旧密钥解密、新密钥加密（先写临时文件再替换，避免中途失败损坏数据）
    _ensure_table()
    for it in _items():
        path = os.path.join(_VAULT_DIR, it["id"] + ".bin")
        if not os.path.isfile(path):
            continue
        try:
            with open(path, "rb") as fh:
                plain = _decrypt(old_key, fh.read())
            tmp = path + ".tmp"
            with open(tmp, "wb") as out:
                out.write(_encrypt(new_key, plain))
            os.chmod(tmp, 0o600)
            os.replace(tmp, path)
        except Exception as e:
            _log.warning("重加密失败（%s）：%s", it["name"], e)
            return jsonify({"error": "部分文件重加密失败：%s" % e}), 500

    set_meta(_META_SALT, new_salt)
    set_meta(_META_HASH, generate_password_hash(new))
    _cache_put(new_key)
    _clear_fails()
    _log.info("保险箱密码已修改")
    return jsonify({"ok": True})

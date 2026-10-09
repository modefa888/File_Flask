"""SSH 终端连接工具：管理与远程主机的连接，在编辑器区打开交互式终端。

POST /api/ssh/list           列出已保存的连接（密码 / 私钥脱敏）
POST /api/ssh/save           {id?, name, host, port, user, auth, password, key, keypass, remark}  新建 / 更新
POST /api/ssh/delete         {id}
POST /api/ssh/test           {id} 或连接字段 —— 仅测试连通性，不建 shell
POST /api/ssh/open           {id} 或连接字段 + {cols, rows} —— 建立 shell 会话，返回 session id
GET  /api/ssh/stream/<sid>   SSE：把远端 shell 输出推到前端
POST /api/ssh/input          {id, data}  发送按键 / 字符串
POST /api/ssh/resize         {id, cols, rows}
POST /api/ssh/close          {id}

存储：config.DATA_ROOT/.ssh_connections.json；密码 / 私钥用 secret.encrypt 加密落库，
前端提交时先经 transport.unwrap（RSA 传输层）再加密存储。
"""
import base64
import json
import os
import queue  # noqa: F401  （备用，当前用 deque 管理输出缓冲）
import socket
import threading
import time
import uuid
from collections import deque
from io import StringIO

from flask import Blueprint, request, jsonify, Response

from ... import config
from ...log import get_logger
from ...services.common import secret, transport


_log = get_logger()
bp = Blueprint("sshconn", __name__)

try:
    import paramiko
    _PARAMIKO_OK = True
except Exception:  # noqa: BLE001
    _PARAMIKO_OK = False

_CONN_FILE = os.path.join(config.DATA_ROOT, ".ssh_connections.json")
_LOCK = threading.Lock()

# 会话输出缓冲上限（块数），超出丢弃最旧，防止慢消费撑爆内存
_OUT_MAX = 2000
_SESSION_TTL = 2 * 3600
_READ_TIMEOUT = 0.2
_HEARTBEAT = 15.0

_SESSIONS = {}


class _Sess:
    __slots__ = ("sid", "client", "chan", "out", "cond", "alive", "cols", "rows", "created", "host", "user")

    def __init__(self, sid, client, chan, cols, rows, host, user):
        self.sid = sid
        self.client = client
        self.chan = chan
        self.out = deque()
        self.cond = threading.Condition()
        self.alive = True
        self.cols = cols
        self.rows = rows
        self.created = time.time()
        self.host = host
        self.user = user


# --------------------------------------------------------------------------
# 连接存储
# --------------------------------------------------------------------------
def _load_conns():
    try:
        with open(_CONN_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except (OSError, ValueError):
        return []


def _save_conns(conns):
    tmp = _CONN_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(conns, f, ensure_ascii=False, indent=2)
    os.replace(tmp, _CONN_FILE)


def _get_conn(cid):
    for c in _load_conns():
        if c.get("id") == cid:
            return c
    return None


def _public(c):
    return {
        "id": c.get("id"),
        "name": c.get("name") or c.get("host") or "(未命名)",
        "host": c.get("host", ""),
        "port": c.get("port", 22),
        "user": c.get("user", ""),
        "auth": c.get("auth", "password"),
        "remark": c.get("remark", ""),
        "created": c.get("created"),
        "hasPassword": bool(c.get("password")),
        "hasKey": bool(c.get("key")),
    }


def _fail(msg, code=400):
    return jsonify({"error": msg}), code


def _save_conn(data):
    """落库一条连接，返回 (记录明文 dict 或 None, 错误信息)。"""
    conns = _load_conns()
    cid = data.get("id")
    existing = next((c for c in conns if c.get("id") == cid), None) if cid else None
    rec = dict(existing) if existing else {"id": uuid.uuid4().hex[:12], "created": time.time()}

    for f in ("name", "host", "port", "user", "auth", "remark"):
        if f in data:
            rec[f] = data[f]

    # 敏感字段：传输层先 unwrap，再加密落库；显式传空 = 清空；不传 = 保留原值
    pw = transport.unwrap(data.get("password"))
    key = transport.unwrap(data.get("key"))
    kp = transport.unwrap(data.get("keypass"))
    if pw:
        rec["password"] = secret.encrypt(pw)
    elif "password" in data and not data["password"] and "password" in rec:
        rec.pop("password", None)
    if key:
        rec["key"] = secret.encrypt(key)
    elif "key" in data and not data["key"] and "key" in rec:
        rec.pop("key", None)
    if kp:
        rec["keypass"] = secret.encrypt(kp)
    elif "keypass" in data and not data["keypass"] and "keypass" in rec:
        rec.pop("keypass", None)

    if not rec.get("host"):
        return None, "缺少主机地址"
    auth = rec.get("auth", "password")
    if auth == "key":
        if not rec.get("key"):
            return None, "缺少私钥"
    elif not rec.get("password"):
        return None, "缺少登录密码"

    if existing:
        conns = [rec if c.get("id") == cid else c for c in conns]
    else:
        conns.append(rec)
    _save_conns(conns)
    return rec, None


def _resolve_conn(data):
    """把请求参数解析成「明文」连接 dict（密码 / 私钥已解密）。"""
    cid = data.get("id")
    if cid:
        c = _get_conn(cid)
        if not c:
            return None, "连接不存在"
        plain = dict(c)
        plain["password"] = secret.decrypt(c.get("password"))
        plain["key"] = secret.decrypt(c.get("key"))
        plain["keypass"] = secret.decrypt(c.get("keypass"))
        return plain, None
    raw = dict(data)
    raw["password"] = transport.unwrap(raw.get("password"))
    raw["key"] = transport.unwrap(raw.get("key"))
    raw["keypass"] = transport.unwrap(raw.get("keypass"))
    return raw, None


def _load_pkey(text, passphrase):
    if not text:
        raise ValueError("缺少私钥内容")
    classes = [paramiko.RSAKey, paramiko.Ed25519Key, paramiko.ECDSAKey, paramiko.DSSKey]
    last = None
    for kc in classes:
        try:
            return kc.from_private_key(StringIO(text), password=passphrase)
        except paramiko.SSHException as e:
            last = e
        except Exception:  # noqa: BLE001
            continue
    raise ValueError("无法解析私钥（格式不支持或口令错误）：%s" % (last or "未知"))


def _ssh_err(e):
    msg = str(e)
    low = msg.lower()
    if "authentication" in low or "auth" in low:
        return "认证失败（用户名 / 密码或密钥不正确）"
    if "timed out" in low or "timeout" in low:
        return "连接超时（主机不可达或端口未开放）"
    if "refused" in low:
        return "连接被拒绝（目标端口未监听 SSH 服务）"
    if "not found" in low or "getaddrinfo" in low or "name or service" in low:
        return "无法解析主机地址"
    return msg or "未知错误"


def _connect(conn):
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    user = conn.get("user") or "root"
    port = int(conn.get("port") or 22)
    kwargs = dict(
        hostname=conn["host"], port=port, username=user, timeout=20,
        allow_agent=False, look_for_keys=False, compress=True,
    )
    if conn.get("auth") == "key":
        pkey = _load_pkey(secret.decrypt(conn.get("key") or ""), secret.decrypt(conn.get("keypass") or "") or None)
        kwargs["pkey"] = pkey
    else:
        pw = secret.decrypt(conn.get("password") or "")
        if not pw:
            raise ValueError("缺少登录密码")
        kwargs["password"] = pw
    client.connect(**kwargs)
    return client


def _pump(sess):
    chan = sess.chan
    try:
        while True:
            try:
                data = chan.recv(4096)
            except socket.timeout:
                continue
            except Exception:  # noqa: BLE001
                break
            if not data:
                break
            with sess.cond:
                sess.out.append(data)
                if len(sess.out) > _OUT_MAX:
                    sess.out.popleft()
                sess.cond.notify()
    finally:
        with sess.cond:
            sess.alive = False
            sess.cond.notify()
        try:
            chan.close()
        except Exception:  # noqa: BLE001
            pass


def _cleanup():
    now = time.time()
    with _LOCK:
        dead = [sid for sid, s in _SESSIONS.items()
                if (not s.alive and not s.out) or now - s.created > _SESSION_TTL]
        for sid in dead:
            s = _SESSIONS.pop(sid, None)
            if s:
                try:
                    s.client.close()
                except Exception:  # noqa: BLE001
                    pass


# --------------------------------------------------------------------------
# 接口
# --------------------------------------------------------------------------
@bp.route("/api/ssh/list", methods=["GET", "POST"])
def api_ssh_list():
    conns = [_public(c) for c in _load_conns()]
    conns.sort(key=lambda c: (c.get("name") or "").lower())
    return jsonify({"ok": True, "paramiko": _PARAMIKO_OK, "connections": conns})


@bp.route("/api/ssh/save", methods=["POST"])
def api_ssh_save():
    data = request.get_json(silent=True) or {}
    rec, err = _save_conn(data)
    if err:
        return _fail(err)
    _log.info("保存 SSH 连接：%s (%s@%s)", rec.get("name"), rec.get("user"), rec.get("host"))
    return jsonify({"ok": True, "conn": _public(rec)})


@bp.route("/api/ssh/delete", methods=["POST"])
def api_ssh_delete():
    data = request.get_json(silent=True) or {}
    cid = data.get("id") or ""
    conns = _load_conns()
    new = [c for c in conns if c.get("id") != cid]
    if len(new) == len(conns):
        return _fail("连接不存在", 404)
    _save_conns(new)
    return jsonify({"ok": True})


@bp.route("/api/ssh/test", methods=["POST"])
def api_ssh_test():
    if not _PARAMIKO_OK:
        return _fail("未安装 paramiko，无法建立 SSH 连接（pip install paramiko 后重启）", 400)
    data = request.get_json(silent=True) or {}
    conn, err = _resolve_conn(data)
    if err:
        return _fail(err)
    if not conn.get("host"):
        return _fail("缺少主机地址")
    try:
        client = _connect(conn)
    except Exception as e:  # noqa: BLE001
        return jsonify({"ok": False, "error": _ssh_err(e)})
    try:
        client.close()
    except Exception:  # noqa: BLE001
        pass
    return jsonify({"ok": True})


@bp.route("/api/ssh/open", methods=["POST"])
def api_ssh_open():
    if not _PARAMIKO_OK:
        return _fail("未安装 paramiko，无法建立 SSH 连接（pip install paramiko 后重启）", 400)
    data = request.get_json(silent=True) or {}
    conn, err = _resolve_conn(data)
    if err:
        return _fail(err)
    if not conn.get("host"):
        return _fail("缺少主机地址")
    try:
        client = _connect(conn)
    except Exception as e:  # noqa: BLE001
        return _fail("连接失败：" + _ssh_err(e))
    cols = max(1, int(data.get("cols") or 80))
    rows = max(1, int(data.get("rows") or 24))
    try:
        chan = client.invoke_shell(term="xterm-256color", width=cols, height=rows)
    except Exception as e:  # noqa: BLE001
        client.close()
        return _fail("开启 shell 失败：" + str(e))
    chan.settimeout(_READ_TIMEOUT)
    _cleanup()
    sid = uuid.uuid4().hex[:16]
    sess = _Sess(sid, client, chan, cols, rows, conn.get("host"), conn.get("user"))
    with _LOCK:
        _SESSIONS[sid] = sess
    threading.Thread(target=_pump, args=(sess,), daemon=True).start()
    _log.info("SSH 会话已建立：%s@%s id=%s", conn.get("user"), conn.get("host"), sid)
    return jsonify({"ok": True, "id": sid, "host": conn.get("host"), "user": conn.get("user")})


@bp.route("/api/ssh/stream/<sid>")
def api_ssh_stream(sid):
    with _LOCK:
        sess = _SESSIONS.get(sid)
    if sess is None:
        return _fail("会话不存在或已关闭", 404)

    def gen():
        try:
            while True:
                with sess.cond:
                    if sess.out:
                        chunks = list(sess.out)
                        sess.out.clear()
                    elif not sess.alive:
                        break
                    else:
                        got = sess.cond.wait(timeout=_HEARTBEAT)
                        if not got:
                            yield ": ping\n\n"
                        continue
                for ch in chunks:
                    payload = base64.b64encode(ch).decode("ascii")
                    yield "data: " + json.dumps({"data": payload}, ensure_ascii=False) + "\n\n"
            yield "data: " + json.dumps({"eof": True}, ensure_ascii=False) + "\n\n"
        except GeneratorExit:
            pass
        finally:
            with _LOCK:
                _SESSIONS.pop(sid, None)
            try:
                sess.client.close()
            except Exception:  # noqa: BLE001
                pass

    return Response(gen(), mimetype="text/event-stream", headers={
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
        "Connection": "keep-alive",
    })


@bp.route("/api/ssh/input", methods=["POST"])
def api_ssh_input():
    data = request.get_json(silent=True) or {}
    sess = _SESSIONS.get(data.get("id") or "")
    if sess is None or not sess.alive:
        return _fail("会话不存在或已关闭", 404)
    raw = data.get("data")
    if raw is None:
        return _fail("缺少数据")
    try:
        sess.chan.send(raw.encode("utf-8", "replace"))
    except Exception as e:  # noqa: BLE001
        return _fail("发送失败：" + str(e))
    return jsonify({"ok": True})


@bp.route("/api/ssh/resize", methods=["POST"])
def api_ssh_resize():
    data = request.get_json(silent=True) or {}
    sess = _SESSIONS.get(data.get("id") or "")
    if sess is None or not sess.alive:
        return _fail("会话不存在或已关闭", 404)
    cols = max(1, int(data.get("cols") or sess.cols))
    rows = max(1, int(data.get("rows") or sess.rows))
    sess.cols, sess.rows = cols, rows
    try:
        sess.chan.resize_pty(width=cols, height=rows)
    except Exception:  # noqa: BLE001
        pass
    return jsonify({"ok": True})


@bp.route("/api/ssh/close", methods=["POST"])
def api_ssh_close():
    data = request.get_json(silent=True) or {}
    sid = data.get("id") or ""
    with _LOCK:
        sess = _SESSIONS.pop(sid, None)
    if sess is None:
        return jsonify({"ok": True})
    try:
        sess.alive = False
        sess.chan.close()
        sess.client.close()
    except Exception:  # noqa: BLE001
        pass
    return jsonify({"ok": True})

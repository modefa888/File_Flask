"""V2Ray 桌面悬浮胶囊：独立进程管理 + 本机 token。

悬浮窗是独立的 tkinter 进程（app/tools/v2ray_float.py），通过 127.0.0.1 的
HTTP 接口与 Flask 交互：
    GET  /api/v2ray/float/info    轮询状态（速度 / 节点 / 路由模式 / 节点列表）
    POST /api/v2ray/float/action  切换节点 / 路由模式 / 断开连接
这两个接口用 data/v2ray/float.token 鉴权（只允许本机），避免复用登录会话。
"""
from __future__ import annotations

import os
import secrets
import subprocess
import sys

from ... import config

_DIR = os.path.join(config.DATA_ROOT, "v2ray")
_TOKEN_FILE = os.path.join(_DIR, "float.token")
_PID_FILE = os.path.join(_DIR, "float.pid")
_LOG_FILE = os.path.join(_DIR, "float.log")


def token() -> str:
    """读取（没有就生成）悬浮窗专用 token。"""
    os.makedirs(_DIR, exist_ok=True)
    try:
        with open(_TOKEN_FILE, encoding="utf-8") as f:
            tok = f.read().strip()
        if tok:
            return tok
    except OSError:
        pass
    tok = secrets.token_urlsafe(24)
    try:
        fd = os.open(_TOKEN_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(tok)
    except OSError:
        pass
    return tok


def _read_pid() -> int:
    try:
        with open(_PID_FILE, encoding="utf-8") as f:
            return int((f.read() or "0").strip())
    except (OSError, ValueError):
        return 0


def _alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def status() -> dict:
    pid = _read_pid()
    running = _alive(pid)
    if pid and not running:
        try:
            os.remove(_PID_FILE)
        except OSError:
            pass
    return {"ok": True, "running": running, "pid": pid if running else 0}


def start(port: int = 0) -> dict:
    """启动桌面悬浮胶囊（已有进程则直接返回）。"""
    st = status()
    if st["running"]:
        return st
    # app/services/ide/v2rayfloat.py → 上三级 = app
    app_dir = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    script = os.path.join(app_dir, "tools", "v2ray_float.py")
    if not os.path.isfile(script):
        return {"ok": False, "error": "找不到悬浮窗脚本：%s" % script}
    os.makedirs(_DIR, exist_ok=True)
    logf = None
    try:
        logf = open(_LOG_FILE, "ab")
    except OSError:
        logf = None
    try:
        proc = subprocess.Popen(
            [sys.executable, script, "--port", str(int(port or config.PORT)), "--token", token()],
            cwd=os.path.dirname(app_dir),
            stdout=logf if logf is not None else subprocess.DEVNULL,
            stderr=logf if logf is not None else subprocess.DEVNULL,
            stdin=subprocess.DEVNULL,
            start_new_session=True,
            env=dict(os.environ),
        )
    except OSError as e:
        return {"ok": False, "error": "启动悬浮窗失败：%s" % e}
    finally:
        if logf is not None:
            logf.close()
    try:
        with open(_PID_FILE, "w", encoding="utf-8") as f:
            f.write(str(proc.pid))
    except OSError:
        pass
    return {"ok": True, "running": True, "pid": proc.pid}


def stop() -> dict:
    """关闭桌面悬浮胶囊。"""
    pid = _read_pid()
    if pid and _alive(pid):
        try:
            os.kill(pid, 15)
        except OSError:
            pass
    try:
        os.remove(_PID_FILE)
    except OSError:
        pass
    return {"ok": True, "running": False}

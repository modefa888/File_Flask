"""文件分享短链接：/share/<token>。

把文件路径映射为随机不可猜测的 token，分享出去的 URL 不暴露服务器上的
绝对路径（用户名 / 目录结构）。token 持久化在 data/.share_links.json，
同一文件重复分享会复用已有 token。

- POST /api/share   {path: 绝对路径} → {token, url}   （需登录）
- GET  /share/<token>   公开访问：md 渲染成居中预览页，其他文件按 MIME 返回
- GET  /share/<token>?raw=1   md 强制返回纯文本
"""
import json
import os
import secrets
import threading
import time

from flask import (
    Blueprint, request, jsonify, send_file, render_template,
    Response as FlaskResponse,
)

from .. import config
from ..log import get_logger

_log = get_logger()
bp = Blueprint("shares", __name__)

_SHARE_FILE = os.path.join(config._DATA_ROOT, ".share_links.json")
_lock = threading.Lock()

_MD_EXTS = {"md", "markdown"}


def _load() -> dict:
    try:
        with open(_SHARE_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _save(data: dict) -> None:
    with open(_SHARE_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)


@bp.route("/api/share", methods=["POST"])
def create_share():
    """为文件创建（或复用）分享 token，返回不含路径的短链接。"""
    data = request.get_json(silent=True) or {}
    path = os.path.abspath(data.get("path", ""))
    if not os.path.isfile(path):
        return jsonify({"error": "文件不存在"}), 404
    name = os.path.basename(path)
    with _lock:
        shares = _load()
        token = next((t for t, v in shares.items() if v.get("path") == path), None)
        if not token:
            token = secrets.token_urlsafe(9)
            while token in shares:
                token = secrets.token_urlsafe(9)
            shares[token] = {"path": path, "name": name, "created": int(time.time())}
            _save(shares)
    _log.info("创建分享: %s -> %s", token, name)
    return jsonify({"token": token, "url": "/share/" + token, "name": name})


@bp.route("/api/share", methods=["DELETE"])
def revoke_share():
    """撤销分享：body/query 提供 token 或 path 任一即可。"""
    data = request.get_json(silent=True) or {}
    token = data.get("token") or request.args.get("token") or ""
    path = os.path.abspath(data.get("path") or request.args.get("path") or "")
    if not token and not path:
        return jsonify({"error": "缺少 token 或 path 参数"}), 400
    with _lock:
        shares = _load()
        drop = [t for t, v in shares.items()
                if t == token or (path and v.get("path") == path)]
        for t in drop:
            del shares[t]
        if drop:
            _save(shares)
    if not drop:
        return jsonify({"error": "未找到对应的分享记录"}), 404
    _log.info("撤销分享: %s", ",".join(drop))
    return jsonify({"revoked": drop})


@bp.route("/share/<token>")
def view_share(token):
    """公开访问入口：md 渲染预览页，其他文件按原始 MIME 返回。"""
    info = _load().get(token)
    if not info:
        return FlaskResponse(
            '<meta charset="utf-8"><body style="font-family:sans-serif;'
            'display:grid;place-items:center;height:100vh;margin:0;color:#8a8f98">'
            "<div>分享链接无效或已失效</div></body>",
            status=404, mimetype="text/html",
        )
    path = info["path"]
    if not os.path.isfile(path):
        return FlaskResponse(
            '<meta charset="utf-8"><body style="font-family:sans-serif;'
            'display:grid;place-items:center;height:100vh;margin:0;color:#8a8f98">'
            "<div>分享的文件已不存在</div></body>",
            status=404, mimetype="text/html",
        )
    ext = os.path.splitext(path)[1].lower().lstrip(".")
    if ext in _MD_EXTS:
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                text = f.read()
        except (OSError, PermissionError) as e:
            return jsonify({"error": f"无法读取文件: {str(e)}"}), 500
        if request.args.get("raw") == "1":
            resp = FlaskResponse(text, status=200, mimetype="text/plain")
        else:
            resp = FlaskResponse(render_template(
                "markdown_view.html", content=text, title=info.get("name") or os.path.basename(path),
            ), status=200, mimetype="text/html")
        resp.headers["Cache-Control"] = "no-store"
        return resp
    import mimetypes
    mime, _ = mimetypes.guess_type(path)
    try:
        resp = send_file(path, mimetype=mime or "application/octet-stream",
                         as_attachment=False, conditional=True)
        resp.headers["Cache-Control"] = "no-store"
        return resp
    except (OSError, PermissionError) as e:
        return jsonify({"error": f"无法读取文件: {str(e)}"}), 500

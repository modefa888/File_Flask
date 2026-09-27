"""登录认证路由：/login、/logout，以及 before_request 全局登录校验。"""
import hmac

from flask import (
    Blueprint, request, session, redirect, url_for,
    render_template, jsonify,
)

from .. import config
from ..log import get_logger


_log = get_logger()
bp = Blueprint("auth", __name__)


def is_logged_in() -> bool:
    """当前会话是否已登录"""
    return bool(session.get("logged_in"))


# 无需登录即可访问的路径（前缀）
_PUBLIC_PATHS = ("/login", "/static")


def _is_public_path(path: str) -> bool:
    return path in _PUBLIC_PATHS or path.startswith(_PUBLIC_PATHS)


@bp.before_app_request
def _require_login():
    """除 /login 与静态资源外，所有请求都必须先登录。"""
    if is_logged_in() or _is_public_path(request.path):
        return None
    # API 请求未登录时返回 401 JSON，页面请求跳转到登录页
    if request.path.startswith("/api/"):
        return jsonify({"error": "未登录或会话已过期", "login_required": True}), 401
    return redirect(url_for("auth.login"))


@bp.route("/login", methods=["GET", "POST"])
def login():
    error = None
    if request.method == "POST":
        username = (request.form.get("username") or "").strip()
        password = request.form.get("password") or ""
        ok_user = hmac.compare_digest(username, config.AUTH_USERNAME)
        ok_pass = hmac.compare_digest(password, config.AUTH_PASSWORD)
        if ok_user and ok_pass:
            session.clear()
            session["logged_in"] = True
            session["username"] = config.AUTH_USERNAME
            _log.info("登录成功: %s", username)
            next_url = request.args.get("next")
            return redirect(next_url or url_for("pages.index"))
        error = "用户名或密码错误"
        _log.warning("登录失败: %s", username)
    return render_template("login.html", error=error)


@bp.route("/logout")
def logout():
    session.clear()
    _log.info("已登出")
    return redirect(url_for("auth.login"))
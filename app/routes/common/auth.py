"""登录认证路由：/login、/logout，以及 before_request 全局登录校验。"""
import hmac

from flask import (
    Blueprint, request, session, redirect, url_for,
    render_template, jsonify,
)

from ... import config
from ...log import get_logger


_log = get_logger()
bp = Blueprint("auth", __name__)


def is_logged_in() -> bool:
    """当前会话是否已登录"""
    return bool(session.get("logged_in"))


# 无需登录即可访问的路径（前缀）
# /share/<token>：token 本身就是随机不可猜测的访问凭证
_PUBLIC_PATHS = ("/login", "/static", "/share/")


def _is_public_path(path: str) -> bool:
    return path in _PUBLIC_PATHS or path.startswith(_PUBLIC_PATHS)


def _safe_next() -> str:
    """取 ?next= 的目标地址，只接受站内相对路径。

    - 必须是 "/" 开头，挡掉 http://evil.com 这类跳板（开放重定向）；
    - 挡掉 "//evil.com"（协议相对地址）与指向 /login 自身的地址，避免登录页来回跳。
    """
    nxt = (request.args.get("next") or "").strip()
    if not nxt.startswith("/") or nxt.startswith("//"):
        return ""
    if nxt == "/login" or nxt.startswith("/login?") or nxt.startswith("/login/"):
        return ""
    if any(c in nxt for c in ("\r", "\n", "\t", "\\")):   # 防头注入 / 反斜杠绕过的地址
        return ""
    return nxt


@bp.before_app_request
def _require_login():
    """除 /login 与静态资源外，所有请求都必须先登录。"""
    if is_logged_in() or _is_public_path(request.path):
        return None
    # API 请求未登录时返回 401 JSON，页面请求跳转到登录页
    if request.path.startswith("/api/"):
        return jsonify({"error": "未登录或会话已过期", "login_required": True}), 401
    # 带上原始地址（含查询串，如 /ide?id=xxx），登录成功后自动回到刚才要去的页面。
    # 只对 GET/HEAD 带 next：POST 的地址回跳时会变成 GET，可能 405。
    if request.method in ("GET", "HEAD"):
        target = request.full_path
        if target.endswith("?"):                # 无查询串时 full_path 会多一个 "?"
            target = target[:-1]
        return redirect(url_for("auth.login", next=target))
    return redirect(url_for("auth.login"))


@bp.route("/login", methods=["GET", "POST"])
def login():
    # 已登录时再打开登录页（收藏夹、后退、手输地址等）直接进目标页，
    # 不重复显示登录表单；POST 仍照常处理，方便换账号重新登录。
    if request.method == "GET" and is_logged_in():
        return redirect(_safe_next() or url_for("pages.index"))
    error = None
    if request.method == "POST":
        username = (request.form.get("username") or "").strip()
        password = request.form.get("password") or ""
        ok_user = hmac.compare_digest(username, config.AUTH_USERNAME)
        ok_pass = hmac.compare_digest(password, config.AUTH_PASSWORD)
        if ok_user and ok_pass:
            session.clear()
            # 持久化会话 cookie（默认 31 天）：否则是浏览器会话级 cookie，
            # 关掉浏览器/过一段时间就失效——手机上尤其明显，
            # 表现为页面还在（缓存），但新接口请求全部 401。
            session.permanent = True
            session["logged_in"] = True
            session["username"] = config.AUTH_USERNAME
            _log.info("登录成功: %s", username)
            return redirect(_safe_next() or url_for("pages.index"))
        error = "用户名或密码错误"
        _log.warning("登录失败: %s", username)
    return render_template("login.html", error=error)


@bp.route("/logout")
def logout():
    session.clear()
    _log.info("已登出")
    return redirect(url_for("auth.login"))
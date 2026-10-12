"""登录认证路由：/login、/register、/logout，以及 before_request 全局登录校验。"""
from flask import (
    Blueprint, request, session, redirect, url_for,
    render_template, jsonify,
)

from ... import config
from ...log import get_logger
from ...services.common.users import create_user, verify_user


_log = get_logger()
bp = Blueprint("auth", __name__)


def is_logged_in() -> bool:
    """当前会话是否已登录"""
    return bool(session.get("logged_in"))


def current_role() -> str:
    """当前登录用户的角色：'admin' / 'member'；未登录返回 ''。

    老会话（引入角色机制之前登录）没有 role 字段，视为 admin——
    那时系统只有 config 单账号，必然是管理员。
    """
    if not is_logged_in():
        return ""
    return session.get("role") or "admin"


def is_admin() -> bool:
    return current_role() == "admin"


def current_username() -> str:
    """当前登录用户的用户名（数据库 users 表的主键）；未登录返回空串。

    用于协作编辑的固定昵称：昵称不能再随机生成，否则每次刷新都会变成
    「房主1234 / 访客5678」这类新身份，「谁改的」记录也跟着乱。
    """
    if not is_logged_in():
        return ""
    return (session.get("username") or "").strip()


# member（受邀协作者）可访问的白名单：受限协作页 + 文件资源列表 + 协作房间信息 + 登出。
# 其余页面/接口（IDE、终端、Git、AI、设置、写文件等）一律拒绝。
_MEMBER_ALLOW_PATHS = ("/collab", "/logout")
_MEMBER_ALLOW_API = {
    ("/api/files", "GET"),        # 项目文件资源列表（只读）
    ("/api/collab/rooms", "GET"),  # 协作房间列表（成员查看自己所在会话）
}


# 无需登录即可访问的路径（前缀）
# /share/<token>：token 本身就是随机不可猜测的访问凭证
# /register：开放注册（协作者没有账号时自行注册后再通过邀请链接加入）
_PUBLIC_PATHS = ("/login", "/register", "/static", "/share/", "/ws/", "/api/collab/")


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
    """除 /login 与静态资源外，所有请求都必须先登录；member 仅限白名单。"""
    if not is_logged_in():
        if _is_public_path(request.path):
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

    # 已登录的协作者（member）：只能访问白名单内的受限功能。
    # /ide 等页面与其余全部 API 都只有管理员可用。
    if current_role() != "admin":
        p = request.path
        allowed = (
            p in _MEMBER_ALLOW_PATHS
            or p.startswith("/static")          # 静态资源对协作者开放，否则 JS 会被重定向成 HTML
            or p.startswith("/ws/")             # WebSocket 对协作者开放，否则 /ws/collab 握手被 302
            or (p, request.method) in _MEMBER_ALLOW_API
            or (p.startswith("/api/collab/") and request.method == "GET")
        )
        if not allowed:
            _log.warning("协作者越权访问已拦截: %s %s", request.method, p)
            if p.startswith("/api/"):
                return jsonify({"error": "协作者账户无权访问该功能", "forbidden": True}), 403
            # 页面请求统一回到受限协作页（含 /ide、首页等）；
            # 保留查询串（如 /?collab=<令牌>），协作页才能拿到令牌自动加入房间
            qs = request.query_string.decode("utf-8", "ignore").strip()
            return redirect("/collab" + (("?" + qs) if qs else ""))
    return None


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
        user = verify_user(username, password)
        if user:
            session.clear()
            # 持久化会话 cookie（默认 31 天）：否则是浏览器会话级 cookie，
            # 关掉浏览器/过一段时间就失效——手机上尤其明显，
            # 表现为页面还在（缓存），但新接口请求全部 401。
            session.permanent = True
            session["logged_in"] = True
            session["username"] = user["username"]
            session["role"] = user["role"]
            _log.info("登录成功: %s (role=%s)", user["username"], user["role"])
            return redirect(_safe_next() or url_for("pages.index"))
        error = "用户名或密码错误"
        _log.warning("登录失败: %s", username)
    return render_template("login.html", error=error)


@bp.route("/register", methods=["GET", "POST"])
def register():
    """开放注册：协作者没有账号时自行注册，注册成功直接登录并回到 ?next=。"""
    nxt = _safe_next()
    if request.method == "GET" and is_logged_in():
        return redirect(nxt or url_for("pages.index"))
    error = None
    username = ""
    if request.method == "POST":
        username = (request.form.get("username") or "").strip()
        password = request.form.get("password") or ""
        confirm = request.form.get("confirm") or ""
        if password != confirm:
            error = "两次输入的密码不一致"
        elif username == config.AUTH_USERNAME:
            error = "该用户名已被占用"
        else:
            err = create_user(username, password)
            if err:
                error = err
            else:
                session.clear()
                session.permanent = True
                session["logged_in"] = True
                session["username"] = username.strip()
                session["role"] = "member"
                _log.info("注册并登录: %s", username)
                return redirect(nxt or url_for("pages.index"))
    return render_template("register.html", error=error, username=username, next=nxt)


@bp.route("/logout")
def logout():
    session.clear()
    _log.info("已登出")
    return redirect(url_for("auth.login"))
"""登录认证路由：/login、/register、/logout，以及 before_request 全局登录校验。"""
from flask import (
    Blueprint, request, session, redirect, url_for,
    render_template, jsonify,
)

from ... import config
from ...log import get_logger
from ...services.common.users import (
    create_user, verify_user, user_exists, is_banned,
    must_change_password, change_own_password, get_password_version,
    touch_login,
)
from ...services.common.auth_settings import registration_open


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


# member（受邀协作者）可访问的白名单：受限协作页 + 被分享文件清单 + 协作房间信息 + 登出。
# 注意：不再放行通用 /api/files —— 协作者只能通过 /api/shared/files 访问「被分享的文件」，
# 即使知道其它文件的路径也无法读取其信息。
# 其余页面/接口（IDE、终端、Git、AI、设置、写文件等）一律拒绝。
_MEMBER_ALLOW_PATHS = ("/collab", "/logout")
_MEMBER_ALLOW_API = {
    ("/api/shared/files", "GET"),   # 被分享的文件清单 / 分享范围内目录（只读、限定范围）
    ("/api/shared/files", "HEAD"),  # HEAD 与 GET 等同（如探测文件大小）
    ("/api/collab/rooms", "GET"),   # 协作房间列表（成员查看自己所在会话）
    ("/api/icons/custom", "GET"),   # 自定义图标规则（只读，纯展示用，不含敏感信息）
    ("/api/icons/ui.css", "GET"),   # 界面图标替换生成的全局 CSS（只读，无敏感信息）
}


# 改密页路由（首次运行必须修改初始密码时强制跳转到这里）
CHANGE_PW_PATH = "/change-password"

# 「初始密码未修改」期间额外放行的路径：
#   /change-password 改密页本身；/logout 允许退出（否则会被锁在改密页里）；
#   /login 允许换账号重新登录。静态资源同样放行，保证页面样式能加载。
_FORCE_PW_PASS_PATHS = (CHANGE_PW_PATH, "/logout", "/login")


# 无需登录即可访问的路径（前缀）
# /share/<token>：token 本身就是随机不可猜测的访问凭证
# /n/<token>：定时任务「网页版通知」的只读渲染页，token 同样是随机不可猜的凭证
# /register：开放注册（协作者没有账号时自行注册后再通过邀请链接加入）
_PUBLIC_PATHS = ("/login", "/register", "/static", "/share/", "/n/", "/ws/", "/api/collab/")


def _is_public_path(path: str) -> bool:
    return path in _PUBLIC_PATHS or path.startswith(_PUBLIC_PATHS)


# 接口访问级别常量：后台「接口模块 / 权限模块」直接复用，保证与实际鉴权口径一致。
ACCESS_PUBLIC = "public"    # 无需登录即可访问
ACCESS_MEMBER = "member"    # 登录后的协作者（member）可访问
ACCESS_ADMIN = "admin"      # 仅管理员可访问


def access_level(path: str, method: str = "GET") -> str:
    """判定某个路径 + 方法所需的访问级别：public / member / admin。

    判定顺序与下面的 `_require_login` 完全一致，二者共用同一套白名单常量：
    后台接口目录与权限矩阵由此得到「文档即实际」的权限标注，避免口径分裂。

    注意：路径可以带 Flask 规则占位符（如 '/share/<token>'），前缀匹配依然成立。
    """
    path = path or ""
    method = (method or "GET").upper()
    if _is_public_path(path):
        return ACCESS_PUBLIC
    if path in _MEMBER_ALLOW_PATHS:
        return ACCESS_MEMBER
    if path.startswith("/static") or path.startswith("/ws/"):
        return ACCESS_MEMBER
    if (path, method) in _MEMBER_ALLOW_API:
        return ACCESS_MEMBER
    if path.startswith("/api/collab/") and method in ("GET", "HEAD"):
        return ACCESS_MEMBER
    return ACCESS_ADMIN


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
    """统一鉴权：以数据库「接口登记表 + 权限表」为准（见 services/adm/api_registry.py）。

    判定顺序：
      1. 接口被停用 -> 一律拒绝（403）；
      2. 当前「角色 + 接口」有「手动设置」的权限记录 -> 以记录为准（允许 / 禁止）；
      3. 否则按接口访问级别推导：public 所有角色可用、member 协作者/管理员可用、admin 仅管理员。
    仅当接口未登记（未同步 / 未知路由）时，才回退到代码默认级别 access_level()。
    注：权限表里的「默认快照」（source='default'）仅供查看，不参与鉴权。
    """
    # 密码版本校验：改密 / 后台重置后，该账号在其它设备上的旧登录会话自动失效。
    # 老会话没有 pw_ver 字段（升级前的登录），不参与校验，保持兼容。
    if is_logged_in() and session.get("pw_ver") is not None:
        if get_password_version(current_username()) != session["pw_ver"]:
            session.clear()
            return _need_login()

    # 首次运行的初始密码未修改：除改密页 / 登出 / 登录 / 静态资源外一律拦下，
    # 不允许带着默认口令使用系统里的任何功能。
    if is_logged_in() and session.get("must_change_pw"):
        path = request.path
        if not (path in _FORCE_PW_PASS_PATHS or path.startswith("/static")):
            return _force_change_password()

    from ...services.adm import api_registry
    rule = getattr(request, "url_rule", None)
    rule_str = rule.rule if rule is not None else request.path
    method = (request.method or "GET").upper()

    ent = api_registry.lookup(rule_str, method)
    if ent is not None:
        if ent["disabled"]:
            _log.warning("已停用接口被拦截: %s %s", method, request.path)
            return _deny_disabled()
        level = ent["access"] or ent["access_default"] or access_level(rule_str, method)
        subject = current_role() if is_logged_in() else "guest"
        allowed = ent["manual"].get(subject)          # 仅后台「手动设置」的权限参与鉴权
        if allowed is None:
            allowed = api_registry.role_allowed(subject, level)
        if allowed:
            return None
        return _need_login() if subject == "guest" else _member_denied()

    # 未登记：按代码默认级别兜底（与旧逻辑一致）
    level = access_level(rule_str, method)
    if level == ACCESS_PUBLIC:
        return None
    if not is_logged_in():
        return _need_login()
    if level == ACCESS_ADMIN and current_role() != "admin":
        return _member_denied()
    return None


def _need_login():
    """未登录：API 返回 401 JSON，页面跳转到登录页。"""
    # API 请求未登录时返回 401 JSON，页面请求跳转到登录页
    if request.path.startswith("/api/"):
        return jsonify({"error": "未登录或会话已过期", "login_required": True}), 401
    # 带上原始地址（含查询串，如 /ide?id=xxx），登录成功后自动回到刚才要去的页面。
    # 只对 GET/HEAD 带 next：POST 的地址回跳时会变成 GET，可能 405。
    if request.method in ("GET", "HEAD"):
        target = request.full_path
        if target.endswith("?"):                    # 无查询串时 full_path 会多一个 "?"
            target = target[:-1]
        return redirect(url_for("auth.login", next=target))
    return redirect(url_for("auth.login"))


def _force_change_password():
    """初始密码未修改：API 返回 403 JSON，页面请求跳转到改密页。"""
    if request.path.startswith("/api/"):
        return jsonify({"error": "请先修改初始密码后再使用", "password_change_required": True}), 403
    return redirect(url_for("auth.change_password"))


def _member_denied():
    """协作者（member）越权：API 返回 403 JSON，页面回到受限协作页。"""
    _log.warning("协作者越权访问已拦截: %s %s", request.method, request.path)
    if request.path.startswith("/api/"):
        return jsonify({"error": "协作者账户无权访问该功能", "forbidden": True}), 403
    # 页面请求统一回到受限协作页（含 /ide、首页等）；
    # 保留查询串（如 /?collab=<令牌>），协作页才能拿到令牌自动加入房间
    qs = request.query_string.decode("utf-8", "ignore").strip()
    return redirect("/collab" + (("?" + qs) if qs else ""))


def _deny_disabled():
    """接口被管理员停用：API 返回 403 JSON，页面渲染错误页。"""
    if request.path.startswith("/api/"):
        return jsonify({"error": "该接口已被管理员停用", "disabled": True}), 403
    return render_template("error.html", code=403, title="接口已停用",
                           message="该功能已被管理员停用，请稍后再试。",
                           path=request.path), 403


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
            session["pw_ver"] = int(user.get("pw_ver", 0))
            _log.info("登录成功: %s (role=%s)", user["username"], user["role"])
            touch_login(user["username"])           # 后台用户列表的「最近登录时间」
            # 首次运行：管理员用的还是初始（默认）密码，必须先改一次才能进入系统
            if user["role"] == "admin" and must_change_password(user["username"]):
                session["must_change_pw"] = True
                session["pw_change_next"] = _safe_next()   # 改完密再回到原本要去的页面
                _log.info("初始密码未修改，跳转强制改密页: %s", user["username"])
                return redirect(url_for("auth.change_password"))
            return redirect(_safe_next() or url_for("pages.index"))
        elif user_exists(username) and is_banned(username):
            # 账号存在且被封禁：给出明确提示，避免用户反复试密码
            error = "该账号已被封禁，请联系管理员"
            _log.warning("已封禁账号登录被拒: %s", username)
        else:
            error = "用户名或密码错误"
            _log.warning("登录失败: %s", username)
    return render_template("login.html", error=error, allow_register=registration_open())


@bp.route("/register", methods=["GET", "POST"])
def register():
    """开放注册：协作者没有账号时自行注册，注册成功直接登录并回到 ?next=。

    受「前端注册开关」控制：关闭后不再展示 / 处理注册表单，只能由管理员在后台建号。
    """
    if not registration_open():
        return render_template("register.html", closed=True,
                               error="注册功能已关闭，请使用已有账号登录，或联系管理员开通。"), 403

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
                session["pw_ver"] = get_password_version(username.strip())
                _log.info("注册并登录: %s", username)
                touch_login(username.strip())
                return redirect(nxt or url_for("pages.index"))
    return render_template("register.html", error=error, username=username, next=nxt)


@bp.route(CHANGE_PW_PATH, methods=["GET", "POST"])
def change_password():
    """修改当前账号密码。

    项目首次运行时管理员登录后会被强制跳转到这里（session.must_change_pw），
    改密成功前无法访问其它任何页面 / 接口；也作为已登录用户主动改密的入口。
    """
    if not is_logged_in():
        return redirect(url_for("auth.login"))
    error = None
    forced = bool(session.get("must_change_pw"))
    if request.method == "POST":
        old_pw = request.form.get("old_password") or ""
        new_pw = request.form.get("new_password") or ""
        confirm = request.form.get("confirm") or ""
        if new_pw != confirm:
            error = "两次输入的新密码不一致"
        else:
            err = change_own_password(current_username(), old_pw, new_pw)
            if err:
                error = err
            else:
                session.pop("must_change_pw", None)
                # 改密后 pw_ver 已 +1：同步刷新本会话的版本号，当前登录保持有效；
                # 该账号其它设备 / 其它浏览器上的旧会话会在下次请求时自动失效。
                session["pw_ver"] = get_password_version(current_username())
                # 只对站内相对地址回跳，挡掉 http://evil.com 与协议相对地址（开放重定向）
                nxt = (session.pop("pw_change_next", "") or "").strip()
                if not (nxt.startswith("/") and not nxt.startswith("//")):
                    nxt = ""
                _log.info("密码修改成功: %s", current_username())
                return redirect(nxt or url_for("pages.index"))
    return render_template("change_password.html", error=error,
                           username=current_username(), forced=forced)


@bp.route("/logout")
def logout():
    session.clear()
    _log.info("已登出")
    return redirect(url_for("auth.login"))
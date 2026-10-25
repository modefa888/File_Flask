"""页面路由。"""
import re

from flask import Blueprint, make_response, redirect, render_template, request

from ... import config
from ...log import get_logger
from ...services.common import transport


_log = get_logger()
bp = Blueprint("pages", __name__)


# 移动端 User-Agent 识别（不含平板以下的小众设备，避免误判桌面）
_MOBILE_UA_RE = re.compile(
    r"(android|iphone|ipod|ipad|mobile|blackberry|windows phone|webos|"
    r"opera mini|harmonyos|huawei|micromessenger|qqbrowser|ucbrowser)",
    re.IGNORECASE,
)


@bp.route("/")
def index():
    _log.info("GET /")
    # 携带协作令牌的链接（邀请协作编辑）不属于文件管理器首页：
    # 自动重定向到 IDE 页，由 IDE 内的协作模块接管加入流程（旧链接兜底）
    collab_token = (request.args.get("collab") or "").strip()
    if collab_token:
        return redirect(f"/ide?collab={collab_token}")
    # 手机访问自动使用移动版；可通过 ?view=desktop / ?view=mobile 强制覆盖
    ua = request.headers.get("User-Agent", "")
    force = request.args.get("view")
    is_mobile = bool(_MOBILE_UA_RE.search(ua))
    if force == "desktop":
        is_mobile = False
    elif force == "mobile":
        is_mobile = True
    template = "mobile/mobile.html" if is_mobile else "index/index.html"
    return _render_page(template)


def _render_page(template, **ctx):
    resp = make_response(render_template(template, **ctx))
    resp.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate, max-age=0'
    resp.headers['Pragma'] = 'no-cache'
    resp.headers['Expires'] = '0'
    return resp


# 移动版独立入口：无论什么设备，访问 /m 或 /mobile 都直接打开移动版
@bp.route("/m")
@bp.route("/mobile")
def mobile_entry():
    _log.info("GET /m (mobile entry)")
    return _render_page("mobile/mobile.html")


# 电脑版独立入口：访问 /desktop 强制打开桌面版
@bp.route("/desktop")
def desktop_entry():
    _log.info("GET /desktop (desktop entry)")
    return _render_page("index/index.html")


# 受限协作编辑页：受邀协作者（member）的专属页面 —— 只有文件树 + 协作编辑，
# 没有终端 / Git / AI / 运行 / 设置等任何其他功能（接口层也已封禁）
@bp.route("/collab")
def collab_entry():
    from .auth import is_admin, current_username
    _log.info("GET /collab token=%s", request.args.get("collab", ""))
    # collab_user：登录用户名（数据库 users 表）——协作编辑用它做固定昵称
    return _render_page("collab.html", is_admin=is_admin(),
                        collab_user=current_username())


# 在线项目开发（类 VSCode）页面：访问 /ide?path=<文件夹绝对路径> —— 仅管理员
@bp.route("/ide")
def ide_entry():
    from .auth import is_admin, current_username
    if not is_admin():
        # 协作者误入 IDE 页：带协作令牌时转到受限协作页继续加入，否则也回协作页
        token = (request.args.get("collab") or "").strip()
        _log.info("GET /ide 被拒绝（非管理员），跳转 /collab token=%s", token)
        return redirect(f"/collab?collab={token}" if token else "/collab")
    _log.info("GET /ide path=%s", request.args.get("path", ""))
    # 注入传输加密公钥：前端提交 Token / API Key 前用它加密（见 services/common/transport.py）；
    # 同时注入登录用户名，协作编辑用做固定昵称（不能再随机生成）；
    # app_version 供「帮助 → 关于」显示版本号（app/config.py 的 APP_VERSION）
    return _render_page("ide/ide.html", tp_pub=transport.public_key_payload(),
                        collab_user=current_username(),
                        app_version=config.APP_VERSION)

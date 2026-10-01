"""页面路由。"""
import re

from flask import Blueprint, make_response, render_template, request

from ...log import get_logger


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


def _render_page(template):
    resp = make_response(render_template(template))
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


# 在线项目开发（类 VSCode）页面：访问 /ide?path=<文件夹绝对路径>
@bp.route("/ide")
def ide_entry():
    _log.info("GET /ide path=%s", request.args.get("path", ""))
    return _render_page("ide/ide.html")

"""文件分享：短链 + 访问密码 + 有效期 + 访问次数限制。

存储：SQLite（统一库 data/storage/store.db 的 shares 表，见 services/common/share_store.py）。

管理接口（需登录）：
- POST   /api/share          {path, password?, expires_in?|expires_at?, max_views?, note?}
- GET    /api/shares         分享记录列表
- POST   /api/share/update   {id, password?, expires_at?|expires_in?, max_views?, note?, revoked?, reset_views?}
- DELETE /api/share          {id} 或 {token}

公开访问（免登录，见 auth._PUBLIC_PATHS 的 /share/ 前缀）：
- GET/POST /share/<token>            分享页（设置了密码时先出密码页）
- GET      /share/<token>/raw        原始内容（图片/视频/音频/文本内嵌引用）
- GET      /share/<token>/download   附件下载
"""
import hashlib
import hmac
import io
import mimetypes
import os
import secrets
import socket
import time
from urllib.parse import urlparse

import qrcode

from flask import (
    Blueprint, request, jsonify, send_file, render_template, session,
    Response as FlaskResponse,
)

from ...config import _STORAGE_DIR
from ...log import get_logger
from ...services.common.share_store import (
    create_share, list_shares, get_share, get_share_secret, update_share,
    delete_share, bump_view, verify_password, share_state, EXPIRE_PRESETS,
)

_log = get_logger()
bp = Blueprint("shares", __name__)

# ===== 内容直链签名 =====
# /share/<token>/raw 与 /download 只凭 token 就能拉走原文件，一旦被单独转发
# 出去就绕过了分享页（密码、有效期都不再生效）。这里给它们加时效签名：
# 只有从分享页渲染出来的、带正确 sig 与 exp 的请求才放行。
_SHARE_SIG_TTL = 12 * 3600          # 签名有效期（秒）


def _load_sign_key():
    """签名密钥：首次生成随机值并持久化，不复用可预测的 SECRET_KEY 默认值"""
    path = os.path.join(_STORAGE_DIR, ".file_manager_share_key")
    try:
        with open(path, "r", encoding="utf-8") as f:
            key = f.read().strip()
        if len(key) >= 32:
            return key
    except OSError:
        pass
    key = secrets.token_hex(32)
    try:
        with open(path, "w", encoding="utf-8") as f:
            f.write(key)
    except OSError:
        pass
    return key


_SIGN_KEY = _load_sign_key()


def _sign(scope, exp):
    msg = f"{scope}|{exp}".encode("utf-8")
    return hmac.new(_SIGN_KEY.encode("utf-8"), msg, hashlib.sha256).hexdigest()[:40]


def _signed_url(token, action=""):
    """生成带时效签名的直链"""
    exp = int(time.time()) + _SHARE_SIG_TTL
    scope = f"{token}/{action}"
    base = f"/share/{token}/{action}"
    return f"{base}?exp={exp}&sig={_sign(scope, exp)}"


def _check_sig(token, action):
    """校验直链签名是否有效且未过期"""
    exp = request.args.get("exp", "")
    sig = request.args.get("sig", "")
    if not exp.isdigit() or not sig:
        return False
    if int(exp) < time.time():
        return False
    return hmac.compare_digest(sig, _sign(f"{token}/{action}", exp))


def _guard_share_action(token, action):
    """内容直链的统一校验：签名 → 同源 → 分享状态 → 访问密码。

    通过返回 (rec, None)；拒绝返回 (None, (response, status))。
    """
    if not _check_sig(token, action):
        return None, (jsonify({"error": "访问签名无效或已过期，请刷新分享页后重试"}), 403)
    if not _check_same_origin():
        return None, (jsonify({"error": "该地址仅允许从分享页内访问"}), 403)
    rec = get_share_secret(token=token)
    if share_state(rec) != "ok":
        return None, (jsonify({"error": "分享无效或已失效"}), 403)
    if rec.get("password_hash") and not session.get("share_auth_" + token):
        return None, (jsonify({"error": "需要访问密码"}), 403)
    return rec, None


def _find_sibling(abs_path, exts):
    """在文件同目录下查找同主名的兄弟文件（用于封面图 / .lrc 歌词）"""
    if not abs_path:
        return None
    folder = os.path.dirname(abs_path)
    stem = os.path.splitext(os.path.basename(abs_path))[0].lower()
    try:
        for name in os.listdir(folder):
            if os.path.splitext(name)[1].lower().lstrip(".") not in exts:
                continue
            if os.path.splitext(name)[0].lower() != stem:
                continue
            full = os.path.join(folder, name)
            if os.path.isfile(full):
                return full
    except OSError:
        return None
    return None


def _check_same_origin():
    """只允许「从本站页面发起」的请求，防止直链被跨站引用或直接粘贴盗用。

    优先使用现代浏览器的 Fetch Metadata（Sec-Fetch-Site）；
    老浏览器没有该头时回退到 Referer 同源判断。
    """
    site = (request.headers.get("Sec-Fetch-Site") or "").lower()
    if site:
        return site == "same-origin"
    ref = request.headers.get("Referer") or ""
    if not ref:
        return False
    try:
        return urlparse(ref).netloc == request.host
    except ValueError:
        return False

def _truthy(v):
    """把 JSON 布尔 / 查询串统一成布尔值。

    注意：JSON 里传 true 时 Python 拿到的是 bool，str(True) == "True"（首字母大写），
    所以必须 lower 后再比较，否则 "True" 会被误判为假。
    前端发 {soft: true} 就踩过这个坑：软取消被当成硬删除、记录直接消失。
    """
    return str(v).strip().lower() in ("1", "true", "yes", "on")


_MD_EXTS = {"md", "markdown"}
_IMG_EXTS = {"png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "ico", "avif"}
_VIDEO_EXTS = {"mp4", "webm", "mkv", "avi", "mov", "m4v", "ogg", "flv", "wmv", "rmvb"}
_AUDIO_EXTS = {"mp3", "wav", "ogg", "flac", "aac", "m4a", "opus", "wma", "ape"}
_TEXT_EXTS = {"txt", "log", "json", "xml", "yml", "yaml", "csv", "ini", "conf", "py", "js",
              "ts", "css", "html", "sh", "bat", "c", "cpp", "h", "java", "go", "rs",
              "sql", "toml", "env"}

_KIND_ICON = {
    "image": "bi-file-image",
    "video": "bi-file-play",
    "audio": "bi-file-music",
    "markdown": "bi-file-text",
    "text": "bi-file-text",
    "pdf": "bi-file-pdf",
    "other": "bi-file-earmark",
}


# ============================ 工具函数 ============================
def _ext_of(path):
    return os.path.splitext(path)[1].lower().lstrip(".")


def _kind_of(path):
    ext = _ext_of(path)
    if ext in _IMG_EXTS:
        return "image"
    if ext in _VIDEO_EXTS:
        return "video"
    if ext in _AUDIO_EXTS:
        return "audio"
    if ext in _MD_EXTS:
        return "markdown"
    if ext == "pdf":
        return "pdf"
    if ext in _TEXT_EXTS:
        return "text"
    return "other"


def _human_size(n):
    n = int(n or 0)
    if n < 1024:
        return f"{n} B"
    if n < 1024 * 1024:
        return f"{n / 1024:.1f} KB"
    if n < 1024 ** 3:
        return f"{n / 1024 / 1024:.1f} MB"
    return f"{n / 1024 ** 3:.2f} GB"


def _fmt_time(ts):
    if not ts:
        return "-"
    return time.strftime("%Y-%m-%d %H:%M", time.localtime(int(ts)))


def _public_url(token):
    """拼出可直接分发的完整地址（带 host）"""
    return request.host_url.rstrip("/") + "/share/" + str(token or "")


def _lan_ip():
    """探测本机在局域网中的出口 IP（不真正发包，只借路由表选地址）；失败返回空串"""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except OSError:
        return ""
    finally:
        s.close()


_LOCAL_HOSTS = {"localhost", "127.0.0.1", "0.0.0.0", "::1", ""}


def _is_private_host(host):
    """是否是内网地址（IPv4 私有段）"""
    if host.startswith("10.") or host.startswith("192.168."):
        return True
    if host.startswith("172."):
        try:
            return 16 <= int(host.split(".")[1]) <= 31
        except (IndexError, ValueError):
            return False
    return False


def _phone_target(token):
    """计算「给手机扫码用」的地址，并判断它的可达范围。

    返回 (url, scope)：
    - 'public'：公网域名 / 公网 IP —— 手机用任意网络（4G/5G）都能打开
    - 'lan'   ：局域网 IP —— 手机需要和本机连同一个 Wi-Fi
    - 'local' ：只有 localhost 且探测不到网卡 IP —— 扫码打不开，需要换地址访问

    localhost 会被替换成局域网 IP，否则手机扫出来的是「手机自己」；
    公网域名照原样保留。另外反向代理（nginx 等）下 request.host 可能只是
    内部地址（如 127.0.0.1:5001），此时优先采用代理写入的对外地址。
    """
    parsed = urlparse(request.host_url.rstrip("/"))
    fwd_host = (request.headers.get("X-Forwarded-Host") or "").split(",")[0].strip()
    fwd_proto = (request.headers.get("X-Forwarded-Proto") or "").split(",")[0].strip()
    host = fwd_host or parsed.netloc
    scheme = fwd_proto or parsed.scheme or "http"
    hp = urlparse("//" + host)
    hostname = (hp.hostname or "").lower()

    if hostname in _LOCAL_HOSTS:
        lan = _lan_ip()
        if lan:
            host = lan + (f":{hp.port}" if hp.port else "")
            scope = "lan"
        else:
            scope = "local"
    elif _is_private_host(hostname):
        scope = "lan"
    else:
        scope = "public"
    return f"{scheme}://{host}/share/{token}", scope


def _decorate(rec):
    """给记录补充前端好用的派生字段"""
    if not rec:
        return None
    rec = dict(rec)
    rec["url"] = "/share/" + rec.get("token", "")
    rec["full_url"] = _public_url(rec.get("token"))
    rec["state"] = share_state(rec)
    rec["size_str"] = _human_size(rec.get("size"))
    rec["created_str"] = _fmt_time(rec.get("created_at"))
    rec["expires_str"] = _fmt_time(rec.get("expires_at")) if rec.get("expires_at") else "永久有效"
    rec["last_view_str"] = _fmt_time(rec.get("last_view_at")) if rec.get("last_view_at") else "从未访问"
    return rec


def _parse_expires(body):
    """接受 expires_in（预设名 '1h'/'1d'/'7d'/'30d'/'forever' 或秒数）或 expires_at（时间戳）"""
    if body.get("expires_at") is not None:
        try:
            return max(0, int(body.get("expires_at") or 0))
        except (TypeError, ValueError):
            return 0
    preset = body.get("expires_in")
    if isinstance(preset, str) and preset in EXPIRE_PRESETS:
        secs = EXPIRE_PRESETS[preset]
        return (int(time.time()) + secs) if secs else 0
    try:
        secs = int(preset or 0)
    except (TypeError, ValueError):
        secs = 0
    return (int(time.time()) + secs) if secs > 0 else 0


def _error_page(message, status=404):
    return render_template("share.html", mode="error", message=message), status


# ============================ 管理接口（需登录） ============================
@bp.route("/api/share", methods=["POST"])
def api_create_share():
    """为文件创建分享；同路径已有分享时复用 token 并更新设置。"""
    _log.info("POST /api/share")
    body = request.get_json(silent=True) or {}
    path = os.path.abspath(body.get("path", ""))
    if not os.path.isfile(path):
        return jsonify({"error": "文件不存在"}), 404
    try:
        size = os.path.getsize(path)
    except OSError:
        size = 0
    try:
        max_views = max(0, int(body.get("max_views") or 0))
    except (TypeError, ValueError):
        max_views = 0
    rec = create_share(
        abs_path=path,
        name=os.path.basename(path),
        size=size,
        password=(body.get("password") or "").strip(),
        expires_at=_parse_expires(body),
        max_views=max_views,
        note=(body.get("note") or "").strip(),
    )
    return jsonify(_decorate(rec))


@bp.route("/api/shares")
def api_list_shares():
    """分享记录列表（含状态、访问量、有效期）。

    include_revoked=1 时连已取消（revoked）的记录一起返回，供「分享历史」查看。
    """
    _log.info("GET /api/shares include_revoked=%s", request.args.get("include_revoked", ""))
    include_revoked = _truthy(request.args.get("include_revoked", ""))
    items = [_decorate(r) for r in list_shares(include_revoked=include_revoked)]
    return jsonify({"items": items, "count": len(items)})


@bp.route("/api/share/update", methods=["POST"])
def api_update_share():
    """更新分享设置：延期 / 改密码 / 改次数上限 / 备注 / 启用停用 / 重置计数"""
    _log.info("POST /api/share/update")
    body = request.get_json(silent=True) or {}
    sid = body.get("id")
    if not sid:
        return jsonify({"error": "缺少 id"}), 400
    if not get_share(share_id=sid):
        return jsonify({"error": "分享记录不存在"}), 404
    kwargs = {}
    if "password" in body:
        kwargs["password"] = (body.get("password") or "").strip()
    if "expires_at" in body or "expires_in" in body:
        kwargs["expires_at"] = _parse_expires(body)
    if "max_views" in body:
        try:
            kwargs["max_views"] = max(0, int(body.get("max_views") or 0))
        except (TypeError, ValueError):
            kwargs["max_views"] = 0
    if "note" in body:
        kwargs["note"] = (body.get("note") or "").strip()
    if "revoked" in body:
        kwargs["revoked"] = bool(body.get("revoked"))
    if body.get("reset_views"):
        kwargs["reset_views"] = True
    rec = update_share(sid, **kwargs)
    return jsonify(_decorate(rec))


@bp.route("/api/share", methods=["DELETE"])
def api_delete_share():
    """删除分享记录（body 或 query 传 id / token）。

    soft=1 表示「取消分享」：只把链接置为失效（revoked=1）并保留记录进历史；
    不带 soft 则彻底删除该条记录。
    """
    _log.info("DELETE /api/share")
    body = request.get_json(silent=True) or {}
    sid = body.get("id") or request.args.get("id")
    token = body.get("token") or request.args.get("token")
    soft = _truthy(body.get("soft")) or _truthy(request.args.get("soft", ""))

    rec = None
    if sid:
        try:
            rec = get_share(share_id=int(sid))
        except (TypeError, ValueError):
            rec = None
    elif token:
        rec = get_share(token=token)
    if not rec:
        return jsonify({"error": "未找到分享记录"}), 404

    if soft:
        update_share(rec["id"], revoked=True)
        return jsonify({"success": True, "soft": True, "id": rec["id"]})

    if not delete_share(rec["id"]):
        return jsonify({"error": "未找到分享记录"}), 404
    return jsonify({"success": True})


# ============================ 公开访问 ============================
@bp.route("/share/<token>", methods=["GET", "POST"])
def view_share(token):
    """分享页：md/文本渲染、图片/视频/音频内嵌、其它类型提供下载。"""
    _log.info("GET /share/%s", token)
    rec = get_share_secret(token=token)
    state = share_state(rec)
    if state == "revoked":
        return _error_page("分享链接无效或已被删除")
    if state == "expired":
        return _error_page("分享链接已过期")
    if state == "exhausted":
        return _error_page("分享链接的访问次数已用完")

    need_pw = bool(rec.get("password_hash"))
    authed = (not need_pw) or bool(session.get("share_auth_" + token))
    err = ""
    if need_pw and not authed and request.method == "POST":
        if verify_password(token, request.form.get("password", "")):
            session["share_auth_" + token] = True
            authed = True
        else:
            err = "密码错误，请重试"
    if not authed:
        return render_template("share.html", mode="password", token=token,
                               file_name=rec.get("name", ""), error=err)

    path = rec.get("abs_path", "")
    if not os.path.isfile(path):
        return _error_page("分享的文件已不存在")

    if request.method == "GET":
        bump_view(token)
        rec = get_share_secret(token=token) or rec

    size = rec.get("size") or 0
    kind = _kind_of(path)
    info = {
        "name": rec.get("name") or os.path.basename(path),
        "size": size,
        "size_str": _human_size(size),
        "ext": (_ext_of(path) or "file").upper(),
        "kind": kind,
        "icon": _KIND_ICON.get(kind, "bi-file-earmark"),
        "created_str": _fmt_time(rec.get("created_at")),
        "expires_str": _fmt_time(rec.get("expires_at")) if rec.get("expires_at") else "永久有效",
        "views": int(rec.get("views") or 0),
        "max_views": int(rec.get("max_views") or 0),
    }
    text_preview = ""
    if kind in ("text", "markdown"):
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                text_preview = f.read(200000)
        except (OSError, PermissionError):
            text_preview = ""
    qr_link, qr_scope = _phone_target(token)
    return render_template("share.html", mode="view", token=token,
                           file=info, text_preview=text_preview,
                           raw_url=_signed_url(token, "raw"),
                           download_url=_signed_url(token, "download"),
                           cover_url=_signed_url(token, "cover"),
                           lyrics_url=_signed_url(token, "lyrics"),
                           qr_url=f"/share/{token}/qr",
                           qr_link=qr_link,
                           qr_scope=qr_scope)


@bp.route("/share/<token>/qr")
def share_qr(token):
    """分享链接的二维码（PNG）：给手机扫码直接打开分享页。

    二维码内容就是分享页地址本身（localhost 会自动换成局域网 IP），
    不带签名也不需要密码——与直接访问分享页等价。
    """
    _log.info("GET /share/%s/qr", token)
    if share_state(get_share_secret(token=token)) != "ok":
        return jsonify({"error": "分享无效或已失效"}), 403
    qr = qrcode.QRCode(
        version=None,
        error_correction=qrcode.constants.ERROR_CORRECT_M,
        box_size=10,
        border=2,
    )
    qr.add_data(_phone_target(token)[0])
    qr.make(fit=True)
    buf = io.BytesIO()
    qr.make_image(fill_color="#0f172a", back_color="#ffffff").save(buf, format="PNG")
    resp = FlaskResponse(buf.getvalue(), mimetype="image/png")
    resp.headers["Cache-Control"] = "no-store"
    return resp


@bp.route("/share/<token>/cover")
def share_cover(token):
    """音乐封面：同目录下的同名图片文件（找不到返回 404，前端回落图标）"""
    rec, err = _guard_share_action(token, "cover")
    if err:
        return err
    cover = _find_sibling(rec.get("abs_path", ""),
                          {"jpg", "jpeg", "png", "webp", "bmp", "gif"})
    if not cover:
        return jsonify({"error": "没有封面"}), 404
    mime, _ = mimetypes.guess_type(cover)
    resp = send_file(cover, mimetype=mime or "image/jpeg", conditional=True)
    resp.headers["Cache-Control"] = "private, max-age=300"
    return resp


@bp.route("/share/<token>/lyrics")
def share_lyrics(token):
    """音乐歌词：同目录下的同名 .lrc 文件（纯文本返回，找不到返回 404）"""
    rec, err = _guard_share_action(token, "lyrics")
    if err:
        return err
    lrc = _find_sibling(rec.get("abs_path", ""), {"lrc"})
    if not lrc:
        return jsonify({"error": "没有歌词"}), 404
    try:
        with open(lrc, "r", encoding="utf-8", errors="replace") as f:
            text = f.read()
    except (OSError, PermissionError):
        return jsonify({"error": "读取失败"}), 500
    resp = FlaskResponse(text, mimetype="text/plain; charset=utf-8")
    resp.headers["Cache-Control"] = "no-store"
    return resp


@bp.route("/share/<token>/raw")
def share_raw(token):
    """原始内容（供分享页内的 img / video / audio 引用）。

    必须带上分享页签发的时效签名，避免该直链被单独转发后长期可用。
    """
    if not _check_sig(token, "raw"):
        return jsonify({"error": "访问签名无效或已过期，请刷新分享页后重试"}), 403
    if not _check_same_origin():
        return jsonify({"error": "该地址仅允许从分享页内访问"}), 403
    rec = get_share_secret(token=token)
    if share_state(rec) != "ok":
        return jsonify({"error": "分享无效或已失效"}), 403
    if rec.get("password_hash") and not session.get("share_auth_" + token):
        return jsonify({"error": "需要访问密码"}), 403
    path = rec.get("abs_path", "")
    if not os.path.isfile(path):
        return jsonify({"error": "文件不存在"}), 404
    mime, _ = mimetypes.guess_type(rec.get("name") or path)
    resp = send_file(path, mimetype=mime or "application/octet-stream",
                     as_attachment=False, conditional=True)
    resp.headers["Cache-Control"] = "private, max-age=60"
    return resp


@bp.route("/share/<token>/download")
def share_download(token):
    """附件下载（同样需要分享页签发的时效签名）"""
    if not _check_sig(token, "download"):
        return jsonify({"error": "下载链接无效或已过期，请刷新分享页后重试"}), 403
    if not _check_same_origin():
        return jsonify({"error": "该地址仅允许从分享页内访问"}), 403
    rec = get_share_secret(token=token)
    if share_state(rec) != "ok":
        return jsonify({"error": "分享无效或已失效"}), 403
    if rec.get("password_hash") and not session.get("share_auth_" + token):
        return jsonify({"error": "需要访问密码"}), 403
    path = rec.get("abs_path", "")
    if not os.path.isfile(path):
        return jsonify({"error": "文件不存在"}), 404
    return send_file(path, as_attachment=True,
                     download_name=rec.get("name") or os.path.basename(path))

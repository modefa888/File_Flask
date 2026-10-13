"""实时协作编辑的 HTTP 接口与 WebSocket 通道。

REST（需登录的房主操作 + 公开加入）：
- POST   /api/collab/rooms           为当前文件创建/复用协作房间，返回 token 与邀请链接
- GET    /api/collab/rooms           列出进行中的协作房间
- DELETE /api/collab/rooms/<token>   停止房间（断开所有协作者）
- GET    /api/collab/<token>/qr      邀请链接二维码（PNG）
- GET    /api/shared/files           协作者专用：被分享文件清单 / 分享范围内目录（越权一律 403）

WebSocket（免登录，凭 token 即可加入，见 auth 公开路径 /ws/）：
- 连接 /ws/collab?token=..&name=..&color=..
- 服务端首帧下发 welcome（文本/版本/在线成员/你的 id）
- 客户端上行：op（编辑）、cursor（光标）、rename（改名）
- 服务端下行：op、cursor、presence（成员变更）、leave（有人离开）
"""

import io
import json
import threading
import time
import uuid

import qrcode
from flask import (
    Blueprint, request, jsonify, Response as FlaskResponse, current_app,
)

from ...services.ide.collab import (
    create_room, get_room, list_rooms, list_group, delete_room,
    apply_op, author_runs, color_for, _transform,
)
bp = Blueprint("collab", __name__)
_log = None  # 延迟到需要时取，避免循环导入


def _logf():
    global _log
    if _log is None:
        from ...log import get_logger
        _log = get_logger()
    return _log


# ----------------------------- REST -----------------------------
@bp.route("/api/collab/rooms", methods=["POST"])
def api_create_room():
    _logf().info("POST /api/collab/rooms")
    body = request.get_json(silent=True) or {}
    path = body.get("path") or ""
    if not path:
        return jsonify({"error": "缺少 path"}), 400
    import os
    path = os.path.abspath(path)
    if not os.path.isfile(path):
        return jsonify({"error": "文件不存在"}), 404
    # group：批量分享（勾选多个文件/文件夹一起共享）时共用一个组 id
    # 限制项（均可缺省=不限）：maxPeers 人数上限；allowedUsers 指定用户名单；
    # expiresIn 有效秒数。由 create_room 统一做类型清洗。
    room, token = create_room(
        path, name=os.path.basename(path), group=body.get("group"),
        max_peers=body.get("maxPeers"),
        allowed_users=body.get("allowedUsers"),
        expires_in=body.get("expiresIn"),
    )
    host = request.host_url.rstrip("/")
    # 指向 IDE 页：受邀者打开即进入编辑器并自动加入协作（首页 ?collab= 已做重定向兜底）
    url = f"{host}/ide?collab={token}"
    return jsonify({
        "token": token,
        "hostKey": room.host_key,
        "name": room.name,
        "peers": len(room.peers),
        "version": room.version,
    })


@bp.route("/api/collab/rooms", methods=["GET"])
def api_list_rooms():
    _logf().info("GET /api/collab/rooms")
    return jsonify({"items": list_rooms(), "count": len(list_rooms())})


@bp.route("/api/collab/share/<sid>")
def api_collab_share(sid):
    """解析分享 id：既可能是单个房间 token，也可能是一次批量分享的组 id。

    统一返回 {type, items:[{token,name,path,peers}]}，受邀者页据此渲染
    「被勾选的文件夹/文件列表」并逐个进入共同编辑。
    """
    _logf().info("GET /api/collab/share/%s", sid)
    room = get_room(sid)
    if room:
        item = dict(_share_item_info(room.path) or {})
        item.update({"token": room.token, "name": room.name, "path": room.path,
                     "peers": len(room.peers), "view": room.view})
        return jsonify({"type": "room", "items": [item]})
    items = list_group(sid)
    if items:
        out = []
        for it in items:
            o = dict(_share_item_info(it["path"]) or {})
            o.update({"token": it["token"], "name": it["name"], "path": it["path"],
                      "peers": it["peers"], "view": it.get("view", False)})
            out.append(o)
        return jsonify({"type": "group", "items": out})
    return jsonify({"error": "分享不存在或已结束"}), 404


@bp.route("/api/shared/files")
def api_shared_files():
    """协作者专用：只暴露「被分享的文件」，杜绝按任意路径越权读取。

    - ?share=<分享id>                被分享的文件清单（名称 / 是否目录 / 大小 / 修改时间 / token）
    - ?share=<分享id>&path=<绝对路径>  被分享目录范围内的某个目录列表

    访问范围严格限定在「该分享实际共享的路径」内：只有被共享的「目录」才允许浏览，
    其余任何路径（哪怕传入一个已知文件路径）一律 403。分享 id 既可以是单个房间
    token，也可以是一次批量分享的组 id；与其它协作接口一样凭 id 解析，不额外放宽。
    """
    import os
    from ...services.common.filecore import list_directory, format_size

    sid = (request.args.get("share") or "").strip()
    if not sid:
        return jsonify({"error": "缺少分享标识 share"}), 400
    rooms = _resolve_share_rooms(sid)
    if not rooms:
        return jsonify({"error": "分享不存在或已结束"}), 404

    # 仅「被分享的目录」可作为可浏览的根；被分享的单个文件不暴露其所在目录
    dir_roots = [os.path.abspath(r.path) for r in rooms
                 if r.path and os.path.isdir(r.path)]
    path = (request.args.get("path") or "").strip()

    # ① 清单模式：返回被分享的文件信息
    if not path:
        items = []
        for r in rooms:
            info = _share_item_info(r.path)
            if info is None:
                continue
            info.update({"token": r.token, "view": bool(getattr(r, "view", False)),
                         "peers": len(r.peers)})
            items.append(info)
        return jsonify({
            "type": "room" if get_room(sid) else "group",
            "share": sid, "roots": dir_roots, "items": items,
        })

    # ② 目录模式：只允许浏览「被分享目录」范围内的目录
    target = os.path.abspath(path)
    if not _within_any(target, dir_roots):
        _logf().warning("协作者请求分享范围外的路径，已拒绝: %s", target)
        return jsonify({"error": "仅允许访问被分享的文件目录"}), 403
    if not os.path.isdir(target):
        return jsonify({"error": "路径不存在或不是目录"}), 400

    items = list_directory(target, get_sizes=False, show_hidden=False)
    total_files = sum(1 for it in items if not it.get("is_dir"))
    total_dirs = sum(1 for it in items if it.get("is_dir"))
    total_size = sum(it["size"] for it in items if it.get("size", 0) >= 0)
    return jsonify({
        "current_path": target, "current_path_abs": target,
        "items": items, "total_items": len(items),
        "stats": {"total_files": total_files, "total_dirs": total_dirs,
                  "total_size": total_size, "total_size_str": format_size(total_size)},
        "roots": dir_roots,
    })


def _resolve_share_rooms(sid):
    """把分享 id（单个房间 token 或批量分享组 id）解析成房间对象列表。"""
    room = get_room(sid)
    if room:
        return [room]
    rooms = []
    for it in (list_group(sid) or []):
        r = get_room(it.get("token"))
        if r is not None:
            rooms.append(r)
    return rooms


def _share_item_info(path):
    """被分享条目的基本信息（文件不存在返回 None）。"""
    import os
    from datetime import datetime
    from ...services.common.filecore import format_size
    if not path:
        return None
    try:
        st = os.stat(path)
    except OSError:
        return None
    is_dir = os.path.isdir(path)
    return {
        "name": os.path.basename(path), "path": path, "is_dir": is_dir,
        "size": 0 if is_dir else st.st_size,
        "size_str": "" if is_dir else format_size(st.st_size),
        "mtime": datetime.fromtimestamp(st.st_mtime).strftime("%Y-%m-%d %H:%M:%S"),
    }


def _within_any(target, roots):
    """target 是否等于某个根目录或位于其下（限制协作者可浏览的范围）。"""
    import os
    t = os.path.abspath(target)
    for r in (roots or []):
        r = os.path.abspath(r)
        if t == r or t.startswith(r.rstrip(os.sep) + os.sep):
            return True
    return False


@bp.route("/api/collab/rooms/<token>", methods=["DELETE"])
def api_delete_room(token):
    _logf().info("DELETE /api/collab/rooms/%s", token)
    room = get_room(token)
    if not room:
        return jsonify({"error": "房间不存在"}), 404
    # 显式停止协作：立即通知所有协作者，再删除房间（不必等宽限期）
    _broadcast(room, {"type": "closed", "message": "房主已停止协作，邀请链接已失效"})
    if not delete_room(token):
        return jsonify({"error": "房间不存在"}), 404
    return jsonify({"success": True})


@bp.route("/api/collab/<token>/baseline")
def api_collab_baseline(token):
    """「分享前」的基线内容：房间创建时文件的最新内容（用于版本对比）。"""
    _logf().info("GET /api/collab/%s/baseline", token)
    room = get_room(token)
    if not room:
        return jsonify({"error": "房间不存在"}), 404
    return jsonify({
        "text": room.baseline if room.baseline is not None else "",
        "hasBaseline": room.baseline is not None,
        "path": room.path,
        "name": room.name,
        "version": room.version,
    })


@bp.route("/api/collab/<token>/authors")
def api_collab_authors(token):
    """改动归属。刷新 / 重新载入后据此重建：
      - chars: 只有「实际被改动的字符」加粗 + 作者色（不含原本就有的代码）
      - runs : 行级归属（行背景高亮 + 末尾作者标签）
    """
    _logf().info("GET /api/collab/%s/authors", token)
    room = get_room(token)
    if not room:
        return jsonify({"error": "房间不存在"}), 404
    with room.lock:
        chars, runs = author_runs(room)
        version = room.version
    return jsonify({"version": version, "chars": chars, "runs": runs})


@bp.route("/api/collab/<token>/raw")
def api_collab_raw(token):
    """仅查看文件的原始内容：图片/PDF/音视频内联预览，压缩包等下载。

    与 WebSocket 一样凭 token 即可访问（受邀者免登录查看被共享的文件）。
    ?dl=1 强制按附件下载。
    """
    _logf().info("GET /api/collab/%s/raw", token)
    room = get_room(token)
    if not room:
        return jsonify({"error": "房间不存在"}), 404
    import os
    if not os.path.isfile(room.path):
        return jsonify({"error": "文件不存在"}), 404
    from flask import send_file
    from urllib.parse import quote
    import mimetypes
    mt = mimetypes.guess_type(room.path)[0] or "application/octet-stream"
    resp = send_file(room.path, mimetype=mt, conditional=True)
    if request.args.get("dl"):
        fname = os.path.basename(room.path)
        resp.headers["Content-Disposition"] = "attachment; filename*=UTF-8''" + quote(fname)
    else:
        resp.headers["Content-Disposition"] = "inline"
    resp.headers["Cache-Control"] = "no-store"
    return resp


@bp.route("/api/collab/<token>/qr")
def api_collab_qr(token):
    _logf().info("GET /api/collab/%s/qr", token)
    if not get_room(token):
        return jsonify({"error": "房间不存在"}), 404
    from urllib.parse import urlparse
    host = request.host_url.rstrip("/")
    url = f"{host}/ide?collab={token}"
    qr = qrcode.QRCode(box_size=10, border=2,
                       error_correction=qrcode.constants.ERROR_CORRECT_M)
    qr.add_data(url)
    qr.make(fit=True)
    buf = io.BytesIO()
    qr.make_image(fill_color="#0f172a", back_color="#ffffff").save(buf, format="PNG")
    resp = FlaskResponse(buf.getvalue(), mimetype="image/png")
    resp.headers["Cache-Control"] = "no-store"
    return resp


# ----------------------------- WebSocket -----------------------------
def _broadcast(room, obj, except_sid=None):
    dead = []
    for sid, p in room.peers.items():
        if sid == except_sid:
            continue
        try:
            p["ws"].send(json.dumps(obj))
        except Exception:
            dead.append(sid)
    for sid in dead:
        room.peers.pop(sid, None)


# 房主断线宽限期：刷新页面 / 短暂掉线时不立刻销毁房间，留出重连窗口
_HOST_GRACE_SECONDS = 15.0


def _cancel_close_timer(room):
    """取消房间的待关闭定时器（调用方需持有 room.lock 或自行保证安全）。"""
    t = getattr(room, "close_timer", None)
    if t is not None:
        try:
            t.cancel()
        except Exception:
            pass
        room.close_timer = None


def _schedule_grace_close(room, old_sid):
    """房主断开：启动宽限期定时器，超时后若房主仍未回来才关闭房间。"""
    if get_room(room.token) is not room:      # 房间已被显式停止/替换：无需再调度
        return
    with room.lock:
        _cancel_close_timer(room)
        timer = threading.Timer(_HOST_GRACE_SECONDS, _grace_close, args=(room, old_sid))
        timer.daemon = True
        room.close_timer = timer
    timer.start()


def _grace_close(room, old_sid):
    """宽限期到点：房主已重连则保留房间，否则通知并删除。"""
    with room.lock:
        room.close_timer = None
        host = room.host_sid
        # 房主已在宽限期内重连（新的在线连接认领了房主身份）→ 保留房间
        if host and host in room.peers:
            return
    _broadcast(room, {"type": "closed",
                      "message": "房主已退出，协作已结束，邀请链接已失效"})
    delete_room(room.token)


def register_collab_ws(sock):
    """把 WebSocket 处理器挂到 Sock 实例上（在 create_app 里调用）。"""

    @sock.route("/ws/collab")
    def _ws(ws):
        from flask import request as _req
        token = (_req.args.get("token") or "").strip()
        name = (_req.args.get("name") or "").strip() or ("协作者" + str(uuid.uuid4())[:4])
        # 颜色只由昵称决定（同一个人刷新 / 换页面颜色都不变），客户端传来的随机色不采用
        color = color_for(name)

        room = get_room(token)
        if not room:
            try:
                ws.send(json.dumps({"type": "error", "message": "房间不存在或已结束"}))
            except Exception:
                pass
            return

        sid = uuid.uuid4().hex
        host_key = (_req.args.get("host") or "").strip()
        # 房主凭密钥不受「指定用户 / 人数上限」约束（本来就要能回到自己的房间）
        _is_host_key = bool(host_key and room.host_key and host_key == room.host_key)
        # 限制校验：有效期 → 指定用户 → 人数上限（校验失败直接拒之门外）
        if room.expires_at and time.time() > room.expires_at:
            try:
                ws.send(json.dumps({"type": "error", "message": "邀请已过期，该协作已自动结束"}))
            except Exception:
                pass
            _broadcast(room, {"type": "closed", "message": "协作已超过有效时间，自动结束"})
            delete_room(room.token)
            return
        if room.allowed_users and not _is_host_key and name not in room.allowed_users:
            try:
                ws.send(json.dumps({"type": "error",
                                    "message": "房主限制了可加入的用户，你不在允许名单中"}))
            except Exception:
                pass
            return
        with room.lock:
            _full = bool(room.max_peers and not _is_host_key and len(room.peers) >= room.max_peers)
        if _full:
            try:
                ws.send(json.dumps({"type": "error",
                                    "message": "协作人数已满（上限 " + str(room.max_peers) + " 人）"}))
            except Exception:
                pass
            return
        with room.lock:
            # 房主身份只认密钥（创建房间时下发给创建者），访客抢先加入
            # 也绝不会被标成房主，房主身份不可被"转换"
            if host_key and room.host_key and host_key == room.host_key:
                room.host_sid = sid
                _cancel_close_timer(room)    # 房主在宽限期内重连：取消待关闭
            elif room.host_key is None and room.host_sid is None:
                room.host_sid = sid          # 旧数据兼容：无密钥房间保持先到先得
                _cancel_close_timer(room)
            room.peers[sid] = {"id": sid, "name": name, "color": color, "ws": ws,
                               "viewer": bool(room.view)}   # 仅查看房间的成员只是观看者

        # 首帧：把当前权威文本、版本、在线成员发给新成员
        def _send_welcome():
            ws.send(json.dumps({
                "type": "welcome",
                "yourId": sid,
                "version": room.version,
                "host": (room.host_sid == sid),
                "text": room.text,
                "path": room.path,
                "name": room.name,
                "view": room.view,
                "peers": room.peers_list(skip_sid=sid),
            }))

        try:
            _send_welcome()
        except Exception:
            room.peers.pop(sid, None)
            return
        _broadcast(room, {"type": "presence", "peers": room.peers_list()}, except_sid=None)

        try:
            while True:
                raw = ws.receive()
                if raw is None:
                    break
                try:
                    msg = json.loads(raw)
                except (ValueError, TypeError):
                    continue
                mtype = msg.get("type")

                if mtype == "op":
                    if room.view:
                        continue       # 仅查看房间（二进制等）：不接受任何编辑操作
                    base = int(msg.get("base", room.version))
                    ops = msg.get("ops") or []
                    if not isinstance(ops, list):
                        continue
                    peer = room.peers.get(sid) or {}
                    applied = apply_op(room, base, ops, author=sid,
                                       author_name=peer.get("name"),
                                       author_color=peer.get("color"))
                    for a in applied:
                        _broadcast(room, {
                            "type": "op",
                            "from": a["from"], "to": a["to"], "text": a["text"],
                            "version": a["version"], "by": sid, "id": a.get("id"),
                        }, except_sid=None)

                elif mtype == "cursor":
                    # 光标位置基于发送方的 base 版本生成；转发前先对 log[base:]
                    # 里的历史操作做 OT 变换，避免并发编辑时远端光标漂移错位
                    base = int(msg.get("base", room.version))
                    f = int(msg.get("from", 0) or 0)
                    t = int(msg.get("to", 0) or 0)
                    with room.lock:
                        base = max(0, min(base, room.version))
                        for past in room.log[base:]:
                            if past.get("by") == sid:
                                continue        # 自己的编辑本地已生效，再折算会双重偏移
                            shifted = _transform({"from": f, "to": t, "text": ""}, past)
                            f, t = shifted["from"], shifted["to"]
                    _broadcast(room, {
                        "type": "cursor",
                        "from": f, "to": t,
                        "id": sid, "name": name, "color": color,
                    }, except_sid=sid)

                elif mtype == "rename":
                    nm = (msg.get("name") or "").strip() or name
                    with room.lock:
                        if sid in room.peers:
                            room.peers[sid]["name"] = nm
                    _broadcast(room, {"type": "presence", "peers": room.peers_list()}, except_sid=None)

                elif mtype == "resync":
                    # 客户端检测到「在途本地操作」与远端操作冲突（本地文本与
                    # 服务端权威文本短暂分叉），重新下发权威文本消除分叉。
                    # 同一 WS 内消息按序处理，此时该客户端此前上报的 op 均
                    # 已应用并回显，welcome 里的文本必然包含它们。
                    try:
                        _send_welcome()
                    except Exception:
                        break

                elif mtype == "ping":
                    try:
                        ws.send(json.dumps({"type": "pong", "t": time.time()}))
                    except Exception:
                        break
        except Exception as e:
            _logf().warning("协作 WebSocket 异常: %s", e)
        finally:
            is_host = False
            with room.lock:
                room.peers.pop(sid, None)
                is_host = (sid == room.host_sid)
            if is_host:
                # 房主断线（含刷新页面）：不立即销毁房间，先给一个宽限期，
                # 期间房主凭密钥重连即恢复；超时仍未回来才广播 closed 并删除。
                _broadcast(room, {"type": "presence", "peers": room.peers_list()})
                _schedule_grace_close(room, sid)
            else:
                _broadcast(room, {"type": "leave", "id": sid}, except_sid=None)
                _broadcast(room, {"type": "presence", "peers": room.peers_list()}, except_sid=None)

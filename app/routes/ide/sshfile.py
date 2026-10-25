"""SSH 远程文件管理：通过 paramiko SFTP 浏览 / 编辑远程主机文件系统。

POST /api/ssh/fs/list      {id, path?, hidden?}   列目录（含大小 / mtime / 权限 / uid / gid）
POST /api/ssh/fs/read      {id, path, max?}       读文本文件（默认 512KB，二进制探测）
POST /api/ssh/fs/write     {id, path, content}    写回文本文件（≤4MB，编辑器保存用）
POST /api/ssh/fs/mkdir     {id, path}
POST /api/ssh/fs/rename    {id, path, name}
POST /api/ssh/fs/copy      {id, path, to}         复制文件 / 文件夹到目标目录（to=目标目录绝对路径）
POST /api/ssh/fs/move      {id, path, to}         移动文件 / 文件夹到目标目录（跨文件系统自动降级为复制+删除）
POST /api/ssh/fs/delete    {id, path}             递归删除（文件 / 目录）
GET  /api/ssh/fs/download  ?id=&path=             流式下载（attachment）
GET  /api/ssh/fs/raw       ?id=&path=             原始字节（内嵌图片缩略图用，≤20MB）
GET  /api/ssh/fs/stream    ?id=&path=             音视频流（支持 Range，可拖动进度）
POST /api/ssh/fs/size      {id, path}             递归统计目录占用（条目 / 耗时都有上限）
POST /api/ssh/fs/upload    multipart: id, path(目标目录), file

连接复用 sshconn 的存储（.ssh_connections.json，密码 / 私钥 secret 加密）。
SFTP 客户端按连接 id 缓存（默认 15 分钟 TTL，惰性清理），请求出错自动重建一次。
"""
import mimetypes
import os
import re
import stat as _stat
import threading
import time
from datetime import datetime
from urllib.parse import quote

from flask import Blueprint, Response, jsonify, request, stream_with_context

from ...log import get_logger
from ...services.common.filecore import format_size
from .sshconn import _connect, _get_conn, _ssh_err

_log = get_logger()
bp = Blueprint("sshfile", __name__)

try:
    import paramiko
    _PARAMIKO_OK = True
except Exception:  # noqa: BLE001
    _PARAMIKO_OK = False

_READ_MAX = 512 * 1024            # fs/read 默认上限
_WRITE_MAX = 4 * 1024 * 1024      # fs/write 上限
_RAW_MAX = 20 * 1024 * 1024       # fs/raw（缩略图 / 内嵌）上限
_SFTP_TTL = 15 * 60               # SFTP 客户端缓存时长
_SFTP_TIMEOUT = 15                # SFTP 通道操作超时（秒）：防止连接被静默断开后永久阻塞

_SFTP_LOCK = threading.Lock()
_SFTP = {}                        # cid -> {"client": SSHClient, "sftp": SFTPClient, "ts": float}


def _close_ent(ent):
    """关闭一个缓存条目的 sftp / client（不持锁，由调用方先从 _SFTP 移除）。"""
    if not ent:
        return
    try:
        ent["sftp"].close()
    except Exception:  # noqa: BLE001
        pass
    try:
        ent["client"].close()
    except Exception:  # noqa: BLE001
        pass


def _drop(cid):
    """丢弃某连接的 SFTP 缓存并关闭底层 client。"""
    with _SFTP_LOCK:
        ent = _SFTP.pop(cid, None)
    _close_ent(ent)


def _purge_expired():
    now = time.time()
    stale = [cid for cid, e in _SFTP.items() if now - e["ts"] > _SFTP_TTL]
    for cid in stale:
        _close_ent(_SFTP.pop(cid, None))   # 注意：调用方已持锁，这里绝不能再走 _drop()


def _sftp_for(cid):
    """取（或建立）某连接的 SFTP 客户端。返回 (sftp, client)。"""
    with _SFTP_LOCK:
        _purge_expired()
        ent = _SFTP.get(cid)
        if ent:
            try:
                ent["sftp"].stat(".")          # 探活：连接被远端断开时抛异常走重建
                ent["ts"] = time.time()
                return ent["sftp"], ent["client"]
            except Exception:  # noqa: BLE001
                _SFTP.pop(cid, None)
                _close_ent(ent)
    if not _PARAMIKO_OK:
        raise RuntimeError("后端未安装 paramiko，无法访问远程文件（pip install paramiko）")
    conn = _get_conn(cid)
    if not conn:
        raise RuntimeError("连接不存在")
    client = _connect(conn)
    try:
        try:
            client.get_transport().set_keepalive(30)   # 防 NAT / 云防火墙静默断开空闲连接
        except Exception:  # noqa: BLE001
            pass
        sftp = client.open_sftp()
        try:
            ch = sftp.get_channel()
            if ch:
                ch.settimeout(_SFTP_TIMEOUT)           # 无超时的 SFTP 操作在半死连接上会永久阻塞
        except Exception:  # noqa: BLE001
            pass
    except Exception:  # noqa: BLE001
        client.close()
        raise
    with _SFTP_LOCK:
        _SFTP[cid] = {"client": client, "sftp": sftp, "ts": time.time()}
    return sftp, client


def _run(cid, fn):
    """执行一次 SFTP 操作；失败（连接断开等）重建客户端后重试一次。

    统一返回 (result, error)：成功时 error 为 None，失败时 result 为 None。
    """
    last = None
    for attempt in (0, 1):
        try:
            sftp, _client = _sftp_for(cid)
            return fn(sftp), None
        except RuntimeError as e:
            return None, str(e)
        except Exception as e:  # noqa: BLE001
            last = e
            _drop(cid)
    return None, (_ssh_err(last) if last else "未知错误")


def _attr_item(a):
    """SFTPAttributes → 前端条目（与本地 /api/files 的字段尽量对齐）。"""
    mode = a.st_mode or 0
    is_dir = _stat.S_ISDIR(mode)
    is_link = _stat.S_ISLNK(mode)
    size = 0 if is_dir else (a.st_size or 0)
    return {
        "name": a.filename,
        "is_dir": is_dir,
        "is_link": is_link,
        "size": size,
        "size_str": "" if is_dir else format_size(size),
        "mtime": datetime.fromtimestamp(a.st_mtime or 0).strftime("%Y-%m-%d %H:%M:%S") if a.st_mtime else "",
        "perm": _stat.filemode(mode) if mode else "",
        "uid": a.st_uid,
        "gid": a.st_gid,
        "type": "目录" if is_dir else "文件",
    }


# --------------------------------------------------------------------------
# 端点
# --------------------------------------------------------------------------

@bp.route("/api/ssh/fs/list", methods=["POST"])
def fs_list():
    data = request.get_json(silent=True) or {}
    cid = data.get("id")
    if not cid:
        return jsonify({"error": "缺少连接 id"}), 400
    path = data.get("path") or "."
    hidden = bool(data.get("hidden"))
    if not _PARAMIKO_OK:
        return jsonify({"error": "后端未安装 paramiko，无法访问远程文件"}), 400

    def op(sftp):
        home = sftp.normalize(".")
        real = sftp.normalize(path)
        items = []
        for a in sftp.listdir_attr(real):
            if not hidden and a.filename.startswith("."):
                continue
            items.append(_attr_item(a))
        items.sort(key=lambda x: (not x["is_dir"], x["name"].lower()))
        return {"path": real, "home": home, "items": items}

    res, err = _run(cid, op)
    if err:
        return jsonify({"error": err}), 400
    return jsonify({
        "current_path_abs": res["path"],
        "home": res["home"],
        "items": res["items"],
        "stats": {
            "total_dirs": sum(1 for i in res["items"] if i["is_dir"]),
            "total_files": sum(1 for i in res["items"] if not i["is_dir"]),
        },
    })


@bp.route("/api/ssh/fs/stat", methods=["POST"])
def fs_stat():
    """单路径探测：存在性 / 是否目录 / 大小（上传覆盖确认用）。"""
    data = request.get_json(silent=True) or {}
    cid, path = data.get("id"), data.get("path")
    if not cid or not path:
        return jsonify({"error": "缺少 id 或 path"}), 400

    def op(sftp):
        real = sftp.normalize(path)
        try:
            st = sftp.stat(real)
            return {"exists": True, "is_dir": _stat.S_ISDIR(st.st_mode),
                    "size": st.st_size or 0, "path": real}
        except IOError:
            return {"exists": False, "path": real}

    res, err = _run(cid, op)
    if err:
        return jsonify({"error": err}), 400
    return jsonify(res)


@bp.route("/api/ssh/fs/read", methods=["POST"])
def fs_read():
    data = request.get_json(silent=True) or {}
    cid, path = data.get("id"), data.get("path")
    if not cid or not path:
        return jsonify({"error": "缺少 id 或 path"}), 400
    try:
        limit = min(int(data.get("max") or _READ_MAX), 8 * 1024 * 1024)
    except (TypeError, ValueError):
        limit = _READ_MAX

    def op(sftp):
        real = sftp.normalize(path)
        st = sftp.stat(real)
        if _stat.S_ISDIR(st.st_mode):
            return {"dir": True, "path": real}
        parts, total, truncated = [], 0, False
        with sftp.open(real, "rb") as f:
            while total < limit:
                chunk = f.read(min(65536, limit - total))
                if not chunk:
                    break
                parts.append(chunk)
                total += len(chunk)
            if f.read(1):                      # 还有剩余 → 标记截断
                truncated = True
        blob = b"".join(parts)
        binary = b"\x00" in blob[:8000]
        return {"dir": False, "path": real, "size": st.st_size or total,
                "binary": binary, "content": None if binary else blob.decode("utf-8", "replace"),
                "truncated": truncated}

    res, err = _run(cid, op)
    if err:
        return jsonify({"error": err}), 400
    if res.get("dir"):
        return jsonify({"error": "目标是目录，不是文件"}), 400
    return jsonify(res)


@bp.route("/api/ssh/fs/write", methods=["POST"])
def fs_write():
    data = request.get_json(silent=True) or {}
    cid, path = data.get("id"), data.get("path")
    content = data.get("content")
    if not cid or not path or content is None:
        return jsonify({"error": "缺少 id / path / content"}), 400
    blob = content.encode("utf-8", "replace")
    if len(blob) > _WRITE_MAX:
        return jsonify({"error": "内容超过 4MB，请改用终端或上传方式"}), 400

    def op(sftp):
        real = sftp.normalize(path)
        with sftp.open(real, "wb") as f:
            f.write(blob)
        return {"path": real, "size": len(blob)}

    res, err = _run(cid, op)
    if err:
        return jsonify({"error": err}), 400
    _log.info("ssh fs write: cid=%s path=%s size=%d", cid, res["path"], res["size"])
    return jsonify(res)


@bp.route("/api/ssh/fs/mkdir", methods=["POST"])
def fs_mkdir():
    data = request.get_json(silent=True) or {}
    cid, path = data.get("id"), data.get("path")
    if not cid or not path:
        return jsonify({"error": "缺少 id 或 path"}), 400
    recursive = bool(data.get("recursive"))

    def _mkdirs(sftp, target):
        """逐级创建缺失的目录段（拖拽上传文件夹时保持结构用）。"""
        parts = [p for p in target.split("/") if p and p != "."]
        cur = ""
        for p in parts:
            cur += "/" + p
            try:
                st = sftp.stat(cur)
                if not _stat.S_ISDIR(st.st_mode):
                    raise ValueError("路径存在但不是目录: " + cur)
            except IOError:
                sftp.mkdir(cur)
        return sftp.normalize(target)

    def op(sftp):
        if recursive:
            real = _mkdirs(sftp, path)
        else:
            sftp.mkdir(path)
            real = sftp.normalize(path)
        return {"path": real}

    res, err = _run(cid, op)
    if err:
        return jsonify({"error": err}), 400
    return jsonify(res)


@bp.route("/api/ssh/fs/rename", methods=["POST"])
def fs_rename():
    data = request.get_json(silent=True) or {}
    cid, path, name = data.get("id"), data.get("path"), (data.get("name") or "").strip()
    if not cid or not path or not name or "/" in name or name in (".", ".."):
        return jsonify({"error": "参数不合法"}), 400

    def op(sftp):
        dst = path.rstrip("/") + "/" + name
        try:
            sftp.posix_rename(path, dst)
        except (AttributeError, IOError):
            sftp.rename(path, dst)
        return {"path": sftp.normalize(dst)}

    res, err = _run(cid, op)
    if err:
        return jsonify({"error": err}), 400
    return jsonify(res)


@bp.route("/api/ssh/fs/delete", methods=["POST"])
def fs_delete():
    data = request.get_json(silent=True) or {}
    cid, path = data.get("id"), data.get("path")
    if not cid or not path:
        return jsonify({"error": "缺少 id 或 path"}), 400

    def op(sftp):
        real = sftp.normalize(path)
        if real == "/":
            raise ValueError("拒绝删除根目录")
        _ssh_rm(sftp, real)
        return {"path": real}

    res, err = _run(cid, op)
    if err:
        return jsonify({"error": err}), 400
    _log.info("ssh fs delete: cid=%s path=%s", cid, res["path"])
    return jsonify(res)


def _ssh_rm(sftp, p):
    """递归删除（fs/delete 与跨文件系统 move 共用）。"""
    st = sftp.lstat(p)
    if _stat.S_ISDIR(st.st_mode):
        for name in sftp.listdir(p):
            _ssh_rm(sftp, p.rstrip("/") + "/" + name)
        sftp.rmdir(p)
    else:
        sftp.remove(p)


def _ssh_exists(sftp, p):
    try:
        sftp.stat(p)
        return True
    except IOError:
        return False


def _ssh_copy(sftp, src, dst):
    """递归复制：文件流式读写，目录逐级创建（symlink 跟随指向的目标）。"""
    st = sftp.stat(src)
    if _stat.S_ISDIR(st.st_mode):
        if _ssh_exists(sftp, dst):
            dst_st = sftp.stat(dst)
            if not _stat.S_ISDIR(dst_st.st_mode):
                raise ValueError("目标已存在且不是目录: " + dst)
        else:
            sftp.mkdir(dst)
        for name in sftp.listdir(src):
            _ssh_copy(sftp, src.rstrip("/") + "/" + name, dst.rstrip("/") + "/" + name)
        return
    with sftp.open(src, "rb") as fi, sftp.open(dst, "wb") as fo:
        while True:
            chunk = fi.read(64 * 1024)
            if not chunk:
                break
            fo.write(chunk)


def _ssh_check_transfer(sftp, src, dst_dir):
    """copy / move 共用的前置校验：返回 (源绝对路径, 目标绝对路径)。"""
    src = sftp.normalize(src)
    dst_dir = sftp.normalize(dst_dir)
    dst_dir_st = sftp.stat(dst_dir)          # 目标目录必须存在且是目录
    if not _stat.S_ISDIR(dst_dir_st.st_mode):
        raise ValueError("目标不是目录: " + dst_dir)
    st = sftp.stat(src)
    if _stat.S_ISDIR(st.st_mode):
        inside = dst_dir == src or dst_dir.startswith(src.rstrip("/") + "/")
        if inside:
            raise ValueError("不能把文件夹移动/复制到它自身内部")
    name = src.rstrip("/").split("/")[-1]
    return src, dst_dir.rstrip("/") + "/" + name


@bp.route("/api/ssh/fs/copy", methods=["POST"])
def fs_copy():
    data = request.get_json(silent=True) or {}
    cid, path, to = data.get("id"), data.get("path"), (data.get("to") or "").strip()
    if not cid or not path or not to:
        return jsonify({"error": "缺少 id / path / to"}), 400

    def op(sftp):
        src, dst = _ssh_check_transfer(sftp, path, to)
        if _ssh_exists(sftp, dst):
            raise ValueError("目标已存在: " + dst)
        _ssh_copy(sftp, src, dst)
        return {"path": sftp.normalize(dst)}

    res, err = _run(cid, op)
    if err:
        return jsonify({"error": err}), 400
    _log.info("ssh fs copy: cid=%s %s -> %s", cid, path, res["path"])
    return jsonify(res)


@bp.route("/api/ssh/fs/move", methods=["POST"])
def fs_move():
    data = request.get_json(silent=True) or {}
    cid, path, to = data.get("id"), data.get("path"), (data.get("to") or "").strip()
    if not cid or not path or not to:
        return jsonify({"error": "缺少 id / path / to"}), 400

    def op(sftp):
        src, dst = _ssh_check_transfer(sftp, path, to)
        if _ssh_exists(sftp, dst):
            raise ValueError("目标已存在: " + dst)
        try:
            sftp.posix_rename(src, dst)      # 同一文件系统：原子改名，瞬间完成
        except (AttributeError, IOError):
            try:
                sftp.rename(src, dst)
            except IOError:                  # 跨文件系统：复制后删源
                _ssh_copy(sftp, src, dst)
                _ssh_rm(sftp, src)
        return {"path": sftp.normalize(dst)}

    res, err = _run(cid, op)
    if err:
        return jsonify({"error": err}), 400
    _log.info("ssh fs move: cid=%s %s -> %s", cid, path, res["path"])
    return jsonify(res)


def _stream_response(sftp, real, download_name, inline, max_bytes=0):
    """把一个远程文件以流式响应送出（下载 / 内嵌预览共用）。"""
    f = sftp.open(real, "rb")
    ext = os.path.splitext(download_name)[1].lower()
    mime = mimetypes.guess_type(download_name)[0] or ("image/svg+xml" if ext == ".svg" else "application/octet-stream")

    def gen():
        try:
            left = max_bytes
            while True:
                n = 64 * 1024 if not max_bytes else min(64 * 1024, left)
                if n <= 0:
                    break
                chunk = f.read(n)
                if not chunk:
                    break
                if max_bytes:
                    left -= len(chunk)
                yield chunk
        finally:
            try:
                f.close()
            except Exception:  # noqa: BLE001
                pass

    headers = {"Content-Disposition": ("%s; filename*=UTF-8''%s" % ("inline" if inline else "attachment", quote(download_name)))}
    return Response(stream_with_context(gen()), mimetype=mime, headers=headers)


@bp.route("/api/ssh/fs/download", methods=["GET"])
def fs_download():
    cid = request.args.get("id", "")
    path = request.args.get("path", "")
    if not cid or not path:
        return jsonify({"error": "缺少 id 或 path"}), 400
    name = os.path.basename(path.rstrip("/")) or "download"
    try:
        sftp, _client = _sftp_for(cid)
        real = sftp.normalize(path)
        return _stream_response(sftp, real, name, inline=False)
    except Exception as e:  # noqa: BLE001
        _drop(cid)
        return jsonify({"error": _ssh_err(e)}), 400


@bp.route("/api/ssh/fs/raw", methods=["GET"])
def fs_raw():
    cid = request.args.get("id", "")
    path = request.args.get("path", "")
    if not cid or not path:
        return jsonify({"error": "缺少 id 或 path"}), 400
    name = os.path.basename(path.rstrip("/")) or "file"
    try:
        sftp, _client = _sftp_for(cid)
        real = sftp.normalize(path)
        return _stream_response(sftp, real, name, inline=True, max_bytes=_RAW_MAX)
    except Exception as e:  # noqa: BLE001
        _drop(cid)
        return jsonify({"error": _ssh_err(e)}), 400


def _parse_range(hdr, size):
    """解析单区间 Range 头：返回 (start, end)；"bad"=区间非法；None=不处理（按全量返回）。
    支持 bytes=a-b / bytes=a- / bytes=-n（后缀区间，mp4 找 moov 时浏览器会这么请求）。"""
    m = re.match(r"^\s*bytes=(\d*)-(\d*)\s*$", hdr or "")
    if not m:
        return None
    a, b = m.group(1), m.group(2)
    if not a and not b:
        return None
    if not a:                                   # bytes=-n：最后 n 字节
        try:
            n = int(b)
        except ValueError:
            return "bad"
        if n <= 0 or size <= 0:
            return "bad"
        return (max(0, size - n), size - 1)
    try:
        start = int(a)
        end = int(b) if b else size - 1
    except ValueError:
        return "bad"
    end = min(end, size - 1)
    if start >= size or start > end:
        return "bad"
    return (start, end)


@bp.route("/api/ssh/fs/stream", methods=["GET"])
def fs_stream():
    """远程音视频流：支持 HTTP Range，可暂停 / 拖进度 / 边下边播。

    每次播放单独建一条 SSH 连接（不占用文件管理器共用的 SFTP 通道），
    响应结束（或浏览器中断）时关了它。"""
    cid = request.args.get("id", "")
    path = request.args.get("path", "")
    if not cid or not path:
        return jsonify({"error": "缺少 id 或 path"}), 400
    if not _PARAMIKO_OK:
        return jsonify({"error": "后端未安装 paramiko，无法访问远程文件"}), 400
    conn = _get_conn(cid)
    if not conn:
        return jsonify({"error": "连接不存在"}), 400

    name = os.path.basename(path.rstrip("/")) or "file"
    mime = mimetypes.guess_type(name)[0] or "application/octet-stream"
    client = sftp = None
    try:
        client = _connect(conn)
        try:
            client.get_transport().set_keepalive(30)
        except Exception:  # noqa: BLE001
            pass
        sftp = client.open_sftp()
        real = sftp.normalize(path)
        size = int(sftp.stat(real).st_size or 0)
    except Exception as e:  # noqa: BLE001
        for x in (sftp, client):
            try:
                if x:
                    x.close()
            except Exception:  # noqa: BLE001
                pass
        return jsonify({"error": _ssh_err(e)}), 400

    state = {"closed": False}

    def cleanup():
        if state["closed"]:
            return
        state["closed"] = True
        for x in (sftp, client):
            try:
                x.close()
            except Exception:  # noqa: BLE001
                pass

    rng = _parse_range(request.headers.get("Range"), size)
    if rng == "bad":
        cleanup()
        resp = Response(status=416)
        resp.headers["Content-Range"] = "bytes */%d" % size
        resp.headers["Accept-Ranges"] = "bytes"
        return resp
    start, end = rng if rng else (0, size - 1)
    length = max(0, end - start + 1)
    status = 206 if rng else 200

    def gen():
        f = None
        try:
            f = sftp.open(real, "rb")
            f.seek(start)                        # SFTP 支持随机读，拖动进度直接定位
            left = length
            while left > 0:
                chunk = f.read(min(512 * 1024, left))
                if not chunk:
                    break
                left -= len(chunk)
                yield chunk
        except Exception as e:  # noqa: BLE001
            _log.warning("ssh stream interrupted: cid=%s path=%s %s", cid, real, e)
        finally:
            try:
                if f:
                    f.close()
            except Exception:  # noqa: BLE001
                pass
            cleanup()

    headers = {
        "Accept-Ranges": "bytes",
        "Content-Length": str(length),
        "Cache-Control": "no-store",
    }
    if status == 206:
        headers["Content-Range"] = "bytes %d-%d/%d" % (start, end, size)
    resp = Response(stream_with_context(gen()), status=status, mimetype=mime, headers=headers)
    resp.call_on_close(cleanup)                  # 生成器没跑起来（如 HEAD）也不会漏连接
    return resp


_SCAN_MAX_ENTRIES = 200000         # 目录统计最多扫多少条目
_SCAN_MAX_SECONDS = 25.0           # 目录统计最长耗时（秒）


@bp.route("/api/ssh/fs/size", methods=["POST"])
def fs_size():
    """递归统计远程目录的占用大小与文件 / 子目录数量（属性面板用）。

    大目录可能很慢：超过 20 万条目或 25 秒就提前收工，返回 truncated=True，
    前端据此标注「结果为部分统计」，避免一次点击把 SFTP 通道占死。"""
    data = request.get_json(silent=True) or {}
    cid, path = data.get("id"), data.get("path")
    if not cid or not path:
        return jsonify({"error": "缺少 id 或 path"}), 400

    def op(sftp):
        real = sftp.normalize(path)
        st = sftp.stat(real)
        if not _stat.S_ISDIR(st.st_mode):
            size = int(st.st_size or 0)
            return {"path": real, "is_dir": False, "size": size,
                    "files": 1, "dirs": 0, "truncated": False}
        total = files = dirs = 0
        truncated = False
        deadline = time.time() + _SCAN_MAX_SECONDS
        stack = [real]
        while stack:
            cur = stack.pop()
            try:
                entries = sftp.listdir_attr(cur)
            except IOError:
                continue                        # 没权限 / 中途被删：跳过这一层
            for a in entries:
                mode = a.st_mode or 0
                if _stat.S_ISDIR(mode):
                    dirs += 1
                    stack.append(cur.rstrip("/") + "/" + a.filename)
                else:
                    files += 1
                    total += int(a.st_size or 0)
                if files + dirs >= _SCAN_MAX_ENTRIES or time.time() > deadline:
                    truncated = True
                    break
            if truncated:
                break
        return {"path": real, "is_dir": True, "size": total,
                "files": files, "dirs": dirs, "truncated": truncated}

    res, err = _run(cid, op)
    if err:
        return jsonify({"error": err}), 400
    res["size_str"] = format_size(res["size"])
    return jsonify(res)


@bp.route("/api/ssh/fs/upload", methods=["POST"])
def fs_upload():
    cid = request.form.get("id", "")
    dir_path = request.form.get("path", "")
    f = request.files.get("file")
    if not cid or not dir_path or f is None:
        return jsonify({"error": "缺少 id / path / file"}), 400
    name = os.path.basename(f.filename or "upload.bin")

    def op(sftp):
        dst = sftp.normalize(dir_path).rstrip("/") + "/" + name
        with sftp.open(dst, "wb") as out:
            while True:
                chunk = f.stream.read(64 * 1024)
                if not chunk:
                    break
                out.write(chunk)
        return {"path": dst, "size": f.content_length or 0}

    res, err = _run(cid, op)
    if err:
        return jsonify({"error": err}), 400
    _log.info("ssh fs upload: cid=%s path=%s", cid, res["path"])
    return jsonify(res)

"""下载中心接口（编辑器区域「下载中心」标签页）。

端点一览
--------
GET  /api/dl/browse?path=&hidden=     可视化浏览服务器目录（选文件 / 选目录）
POST /api/dl/mkdir                    在浏览到的目录里新建文件夹
GET  /api/dl/tasks?q=&status=&page=   任务 / 记录列表（含汇总）
POST /api/dl/tasks                    新建下载任务（多文件、文件夹、文本）
GET  /api/dl/tasks/<id>               单个任务
POST /api/dl/tasks/<id>/action        操作：start / pause / cancel / retry / delete / reset
POST /api/dl/progress                 前端回报断点续传游标
GET  /api/dl/stream/<id>              下发产物（支持 Range → 206，可断点续传）
GET  /api/dl/settings                 模块设置
POST /api/dl/settings                 保存设置
GET  /api/dl/usage                    产物目录占用 / 记录条数
POST /api/dl/clean                    清理产物或记录
GET  /api/dl/export.csv               导出下载记录

约定：成功 {"ok": true, ...}，失败 {"error": "..."} + 4xx/5xx。
"""
import csv
import io
import os
import time
import urllib.parse

from flask import Blueprint, Response, jsonify, request, session

from ... import config
from ...log import get_logger
from ...services.common import downloads as dl
from ...services.common import remote_dl

bp = Blueprint("downloads", __name__)
_log = get_logger()

_FORBIDDEN_NAMES = ('<', '>', ':', '"', '|', '?', '*', '\\', '/')


def _ip():
    return (request.headers.get("X-Forwarded-For") or request.remote_addr or "").split(",")[0].strip()


def _user():
    return session.get("username") or ""


def _bool(v, default=False):
    if v is None:
        return default
    return str(v).strip().lower() in ("1", "true", "yes", "on")


# ----------------------------------------------------------------------
# 目录浏览（可视化选择）
# ----------------------------------------------------------------------
def _quick_roots():
    home = os.path.expanduser("~")
    proj = os.path.dirname(config.BASE_DIR)
    roots = [
        {"name": "项目根目录", "path": proj, "icon": "bi-folder2-open"},
        {"name": "家目录", "path": home, "icon": "bi-house-door"},
        {"name": "下载产物", "path": dl.get_settings().get("artifact_dir"), "icon": "bi-cloud-arrow-down"},
        {"name": "数据目录", "path": config.DATA_ROOT, "icon": "bi-database"},
    ]
    if os.name != "nt":
        roots.append({"name": "根目录 /", "path": "/", "icon": "bi-hdd"})
    else:
        roots.append({"name": "系统盘", "path": os.environ.get("SystemDrive", "C:") + "\\", "icon": "bi-hdd"})
    out, seen = [], set()
    for r in roots:
        p = r.get("path") or ""
        if p and os.path.isdir(p) and p not in seen:
            seen.add(p)
            out.append(r)
    return out


def _recent_dirs(limit=5):
    """最近用过的来源目录（从任务记录里取，方便一键回到上次的位置）。"""
    try:
        conn = dl.store_conn()
        try:
            rows = conn.execute(
                "SELECT src_dir, MAX(updated) AS t FROM dl_tasks WHERE src_dir <> '' "
                "GROUP BY src_dir ORDER BY t DESC LIMIT ?", (limit,)).fetchall()
        finally:
            conn.close()
        return [{"name": r["src_dir"], "path": r["src_dir"], "icon": "bi-clock-history"}
                for r in rows if os.path.isdir(r["src_dir"] or "")]
    except Exception:
        return []


@bp.route("/api/dl/browse")
def api_dl_browse():
    raw = (request.args.get("path") or "").strip()
    path = os.path.abspath(os.path.expanduser(raw)) if raw else os.path.expanduser("~")
    if not os.path.isdir(path):
        # 逐级回退到最近的可用上级
        cur = path
        while cur and not os.path.isdir(cur):
            parent = os.path.dirname(cur)
            if parent == cur:
                break
            cur = parent
        path = cur if cur and os.path.isdir(cur) else os.path.expanduser("~")

    show_hidden = _bool(request.args.get("hidden"))
    q = (request.args.get("q") or "").strip().lower()
    dirs, files = [], []
    try:
        with os.scandir(path) as it:
            for e in it:
                name = e.name
                if not show_hidden and name.startswith("."):
                    continue
                if q and q not in name.lower():
                    continue
                try:
                    is_dir = e.is_dir(follow_symlinks=False)
                    st = e.stat(follow_symlinks=False)
                    size = 0 if is_dir else int(st.st_size)
                    mtime = int(st.st_mtime)
                except OSError:
                    continue
                item = {"name": name, "path": os.path.join(path, name), "is_dir": is_dir,
                        "size": size, "mtime": mtime}
                (dirs if is_dir else files).append(item)
    except PermissionError:
        return jsonify({"error": "没有权限读取该目录：%s" % path}), 403
    except OSError as e:
        return jsonify({"error": "读取目录失败：%s" % e}), 400

    key = lambda x: x["name"].lower()
    dirs.sort(key=key)
    files.sort(key=key)
    parent = os.path.dirname(path.rstrip(os.sep)) or os.sep
    return jsonify({
        "ok": True,
        "path": path,
        "parent": parent if parent != path else None,
        "items": dirs + files,
        "roots": _quick_roots(),
        "recent": _recent_dirs(),
        "sep": os.sep,
        "counts": {"dirs": len(dirs), "files": len(files)},
    })


@bp.route("/api/dl/mkdir", methods=["POST"])
def api_dl_mkdir():
    data = request.get_json(silent=True) or {}
    base = os.path.abspath(str(data.get("path") or ""))
    name = str(data.get("name") or "").strip()
    if not base or not os.path.isdir(base):
        return jsonify({"error": "目标目录不存在"}), 400
    if not name:
        return jsonify({"error": "请输入文件夹名称"}), 400
    if any(ch in name for ch in _FORBIDDEN_NAMES) or name in (".", ".."):
        return jsonify({"error": "名称含有非法字符"}), 400
    full = os.path.join(base, name)
    try:
        os.makedirs(full, exist_ok=True)
    except OSError as e:
        return jsonify({"error": "创建失败：%s" % e}), 400
    return jsonify({"ok": True, "path": full})


# ----------------------------------------------------------------------
# 任务
# ----------------------------------------------------------------------
_RECONCILE_AT = {"t": 0.0}


@bp.route("/api/dl/tasks", methods=["GET"])
def api_dl_tasks():
    # 进程重启后，库里还停在「下载中」但没有线程在跑的任务 → 标成已暂停（每 5 秒最多一次）
    now = time.time()
    if now - _RECONCILE_AT["t"] > 5:
        _RECONCILE_AT["t"] = now
        try:
            remote_dl.reconcile()
        except Exception:
            pass
    total, items = dl.list_tasks(
        q=request.args.get("q", ""),
        status=request.args.get("status", ""),
        kind=request.args.get("kind", ""),
        page=request.args.get("page", 1),
        page_size=request.args.get("page_size", 50),
    )
    return jsonify({"ok": True, "total": total, "items": items,
                    "stats": dl.stats(), "settings": dl.get_settings()})


@bp.route("/api/dl/tasks", methods=["POST"])
def api_dl_tasks_create():
    data = request.get_json(silent=True) or {}
    paths = data.get("paths") or []
    if isinstance(paths, str):
        paths = [paths]
    try:
        task = dl.create_task(
            paths,
            name=(data.get("name") or "").strip(),
            kind=(data.get("kind") or "auto").strip() or "auto",
            opts=data.get("opts") or {},
            user=_user(), ip=_ip(),
        )
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        _log.warning("创建下载任务失败：%s", e)
        return jsonify({"error": "创建失败：%s" % e}), 500
    return jsonify({"ok": True, "task": task})


@bp.route("/api/dl/url", methods=["POST"])
def api_dl_url_create():
    """新建「网络下载」任务：服务器多线程抓取 http / https / ftp / magnet。"""
    data = request.get_json(silent=True) or {}
    url = (data.get("url") or "").strip()
    if not url:
        return jsonify({"error": "请输入下载链接"}), 400
    # 同一链接只保留一个任务：默认先查重，由前端弹框确认是否删掉旧任务；
    # 确认后带 force=1 再来一次，这里负责删除旧任务并重新创建
    force = bool(data.get("force"))
    dups = dl.find_by_url(url)
    if dups and not force:
        return jsonify({
            "error": "已存在相同链接的下载任务",
            "need_confirm": True,
            "count": len(dups),
            "items": [{"id": t.get("id"), "name": t.get("name"),
                       "status": t.get("status"), "ts": t.get("ts")} for t in dups],
        }), 409
    if dups and force:
        for t in dups:
            try:
                dl.delete_task(t.get("id"), purge=True)
            except Exception as e:
                _log.warning("删除重复任务 %s 失败：%s", t.get("id"), e)
    try:
        task = remote_dl.create_task(
            url,
            save_dir=(data.get("save_dir") or "").strip(),
            filename=(data.get("filename") or "").strip(),
            threads=data.get("threads") or 0,
            opts=data.get("opts") or {},
            user=_user(), ip=_ip(),
        )
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        _log.warning("创建网络下载失败：%s", e)
        return jsonify({"error": "创建失败：%s" % e}), 500
    return jsonify({"ok": True, "task": task})


@bp.route("/api/dl/probe", methods=["POST"])
def api_dl_probe():
    """探测链接：文件名 / 大小 / 是否支持多线程（Range）。"""
    data = request.get_json(silent=True) or {}
    url = (data.get("url") or "").strip()
    if not url:
        return jsonify({"error": "请输入下载链接"}), 400
    try:
        info = remote_dl.probe(url, data.get("opts") or {}, timeout=15)
    except Exception as e:
        return jsonify({"error": "无法访问该链接：%s" % e}), 400
    return jsonify({"ok": True, "info": info})


@bp.route("/api/dl/env")
def api_dl_env():
    """运行环境：是否装了 aria2（磁力 / BT 用）。"""
    return jsonify({"ok": True, "env": remote_dl.env_info()})


@bp.route("/api/dl/tasks/<tid>", methods=["GET"])
def api_dl_task(tid):
    task = dl.get(tid)
    if not task:
        return jsonify({"error": "任务不存在"}), 404
    return jsonify({"ok": True, "task": task})


@bp.route("/api/dl/tasks/<tid>/segs")
def api_dl_task_segs(tid):
    """m3u8 分片下载台账：每个切片的下载 / 重试 / 失败状态。"""
    task = dl.get(tid)
    if not task:
        return jsonify({"error": "任务不存在"}), 404
    try:
        segs = remote_dl.segs_view(tid)
    except Exception:
        segs = None
    return jsonify({"ok": True, "status": task.get("status"),
                    "name": task.get("name"), "note": task.get("note"),
                    "segs": segs})


@bp.route("/api/dl/tasks/<tid>/action", methods=["POST"])
def api_dl_task_action(tid):
    data = request.get_json(silent=True) or {}
    action = (data.get("action") or "").strip()
    task = dl.get(tid)
    if not task:
        return jsonify({"error": "任务不存在"}), 404

    is_remote = task.get("kind") in ("url", "torrent", "hls")

    if action == "cancel":
        if is_remote:
            remote_dl.cancel(tid)
            dl.set_status(tid, "canceled")
        else:
            dl.request_cancel(tid)
            if task["status"] in ("ready", "paused", "downloading"):
                dl.set_status(tid, "canceled")
        return jsonify({"ok": True, "task": dl.get(tid)})

    if action == "start":
        if is_remote:
            if remote_dl.is_running(tid):
                return jsonify({"ok": True, "task": dl.get(tid)})
            return jsonify({"ok": True, "task": remote_dl.resume(tid)})
        if task["status"] in ("building", "pending"):
            return jsonify({"error": "还在打包，请稍候"}), 409
        if not task.get("exists"):
            return jsonify({"error": "产物已被清理，请重新创建任务"}), 410
        if task["done"] >= task["size"] and task["size"] > 0:
            dl.update_progress(tid, offset=0, status="ready")     # 已下完 → 从头再来
        else:
            dl.set_status(tid, "downloading")
        return jsonify({"ok": True, "task": dl.get(tid)})

    if action == "pause":
        if is_remote:
            remote_dl.pause(tid)
        dl.set_status(tid, "paused")
        return jsonify({"ok": True, "task": dl.get(tid)})

    if action == "retry":
        if is_remote:
            remote_dl.cancel(tid)
            dl._update(tid, segs=[], srv_done=0, srv_size=0, speed=0, artifact="",
                       meta={}, status="probing", error="", phase="正在重新解析链接…")
            return jsonify({"ok": True, "task": remote_dl.resume(tid)})
        if not task.get("exists"):
            return jsonify({"error": "产物已被清理，请重新创建任务"}), 410
        keep = bool(data.get("resume")) and int(task["done"]) > 0
        dl.update_progress(tid, offset=(task["done"] if keep else 0), status="ready")
        return jsonify({"ok": True, "task": dl.get(tid)})

    if action == "reset":
        if is_remote:
            remote_dl.cancel(tid)
            dl._update(tid, segs=[], srv_done=0, speed=0, status="probing", error="",
                       phase="正在重新解析链接…")
            return jsonify({"ok": True, "task": remote_dl.resume(tid)})
        dl.update_progress(tid, offset=0, status="ready")
        return jsonify({"ok": True, "task": dl.get(tid)})

    if action == "delete":
        ok = dl.delete_task(tid, purge=not _bool(data.get("keep_file")))
        return jsonify({"ok": bool(ok)})

    return jsonify({"error": "未知操作：%s" % action}), 400


@bp.route("/api/dl/progress", methods=["POST"])
def api_dl_progress():
    data = request.get_json(silent=True) or {}
    tid = str(data.get("id") or "")
    if not tid:
        return jsonify({"error": "缺少任务 id"}), 400
    task = dl.update_progress(tid, offset=data.get("offset"), status=data.get("status"))
    if not task:
        return jsonify({"error": "任务不存在"}), 404
    return jsonify({"ok": True, "task": task})


# ----------------------------------------------------------------------
# 下发（Range / 断点续传）
# ----------------------------------------------------------------------
def _parse_range(hdr, size):
    """解析 Range 头，返回 (start, end)；非法返回 None，不可满足返回 "bad"。"""
    if not hdr:
        return None
    hdr = hdr.strip()
    if not hdr.lower().startswith("bytes="):
        return None
    spec = hdr[6:].split(",")[0].strip()
    if "-" not in spec:
        return None
    a, b = spec.split("-", 1)
    try:
        if a == "":
            n = int(b)
            if n <= 0:
                return "bad"
            start = max(0, size - n)
            end = size - 1
        else:
            start = int(a)
            end = int(b) if b else size - 1
    except (TypeError, ValueError):
        return None
    if start < 0 or start >= size or end < start:
        return "bad"
    return start, min(end, size - 1)


@bp.route("/api/dl/stream/<tid>")
def api_dl_stream(tid):
    task = dl.get(tid)
    if not task:
        return jsonify({"error": "任务不存在"}), 404
    if task["status"] in ("building", "pending"):
        return jsonify({"error": "还在打包，请稍候再下载"}), 409
    path = task.get("artifact") or ""
    if not path or not os.path.isfile(path):
        return jsonify({"error": "产物不存在或已被清理，请重新创建任务"}), 410

    size = os.path.getsize(path)
    rng = _parse_range(request.headers.get("Range"), size)
    if rng == "bad":
        resp = Response(status=416)
        resp.headers["Content-Range"] = "bytes */%d" % size
        return resp

    start, end = (0, size - 1) if rng is None else rng
    length = 0 if size == 0 else end - start + 1
    filename = task.get("name") or os.path.basename(path)
    inline = _bool(request.args.get("inline"))

    dl.touch_stream(tid)
    sent = {"n": 0}
    last = {"t": 0.0}

    def _gen():
        try:
            for chunk in dl.iter_file(path, start, end):
                sent["n"] += len(chunk)
                now = time.time()
                if now - last["t"] >= 1.0:
                    last["t"] = now
                    dl.update_progress(tid, offset=min(size, start + sent["n"]))
                yield chunk
        except (BrokenPipeError, ConnectionResetError, GeneratorExit):
            pass
        finally:
            total_sent = start + sent["n"]
            try:
                if length and sent["n"] >= length:
                    dl.update_progress(tid, offset=size, status="done")
                elif total_sent > 0:
                    # 中断：保留游标，下次从断点继续
                    dl.set_status(tid, "paused")
                    dl.update_progress(tid, offset=min(size, total_sent))
            except Exception:
                pass

    resp = Response(_gen(), status=(206 if rng else 200), mimetype="application/octet-stream",
                    direct_passthrough=True)
    resp.headers["Accept-Ranges"] = "bytes"
    resp.headers["Content-Length"] = str(length)
    if rng:
        resp.headers["Content-Range"] = "bytes %d-%d/%d" % (start, end, size)
    disp = "inline" if inline else "attachment"
    # ASCII 回退名（老客户端）+ RFC 5987 的 UTF-8 名（现代浏览器按它显示中文名）
    ascii_name = "".join(ch if (ch.isalnum() or ch in "-_.") else "_" for ch in filename) or "download"
    resp.headers["Content-Disposition"] = "%s; filename=\"%s\"; filename*=UTF-8''%s" % (
        disp, ascii_name, urllib.parse.quote(filename))
    resp.headers["Cache-Control"] = "no-store"
    resp.headers["X-DL-Task"] = tid
    return resp


# ----------------------------------------------------------------------
# 设置 / 占用 / 清理 / 导出
# ----------------------------------------------------------------------
@bp.route("/api/dl/settings", methods=["GET"])
def api_dl_settings_get():
    return jsonify({"ok": True, "settings": dl.get_settings(), "usage": dl.usage()})


@bp.route("/api/dl/settings", methods=["POST"])
def api_dl_settings_save():
    data = request.get_json(silent=True) or {}
    try:
        cfg = dl.save_settings(data)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    return jsonify({"ok": True, "settings": cfg, "usage": dl.usage()})


@bp.route("/api/dl/usage", methods=["GET"])
def api_dl_usage():
    return jsonify({"ok": True, "usage": dl.usage(), "stats": dl.stats()})


@bp.route("/api/dl/clean", methods=["POST"])
def api_dl_clean():
    data = request.get_json(silent=True) or {}
    what = (data.get("what") or "artifacts").strip()
    if what == "artifacts":
        n = dl.clean_artifacts()
        return jsonify({"ok": True, "removed": n, "message": "已清理 %d 个产物文件" % n})
    if what in ("finished", "all"):
        n = dl.clear_tasks(what)
        return jsonify({"ok": True, "removed": n, "message": "已删除 %d 条记录" % n})
    return jsonify({"error": "未知清理类型"}), 400


@bp.route("/api/dl/export.csv")
def api_dl_export():
    total, items = dl.list_tasks(q=request.args.get("q", ""), status=request.args.get("status", ""),
                                 page=1, page_size=200)
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["创建时间", "文件名", "类型", "状态", "大小(字节)", "已下载(字节)",
                "来源", "产物路径", "下载次数", "备注", "错误"])
    for t in items:
        w.writerow([t["ts"], t["name"], t["kind"], t["status"], t["size"], t["done"],
                    " | ".join(t.get("src") or []), t.get("artifact") or "", t["hits"],
                    t.get("note") or "", t.get("error") or ""])
    data = "\ufeff" + buf.getvalue()
    resp = Response(data, mimetype="text/csv; charset=utf-8")
    resp.headers["Content-Disposition"] = (
        "attachment; filename=download_records.csv; filename*=UTF-8''%s"
        % urllib.parse.quote("下载记录_%s.csv" % time.strftime("%Y%m%d_%H%M")))
    resp.headers["Cache-Control"] = "no-store"
    return resp

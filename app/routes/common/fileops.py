"""文件操作路由：创建 / 保存 / 重命名 / 移动 / 复制 / 新建文件夹 / 属性。"""
import os
import json
import shutil
import mimetypes
import threading
import time
import uuid
import hashlib
from datetime import datetime

from flask import Blueprint, request, jsonify, session

from ...log import get_logger
from ...services.common.filecore import (
    safe_path, _invalidate_list_cache, _invalidate_dir_size, _human_size,
    _in_pseudo_fs,
)
from ...services.common.uploadlog import (
    add_record, list_records, stats as upload_stats, clear_records, mark_missing,
)
from ...services.ide.collab import preshare_for, COLLAB_BACKUP_DIR


_log = get_logger()
bp = Blueprint("fileops", __name__)


# ---------- 实时移动/复制进度（任务制，SSE 聚合） ----------
_MOVE_COPY_TASKS = {}
_MOVE_COPY_LOCK = threading.Lock()


def _mc_count_tree(path):
    """统计文件数与总字节数（用于进度计算）"""
    if os.path.islink(path) or os.path.isfile(path):
        try:
            return 1, os.path.getsize(path)
        except OSError:
            return 1, 0
    total_files, total_bytes = 0, 0
    for root, _dirs, files in os.walk(path, onerror=lambda e: None):
        for f in files:
            total_files += 1
            try:
                total_bytes += os.path.getsize(os.path.join(root, f))
            except OSError:
                pass
    return total_files, total_bytes


def _mc_copy_file_progress(src, dst, task):
    """复制单个文件，按字节实时上报进度"""
    try:
        size = os.path.getsize(src)
    except OSError:
        size = 0
    with _MOVE_COPY_LOCK:
        base = task["done_bytes"]
        task["current"] = os.path.basename(src)
    copied = 0
    try:
        with open(src, "rb") as fsrc, open(dst, "wb") as fdst:
            while True:
                chunk = fsrc.read(256 * 1024)
                if not chunk:
                    break
                fdst.write(chunk)
                copied += len(chunk)
                with _MOVE_COPY_LOCK:
                    task["done_bytes"] = base + copied
        try:
            shutil.copystat(src, dst)
        except OSError:
            pass
    except Exception:
        pass
    with _MOVE_COPY_LOCK:
        task["done_files"] += 1
        task["done_bytes"] = base + size


def _mc_worker(task_id, mode, paths, dest_dir):
    task = _MOVE_COPY_TASKS.get(task_id)
    if not task:
        return
    errors = []
    try:
        for src in paths:
            s = os.path.abspath(os.path.normpath(src))
            f, b = _mc_count_tree(s)  # 先统计（操作后源会被移动/删除）
            try:
                _guard_protected_path(s)
            except PermissionError as e:
                errors.append(f"{os.path.basename(s)}: {e}")
                continue
            dest = os.path.join(dest_dir, os.path.basename(s))
            if os.path.exists(dest):
                errors.append(f"{os.path.basename(s)}: 目标已存在")
                continue
            try:
                if mode == "copy":
                    if os.path.isdir(s):
                        shutil.copytree(s, dest)
                    else:
                        _mc_copy_file_progress(s, dest, task)
                else:  # move
                    shutil.move(s, dest_dir)
                _invalidate_list_cache(os.path.dirname(s))
                _invalidate_list_cache(dest_dir)
            except Exception as e:
                errors.append(f"{os.path.basename(s)}: {e}")
                continue
            with _MOVE_COPY_LOCK:
                task["done_files"] += f
                task["done_bytes"] += b
        with _MOVE_COPY_LOCK:
            task["status"] = "done_with_errors" if errors else "done"
            task["errors"] = errors
            task["result"] = {"done": max(len(paths) - len(errors), 0), "errors": errors}
    except Exception as e:
        with _MOVE_COPY_LOCK:
            task["status"] = "error"
            task["errors"] = errors + [str(e)]
            task["result"] = {"done": 0, "errors": errors + [str(e)]}


def _mc_start(mode):
    _log.info("POST /api/%s/start" % mode)
    data = request.get_json()
    if not data:
        return jsonify({"error": "无效请求"}), 400
    paths = data.get("paths", [])
    dest_dir = os.path.abspath(os.path.normpath(data.get("dest_dir", "")))
    if not paths:
        return jsonify({"error": "未指定文件"}), 400
    if not os.path.isdir(dest_dir):
        return jsonify({"error": "目标目录不存在"}), 400
    valid, total_files, total_bytes = [], 0, 0
    for rel in paths:
        p = os.path.abspath(os.path.normpath(rel))
        if not os.path.exists(p):
            continue
        try:
            _guard_protected_path(p)
        except PermissionError:
            return jsonify({"error": f"禁止对服务运行目录及其上级目录执行{mode == 'move' and '移动' or '复制'}: {rel}"}), 403
        f, b = _mc_count_tree(p)
        total_files += f
        total_bytes += b
        valid.append(p)
    if not valid:
        return jsonify({"error": "没有可处理的文件"}), 400
    task_id = uuid.uuid4().hex[:16]
    task = {"status": "running", "total_files": total_files, "total_bytes": total_bytes,
            "done_files": 0, "done_bytes": 0, "current": "", "errors": [], "started_at": time.time()}
    with _MOVE_COPY_LOCK:
        now = time.time()
        for k in [k for k, v in _MOVE_COPY_TASKS.items() if now - v.get("started_at", 0) > 1800]:
            _MOVE_COPY_TASKS.pop(k, None)
        _MOVE_COPY_TASKS[task_id] = task
    threading.Thread(target=_mc_worker, args=(task_id, mode, valid, dest_dir), daemon=True).start()
    return jsonify({"success": True, "task_id": task_id, "total_files": total_files, "total_bytes": total_bytes})


def _mc_progress():
    task_id = request.args.get("task_id", "")
    with _MOVE_COPY_LOCK:
        task = _MOVE_COPY_TASKS.get(task_id)
        if not task:
            return jsonify({"error": "任务不存在或已过期"}), 404
        snap = dict(task)
    total_bytes = snap.get("total_bytes") or 0
    done_bytes = min(snap.get("done_bytes") or 0, total_bytes)
    total_files = snap.get("total_files") or 0
    done_files = min(snap.get("done_files") or 0, total_files)
    if total_bytes > 0:
        percent = done_bytes / total_bytes * 100
    elif total_files > 0:
        percent = done_files / total_files * 100
    else:
        percent = 100 if snap["status"] != "running" else 0
    errors = snap.get("errors") or []
    return jsonify({
        "status": snap["status"], "current": snap.get("current", ""),
        "done_files": done_files, "total_files": total_files,
        "done_bytes": done_bytes, "total_bytes": total_bytes,
        "percent": round(percent, 1), "errors": errors, "result": snap.get("result"),
    })


@bp.route("/api/move/start", methods=["POST"])
def api_move_start():
    return _mc_start("move")


@bp.route("/api/copy/start", methods=["POST"])
def api_copy_start():
    return _mc_start("copy")


@bp.route("/api/move/progress")
def api_move_progress():
    return _mc_progress()


@bp.route("/api/copy/progress")
def api_copy_progress():
    return _mc_progress()


def _guard_protected_path(p):
    """拒绝把服务进程 CWD（项目根）或其祖先目录作为破坏性操作的目标。

    防御场景：前端/参数异常导致路径为空时，os.path.abspath("") 会解析成
    CWD，若不拦截，重命名/移动/删除会把整个项目目录改名、搬走或删掉。
    """
    p = os.path.normpath(os.path.abspath(p))
    cwd = os.path.normpath(os.getcwd())
    if p == cwd or cwd.startswith(p + os.sep):
        raise PermissionError("禁止对服务运行目录及其上级目录执行此操作")





@bp.route("/api/files/create", methods=["POST"])
def api_files_create():
    _log.info("POST /api/files/create")
    data = request.get_json()
    if not data:
        return jsonify({"error": "无效请求"}), 400
    path = data.get("path", "").strip()
    name = data.get("name", "").strip()
    is_dir = data.get("is_dir", False)
    if not name:
        return jsonify({"error": "名称不能为空"}), 400
    forbidden = ['<', '>', ':', '"', '|', '?', '*']
    for ch in forbidden:
        if ch in name:
            return jsonify({"error": f"名称不能包含 {ch}"}), 400
    if os.path.sep in name:
        return jsonify({"error": "名称不能包含路径分隔符"}), 400

    target_dir = safe_path(path)
    if not os.path.isdir(target_dir):
        return jsonify({"error": f"目录不存在: {target_dir}"}), 400
    full_path = os.path.abspath(os.path.normpath(os.path.join(target_dir, name)))
    if os.path.exists(full_path):
        return jsonify({"error": f"已存在: {name}"}), 400

    try:
        if is_dir:
            os.makedirs(full_path, exist_ok=True)
        else:
            with open(full_path, 'w', encoding='utf-8') as f:
                pass  # 创建空文件
        _invalidate_list_cache(target_dir)
        _invalidate_dir_size(target_dir)
        return jsonify({"success": True, "path": full_path, "name": name, "is_dir": is_dir})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


def _backup_preshare(full_path, new_content):
    """保存「参与过协作的文件」前，把「共享前版本」备份到 data/collab_backups/。

    文件名形如 test_cron.py.20260101-120000.preshare.bak（时间戳=那次共享的起始时间），
    同一次共享只留一份；返回备份路径，无需备份时返回空串。
    """
    snap = preshare_for(full_path)
    if not snap:
        return ""
    text = snap.get("text")
    if not text or text == new_content:      # 没共享过 / 内容没变：不必备份
        return ""
    ts = datetime.fromtimestamp(snap.get("created") or time.time()).strftime("%Y%m%d-%H%M%S")
    bak = os.path.join(COLLAB_BACKUP_DIR,
                       "%s.%s.preshare.bak" % (os.path.basename(full_path), ts))
    if os.path.exists(bak):
        return bak                           # 这一次共享已经备份过了
    os.makedirs(COLLAB_BACKUP_DIR, exist_ok=True)
    with open(bak, "w", encoding="utf-8") as f:
        f.write(text)
    _log.info("保存协作文件：已备份共享前版本 -> %s", bak)
    return bak


@bp.route("/api/files/save", methods=["POST"])
def api_files_save():
    _log.info("POST /api/files/save")
    data = request.get_json()
    if not data:
        return jsonify({"error": "无效请求"}), 400
    path = data.get("path", "").strip()
    content = data.get("content", "")
    if not path:
        return jsonify({"error": "未指定路径"}), 400

    full_path = os.path.abspath(os.path.normpath(path))
    parent_dir = os.path.dirname(full_path)

    # 保护自身
    script_path = os.path.abspath(__file__)
    if full_path == script_path:
        return jsonify({"error": "不能修改脚本自身"}), 400

    try:
        # 确保父目录存在
        if parent_dir and not os.path.isdir(parent_dir):
            os.makedirs(parent_dir, exist_ok=True)
        # 确保不是目录
        if os.path.isdir(full_path):
            return jsonify({"error": "不能写入目录"}), 400
        # 参与过协作的文件：覆盖前先把「共享前版本」备份到文件旁边（失败不影响保存）
        try:
            backup = _backup_preshare(full_path, content)
        except Exception as e:
            backup = ""
            _log.info("共享前版本备份失败（忽略）：%s", e)
        with open(full_path, 'w', encoding='utf-8') as f:
            f.write(content)
        _invalidate_list_cache(parent_dir)
        _invalidate_dir_size(parent_dir)
        return jsonify({"success": True, "path": full_path,
                        "size": os.path.getsize(full_path), "backup": backup})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ---------- 拖拽上传：把本地文件 / 文件夹放进项目目录（带基础检查） ----------
# 单文件上限 25MB（全局 MAX_CONTENT_LENGTH=32MB 请求体上限之内，留出表单开销）
UPLOAD_MAX_SIZE = 25 * 1024 * 1024
_UPLOAD_NAME_FORBIDDEN = ("<", ">", ":", '"', "|", "?", "*", "\\", "/")


def _upload_rel_parts(rel):
    """把前端给来的相对路径拆成安全分段；含 .. / 非法字符 / 盘符等一律返回 None。"""
    rel = (rel or "").replace("\\", "/").strip().strip("/")
    if not rel:
        return None
    parts = [p for p in rel.split("/") if p not in ("", ".")]
    if not parts or any(p == ".." for p in parts):
        return None
    for seg in parts:
        if any(ch in seg for ch in _UPLOAD_NAME_FORBIDDEN):
            return None
    return parts


def _upload_make_dirs(target_dir, rel):
    """按相对路径建目录（拖入的空文件夹也要落地），返回创建出的相对路径。"""
    parts = _upload_rel_parts(rel)
    if not parts:
        return None
    full = os.path.join(target_dir, *parts)
    # 双保险：解析后必须仍在目标目录内（防 ../ 与符号链接）
    if not os.path.abspath(full).startswith(os.path.abspath(target_dir) + os.sep):
        return None
    os.makedirs(full, exist_ok=True)
    return "/".join(parts)


def _upload_unique_path(target_dir, parts):
    """在 target_dir 下解析 parts；同名文件自动追加 -1 / -2 序号，返回 (绝对路径, 相对路径)。"""
    name = parts[-1]
    base, ext = os.path.splitext(name)
    final, i = list(parts), 1
    while True:
        full = os.path.join(target_dir, *final)
        if not os.path.exists(full):
            return full, "/".join(final)
        final[-1] = "%s-%d%s" % (base, i, ext)
        i += 1


@bp.route("/api/files/upload", methods=["POST"])
def api_files_upload():
    _log.info("POST /api/files/upload")
    target_dir = safe_path(request.form.get("dir", ""))
    if not os.path.isdir(target_dir):
        return jsonify({"error": "目标目录不存在"}), 400
    files = request.files.getlist("files")
    # keep_structure=1：拖入的是文件夹，按 paths 里的相对路径保留目录层级（IDE 的普通上传不带此参数，行为不变）
    keep = request.form.get("keep_structure") == "1"
    dirs = request.form.getlist("dirs") if keep else []
    if not files and not dirs:
        return jsonify({"error": "没有收到文件"}), 400
    uploaded, skipped = [], []
    for d in dirs:
        try:
            if _upload_make_dirs(target_dir, d) is None:
                skipped.append({"name": d, "reason": "目录名非法"})
        except Exception as e:
            skipped.append({"name": d, "reason": str(e)})
    rel_paths = request.form.getlist("paths")
    for idx, fs in enumerate(files):
        raw_name = fs.filename or ""
        rel = rel_paths[idx] if idx < len(rel_paths) else ""
        parts = _upload_rel_parts(rel) if (keep and rel) else None
        if not parts:
            # 回退：只取文件名本身，统一落到一层
            name = os.path.basename(raw_name.replace("\\", "/")).strip()
            if not name or name in (".", ".."):
                skipped.append({"name": raw_name or "?", "reason": "无效文件名"})
                continue
            if any(ch in name for ch in _UPLOAD_NAME_FORBIDDEN):
                skipped.append({"name": name, "reason": "文件名包含非法字符"})
                continue
            parts = [name]
        shown = "/".join(parts)
        try:
            data = fs.read()
        except Exception as e:
            skipped.append({"name": shown, "reason": "读取失败: %s" % e})
            continue
        if len(data) > UPLOAD_MAX_SIZE:
            skipped.append({"name": shown, "reason": "超过 25MB 大小限制"})
            continue
        # 0 字节文件是合法的：照常落盘（原来这里直接跳过，拖入空文件永远传不上去）
        try:
            full, shown = _upload_unique_path(target_dir, parts)
            parent = os.path.dirname(full)
            if parent and not os.path.isdir(parent):
                os.makedirs(parent, exist_ok=True)
            with open(full, "wb") as f:
                f.write(data)
        except Exception as e:
            skipped.append({"name": shown, "reason": str(e)})
            continue
        uploaded.append(shown)
    _invalidate_list_cache(target_dir)
    _invalidate_dir_size(target_dir)
    return jsonify({"success": True, "dir": target_dir,
                    "uploaded": uploaded, "skipped": skipped})


# ---------- 断点续传（分片上传） ----------
# 大文件按固定大小切片，每片独立请求；服务端按 fid 把分片落到临时目录。
# 上传前先查「已接收分片」，只传缺失的；全部到位后再 merge 成最终文件。
# 中途失败 / 刷新页面后重新「开始上传」，都从断点继续，已传分片不重传。
_UPLOAD_TMP = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__)))), ".upload_tmp")
_UPLOAD_TMP_CLEANED = 0


def _upload_fid(rel, size, mtime):
    """用 (相对路径 + 大小 + 修改时间) 算一个安全的临时目录名，避免路径穿越。"""
    raw = "%s\x00%s\x00%s" % (rel, size, mtime)
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()


def _maybe_clean_upload_tmp():
    """偶发清理超过 3 天还没合并的孤儿临时目录（续传窗口期内保留，跨重启仍可用）。"""
    global _UPLOAD_TMP_CLEANED
    _UPLOAD_TMP_CLEANED += 1
    if _UPLOAD_TMP_CLEANED % 50 != 0:
        return
    try:
        now = time.time()
        for name in os.listdir(_UPLOAD_TMP):
            p = os.path.join(_UPLOAD_TMP, name)
            if os.path.isdir(p) and now - os.path.getmtime(p) > 3 * 86400:
                shutil.rmtree(p, ignore_errors=True)
    except Exception:
        pass


def _upload_dest_parts(rel, keep):
    """把前端传来的相对路径解析为落地路径片段；非法返回 None。
    keep=True 保留目录层级，否则只取 basename（与一次性上传口径一致）。"""
    if keep:
        parts = _upload_rel_parts(rel)
        if parts:
            return parts
    name = os.path.basename((rel or "").replace("\\", "/")).strip()
    if not name or name in (".", ".."):
        return None
    if any(ch in name for ch in _UPLOAD_NAME_FORBIDDEN):
        return None
    return [name]


@bp.route("/api/files/upload_check", methods=["POST"])
def api_files_upload_check():
    """上传前的同名检测：返回目标目录里已经存在的（会造成覆盖的）文件。"""
    target_dir = safe_path(request.form.get("dir", ""))
    if not os.path.isdir(target_dir):
        return jsonify({"error": "目标目录不存在"}), 400
    keep = request.form.get("keep_structure") == "1"
    try:
        rels = json.loads(request.form.get("rels") or "[]")
    except Exception:
        rels = []
    conflicts = []
    for rel in rels:
        parts = _upload_dest_parts(rel, keep)
        if not parts:
            continue
        full = os.path.join(target_dir, *parts)
        try:
            if not os.path.exists(full) and not os.path.islink(full):
                continue
            conflicts.append({
                "rel": rel,                        # 原样回传，便于前端匹配队列项
                "path": "/".join(parts),           # 实际落地相对路径（展示用）
                "online_size": os.path.getsize(full) if os.path.isfile(full) else 0,
                "is_dir": os.path.isdir(full),
            })
        except OSError:
            continue
    return jsonify({"success": True, "conflicts": conflicts})


@bp.route("/api/files/upload_status", methods=["POST"])
def api_files_upload_status():
    rel = request.form.get("rel", "")
    size = request.form.get("size", "0")
    mtime = request.form.get("mtime", "0")
    fid = _upload_fid(rel, size, mtime)
    tmp = os.path.join(_UPLOAD_TMP, fid)
    received = []
    if os.path.isdir(tmp):
        for n in os.listdir(tmp):
            if n.isdigit():
                received.append(int(n))
    return jsonify({"success": True, "received": received})


@bp.route("/api/files/upload_chunk", methods=["POST"])
def api_files_upload_chunk():
    rel = request.form.get("rel", "")
    size = request.form.get("size", "0")
    mtime = request.form.get("mtime", "0")
    try:
        index = int(request.form.get("index", "0"))
        total = int(request.form.get("total", "1"))
    except Exception:
        return jsonify({"error": "参数错误"}), 400
    chunk = request.files.get("chunk")
    if not chunk:
        return jsonify({"error": "没有收到分片"}), 400
    if index < 0 or index >= total:
        return jsonify({"error": "分片序号越界"}), 400
    fid = _upload_fid(rel, size, mtime)
    tmp = os.path.join(_UPLOAD_TMP, fid)
    try:
        os.makedirs(tmp, exist_ok=True)
    except Exception as e:
        return jsonify({"error": "无法创建临时目录: %s" % e}), 500
    dest = os.path.join(tmp, str(index))
    if os.path.exists(dest):                       # 幂等：该分片已存在则跳过
        return jsonify({"success": True, "index": index, "dup": True})
    try:
        with open(dest, "wb") as f:
            f.write(chunk.read())
    except Exception as e:
        return jsonify({"error": "写入分片失败: %s" % e}), 500
    _maybe_clean_upload_tmp()
    return jsonify({"success": True, "index": index})


@bp.route("/api/files/upload_merge", methods=["POST"])
def api_files_upload_merge():
    rel = request.form.get("rel", "")
    size = request.form.get("size", "0")
    mtime = request.form.get("mtime", "0")
    keep = request.form.get("keep_structure") == "1"
    # overwrite=1：用户在前端确认「覆盖」后，同名文件直接覆盖，不再自动改名 -1
    overwrite = request.form.get("overwrite") == "1"
    dirs = request.form.getlist("dirs") if keep else []
    target_dir = safe_path(request.form.get("dir", ""))
    if not os.path.isdir(target_dir):
        return jsonify({"error": "目标目录不存在"}), 400
    try:
        total = int(request.form.get("total", "1"))
    except Exception:
        total = 1

    # ---- 上传记录（侧边抽屉用；写失败只记日志，不影响上传） ----
    _ip = (request.headers.get("X-Forwarded-For") or request.remote_addr or "").split(",")[0].strip()

    def _rec(ok, err="", full="", shown="", fsize=0):
        try:
            add_record(
                name=os.path.basename(full) or os.path.basename((shown or rel).replace("\\", "/")),
                rel=shown or rel,
                target_dir=target_dir,
                path=full,
                size=fsize or (int(size) if (size or "").isdigit() else 0),
                cost_ms=int(request.form.get("cost_ms") or 0),
                ok=ok, error=err,
                user=(session.get("username") or ""),
                ip=_ip,
            )
        except Exception:
            pass

    for d in dirs:                                 # 建空目录（合并前先落地，方便目录续传）
        try:
            if _upload_make_dirs(target_dir, d) is None:
                pass
        except Exception:
            pass
    fid = _upload_fid(rel, size, mtime)
    tmp = os.path.join(_UPLOAD_TMP, fid)
    parts = []
    for i in range(total):
        p = os.path.join(tmp, str(i))
        if not os.path.exists(p):
            _rec(False, "分片缺失: %d" % i)
            return jsonify({"error": "分片缺失: %d" % i, "missing": i}), 400
        parts.append(p)
    # 校验总大小（最后一片可能小于分片大小）
    if size and size != "0":
        try:
            actual = sum(os.path.getsize(p) for p in parts)
            if actual != int(size):
                _rec(False, "分片大小不符: 期望 %s 实际 %s" % (size, actual))
                return jsonify({"error": "分片大小不符: 期望 %s 实际 %s" % (size, actual)}), 400
        except Exception:
            pass
    # 解析最终路径（与一次性上传保持一致：保留目录层级 / 同名 -1）
    parts_path = _upload_dest_parts(rel, keep)
    if not parts_path:
        _rec(False, "无效文件名")
        return jsonify({"error": "无效文件名"}), 400
    try:
        if overwrite:
            full = os.path.join(target_dir, *parts_path)
            shown = "/".join(parts_path)
        else:
            full, shown = _upload_unique_path(target_dir, parts_path)
        parent = os.path.dirname(full)
        if parent and not os.path.isdir(parent):
            os.makedirs(parent, exist_ok=True)
        with open(full, "wb") as out:
            for p in parts:
                with open(p, "rb") as inp:
                    shutil.copyfileobj(inp, out)
    except Exception as e:
        _rec(False, "合并失败: %s" % e)
        return jsonify({"error": "合并失败: %s" % e}), 500
    # 清理临时分片
    shutil.rmtree(tmp, ignore_errors=True)
    _invalidate_list_cache(target_dir)
    _invalidate_dir_size(target_dir)
    try:
        _rec(True, "", full, shown, os.path.getsize(full))
    except Exception:
        pass
    return jsonify({"success": True, "uploaded": [shown], "skipped": []})


@bp.route("/api/files/upload_records", methods=["GET"])
def api_upload_records():
    """上传记录列表（文件管理侧边抽屉）。"""
    total, items = list_records(
        q=request.args.get("q", ""),
        status=request.args.get("status", ""),
        page=request.args.get("page", 1),
        page_size=request.args.get("page_size", 50),
    )
    return jsonify({"success": True, "total": total, "items": items,
                    "stats": upload_stats()})


@bp.route("/api/files/upload_records/clear", methods=["POST"])
def api_upload_records_clear():
    """清空上传记录。"""
    ok = clear_records()
    return jsonify({"success": bool(ok), "error": "" if ok else "清空失败"})


@bp.route("/api/files/upload_records/missing", methods=["POST"])
def api_upload_records_missing():
    """标记某条记录的文件是否还在原位置（前端点记录跳转后校验，找不到就标「已删除」）。"""
    data = request.get_json(silent=True) or {}
    rec_id = request.form.get("id") or data.get("id") or 0
    flag = request.form.get("missing")
    if flag is None:
        flag = data.get("missing", 1)
    try:
        missing = 1 if int(flag) else 0
    except Exception:
        missing = 1
    ok = mark_missing(rec_id, bool(missing))
    return jsonify({"success": bool(ok)})


@bp.route("/api/files/upload_record_fail", methods=["POST"])
def api_upload_record_fail():
    """前端上报一条失败的上传记录（分片中断等，走不到 merge 的情况）。"""
    rel = request.form.get("rel", "")
    try:
        size = int(request.form.get("size") or 0)
    except Exception:
        size = 0
    try:
        cost_ms = int(request.form.get("cost_ms") or 0)
    except Exception:
        cost_ms = 0
    target_dir = safe_path(request.form.get("dir", ""))
    ip = (request.headers.get("X-Forwarded-For") or request.remote_addr or "").split(",")[0].strip()
    add_record(
        name=os.path.basename(rel.replace("\\", "/")),
        rel=rel, target_dir=target_dir, path="", size=size, cost_ms=cost_ms,
        ok=False, error=(request.form.get("error") or "上传失败")[:300],
        user=(session.get("username") or ""), ip=ip,
    )
    return jsonify({"success": True})


@bp.route("/api/rename", methods=["POST"])
def api_rename():
    data = request.get_json()
    if not data:
        return jsonify({"error": "无效请求"}), 400
    old_path = os.path.abspath(os.path.normpath(data.get("path", "")))
    new_name = data.get("new_name", "").strip()
    if not new_name:
        return jsonify({"error": "名称不能为空"}), 400
    forbidden = ['<', '>', ':', '"', '|', '?', '*', '\\', '/']
    for ch in forbidden:
        if ch in new_name:
            return jsonify({"error": f"名称不能包含 {ch}"}), 400
    if os.path.sep in new_name:
        return jsonify({"error": "名称不能包含路径分隔符"}), 400
    if not os.path.exists(old_path):
        return jsonify({"error": "文件不存在"}), 404
    # 安全保护：禁止重命名服务进程工作目录（CWD）及其祖先目录，
    # 防止路径解析异常时把整个项目/磁盘根目录改名
    try:
        _guard_protected_path(old_path)
    except PermissionError as e:
        return jsonify({"error": str(e)}), 403
    parent = os.path.dirname(old_path)
    new_path = os.path.join(parent, new_name)
    if os.path.exists(new_path):
        return jsonify({"error": f"目标名称 '{new_name}' 已存在"}), 400
    try:
        os.rename(old_path, new_path)
    except (OSError, PermissionError) as e:
        return jsonify({"error": f"重命名失败: {str(e)}"}), 500
    _invalidate_list_cache(parent)
    _invalidate_list_cache(os.path.dirname(new_path))
    return jsonify({"success": True, "new_path": new_path})


@bp.route("/api/move", methods=["POST"])
def api_move():
    data = request.get_json()
    if not data:
        return jsonify({"error": "无效请求"}), 400
    src = os.path.abspath(os.path.normpath(data.get("path", "")))
    dest_dir = os.path.abspath(os.path.normpath(data.get("dest_dir", "")))
    if not os.path.exists(src):
        return jsonify({"error": "源文件不存在"}), 404
    if not os.path.isdir(dest_dir):
        return jsonify({"error": "目标目录不存在"}), 400
    try:
        _guard_protected_path(src)
    except PermissionError as e:
        return jsonify({"error": str(e)}), 403
    dest = os.path.join(dest_dir, os.path.basename(src))
    if os.path.exists(dest):
        return jsonify({"error": f"目标 '{os.path.basename(src)}' 已存在"}), 400
    shutil.move(src, dest_dir)
    _invalidate_list_cache(os.path.dirname(src))
    _invalidate_list_cache(dest_dir)
    return jsonify({"success": True})


@bp.route("/api/copy", methods=["POST"])
def api_copy():
    data = request.get_json()
    if not data:
        return jsonify({"error": "无效请求"}), 400
    src = os.path.abspath(os.path.normpath(data.get("path", "")))
    dest_dir = os.path.abspath(os.path.normpath(data.get("dest_dir", "")))
    if not os.path.exists(src):
        return jsonify({"error": "源文件不存在"}), 404
    if not os.path.isdir(dest_dir):
        return jsonify({"error": "目标目录不存在"}), 400
    dest = os.path.join(dest_dir, os.path.basename(src))
    if os.path.exists(dest):
        return jsonify({"error": f"目标 '{os.path.basename(src)}' 已存在"}), 400
    if os.path.isdir(src):
        shutil.copytree(src, dest)
    else:
        shutil.copy2(src, dest)
    _invalidate_list_cache(dest_dir)
    return jsonify({"success": True})


@bp.route("/api/new-folder", methods=["POST"])
def api_new_folder():
    data = request.get_json()
    if not data:
        return jsonify({"error": "无效请求"}), 400
    parent = os.path.abspath(os.path.normpath(data.get("parent", "")))
    name = data.get("name", "").strip()
    if not name:
        return jsonify({"error": "名称不能为空"}), 400
    if not os.path.isdir(parent):
        return jsonify({"error": "父目录不存在"}), 400
    new_dir = os.path.join(parent, name)
    if os.path.exists(new_dir):
        return jsonify({"error": f"'{name}' 已存在"}), 400
    os.makedirs(new_dir, exist_ok=True)
    _invalidate_list_cache(parent)
    return jsonify({"success": True})


@bp.route("/api/properties")
def api_properties():
    rel_path = request.args.get("path", "")
    target_path = os.path.abspath(os.path.normpath(rel_path))
    if not os.path.exists(target_path):
        return jsonify({"error": "路径不存在"}), 404
    stat = os.stat(target_path)
    ext = os.path.splitext(target_path)[1].lower().lstrip(".")
    mime_type, _ = mimetypes.guess_type(target_path)
    is_dir = os.path.isdir(target_path)

    if is_dir:
        if request.args.get("light"):
            # 轻量模式：不做目录大小统计，用于存在性/基本信息的快速探测
            return jsonify({
                "name": os.path.basename(target_path),
                "path": target_path,
                "parent": os.path.dirname(target_path),
                "is_dir": True,
            })
        dir_info = _get_dir_info(target_path)
        return jsonify({
            "name": os.path.basename(target_path),
            "path": target_path,
            "parent": os.path.dirname(target_path),
            "size": dir_info["size"],
            "size_str": _human_size(dir_info["size"]),
            "total_files": dir_info["total_files"],
            "total_dirs": dir_info["total_dirs"],
            "sub_dirs": dir_info["sub_dirs"],
            "sub_files": dir_info["sub_files"],
            "is_dir": True,
            "created": datetime.fromtimestamp(stat.st_ctime).strftime("%Y-%m-%d %H:%M:%S"),
            "modified": datetime.fromtimestamp(stat.st_mtime).strftime("%Y-%m-%d %H:%M:%S"),
            "permissions": oct(stat.st_mode)[-3:],
            "mime_type": "folder",
        })

    return jsonify({
        "name": os.path.basename(target_path),
        "path": target_path,
        "parent": os.path.dirname(target_path),
        "size": stat.st_size,
        "size_str": _human_size(stat.st_size),
        "ext": ext,
        "is_dir": False,
        "created": datetime.fromtimestamp(stat.st_ctime).strftime("%Y-%m-%d %H:%M:%S"),
        "modified": datetime.fromtimestamp(stat.st_mtime).strftime("%Y-%m-%d %H:%M:%S"),
        "permissions": oct(stat.st_mode)[-3:],
        "mime_type": mime_type or "unknown",
    })


def _get_dir_info(dir_path):
    """获取目录信息：总大小、递归文件数、递归目录数、直接子目录数、直接文件数"""
    total_size = 0
    total_files = 0
    total_dirs = 0
    sub_dirs = 0
    sub_files = 0
    try:
        for root, dirs, files in os.walk(dir_path):
            # 跳过 proc/sysfs/tmpfs 等伪文件系统，别把 /proc/kcore 的 128TB 算进总和
            dirs[:] = [d for d in dirs if not _in_pseudo_fs(os.path.join(root, d))]
            for f in files:
                fp = os.path.join(root, f)
                try:
                    total_size += os.stat(fp).st_size
                    total_files += 1
                except (OSError, PermissionError):
                    pass
            for d in dirs:
                total_dirs += 1
            # 直接子项
            if root == dir_path:
                sub_dirs = len([d for d in dirs if not d.startswith('.')])
                sub_files = len(files)
    except (OSError, PermissionError):
        pass
    return {
        "size": total_size,
        "total_files": total_files,
        "total_dirs": total_dirs,
        "sub_dirs": sub_dirs,
        "sub_files": sub_files,
    }

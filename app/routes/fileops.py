"""文件操作路由：创建 / 保存 / 重命名 / 移动 / 复制 / 新建文件夹 / 属性。"""
import os
import shutil
import mimetypes
import threading
import time
import uuid
from datetime import datetime

from flask import Blueprint, request, jsonify

from ..log import get_logger
from ..services.filecore import (
    safe_path, _invalidate_list_cache, _invalidate_dir_size, _human_size,
)


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
        with open(full_path, 'w', encoding='utf-8') as f:
            f.write(content)
        _invalidate_list_cache(parent_dir)
        _invalidate_dir_size(parent_dir)
        return jsonify({"success": True, "path": full_path, "size": os.path.getsize(full_path)})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


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

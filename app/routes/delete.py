"""删除 / 撤销删除 / 删除历史路由。"""
import hashlib
import os
import shutil
import threading
import time
import uuid

from flask import Blueprint, request, jsonify

from ..log import get_logger
from ..services.trash import (
    _load_delete_history, _save_delete_history, _get_trash_item_path, _safe_filename,
    _update_index_after_delete, _invalidate_all_dir_sizes, _DELETE_HISTORY_LOCK,
)
from ..services.filecore import _invalidate_list_cache
from ..services.db import _get_index_conn
from .fileops import _guard_protected_path


_log = get_logger()
bp = Blueprint("delete", __name__)


# ---------- 实时删除进度（任务制） ----------
_DELETE_TASKS = {}
_TASKS_LOCK = threading.Lock()


def _count_tree(path):
    """统计待删除的文件数与总字节数（用于进度计算）"""
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


def _task_bump(task, files=0, bytes_=0):
    with _TASKS_LOCK:
        task["done_files"] += files
        task["done_bytes"] += bytes_


def _copy_file_progress(src, dst, task):
    """跨设备复制单个文件，按字节实时上报进度"""
    try:
        size = os.path.getsize(src)
    except OSError:
        size = 0
    with _TASKS_LOCK:
        base_bytes = task["done_bytes"]
        task["current"] = os.path.basename(src)
    copied = 0
    with open(src, "rb") as fsrc, open(dst, "wb") as fdst:
        while True:
            chunk = fsrc.read(256 * 1024)
            if not chunk:
                break
            fdst.write(chunk)
            copied += len(chunk)
            with _TASKS_LOCK:
                task["done_bytes"] = base_bytes + copied
    try:
        shutil.copystat(src, dst)
    except OSError:
        pass
    try:
        os.remove(src)
    except OSError:
        pass
    with _TASKS_LOCK:
        task["done_files"] += 1
        task["done_bytes"] = base_bytes + size


def _truncate_utf8(s, max_bytes):
    """按字节数安全截断字符串（不切坏多字节字符）"""
    b = s.encode("utf-8", "surrogateescape")
    if len(b) <= max_bytes:
        return s
    return b[:max_bytes].decode("utf-8", "ignore")


def _fit_dst_path(dst_dir, name):
    """目标名过长时截断（保留扩展名 + 短哈希防重名），避免 Errno 36 文件名过长"""
    dname = os.path.basename(name) or name
    if len(dname.encode("utf-8", "surrogateescape")) <= 200:
        return os.path.join(dst_dir, dname)
    root, ext = os.path.splitext(dname)
    ext = _truncate_utf8(ext, 24)
    keep = max(200 - len(ext.encode("utf-8", "surrogateescape")) - 9, 10)
    short = _truncate_utf8(root, keep)
    tag = hashlib.md5(dname.encode("utf-8", "surrogateescape")).hexdigest()[:8]
    return os.path.join(dst_dir, f"{short}-{tag}{ext}")


def _move_tree_progress(src, dst, task):
    """递归移动目录/文件到回收站，逐文件上报进度（同盘 rename 秒移，跨盘复制计时）"""
    if os.path.isdir(src) and not os.path.islink(src):
        os.makedirs(dst, exist_ok=True)
        for name in os.listdir(src):
            try:
                _move_tree_progress(os.path.join(src, name), _fit_dst_path(dst, name), task)
            except Exception as e:
                # 单个条目失败不中断整个目录的删除
                with _TASKS_LOCK:
                    if len(task["errors"]) < 20:
                        task["errors"].append(f"{name}: {e}")
        try:
            os.rmdir(src)
        except OSError:
            pass
        return
    try:
        size = os.path.getsize(src)
    except OSError:
        size = 0
    with _TASKS_LOCK:
        task["current"] = os.path.basename(src)
    try:
        os.rename(src, dst)
        _task_bump(task, 1, size)
        return
    except OSError:
        pass
    if os.path.islink(src):
        try:
            os.symlink(os.readlink(src), dst)
            os.remove(src)
            _task_bump(task, 1, size)
            return
        except OSError:
            pass
    _copy_file_progress(src, dst, task)


def _delete_worker(task_id, valid_paths):
    task = _DELETE_TASKS[task_id]
    deleted, errors, deleted_abs, trash_items = [], [], [], []
    try:
        for rel_path in valid_paths:
            target_path = os.path.abspath(os.path.normpath(rel_path))
            if not os.path.exists(target_path):
                errors.append(f"{rel_path}: 文件不存在")
                continue
            if target_path == os.path.abspath(__file__):
                errors.append(f"{rel_path}: 不能删除脚本自身")
                continue
            try:
                with _TASKS_LOCK:
                    task["current"] = os.path.basename(target_path) or target_path
                trash_id = str(int(time.time() * 1000)) + "_" + str(abs(hash(target_path)) % 100000)
                trash_path = _get_trash_item_path(trash_id)
                is_dir = os.path.isdir(target_path)
                try:
                    file_size = 0 if is_dir else os.path.getsize(target_path)
                except OSError:
                    file_size = 0
                pf, pb = _count_tree(target_path)
                try:
                    os.rename(target_path, trash_path)  # 同盘整体秒移
                    _task_bump(task, pf, pb)
                except OSError:
                    # 跨设备或整体移动失败：逐文件移动并上报进度
                    _move_tree_progress(target_path, trash_path, task)
                deleted.append(rel_path)
                deleted_abs.append(target_path)
                _invalidate_list_cache(os.path.dirname(target_path))
                trash_items.append({
                    "id": trash_id,
                    "original_path": target_path,
                    "trash_path": trash_path,
                    "name": os.path.basename(target_path),
                    "is_dir": is_dir,
                    "size": file_size,
                    "deleted_at": int(time.time()),
                })
            except Exception as e:
                errors.append(f"{rel_path}: {str(e)}")
                with _TASKS_LOCK:
                    task["errors"] = list(errors)

        if deleted_abs:
            try:
                _update_index_after_delete(deleted_abs)
                _invalidate_all_dir_sizes(deleted_abs)
            except Exception:
                pass
        if trash_items:
            try:
                with _DELETE_HISTORY_LOCK:
                    history = _load_delete_history()
                    history.extend(trash_items)
                    if len(history) > 500:
                        history = history[-500:]
                    _save_delete_history(history)
            except Exception:
                pass
        with _TASKS_LOCK:
            task["status"] = "done_with_errors" if errors else "done"
            task["result"] = {
                "deleted": [os.path.basename(p) for p in deleted_abs],
                "errors": errors,
                "trash_items": trash_items,
            }
    except Exception as e:
        with _TASKS_LOCK:
            task["status"] = "error"
            task["result"] = {"deleted": [os.path.basename(p) for p in deleted_abs],
                              "errors": errors + [str(e)],
                              "trash_items": trash_items}


@bp.route("/api/delete/start", methods=["POST"])
def api_delete_start():
    """启动异步删除任务，返回 task_id 供前端轮询实时进度"""
    _log.info("POST /api/delete/start")
    data = request.get_json()
    if not data:
        return jsonify({"error": "无效请求"}), 400
    paths = data.get("paths", [])
    if not paths:
        return jsonify({"error": "未指定文件"}), 400
    valid = []
    for rel in paths:
        p = os.path.abspath(os.path.normpath(rel))
        if not os.path.exists(p):
            continue
        try:
            _guard_protected_path(p)
        except PermissionError:
            return jsonify({"error": f"禁止删除服务运行目录及其上级目录: {rel}"}), 403
        valid.append(rel)
    if not valid:
        return jsonify({"error": "没有可删除的文件"}), 400
    total_files = total_bytes = 0
    for rel in valid:
        f, b = _count_tree(os.path.abspath(os.path.normpath(rel)))
        total_files += f
        total_bytes += b
    task_id = uuid.uuid4().hex[:16]
    task = {
        "status": "running",
        "total_files": total_files,
        "total_bytes": total_bytes,
        "done_files": 0,
        "done_bytes": 0,
        "current": "",
        "errors": [],
        "started_at": time.time(),
    }
    with _TASKS_LOCK:
        now = time.time()
        for k in [k for k, v in _DELETE_TASKS.items() if now - v.get("started_at", 0) > 1800]:
            _DELETE_TASKS.pop(k, None)
        _DELETE_TASKS[task_id] = task
    threading.Thread(target=_delete_worker, args=(task_id, valid), daemon=True).start()
    return jsonify({"success": True, "task_id": task_id,
                    "total_files": total_files, "total_bytes": total_bytes})


@bp.route("/api/delete/progress")
def api_delete_progress():
    """查询删除任务实时进度"""
    task_id = request.args.get("task_id", "")
    with _TASKS_LOCK:
        task = _DELETE_TASKS.get(task_id)
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
    return jsonify({
        "status": snap["status"],
        "current": snap.get("current", ""),
        "done_files": done_files,
        "total_files": total_files,
        "done_bytes": done_bytes,
        "total_bytes": total_bytes,
        "percent": round(percent, 1),
        "errors": snap.get("errors", []),
        "result": snap.get("result"),
    })





@bp.route("/api/delete", methods=["POST"])
def api_delete():
    _log.info("POST /api/delete")
    data = request.get_json()
    if not data:
        return jsonify({"error": "无效请求"}), 400
    paths = data.get("paths", [])
    if not paths:
        return jsonify({"error": "未指定文件"}), 400
    deleted = []
    errors = []
    deleted_abs = []
    trash_items = []
    for rel_path in paths:
        target_path = os.path.abspath(os.path.normpath(rel_path))
        if not os.path.exists(target_path):
            errors.append(f"{rel_path}: 文件不存在")
            continue
        try:
            _guard_protected_path(target_path)
        except PermissionError:
            errors.append(f"{rel_path}: 禁止删除服务运行目录及其上级目录")
            continue
        script_path = os.path.abspath(__file__)
        if target_path == script_path:
            errors.append(f"{rel_path}: 不能删除脚本自身")
            continue
        try:
            # 生成唯一 trash id
            trash_id = str(int(time.time() * 1000)) + "_" + str(abs(hash(target_path)) % 100000)
            trash_path = _get_trash_item_path(trash_id)
            is_dir = os.path.isdir(target_path)
            file_size = os.path.getsize(target_path) if not is_dir else 0

            # 移动到回收站（跨设备时回退为复制+删除）
            moved = False
            try:
                if is_dir:
                    shutil.move(target_path, trash_path)
                else:
                    os.rename(target_path, trash_path)
                moved = True
            except OSError as e:
                if e.errno == 18 or 'cross-device' in str(e).lower():
                    # 跨文件系统：复制后删除原文件
                    try:
                        if is_dir:
                            shutil.copytree(target_path, trash_path)
                        else:
                            shutil.copy2(target_path, trash_path)
                        # 删除原文件
                        if is_dir:
                            shutil.rmtree(target_path, ignore_errors=True)
                        else:
                            os.remove(target_path)
                        moved = True
                    except Exception as e2:
                        raise e2  # 重新抛出，走下面的错误处理
                else:
                    raise  # 非跨设备错误，直接抛出

            deleted.append(rel_path)
            deleted_abs.append(target_path)
            _invalidate_list_cache(os.path.dirname(target_path))

            # 记录删除历史
            trash_items.append({
                "id": trash_id,
                "original_path": target_path,
                "trash_path": trash_path,
                "name": os.path.basename(target_path),
                "is_dir": is_dir,
                "size": file_size,
                "deleted_at": int(time.time()),
            })
        except Exception as e:
            errors.append(f"{rel_path}: {str(e)}")

    # 更新索引：删除对应记录，重新计算祖先目录大小
    if deleted_abs:
        _update_index_after_delete(deleted_abs)
        _invalidate_all_dir_sizes(deleted_abs)

    # 保存删除历史
    if trash_items:
        with _DELETE_HISTORY_LOCK:
            history = _load_delete_history()
            history.extend(trash_items)
            # 保留最近 500 条
            if len(history) > 500:
                history = history[-500:]
            _save_delete_history(history)

    return jsonify({"success": True, "deleted": deleted, "errors": errors, "trash_items": trash_items})


@bp.route("/api/undo-delete", methods=["POST"])
def api_undo_delete():
    """从回收站恢复文件或目录到原路径（5秒回退功能）"""
    _log.info("POST /api/undo-delete")
    data = request.get_json()
    if not data:
        return jsonify({"error": "无效请求"}), 400
    trash_id = data.get("trash_id", "")
    if not trash_id:
        return jsonify({"error": "未指定 trash_id"}), 400

    trash_path = _get_trash_item_path(trash_id)
    if not os.path.exists(trash_path):
        return jsonify({"error": f"回收站中找不到该项目: {trash_id}"}), 400

    with _DELETE_HISTORY_LOCK:
        history = _load_delete_history()

    record = None
    for i, item in enumerate(history):
        if item.get("id") == trash_id:
            record = item
            history.pop(i)
            break

    if record is None:
        # 回收站文件存在但历史记录丢失，尝试通过路径恢复
        record = {"original_path": trash_path, "trash_path": trash_path}

    original_path = record.get("original_path", "")
    try:
        # 确保父目录存在
        parent_dir = os.path.dirname(original_path)
        os.makedirs(parent_dir, exist_ok=True)

        # 检查原路径是否已存在（防止冲突）
        if os.path.exists(original_path):
            # 原路径被占用，移动到回收站的原始位置
            safe_name = _safe_filename(os.path.basename(original_path))
            fallback = os.path.join(parent_dir, safe_name + "_恢复冲突_" + str(int(time.time())))
            if os.path.isdir(trash_path):
                shutil.move(trash_path, fallback)
            else:
                os.rename(trash_path, fallback)
            return jsonify({"success": False, "error": "原路径已被占用，已恢复为: " + fallback})

        # 恢复文件到原位置
        if os.path.isdir(trash_path):
            shutil.move(trash_path, original_path)
        else:
            os.rename(trash_path, original_path)

        _invalidate_list_cache(parent_dir)

        # 更新索引：重新插入恢复的文件
        try:
            conn = _get_index_conn()
            st = os.stat(original_path)
            is_dir = os.path.isdir(trash_path)
            ext = os.path.splitext(os.path.basename(original_path))[1].lower().lstrip(".")
            conn.execute(
                "INSERT OR REPLACE INTO index_files (abs_path, name, ext, size, mtime, is_dir, parent_dir) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (original_path, os.path.basename(original_path), ext if not is_dir else '',
                 0 if is_dir else st.st_size, st.st_mtime, is_dir, os.path.dirname(original_path))
            )
            conn.commit()
            conn.close()
        except Exception:
            pass

        # 持久化更新后的历史记录
        with _DELETE_HISTORY_LOCK:
            _save_delete_history(history)

        return jsonify({"success": True, "message": "已恢复: " + original_path})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@bp.route("/api/delete-history")
def api_delete_history():
    """获取删除历史记录"""
    _log.info("GET /api/delete-history")
    with _DELETE_HISTORY_LOCK:
        history = _load_delete_history()
    # 反转：最新的在前
    history.reverse()
    # 检查回收站文件是否仍存在
    for item in history:
        item["exists"] = os.path.exists(item.get("trash_path", ""))
    return jsonify({"items": history, "count": len(history)})


@bp.route("/api/delete-history/clear", methods=["POST"])
def api_clear_delete_history():
    """清空回收站和删除历史"""
    _log.info("POST /api/delete-history/clear")
    with _DELETE_HISTORY_LOCK:
        history = _load_delete_history()

    removed = 0
    errors = 0
    for item in history:
        trash_path = item.get("trash_path", "")
        if os.path.exists(trash_path):
            try:
                if os.path.isdir(trash_path):
                    shutil.rmtree(trash_path, ignore_errors=True)
                else:
                    os.remove(trash_path)
                removed += 1
            except Exception:
                errors += 1

    with _DELETE_HISTORY_LOCK:
        _save_delete_history([])

    return jsonify({"success": True, "removed": removed, "errors": errors})


@bp.route("/api/delete-history/one", methods=["DELETE"])
def api_delete_history_one():
    """永久删除回收站中的单个项目"""
    _log.info("DELETE /api/delete-history/one")
    data = request.get_json()
    if not data:
        return jsonify({"error": "无效请求"}), 400
    trash_id = data.get("trash_id", "")
    if not trash_id:
        return jsonify({"error": "未指定 trash_id"}), 400

    trash_path = _get_trash_item_path(trash_id)

    with _DELETE_HISTORY_LOCK:
        history = _load_delete_history()

    record = None
    for i, item in enumerate(history):
        if item.get("id") == trash_id:
            record = item
            history.pop(i)
            break

    if record is None:
        return jsonify({"error": "历史记录中找不到该项目"}), 404

    try:
        if os.path.exists(trash_path):
            if os.path.isdir(trash_path):
                shutil.rmtree(trash_path, ignore_errors=True)
            else:
                os.remove(trash_path)

        with _DELETE_HISTORY_LOCK:
            _save_delete_history(history)

        return jsonify({"success": True, "removed": record.get("name", trash_id)})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

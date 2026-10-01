"""AI 文件改动回撤：改动前保存文件原状，支持按改动 id 恢复。

用法（在工具执行线程内）：
    undo.begin()
    ... 执行工具，写入前内部会调用 undo.snapshot(path) ...
    ids = undo.collect()      # 本次执行产生的改动 id 列表

之后前端可拿这些 id 调 /api/ai/undo 回撤（按相反顺序逐个恢复）。
快照保存在内存里，服务重启后失效；超出容量上限时自动淘汰最早的记录。
"""
import os
import threading
import time
import uuid

_LOCK = threading.Lock()
_STORE = {}                 # cid -> {"path","exists","data","ts"}
_ORDER = []                 # cid 先后顺序，用于淘汰
_MAX_ITEMS = 400            # 最多保留多少条快照
_MAX_FILE_BYTES = 5 * 1024 * 1024   # 单个文件超过该大小则不记录（无法回撤，会给出提示）

_local = threading.local()


def begin():
    """开始收集本次工具执行产生的改动 id。"""
    _local.sink = []


def collect():
    """结束收集并返回改动 id 列表。"""
    sink = getattr(_local, "sink", None)
    _local.sink = None
    return list(sink) if sink else []


def _trim_locked():
    while len(_ORDER) > _MAX_ITEMS:
        old = _ORDER.pop(0)
        _STORE.pop(old, None)


def snapshot(path):
    """记录 path 改动前的状态。返回 change id；不记录时返回 None。"""
    if not path:
        return None
    p = os.path.abspath(str(path))
    exists = os.path.isfile(p)
    data = None
    if exists:
        try:
            size = os.path.getsize(p)
        except OSError:
            return None
        if size > _MAX_FILE_BYTES:
            return None                     # 文件太大，放弃记录（回撤时提示该条不可用）
        try:
            with open(p, "rb") as f:
                data = f.read()
        except OSError:
            return None
    cid = uuid.uuid4().hex[:16]
    with _LOCK:
        _STORE[cid] = {"path": p, "exists": exists, "data": data, "ts": time.time()}
        _ORDER.append(cid)
        _trim_locked()
    sink = getattr(_local, "sink", None)
    if sink is not None:
        sink.append(cid)
    return cid


def restore(ids):
    """按相反顺序恢复一组改动；返回逐条结果。"""
    results = []
    for cid in reversed(list(ids or [])):
        with _LOCK:
            rec = _STORE.pop(str(cid), None)
            if cid in _ORDER:
                try:
                    _ORDER.remove(str(cid))
                except ValueError:
                    pass
        if not rec:
            results.append({"id": cid, "ok": False, "error": "该改动的备份已失效（服务可能已重启）"})
            continue
        p = rec["path"]
        try:
            if rec["exists"]:
                d = os.path.dirname(p)
                if d:
                    os.makedirs(d, exist_ok=True)
                with open(p, "wb") as f:
                    f.write(rec["data"] or b"")
                results.append({"id": cid, "ok": True, "path": p, "action": "restored"})
            else:
                if os.path.isfile(p):
                    os.remove(p)
                results.append({"id": cid, "ok": True, "path": p, "action": "removed"})
        except OSError as e:
            results.append({"id": cid, "ok": False, "path": p, "error": str(e)})
    return results

"""AI 文件改动回撤：改动前保存文件/目录原状，支持按改动 id 恢复。

覆盖两类改动：
  1. 工具写入 / 修改（write_file / edit_file）——写前快照单个文件；
  2. run_command 里的文件操作（rm / mkdir / mv / cp / > 重定向等）——执行前按
     命令里出现的路径做快照（文件或整个目录）。

用法（在工具执行线程内）：
    undo.begin()
    ... 执行工具，内部会调用 undo.snapshot / undo.snapshot_any ...
    ids = undo.collect()      # 本次执行产生的改动 id 列表

之后前端可拿这些 id 调 /api/ai/undo 回撤（按相反顺序逐个恢复）。
快照保存在内存里，服务重启后失效；超出容量上限时自动淘汰最早的记录。
"""
import glob
import os
import re
import shlex
import shutil
import threading
import time
import uuid

_LOCK = threading.Lock()
_STORE = {}                 # cid -> entry
_ORDER = []                 # cid 先后顺序，用于淘汰
_MAX_ITEMS = 400            # 最多保留多少条快照
_MAX_FILE_BYTES = 5 * 1024 * 1024      # 单文件超过该大小不记录
_MAX_TREE_BYTES = 30 * 1024 * 1024     # 单个目录快照的总大小上限
_MAX_TREE_FILES = 800                  # 单个目录快照的文件数上限
_MAX_PATHS = 60                        # 一条命令最多快照多少个路径

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


def _record(entry):
    cid = uuid.uuid4().hex[:16]
    with _LOCK:
        _STORE[cid] = entry
        _ORDER.append(cid)
        _trim_locked()
    sink = getattr(_local, "sink", None)
    if sink is not None:
        sink.append(cid)
    return cid


def _read_file_bytes(path):
    size = os.path.getsize(path)
    if size > _MAX_FILE_BYTES:
        return None
    with open(path, "rb") as f:
        return f.read()


def _snapshot_entry(path):
    """按 file / dir / absent 三种形态记录 path 当前状态；无法记录时抛异常。"""
    p = os.path.abspath(str(path))
    if not os.path.exists(p):
        return {"path": p, "kind": "absent"}
    if os.path.isfile(p):
        data = _read_file_bytes(p)
        if data is None:
            raise ValueError("文件过大")
        return {"path": p, "kind": "file", "data": data}
    if not os.path.isdir(p):
        raise ValueError("不支持的路径类型")
    files, dirs, total = {}, [], 0
    for dirpath, dirnames, filenames in os.walk(p):
        dirs.append(os.path.relpath(dirpath, p))
        for fn in filenames:
            full = os.path.join(dirpath, fn)
            try:
                total += os.path.getsize(full)
            except OSError:
                continue
            if total > _MAX_TREE_BYTES or len(files) >= _MAX_TREE_FILES:
                raise ValueError("目录过大")
            try:
                with open(full, "rb") as f:
                    files[os.path.relpath(full, p)] = f.read()
            except OSError:
                continue
    return {"path": p, "kind": "dir", "dirs": dirs, "files": files}


def snapshot(path):
    """记录「文件」改动前的状态（write_file / edit_file 用）。返回 change id 或 None。"""
    if not path:
        return None
    p = os.path.abspath(str(path))
    try:
        if os.path.isdir(p):
            return None
        entry = _snapshot_entry(p)
    except Exception:  # noqa: BLE001
        return None
    return _record(entry)


def snapshot_any(path):
    """记录任意路径（文件 / 目录 / 不存在）的状态。返回 change id 或 None。"""
    if not path:
        return None
    try:
        entry = _snapshot_entry(path)
    except Exception:  # noqa: BLE001
        return None
    return _record(entry)


_FILE_CMDS = ("rm", "rmdir", "mkdir", "touch", "truncate", "install", "ln", "mv", "cp",
              "tee", "dd", "sed", "rsync", "unzip", "tar", "gzip", "gunzip")
_REDIRECTS = (">", ">>", "1>", "2>", "1>>", "2>>")
_SUB_CMDS = ("sudo", "command", "nohup", "time", "env")


def _command_paths(command, root):
    """从 shell 命令里粗略提取会改动的路径（用于命令回撤）。

    支持 `cd x && rm y`、`a > f`、`mkdir -p d/e` 这类写法；只做启发式判断，
    目标是覆盖常见的文件操作，而不是完整解析 shell。
    """
    segments = re.split(r"\s*(?:&&|\|\||;|\n)\s*", str(command or ""))
    cwd = os.path.abspath(root or ".")
    picked = []

    def resolve(tok, base):
        t = str(tok).strip().strip("'\"")
        if not t or t.startswith("-") or t in _REDIRECTS + ("<", "|", "&"):
            return []
        if any(ch in t for ch in ("*", "?", "[")):
            pat = t if os.path.isabs(t) else os.path.join(base, t)
            try:
                return glob.glob(pat)
            except re.error:
                return []
        return [t if os.path.isabs(t) else os.path.join(base, t)]

    for seg in segments:
        try:
            tokens = shlex.split(seg)
        except ValueError:
            tokens = re.findall(r"[^\s]+", seg)
        if not tokens:
            continue
        cmd = os.path.basename(tokens[0])
        rest = tokens[1:]
        while cmd in _SUB_CMDS and rest:          # 跳过 sudo / env 等前缀
            cmd, rest = os.path.basename(rest[0]), rest[1:]
            tokens = tokens[1:]
        if cmd == "cd" and rest:                  # 跟踪 cd，后续相对路径基于新目录
            t = rest[0].strip().strip("'\"")
            if t not in ("-", "~"):
                cwd = t if os.path.isabs(t) else os.path.normpath(os.path.join(cwd, t))
            continue
        if cmd in _FILE_CMDS:
            for t in rest:
                picked.extend(resolve(t, cwd))
        else:                                     # 其他命令：只看像路径的参数
            for t in rest:
                if "/" in t or t.startswith("./") or t.startswith("../"):
                    picked.extend(resolve(t, cwd))
        for i, t in enumerate(tokens):            # 重定向目标：> file / >> file
            if t in _REDIRECTS and i + 1 < len(tokens):
                picked.extend(resolve(tokens[i + 1], cwd))

    seen, out = set(), []
    for p in picked:
        try:
            ap = os.path.abspath(p)
        except (OSError, ValueError):
            continue
        if ap in seen:
            continue
        seen.add(ap)
        out.append(ap)
        if len(out) >= _MAX_PATHS:
            break
    return out


def _with_missing_ancestors(path):
    """路径不存在时，连同它缺失的各级父目录一起返回（用于 mkdir -p 的完整回撤）。"""
    out = [path]
    cur = path
    while True:
        parent = os.path.dirname(cur)
        if not parent or parent == cur or os.path.exists(parent):
            break
        out.append(parent)
        cur = parent
    return out


def snapshot_for_command(command, root):
    """命令执行前的快照；返回 (change_ids, complete)。

    complete=False 表示有路径因过大等原因没能记录，回撤无法保证完整。
    """
    ids, complete = [], True
    for p in _command_paths(command, root):
        targets = _with_missing_ancestors(p) if not os.path.exists(p) else [p]
        for t in targets:
            cid = snapshot_any(t)
            if cid:
                ids.append(cid)
            else:
                complete = False
                break
    return ids, complete


def _restore_entry(rec):
    p = rec["path"]
    kind = rec.get("kind")
    if kind is None:                        # 兼容旧结构
        kind = "file" if rec.get("exists") else "absent"
        if kind == "file":
            rec = {"path": p, "kind": "file", "data": rec.get("data") or b""}
    if kind == "absent":
        if os.path.isdir(p) and not os.path.islink(p):
            shutil.rmtree(p, ignore_errors=True)
        elif os.path.exists(p):
            os.remove(p)
        return "removed"
    if kind == "file":
        d = os.path.dirname(p)
        if d:
            os.makedirs(d, exist_ok=True)
        with open(p, "wb") as f:
            f.write(rec.get("data") or b"")
        return "restored"
    # 目录：先删掉快照里没有的新增文件，再还原原有文件
    if not os.path.isdir(p):
        if os.path.exists(p):
            try:
                os.remove(p)
            except OSError:
                pass
        os.makedirs(p, exist_ok=True)
    keep = set(rec.get("files") or {})
    for dirpath, _dirnames, filenames in os.walk(p, topdown=False):
        rel_dir = os.path.relpath(dirpath, p)
        for fn in filenames:
            rel = fn if rel_dir == "." else os.path.normpath(os.path.join(rel_dir, fn))
            if rel not in keep:
                try:
                    os.remove(os.path.join(dirpath, fn))
                except OSError:
                    pass
    for rel, data in (rec.get("files") or {}).items():
        full = os.path.join(p, rel)
        d = os.path.dirname(full)
        if d:
            os.makedirs(d, exist_ok=True)
        with open(full, "wb") as f:
            f.write(data)
    return "restored"


def restore(ids):
    """按相反顺序恢复一组改动；返回逐条结果。"""
    results = []
    for cid in reversed(list(ids or [])):
        key = str(cid)
        with _LOCK:
            rec = _STORE.pop(key, None)
            if key in _ORDER:
                try:
                    _ORDER.remove(key)
                except ValueError:
                    pass
        if not rec:
            results.append({"id": cid, "ok": False, "error": "该改动的备份已失效（服务可能已重启）"})
            continue
        try:
            action = _restore_entry(rec)
            results.append({"id": cid, "ok": True, "path": rec.get("path"), "action": action})
        except OSError as e:
            results.append({"id": cid, "ok": False, "path": rec.get("path"), "error": str(e)})
    return results

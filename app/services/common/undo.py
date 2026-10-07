"""AI 文件改动回撤：改动前保存文件/目录原状，支持按改动 id 恢复。

覆盖两类改动：
  1. 工具写入 / 修改（write_file / edit_file）——写前快照单个文件；
  2. run_command 里的文件操作（rm / mkdir / mv / cp / > 重定向等）——执行前按
     命令里出现的路径做快照（文件或整个目录）。

用法（在工具执行线程内）：
    undo.begin()
    ... 执行工具，内部会调用 undo.snapshot / undo.snapshot_any ...
    changes = undo.finish(root)   # 结束收集，返回 [{id, path, action, ...}]

changes 里的 id 可用于 /api/ai/undo 回撤（按相反顺序逐个恢复），
也可用于 /api/ai/changes 查看差异。

快照持久化在统一存储库 data/storage/store.db 的 ai_undo_snapshots 表里，
服务重启后仍可回撤；超出条数 / 总大小 / 保存天数上限时自动淘汰最早的记录。
（原独立库 .file_manager_ai_undo.db 由 store_db.migrate_sqlite_once() 首次启动时一次性搬入。）
"""
import difflib
import glob
import os
import pickle
import re
import shlex
import shutil
import threading
import time
import uuid
import zlib

from .store_db import store_conn

_LOCK = threading.Lock()          # 串行化写操作（sqlite 每次独立连接，锁只保护读改写逻辑）

_MAX_ITEMS = 300                  # 最多保留多少条快照
_MAX_AGE_DAYS = 7                 # 快照保存天数
_MAX_TOTAL_BYTES = 300 * 1024 * 1024   # 快照库总大小上限（超出淘汰最早的）
_MAX_FILE_BYTES = 5 * 1024 * 1024      # 单文件超过该大小不记录
_MAX_TREE_BYTES = 30 * 1024 * 1024     # 单个目录快照的总大小上限
_MAX_TREE_FILES = 800                  # 单个目录快照的文件数上限
_MAX_PATHS = 60                        # 一条命令最多快照多少个路径
_MAX_DIFF_CHARS = 120_000              # 单个文件差异文本的字符上限
_MAX_DIFF_BYTES = 1 * 1024 * 1024      # after 内容超过该大小不参与差异计算

_ACTION_LABEL = {"created": "新建", "modified": "修改", "deleted": "删除"}

_local = threading.local()
_init_done = False


def _conn():
    """连接统一存储库（表结构见 store_db._SCHEMA）"""
    return store_conn()


def _init():
    """表已随 store_db 建好，这里只保留调用点。"""
    global _init_done
    _init_done = True


# ---------------------------------------------------------------- 收集（线程内）
def begin():
    """开始收集本次工具执行产生的改动 id。"""
    _local.sink = []


def collect():
    """结束收集并返回改动 id 列表。"""
    sink = getattr(_local, "sink", None)
    _local.sink = None
    return list(sink) if sink else []


# ---------------------------------------------------------------- 存储
def _dumps(obj):
    return zlib.compress(pickle.dumps(obj, protocol=4), 6)


def _loads(blob):
    if not blob:
        return None
    try:
        return pickle.loads(zlib.decompress(bytes(blob)))
    except Exception:  # noqa: BLE001
        return None


def _trim(conn):
    """按条数 / 总大小 / 保存天数淘汰最早的快照。"""
    conn.execute("DELETE FROM ai_undo_snapshots WHERE created_at < ?",
                 (time.time() - _MAX_AGE_DAYS * 86400,))
    conn.execute(
        "DELETE FROM ai_undo_snapshots WHERE cid NOT IN "
        "(SELECT cid FROM ai_undo_snapshots ORDER BY created_at DESC LIMIT ?)",
        (_MAX_ITEMS,))
    total = conn.execute("SELECT COALESCE(SUM(data_len), 0) FROM ai_undo_snapshots").fetchone()[0] or 0
    while total > _MAX_TOTAL_BYTES:
        old = conn.execute(
            "SELECT cid, data_len FROM ai_undo_snapshots ORDER BY created_at ASC LIMIT 1").fetchone()
        if not old:
            break
        conn.execute("DELETE FROM ai_undo_snapshots WHERE cid=?", (old[0],))
        total -= old[1] or 0


def _record(entry):
    _init()
    cid = uuid.uuid4().hex[:16]
    blob = _dumps(entry)
    conn = _conn()
    try:
        with _LOCK:
            conn.execute(
                "INSERT INTO ai_undo_snapshots(cid, path, kind, before, action, data_len, created_at) "
                "VALUES(?,?,?,?,?,?,?)",
                (cid, entry["path"], entry.get("kind") or "absent", blob, "", len(blob), time.time()))
            _trim(conn)
            conn.commit()
    finally:
        conn.close()
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
    for dirpath, _dirnames, filenames in os.walk(p):
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


# ---------------------------------------------------------------- 命令路径识别
# 会改动文件的命令：执行前必须按参数里的路径快照，否则 rm / mv / cp / > 造成的
# 删除、新建既无法回撤，也不会出现在消息下方的「文件变更」模块里。
# 值 = 路径当前不存在时是否也要快照（True：该位置是「将要被创建」的，缺失状态才有意义）。
_CMD_WRITE = {
    "rm": False, "rmdir": False, "unlink": False, "truncate": False, "sed": False,
    "chmod": False, "chown": False, "gzip": False, "gunzip": False, "tar": False,
    "mv": True, "cp": True, "install": True, "rsync": True, "ln": True,
    "mkdir": True, "touch": True, "tee": True, "zip": True, "unzip": True, "dd": True,
}
_CMD_OPS = (";", "&&", "||", "|", "&")
_SHELL_META = set("*?[]{}$`\"'\\<>|&;()")


def _cmd_tokens(cmd):
    """shell 命令 → token 列表（保留 ; | & < > 等运算符，引号内内容不拆）。"""
    try:
        lx = shlex.shlex(cmd, posix=True, punctuation_chars=";|&<>")
        lx.whitespace_split = True
        lx.commenters = ""
        return list(lx)
    except ValueError:
        return []


def _expand_cmd_path(tok, root):
    """命令参数 → 真实绝对路径列表（通配符展开；明显不是路径时返回空）。"""
    t = str(tok or "").strip()
    if not t or t.startswith("-") or t == "/dev/null":
        return []
    if any(ch in t for ch in "*?["):                      # rm -rf data/*.db 之类
        pat = t if os.path.isabs(t) else os.path.join(root or ".", t)
        return [os.path.abspath(p) for p in sorted(glob.glob(pat))][:_MAX_PATHS]
    if any(ch in t for ch in _SHELL_META):
        return []                                         # 还含 shell 元字符：不是普通路径
    if "=" in t and "/" not in t:
        return []                                         # dd bs=1M 之类的 k=v 参数
    p = os.path.expanduser(t)
    if not os.path.isabs(p):
        p = os.path.join(root or os.getcwd(), p)
    return [os.path.abspath(os.path.normpath(p))]


def _inside_root(path, root_abs):
    if not root_abs:
        return True
    try:
        return os.path.commonpath([path, root_abs]) == root_abs
    except ValueError:
        return False


def _paths_in_command(cmd, root=""):
    """从 shell 命令里保守识别可能被改动的路径（按出现顺序去重）。

    只认「写操作子命令的参数」和「重定向目标」：识别不到只是不记录该改动，
    不会误判成改动。项目（root）之外的路径不记录——与「文件变更」展示范围一致，
    也避免误快照系统巨量目录。
    """
    root_abs = os.path.abspath(root) if root else ""
    out, seen = [], set()

    def add(p, allow_missing):
        if len(out) >= _MAX_PATHS:
            return
        if root_abs and not _inside_root(p, root_abs):
            return
        if not os.path.exists(p):
            if not allow_missing:
                return          # rm / sed 这类命令：路径本来就不存在，无需记录
            if not os.path.isdir(os.path.dirname(p) or "/"):
                return          # 父目录不存在：多半不是真路径（例如 sed 的替换表达式）
        if p in seen:
            return
        seen.add(p)
        out.append(p)

    toks = _cmd_tokens(cmd)
    argv = []
    cwd = root_abs or os.getcwd()      # 跟随命令里的 cd，保证相对路径解析正确

    def scan():
        """识别一条简单命令（argv[0] 是写操作命令时，快照它的路径参数）。"""
        nonlocal cwd
        if not argv:
            return
        name = os.path.basename(argv[0])
        if name == "cd":               # cd 改变后续相对路径的基准
            if len(argv) > 1 and not argv[1].startswith("-"):
                for p in _expand_cmd_path(argv[1], cwd):
                    if os.path.isdir(p):
                        cwd = p
            return
        allow_missing = _CMD_WRITE.get(name)
        if allow_missing is None:
            return
        for a in argv[1:]:
            for p in _expand_cmd_path(a, cwd):
                add(p, allow_missing)

    i = 0
    while i < len(toks):
        t = toks[i]
        if t and t[-1] == ">" and all(ch in "<>&0123456789" for ch in t):
            # 重定向（> 、>> 、2> 、&>）：紧随其后的 token 是要写入的路径
            if i + 1 < len(toks) and t.find(">") >= 0:
                for p in _expand_cmd_path(toks[i + 1], cwd):
                    add(p, True)
            i += 2 if i + 1 < len(toks) else 1
            continue
        if t in _CMD_OPS:
            scan()
            argv = []
            i += 1
            continue
        argv.append(t)
        i += 1
    scan()
    return out


def snapshot_for_command(cmd, root=""):
    """执行命令前调用：按命令里出现的路径逐个快照。

    返回 (ids, complete)：ids 是快照记录 id（会被 undo.collect() 一并收集，
    供回撤与「文件变更」模块）；complete=False 表示有路径过大等原因没记全。
    """
    if not cmd:
        return [], True
    paths = _paths_in_command(cmd, root)
    ids = []
    complete = len(paths) < _MAX_PATHS
    for p in paths[:_MAX_PATHS]:
        cid = snapshot_any(p)
        if cid:
            ids.append(cid)
        else:
            complete = False
    return ids, complete


def annotate(ids):
    """工具执行后调用：对照快照与当前磁盘状态，推断每个改动的动作类型，
    并保存「改后内容 + 差异文本」到数据库（目录型快照只记动作，不生成差异）。"""
    _init()
    for cid in ids:
        conn = _conn()
        try:
            row = conn.execute(
                "SELECT path, kind, before, action FROM ai_undo_snapshots WHERE cid=?",
                (str(cid),)).fetchone()
            if not row or row[3]:                     # 不存在或已标注过
                continue
            path, kind = row[0], row[1]
            before = _loads(row[2])
            action, after, diff, trunc = "", None, "", 0
            if not os.path.exists(path):
                if kind != "absent":
                    action = "deleted"
                    if kind == "file":
                        diff, _, _, _ = _diff_text(before.get("data") if isinstance(before, dict) else None,
                                                   None, os.path.basename(path))
                else:
                    action = "unchanged"              # 快照时就不存在，之后也不存在：无变化
            elif os.path.isdir(path):
                action = "created" if kind == "absent" else "modified"
            else:
                try:
                    after = _read_file_bytes(path)
                except OSError:
                    after = None
                if after is not None:
                    before_data = before.get("data") if isinstance(before, dict) else None
                    if kind == "absent":
                        action = "created"
                    else:
                        action = "modified" if (kind != "file" or before_data != after) else "unchanged"
                    if action != "unchanged" and len(after) <= _MAX_DIFF_BYTES:
                        rel = before.get("_rel") if isinstance(before, dict) else None
                        diff, _, _, trunc = _diff_text(before_data, after, rel or os.path.basename(path))
                else:
                    action = "modified"               # 文件过大读不回：至少标记为修改
            after_blob = _dumps({"data": after}) if after is not None else None
            conn.execute(
                "UPDATE ai_undo_snapshots SET action=?, after=?, diff=?, truncated=?, rel=?, "
                "data_len=data_len+? WHERE cid=?",
                (action, after_blob, diff, 1 if trunc else 0,
                 (before.get("_rel") or "") if isinstance(before, dict) else "",
                 len(after_blob) if after_blob else 0, str(cid)))
            conn.commit()
        except Exception:  # noqa: BLE001
            pass
        finally:
            conn.close()


def _diff_text(before, after, rel):
    """两份字节内容 → unified diff 文本 + 增删行数 + 是否截断。"""
    tb, ta = _as_lines(before), _as_lines(after)
    if tb is None or ta is None:
        return "（二进制文件变更，不显示差异）", 0, 0, False
    lines = list(difflib.unified_diff(tb, ta, fromfile="a/" + rel, tofile="b/" + rel, lineterm=""))
    total = sum(len(l) + 1 for l in lines)
    trunc = False
    if total > _MAX_DIFF_CHARS:
        acc, out = 0, []
        for l in lines:
            acc += len(l) + 1
            if acc > _MAX_DIFF_CHARS:
                break
            out.append(l)
        lines = out + ["", "（差异内容过大，已截断）"]
        trunc = True
    diff = "\n".join(lines)
    adds = sum(1 for l in lines if l.startswith("+") and not l.startswith("+++"))
    dels = sum(1 for l in lines if l.startswith("-") and not l.startswith("---"))
    return diff, adds, dels, trunc


def _as_lines(data):
    """字节内容 → 文本行；二进制返回 None。"""
    if data is None:
        return []
    if b"\x00" in data[:4096]:
        return None
    return data.decode("utf-8", "replace").splitlines()


def _rel_of(path, rel, root_abs):
    """绝对路径 → 项目内相对路径（不在项目内则原样返回）。"""
    if rel:
        return rel
    if not root_abs:
        return path
    try:
        rp = os.path.relpath(path, root_abs)
        if not rp.startswith(".."):
            return rp
    except ValueError:
        pass
    return path


def describe(ids, root="", with_diff=False):
    """把一组改动 id 整理为描述列表；root 用于把绝对路径转成项目内相对路径。

    with_diff=False：逐条列出（供 SSE 过程流推送）。
    with_diff=True：按文件聚合为「净变更」——同一文件先新建又多次修改时，
    差异 = 最早快照的改前状态 → 最后一次的改后状态（新建 + 修改的集合体）。
    """
    _init()
    root_abs = os.path.abspath(root) if root else ""
    rows = []
    conn = _conn()
    try:
        for cid in ids or []:
            r = conn.execute(
                "SELECT cid, path, kind, before, after, action, diff, truncated, rel "
                "FROM ai_undo_snapshots WHERE cid=?", (str(cid),)).fetchone()
            if r:
                rows.append(r)
    finally:
        conn.close()
    if not with_diff:
        out = []
        for cid, path, kind, _before, _after, action, _diff, _trunc, rel in rows:
            if kind == "dir":                     # 目录快照只用于回撤，不作为文件变更展示
                continue
            action = action or "modified"
            if action == "unchanged":
                continue
            out.append({"id": cid, "path": _rel_of(path, rel, root_abs), "action": action})
        return out
    # 聚合：按路径分组，合成净变更
    groups, order = {}, []
    for cid, path, kind, before, after, action, diff, trunc, rel in rows:
        if kind == "dir":
            continue
        action = action or "modified"
        if action == "unchanged":
            continue
        p = _rel_of(path, rel, root_abs)
        if p not in groups:
            groups[p] = {"first": None, "last": None, "ids": []}
            order.append(p)
        g = groups[p]
        if g["first"] is None:
            g["first"] = {"kind": kind, "before": _loads(before)}
        g["last"] = {"after": (_loads(after) or {}).get("data") if after else None,
                     "action": action, "diff": diff}
        g["ids"].append(cid)
    out = []
    for p in order:
        g = groups[p]
        first, last = g["first"], g["last"]
        last_action = last["action"] or "modified"
        if last_action == "deleted":
            if first["kind"] == "absent":
                continue                          # 本轮内新建又删除：净效果为零，不显示
            action = "deleted"
        elif first["kind"] == "absent":
            action = "created"
        else:
            action = "modified"
        before_data = first["before"].get("data") if isinstance(first["before"], dict) else None
        after_data = last["after"]
        item = {"id": g["ids"][-1], "path": p, "action": action,
                "ids": g["ids"], "action_label": _ACTION_LABEL.get(action, action)}
        if last_action == "deleted":
            diff, adds, dels, trunc = _diff_text(before_data, None, p)
        elif after_data is None or len(after_data) > _MAX_DIFF_BYTES:
            diff, adds, dels, trunc = "（文件内容过大或未记录，不显示差异）", 0, 0, False
        else:
            diff, adds, dels, trunc = _diff_text(before_data, after_data, p)
        item.update({"diff": diff, "additions": adds, "deletions": dels, "truncated": trunc})
        out.append(item)
    return out


def finish(root=""):
    """工具执行完毕的收尾：收集 → 推断动作与差异 → 返回描述（不含差异文本，供 SSE 推送）。"""
    ids = collect()
    if not ids:
        return []
    annotate(ids)
    return describe(ids, root, with_diff=False)


# ---------------------------------------------------------------- 恢复
def _restore_payload(payload):
    """把改前快照（file/dir/absent 的 pickle 内容）恢复到磁盘。返回动作描述。"""
    if not isinstance(payload, dict):
        return "skipped"
    p = payload["path"]
    kind = payload.get("kind")
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
            f.write(payload.get("data") or b"")
        return "restored"
    # 目录：先删掉快照里没有的新增文件，再还原原有文件
    if not os.path.isdir(p):
        if os.path.exists(p):
            try:
                os.remove(p)
            except OSError:
                pass
        os.makedirs(p, exist_ok=True)
    keep = set(payload.get("files") or {})
    for dirpath, _dirnames, filenames in os.walk(p, topdown=False):
        rel_dir = os.path.relpath(dirpath, p)
        for fn in filenames:
            rel = fn if rel_dir == "." else os.path.normpath(os.path.join(rel_dir, fn))
            if rel not in keep:
                try:
                    os.remove(os.path.join(dirpath, fn))
                except OSError:
                    pass
    for rel, data in (payload.get("files") or {}).items():
        full = os.path.join(p, rel)
        d = os.path.dirname(full)
        if d:
            os.makedirs(d, exist_ok=True)
        with open(full, "wb") as f:
            f.write(data)
    return "restored"


def restore(ids):
    """按相反顺序恢复一组改动；返回逐条结果。"""
    _init()
    results = []
    for cid in reversed(list(ids or [])):
        key = str(cid)
        conn = _conn()
        try:
            with _LOCK:
                row = conn.execute(
                    "SELECT path, kind, before FROM ai_undo_snapshots WHERE cid=?", (key,)).fetchone()
                if row:
                    conn.execute("DELETE FROM ai_undo_snapshots WHERE cid=?", (key,))
                    conn.commit()
            if not row:
                results.append({"id": cid, "ok": False, "error": "该改动的备份不存在或已被恢复/清理"})
                continue
            path, _kind, before = row
            payload = _loads(before)
            try:
                action = _restore_payload(payload)
                results.append({"id": cid, "ok": True, "path": path, "action": action})
            except OSError as e:
                results.append({"id": cid, "ok": False, "path": path, "error": str(e)})
        except Exception as e:  # noqa: BLE001
            results.append({"id": cid, "ok": False, "error": str(e)})
        finally:
            conn.close()
    return results

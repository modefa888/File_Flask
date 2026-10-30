"""下载中心服务（store.db 的 dl_tasks / dl_cfg 表）。

一次「下载」= 一条 dl_tasks 记录，同时充当任务与记录：

    kind = file   单文件：直接以源文件作为下发产物，不复制、不占用额外磁盘
    kind = zip    多文件 / 文件夹：后台线程打包成 zip，产物落到「下载产物目录」
    kind = text   文本另存：把界面上的内容直接写成文件再下发

产物（artifact）准备好后，前端通过 /api/dl/stream/<id> 拉取；
该接口支持 HTTP Range（206 Partial Content），因此：

    · 内置下载引擎可以带 Range 续传（配合 File System Access API 真正写盘续写）；
    · 浏览器原生下载 / aria2 / IDM 等外部下载器同样能续传。

`done` 字段是续传游标（已传输字节），由前端上报，服务端在流式下发时也会兜底累加。
"""
import datetime
import json
import os
import shutil
import threading
import time
import uuid
import zipfile

from ... import config
from ...log import get_logger
from .store_db import store_conn, store_tx

_log = get_logger()

# 打包产物根目录（每个任务一个子目录，便于整任务清理）
ARTIFACT_ROOT = os.path.join(config.DATA_ROOT, ".file_manager_downloads")
try:
    os.makedirs(ARTIFACT_ROOT, exist_ok=True)
except OSError as e:
    _log.warning("创建下载产物目录失败：%s", e)

_MAX_ITEMS = 4000                  # 单个任务最多选中多少个来源条目
_MAX_ENTRIES = 200000              # 单个任务打包时的文件条目上限
_CHUNK = 1024 * 1024               # 打包 / 下发分块
_PROGRESS_MIN_INTERVAL = 0.5       # 进度落库最小间隔（秒）

# 打包线程的取消标记（用户点「取消」时置位）
_CANCEL = set()
_CANCEL_LOCK = threading.Lock()

# 正在下发的任务：{task_id: {"start": ..., "sent": ...}}，用于流式兜底统计
_STREAMING = {}

# 过期清理线程（惰性启动）
_SWEEPER = {"thread": None, "lock": threading.Lock()}

ACTIVE_STATUS = ("pending", "building", "ready", "downloading", "paused")
DONE_STATUS = ("done",)
BAD_STATUS = ("failed", "canceled")

# 模块设置默认值（前端「设置」页可改，存 dl_cfg 的 cfg 键）
_DEFAULTS = {
    "artifact_dir": ARTIFACT_ROOT,   # 打包产物落地目录（可视化选择）
    "keep_days": 7,                  # 产物保留天数（0 = 不自动清理）
    "max_rows": 500,                 # 记录最多保留条数
    "resume": True,                  # 断点续传（关闭后每次都从头下载）
    "use_fs": True,                  # 优先用「另存为」句柄（可跨刷新续写）
    "auto_start": True,              # 新建任务后立即开始
    "notify": True,                  # 下载完成 / 失败时提示
    "concurrency": 2,                # 同时下载几个任务（1–5）
    "throttle_kbps": 0,              # 限速（KB/s，0 = 不限）
    "zip_level": 6,                  # zip 压缩级别（0 = 仅存储）
    "include_hidden": False,         # 打包时包含点开头的隐藏文件
    "keep_structure": True,          # 保留目录结构（关掉 = 扁平化）
    "threads": 8,                    # 网络下载默认线程数（1–32）
    "save_dir": ARTIFACT_ROOT,       # 网络下载默认保存目录
    "user_agent": "",                # 网络下载默认 UA（空 = 内置浏览器 UA）
    "proxy": "",                     # 网络下载代理（如 http://127.0.0.1:7890）
}


# ----------------------------------------------------------------------
# 小工具
# ----------------------------------------------------------------------
def _now_ts():
    return datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _row(r):
    d = dict(r)
    try:
        d["src"] = json.loads(d.get("src") or "[]")
    except (TypeError, ValueError):
        d["src"] = []
    try:
        d["opts"] = json.loads(d.get("opts") or "{}")
    except (TypeError, ValueError):
        d["opts"] = {}
    try:
        d["segs"] = json.loads(d.get("segs") or "[]")
    except (TypeError, ValueError):
        d["segs"] = []
    try:
        d["meta"] = json.loads(d.get("meta") or "{}")
    except (TypeError, ValueError):
        d["meta"] = {}
    d["size"] = int(d.get("size") or 0)
    d["done"] = int(d.get("done") or 0)
    d["hits"] = int(d.get("hits") or 0)
    d["threads"] = int(d.get("threads") or 0)
    d["srv_done"] = int(d.get("srv_done") or 0)
    d["srv_size"] = int(d.get("srv_size") or 0)
    d["speed"] = int(d.get("speed") or 0)
    d["exists"] = bool(d.get("artifact")) and os.path.exists(d.get("artifact") or "")
    if d["size"] > 0:
        d["pct"] = max(0.0, min(100.0, round(d["done"] * 100.0 / d["size"], 2)))
    else:
        d["pct"] = 0.0
    d["srv_pct"] = (max(0.0, min(100.0, round(d["srv_done"] * 100.0 / d["srv_size"], 2)))
                    if d["srv_size"] > 0 else 0.0)
    return d


def _task_conn_get(tid):
    conn = store_conn()
    try:
        r = conn.execute("SELECT * FROM dl_tasks WHERE id=?", (tid,)).fetchone()
    finally:
        conn.close()
    return _row(r) if r else None


def get(tid):
    return _task_conn_get(str(tid or ""))


def find_by_url(url):
    """找出链接完全相同的任务（「同一链接只保留一个任务」的查重用）。"""
    u = str(url or "").strip()
    if not u:
        return []
    try:
        conn = store_conn()
        try:
            rows = conn.execute("SELECT * FROM dl_tasks WHERE url=? ORDER BY ts DESC", (u,)).fetchall()
        finally:
            conn.close()
        return [_row(r) for r in rows]
    except Exception as e:
        _log.warning("按链接查询任务失败：%s", e)
        return []


def _update(tid, **kw):
    """按需更新若干列（列名来自代码内部，不接受外部拼接）。"""
    cols = [k for k in kw if k]
    if not cols:
        return
    sets = ", ".join("%s=?" % c for c in cols)
    args = []
    for c in cols:
        v = kw[c]
        if c in ("opts", "meta") and not isinstance(v, str):
            v = json.dumps(v, ensure_ascii=False)
        if c in ("src", "segs") and isinstance(v, (list, tuple)):
            v = json.dumps(list(v), ensure_ascii=False)
        args.append(v)
    args.append(tid)
    try:
        with store_tx() as conn:
            conn.execute("UPDATE dl_tasks SET " + sets + ", updated=? WHERE id=?",
                         args[:-1] + [time.time(), args[-1]])
    except Exception as e:
        _log.warning("更新下载任务 %s 失败：%s", tid, e)


def _new_id():
    return uuid.uuid4().hex[:12]


def _safe_name(name, fallback="download"):
    name = os.path.basename(str(name or "").replace("\\", "/")).strip()
    name = "".join(ch for ch in name if ch not in '<>:"|?*\r\n\t')
    name = name.strip(". ") or fallback
    return name[:180]


def _unique_arc(used, arc):
    """同一压缩包内重名时自动加序号（来自不同目录的同名文件）。"""
    if arc not in used:
        used.add(arc)
        return arc
    stem, ext = os.path.splitext(arc)
    i = 2
    while True:
        cand = "%s (%d)%s" % (stem, i, ext)
        if cand not in used:
            used.add(cand)
            return cand
        i += 1


def _zip_ext():
    return ".zip"


def _within(path, root):
    try:
        path = os.path.abspath(path)
        root = os.path.abspath(root)
        return path == root or path.startswith(root + os.sep)
    except Exception:
        return False


# ----------------------------------------------------------------------
# 来源扫描
# ----------------------------------------------------------------------
def _collect(items, include_hidden=False, keep_structure=True, base_dir=""):
    """把选中的路径展开成 [(绝对路径, 压缩包内路径, 是否目录, 字节数)]。

    返回 (entries, total_bytes, dirs, warnings)。单文件不展开目录。
    """
    entries, total, warnings = [], 0, []
    used = set()
    dir_count = 0
    for src in items:
        src = os.path.abspath(src)
        if not os.path.exists(src):
            warnings.append("已跳过（不存在）：%s" % src)
            continue
        if os.path.isfile(src):
            arc = _safe_name(os.path.basename(src))
            if keep_structure and base_dir and _within(src, base_dir):
                rel = os.path.relpath(src, base_dir).replace(os.sep, "/")
                arc = rel
            arc = _unique_arc(used, arc)
            try:
                sz = os.path.getsize(src)
            except OSError:
                sz = 0
            entries.append((src, arc, False, sz))
            total += sz
            continue
        # 目录：按「目录名/相对路径」保留结构
        root_name = _safe_name(os.path.basename(src) or "folder", "folder")
        dir_count += 1
        for dirpath, dirnames, filenames in os.walk(src, followlinks=False):
            if not include_hidden:
                dirnames[:] = [d for d in dirnames if not d.startswith(".")]
            dirnames.sort()
            filenames.sort()
            if _within(dirpath, ARTIFACT_ROOT):
                dirnames[:] = []          # 不把自己打包进自己
                continue
            rel_dir = os.path.relpath(dirpath, src)
            arc_dir = root_name if rel_dir == "." else root_name + "/" + rel_dir.replace(os.sep, "/")
            if not filenames and not dirnames:
                entries.append((dirpath, arc_dir + "/", True, 0))
            for fn in filenames:
                if not include_hidden and fn.startswith("."):
                    continue
                full = os.path.join(dirpath, fn)
                if os.path.islink(full) or not os.path.isfile(full):
                    continue
                try:
                    sz = os.path.getsize(full)
                except OSError:
                    warnings.append("已跳过（无法读取）：%s" % full)
                    continue
                arc = arc_dir + "/" + _safe_name(fn)
                entries.append((full, _unique_arc(used, arc), False, sz))
                total += sz
                if len(entries) > _MAX_ENTRIES:
                    raise ValueError("文件数量超过上限（%d），请缩小选择范围后再试" % _MAX_ENTRIES)
    return entries, total, dir_count, warnings


# ----------------------------------------------------------------------
# 打包线程
# ----------------------------------------------------------------------
def _cancel_requested(tid):
    with _CANCEL_LOCK:
        return tid in _CANCEL


def _build_zip(tid, entries, total, out_path, zip_level):
    """后台打包：分块写入并持续更新 done / phase，前端能实时看到进度。"""
    done = 0
    last = 0.0
    try:
        comp = zipfile.ZIP_STORED if int(zip_level) <= 0 else zipfile.ZIP_DEFLATED
        level = max(0, min(9, int(zip_level)))
        parent = os.path.dirname(out_path)
        if parent:
            os.makedirs(parent, exist_ok=True)
        _update(tid, status="building", phase="正在压缩 · %d 个条目" % len(entries),
                size=int(total), done=0)
        with zipfile.ZipFile(out_path, "w", comp, compresslevel=level, allowZip64=True) as zf:
            for abs_p, arc, is_dir, sz in entries:
                if _cancel_requested(tid):
                    raise _Cancelled()
                if is_dir:
                    try:
                        zf.writestr(arc, b"")
                    except Exception as e:
                        _log.warning("写入空目录 %s 失败：%s", arc, e)
                    continue
                try:
                    with open(abs_p, "rb") as src, zf.open(arc, "w", force_zip64=sz > 2 * 1024 ** 3) as dst:
                        while True:
                            if _cancel_requested(tid):
                                raise _Cancelled()
                            buf = src.read(_CHUNK)
                            if not buf:
                                break
                            dst.write(buf)
                            done += len(buf)
                            now = time.time()
                            if now - last >= _PROGRESS_MIN_INTERVAL:
                                last = now
                                _update(tid, done=done)
                except _Cancelled:
                    raise
                except (OSError, PermissionError) as e:
                    _log.warning("打包跳过 %s：%s", abs_p, e)
        size = os.path.getsize(out_path)
        _update(tid, status="ready", phase="", done=0, size=size,
                artifact=out_path, error="")
    except _Cancelled:
        try:
            if os.path.isfile(out_path):
                os.remove(out_path)
        except OSError:
            pass
        _update(tid, status="canceled", phase="", error="已取消")
    except Exception as e:
        _log.warning("打包任务 %s 失败：%s", tid, e)
        try:
            if os.path.isfile(out_path):
                os.remove(out_path)
        except OSError:
            pass
        _update(tid, status="failed", phase="", error=str(e)[:300])


class _Cancelled(Exception):
    pass


# ----------------------------------------------------------------------
# 创建任务
# ----------------------------------------------------------------------
def _create_text(name, opts, cfg, user, ip):
    """文本另存：把传入的内容写成文件后作为下载产物（不涉及来源目录）。"""
    content = str(opts.get("content") or "")
    tid = _new_id()
    art_dir = cfg.get("artifact_dir") or ARTIFACT_ROOT
    try:
        os.makedirs(art_dir, exist_ok=True)
    except OSError:
        art_dir = ARTIFACT_ROOT
        os.makedirs(art_dir, exist_ok=True)
    task_dir = os.path.join(art_dir, tid)
    os.makedirs(task_dir, exist_ok=True)
    dl_name = _safe_name(name or "未命名.txt", "未命名.txt")
    out_path = os.path.join(task_dir, dl_name)
    with open(out_path, "w", encoding="utf-8", newline="") as f:
        f.write(content)
    row = {
        "id": tid, "ts": _now_ts(), "kind": "text", "name": dl_name,
        "src": [], "src_dir": "", "save_dir": art_dir, "artifact": out_path,
        "size": os.path.getsize(out_path), "done": 0, "status": "ready",
        "phase": "", "error": "", "user": user or "", "ip": ip or "",
        "hits": 0, "note": "文本另存 · %d 字符" % len(content), "opts": opts,
    }
    _insert(row)
    ensure_sweeper()
    return get(tid)


def create_task(paths, name="", kind="auto", save_dir="", opts=None, user="", ip=""):
    """新建下载任务。返回任务 dict；参数非法时抛 ValueError。"""
    opts = dict(opts or {})
    cfg = get_settings()
    include_hidden = bool(opts.get("include_hidden", cfg.get("include_hidden")))
    keep_structure = bool(opts.get("keep_structure", cfg.get("keep_structure")))
    zip_level = int(opts.get("zip_level", cfg.get("zip_level", 6)) or 0)

    # 文本另存：没有来源路径，先把内容写成文件（不参与下面的路径校验）
    if kind == "text":
        return _create_text(name, opts, cfg, user, ip)

    if isinstance(paths, str):
        paths = [paths]
    cleaned = []
    for p in (paths or []):
        p = str(p or "").strip()
        if not p:
            continue
        ap = os.path.abspath(p)
        if ap not in cleaned:
            cleaned.append(ap)
    if not cleaned:
        raise ValueError("请先选择要下载的文件或文件夹")
    if len(cleaned) > _MAX_ITEMS:
        raise ValueError("一次最多选择 %d 个条目" % _MAX_ITEMS)
    missing = [p for p in cleaned if not os.path.exists(p)]
    if len(missing) == len(cleaned):
        raise ValueError("选中的文件都不存在了，请刷新后重试")

    base_dir = ""
    if len(cleaned) == 1:
        base_dir = os.path.dirname(cleaned[0]) if os.path.isfile(cleaned[0]) else cleaned[0]

    # 自动判断：单个文件 → 直传；其余 → 打包
    if kind in ("file", "auto") and len(cleaned) == 1 and os.path.isfile(cleaned[0]):
        kind = "file"
    elif kind == "file":
        kind = "zip"
    elif kind in ("auto", "", None):
        kind = "zip"
    elif kind not in ("zip", "text"):
        raise ValueError("不支持的下载类型：%s" % kind)

    tid = _new_id()
    ts = _now_ts()
    src0 = cleaned[0]
    src_dir = os.path.dirname(src0) if os.path.isfile(src0) else src0
    if len(cleaned) > 1:
        try:
            src_dir = os.path.commonpath(cleaned)
        except (ValueError, OSError):
            src_dir = os.path.dirname(src0)

    if kind == "file":
        try:
            size = os.path.getsize(src0)
        except OSError as e:
            raise ValueError("无法读取文件：%s" % e)
        dl_name = _safe_name(name or os.path.basename(src0))
        row = {
            "id": tid, "ts": ts, "kind": "file", "name": dl_name,
            "src": cleaned, "src_dir": src_dir, "save_dir": "",
            "artifact": src0, "size": size, "done": 0,
            "status": "ready", "phase": "", "error": "",
            "user": user or "", "ip": ip or "", "hits": 0,
            "note": "单文件直传 · 不占用额外磁盘",
            "opts": opts,
        }
        _insert(row)
        ensure_sweeper()
        return get(tid)

    # zip / text
    art_dir = cfg.get("artifact_dir") or ARTIFACT_ROOT
    try:
        os.makedirs(art_dir, exist_ok=True)
    except OSError:
        art_dir = ARTIFACT_ROOT
        os.makedirs(art_dir, exist_ok=True)
    task_dir = os.path.join(art_dir, tid)
    os.makedirs(task_dir, exist_ok=True)

    # ---------------- zip ----------------
    entries, total, _dirs, warnings = _collect(
        cleaned, include_hidden=include_hidden,
        keep_structure=keep_structure, base_dir=base_dir)
    if not entries:
        shutil.rmtree(task_dir, ignore_errors=True)
        raise ValueError("选中的内容为空（可能全是隐藏文件或空目录）")

    if name:
        dl_name = _safe_name(name)
        if not dl_name.lower().endswith(_zip_ext()):
            dl_name += _zip_ext()
    elif len(cleaned) == 1:
        dl_name = _safe_name(os.path.basename(cleaned[0]) or "download") + _zip_ext()
    else:
        dl_name = "打包下载_%s.zip" % datetime.datetime.now().strftime("%Y%m%d_%H%M%S")

    out_path = os.path.join(task_dir, dl_name)
    note = "打包 %d 个文件 · %s" % (sum(1 for e in entries if not e[2]), "压缩 Lv%d" % zip_level
                                   if zip_level > 0 else "仅存储")
    if warnings:
        note += " · %d 项被跳过" % len(warnings)
    row = {
        "id": tid, "ts": ts, "kind": "zip", "name": dl_name,
        "src": cleaned, "src_dir": src_dir, "save_dir": art_dir,
        "artifact": out_path, "size": int(total), "done": 0,
        "status": "building", "phase": "正在压缩", "error": "",
        "user": user or "", "ip": ip or "", "hits": 0,
        "note": note, "opts": dict(opts, zip_level=zip_level,
                                   include_hidden=include_hidden,
                                   keep_structure=keep_structure),
    }
    _insert(row)
    ensure_sweeper()
    t = threading.Thread(target=_build_zip, args=(tid, entries, total, out_path, zip_level),
                         daemon=True, name="dl-zip-%s" % tid)
    t.start()
    return get(tid)


def _insert(row):
    with store_tx() as conn:
        conn.execute(
            "INSERT INTO dl_tasks (id, ts, updated, kind, name, src, src_dir, save_dir,"
            " artifact, size, done, status, phase, error, user, ip, hits, note, opts,"
            " url, threads, segs, meta, srv_done, srv_size, speed)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (row["id"], row["ts"], time.time(), row["kind"], row["name"],
             json.dumps(row.get("src") or [], ensure_ascii=False), row.get("src_dir") or "",
             row.get("save_dir") or "", row.get("artifact") or "", int(row.get("size") or 0),
             int(row.get("done") or 0), row.get("status") or "pending",
             row.get("phase") or "", row.get("error") or "", row.get("user") or "",
             row.get("ip") or "", int(row.get("hits") or 0), row.get("note") or "",
             json.dumps(row.get("opts") or {}, ensure_ascii=False),
             row.get("url") or "", int(row.get("threads") or 0),
             json.dumps(row.get("segs") or [], ensure_ascii=False),
             json.dumps(row.get("meta") or {}, ensure_ascii=False),
             int(row.get("srv_done") or 0), int(row.get("srv_size") or 0),
             int(row.get("speed") or 0)))


def create_text_task(content, name="未命名.txt"):
    """文本另存为下载（界面「把当前内容另存为」用）。"""
    return create_task([], name=name, kind="text", opts={"content": content or ""})


# ----------------------------------------------------------------------
# 状态流转 / 进度
# ----------------------------------------------------------------------
def set_status(tid, status, error=""):
    task = get(tid)
    if not task:
        return None
    _update(tid, status=status, error=(error or "")[:300])
    return get(tid)


def request_cancel(tid):
    """打包中的任务：置取消标记，由线程自行收尾。"""
    with _CANCEL_LOCK:
        _CANCEL.add(tid)
    task = get(tid)
    if task and task["status"] in ("pending", "building"):
        _update(tid, phase="正在取消…")
    return True


def update_progress(tid, offset=None, status=None):
    """前端回报下载进度（断点续传游标）。"""
    task = get(tid)
    if not task:
        return None
    kw = {}
    if offset is not None:
        try:
            off = max(0, int(offset))
        except (TypeError, ValueError):
            off = 0
        size = int(task.get("size") or 0)
        if size and off > size:
            off = size
        kw["done"] = off
    if status:
        kw["status"] = status
        if status in ("done",):
            kw["phase"] = ""
    if kw:
        _update(tid, **kw)
    if status == "done":
        try:
            with store_tx() as conn:
                conn.execute("UPDATE dl_tasks SET hits=hits+1 WHERE id=?", (tid,))
        except Exception:
            pass
    return get(tid)


def reset_progress(tid):
    return update_progress(tid, offset=0, status="ready")


# ----------------------------------------------------------------------
# 列表 / 统计
# ----------------------------------------------------------------------
def list_tasks(q="", status="", page=1, page_size=50, kind=""):
    q = (q or "").strip()
    where, args = [], []
    if status == "active":
        where.append("status IN ('pending','building','ready','downloading','paused')")
    elif status == "done":
        where.append("status = 'done'")
    elif status == "failed":
        where.append("status IN ('failed','canceled')")
    elif status and status != "all":
        where.append("status = ?")
        args.append(status)
    if kind:
        where.append("kind = ?")
        args.append(kind)
    if q:
        like = "%" + q + "%"
        where.append("(name LIKE ? OR src LIKE ? OR note LIKE ? OR src_dir LIKE ?)")
        args += [like, like, like, like]
    w = ("WHERE " + " AND ".join(where)) if where else ""
    try:
        page = max(1, int(page or 1))
    except (TypeError, ValueError):
        page = 1
    try:
        page_size = max(1, min(200, int(page_size or 50)))
    except (TypeError, ValueError):
        page_size = 50
    try:
        conn = store_conn()
        try:
            total = conn.execute("SELECT COUNT(1) FROM dl_tasks " + w, args).fetchone()[0]
            rows = conn.execute(
                "SELECT * FROM dl_tasks " + w +
                " ORDER BY ts DESC, updated DESC LIMIT ? OFFSET ?",
                args + [page_size, (page - 1) * page_size]).fetchall()
        finally:
            conn.close()
        return int(total or 0), [_row(r) for r in rows]
    except Exception as e:
        _log.warning("读取下载任务失败：%s", e)
        return 0, []


def stats():
    """顶部汇总：进行中 / 已完成 / 失败 / 累计字节 / 已传输字节。
    产物文件已被删除的 ready/done 任务标为「文件已清理」，不计入已完成。"""
    remote_kinds = ("url", "torrent", "hls")
    try:
        conn = store_conn()
        try:
            rows = conn.execute(
                "SELECT status, kind, size, done, srv_done, artifact FROM dl_tasks").fetchall()
        finally:
            conn.close()
        total = active = done = fail = 0
        bytes_sum = done_bytes = 0
        for r in rows:
            total += 1
            status, kind = r["status"], r["kind"]
            remote = kind in remote_kinds
            gone = status in ("ready", "done") and r["artifact"] and \
                not os.path.exists(r["artifact"])
            if gone:
                continue                                 # 文件已清理：不算已完成
            if status == "done" or (status == "ready" and remote):
                done += 1
            elif status in ("failed", "canceled"):
                fail += 1
            elif status in ("pending", "building", "downloading", "paused") or \
                    (status == "ready" and not remote):
                active += 1
            if remote:
                done_bytes += int(r["srv_done"] or 0)
            else:
                bytes_sum += int(r["size"] or 0)
                done_bytes += int(r["done"] or 0)
        return {"total": total, "active": active, "done": done,
                "fail": fail, "bytes": bytes_sum, "done_bytes": done_bytes}
    except Exception:
        return {"total": 0, "active": 0, "done": 0, "fail": 0, "bytes": 0, "done_bytes": 0}


# ----------------------------------------------------------------------
# 删除 / 清理
# ----------------------------------------------------------------------
def _purge_artifact(task):
    """删除产物文件与其所在的任务目录。

    只删「产物目录」内的东西 —— 单文件直传的 artifact 是用户源文件，绝不能删。
    """
    art = (task or {}).get("artifact") or ""
    if not art or not os.path.exists(art):
        return
    # 同一个产物文件被多条任务引用时（同名文件 / 重试任务）绝不能删，否则会误删别人下好的文件
    try:
        conn = store_conn()
        try:
            shared = conn.execute("SELECT COUNT(1) FROM dl_tasks WHERE artifact=? AND id<>?",
                                  (art, (task or {}).get("id") or "")).fetchone()[0]
        finally:
            conn.close()
        if shared:
            return
    except Exception:
        return
    try:
        roots = [os.path.abspath(ARTIFACT_ROOT),
                 os.path.abspath(get_settings().get("artifact_dir") or ARTIFACT_ROOT)]
        if not any(_within(art, r) for r in roots):
            return
        folder = os.path.dirname(os.path.abspath(art))
        if os.path.isfile(art):
            os.remove(art)
        # 任务目录（产物根目录的直接子目录）整个删掉，避免留下空目录
        if os.path.isdir(folder) and all(folder != r for r in roots):
            shutil.rmtree(folder, ignore_errors=True)
    except OSError as e:
        _log.warning("清理下载产物失败 %s：%s", art, e)


def _stop_remote(tid):
    """网络下载任务：先叫停线程 / aria2 子进程并清掉分片目录（延迟导入避免循环依赖）。"""
    try:
        from . import remote_dl
        remote_dl.cleanup(tid)
    except Exception:
        pass


def delete_task(tid, purge=True):
    task = get(tid)
    if not task:
        return False
    _stop_remote(tid)
    # 只有真正完成的任务才清理产物：失败 / 取消任务的 artifact 可能只是探测时占的路径，
    # 甚至和别的任务同名重合，删了会把别人下好的文件带走
    if purge and task.get("status") in ("ready", "done"):
        _purge_artifact(task)
    try:
        with store_tx() as conn:
            conn.execute("DELETE FROM dl_tasks WHERE id=?", (tid,))
        return True
    except Exception as e:
        _log.warning("删除下载任务失败：%s", e)
        return False


def clear_tasks(scope="finished"):
    """清空记录：finished = 只清已结束的；all = 全部。"""
    try:
        conn = store_conn()
        try:
            if scope == "all":
                rows = conn.execute("SELECT * FROM dl_tasks").fetchall()
            else:
                rows = conn.execute(
                    "SELECT * FROM dl_tasks WHERE status IN ('done','failed','canceled')").fetchall()
        finally:
            conn.close()
    except Exception:
        rows = []
    for r in rows:
        t = _row(r)
        _stop_remote(t["id"])
        _purge_artifact(t)
    try:
        with store_tx() as conn:
            if scope == "all":
                conn.execute("DELETE FROM dl_tasks")
            else:
                conn.execute("DELETE FROM dl_tasks WHERE status IN ('done','failed','canceled')")
        return len(rows)
    except Exception as e:
        _log.warning("清空下载记录失败：%s", e)
        return 0


def clean_artifacts():
    """删掉「已结束」任务的产物文件（保留记录，可重新下载时提示需重建）。"""
    n = 0
    try:
        conn = store_conn()
        try:
            rows = conn.execute(
                "SELECT * FROM dl_tasks WHERE status IN ('done','failed','canceled')").fetchall()
        finally:
            conn.close()
    except Exception:
        rows = []
    for r in rows:
        t = _row(r)
        if t.get("exists"):
            _purge_artifact(t)
            _update(t["id"], artifact="")
            n += 1
    return n


# ----------------------------------------------------------------------
# 设置
# ----------------------------------------------------------------------
def get_settings():
    cfg = dict(_DEFAULTS)
    try:
        conn = store_conn()
        try:
            row = conn.execute("SELECT value FROM dl_cfg WHERE key='cfg'").fetchone()
        finally:
            conn.close()
        if row and row["value"]:
            cfg.update(json.loads(row["value"]) or {})
    except Exception:
        pass
    # 产物目录必须存在
    art = str(cfg.get("artifact_dir") or ARTIFACT_ROOT)
    if not os.path.isdir(art):
        try:
            os.makedirs(art, exist_ok=True)
        except OSError:
            cfg["artifact_dir"] = ARTIFACT_ROOT
    return cfg


def save_settings(patch):
    cfg = get_settings()
    for k, v in (patch or {}).items():
        if k not in _DEFAULTS:
            continue
        if k in ("artifact_dir", "save_dir"):
            p = os.path.abspath(os.path.expanduser(str(v or "").strip()))
            if not p:
                continue
            try:
                os.makedirs(p, exist_ok=True)
            except OSError as e:
                raise ValueError("目录不可用：%s" % e)
            if not os.path.isdir(p):
                raise ValueError("不是目录：%s" % p)
            cfg[k] = p
        elif k in ("keep_days", "max_rows", "concurrency", "throttle_kbps", "zip_level", "threads"):
            try:
                n = int(v)
            except (TypeError, ValueError):
                continue
            limits = {"keep_days": (0, 365), "max_rows": (10, 10000), "concurrency": (1, 5),
                      "throttle_kbps": (0, 1024 * 1024), "zip_level": (0, 9), "threads": (1, 32)}
            lo, hi = limits[k]
            cfg[k] = max(lo, min(hi, n))
        elif k in ("user_agent", "proxy"):
            cfg[k] = str(v or "").strip()[:500]
        else:
            cfg[k] = bool(v)
    try:
        with store_tx() as conn:
            conn.execute("INSERT OR REPLACE INTO dl_cfg (key, value) VALUES ('cfg', ?)",
                         (json.dumps(cfg, ensure_ascii=False),))
    except Exception as e:
        _log.warning("保存下载设置失败：%s", e)
    return cfg


def usage():
    """产物目录占用 + 记录条数（设置页展示）。"""
    cfg = get_settings()
    art = cfg.get("artifact_dir") or ARTIFACT_ROOT
    size, files = 0, 0
    for dirpath, _dirnames, filenames in os.walk(art):
        for fn in filenames:
            fp = os.path.join(dirpath, fn)
            try:
                size += os.path.getsize(fp)
                files += 1
            except OSError:
                pass
    st = stats()
    return {"artifact_dir": art, "artifacts": files, "artifact_bytes": size,
            "records": st["total"], "done_bytes": st["done_bytes"], "bytes": st["bytes"]}


# ----------------------------------------------------------------------
# 过期清理（惰性启动的后台线程）
# ----------------------------------------------------------------------
def sweep_once():
    """清理过期产物 + 裁剪记录条数。返回 (删除文件数, 裁剪记录数)。"""
    cfg = get_settings()
    keep_days = int(cfg.get("keep_days") or 0)
    max_rows = int(cfg.get("max_rows") or 0)
    removed, trimmed = 0, 0
    cutoff = time.time() - keep_days * 86400 if keep_days > 0 else 0
    try:
        conn = store_conn()
        try:
            rows = conn.execute("SELECT * FROM dl_tasks ORDER BY updated DESC").fetchall()
        finally:
            conn.close()
    except Exception:
        rows = []
    for idx, r in enumerate(rows):
        t = _row(r)
        expire = bool(cutoff) and t["updated"] < cutoff and t["status"] not in ACTIVE_STATUS
        overflow = bool(max_rows) and idx >= max_rows and t["status"] not in ACTIVE_STATUS
        if not (expire or overflow):
            continue
        if t["status"] in ACTIVE_STATUS:
            continue
        _purge_artifact(t)
        try:
            with store_tx() as conn:
                conn.execute("DELETE FROM dl_tasks WHERE id=?", (t["id"],))
            trimmed += 1
        except Exception:
            pass
    # 产物目录里没有对应任务的残留目录
    try:
        ids = set()
        conn = store_conn()
        try:
            for r in conn.execute("SELECT id FROM dl_tasks").fetchall():
                ids.add(r["id"])
        finally:
            conn.close()
        for name in os.listdir(ARTIFACT_ROOT):
            p = os.path.join(ARTIFACT_ROOT, name)
            if os.path.isdir(p) and name not in ids:
                shutil.rmtree(p, ignore_errors=True)
                removed += 1
    except Exception:
        pass
    return removed, trimmed


def ensure_sweeper():
    """惰性启动过期清理线程（每 30 分钟一次）。"""
    with _SWEEPER["lock"]:
        th = _SWEEPER.get("thread")
        if th is not None and th.is_alive():
            return

        def _loop():
            time.sleep(20)                 # 启动后先等一等，不抢启动时的 IO
            while True:
                try:
                    r = sweep_once()
                    if r[0] or r[1]:
                        _log.info("下载中心清理：残留目录 %s 个 / 记录 %s 条", r[0], r[1])
                except Exception as e:
                    _log.warning("下载中心清理失败：%s", e)
                time.sleep(1800)

        th = threading.Thread(target=_loop, daemon=True, name="dl-sweeper")
        th.start()
        _SWEEPER["thread"] = th


# ----------------------------------------------------------------------
# 下发（Range 支持）
# ----------------------------------------------------------------------
def iter_file(path, start=0, end=None, chunk=_CHUNK):
    """按区间逐块读取文件（供 Range 响应使用）。"""
    with open(path, "rb", buffering=0) as f:
        f.seek(max(0, int(start)))
        left = None
        if end is not None:
            left = max(0, int(end) - int(start) + 1)
        while True:
            n = chunk if left is None else min(chunk, left)
            if n <= 0:
                break
            buf = f.read(n)
            if not buf:
                break
            if left is not None:
                left -= len(buf)
            yield buf
            if left is not None and left <= 0:
                break


def touch_stream(tid):
    """记录一次下发开始（不影响断点游标）。"""
    task = get(tid)
    if not task:
        return None
    _update(tid, status="downloading", phase="")
    return get(tid)


def finish_stream(tid, aborted=False):
    """下发结束：正常结束由前端上报 done；中途断开则标记为已暂停，保留游标。"""
    task = get(tid)
    if not task:
        return
    if task["status"] == "downloading":
        _update(tid, status="paused" if aborted else "paused",
                phase="" if aborted else "")

"""进程资源管理器：本机资源占用与进程采集（只读查看 + 按 pid 结束进程）。

对外接口（供 app/routes/ide/proc.py 调用）：
- overview()    → 系统总体占用（CPU / 内存 / 磁盘 / 网络）+ 分组统计 + 健康概述
- processes()   → 进程列表（排序 / 关键字过滤 / 是否可结束）
- ports()       → 监听中的端口（复用 portinfo，结果带 3 秒缓存）
- kill_pid()    → 结束指定进程（先 SIGTERM，3 秒后仍未退出再 SIGKILL）

采集方式：后台采样线程每 2 秒刷新一次快照。psutil 的 cpu_percent 需要「两次采样求差」
才知道使用率，不能在 HTTP 请求里阻塞等待，所以接口只读最近一次快照。磁盘用量单独做
20 秒缓存（每个分区都查一次 disk_usage，在网络盘 / 慢盘上耗时明显）。

安全说明：只读取系统信息，不接受任何用户提供的命令文本；结束进程只接受 pid，
且拒绝 pid<=1、本服务自身进程、本服务的祖先进程、以及不属于当前用户的进程。
"""
import os
import threading
import time

from ...log import get_logger
from . import portinfo

try:
    import psutil
except ImportError:                                   # 未安装时接口返回引导文案
    psutil = None


_log = get_logger()

_SAMPLE_INTERVAL = 2.0                                # 快照刷新间隔（秒）
_DISK_TTL = 20.0                                      # 磁盘用量缓存（秒）
_PORT_TTL = 3.0                                       # 端口列表缓存（秒）
_MAX_PARTS = 6                                        # 磁盘卡片最多列几个分区
_APP_PID = os.getpid()
_MY_UID = os.getuid() if hasattr(os, "getuid") else -1

_LOCK = threading.Lock()
_THREAD = None
_SNAP = None                                          # {"t":..., "procs":[...], "ov":{...}}
_DISK_CACHE = {"t": 0.0, "parts": []}
_PORT_CACHE = {"t": 0.0, "rows": []}
_NET_LAST = {"t": 0.0, "sent": 0, "recv": 0}
_PROTECT = {1, _APP_PID}                              # 禁止结束：系统关键进程 + 本服务及其祖先进程
_CPU_LAST = {"t": 0.0, "times": None}                 # 整机 CPU：自己用 cpu_times 求差（比 cpu_percent 的内部缓存可控）

if psutil is not None:                                # 预热一次，让第一次采样有基准值
    try:
        _CPU_LAST["times"] = psutil.cpu_times()
        _CPU_LAST["t"] = time.time()
    except Exception:
        pass


def available() -> bool:
    """psutil 是否可用（不可用时接口会返回安装引导）。"""
    return psutil is not None


def tree_usage(pid) -> dict:
    """某进程及其全部后代当前占用的 CPU / 内存（按最近一次快照聚合）。

    返回 {"cpu": 12.3, "rss": 12345678, "n": 4}：
    - cpu  该进程树的 CPU%（单核为 100%，多核 / 多线程程序可能超过 100，与 top 一致）；
    - rss  常驻内存之和（字节）；
    - n    进程数（含自身）。

    为什么要连后代一起算：后台任务往往是「启动器 + 干活的子进程」结构
    （npm run dev 真正吃内存的是它拉起的 node，python 的 reloader 也一样），
    只看父进程会严重低估算占用。

    未装 psutil、或 pid 已不在快照里（进程刚退出 / 无权查看）时 cpu 返回 None，
    由调用方决定显示成「-」还是隐藏。
    """
    if psutil is None:
        return {"cpu": None, "rss": 0, "n": 0}
    try:
        snap = _ensure()                              # 顺带启动 2 秒采样线程，保证数据新鲜
    except Exception:
        return {"cpu": None, "rss": 0, "n": 0}
    procs = (snap or {}).get("procs") or []
    by_pid, kids = {}, {}
    for r in procs:
        by_pid[r["pid"]] = r
        kids.setdefault(r["ppid"], []).append(r["pid"])
    pid = int(pid or 0)
    if pid <= 0 or pid not in by_pid:
        return {"cpu": None, "rss": 0, "n": 0}
    seen, stack, cpu, rss = set(), [pid], 0.0, 0
    while stack:                                      # 沿 ppid 建子表后向下遍历整棵树
        cur = stack.pop()
        if cur in seen:
            continue
        seen.add(cur)
        r = by_pid.get(cur)
        if r:
            cpu += float(r.get("cpu") or 0.0)
            rss += int(r.get("rss") or 0)
        stack.extend(kids.get(cur, []))
    return {"cpu": round(cpu, 1), "rss": rss, "n": len(seen)}


def tree_pids(pid) -> list:
    """某进程及其全部后代的 pid 列表。

    用途：把监听端口等「实际发生在子进程上」的信息归属到整个任务进程树
    （例如 python reloader / npm run dev 真正监听端口的是它拉起的子进程，只看父 pid 会漏掉）。
    未装 psutil 或 pid 无效时返回 []。
    """
    if psutil is None:
        return []
    try:
        snap = _ensure()
    except Exception:
        return []
    procs = (snap or {}).get("procs") or []
    kids = {}
    for r in procs:
        kids.setdefault(r["ppid"], []).append(r["pid"])
    try:
        pid = int(pid or 0)
    except (TypeError, ValueError):
        return []
    if pid <= 0:
        return []
    out, seen, stack = [], set(), [pid]
    while stack:
        cur = stack.pop()
        if cur in seen:
            continue
        seen.add(cur)
        out.append(cur)
        stack.extend(kids.get(cur, []))
    return out


def _app_root() -> str:
    """本服务所在项目根目录（用来判断工作区落在哪个分区）。"""
    return os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))


def _my_name() -> str:
    if psutil is None:
        return ""
    try:
        return psutil.Process().username()
    except Exception:
        return ""


def _sample_procs() -> list:
    """遍历一次全部进程，取 pid / 名称 / 属主 / CPU / 内存 / 命令行。

    只做只读采集；其它用户的进程可能取不到 cmdline（AccessDenied），取不到就留空。
    """
    rows = []
    for p in psutil.process_iter(["pid", "ppid", "name", "username", "memory_info",
                                  "status", "create_time", "num_threads"]):
        try:
            info = p.info
            pid = int(info.get("pid") or 0)
            if pid <= 0:
                continue
            try:
                # 非阻塞取相对上次调用的增量；process_iter 内部缓存了进程对象，所以差值有效
                cpu = float(p.cpu_percent(None) or 0.0)
            except Exception:
                cpu = 0.0
            mi = info.get("memory_info")
            rss = int(getattr(mi, "rss", 0) or 0)
            try:
                cmd = " ".join(p.cmdline())[:400]
            except Exception:
                cmd = ""
            rows.append({
                "pid": pid,
                "ppid": int(info.get("ppid") or 0),
                "name": (info.get("name") or "")[:64],
                "user": info.get("username") or "",
                "cpu": round(cpu, 1),
                "rss": rss,
                "status": info.get("status") or "",
                "threads": int(info.get("num_threads") or 0),
                "started": int(info.get("create_time") or 0),
                "cmd": cmd,
            })
        except Exception:                             # NoSuchProcess / AccessDenied / Zombie 等
            continue
    return rows


def _cpu_percent() -> float:
    """整机 CPU 使用率：用两次 cpu_times 的差值算（闲置 = idle + iowait）。

    不用 psutil.cpu_percent(None)：它内部有全局缓存，调用间隔过短时直接返回 0，
    表现为「打开后前几秒 CPU 一直是 0」。
    """
    now = time.time()
    try:
        t = psutil.cpu_times()
    except Exception:
        return 0.0
    last, lt = _CPU_LAST["times"], _CPU_LAST["t"]
    _CPU_LAST["times"], _CPU_LAST["t"] = t, now
    if last is None or now - lt < 0.5:                # 采样窗口太短：等下一次再给准数
        return 0.0
    try:
        idle = (t.idle + getattr(t, "iowait", 0.0)) - (last.idle + getattr(last, "iowait", 0.0))
        total = sum(t) - sum(last)
    except Exception:
        return 0.0
    if total <= 0:
        return 0.0
    return max(0.0, min(100.0, (total - idle) * 100.0 / total))


def _disk_parts() -> list:
    """各分区用量（带 TTL 缓存）：工作区所在分区排第一，其余按容量倒序。"""
    now = time.time()
    if _DISK_CACHE["parts"] and now - _DISK_CACHE["t"] < _DISK_TTL:
        return _DISK_CACHE["parts"]
    root = _app_root()
    parts, seen = [], set()
    try:
        dparts = psutil.disk_partitions(all=False)
    except Exception:
        dparts = []
    for d in dparts:
        mp = (d.mountpoint or "").rstrip("\\") or d.mountpoint
        if not mp or mp in seen:
            continue
        seen.add(mp)
        try:
            u = psutil.disk_usage(mp)
        except Exception:                             # 权限 / 已卸载 / 特殊文件系统
            continue
        if not u.total:
            continue
        parts.append({
            "mount": d.mountpoint, "device": d.device, "fstype": d.fstype,
            "total": int(u.total), "used": int(u.used), "free": int(u.free),
            "percent": round(float(u.percent), 1),
        })

    def is_main(p):
        mp = p["mount"]
        return bool(mp) and os.path.abspath(root).startswith(os.path.abspath(mp))

    mains = [p for p in parts if is_main(p)]
    mains.sort(key=lambda p: -len(p["mount"]))        # 挂载点最长者 = 工作区真正所在分区
    main = mains[0] if mains else (parts[0] if parts else None)
    rest = sorted([p for p in parts if p is not main], key=lambda p: -p["total"])
    out = ([dict(main, main=True)] if main else []) + [dict(p, main=False) for p in rest[:_MAX_PARTS - 1]]
    _DISK_CACHE["t"] = now
    _DISK_CACHE["parts"] = out
    return out


def _sample() -> dict:
    """采集一次完整快照（系统指标 + 进程列表 + 分组统计）。"""
    now = time.time()
    cores = psutil.cpu_count(logical=True) or 1
    cpu_pct = _cpu_percent()
    vm = psutil.virtual_memory()
    try:
        sw = psutil.swap_memory()
    except Exception:
        sw = None
    try:
        load = [round(x, 2) for x in psutil.getloadavg()]
    except Exception:                                 # Windows 无 loadavg
        load = []
    try:
        uptime = max(0.0, now - psutil.boot_time())
    except Exception:
        uptime = 0.0

    procs = _sample_procs()
    my = _my_name()

    # 本应用进程树：以服务自身 pid 为根，沿 ppid 建子表做遍历（终端 / 后台任务都在里面）
    kids = {}
    for r in procs:
        kids.setdefault(r["ppid"], []).append(r["pid"])
    app_pids, stack = set(), [_APP_PID]
    while stack:
        cur = stack.pop()
        if cur in app_pids:
            continue
        app_pids.add(cur)
        stack.extend(kids.get(cur, []))

    # 禁止结束：本服务的祖先进程链（启动它的 shell / 终端 / IDE 等），只增不减（多保护无害）
    prot = {1, _APP_PID}
    try:
        cur = psutil.Process(_APP_PID)
        for _ in range(32):
            cur = cur.parent()
            if cur is None:
                break
            prot.add(cur.pid)
    except Exception:
        pass
    _PROTECT.update(prot)

    grp = {"app": {"cpu": 0.0, "rss": 0, "n": 0},
           "mine": {"cpu": 0.0, "rss": 0, "n": 0},
           "sys": {"cpu": 0.0, "rss": 0, "n": 0}}
    for r in procs:
        r["in_app"] = r["pid"] in app_pids
        r["mine"] = bool(my) and r["user"] == my
        key = "app" if r["in_app"] else ("mine" if r["mine"] else "sys")
        grp[key]["cpu"] += r["cpu"]
        grp[key]["rss"] += r["rss"]
        grp[key]["n"] += 1

    def cpu_share(key):                               # 单进程 CPU% 是以「单核」为 100%，换算成整机占比
        return round(min(100.0, grp[key]["cpu"] / cores), 1)

    app_share, mine_share, sys_share = cpu_share("app"), cpu_share("mine"), cpu_share("sys")
    idle = round(max(0.0, 100.0 - (app_share + mine_share + sys_share)), 1)
    total_mem = int(vm.total) or 1
    mem_rows = [
        {"name": "IDE 服务（含终端 / 后台任务）", "bytes": grp["app"]["rss"], "count": grp["app"]["n"],
         "percent": round(grp["app"]["rss"] * 100.0 / total_mem, 1)},
        {"name": "我的其他进程", "bytes": grp["mine"]["rss"], "count": grp["mine"]["n"],
         "percent": round(grp["mine"]["rss"] * 100.0 / total_mem, 1)},
        {"name": "系统与其他用户", "bytes": grp["sys"]["rss"], "count": grp["sys"]["n"],
         "percent": round(grp["sys"]["rss"] * 100.0 / total_mem, 1)},
        {"name": "已空闲", "bytes": int(vm.available), "count": 0,
         "percent": round(int(vm.available) * 100.0 / total_mem, 1)},
    ]

    # 网络：用两次采样的字节数差算实时速率
    net = {"up": 0.0, "down": 0.0, "sent": 0, "recv": 0}
    try:
        io = psutil.net_io_counters()
        dt = now - _NET_LAST["t"] if _NET_LAST["t"] else 0
        if dt > 0.05:
            net["up"] = max(0.0, (io.bytes_sent - _NET_LAST["sent"]) / dt)
            net["down"] = max(0.0, (io.bytes_recv - _NET_LAST["recv"]) / dt)
        net["sent"], net["recv"] = int(io.bytes_sent), int(io.bytes_recv)
        _NET_LAST.update({"t": now, "sent": int(io.bytes_sent), "recv": int(io.bytes_recv)})
    except Exception:
        pass

    parts = _disk_parts()
    main = next((p for p in parts if p.get("main")), parts[0] if parts else
                {"mount": "-", "total": 0, "used": 0, "free": 0, "percent": 0.0, "fstype": ""})

    me = next((r for r in procs if r["pid"] == _APP_PID), None)
    ov = {
        "time": now,
        "cpu": {
            "percent": round(cpu_pct, 1), "cores": cores, "load": load,
            "groups": [
                {"name": "IDE 服务（含终端 / 后台任务）", "percent": app_share, "count": grp["app"]["n"]},
                {"name": "我的其他进程", "percent": mine_share, "count": grp["mine"]["n"]},
                {"name": "系统与其他用户", "percent": sys_share, "count": grp["sys"]["n"]},
                {"name": "已空闲", "percent": idle, "count": 0},
            ],
        },
        "mem": {
            "total": int(vm.total), "used": int(vm.used), "free": int(vm.free),
            "percent": round(float(vm.percent), 1), "available": int(vm.available),
            "swap_total": int(getattr(sw, "total", 0) or 0),
            "swap_used": int(getattr(sw, "used", 0) or 0),
            "swap_percent": round(float(getattr(sw, "percent", 0.0) or 0.0), 1),
            "groups": mem_rows,
        },
        "disk": {
            "mount": main["mount"], "fstype": main.get("fstype") or "",
            "total": main["total"], "used": main["used"], "free": main["free"],
            "percent": main["percent"], "parts": parts,
        },
        "net": net,
        "uptime": uptime,
        "counts": {"total": len(procs), "app": grp["app"]["n"], "mine": grp["mine"]["n"], "sys": grp["sys"]["n"]},
        "self": {"pid": _APP_PID, "rss": (me or {}).get("rss", 0), "cpu": (me or {}).get("cpu", 0.0),
                 "threads": (me or {}).get("threads", 0)},
    }
    ov.update(_health(ov))
    return {"t": now, "procs": procs, "ov": ov}


def _health(ov: dict) -> dict:
    """给一句人话结论（参考 Trae 的「系统概览」），并给出等级 ok / warn / bad。"""
    bad, warn, tips = [], [], []
    cpu = ov["cpu"]["percent"]
    mem = ov["mem"]["percent"]
    dsk = ov["disk"]["percent"]
    if cpu >= 90:
        bad.append("CPU 占用 %.0f%%" % cpu)
    elif cpu >= 75:
        warn.append("CPU 占用偏高（%.0f%%）" % cpu)
    if mem >= 92:
        bad.append("内存占用 %.0f%%" % mem)
    elif mem >= 80:
        warn.append("内存占用偏高（%.0f%%）" % mem)
    if dsk >= 95:
        bad.append("磁盘剩余空间不足（已用 %.0f%%）" % dsk)
    elif dsk >= 85:
        warn.append("磁盘空间偏紧（已用 %.0f%%）" % dsk)
    if ov["mem"]["swap_total"] and ov["mem"]["swap_percent"] >= 50:
        warn.append("交换分区使用 %.0f%%" % ov["mem"]["swap_percent"])
    if bad:
        return {"health": "bad", "summary": "检测到压力项：" + "、".join(bad) + "。建议先结束不用的进程，或减少同时运行的开发任务。"}
    if warn:
        return {"health": "warn", "summary": warn[0] + ("；" + "；".join(warn[1:]) if len(warn) > 1 else "") +
                                       "。整体仍可用，注意观察。"}
    return {"health": "ok", "summary": "CPU、内存和磁盘均处于健康范围。"}


def _loop():
    """后台采样线程：每 2 秒刷新一次快照（异常只记日志，不影响接口）。"""
    global _SNAP
    while True:
        time.sleep(_SAMPLE_INTERVAL)
        try:
            snap = _sample()
            with _LOCK:
                _SNAP = snap
        except Exception as e:
            _log.warning("采集系统资源失败：%s", e)


def _ensure() -> dict:
    """确保采样线程已启动，并返回最近一次快照（首次调用同步采一次，保证立即有数据）。"""
    global _THREAD, _SNAP
    with _LOCK:
        if _SNAP is None:
            try:
                _SNAP = _sample()
            except Exception as e:
                _log.warning("首次采集系统资源失败：%s", e)
                _SNAP = {"t": time.time(), "procs": [], "ov": {"error": str(e)}}
        if _THREAD is None or not _THREAD.is_alive():
            _THREAD = threading.Thread(target=_loop, name="proc-sampler", daemon=True)
            _THREAD.start()
        return _SNAP


def _empty_ov(err: str) -> dict:
    return {"error": err, "time": time.time(), "health": "warn", "summary": err}


def overview() -> dict:
    """系统总体占用（进程列表不在这里返回，避免响应体过大）。"""
    if psutil is None:
        return _empty_ov("未安装 psutil，无法采集系统资源。请在项目里执行：pip install psutil")
    snap = _ensure()
    ov = dict(snap.get("ov") or {})
    return ov


def _can_kill(pid: int) -> tuple:
    """能否结束该进程 → (是否允许, 拒绝原因)。"""
    if psutil is None:
        return False, "未安装 psutil"
    if pid <= 1:
        return False, "拒绝操作：该 pid 属于系统关键进程"
    if pid == _APP_PID:
        return False, "拒绝操作：这是本服务自身的进程"
    if pid in _PROTECT:
        return False, "拒绝操作：这是启动本服务的进程链上的进程"
    try:
        user = psutil.Process(pid).username()
    except psutil.NoSuchProcess:
        return False, "进程已不存在"
    except psutil.AccessDenied:
        return False, "权限不足：无法操作该进程"
    except Exception:
        user = ""
    me = _my_name()
    if me and user and user != me:
        return False, "权限不足：该进程属于用户「%s」，只能结束自己的进程" % user
    if _MY_UID >= 0:
        try:
            if os.stat("/proc/%d" % pid).st_uid != _MY_UID:       # 仅 Linux 有 /proc
                return False, "权限不足：该进程属于其他用户"
        except OSError:
            pass
    return True, ""


def processes(sort: str = "cpu", q: str = "", limit: int = 300) -> dict:
    """进程列表：排序 / 过滤 / 附带「是否可结束」。"""
    if psutil is None:
        return {"error": _empty_ov("")["summary"], "procs": []}
    snap = _ensure()
    rows = list(snap.get("procs") or [])
    key = (q or "").strip().lower()
    if key:
        rows = [r for r in rows
                if key in (r["name"] or "").lower() or key in (r["cmd"] or "").lower()
                or key in (r["user"] or "").lower() or str(r["pid"]) == key]
    keys = {
        "cpu": lambda r: -r["cpu"],
        "mem": lambda r: -r["rss"],
        "pid": lambda r: r["pid"],
        "name": lambda r: (r["name"] or "").lower(),
        "threads": lambda r: -r["threads"],
        "started": lambda r: -r["started"],
    }
    rows.sort(key=keys.get(sort) or keys["cpu"])
    try:
        limit = max(1, min(1000, int(limit)))
    except (TypeError, ValueError):
        limit = 300
    out = []
    for r in rows[:limit]:
        ok, why = (True, "") if r["in_app"] and r["pid"] != _APP_PID else _can_kill(r["pid"])
        out.append(dict(r, can_kill=ok, kill_hint=why))
    return {"procs": out, "count": len(rows), "shown": len(out), "self_pid": _APP_PID}


def ports() -> dict:
    """监听中的端口（复用 portinfo，3 秒缓存）。"""
    now = time.time()
    if _PORT_CACHE["rows"] and now - _PORT_CACHE["t"] < _PORT_TTL:
        rows = _PORT_CACHE["rows"]
    else:
        try:
            rows = portinfo.list_ports()
        except Exception as e:
            _log.warning("读取端口列表失败：%s", e)
            rows = []
        _PORT_CACHE["t"] = now
        _PORT_CACHE["rows"] = rows
    return {"ports": rows, "count": len(rows)}


def kill_pid(pid) -> dict:
    """结束指定进程：先 SIGTERM，3 秒后仍未退出再 SIGKILL（只作用于该 pid）。"""
    if psutil is None:
        return {"error": "未安装 psutil，无法结束进程"}
    try:
        pid = int(pid)
    except (TypeError, ValueError):
        return {"error": "无效的 pid"}
    ok, why = _can_kill(pid)
    if not ok:
        return {"error": why}
    try:
        p = psutil.Process(pid)
        p.terminate()
    except psutil.NoSuchProcess:
        return {"ok": True, "pid": pid, "already_gone": True}
    except psutil.AccessDenied:
        return {"error": "权限不足，无法结束该进程"}
    except Exception as e:
        return {"error": "发送终止信号失败：%s" % e}
    try:
        p.wait(timeout=3)
        return {"ok": True, "pid": pid, "signal": "SIGTERM"}
    except Exception:
        pass
    try:
        p.kill()
        return {"ok": True, "pid": pid, "signal": "SIGKILL"}
    except psutil.NoSuchProcess:
        return {"ok": True, "pid": pid, "signal": "SIGTERM"}
    except Exception as e:
        return {"error": "强制结束失败：%s" % e}

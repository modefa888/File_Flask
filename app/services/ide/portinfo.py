"""端口占用查询与强制释放。

- list_ports()：列出本机处于监听状态的 TCP/UDP 端口，并补上占用进程的
  pid / 进程名 / 启动命令 / 工作目录（即「是哪个项目占了这个端口」）；
- kill_pid()：释放被占用的端口（先 SIGTERM，超时再 SIGKILL，作用于整个进程组）。

端口信息优先用 iproute2 的 ss（能直接给出 pid），取不到时回退到解析
/proc/net/tcp* 并扫描 /proc/<pid>/fd 反查 socket inode，保证在精简系统上也能用。

安全说明：只做「查」与「按 pid 结束进程」，不接受用户提供的命令；
拒绝结束 pid<=1 以及本服务自身的进程。
"""
import os
import re
import signal
import subprocess
import time

from ...log import get_logger

try:
    import pwd
except ImportError:                                   # 非 Unix 平台（本项目实际仅支持 Unix）
    pwd = None


_log = get_logger()

_MAX_PORTS = 300
_CMD_TIMEOUT = 5
_KILL_WAIT = 3.0                                      # SIGTERM 后等待秒数，超时再 SIGKILL

# ss 输出（ss -Hlntup）：proto state recv-q send-q local peer [process]
_SS_LINE_RE = re.compile(r"^(tcp|udp)\s+(\S+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s*(.*)$")


def _run(argv):
    try:
        p = subprocess.run(argv, capture_output=True, timeout=_CMD_TIMEOUT,
                           stdin=subprocess.DEVNULL)
    except (OSError, subprocess.SubprocessError) as e:
        _log.warning("执行 %s 失败：%s", argv[0], e)
        return ""
    return (p.stdout or b"").decode("utf-8", "replace")


def _uid_name(uid: int) -> str:
    if pwd is None:
        return str(uid)
    try:
        return pwd.getpwuid(uid).pw_name
    except (KeyError, OSError):
        return str(uid)


def _proc_info(pid: int) -> dict:
    """读取进程的 名称 / 命令行 / 工作目录 / 属主 / 是否属于当前用户。"""
    info = {"name": "", "cmd": "", "cwd": "", "user": "", "mine": False}
    if not pid:
        return info
    try:
        st = os.stat("/proc/%d" % pid)
        info["user"] = _uid_name(st.st_uid)
        info["mine"] = (st.st_uid == os.getuid())
    except OSError:
        return info
    try:
        with open("/proc/%d/cmdline" % pid, "rb") as f:
            parts = [x.decode("utf-8", "replace") for x in f.read().split(b"\0") if x]
        info["cmd"] = " ".join(parts)
        if parts:
            info["name"] = os.path.basename(parts[0])
    except OSError:
        pass
    if not info["name"]:
        try:
            with open("/proc/%d/comm" % pid, "r", encoding="utf-8", errors="replace") as f:
                info["name"] = f.read().strip()
        except OSError:
            pass
    try:
        info["cwd"] = os.readlink("/proc/%d/cwd" % pid)
    except OSError:
        pass
    return info


def _parse_ss_pids(text: str) -> list:
    """从 ss 的 users:(("node",pid=123,fd=4)) 里取出 pid 列表。"""
    pids = []
    for chunk in (text or "").split("users:("):
        if "pid=" not in chunk:
            continue
        seg = chunk.split(")")[0]
        for item in seg.split("),("):
            for kv in item.split(","):
                kv = kv.strip('"() ')
                if kv.startswith("pid="):
                    try:
                        pid = int(kv[4:])
                    except ValueError:
                        continue
                    if pid not in pids:
                        pids.append(pid)
    return pids


def _from_ss() -> list:
    """用 ss 抓监听端口；拿不到进程信息时也返回（pid 为空，前端只展示不可杀）。"""
    text = _run(["ss", "-Hlntup"]) or _run(["ss", "-Hlntu"])
    rows = []
    for line in (text or "").splitlines():
        m = _SS_LINE_RE.match(line.strip())
        if not m:
            continue
        proto, _state, _rq, _sq, local, _peer, rest = m.groups()
        addr, _, port = local.rpartition(":")
        try:
            port = int(port)
        except ValueError:
            continue
        if not 1 <= port <= 65535:
            continue
        rows.append({"proto": proto, "port": port, "addrs": [addr], "pids": _parse_ss_pids(rest)})
    return rows


def _from_proc() -> list:
    """ss 不可用时的兜底：/proc/net/* 找 inode，再扫 /proc/<pid>/fd 反查进程。"""
    sockets = {}
    for fname, proto in (("tcp", "tcp"), ("tcp6", "tcp"), ("udp", "udp"), ("udp6", "udp")):
        try:
            with open("/proc/net/" + fname, "r", encoding="utf-8") as f:
                lines = f.readlines()[1:]
        except OSError:
            continue
        for line in lines:
            parts = line.split()
            if len(parts) < 10:
                continue
            state = parts[3]
            if fname.startswith("tcp") and state != "0A":       # 0A = LISTEN
                continue
            if fname.startswith("udp") and state != "07":       # 07 = 无对端
                continue
            try:
                _hex_addr, hex_port = parts[1].split(":")
                port = int(hex_port, 16)
                inode = int(parts[9])
            except (ValueError, IndexError):
                continue
            sockets[inode] = (proto, port)
    if not sockets:
        return []

    owners = {}
    for pid in os.listdir("/proc"):
        if not pid.isdigit():
            continue
        fddir = os.path.join("/proc", pid, "fd")
        try:
            fds = os.listdir(fddir)
        except OSError:
            continue
        for fd in fds:
            try:
                target = os.readlink(os.path.join(fddir, fd))
            except OSError:
                continue
            if not target.startswith("socket:["):
                continue
            try:
                ino = int(target[8:-1])
            except ValueError:
                continue
            if ino in sockets:
                owners.setdefault(ino, [])
                p = int(pid)
                if p not in owners[ino]:
                    owners[ino].append(p)

    rows = []
    for ino, (proto, port) in sockets.items():
        rows.append({"proto": proto, "port": port, "addrs": [""], "pids": owners.get(ino, [])})
    return rows


def list_ports() -> list:
    """监听中的端口 + 占用进程信息，按「自己的进程优先、端口升序」排序。"""
    rows = _from_ss() or _from_proc()

    merged = {}                                       # (proto, port) -> 合并多地址 / 多进程
    for r in rows:
        key = (r["proto"], r["port"])
        cur = merged.get(key)
        if not cur:
            merged[key] = r
            continue
        for a in r["addrs"]:
            if a and a not in cur["addrs"]:
                cur["addrs"].append(a)
        for p in r["pids"]:
            if p not in cur["pids"]:
                cur["pids"].append(p)

    out = []
    for r in merged.values():
        pid = r["pids"][0] if r["pids"] else 0
        info = _proc_info(pid)
        mine = bool(info["mine"]) or any(_proc_info(p)["mine"] for p in r["pids"])
        out.append({
            "proto": r["proto"], "port": r["port"],
            "addr": ", ".join([a for a in r["addrs"] if a]) or "*",
            "pid": pid, "pids": r["pids"],
            "name": info["name"], "cmd": info["cmd"], "cwd": info["cwd"],
            "user": info["user"], "mine": mine,
            "can_kill": bool(mine and pid and pid != os.getpid() and pid > 1),
        })
    out.sort(key=lambda x: (not x["mine"], x["port"]))
    return out[:_MAX_PORTS]


def kill_pid(pid: int) -> dict:
    """强制结束进程（整个进程组）：先 SIGTERM，超时再 SIGKILL。"""
    try:
        pid = int(pid)
    except (TypeError, ValueError):
        return {"error": "无效的 pid"}
    if pid <= 1:
        return {"error": "拒绝操作：该 pid 属于系统关键进程"}
    if pid == os.getpid():
        return {"error": "拒绝操作：这是本服务自身的进程"}
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return {"ok": True, "already_gone": True}
    except PermissionError:
        return {"error": "权限不足，无法结束该进程（可能属于其他用户）"}

    try:
        pgid = os.getpgid(pid)
    except OSError:
        pgid = None
    try:
        if pgid and pgid != os.getpgid(0):
            os.killpg(pgid, signal.SIGTERM)
        else:
            os.kill(pid, signal.SIGTERM)
    except OSError as e:
        return {"error": f"发送 SIGTERM 失败：{e}"}

    deadline = time.time() + _KILL_WAIT
    while time.time() < deadline:
        time.sleep(0.1)
        try:
            os.kill(pid, 0)
        except OSError:
            return {"ok": True, "killed": True, "signal": "SIGTERM"}
    try:
        if pgid and pgid != os.getpgid(0):
            os.killpg(pgid, signal.SIGKILL)
        else:
            os.kill(pid, signal.SIGKILL)
    except OSError as e:
        return {"error": f"发送 SIGKILL 失败：{e}"}
    return {"ok": True, "killed": True, "signal": "SIGKILL"}

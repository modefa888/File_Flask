"""V2Ray / Xray 运行管理：拉取订阅、生成配置、启动 / 停止内核、状态与日志。

进程模型：本模块在 Flask 进程内维护一个单例，负责拉起一个 xray 子进程。
子进程用独立的会话（start_new_session=True）启动，因此不会随请求结束而退出；
父进程重启后靠 data/v2ray/state.json 里的 pid 重新「接管」上一个子进程。

对外接口：
    status()                      汇总状态（内核 / 进程 / 入站 / 分享地址）
    start(node_id)                按节点生成配置并启动
    stop()                        停止内核
    restart()                     重启（沿用当前节点）
    traffic()                     实时网速 + 各节点 / 总流量统计（持久化在库里）
    reset_traffic()               流量统计清零
    log_tail(lines)               读取运行日志末尾若干行
    clear_log()                   清空运行日志
    fetch_subscription(sub)       拉取并解析一个订阅，返回 (链接列表, 错误信息)
    fetch_and_store(sub)          拉取订阅并把节点写入库（覆盖该订阅旧节点）
"""
from __future__ import annotations

import json
import os
import signal
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.request
import uuid

from ... import config
from ...log import get_logger
from ..common import proxyutil, secret
from . import v2raycfg, v2raydb

_log = get_logger()

_DIR = os.path.join(config.DATA_ROOT, "v2ray")
_CONFIG_FILE = os.path.join(_DIR, "config.json")
_LOG_FILE = os.path.join(_DIR, "xray.log")
_STATE_FILE = os.path.join(_DIR, "state.json")
_CORE_DIR = os.path.join(_DIR, "core")

_LOG_MAX = 512 * 1024          # 运行日志超过此大小就截断（保留末尾）
_lock = threading.RLock()
_proc = None                   # 当前子进程句柄（本进程内）
_meta = {}                     # 当前运行的元信息：node_id / node_name / started_at / core / config
_boot_checked = False


def _ensure_dir():
    os.makedirs(_CORE_DIR, exist_ok=True)


# ---------------------------------------------------------------------------
# 状态文件（跨进程重启接管）
# ---------------------------------------------------------------------------

def _read_state() -> dict:
    try:
        with open(_STATE_FILE, "r", encoding="utf-8") as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def _write_state(d: dict):
    _ensure_dir()
    try:
        tmp = _STATE_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(d, f, ensure_ascii=False, indent=2)
        os.replace(tmp, _STATE_FILE)
    except OSError as e:
        _log.warning("写入 V2Ray 状态文件失败: %s", e)


def _pid_alive(pid: int) -> bool:
    """判断 pid 是否仍存活，且确实是内核进程（避免 pid 被复用误判）。"""
    if not pid or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    try:
        with open("/proc/%d/cmdline" % pid, "rb") as f:
            cmd = f.read().decode("utf-8", "replace")
    except OSError:
        return True                 # 读不到 cmdline（非 Linux）时按存活处理
    return "xray" in cmd or "v2ray" in cmd


def _boot_check():
    """首次调用时，尝试接管上次遗留的内核进程（父进程重启场景）。"""
    global _boot_checked, _meta
    if _boot_checked:
        return
    _boot_checked = True
    st = _read_state()
    pid = int(st.get("pid") or 0)
    if pid and _pid_alive(pid):
        _meta = {"node_id": st.get("node_id", ""), "node_name": st.get("node_name", ""),
                 "started_at": float(st.get("started_at") or 0), "core": st.get("core", ""),
                 "external": True}
        _log.info("接管已运行的 V2Ray 内核进程 pid=%s", pid)
    elif pid:
        try:
            os.remove(_STATE_FILE)
        except OSError:
            pass


# ---------------------------------------------------------------------------
# 入站端口 / 分享地址
# ---------------------------------------------------------------------------

def _port_free(port: int) -> bool:
    """端口是否空闲（未监听）。"""
    if not port:
        return False
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        s.bind(("0.0.0.0", int(port)))
        return True
    except OSError:
        return False
    finally:
        s.close()


def _share_urls(port: int, listen: str, user: str, pwd: str, http_port: int = 0) -> list:
    """给出可供其他用户填写的代理地址（局域网 + 本机；开了 HTTP 入站再补 http:// 条目）。"""
    auth = ""
    if user:
        auth = "%s:%s@" % (user, pwd or "")
    ip = v2raycfg.lan_ip()
    urls = []
    if listen == "0.0.0.0" and ip:
        urls.append({"label": "局域网", "url": "socks5://%s%s:%s" % (auth, ip, port)})
        if http_port:
            urls.append({"label": "局域网 HTTP", "url": "http://%s%s:%s" % (auth, ip, http_port)})
    urls.append({"label": "本机", "url": "socks5://%s127.0.0.1:%s" % (auth, port)})
    if http_port:
        urls.append({"label": "本机 HTTP", "url": "http://%s127.0.0.1:%s" % (auth, http_port)})
    return urls


# ---------------------------------------------------------------------------
# 日志
# ---------------------------------------------------------------------------

def log_tail(lines: int = 200) -> str:
    lines = max(1, min(int(lines or 200), 2000))
    try:
        with open(_LOG_FILE, "r", encoding="utf-8", errors="replace") as f:
            buf = f.readlines()
        return "".join(buf[-lines:])
    except OSError:
        return ""


def clear_log():
    try:
        open(_LOG_FILE, "w", encoding="utf-8").close()
    except OSError:
        pass


def _trim_log():
    """日志过大时只保留末尾部分，避免长期运行把磁盘写满。"""
    try:
        if os.path.getsize(_LOG_FILE) > _LOG_MAX:
            with open(_LOG_FILE, "r", encoding="utf-8", errors="replace") as f:
                buf = f.readlines()
            keep, size = [], 0
            for line in reversed(buf):
                size += len(line.encode("utf-8", "replace"))
                if size > _LOG_MAX // 2:
                    break
                keep.append(line)
            with open(_LOG_FILE, "w", encoding="utf-8") as f:
                f.write("".join(reversed(keep)))
    except OSError:
        pass


# ---------------------------------------------------------------------------
# 启动 / 停止
# ---------------------------------------------------------------------------

def _settings() -> dict:
    """读模块设置；入站密码落库时是密文，这里还原成明文供生成配置使用。"""
    st = v2raydb.all_settings()
    st["socks_pass"] = secret.decrypt(st.get("socks_pass"))
    return st


def _auth_on(st: dict) -> bool:
    """SOCKS5 认证开关是否生效：0.0.0.0 监听强制启用，本机监听由 auth_enabled 决定。"""
    if (st.get("socks_listen") or "127.0.0.1") == "0.0.0.0":
        return True
    try:
        return int(st.get("auth_enabled") if str(st.get("auth_enabled") or "") != "" else 1) == 1
    except (TypeError, ValueError):
        return True


def _apply_auth(st: dict) -> dict:
    """返回「生效视图」：认证关闭时清空 user / pass（只影响内存副本，落库凭据保留）。"""
    if not _auth_on(st):
        st["socks_user"], st["socks_pass"] = "", ""
    return st


def _core_path(st: dict) -> str:
    return v2raycfg.find_core(st.get("core_path") or "")


def _gen_creds(st: dict) -> None:
    """补齐缺失的 SOCKS5 用户名 / 密码：明文进 st，落库（密码加密保存）。"""
    import secrets
    changed = False
    if not str(st.get("socks_user") or "").strip():
        st["socks_user"] = "u" + secrets.token_hex(4)
        v2raydb.set_setting("socks_user", st["socks_user"])
        changed = True
    if not str(st.get("socks_pass") or ""):
        st["socks_pass"] = secrets.token_urlsafe(12)
        v2raydb.set_setting("socks_pass", secret.encrypt(st["socks_pass"]))
        changed = True
    if changed:
        _log.warning("SOCKS5 认证已自动生成（用户名 %s，密码加密落库）", st["socks_user"])


def _ensure_lan_auth(st: dict) -> None:
    """监听 0.0.0.0（局域网可用）时强制启用 SOCKS5 认证，避免裸奔代理被同网段任意使用。"""
    if (st.get("socks_listen") or "127.0.0.1") != "0.0.0.0":
        return
    if int(st.get("auth_enabled") if str(st.get("auth_enabled") or "") != "" else 1) != 1:
        st["auth_enabled"] = 1
        v2raydb.set_setting("auth_enabled", 1)
    if str(st.get("socks_user") or "").strip() and str(st.get("socks_pass") or "").strip():
        return
    _gen_creds(st)


def gen_lan_auth() -> dict:
    """界面选择 0.0.0.0 时立即生成凭据（无视当前落库的监听地址），返回明文供回填显示。"""
    with _lock:
        st = _settings()
        _gen_creds(st)
        return {"socks_user": str(st.get("socks_user") or ""),
                "socks_pass": str(st.get("socks_pass") or "")}


def _validate_config(core: str, cfg_path: str) -> str:
    """用 `xray run -test -c` 校验配置，返回空串表示通过，否则返回中文错误。"""
    try:
        p = subprocess.run([core, "run", "-test", "-c", cfg_path],
                           capture_output=True, text=True, timeout=15)
    except (OSError, subprocess.SubprocessError) as e:
        return "内核校验失败：%s" % e
    if p.returncode == 0:
        return ""
    detail = ((p.stderr or "") + (p.stdout or "")).strip()
    return "内核校验配置未通过：%s" % (detail[-800:] or ("退出码 %s" % p.returncode))


def start(node_id: str) -> dict:
    """按节点启动内核；已有进程则先停掉。返回 status()。"""
    global _proc, _meta
    with _lock:
        st = _settings()
        _ensure_lan_auth(st)
        st = _apply_auth(st)
        core = _core_path(st)
        if not core:
            return {"error": "没有找到可用的 Xray / V2Ray 内核，请先安装或手动指定路径"}

        node = v2raydb.get_node(node_id)
        if not node:
            return {"error": "节点不存在，请重新选择"}

        port = int(st.get("socks_port") or 10808)
        if _proc is None and not _port_free(port) and not _running_unmanaged():
            return {"error": "端口 %s 已被其它进程占用，请先在设置里改端口或结束占用进程" % port}

        _ensure_dir()
        try:
            cfg = v2raycfg.build_config(node, st)
        except ValueError as e:
            return {"error": "生成配置失败：%s" % e}

        tmp = _CONFIG_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(cfg, f, ensure_ascii=False, indent=2)
        os.replace(tmp, _CONFIG_FILE)

        err = _validate_config(core, _CONFIG_FILE)
        if err:
            return {"error": err}

        _stop_locked()

        _trim_log()
        try:
            logf = open(_LOG_FILE, "a", encoding="utf-8")
        except OSError as e:
            return {"error": "无法写入运行日志：%s" % e}
        try:
            # 独立会话 + 把 stdin 接到 /dev/null，避免随 Flask 的请求 / 终端退出而收到 SIGHUP
            _proc = subprocess.Popen([core, "run", "-c", _CONFIG_FILE], cwd=_DIR,
                                     stdin=subprocess.DEVNULL, stdout=logf, stderr=logf,
                                     start_new_session=True)
        except OSError as e:
            logf.close()
            return {"error": "启动内核失败：%s" % e}
        finally:
            logf.close()

        time.sleep(1.0)
        if _proc.poll() is not None:
            tail = log_tail(35)
            code = _proc.returncode
            _proc = None
            return {"error": "内核启动后立即退出（退出码 %s）。\n%s" % (code, tail[-1200:])}

        _meta = {"node_id": node.get("id") or "", "node_name": node.get("name") or "",
                 "started_at": time.time(), "core": core}
        _write_state({"pid": _proc.pid, "node_id": _meta["node_id"],
                      "node_name": _meta["node_name"], "started_at": _meta["started_at"],
                      "core": core, "port": port})
        v2raydb.set_setting("active_node", _meta["node_id"])
        _log.info("V2Ray 内核已启动 pid=%s 节点=%s 端口=%s", _proc.pid, _meta["node_name"], port)
        return status()


def _running_unmanaged() -> bool:
    """当前是否有一个「非本进程管理」但仍在运行的内核（重启接管场景）。"""
    st = _read_state()
    pid = int(st.get("pid") or 0)
    return bool(pid and _pid_alive(pid) and (_proc is None or _proc.pid != pid))


def _stop_locked() -> bool:
    """内部使用（调用方已持锁）：停止本进程管理的或接管的那个内核进程。"""
    global _proc, _meta
    stopped = False
    if _proc is not None:
        stopped = _kill(_proc.pid)
        _proc = None
        stopped = True
    else:
        st = _read_state()
        pid = int(st.get("pid") or 0)
        if pid and _pid_alive(pid):
            _kill(pid)
            stopped = True
    _meta = {}
    try:
        os.remove(_STATE_FILE)
    except OSError:
        pass
    return stopped


def stop() -> dict:
    with _lock:
        _boot_check()
        stopped = _stop_locked()
    return {"stopped": stopped, "status": status()}


def _kill(pid: int) -> bool:
    """先 SIGTERM 再 SIGKILL，连同进程组一起结束。"""
    if not pid:
        return False
    try:
        os.killpg(os.getpgid(pid), signal.SIGTERM)
    except OSError:
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            return False
    for _ in range(20):
        time.sleep(0.1)
        if not _pid_alive(pid):
            return True
    try:
        os.killpg(os.getpgid(pid), signal.SIGKILL)
    except OSError:
        try:
            os.kill(pid, signal.SIGKILL)
        except OSError:
            pass
    return True


def restart() -> dict:
    with _lock:
        st = _read_state()
        node_id = _meta.get("node_id") or st.get("node_id") or _settings().get("active_node")
    if not node_id:
        return {"error": "还没有连接过节点，无法重启"}
    return start(node_id)


# ---------------------------------------------------------------------------
# 状态汇总
# ---------------------------------------------------------------------------

def status() -> dict:
    with _lock:
        _boot_check()
        st = _settings()
        core = _core_path(st)
        pid = 0
        if _proc is not None and _proc.poll() is None:
            pid = _proc.pid
        else:
            sp = int(_read_state().get("pid") or 0)
            if sp and _pid_alive(sp):
                pid = sp
        running = bool(pid)
        port = int(st.get("socks_port") or 10808)
        listen = st.get("socks_listen") or "0.0.0.0"
        node = v2raydb.get_node(_meta.get("node_id")) if _meta.get("node_id") else None
        if not node and running:
            sp = _read_state().get("node_id")
            node = v2raydb.get_node(sp) if sp else None
        eff = _apply_auth(dict(st))   # 认证关闭时：状态栏 / 分享链接不带凭据（落库值保留）
        return {
            "core": {"path": core, "ok": bool(core),
                     "version": v2raycfg.core_version(core) if core else "",
                     "dir": _CORE_DIR},
            "running": running,
            "pid": pid,
            "started_at": _meta.get("started_at") or _read_state().get("started_at") or 0,
            "uptime": int(time.time() - (_meta.get("started_at") or
                                         float(_read_state().get("started_at") or 0)))
            if running else 0,
            "node": {"id": node.get("id"), "name": node.get("name"), "proto": node.get("proto"),
                     "server": node.get("server"), "port": node.get("port")} if node else None,
            "inbound": {"socks_port": port, "listen": listen, "http_port": int(st.get("http_port") or 0),
                        "auth": bool(str(eff.get("socks_user") or "").strip())},
            "share": _share_urls(port, listen, str(eff.get("socks_user") or ""),
                                 str(eff.get("socks_pass") or ""),
                                 int(eff.get("http_port") or 0)),
            "port_free": _port_free(port),
            "settings": {k: v for k, v in st.items() if k != "socks_pass"},
            "has_pass": bool(str(st.get("socks_pass") or "").strip()),
            "log_file": _LOG_FILE,
        }


# ---------------------------------------------------------------------------
# 流量统计：后台线程每 2 秒向内核 stats API 查询代理出站的上下行计数，
# 与上次相减得到「实时网速」，并把增量累到当前节点 / 总行（落库持久化）。
# ---------------------------------------------------------------------------

_STAT_INTERVAL = 2.0          # 采样间隔（秒）
_stat_lock = threading.Lock()
_stat = {"speed_up": 0.0, "speed_down": 0.0, "ts": 0.0,
         "prev": {}, "api_ok": False}       # prev = 上次内核计数器（检测重启清零）
_stats_thread = None


def _stats_sample():
    """采样一次内核统计；内核未运行 / API 未开启时速度归零。"""
    try:
        st = status()
    except Exception:                          # noqa: BLE001
        return
    core = (st.get("core") or {}).get("path") or ""
    api_port = int((st.get("settings") or {}).get("api_port") or 0)
    node_id = (st.get("node") or {}).get("id") or ""
    counters = {}
    if st.get("running") and core and api_port:
        try:
            p = subprocess.run([core, "api", "statsquery", "--server=127.0.0.1:%d" % api_port],
                               capture_output=True, text=True, timeout=5)
            if p.returncode == 0:
                j = json.loads(p.stdout)
                for it in (j.get("stat") or []):
                    name = str(it.get("name") or "")
                    if name.startswith("outbound>>>proxy>>>traffic>>>"):
                        key = name.rsplit(">>>", 1)[-1]
                        counters[key] = int(str(it.get("value") or 0) or 0)
        except (OSError, subprocess.SubprocessError, ValueError, TypeError):
            counters = {}
    ok = "uplink" in counters and "downlink" in counters
    now = time.time()
    with _stat_lock:
        prev = _stat.get("prev") or {}
        last_ts = float(_stat.get("ts") or 0)
        su = sd = 0.0
        if ok and prev and last_ts:
            dt = max(0.5, now - last_ts)
            du = max(0, counters["uplink"] - int(prev.get("up") or 0))
            dd = max(0, counters["downlink"] - int(prev.get("down") or 0))
            if (du or dd) and node_id:
                # 增量计入当前节点 + 全局总行；两行合并成一次事务调用
                v2raydb.add_traffic(node_id, du, dd)
                v2raydb.add_traffic("__total__", du, dd)
            su, sd = du / dt, dd / dt
        _stat.update({"speed_up": su, "speed_down": sd, "ts": now, "api_ok": ok,
                      "prev": {"up": counters.get("uplink", 0),
                               "down": counters.get("downlink", 0)} if ok else {}})


def _stats_loop():
    while True:
        try:
            _stats_sample()
        except Exception:                      # noqa: BLE001
            pass
        time.sleep(_STAT_INTERVAL)


def _ensure_stats_thread():
    global _stats_thread
    if _stats_thread is None or not _stats_thread.is_alive():
        _stats_thread = threading.Thread(target=_stats_loop, daemon=True,
                                         name="v2ray-stats")
        _stats_thread.start()


def traffic() -> dict:
    """实时网速 + 流量统计：{speed:{up,down}, total:{up,down}, nodes:[...], api_ok}。"""
    _ensure_stats_thread()
    with _stat_lock:
        speed = {"up": round(_stat.get("speed_up") or 0.0),
                 "down": round(_stat.get("speed_down") or 0.0)}
        api_ok = bool(_stat.get("api_ok"))
    rows = v2raydb.traffic_rows()
    tot = rows.get("__total__") or {}
    by_id = {n.get("id"): n for n in v2raydb.list_nodes()}
    nodes = []
    for nid, r in rows.items():
        if nid == "__total__":
            continue
        n = by_id.get(nid)
        if not n:
            continue                           # 节点已删除的残留记录不再展示
        nodes.append({"id": nid, "name": n.get("name"), "proto": n.get("proto"),
                      "up": r["up"], "down": r["down"]})
    nodes.sort(key=lambda x: -(x["up"] + x["down"]))
    return {"speed": speed, "api_ok": api_ok,
            "total": {"up": int(tot.get("up") or 0), "down": int(tot.get("down") or 0)},
            "nodes": nodes}


def reset_traffic() -> dict:
    """清零全部流量统计（含总行），并把内存计数器基准清掉。"""
    v2raydb.reset_traffic()
    with _stat_lock:
        _stat["prev"] = {}
    return {"ok": True, "traffic": traffic()}


# ---------------------------------------------------------------------------
# 订阅拉取
# ---------------------------------------------------------------------------

def fetch_subscription(sub: dict):
    """拉取订阅内容，返回 (分享链接列表, 错误信息)。

    sub 里可用 proxy 字段指定拉取时走的代理（例如已连上本模块自己的
    socks5://127.0.0.1:10808，用来拉取需要翻墙才能访问的订阅站）。
    """
    url = str((sub or {}).get("url") or "").strip()
    if not url:
        return [], "订阅地址为空"
    proxy = str((sub or {}).get("proxy") or "").strip() or _settings().get("sub_proxy") or ""
    try:
        opener = proxyutil.build_opener(proxy=proxy, follow_redirects=True)
        req = urllib.request.Request(url, headers={
            "User-Agent": "Mozilla/5.0 (compatible; FileFlask-V2Ray/1.0)",
            "Accept": "*/*",
        })
        with opener.open(req, timeout=30) as resp:
            raw = resp.read(4 * 1024 * 1024)
    except urllib.error.HTTPError as e:
        return [], "订阅请求失败：%s" % proxyutil.http_status_text(e.code)
    except Exception as e:                      # noqa: BLE001
        return [], proxyutil.friendly_error(e, url)
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        text = raw.decode("utf-8", "replace")
    links = v2raycfg.parse_subscription(text)
    if not links:
        return [], "订阅内容里没有解析到节点（支持 vmess / vless / trojan / ss 分享链接）"
    return links, ""


def fetch_and_store(sub: dict) -> dict:
    """拉取订阅并覆盖该订阅下的节点；返回 {ok, count, error}。"""
    sid = str((sub or {}).get("id") or "")
    links, err = fetch_subscription(sub)
    if err:
        if sid:
            v2raydb.set_sub_result(sid, error=err)
        return {"ok": False, "count": 0, "error": err}
    nodes = []
    bad = 0
    for ln in links:
        try:
            nodes.append(v2raycfg.parse_share_link(ln))
        except ValueError:
            bad += 1
    if sid:
        v2raydb.clear_sub_nodes(sid)
    n = v2raydb.add_nodes(nodes, sub_id=sid)
    if sid:
        v2raydb.set_sub_result(sid, node_count=n, error="")
    note = ""
    if bad:
        note = "（另有 %s 条链接无法解析，已跳过）" % bad
    return {"ok": True, "count": n, "error": "", "note": note}


def core_info() -> dict:
    """内核探测信息：已找到的候选 + 当前选用。"""
    cores = v2raycfg.detect_cores()
    st = _settings()
    cur = _core_path(st)
    plat, arch = v2raycfg.platform_arch()
    return {"found": cores, "current": cur,
            "version": v2raycfg.core_version(cur) if cur else "",
            "platform": "%s/%s" % (plat, arch)}


# ---------------------------------------------------------------------------
# 后台任务：内核探测 / 下载的实时进度（前端用 SSE 拉，画进度条）
# ---------------------------------------------------------------------------
_JOBS = {}
_JOBS_LOCK = threading.Lock()
_JOB_TTL = 1800                # 任务记录保留时长（秒），避免内存里越积越多
_JOB_LOG_MAX = 60              # 每个任务最多保留多少行步骤日志

# 阶段名 → 中文说明（on_phase 回调给的是英文键）
_PHASE_TEXT = {"download": "正在下载内核", "extract": "正在解压", "done": "正在校验"}


def _job_sweep():
    """清掉过期任务（调用方需持有 _JOBS_LOCK）。"""
    now = time.time()
    for k in [k for k, v in _JOBS.items() if now - v["ts"] > _JOB_TTL]:
        _JOBS.pop(k, None)


def job_new(kind: str) -> str:
    """登记一个后台任务，返回任务 id。"""
    jid = uuid.uuid4().hex[:12]
    with _JOBS_LOCK:
        _job_sweep()
        _JOBS[jid] = {"id": jid, "kind": kind, "phase": "准备中", "pct": 0,
                      "got": 0, "total": 0, "done": False, "ok": None,
                      "error": "", "result": None, "log": [],
                      "ts": time.time(), "ver": 1}
    return jid


def _job_patch(jid: str, **kw):
    """更新任务字段并让版本号自增（SSE 靠版本号判断是否有新内容）。"""
    with _JOBS_LOCK:
        j = _JOBS.get(jid)
        if not j:
            return
        j.update(kw)
        j["ver"] += 1
        j["ts"] = time.time()


def _job_log(jid: str, line: str):
    with _JOBS_LOCK:
        j = _JOBS.get(jid)
        if not j:
            return
        j["log"] = (j["log"] + [line])[-_JOB_LOG_MAX:]
        j["ver"] += 1
        j["ts"] = time.time()


def job_get(jid: str):
    """取任务快照（线程安全；不存在返回 None）。"""
    with _JOBS_LOCK:
        j = _JOBS.get(jid)
        return dict(j) if j else None


def _run_detect(jid: str):
    seen = []
    try:
        def progress(i, total, path):
            _job_patch(jid, phase="正在探测内核", pct=int(i * 100 / total) if total else 0)
            if path and path not in seen:
                seen.append(path)
                _job_log(jid, "检测 " + path)

        cores = v2raycfg.detect_cores(progress=progress)
        for c in cores:
            _job_log(jid, "可用：%s · %s" % (c["version"], c["path"]))
        if not cores:
            _job_log(jid, "未发现可用的 xray / v2ray，可点下方按钮下载")
        _job_patch(jid, phase="探测完成", pct=100, done=True, ok=True,
                   result={"found": cores})
    except Exception as e:                     # noqa: BLE001
        _job_patch(jid, phase="探测失败", done=True, ok=False, error=str(e))


def _run_download(jid: str, url: str):
    _ensure_dir()
    last = {"t": 0.0, "pct": -1}

    def progress(got, total):
        pct = int(got * 100 / total) if total else 0
        now = time.time()
        # 限流：进度没变且距上次刷新不足 0.3 秒就跳过，避免 SSE 洪泛
        if pct == last["pct"] and now - last["t"] < 0.3:
            return
        last.update(t=now, pct=pct)
        _job_patch(jid, phase="正在下载内核", pct=pct, got=got, total=total)

    def phase(name):
        _job_patch(jid, phase=_PHASE_TEXT.get(name, name))
        if name == "extract":
            _job_patch(jid, pct=100)
        _job_log(jid, _PHASE_TEXT.get(name, name))

    try:
        _job_log(jid, "开始下载内核（%s/%s）" % v2raycfg.platform_arch())
        _job_log(jid, "直连 GitHub 失败时会自动切换加速镜像，可在下方步骤里看每个源的尝试结果")

        def on_log(line):
            _job_log(jid, line)

        exe = v2raycfg.download_core(_CORE_DIR, url=url, progress=progress,
                                     on_phase=phase, on_log=on_log)
    except ValueError as e:
        _job_patch(jid, phase="下载失败", done=True, ok=False, error=str(e))
        return
    v2raydb.set_setting("core_path", exe)
    ver = v2raycfg.core_version(exe)
    _log.info("已下载 V2Ray 内核：%s (%s)", exe, ver)
    _job_log(jid, "安装完成：%s %s" % (ver, exe))
    _job_patch(jid, phase="安装完成", pct=100, done=True, ok=True,
               result={"path": exe, "version": ver})


def core_detect_job() -> str:
    """后台执行内核探测（进度通过 job_* 查询 / SSE 推送）。"""
    jid = job_new("detect")
    threading.Thread(target=_run_detect, args=(jid,), daemon=True).start()
    return jid


def core_download_job(url: str = "") -> str:
    """后台下载内核到 data/v2ray/core，成功后自动登记路径。"""
    jid = job_new("download")
    threading.Thread(target=_run_download, args=(jid, str(url or "")), daemon=True).start()
    return jid

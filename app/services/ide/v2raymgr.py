"""V2Ray / Xray / sing-box 运行管理：拉取订阅、生成配置、启动 / 停止内核、状态与日志。

进程模型：本模块在 Flask 进程内维护一个单例，负责拉起一个内核子进程
（xray / v2ray / sing-box，类型由可执行文件名判定，见 v2raycfg.core_kind）。
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

import gzip
import json
import os
import re
import signal
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.parse
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
_VERSIONS_DIR = os.path.join(_DIR, "versions")   # 多版本共存：data/v2ray/versions/v<版本号>/

# 版本目录里可能出现的内核可执行文件名（xray / v2ray / sing-box 三种）
_EXE_NAMES = ("xray", "xray.exe", "v2ray", "v2ray.exe", "sing-box", "sing-box.exe")
# 内核输出里的终端颜色控制符（sing-box 的 FATAL/WARN 带颜色）
_ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")

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
    return "xray" in cmd or "v2ray" in cmd or "sing-box" in cmd


def _proc_mem(pid: int) -> int:
    """内核进程的常驻内存（字节）；取不到（非 Linux / 进程已退出）返回 0。"""
    if not pid:
        return 0
    try:
        with open("/proc/%d/status" % pid, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                if line.startswith("VmRSS:"):
                    return int(line.split()[1]) * 1024
    except (OSError, ValueError, IndexError):
        pass
    return 0


def _kernel_pid() -> int:
    """当前内核进程 pid（本进程拉起或接管的）；没在跑返回 0。"""
    if _proc is not None and _proc.poll() is None:
        return _proc.pid
    pid = int(_read_state().get("pid") or 0)
    return pid if pid and _pid_alive(pid) else 0


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


def _flag(v, default: int = 1) -> int:
    """把设置值安全地解析成 0/1 开关；空值 / 非数字时用默认。
    注意不能写 `v or ""`：v 为整数 0（=用户明确选了停用）时会被当成空值吞掉。"""
    try:
        s = str(v).strip()
        return int(s) if s != "" else default
    except (TypeError, ValueError):
        return default


def _auth_on(st: dict) -> bool:
    """SOCKS5 认证开关是否生效：0.0.0.0 监听强制启用，本机监听由 auth_enabled 决定。"""
    if (st.get("socks_listen") or "127.0.0.1") == "0.0.0.0":
        return True
    return _flag(st.get("auth_enabled"), 1) == 1


def _apply_auth(st: dict) -> dict:
    """返回「生效视图」：认证关闭时清空 user / pass（只影响内存副本，落库凭据保留）。"""
    if not _auth_on(st):
        st["socks_user"], st["socks_pass"] = "", ""
    return st


def core_path_key(kind: str) -> str:
    """内核路径按类型分开存：xray/v2ray 用 core_path，sing-box 用 core_path_singbox。"""
    return "core_path_singbox" if str(kind or "") == "sing-box" else "core_path"


def pick_core(st: dict) -> str:
    """取当前应使用的内核路径：按 core_kind 取对应的手动路径，其次自动探测。"""
    kind = str(st.get("core_kind") or "")
    manual = str(st.get(core_path_key(kind)) or "").strip()
    return v2raycfg.find_core(manual, prefer=kind)


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
    if _flag(st.get("auth_enabled"), 1) != 1:
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
    """校验配置，返回空串表示通过，否则返回中文错误。

    Xray / V2Ray 用 `run -test -c`，sing-box 用 `check -c`。
    """
    if v2raycfg.core_kind(core) == "sing-box":
        args = [core, "check", "-c", cfg_path]
    else:
        args = [core, "run", "-test", "-c", cfg_path]
    try:
        p = subprocess.run(args, capture_output=True, text=True, timeout=15)
    except (OSError, subprocess.SubprocessError) as e:
        return "内核校验失败：%s" % e
    if p.returncode == 0:
        return ""
    # sing-box 的报错带终端颜色控制符，直接显示到界面上很难看，先剥掉
    detail = _ANSI_RE.sub("", (p.stderr or "") + (p.stdout or "")).strip()
    return "内核校验配置未通过：%s" % (detail[-800:] or ("退出码 %s" % p.returncode))


def _write_and_validate(core: str, cfg: dict) -> str:
    """把配置写盘并交给内核自检；返回空串表示通过。"""
    tmp = _CONFIG_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)
    os.replace(tmp, _CONFIG_FILE)
    return _validate_config(core, _CONFIG_FILE)


def start(node_id: str) -> dict:
    """按节点启动内核；已有进程则先停掉。返回 status()。"""
    global _proc, _meta
    with _lock:
        st = _settings()
        _ensure_lan_auth(st)
        st = _apply_auth(st)
        core = pick_core(st)
        if not core:
            return {"error": "没有找到可用的 Xray / V2Ray / sing-box 内核，请先安装或手动指定路径"}

        node = v2raydb.get_node(node_id)
        if not node:
            return {"error": "节点不存在，请重新选择"}

        port = int(st.get("socks_port") or 10808)
        if _proc is None and not _port_free(port) and not _running_unmanaged():
            return {"error": "端口 %s 已被其它进程占用，请先在设置里改端口或结束占用进程" % port}

        _ensure_dir()
        kind = v2raycfg.core_kind(core)
        try:
            cfg = v2raycfg.build_config(node, dict(st, core_path=core))
        except ValueError as e:
            return {"error": "生成配置失败：%s" % e}

        err = _write_and_validate(core, cfg)
        if err and kind == "sing-box" and "experimental" in cfg:
            # 个别 sing-box 版本没有 clash_api（或字段改名）→ 去掉统计段再试一次，
            # 「代理能用」比「有实时网速」重要
            cfg.pop("experimental", None)
            err = _write_and_validate(core, cfg)
            if not err:
                _log.warning("当前 sing-box 不支持 clash_api 统计接口，已关闭实时网速采样")
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
        _ensure_failover_thread()          # 连上节点即确保自动切换看门狗在跑
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


# ---------------------------------------------------------------------------
# 单节点「真延迟」探测（临时独立内核实例，不影响主实例）
# ---------------------------------------------------------------------------

_probe_lock = threading.Lock()
_probe_ports = set()           # 并发探测时已占用的临时端口（防撞）


def _probe_port() -> int:
    """申请一个空闲回环端口给临时探测实例（登记防并发冲突，用完释放）。"""
    with _probe_lock:
        st = _settings()
        used = _probe_ports | {int(st.get("socks_port") or 0),
                               int(st.get("http_port") or 0),
                               int(st.get("api_port") or 0)}
        for _ in range(50):
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            s.bind(("127.0.0.1", 0))
            p = s.getsockname()[1]
            s.close()
            if p not in used:
                _probe_ports.add(p)
                return p
    raise OSError("无法分配探测用端口")


def _temp_instance(node: dict) -> dict:
    """为节点起一个临时独立内核实例（回环端口、独立配置文件、无认证/HTTP/统计API）。
    成功返回 {"proc", "port", "cfg"}，失败返回 {"error"}。调用方在 finally 里调 _temp_cleanup。"""
    st = _settings()
    core = pick_core(st)
    if not core:
        return {"error": "没有找到可用的 Xray / V2Ray / sing-box 内核，请先安装或手动指定路径"}
    port = _probe_port()
    cfg_path = os.path.join(_DIR, "probe-%d.json" % port)
    try:
        try:
            cfg = v2raycfg.build_config(node, dict(st, core_path=core, socks_port=port,
                                                   socks_listen="127.0.0.1", http_port=0,
                                                   api_port=0, socks_user="", socks_pass=""))
        except ValueError as e:
            return {"error": "生成配置失败：%s" % e}
        with open(cfg_path, "w", encoding="utf-8") as f:
            json.dump(cfg, f, ensure_ascii=False)
        proc = subprocess.Popen([core, "run", "-c", cfg_path], cwd=_DIR,
                                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL, start_new_session=True)
        time.sleep(0.9)                 # 等内核完成启动
        if proc.poll() is not None:
            _temp_cleanup({"proc": proc, "cfg": cfg_path, "port": port})
            return {"error": "内核启动失败（退出码 %s）" % proc.returncode}
        return {"proc": proc, "port": port, "cfg": cfg_path}
    except Exception:                   # noqa: BLE001
        _temp_cleanup({"proc": proc, "cfg": cfg_path, "port": port})
        raise


def _temp_cleanup(ti: dict) -> None:
    """杀掉临时实例进程、删除临时配置、释放端口（可重复调用）。"""
    proc = ti.get("proc")
    if proc is not None and proc.poll() is None:
        try:
            proc.kill()
            proc.wait(timeout=3)
        except Exception:               # noqa: BLE001
            pass
    try:
        os.unlink(ti.get("cfg") or "")
    except OSError:
        pass
    with _probe_lock:
        _probe_ports.discard(ti.get("port"))


def real_ping(node_id: str, timeout: float = 8.0) -> dict:
    """单节点「真延迟」：为该节点起一个临时独立内核实例，
    经它请求 204 探测地址——真的能出网（账号可用、没被墙）才返回毫秒延迟；
    出不去一律判「不可用」。不触碰正在运行的主实例（不切换当前节点）。
    返回 {"ok": True, "ms": int} 或 {"ok": False, "error": 中文原因}。"""
    node = v2raydb.get_node(node_id)
    if not node:
        return {"ok": False, "error": "节点不存在"}
    ti = _temp_instance(node)
    if ti.get("error"):
        return {"ok": False, "error": ti["error"]}
    try:
        opener = proxyutil.build_opener(proxy="socks5://127.0.0.1:%d" % ti["port"])
        req = urllib.request.Request("http://www.gstatic.com/generate_204",
                                     headers={"User-Agent": "FileFlask-V2Ray/1.0"})
        t0 = time.time()
        with opener.open(req, timeout=timeout) as resp:
            resp.read(64)
        return {"ok": True, "ms": int((time.time() - t0) * 1000)}
    except urllib.error.HTTPError as e:
        return {"ok": False, "error": proxyutil.http_status_text(e.code)}
    except Exception as e:              # noqa: BLE001
        return {"ok": False, "error": proxyutil.friendly_error(e, "http://www.gstatic.com/generate_204")}
    finally:
        _temp_cleanup(ti)


def real_dl(node_id: str, urls, timeout: float = 25.0) -> dict:
    """单节点「真下载测速」：临时独立内核实例 + curl 经该节点拉测速文件，返回 Mbps。
    与 real_ping 一样不影响主实例（不切换当前节点）。urls 依次回退。"""
    node = v2raydb.get_node(node_id)
    if not node:
        return {"ok": False, "error": "节点不存在"}
    ti = _temp_instance(node)
    if ti.get("error"):
        return {"ok": False, "error": ti["error"]}
    errs = []
    try:
        for url in urls:
            tag = url.split("//", 1)[1].split("/", 1)[0]
            try:
                p = subprocess.run(
                    ["curl", "-x", "socks5h://127.0.0.1:%d" % ti["port"], "-sS", "-L",
                     "-o", "/dev/null", "-w", "%{speed_download} %{http_code}",
                     "--max-time", str(int(timeout)), url],
                    capture_output=True, text=True, timeout=timeout + 5)
            except FileNotFoundError:
                return {"ok": False, "error": "系统缺少 curl，无法下载测速"}
            except subprocess.TimeoutExpired:
                errs.append(tag + "：超时")
                continue
            out = (p.stdout or "").strip().split()
            if p.returncode != 0 or not out:
                errs.append(tag + "：" + ((p.stderr or "").strip()[:120] or "curl 退出码 %s" % p.returncode))
                continue
            try:
                speed = float(out[0])
            except ValueError:
                errs.append(tag + "：无法解析测速结果")
                continue
            code = out[1] if len(out) > 1 else ""
            if not code.startswith("2"):
                errs.append(tag + "：HTTP " + code)
                continue
            return {"ok": True, "mbps": round(speed * 8 / 1e6, 2)}
        return {"ok": False, "error": "下载测速失败（所有测速源均不可用）：" + "；".join(errs[:3])}
    finally:
        _temp_cleanup(ti)


def inbound_clients() -> dict:
    """实时连接到代理入站端口（SOCKS5 / HTTP）的客户端列表。
    读系统 ss 的 TCP 连接表里「对端 = 本机入站端口」的已建立连接，按来源 IP 聚合。
    返回 {"ok": True, "items": [...], "total": 总连接数}；内核未运行时 items 为空。"""
    st = _settings()
    ports = {}
    if st.get("socks_port"):
        ports[int(st["socks_port"])] = "SOCKS5"
    if st.get("http_port"):
        ports[int(st["http_port"])] = "HTTP"
    if not ports:
        return {"ok": True, "items": [], "total": 0, "hint": "未启用入站端口"}
    try:
        p = subprocess.run(["ss", "-tnp"], capture_output=True, text=True, timeout=5)
    except FileNotFoundError:
        return {"ok": False, "error": "系统缺少 ss 命令，无法统计连接"}
    items = {}
    for line in (p.stdout or "").splitlines()[1:]:
        tk = line.split()
        # ESTAB  RecvQ SendQ Local Peer [users:(("xray",pid=...,fd=...))]
        if len(tk) < 5 or tk[0] != "ESTAB":
            continue
        try:
            lport = int(tk[3].rsplit(":", 1)[1])
        except (IndexError, ValueError):
            continue
        if lport not in ports:
            continue
        ip = tk[4].rpartition(":")[0].strip("[]")
        it = items.setdefault(ip, {"ip": ip, "conns": 0, "inbound": ports[lport],
                                   "lports": set(), "procs": set()})
        it["conns"] += 1
        it["lports"].add(str(lport))
        m = re.search(r'\(\("([^"]+)"', " ".join(tk[5:]))
        if m:
            it["procs"].add(m.group(1))
    out = [{"ip": it["ip"], "conns": it["conns"],
            "inbound": it["inbound"] + " :" + " :".join(sorted(it["lports"])),
            "procs": sorted(it["procs"])}
           for it in items.values()]
    out.sort(key=lambda x: -x["conns"])
    return {"ok": True, "items": out, "total": sum(i["conns"] for i in out)}


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
        core = pick_core(st)
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
                     "kind": v2raycfg.core_kind(core) if core else "",
                     "dir": _CORE_DIR},
            "mem": {"rss": _proc_mem(pid)},
            "today": v2raydb.traffic_today(),       # 今日累计流量（侧栏显示）
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


def _xray_counters(core: str, api_port: int) -> dict:
    """Xray / V2Ray：`api statsquery` 取 proxy 出站的上下行累计字节。"""
    try:
        p = subprocess.run([core, "api", "statsquery", "--server=127.0.0.1:%d" % api_port],
                           capture_output=True, text=True, timeout=5)
        if p.returncode != 0:
            return {}
        j = json.loads(p.stdout)
    except (OSError, subprocess.SubprocessError, ValueError):
        return {}
    out = {}
    for it in (j.get("stat") or []):
        name = str((it or {}).get("name") or "")
        if name.startswith("outbound>>>proxy>>>traffic>>>"):
            out[name.rsplit(">>>", 1)[-1]] = int(str(it.get("value") or 0) or 0)
    return out


# 访问本机 clash_api 用独立 opener：否则会被环境变量里的 http_proxy 绕去代理
_LOCAL_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def _singbox_counters(api_port: int) -> dict:
    """sing-box：clash_api 的 /connections 返回累计上下行字节。

    部分版本只回活动连接列表（没有 uploadTotal / downloadTotal），
    此时退化为累加当前活动连接的字节数（连接关闭前的最后一段会略少计）。
    """
    try:
        with _LOCAL_OPENER.open("http://127.0.0.1:%d/connections" % api_port, timeout=4) as resp:
            j = json.loads(resp.read(512 * 1024).decode("utf-8", "replace"))
    except Exception:                          # noqa: BLE001
        return {}
    if not isinstance(j, dict):
        return {}
    up, down = j.get("uploadTotal"), j.get("downloadTotal")
    if up is None or down is None:
        conns = [c for c in (j.get("connections") or []) if isinstance(c, dict)]
        up = sum(int(c.get("upload") or 0) for c in conns)
        down = sum(int(c.get("download") or 0) for c in conns)
    try:
        return {"uplink": int(up or 0), "downlink": int(down or 0)}
    except (TypeError, ValueError):
        return {}


def _stats_sample():
    """采样一次内核统计；内核未运行 / API 未开启时速度归零。"""
    try:
        st = status()
    except Exception:                          # noqa: BLE001
        return
    core = (st.get("core") or {}).get("path") or ""
    kind = (st.get("core") or {}).get("kind") or ""
    api_port = int((st.get("settings") or {}).get("api_port") or 0)
    node_id = (st.get("node") or {}).get("id") or ""
    counters = {}
    if st.get("running") and core and api_port:
        if kind == "sing-box":
            counters = _singbox_counters(api_port)
        else:
            counters = _xray_counters(core, api_port)
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
                # 增量计入当前节点 + 全局总行 + 今日行（一次事务）
                v2raydb.add_traffic_sample(node_id, du, dd)
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
    """实时网速 + 流量统计：{speed, total, nodes, api_ok, mem}。"""
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
            "nodes": nodes,
            "mem": _proc_mem(_kernel_pid())}        # 跟着 5 秒轮询一起刷新


def reset_traffic() -> dict:
    """清零全部流量统计（含总行），并把内存计数器基准清掉。"""
    v2raydb.reset_traffic()
    with _stat_lock:
        _stat["prev"] = {}
    return {"ok": True, "traffic": traffic()}


# ---------------------------------------------------------------------------
# 节点失效自动切换（后台看门狗，与网页开关无关，关掉浏览器也持续运行）
# ---------------------------------------------------------------------------
_FAILOVER_INTERVAL = 60        # 探测间隔（秒）
_failover_bad = 0              # 当前节点连续探测失败次数
_failover_thread = None


def _auto_failover_on() -> bool:
    """是否开启「节点失效自动切换」（落库在设置表 auto_failover，0/1）。"""
    try:
        return int(v2raydb.all_settings().get("auto_failover") or 0) == 1
    except Exception:                      # noqa: BLE001
        return False


def _node_reachable(host: str, port: int, timeout: float = 5) -> bool:
    """TCP 握手探一次：能连上即认为节点可达（与前端 / 路由的 ping 同口径）。"""
    if not host or not port:
        return False
    s = None
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(timeout)
        s.connect((host, int(port)))
        return True
    except Exception:                      # noqa: BLE001
        return False
    finally:
        if s is not None:
            try:
                s.close()
            except Exception:              # noqa: BLE001
                pass


def _failover_pick(cur_id: str) -> dict | None:
    """在当前节点之外挑一个最优候选：优先用测速数据里延迟最低的可用节点，
    没测速数据时退而取列表里第一个「实际连通」的节点；都连不上就返回第一个（仍会尝试，但至少换了）。"""
    nodes = [n for n in v2raydb.list_nodes() if n.get("id") != cur_id]
    if not nodes:
        return None
    metrics = {}
    try:
        metrics = json.loads(v2raydb.all_settings().get("node_metrics") or "{}")
    except Exception:                      # noqa: BLE001
        metrics = {}
    cands = []
    for n in nodes:
        m = metrics.get(n.get("id")) if isinstance(metrics, dict) else None
        p = m.get("ping") if isinstance(m, dict) else None
        cands.append((n, p if isinstance(p, int) and p >= 0 else None))
    # 有测速数据的排前面、按延迟升序；没测速数据的排后面
    cands.sort(key=lambda x: (x[1] is None, x[1] if x[1] is not None else 1e9))
    for n, _ in cands:
        if _node_reachable(n.get("server"), int(n.get("port") or 0), timeout=4):
            return n
    return cands[0][0] if cands else None


def _failover_loop():
    """看门狗主循环：每 60 秒探测当前节点，连续 2 次失败则自动切换。"""
    global _failover_bad
    while True:
        if not _auto_failover_on():
            time.sleep(3)
            continue
        try:
            st = status()
            if not st.get("running"):
                _failover_bad = 0
                time.sleep(_FAILOVER_INTERVAL)
                continue
            node = st.get("node") or {}
            cid = node.get("id") or ""
            if _node_reachable(node.get("server"), int(node.get("port") or 0), timeout=5):
                _failover_bad = 0
            else:
                _failover_bad += 1
                # 连续两次失败才切换，避免网络抖动误判
                if _failover_bad >= 2:
                    _failover_bad = 0
                    cand = _failover_pick(cid)
                    if cand:
                        r = start(cand.get("id"))
                        if r.get("error"):
                            _log.warning("节点失效自动切换失败：%s", r.get("error"))
                        else:
                            _log.warning("节点失效自动切换：%s → %s",
                                         node.get("name"), cand.get("name"))
                    else:
                        _log.warning("当前节点 %s 已失效，但没有其它节点可切换", node.get("name"))
        except Exception as e:             # noqa: BLE001
            _log.warning("节点失效自动切换异常：%s", e)
        time.sleep(_FAILOVER_INTERVAL)


def _ensure_failover_thread():
    """确保看门狗线程在跑（守护线程，进程退出即结束）。"""
    global _failover_thread
    if _failover_thread is None or not _failover_thread.is_alive():
        _failover_thread = threading.Thread(target=_failover_loop, daemon=True,
                                           name="v2ray-failover")
        _failover_thread.start()


def set_auto_failover(on: bool) -> dict:
    """开启 / 关闭「节点失效自动切换」；开启时立即拉起后台看门狗线程。"""
    v2raydb.set_setting("auto_failover", 1 if on else 0)
    if on:
        _ensure_failover_thread()
    return status()


# ---------------------------------------------------------------------------
# 订阅拉取
# ---------------------------------------------------------------------------

def _node_proxy_url() -> str:
    """当前已连接节点对应的本机 socks 代理地址（带认证开关生效的凭据）；未运行返回空。

    用 socks5h://：域名交给内核去解析。本机 DNS 经常解析不了被墙/被污染的订阅域名
    （socks5:// 是本机解析，遇到这种域名会直接「无法解析域名」而失败）。
    """
    st = status()
    if not st.get("running"):
        return ""
    s = _apply_auth(_settings())
    user, pwd = str(s.get("socks_user") or ""), str(s.get("socks_pass") or "")
    # 凭据要转义：密码里带 @ / : / 空格 时，不转义会把代理地址拼坏
    auth = ("%s:%s@" % (urllib.parse.quote(user, safe=""),
                        urllib.parse.quote(pwd, safe=""))) if user else ""
    port = int((st.get("inbound") or {}).get("socks_port") or 10808)
    return "socks5h://%s127.0.0.1:%d" % (auth, port)


def _proxy_remote_dns(proxy: str) -> str:
    """本机 socks5 代理 → socks5h：让代理解析域名。

    socks5:// 是「本机先解析再连 IP」，指向本机内核时没有任何好处，
    反而会被本机 DNS 拖死（订阅域名经常本地解析不了）。
    """
    p = str(proxy or "").strip()
    if not p:
        return ""
    try:
        u = urllib.parse.urlsplit(p if "://" in p else "http://" + p)
    except ValueError:
        return p
    if (u.scheme or "").lower() != "socks5":
        return p
    if (u.hostname or "").lower() not in ("127.0.0.1", "localhost", "::1", "0.0.0.0"):
        return p
    return "socks5h://" + p.split("://", 1)[1]


# HTML / JSON 跳转页里的真实地址：<meta http-equiv="refresh" content="0; url=...">、
# window.location.href = "..." / location.replace("...")、<a href="...">
_SUB_HTML_REDIRECT_RE = re.compile(
    r'(?:url=|window\.location(?:\.href)?\s*=\s*|location\.(?:href|replace)\s*[=(]\s*)'
    r'[\'"]?\s*(https?://[^\s\'"<>;]+)', re.I)
_SUB_HREF_RE = re.compile(r"""(?:href|src)\s*=\s*['"]([^'"]+)['"]""", re.I)
_SUB_URL_RE = re.compile(r"https?://[^\s'\"<>()\\]+", re.I)

# 拉订阅用的 UA：不少面板按 UA 决定返回「门户网页」「base64 订阅」还是 Clash 配置
_SUB_UAS = (
    "Mozilla/5.0 (compatible; FileFlask-V2Ray/1.0)",
    "v2rayN/6.31",
)

# 像订阅地址的特征（避免把 css / js / 统计脚本当成跳转目标）
_SUB_HINTS = (".txt", "/sub", "subscription", "token=", "/api/v1/client", "clash", "base64")


def _sub_looks_like_link(url: str) -> bool:
    low = str(url or "").lower()
    return low.startswith(("http://", "https://")) and any(k in low for k in _SUB_HINTS)


def _sub_candidates(text: str, base: str = "") -> list:
    """从跳转页 / 下载页里挑出可能的真实订阅地址（meta 刷新、JS 跳转、a[href]、裸链接）。"""
    html = str(text or "")[:16384]
    raw = [m.group(1) for m in _SUB_HTML_REDIRECT_RE.finditer(html)]
    raw += [m.group(1) for m in _SUB_HREF_RE.finditer(html)]
    raw += [m.group(0) for m in _SUB_URL_RE.finditer(html)]
    out = []
    for u in raw:
        u = str(u).strip().rstrip(".,;)]}'\"")
        if base and u:
            u = urllib.parse.urljoin(base, u)   # /sub.txt 这类相对地址按页面地址补全
        if u and u not in out and _sub_looks_like_link(u):
            out.append(u)
    return out[:5]


def _sub_content_hint(text: str) -> str:
    """内容是网页 / Clash 配置时，给一句能看懂的原因（带页面标题，便于判断是什么页）。"""
    raw = str(text or "")
    low = raw[:4096].lower()
    if "proxies:" in low and ("type: vmess" in low or "type: vless" in low or "type: ss" in low):
        return "（该地址返回的是 Clash 配置，本模块只支持 vmess/vless/trojan/ss 分享链接）"
    if "<html" in low or "<!doctype" in low or "<body" in low:
        m = re.search(r"<title[^>]*>\s*([^<]{1,60})\s*</title>", raw, re.I)
        title = re.sub(r"\s+", " ", m.group(1)).strip() if m else ""
        extra = ("，页面标题「%s」" % title) if title else ""
        return "（返回的是网页%s，可能需要登录、换 UA 或挂代理）" % extra
    return ""


def _sub_fetch_raw(url: str, proxy: str, ua: str = ""):
    """拉取一个订阅地址：手动跟随 3xx 重定向（支持相对地址与 http/https 互跳）。

    返回 (原始字节, 最终地址, 错误信息)；出错时字节为空。
    """
    cur = str(url or "").strip()
    headers = {"User-Agent": ua or _SUB_UAS[0], "Accept": "*/*"}
    for _ in range(8):
        if not cur.startswith(("http://", "https://")):
            return b"", cur, "订阅重定向到了不支持的地址：%s" % cur
        try:
            opener = proxyutil.build_opener(proxy=proxy, follow_redirects=False)
            req = urllib.request.Request(cur, headers=headers)
            with opener.open(req, timeout=30) as resp:
                code = resp.getcode()
                loc = (resp.headers.get("Location") or "").strip()
                if 300 <= code < 400 and loc:
                    cur = urllib.parse.urljoin(cur, loc)
                    continue
                return resp.read(4 * 1024 * 1024), cur, ""
        except urllib.error.HTTPError as e:
            # follow_redirects=False 时 3xx 以 HTTPError 抛出，Location 在其 headers 里
            loc = ""
            try:
                loc = (e.headers.get("Location") or "").strip()
            except Exception:                      # noqa: BLE001
                pass
            if e.code in (301, 302, 303, 307, 308) and loc:
                cur = urllib.parse.urljoin(cur, loc)
                continue
            return b"", cur, "订阅请求失败：%s" % proxyutil.http_status_text(e.code)
        except Exception as e:                  # noqa: BLE001
            return b"", cur, proxyutil.friendly_error(e, cur)
    return b"", cur, "订阅重定向次数过多（超过 8 次）"


def _sub_decode(raw: bytes) -> str:
    """订阅原始字节 → 文本：解 gzip（部分服务器强制压缩）、去 BOM。"""
    if raw[:2] == b"\x1f\x8b":
        try:
            raw = gzip.decompress(raw)
        except OSError:
            pass
    return raw.decode("utf-8", "replace").lstrip("\ufeff").strip()


def _sub_landing_links(text: str, proxy: str, origin: str, errs: list) -> list:
    """内容不是订阅时，从页面里找出真实地址逐个抓取（支持「跳转到 txt 下载页」这种站点）。"""
    for cand in _sub_candidates(text, origin):
        if cand == origin:
            continue
        raw, final, err = _sub_fetch_raw(cand, proxy)
        if err:
            errs.append("跳转地址 %s：%s" % (cand, err))
            continue
        links = v2raycfg.parse_subscription(_sub_decode(raw))
        if links:
            _log.info("订阅 %s 经跳转页抓到 %s（%d 条）", origin, final, len(links))
            return links
    return []


def fetch_subscription(sub: dict):
    """拉取订阅内容，返回 (分享链接列表, 错误信息)。

    通道顺序：设置里的代理（订阅自带的 proxy / 全局 sub_proxy）→ 当前节点的本机 socks → 直连。
    代理留空也能用：正在连接节点时优先走它，直连只在最后兜底（订阅站大多需要翻墙）。
    每个通道失败、或拿到网页解析不出节点，都会继续换下一个通道；
    同一通道拿到内容但没解析出节点时，再换一个 UA（v2rayN）重试——
    不少面板按 UA 决定返回「门户网页」还是「base64 订阅」。

    跳转处理：手动跟随 3xx（含相对地址 / http↔https 互跳）；
    返回的是网页时，从 meta 刷新 / JS location / a[href] 里找出 .txt 等真实订阅地址再抓。
    """
    url = str((sub or {}).get("url") or "").strip()
    if not url:
        return [], "订阅地址为空"

    configured = _proxy_remote_dns(str((sub or {}).get("proxy") or "").strip()
                                   or str(_settings().get("sub_proxy") or "").strip())
    channels = []
    if configured:
        channels.append(configured)
    node_px = _node_proxy_url()
    if node_px:
        channels.append(node_px)            # 当前连接节点的本机 socks（所以代理可以不填）
    channels.append("")                     # 直连兜底
    channels = [p for i, p in enumerate(channels) if p not in channels[:i]]

    errs = []
    for px in channels:
        label = ("代理 " + px) if px else "直连"
        last_text = ""
        for ua in _SUB_UAS:
            raw, final, err = _sub_fetch_raw(url, px, ua)
            if err:
                errs.append("%s：%s" % (label, err))
                _log.info("订阅 %s 走%s失败：%s", url, label, err)
                break                       # 网络层失败，换 UA 没用 → 换下一个通道
            if final != url:
                _log.info("订阅 %s 重定向到 %s（%s）", url, final, label)
            last_text = _sub_decode(raw)
            links = v2raycfg.parse_subscription(last_text)
            if not links:
                links = _sub_landing_links(last_text, px, final or url, errs)
            if links:
                if label != "直连":
                    _log.info("订阅 %s 经%s拉取成功（%d 条）", url, label, len(links))
                return links, ""
        if last_text:
            errs.append("%s：返回内容里没有节点%s" % (label, _sub_content_hint(last_text)))
    return [], "；".join(errs[-4:]) or "订阅拉取失败"


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


def _manual_paths(st: dict) -> list:
    """两种内核各自手动指定的路径（都参与探测，避免换了类型就找不到自定义位置的内核）。"""
    out = []
    for key in ("core_path", "core_path_singbox"):
        p = str(st.get(key) or "").strip()
        if p:
            out.append(p)
    return out


def _detect_extra(st: dict) -> list:
    """探测范围：应用自带安装目录 + 两种内核的手动路径 + 多版本安装目录。

    多版本目录（data/v2ray/versions/xxx/）必须带上，否则「按版本安装」的内核
    探测不到，界面会一直提示「本机还没有该内核」。
    """
    extra = [_CORE_DIR] + _manual_paths(st)
    try:
        for name in sorted(os.listdir(_VERSIONS_DIR), reverse=True):
            p = os.path.join(_VERSIONS_DIR, name)
            if os.path.isdir(p):
                extra.append(p)
    except OSError:
        pass
    return extra


def core_info() -> dict:
    """内核探测信息：已找到的候选 + 当前选用 + 当前内核类型。"""
    st = _settings()
    extra = _detect_extra(st)
    cores = v2raycfg.detect_cores(extra=extra)
    cur = pick_core(st)
    plat, arch = v2raycfg.platform_arch()
    return {"found": cores, "current": cur,
            "version": v2raycfg.core_version(cur) if cur else "",
            "kind": v2raycfg.core_kind(cur) if cur else "",
            "prefer": str(st.get("core_kind") or "xray"),
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


def _run_detect(jid: str, kind: str = ""):
    """后台探测。kind 为空 = 全部类型，否则只探测该类型（前端按当前 Tab 传入）。"""
    only = "sing-box" if str(kind or "") == "sing-box" else ("xray" if kind else "")
    label = "sing-box" if only == "sing-box" else "xray / v2ray"
    seen = []
    try:
        def progress(i, total, path):
            _job_patch(jid, phase="正在探测内核", pct=int(i * 100 / total) if total else 0)
            if path and path not in seen:
                seen.append(path)
                _job_log(jid, "检测 " + path)

        # 探测范围 = 系统目录 + 应用自带安装目录 data/v2ray/core + 用户手动指定的内核路径，
        # 否则「一键下载装到 data/v2ray/core」的内核会被误报成「本机没有可用内核」
        st_now = _settings()
        extra = _detect_extra(st_now)
        cores = v2raycfg.detect_cores(progress=progress, extra=extra, only=only)
        for c in cores:
            _job_log(jid, "可用：%s · %s" % (c["version"], c["path"]))
        if not cores:
            _job_log(jid, "未发现可用的 %s 内核，可点下方按钮下载" % label)
        _job_patch(jid, phase="探测完成", pct=100, done=True, ok=True,
                   result={"found": cores, "kind": only})
    except Exception as e:                     # noqa: BLE001
        _job_patch(jid, phase="探测失败", done=True, ok=False, error=str(e))


def _run_download(jid: str, url: str, dest: str = "", auto_use: bool = True,
                  kind: str = "xray"):
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

    # 直连 GitHub 经常不通：先登记兜底代理（订阅代理 / 本机节点代理），下载失败会自动改走它们
    v2raycfg.set_fallback_proxies(_fallback_proxies())
    try:
        _job_log(jid, "开始下载 %s 内核（%s/%s）" % (kind, *v2raycfg.platform_arch()))
        _job_log(jid, "已配置/运行中的代理可达时优先走代理；否则直连 GitHub 并自动切换加速镜像")

        def on_log(line):
            _job_log(jid, line)

        exe = v2raycfg.download_core(dest or _CORE_DIR, url=url, progress=progress,
                                     on_phase=phase, on_log=on_log, kind=kind)
    except ValueError as e:
        _job_patch(jid, phase="下载失败", done=True, ok=False, error=str(e))
        return
    ver = v2raycfg.core_version(exe)
    if auto_use:
        # 路径按类型分开存：xray 写 core_path，sing-box 写 core_path_singbox
        v2raydb.set_settings({core_path_key(kind): exe, "core_kind": kind})
    _log.info("已下载 %s 内核：%s (%s)", kind, exe, ver)
    _job_log(jid, "安装完成：%s %s" % (ver, exe))
    _job_patch(jid, phase="安装完成", pct=100, done=True, ok=True,
               result={"path": exe, "version": ver, "auto_use": auto_use})


def core_detect_job(kind: str = "") -> str:
    """后台执行内核探测（进度通过 job_* 查询 / SSE 推送）。

    kind 为空 = 全部类型；传 xray / sing-box 时只探测该类型。
    """
    jid = job_new("detect")
    threading.Thread(target=_run_detect, args=(jid, str(kind or "")), daemon=True).start()
    return jid


def core_download_job(url: str = "", kind: str = "xray") -> str:
    """后台下载内核到 data/v2ray/core，成功后自动登记路径与类型。"""
    kind = "sing-box" if str(kind or "") == "sing-box" else "xray"
    jid = job_new("download")
    threading.Thread(target=_run_download, args=(jid, str(url or "")),
                     kwargs={"kind": kind}, daemon=True).start()
    return jid


# ---------------------------------------------------------------------------
# 多版本管理：按版本安装 / 已安装列表 / 一键切换
# ---------------------------------------------------------------------------

def _dir_exe(d: str, kind: str = "") -> str:
    """在版本目录里找内核可执行文件（兼容解压出子目录的情况）。"""
    names = ("sing-box", "sing-box.exe") if kind == "sing-box" else _EXE_NAMES
    for name in names:
        exe = os.path.join(d, name)
        if os.path.isfile(exe):
            return exe
    for root, _ds, files in os.walk(d):
        for f in files:
            if f in names:
                return os.path.join(root, f)
    return ""


def _ver_dir(ver: str, kind: str = "xray") -> str:
    """多版本安装目录：xray → versions/v1.2.3；sing-box → versions/sing-box-v1.2.3。"""
    return os.path.join(_VERSIONS_DIR, ("sing-box-v" if kind == "sing-box" else "v") + ver)


def _safe_ver(version: str) -> str:
    """版本号清洗（只留 0-9a-z.-，去掉首位的 v），非法则抛 ValueError。"""
    ver = str(version or "").strip().lstrip("vV")
    if not re.fullmatch(r"[0-9][0-9A-Za-z.\-]*", ver):
        raise ValueError("无效的版本号：%s" % version)
    return ver


def installed_versions(kind: str = "") -> list:
    """扫描 data/v2ray/versions 下的多版本安装，返回 [{dir, version, path, ok, kind}]，新版本在前。"""
    out = []
    try:
        names = sorted(os.listdir(_VERSIONS_DIR), reverse=True)
    except OSError:
        names = []
    for d in names:
        full = os.path.join(_VERSIONS_DIR, d)
        exe = _dir_exe(full)
        if not exe:
            continue
        k = v2raycfg.core_kind(exe)
        if kind and k != kind:
            continue
        ver = v2raycfg.core_version(exe)
        out.append({"dir": d, "version": ver or "", "path": exe, "ok": bool(ver), "kind": k})
    return out


def core_versions_info(kind: str = "xray") -> dict:
    """多版本信息：指定类型内核的已安装版本 + 该类内核「使用中」的版本 / 路径。

    面板是按内核类型分开的，所以不能把另一种内核的版本号 / 路径混进来
    （之前切到 sing-box Tab 时「当前使用」还显示 xray 的版本）。
    """
    st = _settings()
    cur = pick_core(st)
    cur_kind = v2raycfg.core_kind(cur) if cur else ""
    same = bool(cur) and cur_kind == kind
    return {"kind": kind, "installed": installed_versions(kind),
            "current": cur if same else "",
            "current_version": v2raycfg.core_version(cur) if same else "",
            "current_kind": cur_kind}


def _fallback_proxies() -> list:
    """直连 / 镜像都失败时可用于重试的代理：订阅拉取代理 + 当前节点的本机 socks。

    与「拉订阅」同一套思路：先试设置里的代理，再试正在运行的内核出口。
    """
    out = []
    try:
        p = str(_settings().get("sub_proxy") or "").strip()
    except Exception:                          # noqa: BLE001
        p = ""
    if p:
        out.append(_proxy_remote_dns(p))
    try:
        node = _node_proxy_url()               # 内核没在跑时返回空串
    except Exception:                          # noqa: BLE001
        node = ""
    if node and node not in out:
        out.append(node)
    return out


def core_remote_versions(kind: str = "xray", limit: int = 30) -> list:
    """拉官方版本列表（直连 / 镜像失败时自动改走订阅代理、本机节点代理重试）。"""
    v2raycfg.set_fallback_proxies(_fallback_proxies())
    return v2raycfg.list_versions(limit, kind)


def core_install_version_job(version: str, kind: str = "xray") -> str:
    """后台下载安装指定版本的内核到 data/v2ray/versions/（不自动切换）。"""
    kind = "sing-box" if str(kind or "") == "sing-box" else "xray"
    ver = _safe_ver(version)
    url = v2raycfg.release_url(ver, kind)    # 顺带校验版本号
    jid = job_new("download")
    threading.Thread(target=_run_download, args=(jid, url),
                     kwargs={"dest": _ver_dir(ver, kind), "auto_use": False,
                             "kind": kind}, daemon=True).start()
    return jid


def core_use_version(version: str, kind: str = "xray") -> dict:
    """把当前使用的内核切换到已安装的指定版本；内核在跑就自动重启加载。"""
    kind = "sing-box" if str(kind or "") == "sing-box" else "xray"
    ver = _safe_ver(version)
    exe = _dir_exe(_ver_dir(ver, kind), kind)
    if not exe:
        return {"error": "版本 %s %s 尚未安装，请先下载安装" % (kind, ver)}
    real_ver = v2raycfg.core_version(exe)
    if not real_ver:
        return {"error": "该版本内核不可用（无法执行 version 命令）"}
    v2raydb.set_settings({core_path_key(kind): exe, "core_kind": kind})
    _log.info("内核已切换到 %s %s (%s)", kind, real_ver, exe)
    running = status().get("running")
    if running:
        r = restart()                          # 沿用当前节点重启，加载新内核
        if r.get("error"):
            return {"ok": True, "version": real_ver, "path": exe,
                    "restarted": False, "error": r["error"]}
    return {"ok": True, "version": real_ver, "path": exe, "restarted": running}

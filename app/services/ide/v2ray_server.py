"""本地 V2Ray 服务端节点：把本机变成一个可供其他设备连接的 v2 代理。

与 v2raymgr（本机 10808 出站客户端）完全隔离：独立配置文件 / 状态文件 /
日志 / 子进程，互不覆盖、互不误杀。支持两种出站：

    proxy  流量经本机 10808 客户端再出海（本机已连节点时选这个）
    direct 流量由本机直连外网（本机自身能访问外网时选这个）

其他设备扫描二维码或导入分享链接后，流量路径：
    设备 → 本机:server_port（vmess/vless 入站）→ 本机出站 → 外网
"""
from __future__ import annotations

import base64
import json
import os
import subprocess
import threading
import time
import urllib.parse
import uuid

from ... import config
from ...log import get_logger
from ..common import secret
from . import v2raycfg, v2raydb, v2raymgr

_log = get_logger()

_DIR = os.path.join(config.DATA_ROOT, "v2ray")
_CONFIG_FILE = os.path.join(_DIR, "server-config.json")
_STATE_FILE = os.path.join(_DIR, "server-state.json")
_LOG_FILE = os.path.join(_DIR, "server.log")

_LOCK = threading.RLock()

_DEFAULTS = {
    "server_port": 10810,
    "server_uuid": "",
    "server_proto": "vless",   # Xray 新版已弃用 VMess，优先 VLESS
    "server_name": "本地节点",
    "server_outbound": "proxy",
    "server_security": "reality",   # none / reality（本机做 REALITY 服务端）
    "server_sni": "www.overleaf.com",   # REALITY 伪装域名（serverNames）
    "server_dest": "www.overleaf.com:443",  # REALITY 回源伪装目标
    "server_shortid": "",              # REALITY shortId
    "server_privatekey": "",           # REALITY 服务端私钥（xray x25519 生成）
    "server_fp": "chrome",             # 给客户端填的 TLS 指纹
    "server_flow": "xtls-rprx-vision", # VLESS REALITY 客户端 flow
}

# 本地节点流量统计 / 配额限制
_API_PORT_BASE = 16400          # 每个本地节点的统计 API 端口从此基准往上找空闲端口
_STAT_INTERVAL = 3.0            # 采样间隔（秒）
_STAT_TAG = "local-server-in"   # 统计所依据的入站 tag（与 build_config 一致）
_QUOTA_ACTIONS = ("stop", "notify")   # 配额超限动作：停止节点 / 仅提示
_QUOTA_DEFAULT_ACTION = "stop"


def _int(v, default=0):
    try:
        return int(str(v).strip())
    except (TypeError, ValueError):
        return default


def _shared_core() -> bool:
    """是否共用主代理内核（并入主配置同一进程）。默认开启。"""
    try:
        raw = v2raydb.all_settings().get("shared_core")
        return raw is None or int(raw or 0) == 1
    except Exception:                          # noqa: BLE001
        return True


def _ensure_dir():
    os.makedirs(_DIR, exist_ok=True)


# ---------------------------------------------------------------------------
# REALITY 密钥对（用 Xray 自带 x25519 生成，无需额外依赖）
# ---------------------------------------------------------------------------

def gen_reality_keys() -> dict:
    """生成 REALITY 服务端密钥对：privateKey 自己留着，publicKey 写进分享链接给客户端。"""
    core = pick_xray_core()
    if not core:
        return {"error": "没有找到可用的 Xray 内核，无法生成 REALITY 密钥"}
    try:
        p = subprocess.run([core, "x25519"], capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError) as e:
        return {"error": "生成密钥失败：%s" % e}
    out = (p.stdout or "") + (p.stderr or "")
    priv = pub = ""
    for line in out.splitlines():
        line = line.strip()
        if line.lower().startswith("privatekey:"):
            priv = line.split(":", 1)[1].strip()
        elif line.lower().startswith("password (publickey):"):
            pub = line.split(":", 1)[1].strip()
    if not priv or not pub:
        return {"error": "解析 Xray 密钥输出失败：%s" % out[-300:]}
    return {"ok": True, "privateKey": priv, "publicKey": pub}


# ---------------------------------------------------------------------------
# 配置（存在 v2ray_cfg 设置表里，和模块其它设置一起持久化）
# ---------------------------------------------------------------------------

def get_config() -> dict:
    st = v2raydb.all_settings()
    proto = str(st.get("server_proto") or _DEFAULTS["server_proto"]).lower()
    if proto not in ("vmess", "vless"):
        proto = _DEFAULTS["server_proto"]
    outbound = str(st.get("server_outbound") or _DEFAULTS["server_outbound"]).lower()
    if outbound not in ("proxy", "direct"):
        outbound = _DEFAULTS["server_outbound"]
    port = _int(st.get("server_port"), 0) or _DEFAULTS["server_port"]
    name = str(st.get("server_name") or _DEFAULTS["server_name"]).strip()[:60] or _DEFAULTS["server_name"]
    uid = str(st.get("server_uuid") or "").strip()
    if not uid:
        uid = str(uuid.uuid4())
        v2raydb.set_setting("server_uuid", uid)
    security = str(st.get("server_security") or _DEFAULTS["server_security"]).lower()
    if security not in ("none", "reality"):
        security = _DEFAULTS["server_security"]
    return {
        "port": port, "proto": proto, "uuid": uid,
        "name": name, "outbound": outbound, "security": security,
        "sni": str(st.get("server_sni") or _DEFAULTS["server_sni"]).strip(),
        "dest": str(st.get("server_dest") or _DEFAULTS["server_dest"]).strip(),
        "shortid": str(st.get("server_shortid") or "").strip(),
        "privatekey": str(st.get("server_privatekey") or "").strip(),
        "fp": str(st.get("server_fp") or _DEFAULTS["server_fp"]).strip() or "chrome",
        "flow": str(st.get("server_flow") or _DEFAULTS["server_flow"]).strip(),
    }


def save_config(data: dict) -> dict:
    items = {}
    if "port" in data:
        p = _int(data.get("port"))
        if not (1 <= p <= 65535):
            return {"error": "监听端口需在 1-65535 之间"}
        items["server_port"] = p
    if "proto" in data:
        proto = str(data.get("proto") or "").lower()
        if proto not in ("vmess", "vless"):
            return {"error": "协议只能是 vmess 或 vless"}
        items["server_proto"] = proto
    if "outbound" in data:
        ob = str(data.get("outbound") or "").lower()
        if ob not in ("proxy", "direct"):
            return {"error": "出站方式只能是 proxy 或 direct"}
        items["server_outbound"] = ob
    if "name" in data:
        items["server_name"] = str(data.get("name") or "").strip()[:60] or "本地节点"
    if "uuid" in data:
        uid = str(data.get("uuid") or "").strip()
        try:
            uuid.UUID(uid)
        except (ValueError, AttributeError, TypeError):
            return {"error": "UUID 格式不正确"}
        items["server_uuid"] = uid
    if "security" in data:
        sec = str(data.get("security") or "").lower()
        if sec not in ("none", "reality"):
            return {"error": "安全类型只能是 none 或 reality"}
        items["server_security"] = sec
    for key, field in (("sni", "server_sni"), ("dest", "server_dest"),
                       ("shortid", "server_shortid"), ("privatekey", "server_privatekey"),
                       ("fp", "server_fp"), ("flow", "server_flow")):
        if key in data:
            items[field] = str(data.get(key) or "").strip()
    # 选了 REALITY 但还没有私钥时自动生成一对（无需用户手工填写 base64 密钥）
    if items.get("server_security", "") == "reality" or (
            "security" not in data and v2raydb.all_settings().get("server_security") == "reality"):
        if not (items.get("server_privatekey") or v2raydb.all_settings().get("server_privatekey")):
            keys = gen_reality_keys()
            if keys.get("error"):
                return {"error": keys["error"]}
            items["server_privatekey"] = keys["privateKey"]
    if items:
        v2raydb.set_settings(items)
    return {"ok": True, "config": get_config(), "status": status()}


def new_uuid() -> dict:
    uid = str(uuid.uuid4())
    v2raydb.set_setting("server_uuid", uid)
    cfg = get_config()
    return {"ok": True, "uuid": uid,
            "share_url": share_link(cfg), "status": status()}


# ---------------------------------------------------------------------------
# 配置生成
# ---------------------------------------------------------------------------

def _main_socks_server() -> dict:
    """链式出站用的本机 10808 SOCKS 地址（主代理开了认证就带上账号密码）。"""
    st = v2raydb.all_settings()
    srv = {"address": "127.0.0.1", "port": _int(st.get("socks_port"), 0) or 10808}
    user = str(st.get("socks_user") or "").strip()
    auth_on = bool(st.get("auth_enabled")) or str(st.get("socks_listen") or "") == "0.0.0.0"
    if auth_on and user:
        srv["user"] = user
        srv["pass"] = secret.decrypt(st.get("socks_pass"))
    return srv


def public_from_private(private_key: str) -> str:
    """由 REALITY 私钥派生公钥（Xray x25519 -i），用于分享链接的 pbk 字段。"""
    if not private_key:
        return ""
    core = pick_xray_core()
    if not core:
        return ""
    try:
        p = subprocess.run([core, "x25519", "-i", private_key],
                           capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return ""
    out = (p.stdout or "") + (p.stderr or "")
    for line in out.splitlines():
        line = line.strip()
        if line.lower().startswith("password (publickey):"):
            return line.split(":", 1)[1].strip()
    return ""


def build_config(cfg: dict) -> dict:
    """生成 Xray 服务端配置：一个 v2 入站 + 一个出站（链式代理或直连）。

    当 cfg['api_port'] 非 0 时额外注入统计 API（独立端口），用 inbound 标签
    'local-server-in' 统计该节点转发的上下行流量，供流量统计 / 配额限制使用。
    """
    proto = cfg["proto"]
    security = cfg.get("security", "none")
    if proto == "vmess":
        clients = [{"id": cfg["uuid"], "alterId": 0}]
    else:
        clients = [{"id": cfg["uuid"]}]
    inbound = {
        "tag": "local-server-in",
        "listen": "0.0.0.0",
        "port": cfg["port"],
        "protocol": proto,
        "settings": {"clients": clients},
        "streamSettings": {"network": "tcp"},
    }
    if proto == "vless":
        inbound["settings"]["decryption"] = "none"
    # VLESS + REALITY：客户端 flow 必须写进入站 users，streamSettings 配私钥 / 伪装域名 / dest
    if proto == "vless" and security == "reality":
        inbound["settings"]["clients"][0]["flow"] = cfg.get("flow") or "xtls-rprx-vision"
        inbound["streamSettings"]["security"] = "reality"
        inbound["streamSettings"]["realitySettings"] = {
            "show": False,
            "dest": cfg.get("dest") or "www.overleaf.com:443",
            "xver": 0,
            "serverNames": [s for s in [cfg.get("sni") or "www.overleaf.com"] if s],
            "privateKey": cfg.get("privatekey") or "",
            "shortIds": [cfg.get("shortid") or ""],
        }

    outbounds = []
    if cfg["outbound"] == "proxy":
        outbounds.append({
            "tag": "chain-out",
            "protocol": "socks",
            "settings": {"servers": [_main_socks_server()]},
        })
    outbounds.append({"tag": "direct", "protocol": "freedom"})

    conf = {
        "log": {"loglevel": "warning", "access": "", "error": ""},
        "inbounds": [inbound],
        "outbounds": outbounds,
    }
    rules = []
    if cfg["outbound"] == "proxy":
        rules.append({"type": "field", "network": "tcp,udp", "outboundTag": "chain-out"})

    # 统计 API：每个本地节点用独立端口（api_port），只监听 127.0.0.1。
    # 打开入站方向的流量统计后，statsquery 可取到
    # inbound>>>local-server-in>>>traffic>>>uplink / downlink。
    api_port = _int(cfg.get("api_port") or 0)
    if api_port:
        conf["stats"] = {}
        conf["policy"] = {"system": {"statsInboundUplink": True,
                                     "statsInboundDownlink": True}}
        conf["api"] = {"tag": "api", "services": ["StatsService"]}
        conf["inbounds"].append({
            "tag": "api-in", "listen": "127.0.0.1", "port": api_port,
            "protocol": "dokodemo-door", "settings": {"address": "127.0.0.1"},
        })
        rules.insert(0, {"type": "field", "inboundTag": ["api-in"], "outboundTag": "api"})
    if rules:
        conf["routing"] = {"domainStrategy": "AsIs", "rules": rules}
    return conf


def preview_config() -> dict:
    return {"ok": True, "config": build_config(get_config())}


def share_link(cfg: dict, host: str = "") -> str:
    """生成 vmess:// / vless:// 分享链接，host 默认取本机局域网 IP。"""
    ip = str(host or "").strip() or v2raycfg.lan_ip() or "127.0.0.1"
    port, name, uid = cfg["port"], cfg["name"], cfg["uuid"]
    if cfg["proto"] == "vmess":
        j = {"v": "2", "ps": name, "add": ip, "port": str(port), "id": uid,
             "aid": "0", "scy": "auto", "net": "tcp", "type": "none",
             "host": "", "path": "", "tls": "none"}
        raw = json.dumps(j, ensure_ascii=False).encode("utf-8")
        return "vmess://" + base64.b64encode(raw).decode("ascii")
    if cfg.get("security") == "reality":
        pbk = public_from_private(cfg.get("privatekey") or "")
        q = {
            "encryption": "none", "security": "reality", "type": "tcp",
            "flow": cfg.get("flow") or "xtls-rprx-vision",
            "sni": cfg.get("sni") or "www.overleaf.com",
            "fp": cfg.get("fp") or "chrome",
            "pbk": pbk,
        }
        if cfg.get("shortid"):
            q["sid"] = cfg["shortid"]
        return "vless://%s@%s:%s?%s#%s" % (uid, ip, port, urllib.parse.urlencode(q),
                                            urllib.parse.quote(name, safe=""))
    q = urllib.parse.urlencode({"encryption": "none", "security": "none", "type": "tcp"})
    return "vless://%s@%s:%s?%s#%s" % (uid, ip, port, q, urllib.parse.quote(name, safe=""))


# ---------------------------------------------------------------------------
# 进程 / 状态
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
        _log.warning("写入本地服务端状态失败: %s", e)


def _running_pid() -> int:
    pid = _int(_read_state().get("pid"))
    return pid if pid and v2raymgr._pid_alive(pid) else 0


def _port_free(port: int) -> bool:
    return v2raymgr._port_free(port)


def pick_xray_core() -> str:
    """本地服务端只用 Xray 内核（sing-box 的服务端配置格式不同）。"""
    st = dict(v2raydb.all_settings())
    st["core_kind"] = "xray"
    core = v2raymgr.pick_core(st)
    if core and v2raycfg.core_kind(core) == "sing-box":
        return ""
    return core


def log_tail(lines: int = 60) -> str:
    try:
        with open(_LOG_FILE, "r", encoding="utf-8", errors="replace") as f:
            return "".join(f.readlines()[-max(1, min(int(lines or 60), 500)):])
    except OSError:
        return ""


def clear_log():
    try:
        open(_LOG_FILE, "w", encoding="utf-8").close()
    except OSError:
        pass


def status() -> dict:
    cfg = get_config()
    st = _read_state()
    pid = _running_pid()
    main = v2raydb.all_settings()
    conflicts = []
    for key, label in (("socks_port", "SOCKS5"), ("http_port", "HTTP"), ("api_port", "统计 API")):
        if _int(main.get(key)) and _int(main.get(key)) == cfg["port"]:
            conflicts.append(label)
    return {
        "running": bool(pid),
        "pid": pid,
        "started_at": float(st.get("started_at") or 0),
        "core": str(st.get("core") or ""),
        "port": cfg["port"],
        "proto": cfg["proto"],
        "uuid": cfg["uuid"],
        "name": cfg["name"],
        "outbound": cfg["outbound"],
        "security": cfg["security"],
        "sni": cfg["sni"],
        "dest": cfg["dest"],
        "shortid": cfg["shortid"],
        "privatekey": cfg["privatekey"],
        "publickey": public_from_private(cfg["privatekey"]) if cfg["security"] == "reality" else "",
        "fp": cfg["fp"],
        "flow": cfg["flow"],
        "reality_ready": bool(cfg["privatekey"]) and bool(public_from_private(cfg["privatekey"])),
        "lan_ip": v2raycfg.lan_ip(),
        "share_url": share_link(cfg),
        "port_free": _port_free(cfg["port"]),
        "port_conflicts": conflicts,
        "core_ready": bool(pick_xray_core()),
    }


def start() -> dict:
    with _LOCK:
        cfg = get_config()
        port = cfg["port"]
        if not (1 <= port <= 65535):
            return {"error": "监听端口需在 1-65535 之间"}
        st = status()
        if st["port_conflicts"]:
            return {"error": "端口 %s 与主代理的 %s 端口冲突，请更换" %
                    (port, " / ".join(st["port_conflicts"]))}
        if st["running"]:
            return st
        if not _port_free(port):
            return {"error": "端口 %s 已被其它程序占用，请更换端口" % port}
        core = pick_xray_core()
        if not core:
            return {"error": "没有找到可用的 Xray 内核，本地服务端需要 Xray（请到「设置」安装）"}
        if cfg["proto"] == "vless" and cfg["security"] == "reality":
            if not cfg["privatekey"] or not public_from_private(cfg["privatekey"]):
                return {"error": "REALITY 私钥无效或缺失，请在配置里点「生成密钥对」"}
        conf = build_config(cfg)
        _ensure_dir()
        tmp = _CONFIG_FILE + ".tmp"
        try:
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(conf, f, ensure_ascii=False, indent=2)
            os.replace(tmp, _CONFIG_FILE)
        except OSError as e:
            return {"error": "写入服务端配置失败：%s" % e}
        err = v2raymgr._validate_config(core, _CONFIG_FILE)
        if err:
            return {"error": err}
        try:
            logf = open(_LOG_FILE, "a", encoding="utf-8")
        except OSError as e:
            return {"error": "无法写入服务端日志：%s" % e}
        try:
            proc = subprocess.Popen([core, "run", "-c", _CONFIG_FILE], cwd=_DIR,
                                    stdin=subprocess.DEVNULL, stdout=logf, stderr=logf,
                                    start_new_session=True)
        except OSError as e:
            logf.close()
            return {"error": "启动服务端失败：%s" % e}
        finally:
            logf.close()
        time.sleep(0.9)
        if proc.poll() is not None:
            return {"error": "服务端启动后立即退出（退出码 %s）：\n%s" %
                    (proc.returncode, log_tail(30)[-1000:])}
        _write_state({"pid": proc.pid, "started_at": time.time(),
                      "port": port, "core": core})
        _log.info("本地 V2Ray 服务端已启动 pid=%s 端口=%s 协议=%s", proc.pid, port, cfg["proto"])
        return status()


def stop() -> dict:
    with _LOCK:
        pid = _running_pid()
        if pid:
            v2raymgr._kill(pid)
        try:
            os.remove(_STATE_FILE)
        except OSError:
            pass
        _log.info("本地 V2Ray 服务端已停止")
        return {"ok": True, "status": status()}


# ===========================================================================
# 多节点管理：每个本地服务端节点独立配置 / 状态 / 日志 / 进程
# ===========================================================================

def _node_paths(sid: str):
    safe = str(sid).replace("/", "_").replace("\\", "_")[:40]
    return (os.path.join(_DIR, "srv-%s.json" % safe),
            os.path.join(_DIR, "srv-%s.state.json" % safe),
            os.path.join(_DIR, "srv-%s.log" % safe))


def _node_read_state(sid: str) -> dict:
    _, sf, _ = _node_paths(sid)
    try:
        with open(sf, "r", encoding="utf-8") as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def _node_write_state(sid: str, d: dict):
    _, sf, _ = _node_paths(sid)
    _ensure_dir()
    try:
        tmp = sf + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(d, f, ensure_ascii=False, indent=2)
        os.replace(tmp, sf)
    except OSError as e:
        _log.warning("写入本地节点 %s 状态失败: %s", sid, e)


def _node_pid(sid: str) -> int:
    pid = _int(_node_read_state(sid).get("pid"))
    return pid if pid and v2raymgr._pid_alive(pid) else 0


def node_log_tail(sid: str, lines: int = 60) -> str:
    if _shared_core():
        # 共用内核：节点没有独立进程 / 日志，读主内核日志
        return v2raymgr.log_tail(lines)
    _, _, lf = _node_paths(sid)
    try:
        with open(lf, "r", encoding="utf-8", errors="replace") as f:
            return "".join(f.readlines()[-max(1, min(int(lines or 60), 500)):])
    except OSError:
        return ""


def node_clear_log(sid: str):
    if _shared_core():
        v2raymgr.clear_log()
        return
    _, _, lf = _node_paths(sid)
    try:
        open(lf, "w", encoding="utf-8").close()
    except OSError:
        pass


def _row_to_cfg(r: dict) -> dict:
    """DB 行 → 运行配置 dict（补齐默认值）。"""
    c = dict(r.get("cfg") or {})
    return {
        "id": r["id"], "name": r.get("name") or "本地节点",
        "proto": r.get("proto") or "vless", "port": int(r.get("port") or 0),
        "uuid": c.get("uuid") or "", "outbound": c.get("outbound") or "proxy",
        "security": c.get("security") or "reality",
        "sni": c.get("sni") or _DEFAULTS["server_sni"],
        "dest": c.get("dest") or _DEFAULTS["server_dest"],
        "shortid": str(c.get("shortid") or ""),
        "privatekey": str(c.get("privatekey") or ""),
        "fp": c.get("fp") or "chrome",
        "flow": c.get("flow") or "xtls-rprx-vision",
        "api_port": _int(c.get("api_port") or 0),
        "quota_gb": c.get("quota_gb", 0),
        "quota_action": str(c.get("quota_action") or _QUOTA_DEFAULT_ACTION),
    }


def _norm_node_data(data: dict, base: dict = None) -> dict:
    """校验/规范化创建或修改节点的入参。"""
    b = base or {}
    out = {}
    if "port" in data or not base:
        p = _int(data.get("port"), 0)
        if not (1 <= p <= 65535):
            raise ValueError("监听端口需在 1-65535 之间")
        out["port"] = p
    if "proto" in data:
        proto = str(data.get("proto") or "").lower()
        if proto not in ("vmess", "vless"):
            raise ValueError("协议只能是 vmess 或 vless")
        out["proto"] = proto
    if "name" in data:
        out["name"] = str(data.get("name") or "").strip()[:60] or "本地节点"
    if "uuid" in data:
        uid = str(data.get("uuid") or "").strip()
        try:
            uuid.UUID(uid)
        except (ValueError, AttributeError, TypeError):
            raise ValueError("UUID 格式不正确")
        out["uuid"] = uid
    if "security" in data:
        sec = str(data.get("security") or "").lower()
        if sec not in ("none", "reality"):
            raise ValueError("安全类型只能是 none 或 reality")
        out["security"] = sec
    if "outbound" in data:
        ob = str(data.get("outbound") or "").lower()
        if ob not in ("proxy", "direct"):
            raise ValueError("出站方式只能是 proxy 或 direct")
        out["outbound"] = ob
    for k in ("sni", "dest", "shortid", "privatekey", "fp", "flow"):
        if k in data:
            out[k] = str(data.get(k) or "").strip()
    # 流量配额（GB）：0 / 空 / 负数 = 不限；最多 1e7 GB，避免误输入溢出
    if "quota_gb" in data:
        try:
            q = float(str(data.get("quota_gb") or 0).strip())
        except (TypeError, ValueError):
            raise ValueError("流量上限必须是数字")
        if q < 0 or q > 1e7:
            raise ValueError("流量上限需在 0 - 10000000 GB 之间（0 = 不限）")
        out["quota_gb"] = q
    if "quota_action" in data:
        act = str(data.get("quota_action") or _QUOTA_DEFAULT_ACTION).lower()
        if act not in _QUOTA_ACTIONS:
            raise ValueError("超限动作只能是 stop 或 notify")
        out["quota_action"] = act
    return out


def _free_port(exclude_id: str = "") -> int:
    """自动分配一个空闲监听端口（从 10810 起，避开主代理端口）。"""
    main = v2raydb.all_settings()
    used = {_int(main.get(k)) for k in ("socks_port", "http_port", "api_port")}
    used.update(int(r["port"]) for r in v2raydb.list_local_servers() if r.get("id") != exclude_id)
    p = 10810
    while p in used or not _port_free(p):
        p += 1
        if p > 65535:
            break
    return p


def _free_api_port(exclude_id: str = "") -> int:
    """给本地节点分配独立的统计 API 端口：避开主代理端口、各节点监听端口、
    其它节点已占用的统计端口，并确认系统层面空闲。"""
    main = v2raydb.all_settings()
    used = {_int(main.get(k)) for k in ("socks_port", "http_port", "api_port")}
    for r in v2raydb.list_local_servers():
        if r.get("id") == exclude_id:
            continue
        used.add(int(r.get("port") or 0))
        used.add(_int((r.get("cfg") or {}).get("api_port") or 0))
    p = _API_PORT_BASE
    while p in used or not _port_free(p):
        p += 1
        if p > 65535:
            break
    return p


def auto_config(data: dict = None) -> dict:
    """一键生成关键配置：UUID / REALITY 私钥 / ShortID / 空闲端口 / 伪装域名。"""
    data = dict(data or {})
    cfg = {
        "name": str(data.get("name") or "").strip()[:60] or "本地节点",
        "proto": str(data.get("proto") or "vless").lower(),
        "port": _int(data.get("port"), 0) or _free_port(),
        "uuid": str(uuid.uuid4()),
        "outbound": str(data.get("outbound") or "proxy"),
        "security": str(data.get("security") or "reality").lower(),
        "sni": str(data.get("sni") or _DEFAULTS["server_sni"]),
        "dest": str(data.get("dest") or _DEFAULTS["server_dest"]),
        "shortid": uuid.uuid4().hex[:16],
        "fp": str(data.get("fp") or "chrome"),
        "flow": str(data.get("flow") or "xtls-rprx-vision"),
    }
    if cfg["security"] == "reality":
        keys = gen_reality_keys()
        if keys.get("error"):
            raise ValueError(keys["error"])
        cfg["privatekey"] = keys["privateKey"]
    else:
        cfg["privatekey"] = ""
    return cfg


def create_node(data: dict, auto: bool = False) -> dict:
    with _LOCK:
        if auto:
            cfg = auto_config(data)
        else:
            cfg = _norm_node_data(data)
            if not cfg.get("uuid"):
                cfg["uuid"] = str(uuid.uuid4())
            if not cfg.get("port"):
                cfg["port"] = _free_port()
            if cfg.get("security", "reality") == "reality" and not cfg.get("privatekey"):
                keys = gen_reality_keys()
                if keys.get("error"):
                    return {"error": keys["error"]}
                cfg["privatekey"] = keys["privateKey"]
            if not cfg.get("shortid"):
                cfg["shortid"] = uuid.uuid4().hex[:16]
        # 端口占用校验
        for r in v2raydb.list_local_servers():
            if int(r["port"]) == int(cfg["port"]):
                return {"error": "端口 %s 已被本地节点「%s」使用" % (cfg["port"], r["name"])}
        if not _port_free(int(cfg["port"])):
            return {"error": "端口 %s 已被占用" % cfg["port"]}
        # 给新节点分配独立的统计 API 端口（用于流量统计 / 配额限制）
        cfg["api_port"] = _free_api_port()
        sid = v2raydb.add_local_server(cfg["name"], cfg["proto"], cfg["port"], cfg)
        return {"ok": True, "node": node_status(sid)}


def update_node_data(sid: str, data: dict) -> dict:
    with _LOCK:
        cur = v2raydb.get_local_server(sid)
        if not cur:
            return {"error": "节点不存在"}
        try:
            patch = _norm_node_data(data, base=cur)
        except ValueError as e:
            return {"error": str(e)}
        # 端口冲突校验（排除自身）
        if "port" in patch:
            for r in v2raydb.list_local_servers():
                if r["id"] != sid and int(r["port"]) == int(patch["port"]):
                    return {"error": "端口 %s 已被其它节点占用" % patch["port"]}
            if _node_pid(sid) == 0 and not _port_free(int(patch["port"])):
                return {"error": "端口 %s 已被占用" % patch["port"]}
        name = patch.pop("name", None)
        proto = patch.pop("proto", None)
        port = patch.pop("port", None)
        v2raydb.update_local_server(sid, name=name, proto=proto, port=port, cfg=patch or None)
        return {"ok": True, "node": node_status(sid)}


def delete_node(sid: str) -> dict:
    with _LOCK:
        pid = _node_pid(sid)
        if pid:
            v2raymgr._kill(pid)
        for f in _node_paths(sid):
            try:
                os.remove(f)
            except OSError:
                pass
        v2raydb.srv_traffic_delete(sid)
        _stat_reset_node(sid)
        v2raydb.delete_local_server(sid)
        if _shared_core() and v2raymgr.status().get("running"):
            v2raymgr.restart()   # 移除已删除节点的入站
        return {"ok": True}


def node_status(sid: str) -> dict:
    r = v2raydb.get_local_server(sid)
    if not r:
        return {"error": "节点不存在"}
    cfg = _row_to_cfg(r)
    st = _node_read_state(sid)
    main = v2raydb.all_settings()
    conflicts = [lab for k, lab in (("socks_port", "SOCKS5"), ("http_port", "HTTP"), ("api_port", "统计 API"))
                 if _int(main.get(k)) and _int(main.get(k)) == cfg["port"]]
    pbk = public_from_private(cfg["privatekey"]) if cfg["security"] == "reality" else ""

    shared = _shared_core()
    enabled = bool(r.get("enabled", 0))
    if shared:
        # 共用内核：节点是否真正运行 = 已启用 && 主内核在跑
        mst = v2raymgr.status()
        running = enabled and bool(mst.get("running"))
        pid = int(mst.get("pid") or 0) if running else 0
        started_at = float(mst.get("started_at") or 0) if running else 0
        core_path = str((mst.get("core") or {}).get("path") or "")
    else:
        pid = _node_pid(sid)
        running = bool(pid)
        started_at = float(st.get("started_at") or 0)
        core_path = str(st.get("core") or "")

    return {
        "id": sid, "name": cfg["name"], "proto": cfg["proto"], "port": cfg["port"],
        "remark": r.get("remark") or "", "outbound": cfg["outbound"],
        "running": running, "pid": pid, "enabled": enabled, "shared_core": shared,
        "started_at": started_at,
        "core": core_path,
        "security": cfg["security"], "sni": cfg["sni"], "dest": cfg["dest"],
        "shortid": cfg["shortid"], "privatekey": cfg["privatekey"], "publickey": pbk,
        "fp": cfg["fp"], "flow": cfg["flow"], "uuid": cfg["uuid"],
        "reality_ready": bool(cfg["privatekey"]) and bool(pbk),
        "share_url": share_link(cfg),
        "port_free": _port_free(cfg["port"]), "port_conflicts": conflicts,
        "api_port": cfg.get("api_port") or 0,
        "quota_gb": cfg.get("quota_gb") or 0,
        "quota_action": cfg.get("quota_action") or _QUOTA_DEFAULT_ACTION,
    }


_api_port_migrated = False
_legacy_reaped = False


def _reap_legacy_node_procs():
    """共用内核模式下，清理旧架构遗留的独立节点内核进程（srv-*.json / server-config.json）。

    这些进程由改造前的独立进程模式启动；共用内核后它们的端口会与主内核并入的
    入站冲突，必须在进入本地节点页时清理掉（幂等，每进程一次）。
    """
    global _legacy_reaped
    if _legacy_reaped or not _shared_core():
        return
    _legacy_reaped = True
    try:
        procs = v2raymgr._own_core_procs()
    except Exception:                          # noqa: BLE001
        return
    for p in procs:
        base = os.path.basename(p.get("config") or "")
        if not (base.startswith("srv-") or base == "server-config.json"):
            continue
        # 只清理由本模块 state 记录的、或明确是遗留的独立节点进程；
        # 主内核（config.json）绝不动。
        _log.warning("共用内核：清理旧架构独立节点进程 pid=%s（%s）", p["pid"], base)
        try:
            v2raymgr._kill(p["pid"])
        except Exception as e:                 # noqa: BLE001
            _log.warning("清理独立节点进程 %s 失败: %s", p["pid"], e)


def _migrate_api_ports():
    """旧版本创建的节点没有统计端口：进入本地节点页时补分配一次（幂等）。"""
    global _api_port_migrated
    if _api_port_migrated:
        return
    _api_port_migrated = True
    try:
        for r in v2raydb.list_local_servers():
            if not _int((r.get("cfg") or {}).get("api_port") or 0):
                port = _free_api_port(exclude_id=r["id"])
                if port:
                    v2raydb.update_local_server(r["id"], cfg={"api_port": port})
    except Exception as e:                      # noqa: BLE001
        _log.warning("补齐本地节点统计端口失败: %s", e)


def list_nodes() -> dict:
    _reap_legacy_node_procs()
    _migrate_api_ports()
    rows = v2raydb.list_local_servers()
    nodes = []
    for r in rows:
        n = node_status(r["id"])
        if not n.get("error"):
            nodes.append(n)
    return {
        "nodes": nodes, "total": len(nodes),
        "running": sum(1 for n in nodes if n["running"]),
        "lan_ip": v2raycfg.lan_ip(), "core_ready": bool(pick_xray_core()),
        "shared_core": _shared_core(),
    }


def start_node(sid: str) -> dict:
    with _LOCK:
        r = v2raydb.get_local_server(sid)
        if not r:
            return {"error": "节点不存在"}
        cfg = _row_to_cfg(r)
        port = cfg["port"]
        if not (1 <= port <= 65535):
            return {"error": "监听端口需在 1-65535 之间"}
        st = node_status(sid)
        if st.get("port_conflicts"):
            return {"error": "端口 %s 与主代理端口冲突" % port}
        if st["running"]:
            return st
        core = pick_xray_core()
        if not core:
            return {"error": "没有找到 Xray 内核（请到「设置」安装）"}
        if cfg["proto"] == "vless" and cfg["security"] == "reality":
            if not cfg["privatekey"] or not public_from_private(cfg["privatekey"]):
                return {"error": "REALITY 私钥无效，请点「生成密钥对」"}

        if _shared_core():
            # 共用内核：标记启用；主内核在跑就重启使其带上新入站，
            # 没跑则等主代理连接节点时自动并入（此时不会单独起进程）。
            if not _port_free(port):
                return {"error": "端口 %s 已被占用" % port}
            v2raydb.set_local_server_enabled(sid, True)
            _stat_reset_node(sid)
            mst = v2raymgr.status()
            if mst.get("running"):
                rr = v2raymgr.restart()
                if rr.get("error"):
                    v2raydb.set_local_server_enabled(sid, False)
                    return {"error": "并入主内核失败：%s" % rr["error"]}
                _log.info("本地节点 %s 已并入主内核（共用进程）", cfg["name"])
                return node_status(sid)
            return {"ok": True, "pending": True,
                    "node": node_status(sid),
                    "message": "已启用；主代理连接节点后该入站会自动生效（共用内核）"}

        # 独立进程模式（shared_core=0）：沿用每节点一个 xray 进程
        if not _port_free(port):
            return {"error": "端口 %s 已被占用" % port}
        conf = build_config(cfg)
        cf, sf, lf = _node_paths(sid)
        _ensure_dir()
        try:
            tmp = cf + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(conf, f, ensure_ascii=False, indent=2)
            os.replace(tmp, cf)
        except OSError as e:
            return {"error": "写入配置失败：%s" % e}
        err = v2raymgr._validate_config(core, cf)
        if err:
            return {"error": err}
        try:
            logf = open(lf, "a", encoding="utf-8")
        except OSError as e:
            return {"error": "无法写日志：%s" % e}
        try:
            proc = subprocess.Popen([core, "run", "-c", cf], cwd=_DIR,
                                    stdin=subprocess.DEVNULL, stdout=logf, stderr=logf,
                                    start_new_session=True)
        except OSError as e:
            logf.close()
            return {"error": "启动失败：%s" % e}
        finally:
            logf.close()
        time.sleep(0.9)
        if proc.poll() is not None:
            return {"error": "启动后立即退出（码 %s）：%s" %
                    (proc.returncode, node_log_tail(sid, 30)[-800:])}
        _node_write_state(sid, {"pid": proc.pid, "started_at": time.time(),
                                "port": port, "core": core})
        _stat_reset_node(sid)   # 内核重启后计数从 0 开始，清掉上一次的采样基准
        _ensure_stat_thread()
        _log.info("本地节点 %s 已启动 pid=%s 端口=%s", cfg["name"], proc.pid, port)
        return node_status(sid)


def stop_node(sid: str) -> dict:
    with _LOCK:
        if _shared_core():
            # 共用内核：取消启用并重启主内核以移除该入站
            v2raydb.set_local_server_enabled(sid, False)
            if v2raymgr.status().get("running"):
                rr = v2raymgr.restart()
                if rr.get("error"):
                    return {"error": "从主内核移除失败：%s" % rr["error"]}
            _stat_reset_node(sid)
            return {"ok": True, "node": node_status(sid)}

        # 独立进程模式
        pid = _node_pid(sid)
        if pid:
            v2raymgr._kill(pid)
        _, sf, _ = _node_paths(sid)
        try:
            os.remove(sf)
        except OSError:
            pass
        return {"ok": True, "node": node_status(sid)}


def node_new_uuid(sid: str) -> dict:
    uid = str(uuid.uuid4())
    v2raydb.update_local_server(sid, cfg={"uuid": uid})
    return {"ok": True, "uuid": uid, "node": node_status(sid)}


def node_gen_keys(sid: str) -> dict:
    keys = gen_reality_keys()
    if keys.get("error"):
        return {"error": keys["error"]}
    v2raydb.update_local_server(sid, cfg={"privatekey": keys["privateKey"], "security": "reality"})
    return {"ok": True, **keys, "node": node_status(sid)}


# ===========================================================================
# 本地节点流量统计 + 配额限制（后台线程，每个节点用独立 stats API 端口采样）
# ===========================================================================

_stat_lock = threading.Lock()
_stat = {
    "prev": {},    # sid -> {"up": bytes, "down": bytes}  上次内核计数器
    "speed": {},   # sid -> {"up": B/s, "down": B/s}      实时速度
    "ts": {},      # sid -> 上次采样时间戳
    "ok": {},      # sid -> stats API 是否可用
}
_stat_thread = None
_quota_hit = {}    # sid -> True  本进程内已触发过配额超限（避免重复停止 / 刷日志）


def _stat_reset_node(sid: str):
    """清除某节点的采样基准（节点重启 / 删除 / 清零时调用）。"""
    with _stat_lock:
        for key in ("prev", "speed", "ts", "ok"):
            _stat[key].pop(sid, None)
    _quota_hit.pop(sid, None)


def _xray_inbound_counters(core: str, api_port: int, tag: str = None) -> dict:
    """`xray api statsquery` 取某入站 tag 的上下行累计字节。

    Xray 统计名格式：inbound>>>tag>>>traffic>>>uplink / downlink。
    tag 为空时用默认 _STAT_TAG（独立进程模式的 local-server-in）。
    """
    try:
        p = subprocess.run([core, "api", "statsquery", "--server=127.0.0.1:%d" % api_port],
                           capture_output=True, text=True, timeout=5)
        if p.returncode != 0:
            return {}
        j = json.loads(p.stdout)
    except (OSError, subprocess.SubprocessError, ValueError):
        return {}
    out = {}
    prefix = "inbound>>>%s>>>traffic>>>" % (tag or _STAT_TAG)
    for it in (j.get("stat") or []):
        name = str((it or {}).get("name") or "")
        if name.startswith(prefix):
            out[name.rsplit(">>>", 1)[-1]] = int(str(it.get("value") or 0) or 0)
    return out


def _quota_bytes(cfg: dict) -> int:
    """配额字节数；0 = 不限。"""
    try:
        gb = float(cfg.get("quota_gb") or 0)
    except (TypeError, ValueError):
        return 0
    if gb <= 0:
        return 0
    return int(gb * 1024 * 1024 * 1024)


def _stats_sample():
    """采样一次所有运行中的本地节点：增量落库 + 实时速度 + 配额检查。"""
    core = pick_xray_core()
    if not core:
        return
    now = time.time()
    shared = _shared_core()
    # 共用内核：统计从主内核的 api_port 读，tag = srv-<sid>；进程状态取自主内核
    main_api_port = main_pid = 0
    if shared:
        mst = v2raymgr.status()
        main_pid = int(mst.get("pid") or 0)
        settings = mst.get("settings") or {}
        main_api_port = _int(settings.get("api_port") or 0)
        mcore = str((mst.get("core") or {}).get("path") or "")
        if mcore:
            core = mcore
    try:
        rows = v2raydb.list_local_servers()
    except Exception:                          # noqa: BLE001
        return
    for row in rows:
        sid = row["id"]
        try:
            cfg = _row_to_cfg(row)
            if shared:
                running = bool(row.get("enabled", 0)) and bool(main_pid) and bool(main_api_port)
                api_port = main_api_port
                tag = "srv-%s" % sid
            else:
                running = bool(_node_pid(sid))
                api_port = cfg.get("api_port") or 0
                tag = None
            if not running or not api_port:
                with _stat_lock:
                    _stat["speed"][sid] = {"up": 0.0, "down": 0.0}
                    _stat["ok"][sid] = False
                continue
            counters = _xray_inbound_counters(core, api_port, tag)
            ok = "uplink" in counters and "downlink" in counters
            du = dd = 0.0
            with _stat_lock:
                prev = _stat["prev"].get(sid) or {}
                last_ts = float(_stat["ts"].get(sid) or 0)
                if ok and prev and last_ts:
                    dt = max(0.5, now - last_ts)
                    du = max(0, counters["uplink"] - int(prev.get("up") or 0))
                    dd = max(0, counters["downlink"] - int(prev.get("down") or 0))
                    su, sd = du / dt, dd / dt
                else:
                    su = sd = 0.0
                _stat.update({
                    "speed": {**_stat["speed"], sid: {"up": su, "down": sd}},
                    "ok": {**_stat["ok"], sid: ok},
                    "prev": {**_stat["prev"], sid: {"up": counters.get("uplink", 0),
                                                     "down": counters.get("downlink", 0)} if ok else {}},
                    "ts": {**_stat["ts"], sid: now},
                })
            if (du or dd):
                v2raydb.srv_add_traffic(sid, du, dd)
            # 配额检查：累计用量超过上限时按节点配置的动作处理
            limit = _quota_bytes(cfg)
            if limit > 0:
                used = v2raydb.srv_traffic_rows().get(sid) or {}
                used_bytes = int(used.get("up") or 0) + int(used.get("down") or 0)
                if used_bytes >= limit:
                    if not _quota_hit.get(sid):
                        _quota_hit[sid] = True
                        _log.warning("本地节点 %s 流量已超配额（%s / %s），执行动作：%s",
                                     cfg["name"], used_bytes, limit, cfg.get("quota_action"))
                    node_running = (bool(row.get("enabled", 0)) and bool(main_pid)) if shared else bool(_node_pid(sid))
                    if cfg.get("quota_action") == "stop" and node_running:
                        stop_node(sid)
                else:
                    _quota_hit.pop(sid, None)
        except Exception:                      # noqa: BLE001
            continue


def _stats_loop():
    while True:
        try:
            _stats_sample()
        except Exception:                      # noqa: BLE001
            pass
        time.sleep(_STAT_INTERVAL)


def _ensure_stat_thread():
    global _stat_thread
    if _stat_thread is None or not _stat_thread.is_alive():
        _stat_thread = threading.Thread(target=_stats_loop, daemon=True,
                                        name="v2ray-local-stats")
        _stat_thread.start()


def traffic() -> dict:
    """本地节点流量统计：总量 + 每个节点的用量 / 实时速度 / 配额状态。"""
    _migrate_api_ports()
    _ensure_stat_thread()
    rows = v2raydb.srv_traffic_rows()
    with _stat_lock:
        speeds = dict(_stat["speed"])
        oks = dict(_stat["ok"])
    shared = _shared_core()
    main_pid = int(v2raymgr.status().get("pid") or 0) if shared else 0
    nodes = []
    total_up = total_down = 0
    for row in v2raydb.list_local_servers():
        sid = row["id"]
        cfg = _row_to_cfg(row)
        r = rows.get(sid) or {}
        up, down = int(r.get("up") or 0), int(r.get("down") or 0)
        total_up += up
        total_down += down
        sp = speeds.get(sid) or {}
        limit = _quota_bytes(cfg)
        nodes.append({
            "id": sid, "name": cfg["name"], "proto": cfg["proto"],
            "up": up, "down": down,
            "speed_up": round(sp.get("up") or 0),
            "speed_down": round(sp.get("down") or 0),
            "quota_gb": cfg.get("quota_gb") or 0,
            "quota_bytes": limit,
            "quota_action": cfg.get("quota_action") or _QUOTA_DEFAULT_ACTION,
            "exceeded": bool(limit and (up + down) >= limit),
            "api_ok": bool(oks.get(sid)),
            "running": (bool(row.get("enabled", 0)) and bool(main_pid)) if shared else bool(_node_pid(sid)),
        })
    nodes.sort(key=lambda x: -(x["up"] + x["down"]))
    return {
        "speed": {"up": sum(int((v or {}).get("up") or 0) for v in speeds.values()),
                  "down": sum(int((v or {}).get("down") or 0) for v in speeds.values())},
        "total": {"up": total_up, "down": total_down},
        "nodes": nodes,
    }


def reset_traffic(sid: str = "") -> dict:
    """清零本地节点流量（传 sid 只清该节点，留空清全部）。"""
    v2raydb.srv_traffic_reset(sid)
    for key in ([sid] if sid else [r["id"] for r in v2raydb.list_local_servers()]):
        _stat_reset_node(key)
    return {"ok": True, "traffic": traffic()}

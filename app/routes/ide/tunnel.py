"""内网穿透（cpolar）模块：安装检测、authtoken 配置、隧道创建 / 停止 / 列表。

参考 cpolar 官方 Ubuntu 快速入门（https://www.cpolar.com/blog/cpolar-quick-start-tutorial-ubuntu-series）：
  · 安装：curl -L https://www.cpolar.com/static/downloads/install-release-cpolar.sh | sudo bash
  · 配置：cpolar authtoken <token>（token 在官网后台「验证」页）
  · 隧道：cpolar 启动后本地 Web API 监听 9200（ngrok 1.x 风格）：
      GET    /api/tunnels          在线隧道列表（含公网 URL）
      POST   /api/tunnels          创建并启动隧道 {"name","proto","addr","region"?}
      DELETE /api/tunnels/<name>   停止隧道
  · 服务：sudo systemctl start/stop/enable cpolar

接口：
GET  /api/tunnel/status     综合状态（已安装 / 版本 / 服务 / Web API / authtoken）
POST /api/tunnel/authtoken  配置 authtoken {token}
POST /api/tunnel/install    一键安装（走官方脚本，需 sudo 免密，否则提示用终端）
POST /api/tunnel/service    控制 cpolar systemd 服务 {action: start|stop|restart}
GET/POST/DELETE /api/tunnel/webui/cred  加密保存 / 状态 / 清除 Web UI 账号密码
POST /api/tunnel/webui/login 登录本机 9200 Web UI（不传凭据则用已保存的）→ token
GET  /api/tunnel/list       隧道列表：9200 实时 API 优先，回退 cpolar.yml 的 tunnels 段
POST /api/tunnel/start      创建隧道（写入 cpolar.yml）{name, proto, addr, region?}
POST /api/tunnel/stop       移除隧道（从 cpolar.yml 删除）{name}

说明：cpolar 3.x 的 /api/tunnels 只是 ngrok 兼容占位（200 空 body），Web UI 的
/api/v1/* 又需要登录 token，因此 cpolar.yml 是唯一稳定可读的本地数据源；对它做
文本级增改，保留注释与原有格式。systemd 服务控制需要 sudo 免密；root 直接执行，
普通用户走 `sudo -n`（非交互，避免挂起），失败时回传终端命令供用户手动执行。
"""
import json
import os
import re
import shutil
import subprocess
import urllib.error
import urllib.request

from flask import Blueprint, jsonify, request

bp = Blueprint("tunnel", __name__)

API_BASE = "http://127.0.0.1:9200"      # cpolar 本地 Web API（ngrok 1.x 风格）
WEB_UI = API_BASE + "/ui"               # cpolar Web 管理界面
INSTALL_CMD = ("curl -L https://www.cpolar.com/static/downloads/install-release-cpolar.sh "
               "| sudo bash")
_API_TIMEOUT = 3
_CMD_TIMEOUT = 90


def _fail(msg, code=400):
    return jsonify({"error": msg}), code


def _run(cmd, timeout=_CMD_TIMEOUT):
    """跑一条命令，返回 (ok, stdout+stderr 末尾)。失败不抛异常，交给调用方组装提示。"""
    try:
        p = subprocess.run(cmd, shell=isinstance(cmd, str), capture_output=True,
                           text=True, timeout=timeout)
        out = ((p.stdout or "") + (p.stderr or "")).strip()
        return p.returncode == 0, out[-2000:]
    except FileNotFoundError:
        return False, "命令不存在"
    except subprocess.TimeoutExpired:
        return False, "执行超时"
    except Exception as e:                                   # noqa: BLE001
        return False, str(e)


def _api(path, method="GET", body=None, timeout=_API_TIMEOUT):
    """调用 cpolar 本地 9200 REST API。返回 (ok, data或错误文本)。"""
    url = API_BASE + path
    data = None
    headers = {}
    if body is not None:
        import json as _json
        data = _json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read().decode("utf-8", "replace")
        import json as _json
        try:
            return True, _json.loads(raw)
        except ValueError:
            return True, {"raw": raw[:2000]}
    except urllib.error.HTTPError as e:
        try:
            return False, (e.read().decode("utf-8", "replace") or "")[:500] or ("HTTP %d" % e.code)
        except Exception:                                    # noqa: BLE001
            return False, "HTTP %d" % e.code
    except Exception as e:                                   # noqa: BLE001（连接拒绝 = 服务未启动）
        return False, str(e)


# cpolar 配置位置不固定：`cpolar service install` 默认写 /usr/local/etc/cpolar，
# 而 `cpolar authtoken` 默认写 $HOME/.cpolar/cpolar.yml，两份可能不是同一个文件。
CONFIG_CANDIDATES = (
    "/usr/local/etc/cpolar/cpolar.yml",
    "/etc/cpolar/cpolar.yml",
    "/root/.cpolar/cpolar.yml",
)
AUTHTOKEN_RE = re.compile(r"^\s*authtoken\s*:\s*[\"']?([^\s\"'#]+)", re.I)


def _cpolar_config_paths():
    """按优先级返回候选配置文件路径（去重）。服务配置排在最前。"""
    paths = []
    env = os.environ.get("CPOLAR_CONFIG", "").strip()
    if env:
        paths.append(env)
    paths.extend(CONFIG_CANDIDATES)
    try:
        paths.append(os.path.join(os.path.expanduser("~"), ".cpolar", "cpolar.yml"))
    except Exception:                                        # noqa: BLE001
        pass
    seen, out = set(), []
    for p in paths:
        if p and p not in seen:
            seen.add(p)
            out.append(p)
    return out


def _read_authtoken_masked():
    """遍历候选配置，返回 (是否已配置, 掩码, 路径)。只回前 6 位，不回 token 全文。"""
    for path in _cpolar_config_paths():
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                for line in f:
                    m = AUTHTOKEN_RE.match(line)
                    if m and m.group(1):
                        return True, m.group(1)[:6] + "****", path
        except OSError:
            continue
    return False, "", ""


def _write_authtoken_to(path, token):
    """原地改写 authtoken 行：open('w') 保留原文件属主/权限，避免 cpolar(nobody) 读不到。"""
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        lines = f.readlines()
    for i, line in enumerate(lines):
        if AUTHTOKEN_RE.match(line):
            lines[i] = "authtoken: " + token + "\n"
            break
    else:
        lines.insert(0, "authtoken: " + token + "\n")
    with open(path, "w", encoding="utf-8") as f:
        f.writelines(lines)


# ---------------- cpolar.yml 隧道定义（文本级读写，保留注释与原有格式） ----------------

def _active_config_path():
    """返回服务实际使用的配置文件（第一个含 authtoken / tunnels 的候选）。"""
    for path in _cpolar_config_paths():
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                head = f.read(8192)
            if "authtoken:" in head or "tunnels:" in head:
                return path
        except OSError:
            continue
    return ""


def _read_config_tunnels(path):
    """解析 tunnels: 段。cpolar 3.x 的 /api/tunnels 只回空 body，配置才是可靠数据源。"""
    if not path:
        return []
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            lines = f.readlines()
    except OSError:
        return []
    out, cur, in_sec = [], None, False
    for raw in lines:
        line = raw.rstrip("\r\n")
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        indent = len(line) - len(line.lstrip())
        if indent == 0:
            if in_sec and cur:
                out.append(cur)
                cur = None
            in_sec = s.startswith("tunnels:")
            continue
        if not in_sec:
            continue
        if indent <= 2 and s.endswith(":"):
            if cur:
                out.append(cur)
            cur = {"name": s[:-1].strip().strip("\"'"), "proto": "", "addr": "",
                   "public_url": "", "status": ""}
            continue
        if cur and ":" in s:
            k, v = s.split(":", 1)
            k, v = k.strip().lower(), v.split("#", 1)[0].strip().strip("\"'")
            if k == "proto": cur["proto"] = v
            elif k == "addr": cur["addr"] = v
            elif k == "start_type": cur["status"] = v
            elif k == "hostname" and v: cur["public_url"] = "http://" + v
    if cur:
        out.append(cur)
    return out


def _config_tunnel_lines(name, proto, addr):
    import uuid
    return [
        "  " + name + ":\n",
        "    id: " + str(uuid.uuid4()) + "\n",
        "    proto: " + proto + "\n",
        '    addr: "' + addr + '"\n',
        "    bind_tls: both\n",
        "    start_type: enable\n",
    ]


def _add_config_tunnel(path, name, proto, addr):
    """把新建隧道追加进 tunnels: 段；同名返回 False，避免覆盖已有配置。"""
    if any(t["name"] == name for t in _read_config_tunnels(path)):
        return False
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        lines = f.readlines()
    block = _config_tunnel_lines(name, proto, addr)
    start = next((i for i, l in enumerate(lines) if re.match(r"^tunnels\s*:", l)), None)
    if start is None:
        if lines and not lines[-1].endswith("\n"):
            lines[-1] += "\n"
        lines.append("tunnels:\n")
        lines.extend(block)
    else:
        end = len(lines)
        for j in range(start + 1, len(lines)):
            l = lines[j]
            if l.strip() and not l.startswith((" ", "\t", "#")):
                end = j
                break
        lines[end:end] = block
    with open(path, "w", encoding="utf-8") as f:
        f.writelines(lines)
    return True


def _remove_config_tunnel(path, name):
    """从 tunnels: 段删除指定隧道的整个定义块。"""
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        lines = f.readlines()
    out, in_sec, skip = [], False, False
    for line in lines:
        s = line.strip()
        indent = len(line) - len(line.lstrip())
        if not s or s.startswith("#"):
            out.append(line)
            continue
        if indent == 0:
            in_sec = s.startswith("tunnels:")
            skip = False
            out.append(line)
            continue
        if in_sec and indent <= 2 and s.endswith(":"):
            skip = (s[:-1].strip().strip("\"'") == name)
            if skip:
                continue
        if skip:
            continue
        out.append(line)
    with open(path, "w", encoding="utf-8") as f:
        f.writelines(out)


def _status_payload():
    """聚合一次完整状态，供 /status 与 /service 共用。"""
    installed = bool(shutil.which("cpolar"))
    version = ""
    if installed:
        ok, out = _run(["cpolar", "version"], timeout=10)
        version = out.splitlines()[0].strip() if ok and out else ""
    _svc_ok, svc_out = _run(["systemctl", "is-active", "cpolar"], timeout=10)
    service = (svc_out or "").strip().splitlines()[0] if svc_out else "unknown"
    api_ok, _api_err = _api("/api/tunnels")
    tok_set, tok_mask, tok_config = _read_authtoken_masked()
    return {
        "installed": installed,
        "version": version,
        "service": service,            # active / inactive / failed / unknown
        "api_ok": bool(api_ok),
        "web_ui": WEB_UI,
        "authtoken_set": tok_set,
        "authtoken_mask": tok_mask,
        "authtoken_config": tok_config,   # 检测到的配置文件，便于在面板里排查
        "install_cmd": INSTALL_CMD,
    }


@bp.get("/api/tunnel/status")
def t_status():
    return jsonify(_status_payload())


@bp.post("/api/tunnel/service")
def t_service():
    """启动 / 停止 / 重启 cpolar 的 systemd 服务（面板上的服务按钮走这里）。"""
    action = str((request.get_json(silent=True) or {}).get("action") or "").strip().lower()
    if action not in ("start", "stop", "restart"):
        return _fail("操作仅支持 start / stop / restart")
    if not shutil.which("cpolar"):
        return _fail("cpolar 尚未安装，请先安装")

    # root 直接执行，否则要求 sudo 免密；-n 保证无密码时立即失败而不是卡在交互提示
    cmd = ["systemctl", action, "cpolar"]
    if os.geteuid() != 0:
        cmd = ["sudo", "-n"] + cmd
    manual = "sudo systemctl " + action + " cpolar"
    ok, out = _run(cmd, timeout=60)
    status = _status_payload()
    if not ok:
        return jsonify({
            "ok": False,
            "error": "无法通过 Web 服务控制 systemd：" + (out or "无权限或命令执行失败"),
            "cmd": manual,
            "hint": "请在服务器终端执行：" + manual,
            "status": status,
        })
    return jsonify({"ok": True, "action": action, "output": out[-500:], "status": status})


@bp.post("/api/tunnel/authtoken")
def t_authtoken():
    token = str((request.get_json(silent=True) or {}).get("token") or "").strip()
    if not token:
        return _fail("请填写 authtoken（cpolar 官网后台「验证」页可查）")
    if not re.fullmatch(r"[A-Za-z0-9._-]{8,200}", token):
        return _fail("authtoken 格式不正确（只允许字母、数字、点、中划线、下划线）")
    if not shutil.which("cpolar"):
        return _fail("cpolar 尚未安装，请先安装")

    # CLI 写的是 $HOME/.cpolar/cpolar.yml，服务读的可能是 /usr/local/etc/cpolar/cpolar.yml；
    # 两边都更新，避免「保存成功但服务仍用旧 token」。
    cli_ok, out = _run(["cpolar", "authtoken", token])
    _set, _mask, active_path = _read_authtoken_masked()
    target = active_path or next((p for p in _cpolar_config_paths() if os.path.isfile(p)), "")
    synced = False
    if target:
        try:
            _write_authtoken_to(target, token)
            synced = True
        except OSError as e:                                 # noqa: BLE001
            out = (out + "\n同步服务配置失败：" + str(e)).strip()
    if not cli_ok and not synced:
        return _fail("配置失败：CLI 与配置文件都不可写（" + (out or "未知错误") + "）")
    return jsonify({
        "ok": True,
        "output": out[-500:],
        "config": target,
        "synced": synced,
        "hint": "" if synced else "已写入 CLI 默认配置；服务配置文件不可写，请手动同步 authtoken",
    })


# Web UI 账号密码：复用 app/services/common/secret.py 的加密能力，密文落在
# config.DATA_ROOT 下（权限 600），浏览器端不保存任何明文密码。
_CRED_FILE = ".tunnel_webui_cred.json"


def _cred_path():
    from ... import config
    return os.path.join(config.DATA_ROOT, _CRED_FILE)


def _cred_secret():
    from ...services.common import secret
    return secret


def _read_cred():
    """读取并解密本机凭据，返回 (email, password)；不存在 / 校验失败返回空串。"""
    try:
        with open(_cred_path(), "r", encoding="utf-8") as f:
            d = json.load(f)
        if not isinstance(d, dict):
            return "", ""
    except (OSError, ValueError):
        return "", ""
    s = _cred_secret()
    return s.decrypt(d.get("email") or ""), s.decrypt(d.get("password") or "")


def _write_cred(email, password):
    s = _cred_secret()
    path = _cred_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"email": s.encrypt(email), "password": s.encrypt(password)}, f)
    os.chmod(path, 0o600)


@bp.get("/api/tunnel/webui/cred")
def t_webui_cred_get():
    email, pwd = _read_cred()
    return jsonify({"ok": True, "saved": bool(email and pwd), "email": email})


@bp.post("/api/tunnel/webui/cred")
def t_webui_cred_save():
    d = request.get_json(silent=True) or {}
    email = str(d.get("email") or "").strip()
    password = str(d.get("password") or "")
    if not email or not password:
        return _fail("请填写 cpolar 邮箱账号与密码")
    try:
        _write_cred(email, password)
    except OSError as e:
        return _fail("加密保存失败：" + str(e))
    return jsonify({"ok": True, "email": email})


@bp.delete("/api/tunnel/webui/cred")
def t_webui_cred_delete():
    try:
        os.remove(_cred_path())
    except FileNotFoundError:
        pass
    except OSError as e:
        return _fail("清除失败：" + str(e))
    return jsonify({"ok": True})


@bp.post("/api/tunnel/webui/login")
def t_webui_login():
    """用 cpolar 官网账号登录本机 9200 Web UI，回传 token 给前端写入共享 cookie。

    不传账号密码时自动使用服务端加密保存的凭据；Web UI 是不同端口的独立站点，
    父页无法直接操作它的登录表单，但登录态存在 cookie `vue_admin_template_token`，
    cookie 不区分端口，写入后 iframe 即为已登录。
    """
    d = request.get_json(silent=True) or {}
    email = str(d.get("email") or "").strip()
    password = str(d.get("password") or "")
    if not email or not password:
        email, password = _read_cred()
    if not email or not password:
        return _fail("未保存 Web 面板账号密码，请先在侧栏「Web 面板自动登录」中保存")
    ok, data = _api("/api/v1/user/login", method="POST",
                    body={"email": email, "password": password}, timeout=15)
    if not ok:
        return _fail("登录请求失败：" + (data if isinstance(data, str) else "9200 不可达，请先启动 cpolar 服务"))
    token = ""
    if isinstance(data, dict):
        token = str(data.get("token") or "")
        if not token and isinstance(data.get("data"), dict):
            token = str(data["data"].get("token") or "")
    if not token:
        msg = data.get("message") if isinstance(data, dict) else None
        return _fail(str(msg or "登录失败：账号或密码不正确"))
    return jsonify({"ok": True, "token": token})


@bp.post("/api/tunnel/install")
def t_install():
    """一键安装：跑官方脚本（需 sudo 免密环境；否则提示改用终端执行）。"""
    ok, out = _run(INSTALL_CMD, timeout=300)
    installed = bool(shutil.which("cpolar"))
    if not ok and not installed:
        return jsonify({"ok": False, "installed": False,
                        "output": out[-1500:],
                        "hint": "安装失败。Web 服务通常没有 sudo 免密权限，"
                                "请在服务器终端执行：" + INSTALL_CMD})
    return jsonify({"ok": True, "installed": installed, "output": out[-1500:]})


@bp.get("/api/tunnel/list")
def t_list():
    """隧道列表：优先 9200 实时 API，拿不到数据就回退到 cpolar.yml 的 tunnels 段。

    cpolar 3.x 的 /api/tunnels 是 ngrok 兼容占位（200 空 body），Web UI 的
    /api/v1/tunnels 又需要登录 token，配置文件因此是唯一稳定可读的本地数据源。
    每次请求都重读文件，保证侧栏能实时反映 Web 面板里增删的隧道。
    """
    ok, data = _api("/api/tunnels")
    tunnels = []
    if ok and isinstance(data, dict) and isinstance(data.get("tunnels"), list):
        for t in data["tunnels"]:
            if not isinstance(t, dict):
                continue
            cfg = t.get("config") if isinstance(t.get("config"), dict) else {}
            tunnels.append({
                "name": str(t.get("name") or ""),
                "proto": str(t.get("proto") or cfg.get("proto") or ""),
                "addr": str(cfg.get("addr") or t.get("addr") or ""),
                "public_url": str(t.get("public_url") or ""),
                "status": str(t.get("status") or "active"),
            })
    cfg_path = _active_config_path()
    source = "api" if tunnels else "config"
    if not tunnels:
        tunnels = _read_config_tunnels(cfg_path)
    return jsonify({"ok": True, "tunnels": tunnels, "source": source, "config": cfg_path})


@bp.post("/api/tunnel/start")
def t_start():
    d = request.get_json(silent=True) or {}
    name = str(d.get("name") or "").strip()
    proto = str(d.get("proto") or "http").strip().lower()
    addr = str(d.get("addr") or "").strip()
    region = str(d.get("region") or "").strip()
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,60}", name or ""):
        return _fail("隧道名称只能含字母 / 数字 / 中划线 / 下划线（1-60 位）")
    if proto not in ("http", "tcp"):
        return _fail("协议仅支持 http / tcp")
    if not re.fullmatch(r"\d{1,5}", addr or "") or not (1 <= int(addr) <= 65535):
        return _fail("本地地址请填 1-65535 的端口号")
    cfg = _active_config_path()
    if not cfg:
        return _fail("未找到 cpolar 配置文件，无法创建隧道")
    try:
        if not _add_config_tunnel(cfg, name, proto, addr):
            _bind_ide_tunnel(name)          # 已存在：也补挂到当前运行的任务（老隧道补登记）
            return _fail("隧道名称 " + name + " 已存在")
    except OSError as e:
        return _fail("写入 cpolar 配置失败：" + str(e))
    _bind_ide_tunnel(name)                  # 一键隧道（ide_<端口>）挂到运行任务：任务退出时自动关闭
    body = {"name": name, "proto": proto, "addr": addr}
    if region:
        body["region"] = region
    ok, data = _api("/api/tunnels", method="POST", body=body)
    return jsonify({
        "ok": True, "config": cfg,
        "hint": "" if ok else "隧道已写入 cpolar 配置；9200 未响应创建请求，请在 Web 面板点「启动」",
        "tunnel": data if isinstance(data, dict) else {},
    })


def _bind_ide_tunnel(name: str) -> None:
    """ide_<端口> 形式的隧道 → 挂到正在监听该端口的运行任务，任务退出时自动删除。

    放在 try 里静默失败：找不到任务（隧道先于服务创建）或端口探测异常都不影响创建本身。
    """
    m = re.fullmatch(r"ide_(\d{1,5})", name or "")
    if not m:
        return
    try:
        from . import run as _ide_run       # 延迟导入：run 与 tunnel 不互相依赖模块级加载
        _ide_run.bind_auto_tunnel_for_port(int(m.group(1)), name)
    except Exception:
        pass


@bp.post("/api/tunnel/stop")
def t_stop():
    name = str((request.get_json(silent=True) or {}).get("name") or "").strip()
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,60}", name or ""):
        return _fail("隧道名称不合法")
    cfg = _active_config_path()
    removed = False
    if cfg:
        try:
            _remove_config_tunnel(cfg, name)
            removed = True
        except OSError:
            pass
    ok, _data = _api("/api/tunnels/" + name, method="DELETE")
    return jsonify({"ok": True, "removed": removed,
                    "hint": "" if ok else "已从配置移除；9200 未响应删除请求，请检查 Web 面板"})

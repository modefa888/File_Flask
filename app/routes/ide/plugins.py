"""插件管理蓝图：列举 / 安装 / 启用禁用 / 卸载 / 提供入口；以及受限文件读写代理。

路由（无统一前缀，每个写全路径，与项目其它蓝图一致）：
    GET  /api/plugins                      列出所有已安装插件（读 data/plugins/<id>/plugin.json）
    POST /api/plugins/install              multipart 上传 zip，解压到 data/plugins/<id>（id 取自 plugin.json）
    POST /api/plugins/<pid>/toggle         body {enabled:bool} 切换启用/禁用（写回 plugin.json）
    POST /api/plugins/<pid>/uninstall      删除 data/plugins/<pid>
    GET  /api/plugins/<pid>/main.js        仅当 enabled 时返回插件入口文件（按 plugin.json 的 main 字段）
    POST /api/plugins/fs/read              body {path} 读取文本文件内容（供插件使用）
    POST /api/plugins/fs/write             body {path,content} 写文本文件（供插件使用）

安全说明：
    - 插件 id 仅允许 [A-Za-z0-9_-]{1,64}；zip 解压前校验无绝对/穿越路径。
    - main.js 入口限制在插件目录内，禁止跳出。
    - 文件读写接口不限制路径根（IDE 本身即可访问任意文件），只做归一化与存在性检查。
    当前为「可信插件」模型：插件由用户自行安装，与 VS Code 默认信任用户安装的扩展一致。
"""
import ipaddress
import json
import os
import re
import shutil
import socket
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from datetime import datetime, timezone

from flask import Blueprint, request, jsonify, send_file, send_from_directory

from ... import config
from ...log import get_logger

_log = get_logger()

bp = Blueprint("plugins", __name__)

PLUGINS_DIR = os.path.join(config.DATA_ROOT, "plugins")
os.makedirs(PLUGINS_DIR, exist_ok=True)
REGISTRY_FILE = os.path.join(PLUGINS_DIR, "registry.json")

_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def _plugin_dir(pid):
    return os.path.join(PLUGINS_DIR, pid)


def _remove_path(path):
    """删除插件路径：兼容符号链接 / 普通文件 / 目录（shutil.rmtree 不能处理符号链接）。"""
    if os.path.islink(path) or os.path.isfile(path):
        os.remove(path)
    elif os.path.isdir(path):
        shutil.rmtree(path)


def _load_registry():
    """读取插件登记簿（data/plugins/registry.json）。"""
    try:
        with open(REGISTRY_FILE, encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        data = {}
    if not isinstance(data, dict):
        data = {}
    data.setdefault("plugins", {})
    data.setdefault("history", [])
    return data


def _save_registry(data):
    try:
        with open(REGISTRY_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    except Exception as e:
        _log.warning("写入插件登记簿失败: %s", e)


def _registry_record(action, meta):
    """写入一条安装 / 卸载记录，并维护插件状态与历史。

    action: "install" | "uninstall"
    meta:   插件元数据 dict（至少含 id；name/version 可选）
    """
    try:
        pid = str(meta.get("id", "")).strip()
        if not pid:
            return
        data = _load_registry()
        now = datetime.now(timezone.utc).isoformat()
        entry = data["plugins"].get(pid) or {}
        entry["id"] = pid
        entry["name"] = meta.get("name", pid)
        entry["version"] = meta.get("version", "0.0.0")
        if action == "install":
            entry["status"] = "installed"
            entry["installed_at"] = entry.get("installed_at") or now
            entry["uninstalled_at"] = None
        else:
            entry["status"] = "uninstalled"
            entry["uninstalled_at"] = now
        entry["updated_at"] = now
        data["plugins"][pid] = entry
        data["history"].append({
            "action": action, "id": pid,
            "name": meta.get("name", pid), "version": meta.get("version", "0.0.0"),
            "at": now,
        })
        if len(data["history"]) > 500:
            data["history"] = data["history"][-500:]
        _save_registry(data)
    except Exception as e:
        _log.warning("更新插件登记簿失败: %s", e)


def _load_meta(pid):
    mp = os.path.join(_plugin_dir(pid), "plugin.json")
    if not os.path.isfile(mp):
        return None
    try:
        with open(mp, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def _list_plugins():
    out = []
    if not os.path.isdir(PLUGINS_DIR):
        return out
    for name in sorted(os.listdir(PLUGINS_DIR)):
        meta = _load_meta(name)
        if meta is None:
            continue
        meta.setdefault("id", name)
        meta.setdefault("name", name)
        meta.setdefault("version", "0.0.0")
        meta.setdefault("enabled", True)
        out.append(meta)
    return out


def _save_meta(pid, meta):
    with open(os.path.join(_plugin_dir(pid), "plugin.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)


@bp.route("/api/plugins", methods=["GET"])
def list_plugins():
    return jsonify(_list_plugins())


@bp.route("/api/plugins/registry", methods=["GET"])
def plugin_registry():
    """查看插件登记簿：已安装 / 已卸载历史（data/plugins/registry.json）。"""
    return jsonify(_load_registry())


@bp.route("/api/plugins/install", methods=["POST"])
def install_plugin():
    f = request.files.get("file")
    if not f or not f.filename:
        return jsonify({"error": "缺少插件包（zip）"}), 400
    tmp = tempfile.mkdtemp(prefix="plg_")
    try:
        zpath = os.path.join(tmp, "plugin.zip")
        f.save(zpath)
        try:
            zf = zipfile.ZipFile(zpath)
        except zipfile.BadZipFile:
            return jsonify({"error": "不是有效的 zip 包"}), 400
        # 校验无绝对路径 / 目录穿越
        names = zf.namelist()
        for n in names:
            norm = n.replace("\\", "/")
            if norm.startswith("/") or ".." in norm.split("/"):
                zf.close()
                return jsonify({"error": "插件包包含非法路径"}), 400
        zf.extractall(tmp)
        zf.close()
        # 定位 plugin.json（允许根目录直接是插件文件，或嵌套一层目录）
        top = ""
        for n in sorted(os.listdir(tmp)):
            if os.path.isfile(os.path.join(tmp, n, "plugin.json")):
                top = n
                break
        mpath = os.path.join(tmp, top, "plugin.json")
        if not os.path.isfile(mpath):
            return jsonify({"error": "插件包缺少 plugin.json"}), 400
        try:
            meta = json.load(open(mpath, encoding="utf-8"))
        except Exception as e:
            return jsonify({"error": "plugin.json 解析失败：" + str(e)}), 400
        pid = str(meta.get("id", "")).strip()
        if not _ID_RE.match(pid):
            return jsonify({"error": "plugin.json 的 id 非法（仅限字母数字 _ -，1-64 位）"}), 400
        src = os.path.join(tmp, top) if top else tmp
        dest = _plugin_dir(pid)
        if os.path.islink(dest) or os.path.exists(dest):
            _remove_path(dest)
        shutil.copytree(src, dest)
        # 规范化 manifest
        meta.setdefault("name", pid)
        meta.setdefault("enabled", True)
        meta["installed"] = True
        _save_meta(pid, meta)
        _registry_record("install", meta)
        return jsonify({"success": True, "plugin": meta})
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@bp.route("/api/plugins/<pid>/toggle", methods=["POST"])
def toggle_plugin(pid):
    if not _ID_RE.match(pid):
        return jsonify({"error": "非法插件 id"}), 400
    meta = _load_meta(pid)
    if meta is None:
        return jsonify({"error": "插件不存在"}), 404
    body = request.get_json(silent=True) or {}
    meta["enabled"] = bool(body.get("enabled", not meta.get("enabled", True)))
    _save_meta(pid, meta)
    return jsonify({"success": True, "enabled": meta["enabled"]})


@bp.route("/api/plugins/<pid>/uninstall", methods=["POST"])
def uninstall_plugin(pid):
    if not _ID_RE.match(pid):
        return jsonify({"error": "非法插件 id"}), 400
    dest = _plugin_dir(pid)
    if not os.path.islink(dest) and not os.path.exists(dest):
        return jsonify({"error": "插件不存在"}), 404
    # 卸载前先取元数据（删除后无法再读），用于登记簿记录
    meta = _load_meta(pid) or {}
    try:
        _remove_path(dest)          # 一并删除插件目录（兼容软链接 / 普通目录）
    except Exception as e:
        return jsonify({"error": "卸载失败：" + str(e)}), 500
    _registry_record("uninstall", {"id": pid, "name": meta.get("name", pid), "version": meta.get("version", "0.0.0")})
    return jsonify({"success": True})


@bp.route("/api/plugins/<pid>/main.js")
def serve_main(pid):
    if not _ID_RE.match(pid):
        return jsonify({"error": "非法插件 id"}), 400
    meta = _load_meta(pid)
    if meta is None:
        return jsonify({"error": "插件不存在"}), 404
    if not meta.get("enabled", True):
        return jsonify({"error": "插件已禁用"}), 403
    main = str(meta.get("main", "main.js")).strip()
    if not main or "/" in main or "\\" in main or main.startswith("."):
        return jsonify({"error": "main 字段非法"}), 400
    base = os.path.normpath(_plugin_dir(pid))
    mpath = os.path.normpath(os.path.join(base, main))
    if not (mpath == base or mpath.startswith(base + os.sep)):
        return jsonify({"error": "入口路径非法"}), 400
    if not os.path.isfile(mpath):
        return jsonify({"error": "入口文件缺失：" + main}), 404
    return send_file(mpath, mimetype="application/javascript", conditional=True)


@bp.route("/api/plugins/<pid>/asset/<path:filename>", methods=["GET"])
def serve_asset(pid, filename):
    """提供插件内的静态资源（index.html / style.css / 图片等）。

    用于插件以 index.html + css 渲染富页面（宿主以 iframe 加载）。
    路径受 send_from_directory 的穿越防护约束，只能取插件目录内的文件。
    """
    if not _ID_RE.match(pid):
        return jsonify({"error": "非法插件 id"}), 400
    meta = _load_meta(pid)
    if meta is None:
        return jsonify({"error": "插件不存在"}), 404
    base = os.path.normpath(_plugin_dir(pid))
    try:
        return send_from_directory(base, filename)
    except Exception:
        return jsonify({"error": "资源不存在"}), 404


@bp.route("/api/plugins/fs/read", methods=["POST"])
def fs_read():
    data = request.get_json(silent=True) or {}
    path = str(data.get("path", "")).strip()
    if not path:
        return jsonify({"error": "未指定路径"}), 400
    fp = os.path.abspath(os.path.normpath(path))
    if not os.path.isfile(fp):
        return jsonify({"error": "文件不存在"}), 404
    try:
        with open(fp, encoding="utf-8", errors="replace") as fh:
            content = fh.read()
    except Exception as e:
        return jsonify({"error": "读取失败：" + str(e)}), 400
    return jsonify({"success": True, "path": fp, "content": content})


@bp.route("/api/plugins/fs/write", methods=["POST"])
def fs_write():
    data = request.get_json(silent=True) or {}
    path = str(data.get("path", "")).strip()
    content = data.get("content", "")
    if not path:
        return jsonify({"error": "未指定路径"}), 400
    fp = os.path.abspath(os.path.normpath(path))
    try:
        parent = os.path.dirname(fp)
        if parent and not os.path.isdir(parent):
            os.makedirs(parent, exist_ok=True)
        if os.path.isdir(fp):
            return jsonify({"error": "目标已是目录"}), 400
        with open(fp, "w", encoding="utf-8") as fh:
            fh.write(content)
    except Exception as e:
        return jsonify({"error": "写入失败：" + str(e)}), 500
    return jsonify({"success": True, "path": fp})


@bp.route("/api/plugins/http", methods=["POST"])
def http_proxy():
    """供插件请求「其他网站 / 第三方接口」的服务端转发。

    两种用法（对应前端 IDE.api.direct / IDE.api.proxy）：
      - 不代理：proxy 留空 → 由本服务直接发起请求（绕开浏览器 CORS）。
      - 走代理：proxy 传地址（如 http://127.0.0.1:7890）→ 经由该代理访问目标。

    body: { url, method?, headers?, body?, proxy? }
    返回: { success, status, headers, text } 或 { error }（带状态码）
    """
    data = request.get_json(silent=True) or {}
    url = str(data.get("url", "")).strip()
    if not url:
        return jsonify({"error": "未指定 url"}), 400
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("http", "https"):
        return jsonify({"error": "仅支持 http/https"}), 400

    method = str(data.get("method", "GET")).upper()
    headers = data.get("headers") or {}
    if not isinstance(headers, dict):
        headers = {}
    raw_body = data.get("body")
    body_bytes = None
    if raw_body is not None:
        body_bytes = raw_body.encode("utf-8") if isinstance(raw_body, str) else raw_body

    proxy = str(data.get("proxy", "")).strip()
    handlers = []
    if proxy:
        # 走代理：http 与 https 目标都经由该代理
        handlers.append(urllib.request.ProxyHandler({"http": proxy, "https": proxy}))
    # 不传 ProxyHandler 时 urllib 不会读取环境代理变量 → 真正的「直连」
    handlers.append(urllib.request.HTTPHandler())
    handlers.append(urllib.request.HTTPSHandler())
    opener = urllib.request.build_opener(*handlers)

    req = urllib.request.Request(url, data=body_bytes, method=method, headers=dict(headers))
    try:
        resp = opener.open(req, timeout=20)
        charset = resp.headers.get_content_charset() or "utf-8"
        text = resp.read().decode(charset, errors="replace")
        return jsonify({"success": True, "status": resp.status,
                        "headers": dict(resp.headers), "text": text})
    except urllib.error.HTTPError as e:
        charset = (e.headers.get_content_charset() or "utf-8") if e.headers else "utf-8"
        text = e.read().decode(charset, errors="replace") if e.headers else ""
        return jsonify({"success": False, "status": e.code,
                        "error": "HTTP " + str(e.code), "text": text}), e.code
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 502




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
import json
import os
import re
import shutil
import tempfile
import zipfile

from flask import Blueprint, request, jsonify, send_file

from ... import config
from ...log import get_logger

_log = get_logger()

bp = Blueprint("plugins", __name__)

PLUGINS_DIR = os.path.join(config.DATA_ROOT, "plugins")
os.makedirs(PLUGINS_DIR, exist_ok=True)

_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def _plugin_dir(pid):
    return os.path.join(PLUGINS_DIR, pid)


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
        if os.path.isdir(dest):
            shutil.rmtree(dest)
        shutil.copytree(src, dest)
        # 规范化 manifest
        meta.setdefault("name", pid)
        meta.setdefault("enabled", True)
        meta["installed"] = True
        _save_meta(pid, meta)
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
    if not os.path.isdir(dest):
        return jsonify({"error": "插件不存在"}), 404
    shutil.rmtree(dest, ignore_errors=True)
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

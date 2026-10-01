"""requirements.txt 与独立 venv 的依赖检查 / 一键安装接口。

POST /api/pip/check  {path, content?}
    检测 requirements.txt 每行对应的包在当前独立 venv 中是否已安装。
    返回：venv 路径、已安装列表、缺失列表、每行状态等。

POST /api/pip/install {path, packages?, all_missing?}
    在检测到的 venv 中安装指定包，或一键安装所有缺失包。
"""
import json
import os
import re
import subprocess

from flask import Blueprint, request, jsonify

from ... import config
from ...log import get_logger


_log = get_logger()
bp = Blueprint("pip", __name__)

# venv 目录候选名（按优先级）
_VENV_NAMES = (".venv", "venv", ".env", "env")

# 内置 PyPI 镜像源（key -> URL）
_PIP_INDEX_URLS = {
    "tsinghua": "https://pypi.tuna.tsinghua.edu.cn/simple",
    "aliyun": "https://mirrors.aliyun.com/pypi/simple/",
    "douban": "https://pypi.doubanio.com/simple/",
    "ustc": "https://pypi.mirrors.ustc.edu.cn/simple/",
    "tencent": "https://mirrors.cloud.tencent.com/pypi/simple/",
    "huawei": "https://repo.huaweicloud.com/repository/pypi/simple/",
    "pypi": "https://pypi.org/simple/",
}

# 合法包名正则（PEP 503 归一化前）
_PKG_NAME_RE = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$")


def _exec_allowed() -> bool:
    return bool(getattr(config, "ENABLE_EXEC", True))


def _find_venv(req_path: str):
    """从 requirements.txt 所在目录向上查找独立 venv，返回其绝对路径或 None。"""
    d = os.path.dirname(os.path.abspath(req_path))
    prev = None
    while d and d != prev:
        for name in _VENV_NAMES:
            venv = os.path.join(d, name)
            if os.path.isdir(venv):
                py = _venv_python(venv)
                if py and os.path.isfile(py):
                    return os.path.abspath(venv)
        prev = d
        d = os.path.dirname(d)
    return None


def _venv_python(venv: str) -> str:
    if os.name == "nt":
        return os.path.join(venv, "Scripts", "python.exe")
    return os.path.join(venv, "bin", "python")


def _pip_cmd(venv: str) -> list:
    """优先用 venv 的 python -m pip，避免系统 pip 干扰。"""
    return [_venv_python(venv), "-m", "pip"]


def _parse_pkg_name(line: str):
    """从 requirements.txt 的一行中解析包名与规格。
    返回 (name, spec) 或 (None, None)。"""
    line = line.strip()
    if not line or line.startswith("#"):
        return None, None
    # 跳过选项、URL、可编辑安装等
    if line.startswith(("-", "--", "http://", "https://", "git+", "hg+", "svn+")):
        return None, None
    # 取第一个 token 作为“包名[额外依赖]规格”
    token = line.split()[0].strip()
    if not token:
        return None, None
    # 包名 + 可选 extras + 可选版本规格（PEP 508 简化版）
    m = re.match(
        r"^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)"
        r"(?:\[.*?\])?"
        r"\s*((?:==|!=|<=|>=|<|>|~=|===|=).*)?$",
        token,
    )
    if not m:
        return None, None
    name = m.group(1).strip()
    spec = (m.group(2) or "").strip()
    if not _PKG_NAME_RE.match(name):
        return None, None
    return name, spec


def _pip_list(venv: str):
    """返回 {归一化包名: 版本}，失败返回 None。"""
    try:
        proc = subprocess.run(
            _pip_cmd(venv) + ["list", "--format=json"],
            capture_output=True, text=True, timeout=30,
            check=False,
        )
        if proc.returncode != 0:
            _log.warning("pip list failed: %s", proc.stderr[:500])
            return None
        data = json.loads(proc.stdout or "[]")
        return {item["name"].lower().replace("-", "_").replace(".", "_"): item["version"]
                for item in data if isinstance(item, dict) and item.get("name")}
    except Exception as e:
        _log.warning("pip list error: %s", e)
        return None


def _check_items(venv: str, content: str):
    installed = _pip_list(venv) or {}
    items = []
    installed_count = 0
    missing_count = 0
    for idx, raw in enumerate(content.splitlines()):
        name, spec = _parse_pkg_name(raw)
        if name is None:
            items.append({"line": idx, "type": "skip", "text": raw})
            continue
        norm = name.lower().replace("-", "_").replace(".", "_")
        ver = installed.get(norm)
        is_installed = ver is not None
        if is_installed:
            installed_count += 1
        else:
            missing_count += 1
        items.append({
            "line": idx,
            "type": "req",
            "name": name,
            "spec": spec,
            "text": raw,
            "installed": is_installed,
            "version": ver,
        })
    return items, installed_count, missing_count


@bp.route("/api/pip/check", methods=["POST"])
def api_pip_check():
    if not _exec_allowed():
        return jsonify({"error": "已禁用命令执行（config.ENABLE_EXEC = False）"}), 403

    data = request.get_json(silent=True) or {}
    path = (data.get("path") or "").strip()
    if not path or os.path.basename(path).lower() != "requirements.txt":
        return jsonify({"error": "仅支持 requirements.txt"}), 400
    if not os.path.isfile(path):
        return jsonify({"error": "文件不存在"}), 404

    content = data.get("content")
    if content is None or not isinstance(content, str):
        try:
            with open(path, "r", encoding="utf-8") as f:
                content = f.read()
        except Exception as e:
            return jsonify({"error": f"读取文件失败：{e}"}), 500

    venv = _find_venv(path)
    if not venv:
        return jsonify({"error": "未找到独立 venv（请在 requirements.txt 同级或上级目录创建 .venv/venv）"}), 404

    items, installed_count, missing_count = _check_items(venv, content)
    return jsonify({
        "ok": True,
        "venv": venv,
        "python": _venv_python(venv),
        "installed_count": installed_count,
        "missing_count": missing_count,
        "items": items,
    })


@bp.route("/api/pip/install", methods=["POST"])
def api_pip_install():
    if not _exec_allowed():
        return jsonify({"error": "已禁用命令执行（config.ENABLE_EXEC = False）"}), 403

    data = request.get_json(silent=True) or {}
    path = (data.get("path") or "").strip()
    if not path or os.path.basename(path).lower() != "requirements.txt":
        return jsonify({"error": "仅支持 requirements.txt"}), 400
    if not os.path.isfile(path):
        return jsonify({"error": "文件不存在"}), 404

    venv = _find_venv(path)
    if not venv:
        return jsonify({"error": "未找到独立 venv"}), 404

    packages = data.get("packages")
    all_missing = bool(data.get("all_missing"))
    index_key = (data.get("index") or "").strip()
    index_url = _PIP_INDEX_URLS.get(index_key)
    if index_key and index_url is None:
        return jsonify({"error": f"不支持的镜像源：{index_key}"}), 400

    cmd = _pip_cmd(venv)
    cmd.append("install")
    if index_url:
        cmd += ["--index-url", index_url]
    if isinstance(packages, list) and packages:
        # 简单校验每个包名
        cleaned = []
        for p in packages:
            n = str(p).strip()
            if not n:
                continue
            # 只保留包名与简单规格字符，拒绝 shell 元字符
            if re.search(r"[;&|`$()\n\r]", n):
                return jsonify({"error": f"非法包名：{n}"}), 400
            cleaned.append(n)
        if not cleaned:
            return jsonify({"error": "缺少要安装的包"}), 400
        cmd += cleaned
    elif all_missing:
        cmd += ["-r", path]
    else:
        return jsonify({"error": "缺少 packages 或 all_missing 参数"}), 400

    _log.info("pip install: %s", " ".join(cmd))
    try:
        proc = subprocess.run(
            cmd, capture_output=True, text=True,
            timeout=300, check=False,
            cwd=os.path.dirname(path),
        )
        return jsonify({
            "ok": proc.returncode == 0,
            "returncode": proc.returncode,
            "stdout": proc.stdout,
            "stderr": proc.stderr,
        })
    except subprocess.TimeoutExpired:
        return jsonify({"ok": False, "error": "安装超时（300 秒）"}), 504
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500

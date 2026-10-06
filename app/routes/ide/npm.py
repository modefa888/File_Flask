"""package.json 与 node_modules 的依赖检查 / 一键安装接口。

POST /api/npm/check   {path}
    读取 package.json 的 dependencies / devDependencies 等，检查 node_modules 下是否已装。
    返回：项目根目录、已装/缺失统计、每个依赖的状态与版本。

POST /api/npm/install {path, packages?, all_missing?, registry?}
    在 package.json 所在目录执行 npm install；可只装指定包，或不带包名装全部缺失依赖。
"""
import json
import os
import re
import shutil
import subprocess

from flask import Blueprint, request, jsonify

from ... import config
from ...log import get_logger


_log = get_logger()
bp = Blueprint("npm", __name__)

# 内置 npm 镜像源（key -> registry）
_NPM_REGISTRIES = {
    "npm": "https://registry.npmjs.org/",
    "npmmirror": "https://registry.npmmirror.com/",
    "tencent": "https://mirrors.cloud.tencent.com/npm/",
    "huawei": "https://repo.huaweicloud.com/repository/npm/",
}

# 包名规则：允许 @scope/name、字母数字与 . _ - （不含 shell 元字符）
_PKG_NAME_RE = re.compile(r"^(?:@[A-Za-z0-9][A-Za-z0-9._-]*/)?[A-Za-z0-9][A-Za-z0-9._-]*$")

_MAX_DEPS = 300                  # 参与检查的依赖数上限，避免超大 package.json 拖慢
_INSTALL_TIMEOUT = 600           # npm install 最长执行秒数


def _exec_allowed() -> bool:
    return bool(getattr(config, "ENABLE_EXEC", True))


def _find_npm() -> str:
    """定位 npm 可执行文件（Windows 下是 npm.cmd），找不到返回空串。

    先查 PATH；再兜底扫 nvm 与常见安装目录 —— 服务进程往往不是从带 node 的
    shell 启动的，PATH 里没有 npm，但机器上其实装了（nvm 布局尤其常见）。
    """
    names = ("npm.cmd", "npm") if os.name == "nt" else ("npm",)
    for n in names:
        p = shutil.which(n)
        if p:
            return p

    home = os.path.expanduser("~")
    cands = []
    for nvm_root in (os.path.join(home, ".nvm", "versions", "node"),
                     os.path.join(home, ".config", "nvm", "versions", "node")):
        if os.path.isdir(nvm_root):
            try:
                versions = sorted(os.listdir(nvm_root), reverse=True)
            except OSError:
                versions = []
            for v in versions:
                cands.append(os.path.join(nvm_root, v, "bin", "npm"))
    if os.name == "nt":
        for base in (os.environ.get("ProgramFiles") or "", os.environ.get("ProgramFiles(x86)") or ""):
            if base:
                cands.append(os.path.join(base, "nodejs", "npm.cmd"))
    else:
        cands += ["/usr/local/bin/npm", "/usr/bin/npm", "/opt/node/bin/npm"]
    for p in cands:
        if p and os.path.isfile(p) and os.access(p, os.X_OK):
            return p
    return ""


def _npm_env(npm_path: str) -> dict:
    """构造执行 npm 用的环境变量：把 npm 所在目录（即 node 所在目录）前置到 PATH。

    npm 脚本的 shebang 是 #!/usr/bin/env node —— 只把 npm 的绝对路径交给 subprocess
    还不够，子进程 PATH 里找不到 node 时会直接报「/usr/bin/env: node: 没有那个文件或目录」。
    nvm 这类「node 不在系统 PATH」的环境尤其会踩到。
    """
    env = dict(os.environ)
    d = os.path.dirname(os.path.abspath(npm_path))
    env["PATH"] = d + os.pathsep + env.get("PATH", "")
    return env


def _read_package_json(path: str):
    """读取 package.json，返回 (data, error)。"""
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except json.JSONDecodeError as e:
        return None, f"package.json 格式有误：{e}"
    except Exception as e:
        return None, f"读取失败：{e}"
    if not isinstance(data, dict):
        return None, "package.json 的内容不是对象"
    return data, ""


def _collect_deps(data: dict) -> list:
    """收集依赖：dependencies 优先，其余依次补充，同名只算一次。"""
    out, seen = [], set()
    for key in ("dependencies", "devDependencies", "peerDependencies", "optionalDependencies"):
        block = data.get(key)
        if not isinstance(block, dict):
            continue
        for name, spec in block.items():
            name = str(name).strip()
            if not name or name in seen:
                continue
            seen.add(name)
            out.append({"name": name, "spec": str(spec if spec is not None else ""),
                        "kind": key, "dev": key == "devDependencies"})
            if len(out) >= _MAX_DEPS:
                return out
    return out


def _installed_version(nm_dir: str, name: str):
    """node_modules/<name>/package.json 中的版本号；未安装返回 None。"""
    pj = os.path.join(nm_dir, name, "package.json")
    if not os.path.isfile(pj):
        return None
    try:
        with open(pj, "r", encoding="utf-8") as fh:
            return str(json.load(fh).get("version") or "")
    except Exception:
        return ""          # 目录在但 package.json 坏了，仍算「已安装」


@bp.route("/api/npm/check", methods=["POST"])
def api_npm_check():
    """检查 package.json 里的依赖在 node_modules 下是否已安装。"""
    data = request.get_json(silent=True) or {}
    path = (data.get("path") or "").strip()
    if not path or os.path.basename(path).lower() != "package.json":
        return jsonify({"error": "仅支持 package.json"}), 400
    if not os.path.isfile(path):
        return jsonify({"error": "文件不存在"}), 404

    pkg, err = _read_package_json(path)
    if err:
        return jsonify({"error": err}), 400

    root = os.path.dirname(os.path.abspath(path))
    nm = os.path.join(root, "node_modules")
    items = []
    for d in _collect_deps(pkg):
        ver = _installed_version(nm, d["name"])
        items.append({**d, "installed": ver is not None, "version": ver or ""})
    installed = sum(1 for it in items if it["installed"])
    npm = _find_npm()
    return jsonify({
        "name": str(pkg.get("name") or os.path.basename(root)),
        "root": root,
        "node_modules": nm,
        "has_node_modules": os.path.isdir(nm),
        "npm": npm,
        "npm_ok": bool(npm),
        "items": items,
        "total": len(items),
        "installed": installed,
        "missing": len(items) - installed,
    })


@bp.route("/api/npm/install", methods=["POST"])
def api_npm_install():
    """安装依赖：可只装指定包，或不带包名（all_missing）按 package.json 装全部。"""
    if not _exec_allowed():
        return jsonify({"error": "已禁用命令执行（config.ENABLE_EXEC = False）"}), 403

    data = request.get_json(silent=True) or {}
    path = (data.get("path") or "").strip()
    if not path or os.path.basename(path).lower() != "package.json":
        return jsonify({"error": "仅支持 package.json"}), 400
    if not os.path.isfile(path):
        return jsonify({"error": "文件不存在"}), 404

    npm = _find_npm()
    if not npm:
        return jsonify({"error": "未找到 npm：请先安装 Node.js 并确保它在 PATH 中"}), 404

    reg_key = (data.get("registry") or "").strip()
    registry = _NPM_REGISTRIES.get(reg_key)
    if reg_key and registry is None:
        return jsonify({"error": f"不支持的镜像源：{reg_key}"}), 400

    cmd = [npm, "install"]
    if registry:
        cmd += ["--registry", registry]

    packages = data.get("packages")
    if isinstance(packages, list) and packages:
        cleaned = []
        for p in packages:
            n = str(p).strip()
            if not n:
                continue
            if not _PKG_NAME_RE.match(n):
                return jsonify({"error": f"非法包名：{n}"}), 400
            cleaned.append(n)
        if not cleaned:
            return jsonify({"error": "缺少要安装的包"}), 400
        cmd += cleaned
    elif data.get("all_missing"):
        cmd += []                      # 不带包名 = 按 package.json 安装全部依赖
    else:
        return jsonify({"error": "缺少 packages 或 all_missing 参数"}), 400

    cwd = os.path.dirname(os.path.abspath(path))
    _log.info("npm install: %s（cwd=%s）", " ".join(cmd), cwd)
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, check=False,
                              timeout=_INSTALL_TIMEOUT, cwd=cwd, env=_npm_env(npm))
    except subprocess.TimeoutExpired:
        return jsonify({"error": f"安装超时（超过 {_INSTALL_TIMEOUT // 60} 分钟）"}), 504
    except Exception as e:
        return jsonify({"error": f"执行失败：{str(e)}"}), 500

    return jsonify({
        "ok": proc.returncode == 0,
        "returncode": proc.returncode,
        "stdout": (proc.stdout or "")[-8000:],
        "stderr": (proc.stderr or "")[-8000:],
    })

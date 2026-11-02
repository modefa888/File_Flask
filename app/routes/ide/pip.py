"""requirements.txt 与独立 venv 的依赖检查 / 一键安装接口。

POST /api/pip/check  {path, content?}
    检测 requirements.txt 每行对应的包在当前独立 venv 中是否已安装。
    返回：venv 路径、已安装列表、缺失列表、每行状态等。

POST /api/pip/install {path, packages?, all_missing?, sync_req?}
    在检测到的 venv 中安装指定包，或一键安装所有缺失包。
    sync_req=true 时安装成功后把「包==实际版本」写回 requirements.txt 并返回新 content。

以下为包管理器浮层（requirements.txt 工具栏 🔍）使用：
POST /api/pip/search    {q, index}          关键词搜索 PyPI（搜索页 + 精确包详情）
POST /api/pip/installed {path}              venv 已安装包列表（含版本）
POST /api/pip/latest    {names, index}      批量查 PyPI 最新版本（判断「已是最新」）
POST /api/pip/upgrade   {path, packages, index}    升级并同步 requirements.txt（返回实际新版本）
POST /api/pip/uninstall {path, packages}    卸载并从 requirements.txt 移除对应行
POST /api/pip/download  {path, packages, index}    pip download 到 pip_downloads/ 目录
"""
import difflib
import json
import os
import re
import subprocess
import tempfile
import threading
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

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
    full = _pip_list_full(venv)
    if full is None:
        return None
    return {_norm(item["name"]): item["version"] for item in full}


def _pip_list_full(venv: str):
    """返回 [{name, version}]（保留原始包名大小写），失败返回 None。"""
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
        return [{"name": item["name"], "version": item.get("version", "")}
                for item in data if isinstance(item, dict) and item.get("name")]
    except Exception as e:
        _log.warning("pip list error: %s", e)
        return None


def _norm(name: str) -> str:
    return (name or "").lower().replace("-", "_").replace(".", "_")


def _pkg_name_of(spec: str):
    """从 'requests>=2.0' 之类的安装规格中取纯包名。"""
    m = re.match(r"^([A-Za-z0-9][A-Za-z0-9._-]*)", str(spec or "").strip())
    return m.group(1) if m else None


def _clean_packages(packages):
    """校验包名列表：返回 (cleaned, None) 或 (None, 错误信息)。"""
    cleaned = []
    for p in packages or []:
        n = str(p).strip()
        if not n:
            continue
        if re.search(r"[;&|`$()\n\r]", n):
            return None, f"非法包名：{n}"
        cleaned.append(n)
    return cleaned, None


def _index_args(index_key: str):
    url = _PIP_INDEX_URLS.get((index_key or "").strip())
    return ["--index-url", url] if url else []


def _rewrite_req(content: str, updates: dict):
    """按 updates 改写 requirements.txt 文本。
    updates: {归一化包名: {"name": 展示名, "version": 版本} 或 None(移除该行)}。
    已存在的行 → 把版本规格改成 ==新版本；不存在的 → 文件末尾追加；version 为 None → 整行移除。
    返回 (新content, 是否有变化)。"""
    seen = set()
    out = []
    for raw in content.splitlines():
        name, _spec = _parse_pkg_name(raw)
        key = _norm(name) if name else None
        if key is not None and key in updates:
            seen.add(key)
            upd = updates[key]
            if upd is None:
                continue                       # 卸载：整行移除
            m = re.match(r"^(\s*)(\S+?)(\s*(?:#.*)?)$", raw)
            indent = m.group(1) if m else ""
            tail = (m.group(3) or "") if m else ""
            out.append(f"{indent}{upd['name']}=={upd['version']}{tail}")
        else:
            out.append(raw)
    appends = [(k, v) for k, v in updates.items() if k not in seen and v]
    if appends:
        if out and out[-1].strip():
            out.append("")
        for _k, v in appends:
            out.append(f"{v['name']}=={v['version']}")
    new = "\n".join(out)
    if appends or content.endswith("\n"):
        new += "\n"
    return new, new != content


def _read_req(path: str) -> str:
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def _write_req(path: str, content: str):
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)


def _sync_req_lines(path: str, packages, updates_map):
    """把 packages 对应行的版本同步进 requirements.txt，返回新内容；失败返回 None。"""
    try:
        content = _read_req(path)
        new, changed = _rewrite_req(content, updates_map)
        if changed:
            _write_req(path, new)
        return new
    except Exception as e:
        _log.warning("requirements.txt 同步失败: %s", e)
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
    cleaned = []
    if isinstance(packages, list) and packages:
        # 简单校验每个包名：只保留包名与简单规格字符，拒绝 shell 元字符
        cleaned, err = _clean_packages(packages)
        if err:
            return jsonify({"error": err}), 400
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
            timeout=600, check=False,
            cwd=os.path.dirname(path),
        )
        resp = {
            "ok": proc.returncode == 0,
            "returncode": proc.returncode,
            "stdout": proc.stdout,
            "stderr": proc.stderr,
        }
        # sync_req：安装成功后把「包==实际安装版本」写回 requirements.txt（浮层安装用）
        if resp["ok"] and data.get("sync_req") and cleaned:
            lst = _pip_list(venv) or {}
            updates = {}
            for p in cleaned:
                n = _pkg_name_of(p)
                v = lst.get(_norm(n)) if n else None
                if n and v:
                    updates[_norm(n)] = {"name": n, "version": v}
            if updates:
                content = _sync_req_lines(path, cleaned, updates)
                if content is not None:
                    resp["content"] = content
                resp["versions"] = {k: v["version"] for k, v in updates.items()}
                for k, v in resp["versions"].items():
                    _latest_cache[k] = (time.time(), v)
        return jsonify(resp)
    except subprocess.TimeoutExpired:
        return jsonify({"ok": False, "error": "安装超时（600 秒）"}), 504
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


# ---------------- 包管理器浮层（搜索 / 已安装 / 升级 / 卸载 / 下载） ----------------

_UA = {"User-Agent": "Mozilla/5.0 (compatible; file-flask-ide/1.0)"}

# 支持 /pypi/<pkg>/json 的镜像；不在这张表里的源一律回落 PyPI 官方 JSON API
_JSON_API_HOSTS = {
    "tsinghua": "https://pypi.tuna.tsinghua.edu.cn",
}

def _fetch_json(url: str, timeout: int = 10):
    req = urllib.request.Request(url, headers=_UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


def _pypi_json(pkg: str, index_key: str):
    """包详情（最新版本 / 简介 / 主页）。镜像 JSON API 优先，失败回落官方。"""
    hosts = []
    h = _JSON_API_HOSTS.get((index_key or "").strip())
    if h:
        hosts.append(h)
    if "https://pypi.org" not in hosts:
        hosts.append("https://pypi.org")
    for host in hosts:
        try:
            return _fetch_json(host + "/pypi/" + urllib.parse.quote(pkg) + "/json", 10)
        except Exception:
            continue
    return None


def _pkg_meta(pkg: str, index_key: str):
    """把一个包的详情整理成前端要的字段；查不到也要返回最小结构（能安装）。"""
    info = _pypi_json(pkg, index_key)
    if info and isinstance(info.get("info"), dict):
        i = info["info"]
        return {
            "name": i.get("name") or pkg,
            "version": (i.get("version") or "").strip(),
            "summary": re.sub(r"\s+", " ", (i.get("summary") or "")).strip(),
            "requires_python": i.get("requires_python") or "",
            "home": ((i.get("project_urls") or {}).get("Homepage") or i.get("home_page") or ""),
        }
    return {"name": pkg, "version": "", "summary": "", "requires_python": "", "home": ""}


# ---------------- 相似度搜索 ----------------
# PyPI 的 /search/ 页已被 Fastly 的 "Client Challenge" 拦住（返回的是 JS 验证页），
# 而 PyPI 没有公开的搜索 API，所以这里改成：抓「热门包名榜」到本地做模糊匹配。
_TOP_URL = "https://hugovk.github.io/top-pypi-packages/top-pypi-packages-30-days.min.json"
_TOP_TTL = 24 * 3600          # 热门榜缓存 1 天
_top_state = {"ts": 0.0, "names": []}
_top_lock = threading.Lock()

# 拉不到热门榜时的兜底包名（够覆盖最常见的模糊搜索）
_FALLBACK_NAMES = [
    "requests", "numpy", "pandas", "flask", "django", "fastapi", "uvicorn", "pillow",
    "beautifulsoup4", "scrapy", "selenium", "pytest", "sqlalchemy", "redis", "pymysql",
    "psycopg2-binary", "cryptography", "pyyaml", "python-dotenv", "openpyxl", "lxml",
    "matplotlib", "scipy", "scikit-learn", "aiohttp", "httpx", "pydantic", "jinja2",
    "click", "rich", "tqdm", "loguru", "requests-toolbelt", "python-dateutil", "six",
    "certifi", "urllib3", "charset-normalizer", "idna", "packaging", "setuptools", "wheel",
]


def _top_cache_path() -> str:
    return os.path.join(tempfile.gettempdir(), "file_flask_top_pypi.json")


def _top_names():
    """按下载量降序的包名列表；内存 → 磁盘 → 网络，都失败用内置兜底。"""
    with _top_lock:
        now = time.time()
        if _top_state["names"] and (now - _top_state["ts"]) < _TOP_TTL:
            return _top_state["names"]

        names = []
        try:                                   # 磁盘缓存
            with open(_top_cache_path(), "r", encoding="utf-8") as f:
                cached = json.load(f)
            if (now - float(cached.get("ts") or 0)) < _TOP_TTL:
                names = [n for n in (cached.get("names") or []) if isinstance(n, str)]
        except Exception:
            names = []

        if not names:
            try:                               # 网络拉取
                d = _fetch_json(_TOP_URL, 20)
                names = [r.get("project") for r in (d.get("rows") or []) if r.get("project")]
                try:
                    with open(_top_cache_path(), "w", encoding="utf-8") as f:
                        json.dump({"ts": now, "names": names}, f)
                except Exception:
                    pass
            except Exception as e:
                _log.warning("拉取热门包名失败: %s", e)
                names = list(_FALLBACK_NAMES)

        _top_state["names"] = names
        _top_state["ts"] = now
        return names


def _is_subseq(q: str, s: str) -> bool:
    """q 的字符是否按顺序出现在 s 里（requests ⊃ reqs 这种缩写能给个中档分）。"""
    it = iter(s)
    return all(ch in it for ch in q)


def _match_score(q: str, name: str) -> float:
    """相似度打分：完全相等 > 前缀 > 包含 > 缩写子序列 > 拼写相近。0 表示不匹配。"""
    q, n = q.lower(), name.lower()
    if n == q:
        return 1000.0
    if n.startswith(q):
        return 800.0 + 100.0 * len(q) / max(len(n), 1)
    if q in n:
        return 600.0 + 100.0 * len(q) / max(len(n), 1)
    # 子序列匹配要做长度限制，否则 "numoy" 会命中一堆超长包名
    if len(q) >= 3 and len(n) <= len(q) * 2 + 4 and _is_subseq(q, n):
        return 400.0 + 100.0 * len(q) / max(len(n), 1)
    if len(q) >= 4 and abs(len(n) - len(q)) <= 3:   # 拼写错误：numoy → numpy
        r = difflib.SequenceMatcher(None, q, n).ratio()
        if r >= 0.65:
            return 300.0 * r
    return 0.0


def _fuzzy_names(q: str, limit: int = 16):
    """在热门包名里找相似的：先按匹配档位，再按下载量（热门榜顺序），最后按名字长度。"""
    scored = []
    for rank, name in enumerate(_top_names()):
        sc = _match_score(q, name)
        if sc > 0:
            scored.append((int(sc // 100), rank, len(name), name))
    scored.sort(key=lambda x: (-x[0], x[1], x[2], x[3]))
    return [x[3] for x in scored[:limit]]


def _enrich(names, index_key: str, workers: int = 6):
    """并发补全这些包的版本 / 简介，保持传入顺序。"""
    if not names:
        return []
    info = {}
    with ThreadPoolExecutor(max_workers=min(workers, len(names))) as ex:
        futs = {ex.submit(_pkg_meta, n, index_key): n for n in names}
        for fut in as_completed(futs):
            try:
                info[futs[fut]] = fut.result()
            except Exception:
                info[futs[fut]] = None
    return [info.get(n) or {"name": n, "version": "", "summary": "", "requires_python": "", "home": ""}
            for n in names]


def _venv_for(req_path: str):
    venv = _find_venv(req_path)
    if not venv:
        return None, jsonify({"error": "未找到独立 venv（请在 requirements.txt 同级或上级目录创建 .venv/venv）"}), 404
    return venv, None, None


@bp.route("/api/pip/search", methods=["POST"])
def api_pip_search():
    """相似度搜索：精确包优先，再按相似度补一批热门包（带最新版本 / 简介）。"""
    data = request.get_json(silent=True) or {}
    q = (data.get("q") or "").strip()
    if not q or len(q) > 100:
        return jsonify({"error": "请输入要搜索的包名或关键词"}), 400
    index_key = (data.get("index") or "").strip()

    results, seen = [], set()

    def add(item):
        key = (item.get("name") or "").lower()
        if not key or key in seen:
            return
        seen.add(key)
        results.append(item)

    # 1) 包名完全一致：直接命中（不存在则跳过）
    info = _pypi_json(q, index_key)
    if info and isinstance(info.get("info"), dict):
        i = info["info"]
        add({
            "name": i.get("name") or q,
            "version": (i.get("version") or "").strip(),
            "summary": re.sub(r"\s+", " ", (i.get("summary") or "")).strip(),
            "requires_python": i.get("requires_python") or "",
            "home": ((i.get("project_urls") or {}).get("Homepage") or i.get("home_page") or ""),
        })

    # 2) 相似度匹配（req → requests / requests-toolbelt …）
    warn = None
    try:
        names = [n for n in _fuzzy_names(q, 18) if n.lower() not in seen][:12]
    except Exception as e:
        names, warn = [], "相似度搜索不可用（热门包名榜拉取失败）：%s" % e
        _log.warning("相似度搜索失败: %s", e)
    for item in _enrich(names, index_key):
        add(item)

    if not results:
        warn = warn or "没有匹配的包，试试更完整的包名"
    return jsonify({"ok": True, "results": results[:20], "warn": warn})


# venv 自带的基础包（建虚拟环境时装进去的，不是项目依赖）
_VENV_BASE_PKGS = {"pip", "setuptools", "wheel", "pkg_resources", "distribute", "pip_tools"}


def _req_pkg_names(path: str, content=None):
    """requirements.txt 里出现的包名（归一化）。content 为空则读文件。"""
    if content is None:
        try:
            content = _read_req(path)
        except Exception:
            return set()
    out = set()
    for line in str(content).splitlines():
        name, _spec = _parse_pkg_name(line)
        if name:
            out.add(_norm(name))
    return out


@bp.route("/api/pip/installed", methods=["POST"])
def api_pip_installed():
    """当前 venv 已安装的全部包（含版本 + 分组：requirements / venv 自带 / 其他依赖）。"""
    if not _exec_allowed():
        return jsonify({"error": "已禁用命令执行（config.ENABLE_EXEC = False）"}), 403
    data = request.get_json(silent=True) or {}
    path = (data.get("path") or "").strip()
    if not path or os.path.basename(path).lower() != "requirements.txt":
        return jsonify({"error": "仅支持 requirements.txt"}), 400
    if not os.path.isfile(path):
        return jsonify({"error": "文件不存在"}), 404
    venv, err, code = _venv_for(path)
    if err:
        return err, code
    full = _pip_list_full(venv)
    if full is None:
        return jsonify({"error": "读取已安装列表失败"}), 500
    # 用编辑器里（可能还没保存）的内容做分组，和 gutter 的检测口径保持一致
    content = data.get("content")
    pinned = _req_pkg_names(path, content if isinstance(content, str) else None)
    for it in full:
        k = _norm(it["name"])
        it["group"] = "req" if k in pinned else ("base" if k in _VENV_BASE_PKGS else "other")
    full.sort(key=lambda x: x["name"].lower())
    return jsonify({"ok": True, "venv": venv, "items": full,
                    "groups": {"req": len([i for i in full if i["group"] == "req"]),
                               "base": len([i for i in full if i["group"] == "base"]),
                               "other": len([i for i in full if i["group"] == "other"])}})


# 最新版本缓存：{归一化包名: (查询时间戳, 版本)}，避免每刷新一次就打一遍 PyPI
_LATEST_TTL = 600
_LATEST_MAX = 120
_latest_cache = {}

# PEP 691：simple 索引可以直接返回 JSON（带 versions 数组），比解析 HTML 稳
_SIMPLE_ACCEPT = "application/vnd.pypi.simple.v1+json"


def _max_version(versions):
    """从版本列表里取最高的正式版（跳过 rc / dev 之类预发布）。"""
    if not versions:
        return ""
    try:
        from packaging.version import parse as _pv
        best = None
        for v in versions:
            try:
                p = _pv(str(v))
            except Exception:
                continue
            if p.is_prerelease:
                continue
            if best is None or p > best[0]:
                best = (p, str(v))
        if best:
            return best[1]
    except Exception:
        pass
    return str(versions[-1])


def _simple_latest(pkg: str, index_key: str) -> str:
    """从 simple 索引取最新版本。
    注意：镜像的 /pypi/<pkg>/json 经常严重滞后（实测清华 flask 停在 3.0.3），
    而 simple 索引是 pip 安装时真正用的那份，版本最新，所以优先用它。"""
    base = _PIP_INDEX_URLS.get((index_key or "").strip()) or _PIP_INDEX_URLS["pypi"]
    url = base.rstrip("/") + "/" + urllib.parse.quote(pkg, safe="") + "/"
    req = urllib.request.Request(
        url, headers={"User-Agent": _UA["User-Agent"], "Accept": _SIMPLE_ACCEPT})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            ctype = (r.headers.get("Content-Type") or "").lower()
            raw = r.read()
    except Exception:
        return ""

    versions = []
    if "json" in ctype:
        try:
            versions = json.loads(raw.decode("utf-8", "replace")).get("versions") or []
        except Exception:
            versions = []
    if not versions:                     # 老式 HTML 索引：从文件名里抠版本号
        html = raw.decode("utf-8", "replace")
        name_pat = "[-_.]".join(re.escape(p) for p in re.split(r"[-_.]+", pkg) if p)
        pat = re.compile(
            r">" + name_pat + r"-(\d[^<>\-]*?)(?:\.tar\.gz|\.zip|\.whl|\.egg)<", re.I)
        versions = [m.group(1) for m in pat.finditer(html)]
    return _max_version(versions)


def _latest_of(pkg: str, index_key: str) -> str:
    """查单个包在源上的最新版本（带缓存），查不到返回空串。"""
    key = _norm(pkg)
    hit = _latest_cache.get(key)
    if hit and (time.time() - hit[0]) < _LATEST_TTL:
        return hit[1]
    ver = _simple_latest(pkg, index_key)
    if not ver:                          # 兜底：simple 索引取不到时用 JSON API
        info = _pypi_json(pkg, index_key)
        if info and isinstance(info.get("info"), dict):
            ver = (info["info"].get("version") or "").strip()
    if ver:
        _latest_cache[key] = (time.time(), ver)   # 只缓存成功结果，失败下次还能重试
    return ver


@bp.route("/api/pip/latest", methods=["POST"])
def api_pip_latest():
    """批量查询 PyPI 最新版本，「已安装」页据此把已是最新的包置灰。"""
    data = request.get_json(silent=True) or {}
    names = data.get("names")
    if not isinstance(names, list) or not names:
        return jsonify({"error": "缺少 names 参数"}), 400
    cleaned, err = _clean_packages(names[:_LATEST_MAX])
    if err:
        return jsonify({"error": err}), 400
    if not cleaned:
        return jsonify({"ok": True, "latest": {}})

    index_key = (data.get("index") or "").strip()
    out = {}
    # 首次查多个包时并发拉取，8 路足够又不至于被镜像限流
    with ThreadPoolExecutor(max_workers=min(10, len(cleaned))) as ex:
        futs = {ex.submit(_latest_of, n, index_key): n for n in cleaned}
        for fut in as_completed(futs):
            name = futs[fut]
            try:
                ver = fut.result()
            except Exception:
                ver = ""
            if ver:
                out[_norm(name)] = ver
    return jsonify({"ok": True, "latest": out})


@bp.route("/api/pip/upgrade", methods=["POST"])
def api_pip_upgrade():
    """pip install -U 升级指定包；成功后把 requirements.txt 中对应行同步为实际新版本。"""
    if not _exec_allowed():
        return jsonify({"error": "已禁用命令执行（config.ENABLE_EXEC = False）"}), 403
    data = request.get_json(silent=True) or {}
    path = (data.get("path") or "").strip()
    if not path or os.path.basename(path).lower() != "requirements.txt" or not os.path.isfile(path):
        return jsonify({"error": "仅支持已存在的 requirements.txt"}), 400
    venv, err, code = _venv_for(path)
    if err:
        return err, code
    cleaned, perr = _clean_packages(data.get("packages"))
    if perr:
        return jsonify({"error": perr}), 400
    if not cleaned:
        return jsonify({"error": "缺少要升级的包"}), 400

    cmd = _pip_cmd(venv) + ["install", "-U"] + _index_args(data.get("index")) + cleaned
    _log.info("pip upgrade: %s", " ".join(cmd))
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=600,
                              check=False, cwd=os.path.dirname(path))
        resp = {"ok": proc.returncode == 0, "returncode": proc.returncode,
                "stdout": proc.stdout, "stderr": proc.stderr}
        if resp["ok"]:
            lst = _pip_list(venv) or {}
            updates, versions = {}, {}
            for p in cleaned:
                n = _pkg_name_of(p)
                v = lst.get(_norm(n)) if n else None
                if n and v:
                    updates[_norm(n)] = {"name": n, "version": v}
                    versions[_norm(n)] = v
            if versions:
                # 返回升级后的实际版本：前端据此立即更新行内版本号 / 按钮状态
                resp["versions"] = versions
                for k, v in versions.items():
                    _latest_cache[k] = (time.time(), v)
            if updates:
                content = _sync_req_lines(path, cleaned, updates)
                if content is not None:
                    resp["content"] = content
        return jsonify(resp)
    except subprocess.TimeoutExpired:
        return jsonify({"ok": False, "error": "升级超时（600 秒）"}), 504
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@bp.route("/api/pip/uninstall", methods=["POST"])
def api_pip_uninstall():
    """pip uninstall -y 卸载指定包；成功后从 requirements.txt 移除对应行。"""
    if not _exec_allowed():
        return jsonify({"error": "已禁用命令执行（config.ENABLE_EXEC = False）"}), 403
    data = request.get_json(silent=True) or {}
    path = (data.get("path") or "").strip()
    if not path or os.path.basename(path).lower() != "requirements.txt" or not os.path.isfile(path):
        return jsonify({"error": "仅支持已存在的 requirements.txt"}), 400
    venv, err, code = _venv_for(path)
    if err:
        return err, code
    cleaned, perr = _clean_packages(data.get("packages"))
    if perr:
        return jsonify({"error": perr}), 400
    if not cleaned:
        return jsonify({"error": "缺少要卸载的包"}), 400

    cmd = _pip_cmd(venv) + ["uninstall", "-y"] + [_pkg_name_of(p) or p for p in cleaned]
    _log.info("pip uninstall: %s", " ".join(cmd))
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=300,
                              check=False, cwd=os.path.dirname(path))
        resp = {"ok": proc.returncode == 0, "returncode": proc.returncode,
                "stdout": proc.stdout, "stderr": proc.stderr}
        if resp["ok"]:
            updates = {_norm(_pkg_name_of(p) or p): None for p in cleaned}
            content = _sync_req_lines(path, cleaned, updates)
            if content is not None:
                resp["content"] = content
        return jsonify(resp)
    except subprocess.TimeoutExpired:
        return jsonify({"ok": False, "error": "卸载超时（300 秒）"}), 504
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@bp.route("/api/pip/download", methods=["POST"])
def api_pip_download():
    """pip download --no-deps 把包的 wheel/sdist 下载到 requirements.txt 同级的 pip_downloads/ 目录。"""
    if not _exec_allowed():
        return jsonify({"error": "已禁用命令执行（config.ENABLE_EXEC = False）"}), 403
    data = request.get_json(silent=True) or {}
    path = (data.get("path") or "").strip()
    if not path or os.path.basename(path).lower() != "requirements.txt" or not os.path.isfile(path):
        return jsonify({"error": "仅支持已存在的 requirements.txt"}), 400
    venv, err, code = _venv_for(path)
    if err:
        return err, code
    cleaned, perr = _clean_packages(data.get("packages"))
    if perr:
        return jsonify({"error": perr}), 400
    if not cleaned:
        return jsonify({"error": "缺少要下载的包"}), 400

    dest = os.path.join(os.path.dirname(path), "pip_downloads")
    try:
        os.makedirs(dest, exist_ok=True)
    except Exception as e:
        return jsonify({"error": f"创建下载目录失败：{e}"}), 500

    cmd = _pip_cmd(venv) + ["download", "-d", dest, "--no-deps"] + \
        _index_args(data.get("index")) + cleaned
    _log.info("pip download: %s", " ".join(cmd))
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=600,
                              check=False, cwd=os.path.dirname(path))
        saved = sorted(f for f in os.listdir(dest) if not f.startswith("."))
        return jsonify({
            "ok": proc.returncode == 0,
            "returncode": proc.returncode,
            "dir": dest,
            "files": saved[-20:],
            "stdout": proc.stdout,
            "stderr": proc.stderr,
        })
    except subprocess.TimeoutExpired:
        return jsonify({"ok": False, "error": "下载超时（600 秒）"}), 504
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500

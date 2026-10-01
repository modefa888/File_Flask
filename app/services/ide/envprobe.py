"""运行环境探测与管理。

职责：
- 探测本机已安装的语言运行时 / 包管理器 / 数据库服务 / 常用工具（版本、路径、候选可执行文件）；
- 支持为每个工具指定「自定义可执行文件路径」与「自定义环境变量」，持久化后
  同时作用于「运行当前文件」（/api/run）与内置终端（/api/term/*）；
- 提供少量白名单化的配置操作（切换 npm registry / pip 源 / composer 镜像、创建 venv 等）。

安全说明：
- 探测命令全部来自本文件的 CATALOG，不接受用户输入拼接；
- 配置操作走 TOOL_ACTIONS 白名单，参数经校验后用 argv 列表执行（不经过 shell），
  因此不存在命令注入面；接口也不会执行任意用户命令（那属于终端/运行的职责）。
"""
import json
import os
import platform
import re
import shutil
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor

from ... import config
from ...log import get_logger


_log = get_logger()

# 用户自定义配置（解释器路径 / 环境变量）
_CFG_FILE = os.path.join(config._DATA_ROOT, ".file_flask_env.json")

# 探测结果缓存时间（秒）：面板刷新走缓存，点「重新检测」强制刷新
_PROBE_TTL = 60
_PROBE_TIMEOUT = 4          # 单个 --version 命令超时
_DETAIL_TIMEOUT = 20        # 详情命令超时
_ACTION_TIMEOUT = 120       # 配置操作超时
_MAX_OUTPUT = 8000          # 单项输出上限

_VERSION_RE = re.compile(r"\d+(?:\.\d+){1,3}(?:[-+.][0-9A-Za-z._-]+)?")

_cache = {"ts": 0.0, "data": None}
_cache_lock = threading.Lock()
_cfg_lock = threading.Lock()


# ======================================================================
# 目录表：id / 名称 / 分类 / 图标 / 候选可执行文件 / 版本参数 / 安装提示
# ======================================================================
CATEGORIES = ["语言运行时", "包管理器", "数据库 / 缓存", "Web 服务 / 容器", "常用工具"]

CATALOG = [
    # ---------------- 语言运行时 ----------------
    dict(id="node", label="Node.js", category="语言运行时", icon="bi-hexagon",
         exes=["node"], version_args=["-v"], site="https://nodejs.org",
         hint="Debian/Ubuntu: apt install nodejs npm · 或使用 nvm 安装多版本",
         detail=[["处理版本信息", ["-p", "JSON.stringify(process.versions, null, 2)"]],
                 ["默认模块路径", ["-p", "module.paths.join('\\n')"]],
                 ["npm 前缀", ["-p", "process.execPath"]]],
         tools=[dict(key="registry", title="npm 镜像源", exe="npm",
                     cmd=["config", "set", "registry"],
                     values=[("官方源", "https://registry.npmjs.org"),
                             ("淘宝镜像", "https://registry.npmmirror.com")])]),
    dict(id="python", label="Python", category="语言运行时", icon="bi-filetype-py",
         exes=["python3", "python"], version_args=["--version"], site="https://www.python.org",
         hint="Debian/Ubuntu: apt install python3 python3-pip python3-venv",
         detail=[["解释器路径", ["-c", "import sys; print(sys.executable)"]],
                 ["sys.path", ["-c", "import sys; print('\\n'.join(sys.path))"]],
                 ["已安装包（前 40）", ["-m", "pip", "list", "--format=columns"]],
                 ["虚拟环境支持", ["-c", "import venv, sys; print('venv OK, 版本', sys.version.split()[0])"]]],
         tools=[dict(key="index-url", title="pip 源",
                     cmd=["-m", "pip", "config", "set", "global.index-url"],
                     values=[("官方源", "https://pypi.org/simple"),
                             ("阿里云", "https://mirrors.aliyun.com/pypi/simple/"),
                             ("清华源", "https://pypi.tuna.tsinghua.edu.cn/simple")]),
                dict(key="venv", title="在项目里创建虚拟环境", cmd=["-m", "venv"],
                     arg_placeholder="虚拟环境目录名", arg_default=".venv", in_project=True,
                     note="创建后可用 source .venv/bin/activate 激活")]),
    dict(id="php", label="PHP", category="语言运行时", icon="bi-filetype-php",
         exes=["php"], version_args=["-v"], site="https://www.php.net",
         hint="Debian/Ubuntu: apt install php php-cli php-mbstring",
         detail=[["php.ini 位置", ["--ini"]],
                 ["已加载扩展", ["-m"]],
                 ["已启用配置", ["-i"]]],
         tools=[dict(key="composer-mirror", title="Composer 镜像（阿里云）", exe="composer",
                     cmd=["config", "-g", "repo.packagist", "composer"],
                     fixed="https://mirrors.aliyun.com/composer/",
                     note="需要已安装 composer")]),
    dict(id="java", label="Java (JDK)", category="语言运行时", icon="bi-filetype-java",
         exes=["java"], version_args=["-version"], site="https://adoptium.net",
         hint="Debian/Ubuntu: apt install default-jdk（或安装 Temurin / OpenJDK）",
         detail=[["版本详情", ["-XshowSettings:properties", "-version"]],
                 ["编译器", ["-version"]],
                 ["JAVA_HOME", [], "env:JAVA_HOME"]],
         env_extra=["java", "javac"]),
    dict(id="javac", label="Java 编译器", category="语言运行时", icon="bi-filetype-java",
         exes=["javac"], version_args=["-version"], hint="随 JDK 一同安装"),
    dict(id="go", label="Go", category="语言运行时", icon="bi-braces",
         exes=["go"], version_args=["version"], site="https://go.dev",
         hint="Debian/Ubuntu: apt install golang-go · 或从 go.dev 下载",
         detail=[["go env", ["env"]]]),
    dict(id="ruby", label="Ruby", category="语言运行时", icon="bi-filetype-rb",
         exes=["ruby"], version_args=["-v"], site="https://www.ruby-lang.org",
         hint="Debian/Ubuntu: apt install ruby-full",
         detail=[["gem 环境", ["-e", "puts Gem.dir"]]]),
    dict(id="perl", label="Perl", category="语言运行时", icon="bi-filetype-pl",
         exes=["perl"], version_args=["-v"], hint="Debian/Ubuntu: apt install perl"),
    dict(id="lua", label="Lua", category="语言运行时", icon="bi-braces",
         exes=["lua", "lua5.4", "lua5.3"], version_args=["-v"], hint="Debian/Ubuntu: apt install lua5.4"),
    dict(id="dotnet", label=".NET", category="语言运行时", icon="bi-filetype-cs",
         exes=["dotnet"], version_args=["--list-sdks"], site="https://dotnet.microsoft.com",
         hint="Debian/Ubuntu: apt install dotnet-sdk-8.0"),
    dict(id="rustc", label="Rust", category="语言运行时", icon="bi-braces",
         exes=["rustc"], version_args=["--version"], site="https://www.rust-lang.org",
         hint="安装：curl https://sh.rustup.rs -sSf | sh"),
    dict(id="gcc", label="GCC / G++", category="语言运行时", icon="bi-braces",
         exes=["gcc", "g++"], version_args=["--version"], hint="Debian/Ubuntu: apt install build-essential"),

    # ---------------- 包管理器 ----------------
    dict(id="npm", label="npm", category="包管理器", icon="bi-box-seam", exes=["npm"],
         version_args=["-v"], detail=[["当前 registry", ["config", "get", "registry"]],
                                      ["全局包", ["ls", "-g", "--depth=0"]]]),
    dict(id="yarn", label="Yarn", category="包管理器", icon="bi-box-seam", exes=["yarn"],
         version_args=["-v"], detail=[["当前 registry", ["config", "get", "registry"]]]),
    dict(id="pnpm", label="pnpm", category="包管理器", icon="bi-box-seam", exes=["pnpm"],
         version_args=["-v"], detail=[["当前 registry", ["config", "get", "registry"]]]),
    dict(id="pip", label="pip", category="包管理器", icon="bi-box-seam",
         exes=["pip3", "pip"], version_args=["--version"],
         detail=[["当前 index-url", ["config", "get", "global.index-url"]],
                 ["pip 配置列表", ["config", "list"]]]),
    dict(id="composer", label="Composer", category="包管理器", icon="bi-box-seam",
         exes=["composer"], version_args=["-V"], detail=[["全局配置", ["config", "-g", "--list"]]]),
    dict(id="cargo", label="Cargo", category="包管理器", icon="bi-box-seam", exes=["cargo"],
         version_args=["-V"], detail=[["当前 registry", ["-V"]]]),
    dict(id="gem", label="RubyGems", category="包管理器", icon="bi-box-seam", exes=["gem"],
         version_args=["-v"], detail=[["镜像源", ["sources"]]]),
    dict(id="mvn", label="Maven", category="包管理器", icon="bi-box-seam", exes=["mvn"],
         version_args=["-v"], hint="Debian/Ubuntu: apt install maven"),
    dict(id="gradle", label="Gradle", category="包管理器", icon="bi-box-seam", exes=["gradle"],
         version_args=["-v"], hint="推荐使用项目内的 gradlew"),
    dict(id="uv", label="uv (Python)", category="包管理器", icon="bi-box-seam", exes=["uv"],
         version_args=["--version"], hint="安装：pip install uv 或 curl -LsSf https://astral.sh/uv/install.sh | sh"),

    # ---------------- 数据库 / 缓存 ----------------
    dict(id="mysql", label="MySQL", category="数据库 / 缓存", icon="bi-database",
         exes=["mysql"], version_args=["--version"], hint="Debian/Ubuntu: apt install mysql-server"),
    dict(id="mariadb", label="MariaDB", category="数据库 / 缓存", icon="bi-database",
         exes=["mariadb"], version_args=["--version"], hint="Debian/Ubuntu: apt install mariadb-server"),
    dict(id="psql", label="PostgreSQL", category="数据库 / 缓存", icon="bi-database",
         exes=["psql"], version_args=["--version"], hint="Debian/Ubuntu: apt install postgresql"),
    dict(id="redis", label="Redis", category="数据库 / 缓存", icon="bi-hdd-stack",
         exes=["redis-server"], version_args=["--version"], hint="Debian/Ubuntu: apt install redis-server",
         detail=[["redis-cli 版本", [], None]]),
    dict(id="mongo", label="MongoDB", category="数据库 / 缓存", icon="bi-database",
         exes=["mongod", "mongosh", "mongo"], version_args=["--version"],
         hint="参考 mongodb 官方安装文档"),
    dict(id="sqlite", label="SQLite", category="数据库 / 缓存", icon="bi-database",
         exes=["sqlite3"], version_args=["--version"], hint="Debian/Ubuntu: apt install sqlite3"),

    # ---------------- Web 服务 / 容器 ----------------
    dict(id="nginx", label="Nginx", category="Web 服务 / 容器", icon="bi-server",
         exes=["nginx"], version_args=["-v"], hint="Debian/Ubuntu: apt install nginx"),
    dict(id="apache", label="Apache httpd", category="Web 服务 / 容器", icon="bi-server",
         exes=["apache2", "httpd"], version_args=["-v"], hint="Debian/Ubuntu: apt install apache2"),
    dict(id="docker", label="Docker", category="Web 服务 / 容器", icon="bi-box",
         exes=["docker"], version_args=["--version"], site="https://docs.docker.com/engine/install/",
         hint="安装后需把当前用户加入 docker 组才能免 sudo 使用",
         detail=[["Docker 版本", ["version", "--format", "{{.Server.Version}}"]],
                 ["运行中的容器", ["ps", "--format", "{{.Names}}\\t{{.Image}}\\t{{.Status}}"]]]),
    dict(id="docker-compose", label="Docker Compose", category="Web 服务 / 容器", icon="bi-box",
         exes=["docker-compose", "docker"], version_args=["version", "--short"],
         hint="新版 Docker 已内置：docker compose version"),

    # ---------------- 常用工具 ----------------
    dict(id="git", label="Git", category="常用工具", icon="bi-git", exes=["git"],
         version_args=["--version"], detail=[["用户配置", ["config", "--list", "--show-origin"]]]),
    dict(id="ffmpeg", label="FFmpeg", category="常用工具", icon="bi-film",
         exes=["ffmpeg"], version_args=["-version"], hint="Debian/Ubuntu: apt install ffmpeg"),
    dict(id="curl", label="curl", category="常用工具", icon="bi-cloud", exes=["curl"],
         version_args=["--version"]),
    dict(id="wget", label="wget", category="常用工具", icon="bi-cloud", exes=["wget"],
         version_args=["--version"]),
    dict(id="jq", label="jq", category="常用工具", icon="bi-braces", exes=["jq"],
         version_args=["--version"], hint="Debian/Ubuntu: apt install jq"),
    dict(id="make", label="make", category="常用工具", icon="bi-wrench", exes=["make"],
         version_args=["--version"]),
    dict(id="cmake", label="CMake", category="常用工具", icon="bi-wrench", exes=["cmake"],
         version_args=["--version"]),
    dict(id="rsync", label="rsync", category="常用工具", icon="bi-wrench", exes=["rsync"],
         version_args=["--version"]),
    dict(id="openssl", label="OpenSSL", category="常用工具", icon="bi-shield-lock",
         exes=["openssl"], version_args=["version"]),
    dict(id="tmux", label="tmux", category="常用工具", icon="bi-terminal", exes=["tmux"],
         version_args=["-V"]),
    dict(id="zstd", label="zstd", category="常用工具", icon="bi-file-zip", exes=["zstd"],
         version_args=["--version"]),
]

_CATALOG_BY_ID = {it["id"]: it for it in CATALOG}


# ======================================================================
# 自定义配置（解释器路径 / 环境变量）
# ======================================================================
def load_cfg() -> dict:
    """读取用户自定义配置：{"overrides": {exe: path}, "env": {K: V}}。"""
    with _cfg_lock:
        try:
            with open(_CFG_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, ValueError):
            return {"overrides": {}, "env": {}}
    if not isinstance(data, dict):
        return {"overrides": {}, "env": {}}
    overrides = data.get("overrides") if isinstance(data.get("overrides"), dict) else {}
    env = data.get("env") if isinstance(data.get("env"), dict) else {}
    return {"overrides": {str(k): str(v) for k, v in overrides.items() if v},
            "env": {str(k): str(v) for k, v in env.items()}}


def save_cfg(cfg: dict) -> None:
    payload = {
        "overrides": {str(k): str(v) for k, v in (cfg.get("overrides") or {}).items() if v},
        "env": {str(k): str(v) for k, v in (cfg.get("env") or {}).items()},
        "updated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
    }
    with _cfg_lock:
        tmp = _CFG_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
        os.replace(tmp, _CFG_FILE)


def get_overrides() -> dict:
    return load_cfg()["overrides"]


def custom_env() -> dict:
    """自定义环境变量（供 run / term 注入）。"""
    return load_cfg()["env"]


def _local_bin() -> str:
    """一键安装的软链目录（~/.local/bin）。"""
    return os.path.join(os.path.expanduser("~"), ".local", "bin")


# 常见用户级工具安装目录（nvm / volta / fnm / cargo / go 等不一定在当前 shell 的 PATH 里，
# 例如服务由 systemd / 其它 shell 启动时，就会探测不到这些工具）
_EXTRA_BIN_DIRS = [
    "~/.local/bin",
    "~/.cargo/bin",
    "~/go/bin",
    "~/.volta/bin",
    "~/.bun/bin",
    "~/.local/share/pnpm",
    "~/.pyenv/shims",
    "~/.rbenv/shims",
    "~/.local/share/fnm/aliases/default/bin",
    "/opt/homebrew/bin",
    "/usr/local/bin",
]


def _nvm_roots() -> list:
    """nvm 的安装根目录。

    nvm 不一定装在默认的 ~/.nvm：官方脚本默认是 ~/.nvm，但很多发行版 /
    自定义安装会通过 NVM_DIR 指到别处（例如本机就是 ~/.config/nvm），
    只扫描 ~/.nvm 会出现「明明装了 node 却探测不到」。
    """
    roots = []
    env_dir = os.environ.get("NVM_DIR")
    if env_dir:
        roots.append(env_dir)
    roots += ["~/.nvm", "~/.config/nvm", "/usr/local/nvm", "/opt/nvm"]
    out, seen = [], set()
    for r in roots:
        r = os.path.abspath(os.path.expanduser(r))
        if r not in seen:
            seen.add(r)
            out.append(r)
    return out


def _version_key(v: str) -> list:
    """把 v22.15.0 / 22.15.0 这类版本号转成可比较的元组。"""
    parts = []
    for seg in v.lstrip("v").split("."):
        num = "".join(ch for ch in seg if ch.isdigit())
        parts.append(int(num) if num else 0)
    while len(parts) < 3:
        parts.append(0)
    return parts[:3]


def _nvm_default_alias(root: str) -> str:
    """读取 nvm 的默认版本（alias/default，可能又指向另一个别名）。"""
    name, seen = "default", set()
    for _ in range(5):
        try:
            with open(os.path.join(root, "alias", name), "r", encoding="utf-8") as f:
                val = f.read().strip()
        except OSError:
            return ""
        if not val or val in seen:
            return ""
        seen.add(name)
        if val[:1] == "v" and val[1:2].isdigit():
            return val                       # 形如 v22.15.0
        name = val
    return ""


def _nvm_node_bins() -> list:
    """nvm 管理的 node bin 目录：默认版本优先，其余按版本号从大到小取几个。"""
    out, seen = [], set()
    for root in _nvm_roots():
        base = os.path.join(root, "versions", "node")
        try:
            vers = [d for d in os.listdir(base) if os.path.isdir(os.path.join(base, d))]
        except OSError:
            continue
        if not vers:
            continue
        default = _nvm_default_alias(root)
        ordered = []
        if default in vers:
            vers.remove(default)
            ordered.append(default)
        vers.sort(key=_version_key, reverse=True)
        ordered += vers[:3]
        for v in ordered:
            b = os.path.join(base, v, "bin")
            if os.path.isdir(b) and b not in seen:
                seen.add(b)
                out.append(b)
    return out


def probe_path() -> str:
    """探测/执行用的 PATH：优先用户级目录与一键安装目录，保证装完立即可用也被检测到。"""
    parts = [_local_bin()]
    parts += [os.path.expanduser(d) for d in _EXTRA_BIN_DIRS]
    parts += _nvm_node_bins()
    parts += [p for p in os.environ.get("PATH", "").split(os.pathsep) if p]
    out, seen = [], set()
    for p in parts:
        if p and p not in seen and os.path.isdir(p):
            seen.add(p)
            out.append(p)
    return os.pathsep.join(out) or os.environ.get("PATH", "")


def _exec_ok(path: str) -> str:
    """返回可执行文件的绝对路径；不可用则返回 ""。"""
    if not path:
        return ""
    p = os.path.expanduser(str(path))
    if os.path.isfile(p) and os.access(p, os.X_OK):
        return os.path.abspath(p)
    return ""


def resolve_exe(name: str) -> str:
    """解析可执行文件：优先使用用户自定义路径，其次 PATH。返回绝对路径或 ""。

    自定义路径在配置里以「运行时 id」为键保存（如 python），这里同时兼容
    按可执行文件名（python3）查找，保证 run / term 与面板配置一致。
    """
    overrides = get_overrides()
    # 1) 直接按名字命中自定义路径
    for key in (name, os.path.basename(name)):
        p = _exec_ok(overrides.get(key))
        if p:
            return p
    # 2) 该名字属于某个运行时（或其别名）时，用运行时的自定义路径
    for entry in CATALOG:
        if name in entry["exes"] or entry["id"] == name:
            for key in (entry["id"], *entry["exes"]):
                p = _exec_ok(overrides.get(key))
                if p:
                    return p
            break
    return shutil.which(name, path=probe_path()) or ""


def apply_custom_env(env: dict) -> dict:
    """把自定义环境变量合并进给定 env。

    另外把「自定义解释器路径」所在目录前置到 PATH，这样终端里直接敲
    python3 / node 等命令也会优先命中用户指定的版本。
    """
    for k, v in custom_env().items():
        if k:
            env[str(k)] = str(v)
    dirs = []
    for rid, path in get_overrides().items():
        p = _exec_ok(path)
        if p:
            d = os.path.dirname(p)
            if d and d not in dirs:
                dirs.append(d)
    # 一键安装目录 + 常见用户级工具目录（nvm/volta/cargo/go 等）一并前置，
    # 这样终端里直接敲 node / npm / mvn 也能命中用户自己的版本
    for extra in [_local_bin()] + [os.path.expanduser(d) for d in _EXTRA_BIN_DIRS] + _nvm_node_bins():
        if os.path.isdir(extra) and extra not in dirs:
            dirs.append(extra)
    if dirs:
        old = [p for p in env.get("PATH", os.environ.get("PATH", "")).split(os.pathsep) if p]
        env["PATH"] = os.pathsep.join(dirs + [p for p in old if p not in dirs])
    return env


# ======================================================================
# 探测
# ======================================================================
def _run_cmd(argv, timeout=_PROBE_TIMEOUT, cwd=None, env=None, stdin_null=True):
    """执行命令并返回 (ok, stdout, stderr, code, error)。"""
    try:
        proc = subprocess.run(
            argv, cwd=cwd, timeout=timeout, capture_output=True,
            stdin=subprocess.DEVNULL if stdin_null else None,
            env=env if env is not None else _default_env(),
        )
    except subprocess.TimeoutExpired:
        return False, "", "", None, f"执行超时（>{timeout}s）"
    except OSError as e:
        return False, "", "", None, str(e)
    out = (proc.stdout or b"")[:_MAX_OUTPUT].decode("utf-8", "replace")
    err = (proc.stderr or b"")[:_MAX_OUTPUT].decode("utf-8", "replace")
    return proc.returncode == 0, out, err, proc.returncode, ""


def _first_line(text: str) -> str:
    for line in (text or "").splitlines():
        line = line.strip()
        if line:
            return line
    return ""


def _parse_version(text: str) -> str:
    """从版本输出里提取形如 1.2.3 的版本号（取第一处匹配）。"""
    m = _VERSION_RE.search(text or "")
    return m.group(0) if m else ""


def _probe_exe(path: str, version_args) -> dict:
    """执行 <path> <version_args> 获取版本。"""
    argv = [path] + list(version_args or [])
    if not version_args:
        return {"version": "", "version_raw": "", "ok": False, "error": "未配置版本参数"}
    ok, out, err, code, error = _run_cmd(argv)
    raw = _first_line(out) or _first_line(err)
    if code is None:                       # 超时 / 启动失败
        return {"version": "", "version_raw": "", "ok": False, "error": error or "检测失败"}
    ver = _parse_version(out) or _parse_version(err)
    return {"version": ver, "version_raw": raw, "ok": bool(ver or raw),
            "error": "" if (ver or raw) else (error or "无版本输出")}


def _probe_entry(entry: dict, overrides: dict) -> dict:
    """探测单个条目：所有候选 + 生效的可执行文件。"""
    candidates = []
    ov = overrides.get(entry["id"])
    seen_paths = set()

    # 用户指定的自定义路径优先
    exes = list(entry["exes"])
    if ov:
        exes = [ov] + exes
    ppath = probe_path()
    for name in exes:
        p = name if os.path.sep in name else (shutil.which(name, path=ppath) or "")
        if not p or p in seen_paths:
            continue
        seen_paths.add(p)
        info = _probe_exe(p, entry.get("version_args"))
        candidates.append({
            "exe": os.path.basename(p),
            "path": p,
            "version": info["version"],
            "version_raw": info["version_raw"],
            "error": info["error"],
            "custom": bool(ov) and os.path.abspath(os.path.expanduser(ov)) == os.path.abspath(p),
        })
    active = candidates[0] if candidates else None
    return {
        "id": entry["id"],
        "label": entry["label"],
        "category": entry["category"],
        "icon": entry.get("icon") or "bi-box",
        "site": entry.get("site") or "",
        "hint": entry.get("hint") or "",
        "version_args": " ".join(entry.get("version_args") or []),
        "env_extra": entry.get("env_extra") or [],
        "installed": bool(candidates),
        "exe": active["exe"] if active else entry["exes"][0],
        "path": active["path"] if active else "",
        "version": active["version"] if active else "",
        "version_raw": active["version_raw"] if active else "",
        "error": active["error"] if active else "",
        "custom": bool(active and active["custom"]),
        "candidates": candidates,
        "has_tools": bool(entry.get("tools")),
    }


def _default_env() -> dict:
    """带 ~/.local/bin 的环境变量（一键安装的工具无需重启即可被探测到）。"""
    env = os.environ.copy()
    env["PATH"] = probe_path()
    return env


def probe_all(force: bool = False) -> dict:
    """探测全部条目（带缓存）。返回 {items, categories, detected_at, cached}。"""
    now = time.time()
    with _cache_lock:
        if (not force) and _cache["data"] and now - _cache["ts"] < _PROBE_TTL:
            data = dict(_cache["data"])
            data["cached"] = True
            return data

    overrides = get_overrides()
    results = {}
    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = {pool.submit(_probe_entry, it, overrides): it for it in CATALOG}
        for fut, it in futures.items():
            try:
                results[it["id"]] = fut.result()
            except Exception as e:                      # 单个条目失败不影响整体
                _log.warning("探测 %s 失败: %s", it["id"], e)
                results[it["id"]] = {
                    "id": it["id"], "label": it["label"], "category": it["category"],
                    "icon": it.get("icon") or "bi-box", "site": it.get("site") or "",
                    "hint": it.get("hint") or "", "env_extra": it.get("env_extra") or [],
                    "version_args": " ".join(it.get("version_args") or []),
                    "installed": False, "exe": it["exes"][0], "path": "", "version": "",
                    "version_raw": "", "error": str(e), "custom": False,
                    "candidates": [], "has_tools": bool(it.get("tools")),
                }

    items = [results[it["id"]] for it in CATALOG]
    data = {
        "items": items,
        "categories": CATEGORIES,
        "detected_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "cached": False,
        "summary": {
            "total": len(items),
            "installed": sum(1 for x in items if x["installed"]),
            "categories": len(CATEGORIES),
        },
        "custom_env": custom_env(),
        "overrides": overrides,
    }
    with _cache_lock:
        _cache["ts"] = time.time()
        _cache["data"] = data
    return data


def invalidate_cache() -> None:
    with _cache_lock:
        _cache["ts"] = 0.0
        _cache["data"] = None


def probe_detail(rid: str) -> dict:
    """某个运行时的详细信息：多条只读命令的输出。未安装时返回安装提示与可安装标记。"""
    entry = _CATALOG_BY_ID.get(rid)
    if not entry:
        return {"error": f"未知的运行时：{rid}"}
    exe_path = resolve_exe(entry["exes"][0])
    if not exe_path:
        for name in entry["exes"][1:]:
            exe_path = resolve_exe(name)
            if exe_path:
                break
    if not exe_path:
        try:
            from . import envinstall
            installable = entry["id"] in envinstall.INSTALLABLE
        except Exception:
            installable = False
        return {
            "id": rid, "label": entry["label"], "installed": False,
            "path": "", "version": "", "version_raw": "", "candidates": [],
            "hint": entry.get("hint") or "", "site": entry.get("site") or "",
            "tools": _tool_view(entry, rid), "sections": [], "installable": installable,
            "error": f"未找到可执行文件：{' / '.join(entry['exes'])}",
        }

    sections = []

    def _add(title, argv, env_key=None):
        if env_key:                                   # 取环境变量而非执行命令
            val = os.environ.get(env_key, "")
            sections.append({"title": title, "cmd": f"${env_key}", "ok": bool(val),
                             "output": val or "（未设置）"})
            return
        ok, out, err, code, error = _run_cmd(argv, timeout=_DETAIL_TIMEOUT)
        text = (out or "") + (("\n" + err) if err.strip() else "")
        if code is None:
            text, ok = (error or "执行失败"), False
        sections.append({"title": title, "cmd": " ".join(argv), "ok": ok,
                         "output": text.strip() or "（无输出）", "exit_code": code})

    for item in (entry.get("detail") or []):
        title, args = item[0], list(item[1])
        env_key = item[2] if len(item) > 2 else None
        argv = [exe_path] + args if args else []
        if env_key and env_key.startswith("env:"):
            _add(title, argv, env_key[4:])
        elif argv:
            _add(title, argv)

    if not sections:
        sections.append({"title": "版本", "cmd": " ".join([exe_path] + list(entry.get("version_args") or [])),
                         "ok": True, "output": _first_line("") or "（该工具未配置详情命令）"})
    probe = _probe_entry(entry, get_overrides())
    return {
        "id": rid, "label": entry["label"], "path": exe_path, "installed": True,
        "version": probe["version"], "version_raw": probe["version_raw"],
        "candidates": probe["candidates"],
        "hint": entry.get("hint") or "", "site": entry.get("site") or "",
        "sections": sections,
        "tools": _tool_view(entry, rid),
    }


def system_info() -> dict:
    """系统与解释器相关信息。"""
    uname = platform.uname()
    mem_total = 0
    try:
        with open("/proc/meminfo", "r", encoding="utf-8") as f:
            for line in f:
                if line.startswith("MemTotal:"):
                    mem_total = int(line.split()[1]) * 1024
                    break
    except OSError:
        pass
    try:
        import multiprocessing
        cpu = multiprocessing.cpu_count()
    except Exception:
        cpu = os.cpu_count() or 0

    import sys
    path_entries = [p for p in os.environ.get("PATH", "").split(os.pathsep) if p]
    env_keys = ["JAVA_HOME", "GOROOT", "GOPATH", "NODE_PATH", "VIRTUAL_ENV", "CONDA_PREFIX",
                "PHP_INI_SCAN_DIR", "PYTHONPATH", "LANG", "SHELL", "PIP_INDEX_URL",
                "npm_config_registry", "COMPOSER_HOME"]
    envs = [{"key": k, "value": os.environ.get(k, "")} for k in env_keys]
    return {
        "os": f"{uname.system} {uname.release}",
        "distro": _read_distro(),
        "kernel": uname.version,
        "arch": uname.machine,
        "hostname": uname.node,
        "user": os.environ.get("USER") or os.environ.get("USERNAME") or "",
        "cpu": cpu,
        "mem_total": mem_total,
        "server_python": sys.version.split()[0],
        "server_executable": sys.executable,
        "path_entries": path_entries,
        "envs": envs,
        "custom_env": custom_env(),
        "overrides": get_overrides(),
        "cwd_root": config.DEFAULT_START_PATH,
    }


def _read_distro() -> str:
    try:
        with open("/etc/os-release", "r", encoding="utf-8") as f:
            for line in f:
                if line.startswith("PRETTY_NAME="):
                    return line.split("=", 1)[1].strip().strip('"')
    except OSError:
        pass
    return ""


# ======================================================================
# 白名单配置操作（不经过 shell，参数经校验）
# ======================================================================
def _tool_view(entry: dict, rid: str) -> list:
    """把目录表里的工具配置转成前端可渲染的结构。"""
    out = []
    for t in (entry.get("tools") or []):
        item = {"key": t["key"], "title": t["title"], "note": t.get("note") or "",
                "arg_placeholder": t.get("arg_placeholder") or "路径 / 参数",
                "arg_default": t.get("arg_default") or "",
                "in_project": bool(t.get("in_project")),
                "values": [{"label": a, "value": b} for a, b in (t.get("values") or [])],
                "fixed": t.get("fixed") or ""}
        out.append(item)
    return out


def run_tool_action(rid: str, key: str, value: str = "", cwd: str = "") -> dict:
    """执行白名单内的配置操作。value 会做基础校验（URL / 相对路径）。"""
    entry = _CATALOG_BY_ID.get(rid)
    if not entry:
        return {"error": f"未知的运行时：{rid}"}
    tool = next((t for t in (entry.get("tools") or []) if t["key"] == key), None)
    if not tool:
        return {"error": f"{entry['label']} 不支持操作：{key}"}

    # exe 字段显式指定外部工具（如 composer / npm）；未指定则使用本运行时的解释器，
    # cmd 作为其参数（如 python -m pip config set global.index-url ...）
    head = tool.get("exe") or entry["exes"][0]
    exe_path = resolve_exe(head)
    if head == "npm" and not exe_path:              # npm 可能随 Node 装在 ~/.local/node/bin
        cand = os.path.join(os.path.expanduser("~"), ".local", "node", "bin", "npm")
        exe_path = _exec_ok(cand)
    if not exe_path and head == entry["exes"][0]:
        for alias in entry["exes"][1:]:
            exe_path = resolve_exe(alias)
            if exe_path:
                break
    if not exe_path:
        return {"error": f"未安装 {head}，无法执行该操作"}
    argv = [exe_path] + list(tool["cmd"])

    run_cwd = None
    if tool.get("in_project"):
        if not cwd or not os.path.isdir(cwd):
            return {"error": "需要指定一个存在的项目目录"}
        run_cwd = os.path.abspath(cwd)
        target = (value or tool.get("arg_default") or "").strip()
        # 仅允许简单的目录名（不能是 ../ 之类的相对路径或绝对路径）
        if not target or not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", target) or target in (".", ".."):
            return {"error": "目录名不合法（只允许字母、数字、点、下划线、短横线，且不能是 . 或 ..）"}
        argv = argv + [target]
    elif tool.get("fixed"):
        argv = argv + [tool["fixed"]]
    else:
        val = (value or "").strip()
        if not val:
            return {"error": "请填写要设置的值"}
        if not re.fullmatch(r"https?://[\w.\-:/@%+~]{1,200}", val):
            return {"error": "只允许 http/https 地址"}
        argv = argv + [val]

    ok, out, err, code, error = _run_cmd(argv, timeout=_ACTION_TIMEOUT, cwd=run_cwd,
                                         env=apply_custom_env(os.environ.copy()))
    _log.info("env tool-action %s/%s -> %s", rid, key, " ".join(argv))
    if code is None:
        return {"error": error or "执行失败", "command": " ".join(argv)}
    return {
        "ok": ok, "exit_code": code, "command": " ".join(argv),
        "stdout": (out or "").strip(), "stderr": (err or "").strip(),
        "cwd": run_cwd or os.getcwd(),
        "note": tool.get("note") or "",
    }

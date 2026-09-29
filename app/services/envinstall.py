"""运行环境一键安装（用户级，无需管理员权限）。

设计要点：
- 只执行**内置白名单方案**：下载地址与参数全部写死在本文件，接口不接受任何用户提供的
  URL / 参数，因此不存在命令注入或任意下载执行的风险；
- 一律安装到用户目录（默认 ~/.local/<name>），可执行文件软链到 ~/.local/bin（通常已在 PATH），
  不调用 sudo、不写系统目录；
- 也提供「系统包」方案，但只返回命令文本供用户复制手动执行（服务器无免密 sudo 时无法自动安装）；
- 安装过程在后台线程执行并按行记录日志，前端轮询增量输出。

对外接口：
    list_plans(rid) -> 该运行时可用的安装方案（含解析后的版本 / 下载地址预览）
    start_install(rid, key) -> 任务 id
    task_log(tid, offset) -> {lines, done, ok, error, ...}
"""
import io
import json
import os
import shutil
import stat
import tarfile
import threading
import time
import urllib.error
import urllib.request
import zipfile

from .. import config
from ..log import get_logger


_log = get_logger()

LOCAL_ROOT = os.path.join(os.path.expanduser("~"), ".local")
LOCAL_BIN = os.path.join(LOCAL_ROOT, "bin")
SRC_DIR = os.path.join(LOCAL_ROOT, ".ff-install")
_HTTP_TIMEOUT = 20
_RESOLVE_TTL = 900                      # 版本解析成功缓存 15 分钟
_RESOLVE_FAIL_TTL = 60                  # 解析失败只短暂缓存，避免反复卡住面板
_HTTP_ATTEMPTS = 4                      # 单次请求重试次数（网络抖动常见）
_DOWNLOAD_ATTEMPTS = 6                  # 下载中断后的重试次数（每次从断点续传）
_MAX_LOG_LINES = 4000

_resolve_cache = {}
_tasks = {}
_tasks_lock = threading.Lock()
_install_lock = threading.Lock()        # 同一时间只允许一个安装任务


# ======================================================================
# 网络工具
# ======================================================================
def _open(url, timeout=_HTTP_TIMEOUT, retries=None, headers=None):
    """打开 URL（SSL 握手超时 / 连接抖动时自动重试）。"""
    last = None
    attempts = _HTTP_ATTEMPTS if retries is None else max(1, retries)
    for attempt in range(attempts):
        hd = {"User-Agent": "FileFlask-EnvInstaller/1.0", "Accept": "*/*"}
        hd.update(headers or {})
        req = urllib.request.Request(url, headers=hd)
        try:
            return urllib.request.urlopen(req, timeout=timeout)
        except Exception as e:                     # URLError / SSL 握手超时 / HTTP 5xx 等
            last = e
            if isinstance(e, urllib.error.HTTPError) and 400 <= e.code < 500:
                raise                              # 4xx 重试无意义
            if attempt < attempts - 1:
                time.sleep(1.0 + attempt)
    raise last


def _get_json(url):
    with _open(url) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


def _get_text(url):
    with _open(url) as r:
        return r.read().decode("utf-8", "replace")


def _cached(key, fn):
    """带缓存地解析（成功缓存 15 分钟，失败缓存 60 秒）。"""
    now = time.time()
    hit = _resolve_cache.get(key)
    if hit:
        ttl = _RESOLVE_TTL if hit[2] else _RESOLVE_FAIL_TTL
        if now - hit[0] < ttl:
            if hit[2]:
                return hit[1]
            raise RuntimeError(hit[1])
    try:
        val = fn()
    except Exception as e:
        _resolve_cache[key] = (now, str(e), False)
        raise
    _resolve_cache[key] = (now, val, True)
    return val


# ======================================================================
# 版本解析（拿到官方最新稳定版的下载地址）
# ======================================================================
def _resolve_node():
    data = _get_json("https://nodejs.org/dist/index.json")
    item = next((x for x in data if x.get("lts")), data[0] if data else None)
    if not item:
        raise RuntimeError("无法获取 Node.js 版本列表")
    v = item["version"]
    return {"version": v, "url": f"https://nodejs.org/dist/{v}/node-{v}-linux-x64.tar.xz",
            "strip": 1, "sub": f"node-{v}-linux-x64",
            "files": [("bin/node", "node"), ("bin/npm", "npm"), ("bin/npx", "npx")]}


def _resolve_go():
    data = _get_json("https://go.dev/dl/?mode=json")
    for rel in data:
        if not rel.get("stable"):
            continue
        f = next((x for x in rel.get("files", [])
                  if x.get("os") == "linux" and x.get("arch") == "amd64" and x.get("kind") == "archive"), None)
        if f:
            return {"version": rel["version"].lstrip("go"), "url": "https://go.dev/dl/" + f["filename"],
                    "strip": 1, "sub": "go", "files": [("bin/go", "go"), ("bin/gofmt", "gofmt")]}
    raise RuntimeError("无法获取 Go 版本列表")


def _resolve_java():
    url = ("https://api.adoptium.net/v3/assets/latest/21/hotspot"
           "?architecture=x64&image_type=jdk&os=linux&vendor=eclipse")
    data = _get_json(url)
    if not data:
        raise RuntimeError("无法获取 Adoptium JDK 版本列表")
    pkg = data[0]["binary"]["package"]
    ver = data[0]["version"]["semver"]
    return {"version": ver, "url": pkg["link"], "strip": 1, "sub": "current",
            "files": [("bin/java", "java"), ("bin/javac", "javac"), ("bin/jar", "jar")]}


def _resolve_maven():
    # repo1 的 maven-metadata.xml 最稳定（dlcdn 只保留当前版本，旧版本会 404）
    # 注意：<latest>/<release> 可能指向 4.0.0-rc 之类的预发布版，需要自己筛最新的正式版
    import re
    xml = _get_text("https://repo1.maven.org/maven2/org/apache/maven/apache-maven/maven-metadata.xml")
    versions = [v for v in re.findall(r"<version>([^<]+)</version>", xml) if "-" not in v]
    if not versions:
        raise RuntimeError("无法解析 Maven 稳定版本")

    def _key(v):
        parts = []
        for seg in v.split("."):
            parts.append(int(seg) if seg.isdigit() else 0)
        while len(parts) < 4:
            parts.append(0)
        return parts[:4]

    m_ver = max(versions, key=_key)
    return {"version": m_ver,
            "url": f"https://repo1.maven.org/maven2/org/apache/maven/apache-maven/{m_ver}/"
                   f"apache-maven-{m_ver}-bin.tar.gz",
            "strip": 1, "sub": f"apache-maven-{m_ver}", "files": [("bin/mvn", "mvn")]}


def _resolve_gradle():
    data = _get_json("https://services.gradle.org/versions/current")
    v = data["version"]
    return {"version": v, "url": f"https://services.gradle.org/distributions/gradle-{v}-bin.zip",
            "strip": 1, "sub": f"gradle-{v}", "kind": "zip", "files": [("bin/gradle", "gradle")]}


# ======================================================================
# 安装方案表（key 由前端回传，仅用于在表内查找，不参与命令拼接）
# ======================================================================
# mode=user   ：下载官方包/执行官方脚本，安装到 ~/.local（可自动执行）
# mode=system ：需要管理员权限的系统包，仅返回命令文本供复制
PLANS = {
    "node": [
        dict(key="user", mode="user", label="官方压缩包（用户级，无需管理员）",
             size="约 30–50 MB", dest="node", resolver=_resolve_node,
             note="安装到 ~/.local/node，可执行文件软链到 ~/.local/bin"),
        dict(key="apt", mode="system", label="系统包（需要管理员权限）",
             packages=["nodejs", "npm"], note="Deepin/Debian 自带源版本通常较旧，推荐用上面的用户级安装"),
    ],
    "python": [
        dict(key="uv", mode="user", label="通过 uv 管理 Python（用户级）",
             size="约 15 MB + 解释器", kind="script", script="https://astral.sh/uv/install.sh",
             script_args=[], dest="uv",
             note="装好后可用 uv python install 3.12 安装多个解释器版本"),
        dict(key="apt", mode="system", label="系统包（需要管理员权限）",
             packages=["python3", "python3-pip", "python3-venv"]),
    ],
    "java": [
        dict(key="user", mode="user", label="Adoptium Temurin JDK 21（用户级，无需管理员）",
             size="约 190 MB", dest="java/current", resolver=_resolve_java,
             note="安装后建议在「自定义环境变量」里设置 JAVA_HOME=$(~/.local/java/current)"),
        dict(key="apt", mode="system", label="系统包（需要管理员权限）",
             packages=["default-jdk"], note="Debian/Ubuntu 系可用 openjdk-17-jdk"),
    ],
    "javac": [
        dict(key="user", mode="user", label="随 JDK 一起安装（用户级）",
             size="约 190 MB", dest="java/current", resolver=_resolve_java, rid="java",
             note="javac 由 JDK 提供，安装 Java (JDK) 即可"),
    ],
    "go": [
        dict(key="user", mode="user", label="官方压缩包（用户级，无需管理员）",
             size="约 70–80 MB", dest="go", resolver=_resolve_go,
             note="安装到 ~/.local/go"),
        dict(key="apt", mode="system", label="系统包（需要管理员权限）",
             packages=["golang-go"]),
    ],
    "rustc": [
        dict(key="user", mode="user", label="rustup 官方安装（用户级，含 cargo）",
             size="约 300 MB（含工具链）", kind="script", script="https://sh.rustup.rs",
             script_args=["-y", "--no-modify-path", "--profile", "minimal"], dest="cargo",
             note="安装到 ~/.cargo，同时提供 cargo/rustc/rustup"),
    ],
    "dotnet": [
        dict(key="user", mode="user", label="dotnet-install 官方脚本（用户级，LTS）",
             size="约 200–300 MB", kind="script", script="https://dot.net/v1/dotnet-install.sh",
             script_args=["--channel", "LTS", "--install-dir", os.path.join(LOCAL_ROOT, "dotnet")],
             dest="dotnet", note="安装到 ~/.local/dotnet"),
    ],
    "mvn": [
        dict(key="user", mode="user", label="Apache Maven 官方压缩包（用户级，无需管理员）",
             size="约 9 MB", dest="maven", resolver=_resolve_maven,
             note="需要已安装 JDK"),
        dict(key="apt", mode="system", label="系统包（需要管理员权限）", packages=["maven"]),
    ],
    "gradle": [
        dict(key="user", mode="user", label="官方压缩包（用户级，无需管理员）",
             size="约 130 MB", dest="gradle", resolver=_resolve_gradle,
             note="需要已安装 JDK；项目内一般用 gradlew 即可"),
    ],
    "lua": [
        dict(key="apt", mode="system", label="系统包（需要管理员权限）", packages=["lua5.4"]),
    ],
    "php": [dict(key="apt", mode="system", label="系统包（需要管理员权限）",
                 packages=["php-cli", "php-mbstring"])],
    "ruby": [dict(key="apt", mode="system", label="系统包（需要管理员权限）", packages=["ruby-full"])],
    "perl": [dict(key="apt", mode="system", label="系统包（需要管理员权限）", packages=["perl"])],
    "gcc": [dict(key="apt", mode="system", label="系统包（需要管理员权限）", packages=["build-essential"])],
    "psql": [dict(key="apt", mode="system", label="系统包（需要管理员权限）", packages=["postgresql-client"])],
    "redis": [dict(key="apt", mode="system", label="系统包（需要管理员权限）", packages=["redis-server"])],
    "mysql": [dict(key="apt", mode="system", label="系统包（需要管理员权限）", packages=["mysql-server"])],
    "mariadb": [dict(key="apt", mode="system", label="系统包（需要管理员权限）", packages=["mariadb-server"])],
    "mongo": [dict(key="apt", mode="system", label="官方文档安装（需要管理员权限）", packages=[],
                   note="MongoDB 不在发行版默认源中，请参考 https://www.mongodb.com/docs/manual/installation/")],
    "sqlite": [dict(key="apt", mode="system", label="系统包（需要管理员权限）", packages=["sqlite3"])],
    "nginx": [dict(key="apt", mode="system", label="系统包（需要管理员权限）", packages=["nginx"])],
    "apache": [dict(key="apt", mode="system", label="系统包（需要管理员权限）", packages=["apache2"])],
    "docker": [dict(key="apt", mode="system", label="官方脚本安装（需要管理员权限）", packages=[],
                    note="在终端执行：curl -fsSL https://get.docker.com | sudo sh")],
    "docker-compose": [dict(key="apt", mode="system", label="系统包（需要管理员权限）",
                            packages=["docker-compose-plugin"])],
    "jq": [dict(key="apt", mode="system", label="系统包（需要管理员权限）", packages=["jq"])],
    "ffmpeg": [dict(key="apt", mode="system", label="系统包（需要管理员权限）", packages=["ffmpeg"])],
    "tmux": [dict(key="apt", mode="system", label="系统包（需要管理员权限）", packages=["tmux"])],
    "cmake": [dict(key="apt", mode="system", label="系统包（需要管理员权限）", packages=["cmake"])],
    "uv": [dict(key="user", mode="user", label="官方安装脚本（用户级，无需管理员）",
                size="约 15 MB", kind="script", script="https://astral.sh/uv/install.sh",
                script_args=[], dest="uv", note="安装到 ~/.local/bin/uv")],
    "npm": [dict(key="node", mode="user", label="随 Node.js 一起安装（用户级）",
                 size="约 30–50 MB", dest="node", resolver=_resolve_node, rid="node",
                 note="npm 随 Node.js 一起提供")],
    "yarn": [dict(key="corepack", mode="user", label="用 corepack 启用（用户级，随 Node.js 提供）",
                  size="约 0 MB", kind="run", argv=["npm", "install", "-g", "yarn"], dest="node",
                  note="需要已安装 Node.js / npm")],
    "pnpm": [dict(key="corepack", mode="user", label="用 corepack 启用（用户级，随 Node.js 提供）",
                  size="约 0 MB", kind="run", argv=["npm", "install", "-g", "pnpm"], dest="node",
                  note="需要已安装 Node.js / npm")],
    "cargo": [dict(key="rustup", mode="user", label="随 Rust 一起安装（用户级）",
                   size="约 300 MB", kind="script", script="https://sh.rustup.rs",
                   script_args=["-y", "--no-modify-path", "--profile", "minimal"], dest="cargo",
                   rid="rustc", note="cargo 由 rustup 提供")],
    "pip": [dict(key="apt", mode="system", label="系统包（需要管理员权限）",
                 packages=["python3-pip"])],
    "composer": [dict(key="apt", mode="system", label="系统包（需要管理员权限）", packages=["composer"])],
    "gem": [dict(key="apt", mode="system", label="系统包（需要管理员权限）", packages=["rubygems"])],
    "git": [dict(key="apt", mode="system", label="系统包（需要管理员权限）", packages=["git"])],
    "openssl": [dict(key="apt", mode="system", label="系统包（需要管理员权限）", packages=["openssl"])],
    "rsync": [dict(key="apt", mode="system", label="系统包（需要管理员权限）", packages=["rsync"])],
    "make": [dict(key="apt", mode="system", label="系统包（需要管理员权限）", packages=["build-essential"])],
    "wget": [dict(key="apt", mode="system", label="系统包（需要管理员权限）", packages=["wget"])],
    "curl": [dict(key="apt", mode="system", label="系统包（需要管理员权限）", packages=["curl"])],
    "zstd": [dict(key="apt", mode="system", label="系统包（需要管理员权限）", packages=["zstd"])],
}

# 供 envprobe 使用：某运行时是否提供一键安装
INSTALLABLE = set(PLANS.keys())


def auto_install_enabled() -> bool:
    return bool(getattr(config, "ENABLE_EXEC", True)) and bool(getattr(config, "ENABLE_AUTO_INSTALL", True))


# ======================================================================
# 方案展示
# ======================================================================
def list_plans(rid: str) -> dict:
    """返回某运行时的安装方案（用户级方案会解析出最新版本与下载地址）。"""
    plans = PLANS.get(rid)
    if not plans:
        return {"id": rid, "plans": [], "enabled": auto_install_enabled(),
                "message": "该运行时不提供一键安装，请参考官网文档手动安装"}
    out = []
    for p in plans:
        item = {
            "key": p["key"], "mode": p["mode"], "label": p["label"],
            "note": p.get("note", ""), "size": p.get("size", ""),
            "target": p.get("dest", ""), "rid": p.get("rid", rid),
            "enabled": auto_install_enabled() if p["mode"] == "user" else False,
            "packages": p.get("packages") or [],
            "version": "", "url": "", "error": "", "kind": p.get("kind", "tarball"),
        }
        if p["mode"] == "system":
            if item["packages"]:
                item["command"] = "sudo apt install -y " + " ".join(item["packages"])
            else:
                item["command"] = ""
        if p["mode"] == "user" and p.get("resolver"):
            try:
                info = _cached("res:" + rid + ":" + p["key"], p["resolver"])
                item["version"] = info.get("version", "")
                item["url"] = info.get("url", "")
            except Exception as e:
                item["error"] = f"获取最新版本失败：{e}"
        elif p["mode"] == "user" and p.get("script"):
            item["url"] = p["script"]
        elif p["mode"] == "user" and p.get("kind") == "run":
            item["command"] = " ".join(p.get("argv") or [])
        item["install_dir"] = os.path.join(LOCAL_ROOT, p.get("dest", "")) if p.get("dest") else ""
        out.append(item)
    return {"id": rid, "plans": out, "enabled": auto_install_enabled(), "local_bin": LOCAL_BIN}


# ======================================================================
# 任务执行
# ======================================================================
class _Task:
    def __init__(self, rid, title):
        self.tid = "inst-" + str(int(time.time() * 1000))[-9:] + "-" + rid
        self.rid = rid
        self.title = title
        self.lines = []
        self.done = False
        self.ok = False
        self.error = ""
        self.cancelled = False
        self.installed = []          # 安装出的可执行文件（绝对路径）
        self.started = time.time()

    def log(self, text, cls=""):
        self.lines.append({"t": round(time.time() - self.started, 2), "m": str(text), "c": cls})
        if len(self.lines) > _MAX_LOG_LINES:
            del self.lines[:1000]


def _fmt_size(n):
    for u in ("B", "KB", "MB", "GB"):
        if n < 1024 or u == "GB":
            return ("%d %s" % (n, u)) if u == "B" else ("%.1f %s" % (n, u))
        n /= 1024.0


def _download(task, url, dest, desc=""):
    """下载文件。支持断点续传：中断后从已下载的字节继续，适合不稳定网络。"""
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    task.log(f"下载 {desc or url}")
    task.log(f"  ← {url}", "dim")
    tmp = dest + ".part"
    total = 0
    for attempt in range(1, _DOWNLOAD_ATTEMPTS + 1):
        if task.cancelled:
            raise RuntimeError("已取消")
        have = os.path.getsize(tmp) if os.path.exists(tmp) else 0
        if have and total and have >= total:       # 上次实际已下完
            break
        try:
            r = _open(url, retries=1, headers=({"Range": f"bytes={have}-"} if have else None))
            with r:
                partial = (getattr(r, "status", 200) == 206)
                if have and not partial:           # 服务端不支持续传 → 从头开始
                    have = 0
                if not total:
                    cl = int(r.headers.get("Content-Length") or 0)
                    total = (have + cl) if cl else 0
                got = have
                mark = got + 512 * 1024
                t0 = time.time()
                with open(tmp, "ab" if have else "wb") as f:
                    while True:
                        if task.cancelled:
                            raise RuntimeError("已取消")
                        chunk = r.read(128 * 1024)
                        if not chunk:
                            break
                        f.write(chunk)
                        got += len(chunk)
                        if got >= mark:
                            mark = got + 512 * 1024
                            speed = got / max(0.1, time.time() - t0)
                            pct = f"（{got * 100 // total}%）" if total else ""
                            task.log(f"  已下载 {_fmt_size(got)}"
                                     + (f" / {_fmt_size(total)}" if total else "")
                                     + f"{pct} · {_fmt_size(speed)}/s", "dim")
                if total and got < total:
                    raise RuntimeError(f"连接中断（已下载 {_fmt_size(got)} / {_fmt_size(total)}）")
            os.replace(tmp, dest)
            task.log(f"  完成：{_fmt_size(os.path.getsize(dest))}", "ok")
            return
        except Exception as e:
            if task.cancelled:
                raise RuntimeError("已取消")
            task.log(f"  第 {attempt} 次下载中断：{e}", "err")
            if attempt < _DOWNLOAD_ATTEMPTS:
                task.log("  稍后重试（支持断点续传）", "dim")
                time.sleep(2 * attempt)
    if not os.path.exists(dest) and os.path.exists(tmp):
        os.replace(tmp, dest)
    task.log(f"  完成：{_fmt_size(os.path.getsize(dest))}（重试后成功）", "ok")


def _extract(task, archive, dest, strip=1, kind="tarball"):
    os.makedirs(dest, exist_ok=True)
    task.log(f"解压到 {dest}（strip={strip}）")
    if kind == "zip":
        with zipfile.ZipFile(archive) as z:
            for m in z.infolist():
                parts = m.filename.split("/")[strip:]
                if not parts or not parts[-1]:
                    continue
                target = os.path.join(dest, *parts)
                if m.is_dir():
                    os.makedirs(target, exist_ok=True)
                else:
                    os.makedirs(os.path.dirname(target), exist_ok=True)
                    with z.open(m) as src, open(target, "wb") as out:
                        shutil.copyfileobj(src, out)
                    if (m.external_attr >> 16) & 0o111:
                        os.chmod(target, os.stat(target).st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    else:
        with tarfile.open(archive) as t:
            members = []
            for m in t.getmembers():
                parts = m.name.split("/")[strip:]
                if not parts or not parts[-1]:
                    continue
                m.name = "/".join(parts)
                members.append(m)
            t.extractall(dest, members=members)


def _symlink(task, src, name):
    os.makedirs(LOCAL_BIN, exist_ok=True)
    link = os.path.join(LOCAL_BIN, name)
    if os.path.islink(link) or os.path.exists(link):
        try:
            os.remove(link)
        except OSError:
            pass
    os.symlink(src, link)
    task.log(f"  已创建软链 {link} → {src}", "dim")
    return link


def _run_step(task, argv, cwd=None, env=None):
    import subprocess
    task.log("执行 " + " ".join(argv))
    proc = subprocess.run(argv, cwd=cwd, env=env, capture_output=True, timeout=1800,
                          stdin=subprocess.DEVNULL)
    out = (proc.stdout or b"").decode("utf-8", "replace")
    err = (proc.stderr or b"").decode("utf-8", "replace")
    for line in (out + err).splitlines()[-40:]:
        task.log("  " + line, "dim")
    if proc.returncode != 0:
        raise RuntimeError(f"命令失败（退出码 {proc.returncode}）：{' '.join(argv)}")
    return out


def _env_with_bin():
    env = dict(os.environ)
    env["PATH"] = LOCAL_BIN + os.pathsep + env.get("PATH", "")
    return env


def _run_user_plan(task, plan):
    """执行用户级安装方案。所有 URL / 参数均来自内置表。"""
    dest_rel = plan.get("dest") or plan.get("key")
    dest = os.path.join(LOCAL_ROOT, dest_rel)
    kind = plan.get("kind", "tarball")

    if kind == "run":                                    # 例如 npm install -g yarn
        argv = list(plan.get("argv") or [])
        exe = shutil.which(argv[0], path=_env_with_bin()["PATH"])
        if not exe:
            raise RuntimeError(f"未找到命令 {argv[0]}，请先安装它")
        _run_step(task, [exe] + argv[1:], env=_env_with_bin())
        task.log("完成", "ok")
        return

    if kind == "script":                                 # 官方安装脚本
        name = plan["script"].rsplit("/", 1)[-1] or "install.sh"
        script = os.path.join(SRC_DIR, name)
        _download(task, plan["script"], script, desc="官方安装脚本")
        args = [a.replace("~", os.path.expanduser("~")) for a in (plan.get("script_args") or [])]
        _run_step(task, ["sh", script] + args, env=_env_with_bin())
        for exe in ("cargo", "rustc", "uv", "dotnet"):
            p = os.path.join(LOCAL_BIN, exe)
            if os.path.exists(p):
                task.installed.append(p)
        if not task.installed:                           # 脚本可能装到 ~/.cargo/bin 等位置
            for guess in (os.path.join(os.path.expanduser("~"), ".cargo", "bin", "cargo"),
                          os.path.join(LOCAL_ROOT, dest_rel, "dotnet")):
                if os.path.exists(guess):
                    task.installed.append(guess)
        task.log("完成", "ok")
        return

    info = _cached("res:" + task.rid + ":" + plan["key"], plan["resolver"]) if plan.get("resolver") else None
    url = (info or {}).get("url") or plan.get("url")
    if not url:
        raise RuntimeError("无法解析下载地址")
    strip = int(plan.get("strip") or (info or {}).get("strip") or 1)
    ext = ".zip" if url.endswith(".zip") else (".tar.xz" if url.endswith(".tar.xz") else ".tar.gz")
    archive = os.path.join(SRC_DIR, f"{dest_rel.replace('/', '_')}{ext}")
    _download(task, url, archive, desc=f"{task.rid} {(info or {}).get('version', '')}".strip())
    _extract(task, archive, dest, strip=strip, kind="zip" if ext == ".zip" else "tarball")

    files = plan.get("files") or (info or {}).get("files") or []
    for rel, name in files:
        src = os.path.join(dest, rel)
        if os.path.exists(src):
            try:
                os.chmod(src, os.stat(src).st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
            except OSError:
                pass
            task.installed.append(_symlink(task, src, name))
        else:
            task.log(f"  跳过（未找到）：{src}", "err")
    if not files and os.path.isdir(os.path.join(dest, "bin")):     # 未声明时自动链接 bin 下全部可执行文件
        for name in os.listdir(os.path.join(dest, "bin")):
            src = os.path.join(dest, "bin", name)
            if os.path.isfile(src):
                task.installed.append(_symlink(task, src, name))
    if os.path.exists(archive):
        try:
            os.remove(archive)
        except OSError:
            pass
    task.log("完成", "ok")


def _worker(task, plan):
    try:
        os.makedirs(LOCAL_BIN, exist_ok=True)
        os.makedirs(SRC_DIR, exist_ok=True)
        if plan["mode"] == "system":
            raise RuntimeError("系统包安装需要管理员权限，请复制命令后手动执行")
        _run_user_plan(task, plan)
        task.ok = True
    except Exception as e:
        task.error = str(e)
        task.log(("已取消" if task.cancelled else "安装失败：") + str(e), "err")
    finally:
        task.done = True
        try:
            from . import envprobe
            envprobe.invalidate_cache()
        except Exception:
            pass
        _log.info("env install %s done ok=%s err=%s", task.rid, task.ok, task.error)


def start_install(rid: str, key: str) -> dict:
    """启动安装任务，返回任务 id。"""
    if not auto_install_enabled():
        return {"error": "已禁用一键安装（config.ENABLE_AUTO_INSTALL / ENABLE_EXEC = False）"}
    plan = next((p for p in (PLANS.get(rid) or []) if p["key"] == key), None)
    if not plan:
        return {"error": f"未知的安装方案：{rid}/{key}"}
    if plan["mode"] != "user":
        return {"error": "该系统包方案需要管理员权限，请复制命令手动执行"}
    with _install_lock:
        running = next((t for t in _tasks.values() if not t.done), None)
        if running:
            return {"error": f"已有安装任务在进行中（{running.rid}），请等待完成"}
        task = _Task(rid, plan["label"])
        with _tasks_lock:
            _tasks[task.tid] = task
            for old in [k for k, v in _tasks.items() if v.done and time.time() - v.started > 3600]:
                _tasks.pop(old, None)
        threading.Thread(target=_worker, args=(task, plan), daemon=True).start()
    return {"ok": True, "tid": task.tid, "title": f"正在安装 {rid}：{plan['label']}"}


def cancel_install(tid: str) -> dict:
    """取消进行中的安装任务（下载/解压循环会在下一个检查点退出）。"""
    with _tasks_lock:
        task = _tasks.get(tid)
        if not task:
            return {"error": "任务不存在或已过期"}
        if task.done:
            return {"ok": True, "already_done": True}
        task.cancelled = True
    task.log("收到取消请求，正在停止…", "err")
    return {"ok": True}


def task_log(tid: str, offset: int = 0) -> dict:
    with _tasks_lock:
        task = _tasks.get(tid)
        if not task:
            return {"error": "任务不存在或已过期"}
        lines = task.lines[offset:]
        return {
            "tid": tid, "rid": task.rid, "title": task.title,
            "lines": lines, "offset": offset + len(lines),
            "total": len(task.lines),
            "done": task.done, "ok": task.ok, "error": task.error,
            "installed": task.installed,
            "elapsed": round(time.time() - task.started, 1),
        }

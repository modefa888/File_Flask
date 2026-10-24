"""在线更新（GitHub）：检查远端最新提交 → 拉取代码 → 安装依赖 → 重启服务。

设计要点
--------
- **不引入任何第三方依赖**：GitHub API 走标准库 urllib，拉代码走本机 git 命令。
- **两种检查方式**（配置项 `method`）：
    api  —— 调 GitHub REST API，能看到提交列表 / 提交人 / 时间，信息最全；
    git  —— `git ls-remote` + `git fetch`，只依赖 git 本身（不占用 API 限额，
            服务器能 git clone 但访问不了 api.github.com 时用它）；
    auto —— 先 API，失败自动回退 git（默认）。
- **更新过程在后台线程**执行，事件写进内存缓冲，前端按 `run_id` 轮询进度
  （与 agentrun 的思路一致，重启会让缓冲丢失，因此重启前会把结果落到
  store_meta 的 `update_last`，重启后页面能回显「上次更新是否成功」）。
- **重启方式**（配置项 `restart_mode`）：
    exec    —— `os.execv` 原地替换进程（适合 `python run.py` / 打包后的可执行文件，
               端口不中断太久；仅在本进程就是服务主进程时可用）；
    exit    —— 更新完直接退出，由 systemd / supervisor / pm2 的自动重启拉起
               （服务单元里必须配置了 Restart=always，否则服务会停）；
    command —— 执行自定义重启命令（如 `systemd-run --no-block systemctl restart xxx`）；
    none    —— 只更新不重启，页面上提示手动重启。
- **安全**：所有接口仅管理员可用（由 auth 的全局鉴权接管）；GitHub Token 加密落库，
  且不会出现在任何返回体 / 命令参数里（Git 认证通过 GIT_CONFIG_* 环境变量传
  `http.extraheader`，避免 token 出现在进程命令行）。
- **初始化仓库**（`start_init`）：从 GitHub 下载 ZIP 解压安装的目录里没有 `.git`，
  在线更新全部功能都依赖它。该任务执行 `git init` → 关联 `origin` → `git fetch` →
  `git checkout -f -B <branch>` 与远端对齐；被 .gitignore 覆盖的 data/、.env 等不受影响。
  同样跑在后台线程里，前端按 `run_id` 轮询进度。
- **ZIP 包更新**（`start_zip_update`）：管理员在页面上传源码压缩包，服务端安全解压后覆盖
  到项目目录。完全不依赖 Git / 外网，适合「服务器连不上 GitHub」或「本来就是 ZIP 部署」
  的场景。覆盖时跳过 data/、.env、虚拟环境、日志、__pycache__ 等运行时内容。
- **更新前代码备份**（`_backup_project` / `start_backup`）：两种更新方式在动工作区之前
  都会把当前代码整份打包成 `data/update_backup/pre_时间.zip`（不含 data/、logs/、
  虚拟环境、.git；单文件 >30MB 跳过；只保留最近 10 份）。备份失败会中止更新，
  避免出现「没备份就覆盖」；页面上也可以点「备份代码」随时手动备份。
- **备份记录与回滚**（`list_backups` / `start_restore`）：备份 Tab 列出 data/update_backup
  里的全部压缩包（类型 / 时间 / 大小 / 文件数），支持恢复、下载、删除。恢复时先把当前
  代码再打一份 `restore_时间.zip` 快照再覆盖，备份之后新增的文件不删除（只在日志里提示）。
"""
import base64
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid
import urllib.error
import urllib.request
import zipfile
from urllib.parse import quote

from ... import config
from ...log import get_logger
from ..common import secret
from ..common.store_db import get_meta, set_meta

_log = get_logger()

_CFG_KEY = "update_cfg"
_LAST_KEY = "update_last"

_DEFAULT_CFG = {
    "repo": "",              # owner/repo / https://github.com/owner/repo / git@github.com:owner/repo.git
    "remote_url": "",        # 可选：真正用于 git fetch / ls-remote 的地址（SSH 443 / 镜像）
    "branch": "",            # 留空 = 跟随本地当前分支
    "token": "",             # GitHub PAT（私有仓库必填；公开仓库填了可提高 API 限额）
    "api_base": "https://api.github.com",
    "proxy": "",             # 形如 http://127.0.0.1:7890，同时用于 GitHub API 与 git
    "method": "auto",        # auto / api / git
    "install_deps": True,    # requirements.txt 有变化时自动 pip install
    "backup_before_update": True,  # 更新前把当前代码打包备份到 data/update_backup/
    "restart_mode": "exec",  # exec / exit / command / none
    "restart_cmd": "",       # restart_mode=command 时执行
    "hard_reset": False,     # 是否允许「强制覆盖本地改动」
}

_MAX_RUNS = 10
_RUN_KEEP_SECONDS = 6 * 3600

_LOCK = threading.RLock()
_RUNS = {}                   # run_id -> run dict
_CURRENT = {"id": ""}


# ============================================================================ 配置
def _raw_config():
    """读取配置（token 已解密），任何异常都降级为默认值。"""
    cfg = dict(_DEFAULT_CFG)
    try:
        raw = get_meta(_CFG_KEY)
        if raw:
            data = json.loads(raw)
            if isinstance(data, dict):
                for k in _DEFAULT_CFG:
                    if k in data:
                        cfg[k] = data[k]
    except Exception as e:
        _log.warning("读取在线更新配置失败，使用默认值: %s", e)
    token = cfg.get("token") or ""
    if token:
        cfg["token"] = secret.decrypt(token)
    return cfg


def load_config():
    """对外：读取配置（调用方拿到的是明文 token，仅在服务端内部使用）。"""
    return _raw_config()


def public_config(cfg=None):
    """返回给前端：token 脱敏。"""
    cfg = cfg if isinstance(cfg, dict) else _raw_config()
    out = {k: cfg.get(k) for k in _DEFAULT_CFG}
    out["token"] = secret.mask(cfg.get("token") or "")
    out["token_set"] = bool(cfg.get("token"))
    return out


def save_config(patch):
    """保存配置；前端回显的 `ab12******` 会被识别为「未修改」。返回错误信息或空串。"""
    if not isinstance(patch, dict):
        return "参数格式错误"
    cfg = _raw_config()
    old_token = cfg.get("token") or ""

    if "repo" in patch:
        cfg["repo"] = str(patch.get("repo") or "").strip()
    if "remote_url" in patch:
        cfg["remote_url"] = str(patch.get("remote_url") or "").strip()
    if "branch" in patch:
        cfg["branch"] = str(patch.get("branch") or "").strip()
    if "api_base" in patch:
        cfg["api_base"] = str(patch.get("api_base") or "").strip() or "https://api.github.com"
    if "proxy" in patch:
        cfg["proxy"] = str(patch.get("proxy") or "").strip()
    if "method" in patch:
        method = str(patch.get("method") or "auto").strip().lower()
        cfg["method"] = method if method in ("auto", "api", "git") else "auto"
    if "restart_mode" in patch:
        mode = str(patch.get("restart_mode") or "exec").strip().lower()
        cfg["restart_mode"] = mode if mode in ("exec", "exit", "command", "none") else "exec"
    if "restart_cmd" in patch:
        cfg["restart_cmd"] = str(patch.get("restart_cmd") or "").strip()
    if "install_deps" in patch:
        cfg["install_deps"] = bool(patch.get("install_deps"))
    if "backup_before_update" in patch:
        cfg["backup_before_update"] = bool(patch.get("backup_before_update"))
    if "hard_reset" in patch:
        cfg["hard_reset"] = bool(patch.get("hard_reset"))

    if "token" in patch:
        token = str(patch.get("token") or "").strip()
        cfg["token"] = old_token if "******" in token else token

    if cfg["repo"]:
        parsed = parse_repo(cfg["repo"])
        if not parsed:
            return "仓库地址格式不正确（支持 owner/repo、https://github.com/owner/repo、git@github.com:owner/repo.git）"
        cfg["repo"] = parsed["slug"] if parsed["host"] == "github.com" else parsed["https"]

    data = dict(cfg)
    data["token"] = secret.encrypt(cfg.get("token") or "") if cfg.get("token") else ""
    set_meta(_CFG_KEY, json.dumps(data, ensure_ascii=False))
    _log.info("在线更新配置已保存：repo=%s branch=%s method=%s restart=%s",
              cfg["repo"] or "(跟随 origin)", cfg["branch"] or "(当前分支)",
              cfg["method"], cfg["restart_mode"])
    return ""


# ============================================================================ 仓库解析
_RE_SSH = re.compile(r"^git@([^:]+):(.+?)(?:\.git)?/?$")
_RE_HTTPS = re.compile(r"^https?://([^/]+)/(.+?)(?:\.git)?/?$")
_RE_SLUG = re.compile(r"^([\w.\-]+)/([\w.\-]+)$")


def parse_repo(text):
    """把各种写法的仓库地址归一化为 dict；无法识别返回 None。"""
    t = (text or "").strip()
    if not t:
        return None
    host, path = "", ""
    m = _RE_SSH.match(t)
    if m:
        host, path = m.group(1), m.group(2)
    else:
        m = _RE_HTTPS.match(t)
        if m:
            host, path = m.group(1), m.group(2)
        else:
            m = _RE_SLUG.match(t)
            if m:
                host, path = "github.com", t
    path = path.strip("/")
    if path.endswith(".git"):
        path = path[:-4]
    parts = [p for p in path.split("/") if p]
    if len(parts) < 2:
        return None
    if host and "." not in host:
        return None
    # 只取前两段：兼容粘贴浏览器地址栏的 .../tree/main 这类页面链接
    owner, name = parts[0], parts[1]
    return {
        "host": host or "github.com",
        "owner": owner,
        "name": name,
        "slug": "%s/%s" % (owner, name),
        "https": "https://%s/%s/%s.git" % (host or "github.com", owner, name),
        "web": "https://%s/%s/%s" % (host or "github.com", owner, name),
    }


def project_root():
    """项目根目录：源码运行时是 app/ 的上一级；打包后是可执行文件所在目录。"""
    if getattr(sys, "frozen", False):
        return os.path.dirname(os.path.abspath(sys.executable))
    return os.path.dirname(config.BASE_DIR)


# ============================================================================ Git 执行
def _git_env(cfg=None):
    env = os.environ.copy()
    env["GIT_TERMINAL_PROMPT"] = "0"
    items = []
    token = ((cfg or {}).get("token") or "").strip()
    if token:
        # 通过环境变量注入 http.extraheader，token 不会出现在进程命令行（ps 看不到）
        b64 = base64.b64encode(("x-access-token:" + token).encode("utf-8")).decode("ascii")
        items.append(("http.extraheader", "Authorization: Basic " + b64))
    proxy = ((cfg or {}).get("proxy") or "").strip()
    if proxy:
        # 代理同时作用于 API 与 git：服务器直连 github.com 不通时填这里即可
        items.append(("http.proxy", proxy))
        items.append(("https.proxy", proxy))
    if items:
        env["GIT_CONFIG_COUNT"] = str(len(items))
        for i, (key, value) in enumerate(items):
            env["GIT_CONFIG_KEY_%d" % i] = key
            env["GIT_CONFIG_VALUE_%d" % i] = value
    return env


def _scrub(text, cfg=None):
    """把可能回显出来的 token 抹掉。"""
    if not text:
        return text or ""
    token = ((cfg or {}).get("token") or "").strip()
    if token and len(token) > 4:
        text = text.replace(token, secret.mask(token))
    return text


def _git(args, cwd, cfg=None, timeout=60):
    """执行 git，返回 (returncode, stdout, stderr)；git 不存在时返回 (-1, '', 原因)。"""
    exe = shutil.which("git")
    if not exe:
        return -1, "", "未找到 git 命令，请先在服务器上安装 Git"
    try:
        proc = subprocess.run(
            [exe, "-c", "safe.directory=*", "-c", "core.quotepath=false"] + list(args),
            cwd=cwd, capture_output=True, text=True, errors="replace",
            timeout=timeout, stdin=subprocess.DEVNULL, env=_git_env(cfg),
        )
    except subprocess.TimeoutExpired:
        return -1, "", "git 命令执行超时（%ss）" % timeout
    except OSError as e:
        return -1, "", "git 执行失败：%s" % e
    return proc.returncode, proc.stdout or "", _scrub(proc.stderr or "", cfg)


def _git_out(args, cwd, cfg=None, timeout=60):
    rc, out, err = _git(args, cwd, cfg, timeout)
    return (out.strip() if rc == 0 else ""), ("" if rc == 0 else (err or out).strip())


def _split_log(out):
    """解析 `--format=%H%x1f%an%x1f%aI%x1f%s` 的输出。"""
    rows = []
    for line in (out or "").splitlines():
        parts = line.split("\x1f")
        if len(parts) < 4:
            continue
        sha, author, date, subject = parts[0], parts[1], parts[2], "\x1f".join(parts[3:])
        rows.append({
            "sha": sha,
            "short": sha[:7],
            "author": author,
            "date": date,
            "message": subject,
        })
    return rows


# ============================================================================ 本地状态
def local_state():
    """读取本地仓库状态（分支 / HEAD / 远端 / 是否有未提交改动）。"""
    root = project_root()
    out = {
        "root": root,
        "has_git": False,
        "branch": "",
        "sha": "",
        "short": "",
        "origin": "",
        "dirty": False,
        "dirty_files": [],
        "commit": None,
        "error": "",
    }
    if not os.path.isdir(root):
        out["error"] = "项目目录不存在：%s" % root
        return out
    if not shutil.which("git"):
        out["error"] = "服务器未安装 Git，无法在线更新"
        return out
    rc, top, err = _git(["rev-parse", "--show-toplevel"], root)
    if rc != 0:
        out["error"] = ("当前目录不是 Git 仓库（%s）；可点本页「初始化 Git 仓库」自动补装"
                        % (err or "缺少 .git 目录"))
        return out
    out["has_git"] = True
    out["root"] = top.strip() or root
    cwd = out["root"]

    branch, _ = _git_out(["rev-parse", "--abbrev-ref", "HEAD"], cwd)
    out["branch"] = branch if branch and branch != "HEAD" else ""
    sha, _ = _git_out(["rev-parse", "HEAD"], cwd)
    out["sha"] = sha
    out["short"] = sha[:7]
    origin, _ = _git_out(["remote", "get-url", "origin"], cwd)
    out["origin"] = origin
    log, _ = _git_out(["log", "-1", "--format=%H%x1f%an%x1f%aI%x1f%s"], cwd)
    commits = _split_log(log)
    out["commit"] = commits[0] if commits else None

    rc, status, _ = _git(["status", "--porcelain=v1"], cwd)
    if rc == 0:
        dirty = []
        for line in status.splitlines():
            if not line.strip():
                continue
            code, path = line[:2], line[3:].strip()
            if code.strip() == "??":
                continue          # 未跟踪文件一般不阻塞快进合并
            dirty.append(path)
        out["dirty"] = bool(dirty)
        out["dirty_files"] = dirty[:30]
    return out


def _resolve_repo(cfg):
    """确定要检查的仓库：优先配置，其次本地 origin。返回 (repo_dict|None, 来源说明)。"""
    if (cfg.get("repo") or "").strip():
        repo = parse_repo(cfg["repo"])
        if repo:
            return repo, "config"
    local = local_state()
    if local.get("origin"):
        repo = parse_repo(local["origin"])
        if repo:
            return repo, "origin"
    return None, ""


def _fetch_url(cfg, repo):
    """真正用于 git fetch / ls-remote 的地址：优先「Git 拉取地址」。

    典型场景：服务器能访问 api.github.com 但连不上 github.com 时，
    可以把这里填成 SSH（ssh://git@ssh.github.com:443/owner/repo.git）
    或 GitHub 加速镜像；检查与拉取都走它，API 检查仍按 repo 的 slug 进行。
    """
    return (cfg.get("remote_url") or "").strip() or repo["https"]


def _api_reachable(cfg, timeout=5):
    """快速探测 GitHub API 是否可达（用于给 git 超时做精准归因）。"""
    base = (cfg.get("api_base") or "https://api.github.com").rstrip("/")
    _data, err = _http_json(base + "/rate_limit", cfg, timeout)
    return err is None


# ============================================================================ GitHub API
def _http_json(url, cfg, timeout=20):
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "File_Flask-Updater",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    token = (cfg.get("token") or "").strip()
    if token:
        headers["Authorization"] = "Bearer " + token
    handlers = []
    proxy = (cfg.get("proxy") or "").strip()
    if proxy:
        handlers.append(urllib.request.ProxyHandler({"http": proxy, "https": proxy}))
    opener = urllib.request.build_opener(*handlers)
    req = urllib.request.Request(url, headers=headers)
    try:
        with opener.open(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", "replace")
        return json.loads(raw), None
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = e.read().decode("utf-8", "replace")[:300]
        except Exception:
            pass
        if e.code == 404:
            return None, "仓库 / 分支不存在（404），请检查仓库地址、分支名，以及令牌是否有读取权限"
        if e.code in (401, 403):
            return None, ("GitHub 拒绝访问（%s）：请检查访问令牌是否有效、是否有 repo 读取权限，"
                          "或 API 调用次数已超限" % e.code)
        return None, "GitHub API 返回 %s：%s" % (e.code, detail or "无详细信息")
    except urllib.error.URLError as e:
        return None, ("无法连接 GitHub API：%s。服务器可能没有外网 / 被墙，"
                      "可在下方配置代理，或把检查方式改成「git」" % e.reason)
    except Exception as e:
        return None, "请求 GitHub API 失败：%s" % e


def _api_commit(item):
    c = (item or {}).get("commit") or {}
    author = c.get("author") or {}
    sha = item.get("sha") or ""
    return {
        "sha": sha,
        "short": sha[:7],
        "author": author.get("name") or ((item.get("author") or {}).get("login") or ""),
        "date": author.get("date") or "",
        "message": (c.get("message") or "").splitlines()[0] if c.get("message") else "",
        "url": item.get("html_url") or "",
    }


def _check_api(cfg, repo, branch, local):
    base = (cfg.get("api_base") or "https://api.github.com").rstrip("/")
    url = "%s/repos/%s/commits?sha=%s&per_page=1" % (base, repo["slug"], quote(branch, safe=""))
    data, err = _http_json(url, cfg)
    if err:
        return None, err
    if not isinstance(data, list) or not data:
        return None, "分支 %s 在远端没有任何提交" % branch
    remote = _api_commit(data[0])
    result = {
        "remote": remote,
        "remote_sha": remote["sha"],
        "update_available": remote["sha"] != local.get("sha"),
        "behind": 0,
        "ahead": 0,
        "status": "",
        "commits": [remote],
        "hint": "",
    }
    if remote["sha"] == local.get("sha"):
        result["status"] = "identical"
        return result, None
    cmp_url = "%s/repos/%s/compare/%s...%s" % (base, repo["slug"], local.get("sha"), remote["sha"])
    cmp_data, cmp_err = _http_json(cmp_url, cfg)
    if isinstance(cmp_data, dict):
        result["status"] = cmp_data.get("status") or ""
        result["ahead"] = int(cmp_data.get("ahead_by") or 0)
        result["behind"] = int(cmp_data.get("behind_by") or 0)
        result["update_available"] = result["behind"] > 0
        commits = [_api_commit(x) for x in (cmp_data.get("commits") or [])]
        if commits:
            result["commits"] = commits[-60:]
        if result["status"] == "diverged":
            result["hint"] = ("本地与远端已经分叉（本地有 %d 个未推送提交），"
                              "直接更新会失败；需要先处理本地提交，或开启「允许强制覆盖」。"
                              % result["ahead"])
        elif result["status"] == "ahead":
            result["hint"] = "本地提交领先于远端，没有需要拉取的内容。"
    else:
        # compare 失败最常见的原因：本地 commit 还没 push，GitHub 上找不到 baseline。
        # 这时改用 git 自己算 ahead / behind，避免把「本地领先」误判成「有更新」。
        rel = _git_relations(cfg, repo, branch)
        if rel:
            result["ahead"] = rel["ahead"]
            result["behind"] = rel["behind"]
            result["status"] = rel["status"]
            result["update_available"] = rel["behind"] > 0
            if rel.get("commits"):
                result["commits"] = rel["commits"]
            if rel.get("remote"):
                result["remote"] = rel["remote"]
            result["hint"] = _relation_hint(result) or (
                "GitHub API 无法直接比较两端差异，已用 git 校准。")
        else:
            result["hint"] = ("无法比较本地与远端的提交差异（%s）。"
                              "本地可能还没有推送过，或 GitHub 上找不到这个 commit。"
                              % (cmp_err or ""))
    return result, None


def _git_relations(cfg, repo, branch):
    """fetch 后计算本地与远端的关系（只写 .git/FETCH_HEAD，不动工作区）。

    返回 {ahead, behind, status, commits（旧→新）, remote（远端最新一条）}；
    fetch 失败返回 None。用 rev-list 精确区分「本地领先 / 远端领先 / 双向分叉」，
    否则本地提交还没 push 时会误判成「有更新」。
    """
    root = project_root()
    rc, _out, err = _git(["fetch", "--quiet", "--no-tags", _fetch_url(cfg, repo), branch],
                         root, cfg, 90)
    if rc != 0:
        return None
    ahead = behind = 0
    status = ""
    counts, _ = _git_out(["rev-list", "--left-right", "--count", "HEAD...FETCH_HEAD"], root)
    if counts:
        parts = counts.split()
        if len(parts) >= 2:
            ahead, behind = int(parts[0]), int(parts[1])
            if ahead and behind:
                status = "diverged"
            elif ahead:
                status = "ahead"
            elif behind:
                status = "behind"
            else:
                status = "identical"
    log, _ = _git_out(["log", "HEAD..FETCH_HEAD", "-60", "--format=%H%x1f%an%x1f%aI%x1f%s"], root)
    commits = _split_log(log)                     # 新 → 旧
    head_log, _ = _git_out(["log", "FETCH_HEAD", "-1", "--format=%H%x1f%an%x1f%aI%x1f%s"], root)
    head = _split_log(head_log)
    return {
        "ahead": ahead,
        "behind": behind,
        "status": status,
        "commits": list(reversed(commits))[:60],  # 旧 → 新
        "remote": head[0] if head else None,
    }


def _relation_hint(result):
    """按 ahead / behind 生成一句人类可读的提示。"""
    if result.get("status") == "ahead":
        return ("本地提交领先于远端（%d 个还没推送），没有需要拉取的内容。"
                % result.get("ahead", 0))
    if result.get("status") == "diverged":
        return ("本地与远端已经分叉（本地 %d 个未推送、远端 %d 个新提交），"
                "直接更新会失败；需要先处理本地提交，或开启「允许强制覆盖」。"
                % (result.get("ahead", 0), result.get("behind", 0)))
    if result.get("status") == "identical":
        return "本地与远端完全一致。"
    return ""


def _check_git(cfg, repo, branch, local):
    """不依赖 GitHub API：ls-remote 取远端 sha，再 fetch 读取提交日志与领先 / 落后关系。"""
    url = _fetch_url(cfg, repo)
    # 检查阶段超时不宜太长：GitHub 连不上时要尽快把错误抛给用户
    rc, out, err = _git(["ls-remote", url, "refs/heads/%s" % branch], project_root(), cfg, 30)
    if rc != 0:
        msg = (err or out).strip()[:500] or "未知错误"
        if "超时" in msg or "timeout" in msg.lower():
            if _api_reachable(cfg):
                msg += ("。服务器能访问 GitHub API，但连不上 git 地址 %s："
                        "通常是 github.com 的 DNS 解析到了不可达 IP。"
                        "可在 /etc/hosts 把 github.com 指到可用 IP，"
                        "或在「更新配置 → API 代理」填代理，"
                        "或把「Git 拉取地址」改成 SSH（ssh://git@ssh.github.com:443/owner/repo.git）"
                        % url)
            else:
                msg += ("。请检查服务器网络；需要代理时在「更新配置 → API 代理」填写，"
                        "拉取地址不通也可以改用「Git 拉取地址」")
        return None, "读取远端分支失败：%s" % msg
    line = (out or "").strip().splitlines()
    if not line:
        return None, "远端没有分支 %s" % branch
    remote_sha = line[0].split()[0]
    result = {
        "remote": {"sha": remote_sha, "short": remote_sha[:7], "author": "", "date": "", "message": ""},
        "remote_sha": remote_sha,
        "update_available": remote_sha != local.get("sha"),
        "behind": 0,
        "ahead": 0,
        "status": "",
        "commits": [],
        "hint": "",
    }
    if remote_sha == local.get("sha"):
        result["status"] = "identical"
        result["update_available"] = False
        return result, None

    rel = _git_relations(cfg, repo, branch)
    if rel:
        result["ahead"] = rel["ahead"]
        result["behind"] = rel["behind"]
        result["status"] = rel["status"]
        result["update_available"] = rel["behind"] > 0
        if rel.get("commits"):
            result["commits"] = rel["commits"]
        if rel.get("remote"):
            result["remote"] = rel["remote"]
        result["hint"] = _relation_hint(result)
    else:
        _rc2, out2, err2 = _git(["fetch", "--quiet", url, branch], project_root(), cfg, 180)
        result["hint"] = "已拿到远端最新 commit（%s），但读取提交详情失败：%s" % (
            remote_sha[:7], ((err2 or out2) or "").strip()[:300])
    return result, None


def check_update(method=None):
    """检查是否有更新。不修改工作区。"""
    cfg = _raw_config()
    local = local_state()
    out = {
        "ok": False,
        "checked_at": time.time(),
        "local": local,
        "config": public_config(cfg),
        "repo": "",
        "repo_web": "",
        "repo_source": "",
        "branch": "",
        "remote": None,
        "remote_sha": "",
        "update_available": False,
        "ahead": 0,
        "behind": 0,
        "status": "",
        "commits": [],
        "method": "",
        "hint": "",
        "error": "",
    }
    if not local.get("has_git"):
        out["error"] = local.get("error") or "当前目录不是 Git 仓库，无法在线更新"
        return out

    repo, source = _resolve_repo(cfg)
    if not repo:
        out["error"] = "还没有配置 GitHub 仓库地址，且本地仓库没有 origin 远端"
        return out
    out["repo"] = repo["slug"]
    out["repo_web"] = repo["web"]
    out["repo_source"] = source
    branch = (cfg.get("branch") or local.get("branch") or "main").strip()
    out["branch"] = branch

    mode = (method or cfg.get("method") or "auto").strip().lower()
    if mode not in ("auto", "api", "git"):
        mode = "auto"
    api_error = ""
    if mode in ("auto", "api"):
        res, err = _check_api(cfg, repo, branch, local)
        if res:
            out.update(res)
            out["ok"] = True
            out["method"] = "api"
            out["config"] = public_config(cfg)
            return out
        api_error = err
        if mode == "api":
            out["error"] = err
            return out

    res, err = _check_git(cfg, repo, branch, local)
    if res:
        out.update(res)
        out["ok"] = True
        out["method"] = "git"
        if api_error:
            out["hint"] = ("GitHub API 不可用（%s），已改用 git 方式检查。" % api_error) + (out.get("hint") or "")
    else:
        out["error"] = err
        if api_error:
            out["error"] = "%s；git 方式同样失败：%s" % (api_error, err)
    return out


# ============================================================================ 更新执行
def _now():
    return time.time()


def _trim():
    """只保留最近若干个运行记录，避免内存无限增长。"""
    if len(_RUNS) <= _MAX_RUNS:
        return
    ordered = sorted(_RUNS.values(), key=lambda r: r.get("started_at") or 0)
    for run in ordered[:len(_RUNS) - _MAX_RUNS]:
        _RUNS.pop(run["id"], None)
    if _CURRENT["id"] not in _RUNS:
        _CURRENT["id"] = ""


def _new_run(kind):
    rid = "u" + uuid.uuid4().hex[:12]
    run = {
        "id": rid,
        "kind": kind,               # update / restart
        "status": "running",        # running / done / error
        "step": "init",
        "progress": 0,
        "events": [],
        "started_at": _now(),
        "updated_at": _now(),
        "finished_at": 0,
        "from": "",
        "to": "",
        "error": "",
        "result": "",
    }
    with _LOCK:
        _RUNS[rid] = run
        _CURRENT["id"] = rid
        _trim()
    return run


def _emit(run, text, level="info", progress=None, step=None):
    with _LOCK:
        run["events"].append({"t": _now(), "text": text, "level": level})
        if len(run["events"]) > 500:
            del run["events"][:len(run["events"]) - 500]
        if progress is not None:
            run["progress"] = max(0, min(100, int(progress)))
        if step:
            run["step"] = step
        run["updated_at"] = _now()
    _log.info("[在线更新] %s", text)


def _finish(run, status, message="", error=""):
    with _LOCK:
        if message:
            run["events"].append({"t": _now(), "text": message,
                                  "level": "error" if status == "error" else "ok"})
        run["status"] = status
        run["error"] = error
        run["finished_at"] = _now()
        run["updated_at"] = _now()
        if status == "done":
            run["progress"] = 100
    _save_last(run)


def _save_last(run):
    """把结果按任务类型分别落到 store_meta：重启会清空内存缓冲，重启后仍能看到上次结果。

    存储结构为 {任务类型: 结果}，页面上 Git / ZIP / 备份三个 Tab 各自回显自己的记录。
    """
    try:
        data = {
            "id": run.get("id"),
            "kind": run.get("kind"),
            "status": run.get("status"),
            "from": run.get("from"),
            "to": run.get("to"),
            "error": run.get("error"),
            "finished_at": run.get("finished_at") or _now(),
            "restart_mode": (load_config().get("restart_mode") or "none"),
            "events": (run.get("events") or [])[-60:],
        }
        try:
            raw = get_meta(_LAST_KEY)
            all_last = json.loads(raw) if raw else {}
        except Exception:
            all_last = {}
        if not isinstance(all_last, dict) or "events" in all_last:
            all_last = {}          # 旧版是单条记录，直接按新结构重建
        all_last[run.get("kind") or "update"] = data
        set_meta(_LAST_KEY, json.dumps(all_last, ensure_ascii=False))
    except Exception as e:
        _log.warning("保存更新结果失败: %s", e)


def last_result(kind=None):
    """上次执行结果。

    不传 kind 返回全部（{任务类型: 结果}）；传 kind 只返回该类型的单条，
    没有记录时返回 None。
    """
    try:
        raw = get_meta(_LAST_KEY)
        data = json.loads(raw) if raw else {}
    except Exception:
        data = {}
    if not isinstance(data, dict) or "events" in data:
        data = {}                  # 旧版单条格式视为无记录
    if kind:
        return data.get(kind)
    return data


def get_run(run_id):
    with _LOCK:
        run = _RUNS.get(run_id)
        if not run:
            return None
        snap = dict(run)
        snap["events"] = list(run.get("events") or [])
        return snap


def current_run():
    with _LOCK:
        rid = _CURRENT["id"]
    return get_run(rid) if rid else None


def has_running():
    run = current_run()
    return bool(run and run.get("status") == "running")


def _changed_files(root, old_sha, new_sha):
    out, _err = _git_out(["diff", "--name-only", old_sha, new_sha], root, None, 60)
    return [x.strip() for x in out.splitlines() if x.strip()]


def _pip_install(root, run):
    """执行 pip install -r requirements.txt，优先使用当前运行环境 / 项目 .venv。"""
    req = os.path.join(root, "requirements.txt")
    if not os.path.isfile(req):
        _emit(run, "没有 requirements.txt，跳过依赖安装", "warn")
        return True
    exe = sys.executable
    in_venv = sys.prefix != getattr(sys, "base_prefix", sys.prefix)
    if not in_venv:
        candidates = [os.path.join(root, ".venv", "bin", "python"),
                      os.path.join(root, ".venv", "Scripts", "python.exe")]
        for c in candidates:
            if os.path.isfile(c):
                exe = c
                break
    _emit(run, "使用 %s 安装依赖…" % exe)
    try:
        proc = subprocess.run([exe, "-m", "pip", "install", "-r", "requirements.txt"],
                              cwd=root, capture_output=True, text=True,
                              errors="replace", timeout=900)
    except subprocess.TimeoutExpired:
        _emit(run, "依赖安装超时（15 分钟），请手动执行 pip install -r requirements.txt", "error")
        return False
    except OSError as e:
        _emit(run, "依赖安装失败：%s" % e, "error")
        return False
    tail = ((proc.stdout or "") + "\n" + (proc.stderr or "")).strip().splitlines()[-12:]
    for line in tail:
        if line.strip():
            _emit(run, "  " + line.strip()[:400], "dim")
    if proc.returncode != 0:
        _emit(run, "依赖安装失败（退出码 %s），服务仍会尝试重启，请检查上面的输出"
              % proc.returncode, "error")
        return False
    _emit(run, "依赖安装完成", "ok")
    return True


# ---------------------------------------------------------------------------- 重启
def _can_self_exec():
    argv0 = os.path.basename(sys.argv[0] or "").lower()
    for bad in ("gunicorn", "uwsgi", "hypercorn", "daphne", "waitress", "celery",
                "flask", "uvicorn"):
        if bad in argv0:
            return False, ("当前由 %s 启动，自动替换进程不可靠。建议改用「退出进程，由守护进程拉起」"
                           "或「自定义重启命令」。" % argv0)
    if (sys.argv[0] or "").endswith("__main__.py"):
        return False, ("当前通过 `python -m` 方式启动，自动替换进程不可靠。"
                       "建议改用「退出进程，由守护进程拉起」或「自定义重启命令」。")
    return True, ""


def _spawn_self():
    """os.execv 原地替换当前进程（保留 pid / 环境变量 / 监听端口配置）。"""
    if getattr(sys, "frozen", False):
        argv = [sys.executable] + list(sys.argv[1:])
    else:
        argv = [sys.executable] + list(sys.argv)
    os.execv(sys.executable, argv)


def _do_restart(cfg, run):
    """执行重启，返回给前端看的说明字符串。"""
    mode = (cfg.get("restart_mode") or "none").strip()
    root = project_root()

    if mode == "none":
        _emit(run, "已按配置跳过重启：请手动重启服务，新代码才会生效", "warn")
        return "manual"

    if mode == "command":
        cmd = (cfg.get("restart_cmd") or "").strip()
        if not cmd:
            _emit(run, "没有填写重启命令，请手动重启服务", "warn")
            return "manual"
        _emit(run, "执行重启命令：%s" % cmd, "warn")
        log_path = os.path.join(config.DATA_ROOT, "update_restart.log")
        try:
            with open(log_path, "ab") as fp:
                subprocess.Popen(cmd, shell=True, cwd=root, start_new_session=True,
                                 stdin=subprocess.DEVNULL, stdout=fp, stderr=fp)
        except Exception as e:
            _emit(run, "重启命令执行失败：%s，请手动重启" % e, "error")
            return "manual"
        return "command"

    if mode == "exit":
        _emit(run, "更新完成，服务将退出，等待 systemd / supervisor / pm2 自动拉起…", "warn")
        _emit(run, "注意：守护进程必须配置了「自动重启」，否则服务会停在这里", "warn")
        with _LOCK:
            run["status"] = "restarting"
            run["result"] = "退出进程等待守护进程拉起"
        _save_last(run)
        timer = threading.Timer(2.0, lambda: os._exit(0))
        timer.daemon = True
        timer.start()
        return "exit"

    # exec
    ok, why = _can_self_exec()
    if not ok:
        _emit(run, why, "error")
        return "manual"
    _emit(run, "服务将在 2 秒后原地重启（页面会短暂断连，稍后自动恢复）…", "warn")
    with _LOCK:
        run["status"] = "restarting"
        run["result"] = "原地重启（os.execv）"
    _save_last(run)

    def _boot():
        time.sleep(2.0)
        try:
            _spawn_self()
        except Exception as e:                 # execv 失败：至少不要静默死掉
            _log.error("自动重启失败: %s", e)
            os._exit(1)

    timer = threading.Timer(0.1, _boot)
    timer.daemon = True
    timer.start()
    return "exec"


def _worker_update(run, cfg, reset):
    root = project_root()
    try:
        local = local_state()
        if not local.get("has_git"):
            raise RuntimeError(local.get("error") or "当前目录不是 Git 仓库")
        root = local["root"]
        _emit(run, "项目目录：%s" % root, "dim", 5, "init")
        _emit(run, "本地版本：%s %s" % (local["short"] or "(空)",
                                      (local.get("commit") or {}).get("message", "")), "dim")
        run["from"] = local["sha"]

        repo, _source = _resolve_repo(cfg)
        if not repo:
            raise RuntimeError("没有配置 GitHub 仓库地址，且本地仓库没有 origin 远端")
        branch = (cfg.get("branch") or local.get("branch") or "main").strip()
        if not branch:
            raise RuntimeError("无法确定要更新的分支，请在配置里填写分支名")
        _emit(run, "远端仓库：%s（分支 %s）" % (repo["slug"], branch), "info", 10, "fetch")

        fetch_url = _fetch_url(cfg, repo)
        _emit(run, "正在拉取最新代码…（%s）" % fetch_url, "info", 15)
        refspec = "+refs/heads/%s:refs/remotes/origin/%s" % (branch, branch)
        rc, out, err = _git(["fetch", "--no-tags", fetch_url, refspec], root, cfg, 300)
        if rc != 0:
            detail = (err or out).strip()[:800] or "未知错误"
            if "超时" in detail or "timeout" in detail.lower():
                detail += ("。连不上 %s：可配置代理，或把「Git 拉取地址」改成 "
                           "ssh://git@ssh.github.com:443/owner/repo.git" % fetch_url)
            raise RuntimeError("拉取失败：%s" % detail)

        new_sha, _ = _git_out(["rev-parse", "refs/remotes/origin/%s" % branch], root)
        if not new_sha:
            raise RuntimeError("拉取成功但读不到远端 HEAD，请检查分支 %s 是否存在" % branch)
        run["to"] = new_sha

        if new_sha == local["sha"]:
            _emit(run, "远端没有新提交，已是最新版本（%s）" % new_sha[:7], "ok", 100)
            _finish(run, "done", "已是最新版本，无需更新")
            return

        # 确认有更新后、改动工作区之前整份备份当前代码；备份失败直接中止
        _backup_or_raise(run, cfg, root, "pre", 25)

        _emit(run, "发现新版本：%s → %s" % (local["short"] or "(空)", new_sha[:7]), "ok", 28, "merge")
        if reset:
            _emit(run, "按「强制覆盖」执行 git reset --hard…", "warn", 30)
            rc, out, err = _git(["reset", "--hard", new_sha], root)
            if rc != 0:
                raise RuntimeError("强制覆盖失败：%s" % ((err or out).strip()[:500]))
        else:
            if local.get("dirty"):
                files = "、".join(local.get("dirty_files") or [])[:400]
                raise RuntimeError("本地有未提交改动（%s），为避免丢失已中止更新。"
                                   "请先提交 / 还原改动，或在配置中开启「允许强制覆盖」后重试" % files)
            _emit(run, "正在合并（--ff-only）…", "info", 35)
            rc, out, err = _git(["merge", "--ff-only", new_sha], root)
            if rc != 0:
                raise RuntimeError("无法快进合并：%s。本地可能有未推送的提交，"
                                   "请手动处理后重试，或开启「允许强制覆盖」"
                                   % (((out or "") + (err or "")).strip()[:600]))

        after = local_state()
        _emit(run, "代码已更新到 %s" % (after.get("short") or new_sha[:7]), "ok", 60, "deps")

        changed = _changed_files(root, local["sha"], new_sha)
        dep_files = [f for f in changed if os.path.basename(f) in
                     ("requirements.txt", "pyproject.toml", "package.json")]
        if dep_files:
            _emit(run, "本次更新涉及的依赖文件：%s" % "、".join(dep_files[:10]), "info", 65)
        if "requirements.txt" in dep_files:
            if cfg.get("install_deps"):
                _pip_install(root, run)
            else:
                _emit(run, "requirements.txt 有变化，但未开启「自动安装依赖」，请手动执行 "
                           "pip install -r requirements.txt", "warn")
        else:
            _emit(run, "依赖文件无变化，跳过安装", "dim", 75)

        _emit(run, "准备重启服务…", "info", 90, "restart")
        mode = _do_restart(cfg, run)
        if mode == "manual":
            _finish(run, "done", "代码更新完成；请手动重启服务使新代码生效")
        elif mode == "command":
            _finish(run, "done", "代码更新完成，已下发重启命令")
        # exec / exit：进程即将被替换，run 状态已置为 restarting 并落库，
        # 这里不再改写，避免和重启后的状态判断冲突。
    except Exception as e:
        _finish(run, "error", str(e), error=str(e))
        _log.error("[在线更新] 失败: %s", e)


def _worker_restart(run, cfg):
    try:
        _emit(run, "只执行重启，不拉取代码…", "info", 30, "restart")
        mode = _do_restart(cfg, run)
        if mode == "manual":
            _finish(run, "done", "未执行自动重启，请手动重启服务")
        elif mode == "command":
            _finish(run, "done", "已下发重启命令")
    except Exception as e:
        _finish(run, "error", str(e), error=str(e))


# ============================================================================ 初始化仓库
def _remote_default_branch(cfg, url, timeout=30):
    """读远端 HEAD 指向的默认分支（`git ls-remote --symref`）。

    ZIP 解压安装的目录里没有分支信息，用它来自动对齐到 main / master，
    省得用户还要去猜该填哪个分支名。
    """
    rc, out, _err = _git(["ls-remote", "--symref", url, "HEAD"], project_root(), cfg, timeout)
    if rc != 0:
        return ""
    for line in (out or "").splitlines():
        line = line.strip()
        if not line.startswith("ref:"):
            continue
        parts = line.split()
        if len(parts) >= 2 and parts[1].startswith("refs/heads/"):
            return parts[1][len("refs/heads/"):]
    return ""


def _worker_init(run, cfg):
    """把「下载 ZIP 解压」的目录变成真正的 Git 仓库，与远端分支对齐。

    只覆盖版本库里存在的同名文件（checkout -f）；data/、.env、虚拟环境、
    logs/ 等被 .gitignore 排除的内容不在远端树里，因此不受影响。
    """
    root = project_root()
    try:
        if not os.path.isdir(root):
            raise RuntimeError("项目目录不存在：%s" % root)
        repo, _source = _resolve_repo(cfg)
        if not repo:
            raise RuntimeError("请先填写 GitHub 仓库地址（如 owner/repo 或 https://github.com/owner/repo）")
        url = _fetch_url(cfg, repo)
        _emit(run, "项目目录：%s" % root, "dim", 5, "init")
        _emit(run, "远端仓库：%s → %s" % (repo["slug"], url), "info")
        branch = (cfg.get("branch") or "").strip() or _remote_default_branch(cfg, url) or "main"
        _emit(run, "目标分支：%s" % branch, "info", 10)

        rc, out, err = _git(["init", "-q"], root, cfg, 60)
        if rc != 0:
            raise RuntimeError("git init 失败：%s" % ((err or out).strip()[:500] or "未知错误"))
        _emit(run, "本地仓库已就绪（%s/.git）" % root, "ok", 20, "fetch")

        # origin 指向真正用于拉取的地址（可能是 SSH / 镜像，而不是 https）
        rc, out, _err = _git(["remote", "get-url", "origin"], root, cfg, 30)
        if rc == 0 and (out or "").strip():
            rc, out, err = _git(["remote", "set-url", "origin", url], root, cfg, 30)
            action = "已更新 origin 远端"
        else:
            rc, out, err = _git(["remote", "add", "origin", url], root, cfg, 30)
            action = "已关联 origin 远端"
        if rc != 0:
            raise RuntimeError("配置 origin 远端失败：%s" % ((err or out).strip()[:500] or "未知错误"))
        _emit(run, "%s：%s" % (action, url), "ok", 30)

        _emit(run, "正在拉取远端代码…（首次拉取可能较慢）", "info", 40)
        refspec = "+refs/heads/%s:refs/remotes/origin/%s" % (branch, branch)
        rc, out, err = _git(["fetch", "--no-tags", url, refspec], root, cfg, 600)
        if rc != 0:
            detail = ((err or out).strip()[:600]) or "未知错误"
            if "超时" in detail or "timeout" in detail.lower():
                detail += ("。连不上 %s：可在「更新配置 → API 代理」填代理，"
                           "或把「Git 拉取地址」改成 ssh://git@ssh.github.com:443/owner/repo.git" % url)
            raise RuntimeError("拉取失败：%s" % detail)
        sha, _ = _git_out(["rev-parse", "refs/remotes/origin/%s" % branch], root, cfg)
        if not sha:
            raise RuntimeError("拉取成功但读不到分支 %s，请检查分支名是否正确" % branch)
        run["to"] = sha
        _emit(run, "远端最新提交：%s" % sha[:7], "ok", 50, "merge")

        tracked, _ = _git_out(
            ["ls-tree", "-r", "--name-only", "refs/remotes/origin/%s" % branch], root, cfg, 180)
        names = [x.strip() for x in tracked.splitlines() if x.strip()]
        hit = [p for p in names if os.path.exists(os.path.join(root, p))]
        if hit:
            _emit(run, "将用远端版本覆盖 %d 个同名文件（data/、.env、虚拟环境、日志不在版本库内，不会被删除）"
                  % len(hit), "warn")
            for p in hit[:8]:
                _emit(run, "  ＊ %s" % p, "dim")
            if len(hit) > 8:
                _emit(run, "  … 其余 %d 个文件" % (len(hit) - 8), "dim")

        _emit(run, "正在切换到分支 %s…" % branch, "info", 70)
        rc, out, err = _git(["checkout", "-f", "-B", branch, "refs/remotes/origin/%s" % branch],
                            root, cfg, 300)
        if rc != 0:
            raise RuntimeError("切换分支失败：%s" % ((err or out).strip()[:600] or "未知错误"))
        # checkout -B 的起点是 refs/remotes/... 时不会自动建立跟踪，这里补一下
        _git(["branch", "--set-upstream-to=origin/%s" % branch, branch], root, cfg, 30)

        after = local_state()
        if not after.get("has_git"):
            raise RuntimeError("初始化后仍无法识别为 Git 仓库：%s" % (after.get("error") or "未知错误"))
        _emit(run, "本地版本：%s %s" % (after.get("short") or sha[:7],
                                     (after.get("commit") or {}).get("message", "")), "ok", 100)
        _finish(run, "done", "已初始化为 Git 仓库（%s @ %s），现在可以检查更新了"
                % (after.get("branch") or branch, after.get("short") or sha[:7]))
    except Exception as e:
        _finish(run, "error", str(e), error=str(e))
        _log.error("[初始化仓库] 失败: %s", e)


def start_init():
    """启动「把当前目录初始化为 Git 仓库」的后台任务：返回 (run_id, 错误信息)。"""
    with _LOCK:
        if has_running():
            return "", "已有更新 / 重启任务在执行，请等待完成"
    if not shutil.which("git"):
        return "", "服务器未安装 Git，请先安装（apt install -y git / yum install -y git）"
    local = local_state()
    # 只有「已有提交」才算真正的仓库；上一次初始化中途失败的半成品仓库允许继续补齐
    if local.get("has_git") and local.get("sha"):
        return "", "当前目录已经是 Git 仓库（%s @ %s），无需初始化" % (
            local.get("root"), local.get("short"))
    cfg = _raw_config()
    repo, _source = _resolve_repo(cfg)
    if not repo:
        return "", "请先在「更新配置」里填写 GitHub 仓库地址再初始化"
    run = _new_run("init")
    t = threading.Thread(target=_worker_init, args=(run, cfg), name="online-init", daemon=True)
    t.start()
    return run["id"], ""


# ============================================================================ 代码备份
_BACKUP_DIRNAME = "update_backup"        # 备份统一放 data/update_backup/
_BACKUP_KEEP = 10                        # 只保留最近 10 份，避免把磁盘占满
_BACKUP_SKIP_TOP = {".git", ".hg", ".svn", "data", "logs", ".venv", "venv", ".buildenv",
                    "__pycache__", "node_modules", ".upload_tmp", "build", "dist"}
_BACKUP_SKIP_NAMES = {".DS_Store", "Thumbs.db", "desktop.ini"}
_BACKUP_SKIP_EXT = (".pyc", ".pyo", ".log", ".mp4", ".tmp", ".swp")
_BACKUP_MAX_FILE = 30 * 1024 * 1024      # 单文件超大（多为误放的媒体文件）跳过


def backup_dir():
    """备份目录（绝对路径）。"""
    return os.path.join(config.DATA_ROOT, _BACKUP_DIRNAME)


def _prune_backups(out_dir, keep=_BACKUP_KEEP):
    """只保留最近 keep 份备份（按修改时间排序，前缀不同也不会误删新的）。"""
    try:
        names = [f for f in os.listdir(out_dir) if f.endswith(".zip")]
        names.sort(key=lambda f: os.path.getmtime(os.path.join(out_dir, f)))
    except OSError:
        return
    for name in (names[:-keep] if len(names) > keep else []):
        try:
            os.remove(os.path.join(out_dir, name))
        except OSError:
            pass


def _backup_project(root, tag="pre"):
    """把当前项目「代码」打包到 data/update_backup/，返回 {path, files, size, skipped}。

    跳过 data/（运行数据、上传的文件、store.db）、logs/、虚拟环境、.git、
    __pycache__、node_modules、构建产物；单文件超过 30MB 的也跳过。
    `.env` 会一起打包，方便回滚到原来的配置。
    """
    out_dir = backup_dir()
    try:
        os.makedirs(out_dir, exist_ok=True)
    except OSError as e:
        raise RuntimeError("无法创建备份目录（%s）：%s" % (out_dir, e))
    path = os.path.join(out_dir, "%s_%s.zip" % (tag, time.strftime("%Y%m%d_%H%M%S")))
    files = 0
    size = 0
    skipped = 0
    try:
        with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
            for dirpath, dirnames, filenames in os.walk(root):
                depth = 0 if os.path.normpath(dirpath) == os.path.normpath(root) else \
                    os.path.relpath(dirpath, root).count(os.sep) + 1
                if depth == 0:
                    dirnames[:] = [d for d in dirnames if d not in _BACKUP_SKIP_TOP]
                else:
                    dirnames[:] = [d for d in dirnames if d not in ("__pycache__", ".git")]
                dirnames.sort()
                for name in sorted(filenames):
                    if name in _BACKUP_SKIP_NAMES or name.endswith(_BACKUP_SKIP_EXT):
                        continue
                    abs_path = os.path.join(dirpath, name)
                    try:
                        fsize = os.path.getsize(abs_path)
                        if fsize > _BACKUP_MAX_FILE:
                            skipped += 1
                            continue
                        zf.write(abs_path, os.path.relpath(abs_path, root))
                    except OSError:
                        skipped += 1
                        continue
                    files += 1
                    size += fsize
    except Exception as e:
        try:
            os.remove(path)
        except OSError:
            pass
        raise RuntimeError("备份当前代码失败：%s" % e)
    _prune_backups(out_dir)
    _log.info("[备份] %s：%d 个文件，%.2f MB → %s", tag, files, size / 1048576.0, path)
    return {"path": path, "files": files, "size": size, "skipped": skipped,
            "name": os.path.basename(path)}


def _backup_or_raise(run, cfg, root, tag="pre", progress=6):
    """按配置在更新前备份代码；备份失败直接抛错，避免「没备份就更新」。"""
    if not cfg.get("backup_before_update", True):
        _emit(run, "已关闭「更新前自动备份」，跳过备份", "warn", progress, "backup")
        return None
    _emit(run, "正在备份当前代码…", "info", progress, "backup")
    info = _backup_project(root, tag)
    _emit(run, "已备份 %d 个文件（%.2f MB）→ %s%s"
          % (info["files"], info["size"] / 1048576.0, info["path"],
             ("，跳过 %d 个超大 / 临时文件" % info["skipped"]) if info["skipped"] else ""),
          "ok", progress + 2)
    return info


_BACKUP_LABELS = {"pre": "更新前自动", "manual": "手动备份", "restore": "恢复前自动"}


def backup_name_ok(name):
    """备份文件名只允许 data/update_backup 下的纯文件名，挡掉目录穿越。"""
    name = (name or "").strip()
    if (not name or name.startswith(".") or name != os.path.basename(name)
            or "/" in name or "\\" in name or not name.endswith(".zip")):
        return ""
    return name


def backup_path(name):
    """备份文件的绝对路径；名字不合法返回空串。"""
    good = backup_name_ok(name)
    return os.path.join(backup_dir(), good) if good else ""


def list_backups():
    """备份记录列表（新 → 旧）：文件名 / 类型 / 大小 / 时间 / 文件数。"""
    out = []
    d = backup_dir()
    try:
        names = os.listdir(d)
    except OSError:
        return out
    for name in names:
        if not name.endswith(".zip"):
            continue
        path = os.path.join(d, name)
        try:
            st = os.stat(path)
        except OSError:
            continue
        files = -1
        try:
            with zipfile.ZipFile(path) as zf:
                files = len([i for i in zf.infolist() if not i.is_dir()])
        except Exception:
            files = -1
        tag = name.split("_", 1)[0]
        out.append({
            "name": name,
            "tag": tag,
            "label": _BACKUP_LABELS.get(tag, tag),
            "size": st.st_size,
            "ts": st.st_mtime,
            "files": files,
            "broken": files < 0,
        })
    out.sort(key=lambda x: x["ts"], reverse=True)
    return out


def delete_backup(name):
    """删除一份备份：成功返回空串，失败返回错误信息。"""
    path = backup_path(name)
    if not path:
        return "备份文件名不合法"
    if not os.path.isfile(path):
        return "备份不存在（可能已被清理）"
    try:
        os.remove(path)
    except OSError as e:
        return "删除失败：%s" % e
    _log.info("[备份] 已删除 %s", name)
    return ""


def _worker_restore(run, cfg, name, zip_path):
    """把项目代码恢复到指定备份（改文件前会先给当前代码再做一份备份）。"""
    root = project_root()
    work = os.path.join(config.DATA_ROOT, "update_uploads", "r" + uuid.uuid4().hex[:8])
    try:
        if not os.path.isdir(root):
            raise RuntimeError("项目目录不存在：%s" % root)
        _emit(run, "项目目录：%s" % root, "dim", 5, "init")
        _emit(run, "备份文件：%s（%.2f MB）"
              % (name, os.path.getsize(zip_path) / 1048576.0), "info")
        if not zipfile.is_zipfile(zip_path):
            raise RuntimeError("备份文件已损坏（不是有效的 ZIP），无法恢复")

        os.makedirs(work, exist_ok=True)
        _emit(run, "正在解压备份…", "info", 10)
        # 备份包是把项目根直接打包的，不需要剥外层目录；.env 也要一起还原
        _safe_extract(zip_path, work)
        items, skipped = _zip_plan(work, set())
        if not items:
            raise RuntimeError("备份包里没有任何文件，无法恢复")
        _emit(run, "备份包内 %d 个文件%s" % (len(items),
              ("（跳过 %d 个系统文件）" % skipped) if skipped else ""), "info", 15, "backup")

        # 先给当前代码做一份备份，恢复错了还能再回来
        _emit(run, "正在备份当前代码（恢复前快照）…", "info", 20, "backup")
        info = _backup_project(root, "restore")
        _emit(run, "已备份当前代码：%s（%d 个文件）" % (info["name"], info["files"]), "ok", 28)

        req_before = _file_digest(os.path.join(root, "requirements.txt"))
        copied = 0
        rels = set()
        for rel, abs_src in items:
            dst = os.path.join(root, rel)
            parent = os.path.dirname(dst)
            if parent:
                os.makedirs(parent, exist_ok=True)
            shutil.copy2(abs_src, dst)
            rels.add(rel)
            copied += 1
        _emit(run, "已还原 %d 个文件到 %s" % (copied, name), "ok", 60, "merge")

        extra = [r for r in _project_source_files(root) if r not in rels]
        if extra:
            _emit(run, "提示：当前目录有 %d 个文件不在这份备份里（备份之后新增的），未删除%s"
                  % (len(extra), "：" + "、".join(extra[:6]) if extra else ""), "warn")

        if local_state().get("has_git"):
            _emit(run, "提示：当前目录是 Git 仓库，恢复后这些文件会显示为「已修改」；"
                       "如需用 Git 方式更新，请先处理本地改动", "warn")

        req_after = _file_digest(os.path.join(root, "requirements.txt"))
        if req_before and req_before != req_after:
            if cfg.get("install_deps"):
                _pip_install(root, run)
            else:
                _emit(run, "requirements.txt 有变化，但未开启「自动安装依赖」，请手动执行 "
                           "pip install -r requirements.txt", "warn")
        else:
            _emit(run, "依赖文件无变化，跳过安装", "dim", 78)

        _emit(run, "准备重启服务…", "info", 90, "restart")
        mode = _do_restart(cfg, run)
        if mode == "manual":
            _finish(run, "done", "已恢复到 %s；请手动重启服务使旧代码生效" % name)
        elif mode == "command":
            _finish(run, "done", "已恢复到 %s，已下发重启命令" % name)
    except Exception as e:
        _finish(run, "error", str(e), error=str(e))
        _log.error("[恢复备份] 失败: %s", e)
    finally:
        shutil.rmtree(work, ignore_errors=True)


def _project_source_files(root):
    """当前项目里属于「代码」的相对路径清单（与备份的排除规则一致）。"""
    out = []
    for dirpath, dirnames, filenames in os.walk(root):
        depth = 0 if os.path.normpath(dirpath) == os.path.normpath(root) else \
            os.path.relpath(dirpath, root).count(os.sep) + 1
        if depth == 0:
            dirnames[:] = [d for d in dirnames if d not in _BACKUP_SKIP_TOP]
        else:
            dirnames[:] = [d for d in dirnames if d not in ("__pycache__", ".git")]
        for name in filenames:
            if name in _BACKUP_SKIP_NAMES or name.endswith(_BACKUP_SKIP_EXT):
                continue
            out.append(os.path.relpath(os.path.join(dirpath, name), root))
    return out


def _worker_backup(run, _cfg):
    """手动备份：只打包当前代码，不改动任何文件。"""
    root = project_root()
    try:
        if not os.path.isdir(root):
            raise RuntimeError("项目目录不存在：%s" % root)
        _emit(run, "项目目录：%s" % root, "dim", 5, "init")
        _emit(run, "正在打包当前代码…", "info", 20, "backup")
        info = _backup_project(root, "manual")
        _emit(run, "备份完成：%d 个文件，%.2f MB" % (info["files"], info["size"] / 1048576.0),
              "ok", 90)
        _emit(run, "文件位置：%s" % info["path"], "info", 100)
        _finish(run, "done", "代码备份完成：%s" % info["name"])
    except Exception as e:
        _finish(run, "error", str(e), error=str(e))
        _log.error("[备份] 失败: %s", e)


def start_backup():
    """启动一次代码备份（后台线程）：返回 (run_id, 错误信息)。"""
    with _LOCK:
        if has_running():
            return "", "已有更新 / 备份任务在执行，请等待完成"
    if not os.path.isdir(project_root()):
        return "", "项目目录不存在：%s" % project_root()
    run = _new_run("backup")
    t = threading.Thread(target=_worker_backup, args=(run, _raw_config()),
                         name="online-backup", daemon=True)
    t.start()
    return run["id"], ""


def start_restore(name):
    """把项目恢复到指定备份：返回 (run_id, 错误信息)。"""
    with _LOCK:
        if has_running():
            return "", "已有更新 / 备份 / 恢复任务在执行，请等待完成"
    path = backup_path(name)
    if not path:
        return "", "备份文件名不合法"
    if not os.path.isfile(path):
        return "", "备份不存在（可能已被清理）"
    if not os.path.isdir(project_root()):
        return "", "项目目录不存在：%s" % project_root()
    cfg = _raw_config()
    if (cfg.get("restart_mode") or "") == "command" and not (cfg.get("restart_cmd") or "").strip():
        return "", "重启方式选了「自定义命令」，但没有填写命令"
    run = _new_run("restore")
    t = threading.Thread(target=_worker_restore,
                         args=(run, cfg, os.path.basename(path), path),
                         name="online-restore", daemon=True)
    t.start()
    return run["id"], ""


# ============================================================================ ZIP 包更新
_ZIP_SKIP_TOP = {".git", ".hg", ".svn", "data", "logs", ".venv", "venv", ".buildenv",
                 "__pycache__", "build", "dist", "node_modules", ".upload_tmp"}
_ZIP_SKIP_NAMES = {".env", ".DS_Store", "Thumbs.db", "desktop.ini"}
_ZIP_MAX_FILES = 20000
_ZIP_MAX_BYTES = 800 * 1024 * 1024       # 解压后总量上限，防止压缩炸弹


def _safe_extract(zip_path, dest):
    """解压到 dest：拦掉目录穿越（../、绝对路径）与超大解压体积。"""
    total = 0
    count = 0
    with zipfile.ZipFile(zip_path) as zf:
        for info in zf.infolist():
            name = (info.filename or "").replace("\\", "/")
            parts = [p for p in name.split("/") if p not in ("", ".")]
            if name.startswith("/") or ".." in parts:
                raise RuntimeError("压缩包内含非法路径：%s" % info.filename)
            target = os.path.realpath(os.path.join(dest, name))
            if target != dest and not target.startswith(dest + os.sep):
                raise RuntimeError("压缩包内含非法路径：%s" % info.filename)
            if not info.is_dir():
                count += 1
                total += int(info.file_size or 0)
                if count > _ZIP_MAX_FILES:
                    raise RuntimeError("压缩包内文件过多（超过 %d 个），已中止" % _ZIP_MAX_FILES)
                if total > _ZIP_MAX_BYTES:
                    raise RuntimeError("压缩包解压后超过 %dMB，已中止"
                                       % (_ZIP_MAX_BYTES // 1024 // 1024))
        zf.extractall(dest)


def _zip_source_root(dest):
    """GitHub 的 ZIP 会套一层 `repo-main/`；剥掉这层，返回真正的项目根。"""
    try:
        entries = [e for e in os.listdir(dest) if e != "__MACOSX"]
    except OSError:
        return dest
    if len(entries) == 1:
        only = os.path.join(dest, entries[0])
        if os.path.isdir(only):
            return only
    return dest


def _zip_plan(src, skip_names=None):
    """列出压缩包里要写入项目的文件：[(相对路径, 源文件绝对路径)]，以及跳过的数量。

    `skip_names` 传空集合时连 .env 一起还原（恢复备份时用）。
    """
    skip = _ZIP_SKIP_NAMES if skip_names is None else skip_names
    items = []
    skipped = 0
    for dirpath, dirnames, filenames in os.walk(src):
        depth = 0 if os.path.normpath(dirpath) == os.path.normpath(src) else \
            os.path.relpath(dirpath, src).count(os.sep) + 1
        if depth == 0:
            dirnames[:] = [d for d in dirnames if d not in _ZIP_SKIP_TOP]
        else:
            dirnames[:] = [d for d in dirnames if d not in ("__pycache__", ".git")]
        dirnames.sort()
        for name in sorted(filenames):
            rel = os.path.relpath(os.path.join(dirpath, name), src)
            top = rel.split(os.sep)[0]
            if (name in skip or name.endswith((".pyc", ".pyo"))
                    or top in _ZIP_SKIP_TOP or rel.startswith("..")):
                skipped += 1
                continue
            items.append((rel, os.path.join(dirpath, name)))
    return items, skipped


def _file_digest(path):
    try:
        with open(path, "rb") as fp:
            return hashlib.sha1(fp.read()).hexdigest()
    except OSError:
        return ""


def _worker_zip(run, cfg, zip_path, filename):
    """解压上传的源码包并覆盖到项目目录（不碰 data/、.env 等运行时数据）。"""
    root = project_root()
    work = os.path.join(config.DATA_ROOT, "update_uploads", "x" + uuid.uuid4().hex[:8])
    try:
        if not os.path.isdir(root):
            raise RuntimeError("项目目录不存在：%s" % root)
        size_mb = os.path.getsize(zip_path) / 1024.0 / 1024.0
        _emit(run, "压缩包：%s（%.2f MB）" % (filename, size_mb), "info", 5, "init")
        if not zipfile.is_zipfile(zip_path):
            raise RuntimeError("上传的文件不是有效的 ZIP 压缩包")

        os.makedirs(work, exist_ok=True)
        _emit(run, "正在解压…", "info", 10)
        _safe_extract(zip_path, work)
        src = _zip_source_root(work)
        if not (os.path.isdir(os.path.join(src, "app")) or os.path.isfile(os.path.join(src, "run.py"))):
            raise RuntimeError("压缩包里没有找到项目文件（应包含 run.py / app/ 目录），"
                               "请上传本项目的源码包，而不是运行数据")
        _emit(run, "解压完成，正在比对文件…", "ok", 20, "merge")

        items, skipped = _zip_plan(src)
        if not items:
            raise RuntimeError("压缩包里没有任何可更新的文件")
        overwrite = [rel for rel, _abs in items if os.path.exists(os.path.join(root, rel))]
        _emit(run, "共 %d 个文件：覆盖 %d 个、新增 %d 个"
              % (len(items), len(overwrite), len(items) - len(overwrite)), "info", 30)
        if skipped:
            _emit(run, "跳过 %d 个运行时 / 系统文件（data/、.env、日志、__pycache__ 等）"
                  % skipped, "dim")

        # 覆盖前整份备份当前代码（失败则中止，不会出现「没备份就覆盖」）
        _backup_or_raise(run, cfg, root, "pre", 32)

        req_before = _file_digest(os.path.join(root, "requirements.txt"))
        copied = 0
        for rel, abs_src in items:
            dst = os.path.join(root, rel)
            parent = os.path.dirname(dst)
            if parent:
                os.makedirs(parent, exist_ok=True)
            shutil.copy2(abs_src, dst)
            copied += 1
            if copied % 100 == 0:
                _emit(run, "已写入 %d/%d 个文件…" % (copied, len(items)), "dim")
        _emit(run, "代码已更新（写入 %d 个文件）" % copied, "ok", 60, "deps")

        if local_state().get("has_git"):
            _emit(run, "提示：当前目录是 Git 仓库，ZIP 覆盖后这些文件会显示为「已修改」；"
                       "以后改用 Git 方式更新前，请先提交 / 还原这些改动", "warn")

        req_after = _file_digest(os.path.join(root, "requirements.txt"))
        if req_before and req_before != req_after:
            if cfg.get("install_deps"):
                _pip_install(root, run)
            else:
                _emit(run, "requirements.txt 有变化，但未开启「自动安装依赖」，请手动执行 "
                           "pip install -r requirements.txt", "warn")
        else:
            _emit(run, "依赖文件无变化，跳过安装", "dim", 78)

        _emit(run, "准备重启服务…", "info", 90, "restart")
        mode = _do_restart(cfg, run)
        if mode == "manual":
            _finish(run, "done", "ZIP 包更新完成；请手动重启服务使新代码生效")
        elif mode == "command":
            _finish(run, "done", "ZIP 包更新完成，已下发重启命令")
    except Exception as e:
        _finish(run, "error", str(e), error=str(e))
        _log.error("[ZIP 更新] 失败: %s", e)
    finally:
        shutil.rmtree(work, ignore_errors=True)
        try:
            os.remove(zip_path)
        except OSError:
            pass


def start_zip_update(zip_path, filename=""):
    """启动 ZIP 包更新任务：返回 (run_id, 错误信息)。zip_path 由调用方负责清理。"""
    with _LOCK:
        if has_running():
            return "", "已有更新 / 重启任务在执行，请等待完成"
    if not os.path.isfile(zip_path):
        return "", "上传的压缩包不存在，请重新上传"
    if not zipfile.is_zipfile(zip_path):
        return "", "上传的文件不是有效的 ZIP 压缩包"
    if not os.path.isdir(project_root()):
        return "", "项目目录不存在：%s" % project_root()
    cfg = _raw_config()
    if (cfg.get("restart_mode") or "") == "command" and not (cfg.get("restart_cmd") or "").strip():
        return "", "重启方式选了「自定义命令」，但没有填写命令"
    run = _new_run("zip")
    t = threading.Thread(target=_worker_zip,
                         args=(run, cfg, zip_path, filename or os.path.basename(zip_path)),
                         name="online-zip", daemon=True)
    t.start()
    return run["id"], ""


def start_update(reset=False):
    """启动后台更新：返回 (run_id, 错误信息)。"""
    with _LOCK:
        if has_running():
            return "", "已有更新 / 重启任务在执行，请等待完成"
    cfg = _raw_config()
    local = local_state()
    if not local.get("has_git"):
        return "", local.get("error") or "当前目录不是 Git 仓库，无法在线更新"
    if reset and not cfg.get("hard_reset"):
        return "", "未开启「允许强制覆盖」，不能丢弃本地改动"
    if not reset and local.get("dirty"):
        files = "、".join(local.get("dirty_files") or [])[:300]
        return "", ("本地有未提交改动（%s），请先提交 / 还原改动，"
                    "或在配置中开启「允许强制覆盖」后重试" % files)
    repo, _source = _resolve_repo(cfg)
    if not repo:
        return "", "没有配置 GitHub 仓库地址，且本地仓库没有 origin 远端"
    if (cfg.get("restart_mode") or "") == "command" and not (cfg.get("restart_cmd") or "").strip():
        return "", "重启方式选了「自定义命令」，但没有填写命令"
    run = _new_run("update")
    t = threading.Thread(target=_worker_update, args=(run, cfg, bool(reset)),
                         name="online-updater", daemon=True)
    t.start()
    return run["id"], ""


def start_restart():
    with _LOCK:
        if has_running():
            return "", "已有更新 / 重启任务在执行，请等待完成"
    run = _new_run("restart")
    t = threading.Thread(target=_worker_restart, args=(run, _raw_config()),
                         name="online-restart", daemon=True)
    t.start()
    return run["id"], ""


def _merge_patch(cfg, patch):
    """把页面上尚未保存的值合并进配置（token 为脱敏值时保留原值）。"""
    out = dict(cfg)
    for key in ("repo", "remote_url", "branch", "api_base", "proxy"):
        if key in patch:
            out[key] = str(patch.get(key) or "").strip()
    if "token" in patch:
        token = str(patch.get("token") or "").strip()
        if "******" not in token:
            out["token"] = token
    return out


def probe(patch=None):
    """连通性诊断：分别测试 GitHub API 与 git 拉取地址，返回耗时与错误。

    支持传入页面上「尚未保存」的配置，方便边改边测。
    """
    cfg = _raw_config()
    if isinstance(patch, dict):
        cfg = _merge_patch(cfg, patch)
    local = local_state()
    repo, _source = _resolve_repo(cfg)
    branch = (cfg.get("branch") or local.get("branch") or "main").strip()
    out = {
        "repo": repo["slug"] if repo else "",
        "branch": branch,
        "api": {"ok": False, "ms": 0, "url": "", "error": "", "remaining": None, "limit": None},
        "git": {"ok": False, "ms": 0, "url": "", "error": ""},
    }

    base = (cfg.get("api_base") or "https://api.github.com").rstrip("/")
    out["api"]["url"] = base
    t0 = time.time()
    data, err = _http_json(base + "/rate_limit", cfg, 8)
    out["api"]["ms"] = int((time.time() - t0) * 1000)
    out["api"]["ok"] = err is None
    out["api"]["error"] = err or ""
    if isinstance(data, dict):
        rate = data.get("rate") or {}
        out["api"]["remaining"] = rate.get("remaining")
        out["api"]["limit"] = rate.get("limit")

    if not repo:
        out["git"]["error"] = "没有配置仓库地址，本地也没有 origin 远端"
        return out

    url = _fetch_url(cfg, repo)
    out["git"]["url"] = url
    t0 = time.time()
    rc, stdout, stderr = _git(["ls-remote", url, "refs/heads/%s" % branch],
                              project_root(), cfg, 15)
    out["git"]["ms"] = int((time.time() - t0) * 1000)
    out["git"]["ok"] = rc == 0
    if rc != 0:
        out["git"]["error"] = (stderr or stdout).strip()[:300] or "未知错误"
    return out


def state():
    """页面初始化所需的全部信息。"""
    cfg = _raw_config()
    return {
        "ok": True,
        "config": public_config(cfg),
        "local": local_state(),
        "last": last_result(),
        "run": current_run(),
        "env": {
            "root": project_root(),
            "python": sys.version.split()[0],
            "executable": sys.executable,
            "frozen": bool(getattr(sys, "frozen", False)),
            "can_exec": _can_self_exec()[0],
            "can_exec_reason": _can_self_exec()[1],
            "git": bool(shutil.which("git")),
        },
    }

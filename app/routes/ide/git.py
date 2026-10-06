"""Git 集成（源代码管理面板），基于本机 git 命令实现。

GET  /api/git/status?path=<任意目录>        仓库状态（分支、已暂存/更改/未跟踪）
GET  /api/git/diff?path=<仓库>&file=<相对路径>&staged=0|1&untracked=0|1   差异文本
POST /api/git/stage      {repo, files[], all}   暂存
POST /api/git/unstage    {repo, files[]}        取消暂存
POST /api/git/discard    {repo, files[]}        放弃更改（仅已跟踪文件）
POST /api/git/commit     {repo, message, all}   提交
POST /api/git/init       {repo}                 初始化仓库
"""
import os
import re
import shutil
import subprocess
from urllib.parse import quote, urlsplit, urlunsplit

from flask import Blueprint, request, jsonify

from ... import config
from ...log import get_logger
from ...services.common import secret, transport
from ...services.common.store_db import store_conn, store_tx, migrate_legacy_dict


_log = get_logger()
bp = Blueprint("git", __name__)

_TIMEOUT = 20
_MAX_DIFF_BYTES = 512 * 1024


def _load_git_creds():
    """Git 认证信息（一行一个字段；token 以密文落库，这里解密后返回）。"""
    out = {}
    try:
        conn = store_conn()
        try:
            for r in conn.execute("SELECT name, value FROM git_creds"):
                out[str(r["name"])] = r["value"]
        finally:
            conn.close()
    except Exception:
        return {}
    raw_token = out.get("token")
    if raw_token:
        plain, need_rewrite = secret.decrypt_ex(raw_token)
        out["token"] = plain
        if need_rewrite:
            try:
                _save_git_creds(out)      # 历史明文 / 旧密钥：顺手用当前密钥重写
            except Exception:
                pass
    return out


def _save_git_creds(creds):
    """整表覆盖写入（token 加密后落库，一行一个字段）。"""
    creds = creds if isinstance(creds, dict) else {}
    with store_tx() as conn:
        conn.execute("DELETE FROM git_creds")
        for k, v in creds.items():
            value = str(v)
            if k == "token" and value:
                value = secret.encrypt(value)
            conn.execute("INSERT INTO git_creds (name, value) VALUES (?,?)", (str(k), value))


def _import_git_creds(creds) -> None:
    with store_tx() as conn:
        conn.execute("DELETE FROM git_creds")
        for k, v in (creds or {}).items():
            value = str(v)
            if k == "token" and value:
                value = secret.encrypt(value)
            conn.execute("INSERT INTO git_creds (name, value) VALUES (?,?)", (str(k), value))


# 旧版 .file_manager_git_credentials.json（或上一版 kv 键）一次性导入
migrate_legacy_dict("table_migrated:git_creds", "git_creds",
                    config.GIT_CREDENTIALS_FILE, _import_git_creds)


def _mask_token(token):
    """脱敏返回前端：只保留前 4 位，其余用 ****** 覆盖。"""
    return secret.mask(token)


def _auth_remote_url(url, creds):
    """如果配置了 HTTPS Token，把 https://host/... 重写为 https://<token>@host/...。"""
    if not url or not isinstance(url, str):
        return url
    if (creds or {}).get("type") != "https_token":
        return url
    token = (creds.get("token") or "").strip()
    if not token:
        return url
    if not url.startswith("https://"):
        return url
    try:
        u = urlsplit(url)
        if u.scheme != "https" or u.username is not None:
            return url
        host_filter = (creds.get("host") or "").strip().lower()
        if host_filter and (u.hostname or "").lower() != host_filter:
            return url
        username = (creds.get("username") or "").strip()
        port = ":" + str(u.port) if u.port else ""
        if username:
            netloc = f"{quote(username, safe='')}:{quote(token, safe='')}@{u.hostname}{port}"
        else:
            netloc = f"{quote(token, safe='')}@{u.hostname}{port}"
        return urlunsplit((u.scheme, netloc, u.path, u.query, u.fragment))
    except Exception:
        return url


def _git_exe():
    return shutil.which("git")


def _git(cwd, args, timeout=_TIMEOUT):
    """执行 git 命令，返回 (CompletedProcess, error)。

    统一带上 `-c safe.directory=*`：本服务可能以 root 运行，而仓库/工作区属于
    普通用户，Git 会以 "detected dubious ownership" 拒绝读取（表现为
    `git init` 成功、但紧接着 status/log 仍报「不是 Git 仓库」）。
    这里放行，仅作用于本机自身的仓库目录。

    统一带上 `-c core.quotepath=false`：Git 默认把非 ASCII 路径转义成
    `"01_\346\240\207....css"` 形式（并包上引号），导致提交文件列表、
    差异等处中文文件名显示为乱码。关闭后直接输出 UTF-8 原文。
    """
    exe = _git_exe()
    if not exe:
        return None, "未找到 git 命令，请先安装 Git"
    env = os.environ.copy()
    # 禁止 Git 弹出交互式用户名/密码提示；在 Web 后端没有终端，hang 住会导致超时
    env["GIT_TERMINAL_PROMPT"] = "0"
    env["GIT_ASKPASS"] = "false"
    try:
        proc = subprocess.run([exe, "-c", "safe.directory=*", "-c", "core.quotepath=false"] + args,
                              cwd=cwd, capture_output=True,
                              text=True, errors="replace", timeout=timeout,
                              stdin=subprocess.DEVNULL, env=env)
    except subprocess.TimeoutExpired:
        return None, "git 命令执行超时"
    except OSError as e:
        return None, f"git 执行失败：{e}"
    return proc, None


def _fail(msg, code=400):
    return jsonify({"error": msg}), code


def _repo_root(path):
    """返回 (仓库根目录, 错误)。不是仓库时返回 (None, None)。"""
    if not path or not os.path.isdir(path):
        return None, "目录不存在"
    if not _git_exe():
        return None, "未找到 git 命令，请先安装 Git"
    proc, err = _git(path, ["rev-parse", "--show-toplevel"])
    if err:
        return None, err
    if proc.returncode != 0:
        return None, None                      # 不是 Git 仓库
    return proc.stdout.strip(), None


def _parse_branch(line):
    info = {"branch": "", "upstream": "", "ahead": 0, "behind": 0, "detached": False}
    if not line:
        return info
    if line.startswith("No commits yet on "):
        info["branch"] = line[len("No commits yet on "):].strip()
        return info
    if line.startswith("HEAD (no branch)"):
        info["branch"] = "HEAD（游离）"
        info["detached"] = True
        return info
    main = line.split(" [")[0]
    if "..." in main:
        info["branch"], info["upstream"] = main.split("...", 1)
    else:
        info["branch"] = main
    if line.rstrip().endswith("]"):
        inner = line[line.rindex("[") + 1:line.rindex("]")]
        for part in inner.split(","):
            part = part.strip()
            if part.startswith("ahead "):
                info["ahead"] = int(part[6:].split()[0] or 0)
            elif part.startswith("behind "):
                info["behind"] = int(part[7:].split()[0] or 0)
    return info


# ---- 默认忽略的"构建/缓存产物"（只影响面板显示与一键 .gitignore，不改变仓库内容）----
_IGNORE_DIRS = {
    ".git", "__pycache__", ".venv", "venv", "env", ".env", "node_modules",
    "build", "dist", "out", "target", "vendor", ".idea", ".vscode", ".vs",
    ".pytest_cache", ".mypy_cache", ".ruff_cache", ".tox", ".cache", ".next",
    ".nuxt", ".parcel-cache", ".buildenv", "coverage", "htmlcov", ".sass-cache",
    "cmake-build-debug", "cmake-build-release", ".gradle", ".terraform",
}
_IGNORE_SUFFIX_DIRS = (".egg-info", ".egg", ".dist-info")
_IGNORE_EXTS = {".pyc", ".pyo", ".pyd", ".class", ".o", ".obj", ".a", ".lib",
                ".so", ".dll", ".dylib", ".log", ".tmp", ".swp", ".bak", ".cache"}
_IGNORE_FILES = {".DS_Store", "Thumbs.db", "npm-debug.log", "yarn-error.log", "desktop.ini"}


def _noisy(rel):
    """判断相对路径是否为常见的构建/缓存产物（按路径分段匹配，避免误伤同名源码）。"""
    parts = [p for p in rel.split("/") if p]
    if not parts:
        return False
    for seg in parts[:-1]:
        if seg in _IGNORE_DIRS or seg.endswith(_IGNORE_SUFFIX_DIRS):
            return True
    last = parts[-1]
    if last in _IGNORE_FILES or last in _IGNORE_DIRS or last.endswith(_IGNORE_SUFFIX_DIRS):
        return True
    return os.path.splitext(last)[1].lower() in _IGNORE_EXTS


_GITIGNORE_LINES = [
    "# ---- 由文件管理器自动生成：构建产物 / 缓存 / 依赖目录 ----",
    "__pycache__/", "*.py[cod]", "*.egg-info/", ".pytest_cache/", ".mypy_cache/", ".ruff_cache/",
    ".venv/", "venv/", "env/", ".env",
    "node_modules/", "build/", "dist/", "out/", "target/", "vendor/",
    ".idea/", ".vscode/", ".vs/", ".gradle/", ".terraform/", "cmake-build-*/",
    ".cache/", ".next/", ".nuxt/", ".parcel-cache/", "coverage/", "htmlcov/",
    "*.log", "*.tmp", "*.swp", "*.bak", ".DS_Store", "Thumbs.db", "desktop.ini",
]


def _parse_status(out):
    """解析 `git status --porcelain=v1 -z -b` 输出。"""
    entries = out.split("\0")
    branch_line, files = None, []
    idx = 0
    if entries and entries[0].startswith("##"):
        branch_line = entries[0][3:].strip()
        idx = 1
    while idx < len(entries):
        e = entries[idx]
        if len(e) < 4:
            idx += 1
            continue
        x, y, path = e[0], e[1], e[3:]
        if x in "RC" or y in "RC":             # 重命名/复制：下一个条目是原路径
            idx += 1
        files.append({"path": path, "x": x, "y": y})
        idx += 1
    return branch_line, files


@bp.route("/api/git/status")
def api_git_status():
    target = request.args.get("path", "")
    _log.info("GET /api/git/status path=%s", target)
    if not target or not os.path.isdir(target):
        return _fail("目录不存在")
    root, err = _repo_root(target)
    if err:
        return jsonify({"ok": False, "error": err, "is_repo": False})
    if not root:
        return jsonify({"ok": True, "is_repo": False, "repo": os.path.abspath(target)})

    proc, err = _git(root, ["status", "--porcelain=v1", "-z", "-b", "--untracked-files=all"])
    if err:
        return jsonify({"ok": False, "error": err, "is_repo": True, "repo": root})
    if proc.returncode != 0:
        return jsonify({"ok": False, "error": proc.stderr.strip() or "读取状态失败", "is_repo": True, "repo": root})

    branch_line, files = _parse_status(proc.stdout)
    staged, changed, untracked = [], [], []
    for f in files:
        x, y = f["x"], f["y"]
        if x == "?" and y == "?":
            untracked.append({"path": f["path"], "status": "U"})
            continue
        if x not in (" ", "?"):
            staged.append({"path": f["path"], "status": x})
        if y not in (" ", "?"):
            changed.append({"path": f["path"], "status": y})
    info = _parse_branch(branch_line)
    # 未跟踪项里过滤掉缓存/构建产物，避免 .venv、__pycache__、dist 之类淹没有效改动
    show_untracked = [u for u in untracked if not _noisy(u["path"])]
    hidden = len(untracked) - len(show_untracked)
    return jsonify({
        "ok": True, "is_repo": True, "repo": root,
        "branch": info["branch"], "upstream": info["upstream"],
        "ahead": info["ahead"], "behind": info["behind"], "detached": info["detached"],
        "staged": staged, "changed": changed, "untracked": show_untracked,
        "hidden_untracked": hidden,
        "counts": {"staged": len(staged), "changed": len(changed),
                   "untracked": len(show_untracked), "hidden": hidden},
    })


@bp.route("/api/git/diff")
def api_git_diff():
    repo = request.args.get("path", "")
    rel = request.args.get("file", "")
    staged = request.args.get("staged", "") in ("1", "true", "yes")
    untracked = request.args.get("untracked", "") in ("1", "true", "yes")
    _log.info("GET /api/git/diff file=%s staged=%s", rel, staged)
    root, err = _repo_root(repo)
    if err:
        return _fail(err)
    if not root:
        return _fail("不是 Git 仓库")
    if not rel:
        return _fail("缺少文件参数")

    # hash 存在时看的是「某个提交里的该文件改动」，否则是工作区/暂存区差异
    hash_rev = (request.args.get("hash") or "").strip()
    if hash_rev.startswith("-"):
        return _fail("参数不合法")
    # -U100000：全文件上下文，前端分栏对比需要展示整个文件而非仅变更片段
    if hash_rev:
        args = ["show", "--no-color", "--no-ext-diff", "-U100000", "--format=", hash_rev, "--", rel]
    else:
        args = ["diff", "--no-color", "--no-ext-diff", "-U100000"]
        if staged:
            args.append("--cached")
        args += ["--", rel]
    proc, err = _git(root, args)
    if err:
        return _fail(err, 500)
    text = proc.stdout
    # 未跟踪文件 git diff 为空：改用 --no-index 与空文件对比，展示为整文件新增
    if not text.strip() and untracked:
        proc2, err2 = _git(root, ["diff", "--no-color", "--no-ext-diff", "-U100000", "--no-index",
                                  "--", os.devnull, rel])
        if not err2 and proc2:
            text = proc2.stdout
    truncated = len(text) > _MAX_DIFF_BYTES
    return jsonify({
        "ok": True,
        "diff": text[:_MAX_DIFF_BYTES],
        "truncated": truncated,
        "empty": not text.strip(),
    })


@bp.route("/api/git/file-log")
def api_git_file_log():
    """单个文件的提交历史（「打开时间线」）：git log --follow"""
    repo = request.args.get("path", "")
    rel = request.args.get("file", "")
    try:
        limit = max(1, min(200, int(request.args.get("limit", "40"))))
    except (TypeError, ValueError):
        limit = 40
    _log.info("GET /api/git/file-log file=%s limit=%s", rel, limit)
    root, err = _repo_root(repo)
    if err:
        return _fail(err)
    if not root:
        return _fail("不是 Git 仓库")
    if not rel:
        return _fail("缺少文件参数")
    # %x1f = 单元分隔符，避免提交信息里出现分隔冲突
    proc, err = _git(root, ["log", "--follow", "--no-color", "--date=short",
                            "--pretty=format:%H%x1f%h%x1f%an%x1f%ad%x1f%s",
                            "-n", str(limit), "--", rel])
    if err:
        return _fail(err, 500)
    if proc.returncode != 0:
        return _fail((proc.stderr or "").strip() or "读取历史失败", 500)
    commits = []
    for line in proc.stdout.splitlines():
        parts = line.split("\x1f")
        if len(parts) >= 5:
            commits.append({
                "hash": parts[0], "short": parts[1], "author": parts[2],
                "date": parts[3], "subject": "\x1f".join(parts[4:]),
            })
    return jsonify({"ok": True, "commits": commits})


def _py_unified_diff(pa, pb):
    """git 不可用时的兜底：直接用 difflib 生成 unified diff"""
    import difflib

    def read_lines(p):
        try:
            with open(p, "r", encoding="utf-8", errors="replace") as f:
                return f.read(2 * 1024 * 1024).splitlines(keepends=True)
        except OSError:
            return []

    try:
        return "".join(difflib.unified_diff(read_lines(pa), read_lines(pb), fromfile=pa, tofile=pb))
    except Exception:
        return ""


@bp.route("/api/git/diff-files")
def api_git_diff_files():
    """任意两个文件的差异（「选择以进行比较」）。优先 git diff --no-index，回退 difflib。"""
    a = (request.args.get("a") or "").strip()
    b = (request.args.get("b") or "").strip()
    _log.info("GET /api/git/diff-files a=%s b=%s", a, b)
    if not a or not b:
        return _fail("缺少文件参数")
    pa = os.path.abspath(os.path.normpath(a))
    pb = os.path.abspath(os.path.normpath(b))
    if pa == pb:
        return _fail("请选择两个不同的文件进行比较")
    for p in (pa, pb):
        if not os.path.isfile(p):
            return _fail("文件不存在：" + p, 404)
    text = ""
    if _git_exe():
        # 以两者最近的公共父目录为工作目录、用相对路径比较，
        # 这样 diff 头显示成 a/package.json b/src/server.js 而不是一长串绝对路径
        try:
            base = os.path.commonpath([os.path.dirname(pa), os.path.dirname(pb)])
        except ValueError:
            base = os.path.dirname(pa)
        if not base or not os.path.isdir(base):
            base = os.path.dirname(pa)
        pa_arg = os.path.relpath(pa, base)
        pb_arg = os.path.relpath(pb, base)
        # --no-index 允许在非仓库目录下比较两个文件；有差异时返回码为 1，属正常情况
        proc, err = _git(base or None,
                         ["diff", "--no-color", "--no-ext-diff", "--no-index", "--", pa_arg, pb_arg])
        if not err and proc:
            text = proc.stdout or ""
    if not text.strip():
        text = _py_unified_diff(pa, pb)
    truncated = len(text) > _MAX_DIFF_BYTES
    return jsonify({
        "ok": True,
        "diff": text[:_MAX_DIFF_BYTES],
        "truncated": truncated,
        "empty": not text.strip(),
        "a": pa, "b": pb,
    })


@bp.route("/api/git/stage", methods=["POST"])
def api_git_stage():
    data = request.get_json(silent=True) or {}
    root, err = _repo_root(data.get("repo") or "")
    if err:
        return _fail(err)
    if not root:
        return _fail("不是 Git 仓库")
    files = [f for f in (data.get("files") or []) if f]
    if data.get("all"):
        # tracked_only: 只暂存已跟踪文件的改动（对应“更改”分组）
        args = ["add", "-u"] if data.get("tracked_only") else ["add", "-A"]
    elif files:
        args = ["add", "--"] + files
    else:
        return _fail("缺少文件参数")
    proc, err = _git(root, args)
    if err:
        return _fail(err, 500)
    if proc.returncode != 0:
        return _fail(proc.stderr.strip() or "暂存失败", 500)
    return jsonify({"ok": True})


@bp.route("/api/git/unstage", methods=["POST"])
def api_git_unstage():
    data = request.get_json(silent=True) or {}
    root, err = _repo_root(data.get("repo") or "")
    if err:
        return _fail(err)
    if not root:
        return _fail("不是 Git 仓库")
    files = [f for f in (data.get("files") or []) if f]
    if data.get("all"):
        args = ["reset", "-q", "HEAD"]
        fallback = ["rm", "--cached", "-r", "-q", "--", "."]
    elif files:
        args = ["reset", "-q", "HEAD", "--"] + files
        fallback = ["rm", "--cached", "-q", "--"] + files
    else:
        return _fail("缺少文件参数")
    proc, err = _git(root, args)
    if err:
        return _fail(err, 500)
    if proc.returncode != 0:
        # 仓库尚无提交（没有 HEAD）时回退到从索引移除
        proc2, err2 = _git(root, fallback)
        if err2 or proc2.returncode != 0:
            return _fail(proc.stderr.strip() or "取消暂存失败", 500)
    return jsonify({"ok": True})


@bp.route("/api/git/discard", methods=["POST"])
def api_git_discard():
    data = request.get_json(silent=True) or {}
    root, err = _repo_root(data.get("repo") or "")
    if err:
        return _fail(err)
    if not root:
        return _fail("不是 Git 仓库")
    files = [f for f in (data.get("files") or []) if f]
    if data.get("all"):
        targets = ["."]
    elif files:
        targets = files
    else:
        return _fail("缺少文件参数")
    proc, err = _git(root, ["checkout", "--"] + targets)
    if err:
        return _fail(err, 500)
    if proc.returncode != 0:
        proc2, err2 = _git(root, ["restore", "--worktree", "--"] + targets)
        if err2 or proc2.returncode != 0:
            return _fail(proc.stderr.strip() or "放弃更改失败", 500)
    return jsonify({"ok": True})


@bp.route("/api/git/log")
def api_git_log():
    """最近提交（源代码管理“图形”区块）。"""
    repo = request.args.get("path", "")
    try:
        limit = max(1, min(100, int(request.args.get("limit", 30))))
    except (TypeError, ValueError):
        limit = 30
    root, err = _repo_root(repo)
    if err:
        return jsonify({"ok": False, "error": err, "is_repo": False, "commits": []})
    if not root:
        return jsonify({"ok": True, "is_repo": False, "repo": os.path.abspath(repo), "commits": []})
    # %x1f 作为字段分隔符，避免提交信息中含逗号时解析出错；%d 为 ref 装饰（分支/标签）
    fmt = "%h%x1f%s%x1f%an%x1f%ad%x1f%d"
    proc, err = _git(root, ["log", f"-{limit}", "--date=format:%Y-%m-%d %H:%M",
                            f"--pretty=format:{fmt}"])
    if err:
        return jsonify({"ok": False, "is_repo": True, "repo": root, "error": err, "commits": []})
    commits = []
    if proc.returncode == 0:
        for line in proc.stdout.splitlines():
            parts = line.split("\x1f")
            if len(parts) >= 4:
                refs = []
                if len(parts) >= 5 and parts[4].strip():
                    refs = [r.strip() for r in parts[4].strip().strip("()").split(",") if r.strip()]
                commits.append({"hash": parts[0], "subject": parts[1],
                                "author": parts[2], "date": parts[3], "refs": refs})
    return jsonify({"ok": True, "is_repo": True, "repo": root, "commits": commits})


@bp.route("/api/git/show")
def api_git_show():
    """单个提交的详情与变更文件清单（图形区块展开时使用）。"""
    repo = request.args.get("path", "")
    rev = (request.args.get("hash") or "").strip() or "HEAD"
    if rev.startswith("-"):
        return _fail("参数不合法")
    root, err = _repo_root(repo)
    if err:
        return _fail(err)
    if not root:
        return _fail("不是 Git 仓库")

    fmt = "%H%x1f%h%x1f%s%x1f%an%x1f%ad%x1f%P"
    proc, err = _git(root, ["show", "-s", "--date=format:%Y-%m-%d %H:%M",
                            f"--pretty=format:{fmt}", rev])
    if err:
        return _fail(err, 500)
    if proc.returncode != 0:
        return _fail(proc.stderr.strip() or "读取提交失败", 500)
    parts = (proc.stdout.strip().split("\x1f") + [""] * 7)[:7]
    commit = {"full": parts[0], "hash": parts[1], "subject": parts[2],
              "author": parts[3], "date": parts[4],
              "parents": [p for p in parts[5].split() if p]}

    proc2, err2 = _git(root, ["show", "--name-status", "--format=", rev])
    if err2:
        return _fail(err2, 500)
    files, truncated = [], False
    for line in (proc2.stdout or "").splitlines():
        line = line.strip()
        if not line:
            continue
        segs = line.split("\t")
        if len(segs) < 2:
            continue
        code = segs[0].strip()
        path = segs[-1].strip()            # 重命名时形如 R100\told\tnew，取新路径
        if len(files) >= 500:
            truncated = True
            break
        files.append({"path": path, "status": code[:1]})

    # 变更统计（numstat 聚合；二进制文件计入文件数、不计行数；merge 提交无 diff 时为 0）
    stats = {"files": 0, "insertions": 0, "deletions": 0}
    proc3, err3 = _git(root, ["show", "--numstat", "--format=", rev])
    if not err3 and proc3.returncode == 0:
        for line in proc3.stdout.splitlines():
            segs = line.split("\t")
            if len(segs) < 3 or not segs[0].strip():
                continue
            stats["files"] += 1
            if segs[0] != "-":
                try:
                    stats["insertions"] += int(segs[0])
                except ValueError:
                    pass
            if segs[1] != "-":
                try:
                    stats["deletions"] += int(segs[1])
                except ValueError:
                    pass
    return jsonify({"ok": True, "repo": root, "commit": commit,
                    "files": files, "truncated": truncated, "stats": stats})


@bp.route("/api/git/commit", methods=["POST"])
def api_git_commit():
    data = request.get_json(silent=True) or {}
    root, err = _repo_root(data.get("repo") or "")
    if err:
        return _fail(err)
    if not root:
        return _fail("不是 Git 仓库")
    message = (data.get("message") or "").strip()
    amend = bool(data.get("amend"))          # 提交（修改）：git commit --amend
    if not message and not amend:
        return _fail("提交信息不能为空")
    commit_all = data.get("all")

    # 提交前给出可操作的友好提示，避免直接抛出 git 原生长文本错误
    # （amend 模式允许暂存区为空：仅修改上次提交信息也算合法操作）
    status_proc, status_err = _git(root, ["status", "--porcelain=v1", "-z", "-b", "--untracked-files=all"])
    if not status_err and status_proc.returncode == 0 and not amend:
        _branch, files = _parse_status(status_proc.stdout)
        has_staged = any(f["x"] not in (" ", "?") for f in files)
        has_changed = any(f["y"] not in (" ", "?") and f["x"] in (" ", "?") for f in files)
        has_untracked = any(f["x"] == "?" and f["y"] == "?" for f in files)
        if not has_staged:
            if has_untracked:
                return _fail("没有已暂存的文件。请先在下方文件右侧点击 + 暂存，或点击分组标题右侧的 + 暂存全部，然后再提交。", 400)
            if has_changed and not commit_all:
                return _fail("存在未暂存的已跟踪改动。请先暂存文件，或勾选「包含已跟踪改动」后直接提交。", 400)
            return _fail("没有要提交的更改。", 400)

    if amend and not message:
        args = ["commit", "--amend", "--no-edit"]
    elif amend:
        args = ["commit", "-m", message, "--amend"]
    else:
        args = ["commit", "-m", message]
    if commit_all:
        args.insert(1, "-a")
    proc, err = _git(root, args)
    if err:
        return _fail(err, 500)
    if proc.returncode != 0:
        stderr = (proc.stdout + proc.stderr).strip() or "提交失败"
        # 对已知错误场景给出更直接的提示
        if "nothing added to commit" in stderr or "no changes added to commit" in stderr:
            return _fail("没有已暂存的文件。请先暂存要提交的文件，然后再提交。", 400)
        return _fail(stderr, 500)
    out = (proc.stdout.strip().splitlines() or [""])[0]
    return jsonify({"ok": True, "message": out})


@bp.route("/api/git/file")
def api_git_file():
    """取某个版本下的文件内容（用于“源码”视图）。"""
    repo = request.args.get("path", "")
    rev = (request.args.get("rev") or "").strip()
    rel = (request.args.get("file") or "").strip()
    if rev.startswith("-") or not rel:
        return _fail("参数不合法")
    root, err = _repo_root(repo)
    if err:
        return _fail(err)
    if not root:
        return _fail("不是 Git 仓库")
    spec = f"{rev}:{rel}" if rev else f":{rel}"
    proc, err = _git(root, ["show", spec])
    if err:
        return _fail(err, 500)
    if proc.returncode != 0:
        return _fail(proc.stderr.strip() or "读取文件失败", 500)
    text = proc.stdout
    truncated = len(text) > _MAX_DIFF_BYTES
    return jsonify({"ok": True, "content": text[:_MAX_DIFF_BYTES], "truncated": truncated,
                    "ext": os.path.splitext(rel)[1].lower().lstrip(".")})


def _remote_op(verb, timeout):
    """执行 fetch / pull / push 并返回结果；若保存了 HTTPS Token，自动注入。"""
    data = request.get_json(silent=True) or {}
    root, err = _repo_root(data.get("repo") or "")
    if err:
        return _fail(err)
    if not root:
        return _fail("不是 Git 仓库")
    creds = _load_git_creds()

    # 检查 origin 是否已配置，并取出原始 URL
    proc_url, _ = _git(root, ["remote", "get-url", "origin"])
    if not proc_url or proc_url.returncode != 0:
        return jsonify({
            "ok": False,
            "error": "当前仓库没有配置远程仓库 origin。请先设置远程仓库，例如：\n\ngit remote add origin https://github.com/用户名/仓库名.git",
            "output": ""
        }), 400
    origin_url = proc_url.stdout.strip()
    auth_url = _auth_remote_url(origin_url, creds)

    args = [verb]
    if verb == "fetch":
        args += ["--prune", auth_url]
    elif verb == "push":
        # 分支没有上游时自动发布（push -u <url> <branch>）
        proc_br, _ = _git(root, ["rev-parse", "--abbrev-ref", "HEAD"])
        branch = (proc_br.stdout.strip() if proc_br and proc_br.returncode == 0 else "")
        proc_up, _ = _git(root, ["rev-parse", "--abbrev-ref", f"{branch}@{{upstream}}"])
        has_upstream = bool(proc_up and proc_up.returncode == 0)
        if not has_upstream and branch and branch != "HEAD":
            args += ["-u", auth_url, branch]
        else:
            args += [auth_url]
    else:  # pull
        args += [auth_url]

    proc, err = _git(root, args, timeout=timeout)
    if err:
        return _fail(err, 500)
    out = ((proc.stdout or "") + (proc.stderr or "")).strip()
    if proc.returncode != 0:
        # 对常见错误给出更直接的提示
        lowered = out.lower()
        if "does not appear to be a git repository" in lowered or "could not resolve" in lowered:
            return jsonify({
                "ok": False,
                "error": "无法访问远程仓库 origin。请检查远程地址是否正确，或网络是否可达。",
                "output": out
            }), 400
        if ("permission denied" in lowered or "authentication failed" in lowered or
                "could not read username" in lowered or "could not read password" in lowered or
                "没有那个设备或地址" in out):
            return jsonify({
                "ok": False,
                "error": "访问远程仓库需要认证。请到「设置 → Git 认证」填写 Personal Access Token，或在远程地址中使用 https://<Token>@github.com/用户名/仓库名.git。",
                "output": out
            }), 400
        return jsonify({"ok": False, "error": out or f"{verb} 失败", "output": out}), 500
    return jsonify({"ok": True, "output": out})


@bp.route("/api/git/fetch", methods=["POST"])
def api_git_fetch():
    return _remote_op("fetch", 120)


@bp.route("/api/git/pull", methods=["POST"])
def api_git_pull():
    return _remote_op("pull", 120)


@bp.route("/api/git/push", methods=["POST"])
def api_git_push():
    return _remote_op("push", 120)


@bp.route("/api/git/remote", methods=["GET", "POST"])
def api_git_remote():
    """查看 / 设置远程仓库（默认 origin）。"""
    if request.method == "GET":
        repo = request.args.get("path", "")
        root, err = _repo_root(repo)
        if err:
            return _fail(err)
        if not root:
            return _fail("不是 Git 仓库")
        proc, err = _git(root, ["remote", "-v"])
        if err:
            return _fail(err, 500)
        remotes = []
        for line in (proc.stdout or "").splitlines():
            parts = line.split()
            if len(parts) >= 3:
                remotes.append({"name": parts[0], "url": parts[1], "type": parts[2].strip("()")})
        return jsonify({"ok": True, "remotes": remotes, "repo": root})

    data = request.get_json(silent=True) or {}
    root, err = _repo_root(data.get("repo") or "")
    if err:
        return _fail(err)
    if not root:
        return _fail("不是 Git 仓库")
    name = (data.get("name") or "origin").strip()
    url = (data.get("url") or "").strip()
    if not url:
        return _fail("远程仓库地址不能为空")
    proc, _ = _git(root, ["remote", "get-url", name])
    exists = bool(proc and proc.returncode == 0)
    proc, err = _git(root, ["remote", "set-url" if exists else "add", name, url])
    if err:
        return _fail(err, 500)
    if proc.returncode != 0:
        return _fail(proc.stderr.strip() or "设置远程仓库失败", 500)
    return jsonify({"ok": True, "message": ("已更新" if exists else "已添加") + "远程仓库 " + name})


@bp.route("/api/git/remote/test", methods=["POST"])
def api_git_remote_test():
    """测试远程仓库地址是否可访问，并返回默认分支信息；支持临时传入 credentials。"""
    data = request.get_json(silent=True) or {}
    root, err = _repo_root(data.get("repo") or "")
    if err:
        return _fail(err)
    if not root:
        return _fail("不是 Git 仓库")
    url = (data.get("url") or "").strip()
    if not url:
        return _fail("远程仓库地址不能为空")
    # 优先使用请求里传入的临时 credentials，其次使用已保存的 credentials
    creds = data.get("credentials")
    if not isinstance(creds, dict):
        creds = _load_git_creds()
    url = _auth_remote_url(url, creds)
    proc, err = _git(root, ["ls-remote", "--symref", url, "HEAD"], timeout=20)
    if err:
        if err == "git 命令执行超时":
            return jsonify({
                "ok": False,
                "error": "连接远程仓库超时。如果是 HTTPS 私有仓库，请先到「设置 → Git 认证」填写 Token，或把地址改为 https://<Token>@github.com/用户名/仓库名.git。",
                "output": ""
            }), 400
        return _fail(err, 500)
    out = ((proc.stdout or "") + (proc.stderr or "")).strip()
    if proc.returncode != 0:
        lowered = out.lower()
        if "could not resolve" in lowered or "could not connect" in lowered or "unable to access" in lowered:
            return jsonify({
                "ok": False,
                "error": "无法访问该远程仓库，请检查地址是否正确或网络是否可达。",
                "output": out
            }), 400
        if ("authentication failed" in lowered or "permission denied" in lowered or
                "could not read username" in lowered or "could not read password" in lowered or
                "terminal prompts disabled" in lowered or
                "没有那个设备或地址" in out):
            return jsonify({
                "ok": False,
                "error": "认证失败，请检查是否有该仓库的访问权限。请到「设置 → Git 认证」填写 HTTPS Token，或将远程地址设为 https://<Token>@github.com/用户名/仓库名.git。",
                "output": out
            }), 400
        return jsonify({"ok": False, "error": out or "连接失败", "output": out}), 400
    default_branch = ""
    m = re.search(r"ref:\s*refs/heads/(\S+)", proc.stdout or "")
    if m:
        default_branch = m.group(1)
    return jsonify({
        "ok": True,
        "output": out,
        "default_branch": default_branch,
        "message": "连接成功" + (("，默认分支：" + default_branch) if default_branch else "")
    })


@bp.route("/api/git/credentials", methods=["GET"])
def api_git_credentials_get():
    """读取已保存的 Git 认证信息（Token 脱敏返回）。"""
    creds = _load_git_creds()
    return jsonify({
        "ok": True,
        "type": creds.get("type") or "none",
        "username": creds.get("username") or "",
        "token": _mask_token(creds.get("token") or ""),
        "host": creds.get("host") or "",
        "has_token": bool(creds.get("token")),
    })


@bp.route("/api/git/credentials", methods=["POST"])
def api_git_credentials_post():
    """保存 Git 认证信息；Token 留空表示沿用旧值。"""
    data = request.get_json(silent=True) or {}
    creds = _load_git_creds()
    cred_type = (data.get("type") or "none").strip()
    if cred_type not in ("none", "https_token"):
        return _fail("不支持的认证类型")
    creds["type"] = cred_type
    if cred_type == "https_token":
        username = (data.get("username") or "").strip()
        host = (data.get("host") or "").strip()
        # 前端以 RSA 密文提交（tp1: 前缀），这里先解出明文
        token = transport.unwrap(data.get("token") or "").strip()
        if username:
            creds["username"] = username
        else:
            creds.pop("username", None)
        if host:
            creds["host"] = host
        else:
            creds.pop("host", None)
        if token:
            creds["token"] = token
    else:
        creds.pop("token", None)
        creds.pop("username", None)
        creds.pop("host", None)
    _save_git_creds(creds)
    return jsonify({
        "ok": True,
        "type": creds["type"],
        "token": _mask_token(creds.get("token") or ""),
        "has_token": bool(creds.get("token")),
        "username": creds.get("username") or "",
        "host": creds.get("host") or "",
    })


@bp.route("/api/git/gitignore", methods=["POST"])
def api_git_gitignore():
    """把默认忽略规则写入仓库的 .gitignore（已存在则只追加缺少的行）。"""
    data = request.get_json(silent=True) or {}
    root, err = _repo_root(data.get("repo") or "")
    if err:
        return _fail(err, 500)
    if not root:
        return _fail("不是 Git 仓库")
    path = os.path.join(root, ".gitignore")
    lines = []
    if os.path.isfile(path):
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                lines = f.read().splitlines()
        except OSError as e:
            return _fail(f"读取 .gitignore 失败：{e}", 500)
    have = {l.strip() for l in lines}
    add = [l for l in _GITIGNORE_LINES if l.strip() not in have and not l.startswith("#")]
    if not add:
        return jsonify({"ok": True, "added": 0, "path": path})
    try:
        with open(path, "a", encoding="utf-8") as f:
            if lines and lines[-1].strip():
                f.write("\n")
            if not lines:
                f.write(_GITIGNORE_LINES[0] + "\n")
            f.write("\n".join(add) + "\n")
    except OSError as e:
        return _fail(f"写入 .gitignore 失败：{e}", 500)
    return jsonify({"ok": True, "added": len(add), "path": path})


@bp.route("/api/git/init", methods=["POST"])
def api_git_init():
    data = request.get_json(silent=True) or {}
    target = data.get("repo") or ""
    if not target or not os.path.isdir(target):
        return _fail("目录不存在")
    if not _git_exe():
        return _fail("未找到 git 命令，请先安装 Git")
    proc, err = _git(target, ["init"])
    if err:
        return _fail(err, 500)
    if proc.returncode != 0:
        return _fail(proc.stderr.strip() or "初始化失败", 500)
    return jsonify({"ok": True, "message": proc.stdout.strip().splitlines()[0] if proc.stdout.strip() else "已初始化"})

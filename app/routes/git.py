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
import shutil
import subprocess

from flask import Blueprint, request, jsonify

from ..log import get_logger


_log = get_logger()
bp = Blueprint("git", __name__)

_TIMEOUT = 20
_MAX_DIFF_BYTES = 512 * 1024


def _git_exe():
    return shutil.which("git")


def _git(cwd, args, timeout=_TIMEOUT):
    """执行 git 命令，返回 (CompletedProcess, error)。

    统一带上 `-c safe.directory=*`：本服务可能以 root 运行，而仓库/工作区属于
    普通用户，Git 会以 "detected dubious ownership" 拒绝读取（表现为
    `git init` 成功、但紧接着 status/log 仍报「不是 Git 仓库」）。
    这里放行，仅作用于本机自身的仓库目录。
    """
    exe = _git_exe()
    if not exe:
        return None, "未找到 git 命令，请先安装 Git"
    try:
        proc = subprocess.run([exe, "-c", "safe.directory=*"] + args, cwd=cwd, capture_output=True,
                              text=True, errors="replace", timeout=timeout,
                              stdin=subprocess.DEVNULL)
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
    """执行 fetch / pull / push 并返回结果。"""
    data = request.get_json(silent=True) or {}
    root, err = _repo_root(data.get("repo") or "")
    if err:
        return _fail(err)
    if not root:
        return _fail("不是 Git 仓库")
    args = [verb]
    if verb == "fetch":
        args += ["--all", "--prune"]
    elif verb == "push":
        # 分支没有上游时自动发布（push -u origin <branch>）
        proc_br, _ = _git(root, ["rev-parse", "--abbrev-ref", "HEAD"])
        branch = (proc_br.stdout.strip() if proc_br and proc_br.returncode == 0 else "")
        proc_up, _ = _git(root, ["rev-parse", "--abbrev-ref", f"{branch}@{{upstream}}"])
        has_upstream = bool(proc_up and proc_up.returncode == 0)
        if not has_upstream and branch and branch != "HEAD":
            args += ["-u", "origin", branch]
    # 执行远程操作前，先检查 origin 是否已配置（push/pull/fetch 都依赖它）
    if verb != "fetch":
        proc_remote, _ = _git(root, ["remote", "get-url", "origin"])
        if not proc_remote or proc_remote.returncode != 0:
            return jsonify({
                "ok": False,
                "error": "当前仓库没有配置远程仓库 origin。请先设置远程仓库，例如：\n\ngit remote add origin https://github.com/用户名/仓库名.git",
                "output": ""
            }), 400

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
        if "permission denied" in lowered or "authentication failed" in lowered:
            return jsonify({
                "ok": False,
                "error": "访问远程仓库被拒绝，请检查认证信息（SSH 密钥 / 用户名密码 / Token）是否正确。",
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

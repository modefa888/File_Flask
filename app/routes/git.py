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
    """执行 git 命令，返回 (CompletedProcess, error)。"""
    exe = _git_exe()
    if not exe:
        return None, "未找到 git 命令，请先安装 Git"
    try:
        proc = subprocess.run([exe] + args, cwd=cwd, capture_output=True,
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
    return jsonify({
        "ok": True, "is_repo": True, "repo": root,
        "branch": info["branch"], "upstream": info["upstream"],
        "ahead": info["ahead"], "behind": info["behind"], "detached": info["detached"],
        "staged": staged, "changed": changed, "untracked": untracked,
        "counts": {"staged": len(staged), "changed": len(changed), "untracked": len(untracked)},
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

    args = ["diff", "--no-color", "--no-ext-diff"]
    if staged:
        args.append("--cached")
    args += ["--", rel]
    proc, err = _git(root, args)
    if err:
        return _fail(err, 500)
    text = proc.stdout
    # 未跟踪文件 git diff 为空：改用 --no-index 与空文件对比，展示为整文件新增
    if not text.strip() and untracked:
        proc2, err2 = _git(root, ["diff", "--no-color", "--no-ext-diff", "--no-index",
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
    # %x1f 作为字段分隔符，避免提交信息中含逗号时解析出错
    fmt = "%h%x1f%s%x1f%an%x1f%ad"
    proc, err = _git(root, ["log", f"-{limit}", "--date=format:%Y-%m-%d %H:%M",
                            f"--pretty=format:{fmt}"])
    if err:
        return jsonify({"ok": False, "is_repo": True, "repo": root, "error": err, "commits": []})
    commits = []
    if proc.returncode == 0:
        for line in proc.stdout.splitlines():
            parts = line.split("\x1f")
            if len(parts) >= 4:
                commits.append({"hash": parts[0], "subject": parts[1],
                                "author": parts[2], "date": parts[3]})
    return jsonify({"ok": True, "is_repo": True, "repo": root, "commits": commits})


@bp.route("/api/git/commit", methods=["POST"])
def api_git_commit():
    data = request.get_json(silent=True) or {}
    root, err = _repo_root(data.get("repo") or "")
    if err:
        return _fail(err)
    if not root:
        return _fail("不是 Git 仓库")
    message = (data.get("message") or "").strip()
    if not message:
        return _fail("提交信息不能为空")
    args = ["commit", "-m", message]
    if data.get("all"):
        args.insert(1, "-a")
    proc, err = _git(root, args)
    if err:
        return _fail(err, 500)
    if proc.returncode != 0:
        return _fail((proc.stdout + proc.stderr).strip() or "提交失败", 500)
    out = (proc.stdout.strip().splitlines() or [""])[0]
    return jsonify({"ok": True, "message": out})


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

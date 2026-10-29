"""浏览/预览/缩略图/视频流转发路由。"""
import os
import sys
import re
import json
import time
import threading
import subprocess
import mimetypes
import base64

from flask import Blueprint, request, jsonify, send_file, render_template, Response as FlaskResponse
from urllib.parse import quote

from ...config import (
    _TEXT_EXTS, _IMAGE_EXTS, _VIDEO_EXTS,
    _AUDIO_EXTS,
    _PREVIEW_MAX_BYTES, _TEXT_PREVIEW_MAX_BYTES,
    _THUMB_CACHE_DIR, _TEXT_FILENAMES, _DOTFILE_TEXT_STEMS, _STORAGE_DIR,
    FFMPEG_BIN, FFPROBE_BIN,
)
from ...log import get_logger
from ...services.common.filecore import (
    safe_path, format_size, list_directory, _SIZE_PENDING, _SIZE_PENDING_LOCK,
    _DIR_SIZE_CACHE, _ensure_dir_size_async,
)
from ...services.common import scaffold
from ...services.common.thumbnail import (
    _get_thumbnail_bytes, _get_preview_bytes, _extract_video_frame,
    _clear_disk_cache as _clear_thumb_cache, get_video_duration, get_video_cover,
)
from ...services.common.store_db import store_conn, store_tx, migrate_legacy_list


_log = get_logger()
bp = Blueprint("browser", __name__)





# ======================================================================
# 最近打开的文件夹（服务端持久化，跨设备 / 跨浏览器共享）
# ======================================================================
_RECENT_DIR_FILE = ".file_recent_folders.json"
_RECENT_MAX = 8                              # 最多保留的条数
_RECENT_LOCK = threading.Lock()


def _recent_path() -> str:
    return os.path.join(_STORAGE_DIR, _RECENT_DIR_FILE)


def _norm_dir_path(path: str) -> str:
    """目录路径规范化：绝对化并压掉多余的前导/尾随斜杠（'//home/x/' -> '/home/x'）。

    前导双斜杠在 POSIX 下另有含义，normpath 会原样保留，这里统一成单斜杠，
    避免同一目录以 '/x' 和 '//x' 两种形式各存一条。
    """
    p = os.path.abspath(os.path.normpath(str(path or "").strip()))
    if p == "/":
        return "/"
    return "/" + p.lstrip("/").rstrip("/")


def _recent_load() -> list:
    """最近打开目录（一行一个，seq 顺序即展示顺序）。

    只保留绝对路径：早期版本允许手输路径，可能存进相对路径（如 "m3u8_web"），
    而 /api/files 对失效路径会「回退到最近存在的上级目录」并照常返回 200，
    于是点进去会显示成别的文件夹的内容（路径栏与内容对不上）。发现脏数据直接丢弃并回写。
    """
    try:
        conn = store_conn()
        try:
            rows = conn.execute(
                "SELECT path, opened_at FROM recent_folders ORDER BY seq ASC").fetchall()
        finally:
            conn.close()
    except Exception:
        return []
    items = [{"path": r["path"], "opened_at": float(r["opened_at"] or 0)} for r in rows]
    keep = [it for it in items if str(it["path"]).startswith("/")]
    if len(keep) != len(items):
        _recent_save(keep)          # 顺手把脏数据从库里清掉，不用每次过滤
    return keep


def _recent_save(items: list) -> None:
    """整表覆盖写入（列表下标即 seq，写入顺序 = 读取顺序）。"""
    try:
        with store_tx() as conn:
            conn.execute("DELETE FROM recent_folders")
            for i, it in enumerate(items or []):
                if not isinstance(it, dict) or not it.get("path"):
                    continue
                conn.execute(
                    "INSERT INTO recent_folders (seq, path, opened_at) VALUES (?,?,?)",
                    (i, str(it["path"]), float(it.get("opened_at") or 0)))
    except Exception as e:
        _log.warning("保存最近打开记录失败：%s", e)


# 旧版 .file_recent_folders.json（或上一版 kv 键）一次性导入
migrate_legacy_list("table_migrated:recent_folders", "recent_folders",
                    _recent_path(), _recent_save)


@bp.route("/api/recent/folders")
def api_recent_folders():
    """最近打开的文件夹列表（含是否存在，便于前端标记失效项）。"""
    with _RECENT_LOCK:
        items = _recent_load()
    for it in items:
        it["exists"] = os.path.isdir(it["path"])
        it["name"] = os.path.basename(it["path"].rstrip("/")) or it["path"]
    return jsonify({"ok": True, "folders": items})


@bp.route("/api/recent/folders", methods=["POST"])
def api_recent_folders_add():
    """记录一次打开：去重置顶，最多保留 _RECENT_MAX 条。"""
    data = request.get_json(silent=True) or {}
    path = (data.get("path") or "").strip()
    if not path:
        return jsonify({"error": "缺少路径"}), 400
    if not path.startswith("/"):
        # 相对路径会在服务端按工作目录解析，存下来必然指向错误位置，
        # 读的时候又会被 /api/files 回退到别的目录，干脆拒收
        return jsonify({"error": "只接受绝对路径"}), 400
    path = _norm_dir_path(path)
    with _RECENT_LOCK:
        items = _recent_load()
        items = [x for x in items if x["path"] != path]
        items.insert(0, {"path": path, "opened_at": time.time()})
        items = items[:_RECENT_MAX]
        _recent_save(items)
    return jsonify({"ok": True, "folders": items})


@bp.route("/api/recent/folders/remove", methods=["POST"])
def api_recent_folders_remove():
    """移除一条记录（路径失效时使用）。"""
    data = request.get_json(silent=True) or {}
    path = (data.get("path") or "").strip()
    if not path:
        return jsonify({"error": "缺少路径"}), 400
    path = _norm_dir_path(path)
    with _RECENT_LOCK:
        items = [x for x in _recent_load() if x["path"] != path]
        _recent_save(items)
    return jsonify({"ok": True, "folders": items})


_PROJECT_BRIEF_MAX = 500         # 「AI 生成」时项目描述的字符上限
_PROJECT_AI_TIMEOUT = 300        # 调 AI 生成脚手架的超时秒数（写整个项目较慢，给足 5 分钟）

# 「AI 接口超时」的提示统一在一处：告诉用户可以换更快的模型
_TIMEOUT_HINT = ("AI 响应超时（超过 %ds 没有返回）。可以在弹窗底部把模型换成更快的，"
                 "或者把项目描述写短一点再试。" % _PROJECT_AI_TIMEOUT)


def _is_timeout(e):
    s = str(e).lower()
    return "timed out" in s or "timeout" in s


def _ai_stream_text(req, emit=None, on_text=None, meta=None):
    """读上游 SSE 流：reasoning 实时抛出，正文片段交给 on_text，最后返回完整正文。

    emit 收到两种事件：
      {"stage":"think","kind":"reason","text":"..."}  模型的 reasoning_content 片段
      {"stage":"think","kind":"body","n":已接收字数}   正文进度（模型没给思考时也能看到在动）
    on_text(chunk) 用于「边生成边解析」（Agent 构建时按 <write> 块逐个落盘）。
    meta（可选 dict）：回填 finish（finish_reason）与 reason_chars（思考总字数）——
    用来区分「模型没按协议写」和「思考把 token 吃光了、正文被截断」这两种失败。
    """
    import urllib.request
    resp = urllib.request.urlopen(req, timeout=_PROJECT_AI_TIMEOUT)
    parts, n, last_n, rn = [], 0, 0, 0
    for raw in resp:
        line = raw.decode("utf-8", "ignore").strip()
        if not line or not line.startswith("data:"):
            continue
        data = line[5:].strip()
        if data == "[DONE]":
            break
        try:
            obj = json.loads(data)
        except Exception:
            continue
        ch = (obj.get("choices") or [{}])[0] or {}
        fr = ch.get("finish_reason")
        if fr and meta is not None:
            meta["finish"] = fr
        delta = ch.get("delta") or {}
        think = delta.get("reasoning_content") or delta.get("reasoning") or ""
        if think:
            rn += len(think)
            if meta is not None:
                meta["reason_chars"] = rn
            if emit:
                emit({"stage": "think", "kind": "reason", "text": think})
        chunk = delta.get("content") or ""
        if chunk:
            parts.append(chunk)
            n += len(chunk)
            if on_text is not None:
                try:
                    on_text(chunk)
                except Exception:
                    pass
            if emit and n - last_n >= 400:     # 正文进度节流，别把 SSE 刷爆
                last_n = n
                emit({"stage": "think", "kind": "body", "n": n})
    return "".join(parts)


def _ai_stream_once(req, emit):
    """兼容旧调用：只取完整正文。"""
    return _ai_stream_text(req, emit)


# 从模型输出里抠出 <plan> / <write path="..."> 两种块。
# path 后的引号放宽：模型很爱写成 path=app.py、path='app.py'，严格匹配会整单 0 文件。
_RE_PLAN = re.compile(r"<plan>(.*?)</plan>", re.S)
_RE_WRITE = re.compile(r"""<write\s+path\s*=\s*["']?([^"'\s>]+)["']?\s*>(.*?)</write>""", re.S)


def _ai_plan_files(provider, model, brief, name, emit=None):
    """构建前的「快速规划」：只让模型给文件清单（不写内容），返回 ([{path,role}], error)。

    同样走流式：规划阶段也要能看到模型的思考在动，否则前几十秒一片空白像卡死。
    """
    from ..ide.ai import _log_ai_call
    import urllib.error
    import urllib.request
    base = provider["base_url"].rstrip("/")
    url = base if base.endswith("/chat/completions") else base + "/chat/completions"
    user = f"[项目名]\n{name}\n\n[项目描述]\n{brief}"
    body = json.dumps({"model": model, "stream": True, "messages": [
        {"role": "system", "content": scaffold.AI_PLAN_SYS},
        {"role": "user", "content": user}]}).encode("utf-8")
    req = urllib.request.Request(url, data=body, method="POST", headers={
        "Content-Type": "application/json", "Authorization": "Bearer " + provider["api_key"]})
    t0 = time.time()
    text, err = "", ""
    try:
        text = _ai_stream_text(req, emit)
    except urllib.error.HTTPError as e:
        err = f"AI 接口返回 {e.code}：{e.read().decode('utf-8', 'ignore')[:160]}"
    except Exception as e:
        err = "规划超时" if _is_timeout(e) else f"规划失败：{str(e)}"

    items = scaffold.parse_plan(text) if text else []
    _log_ai_call("scaffold", bool(items), int((time.time() - t0) * 1000),
                 err or ("" if items else "规划没有返回文件清单"), model, 0, 0, True,
                 req=user[:600], resp=text[:900])
    if not items:
        return [], err or "规划没有返回文件清单"
    return items, ""


def _ai_file_content(provider, model, brief, name, plan, path, role, done, emit=None):
    """逐文件生成：一次请求只写一个文件，写完立刻落盘（不用等整个项目吐完）。

    用流式请求：思考片段 / 正文进度都能实时推给前端，等一个文件时不会像卡死。
    返回 (内容, 错误)。内容会去掉模型套在外面的 ``` 围栏。
    """
    lines = ["[项目名] " + name, "[项目描述] " + brief, "", "[完整文件清单]"]
    for x in plan:
        lines.append("- " + x["path"] + ("（" + x["role"] + "）" if x.get("role") else ""))
    lines.append("")
    lines.append("[本次要写] " + path + ("（" + role + "）" if role else ""))
    if done:
        lines.append("")
        lines.append("[已经写好的文件，注意与它们风格一致、接口对得上] " + "、".join(done))
    lines.append("")
    lines.append("只输出这个文件的完整内容，不要任何解释与围栏。")

    import urllib.error
    import urllib.request
    base = provider["base_url"].rstrip("/")
    url = base if base.endswith("/chat/completions") else base + "/chat/completions"
    body = json.dumps({"model": model, "stream": True, "messages": [
        {"role": "system", "content": scaffold.AI_FILE_SYS},
        {"role": "user", "content": "\n".join(lines)}]}).encode("utf-8")
    req = urllib.request.Request(url, data=body, method="POST", headers={
        "Content-Type": "application/json", "Authorization": "Bearer " + provider["api_key"]})
    try:
        text = _ai_stream_text(req, emit)
        return scaffold.strip_fences(text), ""
    except urllib.error.HTTPError as e:
        return "", f"AI 接口返回 {e.code}：{e.read().decode('utf-8', 'ignore')[:160]}"
    except Exception as e:
        return "", ("AI 响应超时" if _is_timeout(e) else f"调用 AI 接口失败：{str(e)}")


def _ai_agent_build(info, sel=None, emit=None):
    """Agent 式构建：模型边生成，我们边按 <write path> 落盘，目录树实时生长。

    与「一次性返回整个 JSON」相比：不用等全部输出完才动笔，也不会因为 JSON 被截断
    就整单失败；单个文件写完立刻可见、可校验。

    返回 {"written","dirs","skipped","items","bytes","error"}。
    """
    from ..ide.ai import _load_cfg, _sys_pick, _log_ai_call   # 函数内导入，避免模块循环依赖
    cfg = _load_cfg()
    provider, model, err = _sys_pick(cfg, "scaffold")
    if err:
        return {"error": err}
    provider, model = _apply_ai_pick(cfg, provider, model, sel)

    import urllib.request
    target, brief, name = info["target"], info["brief"], info["name"]
    try:
        os.makedirs(target, exist_ok=True)
    except Exception as e:
        return {"error": f"创建项目目录失败：{e}"}

    def _cleanup_empty():
        """失败时别留一堆空目录：规划阶段已经把目录建出来了，全空比没有更像“卡住了”。"""
        try:
            if not os.path.isdir(target):
                return
            for d in sorted(st["dirs"], key=lambda x: x.count("/"), reverse=True):
                p = os.path.join(target, d)
                try:
                    if os.path.isdir(p) and not os.listdir(p):
                        os.rmdir(p)
                except Exception:
                    pass
            if not os.listdir(target):
                os.rmdir(target)
        except Exception:
            pass

    t0 = time.time()
    base = provider["base_url"].rstrip("/")
    url = base if base.endswith("/chat/completions") else base + "/chat/completions"

    st = {"buf": "", "plan": [], "plan_sent": False, "written": [], "dirs": [],
          "skipped": [], "items": [], "bytes": 0}

    def _send_plan(paths):
        if st["plan_sent"] or not paths:
            return
        st["plan_sent"] = True
        st["plan"] = paths
        dirs = scaffold.plan_dirs([{"path": p} for p in paths])
        for d in dirs:
            if d not in st["dirs"]:
                st["dirs"].append(d)
        if emit:
            emit({"stage": "plan",
                  "items": [{"path": p, "size": 0} for p in paths],
                  "files": paths, "dirs": dirs, "skipped": [],
                  "n": len(paths), "nd": len(dirs), "bytes": 0,
                  "msg": f"已规划 {len(paths)} 个文件，正在逐个生成…"})

    # ① 先做一次「只出清单」的轻量规划：几秒内就把目录树画出来、目录先建好。
    #    规划失败（模型抽风 / 接口报错）就直接跳过，退回「边写边长树」的老路径。
    plan_items = []
    if emit and brief:
        plan_items, _plan_err = _ai_plan_files(provider, model, brief, name, emit)
        if plan_items:
            _send_plan([x["path"] for x in plan_items])
            for i, d in enumerate(st["dirs"], 1):
                try:
                    os.makedirs(os.path.join(target, d), exist_ok=True)
                except Exception:
                    pass
                emit({"stage": "dir", "path": d, "i": i, "n": len(st["dirs"])})

    def _write(path, content):
        # 单次调用没法累计总量，这里自己兜住「文件数 / 总体量」上限，防止模型刷屏
        if len(st["written"]) >= scaffold.MAX_FILES or st["bytes"] >= scaffold.MAX_TOTAL_BYTES:
            st["skipped"].append(path)
            return
        prepared, sk = scaffold.prepare_manifest(target, [{"path": path, "content": content}])
        if sk:
            st["skipped"].extend(sk)
        if not prepared:
            return
        written, failed = scaffold.write_prepared(prepared)
        if failed:
            st["skipped"].extend(failed)
        if not written:
            return
        it = prepared[0]
        st["written"].append(it["path"])
        st["items"].append({"path": it["path"], "size": it["bytes"]})
        st["bytes"] += it["bytes"]
        for d in scaffold.plan_dirs([{"path": it["path"]}]):
            if d not in st["dirs"]:
                st["dirs"].append(d)
        if emit:
            emit({"stage": "file", "path": it["path"], "i": len(st["written"]),
                  "n": max(len(st["plan"]), len(st["written"])), "ok": True,
                  "size": it["bytes"]})

    def _feed(chunk):
        st["buf"] += chunk
        # <plan> 块不管有没有提前发过，都要从缓冲里摘掉，否则它会挡住后面 <write> 的匹配
        m = _RE_PLAN.search(st["buf"])
        if m:
            paths = []
            for line in m.group(1).splitlines():
                line = line.strip().lstrip("-*+ ").strip()
                if not line:
                    continue
                # 模型常写成 `- app.py`、`**app.py**`、反引号包裹，统一剥掉修饰符
                p = line.split("|")[0].strip().strip("`*_\"' \t").strip()
                if p:
                    paths.append(p)
            st["buf"] = st["buf"][m.end():]
            if not st["plan_sent"]:
                _send_plan(paths)
        while True:
            m = _RE_WRITE.search(st["buf"])
            if not m:
                break
            path, content = m.group(1).strip(), m.group(2)
            st["buf"] = st["buf"][m.end():]
            if not st["plan_sent"]:            # 模型没给 <plan>：先用第一个文件占个位
                st["plan"] = [path]
                _send_plan([path])
            _write(path, content)

    text, aerr = "", ""
    meta = {}                                  # finish / reason_chars，用于区分失败原因
    if plan_items:
        # ② 逐文件生成：一个文件一次请求，写完立刻落盘 → 目录树逐个点亮。
        #    不再赌「模型会不会一口气把整个项目吐完」—— 思考型模型经常吐到一半就断了。
        total = len(plan_items)
        last_err = ""
        for i, it in enumerate(plan_items, 1):
            p = it["path"]
            if emit:
                emit({"stage": "gen", "path": p, "i": i, "n": total})
            content, ferr = _ai_file_content(provider, model, brief, name, plan_items,
                                             p, it.get("role", ""), st["written"], emit)
            if not (content or "").strip():
                last_err = ferr or "模型没有返回这个文件的内容"
                st["skipped"].append(p)
                if emit:
                    emit({"stage": "file", "path": p, "i": i, "n": total,
                          "ok": False, "size": 0})
                continue
            _write(p, content)
        if not st["written"]:
            aerr = last_err or "所有文件都没生成出来，换个模型再试"
    else:
        # ② 老路：一次流式请求，模型边吐 <plan>/<write> 边落盘（拿不到清单时兜底）
        # 刻意不传 max_tokens：思考型模型会把额度几乎全花在 reasoning 上，正文没开始就被截断。
        body = json.dumps({"model": model, "stream": True, "messages": [
            {"role": "system", "content": scaffold.AI_AGENT_SYS},
            {"role": "user", "content": f"[项目名]\n{name}\n\n[项目描述]\n{brief}"}]}).encode("utf-8")
        req = urllib.request.Request(url, data=body, method="POST", headers={
            "Content-Type": "application/json", "Authorization": "Bearer " + provider["api_key"]})
        import urllib.error
        try:
            text = _ai_stream_text(req, emit, on_text=_feed, meta=meta)
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "ignore")[:200]
            aerr = f"AI 接口返回 {e.code}：{detail}"
        except Exception as e:
            aerr = _TIMEOUT_HINT if _is_timeout(e) else f"调用 AI 接口失败：{str(e)}"

        # 兜底：模型没按 <write> 协议写（比如回了老格式的 JSON），再用通用解析试一次
        if not st["written"] and not aerr:
            files = scaffold.parse_manifest(text)
            if files:
                st["plan"] = [f["path"] for f in files]
                _send_plan(st["plan"])
                for f in files:
                    _write(f["path"], f["content"])

    if aerr and not st["written"]:
        _cleanup_empty()
        _log_ai_call("scaffold", False, int((time.time() - t0) * 1000), aerr, model)
        return {"error": aerr}
    if not st["written"]:
        _cleanup_empty()
        if meta.get("finish") == "length":
            # 思考型模型的典型翻车：token 预算被 reasoning 吃光，正文没开始就截断了
            msg = ("模型的输出被截断了：它把 token 预算几乎全用在思考上（已思考 %d 字），"
                   "还没开始写文件就停了。请把底部模型换成不思考的（如 gpt-4o-mini / "
                   "deepseek-chat），或把项目描述写短一点再试。" % (meta.get("reason_chars") or 0))
        else:
            msg = "Agent 没有写出任何文件，请换个说法或换个模型"
        _log_ai_call("scaffold", False, int((time.time() - t0) * 1000), msg, model)
        return {"error": msg}

    _log_ai_call("scaffold", True, int((time.time() - t0) * 1000), "",
                 model, 0, 0, True, req=brief[:600], resp=text[:1200])
    return {"written": st["written"], "dirs": st["dirs"], "skipped": st["skipped"],
            "items": st["items"], "bytes": st["bytes"], "error": ""}


def _apply_ai_pick(cfg, provider, model, sel):
    """请求里带了 provider_id / model 时临时改用这个模型（弹窗底部的模型下拉）。"""
    if not isinstance(sel, dict) or not (sel.get("provider_id") or sel.get("model")):
        return provider, model
    try:
        from ..ide.ai import _override_pick       # 与 AI 面板共用同一套覆盖逻辑
        return _override_pick(cfg, provider, model, sel)
    except Exception:
        return provider, model


def _ai_generate_files(brief, name, plan=None, sel=None, emit=None):
    """用系统 AI 按一句话描述生成项目文件清单。

    plan 是可选的项目规划（{summary, stack, modules, tree}），带上会让生成更贴合规划。
    sel 是可选的手动指定模型 {"provider_id","model"}（弹窗底部下拉选的）。
    emit 是可选回调：给了就走流式，边生成边把思考过程推给前端（见 _ai_stream_once）。

    返回 (files, error)；error 非空时 files 为空、调用方应直接报错。
    统一走 _sys_pick：自动跟随「设置 → 系统 AI」选定的接口/模型，
    并且该模块被停用时直接拒绝（与其它系统 AI 模块一致）。
    """
    from ..ide.ai import _load_cfg, _sys_pick, _log_ai_call   # 函数内导入，避免模块循环依赖
    cfg = _load_cfg()
    provider, model, err = _sys_pick(cfg, "scaffold")
    if err:
        return [], err
    provider, model = _apply_ai_pick(cfg, provider, model, sel)

    t0 = time.time()

    def _fail(msg):
        """统一失败出口：记一次失败调用再返回。"""
        _log_ai_call("scaffold", False, int((time.time() - t0) * 1000), msg, model)
        return [], msg

    base = provider["base_url"].rstrip("/")
    url = base if base.endswith("/chat/completions") else base + "/chat/completions"
    user = f"[项目名]\n{name}\n\n[项目描述]\n{brief}"
    if isinstance(plan, dict):
        lines = []
        if plan.get("summary"):
            lines.append("概括：" + str(plan["summary"])[:120])
        if plan.get("stack"):
            lines.append("技术栈：" + "、".join(map(str, plan["stack"]))[:200])
        if plan.get("modules"):
            lines.append("功能模块：" + "、".join(map(str, plan["modules"]))[:200])
        if plan.get("tree"):
            lines.append("计划文件：" + "、".join(map(str, plan["tree"]))[:300])
        if lines:
            user += ("\n\n[已确认的项目规划]\n" + "\n".join(lines) +
                     "\n请严格按这份规划生成文件：技术栈、功能模块、目录结构都要对得上。")
    import urllib.error
    import urllib.request

    sys_text = scaffold.AI_SYS

    def _post(stream):
        # max_tokens 给足：脚手架是一个较大的 JSON，太小会被截断成非法 JSON
        body = json.dumps({
            "model": model, "stream": bool(stream), "max_tokens": 8192,
            "messages": [{"role": "system", "content": sys_text},
                         {"role": "user", "content": user}],
        }).encode("utf-8")
        return urllib.request.Request(url, data=body, method="POST", headers={
            "Content-Type": "application/json", "Authorization": "Bearer " + provider["api_key"]})

    last_text = ""
    for attempt in (1, 2):
        sys_text = scaffold.AI_SYS
        if attempt == 2:
            # 第一次的输出解析不出来：再要一次，这次把格式要求说得更死
            sys_text += ("\n\n注意：上一次的输出无法被解析。这次务必只输出一个合法的 JSON 对象，"
                         "不要任何解释、不要 Markdown 代码块、不要在 JSON 前后加任何文字。")
            if emit is not None:                 # 让前端知道「正在重试」，不是卡住了
                try:
                    emit({"stage": "think", "kind": "reason",
                          "text": "\n\n—— 上一次输出无法解析，正在重试一次 ——\n"})
                except Exception:
                    pass
        obj, text = {}, ""
        try:
            if emit is not None:
                # 有回调就走流式：一边生成一边把思考过程推给前端
                try:
                    text = _ai_stream_once(_post(True), emit)
                except urllib.error.HTTPError:
                    raise
                except Exception:
                    text = ""              # 该模型不支持流式 → 退回一次性请求
            if not text.strip():
                resp = urllib.request.urlopen(_post(False), timeout=_PROJECT_AI_TIMEOUT)
                obj = json.loads(resp.read().decode("utf-8"))
                text = (((obj.get("choices") or [{}])[0] or {}).get("message") or {}).get("content") or ""
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "ignore")[:200]
            return _fail(f"AI 接口返回 {e.code}：{detail}")
        except Exception as e:
            return _fail(_TIMEOUT_HINT if _is_timeout(e) else f"调用 AI 接口失败：{str(e)}")

        last_text = text
        files = scaffold.parse_manifest(text)
        if files:
            u = obj.get("usage") or {}
            tin, tout, est = u.get("prompt_tokens") or 0, u.get("completion_tokens") or 0, False
            if not (tin or tout):                    # 没给 usage 就按字数兜底估算
                from ..ide.ai import _estimate_msgs, _estimate_tokens
                tin = _estimate_msgs([{"role": "system", "content": sys_text},
                                      {"role": "user", "content": user}])
                tout, est = _estimate_tokens(text), True
            _log_ai_call("scaffold", True, int((time.time() - t0) * 1000), "",
                         str(obj.get("model") or model), tin, tout, est, req=user, resp=text)
            return files, ""

    snippet = " ".join((last_text or "").split())[:160]
    return _fail("AI 没有返回可解析的文件清单" +
                 (f"（原始返回：{snippet}）" if snippet
                  else "（返回为空，请检查模型是否可用、额度是否足够）"))


def _ai_project_names(brief):
    """「AI 生成」第一步：按一句话描述产出几个候选项目名，返回 (payload, error)。

    payload = {"summary", "names", "ms", "out_tokens", "model"}，前端用它展示
    「AI 思考过程」里的真实耗时 / token 数。

    与 _ai_generate_files 分开调用：先让用户挑名字，再按定下的名字生成文件，
    这样 README / 包名 / 目录名三者一致，不需要创建完再改名。
    """
    from ..ide.ai import _load_cfg, _sys_pick, _log_ai_call   # 函数内导入，避免模块循环依赖
    cfg = _load_cfg()
    provider, model, err = _sys_pick(cfg, "scaffold")
    if err:
        return None, err

    t0 = time.time()

    def _fail(msg):
        _log_ai_call("scaffold", False, int((time.time() - t0) * 1000), msg, model)
        return None, msg

    base = provider["base_url"].rstrip("/")
    url = base if base.endswith("/chat/completions") else base + "/chat/completions"
    user = f"[项目描述]\n{brief}"
    # 这一步要「先规划再命名」，输出比单纯的名单大一些，token 给足避免被截断
    payload = json.dumps({"model": model, "stream": False, "max_tokens": 1200, "messages": [
        {"role": "system", "content": scaffold.AI_NAME_SYS},
        {"role": "user", "content": user}]}).encode("utf-8")

    import urllib.error
    import urllib.request
    req = urllib.request.Request(url, data=payload, method="POST", headers={
        "Content-Type": "application/json", "Authorization": "Bearer " + provider["api_key"]})
    try:
        resp = urllib.request.urlopen(req, timeout=_PROJECT_AI_TIMEOUT)
        obj = json.loads(resp.read().decode("utf-8"))
        text = (((obj.get("choices") or [{}])[0] or {}).get("message") or {}).get("content") or ""
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "ignore")[:200]
        return _fail(f"AI 接口返回 {e.code}：{detail}")
    except Exception as e:
        return _fail(_TIMEOUT_HINT if _is_timeout(e) else f"调用 AI 接口失败：{str(e)}")

    plan = scaffold.parse_plan(text)
    if not plan["names"]:
        snippet = (text or "").strip().replace("\n", " ")[:120]
        return _fail("AI 没能给出可用的项目名" +
                     (f"（原始返回：{snippet}）" if snippet else "（返回为空）"))

    u = obj.get("usage") or {}
    tin, tout, est = u.get("prompt_tokens") or 0, u.get("completion_tokens") or 0, False
    if not (tin or tout):
        from ..ide.ai import _estimate_msgs, _estimate_tokens
        tin = _estimate_msgs([{"role": "system", "content": scaffold.AI_NAME_SYS},
                              {"role": "user", "content": user}])
        tout, est = _estimate_tokens(text), True
    ms = int((time.time() - t0) * 1000)
    _log_ai_call("scaffold", True, ms, "",
                 str(obj.get("model") or model), tin, tout, est, req=user, resp=text)
    return {"summary": plan["summary"], "stack": plan["stack"], "modules": plan["modules"],
            "tree": plan["tree"], "names": plan["names"], "ms": ms, "out_tokens": tout,
            "model": str(obj.get("model") or model)}, ""


def _temp_project_name():
    """临时项目名：14 字节随机 → 28 位十六进制。

    先落一个不会重名、不含中文的目录把项目建起来，等代码写完之后再由 AI
    根据实际生成的内容起正式名（见 _ai_final_name），失败也还有这个名字兜底。
    """
    import secrets
    return secrets.token_hex(14)


def _pick_free_name(parent_abs, names):
    """从候选里挑第一个在 parent 下不冲突的名字；都不行返回空串。"""
    for it in names or []:
        nm = str(it.get("name") if isinstance(it, dict) else it or "").strip()
        if not nm or "/" in nm or nm in (".", ".."):
            continue
        if not os.path.exists(os.path.join(parent_abs, nm)):
            return nm
    return ""


def _ai_final_name(brief, files, sel=None):
    """项目写完后：根据实际生成出来的代码给项目起名，返回 (names, error)。

    names 是候选列表（主名在前）；失败时调用方保留 28 位临时名即可，不算致命错误。
    """
    from ..ide.ai import _load_cfg, _sys_pick, _log_ai_call   # 函数内导入，避免模块循环依赖
    cfg = _load_cfg()
    provider, model, err = _sys_pick(cfg, "scaffold")
    if err:
        return [], err
    provider, model = _apply_ai_pick(cfg, provider, model, sel)

    t0 = time.time()

    def _fail(msg):
        _log_ai_call("scaffold", False, int((time.time() - t0) * 1000), msg, model)
        return [], msg

    paths = ["- " + str(f.get("path") or "") for f in (files or [])[:20]]
    sample, used = [], 0
    for f in (files or [])[:6]:
        p = str(f.get("path") or "")
        if not p.lower().endswith((".md", ".py", ".js", ".ts", ".html", ".json", ".txt", ".css")):
            continue
        sample.append(f"--- {p} ---\n" + str(f.get("content") or "")[:320])
        used += len(sample[-1])
        if used > 1200:
            break
    user = (f"[原始需求]\n{brief}\n\n[生成的文件]\n" + "\n".join(paths) +
            ("\n\n[文件开头片段]\n" + "\n\n".join(sample) if sample else ""))

    base = provider["base_url"].rstrip("/")
    url = base if base.endswith("/chat/completions") else base + "/chat/completions"
    payload = json.dumps({"model": model, "stream": False, "max_tokens": 400, "messages": [
        {"role": "system", "content": scaffold.AI_FINAL_NAME_SYS},
        {"role": "user", "content": user}]}).encode("utf-8")

    import urllib.error
    import urllib.request
    req = urllib.request.Request(url, data=payload, method="POST", headers={
        "Content-Type": "application/json", "Authorization": "Bearer " + provider["api_key"]})
    try:
        resp = urllib.request.urlopen(req, timeout=_PROJECT_AI_TIMEOUT)
        obj = json.loads(resp.read().decode("utf-8"))
        text = (((obj.get("choices") or [{}])[0] or {}).get("message") or {}).get("content") or ""
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "ignore")[:200]
        return _fail(f"AI 接口返回 {e.code}：{detail}")
    except Exception as e:
        return _fail(_TIMEOUT_HINT if _is_timeout(e) else f"调用 AI 接口失败：{str(e)}")

    names = scaffold.parse_final_name(text)
    if not names:
        return _fail("AI 没能给出可用的项目名")

    u = obj.get("usage") or {}
    tin, tout, est = u.get("prompt_tokens") or 0, u.get("completion_tokens") or 0, False
    if not (tin or tout):
        from ..ide.ai import _estimate_msgs, _estimate_tokens
        tin = _estimate_msgs([{"role": "system", "content": scaffold.AI_FINAL_NAME_SYS},
                              {"role": "user", "content": user}])
        tout, est = _estimate_tokens(text), True
    _log_ai_call("scaffold", True, int((time.time() - t0) * 1000), "",
                 str(obj.get("model") or model), tin, tout, est, req=user, resp=text)
    return names, ""


def _project_prep(data):
    """新建项目的公共参数校验与目标路径计算（/create 与 /create-stream 共用）。

    返回 (info, err)：err 非空时是 (response, status) 元组，调用方直接 return 它。
    """
    parent = (data.get("parent") or "").strip()
    name = (data.get("name") or "").strip()
    template = (data.get("template") or "blank").strip()
    brief = (data.get("brief") or "").strip()
    if not parent:
        return None, (jsonify({"error": "请选择项目要创建在哪个目录"}), 400)
    if not parent.startswith("/"):
        return None, (jsonify({"error": "位置必须是绝对路径"}), 400)
    if not name:
        return None, (jsonify({"error": "请输入项目名"}), 400)
    if name in (".", "..") or "/" in name or "\\" in name:
        return None, (jsonify({"error": "项目名不能包含路径分隔符"}), 400)
    if any(ch in name for ch in '<>:"|?*'):
        return None, (jsonify({"error": '项目名不能包含 < > : " | ? * 等字符'}), 400)
    if len(name) > 128:
        return None, (jsonify({"error": "项目名过长（上限 128 字符）"}), 400)
    if template not in ("", "blank", scaffold.AI_KEY) and template not in scaffold.TEMPLATES:
        return None, (jsonify({"error": f"未知的初始框架：{template}"}), 400)
    if template == scaffold.AI_KEY and not brief:
        return None, (jsonify({"error": "选择「AI 生成」后，请先用一句话描述你的项目"}), 400)
    if len(brief) > _PROJECT_BRIEF_MAX:
        return None, (jsonify({"error": f"描述过长（上限 {_PROJECT_BRIEF_MAX} 字）"}), 400)

    parent_abs = safe_path(parent)
    target = os.path.abspath(os.path.normpath(os.path.join(parent_abs, name)))
    if target == parent_abs or target == "/":
        return None, (jsonify({"error": "项目名无效"}), 400)
    if os.path.exists(target):
        return None, (jsonify({"error": f"目录已存在：{target}", "exists": True}), 409)
    return {"parent_abs": parent_abs, "target": target, "name": name,
            "template": template or "blank", "brief": brief}, None


@bp.route("/api/projects/templates")
def api_projects_templates():
    """新建项目可选的初始框架（内置模板 + AI 生成），供前端渲染选项"""
    items = [{"key": k, "label": v["label"], "icon": v["icon"], "hint": v["hint"]}
             for k, v in scaffold.TEMPLATES.items()]
    items.append({"key": scaffold.AI_KEY, "label": "AI 生成", "icon": "bi-stars",
                  "hint": "用一句话描述项目，由系统 AI 生成初始框架"})
    return jsonify({"ok": True, "templates": items, "brief_max": _PROJECT_BRIEF_MAX})


@bp.route("/api/projects/ai/models")
def api_projects_ai_models():
    """新建项目弹窗底部的模型下拉：列出配置好的「接口 / 模型」以及当前默认用的那个。

    只是读配置，不发请求；某个模型太慢导致超时时，用户可以在这里临时换一个。
    """
    from ..ide.ai import _load_cfg, _sys_pick
    cfg = _load_cfg()
    provider, model, err = _sys_pick(cfg, "scaffold")
    if err:
        from ..ide.ai import _sys_err_response          # 与其它系统 AI 模块一致
        return _sys_err_response(err, need_config="尚未配置 AI" in err)
    items = []
    for p in (cfg.get("providers") or []):
        for m in (p.get("models") or []):
            items.append({"provider_id": p["id"], "provider": p.get("name") or p["id"], "model": m})
    return jsonify({"ok": True, "items": items,
                    "current": {"provider_id": provider["id"], "model": model}})


@bp.route("/api/projects/ai/names", methods=["POST"])
def api_projects_ai_names():
    """「AI 生成」第一步：按一句话描述让 AI 给出几个候选项目名，交给用户挑。

    选完名字后再调 /api/projects/create-stream，届时 AI 会按这个名字生成文件，
    目录名 / README 标题 / 包名天然一致。同时回报每个候选在当前位置是否已存在。
    """
    data = request.get_json(silent=True) or {}
    brief = (data.get("brief") or "").strip()
    parent = (data.get("parent") or "").strip()
    if not brief:
        return jsonify({"error": "请先用一句话描述你的项目"}), 400
    if len(brief) > _PROJECT_BRIEF_MAX:
        return jsonify({"error": f"描述过长（上限 {_PROJECT_BRIEF_MAX} 字）"}), 400

    payload, aerr = _ai_project_names(brief)
    if aerr:
        from ..ide.ai import _sys_err_response          # 与创建设置保持一致的处理
        return _sys_err_response(aerr, need_config="尚未配置 AI" in aerr)

    parent_abs = safe_path(parent) if parent.startswith("/") else ""
    out = []
    for it in payload["names"]:
        exists = False
        if parent_abs:
            try:
                target = os.path.abspath(os.path.normpath(os.path.join(parent_abs, it["name"])))
                exists = os.path.exists(target)
            except Exception:
                exists = False
        out.append({"name": it["name"], "why": it["why"], "exists": exists})
    _log.info("AI 项目规划：%d 个候选（%s），耗时 %d ms", len(out),
              "、".join(x["name"] for x in out), payload["ms"])
    return jsonify({"ok": True, "summary": payload["summary"], "names": out,
                    "stack": payload.get("stack") or [],
                    "modules": payload.get("modules") or [],
                    "tree": payload.get("tree") or [],
                    "ms": payload["ms"], "out_tokens": payload.get("out_tokens") or 0,
                    "model": payload.get("model") or ""})


@bp.route("/api/projects/create", methods=["POST"])
def api_projects_create():
    """新建项目：在「任意位置」创建项目目录，不受当前工作区限制。

    与 /api/files/create 的区别：那个是在已存在的目录里建一级子项（父目录必须存在），
    这里是从零建项目 —— 父目录不存在会逐级建出来，便于「选个位置 → 输入名字 → 立刻开干」。
    """
    info, err = _project_prep(request.get_json(silent=True) or {})
    if err:
        return err
    name, target, template = info["name"], info["target"], info["template"]

    # 先把文件清单准备好再落盘：AI 失败 / 框架非法时不会留下一个空目录
    if template == scaffold.AI_KEY:
        files, aerr = _ai_generate_files(info["brief"], name)
        if aerr:
            from ..ide.ai import _sys_err_response          # 函数内导入，与 _ai_generate_files 保持一致
            return _sys_err_response(aerr, need_config="尚未配置 AI" in aerr)
    else:
        files = scaffold.render(template, name)

    try:
        os.makedirs(target)              # 父目录不存在时一并建出来
    except PermissionError:
        return jsonify({"error": f"没有权限在此处创建：{target}"}), 403
    except Exception as e:
        return jsonify({"error": f"创建失败：{str(e)}"}), 500

    written, skipped = scaffold.write_manifest(target, files)
    _log.info("新建项目：%s（框架=%s，写入 %d 个文件）", target, template, len(written))
    return jsonify({"ok": True, "path": target, "name": name,
                    "template": template, "files": written, "skipped": skipped})


# 新建项目的步骤条（后端是唯一来源，前端照着画，避免两边各维护一份顺序）
# 「AI 生成代码 / 生成文件树 / 创建目录 / 写入文件」已合并成一步：
# 由 Agent 边思考边建目录、边写文件，进度直接体现在下面的目录树里。
_PROJECT_STEPS = [
    ("check", "校验参数"),
    ("ai", "Agent 构建"),
    ("naming", "生成项目名"),
    ("done", "完成"),
]


@bp.route("/api/projects/create-stream", methods=["POST"])
def api_projects_create_stream():
    """新建项目的流式版本：按「步骤」逐步回报，供前端画步骤条 + 目录树生长动画。

    参数与 /api/projects/create 完全一致；一次性接口保留给不需要进度的调用方。
    AI 模板不要求前端给项目名：这里先抽一个 28 位 hash 当临时目录名把项目建出来，
    等文件写完再让 AI 按实际生成的内容起正式名并自动改名。

    每帧都是 `data: {json}\\n\\n`，stage 取值：
      steps  {"steps":[{"id","label"}]}                 本次要走的步骤（AI 模板才含 ai / naming）
      step   {"id","state":"run|ok|err","msg"}          某一步的状态变化
      plan   {"items":[{"path","size"}],"dirs":[...],"skipped":[...],
              "n","nd","bytes","msg"}                   完整文件树（建目录前就能画出来）
      dir    {"path","i","n"}                           建好一个目录
      file   {"path","i","n","ok","size"}               写完一个文件
      done   {"path","name","temp_name","naming_note","template",
              "written","skipped","dirs","bytes"}       path 是最终（可能已改名）的目录
      error  {"msg","code","need_config","disabled"}
    """
    data = request.get_json(silent=True) or {}
    use_ai = str(data.get("template") or "blank") == scaffold.AI_KEY
    plan = data.get("plan") if isinstance(data.get("plan"), dict) else None   # 前端可选传的规划
    # 弹窗底部手动选的模型（不传就跟随「设置 → 系统 AI」）
    sel = {"provider_id": str(data.get("provider_id") or ""),
           "model": str(data.get("model") or "")}
    # AI 模板不需要用户先想名字：先落一个 28 位 hash 临时目录，等代码写完再改成正式名。
    if use_ai and not (data.get("name") or "").strip():
        info, err = None, None
        for _ in range(3):                       # 极小概率撞名，重抽几次
            data["name"] = _temp_project_name()
            info, err = _project_prep(data)
            if not err:
                break
            try:
                exists = bool((err[0].get_json(silent=True) or {}).get("exists"))
            except Exception:
                exists = False
            if not exists:
                break
    else:
        info, err = _project_prep(data)
    steps = [{"id": k, "label": lb} for k, lb in _PROJECT_STEPS
             if use_ai or k not in ("ai", "naming")]

    def ev(obj):
        return "data: " + json.dumps(obj, ensure_ascii=False) + "\n\n"

    def gen():
        yield ev({"stage": "steps", "steps": steps})

        def st(sid, state, msg=""):
            return ev({"stage": "step", "id": sid, "state": state, "msg": msg})

        yield st("check", "run", "正在校验创建参数…")
        if err:
            resp, code = err
            try:
                msg = (resp.get_json(silent=True) or {}).get("error") or "参数有误"
            except Exception:
                msg = "参数有误"
            yield st("check", "err", msg)
            yield ev({"stage": "error", "msg": msg, "code": code})
            return

        name, target, template = info["name"], info["target"], info["template"]
        yield st("check", "ok", "参数通过：" + target)

        written, skipped, dirs, items, total_bytes = [], [], [], [], 0
        naming_files = []

        if template == scaffold.AI_KEY:
            # ── Agent 构建：模型边生成，这边边建目录、边写文件（原来的 4 步合成这 1 步）──
            yield st("ai", "run", "Agent 正在规划并构建项目…")
            import queue as _queue
            q = _queue.Queue()
            holder = {}

            def _worker():
                try:
                    holder["res"] = _ai_agent_build(info, sel, emit=lambda e: q.put(e))
                except Exception as exc:          # 线程里抛错也要让主流程能收到
                    holder["res"] = {"error": f"Agent 构建失败：{exc}"}
                q.put(None)                        # 结束标记

            threading.Thread(target=_worker, daemon=True).start()
            while True:
                item = q.get()
                if item is None:
                    break
                yield ev(item)
            res = holder.get("res") or {"error": "Agent 构建异常结束（没有拿到结果）"}
            if res.get("error"):
                aerr = res["error"]
                yield st("ai", "err", aerr)
                yield ev({"stage": "error", "msg": aerr,
                          "need_config": "尚未配置 AI" in aerr,
                          "disabled": "已在「设置 → 系统 AI」中关闭" in aerr})
                return
            written = res["written"]
            dirs = res["dirs"]
            skipped = res["skipped"]
            items = res["items"]
            total_bytes = res["bytes"]
            naming_files = [{"path": it["path"], "content": ""} for it in items]
            yield st("ai", "ok", f"Agent 已建好 {len(written)} 个文件")
        else:
            files = scaffold.render(template, name)
            naming_files = files
            # 先把清单定下来（校验 + 体量上限 + 目录清单），再一次性把整棵树推给前端
            yield st("tree", "run", "正在生成文件树…")
            items, skipped = scaffold.prepare_manifest(target, files)
            dirs = scaffold.plan_dirs(items)
            total_bytes = sum(it["bytes"] for it in items)
            yield ev({"stage": "plan",
                      "items": [{"path": it["path"], "size": it["bytes"]} for it in items],
                      "files": [it["path"] for it in items],
                      "dirs": dirs, "skipped": skipped,
                      "n": len(items), "nd": len(dirs), "bytes": total_bytes,
                      "msg": (f"{len(dirs)} 个目录 / {len(items)} 个文件"
                              if items else "空项目：不创建文件")})
            yield st("tree", "ok", f"已规划 {len(dirs)} 个目录、{len(items)} 个文件")

            yield st("dirs", "run", "正在创建目录…")
            try:
                os.makedirs(target, exist_ok=True)   # 父目录不存在时一并建出来
                for i, d in enumerate(dirs, 1):
                    os.makedirs(os.path.join(target, d), exist_ok=True)
                    yield ev({"stage": "dir", "path": d, "i": i, "n": len(dirs)})
                    time.sleep(0.02)          # 本地建目录是毫秒级，稍作停留让前端逐个点亮
            except PermissionError:
                yield st("dirs", "err", f"没有权限在此处创建：{target}")
                yield ev({"stage": "error", "msg": f"没有权限在此处创建：{target}"})
                return
            except Exception as e:
                yield st("dirs", "err", f"创建目录失败：{str(e)}")
                yield ev({"stage": "error", "msg": f"创建目录失败：{str(e)}"})
                return
            yield st("dirs", "ok", f"已创建 {len(dirs)} 个目录")

            yield st("files", "run", "正在写入文件…")
            skipped2 = []
            for i, it in enumerate(items, 1):
                w, s = scaffold.write_prepared([it])      # 一次一个文件，便于逐个回报
                written += w
                skipped2 += s
                yield ev({"stage": "file", "path": it["path"], "i": i, "n": len(items),
                          "ok": bool(w), "size": it["bytes"]})
                time.sleep(0.05)
            skipped += skipped2
            yield st("files", "ok", f"已写入 {len(written)} 个文件" +
                     (f"，跳过 {len(skipped)} 个" if skipped else ""))

        # 代码写完 → 根据实际生成的内容给出候选项目名。
        # 注意：这里只「建议」，不自动改名 —— 前端会进入「项目名」这一步，
        # 用户可挑选 / 修改，确认后再调 /api/projects/rename 完成重命名。
        suggested, naming_note = [], ""
        if template == scaffold.AI_KEY:
            yield st("naming", "run", "正在根据生成的代码给项目起名…")
            names, nerr = _ai_final_name(info["brief"], naming_files, sel)
            free = [n for n in (names or []) if not os.path.exists(
                os.path.join(info["parent_abs"], n["name"] if isinstance(n, dict) else n))]
            if free:
                suggested = free[:4]
                first = suggested[0]["name"] if isinstance(suggested[0], dict) else suggested[0]
                yield st("naming", "ok", f"AI 建议叫 {first}（下一步可改）")
            else:
                naming_note = nerr or "AI 给的名字都已被占用，可用临时目录名或自己起一个"
                yield st("naming", "err", naming_note)

        yield st("done", "ok", "项目创建完成")
        yield ev({"stage": "done", "path": target, "temp_path": target,
                  "suggested": suggested, "naming_note": naming_note,
                  "template": template, "written": written, "skipped": skipped,
                  "dirs": dirs, "bytes": total_bytes})
        _log.info("新建项目（流式）：%s（框架=%s，目录 %d，写入 %d 个文件）",
                  target, template, len(dirs), len(written))

    return FlaskResponse(gen(), mimetype="text/event-stream",
                         headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@bp.route("/api/projects/rename", methods=["POST"])
def api_projects_rename():
    """把新建出来的项目目录改成用户确认后的名字（在「项目名」这一步点完成时调用）。

    name 传空表示「保持临时目录名」，直接返回原路径。
    """
    data = request.get_json(silent=True) or {}
    path = (data.get("path") or "").strip()
    name = (data.get("name") or "").strip()
    if not path.startswith("/") or not os.path.isdir(path):
        return jsonify({"error": "项目路径无效或不存在"}), 400
    if not name:
        return jsonify({"ok": True, "path": path, "renamed": False})
    if name in (".", "..") or "/" in name or "\\" in name:
        return jsonify({"error": "项目名不能包含路径分隔符"}), 400
    if any(ch in name for ch in '<>:"|?*'):
        return jsonify({"error": '项目名不能包含 < > : " | ? * 等字符'}), 400
    if len(name) > 128:
        return jsonify({"error": "项目名过长（上限 128 字符）"}), 400

    parent = os.path.dirname(path)
    dst = os.path.join(parent, name)
    if os.path.abspath(dst) == os.path.abspath(path):
        return jsonify({"ok": True, "path": path, "renamed": False})
    if os.path.exists(dst):
        return jsonify({"error": f"目录已存在：{name}"}), 409
    try:
        os.rename(path, dst)
    except Exception as e:
        return jsonify({"error": f"重命名失败：{e}"}), 500
    _log.info("项目重命名：%s → %s", path, dst)
    return jsonify({"ok": True, "path": dst, "renamed": True})


@bp.route("/api/system")
def api_system():
    _log.info("GET /api/system")
    home = os.path.expanduser("~")
    if sys.platform.startswith("win"):
        root = os.environ.get("SystemDrive", "C:") + "\\"
        # Windows 桌面路径
        desktop = os.path.join(home, "Desktop")
    else:
        root = "/"
        # Linux 桌面路径（支持常见中文/英文路径）
        desktop = os.path.join(home, "Desktop")
        if not os.path.isdir(desktop):
            desktop = os.path.join(home, "桌面")
        if not os.path.isdir(desktop):
            desktop = home  # 回退到主目录
    return jsonify({"home": home, "root": root, "desktop": desktop})


@bp.route("/api/size-status")
def api_size_status():
    """查询目录列表中仍在后台计算大小的子目录（前端轮询用，秒回）"""
    _log.info("GET /api/size-status path=%s", request.args.get("path", ""))
    target_path = safe_path(request.args.get("path", ""))
    if not os.path.isdir(target_path):
        return jsonify({"error": "路径不存在"}), 400
    show_hidden = request.args.get("hidden", "0") == "1"
    items = list_directory(target_path, get_sizes=False, show_hidden=show_hidden, size_budget_ms=300)
    # 直接查全局后台计算集合，避免依赖列表缓存快照
    target_abs = os.path.abspath(target_path)
    for it in items:                       # 快照里仍待计算的目录：确保后台真的在算（幂等）
        if it.get("is_dir") and it.get("size_pending"):
            _ensure_dir_size_async(os.path.join(target_abs, it["name"]))
    with _SIZE_PENDING_LOCK:
        pending = [os.path.basename(p) for p in _SIZE_PENDING
                   if os.path.dirname(os.path.abspath(p)) == target_abs]
    # 附带已算好的子目录大小，供前端本地更新条目（避免完成后全量请求 /api/files）
    sizes = {}
    for it in items:
        if not it.get("is_dir"):
            continue
        entry = _DIR_SIZE_CACHE.get(os.path.join(target_abs, it["name"]))
        if entry and isinstance(entry.get("size"), (int, float)) and entry["size"] >= 0:
            sizes[it["name"]] = entry["size"]
    return jsonify({"pending": pending, "total": len(items), "sizes": sizes})


@bp.route("/api/files")
def api_files():
    _log.info("GET /api/files path=%s", request.args.get("path", ""))
    rel_path = request.args.get("path", "")
    target_path = safe_path(rel_path)
    if not os.path.isdir(target_path):
        # 路径已失效（目录被删除 / 重命名等）：自动逐级向上回退到最近存在的上级目录，
        # 不再直接报错。前端也会做同一回退，这里作为兜底，让任意客户端（移动端 / IDE / API）都受益。
        cur = target_path
        while cur and not os.path.isdir(cur):
            parent = os.path.dirname(cur)
            if parent == cur:
                break
            cur = parent
        if not cur or not os.path.isdir(cur):
            return jsonify({"error": f"路径不存在或不是目录: {target_path}"}), 400
        target_path = cur
        rel_path = target_path   # 让返回的当前路径反映实际目录

    # 分页参数（客户端可传 limit/offset）
    try:
        limit = int(request.args.get("limit", 0))
        if limit < 0:
            limit = 0
    except (TypeError, ValueError):
        limit = 0
    try:
        offset = int(request.args.get("offset", 0))
        if offset < 0:
            offset = 0
    except (TypeError, ValueError):
        offset = 0

    show_hidden = request.args.get("hidden", "0") == "1"
    # 子项计数（n_dirs / n_files）要对每个子目录 scandir 一次，桌面端用不到：
    # 默认不算，移动端列表视图按需传 counts=1。
    counts = request.args.get("counts", "0") == "1"
    # 目录列表：浏览时不同步计算目录大小（避免挂载盘 du 拖慢请求，已缓存/索引命中的仍带回）。
    # 查索引求子树大小也设总预算（1.2s）：分区根这类几百万行的子树一次求和要数秒，
    # 不能让一次列表请求等它 —— 超预算的先标 size_pending，下面起后台线程算完写缓存，
    # 前端轮询 /api/size-status 原地补上（不再整页刷新）。
    items = list_directory(target_path, get_sizes=False, show_hidden=show_hidden,
                           counts=counts, size_budget_ms=1200)
    target_abs_dir = abs_path = os.path.abspath(target_path)
    # 保险箱：锁定期间把「受保护」的条目从列表里隐藏（源文件仍在磁盘上，只是不显示）
    try:
        from .vault import filter_hidden as _vault_filter
        items = _vault_filter(items, abs_path)
    except Exception:
        pass
    for it in items:
        if it.get("is_dir") and it.get("size_pending"):
            _ensure_dir_size_async(os.path.join(target_abs_dir, it["name"]))
    total_size = sum(item["size"] for item in items if item.get("size", 0) >= 0)
    total_files = sum(1 for item in items if not item["is_dir"])
    total_dirs = sum(1 for item in items if item["is_dir"])

    total_items = len(items)
    items_page = items[offset:offset + limit] if limit > 0 else items
    has_more = (offset + limit) < total_items if limit > 0 else False

    return jsonify({
        "current_path": rel_path,
        "current_path_abs": abs_path,
        "items": items_page,
        "total_items": total_items,
        "offset": offset,
        "limit": limit,
        "has_more": has_more,
        "stats": {
            "total_files": total_files,
            "total_dirs": total_dirs,
            "total_size": total_size,
            "total_size_str": format_size(total_size),
        },
        "parent_path": os.path.dirname(target_path) if os.path.dirname(target_path) != target_path else None,
    })


_TEXT_SNIFF_BYTES = 8192        # 嗅探只读前 8KB：足以判定二进制/文本，大文件也不慢
_TEXT_SNIFF_CTRL_RATIO = 0.30   # 控制字符占比超过 30% 视为二进制


# ======================================================================
# 预览接口统一返回提示
#
# 所有失败响应都是同一套结构，前端只负责展示，不再各自拼文案：
#   { "error": 一句话结论, "code": 机器可读原因, "hint": 怎么处理/能做什么,
#     "detail": 原始错误（可选）, ...业务附加字段 }
# code 取值固定为下面 7 种，新增提示只需在表里加一行。
# ======================================================================
_PREVIEW_HINTS = {
    "bad_path": ("文件不存在或不是文件",
                 "目标可能已被删除、重命名，或路径指向的是目录；刷新文件树后再试。"),
    "denied": ("没有读取权限",
               "运行服务的用户无法读取该文件。可在服务器执行 sudo chmod a+r '<路径>'，"
               "或在 IDE 里点「一键获取访问权限」。"),
    "too_large": ("文件太大，无法在线预览",
                  "文本上限 20MB、图片上限 50MB；超大文件请用命令行工具查看或下载到本地。"),
    "binary": ("这是二进制文件，不支持在线预览",
               "可执行文件、压缩包、图片、音视频容器等请下载后用本地工具打开；"
               "IDE 支持文本、图片、视频、SQLite、表格的预览与编辑。"),
    "unsupported": ("暂不支持预览该类型",
                    "IDE 目前支持文本、图片、视频、SQLite 与表格文件的预览与编辑。"),
    "read_failed": ("读取文件失败",
                    "文件可能正被其它程序占用，或磁盘 / 网络存储异常，稍后重试。"),
    "db_failed": ("无法读取数据库",
                  "文件可能已损坏、被加密，或不是有效的 SQLite 数据库。"),
}


def _preview_err(code, status=400, title="", hint="", **extra):
    """按统一的提示表返回预览失败信息（error / code / hint [+ detail]）。"""
    t, h = _PREVIEW_HINTS.get(code, ("预览失败", "请稍后重试，或换个方式打开该文件。"))
    payload = {"error": title or t, "code": code, "hint": hint or h}
    payload.update({k: v for k, v in extra.items() if v})
    return jsonify(payload), status


def _looks_like_text(target_path: str) -> bool:
    """按内容判断是不是文本文件（扩展名不在白名单时用）。

    判定沿用 git / file 的经典做法：
      · 空文件 → 文本（可打开手工写内容）；
      · 样本里出现 NUL 字节 → 二进制（可执行文件、图片、压缩包等几乎必含 NUL）；
      · 否则统计控制字符占比，超过阈值才算二进制。
    高位字节（>=0x80）不当作控制字符，UTF-8 / GBK 中文照常认作文本。
    读不了（没权限等）直接抛出 OSError，由调用方按「没有读取权限 / 读取失败」提示。
    """
    with open(target_path, "rb") as f:
        sample = f.read(_TEXT_SNIFF_BYTES)
    if not sample:
        return True
    if b"\x00" in sample:
        return False
    ctrl = sum(1 for b in sample if b < 0x09 or 0x0E <= b < 0x20 or b == 0x7F)
    return (ctrl / len(sample)) <= _TEXT_SNIFF_CTRL_RATIO


@bp.route("/api/preview")
def api_preview():
    _log.info("GET /api/preview")
    rel_path = request.args.get("path", "")
    target_path = os.path.abspath(os.path.normpath(rel_path))
    if not os.path.isfile(target_path):
        return _preview_err("bad_path", 400)
    try:
        stat = os.stat(target_path)
        ext = os.path.splitext(target_path)[1].lower().lstrip(".")
        filename = os.path.basename(target_path).lower()
        # 链式扩展名匹配：app.log.20260826 / debug.json.bak 这类多段后缀，
        # 只要任一段是已知文本/图片类型就按对应类型处理（日志按天轮转场景）
        segments = [s for s in filename.split(".") if s]
        # 点开头文件（.env / .env.example / .npmrc 等）：splitext 取不到扩展名，
        # 按首段名匹配点文件集合视为文本（.env.example 这类带后缀的变体也命中）
        is_dotfile_text = filename.startswith(".") and segments and segments[0] in _DOTFILE_TEXT_STEMS
        is_text = (ext in _TEXT_EXTS or filename in _TEXT_FILENAMES
                   or any(seg in _TEXT_EXTS for seg in segments[1:])
                   or is_dotfile_text)
        is_image = ext in _IMAGE_EXTS or any(seg in _IMAGE_EXTS for seg in segments[1:])
        # 扩展名没命中任何名单（go.mod / .sum / 自定义后缀 / 无后缀的普通文本…）：
        # 不再直接判「不支持」，改为按文件内容嗅探 —— 能当文本读就照常返回文本，
        # 只有真正的二进制（含 NUL 或大量控制字符）才判不支持。白名单退化为「快速通道」。
        if (not is_text and not is_image and ext not in _VIDEO_EXTS
                and ext not in _AUDIO_EXTS and ext not in _SQLITE_EXTS):
            is_text = _looks_like_text(target_path)
        mime_type, _ = mimetypes.guess_type(target_path)
        if not mime_type:
            mime_type = "application/octet-stream"
        # SQLite 数据库：不做大小限制，返回表清单；数据行由 /api/sqlite/rows 按表分页取
        if ext in _SQLITE_EXTS:
            try:
                tables, stat2 = _sqlite_read_tables(target_path)
            except Exception as e:
                return _preview_err("db_failed", 500, detail=str(e))
            return jsonify({
                "type": "sqlite",
                "ext": ext,
                "tables": tables,
                "size": stat2.st_size,
                "size_str": format_size(stat2.st_size),
            })
        # 文本/图片限制：文本 20MB，图片 50MB
        _limit = _TEXT_PREVIEW_MAX_BYTES if is_text else _PREVIEW_MAX_BYTES
        if ext not in _VIDEO_EXTS and ext not in _AUDIO_EXTS and stat.st_size > _limit:
            return _preview_err("too_large", 413,
                                title=f"文件太大，无法在线预览（上限 {format_size(_limit)}）",
                                size=stat.st_size, size_str=format_size(stat.st_size),
                                limit=format_size(_limit))
        # 音频：不限制大小，走 /api/stream（支持 Range，可拖进度）；IDE 用标签页内音频播放器。
        # 放在视频分支之前：ogg 既是音频容器也是视频容器，按 mimetypes 判出的主类型决定走哪边
        if ext in _AUDIO_EXTS and not (mime_type or "").startswith("video/"):
            return jsonify({
                "type": "audio",
                "ext": ext,
                "name": os.path.basename(target_path),
                "stream_url": f"/api/stream?path={quote(target_path)}",
                "content_type": mime_type or f"audio/{ext}",
                "size": stat.st_size,
                "size_str": format_size(stat.st_size),
            })
        # 视频：不限制大小，用流式传输，返回 stream URL
        if ext in _VIDEO_EXTS:
            return jsonify({
                "type": "video",
                "ext": ext,
                "stream_url": f"/api/stream?path={quote(target_path)}",
                "content_type": mime_type or f"video/{ext}",
                "size": stat.st_size,
                "size_str": format_size(stat.st_size),
            })
        # 文本：raw=1 时直接返回纯文本（不套 JSON/base64），大文件加载快很多（IDE 使用）
        if is_text and request.args.get("raw") == "1":
            with open(target_path, "r", encoding="utf-8", errors="replace", newline="") as f:
                text = f.read()
            resp = FlaskResponse(text, status=200, mimetype="text/plain")
            resp.headers["X-Preview-Type"] = "text"
            resp.headers["X-Preview-Ext"] = ext
            resp.headers["X-File-Size"] = str(stat.st_size)
            resp.headers["Cache-Control"] = "no-store"
            return resp
        # 图片：raw=1 时直接返回图片字节（IDE 内嵌预览使用，前端 <img> 直接引用）
        if is_image and request.args.get("raw") == "1":
            with open(target_path, "rb") as f:
                data = f.read()
            resp = FlaskResponse(data, mimetype=mime_type)
            resp.headers["X-Preview-Type"] = "image"
            resp.headers["Cache-Control"] = "no-store"
            return resp
        # 文本/图片：base64 内联
        with open(target_path, "rb") as f:
            data = f.read()
        if is_text:
            import base64
            return jsonify({
                "type": "text",
                "ext": ext,
                "content": base64.b64encode(data).decode("utf-8"),
                "content_type": mime_type,
            })
        elif is_image:
            import base64
            return jsonify({
                "type": "image",
                "ext": ext,
                "content": base64.b64encode(data).decode("utf-8"),
                "content_type": mime_type,
            })
        else:
            # 走到这里说明内容嗅探已判定为二进制（含 NUL / 大量控制字符），
            # 提示语带上具体类型标记，避免笼统的「不支持的预览类型」
            tip = ("." + ext) if ext else "无扩展名"
            return _preview_err("binary", 400, title=f"这是二进制文件（{tip}），不支持在线预览",
                                ext=ext, size=stat.st_size, size_str=format_size(stat.st_size))
    except PermissionError as e:
        return _preview_err("denied", 403, detail=str(e))
    except OSError as e:
        return _preview_err("read_failed", 500, detail=str(e))


# ======================================================================
# 一键获取访问权限（文件因 Permission denied 打不开时使用）
#
# 场景：IDE 里点开某个文件提示「无法打开：无法读取文件: [Errno 13] Permission denied」，
# 原因是运行服务的用户对该文件没有读权限（典型：root 创建的 600 文件）。
# 这里由服务端尝试补上「读」权限（只加不减，不动执行/写入位）：
#   1) 服务进程是文件属主 → 直接 chmod a+r；
#   2) 不是属主 → 尝试免密 sudo（sudo -n，未配置免密时会立刻失败，不会卡住请求）；
#   3) 都不行 → 返回可在服务器上手动执行的命令，前端提供「复制修复命令」。
# ======================================================================
def _file_readable(target_path: str) -> bool:
    try:
        with open(target_path, "rb") as f:
            f.read(1)
        return True
    except (OSError, PermissionError):
        return False


def _file_mode_str(target_path: str) -> str:
    try:
        return oct(os.stat(target_path).st_mode & 0o777)[-3:]
    except OSError:
        return ""


def _grant_read_bits(target_path: str) -> str:
    """给文件补上读权限，返回生效方式（"chmod" / "sudo"），失败返回空串。"""
    try:
        st = os.stat(target_path)
        if (st.st_mode & 0o444) != 0o444:
            os.chmod(target_path, st.st_mode | 0o444)      # 属主是自己时直接生效
        if _file_readable(target_path):
            return "chmod"
    except OSError:
        pass
    from ... import config
    if not getattr(config, "ENABLE_EXEC", True):
        return ""
    try:
        r = subprocess.run(["sudo", "-n", "chmod", "a+r", "--", target_path],
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=8)
        if r.returncode == 0 and _file_readable(target_path):
            return "sudo"
        err = (r.stderr or b"").decode("utf-8", "replace").strip()
        _log.info("grant-access sudo 失败 %s: %s", target_path, err or r.returncode)
    except (OSError, subprocess.SubprocessError) as e:
        _log.info("grant-access sudo 异常 %s: %s", target_path, e)
    return ""


@bp.route("/api/file/grant-access", methods=["POST"])
def api_file_grant_access():
    """一键获取访问权限：把打不开的文件补上读权限，成功后前端自动重新打开。"""
    data = request.get_json(silent=True) or {}
    raw = str(data.get("path") or "").strip()
    if not raw:
        return jsonify({"error": "缺少 path 参数"}), 400
    target_path = os.path.abspath(os.path.normpath(raw))
    if not os.path.exists(target_path):
        return jsonify({"error": "文件不存在（可能已被删除或重命名）"}), 404
    if os.path.isdir(target_path):
        return jsonify({"error": "这是一个目录，不是文件"}), 400
    cmd = "sudo chmod a+r '%s'" % target_path.replace("'", "'\\''")
    if _file_readable(target_path):
        return jsonify({"ok": True, "already": True, "mode": _file_mode_str(target_path),
                        "cmd": cmd, "message": "该文件本来就可读，请重试打开"})
    via = _grant_read_bits(target_path)
    if not via:
        _log.warning("grant-access 失败 %s（当前用户无权限且 sudo 不可用）", target_path)
        return jsonify({
            "error": "自动授权失败：服务进程不是该文件的属主，且服务器未配置免密 sudo。"
                     "请在服务器执行下面的命令后重试。",
            "cmd": cmd,
        }), 403
    _log.info("grant-access 成功 %s via=%s mode=%s", target_path, via, _file_mode_str(target_path))
    return jsonify({"ok": True, "via": via, "mode": _file_mode_str(target_path), "cmd": cmd,
                    "message": "已获取读取权限"})


# ======================================================================
# SQLite 数据库只读预览（db / sqlite / sqlite3 / db3）
# ======================================================================
_SQLITE_EXTS = {"db", "sqlite", "sqlite3", "db3"}
_SQLITE_TABLE_MAX = 200          # 最多列出的表/视图数
_SQLITE_ROWS_DEFAULT = 100       # 每页默认行数
_SQLITE_ROWS_MAX = 500           # 每页最大行数
_SQLITE_CELL_MAX = 1000          # 单元格显示截断长度（避免超大 BLOB/文本撑爆响应）
_SQLITE_SQL_MAX = 20000          # SQL 文本长度上限
_SQLITE_QUERY_MAX = 2000         # 查询结果最多返回行数
_SQLITE_QUERY_TIMEOUT = 5        # 单条查询最长执行秒数（超出即中断，避免拖死服务）


def _is_sqlite_file(ext):
    return ext in _SQLITE_EXTS


def _sqlite_connect_ro(target_path):
    """以只读 URI 模式打开 SQLite，绝不写入（含 -wal/-shm 伴生文件的库也能安全打开）"""
    import sqlite3
    uri = "file:" + quote(target_path, safe="/") + "?mode=ro"
    con = sqlite3.connect(uri, uri=True, timeout=3)
    return con


def _sqlite_list_tables(cur):
    """列出用户表与视图（排除 sqlite_ 内部表），返回 [(name, type)]"""
    return [(r[0], r[1]) for r in cur.execute(
        "SELECT name, type FROM sqlite_master "
        "WHERE type IN ('table','view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' "
        "ORDER BY type, name").fetchall()]


def _sqlite_quote_ident(name):
    return '"' + str(name).replace('"', '""') + '"'


def _sqlite_cell(v):
    """单元格值序列化：BLOB 尝试文本解码，其余转字符串；超长截断"""
    if v is None or isinstance(v, (int, float)):
        return v
    if isinstance(v, bytes):
        try:
            v = v.decode("utf-8")
        except UnicodeDecodeError:
            v = v[:64].hex() + ("…" if len(v) > 64 else "")
            return f"<BLOB {v}>"
    s = str(v)
    if len(s) > _SQLITE_CELL_MAX:
        s = s[:_SQLITE_CELL_MAX] + f"…（共 {len(s)} 字符）"
    return s


@bp.route("/api/sqlite/tables")
def api_sqlite_tables():
    """列出 SQLite 数据库中的表与视图（含行数与列名）"""
    rel_path = request.args.get("path", "")
    target_path = os.path.abspath(os.path.normpath(rel_path))
    if not os.path.isfile(target_path):
        return jsonify({"error": "文件不存在"}), 404
    if not _is_sqlite_file(os.path.splitext(target_path)[1].lower().lstrip(".")):
        return jsonify({"error": "不是 SQLite 数据库文件"}), 400
    try:
        tables, stat = _sqlite_read_tables(target_path)
        return jsonify({
            "tables": tables,
            "size": stat.st_size,
            "size_str": format_size(stat.st_size),
        })
    except Exception as e:
        return jsonify({"error": f"无法读取数据库: {str(e)}"}), 500


def _sqlite_read_tables(target_path):
    """读取库中全部用户表/视图的行数与列名，返回 (tables, stat)"""
    stat = os.stat(target_path)
    con = _sqlite_connect_ro(target_path)
    cur = con.cursor()
    tables = []
    for name, ttype in _sqlite_list_tables(cur)[:_SQLITE_TABLE_MAX]:
        qn = _sqlite_quote_ident(name)
        try:
            rows = cur.execute(f"SELECT COUNT(*) FROM {qn}").fetchone()[0]
        except Exception:
            rows = None   # 损坏的表（如 page 泄漏）不阻塞整体列表
        try:
            columns = [r[1] for r in cur.execute(f"PRAGMA table_info({qn})").fetchall()]
        except Exception:
            columns = []
        tables.append({"name": name, "kind": ttype, "rows": rows, "columns": columns})
    con.close()
    return tables, stat


@bp.route("/api/sqlite/rows")
def api_sqlite_rows():
    """分页读取某个表/视图的数据（只读）"""
    rel_path = request.args.get("path", "")
    target_path = os.path.abspath(os.path.normpath(rel_path))
    if not os.path.isfile(target_path):
        return jsonify({"error": "文件不存在"}), 404
    table = request.args.get("table", "")
    try:
        limit = min(max(int(request.args.get("limit", _SQLITE_ROWS_DEFAULT)), 1), _SQLITE_ROWS_MAX)
        offset = max(int(request.args.get("offset", 0)), 0)
    except (TypeError, ValueError):
        limit, offset = _SQLITE_ROWS_DEFAULT, 0
    try:
        con = _sqlite_connect_ro(target_path)
        cur = con.cursor()
        # 表名必须真实存在于 sqlite_master，杜绝注入
        real_names = [r[0] for r in cur.execute(
            "SELECT name FROM sqlite_master WHERE type IN ('table','view')")]
        if table not in real_names:
            con.close()
            return jsonify({"error": "表不存在"}), 400
        qn = _sqlite_quote_ident(table)
        columns = [r[1] for r in cur.execute(f"PRAGMA table_info({qn})").fetchall()]
        total = cur.execute(f"SELECT COUNT(*) FROM {qn}").fetchone()[0]
        cur2 = con.execute(f"SELECT * FROM {qn} LIMIT ? OFFSET ?", (limit, offset))
        rows = [[_sqlite_cell(v) for v in row] for row in cur2.fetchall()]
        con.close()
        return jsonify({
            "table": table,
            "columns": columns,
            "rows": rows,
            "total": total,
            "limit": limit,
            "offset": offset,
        })
    except Exception as e:
        return jsonify({"error": f"读取数据失败: {str(e)}"}), 500


def _sqlite_query_error(e):
    """把 sqlite3 的报错翻译成更易懂的中文提示"""
    msg = str(e)
    if "readonly database" in msg:
        return "只读模式：不支持写操作（INSERT / UPDATE / DELETE / CREATE / DROP 等）"
    if "one statement at a time" in msg:
        return "一次只能执行一条 SQL 语句，请分多次运行"
    if msg == "interrupted":
        return f"查询执行超过 {_SQLITE_QUERY_TIMEOUT} 秒，已中断"
    if "no such table" in msg:
        return "表不存在：" + msg
    if "no such column" in msg:
        return "列不存在：" + msg
    if "syntax error" in msg or "incomplete input" in msg or "unrecognized token" in msg:
        return "SQL 语法错误：" + msg
    return "执行失败：" + msg


@bp.route("/api/sqlite/query", methods=["POST"])
def api_sqlite_query():
    """执行单条 SQL（只读连接，因此只能查询）。

    写操作由 SQLite 自身以 "readonly database" 拒绝，无需再做语句解析；
    多语句同样被 sqlite3 拒绝（一次一条）；长查询靠 progress handler 按截止时间中断。
    """
    data = request.get_json(silent=True) or {}
    target_path = os.path.abspath(os.path.normpath(data.get("path") or ""))
    sql = (data.get("sql") or "").strip()
    if not os.path.isfile(target_path):
        return jsonify({"error": "文件不存在"}), 404
    if not _is_sqlite_file(os.path.splitext(target_path)[1].lower().lstrip(".")):
        return jsonify({"error": "不是 SQLite 数据库文件"}), 400
    if not sql:
        return jsonify({"error": "请输入要执行的 SQL"}), 400
    if len(sql) > _SQLITE_SQL_MAX:
        return jsonify({"error": f"SQL 过长（上限 {_SQLITE_SQL_MAX} 字符）"}), 400
    try:
        limit = min(max(int(data.get("limit", _SQLITE_ROWS_DEFAULT)), 1), _SQLITE_QUERY_MAX)
    except (TypeError, ValueError):
        limit = _SQLITE_ROWS_DEFAULT

    t0 = time.time()
    con = None
    try:
        con = _sqlite_connect_ro(target_path)
        deadline = t0 + _SQLITE_QUERY_TIMEOUT
        # 每 2 万条 VM 指令检查一次，超时返回非 0 让 SQLite 抛出 interrupted
        con.set_progress_handler(lambda: 1 if time.time() > deadline else 0, 20000)
        cur = con.cursor()
        cur.execute(sql)
        columns = [d[0] for d in (cur.description or [])]
        raw = cur.fetchmany(limit + 1) if cur.description else []
        truncated = len(raw) > limit
        return jsonify({
            "columns": columns,
            "rows": [[_sqlite_cell(v) for v in row] for row in raw[:limit]],
            "row_count": min(len(raw), limit),
            "truncated": truncated,
            "limit": limit,
            "elapsed_ms": int((time.time() - t0) * 1000),
        })
    except Exception as e:
        return jsonify({
            "error": _sqlite_query_error(e),
            "elapsed_ms": int((time.time() - t0) * 1000),
        }), 400
    finally:
        if con is not None:
            try:
                con.close()
            except Exception:
                pass


# 「一句话生成」统一走 app/routes/common/dbconn.py 的 /api/db/nl2sql
# （SQLite 文件传 path，其它库传 conn + dbname），这里不再单独保留一份实现。


@bp.route("/api/raw/<path:fspath>")
def api_raw_path(fspath):
    """按原始内容与正确 MIME 返回文件。

    供 IDE 的 HTML 预览使用：iframe 内注入 <base href="/api/raw/<目录>/">，
    页面里的相对资源（js/css/img）就会请求 /api/raw/... 而被正确加载。
    fspath 为绝对路径去掉开头斜杠的形式（每段已在前端做 URL 编码）。

    例外：Markdown 文件直接返回渲染好的居中预览页（分享链接在浏览器里
    打开即是排版效果）；需要纯文本时加 ?raw=1。
    """
    full = os.path.abspath(os.sep + fspath)
    if not os.path.isfile(full):
        return jsonify({"error": "文件不存在"}), 404
    ext = os.path.splitext(full)[1].lower().lstrip(".")
    if ext in ("md", "markdown"):
        try:
            with open(full, "r", encoding="utf-8", errors="replace") as f:
                text = f.read()
        except (OSError, PermissionError) as e:
            return jsonify({"error": f"无法读取文件: {str(e)}"}), 500
        # ?raw=1 → 纯文本；否则返回渲染好的居中预览页
        if request.args.get("raw") == "1":
            resp = FlaskResponse(text, status=200, mimetype="text/plain")
            resp.headers["Cache-Control"] = "no-store"
            return resp
        resp = FlaskResponse(render_template(
            "markdown_view.html",
            content=text,
            title=os.path.basename(full),
        ), status=200, mimetype="text/html")
        resp.headers["Cache-Control"] = "no-store"
        return resp
    mime, _ = mimetypes.guess_type(full)
    if not mime:
        mime = "application/octet-stream"
    try:
        resp = send_file(full, mimetype=mime, as_attachment=False, conditional=True)
        resp.headers["Cache-Control"] = "no-store"
        return resp
    except (OSError, PermissionError) as e:
        return jsonify({"error": f"无法读取文件: {str(e)}"}), 500


def _get_file_path_from_request(req):
    """从请求参数安全地提取文件绝对路径"""
    rel_path = req.args.get("path", "")
    target_path = os.path.abspath(os.path.normpath(rel_path))
    if not os.path.isfile(target_path):
        return None
    return target_path


# ========== 收藏夹（常用文件夹，持久化到 data/storage/favorites.json） ==========
_FAV_LOCK = threading.Lock()
_FAV_MAX = 50


def _fav_file():
    return os.path.join(_STORAGE_DIR, "favorites.json")


def _load_favs():
    """收藏夹（一行一个收藏，seq 顺序即展示顺序）。"""
    try:
        conn = store_conn()
        try:
            rows = conn.execute(
                "SELECT path, name, added, group_name FROM favorites ORDER BY seq ASC").fetchall()
        finally:
            conn.close()
        out = []
        for r in rows:
            rec = {"path": r["path"], "name": r["name"], "added": r["added"]}
            if r["group_name"]:
                rec["group"] = r["group_name"]
            out.append(rec)
        return out
    except Exception:
        return []


def _save_favs(items):
    """整表覆盖写入（列表下标即 seq）。"""
    try:
        with store_tx() as conn:
            conn.execute("DELETE FROM favorites")
            for i, it in enumerate(items or []):
                if not isinstance(it, dict):
                    continue
                conn.execute(
                    "INSERT INTO favorites (seq, path, name, added, group_name) VALUES (?,?,?,?,?)",
                    (i, str(it.get("path") or ""), str(it.get("name") or ""),
                     int(it.get("added") or 0), str(it.get("group") or "")))
    except Exception as e:
        _log.warning("保存收藏夹失败：%s", e)


def _groups_file():
    return os.path.join(_STORAGE_DIR, "fav_groups.json")


def _load_groups():
    """分组展示顺序（一行一个分组）；"__ungrouped__" 表示「其他」分区的位置"""
    try:
        conn = store_conn()
        try:
            rows = conn.execute("SELECT name FROM fav_groups ORDER BY seq ASC").fetchall()
        finally:
            conn.close()
        return [str(r["name"]) for r in rows]
    except Exception:
        return []


def _save_groups(groups):
    """整表覆盖写入（列表下标即 seq）。"""
    try:
        with store_tx() as conn:
            conn.execute("DELETE FROM fav_groups")
            for i, g in enumerate(groups or []):
                conn.execute("INSERT INTO fav_groups (seq, name) VALUES (?,?)", (i, str(g)))
    except Exception as e:
        _log.warning("保存收藏分组失败：%s", e)


# 旧版 favorites.json / fav_groups.json（或上一版 kv 键）一次性导入
migrate_legacy_list("table_migrated:favorites", "favorites", _fav_file(), _save_favs)
migrate_legacy_list("table_migrated:fav_groups", "fav_groups", _groups_file(), _save_groups)


def _ensure_group(groups, name):
    """登记分组（保持顺序），新分组追加到末尾"""
    if name and name not in groups:
        groups.append(name)


@bp.route("/api/favorites")
def api_fav_list():
    """收藏夹列表：{items: [{path, name, added, group?, is_dir}], groups: [分组顺序]}"""
    items = []
    for it in _load_favs():
        p = it.get("path", "")
        rec = dict(it)
        rec["is_dir"] = os.path.isdir(p) if p else False
        items.append(rec)
    return jsonify({"items": items, "groups": _load_groups()})


@bp.route("/api/favorites", methods=["POST"])
def api_fav_add():
    body = request.get_json(silent=True) or {}
    path = (body.get("path") or "").strip()
    full = os.path.abspath(os.path.normpath(path)) if path else ""
    if not full or not os.path.exists(full):
        return jsonify({"error": "路径不存在"}), 400
    group = (body.get("group") or "").strip()[:50]
    with _FAV_LOCK:
        items = _load_favs()
        items = [it for it in items if os.path.normpath(it.get("path", "")) != os.path.normpath(full)]
        rec = {
            "path": full,
            "name": os.path.basename(full) or full,
            "added": int(time.time()),
        }
        if group:
            rec["group"] = group
        items.insert(0, rec)
        _save_favs(items[:_FAV_MAX])
        if group:
            groups = _load_groups()
            _ensure_group(groups, group)
            _save_groups(groups)
    return jsonify({"ok": True})


@bp.route("/api/favorites", methods=["DELETE"])
def api_fav_del():
    body = request.get_json(silent=True) or {}
    path = (body.get("path") or "").strip()
    if not path:
        return jsonify({"error": "path 不能为空"}), 400
    with _FAV_LOCK:
        items = [it for it in _load_favs()
                 if os.path.normpath(it.get("path", "")) != os.path.normpath(path)]
        _save_favs(items)
    return jsonify({"ok": True})


@bp.route("/api/favorites", methods=["PUT"])
def api_fav_set_group():
    """修改单条收藏的分组（group 传空 = 移入「其他」）"""
    body = request.get_json(silent=True) or {}
    path = (body.get("path") or "").strip()
    group = (body.get("group") or "").strip()[:50]
    if not path:
        return jsonify({"error": "path 不能为空"}), 400
    with _FAV_LOCK:
        items = _load_favs()
        hit = False
        for it in items:
            if os.path.normpath(it.get("path", "")) == os.path.normpath(path):
                if group:
                    it["group"] = group
                else:
                    it.pop("group", None)
                hit = True
        if not hit:
            return jsonify({"error": "收藏不存在"}), 404
        _save_favs(items)
        if group:
            groups = _load_groups()
            _ensure_group(groups, group)
            _save_groups(groups)
    return jsonify({"ok": True})


@bp.route("/api/favorites/group", methods=["POST", "PUT", "DELETE"])
def api_fav_group():
    """POST: 新建分组（{name}）/ 重命名分组（{old, name}）
    PUT: 保存分组拖动排序（{groups: [...]}，可含 "__ungrouped__" 标记「其他」位置）
    DELETE: 删除分组（{name}，收藏保留变为未分组）"""
    if request.method == "PUT":
        body = request.get_json(silent=True) or {}
        groups = []
        for g in (body.get("groups") or []):
            g = str(g).strip()[:50]
            if g and g not in groups:
                groups.append(g)
        _save_groups(groups)
        return jsonify({"ok": True})
    body = request.get_json(silent=True) or {}
    name = (body.get("name") or "").strip()[:50]
    if not name:
        return jsonify({"error": "分组名不能为空"}), 400
    with _FAV_LOCK:
        items = _load_favs()
        groups = _load_groups()
        if request.method == "POST":
            old = (body.get("old") or "").strip()
            if old:
                # 重命名分组
                changed = 0
                for it in items:
                    if (it.get("group") or "") == old:
                        it["group"] = name
                        changed += 1
                if not changed and old not in groups:
                    return jsonify({"error": "分组不存在"}), 404
                had = old in groups
                groups = [name if g == old else g for g in groups]
                if not had and name not in groups:
                    groups.append(name)
            else:
                # 新建空分组
                if name in groups or any((it.get("group") or "") == name for it in items):
                    return jsonify({"error": "分组已存在"}), 400
                _ensure_group(groups, name)
        else:
            # 删除分组：收藏保留（变为未分组）
            changed = 0
            for it in items:
                if (it.get("group") or "") == name:
                    it.pop("group", None)
                    changed += 1
            if not changed and name not in groups:
                return jsonify({"error": "分组不存在"}), 404
            groups = [g for g in groups if g != name]
        _save_favs(items)
        _save_groups(groups)
    return jsonify({"ok": True})


def _make_thumb_etag(target_path):
    """根据文件的 mtime + size 生成 ETag，文件未修改时浏览器可直接复用缓存"""
    try:
        st = os.stat(target_path)
        return '"%x-%x"' % (int(st.st_mtime), int(st.st_size))
    except OSError:
        return None


@bp.route("/api/thumbnail")
def api_thumbnail():
    """获取文件缩略图（图片直接返回，视频提取帧）

    支持强缓存：源文件未修改（mtime/size 不变）时返回 304，
    浏览器不再重复请求解码，避免每次刷新都走 ffmpeg 抽帧。
    """
    target_path = _get_file_path_from_request(request)
    if target_path is None:
        _log.info("GET /api/thumbnail -> 404 (文件不存在)")
        return jsonify({"error": "文件不存在"}), 404

    etag = _make_thumb_etag(target_path)
    # 协商缓存：命中即返回 304，不传输数据
    if etag and request.headers.get("If-None-Match") == etag:
        resp = FlaskResponse(status=304)
        resp.headers["ETag"] = etag
        resp.headers["Cache-Control"] = "public, max-age=604800"
        return resp

    ext = os.path.splitext(target_path)[1].lower().lstrip(".")
    if ext in _VIDEO_EXTS:
        # 视频：走「视频名+大小 hash」持久化封面缓存（index.json + 本地图片），跨重启复用，不重复抽帧
        data, content_type = get_video_cover(target_path)
    else:
        data, content_type = _get_thumbnail_bytes(target_path)
    if data is None:
        return jsonify({"error": "无法生成缩略图"}), 400

    resp = FlaskResponse(data, status=200, content_type=content_type)
    # 强缓存 7 天；文件改变时 ETag 变化会自动失效，故缓存期可设较长
    resp.headers["Cache-Control"] = "public, max-age=604800"
    if etag:
        resp.headers["ETag"] = etag
    return resp


@bp.route("/api/imagesize", methods=["POST"])
def api_imagesize():
    """批量获取图片原始尺寸（只读文件头，不解码整图）。

    移动版图片查看器（PhotoSwipe）在打开前需要每张图的真实宽高用于缩放与占位布局，
    这里一次性批量返回，避免前端逐张下载完才知道尺寸导致布局跳动。
    请求体：{"paths": ["/abs/a.jpg", "/abs/b.png"]}
    返回：  {"sizes": {"/abs/a.jpg": [w, h], "/abs/b.png": null}}
    """
    data = request.get_json(silent=True) or {}
    paths = data.get("paths") or []
    if not isinstance(paths, list):
        return jsonify({"error": "参数格式错误"}), 400
    if len(paths) > 2000:
        paths = paths[:2000]

    try:
        from PIL import Image
    except ImportError:
        _log.warning("GET /api/imagesize -> Pillow 不可用，返回空尺寸")
        return jsonify({"sizes": {}})

    sizes = {}
    for p in paths:
        key = str(p)
        try:
            target = os.path.abspath(os.path.normpath(key))
            if not os.path.isfile(target):
                sizes[key] = None
                continue
            # Image.open 惰性解析，仅读取文件头即可拿到尺寸（不触发像素解码）
            with Image.open(target) as im:
                sizes[key] = [int(im.width), int(im.height)]
        except Exception:
            sizes[key] = None
    return jsonify({"sizes": sizes})


@bp.route("/api/video_duration")
def api_video_duration():
    """获取音视频时长（秒），供播放列表异步显示；服务端内存缓存，文件未变时秒回"""
    target_path = _get_file_path_from_request(request)
    if target_path is None:
        return jsonify({"error": "文件不存在"}), 404
    ext = os.path.splitext(target_path)[1].lower().lstrip(".")
    if ext not in _VIDEO_EXTS and ext not in _AUDIO_EXTS:
        return jsonify({"error": "不是音视频文件"}), 400
    dur = get_video_duration(target_path)
    if dur is None:
        return jsonify({"error": "无法获取时长"}), 404
    return jsonify({"duration": round(dur, 1)})


def _thumb_cache_stats():
    """统计磁盘缩略图缓存条目数与占用大小"""
    count = 0
    total = 0
    try:
        with os.scandir(_THUMB_CACHE_DIR) as it:
            for e in it:
                if not e.name.endswith(".bin"):
                    continue
                try:
                    total += e.stat().st_size
                    count += 1
                except OSError:
                    continue
    except OSError:
        pass
    return count, total


@bp.route("/api/thumbnail/cache")
def api_thumbnail_cache_info():
    """查询缩略图缓存占用情况"""
    count, total = _thumb_cache_stats()
    return jsonify({
        "entries": count,
        "size": total,
        "size_str": format_size(total) if total else "0 B",
        "dir": _THUMB_CACHE_DIR,
    })


@bp.route("/api/thumbnail/cache/clear", methods=["POST"])
def api_thumbnail_cache_clear():
    """清空缩略图缓存（内存 + 磁盘），下次访问会重新生成"""
    _clear_thumb_cache()
    return jsonify({"ok": True, "message": "缩略图缓存已清空"})


@bp.route("/api/raw")
def api_raw():
    """原图直出（图片预览缩放用）：send_file 条件请求支持 Range / 304"""
    target_path = _get_file_path_from_request(request)
    if target_path is None:
        _log.warning("GET /api/raw -> 404 (path=%s)", request.args.get("path", "")[:200])
        return jsonify({"error": "文件不存在"}), 404

    ext = os.path.splitext(target_path)[1].lower().lstrip(".")
    # 除图片外允许 lrc 歌词文本（音乐播放器加载同名歌词用）
    if ext not in _IMAGE_EXTS and ext != "lrc":
        _log.warning("GET /api/raw -> 400 不支持的扩展名: %s (%s)", ext, target_path)
        return jsonify({"error": "该文件类型不支持"}), 400

    try:
        mime_type, _ = mimetypes.guess_type(target_path)
        if not mime_type:
            mime_type = (f"image/{ext}" if ext in _IMAGE_EXTS else "text/plain; charset=utf-8")
        # 原图直出必须禁用缓存/304，避免浏览器复用旧的降采样图
        resp = send_file(target_path, mimetype=mime_type, conditional=False)
        resp.headers["Accept-Ranges"] = "bytes"
        resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate"
        resp.headers["Pragma"] = "no-cache"
        resp.headers["Expires"] = "0"
        return resp
    except (OSError, PermissionError) as e:
        _log.error("GET /api/raw -> 无法读取文件 %s: %s", target_path, e)
        return jsonify({"error": f"无法读取文件: {str(e)}"}), 500


@bp.route("/api/image")
def api_image():
    """图片预览大图：按最长边等比缩放的清晰版（默认 2560px、JPEG 质量 88）。

    动辄几十 MB 的原图（长截图 / 大 GIF）直接给移动端会长时间转圈甚至加载失败，
    这里由服务端降采样后再下发，结果走缩略图同款缓存（带尺寸前缀）。
    原图小于 3MB 时直接原图直出，保留动图效果。
    """
    target_path = _get_file_path_from_request(request)
    if target_path is None:
        _log.info("GET /api/image -> 404 (文件不存在)")
        return jsonify({"error": "文件不存在"}), 404
    try:
        max_side = int(request.args.get("max", 2560))
    except (ValueError, TypeError):
        max_side = 2560
    max_side = max(320, min(4096, max_side))

    # 协商缓存：源文件未修改时直接 304，避免重复解码/传输大图
    etag = _make_thumb_etag(target_path)
    if etag and request.headers.get("If-None-Match") == etag:
        resp = FlaskResponse(status=304)
        resp.headers["ETag"] = etag
        resp.headers["Cache-Control"] = "private, max-age=604800"
        return resp

    data, content_type = _get_preview_bytes(target_path, max_side=max_side)
    if data is None:
        # 降级：若 Pillow 处理失败或文件无法读取，直接返回原图
        try:
            mime_type, _ = mimetypes.guess_type(target_path)
            if not mime_type:
                mime_type = "application/octet-stream"
            with open(target_path, "rb") as f:
                data = f.read()
            content_type = mime_type
        except (OSError, PermissionError) as e:
            _log.warning("GET /api/image -> 无法读取文件: %s", e)
            return jsonify({"error": "该文件类型不支持预览"}), 400
    resp = FlaskResponse(data, status=200, content_type=content_type)
    resp.headers["Cache-Control"] = "private, max-age=604800"
    if etag:
        resp.headers["ETag"] = etag
    return resp


@bp.route("/api/stream")
def api_stream():
    _log.info("GET /api/stream")
    """音视频流式传输，支持 HTTP Range 请求（可暂停/拖进度/缓冲播放）"""
    target_path = _get_file_path_from_request(request)
    if target_path is None:
        return jsonify({"error": "文件不存在"}), 404

    ext = os.path.splitext(target_path)[1].lower().lstrip(".")
    is_audio = ext in _AUDIO_EXTS
    if ext not in _VIDEO_EXTS and not is_audio:
        return jsonify({"error": "该文件类型不支持流式播放"}), 400

    try:
        mime_type, _ = mimetypes.guess_type(target_path)
        if not mime_type:
            mime_type = (f"audio/{ext}" if is_audio else f"video/{ext}")

        # conditional=True 由 Flask/Werkzeug 标准实现处理 Range 请求：
        # 无 Range → 200 全量；"bytes=0-" / "100-200" / "-500"（后缀区间，探测
        # mp4 片尾 moov 用）→ 206 正确分片；非法区间 → 416。
        # 旧手写解析不认后缀区间，导致播放器拿不到片尾数据而反复重试。
        resp = send_file(target_path, mimetype=mime_type, conditional=True)
        resp.headers["Accept-Ranges"] = "bytes"
        # 允许浏览器缓存 Range 分片（同视频二次打开/回拖时命中本地缓存），
        # 减少重复 206 请求，起播更快
        resp.headers["Cache-Control"] = "public, max-age=86400"
        return resp

    except (OSError, PermissionError) as e:
        return jsonify({"error": f"无法读取文件: {str(e)}"}), 500


# ======================================================================
# 视频实时转码兜底：浏览器解不了视频轨（HEVC/H.265、10bit H.264 等——
# 症状是有声音有时长但没有画面）时，服务端用 ffmpeg 实时转成
# H.264/AAC 的 fMP4 流给播放器。支持 ss 参数（秒或 hh:mm:ss）定位起播。
# ======================================================================
_TRANCODE_SEM = threading.BoundedSemaphore(2)   # 最多同时 2 路转码，防止 CPU 打满


def _parse_ss(v):
    """校验 ss 参数：纯秒数（"12.5"）或 hh:mm:ss(.ms)；合法返回原文，非法返回 None"""
    v = (v or "").strip() or "0"
    if re.fullmatch(r"\d+(\.\d+)?", v) or re.fullmatch(r"(\d{1,3}:)?\d{1,2}:\d{1,2}(\.\d+)?", v):
        return v
    return None


def _probe_audio_codec(path):
    """用 ffprobe 探测文件主音频流编码；返回 (has_audio, codec_name) 或 (False, None)。"""
    try:
        out = subprocess.run(
            [FFPROBE_BIN, "-v", "error", "-select_streams", "a:0", "-show_entries",
             "stream=codec_name", "-of", "default=nw=1:nk=1", path],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=10, check=False
        ).stdout.decode("utf-8", "ignore").strip().lower()
        return (bool(out), out.splitlines()[0] if out else None)
    except Exception:
        return (False, None)


@bp.route("/api/stream_transcode")
def api_stream_transcode():
    target_path = _get_file_path_from_request(request)
    if target_path is None:
        return jsonify({"error": "文件不存在"}), 404
    ext = os.path.splitext(target_path)[1].lower().lstrip(".")
    if ext not in _VIDEO_EXTS:
        return jsonify({"error": "该文件类型不支持转码播放"}), 400
    ss = _parse_ss(request.args.get("ss"))
    if ss is None:
        return jsonify({"error": "ss 参数非法"}), 400

    has_audio, audio_codec = _probe_audio_codec(target_path)
    # 浏览器对 MP4 里的音频兼容性：aac / mp3 可直接透传；其它需要转码成 aac
    if not has_audio:
        audio_args = ["-an"]
    elif audio_codec in ("aac", "mp3"):
        audio_args = ["-c:a", "copy"]
    else:
        audio_args = [
            "-c:a", "aac", "-b:a", "128k", "-ac", "2",
            "-af", "aresample=async=1:min_hard_comp=0.100000:first_pts=0",
        ]

    cmd = [
        FFMPEG_BIN, "-hide_banner", "-loglevel", "error",
        # 修复部分 AVI 时间戳/索引异常，忽略可恢复的错误
        "-fflags", "+genpts+discardcorrupt", "-err_detect", "ignore_err",
        "-ss", ss, "-i", target_path,
        # 视频：H.264 兼容 8bit，1280 内缩放 + veryfast 控制转码延迟与 CPU 占用
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
        "-pix_fmt", "yuv420p",
        "-vf", "scale='min(iw,1280)':-2,format=yuv420p",
    ] + audio_args + [
        # fMP4 分片输出：边转边播，无需等整体转完
        "-movflags", "+faststart+frag_keyframe+empty_moov+default_base_moof",
        "-f", "mp4", "pipe:1",
    ]

    def generate():
        with _TRANCODE_SEM:                 # 并发上限，超出的排队等待
            proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            stderr_chunks = []

            def _drain_stderr():
                try:
                    while True:
                        chunk = proc.stderr.read(16 * 1024)
                        if not chunk:
                            break
                        stderr_chunks.append(chunk)
                except Exception:
                    pass
                finally:
                    stderr_closed.set()

            stderr_thread = threading.Thread(target=_drain_stderr, daemon=True)
            stderr_thread.start()

            try:
                while True:
                    chunk = proc.stdout.read(64 * 1024)
                    if not chunk:
                        break
                    yield chunk
            finally:
                # 客户端断开 / 切换视频 → 立即杀掉 ffmpeg，不留后台转码进程
                try:
                    if proc.poll() is None:
                        proc.kill()
                except Exception:
                    pass
                try:
                    if proc.stdout:
                        proc.stdout.close()
                except Exception:
                    pass
                stderr_thread.join(timeout=3.0)
                try:
                    if proc.stderr:
                        proc.stderr.close()
                except Exception:
                    pass
                stderr = b"".join(stderr_chunks).decode("utf-8", "ignore").strip()
                if stderr or (proc.returncode is not None and proc.returncode != 0):
                    _log.warning("stream_transcode ffmpeg error for %s (code=%s): %s",
                                 target_path, proc.returncode, stderr or "unknown")

    resp = FlaskResponse(generate(), mimetype="video/mp4")
    resp.headers["Cache-Control"] = "no-store"   # 转码结果不缓存（带 ss 定位，且不可 Range）
    resp.headers["X-Transcoded"] = "1"
    return resp


@bp.route("/api/download")
def api_download():
    """通用附件下载：send_file 自动带 Content-Length，前端据此计算实时进度"""
    _log.info("GET /api/download")
    target_path = _get_file_path_from_request(request)
    if target_path is None:
        return jsonify({"error": "文件不存在"}), 404
    if not os.path.isfile(target_path):
        return jsonify({"error": "仅支持下载文件"}), 400
    try:
        return send_file(target_path, as_attachment=True, conditional=True)
    except (OSError, PermissionError) as e:
        return jsonify({"error": f"无法读取文件: {str(e)}"}), 500


# ======================================================================
# 电子表格查看 / 编辑（xlsx / xlsm / xls / et / csv / tsv）
#   xlsx/xlsm/xltx/xltm：openpyxl 读写（保留其余工作表与格式）
#   xls / et（WPS 表格）：xlrd 只读（BIFF8），不支持写回，需另存为 xlsx
#   csv / tsv：标准库读写
#   数据以二维数组返回；超大表按行列上限截断，避免响应过大
# ======================================================================
_SHEET_WRITE_EXTS = {"xlsx", "xlsm", "xltx", "xltm"}
_SHEET_RO_EXTS = {"xls", "et", "ett"}
_SHEET_CSV_EXTS = {"csv", "tsv"}
_SHEET_ALL_EXTS = _SHEET_WRITE_EXTS | _SHEET_RO_EXTS | _SHEET_CSV_EXTS
_SHEET_MAX_ROWS = 3000
_SHEET_MAX_COLS = 300


def _sheet_ext_of(path):
    return os.path.splitext(path)[1].lower().lstrip(".")


def _sheet_cell_str(v):
    """单元格值 → 前端可显示字符串（整数浮点去掉 .0）。"""
    if v is None:
        return ""
    if isinstance(v, bool):
        return "TRUE" if v else "FALSE"
    if isinstance(v, float):
        return str(int(v)) if v.is_integer() else repr(v)
    return str(v)


def _sheet_coerce(v):
    """字符串转回单元格值：空→None，纯整数/浮点→数字，其余→字符串。"""
    if v is None or isinstance(v, (int, float, bool)):
        return v
    s = str(v).strip()
    if s == "":
        return None
    try:
        return int(s)
    except ValueError:
        pass
    try:
        return float(s)
    except ValueError:
        pass
    return s


def _sheet_read_xlsx(path, sheet_name):
    import openpyxl
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    try:
        names = list(wb.sheetnames)
        ws = wb[sheet_name] if sheet_name in names else wb[names[0]]
        data, truncated = [], False
        for i, row in enumerate(ws.iter_rows(values_only=True)):
            if i >= _SHEET_MAX_ROWS:
                truncated = True
                break
            data.append([_sheet_cell_str(v) for v in row[:_SHEET_MAX_COLS]])
        return names, ws.title, data, truncated
    finally:
        wb.close()


def _sheet_read_xls(path, sheet_name):
    """xls / et（WPS BIFF8）：xlrd 读取，只读。"""
    import xlrd
    with open(path, "rb") as f:
        wb = xlrd.open_workbook(file_contents=f.read())
    names = wb.sheet_names()
    ws = wb.sheet_by_name(sheet_name) if sheet_name in names else wb.sheet_by_index(0)
    rows = min(ws.nrows, _SHEET_MAX_ROWS)
    cols = min(ws.ncols, _SHEET_MAX_COLS)
    data = [[_sheet_cell_str(ws.cell_value(r, c)) for c in range(cols)] for r in range(rows)]
    truncated = ws.nrows > _SHEET_MAX_ROWS or ws.ncols > _SHEET_MAX_COLS
    return names, ws.name, data, truncated


def _sheet_read_csv(path, ext):
    import csv as _csv
    with open(path, "r", encoding="utf-8-sig", errors="replace", newline="") as f:
        reader = _csv.reader(f, delimiter=("\t" if ext == "tsv" else ","))
        data, truncated = [], False
        for i, row in enumerate(reader):
            if i >= _SHEET_MAX_ROWS:
                truncated = True
                break
            data.append([str(v) for v in row[:_SHEET_MAX_COLS]])
    return ["Sheet1"], "Sheet1", data, truncated


@bp.route("/api/sheet/read")
def api_sheet_read():
    """读取表格文件，返回工作表清单 + 当前表二维数据。"""
    rel_path = request.args.get("path", "")
    target_path = os.path.abspath(os.path.normpath(rel_path))
    if not os.path.isfile(target_path):
        return jsonify({"error": "文件不存在"}), 404
    ext = _sheet_ext_of(target_path)
    if ext not in _SHEET_ALL_EXTS:
        return jsonify({"error": "不支持的表格类型: " + ext}), 400
    sheet_name = request.args.get("sheet") or None
    try:
        if ext in _SHEET_WRITE_EXTS:
            names, active, data, trunc = _sheet_read_xlsx(target_path, sheet_name)
        elif ext in _SHEET_RO_EXTS:
            names, active, data, trunc = _sheet_read_xls(target_path, sheet_name)
        else:
            names, active, data, trunc = _sheet_read_csv(target_path, ext)
    except ImportError as e:
        return jsonify({"error": "缺少解析库（%s），请安装 openpyxl / xlrd" % e.name}), 500
    except Exception as e:
        return jsonify({"error": "读取表格失败：" + str(e)}), 500
    writable = ext in _SHEET_WRITE_EXTS or ext in _SHEET_CSV_EXTS
    return jsonify({
        "ok": True,
        "ext": ext,
        "sheets": names,
        "active": active,
        "rows": len(data),
        "cols": max((len(r) for r in data), default=0),
        "data": data,
        "truncated": trunc,
        "writable": writable,
        "is_csv": ext in _SHEET_CSV_EXTS,
        "max_rows": _SHEET_MAX_ROWS,
        "max_cols": _SHEET_MAX_COLS,
    })


@bp.route("/api/sheet/write", methods=["POST"])
def api_sheet_write():
    """保存表格编辑：changes=[[r,c,v]...] 单元格补丁；csv/tsv 可传 data 全量。"""
    body = request.get_json(silent=True) or {}
    target_path = os.path.abspath(os.path.normpath(body.get("path", "")))
    if not os.path.isfile(target_path):
        return jsonify({"error": "文件不存在"}), 404
    ext = _sheet_ext_of(target_path)
    sheet_name = body.get("sheet") or None
    changes = body.get("changes") or []
    data = body.get("data")
    if ext in _SHEET_RO_EXTS:
        return jsonify({"error": "该格式（.%s）为只读，不支持直接保存，请另存为 .xlsx 后再编辑" % ext}), 400
    try:
        if ext in _SHEET_WRITE_EXTS:
            _sheet_write_xlsx(target_path, sheet_name, changes, data)
        elif ext in _SHEET_CSV_EXTS:
            _sheet_write_csv(target_path, ext, data, changes)
        else:
            return jsonify({"error": "不支持的表格类型: " + ext}), 400
    except ImportError as e:
        return jsonify({"error": "缺少解析库（%s），请安装 openpyxl" % e.name}), 500
    except Exception as e:
        return jsonify({"error": "保存表格失败：" + str(e)}), 500
    return jsonify({"ok": True})


def _sheet_write_xlsx(path, sheet_name, changes, data):
    import openpyxl
    wb = openpyxl.load_workbook(path, data_only=False)
    names = wb.sheetnames
    ws = wb[sheet_name] if sheet_name in names else wb[names[0]]
    if data is not None:
        if ws.max_row > 0:
            ws.delete_rows(1, ws.max_row)
        for r, row in enumerate(data, start=1):
            for c, v in enumerate(row, start=1):
                ws.cell(row=r, column=c).value = _sheet_coerce(v)
    for ch in changes:
        try:
            r, c, v = int(ch[0]) + 1, int(ch[1]) + 1, ch[2]
        except (TypeError, ValueError, IndexError):
            continue
        ws.cell(row=r, column=c).value = _sheet_coerce(v)
    wb.save(path)


def _sheet_write_csv(path, ext, data, changes):
    import csv as _csv
    if data is None:
        _, _, data, _ = _sheet_read_csv(path, ext)
        for ch in changes:
            try:
                r, c, v = int(ch[0]), int(ch[1]), ch[2]
            except (TypeError, ValueError, IndexError):
                continue
            while len(data) <= r:
                data.append([])
            while len(data[r]) <= c:
                data[r].append("")
            data[r][c] = "" if v is None else str(v)
    with open(path, "w", encoding="utf-8", newline="") as f:
        w = _csv.writer(f, delimiter=("\t" if ext == "tsv" else ","))
        for row in data:
            w.writerow(["" if v is None else v for v in row])

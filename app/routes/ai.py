"""AI 助手后端：多接口（OpenAI 兼容）配置管理与流式对话代理（支持图片输入）。

GET  /api/ai/config            读取配置（key 脱敏返回）
POST /api/ai/config            保存配置：{providers:[...]} 整体替换 / {active:{provider,model}} 切换
POST /api/ai/chat              流式对话（SSE）：{messages:[{role, content}], provider_id?, model?}

配置保存在 data/.file_manager_ai.json：
    {
      "providers": [ {"id","name","base_url","api_key","models":[...]} , ... ],
      "active":    {"provider": "<id>", "model": "<name>"}
    }
API Key 只存服务端、不下发给前端（GET 只回脱敏形式）；POST 中 api_key 留空表示沿用旧值。
对话走服务端代理；content 支持字符串或 OpenAI 图片数组（[{type:text},{type:image_url}]）。
兼容所有 OpenAI 格式的服务（OpenAI / DeepSeek / Kimi / Qwen / SenseNova / Ollama / vLLM 等）。
"""
import json
import os
import re
import shutil
import socket
import subprocess
import threading
import urllib.error
import urllib.parse
import urllib.request

from flask import Blueprint, request, jsonify, Response

from .. import config
from ..log import get_logger

_log = get_logger()
bp = Blueprint("ai", __name__)

_LOCK = threading.Lock()
_CONNECT_TIMEOUT = 15                 # 建立连接的超时（快速报错）
_READ_TIMEOUT = 300                   # 连上之后等模型吐字的超时（慢模型首字可能要几十秒）


def _preflight(url, timeout=_CONNECT_TIMEOUT):
    """先快速探一次端口：连不上立刻报错，避免把长读超时耗在不可达的地址上。

    走代理时跳过（预检直连会绕过代理，反而误判）。"""
    if os.environ.get("http_proxy") or os.environ.get("https_proxy") or os.environ.get("all_proxy"):
        return
    u = urllib.parse.urlsplit(url)
    host = u.hostname
    if not host:
        return
    port = u.port or (443 if u.scheme == "https" else 80)
    try:
        with socket.create_connection((host, port), timeout=timeout):
            pass
    except OSError as e:
        raise OSError("连接 %s:%s 失败：%s" % (host, port, e))


def _open_stream(req, url, connect_timeout=_CONNECT_TIMEOUT, read_timeout=_READ_TIMEOUT):
    """打开模型接口请求：连接阶段短超时，连上后读超时放宽。

    注意 urlopen 的 timeout 对连接和读取都生效：只给 15 秒会把「首字慢」的
    模型判成「无法连接 AI 接口：The read operation timed out」。"""
    _preflight(url, connect_timeout)
    return urllib.request.urlopen(req, timeout=read_timeout)
_MAX_IMAGE_DATAURL = 9_000_000        # 单张图片 data URL 上限（约 6.7MB 原图）
_MAX_IMAGE_PARTS = 8                  # 单次请求最多图片部件数


def _load_cfg() -> dict:
    """读取配置；旧版单接口格式自动迁移为 providers 列表。"""
    try:
        with open(config.AI_CONFIG_FILE, "r", encoding="utf-8") as f:
            d = json.load(f)
    except (OSError, ValueError):
        d = {}
    if isinstance(d.get("providers"), list) and d["providers"]:
        providers = d["providers"]
        active = d.get("active") or {}
    else:
        # 旧格式迁移
        providers = []
        if d.get("base_url") and d.get("model"):
            providers = [{
                "id": "p1",
                "name": "默认接口",
                "base_url": str(d.get("base_url") or "").strip(),
                "api_key": str(d.get("api_key") or "").strip(),
                "models": [str(d.get("model") or "").strip()],
            }]
        active = {"provider": "p1", "model": providers and providers[0]["models"][0] or ""}
    clean, seen = [], set()
    for p in providers:
        if not isinstance(p, dict):
            continue
        pid = str(p.get("id") or "").strip() or ("p" + str(len(clean) + 1))
        if pid in seen:
            continue
        seen.add(pid)
        models = p.get("models") or []
        if isinstance(models, str):
            models = [m.strip() for m in models.replace("，", ",").split(",") if m.strip()]
        models = [str(m).strip() for m in models if str(m).strip()]
        clean.append({
            "id": pid,
            "name": str(p.get("name") or "").strip() or "接口 " + str(len(clean) + 1),
            "base_url": str(p.get("base_url") or "").strip(),
            "api_key": str(p.get("api_key") or "").strip(),
            "models": models,
        })
    active = _resolve_active(clean, active)
    return {"providers": clean, "active": active}


def _resolve_active(providers, active):
    """校验 active 指向的接口/模型仍然存在，失效则回退。"""
    pid = str(active.get("provider") or "")
    model = str(active.get("model") or "")
    by_id = {p["id"]: p for p in providers}
    if pid in by_id and model and (not by_id[pid]["models"] or model in by_id[pid]["models"]):
        return {"provider": pid, "model": model}
    for p in providers:
        for m in p["models"]:
            if model and m == model:
                return {"provider": p["id"], "model": m}
    if providers and providers[0]["models"]:
        return {"provider": providers[0]["id"], "model": providers[0]["models"][0]}
    return {"provider": providers[0]["id"] if providers else "", "model": ""}


def _save_cfg(cfg: dict) -> None:
    tmp = config.AI_CONFIG_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"providers": cfg["providers"], "active": cfg["active"]},
                  f, ensure_ascii=False, indent=2)
    os.replace(tmp, config.AI_CONFIG_FILE)


def _mask_key(key: str) -> str:
    if not key:
        return ""
    if len(key) <= 8:
        return key[:2] + "****"
    return key[:4] + "****" + key[-4:]


@bp.route("/api/ai/config", methods=["GET"])
def api_ai_config_get():
    cfg = _load_cfg()
    return jsonify({
        "providers": [{k: (v if k != "api_key" else _mask_key(v)) for k, v in p.items()}
                      for p in cfg["providers"]],
        "active": cfg["active"],
        "configured": all([cfg["providers"], cfg["active"].get("model")]),
    })


@bp.route("/api/ai/config", methods=["POST"])
def api_ai_config_set():
    data = request.get_json(silent=True) or {}
    with _LOCK:
        cfg = _load_cfg()
        if "providers" in data:
            old_keys = {p["id"]: p["api_key"] for p in cfg["providers"]}
            incoming = data.get("providers")
            if not isinstance(incoming, list) or not incoming:
                return jsonify({"error": "providers 不能为空"}), 400
            clean, seen, incomplete = [], set(), []
            for p in incoming:
                if not isinstance(p, dict):
                    continue
                pid = str(p.get("id") or "").strip() or ("p" + str(len(clean) + 1))
                if pid in seen:
                    continue
                seen.add(pid)
                models = p.get("models") or []
                if isinstance(models, str):
                    models = [m.strip() for m in models.replace("，", ",").split(",") if m.strip()]
                models = [str(m).strip() for m in models if str(m).strip()]
                name = str(p.get("name") or "").strip() or "接口 " + str(len(clean) + 1)
                base_url = str(p.get("base_url") or "").strip()
                key = str(p.get("api_key") or "").strip()
                if not key:                                   # 留空 → 沿用该 id 旧 key
                    key = old_keys.get(pid, "")
                # 完全空白的卡片（刚点添加还没填）直接跳过；填了一半的才报错
                if not (name.startswith("接口 ") or name) and not (base_url or key or models):
                    continue
                if not base_url and not key and not models:
                    continue
                if not (base_url and key and models):
                    incomplete.append(name)
                    continue
                clean.append({"id": pid, "name": name, "base_url": base_url,
                              "api_key": key, "models": models})
            if incomplete:
                return jsonify({"error": "以下接口信息不完整（地址 / Key / 模型列表都必填）："
                                         + "、".join(incomplete)}), 400
            if not clean:
                return jsonify({"error": "至少需要一个完整可用的接口"}), 400
            cfg["providers"] = clean
        if "active" in data:
            a = data.get("active") or {}
            cfg["active"] = _resolve_active(cfg["providers"],
                                            {"provider": a.get("provider"), "model": a.get("model")})
        _save_cfg(cfg)
    masked = {p["id"]: _mask_key(p["api_key"]) for p in cfg["providers"]}
    return jsonify({"ok": True, "providers": [{**p, "api_key": masked[p["id"]]} for p in cfg["providers"]],
                    "active": cfg["active"]})


def _clean_content(c):
    """清洗消息 content：字符串直接透传；数组只保留 text / data-URL 图片部件。"""
    if isinstance(c, str):
        return c[:60000]
    if isinstance(c, list):
        parts = []
        for p in c[:12]:
            if not isinstance(p, dict):
                continue
            t = p.get("type")
            if t == "text":
                parts.append({"type": "text", "text": str(p.get("text") or "")[:60000]})
            elif t == "image_url":
                url = ""
                iu = p.get("image_url")
                if isinstance(iu, dict):
                    url = str(iu.get("url") or "")
                if url.startswith("data:image/") and len(url) <= _MAX_IMAGE_DATAURL:
                    parts.append({"type": "image_url", "image_url": {"url": url}})
            if sum(1 for x in parts if x.get("type") == "image_url") >= _MAX_IMAGE_PARTS:
                break
        return parts
    return ""


def _sse(payload: dict) -> bytes:
    return ("data: " + json.dumps(payload, ensure_ascii=False) + "\n\n").encode("utf-8")


@bp.route("/api/ai/chat", methods=["POST"])
def api_ai_chat():
    cfg = _load_cfg()
    if not cfg["providers"] or not cfg["active"].get("model"):
        return jsonify({"error": "AI 助手尚未配置：请先在设置里添加接口（地址 / API Key / 模型）"}), 400
    data = request.get_json(silent=True) or {}
    msgs = data.get("messages") or []
    if not isinstance(msgs, list) or not msgs:
        return jsonify({"error": "messages 不能为空"}), 400

    # 指定 provider/model 则临时切换（前端模型下拉直接指定）
    want_pid = str(data.get("provider_id") or "")
    want_model = str(data.get("model") or "")
    provider = next((p for p in cfg["providers"] if p["id"] == want_pid), None)
    if provider is None:
        provider = next((p for p in cfg["providers"] if p["id"] == cfg["active"].get("provider")),
                        cfg["providers"][0])
    model = want_model or cfg["active"].get("model") or (provider["models"][0] if provider["models"] else "")

    clean = [{"role": str(m.get("role") or "user")[:16], "content": _clean_content(m.get("content"))}
             for m in msgs[:40]]
    n_imgs = sum(1 for m in clean for part in (m["content"] if isinstance(m["content"], list) else [])
                 if isinstance(part, dict) and part.get("type") == "image_url")
    _log.info("AI 对话：provider=%s model=%s msgs=%d images=%d", provider["name"], model, len(clean), n_imgs)

    base = provider["base_url"].rstrip("/")
    url = base if base.endswith("/chat/completions") else base + "/chat/completions"
    payload = json.dumps({"model": model, "messages": clean, "stream": True}).encode("utf-8")
    req = urllib.request.Request(
        url, data=payload, method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer " + provider["api_key"],
            "Accept": "text/event-stream",
        })

    def gen():
        try:
            resp = _open_stream(req, url)
        except urllib.error.HTTPError as e:
            try:
                detail = e.read().decode("utf-8", "replace")[:500]
            except OSError:
                detail = ""
            yield _sse({"error": f"接口返回 {e.code}：{detail or e.reason}"})
            yield b"data: [DONE]\n\n"
            return
        except (socket.timeout, TimeoutError):
            yield _sse({"error": "连接 AI 接口超时（%d 秒）：请检查接口地址与网络" % _CONNECT_TIMEOUT})
            yield b"data: [DONE]\n\n"
            return
        except (urllib.error.URLError, OSError) as e:
            yield _sse({"error": f"无法连接 AI 接口：{e}"})
            yield b"data: [DONE]\n\n"
            return
        try:
            # SSE 按行迭代：上游每 flush 一行就能立刻转发，保证打字机效果
            for raw in resp:
                line = raw.strip()
                if not line.startswith(b"data:"):
                    continue
                body = line[5:].strip()
                if body == b"[DONE]":
                    yield b"data: [DONE]\n\n"
                    return
                try:
                    obj = json.loads(body.decode("utf-8"))
                except ValueError:
                    continue
                if obj.get("error"):
                    yield _sse({"error": str(obj["error"])})
                    continue
                choices = obj.get("choices") or []
                if not choices:
                    continue
                delta = (choices[0] or {}).get("delta") or {}
                piece = delta.get("content")
                reasoning = delta.get("reasoning_content")
                if piece or reasoning:
                    yield _sse({"delta": piece or "", "reasoning": reasoning or ""})
            yield b"data: [DONE]\n\n"
        except (socket.timeout, TimeoutError):
            yield _sse({"error": "模型 %d 秒没有返回新内容（响应超时），可重试或换个更快的模型"
                                % _READ_TIMEOUT})
            yield b"data: [DONE]\n\n"
        except (OSError, urllib.error.URLError) as e:
            yield _sse({"error": f"读取流中断：{e}"})
            yield b"data: [DONE]\n\n"
        finally:
            try:
                resp.close()
            except OSError:
                pass

    return Response(gen(), mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


_SUMMARY_TIMEOUT = 60
_SUMMARY_SYS = ("你是记忆压缩器。请把对话历史压缩成一份简洁的「记忆摘要」，保留：用户的目标与需求、已得出的结论、"
                "涉及的文件名与关键代码要点、尚未完成的事项。不要寒暄，直接输出摘要正文，不超过 300 字。")


@bp.route("/api/ai/summarize", methods=["POST"])
def api_ai_summarize():
    """dsh 式记忆压缩：把旧对话历史（可带旧摘要增量合并）压缩成简短记忆（非流式）。"""
    cfg = _load_cfg()
    if not cfg["providers"] or not cfg["active"].get("model"):
        return jsonify({"error": "AI 助手尚未配置"}), 400
    data = request.get_json(silent=True) or {}
    msgs = data.get("messages") or []
    prev = str(data.get("prev") or "")[:2000]
    if not isinstance(msgs, list) or not msgs:
        return jsonify({"error": "messages 不能为空"}), 400

    want_pid = str(data.get("provider_id") or "")
    want_model = str(data.get("model") or "")
    provider = next((p for p in cfg["providers"] if p["id"] == want_pid), None)
    if provider is None:
        provider = next((p for p in cfg["providers"] if p["id"] == cfg["active"].get("provider")),
                        cfg["providers"][0])
    model = want_model or cfg["active"].get("model") or (provider["models"][0] if provider["models"] else "")

    convo = []
    for m in msgs[:80]:
        role = "用户" if str(m.get("role")) == "user" else "AI"
        convo.append(role + ": " + str(m.get("text") or m.get("content") or "")[:3000])
    content = ("[已有记忆摘要]\n" + prev + "\n\n[新增对话]\n" if prev else "") + "\n".join(convo)
    content = content[:24000]

    base = provider["base_url"].rstrip("/")
    url = base if base.endswith("/chat/completions") else base + "/chat/completions"
    payload = json.dumps({"model": model, "stream": False, "messages": [
        {"role": "system", "content": _SUMMARY_SYS}, {"role": "user", "content": content}]}).encode("utf-8")
    req = urllib.request.Request(url, data=payload, method="POST", headers={
        "Content-Type": "application/json", "Authorization": "Bearer " + provider["api_key"]})
    try:
        resp = urllib.request.urlopen(req, timeout=_SUMMARY_TIMEOUT)
        obj = json.loads(resp.read().decode("utf-8"))
        choices = obj.get("choices") or [{}]
        text = ((choices[0] or {}).get("message") or {}).get("content") or ""
        _log.info("AI 记忆压缩：model=%s msgs=%d 摘要=%d字", model, len(msgs), len(text))
        return jsonify({"summary": text.strip()[:2000]})
    except urllib.error.HTTPError as e:
        return jsonify({"error": f"接口返回 {e.code}"}), 502
    except (urllib.error.URLError, OSError, ValueError) as e:
        return jsonify({"error": f"压缩失败：{e}"}), 502


# ---------------------------------------------------------------- Git 提交信息生成
_COMMIT_TIMEOUT = 60                  # 生成提交信息的接口超时（秒）
_COMMIT_MAX_NOTES = 3000              # 发给模型的「改动摘要」字符上限（不含任何代码）
_COMMIT_MAX_LINE = 20                 # 生成的说明（不含图标）不超过 20 个中文字符
# 注意：这里刻意不传 max_tokens —— 思考型模型会把额度全花在推理上，
# 导致 content 为空（表现为「模型没有返回内容」）。正文长度靠提示词 + 下面硬截断保证。
_COMMIT_SYS = (
    "你是 Git 提交信息生成器。用户只给你「变更文件清单」和「改动处的中文注释」，"
    "不会给你代码，请据此概括这次改动：\n"
    "1. 只输出一行，格式为「图标 空格 说明」，说明部分不超过 20 个汉字；\n"
    "2. 图标只用一个，按改动性质选：新增功能 ✨、修复缺陷 🐛、性能/提速 ⚡、重构 ♻️、"
    "文档 📝、测试 🧪、配置或依赖 🔧、界面样式 💄\n"
    "3. 说明用「动词 + 对象」，例如「✨ 新增提交信息生成接口」「⚡ 智能体并行提速」；\n"
    "4. 不要标点结尾、不要引号、不要换行、不要代码块、不要额外解释；\n"
    "5. 信息不足时按文件名和注释合理推断，不要编造无关内容。")

_CJK_RE = re.compile(r"[\u4e00-\u9fff]")
_COMMENT_PATTERNS = (
    re.compile(r"<!--(.*?)-->"),          # HTML / Vue
    re.compile(r"/\*(.*?)\*/"),           # C 风格块注释
    re.compile(r"//\s?(.*)$"),            # // 行注释
    re.compile(r"#\s?(.*)$"),             # Python / Shell / YAML / TOML
    re.compile(r"^\s*\*+\s?(.*)$"),       # 块注释续行
)
_TRIM_CHARS = "。.!！?？；;，,、\"'“”"
_MSG_TRIM = "。.!！?？；;，,、\"'“”「」『』"          # 最终提交说明额外去掉书名号/引号
_DECOR_RE = re.compile(r"^(?:[=\-*_#~+·•\s]+)|(?:[=\-*_#~+·•\s]+)$")


def _tidy_note(seg):
    """去掉分隔线装饰、首尾标点；剩余不足 2 字或没有中文则丢弃。"""
    seg = _DECOR_RE.sub("", re.sub(r"\s+", " ", seg or "").strip())
    seg = seg.strip(_TRIM_CHARS + " ")
    if len(seg) < 2 or not _CJK_RE.search(seg):
        return ""
    return seg[:60]


def _line_notes(text):
    """从一行源码里取出中文说明（注释优先，其次中文提示语）。取不到返回空串。"""
    t = (text or "").strip()
    if not t or not _CJK_RE.search(t):
        return ""
    for rx in _COMMENT_PATTERNS:
        m = rx.search(t)
        if m and _CJK_RE.search(m.group(1) or ""):
            seg = _tidy_note(m.group(1))
            if seg:
                return seg
    first = _CJK_RE.search(t).start()                    # 无注释：取这一行里的中文片段
    last = max(m.end() for m in _CJK_RE.finditer(t))
    return _tidy_note(t[first:last])


def _notes_from_diff(diff):
    """从 diff 里只提取「改动处的中文注释」，按文件分组（不保留任何代码）。"""
    added, removed = {}, {}
    cur = ""
    for raw in (diff or "").split("\n"):
        if raw.startswith("+++ "):
            p = raw[4:].strip()
            cur = p[2:] if p.startswith("b/") else p
            continue
        if raw[:1] not in ("+", "-") or raw.startswith(("+++", "---")):
            continue
        note = _line_notes(raw[1:])
        if not note or not cur:
            continue
        if raw[0] == "+":
            lst = added.setdefault(cur, [])
            if note not in lst and len(lst) < 8:
                lst.append(note)
        else:
            lst = removed.setdefault(cur, [])
            if note not in lst and len(lst) < 8:
                lst.append(note)
    out = {}
    for f in list(added) + [f for f in removed if f not in added]:
        out[f] = added.get(f) or removed.get(f) or []     # 优先新增行的注释
    return {f: v for f, v in out.items() if v}


def _git_run(cwd, args, timeout=20):
    """执行 git 命令，返回 (stdout, error)。"""
    exe = shutil.which("git")
    if not exe:
        return "", "未找到 git 命令，请先安装 Git"
    try:
        p = subprocess.run([exe, "-c", "safe.directory=*"] + args, cwd=cwd, capture_output=True,
                           text=True, errors="replace", timeout=timeout, stdin=subprocess.DEVNULL)
    except subprocess.TimeoutExpired:
        return "", "git 命令执行超时"
    except OSError as e:
        return "", "git 执行失败：%s" % e
    if p.returncode != 0:
        return "", (p.stderr or "").strip() or ("退出码 %d" % p.returncode)
    return p.stdout or "", ""


def _git_root(path):
    """返回仓库根目录（cwd 用），失败时返回错误文本。"""
    out, err = _git_run(path, ["rev-parse", "--show-toplevel"])
    if err:
        low = err.lower()
        if "not a git repository" in low or "不是 git 仓库" in err:
            return None, "该目录不是 Git 仓库（可先在「源代码管理」面板初始化仓库）"
        return None, err
    root = (out or "").strip()
    return (root, None) if root else (None, "该目录不是 Git 仓库")


def _collect_changes(root):
    """收集「改动摘要」：变更文件清单 + 改动处的中文注释。

    刻意**不上传代码/diff 全文**：请求体只有几百字，接口首字延迟和成本都低很多；
    注释里已经写清「改了什么」，足以生成一句 20 字以内的提交说明。"""
    staged_diff, err = _git_run(root, ["diff", "--cached", "--no-color", "-U0"])
    if err:
        return None, "读取暂存区差异失败：" + err
    work_diff, _ = _git_run(root, ["diff", "--no-color", "-U0"])
    status, _ = _git_run(root, ["status", "--porcelain=v1", "--untracked-files=all"])
    branch, _ = _git_run(root, ["rev-parse", "--abbrev-ref", "HEAD"])
    untracked, _ = _git_run(root, ["ls-files", "--others", "--exclude-standard"])
    staged_diff, work_diff = staged_diff.strip(), work_diff.strip()
    lines = [ln for ln in (status or "").split("\n") if ln.strip()]
    new_files = [x.strip() for x in (untracked or "").split("\n") if x.strip()]
    notes = _notes_from_diff(staged_diff or work_diff)
    parts = ["【变更文件】"] + ["  " + ln[:160] for ln in lines[:60]]
    if new_files:
        parts += ["【新增未跟踪文件】"] + ["  " + x for x in new_files[:40]]
    if notes:
        parts += ["", "【改动处的中文注释（按文件）】"]
        for f, lst in list(notes.items())[:30]:
            parts.append(f + ":")
            parts += ["  - " + n for n in lst]
    else:
        parts += ["", "（改动处没有中文注释，请仅根据文件名与状态推断）"]
    body = "\n".join(parts).strip()
    if len(body) > _COMMIT_MAX_NOTES:
        body = body[:_COMMIT_MAX_NOTES] + "\n…（已截断）"
    return {"body": body, "branch": (branch or "").strip(), "staged": bool(staged_diff),
            "files": len(lines)}, None


_ICON_ONLY = "[\u2190-\u2BFF\u2600-\u27BF\uFE0F\u200D\U0001F000-\U0001FAFF]"


def _pick_content(choice):
    """兼容各家返回形态：content 字符串 / content 数组（[{type,text}]）/ completion 的 text。"""
    msg = (choice or {}).get("message") or {}
    c = msg.get("content")
    if isinstance(c, list):
        c = "".join(str(p.get("text") or "") for p in c if isinstance(p, dict))
    if not c:
        c = (choice or {}).get("text") or ""
    return c or ""


def _commit_call(url, api_key, model, messages, stream):
    """调用模型生成提交说明；返回 (文本, choice, 错误)。流式与非流式两种返回都能解析。"""
    payload = json.dumps({"model": model, "stream": bool(stream), "temperature": 0.2,
                          "messages": messages}).encode("utf-8")
    req = urllib.request.Request(url, data=payload, method="POST", headers={
        "Content-Type": "application/json", "Authorization": "Bearer " + api_key})
    try:
        resp = urllib.request.urlopen(req, timeout=_COMMIT_TIMEOUT)
    except urllib.error.HTTPError as e:
        try:
            detail = e.read().decode("utf-8", "replace")[:200]
        except OSError:
            detail = ""
        return "", None, "接口返回 %s：%s" % (e.code, detail or e.reason)
    except (urllib.error.URLError, OSError) as e:
        return "", None, "无法连接 AI 接口：%s" % e
    try:
        if not stream:
            obj = json.loads(resp.read().decode("utf-8"))
            choice = (obj.get("choices") or [{}])[0] or {}
            return _pick_content(choice), choice, ""
        text = ""
        for raw in resp:                                  # 流式：把增量拼起来
            line = raw.strip()
            if not line.startswith(b"data:"):
                continue
            body = line[5:].strip()
            if body == b"[DONE]":
                break
            try:
                obj = json.loads(body.decode("utf-8"))
            except ValueError:
                continue
            ch = (obj.get("choices") or [{}])[0] or {}
            piece = (ch.get("delta") or {}).get("content") or ""
            if piece:
                text += piece
        return text, None, ""
    except (OSError, urllib.error.URLError, ValueError) as e:
        return "", None, "读取返回失败：%s" % e
    finally:
        try:
            resp.close()
        except OSError:
            pass


def _clean_message(text, limit=_COMMIT_MAX_LINE):
    """取第一行、去掉围栏/引号/结尾标点；保留开头的图标，说明部分硬性限制在 20 个字以内。"""
    t = (text or "").strip()
    t = re.sub(r"^```[a-zA-Z0-9_-]*\s*\n?", "", t)
    t = re.sub(r"\n?```\s*$", "", t).strip()
    t = re.split(r"[\r\n]+", t)[0].strip()               # 说明只保留一行
    if len(t) >= 2 and t[0] == t[-1] and t[0] in _MSG_TRIM:
        t = t[1:-1].strip()
    t = t.lstrip("#-*·• \t").strip()
    m = re.match("^(" + _ICON_ONLY + r"+[\s:：\-]*)(.*)$", t)     # 开头的图标单独取出
    icon, rest = (m.group(1).strip(), m.group(2).strip()) if m else ("", t)
    rest = rest.strip(_MSG_TRIM + " ")
    if len(rest) > limit:
        head = rest[:limit]
        cut = max(head.rfind(p) for p in "，,、；; ")
        if cut >= limit // 2:                            # 尽量不在词中间截断
            head = head[:cut]
        rest = head.strip(_MSG_TRIM + " ")
    if not rest:
        return ""
    return (icon + " " + rest).strip() if icon else rest


@bp.route("/api/ai/commit-message", methods=["POST"])
def api_ai_commit_message():
    """根据当前改动生成 Git 提交信息（非流式）。{repo} → {message, model, files}"""
    cfg = _load_cfg()
    if not cfg["providers"] or not cfg["active"].get("model"):
        return jsonify({"error": "尚未配置 AI 接口：请到「设置 → AI 助手」添加接口",
                        "need_config": True}), 400
    data = request.get_json(silent=True) or {}
    repo = str(data.get("repo") or "").strip()
    if not repo or not os.path.isdir(repo):
        return jsonify({"error": "项目目录不存在，请先打开一个项目"}), 400
    root, err = _git_root(repo)
    if err:
        return jsonify({"error": err}), 400

    info, err = _collect_changes(root)
    if err:
        return jsonify({"error": err}), 500
    if not info["body"]:
        return jsonify({"error": "没有检测到任何改动（暂存区与工作区都是空的）"}), 400

    want_pid = str(data.get("provider_id") or "")
    want_model = str(data.get("model") or "")
    provider = next((p for p in cfg["providers"] if p["id"] == want_pid), None)
    if provider is None:
        provider = next((p for p in cfg["providers"] if p["id"] == cfg["active"].get("provider")),
                        cfg["providers"][0])
    model = want_model or cfg["active"].get("model") or (provider["models"][0] if provider["models"] else "")

    head = "[当前分支] " + (info["branch"] or "-") + "\n[变更文件数] %d\n\n" % info["files"]
    base = provider["base_url"].rstrip("/")
    url = base if base.endswith("/chat/completions") else base + "/chat/completions"
    messages = [{"role": "system", "content": _COMMIT_SYS},
                {"role": "user", "content": (head + info["body"])[:_COMMIT_MAX_NOTES]}]
    text, choice, err = _commit_call(url, provider["api_key"], model, messages, False)
    if err:
        return jsonify({"error": err}), 502
    msg = _clean_message(text)
    if not msg:                                    # 部分接口/模型非流式下返回空：改用流式再试一次
        _log.info("AI 提交信息：非流式返回为空，改用流式重试")
        text, _choice2, err2 = _commit_call(url, provider["api_key"], model, messages, True)
        msg = _clean_message(text)
        if not msg and err2:
            return jsonify({"error": err2}), 502
    if not msg:
        reason = str((choice or {}).get("finish_reason") or "")
        thinking = bool(((choice or {}).get("message") or {}).get("reasoning_content"))
        hint = ("：模型只输出了思考过程，请换个模型（或关闭深度思考）后重试" if thinking else
                ("（finish_reason=%s）" % reason if reason else "，请重试或换个模型"))
        return jsonify({"error": "模型没有返回可用内容" + hint}), 502
    _log.info("AI 提交信息：model=%s files=%d 结果=%s", model, info["files"], msg)
    return jsonify({"message": msg, "model": model, "files": info["files"],
                    "staged": info["staged"], "branch": info["branch"]})


@bp.route("/api/ai/models", methods=["POST"])
def api_ai_models():
    """从 OpenAI 兼容接口拉取可用模型列表（GET /models），供设置页勾选。"""
    cfg = _load_cfg()
    data = request.get_json(silent=True) or {}
    base = str(data.get("base_url") or "").strip().rstrip("/")
    key = str(data.get("api_key") or "")
    pid = str(data.get("provider_id") or "")
    if not base:
        return jsonify({"error": "请先填写接口地址"}), 400
    if not key:                                   # key 留空 → 沿用已保存的
        provider = next((p for p in cfg["providers"] if p["id"] == pid), None)
        key = (provider or {}).get("api_key", "")
    url = base + "/models"
    headers = {"Content-Type": "application/json"}
    if key:
        headers["Authorization"] = "Bearer " + key
    req = urllib.request.Request(url, headers=headers)
    try:
        resp = urllib.request.urlopen(req, timeout=30)
        obj = json.loads(resp.read().decode("utf-8"))
        items = obj.get("data") if isinstance(obj, dict) else obj if isinstance(obj, list) else None
        ids = []
        for it in items or []:
            mid = (it.get("id") or it.get("name") or "") if isinstance(it, dict) else str(it)
            if mid and mid not in ids:
                ids.append(mid)
        _log.info("AI 模型列表：base=%s 获取到 %d 个模型", base, len(ids))
        return jsonify({"models": ids[:200]})
    except urllib.error.HTTPError as e:
        return jsonify({"error": f"接口返回 {e.code}（可能不支持 /models，请手动填写）"}), 502
    except (urllib.error.URLError, OSError, ValueError) as e:
        return jsonify({"error": f"获取失败：{e}"}), 502

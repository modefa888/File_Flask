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
import threading
import urllib.error
import urllib.request

from flask import Blueprint, request, jsonify, Response

from .. import config
from ..log import get_logger

_log = get_logger()
bp = Blueprint("ai", __name__)

_LOCK = threading.Lock()
_CONNECT_TIMEOUT = 15
_READ_TIMEOUT = 300
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
            resp = urllib.request.urlopen(req, timeout=_CONNECT_TIMEOUT)
        except urllib.error.HTTPError as e:
            try:
                detail = e.read().decode("utf-8", "replace")[:500]
            except OSError:
                detail = ""
            yield _sse({"error": f"接口返回 {e.code}：{detail or e.reason}"})
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

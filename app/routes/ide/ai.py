"""AI 助手后端：多接口（OpenAI 兼容）配置管理与流式对话代理（支持图片输入）。

GET  /api/ai/config            读取配置（key 脱敏返回）
POST /api/ai/config            保存配置：{providers:[...]} 整体替换 / {active:{provider,model}} 切换
POST /api/ai/chat              流式对话（SSE）：{messages:[{role, content}], provider_id?, model?}

配置保存在 data/storage/.file_manager_ai.json：
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
import time
import urllib.error
import urllib.parse
import urllib.request

from flask import Blueprint, request, jsonify, Response

from ... import config
from ...services.common.store_db import (
    store_conn, store_tx, flatten_cfg, read_json, get_meta, set_meta,
    kv_get, kv_delete, finalize_kv_migration,
)
from ...log import get_logger
from ...services.ide.web_search import search_web, format_results
from ...services.common import undo
from ...services.common import notifications as notify_svc

_log = get_logger()
bp = Blueprint("ai", __name__)

_LOCK = threading.Lock()
_CONNECT_TIMEOUT = 15                 # 建立连接的超时（快速报错）
_READ_TIMEOUT = 300                   # 连上之后等模型吐字的超时（慢模型首字可能要几十秒）
_CHAT_MAX_ROUNDS = 6                  # 普通对话里工具调用的最大轮数（防止死循环）
_CHAT_TOOL_CHARS = 20000              # 单个工具结果回填给模型的字符上限

# 限流 / 临时故障自动重试
_RETRY_MAX = 5                        # 最多重试次数
_RETRY_BASE = 3.0                     # 首次等待秒数，之后指数退避
_RETRY_CAP = 60.0                     # 单次等待上限（秒）
_RETRY_STATUS = {408, 409, 425, 429, 500, 502, 503, 504, 520, 522, 524}
_RETRY_HINTS = ("429", "rate limit", "rate_limit", "too many requests", "requests per",
                "tpm", "rpm", "quota", "overload", "overloaded", "busy", "temporarily")


def _is_retryable_status(code):
    try:
        return int(code) in _RETRY_STATUS
    except (TypeError, ValueError):
        return False


def _is_retryable_text(s):
    t = str(s or "").lower()
    return any(h in t for h in _RETRY_HINTS)


def _retry_wait(attempt, err=None):
    """按指数退避计算等待秒数；若响应带 Retry-After 优先使用。"""
    if isinstance(err, urllib.error.HTTPError):
        try:
            ra = err.headers.get("Retry-After") if err.headers else None
            if ra:
                v = float(ra)
                if v > 0:
                    return min(v, _RETRY_CAP)
        except (TypeError, ValueError, AttributeError):
            pass
    return min(_RETRY_BASE * (2 ** max(0, attempt)), _RETRY_CAP)


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
    """读取 AI 接口配置（接口一行一个、模型一行一个、激活项一行）并做规范化。"""
    providers, active = [], {}
    try:
        conn = store_conn()
        try:
            models_by_pid = {}
            for r in conn.execute("SELECT provider_id, name FROM ai_models ORDER BY seq ASC"):
                models_by_pid.setdefault(r["provider_id"], []).append(r["name"])
            for r in conn.execute(
                    "SELECT id, name, base_url, api_key FROM ai_providers ORDER BY seq ASC"):
                providers.append({
                    "id": r["id"], "name": r["name"], "base_url": r["base_url"],
                    "api_key": r["api_key"], "models": models_by_pid.get(r["id"], []),
                })
            row = conn.execute("SELECT provider, model FROM ai_active WHERE id=1").fetchone()
            if row:
                active = {"provider": row["provider"], "model": row["model"]}
        finally:
            conn.close()
    except Exception:
        providers, active = [], {}

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
    """整表覆盖写入 providers / active（接口一行一个、模型一行一个）。"""
    providers = cfg.get("providers") or []
    active = cfg.get("active") or {}
    with store_tx() as conn:
        conn.execute("DELETE FROM ai_providers")
        conn.execute("DELETE FROM ai_models")
        mseq = 0        # ai_models.seq 全局唯一（读取时按 provider_id 分组，组内顺序仍正确）
        for i, p in enumerate(providers):
            if not isinstance(p, dict):
                continue
            pid = str(p.get("id") or "")
            conn.execute(
                "INSERT INTO ai_providers (seq, id, name, base_url, api_key) VALUES (?,?,?,?,?)",
                (i, pid, str(p.get("name") or ""), str(p.get("base_url") or ""),
                 str(p.get("api_key") or "")))
            for m in (p.get("models") or []):
                m = str(m).strip()
                if m:
                    conn.execute(
                        "INSERT INTO ai_models (seq, provider_id, name) VALUES (?,?,?)",
                        (mseq, pid, m))
                    mseq += 1
        conn.execute("DELETE FROM ai_active")
        conn.execute("INSERT INTO ai_active (id, provider, model) VALUES (1, ?, ?)",
                     (str(active.get("provider") or ""), str(active.get("model") or "")))


def _write_notify_rows(cfg) -> None:
    """通知配置一行一个配置项（key 为点号路径）。"""
    rows = flatten_cfg(cfg or {})
    with store_tx() as conn:
        conn.execute("DELETE FROM notify_cfg")
        for k, v in rows.items():
            conn.execute("INSERT INTO notify_cfg (key, value) VALUES (?,?)", (k, v))


def _import_ai_cfg(data) -> None:
    """把旧配置对象拆进各表；兼容更早的「单接口」格式。"""
    providers = data.get("providers")
    if not isinstance(providers, list) or not providers:
        providers = []
        if data.get("base_url") and data.get("model"):
            providers = [{
                "id": "p1", "name": "默认接口",
                "base_url": str(data.get("base_url") or "").strip(),
                "api_key": str(data.get("api_key") or "").strip(),
                "models": [str(data.get("model") or "").strip()],
            }]
    active = data.get("active") if isinstance(data.get("active"), dict) else {}
    _save_cfg({"providers": providers, "active": active})
    notify = data.get("notify")
    if isinstance(notify, dict) and notify:
        _write_notify_rows(notify)


def _migrate_ai_cfg() -> None:
    """旧 AI 配置（JSON 文件或上一版 kv 键）一次性拆进
    ai_providers / ai_models / ai_active / notify_cfg。"""
    marker = "table_migrated:ai_cfg"
    if get_meta(marker):
        return
    data = read_json(config.AI_CONFIG_FILE)
    if not isinstance(data, dict):
        data = kv_get("ai_cfg", None)
    if isinstance(data, dict) and data:
        try:
            _import_ai_cfg(data)
        except Exception as e:
            _log.warning("迁移 AI 配置失败：%s", e)
            return
    kv_delete("ai_cfg")
    set_meta(marker, "1")
    finalize_kv_migration()


_migrate_ai_cfg()


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


@bp.route("/api/ai/web_search", methods=["GET", "POST"])
def api_ai_web_search():
    """独立联网搜索接口（供前端查询/测试，也可被智能体内部调用）。"""
    if request.method == "POST":
        data = request.get_json(silent=True) or {}
    else:
        data = request.args.to_dict()
    query = str(data.get("query") or "").strip()
    if not query:
        return jsonify({"error": "缺少 query"}), 400
    try:
        max_results = max(1, min(int(data.get("max_results") or 5), 10))
    except (TypeError, ValueError):
        max_results = 5
    try:
        results = search_web(query, max_results=max_results)
    except Exception as e:  # noqa: BLE001
        return jsonify({"error": "搜索失败：%s" % e}), 500
    return jsonify({"query": query, "results": results})


def _now_zh():
    """返回中文格式的当前系统时间，注入系统提示让模型知道实时时间。"""
    try:
        wday = {"Monday": "周一", "Tuesday": "周二", "Wednesday": "周三",
                "Thursday": "周四", "Friday": "周五", "Saturday": "周六", "Sunday": "周日"}.get(
            time.strftime("%A"), "")
        return time.strftime("当前系统时间：%%Y-%%m-%%d %%H:%%M:%%S（%s）" % wday, time.localtime())
    except Exception:  # noqa: BLE001
        return ""


def _extract_text(content):
    """从消息 content（字符串或多模态数组）中提取纯文本提问。"""
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        return " ".join(str(p.get("text") or "")
                        for p in content if isinstance(p, dict) and p.get("type") == "text").strip()
    return ""


def _inject_system_time(clean):
    """在消息列表开头注入当前系统时间。"""
    now = _now_zh()
    if not now:
        return
    if clean and clean[0].get("role") == "system":
        clean[0]["content"] = str(clean[0].get("content") or "") + "\n\n" + now
    else:
        clean.insert(0, {"role": "system", "content": now})


def _inject_web_search(clean):
    """针对最后一条用户消息做联网搜索，并把结果注入为 system 消息。"""
    if not clean:
        return
    last = clean[-1]
    if last.get("role") != "user":
        return
    query = _extract_text(last.get("content"))
    if not query:
        return
    _log.info("AI 联网搜索：query=%s", query[:120])
    try:
        results = search_web(query, max_results=5)
        text = format_results(results, max_chars=2500)
    except Exception as e:  # noqa: BLE001
        text = "（联网搜索异常：%s）" % e
    clean.insert(len(clean) - 1, {"role": "system", "content": "[联网搜索结果]\n" + text})


# 内置 Skill 提示词：前端选择对应 id 后，会在 system 消息里追加这段说明。
_SKILL_PROMPTS = {
    "lsp-code-analysis": (
        "[当前激活技能：代码语义分析]\n"
        "当用户询问代码结构、符号定义、调用关系、类型信息时，优先引导使用 LSP/IDE 的「转到定义」「查找引用」「实现」等功能定位，"
        "避免凭空猜测文件内容。需要时建议具体的文件路径和行号范围。"
    ),
    "multi-modal": (
        "[当前激活技能：多模态内容生成]\n"
        "当用户请求生成/创建/处理图片、视频、3D 模型，或给图片/视频加特效时，给出可调用多模态生成接口（如 image_gen）的实施方案，"
        "包括 prompt 写法、尺寸/风格/数量参数与保存路径。"
    ),
    "skill-creator": (
        "[当前激活技能：Skill 创建]\n"
        "当用户想扩展助手能力、创建新 Skill 时，引导其明确触发条件、能力描述、所需工具/脚本与输入输出格式，"
        "并生成对应的 skill 定义文件（如 TOML/JSON）与示例实现。"
    ),
    "pptx": (
        "[当前激活技能：PPT 处理]\n"
        "当用户需要创建、编辑、合并、拆分、提取 PowerPoint 时，优先使用 python-pptx 库，给出完整可运行代码，并说明每页版式与占位符。"
    ),
    "pdf": (
        "[当前激活技能：PDF 处理]\n"
        "当用户需要读取、合并、拆分、旋转、加水印、OCR、填表 PDF 时，优先使用 PyPDF2/pikepdf/pdfplumber 等库，给出完整可运行代码。"
    ),
    "docx": (
        "[当前激活技能：Word 处理]\n"
        "当用户需要创建、编辑、提取 Word 文档时，优先使用 python-docx 库，给出完整可运行代码，包括段落、表格、样式与页眉页脚。"
    ),
    "xlsx": (
        "[当前激活技能：表格处理]\n"
        "当用户需要创建、编辑、公式、图表、清洗 Excel/CSV 数据时，优先使用 openpyxl/pandas 库，给出完整可运行代码与数据示例。"
    ),
}


def _inject_skill(clean, skill):
    """如果请求中指定了 skill（字符串或列表），在第一条 system 消息里追加对应提示词。"""
    if not skill:
        return
    sids = skill if isinstance(skill, list) else [skill]
    prompts = []
    for sid in sids:
        if not sid:
            continue
        prompt = _SKILL_PROMPTS.get(str(sid))
        if prompt:
            prompts.append(prompt)
    if not prompts:
        return
    if clean and clean[0].get("role") == "system":
        clean[0]["content"] = str(clean[0].get("content") or "") + "\n\n" + "\n\n".join(prompts)
    else:
        clean.insert(0, {"role": "system", "content": "\n\n".join(prompts)})


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


def _last_user_text(msgs) -> str:
    """从 messages 里反向找最后一条 user 消息的文本，用于通知模板 {query}。"""
    for m in reversed(msgs or []):
        if isinstance(m, dict) and m.get("role") == "user":
            c = m.get("content")
            if isinstance(c, str):
                return c
            if isinstance(c, list):
                parts = []
                for p in c:
                    if isinstance(p, dict) and p.get("type") == "text":
                        parts.append(str(p.get("text") or ""))
                return " ".join(parts)
    return ""


def _fire_notify_async(task: str, user_query: str, answer_text: str) -> None:
    """在独立线程里调用通知服务，避免任何异常/耗时影响 SSE 流。
    task: "chat" / "agent" 决定通知场景；服务内部会按渠道配置分发。
    """
    def _job():
        try:
            # 使用场景化默认标题；实际标题/正文会以配置文件中的模板渲染
            title = "AI 助手 · 回复完成" if task == "chat" else "AI 智能体 · 任务完成"
            # query 放在 body 前部（截断时优先保留用户任务，模型回复在后）
            q = (user_query or "").strip()
            a = (answer_text or "").strip()
            body = ("%s\n\n%s" % (q, a)).strip()
            notify_svc.notify(title=title, body=body, channel=task or "chat")
        except Exception:
            _log.exception("[notify] %s 触发通知失败", task)

    threading.Thread(target=_job, daemon=True, name="ai-notify").start()


@bp.route("/api/ai/notify", methods=["GET"])
def api_ai_notify_get():
    """读取通知配置；返回 cfg + recent(最近30条) + latest。

    支持 ?cursor=N 增量轮询（浏览器通知轮询用）：cursor 大于 0 时返回 has_new
    标记是否有更新的通知，latest 为最新一条。
    """
    after = request.args.get("cursor", 0, type=int)
    cfg = notify_svc.sanitize_notify_cfg()
    d = notify_svc.read_latest(after_cursor=after)
    return jsonify({
        "cfg": cfg,
        # 磁盘上最多留 200 条，界面只展示最近 30 条（与卡片上的说明一致）
        "recent": (d.get("history") or [])[:30],
        "latest": d.get("latest"),
        "cursor": int(d.get("cursor") or 0),
        "has_new": bool(d.get("has_new")),
    })


@bp.route("/api/ai/notify", methods=["POST"])
def api_ai_notify_set():
    """保存通知配置（部分字段可缺，其余保留）。"""
    try:
        data = (request.get_json(silent=True) or {})
        cfg = notify_svc.save_notify_cfg(data)
        return jsonify({"ok": True, "cfg": cfg})
    except Exception as e:
        _log.exception("保存通知配置失败")
        return jsonify({"error": str(e)}), 400


@bp.route("/api/ai/notify/test", methods=["POST"])
def api_ai_notify_test():
    """按通道发一条测试通知。channel: desktop / email / all"""
    body = request.get_json(silent=True) or {}
    channel = str(body.get("channel") or "all").strip().lower()
    try:
        res = notify_svc.send_test(channel)
        return jsonify(res)
    except Exception as e:
        _log.exception("发送测试通知失败")
        return jsonify({"ok": False, "error": str(e)}), 400


@bp.route("/api/ai/notify/history", methods=["DELETE"])
def api_ai_notify_history_clear():
    """清空通知历史。"""
    try:
        n = notify_svc.clear_recent()
        return jsonify({"ok": True, "cleared": n})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 400


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
    _inject_system_time(clean)                       # 自动注入当前系统时间
    if data.get("web_search"):
        _inject_web_search(clean)                    # 联网搜索并注入结果
    skills = data.get("skills") or data.get("skill")            # 支持多个 skill
    _inject_skill(clean, skills)                                # 注入技能提示词
    # 「文件权限」在普通对话里同样生效：只读→读取类工具；工作区/完全→额外开放写入工具
    perm = str(data.get("perm") or "readonly")
    if perm not in ("readonly", "workspace", "full"):
        perm = "readonly"
    repo = str(data.get("repo") or "")
    root = os.path.abspath(repo) if repo and os.path.isdir(repo) else ""
    use_tools = bool(root) and data.get("use_tools", True) is not False
    n_imgs = sum(1 for m in clean for part in (m["content"] if isinstance(m["content"], list) else [])
                 if isinstance(part, dict) and part.get("type") == "image_url")
    _log.info("AI 对话：provider=%s model=%s msgs=%d images=%d web_search=%s skills=%s perm=%s tools=%s",
              provider["name"], model, len(clean), n_imgs, bool(data.get("web_search")),
              ",".join(skills) if isinstance(skills, list) else (skills or "-"), perm, use_tools)

    base = provider["base_url"].rstrip("/")
    url = base if base.endswith("/chat/completions") else base + "/chat/completions"

    def _chat_headers():
        return {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + provider["api_key"],
            "Accept": "text/event-stream",
        }

    def _text_tool_note(perm_now, web=False):
        """接口不支持原生 tools 时，用系统提示告诉模型可用工具与文本调用格式。"""
        names = ["list_dir(path)", "read_file(path, start, end)", "search_files(pattern, path, max)"]
        if web:
            names.append("web_search(query, max_results)")
        if perm_now in ("workspace", "full"):
            names += ["write_file(path, content)", "edit_file(path, old_text, new_text)"]
        return ("\n\n[可用工具] 你可以按需读取项目文件来回答问题，不要凭空猜测，也不要让用户手动粘贴代码。"
                "当前项目根目录：%s\n可用工具：%s\n"
                "调用格式（严格使用工具名与参数名）：<tool_use>{\"name\":\"read_file\",\"input\":{\"path\":\"app/xxx.py\"}}</tool_use>"
                % (root or "/", "；".join(names)))
    user_query = _last_user_text(msgs)   # 通知用的用户提问
    text_parts: List[str] = []           # 闭包共享：gen() 内的 append 会实时反映到这里

    def gen():
        from .agent import tools_for_perm, _run_tool_job, _parse_text_calls, _gate
        convo = list(clean)
        all_tools = tools_for_perm(perm) if use_tools else []
        if not data.get("web_search"):                       # 未开「联网」时不给 web_search 工具
            all_tools = [t for t in all_tools if t["function"]["name"] != "web_search"]
        tools = list(all_tools)
        offered_names = {t["function"]["name"] for t in all_tools}
        rounds = 0
        while rounds < _CHAT_MAX_ROUNDS:
            rounds += 1
            text, calls = "", {}
            attempt = 0
            while True:                                     # 限流 / 临时错误自动等待重试
                body = {"model": model, "messages": convo, "stream": True}
                if tools:
                    body["tools"] = tools
                    body["tool_choice"] = "auto"
                req = urllib.request.Request(
                    url, data=json.dumps(body).encode("utf-8"), method="POST", headers=_chat_headers())
                # ① 建立连接
                try:
                    resp = _open_stream(req, url)
                except urllib.error.HTTPError as e:
                    try:
                        detail = e.read().decode("utf-8", "replace")[:500]
                    except OSError:
                        detail = ""
                    if _is_retryable_status(e.code) and attempt < _RETRY_MAX:
                        wait = _retry_wait(attempt, e)
                        attempt += 1
                        text, calls = "", {}
                        yield _sse({"type": "retry", "attempt": attempt, "wait": round(wait, 1),
                                    "reason": "接口限流/暂不可用（HTTP %d）" % e.code})
                        time.sleep(wait)
                        continue
                    if tools:                               # 接口不认 tools：降级为纯文本 + 提示词方式
                        _log.info("AI 对话：接口不支持 tools，改用提示词模式（%s）", detail[:200])
                        tools = []
                        rounds -= 1
                        if not any("可用工具" in str(m.get("content") or "") for m in convo):
                            note = _text_tool_note(perm, bool(data.get("web_search")))
                            if convo and convo[0].get("role") == "system":
                                convo[0]["content"] = str(convo[0].get("content") or "") + note
                            else:
                                convo.insert(0, {"role": "system", "content": note.strip()})
                        continue
                    if _is_retryable_status(e.code):
                        yield _sse({"error": "接口返回 %s：已自动重试 %d 次仍未成功，可稍后重试；"
                                            "若为 tpm/rpm 限流，请减少附带文件/图片或缩短上下文。详情：%s"
                                            % (e.code, _RETRY_MAX, detail or e.reason)})
                    else:
                        yield _sse({"error": f"接口返回 {e.code}：{detail or e.reason}"})
                    yield b"data: [DONE]\n\n"
                    return
                except (socket.timeout, TimeoutError):
                    if attempt < _RETRY_MAX:
                        wait = _retry_wait(attempt)
                        attempt += 1
                        text, calls = "", {}
                        yield _sse({"type": "retry", "attempt": attempt, "wait": round(wait, 1),
                                    "reason": "连接接口超时"})
                        time.sleep(wait)
                        continue
                    yield _sse({"error": "连接 AI 接口超时（%d 秒）：请检查接口地址与网络" % _CONNECT_TIMEOUT})
                    yield b"data: [DONE]\n\n"
                    return
                except (urllib.error.URLError, OSError) as e:
                    if attempt < _RETRY_MAX:
                        wait = _retry_wait(attempt)
                        attempt += 1
                        text, calls = "", {}
                        yield _sse({"type": "retry", "attempt": attempt, "wait": round(wait, 1),
                                    "reason": "网络异常，重试中"})
                        time.sleep(wait)
                        continue
                    yield _sse({"error": f"无法连接 AI 接口：{e}"})
                    yield b"data: [DONE]\n\n"
                    return
                # ② 读取流
                broken = None
                try:
                    # SSE 按行迭代：上游每 flush 一行就能立刻转发，保证打字机效果
                    for raw in resp:
                        line = raw.strip()
                        if not line.startswith(b"data:"):
                            continue
                        chunk = line[5:].strip()
                        if chunk == b"[DONE]":
                            break
                        try:
                            obj = json.loads(chunk.decode("utf-8"))
                        except ValueError:
                            continue
                        if obj.get("error"):
                            emsg = str(obj["error"])
                            if _is_retryable_text(emsg):
                                broken = RuntimeError(emsg)
                                break
                            yield _sse({"error": emsg})
                            continue
                        choices = obj.get("choices") or []
                        if not choices:
                            continue
                        delta = (choices[0] or {}).get("delta") or {}
                        piece = delta.get("content")
                        reasoning = delta.get("reasoning_content")
                        if piece or reasoning:
                            yield _sse({"delta": piece or "", "reasoning": reasoning or ""})
                        if piece:
                            text += piece
                            text_parts.append(piece)   # 同步到外层，供通知使用
                        for tc in (delta.get("tool_calls") or []):
                            slot = calls.setdefault(tc.get("index", 0), {"id": "", "name": "", "args_raw": ""})
                            if tc.get("id"):
                                slot["id"] = tc["id"]
                            fn = tc.get("function") or {}
                            if fn.get("name"):
                                slot["name"] += fn["name"]
                            if fn.get("arguments"):
                                slot["args_raw"] += fn["arguments"]
                except (socket.timeout, TimeoutError) as e:
                    broken = e or RuntimeError("读取超时")
                except (OSError, urllib.error.URLError) as e:
                    broken = e
                finally:
                    try:
                        resp.close()
                    except OSError:
                        pass
                if broken is not None:
                    if attempt < _RETRY_MAX:
                        wait = _retry_wait(attempt)
                        attempt += 1
                        text, calls = "", {}
                        yield _sse({"type": "retry", "attempt": attempt, "wait": round(wait, 1),
                                    "reason": "接口限流/连接中断，自动重试"})
                        time.sleep(wait)
                        continue
                    yield _sse({"error": "接口限流或连接中断，已自动重试 %d 次仍未成功：%s"
                                        % (_RETRY_MAX, broken)})
                    yield b"data: [DONE]\n\n"
                    return
                break
            # 收集本轮工具调用（原生 tool_calls 优先，其次正文里的文本格式）
            call_list = []
            for idx in sorted(calls):
                c = calls[idx]
                if not c["name"]:
                    continue
                try:
                    a = json.loads(c["args_raw"] or "{}")
                except ValueError:
                    a = {}
                if not isinstance(a, dict):
                    a = {}
                call_list.append({"id": c["id"] or ("call_%s" % idx), "name": c["name"], "args": a,
                                  "args_raw": c["args_raw"] or "{}"})
            if not call_list:
                call_list = _parse_text_calls(text)
            if not call_list:
                break                                        # 没有工具调用 → 回答结束
            convo.append({"role": "assistant", "content": text or None,
                          "tool_calls": [{"id": c["id"], "type": "function",
                                          "function": {"name": c["name"], "arguments": c["args_raw"]}}
                                         for c in call_list]})
            for c in call_list:
                yield _sse({"type": "step", "call_id": c["id"], "tool": c["name"], "args": c["args"]})
                tool_changes = None
                if c["name"] not in offered_names:            # 模型可能伪造了未开放的工具（如 run_command）
                    ok, summary, detail = False, "该工具在普通对话中不可用：%s" % c["name"], ""
                    model_text = "调用被拒绝：普通对话不允许使用 %s（可在智能体模式下执行命令）" % c["name"]
                else:
                    allowed, refuse, need_ask, ask_reason = _gate(perm, c["name"], c["args"], root)
                    if not allowed:
                        ok, summary, detail = False, refuse, ""
                        model_text = "调用被拒绝：%s" % refuse
                    elif need_ask:
                        ok, summary, detail = False, "该操作需要确认，普通对话不支持", ""
                        model_text = "该操作需要用户确认，请提示用户切换到智能体模式执行"
                    else:
                        undo.begin()
                        ok, summary, detail, model_text = _run_tool_job(c["name"], c["args"], root, perm)
                        tool_changes = undo.finish(root)   # 推断动作 + 生成差异，供「文件变更」模块
                yield _sse({"type": "result", "call_id": c["id"], "tool": c["name"], "ok": bool(ok),
                            "summary": summary, "detail": detail, "ms": 0,
                            "changes": (tool_changes or None)})
                convo.append({"role": "tool", "tool_call_id": c["id"],
                              "content": (model_text or summary or detail or "")[:_CHAT_TOOL_CHARS]})
        yield b"data: [DONE]\n\n"

    def _gen_with_notify():
        try:
            yield from gen()
        finally:
            reply = "".join(text_parts)
            _fire_notify_async("chat", user_query, reply)

    return Response(_gen_with_notify(), mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@bp.route("/api/ai/changes", methods=["POST"])
def api_ai_changes():
    """查看某批改动 id 的文件变更详情（路径 / 动作 / unified 差异）。"""
    data = request.get_json(silent=True) or {}
    ids = data.get("ids") or []
    if not isinstance(ids, list) or not ids:
        return jsonify({"error": "ids 不能为空"}), 400
    repo = str(data.get("repo") or "")
    root = os.path.abspath(repo) if repo and os.path.isdir(repo) else ""
    changes = undo.describe([str(i) for i in ids][:500], root, with_diff=True)
    return jsonify({"ok": True, "changes": changes})


@bp.route("/api/ai/undo", methods=["POST"])
def api_ai_undo():
    """回撤 AI 某条回复造成的文件改动（写入 / 修改 / 新建）。"""
    data = request.get_json(silent=True) or {}
    ids = data.get("ids") or []
    if not isinstance(ids, list) or not ids:
        return jsonify({"error": "ids 不能为空"}), 400
    results = undo.restore([str(i) for i in ids][:500])
    ok = sum(1 for r in results if r.get("ok"))
    _log.info("AI 回撤：请求 %d 项，成功 %d 项", len(results), ok)
    return jsonify({"ok": True, "restored": ok, "total": len(results), "results": results})


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
        p = subprocess.run([exe, "-c", "safe.directory=*", "-c", "core.quotepath=false"] + args,
                           cwd=cwd, capture_output=True,
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

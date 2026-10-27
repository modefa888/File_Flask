"""运行环境管理接口。

GET  /api/env/runtimes?refresh=1     探测本机已安装的运行时 / 工具（版本、路径、候选）
GET  /api/env/detail?id=node         某个运行时的详细信息（多条只读命令输出）
GET  /api/env/system                 系统信息 + 当前 PATH + 相关环境变量
GET  /api/env/config                 读取自定义配置（解释器路径 / 环境变量）
POST /api/env/config                 保存自定义配置
POST /api/env/tool-action            白名单化配置操作（切换镜像源、创建 venv 等）
POST /api/env/ai-install             AI 安装方案（内置接口：服务端采集快照 → 交给「系统 AI」出步骤）
GET  /api/env/install/history        安装记录（落库，按开始时间倒序）
GET  /api/env/install/history/log    某条安装记录的完整日志
POST /api/env/install/history/clear  清空安装记录

说明：探测与配置操作都不接受任意命令，具体见 services/envprobe.py。
"""
import json
import time
import urllib.error
import urllib.request

import os

from flask import Blueprint, request, jsonify

from ... import config
from ...log import get_logger
from ...services.ide import envai, envhist, envprobe, envinstall


_log = get_logger()
bp = Blueprint("env", __name__)

_AI_TIMEOUT = 150          # AI 安装方案的读超时（秒）：步骤较长，给足生成时间


def _exec_allowed() -> bool:
    return bool(getattr(config, "ENABLE_EXEC", True))


@bp.route("/api/env/runtimes")
def api_env_runtimes():
    force = request.args.get("refresh") in ("1", "true", "yes")
    return jsonify(envprobe.probe_all(force=force))


@bp.route("/api/env/detail")
def api_env_detail():
    rid = (request.args.get("id") or "").strip()
    if not rid:
        return jsonify({"error": "缺少 id 参数"}), 400
    return jsonify(envprobe.probe_detail(rid))


@bp.route("/api/env/system")
def api_env_system():
    return jsonify(envprobe.system_info())


@bp.route("/api/env/config", methods=["GET"])
def api_env_config_get():
    cfg = envprobe.load_cfg()
    cfg["file"] = envprobe._CFG_FILE
    return jsonify(cfg)


@bp.route("/api/env/config", methods=["POST"])
def api_env_config_post():
    data = request.get_json(silent=True) or {}
    cfg = envprobe.load_cfg()

    if "overrides" in data:
        raw = data.get("overrides") or {}
        if not isinstance(raw, dict):
            return jsonify({"error": "overrides 必须是对象"}), 400
        clean = dict(cfg["overrides"])
        for rid, path in raw.items():
            rid = str(rid).strip()
            path = str(path or "").strip()
            if not rid:
                continue
            if not path:                      # 空值表示清除该自定义路径
                for key in (rid, *envprobe._CATALOG_BY_ID.get(rid, {}).get("exes", [])):
                    clean.pop(key, None)
                continue
            p = os.path.expanduser(path)
            if not os.path.isfile(p):
                return jsonify({"error": f"文件不存在：{path}"}), 400
            if not os.access(p, os.X_OK):
                return jsonify({"error": f"文件不可执行：{path}"}), 400
            clean[rid] = os.path.abspath(p)
        cfg["overrides"] = clean

    if "env" in data:
        raw = data.get("env") or {}
        if not isinstance(raw, dict):
            return jsonify({"error": "env 必须是对象"}), 400
        clean_env = {}
        for k, v in raw.items():
            k = str(k).strip()
            if not k:
                continue
            if not k.replace("_", "").isalnum() or not (k[0].isalpha() or k[0] == "_"):
                return jsonify({"error": f"环境变量名不合法：{k}"}), 400
            clean_env[k] = str(v)
        cfg["env"] = clean_env

    envprobe.save_cfg(cfg)
    envprobe.invalidate_cache()
    _log.info("POST /api/env/config overrides=%d env=%d", len(cfg["overrides"]), len(cfg["env"]))
    out = dict(cfg)
    out["ok"] = True
    out["file"] = envprobe._CFG_FILE
    return jsonify(out)


@bp.route("/api/env/install")
def api_env_install_plans():
    """某运行时可用的安装方案。

    resolve=0：只返回静态方案（不访问官方源，秒回），版本号由前端随后单独请求；
    默认 resolve=1：解析最新版本与下载地址（网络慢时可能几秒）。
    """
    rid = (request.args.get("id") or "").strip()
    if not rid:
        return jsonify({"error": "缺少 id 参数"}), 400
    resolve = str(request.args.get("resolve", "1")).lower() not in ("0", "false", "no")
    return jsonify(envinstall.list_plans(rid, resolve=resolve))


@bp.route("/api/env/install", methods=["POST"])
def api_env_install_start():
    """启动一键安装（仅内置白名单方案，安装到 ~/.local）。"""
    data = request.get_json(silent=True) or {}
    rid = (data.get("id") or "").strip()
    key = (data.get("key") or "").strip()
    if not rid or not key:
        return jsonify({"error": "缺少 id / key 参数"}), 400
    source = (data.get("source") or "panel").strip()          # ai = 运行管理里的「AI 安装」
    result = envinstall.start_install(rid, key, source=source if source in ("ai", "panel") else "panel")
    if result.get("error"):
        return jsonify(result), 400
    return jsonify(result)


@bp.route("/api/env/install/log")
def api_env_install_log():
    """轮询安装日志（增量）。"""
    tid = (request.args.get("tid") or "").strip()
    try:
        offset = int(request.args.get("offset") or 0)
    except ValueError:
        offset = 0
    if not tid:
        return jsonify({"error": "缺少 tid 参数"}), 400
    return jsonify(envinstall.task_log(tid, offset))


@bp.route("/api/env/install/cancel", methods=["POST"])
def api_env_install_cancel():
    """取消进行中的安装任务。"""
    data = request.get_json(silent=True) or {}
    tid = (data.get("tid") or "").strip()
    if not tid:
        return jsonify({"error": "缺少 tid 参数"}), 400
    result = envinstall.cancel_install(tid)
    if result.get("error"):
        return jsonify(result), 404
    return jsonify(result)


@bp.route("/api/env/ai-install", methods=["POST"])
def api_env_ai_install():
    """AI 安装方案（内置接口，只服务这一件事）。

    入参 {"query": "需求描述", "ids": ["node", ...]}：ids 是使用者在列表里点名的目标（可选）。
    服务端采集「系统信息 + 可选运行时清单」并组织提问，把模型给的建议解析成结构化清单返回：
      {summary, items[{id,name,version,reason,mode,command,plans,plan_key,auto,installed}], notes, risk, text}
    不写对话记录，也不执行任何命令；一键安装由前端逐项走 /api/env/install。
    模型由「设置 → 系统 AI」里 envinstall 模块选定的接口 / 模型提供（未单独指定时跟随 AI 助手）。
    """
    from .ai import (_estimate_msgs, _estimate_tokens, _load_cfg, _log_ai_call,
                     _preflight, _sys_err_response, _sys_pick)   # 函数内导入，避免模块循环依赖

    cfg = _load_cfg()
    provider, model, err = _sys_pick(cfg, "envinstall")
    if err:
        return _sys_err_response(err, need_config=not cfg.get("providers"))

    data = request.get_json(silent=True) or {}
    raw_ids = data.get("ids")
    ids = [str(x).strip() for x in (raw_ids or []) if str(x).strip()][:8]
    query = str(data.get("query") or "").strip()[:600]

    snap = envai.snapshot(ids)
    sys_prompt, user_text = envai.build_messages(snap, query)
    base = provider["base_url"].rstrip("/")
    url = base if base.endswith("/chat/completions") else base + "/chat/completions"
    payload = json.dumps({"model": model, "stream": False, "messages": [
        {"role": "system", "content": sys_prompt},
        {"role": "user", "content": user_text}]}).encode("utf-8")

    t0 = time.time()
    tin = tout = 0
    est = False
    text = ""

    def _fail(msg):
        _log_ai_call("envinstall", False, int((time.time() - t0) * 1000), msg, model,
                     tin, tout, est, req=user_text, resp=text)
        return jsonify({"error": msg})

    try:
        req = urllib.request.Request(url, data=payload, method="POST", headers={
            "Content-Type": "application/json", "Authorization": "Bearer " + provider["api_key"]})
        _preflight(url, 8)                                  # 地址不通时立刻报错，别把长读超时耗光
        resp = urllib.request.urlopen(req, timeout=_AI_TIMEOUT)
        obj = json.loads(resp.read().decode("utf-8", "ignore"))
        text = (((obj.get("choices") or [{}])[0] or {}).get("message") or {}).get("content") or ""
        usage = obj.get("usage") or {}
        tin, tout = int(usage.get("prompt_tokens") or 0), int(usage.get("completion_tokens") or 0)
        if not (tin or tout):                               # 上游没给用量：按字数兜底估算（界面标 ≈）
            tin = _estimate_msgs([{"role": "system", "content": sys_prompt},
                                  {"role": "user", "content": user_text}])
            tout, est = _estimate_tokens(text), True
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "ignore")[:200]
        return _fail("AI 接口返回 %s：%s" % (e.code, detail))
    except Exception as e:
        return _fail("调用 AI 接口失败：%s" % e)

    text = envai.clean_answer(text)
    if not text:
        return _fail("模型没有返回内容，请换个模型或稍后重试")

    elapsed = int((time.time() - t0) * 1000)
    plan = envai.parse_plan(text, snap)
    _log_ai_call("envinstall", True, elapsed, "", model, tin, tout, est, req=user_text, resp=text)
    _log.info("AI 安装方案完成：model=%s %dms，建议 %d 项（可一键安装 %d 项）",
              model, elapsed, len((plan or {}).get("items") or []),
              len([x for x in (plan or {}).get("items") or [] if x.get("auto")]))

    if plan is None:                                  # 模型没按 JSON 回：退化成纯文本展示
        return jsonify({
            "ok": True, "summary": "", "items": [], "notes": [], "risk": "",
            "text": text, "parse_error": "模型没有按约定返回 JSON，已按纯文本展示，可按命令手动安装",
            "model": model, "elapsed_ms": elapsed,
            "tokens_in": tin, "tokens_out": tout, "estimated": est,
        })

    return jsonify({
        "ok": True,
        "summary": plan["summary"], "items": plan["items"],
        "notes": plan["notes"], "risk": plan["risk"],
        "text": envai.render_text(plan),
        "model": model, "elapsed_ms": elapsed,
        "tokens_in": tin, "tokens_out": tout, "estimated": est,
    })


@bp.route("/api/env/install/history", methods=["GET"])
def api_env_install_history():
    """安装记录（最近 N 条，不含日志正文）：运行管理页「安装记录」用。"""
    try:
        limit = int(request.args.get("limit") or 40)
    except ValueError:
        limit = 40
    return jsonify(envhist.list_records(limit))


@bp.route("/api/env/install/history/log", methods=["GET"])
def api_env_install_history_log():
    """某条安装记录的完整日志（点开详情时才取，列表接口不带大字段）。"""
    try:
        seq = int(request.args.get("seq") or 0)
    except ValueError:
        seq = 0
    if not seq:
        return jsonify({"error": "缺少 seq 参数"}), 400
    return jsonify(envhist.record_log(seq))


@bp.route("/api/env/install/history/clear", methods=["POST"])
def api_env_install_history_clear():
    """清空安装记录（只删历史，不影响已装好的运行时）。"""
    res = envhist.clear()
    _log.info("清空运行环境安装记录：%s 条", res.get("deleted", 0))
    return jsonify(res)


@bp.route("/api/env/tool-action", methods=["POST"])
def api_env_tool_action():
    if not _exec_allowed():
        return jsonify({"error": "已禁用命令执行（config.ENABLE_EXEC = False）"}), 403
    data = request.get_json(silent=True) or {}
    rid = (data.get("id") or "").strip()
    key = (data.get("key") or "").strip()
    value = data.get("value") or ""
    cwd = (data.get("cwd") or "").strip()
    if not rid or not key:
        return jsonify({"error": "缺少 id / key 参数"}), 400
    result = envprobe.run_tool_action(rid, key, value=str(value), cwd=cwd)
    envprobe.invalidate_cache()
    if result.get("error"):
        return jsonify(result), 400
    return jsonify(result)

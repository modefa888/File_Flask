"""进程资源管理器 REST API：本机资源占用 / 进程列表 / 端口 / 结束进程 / AI 资源诊断。

GET  /api/proc/overview            系统总体占用（CPU / 内存 / 磁盘 / 网络 + 分组统计）
GET  /api/proc/list?sort=&q=&limit= 进程列表（sort: cpu|mem|pid|name|threads|started）
GET  /api/proc/ports               监听中的端口与占用进程（只读）
POST /api/proc/kill                结束指定进程 {pid}
POST /api/proc/diagnose            AI 资源诊断（内置接口：服务端采集快照 → 交给「系统 AI」分析）

鉴权复用 auth.py 的 session（/api/* 未登录由 before_request 统一拦截）。
安全约束见 services/ide/procinfo.py：只读采集 + 只按 pid 结束进程，不接受任何命令文本。
"""
import json
import time
import urllib.error
import urllib.request

from flask import Blueprint, jsonify, request

from ...log import get_logger
from ...services.ide import procdiag, procinfo

_log = get_logger()
bp = Blueprint("proc", __name__)

_DIAG_TIMEOUT = 180          # 诊断请求的读超时（秒）：报告较长，给足模型生成时间


@bp.route("/api/proc/overview", methods=["GET"])
def api_proc_overview():
    ov = procinfo.overview()
    if ov.get("error"):
        return jsonify({"ok": False, **ov}), 200          # 未装 psutil 等：前端按 ok=false 提示
    return jsonify({"ok": True, **ov})


@bp.route("/api/proc/list", methods=["GET"])
def api_proc_list():
    res = procinfo.processes(sort=request.args.get("sort") or "cpu",
                             q=request.args.get("q") or "",
                             limit=request.args.get("limit") or 300)
    if res.get("error"):
        return jsonify({"ok": False, "error": res["error"], "procs": []}), 200
    return jsonify({"ok": True, **res})


@bp.route("/api/proc/ports", methods=["GET"])
def api_proc_ports():
    return jsonify({"ok": True, **procinfo.ports()})


@bp.route("/api/proc/kill", methods=["POST"])
def api_proc_kill():
    data = request.get_json(silent=True) or {}
    try:
        pid = int(data.get("pid"))
    except (TypeError, ValueError):
        return jsonify({"error": "缺少有效的 pid"}), 400
    res = procinfo.kill_pid(pid)
    if res.get("error"):
        return jsonify(res), 400
    _log.info("进程资源管理器：已结束进程 pid=%s（%s）", pid, res.get("signal") or "-")
    return jsonify(res)


@bp.route("/api/proc/diagnose", methods=["POST"])
def api_proc_diagnose():
    """AI 资源诊断（内置接口，只服务这一件事）。

    服务端自己采集快照并组织提问，把结论整段返回给前端的专用显示模块；
    不走 AI 助手的对话上下文，也不会往聊天记录里塞消息。
    模型由「设置 → 系统 AI」里 proc 模块选定的接口/模型提供（未单独指定时跟随 AI 助手）。
    """
    from .ai import (_estimate_msgs, _estimate_tokens, _load_cfg, _log_ai_call,
                     _preflight, _sys_err_response, _sys_pick)   # 函数内导入，避免模块循环依赖

    cfg = _load_cfg()
    provider, model, err = _sys_pick(cfg, "proc")
    if err:
        return _sys_err_response(err, need_config=not cfg.get("providers"))

    data = request.get_json(silent=True) or {}
    focus = str(data.get("focus") or "").strip()[:400]      # 可选：使用者补充的关注点

    snap = procdiag.snapshot()
    if snap.get("error"):
        return jsonify({"error": snap["error"]})           # 未装 psutil 等：前端按 error 提示

    sys_prompt, user_text = procdiag.build_messages(snap, focus)
    base = provider["base_url"].rstrip("/")
    url = base if base.endswith("/chat/completions") else base + "/chat/completions"
    payload = json.dumps({"model": model, "stream": False, "messages": [
        {"role": "system", "content": sys_prompt},
        {"role": "user", "content": user_text}]}).encode("utf-8")

    t0 = time.time()
    tin = tout = 0
    est = False
    text = ""

    def _fail(msg, ms=0):
        _log_ai_call("proc", False, int(ms or (time.time() - t0) * 1000), msg, model,
                     tin, tout, est, req=user_text, resp=text)
        return jsonify({"error": msg})

    try:
        req = urllib.request.Request(url, data=payload, method="POST", headers={
            "Content-Type": "application/json", "Authorization": "Bearer " + provider["api_key"]})
        _preflight(url, 8)                                  # 地址不通时立刻报错，别把长读超时耗光
        resp = urllib.request.urlopen(req, timeout=_DIAG_TIMEOUT)
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

    text = procdiag.clean_answer(text)
    if not text:
        return _fail("模型没有返回内容，请换个模型或稍后重试")

    elapsed = int((time.time() - t0) * 1000)
    _log_ai_call("proc", True, elapsed, "", model, tin, tout, est, req=user_text, resp=text)
    _log.info("AI 资源诊断完成：model=%s %dms，结论 %d 字", model, elapsed, len(text))
    return jsonify({
        "ok": True, "text": text, "model": model, "elapsed_ms": elapsed,
        "tokens_in": tin, "tokens_out": tout, "estimated": est, "snapshot": snap,
    })

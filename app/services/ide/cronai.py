"""定时任务「AI 提示词」执行器。

把任务里保存的固定提示词（content / ai_sys）发给模型，返回模型输出的正文。
接口与模型走「设置 → 系统 AI」里的 crontask 模块（未单独指定时跟随 AI 助手），
与「AI 生成通知文案」共用同一套配置读取逻辑，但可以单独停用。

只做一次非流式请求，不依赖 Flask 请求上下文，方便在定时任务的线程里调用。
"""
import json
import time
import urllib.error
import urllib.request

from ...log import get_logger

_log = get_logger()

_TIMEOUT_DEFAULT = 180              # 默认单次等待上限（秒），任务里可用「超时」覆盖
_TIMEOUT_MIN = 10
_TIMEOUT_MAX = 900

_DEFAULT_SYS = (
    "你是定时任务执行助手。用户给的是每天固定执行一次的提示词，你需要直接完成它并输出结果正文。\n"
    "要求：\n"
    "1. 只输出结果本身，不要寒暄、不要复述提示词、不要说明「我在执行任务」；\n"
    "2. 用简洁的中文，可用轻量 Markdown（标题 / 列表 / 表格）组织；\n"
    "3. 内容要具体、可执行，避免空话套话；\n"
    "4. 不确定的信息明确标注，不要编造事实或数据。"
)


def run_prompt(task, timeout=0, should_stop=None):
    """执行一次「AI 提示词」任务，返回模型输出文本。

    失败抛出 RuntimeError（消息可直接写进执行日志给用户看）。
    should_stop：可选的无参回调，返回 True 表示用户已停止本次执行。
    """
    from ...routes.ide.ai import (_brief, _estimate_msgs, _estimate_tokens, _load_cfg,
                                  _log_ai_call, _preflight, _sys_pick)

    task = task or {}
    prompt = str(task.get("content") or "").strip()
    if not prompt:
        raise RuntimeError("任务的提示词为空，请先在编辑里填写")
    stop = should_stop or (lambda: False)
    if stop():
        raise RuntimeError("已手动停止")

    cfg = _load_cfg()
    provider, model, err = _sys_pick(cfg, "crontask")
    if err:
        raise RuntimeError(err)

    sys_prompt = str(task.get("ai_sys") or "").strip() or _DEFAULT_SYS
    msgs = [{"role": "system", "content": sys_prompt},
            {"role": "user", "content": prompt}]
    base = str(provider.get("base_url") or "").rstrip("/")
    url = base if base.endswith("/chat/completions") else base + "/chat/completions"
    payload = json.dumps({"model": model, "stream": False, "temperature": 0.7,
                          "messages": msgs}).encode("utf-8")

    try:
        timeout = int(timeout or 0)
    except (TypeError, ValueError):
        timeout = 0
    timeout = min(max(timeout, _TIMEOUT_MIN), _TIMEOUT_MAX) if timeout > 0 else _TIMEOUT_DEFAULT

    t0 = time.time()
    tin = tout = 0
    est = False
    text = ""

    def _fail(msg, raw=""):
        _log_ai_call("crontask", False, int((time.time() - t0) * 1000), msg, model,
                     tin, tout, est, req=_brief(prompt), resp=_brief(raw))
        return RuntimeError(msg)

    try:
        req = urllib.request.Request(url, data=payload, method="POST", headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer " + str(provider.get("api_key") or "")})
        _preflight(url, 8)                       # 地址不通时立刻报错，别耗光读超时
        resp = urllib.request.urlopen(req, timeout=timeout)
        obj = json.loads(resp.read().decode("utf-8", "ignore"))
        text = ((((obj.get("choices") or [{}])[0] or {}).get("message") or {}).get("content") or "")
        usage = obj.get("usage") or {}
        tin, tout = int(usage.get("prompt_tokens") or 0), int(usage.get("completion_tokens") or 0)
        if not (tin or tout):                    # 上游没给用量：按字数兜底估算
            tin = _estimate_msgs(msgs)
            tout, est = _estimate_tokens(text), True
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "ignore")[:200]
        raise _fail("AI 接口返回 %s：%s" % (e.code, detail))
    except Exception as e:                       # noqa: BLE001
        raise _fail("调用 AI 接口失败：%s" % e)

    if not text.strip():
        raise _fail("AI 返回了空内容，请重试或换个模型", raw=text)
    if stop():
        raise RuntimeError("已手动停止")

    elapsed = int((time.time() - t0) * 1000)
    _log_ai_call("crontask", True, elapsed, "", model, tin, tout, est,
                 req=_brief(prompt), resp=_brief(text))
    _log.info("定时任务 AI 提示词执行完成：model=%s %dms %d字", model, elapsed, len(text))
    return text.strip()

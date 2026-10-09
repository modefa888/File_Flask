# -*- coding: utf-8 -*-
"""AI 后台运行管理：把（Agent / 对话）的执行从 HTTP 请求里解耦。

背景：原来的实现把「模型调用的生成器」直接挂在 HTTP 响应上返回，
浏览器一旦刷新 / 断线，响应被关闭 → 生成器被销毁 → 任务就没了，刷新后什么都看不到。

现在改成：
    1. 请求只负责「启动 + 返回 run_id」，真正的执行放到后台线程里跑；
    2. 后台线程把产生的每条 SSE 事件追加进内存缓冲，并唤醒等待中的订阅者；
    3. 前端刷新后按 run_id 重新连接（SSE），先把缓冲里已产生的事件回放一遍，
       再实时续传新事件 —— 于是「刷新页面仍在后台运行、刷新后能看到实时进度」。

事件在内存里保留一段时间（默认 6 小时 / 最多 50 场），过期或超量后按 FIFO 清理。
"""
import json
import threading
import time

# run_id -> {
#   "events": [str, ...],      # 已产生的 SSE 事件文本（每条形如 "data: {json}\n\n"）
#   "done": bool,              # 是否已结束
#   "cancel": Event,           # 请求停止时置位
#   "started": float,          # 开始时间
#   "ended": float,            # 结束时间（未结束为 0）
# }
_RUNS = {}
_RUN_CV = threading.Condition()        # 同时充当 _RUNS 的锁与「有新事件」的通知
_RUNS_ORDER = []                       # 创建顺序，用于清理最旧的运行
_RUN_TTL = 6 * 3600                    # 已结束的运行在内存里保留多久（秒）
_RUNS_KEEP = 50                        # 最多保留多少场运行
_RUN_MAX_EVENTS = 50000                # 单场运行最多缓冲多少条事件（防内存无限增长）


def _sse(payload):
    return ("data: " + json.dumps(payload, ensure_ascii=False) + "\n\n").encode("utf-8")


def _prune_locked():
    """按 TTL 与数量上限清理运行（调用方需持有 _RUN_CV）。正在运行的一律保留。"""
    now = time.time()
    for rid in list(_RUNS_ORDER):
        st = _RUNS.get(rid)
        if st and st["done"] and st["ended"] and now - st["ended"] > _RUN_TTL:
            _RUNS.pop(rid, None)
            try:
                _RUNS_ORDER.remove(rid)
            except ValueError:
                pass
    while len(_RUNS_ORDER) > _RUNS_KEEP:
        victim = None
        for rid in _RUNS_ORDER:
            st = _RUNS.get(rid)
            if st is None or st["done"]:
                victim = rid
                break
        if victim is None:                 # 全都在跑：不再清理，避免误删正在进行的任务
            break
        _RUNS.pop(victim, None)
        try:
            _RUNS_ORDER.remove(victim)
        except ValueError:
            pass


def create(run_id, meta=None):
    """新建一场运行，返回其状态字典。

    meta 用于落库与「按会话找回运行」，形如
    {"session_id": "...", "root": "...", "user_id": "..."}。
    """
    st = {"events": [], "done": False, "cancel": threading.Event(),
          "started": time.time(), "ended": 0.0, "meta": dict(meta or {})}
    with _RUN_CV:
        _RUNS[run_id] = st
        _RUNS_ORDER.append(run_id)
        _prune_locked()
    return st


def exists(run_id):
    with _RUN_CV:
        return run_id in _RUNS


def find_by_session(session_id):
    """按会话 id 找最近一场运行（首选还在跑的，其次刚结束的）。

    前端即使丢了 run_id（清缓存、换浏览器等），刷新后也能按当前会话找回进度。
    """
    if not session_id:
        return ""
    with _RUN_CV:
        hit = ""
        for rid in _RUNS_ORDER:                      # _RUNS_ORDER 按创建顺序，后加入的更晚
            st = _RUNS.get(rid)
            if not st or (st.get("meta") or {}).get("session_id") != session_id:
                continue
            hit = rid
            if not st["done"]:
                break                                # 正在跑的优先
        return hit


def snapshot(run_id):
    """取出该运行已产生的全部事件（快照，不含锁）。"""
    with _RUN_CV:
        st = _RUNS.get(run_id)
        return list(st["events"]) if st else []


def started_at(run_id):
    with _RUN_CV:
        st = _RUNS.get(run_id)
        return st["started"] if st else time.time()


def info(run_id):
    """返回 {exists, done, events} 供前端判断是否还能重连。"""
    with _RUN_CV:
        st = _RUNS.get(run_id)
        if st is None:
            return {"exists": False}
        return {"exists": True, "done": bool(st["done"]), "events": len(st["events"])}


def cancel(run_id):
    """请求停止某场运行；返回是否找到该运行。"""
    with _RUN_CV:
        st = _RUNS.get(run_id)
        if st is None:
            return False
        st["cancel"].set()
        _RUN_CV.notify_all()
        return True


def push(run_id, chunk):
    """把一条 SSE 事件追加进缓冲，并唤醒等待中的订阅者（线程安全）。"""
    text = chunk.decode("utf-8") if isinstance(chunk, bytes) else str(chunk)
    if not text:
        return
    with _RUN_CV:
        st = _RUNS.get(run_id)
        if st is None:
            return
        if len(st["events"]) < _RUN_MAX_EVENTS:
            st["events"].append(text)
        _RUN_CV.notify_all()


def _finish(run_id):
    with _RUN_CV:
        st = _RUNS.get(run_id)
        if st is not None:
            st["done"] = True
            st["ended"] = time.time()
        _RUN_CV.notify_all()


def worker(run_id, producer, on_error="执行失败"):
    """后台线程入口：消费生成器 producer，把每条事件推进缓冲；被取消时提前收尾。

    producer 是一个可迭代的生成器（每次 yield 一小段 SSE 文本 / bytes）。
    """
    cancelled = False
    try:
        for chunk in producer:
            with _RUN_CV:
                st = _RUNS.get(run_id)
                if st is None or st["cancel"].is_set():
                    cancelled = True
                    break
            push(run_id, chunk)
    except BaseException as e:  # noqa: BLE001  （包含 GeneratorExit 等）
        if not isinstance(e, GeneratorExit):
            push(run_id, _sse({"type": "error", "error": "%s：%s" % (on_error, e)}))
    finally:
        try:
            producer.close()
        except BaseException:  # noqa: BLE001
            pass
        if cancelled:
            push(run_id, _sse({"type": "stopped"}))
            push(run_id, _sse({"type": "done"}))
        _finish(run_id)


def _events_to_reply(events):
    """从缓冲的事件里还原这一轮的回复（正文 / 步骤 / 文件变更 / 任务清单）。"""
    text, steps, changes, todos = "", [], [], []
    step_meta = {}
    for raw in events or []:
        for line in str(raw).splitlines():
            if not line.startswith("data:"):
                continue
            body_s = line[5:].strip()
            if not body_s or body_s == "[DONE]":
                continue
            try:
                obj = json.loads(body_s)
            except ValueError:
                continue
            if not isinstance(obj, dict):
                continue
            t = obj.get("type")
            # 正文有两种写法：Agent 用 {"type":"delta","text":...}；对话用 {"delta":...,"reasoning":...}
            if t == "delta" or obj.get("delta") is not None:
                text += str(obj.get("text") or obj.get("delta") or "")
            elif t == "retry":
                text = ""                                   # 限流重试会清空之前的内容
            elif t == "step":
                step_meta[obj.get("call_id")] = {"tool": obj.get("tool"), "args": obj.get("args") or {}}
            elif t == "result":
                md = step_meta.get(obj.get("call_id")) or {"tool": obj.get("tool"), "args": {}}
                steps.append({"tool": md.get("tool"), "args": md.get("args") or {},
                              "ok": bool(obj.get("ok")), "denied": bool(obj.get("denied")),
                              "ms": obj.get("ms"), "summary": obj.get("summary") or "",
                              "detail": obj.get("detail") or ""})
                for c in (obj.get("changes") or []):
                    if c:
                        changes.append(c)
            elif t == "todos":
                if obj.get("todos"):
                    todos = obj["todos"]
    return text, steps, changes, todos


def save_reply(run_id):
    """把一场运行最终的回复写进对话历史（兜底：前端没能重连也不会丢内容）。

    消息 mid 固定为 "m"+run_id，前端保存时用的是同一个 mid（覆盖更新而非新增），
    所以不会出现两条重复回复。会话还不存在（前端还没 flush）时不写。
    """
    from .chatdb import get_conversation, upsert_conversation      # 延迟导入：避免影响模块加载

    with _RUN_CV:
        st = _RUNS.get(run_id)
    if not st:
        return False
    meta = st.get("meta") or {}
    session_id = str(meta.get("session_id") or "")
    user_id = str(meta.get("user_id") or "")
    root = str(meta.get("root") or "")
    if not session_id or not user_id:
        return False
    text, steps, changes, todos = _events_to_reply(snapshot(run_id))
    if not text.strip() and not steps and not changes and not todos:
        return False
    conv = get_conversation(user_id, session_id)
    if not conv:
        return False
    ms = max(0, int((time.time() - (st["started"] or time.time())) * 1000))
    msg = {
        "mid": "m" + run_id,
        "role": "assistant",
        "text": text,
        "images": [],
        "reasoning": "",
        "meta": {"ms": ms, "ts": int(time.time() * 1000),
                 "steps": steps or None, "changes": changes or None, "todos": todos or None},
    }
    upsert_conversation(user_id, session_id, conv.get("title") or "",
                        conv.get("extra") or {}, [msg], root=root)
    return True


def sse_stream(run_id, offset=0):
    """SSE 生成器：先回放缓冲里 offset 之后的事件，再实时续传，直到运行结束且追平。"""
    while True:
        batch = None
        done = False
        gone = False
        woken = True
        with _RUN_CV:
            st = _RUNS.get(run_id)
            if st is None:
                gone = True
            else:
                if offset < len(st["events"]):
                    batch = st["events"][offset:]
                    offset = len(st["events"])
                done = st["done"]
                if batch is None and not done:
                    woken = _RUN_CV.wait(timeout=15)
        if gone:
            yield _sse({"type": "error", "error": "该任务已结束或服务已重启，无法继续接收进度"})
            break
        if batch:
            for ev in batch:
                yield ev
            continue
        if done:
            break
        if woken:
            continue                # 有新事件/状态变化：立即重算，不误发心跳
        yield ": ping\n\n"          # 等待超时：发心跳注释保活，避免代理/网关掐断连接
    yield "data: [DONE]\n\n"

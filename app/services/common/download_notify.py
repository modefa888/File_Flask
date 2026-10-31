"""下载中心通知：任务完成 / 失败时，向「通知渠道」里勾选的账号推送。

与「AI 通知」「定时任务通知」保持同一套模型：
  · 渠道账号统一在「设置 → 通知渠道」里维护（一个渠道可多个账号）
  · 这里只负责：总开关 + 触发事件 + 勾选账号 + 文案模板
  · 每次推送都会写一条通知历史（source="download"），可在「通知中心」看到

配置存 store.db 的 dl_cfg 表（key='dl_notify'），与下载设置（key='cfg'）互不干扰。

统一入口：
    download_notify.on_task(tid, "done" | "failed")   # 任务状态变化时调用
    download_notify.test("all")                        # 发测试消息
"""
import json
import threading
import time

from ...log import get_logger
from . import notifications, notify_channels
from .store_db import store_conn, store_tx

_log = get_logger()

_CFG_KEY = "dl_notify"
_MASK = "******"

CHANNELS = ("desktop", "email", "telegram", "dingtalk", "pushplus", "web")

DEFAULT_CFG = {
    "enabled": False,
    # 哪些结果需要推送
    "events": {"done": True, "failed": True},
    # 勾选的渠道账号 id（空数组 = 该渠道不发送）
    "targets": {ch: [] for ch in CHANNELS},
    # 文案模板：{name} 文件名  {event} 完成/失败  {size} 大小  {status} 原始状态
    #           {date} {time} 触发时间  {error} 失败原因
    "template": {
        "title": "下载{event} · {name}",
        "body": "任务「{name}」{event}。\n大小：{size}\n时间：{date} {time}",
    },
}

_EVENT_NAMES = {"done": "完成", "failed": "失败"}

# 进程内去重：同一个任务同一种结果在极短时间内只推一次
# （防止并发调用 _update 时重复发送；隔一会儿重新下载同一任务仍会正常通知）
_SENT = {}
_SENT_LOCK = threading.Lock()
_SENT_MAX = 2000
_SENT_WINDOW = 10.0


# ---------------------------------------------------------------- 配置读写
def _read_raw():
    try:
        conn = store_conn()
        try:
            row = conn.execute("SELECT value FROM dl_cfg WHERE key=?", (_CFG_KEY,)).fetchone()
        finally:
            conn.close()
    except Exception:                                   # noqa: BLE001
        return {}
    if not row:
        return {}
    try:
        data = json.loads(row["value"] or "{}")
        return data if isinstance(data, dict) else {}
    except (TypeError, ValueError):
        return {}


def _write_raw(cfg):
    with store_tx() as conn:
        conn.execute("INSERT OR REPLACE INTO dl_cfg (key, value) VALUES (?,?)",
                     (_CFG_KEY, json.dumps(cfg, ensure_ascii=False)))


def _normalize_targets(raw):
    out = {}
    for ch in CHANNELS:
        vals = (raw or {}).get(ch)
        seen, ids = set(), []
        for x in (vals if isinstance(vals, list) else []):
            sid = str(x or "").strip()
            if sid and sid not in seen:
                seen.add(sid)
                ids.append(sid)
        out[ch] = ids
    return out


def get_cfg():
    cfg = json.loads(json.dumps(DEFAULT_CFG))
    saved = _read_raw()
    if isinstance(saved.get("events"), dict):
        for k in cfg["events"]:
            if k in saved["events"]:
                cfg["events"][k] = bool(saved["events"][k])
    cfg["targets"] = _normalize_targets(saved.get("targets"))
    if isinstance(saved.get("template"), dict):
        for k in ("title", "body"):
            if k in saved["template"]:
                cfg["template"][k] = str(saved["template"][k] or "")
    if "enabled" in saved:
        cfg["enabled"] = bool(saved.get("enabled"))
    return cfg


def save_cfg(patch):
    """部分更新：只认 enabled / events / targets / template。"""
    cfg = get_cfg()
    if not isinstance(patch, dict):
        return sanitize_cfg(cfg)
    if "enabled" in patch:
        cfg["enabled"] = bool(patch.get("enabled"))
    if isinstance(patch.get("events"), dict):
        for k in cfg["events"]:
            if k in patch["events"]:
                cfg["events"][k] = bool(patch["events"][k])
    if isinstance(patch.get("targets"), dict):
        merged = dict(cfg.get("targets") or {})
        merged.update({ch: patch["targets"][ch] for ch in CHANNELS
                       if ch in patch["targets"]})
        cfg["targets"] = _normalize_targets(merged)
    if isinstance(patch.get("template"), dict):
        for k in ("title", "body"):
            if k in patch["template"]:
                cfg["template"][k] = str(patch["template"][k] or "")
    _write_raw(cfg)
    return sanitize_cfg(get_cfg())


def sanitize_cfg(cfg=None):
    """前端展示用：不带任何密钥（账号密钥在「通知渠道」里），顺带给出 channels 开关表。"""
    cfg = json.loads(json.dumps(cfg or get_cfg()))
    t = cfg.get("targets") or {}
    cfg["channels"] = {ch: bool(t.get(ch)) for ch in CHANNELS}
    return cfg


# ---------------------------------------------------------------- 文案
def _fmt_size(n):
    try:
        n = float(n or 0)
    except (TypeError, ValueError):
        n = 0
    if n <= 0:
        return "-"
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024 or unit == "TB":
            return ("%.0f %s" % (n, unit)) if unit == "B" else ("%.1f %s" % (n, unit))
        n /= 1024.0
    return "-"


def _render(tpl, vars_):
    out = str(tpl or "")
    for k, v in (vars_ or {}).items():
        out = out.replace("{" + k + "}", str(v))
    return out


def _vars_of(task, status):
    now = time.localtime()
    return {
        "name": str((task or {}).get("name") or "下载任务"),
        "event": _EVENT_NAMES.get(status, status or ""),
        "status": status or "",
        "size": _fmt_size((task or {}).get("size")),
        "error": str((task or {}).get("error") or ""),
        "date": time.strftime("%Y-%m-%d", now),
        "time": time.strftime("%H:%M", now),
    }


# ---------------------------------------------------------------- 发送
def send(title, body, event="", meta=None):
    """按勾选的账号逐个发送；返回 {"ok":bool,"results":{渠道:{...}}}。"""
    cfg = get_cfg()
    out = {"ok": False, "results": {}}
    if not cfg.get("enabled"):
        out["skipped"] = "disabled"
        return out
    if event and not (cfg.get("events") or {}).get(event, True):
        out["skipped"] = "event-off"
        return out

    from ..ide import cronnotify                       # 延迟导入，避免循环依赖

    targets = cfg.get("targets") or {}
    send_meta = dict(meta or {})
    any_ok = False
    for ch in CHANNELS:
        ids = targets.get(ch) or []
        if not ids:
            continue
        accounts = notify_channels.accounts_of(ch, ids)
        if not accounts:
            continue
        subs = []
        for acc in accounts:
            try:
                ok, detail = cronnotify.send_with_account(ch, acc, title, body, send_meta)
            except Exception as e:                     # noqa: BLE001
                ok, detail = False, str(e)
            subs.append({"id": acc.get("id"), "name": acc.get("name") or "",
                         "ok": bool(ok), "detail": str(detail or "")[:300]})
            any_ok = any_ok or bool(ok)
            if ok:
                _log.info("[dl-notify/%s] %s (%s)", ch, title[:60], acc.get("name") or "")
            else:
                _log.warning("[dl-notify/%s] failed: %s", ch, detail)
        out["results"][ch] = {
            "ok": any(s["ok"] for s in subs),
            "detail": "；".join("%s：%s" % (s["name"] or s["id"],
                                           "已发送" if s["ok"] else s["detail"])
                                for s in subs)[:600],
            "accounts": subs,
        }
    out["ok"] = any_ok

    try:
        rec = {"source": "download", "title": title, "body": body,
               "ts": int(time.time()), "channels": out["results"]}
        for k in ("task_id", "task_name", "status"):
            v = send_meta.get(k)
            if v:
                rec[k] = v
        notifications.append_history(rec)
    except Exception:                                  # noqa: BLE001
        pass
    return out


def on_task(tid, status):
    """任务状态变成 done / failed 时调用（内部会判断开关、事件、去重）。"""
    try:
        cfg = get_cfg()
        if not cfg.get("enabled"):
            return
        if not (cfg.get("events") or {}).get(status, True):
            return
        key = "%s:%s" % (tid, status)
        now = time.time()
        with _SENT_LOCK:
            last = _SENT.get(key)
            if last and now - last < _SENT_WINDOW:
                return
            _SENT[key] = now
            if len(_SENT) > _SENT_MAX:
                for k, ts in list(_SENT.items()):
                    if now - ts > _SENT_WINDOW:
                        _SENT.pop(k, None)
        from . import downloads                         # 延迟导入，避免循环依赖
        task = downloads.get(tid)
        if not task:
            return
        # 手动取消不算失败，不打扰
        if str(task.get("status") or "") == "canceled":
            return
        vars_ = _vars_of(task, status)
        tpl = cfg.get("template") or {}
        title = _render(tpl.get("title") or "{name}", vars_) or vars_["name"]
        body = _render(tpl.get("body") or "", vars_).strip()
        if not body:
            body = "任务「%s」%s。" % (vars_["name"], vars_["event"])
        send(title, body, event=status,
             meta={"task_id": tid, "task_name": vars_["name"], "status": status})
    except Exception:                                  # noqa: BLE001
        _log.exception("下载通知发送失败（%s / %s）", tid, status)


def fire(tid, status):
    """在后台线程里跑 on_task，绝不阻塞下载流程。"""
    def _job():
        try:
            on_task(tid, status)
        except Exception:                              # noqa: BLE001
            _log.exception("下载通知线程异常")
    threading.Thread(target=_job, daemon=True, name="dl-notify").start()


def test(channel="all"):
    """发一条测试通知（忽略总开关与事件开关）；channel: 渠道名或 all。"""
    ch = (channel or "all").strip().lower()
    title = "下载通知测试 · File_Flask"
    body = "这是一条来自 File_Flask 下载中心的测试通知。若收到，说明账号配置正确。"
    cfg = get_cfg()
    targets = cfg.get("targets") or {}
    from ..ide import cronnotify

    out = {}
    chans = CHANNELS if ch in ("all", "") else (ch,)
    for c in chans:
        if c not in CHANNELS:
            continue
        accounts = notify_channels.accounts_of(c, targets.get(c) or [])
        if not accounts:
            continue
        subs = []
        for acc in accounts:
            try:
                ok, detail = cronnotify.send_with_account(c, acc, title, body, {})
            except Exception as e:                     # noqa: BLE001
                ok, detail = False, str(e)
            subs.append({"id": acc.get("id"), "name": acc.get("name") or "",
                         "ok": bool(ok), "detail": str(detail or "")[:300]})
        out[c] = {"ok": any(s["ok"] for s in subs),
                  "detail": "；".join("%s：%s" % (s["name"] or s["id"],
                                                 "已发送" if s["ok"] else s["detail"])
                                      for s in subs)[:600],
                  "accounts": subs}
    try:
        notifications.append_history({"source": "download", "title": title, "body": body,
                                      "ts": int(time.time()), "channels": out,
                                      "status": "test"})
    except Exception:                                  # noqa: BLE001
        pass
    return {"ok": any(v.get("ok") for v in out.values()), "results": out}


def history(limit=30):
    """下载通知历史（source == "download"），新的在前。"""
    try:
        d = notifications.read_latest(0)
    except Exception:                                  # noqa: BLE001
        return []
    out = []
    for r in (d.get("history") or []):
        if str(r.get("source") or "") != "download":
            continue
        out.append(r)
        if len(out) >= max(1, int(limit or 30)):
            break
    return out

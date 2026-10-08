"""定时任务通知：任务失败 / 超时 / 安排重试时向配置的渠道推送消息。

支持的渠道（可多选）：
  desktop   系统级桌面通知（复用 services/common/notifications 的桌面通知）
  email     SMTP 邮件（复用全局通知的 SMTP 配置：设置 → 通知 里填的邮箱）
  telegram  Telegram Bot（复用全局通知的 Bot 配置）
  dingtalk  钉钉群机器人 Webhook（本模块独立配置，支持加签安全设置）
  pushplus  PushPlus 微信推送（本模块独立配置，一对 one 推送 token）

配置存 store.db 的 cron_cfg 表（键 notify，JSON 结构），由
「定时任务管理 → 通知设置」弹窗维护；测试按钮可对单个渠道发一条测试消息。

统一接口：
    cronnotify.send(title, body, event="fail")   # 按配置推送（event: fail/timeout/retry）
    cronnotify.test(channel)                     # 对单个渠道发测试消息
任何异常都不会抛，只记日志并返回各渠道的发送结果。
"""
import base64
import hashlib
import hmac
import json
import time
import urllib.parse
import urllib.request

from ...log import get_logger
from ..common import notifications
from . import crondb

_log = get_logger()

_HTTP_TIMEOUT = 10                                  # 钉钉 / PushPlus 请求超时（秒）

# 需要脱敏的配置路径（读取时替换为掩码，保存时收到掩码则跳过更新）
_SECRET_PATHS = (("dingtalk", "secret"), ("dingtalk", "webhook"), ("pushplus", "token"))
_MASK = "******"

DEFAULT_CFG = {
    "enabled": False,                               # 总开关
    "events": {                                     # 哪些事件触发通知
        "fail": True,                               # 执行失败
        "timeout": True,                            # 执行超时
        "retry": False,                             # 安排了失败重试
    },
    "channels": {                                   # 启用哪些渠道
        "desktop": True,
        "email": False,
        "dingtalk": False,
        "telegram": False,
        "pushplus": False,
    },
    "dingtalk": {
        "webhook": "",                              # 机器人 Webhook 地址（含 access_token）
        "secret": "",                               # 加签密钥（SEC 开头；留空 = 不加签）
    },
    "pushplus": {
        "token": "",                                # PushPlus 的 token（www.pushplus.plus）
        "topic": "",                                # 群组编码（留空 = 发给自己）
    },
}

_CHANNELS = ("desktop", "email", "dingtalk", "telegram", "pushplus")
_EVENTS = ("fail", "timeout", "retry")


# ---------------------------------------------------------------- 配置读写
def _merge_dict(base, patch, key):
    if isinstance((patch or {}).get(key), dict):
        base.setdefault(key, {}).update(patch[key])


def get_cfg():
    """读取配置（深拷贝默认值后合并已保存项，缺失字段自动补齐）。"""
    cfg = json.loads(json.dumps(DEFAULT_CFG))
    saved = crondb.get_setting("notify")
    if isinstance(saved, dict):
        _merge_dict(cfg, saved, "events")
        _merge_dict(cfg, saved, "channels")
        _merge_dict(cfg, saved, "dingtalk")
        _merge_dict(cfg, saved, "pushplus")
        if "enabled" in saved:
            cfg["enabled"] = bool(saved.get("enabled"))
    return cfg


def save_cfg(patch):
    """合并保存配置（掩码字段跳过）；返回脱敏后的最新配置。"""
    cfg = get_cfg()
    if not isinstance(patch, dict):
        return sanitize_cfg(cfg)
    if "enabled" in patch:
        cfg["enabled"] = bool(patch.get("enabled"))
    for key in ("events", "channels"):
        if isinstance(patch.get(key), dict):
            for k, v in patch[key].items():
                if k in (cfg.get(key) or {}):
                    cfg[key][k] = bool(v)
    for key in ("dingtalk", "pushplus"):
        if isinstance(patch.get(key), dict):
            for k, v in patch[key].items():
                if k in (cfg.get(key) or {}) and v != _MASK:
                    cfg[key][k] = str(v or "").strip()
    crondb.set_setting("notify", cfg)
    return sanitize_cfg(get_cfg())


def sanitize_cfg(cfg=None):
    """脱敏：密钥类字段替换为 ******（前端展示用）。"""
    cfg = json.loads(json.dumps(cfg or get_cfg()))
    for grp, key in _SECRET_PATHS:
        if cfg.get(grp, {}).get(key):
            cfg[grp][key] = _MASK
    return cfg


# ---------------------------------------------------------------- 发送通道
def _post_json(url, payload):
    """POST 一段 JSON，返回 (ok, detail)。失败不抛。"""
    try:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(url, data=data, method="POST",
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=_HTTP_TIMEOUT) as resp:
            body = resp.read().decode("utf-8", "replace")
        try:
            res = json.loads(body)
        except ValueError:
            res = {"raw": body[:200]}
        return True, res
    except Exception as e:                              # noqa: BLE001
        return False, str(e)


def _dingtalk_sign(secret):
    """钉钉加签：timestamp + "\n" + secret 做 HmacSHA256 再 base64。"""
    ts = str(round(time.time() * 1000))
    string_to_sign = "%s\n%s" % (ts, secret)
    sign = base64.b64encode(
        hmac.new(secret.encode("utf-8"), string_to_sign.encode("utf-8"), hashlib.sha256).digest())
    return ts, urllib.parse.quote_plus(sign)


def _send_dingtalk(cfg, title, body):
    ding = cfg.get("dingtalk") or {}
    webhook = str(ding.get("webhook") or "").strip()
    if not webhook:
        return False, "钉钉未配置 Webhook 地址"
    secret = str(ding.get("secret") or "").strip()
    if secret:
        ts, sign = _dingtalk_sign(secret)
        sep = "&" if "?" in webhook else "?"
        webhook = "%s%stimestamp=%s&sign=%s" % (webhook, sep, ts, sign)
    text = title + "\n" + body
    ok, res = _post_json(webhook, {"msgtype": "text", "text": {"content": text[:18000]}})
    if ok and isinstance(res, dict) and res.get("errcode") not in (0, "0"):
        return False, "钉钉返回错误：%s" % (res.get("errmsg") or res)
    return ok, ("已发送" if ok else res)


def _send_pushplus(cfg, title, body):
    pp = cfg.get("pushplus") or {}
    token = str(pp.get("token") or "").strip()
    if not token:
        return False, "PushPlus 未配置 token"
    payload = {"token": token, "title": title[:100], "content": body,
               "template": "txt"}
    topic = str(pp.get("topic") or "").strip()
    if topic:
        payload["topic"] = topic
    ok, res = _post_json("http://www.pushplus.plus/send", payload)
    if ok and isinstance(res, dict) and res.get("code") not in (200, "200"):
        return False, "PushPlus 返回错误：%s" % (res.get("msg") or res)
    return ok, ("已发送" if ok else res)


# ---------------------------------------------------------------- 统一入口
def _send_one(cfg, channel, title, body):
    """向单个渠道发一条；返回 {ok, detail}。"""
    try:
        if channel == "desktop":
            r = notifications.notify_desktop(title, body)
            return bool(getattr(r, "ok", False)), str(getattr(r, "detail", "") or "已发送")
        if channel == "email":
            r = notifications.notify_smtp(title, body)
            return bool(getattr(r, "ok", False)), str(getattr(r, "detail", "") or "已发送")
        if channel == "telegram":
            r = notifications.notify_telegram(title, body)
            return bool(getattr(r, "ok", False)), str(getattr(r, "detail", "") or "已发送")
        if channel == "dingtalk":
            return _send_dingtalk(cfg, title, body)
        if channel == "pushplus":
            return _send_pushplus(cfg, title, body)
        return False, "未知渠道：%s" % channel
    except Exception as e:                              # noqa: BLE001
        _log.warning("定时任务通知（%s）发送异常：%s", channel, e)
        return False, str(e)


def send(title, body, event="fail", source="cron"):
    """按配置推送一次通知；返回 {"results": {渠道: {ok, detail}}}。

    event: fail / timeout / retry —— 决定受哪个事件开关控制；
    总开关未开、该事件未勾选、或该渠道未启用时对应渠道会被跳过。
    """
    cfg = get_cfg()
    results = {"enabled": bool(cfg.get("enabled")),
               "event": event, "results": {}}
    events = cfg.get("events") or {}
    if not cfg.get("enabled"):
        results["skipped"] = "disabled"
        return results
    if not events.get(event, True):
        results["skipped"] = "event-off"
        return results
    channels = cfg.get("channels") or {}
    for ch in _CHANNELS:
        if not channels.get(ch):
            continue
        ok, detail = _send_one(cfg, ch, title, body)
        results["results"][ch] = {"ok": bool(ok), "detail": detail}
    try:                                                # 写进全局通知历史，供标题栏查看
        notifications.append_history({"source": source, "title": title, "body": body,
                                      "ts": int(time.time()), "channels": list(results["results"])})
    except Exception:                                   # noqa: BLE001
        pass
    return results


def test(channel):
    """对单个渠道发一条测试消息（忽略总开关）；channel: 渠道名或 "all"。"""
    ch = (channel or "all").strip().lower()
    cfg = get_cfg()
    title = "定时任务通知测试"
    body = "这是一条来自 File_Flask 定时任务模块的测试通知。若收到，说明该渠道配置正确。"
    out = {}
    targets = _CHANNELS if ch in ("all", "") else [ch]
    for t in targets:
        if t not in _CHANNELS:
            continue
        ok, detail = _send_one(cfg, t, title, body)
        out[t] = {"ok": bool(ok), "detail": detail}
    return out

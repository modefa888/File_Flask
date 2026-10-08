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
import re
import time
import urllib.parse
import urllib.request

from ...log import get_logger
from ..common import notifications
from . import crondb

_log = get_logger()

_HTTP_TIMEOUT = 10                                  # 钉钉 / PushPlus 请求超时（秒）

# 需要脱敏的配置路径（读取时替换为掩码，保存时收到掩码则跳过更新）
_SECRET_PATHS = (("dingtalk", "secret"), ("dingtalk", "webhook"), ("pushplus", "token"),
                 ("email", "password"), ("telegram", "bot_token"))
_MASK = "******"

DEFAULT_CFG = {
    "enabled": False,                               # 总开关
    "events": {                                     # 哪些事件触发通知
        "fail": True,                               # 执行失败
        "timeout": True,                            # 执行超时
        "retry": False,                             # 安排了失败重试
        "success": False,                           # 执行成功（默认关，开启后每次成功都会推送并留记录）
    },
    "channels": {                                   # 启用哪些渠道
        "desktop": True,
        "email": False,
        "dingtalk": False,
        "telegram": False,
        "pushplus": False,
    },
    # desktop / email / telegram 的「判断字段」use_global：
    # True = 复用「设置 → 通知」的全局通道配置；False = 用本模块独立填写的配置
    "desktop": {
        "use_global": True,
        "app_name": "",                             # 独立配置：通知中心显示的应用名（留空 = File_Flask）
        "sound": True,                              # 独立配置：是否播放提示音
    },
    "email": {
        "use_global": True,
        "host": "", "port": 465, "security": "ssl",  # 独立配置：SMTP 服务器 / 端口 / 加密方式
        "username": "", "password": "",              # 独立配置：账号与授权码
        "from_addr": "",                             # 独立配置：发件人地址（留空 = 用户名）
        "to": "",                                    # 独立配置：收件人（多个逗号分隔）
    },
    "telegram": {
        "use_global": True,
        "bot_token": "",                             # 独立配置：Bot Token
        "chat_id": "",                               # 独立配置：会话 ID
        "api_base": "https://api.telegram.org",      # 独立配置：API 地址（可填自建 / 反代）
        "proxy": "",                                 # 独立配置：代理（留空 = 直连）
    },
    "dingtalk": {
        "webhook": "",                              # 机器人 Webhook 地址（含 access_token）
        "secret": "",                               # 加签密钥（SEC 开头；留空 = 不加签）
    },
    "pushplus": {
        "token": "",                                # PushPlus 的 token（www.pushplus.plus）
        "topic": "",                                # 群组编码（留空 = 发给自己）
    },
    # 通知模板：变量 {task} {event} {exit} {duration} {attempt} {run} {date} {time}
    # 标题与正文都清空时回退到 cronsvc 传入的默认文案
    "template": {
        "title": "定时任务{event} · {task}",
        "body": "任务「{task}」{event}。\n退出码：{exit}\n耗时：{duration}\n时间：{date} {time}\n执行记录：{run}",
    },
}

# 事件名（模板 {event} 变量用）
_EVENT_NAMES = {"fail": "执行失败", "timeout": "执行超时", "retry": "安排重试", "success": "执行成功"}

_CHANNELS = ("desktop", "email", "dingtalk", "telegram", "pushplus")
_EVENTS = ("fail", "timeout", "retry", "success")


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
        _merge_dict(cfg, saved, "desktop")
        _merge_dict(cfg, saved, "email")
        _merge_dict(cfg, saved, "telegram")
        _merge_dict(cfg, saved, "dingtalk")
        _merge_dict(cfg, saved, "pushplus")
        _merge_dict(cfg, saved, "template")
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
    for key in ("desktop", "email", "telegram", "dingtalk", "pushplus"):
        if isinstance(patch.get(key), dict):
            for k, v in patch[key].items():
                if k not in (cfg.get(key) or {}):
                    continue
                if k == "use_global":
                    cfg[key][k] = bool(v)           # 判断字段：复用全局 / 独立配置
                elif k == "port":
                    try:
                        cfg[key][k] = max(1, int(v or 465))
                    except (TypeError, ValueError):
                        cfg[key][k] = 465
                elif v != _MASK:                    # 掩码 = 未修改，跳过不覆盖
                    cfg[key][k] = str(v or "").strip()
    if isinstance(patch.get("template"), dict):
        tpl = cfg.setdefault("template", {})
        for k in ("title", "body"):
            if k in patch["template"]:
                tpl[k] = str(patch["template"][k] or "").strip()
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
    """向单个渠道发一条；返回 {ok, detail}。

    desktop / email / telegram 按各自的 use_global 判断字段决定：
    True 复用「设置 → 通知」的全局配置，False 用本模块独立配置。
    """
    try:
        if channel == "desktop":
            d = cfg.get("desktop") or {}
            r = (notifications.notify_desktop(title, body) if d.get("use_global", True)
                 else notifications.notify_desktop(title, body, desk_cfg=d))
            return bool(getattr(r, "ok", False)), str(getattr(r, "detail", "") or "已发送")
        if channel == "email":
            e_ = cfg.get("email") or {}
            r = (notifications.notify_smtp(title, body) if e_.get("use_global", True)
                 else notifications.notify_smtp(title, body, smtp_cfg=e_))
            return bool(getattr(r, "ok", False)), str(getattr(r, "detail", "") or "已发送")
        if channel == "telegram":
            t = cfg.get("telegram") or {}
            r = (notifications.notify_telegram(title, body) if t.get("use_global", True)
                 else notifications.notify_telegram(title, body, tg_cfg=t))
            return bool(getattr(r, "ok", False)), str(getattr(r, "detail", "") or "已发送")
        if channel == "dingtalk":
            return _send_dingtalk(cfg, title, body)
        if channel == "pushplus":
            return _send_pushplus(cfg, title, body)
        return False, "未知渠道：%s" % channel
    except Exception as e:                              # noqa: BLE001
        _log.warning("定时任务通知（%s）发送异常：%s", channel, e)
        return False, str(e)


def _render_tpl(tpl, vars_):
    """渲染模板：{var} 用 vars_ 里的值替换，未知变量原样保留。"""
    def _sub(m):
        key = m.group(1)
        return str(vars_[key]) if key in vars_ else m.group(0)
    return re.sub(r"\{([A-Za-z_][A-Za-z0-9_]*)\}", _sub, str(tpl or ""))


def send(title, body, event="fail", source="cron", vars_=None):
    """按配置推送一次通知；返回 {"results": {渠道: {ok, detail}}}。

    event: fail / timeout / retry —— 决定受哪个事件开关控制；
    vars_: 模板变量（task / event / exit / duration / attempt / run / date / time），
    配置了通知模板时用模板渲染标题与正文，否则用调用方传入的默认文案；
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
    # 模板渲染（模板里两个都清空时用调用方的默认文案）
    tpl = cfg.get("template") or {}
    vars_ = dict(vars_ or {})
    vars_.setdefault("event", _EVENT_NAMES.get(event, event))
    vars_.setdefault("date", time.strftime("%Y-%m-%d"))
    vars_.setdefault("time", time.strftime("%H:%M"))
    if str(tpl.get("title") or "").strip():
        title = _render_tpl(tpl["title"], vars_)
    if str(tpl.get("body") or "").strip():
        body = _render_tpl(tpl["body"], vars_)
    channels = cfg.get("channels") or {}
    for ch in _CHANNELS:
        if not channels.get(ch):
            continue
        ok, detail = _send_one(cfg, ch, title, body)
        results["results"][ch] = {"ok": bool(ok), "detail": detail}
    try:                                                # 写进通知历史（本分区按 source 过滤展示）
        notifications.append_history({"source": source, "title": title, "body": body,
                                      "ts": int(time.time()), "channels": results["results"]})
    except Exception:                                   # noqa: BLE001
        pass
    return results


def history(limit=50):
    """读取定时任务触发的通知记录（按 source == "cron" 过滤，新的在前）。"""
    try:
        d = notifications.read_latest(0)
    except Exception:                                   # noqa: BLE001
        return []
    out = []
    for r in (d.get("history") or []):
        if str(r.get("source") or "") == "cron":
            out.append(r)
            if len(out) >= max(1, int(limit or 50)):
                break
    return out


def test(channel):
    """对单个渠道发一条测试消息（忽略总开关）；channel: 渠道名或 "all"。

    测试结果同样写入通知历史（source="cron"），在「定时任务通知 → 通知记录」可见。
    """
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
    try:                                                # 测试也留记录，便于确认渠道是否真的通了
        notifications.append_history({"source": "cron", "title": title, "body": body,
                                      "ts": int(time.time()), "channels": out})
    except Exception:                                   # noqa: BLE001
        pass
    return out

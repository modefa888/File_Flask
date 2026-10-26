"""定时任务通知：任务失败 / 超时 / 安排重试时向配置的渠道推送消息。

支持的渠道（可多选）：
  desktop   系统级桌面通知（复用 services/common/notifications 的桌面通知）
  email     SMTP 邮件（复用全局通知的 SMTP 配置：设置 → 通知 里填的邮箱）
  telegram  Telegram Bot（复用全局通知的 Bot 配置）
  dingtalk  钉钉群机器人 Webhook（本模块独立配置，支持加签安全设置）
  pushplus  PushPlus 微信推送（本模块独立配置，一对 one 推送 token）
  web       网页版：把通知写进本地库，生成 Markdown 渲染页（地址按任务唯一，默认保留 7 天）

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
        "web": False,
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
    # 网页版：写库 + 生成渲染页；地址 = base_url + /n/<任务令牌>
    "web": {
        "base_url": "",                             # 站点地址（如 http://192.168.1.10:5001）；留空自动推断
        "retention_days": 7,                        # 每条通知保留天数（到期假删除）
        "link_enabled": True,                       # 其它渠道正文末尾是否附加「网页通知」入口
        "link_text": "网页通知",                     # 入口文字（纯文字渠道会连同地址一起显示）
        "link_url": "",                             # 固定跳转地址（留空 = 该任务自己的 /n/<令牌> 页面）
    },
    # 通知模板：变量 {task} {event} {exit} {duration} {attempt} {run} {date} {time} {output}
    # {output} = 脚本输出（末尾若干行，由任务里的「通知内容」决定是否带入）
    # 标题与正文都清空时回退到 cronsvc 传入的默认文案
    "template": {
        "title": "定时任务{event} · {task}",
        "body": "任务「{task}」{event}。\n退出码：{exit}\n耗时：{duration}\n时间：{date} {time}\n执行记录：{run}",
    },
}

# 事件名（模板 {event} 变量用）
_EVENT_NAMES = {"fail": "执行失败", "timeout": "执行超时", "retry": "安排重试", "success": "执行成功"}

_CHANNELS = ("desktop", "email", "dingtalk", "telegram", "pushplus", "web")
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
        _merge_dict(cfg, saved, "web")
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
    for key in ("desktop", "email", "telegram", "dingtalk", "pushplus", "web"):
        if isinstance(patch.get(key), dict):
            for k, v in patch[key].items():
                if k not in (cfg.get(key) or {}):
                    continue
                if k == "use_global":
                    cfg[key][k] = bool(v)           # 判断字段：复用全局 / 独立配置
                elif k == "retention_days":
                    try:
                        cfg[key][k] = max(1, min(int(v or 7), 365))
                    except (TypeError, ValueError):
                        cfg[key][k] = 7
                elif k == "link_enabled":
                    cfg[key][k] = bool(v)
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


# ---------------------------------------------------------------- 网页版（写库 + 渲染页地址）
def _local_ip():
    """尽力取本机局域网 IP（仅用于拼出可点的通知地址）。"""
    import socket
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect(("8.8.8.8", 80))
            return s.getsockname()[0]
        finally:
            s.close()
    except Exception:                                   # noqa: BLE001
        return "127.0.0.1"


def web_base(cfg=None):
    """网页通知的站点根地址：配置里的 base_url > 当前请求的 host > 本机 IP:PORT。"""
    cfg = cfg or get_cfg()
    base = str((cfg.get("web") or {}).get("base_url") or "").strip().rstrip("/")
    if base:
        return base
    try:
        from flask import has_request_context, request
        if has_request_context():
            return request.host_url.rstrip("/")
    except Exception:                                   # noqa: BLE001
        pass
    from ... import config
    try:
        port = int(getattr(config, "PORT", 5001) or 5001)
    except (TypeError, ValueError):
        port = 5001
    return "http://%s:%s" % (_local_ip(), port)


def web_url(token, cfg=None):
    """某个令牌对应的网页地址（/n/<token>）。"""
    return "%s/n/%s" % (web_base(cfg), str(token or "").strip())


def _send_web(cfg, title, body, meta=None):
    """网页版：把标题 + Markdown 正文写库，返回可访问的地址。"""
    meta = meta or {}
    tid = str(meta.get("task_id") or "").strip()
    token = crondb.ensure_web_token(tid) if tid else "test"
    days = (cfg.get("web") or {}).get("retention_days") or 7
    crondb.add_web_note(token, title, body, task_id=tid,
                        task_name=str(meta.get("task_name") or ""),
                        run_id=str(meta.get("run_id") or ""),
                        status=str(meta.get("event") or ""), days=days)
    return True, "已生成：%s" % web_url(token, cfg)


# ---------------------------------------------------------------- 统一入口
def _send_one(cfg, channel, title, body, meta=None):
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
        if channel == "web":
            return _send_web(cfg, title, body, meta)
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


def _url_of(text):
    """从「已生成：http://…」这类描述里抠出地址。"""
    m = re.search(r"https?://[^\s\"'<>]+", str(text or ""))
    return m.group(0) if m else ""


def _web_link_foot(cfg, url):
    """给其它渠道正文末尾追加的网页通知入口（纯文本）。

    · link_enabled=False 时完全不追加；
    · 文字取 link_text（默认「网页通知」）；
    · 跳转地址取 link_url（固定的统一入口），留空则跳该任务自己的 /n/<令牌> 页面。
    钉钉 / Telegram / PushPlus / 邮件都按纯文本发送，做不了真正的按钮，
    所以是「文字 + 下一行裸地址」：这些客户端会把 URL 自动识别成可点链接。
    """
    w = cfg.get("web") or {}
    if not w.get("link_enabled", True):
        return ""
    try:
        days = int(w.get("retention_days") or 7)
    except (TypeError, ValueError):
        days = 7
    text = str(w.get("link_text") or "").strip()[:40] or "网页通知"
    target = str(w.get("link_url") or "").strip() or url
    return ("\n\n━━━━━━━━━━━━━━\n"
            "🔗 %s（排版更完整 · 保留 %d 天）\n%s" % (text, days, target))


def send(title, body, event="fail", source="cron", vars_=None, tpl=None, channels=None,
         meta=None):
    """按配置推送一次通知；返回 {"results": {渠道: {ok, detail}}}。

    event: fail / timeout / retry / success —— 决定受哪个事件开关控制；
    vars_: 模板变量（task / event / exit / duration / attempt / run / date / time / output），
    tpl:   任务级模板 {"title","body"}，非空字段优先于全局模板（留空则回退全局）；
           tpl["raw_body"]=True 时 body 已是最终文本（如已拼好脚本输出），不再做变量渲染；
    channels: 任务级渠道（数组或逗号串，空 = 跟随全局「通知设置」里已启用的渠道）；
           只会在全局已启用的渠道里取交集，任务里选了但全局关掉的渠道不会发送；
    meta:  关联信息 {"task_id","run_id","task_name"}，随记录一起写入通知历史，
           供「执行记录 → 通知记录」按某一次执行过滤展示；
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
    # 模板渲染（任务级模板优先；两个都清空时用调用方的默认文案）
    gtpl = cfg.get("template") or {}
    ttpl = tpl if isinstance(tpl, dict) else {}
    raw_body = bool(ttpl.get("raw_body"))              # 正文已渲染好（如已拼好脚本输出）
    use_title = str(ttpl.get("title") or "").strip() or str(gtpl.get("title") or "").strip()
    use_body = (str(ttpl.get("body") or "") if raw_body
                else (str(ttpl.get("body") or "").strip() or str(gtpl.get("body") or "").strip()))
    vars_ = dict(vars_ or {})
    vars_.setdefault("event", _EVENT_NAMES.get(event, event))
    vars_.setdefault("date", time.strftime("%Y-%m-%d"))
    vars_.setdefault("time", time.strftime("%H:%M"))
    vars_.setdefault("output", "")                       # 未附带脚本输出时占位，避免模板里留着 {output}
    if use_title:
        title = _render_tpl(use_title, vars_)
    if use_body:
        body = use_body if raw_body else _render_tpl(use_body, vars_)
    enabled = cfg.get("channels") or {}
    targets = [ch for ch in _CHANNELS if enabled.get(ch)]
    wanted = crondb.norm_channels(channels)                # 任务级渠道（空 = 全局已启用的全部）
    if wanted:
        picked = set(wanted.split(","))
        targets = [ch for ch in targets if ch in picked]   # 取交集：全局没启用的发不出去
        results["channels"] = wanted
    send_meta = dict(meta or {})
    send_meta["event"] = event
    # 网页版先发：拿到地址后才能给其它渠道的正文末尾追加「前往网页版通知」
    web_url, web_res = "", None
    if "web" in targets:
        ok, detail = _send_one(cfg, "web", title, body, send_meta)
        web_res = {"ok": bool(ok), "detail": detail}
        if ok:
            web_url = _url_of(detail)
        targets = [ch for ch in targets if ch != "web"]
    foot = _web_link_foot(cfg, web_url) if web_url else ""
    for ch in targets:
        ok, detail = _send_one(cfg, ch, title, body + foot, send_meta)
        results["results"][ch] = {"ok": bool(ok), "detail": detail}
    if web_res is not None:
        results["results"]["web"] = web_res              # 放最后，保持渠道展示顺序稳定
    # 记录里也带上网页地址：浏览器通知弹窗、通知记录展开的正文都读这里
    rec_body = (body + foot) if foot else body
    results["body"] = rec_body                            # 供 cronsvc 写执行记录旁的通知记录
    rec = {"source": source, "title": title, "body": rec_body,
           "ts": int(time.time()), "channels": results["results"], "event": event}
    if isinstance(meta, dict):                          # 关联到具体任务 / 执行记录
        for k in ("task_id", "run_id", "task_name"):
            v = str(meta.get(k) or "").strip()
            if v:
                rec[k] = v
    try:                                                # 写进通知历史（本分区按 source 过滤展示）
        notifications.append_history(rec)
    except Exception:                                   # noqa: BLE001
        pass
    return results


def history(limit=50, run_id=None, task_id=None):
    """读取定时任务触发的通知记录（按 source == "cron" 过滤，新的在前）。

    run_id / task_id 非空时只返回关联到该次执行 / 该任务的记录，
    供「执行记录」抽屉里展示"这一次执行发了哪些通知"。
    """
    rid = str(run_id or "").strip()
    tid = str(task_id or "").strip()
    try:
        d = notifications.read_latest(0)
    except Exception:                                   # noqa: BLE001
        return []
    out = []
    for r in (d.get("history") or []):
        if str(r.get("source") or "") != "cron":
            continue
        if rid and str(r.get("run_id") or "") != rid:
            continue
        if tid and str(r.get("task_id") or "") != tid:
            continue
        out.append(r)
        if len(out) >= max(1, int(limit or 50)):
            break
    return out


def clear_history() -> int:
    """清空定时任务触发的通知记录（仅删 source == "cron"）；返回被清掉的条数。"""
    return notifications.clear_recent(source="cron")


def count(run_id=None, task_id=None) -> int:
    """定时任务触发的通知记录总数（可只统计某次执行 / 某个任务）。"""
    try:
        d = notifications.read_latest(0)
    except Exception:                                   # noqa: BLE001
        return 0
    rid = str(run_id or "").strip()
    tid = str(task_id or "").strip()
    n = 0
    for r in (d.get("history") or []):
        if str(r.get("source") or "") != "cron":
            continue
        if rid and str(r.get("run_id") or "") != rid:
            continue
        if tid and str(r.get("task_id") or "") != tid:
            continue
        n += 1
    return n


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

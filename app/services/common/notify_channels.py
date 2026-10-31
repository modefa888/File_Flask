"""通知渠道账号（设置 → 通知渠道）。

一个渠道可以配置**多个账号**，例如两个不同的邮箱、多个 Telegram 群、多个钉钉机器人。
「通知」（AI）与「定时任务通知」两个模块只负责**勾选账号**，不再各自维护渠道参数。

存储：store.db 的 notify_accounts 表（一行一个账号）
    id         账号 id（channel-xxxxxxxx）
    channel    desktop / email / telegram / dingtalk / pushplus / web
    name       显示名（如「QQ 邮箱」「运维群」）
    cfg        账号配置 JSON（密码 / token 等密钥字段密文落库）
    sort       同渠道内的排序

旧配置（notify_cfg 的 smtp/telegram/desktop + cron_cfg.notify 的 dingtalk/pushplus/web）
会在首次读取时一次性迁移成一个「默认账号」，并把对应的 targets 写回两个通知配置，
用户升级后不需要重新填一遍。
"""
import json
import time
import uuid

from ...log import get_logger
from . import notifications, secret
from .store_db import store_conn, store_tx

_log = get_logger()

# 渠道顺序即前端分组顺序
CHANNELS = ("desktop", "email", "telegram", "dingtalk", "pushplus", "web")

CHANNEL_NAMES = {
    "desktop": "浏览器 / 桌面通知",
    "email": "邮件（SMTP）",
    "telegram": "Telegram",
    "dingtalk": "钉钉机器人",
    "pushplus": "PushPlus",
    "web": "网页版",
}

# 每个渠道的默认配置（同时也是允许保存的字段白名单）
DEFAULT_CFG = {
    "desktop": {
        "app_name": "File_Flask",
        "sound": True,
        "sound_name": "",
        "timeout_ms": 5000,
    },
    "email": {
        "host": "", "port": 465, "security": "ssl",
        "username": "", "password": "",
        "from_addr": "", "from_name": "",
        "to": "",
        "subject_prefix": "[File_Flask] ",
    },
    "telegram": {
        "bot_token": "", "chat_id": "", "message_thread_id": "",
        "api_base": "https://api.telegram.org", "proxy": "",
        "disable_notification": False,
    },
    "dingtalk": {"webhook": "", "secret": ""},
    "pushplus": {"token": "", "topic": ""},
    "web": {
        "base_url": "", "retention_days": 7,
        "link_enabled": True, "link_text": "网页通知", "link_url": "",
    },
}

# 需要加密落库 / 脱敏回传的字段
SECRET_FIELDS = {
    "email": ("password",),
    "telegram": ("bot_token",),
    "dingtalk": ("webhook", "secret"),
    "pushplus": ("token",),
}

# 整数 / 布尔字段（其余按字符串处理）
_INT_FIELDS = {"port", "timeout_ms", "retention_days", "message_thread_id"}
_BOOL_FIELDS = {"sound", "disable_notification", "link_enabled"}

_MASK = "******"
_MIGRATE_KEY = "notify.accounts_migrated"


def _now():
    return time.time()


def _rows(sql, args=()):
    conn = store_conn()
    try:
        return [dict(r) for r in conn.execute(sql, args)]
    finally:
        conn.close()


def _new_id(channel):
    return "%s-%s" % (channel, uuid.uuid4().hex[:8])


def _blank(channel):
    return json.loads(json.dumps(DEFAULT_CFG.get(channel) or {}))


def _normalize(channel, raw):
    """只保留白名单字段，并按类型归一化。"""
    base = _blank(channel)
    if not isinstance(raw, dict):
        return base
    for k, default in base.items():
        if k not in raw:
            continue
        v = raw.get(k)
        if k in _BOOL_FIELDS:
            base[k] = bool(v)
        elif k in _INT_FIELDS:
            try:
                base[k] = int(v)
            except (TypeError, ValueError):
                base[k] = default
        else:
            base[k] = "" if v is None else str(v).strip()
    # 派生字段兜底
    if channel == "telegram":
        base["api_base"] = (base.get("api_base") or "https://api.telegram.org").rstrip("/")
        thread = str(base.get("message_thread_id") or "")
        base["message_thread_id"] = thread if thread.isdigit() else ""
    if channel == "email":
        try:
            base["port"] = max(1, int(base.get("port") or 465))
        except (TypeError, ValueError):
            base["port"] = 465
        if base.get("security") not in ("ssl", "tls", "starttls", "none"):
            base["security"] = "ssl"
    if channel == "web":
        base["base_url"] = str(base.get("base_url") or "").rstrip("/")
        try:
            base["retention_days"] = max(1, min(int(base.get("retention_days") or 7), 365))
        except (TypeError, ValueError):
            base["retention_days"] = 7
        base["link_text"] = str(base.get("link_text") or "").strip()[:40]
    return base


def _decode(row):
    """数据库行 → 账号对象（密钥字段解密成明文）。"""
    channel = str(row.get("channel") or "")
    try:
        raw = json.loads(row.get("cfg") or "{}")
    except (TypeError, ValueError):
        raw = {}
    cfg = _normalize(channel, raw)
    for f in SECRET_FIELDS.get(channel, ()):
        if cfg.get(f):
            cfg[f], _rewrite = secret.decrypt_ex(cfg[f])
    return {
        "id": str(row.get("id") or ""),
        "channel": channel,
        "name": str(row.get("name") or ""),
        "cfg": cfg,
        "sort": int(row.get("sort") or 0),
    }


def _encode(channel, cfg):
    data = _normalize(channel, cfg)
    for f in SECRET_FIELDS.get(channel, ()):
        if data.get(f):
            data[f] = secret.encrypt(data[f])
    return json.dumps(data, ensure_ascii=False)


def list_accounts():
    """全部账号（明文配置，内部发送用）：{channel: [account, ...]}"""
    ensure_migrated()
    rows = _rows("SELECT id, channel, name, cfg, sort FROM notify_accounts "
                 "ORDER BY sort, updated_at, id")
    out = {ch: [] for ch in CHANNELS}
    for r in rows:
        acc = _decode(r)
        out.setdefault(acc["channel"], []).append(acc)
    return out


def sanitize_accounts(accounts=None):
    """前端展示用：密钥字段脱敏 + *_set 标志。"""
    accounts = accounts if isinstance(accounts, dict) else list_accounts()
    out = {}
    for ch, items in (accounts or {}).items():
        bucket = []
        for acc in items or []:
            cfg = dict(acc.get("cfg") or {})
            for f in SECRET_FIELDS.get(ch, ()):
                real = str(cfg.get(f) or "")
                cfg[f + "_set"] = bool(real)
                cfg[f] = secret.mask(real) if real else ""
            bucket.append({
                "id": acc.get("id") or "",
                "channel": ch,
                "name": acc.get("name") or "",
                "cfg": cfg,
            })
        out[ch] = bucket
    return out


def accounts_of(channel, ids=None):
    """取某个渠道的账号（明文）。

    ids 为 None  → 该渠道全部账号；
    ids 为 []    → 空（前端明确一个都没勾）；
    ids 为 [..]  → 只返回这些 id，顺序与 ids 一致（已删除的 id 自动跳过）。
    """
    items = list_accounts().get(channel) or []
    if ids is None:
        return items
    want = [str(x) for x in (ids or [])]
    by_id = {a["id"]: a for a in items}
    return [by_id[i] for i in want if i in by_id]


def get_account(channel, account_id):
    for acc in accounts_of(channel):
        if acc["id"] == str(account_id or ""):
            return acc
    return None


def save_accounts(payload):
    """整份保存渠道账号。

    payload = {"channels": {"email": [{"id","name","cfg"} ...], ...}}
    规则：
      · 未出现在提交里的 id 视为删除；
      · 密钥字段回传 ****** 或空 → 保留磁盘旧值（与其它设置页一致）；
      · id 留空 → 自动生成。
    """
    data = payload.get("channels") if isinstance(payload, dict) else None
    if not isinstance(data, dict):
        raise ValueError("channels 必须是对象")

    existing = {}
    for ch in CHANNELS:
        for acc in accounts_of(ch):
            existing[acc["id"]] = acc

    keep_ids = set()
    rows = []
    for ch in CHANNELS:
        items = data.get(ch)
        if not isinstance(items, list):
            continue
        for idx, item in enumerate(items):
            if not isinstance(item, dict):
                continue
            aid = str(item.get("id") or "").strip()
            old = existing.get(aid) if aid else None
            if not aid:
                aid = _new_id(ch)
            if aid in keep_ids:                       # 重复 id：重新生成，避免主键冲突
                aid = _new_id(ch)
            keep_ids.add(aid)
            raw_cfg = item.get("cfg") if isinstance(item.get("cfg"), dict) else item
            cfg = _normalize(ch, raw_cfg)
            # 密钥字段：掩码 / 空 → 沿用旧值
            for f in SECRET_FIELDS.get(ch, ()):
                incoming = str(cfg.get(f) or "")
                old_val = str(((old or {}).get("cfg") or {}).get(f) or "")
                if not incoming or incoming.startswith("•") or _MASK in incoming:
                    cfg[f] = old_val
            rows.append((aid, ch, str(item.get("name") or "").strip()[:60] or _default_name(ch, idx),
                         _encode(ch, cfg), idx, _now()))

    with store_tx() as conn:
        conn.execute("DELETE FROM notify_accounts")
        for r in rows:
            conn.execute(
                "INSERT INTO notify_accounts (id, channel, name, cfg, sort, updated_at) "
                "VALUES (?,?,?,?,?,?)", r)
    return sanitize_accounts(list_accounts())


def _default_name(channel, idx):
    return "%s %d" % (CHANNEL_NAMES.get(channel, channel), (idx or 0) + 1)


# 每个渠道「能真正发出去」必须填的字段（与前端 NOTIFY_CH_DEFS.required 保持一致）
READY_FIELDS = {
    "email": ("to", "host", "username", "password"),
    "telegram": ("bot_token", "chat_id"),
    "dingtalk": ("webhook",),
    "pushplus": ("token",),
}


def is_ready(channel, acc):
    """账号的必填项是否填全；没填全的账号不发消息（前端也不会把它列进可选账号）。"""
    fields = READY_FIELDS.get(channel) or ()
    cfg = (acc or {}).get("cfg") or {}
    for f in fields:
        if not str(cfg.get(f) or "").strip():
            return False
    return True


def send_account(channel, acc, title, body):
    """用某个账号发一条通知（desktop / email / telegram）；返回 (ok, detail)。"""
    cfg = (acc or {}).get("cfg") or {}
    if not is_ready(channel, acc):
        return False, "账号还没配置完成（缺必填项）"
    try:
        if channel == "desktop":
            r = notifications.notify_desktop(title, body, desk_cfg=cfg)
            return bool(getattr(r, "ok", False)), str(getattr(r, "detail", "") or "已发送")
        if channel == "email":
            r = notifications.notify_smtp(title, body, smtp_cfg=cfg)
            return bool(getattr(r, "ok", False)), str(getattr(r, "detail", "") or "已发送")
        if channel == "telegram":
            r = notifications.notify_telegram(title, body, tg_cfg=cfg)
            return bool(getattr(r, "ok", False)), str(getattr(r, "detail", "") or "已发送")
    except Exception as e:                          # noqa: BLE001
        _log.warning("通知账号（%s）发送异常：%s", channel, e)
        return False, str(e)
    return False, "该渠道由定时任务模块发送"


def test_account(channel, account_id):
    """给单个账号发一条测试消息；返回 {ok, detail, name}。"""
    acc = get_account(channel, account_id)
    if not acc:
        return {"ok": False, "detail": "账号不存在（可能已被删除）"}
    title = "通知渠道测试 · File_Flask"
    body = "这是一条来自 File_Flask 的测试通知。若收到，说明账号「%s」配置正确。" % (acc.get("name") or channel)
    if channel in ("dingtalk", "pushplus", "web"):
        try:
            from ..ide import cronnotify
            ok, detail = cronnotify.send_with_account(channel, acc, title, body, meta={})
        except Exception as e:                      # noqa: BLE001
            ok, detail = False, str(e)
    else:
        ok, detail = send_account(channel, acc, title, body)
    return {"ok": bool(ok), "detail": str(detail or "")[:300], "name": acc.get("name") or ""}


# ---------------------------------------------------------------- 旧配置迁移
def _migrated_mark():
    rows = _rows("SELECT value FROM store_meta WHERE key=?", (_MIGRATE_KEY,))
    return bool(rows)


def _set_migrated_mark():
    with store_tx() as conn:
        conn.execute("INSERT OR REPLACE INTO store_meta (key, value) VALUES (?,?)",
                     (_MIGRATE_KEY, str(int(_now()))))


def _insert(channel, name, cfg, sort=0):
    aid = _new_id(channel)
    with store_tx() as conn:
        conn.execute(
            "INSERT INTO notify_accounts (id, channel, name, cfg, sort, updated_at) "
            "VALUES (?,?,?,?,?,?)",
            (aid, channel, name, _encode(channel, cfg), sort, _now()))
    return aid


def ensure_migrated():
    """首次使用：把旧版单账号配置迁移成渠道账号，并回写两边的 targets。"""
    try:
        if _migrated_mark():
            return
        rows = _rows("SELECT id FROM notify_accounts LIMIT 1")
        if rows:                                    # 已有账号（手工建的）→ 只补标记
            _set_migrated_mark()
            return
        _do_migrate()
        _set_migrated_mark()
    except Exception:                               # noqa: BLE001
        _log.exception("通知渠道账号迁移失败")


def _do_migrate():
    from ..ide import cronnotify                     # 延迟导入，避免循环依赖

    ai = notifications._read_cfg()
    cron = cronnotify.get_cfg()

    ids = {ch: [] for ch in CHANNELS}

    # 1) 桌面：AI 通知旧配置 always 有一个 desktop 账号
    d = ai.get("desktop") or {}
    ids["desktop"].append(_insert("desktop", "本机桌面通知", {
        "app_name": d.get("app_name") or "File_Flask",
        "sound": d.get("sound", True),
        "sound_name": d.get("sound_name") or "",
        "timeout_ms": d.get("timeout_ms") or 5000,
    }))

    # 2) 邮件：AI 的 smtp 为主；定时任务独立配置若填了 host 再补一个
    sk = ai.get("smtp") or {}
    if str(sk.get("host") or "").strip():
        ids["email"].append(_insert("email", "默认邮箱", sk))
    ce = cron.get("email") or {}
    if (not ce.get("use_global", True)) and str(ce.get("host") or "").strip():
        ids["email"].append(_insert("email", "定时任务邮箱", ce))

    # 3) Telegram：同上
    tg = ai.get("telegram") or {}
    if str(tg.get("bot_token") or "").strip():
        ids["telegram"].append(_insert("telegram", "默认 Bot", tg))
    ct = cron.get("telegram") or {}
    if (not ct.get("use_global", True)) and str(ct.get("bot_token") or "").strip():
        ids["telegram"].append(_insert("telegram", "定时任务 Bot", ct))

    # 4) 钉钉 / PushPlus / 网页版：来自定时任务旧配置
    ding = cron.get("dingtalk") or {}
    if str(ding.get("webhook") or "").strip():
        ids["dingtalk"].append(_insert("dingtalk", "默认钉钉机器人", ding))

    pp = cron.get("pushplus") or {}
    if str(pp.get("token") or "").strip():
        ids["pushplus"].append(_insert("pushplus", "默认 PushPlus", pp))

    web = cron.get("web") or {}
    ids["web"].append(_insert("web", "网页版通知", web))

    # 5) 回写 targets：按旧 channels 开关决定勾选
    ai_ch = ai.get("channels") or {}
    ai_targets = {
        "desktop": list(ids["desktop"]) if ai_ch.get("desktop", True) else [],
        "email": list(ids["email"]) if ai_ch.get("smtp") else [],
        "telegram": list(ids["telegram"]) if ai_ch.get("telegram") else [],
    }
    ai["targets"] = ai_targets
    notifications._write_notify_cfg(ai)

    cron_ch = cron.get("channels") or {}
    cron_targets = {
        "desktop": list(ids["desktop"]) if cron_ch.get("desktop", True) else [],
        "email": list(ids["email"]) if cron_ch.get("email") else [],
        "telegram": list(ids["telegram"]) if cron_ch.get("telegram") else [],
        "dingtalk": list(ids["dingtalk"]) if cron_ch.get("dingtalk") else [],
        "pushplus": list(ids["pushplus"]) if cron_ch.get("pushplus") else [],
        "web": list(ids["web"]) if cron_ch.get("web") else [],
    }
    cron["targets"] = cron_targets
    cronnotify._write_cfg(cron)

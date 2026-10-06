"""通知服务：AI 对话 / 智能体任务完成后向"启动服务的本人"推送。

当前支持两类通道（用户勾选即可）：

  ① 本地桌面通知（服务器本机可见）
      - Windows : 优先 BurntToast；其次 PowerShell BurntToast 命令；
                  最后兜底到 Start-Process 打开一段通知 HTML（浏览器全屏闪烁 + 声音）
      - macOS   : osascript "display notification"（带声音）
      - Linux   : notify-send + canberra-gtk-play / paplay

  ⑥ SMTP 邮件（最传统、最稳）

 ⑦ Telegram Bot（Bot API sendMessage；支持私聊 / 群组 / 话题 / 自建反代地址 / 独立代理）

统一接口：

    notifications.notify(
        title="AI 助手 · 回复完成",
        body="「你好」的回复已生成 …",
        channel="chat" | "agent",
    )

配置与"AI 助手"共用同一个 JSON 文件（data/storage/.file_manager_ai.json），
新增字段 "notify"；键脱敏在读取时做（api_key 除外，SMTP 的 password 会脱敏返回）。

同时会维护一份"最新通知 + 最近列表"（store.db 的 notify_history 表 + store_meta），
供前端标题栏 / 状态栏做轮询，用于浏览器内的可见提示与历史查看。
"""
from __future__ import annotations

import json
import logging
import mimetypes
import os
import re
import smtplib
import socket
import struct
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass
from email.header import Header
from email.message import EmailMessage
from email.utils import formataddr, formatdate, make_msgid
from typing import Any, Dict, List, Optional, Tuple

from app import config
from app.services.common import secret, transport
from app.services.common.store_db import (
    store_conn, store_tx, migrate_json_once, flatten_cfg, unflatten_cfg,
)


_log = logging.getLogger("file_mgr.notify")


NOTIFY_LATEST_FILE = os.path.join(config.STORAGE_DIR, ".file_manager_notify_latest.json")
NOTIFY_HTML_FILE = os.path.join(config.STORAGE_DIR, ".file_manager_notify_desktop.html")


# ---------------------------------------------------------------------------
# 配置读写
# ---------------------------------------------------------------------------

DEFAULT_NOTIFY_CFG: Dict[str, Any] = {
    "enabled": False,
    "scope": "both",          # chat / agent / both
    "channels": {
        "desktop": True,
        "smtp": False,
        "telegram": False,
    },
    "template": {
        "chat": "AI 助手 · 回复完成",
        "agent": "AI 智能体 · 任务完成",
    },
    "template_body": "任务已完成：{summary}",
    "summary_max_chars": 120,
    "query_max_chars": 60,
    "desktop": {
        "sound": True,
        "sound_name": "",       # 留空 = 用系统默认
        "timeout_ms": 5000,
        "app_name": "File_Flask",
    },
    "smtp": {
        "host": "",
        "port": 465,
        "security": "ssl",      # ssl / tls / none
        "username": "",
        "password": "",
        "from_addr": "",
        "to": "",
        "subject_prefix": "[File_Flask] ",
        "test_recipient": "",   # 留空则用 to
    },
    "telegram": {
        "bot_token": "",            # @BotFather 生成的 Bot Token
        "chat_id": "",              # 私聊 / 群组 的会话 ID
        "message_thread_id": "",    # 群组「话题」模式下的 thread id（可空）
        "disable_notification": False,
        "api_base": "https://api.telegram.org",   # 可改为自建 / 反代地址
        "proxy": "",                # 仅 Telegram Bot 使用的代理，如 http://127.0.0.1:7890
    },
}

# 顶层「标量」字段（非 dict）：读取和写入都必须显式搬运。
# 漏掉任何一个，表现都是「界面改了、还提示保存成功，但通知模板始终是老样子」。
_TOP_LEVEL_SCALARS = (
    "enabled",
    "scope",
    "template_body",        # 正文模板（曾经漏在这里，导致正文模板保存无效）
    "summary_max_chars",
    "query_max_chars",
)


def _read_cfg() -> Dict[str, Any]:
    """深拷贝默认值；再合并库中的 notify 配置（缺失字段自动补齐）。"""
    cfg = json.loads(json.dumps(DEFAULT_NOTIFY_CFG))
    saved = _read_notify_cfg()
    if not isinstance(saved, dict):
        return cfg
    _merge(cfg, saved, "channels")
    _merge(cfg, saved, "template")
    _merge(cfg, saved, "desktop")
    _merge(cfg, saved, "smtp")
    _merge(cfg, saved, "telegram")
    for k in _TOP_LEVEL_SCALARS:
        if k in saved:
            cfg[k] = saved[k]
    # 正文模板为空会让通知正文变空（Telegram 会直接报错），这里兜底回默认
    if not str(cfg.get("template_body") or "").strip():
        cfg["template_body"] = DEFAULT_NOTIFY_CFG["template_body"]
    return cfg


def _merge(base: dict, patch: dict, key: str) -> None:
    if key in patch and isinstance(patch[key], dict):
        base.setdefault(key, {}).update(patch[key])


# 通知配置里需要加密落库的字段（分组, 字段）
_SECRET_FIELDS = (("smtp", "password"), ("telegram", "bot_token"))


def _read_notify_cfg() -> Dict[str, Any]:
    """通知配置：一行一个配置项（key 为点号路径，如 smtp.host），读取时还原成嵌套结构。

    smtp.password / telegram.bot_token 以密文落库，这里解密；历史明文或旧密钥
    会在本次读完后顺手用当前密钥重写。
    """
    try:
        conn = store_conn()
        try:
            rows = {r["key"]: r["value"] for r in conn.execute("SELECT key, value FROM notify_cfg")}
        finally:
            conn.close()
    except Exception:
        return {}
    data = unflatten_cfg(rows)
    need_rewrite = False
    for section, field in _SECRET_FIELDS:
        block = data.get(section)
        if isinstance(block, dict) and block.get(field):
            plain, rewrite = secret.decrypt_ex(block[field])
            block[field] = plain
            need_rewrite = need_rewrite or rewrite
    if need_rewrite:
        try:
            _write_notify_cfg(data)
        except Exception:
            pass
    return data


def _write_notify_cfg(cfg: Dict[str, Any]) -> None:
    """整表覆盖写入通知配置（嵌套结构展平成一行一项；敏感字段加密后落库）。"""
    data = json.loads(json.dumps(cfg or {}))      # 深拷贝，避免改动调用方对象
    for section, field in _SECRET_FIELDS:
        block = data.get(section)
        if isinstance(block, dict) and block.get(field):
            block[field] = secret.encrypt(block[field])
    rows = flatten_cfg(data)
    with store_tx() as conn:
        conn.execute("DELETE FROM notify_cfg")
        for k, v in rows.items():
            conn.execute("INSERT INTO notify_cfg (key, value) VALUES (?,?)", (k, v))


def _write_cfg_patch(patch: Dict[str, Any]) -> None:
    """把通知配置写进 notify_cfg 表（一行一个配置项）。"""
    try:
        _write_notify_cfg(patch or {})
    except Exception:
        _log.exception("写入 notify 配置失败")
        raise


def sanitize_notify_cfg(cfg: Optional[dict] = None) -> Dict[str, Any]:
    """返回给前端的配置（SMTP 密码 / Telegram Token 脱敏）。"""
    c = dict(cfg if cfg is not None else _read_cfg())
    smtp = dict(c.get("smtp") or {})
    pw = str(smtp.get("password") or "")
    # 真实值不回传；只给"前 4 位 + ******"的脱敏形式 + 已保存标志
    smtp["password_set"] = bool(pw)
    smtp["password"] = secret.mask(pw)
    c["smtp"] = smtp

    tg = dict(c.get("telegram") or {})
    tk = str(tg.get("bot_token") or "")
    tg["token_set"] = bool(tk)
    tg["bot_token"] = secret.mask(tk)
    tg["api_base"] = str(tg.get("api_base") or "https://api.telegram.org")
    tg["proxy"] = str(tg.get("proxy") or "").strip()
    c["telegram"] = tg
    return c


def _is_masked_secret(value: str) -> bool:
    """判断是否为回传的脱敏值（旧格式 •••••abc / 新格式 abcd******）→ 视为「未修改」。"""
    return value.startswith("•") or "******" in value


def save_notify_cfg(user_cfg: dict) -> Dict[str, Any]:
    """接收前端提交，脱敏合并后落盘。

    前端在"没填新密码"时会回传脱敏值（如 •••••••abc），此时应保留磁盘里的旧值。
    """
    if not isinstance(user_cfg, dict):
        raise ValueError("notify 配置必须是对象")

    disk = _read_cfg()          # 磁盘当前值（含明文 password）

    new = json.loads(json.dumps(DEFAULT_NOTIFY_CFG))
    # 先用磁盘现值打底、再用入参覆盖（部分更新语义，Route 注释也是这么承诺的）。
    # 否则界面上没有控件的字段（smtp.subject_prefix、desktop.timeout_ms、template.agent 等）
    # 会在每次点保存时被悄悄重置回默认值。
    for key in ("channels", "template", "desktop", "smtp", "telegram"):
        if isinstance(disk.get(key), dict):
            new.setdefault(key, {}).update(disk[key])
    for k in _TOP_LEVEL_SCALARS:
        if k in disk:
            new[k] = disk[k]
    _merge(new, user_cfg, "channels")
    _merge(new, user_cfg, "template")
    _merge(new, user_cfg, "desktop")
    _merge(new, user_cfg, "smtp")
    _merge(new, user_cfg, "telegram")
    for k in _TOP_LEVEL_SCALARS:
        if k in user_cfg:
            new[k] = user_cfg[k]
    # 正文模板去尾部空白；留空则回默认，避免发出空正文
    new["template_body"] = (str(new.get("template_body") or "").strip()
                            or DEFAULT_NOTIFY_CFG["template_body"])

    # 密码合并：只有用户真的输入了新密码才覆盖；空值 / 脱敏回传一律保留旧值
    incoming_pw = transport.unwrap(
        str((user_cfg.get("smtp") or {}).get("password") or "")).strip()
    if not incoming_pw or _is_masked_secret(incoming_pw):
        new["smtp"]["password"] = disk.get("smtp", {}).get("password", "")
    else:
        new["smtp"]["password"] = incoming_pw

    # Telegram Bot Token 合并：规则与 SMTP 密码一致
    incoming_tk = transport.unwrap(
        str((user_cfg.get("telegram") or {}).get("bot_token") or "")).strip()
    if not incoming_tk or _is_masked_secret(incoming_tk):
        new["telegram"]["bot_token"] = disk.get("telegram", {}).get("bot_token", "")
    else:
        new["telegram"]["bot_token"] = incoming_tk

    # 校验
    if new.get("scope") not in ("chat", "agent", "both"):
        new["scope"] = "both"
    if isinstance(new.get("summary_max_chars"), (int, float)):
        new["summary_max_chars"] = int(max(0, min(400, new["summary_max_chars"])))
    else:
        new["summary_max_chars"] = 120
    if isinstance(new.get("query_max_chars"), (int, float)):
        new["query_max_chars"] = int(max(0, min(200, new["query_max_chars"])))
    else:
        new["query_max_chars"] = 60

    # SMTP 端口
    try:
        new["smtp"]["port"] = int(new["smtp"].get("port") or 465)
    except (TypeError, ValueError):
        new["smtp"]["port"] = 465
    if str(new["smtp"].get("security")) not in ("ssl", "tls", "none"):
        new["smtp"]["security"] = "ssl"

    # Telegram：API 地址归一化（去尾部斜杠）+ 话题 ID 只允许数字
    tg = new.setdefault("telegram", {})
    api_base = str(tg.get("api_base") or "").strip().rstrip("/")
    tg["api_base"] = api_base or "https://api.telegram.org"
    thread = str(tg.get("message_thread_id") or "").strip()
    tg["message_thread_id"] = thread if thread.isdigit() else ""
    tg["chat_id"] = str(tg.get("chat_id") or "").strip()
    # 代理地址：留空 = 直连；写法不对直接报错，免得发信时才失败
    tg["proxy"] = _normalize_proxy(tg.get("proxy"))

    _write_cfg_patch(new)
    return sanitize_notify_cfg(new)


# ---------------------------------------------------------------------------
# 最近通知的持久化（前端轮询）
# ---------------------------------------------------------------------------

def _read_latest() -> Dict[str, Any]:
    """读取「最新通知 + 历史」（store.db：notify_history 表 + store_meta 的 latest/cursor）。"""
    try:
        conn = store_conn()
        try:
            meta = {r["key"]: r["value"] for r in conn.execute(
                "SELECT key, value FROM store_meta WHERE key LIKE 'notify.%'")}
            hist = []
            # 插入顺序即「最新在前」，故按 seq 升序还原
            for r in conn.execute("SELECT rec FROM notify_history ORDER BY seq ASC"):
                try:
                    rec = json.loads(r["rec"] or "{}")
                except ValueError:
                    continue
                if isinstance(rec, dict):
                    hist.append(rec)
        finally:
            conn.close()
        latest = None
        raw = meta.get("notify.latest")
        if raw:
            try:
                latest = json.loads(raw)
            except ValueError:
                latest = None
        return {
            "latest": latest,
            "history": hist,
            "cursor": int(meta.get("notify.cursor") or 0),
            "latest_at": int(meta.get("notify.latest_at") or 0),
        }
    except Exception:
        return {"latest": None, "history": [], "cursor": 0}


def _write_latest(d: Dict[str, Any]) -> None:
    """整表覆盖写入（保持调用方原有的「读-改-写」语义）。"""
    try:
        latest = d.get("latest")
        hist = d.get("history") if isinstance(d.get("history"), list) else []
        with store_tx() as conn:
            conn.execute("INSERT OR REPLACE INTO store_meta (key, value) VALUES ('notify.latest', ?)",
                         (json.dumps(latest, ensure_ascii=False) if latest else "",))
            conn.execute("INSERT OR REPLACE INTO store_meta (key, value) VALUES ('notify.cursor', ?)",
                         (str(int(d.get("cursor") or 0)),))
            conn.execute("INSERT OR REPLACE INTO store_meta (key, value) VALUES ('notify.latest_at', ?)",
                         (str(int(d.get("latest_at") or 0)),))
            conn.execute("DELETE FROM notify_history")
            for rec in hist[:200]:
                if not isinstance(rec, dict):
                    continue
                conn.execute("INSERT INTO notify_history (id, ts, rec) VALUES (?,?,?)",
                             (str(rec.get("id") or ""), int(rec.get("ts") or 0),
                              json.dumps(rec, ensure_ascii=False)))
    except Exception:
        _log.exception("写入 notify latest 失败")


def _migrate_legacy_notify() -> None:
    """旧版 data/storage/.file_manager_notify_latest.json 一次性导入。"""
    def _import(conn, data):
        if not isinstance(data, dict):
            return
        latest = data.get("latest")
        if latest:
            conn.execute(
                "INSERT OR REPLACE INTO store_meta (key, value) VALUES ('notify.latest', ?)",
                (json.dumps(latest, ensure_ascii=False),))
        conn.execute("INSERT OR REPLACE INTO store_meta (key, value) VALUES ('notify.cursor', ?)",
                     (str(int(data.get("cursor") or 0)),))
        conn.execute("INSERT OR REPLACE INTO store_meta (key, value) VALUES ('notify.latest_at', ?)",
                     (str(int(data.get("latest_at") or 0)),))
        for rec in (data.get("history") if isinstance(data.get("history"), list) else [])[:200]:
            if not isinstance(rec, dict):
                continue
            conn.execute("INSERT INTO notify_history (id, ts, rec) VALUES (?,?,?)",
                         (str(rec.get("id") or ""), int(rec.get("ts") or 0),
                          json.dumps(rec, ensure_ascii=False)))

    migrate_json_once("json_migrated:notify_latest", NOTIFY_LATEST_FILE, _import)


_migrate_legacy_notify()
# 说明：AI 配置（含 notify）的迁移统一由 app/routes/ide/ai.py 的 _migrate_ai_cfg() 负责，
# 避免两个模块各自读取 / 删除同一份旧数据。


def append_history(rec: Dict[str, Any]) -> int:
    """追加到 history（最多 200 条），返回新 cursor（该条目的 id）。"""
    d = _read_latest()
    hist = d.get("history") or []
    cursor = int(d.get("cursor") or 0) + 1
    rec_id = f"{int(time.time())}-{cursor}"
    rec = dict(rec)
    rec["id"] = rec_id
    rec["ts"] = int(rec.get("ts") or time.time())
    hist.insert(0, rec)
    hist = hist[:200]
    d["latest"] = rec
    d["history"] = hist
    d["cursor"] = cursor
    d["latest_at"] = rec["ts"]
    _write_latest(d)
    return cursor


def read_latest(after_cursor: int = 0) -> Dict[str, Any]:
    """读取最近通知（返回全部 history，由调用方决定展示条数）。"""
    d = _read_latest()
    d["cursor"] = int(d.get("cursor") or 0)
    d["latest_at"] = int(d.get("latest_at") or 0)
    d["after_cursor"] = int(after_cursor or 0)
    d["has_new"] = bool(d["latest"]) and int(d.get("cursor") or 0) > int(after_cursor or 0)
    # 附带前端"是否已配置"的便捷字段
    try:
        cfg = sanitize_notify_cfg()
        d["enabled"] = bool(cfg.get("enabled"))
        d["channels"] = {k: bool(v) for k, v in (cfg.get("channels") or {}).items()}
    except Exception:
        d["enabled"] = False
        d["channels"] = {}
    return d


def clear_recent() -> int:
    """清空通知历史；返回被清掉的条数。"""
    d = _read_latest()
    n = len(d.get("history") or [])
    _write_latest({"latest": None, "history": [], "cursor": int(d.get("cursor") or 0), "latest_at": 0})
    return n


# ---------------------------------------------------------------------------
# 测试
# ---------------------------------------------------------------------------

def send_test(channel: str = "all") -> Dict[str, Any]:
    """按通道发一条测试通知；测试时会临时开启对应通道，测完恢复。

    channel: "desktop" / "email" / "all"
    """
    ch = (channel or "all").strip().lower()
    title = "通知测试 · File_Flask"
    body = "这是一条来自 File_Flask 的测试通知。若收到此消息，说明配置正确。"

    # 读取当前 notify cfg，临时启用
    orig_notify = _read_cfg()
    test_notify = json.loads(json.dumps(orig_notify))
    test_notify["enabled"] = True
    ch_map = dict(test_notify.get("channels") or {})
    if ch in ("all", "local", "desktop"):
        ch_map["desktop"] = True
    if ch in ("all", "email", "smtp"):
        ch_map["smtp"] = True
    if ch in ("all", "telegram", "tg", "tgbot"):
        ch_map["telegram"] = True
    test_notify["channels"] = ch_map

    try:
        _write_cfg_patch(test_notify)
        res = notify(title, body, channel="chat", source="test")
    finally:
        # 恢复原配置（注意：不要覆盖用户后来可能做的改动，用 _write_cfg_patch 保留其余字段）
        _write_cfg_patch(orig_notify)

    def _ok(key: str) -> bool:
        return bool((res.get(key) or {}).get("ok"))

    return {
        "ok": _ok("desktop") or _ok("smtp") or _ok("telegram"),
        "results": {
            "desktop": res.get("desktop"),
            "smtp": res.get("smtp"),
            "telegram": res.get("telegram"),
        },
    }


# ---------------------------------------------------------------------------
# 渲染消息

def _truncate(s: Any, n: int) -> str:
    s = "" if s is None else str(s)
    s = re.sub(r"\s+", " ", s).strip()
    if n and len(s) > n:
        return s[:n].rstrip() + "…"
    return s


_VAR_RE = re.compile(r"\{([A-Za-z_][A-Za-z0-9_]*)\}")


def _split_body(body: str) -> Tuple[str, str]:
    """AI 侧把 body 组织成「提问 + 空行 + 回复」，这里拆成两段。

    没有空行时（测试通知等）两段相同；便于 {query} / {summary} 各取所需。
    """
    s = str(body or "").strip()
    if "\n\n" in s:
        q, a = s.split("\n\n", 1)
        return q.strip(), a.strip()
    return s, s


def render(title: str, body: str, channel: str = "chat") -> Tuple[str, str]:
    """根据用户配置的模板渲染最终 title / body。

    模板变量（未知变量原样保留）：
        {title}       —— 通道默认标题（"AI 助手 · 回复完成" / "AI 智能体 · 任务完成"）
        {task}        —— 任务名（AI 助手 / AI 智能体）
        {channel}     —— chat / agent
        {query}       —— 用户提问 / 任务描述（按 query_max_chars 截断）
        {summary}     —— 模型回复摘要（按 summary_max_chars 截断）
        {answer}      —— 模型回复全文（不截断，邮件里想看完整内容时用）
        {answer_len}  —— 回复字数（不计空白）
        {time}/{date} —— 触发时间 HH:MM / YYYY-MM-DD
    """
    cfg = _read_cfg()
    tmpl_title = str((cfg.get("template") or {}).get(channel) or title or title).strip()
    tmpl_body = str(cfg.get("template_body") or "{summary}").strip()

    q_raw, a_raw = _split_body(body)
    now = time.localtime()
    mapping = {
        "title": title,
        "task": "AI 智能体" if channel == "agent" else "AI 助手",
        "channel": channel,
        "query": _truncate(q_raw, int(cfg.get("query_max_chars") or 60)),
        "summary": _truncate(a_raw, int(cfg.get("summary_max_chars") or 120)),
        "answer": a_raw,
        "answer_len": str(len(re.sub(r"\s+", "", a_raw))),
        "time": time.strftime("%H:%M", now),
        "date": time.strftime("%Y-%m-%d", now),
    }

    def sub(s: str) -> str:
        def _one(m):
            key = m.group(1)
            return mapping[key] if key in mapping else m.group(0)
        return _VAR_RE.sub(_one, s)

    return sub(tmpl_title), sub(tmpl_body)


# ---------------------------------------------------------------------------
# 通道：本地桌面通知
# ---------------------------------------------------------------------------

@dataclass
class DesktopResult:
    ok: bool
    method: str
    detail: str = ""


def notify_desktop(title: str, body: str) -> DesktopResult:
    """在本机弹系统通知。失败不会抛，返回 detail。"""
    cfg = _read_cfg()
    desk = cfg.get("desktop") or {}
    app_name = str(desk.get("app_name") or "File_Flask")
    play_sound = bool(desk.get("sound"))
    timeout_ms = int(desk.get("timeout_ms") or 5000)
    sound_name = str(desk.get("sound_name") or "")

    win = sys.platform.startswith("win")
    mac = sys.platform == "darwin"

    if win:
        return _desktop_win(app_name, title, body, play_sound, timeout_ms, sound_name)
    if mac:
        return _desktop_mac(app_name, title, body, play_sound, timeout_ms, sound_name)
    return _desktop_linux(app_name, title, body, play_sound, timeout_ms, sound_name)


def _desktop_win(app_name: str, title: str, body: str,
                 play_sound: bool, timeout_ms: int, sound_name: str) -> DesktopResult:
    # 1) BurntToast 模块（如果用户装了 PowerShell 模块）
    ps_cmd = (
        "$b = BurntToast -Text @{ Title='%s'; Text='%s' } "
        "-ShowCloseButton -Sound Default"
    ) % (
        _ps_esc(title),
        _ps_esc(body),
    )
    try:
        r = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", ps_cmd],
            capture_output=True, text=True, timeout=8,
        )
        if r.returncode == 0:
            return DesktopResult(True, "BurntToast")
    except Exception as e:
        _log.warning("BurntToast 调用失败：%s", e)

    # 2) 原生 Toast Notification（Win10+，无需额外模块）
    ps_native = _ps_native_toast(app_name, title, body, timeout_ms)
    try:
        r = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", ps_native],
            capture_output=True, text=True, timeout=8,
        )
        if r.returncode == 0:
            # 附带声音（WinForms SystemSounds）
            if play_sound:
                _win_play_sound(sound_name or "SystemExclamation")
            return DesktopResult(True, "Win10 NativeToast")
    except Exception as e:
        _log.warning("Win10 NativeToast 失败：%s", e)

    # 3) 兜底：Start-Process 打开一段通知 HTML（浏览器全屏闪标题 + 声音）
    try:
        html = _render_notify_html(app_name, title, body, play_sound, sound_name)
        with open(NOTIFY_HTML_FILE, "w", encoding="utf-8") as f:
            f.write(html)
        url = "file://" + NOTIFY_HTML_FILE.replace("\\", "/")
        subprocess.Popen(["cmd", "/c", "start", url],
                         creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        return DesktopResult(True, "FallbackBrowser")
    except Exception as e:
        return DesktopResult(False, "none", str(e))


def _ps_native_toast(app_name: str, title: str, body: str, timeout_ms: int) -> str:
    """Win10/11 原生 Notification 对象（用 AppId，可稳定弹到"通知中心"）。"""
    # 用 AppID: File_Flask.Notify.<pid>
    appid = "File_Flask.Notify.%d" % os.getpid()
    return """
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
                    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })
$null = $asTaskGeneric
[void]([System.Reflection.Assembly]::LoadWithPartialName('Windows.Foundation'))
[void]([System.Reflection.Assembly]::LoadWithPartialName('Windows.Data.Xml.Dom'))
[void]([System.Reflection.Assembly]::LoadWithPartialName('Windows.UI.Notifications'))
$builder = [Windows.UI.Notifications.ToastContentBuilder]::new()
$builder = [Windows.UI.Notifications.ToastContentBuilder]::new()
$builder.ApplicationsExecutionState = 'running'
$null = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('%s')
$builder = [Windows.UI.Notifications.ToastContentBuilder]::new()
$content = $builder
$content.Text('"%s"')
$content.Text('"%s"')
$toast = $content.Show()
$null = $toast
""" % (
    appid,
    title.replace("'", "\\'").replace('"', '\\"'),
    body.replace("'", "\\'").replace('"', '\\"'),
)


def _ps_esc(s: str) -> str:
    return str(s).replace("'", "''")


def _win_play_sound(sound_name: str) -> None:
    """通过 WinForms SystemSounds / SystemAPI 播放系统提示音。"""
    ps = (
        "Add-Type -AssemblyName System.Windows.Forms "
        "[System.Media.SystemSounds]::%s.Play()"
    )
    # sound_name 必须是可枚举值，避免执行任意 PowerShell
    safe = re.sub(r"[^A-Za-z]", "", str(sound_name))
    if safe and safe in ("Beep", "Asterisk", "Exclamation", "Hand", "Information",
                         "Question", "SystemDefault", "Warning", "Error",
                         "Ok", "Stop", "Exclamation", "SystemExclamation"):
        try:
            subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command",
                            ps % safe], timeout=4, capture_output=True)
        except Exception:
            pass


def _desktop_mac(app_name: str, title: str, body: str,
                 play_sound: bool, timeout_ms: int, sound_name: str) -> DesktopResult:
    sound = sound_name or "Glass"
    # display notification 支持 sound name；标题 64 字，正文 255 字以内比较好看
    ps = "display notification %s with title %s"
    args = [
        "-e", ps % (_as_str_esc(body), _as_str_esc(title)),
    ]
    if play_sound:
        args += ["-e", "sound name \"%s\"" % sound]
    try:
        r = subprocess.run(["osascript"] + args,
                           capture_output=True, text=True, timeout=6)
        if r.returncode == 0:
            return DesktopResult(True, "osascript")
        return DesktopResult(False, "osascript", r.stderr.strip())
    except Exception as e:
        # 兜底到通知 HTML
        try:
            html = _render_notify_html(app_name, title, body, play_sound, sound_name)
            with open(NOTIFY_HTML_FILE, "w", encoding="utf-8") as f:
                f.write(html)
            subprocess.Popen(["open", "-a", "Safari", NOTIFY_HTML_FILE],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return DesktopResult(True, "FallbackBrowser")
        except Exception as e2:
            return DesktopResult(False, "none", str(e2))


def _as_str_esc(s: str) -> str:
    return '"' + str(s).replace("\\", "\\\\").replace('"', '\\"') + '"'


def _desktop_linux(app_name: str, title: str, body: str,
                   play_sound: bool, timeout_ms: int, sound_name: str) -> DesktopResult:
    # notify-send（GNOME/KDE 都能识别）
    args = ["notify-send", "-a", app_name, "-i", "utilities-terminal"]
    if play_sound:
        args += ["--hint", "string:synchronous", "true",
                 "--hint", "int:desktop-entry", "0"]
    try:
        r = subprocess.run(args + [title, body],
                           capture_output=True, text=True, timeout=5)
        if r.returncode == 0:
            if play_sound:
                _linux_play_sound(sound_name)
            return DesktopResult(True, "notify-send")
    except Exception as e:
        _log.warning("notify-send 失败：%s", e)

    # 兜底：xdg-open 打开通知 HTML
    try:
        html = _render_notify_html(app_name, title, body, play_sound, sound_name)
        with open(NOTIFY_HTML_FILE, "w", encoding="utf-8") as f:
            f.write(html)
        subprocess.Popen(["xdg-open", "file://" + NOTIFY_HTML_FILE],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return DesktopResult(True, "FallbackBrowser")
    except Exception as e:
        return DesktopResult(False, "none", str(e))


def _linux_play_sound(sound_name: str) -> None:
    for cmd in (
        ["paplay", sound_name] if sound_name else [],
        ["canberra-gtk-play", "--play", sound_name] if sound_name else ["canberra-gtk-play"],
        ["paplay", "/usr/share/sounds/freedesktop/stereo/dialog-information.oga"],
    ):
        if not cmd:
            continue
        try:
            subprocess.run(cmd, capture_output=True, timeout=2)
            return
        except Exception:
            continue


def _render_notify_html(app_name: str, title: str, body: str,
                        play_sound: bool, sound_name: str) -> str:
    """兜底：一段自带闪烁标题 + 声音的 HTML，用浏览器打开。"""
    safe_title = _html_esc(title)
    safe_body = _html_esc(body)
    safe_app = _html_esc(app_name)
    sound_tag = ""
    if play_sound:
        # 使用一段短促的方波提示音，不依赖外部文件
        sound_tag = ('<audio id="snd" autoplay>'
                     '<source src="data:audio/wav;base64,'
                     + _beep_wav_b64('') + '" type="audio/wav">'
                     '</audio>')
    return f"""<!DOCTYPE html>
<html><head><meta charset="utf-8">
<title>{safe_title}</title>
<style>
  html,body {{ height:100%; margin:0; background:#0f1115; color:#e6e6e6;
              font:14px/1.6 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }}
  .wrap {{ max-width:640px; margin:8vh auto; padding:24px 28px;
           border:1px solid #2b2f3a; border-radius:10px;
           box-shadow:0 12px 40px rgba(0,0,0,.4);
           animation: pop .35s ease-out, glow 1.6s ease-in-out infinite; }}
  .app {{ color:#7aa2ff; font-size:12px; letter-spacing:1px; margin-bottom:6px; }}
  h1 {{ font-size:22px; margin:0 0 10px; font-weight:600; }}
  .body {{ white-space:pre-wrap; word-break:break-word; color:#c9cdd6; }}
  .tip {{ margin-top:22px; color:#888; font-size:12px; }}
  @keyframes pop {{ from {{ transform: scale(.96); opacity:0 }} to {{ transform:none; opacity:1 }} }}
  @keyframes glow {{ 0%,100% {{ box-shadow:0 12px 40px rgba(0,0,0,.4) }}
                     50%   {{ box-shadow:0 12px 40px rgba(122,162,255,.35) }} }}
</style></head>
<body>
{sound_tag}
<div class="wrap">
  <div class="app">{safe_app}</div>
  <h1>{safe_title}</h1>
  <div class="body">{safe_body}</div>
  <div class="tip">此页面为通知的兜底展示（系统桌面通知不可用时启用），可以关闭。</div>
</div>
</body></html>"""


def _html_esc(s: str) -> str:
    return (str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))


def _beep_wav_b64(_unused: str) -> str:
    """生成一段 0.4s 的双频提示音 base64 WAV。避免依赖系统音频文件。"""
    import base64
    import io
    import struct
    import wave
    sr = 22050
    dur = 0.4
    frames = bytearray()
    for i in range(int(sr * dur)):
        t = i / sr
        # 两声"叮"
        if i < sr * 0.15:
            v = 0.35 * (1 - i / (sr * 0.15)) * _sine(t, 880)
        elif i < sr * 0.25:
            v = 0
        else:
            k = i - int(sr * 0.25)
            v = 0.35 * (1 - k / (sr * 0.15)) * _sine(t, 1320) if k < sr * 0.15 else 0
        frames += struct.pack("<h", int(max(-1, min(1, v)) * 32767))
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
        w.writeframes(bytes(frames))
    return base64.b64encode(buf.getvalue()).decode("ascii")


def _sine(t: float, freq: float) -> float:
    import math
    return math.sin(2 * math.pi * freq * t)


# ---------------------------------------------------------------------------
# 通道：SMTP 邮件
# ---------------------------------------------------------------------------

@dataclass
class SmtpResult:
    ok: bool
    detail: str = ""


def notify_smtp(title: str, body: str, force_recipient: str = "") -> SmtpResult:
    cfg = _read_cfg()
    smtp = cfg.get("smtp") or {}
    host = str(smtp.get("host") or "").strip()
    user = str(smtp.get("username") or "").strip()
    pw = str(smtp.get("password") or "")
    port = int(smtp.get("port") or 465)
    sec = str(smtp.get("security") or "ssl").lower()
    from_addr = str(smtp.get("from_addr") or user or "").strip()
    # 发件人显示名：优先用户配置，其次 "File_Flask"
    from_name = str(smtp.get("from_name") or "").strip() or "File_Flask"
    try:
        from_name_unicode = str(Header(from_name, "utf-8"))
    except Exception:
        from_name_unicode = from_name
    recipients = [str(x).strip() for x in re.split(r"[,;\s]+", force_recipient or smtp.get("to") or "") if str(x).strip()]
    if not host:
        return SmtpResult(False, "SMTP 未配置 host")
    if not recipients:
        return SmtpResult(False, "SMTP 收件人为空")
    prefix = str(smtp.get("subject_prefix") or "")
    subject = "%s%s" % (prefix, title)

    msg = EmailMessage()
    msg["From"] = formataddr((from_name_unicode, from_addr or user))
    msg["To"] = ", ".join(recipients)
    msg["Subject"] = Header(subject, "utf-8")
    msg["Date"] = formatdate(localtime=True)
    msg["Message-ID"] = make_msgid()
    text_body = "%s\n\n%s" % (title, body)
    msg.set_content(text_body)
    html = _render_email_html(title, body)
    msg.add_alternative(html, subtype="html")

    try:
        if sec == "ssl":
            srv = smtplib.SMTP_SSL(host, port, timeout=15)
        else:
            srv = smtplib.SMTP(host, port, timeout=15)
            if sec == "tls":
                srv.starttls()
        if user and pw:
            srv.login(user, pw)
        srv.send_message(msg)
        try:
            srv.quit()
        except Exception:
            pass
        return SmtpResult(True, "ok")
    except Exception as e:
        return SmtpResult(False, "%s: %s" % (type(e).__name__, str(e)))


def _render_email_html(title: str, body: str) -> str:
    return (
        "<html><body style='font-family:-apple-system,Segoe UI,Microsoft YaHei,sans-serif;"
        "color:#222;padding:16px;max-width:640px;margin:0 auto;'>"
        "<div style='border-left:3px solid #4c8dff;padding:8px 12px;background:#f4f7ff;"
        "border-radius:4px;margin-bottom:12px;'>"
        "<div style='color:#666;font-size:12px;'>File_Flask · AI 助手</div>"
        "<div style='font-size:18px;font-weight:600;margin-top:2px;'>"
        + _html_esc(title) + "</div></div>"
        "<pre style='white-space:pre-wrap;word-break:break-word;font:13px/1.6 "
        "inherit;color:#333;margin:0;'>" + _html_esc(body) + "</pre>"
        "<div style='color:#999;font-size:11px;margin-top:16px;'>"
        "此邮件由 File_Flask 自动发送 · 如需关闭请前往「设置 → AI 助手 → 通知」</div>"
        "</body></html>"
    )


# ---------------------------------------------------------------------------
# 通道：Telegram Bot（Bot API sendMessage）
# ---------------------------------------------------------------------------

@dataclass
class TelegramResult:
    ok: bool
    detail: str = ""


_TG_TEXT_LIMIT = 4096          # Telegram sendMessage 的正文上限

# ---------------------------------------------------------------------------
# Telegram 专属代理：只有本机器人走这里，邮件 / 桌面通知完全不受影响
# ---------------------------------------------------------------------------

_TG_TIMEOUT = 15
_PROXY_SCHEMES = ("http", "https", "socks5", "socks5h")

_SOCKS5_ERR = {
    0x01: "一般性失败", 0x02: "规则不允许连接", 0x03: "网络不可达", 0x04: "主机不可达",
    0x05: "连接被拒绝", 0x06: "TTL 超时", 0x07: "代理不支持 CONNECT", 0x08: "地址类型不支持",
}


def _normalize_proxy(raw: Any) -> str:
    """归一化代理地址；空字符串表示直连。写法不对时抛 ValueError（前端会弹提示）。"""
    s = str(raw or "").strip().rstrip("/")
    if not s:
        return ""
    if "://" not in s:
        # 只填 host:port 时按 http 代理处理，省得用户记协议名
        s = "http://" + s
    u = urllib.parse.urlsplit(s)
    if u.scheme.lower() not in _PROXY_SCHEMES:
        raise ValueError("代理地址只支持 http:// https:// socks5:// socks5h:// 开头（当前是 %s://）" % u.scheme)
    if not u.hostname:
        raise ValueError("代理地址缺少主机名，应形如 http://127.0.0.1:7890")
    if not u.port:
        raise ValueError("代理地址缺少端口，应形如 http://127.0.0.1:7890")
    return s


def _parse_proxy(proxy: str):
    u = urllib.parse.urlsplit(proxy)
    scheme = u.scheme.lower()
    port = u.port or (1080 if scheme.startswith("socks") else 8080)
    user = urllib.parse.unquote(u.username) if u.username else ""
    pwd = urllib.parse.unquote(u.password) if u.password else ""
    return scheme, (u.hostname or ""), port, user, pwd


def _recv_exact(sock: socket.socket, n: int) -> bytes:
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise OSError("代理提前关闭了连接")
        buf += chunk
    return buf


def _socks5_connect(proxy_host: str, proxy_port: int, host: str, port: int,
                    timeout: Any, username: str = "", password: str = "",
                    resolve_local: bool = False) -> socket.socket:
    """极简 SOCKS5 CONNECT 客户端（纯标准库，不依赖 PySocks）。"""
    t = timeout if isinstance(timeout, (int, float)) else _TG_TIMEOUT
    s = socket.create_connection((proxy_host, proxy_port), t)
    s.settimeout(t)
    try:
        # 1) 握手：声明支持的认证方式
        s.sendall(b"\x05\x02\x00\x02" if username else b"\x05\x01\x00")
        resp = _recv_exact(s, 2)
        if resp[0] != 0x05:
            raise OSError("该端口不是 SOCKS5 代理（返回版本 0x%02x）" % resp[0])
        method = resp[1]
        if method == 0x02:
            if not username:
                raise OSError("代理要求用户名 / 密码认证，请写成 socks5://用户:密码@主机:端口")
            ub, pb = username.encode("utf-8"), (password or "").encode("utf-8")
            s.sendall(b"\x01" + bytes([len(ub)]) + ub + bytes([len(pb)]) + pb)
            if _recv_exact(s, 2)[1] != 0x00:
                raise OSError("代理认证失败（用户名或密码不正确）")
        elif method != 0x00:
            raise OSError("代理不接受「无认证」连接（方式 0x%02x）" % method)

        # 2) CONNECT 请求：默认把域名交给代理解析（等价 socks5h）
        if resolve_local:
            info = socket.getaddrinfo(host, port, 0, socket.SOCK_STREAM)
            if not info:
                raise OSError("本机无法解析域名 %s" % host)
            fam, _, _, _, addr = info[0]
            dst = (b"\x04" + socket.inet_pton(socket.AF_INET6, addr[0])) if fam == socket.AF_INET6 \
                else (b"\x01" + socket.inet_aton(addr[0]))
        else:
            try:
                hb = host.encode("ascii")
            except UnicodeEncodeError:
                hb = host.encode("idna")
            dst = b"\x03" + bytes([len(hb)]) + hb
        s.sendall(b"\x05\x01\x00" + dst + struct.pack(">H", int(port)))

        head = _recv_exact(s, 4)
        if head[1] != 0x00:
            raise OSError("代理返回：%s（0x%02x）" % (_SOCKS5_ERR.get(head[1], "未知错误"), head[1]))
        atyp = head[3]
        if atyp == 0x01:
            _recv_exact(s, 4)
        elif atyp == 0x03:
            _recv_exact(s, _recv_exact(s, 1)[0])
        elif atyp == 0x04:
            _recv_exact(s, 16)
        _recv_exact(s, 2)
        return s
    except Exception:
        try:
            s.close()
        except Exception:
            pass
        raise


def _tg_urlopen(req, proxy: str = "", timeout: int = _TG_TIMEOUT):
    """按「Telegram 专属代理」打开请求。

    proxy 为空 → 直连（沿用系统环境变量代理）；
    http/https → urllib 自带的 CONNECT 隧道；
    socks5/socks5h → 用内置的极简 SOCKS5 客户端建立连接。
    """
    # 兜底归一化：手工改过配置文件（或只填 host:port）时也能正常工作
    proxy = _normalize_proxy(proxy)
    if not proxy:
        return urllib.request.urlopen(req, timeout=timeout)

    scheme, phost, pport, puser, ppass = _parse_proxy(proxy)
    if scheme in ("http", "https"):
        opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({"http": proxy, "https": proxy})
        )
        return opener.open(req, timeout=timeout)

    import http.client as _http_client
    # socks5h 把域名交给代理解析；socks5 在本机解析后再连 IP
    resolve_local = (scheme == "socks5")

    def _connect_socks(conn):
        conn.sock = _socks5_connect(phost, pport, conn.host, conn.port, conn.timeout,
                                    puser, ppass, resolve_local)
        try:
            conn.sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        except OSError:
            pass

    class _SocksHTTP(_http_client.HTTPConnection):
        def connect(self):
            _connect_socks(self)

    class _SocksHTTPS(_http_client.HTTPSConnection):
        def connect(self):
            _connect_socks(self)
            self.sock = self._context.wrap_socket(self.sock, server_hostname=self.host)

    class _Handler(urllib.request.HTTPHandler):
        def http_open(self, r):
            return self.do_open(_SocksHTTP, r)

    class _SHandler(urllib.request.HTTPSHandler):
        def https_open(self, r):
            return self.do_open(_SocksHTTPS, r, context=None)

    # ProxyHandler({}) 显式关掉环境变量代理，避免和本设置互相打架
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _Handler(), _SHandler())
    return opener.open(req, timeout=timeout)




def notify_telegram(title: str, body: str) -> TelegramResult:
    """通过 Bot API 发送一条消息。失败不抛，返回 detail。"""
    cfg = _read_cfg()
    tg = cfg.get("telegram") or {}
    token = str(tg.get("bot_token") or "").strip()
    chat_id = str(tg.get("chat_id") or "").strip()
    if not token:
        return TelegramResult(False, "Telegram 未配置 Bot Token")
    if not chat_id:
        return TelegramResult(False, "Telegram 未配置 Chat ID")

    api_base = str(tg.get("api_base") or "https://api.telegram.org").strip().rstrip("/")
    if not api_base:
        api_base = "https://api.telegram.org"
    url = "%s/bot%s/sendMessage" % (api_base, token)
    proxy = str(tg.get("proxy") or "").strip()
    px_tip = "（代理 %s）" % proxy if proxy else ""

    text = ("%s\n\n%s" % (title, body)).strip()
    if len(text) > _TG_TEXT_LIMIT:
        text = text[: _TG_TEXT_LIMIT - 1].rstrip() + "…"

    payload: Dict[str, Any] = {"chat_id": chat_id, "text": text,
                               "disable_web_page_preview": True}
    thread = str(tg.get("message_thread_id") or "").strip()
    if thread:
        try:
            payload["message_thread_id"] = int(thread)
        except ValueError:
            return TelegramResult(False, "Telegram 话题 ID 必须是数字")
    if tg.get("disable_notification"):
        payload["disable_notification"] = True

    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url, data=data, method="POST",
        headers={"Content-Type": "application/json; charset=utf-8"},
    )
    try:
        with _tg_urlopen(req, proxy, _TG_TIMEOUT) as resp:
            raw = resp.read().decode("utf-8", "replace")
        try:
            d = json.loads(raw) if raw else {}
        except ValueError:
            d = {}
        if isinstance(d, dict) and d.get("ok"):
            return TelegramResult(True, "ok")
        desc = (d or {}).get("description") if isinstance(d, dict) else ""
        return TelegramResult(False, "Telegram 返回：%s" % (desc or raw[:200] or "未知错误"))
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            raw = e.read().decode("utf-8", "replace")
            d = json.loads(raw)
            detail = (d or {}).get("description") or raw
        except Exception:
            detail = ""
        return TelegramResult(False, "HTTP %s %s" % (e.code, detail or e.reason or ""))
    except urllib.error.URLError as e:
        return TelegramResult(False, "网络错误%s：%s" % (px_tip, getattr(e, "reason", e)))
    except Exception as e:
        # SOCKS 握手失败抛的是裸 OSError（不会被包成 URLError），这里给出可读信息
        if isinstance(e, OSError) and not isinstance(e, urllib.error.URLError):
            return TelegramResult(False, "连接失败%s：%s" % (px_tip, e))
        return TelegramResult(False, "%s: %s" % (type(e).__name__, e))


# ---------------------------------------------------------------------------
# 对外主入口
# ---------------------------------------------------------------------------

def should_notify(channel: str) -> bool:
    """按 scope 判断是否应该推送。"""
    cfg = _read_cfg()
    if not cfg.get("enabled"):
        return False
    scope = str(cfg.get("scope") or "both")
    return scope in ("both", channel)


def notify(title: str, body: str, channel: str = "chat",
           source: str = "") -> Dict[str, Any]:
    """按配置推送一次通知，并把记录写入 latest/history。

    channel: 场景（chat / agent），决定用哪套模板、以及 scope 判定
    source:  历史记录里的来源标签，默认与 channel 相同；测试入口传 "test"
    任何异常都不会抛，只 log。
    """
    results = {"channel": channel, "source": source or channel,
               "title": title, "body": body,
               "desktop": None, "smtp": None, "telegram": None}
    if not should_notify(channel):
        # 没启用 / scope 不匹配：什么都没发出去，不写历史，
        # 否则列表里会出现一条既没有正文、也没有通道状态的“空壳记录”。
        results["skipped"] = "disabled"
        return results

    cfg = _read_cfg()
    # 使用用户模板覆盖 title
    title, body = render(title, body, channel)
    results["title"] = title
    results["body"] = body

    if (cfg.get("channels") or {}).get("desktop"):
        try:
            r = notify_desktop(title, body)
            results["desktop"] = {"ok": r.ok, "method": r.method, "detail": r.detail}
            if r.ok:
                _log.info("[notify-desktop/%s] %s (%s)", channel, title[:60], r.method)
            else:
                _log.warning("[notify-desktop/%s] failed: %s", channel, r.detail)
        except Exception as e:
            results["desktop"] = {"ok": False, "method": "none", "detail": str(e)}
            _log.exception("notify_desktop 抛异常")

    if (cfg.get("channels") or {}).get("smtp"):
        try:
            r = notify_smtp(title, body)
            results["smtp"] = {"ok": r.ok, "detail": r.detail}
            if r.ok:
                _log.info("[notify-smtp/%s] %s", channel, title[:60])
            else:
                _log.warning("[notify-smtp/%s] failed: %s", channel, r.detail)
        except Exception as e:
            results["smtp"] = {"ok": False, "detail": str(e)}
            _log.exception("notify_smtp 抛异常")

    if (cfg.get("channels") or {}).get("telegram"):
        try:
            r = notify_telegram(title, body)
            results["telegram"] = {"ok": r.ok, "detail": r.detail}
            if r.ok:
                _log.info("[notify-telegram/%s] %s", channel, title[:60])
            else:
                _log.warning("[notify-telegram/%s] failed: %s", channel, r.detail)
        except Exception as e:
            results["telegram"] = {"ok": False, "detail": str(e)}
            _log.exception("notify_telegram 抛异常")

    _record_history(results)
    return results


def _record_history(results: Dict[str, Any]) -> None:
    # 只有真的推过（或至少配置启用）才记录
    try:
        cfg = _read_cfg()
        if not cfg.get("enabled"):
            return
        # 本次真正尝试过的通道（未启用的通道是 None，不写进来）
        channels: Dict[str, Any] = {}
        for key in ("desktop", "smtp", "telegram"):
            r = results.get(key)
            if isinstance(r, dict):
                channels[key] = {
                    "ok": bool(r.get("ok")),
                    "detail": str(r.get("detail") or "")[:300],
                }
        summary = {
            # kind 是历史列表用来显示来源（AI 助手 / AI 智能体 / 测试通知）的字段
            "kind": str(results.get("source") or results.get("channel") or "chat"),
            "channel": results.get("channel"),
            "title": results.get("title"),
            "body": (results.get("body") or "")[:800],
            "ts": int(time.time()),
            "channels": channels,
            "skipped": results.get("skipped"),
            # 兼容旧版读取方：保留平铺的通道字段
            "desktop": results.get("desktop"),
            "smtp": results.get("smtp"),
            "telegram": results.get("telegram"),
        }
        append_history(summary)
    except Exception:
        _log.exception("记录通知历史失败")


# ---------------------------------------------------------------------------
# 测试入口（供 UI 按钮调用）
# ---------------------------------------------------------------------------

def test_notification(channel: str = "chat", smtp_recipient: str = "") -> Dict[str, Any]:
    title = "通知测试"
    body = "这是一条来自 File_Flask 的测试通知。\n如果你看到它，说明通道工作正常。"
    # 临时强制打开开关，避免"未启用"直接返回
    cfg = _read_cfg()
    was_enabled = cfg.get("enabled")
    if not was_enabled:
        # 临时写一份 enabled=True 的副本用于本次测试
        test_cfg = json.loads(json.dumps(cfg))
        test_cfg["enabled"] = True
        # 用 monkey-patch 的方式调用内部实现
        orig_read = globals().get("_read_cfg")
        _orig = _read_cfg
        globals()["_read_cfg"] = lambda: test_cfg
        try:
            title, body = render(title, body, channel)
            results = {"channel": channel, "title": title, "body": body}
            if (test_cfg.get("channels") or {}).get("desktop"):
                r = notify_desktop(title, body)
                results["desktop"] = {"ok": r.ok, "method": r.method, "detail": r.detail}
            if (test_cfg.get("channels") or {}).get("smtp"):
                r = notify_smtp(title, body, smtp_recipient)
                results["smtp"] = {"ok": r.ok, "detail": r.detail}
            if (test_cfg.get("channels") or {}).get("telegram"):
                r = notify_telegram(title, body)
                results["telegram"] = {"ok": r.ok, "detail": r.detail}
        finally:
            globals()["_read_cfg"] = _orig
        return results
    return notify(title, body, channel)

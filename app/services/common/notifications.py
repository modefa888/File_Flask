"""通知服务：AI 对话 / 智能体任务完成后向"启动服务的本人"推送。

当前支持两类通道（用户勾选即可）：

  ① 本地桌面通知（服务器本机可见）
      - Windows : 优先 BurntToast；其次 PowerShell BurntToast 命令；
                  最后兜底到 Start-Process 打开一段通知 HTML（浏览器全屏闪烁 + 声音）
      - macOS   : osascript "display notification"（带声音）
      - Linux   : notify-send + canberra-gtk-play / paplay

  ⑥ SMTP 邮件（最传统、最稳）

统一接口：

    notifications.notify(
        title="AI 助手 · 回复完成",
        body="「你好」的回复已生成 …",
        channel="chat" | "agent",
    )

配置与"AI 助手"共用同一个 JSON 文件（data/storage/.file_manager_ai.json），
新增字段 "notify"；键脱敏在读取时做（api_key 除外，SMTP 的 password 会脱敏返回）。

同时会维护一份"最新通知 + 最近列表"（data/storage/.file_manager_notify_latest.json），
供前端标题栏 / 状态栏做轮询，用于浏览器内的可见提示与历史查看。
"""
from __future__ import annotations

import json
import logging
import mimetypes
import os
import re
import smtplib
import subprocess
import sys
import time
import uuid
from dataclasses import dataclass
from email.header import Header
from email.message import EmailMessage
from email.utils import formataddr, formatdate, make_msgid
from typing import Any, Dict, List, Optional, Tuple

from app import config


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
    },
    "template": {
        "chat": "AI 助手 · 回复完成",
        "agent": "AI 智能体 · 任务完成",
    },
    "template_body": "任务已完成：{query}\n{summary}",
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
}


def _read_cfg() -> Dict[str, Any]:
    """深拷贝默认值；再合并磁盘 JSON 中的 notify 字段（缺失字段自动补齐）。"""
    cfg = json.loads(json.dumps(DEFAULT_NOTIFY_CFG))
    try:
        with open(config.AI_CONFIG_FILE, "r", encoding="utf-8") as f:
            disk = json.load(f) or {}
    except (OSError, ValueError):
        return cfg
    saved = disk.get("notify") or {}
    if not isinstance(saved, dict):
        return cfg
    _merge(cfg, saved, "channels")
    _merge(cfg, saved, "template")
    _merge(cfg, saved, "desktop")
    _merge(cfg, saved, "smtp")
    for k in ("enabled", "scope", "summary_max_chars", "query_max_chars"):
        if k in saved:
            cfg[k] = saved[k]
    return cfg


def _merge(base: dict, patch: dict, key: str) -> None:
    if key in patch and isinstance(patch[key], dict):
        base.setdefault(key, {}).update(patch[key])


def _write_cfg_patch(patch: Dict[str, Any]) -> None:
    """把 patch 写回 data/storage/.file_manager_ai.json 的 notify 字段（保留其他字段）。"""
    disk: Dict[str, Any] = {}
    try:
        with open(config.AI_CONFIG_FILE, "r", encoding="utf-8") as f:
            disk = json.load(f) or {}
    except (OSError, ValueError):
        disk = {}
    disk["notify"] = patch
    try:
        with open(config.AI_CONFIG_FILE, "w", encoding="utf-8") as f:
            json.dump(disk, f, ensure_ascii=False, indent=2)
    except Exception:
        _log.exception("写入 notify 配置失败")
        raise


def sanitize_notify_cfg(cfg: Optional[dict] = None) -> Dict[str, Any]:
    """返回给前端的配置（SMTP 密码脱敏）。"""
    c = dict(cfg if cfg is not None else _read_cfg())
    smtp = dict(c.get("smtp") or {})
    pw = str(smtp.get("password") or "")
    if pw:
        # 真实密码不回传；只保留"已保存"标志
        smtp["password"] = ""
        smtp["password_set"] = True
    else:
        smtp["password"] = ""
        smtp["password_set"] = False
    c["smtp"] = smtp
    return c


def save_notify_cfg(user_cfg: dict) -> Dict[str, Any]:
    """接收前端提交，脱敏合并后落盘。

    前端在"没填新密码"时会回传脱敏值（如 •••••••abc），此时应保留磁盘里的旧值。
    """
    if not isinstance(user_cfg, dict):
        raise ValueError("notify 配置必须是对象")

    disk = _read_cfg()          # 磁盘当前值（含明文 password）

    new = json.loads(json.dumps(DEFAULT_NOTIFY_CFG))
    _merge(new, user_cfg, "channels")
    _merge(new, user_cfg, "template")
    _merge(new, user_cfg, "desktop")
    _merge(new, user_cfg, "smtp")
    for k in ("enabled", "scope", "summary_max_chars", "query_max_chars"):
        if k in user_cfg:
            new[k] = user_cfg[k]

    # 密码合并：只有当用户真的输入了新密码时才覆盖
    incoming_pw = str((user_cfg.get("smtp") or {}).get("password") or "").strip()
    if not incoming_pw:
        new["smtp"]["password"] = disk.get("smtp", {}).get("password", "")
    elif len(incoming_pw) > 3 and incoming_pw.startswith("•"):
        # 前端回传的脱敏值 → 保留旧值
        new["smtp"]["password"] = disk.get("smtp", {}).get("password", "")
    else:
        new["smtp"]["password"] = incoming_pw

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

    _write_cfg_patch(new)
    return sanitize_notify_cfg(new)


# ---------------------------------------------------------------------------
# 最近通知的持久化（前端轮询）
# ---------------------------------------------------------------------------

def _read_latest() -> Dict[str, Any]:
    try:
        with open(NOTIFY_LATEST_FILE, "r", encoding="utf-8") as f:
            d = json.load(f)
        if not isinstance(d, dict):
            return {"latest": None, "history": [], "cursor": 0}
        d.setdefault("history", [])
        d.setdefault("cursor", 0)
        return d
    except (OSError, ValueError):
        return {"latest": None, "history": [], "cursor": 0}


def _write_latest(d: Dict[str, Any]) -> None:
    try:
        with open(NOTIFY_LATEST_FILE, "w", encoding="utf-8") as f:
            json.dump(d, f, ensure_ascii=False, indent=2)
    except Exception:
        _log.exception("写入 notify latest 失败")


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
    test_notify["channels"] = ch_map

    try:
        _write_cfg_patch(test_notify)
        res = notify(title, body, channel="chat")
    finally:
        # 恢复原配置（注意：不要覆盖用户后来可能做的改动，用 _write_cfg_patch 保留其余字段）
        _write_cfg_patch(orig_notify)

    return {
        "ok": bool(res.get("desktop", {}).get("ok")) or bool(res.get("smtp", {}).get("ok")),
        "results": {
            "desktop": res.get("desktop"),
            "smtp": res.get("smtp"),
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


def render(title: str, body: str, channel: str = "chat") -> Tuple[str, str]:
    """根据用户配置的模板渲染最终 title / body。

    模板变量：
        {title}     —— 通道对应的默认标题（"AI 助手 · 回复完成" 等）
        {channel}   —— chat / agent
        {query}     —— 用户提问 / 任务描述
        {summary}   —— 模型回复摘要（截断）
    """
    cfg = _read_cfg()
    tmpl_title = str((cfg.get("template") or {}).get(channel) or title or title).strip()
    tmpl_body = str(cfg.get("template_body") or "{title}：{summary}").strip()

    def sub(s: str) -> str:
        s = s.replace("{title}", title)
        s = s.replace("{channel}", channel)
        s = s.replace("{query}", _truncate(cfg.get("query") if False else body.split("\n")[0] if False else body, 0))
        s = s.replace("{summary}", _truncate(body, int(cfg.get("summary_max_chars") or 120)))
        return s

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
# 对外主入口
# ---------------------------------------------------------------------------

def should_notify(channel: str) -> bool:
    """按 scope 判断是否应该推送。"""
    cfg = _read_cfg()
    if not cfg.get("enabled"):
        return False
    scope = str(cfg.get("scope") or "both")
    return scope in ("both", channel)


def notify(title: str, body: str, channel: str = "chat") -> Dict[str, Any]:
    """按配置推送一次通知，并把记录写入 latest/history。

    任何异常都不会抛，只 log。
    """
    results = {"channel": channel, "title": title, "body": body,
               "desktop": None, "smtp": None}
    if not should_notify(channel):
        results["skipped"] = "disabled"
        _record_history(results)
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

    _record_history(results)
    return results


def _record_history(results: Dict[str, Any]) -> None:
    # 只有真的推过（或至少配置启用）才记录
    try:
        cfg = _read_cfg()
        if not cfg.get("enabled"):
            return
        summary = {
            "channel": results.get("channel"),
            "title": results.get("title"),
            "body": (results.get("body") or "")[:400],
            "ts": int(time.time()),
            "desktop": results.get("desktop"),
            "smtp": results.get("smtp"),
            "skipped": results.get("skipped"),
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
        finally:
            globals()["_read_cfg"] = _orig
        return results
    return notify(title, body, channel)

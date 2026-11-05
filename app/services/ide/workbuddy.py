"""WorkBuddy 积分 / 签到业务层。

原理
----
WorkBuddy / CodeBuddy 桌面端的「Buddy 加油站 → 签到」本质是一次带登录态的
HTTPS 请求。本模块支持三种凭据来源：

  1. OAuth 设备授权（推荐，参考 workbuddy2api-panel 的 login/start + login/poll）：
     POST /v2/plugin/auth/state 拿授权 URL → 用户在浏览器里微信扫码登录 →
     GET  /v2/plugin/auth/token?state= 轮询拿 accessToken / refreshToken →
     GET  /v2/plugin/login/account?state= 拿 uid / nickname；
  2. 本机桌面端登录态文件 workbuddy-desktop.info（只读）；
  3. 界面手动填写 accessToken。

计费接口（域名以登录态 / OAuth 返回的 domain 为准，默认 www.codebuddy.cn）：

    POST /v2/billing/meter/checkin-activity-status   今日签到状态 / 连签天数
    POST /billing/meter/get-user-resource-summary    积分余额
    POST /v2/billing/meter/daily-checkin             领取当日积分（幂等）

请求头：Authorization: Bearer <accessToken>、X-User-Id: <uid>、
Content-Type: application/json；请求体固定为 {}。企业账号另带
X-Enterprise-Id / X-Tenant-Id。

安全约定
--------
  * accessToken / refreshToken 等同账号密码：落库前用 secret.encrypt 加密，
    接口一律不回显明文、日志不打印任何凭据；登录态文件只读，不修改、不外传；
  * 请求域名限制在官方域名白名单内且强制 HTTPS，避免把凭据发往任意地址；
  * 签到前先查状态，已签到直接跳过；服务端返回「已签到」也归一化为幂等成功。

多账号
------
每个 WorkBuddy 账号一行存 workbuddy_accounts（凭据加密），全局设置与「当前账号」
放 store_meta['workbuddy.config']。旧版单账号配置在首次访问时一次性迁入，不丢凭据。
签到记录写 workbuddy_checkin（按 日期 + uid 唯一，天然按账号隔离）。
"""
from __future__ import annotations

import base64
import io
import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

from ...log import get_logger
from ..common import proxyutil, secret, store_db

_log = get_logger()

CONFIG_KEY = "workbuddy.config"
DEFAULT_DOMAIN = "www.codebuddy.cn"
# 只允许把凭据发往这些官方域名（支持子域），防止配置误填导致 token 外泄
ALLOWED_DOMAINS = ("codebuddy.cn", "workbuddy.ai", "copilot.tencent.com", "tencent.com")

PATH_STATUS = "/v2/billing/meter/checkin-activity-status"
PATH_CHECKIN = "/v2/billing/meter/daily-checkin"
PATH_CREDITS = "/billing/meter/get-user-resource-summary"

# OAuth 设备授权（CLI 插件同款请求头与端点；参考 linguo2625469/workbuddy2api-panel）
OAUTH_BASE = {"cn": "https://copilot.tencent.com", "global": "https://www.workbuddy.ai"}
OAUTH_ORIGIN = {"cn": "https://www.codebuddy.cn", "global": "https://www.workbuddy.ai"}
OAUTH_UA = "CLI/2.63.2 CodeBuddy/2.63.2"
OAUTH_STATE_PATH = "/v2/plugin/auth/state?platform=CLI"
OAUTH_TOKEN_PATH = "/v2/plugin/auth/token?state="
OAUTH_ACCOUNT_PATH = "/v2/plugin/login/account?state="
OAUTH_REFRESH_PATH = "/v2/plugin/auth/token/refresh"
LOGIN_TTL = 600                     # 授权会话 10 分钟有效
_LOGINS = {}                        # state -> {realm, created, url}
_LOGIN_LOCK = threading.RLock()
_REFRESH_LOCK = threading.RLock()
_last_refresh_try = 0.0

_STATUS_KEYS = {
    "today_checked_in": ("today_checked_in", "todayCheckedIn", "checked_in_today",
                         "is_checked_in", "has_checked_in", "checked_in", "claimed"),
    "streak_days": ("streak_days", "streakDays", "continuous_days", "continuousDays",
                    "checkin_days", "streak"),
    "today_credit": ("today_credit", "todayCredit", "daily_credit", "dailyCredit",
                     "today_reward", "reward", "credit"),
    "total_credits": ("total_credits", "totalCredits", "accumulated_credits",
                      "checkin_total_credits"),
    "start_time": ("start_time", "startTime", "activity_start_time", "begin_time"),
    "end_time": ("end_time", "endTime", "activity_end_time", "expire_time"),
}
_BALANCE_KEYS = ("TotalCredits", "totalCredits", "total_credits", "availableCredits",
                 "remainingCredits", "balance", "creditBalance", "leftCredits",
                 "available_credits", "Credits", "credit")
_USED_KEYS = ("UsedCredits", "usedCredits", "used_credits", "totalUsed", "consumed")
_TOTAL_KEYS = ("TotalQuota", "totalQuota", "quota", "packageCredits", "total_amount")
_MSG_KEYS = ("message", "msg", "errmsg", "errorMsg", "error", "detail", "tip")


class WorkBuddyError(Exception):
    """可直接展示给用户的业务错误。"""


# --------------------------------------------------------------------------- 工具

def _norm_key(k) -> str:
    return re.sub(r"[^a-z0-9]", "", str(k).lower())


def _find(obj, wanted: str, depth: int = 0):
    """在嵌套 JSON 里按「归一化键名」找第一个标量值（限制深度防失控）。"""
    if depth > 6:
        return None
    if isinstance(obj, dict):
        for k, v in obj.items():
            if _norm_key(k) == wanted and not isinstance(v, (dict, list)):
                return v
        for v in obj.values():
            got = _find(v, wanted, depth + 1)
            if got is not None:
                return got
    elif isinstance(obj, list):
        for v in obj[:20]:
            got = _find(v, wanted, depth + 1)
            if got is not None:
                return got
    return None


def _pick(obj, names):
    """按候选名依次查找，返回 (值, 命中的键名)。"""
    for name in names:
        got = _find(obj, _norm_key(name))
        if got is not None:
            return got, name
    return None, ""


def _num(v, default=None):
    try:
        if v is None or isinstance(v, bool):
            return default
        return float(str(v).replace(",", "").strip())
    except (TypeError, ValueError):
        return default


def _bool(v):
    if v is None:
        return None
    if isinstance(v, bool):
        return v
    s = str(v).strip().lower()
    if s in ("1", "true", "yes", "y", "checked", "signed"):
        return True
    if s in ("0", "false", "no", "n", ""):
        return False
    return None


def _message(obj) -> str:
    for name in _MSG_KEYS:
        got = _find(obj, _norm_key(name))
        if got is not None and not isinstance(got, (dict, list)):
            return str(got)
    return ""


def _already(code, msg, raw_text="") -> bool:
    if str(code) in ("10001", "10002", "40001"):
        return True
    text = (str(msg) + " " + str(raw_text)[:400]).lower()
    return any(k in text for k in ("已签到", "已领取", "已领过", "明天再来",
                                   "already", "checked in", "claimed"))


def _time_text(v):
    """接口里的活动起止时间：秒 / 毫秒时间戳或字符串统一转成本地可读文本。"""
    if v is None or v == "":
        return ""
    n = _num(v)
    if n is not None and n > 1000000000:
        sec = n / 1000 if n > 100000000000 else n
        return time.strftime("%Y-%m-%d %H:%M", time.localtime(sec))
    return str(v)[:64]


def _domain(raw) -> str:
    """清洗并校验域名：必须是白名单里的官方域名（可带协议 / 路径）。"""
    s = str(raw or "").strip()
    if not s:
        return DEFAULT_DOMAIN
    if "://" in s:
        host = (urllib.parse.urlsplit(s).hostname or "").lower()
    else:
        host = s.split("/", 1)[0].split(":", 1)[0].lower()
    if not host:
        raise WorkBuddyError("接口域名为空，请在配置里填写有效的官方域名")
    if not any(host == d or host.endswith("." + d) for d in ALLOWED_DOMAINS):
        raise WorkBuddyError("域名 %s 不在官方白名单内，已阻止发送凭据（支持：%s）"
                             % (host, " / ".join(ALLOWED_DOMAINS)))
    return host


# --------------------------------------------------------------------------- 登录态

def _auth_dirs():
    """按平台给出登录态文件可能所在的目录（用于自动探测与界面提示）。"""
    home = os.path.expanduser("~")
    dirs = []
    env_file = os.environ.get("WORKBUDDY_AUTH_FILE", "").strip()
    if env_file:
        dirs.append(os.path.dirname(os.path.abspath(os.path.expanduser(env_file))))
    local = os.environ.get("LOCALAPPDATA", "").strip()
    if sys.platform.startswith("win") and local:
        dirs.append(os.path.join(local, "CodeBuddyExtension", "Data", "Public", "auth"))
    if sys.platform == "darwin":
        dirs.append(os.path.join(home, "Library", "Application Support",
                                 "CodeBuddyExtension", "Data", "Public", "auth"))
    else:
        dirs.append(os.path.join(home, ".local", "share", "CodeBuddyExtension",
                                 "Data", "Public", "auth"))
        dirs.append(os.path.join(home, ".config", "CodeBuddyExtension",
                                 "Data", "Public", "auth"))
        dirs.append(os.path.join(home, ".config", "CodeBuddy CN", "User", "globalStorage"))
    out = []
    for d in dirs:
        if d and d not in out:
            out.append(d)
    return out


def _auth_files(explicit=""):
    """候选登录态文件：显式路径 / 环境变量优先，其次扫描各探测目录。"""
    files = []
    for raw in (explicit, os.environ.get("WORKBUDDY_AUTH_FILE", "")):
        p = os.path.abspath(os.path.expanduser(str(raw or "").strip()))
        if raw and p not in files:
            files.append(p)
    preferred = ("workbuddy-desktop.info", "workbuddy.info", "auth.info", "auth.json")
    for d in _auth_dirs():
        if not os.path.isdir(d):
            continue
        for name in preferred:
            p = os.path.join(d, name)
            if os.path.isfile(p) and p not in files:
                files.append(p)
        try:
            scanned = 0
            for name in sorted(os.listdir(d)):
                if not name.lower().endswith((".info", ".json")):
                    continue
                p = os.path.join(d, name)
                if not os.path.isfile(p) or p in files:
                    continue
                # 只扫小文件：VSCode 系 globalStorage 里可能有体积很大的会话数据
                try:
                    if os.path.getsize(p) > 2 * 1024 * 1024:
                        continue
                except OSError:
                    continue
                files.append(p)
                scanned += 1
                if scanned >= 40:
                    break
        except OSError:
            continue
    return files


def _parse_auth_file(path):
    """只读解析登录态 JSON，兼容字段放在顶层 / auth / data.auth / account 下。"""
    try:
        with open(path, "r", encoding="utf-8-sig") as f:
            doc = json.load(f)
    except (OSError, ValueError) as e:
        raise WorkBuddyError("登录态文件无法读取：%s（%s）" % (path, e))
    if not isinstance(doc, dict):
        raise WorkBuddyError("登录态文件内容不是 JSON 对象：%s" % path)

    def dig(node, keys, depth=0):
        if depth > 4 or not isinstance(node, dict):
            return ""
        for key in keys:
            got = node.get(key)
            if got is not None and not isinstance(got, (dict, list)) and str(got).strip():
                return str(got).strip()
        for v in node.values():
            got = dig(v, keys, depth + 1)
            if got:
                return got
        return ""

    token = dig(doc, ("accessToken", "access_token", "authToken", "token", "jwt"))
    if not token:
        return None
    return {
        "path": path,
        "token": token,
        "uid": dig(doc, ("uid", "userId", "user_id", "accountId")),
        "domain": dig(doc, ("domain", "apiDomain", "apiHost", "baseDomain")),
    }


def detect_auth(explicit=""):
    """自动探测可用的登录态；返回不含 token 明文的摘要，找不到返回 None。"""
    for path in _auth_files(explicit):
        try:
            info = _parse_auth_file(path)
        except WorkBuddyError:
            continue
        if not info:
            continue
        try:
            domain = _domain(info["domain"])
        except WorkBuddyError:
            domain = ""
        return {"path": path, "uid": info["uid"], "domain": domain,
                "has_token": True, "mtime": os.path.getmtime(path)}
    return None


# --------------------------------------------------------------------------- 多账号

ACCOUNT_FIELDS = ("uid", "nickname", "source", "auth_file", "token", "refresh_token",
                  "domain", "oauth_domain", "enterprise_id", "login_method",
                  "expires_at", "enabled", "is_default", "remark",
                  "last_balance", "last_check_at", "created_at", "updated_at")
_MIGRATED_KEY = "workbuddy.accounts_migrated"


def ensure_migrated() -> None:
    """旧版单账号配置 → workbuddy_accounts 一次性迁移（幂等，不丢凭据）。"""
    if store_db.get_meta(_MIGRATED_KEY):
        return
    cfg = get_config()
    uid = str(cfg.get("uid") or "").strip() or "legacy"
    with store_db.store_tx() as conn:
        exists = conn.execute("SELECT 1 FROM workbuddy_accounts LIMIT 1").fetchone()
        has_credential = bool(cfg.get("token") or cfg.get("auth_file") or cfg.get("uid"))
        if not exists and has_credential:
            now = time.time()
            conn.execute(
                "INSERT OR REPLACE INTO workbuddy_accounts "
                "(uid, nickname, source, auth_file, token, refresh_token, domain, "
                " oauth_domain, enterprise_id, login_method, expires_at, enabled, "
                " is_default, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (uid, str(cfg.get("nickname") or ""),
                 str(cfg.get("login_method") or cfg.get("source") or ""),
                 str(cfg.get("auth_file") or ""), str(cfg.get("token") or ""),
                 str(cfg.get("refresh_token") or ""), str(cfg.get("domain") or ""),
                 str(cfg.get("oauth_domain") or ""), str(cfg.get("enterprise_id") or ""),
                 str(cfg.get("login_method") or ""), float(cfg.get("expires_at") or 0),
                 1, 1, now, now))
        conn.execute("INSERT OR REPLACE INTO store_meta (key, value) VALUES (?, '1')",
                     (_MIGRATED_KEY,))


def get_account(uid):
    """取账号原始行（含加密后的凭据，仅供服务端内部使用）。"""
    conn = store_db.store_conn()
    try:
        row = conn.execute("SELECT * FROM workbuddy_accounts WHERE uid=?",
                           (str(uid or ""),)).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def public_account(acc) -> dict:
    """脱敏后的账号信息：绝不包含 token / refreshToken 明文或密文。"""
    acc = acc or {}
    uid = str(acc.get("uid") or "")
    exp = float(acc.get("expires_at") or 0)
    return {
        "uid": uid,
        "nickname": acc.get("nickname") or "",
        "display_name": (acc.get("nickname") or acc.get("remark") or uid[:8] or "未命名账号"),
        "source": acc.get("source") or "",
        "login_method": acc.get("login_method") or "",
        "auth_file": acc.get("auth_file") or "",
        "domain": acc.get("domain") or "",
        "oauth_domain": acc.get("oauth_domain") or "",
        "enterprise_id": acc.get("enterprise_id") or "",
        "remark": acc.get("remark") or "",
        "enabled": int(acc.get("enabled") or 0),
        "is_default": int(acc.get("is_default") or 0),
        "token_set": bool(acc.get("token")),
        "refresh_token_set": bool(acc.get("refresh_token")),
        "expires_at": exp,
        "expires_text": time.strftime("%Y-%m-%d %H:%M", time.localtime(exp)) if exp else "",
        "expires_soon": bool(exp and exp - time.time() < 86400),
        "last_balance": acc.get("last_balance"),
        "last_check_at": acc.get("last_check_at") or 0,
        "created_at": acc.get("created_at") or 0,
        "updated_at": acc.get("updated_at") or 0,
    }


def list_accounts() -> list:
    ensure_migrated()
    conn = store_db.store_conn()
    try:
        rows = [dict(r) for r in conn.execute(
            "SELECT * FROM workbuddy_accounts ORDER BY is_default DESC, created_at ASC")]
    finally:
        conn.close()
    return [public_account(r) for r in rows]


def set_current(uid) -> str:
    uid = str(uid or "").strip()
    if uid and not get_account(uid):
        raise WorkBuddyError("账号不存在或已被移除")
    cfg = get_config()
    cfg["current_uid"] = uid
    store_db.set_meta(CONFIG_KEY, json.dumps(cfg, ensure_ascii=False))
    return uid


def current_uid() -> str:
    ensure_migrated()
    uid = str(get_config().get("current_uid") or "").strip()
    if uid and get_account(uid):
        return uid
    accounts = list_accounts()
    if not accounts:
        return ""
    pick = next((a["uid"] for a in accounts if a["is_default"]), accounts[0]["uid"])
    set_current(pick)
    return pick


def save_account(data: dict) -> dict:
    """新增 / 更新一个账号；凭据字段加密，UID 严格校验。"""
    ensure_migrated()
    data = data or {}
    uid = str(data.get("uid") or "").strip()
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", uid):
        raise WorkBuddyError("账号 UID 只能包含字母、数字、下划线、连字符（1-64 位）")
    old = get_account(uid) or {}
    now = time.time()
    acc = {k: old.get(k) for k in ACCOUNT_FIELDS}
    acc["uid"] = uid
    for k in ("nickname", "source", "auth_file", "domain", "oauth_domain",
              "enterprise_id", "login_method", "remark"):
        if k in data:
            acc[k] = str(data[k] or "").strip()[:256]
    if "enabled" in data:
        acc["enabled"] = 1 if data["enabled"] else 0
    if "expires_at" in data:
        try:
            acc["expires_at"] = float(data["expires_at"] or 0)
        except (TypeError, ValueError):
            pass
    for k in ("token", "refresh_token"):
        if k in data:
            v = str(data[k] or "").strip()
            if v == "__clear__":
                acc[k] = ""
            elif v:
                acc[k] = secret.encrypt(v)
    if str(acc.get("domain") or "").strip():
        acc["domain"] = _domain(acc["domain"])
    if str(acc.get("oauth_domain") or "").strip():
        try:
            acc["oauth_domain"] = _domain(acc["oauth_domain"])
        except WorkBuddyError:
            acc["oauth_domain"] = ""
    if "last_balance" in data:
        try:
            acc["last_balance"] = (float(data["last_balance"])
                                   if data["last_balance"] is not None else None)
        except (TypeError, ValueError):
            pass
    acc["created_at"] = float(old.get("created_at") or now)
    acc["updated_at"] = now
    if not old:
        acc["enabled"], acc["is_default"] = 1, 0

    with store_db.store_tx() as conn:
        others = conn.execute(
            "SELECT 1 FROM workbuddy_accounts WHERE is_default=1 AND uid<>? LIMIT 1",
            (uid,)).fetchone()
        make_default = bool(data.get("is_default")) or not others
        if make_default:
            conn.execute("UPDATE workbuddy_accounts SET is_default=0")
            acc["is_default"] = 1
        conn.execute(
            "INSERT OR REPLACE INTO workbuddy_accounts (%s) VALUES (%s)"
            % (", ".join(ACCOUNT_FIELDS), ", ".join("?" for _ in ACCOUNT_FIELDS)),
            tuple(acc.get(k) for k in ACCOUNT_FIELDS))
    if make_default or not str(get_config().get("current_uid") or "").strip():
        set_current(uid)
    return public_account(get_account(uid))


def delete_account(uid) -> list:
    """移除账号；若删的是当前 / 默认账号，自动把剩余账号补位。"""
    uid = str(uid or "").strip()
    if not get_account(uid):
        raise WorkBuddyError("账号不存在或已被移除")
    with store_db.store_tx() as conn:
        conn.execute("DELETE FROM workbuddy_accounts WHERE uid=?", (uid,))
        row = conn.execute(
            "SELECT uid FROM workbuddy_accounts ORDER BY is_default DESC, created_at ASC "
            "LIMIT 1").fetchone()
        if row:
            conn.execute("UPDATE workbuddy_accounts SET is_default=1 WHERE uid=?",
                         (row["uid"],))
    if str(get_config().get("current_uid") or "") == uid:
        set_current(row["uid"] if row else "")
    return list_accounts()


def _account_to_cfg(acc) -> dict:
    """账号行 → resolve_credentials 使用的配置字典（合并全局设置）。"""
    cfg = dict(_DEFAULTS)
    for k in ("source", "auth_file", "token", "refresh_token", "domain",
              "oauth_domain", "enterprise_id", "login_method", "nickname", "uid"):
        cfg[k] = acc.get(k) or ""
    cfg["expires_at"] = float(acc.get("expires_at") or 0)
    cfg["uid"] = acc.get("uid") or ""
    # OAuth / 手动凭据都走「已保存 token」；auto 保留本机文件探测
    if str(cfg["source"]) not in ("auto", "manual"):
        cfg["source"] = "manual"
    g = get_config()
    cfg["proxy"], cfg["timeout"] = g["proxy"], g["timeout"]
    cfg["account_uid"] = acc.get("uid") or ""
    return cfg


# --------------------------------------------------------------------------- 配置

_DEFAULTS = {
    "source": "auto",          # auto = 读本机登录态文件；manual = 用已保存 / 手填凭据
    "auth_file": "",           # 指定登录态文件路径（留空则自动探测）
    "token": "",               # secret.encrypt 后的密文
    "refresh_token": "",       # OAuth 刷新令牌，同样加密
    "uid": "",
    "domain": "",              # 计费接口域名，留空 = 登录态文件里的 domain，兜底 www.codebuddy.cn
    "oauth_domain": "",        # OAuth 返回的 domain，只用于 X-Domain 头（不是请求域名）
    "proxy": "",               # 可选出站代理，留空走系统默认
    "timeout": 15,
    "expires_at": 0.0,         # accessToken 到期时间（Unix 秒）
    "login_method": "",        # oauth / file / manual，仅用于界面显示
    "nickname": "",
    "enterprise_id": "",
    "current_uid": "",        # 当前操作的账号；账号本身存 workbuddy_accounts 表
}
_PUBLIC_KEYS = ("source", "auth_file", "uid", "domain", "oauth_domain", "proxy",
                "timeout", "login_method", "nickname", "enterprise_id", "current_uid")
_SECRET_KEYS = ("token", "refresh_token")
_NUM_KEYS = ("expires_at",)


def get_config() -> dict:
    cfg = dict(_DEFAULTS)
    try:
        doc = json.loads(store_db.get_meta(CONFIG_KEY) or "{}")
        if isinstance(doc, dict):
            for k in _PUBLIC_KEYS + _SECRET_KEYS + _NUM_KEYS:
                if k in doc:
                    cfg[k] = doc[k]
    except (TypeError, ValueError):
        pass
    cfg["source"] = "manual" if str(cfg["source"]) == "manual" else "auto"
    try:
        cfg["timeout"] = max(3, min(60, int(cfg["timeout"])))
    except (TypeError, ValueError):
        cfg["timeout"] = 15
    try:
        cfg["expires_at"] = float(cfg["expires_at"] or 0)
    except (TypeError, ValueError):
        cfg["expires_at"] = 0.0
    return cfg


def save_config(data: dict) -> dict:
    data = data or {}
    cfg = get_config()
    for k in _PUBLIC_KEYS:
        if k in data:
            cfg[k] = data[k] if k == "timeout" else str(data[k]).strip()
    if str(cfg["source"]) not in ("auto", "manual"):
        cfg["source"] = "auto"
    try:
        cfg["timeout"] = max(3, min(60, int(cfg.get("timeout") or 15)))
    except (TypeError, ValueError):
        cfg["timeout"] = 15
    for k in _NUM_KEYS:
        if k in data:
            try:
                cfg[k] = float(data[k] or 0)
            except (TypeError, ValueError):
                pass
    for k in _SECRET_KEYS:
        v = str(data.get(k) or "").strip()
        if v == "__clear__":
            cfg[k] = ""
        elif v:
            cfg[k] = secret.encrypt(v)
    # 域名先校验再落库：避免误把凭据发到第三方
    if str(cfg.get("domain") or "").strip():
        cfg["domain"] = _domain(cfg["domain"])
    store_db.set_meta(CONFIG_KEY, json.dumps(cfg, ensure_ascii=False))
    return public_config()


def public_config() -> dict:
    """给界面看的配置快照：绝不包含 token / refreshToken 明文或密文。"""
    cfg = get_config()
    explicit = str(cfg.get("auth_file") or "").strip()
    detected = detect_auth(explicit)
    exp = float(cfg["expires_at"] or 0)
    out = {k: cfg[k] for k in _PUBLIC_KEYS}
    out.update({
        "token_set": bool(cfg["token"]),
        "token_masked": "已配置 · ******" if cfg["token"] else "",
        "refresh_token_set": bool(cfg["refresh_token"]),
        "expires_at": exp,
        "expires_text": time.strftime("%Y-%m-%d %H:%M", time.localtime(exp)) if exp else "",
        "expires_soon": bool(exp and exp - time.time() < 86400),
        "auth_file_exists": bool(explicit and os.path.isfile(os.path.expanduser(explicit))),
        "detected": detected,
        "default_domain": DEFAULT_DOMAIN,
        "allowed_domains": list(ALLOWED_DOMAINS),
        "auth_dirs": _auth_dirs(),
    })
    # 多账号：把当前账号的展示字段映射到旧字段，现有前端代码无需改动即可兼容
    accounts = list_accounts()
    cur = current_uid()
    acc = get_account(cur) if cur else None
    out["accounts"] = accounts
    out["current_uid"] = cur
    out["account"] = public_account(acc) if acc else None
    if acc:
        pa = out["account"]
        out["uid"] = pa["uid"]
        out["nickname"] = pa["nickname"]
        out["login_method"] = pa["login_method"]
        out["domain"] = pa["domain"]
        out["oauth_domain"] = pa["oauth_domain"]
        out["enterprise_id"] = pa["enterprise_id"]
        out["token_set"] = pa["token_set"]
        out["token_masked"] = "已配置 · ******" if pa["token_set"] else ""
        out["refresh_token_set"] = pa["refresh_token_set"]
        out["expires_at"] = pa["expires_at"]
        out["expires_text"] = pa["expires_text"]
        out["expires_soon"] = pa["expires_soon"]
    return out


def logout(uid=None) -> dict:
    """移除账号（旧接口语义：清除当前账号的登录凭据）。"""
    target = str(uid or "").strip() or current_uid()
    if target:
        delete_account(target)
    return public_config()


def resolve_credentials(uid=None, cfg=None) -> dict:
    """按账号解析出 {token, uid, domain, ...}；失败抛 WorkBuddyError。

    uid 为空时用当前账号；账号表为空时回退旧配置（兼容「只读本机登录态文件」模式）。
    """
    if cfg is None:
        ensure_migrated()
        target = str(uid or "").strip() or current_uid()
        acc = get_account(target) if target else None
        cfg = _account_to_cfg(acc) if acc else get_config()
    if str(cfg.get("login_method") or "") == "oauth":
        cfg = _maybe_refresh(cfg)
    file_info = None
    if str(cfg["source"]) == "auto":
        explicit = str(cfg.get("auth_file") or "").strip()
        for path in _auth_files(explicit):
            try:
                file_info = _parse_auth_file(path)
            except WorkBuddyError:
                continue
            if file_info:
                break
    elif str(cfg.get("auth_file") or "").strip():
        # 手动模式下仍允许指定文件读取 uid / domain，但 token 只用界面填的
        try:
            file_info = _parse_auth_file(os.path.expanduser(str(cfg["auth_file"]).strip()))
        except WorkBuddyError:
            file_info = None

    plain = secret.decrypt(cfg.get("token") or "")
    if str(cfg["source"]) == "manual":
        token, source = plain, "manual"
    elif file_info:
        # 自动模式优先用本机最新登录态（客户端刷新 token 后无需手动更新配置）
        token, source = file_info["token"], "file"
    else:
        # 自动模式没找到文件：回退到扫码登录 / 手动保存的凭据
        token, source = plain, str(cfg.get("login_method") or "manual")
    if not token:
        if str(cfg["source"]) == "manual":
            raise WorkBuddyError("尚未配置 accessToken，请点「扫码登录」或在凭据配置里填写")
        raise WorkBuddyError("未找到 WorkBuddy 登录态。请点「扫码登录」，"
                             "或在凭据配置里指定登录态文件路径 / 直接填写 accessToken")

    raw_domain = str(cfg.get("domain") or "").strip()
    if not raw_domain and file_info:
        raw_domain = file_info.get("domain") or ""
    domain = _domain(raw_domain)
    uid = str(cfg.get("uid") or "").strip()
    if not uid and file_info:
        uid = file_info.get("uid") or ""
    return {"token": token, "uid": uid, "domain": domain, "source": source,
            "auth_file": (file_info or {}).get("path", ""),
            "enterprise_id": str(cfg.get("enterprise_id") or "").strip(),
            "nickname": str(cfg.get("nickname") or "").strip(),
            "login_method": str(cfg.get("login_method") or "").strip(),
            "oauth_domain": str(cfg.get("oauth_domain") or "").strip(),
            "expires_at": float(cfg.get("expires_at") or 0),
            "account_uid": str(cfg.get("account_uid") or cfg.get("uid") or "").strip()}


# --------------------------------------------------------------------------- OAuth 设备授权登录

def _jwt_uid(token: str) -> str:
    """账号接口拿不到 uid 时，从 JWT payload 里兜底解析。"""
    try:
        part = token.split(".")[1]
        part += "=" * (-len(part) % 4)
        payload = json.loads(base64.urlsafe_b64decode(part).decode("utf-8", "replace"))
        return str(payload.get("uid") or payload.get("user_id") or payload.get("sub") or "")
    except Exception:
        return ""


def _oauth_request(method, url, realm="cn", bearer="", body=None, extra=None) -> tuple:
    """调用 OAuth 设备授权端点，返回 (code, msg, data)。

    上游统一信封 {code, msg, data}：code!=0（如 11217 "login ing..."）表示尚未授权，
    由 login_poll 判定为「等待扫码」，其它异常抛 WorkBuddyError。
    """
    origin = OAUTH_ORIGIN.get(realm) or OAUTH_ORIGIN["cn"]
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/plain, */*",
        "X-Requested-With": "XMLHttpRequest",
        "Origin": origin,
        "Referer": origin + "/",
        "User-Agent": OAUTH_UA,
    }
    if bearer:
        headers["Authorization"] = "Bearer " + bearer
    if extra:
        headers.update(extra)
    req = urllib.request.Request(url, data=body, method=method, headers=headers)
    status, raw = 200, b""
    try:
        proxy = str(get_config().get("proxy") or "").strip()
        opener = (proxyutil.build_opener(proxy=proxy) if proxy
                  else urllib.request.build_opener())
        resp = opener.open(req, timeout=20)
        status = getattr(resp, "status", 200) or 200
        raw = resp.read(1024 * 1024)
    except urllib.error.HTTPError as e:
        status = e.code
        try:
            raw = e.read(1024 * 1024)
        except Exception:
            raw = b""
    except Exception as e:
        raise WorkBuddyError("连接 WorkBuddy 登录服务失败：%s"
                             % proxyutil.friendly_error(e, url))
    try:
        obj = json.loads(raw.decode("utf-8", "replace"))
    except (TypeError, ValueError):
        obj = {}
    if not isinstance(obj, dict):
        obj = {}
    code = obj.get("code", 0)
    msg = str(obj.get("msg") or obj.get("message") or "")
    data = obj.get("data")
    if status >= 300:
        raise WorkBuddyError("登录服务返回 HTTP %s：%s" % (status, msg or "请求失败"))
    if not isinstance(data, dict):
        data = obj if code in (0, "0", None) else {}
    return code, msg, data


def login_start(realm="cn") -> dict:
    """发起设备授权：返回授权 URL / state / 二维码地址（state 只在内存里存 10 分钟）。"""
    realm = "global" if realm == "global" else "cn"
    code, msg, data = _oauth_request(
        "POST", OAUTH_BASE[realm] + OAUTH_STATE_PATH, realm=realm, body=b"{}")
    state = str(_pick(data, ("state",))[0] or "").strip()
    url = str(_pick(data, ("authUrl", "auth_url", "url"))[0] or "").strip()
    if not state or not url:
        raise WorkBuddyError("发起登录失败：%s" % (msg or "未拿到授权链接"))
    now = time.time()
    with _LOGIN_LOCK:
        for k in [k for k, v in _LOGINS.items() if now - v["created"] > LOGIN_TTL]:
            _LOGINS.pop(k, None)
        _LOGINS[state] = {"realm": realm, "created": now, "url": url}
    return {"ok": True, "state": state, "url": url, "realm": realm,
            "qr": "/api/workbuddy/login/qr?state=" + urllib.parse.quote(state)}


def login_poll(state) -> dict:
    """轮询授权结果；完成后取账号信息并把凭据加密写入配置。"""
    state = str(state or "").strip()
    with _LOGIN_LOCK:
        sess = _LOGINS.get(state)
    if not sess:
        raise WorkBuddyError("登录会话不存在或已过期，请重新发起扫码登录")
    if time.time() - sess["created"] > LOGIN_TTL:
        login_cancel(state)
        raise WorkBuddyError("登录会话已超时，请重新发起扫码登录")
    realm, base = sess["realm"], OAUTH_BASE[sess["realm"]]
    enc_state = urllib.parse.quote(state)
    code, msg, data = _oauth_request("GET", base + OAUTH_TOKEN_PATH + enc_state, realm=realm)
    token = str(_pick(data, ("accessToken", "access_token", "token"))[0] or "").strip()
    if code not in (0, "0", None) or not token:
        return {"done": False, "message": "等待扫码登录…" if "ing" in msg.lower()
                else (msg or "等待授权…")}
    refresh = str(_pick(data, ("refreshToken", "refresh_token"))[0] or "").strip()
    expires_in = float(_num(_pick(data, ("expiresIn", "expires_in", "expires"))[0], 0) or 0)
    domain = str(_pick(data, ("domain",))[0] or "").strip()

    uid = nickname = ent = ""
    try:
        _, _, account = _oauth_request(
            "GET", base + OAUTH_ACCOUNT_PATH + enc_state, realm=realm, bearer=token)
        uid = str(_pick(account, ("uid", "userId", "user_id"))[0] or "").strip()
        nickname = str(_pick(account, ("nickname", "name"))[0] or "").strip()
        ent = str(_pick(account, ("enterpriseId", "enterprise_id"))[0] or "").strip()
        domain = domain or str(_pick(account, ("domain",))[0] or "").strip()
    except Exception as e:
        _log.warning("WorkBuddy 账号信息读取失败：%s", e)
    if not uid:
        uid = _jwt_uid(token)
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", uid or ""):
        raise WorkBuddyError("登录成功但账号 UID 无效，请重新扫码登录")

    saved = {"uid": uid, "source": "oauth", "login_method": "oauth", "token": token,
             "refresh_token": refresh, "nickname": nickname, "enterprise_id": ent,
             "expires_at": (time.time() + expires_in) if expires_in else 0}
    # OAuth 返回的是授权服务域（如 copilot.tencent.com），只作 X-Domain 头；
    # 签到 / 余额接口仍打 www.codebuddy.cn，不能用授权域当请求域名。
    if domain:
        try:
            saved["oauth_domain"] = _domain(domain)
        except WorkBuddyError:
            pass
    acc = save_account(saved)          # 同 UID 重新扫码 = 更新凭据，不会重复建档
    set_current(uid)                   # 新登录的账号自动成为当前账号
    login_cancel(state)
    _log.info("WorkBuddy 扫码登录完成（uid 已隐藏）")
    return {"done": True, "uid": uid, "nickname": nickname,
            "expires_at": acc["expires_at"], "expires_text": acc["expires_text"],
            "account": acc}


def login_qr_image(state):
    """把授权链接画成二维码 SVG（用微信「扫一扫」即可打开登录页）。

    特意用 qrcode 的 SVG 后端：不依赖 Pillow，系统 Python / 虚拟环境都能生成。
    """
    state = str(state or "").strip()
    with _LOGIN_LOCK:
        sess = _LOGINS.get(state)
    if not sess:
        raise WorkBuddyError("登录会话已过期，请重新发起扫码登录")
    import qrcode
    import qrcode.image.svg
    img = qrcode.make(sess["url"], image_factory=qrcode.image.svg.SvgPathImage)
    buf = io.BytesIO()
    img.save(buf)
    return buf.getvalue(), "image/svg+xml"


def login_cancel(state) -> None:
    with _LOGIN_LOCK:
        _LOGINS.pop(str(state or "").strip(), None)


def refresh_login(uid=None, force=False) -> dict:
    """用指定账号的 refreshToken 换新 accessToken（带 X-Refresh-Token 头）。"""
    global _last_refresh_try
    ensure_migrated()
    target = str(uid or "").strip() or current_uid()
    acc = get_account(target) if target else None
    if not acc:
        raise WorkBuddyError("账号不存在，请先添加账号")
    refresh = secret.decrypt(acc.get("refresh_token") or "")
    if not refresh:
        raise WorkBuddyError("该账号没有可用的刷新令牌，请重新扫码登录")
    realm = "global" if "workbuddy.ai" in str(
        acc.get("oauth_domain") or acc.get("domain") or "") else "cn"
    access = secret.decrypt(acc.get("token") or "")
    code, msg, data = _oauth_request(
        "POST", OAUTH_BASE[realm] + OAUTH_REFRESH_PATH, realm=realm,
        bearer=access, body=json.dumps({"refreshToken": refresh}).encode(),
        extra={"X-Refresh-Token": refresh})
    token = str(_pick(data, ("accessToken", "access_token", "token"))[0] or "").strip()
    if not token:
        raise WorkBuddyError("刷新登录态失败：%s" % (msg or "接口未返回新令牌"))
    expires_in = float(_num(_pick(data, ("expiresIn", "expires_in"))[0], 0) or 0)
    upd = {"uid": target, "token": token,
           "expires_at": (time.time() + expires_in) if expires_in else 0}
    new_refresh = str(_pick(data, ("refreshToken", "refresh_token"))[0] or "").strip()
    if new_refresh:
        upd["refresh_token"] = new_refresh
    saved = save_account(upd)
    _last_refresh_try = time.time()
    return {"ok": True, "uid": target, "expires_at": saved["expires_at"],
            "expires_text": saved["expires_text"]}


def _maybe_refresh(cfg) -> dict:
    """accessToken 临近过期时自动刷新一次；失败不阻断查询（继续用旧 token）。"""
    global _last_refresh_try
    exp = float(cfg.get("expires_at") or 0)
    uid = str(cfg.get("account_uid") or "")
    if not uid or not exp or exp - time.time() > 600:
        return cfg
    if not secret.decrypt(cfg.get("refresh_token") or ""):
        return cfg
    if time.time() - _last_refresh_try < 300:
        return cfg
    with _REFRESH_LOCK:
        _last_refresh_try = time.time()
        try:
            refresh_login(uid=uid)
        except Exception as e:
            _log.warning("WorkBuddy 登录态自动刷新失败：%s", e)
    acc = get_account(uid)
    return _account_to_cfg(acc) if acc else cfg


# --------------------------------------------------------------------------- 接口

def _request(creds: dict, path: str, method="POST") -> dict:
    """调用一次官方接口；HTTP 错误也解析响应体（「今天已签到」常以 400 返回）。"""
    host = _domain(creds.get("domain"))
    url = "https://" + host + path
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Authorization": "Bearer " + creds["token"],
        "User-Agent": "Mozilla/5.0 (WorkBuddy Credits)",
        "X-Client-Platform": "web",
    }
    if creds.get("uid"):
        headers["X-User-Id"] = str(creds["uid"])
    # 企业账号：签到 / 余额接口按这两个头归属企业（参考 workbuddy2api-panel）
    if creds.get("enterprise_id"):
        headers["X-Enterprise-Id"] = str(creds["enterprise_id"])
        headers["X-Tenant-Id"] = str(creds["enterprise_id"])
    xdomain = creds.get("oauth_domain") or creds.get("domain") or ""
    if xdomain:
        headers["X-Domain"] = str(xdomain)
    body = b"{}" if method == "POST" else None
    req = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        proxy = str((get_config().get("proxy") or "")).strip()
        opener = (proxyutil.build_opener(proxy=proxy) if proxy
                  else urllib.request.build_opener())
    except ValueError as e:
        raise WorkBuddyError("代理配置有误：%s" % e)
    status, raw = 200, b""
    try:
        resp = opener.open(req, timeout=int(creds.get("timeout") or 15))
        status = getattr(resp, "status", 200) or 200
        raw = resp.read(1024 * 512)
    except urllib.error.HTTPError as e:
        status = e.code
        try:
            raw = e.read(1024 * 512)
        except Exception:
            raw = b""
    except Exception as e:
        raise WorkBuddyError("连接 WorkBuddy 接口失败：%s"
                             % proxyutil.friendly_error(e, url))
    text = raw.decode("utf-8", "replace")
    try:
        obj = json.loads(text)
    except (TypeError, ValueError):
        obj = {}
    msg = _message(obj) or text[:160]
    code = None
    if isinstance(obj, dict):
        for k in ("code", "Code", "errCode", "errcode", "ret", "status"):
            if k in obj and not isinstance(obj[k], (dict, list)):
                code = obj[k]
                break
    ok_code = code is None or str(code) in ("0", "200", "success", "OK")
    if status >= 400 or not ok_code:
        if _already(code, msg, text):
            return {"status": status, "json": obj, "message": "今天已签到，请明天再来",
                    "already": True}
        raise WorkBuddyError("WorkBuddy 接口返回 HTTP %s%s：%s"
                             % (status, "" if ok_code else " / code=%s" % code,
                                msg or "无响应内容"))
    return {"status": status, "json": obj, "message": msg, "already": False}


def fetch_status(creds: dict) -> dict:
    """今日签到状态 + 连签 / 活动信息。"""
    res = _request(creds, PATH_STATUS)
    obj = res["json"]
    out = {}
    for key, names in _STATUS_KEYS.items():
        out[key] = _pick(obj, names)[0]
    out["today_checked_in"] = _bool(out["today_checked_in"])
    out["streak_days"] = int(_num(out["streak_days"], 0) or 0)
    out["today_credit"] = _num(out["today_credit"], 0) or 0
    out["total_credits"] = _num(out["total_credits"], 0) or 0
    out["start_time"] = _time_text(out["start_time"])
    out["end_time"] = _time_text(out["end_time"])
    out["already"] = res["already"]
    if res["already"] and out["today_checked_in"] is None:
        out["today_checked_in"] = True
    _log.info("WorkBuddy 签到状态查询完成（HTTP %s）", res["status"])
    return out


def fetch_credits(creds: dict) -> dict:
    """积分余额（不同版本字段名不一致，按候选名逐个兼容）。"""
    res = _request(creds, PATH_CREDITS)
    obj = res["json"]
    balance, key = _pick(obj, _BALANCE_KEYS)
    used, _ = _pick(obj, _USED_KEYS)
    total, _ = _pick(obj, _TOTAL_KEYS)
    out = {
        "balance": _num(balance),
        "used": _num(used, 0) or 0,
        "total": _num(total),
        "balance_key": key,
        "expire_at": _time_text(_pick(obj, ("expireTime", "expire_time", "endTime", "end_time"))[0]),
    }
    if out["balance"] is None:
        out["error"] = "接口响应里未找到积分余额字段（%s）" % (key or "字段名可能已变更")
    _log.info("WorkBuddy 积分余额查询完成（HTTP %s）", res["status"])
    return out


def do_checkin(creds: dict, source="manual") -> dict:
    """执行签到（幂等）：先查状态，已签到就不再发起领取请求。"""
    status = {}
    try:
        status = fetch_status(creds)
    except WorkBuddyError as e:
        _log.warning("签到前状态查询失败，继续尝试领取：%s", e)
    if status.get("today_checked_in") is True:
        result = {"ok": True, "status": "already", "message": "今天已签到，请明天再来",
                  "credit": 0, "streak_days": status.get("streak_days") or 0}
        _record(creds, result, source)
        return result

    res = _request(creds, PATH_CHECKIN)
    obj = res["json"]
    if res["already"]:
        result = {"ok": True, "status": "already", "message": res["message"],
                  "credit": 0, "streak_days": int(_num(_pick(obj, _STATUS_KEYS["streak_days"])[0], 0) or 0)}
    else:
        credit, _ = _pick(obj, _STATUS_KEYS["today_credit"] + ("rewardCredits", "amount", "credits"))
        streak, _ = _pick(obj, _STATUS_KEYS["streak_days"])
        result = {"ok": True, "status": "success", "message": "签到成功，积分已到账",
                  "credit": _num(credit, 0) or 0,
                  "streak_days": int(_num(streak, status.get("streak_days") or 0) or 0)}
    _record(creds, result, source)
    _log.info("WorkBuddy 签到完成：%s（来源 %s）", result["status"], source)
    return result


# --------------------------------------------------------------------------- 记录

def _record(creds: dict, result: dict, source: str) -> None:
    """一天一账号一条记录（重复点击只覆盖同一行，不会刷屏）。"""
    day = time.strftime("%Y-%m-%d")
    try:
        with store_db.store_tx() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO workbuddy_checkin "
                "(day, uid, status, credit, streak_days, message, source, at) "
                "VALUES (?,?,?,?,?,?,?,?)",
                (day, str(creds.get("uid") or ""), result["status"],
                 float(result.get("credit") or 0), int(result.get("streak_days") or 0),
                 result.get("message") or "", source, time.time()))
    except Exception as e:
        _log.warning("WorkBuddy 签到记录写入失败：%s", e)


def list_history(q="", page=1, size=10, limit=None, sort="", order="", uid=None) -> dict:
    """签到记录（默认按日期倒序）；uid 可按账号筛选，limit 供日历取最近 N 条。"""
    conn = None
    try:
        conn = store_db.store_conn()
        rows = [dict(r) for r in conn.execute(
            "SELECT * FROM workbuddy_checkin ORDER BY day DESC, at DESC")]
    except Exception as e:
        _log.warning("WorkBuddy 签到记录读取失败：%s", e)
        return {"items": [], "total": 0}
    finally:
        if conn is not None:
            conn.close()
    out = []
    for r in rows:
        out.append({
            "day": r["day"], "at": r["at"],
            "at_text": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(r["at"] or 0)),
            "uid": r["uid"], "status": r["status"],
            "status_text": {"success": "签到成功", "already": "今日已签"}.get(r["status"], r["status"]),
            "credit": r["credit"], "streak_days": r["streak_days"],
            "message": r["message"], "source": r["source"],
        })
    if uid:
        out = [r for r in out if r["uid"] == str(uid)]
    if q:
        low = str(q).lower()
        out = [r for r in out if low in " ".join(str(v) for v in r.values()).lower()]
    if str(sort) in ("day", "at", "at_text", "status", "status_text", "credit",
                     "streak_days", "message", "source", "uid"):
        def _key(r):
            v = r.get(sort)
            return (0, float(v)) if isinstance(v, (int, float)) else (1, str(v or ""))
        out.sort(key=_key, reverse=str(order).lower() == "desc")
    total = len(out)
    if limit:
        out = out[:int(limit)]
    else:
        page = max(1, int(page or 1))
        size = max(1, min(500, int(size or 10)))
        out = out[(page - 1) * size:page * size]
    return {"items": out, "total": total}


# --------------------------------------------------------------------------- 汇总

def _update_balance(uid, balance) -> None:
    """缓存账号最近一次查到的余额，供账号列表展示（不影响主流程）。"""
    try:
        with store_db.store_tx() as conn:
            conn.execute(
                "UPDATE workbuddy_accounts SET last_balance=?, last_check_at=? WHERE uid=?",
                (float(balance), time.time(), str(uid)))
    except Exception as e:
        _log.warning("WorkBuddy 余额缓存写入失败：%s", e)


def overview(uid=None) -> dict:
    """首屏：指定账号的余额 / 签到状态 + 全部账号列表 + 该账号最近记录。"""
    ensure_migrated()
    target = str(uid or "").strip() or current_uid()
    acc = get_account(target) if target else None
    out = {"ok": True, "config": public_config(), "today": time.strftime("%Y-%m-%d"),
           "updated_at": time.time(), "status": None, "credits": None,
           "errors": {}, "history_recent": [], "accounts": list_accounts(),
           "current_uid": target, "account": public_account(acc) if acc else None}
    if not acc:
        out["configured"] = False
        out["error"] = "尚未添加 WorkBuddy 账号，请点「添加账号」扫码登录"
        return out
    try:
        creds = resolve_credentials(target)
    except WorkBuddyError as e:
        out["configured"] = False
        out["error"] = str(e)
        out["history_recent"] = list_history(limit=30, uid=target)["items"]
        return out
    out["configured"] = True
    out["credential"] = {"source": creds["source"], "domain": creds["domain"],
                         "uid": creds["uid"], "auth_file": creds["auth_file"],
                         "login_method": creds.get("login_method", ""),
                         "nickname": creds.get("nickname", ""),
                         "expires_at": creds.get("expires_at", 0),
                         "account_uid": target}
    creds["timeout"] = get_config()["timeout"]
    with ThreadPoolExecutor(max_workers=2) as pool:
        jobs = {"status": pool.submit(fetch_status, creds),
                "credits": pool.submit(fetch_credits, creds)}
        for key, job in jobs.items():
            try:
                out[key] = job.result()
            except Exception as e:
                out["errors"][key] = str(e)
    if out["credits"] and out["credits"].get("balance") is not None:
        _update_balance(target, out["credits"]["balance"])
    out["history_recent"] = list_history(limit=30, uid=target)["items"]
    return out


def test_connection(uid=None) -> dict:
    """只查询签到状态，不领取积分：用于验证指定账号的凭据是否可用。"""
    creds = resolve_credentials(uid)
    creds["timeout"] = get_config()["timeout"]
    return {"ok": True, "credential": {"domain": creds["domain"], "uid": creds["uid"],
                                       "source": creds["source"],
                                       "account_uid": creds.get("account_uid", "")},
            "status": fetch_status(creds)}


# --------------------------------------------------------------------------- 批量操作

def _checkin_one(uid, nickname="") -> dict:
    creds = resolve_credentials(uid)
    creds["timeout"] = get_config()["timeout"]
    result = do_checkin(creds, source="auto")
    return {"uid": uid, "nickname": nickname, "ok": True, **result}


def _refresh_one(uid, nickname="") -> dict:
    creds = resolve_credentials(uid)
    creds["timeout"] = get_config()["timeout"]
    cr = fetch_credits(creds)
    if cr.get("balance") is not None:
        _update_balance(uid, cr["balance"])
        return {"uid": uid, "nickname": nickname, "ok": True, "status": "success",
                "balance": cr["balance"]}
    return {"uid": uid, "nickname": nickname, "ok": False, "status": "failed",
            "message": cr.get("error") or "未取得余额"}


def _run_all(worker) -> dict:
    """并发跑一遍所有启用账号；单账号失败不影响其它账号。"""
    accounts = [a for a in list_accounts() if a["enabled"]]
    if not accounts:
        return {"ok": True, "items": [],
                "summary": {"total": 0, "success": 0, "already": 0, "failed": 0, "credit": 0}}
    items = []
    with ThreadPoolExecutor(max_workers=min(3, len(accounts))) as pool:
        jobs = {a["uid"]: pool.submit(worker, a["uid"], a["display_name"])
                for a in accounts}
        for uid, job in jobs.items():
            try:
                items.append(job.result())
            except Exception as e:
                items.append({"uid": uid, "ok": False, "status": "failed",
                              "message": str(e), "credit": 0})
    summary = {"total": len(items), "success": 0, "already": 0, "failed": 0, "credit": 0}
    for it in items:
        status = "failed" if not it.get("ok") else it.get("status")
        if status == "success":
            summary["success"] += 1
        elif status == "already":
            summary["already"] += 1
        else:
            summary["failed"] += 1
        summary["credit"] += float(it.get("credit") or 0)
    return {"ok": True, "items": items, "summary": summary}


def checkin_all() -> dict:
    """全部启用账号逐个签到（幂等，已签到自动跳过）。"""
    return _run_all(_checkin_one)


def refresh_all() -> dict:
    """全部启用账号刷新积分余额并缓存。"""
    return _run_all(_refresh_one)

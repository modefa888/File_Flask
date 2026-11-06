"""Trae CN 积分 / 签到业务层。

原理
----
Trae 国内版客户端的「每日签到领积分」本质是带 Cloud-IDE-Token 登录态的 HTTPS
请求（api.trae.cn）。本模块的凭据来源为界面手动填写（来源与获取方式见前端
「添加账号」弹窗里的说明）：

  * token：Cloud-IDE-Token（JWT，约 14 天有效；客户端 F12 / 网页 localStorage 可取）；
  * device_id：Trae 客户端设备号（claim 接口必需，缺失报 code=9004、
    服务端不认报 code=9074）。可手动填写，也可通过「网站连接登录 /
    自动获取设备号」从本机 Trae 登录态读取（桌面 storage.json 的
    iCubeAuthInfo://icube-dc: 数字后缀，或 CLI ~/.trae-cn/argv.json 的
    crash-reporter-id）。

接口契约（响应为扁平 JSON，code==0 表示成功）：

    POST /trae/api/v2/ug/checkin_credits/status     今日签到状态 / 单日奖励
         {"checked_in": false, "credits": 150, "extra_credits": 50, ...}
         —— 注意判定字段是 checked_in（did_checked_in 是干扰项）
    POST /trae/api/v2/ug/checkin_credits/claim      领取当日积分（幂等）
         成功 {"code": 0, "message": "success"}，无金额字段，奖励金额以 status 为准
    POST /trae/api/v2/pay/ide_user_ent_usage        可用积分余额
         {"usage_summary": {"total_amount": x, "consumed_amount": y, ...}}
         可用积分 = total_amount - consumed_amount

请求头：Authorization: Cloud-IDE-JWT <token>（scheme 前缀在值里）、
x-device-id（claim 必需）、x-user-id / X-User-Region（建议带上）。

安全约定
--------
  * token 等同账号密码：落库前用 secret.encrypt 加密，接口一律不回显；
  * 请求域名固定为官方 api.trae.cn，不接受自定义域名，避免把凭据发往别处；
  * 签到前先查状态，已签到直接跳过（幂等）；限流返回 HTTP 200 + 业务码
    （9074/429），必须检查 body 里的 code 而不是只看 HTTP 状态。

多账号
------
每个账号一行存 traecn_accounts（token 加密），「当前账号」放
store_meta['traecn.config']。签到记录写 traecn_checkin（按 日期 + uid 唯一）。
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import platform
import re
import sqlite3
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

from ...log import get_logger
from ..common import proxyutil, secret, store_db

_log = get_logger()

CONFIG_KEY = "traecn.config"
API_BASE = "https://api.trae.cn"
HOST = "api.trae.cn"

PATH_STATUS = "/trae/api/v2/ug/checkin_credits/status"
PATH_CLAIM = "/trae/api/v2/ug/checkin_credits/claim"
PATH_USAGE = "/trae/api/v2/pay/ide_user_ent_usage"
# 网页版用量接口：与 ide_user_ent_usage 同源，额外带订阅权益（用于「模型与档位」的档位解析）
PATH_USAGE_WEB = "/trae/api/v2/pay/web_user_ent_usage"

AUTH_SCHEME = "Cloud-IDE-JWT"
USER_AGENT = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")

# 业务错误码 → 可读说明（HTTP 层面仍是 200，必须查 body 里的 code）
CODE_HINTS = {
    9004: "缺少 x-device-id 请求头（设备号未配置）",
    9074: "设备号未被服务端接受，或接口偶发拥堵（连续多次请重新获取 device_id）",
    1001: "认证失败：Authorization 值需为「Cloud-IDE-JWT <token>」，且 token 未过期",
}


class TraeError(Exception):
    """可直接展示给用户的业务错误。"""


ACCOUNT_FIELDS = ("uid", "nickname", "token", "device_id", "user_region", "source",
                  "expires_at", "enabled", "is_default", "remark", "last_balance",
                  "last_check_at", "created_at", "updated_at")

_DEFAULTS = {
    "timeout": 15,
    "proxy": "",               # 可选出站代理，留空走系统默认
    "current_uid": "",         # 当前操作的账号；账号本身存 traecn_accounts 表
}


# --------------------------------------------------------------------------- 配置

def get_config() -> dict:
    cfg = dict(_DEFAULTS)
    try:
        doc = json.loads(store_db.get_meta(CONFIG_KEY) or "{}")
        if isinstance(doc, dict):
            for k in _DEFAULTS:
                if k in doc:
                    cfg[k] = doc[k]
    except (TypeError, ValueError):
        pass
    try:
        cfg["timeout"] = max(3, min(60, int(cfg["timeout"])))
    except (TypeError, ValueError):
        cfg["timeout"] = 15
    cfg["proxy"] = str(cfg.get("proxy") or "").strip()
    cfg["current_uid"] = str(cfg.get("current_uid") or "").strip()
    return cfg


def save_config(data: dict) -> dict:
    data = data or {}
    cfg = get_config()
    if "timeout" in data:
        try:
            cfg["timeout"] = max(3, min(60, int(data["timeout"])))
        except (TypeError, ValueError):
            pass
    if "proxy" in data:
        cfg["proxy"] = str(data["proxy"] or "").strip()
    store_db.set_meta(CONFIG_KEY, json.dumps(cfg, ensure_ascii=False))
    return cfg


def public_config() -> dict:
    cfg = get_config()
    out = dict(cfg)
    out["accounts"] = list_accounts()
    out["current_uid"] = current_uid()
    return out


# --------------------------------------------------------------------------- JWT 工具

def _jwt_payload(token: str) -> dict:
    """解析 JWT 的 payload 段（不验签，仅用于取 uid / 过期时间展示）。"""
    try:
        seg = str(token or "").strip().split(".")
        if len(seg) < 2:
            return {}
        pad = seg[1] + "=" * (-len(seg[1]) % 4)
        obj = json.loads(base64.urlsafe_b64decode(pad.encode()).decode("utf-8", "replace"))
        return obj if isinstance(obj, dict) else {}
    except Exception:
        return {}


def _jwt_exp(token: str) -> float:
    try:
        return float(_jwt_payload(token).get("exp") or 0)
    except (TypeError, ValueError):
        return 0.0


def _jwt_uid(token: str) -> str:
    """从 JWT payload 里探测用户标识（字段名以客户端实现为准，逐个候选尝试）。"""
    p = _jwt_payload(token)
    for k in ("user_id", "userId", "uid", "user", "sub", "id"):
        v = p.get(k)
        if v is not None and str(v).strip():
            return str(v).strip()[:64]
    return ""


def _mask_token(token: str) -> str:
    """JWT 是整段生效的登录态，不回显任何前缀片段。"""
    return "已配置 · ******"


# --------------------------------------------------------------------------- 账号

def get_account(uid):
    """取账号原始行（含加密后的凭据，仅供服务端内部使用）。"""
    conn = store_db.store_conn()
    try:
        row = conn.execute("SELECT * FROM traecn_accounts WHERE uid=?",
                           (str(uid or ""),)).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def public_account(acc) -> dict:
    """脱敏后的账号信息：绝不包含 token 明文或密文。"""
    acc = acc or {}
    uid = str(acc.get("uid") or "")
    exp = float(acc.get("expires_at") or 0)
    return {
        "uid": uid,
        "nickname": acc.get("nickname") or "",
        "display_name": (acc.get("nickname") or acc.get("remark") or uid[:8] or "未命名账号"),
        "source": acc.get("source") or "manual",
        "device_id_set": bool(acc.get("device_id")),
        "remark": acc.get("remark") or "",
        "enabled": int(acc.get("enabled") or 0),
        "is_default": int(acc.get("is_default") or 0),
        "token_set": bool(acc.get("token")),
        "token_masked": _mask_token(secret.decrypt(acc.get("token"))) if acc.get("token") else "",
        "expires_at": exp,
        "expires_text": time.strftime("%Y-%m-%d %H:%M", time.localtime(exp)) if exp else "",
        "expires_soon": bool(exp and exp - time.time() < 86400),
        "last_balance": acc.get("last_balance"),
        "last_check_at": acc.get("last_check_at") or 0,
        "created_at": acc.get("created_at") or 0,
        "updated_at": acc.get("updated_at") or 0,
    }


def list_accounts() -> list:
    conn = store_db.store_conn()
    try:
        rows = [dict(r) for r in conn.execute(
            "SELECT * FROM traecn_accounts ORDER BY is_default DESC, created_at ASC")]
    finally:
        conn.close()
    return [public_account(r) for r in rows]


def set_current(uid) -> str:
    uid = str(uid or "").strip()
    if uid and not get_account(uid):
        raise TraeError("账号不存在或已被移除")
    cfg = get_config()
    cfg["current_uid"] = uid
    store_db.set_meta(CONFIG_KEY, json.dumps(cfg, ensure_ascii=False))
    return uid


def current_uid() -> str:
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
    """新增 / 更新一个账号；token 加密落库，uid / 过期时间尽量从 JWT 自动解析。"""
    data = data or {}
    token = str(data.get("token") or "").strip()
    if token == "__clear__":
        token = ""
    uid = str(data.get("uid") or "").strip() or _jwt_uid(token)
    if not uid and token:
        # Trae 的 userId 不在 JWT payload 里（与 token 平级存在 storage.json），
        # JWT 解析不出标识时用 Token 指纹兜底：同一段 token 结果稳定，重复添加即覆盖更新。
        uid = "tok_" + hashlib.sha256(token.encode("utf-8")).hexdigest()[:16]
    if not uid:
        raise TraeError("缺少账号标识：请填写 Cloud-IDE-Token（或手动填 UID）")
    if not re.fullmatch(r"[A-Za-z0-9_.@-]{1,128}", uid):
        raise TraeError("账号 UID 只能包含字母、数字、下划线、点、@、连字符（1-128 位）")
    old = get_account(uid) or {}
    now = time.time()
    acc = {k: old.get(k) for k in ACCOUNT_FIELDS}
    acc["uid"] = uid
    for k in ("nickname", "remark"):
        if k in data:
            acc[k] = str(data[k] or "").strip()[:256]
    if "user_region" in data and str(data["user_region"] or "").strip():
        acc["user_region"] = str(data["user_region"]).strip()[:16]
    if "enabled" in data:
        acc["enabled"] = 1 if data["enabled"] else 0
    if "device_id" in data:
        acc["device_id"] = str(data["device_id"] or "").strip()[:128]
    if token:
        acc["token"] = secret.encrypt(token)
        acc["expires_at"] = _jwt_exp(token) or float(old.get("expires_at") or 0)
        _src = str(data.get("source") or "manual").strip()[:16]
        acc["source"] = _src or "manual"
        if not str(acc.get("nickname") or "").strip():
            # JWT 里可能带昵称 / 邮箱，拿得到就自动补一个可读名字
            p = _jwt_payload(token)
            for k in ("nickname", "name", "email", "username"):
                v = p.get(k)
                if v and str(v).strip():
                    acc["nickname"] = str(v).strip()[:64]
                    break
    if "expires_at" in data:
        try:
            acc["expires_at"] = float(data["expires_at"] or 0) or acc.get("expires_at") or 0
        except (TypeError, ValueError):
            pass
    if "last_balance" in data:
        try:
            acc["last_balance"] = (float(data["last_balance"])
                                   if data["last_balance"] is not None else None)
        except (TypeError, ValueError):
            pass
    acc["created_at"] = float(old.get("created_at") or now)
    acc["updated_at"] = now
    if not old:
        acc["enabled"], acc["is_default"] = acc.get("enabled", 1) or 1, 0

    with store_db.store_tx() as conn:
        others = conn.execute(
            "SELECT 1 FROM traecn_accounts WHERE is_default=1 AND uid<>? LIMIT 1",
            (uid,)).fetchone()
        make_default = bool(data.get("is_default")) or not others
        if make_default:
            conn.execute("UPDATE traecn_accounts SET is_default=0")
            acc["is_default"] = 1
        conn.execute(
            "INSERT OR REPLACE INTO traecn_accounts (%s) VALUES (%s)"
            % (", ".join(ACCOUNT_FIELDS), ", ".join("?" for _ in ACCOUNT_FIELDS)),
            tuple(acc.get(k) for k in ACCOUNT_FIELDS))
    if make_default or not str(get_config().get("current_uid") or "").strip():
        set_current(uid)
    return public_account(get_account(uid))


def delete_account(uid) -> list:
    """移除账号；若删的是当前 / 默认账号，自动把剩余账号补位。"""
    uid = str(uid or "").strip()
    if not get_account(uid):
        raise TraeError("账号不存在或已被移除")
    with store_db.store_tx() as conn:
        conn.execute("DELETE FROM traecn_accounts WHERE uid=?", (uid,))
        row = conn.execute(
            "SELECT uid FROM traecn_accounts ORDER BY is_default DESC, created_at ASC "
            "LIMIT 1").fetchone()
        if row:
            conn.execute("UPDATE traecn_accounts SET is_default=1 WHERE uid=?",
                         (row["uid"],))
    if str(get_config().get("current_uid") or "") == uid:
        set_current(row["uid"] if row else "")
    return list_accounts()


def resolve_credentials(uid=None) -> dict:
    """按账号解析出 {token, device_id, uid, ...}；失败抛 TraeError。"""
    target = str(uid or "").strip() or current_uid()
    if not target:
        raise TraeError("尚未添加 Trae CN 账号，请点「添加账号」填写 Cloud-IDE-Token")
    acc = get_account(target)
    if not acc:
        raise TraeError("账号不存在或已被移除")
    token = secret.decrypt(acc.get("token"))
    if not token:
        raise TraeError("该账号未配置 Cloud-IDE-Token，请编辑账号重新填写")
    cfg = get_config()
    return {
        "account_uid": target,
        "uid": target,
        "token": token,
        "device_id": str(acc.get("device_id") or "").strip(),
        "user_region": str(acc.get("user_region") or "cn").strip() or "cn",
        "expires_at": float(acc.get("expires_at") or 0),
        "timeout": cfg["timeout"],
        "proxy": cfg["proxy"],
    }


# --------------------------------------------------------------------------- 本地连接登录（网站连接登录）
# 参考 dingminhua/dsh-connect-trae：读取本机 Trae 桌面客户端 storage.json，
# 用 AES-128-CBC + sha512(salt) 方案解密 iCubeAuthInfo://icube.cloudide，取出
# token / userId / refreshToken 等登录态，直接落库为本模块账号（无需手动抄 token）。
# 本质是「读本地客户端登录态」而非 OAuth：服务端运行在本机，可直接访问用户目录下的
# Trae 配置文件。

TRAE_AUTH_STORAGE_KEY = "iCubeAuthInfo://icube.cloudide"
TRAE_CLI_TOKEN_FILENAME = "trae-jwt-token"

# 来自 dsh-connect-trae/src/decrypt.ts 的 salt（256 位），用于派生 AES key/IV。
SALT_A = bytes([82, 9, 106, 213, 48, 54, 165, 56, 191, 64, 163, 158, 129, 243, 215, 251, 124, 227, 57, 130, 155, 47, 255, 135, 52, 142, 67, 68, 196, 222, 233, 203, 84, 123, 148, 50, 166, 194, 35, 61, 238, 76, 149, 11, 66, 250, 195, 78, 8, 46, 161, 102, 40, 217, 36, 178, 118, 91, 162, 73, 109, 139, 209, 37])
SALT_B = bytes([31, 221, 168, 51, 136, 7, 199, 49, 177, 18, 16, 89, 39, 128, 236, 95, 96, 81, 127, 169, 25, 181, 74, 13, 45, 229, 122, 159, 147, 201, 156, 239, 160, 224, 59, 77, 174, 42, 245, 176, 200, 235, 187, 60, 131, 83, 153, 97, 23, 43, 4, 126, 186, 119, 214, 38, 225, 105, 20, 99, 85, 33, 12, 125])
SALT_C = bytes([191, 192, 216, 250, 122, 246, 220, 97, 31, 254, 98, 27, 8, 72, 71, 176, 135, 99, 96, 18, 127, 101, 203, 104, 211, 102, 191, 125, 37, 72, 150, 156, 51, 229, 121, 35, 17, 153, 141, 177, 110, 131, 150, 128, 172, 255, 254, 6, 18, 140, 55, 62, 236, 249, 135, 64, 135, 12, 117, 4, 89, 149, 168, 209])
SALT_D = bytes([246, 204, 26, 232, 232, 70, 129, 109, 223, 146, 169, 242, 23, 241, 105, 145, 50, 196, 165, 42, 254, 120, 3, 54, 244, 207, 209, 85, 53, 6, 138, 106, 175, 148, 31, 204, 186, 186, 165, 182, 87, 142, 49, 10, 39, 110, 26, 154, 86, 56, 173, 125, 18, 64, 198, 225, 99, 99, 83, 82, 191, 134, 76, 170])


def _xor_bytes(a: bytes, b: bytes) -> bytes:
    return bytes(x ^ y for x, y in zip(a, b))


def _trae_encryption_type(header: bytes) -> str:
    if header == bytes([0x74, 0x63, 0x05, 0x10, 0x00, 0x00]):
        return "aes"
    if header == bytes([18, 57, 32, 32, 2, 3]):
        return "aes-private"
    raise TraeError("不支持的 Trae 加密头（不是 Trae 客户端 storage）")


def decrypt_trae_storage_value(encoded: str) -> str:
    """解密单个 iCubeAuthInfo 值：base64 → 头(6)/random(32)/AES-128-CBC 密文；
    密文前置 sha512(明文) 作完整性校验。key/IV 由 sha512(sha512(random) ‖ salt) 派生。"""
    try:
        buf = base64.b64decode(encoded)
    except Exception:
        raise TraeError("Trae 凭据不是合法 base64")
    if len(buf) <= 102:
        raise TraeError("Trae 凭据密文过短")
    etype = _trae_encryption_type(buf[:6])
    random = buf[6:38]
    encrypted = buf[38:]
    salt = _xor_bytes(SALT_C, SALT_D) if etype == "aes-private" else _xor_bytes(SALT_A, SALT_B)
    first = hashlib.sha512(random).digest()
    derived = hashlib.sha512(first + salt).digest()
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    cipher = Cipher(algorithms.AES(derived[:16]), modes.CBC(derived[16:32]))
    dec = cipher.decryptor()
    decrypted = dec.update(encrypted) + dec.finalize()
    # Node 的 AES-CBC 默认带 PKCS7 填充，解密后需手动去除（保证 plaintext 纯净，
    # 否则尾部填充字节会让 sha512 完整性校验 / JSON 解析失败）。
    if decrypted and 1 <= decrypted[-1] <= 16:
        _pad = decrypted[-1]
        if decrypted[-_pad:] == bytes([_pad]) * _pad:
            decrypted = decrypted[:-_pad]
    if len(decrypted) < 64:
        raise TraeError("Trae 明文过短")
    expected = decrypted[:64]
    plaintext = decrypted[64:]
    if hashlib.sha512(plaintext).digest() != expected:
        raise TraeError("Trae 凭据完整性校验失败")
    return plaintext.decode("utf-8")


def parse_trae_auth_value(value: str) -> dict:
    value = (value or "").strip()
    if not value:
        raise TraeError("Trae 凭据为空")
    if value.startswith("{"):
        obj = json.loads(value)          # 部分客户端直接存明文 JSON
    else:
        obj = json.loads(decrypt_trae_storage_value(value))
    return obj if isinstance(obj, dict) else {}


def parse_trae_storage_document(text: str) -> dict:
    try:
        parsed = json.loads(text)
    except (TypeError, ValueError):
        raise TraeError("Trae storage.json 不是合法 JSON")
    if not isinstance(parsed, dict):
        raise TraeError("Trae storage.json 不是对象")
    val = parsed.get(TRAE_AUTH_STORAGE_KEY)
    if not isinstance(val, str):
        raise TraeError("Trae storage.json 不含 %s 字段" % TRAE_AUTH_STORAGE_KEY)
    return parse_trae_auth_value(val)


def parse_trae_cli_token(text: str) -> dict:
    """解析 Trae CLI 裸 JWT（trae-jwt-token）：取 data.user_id 作为账号标识。"""
    text = (text or "").strip()
    if not text:
        raise TraeError("Trae CLI token 文件为空")
    token = text
    if text.startswith("{"):
        try:
            env = json.loads(text)
        except (TypeError, ValueError):
            raise TraeError("Trae CLI token 文档不是合法 JSON")
        candidate = env.get("token") or env.get("accessToken") or env.get("jwt")
        if not isinstance(candidate, str) or not candidate.strip():
            raise TraeError("Trae CLI token 文档无 token 字段")
        token = candidate.strip()
    segs = token.split(".")
    if len(segs) != 3 or any(s == "" for s in segs):
        raise TraeError("Trae CLI token 不是三段式 JWT")
    payload = _jwt_payload(token)
    data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
    user_id = data.get("user_id") if isinstance(data.get("user_id"), str) else ""
    if not user_id:
        raise TraeError("Trae CLI token 无 data.user_id 声明")
    exp = payload.get("exp")
    expires_at = float(exp) if isinstance(exp, (int, float)) and exp > 0 else 0.0
    return {"accessToken": token, "userId": user_id, "expires_at": expires_at}


def _trae_region_from_host(host, edition):
    if host:
        hl = str(host).lower()
        if hl.endswith(".trae.ai"):
            return "sg"
        if hl.endswith(".trae.cn") or hl.endswith(".trae.com.cn"):
            return "cn"
    if edition in ("sg", "solo-sg"):
        return "sg"
    return "cn"


TRAE_DEVICE_CENTER_PREFIX = "iCubeAuthInfo://icube-dc:"


def _trae_desktop_device_id(storage: dict, storage_path: str) -> str:
    """桌面端设备号（对齐 dsh-connect-trae identity.ts）：
    1) storage.json 中 `iCubeAuthInfo://icube-dc:<数字>` 键的数字后缀 —— 官方客户端
       发的 x-device-id 就是它（真实已登记号，claim 判定用它）；
    2) 回退 telemetry.devDeviceId；
    3) 再回退 sha256(machineId)[:32]（machineId 取 telemetry.machineId 或
       <appRoot>/machineid 文件，appRoot = storage.json 上三级目录）。
    读不到返回空串。"""
    if not isinstance(storage, dict):
        return ""
    dcs = [k[len(TRAE_DEVICE_CENTER_PREFIX):].strip()
           for k in storage.keys() if k.startswith(TRAE_DEVICE_CENTER_PREFIX)]
    dcs = [x for x in dcs if x]
    if len(dcs) == 1:
        return dcs[0]
    dev = str(storage.get("telemetry.devDeviceId") or "").strip()
    if dev:
        return dev
    machine_id = str(storage.get("telemetry.machineId") or "").strip()
    if not machine_id:
        app_root = os.path.dirname(os.path.dirname(os.path.dirname(storage_path)))
        try:
            with open(os.path.join(app_root, "machineid"), "r", encoding="utf-8") as f:
                machine_id = f.read().strip()
        except OSError:
            machine_id = ""
    if machine_id:
        return hashlib.sha256(machine_id.encode("utf-8")).hexdigest()[:32]
    return ""


def _strip_jsonc_comments(text: str) -> str:
    """去掉 JSONC 的 // 与 /* */ 注释（保留字符串内部内容），供 argv.json 这类
    允许注释的 VS Code 风格配置解析用。"""
    out, i, n, in_str = [], 0, len(text), False
    while i < n:
        ch = text[i]
        if in_str:
            out.append(ch)
            if ch == "\\" and i + 1 < n:
                out.append(text[i + 1])
                i += 2
                continue
            if ch == '"':
                in_str = False
            i += 1
            continue
        if ch == '"':
            in_str = True
            out.append(ch)
            i += 1
            continue
        if ch == "/" and i + 1 < n and text[i + 1] == "/":
            while i < n and text[i] != "\n":
                i += 1
            continue
        if ch == "/" and i + 1 < n and text[i + 1] == "*":
            i += 2
            while i + 1 < n and not (text[i] == "*" and text[i + 1] == "/"):
                i += 1
            i += 2
            continue
        out.append(ch)
        i += 1
    return "".join(out)


def _trae_cli_device_id(cli_home: str) -> str:
    """CLI 端设备号：argv.json 的 crash-reporter-id（CLI 首次运行写入的稳定 UUID，
    文件为 VS Code 风格 JSONC、允许注释）→ 回退 sha256("trae-cli\\0host\\0user")[:32]。
    读不到返回空串。"""
    argv = {}
    try:
        with open(os.path.join(cli_home, "argv.json"), "r", encoding="utf-8") as f:
            loaded = json.loads(_strip_jsonc_comments(f.read()))
        if isinstance(loaded, dict):
            argv = loaded
    except (OSError, ValueError):
        argv = {}
    crash = str(argv.get("crash-reporter-id") or "").strip()
    if crash:
        return crash
    host = str(os.environ.get("HOSTNAME") or "").strip()
    if not host and hasattr(os, "uname"):
        host = os.uname().nodename
    user = str(os.environ.get("USER") or os.environ.get("USERNAME") or "").strip() or "unknown-user"
    return hashlib.sha256(("trae-cli\0" + host + "\0" + user).encode("utf-8")).hexdigest()[:32]


def _trae_storage_candidates() -> list:
    """枚举本机所有可能的 Trae 登录态文件路径（桌面 storage.json + CLI token）。"""
    sysname = platform.system()
    home = os.path.expanduser("~")
    candidates = []
    editions = ["cn", "sg", "solo", "solo-sg"]

    def _add_desktop(root, app_names):
        for ed in editions:
            for an in app_names.get(ed, []):
                candidates.append({"edition": ed, "source": "desktop",
                                   "path": os.path.join(root, an, "User", "globalStorage", "storage.json")})

    if sysname == "Darwin":
        root = os.path.join(home, "Library", "Application Support")
        _add_desktop(root, {"cn": ["Trae CN"], "sg": ["Trae"],
                            "solo": ["TRAE SOLO CN"], "solo-sg": ["TRAE SOLO"]})
    elif sysname == "Windows":
        roots = []
        if os.environ.get("APPDATA"):
            roots.append(os.environ["APPDATA"])
        roaming = os.path.join(home, "AppData", "Roaming")
        if roaming not in roots:
            roots.append(roaming)
        win_names = {"cn": ["Trae CN", "trae-cn"], "sg": ["Trae"],
                     "solo": ["TRAE SOLO CN", "trae-solo-cn"], "solo-sg": ["TRAE SOLO"]}
        for r in roots:
            _add_desktop(r, win_names)
    elif sysname == "Linux":
        root = os.environ.get("XDG_CONFIG_HOME") or os.path.join(home, ".config")
        linux_names = {"cn": ["trae-cn", "Trae CN", "trae", "Trae"],
                       "sg": ["trae", "Trae"],
                       "solo": ["trae-solo-cn", "TRAE SOLO CN"],
                       "solo-sg": ["trae-solo", "TRAE SOLO"]}
        _add_desktop(root, linux_names)

    # CLI：~/.trae-cn（cn）/ ~/.trae（sg）下的裸 JWT
    cli_roots = [os.environ.get("USERPROFILE") or home] if sysname == "Windows" else [home]
    for name, ed in ((".trae-cn", "cn"), (".trae", "sg")):
        for r in cli_roots:
            candidates.append({"edition": ed, "source": "cli",
                               "path": os.path.join(r, name, TRAE_CLI_TOKEN_FILENAME)})
    return candidates


def _import_trae_credential(cred: dict, edition: str, source: str) -> dict:
    """把一个解析出来的 Trae 登录态落库为账号（幂等：同 uid 覆盖更新）。"""
    token = str(cred.get("token") or cred.get("accessToken") or "").strip()
    if not token:
        raise TraeError("Trae 登录态缺少 token")
    user_id = str(cred.get("userId") or "").strip()
    host = str(cred.get("host") or "")
    user_region = cred.get("user_region") or _trae_region_from_host(host, edition) or "cn"
    user_region = str(user_region).strip().lower() or "cn"
    nickname = ""
    acc = cred.get("account")
    if isinstance(acc, dict):
        nickname = str(acc.get("username") or "")
    # 账号 uid：优先 userId（带版本前缀避免跨版本冲突），否则用 token 指纹
    if user_id:
        uid = "trae_%s_%s" % (edition, user_id)
    else:
        uid = "trae_%s_tok_%s" % (edition, hashlib.sha256(token.encode("utf-8")).hexdigest()[:16])
    if not re.fullmatch(r"[A-Za-z0-9_.@-]{1,128}", uid):
        uid = "trae_%s_tok_%s" % (edition, hashlib.sha256((token + user_id).encode("utf-8")).hexdigest()[:16])
    data = {"token": token, "uid": uid, "source": "connect",
            "user_region": str(user_region or "cn")[:16]}
    device_id = str(cred.get("device_id") or "").strip()[:128]
    if device_id:
        data["device_id"] = device_id
    if nickname:
        data["remark"] = nickname[:256]
    if cred.get("expires_at"):
        data["expires_at"] = cred["expires_at"]
    return save_account(data)


def connect_local_trae(editions=None) -> dict:
    """扫描本机 Trae 桌面 / CLI 登录态并导入为本模块账号。

    返回 {ok, count, found[], errors[], scanned}；每个 found 为脱敏后的账号摘要。
    errors 记录扫描到但解析 / 导入失败的项（路径 + 原因），便于排查。
    """
    cands = _trae_storage_candidates()
    if editions:
        want = set(editions)
        cands = [c for c in cands if c["edition"] in want]
    found, errors, seen = [], [], set()
    for cand in cands:
        path = cand["path"]
        if path in seen:
            continue
        seen.add(path)
        if not os.path.isfile(path):
            continue
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                text = f.read()
            if cand["source"] == "desktop":
                try:
                    raw = json.loads(text)
                except (TypeError, ValueError):
                    raise TraeError("Trae storage.json 不是合法 JSON")
                if not isinstance(raw, dict):
                    raise TraeError("Trae storage.json 不是对象")
                val = raw.get(TRAE_AUTH_STORAGE_KEY)
                if not isinstance(val, str):
                    raise TraeError("Trae storage.json 不含 %s 字段" % TRAE_AUTH_STORAGE_KEY)
                doc = parse_trae_auth_value(val)
                token = doc.get("token") or doc.get("accessToken")
                if not token:
                    raise TraeError("storage.json 解析出的登录态缺少 token")
                cred = {
                    "token": token,
                    "userId": doc.get("userId") or "",
                    "refreshToken": doc.get("refreshToken"),
                    "host": doc.get("host") or "",
                    "account": doc.get("account"),
                }
                ur = doc.get("userRegion") or doc.get("user_region")
                if ur:
                    cred["user_region"] = str(ur)
                device_id = _trae_desktop_device_id(raw, path)
                if device_id:
                    cred["device_id"] = device_id
            else:
                claims = parse_trae_cli_token(text)
                cred = {"token": claims["accessToken"], "userId": claims["userId"],
                        "expires_at": claims["expires_at"]}
                device_id = _trae_cli_device_id(os.path.dirname(path))
                if device_id:
                    cred["device_id"] = device_id
            acc = _import_trae_credential(cred, cand["edition"], cand["source"])
            found.append({"uid": acc["uid"], "display_name": acc["display_name"],
                          "edition": cand["edition"], "source": cand["source"]})
        except Exception as e:
            errors.append({"edition": cand["edition"], "source": cand["source"],
                           "path": path, "error": str(e)})
    return {"ok": True, "count": len(found), "found": found,
            "errors": errors, "scanned": len(seen)}


def auto_fill_device_id() -> dict:
    """扫描本机 Trae 登录态，为尚未配置设备号的账号自动补 device_id。

    账号 → 版本匹配：uid 形如 trae_<edition>_<userId> 的优先用对应版本的设备号；
    匹配不到且本机恰好只有一个设备标识时兜底使用它。已配置的账号不覆盖。
    """
    devices = {}   # edition -> {device_id, source, path}
    for cand in _trae_storage_candidates():
        ed = cand["edition"]
        if ed in devices:
            continue
        if not os.path.isfile(cand["path"]):
            continue
        try:
            if cand["source"] == "desktop":
                with open(cand["path"], "r", encoding="utf-8", errors="replace") as f:
                    raw = json.load(f)
                did = _trae_desktop_device_id(raw, cand["path"]) if isinstance(raw, dict) else ""
            else:
                did = _trae_cli_device_id(os.path.dirname(cand["path"]))
            if did:
                devices[ed] = {"device_id": did[:128], "source": cand["source"], "path": cand["path"]}
        except Exception:
            continue
    filled, skipped = [], []
    for acc in list_accounts():
        uid = str(acc.get("uid") or "")
        if acc.get("device_id_set"):
            skipped.append({"uid": uid, "reason": "已配置设备号"})
            continue
        m = re.match(r"^trae_([a-z][a-z0-9-]*)_", uid)
        edition = m.group(1) if m else ""
        info = devices.get(edition)
        if info is None and len(devices) == 1:
            info = next(iter(devices.values()))
        if info is None:
            skipped.append({"uid": uid, "reason": "本机未找到可用的 Trae 设备标识"})
            continue
        save_account({"uid": uid, "device_id": info["device_id"]})
        filled.append({"uid": uid, "edition": edition or "-", "source": info["source"]})
    return {"ok": True, "filled": filled, "skipped": skipped, "devices": devices}


# --------------------------------------------------------------------------- 官方接口

def _request(creds: dict, path: str, body=None) -> dict:
    """调用一次官方接口；HTTP 层与业务层错误都会归一化为 TraeError 或结果字典。

    Trae 的限流 / 参数错误返回 HTTP 200 + body 业务码，必须检查 body 的 code。
    """
    url = API_BASE + path
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Authorization": AUTH_SCHEME + " " + creds["token"],
        "User-Agent": USER_AGENT,
        "X-User-Region": str(creds.get("user_region") or "cn"),
    }
    if creds.get("uid"):
        headers["x-user-id"] = str(creds["uid"])
    if creds.get("device_id"):
        headers["x-device-id"] = str(creds["device_id"])
    payload = json.dumps(body or {"req_source": 1}, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=payload, method="POST", headers=headers)
    try:
        proxy = str(creds.get("proxy") or "").strip()
        opener = (proxyutil.build_opener(proxy=proxy) if proxy
                  else urllib.request.build_opener())
    except ValueError as e:
        raise TraeError("代理配置有误：%s" % e)
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
        raise TraeError("连接 Trae 接口失败：%s" % proxyutil.friendly_error(e, url))
    text = raw.decode("utf-8", "replace")
    try:
        obj = json.loads(text)
    except (TypeError, ValueError):
        obj = {}
    if not isinstance(obj, dict):
        obj = {}
    code = obj.get("code")
    message = str(obj.get("message") or obj.get("msg") or text[:160])
    if status >= 400 or (code is not None and str(code) not in ("0", "200", "success", "OK")):
        hint = CODE_HINTS.get(code, "")
        raise TraeError("Trae 接口返回 HTTP %s%s：%s%s"
                        % (status, "" if code is None else " / code=%s" % code,
                           message, ("（%s）" % hint) if hint else ""))
    return {"status": status, "json": obj, "message": message, "code": code}


def fetch_status(creds: dict) -> dict:
    """今日签到状态 + 单日奖励额度。

    响应字段（实测）：checked_in / did_checked_in / credits / extra_credits /
    enable；判定字段是 checked_in（did_checked_in 为干扰项）。
    """
    res = _request(creds, PATH_STATUS)
    obj = res["json"]

    def _b(v):
        if isinstance(v, bool):
            return v
        return str(v).strip().lower() in ("1", "true", "yes")

    credits = _num(obj.get("credits"), 0) or 0
    extra = _num(obj.get("extra_credits"), 0) or 0
    out = {
        "checked_in": _b(obj.get("checked_in")),
        "did_checked_in": _b(obj.get("did_checked_in")),
        "enable": _b(obj.get("enable")) if obj.get("enable") is not None else True,
        "daily_credit": credits + extra,     # 单日奖励额度（免费 150 / 会员 200）
        "base_credit": credits,
        "extra_credit": extra,
        "already": bool(obj.get("checked_in")),
    }
    _log.info("Trae CN 签到状态查询完成（HTTP %s）", res["status"])
    return out


def _parse_entitlement_packs(obj: dict) -> list:
    """从 usage 响应解析积分包列表（来源 / 面额 / 到期时间）。

    user_entitlement_pack_list 的每个包形如：group_name「每日签到」/「每月登录积分」、
    quota.credits_limit 面额、expire_time 到期（签到/登录积分发放约 31 天后清零）。
    过滤掉无额度包（如「免费」权益）与已失效包。按到期时间升序。
    """
    packs = []
    for p in obj.get("user_entitlement_pack_list") or []:
        if not isinstance(p, dict):
            continue
        bi = p.get("entitlement_base_info") or {}
        quota = bi.get("quota") or {}
        amount = _num(quota.get("credits_limit"))
        if amount is None:
            amount = _num(bi.get("charge_amount"))
        expire = _num(p.get("expire_time"))
        if expire is None:
            expire = _num(bi.get("end_time"))
        if not amount or not expire:
            continue
        expire = float(expire)
        now = time.time()
        if expire <= now:
            continue    # 已清零的旧包
        left = expire - now
        days = int(left // 86400)
        hours = int((left % 86400) // 3600)
        minutes = int((left % 3600) // 60)
        if days > 0:
            left_text = "%d天" % days
        else:
            left_text = "%d小时%d分" % (hours, minutes)
        packs.append({
            "name": str(p.get("group_name") or p.get("display_desc") or "积分包"),
            "amount": float(amount),
            "start_text": time.strftime("%Y-%m-%d",
                                        time.localtime(_num(bi.get("start_time")) or expire)),
            "expire_at": expire,
            "expire_text": time.strftime("%Y-%m-%d %H:%M", time.localtime(expire)),
            "days_left": days,
            "left_text": left_text,
        })
    packs.sort(key=lambda x: x["expire_at"])
    return packs


def fetch_credits(creds: dict) -> dict:
    """可用积分余额：usage_summary.total_amount - consumed_amount。

    同一响应顺带解析积分包列表（packs），供「积分构成 / 到期提醒」展示，
    不额外增加外呼。"""
    res = _request(creds, PATH_USAGE, body={"require_usage": True, "req_source": 1})
    obj = res["json"]
    summary = obj.get("usage_summary") if isinstance(obj.get("usage_summary"), dict) else {}
    total = _num(summary.get("total_amount"))
    used = _num(summary.get("consumed_amount"), 0) or 0
    if total is None:
        # 兼容字段变体：直接在顶层 / ent_info 里找
        alt = obj if not summary else summary
        for k in ("total_amount", "totalAmount", "amount", "credits"):
            total = _num(alt.get(k))
            if total is not None:
                used = _num(alt.get("consumed_amount") or alt.get("used"), 0) or 0
                break
    if total is None:
        raise TraeError("积分余额接口响应里未找到 usage_summary.total_amount 字段（字段名可能已变更）")
    out = {"balance": max(0.0, float(total) - float(used)), "used": used,
           "total": total, "balance_key": "usage_summary",
           "packs": _parse_entitlement_packs(obj)}
    _log.info("Trae CN 积分余额查询完成（HTTP %s）", res["status"])
    return out


def do_checkin(creds: dict, source="manual") -> dict:
    """执行签到（幂等）：先查状态，已签到就不再发起领取请求。

    claim 成功响应不带金额，入账积分以 status 返回的单日奖励额度（credits +
    extra_credits）记录，避免编造数字。
    """
    try:
        status = fetch_status(creds)
    except TraeError as e:
        # 状态查询失败不阻塞领取（可能与 status 接口独立限流）
        _log.warning("签到前状态查询失败，继续尝试领取：%s", e)
        status = {}
    if status.get("checked_in") is True:
        result = {"ok": True, "status": "already",
                  "message": "今天已签到，请明天再来",
                  "credit": float(status.get("daily_credit") or 0)}
        _record(creds, result, source)
        return result

    res = _request(creds, PATH_CLAIM)
    if res["code"] not in (0, "0", None, "200", "success", "OK"):
        raise TraeError("签到领取失败：code=%s %s" % (res["code"], res["message"]))
    result = {"ok": True, "status": "success",
              "message": "签到成功，积分已到账",
              "credit": float(status.get("daily_credit") or 0)}
    _record(creds, result, source)
    _log.info("Trae CN 签到完成：%s（来源 %s）", result["status"], source)
    return result


# --------------------------------------------------------------------------- 记录

def _record(creds: dict, result: dict, source: str) -> None:
    """一天一账号一条记录（重复点击只覆盖同一行，不会刷屏）。"""
    day = time.strftime("%Y-%m-%d")
    try:
        with store_db.store_tx() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO traecn_checkin "
                "(day, uid, status, credit, message, source, at) "
                "VALUES (?,?,?,?,?,?,?)",
                (day, str(creds.get("uid") or ""), result["status"],
                 float(result.get("credit") or 0),
                 result.get("message") or "", source, time.time()))
    except Exception as e:
        _log.warning("Trae CN 签到记录写入失败：%s", e)


def list_history(q="", page=1, size=10, limit=None, sort="", order="", uid=None) -> dict:
    """签到记录（默认按日期倒序）；uid 可按账号筛选，limit 供汇总取最近 N 条。"""
    conn = None
    try:
        conn = store_db.store_conn()
        rows = [dict(r) for r in conn.execute(
            "SELECT * FROM traecn_checkin ORDER BY day DESC, at DESC")]
    except Exception as e:
        _log.warning("Trae CN 签到记录读取失败：%s", e)
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
            "credit": r["credit"], "message": r["message"], "source": r["source"],
        })
    if uid:
        out = [r for r in out if r["uid"] == str(uid)]
    if q:
        low = str(q).lower()
        out = [r for r in out if low in " ".join(str(v) for v in r.values()).lower()]
    if str(sort) in ("day", "at", "at_text", "status", "status_text", "credit",
                     "message", "source", "uid"):
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


# --------------------------------------------------------------------------- 汇总 / 首屏

def _num(v, default=None):
    try:
        if v is None or isinstance(v, bool):
            return default
        return float(v)
    except (TypeError, ValueError):
        return default


def _update_balance(uid, balance) -> None:
    """缓存账号最近一次查到的余额，供账号列表展示（不影响主流程）。"""
    try:
        with store_db.store_tx() as conn:
            conn.execute(
                "UPDATE traecn_accounts SET last_balance=?, last_check_at=? WHERE uid=?",
                (float(balance), time.time(), str(uid)))
    except Exception as e:
        _log.warning("Trae CN 余额缓存写入失败：%s", e)


def _save_entitlements(uid: str, packs: list) -> None:
    """缓存积分包列表（「积分构成 / 到期提醒」缓存模式展示用）。"""
    try:
        with store_db.store_tx() as conn:
            conn.execute(
                "CREATE TABLE IF NOT EXISTS traecn_entitlements ("
                "uid TEXT PRIMARY KEY, packs TEXT DEFAULT '[]', updated_at REAL DEFAULT 0)")
            conn.execute(
                "INSERT OR REPLACE INTO traecn_entitlements (uid, packs, updated_at) "
                "VALUES (?,?,?)",
                (str(uid), json.dumps(packs, ensure_ascii=False), time.time()))
    except Exception as e:
        _log.warning("Trae CN 积分包缓存写入失败：%s", e)


def _load_entitlements(uid: str):
    try:
        conn = store_db.store_conn()
        try:
            row = conn.execute(
                "SELECT packs, updated_at FROM traecn_entitlements WHERE uid=?",
                (str(uid),)).fetchone()
        finally:
            conn.close()
        if not row:
            return None
        return {"packs": json.loads(row["packs"] or "[]"),
                "updated_at": float(row["updated_at"] or 0)}
    except Exception as e:
        _log.warning("Trae CN 积分包缓存读取失败：%s", e)
        return None


def credits_summary() -> dict:
    """跨账号汇总（只读本地缓存，零外呼）。"""
    accounts = list_accounts()
    total = 0.0
    per_account = []
    for a in accounts:
        bal = a.get("last_balance")
        has = bal is not None
        if has:
            total += float(bal)
        per_account.append({
            "uid": a["uid"], "name": a["display_name"],
            "balance": float(bal) if has else None,
            "known": has,
        })
    return {"total_balance": total if any(p["known"] for p in per_account) else None,
            "accounts": per_account}


def _local_status(uid: str, today: str) -> dict:
    """从本地签到记录推断账号状态（缓存模式不发任何外部请求，毫秒级返回）。"""
    conn = store_db.store_conn()
    try:
        rows = [dict(r) for r in conn.execute(
            "SELECT day, status, credit FROM traecn_checkin "
            "WHERE uid=? ORDER BY day DESC LIMIT 120", (str(uid),))]
    finally:
        conn.close()
    ok_days = {r["day"] for r in rows if r["status"] in ("success", "already")}
    total_credit = sum(float(r["credit"] or 0) for r in rows)
    checked = today in ok_days
    # 连签天数：从今天（未签则从昨天）往前数连续签到日
    cur = time.mktime(time.strptime(today, "%Y-%m-%d"))
    if not checked:
        cur -= 86400
    streak = 0
    while time.strftime("%Y-%m-%d", time.localtime(cur)) in ok_days:
        streak += 1
        cur -= 86400
    today_credit = 0.0
    for r in rows:
        if r["day"] == today:
            today_credit = float(r["credit"] or 0)
            break
    return {"checked_in": checked, "streak_days": streak,
            "total_credits": total_credit, "today_credit": today_credit,
            "cached": True}


def overview(uid=None, fresh=False) -> dict:
    """首屏：指定账号的余额 / 签到状态 + 全部账号列表 + 签到记录。

    fresh=False（默认）只读本地库，切换账号 / 首屏即时返回；
    fresh=True 才请求官方接口拉取最新状态与余额。"""
    target = str(uid or "").strip() or current_uid()
    acc = get_account(target) if target else None
    out = {"ok": True, "config": public_config(), "today": time.strftime("%Y-%m-%d"),
           "updated_at": time.time(), "status": None, "credits": None,
           "errors": {}, "history_recent": [], "history_all": [],
           "accounts": list_accounts(), "current_uid": target,
           "account": public_account(acc) if acc else None}
    hist_limit = 14 * max(1, len(out["accounts"])) + 60
    if not acc:
        out["configured"] = False
        out["error"] = "尚未添加 Trae CN 账号，请点「添加账号」填写 Cloud-IDE-Token"
        out["history_all"] = list_history(limit=hist_limit)["items"]
        out["credits_summary"] = credits_summary()
        return out
    if not fresh:
        # 本地缓存模式：余额用 last_balance 快照，签到状态从本机签到记录推断
        out["configured"] = True
        out["cached"] = True
        out["status"] = _local_status(target, out["today"])
        bal = acc.get("last_balance")
        out["credits"] = None if bal is None else {
            "balance": float(bal), "used": None, "total": None,
            "balance_key": "cached", "expire_at": ""}
        out["history_recent"] = list_history(limit=30, uid=target)["items"]
        out["history_all"] = list_history(limit=hist_limit)["items"]
        out["credits_summary"] = credits_summary()
        ent = _load_entitlements(target)
        if ent:
            out["entitlements"] = ent
        return out
    out["cached"] = False
    try:
        creds = resolve_credentials(target)
    except TraeError as e:
        out["configured"] = False
        out["error"] = str(e)
        out["history_recent"] = list_history(limit=30, uid=target)["items"]
        out["history_all"] = list_history(limit=hist_limit)["items"]
        out["credits_summary"] = credits_summary()
        return out
    out["configured"] = True
    out["credential"] = {"uid": creds["uid"], "account_uid": target,
                         "device_id_set": bool(creds["device_id"]),
                         "expires_at": creds["expires_at"]}
    with ThreadPoolExecutor(max_workers=2) as pool:
        jobs = {"status": pool.submit(fetch_status, creds),
                "credits": pool.submit(fetch_credits, creds)}
        for key, job in jobs.items():
            try:
                out[key] = job.result()
            except Exception as e:
                out["errors"][key] = str(e)
    # 官方 status 不含本地统计（连签天数 / 实际到账累计 / 今日到账），从签到记录合并
    local = _local_status(target, out["today"])
    if isinstance(out["status"], dict):
        out["status"].update({k: local[k]
                              for k in ("streak_days", "total_credits", "today_credit")})
    else:
        out["status"] = local
    if out["credits"] and out["credits"].get("balance") is not None:
        _update_balance(target, out["credits"]["balance"])
    packs = out["credits"].get("packs") if out["credits"] else None
    if packs is not None:
        _save_entitlements(target, packs)
        out["entitlements"] = {"packs": packs, "updated_at": time.time()}
    else:
        ent = _load_entitlements(target)
        if ent:
            out["entitlements"] = ent
    out["history_recent"] = list_history(limit=30, uid=target)["items"]
    out["history_all"] = list_history(limit=hist_limit)["items"]
    out["credits_summary"] = credits_summary()
    return out


def test_connection(uid=None) -> dict:
    """只查询状态、不领取积分。"""
    creds = resolve_credentials(uid)
    return {"ok": True, "credential": {"uid": creds["uid"],
                                       "device_id_set": bool(creds["device_id"]),
                                       "account_uid": creds["account_uid"]},
            "status": fetch_status(creds)}


# --------------------------------------------------------------------------- 批量操作

def _checkin_one(uid, nickname="") -> dict:
    creds = resolve_credentials(uid)
    result = do_checkin(creds, source="auto")
    return {"uid": uid, "nickname": nickname, "ok": True, **result}


def _refresh_one(uid, nickname="") -> dict:
    creds = resolve_credentials(uid)
    cr = fetch_credits(creds)
    if cr.get("balance") is not None:
        _update_balance(uid, cr["balance"])
    return {"uid": uid, "nickname": nickname, "ok": True, "status": "success",
            "balance": cr["balance"]}


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


# --------------------------------------------------------------------------- 模型与档位
#
# 数据来源分两路，互不替代：
#   1) 档位：官方 api.trae.cn 的用量接口（web_user_ent_usage）里的订阅权益包
#      （subscription_extra + display_desc）→ 免费 / 会员 Lite / Pro / Pro+ / Ultra …
#      以及每月登录赠送积分、云端并行任务数、试用状态；
#   2) 模型清单：官方没有对外的模型列表接口（/api/ide/v1/get_detail_param 只在客户端
#      私有网关 trae-api-cn.mchost.guru 上，本模块不把 token 发往官方以外域名），
#      因此改为读本机 Trae CN 客户端缓存：VS Code 同款 state.vscdb 里
#      `<userId>_AI.agent.model.model_list_map` 就是客户端拉到的完整模型目录
#      （含消耗倍率 / 会员折扣 / 上下文 / 最大输出 / 思考档位 / 多模态标记）。
#      只读打开（immutable=1），不影响正在运行的客户端。

# 本机客户端用户数据目录名（Trae CN 各版本 / 不同包名）
_STATE_APP_DIRS = ("Trae CN", "Trae CN - Insiders", "Trae CN Nightly", "Trae")

# 模型目录按「场景」分组：同一模型可能出现在多个场景里，展示时合并
_SCENE_LABELS = {
    "chat_v3": "对话",
    "solo_agent": "SOLO Agent",
    "builder_v3": "Builder v3",
    "builder": "Builder",
    "refactor": "重构",
    "code_reviewer": "代码评审",
    "code_review_summary": "评审摘要",
}
_SCENE_ORDER = ("chat_v3", "solo_agent", "builder_v3", "builder", "refactor",
                "code_reviewer", "code_review_summary")

# 订阅档位：权益包名 / 周期名 → 展示名（由粗到细匹配，命中即止）
_TIER_RULES = (
    ("express", "优速通 Express"),
    ("优速通", "优速通 Express"),
    ("ultra", "会员 Ultra"),
    ("pro+", "会员 Pro+"),
    ("proplus", "会员 Pro+"),
    ("pro +", "会员 Pro+"),
    ("lite", "会员 Lite"),
    ("pro", "会员 Pro"),
    ("免费", "免费版"),
    ("free", "免费版"),
    ("trial", "体验版"),
    ("企业", "企业版"),
    ("enterprise", "企业版"),
    ("团队", "团队版"),
    ("team", "团队版"),
)

# 厂商：按模型 id 关键词推导（客户端目录不直接给 provider）
_VENDOR_RULES = (
    ("doubao", "豆包"), ("seed", "豆包"),
    ("deepseek", "DeepSeek"),
    ("glm", "智谱"),
    ("kimi", "月之暗面"),
    ("qwen", "通义千问"),
    ("minimax", "MiniMax"),
    ("mimo", "小米"),
    ("step", "阶跃星辰"),
    ("claude", "Anthropic"), ("gpt", "OpenAI"), ("gemini", "Google"),
    ("grok", "xAI"), ("sensenova", "商汤"),
)


def _vendor_of(mid: str) -> str:
    hay = str(mid or "").lower()
    for key, label in _VENDOR_RULES:
        if key in hay:
            return label
    return ""


def _plan_label(desc: str) -> str:
    hay = str(desc or "").strip().lower()
    if not hay:
        return ""
    for key, label in _TIER_RULES:
        if key in hay:
            return label
    return ""


def _plan_code(label: str) -> str:
    """展示名 → 稳定的档位代码（供前端判断是否付费档）。"""
    for key, val in (("Ultra", "ultra"), ("Pro+", "pro_plus"), ("Pro", "pro"),
                     ("Lite", "lite"), ("Express", "express"),
                     ("免费", "free"), ("体验", "trial"),
                     ("企业", "enterprise"), ("团队", "team")):
        if key in str(label or ""):
            return val
    return ""


def _as_text(value) -> str:
    if isinstance(value, bytes):
        try:
            return value.decode("utf-8", "replace")
        except Exception:                        # noqa: BLE001
            return ""
    return str(value or "")


def _state_db_candidates() -> list:
    """本机 Trae CN 客户端 state.vscdb 候选路径（可用 TRAE_STATE_DB 覆盖）。"""
    paths = []
    env = str(os.environ.get("TRAE_STATE_DB") or "").strip()
    if env:
        paths.append(env)
    home = os.path.expanduser("~")
    system = platform.system()
    if system == "Windows":
        roots = [os.environ.get("APPDATA") or os.path.join(home, "AppData", "Roaming")]
    elif system == "Darwin":
        roots = [os.path.join(home, "Library", "Application Support")]
    else:
        roots = [os.path.join(home, ".config"),
                 os.environ.get("XDG_CONFIG_HOME") or os.path.join(home, ".config")]
    for root in roots:
        for name in _STATE_APP_DIRS:
            paths.append(os.path.join(root, name, "User", "globalStorage", "state.vscdb"))
    seen, out = set(), []
    for p in paths:
        p = os.path.abspath(os.path.expanduser(p))
        if p and p not in seen:
            seen.add(p)
            out.append(p)
    return out


def _read_state_rows(path: str) -> list:
    """只读打开客户端状态库，取出所有 model_list_map 键（不写、不锁库）。"""
    uri = "file:%s?mode=ro&immutable=1" % urllib.parse.quote(path)
    try:
        conn = sqlite3.connect(uri, uri=True, timeout=3)
    except sqlite3.Error as e:
        _log.warning("Trae CN 客户端状态库打开失败（%s）：%s", path, e)
        return []
    try:
        rows = conn.execute(
            "SELECT key, value FROM ItemTable WHERE key LIKE '%model_list_map%'"
        ).fetchall()
        return rows or []
    except sqlite3.Error as e:
        _log.warning("Trae CN 客户端模型缓存读取失败（%s）：%s", path, e)
        return []
    finally:
        conn.close()


def _pick_catalog(rows: list, uid: str):
    """在多条缓存里挑出当前账号的那份（键名带 userId 数字）；挑不到取内容最大的。"""
    digits = re.sub(r"\D", "", str(uid or ""))
    best, best_score = None, -1
    for key, value in rows:
        text = _as_text(value).strip()
        if not text or not text.startswith("{"):
            continue
        score = 0
        if digits and digits in str(key):
            score += 2
        if "chat_v3" in text:
            score += 1
        if score > best_score or (score == best_score and best and len(text) > len(best[1])):
            best, best_score = (str(key), text), score
    return best


def _read_local_models(uid: str):
    """从本机客户端缓存读出模型目录；返回 (catalog, source_path, 文件更新时间)。"""
    for path in _state_db_candidates():
        if not os.path.isfile(path):
            continue
        rows = _read_state_rows(path)
        picked = _pick_catalog(rows, uid)
        if not picked:
            continue
        try:
            catalog = json.loads(picked[1])
        except (TypeError, ValueError) as e:
            _log.warning("Trae CN 客户端模型缓存解析失败（%s）：%s", path, e)
            continue
        if not isinstance(catalog, dict):
            continue
        try:
            mtime = os.path.getmtime(path)
        except OSError:
            mtime = 0.0
        return catalog, path, mtime
    return {}, "", 0.0


def _norm_model(m: dict, mid: str) -> dict:
    """客户端目录条目 → 展示字段（对齐 WorkBuddy「模型与档位」的列）。"""
    feats = m.get("features") if isinstance(m.get("features"), dict) else {}
    rate = _num(((feats.get("consumption_rate") or {}).get("data") or {}).get("rate"))
    disc = (feats.get("activity_discount") or {}).get("data") or {}
    member_rate = _num((disc.get("member") or {}).get("after_consumption_rate"))
    effort_cfg = m.get("reasoning_effort_config") if isinstance(
        m.get("reasoning_effort_config"), dict) else {}
    efforts = [str(x).strip() for x in (effort_cfg.get("options") or [])
               if str(x or "").strip()][:8]
    cap_disp = m.get("context_window_size") if isinstance(
        m.get("context_window_size"), dict) else {}
    ctx = (_num((m.get("context_window_tokens") or {}).get("dev"))
           or _num(cap_disp.get("default")) or _num(cap_disp.get("max")) or 0)
    multimodal = bool(m.get("multimodal")) or bool((feats.get("multimodal") or {}).get("enable"))
    thinking = bool(effort_cfg.get("support_thinking")) or bool(
        (feats.get("reasoning") or {}).get("enable"))
    custom = (str(mid).startswith("custom_") or bool(m.get("custom_model_id"))
              or bool((m.get("display_config") or {}).get("is_custom_model")))
    caps = []
    if multimodal:
        caps.append("视觉")
    if thinking:
        caps.append("思考")
    if custom:
        caps.append("自定义")
    if m.get("is_beta"):
        caps.append("Beta")
    return {
        "id": mid,
        "name": str(m.get("display_name") or ""),
        "vendor": _vendor_of(mid),
        "max_input": int(ctx or 0),
        "max_output": int(_num(m.get("max_tokens"), 0) or 0),
        "rate": rate,
        "rate_num": rate,
        "member_rate": member_rate,
        "efforts": efforts,
        "effort_default": str(effort_cfg.get("default_level") or ""),
        "multimodal": multimodal,
        "thinking": thinking,
        "custom": custom,
        "beta": bool(m.get("is_beta")),
        "fee_level": _num(m.get("fee_model_level"), 0) or 0,
        "default": bool(m.get("is_default")),
        "caps": caps,
        "free": rate is not None and float(rate) == 0.0,
    }


def _merge_models(catalog: dict) -> list:
    """把按场景分组的目录合并成一张模型表：同 id 只留一行，场景 / 容量取并集。"""
    merged, order = {}, []
    scenes_seen = list(_SCENE_ORDER) + [k for k in catalog if k not in _SCENE_ORDER]
    for scene in scenes_seen:
        items = catalog.get(scene)
        if not isinstance(items, list):
            continue
        scene_label = _SCENE_LABELS.get(scene, scene)
        for m in items:
            if not isinstance(m, dict):
                continue
            if m.get("selectable") is False or m.get("status") is False:
                continue
            mid = str(m.get("name") or "").strip()
            if not mid:
                continue
            rec = _norm_model(m, mid)
            cur = merged.get(mid)
            if cur is None:
                rec["scenes"] = [scene_label]
                merged[mid] = rec
                order.append(mid)
            else:
                if scene_label not in cur["scenes"]:
                    cur["scenes"].append(scene_label)
                cur["max_input"] = max(cur["max_input"], rec["max_input"])
                cur["max_output"] = max(cur["max_output"], rec["max_output"])
                cur["default"] = cur["default"] or rec["default"]
                cur["beta"] = cur["beta"] or rec["beta"]
                cur["thinking"] = cur["thinking"] or rec["thinking"]
                if cur["rate_num"] is None:
                    cur["rate_num"] = rec["rate_num"]
                    cur["rate"] = rec["rate"]
                if cur["member_rate"] is None:
                    cur["member_rate"] = rec["member_rate"]
                if not cur["efforts"]:
                    cur["efforts"] = rec["efforts"]
                    cur["effort_default"] = rec["effort_default"]
                for cap in rec["caps"]:
                    if cap not in cur["caps"]:
                        cur["caps"].append(cap)
    return [merged[k] for k in order]


def _tier_info(obj: dict) -> dict:
    """用量响应 → 订阅档位（免费 / 会员 Lite / Pro / Pro+ / Ultra …）+ 额度信息。"""
    packs = obj.get("user_entitlement_pack_list")
    packs = [p for p in packs if isinstance(p, dict)] if isinstance(packs, list) else []
    label, code = "", ""
    parallel = 0
    monthly_bonus = 0.0
    charged = 0.0
    pack_count = 0
    for p in packs:
        bi = p.get("entitlement_base_info") or {}
        quota = bi.get("quota") if isinstance(bi.get("quota"), dict) else {}
        extra = bi.get("product_extra") if isinstance(bi.get("product_extra"), dict) else {}
        sub = extra.get("subscription_extra") if isinstance(
            extra.get("subscription_extra"), dict) else {}
        pkg = extra.get("package_extra") if isinstance(extra.get("package_extra"), dict) else {}
        desc = str(p.get("display_desc") or "")
        if str(p.get("status") or "") in ("0", "2", "3"):
            continue
        pack_count += 1
        charged += _num(bi.get("charge_amount"), 0) or 0
        amount = _num(quota.get("credits_limit"))
        if amount is None:
            amount = _num((pkg.get("quota") or {}).get("credits_limit"))
        if amount and ("赠送" in desc or "登录" in desc):
            monthly_bonus += float(amount)
        # 订阅包：带 subscription_extra，里面是权益（并行任务数等）
        if sub:
            if not label:
                label = _plan_label(desc)
                code = _plan_code(label)
            lim = _num((sub.get("quota") or {}).get("solo_agent_parallel_limit"))
            if lim:
                parallel = max(parallel, int(lim))
        else:
            lim = _num((pkg.get("quota") or {}).get("solo_agent_parallel_limit"))
            if lim:
                parallel = max(parallel, int(lim))
    summary = obj.get("usage_summary") if isinstance(obj.get("usage_summary"), dict) else {}
    total = _num(summary.get("total_amount"))
    used = _num(summary.get("consumed_amount"), 0) or 0
    trial = obj.get("trial_status") if isinstance(obj.get("trial_status"), dict) else {}
    is_paid = bool(charged > 0) or (bool(label) and label != "免费版")
    return {
        "code": code,
        "label": label or "免费版",
        "is_paid": is_paid,
        "parallel": parallel or None,
        "monthly_bonus": monthly_bonus or None,
        "pack_count": pack_count,
        "total": total,
        "used": used,
        "remain": (float(total) - float(used)) if total is not None else None,
        "in_trial": bool(trial.get("is_in_trial")),
        "trial_eligible": bool(trial.get("is_eligible_for_trial")),
    }


def fetch_tier(creds: dict) -> dict:
    """订阅档位 + 额度（官方用量接口，只读、不消耗积分）。"""
    res = _request(creds, PATH_USAGE_WEB, body={"require_usage": True, "req_source": 1})
    return _tier_info(res["json"])


def models_info(uid=None) -> dict:
    """当前账号的订阅档位 + 可用模型清单。

    模型清单读本机 Trae CN 客户端缓存（官方未提供公开模型接口），
    档位走官方用量接口；两者互不阻塞，任何一路失败都只降级、不报错。
    """
    target = str(uid or "").strip() or current_uid()
    if not target:
        raise TraeError("尚未添加 Trae CN 账号")
    creds = resolve_credentials(target)

    tier, tier_err = {}, ""
    try:
        tier = fetch_tier(creds)
    except TraeError as e:
        tier_err = str(e)
    except Exception as e:                       # noqa: BLE001
        tier_err = "档位信息获取失败：%s" % e

    catalog, source, mtime = _read_local_models(target)
    models = _merge_models(catalog)
    counts = {
        "total": len(models),
        "vision": sum(1 for m in models if m["multimodal"]),
        "reasoning": sum(1 for m in models if m["thinking"]),
        "custom": sum(1 for m in models if m["custom"]),
        "free": sum(1 for m in models if m["free"]),
        "scenes": len([s for s in catalog if isinstance(catalog.get(s), list)]),
    }
    out = {
        "ok": True, "uid": target, "tier": tier, "tier_error": tier_err,
        "models": models, "counts": counts, "total": len(models),
        "source": source, "source_mtime": mtime,
        "updated_at": time.time(),
    }
    if not models:
        out["catalog_error"] = (
            "未找到本机 Trae CN 客户端的模型缓存。请确认本机装有并登录过 Trae CN 客户端"
            "（读取 ~/.config/Trae CN/User/globalStorage/state.vscdb），"
            "或设置环境变量 TRAE_STATE_DB 指向该文件。")
    return out

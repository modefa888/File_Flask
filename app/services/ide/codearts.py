"""CodeArts（华为云）积分 / 签到业务层。

原理
----
参考 dsh-get-it-for-free 渠道包（vendor/channel-pack 的 oauth.ts / login.ts /
sign.ts / codearts-credits.ts）在 Python 侧复刻同一条协议链：

链接登录（浏览器授权，OAuth + PKCE + DPoP）
    1. login_start 生成 ticket_id（32 字节 hex）、PKCE 对（48 字节 verifier →
       SHA-256 challenge）、ES256（P-256）DPoP 密钥对，并在本机 127.0.0.1
       起 :port ≥ 10000 的回调 HTTP 服务；
    2. 授权链接（用户在浏览器打开并登录华为云）：
       https://codearts.huaweicloud.com/portal/authorize?theme=2&locale=zh-cn
         &uri_scheme=codearts-agent&client_id=codearts-agent&port={port}
         &code_challenge={challenge}&code_challenge_method=SHA-256
         &ticket_id={ticket}&plugin-name=snap_AIIDE&plugin-version=5.2.0
    3. 登录完成后华为云重定向回本机 http://127.0.0.1:{port}/oauth/callback：
       带 ?code= → 用 PKCE verifier + DPoP 到 STS 换取令牌（含 refresh_token）；
       带 ?secret= → 轮询 snap login/ticket 接口拿 AK/SK 临时凭据；
    4. login_poll 轮询回调结果，成功后凭据整体加密落库。

凭据与续期
    STS 临时凭据 = AK / SK / security_token（约 2 小时一换）。带 refresh_token
    + code_verifier + DPoP 私钥的凭据可在过期前 30 分钟自动续期：
    POST https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens
    华为每签发一次旧 refresh_token 立即作废，因此同一账号的续期按 uid 串行，
    续期成功后整体替换账号行里的加密凭据 JSON。

签到（SDK-HMAC-SHA256 签名请求 snap-access 网关）
    GET  /snap-manager/v1/statistics/plugin   账户套餐 + 四类积分包余额
    GET  /v1/ops/delivery?channel=IDE         活动列表（每日签到 type=USER_LOGIN）
    POST /v1/ops/claim {campaignId, channel}  领取积分（响应带 benefitAmount / id）
    POST /v1/ops/confirm {campaignId}         确认入账（尽力而为）
    已领判定：claimable != true 且 status ∈ (CLAIMED, CONFIRMED, CONSUMED)。

安全约定
--------
  * 凭据 JSON 用 secret.encrypt 加密落库，接口一律不回显明文 / 密文；
  * 请求域名固定为华为云官方域名（sts / snap-access / codearts 官方域），
    不接受配置改写，避免把凭据发往任意地址；
  * 回调服务只绑 127.0.0.1、单次会话 10 分钟自动回收，端口 ≥ 10000；
  * 签到幂等：先查活动状态，已领直接跳过。
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import http.server
import json
import re
import secrets as pysecrets
import socket
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

from ...log import get_logger
from ..common import proxyutil, secret, store_db

_log = get_logger()

CONFIG_KEY = "codearts.config"

# ---------------------------------------------------------------- 官方端点（固定白名单，不开放配置）
STS_TOKEN_ENDPOINT = "https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens"
SNAP_ENGINE_URL = "https://snap-access.cn-north-4.myhuaweicloud.com"
PORTAL_AUTHORIZE_BASE = "https://codearts.huaweicloud.com/portal/authorize"
PORTAL_LOGIN_RESULT = ("https://codearts.huaweicloud.com/portal/login"
                       "?login_succeed={ok}&uri_scheme=codearts-agent&locale=zh-cn")
TICKET_CREDENTIAL_URL = SNAP_ENGINE_URL + "/snap-manager/v1/login/ticket"

OPENGW_GATEWAY_CONFIG_URL = "https://opengw.developer.huaweicloud.com/api/v1/gateway/config"
SNAP_MODEL_BUILTIN_URL = SNAP_ENGINE_URL + "/v1/model/builtin"

CLIENT_ID = "codearts-agent"
REDIRECT_PATH = "/oauth/callback"
OAUTH_THEME, OAUTH_LOCALE = "2", "zh-cn"
LOGIN_PLUGIN_NAME, LOGIN_PLUGIN_VERSION = "snap_AIIDE", "5.2.0"

PATH_PACKAGE_INFO = "/snap-manager/v1/statistics/plugin"
PATH_OPS_DELIVERY = "/v1/ops/delivery"
PATH_OPS_CLAIM = "/v1/ops/claim"
PATH_OPS_CONFIRM = "/v1/ops/confirm"
OPS_CHANNEL = "IDE"
DAILY_LOGIN_TYPE = "USER_LOGIN"
CLAIMED_STATUSES = ("CLAIMED", "CONFIRMED", "CONSUMED")
SNAP_EXTRA_HEADERS = {"Agent-Type": "PromptCenter", "X-Language": "zh-cn"}

CREDIT_METRIC_LABELS = {
    "usageTotalPackageCredit": "总积分包",
    "usageBasicPackageCredit": "基础积分包",
    "usageOnDemandPackageCredit": "按需积分包",
    "usageBonusPackageCredit": "赠送积分包",
}
TOTAL_CREDIT_METRIC = "usageTotalPackageCredit"

# 提前 30 分钟续期；回调会话 10 分钟回收；回调端口下限与参考实现一致（≥10000）
REFRESH_EARLY_SEC = 30 * 60
LOGIN_TTL = 600
MIN_CALLBACK_PORT = 10000
REQUEST_TIMEOUT = 30

MIN_BALANCE_TTL = 300.0            # 续期尝试节流（失败也至少隔 5 分钟再试）
_REFRESH_LOCKS = {}
_LAST_REFRESH_TRY = 0.0


class CodeArtsError(Exception):
    """可直接展示给用户的业务错误。"""


class CredentialExpiredError(CodeArtsError):
    """refresh_token 已失效，需要重新走链接登录。"""


# --------------------------------------------------------------------------- DPoP（ES256）

def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _b64url_decode(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def generate_dpop_keypair() -> dict:
    """生成 P-256 ES256 密钥对，返回可落库的私钥 JWK。"""
    from cryptography.hazmat.primitives.asymmetric import ec

    key = ec.generate_private_key(ec.SECP256R1())
    numbers = key.public_key().public_numbers()
    d = key.private_numbers().private_value
    int_to_b64 = lambda n: _b64url(n.to_bytes(32, "big"))
    return {"kty": "EC", "crv": "P-256", "d": int_to_b64(d),
            "x": int_to_b64(numbers.x), "y": int_to_b64(numbers.y)}


def generate_pkce_pair() -> tuple:
    """PKCE：verifier = 48 字节 base64url，challenge = SHA-256(verifier) base64url。"""
    verifier = _b64url(pysecrets.token_bytes(48))
    challenge = _b64url(hashlib.sha256(verifier.encode("ascii")).digest())
    return verifier, challenge


def sign_dpop(jwk: dict, htm: str, htu: str) -> str:
    """DPoP 证明 JWS：header 带公钥 JWK，payload 带 htm/htu/iat/jti，ES256 签名。"""
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.asymmetric.utils import (
        decode_dss_signature, encode_dss_signature)

    key = ec.derive_private_key(int.from_bytes(_b64url_decode(jwk["d"]), "big"),
                                ec.SECP256R1())
    header = {"alg": "ES256", "typ": "dpop+jwt",
              "jwk": {"kty": jwk["kty"], "crv": jwk["crv"],
                      "x": jwk["x"], "y": jwk["y"]}}
    payload = {"htm": htm, "htu": htu,
               "iat": int(time.time()), "jti": pysecrets.token_hex(32)}
    signing_input = "%s.%s" % (
        _b64url(json.dumps(header, separators=(",", ":")).encode()),
        _b64url(json.dumps(payload, separators=(",", ":")).encode()))
    der = key.sign(signing_input.encode("ascii"), ec.ECDSA(hashes.SHA256()))
    r, s = decode_dss_signature(der)
    # JWS 要求 R||S 各 32 字节定长拼接（cryptography 默认输出 DER）
    sig = r.to_bytes(32, "big") + s.to_bytes(32, "big")
    return "%s.%s" % (signing_input, _b64url(sig))


# --------------------------------------------------------------------------- STS 令牌

def _sts_request(body: dict, jwk: dict) -> dict:
    """调用华为 STS 令牌端点（DPoP 头 + form 表单），返回原始 JSON。"""
    dpop = sign_dpop(jwk, "POST", STS_TOKEN_ENDPOINT)
    payload = urllib.parse.urlencode(body).encode("utf-8")
    req = urllib.request.Request(STS_TOKEN_ENDPOINT, data=payload, method="POST", headers={
        "DPoP": dpop,
        "Content-Type": "application/x-www-form-urlencoded",
    })
    status, raw = 200, b""
    try:
        resp = urllib.request.build_opener().open(req, timeout=REQUEST_TIMEOUT)
        status = getattr(resp, "status", 200) or 200
        raw = resp.read(1024 * 512)
    except urllib.error.HTTPError as e:
        status = e.code
        try:
            raw = e.read(1024 * 512)
        except Exception:
            raw = b""
    except Exception as e:
        raise CodeArtsError("连接华为云 STS 失败：%s" % proxyutil.friendly_error(e, STS_TOKEN_ENDPOINT))
    try:
        obj = json.loads(raw.decode("utf-8", "replace"))
    except (TypeError, ValueError):
        obj = {}
    if not isinstance(obj, dict):
        obj = {}
    if status >= 300 or not obj.get("credentials"):
        error_code = str(obj.get("error_code") or "")
        message = "STS 返回 HTTP %s：%s" % (status, json.dumps(obj, ensure_ascii=False)[:300])
        err = (CredentialExpiredError(message)
               if obj.get("error") == "invalid_grant" or "ExpiredRefreshToken" in error_code
               else CodeArtsError(message))
        raise err
    return obj


def _credential_from_token(obj: dict, code_verifier: str, jwk: dict) -> dict:
    """STS 响应 → 凭据 dict（登录 code 换取 / 续期共用）。"""
    cred = obj.get("credentials") or {}
    return {
        "access_key_id": str(cred.get("access_key_id") or ""),
        "secret_access_key": str(cred.get("secret_access_key") or ""),
        "security_token": str(cred.get("security_token") or ""),
        "expires_at": str(cred.get("expiration") or ""),
        "refresh_token": str(obj.get("refresh_token") or ""),
        "code_verifier": code_verifier,
        "dpop_private_key_jwk": jwk,
    }


def refresh_credential(credential: dict) -> dict:
    """用 refresh_token 换一份新凭据；refresh_token 已作废时抛 CredentialExpiredError。"""
    refresh = str(credential.get("refresh_token") or "")
    verifier = str(credential.get("code_verifier") or "")
    jwk = credential.get("dpop_private_key_jwk") or {}
    if not refresh or not verifier or not jwk.get("d"):
        raise CredentialExpiredError("凭据缺少续期材料（refresh_token / DPoP 密钥），请重新链接登录")
    obj = _sts_request({
        "client_id": CLIENT_ID,
        "code_verifier": verifier,
        "grant_type": "refresh_token",
        "refresh_token": refresh,
    }, jwk)
    return _credential_from_token(obj, verifier, jwk)


def credential_expires_at(credential: dict) -> float:
    """security_token 到期时间（Unix 秒）；解析不出返回 0（按需续期）。

    STS 的 expiration 形如 2026-11-22T10:00:00Z（UTC），必须按 UTC 换算，
    不能当本地时间解析（否则东八区会偏差 8 小时）。
    """
    raw = str(credential.get("expires_at") or "").strip()
    if not raw:
        return 0.0
    try:
        from datetime import datetime, timezone
        dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        parsed = dt.timestamp()
    except (TypeError, ValueError):
        return 0.0
    return parsed if parsed > 0 else 0.0


def needs_refresh(credential: dict, now=None) -> bool:
    if not str(credential.get("refresh_token") or ""):
        return False
    now = now or time.time()
    exp = credential_expires_at(credential)
    return True if not exp else exp - now <= REFRESH_EARLY_SEC


# --------------------------------------------------------------------------- 链接登录（回调服务）

class _CallbackState:
    """一次授权会话：回调 HTTP 服务 + 结果 Future + PKCE / DPoP 材料。"""

    def __init__(self, ticket_id: str, code_verifier: str, jwk: dict,
                 port: int, server, login_url: str):
        self.ticket_id = ticket_id
        self.code_verifier = code_verifier
        self.jwk = jwk
        self.port = port
        self.server = server
        self.login_url = login_url
        self.created = time.time()
        self.result = {}                     # {"credential": {...}} 或 {"error": "..."}
        self.done = threading.Event()


class _OAuthCallbackHandler(http.server.BaseHTTPRequestHandler):
    """华为云授权完成后的本机回调：/oauth/callback?code=... 或 ?secret=...。"""

    def log_message(self, *args):        # 静默默认的请求日志
        return

    def do_OPTIONS(self):                # noqa: N802
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers",
                         "Content-Type, Authorization, X-Requested-With")
        self.end_headers()

    def do_GET(self):                    # noqa: N802
        state = getattr(self.server, "ca_state", None)
        url = urllib.parse.urlsplit(self.path)
        if url.path != REDIRECT_PATH:
            self.send_response(404)
            self.end_headers()
            return
        params = urllib.parse.parse_qs(url.query)
        code = (params.get("code") or [""])[0].strip()
        ticket_secret = (params.get("secret") or [""])[0].strip()
        if code:
            self._finish(True)           # 先回 307 再换令牌，避免浏览器端长时间转圈
            try:
                credential = _credential_from_token(_sts_request({
                    "client_id": CLIENT_ID,
                    "code": code,
                    "code_verifier": state.code_verifier,
                    "grant_type": "authorization_code",
                    "redirect_uri": "http://127.0.0.1:%d%s" % (state.port, REDIRECT_PATH),
                }, state.jwk), state.code_verifier, state.jwk)
                state.result = {"credential": credential}
            except Exception as e:       # noqa: BLE001
                state.result = {"error": str(e)}
            state.done.set()
        elif ticket_secret:
            self._finish(True)
            try:
                credential = _poll_ticket_credential(state.ticket_id, ticket_secret)
                state.result = {"credential": credential}
            except Exception as e:       # noqa: BLE001
                state.result = {"error": str(e)}
            state.done.set()
        else:
            self._finish(False)

    def _finish(self, ok: bool):
        self.send_response(307)
        self.send_header("Location", PORTAL_LOGIN_RESULT.format(ok=1 if ok else 0))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()


def _start_callback_server(state: _CallbackState):
    """在 127.0.0.1 上起回调 HTTP 服务（独立线程，会话结束 / 超时自动回收）。

    参考实现要求回调端口 ≥ 10000：系统随机分配到低端口号时换随机高端口重试。
    """
    server = None
    port = 0
    for _ in range(12):
        candidate = http.server.HTTPServer(("127.0.0.1", 0), _OAuthCallbackHandler)
        port = candidate.server_address[1]
        if port >= MIN_CALLBACK_PORT:
            server = candidate
            break
        candidate.server_close()
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            sock.bind(("127.0.0.1", 0))
            free = sock.getsockname()[1]
        finally:
            sock.close()
        try:
            candidate = http.server.HTTPServer(("127.0.0.1", free), _OAuthCallbackHandler)
            port = candidate.server_address[1]
            if port >= MIN_CALLBACK_PORT:
                server = candidate
                break
            candidate.server_close()
        except OSError:
            continue
    if server is None:
        raise CodeArtsError("本机回调端口分配失败（需要 ≥10000 的空闲端口），请稍后重试")
    state.port, state.server = port, server
    setattr(server, "ca_state", state)
    thread = threading.Thread(target=server.serve_forever,
                              kwargs={"poll_interval": 0.5}, daemon=True)
    thread.start()


def _close_callback_server(state: _CallbackState) -> None:
    server = getattr(state, "server", None)
    if server is not None:
        try:
            server.shutdown()
            server.server_close()
        except Exception:                # noqa: BLE001
            pass
        state.server = None


def _poll_ticket_credential(ticket_id: str, ticket_secret: str) -> dict:
    """用 ticket_id + secret 轮询 snap 凭据接口（对齐 pollForCredential，最多 120 次）。"""
    url = "%s?ticket_id=%s&secret=%s" % (
        TICKET_CREDENTIAL_URL, urllib.parse.quote(ticket_id),
        urllib.parse.quote(ticket_secret))
    last_error = "登录超时：未获取到凭据"
    for attempt in range(120):
        if attempt:
            time.sleep(1.0)
        req = urllib.request.Request(url, method="GET", headers={
            "Content-Type": "application/json;charset=UTF-8",
            "plugin-name": LOGIN_PLUGIN_NAME,
            "plugin-version": LOGIN_PLUGIN_VERSION,
        })
        try:
            resp = urllib.request.build_opener().open(req, timeout=20)
            status = getattr(resp, "status", 200) or 200
            raw = resp.read(1024 * 512)
        except Exception:                # noqa: BLE001
            last_error = "凭据接口连接失败，继续等待"
            continue
        if status >= 300:
            last_error = "凭据接口返回 HTTP %s" % status
            continue
        try:
            data = json.loads(raw.decode("utf-8", "replace"))
        except (TypeError, ValueError):
            continue
        credential = _parse_ticket_credential(data if isinstance(data, dict) else {})
        if credential:
            return credential
    raise CodeArtsError(last_error)


def _parse_ticket_credential(data: dict) -> dict:
    """snap login/ticket 响应 → 凭据 dict（兼容 credential / result 两种包裹）。"""
    out = {}
    cred = data.get("credential")
    if isinstance(cred, dict):
        access = str(cred.get("access") or "")
        token = str(cred.get("securitytoken") or cred.get("securityToken") or "")
        if access and token:
            out = {
                "access_key_id": access,
                "secret_access_key": str(cred.get("secret") or ""),
                "security_token": token,
                "expires_at": str(cred.get("expires_at") or cred.get("expiresAt") or ""),
            }
            for k in ("domain_id", "user_id", "user_name"):
                if data.get(k):
                    out[k] = str(data[k])
    result = data.get("result")
    if not out and isinstance(result, dict):
        ak = str(result.get("accessKeyId") or "")
        token = str(result.get("securityToken") or "")
        if ak and token:
            out = {
                "access_key_id": ak,
                "secret_access_key": str(result.get("secretAccessKey") or ""),
                "security_token": token,
                "expires_at": str(result.get("expiration") or result.get("expiresAt") or ""),
            }
            for k in ("domain_id", "user_id", "user_name"):
                if data.get(k):
                    out[k] = str(data[k])
    return out


# --------------------------------------------------------------------------- 登录会话

_LOGINS = {}
_LOGIN_LOCK = threading.RLock()


def _cleanup_logins() -> None:
    now = time.time()
    with _LOGIN_LOCK:
        for state in [s for s in _LOGINS.values() if now - s.created > LOGIN_TTL]:
            _close_callback_server(state)
            _LOGINS.pop(state.ticket_id, None)


def login_start() -> dict:
    """发起链接登录：返回授权链接；浏览器打开并登录华为云后回调本机端口。"""
    _cleanup_logins()
    ticket_id = pysecrets.token_hex(32)
    verifier, challenge = generate_pkce_pair()
    jwk = generate_dpop_keypair()
    state = _CallbackState(ticket_id, verifier, jwk, 0, None, "")
    _start_callback_server(state)
    query = urllib.parse.urlencode({
        "theme": OAUTH_THEME, "locale": OAUTH_LOCALE, "uri_scheme": CLIENT_ID,
        "client_id": CLIENT_ID, "port": state.port,
        "code_challenge": challenge, "code_challenge_method": "SHA-256",
        "ticket_id": ticket_id, "plugin-name": LOGIN_PLUGIN_NAME,
        "plugin-version": LOGIN_PLUGIN_VERSION,
    })
    state.login_url = "%s?%s" % (PORTAL_AUTHORIZE_BASE, query)
    with _LOGIN_LOCK:
        _LOGINS[ticket_id] = state
    return {"ok": True, "state": ticket_id, "url": state.login_url,
            "port": state.port, "expires_in": LOGIN_TTL}


def login_poll(state_id: str) -> dict:
    """轮询授权结果；成功后凭据加密落库并设为当前账号。"""
    state_id = str(state_id or "").strip()
    with _LOGIN_LOCK:
        state = _LOGINS.get(state_id)
    if not state:
        raise CodeArtsError("登录会话不存在或已过期，请重新发起链接登录")
    if time.time() - state.created > LOGIN_TTL:
        login_cancel(state_id)
        raise CodeArtsError("登录会话已超时，请重新发起链接登录")
    if not state.done.wait(timeout=0.2):
        return {"done": False, "message": "等待浏览器登录授权…"}
    result = dict(state.result)
    with _LOGIN_LOCK:
        _LOGINS.pop(state_id, None)
    _close_callback_server(state)
    if result.get("error"):
        raise CodeArtsError(str(result["error"]))
    credential = result.get("credential")
    if not credential:
        raise CodeArtsError("登录流程异常结束，请重新发起链接登录")
    acc = save_account({"credential": credential, "source": "oauth",
                        "login_method": "oauth"})
    set_current(acc["uid"])
    _log.info("CodeArts 链接登录完成（uid 已隐藏）")
    return {"done": True, "uid": acc["uid"], "nickname": acc["nickname"],
            "account": acc}


def login_cancel(state_id: str) -> None:
    with _LOGIN_LOCK:
        state = _LOGINS.pop(str(state_id or "").strip(), None)
    if state:
        _close_callback_server(state)


# --------------------------------------------------------------------------- 多账号

ACCOUNT_FIELDS = ("uid", "nickname", "source", "login_method", "credential",
                  "expires_at", "enabled", "is_default", "remark",
                  "last_balance", "last_check_at", "created_at", "updated_at")

_IDENTITY_KEYS = ("user_id", "user_name", "domain_id")


def _ak_fingerprint(access_key_id: str) -> str:
    """AK 指纹（FNV-1a 32 位 + 长度后缀）：identity 缺失时充当账号 uid 锚点。"""
    h = 0x811c9dc5
    for ch in str(access_key_id or ""):
        h = ((h ^ ord(ch)) * 0x01000193) & 0xFFFFFFFF
    return "%08x%s" % (h, len(str(access_key_id or "")))


def _credential_identity(credential: dict) -> tuple:
    """从凭据里取 (uid, nickname)；都缺失时用 AK 指纹兜底。"""
    uid = str(credential.get("user_id") or credential.get("domain_id") or "").strip()
    nickname = str(credential.get("user_name") or "").strip()
    if not uid:
        uid = "ak_" + _ak_fingerprint(credential.get("access_key_id") or "")
    if not nickname:
        nickname = str(credential.get("user_name") or "") or uid[:16]
    return uid[:64], nickname[:64]


def get_account(uid):
    """取账号原始行（含加密凭据，仅供服务端内部使用）。"""
    conn = store_db.store_conn()
    try:
        row = conn.execute("SELECT * FROM codearts_accounts WHERE uid=?",
                           (str(uid or ""),)).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def public_account(acc) -> dict:
    """脱敏后的账号信息：绝不包含 AK / SK / security_token / refresh_token。"""
    acc = acc or {}
    uid = str(acc.get("uid") or "")
    exp = float(acc.get("expires_at") or 0)
    credential_set = bool(acc.get("credential"))
    refreshable = False
    if credential_set:
        try:
            credential = json.loads(secret.decrypt(acc.get("credential") or "") or "{}")
            refreshable = bool(str(credential.get("refresh_token") or ""))
        except (TypeError, ValueError):
            refreshable = False
    return {
        "uid": uid,
        "nickname": acc.get("nickname") or "",
        "display_name": (acc.get("nickname") or acc.get("remark") or uid[:16] or "未命名账号"),
        "source": acc.get("source") or "",
        "login_method": acc.get("login_method") or "",
        "remark": acc.get("remark") or "",
        "enabled": int(acc.get("enabled") or 0),
        "is_default": int(acc.get("is_default") or 0),
        "credential_set": credential_set,
        "refreshable": refreshable,
        "expires_at": exp,
        "expires_text": time.strftime("%Y-%m-%d %H:%M", time.localtime(exp)) if exp else "",
        "expires_soon": bool(exp and exp - time.time() < REFRESH_EARLY_SEC + 600),
        "expired": bool(exp and exp < time.time()),
        "last_balance": acc.get("last_balance"),
        "last_check_at": acc.get("last_check_at") or 0,
        "created_at": acc.get("created_at") or 0,
        "updated_at": acc.get("updated_at") or 0,
    }


def list_accounts() -> list:
    conn = store_db.store_conn()
    try:
        rows = [dict(r) for r in conn.execute(
            "SELECT * FROM codearts_accounts ORDER BY is_default DESC, created_at ASC")]
    finally:
        conn.close()
    return [public_account(r) for r in rows]


def set_current(uid) -> str:
    uid = str(uid or "").strip()
    if uid and not get_account(uid):
        raise CodeArtsError("账号不存在或已被移除")
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
    """新增 / 更新账号；凭据 JSON 整体加密落库。

    两个入口：
      * login_poll → data["credential"] = 解析好的凭据 dict（自动定 uid / 昵称）；
      * 界面编辑   → 只允许改 nickname / remark / enabled / is_default。
    """
    data = data or {}
    credential = data.get("credential")
    if isinstance(credential, str):
        try:
            credential = json.loads(credential)
        except (TypeError, ValueError):
            raise CodeArtsError("凭据格式无效：需要登录流程生成的凭据 JSON")
    now = time.time()
    if credential:
        uid, nickname = _credential_identity(credential)
        uid = str(data.get("uid") or uid).strip() or uid
        old = get_account(uid) or {}
        if old:
            # 保留旧身份字段（STS 续期响应不带身份信息，别被覆盖丢掉）
            try:
                prev = json.loads(secret.decrypt(old.get("credential") or "") or "{}")
            except (TypeError, ValueError):
                prev = {}
            for k in _IDENTITY_KEYS:
                if not credential.get(k) and prev.get(k):
                    credential[k] = prev[k]
            if not str(data.get("nickname") or "").strip():
                nickname = old.get("nickname") or nickname
        acc = {k: old.get(k) for k in ACCOUNT_FIELDS}
        acc.update({
            "uid": uid,
            "nickname": str(data.get("nickname") or nickname or "").strip()[:64],
            "source": str(data.get("source") or old.get("source") or "oauth")[:32],
            "login_method": str(data.get("login_method") or "oauth")[:32],
            "credential": secret.encrypt(json.dumps(credential, ensure_ascii=False)),
            "expires_at": credential_expires_at(credential),
            "enabled": 1 if old.get("enabled") is None else int(old.get("enabled") or 0),
            "remark": str(data.get("remark") or old.get("remark") or "").strip()[:256],
            "created_at": float(old.get("created_at") or now),
            "updated_at": now,
        })
        if data.get("enabled") is not None:
            acc["enabled"] = 1 if data["enabled"] else 0
    else:
        uid = str(data.get("uid") or "").strip()
        old = get_account(uid)
        if not old:
            raise CodeArtsError("账号不存在，无法保存")
        acc = {k: old.get(k) for k in ACCOUNT_FIELDS}
        for k in ("nickname", "remark"):
            if k in data:
                acc[k] = str(data[k] or "").strip()[:256]
        if "enabled" in data:
            acc["enabled"] = 1 if data["enabled"] else 0
        acc["updated_at"] = now

    with store_db.store_tx() as conn:
        others = conn.execute(
            "SELECT 1 FROM codearts_accounts WHERE is_default=1 AND uid<>? LIMIT 1",
            (uid,)).fetchone()
        make_default = bool(data.get("is_default")) or not others
        if make_default:
            conn.execute("UPDATE codearts_accounts SET is_default=0")
            acc["is_default"] = 1
        conn.execute(
            "INSERT OR REPLACE INTO codearts_accounts (%s) VALUES (%s)"
            % (", ".join(ACCOUNT_FIELDS), ", ".join("?" for _ in ACCOUNT_FIELDS)),
            tuple(acc.get(k) for k in ACCOUNT_FIELDS))
    if make_default or not str(get_config().get("current_uid") or "").strip():
        set_current(uid)
    return public_account(get_account(uid))


def delete_account(uid) -> list:
    """移除账号；若删的是当前 / 默认账号，自动把剩余账号补位。"""
    uid = str(uid or "").strip()
    if not get_account(uid):
        raise CodeArtsError("账号不存在或已被移除")
    with store_db.store_tx() as conn:
        conn.execute("DELETE FROM codearts_accounts WHERE uid=?", (uid,))
        row = conn.execute(
            "SELECT uid FROM codearts_accounts ORDER BY is_default DESC, created_at ASC "
            "LIMIT 1").fetchone()
        if row:
            conn.execute("UPDATE codearts_accounts SET is_default=1 WHERE uid=?",
                         (row["uid"],))
    if str(get_config().get("current_uid") or "") == uid:
        set_current(row["uid"] if row else "")
    return list_accounts()


# --------------------------------------------------------------------------- 配置

_DEFAULTS = {"proxy": "", "timeout": 20, "current_uid": ""}
_PUBLIC_KEYS = ("proxy", "timeout", "current_uid")


def get_config() -> dict:
    cfg = dict(_DEFAULTS)
    try:
        doc = json.loads(store_db.get_meta(CONFIG_KEY) or "{}")
        if isinstance(doc, dict):
            for k in _PUBLIC_KEYS:
                if k in doc:
                    cfg[k] = doc[k]
    except (TypeError, ValueError):
        pass
    try:
        cfg["timeout"] = max(3, min(60, int(cfg["timeout"])))
    except (TypeError, ValueError):
        cfg["timeout"] = 20
    return cfg


def save_config(data: dict) -> dict:
    data = data or {}
    cfg = get_config()
    for k in _PUBLIC_KEYS:
        if k in data:
            cfg[k] = data[k] if k == "timeout" else str(data[k]).strip()
    try:
        cfg["timeout"] = max(3, min(60, int(cfg.get("timeout") or 20)))
    except (TypeError, ValueError):
        cfg["timeout"] = 20
    store_db.set_meta(CONFIG_KEY, json.dumps(cfg, ensure_ascii=False))
    return public_config()


def public_config() -> dict:
    cfg = get_config()
    out = {k: cfg[k] for k in _PUBLIC_KEYS}
    out.update({
        "accounts": list_accounts(),
        "current_uid": current_uid(),
        "account": public_account(get_account(current_uid())) if current_uid() else None,
    })
    return out


# --------------------------------------------------------------------------- 续期

def _maybe_refresh(acc: dict) -> dict:
    """security_token 临近过期时自动续期一次；失败不阻断查询（继续用旧凭据）。

    只对带续期材料（refresh_token + DPoP 私钥）的凭据主动续期；ticket 登录
    路径的凭据没有这些材料，直接沿用现有凭据——真过期时接口会返回
    APIG.0602，提示重新链接登录即可，不能在这里凭空报「需要重新登录」。
    """
    global _LAST_REFRESH_TRY
    if not acc:
        return acc
    exp = float(acc.get("expires_at") or 0)
    if exp and exp - time.time() > REFRESH_EARLY_SEC:
        return acc
    try:
        credential = json.loads(secret.decrypt(acc.get("credential") or "") or "{}")
    except (TypeError, ValueError):
        return acc
    jwk = credential.get("dpop_private_key_jwk") or {}
    if not str(credential.get("refresh_token") or "") or not jwk.get("d"):
        return acc
    uid = str(acc.get("uid") or "")
    lock = _REFRESH_LOCKS.setdefault(uid, threading.RLock())
    now = time.time()
    fresh = get_account(uid)
    if not fresh:
        return acc
    if float(fresh.get("expires_at") or 0) - time.time() > REFRESH_EARLY_SEC:
        return fresh                      # 其他线程刚续过
    if now - _LAST_REFRESH_TRY < MIN_BALANCE_TTL:
        return fresh
    with lock:
        _LAST_REFRESH_TRY = time.time()
        try:
            refresh_login(uid=uid)
        except CredentialExpiredError:
            raise                         # 需要重新登录：上层如实报错
        except Exception as e:            # noqa: BLE001
            _log.warning("CodeArts 凭据自动续期失败（继续用旧凭据）：%s", e)
    return get_account(uid) or acc


def refresh_login(uid=None, force=False) -> dict:
    """手动 / 自动续期指定账号的 STS 临时凭据（每签发一次旧 refresh_token 作废）。"""
    target = str(uid or "").strip() or current_uid()
    acc = get_account(target)
    if not acc:
        raise CodeArtsError("账号不存在，请先添加账号")
    try:
        credential = json.loads(secret.decrypt(acc.get("credential") or "") or "{}")
    except (TypeError, ValueError):
        raise CodeArtsError("凭据数据损坏，请重新链接登录")
    if not credential.get("access_key_id"):
        raise CodeArtsError("该账号没有可用凭据，请重新链接登录")
    if not str(credential.get("refresh_token") or ""):
        # ticket 登录路径没有 refresh_token：临期只能提示重新登录
        exp = float(acc.get("expires_at") or 0)
        if not force and exp and exp - time.time() > 120:
            return {"ok": True, "uid": target, "skipped": True,
                    "expires_at": exp,
                    "expires_text": time.strftime("%Y-%m-%d %H:%M", time.localtime(exp)),
                    "message": "凭据仍在有效期内（该账号不支持自动续期）"}
        raise CredentialExpiredError("该账号凭据不支持自动续期（无 refresh_token），请重新链接登录")
    next_credential = refresh_credential(credential)
    saved = save_account({"uid": target, "credential": next_credential})
    _log.info("CodeArts 凭据已续期（uid 已隐藏）")
    return {"ok": True, "uid": target, "expires_at": saved["expires_at"],
            "expires_text": saved["expires_text"]}


def resolve_credentials(uid=None) -> dict:
    """按账号解析凭据（临期自动续期），返回解密后的 credential dict。"""
    target = str(uid or "").strip() or current_uid()
    if not target:
        raise CodeArtsError("尚未添加 CodeArts 账号，请点「链接登录」")
    acc = _maybe_refresh(get_account(target))
    if not acc:
        raise CodeArtsError("账号不存在或已被移除")
    try:
        credential = json.loads(secret.decrypt(acc.get("credential") or "") or "{}")
    except (TypeError, ValueError):
        credential = {}
    if not credential.get("access_key_id") or not credential.get("secret_access_key"):
        raise CodeArtsError("凭据缺失或损坏，请对该账号重新链接登录")
    if credential.get("security_token") is None:
        credential["security_token"] = ""
    credential["_uid"] = target
    credential["_nickname"] = acc.get("nickname") or ""
    return credential


# --------------------------------------------------------------------------- 签名与请求

def _sign_snap_request(method: str, url: str, credential: dict, body=None) -> dict:
    """构造 SDK-HMAC-SHA256 签名请求头（对齐 signRequestHuawei / signedSnapRequest）。

    返回 {"ok": bool, "status": int, "json": obj, "message": str,
          "token_expired": bool}；业务码非 0 时 ok=False 并带 message。
    """
    ak = str(credential.get("access_key_id") or "")
    sk = str(credential.get("secret_access_key") or "")
    st = str(credential.get("security_token") or "")
    if not ak or not sk:
        return {"ok": False, "status": 0, "json": {}, "message": "凭据缺少 AK/SK",
                "token_expired": False}
    parts = urllib.parse.urlsplit(url)
    uri = parts.path if parts.path.endswith("/") else parts.path + "/"
    query = parts.query
    payload = b"" if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
    payload_hash = hashlib.sha256(payload).hexdigest()
    date_stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    headers = {
        "host": parts.netloc,
        "x-sdk-date": date_stamp,
        "x-sdk-content-sha256": payload_hash,
        "x-security-token": st,
    }
    if method.upper() != "GET":
        headers["content-type"] = "application/json"
    signed = sorted(headers)
    canonical = "\n".join([
        method.upper(), uri, query,
        "\n".join("%s:%s" % (k, headers[k]) for k in signed),
        "", ";".join(signed), payload_hash,
    ])
    canonical_hash = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    string_to_sign = "SDK-HMAC-SHA256\n%s\n%s" % (date_stamp, canonical_hash)
    signature = hmac.new(sk.encode("utf-8"), string_to_sign.encode("utf-8"),
                         hashlib.sha256).hexdigest()
    headers["Authorization"] = ("SDK-HMAC-SHA256 Access=%s,SignedHeaders=%s,Signature=%s"
                               % (ak, ";".join(signed), signature))

    req_headers = {k: v for k, v in headers.items() if k != "host"}
    req_headers.update(SNAP_EXTRA_HEADERS)
    req = urllib.request.Request(url, data=(payload if payload else None),
                                 method=method.upper(), headers=req_headers)
    cfg = get_config()
    try:
        opener = (proxyutil.build_opener(proxy=str(cfg.get("proxy") or "").strip())
                  if str(cfg.get("proxy") or "").strip()
                  else urllib.request.build_opener())
    except ValueError as e:
        return {"ok": False, "status": 0, "json": {}, "message": "代理配置有误：%s" % e,
                "token_expired": False}
    status, raw = 200, b""
    try:
        resp = opener.open(req, timeout=int(cfg.get("timeout") or 20))
        status = getattr(resp, "status", 200) or 200
        raw = resp.read(1024 * 512)
    except urllib.error.HTTPError as e:
        status = e.code
        try:
            raw = e.read(1024 * 512)
        except Exception:
            raw = b""
    except Exception as e:
        return {"ok": False, "status": 0, "json": {},
                "message": "连接华为云接口失败：%s" % proxyutil.friendly_error(e, url),
                "token_expired": False}
    text = raw.decode("utf-8", "replace")
    try:
        obj = json.loads(text)
    except (TypeError, ValueError):
        obj = {}
    token_expired = bool(obj.get("error_code") == "APIG.0602"
                         or "the security token has expired" in text.lower())
    if status >= 300 or token_expired:
        detail = ""
        if isinstance(obj, dict):
            detail = " ".join(str(obj.get(k) or "") for k in ("error_code", "error_msg")).strip()
        return {"ok": False, "status": status, "json": obj if isinstance(obj, dict) else {},
                "message": ("HTTP %s：%s" % (status, detail or text[:200])) if status else text[:200],
                "token_expired": token_expired}
    # 业务信封 {code, message, data}：code 缺失视为成功
    code = obj.get("code") if isinstance(obj, dict) else None
    if isinstance(code, int) and code != 0:
        msg = str(obj.get("message") or obj.get("msg") or "业务码 %s" % code)
        return {"ok": False, "status": status, "json": obj, "message": msg,
                "token_expired": False}
    data = obj.get("data") if isinstance(obj, dict) else None
    if data is None and isinstance(obj, dict):
        data = obj
    return {"ok": True, "status": status, "json": obj, "data": data,
            "message": "", "token_expired": False}


def _snap_request(method: str, url: str, credential: dict, body=None,
                  uid: str = "") -> dict:
    """签名请求 + 临时令牌过期自动续期重试一次（仅重发一次，防死循环）。"""
    result = _sign_snap_request(method, url, credential, body)
    if not result["ok"] and result["token_expired"] and uid:
        try:
            refresh_login(uid=uid, force=True)
        except Exception:                # noqa: BLE001
            return result
        next_credential = resolve_credentials(uid)
        next_credential.pop("_uid", None)
        result = _sign_snap_request(method, url, next_credential, body)
    return result


# --------------------------------------------------------------------------- 积分查询

def _read_bool(source, key) -> bool:
    value = source.get(key)
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() == "true"
    return False


def _read_num(source, key) -> float:
    value = source.get(key)
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    try:
        return float(str(value).strip())
    except (TypeError, ValueError):
        return 0.0


def _read_str(source, key) -> str:
    value = source.get(key)
    return str(value) if value is not None and not isinstance(value, (dict, list)) else ""


def fetch_account_info(credential: dict, uid: str = "") -> dict:
    """账户套餐 + 四类积分包余额（GET snap-manager/v1/statistics/plugin）。"""
    result = _snap_request("GET", SNAP_ENGINE_URL + PATH_PACKAGE_INFO, credential, uid=uid)
    if not result["ok"]:
        raise CodeArtsError("账户信息查询失败：%s" % result["message"])
    data = result["data"] if isinstance(result.get("data"), dict) else {}
    pkg = data.get("package") if isinstance(data.get("package"), dict) else {}
    metrics = data.get("metrics") if isinstance(data.get("metrics"), list) else []
    packages = []
    total_remain = None
    saw_metric = False
    for item in metrics:
        if not isinstance(item, dict):
            continue
        name = _read_str(item, "name")
        label = CREDIT_METRIC_LABELS.get(name)
        if not label:
            continue
        saw_metric = True
        amount = _read_num(item, "package_credit_amount")
        used = _read_num(item, "package_credit_used")
        remain = _read_num(item, "package_credit_remain")
        if name == TOTAL_CREDIT_METRIC:
            total_remain = remain
        if amount <= 0 and remain <= 0:
            continue
        packages.append({"pid": name, "name": label, "remain": remain,
                         "used": used, "size": amount,
                         # usageTotalPackageCredit 是「基础+按需+赠送」的汇总口径，
                         # 不能与子项相加（否则余额翻倍）。单独打标供聚合时剔除。
                         "is_total": name == TOTAL_CREDIT_METRIC})
    return {
        "is_credit_package": _read_bool(pkg, "is_credit_package"),
        "is_token_package": _read_bool(pkg, "is_token_package"),
        "spec_code": _read_str(pkg, "spec_code"),
        "package_name": _read_str(pkg, "package_name_cn") or _read_str(pkg, "package_name_en"),
        "package_status": _read_str(pkg, "status"),
        "packages": packages if saw_metric else [],
        "balance": total_remain if total_remain is not None else sum(
            p["remain"] for p in packages),
    }


def _parse_activity(item: dict) -> dict:
    """活动条目裁剪（campaignId 实测是数字 1，需 readIdentifier 兜底）。"""
    campaign_id = item.get("campaignId")
    if not isinstance(campaign_id, str):
        campaign_id = str(campaign_id) if campaign_id is not None else ""
    return {
        "campaign_id": campaign_id.strip(),
        "type": _read_str(item, "type"),
        "title": _read_str(item, "title"),
        "claimable": _read_bool(item, "claimable"),
        "status": _read_str(item, "status"),
        "amount": (_read_num(item, "benefitAmount") or _read_num(item, "amount")
                   or _read_num(item, "creditAmount")),
    }


def fetch_activities(credential: dict, uid: str = "") -> list:
    """活动列表（GET /v1/ops/delivery?channel=IDE）。"""
    url = "%s%s?channel=%s" % (SNAP_ENGINE_URL, PATH_OPS_DELIVERY, OPS_CHANNEL)
    result = _snap_request("GET", url, credential, uid=uid)
    if not result["ok"]:
        raise CodeArtsError("活动列表查询失败：%s" % result["message"])
    data = result["data"] if isinstance(result.get("data"), dict) else {}
    items = data.get("items")
    if not isinstance(items, list):
        raise CodeArtsError("活动列表响应缺少 items 字段")
    return [_parse_activity(x) for x in items if isinstance(x, dict)]


def _daily_activity(activities: list):
    for activity in activities:
        if activity["type"] == DAILY_LOGIN_TYPE:
            return activity
    return None


def fetch_status(credential: dict, uid: str = "") -> dict:
    """今日签到状态（形状对齐 WorkBuddy 的 today_checked_in / today_credit）。"""
    info = fetch_account_info(credential, uid=uid)
    if not info["is_credit_package"]:
        return {"active": False, "today_checked_in": False, "today_credit": 0,
                "message": "非积分计费账户（Token 计费），不在积分活动范围"}
    activity = _daily_activity(fetch_activities(credential, uid=uid))
    if not activity:
        return {"active": False, "today_checked_in": False, "today_credit": 0,
                "message": "未找到每日签到活动"}
    claimed = not activity["claimable"] and activity["status"] in CLAIMED_STATUSES
    return {"active": True, "today_checked_in": claimed,
            "today_credit": activity["amount"] if claimed else 0,
            "amount": activity["amount"], "claimable": activity["claimable"],
            "campaign_status": activity["status"], "activity_title": activity["title"],
            "balance": info["balance"], "package_name": info["package_name"]}


def do_checkin(credential: dict, uid: str = "", source="manual") -> dict:
    """执行签到（幂等，永不抛业务异常之外的网络细节）：
    查账户信息 → 查活动列表 → claim → confirm（尽力而为）。"""
    try:
        info = fetch_account_info(credential, uid=uid)
    except CodeArtsError as e:
        result = {"ok": False, "status": "failed", "credit": 0,
                  "message": "账户信息查询失败：%s" % e}
        _record(uid, result, source)
        return result
    if not info["is_credit_package"]:
        result = {"ok": True, "status": "inactive", "credit": 0,
                  "message": "Token 计费账户，不在积分活动范围"
                  if info["is_token_package"] else "非积分计费账户，不在积分活动范围"}
        _record(uid, result, source)
        return result
    try:
        activities = fetch_activities(credential, uid=uid)
    except CodeArtsError as e:
        result = {"ok": False, "status": "failed", "credit": 0,
                  "message": "活动列表查询失败：%s" % e}
        _record(uid, result, source)
        return result
    activity = _daily_activity(activities)
    if not activity:
        result = {"ok": True, "status": "inactive", "credit": 0,
                  "message": "未找到每日签到活动"}
        _record(uid, result, source)
        return result
    if not activity["claimable"]:
        if activity["status"] in CLAIMED_STATUSES:
            result = {"ok": True, "status": "already", "credit": 0,
                      "message": "今天已领取（benefitAmount=%g）" % activity["amount"]
                      if activity["amount"] else "今天已领取"}
        else:
            result = {"ok": True, "status": "inactive", "credit": 0,
                      "message": "当前不可领取（status=%s）" % (activity["status"] or "未知")}
        _record(uid, result, source)
        return result
    if not activity["campaign_id"]:
        result = {"ok": False, "status": "failed", "credit": 0,
                  "message": "活动缺少 campaignId，无法领取"}
        _record(uid, result, source)
        return result
    claim = _snap_request(
        "POST", SNAP_ENGINE_URL + PATH_OPS_CLAIM, credential,
        body={"campaignId": activity["campaign_id"], "channel": OPS_CHANNEL}, uid=uid)
    if not claim["ok"]:
        result = {"ok": False, "status": "failed", "credit": 0,
                  "message": "领取失败：%s" % claim["message"]}
        _record(uid, result, source)
        return result
    claim_data = claim.get("data") if isinstance(claim.get("data"), dict) else {}
    credit = (_read_num(claim_data, "benefitAmount") or _read_num(claim_data, "credit")
              or _read_num(claim_data, "credits") or _read_num(claim_data, "creditAmount")
              or _read_num(claim_data, "amount") or activity["amount"])
    if claim_data.get("id") is not None:
        # 确认入账：尽力而为，失败不影响积分已领取的事实
        _snap_request("POST", SNAP_ENGINE_URL + PATH_OPS_CONFIRM, credential,
                      body={"campaignId": activity["campaign_id"]}, uid=uid)
    result = {"ok": True, "status": "success", "credit": credit,
              "message": "签到成功，积分已到账（%s +%g）" % (
                  activity["title"] or "每日签到", credit)}
    _record(uid, result, source)
    _log.info("CodeArts 签到完成（来源 %s）：%s", source, result["status"])
    return result


# --------------------------------------------------------------------------- 记录 / 汇总

def _record(uid: str, result: dict, source: str) -> None:
    """一天一账号一条记录（重复点击只覆盖同一行）。"""
    if not uid:
        return
    day = time.strftime("%Y-%m-%d")
    try:
        with store_db.store_tx() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO codearts_checkin "
                "(day, uid, status, credit, message, source, at) VALUES (?,?,?,?,?,?,?)",
                (day, str(uid), result.get("status") or "",
                 float(result.get("credit") or 0), result.get("message") or "",
                 source, time.time()))
    except Exception as e:
        _log.warning("CodeArts 签到记录写入失败：%s", e)


def list_history(q="", page=1, size=10, limit=None, sort="", order="", uid=None) -> dict:
    """签到记录（默认按日期倒序）；uid 可按账号筛选，limit 供日历取最近 N 条。"""
    conn = None
    try:
        conn = store_db.store_conn()
        rows = [dict(r) for r in conn.execute(
            "SELECT * FROM codearts_checkin ORDER BY day DESC, at DESC")]
    except Exception as e:
        _log.warning("CodeArts 签到记录读取失败：%s", e)
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
            "status_text": {"success": "签到成功", "already": "今日已领",
                            "inactive": "不适用", "failed": "失败"}.get(r["status"], r["status"]),
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


def _update_balance(uid, balance) -> None:
    """缓存账号最近一次查到的余额，供账号列表展示。"""
    try:
        with store_db.store_tx() as conn:
            conn.execute(
                "UPDATE codearts_accounts SET last_balance=?, last_check_at=? WHERE uid=?",
                (float(balance), time.time(), str(uid)))
    except Exception as e:
        _log.warning("CodeArts 余额缓存写入失败：%s", e)


def save_packages(uid, packages) -> None:
    """按账号全量替换积分构成快照。"""
    now = time.time()
    with store_db.store_tx() as conn:
        conn.execute("DELETE FROM codearts_packages WHERE uid=?", (str(uid),))
        for p in packages:
            conn.execute(
                "INSERT OR REPLACE INTO codearts_packages "
                "(uid, pid, name, remain, used, size, updated_at) VALUES (?,?,?,?,?,?,?)",
                (str(uid), p["pid"], p["name"], p["remain"], p["used"],
                 p["size"], now))


def refresh_packages(uid=None) -> dict:
    """刷新指定账号的积分构成快照并同步余额缓存。"""
    target = str(uid or "").strip() or current_uid()
    if not target:
        raise CodeArtsError("尚未添加账号")
    credential = resolve_credentials(target)
    info = fetch_account_info(credential, uid=target)
    save_packages(target, info["packages"])
    if info["balance"] is not None:
        _update_balance(target, info["balance"])
    return {"ok": True, "uid": target, "count": len(info["packages"]),
            "balance": info["balance"]}


def _public_package(row, now=None) -> dict:
    return {
        "pid": row.get("pid"), "name": row.get("name") or "积分包",
        "remain": float(row.get("remain") or 0),
        "used": float(row.get("used") or 0),
        "size": float(row.get("size") or 0),
        # usageTotalPackageCredit 是汇总口径（= 基础 + 按需 + 赠送），
        # 聚合时单独处理，避免与子项相加导致余额翻倍
        "is_total": row.get("pid") == TOTAL_CREDIT_METRIC,
        "updated_at": float(row.get("updated_at") or 0),
    }


def credits_summary() -> dict:
    """跨账号积分统计 + 账号构成（全部读本地快照，不发外部请求）。

    口径：usageTotalPackageCredit（总积分包）是官方下发的「汇总」指标，
    基础 / 按需 / 赠送三类是它的构成明细。余额 / 总额 / 已用一律优先取
    汇总行；没有汇总行时才回退为构成明细求和。构成堆叠条与来源统计只
    用明细类目，汇总行只出现在明细表里（打「汇总」标记）。
    """
    accounts = list_accounts()
    conn = store_db.store_conn()
    try:
        rows = [dict(r) for r in conn.execute(
            "SELECT * FROM codearts_packages ORDER BY uid, pid")]
    finally:
        conn.close()
    per_uid = {}
    for r in rows:
        per_uid.setdefault(r["uid"], []).append(_public_package(r))
    by_account, by_source = [], {}
    total_balance = total_size = total_used = 0.0
    updated_at = 0.0
    for acc in accounts:
        uid = acc["uid"]
        packs = per_uid.get(uid, [])
        total_pack = next((p for p in packs if p["is_total"]), None)
        breakdown = [p for p in packs if not p["is_total"]]
        if total_pack:
            balance, size, used = total_pack["remain"], total_pack["size"], total_pack["used"]
        else:
            balance = sum(p["remain"] for p in breakdown)
            size = sum(p["size"] for p in breakdown)
            used = sum(p["used"] for p in breakdown)
        if not packs and acc.get("last_balance") is not None:
            balance = float(acc["last_balance"])
            size = balance
        total_balance += balance
        total_size += size
        total_used += used
        local_sources = {}
        for p in breakdown:
            updated_at = max(updated_at, p["updated_at"])
            for target in (by_source, local_sources):
                s = target.setdefault(p["pid"], {
                    "name": p["name"], "remain": 0.0, "size": 0.0, "count": 0})
                s["remain"] += p["remain"]
                s["size"] += p["size"]
                s["count"] += 1
        by_account.append({
            "uid": uid, "display_name": acc["display_name"],
            "is_default": acc["is_default"], "balance": balance,
            "size": size, "used": used, "package_count": len(packs),
            "no_detail": not packs, "packages": packs,
            "by_source": sorted(local_sources.values(), key=lambda s: -s["remain"]),
            "last_check_at": acc["last_check_at"],
        })
    return {
        "ok": True,
        "total_balance": round(total_balance, 2),
        "total_size": round(total_size, 2),
        "total_used": round(total_used, 2),
        "account_count": len(accounts),
        "package_count": len(rows),
        "by_account": by_account,
        "by_source": sorted(by_source.values(), key=lambda s: -s["remain"]),
        "updated_at": updated_at,
        "no_expiry": True,               # 华为积分包不下发到期时间
    }


# --------------------------------------------------------------------------- 首屏汇总

def _local_status(uid: str, today: str) -> dict:
    """从本地签到记录推断账号状态（缓存模式不发任何外部请求）。"""
    conn = store_db.store_conn()
    try:
        rows = [dict(r) for r in conn.execute(
            "SELECT day, status, credit FROM codearts_checkin "
            "WHERE uid=? ORDER BY day DESC LIMIT 120", (str(uid),))]
    finally:
        conn.close()
    ok_days = {r["day"] for r in rows if r["status"] in ("success", "already")}
    total_credit = sum(float(r["credit"] or 0) for r in rows)
    today_credit = 0.0
    for r in rows:
        if r["day"] == today:
            today_credit = float(r["credit"] or 0)
            break
    return {"today_checked_in": today in ok_days, "today_credit": today_credit,
            "total_credits": total_credit, "cached": True}


def _checkin_all_done(accounts, today, extra_checked=()) -> bool:
    """所有启用账号今天是否都已签到。"""
    enabled = [str(a.get("uid") or "") for a in (accounts or []) if a.get("enabled")]
    if not enabled:
        return False
    conn = store_db.store_conn()
    try:
        rows = [r[0] for r in conn.execute(
            "SELECT uid FROM codearts_checkin "
            "WHERE day=? AND status IN ('success','already')", (today,))]
    except Exception as e:
        _log.warning("CodeArts 批量签到状态读取失败：%s", e)
        return False
    finally:
        conn.close()
    checked = set(rows) | {str(u) for u in extra_checked if u}
    return all(uid in checked for uid in enabled)


def overview(uid=None, fresh=False) -> dict:
    """首屏：指定账号的余额 / 签到状态 + 全部账号列表 + 该账号最近记录。

    fresh=False（默认）只读本地库；fresh=True 才请求华为云接口拉取最新数据。
    """
    target = str(uid or "").strip() or current_uid()
    acc = get_account(target) if target else None
    out = {"ok": True, "config": public_config(), "today": time.strftime("%Y-%m-%d"),
           "updated_at": time.time(), "status": None, "credits": None,
           "errors": {}, "history_recent": [], "history_all": [],
           "accounts": list_accounts(), "current_uid": target,
           "account": public_account(acc) if acc else None}
    out["checkin_all_done"] = _checkin_all_done(out["accounts"], out["today"])
    hist_limit = 14 * max(1, len(out["accounts"])) + 60
    if not acc:
        out["configured"] = False
        out["error"] = "尚未添加 CodeArts 账号，请点「链接登录」完成华为云授权"
        out["history_all"] = list_history(limit=hist_limit)["items"]
        out["credits_summary"] = credits_summary()
        return out
    if not fresh:
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
        return out
    out["cached"] = False
    try:
        credential = resolve_credentials(target)
    except CredentialExpiredError as e:
        out["configured"] = False
        msg = str(e)
        out["error"] = msg if "重新链接登录" in msg else "%s（请对该账号重新链接登录）" % msg
        out["history_recent"] = list_history(limit=30, uid=target)["items"]
        out["history_all"] = list_history(limit=hist_limit)["items"]
        out["credits_summary"] = credits_summary()
        return out
    except CodeArtsError as e:
        out["configured"] = False
        out["error"] = str(e)
        out["history_recent"] = list_history(limit=30, uid=target)["items"]
        out["history_all"] = list_history(limit=hist_limit)["items"]
        out["credits_summary"] = credits_summary()
        return out
    out["configured"] = True
    credential = dict(credential)
    credential.pop("_uid", None)
    credential.pop("_nickname", None)
    out["credential"] = {
        "uid": target,
        "access_key_masked": (str(credential.get("access_key_id") or "")[:8] + "…"
                               if credential.get("access_key_id") else ""),
        "expires_at": credential_expires_at(credential),
        "refreshable": bool(str(credential.get("refresh_token") or "")),
    }
    with ThreadPoolExecutor(max_workers=2) as pool:
        jobs = {"status": pool.submit(fetch_status, credential, target),
                "packages": pool.submit(refresh_packages, target)}
        for key, job in jobs.items():
            try:
                res = job.result()
                out["packages_refresh" if key == "packages" else key] = res
            except Exception as e:
                out["errors"][key] = str(e)
    packages_refresh = out.get("packages_refresh") or {}
    if packages_refresh.get("balance") is not None:
        out["credits"] = {"balance": float(packages_refresh["balance"]),
                          "used": None, "total": None,
                          "balance_key": "codearts.packages", "expire_at": ""}
        _update_balance(target, out["credits"]["balance"])
    elif out.get("status") and out["status"].get("balance") is not None:
        out["credits"] = {"balance": float(out["status"]["balance"]),
                          "used": None, "total": None,
                          "balance_key": "codearts.status", "expire_at": ""}
        _update_balance(target, out["credits"]["balance"])
    # 余额刚写库，账号列表必须重新读取（否则返回的是刷新前的旧 last_balance）
    out["accounts"] = list_accounts()
    out["history_recent"] = list_history(limit=30, uid=target)["items"]
    out["history_all"] = list_history(limit=hist_limit)["items"]
    out["credits_summary"] = credits_summary()
    live = out.get("status") or {}
    live_checked = live.get("today_checked_in") is True
    out["checkin_all_done"] = _checkin_all_done(
        out["accounts"], out["today"], (target,) if live_checked else ())
    return out


def test_connection(uid=None) -> dict:
    """只查询签到状态、不领取积分。"""
    credential = resolve_credentials(uid)
    target = str(uid or "").strip() or current_uid()
    status = fetch_status(credential, uid=target)
    return {"ok": True, "credential": {"uid": target}, "status": status}


# --------------------------------------------------------------------------- 批量操作

def _checkin_one(uid, nickname="") -> dict:
    credential = resolve_credentials(uid)
    result = do_checkin(credential, uid=uid, source="auto")
    return {"uid": uid, "nickname": nickname, **result}


def _refresh_one(uid, nickname="") -> dict:
    result = refresh_packages(uid)
    return {"uid": uid, "nickname": nickname, "ok": True, "status": "success",
            "balance": result["balance"], "packages": result["count"]}


def _run_all(worker) -> dict:
    """并发跑一遍所有启用账号；单账号失败不影响其它账号。"""
    accounts = [a for a in list_accounts() if a["enabled"]]
    if not accounts:
        return {"ok": True, "items": [],
                "summary": {"total": 0, "success": 0, "already": 0,
                            "failed": 0, "credit": 0}}
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
    """全部启用账号逐个签到（幂等，已签到自动跳过）。

    定时任务每 6 小时调用一次；本地记录显示今天全部签过时直接跳过，
    不再逐个账号请求华为云接口。第二天记录不再命中，任务会自动恢复执行。
    """
    accounts = [a for a in list_accounts() if a.get("enabled")]
    if accounts and _checkin_all_done(accounts, time.strftime("%Y-%m-%d")):
        return {
            "ok": True, "skipped": True,
            "items": [{"uid": a.get("uid") or "", "nickname": a.get("display_name") or "",
                       "ok": True, "status": "already", "credit": 0,
                       "message": "今日已签到，定时任务跳过"} for a in accounts],
            "summary": {"total": len(accounts), "success": 0,
                        "already": len(accounts), "failed": 0, "credit": 0},
        }
    return _run_all(_checkin_one)


def refresh_all() -> dict:
    """全部启用账号刷新积分余额并缓存。"""
    return _run_all(_refresh_one)


def logout(uid=None) -> dict:
    """移除账号（旧接口语义：清除指定 / 当前账号的登录凭据）。"""
    target = str(uid or "").strip() or current_uid()
    if target:
        delete_account(target)
    return public_config()


# --------------------------------------------------------------------------- 模型与档位

_MODELS_CACHE = {}                  # uid -> (ts, models)，30 分钟节流
_MODELS_CACHE_TTL = 1800.0

_MODEL_FIELD_CANDIDATES = {
    "vendor": ("vendor", "provider", "owner", "company", "supplier"),
    "scene": ("scene", "scenes", "usage", "scenario"),
    "max_input": ("context_length", "context_window", "max_context", "context",
                  "max_input_tokens", "max_input"),
    "max_output": ("max_tokens", "max_output_tokens", "max_output",
                   "max_completion_tokens"),
}


def _model_field(model: dict, key: str):
    """按候选键名 tolerant 提取模型可选字段（接口字段名未成文，取到即用）。"""
    for name in _MODEL_FIELD_CANDIDATES[key]:
        value = model.get(name)
        if value is None or isinstance(value, (dict, list)):
            continue
        return value
    return None


def _normalize_model_id(raw: str) -> str:
    """去掉版本后缀（实测 catalog 里带 -0001 这类四位数字尾巴）。"""
    text = str(raw or "")
    if len(text) > 5 and text[-5] == "-" and text[-4:].isdigit():
        return text[:-5]
    return text


def _parse_model(model: dict, seen: set) -> dict | None:
    """模型条目裁剪：id / 名称 / 积分倍率（credit[].ratio_display 形如 "0.18x"）。

    与参考实现对齐：跳过视觉语言（-VL-）模型与重复 id；倍率缺失保持为 None，
    不臆造。
    """
    raw_id = model.get("model_id")
    if not isinstance(raw_id, str) or not raw_id:
        return None
    mid = _normalize_model_id(raw_id)
    if "-VL-" in mid or mid.endswith("-VL"):
        return None
    if mid in seen:
        return None
    seen.add(mid)
    raw_name = model.get("model_name")
    name = _normalize_model_id(raw_name) if isinstance(raw_name, str) and raw_name else mid

    ratio = None
    credit = model.get("credit")
    if isinstance(credit, list):
        for entry in credit:
            raw = (entry.get("ratio_display") if isinstance(entry, dict) else "") or ""
            match = re.match(r"^\s*(\d+(?:\.\d+)?)\s*x\s*$", str(raw), re.I)
            if match:
                try:
                    ratio = float(match.group(1))
                except ValueError:
                    ratio = None
                break

    vendor = _model_field(model, "vendor")
    max_input = _model_field(model, "max_input")
    max_output = _model_field(model, "max_output")
    try:
        max_input = float(max_input) if max_input is not None else None
    except (TypeError, ValueError):
        max_input = None
    try:
        max_output = float(max_output) if max_output is not None else None
    except (TypeError, ValueError):
        max_output = None
    return {
        "id": mid,
        "name": name if name != mid else "",
        "ratio": ratio,
        "vendor": str(vendor or ""),
        "max_input": max_input or 0,
        "max_output": max_output or 0,
        "source": "",
    }


def _models_from_json(obj, path: tuple) -> list:
    """沿指定键路径取模型数组（gateway: result.models / builtin: builtinModels）。"""
    value = obj
    for key in path:
        if not isinstance(value, dict):
            return []
        value = value.get(key)
    return [m for m in value if isinstance(m, dict)] if isinstance(value, list) else []


def fetch_models(credential: dict) -> list:
    """拉取账号可用模型清单：opengw gateway config（主）+ snap builtin（补充）。

    两个源都是 SDK-HMAC-SHA256 签名 GET；单源失败不阻断（各自静默降级）。
    """
    seen, models, sources = set(), [], []
    for url, path, source in (
            (OPENGW_GATEWAY_CONFIG_URL, ("result", "models"), "gateway"),
            (SNAP_MODEL_BUILTIN_URL, ("builtinModels",), "builtin")):
        result = _sign_snap_request("GET", url, credential)
        if not result["ok"]:
            _log.warning("CodeArts 模型清单 %s 源请求失败：%s", source, result["message"])
            continue
        count_before = len(models)
        for m in _models_from_json(result.get("json") or {}, path):
            parsed = _parse_model(m, seen)
            if parsed:
                parsed["source"] = source
                models.append(parsed)
        if len(models) > count_before:
            sources.append(source)
    return models


def models_info(uid=None, force=False) -> dict:
    """当前账号的可用模型清单（30 分钟内存节流，force=True 强制重拉）。"""
    target = str(uid or "").strip() or current_uid()
    if not target:
        raise CodeArtsError("尚未添加账号")
    cached = _MODELS_CACHE.get(target)
    now = time.time()
    if not force and cached and now - cached[0] < _MODELS_CACHE_TTL:
        models = cached[1]
        cached_flag = True
    else:
        credential = resolve_credentials(target)
        models = fetch_models(credential)
        _MODELS_CACHE[target] = (now, models)
        cached_flag = False
    counts = {
        "total": len(models),
        "free": sum(1 for m in models if m["ratio"] == 0),
        "rated": sum(1 for m in models if m["ratio"] not in (None, 0)),
        "unknown": sum(1 for m in models if m["ratio"] is None),
    }
    return {"ok": True, "uid": target, "models": models, "counts": counts,
            "cached": cached_flag, "updated_at": now}

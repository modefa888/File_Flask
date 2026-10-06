"""敏感字段加密：Git Token / AI API Key / SMTP 授权码 / Telegram Bot Token。

落库前加密、服务端读回时解密；返回前端时统一脱敏为「前 4 位 + ******」。

密钥来源（优先级从高到低）：
  1. .env 的 SECRET_SALT —— 用 PBKDF2-HMAC-SHA256 派生 32 字节密钥（推荐）；
  2. data/.file_manager_secret_key —— 本地随机密钥文件（首次自动生成，权限 600）。
     · 未配置 SECRET_SALT 时，它就是主密钥；
     · 已配置 SECRET_SALT 时，它退居「旧密钥」，用于解密切换密钥前写入的历史密文 ——
       这些数据会在下次写回时自动用新密钥重新加密，因此换盐不会导致凭据丢失。

算法：SHA256-CTR 流加密 + HMAC-SHA256 完整性校验（Encrypt-then-MAC），
格式：enc:v1:<nonce_hex>:<tag_hex>:<cipher_hex>；不依赖第三方加密库。
"""
import hashlib
import hmac
import os
import secrets as _secrets
import threading

from ... import config
from ...log import get_logger

_log = get_logger()

_KEY_FILE = os.path.join(config.DATA_ROOT, ".file_manager_secret_key")
_PREFIX = "enc:v1:"
_TAG_BYTES = 16
_PBKDF2_ROUNDS = 200_000
_PBKDF2_INFO = b"file_flask.cred.v1"

_lock = threading.Lock()
_state = {"loaded": False, "primary": None, "legacy": None}


def _read_key_file():
    """读取本地密钥文件（不存在 / 非法返回 None，不会创建）。"""
    try:
        with open(_KEY_FILE, "r", encoding="utf-8") as f:
            raw = f.read().strip()
        key = bytes.fromhex(raw)
        return key if len(key) >= 32 else None
    except (OSError, ValueError):
        return None


def _write_key_file(key: bytes) -> None:
    try:
        with open(_KEY_FILE, "w", encoding="utf-8") as f:
            f.write(key.hex())
        os.chmod(_KEY_FILE, 0o600)
    except OSError as e:
        _log.warning("加密密钥写入失败（本次仅进程内生效）：%s", e)


def _derive_key(salt: str) -> bytes:
    return hashlib.pbkdf2_hmac("sha256", salt.encode("utf-8"),
                               _PBKDF2_INFO, _PBKDF2_ROUNDS, dklen=32)


def _keys():
    """返回 (主密钥, 旧密钥或 None)。"""
    if _state["loaded"]:
        return _state["primary"], _state["legacy"]
    with _lock:
        if _state["loaded"]:
            return _state["primary"], _state["legacy"]
        salt = (getattr(config, "SECRET_SALT", "") or "").strip()
        file_key = _read_key_file()
        if salt:
            primary = _derive_key(salt)
            legacy = file_key if (file_key and file_key != primary) else None
        else:
            if file_key is None:
                file_key = _secrets.token_bytes(32)
                _write_key_file(file_key)
            primary, legacy = file_key, None
        _state.update(loaded=True, primary=primary, legacy=legacy)
        return primary, legacy


def _keystream(key: bytes, nonce: bytes, length: int) -> bytes:
    """SHA256 计数器模式生成密钥流。"""
    out = bytearray()
    counter = 0
    while len(out) < length:
        out += hashlib.sha256(key + nonce + counter.to_bytes(8, "big")).digest()
        counter += 1
    return bytes(out[:length])


def _encrypt_with(key: bytes, text: str) -> str:
    nonce = _secrets.token_bytes(16)
    data = text.encode("utf-8")
    stream = _keystream(key, nonce, len(data))
    cipher = bytes(a ^ b for a, b in zip(data, stream))
    tag = hmac.new(key, nonce + cipher, hashlib.sha256).digest()[:_TAG_BYTES]
    return _PREFIX + nonce.hex() + ":" + tag.hex() + ":" + cipher.hex()


def _decrypt_with(key: bytes, value: str):
    """用指定密钥解密；校验失败返回 None。"""
    try:
        nonce_hex, tag_hex, cipher_hex = value[len(_PREFIX):].split(":")
        nonce = bytes.fromhex(nonce_hex)
        tag = bytes.fromhex(tag_hex)
        cipher = bytes.fromhex(cipher_hex)
    except ValueError:
        return None
    expect = hmac.new(key, nonce + cipher, hashlib.sha256).digest()[:_TAG_BYTES]
    if not hmac.compare_digest(expect, tag):
        return None
    stream = _keystream(key, nonce, len(cipher))
    return bytes(a ^ b for a, b in zip(cipher, stream)).decode("utf-8", "replace")


def is_encrypted(value) -> bool:
    return isinstance(value, str) and value.startswith(_PREFIX)


def encrypt(plain) -> str:
    """明文 → 密文；空值 / 已加密内容原样返回。"""
    if not plain:
        return plain or ""
    text = str(plain)
    if is_encrypted(text):
        return text
    primary, _legacy = _keys()
    return _encrypt_with(primary, text)


def decrypt_ex(value):
    """返回 (明文, 是否需要重新加密)。

    历史明文 → 需要加密；用旧密钥解出的密文 → 需要用新密钥重写；其余不需要。
    """
    if not value:
        return "", False
    text = str(value)
    if not is_encrypted(text):
        return text, True
    primary, legacy = _keys()
    plain = _decrypt_with(primary, text)
    if plain is not None:
        return plain, False
    if legacy is not None:
        plain = _decrypt_with(legacy, text)
        if plain is not None:
            return plain, True
    # 密钥被更换且旧密钥也不匹配：宁可用不了，也不要拿错误的值去发请求
    _log.warning("密文解密失败（密钥不匹配或数据被篡改），请重新填写该凭据")
    return "", False


def decrypt(value) -> str:
    """密文 → 明文；非密文原样返回，失败返回空串。"""
    return decrypt_ex(value)[0]


def mask(value, head: int = 4) -> str:
    """脱敏后返回前端：只保留最前面一小段，其余统一用 ****** 覆盖。"""
    if not value:
        return ""
    text = str(value)
    if len(text) <= head:
        return "******"
    return text[:head] + "******"

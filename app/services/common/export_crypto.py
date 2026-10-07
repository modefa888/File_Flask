"""导出文件的口令加密：把请求里的关键字段（Authorization / token / 密码 …）加密后再落盘。

为什么不复用 secret.py 那套本机密钥：
  enc:v1: 用的是本机密钥（.env 的 SECRET_SALT 或 data/.file_manager_secret_key），
  而导出的 JSON 是要离开这台机器的（备份、换机导入）—— 换台机器就没有那把密钥，
  解密必然失败。所以这里改用「用户口令 + 每次随机盐」派生密钥，口令本身就是钥匙，
  盐随密文一起走，做到换机可还原。

为什么不用 AES / 第三方库：
  与 secret.py 保持同一套做法，标准库就够：SHA256-CTR 流加密 + HMAC-SHA256
  完整性校验（Encrypt-then-MAC）。少一个依赖，且密文改一个字节都过不了校验。

密文格式：encp:v1:<salt_b64>:<nonce_hex>:<tag_hex>:<cipher_b64>
  encp = encrypt with password。与落库密文 enc:v1:、传输密文 tp1: 前缀互不冲突，
  后端/前端只要看前缀就知道该走哪条解密路径。

安全边界（写清楚，别高估它）：
  · SHA256-CTR 是自拼构造，不是标准 AEAD；但「随机 nonce + Encrypt-then-MAC」下
    足以满足本场景（离线备份文件防窥视、防篡改）。
  · 口令强度决定一切：弱口令挡不住离线爆破（200k 次 PBKDF2 只是抬高成本）。
"""
import base64
import hashlib
import hmac
import secrets as _secrets

_PREFIX = "encp:v1:"
_ROUNDS = 200_000
_INFO = b"file_flask.export.v1"     # 域分隔：避免与其它 PBKDF2 用途派生出同一把密钥
_TAG_BYTES = 16

# 写进导出文件的元信息，供人（和以后换参数时的自己）看出这是哪套派生参数
KDF_LABEL = "pbkdf2-hmac-sha256/" + str(_ROUNDS)


def _b64e(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _b64d(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _derive(password: str, salt: bytes) -> bytes:
    """口令 + 盐 → 32 字节密钥。"""
    return hashlib.pbkdf2_hmac("sha256", str(password).encode("utf-8"),
                               salt + _INFO, _ROUNDS, dklen=32)


def _keystream(key: bytes, nonce: bytes, length: int) -> bytes:
    """SHA256 计数器模式生成密钥流（与 secret.py 同一构造）。"""
    out = bytearray()
    counter = 0
    while len(out) < length:
        out += hashlib.sha256(key + nonce + counter.to_bytes(8, "big")).digest()
        counter += 1
    return bytes(out[:length])


def is_sealed(value) -> bool:
    """是否为本模块产出的密文。"""
    return isinstance(value, str) and value.startswith(_PREFIX)


def seal(password: str, text) -> str:
    """明文 → 密文；空值原样返回，已加密的原样返回（幂等，重复导出不会套娃）。"""
    if not text:
        return text or ""
    plain = str(text)
    if is_sealed(plain):
        return plain
    salt = _secrets.token_bytes(16)
    key = _derive(password, salt)
    nonce = _secrets.token_bytes(16)
    data = plain.encode("utf-8")
    cipher = bytes(a ^ b for a, b in zip(data, _keystream(key, nonce, len(data))))
    tag = hmac.new(key, nonce + cipher, hashlib.sha256).digest()[:_TAG_BYTES]
    return _PREFIX + _b64e(salt) + ":" + nonce.hex() + ":" + tag.hex() + ":" + _b64e(cipher)


def unseal(password: str, value):
    """密文 → 明文。

    返回 None 表示解不开（口令不对，或密文被改过）——调用方据此报「口令不正确」，
    不要把 None 当成空字符串用掉，否则会静默丢数据。
    非密文（明文）原样返回，这样导入旧格式文件时可以直接调用，不必先判断。
    """
    if not is_sealed(value):
        return value
    try:
        body = value[len(_PREFIX):]
        salt_b64, nonce_hex, tag_hex, cipher_b64 = body.split(":")
        salt = _b64d(salt_b64)
        nonce = bytes.fromhex(nonce_hex)
        tag = bytes.fromhex(tag_hex)
        cipher = _b64d(cipher_b64)
    except (ValueError, TypeError):
        return None
    key = _derive(password, salt)
    expect = hmac.new(key, nonce + cipher, hashlib.sha256).digest()[:_TAG_BYTES]
    if not hmac.compare_digest(expect, tag):
        return None
    stream = _keystream(key, nonce, len(cipher))
    return bytes(a ^ b for a, b in zip(cipher, stream)).decode("utf-8", "replace")

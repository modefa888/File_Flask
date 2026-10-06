"""前端敏感字段的传输加密（RSA-OAEP + SHA-256）。

IDE 页面通常通过 http://<局域网IP>:端口 访问，属于「非安全上下文」，
浏览器原生 WebCrypto（crypto.subtle）在这种页面下不可用，因此前端用一份纯 JS
实现（templates/ide/js/24_敏感字段传输加密.js，BigInt + OAEP）完成加密，
后端在这里用私钥解密。

流程：
  1. 渲染 IDE 页面时把公钥注入 window.__tpPub（只要 n / e 两个十六进制大数，
     前端无需解析 PEM / DER）；
  2. 前端提交 Git Token / AI API Key / SMTP 授权码 / Telegram Bot Token 前，
     用公钥加密并加上 "tp1:" 前缀（与落库密文的 "enc:v1:" 前缀区分开）；
  3. 后端 unwrap() 解出明文，再交给 secret.encrypt() 按存储密钥加密落库。

密钥对持久化在 data/.file_manager_transport_key.pem（权限 600）：
这样多进程（例如 gunicorn 多 worker）共用同一对密钥，且服务重启后，
前端页面里持有的旧公钥仍然有效 —— 否则「页面已打开、服务重启」会导致解密失败。

cryptography 未安装时自动降级：available() 为 False，公钥下发 enabled=False，
前端检测到后按原先的明文方式提交，功能不受影响（只是少了传输层加密）。
"""
import base64
import os
import threading

from ... import config
from ...log import get_logger

_log = get_logger()

# 传输密文前缀（与落库密文 enc:v1: 区分，便于后端判断该走哪条解密路径）
PREFIX = "tp1:"
_KEY_FILE = os.path.join(config.DATA_ROOT, ".file_manager_transport_key.pem")

try:
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import padding, rsa
    _CRYPTO_OK = True
except Exception:                        # 未安装 cryptography → 降级为明文传输
    _CRYPTO_OK = False

_lock = threading.Lock()
_private_key = None
_loaded = False


def available() -> bool:
    """是否具备传输加密能力（未安装 cryptography 时为 False）。"""
    return _CRYPTO_OK


def _load_key():
    """加载（或首次生成）传输密钥对，返回私钥对象。"""
    global _private_key, _loaded
    if _loaded:
        return _private_key
    with _lock:
        if _loaded:
            return _private_key
        key = None
        try:
            with open(_KEY_FILE, "rb") as f:
                key = serialization.load_pem_private_key(f.read(), password=None)
        except Exception:
            key = None
        if key is None:
            key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
            try:
                with open(_KEY_FILE, "wb") as f:
                    f.write(key.private_bytes(
                        encoding=serialization.Encoding.PEM,
                        format=serialization.PrivateFormat.PKCS8,
                        encryption_algorithm=serialization.NoEncryption()))
                os.chmod(_KEY_FILE, 0o600)
            except OSError as e:
                _log.warning("传输密钥写入失败（本次仅进程内生效）：%s", e)
        _private_key = key
        _loaded = True
        return _private_key


def public_key_payload():
    """注入前端 / 下发的公钥（十六进制大数）。"""
    if not _CRYPTO_OK:
        return {"enabled": False}
    try:
        nums = _load_key().public_key().public_numbers()
        return {"enabled": True, "n": format(nums.n, "x"), "e": format(nums.e, "x")}
    except Exception as e:
        _log.warning("生成传输公钥失败：%s", e)
        return {"enabled": False}


def unwrap(value):
    """把前端提交的敏感值还原成明文。

    - "tp1:<base64>" → RSA-OAEP 解密；
    - 其它（未启用传输加密 / 前端未加密）→ 原样返回；
    - 解密失败 → 返回空串：既不会把垃圾写进库，也会自然触发
      各接口「留空 = 沿用旧值」的逻辑。
    """
    if not isinstance(value, str) or not value.startswith(PREFIX):
        return value or ""
    if not _CRYPTO_OK:
        return ""
    try:
        cipher = base64.b64decode(value[len(PREFIX):])
        plain = _load_key().decrypt(cipher, padding.OAEP(
            mgf=padding.MGF1(algorithm=hashes.SHA256()),
            algorithm=hashes.SHA256(), label=None))
        text = plain.decode("utf-8")
        if "\x00" in text:               # 明文里出现 NUL 说明填充异常，拒收
            raise ValueError("解密结果异常")
        return text
    except Exception:
        _log.warning("传输密文解密失败（页面公钥可能已过期，刷新页面后重试）")
        return ""

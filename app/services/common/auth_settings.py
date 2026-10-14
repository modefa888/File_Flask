"""注册开关：控制是否允许前端自助注册新账号。

- 默认值来自 app/config.py 的 ALLOW_REGISTER（可由 .env 的 ALLOW_REGISTER 覆盖，默认开启）；
- 管理员可在后台「系统设置」里临时关闭 / 重新开启，开关状态记进 store.db 的 store_meta
  （键 auth.allow_register）。store_meta 里的值优先于 env 默认值，便于不重启服务即可切换。
"""
from ... import config
from ...services.common.store_db import get_meta, set_meta

_META_KEY = "auth.allow_register"


def registration_open() -> bool:
    """当前是否允许前端自助注册（store_meta 优先于 env 默认值）。"""
    try:
        v = get_meta(_META_KEY)
    except Exception:
        v = None
    if v is not None:
        return v not in ("0", "false", "no", "off", "")
    return bool(config.ALLOW_REGISTER)


def set_registration_open(on: bool) -> None:
    """持久化保存「是否允许前端注册」开关。"""
    set_meta(_META_KEY, "1" if on else "0")

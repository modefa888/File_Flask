"""后台管理路由包。

导出统一的蓝图对象 `bp`，供 `app/__init__.py::_register_blueprints` 注册。
"""
from .admin import bp

__all__ = ["bp"]

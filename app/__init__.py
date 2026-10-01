"""应用工厂：create_app() —— Flask 应用入口。

负责装配配置、注册蓝图、安装请求日志中间件，并初始化持久化索引。
"""
import threading
import time as _time

from flask import Flask, g

from . import config
from .log import get_logger


_log = get_logger()


def create_app(test_config=None) -> Flask:
    app = Flask(
        __name__,
        template_folder=config.TEMPLATE_FOLDER,
        static_folder=config.STATIC_FOLDER,
    )
    app.config.update(
        SECRET_KEY=config.SECRET_KEY,
        DEBUG=config.DEBUG,
        JSON_AS_ASCII=False,
        MAX_CONTENT_LENGTH=32 * 1024 * 1024,   # 32MB 请求体上限
    )
    if test_config:
        app.config.update(test_config)

    _register_blueprints(app)
    _install_request_logging(app)
    _init_chat_engine()
    _init_index_engine()

    return app


def _register_blueprints(app: Flask) -> None:
    from .routes.common.auth import bp as auth_bp
    from .routes.common.pages import bp as pages_bp
    from .routes.common.browser import bp as browser_bp
    from .routes.common.zip import bp as zip_bp
    from .routes.common.delete import bp as delete_bp
    from .routes.common.archive_history import bp as archive_history_bp
    from .routes.common.fileops import bp as fileops_bp
    from .routes.common.index import bp as index_bp
    from .routes.common.progress_stream import bp as progress_stream_bp
    from .routes.ide.grep import bp as grep_bp
    from .routes.ide.git import bp as git_bp
    from .routes.ide.run import bp as run_bp
    from .routes.ide.port import bp as port_bp
    from .routes.ide.term import bp as term_bp
    from .routes.ide.env import bp as env_bp
    from .routes.common.shares import bp as shares_bp
    from .routes.ide.ai import bp as ai_bp
    from .routes.ide.agent import bp as agent_bp
    from .routes.ide.chat_history import bp as chat_history_bp
    from .routes.ide.pip import bp as pip_bp
    for bp in (auth_bp, pages_bp, browser_bp, zip_bp, delete_bp, archive_history_bp,
               fileops_bp, index_bp, progress_stream_bp, grep_bp, git_bp, run_bp, port_bp,
               term_bp, env_bp, shares_bp, ai_bp, agent_bp, chat_history_bp, pip_bp):
        app.register_blueprint(bp)


def _install_request_logging(app: Flask) -> None:
    """为每个 HTTP 请求/响应记录 JSON 结构化日志。"""
    from flask import request

    @app.before_request
    def _before_request():
        g._start = _time.monotonic()
        g.request_method = request.method
        g.request_path = request.path

    @app.after_request
    def _after_request(response):
        latency = None
        start = getattr(g, "_start", None)
        if start is not None:
            latency = round((_time.monotonic() - start) * 1000, 2)
        # 某些 before_request（如登录重定向）可能未设置 g 属性，回退到 request 取值
        method = getattr(g, "request_method", None) or request.method
        path = getattr(g, "request_path", None) or request.path
        _log.info(
            "HTTP %s %s %s",
            response.status_code, method, path,
            extra={
                "method": method, "path": path,
                "status": response.status_code, "latency_ms": latency,
            },
        )
        return response


def _init_chat_engine() -> None:
    """初始化 AI 对话历史持久化库。"""
    from .services.ide.chatdb import init_chat_db
    try:
        init_chat_db()
    except Exception as e:                      # 初始化失败不应阻断服务启动
        _log.warning("对话历史库初始化失败，继续启动: %s", e)


def _init_index_engine() -> None:
    """初始化持久化索引：建表、加载元信息、启动后台扫描调度器。"""
    from .services.common.db import _init_index_db
    from .services.common.indexer import (
        _load_index_meta, _schedule_index_scan, _build_index, _INDEX_META,
    )

    try:
        _init_index_db()
        index_loaded = _load_index_meta()
        _schedule_index_scan(30)
        if not index_loaded:
            _log.info("未找到已有索引，启动首次索引扫描...")
            def _delayed_first_scan():
                _time.sleep(2)
                _build_index("")
            threading.Thread(target=_delayed_first_scan, daemon=True).start()
    except Exception as e:                      # 索引初始化失败不应阻断服务启动
        _log.warning("索引初始化失败，继续启动: %s", e)
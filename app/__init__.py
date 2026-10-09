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
    _install_error_handlers(app)
    _init_chat_engine()
    _init_index_engine()
    _init_cron_engine(app)

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
    from .routes.ide.proc import bp as proc_bp
    from .routes.common.shares import bp as shares_bp
    from .routes.ide.ai import bp as ai_bp
    from .routes.ide.agent import bp as agent_bp
    from .routes.ide.chat_history import bp as chat_history_bp
    from .routes.ide.pip import bp as pip_bp
    from .routes.ide.npm import bp as npm_bp
    from .routes.ide.plugins import bp as plugins_bp
    from .routes.common.dbconn import bp as dbconn_bp
    from .routes.ide.httpreq import bp as httpreq_bp
    from .routes.ide.cron import bp as cron_bp
    from .routes.ide.sshconn import bp as sshconn_bp
    from .routes.ide.hints import bp as hints_bp
    for bp in (auth_bp, pages_bp, browser_bp, zip_bp, delete_bp, archive_history_bp,
               fileops_bp, index_bp, progress_stream_bp, grep_bp, git_bp, run_bp, port_bp,
               term_bp, env_bp, proc_bp, shares_bp, ai_bp, agent_bp, chat_history_bp, pip_bp, npm_bp,
               plugins_bp, dbconn_bp, httpreq_bp, cron_bp, sshconn_bp, hints_bp):
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


def _install_error_handlers(app: Flask) -> None:
    """统一错误页：/api 请求仍返回 JSON，页面请求渲染科技感错误页。"""
    from flask import request, render_template, jsonify

    _META = {
        400: ("请求有误", "服务器无法理解这次请求，请检查参数后重试。"),
        403: ("禁止访问", "你没有权限访问该资源。"),
        404: ("页面走丢了", "你访问的地址不存在，或者链接已经失效。"),
        405: ("方法不被允许", "该地址不支持这种请求方式。"),
        429: ("请求过于频繁", "访问太频繁了，请稍后再试。"),
        500: ("服务器开小差了", "服务内部出现异常，请稍后重试。"),
    }

    def _handle_error(e):
        code = getattr(e, "code", 500) or 500
        if code >= 500:
            _log.error("请求异常 %s %s: %s", code, request.path,
                       getattr(e, "original_exception", None) or e)
        # 接口请求保持 JSON，避免前端的 res.json() 解析失败
        if request.path.startswith("/api/"):
            title = _META.get(code, ("出错了", ""))[0]
            return jsonify({"error": title, "code": code}), code
        title, message = _META.get(code, ("出错了", "请求未能完成。"))
        path = request.path
        if request.query_string:
            path += "?" + request.query_string.decode("utf-8", "ignore")
        return render_template("error.html", code=code, title=title,
                               message=message, path=path), code

    for _code in (400, 403, 404, 405, 429, 500):
        app.register_error_handler(_code, _handle_error)


def _init_chat_engine() -> None:
    """初始化 AI 对话历史持久化库。"""
    from .services.ide.chatdb import init_chat_db
    try:
        init_chat_db()
    except Exception as e:                      # 初始化失败不应阻断服务启动
        _log.warning("对话历史库初始化失败，继续启动: %s", e)


def _init_cron_engine(app=None) -> None:
    """启动定时任务调度器（幂等）。

    debug + reloader 模式下父进程也会 create_app，父进程不启动，避免同一任务被触发两次。
    """
    import os as _os
    if app is not None and getattr(app, "debug", False) and _os.environ.get("WERKZEUG_RUN_MAIN") != "true":
        _log.info("调试重载父进程：跳过定时任务调度器")
        return
    try:
        from .services.ide import cronsvc
        cronsvc.ensure_scheduler()
    except Exception as e:                      # 调度器失败不应阻断服务启动
        _log.warning("定时任务调度器启动失败，继续启动: %s", e)


def _init_index_engine() -> None:
    """初始化持久化索引：建表、加载元信息、启动后台扫描调度器。"""
    from .services.common.db import _init_index_db
    from .services.common.indexer import (
        _load_index_meta, _schedule_index_scan, _build_index, _INDEX_META,
    )

    try:
        _init_index_db()
        index_loaded = _load_index_meta()
        # 后台调度器只响应手动 / API 触发的信号，不自动定时扫描；
        # 首次启动也不再自动全盘索引，完全交由用户在界面手动「重建索引」。
        _schedule_index_scan()
        if not index_loaded:
            _log.info("未找到已有索引，等待用户在界面手动启动索引（不自动扫描）")
    except Exception as e:                      # 索引初始化失败不应阻断服务启动
        _log.warning("索引初始化失败，继续启动: %s", e)
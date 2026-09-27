"""统一日志模块：控制台 + 每日轮转 JSON 文件日志。

所有业务模块通过 get_logger() 获取同一个名为 "fm" 的记录器，
HTTP 请求/响应的 JSON 结构化日志由 app/__init__.py 的请求中间件写入。
"""
import json
import logging
import os
import sys
from datetime import datetime
from logging.handlers import TimedRotatingFileHandler

# 日志目录：源码运行时放项目根目录/logs；打包后放可执行文件旁/logs（避免写入临时目录）
if bool(getattr(sys, "frozen", False)):
    _LOG_DIR = os.path.join(os.path.dirname(os.path.abspath(sys.executable)), "logs")
else:
    _LOG_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "logs")
os.makedirs(_LOG_DIR, exist_ok=True)


class JsonFormatter(logging.Formatter):
    """将日志记录格式化为 JSON 行，便于 ELK / Logstash 等采集。"""

    def format(self, record):
        try:
            payload = {
                "ts": datetime.fromtimestamp(record.created).strftime("%Y-%m-%d %H:%M:%S.%f")[:-3],
                "level": record.levelname,
                "logger": record.name,
                "msg": record.getMessage(),
            }
            if record.exc_info:
                payload["exc"] = self.formatException(record.exc_info)
            # 附带请求上下文（由中间件注入的 extra）
            for key in ("method", "path", "status", "latency_ms"):
                val = getattr(record, key, None)
                if val is not None:
                    payload[key] = val
            return json.dumps(payload, ensure_ascii=False)
        except Exception:
            return super().format(record)


def _build_logger(name: str = "fm") -> logging.Logger:
    logger = logging.getLogger(name)
    if logger.handlers:                     # 幂等：避免重复挂载句柄
        return logger
    logger.setLevel(logging.INFO)
    logger.propagate = False

    console = logging.StreamHandler()
    console.setFormatter(logging.Formatter("[%(asctime)s] %(levelname)s %(message)s"))
    logger.addHandler(console)

    file_handler = TimedRotatingFileHandler(
        os.path.join(_LOG_DIR, "app.log"), when="midnight", backupCount=15, encoding="utf-8",
    )
    file_handler.suffix = "%Y%m%d"
    file_handler.setFormatter(JsonFormatter())
    logger.addHandler(file_handler)
    return logger


# 应用默认记录器（供服务/路由直接使用）
_log = _build_logger()


def get_logger(name: str = "fm") -> logging.Logger:
    if name == "fm":
        return _log
    return _build_logger(name)
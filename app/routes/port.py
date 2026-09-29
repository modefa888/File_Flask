"""端口占用查询：列出被占用的端口及其进程 / 项目目录，并支持强制释放。

GET  /api/port/list       监听中的端口 + 占用进程（pid / 名称 / 命令 / 工作目录）
POST /api/port/kill {pid} 强制结束占用进程（整个进程组）

说明：只查询与按 pid 结束进程，不接受任何用户提供的命令文本。
"""
from flask import Blueprint, request, jsonify

from ..log import get_logger
from ..services import portinfo


_log = get_logger()
bp = Blueprint("port", __name__)


@bp.route("/api/port/list")
def api_port_list():
    items = portinfo.list_ports()
    return jsonify({
        "ok": True, "ports": items, "count": len(items),
        "mine": sum(1 for x in items if x["mine"]),
    })


@bp.route("/api/port/kill", methods=["POST"])
def api_port_kill():
    data = request.get_json(silent=True) or {}
    try:
        pid = int(data.get("pid") or 0)
    except (TypeError, ValueError):
        pid = 0
    if pid <= 0:
        return jsonify({"error": "缺少有效的 pid"}), 400
    _log.info("POST /api/port/kill pid=%s port=%s", pid, data.get("port"))
    res = portinfo.kill_pid(pid)
    if res.get("error"):
        return jsonify(res), 400
    return jsonify(res)

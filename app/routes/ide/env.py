"""运行环境管理接口。

GET  /api/env/runtimes?refresh=1     探测本机已安装的运行时 / 工具（版本、路径、候选）
GET  /api/env/detail?id=node         某个运行时的详细信息（多条只读命令输出）
GET  /api/env/system                 系统信息 + 当前 PATH + 相关环境变量
GET  /api/env/config                 读取自定义配置（解释器路径 / 环境变量）
POST /api/env/config                 保存自定义配置
POST /api/env/tool-action            白名单化配置操作（切换镜像源、创建 venv 等）

说明：探测与配置操作都不接受任意命令，具体见 services/envprobe.py。
"""
import os

from flask import Blueprint, request, jsonify

from ... import config
from ...log import get_logger
from ...services.ide import envprobe, envinstall


_log = get_logger()
bp = Blueprint("env", __name__)


def _exec_allowed() -> bool:
    return bool(getattr(config, "ENABLE_EXEC", True))


@bp.route("/api/env/runtimes")
def api_env_runtimes():
    force = request.args.get("refresh") in ("1", "true", "yes")
    return jsonify(envprobe.probe_all(force=force))


@bp.route("/api/env/detail")
def api_env_detail():
    rid = (request.args.get("id") or "").strip()
    if not rid:
        return jsonify({"error": "缺少 id 参数"}), 400
    return jsonify(envprobe.probe_detail(rid))


@bp.route("/api/env/system")
def api_env_system():
    return jsonify(envprobe.system_info())


@bp.route("/api/env/config", methods=["GET"])
def api_env_config_get():
    cfg = envprobe.load_cfg()
    cfg["file"] = envprobe._CFG_FILE
    return jsonify(cfg)


@bp.route("/api/env/config", methods=["POST"])
def api_env_config_post():
    data = request.get_json(silent=True) or {}
    cfg = envprobe.load_cfg()

    if "overrides" in data:
        raw = data.get("overrides") or {}
        if not isinstance(raw, dict):
            return jsonify({"error": "overrides 必须是对象"}), 400
        clean = dict(cfg["overrides"])
        for rid, path in raw.items():
            rid = str(rid).strip()
            path = str(path or "").strip()
            if not rid:
                continue
            if not path:                      # 空值表示清除该自定义路径
                for key in (rid, *envprobe._CATALOG_BY_ID.get(rid, {}).get("exes", [])):
                    clean.pop(key, None)
                continue
            p = os.path.expanduser(path)
            if not os.path.isfile(p):
                return jsonify({"error": f"文件不存在：{path}"}), 400
            if not os.access(p, os.X_OK):
                return jsonify({"error": f"文件不可执行：{path}"}), 400
            clean[rid] = os.path.abspath(p)
        cfg["overrides"] = clean

    if "env" in data:
        raw = data.get("env") or {}
        if not isinstance(raw, dict):
            return jsonify({"error": "env 必须是对象"}), 400
        clean_env = {}
        for k, v in raw.items():
            k = str(k).strip()
            if not k:
                continue
            if not k.replace("_", "").isalnum() or not (k[0].isalpha() or k[0] == "_"):
                return jsonify({"error": f"环境变量名不合法：{k}"}), 400
            clean_env[k] = str(v)
        cfg["env"] = clean_env

    envprobe.save_cfg(cfg)
    envprobe.invalidate_cache()
    _log.info("POST /api/env/config overrides=%d env=%d", len(cfg["overrides"]), len(cfg["env"]))
    out = dict(cfg)
    out["ok"] = True
    out["file"] = envprobe._CFG_FILE
    return jsonify(out)


@bp.route("/api/env/install")
def api_env_install_plans():
    """某运行时可用的安装方案（用户级方案会解析最新版本与下载地址）。"""
    rid = (request.args.get("id") or "").strip()
    if not rid:
        return jsonify({"error": "缺少 id 参数"}), 400
    return jsonify(envinstall.list_plans(rid))


@bp.route("/api/env/install", methods=["POST"])
def api_env_install_start():
    """启动一键安装（仅内置白名单方案，安装到 ~/.local）。"""
    data = request.get_json(silent=True) or {}
    rid = (data.get("id") or "").strip()
    key = (data.get("key") or "").strip()
    if not rid or not key:
        return jsonify({"error": "缺少 id / key 参数"}), 400
    result = envinstall.start_install(rid, key)
    if result.get("error"):
        return jsonify(result), 400
    return jsonify(result)


@bp.route("/api/env/install/log")
def api_env_install_log():
    """轮询安装日志（增量）。"""
    tid = (request.args.get("tid") or "").strip()
    try:
        offset = int(request.args.get("offset") or 0)
    except ValueError:
        offset = 0
    if not tid:
        return jsonify({"error": "缺少 tid 参数"}), 400
    return jsonify(envinstall.task_log(tid, offset))


@bp.route("/api/env/install/cancel", methods=["POST"])
def api_env_install_cancel():
    """取消进行中的安装任务。"""
    data = request.get_json(silent=True) or {}
    tid = (data.get("tid") or "").strip()
    if not tid:
        return jsonify({"error": "缺少 tid 参数"}), 400
    result = envinstall.cancel_install(tid)
    if result.get("error"):
        return jsonify(result), 404
    return jsonify(result)


@bp.route("/api/env/tool-action", methods=["POST"])
def api_env_tool_action():
    if not _exec_allowed():
        return jsonify({"error": "已禁用命令执行（config.ENABLE_EXEC = False）"}), 403
    data = request.get_json(silent=True) or {}
    rid = (data.get("id") or "").strip()
    key = (data.get("key") or "").strip()
    value = data.get("value") or ""
    cwd = (data.get("cwd") or "").strip()
    if not rid or not key:
        return jsonify({"error": "缺少 id / key 参数"}), 400
    result = envprobe.run_tool_action(rid, key, value=str(value), cwd=cwd)
    envprobe.invalidate_cache()
    if result.get("error"):
        return jsonify(result), 400
    return jsonify(result)

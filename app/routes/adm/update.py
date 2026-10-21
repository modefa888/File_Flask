"""在线更新（GitHub）：后台管理模块 + 管理接口（仅管理员）。

页面
----
GET  /admin/update                 旧地址：重定向到后台管理的「在线更新」模块（/admin#update）

接口
----
GET  /api/adm/update               页面初始化：配置（token 脱敏）+ 本地版本 + 上次结果 + 当前任务
GET  /api/adm/update/check         检查远端是否有更新（?method=api|git 可临时覆盖配置）
POST /api/adm/update/config        保存配置（仓库 / 分支 / 令牌 / 检查方式 / 重启方式…）
POST /api/adm/update/apply         执行更新 {reset: bool} → {run_id}
GET  /api/adm/update/status        查询任务进度 ?run_id=（不传则取当前任务）
POST /api/adm/update/restart       只重启（不拉代码）→ {run_id}

实现见 `services/adm/updater.py`。所有接口默认属于 admin 级别，
由 `routes/common/auth.py` 的全局鉴权统一拦截非管理员。
"""
from flask import Blueprint, jsonify, redirect, request

from ...log import get_logger
from ...services.adm import updater

_log = get_logger()
bp = Blueprint("update", __name__)


def _fail(msg, code=400):
    return jsonify({"error": msg}), code


# --------------------------------------------------------------------------- 页面
@bp.route("/admin/update")
def update_page():
    """旧地址兼容：在线更新已经并入后台管理 SPA，定位到对应模块。"""
    from ..common.auth import is_admin
    if not is_admin():
        _log.info("GET /admin/update 被拒绝（非管理员）")
        return redirect("/collab")
    _log.info("GET /admin/update → /admin#update")
    return redirect("/admin#update")


# --------------------------------------------------------------------------- 接口
@bp.route("/api/adm/update")
def api_state():
    try:
        return jsonify(updater.state())
    except Exception as e:
        _log.error("读取在线更新状态失败: %s", e)
        return _fail("读取更新状态失败：%s" % e, 500)


@bp.route("/api/adm/update/config", methods=["POST"])
def api_save_config():
    data = request.get_json(silent=True) or {}
    err = updater.save_config(data)
    if err:
        return _fail(err)
    return jsonify({"ok": True, "config": updater.public_config()})


@bp.route("/api/adm/update/check", methods=["POST"])
def api_check():
    data = request.get_json(silent=True) or {}
    method = data.get("method") or request.args.get("method")
    try:
        res = updater.check_update(method)
    except Exception as e:
        _log.error("检查更新失败: %s", e)
        return _fail("检查更新失败：%s" % e, 500)
    return jsonify(res)


@bp.route("/api/adm/update/apply", methods=["POST"])
def api_apply():
    data = request.get_json(silent=True) or {}
    run_id, err = updater.start_update(reset=bool(data.get("reset")))
    if err:
        return _fail(err, 409)
    _log.info("POST /api/adm/update/apply run=%s reset=%s", run_id, bool(data.get("reset")))
    return jsonify({"ok": True, "run_id": run_id})


@bp.route("/api/adm/update/probe", methods=["POST"])
def api_probe():
    """连通性诊断：分别测 GitHub API 与 git 拉取地址（支持未保存的配置）。"""
    data = request.get_json(silent=True) or {}
    try:
        return jsonify(updater.probe(data))
    except Exception as e:
        _log.error("连接测试失败: %s", e)
        return _fail("连接测试失败：%s" % e, 500)


@bp.route("/api/adm/update/status")
def api_status():
    run_id = (request.args.get("run_id") or "").strip()
    run = updater.get_run(run_id) if run_id else updater.current_run()
    if not run:
        return _fail("任务不存在或已过期（服务可能已重启）", 404)
    return jsonify(run)


@bp.route("/api/adm/update/restart", methods=["POST"])
def api_restart():
    run_id, err = updater.start_restart()
    if err:
        return _fail(err, 409)
    _log.info("POST /api/adm/update/restart run=%s", run_id)
    return jsonify({"ok": True, "run_id": run_id})

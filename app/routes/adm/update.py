"""在线更新（GitHub）：后台管理模块 + 管理接口（仅管理员）。

页面
----
GET  /admin/update                 旧地址：重定向到后台管理的「在线更新」模块（/admin#update）

接口
----
GET  /api/adm/update               页面初始化：配置（token 脱敏）+ 本地版本 + 上次结果 + 当前任务
GET  /api/adm/update/check         检查远端是否有更新（?method=api|git 可临时覆盖配置）
POST /api/adm/update/config        保存配置（仓库 / 分支 / 令牌 / 检查方式 / 重启方式…）
POST /api/adm/update/init          把当前目录初始化为 Git 仓库（ZIP 安装后的补装）→ {run_id}
POST /api/adm/update/zip           上传源码 ZIP 包并覆盖更新（multipart: file）→ {run_id}
POST /api/adm/update/backup        手动备份当前代码（打包到 data/update_backup/）→ {run_id}
GET  /api/adm/update/backups       备份记录列表（文件名 / 类型 / 大小 / 时间）
GET  /api/adm/update/backup/download?name=   下载某份备份
POST /api/adm/update/backup/delete 删除某份备份 {name}
POST /api/adm/update/restore       恢复到某份备份 {name} → {run_id}
POST /api/adm/update/apply         执行更新 {reset: bool} → {run_id}
GET  /api/adm/update/status        查询任务进度 ?run_id=（不传则取当前任务）
POST /api/adm/update/restart       只重启（不拉代码）→ {run_id}

实现见 `services/adm/updater.py`。所有接口默认属于 admin 级别，
由 `routes/common/auth.py` 的全局鉴权统一拦截非管理员。
"""
import os
import uuid

from flask import Blueprint, jsonify, redirect, request, send_file

from ... import config
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


@bp.route("/api/adm/update/init", methods=["POST"])
def api_init():
    """ZIP 解压安装的目录没有 .git：这里补做 git init + 关联 origin + 对齐远端分支。"""
    run_id, err = updater.start_init()
    if err:
        return _fail(err, 409)
    _log.info("POST /api/adm/update/init run=%s", run_id)
    return jsonify({"ok": True, "run_id": run_id})


@bp.route("/api/adm/update/zip", methods=["POST"])
def api_zip():
    """上传源码 ZIP 包并覆盖更新：不依赖 Git / 外网，适合连不上 GitHub 的服务器。"""
    # 全局 MAX_CONTENT_LENGTH 是 32MB，这里单独放宽（Flask >= 3.1 才支持按请求设置）
    try:
        request.max_content_length = 512 * 1024 * 1024
    except Exception:
        pass
    file = request.files.get("file")
    if not file or not (file.filename or "").strip():
        return _fail("没有收到文件，请选择 ZIP 压缩包")
    name = os.path.basename(file.filename)
    if not name.lower().endswith(".zip"):
        return _fail("只支持 .zip 压缩包")
    upd_dir = os.path.join(config.DATA_ROOT, "update_uploads")
    try:
        os.makedirs(upd_dir, exist_ok=True)
    except OSError as e:
        return _fail("无法创建上传目录：%s" % e, 500)
    tmp = os.path.join(upd_dir, "upd_%s.zip" % uuid.uuid4().hex[:10])
    try:
        file.save(tmp)
    except Exception as e:
        _log.error("保存上传的 ZIP 失败: %s", e)
        return _fail("保存上传文件失败：%s" % e, 500)
    run_id, err = updater.start_zip_update(tmp, name)
    if err:
        try:
            os.remove(tmp)
        except OSError:
            pass
        return _fail(err, 409)
    _log.info("POST /api/adm/update/zip file=%s run=%s", name, run_id)
    return jsonify({"ok": True, "run_id": run_id})


@bp.route("/api/adm/update/backup", methods=["POST"])
def api_backup():
    """手动备份：把当前项目代码打包到 data/update_backup/（更新前也会自动执行）。"""
    run_id, err = updater.start_backup()
    if err:
        return _fail(err, 409)
    _log.info("POST /api/adm/update/backup run=%s", run_id)
    return jsonify({"ok": True, "run_id": run_id})


@bp.route("/api/adm/update/backups")
def api_backups():
    """备份记录列表。"""
    try:
        return jsonify({"ok": True, "dir": updater.backup_dir(), "backups": updater.list_backups()})
    except Exception as e:
        _log.error("读取备份记录失败: %s", e)
        return _fail("读取备份记录失败：%s" % e, 500)


@bp.route("/api/adm/update/backup/download")
def api_backup_download():
    """下载某份备份（便于在本地留一份）。"""
    name = request.args.get("name") or ""
    path = updater.backup_path(name)
    if not path or not os.path.isfile(path):
        return _fail("备份不存在（可能已被清理）", 404)
    _log.info("下载备份: %s", os.path.basename(path))
    return send_file(path, as_attachment=True, download_name=os.path.basename(path))


@bp.route("/api/adm/update/backup/delete", methods=["POST"])
def api_backup_delete():
    data = request.get_json(silent=True) or {}
    err = updater.delete_backup(data.get("name"))
    if err:
        return _fail(err)
    return jsonify({"ok": True})


@bp.route("/api/adm/update/restore", methods=["POST"])
def api_restore():
    data = request.get_json(silent=True) or {}
    run_id, err = updater.start_restore(data.get("name"))
    if err:
        return _fail(err, 409)
    _log.info("POST /api/adm/update/restore name=%s run=%s", data.get("name"), run_id)
    return jsonify({"ok": True, "run_id": run_id})


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

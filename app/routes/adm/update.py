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

store.db 数据同步 / 更新
GET  /api/adm/update/store                    本地库概览（大小/表数/行数/缺表）+ 服务器快照列表
GET  /api/adm/update/store/export             导出一致快照 .db（可给另一台机器导入）
GET  /api/adm/update/store/backup/download?name=  下载服务器快照
GET  /api/adm/update/store/task                查询当前任务；?run_id= 查询指定任务进度
POST /api/adm/update/store/task                创建后台任务 {action: sync|restore|backup|schema|delete}
POST /api/adm/update/store/inspect           校验来源并逐表对比本地库 → 差异报告 + 可复用的 src_token
POST /api/adm/update/store/upload            上传 .db 快照并同步（multipart: file + mode/tables/skip_cache）

实现见 `services/adm/updater.py` 与 `services/adm/store_sync.py`。所有接口默认属于 admin 级别，
由 `routes/common/auth.py` 的全局鉴权统一拦截非管理员。
"""
import os
import shutil
import time
import uuid

from flask import Blueprint, after_this_request, jsonify, redirect, request, send_file

from ... import config
from ...log import get_logger
from ...services.adm import updater, store_sync

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


# --------------------------------------------------------------------------- store.db 同步
@bp.route("/api/adm/update/store")
def api_store_state():
    """本地 store.db 概览（路径 / 大小 / 表数 / 行数 / 缺表 / 服务器快照列表）。"""
    try:
        return jsonify(store_sync.status())
    except Exception as e:
        _log.error("读取 store.db 状态失败: %s", e)
        return _fail("读取 store.db 状态失败：%s" % e, 500)


@bp.route("/api/adm/update/store/export")
def api_store_export():
    """导出一致快照（含 WAL 数据），可直接作为另一台机器的同步来源。"""
    tmp = ""
    try:
        tmp = store_sync.export_path()
        store_sync.snapshot(tmp)
    except Exception as e:
        _log.error("导出 store.db 快照失败: %s", e)
        return _fail("导出快照失败：%s" % e, 500)

    @after_this_request
    def _cleanup(resp):
        try:
            os.remove(tmp)
        except OSError:
            pass
        return resp

    _log.info("导出 store.db 快照")
    return send_file(tmp, as_attachment=True,
                     download_name="store_%s.db" % time.strftime("%Y%m%d_%H%M%S"))


@bp.route("/api/adm/update/store/backup/download")
def api_store_backup_download():
    """下载服务器上保存的 store.db 快照。"""
    path = store_sync.backup_path(request.args.get("name") or "")
    if not path or not os.path.isfile(path):
        return _fail("快照不存在或文件名不合法", 404)
    return send_file(path, as_attachment=True, download_name=os.path.basename(path))


def _store_params(data, src_path="", cleanup_src=False):
    """整理同步参数（表名过滤交给服务层做安全校验）。"""
    params = {
        "mode": data.get("mode") or "merge",
        "skip_cache": bool(data.get("skip_cache", True)),
        "tables": data.get("tables") or [],
        "url": (data.get("url") or "").strip(),
        "token": data.get("token") or "",
        "name": data.get("name") or "",
        "src_token": (data.get("src_token") or "").strip(),
    }
    if src_path:
        params["src_path"] = src_path
        params["cleanup_src"] = cleanup_src
    return params


@bp.route("/api/adm/update/store/inspect", methods=["POST"])
def api_store_inspect():
    """校验来源 .db 并逐表对比本地库，返回差异报告 + 可复用的 src_token。

    来源：multipart file / JSON {url, token} / JSON {name} 服务器快照 /
    JSON {src_token} 对已校验来源按新选项重新分析（不重复上传）。
    """
    try:
        request.max_content_length = 512 * 1024 * 1024
    except Exception:
        pass
    file = request.files.get("file")
    data = request.form.to_dict() if file else (request.get_json(silent=True) or {})
    params = store_sync.normalize_params(_store_params(data))
    token = params.get("src_token") or ""
    display = ""

    if token:
        src_path = store_sync.source_path(token)
        if not src_path:
            return _fail("来源文件已过期，请重新校验", 404)
        display = data.get("display_name") or "已校验来源"
        keep = True                         # 复用已有文件，分析失败也不删
    else:
        src_path = store_sync.new_source_path()
        token = store_sync.source_token(src_path)
        keep = False
        try:
            if file:
                name = os.path.basename(file.filename or "")
                if not name.lower().endswith((".db", ".sqlite", ".sqlite3")):
                    return _fail("只支持 .db / .sqlite / .sqlite3 数据库文件")
                file.save(src_path)
                display = name
            elif (data.get("url") or "").strip():
                url = data["url"].strip()
                store_sync.download_to(url, data.get("token") or "", src_path)
                display = url
            elif data.get("name"):
                bak = store_sync.backup_path(data.get("name"))
                if not bak or not os.path.isfile(bak):
                    return _fail("快照不存在或文件名不合法", 404)
                shutil.copyfile(bak, src_path)
                display = os.path.basename(bak)
            else:
                return _fail("请选择文件、填写远程 URL 或指定服务器快照")
        except Exception as e:
            try:
                os.remove(src_path)
            except OSError:
                pass
            _log.error("读取 store.db 校验来源失败: %s", e)
            return _fail("读取来源失败：%s" % e, 500)

    try:
        report = store_sync.inspect(src_path, params, display)
    except Exception as e:
        if not keep:
            try:
                os.remove(src_path)
            except OSError:
                pass
        _log.error("校验 store.db 来源失败: %s", e)
        return _fail("校验失败：%s" % e, 400)
    report["src_token"] = token
    return jsonify(report)


@bp.route("/api/adm/update/store/task", methods=["GET", "POST"])
def api_store_task():
    """创建 / 查询 store.db 后台任务。

    POST body: {action: sync|restore|backup|schema|delete, ...}
    GET  ?run_id= 返回任务进度（events 与在线更新任务同结构）。
    """
    if request.method == "GET":
        run_id = (request.args.get("run_id") or "").strip()
        # 不带 run_id 时返回当前进行中的任务，页面刷新后能续上进度
        task = store_sync.get_task(run_id) if run_id else store_sync.current_task()
        if not task:
            return _fail("任务不存在或已过期（服务可能已重启）", 404)
        return jsonify(task)

    data = request.get_json(silent=True) or {}
    action = (data.get("action") or "").strip()
    src_path = ""
    if action == "restore":
        src_path = store_sync.backup_path(data.get("name"))
        if not src_path or not os.path.isfile(src_path):
            return _fail("快照不存在或文件名不合法", 404)
    elif action == "sync":
        tok = (data.get("src_token") or "").strip()
        if tok:
            src_path = store_sync.source_path(tok)
            if not src_path:
                return _fail("来源文件已过期，请重新校验", 404)
        elif not (data.get("url") or "").strip():
            return _fail("请先校验来源差异，或填写远程 URL")

    run_id, err = store_sync.start_task(action, _store_params(data, src_path))
    if err:
        return _fail(err, 409)
    _log.info("POST /api/adm/update/store/task action=%s run=%s", action, run_id)
    return jsonify({"ok": True, "run_id": run_id})


@bp.route("/api/adm/update/store/upload", methods=["POST"])
def api_store_upload():
    """上传另一台机器导出的 store.db，并按选定模式合并进本地库。"""
    try:
        request.max_content_length = 512 * 1024 * 1024
    except Exception:
        pass
    file = request.files.get("file")
    if not file or not (file.filename or "").strip():
        return _fail("没有收到文件，请选择 .db 数据库文件")
    name = os.path.basename(file.filename)
    if not name.lower().endswith((".db", ".sqlite", ".sqlite3")):
        return _fail("只支持 .db / .sqlite / .sqlite3 数据库文件")
    try:
        path = store_sync.upload_path()
        file.save(path)
    except Exception as e:
        _log.error("保存上传的 store.db 失败: %s", e)
        return _fail("保存上传文件失败：%s" % e, 500)

    run_id, err = store_sync.start_task(
        "sync", _store_params(request.form.to_dict(), path, cleanup_src=True))
    if err:
        for p in (path, path + "-wal", path + "-shm"):
            try:
                os.remove(p)
            except OSError:
                pass
        return _fail(err, 409)
    _log.info("POST /api/adm/update/store/upload file=%s run=%s", name, run_id)
    return jsonify({"ok": True, "run_id": run_id})

"""Trae CN 积分 / 签到模块接口。

GET  /api/traecn/overview           首屏汇总（?uid= 指定账号、?fresh=1 拉官方最新）
POST /api/traecn/test               测试连接：只查签到状态，不领取积分
POST /api/traecn/checkin            执行当日签到（幂等，body 可带 uid）
POST /api/traecn/checkin/all        全部启用账号批量签到
GET  /api/traecn/history            签到记录（q / page / page_size / uid）

多账号管理：
GET  /api/traecn/accounts           账号列表（脱敏）
POST /api/traecn/accounts/save      新增 / 编辑账号（token 加密落库）
POST /api/traecn/accounts/delete    移除账号
POST /api/traecn/accounts/current   切换当前账号
POST /api/traecn/accounts/refresh_all  批量刷新全部账号余额

网站连接登录（读取本机 Trae 客户端登录态，无需手动抄 Token）：
POST /api/traecn/connect            扫描本机 Trae 桌面 / CLI 登录态并导入账号
                                    可选 body：{"editions": ["cn","sg",...]} 限定版本

凭据为手动填写的 Cloud-IDE-Token（JWT）+ device_id；官方接口固定 api.trae.cn，
业务实现见 services/ide/traecn.py。接口不返回 token 明文或密文；默认仅管理员可用。
"""
from flask import Blueprint, jsonify, request

from ...services.ide import traecn as tr

bp = Blueprint("traecn", __name__)


def _fail(msg, code=400):
    return jsonify({"error": str(msg)}), code


@bp.get("/api/traecn/overview")
def traecn_overview():
    # 默认只读本地库（毫秒级）；fresh=1 才请求官方最新数据
    fresh = request.args.get("fresh") in ("1", "true")
    return jsonify(tr.overview(
        uid=request.args.get("uid", ""), fresh=fresh))


@bp.post("/api/traecn/test")
def traecn_test():
    data = request.get_json(silent=True) or {}
    try:
        return jsonify(tr.test_connection(uid=data.get("uid", "")))
    except tr.TraeError as e:
        return _fail(e)
    except Exception as e:                       # 兜底：不让上游异常变成 HTML 错误页
        return _fail("测试连接失败：%s" % e, 502)


@bp.post("/api/traecn/checkin")
def traecn_checkin():
    data = request.get_json(silent=True) or {}
    source = str(data.get("source") or "manual").strip()[:20]
    uid = str(data.get("uid") or "").strip()
    try:
        creds = tr.resolve_credentials(uid)
        return jsonify({"ok": True, **tr.do_checkin(creds, source=source)})
    except tr.TraeError as e:
        return _fail(e)
    except Exception as e:
        return _fail("签到失败：%s" % e, 502)


@bp.get("/api/traecn/history")
def traecn_history():
    try:
        page = max(1, int(request.args.get("page", 1)))
    except (TypeError, ValueError):
        page = 1
    try:
        size = max(1, min(500, int(request.args.get("page_size", 10))))
    except (TypeError, ValueError):
        size = 10
    return jsonify(tr.list_history(
        q=request.args.get("q", ""), page=page, size=size,
        sort=request.args.get("sort", ""), order=request.args.get("order", ""),
        uid=request.args.get("uid", "")))


# --------------------------------------------------------------------------- 多账号

@bp.get("/api/traecn/accounts")
def traecn_accounts():
    items = tr.list_accounts()
    return jsonify({"ok": True, "items": items, "total": len(items),
                    "current_uid": tr.current_uid()})


@bp.post("/api/traecn/accounts/save")
def traecn_account_save():
    data = request.get_json(silent=True) or {}
    try:
        acc = tr.save_account(data)
        return jsonify({"ok": True, "account": acc, "items": tr.list_accounts()})
    except tr.TraeError as e:
        return _fail(e)
    except Exception as e:
        return _fail("保存账号失败：%s" % e, 502)


@bp.post("/api/traecn/accounts/delete")
def traecn_account_delete():
    data = request.get_json(silent=True) or {}
    try:
        items = tr.delete_account(data.get("uid", ""))
        return jsonify({"ok": True, "items": items, "current_uid": tr.current_uid()})
    except tr.TraeError as e:
        return _fail(e)


@bp.post("/api/traecn/accounts/current")
def traecn_account_current():
    data = request.get_json(silent=True) or {}
    try:
        return jsonify({"ok": True, "current_uid": tr.set_current(data.get("uid", ""))})
    except tr.TraeError as e:
        return _fail(e)


@bp.post("/api/traecn/accounts/refresh_all")
def traecn_accounts_refresh_all():
    try:
        return jsonify(tr.refresh_all())
    except Exception as e:
        return _fail("批量刷新失败：%s" % e, 502)


@bp.post("/api/traecn/connect")
def traecn_connect():
    """网站连接登录：扫描本机 Trae 桌面 / CLI 登录态并导入账号。"""
    data = request.get_json(silent=True) or {}
    editions = data.get("editions")
    try:
        result = tr.connect_local_trae(editions=editions)
        return jsonify({"ok": True, **result})
    except tr.TraeError as e:
        return _fail(e)
    except Exception as e:
        return _fail("网站连接登录失败：%s" % e, 502)


@bp.post("/api/traecn/device_id/auto")
def traecn_device_id_auto():
    """自动获取设备号：扫描本机 Trae 登录态，为缺 device_id 的账号补齐。"""
    try:
        return jsonify(tr.auto_fill_device_id())
    except tr.TraeError as e:
        return _fail(e)
    except Exception as e:
        return _fail("自动获取设备号失败：%s" % e, 502)


@bp.post("/api/traecn/checkin/all")
def traecn_checkin_all():
    try:
        return jsonify(tr.checkin_all())
    except Exception as e:
        return _fail("批量签到失败：%s" % e, 502)

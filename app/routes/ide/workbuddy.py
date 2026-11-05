"""WorkBuddy 积分 / 签到模块接口。

GET  /api/workbuddy/overview            首屏汇总（?uid= 指定账号：余额 / 状态 / 账号列表 / 最近记录）
GET  /api/workbuddy/config              全局配置（token 一律脱敏，不回显）
POST /api/workbuddy/config              保存全局配置
POST /api/workbuddy/test                测试连接：只查签到状态，不领取积分
POST /api/workbuddy/checkin             执行当日签到（幂等，body 可带 uid）
POST /api/workbuddy/checkin/all         全部启用账号批量签到
GET  /api/workbuddy/history             签到记录（q / page / page_size / uid）
GET  /api/workbuddy/credits/summary     跨账号总积分 / 账号构成 / 最近过期积分
POST /api/workbuddy/credits/refresh     刷新积分构成快照（body: {uid?, all?}）

多账号管理：
GET  /api/workbuddy/accounts            账号列表（脱敏）
POST /api/workbuddy/accounts/save       新增 / 编辑账号（凭据加密落库）
POST /api/workbuddy/accounts/delete    移除账号
POST /api/workbuddy/accounts/current   切换当前账号
POST /api/workbuddy/accounts/refresh   刷新指定账号登录态
POST /api/workbuddy/accounts/refresh_all  批量刷新全部账号余额

OAuth 设备授权登录（参考 workbuddy2api-panel 的 login/start + login/poll）：
国内版 realm=cn（copilot.tencent.com + 微信扫码），
国际版 realm=global（workbuddy.ai，登录后自动注册激活 + 领取一次性 trial 加油包；
国际版无每日签到体系，签到按钮等价为幂等的激活 / 试用包领取）。
POST /api/workbuddy/login/start         发起授权（body: {realm: cn|global}）
GET  /api/workbuddy/login/qr            授权链接二维码（PNG）
GET  /api/workbuddy/login/poll          轮询授权结果；成功后凭据加密落库
POST /api/workbuddy/login/refresh       用 refreshToken 刷新登录态
POST /api/workbuddy/login/logout        清除已保存的登录凭据
POST /api/workbuddy/login/cancel        放弃本次授权会话

业务实现见 services/ide/workbuddy.py。凭据只在服务端使用，接口不会返回
accessToken / refreshToken 明文或密文；所有接口默认仅管理员可用。
"""
from flask import Blueprint, jsonify, make_response, request

from ...services.ide import workbuddy as wb

bp = Blueprint("workbuddy", __name__)


def _fail(msg, code=400):
    return jsonify({"error": str(msg)}), code


@bp.get("/api/workbuddy/overview")
def wb_overview():
    # 默认只读本地库（切换账号毫秒级）；fresh=1 才请求官方最新数据
    fresh = request.args.get("fresh") in ("1", "true")
    return jsonify(wb.overview(
        uid=request.args.get("uid", ""), fresh=fresh))


@bp.route("/api/workbuddy/config", methods=["GET", "POST"])
def wb_config():
    if request.method == "GET":
        return jsonify(wb.public_config())
    data = request.get_json(silent=True) or {}
    try:
        return jsonify({"ok": True, "config": wb.save_config(data)})
    except wb.WorkBuddyError as e:
        return _fail(e)


@bp.post("/api/workbuddy/test")
def wb_test():
    data = request.get_json(silent=True) or {}
    try:
        return jsonify(wb.test_connection(uid=data.get("uid", "")))
    except wb.WorkBuddyError as e:
        return _fail(e)
    except Exception as e:                       # 兜底：不让上游异常变成 HTML 错误页
        return _fail("测试连接失败：%s" % e, 502)


@bp.post("/api/workbuddy/checkin")
def wb_checkin():
    data = request.get_json(silent=True) or {}
    source = str(data.get("source") or "manual").strip()[:20]
    uid = str(data.get("uid") or "").strip()
    try:
        creds = wb.resolve_credentials(uid)
        creds["timeout"] = wb.get_config()["timeout"]
        return jsonify({"ok": True, **wb.do_checkin(creds, source=source)})
    except wb.WorkBuddyError as e:
        return _fail(e)
    except Exception as e:
        return _fail("签到失败：%s" % e, 502)


@bp.get("/api/workbuddy/history")
def wb_history():
    try:
        page = max(1, int(request.args.get("page", 1)))
    except (TypeError, ValueError):
        page = 1
    try:
        size = max(1, min(500, int(request.args.get("page_size", 10))))
    except (TypeError, ValueError):
        size = 10
    return jsonify(wb.list_history(
        q=request.args.get("q", ""), page=page, size=size,
        sort=request.args.get("sort", ""), order=request.args.get("order", ""),
        uid=request.args.get("uid", "")))


# --------------------------------------------------------------------------- 扫码登录

@bp.post("/api/workbuddy/login/start")
def wb_login_start():
    data = request.get_json(silent=True) or {}
    try:
        return jsonify(wb.login_start(realm=str(data.get("realm") or "cn")))
    except wb.WorkBuddyError as e:
        return _fail(e, 502)
    except Exception as e:
        return _fail("发起登录失败：%s" % e, 502)


@bp.get("/api/workbuddy/login/qr")
def wb_login_qr():
    try:
        data, mimetype = wb.login_qr_image(request.args.get("state", ""))
    except wb.WorkBuddyError as e:
        return _fail(e)
    resp = make_response(data)
    resp.headers["Content-Type"] = mimetype
    resp.headers["Cache-Control"] = "no-store"
    return resp


@bp.get("/api/workbuddy/login/poll")
def wb_login_poll():
    try:
        return jsonify(wb.login_poll(request.args.get("state", "")))
    except wb.WorkBuddyError as e:
        return _fail(e)
    except Exception as e:
        return _fail("查询登录结果失败：%s" % e, 502)


@bp.post("/api/workbuddy/login/refresh")
def wb_login_refresh():
    data = request.get_json(silent=True) or {}
    try:
        return jsonify(wb.refresh_login(uid=data.get("uid", ""), force=True))
    except wb.WorkBuddyError as e:
        return _fail(e)
    except Exception as e:
        return _fail("刷新登录态失败：%s" % e, 502)


@bp.post("/api/workbuddy/login/logout")
def wb_login_logout():
    data = request.get_json(silent=True) or {}
    try:
        return jsonify({"ok": True, "config": wb.logout(uid=data.get("uid", ""))})
    except wb.WorkBuddyError as e:
        return _fail(e)


@bp.post("/api/workbuddy/login/cancel")
def wb_login_cancel():
    data = request.get_json(silent=True) or {}
    wb.login_cancel(data.get("state", ""))
    return jsonify({"ok": True})


# --------------------------------------------------------------------------- 积分构成

@bp.get("/api/workbuddy/credits/summary")
def wb_credits_summary():
    return jsonify(wb.credits_summary())


@bp.post("/api/workbuddy/credits/refresh")
def wb_credits_refresh():
    data = request.get_json(silent=True) or {}
    try:
        if data.get("all"):
            return jsonify(wb.refresh_all())
        return jsonify(wb.refresh_packages(uid=data.get("uid", "")))
    except wb.WorkBuddyError as e:
        return _fail(e)
    except Exception as e:
        return _fail("刷新积分构成失败：%s" % e, 502)


# --------------------------------------------------------------------------- 多账号

@bp.get("/api/workbuddy/accounts")
def wb_accounts():
    items = wb.list_accounts()
    return jsonify({"ok": True, "items": items, "total": len(items),
                    "current_uid": wb.current_uid()})


@bp.post("/api/workbuddy/accounts/save")
def wb_account_save():
    data = request.get_json(silent=True) or {}
    try:
        acc = wb.save_account(data)
        return jsonify({"ok": True, "account": acc, "items": wb.list_accounts()})
    except wb.WorkBuddyError as e:
        return _fail(e)
    except Exception as e:
        return _fail("保存账号失败：%s" % e, 502)


@bp.post("/api/workbuddy/accounts/delete")
def wb_account_delete():
    data = request.get_json(silent=True) or {}
    try:
        items = wb.delete_account(data.get("uid", ""))
        return jsonify({"ok": True, "items": items, "current_uid": wb.current_uid()})
    except wb.WorkBuddyError as e:
        return _fail(e)


@bp.post("/api/workbuddy/accounts/current")
def wb_account_current():
    data = request.get_json(silent=True) or {}
    try:
        return jsonify({"ok": True, "current_uid": wb.set_current(data.get("uid", ""))})
    except wb.WorkBuddyError as e:
        return _fail(e)


@bp.post("/api/workbuddy/accounts/refresh")
def wb_account_refresh():
    data = request.get_json(silent=True) or {}
    uid = str(data.get("uid") or "").strip() or wb.current_uid()
    try:
        return jsonify({"ok": True, **wb.refresh_login(uid=uid, force=True)})
    except wb.WorkBuddyError as e:
        return _fail(e)
    except Exception as e:
        return _fail("刷新登录态失败：%s" % e, 502)


@bp.post("/api/workbuddy/accounts/refresh_all")
def wb_accounts_refresh_all():
    try:
        return jsonify(wb.refresh_all())
    except Exception as e:
        return _fail("批量刷新失败：%s" % e, 502)


@bp.post("/api/workbuddy/checkin/all")
def wb_checkin_all():
    try:
        return jsonify(wb.checkin_all())
    except Exception as e:
        return _fail("批量签到失败：%s" % e, 502)

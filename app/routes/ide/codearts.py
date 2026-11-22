"""CodeArts（华为云）积分 / 签到模块接口。

GET  /api/codearts/overview           首屏汇总（?uid= 指定账号、?fresh=1 拉官方最新）
GET  /api/codearts/config             全局配置（凭据一律脱敏，不回显）
POST /api/codearts/config             保存全局配置（代理 / 超时）
POST /api/codearts/test               测试连接：只查签到状态，不领取积分
POST /api/codearts/checkin            执行当日签到（幂等，body 可带 uid）
POST /api/codearts/checkin/all        全部启用账号批量签到
GET  /api/codearts/history            签到记录（q / page / page_size / uid）
GET  /api/codearts/credits/summary    跨账号总积分 / 账号构成（读本地快照）
POST /api/codearts/credits/refresh    刷新积分构成快照（body: {uid?, all?}）

多账号管理：
GET  /api/codearts/accounts           账号列表（脱敏）
POST /api/codearts/accounts/save      编辑账号（昵称 / 备注 / 启用；凭据由登录流程写入）
POST /api/codearts/accounts/delete    移除账号
POST /api/codearts/accounts/current   切换当前账号
POST /api/codearts/accounts/refresh   手动续期指定账号 STS 临时凭据
POST /api/codearts/accounts/refresh_all  批量刷新全部账号余额

链接登录（华为云 OAuth 浏览器授权，参考 dsh-get-it-for-free 渠道包）：
POST /api/codearts/login/start        生成授权链接并在本机起 127.0.0.1 回调服务
GET  /api/codearts/login/poll         轮询授权结果；成功后凭据加密落库
POST /api/codearts/login/cancel       放弃本次授权会话
POST /api/codearts/login/logout       移除指定账号（旧接口语义）

业务实现见 services/ide/codearts.py。凭据只在服务端使用，接口不返回
AK / SK / security_token / refresh_token 明文或密文；所有接口默认仅管理员可用。
"""
from flask import Blueprint, jsonify, request

from ...services.ide import codearts as ca

bp = Blueprint("codearts", __name__)


def _fail(msg, code=400):
    return jsonify({"error": str(msg)}), code


def _cred_fail(e, code=400):
    """凭据失效类错误：消息里没有「重新登录」提示时补一句，避免重复。"""
    msg = str(e)
    if "重新链接登录" not in msg:
        msg += "（请重新链接登录）"
    return _fail(msg, code)


@bp.get("/api/codearts/overview")
def ca_overview():
    # 默认只读本地库（毫秒级）；fresh=1 才请求官方最新数据
    fresh = request.args.get("fresh") in ("1", "true")
    return jsonify(ca.overview(
        uid=request.args.get("uid", ""), fresh=fresh))


@bp.route("/api/codearts/config", methods=["GET", "POST"])
def ca_config():
    if request.method == "GET":
        return jsonify(ca.public_config())
    data = request.get_json(silent=True) or {}
    return jsonify({"ok": True, "config": ca.save_config(data)})


@bp.post("/api/codearts/test")
def ca_test():
    data = request.get_json(silent=True) or {}
    try:
        return jsonify(ca.test_connection(uid=data.get("uid", "")))
    except ca.CredentialExpiredError as e:
        return _cred_fail(e)
    except ca.CodeArtsError as e:
        return _fail(e)
    except Exception as e:                       # 兜底：不让上游异常变成 HTML 错误页
        return _fail("测试连接失败：%s" % e, 502)


@bp.post("/api/codearts/checkin")
def ca_checkin():
    data = request.get_json(silent=True) or {}
    source = str(data.get("source") or "manual").strip()[:20]
    uid = str(data.get("uid") or "").strip()
    try:
        credential = ca.resolve_credentials(uid)
        return jsonify({"ok": True, **ca.do_checkin(
            credential, uid=credential.get("_uid") or uid, source=source)})
    except ca.CredentialExpiredError as e:
        return _cred_fail(e)
    except ca.CodeArtsError as e:
        return _fail(e)
    except Exception as e:
        return _fail("签到失败：%s" % e, 502)


@bp.get("/api/codearts/history")
def ca_history():
    try:
        page = max(1, int(request.args.get("page", 1)))
    except (TypeError, ValueError):
        page = 1
    try:
        size = max(1, min(500, int(request.args.get("page_size", 10))))
    except (TypeError, ValueError):
        size = 10
    return jsonify(ca.list_history(
        q=request.args.get("q", ""), page=page, size=size,
        sort=request.args.get("sort", ""), order=request.args.get("order", ""),
        uid=request.args.get("uid", "")))


# --------------------------------------------------------------------------- 链接登录

@bp.post("/api/codearts/login/start")
def ca_login_start():
    try:
        return jsonify(ca.login_start())
    except ca.CodeArtsError as e:
        return _fail(e)
    except Exception as e:
        return _fail("发起链接登录失败：%s" % e, 502)


@bp.get("/api/codearts/login/poll")
def ca_login_poll():
    try:
        return jsonify(ca.login_poll(request.args.get("state", "")))
    except ca.CodeArtsError as e:
        return _fail(e)
    except Exception as e:
        return _fail("查询登录结果失败：%s" % e, 502)


@bp.post("/api/codearts/login/cancel")
def ca_login_cancel():
    data = request.get_json(silent=True) or {}
    ca.login_cancel(data.get("state", ""))
    return jsonify({"ok": True})


@bp.post("/api/codearts/login/logout")
def ca_login_logout():
    data = request.get_json(silent=True) or {}
    try:
        return jsonify({"ok": True, "config": ca.logout(uid=data.get("uid", ""))})
    except ca.CodeArtsError as e:
        return _fail(e)


# --------------------------------------------------------------------------- 积分构成

@bp.get("/api/codearts/credits/summary")
def ca_credits_summary():
    return jsonify(ca.credits_summary())


@bp.post("/api/codearts/credits/refresh")
def ca_credits_refresh():
    data = request.get_json(silent=True) or {}
    try:
        if data.get("all"):
            return jsonify(ca.refresh_all())
        return jsonify(ca.refresh_packages(uid=data.get("uid", "")))
    except ca.CodeArtsError as e:
        return _fail(e)
    except Exception as e:
        return _fail("刷新积分构成失败：%s" % e, 502)


# --------------------------------------------------------------------------- 多账号

@bp.get("/api/codearts/accounts")
def ca_accounts():
    items = ca.list_accounts()
    return jsonify({"ok": True, "items": items, "total": len(items),
                    "current_uid": ca.current_uid()})


@bp.post("/api/codearts/accounts/save")
def ca_account_save():
    data = request.get_json(silent=True) or {}
    try:
        acc = ca.save_account(data)
        return jsonify({"ok": True, "account": acc, "items": ca.list_accounts()})
    except ca.CodeArtsError as e:
        return _fail(e)
    except Exception as e:
        return _fail("保存账号失败：%s" % e, 502)


@bp.post("/api/codearts/accounts/delete")
def ca_account_delete():
    data = request.get_json(silent=True) or {}
    try:
        items = ca.delete_account(data.get("uid", ""))
        return jsonify({"ok": True, "items": items, "current_uid": ca.current_uid()})
    except ca.CodeArtsError as e:
        return _fail(e)


@bp.post("/api/codearts/accounts/current")
def ca_account_current():
    data = request.get_json(silent=True) or {}
    try:
        return jsonify({"ok": True, "current_uid": ca.set_current(data.get("uid", ""))})
    except ca.CodeArtsError as e:
        return _fail(e)


@bp.post("/api/codearts/accounts/refresh")
def ca_account_refresh():
    """手动续期指定账号的 STS 临时凭据（约 2 小时一轮）。"""
    data = request.get_json(silent=True) or {}
    uid = str(data.get("uid") or "").strip() or ca.current_uid()
    try:
        return jsonify({"ok": True, **ca.refresh_login(uid=uid, force=True)})
    except ca.CredentialExpiredError as e:
        return _cred_fail(e)
    except ca.CodeArtsError as e:
        return _fail(e)
    except Exception as e:
        return _fail("续期凭据失败：%s" % e, 502)


@bp.post("/api/codearts/accounts/refresh_all")
def ca_accounts_refresh_all():
    try:
        return jsonify(ca.refresh_all())
    except Exception as e:
        return _fail("批量刷新失败：%s" % e, 502)


@bp.get("/api/codearts/models")
def ca_models():
    """当前账号的可用模型清单（?uid= 可指定账号，?force=1 强制重拉）。

    模型目录来自华为云 opengw gateway config + snap builtin 双源（签名 GET），
    含积分倍率（credit[].ratio_display）。30 分钟内存节流。
    """
    try:
        force = request.args.get("force") in ("1", "true")
        return jsonify(ca.models_info(request.args.get("uid", ""), force=force))
    except ca.CodeArtsError as e:
        return _fail(e)
    except Exception as e:                       # noqa: BLE001
        return _fail("获取模型清单失败：%s" % e, 502)


@bp.post("/api/codearts/checkin/all")
def ca_checkin_all():
    try:
        return jsonify(ca.checkin_all())
    except Exception as e:
        return _fail("批量签到失败：%s" % e, 502)

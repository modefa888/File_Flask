"""V2Ray / Xray 代理模块：订阅管理、节点管理、10808 代理出口的连接与共享。

GET  /api/v2ray/status           汇总状态（内核 / 进程 / 入站端口 / 分享地址）
GET  /api/v2ray/core             内核探测结果（候选列表 + 当前选用）
POST /api/v2ray/core/detect      启动后台探测任务 → {job}
POST /api/v2ray/core/download    启动后台下载任务 {url?, kind?}（kind = xray / sing-box）→ {job}
GET  /api/v2ray/core/job/<jid>/stream   SSE：任务进度（阶段 / 百分比 / 已下载字节 / 步骤日志）
POST /api/v2ray/core/path        手动指定内核路径 {path}
GET  /api/v2ray/nodes            节点列表 ?sub_id=
POST /api/v2ray/nodes/add        添加节点：{links?（字符串 / 对象数组 / 备份文件）, node?（表单参数）, sub_id?}
POST /api/v2ray/nodes/update     改名 / 备注 / 连接参数 {id, name?, remark?, server?, port?, fields?}
POST /api/v2ray/nodes/batch-grp  批量移动分组 {ids:[...], grp}（grp 空 = 移出分组）
POST /api/v2ray/nodes/dedupe     重复节点检测 / 一键清理 {apply}
POST /api/v2ray/nodes/export     节点导出 {ids?, format: txt|json}
POST /api/v2ray/speedtest/config 定时测速配置 {on, interval, pick, dl}
POST /api/v2ray/speedtest/run    立即测一轮
POST /api/v2ray/nodes/delete     批量删除 {ids:[...]}
GET  /api/v2ray/subs             订阅列表
POST /api/v2ray/subs/save        新建 / 更新订阅 {id?, name, url, proxy?, enabled?}
POST /api/v2ray/subs/delete      删除订阅（连带其节点）{id}
POST /api/v2ray/subs/refresh     拉取订阅并更新节点 {id?}（不传 id = 刷新全部）
POST /api/v2ray/preview          预览某节点生成的运行配置 {id}
GET  /api/v2ray/settings         模块设置（密码脱敏）
POST /api/v2ray/settings         保存模块设置
POST /api/v2ray/connect          连接：按节点启动内核 {id}
POST /api/v2ray/disconnect       断开（停止内核）
POST /api/v2ray/restart          重启（沿用当前节点）
GET  /api/v2ray/log              运行日志（末尾若干行）?lines=
POST /api/v2ray/log/clear        清空运行日志
POST /api/v2ray/ping             节点连通性测试（TCP 握手延迟）{id}
POST /api/v2ray/exit-test        通过本机代理出口访问探测地址，返回出口 IP + 归属地 / ISP
GET  /api/v2ray/traffic          实时网速 + 各节点 / 总流量统计（持久化）
POST /api/v2ray/traffic/reset    流量统计清零

说明：入站监听地址默认 0.0.0.0，即同网段的其他用户填 本机IP:10808 即可把本机当
SOCKS5 代理使用；如需限制范围，可在设置里改为 127.0.0.1，或给入站加用户名密码。
"""
import io
import json
import secrets
import socket
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

from flask import Blueprint, Response, jsonify, request, send_file

from ...log import get_logger
from ...services.common import proxyutil, secret, transport
from ...services.ide import v2raycfg, v2raydb, v2raymgr, v2rayfloat, v2ray_server

_log = get_logger()
bp = Blueprint("v2ray", __name__)

# 允许通过设置接口写入的键（其余一律忽略）
_SETTING_KEYS = ("core_path", "core_url", "core_kind", "socks_port", "socks_listen",
                 "socks_user", "http_port", "log_level", "sub_proxy", "auto_start",
                 "api_port", "auth_enabled", "route_mode", "bypass_cn", "shared_core")
_LISTEN_CHOICES = ("0.0.0.0", "127.0.0.1")


def _fail(msg, code=400):
    return jsonify({"error": msg}), code


def _int(v, default=0):
    try:
        return int(str(v).strip())
    except (TypeError, ValueError):
        return default


# ---------------------------------------------------------------------------
# 状态 / 内核
# ---------------------------------------------------------------------------

@bp.get("/api/v2ray/status")
def v2_status():
    r = v2raymgr.status()
    r["speedtest"] = v2raymgr.speedtest_state()
    return jsonify(r)


@bp.route("/api/v2ray/clients", methods=["GET", "POST"])
def v2_clients():
    """实时连接到代理入站端口的客户端列表（按来源 IP 聚合）。"""
    return jsonify(v2raymgr.inbound_clients())


@bp.get("/api/v2ray/client_usage")
def v2_client_usage():
    """客户端使用统计：按来源 IP 的流量 / 使用时长 / 首次与最后使用时间。"""
    return jsonify({"items": v2raymgr.client_usage()})


@bp.post("/api/v2ray/client_usage/clear")
def v2_client_usage_clear():
    """清空客户端使用统计。"""
    v2raymgr.client_usage_reset()
    return jsonify({"ok": True})


@bp.get("/api/v2ray/core")
def v2_core():
    return jsonify(v2raymgr.core_info())


@bp.post("/api/v2ray/core/detect")
def v2_core_detect():
    """启动后台探测任务 {kind?}，返回 job id（进度用 /core/job/<jid>/stream 订阅）。

    kind 限定只探测某一类内核（xray = Xray/V2Ray 系，sing-box），不传则全部探测。
    """
    data = request.get_json(silent=True) or {}
    kind = str(data.get("kind") or "")
    return jsonify({"ok": True, "job": v2raymgr.core_detect_job(_kind(kind) if kind else "")})


@bp.post("/api/v2ray/core/download")
def v2_core_download():
    """启动后台下载任务 {url?, kind?}，返回 job id（进度用 /core/job/<jid>/stream 订阅）。"""
    data = request.get_json(silent=True) or {}
    return jsonify({"ok": True, "job": v2raymgr.core_download_job(
        str(data.get("url") or ""), str(data.get("kind") or "xray"))})


@bp.post("/api/v2ray/geo/download")
def v2_geo_download():
    """启动后台任务：只下载 geoip.dat / geosite.dat 到当前内核目录（补全大陆分流数据）。"""
    return jsonify({"ok": True, "job": v2raymgr.geo_download_job()})


def _kind(v) -> str:
    """内核类型参数归一：只认 xray / sing-box，其余按 xray。"""
    return "sing-box" if str(v or "") == "sing-box" else "xray"


@bp.get("/api/v2ray/core/versions")
def v2_core_versions():
    """多版本管理：某类型内核的已安装版本 + 当前选用 + 官方近期发布列表（remote）。"""
    kind = _kind(request.args.get("kind"))
    data = v2raymgr.core_versions_info(kind)
    try:
        data["remote"] = v2raymgr.core_remote_versions(kind, 30)
        data["remote_error"] = ""
    except ValueError as e:
        data["remote"] = []
        data["remote_error"] = str(e)
    return jsonify(data)


@bp.post("/api/v2ray/core/install-version")
def v2_core_install_version():
    """后台下载安装指定版本（不自动切换），返回 job id。"""
    data = request.get_json(silent=True) or {}
    try:
        job = v2raymgr.core_install_version_job(str(data.get("version") or ""),
                                                _kind(data.get("kind")))
    except ValueError as e:
        return _fail(str(e))
    return jsonify({"ok": True, "job": job})


@bp.post("/api/v2ray/core/use-version")
def v2_core_use_version():
    """切换当前使用的内核版本；内核在跑会自动重启加载。"""
    data = request.get_json(silent=True) or {}
    r = v2raymgr.core_use_version(str(data.get("version") or ""), _kind(data.get("kind")))
    if r.get("error"):
        return _fail(r["error"])
    return jsonify(r)


@bp.get("/api/v2ray/core/job/<jid>/stream")
def v2_core_job_stream(jid):
    """SSE：把后台任务（探测 / 下载）的进度实时推给前端。"""
    if v2raymgr.job_get(jid) is None:
        return _fail("任务不存在或已过期", 404)

    def gen():
        last_ver = -1
        idle = 0.0
        try:
            while True:
                j = v2raymgr.job_get(jid)
                if j is None:
                    break
                if j["ver"] != last_ver:
                    last_ver = j["ver"]
                    idle = 0.0
                    yield "data: " + json.dumps(j, ensure_ascii=False) + "\n\n"
                if j.get("done"):
                    break
                time.sleep(0.2)
                idle += 0.2
                if idle >= 15:                 # 心跳，防止中间层把长连接掐断
                    idle = 0.0
                    yield ": ping\n\n"
        except GeneratorExit:                  # 前端关闭页面 / 断开 EventSource
            pass

    return Response(gen(), mimetype="text/event-stream", headers={
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
        "Connection": "keep-alive",
    })


@bp.post("/api/v2ray/core/path")
def v2_core_path():
    data = request.get_json(silent=True) or {}
    path = str(data.get("path") or "").strip()
    if path and not v2raycfg.core_version(path):
        return _fail("该路径不是可用的 Xray / V2Ray / sing-box 内核（无法执行 version）")
    # 路径按内核类型分开存：清空时要知道清的是哪一类，所以也允许显式传 kind
    kind = v2raycfg.core_kind(path) if path else _kind(data.get("kind"))
    items = {v2raymgr.core_path_key(kind): path}
    if path:
        items["core_kind"] = kind          # 手动指定后同步内核类型，生成的配置格式才对
    v2raydb.set_settings(items)
    return jsonify({"ok": True, "core": v2raymgr.core_info()})


# ---------------------------------------------------------------------------
# 节点
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# 节点测速结果持久化：存设置表 node_metrics（JSON），每次测试覆盖对应字段
# ---------------------------------------------------------------------------

_METRIC_LOCK = threading.RLock()


def _metrics() -> dict:
    try:
        m = json.loads(v2raydb.all_settings().get("node_metrics") or "{}")
        return m if isinstance(m, dict) else {}
    except ValueError:
        return {}


def _metric_save_many(items) -> None:
    """批量写测速结果：一批只读一次、只写一次库，避免逐节点反复序列化全量
    node_metrics（上千节点时这部分开销甚至比探测本身还明显）。
    读-改-写加锁，多个批量测速请求并发时也不会互相覆盖结果。"""
    items = [(str(n), k, v) for n, k, v in items]
    if not items:
        return
    with _METRIC_LOCK:
        m = _metrics()
        ts = int(time.time())
        for nid, key, val in items:
            row = m.get(nid) if isinstance(m.get(nid), dict) else {}
            row[key] = val
            row["ts"] = ts
            m[nid] = row
        v2raydb.set_setting("node_metrics", json.dumps(m, ensure_ascii=False))


def _metric_save(nid: str, key: str, val) -> None:
    _metric_save_many([(nid, key, val)])


def _metric_drop(ids) -> None:
    with _METRIC_LOCK:
        m = _metrics()
        hit = [i for i in ids if i in m]
        if not hit:
            return
        for i in hit:
            m.pop(i, None)
        v2raydb.set_setting("node_metrics", json.dumps(m, ensure_ascii=False))


@bp.get("/api/v2ray/nodes")
def v2_nodes():
    sub_id = request.args.get("sub_id")
    nodes = v2raydb.list_nodes(sub_id) if sub_id is not None else v2raydb.list_nodes()
    # 列表里不重复回传完整参数，只给界面展示需要的字段
    out = [{"id": n.get("id"), "sub_id": n.get("sub_id"), "name": n.get("name"),
            "proto": n.get("proto"), "server": n.get("server"), "port": n.get("port"),
            "remark": n.get("remark"), "grp": n.get("grp"), "raw": n.get("raw")} for n in nodes]
    return jsonify({"nodes": out, "total": len(out), "metrics": _metrics(),
                    "groups": v2raydb.get_custom_grps()})


@bp.post("/api/v2ray/nodes/add")
def v2_nodes_add():
    data = request.get_json(silent=True) or {}
    sub_id = str(data.get("sub_id") or "")
    grp = str(data.get("grp") or "").strip()      # 当前打开的是自定义分组 tab 时，新节点直接归组
    links = data.get("links")
    if isinstance(links, str):
        links = [x.strip() for x in links.replace("\r", "\n").split("\n") if x.strip()]
    parsed, errors = [], []
    for ln in (links or []):
        # 条目两种形态：纯字符串链接，或备份导入的 {link, grp?, remark?, name?} 对象
        item = ln if isinstance(ln, dict) else {"link": ln}
        link = str(item.get("link") or "").strip()
        if not link:
            continue
        try:
            node = v2raycfg.parse_share_link(link)
        except ValueError as e:
            errors.append("%s…：%s" % (link[:40], e))
            continue
        if str(item.get("grp") or "").strip():
            node["__grp"] = str(item["grp"]).strip()   # 条目自带分组（备份导入），入库时按组分桶
        if str(item.get("remark") or "").strip():
            node["remark"] = str(item["remark"]).strip()
        if str(item.get("name") or "").strip():
            node["name"] = str(item["name"]).strip()
        parsed.append(node)
    form = data.get("node")
    if isinstance(form, dict) and (form.get("server") or form.get("proto")):
        try:
            parsed.append(_build_from_form(form))
        except ValueError as e:
            errors.append("手填节点：%s" % e)
    if not parsed:
        return _fail(errors[0] if errors else "没有可添加的节点")
    # 条目自带分组的按组分桶入库；没带的走统一 grp（当前 tab）
    buckets = {}
    for node in parsed:
        buckets.setdefault(node.pop("__grp", "") or grp, []).append(node)
    n = sum(v2raydb.add_nodes(items, sub_id=sub_id, grp=g) for g, items in buckets.items())
    return jsonify({"ok": True, "added": n, "errors": errors})


@bp.post("/api/v2ray/groups/save")
def v2_groups_save():
    """新建自定义分组（空分组也保存，节点列表 tab 上常驻显示）。"""
    data = request.get_json(silent=True) or {}
    name = str(data.get("name") or "").strip()
    if not name:
        return _fail("分组名不能为空")
    if len(name) > 40:
        return _fail("分组名过长（最多 40 字）")
    grps = v2raydb.get_custom_grps()
    if name not in grps:
        grps.append(name)
        v2raydb.save_custom_grps(grps)
    return jsonify({"ok": True, "groups": grps})


@bp.post("/api/v2ray/groups/delete")
def v2_groups_delete():
    """删除自定义分组：清掉持久化记录，并把还挂在该分组下的节点 grp 一并清空。"""
    data = request.get_json(silent=True) or {}
    name = str(data.get("name") or "").strip()
    if not name:
        return _fail("分组名不能为空")
    grps = [g for g in v2raydb.get_custom_grps() if g != name]
    v2raydb.save_custom_grps(grps)
    moved = v2raydb.clear_grp(name)
    return jsonify({"ok": True, "groups": grps, "moved": moved})


def _build_from_form(f: dict) -> dict:
    """把界面表单拼成一条分享链接再复用统一解析（保证与订阅节点同构）。"""
    proto = str(f.get("proto") or "vmess").lower()
    server = str(f.get("server") or "").strip()
    port = _int(f.get("port"))
    if not server or not port:
        raise ValueError("缺少服务器地址或端口")
    name = str(f.get("name") or "").strip()
    net = str(f.get("net") or "tcp").lower()
    tls = str(f.get("tls") or "none").lower()
    host = str(f.get("host") or "").strip()
    path = str(f.get("path") or "").strip()
    sni = str(f.get("sni") or "").strip()
    if proto == "vmess":
        j = {"v": "2", "ps": name, "add": server, "port": str(port),
             "id": str(f.get("uuid") or "").strip(), "aid": str(_int(f.get("aid"))),
             "scy": str(f.get("scy") or "auto"), "net": net, "type": "none",
             "host": host, "path": path, "tls": "tls" if tls == "tls" else "none", "sni": sni}
        if not j["id"]:
            raise ValueError("缺少 uuid")
        import base64
        link = "vmess://" + base64.b64encode(json.dumps(j, ensure_ascii=False).encode()).decode()
    elif proto in ("vless", "trojan"):
        query = {"type": net, "security": tls}
        for k, v in (("sni", sni), ("host", host), ("path", path),
                     ("fp", str(f.get("fp") or "").strip()),
                     ("pin", str(f.get("pin") or "").strip()),
                     ("pbk", str(f.get("pbk") or "").strip()),
                     ("sid", str(f.get("sid") or "").strip()),
                     ("spx", str(f.get("spx") or "").strip())):
            if v:
                query[k] = v
        if tls == "reality" and proto == "vless" and not query.get("fp"):
            query["fp"] = "chrome"       # REALITY 必须有客户端指纹，默认 chrome
        if proto == "vless":
            if not str(f.get("uuid") or "").strip():
                raise ValueError("缺少 uuid")
            cred = str(f.get("uuid")).strip()
            if f.get("flow"):
                query["flow"] = str(f["flow"])
        else:
            if not str(f.get("password") or ""):
                raise ValueError("缺少密码")
            cred = urllib.parse.quote(str(f["password"]), safe="")
        link = "%s://%s@%s:%s?%s#%s" % (proto, cred, server, port,
                                        urllib.parse.urlencode(query),
                                        urllib.parse.quote(name, safe=""))
    elif proto == "ss":
        import base64
        if not str(f.get("method") or "") or not str(f.get("password") or ""):
            raise ValueError("缺少加密方式或密码")
        cred = base64.b64encode(("%s:%s" % (f["method"], f["password"])).encode()).decode()
        link = "ss://%s@%s:%s#%s" % (cred.replace("=", ""), server, port,
                                     urllib.parse.quote(name, safe=""))
    else:
        raise ValueError("不支持的协议：%s" % proto)
    return v2raycfg.parse_share_link(link)


@bp.post("/api/v2ray/nodes/update")
def v2_nodes_update():
    data = request.get_json(silent=True) or {}
    nid = str(data.get("id") or "")
    if not nid or not v2raydb.get_node(nid):
        return _fail("节点不存在", 404)
    fields = data.get("fields") if isinstance(data.get("fields"), dict) else None
    node = v2raydb.update_node(nid, name=data.get("name"), remark=data.get("remark"),
                               server=data.get("server"), port=data.get("port"),
                               fields=fields, grp=data.get("grp"))
    return jsonify({"ok": True, "node": node})


@bp.post("/api/v2ray/nodes/delete")
def v2_nodes_delete():
    """软删除节点（进回收站，可恢复）。流量统计保留，恢复后不丢。"""
    data = request.get_json(silent=True) or {}
    ids = data.get("ids") or ([data["id"]] if data.get("id") else [])
    n = v2raydb.delete_nodes(ids)
    return jsonify({"ok": True, "deleted": n})


@bp.post("/api/v2ray/nodes/trash")
def v2_nodes_trash():
    """回收站列表（软删除的节点）。"""
    items = v2raydb.trash_nodes()
    return jsonify({"ok": True, "items": items, "count": len(items)})


@bp.post("/api/v2ray/nodes/restore")
def v2_nodes_restore():
    """从回收站恢复节点 {ids:[...]}。"""
    data = request.get_json(silent=True) or {}
    n = v2raydb.restore_nodes(data.get("ids") or [])
    return jsonify({"ok": True, "restored": n})


@bp.post("/api/v2ray/nodes/purge")
def v2_nodes_purge():
    """彻底删除（真删库）{ids?}：不传 ids = 清空整个回收站。"""
    data = request.get_json(silent=True) or {}
    ids = [str(x) for x in (data.get("ids") or []) if x]
    if not ids:
        ids = [str(n["id"]) for n in v2raydb.trash_nodes()]     # 清空：先取全部回收站 id
    n = v2raydb.purge_nodes(ids or None)
    if ids:
        _metric_drop(ids)                                       # 彻底删除才清流量统计
    return jsonify({"ok": True, "deleted": n})


@bp.post("/api/v2ray/nodes/batch-grp")
def v2_nodes_batch_grp():
    """批量移动到分组 {ids:[...], grp}：grp 为空串 = 移出分组（回到「全部」）。"""
    data = request.get_json(silent=True) or {}
    ids = [str(x) for x in (data.get("ids") or []) if x]
    grp = str(data.get("grp") or "").strip()
    if not ids:
        return _fail("没有选择节点")
    n = 0
    for nid in ids:
        if v2raydb.get_node(nid):
            v2raydb.update_node(nid, grp=grp)
            n += 1
    return jsonify({"ok": True, "updated": n})


def _node_dupe_key(n: dict) -> tuple:
    """节点唯一性键：(proto, server, port, 凭据, 传输参数)。凭据取节点参数里的
    uuid（vmess/vless）或 method+password（trojan/ss），缺了算空串——
    同协议同地址同端口同凭据且传输 / 伪装参数一致才视为同一个节点；
    参数不同（如 ws 路径不同）是两条不同配置，不算重复。"""
    proto = str(n.get("proto") or "").lower()
    cred = str(n.get("uuid") or n.get("password") or "")
    if proto == "ss":
        cred = "%s:%s" % (n.get("method") or "", n.get("password") or "")
    params = (str(n.get("net") or ""), str(n.get("path") or ""), str(n.get("host") or ""),
              str(n.get("sni") or ""), str(n.get("tls") or n.get("security") or ""))
    return (proto, str(n.get("server") or "").strip().lower(),
            _int(n.get("port")), cred) + params


@bp.post("/api/v2ray/nodes/dedupe")
def v2_nodes_dedupe():
    """重复节点检测 / 一键清理 {apply: bool}。

    apply=false 只统计（dry-run），apply=true 把重复项软删除进回收站。
    每组保留一个：当前已连接的优先，否则保留最早创建的。
    """
    data = request.get_json(silent=True) or {}
    active_id = str(v2raydb.all_settings().get("active_node") or "")
    groups = {}
    for n in v2raydb.list_nodes():
        groups.setdefault(_node_dupe_key(n), []).append(n)
    remove_ids, remove_names, keep_names = [], [], []
    for rows in groups.values():
        if len(rows) < 2:
            continue
        # 已连接的排最前，再按创建时间旧→新：留下的就是列表第一个
        rows.sort(key=lambda x: (x.get("id") != active_id,
                                 float(x.get("created_at") or 0)))
        keep = rows[0]
        keep_names.append("%s（保留）" % (keep.get("name") or keep.get("id")))
        for extra in rows[1:]:
            remove_ids.append(str(extra["id"]))
            remove_names.append("%s（与「%s」重复）" % (extra.get("name") or extra.get("id"),
                                                       keep.get("name") or keep.get("id")))
    if not data.get("apply"):
        return jsonify({"ok": True, "dup_groups": len(remove_ids),
                        "remove_ids": remove_ids, "remove_names": remove_names[:20],
                        "keep_names": keep_names[:10]})
    n = v2raydb.delete_nodes(remove_ids) if remove_ids else 0
    return jsonify({"ok": True, "deleted": n, "remove_ids": remove_ids,
                    "dup_groups": len(remove_ids)})


@bp.post("/api/v2ray/nodes/export")
def v2_nodes_export():
    """节点导出 {ids?: [...], format: "txt"|"json"}。

    txt = 分享链接一行一条（可直接再导入）；json = 备份（含分组 / 备注，
    用 /nodes/add 的对象数组 links 导回可还原分组）。ids 省略 = 全部节点。
    """
    data = request.get_json(silent=True) or {}
    fmt = str(data.get("format") or "txt").lower()
    want = {str(x) for x in (data.get("ids") or []) if x}
    nodes = [n for n in v2raydb.list_nodes() if not want or n.get("id") in want]
    if not nodes:
        return _fail("没有可导出的节点")
    stamp = time.strftime("%Y%m%d_%H%M")
    if fmt == "json":
        items = []
        for n in nodes:
            try:
                link = v2raycfg.node_to_share(n)
            except Exception:                  # noqa: BLE001
                link = ""
            if not link:
                continue
            items.append({"link": link, "name": n.get("name") or "", "proto": n.get("proto") or "",
                          "server": n.get("server") or "", "port": n.get("port"),
                          "grp": n.get("grp") or "", "remark": n.get("remark") or ""})
        if not items:
            return _fail("没有可导出的节点（无法生成分享链接）")
        payload = json.dumps({"kind": "file-flask-v2ray-backup", "exported_at": int(time.time()),
                              "count": len(items), "nodes": items},
                             ensure_ascii=False, indent=1)
        name = "v2ray_backup_%s.json" % stamp
        buf = io.BytesIO(payload.encode("utf-8"))
        return send_file(buf, as_attachment=True, download_name=name,
                         mimetype="application/json")
    lines = []
    for n in nodes:
        try:
            link = v2raycfg.node_to_share(n)
        except Exception:                      # noqa: BLE001
            link = ""
        if link:
            lines.append(link)
    if not lines:
        return _fail("没有可导出的节点（无法生成分享链接）")
    name = "v2ray_nodes_%s.txt" % stamp
    buf = io.BytesIO("\n".join(lines).encode("utf-8"))
    return send_file(buf, as_attachment=True, download_name=name, mimetype="text/plain")


# ---------------------------------------------------------------------------
# 订阅
# ---------------------------------------------------------------------------

@bp.get("/api/v2ray/subs")
def v2_subs():
    return jsonify({"subs": v2raydb.list_subs()})


@bp.post("/api/v2ray/subs/save")
def v2_subs_save():
    data = request.get_json(silent=True) or {}
    url = str(data.get("url") or "").strip()
    if not url:
        return _fail("订阅地址不能为空")
    if not url.lower().startswith(("http://", "https://")):
        return _fail("订阅地址需以 http:// 或 https:// 开头")
    sub = v2raydb.save_sub(str(data.get("id") or ""), str(data.get("name") or "").strip() or "订阅",
                           url, proxy=str(data.get("proxy") or "").strip(),
                           enabled=bool(data.get("enabled", True)))
    return jsonify({"ok": True, "sub": sub})


@bp.post("/api/v2ray/subs/delete")
def v2_subs_delete():
    data = request.get_json(silent=True) or {}
    sid = str(data.get("id") or "")
    if not sid or not v2raydb.get_sub(sid):
        return _fail("订阅不存在", 404)
    if not bool(data.get("confirm")):
        return _fail("删除订阅会同时删除其下所有节点，请确认后再试")
    v2raydb.delete_sub(sid)
    return jsonify({"ok": True})


@bp.post("/api/v2ray/subs/refresh")
def v2_subs_refresh():
    data = request.get_json(silent=True) or {}
    sid = str(data.get("id") or "")
    subs = [v2raydb.get_sub(sid)] if sid else v2raydb.list_subs()
    subs = [s for s in subs if s]
    if not subs:
        return _fail("没有可刷新的订阅", 404)
    results = []
    for s in subs:
        if not s.get("enabled") and sid:
            results.append({"id": s["id"], "name": s["name"], "ok": False, "error": "订阅已停用"})
            continue
        r = v2raymgr.fetch_and_store(s)
        r.update({"id": s["id"], "name": s["name"]})
        results.append(r)
    return jsonify({"ok": True, "results": results,
                    "total": sum(x.get("count") or 0 for x in results)})


# ---------------------------------------------------------------------------
# 设置 / 连接 / 日志 / 测试
# ---------------------------------------------------------------------------

@bp.get("/api/v2ray/settings")
def v2_settings_get():
    st = v2raydb.all_settings()
    st.pop("socks_pass", None)
    st["has_pass"] = bool(secret.decrypt(v2raydb.all_settings().get("socks_pass")))
    return jsonify(st)


@bp.post("/api/v2ray/get-pass")
def v2_get_pass():
    """取回已保存的 SOCKS5 密码明文（供设置页显示 / 复制，仅本机管理界面使用）。"""
    pwd = secret.decrypt(v2raydb.all_settings().get("socks_pass"))
    return jsonify({"ok": True, "socks_pass": pwd})


@bp.post("/api/v2ray/gen-auth")
def v2_gen_auth():
    """0.0.0.0 模式：界面选择监听地址时立即生成 SOCKS5 账号密码（明文返回一次供回填）。"""
    r = v2raymgr.gen_lan_auth()
    return jsonify({"ok": True, "socks_user": r["socks_user"], "socks_pass": r["socks_pass"]})


@bp.post("/api/v2ray/settings")
def v2_settings_save():
    data = request.get_json(silent=True) or {}
    kind = _kind(data.get("core_kind"))      # 路径要按当前内核类型分开落库
    items = {}
    for k in _SETTING_KEYS:
        if k not in data:
            continue
        if k == "socks_port":
            p = _int(data.get(k))
            if not (1 <= p <= 65535):
                return _fail("SOCKS5 端口需在 1-65535 之间")
            items[k] = p
        elif k == "http_port":
            p = _int(data.get(k))
            if p and not (1 <= p <= 65535):
                return _fail("HTTP 端口需在 1-65535 之间（0 = 不开启）")
            items[k] = p
        elif k == "api_port":
            p = _int(data.get(k))
            if p and not (1 <= p <= 65535):
                return _fail("统计 API 端口需在 1-65535 之间（0 = 关闭统计）")
            items[k] = p
        elif k == "socks_listen":
            v = str(data.get(k) or "").strip()
            if v not in _LISTEN_CHOICES:
                return _fail("监听地址只能是 0.0.0.0（供局域网使用）或 127.0.0.1（仅本机）")
            items[k] = v
        elif k == "auto_start":
            items[k] = 1 if data.get(k) else 0
        elif k == "auth_enabled":
            items[k] = 1 if data.get(k) else 0
        elif k == "route_mode":
            v = str(data.get(k) or "").strip().lower()
            if v not in ("global", "rule", "direct"):
                return _fail("路由模式只能是 全局代理 / 智能分流 / 全局直连")
            items[k] = v
        elif k == "bypass_cn":
            items[k] = 1 if data.get(k) else 0
        elif k == "core_kind":
            items[k] = kind
        elif k == "core_path":
            # Xray 与 sing-box 各存一份，切 Tab 后互不覆盖
            items[v2raymgr.core_path_key(kind)] = str(data.get(k) or "").strip()
        else:
            items[k] = str(data.get(k) or "").strip()
    # 入站密码：传输层先 unwrap，再加密落库；留空 = 保留原值，clear_pass=1 = 清空
    if data.get("clear_pass"):
        items["socks_pass"] = ""
    else:
        pw = transport.unwrap(data.get("socks_pass"))
        if pw:
            items["socks_pass"] = secret.encrypt(pw)
    if items.get("socks_user") and "socks_pass" not in items and not data.get("clear_pass"):
        cur = secret.decrypt(v2raydb.all_settings().get("socks_pass"))
        if not cur:
            return _fail("已设置用户名，请同时填写密码（或清空用户名）")
    if items:
        v2raydb.set_settings(items)
    # 端口互斥：HTTP 入站不能与 SOCKS5 入站 / 统计 API 端口撞车
    eff = dict(v2raydb.all_settings())
    eff.update(items)
    hp = _int(eff.get("http_port") or 0)
    if hp:
        if hp == _int(eff.get("socks_port") or 10808):
            return _fail("HTTP 代理端口不能与 SOCKS5 端口相同")
        if hp == _int(eff.get("api_port") or 0):
            return _fail("HTTP 代理端口不能与统计 API 端口相同")
    # 落库后兜底：0.0.0.0 监听强制启用认证并确保有凭据（下次连接也会再校验一次）
    if str(items.get("socks_listen") or v2raydb.all_settings().get("socks_listen") or "") == "0.0.0.0":
        if "auth_enabled" in items and not items["auth_enabled"]:
            v2raydb.set_setting("auth_enabled", 1)
            items["auth_enabled"] = 1
        v2raymgr.gen_lan_auth()
    st = v2raydb.all_settings()
    st.pop("socks_pass", None)
    st["has_pass"] = bool(secret.decrypt(v2raydb.all_settings().get("socks_pass")))
    return jsonify({"ok": True, "settings": st, "status": v2raymgr.status()})


@bp.post("/api/v2ray/connect")
def v2_connect():
    data = request.get_json(silent=True) or {}
    nid = str(data.get("id") or "")
    if not nid:
        return _fail("请先选择要连接的节点")
    r = v2raymgr.start(nid)
    if r.get("error"):
        v2raymgr._conn_log("fail", "手动连接失败：%s（%s）"
                           % ((v2raydb.get_node(nid) or {}).get("name") or nid, r["error"]))
        return _fail(r["error"], 500)
    return jsonify(r)


@bp.post("/api/v2ray/disconnect")
def v2_disconnect():
    v2raymgr._conn_log("disconnect", "手动断开连接")
    return jsonify(v2raymgr.stop())


@bp.post("/api/v2ray/restart")
def v2_restart():
    r = v2raymgr.restart()
    if r.get("error"):
        return _fail(r["error"], 500)
    return jsonify(r)


@bp.get("/api/v2ray/log")
def v2_log():
    return jsonify({"log": v2raymgr.log_tail(_int(request.args.get("lines"), 200))})


@bp.get("/api/v2ray/conn_log")
def v2_conn_log():
    """节点连接情况日志（手动连接 / 自动切换 / 验证 / 回收站），最新在前。"""
    return jsonify({"events": v2raymgr.conn_events(_int(request.args.get("lines"), 200))})


@bp.post("/api/v2ray/log/clear")
def v2_log_clear():
    v2raymgr.clear_log()
    return jsonify({"ok": True})


@bp.post("/api/v2ray/conn_log/clear")
def v2_conn_log_clear():
    """清空节点连接记录。"""
    v2raymgr.clear_conn_log()
    return jsonify({"ok": True})


@bp.post("/api/v2ray/preview")
def v2_preview():
    """预览某节点生成的运行配置（不含入站密码明文），便于排查。"""
    data = request.get_json(silent=True) or {}
    node = v2raydb.get_node(str(data.get("id") or ""))
    if not node:
        return _fail("节点不存在", 404)
    st = v2raydb.all_settings()
    opts = dict(st)
    opts["socks_pass"] = ""            # 预览里不回显密码
    # 预览按真正会被使用的内核生成配置（Xray / sing-box 两种格式不同）
    opts["core_path"] = v2raymgr.pick_core(st)
    try:
        cfg = v2raycfg.build_config(node, opts)
    except ValueError as e:
        return _fail(str(e))
    return jsonify({"config": cfg, "json": json.dumps(cfg, ensure_ascii=False, indent=2)})


def _tcp_ping(host: str, port: int):
    """TCP 握手测一次延迟；返回 (ms, 错误信息)，成功时 ms>=0。"""
    t0 = time.time()
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(5)
    try:
        s.connect((host, port))
        return int((time.time() - t0) * 1000), ""
    except (socket.timeout, TimeoutError):
        return -1, "连接超时（5 秒）"
    except OSError as e:
        return -1, proxyutil.friendly_error(e, host)
    finally:
        s.close()


@bp.post("/api/v2ray/auto-failover")
def v2_auto_failover():
    """开启 / 关闭「节点失效自动切换」：状态落库，并由后端看门狗线程（与网页无关）执行。"""
    data = request.get_json(silent=True) or {}
    return jsonify(v2raymgr.set_auto_failover(bool(data.get("on"))))


@bp.post("/api/v2ray/speedtest/config")
def v2_speedtest_config():
    """保存「定时测速 + 自动选最快」配置：{on, interval(分钟), pick, dl}。"""
    data = request.get_json(silent=True) or {}
    return jsonify(v2raymgr.set_speedtest(
        bool(data.get("on")), _int(data.get("interval"), 30),
        bool(data.get("pick")), bool(data.get("dl"))))


@bp.post("/api/v2ray/speedtest/run")
def v2_speedtest_run():
    """立即触发一轮定时测速（后台异步执行，结果看连接日志 / 节点列表刷新）。"""
    return jsonify(v2raymgr.run_speedtest_now())


@bp.post("/api/v2ray/ping")
def v2_ping():
    """节点延迟测试。
    - 普通模式（real 不为真）：TCP 握手，只测 server:port 可达（快，批量测速用）。
      缺点：端口通 ≠ 节点可用（账号过期 / 被墙也会返回延迟）。
    - 真延迟模式（real=true）：临时把内核切到该节点，经 socks 出口请求探测地址，
      真的能出网才返回延迟；出不去一律判「不可用」并持久化 -1。"""
    data = request.get_json(silent=True) or {}
    nid = str(data.get("id") or "")
    node = v2raydb.get_node(nid)
    if not node:
        return _fail("节点不存在", 404)

    if not data.get("real"):
        host, port = node.get("server"), _int(node.get("port"))
        if not host or not port:
            return _fail("节点缺少地址或端口")
        ms, err = _tcp_ping(host, port)
        _metric_save(nid, "ping", ms)          # 持久化：-1 表示超时
        if err:
            return jsonify({"ok": False, "error": err})
        return jsonify({"ok": True, "ms": ms})

    # ---- 真延迟：临时切换节点 → 经代理探测 204 地址 ----
    probe = "http://www.gstatic.com/generate_204"
    st0 = v2raymgr.status()
    was_running = bool(st0.get("running"))
    prev_id = ((st0.get("node") or {}) or {}).get("id") if was_running else None
    try:
        if (not was_running) or (prev_id != nid):
            r = v2raymgr.start(nid, auto_probe=False)   # 下面马上自己探测并落台账
            if r.get("error"):
                return _fail("启动该节点失败：" + r["error"])
        st = v2raymgr.status()
        inb = st.get("inbound") or {}
        port = int(inb.get("socks_port") or 10808)
        user = str(v2raydb.all_settings().get("socks_user") or "").strip()
        pwd = secret.decrypt(v2raydb.all_settings().get("socks_pass"))
        proxy = "socks5://%s127.0.0.1:%d" % (("%s:%s@" % (user, pwd)) if user else "", port)
        opener = proxyutil.build_opener(proxy=proxy)
        req = urllib.request.Request(probe, headers={"User-Agent": "FileFlask-V2Ray/1.0"})
        t0 = time.time()
        with opener.open(req, timeout=12) as resp:
            resp.read(64)
        ms = int((time.time() - t0) * 1000)
        _metric_save(nid, "ping", ms)
        return jsonify({"ok": True, "ms": ms, "real": True})
    except urllib.error.HTTPError as e:
        _metric_save(nid, "ping", -1)
        return jsonify({"ok": False, "error": proxyutil.http_status_text(e.code)})
    except Exception as e:                      # noqa: BLE001
        _metric_save(nid, "ping", -1)
        return jsonify({"ok": False, "error": proxyutil.friendly_error(e, probe)})
    finally:
        if not was_running:
            v2raymgr.stop()
        elif prev_id and prev_id != nid:
            v2raymgr.stop()
            v2raymgr.start(prev_id, auto_probe=False)   # 测速后恢复原节点，无需再探测


@bp.post("/api/v2ray/ping-batch")
def v2_ping_batch():
    """批量并发测速：一次 HTTP 请求并发对多个节点做 TCP 握手 / 真延迟探测。
    前端分批调用（每批 ≤ 500 个）；整批结果一次性落库，
    避免逐节点反复读写全量 node_metrics（上千节点时开销很明显）。"""
    from concurrent.futures import ThreadPoolExecutor, as_completed
    data = request.get_json(silent=True) or {}
    ids = data.get("ids") or []
    if not isinstance(ids, list) or not ids:
        return _fail("ids 不能为空")
    ids = [str(x) for x in ids[:500]]

    def collect(max_workers, probe):
        results, saves = {}, []
        with ThreadPoolExecutor(max_workers=max_workers) as ex:
            futs = {ex.submit(probe, nid): nid for nid in ids}
            for fut in as_completed(futs):
                nid = futs[fut]
                try:
                    res = fut.result()
                except Exception as e:              # 单个节点异常不影响整批结果
                    res = {"ok": False, "error": str(e)}
                results[nid] = res
                saves.append((nid, "ping", res["ms"] if res.get("ok") else -1))
        _metric_save_many(saves)
        return results

    if data.get("real"):
        # 真延迟：每节点起临时独立内核实例实测出网（端口分配有锁，不碰主实例）。
        # 并发 8 路（原 6 路），配合前端批次并发，缩短大列表整体耗时；
        # 探测地址、超时 6s、可用性判定都保持原样。
        results = collect(8, lambda nid: v2raymgr.real_ping(nid, timeout=6))
        return jsonify({"ok": True, "results": results})

    def ping_one(nid):
        node = v2raydb.get_node(nid)
        if not node:
            return {"ok": False, "error": "节点不存在"}
        host, port = node.get("server"), _int(node.get("port"))
        if not host or not port:
            return {"ok": False, "error": "节点缺少地址或端口"}
        ms, err = _tcp_ping(host, port)
        return {"ok": True, "ms": ms} if not err else {"ok": False, "error": err}

    results = collect(40, ping_one)
    return jsonify({"ok": True, "results": results})


def _node_share_link(node: dict) -> str:
    """把存储的节点还原成分享链接（复制节点用）。"""
    import base64
    proto = (node.get("proto") or "").lower()
    host, port = node.get("server"), _int(node.get("port"))
    name = urllib.parse.quote(str(node.get("name") or host or ""), safe="")
    net = (node.get("net") or "tcp").lower()
    tls = (node.get("tls") or "none").lower()
    if proto == "vmess":
        j = {"v": "2", "ps": str(node.get("name") or ""), "add": str(host), "port": str(port),
             "id": str(node.get("uuid") or ""), "aid": str(_int(node.get("aid"))),
             "scy": str(node.get("scy") or "auto"), "net": net, "type": "none",
             "host": str(node.get("host") or ""), "path": str(node.get("path") or ""),
             "tls": "tls" if tls in ("tls", "reality") else "none", "sni": str(node.get("sni") or "")}
        return "vmess://" + base64.b64encode(json.dumps(j, ensure_ascii=False).encode()).decode()
    if proto == "ss":
        cred = base64.b64encode(("%s:%s" % (node.get("method") or "",
                                            node.get("password") or "")).encode()).decode()
        return "ss://%s@%s:%s#%s" % (cred.replace("=", ""), host, port, name)
    if proto in ("vless", "trojan"):
        q = [("type", net), ("security", tls)]
        for k in ("sni", "host", "path"):
            if str(node.get(k) or ""):
                q.append((k, str(node[k])))
        cred = urllib.parse.quote(str(node.get("uuid") or node.get("password") or ""), safe="")
        return "%s://%s@%s:%s?%s#%s" % (proto, cred, host, port,
                                        urllib.parse.urlencode(q), name)
    raise ValueError("该节点类型不支持生成分享链接")


@bp.post("/api/v2ray/share-link")
def v2_share_link():
    """返回某节点的分享链接（复制节点用）。"""
    data = request.get_json(silent=True) or {}
    node = v2raydb.get_node(str(data.get("id") or ""))
    if not node:
        return _fail("节点不存在", 404)
    try:
        return jsonify({"ok": True, "link": _node_share_link(node)})
    except ValueError as e:
        return _fail(str(e))


_DL_URLS = [   # 测速文件源，依次回退（首个被限流/失败时换下一个）
    "https://speed.cloudflare.com/__down?bytes=25000000",
    "https://proof.ovh.net/files/10Mb.dat",
    "https://proof.ovh.net/files/100Mb.dat",
]


@bp.post("/api/v2ray/dl-test")
def v2_dl_test():
    """下载测速：经指定节点的 socks 代理拉测速文件，返回 Mbps。
    未连接或连着别的节点时，会临时切到该节点测速，测完恢复原先状态。"""
    import subprocess
    data = request.get_json(silent=True) or {}
    nid = str(data.get("id") or "")
    if not v2raydb.get_node(nid):
        return _fail("节点不存在", 404)

    def measure(port, url):
        """拉取测速文件，返回 (mbps, None) 或 (None, 错误信息)。"""
        try:
            p = subprocess.run(
                ["curl", "-x", "socks5h://127.0.0.1:%d" % port, "-sS", "-L", "-o", "/dev/null",
                 "-w", "%{speed_download} %{http_code}", "--max-time", "20", url],
                capture_output=True, text=True, timeout=25)
        except FileNotFoundError:
            return None, "系统缺少 curl，无法下载测速"
        except subprocess.TimeoutExpired:
            return None, "测速超时"
        out = (p.stdout or "").strip().split()
        if p.returncode != 0 or not out:
            return None, (p.stderr or "").strip()[:120] or "curl 退出码 %s" % p.returncode
        try:
            speed = float(out[0])
        except ValueError:
            return None, "无法解析测速结果"
        code = out[1] if len(out) > 1 else ""
        if not code.startswith("2"):
            return None, "HTTP " + code
        return round(speed * 8 / 1e6, 2), None

    st0 = v2raymgr.status()
    was_running = bool(st0.get("running"))
    prev_id = ((st0.get("node") or {}) or {}).get("id") if was_running else None
    port = int((st0.get("inbound") or {}).get("socks_port") or 10808)
    try:
        if (not was_running) or (prev_id != nid):
            r = v2raymgr.start(nid, auto_probe=False)   # 测速流程自测，无需再探测
            if r.get("error"):
                return _fail("启动该节点失败：" + r["error"])
            port = int((v2raymgr.status().get("inbound") or {}).get("socks_port") or port)
        errs = []
        for url in _DL_URLS:
            mbps, err = measure(port, url)
            if err is None:
                _metric_save(nid, "dl", mbps)         # 持久化：覆盖上次下载速度
                return jsonify({"ok": True, "mbps": mbps})
            errs.append(url.split("//", 1)[1].split("/", 1)[0] + "：" + err)
        return _fail("测速失败（所有测速源均不可用）：" + "；".join(errs[:3]))
    finally:
        if not was_running:
            v2raymgr.stop()
        elif prev_id and prev_id != nid:
            v2raymgr.stop()
            v2raymgr.start(prev_id, auto_probe=False)   # 测速后恢复原节点，无需再探测


@bp.post("/api/v2ray/dl-temp")
def v2_dl_temp():
    """单节点下载测速（临时独立内核实例，不切换 / 不中断当前连接）。"""
    data = request.get_json(silent=True) or {}
    nid = str(data.get("id") or "")
    if not v2raydb.get_node(nid):
        return _fail("节点不存在", 404)
    r = v2raymgr.real_dl(nid, _DL_URLS)
    if r.get("ok"):
        _metric_save(nid, "dl", r["mbps"])          # 持久化：覆盖上次下载速度
    return jsonify(r)


@bp.post("/api/v2ray/exit-test")
def v2_exit_test():
    """通过本机代理出口访问探测地址，返回出口 IP + 归属地 / ISP（验证 10808 真的能用）。"""
    st = v2raymgr.status()
    if not st.get("running"):
        return _fail("代理尚未连接，请先连接一个节点")
    inb = st["inbound"]
    user = str(v2raydb.all_settings().get("socks_user") or "").strip()
    pwd = secret.decrypt(v2raydb.all_settings().get("socks_pass"))
    proxy = "socks5://%s127.0.0.1:%s" % (("%s:%s@" % (user, pwd)) if user else "", inb["socks_port"])
    try:
        opener = proxyutil.build_opener(proxy=proxy, follow_redirects=True)
        req = urllib.request.Request("http://api.ipify.org/?format=text",
                                     headers={"User-Agent": "FileFlask-V2Ray/1.0"})
        with opener.open(req, timeout=20) as resp:
            ip = resp.read(128).decode("utf-8", "replace").strip()
    except urllib.error.HTTPError as e:
        return jsonify({"ok": False, "error": proxyutil.http_status_text(e.code)})
    except Exception as e:                      # noqa: BLE001
        return jsonify({"ok": False, "error": proxyutil.friendly_error(e, "http://api.ipify.org")})

    # 归属地 / ISP：ip-api 免费接口，失败不影响出口 IP 的展示
    geo = {}
    try:
        greq = urllib.request.Request(
            "http://ip-api.com/json/?fields=status,country,city,isp,query&lang=zh-CN",
            headers={"User-Agent": "FileFlask-V2Ray/1.0"})
        with opener.open(greq, timeout=10) as gresp:
            gj = json.loads(gresp.read(8 * 1024).decode("utf-8", "replace"))
        if isinstance(gj, dict) and gj.get("status") == "success":
            geo = {"country": str(gj.get("country") or ""), "city": str(gj.get("city") or ""),
                   "isp": str(gj.get("isp") or "")}
    except Exception:                           # noqa: BLE001
        geo = {}
    return jsonify({"ok": True, "ip": ip, "geo": geo, "via": proxy})


@bp.get("/api/v2ray/traffic")
def v2_traffic():
    """实时上下行网速 + 各节点 / 总流量统计（后台线程采样并持久化）。"""
    return jsonify(v2raymgr.traffic())


@bp.post("/api/v2ray/traffic/reset")
def v2_traffic_reset():
    """流量统计清零。"""
    return jsonify(v2raymgr.reset_traffic())


# ---------------------------------------------------------------------------
# 桌面悬浮胶囊（系统级 tkinter 进程）
# ---------------------------------------------------------------------------

def _float_auth_ok() -> bool:
    """悬浮窗接口鉴权：只允许本机 + 正确 token（不走登录会话）。"""
    if request.remote_addr not in ("127.0.0.1", "::1"):
        return False
    tok = str(request.headers.get("X-Float-Token") or "")
    good = v2rayfloat.token()
    return bool(tok) and bool(good) and secrets.compare_digest(tok, good)


def _float_payload() -> dict:
    """悬浮窗需要的精简状态：速度 / 节点 / 模式 / 节点列表。"""
    st = v2raymgr.status()
    tr = v2raymgr.traffic()
    s = st.get("settings") or {}
    nodes = [{"id": n.get("id"), "name": n.get("name") or n.get("server") or n.get("id")}
             for n in v2raydb.list_nodes()]
    return {
        "ok": True,
        "running": bool(st.get("running")),
        "pid": int(st.get("pid") or 0),
        "mode": str(s.get("route_mode") or "rule"),
        "bypass_cn": int(s.get("bypass_cn") or 0),
        "node": st.get("node") or {},
        "speed": tr.get("speed") or {"up": 0, "down": 0},
        "total": tr.get("total") or {},
        "nodes": nodes,
    }


@bp.get("/api/v2ray/float/status")
def v2_float_status():
    """桌面胶囊进程状态（前端按钮用）。"""
    return jsonify(v2rayfloat.status())


@bp.post("/api/v2ray/float/start")
def v2_float_start():
    """启动桌面悬浮胶囊。"""
    return jsonify(v2rayfloat.start())


@bp.post("/api/v2ray/float/stop")
def v2_float_stop():
    """关闭桌面悬浮胶囊。"""
    return jsonify(v2rayfloat.stop())


@bp.get("/api/v2ray/float/info")
def v2_float_info():
    """悬浮窗轮询接口（本机 token 鉴权）。"""
    if not _float_auth_ok():
        return jsonify({"ok": False, "error": "未授权"}), 403
    return jsonify(_float_payload())


@bp.post("/api/v2ray/float/action")
def v2_float_action():
    """悬浮窗操作：切换路由模式 / 节点 / 连接状态（本机 token 鉴权）。"""
    if not _float_auth_ok():
        return jsonify({"ok": False, "error": "未授权"}), 403
    data = request.get_json(silent=True) or {}
    action = str(data.get("action") or "")
    if action == "mode":
        mode = str(data.get("mode") or "").strip().lower()
        if mode not in ("global", "rule", "direct"):
            return jsonify({"ok": False, "error": "无效的路由模式"}), 400
        v2raydb.set_settings({"route_mode": mode,
                              "bypass_cn": 1 if mode == "rule" else 0})
        if (v2raymgr.status() or {}).get("running"):
            err = (v2raymgr.restart() or {}).get("error")
            if err:
                return jsonify({"ok": False, "error": err}), 400
    elif action == "node":
        nid = str(data.get("id") or "")
        if not nid:
            return jsonify({"ok": False, "error": "缺少节点 id"}), 400
        err = (v2raymgr.start(nid) or {}).get("error")
        if err:
            return jsonify({"ok": False, "error": err}), 400
    elif action == "toggle":
        if (v2raymgr.status() or {}).get("running"):
            v2raymgr.stop()
        else:
            nid = str(v2raydb.all_settings().get("active_node") or "")
            if not nid:
                nodes = v2raydb.list_nodes()
                nid = nodes[0].get("id") if nodes else ""
            if not nid:
                return jsonify({"ok": False, "error": "还没有节点，请先在主界面添加"}), 400
            err = (v2raymgr.start(nid) or {}).get("error")
            if err:
                return jsonify({"ok": False, "error": err}), 400
    else:
        return jsonify({"ok": False, "error": "未知操作"}), 400
    return jsonify(_float_payload())


# ---------------------------------------------------------------------------
# 本地服务端节点：把本机做成 v2 代理供其他设备连接（与 10808 客户端实例隔离）
# ---------------------------------------------------------------------------

@bp.get("/api/v2ray/server/status")
def v2_server_status():
    """本地服务端状态、配置、分享链接（供「本地节点」分区展示）。"""
    return jsonify(v2ray_server.status())


@bp.post("/api/v2ray/server/start")
def v2_server_start():
    r = v2ray_server.start()
    if r.get("error"):
        return _fail(r["error"], 500)
    return jsonify(r)


@bp.post("/api/v2ray/server/stop")
def v2_server_stop():
    return jsonify(v2ray_server.stop())


@bp.post("/api/v2ray/server/save")
def v2_server_save():
    r = v2ray_server.save_config(request.get_json(silent=True) or {})
    if r.get("error"):
        return _fail(r["error"])
    return jsonify(r)


@bp.post("/api/v2ray/server/new-uuid")
def v2_server_new_uuid():
    """换一个新的客户端 UUID（旧分享链接随即失效）。"""
    return jsonify(v2ray_server.new_uuid())


@bp.post("/api/v2ray/server/gen-reality-keys")
def v2_server_gen_reality_keys():
    """生成一对 REALITY 密钥；可选 save=1 直接写入服务端私钥。"""
    r = v2ray_server.gen_reality_keys()
    if r.get("error"):
        return _fail(r["error"], 500)
    if request.get_json(silent=True) and request.get_json(silent=True).get("save"):
        v2ray_server.save_config({"privatekey": r["privateKey"], "security": "reality"})
    return jsonify(r)


@bp.get("/api/v2ray/server/log")
def v2_server_log():
    """本地服务端运行日志末尾若干行（前端「服务端日志」刷新按钮）。"""
    lines = _int(request.args.get("lines"), 60)
    return jsonify({"ok": True, "log": v2ray_server.log_tail(lines)})


@bp.post("/api/v2ray/server/log/clear")
def v2_server_log_clear():
    """清空本地服务端运行日志。"""
    v2ray_server.clear_log()
    return jsonify({"ok": True})


@bp.get("/api/v2ray/server/preview")
def v2_server_preview():
    """预览将写入内核的配置（排障用）。?id= 指定本地节点。"""
    sid = str(request.args.get("id") or "")
    if sid:
        row = v2raydb.get_local_server(sid)
        if not row:
            return _fail("节点不存在")
        return jsonify({"ok": True, "config": v2ray_server.build_config(
            v2ray_server._row_to_cfg(row))})
    return jsonify(v2ray_server.preview_config())


# --- 多节点管理 ---
@bp.get("/api/v2ray/server/nodes")
def v2_server_nodes():
    return jsonify(v2ray_server.list_nodes())


@bp.get("/api/v2ray/server/traffic")
def v2_server_traffic():
    """本地节点流量统计：实时网速 + 每节点累计用量 / 配额状态。"""
    return jsonify(v2ray_server.traffic())


@bp.post("/api/v2ray/server/traffic/reset")
def v2_server_traffic_reset():
    """清零本地节点流量：body.sid 指定节点，留空清全部。"""
    data = request.get_json(silent=True) or {}
    return jsonify(v2ray_server.reset_traffic(str(data.get("sid") or "")))


@bp.post("/api/v2ray/server/nodes/create")
def v2_server_node_create():
    data = request.get_json(silent=True) or {}
    r = v2ray_server.create_node(data, auto=bool(data.get("auto")))
    if r.get("error"):
        return _fail(r["error"])
    return jsonify(r)


@bp.post("/api/v2ray/server/nodes/<sid>/update")
def v2_server_node_update(sid):
    r = v2ray_server.update_node_data(sid, request.get_json(silent=True) or {})
    if r.get("error"):
        return _fail(r["error"])
    return jsonify(r)


@bp.post("/api/v2ray/server/nodes/<sid>/delete")
def v2_server_node_delete(sid):
    return jsonify(v2ray_server.delete_node(sid))


@bp.post("/api/v2ray/server/nodes/<sid>/start")
def v2_server_node_start(sid):
    r = v2ray_server.start_node(sid)
    if r.get("error"):
        return _fail(r["error"], 500)
    return jsonify(r)


@bp.post("/api/v2ray/server/nodes/<sid>/stop")
def v2_server_node_stop(sid):
    return jsonify(v2ray_server.stop_node(sid))


@bp.get("/api/v2ray/server/nodes/<sid>/log")
def v2_server_node_log(sid):
    lines = _int(request.args.get("lines"), 60)
    return jsonify({"ok": True, "log": v2ray_server.node_log_tail(sid, lines)})


@bp.post("/api/v2ray/server/nodes/<sid>/log/clear")
def v2_server_node_log_clear(sid):
    v2ray_server.node_clear_log(sid)
    return jsonify({"ok": True})


@bp.post("/api/v2ray/server/nodes/<sid>/new-uuid")
def v2_server_node_new_uuid(sid):
    return jsonify(v2ray_server.node_new_uuid(sid))


@bp.post("/api/v2ray/server/nodes/<sid>/gen-keys")
def v2_server_node_gen_keys(sid):
    r = v2ray_server.node_gen_keys(sid)
    if r.get("error"):
        return _fail(r["error"], 500)
    return jsonify(r)


@bp.get("/api/v2ray/server/qr")
def v2_server_qr():
    """把分享链接编码成 PNG 二维码，手机扫一扫即可导入。"""
    text = str(request.args.get("text") or "").strip()
    if not text:
        cfg = v2ray_server.get_config()
        text = v2ray_server.share_link(cfg, str(request.args.get("host") or ""))
    if len(text) > 4000:
        return _fail("链接内容过长，无法生成二维码")
    try:
        import io
        import qrcode
        qr = qrcode.QRCode(version=None, error_correction=qrcode.constants.ERROR_CORRECT_M,
                           box_size=10, border=2)
        qr.add_data(text)
        qr.make(fit=True)
        buf = io.BytesIO()
        qr.make_image(fill_color="#0f172a", back_color="#ffffff").save(buf, format="PNG")
    except Exception as e:                       # noqa: BLE001
        return _fail("生成二维码失败：%s" % e, 500)
    resp = Response(buf.getvalue(), mimetype="image/png")
    resp.headers["Cache-Control"] = "no-store"
    return resp

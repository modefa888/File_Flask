"""操作审计日志 —— 记录全站「写操作」（POST / PUT / PATCH / DELETE）。

设计
----
* 采集点只有一个：`app._install_request_logging` 的 `after_request`，
  所以各业务接口不用改一行代码，新加的接口也会自动被记录；
* 落库在 store.db 的 `op_log` 表，只留最近 KEEP 条（超出按时间从旧到新删）；
* 只记「谁 / 何时 / 哪个模块 / 做了什么 / 对什么 / 结果」，请求体里的密码类字段打码。

排除：GET 类请求、静态资源、AI 对话（已有单独用量统计）、本模块自身的接口。
"""
from __future__ import annotations

import json
import time

from ...log import get_logger
from .store_db import store_conn, store_tx

_log = get_logger()

KEEP = 5000
METHODS = ("POST", "PUT", "PATCH", "DELETE")
SKIP_PREFIX = (
    "/api/adm/oplogs",      # 本模块自身（查 / 清空都不算操作）
    "/api/ai/",             # AI 调用已有「AI 用量」统计
    "/static",
    "/api/progress/",
)
MASK_KEYS = ("password", "passwd", "pwd", "secret", "token", "api_key", "apikey", "key", "credential")
TARGET_KEYS = ("path", "name", "filename", "username", "user", "id", "trash_id",
               "rule", "module", "target", "value", "provider", "channel")

# 兜底用的路径前缀 → 模块中文名
PREFIX_MODULE = {
    "adm": "后台管理", "files": "文件管理", "file": "文件管理", "trash": "回收站",
    "shares": "分享", "share": "分享", "cron": "定时任务", "run": "后台任务",
    "plugins": "插件", "db": "数据库连接", "ssh": "SSH 连接", "sshconn": "SSH 连接",
    "ai": "AI", "http": "接口调试", "upload": "上传", "auth": "账号",
    "users": "用户", "user": "用户", "collab": "协作", "git": "Git",
    "env": "运行环境", "npm": "npm", "pip": "pip", "term": "终端",
}

# 动作归类：先看路径关键词，再看请求方法。顺序有意义（先匹配先返回）
OP_RULES = (
    ("清空", ("/clear", "/purge", "/reset")),
    ("删除", ("/delete", "/remove", "/uninstall", "/drop")),
    ("清理", ("/cleanup",)),
    ("停止", ("/stop", "/kill", "/cancel", "/terminate")),
    ("新增", ("/create", "/add", "/new", "/upload", "/install", "/register", "/import")),
    ("执行", ("/run", "/exec", "/start", "/restart", "/reboot", "/apply", "/test",
              "/send", "/sync", "/materialize")),
    ("修改", ("/update", "/edit", "/save", "/set", "/toggle", "/enable", "/disable",
              "/ban", "/unban", "/restore", "/move", "/rename", "/hide", "/config")),
    ("登录", ("/login",)),
    ("退出", ("/logout",)),
)


def _op_of(method, rule, path=""):
    """把一次写操作归类成「新增 / 修改 / 删除 / 清空 / 执行 …」。"""
    low = str(rule or path or "").lower()
    for name, keys in OP_RULES:
        if any(k in low for k in keys):
            return name
    method = str(method or "").upper()
    if method == "DELETE":
        return "删除"
    if method in ("PUT", "PATCH"):
        return "修改"
    return "提交" if method == "POST" else method


_LABELS = {}


def _labels():
    """(rule, method) → (模块, 动作说明)：用接口登记表里的人工说明，缓存一份。"""
    if _LABELS:
        return _LABELS
    try:
        from ..adm import api_registry
        for r in api_registry.list_interfaces():
            _LABELS[(r.get("rule") or "", r.get("method") or "")] = (
                r.get("module_name") or r.get("module") or "",
                r.get("desc") or "",
            )
    except Exception as e:                       # 取不到就用路径兜底
        _log.warning("读取接口说明失败：%s", e)
    return _LABELS


def _guess(rule, method, path):
    """给一次写操作起名字：优先用登记表里的「模块 + 说明」，否则按路径猜。"""
    labels = _labels()
    hit = labels.get((rule or "", method)) or labels.get((path or "", method))
    if hit and (hit[0] or hit[1]):
        return hit[0] or "其他", hit[1] or method
    parts = [p for p in str(path or rule or "").split("/") if p]
    key = parts[0] if parts and parts[0] != "api" else (parts[1] if len(parts) > 1 else "")
    module = PREFIX_MODULE.get(key, key or "其他")
    tail = "/".join(parts[-2:]) if len(parts) >= 2 else (parts[-1] if parts else "")
    return module, "%s %s" % (method, tail)


_BRIEF_MAX = 1200     # op_log.detail 存这么多字（前端参数卡片本身有滚动，不怕长）
_STR_MAX = 80
_DEPTH_MAX = 3
# 超长时的逐级压缩参数：(字符串上限, 数组最多几项, 对象最多几个字段, 最大深度)
_SQUEEZE = ((40, 6, 8, 2), (24, 4, 6, 2), (16, 3, 4, 1))


def _masked(key):
    low = str(key).lower()
    return any(s in low for s in MASK_KEYS)


def _slim(v, depth=0, str_max=_STR_MAX, item_max=8, key_max=10, depth_max=_DEPTH_MAX):
    """把参数值压成「还能看懂」的结构：长字符串截断、数组/对象限制规模。

    关键：嵌套对象保留成对象（而不是 dump 成一整串 JSON 字符串），
    这样前端能把 notify.enabled / notify.events 这类参数逐行展开。
    """
    if v is None or isinstance(v, (bool, int, float)):
        return v
    if isinstance(v, str):
        s = v.strip()
        return s if len(s) <= str_max else s[:str_max] + "…"
    if isinstance(v, (list, tuple)):
        if depth >= depth_max:
            return "[%d 项]" % len(v)
        items = [_slim(x, depth + 1, str_max, item_max, key_max, depth_max)
                 for x in list(v)[:item_max]]
        if len(v) > item_max:
            items.append("…共 %d 项" % len(v))
        return items
    if isinstance(v, dict):
        if depth >= depth_max:
            return "{ %d 个字段 }" % len(v)
        out = {}
        for i, (k, x) in enumerate(v.items()):
            if i >= key_max:
                out["…"] = "还有 %d 个字段" % (len(v) - key_max)
                break
            k = str(k)[:40]
            out[k] = "***" if _masked(k) else _slim(
                x, depth + 1, str_max, item_max, key_max, depth_max)
        return out
    return str(v)[:str_max]


def _brief(body, limit=_BRIEF_MAX):
    """请求参数摘要：敏感字段打码、长值截断；嵌套结构原样保留给前端展开。

    整体超长时逐级压缩（先缩紧每个值的规模，再按字段丢弃尾部），
    保证「永远有内容可看」，不会因为某个字段太大就整条变成空参数。
    """
    if not isinstance(body, dict) or not body:
        return ""
    items = [(str(k)[:40], k, v) for k, v in list(body.items())[:20]]

    def build(str_max, item_max, key_max, depth_max, keep):
        out = {}
        for name, raw_k, v in items[:keep]:
            out[name] = "***" if _masked(raw_k) else _slim(
                v, 0, str_max, item_max, key_max, depth_max)
        if keep < len(items):
            out["…"] = "另有 %d 个字段" % (len(items) - keep)
        return json.dumps(out, ensure_ascii=False)

    # 1) 先按正常规模输出；2) 太长就逐级压缩；3) 还长就丢字段（至少留 1 个）
    text = build(_STR_MAX, 8, 10, _DEPTH_MAX, len(items))
    if len(text) <= limit:
        return text
    for str_max, item_max, key_max, depth_max in _SQUEEZE:
        text = build(str_max, item_max, key_max, depth_max, len(items))
        if len(text) <= limit:
            return text
    for keep in range(min(len(items), 20) - 1, 0, -1):
        for str_max, item_max, key_max, depth_max in _SQUEEZE:
            text = build(str_max, item_max, key_max, depth_max, keep)
            if len(text) <= limit:
                return text
    # 极端情况：直接截断（前端解析不了会按原始文本展示，总比空着强）
    return text[:limit]


_RESP_MAX = 1200
_RESP_RAW_LIMIT = 200 * 1024        # 超过这个体积的响应不解析，只留一句提示


def _resp_brief(response):
    """接口返回内容摘要：JSON 走和请求参数一样的压缩，非 JSON 的文本截断，超大 / 二进制跳过。"""
    if response is None:
        return ""
    try:
        if getattr(response, "direct_passthrough", False) or getattr(response, "is_streamed", False):
            return ""               # 流式响应：读了会截断真实输出，直接不记
        ctype = str(response.headers.get("Content-Type") or "").lower()
        if ctype and not any(t in ctype for t in ("json", "text", "javascript", "xml")):
            return "[%s 响应，未记录]" % ((ctype.split(";")[0] or "二进制").strip())
        size = 0
        try:
            size = int(response.calculate_content_length() or 0)
        except Exception:
            size = 0
        if size > _RESP_RAW_LIMIT:
            return "[响应约 %d KB，未记录]" % (size // 1024)
        text = (response.get_data(as_text=True) or "").strip()
    except Exception:
        return ""
    if not text:
        return ""
    try:
        obj = json.loads(text)
    except Exception:
        return text[:_RESP_MAX]      # 非 JSON（HTML / 纯文本）：原样截断
    if isinstance(obj, dict):
        return _brief(obj, _RESP_MAX) or text[:_RESP_MAX]
    if isinstance(obj, list):
        return _brief({"items": obj}, _RESP_MAX) or text[:_RESP_MAX]
    return text[:_RESP_MAX]


def record(module, action, target="", detail="", result="ok", user="", ip="",
           rule="", method="", op="", resp=""):
    """写一条操作日志（失败只记警告，绝不影响业务请求）。

    module/action 是「模块 + 说明」（取自接口登记表），
    rule/method 是接口路径与请求方法，op 是动作归类（新增 / 修改 / 删除 …），
    detail 是请求参数摘要，resp 是接口返回内容摘要。
    """
    ts = time.strftime("%Y-%m-%d %H:%M:%S")
    try:
        with store_tx() as conn:
            conn.execute(
                "INSERT INTO op_log (ts, user, module, action, target, detail, ip, result, "
                "rule, method, op, resp) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                (ts, str(user)[:60], str(module)[:40], str(action)[:80],
                 str(target)[:200], str(detail)[:1300], str(ip)[:40], str(result)[:20],
                 str(rule)[:200], str(method)[:10], str(op)[:20], str(resp)[:1300]))
            n = conn.execute("SELECT COUNT(*) AS n FROM op_log").fetchone()["n"]
            if n > KEEP:
                conn.execute(
                    "DELETE FROM op_log WHERE id IN "
                    "(SELECT id FROM op_log ORDER BY id ASC LIMIT ?)", (n - KEEP,))
    except Exception as e:
        _log.warning("写操作日志失败：%s", e)


def record_from_request(request, status, method, path, response=None):
    """after_request 里调用：把一次写操作（含失败）连同接口返回内容记下来。"""
    method = str(method or "").upper()
    if method not in METHODS:
        return
    if any(str(path or "").startswith(p) for p in SKIP_PREFIX):
        return

    rule_obj = getattr(request, "url_rule", None)
    rule = rule_obj.rule if rule_obj is not None else path
    module, action = _guess(rule, method, path)

    try:
        body = request.get_json(silent=True) or {}
    except Exception:
        body = {}
    if not isinstance(body, dict):
        body = {}
    if not body:                       # 表单提交 / 其它 Content-Type：也尽量把参数记下来
        try:
            if request.form:
                body = request.form.to_dict(flat=True)
        except Exception:
            body = {}

    # 参数 = 路径参数 + URL 查询参数 + 请求体（后面的覆盖前面的）
    params = {}
    try:
        if getattr(request, "view_args", None):
            params.update(request.view_args)
        for k in request.args:
            params[k] = request.args.get(k)
        params.update(body)
    except Exception:
        pass

    target = ""
    for k in TARGET_KEYS:
        if params.get(k) not in (None, "", 0, "0"):
            target = str(params.get(k))
            break

    user = ""
    try:
        from ...routes.common.auth import current_username
        user = current_username() or ""
    except Exception:
        pass

    ip = ""
    try:
        ip = (request.headers.get("X-Forwarded-For") or "").split(",")[0].strip() \
            or (request.remote_addr or "")
    except Exception:
        pass

    try:
        code = int(status)
    except (TypeError, ValueError):
        code = 0
    result = "ok" if code and code < 400 else "失败 HTTP %s" % code

    record(module, action, target=target, detail=_brief(params),
           result=result, user=user, ip=ip,
           rule=str(rule or ""), method=method, op=_op_of(method, rule, path),
           resp=_resp_brief(response))


def list_logs(q="", page=1, page_size=50):
    """分页查询：返回 (记录列表, 总数)。"""
    where, args = "", []
    if q:
        where = (" WHERE (module LIKE ? OR action LIKE ? OR target LIKE ? "
                 "OR detail LIKE ? OR resp LIKE ? OR user LIKE ? OR ip LIKE ? "
                 "OR rule LIKE ? OR method LIKE ? OR op LIKE ?)")
        args = ["%" + q + "%"] * 10
    try:
        page = max(int(page or 1), 1)
        page_size = min(max(int(page_size or 50), 1), 200)
    except (TypeError, ValueError):
        page, page_size = 1, 50
    conn = store_conn()
    try:
        total = conn.execute("SELECT COUNT(*) AS n FROM op_log" + where, args).fetchone()["n"]
        rows = conn.execute(
            "SELECT id, ts, user, module, action, target, detail, ip, result, "
            "rule, method, op, resp FROM op_log" + where +
            " ORDER BY id DESC LIMIT ? OFFSET ?",
            args + [page_size, (page - 1) * page_size]).fetchall()
    finally:
        conn.close()
    return [dict(r) for r in rows], int(total or 0)


def stats():
    """概览：总数 / 今天的条数 / 最近一条时间。"""
    conn = store_conn()
    try:
        total = conn.execute("SELECT COUNT(*) AS n FROM op_log").fetchone()["n"]
        today = time.strftime("%Y-%m-%d")
        tcount = conn.execute("SELECT COUNT(*) AS n FROM op_log WHERE ts LIKE ?",
                              (today + "%",)).fetchone()["n"]
        last = conn.execute("SELECT ts FROM op_log ORDER BY id DESC LIMIT 1").fetchone()
    finally:
        conn.close()
    return {"total": int(total or 0), "today": int(tcount or 0),
            "last_at": (last["ts"] if last else "")}


def clear():
    """清空操作日志，返回删除条数。"""
    try:
        with store_tx() as conn:
            n = conn.execute("DELETE FROM op_log").rowcount
    except Exception as e:
        _log.warning("清空操作日志失败：%s", e)
        return 0
    _log.info("已清空操作日志：%d 条", n or 0)
    return int(n or 0)

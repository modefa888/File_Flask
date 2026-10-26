"""定时任务存储层（SQLite / store.db 的 cron_tasks + cron_runs + cron_cfg 三张表）。

只做纯粹的增删改查，不涉及进程与文件；调度与执行见 cronsvc.py，
通知渠道配置见 cronnotify.py（同样落在 cron_cfg 表）。
"""
import json
import secrets
import time
import uuid

from ...log import get_logger
from ..common.store_db import store_conn, store_tx

_log = get_logger()

_TASK_COLS = ("id", "name", "cron", "command", "kind", "lang", "content", "ai_sys", "web_token", "cwd",
              "enabled", "remark", "timeout",
              "max_retries", "retry_interval", "depends_on", "pre_hook", "post_hook",
              "notify", "notify_content", "notify_lines", "notify_title", "notify_body",
              "notify_channels",
              "created_at", "updated_at", "last_at", "last_status", "last_ms",
              "last_exit", "run_count", "ok_count", "fail_count")

# 任务级通知内容：仅结果 / 结果+脚本输出 / 仅脚本输出 / 自定义模板
NOTIFY_MODES = ("status", "output", "output_only", "custom")
_NOTIFY_LINES_MAX = 200

# 任务执行方式：command（shell 命令）/ code（代码片段）/ ai（AI 提示词）
KINDS = ("command", "code", "ai")
LANGS = ("python", "node", "bash")
KIND_LABELS = {"command": "命令", "code": "代码", "ai": "AI 提示词"}
LANG_LABELS = {"python": "Python", "node": "Node.js", "bash": "Shell"}

# 可推送的通知渠道（与 cronnotify 的渠道一致）；任务里为空 = 跟随「通知设置」里已启用的渠道
NOTIFY_CHANNELS = ("desktop", "email", "dingtalk", "telegram", "pushplus", "web")


def norm_channels(v):
    """把渠道配置归一化成逗号串：接受数组 / 逗号串，丢弃未知渠道并去重（顺序固定）。"""
    if isinstance(v, str):
        items = v.split(",")
    elif isinstance(v, (list, tuple, set)):
        items = [str(x) for x in v]
    else:
        items = []
    picked = {str(x).strip().lower() for x in items}
    return ",".join(c for c in NOTIFY_CHANNELS if c in picked)


def as_bool(v, default=True):
    """布尔归一化：兼容 0/1、'0'/'1'、'false'/'true' 等写法。

    历史数据里 notify 曾以字符串 '0' / '1' 落库，直接 bool('0') 会得到 True，
    导致「取消勾选执行后发送通知 → 保存 → 再打开又变回勾选」。
    """
    if v is None:
        return bool(default)
    if isinstance(v, str):
        return v.strip().lower() not in ("", "0", "false", "no", "off", "none")
    return bool(v)


def _norm_mode(v):
    v = str(v or "").strip().lower()
    return v if v in NOTIFY_MODES else "status"


def _norm_lines(v):
    try:
        return max(0, min(int(v or 0), _NOTIFY_LINES_MAX))
    except (TypeError, ValueError):
        return 20


def _norm_kind(v):
    v = str(v or "").strip().lower()
    return v if v in KINDS else "command"


def _norm_lang(v):
    v = str(v or "").strip().lower()
    return v if v in LANGS else "python"


def _task_dict(row):
    if not row:
        return None
    d = {k: row[k] for k in _TASK_COLS if k in row.keys()}
    d["enabled"] = as_bool(d.get("enabled"))
    d["notify"] = as_bool(d.get("notify"))
    d["notify_content"] = _norm_mode(d.get("notify_content"))
    d["notify_lines"] = _norm_lines(d.get("notify_lines"))
    d["notify_title"] = str(d.get("notify_title") or "")
    d["notify_body"] = str(d.get("notify_body") or "")
    d["notify_channels"] = norm_channels(d.get("notify_channels"))
    d["kind"] = _norm_kind(d.get("kind"))
    d["lang"] = _norm_lang(d.get("lang"))
    d["content"] = str(d.get("content") or "")
    d["ai_sys"] = str(d.get("ai_sys") or "")
    d["web_token"] = str(d.get("web_token") or "")
    return d


def _run_dict(row):
    if not row:
        return None
    return {k: row[k] for k in row.keys()}


def _query(sql, args=()):
    conn = store_conn()
    try:
        return conn.execute(sql, args).fetchall()
    finally:
        conn.close()


# ---------------------------------------------------------------- 任务
def list_tasks():
    rows = _query("SELECT * FROM cron_tasks ORDER BY created_at ASC")
    return [_task_dict(r) for r in rows]


def get_task(tid):
    rows = _query("SELECT * FROM cron_tasks WHERE id=?", (str(tid or ""),))
    return _task_dict(rows[0]) if rows else None


def create_task(name, cron, command, cwd="", enabled=True, remark="", timeout=0,
                max_retries=0, retry_interval=60, depends_on="", pre_hook="", post_hook="",
                notify=True, tid=None, notify_content="status", notify_lines=20,
                notify_title="", notify_body="", notify_channels="",
                kind="command", lang="python", content="", ai_sys=""):
    now = time.time()
    tid = str(tid) if tid else uuid.uuid4().hex[:12]
    with store_tx() as conn:
        conn.execute(
            "INSERT INTO cron_tasks (id, name, cron, command, kind, lang, content, ai_sys,"
            " cwd, enabled, remark, timeout,"
            " max_retries, retry_interval, depends_on, pre_hook, post_hook, notify,"
            " notify_content, notify_lines, notify_title, notify_body, notify_channels,"
            " created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (tid, name, cron, command, _norm_kind(kind), _norm_lang(lang),
             str(content or ""), str(ai_sys or ""),
             cwd, 1 if as_bool(enabled) else 0, remark, int(timeout or 0),
             max(0, int(max_retries or 0)), max(1, int(retry_interval or 60)),
             str(depends_on or ""), str(pre_hook or ""), str(post_hook or ""),
             1 if as_bool(notify) else 0, _norm_mode(notify_content), _norm_lines(notify_lines),
             str(notify_title or ""), str(notify_body or ""), norm_channels(notify_channels),
             now, now))
    return get_task(tid)


def update_task(tid, **fields):
    allowed = ("name", "cron", "command", "kind", "lang", "content", "ai_sys",
               "cwd", "enabled", "remark", "timeout",
               "max_retries", "retry_interval", "depends_on", "pre_hook", "post_hook", "notify",
               "notify_content", "notify_lines", "notify_title", "notify_body",
               "notify_channels")
    sets, args = [], []
    for k in allowed:
        if k not in fields:
            continue
        v = fields[k]
        sets.append(k + "=?")
        if k in ("enabled", "notify"):
            args.append(1 if as_bool(v) else 0)
        elif k == "max_retries":
            args.append(max(0, int(v or 0)))
        elif k == "retry_interval":
            args.append(max(1, int(v or 60)))
        elif k == "notify_content":
            args.append(_norm_mode(v))
        elif k == "notify_lines":
            args.append(_norm_lines(v))
        elif k == "notify_channels":
            args.append(norm_channels(v))
        elif k == "kind":
            args.append(_norm_kind(v))
        elif k == "lang":
            args.append(_norm_lang(v))
        elif k in ("content", "ai_sys"):
            args.append(str(v or ""))
        else:
            args.append(v)
    if sets:
        sets.append("updated_at=?")
        args.append(time.time())
        args.append(str(tid))
        with store_tx() as conn:
            conn.execute("UPDATE cron_tasks SET " + ", ".join(sets) + " WHERE id=?", tuple(args))
    return get_task(tid)


def set_enabled(tid, enabled):
    with store_tx() as conn:
        conn.execute("UPDATE cron_tasks SET enabled=?, updated_at=? WHERE id=?",
                     (1 if enabled else 0, time.time(), str(tid)))
    return get_task(tid)


def delete_task(tid):
    """删除任务及其执行历史，返回被删记录的日志路径（供上层清理日志文件）。"""
    tid = str(tid)
    rows = _query("SELECT log_path FROM cron_runs WHERE task_id=?", (tid,))
    logs = [r["log_path"] for r in rows if r["log_path"]]
    with store_tx() as conn:
        conn.execute("DELETE FROM cron_tasks WHERE id=?", (tid,))
        conn.execute("DELETE FROM cron_runs WHERE task_id=?", (tid,))
    return logs


def bump_task_stats(tid, status, ms=0, exit_code=None, at=None):
    """任务跑完回写统计：最近一次状态 / 耗时 / 累计次数。"""
    ok = 1 if status == "success" else 0
    fail = 0 if status in ("success", "running", "killed") else 1
    with store_tx() as conn:
        conn.execute(
            "UPDATE cron_tasks SET last_at=?, last_status=?, last_ms=?, last_exit=?,"
            " run_count=run_count+1, ok_count=ok_count+?, fail_count=fail_count+? WHERE id=?",
            (float(at or time.time()), status, int(ms or 0), exit_code, ok, fail, str(tid)))


# ---------------------------------------------------------------- 执行历史
def insert_run(run_id, task_id, task_name, trigger, log_path, started_at=None, attempt=0):
    with store_tx() as conn:
        conn.execute(
            "INSERT INTO cron_runs (id, task_id, task_name, trigger, attempt, status,"
            " started_at, log_path) VALUES (?,?,?,?,?,?,?,?)",
            (run_id, str(task_id), task_name, trigger, max(0, int(attempt or 0)), "running",
             float(started_at or time.time()), log_path))


def finish_run(run_id, status, exit_code=None, duration=0, log_size=0, ended_at=None):
    with store_tx() as conn:
        conn.execute(
            "UPDATE cron_runs SET status=?, exit_code=?, duration=?, log_size=?, ended_at=? WHERE id=?",
            (status, exit_code, int(duration or 0), int(log_size or 0),
             float(ended_at or time.time()), run_id))


def list_runs(task_id=None, limit=50):
    limit = max(1, min(int(limit or 50), 200))
    if task_id:
        rows = _query("SELECT * FROM cron_runs WHERE task_id=? ORDER BY started_at DESC LIMIT ?",
                      (str(task_id), limit))
    else:
        rows = _query("SELECT * FROM cron_runs ORDER BY started_at DESC LIMIT ?", (limit,))
    return [_run_dict(r) for r in rows]


def get_run(run_id):
    rows = _query("SELECT * FROM cron_runs WHERE id=?", (str(run_id or ""),))
    return _run_dict(rows[0]) if rows else None


def running_runs():
    rows = _query("SELECT * FROM cron_runs WHERE status='running'")
    return [_run_dict(r) for r in rows]


def prune_runs(task_id, keep=50):
    """只保留某任务最近 keep 条执行记录，返回被删记录（供上层清理日志文件）。"""
    keep = max(1, int(keep or 50))
    rows = _query("SELECT id, log_path FROM cron_runs WHERE task_id=?"
                  " ORDER BY started_at DESC LIMIT -1 OFFSET ?", (str(task_id), keep))
    dropped = [{"id": r["id"], "log_path": r["log_path"]} for r in rows]
    if dropped:
        with store_tx() as conn:
            for r in dropped:
                conn.execute("DELETE FROM cron_runs WHERE id=?", (r["id"],))
    return dropped


def clear_runs(task_id):
    """清空某任务的执行记录（保留正在运行的那条），返回被删记录。"""
    rows = _query("SELECT id, log_path FROM cron_runs WHERE task_id=? AND status!='running'",
                  (str(task_id),))
    dropped = [{"id": r["id"], "log_path": r["log_path"]} for r in rows]
    if dropped:
        with store_tx() as conn:
            conn.execute("DELETE FROM cron_runs WHERE task_id=? AND status!='running'", (str(task_id),))
    return dropped


def clear_runs_before(ts):
    """删除某时刻之前的所有执行记录（日志自动清理用），返回被删记录。"""
    rows = _query("SELECT id, log_path FROM cron_runs WHERE status!='running' AND ended_at>0"
                  " AND ended_at<?", (float(ts),))
    dropped = [{"id": r["id"], "log_path": r["log_path"]} for r in rows]
    if dropped:
        with store_tx() as conn:
            conn.execute("DELETE FROM cron_runs WHERE id IN (%s)"
                         % ",".join("?" * len(dropped)), tuple(r["id"] for r in dropped))
    return dropped


# ---------------------------------------------------------------- 网页版通知
_WEB_NOTE_COLS = ("id", "token", "task_id", "task_name", "run_id", "title", "body",
                  "status", "created_at", "expires_at", "deleted")


def ensure_web_token(tid):
    """取任务的网页通知令牌；没有就生成随机串并落库（每个任务固定一个，地址可收藏）。"""
    tid = str(tid or "")
    rows = _query("SELECT web_token FROM cron_tasks WHERE id=?", (tid,))
    if rows and rows[0]["web_token"]:
        return str(rows[0]["web_token"])
    token = secrets.token_hex(16)
    with store_tx() as conn:
        conn.execute("UPDATE cron_tasks SET web_token=? WHERE id=?", (token, tid))
    return token


def get_task_by_web_token(token):
    """按网页通知令牌反查任务（页面标题 / 归属用）。"""
    token = str(token or "").strip()
    if not token:
        return None
    rows = _query("SELECT * FROM cron_tasks WHERE web_token=?", (token,))
    return _task_dict(rows[0]) if rows else None


def add_web_note(token, title, body, task_id="", task_name="", run_id="", status="", days=7):
    """保存一条网页通知（Markdown 正文），返回 {id, expires_at}。"""
    try:
        days = max(1, min(int(days or 7), 365))
    except (TypeError, ValueError):
        days = 7
    now = time.time()
    nid = uuid.uuid4().hex[:12]
    with store_tx() as conn:
        conn.execute(
            "INSERT INTO cron_web_notes (id, token, task_id, task_name, run_id, title, body,"
            " status, created_at, expires_at, deleted) VALUES (?,?,?,?,?,?,?,?,?,?,0)",
            (nid, str(token or ""), str(task_id or ""), str(task_name or ""), str(run_id or ""),
             str(title or "")[:200], str(body or ""), str(status or ""), now, now + days * 86400))
    return {"id": nid, "expires_at": now + days * 86400}


def list_web_notes(token, limit=50):
    """某个令牌下仍有效的通知（新的在前；过期 / 已假删除的不返回）。"""
    token = str(token or "").strip()
    if not token:
        return []
    limit = max(1, min(int(limit or 50), 200))
    rows = _query(
        "SELECT * FROM cron_web_notes WHERE token=? AND deleted=0 AND expires_at>?"
        " ORDER BY created_at DESC LIMIT ?", (token, time.time(), limit))
    return [{k: r[k] for k in _WEB_NOTE_COLS if k in r.keys()} for r in rows]


def purge_web_notes():
    """把过期通知标记为已删除（假删除，不物理删）；返回处理条数。"""
    with store_tx() as conn:
        cur = conn.execute(
            "UPDATE cron_web_notes SET deleted=1 WHERE deleted=0 AND expires_at<=?",
            (time.time(),))
        return cur.rowcount or 0


# ---------------------------------------------------------------- 模块设置（cron_cfg 键值表）
def get_setting(key, default=None):
    """读取一个模块设置（值是 JSON 文本；不存在返回 default）。"""
    rows = _query("SELECT value FROM cron_cfg WHERE key=?", (str(key),))
    if not rows:
        return default
    try:
        return json.loads(rows[0]["value"])
    except (TypeError, ValueError):
        return rows[0]["value"]


def set_setting(key, value):
    """写入一个模块设置（任意可 JSON 序列化的值）。"""
    with store_tx() as conn:
        conn.execute("INSERT OR REPLACE INTO cron_cfg (key, value) VALUES (?, ?)",
                     (str(key), json.dumps(value, ensure_ascii=False)))


def all_settings():
    """读取全部模块设置（还原成对象）。"""
    rows = _query("SELECT key, value FROM cron_cfg")
    out = {}
    for r in rows:
        try:
            out[r["key"]] = json.loads(r["value"])
        except (TypeError, ValueError):
            out[r["key"]] = r["value"]
    return out

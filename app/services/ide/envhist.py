"""运行环境安装记录（落库到 store.db 的 env_install_history）。

一次「一键安装」= 一行：
  开始安装时先写 running（finished_at = 0），结束时补结果 / 耗时 / 装出来的可执行文件 / 完整日志；
  进程中途退出的话这一行会停在 finished_at = 0，界面上显示为「中断」，不会凭空消失。

只存「本机用户级安装」的记录（系统包方案本来就不会自动执行）；日志按尾部截断，避免库无限膨胀。
"""
import time

from ...log import get_logger
from ..common.store_db import store_conn, store_tx

_log = get_logger()

_MAX_LOG_CHARS = 200_000       # 单次安装日志最多存多少字符（留尾部）
_KEEP_ROWS = 300               # 最多保留多少条记录（超出删最旧的）

_FIELDS = ("seq", "tid", "rid", "label", "version", "plan_key", "mode", "source",
           "ok", "cancelled", "error", "installed", "elapsed", "started_at", "finished_at")

# 本模块专属表：建表 DDL 放这里，跟着模块演进（与 v2raydb / collab 一样的做法）
_SCHEMA = """
CREATE TABLE IF NOT EXISTS env_install_history (
    seq         INTEGER PRIMARY KEY AUTOINCREMENT,
    tid         TEXT DEFAULT '',
    rid         TEXT DEFAULT '',
    label       TEXT DEFAULT '',
    version     TEXT DEFAULT '',
    plan_key    TEXT DEFAULT '',
    mode        TEXT DEFAULT 'user',
    source      TEXT DEFAULT 'panel',
    ok          INTEGER NOT NULL DEFAULT 0,
    cancelled   INTEGER NOT NULL DEFAULT 0,
    error       TEXT DEFAULT '',
    installed   TEXT DEFAULT '',
    elapsed     REAL NOT NULL DEFAULT 0,
    started_at  REAL NOT NULL DEFAULT 0,
    finished_at REAL NOT NULL DEFAULT 0,
    log         TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_env_hist_started ON env_install_history(started_at DESC);
"""

_ready = False


def init_db() -> None:
    """幂等建表；失败只告警，不阻断启动。"""
    global _ready
    if _ready:
        return
    try:
        with store_tx() as conn:
            conn.executescript(_SCHEMA)
        _ready = True
    except Exception as e:
        _log.warning("建安装记录表失败：%s", e)


init_db()


def _log_text(task) -> str:
    out = []
    for ln in (task.lines or []):
        msg = str(ln.get("m") or "")
        cls = ln.get("c") or ""
        if cls == "err":
            msg = "! " + msg
        elif cls == "ok":
            msg = "✔ " + msg
        elif cls == "h":
            msg = "## " + msg
        out.append("[%6.2fs] %s" % (float(ln.get("t") or 0), msg))
    text = "\n".join(out)
    if len(text) > _MAX_LOG_CHARS:
        text = "…（前面的日志已截断）\n" + text[-_MAX_LOG_CHARS:]
    return text


def begin(tid: str, rid: str, label: str, plan_key: str, mode: str = "user", source: str = "panel") -> int:
    """写一条「正在安装」的记录，返回 seq（失败返回 0，不影响安装本身）。"""
    init_db()
    try:
        with store_tx() as conn:
            cur = conn.execute(
                "INSERT INTO env_install_history "
                "(tid, rid, label, plan_key, mode, source, ok, cancelled, error, installed, "
                " elapsed, started_at, finished_at, log) "
                "VALUES (?,?,?,?,?,?,0,0,'','',0,?,0,'')",
                (str(tid or ""), str(rid or ""), str(label or ""), str(plan_key or ""),
                 str(mode or "user"), str(source or "panel"), time.time()),
            )
            seq = int(cur.lastrowid or 0)
            _prune(conn)
            return seq
    except Exception as e:
        _log.warning("写安装记录（begin）失败：%s", e)
        return 0


def _probe_version(rid: str) -> str:
    """装完顺手取一次版本（尽量，失败就算了）。"""
    try:
        from . import envprobe
        d = envprobe.probe_detail(rid) or {}
        return str(d.get("version") or "")
    except Exception:
        return ""


def finish(task) -> None:
    """安装结束：补齐结果、耗时、可执行文件与完整日志。"""
    seq = int(getattr(task, "hist_seq", 0) or 0)
    if not seq:
        return
    version = _probe_version(task.rid)
    installed = "\n".join(str(p) for p in (task.installed or []))
    try:
        with store_tx() as conn:
            conn.execute(
                "UPDATE env_install_history SET ok=?, cancelled=?, error=?, installed=?, "
                "version=?, elapsed=?, finished_at=?, log=? WHERE seq=?",
                (1 if task.ok else 0, 1 if task.cancelled else 0, str(task.error or ""),
                 installed[:4000], version[:80], round(time.time() - task.started, 2),
                 time.time(), _log_text(task), seq),
            )
    except Exception as e:
        _log.warning("写安装记录（finish）失败：%s", e)


def _prune(conn) -> None:
    """只保留最近的 _KEEP_ROWS 条。"""
    try:
        conn.execute(
            "DELETE FROM env_install_history WHERE seq NOT IN "
            "(SELECT seq FROM env_install_history ORDER BY started_at DESC LIMIT %d)" % _KEEP_ROWS
        )
    except Exception:
        pass


def list_records(limit: int = 40) -> dict:
    """最近的安装记录（不含日志正文，点开再看）。"""
    init_db()
    limit = max(1, min(int(limit or 40), 200))
    conn = store_conn()
    try:
        total = int(conn.execute("SELECT COUNT(*) FROM env_install_history").fetchone()[0] or 0)
        rows = conn.execute(
            "SELECT " + ", ".join(_FIELDS) + ", LENGTH(log) AS log_len "
            "FROM env_install_history ORDER BY started_at DESC LIMIT ?", (limit,)
        ).fetchall()
        items = []
        for r in rows:
            d = {k: r[k] for k in _FIELDS}
            d["log_len"] = int(r["log_len"] or 0)
            d["ok"] = bool(d["ok"])
            d["cancelled"] = bool(d["cancelled"])
            items.append(d)
        return {"items": items, "total": total}
    finally:
        conn.close()


def record_log(seq: int) -> dict:
    """某条记录的完整日志。"""
    init_db()
    conn = store_conn()
    try:
        r = conn.execute("SELECT seq, rid, label, log FROM env_install_history WHERE seq=?",
                         (int(seq),)).fetchone()
        if not r:
            return {"error": "记录不存在或已清理"}
        return {"seq": int(r["seq"]), "rid": r["rid"] or "", "label": r["label"] or "",
                "log": r["log"] or ""}
    finally:
        conn.close()


def clear() -> dict:
    init_db()
    with store_tx() as conn:
        n = conn.execute("DELETE FROM env_install_history").rowcount
    return {"ok": True, "deleted": int(n or 0)}

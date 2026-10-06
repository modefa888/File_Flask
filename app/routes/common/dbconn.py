"""数据库连接工具：连接配置管理 + 多数据库浏览与查询。

支持：SQLite（标准库，无需驱动）、MySQL / MariaDB（pymysql）、PostgreSQL（psycopg2）。
没装对应驱动的类型会在「驱动」接口里标出来，前端据此禁用，而不是等到连接时才报错。

安全约定（与既有 SQLite 查看器一致）：
  · 查询一律只读 —— SQLite 用 file:...?mode=ro；MySQL/PG 只放行 SELECT/SHOW/DESC/EXPLAIN 类语句；
  · 密码用 services/common/secret.py 加密后落库，返回前端时脱敏（只留前 4 位）；
  · 表名走方言引号转义，且必须来自已列出的表，避免拼接注入。
"""
import json
import os
import sqlite3
import threading
import time
import uuid

from flask import Blueprint, jsonify, request

from ...log import get_logger
from ...services.common import secret
from ...services.common.store_db import store_conn, store_tx

bp = Blueprint("dbconn", __name__)
_log = get_logger()

_MAX_ROWS = 500                  # 单次浏览 / 查询返回的最大行数
_PAGE_DEFAULT = 100
_SQL_MAX = 20000                 # SQL 文本长度上限
_QUERY_TIMEOUT = 8               # 查询超时秒数
_CONNECT_TIMEOUT = 8             # 建连接超时秒数
_CELL_MAX = 2000                 # 单个单元格最长字符数（超出截断）

KINDS = {
    "sqlite": {"label": "SQLite", "icon": "bi-filetype-db", "need_host": False,
               "default_port": 0, "driver": "sqlite3", "hint": "填写 .db / .sqlite 文件的绝对路径"},
    "mysql": {"label": "MySQL / MariaDB", "icon": "bi-server", "need_host": True,
              "default_port": 3306, "driver": "pymysql", "hint": "默认端口 3306"},
    "postgres": {"label": "PostgreSQL", "icon": "bi-database-fill", "need_host": True,
                 "default_port": 5432, "driver": "psycopg2", "hint": "默认端口 5432"},
}

# 只读语句白名单：首关键字命中即放行（写操作交给数据库自身再拒一次）
_READ_START = ("select", "show", "desc", "describe", "explain", "with", "pragma", "table", "values")
_WRITE_WORDS = ("insert", "update", "delete", "drop", "alter", "create", "truncate", "grant",
                "revoke", "replace", "rename", "attach", "detach", "vacuum", "reindex")

_LOCK = threading.Lock()         # 连接测试/查询并发保护（驱动不一定线程安全）


# --------------------------------------------------------------------------- 驱动

def _driver_ok(mod: str) -> bool:
    try:
        __import__(mod)
        return True
    except Exception:
        return False


@bp.route("/api/db/kinds")
def api_db_kinds():
    """支持的数据库类型 + 本机驱动是否可用（前端据此禁用未装驱动的类型）"""
    out = []
    for key, meta in KINDS.items():
        ok = _driver_ok(meta["driver"])
        out.append({"kind": key, "label": meta["label"], "icon": meta["icon"],
                    "need_host": meta["need_host"], "default_port": meta["default_port"],
                    "hint": meta["hint"], "driver": meta["driver"], "ready": ok,
                    "install": "" if ok else "pip install %s" % (
                        "pymysql" if meta["driver"] == "pymysql" else "psycopg2-binary")})
    return jsonify({"kinds": out})


# --------------------------------------------------------------------------- 连接配置

def _conn_row(conf: dict, with_password: bool = False) -> dict:
    """把配置整理成前端可用的结构；默认不带明文密码"""
    pwd, need_rewrite = secret.decrypt_ex(conf.get("password") or "")
    if need_rewrite and pwd:                      # 换过密钥的老数据，顺手重加密
        try:
            with store_tx() as c:
                c.execute("UPDATE db_conns SET password=? WHERE id=?",
                          (secret.encrypt(pwd), conf["id"]))
        except Exception as e:
            _log.warning("重加密数据库密码失败：%s", e)
    out = {
        "id": conf["id"], "name": conf["name"], "kind": conf["kind"],
        "host": conf.get("host") or "", "port": int(conf.get("port") or 0),
        "username": conf.get("username") or "", "dbname": conf.get("dbname") or "",
        "params": conf.get("params") or "",
        "created_at": float(conf.get("created_at") or 0),
        "updated_at": float(conf.get("updated_at") or 0),
        "has_password": bool(pwd),
        "password_masked": secret.mask(pwd) if pwd else "",
    }
    if with_password:
        out["password"] = pwd
    return out


def _load_conf(cid: str, with_password: bool = True):
    """按 id 读一条配置（默认含明文密码），不存在返回 None"""
    if not cid:
        return None
    try:
        conn = store_conn()
        try:
            r = conn.execute("SELECT * FROM db_conns WHERE id=?", (cid,)).fetchone()
        finally:
            conn.close()
    except Exception as e:
        _log.warning("读取数据库连接失败：%s", e)
        return None
    return _conn_row(dict(r), with_password=with_password) if r else None


@bp.route("/api/db/conns", methods=["GET"])
def api_db_conns():
    """连接列表（密码脱敏）"""
    items = []
    try:
        conn = store_conn()
        try:
            rows = conn.execute("SELECT * FROM db_conns ORDER BY updated_at DESC").fetchall()
        finally:
            conn.close()
        items = [_conn_row(dict(r)) for r in rows]
    except Exception as e:
        return jsonify({"error": "读取连接列表失败：%s" % e}), 500
    return jsonify({"conns": items, "kinds": list(KINDS.keys())})


@bp.route("/api/db/conns", methods=["POST"])
def api_db_conns_save():
    """新建 / 更新一个连接。密码为空时沿用已存的那份（避免编辑时被迫重输）。"""
    data = request.get_json(silent=True) or {}
    cid = str(data.get("id") or "").strip()
    name = str(data.get("name") or "").strip()
    kind = str(data.get("kind") or "").strip()
    if kind not in KINDS:
        return jsonify({"error": "未知的数据库类型：%s" % kind}), 400
    if not name:
        return jsonify({"error": "请填写连接名称"}), 400

    host = str(data.get("host") or "").strip()
    username = str(data.get("username") or "").strip()
    dbname = str(data.get("dbname") or "").strip()
    params = str(data.get("params") or "").strip()
    try:
        port = int(data.get("port") or 0)
    except (TypeError, ValueError):
        port = 0
    if not port:
        port = KINDS[kind]["default_port"]

    if kind == "sqlite":
        if not dbname:
            return jsonify({"error": "请填写 SQLite 数据库文件路径"}), 400
        if not dbname.startswith("/"):
            return jsonify({"error": "SQLite 路径必须是绝对路径"}), 400
        if not os.path.isfile(dbname):
            return jsonify({"error": "文件不存在：%s" % dbname}), 400
    elif not host:
        return jsonify({"error": "请填写主机地址"}), 400

    pwd_raw = data.get("password")
    old = _load_conf(cid, with_password=True) if cid else None
    if cid and not old:
        return jsonify({"error": "连接不存在（可能已被删除）"}), 404
    if pwd_raw is None or str(pwd_raw) == "":
        pwd_plain = (old or {}).get("password") or ""      # 留空 = 不改密码
    else:
        pwd_plain = str(pwd_raw)

    now = time.time()
    if not cid:
        cid = uuid.uuid4().hex[:12]
    row = (cid, name, kind, host, port, username, secret.encrypt(pwd_plain), dbname, params,
           float((old or {}).get("created_at") or now), now)
    try:
        with store_tx() as conn:
            conn.execute(
                "INSERT INTO db_conns (id, name, kind, host, port, username, password, dbname, "
                "params, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?) "
                "ON CONFLICT(id) DO UPDATE SET name=excluded.name, kind=excluded.kind, "
                "host=excluded.host, port=excluded.port, username=excluded.username, "
                "password=excluded.password, dbname=excluded.dbname, params=excluded.params, "
                "updated_at=excluded.updated_at", row)
    except Exception as e:
        return jsonify({"error": "保存失败：%s" % e}), 500
    _log.info("保存数据库连接：%s（%s）", name, kind)
    return jsonify({"ok": True, "conn": _load_conf(cid, with_password=False)})


@bp.route("/api/db/conns/delete", methods=["POST"])
def api_db_conns_delete():
    """删除连接（只删配置，不碰数据库本身）"""
    data = request.get_json(silent=True) or {}
    cid = str(data.get("id") or "").strip()
    if not cid:
        return jsonify({"error": "缺少 id"}), 400
    try:
        with store_tx() as conn:
            conn.execute("DELETE FROM db_conns WHERE id=?", (cid,))
    except Exception as e:
        return jsonify({"error": "删除失败：%s" % e}), 500
    return jsonify({"ok": True})


# --------------------------------------------------------------------------- 连接（各方言）

def _open_sqlite(conf):
    path = conf.get("dbname") or ""
    if not os.path.isfile(path):
        raise RuntimeError("文件不存在：%s" % path)
    uri = "file:%s?mode=ro" % path.replace("?", "%3f").replace("#", "%23")
    conn = sqlite3.connect(uri, uri=True, timeout=_CONNECT_TIMEOUT)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout=3000")
    return conn


def _open_mysql(conf):
    import pymysql                                   # 函数内导入：没装也只是这类不可用
    from pymysql.cursors import DictCursor
    params = {"host": conf.get("host") or "127.0.0.1",
              "port": int(conf.get("port") or 3306),
              "user": conf.get("username") or "root",
              "password": conf.get("password") or "",
              "connect_timeout": _CONNECT_TIMEOUT,
              "read_timeout": _QUERY_TIMEOUT,
              "charset": "utf8mb4",
              "cursorclass": DictCursor}
    if conf.get("dbname"):
        params["database"] = conf["dbname"]
    conn = pymysql.connect(**params)
    try:                                             # 会话级只读，双保险
        with conn.cursor() as cur:
            cur.execute("SET SESSION TRANSACTION READ ONLY")
    except Exception:
        pass
    return conn


def _open_postgres(conf):
    import psycopg2
    from psycopg2.extras import RealDictCursor
    conn = psycopg2.connect(host=conf.get("host") or "127.0.0.1",
                            port=int(conf.get("port") or 5432),
                            user=conf.get("username") or "postgres",
                            password=conf.get("password") or "",
                            dbname=conf.get("dbname") or "postgres",
                            connect_timeout=_CONNECT_TIMEOUT,
                            cursor_factory=RealDictCursor)
    conn.set_session(readonly=True, autocommit=True)  # 只读事务
    return conn


def _open(conf):
    """按类型建连接。返回 (conn, kind)；失败抛异常。"""
    kind = conf.get("kind") or "sqlite"
    if kind == "sqlite":
        return _open_sqlite(conf), kind
    if kind == "mysql":
        return _open_mysql(conf), kind
    if kind == "postgres":
        return _open_postgres(conf), kind
    raise RuntimeError("不支持的数据库类型：%s" % kind)


def _quote(kind, name: str) -> str:
    """按方言转义标识符（表名 / 字段名），内部双写引号防拼接"""
    if kind == "mysql":
        return "`" + str(name).replace("`", "``") + "`"
    return '"' + str(name).replace('"', '""') + '"'


def _cell(v):
    """单元格取值：二进制 / 超长文本做可读化处理"""
    if v is None or isinstance(v, (int, float, bool)):
        return v
    if isinstance(v, (bytes, bytearray, memoryview)):
        b = bytes(v)
        return "<%d 字节二进制>" % len(b)
    try:                                             # 日期 / Decimal 等统一转字符串
        s = v if isinstance(v, str) else str(v)
    except Exception:
        s = repr(v)
    return s[:_CELL_MAX] + ("…（已截断）" if len(s) > _CELL_MAX else "")


def _rows_of(cur, kind):
    """把游标结果读成 (列名, 行列表)；兼容 DictCursor 与 sqlite3.Row"""
    if kind == "sqlite":
        cols = [d[0] for d in (cur.description or [])]
        return cols, [[_cell(v) for v in r] for r in cur.fetchall()]
    rows = cur.fetchall() or []
    if rows and isinstance(rows[0], dict):
        cols = list(rows[0].keys())
        return cols, [[_cell(r.get(c)) for c in cols] for r in rows]
    cols = [d[0] for d in (cur.description or [])]
    return cols, [[_cell(v) for v in r] for r in rows]


def _timeout_guard(conn, kind):
    """SQLite 用 progress_handler 限时；MySQL/PG 靠驱动自身的 read_timeout"""
    if kind != "sqlite":
        return
    t0 = time.time()
    try:
        conn.set_progress_handler(lambda: 1 if time.time() - t0 > _QUERY_TIMEOUT else 0, 2000)
    except Exception:
        pass


def _pick(conf, dbname=None):
    """复制一份配置（可覆盖库名），用于「同一个连接换库浏览」"""
    c = dict(conf)
    if dbname:
        c["dbname"] = dbname
    return c


# --------------------------------------------------------------------------- 结构 / 数据

def _list_tables(cur, kind, dbname=""):
    """列出表：返回 [{name, schema, kind, rows}]"""
    out = []
    if kind == "sqlite":
        cur.execute("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') "
                    "AND name NOT LIKE 'sqlite_%' ORDER BY name")
        for name, typ in cur.fetchall():
            rows = None
            try:
                cur.execute("SELECT COUNT(*) FROM %s" % _quote(kind, name))
                rows = cur.fetchone()[0]
            except Exception:
                pass
            out.append({"name": name, "schema": "main", "kind": typ or "table", "rows": rows})
        return out
    if kind == "mysql":
        cur.execute("SELECT table_schema, table_name, table_type, table_rows "
                    "FROM information_schema.tables WHERE table_schema = %s "
                    "ORDER BY table_name", (dbname or "",))
        for r in cur.fetchall():
            vals = list(r.values()) if isinstance(r, dict) else list(r)
            out.append({"schema": vals[0], "name": vals[1], "kind": vals[2] or "BASE TABLE",
                        "rows": vals[3]})
        return out
    cur.execute("SELECT table_schema, table_name, table_type FROM information_schema.tables "
                "WHERE table_schema NOT IN ('pg_catalog','information_schema') "
                "ORDER BY table_schema, table_name")
    for r in cur.fetchall():
        vals = list(r.values()) if isinstance(r, dict) else list(r)
        out.append({"schema": vals[0], "name": vals[1], "kind": vals[2] or "BASE TABLE", "rows": None})
    return out


def _list_databases(cur, kind, conf):
    """列出可切换的库：SQLite 只有一个（即文件本身）"""
    if kind == "sqlite":
        return [{"name": os.path.basename(conf.get("dbname") or ""), "current": True}]
    if kind == "mysql":
        cur.execute("SHOW DATABASES")
        names = [list(r.values())[0] if isinstance(r, dict) else r[0] for r in cur.fetchall()]
    else:
        cur.execute("SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname")
        names = [list(r.values())[0] if isinstance(r, dict) else r[0] for r in cur.fetchall()]
    cur_db = conf.get("dbname") or ""
    return [{"name": n, "current": n == cur_db} for n in names]


def _table_ref(kind, dbname, schema, table):
    """拼「库.表」引用；SQLite 直接用表名"""
    if kind == "sqlite":
        return _quote(kind, table)
    if kind == "mysql":
        return "%s.%s" % (_quote(kind, dbname), _quote(kind, table))
    return "%s.%s" % (_quote(kind, schema or "public"), _quote(kind, table))


def _readonly_guard(sql: str):
    """只读校验：返回错误文案，通过则返回空串"""
    s = str(sql or "").strip().rstrip(";").strip()
    if not s:
        return "SQL 不能为空"
    if len(s) > _SQL_MAX:
        return "SQL 过长（上限 %d 字符）" % _SQL_MAX
    # 去掉注释行再判断首关键字，避免 "-- xxx\nselect" 被误判
    lines = [ln for ln in s.splitlines() if ln.strip() and not ln.strip().startswith("--")]
    body = " ".join(lines).strip()
    if ";" in body.rstrip(";"):
        return "不支持一次执行多条语句"
    first = body.split(None, 1)[0].lower() if body else ""
    if first not in _READ_START:
        return "只允许只读查询（%s 开头）；写操作请到数据库客户端执行" % first
    low = " " + body.lower() + " "
    for w in _WRITE_WORDS:
        if " " + w + " " in low:
            return "检测到写操作关键字「%s」，已拒绝执行" % w
    return ""


# --------------------------------------------------------------------------- 接口

@bp.route("/api/db/test", methods=["POST"])
def api_db_test():
    """测试连接。可直接传配置（未保存也能测），也可只传 id 用已存的配置。"""
    data = request.get_json(silent=True) or {}
    cid = str(data.get("id") or "").strip()
    if cid and not data.get("kind"):
        conf = _load_conf(cid, with_password=True)
        if not conf:
            return jsonify({"error": "连接不存在"}), 404
    else:
        kind = str(data.get("kind") or "")
        if kind not in KINDS:
            return jsonify({"error": "未知的数据库类型：%s" % kind}), 400
        old = _load_conf(cid, with_password=True) if cid else None
        pwd = data.get("password")
        if pwd is None or str(pwd) == "":
            pwd = (old or {}).get("password") or ""
        conf = {"kind": kind, "host": str(data.get("host") or "").strip(),
                "port": int(data.get("port") or 0) or KINDS[kind]["default_port"],
                "username": str(data.get("username") or "").strip(),
                "password": str(pwd), "dbname": str(data.get("dbname") or "").strip()}
    t0 = time.time()
    try:
        with _LOCK:
            conn, kind = _open(conf)
            try:
                cur = conn.cursor()
                if kind == "sqlite":
                    cur.execute("SELECT COUNT(*) FROM sqlite_master")
                    cur.fetchone()
                    ver = "SQLite " + sqlite3.sqlite_version
                elif kind == "mysql":
                    cur.execute("SELECT VERSION()")
                    r = cur.fetchone()
                    ver = "MySQL " + str(list(r.values())[0] if isinstance(r, dict) else r[0])
                else:
                    cur.execute("SHOW server_version")
                    r = cur.fetchone()
                    ver = "PostgreSQL " + str(list(r.values())[0] if isinstance(r, dict) else r[0])
            finally:
                try:
                    conn.close()
                except Exception:
                    pass
    except Exception as e:
        return jsonify({"ok": False, "error": "连接失败：%s" % e}), 200
    return jsonify({"ok": True, "version": ver, "elapsed_ms": int((time.time() - t0) * 1000)})


@bp.route("/api/db/schema", methods=["GET"])
def api_db_schema():
    """结构浏览：可切换的库列表 + 当前库的表列表（含行数估算）"""
    cid = str(request.args.get("conn") or "")
    dbname = str(request.args.get("dbname") or "")
    conf = _load_conf(cid, with_password=True)
    if not conf:
        return jsonify({"error": "连接不存在"}), 404
    use = _pick(conf, dbname)
    try:
        with _LOCK:
            conn, kind = _open(use)
            try:
                cur = conn.cursor()
                dbs = _list_databases(cur, kind, use)
                tables = _list_tables(cur, kind, use.get("dbname") or "")
            finally:
                try:
                    conn.close()
                except Exception:
                    pass
    except Exception as e:
        return jsonify({"error": "读取结构失败：%s" % e}), 500
    return jsonify({"kind": kind, "dbname": use.get("dbname") or "",
                    "databases": dbs, "tables": tables})


@bp.route("/api/db/rows", methods=["GET"])
def api_db_rows():
    """表数据分页浏览"""
    cid = str(request.args.get("conn") or "")
    dbname = str(request.args.get("dbname") or "")
    schema = str(request.args.get("schema") or "")
    table = str(request.args.get("table") or "")
    if not table:
        return jsonify({"error": "缺少表名"}), 400
    try:
        limit = min(max(int(request.args.get("limit", _PAGE_DEFAULT)), 1), _MAX_ROWS)
        offset = max(int(request.args.get("offset", 0)), 0)
    except (TypeError, ValueError):
        limit, offset = _PAGE_DEFAULT, 0
    conf = _load_conf(cid, with_password=True)
    if not conf:
        return jsonify({"error": "连接不存在"}), 404
    use = _pick(conf, dbname)
    try:
        with _LOCK:
            conn, kind = _open(use)
            try:
                cur = conn.cursor()
                names = {t["name"] for t in _list_tables(cur, kind, use.get("dbname") or "")}
                if table not in names:               # 表名必须真实存在，避免拼接注入
                    return jsonify({"error": "表不存在：%s" % table}), 404
                ref = _table_ref(kind, use.get("dbname") or "", schema, table)
                total = None
                try:
                    cur.execute("SELECT COUNT(*) FROM %s" % ref)
                    row = cur.fetchone()
                    total = list(row.values())[0] if isinstance(row, dict) else row[0]
                except Exception:
                    pass
                cur.execute("SELECT * FROM %s LIMIT %d OFFSET %d" % (ref, limit, offset))
                cols, rows = _rows_of(cur, kind)
            finally:
                try:
                    conn.close()
                except Exception:
                    pass
    except Exception as e:
        return jsonify({"error": "读取数据失败：%s" % e}), 500
    return jsonify({"table": table, "columns": cols, "rows": rows,
                    "total": total, "limit": limit, "offset": offset})


@bp.route("/api/db/query", methods=["POST"])
def api_db_query():
    """执行只读 SQL"""
    data = request.get_json(silent=True) or {}
    cid = str(data.get("conn") or "")
    sql = str(data.get("sql") or "")
    dbname = str(data.get("dbname") or "")
    bad = _readonly_guard(sql)
    if bad:
        return jsonify({"error": bad}), 400
    try:
        limit = min(max(int(data.get("limit") or _PAGE_DEFAULT), 1), _MAX_ROWS)
    except (TypeError, ValueError):
        limit = _PAGE_DEFAULT
    conf = _load_conf(cid, with_password=True)
    if not conf:
        return jsonify({"error": "连接不存在"}), 404
    use = _pick(conf, dbname)
    t0 = time.time()
    try:
        with _LOCK:
            conn, kind = _open(use)
            try:
                _timeout_guard(conn, kind)
                cur = conn.cursor()
                cur.execute(sql.rstrip(";"))
                cols, rows = _rows_of(cur, kind)
            finally:
                try:
                    conn.close()
                except Exception:
                    pass
    except Exception as e:
        msg = str(e)
        if "readonly" in msg.lower() or "read-only" in msg.lower():
            msg = "该连接是只读的，不能执行写操作（%s）" % msg
        return jsonify({"error": "执行失败：%s" % msg}), 400
    truncated = len(rows) > limit
    return jsonify({"columns": cols, "rows": rows[:limit], "row_count": len(rows),
                    "truncated": truncated, "limit": limit,
                    "elapsed_ms": int((time.time() - t0) * 1000)})

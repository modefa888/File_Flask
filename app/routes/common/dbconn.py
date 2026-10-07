"""数据库连接工具：连接配置管理 + 多数据库浏览与查询。

支持：SQLite（标准库，无需驱动）、MySQL / MariaDB（pymysql）、PostgreSQL（psycopg2）、
      Redis（redis）、MongoDB（pymongo）。
没装对应驱动的类型会在「驱动」接口里标出来，前端据此禁用，而不是等到连接时才报错。

安全约定（与既有 SQLite 查看器一致）：
  · 查询一律只读 —— SQLite 用 file:...?mode=ro；MySQL/PG 只放行 SELECT/SHOW/DESC/EXPLAIN 类语句；
    Redis 只放行读取类命令；MongoDB 只做 find，并拒绝 $where 等可执行脚本的操作符；
  · 密码用 services/common/secret.py 加密后落库，返回前端时脱敏（只留前 4 位）；
  · 表名走方言引号转义，且必须来自已列出的表，避免拼接注入。
"""
import json
import os
import re
import shlex
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
_NL_MAX = 500                    # 「一句话生成 SQL」描述长度上限
_NL_TIMEOUT = 60                 # 调 AI 生成 SQL 的超时秒数
_NL_CTX = 40000                  # 提示词总长度上限（表结构 + 需求）
_NL_TABLES = 60                  # 表结构最多提供给 AI 的表数
_NOSQL_LIST_MAX = 300            # Redis key / 列表类浏览一次最多列出多少条

KINDS = {
    "sqlite": {"label": "SQLite", "icon": "bi-filetype-sql", "need_host": False,
               "default_port": 0, "driver": "sqlite3", "pip": "",
               "hint": "填写 .db / .sqlite 文件的绝对路径"},
    "mysql": {"label": "MySQL / MariaDB", "icon": "bi-server", "need_host": True,
              "default_port": 3306, "driver": "pymysql", "pip": "pymysql", "hint": "默认端口 3306"},
    "postgres": {"label": "PostgreSQL", "icon": "bi-database-fill", "need_host": True,
                 "default_port": 5432, "driver": "psycopg2", "pip": "psycopg2-binary",
                 "hint": "默认端口 5432"},
    "redis": {"label": "Redis", "icon": "bi-lightning-charge", "need_host": True,
              "default_port": 6379, "driver": "redis", "pip": "redis",
              "hint": "默认端口 6379；「库名」填 0-15 的库序号，留空为 0"},
    "mongodb": {"label": "MongoDB", "icon": "bi-collection-fill", "need_host": True,
                "default_port": 27017, "driver": "pymongo", "pip": "pymongo",
                "hint": "默认端口 27017；「库名」可留空，连上后再选库"},
}
# 非关系型：不走 SQL 那套（库表/行/SQL 语句），浏览与查询各自单独实现
_NOSQL = ("redis", "mongodb")
_SQLITE_EXTS = (".db", ".sqlite", ".sqlite3", ".db3")   # 「一句话生成」按路径直连时的后缀白名单

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
                    "install": "" if (ok or not meta.get("pip")) else "pip install %s" % meta["pip"]})
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

def _open_sqlite(conf, writable=False):
    path = conf.get("dbname") or ""
    if not os.path.isfile(path):
        raise RuntimeError("文件不存在：%s" % path)
    # 默认只读（mode=ro）；只有「编辑行」保存时才以可写方式打开
    uri = "file:%s" % path.replace("?", "%3f").replace("#", "%23")
    if not writable:
        uri += "?mode=ro"
    conn = sqlite3.connect(uri, uri=True, timeout=_CONNECT_TIMEOUT)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout=3000")
    return conn


def _open_mysql(conf, writable=False):
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
    if not writable:
        try:                                         # 会话级只读，双保险
            with conn.cursor() as cur:
                cur.execute("SET SESSION TRANSACTION READ ONLY")
        except Exception:
            pass
    return conn


def _open_postgres(conf, writable=False):
    import psycopg2
    from psycopg2.extras import RealDictCursor
    conn = psycopg2.connect(host=conf.get("host") or "127.0.0.1",
                            port=int(conf.get("port") or 5432),
                            user=conf.get("username") or "postgres",
                            password=conf.get("password") or "",
                            dbname=conf.get("dbname") or "postgres",
                            connect_timeout=_CONNECT_TIMEOUT,
                            cursor_factory=RealDictCursor)
    conn.set_session(readonly=not writable, autocommit=True)   # 只读事务（保存时放开）
    return conn


def _open_redis(conf):
    import redis                                     # 函数内导入：没装也只是这类不可用
    try:
        db = int(conf.get("dbname") or 0)
    except (TypeError, ValueError):
        db = 0
    r = redis.Redis(host=conf.get("host") or "127.0.0.1",
                    port=int(conf.get("port") or 6379),
                    username=conf.get("username") or None,
                    password=conf.get("password") or None,
                    db=max(0, db),
                    decode_responses=True,           # 直接给字符串，省去逐处 decode
                    socket_connect_timeout=_CONNECT_TIMEOUT,
                    socket_timeout=_QUERY_TIMEOUT)
    r.ping()                                         # 连不上时立刻报错，而不是等到第一次命令
    return r


def _sasl_bad_char(s):
    """按 SASLprep（RFC 4013）找出第一个不被允许的字符，没有则返回 None。

    MongoDB 的 SCRAM 认证会对用户名 / 密码做 SASLprep 校验，一旦命中禁止字符，
    pymongo 只会回一句笼统的『SASLprep: failed prohibited character check』。
    这里把具体字符找出来（常见于复制密码时带进来的零宽字符等不可见字符），便于定位。
    """
    import stringprep
    import unicodedata
    if not s:
        return None
    mapped = []
    for ch in s:
        if stringprep.in_table_c12(ch):          # 非 ASCII 空格 → 普通空格
            mapped.append(" ")
        elif stringprep.in_table_b1(ch):         # 「映射为无」→ 直接删除
            continue
        else:
            mapped.append(ch)
    for ch in unicodedata.normalize("NFKC", "".join(mapped)):
        if (stringprep.in_table_a1(ch) or stringprep.in_table_c12(ch)
                or stringprep.in_table_c21_c22(ch) or stringprep.in_table_c3(ch)
                or stringprep.in_table_c4(ch) or stringprep.in_table_c5(ch)
                or stringprep.in_table_c6(ch) or stringprep.in_table_c7(ch)
                or stringprep.in_table_c8(ch) or stringprep.in_table_c9(ch)):
            return ch
    return None


def _open_mongo(conf):
    import pymongo
    from urllib.parse import quote_plus
    host = conf.get("host") or "127.0.0.1"
    port = int(conf.get("port") or 27017)
    user = conf.get("username") or ""
    pwd = conf.get("password") or ""
    auth = ("%s:%s@" % (quote_plus(user), quote_plus(pwd))) if user else ""
    uri = "mongodb://%s%s:%d/" % (auth, host, port)
    client = pymongo.MongoClient(uri,
                                 serverSelectionTimeoutMS=_CONNECT_TIMEOUT * 1000,
                                 connectTimeoutMS=_CONNECT_TIMEOUT * 1000,
                                 socketTimeoutMS=_QUERY_TIMEOUT * 1000)
    try:
        client.admin.command("ping")                 # 连不上时立刻报错
    except Exception as e:
        msg = str(e)
        if "saslprep" in msg.lower():                # 把「哪个字符不合法」翻译出来
            for label, val in (("密码", pwd), ("用户名", user)):
                bad = _sasl_bad_char(val)
                if bad is not None:
                    raise RuntimeError(
                        "%s；%s里含 SASLprep 不允许的字符 U+%04X（控制字符 / 显示类不可见字符，"
                        "或 Unicode 3.2 之后新增的字符如 emoji；多为复制密码时带进来的），请重新输入"
                        % (msg, label, ord(bad)))
        raise
    return client


def _open(conf, writable=False):
    """按类型建连接。返回 (conn, kind)；失败抛异常。

    writable=True 只用于「编辑行 → 保存」；浏览 / 查询一律走默认的只读连接。
    """
    kind = conf.get("kind") or "sqlite"
    if kind == "sqlite":
        return _open_sqlite(conf, writable), kind
    if kind == "mysql":
        return _open_mysql(conf, writable), kind
    if kind == "postgres":
        return _open_postgres(conf, writable), kind
    if kind == "redis":
        return _open_redis(conf), kind
    if kind == "mongodb":
        return _open_mongo(conf), kind
    raise RuntimeError("不支持的数据库类型：%s" % kind)


def _close(conn, kind=""):
    """所有类型统一收尾（Redis / Mongo 的 close 语义不同，但都叫 close）"""
    try:
        conn.close()
    except Exception:
        pass


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


# --------------------------------------------------------------- 一句话生成 SQL

_NL_SYS = (
    "你是 {dialect} 查询生成器。根据用户的一句话需求和给定的数据库结构，"
    "生成一条可直接执行的 {dialect} 只读查询语句。\n"
    "硬性要求：\n"
    "1. 只输出 SQL 本身：不要解释、不要 Markdown 代码块、不要用 ``` 包裹、不要输出多条语句；\n"
    "2. 只允许查询（SELECT / WITH / SHOW / DESC / EXPLAIN 等），严禁 INSERT / UPDATE / DELETE / "
    "DROP / ALTER / CREATE 等写操作；\n"
    "3. 只能使用结构中确实存在的表名与字段名，不要臆造；\n"
    "4. 不确定或需求无法满足时，只输出一行以「-- 」开头的简短原因说明；\n"
    "5. 合理使用 LIMIT 限制返回行数。"
)

_NL_SYS_REDIS = (
    "你是 Redis 查询生成器。根据用户的一句话需求和给定的 key 结构，生成一条可直接执行的 Redis 只读命令。\n"
    "硬性要求：\n"
    "1. 只输出一条命令本身：不要解释、不要 Markdown 代码块、不要用 ``` 包裹；\n"
    "2. 只允许读取类命令（GET / MGET / HGET / HGETALL / HKEYS / HVALS / LRANGE / LLEN / SMEMBERS / "
    "SCARD / ZRANGE / ZSCORE / TYPE / TTL / EXISTS / STRLEN / HLEN / DBSIZE / XRANGE 等），"
    "严禁 SET / DEL / EXPIRE / HSET / LPUSH / SADD / FLUSHDB 等写操作；\n"
    "3. key 只能来自给定的示例或用户明确提到的名字，不要臆造；\n"
    "4. 不确定或需求无法满足时，只输出一行以「-- 」开头的简短原因说明；\n"
    "5. 需要遍历 key 时用 SCAN，不要用 KEYS。\n"
    "示例：用户问「user:1 里存了什么」→ 输出 HGETALL user:1"
)

_NL_SYS_MONGO = (
    "你是 MongoDB 查询生成器。根据用户的一句话需求和给定的集合结构，生成一个用于 find 的 JSON。\n"
    "硬性要求：\n"
    "1. 只输出 JSON 本身：不要解释、不要 Markdown 代码块、不要用 ``` 包裹；\n"
    "2. 支持的形式：{\"collection\": \"集合名\", \"filter\": {...}, \"sort\": {\"字段\": -1}, "
    "\"projection\": {...}, \"limit\": 50, \"skip\": 0}；也可以只给一个过滤对象 {...}；\n"
    "3. 用户点名了集合（如「用户表」「users 集合」）时，必须用 collection 指明，且取自结构里真实的集合名；"
    "没点名时可以省略 collection，由调用方用「当前选中的集合」；\n"
    "4. 只做查询，严禁 $where / $function / $accumulator / $out / $merge 等可执行或写入的操作符；\n"
    "5. 字段名只能来自采样文档中出现过的，不要臆造；\n"
    "6. 不确定或需求无法满足时，只输出一行以「-- 」开头的简短原因说明；\n"
    "7. 合理设置 limit（不超过 200）。\n"
    "示例：用户问「查询用户表」→ 输出 {\"collection\": \"users\", \"filter\": {}, \"limit\": 200}\n"
    "注意：必须输出 JSON，不要输出 db.集合.find(...) 这类 shell 写法。"
)


def _row_vals(r):
    """统一取值：DictCursor 给 dict、sqlite3 给 Row/元组，都转成列表"""
    return list(r.values()) if isinstance(r, dict) else list(r)


def _schema_text(cur, kind, dbname=""):
    """把库结构整理成给 AI 看的文本（表名 + 字段，超长截断），兼容各数据库方言"""
    parts = []
    if kind == "sqlite":
        cur.execute("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') "
                    "AND name NOT LIKE 'sqlite_%' ORDER BY name")
        rows = [_row_vals(r) for r in cur.fetchall()]
        for name, typ in rows[:_NL_TABLES]:
            try:
                cols = [_row_vals(c) for c in cur.execute("PRAGMA table_info(%s)" % _quote(kind, name)).fetchall()]
                cdefs = ", ".join("%s %s" % (c[1], c[2] or "") for c in cols)
            except Exception:
                cdefs = ""
            parts.append("-- %s %s\n%s(%s)" % (typ or "table", name, name, cdefs))
    elif kind == "mysql":
        cur.execute("SELECT table_name, column_name, column_type, column_key "
                    "FROM information_schema.columns WHERE table_schema = %s "
                    "ORDER BY table_name, ordinal_position", (dbname or "",))
        groups = {}
        for r in cur.fetchall():
            tn, cn, ct, ck = _row_vals(r)[:4]
            groups.setdefault(tn, []).append("%s %s%s" % (cn, ct, " PK" if ck == "PRI" else ""))
        for i, (tn, cols) in enumerate(groups.items()):
            if i >= _NL_TABLES:
                break
            parts.append("%s(%s)" % (tn, ", ".join(cols)))
    else:  # postgres
        cur.execute("SELECT table_schema, table_name, column_name, data_type "
                    "FROM information_schema.columns "
                    "WHERE table_schema NOT IN ('pg_catalog','information_schema') "
                    "ORDER BY table_schema, table_name, ordinal_position")
        groups = {}
        for r in cur.fetchall():
            sc, tn, cn, dt = _row_vals(r)[:4]
            key = tn if sc == "public" else "%s.%s" % (sc, tn)
            groups.setdefault(key, []).append("%s %s" % (cn, dt))
        for i, (tn, cols) in enumerate(groups.items()):
            if i >= _NL_TABLES:
                break
            parts.append("%s(%s)" % (tn, ", ".join(cols)))
    return "\n".join(parts)


def _first_semi(line: str):
    """行内「字符串字面量之外」的第一个分号位置；行内注释之后的分号不算，没有则 None"""
    q = None
    i = 0
    while i < len(line):
        ch = line[i]
        if q:
            if ch == q:
                if q == "'" and line[i + 1:i + 2] == "'":     # '' 是转义的单引号
                    i += 2
                    continue
                q = None
        elif ch in ("'", '"', "`"):
            q = ch
        elif ch == "-" and line[i + 1:i + 2] == "-":
            return None
        elif ch == ";":
            return i
        i += 1
    return None


def _clean_sql(text: str) -> str:
    """从模型输出里抠出 SQL：去代码围栏、去前缀说明、截到第一条语句结尾"""
    s = (text or "").strip()
    m = re.search(r"```(?:sql)?\s*(.+?)(?:```|\Z)", s, re.S | re.I)
    if m:
        s = m.group(1).strip()
    lines = s.splitlines()
    start = next((i for i, ln in enumerate(lines)
                  if re.match(r"^\s*(select|with|show|desc|describe|explain|table|values|--)", ln, re.I)), None)
    if start is None:
        return ""       # 通篇不含 SQL：交给上层提示「没有返回可用的 SQL」
    out = []
    for ln in lines[start:]:
        cut = _first_semi(ln)
        if cut is not None:                   # 到第一条语句结尾即停，丢掉后面的解释
            out.append(ln[:cut + 1])
            break
        out.append(ln)
    return "\n".join(out).strip()[:_SQL_MAX]


# ----------------------------------------------------------- 非关系型库（Redis / MongoDB）

# Redis 只读命令白名单（只放行「读取」类，避免误改数据）
_REDIS_READ = {
    "type", "ttl", "pttl", "exists", "dbsize", "randomkey", "scan", "keys", "object", "memory",
    "dump", "strlen", "getrange", "get", "mget", "bitcount", "getbit", "bitpos",
    "hget", "hmget", "hgetall", "hkeys", "hvals", "hlen", "hexists", "hscan", "hstrlen",
    "lrange", "llen", "lindex", "lpos",
    "smembers", "scard", "sismember", "smismember", "srandmember", "sscan",
    "sinter", "sunion", "sdiff", "sintercard",
    "zrange", "zrevrange", "zrangebyscore", "zrevrangebyscore", "zrangebylex", "zlexcount",
    "zscore", "zmscore", "zcard", "zcount", "zrank", "zrevrank", "zscan",
    "info", "ping", "echo", "time", "xrange", "xrevrange", "xlen", "xinfo",
}


def _redis_db_index(conf):
    try:
        return max(0, int(conf.get("dbname") or 0))
    except (TypeError, ValueError):
        return 0


def _redis_databases(r, conf):
    """可切换的库：Redis 按序号划分（默认 16 个）"""
    try:
        n = int((r.config_get("databases") or {}).get("databases") or 16)
    except Exception:
        n = 16
    n = max(1, min(n, 64))
    cur = _redis_db_index(conf)
    return [{"name": str(i), "current": i == cur} for i in range(n)]


def _redis_keys(r, limit=_NOSQL_LIST_MAX):
    """列出 key（SCAN 渐进扫描，最多 limit 条）；顺带用一次 pipeline 取每个 key 的类型"""
    keys, cursor = [], 0
    try:
        while True:
            cursor, batch = r.scan(cursor=cursor, count=200)
            keys.extend(batch)
            if cursor == 0 or len(keys) >= limit:
                break
    except Exception:
        pass
    keys = sorted(keys[:limit])
    types = [None] * len(keys)
    if keys:
        try:
            pipe = r.pipeline(transaction=False)
            for k in keys:
                pipe.type(k)
            types = pipe.execute()
        except Exception:
            pass
    return [{"name": k, "schema": "", "kind": "key",
             "rows": types[i] if i < len(types) else None} for i, k in enumerate(keys)]


def _redis_key_total(r, key, t):
    try:
        if t == "string":
            return 1
        if t == "hash":
            return int(r.hlen(key))
        if t == "list":
            return int(r.llen(key))
        if t == "set":
            return int(r.scard(key))
        if t == "zset":
            return int(r.zcard(key))
    except Exception:
        pass
    return None


def _redis_rows(r, key, limit, offset):
    """把某个 key 的值摊平成「列 + 行」（按类型分别处理）"""
    t = r.type(key)
    if t == "none":
        return ["结果"], [["<key 不存在>"]], 0
    if t == "string":
        return ["字段", "值"], [["value", r.get(key)]], 1
    if t == "hash":
        items = list(r.hgetall(key).items())
        return ["字段", "值"], [[k, v] for k, v in items[offset:offset + limit]], len(items)
    if t == "list":
        vals = r.lrange(key, offset, offset + limit - 1)
        return ["索引", "值"], [[offset + i, v] for i, v in enumerate(vals)], _redis_key_total(r, key, t)
    if t == "set":                                   # 集合无序：用 SSCAN 逐段翻页
        out, cursor, skip = [], 0, offset
        while len(out) < limit:
            cursor, batch = r.sscan(key, cursor=cursor, count=200)
            for m in batch:
                if skip > 0:
                    skip -= 1
                    continue
                out.append(m)
                if len(out) >= limit:
                    break
            if cursor == 0:
                break
        return ["成员"], [[m] for m in out], _redis_key_total(r, key, t)
    if t == "zset":
        vals = r.zrange(key, offset, offset + limit - 1, withscores=True)
        return ["成员", "分数"], [[m, s] for m, s in vals], _redis_key_total(r, key, t)
    if t == "stream":
        return ["值"], [["<stream 请在命令区用 XRANGE 查询>"]], None
    return ["值"], [["<暂不支持浏览的 key 类型：%s>" % t]], None


def _redis_render(v):
    """把 Redis 命令的返回值整理成表格"""
    if v is None:
        return ["结果"], [["(nil)"]]
    if isinstance(v, bool):
        return ["结果"], [[int(v)]]
    if isinstance(v, (str, int, float)):
        return ["结果"], [[v]]
    if isinstance(v, dict):
        return ["字段", "值"], [[k, _cell(x)] for k, x in v.items()]
    if isinstance(v, (list, tuple)):
        if v and all(isinstance(x, (list, tuple)) and len(x) == 2 for x in v):
            return ["项", "值"], [[_cell(a), _cell(b)] for a, b in v]
        return ["结果"], [[_cell(x)] for x in v]
    return ["结果"], [[_cell(v)]]


def _mongo_cell(v):
    """MongoDB 取值：文档 / 数组 / ObjectId 等统一转成可读文本"""
    if v is None or isinstance(v, (int, float, bool)):
        return v
    if isinstance(v, str):
        return v[:_CELL_MAX] + ("…（已截断）" if len(v) > _CELL_MAX else "")
    try:
        s = json.dumps(v, default=str, ensure_ascii=False)
    except Exception:
        s = str(v)
    return s[:_CELL_MAX] + ("…（已截断）" if len(s) > _CELL_MAX else "")


def _mongo_pick_db(names, want):
    """挑一个可用的库：优先请求的，其次第一个非系统库"""
    if want and want in names:
        return want
    return next((n for n in names if n not in ("admin", "local", "config")),
                names[0] if names else "")


def _nosql_schema(conn, kind, use):
    """非关系型库的结构：Redis → 编号库 + key；MongoDB → 库 + 集合。返回 (dbs, tables, dbname)"""
    if kind == "redis":
        return _redis_databases(conn, use), _redis_keys(conn), str(_redis_db_index(use))
    try:
        names = sorted(conn.list_database_names())
    except Exception:
        names = []
    dbname = _mongo_pick_db(names, use.get("dbname") or "")
    tables = []
    if dbname:
        try:
            colls = sorted(conn[dbname].list_collection_names())
        except Exception:
            colls = []
        if len(colls) <= _NL_TABLES:                 # 集合不多时顺带带上文档数
            for name in colls:
                n = None
                try:
                    n = int(conn[dbname][name].estimated_document_count())
                except Exception:
                    pass
                tables.append({"name": name, "schema": dbname, "kind": "collection", "rows": n})
        else:
            tables = [{"name": name, "schema": dbname, "kind": "collection", "rows": None}
                      for name in colls]
    return [{"name": n, "current": n == dbname} for n in names], tables, dbname


def _nosql_rows(conn, kind, use, table, limit, offset):
    """非关系型库的数据行：Redis → 某个 key 的值；MongoDB → 某个集合的文档"""
    if kind == "redis":
        return _redis_rows(conn, table, limit, offset)
    coll = conn[use.get("dbname") or ""][table]
    total = None
    try:
        total = int(coll.estimated_document_count())
    except Exception:
        pass
    docs = list(coll.find({}).skip(offset).limit(limit))
    cols = []
    for d in docs:
        for k in d.keys():
            if k not in cols:
                cols.append(k)                       # 列取所有文档键的并集（保持出现顺序）
    return cols, [[_mongo_cell(d.get(c)) for c in cols] for d in docs], total


def _nosql_query(conn, kind, use, table, text, limit):
    """非关系型库的「查询」：Redis → 只读命令；MongoDB → 集合上的 JSON 过滤。

    返回 (列, 行, 实际使用的集合)：MongoDB 时第三项是真正查的集合名（供前端回显 / 同步选中），
    Redis 没有集合概念，固定返回空串。
    """
    if kind == "redis":
        parts = shlex.split(text)                    # 支持带引号的参数
        if not parts:
            raise RuntimeError("命令不能为空")
        cmd = parts[0].lower()
        if cmd not in _REDIS_READ:
            raise RuntimeError("只允许读取类命令，「%s」不在白名单内" % cmd)
        cols, rows = _redis_render(conn.execute_command(*parts))
        return cols, rows, ""
    text = (text or "").strip()
    if not text:
        spec = {}                                    # 空 = 无条件，取全部文档
    else:
        try:
            spec = json.loads(text)
        except Exception:
            raise RuntimeError('查询必须是合法的 JSON，例如 {"filter": {"status": 1}, "limit": 50}')
    if not isinstance(spec, dict):
        raise RuntimeError("查询必须是一个 JSON 对象")
    raw = json.dumps(spec, ensure_ascii=False)
    for bad in ("$where", "$function", "$accumulator", "$out", "$merge"):
        if bad in raw:
            raise RuntimeError("查询里含有不允许的操作符：%s" % bad)
    # 集合：JSON 里写了 collection 就用它，没写就用左侧选中的那个
    coll = str(spec.get("collection") or table or "")
    if not coll:
        raise RuntimeError("请先在左侧选择一个集合，或在 JSON 里用 collection 指定")
    dbname = use.get("dbname") or ""
    if coll not in conn[dbname].list_collection_names():
        raise RuntimeError("集合不存在：%s" % coll)
    if set(spec) & {"filter", "sort", "projection", "limit", "skip"}:
        flt = spec.get("filter") or {}
        sort, proj = spec.get("sort"), spec.get("projection")
        try:
            lim = max(1, min(int(spec.get("limit") or limit), _MAX_ROWS))
            skip = max(0, int(spec.get("skip") or 0))
        except (TypeError, ValueError):
            lim, skip = limit, 0
    else:                                            # 没写这些键时，整个对象就当过滤条件
        flt, sort, proj, lim, skip = spec, None, None, limit, 0
    if isinstance(flt, dict):
        flt.pop("collection", None)                  # 别把 collection 当成过滤字段
    kwargs = {}
    if flt:
        kwargs["filter"] = flt
    if proj:
        kwargs["projection"] = proj
    cur = conn[dbname][coll].find(**kwargs)
    if sort:
        cur = cur.sort([(k, 1 if v not in (-1, "-1") else -1) for k, v in sort.items()])
    docs = list(cur.skip(skip).limit(lim))
    cols = []
    for d in docs:
        for k in d.keys():
            if k not in cols:
                cols.append(k)
    return cols, [[_mongo_cell(d.get(c)) for c in cols] for d in docs], coll


# ------------------------------------------------------------ 编辑行（按主键 / _id 更新）

def _pk_columns(cur, kind, dbname, schema, table):
    """取主键列名（编辑行时用来定位），没有主键返回 []"""
    try:
        if kind == "sqlite":
            rows = cur.execute("PRAGMA table_info(%s)" % _quote(kind, table)).fetchall()
            return [r[1] for r in sorted((r for r in rows if r[5]), key=lambda r: r[5])]
        if kind == "mysql":
            cur.execute("SELECT column_name FROM information_schema.key_column_usage "
                        "WHERE table_schema = %s AND table_name = %s AND constraint_name = 'PRIMARY' "
                        "ORDER BY ordinal_position", (dbname, table))
        else:
            cur.execute("SELECT kcu.column_name FROM information_schema.table_constraints tc "
                        "JOIN information_schema.key_column_usage kcu "
                        "  ON kcu.constraint_name = tc.constraint_name "
                        " AND kcu.table_schema = tc.table_schema AND kcu.table_name = tc.table_name "
                        "WHERE tc.constraint_type = 'PRIMARY KEY' "
                        "  AND tc.table_schema = %s AND tc.table_name = %s "
                        "ORDER BY kcu.ordinal_position", (schema or "public", table))
        return [_row_vals(r)[0] for r in cur.fetchall()]
    except Exception:
        return []


def _mongo_id(v):
    """把前端回传的 _id 还原成合适类型（24 位十六进制 → ObjectId）"""
    if isinstance(v, str):
        s = v.strip().strip('"')
        if len(s) == 24:
            try:
                from bson import ObjectId
                return ObjectId(s)
            except Exception:
                pass
        return s
    return v


def _update_sql(use, kind, schema, table, key, changes):
    """UPDATE ... WHERE 主键（用可写连接：浏览 / 查询用的连接是只读的）"""
    ref = _table_ref(kind, use.get("dbname") or "", schema, table)
    ph = "?" if kind == "sqlite" else "%s"
    sets = ", ".join("%s = %s" % (_quote(kind, c), ph) for c in changes)
    whr = " AND ".join("%s = %s" % (_quote(kind, c), ph) for c in key)
    args = list(changes.values()) + list(key.values())
    conn, _k = _open(use, writable=True)
    try:
        cur = conn.cursor()
        cur.execute("UPDATE %s SET %s WHERE %s" % (ref, sets, whr), args)
        n = cur.rowcount
        conn.commit()
        return n
    finally:
        _close(conn, kind)


def _update_redis(r, key, row_key, changes):
    """Redis 的「编辑行」：按 key 的类型写回（string / hash / list）；返回 (行数, 写前快照)"""
    t = r.type(key)
    new = changes.get("值")
    if t == "string":
        if new is None:
            raise RuntimeError("没有需要保存的改动")
        snap = _redis_snapshot(r, key)
        r.set(key, new)
        return 1, snap
    if t == "hash":
        f = row_key.get("字段")
        if f is None or new is None:
            raise RuntimeError("哈希行需要「字段」与新值")
        snap = _redis_snapshot(r, key)
        r.hset(key, f, new)
        return 1, snap
    if t == "list":
        i = row_key.get("索引")
        if i is None or new is None:
            raise RuntimeError("列表行需要「索引」与新值")
        snap = _redis_snapshot(r, key)
        r.lset(key, int(i), new)
        return 1, snap
    raise RuntimeError("暂不支持直接编辑 %s 类型的 key" % t)


# ------------------------------------------------------------ 写操作日志（供「回撤」用）

def _json_dump(v):
    try:
        return json.dumps(v, ensure_ascii=False, default=str)
    except Exception:
        return ""


def _json_load(s, default=None):
    try:
        return json.loads(s) if s else default
    except Exception:
        return default


def _log_write(cid, kind, dbname, schema, tbl, op, summary, before=None, after=None,
               before_text=None, after_text=None, undoable=True):
    """记一次写操作（存本机 store.db，不碰目标库）；返回日志 id。

    before/after 走 JSON；MongoDB 需要保住 ObjectId / 日期类型时，用 before_text / after_text
    直接传「扩展 JSON」文本。
    """
    rec = (uuid.uuid4().hex[:12], cid, kind or "", dbname or "", schema or "", tbl or "", op,
           summary or "",
           before_text if before_text is not None else (_json_dump(before) if before is not None else ""),
           after_text if after_text is not None else (_json_dump(after) if after is not None else ""),
           1 if undoable else 0, 0, time.time())
    try:
        with store_tx() as c:
            c.execute("INSERT INTO db_write_log (id, conn_id, kind, dbname, tbl_schema, tbl, op, summary,"
                      " before_json, after_json, undoable, undone, created_at)"
                      " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", rec)
        return rec[0]
    except Exception as e:
        _log.warning("记录写操作失败：%s", e)
        return ""


def _list_writes(cid, limit=30):
    out = []
    try:
        conn = store_conn()
        try:
            rows = conn.execute("SELECT id, op, tbl, summary, undoable, undone, created_at"
                                " FROM db_write_log WHERE conn_id=? ORDER BY created_at DESC LIMIT ?",
                                (cid, limit)).fetchall()
        finally:
            conn.close()
        out = [{"id": r["id"], "op": r["op"], "table": r["tbl"], "summary": r["summary"],
                "undoable": bool(r["undoable"]), "undone": bool(r["undone"]),
                "created_at": float(r["created_at"])} for r in rows]
    except Exception as e:
        _log.warning("读取写操作日志失败：%s", e)
    return out


def _get_write(wid):
    try:
        conn = store_conn()
        try:
            r = conn.execute("SELECT * FROM db_write_log WHERE id=?", (wid,)).fetchone()
        finally:
            conn.close()
        return dict(r) if r else None
    except Exception:
        return None


def _mark_undone(wid):
    try:
        with store_tx() as c:
            c.execute("UPDATE db_write_log SET undone=1 WHERE id=?", (wid,))
    except Exception as e:
        _log.warning("标记回撤失败：%s", e)


def _op_name(op):
    return {"insert": "新增行", "update": "修改行", "delete": "删除行", "truncate": "清空",
            "drop": "删除", "create": "新建", "hash": "哈希字段", "rename": "重命名"}.get(op, op)


# ------------------------------------------------------------------ 行：增 / 删

def _fetch_row_sql(use, kind, schema, table, key):
    """按主键取一整行（取原始值，不走 _cell 的截断），供删除时留档回撤"""
    ref = _table_ref(kind, use.get("dbname") or "", schema, table)
    ph = "?" if kind == "sqlite" else "%s"
    whr = " AND ".join("%s = %s" % (_quote(kind, c), ph) for c in key)
    conn, _k = _open(use)
    try:
        cur = conn.cursor()
        cur.execute("SELECT * FROM %s WHERE %s LIMIT 1" % (ref, whr), list(key.values()))
        cols = [d[0] for d in (cur.description or [])]
        rows = cur.fetchall()
        if not rows:
            return cols, None
        r = rows[0]
        return cols, (list(r.values()) if isinstance(r, dict) else list(r))
    finally:
        _close(conn, kind)


def _insert_sql(use, kind, schema, table, values):
    """插入一行；返回 (新行主键 或 None, 影响行数)"""
    cols = list(values.keys())
    if not cols:
        raise RuntimeError("没有可插入的字段")
    ref = _table_ref(kind, use.get("dbname") or "", schema, table)
    ph = "?" if kind == "sqlite" else "%s"
    sql = "INSERT INTO %s (%s) VALUES (%s)" % (ref, ", ".join(_quote(kind, c) for c in cols),
                                               ", ".join([ph] * len(cols)))
    conn, _k = _open(use, writable=True)
    try:
        cur = conn.cursor()
        cur.execute(sql, list(values.values()))
        n = cur.rowcount
        pk = _pk_columns(cur, kind, use.get("dbname") or "", schema, table)
        key = None
        if pk and all(c in values for c in pk):
            key = dict((c, values[c]) for c in pk)
        elif len(pk) == 1 and kind in ("sqlite", "mysql"):
            rid = getattr(cur, "lastrowid", None)
            if rid is not None:
                key = {pk[0]: rid}
        conn.commit()
        return key, n
    finally:
        _close(conn, kind)


def _delete_sql(use, kind, schema, table, key):
    ref = _table_ref(kind, use.get("dbname") or "", schema, table)
    ph = "?" if kind == "sqlite" else "%s"
    whr = " AND ".join("%s = %s" % (_quote(kind, c), ph) for c in key)
    conn, _k = _open(use, writable=True)
    try:
        cur = conn.cursor()
        cur.execute("DELETE FROM %s WHERE %s" % (ref, whr), list(key.values()))
        n = cur.rowcount
        conn.commit()
        return n
    finally:
        _close(conn, kind)


# ------------------------------------------------------------------ 回撤

def _undo_sql(use, kind, schema, table, op, before, after):
    conn, _k = _open(use, writable=True)
    try:
        cur = conn.cursor()
        ph = "?" if kind == "sqlite" else "%s"
        ref = _table_ref(kind, use.get("dbname") or "", schema, table)
        if op == "update":
            old = before.get("set") or {}
            if not old:
                raise RuntimeError("没有可回撤的旧值")
            sets = ", ".join("%s = %s" % (_quote(kind, c), ph) for c in old)
            whr = " AND ".join("%s = %s" % (_quote(kind, c), ph) for c in before["key"])
            cur.execute("UPDATE %s SET %s WHERE %s" % (ref, sets, whr),
                        list(old.values()) + list(before["key"].values()))
        elif op == "delete":
            cols, row = before.get("cols") or [], before.get("row") or []
            cur.execute("INSERT INTO %s (%s) VALUES (%s)" % (
                ref, ", ".join(_quote(kind, c) for c in cols), ", ".join([ph] * len(cols))), row)
        elif op == "insert":
            key = after.get("key") or {}
            if not key:
                raise RuntimeError("这条新增没记下主键，无法回撤")
            whr = " AND ".join("%s = %s" % (_quote(kind, c), ph) for c in key)
            cur.execute("DELETE FROM %s WHERE %s" % (ref, whr), list(key.values()))
        else:
            raise RuntimeError("该操作不支持回撤")
        conn.commit()
    finally:
        _close(conn, kind)


def _undo_mongo(use, table, op, before, after):
    conn, _k = _open(use, writable=True)
    try:
        coll = conn[use.get("dbname") or ""][table]
        if op == "update":
            coll.update_one({"_id": _mongo_id(before.get("id"))}, {"$set": before.get("set") or {}})
        elif op == "delete":
            doc = before.get("doc")
            if not doc:
                raise RuntimeError("没有可回撤的文档")
            coll.insert_one(doc)
        elif op == "insert":
            coll.delete_one({"_id": _mongo_id(after.get("id"))})
        else:
            raise RuntimeError("该操作不支持回撤")
    finally:
        _close(conn, _k)


def _redis_snapshot(r, key):
    """写之前把整个 key 存一份（类型 / 值 / TTL），回撤时整体还原"""
    t = r.type(key)
    if t == "none":
        return {"exists": False}
    try:
        ttl = int(r.ttl(key))
    except Exception:
        ttl = -1
    snap = {"exists": True, "type": t, "ttl": ttl, "value": None}
    try:
        if t == "string":
            snap["value"] = r.get(key)
        elif t == "hash":
            snap["value"] = r.hgetall(key)
        elif t == "list":
            snap["value"] = r.lrange(key, 0, -1)
        elif t == "set":
            snap["value"] = list(r.smembers(key))
        elif t == "zset":
            snap["value"] = [[m, s] for m, s in r.zrange(key, 0, -1, withscores=True)]
    except Exception:
        pass
    return snap


def _undo_redis(use, key, snap):
    """整体还原：先删掉当前 key，再按快照重建（类型 / 值 / TTL 都还原）"""
    conn, _k = _open(use, writable=True)
    try:
        conn.delete(key)
        if not snap or not snap.get("exists"):
            return
        t, v = snap.get("type"), snap.get("value")
        if t == "string":
            conn.set(key, v)
        elif t == "hash" and v:
            conn.hset(key, mapping=v)
        elif t == "list" and v:
            conn.rpush(key, *v)
        elif t == "set" and v:
            conn.sadd(key, *v)
        elif t == "zset" and v:
            conn.zadd(key, dict((m, s) for m, s in v))
        ttl = snap.get("ttl")
        if ttl and int(ttl) > 0:
            conn.expire(key, int(ttl))
    finally:
        _close(conn, _k)


# --------------------------------------------- 非关系型库的「一句话生成」上下文与清洗

def _clean_command(text):
    """从模型输出里抠出 Redis 命令：去代码围栏与说明，只取第一行命令"""
    s = (text or "").strip()
    m = re.search(r"```(?:bash|sh|redis|shell)?\s*(.+?)(?:```|\Z)", s, re.S | re.I)
    if m:
        s = m.group(1).strip()
    for ln in s.splitlines():
        ln = ln.strip()
        if ln and not ln.startswith("#") and not ln.startswith("//"):
            return ln[:_SQL_MAX]
    return ""


def _clean_json(text):
    """从模型输出里抠出 JSON 对象：去代码围栏，再按括号配对截出第一个完整对象"""
    s = (text or "").strip()
    m = re.search(r"```(?:json)?\s*(.+?)(?:```|\Z)", s, re.S | re.I)
    if m:
        s = m.group(1).strip()
    i = s.find("{")
    if i < 0:
        return ""
    depth, quote, esc = 0, None, False
    for j in range(i, len(s)):
        ch = s[j]
        if quote:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == quote:
                quote = None
            continue
        if ch in "\"'":
            quote = ch
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return s[i:j + 1][:_SQL_MAX]
    return ""


def _excerpt(text, n=160):
    """模型回复的短摘要：压平空白 + 截断；用于把「模型到底回了啥」带进错误信息与日志"""
    s = re.sub(r"\s+", " ", str(text or "")).strip()
    return (s[:n] + "…") if len(s) > n else (s or "（空回复）")


def _redis_ai_context(r, use):
    """给 AI 看的 Redis 结构：当前库规模 + 一部分 key 及其类型"""
    db = _redis_db_index(use)
    keys = _redis_keys(r, limit=60)
    try:
        size = int(r.dbsize())
    except Exception:
        size = len(keys)
    lines = ["-- 当前是第 %d 号库，约有 %d 个 key；下面是部分 key 及其类型：" % (db, size)]
    if keys:
        lines += ["%s (%s)" % (k["name"], k["rows"] or "?") for k in keys]
    else:
        lines.append("-- （这个库是空的）")
    return "\n".join(lines)


def _mongo_ai_context(client, use):
    """给 AI 看的 MongoDB 结构：当前库 + 各集合的采样文档"""
    try:
        names = sorted(client.list_database_names())
    except Exception:
        names = []
    dbname = _mongo_pick_db(names, use.get("dbname") or "")
    lines = ["-- 当前库：%s" % (dbname or "(未指定)")]
    if not dbname:
        return "\n".join(lines)
    try:
        colls = sorted(client[dbname].list_collection_names())
    except Exception:
        colls = []
    lines.append("-- 集合及其采样文档：")
    if not colls:
        lines.append("-- （这个库没有集合）")
    for name in colls[:_NL_TABLES]:
        try:
            doc = client[dbname][name].find_one()
        except Exception:
            doc = None
        if doc is None:
            lines.append("%s: （空集合）" % name)
            continue
        try:
            s = json.dumps(doc, default=str, ensure_ascii=False)
        except Exception:
            s = str(doc)
        lines.append("%s: %s" % (name, s[:600]))
    return "\n".join(lines)


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
                if kind == "sqlite":
                    cur = conn.cursor()
                    cur.execute("SELECT COUNT(*) FROM sqlite_master")
                    cur.fetchone()
                    ver = "SQLite " + sqlite3.sqlite_version
                elif kind == "mysql":
                    cur = conn.cursor()
                    cur.execute("SELECT VERSION()")
                    r = cur.fetchone()
                    ver = "MySQL " + str(list(r.values())[0] if isinstance(r, dict) else r[0])
                elif kind == "postgres":
                    cur = conn.cursor()
                    cur.execute("SHOW server_version")
                    r = cur.fetchone()
                    ver = "PostgreSQL " + str(list(r.values())[0] if isinstance(r, dict) else r[0])
                elif kind == "redis":
                    ver = "Redis " + str((conn.info() or {}).get("redis_version") or "")
                else:
                    ver = "MongoDB " + str((conn.server_info() or {}).get("version") or "")
            finally:
                _close(conn, kind)
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
                if kind in _NOSQL:
                    dbs, tables, eff = _nosql_schema(conn, kind, use)
                    use["dbname"] = eff           # 例如 MongoDB 没指定库时自动选一个，回给前端
                else:
                    cur = conn.cursor()
                    dbs = _list_databases(cur, kind, use)
                    tables = _list_tables(cur, kind, use.get("dbname") or "")
            finally:
                _close(conn, kind)
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
                pk = []                          # 主键列（编辑行时用来定位）
                if kind in _NOSQL:
                    dbn = use.get("dbname") or ""
                    if kind == "mongodb" and table not in conn[dbn].list_collection_names():
                        return jsonify({"error": "集合不存在：%s" % table}), 404
                    cols, rows, total = _nosql_rows(conn, kind, use, table, limit, offset)
                    if kind == "mongodb" and "_id" in cols:
                        pk = ["_id"]
                else:
                    cur = conn.cursor()
                    names = {t["name"] for t in _list_tables(cur, kind, use.get("dbname") or "")}
                    if table not in names:           # 表名必须真实存在，避免拼接注入
                        return jsonify({"error": "表不存在：%s" % table}), 404
                    pk = _pk_columns(cur, kind, use.get("dbname") or "", schema, table)
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
                _close(conn, kind)
    except Exception as e:
        return jsonify({"error": "读取数据失败：%s" % e}), 500
    return jsonify({"table": table, "columns": cols, "rows": rows, "pk": pk,
                    "total": total, "limit": limit, "offset": offset})


@bp.route("/api/db/query", methods=["POST"])
def api_db_query():
    """执行只读查询：SQL 库走 SELECT 类语句；Redis 走只读命令；MongoDB 走 JSON 过滤"""
    data = request.get_json(silent=True) or {}
    cid = str(data.get("conn") or "")
    sql = str(data.get("sql") or "")
    dbname = str(data.get("dbname") or "")
    table = str(data.get("table") or "")
    conf = _load_conf(cid, with_password=True)
    if not conf:
        return jsonify({"error": "连接不存在"}), 404
    # 只读语句校验只针对 SQL；Redis 命令 / Mongo JSON 由 _nosql_query 各自校验
    if (conf.get("kind") or "sqlite") not in _NOSQL:
        bad = _readonly_guard(sql)
        if bad:
            return jsonify({"error": bad}), 400
    try:
        limit = min(max(int(data.get("limit") or _PAGE_DEFAULT), 1), _MAX_ROWS)
    except (TypeError, ValueError):
        limit = _PAGE_DEFAULT
    use = _pick(conf, dbname)
    t0 = time.time()
    used = table                                  # 实际查询的表 / 集合，回显给前端
    try:
        with _LOCK:
            conn, kind = _open(use)
            try:
                if kind in _NOSQL:
                    cols, rows, used = _nosql_query(conn, kind, use, table, sql, limit)
                else:
                    _timeout_guard(conn, kind)
                    cur = conn.cursor()
                    cur.execute(sql.rstrip(";"))
                    cols, rows = _rows_of(cur, kind)
            finally:
                _close(conn, kind)
    except Exception as e:
        msg = str(e)
        if "readonly" in msg.lower() or "read-only" in msg.lower():
            msg = "该连接是只读的，不能执行写操作（%s）" % msg
        return jsonify({"error": "执行失败：%s" % msg}), 400
    truncated = len(rows) > limit
    pk = ["_id"] if (kind == "mongodb" and "_id" in (cols or [])) else []
    return jsonify({"columns": cols, "rows": rows[:limit], "row_count": len(rows),
                    "truncated": truncated, "limit": limit, "table": used, "pk": pk,
                    "elapsed_ms": int((time.time() - t0) * 1000)})


def _undo_write(row):
    """执行一次回撤（按类型分派）；失败抛异常"""
    op = row["op"]
    kind = row["kind"] or "sqlite"
    table = row["tbl"] or ""
    if not row["undoable"]:
        raise RuntimeError("「%s」不支持回撤" % _op_name(op))
    conf = _load_conf(row["conn_id"], with_password=True)
    if not conf:
        raise RuntimeError("连接已不存在，无法回撤")
    use = _pick(conf, row["dbname"] or "")
    if kind == "mongodb":
        from bson import json_util
        before = json_util.loads(row["before_json"]) if row["before_json"] else {}
        after = json_util.loads(row["after_json"]) if row["after_json"] else {}
        _undo_mongo(use, table, op, before or {}, after or {})
        return
    before = _json_load(row["before_json"], {}) or {}
    after = _json_load(row["after_json"], {}) or {}
    if kind == "redis":
        _undo_redis(use, table, before.get("snap"))
        return
    _undo_sql(use, kind, row["tbl_schema"] or "", table, op, before, after)


@bp.route("/api/db/row/update", methods=["POST"])
def api_db_row_update():
    """按主键（MongoDB 按 _id）更新一行里的若干字段；写完记一条可回撤的日志。"""
    data = request.get_json(silent=True) or {}
    cid = str(data.get("conn") or "")
    dbname = str(data.get("dbname") or "")
    schema = str(data.get("schema") or "")
    table = str(data.get("table") or "")
    key = data.get("key") if isinstance(data.get("key"), dict) else {}
    changes = data.get("changes") if isinstance(data.get("changes"), dict) else {}
    if not key:
        return jsonify({"error": "缺少定位这一行的主键"}), 400
    if not changes:
        return jsonify({"error": "没有需要保存的改动"}), 400
    if len(key) > 10 or len(changes) > 60:
        return jsonify({"error": "字段过多，已拒绝"}), 400
    conf = _load_conf(cid, with_password=True)
    if not conf:
        return jsonify({"error": "连接不存在"}), 404
    use = _pick(conf, dbname)
    kind = conf.get("kind") or "sqlite"
    before = before_text = None
    try:
        with _LOCK:
            if kind == "redis":
                conn, _k = _open(use, writable=True)
                try:
                    n, snap = _update_redis(conn, table, key, changes)
                finally:
                    _close(conn, kind)
                before = {"snap": snap}
            elif kind == "mongodb":
                from bson import json_util
                conn, _k = _open(use, writable=True)
                try:
                    coll = conn[use.get("dbname") or ""][table]
                    doc_id = _mongo_id(key.get("_id"))
                    old = coll.find_one({"_id": doc_id}) or {}
                    res = coll.update_one({"_id": doc_id}, {"$set": changes})
                    n = int(getattr(res, "modified_count", 0))
                finally:
                    _close(conn, kind)
                before_text = json_util.dumps(
                    {"id": key.get("_id"), "set": dict((c, old.get(c)) for c in changes)})
            else:
                cols, old_row = _fetch_row_sql(use, kind, schema, table, key)
                old_set = {}
                for c in changes:
                    old_set[c] = old_row[cols.index(c)] if (old_row and c in cols) else None
                n = _update_sql(use, kind, schema, table, key, changes)
                before = {"key": key, "set": old_set}
    except Exception as e:
        return jsonify({"error": "保存失败：%s" % e}), 400
    wid = _log_write(cid, kind, use.get("dbname") or "", schema, table, "update",
                     "修改 %d 处字段" % len(changes), before=before, before_text=before_text)
    _log.info("更新数据行：kind=%s table=%s 字段=%s 行数=%s", kind, table, list(changes), n)
    return jsonify({"ok": True, "updated": n, "write_id": wid})


@bp.route("/api/db/row/insert", methods=["POST"])
def api_db_row_insert():
    """新增一行：SQL → INSERT；MongoDB → insertOne；Redis → 往哈希里加字段。"""
    data = request.get_json(silent=True) or {}
    cid = str(data.get("conn") or "")
    dbname = str(data.get("dbname") or "")
    schema = str(data.get("schema") or "")
    table = str(data.get("table") or "")
    values = data.get("values") if isinstance(data.get("values"), dict) else {}
    if not values:
        return jsonify({"error": "没有要写入的字段"}), 400
    conf = _load_conf(cid, with_password=True)
    if not conf:
        return jsonify({"error": "连接不存在"}), 404
    use = _pick(conf, dbname)
    kind = conf.get("kind") or "sqlite"
    before = after = after_text = None
    try:
        with _LOCK:
            if kind == "redis":
                conn, _k = _open(use, writable=True)
                try:
                    if conn.type(table) != "hash":
                        raise RuntimeError("Redis 只支持往哈希类型的 key 里新增字段")
                    f = str(values.get("字段") or "").strip()
                    if not f:
                        raise RuntimeError("请填写「字段」")
                    before = {"snap": _redis_snapshot(conn, table)}
                    conn.hset(table, f, values.get("值") or "")
                    n = 1
                finally:
                    _close(conn, kind)
            elif kind == "mongodb":
                from bson import json_util
                conn, _k = _open(use, writable=True)
                try:
                    res = conn[use.get("dbname") or ""][table].insert_one(values)
                    n = 1
                    after_text = json_util.dumps({"id": getattr(res, "inserted_id", None)})
                finally:
                    _close(conn, kind)
            else:
                key, n = _insert_sql(use, kind, schema, table, values)
                after = {"key": key}
    except Exception as e:
        return jsonify({"error": "新增失败：%s" % e}), 400
    wid = _log_write(cid, kind, use.get("dbname") or "", schema, table, "insert",
                     "新增一行（%d 个字段）" % len(values), before=before,
                     after=after, after_text=after_text)
    _log.info("新增数据行：kind=%s table=%s 字段=%s", kind, table, list(values))
    return jsonify({"ok": True, "inserted": n, "write_id": wid})


@bp.route("/api/db/row/delete", methods=["POST"])
def api_db_row_delete():
    """按主键删除一行（Redis 是删掉整个 key）；删之前留档，便于回撤。"""
    data = request.get_json(silent=True) or {}
    cid = str(data.get("conn") or "")
    dbname = str(data.get("dbname") or "")
    schema = str(data.get("schema") or "")
    table = str(data.get("table") or "")
    key = data.get("key") if isinstance(data.get("key"), dict) else {}
    if not key:
        return jsonify({"error": "缺少定位这一行的主键"}), 400
    conf = _load_conf(cid, with_password=True)
    if not conf:
        return jsonify({"error": "连接不存在"}), 404
    use = _pick(conf, dbname)
    kind = conf.get("kind") or "sqlite"
    before = before_text = None
    try:
        with _LOCK:
            if kind == "redis":
                conn, _k = _open(use, writable=True)
                try:
                    before = {"snap": _redis_snapshot(conn, table)}
                    n = int(conn.delete(table))
                finally:
                    _close(conn, kind)
            elif kind == "mongodb":
                from bson import json_util
                conn, _k = _open(use, writable=True)
                try:
                    coll = conn[use.get("dbname") or ""][table]
                    doc_id = _mongo_id(key.get("_id"))
                    doc = coll.find_one({"_id": doc_id})
                    if doc is None:
                        raise RuntimeError("没找到这条记录")
                    n = int(coll.delete_one({"_id": doc_id}).deleted_count)
                finally:
                    _close(conn, kind)
                before_text = json_util.dumps({"doc": doc})
            else:
                cols, row = _fetch_row_sql(use, kind, schema, table, key)
                if row is None:
                    raise RuntimeError("没找到这条记录")
                n = _delete_sql(use, kind, schema, table, key)
                before = {"cols": cols, "row": row}
    except Exception as e:
        return jsonify({"error": "删除失败：%s" % e}), 400
    wid = _log_write(cid, kind, use.get("dbname") or "", schema, table, "delete",
                     "删除一行", before=before, before_text=before_text)
    _log.info("删除数据行：kind=%s table=%s", kind, table)
    return jsonify({"ok": True, "deleted": n, "write_id": wid})


@bp.route("/api/db/table", methods=["POST"])
def api_db_table():
    """表级操作：create / rename / truncate / drop（MongoDB 对应集合）。

    清空 / 删除 / 重命名都会动到结构或大量数据，**不支持回撤**，界面上会强提示。
    """
    data = request.get_json(silent=True) or {}
    cid = str(data.get("conn") or "")
    dbname = str(data.get("dbname") or "")
    schema = str(data.get("schema") or "")
    action = str(data.get("action") or "")
    table = str(data.get("table") or "").strip()
    if action not in ("create", "rename", "truncate", "drop"):
        return jsonify({"error": "未知操作：%s" % action}), 400
    if action != "create" and not table:
        return jsonify({"error": "缺少表名"}), 400
    conf = _load_conf(cid, with_password=True)
    if not conf:
        return jsonify({"error": "连接不存在"}), 404
    use = _pick(conf, dbname)
    kind = conf.get("kind") or "sqlite"
    if kind == "redis":
        return jsonify({"error": "Redis 没有「表」概念，可直接删除 key"}), 400
    name = str(data.get("name") or "").strip()
    try:
        with _LOCK:
            if kind == "mongodb":
                conn, _k = _open(use, writable=True)
                try:
                    db = conn[use.get("dbname") or ""]
                    if action == "create":
                        if not name:
                            raise RuntimeError("请填写集合名")
                        db.create_collection(name)
                    elif action == "truncate":
                        db[table].delete_many({})
                    elif action == "drop":
                        db.drop_collection(table)
                    else:
                        raise RuntimeError("MongoDB 暂不支持重命名集合")
                finally:
                    _close(conn, kind)
            else:
                conn, _k = _open(use, writable=True)
                try:
                    cur = conn.cursor()
                    ref = _table_ref(kind, use.get("dbname") or "", schema, table)
                    if action == "create":
                        cols = str(data.get("columns") or "").strip()
                        if not name:
                            raise RuntimeError("请填写表名")
                        if not cols:
                            raise RuntimeError("请填写列定义")
                        cur.execute("CREATE TABLE %s (%s)" % (_quote(kind, name), cols))
                    elif action == "rename":
                        new = str(data.get("new_name") or "").strip()
                        if not new:
                            raise RuntimeError("请填写新表名")
                        if kind == "mysql":
                            cur.execute("RENAME TABLE %s TO %s" % (
                                ref, _table_ref(kind, use.get("dbname") or "", schema, new)))
                        else:
                            cur.execute("ALTER TABLE %s RENAME TO %s" % (ref, _quote(kind, new)))
                    elif action == "truncate":
                        cur.execute(("TRUNCATE TABLE %s" if kind in ("mysql", "postgres")
                                     else "DELETE FROM %s") % ref)
                    else:
                        cur.execute("DROP TABLE %s" % ref)
                    conn.commit()
                finally:
                    _close(conn, kind)
    except Exception as e:
        return jsonify({"error": "操作失败：%s" % e}), 400
    summary = {"create": "新建表 " + (name or ""),
               "rename": "重命名 %s → %s" % (table, str(data.get("new_name") or "")),
               "truncate": "清空 " + table,
               "drop": "删除 " + table}.get(action, action)
    wid = _log_write(cid, kind, use.get("dbname") or "", schema, table or name, action, summary,
                     undoable=False)
    _log.info("表操作：kind=%s %s %s", kind, action, table or name)
    return jsonify({"ok": True, "write_id": wid})


@bp.route("/api/db/writes", methods=["GET"])
def api_db_writes():
    """最近的写操作（供「回撤」入口展示）"""
    cid = str(request.args.get("conn") or "")
    if not cid:
        return jsonify({"error": "缺少 conn"}), 400
    writes = _list_writes(cid)
    return jsonify({"writes": writes,
                    "undoable": len([w for w in writes if w["undoable"] and not w["undone"]])})


@bp.route("/api/db/undo", methods=["POST"])
def api_db_undo():
    """回撤一条写操作（不传 id 则回撤最近一条未回撤的）"""
    data = request.get_json(silent=True) or {}
    wid = str(data.get("id") or "")
    if not wid:
        cid = str(data.get("conn") or "")
        for w in _list_writes(cid):
            if w["undoable"] and not w["undone"]:
                wid = w["id"]
                break
        if not wid:
            return jsonify({"error": "没有可回撤的操作"}), 400
    row = _get_write(wid)
    if not row:
        return jsonify({"error": "找不到这条操作记录"}), 404
    if row["undone"]:
        return jsonify({"error": "这条操作已经回撤过了"}), 400
    try:
        with _LOCK:
            _undo_write(row)
    except Exception as e:
        return jsonify({"error": "回撤失败：%s" % e}), 400
    _mark_undone(wid)
    _log.info("回撤写操作：%s %s", row["op"], row["tbl"])
    return jsonify({"ok": True, "undo": {"op": row["op"], "table": row["tbl"],
                                         "summary": row["summary"]}})


@bp.route("/api/db/nl2sql", methods=["POST"])
def api_db_nl2sql():
    """一句话生成查询：SQL → 只读 SQL；Redis → 只读命令；MongoDB → find 的 JSON。

    统一入口，用参数决定目标数据库（两种二选一）：
      · conn + dbname —— 已保存的连接（SQLite / MySQL / PostgreSQL / Redis / MongoDB）
      · path          —— 直接指向 SQLite 数据库文件（文件查看器用，无需先建连接）

    只负责生成、不负责执行；结果回到前端让用户确认后再执行（那里同样只读），构成双重保险。
    """
    data = request.get_json(silent=True) or {}
    cid = str(data.get("conn") or "")
    path = str(data.get("path") or "")
    dbname = str(data.get("dbname") or "")
    question = str(data.get("question") or "").strip()
    if not question:
        return jsonify({"error": "请先用一句话描述你想查什么"}), 400
    if len(question) > _NL_MAX:
        return jsonify({"error": "描述过长（上限 %d 字）" % _NL_MAX}), 400
    if cid:
        conf = _load_conf(cid, with_password=True)
        if not conf:
            return jsonify({"error": "连接不存在"}), 404
        use = _pick(conf, dbname)
    elif path:
        target = os.path.abspath(os.path.normpath(path))
        if not os.path.isfile(target):
            return jsonify({"error": "数据库文件不存在：%s" % target}), 404
        if os.path.splitext(target)[1].lower() not in _SQLITE_EXTS:
            return jsonify({"error": "不是 SQLite 数据库文件：%s" % target}), 400
        use = {"kind": "sqlite", "dbname": target}          # 直接按文件当 SQLite 库打开
    else:
        return jsonify({"error": "缺少目标数据库（conn 或 path）"}), 400
    kind = use.get("kind") or "sqlite"

    from ..ide.ai import _load_cfg, _sys_pick, _log_ai_call, _sys_err_response   # 函数内导入，避免模块循环依赖
    cfg = _load_cfg()
    provider, model, err = _sys_pick(cfg, "nl2sql")
    if err:
        return _sys_err_response(err, need_config=not cfg.get("providers"))

    t_start = time.time()

    def _fail(msg, code=502, **extra):
        """统一失败出口：记一次失败调用再返回"""
        _log_ai_call("nl2sql", False, int((time.time() - t_start) * 1000), msg)
        return jsonify({"error": msg, **extra}), code

    try:
        with _LOCK:
            conn, _k = _open(use)
            try:
                if kind == "redis":
                    ctx = _redis_ai_context(conn, use)
                elif kind == "mongodb":
                    ctx = _mongo_ai_context(conn, use)
                else:
                    _timeout_guard(conn, kind)
                    ctx = _schema_text(conn.cursor(), kind, use.get("dbname") or "")
            finally:
                _close(conn, kind)
    except Exception as e:
        return jsonify({"error": "无法读取数据库结构：%s" % e}), 500

    if kind == "redis":
        sys_prompt = _NL_SYS_REDIS
        content = ("[Redis 结构]\n" + ctx + "\n\n[查询需求]\n" + question)[:_NL_CTX]
    elif kind == "mongodb":
        sys_prompt = _NL_SYS_MONGO
        content = ("[MongoDB 结构]\n" + ctx + "\n\n[查询需求]\n" + question)[:_NL_CTX]
    else:
        dialect = {"sqlite": "SQLite", "mysql": "MySQL", "postgres": "PostgreSQL"}.get(kind, kind)
        sys_prompt = _NL_SYS.format(dialect=dialect)
        content = ("[数据库表结构]\n" + ctx + "\n\n[查询需求]\n" + question)[:_NL_CTX]
    base = provider["base_url"].rstrip("/")
    url = base if base.endswith("/chat/completions") else base + "/chat/completions"
    payload = json.dumps({"model": model, "stream": False, "messages": [
        {"role": "system", "content": sys_prompt},
        {"role": "user", "content": content}]}).encode("utf-8")

    import urllib.error
    import urllib.request
    t0 = time.time()
    req = urllib.request.Request(url, data=payload, method="POST", headers={
        "Content-Type": "application/json", "Authorization": "Bearer " + provider["api_key"]})
    try:
        resp = urllib.request.urlopen(req, timeout=_NL_TIMEOUT)
        obj = json.loads(resp.read().decode("utf-8"))
        text = (((obj.get("choices") or [{}])[0] or {}).get("message") or {}).get("content") or ""
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "ignore")[:200]
        return _fail("AI 接口返回 %s：%s" % (e.code, detail))
    except Exception as e:
        return _fail("调用 AI 接口失败：%s" % e)

    # 把模型原话记进日志，解析不出来时便于回溯（只在服务端日志里）
    _log.info("AI 生成回复：kind=%s model=%s text=%s", kind, model, _excerpt(text, 300))

    out = ""
    if kind == "redis":
        out = _clean_command(text)
        if not out:
            return _fail("模型没有返回可用的命令，请换个说法或换个模型（模型原话：%s）" % _excerpt(text))
        if out.startswith("--"):        # 模型按要求回了「-- 无法生成：<原因>」
            return _fail(out.lstrip("- ")[:200] or "无法根据当前结构生成命令", 400, sql=out)
        if out.split(None, 1)[0].lower() not in _REDIS_READ:
            return _fail("模型生成的不是只读命令，已丢弃，请换个说法重试", 400, sql=out)
    elif kind == "mongodb":
        out = _clean_json(text)
        if not out:
            return _fail("模型没有返回可用的 JSON，请换个说法或换个模型（模型原话：%s）" % _excerpt(text))
        try:
            spec = json.loads(out)
            if not isinstance(spec, dict):
                raise ValueError
        except Exception:
            return _fail("模型生成的不是 JSON 对象，已丢弃，请换个说法重试", 400, sql=out)
        for bad_op in ("$where", "$function", "$accumulator", "$out", "$merge"):
            if bad_op in out:
                return _fail("模型生成的查询里含有不允许的操作符：%s" % bad_op, 400, sql=out)
        out = json.dumps(spec, ensure_ascii=False, indent=2)
    else:
        out = _clean_sql(text)
        if not out:
            low = " " + (text or "").lower() + " "
            if any((" " + w + " ") in low for w in _WRITE_WORDS):
                return _fail("模型生成的是写操作语句，已丢弃（此处只用于查询），请换个说法重试", 400)
            return _fail("模型没有返回可用的 SQL，请换个说法或换个模型（模型原话：%s）" % _excerpt(text))
        if out.startswith("--"):        # 模型按要求回了「-- 无法生成：<原因>」
            return _fail(out.lstrip("- ").splitlines()[0][:200] or "无法根据当前结构生成 SQL", 400, sql=out)
        bad = _readonly_guard(out)
        if bad:
            return _fail("模型生成的不是只读查询语句，已丢弃，请换个说法重试（%s）" % bad, 400, sql=out)

    elapsed = int((time.time() - t0) * 1000)
    _log_ai_call("nl2sql", True, elapsed)
    _log.info("AI 生成查询：kind=%s model=%s %dms out=%s", kind, model, elapsed, out[:200])
    return jsonify({"sql": out, "model": model, "elapsed_ms": elapsed})

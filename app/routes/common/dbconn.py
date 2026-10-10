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
import random
import re
import shlex
import sqlite3
import threading
import time
import uuid

from datetime import datetime, timedelta

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
_TD_MAX = 500                    # 「AI 推荐表设计」需求描述长度上限
_TD_COLS = 60                    # 一次最多采纳多少列
_TD_TYPE = 64                    # 单个类型定义长度上限
_NL_TABLES = 60                  # 表结构最多提供给 AI 的表数
_FAKE_MAX = 200                  # 「随机数据」一次最多生成 / 写入多少行
_FAKE_SKIP_MAX = 8               # 提示里最多列出几个「不写入」的列名
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
                "hint": "默认端口 27017；「库名」可留空，连上后再选库；"
                        "也可直接粘贴 mongodb:// 或 mongodb+srv:// 连接字符串"},
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

    # MongoDB：允许直接粘贴连接字符串（mongodb:// / mongodb+srv://）。
    # 账号密码从串里拆出来存进原来那两列（密码仍加密），串本身剥掉账号密码后存 params，
    # 连库时整条用它 —— 这样 SRV / 副本集 / TLS / authSource 等参数都不会丢。
    uri_pwd = ""
    uri_in = str(data.get("uri") or "").strip()
    if kind == "mongodb" and uri_in:
        try:
            params, info = _split_mongo_uri(uri_in)
        except ValueError as e:
            return jsonify({"error": str(e)}), 400
        host = host or info["host"]
        port = port or info["port"]
        username = username or info["username"]
        dbname = dbname or info["dbname"]
        uri_pwd = info["password"]
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
    if uri_pwd:
        pwd_plain = uri_pwd                                  # 连接串里带了密码 → 以它为准
    elif pwd_raw is None or str(pwd_raw) == "":
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


# MongoDB 支持用「连接字符串」添加：mongodb+srv:// 的 SRV 记录、多主机副本集、TLS、
# authSource 这些靠 host/port 两个输入框根本表达不出来，所以原样保存整条 URI。
_MONGO_URI_RE = re.compile(r"^mongodb(\+srv)?://", re.IGNORECASE)
# 连接串拆件：scheme://[user:pass@]host[,host...][/db][?opts]
# 账号密码段用贪婪匹配，密码里带未转义的 @ 时才按最后一个 @ 切分
_MONGO_URI_PARTS_RE = re.compile(
    r"^mongodb(?:\+srv)?://(?:(?P<userinfo>[^/?#]*)@)?(?P<hosts>[^/?#]*)(?P<path>/[^?#]*)?",
    re.IGNORECASE)


def _mongo_uri(conf: dict) -> str:
    """配置里保存的连接字符串（存在 params 字段）；不是 mongodb URI 就当作没有。"""
    raw = str(conf.get("params") or "").strip()
    return raw if _MONGO_URI_RE.match(raw) else ""


def _strip_mongo_credentials(uri: str) -> str:
    """去掉连接串里的 user:pass@。

    密码统一走「加密后落库」的那一列，连接串里不留明文；连库时再把账号密码单独传给驱动。
    """
    m = _MONGO_URI_RE.match(uri)
    if not m:
        return uri
    head, rest = uri[:m.end()], uri[m.end():]
    cut = len(rest)
    for i, ch in enumerate(rest):               # 账号密码只在第一个 / ? # 之前的这一段里
        if ch in "/?#":
            cut = i
            break
    authority, tail = rest[:cut], rest[cut:]
    if "@" in authority:                        # 密码里可能带未转义的 @，取最后一个
        authority = authority.rsplit("@", 1)[1]
    return head + authority + tail


def _split_host_port(s: str):
    """拆 host:port（IPv6 写成 [::1]:27017）。返回 (host, port)；端口不是数字则报错。"""
    s = (s or "").strip()
    if not s:
        return "", 0
    if s.startswith("["):                            # IPv6
        host, _b, rest = s.partition("]")
        rest = rest.lstrip(":")
        if rest and not rest.isdigit():
            raise ValueError("端口不是数字：%s" % rest)
        return host[1:], (int(rest) if rest else 0)
    head, sep, tail = s.rpartition(":")
    if sep and head:
        if not tail.isdigit():
            raise ValueError("端口不是数字：%s" % tail)
        return head, int(tail)
    return s, 0


def _parse_mongo_uri_basic(raw: str) -> dict:
    """不依赖 pymongo 的兜底解析：认 scheme://user:pass@host1:port,host2:port/db?opts 这种写法。

    （保存配置这一步不能因为没装驱动就失败，所以这里手工拆，够填输入框就行。）
    """
    from urllib.parse import unquote
    m = _MONGO_URI_PARTS_RE.match(str(raw or "").strip())
    if not m:
        raise ValueError("连接字符串格式不正确：%s" % raw)
    userinfo = m.group("userinfo") or ""
    hosts = [h for h in (m.group("hosts") or "").split(",") if h]
    path = (m.group("path") or "").lstrip("/")
    user, _sep, pwd = userinfo.partition(":")
    host, port = _split_host_port(hosts[0]) if hosts else ("", 0)
    return {"username": unquote(user), "password": unquote(pwd),
            # 没有主机名时，这段 path 是 unix socket 的路径而不是库名
            "dbname": unquote(path) if host else "",
            "host": ",".join(_split_host_port(h)[0] for h in hosts) if hosts else "",
            "port": port}


def _split_mongo_uri(uri: str):
    """拆连接串：返回 (去掉账号密码的 URI, {username, password, dbname, host, port})。

    优先用 pymongo 自带的解析器（认得 SRV / 多主机 / 百分号编码）；没装驱动或解析失败时
    退回 urllib，至少保证「保存」这一步不依赖驱动能不能用。host / port / dbname 只是拿来
    填输入框方便核对，真正连库用的是整条连接串。
    """
    raw = str(uri or "").strip()
    if not _MONGO_URI_RE.match(raw):
        raise ValueError("连接字符串需以 mongodb:// 或 mongodb+srv:// 开头")
    info = {"username": "", "password": "", "dbname": "", "host": "", "port": 0}
    try:
        import pymongo
        parsed = pymongo.uri_parser.parse_uri(raw)
        nodes = parsed.get("nodelist") or []
        if nodes:
            info["host"] = ",".join(h for h, _p in nodes)
            info["port"] = int(nodes[0][1] or 0)
        info["username"] = parsed.get("username") or ""
        info["password"] = parsed.get("password") or ""
        info["dbname"] = parsed.get("database") or ""
    except Exception:                            # 驱动缺失 / SRV 解析失败 → 手工兜底
        info = _parse_mongo_uri_basic(raw)
    return _strip_mongo_credentials(raw), info


def _open_mongo(conf):
    import pymongo
    from urllib.parse import quote_plus
    user = conf.get("username") or ""
    pwd = conf.get("password") or ""
    uri = _mongo_uri(conf)
    if not uri:                                  # 没填连接串：按主机 / 端口 / 账号密码拼
        host = conf.get("host") or "127.0.0.1"
        port = int(conf.get("port") or 27017)
        auth = ("%s:%s@" % (quote_plus(user), quote_plus(pwd))) if user else ""
        uri = "mongodb://%s%s:%d/" % (auth, host, port)
    opts = {"serverSelectionTimeoutMS": _CONNECT_TIMEOUT * 1000,
            "connectTimeoutMS": _CONNECT_TIMEOUT * 1000,
            "socketTimeoutMS": _QUERY_TIMEOUT * 1000}
    if user or pwd:                              # 连接串里的账号密码已剥掉，这里补回去
        opts["username"] = user
        opts["password"] = pwd
    client = pymongo.MongoClient(uri, **opts)
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

_TD_SYS = (
    "你是 {dialect} 表结构设计助手。根据用户的一句话需求（可能附带已有表结构），"
    "设计或补齐这张表，并只以一个 JSON 对象返回。\n"
    "硬性要求：\n"
    "1. 只输出 JSON 本身：不要解释、不要 Markdown 代码块、不要用 ``` 包裹；\n"
    "2. JSON 结构固定为：{{\"table\": \"表名\", \"note\": \"一句话说明\", \"columns\": "
    "[{{\"name\": \"列名\", \"type\": \"类型\", \"nullable\": true, \"default\": \"\", \"pk\": false}}]}}；\n"
    "3. type 只写纯类型（本库可用：{types}），不要带 NOT NULL / DEFAULT / PRIMARY KEY / "
    "AUTO_INCREMENT / UNIQUE，这些分别由 nullable / default / pk 表达；\n"
    "4. 列名用小写蛇形英文，第一列是主键 id（pk=true、nullable=false）；\n"
    "5. default 写值的字面量：字符串带单引号、数字 / 布尔 / 函数不带引号（时间用 {now}），"
    "没有默认值就写空字符串；\n"
    "6. 表里必须有 created_at 与 updated_at 两个时间字段；\n"
    "7. 用户给了已有表结构时，必须保留原有列名与原义，只做补齐 / 优化，不要改名、不要臆造；\n"
    "8. 列数控制在 20 列以内，不要设计外键；\n"
    "9. 需求完全无法理解时，只输出 {{\"error\": \"简短原因\"}}。"
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


def _nosql_rows(conn, kind, use, table, limit, offset, include_deleted=False,
                order_col="", order_dir="ASC"):
    """非关系型库的数据行：Redis → 某个 key 的值；MongoDB → 某个集合的文档

    Redis 的行没有可排序的「列」语义，order_col 忽略；MongoDB 交给服务端排序。
    """
    if kind == "redis":
        return _redis_rows(conn, table, limit, offset)
    coll = conn[use.get("dbname") or ""][table]
    total = None
    try:
        total = int(coll.estimated_document_count())
    except Exception:
        pass
    filt = {}                                         # 默认过滤掉 is_deleted=1 的文档（假删除）
    if not include_deleted:
        filt = {"$or": [{"is_deleted": {"$ne": 1}}, {"is_deleted": {"$exists": False}}]}
    cur = coll.find(filt)
    if order_col:                                     # 表头点击排序：按该字段升 / 降
        cur = cur.sort(order_col, -1 if order_dir == "DESC" else 1)
    docs = list(cur.skip(offset).limit(limit))
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
            # 先用 columns.column_key（与「表结构」用的是同一张表，权限要求最低），
            # 取不到再退回 key_column_usage（个别库 / 账号对后者可见性受限）
            cur.execute("SELECT column_name FROM information_schema.columns "
                        "WHERE table_schema = %s AND table_name = %s AND column_key = 'PRI' "
                        "ORDER BY ordinal_position", (dbname, table))
            pk = [_row_vals(r)[0] for r in cur.fetchall()]
            if pk:
                return pk
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


def _autoinc_column(cur, kind, dbname, schema, table):
    """找「单列自增 / 标识列」（没有主键时的兜底）：回撤要靠它把新行删掉"""
    try:
        if kind == "mysql":
            cur.execute("SELECT column_name FROM information_schema.columns "
                        "WHERE table_schema = %s AND table_name = %s "
                        "AND LOWER(extra) LIKE '%%auto_increment%%' ORDER BY ordinal_position",
                        (dbname, table))
        elif kind == "sqlite":
            rows = cur.execute("PRAGMA table_info(%s)" % _quote(kind, table)).fetchall()
            for r in rows:
                v = list(r.values()) if isinstance(r, dict) else list(r)
                if v[5] and str(v[2]).upper() == "INTEGER":     # INTEGER PRIMARY KEY 即 rowid
                    return v[1]
            return ""
        else:
            cur.execute("SELECT column_name FROM information_schema.columns "
                        "WHERE table_schema = %s AND table_name = %s "
                        "AND (is_identity = 'YES' OR column_default LIKE 'nextval(%%') "
                        "ORDER BY ordinal_position", (schema or "public", table))
        rows = cur.fetchall()
        return _row_vals(rows[0])[0] if len(rows) == 1 else ""     # 多个自增列无法唯一定位
    except Exception:
        return ""


def _insert_key_cols(cur, kind, dbname, schema, table):
    """新行回撤要用的「键列」：主键优先；没有主键退回单列自增 / 标识列；都没有返回 []"""
    pk = _pk_columns(cur, kind, dbname, schema, table)
    if pk:
        return pk
    ai = _autoinc_column(cur, kind, dbname, schema, table)
    return [ai] if ai else []


def _columns_info(cur, kind, dbname, schema, table):
    """取表的列结构：[{name, type, nullable, default, pk, extra}]

    供「表结构设计」弹窗展示与比对（改列 / 删列 / 重命名列时的原始值）。
    """
    out = []
    if kind == "sqlite":
        cur.execute("PRAGMA table_info(%s)" % _quote(kind, table))
        for r in cur.fetchall():
            v = list(r.values()) if isinstance(r, dict) else list(r)
            out.append({"name": v[1], "type": v[2] or "", "nullable": not bool(v[3]),
                        "default": v[4], "pk": bool(v[5]), "extra": ""})
        return out
    if kind == "mysql":
        cur.execute("SELECT column_name, column_type, is_nullable, column_default, column_key, extra "
                    "FROM information_schema.columns WHERE table_schema = %s AND table_name = %s "
                    "ORDER BY ordinal_position", (dbname or "", table))
        for r in cur.fetchall():
            v = list(r.values()) if isinstance(r, dict) else list(r)
            out.append({"name": v[0], "type": v[1] or "", "nullable": str(v[2]).upper() == "YES",
                        "default": v[3], "pk": str(v[4]).upper() == "PRI", "extra": v[5] or ""})
        return out
    # PostgreSQL：data_type 不带长度，按需把长度补回去，便于原样回填
    cur.execute("SELECT column_name, data_type, is_nullable, column_default, "
                "character_maximum_length, numeric_precision "
                "FROM information_schema.columns WHERE table_schema = %s AND table_name = %s "
                "ORDER BY ordinal_position", (schema or "public", table))
    pk = set(_pk_columns(cur, kind, dbname, schema, table))
    for r in cur.fetchall():
        v = list(r.values()) if isinstance(r, dict) else list(r)
        name, dtype = v[0], v[1] or ""
        if dtype in ("character varying", "character") and isinstance(v[4], int):
            dtype = ("varchar(%d)" if dtype == "character varying" else "char(%d)") % v[4]
        elif dtype in ("numeric", "decimal") and isinstance(v[5], int):
            dtype = "numeric(%d)" % v[5]
        out.append({"name": name, "type": dtype, "nullable": str(v[2]).upper() == "YES",
                    "default": v[3], "pk": name in pk, "extra": ""})
    return out


# ---------------------------------------------------------- 随机测试数据（纯规则造数，不用 AI）
# 「新增行」面板里的「随机数据」用：按「列名语义优先、类型次之」造一份像样的值，
# 既能填进表单让人先改，也能直接批量写入（见 /api/db/row/fake、/api/db/row/insert-many）。
_FAKE_NONE = object()            # 哨兵：这列不写值（交给数据库：自增 / 默认值）

_FAKE_WORDS = ("测试数据", "演示样例", "临时记录", "常规分组", "批量导入", "示例内容",
               "华东区", "华南区", "华北区", "内部使用", "自动生成", "待补充说明")
_FAKE_REMARKS = ("随机生成的测试数据，可直接删除", "联调用样例数据，无实际含义",
                 "批量造数生成，请勿用于生产环境", "演示数据，用于验证页面展示效果")
_FAKE_STATUS = ("待处理", "处理中", "已完成", "已取消", "已关闭")
_FAKE_SURNAME = "赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦许何吕施张孔曹严华金魏陶姜"
_FAKE_GIVEN = "伟芳娜秀英敏静丽强磊军洋勇艳杰娟涛明超平刚金梅鑫宇浩然子轩雨欣思远嘉怡"
_FAKE_CITY = ("北京", "上海", "广州", "深圳", "杭州", "成都", "武汉", "西安", "南京", "重庆",
              "苏州", "天津", "长沙", "青岛", "郑州", "厦门", "合肥", "福州", "济南", "宁波")
_FAKE_ROAD = ("中山", "人民", "解放", "建设", "长江", "黄河", "科技园", "创业", "新华",
              "和谐", "光明", "朝阳", "幸福", "淮河", "文一")
_FAKE_NO_PREFIX = ("SO", "NO", "OD", "TK")

_FAKE_INT_TYPES = ("int", "integer", "tinyint", "smallint", "mediumint", "bigint", "serial",
                   "bigserial", "smallserial", "int2", "int4", "int8", "year")
_FAKE_REAL_TYPES = ("real", "double", "float", "decimal", "numeric", "money")
_FAKE_TEXT_TYPES = ("char", "varchar", "nvarchar", "nchar", "text", "tinytext", "mediumtext",
                    "longtext", "clob", "citext", "string", "xml")
_FAKE_BIN_TYPES = ("blob", "bytea", "binary", "varbinary", "tinyblob", "mediumblob", "longblob",
                   "image", "bit varying")


def _fake_family(typ):
    """把各方言的类型名归到造数家族：int / real / bool / datetime / date / time / text /
    json / enum / uuid / ip / binary / other"""
    t = re.sub(r"\s+", " ", (typ or "").strip().lower())
    base = re.split(r"[(\s]", t, 1)[0] if t else ""
    if base in ("enum", "set"):
        return "enum"
    if base in _FAKE_INT_TYPES:
        return "int"
    if base in _FAKE_REAL_TYPES or t.startswith("double precision"):
        return "real"
    if base in ("bool", "boolean", "bit"):
        return "bool"
    if base in ("timestamp", "datetime", "smalldatetime", "timestamptz"):
        return "datetime"
    if base == "date":
        return "date"
    if base == "time":
        return "time"
    if base in ("json", "jsonb"):
        return "json"
    if base in _FAKE_BIN_TYPES:
        return "binary"
    if base in ("inet", "cidr"):
        return "ip"
    if base in ("uuid", "uniqueidentifier"):
        return "uuid"
    if base in _FAKE_TEXT_TYPES or "char" in base:
        return "text"
    return "other"


def _fake_meta(typ):
    """从类型里抠出长度 / 小数位 / 枚举候选值（造值时要照着来，别超长也别超精度）"""
    t = (typ or "").strip()
    low = t.lower()
    size = scale = None
    m = re.search(r"\(([^)]*)\)", low)
    if m:
        nums = re.findall(r"\d+", m.group(1))
        if nums:
            size = int(nums[0])
            if len(nums) > 1:                        # decimal(10,2)
                scale = int(nums[1])
    opts = []
    if "enum" in low or "set(" in low:
        opts = re.findall(r"'([^']*)'", t) or re.findall(r'"([^"]*)"', t)
    return size, scale, opts


def _fake_cols(cur, kind, dbname, schema, table):
    """取列结构，并判定哪些列不该写值：自增主键（交给库分配）、生成列、二进制列"""
    ident = set()
    if kind == "postgres":                            # PG10+ 的 identity 列 column_default 是空的
        try:
            cur.execute("SELECT column_name FROM information_schema.columns "
                        "WHERE table_schema = %s AND table_name = %s AND is_identity = 'YES'",
                        (schema or "public", table))
            ident = {_row_vals(r)[0] for r in cur.fetchall()}
        except Exception:
            ident = set()
    out = []
    for c in _columns_info(cur, kind, dbname, schema, table):
        t = (c.get("type") or "").lower()
        extra = (c.get("extra") or "").lower()
        dflt = str(c.get("default") or "").lower()
        fam = _fake_family(c.get("type"))
        size, scale, opts = _fake_meta(c.get("type"))
        auto = ("auto_increment" in extra or "nextval(" in dflt or c["name"] in ident
                or (kind == "sqlite" and c["pk"] and "int" in t))
        gen = "generated" in extra or "virtual" in extra or "stored" in extra
        out.append({"name": c["name"], "type": c.get("type") or "", "fam": fam,
                    "size": size, "scale": scale, "opts": opts,
                    "pk": bool(c["pk"]), "nullable": bool(c["nullable"]),
                    "skip": bool(auto or gen or fam == "binary")})
    return out


def _fake_value(rng, c, now, i=0):
    """造一个值；返回 _FAKE_NONE 表示这列留空（不写入），返回 None 表示写入 NULL

    i 是这一批里的行号：邮箱 / 编号这类常带唯一约束的字段用它错开，免得批量一写就撞唯一键。
    """
    if c["skip"]:
        return _FAKE_NONE
    n = (c["name"] or "").lower()
    fam, size, scale, opts = c["fam"], c["size"], c["scale"], c["opts"]
    if fam == "enum":
        return rng.choice(opts) if opts else _FAKE_NONE
    if fam == "uuid":
        return str(uuid.uuid4())
    if fam == "ip":
        return "192.168.%d.%d" % (rng.randint(0, 255), rng.randint(1, 254))
    if fam == "json":
        return json.dumps({"key": "测试", "n": rng.randint(1, 999), "ok": True}, ensure_ascii=False)
    # ---- 时间类：名字带生日就往几十年前推，其余取近 90 天内 ----
    if fam in ("date", "datetime", "time") or (fam == "int" and re.search(r"(^|_)(at|time|date|ts)$", n)):
        if re.search(r"(birth|born|生日)", n):
            dt = now - timedelta(days=rng.randint(365 * 20, 365 * 40))
        else:
            dt = now - timedelta(seconds=rng.randint(0, 90 * 86400))
        if fam == "date":
            return dt.strftime("%Y-%m-%d")
        if fam == "time":
            return dt.strftime("%H:%M:%S")
        if fam == "int":                              # 时间戳列
            return int(dt.timestamp())
        return dt.strftime("%Y-%m-%d %H:%M:%S")
    if fam == "bool":
        return rng.choice([True, False])
    # ---- 名字能看出语义的常见字段，给得像真的 ----
    if re.search(r"(email|mail)$", n):
        return "user%d@example.com" % (rng.randint(10000, 999999) * 100 + i)
    if re.search(r"(phone|mobile|tel)", n):
        return "1" + rng.choice("3578") + "".join(rng.choice("0123456789") for _ in range(9))
    if re.search(r"(url|link|website|homepage|avatar|photo|img|image)", n) and fam in ("text", "other"):
        return "https://example.com/" + "".join(rng.choice("0123456789abcdef") for _ in range(8))
    if re.search(r"(^|_)(user_?name|real_?name|full_?name|nick_?name|contact|owner|author|operator)$", n):
        return rng.choice(_FAKE_SURNAME) + "".join(rng.choice(_FAKE_GIVEN)
                                                   for _ in range(rng.choice((1, 2))))
    if re.search(r"(address|addr|location|city|region|province|district)", n) and fam in ("text", "other"):
        return "%s市%s路%d号" % (rng.choice(_FAKE_CITY), rng.choice(_FAKE_ROAD), rng.randint(1, 999))
    if re.search(r"(remark|note|memo|comment|content|desc|detail|reason|message|intro)", n):
        return rng.choice(_FAKE_REMARKS)
    if re.search(r"(title|subject|name|label|tag|keyword)", n) and fam in ("text", "other"):
        return "%s%d" % (rng.choice(_FAKE_WORDS), rng.randint(1, 99))
    if re.search(r"(status|state|stage|type|kind|category|level|gender|source|mode)", n):
        if fam in ("int", "real"):
            return rng.randint(0, 3)
        return rng.choice(_FAKE_STATUS)
    if re.search(r"(no|code|sn|serial|number|num|bill|trade)$", n) and fam in ("text", "other"):
        return "%s%s%04d%02d" % (rng.choice(_FAKE_NO_PREFIX), now.strftime("%Y%m%d"),
                                 rng.randint(0, 9999), i + 1)
    if re.search(r"^(is_|has_|can_|enable|disable|deleted|active)", n):
        v = rng.choice([True, False])
        return v if fam == "bool" else (1 if v else 0) if fam in ("int", "real") else "是" if v else "否"
    # ---- 名字没线索就按类型造 ----
    if fam == "int":
        return rng.randint(0, 1) if size == 1 else rng.randint(1, 99999)   # tinyint(1) 当布尔用
    if fam == "real":
        sc = scale if scale is not None else 2
        lim = max(1, min(9999, 10 ** max(1, (size or 6) - sc) - 1))         # 别超 precision
        return round(rng.uniform(0, lim), sc)
    if fam in ("text", "other"):
        s = "%s%d" % (rng.choice(_FAKE_WORDS), rng.randint(1, 999))
        return s[:max(1, size)] if size else s                              # varchar(n) 别超长
    return _FAKE_NONE


def _fake_rows(cols, count, now, rng=None):
    """造 count 行：返回 (行列表, 不写入的列名)"""
    rng = rng or random.Random()
    rows, skipped = [], []
    for i in range(count):
        row = {}
        for c in cols:
            v = _fake_value(rng, c, now, i)
            if v is _FAKE_NONE:
                if c["name"] not in skipped:
                    skipped.append(c["name"])
                continue
            # 可空列偶尔留个 NULL，顺便把「空值」这条路径也测到（主键列不给 NULL）
            if v is not None and c["nullable"] and not c["pk"] and rng.random() < 0.08:
                v = None
            row[c["name"]] = v
        rows.append(row)
    return rows, skipped


def _alter_sql(kind, ref, op, col, new_name, definition, extra=None):
    """把「改列结构」翻译成各方言的 ALTER TABLE 语句（可能多句）

    extra 里带结构化信息（parts=改动项 / type / nullable / default）：PostgreSQL
    改列要按「类型 / 可空 / 默认值」拆成多条 ALTER COLUMN，不能像 MySQL 那样一句 MODIFY 搞定。
    """
    q = lambda n: _quote(kind, n)
    e = extra or {}
    parts = e.get("parts") or []
    if op == "add":
        if not definition:
            raise RuntimeError("请填写列定义，如 age INT NOT NULL DEFAULT 0")
        return ["ALTER TABLE %s ADD COLUMN %s %s" % (ref, q(col), definition)]
    if op == "drop":
        return ["ALTER TABLE %s DROP COLUMN %s" % (ref, q(col))]
    if op == "rename":
        if not new_name:
            raise RuntimeError("请填写新的列名")
        if kind == "mysql" and definition:
            # 用 CHANGE COLUMN 而不是 RENAME COLUMN：后者要 MySQL 8 / MariaDB 10.5+，
            # 且 CHANGE 能一并保住类型 / 默认值 / auto_increment 等属性（definition 里带上）
            return ["ALTER TABLE %s CHANGE COLUMN %s %s %s" % (ref, q(col), q(new_name), definition)]
        return ["ALTER TABLE %s RENAME COLUMN %s TO %s" % (ref, q(col), q(new_name))]
    if op == "modify":
        if kind == "mysql":
            if not definition:
                raise RuntimeError("请填写新的列定义")
            return ["ALTER TABLE %s MODIFY COLUMN %s %s" % (ref, q(col), definition)]
        if kind == "postgres":
            out = []
            ctype = str(e.get("type") or "").strip()
            if "type" in parts and ctype:
                # USING 让隐式转换不了的老数据也能改
                out.append("ALTER TABLE %s ALTER COLUMN %s TYPE %s USING %s::%s"
                           % (ref, q(col), ctype, q(col), ctype))
            if "nullable" in parts:
                out.append("ALTER TABLE %s ALTER COLUMN %s %s NOT NULL"
                           % (ref, q(col), "SET" if e.get("nullable") is False else "DROP"))
            if "default" in parts:
                d = str(e.get("default") or "").strip()
                out.append("ALTER TABLE %s ALTER COLUMN %s %s"
                           % (ref, q(col), ("SET DEFAULT " + d) if d else "DROP DEFAULT"))
            if not out:
                raise RuntimeError("没有检测到可执行的列改动")
            return out
        raise RuntimeError("SQLite 只支持 新增 / 删除 / 重命名 列，不支持修改列类型")
    raise RuntimeError("未知的列操作：%s" % op)


def _table_op_sql(use, kind, schema, action, table, name, data):
    """SQL 库的表级操作：新建 / 重命名 / 清空 / 删除 / 改列结构"""
    conn, _k = _open(use, writable=True)
    try:
        cur = conn.cursor()
        dbs = use.get("dbname") or ""
        ref = _table_ref(kind, dbs, schema, table)
        if action == "create":
            cols = str(data.get("columns") or "").strip()
            if not name:
                raise RuntimeError("请填写表名")
            if not cols:
                raise RuntimeError("请至少定义一列")
            cur.execute("CREATE TABLE %s (%s)" % (_quote(kind, name), cols))
        elif action == "rename":
            new = str(data.get("new_name") or "").strip()
            if not new:
                raise RuntimeError("请填写新表名")
            if kind == "mysql":
                cur.execute("RENAME TABLE %s TO %s" % (ref, _table_ref(kind, dbs, schema, new)))
            else:
                cur.execute("ALTER TABLE %s RENAME TO %s" % (ref, _quote(kind, new)))
        elif action == "truncate":
            cur.execute(("TRUNCATE TABLE %s" if kind in ("mysql", "postgres") else "DELETE FROM %s") % ref)
        elif action == "drop":
            cur.execute("DROP TABLE %s" % ref)
        elif action == "alter":
            op = str(data.get("op") or "")
            col = str(data.get("column") or "").strip()
            if op != "add" and not col:
                raise RuntimeError("请选择要操作的列")
            for stmt in _alter_sql(kind, ref, op, col, str(data.get("new_name") or "").strip(),
                                   str(data.get("definition") or "").strip(),
                                   {"parts": data.get("parts") or [],
                                    "type": data.get("type") or "",
                                    "nullable": data.get("nullable"),
                                    "default": data.get("default")}):
                cur.execute(stmt)
        else:
            raise RuntimeError("该操作不适用于 %s" % kind)
        conn.commit()
    finally:
        _close(conn, kind)


def _mongo_value(v):
    """把前端输入还原成合适类型：能当 JSON 解析就解析（数字 / 布尔 / null / 对象）"""
    if not isinstance(v, str):
        return v
    s = v.strip()
    if s == "":
        return ""
    try:
        return json.loads(s)
    except Exception:
        return v


def _table_op_mongo(use, action, table, name, data):
    """MongoDB 的「表」操作（集合）：新建 / 重命名 / 清空 / 删除 / 批量加字段"""
    conn, _k = _open(use, writable=True)
    try:
        db = conn[use.get("dbname") or ""]
        if action == "create":
            if not name:
                raise RuntimeError("请填写集合名")
            db.create_collection(name)
        elif action == "rename":
            new = str(data.get("new_name") or "").strip()
            if not new:
                raise RuntimeError("请填写新的集合名")
            db[table].rename(new)
        elif action == "truncate":
            db[table].delete_many({})
        elif action == "drop":
            db.drop_collection(table)
        elif action == "addfield":
            f = str(data.get("field") or "").strip()
            if not f:
                raise RuntimeError("请填写字段名")
            db[table].update_many({}, {"$set": {f: _mongo_value(data.get("value"))}})
        else:
            raise RuntimeError("该操作不适用于 MongoDB")
    finally:
        _close(conn, kind)


def _table_op_redis(use, action, table, name, data):
    """Redis 的「表」操作（key）：新建 / 重命名 / 设置过期 / 删除"""
    conn, _k = _open(use, writable=True)
    try:
        if action == "create":
            if not name:
                raise RuntimeError("请填写 key 名")
            t = str(data.get("type") or "string").lower()
            val = str(data.get("value") or "")
            if t == "hash":
                f = str(data.get("field") or "").strip()
                if not f:
                    raise RuntimeError("哈希类型需要填写字段名")
                conn.hset(name, f, val)
            elif t == "list":
                conn.rpush(name, val)
            else:
                conn.set(name, val)
        elif action == "rename":
            new = str(data.get("new_name") or "").strip()
            if not new:
                raise RuntimeError("请填写新的 key 名")
            if not conn.exists(table):
                raise RuntimeError("key 不存在：%s" % table)
            conn.rename(table, new)
        elif action == "expire":
            sec = int(data.get("seconds") or 0)
            if sec > 0:
                conn.expire(table, sec)
            else:
                conn.persist(table)
        elif action == "drop":
            conn.delete(table)
        else:
            raise RuntimeError("Redis 只支持 新建 / 重命名 / 设置过期 / 删除 key")
    finally:
        _close(conn, kind)


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
            "drop": "删除", "create": "新建", "hash": "哈希字段", "rename": "重命名",
            "soft_delete": "假删除行"}.get(op, op)


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
        # 键列必须在 INSERT 之前算好：一是 PG 的 RETURNING 要拼进语句，
        # 二是 pymysql 再跑一次 SELECT 会把 lastrowid 重置成 0。
        kcols = _insert_key_cols(cur, kind, use.get("dbname") or "", schema, table)
        key = None
        if kcols and all(c in values for c in kcols):          # 键值自己填了，直接记
            cur.execute(sql, list(values.values()))
            key = dict((c, values[c]) for c in kcols)
        elif len(kcols) == 1 and kind == "postgres":            # PG 没有 lastrowid，用 RETURNING 取回
            cur.execute(sql + " RETURNING %s" % _quote(kind, kcols[0]), list(values.values()))
            r = cur.fetchone()
            if r is not None:
                key = {kcols[0]: _row_vals(r)[0]}
        else:
            cur.execute(sql, list(values.values()))
            if len(kcols) == 1 and kind in ("sqlite", "mysql"):
                rid = getattr(cur, "lastrowid", None)
                if rid:                                        # 0 / None 视为没拿到自增 id
                    key = {kcols[0]: rid}
        n = cur.rowcount
        conn.commit()
        return key, n
    finally:
        _close(conn, kind)


def _insert_many_sql(use, kind, schema, table, rows):
    """批量插入（一个连接、一个事务）；返回 (新行主键列表, 插入行数)

    「随机数据」一次写几十行，逐行走 _insert_sql 会开几十个连接、也记几十条回撤日志，
    这里一次写完只留一条。
    """
    ref = _table_ref(kind, use.get("dbname") or "", schema, table)
    ph = "?" if kind == "sqlite" else "%s"
    conn, _k = _open(use, writable=True)
    try:
        cur = conn.cursor()
        kcols = _insert_key_cols(cur, kind, use.get("dbname") or "", schema, table)
        keys, n = [], 0
        for values in rows:
            cols = list(values.keys())
            if not cols:
                continue
            sql = "INSERT INTO %s (%s) VALUES (%s)" % (ref, ", ".join(_quote(kind, c) for c in cols),
                                                      ", ".join([ph] * len(cols)))
            if kcols and all(c in values for c in kcols):          # 键值自己填了
                cur.execute(sql, list(values.values()))
                keys.append(dict((c, values[c]) for c in kcols))
            elif len(kcols) == 1 and kind == "postgres":
                # PG 没有 lastrowid，用 RETURNING 把新主键拿回来（回撤要靠它）
                cur.execute(sql + " RETURNING %s" % _quote(kind, kcols[0]))
                r = cur.fetchone()
                if r is not None:
                    keys.append({kcols[0]: _row_vals(r)[0]})
            else:
                cur.execute(sql, list(values.values()))
                if len(kcols) == 1 and kind in ("sqlite", "mysql"):
                    rid = getattr(cur, "lastrowid", None)
                    if rid:                                        # 0 / None 视为没拿到自增 id
                        keys.append({kcols[0]: rid})
            n += 1
        conn.commit()
        return keys, n
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


# ------------------------------------------------------------------ 逻辑删除（假删除）
# 约定：表里若存在 deleted_at / is_deleted / del_flag 之类「软删除列」，删除时只把它标记为已删除，
# 不真正 DELETE；列表默认过滤掉已删除的行。没有这种列时，按需自动补一个 is_deleted 标志列。
_SOFTDEL_TS_NAMES = {"deleted_at", "is_deleted_at", "delete_time", "deleted_time",
                     "delete_at", "remove_time", "removed_at", "deleted_on", "is_deleted_at"}
_SOFTDEL_FLAG_NAMES = {"is_deleted", "deleted", "del_flag", "is_del", "delete_flag",
                       "deleted_flag", "is_removed", "removed", "is_remove", "remove_flag",
                       "is_deleted_flag"}


def _col_name_types(cur, kind, dbname, schema, table):
    """返回 [(列名, 类型), ...]；供探查软删除列 / 自动加列。失败返回 []。"""
    try:
        if kind == "sqlite":
            rows = cur.execute("PRAGMA table_info(%s)" % _quote(kind, table)).fetchall()
            return [(r[1], (r[2] or "")) for r in rows]
        cur.execute("SELECT column_name, data_type FROM information_schema.columns "
                    "WHERE table_schema = %s AND table_name = %s ORDER BY ordinal_position",
                    (dbname if kind == "mysql" else (schema or "public"), table))
        return [(_row_vals(r)[0], _row_vals(r)[1]) for r in cur.fetchall()]
    except Exception:
        return []


def _detect_soft_col(cur, kind, dbname, schema, table):
    """只读探查软删除列：(列名, 'flag'|'timestamp') 或 (None, None)。不会改库。"""
    cols = _col_name_types(cur, kind, dbname, schema, table)
    for name, _t in cols:
        if str(name).lower() in _SOFTDEL_TS_NAMES:
            return name, "timestamp"
    for name, _t in cols:
        if str(name).lower() in _SOFTDEL_FLAG_NAMES:
            return name, "flag"
    return None, None


def _add_soft_col(cur, use, kind, schema, table):
    """自动补一个 is_deleted 标志列（只读路径不会调用，仅删除时按需补）。返回 (列名, 'flag')。"""
    ref = _table_ref(kind, use.get("dbname") or "", schema, table)
    if kind == "mysql":
        cur.execute("ALTER TABLE %s ADD COLUMN %s TINYINT(1) NOT NULL DEFAULT 0"
                    % (ref, _quote(kind, "is_deleted")))
    elif kind == "sqlite":
        cur.execute("ALTER TABLE %s ADD COLUMN %s INTEGER NOT NULL DEFAULT 0"
                    % (ref, _quote(kind, "is_deleted")))
    else:   # postgres
        cur.execute('ALTER TABLE %s ADD COLUMN %s SMALLINT NOT NULL DEFAULT 0'
                    % (ref, _quote(kind, "is_deleted")))
    return "is_deleted", "flag"


def _soft_set_value(kind, mode, restore):
    """返回 (占位符或表达式, 参数值 或 None)：flag -> 0/1；timestamp -> NOW()/NULL。"""
    if mode == "timestamp":
        if restore:
            return "NULL", None
        return ("NOW()" if kind != "sqlite" else "datetime('now')"), None
    return ("?" if kind == "sqlite" else "%s"), (0 if restore else 1)


# ------------------------------------------------------------------ 回撤

def _undo_sql(use, kind, schema, table, op, before, after):
    conn, _k = _open(use, writable=True)
    try:
        cur = conn.cursor()
        ph = "?" if kind == "sqlite" else "%s"
        ref = _table_ref(kind, use.get("dbname") or "", schema, table)
        if op in ("update", "soft_delete"):
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
            # 单行记 key，批量插入记 keys（「随机数据」一次写多行，回撤时一起删）
            keys = after.get("keys") or ([after.get("key")] if after.get("key") else [])
            keys = [k for k in keys if k]
            if not keys:
                raise RuntimeError("这条新增没记下主键（该表可能既无主键也无自增列），无法回撤")
            for key in keys:
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
        elif op == "soft_delete":
            coll.update_one({"_id": _mongo_id(before.get("id"))}, {"$set": before.get("set") or {}})
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
                "password": str(pwd), "dbname": str(data.get("dbname") or "").strip(),
                # MongoDB 的连接串（未保存也能测）：优先用刚粘贴的那条
                "params": str(data.get("uri") or data.get("params") or "").strip()}
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


@bp.route("/api/db/table/columns", methods=["GET"])
def api_db_table_columns():
    """表结构：列名 / 类型 / 是否可空 / 默认值 / 是否主键

    MongoDB 没有固定结构，改采样首条文档的字段充当「列」。
    """
    cid = str(request.args.get("conn") or "")
    dbname = str(request.args.get("dbname") or "")
    schema = str(request.args.get("schema") or "")
    table = str(request.args.get("table") or "")
    if not table:
        return jsonify({"error": "缺少表名"}), 400
    conf = _load_conf(cid, with_password=True)
    if not conf:
        return jsonify({"error": "连接不存在"}), 404
    if (conf.get("kind") or "") == "redis":
        return jsonify({"error": "Redis 没有列结构"}), 400
    use = _pick(conf, dbname)
    try:
        with _LOCK:
            conn, kind = _open(use)
            try:
                if kind == "mongodb":
                    doc = conn[use.get("dbname") or ""][table].find_one({})
                    if doc:
                        cols = [{"name": k, "type": type(v).__name__, "nullable": True,
                                 "default": None, "pk": (k == "_id"), "extra": ""}
                                for k, v in doc.items()]
                    else:
                        cols = [{"name": "_id", "type": "ObjectId", "nullable": False,
                                 "default": None, "pk": True, "extra": ""}]
                else:
                    cur = conn.cursor()
                    cols = _columns_info(cur, kind, use.get("dbname") or "", schema, table)
            finally:
                _close(conn, kind)
    except Exception as e:
        return jsonify({"error": "读取表结构失败：%s" % e}), 500
    return jsonify({"table": table, "kind": kind, "columns": cols})


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
    include_deleted = request.args.get("include_deleted") == "1"
    order_col = str(request.args.get("order") or "").strip()          # 表头点击排序：排序列 / 方向
    order_dir = "DESC" if str(request.args.get("dir") or "").lower() == "desc" else "ASC"
    conf = _load_conf(cid, with_password=True)
    if not conf:
        return jsonify({"error": "连接不存在"}), 404
    use = _pick(conf, dbname)
    try:
        with _LOCK:
            conn, kind = _open(use)
            try:
                pk = []                          # 主键列（编辑行时用来定位）
                soft_col, soft_mode = None, None
                if kind in _NOSQL:
                    dbn = use.get("dbname") or ""
                    if kind == "mongodb" and table not in conn[dbn].list_collection_names():
                        return jsonify({"error": "集合不存在：%s" % table}), 404
                    cols, rows, total = _nosql_rows(conn, kind, use, table, limit, offset,
                                                    include_deleted, order_col, order_dir)
                    if kind == "mongodb":
                        pk = ["_id"]
                        soft_col, soft_mode = "is_deleted", "flag"   # Mongo 约定用 is_deleted 字段
                else:
                    cur = conn.cursor()
                    names = {t["name"] for t in _list_tables(cur, kind, use.get("dbname") or "")}
                    if table not in names:           # 表名必须真实存在，避免拼接注入
                        return jsonify({"error": "表不存在：%s" % table}), 404
                    pk = _pk_columns(cur, kind, use.get("dbname") or "", schema, table)
                    ref = _table_ref(kind, use.get("dbname") or "", schema, table)
                    soft_col, soft_mode = _detect_soft_col(cur, kind, use.get("dbname") or "", schema, table)
                    where = ""
                    if soft_col and not include_deleted:      # 默认过滤掉已逻辑删除的行
                        where = " WHERE " + (_quote(kind, soft_col) + " IS NULL" if soft_mode == "timestamp"
                                            else "COALESCE(%s,0)=0" % _quote(kind, soft_col))
                    total = None
                    try:
                        cur.execute("SELECT COUNT(*) FROM %s%s" % (ref, where))
                        row = cur.fetchone()
                        total = list(row.values())[0] if isinstance(row, dict) else row[0]
                    except Exception:
                        pass
                    # 排序：列名先用一条 LIMIT 0 确认真实存在再拼接（比查 information_schema 便宜，也不给注入留口子）
                    order_by = ""
                    if order_col:
                        cur.execute("SELECT * FROM %s LIMIT 0" % ref)
                        if order_col in [d0[0] for d0 in (cur.description or [])]:
                            order_by = " ORDER BY %s %s" % (_quote(kind, order_col), order_dir)
                    cur.execute("SELECT * FROM %s%s%s LIMIT %d OFFSET %d"
                                % (ref, where, order_by, limit, offset))
                    cols, rows = _rows_of(cur, kind)
            finally:
                _close(conn, kind)
    except Exception as e:
        return jsonify({"error": "读取数据失败：%s" % e}), 500
    return jsonify({"table": table, "columns": cols, "rows": rows, "pk": pk,
                    "total": total, "limit": limit, "offset": offset,
                    "soft_col": soft_col, "soft_mode": soft_mode})


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
    key = None
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
    undone_key = key if isinstance(key, dict) and key else None
    if kind in ("redis", "mongodb"):
        can_undo = True                                   # Redis 靠 before 快照，Mongo 靠 inserted_id
        note = ""
    else:
        can_undo = bool(undone_key)                       # SQL：没拿到主键就回撤不了
        note = "" if can_undo else "（无主键，不可回撤）"
    wid = _log_write(cid, kind, use.get("dbname") or "", schema, table, "insert",
                     "新增一行（%d 个字段）%s" % (len(values), note),
                     before=before, after=after, after_text=after_text, undoable=can_undo)
    _log.info("新增数据行：kind=%s table=%s 字段=%s 可回撤=%s", kind, table, list(values), can_undo)
    return jsonify({"ok": True, "inserted": n, "write_id": wid})


@bp.route("/api/db/row/fake", methods=["POST"])
def api_db_row_fake():
    """按表结构随机生成测试数据（纯规则，不调用 AI）。

    只造数不落库：返回 {columns, rows, skipped}，前端可以填进「新增行」表单让人先改，
    也可以原样丢给 /api/db/row/insert-many 一次写入多行。
    """
    data = request.get_json(silent=True) or {}
    cid = str(data.get("conn") or "")
    dbname = str(data.get("dbname") or "")
    schema = str(data.get("schema") or "")
    table = str(data.get("table") or "")
    if not table:
        return jsonify({"error": "缺少表名"}), 400
    try:
        count = min(max(int(data.get("count", 1)), 1), _FAKE_MAX)
    except (TypeError, ValueError):
        count = 1
    conf = _load_conf(cid, with_password=True)
    if not conf:
        return jsonify({"error": "连接不存在"}), 404
    kind = conf.get("kind") or "sqlite"
    if kind in _NOSQL:
        return jsonify({"error": "只有 SQLite / MySQL / PostgreSQL 能按表结构造数"}), 400
    use = _pick(conf, dbname)
    try:
        with _LOCK:
            conn, kind = _open(use)
            try:
                cur = conn.cursor()
                names = {t["name"] for t in _list_tables(cur, kind, use.get("dbname") or "")}
                if table not in names:               # 表名必须真实存在，避免拼接注入
                    return jsonify({"error": "表不存在：%s" % table}), 404
                cols = _fake_cols(cur, kind, use.get("dbname") or "", schema, table)
            finally:
                _close(conn, kind)
    except Exception as e:
        return jsonify({"error": "读取表结构失败：%s" % e}), 500
    if not cols or all(c["skip"] for c in cols):
        return jsonify({"error": "这张表没有可造数的列（都是自增 / 二进制 / 生成列）"}), 400
    rows, skipped = _fake_rows(cols, count, datetime.now())
    _log.info("随机生成测试数据：kind=%s table=%s %d 行 跳过=%s",
              kind, table, len(rows), skipped)
    return jsonify({"columns": [c["name"] for c in cols], "rows": rows,
                    "skipped": skipped[:_FAKE_SKIP_MAX], "max": _FAKE_MAX})


@bp.route("/api/db/row/insert-many", methods=["POST"])
def api_db_row_insert_many():
    """批量新增（给「随机数据」用）：一个事务写入多行，整体只记 1 条可回撤日志。"""
    data = request.get_json(silent=True) or {}
    cid = str(data.get("conn") or "")
    dbname = str(data.get("dbname") or "")
    schema = str(data.get("schema") or "")
    table = str(data.get("table") or "")
    raw = data.get("rows") if isinstance(data.get("rows"), list) else []
    rows = [dict(r) for r in raw[:_FAKE_MAX] if isinstance(r, dict) and r]
    if not table:
        return jsonify({"error": "缺少表名"}), 400
    if not rows:
        return jsonify({"error": "没有要写入的数据"}), 400
    conf = _load_conf(cid, with_password=True)
    if not conf:
        return jsonify({"error": "连接不存在"}), 404
    kind = conf.get("kind") or "sqlite"
    if kind in _NOSQL:
        return jsonify({"error": "批量新增只支持 SQLite / MySQL / PostgreSQL"}), 400
    use = _pick(conf, dbname)
    try:
        with _LOCK:
            conn, kind = _open(use)
            try:
                cur = conn.cursor()
                names = {t["name"] for t in _list_tables(cur, kind, use.get("dbname") or "")}
                if table not in names:
                    return jsonify({"error": "表不存在：%s" % table}), 404
                # 字段名必须来自这张表：值走参数化，列名是拼进 SQL 的，得先挡一道
                known = {c["name"] for c in _columns_info(cur, kind, use.get("dbname") or "",
                                                          schema, table)}
            finally:
                _close(conn, kind)
        bad = set()
        for r in rows:
            bad |= {c for c in r if c not in known}
        if bad:
            return jsonify({"error": "字段不存在：%s" % "、".join(sorted(bad)[:8])}), 400
        keys, n = _insert_many_sql(use, kind, schema, table, rows)
    except Exception as e:
        return jsonify({"error": "批量新增失败：%s" % e}), 400
    wid = _log_write(cid, kind, use.get("dbname") or "", schema, table, "insert",
                     "批量新增 %d 行（随机数据）%s" % (n, "" if keys else "（无主键，不可回撤）"),
                     after={"keys": keys}, undoable=bool(keys))
    _log.info("批量新增：kind=%s table=%s 行数=%d 可回撤=%s", kind, table, n, bool(keys))
    return jsonify({"ok": True, "inserted": n, "undoable": bool(keys), "write_id": wid})


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


@bp.route("/api/db/row/soft-delete", methods=["POST"])
def api_db_row_soft_delete():
    """逻辑删除（假删除）：把软删除列标记为已删除，列表默认过滤掉；可回撤还原。

    restore=true 时把标记清零（恢复这一行）。Redis 不支持（没有行概念），请走真删除。
    """
    data = request.get_json(silent=True) or {}
    cid = str(data.get("conn") or "")
    dbname = str(data.get("dbname") or "")
    schema = str(data.get("schema") or "")
    table = str(data.get("table") or "")
    key = data.get("key") if isinstance(data.get("key"), dict) else {}
    restore = bool(data.get("restore"))
    if not key:
        return jsonify({"error": "缺少定位这一行的主键"}), 400
    conf = _load_conf(cid, with_password=True)
    if not conf:
        return jsonify({"error": "连接不存在"}), 404
    use = _pick(conf, dbname)
    kind = conf.get("kind") or "sqlite"
    if kind == "redis":
        return jsonify({"error": "Redis 不支持逻辑删除（请用行详情里的真删除）"}), 400
    try:
        with _LOCK:
            conn, _k = _open(use, writable=True)
            try:
                cur = conn.cursor()
                if kind == "mongodb":
                    coll = conn[use.get("dbname") or ""][table]
                    doc_id = _mongo_id(key.get("_id"))
                    doc = coll.find_one({"_id": doc_id})
                    if doc is None:
                        raise RuntimeError("没找到这条记录")
                    scol = "is_deleted"
                    old_val = doc.get(scol)
                    coll.update_one({"_id": doc_id}, {"$set": {scol: (0 if restore else 1)}})
                    n = 1
                    wid = _log_write(cid, kind, use.get("dbname") or "", schema, table, "soft_delete",
                                     "还原一行" if restore else "假删除一行",
                                     before={"id": str(key.get("_id")), "set": {scol: old_val}},
                                     undoable=True)
                    soft_col, mode = scol, "flag"
                else:
                    ref = _table_ref(kind, use.get("dbname") or "", schema, table)
                    soft_col, mode = _detect_soft_col(cur, kind, use.get("dbname") or "", schema, table)
                    if soft_col is None:                          # 没有软删除列就自动补一个
                        soft_col, mode = _add_soft_col(cur, use, kind, schema, table)
                        conn.commit()
                    ph = "?" if kind == "sqlite" else "%s"
                    whr = " AND ".join("%s = %s" % (_quote(kind, c), ph) for c in key)
                    cur.execute("SELECT %s FROM %s WHERE %s LIMIT 1" %
                                (_quote(kind, soft_col), ref, whr), list(key.values()))
                    rr = cur.fetchone()
                    old_val = _row_vals(rr)[0] if rr else (None if mode == "timestamp" else 0)
                    set_sql, set_param = _soft_set_value(kind, mode, restore)
                    if set_param is None:                         # timestamp 模式：NOW()/NULL 直接拼
                        cur.execute("UPDATE %s SET %s = %s WHERE %s" % (ref, _quote(kind, soft_col), set_sql, whr),
                                    list(key.values()))
                    else:
                        cur.execute("UPDATE %s SET %s = %s WHERE %s" % (ref, _quote(kind, soft_col), ph, whr),
                                    [set_param] + list(key.values()))
                    n = cur.rowcount
                    conn.commit()
                    wid = _log_write(cid, kind, use.get("dbname") or "", schema, table, "soft_delete",
                                     "还原一行" if restore else "假删除一行",
                                     before={"key": key, "set": {soft_col: old_val}}, undoable=True)
            finally:
                _close(conn, kind)
    except Exception as e:
        return jsonify({"error": "操作失败：%s" % e}), 400
    _log.info("逻辑删除：kind=%s table=%s restore=%s", kind, table, restore)
    return jsonify({"ok": True, "updated": n, "write_id": wid, "soft_col": soft_col, "mode": mode})


# --------------------------------------------------------------------------- 库级操作

# 数据库名白名单：字母 / 数字 / 下划线 / 中划线 / 中文；空格、引号、分号、斜杠等一律拒绝
_DB_NAME_RE = re.compile(r"^[A-Za-z0-9_\u4e00-\u9fff-]{1,64}$")
# MySQL 建库时字符集 → 默认排序规则（表里没列到的按 <charset>_general_ci 拼）
_DB_COLLATE = {"utf8mb4": "utf8mb4_general_ci", "utf8": "utf8_general_ci",
               "utf8mb3": "utf8_general_ci", "latin1": "latin1_swedish_ci",
               "gbk": "gbk_chinese_ci", "big5": "big5_chinese_ci", "ascii": "ascii_general_ci"}
# 没有「建库」这一步的类型：给一句能直接照做的引导，而不是丢个语法错误给用户
_DB_NEW_UNSUPPORTED = {
    "sqlite": "SQLite 是「一个文件一个库」，请用「新建连接」选择已有的 .db / .sqlite 文件",
    "redis": "Redis 的库是编号（0-15）的，不用新建：连接里把「库名」填成想要的下标即可",
    "mongodb": "MongoDB 的库不用预先创建，写入第一个集合时自动生成",
}


def _create_database_sql(kind, name, charset=""):
    """拼「新建数据库」语句（库名已过白名单，再由 _quote 按方言转义）"""
    if kind != "mysql":
        return "CREATE DATABASE %s" % _quote(kind, name)          # PostgreSQL
    sql = "CREATE DATABASE %s" % _quote(kind, name)
    cs = (charset or "").strip().lower()
    if cs:
        if not re.match(r"^[a-z0-9_]{1,32}$", cs):
            raise RuntimeError("字符集不合法：%s" % charset)
        sql += " CHARACTER SET %s COLLATE %s" % (cs, _DB_COLLATE.get(cs, "%s_general_ci" % cs))
    return sql


@bp.route("/api/db/database", methods=["POST"])
def api_db_database():
    """库级操作：目前只有「新建数据库」（MySQL / MariaDB、PostgreSQL）。

    建库是结构级操作、不可回撤（前端会强提示），库名白名单校验后再按方言转义；
    其它类型没有「建库」这一步，直接返回对应的引导文案。
    """
    data = request.get_json(silent=True) or {}
    cid = str(data.get("conn") or "")
    action = str(data.get("action") or "create")
    name = str(data.get("name") or "").strip()
    if action != "create":
        return jsonify({"error": "未知操作：%s" % action}), 400
    if not name:
        return jsonify({"error": "请填写数据库名"}), 400
    if not _DB_NAME_RE.match(name):
        return jsonify({"error": "数据库名不合法：只允许字母、数字、下划线、中划线和中文，最多 64 个字符"}), 400
    conf = _load_conf(cid, with_password=True)
    if not conf:
        return jsonify({"error": "连接不存在"}), 404
    kind = conf.get("kind") or "sqlite"
    if kind not in ("mysql", "postgres"):
        return jsonify({"error": "该类型不支持新建数据库：%s" % _DB_NEW_UNSUPPORTED.get(kind, kind)}), 400
    try:
        sql = _create_database_sql(kind, name, str(data.get("charset") or ""))
    except Exception as e:
        return jsonify({"error": str(e)}), 400
    use = dict(conf)
    # MySQL 建库不需要先连进某个库：连接里记的库万一被删了，也不该连建库都做不了
    if kind == "mysql":
        use["dbname"] = ""
    try:
        with _LOCK:
            conn, _k = _open(use, writable=True)
            try:
                cur = conn.cursor()
                cur.execute(sql)
                try:
                    conn.commit()
                except Exception:
                    pass
            finally:
                _close(conn, kind)
    except Exception as e:
        return jsonify({"error": "新建数据库失败：%s" % e}), 400
    _log.info("新建数据库：kind=%s name=%s", kind, name)
    return jsonify({"ok": True, "name": name, "sql": sql})


@bp.route("/api/db/table", methods=["POST"])
def api_db_table():
    """表级操作（各类库按自己的语义落地）：

      · SQL（SQLite / MySQL / PostgreSQL）：create / rename / truncate / drop / alter（改列结构）
      · MongoDB：create / rename / truncate / drop / addfield（给所有文档批量加字段）
      · Redis：create（新建 key）/ rename / expire（设置过期）/ drop（删除 key）

    清空 / 删除 / 重命名 / 改结构都会动到结构或大量数据，**不支持回撤**，界面上会强提示。
    """
    data = request.get_json(silent=True) or {}
    cid = str(data.get("conn") or "")
    dbname = str(data.get("dbname") or "")
    schema = str(data.get("schema") or "")
    action = str(data.get("action") or "")
    table = str(data.get("table") or "").strip()
    name = str(data.get("name") or "").strip()
    if action not in ("create", "rename", "truncate", "drop", "alter", "addfield", "expire"):
        return jsonify({"error": "未知操作：%s" % action}), 400
    if action != "create" and not table:
        return jsonify({"error": "缺少表名 / 集合名 / key"}), 400
    conf = _load_conf(cid, with_password=True)
    if not conf:
        return jsonify({"error": "连接不存在"}), 404
    use = _pick(conf, dbname)
    kind = conf.get("kind") or "sqlite"
    try:
        with _LOCK:
            if kind == "redis":
                _table_op_redis(use, action, table, name, data)
            elif kind == "mongodb":
                _table_op_mongo(use, action, table, name, data)
            else:
                _table_op_sql(use, kind, schema, action, table, name, data)
    except Exception as e:
        return jsonify({"error": "操作失败：%s" % e}), 400
    label = {"create": "新建 ", "rename": "重命名 %s → %s" % (table, str(data.get("new_name") or "")),
             "truncate": "清空 " + table, "drop": "删除 " + table,
             "alter": "%s 列结构" % {"add": "新增", "drop": "删除", "modify": "修改",
                                     "rename": "重命名"}.get(str(data.get("op") or ""), "调整"),
             "addfield": "为全部文档新增字段 " + str(data.get("field") or ""),
             "expire": "设置过期 " + table}.get(action, action)
    summary = (label + (name or "")) if action == "create" else label
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

    from ..ide.ai import (_load_cfg, _sys_pick, _log_ai_call, _sys_err_response,
                          _estimate_msgs, _estimate_tokens)   # 函数内导入，避免模块循环依赖
    cfg = _load_cfg()
    provider, model, err = _sys_pick(cfg, "nl2sql")
    if err:
        return _sys_err_response(err, need_config=not cfg.get("providers"))

    t_start = time.time()
    req_text = ""      # 明细用：这次实际发出去的请求摘要与收到的响应（失败时也一并带上）
    resp_text = ""
    tin = tout = 0
    est = False

    def _fail(msg, code=502, **extra):
        """统一失败出口：记一次失败调用再返回"""
        _log_ai_call("nl2sql", False, int((time.time() - t_start) * 1000), msg,
                     model, tin, tout, est, req=req_text, resp=resp_text)
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
    req_text = content
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
        resp_text = text
        u = obj.get("usage") or {}
        tin, tout = u.get("prompt_tokens") or 0, u.get("completion_tokens") or 0
        if not (tin or tout):                 # 上游没给 usage：按字数兜底估算，界面标「≈」
            tin = _estimate_msgs([{"role": "system", "content": sys_prompt},
                                  {"role": "user", "content": content}])
            tout, est = _estimate_tokens(text), True
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
    _log_ai_call("nl2sql", True, elapsed, "", model, tin, tout, est,
                 req=req_text, resp=resp_text)
    _log.info("AI 生成查询：kind=%s model=%s %dms out=%s", kind, model, elapsed, out[:200])
    return jsonify({"sql": out, "model": model, "elapsed_ms": elapsed})


# --------------------------------------------------------------------------- AI 推荐表设计
# 给「表结构设计」弹窗用：一句话描述 → 一份列定义，回填到弹窗里让用户过目 / 修改后再保存。
# 只生成、不落库（保存仍然走 /api/db/table），所以模型出错最坏也只是表单填得不对。

def _td_split_def(s):
    """把模型给的「类型 / 定义」拆成 (纯类型, 默认值)。

    弹窗把类型、可空、默认值分开存，保存时再用 colDef() 拼回一句 DDL；
    不拆干净就会拼出 `INT NOT NULL DEFAULT 0 DEFAULT 0` 这种重复定义。
    """
    t = re.sub(r"[\r\n;]+", " ", str(s or ""))
    t = re.sub(r"\s+", " ", t).strip()
    t = re.sub(r"\bNOT\s+NULL\b", "", t, flags=re.I)
    t = re.sub(r"\bPRIMARY\s+KEY\b", "", t, flags=re.I)
    t = re.sub(r"\bUNIQUE\b", "", t, flags=re.I)
    t = re.sub(r"\bAUTO_?INCREMENT\b", "", t, flags=re.I)   # 自增跟着主键一起补，见 _td_pk_def
    dflt = ""
    m = re.search(r"\bDEFAULT\b\s*(.+)$", t, flags=re.I)
    if m:
        dflt = m.group(1).strip()
        t = t[:m.start()]
    return re.sub(r"\s+", " ", t).strip().strip(",")[:_TD_TYPE], _td_clean_default(dflt)


def _td_clean_default(v):
    """默认值：掐掉换行 / 分号，留 `'abc'` / `0` / `now()` 这类字面量原样"""
    s = re.sub(r"[\r\n;]+", " ", str(v if v is not None else ""))
    s = re.sub(r"\s+", " ", s).strip()
    if s.lower() in ("", "none", "null", "无", "-", "--"):
        return ""
    return s[:80]


def _td_columns(raw):
    """把模型返回的 columns 规整成弹窗的四要素：清列名、去重、限长、类型必填"""
    out, seen = [], set()
    for c in (raw or []):
        if not isinstance(c, dict):
            continue
        name = re.sub(r"[\s\"'`;,\-]+", "_", str(c.get("name") or "")).strip("_")
        if not name or name in seen:
            continue
        typ, dflt = _td_split_def(c.get("type"))
        if not typ:
            continue
        nv = c.get("nullable")
        pk = bool(c.get("pk"))
        seen.add(name)
        out.append({"name": name, "type": typ, "nullable": True if nv is None else bool(nv),
                    "default": _td_clean_default(c.get("default")) or dflt, "pk": pk})
        if len(out) >= _TD_COLS:
            break
    return out


def _td_pk_def(kind, typ):
    """把主键写进「类型定义」里。

    新建表时弹窗是把整句类型定义拼进 CREATE TABLE 的，只给 pk 标记建不出主键；
    这也和弹窗里新建表的默认行（INTEGER PRIMARY KEY AUTOINCREMENT 之类）保持一致。
    """
    t = (typ or "").strip()
    low = t.lower()
    if "primary key" in low:
        return t
    base = low.split("(")[0].strip()
    ints = ("int", "integer", "smallint", "bigint", "tinyint", "serial", "bigserial")
    if kind == "postgres" and base in ints:
        return ("BIGSERIAL" if base in ("bigint", "bigserial") else "SERIAL") + " PRIMARY KEY"
    if kind == "sqlite" and base in ints:
        return "INTEGER PRIMARY KEY AUTOINCREMENT"
    if kind == "mysql" and base in ints:
        return t + " PRIMARY KEY AUTO_INCREMENT"
    return t + " PRIMARY KEY"


@bp.route("/api/db/table/ai-design", methods=["POST"])
def api_db_table_ai_design():
    """AI 推荐表设计：一句话需求（+ 已有表结构）→ 表名与列定义。

    只服务 SQL 库（Redis 是 key、MongoDB 是 schemaless，都没有「表结构」可设计）。
    返回的列定义会填进弹窗，用户确认后仍由 /api/db/table 落库。
    """
    data = request.get_json(silent=True) or {}
    cid = str(data.get("conn") or "")
    dbname = str(data.get("dbname") or "")
    schema = str(data.get("schema") or "")
    table = str(data.get("table") or "").strip()
    question = str(data.get("question") or "").strip()
    if not question:
        return jsonify({"error": "请先用一句话描述这张表要存什么"}), 400
    if len(question) > _TD_MAX:
        return jsonify({"error": "描述过长（上限 %d 字）" % _TD_MAX}), 400
    conf = _load_conf(cid, with_password=True)
    if not conf:
        return jsonify({"error": "连接不存在"}), 404
    kind = conf.get("kind") or "sqlite"
    if kind not in ("sqlite", "mysql", "postgres"):
        return jsonify({"error": "只有 SQLite / MySQL / PostgreSQL 支持设计表结构"}), 400
    use = _pick(conf, dbname)
    dbname = use.get("dbname") or ""

    from ..ide.ai import (_load_cfg, _sys_pick, _log_ai_call, _sys_err_response,
                          _estimate_msgs, _estimate_tokens)   # 函数内导入，避免模块循环依赖
    cfg = _load_cfg()
    provider, model, err = _sys_pick(cfg, "tabledesign")
    if err:
        return _sys_err_response(err, need_config=not cfg.get("providers"))

    t_start = time.time()
    req_text = ""      # 明细用：这次实际发出去的请求摘要与收到的响应（失败时也一并带上）
    resp_text = ""
    tin = tout = 0
    est = False

    def _fail(msg, code=502, **extra):
        _log_ai_call("tabledesign", False, int((time.time() - t_start) * 1000), msg,
                     model, tin, tout, est, req=req_text, resp=resp_text)
        return jsonify({"error": msg, **extra}), code

    # 上下文：改已有表 → 带上它的列结构；新建表 → 带上库里的表名，免得重名
    ctx = ""
    try:
        with _LOCK:
            conn, _k = _open(use)
            try:
                cur = conn.cursor()
                _timeout_guard(conn, kind)
                if table:
                    cols = _columns_info(cur, kind, dbname, schema, table)
                    if cols:
                        ctx = "[表 %s 的现有结构]\n%s\n\n" % (table, "\n".join(
                            "  %s %s%s%s" % (c["name"], c["type"],
                                            "" if c["nullable"] else " NOT NULL",
                                            (" DEFAULT " + str(c["default"])) if c["default"] is not None else "")
                            for c in cols))
                else:
                    names = [t["name"] for t in _list_tables(cur, kind, dbname)][:_NL_TABLES]
                    if names:
                        ctx = "[库里已有的表（新表不要重名）]\n  " + "、".join(names) + "\n\n"
            finally:
                _close(conn, kind)
    except Exception as e:
        return jsonify({"error": "无法读取数据库结构：%s" % e}), 500

    dialect = {"sqlite": "SQLite", "mysql": "MySQL", "postgres": "PostgreSQL"}.get(kind, kind)
    sys_prompt = _TD_SYS.format(
        dialect=dialect,
        types={"sqlite": "INTEGER / TEXT / REAL / BLOB / NUMERIC",
               "mysql": "INT / BIGINT / VARCHAR(255) / TEXT / DECIMAL(10,2) / DATETIME / DATE / JSON / TINYINT(1)",
               "postgres": "integer / bigint / varchar(255) / text / numeric(10,2) / timestamp / date / boolean / jsonb"}[kind],
        now={"sqlite": "CURRENT_TIMESTAMP", "mysql": "CURRENT_TIMESTAMP", "postgres": "now()"}[kind],
    )
    content = (ctx + "[设计要求]\n" + question)[:_NL_CTX]
    req_text = content
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
        resp_text = text
        u = obj.get("usage") or {}
        tin, tout = u.get("prompt_tokens") or 0, u.get("completion_tokens") or 0
        if not (tin or tout):                 # 上游没给 usage：按字数兜底估算，界面标「≈」
            tin = _estimate_msgs([{"role": "system", "content": sys_prompt},
                                  {"role": "user", "content": content}])
            tout, est = _estimate_tokens(text), True
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "ignore")[:200]
        return _fail("AI 接口返回 %s：%s" % (e.code, detail))
    except Exception as e:
        return _fail("调用 AI 接口失败：%s" % e)

    _log.info("AI 推荐表结构：kind=%s model=%s text=%s", kind, model, _excerpt(text, 300))

    out = _clean_json(text)
    spec = None
    if out:
        try:
            spec = json.loads(out)
        except Exception:
            spec = None
    if not isinstance(spec, dict):
        return _fail("模型没有返回可用的 JSON，请换个说法或换个模型（模型原话：%s）" % _excerpt(text))
    if spec.get("error"):
        return _fail(str(spec["error"])[:200], 400)

    cols = _td_columns(spec.get("columns"))
    if not cols:
        return _fail("模型没有给出可用的列定义，请换个说法或换个模型（模型原话：%s）" % _excerpt(text))
    if not table:                                  # 新建表：主键必须写进类型，否则建不出主键
        first = None
        for c in cols:
            if not c["pk"]:
                continue
            if first is None:
                first = c
                c["type"] = _td_pk_def(kind, c["type"])
                c["nullable"] = False
            else:
                c["pk"] = False                    # 一个表只能有一个主键
        if first is None:                          # 模型漏了主键就补在第一列上，否则这张表没法改 / 删行
            first = cols[0]
            first["pk"] = True
            first["nullable"] = False
            first["type"] = _td_pk_def(kind, first["type"])

    name = re.sub(r"[\s\"'`;,\-./]+", "_", str(spec.get("table") or "")).strip("_")[:_TD_TYPE]
    elapsed = int((time.time() - t0) * 1000)
    _log_ai_call("tabledesign", True, elapsed, "", model, tin, tout, est,
                 req=req_text, resp=resp_text)
    _log.info("AI 推荐表结构：kind=%s model=%s %dms table=%s %d 列", kind, model, elapsed, name, len(cols))
    return jsonify({"table": name, "columns": cols, "note": str(spec.get("note") or "")[:200],
                    "model": model, "elapsed_ms": elapsed})

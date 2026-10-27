"""V2Ray / Xray 代理模块的存储层（store.db 的 v2ray_subs / v2ray_nodes / v2ray_cfg 三张表）。

建表 DDL 放在本模块（而不是 store_db.py 的 _SCHEMA）里：
这三张表只属于本模块，跟着模块一起演进，模块被删除时也不留残余依赖。

对外接口：
    init_db()                          幂等建表（导入时自动执行一次）
    get_setting / set_setting / all_settings   模块设置（v2ray_cfg 键值表）
    list_subs / get_sub / save_sub / delete_sub / set_sub_result
    list_nodes / get_node / add_nodes / update_node / delete_nodes / clear_sub_nodes
"""
import json
import time
import uuid

from ...log import get_logger
from ..common.store_db import store_conn, store_tx

_log = get_logger()

_SCHEMA = """
CREATE TABLE IF NOT EXISTS v2ray_subs (
    id          TEXT PRIMARY KEY,
    name        TEXT DEFAULT '',
    url         TEXT DEFAULT '',
    proxy       TEXT DEFAULT '',
    enabled     INTEGER NOT NULL DEFAULT 1,
    node_count  INTEGER NOT NULL DEFAULT 0,
    last_error  TEXT DEFAULT '',
    created_at  REAL NOT NULL DEFAULT 0,
    updated_at  REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS v2ray_nodes (
    id         TEXT PRIMARY KEY,
    sub_id     TEXT DEFAULT '',
    name       TEXT DEFAULT '',
    proto      TEXT DEFAULT '',
    server     TEXT DEFAULT '',
    port       INTEGER NOT NULL DEFAULT 0,
    raw        TEXT DEFAULT '',
    node_json  TEXT DEFAULT '',
    remark     TEXT DEFAULT '',
    grp        TEXT DEFAULT '',
    sort       INTEGER NOT NULL DEFAULT 0,
    created_at REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_v2ray_nodes_sub ON v2ray_nodes(sub_id, sort);
CREATE TABLE IF NOT EXISTS v2ray_cfg (
    key   TEXT PRIMARY KEY,
    value TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS v2ray_traffic (
    node_id    TEXT PRIMARY KEY,   -- 节点 id；特殊值 __total__ = 全局总流量
    up         INTEGER NOT NULL DEFAULT 0,
    down       INTEGER NOT NULL DEFAULT 0,
    updated_at REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS v2ray_traffic_day (
    day        TEXT PRIMARY KEY,   -- 本地日期 YYYY-MM-DD
    up         INTEGER NOT NULL DEFAULT 0,
    down       INTEGER NOT NULL DEFAULT 0,
    updated_at REAL NOT NULL DEFAULT 0
);
"""

# 模块默认设置（未落库时用这些值）
DEFAULT_SETTINGS = {
    "core_path": "",            # 手动指定的 Xray / V2Ray 内核路径（留空 = 自动探测）
    "core_path_singbox": "",    # 手动指定的 sing-box 内核路径（与 xray 分开存，切 Tab 互不覆盖）
    "core_url": "",             # 一键下载内核的地址（留空 = 官方 Release 直链）
    "core_kind": "xray",        # 当前使用的内核类型：xray（Xray-core）/ sing-box
    "socks_port": 10808,        # SOCKS5 入站端口
    "socks_listen": "0.0.0.0",  # 入站监听地址（0.0.0.0 = 供局域网其他用户使用）
    "socks_user": "",           # 非空则要求用户名密码认证
    "socks_pass": "",
    "http_port": 0,             # HTTP 入站端口（0 = 不开启）
    "log_level": "warning",
    "active_node": "",          # 上次连接的节点 id（启动时可自动重连）
    "auto_start": 0,            # 服务启动后自动连接上次的节点
    "sub_proxy": "",            # 拉取订阅时使用的代理（如 socks5://127.0.0.1:10808）
    "api_port": 15490,          # 内核统计 API 端口（实时网速 / 流量统计依赖它；0 = 关闭）
    "auth_enabled": 1,          # SOCKS5 认证开关（1 = 启用；仅本机监听时可关闭，0.0.0.0 强制启用）
}

_LISTEN_CHOICES = ("0.0.0.0", "127.0.0.1")


def init_db():
    """幂等建表；失败只告警，不阻断服务启动。"""
    try:
        with store_tx() as conn:
            conn.executescript(_SCHEMA)
    except Exception as e:                      # noqa: BLE001
        _log.warning("V2Ray 表初始化失败: %s", e)
    # 旧库迁移：v2ray_nodes 补 grp（自定义分组）列，已存在则忽略
    try:
        with store_tx() as conn:
            conn.execute("ALTER TABLE v2ray_nodes ADD COLUMN grp TEXT DEFAULT ''")
    except Exception:
        pass


# ---------------------------------------------------------------------------
# 模块设置
# ---------------------------------------------------------------------------

def all_settings() -> dict:
    out = dict(DEFAULT_SETTINGS)
    try:
        conn = store_conn()
        try:
            for r in conn.execute("SELECT key, value FROM v2ray_cfg"):
                try:
                    out[r["key"]] = json.loads(r["value"])
                except (TypeError, ValueError):
                    out[r["key"]] = r["value"]
        finally:
            conn.close()
    except Exception as e:                      # noqa: BLE001
        _log.warning("读取 V2Ray 设置失败: %s", e)
    return out


def set_setting(key, value):
    with store_tx() as conn:
        conn.execute("INSERT OR REPLACE INTO v2ray_cfg (key, value) VALUES (?, ?)",
                     (str(key), json.dumps(value, ensure_ascii=False)))


def set_settings(items: dict):
    with store_tx() as conn:
        for k, v in (items or {}).items():
            conn.execute("INSERT OR REPLACE INTO v2ray_cfg (key, value) VALUES (?, ?)",
                         (str(k), json.dumps(v, ensure_ascii=False)))


# ---------------------------------------------------------------------------
# 流量统计（实时网速由 v2raymgr 采样后写入这里，持久化保存）
# ---------------------------------------------------------------------------

def add_traffic(node_id, up: int, down: int):
    """给某节点（或 __total__ 总行）累加流量字节；node_id 为空或增量为 0 时忽略。"""
    node_id = str(node_id or "")
    up, down = int(up or 0), int(down or 0)
    if not node_id or (up <= 0 and down <= 0):
        return
    with store_tx() as conn:
        conn.execute(
            "INSERT INTO v2ray_traffic (node_id, up, down, updated_at) VALUES (?, ?, ?, ?) "
            "ON CONFLICT(node_id) DO UPDATE SET up = up + excluded.up, "
            "down = down + excluded.down, updated_at = excluded.updated_at",
            (node_id, up, down, time.time()))


def add_traffic_sample(node_id, up: int, down: int):
    """采样一次：同一事务里累加「该节点行 + 总行 + 今日行」。

    节点 / 总行是累计值（重启不丢），今日行按本地日期分桶，供侧栏「今日流量」。
    """
    node_id = str(node_id or "")
    up, down = int(up or 0), int(down or 0)
    if node_id and (up > 0 or down > 0):
        now = time.time()
        day = time.strftime("%Y-%m-%d")
        with store_tx() as conn:
            for nid in (node_id, "__total__"):
                conn.execute(
                    "INSERT INTO v2ray_traffic (node_id, up, down, updated_at) VALUES (?, ?, ?, ?) "
                    "ON CONFLICT(node_id) DO UPDATE SET up = up + excluded.up, "
                    "down = down + excluded.down, updated_at = excluded.updated_at",
                    (nid, up, down, now))
            conn.execute(
                "INSERT INTO v2ray_traffic_day (day, up, down, updated_at) VALUES (?, ?, ?, ?) "
                "ON CONFLICT(day) DO UPDATE SET up = up + excluded.up, "
                "down = down + excluded.down, updated_at = excluded.updated_at",
                (day, up, down, now))


def traffic_today(day: str = "") -> dict:
    """今日累计流量（本地日期）：{day, up, down}；表不可用时返回 0。"""
    day = day or time.strftime("%Y-%m-%d")
    out = {"day": day, "up": 0, "down": 0}
    try:
        conn = store_conn()
        try:
            row = conn.execute("SELECT up, down FROM v2ray_traffic_day WHERE day=?",
                               (day,)).fetchone()
        finally:
            conn.close()
    except Exception as e:                          # noqa: BLE001
        _log.warning("读取今日流量失败: %s", e)
        return out
    if row:
        out["up"] = int(row["up"] or 0)
        out["down"] = int(row["down"] or 0)
    return out


def traffic_rows() -> dict:
    """全部流量记录：{node_id: {up, down, updated_at}}；表不可用时返回空 dict。"""
    try:
        conn = store_conn()
        try:
            return {r["node_id"]: {"up": int(r["up"] or 0), "down": int(r["down"] or 0),
                                   "updated_at": float(r["updated_at"] or 0)}
                    for r in conn.execute("SELECT * FROM v2ray_traffic")}
        finally:
            conn.close()
    except Exception as e:                      # noqa: BLE001
        _log.warning("读取 V2Ray 流量统计失败: %s", e)
        return {}


def reset_traffic():
    """清零全部流量统计。"""
    with store_tx() as conn:
        conn.execute("DELETE FROM v2ray_traffic")


# ---------------------------------------------------------------------------
# 订阅
# ---------------------------------------------------------------------------

def _sub_dict(row) -> dict:
    if not row:
        return None
    d = {k: row[k] for k in row.keys()}
    d["enabled"] = bool(d.get("enabled", 1))
    return d


def list_subs() -> list:
    conn = store_conn()
    try:
        rows = conn.execute("SELECT * FROM v2ray_subs ORDER BY created_at ASC").fetchall()
    finally:
        conn.close()
    return [_sub_dict(r) for r in rows]


def get_sub(sid) -> dict:
    conn = store_conn()
    try:
        rows = conn.execute("SELECT * FROM v2ray_subs WHERE id=?", (str(sid or ""),)).fetchall()
    finally:
        conn.close()
    return _sub_dict(rows[0]) if rows else None


def save_sub(sid, name, url, proxy="", enabled=True) -> dict:
    now = time.time()
    sid = str(sid or "").strip() or uuid.uuid4().hex[:12]
    if get_sub(sid):
        with store_tx() as conn:
            conn.execute(
                "UPDATE v2ray_subs SET name=?, url=?, proxy=?, enabled=?, updated_at=? WHERE id=?",
                (name, url, proxy, 1 if enabled else 0, now, sid))
    else:
        with store_tx() as conn:
            conn.execute(
                "INSERT INTO v2ray_subs (id, name, url, proxy, enabled, node_count, last_error,"
                " created_at, updated_at) VALUES (?,?,?,?,?,0,'',?,?)",
                (sid, name, url, proxy, 1 if enabled else 0, now, now))
    return get_sub(sid)


def delete_sub(sid):
    """删除订阅及其下所有节点。"""
    with store_tx() as conn:
        conn.execute("DELETE FROM v2ray_subs WHERE id=?", (str(sid),))
        conn.execute("DELETE FROM v2ray_nodes WHERE sub_id=?", (str(sid),))


def set_sub_result(sid, node_count=None, error=""):
    sets, args = ["updated_at=?", "last_error=?"], [time.time(), str(error or "")]
    if node_count is not None:
        sets.append("node_count=?")
        args.append(int(node_count))
    args.append(str(sid))
    with store_tx() as conn:
        conn.execute("UPDATE v2ray_subs SET " + ", ".join(sets) + " WHERE id=?", tuple(args))


# ---------------------------------------------------------------------------
# 节点
# ---------------------------------------------------------------------------

def _node_dict(row) -> dict:
    if not row:
        return None
    d = {k: row[k] for k in row.keys()}
    try:
        extra = json.loads(d.pop("node_json", "") or "{}")
    except (TypeError, ValueError):
        extra = {}
    if isinstance(extra, dict):
        # node_json 是解析当时的原始参数；name / remark 之后可能被用户改过，
        # 因此用「行里的列值」覆盖 json 里的同名字段，否则改名后读回来还是旧名字。
        merged = dict(extra)
        merged.update(d)
        d = merged
    return d


def list_nodes(sub_id=None) -> list:
    conn = store_conn()
    try:
        if sub_id is None:
            rows = conn.execute("SELECT * FROM v2ray_nodes ORDER BY sort ASC, created_at ASC").fetchall()
        else:
            rows = conn.execute("SELECT * FROM v2ray_nodes WHERE sub_id=? ORDER BY sort ASC,"
                                " created_at ASC", (str(sub_id),)).fetchall()
    finally:
        conn.close()
    return [_node_dict(r) for r in rows]


def get_node(nid) -> dict:
    conn = store_conn()
    try:
        rows = conn.execute("SELECT * FROM v2ray_nodes WHERE id=?", (str(nid or ""),)).fetchall()
    finally:
        conn.close()
    return _node_dict(rows[0]) if rows else None


def clear_sub_nodes(sub_id):
    with store_tx() as conn:
        conn.execute("DELETE FROM v2ray_nodes WHERE sub_id=?", (str(sub_id),))


def add_nodes(nodes: list, sub_id="", start_sort=0) -> int:
    """批量写入节点，返回写入条数。nodes 为 parse_share_link 得到的 dict 列表。"""
    now = time.time()
    n = 0
    with store_tx() as conn:
        for i, nd in enumerate(nodes or []):
            conn.execute(
                "INSERT INTO v2ray_nodes (id, sub_id, name, proto, server, port, raw, node_json,"
                " remark, sort, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (uuid.uuid4().hex[:12], str(sub_id or ""), nd.get("name") or "", nd.get("proto") or "",
                 nd.get("server") or "", int(nd.get("port") or 0), nd.get("raw") or "",
                 json.dumps(nd, ensure_ascii=False), nd.get("remark") or "",
                 int(start_sort) + i, now))
            n += 1
    return n


# 允许通过 update_node(fields=...) 直接修改的连接参数（存进 node_json，连接时生效）
_NODE_JSON_FIELDS = ("uuid", "aid", "scy", "flow", "method", "password",
                     "net", "header", "path", "host", "sni", "tls",
                     "fp", "pbk", "sid", "spx", "insecure")


def update_node(nid, name=None, remark=None, server=None, port=None, fields=None, grp=None):
    """更新节点：name/remark/grp/server/port 是行内列；fields 是连接参数（并入 node_json）。"""
    sets, args = [], []
    if name is not None:
        sets.append("name=?")
        args.append(str(name))
    if remark is not None:
        sets.append("remark=?")
        args.append(str(remark))
    if grp is not None:
        sets.append("grp=?")
        args.append(str(grp).strip())
    if server is not None:
        sets.append("server=?")
        args.append(str(server).strip())
    if port is not None:
        try:
            port = int(str(port).strip())
        except (TypeError, ValueError):
            port = 0
        sets.append("port=?")
        args.append(port)
    if fields:
        with store_tx() as conn:
            row = conn.execute("SELECT node_json FROM v2ray_nodes WHERE id=?",
                               (str(nid),)).fetchone()
        try:
            cur = json.loads((row["node_json"] if row else "") or "{}")
        except (TypeError, ValueError):
            cur = {}
        if not isinstance(cur, dict):
            cur = {}
        for k in _NODE_JSON_FIELDS:
            if k in fields and fields[k] is not None:
                cur[k] = fields[k]
        sets.append("node_json=?")
        args.append(json.dumps(cur, ensure_ascii=False))
    if sets:
        args.append(str(nid))
        with store_tx() as conn:
            conn.execute("UPDATE v2ray_nodes SET " + ", ".join(sets) + " WHERE id=?", tuple(args))
    return get_node(nid)


def delete_nodes(ids):
    ids = [str(x) for x in (ids or []) if x]
    if not ids:
        return 0
    with store_tx() as conn:
        cur = conn.execute("DELETE FROM v2ray_nodes WHERE id IN (%s)"
                           % ",".join("?" * len(ids)), tuple(ids))
        return cur.rowcount or 0


init_db()

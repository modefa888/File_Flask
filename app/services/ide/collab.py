"""实时协作编辑：房间 / 邀请管理 + 基于操作转换（OT）的合并引擎。

设计要点
========
- 每个房间（room）对应一个被多人共同编辑的文件，由「房主」首次发起时创建。
- 服务端是文本的唯一权威（canonical text）。所有客户端把本地 CodeMirror 的
  change 作为「操作」上报，服务端用 OT 把操作相对其本地 base 版本折算到
  *当前* 服务端文本的绝对坐标，再广播这个绝对坐标的操作给所有其他人。
- 因为所有客户端都按相同顺序、相同坐标应用同一批广播操作，且各自文本在服务端
  广播那一刻与服务端一致，所以必然收敛、不会分叉——这正是 OT 的关键保证。
- 客户端收到自己发出的操作回显时只更新本地版本号、不重复应用，避免双重写入。

操作统一表示为单段替换：{"from": 起始字符偏移, "to": 结束字符偏移, "text": 新文本}。
"""

import json
import os
import secrets
import threading
import time
from bisect import bisect_left

from ...log import get_logger
from ...services.common import store_db
from ...services.common.store_db import store_conn, store_tx, migrate_json_once, get_meta

_log = get_logger()

# token -> Room；全局唯一，进程内存活（重启后房间需重建，邀请链接即失效）
_rooms = {}
_rooms_lock = threading.Lock()

# 房间持久化：服务重启 / 页面刷新后房间与已同步内容不丢
_DATA_FILE = os.path.abspath(os.path.join(
    os.path.dirname(__file__), "..", "..", "..", "data", "collab_rooms.json"))
_MAX_PERSIST_TEXT = 2 * 1024 * 1024   # 超大文件不落盘（房间仍可用，但重启后需重建）

# 本模块专属表：协作房间 / 共享前快照（建表 DDL 放本模块，而非 store_db 的 _SCHEMA，跟随模块演进）
_SCHEMA = """
CREATE TABLE IF NOT EXISTS collab_rooms (
    token TEXT PRIMARY KEY,
    data  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS collab_preshare (
    path TEXT PRIMARY KEY,
    data TEXT NOT NULL
);
"""

def init_db():
    """幂等建表；失败只告警，不阻断启动。"""
    try:
        with store_tx() as conn:
            conn.executescript(_SCHEMA)
    except Exception as e:                      # noqa: BLE001
        _log.warning("协作表初始化失败: %s", e)

_save_lock = threading.Lock()
_save_timer = None


def _pack_authors(seq):
    """归属序列压缩成 [[sid, 连续长度], ...]，避免落盘体积过大（逐字符存储会很大）。"""
    out = []
    for sid in seq:
        if out and out[-1][0] == sid:
            out[-1][1] += 1
        else:
            out.append([sid, 1])
    return out


def _unpack_authors(packed, n):
    seq = []
    for item in packed or []:
        try:
            sid, cnt = item[0], int(item[1])
        except (TypeError, ValueError, IndexError):
            continue
        if cnt > 0:
            seq.extend([sid] * cnt)
    if len(seq) != n:
        seq = (seq + [None] * n)[:n]
    return seq


# 「共享前版本」快照：按文件路径记录「发起共享那一刻」的内容。
# 保存一个正在/曾经被共享的文件时，据此在文件旁留一份备份——房间被停止、
# 甚至服务重启后依然能拿到，避免协作成果覆盖掉原始版本。
_PRESHARE_FILE = os.path.abspath(os.path.join(
    os.path.dirname(__file__), "..", "..", "..", "data", "collab_preshare.json"))
# 保存共享文件时，「共享前版本」备份到 data/collab_backups/ 下
COLLAB_BACKUP_DIR = os.path.abspath(os.path.join(
    os.path.dirname(__file__), "..", "..", "..", "data", "collab_backups"))
_preshare = {}
_preshare_lock = threading.Lock()


# 最多保留多少份「共享前版本」快照；超出时删最旧（created 最小）的，避免无限增长
_PRESHARE_MAX = 2000


def _import_collab_preshare(conn, data):
    if isinstance(data, dict):
        for path, snap in data.items():
            if isinstance(snap, dict):
                conn.execute("INSERT OR REPLACE INTO collab_preshare (path, data) VALUES (?, ?)",
                             (path, json.dumps(snap, ensure_ascii=False)))


def _load_preshare():
    """从 store.db 恢复内存中的共享前快照（启动时调用）。"""
    try:
        conn = store_conn()
        try:
            rows = conn.execute("SELECT path, data FROM collab_preshare").fetchall()
        finally:
            conn.close()
    except Exception:
        return
    with _preshare_lock:
        for r in rows:
            try:
                _preshare[r["path"]] = json.loads(r["data"])
            except Exception:
                pass


def record_preshare(path, text, token=None, created=None):
    """记录某路径的「共享前版本」快照；同一路径再次发起共享时覆盖为最新一次。

    落 store.db 的 collab_preshare 表（按文件绝对路径为主键）；超出上限时删最旧的快照。
    """
    if not path or text is None or len(text) > _MAX_PERSIST_TEXT:
        return
    abp = os.path.abspath(path)
    created = int(created or time.time())
    blob = json.dumps({"text": text, "created": created, "token": token}, ensure_ascii=False)
    with _preshare_lock:
        _preshare[abp] = {"text": text, "created": created, "token": token}
    try:
        with store_tx() as conn:
            conn.execute("INSERT OR REPLACE INTO collab_preshare (path, data) VALUES (?, ?)",
                         (abp, blob))
            n = conn.execute("SELECT COUNT(*) FROM collab_preshare").fetchone()[0]
            if n > _PRESHARE_MAX:
                excess = n - _PRESHARE_MAX
                old = conn.execute(
                    "SELECT path FROM collab_preshare "
                    "ORDER BY CAST(json_extract(data, '$.created') AS INTEGER) ASC LIMIT ?",
                    (excess,)).fetchall()
                old_paths = [r["path"] for r in old]
                for p in old_paths:
                    conn.execute("DELETE FROM collab_preshare WHERE path=?", (p,))
                with _preshare_lock:
                    for p in old_paths:
                        _preshare.pop(p, None)
    except Exception:
        pass


def preshare_for(path):
    """取某路径的「共享前版本」快照，没有则返回 None。"""
    with _preshare_lock:
        return _preshare.get(os.path.abspath(path))


def _persist():
    """把全部房间写入 store.db（collab_rooms 表；超大文件按 _MAX_PERSIST_TEXT 跳过）。"""
    try:
        rows = []
        for r in _rooms.values():
            if len(r.text) > _MAX_PERSIST_TEXT:
                continue
            rows.append((r.token, json.dumps({
                "token": r.token, "path": r.path, "name": r.name,
                "created": r.created, "version": r.version,
                "host_key": r.host_key, "group": r.group,
                "max_peers": r.max_peers, "allowed_users": r.allowed_users,
                "expires_at": r.expires_at, "view": r.view,
                "text": r.text, "baseline": r.baseline, "log": r.log,
                "char_authors": _pack_authors(r.char_authors),
                "author_info": r.author_info,
            }, ensure_ascii=False)))
        with store_tx() as conn:
            conn.execute("DELETE FROM collab_rooms")
            conn.executemany(
                "INSERT OR REPLACE INTO collab_rooms (token, data) VALUES (?, ?)", rows)
    except Exception:
        pass


def _persist_soon():
    """操作高频时的防抖落盘：1 秒内的多次改动合并为一次写盘。"""
    global _save_timer
    with _save_lock:
        if _save_timer is None:
            _save_timer = threading.Timer(1.0, _flush_save)
            _save_timer.daemon = True
            _save_timer.start()


def _flush_save():
    global _save_timer
    _persist()
    with _save_lock:
        _save_timer = None


def _load():
    """从 store.db（collab_rooms 表）恢复上次未关闭的房间。"""
    try:
        conn = store_conn()
        try:
            rows = conn.execute("SELECT data FROM collab_rooms").fetchall()
        finally:
            conn.close()
    except Exception:
        return
    for raw in rows:
        try:
            d = json.loads(raw["data"])
        except Exception:
            continue
        if not isinstance(d, dict) or not d.get("token"):
            continue
        try:
            r = Room(d["token"], d["path"], d.get("name") or os.path.basename(d["path"]))
            r.version = int(d.get("version", 0))
            r.text = d.get("text", "")
            # 老房间（本功能上线前创建）没有 baseline 字段：置 None，由接口告知前端「无基线」
            r.baseline = d.get("baseline")
            r.log = list(d.get("log", []))
            r.char_authors = _unpack_authors(d.get("char_authors"), len(r.text))
            ai = d.get("author_info")
            r.author_info = dict(ai) if isinstance(ai, dict) else {}
            r.created = int(d.get("created", time.time()))
            r.host_key = d.get("host_key")
            r.group = d.get("group")
            r.max_peers = d.get("max_peers")
            au = d.get("allowed_users")
            r.allowed_users = [str(u) for u in au if str(u).strip()] if isinstance(au, list) and au else None
            r.expires_at = d.get("expires_at")
            # 老数据没有 view 字段：按文件现况补算（新房间持久化里有）
            r.view = bool(d.get("view")) or is_view_only(r.path)
            _rooms[r.token] = r
        except Exception:
            continue
    # 恢复出来的房间也补记「共享前版本」快照（老数据里可能没有）
    for r in list(_rooms.values()):
        record_preshare(r.path, r.baseline, r.token, r.created)


_PALETTE = (
    "#e06c75", "#61afef", "#98c379", "#e5c07b", "#c678dd",
    "#56b6c2", "#d19a66", "#ff79c6", "#7ee787", "#f78c6c",
)


def _read_file_text(path):
    """读取文件内容作为房间初始文本；读不到返回空串。"""
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            return f.read()
    except OSError:
        return ""


# 只能「共享查看」、不能共同编辑的文件类型：图片 / PDF / 音视频 /
# 压缩包 / 二进制产物（字体、可执行、数据库等）。它们照样能出现在
# 批量分享里给其他用户打开查看或下载，但不进 OT 编辑房间。
_VIEW_EXTS = {
    ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".svg", ".ico", ".avif",
    ".pdf",
    ".mp4", ".webm", ".mov", ".mkv", ".mp3", ".wav", ".ogg", ".flac",
    ".zip", ".rar", ".7z", ".tar", ".gz", ".bz2", ".xz",
    ".exe", ".dll", ".so", ".dylib", ".bin", ".iso", ".apk", ".jar",
    ".woff", ".woff2", ".ttf", ".otf", ".eot",
    ".db", ".sqlite", ".pyc", ".o", ".a", ".wasm",
}


def is_view_only(path):
    """判断某文件是否为「仅查看」：按扩展名识别，可疑时再嗅探二进制字节。"""
    ext = os.path.splitext(path or "")[1].lower()
    if ext in _VIEW_EXTS:
        return True
    try:
        with open(path, "rb") as f:
            return b"\x00" in f.read(1024)     # 含 NUL 字节基本可断定是二进制
    except OSError:
        return False


class Room:
    def __init__(self, token, path, name):
        self.token = token
        self.path = path                      # 被协作编辑的文件绝对路径
        self.name = name
        self.view = is_view_only(path)        # 仅查看（二进制等）：不参与共同编辑
        self.created = int(time.time())
        # 仅查看的文件不做文本种子：二进制按 UTF-8 解出来是乱码，没有编辑意义
        self.text = "" if self.view else _read_file_text(path)
        self.baseline = self.text             # 「分享前」的基线内容，用于版本对比
        self.char_authors = [None] * len(self.text)   # 逐字符归属：这个字最后是谁写的
        self.author_info = {}                 # sid -> {"name","color"}：归属展示用
        self.version = 0                      # 已应用的广播操作数
        self.log = []                        # 顺序操作日志，index == version-1
        self.peers = {}                      # sid -> {"id","name","color","ws"}
        self.host_sid = None                 # 房主（邀请人）的 WS 连接 sid
        self.host_key = None                 # 房主认领密钥：只有创建者持有，访客无法冒充
        self.group = None                    # 所属「分享组」id：一次勾选多个文件共享时共用
        self.max_peers = None                # 人数上限（None=不限）：含房主在内的并发连接数
        self.allowed_users = None            # 指定用户名单（None/空=不限）：按昵称（登录用户名）匹配
        self.expires_at = None               # 有效期截止时间戳（None=永久）
        self.close_timer = None              # 房主断线宽限期的待关闭定时器（None=无）
        self.lock = threading.Lock()

    def peers_list(self, skip_sid=None):
        return [
            {"id": p["id"], "name": p["name"], "color": p["color"],
             "host": p["id"] == self.host_sid,
             "viewer": bool(p.get("viewer"))}   # 仅查看成员（二进制等文件的观看者）
            for p in self.peers.values()
            if p["id"] != skip_sid
        ]


def _import_collab_rooms(conn, data):
    """旧版 collab_rooms.json 一次性迁入 store.db。"""
    if isinstance(data, list):
        for d in data:
            if isinstance(d, dict) and d.get("token"):
                conn.execute("INSERT OR REPLACE INTO collab_rooms (token, data) VALUES (?, ?)",
                             (d["token"], json.dumps(d, ensure_ascii=False)))


# 旧版 JSON 一次性迁入 store.db（仅首次执行；成功后删除旧文件，避免与库双份）
init_db()
migrate_json_once("json_migrated:collab_rooms", _DATA_FILE, _import_collab_rooms)
migrate_json_once("json_migrated:collab_preshare", _PRESHARE_FILE, _import_collab_preshare)
for _marker, _jf in (("json_migrated:collab_rooms", _DATA_FILE),
                     ("json_migrated:collab_preshare", _PRESHARE_FILE)):
    if get_meta(_marker) and os.path.isfile(_jf):
        try:
            os.remove(_jf)
        except OSError:
            pass

_load_preshare()   # 从库恢复内存中的共享前快照
_load()            # 从库恢复上次未关闭的房间（Room 类已定义）


def create_room(path, name=None, group=None, max_peers=None, allowed_users=None, expires_in=None):
    """为某文件创建协作房间（已存在则复用 token）。

    返回 (room, token)。room.host_key 是房主认领密钥：仅下发给创建者，
    WS 连接凭它认领房主身份——访客抢先是拿不到房主身份的。
    group：批量分享组 id（一次勾选多个文件/文件夹一起共享时共用）。
    max_peers：人数上限（含房主）；allowed_users：指定用户名单（按昵称匹配）；
    expires_in：有效秒数，超时后房间自动失效。
    """
    path = os.path.abspath(path)
    group = (group or "").strip() or None

    def _apply_limits(r):
        # 复用已有房间时也按本次输入刷新限制（房主调整上限/有效期是合理操作）
        try:
            mp = int(max_peers) if max_peers not in (None, "", 0) else None
        except (TypeError, ValueError):
            mp = None
        r.max_peers = max(1, mp) if mp else None
        if allowed_users is None:
            pass                      # 未传：保持原名单不变
        elif isinstance(allowed_users, str):
            r.allowed_users = [u.strip() for u in allowed_users.replace("，", ",").split(",") if u.strip()] or None
        elif isinstance(allowed_users, list):
            r.allowed_users = [str(u).strip() for u in allowed_users if str(u).strip()] or None
        try:
            ttl = int(expires_in) if expires_in else 0
        except (TypeError, ValueError):
            ttl = 0
        if ttl > 0:
            r.expires_at = int(time.time()) + ttl

    with _rooms_lock:
        for r in _rooms.values():
            if r.path == path:
                if group and not r.group:
                    r.group = group        # 老房间并入这次的分享组
                r.view = is_view_only(path)  # 复用房间也按文件现况刷新「仅查看」
                _apply_limits(r)
                _persist_soon()
                return r, r.token
        token = secrets.token_urlsafe(16)
        room = Room(token, path, name or os.path.basename(path))
        room.host_key = secrets.token_urlsafe(16)
        room.group = group
        _apply_limits(room)
        _rooms[token] = room
        # 记下这次共享前的版本：保存该文件时据此在文件旁留一份备份
        record_preshare(room.path, room.baseline, token, room.created)
        _persist_soon()
        return room, token


def list_group(gid):
    """某次批量分享（组）里的全部房间，按创建时间排序。"""
    gid = (gid or "").strip()
    if not gid:
        return []
    with _rooms_lock:
        rooms = [r for r in _rooms.values() if r.group == gid]
    rooms.sort(key=lambda r: r.created)
    return [
        {"token": r.token, "name": r.name, "path": r.path,
         "peers": len(r.peers), "version": r.version, "created": r.created,
         "view": r.view}
        for r in rooms
    ]


def get_room(token):
    """取房间；已过有效期的房间顺带清除（惰性过期，不依赖定时器）。"""
    r = _rooms.get(token)
    if r and r.expires_at and time.time() > r.expires_at:
        delete_room(token)
        return None
    return r


def list_rooms():
    expired = []
    with _rooms_lock:
        now = time.time()
        out = []
        for r in _rooms.values():
            if r.expires_at and now > r.expires_at:
                expired.append(r.token)      # 延后到锁外清除（锁不可重入）
                continue
            out.append({
                "token": r.token,
                "name": r.name,
                "path": r.path,
                "peers": len(r.peers),
                "version": r.version,
                "created": r.created,
                "group": r.group,     # 批量分享组 id：受邀者/弹窗按组分卡片显示
                "max_peers": r.max_peers,
                "allowed_users": r.allowed_users or [],
                "expires_at": r.expires_at,
                "view": r.view,       # 仅查看（二进制等）：不参与共同编辑
            })
    for t in expired:
        delete_room(t)
    return out


def delete_room(token):
    with _rooms_lock:
        room = _rooms.pop(token, None)
    if room is None:
        return False
    # 取消可能存在的「房主断线待关闭」定时器，避免其后再触发一次关闭
    t = getattr(room, "close_timer", None)
    if t is not None:
        try:
            t.cancel()
        except Exception:
            pass
        room.close_timer = None
    # 房间关闭后仍保留「共享前版本」快照：之后保存该文件依然会留备份
    record_preshare(room.path, room.baseline, room.token, room.created)
    _persist()
    return True


def pick_color():
    return _PALETTE[secrets.randbelow(len(_PALETTE))]


def color_for(name):
    """按昵称确定配色：同名永远同色。

    昵称固定成登录用户名后，颜色若仍每次随机，「谁改的」记录会随每次刷新
    看着变来变去；这里让颜色只由昵称决定，刷新 / 换页面都保持一致。
    """
    s = (name or "").strip()
    if not s:
        return pick_color()
    h = 0
    for ch in s:
        h = (h * 31 + ord(ch)) % 1000000007
    return _PALETTE[h % len(_PALETTE)]


def _transform(inc, other):
    """把操作 inc 折算到 other 已应用之后的坐标系（inc 在 other 之前生成）。

    两者均为单段替换 {"from","to","text"}。返回折算后的 inc。
    这是面向单文档的 OT 位置变换：覆盖插入/删除/重叠的常见情况即可收敛。
    """
    of, ot, otext = other["from"], other["to"], other["text"]
    ofs = ot - of                 # other 删除的长度
    oins = len(otext)             # other 插入的长度
    delta = oins - ofs

    f, t, txt = inc["from"], inc["to"], inc["text"]

    if f <= of:
        # inc 起始在 other 之前或相同
        if t <= of:
            return inc                              # 完全在 other 之前，不平移
        # 与 other 区间左重叠：删除范围延展覆盖 other 的整个替换区域。
        # 终点必须 + delta：new 坐标里 other 的替换段长度已变，
        # 否则删除会"删少了"，别人的插入文本或后续内容残留在文档里。
        return {"from": f, "to": max(t, ot) + delta, "text": txt}
    else:
        # f > of
        if f >= ot:
            return {"from": f + delta, "to": t + delta, "text": txt}   # 完全在 other 之后，整体平移
        # f 落在 (of, ot) 内：other 的删除吞掉了 f，插入点挪到 other 之后
        return {"from": of + oins, "to": max(t, ot) + delta, "text": txt}


def apply_op(room, base, ops, author=None, author_name=None, author_color=None):
    """在服务端文本上依次应用一批操作，返回广播用的绝对操作列表（含新版本号）。

    base 是客户端上报的本地版本号；batch 内多个操作相对「前一个操作之后」生成，
    只对 room.log[base:] 中**他人**的操作做 OT 折算后再写入。

    关键：发送方自己的历史操作（含同一批内先应用的那些）在本地早已生效，
    若再折算会双重平移——这正是「快速连打时字符错位、回显校验失败触发
    resync、光标跳回 1:1」的根因（游标分支一直有 skip-self，操作分支漏了）。
    author 记入日志：供操作/光标变换跳过本人操作；id 原样回显，供发送方精确出队。
    """
    out = []
    with room.lock:
        if author:
            room.author_info[author] = {
                "name": author_name or "协作者",
                "color": author_color or "#6cb6ff",
            }
        for op in ops:
            f, t = int(op["from"]), int(op["to"])
            txt = op.get("text", "")
            for past in room.log[base:]:
                if past.get("by") == author:
                    continue        # 自己的操作本地已生效，跳过，避免双重平移
                shifted = _transform({"from": f, "to": t, "text": txt}, past)
                f, t, txt = shifted["from"], shifted["to"], shifted["text"]
            # 字符级归属：被替换的那段字符归当前作者。与文本用同一切片，
            # 天然逐字符对齐，且不必每个 op 扫全文（行级归属由 /authors 推导）
            ca = room.char_authors
            if 0 <= f <= t <= len(ca):
                ca[f:t] = [author] * len(txt)
            room.text = room.text[:f] + txt + room.text[t:]
            room.version += 1
            room.log.append({"from": f, "to": t, "text": txt, "by": author, "id": op.get("id")})
            out.append({"from": f, "to": t, "text": txt, "version": room.version, "id": op.get("id")})
    _persist_soon()
    return out


def author_runs(room):
    """由字符级归属推出「改动归属」，供前端重绘：
      - chars: [[起, 止(不含), sid, 名字, 颜色], ...]  —— 只有这些字符加粗 + 作者色
      - lines: [[起行, 止行, sid, 名字, 颜色], ...]    —— 行背景高亮与作者标签
    仅在刷新 / 重新载入时调用一次，O(文本长度)。
    """
    ca = room.char_authors
    text = room.text
    info = room.author_info or {}
    n = len(ca)
    nl = [i for i in range(min(n, len(text))) if text[i] == "\n"]
    line_owner = [None] * (text.count("\n") + 1)
    chars = []
    i = 0
    while i < n:
        sid = ca[i]
        if not sid:
            i += 1
            continue
        j = i
        while j + 1 < n and ca[j + 1] == sid:
            j += 1
        chars.append([i, j + 1, sid])
        last = bisect_left(nl, j)                     # 区间末字符所在行
        for L in range(bisect_left(nl, i), min(last, len(line_owner) - 1) + 1):
            line_owner[L] = sid
        i = j + 1
    lines = []
    cur = None
    for idx, sid in enumerate(line_owner):
        if not sid:
            if cur:
                lines.append(cur)
                cur = None
            continue
        if cur and cur[2] == sid:
            cur[1] = idx
        else:
            if cur:
                lines.append(cur)
            cur = [idx, idx, sid]
    if cur:
        lines.append(cur)

    def meta(sid):
        m = info.get(sid) or {}
        return [m.get("name") or "协作者", m.get("color") or "#6cb6ff"]

    return [c + meta(c[2]) for c in chars], [l + meta(l[2]) for l in lines]

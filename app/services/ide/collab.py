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

_log = get_logger()

# token -> Room；全局唯一，进程内存活（重启后房间需重建，邀请链接即失效）
_rooms = {}
_rooms_lock = threading.Lock()

# 房间持久化：服务重启 / 页面刷新后房间与已同步内容不丢
_DATA_FILE = os.path.abspath(os.path.join(
    os.path.dirname(__file__), "..", "..", "..", "data", "collab_rooms.json"))
_MAX_PERSIST_TEXT = 2 * 1024 * 1024   # 超大文件不落盘（房间仍可用，但重启后需重建）

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


def _load_preshare():
    try:
        with open(_PRESHARE_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            _preshare.update(data)
    except (OSError, ValueError):
        pass


def _save_preshare():
    try:
        os.makedirs(os.path.dirname(_PRESHARE_FILE), exist_ok=True)
        tmp = _PRESHARE_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(_preshare, f, ensure_ascii=False)
        os.replace(tmp, _PRESHARE_FILE)
    except OSError:
        pass


def record_preshare(path, text, token=None, created=None):
    """记录某路径的「共享前版本」快照；同一路径再次发起共享时覆盖为最新一次。"""
    if not path or text is None or len(text) > _MAX_PERSIST_TEXT:
        return
    with _preshare_lock:
        _preshare[os.path.abspath(path)] = {
            "text": text,
            "created": int(created or time.time()),
            "token": token,
        }
    _save_preshare()


def preshare_for(path):
    """取某路径的「共享前版本」快照，没有则返回 None。"""
    with _preshare_lock:
        return _preshare.get(os.path.abspath(path))


_load_preshare()


def _persist():
    """把全部房间写入磁盘（原子替换）。"""
    try:
        data = []
        for r in _rooms.values():
            if len(r.text) > _MAX_PERSIST_TEXT:
                continue
            data.append({
                "token": r.token, "path": r.path, "name": r.name,
                "created": r.created, "version": r.version,
                "host_key": r.host_key,
                "text": r.text, "baseline": r.baseline, "log": r.log,
                "char_authors": _pack_authors(r.char_authors),
                "author_info": r.author_info,
            })
        os.makedirs(os.path.dirname(_DATA_FILE), exist_ok=True)
        tmp = _DATA_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
        os.replace(tmp, _DATA_FILE)
    except OSError:
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
    try:
        with open(_DATA_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return
    for d in data or []:
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


class Room:
    def __init__(self, token, path, name):
        self.token = token
        self.path = path                      # 被协作编辑的文件绝对路径
        self.name = name
        self.created = int(time.time())
        self.text = _read_file_text(path)     # 服务端权威文本（从磁盘种子）
        self.baseline = self.text             # 「分享前」的基线内容，用于版本对比
        self.char_authors = [None] * len(self.text)   # 逐字符归属：这个字最后是谁写的
        self.author_info = {}                 # sid -> {"name","color"}：归属展示用
        self.version = 0                      # 已应用的广播操作数
        self.log = []                        # 顺序操作日志，index == version-1
        self.peers = {}                      # sid -> {"id","name","color","ws"}
        self.host_sid = None                 # 房主（邀请人）的 WS 连接 sid
        self.host_key = None                 # 房主认领密钥：只有创建者持有，访客无法冒充
        self.close_timer = None              # 房主断线宽限期的待关闭定时器（None=无）
        self.lock = threading.Lock()

    def peers_list(self, skip_sid=None):
        return [
            {"id": p["id"], "name": p["name"], "color": p["color"],
             "host": p["id"] == self.host_sid}
            for p in self.peers.values()
            if p["id"] != skip_sid
        ]


_load()   # 启动时恢复上次未关闭的房间（Room 类已定义）


def create_room(path, name=None):
    """为某文件创建协作房间（已存在则复用 token）。

    返回 (room, token)。room.host_key 是房主认领密钥：仅下发给创建者，
    WS 连接凭它认领房主身份——访客抢先是拿不到房主身份的。
    """
    path = os.path.abspath(path)
    with _rooms_lock:
        for r in _rooms.values():
            if r.path == path:
                return r, r.token
        token = secrets.token_urlsafe(16)
        room = Room(token, path, name or os.path.basename(path))
        room.host_key = secrets.token_urlsafe(16)
        _rooms[token] = room
        # 记下这次共享前的版本：保存该文件时据此在文件旁留一份备份
        record_preshare(room.path, room.baseline, token, room.created)
        _persist_soon()
        return room, token


def get_room(token):
    return _rooms.get(token)


def list_rooms():
    with _rooms_lock:
        return [
            {
                "token": r.token,
                "name": r.name,
                "path": r.path,
                "peers": len(r.peers),
                "version": r.version,
                "created": r.created,
            }
            for r in _rooms.values()
        ]


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

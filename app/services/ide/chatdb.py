"""AI 对话历史持久化：SQLite 存储层。

对话（conversations）按 user_id 隔离，每条对话下挂多条消息（messages）。
消息中图片以 dataURL 形式完整保存（images 字段存 JSON 数组），保证多端回放一致。

表（ai_conversations / ai_messages / ai_prefs）已并入统一存储库 data/storage/store.db，
建表由 store_db 的 _SCHEMA 幂等完成；旧独立库 .file_manager_ai_chat.db 由
store_db.migrate_sqlite_once() 在首次启动时一次性搬入。
"""
import json
import time

from ..common.store_db import store_conn

# 单条消息图片 dataURL 上限（与 ai.py 的 _MAX_IMAGE_DATAURL 对齐）
_MAX_IMAGE_DATAURL = 9_000_000
_MAX_IMAGE_PARTS = 8


def _conn():
    """连接统一存储库（表结构见 store_db._SCHEMA）"""
    return store_conn()


def init_chat_db():
    """表已随 store_db 建好，保留此函数只为兼容启动时的调用。"""
    return


def _clean_images(images):
    """清洗图片数组：仅保留合法的 data:image/ dataURL，限制数量与大小。"""
    if not isinstance(images, list):
        return []
    out = []
    for u in images[:_MAX_IMAGE_PARTS]:
        if isinstance(u, str) and u.startswith("data:image/") and len(u) <= _MAX_IMAGE_DATAURL:
            out.append(u)
    return out


def _clean_meta(meta):
    if not isinstance(meta, dict):
        return {}
    # 只保留需要的字段
    clean = {}
    for k in ("ms", "ts", "steps", "files", "changes", "undone", "err", "todos"):
        if k in meta and meta[k] is not None:
            clean[k] = meta[k]
    return clean


def _norm_root(root):
    """项目根目录规范化：去空白与尾部斜杠（IDE 的 ROOT 已去尾斜杠，这里再兜一次）。

    空串 = 还没绑定项目（旧数据 / 没打开文件夹），见 adopt_unassigned()。
    """
    r = str(root or "").strip()
    return r.rstrip("/") if len(r) > 1 else r


def list_conversations(user_id, root=""):
    """返回【该项目】的会话列表（不含消息），按「最后一条消息的时间」倒序。

    时间口径说明：列表显示 / 排序都用【最后一条消息的入库时间】，而不是
    ai_conversations.updated_at —— 后者在切换会话、回撤改动、仅改 extra 等
    非发消息场景也会被刷新，导致「打开会话时间就变了」。没有消息的会话
    才回退到 updated_at。
    """
    conn = _conn()
    try:
        rows = conn.execute(
            "SELECT c.id, c.title, c.created_at, "
            "COALESCE((SELECT MAX(m.created_at) FROM ai_messages m "
            "          WHERE m.conv_id=c.id AND m.user_id=c.user_id), c.updated_at) AS last_at, "
            "c.extra, "
            "(SELECT COUNT(*) FROM ai_messages m WHERE m.conv_id=c.id) AS cnt "
            "FROM ai_conversations c WHERE c.user_id=? AND c.root=? ORDER BY last_at DESC",
            (user_id, _norm_root(root)),
        ).fetchall()
        return [{
            "id": r[0], "title": r[1], "created_at": r[2], "updated_at": r[3],
            "extra": json.loads(r[4]) if r[4] else {}, "msg_count": r[5],
        } for r in rows]
    finally:
        conn.close()


def adopt_unassigned(user_id, root):
    """把「还没绑定项目」的旧会话（root 为空）一次性划归当前项目，返回改动条数。

    背景：加 root 维度前所有会话的 root 都是空串。若不处理，用户升级后打开
    项目会看到空历史列表（旧对话全被过滤掉）。这里只在某个项目【第一次】
    进入时采纳一次（调用方用 localStorage 标记记住），之后新项目不再抢旧数据。
    """
    key = _norm_root(root)
    if not key:
        return 0
    conn = _conn()
    try:
        _prefs_ensure(conn)
        # 旧的「当前会话」也跟着归属到第一个采纳历史的项目，否则打开项目后
        # 历史列表有旧对话、当前会话却是空的（列表会退回最新一条，体验割裂）。
        legacy, roots = _prefs_row(conn, user_id)
        if legacy and key not in roots:
            roots[key] = legacy
            conn.execute(
                "UPDATE ai_prefs SET cur_roots=? WHERE user_id=?",
                (json.dumps(roots, ensure_ascii=False), user_id),
            )
        cur = conn.execute(
            "UPDATE ai_conversations SET root=? WHERE user_id=? AND (root IS NULL OR root='')",
            (key, user_id),
        )
        conn.commit()
        return cur.rowcount or 0
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def get_conversation(user_id, conv_id):
    """返回单条会话（含完整消息），不存在返回 None。"""
    conn = _conn()
    try:
        row = conn.execute(
            "SELECT id, title, created_at, updated_at, extra "
            "FROM ai_conversations WHERE id=? AND user_id=?",
            (conv_id, user_id),
        ).fetchone()
        if not row:
            return None
        mrows = conn.execute(
            "SELECT mid, role, text, images, reasoning, meta FROM ai_messages "
            "WHERE conv_id=? AND user_id=? ORDER BY seq ASC",
            (conv_id, user_id),
        ).fetchall()
        msgs = []
        for mr in mrows:
            mid, role, text, images, reasoning, meta = mr
            m = {"pid": mid, "role": role, "text": text or ""}
            try:
                imgs = json.loads(images) if images else []
                if imgs:
                    m["images"] = imgs
            except (ValueError, TypeError):
                pass
            if reasoning:
                m["reasoning"] = reasoning
            try:
                md = json.loads(meta) if meta else {}
                if md:
                    if md.get("files"):
                        m["files"] = md["files"]
                    if md.get("steps"):
                        m["steps"] = md["steps"]
                    if md.get("todos"):
                        m["todos"] = md["todos"]
                    if md.get("ms") is not None:
                        m["ms"] = md["ms"]
                    if md.get("ts") is not None:
                        m["ts"] = md["ts"]
                    if md.get("changes"):
                        m["changes"] = md["changes"]
                    if md.get("undone"):
                        m["undone"] = True
                    if md.get("err"):
                        m["err"] = True
            except (ValueError, TypeError):
                pass
            msgs.append(m)
        extra = json.loads(row[4]) if row[4] else {}
        return {
            "id": row[0], "title": row[1], "created_at": row[2],
            "updated_at": row[3], "msgs": msgs,
            "extra": extra,
        }
    finally:
        conn.close()


def upsert_conversation(user_id, conv_id, title, extra, msgs, deleted=None, root=""):
    """新建 / 更新会话：插入缺失的新消息，可选删除消息，更新标题与 extra。

    root 为会话所属项目根目录：新建时写入；已存在的会话若还没归属（空串）
    则顺手补上，避免旧会话一直游离在项目之外。
    返回 {id, saved_mids:[...], deleted:[...]}。
    """
    now = time.time()
    key = _norm_root(root)
    saved = []
    deleted_out = []
    conn = _conn()
    try:
        cur = conn.execute(
            "SELECT id FROM ai_conversations WHERE id=? AND user_id=?",
            (conv_id, user_id),
        ).fetchone()
        if cur:
            conn.execute(
                "UPDATE ai_conversations SET title=?, updated_at=?, extra=?, "
                "root=CASE WHEN root IS NULL OR root='' THEN ? ELSE root END "
                "WHERE id=? AND user_id=?",
                (title or "", now, json.dumps(extra or {}, ensure_ascii=False), key, conv_id, user_id),
            )
        else:
            conn.execute(
                "INSERT INTO ai_conversations(id, user_id, title, created_at, updated_at, extra, root) "
                "VALUES(?,?,?,?,?,?,?)",
                (conv_id, user_id, title or "", now, now,
                 json.dumps(extra or {}, ensure_ascii=False), key),
            )
        # 删除指定消息
        if deleted:
            placeholders = ",".join("?" * len(deleted))
            conn.execute(
                f"DELETE FROM ai_messages WHERE conv_id=? AND user_id=? AND mid IN ({placeholders})",
                (conv_id, user_id, *deleted),
            )
            deleted_out = list(deleted)
        # 插入新消息（已存在则更新内容与 meta，例如回撤后 undone 状态变化）
        for m in msgs:
            mid = str(m.get("mid") or "")
            if not mid:
                continue
            meta_json = json.dumps(_clean_meta(m.get("meta")), ensure_ascii=False)
            existing = conn.execute(
                "SELECT 1 FROM ai_messages WHERE conv_id=? AND mid=?",
                (conv_id, mid),
            ).fetchone()
            if existing:
                conn.execute(
                    "UPDATE ai_messages SET text=?, images=?, reasoning=?, meta=? "
                    "WHERE conv_id=? AND mid=?",
                    ((m.get("text") or "")[:200000],
                     json.dumps(_clean_images(m.get("images")), ensure_ascii=False),
                     (m.get("reasoning") or "")[:200000],
                     meta_json, conv_id, mid),
                )
                saved.append(mid)
                continue
            seq = conn.execute(
                "SELECT COALESCE(MAX(seq), -1) + 1 FROM ai_messages WHERE conv_id=?",
                (conv_id,),
            ).fetchone()[0]
            conn.execute(
                "INSERT INTO ai_messages(conv_id, mid, user_id, role, text, images, reasoning, meta, seq, created_at) "
                "VALUES(?,?,?,?,?,?,?,?,?,?)",
                (conv_id, mid, user_id, str(m.get("role") or "user"),
                 (m.get("text") or "")[:200000],
                 json.dumps(_clean_images(m.get("images")), ensure_ascii=False),
                 (m.get("reasoning") or "")[:200000],
                 json.dumps(_clean_meta(m.get("meta")), ensure_ascii=False),
                 seq, now),
            )
            saved.append(mid)
        conn.commit()
        return {"id": conv_id, "saved_mids": saved, "deleted": deleted_out}
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def delete_conversation(user_id, conv_id):
    """删除会话及其全部消息。返回是否删除成功。"""
    conn = _conn()
    try:
        cur = conn.execute(
            "SELECT id FROM ai_conversations WHERE id=? AND user_id=?",
            (conv_id, user_id),
        ).fetchone()
        if not cur:
            return False
        conn.execute("DELETE FROM ai_messages WHERE conv_id=? AND user_id=?", (conv_id, user_id))
        conn.execute("DELETE FROM ai_conversations WHERE id=? AND user_id=?", (conv_id, user_id))
        conn.commit()
        return True
    finally:
        conn.close()


def _prefs_ensure(conn):
    """确保 ai_prefs 存在且带上 cur_roots 列（老库由 store_db 补列，这里再兜一次底）。"""
    conn.execute(
        "CREATE TABLE IF NOT EXISTS ai_prefs (user_id TEXT PRIMARY KEY, "
        "cur_conv TEXT DEFAULT '', cur_roots TEXT DEFAULT '{}')"
    )
    try:
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(ai_prefs)")}
    except Exception:
        cols = set()
    if cols and "cur_roots" not in cols:
        conn.execute("ALTER TABLE ai_prefs ADD COLUMN cur_roots TEXT DEFAULT '{}'")


def _prefs_row(conn, user_id):
    """读出 (旧版单值 cur_conv, 按项目的 {root: 会话 id})。"""
    row = conn.execute(
        "SELECT cur_conv, cur_roots FROM ai_prefs WHERE user_id=?", (user_id,)
    ).fetchone()
    if not row:
        return "", {}
    roots = {}
    try:
        loaded = json.loads(row["cur_roots"] or "{}")
        if isinstance(loaded, dict):
            roots = loaded
    except (ValueError, TypeError):
        roots = {}
    return (row["cur_conv"] or ""), roots


def get_current(user_id, root=""):
    """读取【该项目】的当前会话 id（按项目根目录区分，存在 ai_prefs.cur_roots）。"""
    conn = _conn()
    try:
        _prefs_ensure(conn)
        legacy, roots = _prefs_row(conn, user_id)
        key = _norm_root(root)
        if key in roots:
            return roots[key] or ""
        # 没打开文件夹（root 为空）时沿用旧版单值，保持老行为；
        # 有项目时一律以「按项目的记录」为准，绝不把别的项目的当前会话串过来。
        return legacy if not key else ""
    finally:
        conn.close()


def set_current(user_id, conv_id, root=""):
    """设置【该项目】的当前会话 id。空串根目录同时维护旧单值，保持向后兼容。"""
    conn = _conn()
    try:
        _prefs_ensure(conn)
        legacy, roots = _prefs_row(conn, user_id)
        key = _norm_root(root)
        if conv_id:
            roots[key] = conv_id
        else:
            roots.pop(key, None)
        if not key:
            legacy = conv_id or ""
        conn.execute(
            "INSERT INTO ai_prefs(user_id, cur_conv, cur_roots) VALUES(?,?,?) "
            "ON CONFLICT(user_id) DO UPDATE SET cur_conv=excluded.cur_conv, cur_roots=excluded.cur_roots",
            (user_id, legacy or "", json.dumps(roots, ensure_ascii=False)),
        )
        conn.commit()
    finally:
        conn.close()


def forget_current(user_id, conv_id):
    """会话被删除后，把所有项目里指向它的「当前会话」记录一并清掉。"""
    if not conv_id:
        return
    conn = _conn()
    try:
        _prefs_ensure(conn)
        legacy, roots = _prefs_row(conn, user_id)
        hit = False
        for k in [k for k, v in roots.items() if v == conv_id]:
            roots.pop(k, None)
            hit = True
        if legacy == conv_id:
            legacy = ""
            hit = True
        if not hit:
            return
        conn.execute(
            "UPDATE ai_prefs SET cur_conv=?, cur_roots=? WHERE user_id=?",
            (legacy or "", json.dumps(roots, ensure_ascii=False), user_id),
        )
        conn.commit()
    finally:
        conn.close()

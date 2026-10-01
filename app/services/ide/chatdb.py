"""AI 对话历史持久化：SQLite 存储层。

对话（conversations）按 user_id 隔离，每条对话下挂多条消息（messages）。
消息中图片以 dataURL 形式完整保存（images 字段存 JSON 数组），保证多端回放一致。
"""
import os
import json
import time
import sqlite3

from ... import config


CHAT_DB = os.path.join(config.DATA_ROOT, ".file_manager_ai_chat.db")

# 单条消息图片 dataURL 上限（与 ai.py 的 _MAX_IMAGE_DATAURL 对齐）
_MAX_IMAGE_DATAURL = 9_000_000
_MAX_IMAGE_PARTS = 8


def _conn():
    conn = sqlite3.connect(CHAT_DB, timeout=30)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    return conn


def init_chat_db():
    """建表（幂等）。"""
    conn = _conn()
    try:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS ai_conversations (
                id         TEXT PRIMARY KEY,
                user_id    TEXT NOT NULL,
                title      TEXT DEFAULT '',
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL,
                extra      TEXT DEFAULT ''          -- JSON：mem / cmp / cmpLen / savedTok / stats
            );
            CREATE TABLE IF NOT EXISTS ai_messages (
                conv_id  TEXT NOT NULL,
                mid      TEXT NOT NULL,
                user_id  TEXT NOT NULL,
                role     TEXT NOT NULL,
                text     TEXT DEFAULT '',
                images   TEXT DEFAULT '',           -- JSON 数组：图片 dataURL（完整保存）
                reasoning TEXT DEFAULT '',
                meta     TEXT DEFAULT '',           -- JSON：{ms, ts, steps, files}
                seq      INTEGER NOT NULL,
                created_at REAL NOT NULL,
                PRIMARY KEY (conv_id, mid)
            );
            CREATE INDEX IF NOT EXISTS idx_ai_conv_user ON ai_conversations(user_id, updated_at DESC);
            CREATE INDEX IF NOT EXISTS idx_ai_msg_user ON ai_messages(user_id, conv_id, seq);
        """)
        conn.commit()
    finally:
        conn.close()


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
    for k in ("ms", "ts", "steps", "files", "changes", "undone", "err"):
        if k in meta and meta[k] is not None:
            clean[k] = meta[k]
    return clean


def list_conversations(user_id):
    """返回会话列表（不含消息），按 updated_at 倒序。"""
    conn = _conn()
    try:
        rows = conn.execute(
            "SELECT c.id, c.title, c.created_at, c.updated_at, c.extra, "
            "(SELECT COUNT(*) FROM ai_messages m WHERE m.conv_id=c.id) AS cnt "
            "FROM ai_conversations c WHERE c.user_id=? ORDER BY c.updated_at DESC",
            (user_id,),
        ).fetchall()
        return [{
            "id": r[0], "title": r[1], "created_at": r[2], "updated_at": r[3],
            "msg_count": r[5], "extra": json.loads(r[4]) if r[4] else {},
        } for r in rows]
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


def upsert_conversation(user_id, conv_id, title, extra, msgs, deleted=None):
    """新建 / 更新会话：插入缺失的新消息，可选删除消息，更新标题与 extra。

    返回 {id, saved_mids:[...], deleted:[...]}。
    """
    now = time.time()
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
                "UPDATE ai_conversations SET title=?, updated_at=?, extra=? WHERE id=? AND user_id=?",
                (title or "", now, json.dumps(extra or {}, ensure_ascii=False), conv_id, user_id),
            )
        else:
            conn.execute(
                "INSERT INTO ai_conversations(id, user_id, title, created_at, updated_at, extra) "
                "VALUES(?,?,?,?,?,?)",
                (conv_id, user_id, title or "", now, now, json.dumps(extra or {}, ensure_ascii=False)),
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


def get_current(user_id):
    """读取当前会话 id（ai_prefs 表）。"""
    conn = _conn()
    try:
        conn.execute(
            "CREATE TABLE IF NOT EXISTS ai_prefs (user_id TEXT PRIMARY KEY, cur_conv TEXT DEFAULT '')"
        )
        row = conn.execute("SELECT cur_conv FROM ai_prefs WHERE user_id=?", (user_id,)).fetchone()
        return row[0] if row else ""
    finally:
        conn.close()


def set_current(user_id, conv_id):
    """设置当前会话 id。"""
    conn = _conn()
    try:
        conn.execute(
            "CREATE TABLE IF NOT EXISTS ai_prefs (user_id TEXT PRIMARY KEY, cur_conv TEXT DEFAULT '')"
        )
        conn.execute(
            "INSERT INTO ai_prefs(user_id, cur_conv) VALUES(?, ?) "
            "ON CONFLICT(user_id) DO UPDATE SET cur_conv=excluded.cur_conv",
            (user_id, conv_id or ""),
        )
        conn.commit()
    finally:
        conn.close()

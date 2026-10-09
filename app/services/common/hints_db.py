"""文件说明（自定义）存储：name -> hint，落在 store.db 的 file_hints 表。

special_hints.json 提供内置「基础说明」（只读、随代码维护）；
这里存用户在界面上为任意文件 / 文件夹补充或覆盖的说明。
前端把两者合并展示（自定义优先），hint 清空即删除该条自定义记录、回落到基础说明。
"""
import time

from .store_db import store_conn, store_tx


def load_hints():
    """返回 {name: hint}，只含非空说明。"""
    conn = store_conn()
    try:
        rows = conn.execute("SELECT name, hint FROM file_hints").fetchall()
        return {r["name"]: r["hint"] for r in rows if (r["hint"] or "").strip()}
    finally:
        conn.close()


def set_hint(name, hint):
    """保存 / 更新一条说明；hint 为空表示删除该自定义项（回落到内置基础说明）。"""
    name = (name or "").strip()
    if not name:
        return False
    text = (hint or "").strip()
    with store_tx() as conn:
        if text:
            conn.execute(
                "INSERT OR REPLACE INTO file_hints (name, hint, updated_at) VALUES (?, ?, ?)",
                (name, text, time.time()))
        else:
            conn.execute("DELETE FROM file_hints WHERE name = ?", (name,))
    return True


def delete_hint(name):
    """删除一条自定义说明（表里没有该键时也返回 True）。"""
    name = (name or "").strip()
    if not name:
        return False
    with store_tx() as conn:
        conn.execute("DELETE FROM file_hints WHERE name = ?", (name,))
    return True

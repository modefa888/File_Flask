"""压缩 / 解压历史记录服务。"""
import json
import os
import threading
import time
import uuid

from ...config import _DATA_ROOT
from ...log import get_logger

_log = get_logger()
_ARCHIVE_HISTORY_FILE = os.path.join(_DATA_ROOT, ".file_manager_archive_history.json")
_ARCHIVE_HISTORY_LOCK = threading.Lock()


def _load():
    """加载压缩/解压历史记录"""
    try:
        with open(_ARCHIVE_HISTORY_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return []


def _save(items):
    """保存压缩/解压历史记录"""
    try:
        with open(_ARCHIVE_HISTORY_FILE, "w", encoding="utf-8") as f:
            json.dump(items, f, ensure_ascii=False)
    except OSError:
        pass


def add_record(kind, name, path, detail=""):
    """记录一次归档操作：kind='zip' 压缩 / kind='unzip' 解压"""
    with _ARCHIVE_HISTORY_LOCK:
        items = _load()
        items.append({
            "id": uuid.uuid4().hex[:12],
            "kind": kind,
            "name": name,
            "path": path,
            "detail": detail,
            "time": time.time(),
        })
        if len(items) > 300:
            items = items[-300:]
        _save(items)

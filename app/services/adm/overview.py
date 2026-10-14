"""后台管理：概览统计、系统信息、配置快照与日志读取。

本模块只做「只读聚合」：把散落在 store.db 各业务表、data/ 目录以及系统层面的
数据汇成后台首页需要的几块信息，不修改任何业务状态。所有异常都被吞掉并降级为
默认值，保证后台页在部分数据缺失时仍能打开。
"""
import os
import platform
import sys
import time

from ... import config
from ...log import get_logger, _LOG_DIR
from ..common.store_db import store_conn
from ...services.common.auth_settings import registration_open

_log = get_logger()

try:
    import psutil
except Exception:                       # 未安装 psutil 时降级
    psutil = None


# --------------------------------------------------------------------------- 工具
def _count(conn, sql, args=()):
    """执行 COUNT 类查询，出错返回 0。"""
    try:
        row = conn.execute(sql, args).fetchone()
        return int((row[0] if row else 0) or 0)
    except Exception:
        return 0


def _one(conn, sql, args=()):
    try:
        return conn.execute(sql, args).fetchone()
    except Exception:
        return None


def _dir_size(path):
    """递归统计目录占用字节数（出错忽略）。"""
    total = 0
    try:
        for root, _dirs, files in os.walk(path):
            for name in files:
                try:
                    total += os.path.getsize(os.path.join(root, name))
                except OSError:
                    continue
    except OSError:
        pass
    return total


def _file_size(path):
    try:
        return os.path.getsize(path) if os.path.isfile(path) else 0
    except OSError:
        return 0


# --------------------------------------------------------------------------- 概览
def _business_counts():
    """从 store.db 汇总各业务对象的数量。"""
    out = {}
    try:
        conn = store_conn()
        try:
            out = {
                "users": _count(conn, "SELECT COUNT(*) FROM users"),
                "admins": _count(conn, "SELECT COUNT(*) FROM users WHERE role='admin'"),
                "members": _count(conn, "SELECT COUNT(*) FROM users WHERE role='member'"),
                "shares": _count(conn, "SELECT COUNT(*) FROM shares"),
                "shares_active": _count(conn, "SELECT COUNT(*) FROM shares WHERE revoked=0"),
                "cron_tasks": _count(conn, "SELECT COUNT(*) FROM cron_tasks"),
                "cron_enabled": _count(conn, "SELECT COUNT(*) FROM cron_tasks WHERE enabled=1"),
                "cron_runs": _count(conn, "SELECT COUNT(*) FROM cron_runs"),
                "plugins": _count(conn, "SELECT COUNT(*) FROM plugin_registry"),
                "db_conns": _count(conn, "SELECT COUNT(*) FROM db_conns"),
                "ai_providers": _count(conn, "SELECT COUNT(*) FROM ai_providers"),
                "ai_conversations": _count(conn, "SELECT COUNT(*) FROM ai_conversations"),
                "ai_messages": _count(conn, "SELECT COUNT(*) FROM ai_messages"),
                "notify_history": _count(conn, "SELECT COUNT(*) FROM notify_history"),
                "archive_history": _count(conn, "SELECT COUNT(*) FROM archive_history"),
                "delete_history": _count(conn, "SELECT COUNT(*) FROM delete_history"),
                "file_hints": _count(conn, "SELECT COUNT(*) FROM file_hints"),
                "favorites": _count(conn, "SELECT COUNT(*) FROM favorites"),
                "recent_folders": _count(conn, "SELECT COUNT(*) FROM recent_folders"),
            }
        finally:
            conn.close()
    except Exception as e:
        _log.warning("汇总业务计数失败：%s", e)
    return out


def _ai_summary():
    """AI 调用统计（累计成功 / 失败 / token）。"""
    out = {"modules": 0, "ok": 0, "fail": 0, "tokens_in": 0, "tokens_out": 0, "calls": 0}
    try:
        conn = store_conn()
        try:
            row = _one(conn, "SELECT COUNT(*) AS n, COALESCE(SUM(ok),0) AS ok, "
                             "COALESCE(SUM(fail),0) AS fail, "
                             "COALESCE(SUM(tokens_in),0) AS tin, COALESCE(SUM(tokens_out),0) AS tout "
                             "FROM ai_usage")
            if row is not None:
                out.update({"modules": int(row["n"] or 0), "ok": int(row["ok"] or 0),
                            "fail": int(row["fail"] or 0), "tokens_in": int(row["tin"] or 0),
                            "tokens_out": int(row["tout"] or 0)})
            out["calls"] = _count(conn, "SELECT COUNT(*) FROM ai_calls")
        finally:
            conn.close()
    except Exception as e:
        _log.warning("汇总 AI 用量失败：%s", e)
    return out


def _plugin_counts():
    """统计已安装 / 已启用插件（读 data/plugins 下的 plugin.json）。"""
    import json
    base = os.path.join(config.DATA_ROOT, "plugins")
    installed = enabled = 0
    try:
        for name in os.listdir(base):
            mp = os.path.join(base, name, "plugin.json")
            if not os.path.isfile(mp):
                continue
            installed += 1
            try:
                with open(mp, encoding="utf-8") as f:
                    meta = json.load(f)
                if meta.get("enabled", True) is not False:
                    enabled += 1
            except Exception:
                enabled += 1
    except OSError:
        pass
    return {"installed": installed, "enabled": enabled}


def _ssh_count():
    """统计已保存的 SSH 连接数。"""
    import json
    path = os.path.join(config.DATA_ROOT, ".ssh_connections.json")
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        return len(data) if isinstance(data, list) else 0
    except (OSError, ValueError):
        return 0


def _system_block():
    """系统资源与运行环境信息（复用 proc 资源采集，失败降级）。"""
    res = {}
    if psutil is not None:
        try:
            from ..ide import procinfo
            res = procinfo.overview()
        except Exception as e:
            res = {"error": str(e)}
    else:
        res = {"error": "未安装 psutil（pip install psutil），无法采集系统资源"}

    boot = 0
    try:
        boot = int(psutil.boot_time()) if psutil is not None else 0
    except Exception:
        boot = 0
    return {
        "resource": res,
        "psutil": psutil is not None,
        "platform": platform.platform(),
        "python": platform.python_version(),
        "pid": os.getpid(),
        "boot": boot,
        "now": int(time.time()),
        "frozen": bool(getattr(sys, "frozen", False)),
    }


def system_resource():
    """仅系统资源快照（procinfo 后台线程每 2 秒采集，读取开销极小；供概览页轮询刷新）。"""
    if psutil is None:
        return {"error": "未安装 psutil（pip install psutil），无法采集系统资源"}
    try:
        from ..ide import procinfo
        return procinfo.overview()
    except Exception as e:
        return {"error": str(e)}


_STORAGE_CACHE = {"t": 0.0, "data": None}


def _storage_block():
    """data / logs 目录的占用情况（60 秒缓存，避免频繁全盘遍历）。"""
    now = time.time()
    if _STORAGE_CACHE["data"] is not None and now - _STORAGE_CACHE["t"] < 60:
        return _STORAGE_CACHE["data"]
    logs_root = _LOG_DIR
    block = {
        "data_dir": config.DATA_ROOT,
        "logs_dir": logs_root,
        "storage_dir": config.STORAGE_DIR,
        "data_size": _dir_size(config.DATA_ROOT),
        "logs_size": _dir_size(logs_root),
        "store_db": _file_size(getattr(config, "_STORE_DB_FILE", "")),
        "index_db": _file_size(getattr(config, "_INDEX_DB_FILE", "")),
        "trash_size": _dir_size(os.path.join(config.DATA_ROOT, ".file_manager_trash")),
        "thumb_size": _dir_size(os.path.join(config.DATA_ROOT, ".file_manager_thumbs")),
        "cover_size": _dir_size(os.path.join(config.DATA_ROOT, ".file_manager_covers")),
        "run_logs_size": _dir_size(os.path.join(config.DATA_ROOT, "run_logs")),
        "cron_logs_size": _dir_size(os.path.join(config.DATA_ROOT, "cron_logs")),
    }
    _STORAGE_CACHE["t"] = now
    _STORAGE_CACHE["data"] = block
    return block


def _recent_block():
    """最近动态：定时任务执行 + AI 调用。"""
    runs, calls = [], []
    try:
        conn = store_conn()
        try:
            for r in conn.execute("SELECT id, task_name, status, started_at, duration, trigger "
                                  "FROM cron_runs ORDER BY started_at DESC LIMIT 6"):
                runs.append({"id": r["id"], "task_name": r["task_name"], "status": r["status"],
                             "started_at": r["started_at"], "duration": r["duration"] or 0,
                             "trigger": r["trigger"]})
            for r in conn.execute("SELECT id, module, ok, ms, ts, model FROM ai_calls "
                                  "ORDER BY id DESC LIMIT 6"):
                calls.append({"id": r["id"], "module": r["module"], "ok": bool(r["ok"]),
                              "ms": r["ms"] or 0, "ts": r["ts"], "model": r["model"] or ""})
        finally:
            conn.close()
    except Exception as e:
        _log.warning("读取最近动态失败：%s", e)
    return {"cron_runs": runs, "ai_calls": calls}


def dashboard():
    """后台首页概览：业务计数 + AI 用量 + 插件 / SSH + 系统 + 存储 + 最近动态。"""
    counts = _business_counts()
    counts.update(_plugin_counts())
    counts["ssh_conns"] = _ssh_count()
    return {
        "counts": counts,
        "ai": _ai_summary(),
        "system": _system_block(),
        "storage": _storage_block(),
        "recent": _recent_block(),
        "generated_at": int(time.time()),
    }


# --------------------------------------------------------------------------- 配置快照
def _rule_groups():
    """命令安全规则分组（只读展示）：名称 / 说明 / 各级别条数。"""
    out = []
    for gid, name, desc, items in getattr(config, "EXEC_RULE_GROUPS", []):
        levels = {"blocked": 0, "confirm": 0, "delete": 0}
        for _pat, _reason, lv in items:
            levels[lv] = levels.get(lv, 0) + 1
        out.append({"id": gid, "name": name, "desc": desc,
                    "total": len(items), **levels})
    return out


def config_snapshot():
    """系统配置快照（只读、不含密钥，仅标注是否已设置）。"""
    return {
        "service": {
            "host": config.HOST,
            "port": config.PORT,
            "debug": bool(config.DEBUG),
            "base_dir": config.BASE_DIR,
            "data_root": config.DATA_ROOT,
            "storage_dir": config.STORAGE_DIR,
            "default_start_path": config.DEFAULT_START_PATH,
            "timezone": time.strftime("%Z") or "-",
            "server_time": time.strftime("%Y-%m-%d %H:%M:%S"),
        },
        "auth": {
            "admin_username": config.AUTH_USERNAME,
            "secret_salt_set": bool(config.SECRET_SALT),
            "export_password_set": bool(config.EXPORT_PASSWORD),
            "allow_register": registration_open(),
        },
        "exec": {
            "enable_exec": bool(config.ENABLE_EXEC),
            "exec_enforce_safety": bool(config.EXEC_ENFORCE_SAFETY),
            "enable_auto_install": bool(config.ENABLE_AUTO_INSTALL),
            "run_timeout": config.RUN_TIMEOUT,
            "run_timeout_max": config.RUN_TIMEOUT_MAX,
            "run_timeout_action": config.RUN_TIMEOUT_ACTION,
            "run_log_keep_days": config.RUN_LOG_KEEP_DAYS,
        },
        "media": {
            "ffmpeg": config.FFMPEG_BIN,
            "ffprobe": config.FFPROBE_BIN,
            "text_exts": len(getattr(config, "_TEXT_EXTS", set())),
            "image_exts": len(getattr(config, "_IMAGE_EXTS", set())),
            "video_exts": len(getattr(config, "_VIDEO_EXTS", set())),
            "audio_exts": len(getattr(config, "_AUDIO_EXTS", set())),
            "max_content_mb": 32,
        },
        "rules": {"groups": _rule_groups(),
                  "blocked": len(config.EXEC_BLOCK_PATTERNS),
                  "confirm": len(config.EXEC_CONFIRM_PATTERNS),
                  "delete": len(config.EXEC_DELETE_PATTERNS)},
    }


# --------------------------------------------------------------------------- 日志
def list_logs():
    """列出日志目录下的文件（名称 / 大小 / 修改时间），按修改时间倒序。"""
    items = []
    try:
        names = os.listdir(_LOG_DIR)
    except OSError:
        return {"dir": _LOG_DIR, "items": []}
    for name in names:
        full = os.path.join(_LOG_DIR, name)
        if not os.path.isfile(full):
            continue
        try:
            st = os.stat(full)
        except OSError:
            continue
        items.append({"name": name, "size": st.st_size, "mtime": st.st_mtime})
    items.sort(key=lambda x: x["mtime"], reverse=True)
    return {"dir": _LOG_DIR, "items": items}


def read_log(name, tail=500):
    """读取某个日志文件的尾部若干行（只允许日志目录内的文件，防目录穿越）。"""
    name = os.path.basename(str(name or "").strip())
    if not name:
        return {"error": "未指定日志文件"}
    full = os.path.join(_LOG_DIR, name)
    if not os.path.isfile(full):
        return {"error": "日志文件不存在"}
    try:
        with open(full, "r", encoding="utf-8", errors="replace") as f:
            lines = f.readlines()
    except OSError as e:
        return {"error": "读取失败：%s" % e}
    try:
        tail = max(1, min(5000, int(tail)))
    except (TypeError, ValueError):
        tail = 500
    total = len(lines)
    content = "".join(lines[-tail:])
    return {"name": name, "content": content, "lines": total,
            "shown": min(total, tail), "size": os.path.getsize(full)}

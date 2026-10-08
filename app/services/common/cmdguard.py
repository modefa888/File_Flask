# -*- coding: utf-8 -*-
"""命令安全规则的分组开关与自定义正则（设置 → 命令安全）。

规则本体在 config.EXEC_RULE_GROUPS（按用途分组，每条标明 blocked / confirm / delete 级别），
本模块负责三件事：
  1. 把规则整理成前端可直接渲染的目录（catalog）；
  2. 保存用户的选择 —— 总开关、分组开关、自定义正则（store.db 的 cmd_guard 表，单行 JSON）；
  3. 给 safety.py 提供「当前生效的规则」，被关掉的分组不再参与校验。

两条约定：
  · blocked 级别的硬拦截始终生效，不随任何开关放行。这类规则拦的是「删根目录 / 格式化磁盘 /
    直接写块设备」这种不可逆操作，给它配一个开关就等于把刹车做成装饰；要彻底关掉校验，
    只能用部署级开关 config.EXEC_ENFORCE_SAFETY（环境变量 EXEC_ENFORCE_SAFETY=False）。
  · 关掉分组只影响「要不要打断用户」：命令不再弹确认，直接执行。
"""
import json
import re
import threading

from ... import config
from ...log import get_logger
from .store_db import store_conn, store_tx

_log = get_logger()

_TABLE = "cmd_guard"
_KEY = "state"
_MAX_CUSTOM = 50                     # 自定义正则条数上限，避免设置被塞爆

# 级别的中文名（前端直接用，保证只有一处定义）
LEVELS = {"blocked": "硬拦截", "confirm": "需确认", "delete": "删除类"}

_lock = threading.RLock()
_state = None                        # 进程内缓存：{enabled, off, custom}
_active = None                       # 缓存编译好的生效规则，save() 后失效


def _default():
    return {"enabled": True, "off": [], "custom": []}


def _clean(raw) -> dict:
    """把读到的内容整成规范结构：字段缺失 / 类型不对就回到默认值，脏数据不至于把校验搞崩。"""
    st = _default()
    if not isinstance(raw, dict):
        return st
    st["enabled"] = bool(raw.get("enabled", True))

    known = {g[0] for g in config.EXEC_RULE_GROUPS}
    off = raw.get("off")
    if isinstance(off, dict):                    # 万一被存成 {0: "del", ...}
        off = list(off.values())
    elif isinstance(off, str):
        off = [off]
    st["off"] = sorted({str(x) for x in (off or []) if str(x) in known})

    custom = raw.get("custom")
    if isinstance(custom, dict):
        custom = list(custom.values())
    items = []
    for item in (custom or []):
        if not isinstance(item, dict):
            continue
        pattern = str(item.get("pattern") or "").strip()
        if not pattern:
            continue
        items.append({
            "pattern": pattern,
            "reason": str(item.get("reason") or "").strip() or "自定义规则",
            "on": bool(item.get("on", True)),
        })
    st["custom"] = items[:_MAX_CUSTOM]
    return st


def _read() -> dict:
    try:
        conn = store_conn()
        try:
            row = conn.execute("SELECT value FROM %s WHERE key=?" % _TABLE, (_KEY,)).fetchone()
        finally:
            conn.close()
        if row and row[0]:
            return json.loads(row[0])
    except Exception as e:                        # 表还没建好 / JSON 坏了都不该让命令执行挂掉
        _log.warning("读取命令安全设置失败：%s", e)
    return {}


def _write(st: dict) -> None:
    with store_tx() as conn:
        conn.execute("INSERT OR REPLACE INTO %s(key, value) VALUES(?, ?)" % _TABLE,
                     (_KEY, json.dumps(st, ensure_ascii=False)))


def state() -> dict:
    """当前设置（进程内缓存）。返回的是内部对象，调用方只读，不要就地修改。"""
    global _state
    with _lock:
        if _state is None:
            _state = _clean(_read())
        return _state


def save(payload) -> tuple:
    """整份覆盖保存，返回 (新设置, 错误信息)。前端每次改动都提交完整状态，省掉增量合并的坑。"""
    global _state, _active
    if not isinstance(payload, dict):
        return None, "参数格式不正确"
    st = _clean(payload)
    for item in st["custom"]:                     # 先编译一遍：坏的正则当场退回，别等执行时才炸
        try:
            re.compile(item["pattern"])
        except re.error as e:
            return None, "自定义规则不是合法的正则表达式：%s（%s）" % (item["pattern"], e)
    with _lock:
        try:
            _write(st)
        except Exception as e:
            return None, "保存失败：%s" % e
        _state, _active = st, None
    return st, None


def master_on() -> bool:
    """总开关：关掉后命令不再逐条确认（硬拦截仍然生效）。"""
    return bool(state().get("enabled", True))


def active_rules() -> dict:
    """当前生效的规则（已编译）：{"blocked": [(re, reason)], "confirm": [...], "delete": [...]}。

    blocked 始终全量返回；confirm / delete 按总开关与分组开关过滤。
    """
    global _active
    with _lock:
        if _active is not None:
            return _active
        st = state()
        master = bool(st.get("enabled", True))
        off = set(st.get("off") or [])
        out = {"blocked": [], "confirm": [], "delete": []}
        for gid, _name, _desc, items in config.EXEC_RULE_GROUPS:
            for pattern, reason, level in items:
                hard = level == "blocked"
                if not hard and (not master or gid in off):
                    continue                      # 总开关或该分组被关掉 -> 不再打断用户
                try:
                    out.setdefault(level, []).append((re.compile(pattern, re.IGNORECASE), reason))
                except re.error:
                    continue                      # 规则写错就跳过这条，不影响其它规则
        for item in st.get("custom") or []:       # 自定义正则一律按「需要确认」处理
            if not master or not item.get("on", True):
                continue
            try:
                out["confirm"].append((re.compile(item["pattern"], re.IGNORECASE),
                                       item.get("reason") or "自定义规则"))
            except re.error:
                continue
        _active = out
        return out


def catalog() -> dict:
    """设置页渲染用的目录：分组、规则、开关状态、自定义正则。"""
    st = state()
    off = set(st.get("off") or [])
    groups = []
    for gid, name, desc, items in config.EXEC_RULE_GROUPS:
        rules = [{"pattern": p, "reason": r, "level": lv} for p, r, lv in items]
        groups.append({
            "id": gid,
            "name": name,
            "desc": desc,
            "on": gid not in off,
            "count": len(rules),
            "lock": len([1 for x in rules if x["level"] == "blocked"]),   # 其中硬拦截条数（开关也拦不住）
            "rules": rules,
        })
    return {
        "enabled": bool(st.get("enabled", True)),
        "env_enabled": bool(getattr(config, "EXEC_ENFORCE_SAFETY", True)),
        "levels": dict(LEVELS),
        "groups": groups,
        "custom": [dict(x) for x in (st.get("custom") or [])],
        "custom_max": _MAX_CUSTOM,
    }

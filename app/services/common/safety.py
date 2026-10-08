"""命令安全校验：拦截危险命令，敏感命令要求二次确认。

规则定义在 config.EXEC_RULE_GROUPS（按用途分组，每条标明级别），分组开关与自定义正则
由 services/common/cmdguard.py 管理 —— 设置 → 命令安全 里能整组开关、加自己的正则。
命令会先按 shell 分隔符（; && || | 换行）拆成子命令逐个校验，
避免 `echo hi && rm -rf /` 这类拼接绕过。
"""
import re

from ... import config
from . import cmdguard


def split_commands(command: str):
    """按 shell 分隔符拆分命令（不处理引号内的分隔符，保守拆分）。"""
    parts = re.split(r"&&|\|\||;|\n|\|", command or "")
    return [p.strip() for p in parts if p and p.strip()]


def is_allowed_command(command: str) -> bool:
    """命令级全局放行（设置 → 命令安全 → 全局放行名单）：

    用户在确认卡片上选过「全局允许」的同名命令，之后在任何项目里都直接执行、不再弹确认。
    只做整条命令的精确匹配，不做正则/前缀匹配，避免把一整类命令都放出去。
    """
    text = (command or "").strip()
    return bool(text) and text in cmdguard.allow_set()


def is_delete_command(command: str):
    """判断是否是删除 / 破坏性命令，返回 (bool, reason)。

    规则来自「文件删除」等分组里 delete 级别的条目：被用户在设置里关掉的分组不再参与判断
    （关掉就意味着这些命令直接执行，不再打断）。
    """
    text = (command or "").strip()
    if not text:
        return False, ""
    if text in cmdguard.allow_set():           # 已加入全局放行名单：不再按删除命令打断
        return False, ""
    delete_rules = cmdguard.active_rules().get("delete") or []
    for part in [text] + split_commands(text):
        for regex, reason in delete_rules:
            if regex.search(part):
                return True, reason
    return False, ""


def check_command(command: str) -> dict:
    """返回 {"level": "ok"|"confirm"|"blocked", "reason": str, "part": str}。"""
    if not getattr(config, "EXEC_ENFORCE_SAFETY", True):
        return {"level": "ok", "reason": "", "part": ""}
    text = (command or "").strip()
    if not text:
        return {"level": "ok", "reason": "", "part": ""}
    if text in cmdguard.allow_set():          # 全局放行名单：任何项目都直接执行
        return {"level": "ok", "reason": "", "part": ""}

    rules = cmdguard.active_rules()
    blocked, confirm = rules.get("blocked") or [], rules.get("confirm") or []

    # 先整体匹配一次（有些规则需要看到整条命令，例如 dd ... of=/dev/xxx）
    candidates = [text] + split_commands(text)
    for regex, reason in blocked:
        for part in candidates:
            if regex.search(part):
                return {"level": "blocked", "reason": reason, "part": part}
    for regex, reason in confirm:
        for part in candidates:
            if regex.search(part):
                return {"level": "confirm", "reason": reason, "part": part}
    return {"level": "ok", "reason": "", "part": ""}


def rules_summary() -> dict:
    """给前端展示用的规则摘要：终端「规则说明」弹窗与设置页「命令安全」共用。

    blocked / confirm / delete 是**当前生效**的说明（已按设置里的开关过滤），
    guard 里带着完整目录与开关状态，供设置页渲染。
    """
    live = cmdguard.active_rules()
    guard = cmdguard.catalog()
    return {
        "enabled": bool(getattr(config, "EXEC_ENFORCE_SAFETY", True)),
        # 去重（多条正则可能对应同一条说明）
        "blocked": list(dict.fromkeys(r for _p, r in live.get("blocked") or [])),
        "confirm": list(dict.fromkeys(r for _p, r in live.get("confirm") or [])),
        "delete": list(dict.fromkeys(r for _p, r in live.get("delete") or [])),
        "master": guard["enabled"],                                    # 设置里的总开关
        "off_groups": [g["name"] for g in guard["groups"] if not g["on"]],   # 已关闭的分组
        "custom": [c["pattern"] for c in guard["custom"] if c.get("on")],    # 生效的自定义正则
        "allow": list(guard.get("allow") or []),          # 全局放行名单（任何项目都直接执行）
        "guard": guard,
    }

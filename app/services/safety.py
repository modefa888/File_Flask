"""命令安全校验：拦截危险命令，敏感命令要求二次确认。

规则定义在 config.EXEC_BLOCK_PATTERNS / EXEC_CONFIRM_PATTERNS，可自行增删。
命令会先按 shell 分隔符（; && || | 换行）拆成子命令逐个校验，
避免 `echo hi && rm -rf /` 这类拼接绕过。
"""
import re

from .. import config


def _rules(name, default):
    rules = getattr(config, name, None)
    if not rules:
        return []
    out = []
    for item in rules:
        try:
            pattern, reason = item[0], item[1]
        except (TypeError, IndexError):
            continue
        try:
            out.append((re.compile(pattern, re.IGNORECASE), reason))
        except re.error:
            continue          # 用户自定义的正则写错时忽略该条，不影响其它规则
    return out


def split_commands(command: str):
    """按 shell 分隔符拆分命令（不处理引号内的分隔符，保守拆分）。"""
    parts = re.split(r"&&|\|\||;|\n|\|", command or "")
    return [p.strip() for p in parts if p and p.strip()]


def check_command(command: str) -> dict:
    """返回 {"level": "ok"|"confirm"|"blocked", "reason": str, "part": str}。"""
    if not getattr(config, "EXEC_ENFORCE_SAFETY", True):
        return {"level": "ok", "reason": "", "part": ""}
    text = (command or "").strip()
    if not text:
        return {"level": "ok", "reason": "", "part": ""}

    blocked = _rules("EXEC_BLOCK_PATTERNS", [])
    confirm = _rules("EXEC_CONFIRM_PATTERNS", [])

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
    """给前端展示用的规则摘要。"""
    return {
        "enabled": bool(getattr(config, "EXEC_ENFORCE_SAFETY", True)),
        # 去重（多条正则可能对应同一条说明）
        "blocked": list(dict.fromkeys(r for _p, r in _rules("EXEC_BLOCK_PATTERNS", []))),
        "confirm": list(dict.fromkeys(r for _p, r in _rules("EXEC_CONFIRM_PATTERNS", []))),
    }

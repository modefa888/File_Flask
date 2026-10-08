"""Cron 表达式解析 / 匹配 / 推算下次运行时间（标准 5 段式 + 秒级 6 段式，参考青龙面板）。

支持写法：
    *            任意
    5            固定值
    1,2,5        列表
    1-5          区间
    */10         步长
    1-30/5       区间步长
    补零（如 05）同样识别

段顺序：
    5 段：分 时 日 月 周（0-6，0 与 7 都表示周日）
    6 段：秒 分 时 日 月 周（秒级精度，如 */30 * * * * * = 每 30 秒）
另有常用宏：@yearly @annually @monthly @weekly @daily @midnight @hourly（均为 5 段）。

日 / 周同时被限定（都不是 *）时，按标准 cron 语义取「或」（满足其一即可）。
"""
import re
from datetime import datetime, timedelta

__all__ = ["CronError", "parse_cron", "cron_matches", "next_runs", "validate"]

_MACROS = {
    "@yearly": "0 0 1 1 *", "@annually": "0 0 1 1 *",
    "@monthly": "0 0 1 * *", "@weekly": "0 0 * * 0",
    "@daily": "0 0 * * *", "@midnight": "0 0 * * *",
    "@hourly": "0 * * * *",
}

# 每一段的取值范围（周额外允许 7 = 周日）
# 索引：0=秒 1=分 2=时 3=日 4=月 5=周（6 段式从 0 开始；5 段式从 1 开始）
_RANGES = ((0, 59), (0, 59), (0, 23), (1, 31), (1, 12), (0, 7))
_NAMES = [
    {},                                                    # 秒：不支持名称
    {},                                                    # 分：不支持名称
    {},                                                    # 时
    {},                                                    # 日
    {"jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
     "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12},
    {"sun": 0, "mon": 1, "tue": 2, "wed": 3, "thu": 4, "fri": 5, "sat": 6},
]


class CronError(ValueError):
    """表达式非法。"""


def _num(tok, lo, hi, names):
    tok = tok.strip().lower()
    if not tok:
        raise CronError("存在空的取值")
    if names and tok in names:
        return names[tok]
    if not re.fullmatch(r"\d{1,2}", tok):                  # cron 里不允许负数 / 字母（除月份、星期名）
        raise CronError("非法取值：%s" % tok)
    v = int(tok)
    if v < lo or v > hi:
        raise CronError("取值 %d 超出范围 %d-%d" % (v, lo, hi))
    return v


def _parse_field(text, idx):
    """解析一段；返回 (值集合, 是否被限定)。"""
    lo, hi = _RANGES[idx]
    names = _NAMES[idx]
    raw = text.strip()
    if not raw:
        raise CronError("存在空白段")
    restricted = raw != "*"
    values = set()
    for part in raw.split(","):
        part = part.strip()
        if not part:
            raise CronError("存在空的分段")
        step = 1
        body = part
        if "/" in part:
            body, _, step_s = part.partition("/")
            if not re.fullmatch(r"\d{1,3}", step_s or ""):
                raise CronError("步长非法：%s" % part)
            step = int(step_s)
            if step <= 0:
                raise CronError("步长必须为正：%s" % part)
        if body in ("*", ""):
            start, end = lo, hi
        elif "-" in body.lstrip("-"):
            a, _, b = body.partition("-")
            start = _num(a, lo, hi, names)
            end = _num(b, lo, hi, names)
            if start > end:
                raise CronError("区间起始大于结束：%s" % part)
        else:
            start = end = _num(body, lo, hi, names)
        values.update(range(start, end + 1, step))
    if idx == 5 and 7 in values:                           # 周：7 归一到 0（周日）
        values.discard(7)
        values.add(0)
    valid = {v for v in values if lo <= v <= hi}
    if not valid:
        raise CronError("该段没有任何有效取值：%s" % raw)
    return valid, restricted


class _Cron(object):
    __slots__ = ("raw", "seconds", "minutes", "hours", "doms", "months", "dows",
                 "dom_restricted", "dow_restricted")

    def __init__(self, raw, seconds, minutes, hours, doms, months, dows, dom_res, dow_res):
        self.raw = raw
        self.seconds = seconds                             # None = 5 段式（秒位不参与匹配）
        self.minutes = minutes
        self.hours = hours
        self.doms = doms
        self.months = months
        self.dows = dows
        self.dom_restricted = dom_res
        self.dow_restricted = dow_res


def parse_cron(expr):
    """解析表达式，返回内部结构；非法时抛 CronError。

    6 段 = 秒 分 时 日 月 周（秒级）；5 段 = 分 时 日 月 周（分钟级）。
    """
    raw = str(expr or "").strip()
    if not raw:
        raise CronError("表达式不能为空")
    low = raw.lower()
    if low in _MACROS:
        raw = _MACROS[low]
    elif raw.startswith("@"):
        raise CronError("不支持的宏：%s" % raw)
    parts = raw.split()
    if len(parts) == 6:
        seconds, s_res = _parse_field(parts[0], 0)
        base = 1
    elif len(parts) == 5:
        seconds, base = None, 0                           # 分 时 日 月 周 → 段索引 1..5
    else:
        raise CronError("需要 5 段（分 时 日 月 周）或 6 段（秒 分 时 日 月 周），当前 %d 段" % len(parts))
    minutes, m_res = _parse_field(parts[base], 1)
    hours, h_res = _parse_field(parts[base + 1], 2)
    doms, dom_res = _parse_field(parts[base + 2], 3)
    months, mo_res = _parse_field(parts[base + 3], 4)
    dows, dow_res = _parse_field(parts[base + 4], 5)
    return _Cron(raw, seconds, minutes, hours, doms, months, dows, dom_res, dow_res)


def _match_day(c, dt):
    dom_ok = dt.day in c.doms
    dow_ok = ((dt.weekday() + 1) % 7) in c.dows               # python: 周一=0 → cron: 周日=0
    if c.dom_restricted and c.dow_restricted:
        return dom_ok or dow_ok                               # 标准 cron：两者都限定时取「或」
    if c.dom_restricted:
        return dom_ok
    if c.dow_restricted:
        return dow_ok
    return True


def cron_matches(expr, when=None):
    """判断某个时刻是否命中该表达式（5 段精确到分钟，6 段精确到秒）。

    5 段式下秒位不参与匹配（调用方需要自己保证按整分钟判断）。
    """
    c = expr if isinstance(expr, _Cron) else parse_cron(expr)
    dt = when or datetime.now()
    if c.seconds is not None and dt.second not in c.seconds:
        return False
    return (dt.minute in c.minutes and dt.hour in c.hours
            and dt.month in c.months and _match_day(c, dt))


def next_runs(expr, base=None, count=5):
    """从 base（默认现在）之后推算 count 个运行时刻（datetime 列表）。"""
    c = expr if isinstance(expr, _Cron) else parse_cron(expr)
    count = max(1, min(int(count or 5), 30))
    dt = (base or datetime.now()).replace(microsecond=0)
    if c.seconds is None:
        dt = dt.replace(second=0) + timedelta(minutes=1)
        step, limit = timedelta(minutes=1), 50000
    else:
        dt = dt + timedelta(seconds=1)
        step, limit = timedelta(seconds=1), 300000
    out, guard = [], 0
    while len(out) < count and guard < limit:
        guard += 1
        if dt.month not in c.months or not _match_day(c, dt):
            dt = (dt + timedelta(days=1)).replace(hour=0, minute=0, second=0)
            continue
        if dt.hour not in c.hours:
            dt = dt.replace(minute=0, second=0) + timedelta(hours=1)
            continue
        if dt.minute not in c.minutes:
            dt = dt.replace(second=0) + timedelta(minutes=1)
            continue
        if c.seconds is not None and dt.second not in c.seconds:
            dt += timedelta(seconds=1)
            continue
        out.append(dt)
        dt += step
    return out


def validate(expr):
    """校验表达式；返回 (ok, 错误信息 或 说明)。"""
    try:
        c = parse_cron(expr)
    except CronError as e:
        return False, str(e)
    nxt = next_runs(c, count=1)
    fmt = "%Y-%m-%d %H:%M:%S" if c.seconds is not None else "%Y-%m-%d %H:%M"
    tip = ("下次运行：" + nxt[0].strftime(fmt)) if nxt else "在未来 5 年内不会触发"
    return True, tip

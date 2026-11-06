"""定时任务「系统接口」动作注册表。

任务类型为 system 的定时任务到点后不起 shell 子进程，直接在本进程内调用
指定服务层函数（如 Trae CN / WorkBuddy 的全部签到）。输出写进执行日志，
收尾 / 统计 / 通知与其它任务类型完全一致。新增动作只需在 _ACTIONS 里登记。
"""
import importlib
import json

from ...log import get_logger

_log = get_logger()

# 动作注册表：id →（展示标签，模块名，函数名）。模块延迟导入，避免加载
# 定时任务模块时把所有积分服务一次性拉起来。
_ACTIONS = {
    "workbuddy_checkin_all": ("WorkBuddy 全部签到", "workbuddy", "checkin_all"),
    "traecn_checkin_all": ("Trae CN 全部签到", "traecn", "checkin_all"),
}


def list_actions() -> list:
    """全部可用动作（前端下拉用），按标签排序。"""
    items = [{"id": k, "label": v[0]} for k, v in _ACTIONS.items()]
    items.sort(key=lambda a: a["label"])
    return items


def has_action(action_id: str) -> bool:
    return str(action_id or "").strip() in _ACTIONS


def label_of(action_id: str) -> str:
    spec = _ACTIONS.get(str(action_id or "").strip())
    return spec[0] if spec else str(action_id or "未知动作")


def _item_line(it: dict) -> str:
    """items 里的一条结果 → 一行人读文本（谁 · 状态 · 消息 · 加了多少积分）。"""
    who = str(it.get("nickname") or it.get("name") or it.get("uid") or "账号")
    bits = []
    st = str(it.get("status") or "").strip()
    if st:
        bits.append({"success": "成功", "already": "已签过", "failed": "失败"}.get(st, st))
    msg = str(it.get("message") or "").strip()
    if msg:
        bits.append(msg)
    try:
        credit = float(it.get("credit") or 0)
        if credit:
            bits.append("+%g 积分" % credit)
    except (TypeError, ValueError):
        pass
    return "%s：%s" % (who, "，".join(bits) or "无返回信息")


def _flat_obj(label: str, res: dict) -> dict:
    """把动作结果摊平成「模板友好」的一层 JSON。

    自定义模板的变量取的是输出 JSON 的顶层字段（_json_vars 只展开一层），
    所以这里把常用值提到顶层：
    · {action} 动作标签；{ok} 是否成功；
    · summary 里的计数直接顶到 {total} {success} {already} {failed} {credit}；
    · 嵌套字典保留一层前缀（summary_total / summary_credit…）；
    · items 逐条拼成多行文本 {detail}（昵称：状态，消息，+积分）；
    · {items} / {summary} 仍保留原始 JSON，需要全量信息时可用。
    """
    out = {"action": label}
    summary = res.get("summary") if isinstance(res.get("summary"), dict) else {}
    for k in ("total", "success", "already", "failed", "credit"):
        if k in summary:
            out[k] = summary[k]
    for k, v in res.items():
        if isinstance(v, dict):
            for k2, v2 in v.items():
                out.setdefault("%s_%s" % (k, k2), v2)
        else:
            out.setdefault(k, v)
    lines = [_item_line(it) for it in (res.get("items") or [])
             if isinstance(it, dict)]
    if lines:
        out["detail"] = "\n".join(lines)
    return out


def _headline(label: str, res: dict) -> str:
    """一行人读摘要（写日志用，不能带花括号，避免干扰 JSON 变量解析）。"""
    s = res.get("summary") if isinstance(res.get("summary"), dict) else {}
    mark = "✔" if res.get("ok") else "✘"
    if not s:
        return "%s %s 执行完成" % (mark, label)
    parts = ["%s %s" % (k, s[k]) for k in ("success", "already", "failed")
             if k in s]
    try:
        if float(s.get("credit") or 0):
            parts.append("共 +%g 积分" % float(s["credit"]))
    except (TypeError, ValueError):
        pass
    return "%s %s：%s" % (mark, label, " · ".join(parts) or "无明细")


def run_action(action_id: str) -> str:
    """执行一个系统接口动作，返回写进执行日志的文本；未知动作抛 ValueError。

    输出格式：一行人读摘要 + 一个摊平后的 JSON 对象。自定义模板里的变量
    就是这个 JSON 的顶层字段（{action} {ok} {total} {success} {already}
    {failed} {credit} {detail} {summary} {items}…），与返回 JSON 的具体
    结构解耦——不管服务层将来怎么改返回值，模板字段保持稳定。
    """
    aid = str(action_id or "").strip()
    spec = _ACTIONS.get(aid)
    if not spec:
        raise ValueError("未知的系统接口动作：%s" % (aid or "（空）"))
    label, mod_name, fn_name = spec
    mod = importlib.import_module("app.services.ide." + mod_name)
    fn = getattr(mod, fn_name, None)
    if not callable(fn):
        raise RuntimeError("系统接口不可用：%s.%s" % (mod_name, fn_name))
    _log.info("定时任务系统接口：%s（%s.%s）", label, mod_name, fn_name)
    res = fn() or {}
    body = json.dumps(_flat_obj(label, res), ensure_ascii=False, indent=1,
                      default=str)
    return "----- 系统接口输出（%s）-----\n%s\n%s\n" % (
        label, _headline(label, res), body)

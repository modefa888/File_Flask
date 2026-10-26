"""定时任务（参考青龙面板）：任务的增删改查、启停、手动运行、执行记录与日志。

GET  /api/cron/tasks           任务列表（带下次运行时间、运行中状态）
POST /api/cron/save            新建 / 更新任务 {id?, name, cron(5或6段), command, cwd, enabled,
                               remark, timeout, max_retries, retry_interval, depends_on,
                               pre_hook, post_hook, notify, notify_content, notify_lines,
                               notify_title, notify_body}
                               任务类型：kind=command（命令）/ code（代码片段，配 lang=python|node|bash
                               与 content）/ ai（固定提示词，配 content 与可选 ai_sys）
POST /api/cron/delete          删除任务 {id}
POST /api/cron/toggle          启用 / 停用 {id, enabled}
POST /api/cron/run             立即运行一次 {id}
POST /api/cron/stop            停止正在运行的执行 {id | run_id}
GET  /api/cron/runs            执行记录 ?task_id=&limit=
GET  /api/cron/log             执行日志（增量）?run_id=&offset=
POST /api/cron/clear-runs      清空某任务的执行记录 {id}
POST /api/cron/validate        校验 cron 表达式并给出下次运行时间 {cron}
POST /api/cron/dry-run         试运行：用编辑中的命令跑一次并返回脚本输出（不落记录、不通知）
POST /api/cron/suggest         按文件推断命令 / 名称 / 工作目录，供「从文件新建定时任务」预填 {path}
GET  /api/cron/monitor         实时资源监控（系统 CPU / 内存 + 运行中任务的进程占用）
GET  /api/cron/settings        模块设置（日志清理 / 通知配置，密钥脱敏）
POST /api/cron/settings        保存模块设置 {log_days, keep_runs, notify:{...}}
POST /api/cron/notify-test     对指定渠道发测试通知 {channel}
POST /api/cron/notify-ai       让 AI 根据试运行输出生成一版自定义通知文案
POST /api/cron/ai-draft        一句话生成定时任务草稿（名称 / 类型 / cron / 代码或提示词 / 通知方式）
GET  /api/cron/backup          导出全部任务与设置（JSON，供下载备份）
POST /api/cron/restore         恢复备份 {tasks:[...], settings:{...}, mode:"merge"|"replace"}
"""
import json
import os
import re
import shlex
import time
import urllib.error
import urllib.request

from flask import Blueprint, jsonify, render_template, request

from ...log import get_logger
from ...services.ide import crondb, cronnotify, cronsvc, cronutil
from ...services.common.safety import check_command

_log = get_logger()
bp = Blueprint("cron", __name__)


def _next_runs(expr, count=3):
    try:
        c = cronutil.parse_cron(expr)
    except cronutil.CronError:
        return []
    fmt = "%Y-%m-%d %H:%M:%S" if c.seconds is not None else "%Y-%m-%d %H:%M"
    try:
        return [d.strftime(fmt) for d in cronutil.next_runs(c, count=count)]
    except cronutil.CronError:
        return []


def _with_runtime(t):
    """补上界面要用的派生字段：下次运行时间、是否运行中。"""
    d = dict(t)
    d["next"] = _next_runs(t.get("cron") or "", 3) if t.get("enabled") else []
    running_id = cronsvc.running_run_id(t["id"])
    d["running"] = bool(running_id)
    d["run_id"] = running_id or ""
    return d


@bp.route("/api/cron/tasks")
def api_cron_tasks():
    tasks = [_with_runtime(t) for t in crondb.list_tasks()]
    tasks.sort(key=lambda x: (not x.get("enabled"), x.get("created_at") or 0))
    from ..common.paginate import paginate_opt
    page_items, total = paginate_opt(tasks, request)
    summary = {
        "total": len(tasks),
        "enabled": sum(1 for t in tasks if t.get("enabled")),
        "running": sum(1 for t in tasks if t["running"]),
        "ok": sum(int(t.get("ok_count") or 0) for t in tasks),
        "fail": sum(int(t.get("fail_count") or 0) for t in tasks),
    }
    if total is None:
        return jsonify({"ok": True, "tasks": tasks, "running": summary["running"],
                        "summary": summary})
    return jsonify({"ok": True, "tasks": page_items, "total": total,
                    "running": summary["running"], "summary": summary})


@bp.route("/api/cron/save", methods=["POST"])
def api_cron_save():
    data = request.get_json(silent=True) or {}
    name = str(data.get("name") or "").strip()
    expr = str(data.get("cron") or "").strip()
    command = str(data.get("command") or "").strip()
    # 任务类型：command（shell 命令）/ code（代码片段）/ ai（固定提示词）
    kind = str(data.get("kind") or "command").strip().lower()
    if kind not in crondb.KINDS:
        kind = "command"
    lang = str(data.get("lang") or "python").strip().lower()
    if lang not in crondb.LANGS:
        lang = "python"
    content = str(data.get("content") or "")
    ai_sys = str(data.get("ai_sys") or "").strip()[:4000]
    if not name:
        return jsonify({"error": "请填写任务名称"})
    if kind == "command":
        if not command:
            return jsonify({"error": "请填写要执行的命令"})
    elif kind == "code":
        if not content.strip():
            return jsonify({"error": "请填写要执行的代码"})
        # 命令字段只做界面展示 / 日志摘要，真正执行时由 cronsvc 落脚本再跑
        command = cronsvc._display_command("code", "", lang, content)
    else:
        if not content.strip():
            return jsonify({"error": "请填写固定的 AI 提示词"})
        command = cronsvc._display_command("ai", "", lang, content)
    ok, tip = cronutil.validate(expr)
    if not ok:
        return jsonify({"error": "cron 表达式非法：" + tip})
    cwd = str(data.get("cwd") or "").strip()
    if cwd and not os.path.isdir(cwd):
        return jsonify({"error": "工作目录不存在：%s" % cwd})
    try:
        timeout = max(0, int(data.get("timeout") or 0))
    except (TypeError, ValueError):
        timeout = 0
    try:
        max_retries = max(0, int(data.get("max_retries") or 0))
    except (TypeError, ValueError):
        max_retries = 0
    try:
        retry_interval = max(1, int(data.get("retry_interval") or 60))
    except (TypeError, ValueError):
        retry_interval = 60
    depends_on = data.get("depends_on") or []
    if isinstance(depends_on, str):
        depends_on = [s.strip() for s in depends_on.split(",") if s.strip()]
    depends_on = [str(s) for s in depends_on if str(s).strip()]
    pre_hook = str(data.get("pre_hook") or "").strip()
    post_hook = str(data.get("post_hook") or "").strip()
    notify = crondb.as_bool(data.get("notify"), True)
    # 通知内容：status（仅结果）/ output（结果 + 脚本输出）/ output_only / custom（自定义模板）
    notify_content = str(data.get("notify_content") or "status").strip().lower()
    if notify_content not in crondb.NOTIFY_MODES:
        notify_content = "status"
    raw_lines = data.get("notify_lines")
    if raw_lines is None or raw_lines == "":
        notify_lines = 20                              # 没传 / 留空：默认取末尾 20 行
    else:
        try:
            notify_lines = max(0, min(int(raw_lines), 200))
        except (TypeError, ValueError):
            notify_lines = 20
    notify_title = str(data.get("notify_title") or "").strip()[:200]
    notify_body = str(data.get("notify_body") or "").strip()[:2000]
    # 通知渠道：任务可只发其中几个（空 = 跟随「通知设置」里已启用的渠道）
    notify_channels = crondb.norm_channels(data.get("notify_channels"))
    enabled = crondb.as_bool(data.get("enabled"), True)
    remark = str(data.get("remark") or "").strip()
    tid = str(data.get("id") or "").strip()
    # 依赖任务必须真实存在（依赖自己等于死锁，直接拒绝）
    for dep in depends_on:
        if dep == tid:
            return jsonify({"error": "任务不能依赖自己"})
        if not crondb.get_task(dep):
            return jsonify({"error": "依赖的任务不存在或已被删除，请重新勾选"})
    # 钩子也要过一遍危险命令校验（与主命令同标准）
    for label, hook in (("前置钩子", pre_hook), ("后置钩子", post_hook)):
        verdict = check_command(hook)
        if verdict.get("level") == "blocked":
            return jsonify({"error": "%s被拦截：%s" % (label, verdict.get("reason"))})
    fields = dict(name=name, cron=expr, command=command, kind=kind, lang=lang,
                  content=content, ai_sys=ai_sys, cwd=cwd, enabled=enabled,
                  remark=remark, timeout=timeout, max_retries=max_retries,
                  retry_interval=retry_interval, depends_on=",".join(depends_on),
                  pre_hook=pre_hook, post_hook=post_hook, notify=notify,
                  notify_content=notify_content, notify_lines=notify_lines,
                  notify_title=notify_title, notify_body=notify_body,
                  notify_channels=notify_channels)
    if tid:
        if not crondb.get_task(tid):
            return jsonify({"error": "任务不存在"})
        task = crondb.update_task(tid, **fields)
    else:
        task = crondb.create_task(name, expr, command, cwd=cwd, enabled=enabled,
                                  remark=remark, timeout=timeout,
                                  max_retries=max_retries, retry_interval=retry_interval,
                                  depends_on=",".join(depends_on), pre_hook=pre_hook,
                                  post_hook=post_hook, notify=notify,
                                  notify_content=notify_content, notify_lines=notify_lines,
                                  notify_title=notify_title, notify_body=notify_body,
                                  notify_channels=notify_channels,
                                  kind=kind, lang=lang, content=content, ai_sys=ai_sys)
    return jsonify({"ok": True, "task": _with_runtime(task)})


@bp.route("/api/cron/delete", methods=["POST"])
def api_cron_delete():
    data = request.get_json(silent=True) or {}
    tid = str(data.get("id") or "").strip()
    if not crondb.get_task(tid):
        return jsonify({"error": "任务不存在"})
    if cronsvc.is_running(tid):
        cronsvc.stop_task(tid)
    cronsvc.cancel_retry(tid)                      # 取消还没到点的自动重试
    logs = crondb.delete_task(tid)
    for p in logs:
        cronsvc._remove_log(p)                     # 连同该任务的日志文件一起清理
    cronsvc._remove_task_dir(tid)
    return jsonify({"ok": True})


@bp.route("/api/cron/toggle", methods=["POST"])
def api_cron_toggle():
    data = request.get_json(silent=True) or {}
    tid = str(data.get("id") or "").strip()
    task = crondb.get_task(tid)
    if not task:
        return jsonify({"error": "任务不存在"})
    enabled = data.get("enabled")
    if enabled is None:
        enabled = not task.get("enabled")
    return jsonify({"ok": True, "task": _with_runtime(crondb.set_enabled(tid, bool(enabled)))})


@bp.route("/api/cron/run", methods=["POST"])
def api_cron_run():
    data = request.get_json(silent=True) or {}
    tid = str(data.get("id") or "").strip()
    res = cronsvc.start_run(tid, "manual")
    if res.get("error"):
        return jsonify(res)
    return jsonify({"ok": True, "run_id": res["run_id"]})


@bp.route("/api/cron/dry-run", methods=["POST"])
def api_cron_dry_run():
    """试运行：用编辑中的命令跑一次并返回脚本输出（不写执行记录、不发通知）。

    入参：{command, cwd, timeout, pre_hook, post_hook, lines}
    返回：{ok, exit_code, duration, timed_out, output, tail, lines, truncated}
    """
    data = request.get_json(silent=True) or {}
    try:
        lines = int(data.get("lines") or 20)
    except (TypeError, ValueError):
        lines = 20
    return jsonify(cronsvc.dry_run(data, max(0, min(lines, 200))))


@bp.route("/api/cron/stop", methods=["POST"])
def api_cron_stop():
    data = request.get_json(silent=True) or {}
    run_id = str(data.get("run_id") or "").strip()
    tid = str(data.get("id") or "").strip()
    res = cronsvc.stop_run(run_id) if run_id else cronsvc.stop_task(tid)
    if res.get("error"):
        return jsonify(res)
    return jsonify({"ok": True})


@bp.route("/api/cron/runs")
def api_cron_runs():
    tid = (request.args.get("task_id") or "").strip()
    try:
        limit = int(request.args.get("limit") or 50)
    except ValueError:
        limit = 50
    runs = crondb.list_runs(tid or None, limit)
    return jsonify({"ok": True, "runs": runs})


@bp.route("/api/cron/log")
def api_cron_log():
    run_id = (request.args.get("run_id") or "").strip()
    try:
        offset = int(request.args.get("offset") or 0)
    except ValueError:
        offset = 0
    res = cronsvc.read_log(run_id, offset)
    if res.get("error"):
        return jsonify(res)
    return jsonify({"ok": True, **res})


@bp.route("/api/cron/notify-log")
def api_cron_notify_log():
    """某一次执行触发的通知记录（读该 run 日志旁的 .notify.json，最新在前）。

    与全局通知历史分开：只包含这一次执行自己发出去（或被跳过）的通知，
    不会混进别的任务 / 测试通知。没有记录时 records 为空数组。
    """
    run_id = (request.args.get("run_id") or "").strip()
    run = crondb.get_run(run_id) if run_id else None
    if not run:
        return jsonify({"ok": False, "error": "执行记录不存在", "records": []})
    recs = cronsvc.read_notify_log(run.get("log_path"))
    recs = sorted(recs, key=lambda r: int(r.get("ts") or 0), reverse=True)
    return jsonify({"ok": True, "records": recs})


@bp.route("/api/cron/clear-runs", methods=["POST"])
def api_cron_clear_runs():
    data = request.get_json(silent=True) or {}
    tid = str(data.get("id") or "").strip()
    if not crondb.get_task(tid):
        return jsonify({"error": "任务不存在"})
    removed = crondb.clear_runs(tid)               # 只清非运行中的记录
    for r in removed:
        cronsvc._remove_log(r.get("log_path"))
    return jsonify({"ok": True, "removed": len(removed)})


@bp.route("/api/cron/validate", methods=["POST"])
def api_cron_validate():
    data = request.get_json(silent=True) or {}
    expr = str(data.get("cron") or "").strip()
    ok, tip = cronutil.validate(expr)
    return jsonify({"ok": ok, "tip": tip, "next": _next_runs(expr, 3) if ok else []})


@bp.route("/api/cron/suggest", methods=["POST"])
def api_cron_suggest():
    """给「从文件新建定时任务」预填内容：按扩展名推断解释器 + 绝对路径 + 工作目录。

    复用运行模块的 _RUNNERS / _project_runtime，所以项目自带 venv、node_modules/.bin
    等「就近运行环境」的判断与 F5 运行完全一致（例如 .py 会用项目里的 .venv/bin/python）。
    """
    from ...services.ide import envprobe
    from . import run as runmod
    data = request.get_json(silent=True) or {}
    path = str(data.get("path") or "").strip()
    if not path or not os.path.isfile(path):
        return jsonify({"error": "文件不存在"})
    path = os.path.abspath(path)
    base = os.path.basename(path)
    stem = os.path.splitext(base)[0] or base
    ext = os.path.splitext(path)[1].lower().lstrip(".")
    cwd = os.path.dirname(path) or "."
    runner = runmod._RUNNERS.get(ext)
    label = ""
    if runner:
        exe, label = runner
        try:
            proj_exe, _prepend, _note = runmod._project_runtime(path, exe)
            interp = proj_exe or envprobe.resolve_exe(exe) or exe
        except Exception:                              # noqa: BLE001
            interp = exe
        command = "%s %s" % (shlex.quote(interp), shlex.quote(path))
    else:                                              # 未知类型：按可执行文件处理
        command = shlex.quote(path)
    return jsonify({"ok": True, "name": stem, "command": command, "cwd": cwd,
                    "runner": label, "ext": ext})


# ---------------------------------------------------------------- 资源监控
@bp.route("/api/cron/monitor")
def api_cron_monitor():
    """系统 CPU / 内存 + 正在运行的定时任务进程占用（供管理页监控条轮询）。"""
    res = cronsvc.monitor()
    return jsonify({"ok": True, **res})


# ---------------------------------------------------------------- 模块设置 / 通知
@bp.route("/api/cron/settings")
def api_cron_settings():
    """读取模块设置：日志清理 + 通知配置（密钥类字段脱敏）。"""
    return jsonify({
        "ok": True,
        "log_days": crondb.get_setting("log_days", 0),
        "keep_runs": crondb.get_setting("keep_runs", 50),
        "notify": cronnotify.sanitize_cfg(),
    })


@bp.route("/api/cron/settings", methods=["POST"])
def api_cron_settings_save():
    """保存模块设置：log_days（日志保留天数，0 不限）/ keep_runs（每任务保留条数）/ notify。"""
    data = request.get_json(silent=True) or {}
    if "log_days" in data:
        try:
            days = max(0, int(data.get("log_days") or 0))
        except (TypeError, ValueError):
            days = 0
        crondb.set_setting("log_days", days)
    if "keep_runs" in data:
        try:
            keep = max(1, int(data.get("keep_runs") or 50))
        except (TypeError, ValueError):
            keep = 50
        crondb.set_setting("keep_runs", keep)
    notify = data.get("notify")
    notify_saved = None
    if isinstance(notify, dict):
        notify_saved = cronnotify.save_cfg(notify)
    return jsonify({"ok": True,
                    "log_days": crondb.get_setting("log_days", 0),
                    "keep_runs": crondb.get_setting("keep_runs", 50),
                    "notify": notify_saved or cronnotify.sanitize_cfg()})


@bp.route("/api/cron/notify-test", methods=["POST"])
def api_cron_notify_test():
    """对指定渠道发一条测试通知（忽略总开关）。channel: desktop/email/dingtalk/telegram/pushplus/all"""
    data = request.get_json(silent=True) or {}
    res = cronnotify.test(data.get("channel") or "all")
    return jsonify({"ok": True, "results": res})


# ---------------------------------------------------------------- AI 生成通知文案
_AI_TPL_SYS = (
    "你是「定时任务执行通知」的文案助手。根据任务信息与脚本输出，写一版简洁、好看、"
    "信息密度高、带 emoji 的通知文案。\n"
    "只输出一个 JSON 对象，不要 markdown 代码块、不要任何解释：\n"
    '{"title": "通知标题", "body": "通知正文"}\n\n'
    "硬性要求：\n"
    "1. 标题不超过 24 个汉字，且必须以 1 个贴切的 emoji 开头（如 📦 🚀 📊 🔔 ✅）；\n"
    "2. 正文 2~4 行、每行不超过 42 个汉字，且**每一行都必须有 emoji**"
    "（放在行首或关键数字前）；全篇用 2~5 个不同 emoji，不要反复用同一个；\n"
    "3. 必须原样保留这些变量占位符，不要替换成具体值："
    "{task} {event} {status} {exit} {duration} {date} {time} {output}；\n"
    "4. 给了「可用输出字段」时，用字段占位符（如 {order_count}）把关键数字写进正文，"
    "让每次执行自动填值；\n"
    "5. 中文；不要编造输出里没有的数据；{output} 可放最后一行（完整输出），"
    "信息已经足够时也可以不放。\n\n"
    "emoji 选型参考：📦 订单/数量、💰 金额/销售额、⚠️ 异常/错误、⏱ 耗时、📅 日期、"
    "🔥 热销/爆款、✅ 成功、❌ 失败、🔔 提醒、📊 统计。\n\n"
    '示例：{"title": "📦 今日订单播报", "body": "任务「{task}」{event}。\\n'
    '📦 订单 {order_count} 单 · ⚠️ 异常 {error_count} 条\\n'
    '💰 销售额 ¥{sales_amount} · 🔥 热销 {hot_product}\\n'
    '⏱ 用时 {duration} · 📅 {date} {time}"}'
)


def _parse_ai_tpl(text):
    """从模型回复里取出 {"title","body"}；容忍代码块包裹与前后多余文字。"""
    d = _parse_ai_obj(text)
    if not d:
        return None
    title = str(d.get("title") or "").strip()
    body = str(d.get("body") or "").strip()
    if title or body:
        return {"title": title[:200], "body": body[:2000]}
    return None


def _parse_ai_obj(text):
    """从模型回复里取出第一个可用 JSON 对象；容忍 ```json 包裹与前后多余文字。"""
    s = str(text or "").strip()
    if not s:
        return None
    s = re.sub(r"^```[A-Za-z]*\s*", "", s)
    s = re.sub(r"\s*```$", "", s).strip()
    cands = [s]
    i, j = s.find("{"), s.rfind("}")
    if 0 <= i < j:
        cands.append(s[i:j + 1])
    for c in cands:
        try:
            d = json.loads(c)
        except Exception:                              # noqa: BLE001
            continue
        if isinstance(d, dict):
            return d
    return None


_AI_DRAFT_SYS = (
    "你是「定时任务配置生成器」。用户会用一句中文描述想要的定时任务，"
    "你要把它翻译成一条可直接保存的定时任务配置。\n"
    "只输出一个 JSON 对象，不要 markdown 代码块、不要任何解释：\n"
    '{"name": "任务名称（不超过 16 字）",\n'
    ' "kind": "command | code | ai",\n'
    ' "lang": "python | node | bash",\n'
    ' "cron": "5 段 cron：分 时 日 月 周",\n'
    ' "content": "kind=code 时是完整可运行代码；kind=ai 时是可直接发给模型的完整提示词；command 时留空",\n'
    ' "command": "kind=command 时是 shell 命令；其余留空",\n'
    ' "cwd": "工作目录，用户没说要就留空",\n'
    ' "timeout": 0,\n'
    ' "notify_content": "status | output | output_only | custom",\n'
    ' "remark": "一句话备注",\n'
    ' "reason": "用一句话说明你为什么这样设"}\n\n'
    "选择规则：\n"
    "1. 需要「讲解 / 学习 / 总结 / 出题 / 写文案 / 给建议」这类靠模型输出内容的需求，用 kind=ai："
    "content 要写成自包含的提示词，指明输出结构与字数，让它每天重复执行也不会重复啰嗦；\n"
    "2. 需要读写文件、调用脚本、抓数据、算指标，用 kind=code（代码要完整、可直接运行，"
    "只用标准库，路径用用户给的或留空）；一次性 shell 动作可用 kind=command；\n"
    "3. 时间：用户没说就默认每天 9 点（0 9 * * *）；说「每早 8 点」→ 0 8 * * *，"
    "「每天 0 点」→ 0 0 * * *，「每周一 9 点」→ 0 9 * * 1；\n"
    "4. 通知：只要结果成败用 status；想把生成内容 / 脚本输出直接推到渠道，用 output_only；"
    "输出是 JSON、想按变量排版才用 custom；\n"
    "5. 不要编造用户没提到的数据、路径、账号；content 里不要写 shell 重定向（输出会被自动记录）。"
)


_EMOJI_RE = re.compile("[\U0001F000-\U0001FAFF\u2600-\u27BF\u2B00-\u2BFF\uFE0F]")
# 没带 emoji 时的兜底：按行内关键词挑一个贴切的
_EMOJI_HINTS = (
    (("订单", "单量", "数量", "件数"), "📦"),
    (("金额", "销售额", "收入", "¥", "￥", "元"), "💰"),
    (("异常", "错误", "失败", "报错", "error"), "⚠️"),
    (("耗时", "用时", "毫秒", "秒"), "⏱"),
    (("热销", "爆款", "热门"), "🔥"),
    (("成功",), "✅"),
    (("任务", "执行"), "📋"),
    (("日期", "时间"), "📅"),
)


def _ensure_emoji(title, body):
    """模型偶尔还是不写 emoji：标题补一个、正文逐行补一个语义相近的（已有就不动）。"""
    t = str(title or "").strip()
    if t and not _EMOJI_RE.search(t):
        t = "🔔 " + t
    rows = []
    for ln in str(body or "").split("\n"):
        s = ln.rstrip()
        if s.strip() and not _EMOJI_RE.search(s):
            low = s.lower()
            icon = "🔹"
            for keys, em in _EMOJI_HINTS:
                if any(k in low for k in keys):
                    icon = em
                    break
            s = icon + " " + s.lstrip()
        rows.append(s)
    return t, "\n".join(rows)


@bp.route("/api/cron/notify-ai", methods=["POST"])
def api_cron_notify_ai():
    """让 AI 根据这次试运行的脚本输出，写一版好看的自定义通知文案。

    入参：{name, command, output, fields, ok, exit, duration, channels}
    返回：{ok, title, body, model} —— 文案里保留 {task} / {order_count} 这类变量占位。
    """
    from .ai import (_brief, _estimate_msgs, _estimate_tokens, _load_cfg, _log_ai_call,
                     _preflight, _sys_err_response, _sys_pick)
    cfg = _load_cfg()
    provider, model, err = _sys_pick(cfg, "cron")     # 系统 AI 里可单独指定/停用「定时任务通知文案」
    if err:
        return _sys_err_response(err, need_config=not cfg.get("providers"))

    data = request.get_json(silent=True) or {}
    name = str(data.get("name") or "").strip() or "（未命名任务）"
    cmd = str(data.get("command") or "").strip()
    output = str(data.get("output") or "").strip()
    fields = data.get("fields") if isinstance(data.get("fields"), dict) else {}
    ok = bool(data.get("ok"))
    code = data.get("exit")
    channels = str(data.get("channels") or "").strip()
    field_txt = "，".join("%s=%s" % (k, str(v)[:40]) for k, v in list(fields.items())[:20]) or "（无）"
    user_text = ("任务名称：%s\n执行命令：%s\n本次试运行：%s（退出码 %s）\n"
                 "可用输出字段：%s\n通知渠道：%s\n\n脚本输出：\n%s") % (
        name, cmd[:500], "成功" if ok else "失败", "无" if code is None else code,
        field_txt, channels or "未指定", output[:4000] or "（无输出）")

    base = provider["base_url"].rstrip("/")
    url = base if base.endswith("/chat/completions") else base + "/chat/completions"
    payload = json.dumps({"model": model, "stream": False, "temperature": 0.7,
                          "messages": [{"role": "system", "content": _AI_TPL_SYS},
                                       {"role": "user", "content": user_text}]}).encode("utf-8")
    t0 = time.time()
    tin = tout = 0
    est = False
    text = ""

    def _fail(msg, resp=""):
        _log_ai_call("cron", False, int((time.time() - t0) * 1000), msg, model, tin, tout,
                     est, req=_brief(user_text), resp=_brief(resp))
        return jsonify({"error": msg})

    try:
        req = urllib.request.Request(url, data=payload, method="POST", headers={
            "Content-Type": "application/json", "Authorization": "Bearer " + provider["api_key"]})
        _preflight(url, 8)                                 # 地址不通时立刻报错，别耗光读超时
        resp = urllib.request.urlopen(req, timeout=60)
        obj = json.loads(resp.read().decode("utf-8", "ignore"))
        text = ((((obj.get("choices") or [{}])[0] or {}).get("message") or {}).get("content") or "")
        usage = obj.get("usage") or {}
        tin, tout = int(usage.get("prompt_tokens") or 0), int(usage.get("completion_tokens") or 0)
        if not (tin or tout):                              # 上游没给用量：按字数兜底估算
            tin = _estimate_msgs([{"role": "system", "content": _AI_TPL_SYS},
                                  {"role": "user", "content": user_text}])
            tout, est = _estimate_tokens(text), True
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "ignore")[:200]
        return _fail("AI 接口返回 %s：%s" % (e.code, detail))
    except Exception as e:                                 # noqa: BLE001
        return _fail("调用 AI 接口失败：%s" % e)

    tpl = _parse_ai_tpl(text)
    if not tpl:
        return _fail("AI 返回的内容不是预期的 JSON，请重试或换个模型", resp=text)
    title, body = _ensure_emoji(tpl["title"], tpl["body"])   # 模型没写 emoji 时兜底补上

    elapsed = int((time.time() - t0) * 1000)
    _log_ai_call("cron", True, elapsed, "", model, tin, tout, est,
                 req=_brief(user_text), resp=_brief(text))
    _log.info("定时任务通知文案生成：model=%s %dms", model, elapsed)
    return jsonify({"ok": True, "title": title, "body": body,
                    "model": model, "elapsed_ms": elapsed})


@bp.route("/api/cron/ai-draft", methods=["POST"])
def api_cron_ai_draft():
    """一句话生成定时任务草稿：AI 直接返回可回填编辑器的字段。

    入参：{desc, cwd}
    返回：{ok, draft:{name, kind, lang, cron, content, command, cwd, timeout,
                     notify_content, remark}, reason, warning, model}
    draft 已经过归一化：类型 / 语言 / cron 不合法会回退到安全值并给出 warning。
    """
    from .ai import (_brief, _estimate_msgs, _estimate_tokens, _load_cfg, _log_ai_call,
                     _preflight, _sys_err_response, _sys_pick)
    cfg = _load_cfg()
    provider, model, err = _sys_pick(cfg, "crongen")   # 系统 AI 里可单独指定 / 停用「定时任务一键生成」
    if err:
        return _sys_err_response(err, need_config=not cfg.get("providers"))

    data = request.get_json(silent=True) or {}
    desc = str(data.get("desc") or "").strip()
    if not desc:
        return jsonify({"error": "请先用一句话描述你想要的任务"})
    desc = desc[:2000]
    default_cwd = str(data.get("cwd") or "").strip()
    user_text = ("需求：%s\n当前工作目录：%s\n现在时间：%s（周%s）" % (
        desc, default_cwd or "（未指定）", time.strftime("%Y-%m-%d %H:%M"),
        "日一二三四五六"[int(time.strftime("%w"))]))

    base = provider["base_url"].rstrip("/")
    url = base if base.endswith("/chat/completions") else base + "/chat/completions"
    payload = json.dumps({"model": model, "stream": False, "temperature": 0.3,
                          "messages": [{"role": "system", "content": _AI_DRAFT_SYS},
                                       {"role": "user", "content": user_text}]}).encode("utf-8")
    t0 = time.time()
    tin = tout = 0
    est = False
    text = ""

    def _fail(msg, resp=""):
        _log_ai_call("crongen", False, int((time.time() - t0) * 1000), msg, model, tin, tout,
                     est, req=_brief(desc), resp=_brief(resp))
        return jsonify({"error": msg})

    try:
        req = urllib.request.Request(url, data=payload, method="POST", headers={
            "Content-Type": "application/json", "Authorization": "Bearer " + provider["api_key"]})
        _preflight(url, 8)                                 # 地址不通时立刻报错，别耗光读超时
        resp = urllib.request.urlopen(req, timeout=90)
        obj = json.loads(resp.read().decode("utf-8", "ignore"))
        text = ((((obj.get("choices") or [{}])[0] or {}).get("message") or {}).get("content") or "")
        usage = obj.get("usage") or {}
        tin, tout = int(usage.get("prompt_tokens") or 0), int(usage.get("completion_tokens") or 0)
        if not (tin or tout):                              # 上游没给用量：按字数兜底估算
            tin = _estimate_msgs([{"role": "system", "content": _AI_DRAFT_SYS},
                                  {"role": "user", "content": user_text}])
            tout, est = _estimate_tokens(text), True
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "ignore")[:200]
        return _fail("AI 接口返回 %s：%s" % (e.code, detail))
    except Exception as e:                                 # noqa: BLE001
        return _fail("调用 AI 接口失败：%s" % e)

    draft = _parse_ai_obj(text)
    if not draft:
        return _fail("AI 返回的内容不是预期的 JSON，请重试或换个模型", resp=text)

    warns = []
    kind = str(draft.get("kind") or "").strip().lower()
    if kind not in crondb.KINDS:
        kind = "ai"
    lang = str(draft.get("lang") or "").strip().lower()
    if lang not in crondb.LANGS:
        lang = "python"
    content = str(draft.get("content") or "").strip()
    command = str(draft.get("command") or "").strip()
    # 类型与内容不匹配时做兜底，别让用户保存一个空任务
    if kind == "code" and not content:
        kind = "command" if command else "ai"
        content = desc if kind == "ai" else ""
    if kind == "command" and not command:
        kind = "ai"
        content = content or desc
    if kind == "ai" and not content:
        content = desc
    expr = str(draft.get("cron") or "").strip()
    ok, tip = cronutil.validate(expr)
    if not ok:
        warns.append("AI 给的时间表达式不合法（%s），已回退为每天 9 点" % (tip or expr))
        expr = "0 9 * * *"
    cwd = str(draft.get("cwd") or "").strip()
    if cwd and not os.path.isdir(cwd):
        warns.append("AI 给的目录 %s 不存在，已改用当前工作目录" % cwd)
        cwd = default_cwd
    elif not cwd:
        cwd = default_cwd
    try:
        timeout = max(0, min(int(draft.get("timeout") or 0), 86400))
    except (TypeError, ValueError):
        timeout = 0
    ncontent = str(draft.get("notify_content") or "").strip().lower()
    if ncontent not in crondb.NOTIFY_MODES:
        # 生成内容 / 代码的任务默认把输出一起推过去，纯命令任务只看成败
        ncontent = "status" if kind == "command" else "output_only"
    name = (str(draft.get("name") or "").strip() or desc[:16])[:40]
    out = {
        "name": name, "kind": kind, "lang": lang, "cron": expr,
        "content": content, "command": command, "cwd": cwd,
        "timeout": timeout, "notify_content": ncontent,
        "remark": str(draft.get("remark") or "").strip()[:200],
    }
    elapsed = int((time.time() - t0) * 1000)
    _log_ai_call("crongen", True, elapsed, "", model, tin, tout, est,
                 req=_brief(desc), resp=_brief(text))
    _log.info("定时任务一键生成：%s（%s/%s）%dms", name, kind, lang, elapsed)
    return jsonify({"ok": True, "draft": out, "model": model,
                    "reason": str(draft.get("reason") or "").strip()[:200],
                    "warning": "；".join(warns), "elapsed_ms": elapsed})


@bp.route("/api/cron/notify-history")
def api_cron_notify_history():
    """定时任务触发的通知记录（按来源过滤，最新在前）；支持关键字搜索与分页。

    run_id / task_id 用于「执行记录 → 通知记录」：只取关联到该次执行 / 该任务的记录。
    """
    from ..common.paginate import paginate_opt
    run_id = (request.args.get("run_id") or "").strip()
    task_id = (request.args.get("task_id") or "").strip()
    recs = cronnotify.history(1000 if request.args.get("page") else 50,
                              run_id=run_id or None, task_id=task_id or None)
    page_items, total = paginate_opt(recs, request)
    if total is None:
        return jsonify({"ok": True, "records": recs,
                        "total": cronnotify.count(run_id=run_id or None,
                                                  task_id=task_id or None)})
    return jsonify({"ok": True, "records": page_items, "total": total})


@bp.route("/api/cron/notify-history", methods=["DELETE"])
def api_cron_notify_history_clear():
    """清空定时任务触发的通知记录。"""
    try:
        n = cronnotify.clear_history()
        return jsonify({"ok": True, "cleared": n})
    except Exception as e:                              # noqa: BLE001
        return jsonify({"ok": False, "error": str(e)}), 400


# ---------------------------------------------------------------- 网页版通知（公开只读页）
@bp.route("/n/<token>")
def cron_web_note_page(token):
    """网页版通知的渲染页：地址里的 token 按任务唯一，无需登录即可查看。

    只展示未过期（且未被假删除）的通知；正文按 Markdown 渲染。
    token 只允许字母数字下划线短横线，避免拼出奇怪的 URL / 注入。
    """
    token = re.sub(r"[^0-9a-zA-Z_-]", "", str(token or ""))[:64]
    notes = crondb.list_web_notes(token, 100) if token else []
    task = crondb.get_task_by_web_token(token) if token else None
    cfg = cronnotify.get_cfg()
    try:
        days = int((cfg.get("web") or {}).get("retention_days") or 7)
    except (TypeError, ValueError):
        days = 7
    # 中文直出（不转义成 \uXXXX）：正文可能很长，转义后体积会膨胀好几倍；
    # < > & 仍转成 \u003c 等，避免正文里的 </script> 提前闭合脚本块。
    notes_json = (json.dumps(notes, ensure_ascii=False)
                  .replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026"))
    return render_template("cron_web_note.html", token=token, notes_json=notes_json,
                           task_name=((task or {}).get("name") or
                                      (notes[0]["task_name"] if notes else "")),
                           retention_days=days, server_now=time.time())


@bp.route("/api/cron/web-link")
def api_cron_web_link():
    """取某个任务的网页通知地址（没有就现生成一个令牌）。"""
    tid = (request.args.get("task_id") or "").strip()
    task = crondb.get_task(tid)
    if not task:
        return jsonify({"error": "任务不存在"})
    cfg = cronnotify.get_cfg()
    token = crondb.ensure_web_token(tid)
    try:
        days = int((cfg.get("web") or {}).get("retention_days") or 7)
    except (TypeError, ValueError):
        days = 7
    return jsonify({"ok": True, "token": token, "url": cronnotify.web_url(token, cfg),
                    "retention_days": days,
                    "enabled": bool((cfg.get("channels") or {}).get("web"))})


# ---------------------------------------------------------------- 备份 / 恢复
@bp.route("/api/cron/backup")
def api_cron_backup():
    """导出全部任务与设置（JSON）。密钥类通知配置已脱敏，可安全保存 / 分享。"""
    return jsonify({
        "ok": True,
        "app": "File_Flask",
        "kind": "cron-backup",
        "version": 1,
        "exported_at": time.time(),
        "tasks": crondb.list_tasks(),
        "settings": {
            "log_days": crondb.get_setting("log_days", 0),
            "keep_runs": crondb.get_setting("keep_runs", 50),
        },
        "notify": cronnotify.sanitize_cfg(),
    })


def _coerce_task(raw):
    """把备份文件里的一条任务整理成合法字段；不合法返回 None。"""
    if not isinstance(raw, dict):
        return None
    name = str(raw.get("name") or "").strip()
    expr = str(raw.get("cron") or "").strip()
    command = str(raw.get("command") or "").strip()
    kind = str(raw.get("kind") or "command").strip().lower()
    if kind not in crondb.KINDS:
        kind = "command"
    lang = str(raw.get("lang") or "python").strip().lower()
    if lang not in crondb.LANGS:
        lang = "python"
    content = str(raw.get("content") or "")
    if not name:
        return None
    if kind == "command" and not command:
        return None
    if kind in ("code", "ai"):
        if not content.strip():
            return None
        command = cronsvc._display_command(kind, "", lang, content)
    ok, _tip = cronutil.validate(expr)
    if not ok:
        return None

    def _int(v, d, lo=0):
        try:
            return max(lo, int(v or 0))
        except (TypeError, ValueError):
            return d

    deps = raw.get("depends_on") or []
    if isinstance(deps, str):
        deps = [s.strip() for s in deps.split(",") if s.strip()]
    return {
        "tid": str(raw.get("id") or "").strip() or None,
        "name": name, "cron": expr, "command": command,
        "kind": kind, "lang": lang, "content": content,
        "ai_sys": str(raw.get("ai_sys") or "").strip()[:4000],
        "cwd": str(raw.get("cwd") or "").strip(),
        "enabled": crondb.as_bool(raw.get("enabled")),
        "remark": str(raw.get("remark") or "").strip(),
        "timeout": _int(raw.get("timeout"), 0),
        "max_retries": _int(raw.get("max_retries"), 0),
        "retry_interval": max(1, _int(raw.get("retry_interval"), 60)),
        "depends_on": ",".join(str(s) for s in deps if str(s).strip()),
        "pre_hook": str(raw.get("pre_hook") or "").strip(),
        "post_hook": str(raw.get("post_hook") or "").strip(),
        "notify": crondb.as_bool(raw.get("notify"), True),
        "notify_content": (str(raw.get("notify_content") or "status").strip().lower()
                           if str(raw.get("notify_content") or "").strip().lower()
                           in crondb.NOTIFY_MODES else "status"),
        "notify_lines": min(200, _int(raw.get("notify_lines"), 20)),
        "notify_title": str(raw.get("notify_title") or "").strip()[:200],
        "notify_body": str(raw.get("notify_body") or "").strip()[:2000],
        "notify_channels": crondb.norm_channels(raw.get("notify_channels")),
    }


@bp.route("/api/cron/restore", methods=["POST"])
def api_cron_restore():
    """从备份 JSON 恢复。mode: merge（默认，保留现有任务）/ replace（先清空再导入）。

    导入时尽量保留原任务 id（未被占用时），这样任务间的依赖关系也能一并恢复。
    """
    data = request.get_json(silent=True) or {}
    tasks = data.get("tasks")
    if not isinstance(tasks, list) or not tasks:
        return jsonify({"error": "备份文件里没有任务数据"})
    mode = data.get("mode") or "merge"
    if mode == "replace":
        for t in crondb.list_tasks():
            tid = t["id"]
            if cronsvc.is_running(tid):
                cronsvc.stop_task(tid)
            cronsvc.cancel_retry(tid)
            for p in crondb.delete_task(tid):
                cronsvc._remove_log(p)
            cronsvc._remove_task_dir(tid)
    existing = {t["id"] for t in crondb.list_tasks()}
    imported, skipped = 0, 0
    for raw in tasks:
        f = _coerce_task(raw)
        if not f:
            skipped += 1
            continue
        tid = None
        if f["tid"] and f["tid"] not in existing:      # 原 id 未被占用：保留（依赖关系随之恢复）
            tid = f["tid"]
            existing.add(tid)
        crondb.create_task(f["name"], f["cron"], f["command"], cwd=f["cwd"],
                           enabled=f["enabled"], remark=f["remark"], timeout=f["timeout"],
                           max_retries=f["max_retries"], retry_interval=f["retry_interval"],
                           depends_on=f["depends_on"], pre_hook=f["pre_hook"],
                           post_hook=f["post_hook"], notify=f["notify"], tid=tid,
                           notify_content=f["notify_content"], notify_lines=f["notify_lines"],
                           notify_title=f["notify_title"], notify_body=f["notify_body"],
                           notify_channels=f["notify_channels"],
                           kind=f["kind"], lang=f["lang"], content=f["content"],
                           ai_sys=f["ai_sys"])
        imported += 1
    st = data.get("settings")
    if isinstance(st, dict):
        for key in ("log_days", "keep_runs"):
            if key in st:
                try:
                    crondb.set_setting(key, max(0, int(st[key] or 0)))
                except (TypeError, ValueError):
                    pass
    _log.info("定时任务备份恢复完成：导入 %d 个任务，跳过 %d 条（%s）", imported, skipped, mode)
    return jsonify({"ok": True, "imported": imported, "skipped": skipped, "mode": mode})

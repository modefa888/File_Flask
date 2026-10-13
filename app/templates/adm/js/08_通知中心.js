/* 后台管理：通知中心（Tab 分区配置）。
 * 分区：基础设置 / 桌面通知 / 邮件(SMTP) / Telegram / 定时任务通知 / 通知历史
 * 数据来源：/api/ai/notify（全局通知）、/api/cron/settings 与 /api/cron/notify-history（定时任务通知）
 */
ADM.modules.push({
    id: 'notify',
    name: '通知中心',
    subtitle: '通知 / 邮件 / Telegram / 定时任务通知',
    icon: 'bi-bell',
    async load(el) {
        el.innerHTML = ADM.loading('加载通知配置…');
        await refreshNotify(el);
    }
});

var NOTIFY = { global: null, cron: null, cronRecords: [], cronTotal: null };

/* ---------------- 表单小工具 ---------------- */
function nfVal(el, name) {
    var i = el.querySelector('[name="' + name + '"]');
    return i ? i.value : '';
}
function nfChk(el, id) {
    var i = el.querySelector('#' + id);
    return !!(i && i.checked);
}
function nfSw(id, label, checked) {
    return '<label class="adm-switch" style="margin-bottom:12px"><input type="checkbox" id="' + id + '"' +
        (checked ? ' checked' : '') + '> ' + ADM.esc(label) + '</label>';
}
function nfSub(text) {
    return '<div class="adm-subhead">' + ADM.esc(text) + '</div>';
}
function nfBtn(label, attr, value, primary) {
    return '<button class="adm-btn' + (primary ? ' primary' : '') + '" type="button" ' + attr + '="' + value + '">' +
        ADM.esc(label) + '</button>';
}

/* ---------------- 通知模板：预设 / 效果预览 / 变量（与 IDE 设置页一致） ---------------- */
var NF_AI_PRESETS = [
    { id: 'standard', name: '标准', icon: 'bi-check2-circle', desc: '标题带任务名 + 一行摘要', title: '{task} · 回复完成', body: '任务已完成：{summary}' },
    { id: 'minimal', name: '极简', icon: 'bi-dash-circle', desc: '只有任务名和摘要', title: '{task} · 完成', body: '{summary}' },
    { id: 'qa', name: '问答对照', icon: 'bi-chat-left-quote', desc: '保留提问 + 回复', title: '{task} · 回复完成', body: '问：{query}\n答：{summary}' },
    { id: 'report', name: '结构化报告', icon: 'bi-clipboard-data', desc: '带时间与字数，适合邮件 / Telegram 归档', title: '📬 {task} · {time}', body: '🕒 {date} {time}\n❓ 任务：{query}\n💬 回复：{summary}\n📏 字数：{answer_len}' },
    { id: 'plain', name: '纯文本', icon: 'bi-fonts', desc: '无表情符号，兼容老系统', title: '{task} 任务完成', body: '{query}\n\n{summary}' }
];
var NF_AI_VARS = [
    { key: 'task', desc: '任务名：AI 助手 / AI 智能体' },
    { key: 'query', desc: '提问 / 任务描述（过长自动截断）' },
    { key: 'summary', desc: '回复摘要（过长自动截断，默认 120 字）' },
    { key: 'answer_len', desc: '回复字数（不计空白）' },
    { key: 'time', desc: '触发时间，如 14:32' },
    { key: 'date', desc: '触发日期' },
    { key: 'answer', desc: '回复全文（不截断）' },
    { key: 'title', desc: '通道默认标题' },
    { key: 'channel', desc: 'chat / agent' }
];
var NF_CRON_PRESETS = [
    { id: 'std', name: '标准', icon: 'bi-check2-circle', desc: '标题带事件 + 任务名，正文分行列详情', title: '定时任务{event} · {task}', body: '任务「{task}」{event}。\n退出码：{exit}\n耗时：{duration}\n时间：{date} {time}\n执行记录：{run}' },
    { id: 'simple', name: '极简', icon: 'bi-circle', desc: '一行摘要，适合一扫而过', title: '⏰ {task} {event}', body: '{task} {event}（退出码 {exit}，耗时 {duration}）· {date} {time}' },
    { id: 'alert', name: '运维告警', icon: 'bi-exclamation-triangle', desc: '带 🚨 前缀与结构化字段，适合钉钉群', title: '🚨 定时任务{event}：{task}', body: '任务：{task}\n事件：{event}\n退出码：{exit}\n耗时：{duration}\n重试：{attempt}\n时间：{date} {time}\n执行记录：{run}' },
    { id: 'plain', name: '纯文本', icon: 'bi-fonts', desc: '无表情符号，兼容老系统', title: '[定时任务] {task} {event}', body: '{task} 于 {date} {time} {event}，退出码 {exit}，耗时 {duration}。执行记录 {run}。' }
];
var NF_CRON_VARS = [
    { key: 'task', desc: '任务名称' },
    { key: 'event', desc: '事件：执行失败 / 执行超时 / 安排重试 / 执行成功' },
    { key: 'exit', desc: '退出码' },
    { key: 'duration', desc: '耗时（如 3.2s）' },
    { key: 'attempt', desc: '重试进度（如 第 1/3 次；非重试为空）' },
    { key: 'run', desc: '执行记录 ID' },
    { key: 'date', desc: '触发日期 YYYY-MM-DD' },
    { key: 'time', desc: '触发时间 HH:MM' }
];
/* 标题 / 正文都清空时，后端用系统默认文案；cron 预览也按这份默认来 */
var NF_CRON_TPL_DEFAULT = NF_CRON_PRESETS[0];

function nfTplSubVars(tpl, vars) {
    return String(tpl == null ? '' : tpl).replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, function (m, key) {
        return Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : m;
    });
}
function nfTplClip(s, n) {
    s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    if (n && s.length > n) return s.slice(0, n).replace(/\s+$/, '') + '…';
    return s;
}
function nfTplField(el, name) {
    var i = el.querySelector('[name="' + name + '"]');
    return i ? i.value : '';
}
function nfAiPreviewVars() {
    return {
        task: 'AI 助手', channel: 'chat', title: 'AI 助手 · 回复完成',
        query: nfTplClip('把 app.js 里的 fetch 请求都改成 axios，并补上错误处理', 60),
        summary: nfTplClip('已替换 app.js 中 3 处 fetch 调用为 axios，并统一了 try/catch 与失败提示。', 120),
        answer: '已替换 app.js 中 3 处 fetch 调用为 axios，并统一了 try/catch 与失败提示。',
        answer_len: '48', time: '14:32', date: '2026-10-04'
    };
}
function nfCronPreviewVars() {
    var d = new Date(), p2 = function (n) { return String(n).padStart(2, '0'); };
    return {
        task: '每日备份', event: '执行失败', exit: '1', duration: '3.2s',
        attempt: '', run: 'ab12cd34ef',
        date: d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()),
        time: p2(d.getHours()) + ':' + p2(d.getMinutes())
    };
}
function nfTplPresetRow(presets, attr) {
    return '<div class="adm-preset-row"><span class="adm-preset-label">快速模板</span>' +
        '<div style="display:flex;flex-wrap:wrap;gap:6px">' +
        presets.map(function (p) {
            return '<button type="button" class="adm-btn sm preset" ' + attr + '="' + p.id + '" title="' + ADM.esc(p.desc || '') + '">' +
                '<i class="bi ' + p.icon + '"></i> ' + ADM.esc(p.name) + '</button>';
        }).join('') + '</div></div>';
}
function nfTplPreview(idp) {
    return '<div class="adm-tpl-preview">' +
        '<div class="adm-tpl-preview-head"><span><i class="bi bi-eye"></i> 效果预览</span>' +
        '<span class="adm-tpl-tag">示例数据</span></div>' +
        '<div class="adm-tpl-card"><div class="adm-tpl-app"><i class="bi bi-bell-fill"></i> File_Flask<span>刚刚</span></div>' +
        '<div class="adm-tpl-title" id="' + idp + 'PrevTitle">—</div>' +
        '<div class="adm-tpl-body" id="' + idp + 'PrevBody">—</div></div></div>';
}
function nfTplVarChips(vars, attr) {
    return '<div class="adm-var-row"><span class="adm-vars-tip">可用变量（点击插入）</span>' +
        vars.map(function (x) {
            return '<button type="button" class="adm-var" ' + attr + '="' + x.key + '" title="' + ADM.esc(x.desc) + '">{'+ x.key + '}</button>';
        }).join('') + '</div>';
}

function nfAiPreviewRefresh(el) {
    var tOut = el.querySelector('#nfAiPrevTitle'), bOut = el.querySelector('#nfAiPrevBody');
    if (!tOut || !bOut) return;
    var vars = nfAiPreviewVars();
    var title = nfTplField(el, 'nf_chat'), agent = nfTplField(el, 'nf_agent'), body = nfTplField(el, 'nf_body');
    tOut.textContent = nfTplSubVars(title, vars).trim() || '（标题为空）';
    bOut.textContent = nfTplSubVars(body, vars).trim() || '（正文为空）';
    el.querySelectorAll('[data-nfpreset]').forEach(function (b) {
        var p = NF_AI_PRESETS.filter(function (x) { return x.id === b.dataset.nfpreset; })[0];
        b.classList.toggle('active', !!p && p.title === title.trim() && p.body === body.trim() &&
            (!agent.trim() || agent.trim() === p.title));
    });
}
function nfCronPreviewRefresh(el) {
    var tOut = el.querySelector('#nfCronPrevTitle'), bOut = el.querySelector('#nfCronPrevBody');
    if (!tOut || !bOut) return;
    var vars = nfCronPreviewVars();
    var title = nfTplField(el, 'cn_tpl_title').trim() || NF_CRON_TPL_DEFAULT.title;
    var body = nfTplField(el, 'cn_tpl_body').trim() || NF_CRON_TPL_DEFAULT.body;
    tOut.textContent = nfTplSubVars(title, vars);
    bOut.textContent = nfTplSubVars(body, vars);
    el.querySelectorAll('[data-cpreset]').forEach(function (b) {
        var p = NF_CRON_PRESETS.filter(function (x) { return x.id === b.dataset.cpreset; })[0];
        b.classList.toggle('active', !!p && p.title === title && p.body === body);
    });
}
function nfAiApplyPreset(el, id) {
    var p = NF_AI_PRESETS.filter(function (x) { return x.id === id; })[0];
    if (!p) return;
    ['nf_chat', 'nf_agent'].forEach(function (n) {
        var i = el.querySelector('[name="' + n + '"]'); if (i) i.value = p.title;
    });
    var b = el.querySelector('[name="nf_body"]'); if (b) b.value = p.body;
    nfAiPreviewRefresh(el);
}
function nfCronApplyPreset(el, id) {
    var p = NF_CRON_PRESETS.filter(function (x) { return x.id === id; })[0];
    if (!p) return;
    var t = el.querySelector('[name="cn_tpl_title"]'); if (t) t.value = p.title;
    var b = el.querySelector('[name="cn_tpl_body"]'); if (b) b.value = p.body;
    nfCronPreviewRefresh(el);
}
/* 点变量胶囊 → 插入到最后聚焦的模板输入框光标处 */
function nfTplInsertVar(el, field, fallbackName, key, refresh) {
    var target = (field && el.contains(field)) ? field : el.querySelector('[name="' + fallbackName + '"]');
    if (!target) return;
    var v = '{' + key + '}';
    var start = typeof target.selectionStart === 'number' ? target.selectionStart : target.value.length;
    var end = typeof target.selectionEnd === 'number' ? target.selectionEnd : target.value.length;
    target.value = target.value.slice(0, start) + v + target.value.slice(end);
    try { target.focus(); target.setSelectionRange(start + v.length, start + v.length); } catch (_) {}
    refresh(el);
}

async function refreshNotify(el) {
    var g = await ADM.api('/api/ai/notify');
    var cr = await ADM.api('/api/cron/settings');
    var rec = await ADM.api('/api/cron/notify-history');
    NOTIFY.global = g;
    NOTIFY.cron = cr;
    NOTIFY.cronRecords = (rec && rec.records) || [];
    NOTIFY.cronTotal = (rec && rec.total != null) ? rec.total : NOTIFY.cronRecords.length;
    renderNotify(el);
}

function notifyHistoryCols() {
    return [
        { label: '来源', render: function (r) { return ADM.badge(r.kind || r.source || '-', 'info'); } },
        { label: '标题', render: function (r) { return ADM.esc(r.title || '-'); } },
        { label: '正文', render: function (r) { return '<span class="adm-cell-mono" title="' + ADM.esc(r.body) + '">' + ADM.esc(r.body || '') + '</span>'; } },
        {
            label: '通道', render: function (r) {
                var chans = r.channels || {}, out = [];
                Object.keys(chans).forEach(function (k) { out.push((chans[k].ok ? '✅ ' : '❌ ') + k); });
                return ADM.esc(out.join('  ') || '-');
            }
        },
        { label: '时间', render: function (r) { return ADM.dt(r.ts); } }
    ];
}

function renderNotify(el) {
    var g = NOTIFY.global || {}, cfg = g.cfg || {};
    var ch = cfg.channels || {}, smtp = cfg.smtp || {}, tg = cfg.telegram || {};
    var desk = cfg.desktop || {}, tpl = cfg.template || {};

    var cr = (NOTIFY.cron && NOTIFY.cron.notify) || {};
    var cev = cr.events || {}, cch = cr.channels || {};
    var cdesk = cr.desktop || {}, cmail = cr.email || {}, ctg = cr.telegram || {};
    var cding = cr.dingtalk || {}, cpp = cr.pushplus || {}, ctpl = cr.template || {};

    /* ---- 1. 基础设置 ---- */
    var basic =
        nfSw('nfEnabled', '启用通知', cfg.enabled) +
        ADM.fieldHtml({
            name: 'nf_scope', label: '通知范围', type: 'select', value: cfg.scope || 'both', options: [
                { value: 'both', label: '全部（AI 助手 + 智能体）' },
                { value: 'chat', label: '仅 AI 助手对话' },
                { value: 'agent', label: '仅 AI 智能体任务' }
            ]
        }) +
        nfSub('通知模板') +
        nfTplPresetRow(NF_AI_PRESETS, 'data-nfpreset') +
        '<div class="adm-hint" style="margin-bottom:8px">点一下同时套用标题 + 正文，预览即时生效；套用后仍可自由修改。</div>' +
        nfTplPreview('nfAi') +
        ADM.fieldHtml({ name: 'nf_chat', label: 'AI 助手对话标题', value: (tpl.chat || '') }) +
        ADM.fieldHtml({ name: 'nf_agent', label: 'AI 智能体任务标题', value: (tpl.agent || '') }) +
        nfTplVarChips(NF_AI_VARS, 'data-nfvar') +
        ADM.fieldHtml({
            name: 'nf_body', label: '正文模板', type: 'textarea', value: cfg.template_body || '',
            hint: '支持换行；钉钉 / PushPlus 等渠道按纯文本发送。'
        }) +
        ADM.fieldHtml({ name: 'nf_summary', label: '回复摘要截断字数', type: 'number', value: cfg.summary_max_chars || 0 }) +
        ADM.fieldHtml({ name: 'nf_query', label: '提问截断字数', type: 'number', value: cfg.query_max_chars || 0 }) +
        '<div class="adm-btn-row">' + nfBtn('保存基础设置', 'data-nsave', 'basic', true) +
        nfBtn('测试桌面通知', 'data-ntest', 'desktop') + nfBtn('测试全部', 'data-ntest', 'all') + '</div>';

    /* ---- 2. 桌面通知 ---- */
    var desktop =
        nfSw('nf_desktop', '启用桌面通知（在服务器本机弹出）', ch.desktop) +
        ADM.fieldHtml({ name: 'nf_app', label: '通知应用名', value: desk.app_name || 'File_Flask' }) +
        nfSw('nf_sound', '播放提示音', desk.sound !== false) +
        ADM.fieldHtml({ name: 'nf_soundname', label: '提示音名称', value: desk.sound_name || '', hint: '留空 = 系统默认（Windows 如 SystemExclamation / macOS 如 Glass）' }) +
        ADM.fieldHtml({ name: 'nf_timeout', label: '显示时长（毫秒）', type: 'number', value: desk.timeout_ms || 5000 }) +
        '<div class="adm-btn-row">' + nfBtn('保存桌面通知', 'data-nsave', 'desktop', true) +
        nfBtn('测试桌面通知', 'data-ntest', 'desktop') + '</div>' +
        '<div class="adm-hint" style="margin-top:10px">桌面通知在「跑本服务的这台机器」上弹出（Windows / macOS / Linux 均已适配，通知不可用时回退为浏览器页面提示）。</div>';

    /* ---- 3. 邮件 SMTP ---- */
    var email =
        nfSw('nf_smtp', '启用邮件通知', ch.smtp) +
        ADM.fieldHtml({ name: 'nf_smtp_host', label: 'SMTP 服务器', value: smtp.host || '', placeholder: 'smtp.example.com' }) +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">' +
        ADM.fieldHtml({ name: 'nf_smtp_port', label: '端口', type: 'number', value: smtp.port || 465 }) +
        ADM.fieldHtml({
            name: 'nf_smtp_sec', label: '加密方式', type: 'select', value: smtp.security || 'ssl', options: [
                { value: 'ssl', label: 'SSL' }, { value: 'tls', label: 'STARTTLS' }, { value: 'none', label: '不加密' }
            ]
        }) + '</div>' +
        ADM.fieldHtml({ name: 'nf_smtp_user', label: '账号', value: smtp.username || '' }) +
        ADM.fieldHtml({ name: 'nf_smtp_pwd', label: '授权码 / 密码', value: smtp.password || '', hint: '保持原样 = 不修改' }) +
        ADM.fieldHtml({ name: 'nf_smtp_from', label: '发件人地址', value: smtp.from_addr || '', hint: '留空 = 使用账号' }) +
        ADM.fieldHtml({ name: 'nf_smtp_to', label: '收件人', value: smtp.to || '', placeholder: '多个用逗号分隔' }) +
        ADM.fieldHtml({ name: 'nf_smtp_prefix', label: '邮件主题前缀', value: smtp.subject_prefix || '' }) +
        '<div class="adm-btn-row">' + nfBtn('保存邮件配置', 'data-nsave', 'email', true) +
        nfBtn('测试邮件', 'data-ntest', 'email') + '</div>';

    /* ---- 4. Telegram ---- */
    var telegram =
        nfSw('nf_tg', '启用 Telegram 通知', ch.telegram) +
        ADM.fieldHtml({ name: 'nf_tg_token', label: 'Bot Token', value: tg.bot_token || '', hint: '保持原样 = 不修改' }) +
        ADM.fieldHtml({ name: 'nf_tg_chat', label: 'Chat ID', value: tg.chat_id || '' }) +
        ADM.fieldHtml({ name: 'nf_tg_thread', label: '话题 ID', value: tg.message_thread_id || '', hint: '群组「话题」模式下填写，可留空' }) +
        nfSw('nf_tg_silent', '静默发送（不响铃）', tg.disable_notification) +
        ADM.fieldHtml({ name: 'nf_tg_api', label: 'API 地址', value: tg.api_base || 'https://api.telegram.org' }) +
        ADM.fieldHtml({ name: 'nf_tg_proxy', label: '专属代理', value: tg.proxy || '', placeholder: '如 http://127.0.0.1:7890' }) +
        '<div class="adm-btn-row">' + nfBtn('保存 Telegram', 'data-nsave', 'tg', true) +
        nfBtn('测试 Telegram', 'data-ntest', 'telegram') + '</div>';

    /* ---- 5. 定时任务通知（内部用子 Tab 分组配置） ---- */
    var cronRecs = NOTIFY.cronRecords || [];
    var cronTab =
        ADM.tabs([
            {
                id: 'base', name: '基础', icon: 'bi-sliders',
                content:
                    nfSw('cn_enabled', '启用定时任务通知', cr.enabled) +
                    nfSub('触发事件') +
                    '<div style="display:flex;flex-wrap:wrap;gap:18px;margin-bottom:6px">' +
                    '<label class="adm-switch"><input type="checkbox" id="cn_ev_fail"' + (cev.fail ? ' checked' : '') + '> 执行失败</label>' +
                    '<label class="adm-switch"><input type="checkbox" id="cn_ev_timeout"' + (cev.timeout ? ' checked' : '') + '> 执行超时</label>' +
                    '<label class="adm-switch"><input type="checkbox" id="cn_ev_retry"' + (cev.retry ? ' checked' : '') + '> 安排重试</label>' +
                    '<label class="adm-switch"><input type="checkbox" id="cn_ev_success"' + (cev.success ? ' checked' : '') + '> 执行成功</label>' +
                    '</div>' +
                    nfSub('通知渠道') +
                    '<div style="display:flex;flex-wrap:wrap;gap:18px;margin-bottom:6px">' +
                    '<label class="adm-switch"><input type="checkbox" id="cn_ch_desktop"' + (cch.desktop ? ' checked' : '') + '> 桌面通知</label>' +
                    '<label class="adm-switch"><input type="checkbox" id="cn_ch_email"' + (cch.email ? ' checked' : '') + '> 邮件</label>' +
                    '<label class="adm-switch"><input type="checkbox" id="cn_ch_dingtalk"' + (cch.dingtalk ? ' checked' : '') + '> 钉钉机器人</label>' +
                    '<label class="adm-switch"><input type="checkbox" id="cn_ch_telegram"' + (cch.telegram ? ' checked' : '') + '> Telegram</label>' +
                    '<label class="adm-switch"><input type="checkbox" id="cn_ch_pushplus"' + (cch.pushplus ? ' checked' : '') + '> PushPlus（微信）</label>' +
                    '</div>' +
                    nfSub('通知模板') +
                    nfTplPresetRow(NF_CRON_PRESETS, 'data-cpreset') +
                    '<div class="adm-hint" style="margin-bottom:8px">点一下同时套用标题 + 正文，预览即时生效；清空两个字段则使用系统默认文案。</div>' +
                    nfTplPreview('nfCron') +
                    ADM.fieldHtml({ name: 'cn_tpl_title', label: '标题模板', value: ctpl.title || '' }) +
                    nfTplVarChips(NF_CRON_VARS, 'data-cvar') +
                    ADM.fieldHtml({ name: 'cn_tpl_body', label: '正文模板', type: 'textarea', value: ctpl.body || '', hint: '支持换行；钉钉 / PushPlus 等渠道按纯文本发送。' })
            },
            {
                id: 'desk', name: '桌面', icon: 'bi-display',
                content:
                    nfSub('桌面通知（本模块独立配置）') +
                    nfSw('cn_desk_global', '复用「基础设置」的桌面配置', cdesk.use_global !== false) +
                    ADM.fieldHtml({ name: 'cn_desk_app', label: '应用名', value: cdesk.app_name || '', hint: '留空 = File_Flask' }) +
                    nfSw('cn_desk_sound', '播放提示音', cdesk.sound !== false)
            },
            {
                id: 'mail', name: '邮件', icon: 'bi-envelope-at',
                content:
                    nfSub('邮件（本模块独立配置）') +
                    nfSw('cn_mail_global', '复用上面的 SMTP 配置', cmail.use_global !== false) +
                    ADM.fieldHtml({ name: 'cn_mail_host', label: 'SMTP 服务器', value: cmail.host || '' }) +
                    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">' +
                    ADM.fieldHtml({ name: 'cn_mail_port', label: '端口', type: 'number', value: cmail.port || 465 }) +
                    ADM.fieldHtml({
                        name: 'cn_mail_sec', label: '加密方式', type: 'select', value: cmail.security || 'ssl', options: [
                            { value: 'ssl', label: 'SSL' }, { value: 'tls', label: 'STARTTLS' }, { value: 'none', label: '不加密' }
                        ]
                    }) + '</div>' +
                    ADM.fieldHtml({ name: 'cn_mail_user', label: '账号', value: cmail.username || '' }) +
                    ADM.fieldHtml({ name: 'cn_mail_pwd', label: '授权码 / 密码', value: cmail.password || '', hint: '保持原样 = 不修改' }) +
                    ADM.fieldHtml({ name: 'cn_mail_from', label: '发件人地址', value: cmail.from_addr || '' }) +
                    ADM.fieldHtml({ name: 'cn_mail_to', label: '收件人', value: cmail.to || '' })
            },
            {
                id: 'tg', name: 'Telegram', icon: 'bi-send',
                content:
                    nfSub('Telegram（本模块独立配置）') +
                    nfSw('cn_tg_global', '复用上面的 Bot 配置', ctg.use_global !== false) +
                    ADM.fieldHtml({ name: 'cn_tg_token', label: 'Bot Token', value: ctg.bot_token || '', hint: '保持原样 = 不修改' }) +
                    ADM.fieldHtml({ name: 'cn_tg_chat', label: 'Chat ID', value: ctg.chat_id || '' }) +
                    ADM.fieldHtml({ name: 'cn_tg_api', label: 'API 地址', value: ctg.api_base || 'https://api.telegram.org' }) +
                    ADM.fieldHtml({ name: 'cn_tg_proxy', label: '代理', value: ctg.proxy || '' })
            },
            {
                id: 'ding', name: '钉钉', icon: 'bi-chat-dots',
                content:
                    nfSub('钉钉群机器人') +
                    ADM.fieldHtml({ name: 'cn_ding_webhook', label: 'Webhook 地址', value: cding.webhook || '', hint: '保持原样 = 不修改' }) +
                    ADM.fieldHtml({ name: 'cn_ding_secret', label: '加签密钥', value: cding.secret || '', hint: 'SEC 开头；留空 = 不加签' })
            },
            {
                id: 'pp', name: 'PushPlus', icon: 'bi-wechat',
                content:
                    nfSub('PushPlus（微信推送）') +
                    ADM.fieldHtml({ name: 'cn_pp_token', label: 'Token', value: cpp.token || '', hint: 'www.pushplus.plus 的推送 token；保持原样 = 不修改' }) +
                    ADM.fieldHtml({ name: 'cn_pp_topic', label: '群组编码', value: cpp.topic || '', hint: '留空 = 发给自己' })
            }
        ], { key: 'cron-notify-tabs' }) +
        '<div class="adm-btn-row" style="margin-top:12px">' + nfBtn('保存定时任务通知', 'data-csave', '1', true) + '</div>' +
        '<div class="adm-btn-row" style="margin:10px 0 4px">' +
        nfBtn('测试全部', 'data-ctest', 'all') + nfBtn('桌面', 'data-ctest', 'desktop') +
        nfBtn('邮件', 'data-ctest', 'email') + nfBtn('Telegram', 'data-ctest', 'telegram') +
        nfBtn('钉钉', 'data-ctest', 'dingtalk') + nfBtn('PushPlus', 'data-ctest', 'pushplus') + '</div>';

    /* ---- 6. 通知历史（内部再用 Tab 区分两类记录，均为服务端搜索 + 分页） ---- */
    var history =
        ADM.tabs([
            {
                id: 'ai', name: 'AI 助手 / 智能体', icon: 'bi-robot',
                content: '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">' +
                    '<div class="adm-hint">AI 助手 / 智能体触发的通知记录</div>' +
                    nfBtn('清空通知历史', 'data-nclear', '1', false) + '</div>' +
                    ADM.servTable(notifyHistoryCols(), {
                        key: 'notify-history',
                        fetch: function (p) {
                            return ADM.api('/api/ai/notify/history?q=' + encodeURIComponent(p.q) +
                                '&page=' + p.page + '&page_size=' + p.size);
                        }
                    })
            },
            {
                id: 'cron', name: '定时任务通知', icon: 'bi-clock-history',
                content: '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">' +
                    '<div class="adm-hint">定时任务失败 / 超时 / 重试等触发的通知记录</div>' +
                    nfBtn('清空通知历史', 'data-ncclear', '1', false) + '</div>' +
                    ADM.servTable(notifyHistoryCols(), {
                        key: 'cron-notify-history',
                        itemsKey: 'records', totalKey: 'total',
                        fetch: function (p) {
                            return ADM.api('/api/cron/notify-history?q=' + encodeURIComponent(p.q) +
                                '&page=' + p.page + '&page_size=' + p.size);
                        }
                    })
            }
        ], { key: 'notify-history-tabs' });

    var html = ADM.tabs([
        { id: 'basic', name: '基础设置', icon: 'bi-sliders', content: basic },
        { id: 'desktop', name: '桌面通知', icon: 'bi-display', content: desktop },
        { id: 'email', name: '邮件 (SMTP)', icon: 'bi-envelope-at', content: email },
        { id: 'telegram', name: 'Telegram', icon: 'bi-send', content: telegram },
        { id: 'cron', name: '定时任务通知', icon: 'bi-clock-history', content: cronTab },
        { id: 'history', name: '通知历史', icon: 'bi-list-ul', content: history }
    ], { key: 'notify-tabs' });

    el.innerHTML = html;
    ADM.mountServTables(el);
    ADM.mountTables(el);
    ADM.mountTabs(el);
    bindNotify(el);
}

/* ---------------- 事件绑定 ---------------- */
function bindNotify(el) {
    el.querySelectorAll('[data-nsave]').forEach(function (b) {
        b.addEventListener('click', function () { saveGlobalSection(el, b.dataset.nsave, b); });
    });
    el.querySelectorAll('[data-ntest]').forEach(function (b) {
        b.addEventListener('click', function () { testGlobal(el, b.dataset.ntest, b); });
    });
    el.querySelectorAll('[data-csave]').forEach(function (b) {
        b.addEventListener('click', function () { saveCronNotify(el, b); });
    });
    el.querySelectorAll('[data-ctest]').forEach(function (b) {
        b.addEventListener('click', function () { testCron(el, b.dataset.ctest, b); });
    });
    el.querySelectorAll('[data-nclear]').forEach(function (b) {
        b.addEventListener('click', async function () {
            var ok = await ADM.confirm('清空通知历史', '确认清空全部通知历史记录？', '清空');
            if (!ok) return;
            await ADM.api('/api/ai/notify/history', { method: 'DELETE' });
            ADM.toast('已清空', 'ok');
            await refreshNotify(el);
        });
    });
    el.querySelectorAll('[data-ncclear]').forEach(function (b) {
        b.addEventListener('click', async function () {
            var ok = await ADM.confirm('清空通知历史', '确认清空定时任务通知记录？', '清空');
            if (!ok) return;
            await ADM.api('/api/cron/notify-history', { method: 'DELETE' });
            ADM.toast('已清空', 'ok');
            await refreshNotify(el);
        });
    });

    /* ---- 通知模板：快速预设 / 变量胶囊 / 效果预览 ---- */
    /* AI 通知模板（基础设置） */
    var aiFields = ['nf_chat', 'nf_agent', 'nf_body'].map(function (n) {
        return el.querySelector('[name="' + n + '"]');
    }).filter(Boolean);
    aiFields.forEach(function (i) {
        i.addEventListener('focus', function () { el._nfLastAi = i; });
        i.addEventListener('input', function () { nfAiPreviewRefresh(el); });
    });
    el.querySelectorAll('[data-nfpreset]').forEach(function (b) {
        b.addEventListener('click', function () { nfAiApplyPreset(el, b.dataset.nfpreset); });
    });
    el.querySelectorAll('[data-nfvar]').forEach(function (b) {
        b.addEventListener('click', function () {
            nfTplInsertVar(el, el._nfLastAi, 'nf_body', b.dataset.nfvar, nfAiPreviewRefresh);
        });
    });

    /* 定时任务通知模板 */
    var cronTplFields = ['cn_tpl_title', 'cn_tpl_body'].map(function (n) {
        return el.querySelector('[name="' + n + '"]');
    }).filter(Boolean);
    cronTplFields.forEach(function (i) {
        i.addEventListener('focus', function () { el._nfLastCron = i; });
        i.addEventListener('input', function () { nfCronPreviewRefresh(el); });
    });
    el.querySelectorAll('[data-cpreset]').forEach(function (b) {
        b.addEventListener('click', function () { nfCronApplyPreset(el, b.dataset.cpreset); });
    });
    el.querySelectorAll('[data-cvar]').forEach(function (b) {
        b.addEventListener('click', function () {
            nfTplInsertVar(el, el._nfLastCron, 'cn_tpl_body', b.dataset.cvar, nfCronPreviewRefresh);
        });
    });

    /* 初始预览 */
    nfAiPreviewRefresh(el);
    nfCronPreviewRefresh(el);
}

async function saveGlobalSection(el, section, btn) {
    var body;
    if (section === 'basic') {
        body = {
            enabled: nfChk(el, 'nfEnabled'),
            scope: nfVal(el, 'nf_scope'),
            template_body: nfVal(el, 'nf_body'),
            summary_max_chars: Number(nfVal(el, 'nf_summary') || 0),
            query_max_chars: Number(nfVal(el, 'nf_query') || 0),
            template: { chat: nfVal(el, 'nf_chat'), agent: nfVal(el, 'nf_agent') }
        };
    } else if (section === 'desktop') {
        body = {
            channels: { desktop: nfChk(el, 'nf_desktop') },
            desktop: {
                app_name: nfVal(el, 'nf_app'),
                sound: nfChk(el, 'nf_sound'),
                sound_name: nfVal(el, 'nf_soundname'),
                timeout_ms: Number(nfVal(el, 'nf_timeout') || 5000)
            }
        };
    } else if (section === 'email') {
        body = {
            channels: { smtp: nfChk(el, 'nf_smtp') },
            smtp: {
                host: nfVal(el, 'nf_smtp_host'),
                port: Number(nfVal(el, 'nf_smtp_port') || 465),
                security: nfVal(el, 'nf_smtp_sec'),
                username: nfVal(el, 'nf_smtp_user'),
                from_addr: nfVal(el, 'nf_smtp_from'),
                to: nfVal(el, 'nf_smtp_to'),
                subject_prefix: nfVal(el, 'nf_smtp_prefix')
            }
        };
        var pwd = nfVal(el, 'nf_smtp_pwd');
        if (pwd) body.smtp.password = pwd;
    } else if (section === 'tg') {
        body = {
            channels: { telegram: nfChk(el, 'nf_tg') },
            telegram: {
                chat_id: nfVal(el, 'nf_tg_chat'),
                message_thread_id: nfVal(el, 'nf_tg_thread'),
                disable_notification: nfChk(el, 'nf_tg_silent'),
                api_base: nfVal(el, 'nf_tg_api'),
                proxy: nfVal(el, 'nf_tg_proxy')
            }
        };
        var token = nfVal(el, 'nf_tg_token');
        if (token) body.telegram.bot_token = token;
    } else {
        return;
    }
    btn.disabled = true;
    try {
        await ADM.api('/api/ai/notify', { method: 'POST', body: body });
        ADM.toast('已保存', 'ok');
        await refreshNotify(el);
    } catch (e) {
        ADM.toast(e.message, 'err');
    } finally {
        btn.disabled = false;
    }
}

async function testGlobal(el, channel, btn) {
    btn.disabled = true;
    try {
        var r = await ADM.api('/api/ai/notify/test', { method: 'POST', body: { channel: channel } });
        ADM.toast(r.ok ? '测试通知已发送' : '测试未成功，请检查配置', r.ok ? 'ok' : 'warn');
    } catch (e) {
        ADM.toast(e.message, 'err');
    } finally {
        btn.disabled = false;
    }
}

async function saveCronNotify(el, btn) {
    var body = {
        notify: {
            enabled: nfChk(el, 'cn_enabled'),
            events: {
                fail: nfChk(el, 'cn_ev_fail'), timeout: nfChk(el, 'cn_ev_timeout'),
                retry: nfChk(el, 'cn_ev_retry'), success: nfChk(el, 'cn_ev_success')
            },
            channels: {
                desktop: nfChk(el, 'cn_ch_desktop'), email: nfChk(el, 'cn_ch_email'),
                dingtalk: nfChk(el, 'cn_ch_dingtalk'), telegram: nfChk(el, 'cn_ch_telegram'),
                pushplus: nfChk(el, 'cn_ch_pushplus')
            },
            desktop: {
                use_global: nfChk(el, 'cn_desk_global'),
                app_name: nfVal(el, 'cn_desk_app'), sound: nfChk(el, 'cn_desk_sound')
            },
            email: {
                use_global: nfChk(el, 'cn_mail_global'), host: nfVal(el, 'cn_mail_host'),
                port: Number(nfVal(el, 'cn_mail_port') || 465), security: nfVal(el, 'cn_mail_sec'),
                username: nfVal(el, 'cn_mail_user'), password: nfVal(el, 'cn_mail_pwd'),
                from_addr: nfVal(el, 'cn_mail_from'), to: nfVal(el, 'cn_mail_to')
            },
            telegram: {
                use_global: nfChk(el, 'cn_tg_global'), bot_token: nfVal(el, 'cn_tg_token'),
                chat_id: nfVal(el, 'cn_tg_chat'), api_base: nfVal(el, 'cn_tg_api'),
                proxy: nfVal(el, 'cn_tg_proxy')
            },
            dingtalk: { webhook: nfVal(el, 'cn_ding_webhook'), secret: nfVal(el, 'cn_ding_secret') },
            pushplus: { token: nfVal(el, 'cn_pp_token'), topic: nfVal(el, 'cn_pp_topic') },
            template: { title: nfVal(el, 'cn_tpl_title'), body: nfVal(el, 'cn_tpl_body') }
        }
    };
    btn.disabled = true;
    try {
        await ADM.api('/api/cron/settings', { method: 'POST', body: body });
        ADM.toast('定时任务通知配置已保存', 'ok');
        await refreshNotify(el);
    } catch (e) {
        ADM.toast(e.message, 'err');
    } finally {
        btn.disabled = false;
    }
}

async function testCron(el, channel, btn) {
    btn.disabled = true;
    try {
        var r = await ADM.api('/api/cron/notify-test', { method: 'POST', body: { channel: channel } });
        var res = (r && r.results) || {};
        var keys = Object.keys(res);
        var okN = keys.filter(function (k) { return res[k] && res[k].ok; }).length;
        ADM.toast(keys.length ? ('测试完成：成功 ' + okN + ' / ' + keys.length + ' 个渠道') : '测试已发送',
            okN > 0 ? 'ok' : 'warn');
        await refreshNotify(el);
    } catch (e) {
        ADM.toast(e.message, 'err');
    } finally {
        btn.disabled = false;
    }
}

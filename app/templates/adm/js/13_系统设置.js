/* 后台管理：系统设置（只读配置快照，来源 app/config.py 与 .env）。 */
ADM.modules.push({
    id: 'config',
    name: '系统设置',
    subtitle: '运行参数与安全策略（只读）',
    icon: 'bi-gear',
    async load(el) {
        el.innerHTML = ADM.loading('读取系统配置…');
        var d = await ADM.api('/api/adm/config');
        var svc = d.service || {}, auth = d.auth || {}, ex = d.exec || {}, media = d.media || {}, rules = d.rules || {};

        function flag(v) { return v ? ADM.badge('开启', 'ok') : ADM.badge('关闭', 'mute'); }
        function kv(pairs) {
            var h = '<dl class="adm-kv">';
            pairs.forEach(function (p) { h += '<dt>' + ADM.esc(p[0]) + '</dt><dd>' + p[1] + '</dd>'; });
            return h + '</dl>';
        }

        /* ---- 配置总览 ---- */
        var ruleTotal = (rules.blocked || 0) + (rules.confirm || 0) + (rules.delete || 0);
        var extTotal = (media.text_exts || 0) + (media.image_exts || 0) + (media.video_exts || 0) + (media.audio_exts || 0);
        var html = '<div class="adm-section">' + ADM.sectionHead('bi-graph-up', '配置总览',
            '<span class="adm-hint">数据来源：app/config.py 与 .env（只读）</span>') + '<div class="adm-stat-grid">';
        html += ADM.stat('bi-shield-check', '安全规则', ruleTotal,
            '硬拦截 ' + (rules.blocked || 0) + ' · 二次确认 ' + (rules.confirm || 0) + ' · 删除类 ' + (rules.delete || 0));
        html += ADM.stat('bi-terminal', '命令执行', ex.enable_exec ? '开启' : '关闭',
            ex.enable_exec ? ('安全校验' + (ex.exec_enforce_safety ? '已开启' : '未开启') + ' · 超时 ' + ex.run_timeout + ' 秒') : '功能未启用');
        html += ADM.stat('bi-files', '可预览格式', extTotal,
            '文本 ' + media.text_exts + ' · 图片 ' + media.image_exts + ' · 视频 ' + media.video_exts + ' · 音频 ' + media.audio_exts);
        html += ADM.stat('bi-gear', '服务地址', svc.host + ':' + svc.port,
            '调试模式' + (svc.debug ? '开启' : '关闭') + ' · 请求体上限 ' + media.max_content_mb + ' MB');
        html += '</div></div>';

        /* ---- Tab 1：运行参数（原来的「系统设置」卡片） ---- */
        var basicHtml = '<div class="adm-col-grid">';
        basicHtml += '<div class="adm-card">' + kv([
            ['服务地址', ADM.esc(svc.host + ':' + svc.port)],
            ['调试模式', flag(svc.debug)],
            ['默认起始路径', '<span class="adm-cell-mono" title="' + ADM.esc(svc.default_start_path) + '">' + ADM.esc(svc.default_start_path) + '</span>'],
            ['数据目录', '<span class="adm-cell-mono" title="' + ADM.esc(svc.data_root) + '">' + ADM.esc(svc.data_root) + '</span>'],
            ['存储目录', '<span class="adm-cell-mono" title="' + ADM.esc(svc.storage_dir) + '">' + ADM.esc(svc.storage_dir) + '</span>'],
            ['服务器时间', ADM.esc(svc.server_time) + '（' + ADM.esc(svc.timezone) + '）']
        ]) + '</div>';
        basicHtml += '<div class="adm-card">' + kv([
            ['默认管理员', ADM.esc(auth.admin_username)],
            ['凭据加密盐 SECRET_SALT', auth.secret_salt_set ? ADM.badge('已设置', 'ok') : ADM.badge('未设置（回退本地密钥）', 'warn')],
            ['导出默认口令', auth.export_password_set ? ADM.badge('已设置', 'ok') : ADM.badge('未设置', 'warn')],
            ['命令执行 ENABLE_EXEC', flag(ex.enable_exec)],
            ['命令安全校验', flag(ex.exec_enforce_safety)],
            ['一键安装运行时', flag(ex.enable_auto_install)]
        ]) + '</div>';

        /* 前端注册开关（可交互） */
        var regOpen = !!(auth && auth.allow_register);
        basicHtml += '<div class="adm-card"><div class="adm-setting-row">' +
            '<div class="adm-setting-text">' +
            '<div class="adm-setting-title">允许前端自助注册</div>' +
            '<div class="adm-hint">关闭后，登录页不再显示「注册新账号」入口，/register 直接提示已关闭；新用户只能由管理员在「用户管理」中手动创建。</div>' +
            '</div>' +
            '<label class="adm-switch"><input type="checkbox" id="admAllowRegister"' +
            (regOpen ? ' checked' : '') + '></label>' +
            '</div></div>';

        basicHtml += '<div class="adm-card">' + kv([
            ['前台运行超时', ex.run_timeout + ' 秒（上限 ' + ex.run_timeout_max + ' 秒）'],
            ['超时处理', ADM.badge(ex.run_timeout_action, 'info')],
            ['后台日志保留', ex.run_log_keep_days + ' 天'],
            ['ffmpeg', '<span class="adm-cell-mono" title="' + ADM.esc(media.ffmpeg) + '">' + ADM.esc(media.ffmpeg) + '</span>'],
            ['ffprobe', '<span class="adm-cell-mono" title="' + ADM.esc(media.ffprobe) + '">' + ADM.esc(media.ffprobe) + '</span>'],
            ['请求体上限', media.max_content_mb + ' MB'],
            ['可预览扩展', '文本 ' + media.text_exts + ' · 图片 ' + media.image_exts +
                ' · 视频 ' + media.video_exts + ' · 音频 ' + media.audio_exts]
        ]) + '</div>';
        basicHtml += '</div>';

        /* ---- Tab 2：命令安全规则（分组可展开看每一条） ---- */
        var rulesHtml = '<div class="adm-rule-toolbar">' +
            '<input class="adm-input" id="admRuleQ" placeholder="搜索规则：命令 / 说明，例如 mkfs、systemctl、reboot" spellcheck="false">' +
            '<button class="adm-btn sm ghost" type="button" id="admRuleToggleAll">' +
            '<i class="bi bi-arrows-expand"></i> 全部展开</button>' +
            '</div>' +
            '<div id="admRuleList">' + admRuleGroupsHtml(rules.groups, '') + '</div>' +
            '<div class="adm-hint" style="margin-top:10px">' +
            '规则定义在 <code>app/config.py</code> 的 <code>EXEC_RULE_GROUPS</code>，修改后重启服务生效；' +
            '「硬拦截」= 直接拒绝执行，「二次确认」= 前端弹确认框，「删除类」= 删除操作额外提示。' +
            '点分组标题可展开 / 收起，右侧是命中用的正则原文（悬停看完整）。' +
            '</div>';

        html += '<div class="adm-section">' + ADM.sectionHead('bi-gear', '系统设置',
            '<span class="adm-hint">运行参数与命令安全策略</span>') +
            ADM.tabs([
                { id: 'basic', name: '运行参数', icon: 'bi-gear', content: basicHtml },
                { id: 'rules', name: '命令安全规则', icon: 'bi-shield-check', content: rulesHtml }
            ], { key: 'admconfig' }) +
            '</div>';

        el.innerHTML = html;
        ADM.mountTabs(el);

        /* 命令规则：展开 / 收起 + 搜索 */
        admBindRuleGroups(el, rules.groups);

        /* 注册开关：切换即保存 */
        var sw = el.querySelector('#admAllowRegister');
        if (sw) {
            sw.addEventListener('change', async function () {
                var on = sw.checked;
                if (on) {
                    var okOpen = await ADM.confirm('开启开放注册',
                        '开启后任何人都能在登录页注册新账号（默认是普通成员权限）。<br>' +
                        '<span class="adm-hint">确认现在对外开放注册？</span>', '开启注册');
                    if (!okOpen) { sw.checked = false; return; }
                }
                var r = await ADM.api('/api/adm/settings/register-open',
                    { method: 'POST', body: { open: on } });
                if (!r || !r.ok) {
                    ADM.toast('保存失败', 'err');
                    sw.checked = !on;          // 回滚
                    return;
                }
                ADM.toast(on ? '已开放前端注册' : '已关闭前端注册', 'ok');
            });
        }
    }
});

/* 命令安全规则：分组卡片（点标题展开看每条规则的说明 + 正则） */
function admRuleGroupsHtml(groups, q) {
    q = (q || '').toLowerCase();
    var out = '';
    (groups || []).forEach(function (g) {
        var items = (g.items || []).filter(function (r) {
            if (!q) return true;
            return (r.reason + ' ' + r.pattern).toLowerCase().indexOf(q) !== -1;
        });
        if (q && !items.length && (g.name + ' ' + (g.desc || '')).toLowerCase().indexOf(q) === -1) return;

        var rows = items.map(function (r) {
            var tone = r.level === 'blocked' ? 'bad' : (r.level === 'confirm' ? 'warn' : 'info');
            var lv = r.level === 'blocked' ? '硬拦截' : (r.level === 'confirm' ? '二次确认' : '删除类');
            return '<div class="adm-rule-item">' +
                '<span class="adm-rule-lv">' + ADM.badge(lv, tone) + '</span>' +
                '<span class="adm-rule-reason">' + ADM.esc(r.reason) + '</span>' +
                '<code class="adm-rule-pat" title="' + ADM.esc(r.pattern) + '">' + ADM.esc(r.pattern) + '</code>' +
                '</div>';
        }).join('') || '<div class="adm-hint" style="padding:6px 4px">本组没有匹配的规则</div>';

        out += '<div class="adm-rule-card' + (q ? ' open' : '') + '">' +
            '<button class="adm-rule-head" type="button">' +
            '<i class="bi bi-chevron-right adm-rule-caret"></i>' +
            '<span class="adm-rule-name">' + ADM.esc(g.name) + '</span>' +
            '<span class="adm-rule-desc">' + ADM.esc(g.desc || '') + '</span>' +
            '<span class="adm-rule-counts">' +
            ADM.badge('共 ' + g.total, 'mute') +
            ADM.badge('拦截 ' + (g.blocked || 0), 'bad') +
            ADM.badge('确认 ' + (g.confirm || 0), 'warn') +
            ((g.delete || 0) ? ADM.badge('删除 ' + g.delete, 'info') : '') +
            '</span></button>' +
            '<div class="adm-rule-body"' + (q ? '' : ' hidden') + '>' +
            '<div class="adm-rule-cols"><span>级别</span><span>说明</span><span>匹配规则（正则）</span></div>' +
            rows + '</div>' +
            '</div>';
    });
    return out || '<div class="adm-hint">没有匹配的规则</div>';
}

function admRuleHeadsBind(root) {
    root.querySelectorAll('.adm-rule-head').forEach(function (h) {
        h.addEventListener('click', function () {
            var card = h.parentNode;
            var body = card.querySelector('.adm-rule-body');
            var open = card.classList.toggle('open');
            body.hidden = !open;
        });
    });
}

function admBindRuleGroups(el, groups) {
    var list = el.querySelector('#admRuleList');
    if (!list) return;
    admRuleHeadsBind(list);

    var q = el.querySelector('#admRuleQ');
    if (q) {
        var timer = null;
        q.addEventListener('input', function () {
            clearTimeout(timer);
            timer = setTimeout(function () {
                list.innerHTML = admRuleGroupsHtml(groups, q.value.trim());
                admRuleHeadsBind(list);
            }, 150);
        });
    }

    var all = el.querySelector('#admRuleToggleAll');
    if (all) {
        all.addEventListener('click', function () {
            var cards = list.querySelectorAll('.adm-rule-card');
            var anyClosed = Array.prototype.some.call(cards, function (c) { return !c.classList.contains('open'); });
            cards.forEach(function (c) {
                c.classList.toggle('open', anyClosed);
                var body = c.querySelector('.adm-rule-body');
                if (body) body.hidden = !anyClosed;
            });
            all.innerHTML = anyClosed
                ? '<i class="bi bi-arrows-collapse"></i> 全部收起'
                : '<i class="bi bi-arrows-expand"></i> 全部展开';
        });
    }
}

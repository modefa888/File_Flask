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

        html += '<div class="adm-section">' + ADM.sectionHead('bi-gear', '系统设置') + '<div class="adm-col-grid">';
        html += '<div class="adm-card">' + kv([
            ['服务地址', ADM.esc(svc.host + ':' + svc.port)],
            ['调试模式', flag(svc.debug)],
            ['默认起始路径', '<span class="adm-cell-mono">' + ADM.esc(svc.default_start_path) + '</span>'],
            ['数据目录', '<span class="adm-cell-mono">' + ADM.esc(svc.data_root) + '</span>'],
            ['存储目录', '<span class="adm-cell-mono">' + ADM.esc(svc.storage_dir) + '</span>'],
            ['服务器时间', ADM.esc(svc.server_time) + '（' + ADM.esc(svc.timezone) + '）']
        ]) + '</div>';
        html += '<div class="adm-card">' + kv([
            ['默认管理员', ADM.esc(auth.admin_username)],
            ['凭据加密盐 SECRET_SALT', auth.secret_salt_set ? ADM.badge('已设置', 'ok') : ADM.badge('未设置（回退本地密钥）', 'warn')],
            ['导出默认口令', auth.export_password_set ? ADM.badge('已设置', 'ok') : ADM.badge('未设置', 'warn')],
            ['命令执行 ENABLE_EXEC', flag(ex.enable_exec)],
            ['命令安全校验', flag(ex.exec_enforce_safety)],
            ['一键安装运行时', flag(ex.enable_auto_install)]
        ]) + '</div>';
        html += '<div class="adm-card">' + kv([
            ['前台运行超时', ex.run_timeout + ' 秒（上限 ' + ex.run_timeout_max + ' 秒）'],
            ['超时处理', ADM.badge(ex.run_timeout_action, 'info')],
            ['后台日志保留', ex.run_log_keep_days + ' 天'],
            ['ffmpeg', '<span class="adm-cell-mono">' + ADM.esc(media.ffmpeg) + '</span>'],
            ['ffprobe', '<span class="adm-cell-mono">' + ADM.esc(media.ffprobe) + '</span>'],
            ['请求体上限', media.max_content_mb + ' MB'],
            ['可预览扩展', '文本 ' + media.text_exts + ' · 图片 ' + media.image_exts +
                ' · 视频 ' + media.video_exts + ' · 音频 ' + media.audio_exts]
        ]) + '</div></div></div>';

        html += '<div class="adm-section">' + ADM.sectionHead('bi-shield-check', '命令安全规则',
            '<span class="adm-hint">硬拦截 ' + (rules.blocked || 0) + ' · 二次确认 ' + (rules.confirm || 0) +
            ' · 删除类 ' + (rules.delete || 0) + '</span>') + '<div class="adm-card">';
        (rules.groups || []).forEach(function (g) {
            html += '<div class="adm-rule-group"><h4>' + ADM.esc(g.name) + '</h4><p>' + ADM.esc(g.desc) + '</p>' +
                '<div class="adm-rule-tags">' +
                ADM.badge('共 ' + g.total + ' 条', 'mute') +
                ADM.badge('硬拦截 ' + (g.blocked || 0), 'bad') +
                ADM.badge('二次确认 ' + (g.confirm || 0), 'warn') +
                ADM.badge('删除类 ' + (g.delete || 0), 'info') +
                '</div></div>';
        });
        html += '<div class="adm-hint">规则定义在 app/config.py 的 EXEC_RULE_GROUPS，修改后重启服务生效。</div>';
        html += '</div></div>';

        el.innerHTML = html;
    }
});

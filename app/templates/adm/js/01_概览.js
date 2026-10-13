/* 后台管理：概览面板。 */
ADM.modules.push({
    id: 'overview',
    name: '概览',
    subtitle: '系统运行状态与对象统计',
    icon: 'bi-speedometer2',
    async load(el) {
        el.innerHTML = ADM.loading('正在汇总系统信息…');
        var d = await ADM.api('/api/adm/overview');
        var c = d.counts || {}, sys = d.system || {}, res = sys.resource || {}, st = d.storage || {},
            ai = d.ai || {}, recent = d.recent || {};

        var html = '';

        /* ---- 对象统计 ---- */
        html += '<div class="adm-section">' + ADM.sectionHead('bi-grid-1x2', '对象统计',
            '<span class="adm-hint">数据来源：store.db</span>') + '<div class="adm-stat-grid">';
        html += ADM.stat('bi-people', '用户账号', c.users || 0, '管理员 ' + (c.admins || 0) + ' · 协作者 ' + (c.members || 0));
        html += ADM.stat('bi-share', '分享链接', c.shares || 0, '有效 ' + (c.shares_active || 0));
        html += ADM.stat('bi-clock-history', '定时任务', c.cron_tasks || 0, '已启用 ' + (c.cron_enabled || 0));
        html += ADM.stat('bi-puzzle', '插件', (c.installed || 0), '已启用 ' + (c.enabled || 0));
        html += ADM.stat('bi-database', '数据库连接', c.db_conns || 0, 'SSH 连接 ' + (c.ssh_conns || 0));
        html += ADM.stat('bi-robot', 'AI 对话', c.ai_conversations || 0, '消息 ' + (c.ai_messages || 0) + ' 条');
        html += ADM.stat('bi-bell', '通知记录', c.notify_history || 0, 'AI 接口 ' + (c.ai_providers || 0) + ' 个');
        html += ADM.stat('bi-star', '收藏夹', c.favorites || 0, '文件说明 ' + (c.file_hints || 0) + ' 条');
        html += '</div></div>';

        /* ---- 系统资源 ---- */
        html += '<div class="adm-section">' + ADM.sectionHead('bi-cpu', '系统资源') + '<div class="adm-col-grid">';
        if (res && !res.error) {
            var cpu = res.cpu || {}, mem = res.mem || {}, disk = res.disk || {};
            html += '<div class="adm-card">';
            html += ADM.metric('CPU 使用率', (cpu.percent || 0) + '%（' + (cpu.cores || 1) + ' 核）',
                cpu.percent || 0, cpu.load && cpu.load.length ? ('负载 ' + cpu.load.join(' / ')) : '');
            html += ADM.metric('内存使用率', (mem.percent || 0) + '%',
                mem.percent || 0, ADM.bytes(mem.used) + ' / ' + ADM.bytes(mem.total));
            html += ADM.metric('磁盘使用率', (disk.percent || 0) + '%',
                disk.percent || 0, ADM.bytes(disk.used) + ' / ' + ADM.bytes(disk.total) + '（' + (disk.mount || '-') + '）');
            html += '</div>';
            html += '<div class="adm-card">';
            html += '<dl class="adm-kv">';
            html += '<dt>健康结论</dt><dd>' + ADM.badge(
                res.health === 'bad' ? '压力较大' : (res.health === 'warn' ? '需关注' : '正常'),
                res.health === 'bad' ? 'bad' : (res.health === 'warn' ? 'warn' : 'ok')) +
                ' <span class="adm-hint">' + ADM.esc(res.summary || '') + '</span></dd>';
            html += '<dt>系统运行时长</dt><dd>' + ADM.dur(res.uptime || 0) + '</dd>';
            html += '<dt>进程总数</dt><dd>' + ((res.counts && res.counts.total) || 0) + '（本服务相关 ' +
                ((res.counts && res.counts.app) || 0) + '）</dd>';
            html += '<dt>本服务进程</dt><dd>PID ' + ((res.self && res.self.pid) || sys.pid || '-') + ' · 内存 ' +
                ADM.bytes(res.self && res.self.rss) + '</dd>';
            html += '<dt>交换分区</dt><dd>' + ADM.bytes(mem.swap_used) + ' / ' + ADM.bytes(mem.swap_total) + '</dd>';
            html += '<dt>网络实时速率</dt><dd>↑ ' + ADM.bytes((res.net && res.net.up) || 0) + '/s · ↓ ' +
                ADM.bytes((res.net && res.net.down) || 0) + '/s</dd>';
            html += '</dl></div>';
        } else {
            html += '<div class="adm-card"><div class="adm-hint">' +
                ADM.esc((res && res.error) || '无法采集系统资源') + '</div></div>';
        }
        html += '</div></div>';

        /* ---- 存储占用 ---- */
        html += '<div class="adm-section">' + ADM.sectionHead('bi-hdd', '存储占用') + '<div class="adm-card">';
        html += ADM.table([
            { label: '位置', render: function (r) { return '<span class="adm-cell-strong">' + ADM.esc(r.name) + '</span>'; } },
            { label: '占用', render: function (r) { return ADM.bytes(r.size); } },
            { label: '路径', render: function (r) { return '<span class="adm-cell-mono" title="' + ADM.esc(r.path) + '">' + ADM.esc(r.path) + '</span>'; } }
        ], [
            { name: '数据总目录 data/', size: st.data_size, path: st.data_dir },
            { name: '统一数据库 store.db', size: st.store_db, path: st.storage_dir },
            { name: '文件索引 index.db', size: st.index_db, path: st.data_dir },
            { name: '日志目录 logs/', size: st.logs_size, path: st.logs_dir },
            { name: '回收站', size: st.trash_size, path: st.data_dir + '/.file_manager_trash' },
            { name: '缩略图缓存', size: st.thumb_size, path: st.data_dir + '/.file_manager_thumbs' },
            { name: '运行日志', size: st.run_logs_size, path: st.data_dir + '/run_logs' },
            { name: '定时任务日志', size: st.cron_logs_size, path: st.data_dir + '/cron_logs' }
        ], { key: 'ov-storage', pageSize: 6 });
        html += '</div></div>';

        /* ---- AI 用量 + 运行环境 ---- */
        html += '<div class="adm-section">' + ADM.sectionHead('bi-activity', 'AI 用量与运行环境') + '<div class="adm-col-grid">';
        html += '<div class="adm-card"><dl class="adm-kv">';
        html += '<dt>累计调用</dt><dd>' + (ai.calls || 0) + ' 次（模块 ' + (ai.modules || 0) + ' 个）</dd>';
        html += '<dt>成功 / 失败</dt><dd><span style="color:#6ee7b7">' + (ai.ok || 0) + '</span> / <span style="color:#fca5a5">' + (ai.fail || 0) + '</span></dd>';
        html += '<dt>Token 用量</dt><dd>输入 ' + (ai.tokens_in || 0) + ' · 输出 ' + (ai.tokens_out || 0) + '</dd>';
        html += '<dt>归档历史</dt><dd>' + (c.archive_history || 0) + ' 条压缩记录 · ' + (c.delete_history || 0) + ' 条删除记录</dd>';
        html += '</dl></div>';

        html += '<div class="adm-card"><dl class="adm-kv">';
        html += '<dt>操作系统</dt><dd>' + ADM.esc(sys.platform || '-') + '</dd>';
        html += '<dt>Python</dt><dd>' + ADM.esc(sys.python || '-') + '</dd>';
        html += '<dt>运行形态</dt><dd>' + (sys.frozen ? '打包可执行文件' : '源码运行') + '</dd>';
        html += '<dt>psutil</dt><dd>' + (sys.psutil ? ADM.badge('已安装', 'ok') : ADM.badge('未安装', 'warn')) + '</dd>';
        html += '<dt>服务器时间</dt><dd>' + ADM.dt(sys.now) + '</dd>';
        html += '</dl></div>';
        html += '</div></div>';

        /* ---- 最近动态 ---- */
        html += '<div class="adm-section">' + ADM.sectionHead('bi-clock', '最近动态') + '<div class="adm-col-grid">';
        html += '<div class="adm-card"><div class="adm-hint" style="margin-bottom:8px">定时任务执行</div>';
        html += ADM.table([
            { label: '任务', render: function (r) { return ADM.esc(r.task_name || '-'); } },
            { label: '状态', render: function (r) { return taskStatusBadge(r.status); } },
            { label: '触发', render: function (r) { return ADM.esc(r.trigger || '-'); } },
            { label: '耗时', render: function (r) { return ADM.dur(r.duration); } },
            { label: '开始', render: function (r) { return ADM.dt(r.started_at); } }
        ], recent.cron_runs || [], { key: 'ov-cron-runs', pageSize: 5 });
        html += '</div>';

        html += '<div class="adm-card"><div class="adm-hint" style="margin-bottom:8px">AI 调用</div>';
        html += ADM.table([
            { label: '模块', render: function (r) { return ADM.esc(r.module || '-'); } },
            { label: '结果', render: function (r) { return r.ok ? ADM.badge('成功', 'ok') : ADM.badge('失败', 'bad'); } },
            { label: '模型', render: function (r) { return ADM.esc(r.model || '-'); } },
            { label: '耗时', render: function (r) { return (r.ms || 0) + ' ms'; } },
            { label: '时间', render: function (r) { return ADM.esc(r.ts || '-'); } }
        ], recent.ai_calls || [], { key: 'ov-ai-calls', pageSize: 5 });
        html += '</div></div></div>';

        el.innerHTML = html;
        ADM.mountTables(el);
    }
});

/* 复用的小工具：定时任务状态徽标 */
function taskStatusBadge(status) {
    var map = {
        success: ['成功', 'ok'], fail: ['失败', 'bad'], running: ['运行中', 'info'],
        killed: ['已终止', 'warn'], timeout: ['超时', 'warn']
    };
    var it = map[status] || [status || '未知', 'mute'];
    return ADM.badge(it[0], it[1]);
}

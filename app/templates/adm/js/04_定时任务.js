/* 后台管理：定时任务（复用 /api/cron/*）。 */
ADM.modules.push({
    id: 'cron',
    name: '定时任务',
    subtitle: 'cron 计划任务的启停、运行与记录',
    icon: 'bi-clock-history',
    async load(el) {
        el.innerHTML = ADM.loading('加载定时任务…');
        await refreshCron(el);
    }
});

async function refreshCron(el) {
    var cronCols = [
        { label: '任务名', render: function (r) { return '<span class="adm-cell-strong">' + ADM.esc(r.name) + '</span>'; } },
        {
            label: '调度', render: function (r) {
                return '<span class="adm-cell-mono">' + ADM.esc(r.cron) + '</span>' +
                    (r.next && r.next.length ? '<div class="adm-hint adm-nowrap" style="margin-top:3px">下次 ' + ADM.esc(r.next[0]) + '</div>' : '');
            }
        },
        {
            label: '状态', render: function (r) {
                if (r.running) return ADM.badge('运行中', 'info');
                return r.enabled ? ADM.badge('已启用', 'ok') : ADM.badge('已停用', 'mute');
            }
        },
        { label: '命令', render: function (r) { return '<span class="adm-cell-mono" title="' + ADM.esc(r.command) + '">' + ADM.esc(r.command) + '</span>'; } },
        {
            label: '统计', render: function (r) {
                // 单行显示：成功数 · 失败数 + 上次状态徽标
                return '<span class="adm-nowrap">成功 <b>' + (r.ok_count || 0) + '</b> · 失败 <b>' +
                    (r.fail_count || 0) + '</b>' +
                    (r.last_status ? ' ' + taskStatusBadge(r.last_status) : '') + '</span>';
            }
        },
        { label: '上次运行', render: function (r) { return r.last_at ? ADM.dt(r.last_at) : '-'; } },
        {
            label: '操作', render: function (r) {
                var id = ADM.esc(r.id);
                var toggle = r.enabled
                    ? '<button class="adm-btn sm" data-act="disable" data-id="' + id + '">停用</button>'
                    : '<button class="adm-btn sm" data-act="enable" data-id="' + id + '">启用</button>';
                var run = r.running
                    ? '<button class="adm-btn sm warn" data-act="stop" data-id="' + id + '">停止</button>'
                    : '<button class="adm-btn sm primary" data-act="run" data-id="' + id + '"><i class="bi bi-play-fill"></i> 运行</button>';
                return '<div class="adm-btn-row">' + run + toggle +
                    '<button class="adm-btn sm" data-act="runs" data-id="' + id + '" data-name="' + ADM.esc(r.name) + '">记录</button>' +
                    '<button class="adm-btn sm danger" data-act="del" data-id="' + id + '" data-name="' + ADM.esc(r.name) + '">删除</button>' +
                    '</div>';
            }
        }
    ];
    var html = '<div class="adm-section">';
    html += ADM.sectionHead('bi-clock-history', '定时任务',
        '<span class="adm-hint" id="cronCount"></span>');
    html += ADM.servTable(cronCols, {
        key: 'cron-tasks',
        itemsKey: 'tasks', totalKey: 'total',
        fetch: function (p) {
            return ADM.api('/api/cron/tasks?q=' + encodeURIComponent(p.q) +
                '&page=' + p.page + '&page_size=' + p.size);
        },
        onRender: function (host, last) {
            var c = el.querySelector('#cronCount');
            if (c) c.textContent = '共 ' + (last.total || 0) + ' 个 · 运行中 ' + (last.running || 0) + ' 个';
            bindCronEvents(host, el);
        }
    });
    html += '</div>';
    el.innerHTML = html;
    ADM.mountServTables(el);
}

/* 行内按钮绑定（分页切换后由 onRender 重新调用） */
function bindCronEvents(host, el) {
    host.querySelectorAll('[data-act]').forEach(function (btn) {
        btn.addEventListener('click', function () { handleCronAction(el, btn); });
    });
}

async function handleCronAction(el, btn) {
    var id = btn.dataset.id, act = btn.dataset.act;
    if (act === 'enable' || act === 'disable') {
        await ADM.api('/api/cron/toggle', { method: 'POST', body: { id: id, enabled: act === 'enable' } });
        ADM.toast(act === 'enable' ? '任务已启用' : '任务已停用', 'ok');
        await refreshCron(el);
    } else if (act === 'run') {
        var r = await ADM.api('/api/cron/run', { method: 'POST', body: { id: id } });
        if (r.error) { ADM.toast(r.error, 'err'); return; }
        ADM.toast('已触发运行', 'ok');
        await refreshCron(el);
        setTimeout(function () { openCronRuns(id, btn.dataset.name, el); }, 600);
    } else if (act === 'stop') {
        await ADM.api('/api/cron/stop', { method: 'POST', body: { id: id } });
        ADM.toast('已停止', 'ok');
        await refreshCron(el);
    } else if (act === 'del') {
        var ok = await ADM.confirm('删除任务', '确认删除任务「' + ADM.esc(btn.dataset.name) + '」？其执行记录与日志将一并清除。', '删除');
        if (!ok) return;
        await ADM.api('/api/cron/delete', { method: 'POST', body: { id: id } });
        ADM.toast('任务已删除', 'ok');
        await refreshCron(el);
    } else if (act === 'runs') {
        openCronRuns(id, btn.dataset.name, el);
    }
}

async function openCronRuns(taskId, name, el) {
    var data = await ADM.api('/api/cron/runs?task_id=' + encodeURIComponent(taskId) + '&limit=50');
    var runs = data.runs || [];
    var html = '<div style="margin-bottom:10px" class="adm-hint">任务：' + ADM.esc(name) + ' · 共 ' + runs.length + ' 条记录</div>';
    html += ADM.table([
        { label: '开始时间', render: function (r) { return ADM.dt(r.started_at); } },
        { label: '状态', render: function (r) { return taskStatusBadge(r.status); } },
        { label: '触发', render: function (r) { return ADM.esc(r.trigger) + (r.attempt ? ' · 重试' + r.attempt : ''); } },
        { label: '耗时', render: function (r) { return ADM.dur(r.duration); } },
        { label: '退出码', render: function (r) { return (r.exit_code === null || r.exit_code === undefined) ? '-' : r.exit_code; } },
        {
            label: '日志', render: function (r) {
                return '<button class="adm-btn sm" data-log="' + ADM.esc(r.id) + '">查看日志</button>';
            }
        }
    ], runs, { key: 'cron-runs', reset: true, onRender: function (host) {
        host.querySelectorAll('[data-log]').forEach(function (b) {
            b.addEventListener('click', function () { openCronLog(b.dataset.log); });
        });
    } });
    await ADM.modal({
        title: '执行记录 · ' + name,
        icon: 'bi-list-check',
        size: 'big',
        noOk: true,
        cancelText: '关闭',
        html: html
    });
}

function openCronLog(runId) {
    openLogViewer('执行日志 · ' + runId, function (offset) {
        return ADM.api('/api/cron/log?run_id=' + encodeURIComponent(runId) + '&offset=' + offset);
    }, 'running');
}

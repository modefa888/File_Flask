/* 后台管理：后台运行任务（复用 /api/run/*）。 */
ADM.modules.push({
    id: 'runner',
    name: '后台任务',
    subtitle: 'F5 运行 / 后台服务进程',
    icon: 'bi-terminal',
    async load(el) {
        el.innerHTML = ADM.loading('加载后台任务…');
        await refreshRunner(el);
    }
});

async function refreshRunner(el) {
    var runnerCols = [
        { label: '任务', render: function (r) { return '<span class="adm-cell-strong">' + ADM.esc(r.name || r.target) + '</span>'; } },
        {
            label: '状态', render: function (r) {
                if (r.paused) return ADM.badge('已暂停', 'warn');
                if (r.running) return ADM.badge('运行中', 'ok');
                if (r.timed_out) return ADM.badge('已超时', 'warn');
                if (r.stopped_by_user) return ADM.badge('已手动停止', 'mute');
                return ADM.badge('已结束' + (r.exit_code !== null && r.exit_code !== undefined ? ' (码 ' + r.exit_code + ')' : ''), 'mute');
            }
        },
        { label: 'PID', render: function (r) { return r.pid ? r.pid : '-'; } },
        { label: '资源', render: function (r) { return (r.running ? (r.cpu === null ? '-' : r.cpu + '%') + ' · ' + ADM.bytes(r.mem) : '-'); } },
        { label: '端口', render: function (r) { return (r.ports && r.ports.length) ? r.ports.join(', ') : '-'; } },
        { label: '运行时长', render: function (r) { return ADM.dur(r.duration); } },
        { label: '日志', render: function (r) { return ADM.bytes(r.log_size); } },
        {
            label: '操作', render: function (r) {
                var id = ADM.esc(r.id);
                // 已结束 → 启动；运行中 → 重启（先终止再拉起）
                var start = '<button class="adm-btn sm primary" data-act="restart" data-id="' + id +
                    '" data-running="' + (r.running ? '1' : '') + '">' + (r.running ? '重启' : '启动') + '</button>';
                var stop = r.running ? '<button class="adm-btn sm warn" data-act="stop" data-id="' + id + '">停止</button>' : '';
                var log = '<button class="adm-btn sm" data-act="log" data-id="' + id + '">日志</button>';
                var runs = '<button class="adm-btn sm" data-act="runs" data-id="' + id + '">记录</button>';
                var rm = '<button class="adm-btn sm danger" data-act="remove" data-id="' + id + '"' + (r.running ? ' disabled title="运行中，请先停止"' : '') + '>移除</button>';
                return '<div class="adm-btn-row">' + start + stop + log + runs + rm + '</div>';
            }
        }
    ];
    var html = '<div class="adm-section">';
    html += ADM.sectionHead('bi-terminal', '后台任务',
        '<div class="adm-btn-row"><span class="adm-hint" id="runnerCount" style="align-self:center"></span>' +
        '<button class="adm-btn sm ghost" id="admRunPrune" type="button"><i class="bi bi-trash3"></i> 清理已结束</button></div>');
    html += ADM.servTable(runnerCols, {
        key: 'runner-tasks',
        actionsWidth: 400,
        itemsKey: 'tasks', totalKey: 'total',
        fetch: function (p) {
            return ADM.api('/api/run/tasks?q=' + encodeURIComponent(p.q) +
                '&page=' + p.page + '&page_size=' + p.size);
        },
        onRender: function (host, last) {
            var c = el.querySelector('#runnerCount');
            if (c) c.textContent = '运行中 ' + (last.running || 0) + ' / 共 ' + (last.total || 0);
            bindRunnerEvents(host, el);
        }
    });
    html += '</div>';
    el.innerHTML = html;
    ADM.mountServTables(el);

    var prune = el.querySelector('#admRunPrune');
    if (prune) prune.addEventListener('click', async function () {
        var ok = await ADM.confirm('清理已结束任务', '移除所有已结束的后台任务记录（运行中的任务不受影响）。', '清理');
        if (!ok) return;
        await ADM.api('/api/run/prune', { method: 'POST', body: {} });
        ADM.toast('已清理', 'ok');
        await refreshRunner(el);
    });
}

/* 行内按钮绑定（分页切换后由 onRender 重新调用） */
function bindRunnerEvents(host, el) {
    host.querySelectorAll('[data-act]').forEach(function (btn) {
        btn.addEventListener('click', function () { handleRunnerAction(el, btn); });
    });
}

async function handleRunnerAction(el, btn) {
    var id = btn.dataset.id, act = btn.dataset.act;
    if (act === 'restart') {
        if (btn.dataset.running === '1') {
            var okStart = await ADM.confirm('重启任务', '该任务正在运行，重启会先终止当前进程再重新启动。确认继续？', '重启');
            if (!okStart) return;
        }
        try {
            await ADM.api('/api/run/restart', { method: 'POST', body: { id: id } });
            ADM.toast('已触发启动', 'ok');
            await refreshRunner(el);
        } catch (e) {
            ADM.toast(e.message, 'err');
        }
    } else if (act === 'stop') {
        await ADM.api('/api/run/stop', { method: 'POST', body: { id: id } });
        ADM.toast('已发送停止信号', 'ok');
        await refreshRunner(el);
    } else if (act === 'remove') {
        var ok = await ADM.confirm('移除任务记录', '确认从列表中移除该任务记录？运行中的任务需先停止。', '移除');
        if (!ok) return;
        await ADM.api('/api/run/remove', { method: 'POST', body: { id: id } });
        ADM.toast('已移除', 'ok');
        await refreshRunner(el);
    } else if (act === 'log') {
        openRunLog(id);
    } else if (act === 'runs') {
        var st = ADM._servTables['runner-tasks'];
        var rows = (st && st.last && st.last.tasks) || [];
        var row = rows.filter(function (x) { return String(x.id) === String(id); })[0];
        if (row) openRunnerRuns(row);
    }
}

/* 运行记录：该任务的历次「启动 → 停止」摘要（与 IDE 面板中的「运行记录」一致） */
function openRunnerRuns(r) {
    var rows = (r.runs || []).slice().reverse();       // 最新在前
    var html = '<div class="adm-hint" style="margin-bottom:12px">任务：' + ADM.esc(r.name || r.target) +
        '　共运行 ' + ((r.run_count === undefined || r.run_count === null) ? rows.length : r.run_count) +
        ' 次　本次运行时长：' + ADM.dur(r.duration) + '</div>';
    html += ADM.table([
        { label: '开始时间', render: function (x) { return ADM.dt(x.start); } },
        { label: '结束时间', render: function (x) { return x.end ? ADM.dt(x.end) : ADM.badge('进行中', 'ok'); } },
        {
            label: '时长', render: function (x) {
                return (x.duration === null || x.duration === undefined) ? '-' : ADM.dur(x.duration);
            }
        },
        { label: '结果', render: function (x) { return runResult(x); } },
        { label: 'PID', render: function (x) { return x.pid || '-'; } }
    ], rows, { key: 'runner-runs', reset: true, pageSize: 10 });
    ADM.modal({
        title: '运行记录 · ' + (r.name || r.target),
        icon: 'bi-clock-history',
        size: 'big',
        noOk: true,
        cancelText: '关闭',
        html: html
    });
}

function runResult(x) {
    if (!x.end) return ADM.badge('运行中', 'ok');
    if (x.timed_out) return ADM.badge('已超时', 'warn');
    if (x.stopped_by_user) return ADM.badge('手动停止', 'mute');
    var code = (x.exit_code === null || x.exit_code === undefined) ? '' : '（码 ' + x.exit_code + '）';
    return ADM.badge('已结束' + code, 'mute');
}

function openRunLog(id) {
    openLogViewer('实时日志 · ' + id, function (offset) {
        return ADM.api('/api/run/log?id=' + encodeURIComponent(id) + '&offset=' + offset).then(function (r) {
            r.text = (r.lines || []).map(function (l) { return l.m; }).join('\n') + ((r.lines && r.lines.length) ? '\n' : '');
            return r;
        });
    }, 'running');
}

/* 后台管理：系统日志（JSON 结构化日志，见 app/log.py）。 */
ADM.modules.push({
    id: 'logs',
    name: '系统日志',
    subtitle: 'logs/ 目录下的日志文件',
    icon: 'bi-journal-text',
    async load(el) {
        el.innerHTML = ADM.loading('加载日志文件…');
        var logCols = [
            { label: '文件', render: function (r) { return '<span class="adm-cell-strong">' + ADM.esc(r.name) + '</span>'; } },
            { label: '大小', render: function (r) { return ADM.bytes(r.size); } },
            { label: '修改时间', render: function (r) { return ADM.dt(r.mtime); } },
            {
                label: '操作', render: function (r) {
                    return '<button class="adm-btn sm" data-name="' + ADM.esc(r.name) + '"><i class="bi bi-eye"></i> 查看</button>';
                }
            }
        ];
        var html = '<div class="adm-section">';
        html += ADM.sectionHead('bi-journal-text', '日志文件',
            '<span class="adm-hint" id="logDir"></span>');
        html += ADM.servTable(logCols, {
            key: 'log-files',
            fetch: function (p) {
                return ADM.api('/api/adm/logs?q=' + encodeURIComponent(p.q) +
                    '&page=' + p.page + '&page_size=' + p.size)
                    .then(function (r) {
                        var d = el.querySelector('#logDir');
                        if (d) d.textContent = r.dir || '';
                        return { items: r.items || [], total: r.total || 0 };
                    });
            },
            onRender: bindLogEvents
        });
        html += '<div class="adm-hint" style="margin-top:10px">日志按天轮转，保留 15 天；每次 HTTP 请求 / 响应的 JSON 记录都在这里。</div>';
        html += '</div>';
        el.innerHTML = html;
        ADM.mountServTables(el);
    }
});

/* 行内按钮绑定（分页切换后由 onRender 重新调用） */
function bindLogEvents(host) {
    host.querySelectorAll('[data-name]').forEach(function (b) {
        b.addEventListener('click', function () { openSystemLog(b.dataset.name); });
    });
}

function openSystemLog(name) {
    openLogViewer('系统日志 · ' + name, function () {
        return ADM.api('/api/adm/log?name=' + encodeURIComponent(name) + '&tail=800').then(function (r) {
            return { text: r.content || '', offset: 0, running: false,
                status: '共 ' + (r.lines || 0) + ' 行（显示最后 ' + (r.shown || 0) + ' 行）' };
        });
    }, null);
}

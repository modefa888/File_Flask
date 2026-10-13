/* 后台管理：操作历史（删除 / 回收站历史 + 压缩历史），用 Tab 切换查看。 */
ADM.modules.push({
    id: 'history',
    name: '操作历史',
    subtitle: '删除记录与压缩 / 解压记录',
    icon: 'bi-clock-history',
    async load(el) {
        el.innerHTML = ADM.loading('加载操作历史…');
        await refreshHistory(el);
    }
});

async function refreshHistory(el) {
    /* 顶部统计（失败不阻塞列表） */
    var delTotal = 0, arcTotal = 0;
    try { delTotal = (await ADM.api('/api/delete-history?page=1&page_size=1')).total || 0; } catch (e) { }
    try { arcTotal = (await ADM.api('/api/archive-history?page=1&page_size=1')).total || 0; } catch (e) { }

    /* ---- Tab 1：删除 / 回收站历史（服务端搜索 + 分页） ---- */
    var delCols = [
        { label: '名称', render: function (r) { return '<span class="adm-cell-strong">' + ADM.esc(r.name || '-') + '</span>'; } },
        { label: '类型', render: function (r) { return r.is_dir ? ADM.badge('目录', 'mute') : ADM.badge('文件', 'info'); } },
        { label: '大小', render: function (r) { return ADM.bytes(r.size); } },
        { label: '原路径', render: function (r) { return '<span class="adm-cell-mono" title="' + ADM.esc(r.original_path) + '">' + ADM.esc(r.original_path || '-') + '</span>'; } },
        { label: '删除时间', render: function (r) { return ADM.dt(r.deleted_at); } },
        { label: '回收站文件', render: function (r) { return r.exists ? ADM.badge('存在', 'ok') : ADM.badge('已清理', 'mute'); } },
        {
            label: '操作', render: function (r) {
                return '<button class="adm-btn sm danger" data-del="' + ADM.esc(r.id) + '">彻底删除</button>';
            }
        }
    ];
    var delContent = '<div class="adm-tab-toolbar">' +
        '<button class="adm-btn sm ghost" id="admDelClear" type="button"><i class="bi bi-trash3"></i> 清空回收站</button>' +
        '</div>' + ADM.servTable(delCols, {
            key: 'delete-history',
            fetch: function (p) {
                return ADM.api('/api/delete-history?q=' + encodeURIComponent(p.q) +
                    '&page=' + p.page + '&page_size=' + p.size);
            },
            pageSize: 10, onRender: function (host) { bindHistoryEvents(host, el); }
        });

    /* ---- Tab 2：压缩 / 解压历史（服务端搜索 + 分页） ---- */
    var arcCols = [
        { label: '类型', render: function (r) { return ADM.badge(r.kind || '-', 'info'); } },
        { label: '名称', render: function (r) { return '<span class="adm-cell-strong">' + ADM.esc(r.name || '-') + '</span>'; } },
        { label: '详情', render: function (r) { return ADM.esc(r.detail || '-'); } },
        { label: '路径', render: function (r) { return '<span class="adm-cell-mono" title="' + ADM.esc(r.path) + '">' + ADM.esc(r.path || '-') + '</span>'; } },
        { label: '时间', render: function (r) { return ADM.dt(r.time); } },
        { label: '操作', render: function (r) { return '<button class="adm-btn sm danger" data-arc="' + ADM.esc(r.id) + '">删除记录</button>'; } }
    ];
    var arcContent = '<div class="adm-tab-toolbar">' +
        '<button class="adm-btn sm ghost" id="admArcClear" type="button"><i class="bi bi-eraser"></i> 清空记录</button>' +
        '</div>' + ADM.servTable(arcCols, {
            key: 'archive-history',
            fetch: function (p) {
                return ADM.api('/api/archive-history?q=' + encodeURIComponent(p.q) +
                    '&page=' + p.page + '&page_size=' + p.size);
            },
            pageSize: 10, onRender: function (host) { bindHistoryEvents(host, el); }
        });

    /* ---- 历史总览 ---- */
    var cards = '<div class="adm-section">' + ADM.sectionHead('bi-graph-up', '历史总览',
        '<span class="adm-hint">数据来源：store.db（delete_history / archive_history）</span>') + '<div class="adm-stat-grid">';
    cards += ADM.stat('bi-trash', '删除记录', delTotal, '删除历史与回收站条目');
    cards += ADM.stat('bi-file-zip', '压缩记录', arcTotal, '压缩 / 解压操作记录');
    cards += '</div></div>';

    var html = cards + ADM.tabs([
        { id: 'del', name: '删除 / 回收站历史', icon: 'bi-trash', content: delContent },
        { id: 'arc', name: '压缩 / 解压历史', icon: 'bi-file-zip', content: arcContent }
    ], { key: 'history-tabs' });

    el.innerHTML = html;
    ADM.mountServTables(el);
    ADM.mountTables(el);
    ADM.mountTabs(el);

    var dc = el.querySelector('#admDelClear');
    if (dc) dc.addEventListener('click', async function () {
        var ok = await ADM.confirm('清空回收站', '确认清空回收站并删除全部删除历史？不可恢复。', '清空');
        if (!ok) return;
        await ADM.api('/api/delete-history/clear', { method: 'POST', body: {} });
        ADM.toast('已清空', 'ok');
        await refreshHistory(el);
    });
    var ac = el.querySelector('#admArcClear');
    if (ac) ac.addEventListener('click', async function () {
        var ok = await ADM.confirm('清空压缩历史', '确认清空全部压缩 / 解压历史记录？', '清空');
        if (!ok) return;
        await ADM.api('/api/archive-history/clear', { method: 'POST', body: {} });
        ADM.toast('已清空', 'ok');
        await refreshHistory(el);
    });
}

/* 行内按钮绑定（分页切换后由 onRender 重新调用） */
function bindHistoryEvents(host, el) {
    host.querySelectorAll('[data-del]').forEach(function (b) {
        b.addEventListener('click', async function () {
            var ok = await ADM.confirm('彻底删除', '确认从回收站永久删除该项目？不可恢复。', '彻底删除');
            if (!ok) return;
            await ADM.api('/api/delete-history/one', { method: 'DELETE', body: { trash_id: b.dataset.del } });
            ADM.toast('已删除', 'ok');
            await refreshHistory(el);
        });
    });
    host.querySelectorAll('[data-arc]').forEach(function (b) {
        b.addEventListener('click', async function () {
            await ADM.api('/api/archive-history/one', { method: 'DELETE', body: { id: b.dataset.arc } });
            ADM.toast('已删除记录', 'ok');
            await refreshHistory(el);
        });
    });
}

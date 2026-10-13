/* 后台管理：插件管理（复用 /api/plugins*）。 */
ADM.modules.push({
    id: 'plugins',
    name: '插件管理',
    subtitle: '插件安装、启用与卸载',
    icon: 'bi-puzzle',
    async load(el) {
        el.innerHTML = ADM.loading('加载插件…');
        await refreshPlugins(el);
    }
});

async function refreshPlugins(el) {
    var reg = {};
    try { reg = await ADM.api('/api/plugins/registry'); } catch (e) { reg = {}; }
    var registry = (reg && reg.plugins) || {};

    /* 统计（插件数量级很小，取全量一页算启用 / 禁用） */
    var pTotal = 0, pOn = 0, pOff = 0, pHist = ((reg && reg.history) || []).length;
    try {
        var pl = await ADM.api('/api/plugins/list?page=1&page_size=200');
        pTotal = pl.total || (pl.items || []).length;
        (pl.items || []).forEach(function (r) { if (r.enabled === false) pOff++; else pOn++; });
    } catch (e) { }

    var pluginCols = [
        { label: '名称', render: function (r) { return '<span class="adm-cell-strong">' + ADM.esc(r.name || r.id) + '</span><div class="adm-hint">' + ADM.esc(r.id) + '</div>'; } },
        { label: '版本', render: function (r) { return ADM.esc(r.version || '0.0.0'); } },
        {
            label: '状态', render: function (r) {
                return r.enabled === false ? ADM.badge('已禁用', 'mute') : ADM.badge('已启用', 'ok');
            }
        },
        { label: '描述', render: function (r) { return ADM.esc(r.description || '-') || '-'; } },
        {
            label: '操作', render: function (r) {
                var id = ADM.esc(r.id);
                var toggle = r.enabled === false
                    ? '<button class="adm-btn sm" data-act="enable" data-id="' + id + '">启用</button>'
                    : '<button class="adm-btn sm" data-act="disable" data-id="' + id + '">禁用</button>';
                return '<div class="adm-btn-row">' + toggle +
                    '<button class="adm-btn sm danger" data-act="uninstall" data-id="' + id + '" data-name="' + ADM.esc(r.name || r.id) + '">卸载</button></div>';
            }
        }
    ];
    /* ---- 插件总览 ---- */
    var html = '<div class="adm-section">' + ADM.sectionHead('bi-graph-up', '插件总览',
        '<span class="adm-hint">数据来源：data/plugins 与 store.db（plugin_registry）</span>') + '<div class="adm-stat-grid">';
    html += ADM.stat('bi-puzzle', '已安装', pTotal, '启用 ' + pOn + ' · 禁用 ' + pOff);
    html += ADM.stat('bi-check-circle', '已启用', pOn, '已挂载生效');
    if (pOff) html += ADM.stat('bi-pause-circle', '已禁用', pOff, '文件保留，未加载');
    html += ADM.stat('bi-clock-arrow-down', '安装历史', pHist, '安装 / 卸载操作累计次数');
    html += '</div></div>';

    html += '<div class="adm-section">';
    html += ADM.sectionHead('bi-puzzle', '已安装插件',
        '<div class="adm-btn-row">' +
        '<input type="file" id="admPluginFile" accept=".zip" style="display:none">' +
        '<button class="adm-btn primary" id="admPluginUpload" type="button"><i class="bi bi-upload"></i> 安装插件（zip）</button></div>');
    html += ADM.servTable(pluginCols, {
        key: 'plugins',
        fetch: function (p) {
            return ADM.api('/api/plugins/list?q=' + encodeURIComponent(p.q) +
                '&page=' + p.page + '&page_size=' + p.size)
                .then(function (r) { return { items: r.items || [], total: r.total || 0 }; });
        },
        onRender: function (host) { bindPluginEvents(host, el); }
    });
    html += '</div>';

    /* 安装 / 卸载历史 */
    var history = (reg && reg.history) || [];
    html += '<div class="adm-section">' + ADM.sectionHead('bi-clock-arrow-down', '安装历史') + ADM.table([
        { label: '动作', render: function (r) { return r.action === 'install' ? ADM.badge('安装', 'ok') : ADM.badge('卸载', 'mute'); } },
        { label: '插件', render: function (r) { return ADM.esc(r.name || r.id); } },
        { label: '版本', render: function (r) { return ADM.esc(r.version || '-'); } },
        { label: '时间', render: function (r) { return ADM.esc(r.at || '-'); } }
    ], history.slice(-30).reverse(), { key: 'plugin-history', pageSize: 10 }) + '</div>';

    el.innerHTML = html;
    ADM.mountServTables(el);
    ADM.mountTables(el);

    var fileInput = el.querySelector('#admPluginFile');
    var upBtn = el.querySelector('#admPluginUpload');
    if (upBtn) upBtn.addEventListener('click', function () { fileInput.click(); });
    if (fileInput) fileInput.addEventListener('change', async function () {
        if (!fileInput.files || !fileInput.files.length) return;
        var fd = new FormData();
        fd.append('file', fileInput.files[0]);
        upBtn.disabled = true;
        try {
            await ADM.api('/api/plugins/install', { method: 'POST', form: fd });
            ADM.toast('插件安装成功', 'ok');
            await refreshPlugins(el);
        } catch (e) {
            ADM.toast(e.message, 'err');
        } finally {
            upBtn.disabled = false;
            fileInput.value = '';
        }
    });
}

/* 行内按钮绑定（分页切换后由 onRender 重新调用） */
function bindPluginEvents(host, el) {
    host.querySelectorAll('[data-act]').forEach(function (btn) {
        btn.addEventListener('click', function () { handlePluginAction(el, btn); });
    });
}

async function handlePluginAction(el, btn) {
    var id = btn.dataset.id, act = btn.dataset.act;
    if (act === 'enable' || act === 'disable') {
        await ADM.api('/api/plugins/' + encodeURIComponent(id) + '/toggle', { method: 'POST', body: { enabled: act === 'enable' } });
        ADM.toast(act === 'enable' ? '插件已启用' : '插件已禁用', 'ok');
        await refreshPlugins(el);
    } else if (act === 'uninstall') {
        var ok = await ADM.confirm('卸载插件', '确认卸载插件「' + ADM.esc(btn.dataset.name) + '」？插件文件将被删除。', '卸载');
        if (!ok) return;
        await ADM.api('/api/plugins/' + encodeURIComponent(id) + '/uninstall', { method: 'POST', body: {} });
        ADM.toast('插件已卸载', 'ok');
        await refreshPlugins(el);
    }
}

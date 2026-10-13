/* 后台管理：API 调试（Tab：请求集合 / 分组，存 store.db，复用 /api/http/collection*）。 */
ADM.modules.push({
    id: 'http',
    name: 'API 调试',
    subtitle: 'IDE 请求集合的查看与管理',
    icon: 'bi-send',
    async load(el) {
        el.innerHTML = ADM.loading('加载请求集合…');

        var inited = {};   // 各 Tab 只在首次显示时加载数据

        var html = ADM.tabs([
            {
                id: 'reqs', name: '请求集合', icon: 'bi-send', content: reqsPanelHtml(),
                onShow: function () { if (!inited.reqs) { inited.reqs = 1; mountReqsTab(el); } }
            },
            {
                id: 'groups', name: '分组', icon: 'bi-folder-fill', content: groupsPanelHtml(),
                onShow: function () { if (!inited.groups) { inited.groups = 1; loadHttpGroups(el); } }
            }
        ], { key: 'http-debug' });

        el.innerHTML = html;
        ADM.mountTabs(el);

        /* 首次进入：手动触发当前激活面板的数据加载（mountTabs 只在点击时回调 onShow） */
        var bar = el.querySelector('[data-adm-tabs="http-debug"]');
        var first = bar && bar.querySelector('.adm-tab.active');
        var firstId = first ? first.dataset.tab : 'reqs';
        if (firstId === 'reqs') { inited.reqs = 1; mountReqsTab(el); }
        else { inited.groups = 1; loadHttpGroups(el); }
    }
});

/* ---------- Tab 1：请求集合 ---------- */
function reqsPanelHtml() {
    var h = '<div class="adm-section">';
    h += ADM.sectionHead('bi-send', '请求集合',
        '<span class="adm-hint" id="httpCount" style="align-self:center"></span>');
    h += '<div id="httpReqBox"><div class="adm-table-wrap adm-table-empty">加载中…</div></div>';
    h += '<div class="adm-hint" style="margin-top:10px">这里存储的是 IDE「API 调试」面板的请求集合（含分组）。' +
        '在 IDE 里增删改会自动同步到这里；在此删除也会同步回 IDE。请求体 / 认证等完整参数只在 IDE 中展示。</div>';
    h += '</div>';
    return h;
}

function mountReqsTab(el) {
    var host = el.querySelector('#httpReqBox');
    if (!host || host.dataset.mounted) return;
    host.dataset.mounted = '1';
    var httpCols = [
        { label: '名称', render: function (r) { return '<span class="adm-cell-strong">' + ADM.esc(r.name) + '</span>'; } },
        {
            label: '方法', render: function (r) {
                var m = String(r.method || 'GET').toUpperCase();
                var tone = m === 'GET' ? 'ok' : (m === 'DELETE' ? 'bad' : (m === 'POST' ? 'info' : 'warn'));
                return ADM.badge(m, tone);
            }
        },
        { label: 'URL', render: function (r) { return ADM.esc(r.url || '（未填写）'); } },
        { label: '分组', render: function (r) { return ADM.esc(r.group || '未分组'); } },
        { label: '请求体', render: function (r) { return ADM.esc(r.body_mode || 'none'); } },
        { label: '认证', render: function (r) { return ADM.esc(r.auth || 'none'); } },
        {
            label: '操作', render: function (r) {
                return '<div class="adm-btn-row">' +
                    '<button class="adm-btn sm danger" data-act="del" data-id="' + ADM.esc(r.id) + '" data-name="' + ADM.esc(r.name) + '">删除</button></div>';
            }
        }
    ];
    /* servTable 输出的是带 data-adm-serv 的宿主 div，需要插回容器并手动挂载 */
    host.innerHTML = ADM.servTable(httpCols, {
        key: 'http-reqs',
        searchPlaceholder: '搜索名称 / URL / 方法 / 分组…',
        fetch: function (p) {
            return ADM.api('/api/http/collection/list?q=' + encodeURIComponent(p.q) +
                '&page=' + p.page + '&page_size=' + p.size)
                .then(function (r) {
                    var c = el.querySelector('#httpCount');
                    if (c) c.textContent = '共 ' + (r.total || 0) + ' 个请求，' + (r.groups || 0) + ' 个分组';
                    return { items: r.items || [], total: r.total || 0 };
                });
        },
        onRender: function (h) { bindHttpEvents(h, el); }
    });
    var serv = host.querySelector('[data-adm-serv="http-reqs"]');
    if (serv) ADM.loadServ(serv, 'http-reqs');
}

/* ---------- Tab 2：分组 ---------- */
function groupsPanelHtml() {
    var h = '<div class="adm-section">';
    h += ADM.sectionHead('bi-folder-fill', '分组',
        '<span class="adm-hint" id="groupHint" style="align-self:center"></span>');
    h += '<div id="httpGroupBox"><div class="adm-table-wrap adm-table-empty">加载中…</div></div>';
    h += '<div class="adm-hint" style="margin-top:10px">分组由 IDE「API 调试」面板的「新建分组」创建；' +
        '删除分组时组内请求会移到「未分组」，请求本身不会删除。</div>';
    h += '</div>';
    return h;
}

async function loadHttpGroups(el) {
    var box = el.querySelector('#httpGroupBox');
    var hint = el.querySelector('#groupHint');
    var d;
    try {
        d = await ADM.api('/api/http/collection/groups');
    } catch (e) {
        if (box) box.innerHTML = '<div class="adm-table-wrap adm-table-empty">加载失败：' + ADM.esc(e.message || e) +
            '（若为 404 / Not Found，请重启 Flask 服务后刷新页面）</div>';
        return;
    }
    var items = d.items || [];
    if (hint) hint.textContent = '共 ' + items.length + ' 个分组，未分组请求 ' + (d.ungrouped || 0) + ' 个';
    if (!box) return;
    if (!items.length) {
        box.innerHTML = '<div class="adm-table-wrap adm-table-empty">暂无分组（在 IDE「API 调试」面板里「新建分组」后这里会显示）</div>';
        return;
    }
    var rows = items.map(function (g) {
        return '<tr>' +
            '<td><span class="adm-cell-strong">' + ADM.esc(g.name) + '</span></td>' +
            '<td>' + (g.requests || 0) + '</td>' +
            '<td><div class="adm-btn-row">' +
            '<button class="adm-btn sm" data-gact="ren" data-id="' + ADM.esc(g.id) + '" data-name="' + ADM.esc(g.name) + '">重命名</button>' +
            '<button class="adm-btn sm danger" data-gact="del" data-id="' + ADM.esc(g.id) + '" data-name="' + ADM.esc(g.name) + '" data-cnt="' + (g.requests || 0) + '">删除</button>' +
            '</div></td></tr>';
    }).join('');
    box.innerHTML = '<div class="adm-table-wrap"><table class="adm-table"><thead><tr>' +
        '<th>分组名</th><th>请求数</th><th>操作</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
    box.querySelectorAll('[data-gact]').forEach(function (b) {
        b.addEventListener('click', async function () {
            var gid = b.dataset.id, name = b.dataset.name;
            if (b.dataset.gact === 'ren') {
                groupRenameDialog(el, gid, name);
                return;
            }
            var cnt = parseInt(b.dataset.cnt || '0', 10);
            var ok = await ADM.confirm('删除分组', '确认删除分组「' + ADM.esc(name) + '」？' +
                (cnt ? '组内 ' + cnt + ' 个请求会移到「未分组」，请求本身不会删除。' : '该分组是空的。'), '删除');
            if (!ok) return;
            await ADM.api('/api/http/collection/groups/delete', { method: 'POST', body: { id: gid } });
            ADM.toast('已删除分组', 'ok');
            await loadHttpGroups(el);
            reloadReqsTable(el);   // 请求表里的「分组」列要跟着刷新
        });
    });
}

/* 重命名分组：弹窗输入新名称 */
function groupRenameDialog(el, gid, name) {
    ADM.modal({
        title: '重命名分组 · ' + name,
        icon: 'bi-folder-fill',
        html: ADM.fieldHtml({ name: 'name', label: '分组名称', value: name }),
        okText: '保存',
        onOk: async function (box) {
            var v = ADM.readForm(box);
            var nn = String(v.name || '').trim();
            if (!nn) throw new Error('请填写分组名称');
            if (nn === name) return true;
            await ADM.api('/api/http/collection/groups/rename', { method: 'POST', body: { id: gid, name: nn } });
            ADM.toast('已重命名', 'ok');
            await loadHttpGroups(el);
            reloadReqsTable(el);
            return true;
        }
    });
}

/* 请求集合表若已挂载则重新拉取（分组变化后刷新「分组」列） */
function reloadReqsTable(el) {
    var serv = el.querySelector('[data-adm-serv="http-reqs"]');
    if (serv) ADM.loadServ(serv, 'http-reqs');
}

/* 行内按钮绑定（分页切换后由 onRender 重新调用） */
function bindHttpEvents(host, el) {
    host.querySelectorAll('[data-act="del"]').forEach(function (b) {
        b.addEventListener('click', async function () {
            var ok = await ADM.confirm('删除请求', '确认从请求集合中删除「' + ADM.esc(b.dataset.name) + '」？会同时从服务端数据库删除，IDE 端同步生效。', '删除');
            if (!ok) return;
            await ADM.api('/api/http/collection/delete', { method: 'POST', body: { id: b.dataset.id } });
            ADM.toast('已删除', 'ok');
            reloadReqsTable(el);
        });
    });
}

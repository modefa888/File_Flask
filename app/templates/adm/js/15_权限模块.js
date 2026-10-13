/* 后台管理：权限模块 —— 按角色查看并调整接口权限（角色×接口，存 store.db）。 */
ADM.modules.push({
    id: 'permissions',
    name: '权限模块',
    subtitle: '按角色查看与调整接口权限',
    icon: 'bi-shield-check',
    async load(el) {
        async function refresh() {
            el.innerHTML = ADM.loading('加载权限视图…');
            var d = await ADM.api('/api/adm/permissions');
            render(d);
        }

        function render(d) {
            var items = [{ id: 'matrix', name: '权限总览', icon: 'bi-grid-3x3-gap', content: permMatrixHtml(d, refresh) }];
            (d.roles || []).forEach(function (r) {
                items.push({ id: 'role-' + r.id, name: r.name, icon: r.icon, content: permRoleHtml(d, r, refresh) });
            });
            el.innerHTML = ADM.tabs(items, { key: 'perms' });
            ADM.mountTables(el);
            ADM.mountTabs(el);
            bindPermSnapshot(el, d, refresh);
        }

        await refresh();
    }
});

/* ---------- Tab 1：权限总览（级别汇总 + 判定规则 + 权限矩阵） ---------- */
function permMatrixHtml(d, refresh) {
    // 预先聚合「模块 → 接口清单」，供悬浮框列表复用
    var byModule = {};
    (d.items || []).forEach(function (r) {
        (byModule[r.module] = byModule[r.module] || []).push(r);
    });

    var h = '<div class="adm-section">' + ADM.sectionHead('bi-shield-check', '权限级别',
        '<span class="adm-hint">接口总数 <b>' + (d.total || 0) + '</b></span>') +
        '<div class="adm-stat-grid">';
    (d.levels || []).forEach(function (lv) {
        h += ADM.stat('bi-' + (lv.id === 'public' ? 'unlock' : (lv.id === 'member' ? 'people' : 'shield-lock')),
            lv.label + '接口', lv.count || 0, lv.desc || '');
    });
    if (d.perm_overridden) h += ADM.stat('bi-person-check', '权限已定制', d.perm_overridden, '改过角色权限的接口');
    if (d.overridden) h += ADM.stat('bi-pencil-square', '级别已改', d.overridden, '覆盖了默认级别');
    if (d.disabled) h += ADM.stat('bi-slash-circle', '已停用', d.disabled, '所有角色不可访问');
    h += '</div></div>';

    h += '<div class="adm-section">' + ADM.sectionHead('bi-info-circle', '判定规则',
        (d.snapshot ? ADM.badge('默认快照：已开启', 'info') : ADM.badge('默认快照：未开启', 'mute')) +
        '<button class="adm-btn sm" id="permSnapBtn" type="button"><i class="bi bi-database-add"></i> 生成默认快照</button>' +
        (d.snapshot ? '<button class="adm-btn sm danger" id="permSnapClear" type="button"><i class="bi bi-eraser"></i> 清除快照</button>' : '')) +
        '<div class="adm-card">' +
        '<div class="adm-hint" style="line-height:1.9">权限保存在数据库（<span class="adm-cell-mono">store.db · api_permission</span>），' +
        '鉴权时以数据库为准：</div>' +
        '<div class="adm-rule-tags" style="margin-top:10px">' +
        '<span class="adm-badge bad">1. 接口被停用 → 一律拒绝</span>' +
        '<span class="adm-badge info">2. 该「角色×接口」有手动设置 → 以记录为准</span>' +
        '<span class="adm-badge ok">3. 否则按接口访问级别推导</span>' +
        '</div>' +
        '<div class="adm-hint" style="margin-top:10px">' + ADM.esc(d.hint || '') +
        ' 在角色标签页里可对单个接口「允许 / 禁止 / 恢复默认」。</div>' +
        '<div class="adm-hint" style="margin-top:8px"><b>默认快照</b>：按当前规则把全部「角色×接口」一次性写入权限表 ' +
        '（<span class="adm-cell-mono">source=default</span>），方便直接查库 / 导出；快照仅供查看、不参与鉴权，' +
        '改接口级别或同步时会自动重建。手动设置的行（<span class="adm-cell-mono">source=manual</span>）不受影响。</div>' +
        '</div></div>';

    h += '<div class="adm-section">' + ADM.sectionHead('bi-grid-3x3-gap', '模块权限矩阵',
        '<span class="adm-hint">单元格为「该角色可访问的接口数」（不含已停用）</span>') +
        '<div class="adm-card">';
    h += ADM.table([
        { label: '模块', render: function (r) { return '<span class="adm-cell-strong">' + ADM.esc(r.name) + '</span>'; } },
        { label: '接口总数', render: function (r) { return String(r.total || 0); } },
        { label: '访客', render: function (r) { return permCountCell(r.guest); } },
        { label: '协作者', render: function (r) { return permCountCell(r.member); } },
        { label: '管理员', render: function (r) { return permCountCell(r.admin); } },
        {
            label: '操作', sortable: false, render: function (r) {
                return '<div class="adm-btn-row"><button class="adm-btn sm" data-act="view" data-mod="' +
                    ADM.esc(r.module) + '" data-name="' + ADM.esc(r.name) + '"><i class="bi bi-list-ul"></i> 查看接口</button></div>';
            }
        }
    ], d.matrix || [], {
        key: 'perm-matrix', pageSize: 15, sizes: [15, 30, 50, 100], actionsWidth: 150,
        onRender: function (host) {
            host.querySelectorAll('[data-act="view"]').forEach(function (b) {
                b.addEventListener('click', function () {
                    openModuleApiList(b.dataset.name, byModule[b.dataset.mod] || []);
                });
            });
        }
    });
    h += '</div></div>';
    return h;
}

/* 悬浮框：列出某个模块下的全部接口（含各角色允许情况） */
function openModuleApiList(name, items) {
    var h = '<div class="adm-hint" style="margin-bottom:10px">模块「' + ADM.esc(name) + '」共 <b>' +
        (items.length || 0) + '</b> 个接口</div>';
    h += ADM.table([
        { label: '方法', render: function (r) { return apiMethodBadge(r.method); } },
        { label: '路径', render: apiPathCell },
        { label: '权限', render: apiAccessBadge },
        { label: '访客', render: function (r) { return permAllowedMini('guest', r); } },
        { label: '协作者', render: function (r) { return permAllowedMini('member', r); } },
        { label: '管理员', render: function (r) { return permAllowedMini('admin', r); } }
    ], items, {
        key: 'perm-mod-' + name,
        pageSize: 10,
        empty: '该模块暂无接口',
        detailTitle: function (r) { return r.method + '  ' + r.path; }
    });
    ADM.modal({
        title: '接口列表 · ' + name, icon: 'bi-list-ul', size: 'big',
        noOk: true, cancelText: '关闭', html: h
    });
}

function permAllowedMini(role, r) {
    if (r.disabled) return ADM.badge('已停用', 'mute');
    var s = (r.allowed && r.allowed[role]) ? ADM.badge('允许', 'ok') : ADM.badge('禁止', 'bad');
    if (r.perm_override && r.perm_override[role]) s += ' ' + ADM.badge('改', 'mute');
    return s;
}

function permCountCell(n) {
    n = Number(n || 0);
    return n ? String(n) : '<span class="adm-hint">0</span>';
}

/* ---------- Tab 2~4：某个角色的接口权限（可编辑） ---------- */
function permRoleHtml(d, role, refresh) {
    var items = d.items || [];
    var allowedN = items.filter(function (r) {
        return !r.disabled && r.allowed && r.allowed[role.id];
    }).length;
    var h = '<div class="adm-section">' +
        ADM.sectionHead('bi-list-check', role.name + ' 的接口权限',
            '<span class="adm-hint">共 <b>' + items.length + '</b> 个接口，允许 <b>' + allowedN + '</b> 个</span>') +
        '<div class="adm-hint" style="margin-bottom:10px">' + ADM.esc(role.desc || '') +
        (role.id === 'guest' ? '　注意：允许访客 = 无需登录即可访问，请谨慎操作。' : '') + '</div>';
    h += ADM.table(permRoleCols(role.id), items, {
        key: 'perm-' + role.id,
        pageSize: 10,
        empty: '暂无接口',
        actionsWidth: 200,
        detailTitle: function (r) { return r.method + '  ' + r.path; },
        onRender: function (host) { bindPermActions(host, refresh); }
    });
    h += '</div>';
    return h;
}

function permRoleCols(role) {
    return [
        { label: '方法', render: function (r) { return apiMethodBadge(r.method); } },
        { label: '路径', render: apiPathCell },
        { label: '所属模块', render: function (r) { return ADM.esc(r.module_name || r.module || '-'); } },
        { label: '接口级别', render: apiAccessBadge },
        { label: '该角色', render: function (r) { return permAllowedMini(role, r); } },
        { label: '操作', sortable: false, render: function (r) { return permActionCell(role, r); } }
    ];
}

function permActionCell(role, r) {
    if (r.orphan) return '<span class="adm-hint">已失效</span>';
    if (r.disabled) return '<span class="adm-hint">已停用</span>';
    if (r.can_manage === false) return '<span class="adm-hint" title="受保护接口：不允许修改权限">受保护</span>';
    var p = ADM.esc(r.path), m = ADM.esc(r.method);
    var ov = r.perm_override && r.perm_override[role];
    var al = r.allowed && r.allowed[role];
    var btns = '';
    if (ov) {
        btns += '<button class="adm-btn sm ghost" data-pact="default" data-role="' + role +
            '" data-path="' + p + '" data-method="' + m + '">恢复默认</button>';
    }
    btns += al
        ? '<button class="adm-btn sm warn" data-pact="deny" data-role="' + role + '" data-path="' + p + '" data-method="' + m + '">禁止</button>'
        : '<button class="adm-btn sm" data-pact="allow" data-role="' + role + '" data-path="' + p + '" data-method="' + m + '">允许</button>';
    return '<div class="adm-btn-row">' + btns + '</div>';
}

function bindPermActions(host, refresh) {
    host.querySelectorAll('[data-pact]').forEach(function (b) {
        b.addEventListener('click', function () { handlePermAction(b, refresh); });
    });
}

async function handlePermAction(btn, refresh) {
    var act = btn.dataset.pact, role = btn.dataset.role;
    var path = btn.dataset.path, method = btn.dataset.method;
    var allowed = act === 'allow' ? true : (act === 'deny' ? false : null);
    var label = act === 'default' ? '恢复默认' : (act === 'deny' ? '禁止' : '允许');
    if (act !== 'default') {
        var ok = await ADM.confirm('修改权限',
            '确认把「' + ADM.esc(role) + '」对「' + method + ' ' + ADM.esc(path) + '」的权限设为「' + label + '」？',
            label);
        if (!ok) return;
    }
    await ADM.api('/api/adm/apis/permission', {
        method: 'POST', body: { role: role, path: path, method: method, allowed: allowed }
    });
    ADM.toast('权限已更新（' + label + '）', 'ok');
    await refresh();
}

/* ---------- 默认权限快照：生成 / 清除 ---------- */
function bindPermSnapshot(el, d, refresh) {
    var gen = el.querySelector('#permSnapBtn');
    if (gen) gen.addEventListener('click', async function () {
        var ok = await ADM.confirm('生成默认快照',
            '按当前权限规则，把全部「角色 × 接口」写入权限表（source=default）？<br>' +
            '快照仅供查库查看 / 导出，不参与鉴权；改接口级别或同步时会自动重建。', '生成');
        if (!ok) return;
        gen.disabled = true;
        try {
            var r = await ADM.api('/api/adm/apis/permission/materialize', { method: 'POST' });
            ADM.toast('已生成默认快照：' + (r.rows || 0) + ' 行', 'ok');
        } finally { gen.disabled = false; }
        await refresh();
    });
    var clr = el.querySelector('#permSnapClear');
    if (clr) clr.addEventListener('click', async function () {
        var ok = await ADM.confirm('清除默认快照',
            '删除权限表中所有默认快照行（手动设置的权限会保留）？', '清除');
        if (!ok) return;
        clr.disabled = true;
        try {
            var r = await ADM.api('/api/adm/apis/permission/clear', { method: 'POST' });
            ADM.toast('已清除默认快照：' + (r.removed || 0) + ' 行', 'ok');
        } finally { clr.disabled = false; }
        await refresh();
    });
}

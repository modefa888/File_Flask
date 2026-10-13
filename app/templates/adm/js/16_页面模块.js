/* 后台管理：页面模块 —— 系统全部「页面」的清单与管理。
 * 登录页 / 注册页 / 分享页 / IDE 编辑页 / 文件管理首页 / 移动版 / 协作页 / 后台页等。
 * 数据来自接口登记表（store.db），与「接口模块 / 权限模块」共用同一份权威数据：
 * 这里改的说明 / 访问级别 / 停用，与接口模块里的改动一致，鉴权口径完全统一。 */
ADM.modules.push({
    id: 'pages',
    name: '页面模块',
    subtitle: '登录 / 分享 / 编辑 / 文件管理等全部页面的管理',
    icon: 'bi-window-stack',
    async load(el) {
        var group = '';                  // 当前分组过滤：'' / 分组名
        var access = '';                 // 当前访问级别过滤：'' / public / member / admin
        var sum = {}, all = [];

        async function fetchAll() {
            sum = await ADM.api('/api/adm/pages/summary');
            var list = await ADM.api('/api/adm/pages');   // 一次性拿全量，前端过滤 / 分页
            all = list.items || [];
        }

        function rows() {
            return all.filter(function (r) {
                if (group && r.group !== group) return false;
                if (access && r.access !== access) return false;
                return true;
            });
        }

        function drawTable() {
            var host = el.querySelector('#pageTableHost');
            if (!host) return;
            host.innerHTML = ADM.table(pageCols(), rows(), {
                key: 'pages',
                empty: '没有符合条件的页面',
                actionsWidth: 300,
                detailTitle: function (r) { return r.name + '  ' + r.path; },
                onRender: function (h) { bindPageRowActions(h, refresh); }
            });
            ADM.mountTables(host);
        }

        function render() {
            var html = '';

            /* ---- 汇总统计 ---- */
            html += '<div class="adm-section">' + ADM.sectionHead('bi-window-stack', '页面总览',
                '<span class="adm-hint">页面总数 <b>' + (sum.total || 0) + '</b> · 数据来源：store.db（接口登记表）</span>') +
                '<div class="adm-stat-grid">';
            (sum.levels || []).forEach(function (lv) {
                html += ADM.stat('bi-' + (lv.id === 'public' ? 'unlock' : (lv.id === 'member' ? 'people' : 'shield-lock')),
                    lv.label + '页面', lv.count || 0,
                    lv.id === 'public' ? '无需登录' : (lv.id === 'member' ? '协作者可用' : '仅管理员'));
            });
            html += ADM.stat('bi-window', '页面数', sum.pages || 0, 'HTML 页面');
            if (sum.resources) html += ADM.stat('bi-box', '资源路由', sum.resources, '二维码 / 封面 / 下载等');
            html += ADM.stat('bi-graph-up-arrow', '累计访问', sum.requests || 0,
                '成功 ' + ((sum.requests || 0) - (sum.failed || 0)) + ' · 失败 ' + (sum.failed || 0));
            if (sum.overridden) html += ADM.stat('bi-pencil-square', '已改级别', sum.overridden, '覆盖了默认级别');
            if (sum.disabled) html += ADM.stat('bi-slash-circle', '已停用', sum.disabled, '所有角色不可访问');
            if (sum.orphan) html += ADM.stat('bi-exclamation-triangle', '已失效', sum.orphan, '代码中已不存在该路由');
            html += '</div></div>';

            /* ---- 按分组统计（点击分组 → 过滤下方列表） ---- */
            html += '<div class="adm-section">' + ADM.sectionHead('bi-collection', '按分组查看',
                '<span class="adm-hint">点击分组可筛选页面</span>') +
                '<div class="adm-card"><div class="adm-rule-tags" id="pageGroupStats">';
            html += '<button type="button" class="adm-module-chip' + (group === '' ? ' on' : '') +
                '" data-group="" title="显示全部页面">全部 · ' + (sum.total || 0) + '</button>';
            (sum.groups || []).forEach(function (g) {
                var tip = '公开 ' + g.public + ' · 协作者 ' + g.member + ' · 仅管理员 ' + g.admin +
                    (g.disabled ? ' · 已停用 ' + g.disabled : '');
                html += '<button type="button" class="adm-module-chip' + (group === g.group ? ' on' : '') +
                    '" data-group="' + ADM.esc(g.group) + '" title="' + ADM.esc(tip) + '">' +
                    ADM.esc(g.group) + ' · ' + g.total + '</button>';
            });
            html += '</div></div></div>';

            /* ---- 页面清单 ---- */
            html += '<div class="adm-section">' + ADM.sectionHead('bi-list-ul', '页面清单',
                '<span class="adm-hint" style="align-self:center">访问级别</span>' +
                '<select class="adm-select" id="pageAccessFilter" style="padding:5px 9px;font-size:12.5px">' +
                '<option value="">全部</option>' +
                '<option value="public">公开</option>' +
                '<option value="member">协作者</option>' +
                '<option value="admin">仅管理员</option>' +
                '</select>' +
                '<button class="adm-btn sm ghost" id="pageSyncBtn" type="button"><i class="bi bi-arrow-repeat"></i> 同步页面</button>') +
                '<div id="pageTableHost"></div>' +
                '<div class="adm-hint" style="margin-top:10px">' +
                '「打开」在新标签页预览该页面（带路径参数或非 HTML 资源的页面不提供）；' +
                '「编辑」可改用途说明与访问级别（留空恢复默认）；「停用」后所有角色都无法访问该页面（返回 403）。' +
                '登录页、注册入口、后台页面、静态资源与协作通道为受保护页面，不允许停用或改级别。' +
                '<b>同步页面</b>会从代码路由刷新登记表：新增页面自动登记、已移除的标记为「已失效」。' +
                '<b>点击表头</b>可按该列排序；点击任意一行可查看完整信息。' +
                '</div></div>';

            el.innerHTML = html;

            var sel = el.querySelector('#pageAccessFilter');
            if (sel) {
                sel.value = access;
                sel.addEventListener('change', function () { access = sel.value; drawTable(); });
            }
            var syncBtn = el.querySelector('#pageSyncBtn');
            if (syncBtn) syncBtn.addEventListener('click', function () { doPageSync(syncBtn, refresh); });
            var stats = el.querySelector('#pageGroupStats');
            if (stats) stats.querySelectorAll('[data-group]').forEach(function (b) {
                b.addEventListener('click', function () {
                    group = b.dataset.group || '';
                    stats.querySelectorAll('[data-group]').forEach(function (x) {
                        x.classList.toggle('on', (x.dataset.group || '') === group);
                    });
                    drawTable();
                });
            });
            drawTable();
        }

        async function refresh() {
            el.innerHTML = ADM.loading('加载页面清单…');
            await fetchAll();
            render();
        }

        await refresh();
    }
});

/* ---------- 页面清单表格列 ---------- */
function pageCols() {
    return [
        { label: '页面', render: pageNameCell },
        { label: '路径', render: pagePathCell },
        { label: '分组', render: function (r) { return ADM.badge(r.group || '-', 'mute'); } },
        { label: '访问级别', render: pageAccessCell },
        { label: '访问次数', render: pageReqCell, sortVal: function (r) { return Number(r.total || 0); } },
        { label: '状态', render: pageStatusCell },
        { label: '操作', sortable: false, render: pageActionCell }
    ];
}

function pageNameCell(r) {
    return '<span class="adm-cell-strong"><i class="bi ' + ADM.esc(r.icon || 'bi-file-earmark') + '"></i> ' +
        ADM.esc(r.name || r.path) + '</span>' +
        (r.type && r.type !== '页面' ? ' ' + ADM.badge(r.type, 'mute') : '');
}

function pagePathCell(r) {
    return '<span class="adm-cell-mono" title="' + ADM.esc(r.path || '') + '">' + ADM.esc(r.path || '-') + '</span>';
}

function pageAccessCell(r) {
    var tone = r.access === 'public' ? 'ok' : (r.access === 'member' ? 'info' : 'warn');
    var s = ADM.badge(r.access_label || r.access || '-', tone);
    if (r.overridden) s += ' ' + ADM.badge('已改', 'mute');
    return s;
}

function pageStatusCell(r) {
    if (r.orphan) return ADM.badge('已失效', 'mute');
    if (r.disabled) return ADM.badge('已停用', 'bad');
    return ADM.badge('正常', 'ok');
}

/* 访问次数（含成功 / 失败）；悬停显示成功/失败/最近访问 */
function pageReqCell(r) {
    var t = Number(r.total || 0);
    if (!t) return '<span class="adm-hint">0</span>';
    var tip = '成功 ' + (r.ok || 0) + ' · 失败 ' + (r.fail || 0) +
        (r.last_at ? ' · 最近 ' + ADM.dt(r.last_at) + '（HTTP ' + (r.last_status || 0) + '）' : '');
    var s = '<span class="adm-cell-strong" title="' + ADM.esc(tip) + '">' + t + '</span>';
    if (r.fail) s += ' ' + ADM.badge(String(r.fail), 'bad');
    return s;
}

/* 页面「操作」列：打开预览 / 编辑（说明 + 访问级别）/ 停用启用 */
function pageActionCell(r) {
    if (r.orphan) return '<span class="adm-hint" title="代码中已无此路由">已失效</span>';
    var p = ADM.esc(r.path);
    var open = r.href
        ? '<a class="adm-btn sm ghost" href="' + ADM.esc(r.href) + '" target="_blank" rel="noopener" title="在新标签页打开该页面"><i class="bi bi-box-arrow-up-right"></i> 打开</a>'
        : '<span class="adm-hint" title="该页面带路径参数或为资源，无法直接打开"><i class="bi bi-dash"></i></span>';
    var edit = '<button class="adm-btn sm" data-pact="edit" data-path="' + p +
        '" data-access="' + ADM.esc(r.access_override || '') + '" data-default="' + ADM.esc(r.access_default || '') +
        '" data-manage="' + (r.can_manage === false ? '0' : '1') +
        '" data-desc="' + ADM.esc(r.desc || '') + '">编辑</button>';
    if (r.can_manage === false) {
        return '<div class="adm-btn-row">' + open + edit +
            '<span class="adm-hint" title="受保护页面：不允许停用或改级别">受保护</span></div>';
    }
    var toggle = r.disabled
        ? '<button class="adm-btn sm" data-pact="enable" data-path="' + p + '">启用</button>'
        : '<button class="adm-btn sm warn" data-pact="disable" data-path="' + p + '">停用</button>';
    return '<div class="adm-btn-row">' + open + edit + toggle + '</div>';
}

/* ---------- 行内按钮事件 ---------- */
function bindPageRowActions(host, refresh) {
    host.querySelectorAll('[data-pact="edit"]').forEach(function (b) {
        b.addEventListener('click', function () { openPageEditDialog(b, refresh); });
    });
    host.querySelectorAll('[data-pact="disable"]').forEach(function (b) {
        b.addEventListener('click', function () { togglePageDisabled(b, true, refresh); });
    });
    host.querySelectorAll('[data-pact="enable"]').forEach(function (b) {
        b.addEventListener('click', function () { togglePageDisabled(b, false, refresh); });
    });
}

function openPageEditDialog(btn, refresh) {
    var path = btn.dataset.path;
    var a = btn.dataset.access || '', def = btn.dataset.default || '', desc = btn.dataset.desc || '';
    var manageable = btn.dataset.manage !== '0';
    var html = ADM.fieldHtml({ name: 'desc', label: '用途说明', type: 'textarea', value: desc, placeholder: '给这个页面写一句说明，便于后续维护' });
    if (manageable) {
        html += '<div class="adm-hint" style="margin:6px 0 12px">该页面的代码默认级别为「' + ADM.esc(apiLevelLabel(def)) +
            '」，选择「跟随默认」即清除此前的覆盖。</div>' +
            ADM.fieldHtml({
                name: 'access', label: '访问级别', type: 'select', value: a, options: [
                    { value: '', label: '跟随默认（' + apiLevelLabel(def) + '）' },
                    { value: 'public', label: '公开（无需登录）' },
                    { value: 'member', label: '协作者（登录后 member 可访问）' },
                    { value: 'admin', label: '仅管理员' }
                ]
            });
    } else {
        html += '<div class="adm-hint" style="margin:8px 0 4px">该页面为受保护页面（如登录入口 / 后台页面），' +
            '其访问级别由代码固定，此处只能修改用途说明。</div>';
    }
    ADM.modal({
        title: '编辑页面 · ' + path,
        icon: 'bi-window-stack',
        html: html,
        okText: '保存',
        onOk: async function (box) {
            var v = ADM.readForm(box);
            var body = { path: path, desc: v.desc };
            if (manageable) body.access = v.access;
            await ADM.api('/api/adm/pages/update', { method: 'POST', body: body });
            ADM.toast('页面已更新', 'ok');
            await refresh();
            return true;
        }
    });
}

async function togglePageDisabled(btn, disabled, refresh) {
    var path = btn.dataset.path;
    var ok = await ADM.confirm(disabled ? '停用页面' : '启用页面',
        disabled
            ? '确认停用「' + ADM.esc(path) + '」？停用后所有角色都无法访问该页面（返回 403、页面显示停用提示）。'
            : '确认重新启用「' + ADM.esc(path) + '」？将按当前访问级别恢复访问。',
        disabled ? '停用页面' : '启用页面');
    if (!ok) return;
    await ADM.api('/api/adm/pages/update', { method: 'POST', body: { path: path, disabled: disabled } });
    ADM.toast(disabled ? '页面已停用' : '页面已启用', 'ok');
    await refresh();
}

async function doPageSync(btn, refresh) {
    btn.disabled = true;
    try {
        var r = await ADM.api('/api/adm/apis/sync', { method: 'POST' });
        var s = r.sync || {};
        ADM.toast('已同步：登记 ' + (s.total || 0) + ' 个页面 / 接口，失效 ' + (s.orphan || 0) + ' 个', 'ok');
    } finally {
        btn.disabled = false;
    }
    await refresh();
}

/* 后台管理：接口模块 —— 接口登记表（清单 / 说明 / 访问级别 / 停用）。数据存 store.db。 */
ADM.modules.push({
    id: 'apis',
    name: '接口模块',
    subtitle: '接口登记表：清单、说明、访问权限与停用',
    icon: 'bi-diagram-3',
    async load(el) {
        var access = '';                 // 当前访问级别过滤：'' / public / member / admin
        var sum = {}, all = [];

        async function fetchAll() {
            sum = await ADM.api('/api/adm/apis/summary');
            var list = await ADM.api('/api/adm/apis');   // 不传 page：一次性拿全量
            all = list.items || [];
        }

        function rows() {
            return access ? all.filter(function (r) { return r.access === access; }) : all;
        }

        function drawTable() {
            var host = el.querySelector('#apiTableHost');
            if (!host) return;
            host.innerHTML = ADM.table(apiCatalogCols(), rows(), {
                key: 'apis',
                empty: '没有符合条件的接口',
                actionsWidth: 300,
                detailTitle: function (r) { return r.method + '  ' + r.path; },
                onRender: function (h) { bindApiRowActions(h, refresh); }
            });
            ADM.mountTables(host);
        }

        function render() {
            var html = '';

            /* ---- 汇总统计 ---- */
            html += '<div class="adm-section">' + ADM.sectionHead('bi-diagram-3', '接口总览',
                '<span class="adm-hint">接口总数 <b>' + (sum.total || 0) + '</b> · 数据来源：store.db（接口登记表）</span>') +
                '<div class="adm-stat-grid">';
            (sum.levels || []).forEach(function (lv) {
                html += ADM.stat('bi-' + (lv.id === 'public' ? 'unlock' : (lv.id === 'member' ? 'people' : 'shield-lock')),
                    lv.label + '接口', lv.count || 0,
                    lv.id === 'public' ? '无需登录' : (lv.id === 'member' ? '协作者可用' : '仅管理员'));
            });
            html += ADM.stat('bi-hdd-network', '接口总数', sum.total || 0, '当前登记（不含失效）');
            html += ADM.stat('bi-graph-up-arrow', '累计请求', sum.requests || 0,
                '成功 ' + ((sum.requests || 0) - (sum.failed || 0)) + ' · 失败 ' + (sum.failed || 0));
            if (sum.overridden) html += ADM.stat('bi-pencil-square', '已改级别', sum.overridden, '覆盖了默认级别');
            if (sum.perm_overridden) html += ADM.stat('bi-person-check', '权限已定制', sum.perm_overridden, '在权限模块改过角色权限');
            if (sum.disabled) html += ADM.stat('bi-slash-circle', '已停用', sum.disabled, '所有角色不可访问');
            if (sum.orphan) html += ADM.stat('bi-exclamation-triangle', '已失效', sum.orphan, '代码中已不存在该路由');
            html += '</div></div>';

            /* ---- 按模块统计（点击模块 → 弹出该模块的接口列表） ---- */
            html += '<div class="adm-section">' + ADM.sectionHead('bi-collection', '按模块统计',
                '<span class="adm-hint">点击模块可查看其接口列表</span>') +
                '<div class="adm-card"><div class="adm-rule-tags" id="apiModuleStats">';
            (sum.modules || []).forEach(function (m) {
                var tip = '公开 ' + m.public + ' · 协作者 ' + m.member + ' · 仅管理员 ' + m.admin +
                    (m.disabled ? ' · 已停用 ' + m.disabled : '');
                html += '<button type="button" class="adm-module-chip" data-mod="' + ADM.esc(m.module) +
                    '" data-name="' + ADM.esc(m.name) + '" title="' + tip + '">' +
                    ADM.esc(m.name) + ' · ' + m.total + '</button>';
            });
            html += '</div></div></div>';

            /* ---- 接口目录 ---- */
            html += '<div class="adm-section">' + ADM.sectionHead('bi-list-ul', '接口目录',
                '<span class="adm-hint" style="align-self:center">访问级别</span>' +
                '<select class="adm-select" id="apiAccessFilter" style="padding:5px 9px;font-size:12.5px">' +
                '<option value="">全部</option>' +
                '<option value="public">公开</option>' +
                '<option value="member">协作者</option>' +
                '<option value="admin">仅管理员</option>' +
                '</select>' +
                '<button class="adm-btn sm ghost" id="apiSyncBtn" type="button"><i class="bi bi-arrow-repeat"></i> 同步接口</button>' +
                '<button class="adm-btn sm ghost" id="apiStatsReset" type="button"><i class="bi bi-eraser"></i> 清零统计</button>' +
                (sum.orphan ? '<button class="adm-btn sm danger" id="apiCleanBtn" type="button"><i class="bi bi-trash3"></i> 清理失效</button>' : '')) +
                '<div id="apiTableHost"></div>' +
                '<div class="adm-hint" style="margin-top:10px">' +
                '「编辑」可改说明与访问级别（留空恢复默认）；「停用」后所有角色都无法访问（接口返回 403）。' +
                '「测试」会在悬浮框里以当前登录会话向该接口发一次真实请求，可填路径 / 查询参数与请求体。' +
                '「请求次数」为累计调用量（含成功与失败，统计在 store.db 的 api_stats 表，后台每数秒批量落库）。' +
                '登录入口、静态资源与后台管理接口为受保护接口，不允许停用或改权限。<b>同步接口</b>会从代码路由刷新登记表：' +
                '新增路由自动登记、已移除的路由标记为「已失效」。' +
                '<b>点击表头</b>可按该列排序（再点一次切换升 / 降序）。点击任意一行可查看完整信息。' +
                '</div></div>';

            el.innerHTML = html;

            var sel = el.querySelector('#apiAccessFilter');
            if (sel) {
                sel.value = access;
                sel.addEventListener('change', function () { access = sel.value; drawTable(); });
            }
            var syncBtn = el.querySelector('#apiSyncBtn');
            if (syncBtn) syncBtn.addEventListener('click', function () { doSync(syncBtn, refresh); });
            var cleanBtn = el.querySelector('#apiCleanBtn');
            if (cleanBtn) cleanBtn.addEventListener('click', function () { doCleanup(cleanBtn, refresh); });
            var resetBtn = el.querySelector('#apiStatsReset');
            if (resetBtn) resetBtn.addEventListener('click', function () { doResetStats(resetBtn, refresh); });
            var stats = el.querySelector('#apiModuleStats');
            if (stats) stats.querySelectorAll('[data-mod]').forEach(function (b) {
                b.addEventListener('click', function () {
                    var mod = b.dataset.mod || '';
                    openModuleInterfaces(b.dataset.name, function () {
                        return all.filter(function (r) {
                            return !r.orphan && (r.module || '') === mod;
                        });
                    }, refresh);
                });
            });
            drawTable();
        }

        async function refresh() {
            el.innerHTML = ADM.loading('加载接口目录…');
            await fetchAll();
            render();
        }

        await refresh();
    }
});

/* ---------- 两个面板共用的单元格渲染工具 ---------- */
function apiMethodBadge(m) {
    var mm = String(m || 'GET').toUpperCase();
    var tone = mm === 'GET' ? 'ok' : (mm === 'DELETE' ? 'bad' : (mm === 'POST' ? 'info' : 'warn'));
    return ADM.badge(mm, tone);
}

function apiLevelLabel(id) {
    return { public: '公开', member: '协作者', admin: '仅管理员' }[id] || '未知';
}

function apiAccessBadge(r) {
    var tone = r.access === 'public' ? 'ok' : (r.access === 'member' ? 'info' : 'warn');
    var s = ADM.badge(r.access_label || r.access || '-', tone);
    if (r.overridden) s += ' ' + ADM.badge('已改', 'mute');
    return s;
}

function apiPathCell(r) {
    return '<span class="adm-cell-mono" title="' + ADM.esc(r.path || '') + '">' + ADM.esc(r.path || '-') + '</span>';
}

function apiDescCell(r) {
    if (r.desc) return ADM.esc(r.desc);
    return '<span class="adm-cell-mono" title="' + ADM.esc(r.endpoint || '') + '">' + ADM.esc(r.endpoint || '-') + '</span>';
}

/* 接口目录表格列；withAccess=false 时省略「权限」列（用于按角色的权限清单） */
function apiCols(withAccess) {
    var cols = [
        { label: '方法', render: function (r) { return apiMethodBadge(r.method); } },
        { label: '路径', render: apiPathCell },
        { label: '所属模块', render: function (r) { return ADM.esc(r.module_name || r.module || '-'); } },
        { label: '类型', render: function (r) { return ADM.badge(r.kind || '-', 'mute'); } }
    ];
    if (withAccess) {
        cols.push({ label: '权限', render: apiAccessBadge });
    }
    cols.push({ label: '说明', render: apiDescCell });
    return cols;
}

/* 接口「操作」列：测试（悬浮框内发真实请求）/ 编辑（说明 + 访问级别）/ 停用启用；失效接口只给提示 */
function apiActionCell(r) {
    if (r.orphan) return '<span class="adm-hint" title="代码中已无此路由">已失效</span>';
    var p = ADM.esc(r.path), m = ADM.esc(r.method);
    var test = '<button class="adm-btn sm" data-act="test" data-path="' + p + '" data-method="' + m +
        '" title="在悬浮框内填参数并真实请求一次"><i class="bi bi-play"></i> 测试</button>';
    if (r.can_manage === false) {
        return '<div class="adm-btn-row">' + test +
            '<span class="adm-hint" title="受保护接口：不允许停用或改权限">受保护</span></div>';
    }
    var toggle = r.disabled
        ? '<button class="adm-btn sm" data-act="enable" data-path="' + p + '" data-method="' + m + '">启用</button>'
        : '<button class="adm-btn sm warn" data-act="disable" data-path="' + p + '" data-method="' + m + '">停用</button>';
    return '<div class="adm-btn-row">' + test +
        '<button class="adm-btn sm" data-act="edit" data-path="' + p + '" data-method="' + m +
        '" data-access="' + ADM.esc(r.access_override || '') + '" data-default="' + ADM.esc(r.access_default || '') +
        '" data-desc="' + ADM.esc(r.desc || '') + '">编辑</button>' + toggle + '</div>';
}

/* 接口模块主表列：方法 / 路径 / 模块 / 权限 / 请求次数 / 说明 / 状态 / 操作 */
function apiCatalogCols() {
    return [
        { label: '方法', render: function (r) { return apiMethodBadge(r.method); } },
        { label: '路径', render: apiPathCell },
        { label: '所属模块', render: function (r) { return ADM.esc(r.module_name || r.module || '-'); } },
        { label: '权限', render: apiAccessBadge },
        { label: '请求次数', render: apiReqCell, sortVal: function (r) { return Number(r.total || 0); } },
        { label: '说明', render: apiDescCell },
        { label: '状态', render: apiStatusCell },
        { label: '操作', sortable: false, render: apiActionCell }
    ];
}

/* 模块接口悬浮框的列：同一模块，省略「所属模块」，但保留操作按钮 */
function apiModalCols() {
    return [
        { label: '方法', render: function (r) { return apiMethodBadge(r.method); } },
        { label: '路径', render: apiPathCell },
        { label: '权限', render: apiAccessBadge },
        { label: '请求次数', render: apiReqCell, sortVal: function (r) { return Number(r.total || 0); } },
        { label: '状态', render: apiStatusCell },
        { label: '说明', render: apiDescCell },
        { label: '操作', sortable: false, render: apiActionCell }
    ];
}

function apiStatusCell(r) {
    if (r.orphan) return ADM.badge('已失效', 'mute');
    if (r.disabled) return ADM.badge('已停用', 'bad');
    return ADM.badge('正常', 'ok');
}

/* 累计请求次数（含成功 / 失败）；鼠标悬停显示成功/失败/最近时间 */
function apiReqCell(r) {
    var t = Number(r.total || 0);
    if (!t) return '<span class="adm-hint">0</span>';
    var tip = '成功 ' + (r.ok || 0) + ' · 失败 ' + (r.fail || 0) +
        (r.last_at ? ' · 最近 ' + ADM.dt(r.last_at) + '（HTTP ' + (r.last_status || 0) + '）' : '');
    var s = '<span class="adm-cell-strong" title="' + ADM.esc(tip) + '">' + t + '</span>';
    if (r.fail) s += ' ' + ADM.badge(String(r.fail), 'bad');
    return s;
}

/* 悬浮框：列出某个模块下的接口（点击「按模块统计」里的模块进入）。
 * getItems() 每次现取该模块的接口（保证编辑 / 停用后弹窗内容与页面同步），
 * refresh() 重新拉取页面数据；两者配合让弹窗内的操作按钮改完立即刷新。 */
function openModuleInterfaces(name, getItems, refresh) {
    ADM.modal({
        title: '接口列表 · ' + name,
        icon: 'bi-collection',
        size: 'big',
        noOk: true,
        cancelText: '关闭',
        html: '<div id="apiModHost"></div>',
        onOpen: function (box) {
            function draw() {
                var items = getItems() || [];
                var host = box.querySelector('#apiModHost');
                if (!host) return;
                host.innerHTML =
                    '<div class="adm-hint" style="margin-bottom:10px">模块「' + ADM.esc(name) + '」共 <b>' +
                    items.length + '</b> 个接口</div>' +
                    ADM.table(apiModalCols(), items, {
                        key: 'api-mod-' + name,
                        pageSize: 10,
                        empty: '该模块暂无接口',
                        actionsWidth: 300,
                        detailTitle: function (r) { return r.method + '  ' + r.path; },
                        onRender: function (h) { bindApiRowActions(h, reload); }
                    });
                ADM.mountTables(host);
            }
            async function reload() {
                await refresh();      // 刷新页面（汇总 + 全量接口）
                draw();               // 弹窗内容随之重绘
            }
            draw();
        }
    });
}

/* ---------- 行内按钮事件 ---------- */
function bindApiRowActions(host, refresh) {
    host.querySelectorAll('[data-act="test"]').forEach(function (b) {
        b.addEventListener('click', function () { openApiTestDialog(b); });
    });
    host.querySelectorAll('[data-act="edit"]').forEach(function (b) {
        b.addEventListener('click', function () { openApiEditDialog(b, refresh); });
    });
    host.querySelectorAll('[data-act="disable"]').forEach(function (b) {
        b.addEventListener('click', function () { toggleApiDisabled(b, true, refresh); });
    });
    host.querySelectorAll('[data-act="enable"]').forEach(function (b) {
        b.addEventListener('click', function () { toggleApiDisabled(b, false, refresh); });
    });
}

function openApiEditDialog(btn, refresh) {
    var path = btn.dataset.path, method = btn.dataset.method;
    var access = btn.dataset.access || '', def = btn.dataset.default || '', desc = btn.dataset.desc || '';
    ADM.modal({
        title: '编辑接口 · ' + method + ' ' + path,
        icon: 'bi-sliders',
        html:
            ADM.fieldHtml({ name: 'desc', label: '说明', type: 'textarea', value: desc, placeholder: '给这个接口写一句说明，便于后续维护' }) +
            '<div class="adm-hint" style="margin:6px 0 12px">该接口的代码默认级别为「' + ADM.esc(apiLevelLabel(def)) +
            '」，选择「跟随默认」即清除此前的覆盖。</div>' +
            ADM.fieldHtml({
                name: 'access', label: '访问级别', type: 'select', value: access, options: [
                    { value: '', label: '跟随默认（' + apiLevelLabel(def) + '）' },
                    { value: 'public', label: '公开（无需登录）' },
                    { value: 'member', label: '协作者（登录后 member 可访问）' },
                    { value: 'admin', label: '仅管理员' }
                ]
            }),
        okText: '保存',
        onOk: async function (box) {
            var v = ADM.readForm(box);
            await ADM.api('/api/adm/apis/update', {
                method: 'POST',
                body: { path: path, method: method, desc: v.desc, access: v.access }
            });
            ADM.toast('接口已更新', 'ok');
            await refresh();
            return true;
        }
    });
}

/* ---------- 接口测试 ----------
 * 悬浮框里以当前登录会话向该接口发一次真实请求（fetch 同源带 Cookie），
 * 可填 Flask 路由的路径参数 <...>、查询参数（每行 key=value）与请求体。
 * 响应只在前端展示：状态码 / 耗时 / Content-Type / 格式化后的内容。
 * 注意：请求会像正常调用一样被计入接口请求统计（api_stats）。 */
function openApiTestDialog(btn) {
    var path = btn.dataset.path, method = (btn.dataset.method || 'GET').toUpperCase();
    var segs = path.match(/<[^<>]*>/g) || [];   // 路由里的路径参数，如 /share/<token>、/api/file/<path:subpath>
    var html = '<div class="adm-hint" style="margin-bottom:10px">以当前登录会话请求 <span class="adm-cell-mono">' +
        ADM.esc(method + ' ' + path) + '</span>。停用 / 权限不足的接口会按服务端规则返回 401 / 403。</div>';
    if (segs.length) {
        html += '<div class="adm-field"><label>路径参数</label>' + segs.map(function (s, i) {
            return '<input class="adm-input" name="seg_' + i + '" placeholder="' + ADM.esc(s) + '" style="margin-bottom:6px" spellcheck="false">';
        }).join('') + '</div>';
    }
    html += ADM.fieldHtml({ name: 'query', label: '查询参数（每行 key=value，可留空）', type: 'textarea', placeholder: 'q=关键字\npage=1' }) +
        ADM.fieldHtml({ name: 'body', label: '请求体（JSON 或原文，可留空；GET 一般留空）', type: 'textarea', placeholder: '{"name": "value"}' }) +
        '<div id="apiTestOut"><div class="adm-hint">填写参数后点击左下角「发送请求」，响应会显示在这里。</div></div>';

    ADM.modal({
        title: '测试接口 · ' + method + ' ' + path,
        icon: 'bi-play-circle',
        size: 'big',
        noOk: true,
        cancelText: '关闭',
        html: html,
        footer: '<button class="adm-btn primary" type="button" data-adm-test-send><i class="bi bi-send"></i> 发送请求</button>',
        onOpen: function (box) {
            var sendBtn = box.querySelector('[data-adm-test-send]');
            if (sendBtn) sendBtn.addEventListener('click', function () { runApiTest(box, path, method, segs, sendBtn); });
        }
    });
}

async function runApiTest(box, path, method, segs, sendBtn) {
    var out = box.querySelector('#apiTestOut');
    if (!out) return;
    var v = ADM.readForm(box);

    /* 路径参数替换：<path:...> 允许带 /（逐段编码），其余按单段编码 */
    var url = path;
    for (var i = 0; i < segs.length; i++) {
        var raw = String(v['seg_' + i] || '').trim();
        if (!raw) { ADM.toast('请填写路径参数 ' + segs[i], 'warn'); return; }
        var enc = segs[i].indexOf('path:') >= 0
            ? raw.split('/').map(encodeURIComponent).join('/')
            : encodeURIComponent(raw);
        url = url.replace(segs[i], enc);
    }

    /* 查询参数：每行 key=value（在第一个 = 处切分，value 里可以再带 =） */
    var qs = [];
    String(v.query || '').split('\n').forEach(function (line) {
        line = line.trim();
        if (!line) return;
        var eq = line.indexOf('=');
        if (eq < 1) return;
        qs.push(encodeURIComponent(line.slice(0, eq)) + '=' + encodeURIComponent(line.slice(eq + 1)));
    });
    if (qs.length) url += (url.indexOf('?') >= 0 ? '&' : '?') + qs.join('&');

    /* 请求体：能解析成 JSON 就按 application/json 发，否则按纯文本；GET/HEAD 不允许带 body */
    var opts = { method: method, credentials: 'same-origin', headers: {} };
    var bodyText = String(v.body || '').trim();
    if (bodyText && method !== 'GET' && method !== 'HEAD') {
        opts.headers['Content-Type'] = 'application/json';
        try { JSON.parse(bodyText); } catch (e) { opts.headers['Content-Type'] = 'text/plain;charset=utf-8'; }
        opts.body = bodyText;
    }

    sendBtn.disabled = true;
    out.innerHTML = '<div class="adm-hint">请求中…</div>';
    try {
        var t0 = performance.now();
        var resp = await fetch(url, opts);
        var ms = Math.round(performance.now() - t0);
        var text = await resp.text();
        var ct = resp.headers.get('content-type') || '';
        var pretty = text;
        if (/json/i.test(ct) || /^[ \t]*[\[{]/.test(text)) {
            try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch (e) { /* 非 JSON，保持原文 */ }
        }
        if (pretty.length > 20000) pretty = pretty.slice(0, 20000) + '\n…（响应过长已截断，共 ' + pretty.length + ' 字符）';
        out.innerHTML =
            '<div style="margin-bottom:8px">' + ADM.badge('HTTP ' + resp.status, resp.ok ? 'ok' : 'bad') +
            '<span class="adm-hint" style="margin-left:8px">耗时 ' + ms + ' ms · ' + ADM.esc(ct || '无 Content-Type') + '</span></div>' +
            '<pre style="margin:0;max-height:340px;overflow:auto;background:var(--adm-bg-soft,#f6f8fa);border:1px solid var(--adm-border-soft,#e5e7eb);border-radius:6px;padding:10px;font-size:12px;line-height:1.5;white-space:pre-wrap;word-break:break-all">' +
            ADM.esc(pretty) + '</pre>';
    } catch (e) {
        out.innerHTML = '<div class="adm-hint">请求失败：' + ADM.esc(String((e && e.message) || e)) + '</div>';
    } finally {
        sendBtn.disabled = false;
    }
}

async function toggleApiDisabled(btn, disabled, refresh) {
    var path = btn.dataset.path, method = btn.dataset.method;
    var ok = await ADM.confirm(disabled ? '停用接口' : '启用接口',
        disabled
            ? '确认停用「' + method + ' ' + ADM.esc(path) + '」？停用后所有角色都无法访问该接口（接口返回 403、页面显示停用提示）。'
            : '确认重新启用「' + method + ' ' + ADM.esc(path) + '」？将按当前访问级别恢复访问。',
        disabled ? '停用接口' : '启用接口');
    if (!ok) return;
    await ADM.api('/api/adm/apis/update', { method: 'POST', body: { path: path, method: method, disabled: disabled } });
    ADM.toast(disabled ? '接口已停用' : '接口已启用', 'ok');
    await refresh();
}

async function doSync(btn, refresh) {
    btn.disabled = true;
    try {
        var r = await ADM.api('/api/adm/apis/sync', { method: 'POST' });
        var s = r.sync || {};
        ADM.toast('已同步：登记 ' + (s.total || 0) + ' 个接口，失效 ' + (s.orphan || 0) + ' 个', 'ok');
    } finally {
        btn.disabled = false;
    }
    await refresh();
}

async function doCleanup(btn, refresh) {
    var ok = await ADM.confirm('清理失效接口', '确认删除所有「已失效」（代码中已不存在）的接口登记？其对应的权限记录会一并删除。', '清理');
    if (!ok) return;
    btn.disabled = true;
    try {
        var r = await ADM.api('/api/adm/apis/cleanup', { method: 'POST' });
        ADM.toast('已清理 ' + (r.removed || 0) + ' 条失效登记', 'ok');
    } finally {
        btn.disabled = false;
    }
    await refresh();
}

async function doResetStats(btn, refresh) {
    var ok = await ADM.confirm('清零请求统计', '确认把所有接口的「请求次数」统计清零？该操作不影响接口本身与权限设置。', '清零');
    if (!ok) return;
    btn.disabled = true;
    try {
        var r = await ADM.api('/api/adm/apis/stats/reset', { method: 'POST' });
        ADM.toast('已清零 ' + (r.removed || 0) + ' 条统计', 'ok');
    } finally {
        btn.disabled = false;
    }
    await refresh();
}

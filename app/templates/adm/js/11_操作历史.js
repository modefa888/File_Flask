/* 后台管理：操作历史（删除 / 回收站历史 + 压缩历史），用 Tab 切换查看。 */
ADM.modules.push({
    id: 'history',
    name: '操作历史',
    subtitle: '删除记录、压缩记录与全站操作日志',
    icon: 'bi-clock-history',
    async load(el) {
        el.innerHTML = ADM.loading('加载操作历史…');
        await refreshHistory(el);
    }
});

async function refreshHistory(el) {
    /* 顶部统计（失败不阻塞列表） */
    var delTotal = 0, arcTotal = 0, opStats = { total: 0, today: 0, last_at: '' };
    try { delTotal = (await ADM.api('/api/delete-history?page=1&page_size=1')).total || 0; } catch (e) { }
    try { arcTotal = (await ADM.api('/api/archive-history?page=1&page_size=1')).total || 0; } catch (e) { }
    try { opStats = (await ADM.api('/api/adm/oplogs?page=1&page_size=1')).stats || opStats; } catch (e) { }

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

    /* ---- Tab 3：操作日志（全站写操作的审计记录） ---- */
    /* 动作归类配色：删除类红、执行类黄、新增绿、其余蓝 */
    function opTone(op) {
        if (op === '删除' || op === '清空' || op === '清理') return 'bad';
        if (op === '执行' || op === '停止') return 'warn';
        if (op === '新增') return 'ok';
        if (op === '登录' || op === '退出') return 'mute';
        return 'info';
    }
    function methodTone(m) {
        if (m === 'DELETE') return 'bad';
        if (m === 'PUT' || m === 'PATCH') return 'warn';
        return 'info';
    }

    var opCols = [
        {
            label: '时间', render: function (r) {
                return '<span class="adm-cell-mono" title="IP：' + ADM.esc(r.ip || '-') + '">' +
                    ADM.esc(r.ts || '-') + '</span>';
            }
        },
        {
            label: '用户', render: function (r) {
                return r.user ? ADM.badge(r.user, 'mute') : '<span class="adm-hint">-</span>';
            }
        },
        {
            label: '动作', render: function (r) {
                var op = r.op || '—';
                return ADM.badge(op, opTone(op));
            }
        },
        {
            label: '方法', render: function (r) {
                return r.method
                    ? ADM.badge(r.method, methodTone(r.method))
                    : '<span class="adm-hint">-</span>';
            }
        },
        {
            label: '接口', render: function (r) {
                if (!r.rule) return '<span class="adm-hint">-</span>';
                var tip = (r.module ? r.module + ' · ' : '') + (r.action || '');
                return '<span class="adm-cell-mono" title="' + ADM.esc(tip) + '">' +
                    ADM.esc(r.rule) + '</span>';
            }
        },
        {
            // 目标 = 这次操作作用的对象（文件名 / 路径 / 用户名 / 任务 id 等）；
            // 全量同步、批量任务这类没有单一对象的操作就是空的
            label: '操作对象', render: function (r) {
                if (!r.target) {
                    return '<span class="adm-hint" title="该接口是整体同步 / 批量操作，没有单一作用对象">' +
                        '-' + '</span>';
                }
                return '<span class="adm-cell-mono" title="操作对象：' + ADM.esc(r.target) +
                    (r.detail ? '\n参数：' + ADM.esc(r.detail) : '') + '">' +
                    ADM.esc(r.target) + '</span>';
            }
        },
        {
            label: '结果', render: function (r) {
                var ok = (r.result || 'ok') === 'ok';
                return ok ? ADM.badge('成功', 'ok') : ADM.badge(r.result || '失败', 'bad');
            }
        }
    ];
    var opContent = '<div class="adm-tab-toolbar">' +
        '<button class="adm-btn sm ghost" id="admOpClear" type="button"><i class="bi bi-eraser"></i> 清空操作日志</button>' +
        '<span class="adm-hint">只记写操作（POST / PUT / DELETE），浏览类 GET 不记录；同时记录请求参数与接口返回内容，' +
        '最多保留最近 5000 条，密码 / Key / Token 类字段已打码</span>' +
        '</div>' + ADM.servTable(opCols, {
            key: 'op-logs',
            fetch: function (p) {
                return ADM.api('/api/adm/oplogs?q=' + encodeURIComponent(p.q) +
                    '&page=' + p.page + '&page_size=' + p.size);
            },
            pageSize: 15,
            detailTitle: function (r) {
                return (r.op || '操作') + ' · ' + (r.rule || r.module || '');
            },
            detail: function (r) {
                function line(k, v) {
                    return '<div class="adm-op-line">' +
                        '<span class="adm-op-line-k">' + k + '</span>' +
                        '<span class="adm-op-line-v">' + v + '</span></div>';
                }
                var ok = (r.result || 'ok') === 'ok';
                return '<div style="font-size:12.5px;line-height:1.7">' +
                    line('时间', ADM.esc(r.ts || '-')) +
                    line('用户', ADM.esc(r.user || '-')) +
                    line('动作', ADM.badge(r.op || '—', 'info')) +
                    line('方法', r.method ? ADM.badge(r.method, 'info') : '-') +
                    line('接口', '<code>' + ADM.esc(r.rule || '-') + '</code>') +
                    line('模块', ADM.esc(r.module || '-')) +
                    line('说明', ADM.esc(r.action || '-')) +
                    line('操作对象', r.target
                        ? ADM.esc(r.target)
                        : '<span class="adm-hint">（无具体对象：该接口是整体同步 / 批量操作）</span>') +
                    line('请求参数', opParamsHtml(r.detail)) +
                    line('IP', ADM.esc(r.ip || '-')) +
                    line('结果', ok ? ADM.badge('成功', 'ok') : ADM.badge(r.result || '失败', 'bad')) +
                    line('返回内容', opParamsHtml(r.resp, '（无返回内容 / 未记录）')) +
                    '</div>';
            }
        });

    /* ---- 历史总览 ---- */
    var cards = '<div class="adm-section">' + ADM.sectionHead('bi-graph-up', '历史总览',
        '<span class="adm-hint">数据来源：store.db（delete_history / archive_history）</span>') + '<div class="adm-stat-grid">';
    cards += ADM.stat('bi-trash', '删除记录', delTotal, '删除历史与回收站条目');
    cards += ADM.stat('bi-file-zip', '压缩记录', arcTotal, '压缩 / 解压操作记录');
    cards += ADM.stat('bi-journal-text', '操作日志', opStats.total || 0,
        '今日 ' + (opStats.today || 0) + ' 条' + (opStats.last_at ? ' · 最近 ' + opStats.last_at : ''));
    cards += '</div></div>';

    var html = cards + ADM.tabs([
        { id: 'del', name: '删除 / 回收站历史', icon: 'bi-trash', content: delContent },
        { id: 'arc', name: '压缩 / 解压历史', icon: 'bi-file-zip', content: arcContent },
        { id: 'op', name: '操作日志', icon: 'bi-journal-text', content: opContent }
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
    var oc = el.querySelector('#admOpClear');
    if (oc) oc.addEventListener('click', async function () {
        var ok = await ADM.confirm('清空操作日志',
            '确认清空全部操作日志？该操作只删除审计记录，不影响任何业务数据。', '清空');
        if (!ok) return;
        await ADM.api('/api/adm/oplogs/clear', { method: 'POST', body: {} });
        ADM.toast('操作日志已清空', 'ok');
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

/* 旧日志里嵌套参数被存成了一整串 JSON 字符串（形如 notify: '{"enabled":true}'），
 * 这里还原成对象，交给下面同样的逻辑逐行展开。
 * 老记录在入库时按 120 字截断，尾巴常常断在半截，所以解析失败时再「修一下」：
 * 找最后一个逗号切成完整前缀，再把没闭合的括号补上。 */
function opLooseJson(s) {
    var stack = [], cut = -1, cutStack = null, inStr = false, esc = false, i, c;
    for (i = 0; i < s.length; i++) {
        c = s.charAt(i);
        if (inStr) {
            if (esc) esc = false;
            else if (c === '\\') esc = true;
            else if (c === '"') inStr = false;
            continue;
        }
        if (c === '"') { inStr = true; continue; }
        if (c === '{' || c === '[') { stack.push(c); continue; }
        if (c === '}' || c === ']') { if (stack.length) stack.pop(); continue; }
        if (c === ',' && stack.length) { cut = i; cutStack = stack.slice(); }
    }
    if (cut < 2 || !cutStack || !cutStack.length) return null;
    var close = '';
    for (i = cutStack.length - 1; i >= 0; i--) close += cutStack[i] === '{' ? '}' : ']';
    try { return JSON.parse(s.slice(0, cut) + close); } catch (e) { return null; }
}

function opMaybeJson(v) {
    if (typeof v !== 'string') return null;
    var s = v.trim();
    if (!s || (s.charAt(0) !== '{' && s.charAt(0) !== '[')) return null;
    try { return JSON.parse(s); } catch (e) { /* 多半是被截断的老记录，下面修补 */ }
    return opLooseJson(s);
}

/* 数组元素 / 兜底值的单行文本（对象压成一行 JSON，超长截断） */
function opScalarText(x) {
    if (x === null || x === undefined) return 'null';
    if (typeof x === 'object') {
        var s = '';
        try { s = JSON.stringify(x); } catch (e) { s = String(x); }
        return s.length > 48 ? s.slice(0, 48) + '…' : s;
    }
    var t = String(x);
    return t.length > 48 ? t.slice(0, 48) + '…' : t;
}

/* 请求参数 / 返回内容渲染：递归展开成「键 → 值」列表（嵌套对象逐层缩进），比一坨 JSON 好读。
 * 右上角可切到「原文」看后端记录的原始 JSON；内容超高时内部滚动（自定义滚动条）。
 * emptyText 是「什么都没记」时的占位文案（参数 / 返回各说各的）。 */
function opParamsHtml(detail, emptyText) {
    if (!detail) {
        return '<span class="adm-hint">' + ADM.esc(emptyText || '（无参数）') + '</span>';
    }
    var obj = null;
    try { obj = JSON.parse(detail); } catch (e) { obj = null; }

    var rows = [];
    function push(key, html, depth) {
        rows.push('<div class="adm-op-param' + (depth ? ' sub' : '') + '">' +
            '<span class="adm-op-key" style="padding-left:' + (depth * 14) + 'px" title="' +
            ADM.esc(key) + '">' + ADM.esc(key) + '</span>' +
            '<span class="adm-op-v">' + html + '</span></div>');
    }
    function walk(v, key, depth) {
        var parsed = opMaybeJson(v);        // 旧记录：字符串里藏着的 JSON 结构，展开
        if (parsed !== null) v = parsed;
        if (v === null || v === undefined) {
            push(key, '<span class="adm-hint">null</span>', depth);
            return;
        }
        if (typeof v === 'boolean') {
            push(key, ADM.badge(v ? 'true' : 'false', v ? 'ok' : 'mute'), depth);
            return;
        }
        if (Array.isArray(v)) {
            if (!v.length) { push(key, '<span class="adm-hint">空数组</span>', depth); return; }
            push(key, v.map(function (x) {
                var inner = opMaybeJson(x);
                return '<span class="adm-op-chip">' +
                    ADM.esc(opScalarText(inner !== null ? inner : x)) + '</span>';
            }).join(''), depth);
            return;
        }
        if (typeof v === 'object') {
            var keys = Object.keys(v);
            if (!keys.length) {
                if (key) push(key, '<span class="adm-hint">{ }</span>', depth);
                return;                     // 顶层空对象：什么都不显示，下面统一给「无参数」
            }
            // 最外层对象不单独占一行，直接把字段摊开（否则会出现一个多余的分组标题）
            var flat = (depth === 0 && !key);
            if (!flat) push(key, '<span class="adm-hint">' + keys.length + ' 个字段</span>', depth);
            keys.forEach(function (k) { walk(v[k], k, flat ? depth : depth + 1); });
            return;
        }
        push(key, '<span class="adm-op-val">' + ADM.esc(String(v)) + '</span>', depth);
    }

    if (Array.isArray(obj)) {
        obj.forEach(function (x, i) { walk(x, '[' + i + ']', 0); });
    } else if (obj && typeof obj === 'object') {
        walk(obj, '', 0);
    }

    // 「原文」：优先给格式化后的 JSON（后端存的也是 JSON），解析不了就原样贴出来
    var rawText = detail;
    if (obj && typeof obj === 'object') {
        try { rawText = JSON.stringify(obj, null, 2); } catch (e) { rawText = detail; }
    }

    var bar = '<div class="adm-op-bar" title="点击展开 / 收起">' +
        '<span class="adm-op-bar-hint">' +
        '<i class="bi bi-chevron-right adm-op-caret"></i>' +
        (rows.length ? rows.length + ' 项' : '原始内容') + '</span>' +
        (rows.length
            ? '<button type="button" class="adm-op-switch" data-opraw="0" ' +
              'title="切换结构化 / 原文">原文</button>'
            : '') +
        '</div>';
    var body = rows.length
        ? '<div class="adm-op-body">' + rows.join('') + '</div>'
        : '<div class="adm-op-body"><span class="adm-op-val">' + ADM.esc(detail) + '</span></div>';
    // 默认收起（collapsed）：只露顶栏那一条，点顶栏才展开，参数 / 返回内容很长时不至于把弹窗撑爆
    return '<div class="adm-op-params collapsed">' + bar + body +
        '<pre class="adm-op-raw">' + ADM.esc(rawText) + '</pre></div>';
}

/* 「原文 / 结构化」切换：整个容器加 raw 类，靠 CSS 决定显示哪一块 */
function opToggleRaw(btn) {
    var box = btn.closest('.adm-op-params');
    if (!box) return;
    var toRaw = btn.dataset.opraw !== '1';
    box.classList.toggle('raw', toRaw);
    box.classList.remove('collapsed');       // 切视图顺带展开，否则点了看不到内容
    btn.dataset.opraw = toRaw ? '1' : '0';
    btn.textContent = toRaw ? '结构化' : '原文';
}

/* 详情弹窗是动态插入的，这里用一次事件委托处理「展开 / 收起」和「原文 / 结构化」切换 */
if (!window._admOpRawBound) {
    window._admOpRawBound = 1;
    document.addEventListener('click', function (ev) {
        var t = ev.target;
        if (!t || !t.closest) return;
        var btn = t.closest('.adm-op-switch');
        if (btn) { opToggleRaw(btn); return; }
        var bar = t.closest('.adm-op-bar');
        var box = bar && bar.closest('.adm-op-params');
        if (box) box.classList.toggle('collapsed');
    });
}

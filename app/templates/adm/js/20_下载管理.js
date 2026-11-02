/* 后台管理：下载管理（任务 / 产物清理）。
 * 数据全部复用 IDE 下载中心的服务端接口 /api/dl/*（/api/dl/tasks、/api/dl/usage、
 * /api/dl/clean、/api/dl/tasks/<id>/action、/api/dl/stream/<id>），后台这边只做管理视图。 */
ADM.modules.push({
    id: 'downloads',
    name: '下载管理',
    subtitle: '下载任务、进度与产物清理',
    icon: 'bi-cloud-arrow-down',
    async load(el) {
        el.innerHTML = ADM.loading('加载下载任务…');
        await dlAdmRender(el);
        dlAdmPoll(el);
    }
});

/* 任务状态 → 文案 / 徽章配色（与 IDE 下载中心保持一致） */
var DL_ADM_ST = {
    pending: ['排队中', 'mute'],
    building: ['打包中', 'info'],
    probing: ['解析中', 'info'],
    ready: ['待取回', 'warn'],
    downloading: ['下载中', 'info'],
    paused: ['已暂停', 'warn'],
    done: ['已完成', 'ok'],
    failed: ['失败', 'bad'],
    canceled: ['已取消', 'mute']
};
var DL_ADM_KIND = { file: '文件', folder: '文件夹', multi: '多文件', url: '网络', torrent: 'BT', hls: 'm3u8' };
/* 当前选中的状态筛选（空 = 全部），fetch 闭包里读它 */
var DL_ADM = { status: '', timer: null };

function dlAdmStatusText(s) {
    var it = DL_ADM_ST[s];
    return it ? it[0] : (s || '-');
}
function dlAdmStatusTone(s) {
    var it = DL_ADM_ST[s];
    return it ? it[1] : 'mute';
}
/* 进度：优先用「本地取回」百分比；还没开始取回时才退回「服务器抓取」百分比 */
function dlAdmPct(t) {
    var local = Number(t.pct || 0);
    var p = local > 0 ? local : Number(t.srv_pct || 0);
    if (!isFinite(p) || p <= 0) return 0;
    return Math.min(100, p);
}
function dlAdmPctHtml(t) {
    var p = dlAdmPct(t);
    if (p <= 0) return '<span class="adm-hint" title="' + ADM.esc(t.phase || '') + '">-</span>';
    var local = Number(t.pct || 0) > 0;
    var size = Number(local ? (t.size || 0) : (t.srv_size || 0));
    var done = Number(local ? (t.done || 0) : (t.srv_done || 0));
    var bar = '<span class="dladm-bar"><i style="width:' + p.toFixed(1) + '%"></i></span>';
    var txt = p.toFixed(p >= 100 ? 0 : 1) + '%';
    if (size > 0) txt += ' · ' + ADM.bytes(done) + ' / ' + ADM.bytes(size);
    return '<div class="dladm-pct">' + bar + '<span>' + ADM.esc(txt) + '</span></div>';
}
function dlAdmSpeed(t) {
    var sp = Number(t.speed || 0);
    return sp > 0 ? ADM.bytes(sp) + '/s' : '-';
}

async function dlAdmRender(el) {
    var stats = {}, usage = {}, settings = {};
    try {
        var d = await ADM.api('/api/dl/tasks?page=1&page_size=1');
        stats = d.stats || {};
        settings = d.settings || {};
    } catch (e) { }
    try {
        var u = await ADM.api('/api/dl/usage');
        usage = u.usage || {};
    } catch (e) { }
    if (!usage.artifact_dir) usage.artifact_dir = settings.artifact_dir || '';

    /* ---- 顶部统计 ---- */
    var cards = '<div class="adm-section">' +
        ADM.sectionHead('bi-graph-up', '下载总览',
            '<span class="adm-hint">数据来源：IDE「下载中心」服务端记录</span>') +
        '<div class="adm-stat-grid">' +
        ADM.stat('bi-cloud-arrow-down', '任务总数',
            '<span id="dlAdmStatTotal">' + (stats.total || 0) + '</span>',
            '进行中 ' + (stats.active || 0) + ' 个') +
        ADM.stat('bi-check2-circle', '已完成',
            '<span id="dlAdmStatDone">' + (stats.done || 0) + '</span>',
            '失败 ' + (stats.fail || 0) + ' 个') +
        ADM.stat('bi-arrow-down-circle', '已下载数据',
            '<span id="dlAdmStatBytes">' + ADM.bytes(stats.done_bytes || 0) + '</span>',
            '全部任务累计') +
        ADM.stat('bi-hdd-stack', '产物占用',
            '<span id="dlAdmStatArt">' + ADM.bytes(usage.artifact_bytes || 0) + '</span>',
            (usage.artifacts || 0) + ' 个文件 · ' + (usage.records || 0) + ' 条记录') +
        '</div></div>';

    /* ---- Tab 1：任务列表 ---- */
    var cols = [
        {
            label: '任务', render: function (r) {
                var kind = DL_ADM_KIND[r.kind] || r.kind || '-';
                var name = r.name || r.id || '-';
                return '<span class="adm-cell-strong" title="' + ADM.esc(name) + '">' +
                    ADM.esc(name) + '</span> ' + ADM.badge(kind, 'mute') +
                    '<div class="dladm-id">' + ADM.esc(r.id || '') + '</div>';
            }
        },
        {
            label: '状态', render: function (r) {
                var extra = r.status === 'failed' && r.error ? ' title="' + ADM.esc(r.error) + '"' : '';
                return '<span data-cell="status"' + extra + '>' +
                    ADM.badge(dlAdmStatusText(r.status), dlAdmStatusTone(r.status)) + '</span>';
            }
        },
        { label: '进度', render: function (r) { return '<span data-cell="pct">' + dlAdmPctHtml(r) + '</span>'; } },
        {
            label: '速度', render: function (r) {
                return '<span data-cell="speed" class="adm-cell-mono">' + dlAdmSpeed(r) + '</span>';
            }
        },
        {
            label: '创建时间', render: function (r) {
                return '<span class="adm-cell-mono">' + ADM.dt(r.ts) + '</span>';
            }
        },
        {
            label: '操作', render: function (r) {
                var out = [];
                var id = ADM.esc(r.id || '');
                if (['downloading', 'probing', 'pending', 'building'].indexOf(r.status) >= 0) {
                    out.push('<button class="adm-btn sm ghost" data-dla="pause" data-id="' + id + '">暂停</button>');
                } else if (['paused', 'failed', 'canceled'].indexOf(r.status) >= 0) {
                    out.push('<button class="adm-btn sm ghost" data-dla="retry" data-id="' + id + '">重试</button>');
                } else if (r.status === 'ready') {
                    out.push('<button class="adm-btn sm ghost" data-dla="start" data-id="' + id + '">开始</button>');
                }
                if (r.exists && ['ready', 'done'].indexOf(r.status) >= 0) {
                    out.push('<button class="adm-btn sm primary" data-dlopen="' + id + '">下载</button>');
                }
                out.push('<button class="adm-btn sm danger" data-dldel="' + id + '">删除</button>');
                return '<span class="adm-btn-row">' + out.join('') + '</span>';
            }
        }
    ];

    // 状态筛选 / 刷新按钮在 onRender 里并进表格自带的工具行（搜索框、条数、每页都在那一行）
    var tasksHtml = ADM.servTable(cols, {
            key: 'dl-tasks',
            itemsKey: 'items', totalKey: 'total',
            pageSize: 15,
            searchPlaceholder: '任务名 / id / 链接 关键字…',
            empty: '还没有下载任务（在 IDE 里用「下载中心」创建）',
            actionsWidth: 260,
            fetch: function (p) {
                return ADM.api('/api/dl/tasks?q=' + encodeURIComponent(p.q) +
                    '&status=' + encodeURIComponent(DL_ADM.status) +
                    '&page=' + p.page + '&page_size=' + p.size);
            },
            onRender: function (host) { dlAdmBindToolbar(host); dlAdmBind(host, el); }
        });

    /* ---- Tab 2：产物与清理 ---- */
    var cfgLine = function (k, v) {
        return '<div class="dladm-kv"><span>' + ADM.esc(k) + '</span><b>' + v + '</b></div>';
    };
    var cleanHtml = '<div class="adm-section">' +
        ADM.sectionHead('bi-hdd-stack', '产物与记录',
            '<span class="adm-hint">清理只影响服务器上的 zip / 临时文件与记录，不碰源文件</span>') +
        '<div class="adm-card dladm-card">' +
        cfgLine('产物目录', '<span class="dladm-path" title="' + ADM.esc(usage.artifact_dir || '') + '">' +
            ADM.esc(usage.artifact_dir || '-') + '</span>') +
        cfgLine('产物文件', (usage.artifacts || 0) + ' 个 · ' + ADM.bytes(usage.artifact_bytes || 0)) +
        cfgLine('下载记录', (usage.records || 0) + ' 条') +
        cfgLine('保留策略', '保留 ' + (settings.keep_days || 0) + ' 天 · 最多 ' +
            (settings.max_rows || 0) + ' 条记录') +
        cfgLine('并发 / 限速', (settings.concurrency || 1) + ' 个任务 · ' +
            (settings.throttle_kbps ? settings.throttle_kbps + ' KB/s' : '不限速')) +
        '</div>' +
        '<div class="adm-btn-row dladm-acts">' +
        '<button class="adm-btn ghost" data-dlclean="artifacts"><i class="bi bi-eraser"></i> 清理产物文件</button>' +
        '<button class="adm-btn ghost" data-dlclean="finished"><i class="bi bi-trash3"></i> 清理已结束记录</button>' +
        '<button class="adm-btn danger" data-dlclean="all"><i class="bi bi-exclamation-octagon"></i> 全部清理</button>' +
        '</div>' +
        '<div class="adm-hint dladm-tip">提示：单文件下载不产生产物；只有「多文件 / 文件夹」才会生成 zip。' +
        '清理产物后对应任务记录会标记「产物已清理」，重新下载需要重建任务。</div>' +
        '</div>';

    var html = cards + ADM.tabs([
        { id: 'tasks', name: '下载任务', icon: 'bi-list-task', content: tasksHtml },
        { id: 'clean', name: '产物与清理', icon: 'bi-hdd-stack', content: cleanHtml }
    ], { key: 'dl-adm-tabs' });

    el.innerHTML = html;
    ADM.mountServTables(el);
    ADM.mountTabs(el);

    el.querySelectorAll('[data-dlclean]').forEach(function (b) {
        b.addEventListener('click', function () { dlAdmClean(b.dataset.dlclean, el); });
    });
}

/* 把「状态筛选」和「刷新」并进表格自带的工具行，和搜索框 / 条数 / 每页水平对齐在一行 */
function dlAdmBindToolbar(host) {
    var bar = host.querySelector('.adm-table-toolbar');
    if (!bar || bar.querySelector('.dladm-status')) return;
    host.classList.add('dladm-host');

    var sel = document.createElement('select');
    sel.className = 'adm-select dladm-status';
    sel.title = '按状态筛选';
    sel.innerHTML = [['', '全部状态']].concat(Object.keys(DL_ADM_ST).map(function (k) {
        return [k, DL_ADM_ST[k][0]];
    })).map(function (p) {
        return '<option value="' + p[0] + '"' + (p[0] === DL_ADM.status ? ' selected' : '') + '>' +
            ADM.esc(p[1]) + '</option>';
    }).join('');
    sel.addEventListener('change', function () {
        DL_ADM.status = sel.value;
        var st = ADM._servTables['dl-tasks'];
        if (st) st.page = 1;
        ADM.loadServ(host, 'dl-tasks');
    });
    bar.insertBefore(sel, bar.firstChild);

    var rf = document.createElement('button');
    rf.type = 'button';
    rf.className = 'adm-btn sm ghost dladm-refresh';
    rf.title = '重新读取任务列表';
    rf.innerHTML = '<i class="bi bi-arrow-clockwise"></i> 刷新';
    rf.addEventListener('click', function () { dlAdmReloadTable(); });
    bar.appendChild(rf);
}

/* 只重新拉当前表格（保留搜索词 / 页码 / 滚动位置） */
function dlAdmReloadTable() {
    var host = document.querySelector('[data-adm-serv="dl-tasks"]');
    if (host) ADM.loadServ(host, 'dl-tasks');
}

/* 行内按钮：暂停 / 重试 / 开始 / 下载产物 / 删除（分页、轮询后由 onRender 重新绑定） */
function dlAdmBind(host, el) {
    host.querySelectorAll('[data-dla]').forEach(function (b) {
        b.addEventListener('click', async function () {
            b.disabled = true;
            try {
                await ADM.api('/api/dl/tasks/' + encodeURIComponent(b.dataset.id) + '/action', {
                    method: 'POST', body: { action: b.dataset.dla }
                });
                ADM.toast('已提交：' + b.textContent.trim(), 'ok');
            } catch (e) {
                ADM.toast(e.message || '操作失败', 'err');
                b.disabled = false;
                return;
            }
            dlAdmReloadTable();          // 只刷表格，整页重绘会把滚动位置顶回顶部
        });
    });
    host.querySelectorAll('[data-dlopen]').forEach(function (b) {
        b.addEventListener('click', function () {
            window.open('/api/dl/stream/' + encodeURIComponent(b.dataset.dlopen), '_blank');
        });
    });
    host.querySelectorAll('[data-dldel]').forEach(function (b) {
        b.addEventListener('click', async function () {
            var ok = await ADM.confirm('删除下载任务',
                '确认删除该任务？勾选的产物文件会一并清理，不可恢复。', '删除');
            if (!ok) return;
            try {
                await ADM.api('/api/dl/tasks/' + encodeURIComponent(b.dataset.dldel) + '/action', {
                    method: 'POST', body: { action: 'delete' }
                });
                ADM.toast('任务已删除', 'ok');
            } catch (e) {
                ADM.toast(e.message || '删除失败', 'err');
                return;
            }
            dlAdmReloadTable();
        });
    });
}

async function dlAdmClean(what, el) {
    var text = what === 'artifacts' ? '清理所有已完成任务生成的 zip / 临时文件？下载记录会保留。'
        : (what === 'finished' ? '清理全部已结束（完成 / 失败 / 取消）的下载记录？'
            : '清理全部产物文件与已结束记录？不可恢复。');
    var ok = await ADM.confirm('清理', text, '清理');
    if (!ok) return;
    try {
        var d = await ADM.api('/api/dl/clean', { method: 'POST', body: { what: what } });
        ADM.toast(d.message || '已清理', 'ok');
    } catch (e) {
        ADM.toast(e.message || '清理失败', 'err');
        return;
    }
    ADM.render('downloads');
}

/* 自动刷新：每 5 秒静默更新当前页的进度 / 速度 / 状态，不重建整张表（避免闪烁、丢焦点） */
function dlAdmPoll(el) {
    if (DL_ADM.timer) clearInterval(DL_ADM.timer);
    DL_ADM.timer = setInterval(function () { dlAdmTick(el); }, 5000);
}
async function dlAdmTick(el) {
    if (!el || !el.isConnected || ADM.current !== 'downloads') return;
    var host = el.querySelector('[data-adm-serv="dl-tasks"]');
    var st = ADM._servTables['dl-tasks'];
    if (!host || !st || !st.last) return;
    if (host.contains(document.activeElement)) return;      // 正在搜索 / 输入，别打扰
    var d;
    try {
        d = await ADM.api('/api/dl/tasks?q=' + encodeURIComponent(st.q) +
            '&status=' + encodeURIComponent(DL_ADM.status) +
            '&page=' + st.page + '&page_size=' + st.size);
    } catch (e) { return; }
    if (!host.isConnected) return;
    var items = d.items || [];
    var rows = host.querySelectorAll('tbody tr[data-row]');
    if (rows.length !== items.length) {                     // 任务增删了 → 整表刷新
        ADM.loadServ(host, 'dl-tasks');
    } else {
        st.last.items = items;
        rows.forEach(function (tr) {
            var t = items[parseInt(tr.dataset.row, 10)];
            if (!t) return;
            var c1 = tr.querySelector('[data-cell="status"]');
            if (c1) c1.innerHTML = ADM.badge(dlAdmStatusText(t.status), dlAdmStatusTone(t.status));
            var c2 = tr.querySelector('[data-cell="pct"]');
            if (c2) c2.innerHTML = dlAdmPctHtml(t);
            var c3 = tr.querySelector('[data-cell="speed"]');
            if (c3) c3.textContent = dlAdmSpeed(t);
        });
    }
    var sm = d.stats || {};
    var set = function (id, html) { var e = document.getElementById(id); if (e) e.innerHTML = html; };
    set('dlAdmStatTotal', sm.total || 0);
    set('dlAdmStatDone', sm.done || 0);
    set('dlAdmStatBytes', ADM.bytes(sm.done_bytes || 0));
}

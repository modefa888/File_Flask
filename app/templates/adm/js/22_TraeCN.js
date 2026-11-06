/* 后台管理：Trae CN 积分 / 每日签到。
 * 数据来自 /api/traecn/*（服务端用加密保存的 Cloud-IDE-Token + device_id
 * 调用官方 api.trae.cn 接口）。token 永远不会回显到页面。
 * 样式复用 07_WorkBuddy.css 的 wb- 类（余额主卡 / 指标卡 / 账号卡 / 弹窗表单）。 */
ADM.modules.push({
    id: 'traecn',
    name: 'Trae CN 积分',
    subtitle: '积分余额 · 每日签到 · 签到记录',
    icon: 'bi-lightning-charge',
    async load(el) {
        el.innerHTML = ADM.loading('正在读取 Trae CN 积分…');
        await trRefresh(el);
    }
});

/* 当前账号：所有查询 / 签到都按它进行；空串 = 跟随服务端默认账号 */
var trCurrentUid = '';
var trHistoryUid = '';

/* ---------------- 小工具 ---------------- */
function trFmtNum(v) {
    if (v === null || v === undefined || v === '' || isNaN(Number(v))) return '—';
    return (Math.round(Number(v) * 100) / 100).toLocaleString('zh-CN');
}

function trEsc(s) { return ADM.esc(s === null || s === undefined ? '' : s); }

/* 解析 JWT payload 段（不验签），用于添加账号时提示有效期 / 自动识别 UID */
function trJwtPayload(token) {
    try {
        var seg = String(token || '').trim().split('.');
        if (seg.length < 2) return {};
        var pad = seg[1] + '='.repeat((4 - seg[1].length % 4) % 4);
        var obj = JSON.parse(decodeURIComponent(escape(atob(pad.replace(/-/g, '+').replace(/_/g, '/')))));
        return (obj && typeof obj === 'object') ? obj : {};
    } catch (e) { return {}; }
}

/* Token 指纹（FNV-1a + djb2 双 32 位哈希，16 位 hex）：同一段 token 结果稳定，
 * 用于在 JWT 不含用户标识时充当账号 uid（Trae 的 userId 不在 JWT payload 里）。 */
function trTokenFingerprint(token) {
    var s = String(token || '').trim();
    if (!s) return '';
    var h1 = 0x811c9dc5, h2 = 5381;
    for (var i = 0; i < s.length; i++) {
        var c = s.charCodeAt(i);
        h1 = ((h1 ^ c) * 0x01000193) >>> 0;
        h2 = ((h2 * 33) + c) >>> 0;
    }
    return ('00000000' + h1.toString(16)).slice(-8) +
        ('00000000' + h2.toString(16)).slice(-8);
}

/* ---------------- 首屏 ---------------- */
/* fresh=true 才请求官方最新数据；默认只读本地库（切换账号 / 首屏即时返回） */
async function trRefresh(el, uid, fresh) {
    if (uid !== undefined) {
        trCurrentUid = uid || '';
        if (uid) trHistoryUid = '';
    }
    var url = '/api/traecn/overview' +
        (trCurrentUid ? '?uid=' + encodeURIComponent(trCurrentUid) : '');
    if (fresh) url += (url.indexOf('?') >= 0 ? '&' : '?') + 'fresh=1';
    var d;
    try {
        d = await ADM.api(url);
    } catch (e) {
        el.innerHTML = '<div class="adm-card"><div class="adm-hint">加载失败：' +
            trEsc((e && e.message) || e) + '</div></div>';
        return;
    }
    d = d || {};
    trCurrentUid = d.current_uid || '';
    trRender(el, d);
    trBind(el, d);
}

function trRender(el, d) {
    var st = d.status || {};
    var cr = d.credits || {};
    var errs = d.errors || {};
    var cached = !!d.cached;
    var checked = st.checked_in === true || st.already === true;
    var unknown = !d.configured || st.checked_in === undefined;
    var stateHtml = checked
        ? '<span class="wb-state ok"><i class="bi bi-check2-circle"></i> 今日已签到</span>'
        : (unknown
            ? '<span class="wb-state"><i class="bi bi-question-circle"></i> 签到状态未知</span>'
            : '<span class="wb-state warn"><i class="bi bi-alarm"></i> 今日待签到</span>');

    /* ---- 账号管理 ---- */
    var html = trAccountBar(d);

    /* ---- 顶部指标 ---- */
    html += '<div class="adm-section">' + ADM.sectionHead('bi-graph-up', '积分总览',
        '<span class="adm-hint">' + (cached
            ? '本地缓存数据（签到状态按本机记录推断） · 点「刷新」拉取官方最新'
            : '数据来源：Trae 官方接口（api.trae.cn） · 更新于 ' + trEsc(ADM.dt(d.updated_at))) +
        '</span>') + '<div class="adm-stat-grid wb-stats">';
    html += ADM.stat('bi-calendar2-check', '今日签到',
        checked ? '<span class="wb-stat-ok">已签到</span>'
            : (unknown ? '未知' : '<span class="wb-stat-warn">待签到</span>'),
        d.today ? ('本地日期 ' + trEsc(d.today)) : '');
    html += ADM.stat('bi-lightning-charge', '连续签到', trFmtNum(st.streak_days || 0) + ' 天',
        '断签后连签天数会重置');
    html += ADM.stat('bi-gift', '累计签到积分', trFmtNum(st.total_credits || 0),
        '实际到账累计（普通 100 / 会员 200 每天）');
    html += ADM.stat('bi-coin', '今日签到积分',
        (checked && Number(st.today_credit) > 0) ? trFmtNum(st.today_credit) : '—',
        '签到到账后显示实际所得（普通 100 / 会员 200）');
    html += '</div></div>';

    /* ---- 主卡片：余额 + 分组操作 ---- */
    var canCheck = !!d.configured && !checked;
    html += '<div class="adm-section"><div class="wb-hero">' +
        '<div class="wb-hero-main">' +
        '<div class="wb-hero-label"><i class="bi bi-stars"></i> ' +
        trEsc((d.account && d.account.display_name) || 'Trae CN') + ' · 当前可用积分</div>' +
        '<div class="wb-balance">' + trFmtNum(cr.balance) + '<small>积分</small></div>' +
        '<div class="wb-hero-sub">' + stateHtml +
        (cached ? '<span class="wb-cache-tag"><i class="bi bi-database"></i> 缓存数据</span>' : '') +
        (cr.used !== null && cr.used !== undefined && cr.total !== null && cr.total !== undefined
            ? '<span class="wb-hero-expire"><i class="bi bi-pie-chart"></i> 已用 ' +
              trFmtNum(cr.used) + ' / 总额 ' + trFmtNum(cr.total) + '</span>' : '') +
        '</div></div>' +
        '<div class="wb-hero-actions">' +
        '<div class="wb-hero-primary">' +
        '<button class="adm-btn primary wb-btn-main" id="trCheckin" type="button"' +
        (canCheck ? '' : ' disabled') + '><i class="bi bi-hand-thumbs-up"></i> ' +
        (checked ? '今日已签到' : '立即签到') + '</button></div>' +
        '<div class="wb-hero-tools">' +
        '<button class="adm-btn ghost" id="trReload" type="button"><i class="bi bi-arrow-clockwise"></i> 刷新</button>' +
        '<button class="adm-btn ghost" id="trTest" type="button"><i class="bi bi-plug"></i> 测试连接</button>' +
        '<button class="adm-btn ghost" id="trAddBtn" type="button"><i class="bi bi-person-plus"></i> 添加账号</button>' +
        '</div></div></div>';

    /* ---- 错误提示 ---- */
    var problems = [];
    if (!d.configured && d.error) problems.push(d.error);
    if (errs.status) problems.push('签到状态：' + errs.status);
    if (errs.credits) problems.push('积分余额：' + errs.credits);
    (d.account && d.account.expires_soon) &&
        problems.push('Token 即将过期（' + (d.account.expires_text || '7 天有效期') +
            '），请重新获取 Cloud-IDE-Token 并编辑账号');
    if (problems.length) {
        html += '<div class="wb-errors">';
        problems.forEach(function (p) {
            html += '<div class="wb-error"><i class="bi bi-exclamation-triangle"></i><span>' +
                trEsc(p) + '</span></div>';
        });
        html += '</div>';
    }
    html += '</div>';

    /* ---- 未配置时的引导 ---- */
    if (!d.configured) {
        html += '<div class="adm-section"><div class="wb-guide"><i class="bi bi-info-circle"></i><div>' +
            '<h3>添加 Trae CN 账号</h3>' +
            '<p>本模块使用手动填写的 Cloud-IDE-Token（JWT）+ 设备号调用官方接口。获取方式：' +
            '登录 <a href="https://trae.cn" target="_blank" rel="noopener noreferrer">trae.cn</a> 网页版或客户端后，' +
            '在开发者工具（F12）→ Application / 存储 里找到 <code>Cloud-IDE-Token</code>（形如 xxx.yyy.zzz 的 JWT）；' +
            'device_id 可选，用于签到领取。凭据加密保存在本机 store.db，页面与日志均不回显。</p>' +
            '<div class="adm-btn-row">' +
            '<button class="adm-btn primary sm" id="trAddBtn2" type="button"><i class="bi bi-person-plus"></i> 立即添加账号</button>' +
            '</div></div></div></div>';
    }

    /* ---- 账户信息 ---- */
    var acct = d.account || {};
    var info = [
        ['bi-person-badge', '账号 UID', acct.uid || '-'],
        ['bi-key', 'Token', acct.token_masked || (acct.token_set ? '已配置 · ******' : '未配置')],
        ['bi-clock-history', 'Token 有效期', acct.expires_text || '-（无法从 token 解析，约 7 天）'],
        ['bi-phone', '设备号 device_id', acct.device_id_set ? '已配置（签到领取必需）' : '未配置（签到领取会失败）'],
        ['bi-database', '余额快照', acct.last_balance === null || acct.last_balance === undefined
            ? '尚未刷新' : trFmtNum(acct.last_balance) + ' 积分'],
        ['bi-tag', '备注', acct.remark || '-']
    ];
    var infoHtml = '<div class="adm-section">' + ADM.sectionHead('bi-info-square', '账户信息') +
        '<div class="adm-card wb-info-card"><div class="wb-info-grid">';
    info.forEach(function (it) {
        var text = String(it[2] === null || it[2] === undefined ? '' : it[2]);
        infoHtml += '<div class="wb-info-item" title="' + trEsc(text) + '">' +
            '<span class="wb-info-k"><i class="bi ' + it[0] + '"></i>' + trEsc(it[1]) + '</span>' +
            '<span class="wb-info-v">' + trEsc(text) + '</span></div>';
    });
    infoHtml += '</div>' +
        (!d.configured || acct.device_id_set ? '' :
            '<div class="adm-btn-row" style="margin-top:10px;align-items:center">' +
            '<button class="adm-btn sm ghost" id="trAutoDev" type="button"><i class="bi bi-cpu"></i> 自动获取设备号</button>' +
            '<span class="adm-hint">读取本机 Trae 客户端登录态（storage.json 的 icube-dc 号 / CLI argv.json）</span>' +
            '</div>') +
        '</div></div>';

    /* ---- 最近 14 天签到日历（Tab：签到记录），按账号逐行展示 ---- */
    var calHtml = '<div class="adm-section">' + ADM.sectionHead('bi-calendar3', '各账号签到情况 · 最近 14 天',
        '<span class="adm-hint">每个账号一行 · 点格子可在下方记录表筛选该账号</span>') +
        '<div class="adm-card">' + trCalendar(d.today, d.history_all || [],
            d.accounts || [], d.current_uid) + '</div></div>';

    /* ---- 签到记录表格（含账号列与连签天数） ---- */
    var nameMap = {};
    (d.accounts || []).forEach(function (a) {
        nameMap[a.uid] = a.display_name || a.uid.slice(0, 8);
    });
    var streakMap = trStreakMap(d.history_all || []);
    var accountsNow = d.accounts || [];
    var cols = [
        {
            label: '账号', key: 'uid', render: function (r) {
                return '<span class="adm-cell-strong">' +
                    trEsc(nameMap[r.uid] || (r.uid ? r.uid.slice(0, 8) + '…' : '-')) + '</span>';
            }
        },
        { label: '日期', key: 'day', sortKey: 'day', render: function (r) { return '<span class="adm-cell-strong">' + trEsc(r.day) + '</span>'; } },
        { label: '时间', key: 'at_text', sortKey: 'at', render: function (r) { return trEsc(r.at_text); } },
        {
            label: '结果', key: 'status_text', sortKey: 'status', render: function (r) {
                return r.status === 'success' ? ADM.badge('签到成功', 'ok')
                    : (r.status === 'already' ? ADM.badge('今日已签', 'info') : ADM.badge(trEsc(r.status_text), 'warn'));
            }
        },
        { label: '获得积分', key: 'credit', sortKey: 'credit', render: function (r) { return '+' + trFmtNum(r.credit); } },
        { label: '连签天数', key: 'streak', render: function (r) {
            var n = streakMap[(r.uid || '') + '|' + r.day] || 0;
            return n ? trFmtNum(n) + ' 天' : '<span class="adm-hint">—</span>';
        } },
        { label: '说明', key: 'message', render: function (r) { return trEsc(r.message || '-'); } },
        { label: '来源', key: 'source', render: function (r) { return r.source === 'auto' ? '自动' : '手动'; } }
    ];
    var histHtml = '<div class="adm-section">' + ADM.sectionHead('bi-clock-history', '签到记录',
        '<span class="adm-hint">可用表格左上角下拉，或点日历格子按账号筛选</span>') +
        ADM.servTable(cols, {
            key: 'traecn-history', pageSize: 10, sortable: true,
            empty: '暂无签到记录，点上方「立即签到」开始积累',
            onRender: function (host) { trHistoryToolbar(host, accountsNow); },
            fetch: function (p) {
                return ADM.api('/api/traecn/history?q=' + encodeURIComponent(p.q) +
                    '&page=' + p.page + '&page_size=' + p.size +
                    '&sort=' + encodeURIComponent(p.sort || '') + '&order=' + encodeURIComponent(p.order || '') +
                    '&uid=' + encodeURIComponent(trHistoryUid || ''));
            }
        }) + '</div>';

    /* ---- 详情区：收进 Tab，首屏只留余额与签到操作 ---- */
    html += '<div class="adm-section wb-detail">' +
        ADM.sectionHead('bi-bar-chart', '积分与签到详情',
            '<span class="adm-hint">按需切换查看 · 选中的标签会自动保留</span>') +
        ADM.tabs([
            { id: 'history', name: '签到记录', icon: 'bi-clock-history', content: calHtml + histHtml },
            { id: 'entitlements', name: '积分构成', icon: 'bi-pie-chart', content: trEntitlementsHtml(d) },
            { id: 'expiry', name: '到期提醒', icon: 'bi-calendar2-week', content: trExpiryHtml(d) },
            { id: 'models', name: '模型与档位', icon: 'bi-cpu',
                content: '<div class="adm-section">' +
                    ADM.sectionHead('bi-cpu', '可用模型与订阅档位',
                        '<span class="adm-hint">档位来自官方用量接口 · 模型清单读本机 Trae CN 客户端缓存</span>') +
                    '<div class="adm-card" id="trModelsBody"><div class="wb-empty">正在读取模型清单…</div></div></div>' },
            { id: 'info', name: '账户信息', icon: 'bi-info-square', content: infoHtml }
        ], { key: 'traecn-detail-tabs' }) + '</div>';

    el.innerHTML = html;
    ADM.mountServTables(el);
    ADM.mountTabs(el);
    /* 模型与档位 Tab：面板已在 DOM 里，挂载后异步拉一次（隐藏面板也会渲染好） */
    trLoadModels(el);
}

/* ---------------- 积分构成 / 到期提醒（样式对齐 WorkBuddy 积分构成 Tab） ---------------- */

/* Unix 秒 → 'YYYY-MM-DD' */
function trFmtDay(ts) {
    var n = Number(ts);
    if (!n || isNaN(n)) return '—';
    var d = new Date(n * 1000);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') +
        '-' + String(d.getDate()).padStart(2, '0');
}

function trDayStr(dt) {
    return dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') +
        '-' + String(dt.getDate()).padStart(2, '0');
}

/* 实时倒计时（超过 1 天按天，1 天内精确到小时 / 分钟）：基于 expire_at 现算 */
function trLeftText(p) {
    var left = Number(p.expire_at) * 1000 - Date.now();
    if (!(left > 0)) return '已到期';
    var d = Math.floor(left / 86400000),
        h = Math.floor((left % 86400000) / 3600000),
        m = Math.floor((left % 3600000) / 60000);
    return d > 0 ? (d + '天') : (h + '小时' + m + '分');
}

/* 过滤已过期的缓存积分包 */
function trLivePacks(packs) {
    var now = Date.now() / 1000;
    return (packs || []).filter(function (p) { return Number(p.expire_at) > now; });
}

/* 按「账号 × 最近 14 天」生成签到矩阵：每个账号一行，格子显示当天签到结果与积分（同 WorkBuddy） */
function trCalendar(today, recent, accounts, currentUid) {
    var map = {};
    (recent || []).forEach(function (r) {
        var k = (r.uid || '') + '|' + r.day;
        var old = map[k];
        // 同一天重复记录优先展示「签到成功」
        if (!old || r.status === 'success' ||
            (r.status === 'already' && old.status !== 'success')) map[k] = r;
    });
    var base;
    if (today && /^\d{4}-\d{2}-\d{2}$/.test(today)) {
        var parts = today.split('-');
        base = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    } else {
        base = new Date();
        base.setHours(0, 0, 0, 0);
    }
    var week = ['日', '一', '二', '三', '四', '五', '六'];
    var days = [];
    for (var i = 13; i >= 0; i--) {
        var dt = new Date(base.getTime() - i * 86400000);
        days.push({ day: trDayStr(dt), label: (dt.getMonth() + 1) + '/' + dt.getDate(),
            w: week[dt.getDay()] });
    }
    var todayStr = trDayStr(base);

    // 已保存账号优先；历史里出现过但已移除的账号也补一行，避免记录凭空消失
    var lines = (accounts || []).map(function (a) {
        return { uid: a.uid, name: a.display_name || a.uid.slice(0, 8),
            current: a.uid === currentUid, removed: false };
    });
    var known = {};
    lines.forEach(function (l) { known[l.uid] = 1; });
    (recent || []).forEach(function (r) {
        var u = r.uid || '';
        if (u && !known[u]) {
            known[u] = 1;
            lines.push({ uid: u, name: u.slice(0, 8) + '…',
                current: false, removed: true });
        }
    });
    if (!lines.length) {
        lines.push({ uid: '', name: '暂无账号', current: false, removed: true });
    }

    var h = '<div class="wb-cal-scroll"><div class="wb-cal-matrix">';
    h += '<div class="wb-cal-row head"><div class="wb-cal-account head">' +
        '<span>账号 / 日期</span><span class="adm-hint">最近 14 天</span></div>';
    days.forEach(function (day) {
        h += '<div class="wb-cal-date' + (day.day === todayStr ? ' today' : '') + '">' +
            '<b>' + trEsc(day.label) + '</b><span>周' + day.w + '</span></div>';
    });
    h += '</div>';

    lines.forEach(function (l) {
        var cnt = 0, sum = 0;
        var cells = days.map(function (day) {
            var r = map[l.uid + '|' + day.day];
            var cls = 'wb-cal-cell', icon = 'bi-dash', small = '', tip = day.day + '：无记录';
            if (r) {
                var ok = r.status === 'success', done = r.status === 'already';
                cls += ok ? ' ok' : (done ? ' done' : ' bad');
                icon = (ok || done) ? 'bi-check2' : 'bi-exclamation-triangle';
                small = r.credit ? ('+' + trFmtNum(r.credit)) : '';
                if (ok || done) { cnt++; sum += Number(r.credit) || 0; }
                tip = day.day + ' · ' + (r.status_text || r.status) +
                    (r.credit ? ' +' + trFmtNum(r.credit) + ' 积分' : '') +
                    (r.at_text ? ' · ' + r.at_text : '') +
                    (r.message ? ' · ' + r.message : '');
            }
            if (day.day === todayStr) cls += ' today';
            return '<button type="button" class="' + cls + '" data-trcaluid="' +
                trEsc(l.uid) + '" title="' + trEsc(tip) + '">' +
                '<i class="bi ' + icon + '"></i>' +
                (small ? '<small>' + trEsc(small) + '</small>' : '') + '</button>';
        }).join('');
        var t = map[l.uid + '|' + todayStr];
        var todayTag = (t && (t.status === 'success' || t.status === 'already'))
            ? '<span class="wb-cal-today ok">今日已签</span>'
            : '<span class="wb-cal-today warn">今日未签</span>';
        h += '<div class="wb-cal-row"><div class="wb-cal-account">' +
            '<div class="wb-cal-account-name"><b>' + trEsc(l.name) + '</b>' +
            (l.current ? '<span class="wb-account-badge current">当前</span>' : '') +
            (l.removed ? '<span class="wb-account-badge">已移除</span>' : '') + '</div>' +
            '<div class="wb-cal-account-meta">' + todayTag +
            '<span>14 天 ' + cnt + ' 次 · +' + trFmtNum(sum) + ' 积分</span></div>' +
            '</div>' + cells + '</div>';
    });
    h += '</div></div>';
    h += '<div class="wb-cal-legend">' +
        '<span><i class="wb-legend-dot ok"></i> 签到成功</span>' +
        '<span><i class="wb-legend-dot done"></i> 今日已签</span>' +
        '<span><i class="wb-legend-dot miss"></i> 无记录</span>' +
        '<span><i class="wb-legend-dot today"></i> 今天</span>' +
        '<span class="adm-hint">点任意格子可在下方记录表中筛选该账号</span></div>';
    return h;
}

/* 前端近似计算连签天数：uid|day → 从该日起往前连续签到的天数 */
function trStreakMap(records) {
    var ok = {};
    (records || []).forEach(function (r) {
        var u = r.uid || '';
        if (!ok[u]) ok[u] = {};
        if (r.status === 'success' || r.status === 'already') ok[u][r.day] = 1;
    });
    var out = {};
    Object.keys(ok).forEach(function (u) {
        Object.keys(ok[u]).forEach(function (d) {
            var n = 0, cur = new Date(d + 'T00:00:00').getTime();
            while (ok[u][trFmtDay(cur / 1000)]) { n++; cur -= 86400000; }
            out[u + '|' + d] = n;
        });
    });
    return out;
}

/* 签到记录表工具栏：注入「按账号筛选」下拉（分页重绘时不重复添加，同 WorkBuddy） */
function trHistoryToolbar(host, accounts) {
    var bar = host.querySelector('.adm-table-toolbar');
    if (!bar || bar.querySelector('#trHistoryAccount')) return;
    var sel = document.createElement('select');
    sel.className = 'adm-select wb-history-account';
    sel.id = 'trHistoryAccount';
    sel.title = '按账号筛选签到记录';
    sel.innerHTML = '<option value="">全部账号</option>' + (accounts || []).map(function (a) {
        return '<option value="' + trEsc(a.uid) + '">' +
            trEsc(a.display_name || a.uid.slice(0, 8)) + '</option>';
    }).join('');
    sel.value = trHistoryUid;
    sel.addEventListener('change', function () {
        trHistoryUid = sel.value;
        var st = ADM._servTables['traecn-history'];
        if (st) st.page = 1;
        ADM.loadServ(host, 'traecn-history');
    });
    bar.insertBefore(sel, bar.firstChild);
}

var TR_SRC_COLORS = ['#5b8cff', '#4ade80', '#f59e0b', '#a78bfa', '#22d3ee', '#fb7185'];

/* 按来源名稳定取色（同名的包永远同色） */
function trSourceColor(name) {
    var s = String(name || ''), hash = 0;
    for (var i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
    return TR_SRC_COLORS[hash % TR_SRC_COLORS.length];
}

/* packs 按来源聚合 → [{name, count, amount, color, earliest}]，按积分降序 */
function trGroupBySource(packs) {
    var map = {}, order = [];
    (packs || []).forEach(function (p) {
        var k = p.name || '其他';
        if (!map[k]) { map[k] = { name: k, count: 0, amount: 0, earliest: null }; order.push(k); }
        map[k].count += 1;
        map[k].amount += Number(p.amount) || 0;
        if (map[k].earliest === null || Number(p.expire_at) < map[k].earliest)
            map[k].earliest = p.expire_at;
    });
    return order.map(function (k, i) {
        map[k].color = TR_SRC_COLORS[i % TR_SRC_COLORS.length];
        return map[k];
    }).sort(function (a, b) { return b.amount - a.amount; });
}

/* 逐包明细折叠表（wb-pack-table） */
function trPackDetailTable(packs) {
    if (!packs.length) return '<div class="wb-empty">暂无积分包明细，点「刷新」拉取官方数据。</div>';
    var h = '<table class="wb-pack-table"><thead><tr>' +
        '<th>积分包</th><th>面额</th><th>获得日期</th><th>失效时间</th><th>倒计时</th>' +
        '</tr></thead><tbody>';
    packs.forEach(function (p) {
        var tone = p.days_left <= 7 ? 'danger' : (p.days_left <= 30 ? 'warn' : 'mute');
        h += '<tr>' +
            '<td><i class="wb-exp-dot" style="background:' + trSourceColor(p.name) + '"></i>' +
            trEsc(p.name) + '</td>' +
            '<td><b>' + trFmtNum(p.amount) + '</b></td>' +
            '<td>' + trEsc(p.start_text || '—') + '</td>' +
            '<td>' + trEsc(p.expire_text || '—') + '</td>' +
            '<td><span class="wb-exp-badge ' + tone + '">' +
            trEsc(trLeftText(p)) + '</span></td></tr>';
    });
    return h + '</tbody></table>';
}

/* 积分构成：总积分统计 4 卡 + 最近到期提示条 + 账号构成堆叠条（同 WorkBuddy） */
function trEntitlementsHtml(d) {
    var packs = trLivePacks((d.entitlements && d.entitlements.packs) || []);
    var updated = d.entitlements && d.entitlements.updated_at;
    var total = 0, exp7 = 0, exp30 = 0, nearest = null;
    packs.forEach(function (p) {
        var a = Number(p.amount) || 0;
        total += a;
        if (p.days_left <= 7) exp7 += a;
        if (p.days_left <= 30) exp30 += a;
        if (!nearest || Number(p.expire_at) < Number(nearest.expire_at)) nearest = p;
    });
    var h = '<div class="adm-section">' + ADM.sectionHead('bi-pie-chart', '总积分统计',
        '<span class="adm-hint">' + (updated
            ? '快照更新于 ' + trEsc(ADM.dt(updated)) + ' · 点「刷新」更新'
            : '点上方「刷新」拉取官方积分构成') + '</span>') +
        '<div class="adm-stat-grid wb-total-stats">';
    h += ADM.stat('bi-coin', '总可用积分', trFmtNum(total),
        '逐包面额合计 · ' + packs.length + ' 个积分包');
    h += ADM.stat('bi-boxes', '积分包来源', trFmtNum(trGroupBySource(packs).length),
        '登录赠送 / 签到奖励等来源数');
    h += ADM.stat('bi-alarm', '7 天内到期', trFmtNum(exp7), '临近作废，建议优先消耗');
    h += ADM.stat('bi-hourglass-split', '30 天内到期', trFmtNum(exp30), '含 7 天内临期积分');
    h += '</div>';
    if (nearest) {
        h += '<div class="wb-nearest"><i class="bi bi-exclamation-circle"></i>' +
            '<span>最近到期：「' + trEsc(nearest.name) + '」 <b>' +
            trFmtNum(nearest.amount) + '</b> 积分将于 ' +
            trEsc(nearest.expire_text || trFmtDay(nearest.expire_at)) + ' 失效</span>' +
            '<span class="wb-nearest-days">' + trEsc(trLeftText(nearest)) + '</span></div>';
    }
    h += '</div>';

    /* 账号积分构成：堆叠条按来源着色 + 明细折叠 */
    var seg = '', legend = '';
    trGroupBySource(packs).forEach(function (g) {
        var w = total > 0 ? (g.amount / total) * 100 : 0;
        if (w <= 0) return;
        seg += '<span class="wb-comp-seg" style="width:' + w.toFixed(2) +
            '%;background:' + g.color + '" title="' + trEsc(g.name) + '：' +
            trFmtNum(g.amount) + ' 积分"></span>';
        legend += '<span><i style="background:' + g.color + '"></i>' +
            trEsc(g.name) + ' ' + trFmtNum(g.amount) + '</span>';
    });
    if (!seg) {
        seg = '<span class="wb-comp-seg" style="width:100%;background:rgba(90,102,131,.45)"></span>';
        legend = '<span><i style="background:rgba(90,102,131,.45)"></i>余额快照（暂无分包明细）</span>';
    }
    var key = trEsc(trCurrentUid || '_');
    h += '<div class="adm-section">' + ADM.sectionHead('bi-bar-chart', '账号积分构成',
        '<span class="adm-hint">堆叠条按积分来源着色 · 点「明细」看逐包面额与有效期</span>') +
        '<div class="wb-comp-list"><div class="wb-comp-row">' +
        '<div class="wb-comp-head">' +
        '<div class="wb-comp-name"><i class="bi bi-person-circle"></i> ' +
        trEsc((d.account && d.account.display_name) || '当前账号') + '</div>' +
        '<div class="wb-comp-num"><b>' + trFmtNum(total) + '</b> 积分' +
        '<span class="adm-hint"> / ' + packs.length + ' 包</span></div>' +
        '<button class="adm-btn sm ghost" data-trcomp-toggle="' + key +
        '" type="button">明细</button></div>' +
        '<div class="wb-comp-bar">' + seg + '</div>' +
        '<div class="wb-comp-legend">' + legend + '</div>' +
        '<div class="wb-comp-detail" data-trcomp-detail="' + key + '" hidden>' +
        trPackDetailTable(packs) + '</div>' +
        '</div></div></div>';
    return h;
}

/* 到期提醒：按天到期柱状图（wb-exp-chart）+ 逐包列表（wb-exp-list）+ Token 提示 */
function trExpiryHtml(d) {
    var packs = trLivePacks((d.entitlements && d.entitlements.packs) || []);
    var acct = d.account || {};
    var who = trEsc((d.account && d.account.display_name) || '当前账号');
    var h = '<div class="adm-section">' + ADM.sectionHead('bi-calendar2-week', '最近过期积分',
        '<span class="adm-hint">签到 / 登录积分发放约 31 天后清零 · 积分按到期先后消耗</span>') +
        '<div class="adm-card">';
    if (!packs.length) {
        h += '<div class="wb-empty">暂无到期积分包。点「刷新」从官方接口拉取逐包明细。</div>';
    } else {
        /* 未来 45 天内按到期日聚合的柱状图 */
        var byDay = {}, max = 1;
        packs.forEach(function (p) {
            if (Number(p.days_left) > 45) return;
            var k = String(p.expire_text || '—').slice(0, 10);
            byDay[k] = (byDay[k] || 0) + (Number(p.amount) || 0);
        });
        var days = Object.keys(byDay).sort();
        days.forEach(function (k) { max = Math.max(max, byDay[k]); });
        if (days.length) {
            h += '<div class="wb-exp-chart">';
            days.forEach(function (k) {
                var left = Math.max(0, Math.round((new Date(k + 'T23:59:59').getTime() - Date.now()) / 86400000));
                var pct = Math.max(6, (byDay[k] / max) * 100);
                h += '<div class="wb-exp-col" title="' + trEsc(k) + '：' +
                    trFmtNum(byDay[k]) + ' 积分到期">' +
                    '<span class="wb-exp-val">' + trFmtNum(byDay[k]) + '</span>' +
                    '<div class="wb-exp-bar' + (left <= 7 ? ' danger' : '') +
                    '" style="height:' + pct.toFixed(1) + '%"></div>' +
                    '<span class="wb-exp-date">' + trEsc(k.slice(5)) + '</span></div>';
            });
            h += '</div>';
        } else {
            h += '<div class="wb-empty">未来 45 天内没有到期积分包。</div>';
        }
        /* 逐包列表 */
        h += '<div class="wb-exp-list">';
        packs.forEach(function (p) {
            var tone = p.days_left <= 7 ? 'danger' : (p.days_left <= 30 ? 'warn' : 'mute');
            h += '<div class="wb-exp-item">' +
                '<i class="wb-exp-dot" style="background:' + trSourceColor(p.name) + '"></i>' +
                '<span class="wb-exp-who">' + who + '</span>' +
                '<span class="wb-exp-name">' + trEsc(p.name) + '</span>' +
                '<b>' + trFmtNum(p.amount) + ' 积分</b>' +
                '<span class="adm-hint">' + trEsc(p.expire_text || '—') + '</span>' +
                '<span class="wb-exp-badge ' + tone + '">' +
                trEsc(trLeftText(p)) + '</span></div>';
        });
        h += '</div>';
    }
    if (acct.expires_text) {
        h += acct.expires_soon
            ? '<div class="wb-error" style="margin-top:10px"><i class="bi bi-exclamation-triangle"></i><span>' +
              'Cloud-IDE-Token 有效期至 ' + trEsc(acct.expires_text) +
              '，即将过期，请重新获取并点该账号「编辑」粘贴新值。</span></div>'
            : '<div class="adm-hint" style="margin-top:10px">Cloud-IDE-Token 有效期至 ' +
              trEsc(acct.expires_text) + '（与积分到期无关）</div>';
    }
    h += '</div></div>';
    return h;
}

/* ---------------- 账号管理区 ---------------- */
function trAccountBar(d) {
    var accounts = d.accounts || [];
    var cur = d.current_uid || '';
    var h = '<div class="adm-section">' + ADM.sectionHead('bi-people', '账号管理',
        '<div class="adm-btn-row">' +
        '<button class="adm-btn sm primary" id="trAddAcc" type="button"><i class="bi bi-person-plus"></i> 添加账号</button>' +
        '<button class="adm-btn sm ghost" id="trConnect" type="button"><i class="bi bi-link-45deg"></i> 网站连接登录</button>' +
        '<button class="adm-btn sm ghost" id="trCheckinAll" type="button"><i class="bi bi-check2-all"></i> 全部签到</button>' +
        '<button class="adm-btn sm ghost" id="trRefreshAll" type="button"><i class="bi bi-arrow-repeat"></i> 刷新余额</button>' +
        '</div>') + '<div class="wb-accounts">';
    if (!accounts.length) {
        h += '<div class="wb-accounts-empty"><i class="bi bi-person-plus"></i> ' +
            '还没有账号，点「添加账号」填写 Cloud-IDE-Token 后开始签到。</div>';
    }
    accounts.forEach(function (a) {
        var active = a.uid === cur;
        var initial = (a.display_name || '?').slice(0, 1).toUpperCase();
        h += '<div class="wb-account' + (active ? ' active' : '') + '" data-truid="' + trEsc(a.uid) + '">' +
            '<div class="wb-account-top">' +
            '<span class="wb-account-avatar">' + trEsc(initial) + '</span>' +
            '<div class="wb-account-id"><b>' + trEsc(a.display_name) + '</b>' +
            '<span class="adm-hint" title="' + trEsc(a.uid) + '">UID ' +
            trEsc(a.uid.slice(0, 12)) + (a.uid.length > 12 ? '…' : '') + '</span></div>' +
            (a.is_default ? '<span class="wb-account-badge">默认</span>' : '') +
            (active ? '<span class="wb-account-badge current">当前</span>' : '') +
            '</div>' +
            '<div class="wb-account-meta">' +
            '<span class="wb-account-balance"><i class="bi bi-coin"></i> ' +
            (a.last_balance === null || a.last_balance === undefined ? '—' : trFmtNum(a.last_balance)) +
            '<em>积分</em></span>' +
            '<span class="wb-account-tags"><i class="bi bi-key"></i> ' +
            (a.token_set ? 'Token 已配置' : '缺 Token') +
            '<span class="dot">·</span>' +
            '<i class="bi bi-phone"></i> ' + (a.device_id_set ? '设备号已配置' : '无设备号') +
            '</span></div>' +
            '<div class="wb-account-exp' + (a.expires_soon ? ' warn' : '') + '">' +
            trEsc(a.expires_text ? 'Token 有效期至 ' + a.expires_text : '有效期未知（约 7 天一轮）') +
            '</div>' +
            '<div class="wb-account-acts">' +
            '<button class="adm-btn sm ghost" data-tract="use"' + (active ? ' disabled' : '') + '>切换</button>' +
            '<button class="adm-btn sm ghost" data-tract="edit">编辑</button>' +
            '<button class="adm-btn sm ghost" data-tract="default"' +
            (a.is_default ? ' disabled' : '') + '>设为默认</button>' +
            '<button class="adm-btn sm ghost" data-tract="del">移除</button>' +
            '</div></div>';
    });
    h += '</div></div>';
    return h;
}

/* ---------------- 事件绑定 ---------------- */
function trBind(el, d) {
    var reload = el.querySelector('#trReload');
    if (reload) reload.addEventListener('click', function () {
        trRefresh(el, undefined, true);   // 手动「刷新」才拉取官方最新数据
    });

    var checkin = el.querySelector('#trCheckin');
    if (checkin) checkin.addEventListener('click', async function () {
        checkin.disabled = true;
        try {
            var r = await ADM.api('/api/traecn/checkin', {
                method: 'POST', body: { source: 'manual', uid: trCurrentUid }
            });
            ADM.toast(r.status === 'success'
                ? ('签到成功，+' + trFmtNum(r.credit) + ' 积分')
                : (r.message || '今天已签到'),
                r.status === 'success' ? 'ok' : 'warn');
            await trRefresh(el, undefined, true);   // 签到后余额 / 状态已变化
        } catch (e) {
            ADM.toast((e && e.message) || String(e), 'err');
            checkin.disabled = false;
        }
    });

    var test = el.querySelector('#trTest');
    if (test) test.addEventListener('click', async function () {
        test.disabled = true;
        try {
            var r = await ADM.api('/api/traecn/test', {
                method: 'POST', body: { uid: trCurrentUid }
            });
            ADM.toast('连接正常：' + (r.status && r.status.checked_in
                ? '今日已签到'
                : '今日待签到'), 'ok');
        } catch (e) {
            ADM.toast((e && e.message) || String(e), 'err');
        }
        test.disabled = false;
    });

    [el.querySelector('#trAddBtn'), el.querySelector('#trAddBtn2'),
        el.querySelector('#trAddAcc')].forEach(function (btn) {
        if (btn) btn.addEventListener('click', function () { trOpenAddAccount(el); });
    });

    var autoDevBtn = el.querySelector('#trAutoDev');
    if (autoDevBtn) autoDevBtn.addEventListener('click', async function () {
        autoDevBtn.disabled = true;
        try {
            var r = await ADM.api('/api/traecn/device_id/auto', { method: 'POST', body: {} });
            var n = (r.filled || []).length;
            if (n) ADM.toast('已为 ' + n + ' 个账号自动配置设备号', 'ok');
            else ADM.toast('本机未找到可用的 Trae 设备标识（请确认已安装并登录 Trae 客户端 / CLI）', 'warn');
            await trRefresh(el, '');
        } catch (e) {
            ADM.toast((e && e.message) || String(e), 'err');
        } finally {
            autoDevBtn.disabled = false;
        }
    });

    var connectBtn = el.querySelector('#trConnect');
    if (connectBtn) connectBtn.addEventListener('click', async function () {
        connectBtn.disabled = true;
        try {
            var r = await ADM.api('/api/traecn/connect', { method: 'POST', body: {} });
            var lines = [];
            (r.found || []).forEach(function (a) {
                lines.push('<div class="wb-ok"><i class="bi bi-check2-circle"></i> 已导入：' +
                    trEsc(a.display_name || a.uid) +
                    ' <small class="adm-hint">（' + trEsc(a.edition) + ' · ' + trEsc(a.uid) + '）</small></div>');
            });
            (r.errors || []).forEach(function (e) {
                lines.push('<div class="wb-err"><i class="bi bi-exclamation-triangle"></i> ' +
                    trEsc(e.edition + '/' + e.source) + '：' + trEsc(e.error) + '</div>');
            });
            if (!lines.length) {
                lines.push('<div class="adm-hint" style="display:block;line-height:1.9">' +
                    '未在本机发现 Trae 客户端登录态（storage.json / CLI token）。' +
                    '请确认已安装并登录过 Trae 桌面客户端或 CLI（本功能读取本机 <code>~/.config/trae-cn</code> 等目录下的登录态，' +
                    '无需手动复制 Token）。</div>');
            }
            await ADM.modal({
                title: '网站连接登录', icon: 'bi-link-45deg',
                html: '<div class="adm-fields">' + lines.join('') + '</div>',
                okText: '完成', cancelText: '',
                onOk: function () { return true; }
            });
            await trRefresh(el, '');
        } catch (e) {
            ADM.toast((e && e.message) || String(e), 'err');
        } finally {
            connectBtn.disabled = false;
        }
    });

    var all = el.querySelector('#trCheckinAll');
    if (all) all.addEventListener('click', async function () {
        all.disabled = true;
        try {
            var r = await ADM.api('/api/traecn/checkin/all', { method: 'POST', body: {} });
            var s = r.summary || {};
            ADM.toast('批量签到：成功 ' + (s.success || 0) + ' · 已签 ' + (s.already || 0) +
                ' · 失败 ' + (s.failed || 0), s.failed ? 'warn' : 'ok');
            await trRefresh(el, undefined, true);
        } catch (e) {
            ADM.toast((e && e.message) || String(e), 'err');
            all.disabled = false;
        }
    });
    var refreshAll = el.querySelector('#trRefreshAll');
    if (refreshAll) refreshAll.addEventListener('click', async function () {
        refreshAll.disabled = true;
        try {
            var r = await ADM.api('/api/traecn/accounts/refresh_all', { method: 'POST', body: {} });
            var s = r.summary || {};
            ADM.toast('余额刷新：成功 ' + (s.success || 0) + ' · 失败 ' + (s.failed || 0),
                s.failed ? 'warn' : 'ok');
            await trRefresh(el, undefined, true);
        } catch (e) {
            ADM.toast((e && e.message) || String(e), 'err');
            refreshAll.disabled = false;
        }
    });

    /* 积分构成「明细」折叠切换（Tab 懒挂载后可能重新绑定，用标志位防重复） */
    el.querySelectorAll('[data-trcomp-toggle]').forEach(function (btn) {
        if (btn.dataset.trcompBound) return;
        btn.dataset.trcompBound = '1';
        btn.addEventListener('click', function () {
            var key = btn.dataset.trcompToggle;
            var box = el.querySelector('[data-trcomp-detail="' + key + '"]');
            if (!box) return;
            box.hidden = !box.hidden;
            btn.textContent = box.hidden ? '明细' : '收起';
        });
    });

    /* 点日历格子 → 按账号筛选下方签到记录表（同 WorkBuddy） */
    el.querySelectorAll('[data-trcaluid]').forEach(function (cell) {
        cell.addEventListener('click', function () {
            trHistoryUid = cell.dataset.trcaluid || '';
            var sel = el.querySelector('#trHistoryAccount');
            if (sel) sel.value = trHistoryUid;
            var host = el.querySelector('[data-adm-serv="traecn-history"]');
            if (!host) return;
            var st = ADM._servTables['traecn-history'];
            if (st) st.page = 1;
            ADM.loadServ(host, 'traecn-history');
            if (host.scrollIntoView) {
                host.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
        });
    });

    el.querySelectorAll('[data-tract]').forEach(function (btn) {
        btn.addEventListener('click', async function () {
            var host = btn.closest('.wb-account');
            var uid = host ? host.dataset.truid : '';
            var act = btn.dataset.tract;
            if (!uid) return;
            if (act === 'del') {
                var nameEl = host.querySelector('.wb-account-id b');
                var accName = nameEl ? nameEl.textContent : uid;
                var ok = await ADM.confirm('移除 Trae CN 账号',
                    '将删除「' + trEsc(accName) + '」在本机保存的 Token（不影响官方账号本身），下次使用需重新填写。',
                    '确认移除');
                if (!ok) return;
                btn.disabled = true;
                try {
                    await ADM.api('/api/traecn/accounts/delete', { method: 'POST', body: { uid: uid } });
                    ADM.toast('账号已移除', 'ok');
                    await trRefresh(el, '');
                } catch (err) {
                    ADM.toast((err && err.message) || String(err), 'err');
                    btn.disabled = false;
                }
                return;
            }
            btn.disabled = true;
            try {
                if (act === 'use') {
                    await ADM.api('/api/traecn/accounts/current',
                        { method: 'POST', body: { uid: uid } });
                    ADM.toast('已切换账号', 'ok');
                    await trRefresh(el, uid);
                } else if (act === 'default') {
                    await ADM.api('/api/traecn/accounts/save',
                        { method: 'POST', body: { uid: uid, is_default: true } });
                    ADM.toast('已设为默认账号', 'ok');
                    await trRefresh(el);
                } else if (act === 'edit') {
                    btn.disabled = false;
                    trOpenAddAccount(el, uid);
                }
            } catch (e) {
                ADM.toast((e && e.message) || String(e), 'err');
                btn.disabled = false;
            }
        });
    });
}

/* ---------------- 手动添加 / 编辑账号弹窗 ---------------- */
async function trOpenAddAccount(el, uid) {
    var acc = null;
    if (uid) {
        var accounts = [];
        try {
            var r = await ADM.api('/api/traecn/accounts');
            accounts = r.items || [];
        } catch (e) { /* 列表拿不到也能新增 */ }
        acc = accounts.find(function (a) { return a.uid === uid; }) || null;
    }
    var isEdit = !!acc;
    var html = '<div class="adm-fields">' + [
        ADM.fieldHtml({
            name: 'token', label: 'Cloud-IDE-Token（JWT，' + (isEdit ? '留空保持原值' : '必填') + '）',
            type: 'password', value: '',
            placeholder: 'eyJhbGciOi…（形如 xxx.yyy.zzz 的三段式 JWT）'
        }),
        ADM.fieldHtml({
            name: 'device_id', label: '设备号 device_id（可选，签到领取必需）', value: '',
            placeholder: '纯数字串，来自 Trae CN 客户端 aha.device.device_id'
        }),
        ADM.fieldHtml({
            name: 'uid', label: '账号 UID（选填，留空以 Token 指纹为账号标识）',
            value: isEdit ? acc.uid : '', placeholder: '可自定义，便于与其它工具对账'
        }),
        ADM.fieldHtml({
            name: 'remark', label: '备注 / 昵称',
            value: isEdit ? (acc.nickname || acc.remark || '') : '', placeholder: '便于区分，如「主力号」'
        })
    ].join('') +
        '<div class="adm-hint" style="display:block;line-height:1.8">' +
        '获取方式：登录 <a href="https://trae.cn" target="_blank" rel="noopener noreferrer">trae.cn</a> 网页版或客户端 → ' +
        '开发者工具（F12）→ Application / 存储 → Cloud-IDE-Token。<br>' +
        'JWT 约 7 天过期（客户端内部靠 refresh 机制自动续签，静态 Token 不会），过期后重新获取并点该账号「编辑」粘贴新值；' +
        '签到领取需要 device_id，缺失时接口报 code=9004。<br>' +
        'Token 仅加密保存在本机 store.db，页面与日志均不回显；同 UID 再次添加会覆盖更新该账号。</div>';
    var result = await ADM.modal({
        title: isEdit ? '编辑 Trae CN 账号 · ' + trEsc(acc.display_name) : '添加 Trae CN 账号',
        icon: 'bi-lightning-charge',
        html: html,
        okText: isEdit ? '保存' : '添加账号',
        onOpen: function (box) {
            var ta = box.querySelector('[name="token"]');
            if (!ta) return;
            var tip = document.createElement('div');
            tip.className = 'adm-hint';
            tip.style.cssText = 'display:block;margin-top:4px';
            ta.insertAdjacentElement('afterend', tip);
            ta.addEventListener('input', function () {
                var p = trJwtPayload(ta.value);
                if (!ta.value.trim()) { tip.textContent = '粘贴后自动解析有效期（Trae 的 userId 不在 JWT 里，UID 可留空）'; return; }
                if (!Object.keys(p).length) {
                    tip.textContent = '无法解析为 JWT，请确认是完整的三段式 Cloud-IDE-Token';
                    return;
                }
                var parts = [];
                if (p.exp) {
                    try { parts.push('有效期至 ' + new Date(p.exp * 1000).toLocaleString('zh-CN')); }
                    catch (e) { /* 时间异常不影响 */ }
                }
                var uidHint = p.user_id || p.userId || p.uid || p.sub || '';
                if (uidHint) {
                    parts.push('UID ' + uidHint);
                } else {
                    parts.push('Token 内不含账号标识（Trae 的 userId 不在 JWT 里），留空 UID 将以 Token 指纹作为账号标识');
                }
                tip.textContent = '已解析：' + parts.join(' · ');
            });
        },
        onOk: async function (box) {
            var f = ADM.readForm(box);
            var token = (f.token || '').trim();
            var body = {
                uid: (f.uid || '').trim(),
                device_id: (f.device_id || '').trim(),
                remark: (f.remark || '').trim()
            };
            if (token) body.token = token;
            if (isEdit && !body.uid) body.uid = acc.uid;
            if (!body.uid) {
                var p = trJwtPayload(token);
                body.uid = String(p.user_id || p.userId || p.uid || p.sub || '').trim();
                if (!body.uid && token) body.uid = 'tok_' + trTokenFingerprint(token);
            }
            if (!body.uid) throw new Error('缺少账号标识：请填写 Cloud-IDE-Token 或手动填 UID');
            if (!isEdit && !token) throw new Error('请填写 Cloud-IDE-Token');
            var r = await ADM.api('/api/traecn/accounts/save', { method: 'POST', body: body });
            return (r.account && r.account.uid) || true;
        }
    });
    if (result) {
        ADM.toast(isEdit ? '账号已保存' : '账号已添加', 'ok');
        await trRefresh(el, typeof result === 'string' ? result : '');
    }
}

/* ---------------- 模型与档位（对齐 WorkBuddy 的「模型与档位」模块） ----------------
 * 数据：/api/traecn/models
 *   · 档位 / 额度 —— 官方 api.trae.cn 用量接口（订阅权益包）
 *   · 模型清单 —— 本机 Trae CN 客户端缓存（state.vscdb 里的 model_list_map）
 * 表格样式与徽章函数复用 WorkBuddy 的 wb-*（同一后台、同一套 CSS）。
 */
var trModelsState = { models: [], q: '', cap: 'all', sortKey: '', sortDir: '' };

/* 各可排序列取值：无倍率 / 无容量的模型视为未知，永远排最后 */
function trModelsSortVal(m, key) {
    if (key === 'id') return String(m.id || '').toLowerCase();
    if (key === 'rate') {
        if (m.rate === null || m.rate === undefined || m.rate === '') return null;
        var r = Number(m.rate_num);
        return Number.isFinite(r) ? r : null;
    }
    var field = key === 'ctx' ? 'max_input' : (key === 'out' ? 'max_output' : key);
    var v = Number(m[field]);
    return (Number.isFinite(v) && v > 0) ? v : null;
}

/* 表头排序指示：未排序 ↕，升序 ▲，降序 ▼ */
function trModelsSyncSort() {
    var tb = document.getElementById('trModelsBody');
    if (!tb) return;
    tb.querySelectorAll('th[data-sort]').forEach(function (th) {
        var on = th.dataset.sort === trModelsState.sortKey && !!trModelsState.sortDir;
        var ind = th.querySelector('.wb-sort-ind');
        if (!ind) return;
        ind.className = 'wb-sort-ind' + (on ? ' on' : '');
        ind.textContent = on ? (trModelsState.sortDir === 'desc' ? '▼' : '▲') : '↕';
    });
}

/* 点击表头：升序 → 降序 → 恢复接口默认顺序 */
function trModelsToggleSort(key) {
    var s = trModelsState;
    if (s.sortKey !== key) { s.sortKey = key; s.sortDir = 'asc'; }
    else if (s.sortDir === 'asc') { s.sortDir = 'desc'; }
    else if (s.sortDir === 'desc') { s.sortKey = ''; s.sortDir = ''; }
    else { s.sortDir = 'asc'; }
    trModelsRender();
}

/* 能力徽章：视觉 / 思考 / 自定义 / Beta（样式沿用 wb-cap） */
function trCapBadges(caps) {
    var cls = { '视觉': 'vis', '思考': 'think', '自定义': 'agent', 'Beta': 'img' };
    return (caps || []).map(function (c) {
        return '<span class="wb-cap ' + (cls[c] || '') + '">' + wbEsc(c) + '</span>';
    }).join('');
}

function trModelsHtml(d) {
    var tier = d.tier || {};
    var c = d.counts || { total: 0, vision: 0, reasoning: 0, custom: 0 };
    var h = '<div class="adm-section">' + ADM.sectionHead('bi-award', '订阅档位',
        '<span class="adm-hint">来自官方用量接口 · 账号 ' +
        wbEsc(String(d.uid || '').slice(0, 12)) + '</span>') +
        '<div class="adm-stat-grid">';
    h += ADM.stat('bi-award', '当前档位', wbEsc(tier.label || '未知'),
        tier.is_paid ? '付费订阅账号' : '免费 / 体验账号');
    h += ADM.stat('bi-coin', '可用积分',
        (tier.remain === null || tier.remain === undefined) ? '—' : wbFmtNum(tier.remain),
        (tier.total === null || tier.total === undefined)
            ? '额度未知'
            : '已用 ' + wbFmtNum(tier.used) + ' / 共 ' + wbFmtNum(tier.total));
    h += ADM.stat('bi-gift', '每月赠送',
        tier.monthly_bonus ? wbFmtNum(tier.monthly_bonus) : '—',
        '登录赠送等权益包合计（积分 / 月）');
    h += ADM.stat('bi-layers', '云端并行任务',
        tier.parallel ? String(tier.parallel) : '—', 'SOLO Agent 并行上限');
    h += ADM.stat('bi-cpu', '可用模型', wbFmtNum(c.total || 0), '读本机客户端模型缓存');
    h += ADM.stat('bi-eye', '视觉模型', wbFmtNum(c.vision || 0), '多模态 / 图片理解模型数');
    h += ADM.stat('bi-lightbulb', '思考模型', wbFmtNum(c.reasoning || 0), '支持思考档位的模型数');
    h += ADM.stat('bi-sliders', '自定义模型', wbFmtNum(c.custom || 0), '自带 API Key 接入的模型数');
    h += '</div>';
    if (tier.in_trial || tier.trial_eligible) {
        h += '<div class="adm-hint" style="margin-top:10px">' +
            (tier.in_trial ? '当前处于试用期（Trial）。' : '账号可开通试用（Trial）。') + '</div>';
    }
    h += '</div>';
    if (d.tier_error) {
        h += '<div class="adm-section"><div class="wb-empty">档位信息获取失败：' +
            wbEsc(d.tier_error) + '</div></div>';
    }

    var filters =
        '<div class="wb-model-filters">' +
        '<div class="wb-model-search"><i class="bi bi-search"></i>' +
        '<input type="text" id="trModelsSearch" placeholder="搜索模型 ID / 名称 / 厂商…" ' +
        'aria-label="搜索模型" value="' + wbEsc(trModelsState.q) + '"></div>' +
        '<div class="wb-model-capf" role="group" aria-label="能力筛选">' +
        [['all', '全部'], ['vis', '视觉'], ['think', '思考'], ['custom', '自定义']].map(function (p) {
            return '<button type="button" class="wb-capf-btn' +
                (trModelsState.cap === p[0] ? ' active' : '') +
                '" data-cap="' + p[0] + '">' + p[1] + '</button>';
        }).join('') + '</div>' +
        '<span class="wb-realm-tag" title="' + wbEsc(d.source || '') + '">' +
        '<i class="bi bi-hdd"></i> 来源：本机客户端缓存</span>' +
        '<button class="adm-btn sm ghost" id="trModelsRefresh" type="button">' +
        '<i class="bi bi-arrow-clockwise"></i> 刷新</button>' +
        '<span class="wb-model-count" id="trModelsCount" role="status"></span>' +
        '</div>';

    var table = d.catalog_error
        ? '<div class="wb-empty">' + wbEsc(d.catalog_error) + '</div>'
        : '<div class="wb-model-table-wrap"><table class="wb-pack-table wb-model-table">' +
          '<thead><tr>' +
          '<th class="wb-sortable" data-sort="id" tabindex="0" role="button" ' +
          'title="按模型 ID 排序">模型<span class="wb-sort-ind">↕</span></th>' +
          '<th class="wb-sortable" data-sort="rate" tabindex="0" role="button" ' +
          'title="按积分倍率排序（升序 → 降序 → 默认）">积分倍率<span class="wb-sort-ind">↕</span></th>' +
          '<th>默认档</th><th>支持思考档位</th>' +
          '<th class="wb-sortable" data-sort="ctx" tabindex="0" role="button" ' +
          'title="按上下文长度排序">上下文长度<span class="wb-sort-ind">↕</span></th>' +
          '<th class="wb-sortable" data-sort="out" tabindex="0" role="button" ' +
          'title="按最大输出排序">最大输出<span class="wb-sort-ind">↕</span></th>' +
          '</tr></thead><tbody id="trModelsRows"></tbody></table>' +
          '<div class="wb-empty" id="trModelsEmpty" hidden>没有符合条件的模型</div>' +
          '</div>';

    return h + '<div class="adm-section">' + ADM.sectionHead('bi-cpu', '可用模型列表',
        '<span class="adm-hint">清单读本机 Trae CN 客户端缓存 · 倍率取自客户端模型目录 · 点表头排序</span>') +
        (d.catalog_error ? '' : filters) + table + '</div>';
}

function trModelsRender() {
    var tb = document.getElementById('trModelsRows');
    var empty = document.getElementById('trModelsEmpty');
    var cnt = document.getElementById('trModelsCount');
    if (!tb) return;
    trModelsSyncSort();
    var q = trModelsState.q.trim().toLowerCase();
    var list = trModelsState.models.filter(function (m) {
        if (trModelsState.cap === 'vis' && !m.multimodal) return false;
        if (trModelsState.cap === 'think' && !m.thinking) return false;
        if (trModelsState.cap === 'custom' && !m.custom) return false;
        if (q && (m.id + ' ' + (m.name || '') + ' ' + (m.vendor || '')).toLowerCase().indexOf(q) < 0) return false;
        return true;
    });
    var sk = trModelsState.sortKey, sd = trModelsState.sortDir;
    if (sk && sd) {
        list = list.slice().sort(function (a, b) {
            var va = trModelsSortVal(a, sk), vb = trModelsSortVal(b, sk);
            if (va === null && vb === null) return 0;
            if (va === null) return 1;
            if (vb === null) return -1;
            if (typeof va === 'string') {
                return sd === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
            }
            return sd === 'asc' ? va - vb : vb - va;
        });
    }
    if (cnt) cnt.textContent = '共 ' + list.length + ' / ' + trModelsState.models.length + ' 个';
    if (!list.length) { tb.innerHTML = ''; if (empty) empty.hidden = false; return; }
    if (empty) empty.hidden = true;
    tb.innerHTML = list.map(function (m) {
        var rateN = Number(m.rate_num);
        var rateHtml;
        if (m.rate === null || m.rate === undefined || m.rate === '') {
            rateHtml = '<span class="wb-rate-val">—</span>';
        } else if (Number.isFinite(rateN) && rateN === 0) {
            rateHtml = '<b class="wb-rate-val free">0×</b><span class="wb-rate-badge warn">限时免费</span>';
        } else if (Number.isFinite(rateN)) {
            rateHtml = '<b class="wb-rate-val">×' + rateN + '</b>';
        } else {
            rateHtml = '<b class="wb-rate-val">×' + wbEsc(m.rate) + '</b>';
        }
        var memberN = Number(m.member_rate);
        if (m.member_rate !== null && m.member_rate !== undefined && Number.isFinite(memberN) &&
                memberN !== rateN) {
            rateHtml += '<span class="wb-rate-badge" title="订阅会员折扣价">会员 ×' + memberN + '</span>';
        }
        var effs = (m.efforts || []).map(wbEffBadge).join('');
        if (!effs) {
            effs = m.thinking
                ? '<span class="wb-eff fixed">固定档</span>'
                : '<span class="wb-eff none">不支持思考</span>';
        }
        var defCell = m.effort_default
            ? '<span class="wb-eff default">' + wbEsc(m.effort_default) + '</span>'
            : '—';
        var caps = trCapBadges(m.caps) +
            (m.default ? '<span class="wb-cap agent">默认</span>' : '');
        var scenes = (m.scenes || []).map(function (s) {
            return '<span class="wb-tag">' + wbEsc(s) + '</span>';
        }).join('');
        return '<tr data-mid="' + wbEsc(m.id) + '">' +
            '<td class="wb-model-id"><div class="wb-mid-line"><span class="wb-mname mono">' +
            wbEsc(m.id || '—') + '</span>' +
            '<button class="wb-copy" type="button" data-copy="' + wbEsc(m.id) +
            '" title="复制模型 ID"><i class="bi bi-clipboard"></i></button></div>' +
            ((m.name || m.vendor)
                ? '<div class="wb-mvendor">' + wbEsc([m.vendor, m.name].filter(Boolean).join(' · ')) + '</div>'
                : '') +
            (caps ? '<div class="wb-mcaps">' + caps + '</div>' : '') +
            (scenes ? '<div class="wb-mtags">' + scenes + '</div>' : '') +
            '</td>' +
            '<td class="wb-rate-cell">' + rateHtml + '</td>' +
            '<td>' + defCell + '</td>' +
            '<td>' + effs + '</td>' +
            '<td class="wb-num">' + wbFmtK(m.max_input) + '</td>' +
            '<td class="wb-num">' + wbFmtK(m.max_output) + '</td></tr>';
    }).join('');
}

function trModelsBind(d, body) {
    trModelsState.models = d.models || [];
    var s = body.querySelector('#trModelsSearch');
    if (s) s.addEventListener('input', function () {
        trModelsState.q = s.value;
        trModelsRender();
    });
    body.querySelectorAll('th[data-sort]').forEach(function (th) {
        var key = th.dataset.sort;
        th.addEventListener('click', function () { trModelsToggleSort(key); });
        th.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
                e.preventDefault();
                trModelsToggleSort(key);
            }
        });
    });
    body.querySelectorAll('.wb-capf-btn').forEach(function (b) {
        b.addEventListener('click', function () {
            trModelsState.cap = b.dataset.cap;
            body.querySelectorAll('.wb-capf-btn').forEach(function (x) {
                x.classList.toggle('active', x === b);
            });
            trModelsRender();
        });
    });
    body.querySelectorAll('.wb-copy').forEach(function (b) {
        b.addEventListener('click', function () {
            var id = b.dataset.copy || '';
            try {
                navigator.clipboard.writeText(id);
                b.innerHTML = '<i class="bi bi-check2"></i>';
                setTimeout(function () { b.innerHTML = '<i class="bi bi-clipboard"></i>'; }, 1200);
            } catch (_) { /* 非安全上下文忽略 */ }
        });
    });
    trModelsRender();
}

/* 模型与档位：挂载后拉一次；点「刷新」强制重拉 */
async function trLoadModels(el, force) {
    var body = el.querySelector('#trModelsBody');
    if (!body) return;
    if (body.dataset.loaded && !force) return;
    body.innerHTML = '<div class="wb-empty">正在读取模型清单…</div>';
    try {
        var d = await ADM.api('/api/traecn/models?uid=' + encodeURIComponent(trCurrentUid || ''));
        if (d.error) {
            body.innerHTML = '<div class="wb-empty">' + wbEsc(d.error) + '</div>';
            return;
        }
        body.dataset.loaded = '1';
        body.innerHTML = trModelsHtml(d);
        trModelsBind(d, body);
        var rb = body.querySelector('#trModelsRefresh');
        if (rb) rb.addEventListener('click', function () { trLoadModels(el, true); });
    } catch (e) {
        body.innerHTML = '<div class="wb-empty">加载失败：' +
            wbEsc((e && e.message) || String(e)) + '</div>';
    }
}

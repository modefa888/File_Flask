/* 后台管理：WorkBuddy 积分 / 每日签到。
 * 数据来自 /api/workbuddy/*（服务端读取本机登录态或已加密保存的凭据，
 * 调用官方计费接口）。accessToken 永远不会回显到页面。 */
ADM.modules.push({
    id: 'workbuddy',
    name: 'WorkBuddy 积分',
    subtitle: '积分余额 · 每日签到 · 签到记录',
    icon: 'bi-coin',
    async load(el) {
        el.innerHTML = ADM.loading('正在读取 WorkBuddy 积分…');
        await wbRefresh(el);
    }
});

/* 当前账号：所有查询 / 签到都按它进行；空串 = 跟随服务端默认账号 */
var wbCurrentUid = '';
/* 签到记录表 / 日历共用的「按账号筛选」：点日历格子或下拉都会更新它 */
var wbHistoryUid = '';
/* servTable 会复用同 key 的 state，账号列表走全局变量保证下拉选项始终最新 */
var wbHistoryAccounts = [];

/* ---------------- 小工具 ---------------- */
function wbFmtNum(v) {
    if (v === null || v === undefined || v === '' || isNaN(Number(v))) return '—';
    var n = Number(v);
    var s = (Math.round(n * 100) / 100).toLocaleString('zh-CN');
    return s;
}

function wbDayStr(dt) {
    var p = function (x) { return (x < 10 ? '0' : '') + x; };
    return dt.getFullYear() + '-' + p(dt.getMonth() + 1) + '-' + p(dt.getDate());
}

function wbEsc(s) { return ADM.esc(s === null || s === undefined ? '' : s); }

/* 实时倒计时（超过 1 天按天，1 天内精确到小时 / 分钟）：基于 end_at 现算 */
function wbLeftText(p) {
    var end = Number(p.end_at);
    if (!end || end <= 0) return '—';
    var left = end * 1000 - Date.now();
    if (!(left > 0)) return '已到期';
    var d = Math.floor(left / 86400000),
        h = Math.floor((left % 86400000) / 3600000),
        m = Math.floor((left % 3600000) / 60000);
    return d > 0 ? (d + '天') : (h + '小时' + m + '分');
}

/* ---------------- 首屏 ---------------- */
/* fresh=true 才请求官方最新数据；默认只读本地库（切换账号 / 首屏即时返回） */
async function wbRefresh(el, uid, fresh) {
    if (uid !== undefined) {
        wbCurrentUid = uid || '';
        if (uid) wbHistoryUid = '';   // 切换账号后清掉旧筛选，避免表格显示「无记录」
    }
    var url = '/api/workbuddy/overview' +
        (wbCurrentUid ? '?uid=' + encodeURIComponent(wbCurrentUid) : '');
    if (fresh) url += (url.indexOf('?') >= 0 ? '&' : '?') + 'fresh=1';
    var d;
    try {
        d = await ADM.api(url);
    } catch (e) {
        el.innerHTML = '<div class="adm-card"><div class="adm-hint">加载失败：' +
            wbEsc((e && e.message) || e) + '</div></div>';
        return;
    }
    d = d || {};
    wbCurrentUid = d.current_uid || '';
    wbRender(el, d);
    wbBind(el, d);
}

function wbRender(el, d) {
    var cfg = d.config || {};
    wbHistoryAccounts = d.accounts || [];
    var st = d.status || {};
    var cr = d.credits || {};
    var errs = d.errors || {};
    var isGlobal = ((d.account && d.account.realm) ||
        (d.credential && d.credential.realm) || 'cn') === 'global';
    var cached = !!d.cached;   // 本地缓存模式：切换账号 / 首屏零外呼
    var checked = st.today_checked_in === true || st.already === true;
    var unknown = !d.configured || (st.today_checked_in === undefined && !st.already);
    var stateHtml = isGlobal
        ? '<span class="wb-state ok"><i class="bi bi-globe2"></i> 国际版 · 注册激活 / 试用包</span>'
        : (checked
            ? '<span class="wb-state ok"><i class="bi bi-check2-circle"></i> 今日已签到</span>'
            : (unknown
                ? '<span class="wb-state"><i class="bi bi-question-circle"></i> 签到状态未知</span>'
                : '<span class="wb-state warn"><i class="bi bi-alarm"></i> 今日待签到</span>'));

    /* ---- 账号管理 ---- */
    var html = wbAccountBar(d);

    /* ---- 顶部指标：与 hero 大数字互补，不再重复显示余额 ---- */
    html += '<div class="adm-section">' + ADM.sectionHead('bi-graph-up', '积分总览',
        '<span class="adm-hint">' + (cached
            ? '本地缓存数据（签到状态按本机记录推断） · 点右上「刷新」拉取官方最新'
            : '数据来源：WorkBuddy 官方计费接口 · 更新于 ' + wbEsc(ADM.dt(d.updated_at))) +
        '</span>') + '<div class="adm-stat-grid wb-stats">';
    if (isGlobal) {
        html += ADM.stat('bi-globe2', '账号版本',
            '<span class="wb-stat-ok">国际版</span>', 'workbuddy.ai · 无每日签到体系');
        html += ADM.stat('bi-lightning-charge', '连续签到', '—', '国际版不提供连签数据');
        html += ADM.stat('bi-gift', '积分动作', '试用包', '一次性 trial 加油包（幂等）');
        html += ADM.stat('bi-coin', '今日可得积分', '—', '国际版无每日签到发放');
    } else {
        html += ADM.stat('bi-calendar2-check', '今日签到',
            checked ? '<span class="wb-stat-ok">已签到</span>'
                : (unknown ? '未知' : '<span class="wb-stat-warn">待签到</span>'),
            d.today ? ('本地日期 ' + wbEsc(d.today)) : '');
        html += ADM.stat('bi-lightning-charge', '连续签到', wbFmtNum(st.streak_days || 0) + ' 天',
            '断签后连签天数会重置');
        html += ADM.stat('bi-gift', '累计签到积分', wbFmtNum(st.total_credits || 0),
            '活动周期内签到所得累计');
        html += ADM.stat('bi-coin', '今日可得积分', wbFmtNum(st.today_credit || 0),
            '每日签到发放的额度');
    }
    html += '</div></div>';

    /* ---- 主卡片：余额 + 分组操作 ---- */
    var canCheck = !!d.configured && (isGlobal || !checked);
    var checkText = isGlobal ? '激活并领取试用积分'
        : (checked ? '今日已签到' : '立即签到');
    html += '<div class="adm-section"><div class="wb-hero">' +
        '<div class="wb-hero-main">' +
        '<div class="wb-hero-label"><i class="bi bi-stars"></i> ' +
        wbEsc((d.account && d.account.display_name) || 'WorkBuddy') +
        (isGlobal ? ' · 国际版' : ' · 国内版') + ' · 当前可用积分</div>' +
        '<div class="wb-balance">' + wbFmtNum(cr.balance) + '<small>积分</small></div>' +
        '<div class="wb-hero-sub">' + stateHtml +
        (cached ? '<span class="wb-cache-tag"><i class="bi bi-database"></i> 缓存数据</span>' : '') +
        (cr.expire_at ? ('<span class="wb-hero-expire"><i class="bi bi-clock"></i> 额度有效期 ' +
            wbEsc(cr.expire_at) + '</span>') : '') +
        '</div></div>' +
        '<div class="wb-hero-actions">' +
        '<div class="wb-hero-primary">' +
        '<button class="adm-btn primary wb-btn-main" id="wbCheckin" type="button"' +
        (canCheck ? '' : ' disabled') + '><i class="bi ' +
        (isGlobal ? 'bi-globe2' : 'bi-hand-thumbs-up') + '"></i> ' +
        checkText + '</button></div>' +
        '<div class="wb-hero-tools">' +
        '<button class="adm-btn ghost" id="wbReload" type="button"><i class="bi bi-arrow-clockwise"></i> 刷新</button>' +
        '<button class="adm-btn ghost" id="wbTest" type="button"><i class="bi bi-plug"></i> 测试连接</button>' +
        '<button class="adm-btn ghost" id="wbQrLogin" type="button"><i class="bi bi-qr-code"></i> 扫码登录</button>' +
        '<button class="adm-btn ghost" id="wbConfig" type="button"><i class="bi bi-key"></i> 凭据配置</button>' +
        '</div></div></div>';

    /* ---- 错误提示 ---- */
    var problems = [];
    if (!d.configured && d.error) problems.push(d.error);
    if (errs.status) problems.push('签到状态：' + errs.status);
    if (errs.credits) problems.push('积分余额：' + errs.credits);
    if (cr.error) problems.push(cr.error);
    if (problems.length) {
        html += '<div class="wb-errors">';
        problems.forEach(function (p) {
            html += '<div class="wb-error"><i class="bi bi-exclamation-triangle"></i><span>' +
                wbEsc(p) + '</span></div>';
        });
        html += '</div>';
    }
    html += '</div>';

    /* ---- 未配置时的引导 ---- */
    if (!d.configured) {
        var det = cfg.detected || {};
        html += '<div class="adm-section"><div class="wb-guide"><i class="bi bi-info-circle"></i><div>' +
            '<h3>登录 WorkBuddy 账号（国内版 / 国际版）</h3>' +
            '<p>点「微信扫码登录」打开官方登录页完成授权，模块会自动获取并加密保存 accessToken / uid，' +
            '无需手动复制凭据。也可以读取本机桌面端登录态文件（' +
            (det.path ? '已探测到 <code>' + wbEsc(det.path) + '</code>' :
                '常见位置：<code>' + wbEsc((cfg.auth_dirs || []).join(' / ')) + '</code>') +
            '），或在上方账号管理区点「手动添加」。凭据只在服务端使用并加密保存。</p>' +
            '<div class="adm-btn-row">' +
            '<button class="adm-btn primary sm" id="wbQrLogin2" type="button"><i class="bi bi-qr-code"></i> 微信扫码登录</button>' +
            '<button class="adm-btn sm" id="wbAddGlobal2" type="button"><i class="bi bi-globe2"></i> 国际版登录</button>' +
            '<button class="adm-btn sm ghost" id="wbConfig2" type="button"><i class="bi bi-sliders"></i> 全局设置</button>' +
            '</div></div></div></div>';
    }

    /* ---- 账户与活动（Tab：账户信息） ---- */
    var cred = d.credential || {};
    var acct = d.account || {};
    var from = isGlobal ? '国际版 OAuth 授权（workbuddy.ai）'
        : (acct.login_method === 'oauth' ? '微信扫码登录（OAuth）'
            : (acct.source === 'file' ? '本机登录态文件'
                : (acct.source === 'auto' ? '自动读取本机登录态' : '手动填写凭据')));
    var info = [
        ['bi-globe2', '账号版本', isGlobal ? '国际版（workbuddy.ai）' : '国内版（codebuddy.cn）'],
        ['bi-shield-check', '凭据来源', from],
        ['bi-globe2', '接口域名', cred.domain || acct.domain || cfg.default_domain || '-'],
        ['bi-person-badge', '账号 UID', acct.uid || cred.uid || '-'],
        ['bi-clock-history', '登录态有效期', acct.expires_text || cfg.expires_text || '-'],
        ['bi-coin', '今日可得积分', wbFmtNum(st.today_credit || 0)],
        ['bi-calendar-range', '活动周期',
            (st.start_time || st.end_time) ? ((st.start_time || '?') + ' ~ ' + (st.end_time || '?')) : '-'],
        ['bi-pie-chart', '已用额度',
            wbFmtNum(cr.used || 0) + (cr.total !== null && cr.total !== undefined ? (' / 总额 ' + wbFmtNum(cr.total)) : '')]
    ];
    var infoHtml = '<div class="adm-section">' + ADM.sectionHead('bi-info-square', '账户与活动') +
        '<div class="adm-card wb-info-card"><div class="wb-info-grid">';
    info.forEach(function (it) {
        var text = String(it[2] === null || it[2] === undefined ? '' : it[2]);
        infoHtml += '<div class="wb-info-item" title="' + wbEsc(text) + '">' +
            '<span class="wb-info-k"><i class="bi ' + it[0] + '"></i>' + wbEsc(it[1]) + '</span>' +
            '<span class="wb-info-v">' + wbEsc(text) + '</span></div>';
    });
    infoHtml += '</div></div></div>';

    /* ---- 最近 14 天签到日历（Tab：签到记录），按账号逐行展示 ---- */
    var calHtml = '<div class="adm-section">' + ADM.sectionHead('bi-calendar3', '各账号签到情况 · 最近 14 天',
        '<span class="adm-hint">每个账号一行 · 点格子可在下方记录表筛选该账号</span>') +
        '<div class="adm-card">' + wbCalendar(d.today, d.history_all || [],
            d.accounts || [], d.current_uid) + '</div></div>';

    /* ---- 签到记录表格（含账号列，按 UID 搜索即可筛选单个账号） ---- */
    var nameMap = {};
    (d.accounts || []).forEach(function (a) {
        nameMap[a.uid] = a.display_name || a.uid.slice(0, 8);
    });
    var cols = [
        {
            label: '账号', key: 'uid', render: function (r) {
                return '<span class="adm-cell-strong">' +
                    wbEsc(nameMap[r.uid] || (r.uid ? r.uid.slice(0, 8) + '…' : '-')) + '</span>';
            }
        },
        { label: '日期', key: 'day', sortKey: 'day', render: function (r) { return '<span class="adm-cell-strong">' + wbEsc(r.day) + '</span>'; } },
        { label: '时间', key: 'at_text', sortKey: 'at', render: function (r) { return wbEsc(r.at_text); } },
        {
            label: '结果', key: 'status_text', sortKey: 'status', render: function (r) {
                return r.status === 'success' ? ADM.badge('签到成功', 'ok')
                    : (r.status === 'already' ? ADM.badge('今日已签', 'info') : ADM.badge(wbEsc(r.status_text), 'warn'));
            }
        },
        { label: '获得积分', key: 'credit', sortKey: 'credit', render: function (r) { return '+' + wbFmtNum(r.credit); } },
        { label: '连签天数', key: 'streak_days', sortKey: 'streak_days', render: function (r) { return wbFmtNum(r.streak_days) + ' 天'; } },
        { label: '说明', key: 'message', render: function (r) { return wbEsc(r.message || '-'); } },
        { label: '来源', key: 'source', render: function (r) { return r.source === 'auto' ? '自动' : '手动'; } }
    ];
    var histHtml = '<div class="adm-section">' + ADM.sectionHead('bi-clock-history', '签到记录',
        '<span class="adm-hint">可用表格左上角下拉，或点日历格子按账号筛选</span>') +
        ADM.servTable(cols, {
            key: 'wb-history', pageSize: 10, sortable: true,
            empty: '暂无签到记录，点上方「立即签到」开始积累',
            onRender: function (host) { wbHistoryToolbar(host, wbHistoryAccounts); },
            fetch: function (p) {
                return ADM.api('/api/workbuddy/history?q=' + encodeURIComponent(p.q) +
                    '&page=' + p.page + '&page_size=' + p.size +
                    '&sort=' + encodeURIComponent(p.sort || '') + '&order=' + encodeURIComponent(p.order || '') +
                    '&uid=' + encodeURIComponent(wbHistoryUid || ''));
            }
        }) + '</div>';

    /* ---- 详情区：下方所有区块收进 Tab，首屏只留余额与签到操作 ---- */
    html += '<div class="adm-section wb-detail">' +
        ADM.sectionHead('bi-bar-chart', '积分与签到详情',
            '<span class="adm-hint">按需切换查看 · 选中的标签会自动保留</span>') +
        ADM.tabs([
            { id: 'history', name: '签到记录', icon: 'bi-clock-history',
                content: calHtml + histHtml },
            { id: 'composition', name: '积分构成', icon: 'bi-pie-chart',
                content: wbTotalStats(d.credits_summary) + wbComposition(d.credits_summary) },
            { id: 'expiry', name: '到期提醒', icon: 'bi-calendar2-week',
                content: wbExpiry(d.credits_summary) },
            { id: 'info', name: '账户信息', icon: 'bi-info-square', content: infoHtml }
        ], { key: 'wb-detail-tabs' }) + '</div>';

    el.innerHTML = html;
    ADM.mountServTables(el);
    ADM.mountTabs(el);
}

/* ---------------- 账号管理区 ---------------- */
function wbAccountBar(d) {
    var accounts = d.accounts || [];
    var cur = d.current_uid || '';
    var h = '<div class="adm-section">' + ADM.sectionHead('bi-people', '账号管理',
        '<div class="adm-btn-row">' +
        '<button class="adm-btn sm primary" id="wbAddQr" type="button"><i class="bi bi-qr-code"></i> 扫码添加</button>' +
        '<button class="adm-btn sm ghost" id="wbAddGlobal" type="button"><i class="bi bi-globe2"></i> 国际版登录</button>' +
        '<button class="adm-btn sm ghost" id="wbAddManual" type="button"><i class="bi bi-plus-lg"></i> 手动添加</button>' +
        '<button class="adm-btn sm ghost" id="wbCheckinAll" type="button"><i class="bi bi-check2-all"></i> 全部签到</button>' +
        '<button class="adm-btn sm ghost" id="wbRefreshAll" type="button"><i class="bi bi-arrow-repeat"></i> 刷新余额</button>' +
        '</div>') + '<div class="wb-accounts">';
    if (!accounts.length) {
        h += '<div class="wb-accounts-empty"><i class="bi bi-person-plus"></i> ' +
            '还没有账号，点「扫码添加」登录第一个 WorkBuddy 账号。</div>';
    }
    accounts.forEach(function (a) {
        var active = a.uid === cur;
        var initial = (a.display_name || '?').slice(0, 1).toUpperCase();
        h += '<div class="wb-account' + (active ? ' active' : '') + '" data-wbuid="' + wbEsc(a.uid) + '">' +
            '<div class="wb-account-top">' +
            '<span class="wb-account-avatar">' + wbEsc(initial) + '</span>' +
            '<div class="wb-account-id"><b>' + wbEsc(a.display_name) + '</b>' +
            '<span class="adm-hint" title="' + wbEsc(a.uid) + '">UID ' +
            wbEsc(a.uid.slice(0, 8)) + '…</span></div>' +
            (a.is_default ? '<span class="wb-account-badge">默认</span>' : '') +
            (active ? '<span class="wb-account-badge current">当前</span>' : '') +
            '</div>' +
            '<div class="wb-account-meta">' +
            '<span class="wb-account-balance"><i class="bi bi-coin"></i> ' +
            (a.last_balance === null || a.last_balance === undefined ? '—' : wbFmtNum(a.last_balance)) +
            '<em>积分</em></span>' +
            '<span class="wb-account-tags">' +
            '<i class="bi bi-globe2"></i> ' + (a.realm === 'global' ? '国际版' : '国内版') +
            '<span class="dot">·</span>' +
            '<i class="bi ' + (a.login_method === 'oauth' ? 'bi-qr-code' : 'bi-key') + '"></i> ' +
            (a.login_method === 'oauth' ? '扫码登录' : (a.source === 'file' ? '本机文件' : '手动')) +
            '</span></div>' +
            '<div class="wb-account-exp' + (a.expires_soon ? ' warn' : '') + '">' +
            wbEsc(a.expires_text ? '登录态至 ' + a.expires_text
                : (a.token_set ? '凭据已配置' : '未配置凭据')) + '</div>' +
            '<div class="wb-account-acts">' +
            '<button class="adm-btn sm ghost" data-wbact="use"' + (active ? ' disabled' : '') + '>切换</button>' +
            '<button class="adm-btn sm ghost" data-wbact="refresh" title="重新获取 OAuth 登录态">刷新凭据</button>' +
            '<button class="adm-btn sm ghost" data-wbact="default"' +
            (a.is_default ? ' disabled' : '') + '>设为默认</button>' +
            '<button class="adm-btn sm danger" data-wbact="del">移除</button>' +
            '</div></div>';
    });
    h += '</div></div>';
    return h;
}

/* ---------------- 总积分统计（跨账号） ---------------- */
function wbTotalStats(s) {
    s = s || {};
    var near = s.nearest_expiry;
    var h = '<div class="adm-section">' + ADM.sectionHead('bi-pie-chart', '总积分统计',
        '<span class="adm-hint">全部 ' + wbFmtNum(s.account_count || 0) + ' 个账号 · ' +
        (s.updated_at ? '快照更新于 ' + wbEsc(ADM.dt(s.updated_at)) : '尚未刷新积分构成') +
        '</span>') + '<div class="adm-stat-grid wb-total-stats">';
    h += ADM.stat('bi-coin', '总可用积分', wbFmtNum(s.total_balance),
        '逐包剩余合计 · ' + wbFmtNum(s.package_count || 0) + ' 个积分包');
    h += ADM.stat('bi-people', '账号总数', wbFmtNum(s.account_count || 0),
        '已在本机保存的 WorkBuddy 账号');
    h += ADM.stat('bi-alarm', '7 天内到期', wbFmtNum(s.expiring_7d || 0),
        '临近作废，建议优先消耗');
    h += ADM.stat('bi-hourglass-split', '30 天内到期', wbFmtNum(s.expiring_30d || 0),
        '含 7 天内临期积分');
    h += '</div>';
    if (near) {
        h += '<div class="wb-nearest"><i class="bi bi-exclamation-circle"></i>' +
            '<span>最近到期：<b>' + wbEsc(near.display_name) + '</b> 的「' +
            wbEsc(near.name) + '」 <b>' + wbFmtNum(near.remain) + '</b> 积分将于 ' +
            wbEsc(near.end_text) + ' 失效</span>' +
            '<span class="wb-nearest-days">' + wbEsc(wbLeftText(near)) + '</span></div>';
    }
    return h + '</div>';
}

/* ---------------- 账号积分构成 ---------------- */
function wbPackageTable(packs) {
    packs = packs || [];
    if (!packs.length) return '<div class="wb-empty">该账号暂无分包明细（企业额度或使用汇总接口）</div>';
    var h = '<table class="wb-pack-table"><thead><tr>' +
        '<th>积分包</th><th>剩余 / 面额</th><th>已用</th><th>失效时间</th><th>倒计时</th>' +
        '</tr></thead><tbody>';
    packs.forEach(function (p) {
        var tone = p.days_left === null ? 'mute' : (p.days_left <= 7 ? 'danger'
            : (p.days_left <= 30 ? 'warn' : 'mute'));
        /* 剩余为 0 的包不再显示倒计时，直接标「已用完」 */
        var badge = Number(p.remain) > 0
            ? (p.end_at ? wbLeftText(p) : '—')
            : '已用完';
        if (badge === '已用完') tone = 'mute';
        h += '<tr>' +
            '<td><i class="wb-exp-dot" style="background:' + wbEsc(p.color) + '"></i>' +
            wbEsc(p.name) + '</td>' +
            '<td><b>' + wbFmtNum(p.remain) + '</b> / ' + wbFmtNum(p.size) + '</td>' +
            '<td>' + wbFmtNum(p.used) + '</td>' +
            '<td>' + wbEsc(p.end_text || '无到期时间') + '</td>' +
            '<td><span class="wb-exp-badge ' + tone + '">' + wbEsc(badge) +
            '</span></td></tr>';
    });
    return h + '</tbody></table>';
}

function wbComposition(s) {
    var rows = (s && s.by_account) || [];
    var h = '<div class="adm-section">' + ADM.sectionHead('bi-bar-chart', '账号积分构成',
        '<span class="adm-hint">堆叠条按积分包着色 · 点「明细」看逐包面额与有效期</span>') +
        '<div class="wb-comp-list">';
    if (!rows.length) h += '<div class="wb-empty">暂无账号，先在上方账号管理里添加一个。</div>';
    rows.forEach(function (a) {
        var seg = '', legend = '';
        (a.by_source || []).forEach(function (src) {
            var w = a.balance > 0 ? (src.remain / a.balance) * 100 : 0;
            if (w <= 0) return;
            seg += '<span class="wb-comp-seg" style="width:' + w.toFixed(2) +
                '%;background:' + wbEsc(src.color) + '" title="' + wbEsc(src.name) +
                '：' + wbFmtNum(src.remain) + ' 积分"></span>';
            legend += '<span><i style="background:' + wbEsc(src.color) + '"></i>' +
                wbEsc(src.name) + ' ' + wbFmtNum(src.remain) + '</span>';
        });
        if (!seg && a.no_detail && a.balance > 0) {
            // 尚未拉取分包明细：用灰条示意余额快照，引导点「刷新构成」
            seg += '<span class="wb-comp-seg" style="width:100%;background:rgba(90,102,131,.45)"></span>';
            legend += '<span><i style="background:rgba(90,102,131,.45)"></i>余额快照（暂无分包明细） ' +
                wbFmtNum(a.balance) + '</span>';
        }
        h += '<div class="wb-comp-row">' +
            '<div class="wb-comp-head">' +
            '<div class="wb-comp-name"><i class="bi bi-person-circle"></i> ' +
            wbEsc(a.display_name) +
            (a.is_default ? '<span class="wb-account-badge">默认</span>' : '') + '</div>' +
            '<div class="wb-comp-num"><b>' + wbFmtNum(a.balance) + '</b> 积分' +
            '<span class="adm-hint"> / 面额 ' + wbFmtNum(a.size) + ' · 已用 ' +
            wbFmtNum(a.used) + ' · ' + a.package_count + ' 包</span></div>' +
            '<button class="adm-btn sm ghost" data-wbcomp-toggle="' + wbEsc(a.uid) +
            '" type="button">明细</button></div>' +
            '<div class="wb-comp-bar">' + seg + '</div>' +
            '<div class="wb-comp-legend">' + legend + '</div>' +
            '<div class="wb-comp-detail" data-wbcomp-detail="' + wbEsc(a.uid) +
            '" hidden>' + wbPackageTable(a.packages) + '</div>' +
            '</div>';
    });
    return h + '</div></div>';
}

/* ---------------- 最近过期积分 ---------------- */
function wbExpiry(s) {
    var buckets = (s && s.expiry_buckets) || [];
    var recent = (s && s.recent_expiry) || [];
    var max = 1;
    buckets.forEach(function (b) { max = Math.max(max, b.remain); });
    var h = '<div class="adm-section">' + ADM.sectionHead('bi-calendar2-week', '最近过期积分',
        '<button class="adm-btn sm ghost" id="wbRefreshCredits" type="button">' +
        '<i class="bi bi-arrow-repeat"></i> 刷新构成</button>') + '<div class="adm-card">';
    if (!buckets.length) {
        h += '<div class="wb-empty">暂无到期积分包。点「刷新构成」从官方接口拉取逐包明细。</div>';
    } else {
        h += '<div class="wb-exp-chart">';
        buckets.forEach(function (b) {
            var pct = Math.max(6, (b.remain / max) * 100);
            h += '<div class="wb-exp-col" title="' + wbEsc(b.date) + '：' +
                wbFmtNum(b.remain) + ' 积分到期">' +
                '<span class="wb-exp-val">' + wbFmtNum(b.remain) + '</span>' +
                '<div class="wb-exp-bar' + (b.days_left <= 7 ? ' danger' : '') +
                '" style="height:' + pct.toFixed(1) + '%"></div>' +
                '<span class="wb-exp-date">' + wbEsc(b.date.slice(5)) + '</span></div>';
        });
        h += '</div>';
    }
    if (recent.length) {
        h += '<div class="wb-exp-list">';
        recent.forEach(function (r) {
            var tone = r.days_left <= 7 ? 'danger' : (r.days_left <= 30 ? 'warn' : 'mute');
            h += '<div class="wb-exp-item">' +
                '<i class="wb-exp-dot" style="background:' + wbEsc(r.color) + '"></i>' +
                '<span class="wb-exp-who">' + wbEsc(r.display_name) + '</span>' +
                '<span class="wb-exp-name">' + wbEsc(r.name) + '</span>' +
                '<b>' + wbFmtNum(r.remain) + ' 积分</b>' +
                '<span class="adm-hint">' + wbEsc(r.end_text) + '</span>' +
                '<span class="wb-exp-badge ' + tone + '">' + wbEsc(wbLeftText(r)) + '</span>' +
                '</div>';
        });
        h += '</div>';
    }
    return h + '</div></div>';
}

/* 按「账号 × 最近 14 天」生成签到矩阵：每个账号一行，格子显示当天签到结果与积分 */
function wbCalendar(today, recent, accounts, currentUid) {
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
        days.push({ day: wbDayStr(dt), label: (dt.getMonth() + 1) + '/' + dt.getDate(),
            w: week[dt.getDay()] });
    }
    var todayStr = wbDayStr(base);

    // 已保存账号优先；历史里出现过但已移除的账号也补一行，避免记录凭空消失
    var lines = (accounts || []).map(function (a) {
        return { uid: a.uid, name: a.display_name || a.uid.slice(0, 8),
            realm: a.realm || 'cn', current: a.uid === currentUid, removed: false };
    });
    var known = {};
    lines.forEach(function (l) { known[l.uid] = 1; });
    (recent || []).forEach(function (r) {
        var u = r.uid || '';
        if (u && !known[u]) {
            known[u] = 1;
            lines.push({ uid: u, name: u.slice(0, 8) + '…', realm: '',
                current: false, removed: true });
        }
    });
    if (!lines.length) {
        lines.push({ uid: '', name: '暂无账号', realm: '', current: false, removed: true });
    }

    var h = '<div class="wb-cal-scroll"><div class="wb-cal-matrix">';
    h += '<div class="wb-cal-row head"><div class="wb-cal-account head">' +
        '<span>账号 / 日期</span><span class="adm-hint">最近 14 天</span></div>';
    days.forEach(function (d) {
        h += '<div class="wb-cal-date' + (d.day === todayStr ? ' today' : '') + '">' +
            '<b>' + wbEsc(d.label) + '</b><span>周' + d.w + '</span></div>';
    });
    h += '</div>';

    lines.forEach(function (l) {
        var cnt = 0, sum = 0;
        var cells = days.map(function (d) {
            var r = map[l.uid + '|' + d.day];
            var cls = 'wb-cal-cell', icon = 'bi-dash', small = '', tip = d.day + '：无记录';
            if (r) {
                var ok = r.status === 'success', done = r.status === 'already';
                cls += ok ? ' ok' : (done ? ' done' : ' bad');
                icon = (ok || done) ? 'bi-check2' : 'bi-exclamation-triangle';
                small = r.credit ? ('+' + wbFmtNum(r.credit)) : '';
                if (ok || done) { cnt++; sum += Number(r.credit) || 0; }
                tip = d.day + ' · ' + (r.status_text || r.status) +
                    (r.credit ? ' +' + wbFmtNum(r.credit) + ' 积分' : '') +
                    (r.streak_days ? ' · 连签 ' + r.streak_days + ' 天' : '') +
                    (r.at_text ? ' · ' + r.at_text : '') +
                    (r.message ? ' · ' + r.message : '');
            }
            if (d.day === todayStr) cls += ' today';
            return '<button type="button" class="' + cls + '" data-wbcaluid="' +
                wbEsc(l.uid) + '" title="' + wbEsc(tip) + '">' +
                '<i class="bi ' + icon + '"></i>' +
                (small ? '<small>' + wbEsc(small) + '</small>' : '') + '</button>';
        }).join('');
        var t = map[l.uid + '|' + todayStr];
        var todayTag = (t && (t.status === 'success' || t.status === 'already'))
            ? '<span class="wb-cal-today ok">今日已签</span>'
            : '<span class="wb-cal-today warn">今日未签</span>';
        h += '<div class="wb-cal-row"><div class="wb-cal-account">' +
            '<div class="wb-cal-account-name"><b>' + wbEsc(l.name) + '</b>' +
            (l.realm === 'global' ? '<span class="wb-account-badge global">国际版</span>' : '') +
            (l.current ? '<span class="wb-account-badge current">当前</span>' : '') +
            (l.removed ? '<span class="wb-account-badge">已移除</span>' : '') + '</div>' +
            '<div class="wb-cal-account-meta">' + todayTag +
            '<span>14 天 ' + cnt + ' 次 · +' + wbFmtNum(sum) + ' 积分</span></div>' +
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

/* 签到记录表工具栏：注入「按账号筛选」下拉（分页重绘时不重复添加） */
function wbHistoryToolbar(host, accounts) {
    var bar = host.querySelector('.adm-table-toolbar');
    if (!bar || bar.querySelector('#wbHistoryAccount')) return;
    var sel = document.createElement('select');
    sel.className = 'adm-select wb-history-account';
    sel.id = 'wbHistoryAccount';
    sel.title = '按账号筛选签到记录';
    sel.innerHTML = '<option value="">全部账号</option>' + (accounts || []).map(function (a) {
        return '<option value="' + wbEsc(a.uid) + '">' +
            wbEsc((a.display_name || a.uid.slice(0, 8)) +
                (a.realm === 'global' ? '（国际版）' : '')) + '</option>';
    }).join('');
    sel.value = wbHistoryUid;
    sel.addEventListener('change', function () {
        wbHistoryUid = sel.value;
        var st = ADM._servTables['wb-history'];
        if (st) st.page = 1;
        ADM.loadServ(host, 'wb-history');
    });
    bar.insertBefore(sel, bar.firstChild);
}

/* ---------------- 就地悬浮二次确认 ---------------- */
var wbPop = null;

function wbClosePop() {
    if (!wbPop) return;
    var p = wbPop;
    wbPop = null;
    document.removeEventListener('click', p.onDoc, true);
    document.removeEventListener('keydown', p.onKey, true);
    window.removeEventListener('resize', p.onLayout);
    window.removeEventListener('scroll', p.onLayout, true);
    if (p.el && p.el.parentNode) p.el.parentNode.removeChild(p.el);
}

function wbConfirmPop(anchor, opts) {
    opts = opts || {};
    wbClosePop();
    var box = document.createElement('div');
    box.className = 'wb-popconfirm';
    box.innerHTML = '<div class="wb-popconfirm-title">' +
        '<i class="bi bi-exclamation-triangle"></i> ' + wbEsc(opts.title || '确认操作') + '</div>' +
        '<div class="wb-popconfirm-text">' + wbEsc(opts.text || '') + '</div>' +
        '<div class="wb-popconfirm-acts">' +
        '<button class="adm-btn sm ghost" type="button" data-wbpop="cancel">取消</button>' +
        '<button class="adm-btn sm danger" type="button" data-wbpop="ok">' +
        wbEsc(opts.okText || '确认') + '</button></div>';
    document.body.appendChild(box);

    function place() {
        var r = anchor.getBoundingClientRect();
        var w = box.offsetWidth || 272, h = box.offsetHeight || 140;
        var left = Math.min(Math.max(8, r.right - w),
            Math.max(8, window.innerWidth - w - 8));
        var top = r.bottom + 8, flip = false;
        if (top + h > window.innerHeight - 8) {
            top = Math.max(8, r.top - h - 8);
            flip = true;
        }
        box.style.left = left + 'px';
        box.style.top = top + 'px';
        box.classList.toggle('flip', flip);
    }
    place();

    var p = { el: box, onDoc: null, onKey: null, onLayout: null };
    function dismiss() {
        wbClosePop();
        if (opts.onCancel) opts.onCancel();
    }
    p.onDoc = function (ev) {
        if (box.contains(ev.target) || anchor.contains(ev.target)) return;
        dismiss();
    };
    p.onKey = function (ev) {
        if (ev.key === 'Escape') dismiss();
    };
    p.onLayout = function () { dismiss(); };
    wbPop = p;
    // 延后一帧注册，避免本次点击立刻把刚创建的浮层关掉
    setTimeout(function () {
        document.addEventListener('click', p.onDoc, true);
        document.addEventListener('keydown', p.onKey, true);
    }, 0);
    window.addEventListener('resize', p.onLayout);
    window.addEventListener('scroll', p.onLayout, true);

    box.addEventListener('click', function (ev) {
        var b = ev.target.closest ? ev.target.closest('[data-wbpop]') : null;
        if (!b) return;
        wbClosePop();
        if (b.dataset.wbpop === 'ok') {
            if (opts.onOk) opts.onOk();
        } else if (opts.onCancel) {
            opts.onCancel();
        }
    });
}

/* ---------------- 事件 ---------------- */
function wbBind(el, d) {
    var reload = el.querySelector('#wbReload');
    if (reload) reload.addEventListener('click', function () {
        wbRefresh(el, undefined, true);   // 手动「刷新」才拉取官方最新数据
    });

    var checkin = el.querySelector('#wbCheckin');
    if (checkin) checkin.addEventListener('click', async function () {
        checkin.disabled = true;
        try {
            var r = await ADM.api('/api/workbuddy/checkin', {
                method: 'POST', body: { source: 'manual', uid: wbCurrentUid }
            });
            ADM.toast(r.global ? (r.message || '国际版账号状态已确认')
                : (r.status === 'success'
                    ? ('签到成功，+' + wbFmtNum(r.credit) + ' 积分')
                    : (r.message || '今天已签到')),
                r.status === 'success' ? 'ok' : 'warn');
            await wbRefresh(el, undefined, true);   // 签到后余额 / 状态已变化
        } catch (e) {
            ADM.toast((e && e.message) || String(e), 'err');
            checkin.disabled = false;
        }
    });

    var test = el.querySelector('#wbTest');
    if (test) test.addEventListener('click', async function () {
        test.disabled = true;
        try {
            var r = await ADM.api('/api/workbuddy/test', {
                method: 'POST', body: { uid: wbCurrentUid }
            });
            ADM.toast('连接正常：' + (r.credential && r.credential.domain) +
                (r.status && r.status.global
                    ? (' · ' + (r.status.activated ? '国际版已激活'
                        : (r.status.message || '国际版注册状态')))
                    : (r.status && r.status.today_checked_in ? ' · 今日已签到' : ' · 今日待签到')), 'ok');
        } catch (e) {
            ADM.toast((e && e.message) || String(e), 'err');
        }
        test.disabled = false;
    });

    [el.querySelector('#wbConfig'), el.querySelector('#wbConfig2')].forEach(function (btn) {
        if (btn) btn.addEventListener('click', function () { wbOpenConfig(el); });
    });
    [el.querySelector('#wbQrLogin'), el.querySelector('#wbQrLogin2'),
        el.querySelector('#wbAddQr')].forEach(function (btn) {
        if (btn) btn.addEventListener('click', function () { wbOpenLogin(el, 'cn'); });
    });
    [el.querySelector('#wbAddGlobal'), el.querySelector('#wbAddGlobal2')].forEach(
        function (btn) {
            if (btn) btn.addEventListener('click', function () {
                wbOpenLogin(el, 'global');
            });
        });
    var addManual = el.querySelector('#wbAddManual');
    if (addManual) addManual.addEventListener('click', function () { wbOpenAddAccount(el); });

    var all = el.querySelector('#wbCheckinAll');
    if (all) all.addEventListener('click', async function () {
        all.disabled = true;
        try {
            var r = await ADM.api('/api/workbuddy/checkin/all', { method: 'POST', body: {} });
            var s = r.summary || {};
            ADM.toast('批量签到：成功 ' + (s.success || 0) + ' · 已签 ' + (s.already || 0) +
                ' · 失败 ' + (s.failed || 0), s.failed ? 'warn' : 'ok');
            await wbRefresh(el, undefined, true);
        } catch (e) {
            ADM.toast((e && e.message) || String(e), 'err');
            all.disabled = false;
        }
    });
    var refreshAll = el.querySelector('#wbRefreshAll');
    if (refreshAll) refreshAll.addEventListener('click', async function () {
        refreshAll.disabled = true;
        try {
            var r = await ADM.api('/api/workbuddy/accounts/refresh_all', { method: 'POST', body: {} });
            var s = r.summary || {};
            ADM.toast('余额刷新：成功 ' + (s.success || 0) + ' · 失败 ' + (s.failed || 0),
                s.failed ? 'warn' : 'ok');
            await wbRefresh(el, undefined, true);
        } catch (e) {
            ADM.toast((e && e.message) || String(e), 'err');
            refreshAll.disabled = false;
        }
    });

    el.querySelectorAll('[data-wbact]').forEach(function (btn) {
        btn.addEventListener('click', async function () {
            var host = btn.closest('.wb-account');
            var uid = host ? host.dataset.wbuid : '';
            var act = btn.dataset.wbact;
            if (!uid) return;
            btn.disabled = true;
            try {
                if (act === 'use') {
                    await ADM.api('/api/workbuddy/accounts/current',
                        { method: 'POST', body: { uid: uid } });
                    ADM.toast('已切换账号', 'ok');
                    await wbRefresh(el, uid);
                } else if (act === 'default') {
                    await ADM.api('/api/workbuddy/accounts/save',
                        { method: 'POST', body: { uid: uid, is_default: true } });
                    ADM.toast('已设为默认账号', 'ok');
                    await wbRefresh(el);
                } else if (act === 'refresh') {
                    await ADM.api('/api/workbuddy/accounts/refresh',
                        { method: 'POST', body: { uid: uid } });
                    ADM.toast('登录态已刷新', 'ok');
                    await wbRefresh(el);
                } else if (act === 'del') {
                    var nameEl = host.querySelector('.wb-account-id b');
                    var accName = nameEl ? nameEl.textContent : uid;
                    btn.disabled = false;   // 悬浮确认期间保持按钮可用，取消后不残留禁用态
                    wbConfirmPop(btn, {
                        title: '移除该账号？',
                        text: '将删除「' + accName + '」在本机保存的凭据（不影响官方账号本身），下次使用需重新登录。',
                        okText: '确认移除',
                        onCancel: function () { btn.disabled = false; },
                        onOk: async function () {
                            btn.disabled = true;
                            try {
                                await ADM.api('/api/workbuddy/accounts/delete',
                                    { method: 'POST', body: { uid: uid } });
                                ADM.toast('账号已移除', 'ok');
                                await wbRefresh(el, '');
                            } catch (err) {
                                ADM.toast((err && err.message) || String(err), 'err');
                                btn.disabled = false;
                            }
                        }
                    });
                    return;
                }
            } catch (e) {
                ADM.toast((e && e.message) || String(e), 'err');
                btn.disabled = false;
            }
        });
    });

    /* 点日历格子 → 按账号筛选下方签到记录表 */
    el.querySelectorAll('[data-wbcaluid]').forEach(function (cell) {
        cell.addEventListener('click', function () {
            wbHistoryUid = cell.dataset.wbcaluid || '';
            var sel = el.querySelector('#wbHistoryAccount');
            if (sel) sel.value = wbHistoryUid;
            var host = el.querySelector('[data-adm-serv="wb-history"]');
            if (!host) return;
            var st = ADM._servTables['wb-history'];
            if (st) st.page = 1;
            ADM.loadServ(host, 'wb-history');
            if (host.scrollIntoView) {
                host.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
        });
    });

    el.querySelectorAll('[data-wbcomp-toggle]').forEach(function (btn) {
        btn.addEventListener('click', function () {
            var box = el.querySelector('[data-wbcomp-detail="' + btn.dataset.wbcompToggle + '"]');
            if (!box) return;
            var open = box.hidden;
            box.hidden = !open;
            btn.textContent = open ? '收起' : '明细';
        });
    });
    var rc = el.querySelector('#wbRefreshCredits');
    if (rc) rc.addEventListener('click', async function () {
        rc.disabled = true;
        try {
            var r = await ADM.api('/api/workbuddy/credits/refresh',
                { method: 'POST', body: { all: true } });
            var sum = r.summary || {};
            ADM.toast('积分构成已刷新：成功 ' + (sum.success || 0) +
                ' · 失败 ' + (sum.failed || 0), sum.failed ? 'warn' : 'ok');
            await wbRefresh(el, undefined, true);
        } catch (e) {
            ADM.toast((e && e.message) || String(e), 'err');
            rc.disabled = false;
        }
    });
}

/* ---------------- OAuth 设备授权登录（国内版 / 国际版） ----------------
 * 参考 workbuddy2api-panel 的 login/start + login/poll：
 * 服务端按 realm 签发 state 与授权 URL → 用户在浏览器完成授权 →
 * 前端每 3 秒轮询，服务端拿到 token/uid 后加密落库。
 * 国际版登录后额外完成注册激活 + 一次性 trial 加油包（无每日签到体系）。 */
async function wbOpenLogin(el, realm) {
    realm = realm === 'global' ? 'global' : 'cn';
    var isGlobal = realm === 'global';
    var sess;
    try {
        sess = await ADM.api('/api/workbuddy/login/start',
            { method: 'POST', body: { realm: realm } });
    } catch (e) {
        ADM.toast((e && e.message) || String(e), 'err');
        return;
    }
    var html = '<div class="wb-login">' +
        '<div class="wb-login-qr">' +
        '<div class="wb-login-qr-box"><img src="' + wbEsc(sess.qr) + '" alt="WorkBuddy 登录二维码"></div>' +
        '<div class="wb-login-qr-cap"><i class="bi bi-qr-code"></i> ' +
        (isGlobal ? '扫码打开国际版登录页' : '微信「扫一扫」') + '</div>' +
        '<div class="wb-login-qr-tip"><i class="bi bi-clock"></i> 二维码 10 分钟内有效</div>' +
        '</div>' +
        '<div class="wb-login-info">' +
        '<span class="wb-login-badge"><i class="bi bi-shield-check"></i> ' +
        (isGlobal ? '国际版 OAuth 授权（workbuddy.ai）' : '官方 OAuth 授权') + '</span>' +
        '<h3>' + (isGlobal ? '国际版登录后自动激活' : '扫码后自动同步账号') + '</h3>' +
        (isGlobal
            ? '<p>国际版通常不用微信扫码，请点下方按钮在浏览器里完成官方登录。' +
              '授权成功后本窗口会自动保存凭据，并补全注册地区、激活账号、领取一次性 trial 加油包。</p>'
            : '<p>无需手动复制 Token：你在微信里确认授权后，本窗口会自动检测登录结果，' +
              '把凭据加密保存到本机并刷新积分面板。</p>') +
        '<ol class="wb-login-steps">' +
        '<li><span>1</span>' + (isGlobal ? '打开官方登录页（或扫码在手机浏览器打开）' : '扫描左侧二维码，或打开官方登录页') + '</li>' +
        '<li><span>2</span>' + (isGlobal ? '在浏览器里完成国际版账号登录' : '在手机微信里点「确认登录」') + '</li>' +
        '<li><span>3</span>' + (isGlobal ? '自动注册激活并领取试用加油包' : '自动完成，回到积分面板') + '</li>' +
        '</ol>' +
        '<a class="adm-btn primary wb-login-open" target="_blank" rel="noopener noreferrer" href="' + wbEsc(sess.url) + '">' +
        '<i class="bi bi-box-arrow-up-right"></i> 打开官方登录页</a>' +
        '<div class="wb-login-state" id="wbLoginState">' +
        '<span class="wb-login-dot"></span><i class="bi bi-hourglass"></i>' +
        '<span id="wbLoginMsg">' + (isGlobal ? '等待登录授权…' : '等待扫码…') + '</span></div>' +
        '<div class="wb-login-note"><i class="bi bi-lock"></i> accessToken / refreshToken ' +
        '仅加密保存在本机 store.db，页面与日志均不回显。' +
        (isGlobal ? '国际版无每日签到，积分动作为注册激活 + 一次性 trial 加油包。' : '') +
        '</div>' +
        '</div></div>';

    var stopped = false, timer = null;
    var ok = await ADM.modal({
        title: isGlobal ? '添加国际版账号 · OAuth 登录' : '添加账号 · 微信扫码登录',
        icon: isGlobal ? 'bi-globe2' : 'bi-qr-code',
        size: 'wide',
        html: html,
        noOk: true,
        cancelText: '取消',
        onOpen: function (box, done) {
            var stateEl = box.querySelector('#wbLoginState');
            var msgEl = box.querySelector('#wbLoginMsg');
            var iconEl = stateEl.querySelector('i');
            var tick = async function () {
                if (stopped || !document.body.contains(box)) {
                    stopped = true;
                    if (timer) clearTimeout(timer);
                    return;
                }
                try {
                    var r = await ADM.api('/api/workbuddy/login/poll?state=' + encodeURIComponent(sess.state));
                    if (r.done) {
                        stopped = true;
                        if (timer) clearTimeout(timer);
                        stateEl.classList.add('ok');
                        iconEl.className = 'bi bi-check2-circle';
                        msgEl.textContent = '登录成功，正在加载积分…';
                        ADM.toast('WorkBuddy 登录成功' + (r.nickname ? '：' + r.nickname : '') +
                            (r.checkin_message ? ' · ' + r.checkin_message : ''), 'ok');
                        done(true);
                        await wbRefresh(el, '', true);   // 新账号需拉取余额 / 激活结果
                        return;
                    }
                    msgEl.textContent = r.message ||
                        (isGlobal ? '等待登录授权…' : '等待扫码…');
                } catch (e) {
                    stopped = true;                 // 会话过期 / 网络异常：停止轮询并就地提示
                    if (timer) clearTimeout(timer);
                    stateEl.classList.add('err');
                    iconEl.className = 'bi bi-exclamation-triangle';
                    msgEl.textContent = (e && e.message) || String(e);
                    return;
                }
                if (!stopped) timer = setTimeout(tick, 3000);
            };
            timer = setTimeout(tick, 1500);
        }
    });
    stopped = true;
    if (timer) clearTimeout(timer);
    if (!ok) {
        try {
            await ADM.api('/api/workbuddy/login/cancel', {
                method: 'POST', body: { state: sess.state }
            });
        } catch (e) { }
    }
}

/* ---------------- 全局设置 / 当前账号 ---------------- */
async function wbOpenConfig(el) {
    var cfg;
    try {
        cfg = await ADM.api('/api/workbuddy/config');
    } catch (e) {
        ADM.toast((e && e.message) || String(e), 'err');
        return;
    }
    var acct = cfg.account || {};
    var det = cfg.detected || {};
    var fields = [
        ADM.fieldHtml({ name: 'proxy', label: '出站代理（全局，可选）', value: cfg.proxy || '',
            placeholder: '如 http://127.0.0.1:7890；留空走系统默认' }),
        ADM.fieldHtml({ name: 'timeout', label: '请求超时（秒，全局）', type: 'number',
            value: cfg.timeout || 15 })
    ].join('');

    var card = '<div class="wb-login-card"><div class="wb-login-card-main">' +
        '<b><i class="bi bi-person-circle"></i> 当前账号：' +
        wbEsc(acct.display_name || '尚未添加账号') + '</b>' +
        '<div class="adm-hint">' +
        (acct.uid ? ((acct.realm === 'global' ? '国际版' : '国内版') + ' · UID ' +
            wbEsc(acct.uid.slice(0, 12)) + '… · ' +
            (acct.login_method === 'oauth' ? 'OAuth 登录' : '手动凭据') +
            (acct.expires_text ? ' · 登录态至 ' + wbEsc(acct.expires_text) : ''))
            : '账号凭据在「账号管理」里逐个保存，这里只放全局设置。') +
        '</div></div>' +
        (acct.uid ? '<div class="adm-btn-row">' +
            '<button class="adm-btn sm ghost" id="wbCfgRefresh" type="button"><i class="bi bi-arrow-repeat"></i> 刷新登录态</button>' +
            '<button class="adm-btn sm danger" id="wbCfgRemove" type="button"><i class="bi bi-trash"></i> 移除账号</button>' +
            '</div>' : '') + '</div>';

    var html = card + '<div class="adm-fields">' + fields + '</div>' +
        '<div class="adm-hint" style="display:block;margin-top:10px;line-height:1.8">' +
        'accessToken / refreshToken 按账号加密保存在本机 store.db，接口与日志均不回显明文。<br>' +
        '仅允许向官方域名（' + wbEsc((cfg.allowed_domains || []).join(' / ')) + '）发送凭据。' +
        (det.path ? '<br>已探测到本机登录态：<code>' + wbEsc(det.path) + '</code>' : '') +
        '</div>';

    var ok = await ADM.modal({
        title: 'WorkBuddy 全局设置',
        icon: 'bi-sliders',
        html: html,
        okText: '保存设置',
        onOpen: function (box, close) {
            var rf = box.querySelector('#wbCfgRefresh');
            if (rf) rf.addEventListener('click', async function () {
                rf.disabled = true;
                try {
                    await ADM.api('/api/workbuddy/accounts/refresh',
                        { method: 'POST', body: { uid: acct.uid } });
                    ADM.toast('登录态已刷新', 'ok');
                    close(true);
                } catch (e) {
                    ADM.toast((e && e.message) || String(e), 'err');
                    rf.disabled = false;
                }
            });
            var rm = box.querySelector('#wbCfgRemove');
            if (rm) rm.addEventListener('click', function () {
                wbConfirmPop(rm, {
                    title: '移除该账号？',
                    text: '将删除「' + (acct.display_name || acct.uid || '当前账号') +
                        '」在本机保存的凭据，下次使用需重新登录。',
                    okText: '确认移除',
                    onOk: async function () {
                        try {
                            await ADM.api('/api/workbuddy/accounts/delete',
                                { method: 'POST', body: { uid: acct.uid } });
                            ADM.toast('账号已移除', 'ok');
                            close(true);
                        } catch (e) {
                            ADM.toast((e && e.message) || String(e), 'err');
                        }
                    }
                });
            });
        },
        onOk: async function (box) {
            var f = ADM.readForm(box);
            await ADM.api('/api/workbuddy/config', {
                method: 'POST',
                body: { proxy: f.proxy, timeout: parseInt(f.timeout, 10) || 15 }
            });
            return true;
        }
    });
    if (ok) {
        ADM.toast('设置已保存', 'ok');
        await wbRefresh(el, '');
    }
}

/* ---------------- 手动添加账号 ---------------- */
async function wbOpenAddAccount(el) {
    var cfg;
    try {
        cfg = await ADM.api('/api/workbuddy/config');
    } catch (e) {
        ADM.toast((e && e.message) || String(e), 'err');
        return;
    }
    var fields = [
        ADM.fieldHtml({ name: 'realm', label: '账号版本', type: 'select', value: 'cn',
            options: [{ value: 'cn', label: '国内版（codebuddy.cn）' },
                      { value: 'global', label: '国际版（workbuddy.ai）' }] }),
        ADM.fieldHtml({ name: 'uid', label: '账号 UID（必填）', value: '',
            placeholder: '账号唯一标识，也是请求头 X-User-Id' }),
        ADM.fieldHtml({ name: 'nickname', label: '显示名称', value: '',
            placeholder: '便于区分，如「工作号」' }),
        ADM.fieldHtml({ name: 'token', label: 'accessToken（必填）', type: 'password', value: '',
            placeholder: 'Bearer 令牌' }),
        ADM.fieldHtml({ name: 'refresh_token', label: 'refreshToken（可选）', type: 'password', value: '',
            placeholder: '用于自动刷新登录态，建议扫码登录自动获取' }),
        ADM.fieldHtml({ name: 'domain', label: '接口域名（可选）', value: '',
            placeholder: '留空默认 ' + cfg.default_domain }),
        ADM.fieldHtml({ name: 'remark', label: '备注', value: '', placeholder: '可选' })
    ].join('');
    var html = '<div class="adm-fields">' + fields + '</div>' +
        '<div class="adm-hint" style="display:block;line-height:1.8">' +
        '推荐用「扫码添加」或「国际版登录」自动获取凭据；手动填写时 UID 与 accessToken 必须对应。<br>' +
        '国际版账号会自动使用 workbuddy.ai 域名与注册激活 / 试用包动作（无每日签到）。<br>' +
        '凭据加密保存，本页不会回显；同 UID 再次添加会覆盖更新该账号。</div>';
    var ok = await ADM.modal({
        title: '手动添加 WorkBuddy 账号',
        icon: 'bi-person-plus',
        html: html,
        okText: '添加账号',
        onOk: async function (box) {
            var f = ADM.readForm(box);
            var r = await ADM.api('/api/workbuddy/accounts/save', {
                method: 'POST',
                body: {
                    uid: f.uid, nickname: f.nickname, token: f.token,
                    refresh_token: f.refresh_token, domain: f.domain,
                    remark: f.remark, realm: f.realm,
                    source: 'manual', login_method: 'manual'
                }
            });
            return (r.account && r.account.uid) || true;
        }
    });
    if (ok) {
        ADM.toast('账号已添加', 'ok');
        await wbRefresh(el, typeof ok === 'string' ? ok : '', true);
    }
}

/* 后台管理：CodeArts（华为云）积分 / 每日签到。
 * 数据来自 /api/codearts/*（服务端用加密保存的华为云 STS 临时凭据，经
 * SDK-HMAC-SHA256 签名调用 snap-access 官方接口；登录走华为云 OAuth
 * 浏览器授权链接，协议参考 dsh-get-it-for-free 渠道包）。
 * 凭据永远不会回显到页面。样式复用 07_WorkBuddy.css 的 wb- 类。 */
ADM.modules.push({
    id: 'codearts',
    name: 'CodeArts 积分',
    subtitle: '华为云积分 · 每日签到 · 链接登录',
    icon: 'bi-cloud-fill',
    async load(el) {
        el.innerHTML = ADM.loading('正在读取 CodeArts 积分…');
        await caRefresh(el);
    }
});

/* 当前账号：所有查询 / 签到都按它进行；空串 = 跟随服务端默认账号 */
var caCurrentUid = '';
var caHistoryUid = '';
var caLoginTimer = null;

/* ---------------- 小工具 ---------------- */
function caFmtNum(v) {
    if (v === null || v === undefined || v === '' || isNaN(Number(v))) return '—';
    return (Math.round(Number(v) * 100) / 100).toLocaleString('zh-CN');
}

function caEsc(s) { return ADM.esc(s === null || s === undefined ? '' : s); }

/* STS 有效期文本：临期 / 过期着色 */
function caExpiresText(acc) {
    if (!acc) return '';
    if (!acc.expires_at) return '未知';
    return acc.expires_text + (acc.expired ? '（已过期）' :
        (acc.expires_soon ? '（即将过期）' : ''));
}

/* ---------------- 首屏 ---------------- */
/* fresh=true 才请求华为云最新数据；默认只读本地库（切换账号 / 首屏即时返回） */
async function caRefresh(el, uid, fresh) {
    if (uid !== undefined) {
        caCurrentUid = uid || '';
        if (uid) caHistoryUid = '';
    }
    var url = '/api/codearts/overview' +
        (caCurrentUid ? '?uid=' + encodeURIComponent(caCurrentUid) : '');
    if (fresh) url += (url.indexOf('?') >= 0 ? '&' : '?') + 'fresh=1';
    var d;
    try {
        d = await ADM.api(url);
    } catch (e) {
        el.innerHTML = '<div class="adm-card"><div class="adm-hint">加载失败：' +
            caEsc((e && e.message) || e) + '</div></div>';
        return;
    }
    d = d || {};
    // 定时签到任务（复用内置定时任务）：找到就显示开关与下次运行时间
    try {
        var cr = await ADM.api('/api/cron/tasks');
        d.caCron = ((cr && cr.tasks) || []).find(function (t) {
            return t && t.kind === 'system' && t.content === 'codearts_checkin_all';
        }) || null;
    } catch (e) {
        d.caCron = null;
    }
    caCurrentUid = d.current_uid || '';
    caRender(el, d);
    caBind(el, d);
}

function caRender(el, d) {
    var st = d.status || {};
    var cr = d.credits || {};
    var errs = d.errors || {};
    var cached = !!d.cached;
    var acc = d.account || {};
    var checked = st.today_checked_in === true;
    var inactive = st.active === false;   // 非积分计费账户 / 无活动
    var unknown = !d.configured || st.today_checked_in === undefined;
    var stateHtml = checked
        ? '<span class="wb-state ok"><i class="bi bi-check2-circle"></i> 今日已签到</span>'
        : (inactive
            ? '<span class="wb-state"><i class="bi bi-info-circle"></i> 当前账户不在积分活动范围</span>'
            : (unknown
                ? '<span class="wb-state"><i class="bi bi-question-circle"></i> 签到状态未知</span>'
                : '<span class="wb-state warn"><i class="bi bi-alarm"></i> 今日待签到</span>'));

    /* ---- 账号管理 ---- */
    var html = caAccountBar(d);

    /* ---- 顶部指标 ---- */
    html += '<div class="adm-section">' + ADM.sectionHead('bi-graph-up', '积分总览',
        '<span class="adm-hint">' + (cached
            ? '本地缓存数据（签到状态按本机记录推断） · 点「刷新」拉取华为云最新'
            : '数据来源：华为云 CodeArts（snap-access 官方接口） · 更新于 ' + caEsc(ADM.dt(d.updated_at))) +
        '</span>') + '<div class="adm-stat-grid wb-stats">';
    html += ADM.stat('bi-calendar2-check', '今日签到',
        checked ? '<span class="wb-stat-ok">已签到</span>'
            : (unknown ? '未知' : (inactive ? '不适用'
                : '<span class="wb-stat-warn">待签到</span>')),
        d.today ? ('本地日期 ' + caEsc(d.today)) : '');
    html += ADM.stat('bi-coin', '今日签到积分',
        (checked && Number(st.today_credit) > 0) ? caFmtNum(st.today_credit) : '—',
        '签到领取到账后显示实际所得（benefitAmount）');
    html += ADM.stat('bi-gift', '累计签到积分', caFmtNum(st.total_credits || 0),
        '本机记录的签到到账累计');
    html += ADM.stat('bi-shield-lock', 'STS 凭据有效期', acc.expires_text ? '至 ' + caEsc(acc.expires_text) : '—',
        acc.refreshable ? '临期自动续期（约 2 小时一轮）' : '该凭据不支持自动续期，临期请重新链接登录');
    html += '</div></div>';

    /* ---- 主卡片：余额 + 分组操作 ---- */
    var canCheck = !!d.configured && !checked && !unknown;
    html += '<div class="adm-section"><div class="wb-hero">' +
        '<div class="wb-hero-main">' +
        '<div class="wb-hero-label"><i class="bi bi-stars"></i> ' +
        caEsc(acc.display_name || 'CodeArts（华为云）') + ' · 当前可用积分</div>' +
        '<div class="wb-balance">' + caFmtNum(cr.balance) + '<small>积分</small></div>' +
        '<div class="wb-hero-sub">' + stateHtml +
        (cached ? '<span class="wb-cache-tag"><i class="bi bi-database"></i> 缓存数据</span>' : '') +
        (st.package_name ? '<span class="wb-hero-expire"><i class="bi bi-box-seam"></i> ' +
            caEsc(st.package_name) + '</span>' : '') +
        '</div></div>' +
        '<div class="wb-hero-actions">' +
        '<div class="wb-hero-primary">' +
        '<button class="adm-btn primary wb-btn-main" id="caCheckin" type="button"' +
        (canCheck ? '' : ' disabled') + '><i class="bi bi-hand-thumbs-up"></i> ' +
        (checked ? '今日已签到' : '立即签到') + '</button></div>' +
        '<div class="wb-hero-tools">' +
        '<button class="adm-btn ghost" id="caReload" type="button"><i class="bi bi-arrow-clockwise"></i> 刷新</button>' +
        '<button class="adm-btn ghost" id="caTest" type="button"><i class="bi bi-plug"></i> 测试连接</button>' +
        '<button class="adm-btn ghost" id="caLogin" type="button"><i class="bi bi-link-45deg"></i> 链接登录</button>' +
        '</div></div></div>';

    /* ---- 错误提示 ---- */
    var problems = [];
    if (!d.configured && d.error) problems.push(d.error);
    if (errs.status) problems.push('签到状态：' + errs.status);
    if (errs.packages) problems.push('积分余额：' + errs.packages);
    if (acc.expired) problems.push('STS 临时凭据已过期，请点该账号「续期」或重新链接登录');
    if (problems.length) {
        html += '<div class="wb-errors">';
        problems.forEach(function (p) {
            html += '<div class="wb-error"><i class="bi bi-exclamation-triangle"></i><span>' +
                caEsc(p) + '</span></div>';
        });
        html += '</div>';
    }
    html += '</div>';

    /* ---- 未配置时的引导 ---- */
    if (!d.configured) {
        html += '<div class="adm-section"><div class="wb-guide"><i class="bi bi-info-circle"></i><div>' +
            '<h3>添加 CodeArts（华为云）账号</h3>' +
            '<p>本模块通过「链接登录」完成华为云授权：服务端在本机 127.0.0.1 起一个回调端口并生成授权链接，' +
            '你在浏览器里登录华为云后，页面会跳回本机回调并自动保存加密凭据（STS 临时 AK/SK + security_token，' +
            '约 2 小时一轮；带 refresh_token 的凭据会在临期前自动续期）。' +
            '凭据加密保存在本机 store.db，页面与日志均不回显。</p>' +
            '<div class="adm-btn-row">' +
            '<button class="adm-btn primary sm" id="caLogin2" type="button"><i class="bi bi-link-45deg"></i> 开始链接登录</button>' +
            '</div></div></div></div>';
    }

    /* ---- 账户信息 ---- */
    var cred = d.credential || {};
    var info = [
        ['bi-person-badge', '账号 UID', acc.uid || '-'],
        ['bi-person', '昵称', acc.nickname || '-'],
        ['bi-key', '访问密钥', cred.access_key_masked ? '已配置（' + cred.access_key_masked + '）' :
            (acc.credential_set ? '已配置 · ******' : '未配置')],
        ['bi-clock-history', 'STS 有效期', caExpiresText(acc) || '-'],
        ['bi-arrow-repeat', '自动续期', acc.refreshable ? '支持（临期前 30 分钟自动换新）' : '不支持（临期需重新链接登录）'],
        ['bi-box-seam', '套餐', st.package_name || '-'],
        ['bi-database', '余额快照', acc.last_balance === null || acc.last_balance === undefined
            ? '尚未刷新' : caFmtNum(acc.last_balance) + ' 积分'],
        ['bi-tag', '备注', acc.remark || '-']
    ];
    var infoHtml = '<div class="adm-section">' + ADM.sectionHead('bi-info-square', '账户信息') +
        '<div class="adm-card wb-info-card"><div class="wb-info-grid">';
    info.forEach(function (it) {
        var text = String(it[2] === null || it[2] === undefined ? '' : it[2]);
        infoHtml += '<div class="wb-info-item" title="' + caEsc(text) + '">' +
            '<span class="wb-info-k"><i class="bi ' + it[0] + '"></i>' + caEsc(it[1]) + '</span>' +
            '<span class="wb-info-v">' + caEsc(text) + '</span></div>';
    });
    infoHtml += '</div></div></div>';

    /* ---- 最近 14 天签到日历（Tab：签到记录），按账号逐行展示 ---- */
    var calHtml = '<div class="adm-section">' + ADM.sectionHead('bi-calendar3', '各账号签到情况 · 最近 14 天',
        '<span class="adm-hint">每个账号一行 · 点格子可在下方记录表筛选该账号</span>') +
        '<div class="adm-card">' + caCalendar(d.today, d.history_all || [],
            d.accounts || [], d.current_uid) + '</div></div>';

    /* ---- 签到记录表格 ---- */
    var nameMap = {};
    (d.accounts || []).forEach(function (a) {
        nameMap[a.uid] = a.display_name || a.uid.slice(0, 16);
    });
    var accountsNow = d.accounts || [];
    var cols = [
        {
            label: '账号', key: 'uid', render: function (r) {
                return '<span class="adm-cell-strong">' +
                    caEsc(nameMap[r.uid] || (r.uid ? r.uid.slice(0, 16) + '…' : '-')) + '</span>';
            }
        },
        { label: '日期', key: 'day', sortKey: 'day', render: function (r) { return '<span class="adm-cell-strong">' + caEsc(r.day) + '</span>'; } },
        { label: '时间', key: 'at_text', sortKey: 'at', render: function (r) { return caEsc(r.at_text); } },
        {
            label: '结果', key: 'status_text', sortKey: 'status', render: function (r) {
                return r.status === 'success' ? ADM.badge('签到成功', 'ok')
                    : (r.status === 'already' ? ADM.badge('今日已领', 'info')
                        : (r.status === 'inactive' ? ADM.badge('不适用', 'mute')
                            : ADM.badge(caEsc(r.status_text), 'warn')));
            }
        },
        { label: '获得积分', key: 'credit', sortKey: 'credit', render: function (r) { return '+' + caFmtNum(r.credit); } },
        { label: '说明', key: 'message', render: function (r) { return caEsc(r.message || '-'); } },
        { label: '来源', key: 'source', render: function (r) { return r.source === 'auto' ? '自动' : '手动'; } }
    ];
    var histHtml = '<div class="adm-section">' + ADM.sectionHead('bi-clock-history', '签到记录',
        '<span class="adm-hint">可用表格左上角下拉，或点日历格子按账号筛选</span>') +
        ADM.servTable(cols, {
            key: 'codearts-history', pageSize: 10, sortable: true,
            empty: '暂无签到记录，点上方「立即签到」开始积累',
            onRender: function (host) { caHistoryToolbar(host, accountsNow); },
            fetch: function (p) {
                return ADM.api('/api/codearts/history?q=' + encodeURIComponent(p.q) +
                    '&page=' + p.page + '&page_size=' + p.size +
                    '&sort=' + encodeURIComponent(p.sort || '') + '&order=' + encodeURIComponent(p.order || '') +
                    '&uid=' + encodeURIComponent(caHistoryUid || ''));
            }
        }) + '</div>';

    /* ---- 详情区：收进 Tab，首屏只留余额与签到操作 ---- */
    html += '<div class="adm-section wb-detail">' +
        ADM.sectionHead('bi-bar-chart', '积分与签到详情',
            '<span class="adm-hint">按需切换查看 · 选中的标签会自动保留</span>') +
        ADM.tabs([
            { id: 'history', name: '签到记录', icon: 'bi-clock-history', content: calHtml + histHtml },
            { id: 'entitlements', name: '积分构成', icon: 'bi-pie-chart', content: caEntitlementsHtml(d) },
            { id: 'expiry', name: '到期提醒', icon: 'bi-calendar2-week', content: caExpiryHtml(d) },
            { id: 'models', name: '模型与档位', icon: 'bi-cpu',
                content: '<div class="adm-section">' +
                    ADM.sectionHead('bi-cpu', '可用模型与积分倍率',
                        '<span class="adm-hint">目录来自华为云官方双源接口 · 点表内刷新强制重拉</span>') +
                    '<div class="adm-card" id="caModelsBody"><div class="wb-empty">正在读取模型清单…</div></div></div>' },
            { id: 'info', name: '账户信息', icon: 'bi-info-square', content: infoHtml }
        ], { key: 'codearts-detail-tabs' }) + '</div>';

    el.innerHTML = html;
    ADM.mountServTables(el);
    ADM.mountTabs(el);
    /* 模型与档位 Tab：面板已在 DOM 里，挂载后异步拉一次（隐藏面板也会渲染好） */
    caLoadModels(el);
}

/* ---------------- 积分构成（华为积分包无到期时间，样式对齐 WorkBuddy 构成 Tab） ---------------- */
var CA_SRC_COLORS = ['#5b8cff', '#4ade80', '#f59e0b', '#a78bfa', '#22d3ee', '#fb7185'];

function caSourceColor(name, idx) {
    if (typeof idx === 'number') return CA_SRC_COLORS[idx % CA_SRC_COLORS.length];
    var s = String(name || ''), hash = 0;
    for (var i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
    return CA_SRC_COLORS[hash % CA_SRC_COLORS.length];
}

function caEntitlementsHtml(d) {
    var cs = d.credits_summary || {};
    var updated = cs.updated_at;
    var h = '<div class="adm-section">' + ADM.sectionHead('bi-pie-chart', '总积分统计',
        '<span class="adm-hint">' + (updated
            ? '快照更新于 ' + caEsc(ADM.dt(updated)) + ' · 点「刷新」更新 · 余额取官方「总积分包」汇总口径'
            : '点上方「刷新」拉取华为云积分构成') + '</span>') +
        '<div class="adm-stat-grid wb-total-stats">';
    h += ADM.stat('bi-coin', '总可用积分', caFmtNum(cs.total_balance || 0),
        '官方汇总口径（总积分包剩余）· ' + (cs.account_count || 0) + ' 个账号');
    h += ADM.stat('bi-boxes', '积分包类目', caFmtNum(cs.by_source ? cs.by_source.length : 0),
        '基础 / 按需 / 赠送（不含汇总行）');
    h += ADM.stat('bi-clipboard-data', '积分包条目', caFmtNum(cs.package_count || 0),
        '本地快照记录数（含汇总行）');
    h += ADM.stat('bi-calculator', '已用积分', caFmtNum(cs.total_used || 0),
        '官方汇总口径（总积分包已用）');
    h += '</div></div>';

    /* 账号积分构成：堆叠条只画明细类目（总积分包是它们的汇总，不能重复入条） */
    var rows = cs.by_account || [];
    if (!rows.length) {
        h += '<div class="adm-section"><div class="wb-empty">暂无账号，先点「链接登录」添加账号。</div></div>';
        return h;
    }
    h += '<div class="adm-section">' + ADM.sectionHead('bi-bar-chart', '账号积分构成',
        '<span class="adm-hint">堆叠条按积分包类目着色 · 「总积分包」为汇总口径不参与堆叠</span>') +
        '<div class="wb-comp-list">';
    rows.forEach(function (row) {
        var packs = row.packages || [];
        var breakdown = packs.filter(function (p) { return !p.is_total; });
        var seg = '', legend = '';
        breakdown.forEach(function (p, i) {
            var w = row.size > 0 ? (p.size / row.size) * 100 : 0;
            if (w <= 0) return;
            var color = caSourceColor(p.pid, i);
            seg += '<span class="wb-comp-seg" style="width:' + w.toFixed(2) +
                '%;background:' + color + '" title="' + caEsc(p.name) + '：剩余 ' +
                caFmtNum(p.remain) + ' / ' + caFmtNum(p.size) + '"></span>';
            legend += '<span><i style="background:' + color + '"></i>' +
                caEsc(p.name) + ' ' + caFmtNum(p.remain) + '</span>';
        });
        if (!seg) {
            seg = '<span class="wb-comp-seg" style="width:100%;background:rgba(90,102,131,.45)"></span>';
            legend = '<span><i style="background:rgba(90,102,131,.45)"></i>' +
                (row.no_detail && row.balance ? '余额快照（暂无分包明细）' : '暂无数据') + '</span>';
        }
        var key = caEsc(row.uid || '_');
        h += '<div class="wb-comp-row">' +
            '<div class="wb-comp-head">' +
            '<div class="wb-comp-name"><i class="bi bi-person-circle"></i> ' +
            caEsc(row.display_name) +
            (row.is_default ? '<span class="wb-account-badge">默认</span>' : '') + '</div>' +
            '<div class="wb-comp-num"><b>' + caFmtNum(row.balance) + '</b> 积分' +
            '<span class="adm-hint"> / ' + breakdown.length + ' 类明细</span></div>' +
            '<button class="adm-btn sm ghost" data-cacomp-toggle="' + key +
            '" type="button">明细</button></div>' +
            '<div class="wb-comp-bar">' + seg + '</div>' +
            '<div class="wb-comp-legend">' + legend + '</div>' +
            '<div class="wb-comp-detail" data-cacomp-detail="' + key + '" hidden>' +
            caPackDetailTable(packs) + '</div>' +
            '</div>';
    });
    h += '</div></div>';
    return h;
}

function caPackDetailTable(packs) {
    var breakdown = (packs || []).filter(function (p) { return !p.is_total; });
    var totalPack = (packs || []).find(function (p) { return p.is_total; }) || null;
    if (!breakdown.length && !totalPack) {
        return '<div class="wb-empty">暂无积分包明细，点「刷新」拉取官方数据。</div>';
    }
    var h = '<table class="wb-pack-table"><thead><tr>' +
        '<th>积分包</th><th>面额</th><th>已用</th><th>剩余</th>' +
        '</tr></thead><tbody>';
    breakdown.forEach(function (p, i) {
        h += '<tr>' +
            '<td><i class="wb-exp-dot" style="background:' + caSourceColor(p.pid, i) + '"></i>' +
            caEsc(p.name) + '</td>' +
            '<td><b>' + caFmtNum(p.size) + '</b></td>' +
            '<td>' + caFmtNum(p.used) + '</td>' +
            '<td>' + caFmtNum(p.remain) + '</td></tr>';
    });
    if (totalPack) {
        // 汇总行：官方把「基础 + 按需 + 赠送」的合计也发了一份，单独展示不参与求和
        h += '<tr style="opacity:.72">' +
            '<td><i class="wb-exp-dot" style="background:#64748b"></i>' + caEsc(totalPack.name) +
            '<span class="wb-account-badge" title="官方汇总口径 = 各明细类目之和">汇总</span></td>' +
            '<td><b>' + caFmtNum(totalPack.size) + '</b></td>' +
            '<td>' + caFmtNum(totalPack.used) + '</td>' +
            '<td>' + caFmtNum(totalPack.remain) + '</td></tr>';
    }
    return h + '</tbody></table>';
}

/* ---------------- 到期提醒（STS 凭据倒计时 + 积分口径说明） ---------------- */

/* 实时倒计时（超过 1 天按天，1 天内精确到小时 / 分钟）：基于 Unix 秒现算 */
function caLeftText(expiresAt) {
    var left = Number(expiresAt) * 1000 - Date.now();
    if (!(left > 0)) return '已过期';
    var d = Math.floor(left / 86400000),
        h = Math.floor((left % 86400000) / 3600000),
        m = Math.floor((left % 3600000) / 60000);
    return d > 0 ? (d + '天' + h + '小时') : (h + '小时' + m + '分');
}

function caExpiryHtml(d) {
    var accounts = d.accounts || [];
    var h = '<div class="adm-section">' + ADM.sectionHead('bi-calendar2-week', 'STS 凭据到期提醒',
        '<span class="adm-hint">华为云临时凭据约 2 小时一轮 · 支持自动续期的账号在临期前 30 分钟自动换新</span>') +
        '<div class="adm-card">';
    if (!accounts.length) {
        h += '<div class="wb-empty">暂无账号。点「链接登录」添加账号。</div>';
    } else {
        h += '<div class="wb-exp-list">';
        accounts.forEach(function (a) {
            var expired = a.expired === true ||
                (Number(a.expires_at) > 0 && Number(a.expires_at) * 1000 <= Date.now());
            var soon = !expired && a.expires_soon === true;
            var tone = expired ? 'danger' : (soon ? 'warn' : 'mute');
            var dot = expired ? '#f87171' : (soon ? '#f59e0b' : '#22d3ee');
            h += '<div class="wb-exp-item">' +
                '<i class="wb-exp-dot" style="background:' + dot + '"></i>' +
                '<span class="wb-exp-who">' + caEsc(a.display_name) + '</span>' +
                '<span class="adm-hint">' +
                (a.refreshable ? '<i class="bi bi-arrow-repeat"></i> 自动续期开启' :
                    '<i class="bi bi-slash-circle"></i> 不支持自动续期') + '</span>' +
                '<b>' + (a.expires_text ? '至 ' + caEsc(a.expires_text) : '有效期未知') + '</b>' +
                '<span class="wb-exp-badge ' + tone + '">' +
                (expired ? '已过期 · 请重新链接登录' : caLeftText(a.expires_at)) + '</span>' +
                '</div>';
        });
        h += '</div>';
    }
    h += '</div></div>';

    /* 积分口径说明：华为积分不下发到期时间，如实说明而不是造一张空表 */
    h += '<div class="adm-section">' + ADM.sectionHead('bi-info-circle', '关于积分到期',
        '<span class="adm-hint">官方积分体系说明</span>') +
        '<div class="adm-card"><div class="ca-expiry-note">' +
        '<div><i class="bi bi-infinity"></i> 华为云积分包不下发到期时间：积分按剩余量扣减，' +
        '不存在「临期清零」，因此没有按天到期的分布图。</div>' +
        '<div><i class="bi bi-gift"></i> 每日签到积分实时到账，计入「总积分包」汇总口径' +
        '（可在「积分构成」Tab 查看基础 / 赠送等明细）。</div>' +
        '<div><i class="bi bi-shield-lock"></i> STS 临时凭据（AK / SK + security_token）约 2 小时一轮：' +
        '支持自动续期的账号在临期前 30 分钟自动换新；不支持自动续期的账号（凭据无 refresh_token）' +
        '过期后需重新链接登录。</div>' +
        '</div></div></div>';
    return h;
}

/* ---------------- 模型与档位（对齐 WorkBuddy「模型与档位」Tab） ----------------
 * 数据：/api/codearts/models —— 华为云 opengw gateway config + snap builtin 双源
 * 签名目录，含积分倍率（credit[].ratio_display，形如 "0.18x"）。30 分钟内存节流。
 */
var caModelsState = { models: [], q: '' };

function caModelsSyncCount() {
    var cnt = document.getElementById('caModelsCount');
    if (!cnt) return;
    var q = caModelsState.q.trim().toLowerCase();
    var list = caModelsState.models.filter(function (m) {
        return !q || (m.id + ' ' + (m.name || '') + ' ' + (m.vendor || '')).toLowerCase().indexOf(q) >= 0;
    });
    cnt.textContent = '共 ' + list.length + ' / ' + caModelsState.models.length + ' 个';
}

function caModelsRender() {
    var tb = document.getElementById('caModelsRows');
    var empty = document.getElementById('caModelsEmpty');
    if (!tb) return;
    var q = caModelsState.q.trim().toLowerCase();
    var list = caModelsState.models.filter(function (m) {
        return !q || (m.id + ' ' + (m.name || '') + ' ' + (m.vendor || '')).toLowerCase().indexOf(q) >= 0;
    });
    if (!list.length) {
        tb.innerHTML = '';
        if (empty) empty.hidden = false;
        caModelsSyncCount();
        return;
    }
    if (empty) empty.hidden = true;
    tb.innerHTML = list.map(function (m) {
        var rateN = Number(m.ratio);
        var rateHtml;
        if (m.ratio === null || m.ratio === undefined || m.ratio === '') {
            rateHtml = '<span class="wb-rate-val">—</span>';
        } else if (Number.isFinite(rateN) && rateN === 0) {
            rateHtml = '<b class="wb-rate-val free">0×</b><span class="wb-rate-badge warn">限时免费</span>';
        } else if (Number.isFinite(rateN)) {
            rateHtml = '<b class="wb-rate-val">×' + rateN.toFixed(2) + '</b>';
        } else {
            rateHtml = '<span class="wb-rate-val">—</span>';
        }
        var vendor = m.vendor ? '<div class="wb-mvendor">' + caEsc(m.vendor) + '</div>' : '';
        var name = m.name && m.name !== m.id
            ? '<div class="wb-mvendor">' + caEsc(m.name) + '</div>' : '';
        var src = m.source === 'gateway' ? '目录' : '内置';
        return '<tr data-mid="' + caEsc(m.id) + '">' +
            '<td class="wb-model-id"><div class="wb-mid-line"><span class="wb-mname mono">' +
            caEsc(m.id || '—') + '</span>' +
            '<button class="wb-copy" type="button" data-copy="' + caEsc(m.id) +
            '" title="复制模型 ID"><i class="bi bi-clipboard"></i></button></div>' +
            (name || vendor ? name + vendor : '') +
            '</td>' +
            '<td class="wb-rate-cell">' + rateHtml + '</td>' +
            '<td><span class="wb-tag" title="来源：' + caEsc(m.source || '') + '">' + caEsc(src) + '</span></td>' +
            '</tr>';
    }).join('');
    caModelsSyncCount();
}

function caModelsBind(d, body) {
    caModelsState.models = d.models || [];
    var s = body.querySelector('#caModelsSearch');
    if (s) s.addEventListener('input', function () {
        caModelsState.q = s.value;
        caModelsRender();
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
    caModelsRender();
}

function caModelsHtml(d) {
    var c = d.counts || { total: 0, free: 0, rated: 0, unknown: 0 };
    var h = '<div class="adm-section">' + ADM.sectionHead('bi-award', '模型概览',
        '<span class="adm-hint">账号 ' + caEsc(String(d.uid || '').slice(0, 16)) +
        (d.cached ? ' · 内存缓存' : ' · 实时拉取') + '</span>') +
        '<div class="adm-stat-grid">';
    h += ADM.stat('bi-cpu', '可用模型', caFmtNum(c.total || 0), '双源目录去重后数量');
    h += ADM.stat('bi-lightning-charge', '限时免费', caFmtNum(c.free || 0), '倍率为 0× 的模型');
    h += ADM.stat('bi-coin', '计费模型', caFmtNum(c.rated || 0), '带积分倍率的模型');
    h += ADM.stat('bi-question-circle', '倍率未知', caFmtNum(c.unknown || 0), '官方未下发倍率的模型');
    h += '</div></div>';

    var filters =
        '<div class="wb-model-filters">' +
        '<div class="wb-model-search"><i class="bi bi-search"></i>' +
        '<input type="text" id="caModelsSearch" placeholder="搜索模型 ID / 名称 / 厂商…" ' +
        'aria-label="搜索模型" value="' + caEsc(caModelsState.q) + '"></div>' +
        '<button class="adm-btn sm ghost" id="caModelsRefresh" type="button">' +
        '<i class="bi bi-arrow-clockwise"></i> 刷新</button>' +
        '<span class="wb-model-count" id="caModelsCount" role="status"></span>' +
        '</div>';

    var table = '<div class="wb-model-table-wrap"><table class="wb-pack-table wb-model-table">' +
        '<thead><tr><th>模型</th><th>积分倍率</th><th>来源</th></tr></thead>' +
        '<tbody id="caModelsRows"></tbody></table>' +
        '<div class="wb-empty" id="caModelsEmpty" hidden>没有符合条件的模型</div>' +
        '</div>';

    return '<div class="adm-section">' + ADM.sectionHead('bi-cpu', '可用模型列表',
        '<span class="adm-hint">倍率来自官方 credit.ratio_display · 0× 为限时免费</span>') +
        filters + table + '</div>';
}

/* 模型与档位：挂载后拉一次；点「刷新」强制重拉 */
async function caLoadModels(el, force) {
    var body = el.querySelector('#caModelsBody');
    if (!body) return;
    if (body.dataset.loaded && !force) return;
    body.innerHTML = '<div class="wb-empty">正在读取模型清单…</div>';
    try {
        var d = await ADM.api('/api/codearts/models?uid=' + encodeURIComponent(caCurrentUid || '') +
            (force ? '&force=1' : ''));
        if (d && d.error) {
            body.innerHTML = '<div class="wb-empty">' + caEsc(d.error) + '</div>';
            return;
        }
        body.dataset.loaded = '1';
        body.innerHTML = caModelsHtml(d);
        caModelsBind(d, body);
        var rb = body.querySelector('#caModelsRefresh');
        if (rb) rb.addEventListener('click', function () { caLoadModels(el, true); });
    } catch (e) {
        body.innerHTML = '<div class="wb-empty">加载失败：' +
            caEsc((e && e.message) || String(e)) + '</div>';
    }
}

/* ---------------- 账号管理区 ---------------- */
function caAccountBar(d) {
    var accounts = d.accounts || [];
    var cur = d.current_uid || '';
    var h = '<div class="adm-section">' + ADM.sectionHead('bi-people', '账号管理',
        '<div class="adm-btn-row">' +
        '<button class="adm-btn sm primary" id="caAddAcc" type="button"><i class="bi bi-link-45deg"></i> 链接登录</button>' +
        '<button class="adm-btn sm ghost" id="caCheckinAll" type="button"' +
        (d.checkin_all_done ? ' disabled title="今日所有账号均已签到"' : '') + '>' +
        '<i class="bi bi-check2-all"></i> ' +
        (d.checkin_all_done ? '今日已全部签到' : '全部签到') + '</button>' +
        '<button class="adm-btn sm ' + (d.caCron && d.caCron.enabled ? 'primary' : 'ghost') +
        '" id="caAutoCheckin" type="button" title="' +
        (d.caCron
            ? '每 6 小时执行一次；今日全部签到后自动跳过。下次：' +
              caEsc((d.caCron.next || [])[0] || '待计算')
            : '创建每 6 小时执行一次的定时签到任务；今日全部签到后自动跳过') + '">' +
        '<i class="bi bi-clock-history"></i> ' +
        (d.caCron ? (d.caCron.enabled ? '定时签到：已开启' : '定时签到：已关闭') : '开启定时签到') +
        '</button>' +
        '<button class="adm-btn sm ghost" id="caRefreshAll" type="button"><i class="bi bi-arrow-repeat"></i> 刷新余额</button>' +
        '</div>') + '<div class="wb-accounts">';
    if (!accounts.length) {
        h += '<div class="wb-accounts-empty"><i class="bi bi-person-plus"></i> ' +
            '还没有账号，点「链接登录」在浏览器里完成华为云授权后开始签到。</div>';
    }
    accounts.forEach(function (a) {
        var active = a.uid === cur;
        var initial = (a.display_name || '?').slice(0, 1).toUpperCase();
        h += '<div class="wb-account' + (active ? ' active' : '') + '" data-cauid="' + caEsc(a.uid) + '">' +
            '<div class="wb-account-top">' +
            '<span class="wb-account-avatar">' + caEsc(initial) + '</span>' +
            '<div class="wb-account-id"><b>' + caEsc(a.display_name) + '</b>' +
            '<span class="adm-hint" title="' + caEsc(a.uid) + '">UID ' +
            caEsc(a.uid.slice(0, 16)) + (a.uid.length > 16 ? '…' : '') + '</span></div>' +
            (a.is_default ? '<span class="wb-account-badge">默认</span>' : '') +
            (active ? '<span class="wb-account-badge current">当前</span>' : '') +
            '</div>' +
            '<div class="wb-account-meta">' +
            '<span class="wb-account-balance"><i class="bi bi-coin"></i> ' +
            (a.last_balance === null || a.last_balance === undefined ? '—' : caFmtNum(a.last_balance)) +
            '<em>积分</em></span>' +
            '<span class="wb-account-tags"><i class="bi bi-key"></i> ' +
            (a.credential_set ? '凭据已配置' : '缺凭据') +
            '<span class="dot">·</span>' +
            '<i class="bi bi-arrow-repeat"></i> ' + (a.refreshable ? '可自动续期' : '无续期') +
            '</span></div>' +
            '<div class="wb-account-exp' + (a.expires_soon || a.expired ? ' warn' : '') + '">' +
            caEsc(a.expires_text ? 'STS 有效期至 ' + a.expires_text : '有效期未知') +
            '</div>' +
            '<div class="wb-account-acts">' +
            '<button class="adm-btn sm ghost" data-caact="use"' + (active ? ' disabled' : '') + '>切换</button>' +
            '<button class="adm-btn sm ghost" data-caact="edit">编辑</button>' +
            '<button class="adm-btn sm ghost" data-caact="renew"' +
            (a.refreshable ? '' : ' title="该凭据无 refresh_token，请重新链接登录"') + '>续期</button>' +
            '<button class="adm-btn sm ghost" data-caact="default"' +
            (a.is_default ? ' disabled' : '') + '>设为默认</button>' +
            '<button class="adm-btn sm danger" data-caact="del">移除</button>' +
            '</div></div>';
    });
    h += '</div></div>';
    return h;
}

/* ---------------- 签到日历 / 记录筛选 ---------------- */
function caFmtDay(ts) {
    var n = Number(ts);
    if (!n || isNaN(n)) return '—';
    var d = new Date(n * 1000);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') +
        '-' + String(d.getDate()).padStart(2, '0');
}

function caDayStr(dt) {
    return dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') +
        '-' + String(dt.getDate()).padStart(2, '0');
}

/* 按「账号 × 最近 14 天」生成签到矩阵（同 WorkBuddy / Trae CN） */
function caCalendar(today, recent, accounts, currentUid) {
    var map = {};
    (recent || []).forEach(function (r) {
        var k = (r.uid || '') + '|' + r.day;
        var old = map[k];
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
        days.push({ day: caDayStr(dt), label: (dt.getMonth() + 1) + '/' + dt.getDate(),
            w: week[dt.getDay()] });
    }
    var todayStr = caDayStr(base);

    var lines = (accounts || []).map(function (a) {
        return { uid: a.uid, name: a.display_name || a.uid.slice(0, 16),
            current: a.uid === currentUid, removed: false };
    });
    var known = {};
    lines.forEach(function (l) { known[l.uid] = 1; });
    (recent || []).forEach(function (r) {
        var u = r.uid || '';
        if (u && !known[u]) {
            known[u] = 1;
            lines.push({ uid: u, name: u.slice(0, 16) + '…',
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
            '<b>' + caEsc(day.label) + '</b><span>周' + day.w + '</span></div>';
    });
    h += '</div>';

    lines.forEach(function (l) {
        var cnt = 0, sum = 0;
        var cells = days.map(function (day) {
            var r = map[l.uid + '|' + day.day];
            var cls = 'wb-cal-cell', icon = 'bi-dash', small = '', tip = day.day + '：无记录';
            if (r) {
                var ok = r.status === 'success', done = r.status === 'already';
                cls += ok ? ' ok' : (done ? ' done' : (r.status === 'inactive' ? '' : ' bad'));
                icon = (ok || done) ? 'bi-check2' : (r.status === 'inactive' ? 'bi-dash' : 'bi-exclamation-triangle');
                small = r.credit ? ('+' + caFmtNum(r.credit)) : '';
                if (ok || done) { cnt++; sum += Number(r.credit) || 0; }
                tip = day.day + ' · ' + (r.status_text || r.status) +
                    (r.credit ? ' +' + caFmtNum(r.credit) + ' 积分' : '') +
                    (r.at_text ? ' · ' + r.at_text : '') +
                    (r.message ? ' · ' + r.message : '');
            }
            if (day.day === todayStr) cls += ' today';
            return '<button type="button" class="' + cls + '" data-cacaluid="' +
                caEsc(l.uid) + '" title="' + caEsc(tip) + '">' +
                '<i class="bi ' + icon + '"></i>' +
                (small ? '<small>' + caEsc(small) + '</small>' : '') + '</button>';
        }).join('');
        var t = map[l.uid + '|' + todayStr];
        var todayTag = (t && (t.status === 'success' || t.status === 'already'))
            ? '<span class="wb-cal-today ok">今日已签</span>'
            : '<span class="wb-cal-today warn">今日未签</span>';
        h += '<div class="wb-cal-row"><div class="wb-cal-account">' +
            '<div class="wb-cal-account-name"><b>' + caEsc(l.name) + '</b>' +
            (l.current ? '<span class="wb-account-badge current">当前</span>' : '') +
            (l.removed ? '<span class="wb-account-badge">已移除</span>' : '') + '</div>' +
            '<div class="wb-cal-account-meta">' + todayTag +
            '<span>14 天 ' + cnt + ' 次 · +' + caFmtNum(sum) + ' 积分</span></div>' +
            '</div>' + cells + '</div>';
    });
    h += '</div></div>';
    h += '<div class="wb-cal-legend">' +
        '<span><i class="wb-legend-dot ok"></i> 签到成功</span>' +
        '<span><i class="wb-legend-dot done"></i> 今日已领</span>' +
        '<span><i class="wb-legend-dot miss"></i> 无记录</span>' +
        '<span><i class="wb-legend-dot today"></i> 今天</span>' +
        '<span class="adm-hint">点任意格子可在下方记录表中筛选该账号</span></div>';
    return h;
}

/* 签到记录表工具栏：注入「按账号筛选」下拉 */
function caHistoryToolbar(host, accounts) {
    var bar = host.querySelector('.adm-table-toolbar');
    if (!bar || bar.querySelector('#caHistoryAccount')) return;
    var sel = document.createElement('select');
    sel.className = 'adm-select wb-history-account';
    sel.id = 'caHistoryAccount';
    sel.title = '按账号筛选签到记录';
    sel.innerHTML = '<option value="">全部账号</option>' + (accounts || []).map(function (a) {
        return '<option value="' + caEsc(a.uid) + '">' +
            caEsc(a.display_name || a.uid.slice(0, 16)) + '</option>';
    }).join('');
    sel.value = caHistoryUid;
    sel.addEventListener('change', function () {
        caHistoryUid = sel.value;
        var st = ADM._servTables['codearts-history'];
        if (st) st.page = 1;
        ADM.loadServ(host, 'codearts-history');
    });
    bar.insertBefore(sel, bar.firstChild);
}

/* ---------------- 事件绑定 ---------------- */
function caBind(el, d) {
    var reload = el.querySelector('#caReload');
    if (reload) reload.addEventListener('click', function () {
        caRefresh(el, undefined, true);   // 手动「刷新」才拉取华为云最新数据
    });

    var checkin = el.querySelector('#caCheckin');
    if (checkin) checkin.addEventListener('click', async function () {
        checkin.disabled = true;
        try {
            var r = await ADM.api('/api/codearts/checkin', {
                method: 'POST', body: { source: 'manual', uid: caCurrentUid }
            });
            ADM.toast(r.status === 'success'
                ? ('签到成功，+' + caFmtNum(r.credit) + ' 积分')
                : (r.message || '今天已领取'),
                r.status === 'success' ? 'ok' : 'warn');
            await caRefresh(el, undefined, true);
        } catch (e) {
            ADM.toast((e && e.message) || String(e), 'err');
            checkin.disabled = false;
        }
    });

    var test = el.querySelector('#caTest');
    if (test) test.addEventListener('click', async function () {
        test.disabled = true;
        try {
            var r = await ADM.api('/api/codearts/test', {
                method: 'POST', body: { uid: caCurrentUid }
            });
            var s = r.status || {};
            ADM.toast('连接正常：' + (s.active === false
                ? (s.message || '不在积分活动范围')
                : (s.today_checked_in ? '今日已签到' : '今日待签到')), 'ok');
        } catch (e) {
            ADM.toast((e && e.message) || String(e), 'err');
        }
        test.disabled = false;
    });

    [el.querySelector('#caLogin'), el.querySelector('#caLogin2'),
        el.querySelector('#caAddAcc')].forEach(function (btn) {
        if (btn) btn.addEventListener('click', function () { caOpenLogin(el); });
    });

    var all = el.querySelector('#caCheckinAll');
    if (all) all.addEventListener('click', async function () {
        all.disabled = true;
        try {
            var r = await ADM.api('/api/codearts/checkin/all', { method: 'POST', body: {} });
            var s = r.summary || {};
            ADM.toast('批量签到：成功 ' + (s.success || 0) + ' · 已签 ' + (s.already || 0) +
                ' · 失败 ' + (s.failed || 0), s.failed ? 'warn' : 'ok');
            await caRefresh(el, undefined, true);
        } catch (e) {
            ADM.toast((e && e.message) || String(e), 'err');
            all.disabled = false;
        }
    });

    var auto = el.querySelector('#caAutoCheckin');
    if (auto) auto.addEventListener('click', async function () {
        auto.disabled = true;
        try {
            var task = d.caCron;
            var r;
            if (task) {
                r = await ADM.api('/api/cron/toggle', {
                    method: 'POST', body: { id: task.id, enabled: !task.enabled }
                });
            } else {
                r = await ADM.api('/api/cron/save', {
                    method: 'POST', body: {
                        name: 'CodeArts 定时签到（每6小时）',
                        cron: '0 */6 * * *',
                        kind: 'system',
                        content: 'codearts_checkin_all',
                        enabled: true,
                        notify: false,
                        remark: '每 6 小时批量签到；今日全部签过后自动跳过',
                        timeout: 600
                    }
                });
            }
            if (r && r.error) throw new Error(r.error);
            ADM.toast(task
                ? (task.enabled ? '定时签到已关闭' : '定时签到已开启')
                : '定时签到已开启（每 6 小时，静默运行）', 'ok');
            await caRefresh(el);
        } catch (e) {
            ADM.toast((e && e.message) || String(e), 'err');
            auto.disabled = false;
        }
    });

    var refreshAll = el.querySelector('#caRefreshAll');
    if (refreshAll) refreshAll.addEventListener('click', async function () {
        refreshAll.disabled = true;
        try {
            var r = await ADM.api('/api/codearts/accounts/refresh_all', { method: 'POST', body: {} });
            var s = r.summary || {};
            ADM.toast('余额刷新：成功 ' + (s.success || 0) + ' · 失败 ' + (s.failed || 0),
                s.failed ? 'warn' : 'ok');
            await caRefresh(el, undefined, true);
        } catch (e) {
            ADM.toast((e && e.message) || String(e), 'err');
            refreshAll.disabled = false;
        }
    });

    /* 积分构成「明细」折叠切换（Tab 懒挂载后可能重新绑定，用标志位防重复） */
    el.querySelectorAll('[data-cacomp-toggle]').forEach(function (btn) {
        if (btn.dataset.cacompBound) return;
        btn.dataset.cacompBound = '1';
        btn.addEventListener('click', function () {
            var key = btn.dataset.cacompToggle;
            var box = el.querySelector('[data-cacomp-detail="' + key + '"]');
            if (!box) return;
            box.hidden = !box.hidden;
            btn.textContent = box.hidden ? '明细' : '收起';
        });
    });

    /* 点日历格子 → 按账号筛选下方签到记录表（同 WorkBuddy） */
    el.querySelectorAll('[data-cacaluid]').forEach(function (cell) {
        cell.addEventListener('click', function () {
            caHistoryUid = cell.dataset.cacaluid || '';
            var sel = el.querySelector('#caHistoryAccount');
            if (sel) sel.value = caHistoryUid;
            var host = el.querySelector('[data-adm-serv="codearts-history"]');
            if (!host) return;
            var st = ADM._servTables['codearts-history'];
            if (st) st.page = 1;
            ADM.loadServ(host, 'codearts-history');
            if (host.scrollIntoView) {
                host.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
        });
    });

    el.querySelectorAll('[data-caact]').forEach(function (btn) {
        btn.addEventListener('click', async function () {
            var host = btn.closest('.wb-account');
            var uid = host ? host.dataset.cauid : '';
            var act = btn.dataset.caact;
            if (!uid) return;
            if (act === 'del') {
                // 与 WorkBuddy 同款：danger 按钮 + 按钮旁悬浮确认，取消不残留禁用态
                var nameEl = host.querySelector('.wb-account-id b');
                var accName = nameEl ? nameEl.textContent : uid;
                btn.disabled = false;
                wbConfirmPop(btn, {
                    title: '移除该账号？',
                    text: '将删除「' + accName + '」在本机保存的华为云凭据（不影响华为云账号本身），下次使用需重新链接登录。',
                    okText: '确认移除',
                    onCancel: function () { btn.disabled = false; },
                    onOk: async function () {
                        btn.disabled = true;
                        try {
                            await ADM.api('/api/codearts/accounts/delete',
                                { method: 'POST', body: { uid: uid } });
                            ADM.toast('账号已移除', 'ok');
                            await caRefresh(el, '');
                        } catch (err) {
                            ADM.toast((err && err.message) || String(err), 'err');
                            btn.disabled = false;
                        }
                    }
                });
                return;
            }
            btn.disabled = true;
            try {
                if (act === 'use') {
                    await ADM.api('/api/codearts/accounts/current',
                        { method: 'POST', body: { uid: uid } });
                    ADM.toast('已切换账号', 'ok');
                    await caRefresh(el, uid);
                } else if (act === 'default') {
                    await ADM.api('/api/codearts/accounts/save',
                        { method: 'POST', body: { uid: uid, is_default: true } });
                    ADM.toast('已设为默认账号', 'ok');
                    await caRefresh(el);
                } else if (act === 'renew') {
                    var r = await ADM.api('/api/codearts/accounts/refresh',
                        { method: 'POST', body: { uid: uid } });
                    ADM.toast('续期成功，新凭据有效期至 ' + (r.expires_text || '未知'), 'ok');
                    await caRefresh(el);
                } else if (act === 'edit') {
                    btn.disabled = false;
                    caOpenEditAccount(el, uid);
                }
            } catch (e) {
                ADM.toast((e && e.message) || String(e), 'err');
                btn.disabled = false;
            }
        });
    });
}

/* ---------------- 链接登录弹窗（华为云 OAuth 浏览器授权） ---------------- */
async function caOpenLogin(el) {
    var started;
    try {
        started = await ADM.api('/api/codearts/login/start', { method: 'POST', body: {} });
    } catch (e) {
        ADM.toast((e && e.message) || String(e), 'err');
        return;
    }
    var state = started.state || '';
    var html = '<div class="ca-login-steps">' +
        '<div class="ca-login-step"><span class="ca-step-badge">1</span><div>' +
        '点 <b>「打开授权页」</b> 在新标签页登录华为云；也可以复制链接，粘贴到任意本机浏览器打开。</div></div>' +
        '<div class="ca-login-step"><span class="ca-step-badge">2</span><div>' +
        '登录成功后华为云会自动跳回 <code>http://127.0.0.1:' + caEsc(started.port) +
        '/oauth/callback</code>——跳转后的空白 / 提示页是正常的，本弹窗会在几秒内自动完成登录。</div></div>' +
        '<div class="ca-login-step meta"><i class="bi bi-hourglass-split"></i><span>' +
        '会话有效期 ' + caEsc(Math.round((started.expires_in || 600) / 60)) +
        ' 分钟，超时请重新发起；凭据将加密保存在本机 store.db，页面与日志均不回显。</span></div>' +
        '</div>' +
        '<div class="adm-field"><label>授权链接</label>' +
        '<input class="adm-input ca-login-url" type="text" readonly value="' +
        caEsc(started.url || '') + '" id="caLoginUrl">' +
        '<div class="ca-login-actions">' +
        '<button class="adm-btn sm ghost" id="caLoginCopy" type="button"><i class="bi bi-clipboard"></i> 复制链接</button>' +
        '<a class="adm-btn sm primary" href="' + caEsc(started.url || '') +
        '" target="_blank" rel="noopener noreferrer"><i class="bi bi-box-arrow-up-right"></i> 打开授权页</a>' +
        '<span class="adm-hint">登录后本弹窗自动完成</span>' +
        '</div></div>' +
        '<div class="wb-ok ca-login-status" id="caLoginStatus" style="display:none"></div>';
    var stopped = false;
    if (caLoginTimer) { clearInterval(caLoginTimer); caLoginTimer = null; }
    var result = await ADM.modal({
        title: 'CodeArts 链接登录（华为云授权）',
        icon: 'bi-link-45deg',
        size: 'wide',
        html: html,
        okText: '取消登录',
        cancelText: '关闭',
        onOpen: function (box, done) {
            var status = box.querySelector('#caLoginStatus');
            var showStatus = function (text, ok) {
                if (!status) return;
                status.style.display = 'flex';
                status.className = 'wb-ok ca-login-status' + (ok ? ' done' : '');
                status.innerHTML = '<i class="bi ' + (ok ? 'bi-check2-circle' : 'bi-arrow-repeat') +
                    '"></i><span>' + caEsc(text) + '</span>';
            };
            /* 授权链接框：聚焦即全选，方便一键复制 */
            var urlInput = box.querySelector('#caLoginUrl');
            if (urlInput) urlInput.addEventListener('focus', function () {
                try { urlInput.select(); } catch (_) { /* 忽略 */ }
            });
            var pollOnce = async function () {
                try {
                    var r = await ADM.api('/api/codearts/login/poll?state=' +
                        encodeURIComponent(state));
                    if (r && r.done) {
                        clearInterval(caLoginTimer);
                        caLoginTimer = null;
                        showStatus('登录成功：' + (r.nickname || r.uid || '账号') +
                            ' 凭据已加密保存', true);
                        ADM.toast('CodeArts 账号已添加', 'ok');
                        if (el) await caRefresh(el);
                        setTimeout(function () { done(true); }, 1200);
                    } else {
                        showStatus((r && r.message) || '等待浏览器登录授权…', false);
                    }
                } catch (e) {
                    clearInterval(caLoginTimer);
                    caLoginTimer = null;
                    showStatus((e && e.message) || '登录会话已结束', false);
                }
            };
            pollOnce();
            caLoginTimer = setInterval(pollOnce, 2000);
            var copy = box.querySelector('#caLoginCopy');
            if (copy) copy.addEventListener('click', function () {
                var input = box.querySelector('#caLoginUrl');
                try {
                    input.select();
                    navigator.clipboard.writeText(input.value);
                    copy.innerHTML = '<i class="bi bi-check2"></i> 已复制';
                    setTimeout(function () {
                        copy.innerHTML = '<i class="bi bi-clipboard"></i> 复制';
                    }, 1500);
                } catch (_) { /* 非安全上下文忽略 */ }
            });
        },
        onOk: async function () {
            stopped = true;
            if (caLoginTimer) { clearInterval(caLoginTimer); caLoginTimer = null; }
            try {
                await ADM.api('/api/codearts/login/cancel', { method: 'POST', body: { state: state } });
            } catch (_) { /* 取消失败不影响 */ }
            return true;
        }
    });
    if (result !== undefined && el) await caRefresh(el);
}

/* ---------------- 编辑账号弹窗（昵称 / 备注，凭据只能由链接登录写入） ---------------- */
async function caOpenEditAccount(el, uid) {
    var acc = null;
    try {
        var r = await ADM.api('/api/codearts/accounts');
        acc = (r.items || []).find(function (a) { return a.uid === uid; }) || null;
    } catch (e) { /* 列表拿不到也能编辑 */ }
    if (!acc) {
        ADM.toast('账号不存在或已被移除', 'err');
        return;
    }
    var html = '<div class="adm-fields">' + [
        ADM.fieldHtml({
            name: 'nickname', label: '昵称', value: acc.nickname || '',
            placeholder: '便于区分，如「主力号」'
        }),
        ADM.fieldHtml({
            name: 'remark', label: '备注', value: acc.remark || '',
            placeholder: '备注信息（仅本机可见）'
        }),
        ADM.fieldHtml({
            name: 'enabled', label: '状态（参与批量签到 / 刷新）',
            type: 'select', value: acc.enabled ? '1' : '0',
            options: [{ value: '1', label: '启用' }, { value: '0', label: '停用' }]
        })
    ].join('') +
        '<div class="adm-hint" style="display:block;line-height:1.8">' +
        '凭据（AK / SK / security_token / refresh_token）由「链接登录」自动生成并加密保存，' +
        '本弹窗不支持手工填写；STS 凭据约 2 小时一轮，支持自动续期的账号会在临期前换新，' +
        '不支持的请临期重新链接登录。</div>';
    await ADM.modal({
        title: '编辑 CodeArts 账号 · ' + caEsc(acc.display_name),
        icon: 'bi-person-gear',
        html: html,
        okText: '保存',
        onOk: async function (box) {
            var f = ADM.readForm(box);
            var r = await ADM.api('/api/codearts/accounts/save', {
                method: 'POST', body: {
                    uid: uid,
                    nickname: (f.nickname || '').trim(),
                    remark: (f.remark || '').trim(),
                    enabled: String(f.enabled) === '1'
                }
            });
            ADM.toast('账号已保存', 'ok');
            await caRefresh(el, (r.account && r.account.uid) || '');
            return true;
        }
    });
}

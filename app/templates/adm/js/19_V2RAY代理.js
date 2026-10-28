/* 后台管理：V2RAY 代理管理（复用 IDE 侧栏同款 /api/v2ray/* 接口，
 * 覆盖：状态总览 / 连接控制 / 节点管理与测延迟 / 订阅管理 / 端口设置 / 运行日志）。 */
ADM.modules.push({
    id: 'v2ray',
    name: 'V2RAY 代理',
    subtitle: '订阅 / 节点 / 10808 代理出口',
    icon: 'bi-shield-lock',
    async load(el) {
        el.innerHTML = ADM.loading('加载代理状态…');
        var st, nd, sb;
        try {
            var rs = await Promise.all([
                ADM.api('/api/v2ray/status'),
                ADM.api('/api/v2ray/nodes'),
                ADM.api('/api/v2ray/subs')
            ]);
            st = rs[0]; nd = rs[1]; sb = rs[2];
        } catch (e) {
            el.innerHTML = '<div class="adm-card"><div class="adm-hint">加载失败：' +
                ADM.esc((e && e.message) || e) + '</div></div>';
            return;
        }
        v2admRender(el, st, nd, sb);
        v2admPoll(el);
    }
});

/* ---------------- 渲染 ---------------- */
function v2admRender(el, st, nd, sb) {
    var running = !!st.running;
    var node = st.node || null;
    var inb = st.inbound || {};
    var core = st.core || {};
    var today = st.today || {};
    var activeId = node ? node.id : '';
    var metrics = nd.metrics || {};
    var subCount = {};
    (sb.subs || []).forEach(function (s) { subCount[s.id] = 0; });
    (nd.nodes || []).forEach(function (n) {
        if (subCount[n.sub_id] !== undefined) subCount[n.sub_id]++;
    });

    /* ---- 状态总览 ---- */
    var html = '<div class="adm-section">' + ADM.sectionHead('bi-speedometer2', '运行总览',
        '<span class="adm-hint">SOCKS5 127.0.0.1:' + (inb.socks_port || 10808) +
        (inb.http_port ? ' · HTTP :' + inb.http_port : '') + '</span>') + '<div class="adm-stat-grid">';
    html += ADM.stat(running ? 'bi-play-circle' : 'bi-stop-circle',
        '运行状态', running ? '<span class="adm-badge ok">已连接</span>' : '<span class="adm-badge mute">未运行</span>',
        running ? (node ? node.name : '内核运行中') + (st.pid ? ' · PID ' + st.pid : '') : '尚未连接任何节点');
    html += ADM.stat('bi-arrow-down-up', '今日流量',
        ADM.bytes(today.down || 0) + ' <span style="opacity:.55">↓</span> / ' + ADM.bytes(today.up || 0) + ' <span style="opacity:.55">↑</span>',
        running ? '实时网速见下方连接控制' : '连接后开始统计');
    html += ADM.stat('bi-hdd-network', '节点 / 订阅',
        (nd.nodes || []).length + ' <span style="opacity:.55">节点</span> / ' + (sb.subs || []).length + ' <span style="opacity:.55">订阅</span>',
        core.ok ? ('内核 ' + ADM.esc(core.kind || 'xray') + ' ' + ADM.esc(core.version || '')) : '内核未检测到');
    html += ADM.stat('bi-activity', '监听范围', inb.listen === '127.0.0.1' ? '仅本机' : '局域网',
        inb.auth ? '入站已启用账号认证' : '入站未启用认证');
    html += '</div></div>';

    /* ---- 连接控制 ---- */
    html += '<div class="adm-section">' + ADM.sectionHead('bi-power', '连接控制') +
        '<div class="adm-card">' +
        '<div class="adm-btn-row" style="flex-wrap:wrap;align-items:center;gap:14px">' +
        '<span style="font-size:13px">' + (running
            ? '当前节点：<b>' + ADM.esc(node ? node.name : '-') + '</b> <span class="adm-badge info">' + ADM.esc(node ? node.proto : '') + '</span>' +
              ' <span class="adm-hint">' + ADM.esc((node ? node.server : '') + ':' + (node ? node.port : '')) + '</span>'
            : '<span class="adm-hint">未连接。在下方节点列表点「连接」即可启动内核。</span>') + '</span>' +
        (running ? '<span class="adm-hint">运行 ' + ADM.esc(ADM.dur(st.uptime || 0)) +
            (st.mem && st.mem.rss ? ' · 内存 ' + ADM.esc(ADM.bytes(st.mem.rss)) : '') + '</span>' : '') +
        '</div>' +
        '<div class="adm-btn-row" style="margin-top:12px">' +
        (running
            ? '<button class="adm-btn danger" data-v2act="disconnect"><i class="bi bi-stop-circle"></i> 断开</button>' +
              '<button class="adm-btn" data-v2act="restart"><i class="bi bi-arrow-repeat"></i> 重启内核</button>'
            : '') +
        '<button class="adm-btn ghost" data-v2act="exit-test"><i class="bi bi-globe2"></i> 测出口 IP</button>' +
        '<button class="adm-btn ghost" data-v2act="log"><i class="bi bi-terminal"></i> 运行日志</button>' +
        '<button class="adm-btn ghost" data-v2act="reload"><i class="bi bi-arrow-clockwise"></i> 刷新状态</button>' +
        '<span class="adm-hint" id="v2admSpeed" style="margin-left:auto"></span>' +
        '</div></div></div>';

    /* ---- 节点 / 订阅 / 端口与行为：Tab 切换 ---- */
    var sst = st.settings || {};
    html += ADM.tabs([
        { id: 'nodes', name: '节点管理', icon: 'bi-diagram-3', content:
            '<div class="adm-tab-toolbar" style="justify-content:flex-start">' +
            '<button class="adm-btn sm" data-v2act="ping-all"><i class="bi bi-speedometer2"></i> 批量测延迟</button>' +
            '<button class="adm-btn sm primary" data-v2act="add-node"><i class="bi bi-plus-lg"></i> 添加节点</button>' +
            '</div>' + v2admNodeTable(nd, metrics, activeId) },
        { id: 'subs', name: '订阅管理', icon: 'bi-rss', content:
            '<div class="adm-tab-toolbar" style="justify-content:flex-start">' +
            '<button class="adm-btn sm" data-v2act="refresh-subs"><i class="bi bi-cloud-download"></i> 刷新全部订阅</button>' +
            '<button class="adm-btn sm primary" data-v2act="add-sub"><i class="bi bi-plus-lg"></i> 添加订阅</button>' +
            '</div>' + v2admSubTable(sb, subCount) },
        { id: 'settings', name: '端口与行为', icon: 'bi-gear', content:
            '<div class="adm-card">' +
            '<div class="adm-btn-row" style="flex-wrap:wrap;gap:18px">' +
            '<label style="font-size:12.5px">SOCKS5 端口 <input class="adm-input" id="v2SocksPort" style="width:110px" value="' +
                ADM.esc(sst.socks_port || 10808) + '"></label>' +
            '<label style="font-size:12.5px">HTTP 端口 <input class="adm-input" id="v2HttpPort" style="width:110px" value="' +
                ADM.esc(sst.http_port || 0) + '"><span class="adm-hint">（0 = 不开启）</span></label>' +
            '<label style="font-size:12.5px">监听地址 <select class="adm-input" id="v2Listen" style="width:170px">' +
                '<option value="0.0.0.0"' + (sst.socks_listen !== '127.0.0.1' ? ' selected' : '') + '>0.0.0.0（局域网可用）</option>' +
                '<option value="127.0.0.1"' + (sst.socks_listen === '127.0.0.1' ? ' selected' : '') + '>127.0.0.1（仅本机）</option>' +
            '</select></label>' +
            '<label class="adm-switch" style="font-size:12.5px"><input type="checkbox" id="v2AutoStart"' +
                (sst.auto_start ? ' checked' : '') + '> 随系统自启</label>' +
            '<label class="adm-switch" style="font-size:12.5px"><input type="checkbox" id="v2Failover"' +
                (sst.auto_failover ? ' checked' : '') + '> 节点失效自动切换</label>' +
            '</div>' +
            /* ---- 入站账号认证（0.0.0.0 局域网监听时后端会强制启用） ---- */
            '<div class="adm-btn-row" style="flex-wrap:wrap;gap:18px;margin-top:14px;padding-top:14px;border-top:1px dashed var(--adm-border)">' +
            '<label class="adm-switch" style="font-size:12.5px"><input type="checkbox" id="v2Auth"' +
                (sst.auth_enabled ? ' checked' : '') + '> 入站账号认证</label>' +
            '<label style="font-size:12.5px">用户名 <input class="adm-input" id="v2AuthUser" style="width:150px" value="' +
                ADM.esc(sst.socks_user || '') + '" autocomplete="off"></label>' +
            '<label style="font-size:12.5px">密码 <input class="adm-input" id="v2AuthPass" type="password" style="width:180px" value="" placeholder="' +
                (st.has_pass ? '••••••（留空不修改）' : '可选') + '" autocomplete="new-password"></label>' +
            '<button class="adm-btn sm" data-v2act="pass-eye" title="显示 / 隐藏密码"><i class="bi bi-eye"></i></button>' +
            '<button class="adm-btn sm" data-v2act="pass-copy" title="复制密码"><i class="bi bi-clipboard"></i></button>' +
            '<button class="adm-btn sm" data-v2act="gen-auth" title="随机生成一组账号密码"><i class="bi bi-magic"></i> 自动生成</button>' +
            '</div>' +
            '<button class="adm-btn primary" data-v2act="save-settings"><i class="bi bi-check-lg"></i> 保存设置</button>' +
            '</div>' +
            '<div class="adm-hint" style="margin-top:10px">修改后点「保存设置」；端口 / 认证变更在下次连接时生效。监听 0.0.0.0（局域网可用）时后端会强制启用账号认证。</div>' +
            '</div>' }
    ], { key: 'v2adm-main' });

    el.innerHTML = html;
    v2admBind(el, st, nd, sb, subCount);
    ADM.mountTables(el);
    ADM.mountTabs(el);
}

/* ---------------- 节点 / 订阅表格 ---------------- */
/* 延迟徽章：带 data-pingfor 锚点，测速后可只替换这一格，整页不刷新、不抖动 */
function v2PingBadge(id, m) {
    var idA = ' data-pingfor="' + ADM.esc(id) + '"';
    if (!m || m.ping === undefined || m.ping === null) return '<span class="adm-hint"' + idA + '>未测</span>';
    if (m.ping < 0) return '<span class="adm-badge bad"' + idA + '>超时</span>';
    return '<span class="adm-badge ' + (m.ping < 150 ? 'ok' : (m.ping < 400 ? 'warn' : 'bad')) + '"' + idA + '>' +
        m.ping + ' ms</span>';
}

function v2admNodeTable(nd, metrics, activeId) {
    var cols = [
        { label: '节点', render: function (r) {
            return '<span class="adm-cell-strong">' + ADM.esc(r.name || r.server) + '</span>' +
                (String(r.id) === String(activeId) ? ' <span class="adm-badge ok">当前</span>' : '');
        } },
        { label: '协议', render: function (r) { return '<span class="adm-badge info">' + ADM.esc(r.proto || '-') + '</span>'; } },
        { label: '服务器', render: function (r) {
            return '<span class="adm-cell-mono">' + ADM.esc(r.server || '-') + ':' + ADM.esc(r.port || '') + '</span>';
        } },
        { label: '延迟', render: function (r) { return v2PingBadge(r.id, metrics[r.id]); } },
        { label: '操作', render: function (r) {
            return '<span style="display:inline-flex;align-items:center;gap:6px;white-space:nowrap">' +
                '<button class="adm-btn sm primary" data-v2conn="' + ADM.esc(r.id) + '"' +
                (String(r.id) === String(activeId) ? ' disabled' : '') + '><i class="bi bi-play"></i> 连接</button>' +
                '<button class="adm-btn sm" data-v2ping="' + ADM.esc(r.id) + '"><i class="bi bi-activity"></i> 测速</button>' +
                '<button class="adm-btn sm danger" data-v2del="' + ADM.esc(r.id) + '" data-name="' + ADM.esc(r.name || '') + '"><i class="bi bi-trash"></i></button>' +
                '</span>';
        } }
    ];
    return ADM.table(cols, nd.nodes || [], { key: 'v2adm-nodes', pageSize: 12 });
}

function v2admSubTable(sb, subCount) {
    var cols = [
        { label: '名称', render: function (r) { return '<span class="adm-cell-strong">' + ADM.esc(r.name || '-') + '</span>'; } },
        { label: '订阅地址', render: function (r) {
            return '<span class="adm-cell-mono" style="display:inline-block;max-width:340px;overflow:hidden;text-overflow:ellipsis;vertical-align:bottom;white-space:nowrap" title="' +
                ADM.esc(r.url || '') + '">' + ADM.esc(r.url || '-') + '</span>';
        } },
        { label: '状态', render: function (r) {
            return r.enabled ? '<span class="adm-badge ok">启用</span>' : '<span class="adm-badge mute">停用</span>';
        } },
        { label: '节点数', render: function (r) { return subCount[r.id] || 0; } },
        { label: '操作', render: function (r) {
            return '<span style="display:inline-flex;align-items:center;gap:6px;white-space:nowrap">' +
                '<button class="adm-btn sm" data-v2subrefresh="' + ADM.esc(r.id) + '"><i class="bi bi-cloud-download"></i> 刷新</button>' +
                '<button class="adm-btn sm" data-v2subedit="' + ADM.esc(r.id) + '"><i class="bi bi-pencil"></i> 编辑</button>' +
                '<button class="adm-btn sm danger" data-v2subdel="' + ADM.esc(r.id) + '" data-name="' + ADM.esc(r.name || '') + '"><i class="bi bi-trash"></i></button>' +
                '</span>';
        } }
    ];
    return ADM.table(cols, sb.subs || [], { key: 'v2adm-subs', pageSize: 10 });
}

/* ---------------- 事件绑定 ----------------
 * 表格行由 ADM.mountTables() 异步渲染、翻页/排序会重建 DOM，
 * 所以不能用「逐按钮 addEventListener」（渲染前绑不到、翻页后失效）。
 * 这里在模块根 el 上做事件委托，每次渲染重挂一次（先移除旧的）。 */
function v2admBind(el, st, nd, sb, subCount) {
    var subsById = {};
    (sb.subs || []).forEach(function (s) { subsById[s.id] = s; });

    function reload() { ADM.render('v2ray'); }

    async function run(b, act) {
        try {
            if (act === 'disconnect') {
                await ADM.api('/api/v2ray/disconnect', { method: 'POST' });
                ADM.toast('已断开', 'ok'); reload();
            } else if (act === 'restart') {
                await ADM.api('/api/v2ray/restart', { method: 'POST' });
                ADM.toast('内核已重启', 'ok'); reload();
            } else if (act === 'exit-test') {
                b.disabled = true;
                var r = await ADM.api('/api/v2ray/exit-test', { method: 'POST' });
                b.disabled = false;
                var geo = r.geo || {};
                ADM.modal({
                    title: '代理出口测试', icon: 'bi-globe2', noOk: true,
                    html: '<div style="font-size:14px;line-height:2">出口 IP：<b>' + ADM.esc(r.ip || '-') + '</b><br>' +
                        '归属地：' + ADM.esc(geo.country || '-') + (geo.city ? ' ' + ADM.esc(geo.city) : '') + '<br>' +
                        '运营商：' + ADM.esc(geo.isp || '-') + '</div>'
                });
            } else if (act === 'log') {
                var lr = await ADM.api('/api/v2ray/log?lines=300');
                ADM.modal({
                    title: 'V2RAY 运行日志（末尾 300 行）', icon: 'bi-terminal', noOk: true, size: 'wide',
                    html: '<pre style="max-height:56vh;overflow:auto;font-size:12px;line-height:1.6;white-space:pre-wrap;word-break:break-all;margin:0">' +
                        ADM.esc(lr.log || '（空）') + '</pre>',
                    footer: '<button class="adm-btn sm danger" id="v2LogClear"><i class="bi bi-eraser"></i> 清空日志</button>'
                }).then(function () { });
                setTimeout(function () {
                    var cb = document.getElementById('v2LogClear');
                    if (cb) cb.addEventListener('click', async function () {
                        await ADM.api('/api/v2ray/log/clear', { method: 'POST' });
                        ADM.toast('日志已清空', 'ok');
                        cb.closest('.adm-modal-mask').remove();
                    });
                }, 0);
            } else if (act === 'reload') {
                reload();
            } else if (act === 'ping-all') {
                b.disabled = true;
                var ids = (nd.nodes || []).map(function (n) { return n.id; });
                for (var i = 0; i < ids.length; i += 200) {
                    var rb = await ADM.api('/api/v2ray/ping-batch', { method: 'POST', body: { ids: ids.slice(i, i + 200), real: true } });
                    var res = rb.results || {};
                    Object.keys(res).forEach(function (nid) {
                        var m = res[nid].ok ? { ping: res[nid].ms } : { ping: -1 };
                        nd.metrics[nid] = m;
                        patchPing(nid, m);      // 原地更新延迟徽章，不刷新整页
                    });
                }
                ADM.toast('测延迟完成（' + ids.length + ' 个节点）', 'ok');
                b.disabled = false;
            } else if (act === 'add-node') {
                v2admAddNodeModal();
            } else if (act === 'add-sub') {
                v2admSubModal(null);
            } else if (act === 'refresh-subs') {
                b.disabled = true;
                var rr = await ADM.api('/api/v2ray/subs/refresh', { method: 'POST', body: {} });
                ADM.toast('订阅刷新完成，新增/更新 ' + (rr.total || 0) + ' 个节点', 'ok'); reload();
            } else if (act === 'gen-auth') {
                var g = await ADM.api('/api/v2ray/gen-auth', { method: 'POST', body: {} });
                el.querySelector('#v2AuthUser').value = g.socks_user || '';
                el.querySelector('#v2AuthPass').value = g.socks_pass || '';
                el.querySelector('#v2Auth').checked = true;
                ADM.toast('已生成账号密码，请点「保存设置」', 'ok');
            } else if (act === 'pass-eye' || act === 'pass-copy') {
                var pIn = el.querySelector('#v2AuthPass');
                if (!pIn.value) {          // 输入框为空时先回填已保存的密码明文
                    var gp = await ADM.api('/api/v2ray/get-pass', { method: 'POST', body: {} });
                    if (!gp.socks_pass) { ADM.toast('尚未设置密码', 'warn'); return; }
                    pIn.value = gp.socks_pass;
                }
                if (act === 'pass-copy') { ADM.copy(pIn.value); return; }
                pIn.type = pIn.type === 'password' ? 'text' : 'password';
                var pic = b.querySelector('i');
                if (pic) pic.className = 'bi ' + (pIn.type === 'password' ? 'bi-eye' : 'bi-eye-slash');
            } else if (act === 'save-settings') {
                b.disabled = true;
                var body = {
                    socks_port: el.querySelector('#v2SocksPort').value,
                    http_port: el.querySelector('#v2HttpPort').value,
                    socks_listen: el.querySelector('#v2Listen').value,
                    auto_start: el.querySelector('#v2AutoStart').checked,
                    auth_enabled: el.querySelector('#v2Auth').checked,
                    socks_user: el.querySelector('#v2AuthUser').value.trim()
                };
                var pw = el.querySelector('#v2AuthPass').value;
                if (pw) body.socks_pass = pw;   // 留空 = 沿用已保存的密码
                await ADM.api('/api/v2ray/settings', { method: 'POST', body: body });
                await ADM.api('/api/v2ray/auto-failover', {
                    method: 'POST', body: { on: el.querySelector('#v2Failover').checked }
                });
                ADM.toast('设置已保存', 'ok'); reload();
            }
        } catch (e) {
            b.disabled = false;
            ADM.toast((e && e.message) || String(e), 'err');
        }
    }

    async function conn(b) {
        b.disabled = true;
        try {
            await ADM.api('/api/v2ray/connect', { method: 'POST', body: { id: b.dataset.v2conn } });
            ADM.toast('已连接', 'ok'); reload();
        } catch (e) { b.disabled = false; ADM.toast((e && e.message) || String(e), 'err'); }
    }

    /* 把某个节点的延迟徽章原地替换（当前页可见的行，跨页/搜索隐藏时等下次渲染生效） */
    function patchPing(id, m) {
        var html = v2PingBadge(id, m);
        el.querySelectorAll('[data-pingfor="' + id + '"]').forEach(function (s) { s.outerHTML = html; });
    }

    async function ping(b) {
        b.disabled = true;
        try {
            // 真延迟：临时切到该节点经代理实测出网，端口通但账号不可用时判失败
            var r = await ADM.api('/api/v2ray/ping', { method: 'POST', body: { id: b.dataset.v2ping, real: true } });
            var m = r.ok ? { ping: r.ms } : { ping: -1 };
            nd.metrics[b.dataset.v2ping] = m;   // 同步回内存数据，排序/翻页后仍正确
            patchPing(b.dataset.v2ping, m);
            ADM.toast(r.ok ? ('可用，真延迟 ' + r.ms + ' ms') : ('节点不可用：' + (r.error || '未知')), r.ok ? 'ok' : 'err');
        } catch (e) { ADM.toast((e && e.message) || String(e), 'err'); }
        b.disabled = false;
    }

    async function delNode(b) {
        var ok = await ADM.confirm('删除节点',
            '确定删除节点「' + ADM.esc(b.dataset.name) + '」？该操作不可恢复。', '删除');
        if (!ok) return;
        await ADM.api('/api/v2ray/nodes/delete', { method: 'POST', body: { ids: [b.dataset.v2del] } });
        ADM.toast('节点已删除', 'ok'); reload();
    }

    async function subRefresh(b) {
        b.disabled = true;
        try {
            var rr = await ADM.api('/api/v2ray/subs/refresh', { method: 'POST', body: { id: b.dataset.v2subrefresh } });
            var r0 = (rr.results || [])[0] || {};
            ADM.toast(r0.ok ? ('已更新 ' + (r0.count || 0) + ' 个节点') : ('刷新失败：' + (r0.error || '')), r0.ok ? 'ok' : 'err');
            reload();
        } catch (e) { b.disabled = false; ADM.toast((e && e.message) || String(e), 'err'); }
    }

    async function subDel(b) {
        var ok = await ADM.confirm('删除订阅',
            '删除订阅「' + ADM.esc(b.dataset.name) + '」会同时删除其下所有节点，确定？', '删除订阅');
        if (!ok) return;
        await ADM.api('/api/v2ray/subs/delete', { method: 'POST', body: { id: b.dataset.v2subdel, confirm: true } });
        ADM.toast('订阅已删除', 'ok'); reload();
    }

    if (el._v2admClick) el.removeEventListener('click', el._v2admClick);
    el._v2admClick = function (e) {
        var b = e.target.closest('[data-v2act],[data-v2conn],[data-v2ping],[data-v2del],[data-v2subrefresh],[data-v2subedit],[data-v2subdel]');
        if (!b || !el.contains(b) || b.disabled) return;
        var d = b.dataset;
        if (d.v2act) run(b, d.v2act);
        else if (d.v2conn !== undefined) conn(b);
        else if (d.v2ping !== undefined) ping(b);
        else if (d.v2del !== undefined) delNode(b);
        else if (d.v2subrefresh !== undefined) subRefresh(b);
        else if (d.v2subedit !== undefined) v2admSubModal(subsById[d.v2subedit]);
        else if (d.v2subdel !== undefined) subDel(b);
    };
    el.addEventListener('click', el._v2admClick);
}

/* ---------------- 弹窗：添加节点（分享链接） ---------------- */
function v2admAddNodeModal() {
    ADM.modal({
        title: '添加节点（粘贴分享链接）', icon: 'bi-diagram-3', okText: '添加',
        html: '<textarea class="adm-input" id="v2NodeLinks" rows="6" style="width:100%;font-family:monospace;font-size:12px" ' +
            'placeholder="每行一条 vmess:// / vless:// / trojan:// / ss:// 链接，支持批量"></textarea>' +
            '<div class="adm-hint" style="margin-top:8px">也可在 IDE 侧栏「V2RAY 代理」里通过订阅自动拉取节点。</div>',
        onOk: async function (box) {
            var links = box.querySelector('#v2NodeLinks').value.trim();
            if (!links) { ADM.toast('请先粘贴分享链接', 'warn'); return false; }
            var r = await ADM.api('/api/v2ray/nodes/add', { method: 'POST', body: { links: links } });
            var msg = '已添加 ' + (r.added || 0) + ' 个节点' + ((r.errors || []).length ? '，' + r.errors.length + ' 条解析失败' : '');
            ADM.toast(msg, (r.added || 0) ? 'ok' : 'warn');
            ADM.render('v2ray');
            return true;
        }
    });
}

/* ---------------- 弹窗：新建 / 编辑订阅 ---------------- */
function v2admSubModal(sub) {
    sub = sub || {};
    ADM.modal({
        title: sub.id ? '编辑订阅' : '添加订阅', icon: 'bi-rss', okText: '保存',
        html:
            '<label style="display:block;font-size:12.5px;margin-bottom:10px">名称' +
            '<input class="adm-input" id="v2SubName" style="width:100%;margin-top:4px" value="' + ADM.esc(sub.name || '') + '" placeholder="例如 机场 A"></label>' +
            '<label style="display:block;font-size:12.5px;margin-bottom:10px">订阅地址（URL）' +
            '<input class="adm-input" id="v2SubUrl" style="width:100%;margin-top:4px;font-family:monospace;font-size:12px" value="' +
            ADM.esc(sub.url || '') + '" placeholder="https://…"></label>' +
            '<label class="adm-switch" style="font-size:12.5px"><input type="checkbox" id="v2SubEnabled"' +
            (sub.id ? (sub.enabled ? ' checked' : '') : ' checked') + '> 启用（刷新全部订阅时参与拉取）</label>',
        onOk: async function (box) {
            var url = box.querySelector('#v2SubUrl').value.trim();
            if (!url) { ADM.toast('订阅地址不能为空', 'warn'); return false; }
            await ADM.api('/api/v2ray/subs/save', {
                method: 'POST',
                body: {
                    id: sub.id || '', name: box.querySelector('#v2SubName').value.trim() || '订阅',
                    url: url, enabled: box.querySelector('#v2SubEnabled').checked
                }
            });
            ADM.toast('订阅已保存', 'ok');
            ADM.render('v2ray');
            return true;
        }
    });
}

/* ---------------- 实时网速轮询（离开页面自动停止） ---------------- */
function v2admPoll(el) {
    var speedEl = el.querySelector('#v2admSpeed');
    if (!speedEl) return;
    var timer = setInterval(async function () {
        if (!el.isConnected) { clearInterval(timer); return; }
        try {
            var t = await ADM.api('/api/v2ray/traffic');
            var target = el.querySelector('#v2admSpeed');
            if (!target) { clearInterval(timer); return; }
            target.innerHTML = '<i class="bi bi-arrow-up"></i> ' + ADM.bytes(t.speed ? t.speed.up : 0) + '/s　' +
                '<i class="bi bi-arrow-down"></i> ' + ADM.bytes(t.speed ? t.speed.down : 0) + '/s';
        } catch (e) { /* 状态接口暂时不可用：静默跳过本轮 */ }
    }, 3000);
}

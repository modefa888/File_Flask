/* 后台管理：文件分享链接管理（复用 /api/shares）。 */
ADM.modules.push({
    id: 'shares',
    name: '分享管理',
    subtitle: '分享链接、有效期与访问量',
    icon: 'bi-share',
    async load(el) {
        el.innerHTML = ADM.loading('加载分享列表…');
        await refreshShares(el);
    }
});

function shareStateBadge(state) {
    var map = {
        ok: ['有效', 'ok'], expired: ['已过期', 'warn'], exhausted: ['次数用尽', 'warn'],
        revoked: ['已取消', 'mute']
    };
    var it = map[state] || [state || '-', 'mute'];
    return ADM.badge(it[0], it[1]);
}

async function refreshShares(el) {
    /* 顶部统计（失败不阻塞列表） */
    var sum = {};
    try { sum = (await ADM.api('/api/shares?include_revoked=1&page=1&page_size=1')).summary || {}; } catch (e) { }

    /* sortKey = 该列排序时传给后端的字段名（后端按 ?sort= 排序；无 sortKey 的列不可排序） */
    var shareCols = [
        { label: '文件', sortKey: 'name', render: function (r) { return '<span class="adm-cell-strong">' + ADM.esc(r.name) + '</span>'; } },
        { label: '大小', sortKey: 'size', render: function (r) { return ADM.esc(r.size_str); } },
        { label: '状态', sortKey: 'state', render: function (r) { return shareStateBadge(r.state); } },
        { label: '访问量', sortKey: 'views', render: function (r) { return (r.views || 0) + ' / ' + (r.max_views || '∞'); } },
        { label: '有效期', sortKey: 'expires_at', render: function (r) { return ADM.esc(r.expires_str); } },
        { label: '创建', sortKey: 'created_at', render: function (r) { return ADM.esc(r.created_str); } },
        { label: '最近访问', sortKey: 'last_view_at', render: function (r) { return ADM.esc(r.last_view_str); } },
        {
            label: '操作', render: function (r) {
                var id = r.id, token = ADM.esc(r.token);
                var copy = '<button class="adm-btn sm" data-act="copy" data-url="' + ADM.esc(r.full_url) + '"><i class="bi bi-link-45deg"></i> 复制</button>';
                var open = '<a class="adm-btn sm" href="' + ADM.esc(r.url) + '" target="_blank"><i class="bi bi-box-arrow-up-right"></i></a>';
                var edit = '<button class="adm-btn sm" data-act="edit" data-id="' + id + '"><i class="bi bi-sliders"></i> 修改配置</button>';
                var revoke = r.revoked ? '' : '<button class="adm-btn sm" data-act="revoke" data-id="' + id + '">取消</button>';
                var del = '<button class="adm-btn sm danger" data-act="del" data-id="' + id + '" data-token="' + token + '">删除</button>';
                return '<div class="adm-btn-row">' + copy + open + edit + revoke + del + '</div>';
            }
        }
    ];
    /* ---- 分享总览 ---- */
    var html = '<div class="adm-section">' + ADM.sectionHead('bi-graph-up', '分享总览',
        '<span class="adm-hint">数据来源：store.db（shares 表）</span>') + '<div class="adm-stat-grid">';
    html += ADM.stat('bi-share', '分享总数', sum.total || 0,
        '有效中 ' + (sum.active || 0) + ' · 已取消 ' + (sum.revoked || 0));
    html += ADM.stat('bi-check-circle', '有效中', sum.active || 0, '可正常访问');
    html += ADM.stat('bi-hourglass-split', '已失效', sum.expired || 0, '过期或次数用尽');
    if (sum.revoked) html += ADM.stat('bi-slash-circle', '已取消', sum.revoked, '手动取消分享');
    html += ADM.stat('bi-eye', '累计浏览', sum.views || 0, '所有分享的访问次数合计');
    html += '</div></div>';

    html += '<div class="adm-section">';
    html += ADM.sectionHead('bi-share', '分享链接');
    html += ADM.servTable(shareCols, {
        key: 'shares',
        actionsWidth: 360,
        sortable: true,                       // 点击表头 → 后端按 sortKey 字段排序
        fetch: function (p) {
            return ADM.api('/api/shares?include_revoked=1&q=' + encodeURIComponent(p.q) +
                '&page=' + p.page + '&page_size=' + p.size +
                (p.sort ? '&sort=' + encodeURIComponent(p.sort) + '&order=' + encodeURIComponent(p.order) : ''));
        },
        onRender: function (host) { bindShareEvents(host, el); }
    });
    html += '<div class="adm-hint" style="margin-top:10px">点击表头可按该列排序（再点一次切换升 / 降序）。</div>';
    html += '</div>';
    el.innerHTML = html;
    ADM.mountServTables(el);
}

/* 行内按钮绑定（分页切换后由 onRender 重新调用） */
function bindShareEvents(host, el) {
    host.querySelectorAll('[data-act]').forEach(function (btn) {
        btn.addEventListener('click', function () { handleShareAction(el, btn); });
    });
}

async function handleShareAction(el, btn) {
    var act = btn.dataset.act;
    if (act === 'copy') {
        ADM.copy(btn.dataset.url || '');
    } else if (act === 'edit') {
        var row = await ADM.api('/api/share?id=' + encodeURIComponent(btn.dataset.id));
        if (row && row.item) openShareConfig(el, row.item);
    } else if (act === 'revoke') {
        var ok = await ADM.confirm('取消分享', '取消后该链接立即失效（记录会保留在历史里）。', '取消分享');
        if (!ok) return;
        await ADM.api('/api/share/update', { method: 'POST', body: { id: Number(btn.dataset.id), revoked: true } });
        ADM.toast('分享已取消', 'ok');
        await refreshShares(el);
    } else if (act === 'del') {
        var ok2 = await ADM.confirm('删除分享记录', '确认彻底删除该分享记录？外部链接将无法再访问。', '删除');
        if (!ok2) return;
        await ADM.api('/api/share', { method: 'DELETE', body: { id: Number(btn.dataset.id) } });
        ADM.toast('分享记录已删除', 'ok');
        await refreshShares(el);
    }
}

/* 修改分享配置：访问密码 / 有效期 / 次数上限 / 备注 / 重置计数 */
async function openShareConfig(el, r) {
    var views = r.views || 0;
    var html =
        '<div class="adm-hint" style="margin-bottom:12px">文件：' + ADM.esc(r.name) +
        '　密码：' + (r.has_password ? '已设置' : '未设置') + '</div>' +
        ADM.fieldHtml({
            name: 'new_pwd', label: '新访问密码', type: 'password',
            placeholder: '留空表示不修改', hint: '填写后将替换原有密码'
        }) +
        '<label class="adm-switch" style="margin-bottom:14px"><input type="checkbox" name="clear_pwd"> 清除访问密码（任何人可访问）</label>' +
        ADM.fieldHtml({
            name: 'expires_in', label: '有效期', type: 'select', value: '', options: [
                { value: '', label: '保持不变' },
                { value: '1h', label: '1 小时' },
                { value: '1d', label: '1 天' },
                { value: '7d', label: '7 天' },
                { value: '30d', label: '30 天' },
                { value: 'forever', label: '永久有效' }
            ],
            hint: '当前：' + (r.expires_str || '永久有效')
        }) +
        ADM.fieldHtml({
            name: 'max_views', label: '访问次数上限', type: 'number', value: r.max_views || 0,
            hint: '0 = 不限制；当前已访问 ' + views + ' 次'
        }) +
        ADM.fieldHtml({ name: 'note', label: '备注', value: r.note || '' }) +
        '<label class="adm-switch"><input type="checkbox" name="reset_views"> 重置访问计数（' + views + ' 次 → 0）</label>';

    await ADM.modal({
        title: '修改分享配置',
        icon: 'bi-sliders',
        okText: '保存',
        html: html,
        onOk: async function (box) {
            var v = ADM.readForm(box);
            var body = { id: r.id, note: v.note, max_views: Number(v.max_views || 0) };
            if (v.clear_pwd) body.password = '';
            else if (v.new_pwd) body.password = v.new_pwd;
            if (v.expires_in) body.expires_in = v.expires_in;   // 空 = 保持不变，不提交该字段
            if (v.reset_views) body.reset_views = true;
            await ADM.api('/api/share/update', { method: 'POST', body: body });
            ADM.toast('分享配置已更新', 'ok');
            await refreshShares(el);
            return true;
        }
    });
}

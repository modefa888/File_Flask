/* 后台管理：用户账号管理。 */
ADM.modules.push({
    id: 'users',
    name: '用户管理',
    subtitle: '账号、角色、密码与封禁',
    icon: 'bi-people',
    async load(el) {
        el.innerHTML = ADM.loading('加载用户列表…');
        await refreshUsers(el);
    }
});

async function refreshUsers(el) {
    /* 顶部统计：失败不阻塞列表 */
    var sum = {};
    try { sum = (await ADM.api('/api/adm/users/summary')).summary || {}; } catch (e) { }
    var userCols = [
        {
            label: '用户名', sortKey: 'username', render: function (r) {
                var self = (r.username === ADM.user);
                return '<span class="adm-cell-strong">' + ADM.esc(r.username) + '</span>' +
                    (self ? ' ' + ADM.badge('当前账号', 'info') : '');
            }
        },
        {
            label: '角色', sortKey: 'role', render: function (r) {
                return r.role === 'admin' ? ADM.badge('管理员', 'info') : ADM.badge('协作者', 'mute');
            }
        },
        {
            label: '状态', sortKey: 'banned', render: function (r) {
                return r.banned ? ADM.badge('已封禁', 'bad') : ADM.badge('正常', 'ok');
            }
        },
        { label: '创建时间', sortKey: 'created', render: function (r) { return ADM.dt(r.created); } },
        {
            // 最近一次成功登录（0 = 从未登录过，比如刚建号还没用过）
            label: '最近登录时间', sortKey: 'last_login', render: function (r) {
                return r.last_login
                    ? ADM.dt(r.last_login)
                    : '<span class="adm-hint">从未登录</span>';
            }
        },
        {
            // 最近一次调用的接口：太长时用 title 悬浮看全，列宽不撑破
            label: '最后使用接口', sortable: false, render: function (r) {
                if (!r.last_api) return '<span class="adm-hint">-</span>';
                return '<span class="adm-cell-mono" title="' + ADM.esc(r.last_api) + '">' +
                    ADM.esc(r.last_api) + '</span>';
            }
        },
        {
            label: '最后使用时间', sortKey: 'last_api_at', render: function (r) {
                return r.last_api_at
                    ? ADM.dt(r.last_api_at)
                    : '<span class="adm-hint">-</span>';
            }
        },
        {
            label: '操作', sortable: false, render: function (r) {
                var name = ADM.esc(r.username);
                var self = (r.username === ADM.user);
                var pwd = '<button class="adm-btn sm" data-act="pwd" data-name="' + name + '">重置密码</button>';
                // 当前登录账号：不允许改自己的角色 / 删除 / 封禁（后端同样有校验）
                if (self) {
                    return '<div class="adm-btn-row">' + pwd +
                        '<span class="adm-hint" style="align-self:center">当前账号不可降级 / 删除 / 封禁</span></div>';
                }
                var roleBtn = r.role === 'admin'
                    ? '<button class="adm-btn sm" data-act="role" data-name="' + name + '" data-role="member">降为协作者</button>'
                    : '<button class="adm-btn sm" data-act="role" data-name="' + name + '" data-role="admin">设为管理员</button>';
                var banBtn = r.banned
                    ? '<button class="adm-btn sm" data-act="unban" data-name="' + name + '">解封</button>'
                    : '<button class="adm-btn sm warn" data-act="ban" data-name="' + name + '">封禁</button>';
                return '<div class="adm-btn-row">' + roleBtn + pwd + banBtn +
                    '<button class="adm-btn sm danger" data-act="del" data-name="' + name + '">删除</button></div>';
            }
        }
    ];
    /* ---- 用户总览（样式与接口模块的「接口总览」一致） ---- */
    var html = '<div class="adm-section">' + ADM.sectionHead('bi-graph-up', '用户总览',
        '<span class="adm-hint">数据来源：store.db（users 表）</span>') + '<div class="adm-stat-grid">';
    html += ADM.stat('bi-people', '用户总数', sum.total || 0,
        '管理员 ' + (sum.admins || 0) + ' · 协作者 ' + (sum.members || 0));
    html += ADM.stat('bi-person-badge', '管理员', sum.admins || 0, '全部权限（含后台管理）');
    html += ADM.stat('bi-person', '协作者', sum.members || 0, '仅协作编辑');
    html += ADM.stat('bi-unlock', '正常账号', sum.normal || 0, '可正常登录');
    if (sum.banned) html += ADM.stat('bi-lock', '已封禁', sum.banned, '禁止登录');
    html += ADM.stat('bi-person-plus', '近 7 天新增', sum.recent || 0, '新建与注册的账号');
    html += '</div></div>';

    html += '<div class="adm-section">';
    html += ADM.sectionHead('bi-people', '用户账号',
        '<button class="adm-btn primary" id="admAddUser" type="button"><i class="bi bi-person-plus"></i> 新建用户</button>');
    html += ADM.servTable(userCols, {
        key: 'users',
        actionsWidth: 400,
        sortable: true,                       // 点击表头 → 后端按 sortKey 字段排序
        fetch: function (p) {
            return ADM.api('/api/adm/users?q=' + encodeURIComponent(p.q) +
                '&page=' + p.page + '&page_size=' + p.size +
                (p.sort ? '&sort=' + encodeURIComponent(p.sort) + '&order=' + encodeURIComponent(p.order) : ''))
                .then(function (r) { return { items: r.users || [], total: r.total || 0 }; });
        },
        onRender: function (host) { bindUserEvents(host, el); }
    });
    html += '<div class="adm-hint" style="margin-top:10px">点击表头可按该列排序（再点一次切换升 / 降序）。默认管理员账号及当前登录账号不可降级 / 删除 / 封禁，系统始终保留至少一个管理员。封禁后该账号将无法登录。「最近登录时间 / 最后使用接口 / 最后使用时间」由该账号自己的登录与接口调用自动更新（只统计成功的 API 请求），从本次升级后开始记录。</div>';
    html += '</div>';
    el.innerHTML = html;
    ADM.mountServTables(el);
    var addBtn = el.querySelector('#admAddUser');
    if (addBtn) addBtn.addEventListener('click', function () { openUserDialog(el); });
}

/* 行内按钮绑定（分页切换后由 onRender 重新调用） */
function bindUserEvents(host, el) {
    host.querySelectorAll('[data-act]').forEach(function (btn) {
        btn.addEventListener('click', function () { handleUserAction(el, btn); });
    });
}

async function handleUserAction(el, btn) {
    var name = btn.dataset.name, act = btn.dataset.act;
    if (act === 'role') {
        var target = btn.dataset.role;
        var ok = await ADM.confirm('修改角色', '确认将用户「' + ADM.esc(name) + '」的角色调整为「' +
            (target === 'admin' ? '管理员' : '协作者') + '」？', '确认修改');
        if (!ok) return;
        await ADM.api('/api/adm/users/update', { method: 'POST', body: { username: name, role: target } });
        ADM.toast('角色已更新', 'ok');
        await refreshUsers(el);
    } else if (act === 'pwd') {
        // 修改自己账号的密码：需先输入当前（旧）密码；重置他人密码则无需旧密码
        var isSelf = (name === ADM.user);
        var fields =
            (isSelf ? ADM.fieldHtml({ name: 'old_password', label: '当前密码', type: 'password', placeholder: '请输入现在的密码' }) : '') +
            ADM.fieldHtml({ name: 'password', label: '新密码', type: 'password', placeholder: '至少 6 位' }) +
            ADM.fieldHtml({ name: 'confirm', label: '确认新密码', type: 'password', placeholder: '再输入一次新密码',
                hint: '成功后该账号的旧登录状态将全部失效' });
        await ADM.modal({
            title: (isSelf ? '修改密码' : '重置密码') + ' · ' + name,
            icon: 'bi-key',
            html: fields,
            okText: isSelf ? '确认修改' : '重置密码',
            onOk: async function (box) {
                var v = ADM.readForm(box);
                if (isSelf && !v.old_password) throw new Error('请输入当前密码');
                if (!v.password || v.password.length < 6) throw new Error('密码至少 6 位');
                if (v.password !== v.confirm) throw new Error('两次输入的新密码不一致');
                if (v.old_password && v.password === v.old_password) throw new Error('新密码不能与当前密码相同');
                var body = { username: name, password: v.password, confirm: v.confirm };
                if (isSelf) body.old_password = v.old_password;
                await ADM.api('/api/adm/users/update', { method: 'POST', body: body });
                ADM.toast(isSelf ? '密码已修改，旧登录状态已失效' : '密码已重置，该用户旧登录状态已失效', 'ok');
                return true;
            }
        });
    } else if (act === 'ban' || act === 'unban') {
        var isBan = (act === 'ban');
        var ok2 = await ADM.confirm(isBan ? '封禁账号' : '解封账号',
            isBan
                ? '确认封禁用户「' + ADM.esc(name) + '」？封禁后该账号将无法登录（已登录的会话在下次请求时失效）。'
                : '确认解除用户「' + ADM.esc(name) + '」的封禁，恢复登录能力？',
            isBan ? '封禁' : '解封');
        if (!ok2) return;
        await ADM.api('/api/adm/users/ban', { method: 'POST', body: { username: name, banned: isBan } });
        ADM.toast(isBan ? '账号已封禁' : '账号已解封', 'ok');
        await refreshUsers(el);
    } else if (act === 'del') {
        var ok3 = await ADM.confirm('删除用户', '确认永久删除用户「' + ADM.esc(name) + '」？该操作不可恢复。', '删除');
        if (!ok3) return;
        await ADM.api('/api/adm/users/delete', { method: 'POST', body: { username: name } });
        ADM.toast('用户已删除', 'ok');
        await refreshUsers(el);
    }
}

function openUserDialog(el) {
    ADM.modal({
        title: '新建用户',
        icon: 'bi-person-plus',
        html:
            ADM.fieldHtml({ name: 'username', label: '用户名', placeholder: '2-32 位中文、字母、数字或下划线' }) +
            ADM.fieldHtml({ name: 'password', label: '密码', type: 'password', placeholder: '至少 6 位' }) +
            ADM.fieldHtml({ name: 'role', label: '角色', type: 'select', value: 'member', options: [
                { value: 'member', label: '协作者（仅协作编辑）' },
                { value: 'admin', label: '管理员（全部权限）' }
            ] }),
        okText: '创建',
        onOk: async function (box) {
            var v = ADM.readForm(box);
            if (!v.username) throw new Error('请填写用户名');
            if (!v.password || v.password.length < 6) throw new Error('密码至少 6 位');
            await ADM.api('/api/adm/users', { method: 'POST', body: v });
            ADM.toast('用户已创建', 'ok');
            await refreshUsers(el);
            return true;
        }
    });
}

/* 后台管理：数据库连接 + SSH 连接（复用各自业务接口）。 */

/* ---------------- 数据库连接 ---------------- */
ADM.modules.push({
    id: 'db',
    name: '数据库连接',
    subtitle: '已保存的数据库连接',
    icon: 'bi-database',
    async load(el) {
        el.innerHTML = ADM.loading('加载数据库连接…');
        var dbTotal = 0;
        try { dbTotal = (await ADM.api('/api/db/conns?page=1&page_size=1')).total || 0; } catch (e) { }
        var dbCols = [
            { label: '名称', render: function (r) { return '<span class="adm-cell-strong">' + ADM.esc(r.name) + '</span>'; } },
            { label: '类型', render: function (r) { return ADM.badge(r.kind, 'info'); } },
            { label: '地址', render: function (r) { return ADM.esc(r.host || '-') + (r.port ? ':' + r.port : ''); } },
            { label: '库 / 文件', render: function (r) { return '<span class="adm-cell-mono" title="' + ADM.esc(r.dbname) + '">' + ADM.esc(r.dbname || '-') + '</span>'; } },
            { label: '用户', render: function (r) { return ADM.esc(r.username || '-'); } },
            { label: '密码', render: function (r) { return r.has_password ? ADM.badge('已保存', 'ok') : ADM.badge('无', 'mute'); } },
            {
                label: '操作', render: function (r) {
                    var id = ADM.esc(r.id);
                    return '<div class="adm-btn-row">' +
                        '<button class="adm-btn sm" data-act="test" data-id="' + id + '">测试</button>' +
                        '<button class="adm-btn sm danger" data-act="del" data-id="' + id + '" data-name="' + ADM.esc(r.name) + '">删除</button></div>';
                }
            }
        ];
        var html = '<div class="adm-section">' + ADM.sectionHead('bi-graph-up', '连接总览',
            '<span class="adm-hint">数据来源：store.db（db_conns 表）</span>') + '<div class="adm-stat-grid">';
        html += ADM.stat('bi-database', '数据库连接', dbTotal, '密码已加密存储，仅展示状态');
        html += '</div></div>';
        html += '<div class="adm-section">' + ADM.sectionHead('bi-database', '数据库连接',
            '<span class="adm-hint" id="dbCount"></span>');
        html += ADM.servTable(dbCols, {
            key: 'db-conns',
            fetch: function (p) {
                return ADM.api('/api/db/conns?q=' + encodeURIComponent(p.q) +
                    '&page=' + p.page + '&page_size=' + p.size)
                    .then(function (r) { return { items: r.conns || [], total: r.total || 0 }; });
            },
            onRender: function (host, last) {
                var c = el.querySelector('#dbCount');
                if (c) c.textContent = '共 ' + (last.total || 0) + ' 条（密码已加密存储，此处仅展示状态）';
                bindDbEvents(host);
            }
        });
        html += '<div class="adm-hint" style="margin-top:10px">新增 / 编辑连接、浏览表与执行 SQL 请前往 IDE 的「数据库」面板。</div>';
        html += '</div>';
        el.innerHTML = html;
        ADM.mountServTables(el);
    }
});

/* 行内按钮绑定（分页切换后由 onRender 重新调用） */
function bindDbEvents(host) {
    host.querySelectorAll('[data-act]').forEach(function (btn) {
        btn.addEventListener('click', async function () {
            var id = btn.dataset.id, act = btn.dataset.act;
            if (act === 'test') {
                btn.disabled = true;
                try {
                    var r = await ADM.api('/api/db/test', { method: 'POST', body: { id: id } });
                    if (r.ok) ADM.toast('连接成功：' + (r.version || '') + ' (' + (r.elapsed_ms || 0) + 'ms)', 'ok');
                    else ADM.toast(r.error || '连接失败', 'err');
                } catch (e) { ADM.toast(e.message, 'err'); }
                finally { btn.disabled = false; }
            } else if (act === 'del') {
                var ok = await ADM.confirm('删除数据库连接', '确认删除连接配置「' + ADM.esc(btn.dataset.name) + '」？不会影响数据库本身。', '删除');
                if (!ok) return;
                await ADM.api('/api/db/conns/delete', { method: 'POST', body: { id: id } });
                ADM.toast('已删除', 'ok');
                ADM.reload();
            }
        });
    });
}

/* ---------------- SSH 连接 ---------------- */
ADM.modules.push({
    id: 'ssh',
    name: 'SSH 连接',
    subtitle: '远程主机连接（密码 / 私钥已加密）',
    icon: 'bi-terminal-fill',
    async load(el) {
        el.innerHTML = ADM.loading('加载 SSH 连接…');
        var sum = {};
        try { sum = await ADM.api('/api/ssh/list?page=1&page_size=1'); } catch (e) { }
        var sshCols = [
            { label: '名称', render: function (r) { return '<span class="adm-cell-strong">' + ADM.esc(r.name) + '</span>'; } },
            { label: '主机', render: function (r) { return ADM.esc(r.host) + ':' + (r.port || 22); } },
            { label: '用户', render: function (r) { return ADM.esc(r.user || '-'); } },
            { label: '认证', render: function (r) { return r.auth === 'key' ? ADM.badge('私钥', 'info') : ADM.badge('密码', 'mute'); } },
            { label: '备注', render: function (r) { return ADM.esc(r.remark || '-'); } },
            { label: '凭据', render: function (r) { return (r.hasPassword || r.hasKey) ? ADM.badge('已保存', 'ok') : ADM.badge('无', 'warn'); } },
            {
                label: '操作', render: function (r) {
                    var id = ADM.esc(r.id);
                    return '<div class="adm-btn-row">' +
                        '<button class="adm-btn sm" data-act="test" data-id="' + id + '">测试</button>' +
                        '<button class="adm-btn sm danger" data-act="del" data-id="' + id + '" data-name="' + ADM.esc(r.name) + '">删除</button></div>';
                }
            }
        ];
        var html = '<div class="adm-section">' + ADM.sectionHead('bi-graph-up', '连接总览',
            '<span class="adm-hint">数据来源：data/.ssh_connections.json</span>') + '<div class="adm-stat-grid">';
        html += ADM.stat('bi-terminal-fill', 'SSH 连接', sum.total || 0, '密码 / 私钥已加密存储');
        html += ADM.stat('bi-plug', 'paramiko', sum.paramiko ? '可用' : '未安装',
            sum.paramiko ? '远程建连依赖正常' : '安装后才能建立 SSH 连接');
        html += '</div></div>';
        html += '<div class="adm-section">' + ADM.sectionHead('bi-terminal-fill', 'SSH 连接',
            '<span class="adm-hint" id="sshInfo"></span>');
        html += ADM.servTable(sshCols, {
            key: 'ssh-conns',
            fetch: function (p) {
                return ADM.api('/api/ssh/list?q=' + encodeURIComponent(p.q) +
                    '&page=' + p.page + '&page_size=' + p.size)
                    .then(function (r) {
                        var c = el.querySelector('#sshInfo');
                        if (c) c.textContent = r.paramiko ? 'paramiko 可用' : '未安装 paramiko，无法建连';
                        return { items: r.connections || [], total: r.total || 0 };
                    });
            },
            onRender: function (host) { bindSshEvents(host); }
        });
        html += '</div>';
        el.innerHTML = html;
        ADM.mountServTables(el);
    }
});

/* 行内按钮绑定（分页切换后由 onRender 重新调用） */
function bindSshEvents(host) {
    host.querySelectorAll('[data-act]').forEach(function (btn) {
        btn.addEventListener('click', async function () {
            var id = btn.dataset.id, act = btn.dataset.act;
            if (act === 'test') {
                btn.disabled = true;
                try {
                    var r = await ADM.api('/api/ssh/test', { method: 'POST', body: { id: id } });
                    if (r.ok) ADM.toast('连通性正常', 'ok');
                    else ADM.toast(r.error || '连接失败', 'err');
                } catch (e) { ADM.toast(e.message, 'err'); }
                finally { btn.disabled = false; }
            } else if (act === 'del') {
                var ok = await ADM.confirm('删除 SSH 连接', '确认删除连接「' + ADM.esc(btn.dataset.name) + '」？', '删除');
                if (!ok) return;
                await ADM.api('/api/ssh/delete', { method: 'POST', body: { id: id } });
                ADM.toast('已删除', 'ok');
                ADM.reload();
            }
        });
    });
}

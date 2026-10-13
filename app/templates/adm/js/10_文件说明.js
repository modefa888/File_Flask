/* 后台管理：文件说明（自定义，复用 /api/file_hints）。 */
ADM.modules.push({
    id: 'hints',
    name: '文件说明',
    subtitle: '为文件 / 文件夹补充自定义说明',
    icon: 'bi-info-circle',
    async load(el) {
        el.innerHTML = ADM.loading('加载文件说明…');
        await refreshHints(el);
    }
});

async function refreshHints(el) {
    /* 顶部统计（失败不阻塞列表） */
    var total = 0;
    try { total = (await ADM.api('/api/file_hints/list?page=1&page_size=1')).total || 0; } catch (e) { }

    var hintCols = [
        { label: '名称（文件 / 文件夹名）', render: function (r) { return '<span class="adm-cell-strong">' + ADM.esc(r.name) + '</span>'; } },
        { label: '说明', render: function (r) { return ADM.esc(r.hint); } },
        {
            label: '操作', render: function (r) {
                var n = ADM.esc(r.name);
                return '<div class="adm-btn-row">' +
                    '<button class="adm-btn sm" data-act="edit" data-name="' + n + '">编辑</button>' +
                    '<button class="adm-btn sm danger" data-act="del" data-name="' + n + '">删除</button></div>';
            }
        }
    ];
    /* ---- 说明总览 ---- */
    var html = '<div class="adm-section">' + ADM.sectionHead('bi-graph-up', '说明总览',
        '<span class="adm-hint">数据来源：store.db（file_hints 表）</span>') + '<div class="adm-stat-grid">';
    html += ADM.stat('bi-info-circle', '自定义说明', total, '与内置说明合并展示，自定义优先');
    html += '</div></div>';

    html += '<div class="adm-section">';
    html += ADM.sectionHead('bi-info-circle', '自定义文件说明',
        '<div class="adm-btn-row"><span class="adm-hint" id="hintCount" style="align-self:center"></span>' +
        '<button class="adm-btn primary" id="admAddHint" type="button"><i class="bi bi-plus-lg"></i> 新增说明</button></div>');
    html += ADM.servTable(hintCols, {
        key: 'file-hints',
        fetch: function (p) {
            return ADM.api('/api/file_hints/list?q=' + encodeURIComponent(p.q) +
                '&page=' + p.page + '&page_size=' + p.size)
                .then(function (r) {
                    var c = el.querySelector('#hintCount');
                    if (c) c.textContent = '共 ' + (r.total || 0) + ' 条';
                    return { items: r.items || [], total: r.total || 0 };
                });
        },
        onRender: function (host) { bindHintEvents(host, el); }
    });
    html += '<div class="adm-hint" style="margin-top:10px">这里保存的是界面补充的说明，会与内置说明合并展示（自定义优先）。</div>';
    html += '</div>';
    el.innerHTML = html;
    ADM.mountServTables(el);

    var addBtn = el.querySelector('#admAddHint');
    if (addBtn) addBtn.addEventListener('click', function () { hintDialog(el, '', ''); });
}

/* 行内按钮绑定（分页切换后由 onRender 重新调用） */
function bindHintEvents(host, el) {
    host.querySelectorAll('[data-act]').forEach(function (b) {
        b.addEventListener('click', async function () {
            var name = b.dataset.name;
            if (b.dataset.act === 'edit') {
                var st = ADM._servTables['file-hints'];
                var row = (st && st.last && st.last.items || []).filter(function (x) { return x.name === name; })[0];
                hintDialog(el, name, row ? (row.hint || '') : '');
            } else {
                var ok = await ADM.confirm('删除说明', '确认删除「' + ADM.esc(name) + '」的自定义说明？', '删除');
                if (!ok) return;
                await ADM.api('/api/file_hints?name=' + encodeURIComponent(name), { method: 'DELETE' });
                ADM.toast('已删除', 'ok');
                await refreshHints(el);
            }
        });
    });
}

function hintDialog(el, name, hint) {
    ADM.modal({
        title: name ? ('编辑说明 · ' + name) : '新增文件说明',
        icon: 'bi-info-circle',
        html: ADM.fieldHtml({ name: 'name', label: '文件 / 文件夹名', value: name, placeholder: '如 package.json 或 src' }) +
            ADM.fieldHtml({ name: 'hint', label: '说明内容', type: 'textarea', value: hint }),
        okText: '保存',
        onOk: async function (box) {
            var v = ADM.readForm(box);
            if (!v.name) throw new Error('请填写名称');
            await ADM.api('/api/file_hints', { method: 'POST', body: { name: v.name, hint: v.hint } });
            ADM.toast('已保存', 'ok');
            await refreshHints(el);
            return true;
        }
    });
}

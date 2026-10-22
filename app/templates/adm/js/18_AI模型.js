/* 后台管理：AI 模型 —— 接口（提供商）与模型清单，支持增删改与切换默认模型。
 * 读写都走 /api/ai/config（与 IDE「设置 → AI 助手」同一份 store.db 配置），
 * 保存时 API Key 留空 = 沿用旧值（后端按 id 回填，不会把脱敏串写进库）。 */
ADM.modules.push({
    id: 'aimodels',
    name: 'AI 模型',
    subtitle: 'AI 接口 / 模型清单与各模块使用的模型',
    icon: 'bi-cpu',
    async load(el) {
        AIM.el = el;
        await aimRefresh();
    }
});

var AIM = { el: null, cfg: null };

/* ---------------- 数据 ---------------- */
async function aimRefresh() {
    var el = AIM.el;
    if (!el) return;
    el.innerHTML = ADM.loading('加载 AI 模型清单…');
    var cfg = null, err = '';
    try {
        cfg = await ADM.api('/api/ai/config');
    } catch (e) {
        err = (e && e.message) || String(e);
    }
    AIM.cfg = cfg;
    aimRender(err);
}

async function aimSave(body) {
    try {
        await ADM.api('/api/ai/config', { method: 'POST', body: body });
        ADM.toast('已保存', 'ok');
        await aimRefresh();
        return true;
    } catch (e) {
        ADM.toast((e && e.message) || String(e), 'err');
        return false;
    }
}

/* 提交前把接口列表规整成后端要的形状：只有被编辑的那个带明文 key，其余一律空串（= 沿用旧值） */
function aimPayload(list, keyById) {
    return list.map(function (p) {
        return {
            id: p.id, name: p.name, base_url: p.base_url, models: p.models || [],
            api_key: (keyById || {})[p.id] || ""
        };
    });
}

function aimNextPid() {
    var n = 1;
    (AIM.cfg.providers || []).forEach(function (p) {
        var m = /^p(\d+)$/.exec(String(p.id || ""));
        if (m) n = Math.max(n, parseInt(m[1], 10) + 1);
    });
    return "p" + n;
}

/* ---------------- 渲染 ---------------- */
function aimRender(err) {
    var el = AIM.el;
    var cfg = AIM.cfg || {};
    var providers = cfg.providers || [];
    var active = cfg.active || {};
    var sys = cfg.sys || {};
    var off = sys.off || [];
    var rows = aiModelRows(cfg);
    var modelCount = rows.filter(function (r) { return !!r.model; }).length;

    var html = '';
    if (err) {
        html += '<div class="adm-section"><div class="adm-card" style="padding:14px 16px;color:#fca5a5">' +
            '读取 AI 配置失败：' + ADM.esc(err) + '</div></div>';
    }

    /* ---- 总览 ---- */
    html += '<div class="adm-section">' + ADM.sectionHead('bi-cpu', '模型总览',
        '<span class="adm-hint">数据来源：store.db（ai_providers / ai_models / ai_active）</span>') +
        '<div class="adm-stat-grid">';
    html += ADM.stat('bi-hdd-network', 'AI 接口', providers.length,
        providers.length ? '已配置的提供商' : '还没有配置接口');
    html += ADM.stat('bi-boxes', '模型', modelCount,
        active.model ? ('默认 ' + active.model) : '未选择默认模型');
    html += ADM.stat('bi-diagram-3', '在用模块', (function () {
        var s = {};
        rows.forEach(function (r) { r.usedBy.forEach(function (k) { s[k] = 1; }); });
        return Object.keys(s).length;
    })(), off.length ? ('已关闭 ' + off.length + ' 个') : '全部模块可用');
    html += ADM.stat('bi-slash-circle', '已关闭模块', off.length,
        off.length ? off.join('、') : '没有关闭任何模块');
    html += '</div></div>';

    /* ---- 接口 / 模型清单：Tab 切换（一屏只看一块，不再上下堆两张表） ---- */
    var tabItems = [
        {
            id: 'providers', name: 'AI 接口', icon: 'bi-hdd-network',
            content: '<div id="aimProviderHost"></div>' +
                '<div class="adm-hint" style="margin-top:10px">' +
                '「默认模型」下拉切换后立即保存，AI 助手面板用的就是这个；' +
                'API Key 编辑时留空表示保持原值（列表里显示的是脱敏后的样子）。' +
                '</div>'
        },
        {
            id: 'models', name: '模型清单', icon: 'bi-list-ul',
            content: '<div id="aimTableHost"></div>' +
                '<div class="adm-hint" style="margin-top:10px">' +
                '「用于」列：<b>AI 助手</b> 是默认模型，<b>系统默认</b> 是「系统 AI」的全局默认，' +
                '其余是各模块单独指定的模型；「未被使用」表示没有任何功能选它。' +
                '</div>'
        }
    ];
    html += '<div class="adm-section">' +
        ADM.sectionHead('bi-hdd-network', '接口与模型',
            '<button class="adm-btn sm primary" id="aimAddBtn" type="button">' +
            '<i class="bi bi-plus-lg"></i> 新增接口</button>') +
        ADM.tabs(tabItems, { key: 'aimtabs' }) +
        '</div>';

    el.innerHTML = html;
    ADM.mountTabs(el);          // 绑定切换（隐藏面板里的表格会在切换后自动重新测量）

    var addBtn = el.querySelector('#aimAddBtn');
    if (addBtn) addBtn.addEventListener('click', function () { aimOpenProvider(-1); });

    aimDrawProviders();
    aiDrawModelTable(rows);
}

/* 接口表格：名称 / 地址 / 模型 / 默认模型 / 操作 */
function aimDrawProviders() {
    var el = AIM.el;
    var host = el.querySelector('#aimProviderHost');
    if (!host) return;
    var providers = (AIM.cfg.providers || []);
    var active = (AIM.cfg.active || {});

    var cols = [
        {
            label: '接口',
            sortVal: function (r) { return r.name || ''; },
            render: function (r) {
                var s = '<span class="adm-cell-strong">' + ADM.esc(r.name) + '</span> ' +
                    ADM.badge(r.id, 'mute');
                if (active.provider === r.id) s += ' ' + ADM.badge('默认', 'ok');
                return s;
            }
        },
        {
            label: '接口地址',
            sortVal: function (r) { return r.base_url || ''; },
            render: function (r) {
                return r.base_url
                    ? '<span class="adm-cell-mono" title="' + ADM.esc(r.base_url) + '">' + ADM.esc(r.base_url) + '</span>'
                    : '<span class="adm-hint">未填写</span>';
            }
        },
        {
            label: '模型',
            sortable: false,
            render: function (r) {
                var ms = r.models || [];
                if (!ms.length) return '<span class="adm-hint">未配置</span>';
                return '<span class="adm-hint">' + ms.length + ' 个：</span>' +
                    ms.map(function (m) { return ADM.badge(m, 'mute'); }).join(' ');
            }
        },
        {
            label: '默认模型',
            sortable: false,
            render: function (r) {
                var ms = r.models || [];
                if (!ms.length) return '<span class="adm-hint">-</span>';
                var opts = ms.map(function (m) {
                    var on = (active.provider === r.id && active.model === m) ? ' selected' : '';
                    return '<option' + on + '>' + ADM.esc(m) + '</option>';
                }).join('');
                return '<select class="adm-select" data-aim-sel="' + ADM.esc(r.id) +
                    '" style="padding:3px 8px;font-size:12px;max-width:190px" title="选择后立即设为 AI 助手默认模型">' +
                    opts + '</select>';
            }
        },
        {
            label: '操作',
            sortable: false,
            render: function (r) {
                return '<div class="adm-btn-row">' +
                    '<button class="adm-btn sm" data-aim-edit="' + ADM.esc(r.id) + '">编辑</button>' +
                    '<button class="adm-btn sm danger" data-aim-del="' + ADM.esc(r.id) + '">删除</button>' +
                    '</div>';
            }
        }
    ];

    host.innerHTML = ADM.table(cols, providers.slice(), {
        key: 'aimproviders',
        pageSize: 20,
        empty: '还没有配置 AI 接口，点右上角「新增接口」添加',
        actionsWidth: 150
    });
    ADM.mountTables(host);

    host.querySelectorAll('[data-aim-edit]').forEach(function (b) {
        b.addEventListener('click', function () {
            var i = (AIM.cfg.providers || []).findIndex(function (p) { return p.id === b.dataset.aimEdit; });
            if (i >= 0) aimOpenProvider(i);
        });
    });
    host.querySelectorAll('[data-aim-del]').forEach(function (b) {
        b.addEventListener('click', function () { aimDeleteProvider(b.dataset.aimDel); });
    });
    host.querySelectorAll('[data-aim-sel]').forEach(function (s) {
        s.addEventListener('change', function () {
            aimSave({ active: { provider: s.dataset.aimSel, model: s.value } });
        });
    });
}

/* 模型清单（拍平后的只读表，搜索 / 排序走通用表格） */
function aiDrawModelTable(rows) {
    var host = AIM.el.querySelector('#aimTableHost');
    if (!host) return;
    var cols = [
        {
            label: '模型',
            sortVal: function (r) { return r.model || ''; },
            render: function (r) {
                if (!r.model) return '<span class="adm-hint">（接口未填模型）</span>';
                var s = '<span class="adm-cell-mono">' + ADM.esc(r.model) + '</span>';
                if (r.current) s += ' ' + ADM.badge('当前', 'ok');
                return s;
            }
        },
        {
            label: '接口',
            sortVal: function (r) { return r.provider || ''; },
            render: function (r) {
                return '<span class="adm-cell-strong">' + ADM.esc(r.provider) + '</span> ' +
                    ADM.badge(r.pid, 'mute');
            }
        },
        {
            label: '接口地址',
            sortable: false,
            render: function (r) {
                return r.base_url
                    ? '<span class="adm-cell-mono" title="' + ADM.esc(r.base_url) + '">' + ADM.esc(r.base_url) + '</span>'
                    : '<span class="adm-hint">-</span>';
            }
        },
        {
            label: '用于',
            sortable: false,
            render: function (r) {
                if (!r.usedBy.length) return '<span class="adm-hint">未被使用</span>';
                return r.usedBy.map(function (k) {
                    var tone = k === 'AI 助手' ? 'ok' : (k === '系统默认' ? 'info' : 'mute');
                    return ADM.badge(k, tone);
                }).join(' ');
            }
        },
        {
            label: '操作',
            sortable: false,
            render: function (r) {
                var b = [];
                if (r.model) {
                    b.push('<button class="adm-btn sm ghost" data-copy="' + ADM.esc(r.model) +
                        '" title="复制模型名"><i class="bi bi-clipboard"></i></button>');
                }
                b.push('<button class="adm-btn sm ghost" data-usage="1" title="查看各模块调用量">' +
                    '<i class="bi bi-activity"></i></button>');
                return '<div class="adm-btn-row">' + b.join('') + '</div>';
            }
        }
    ];

    host.innerHTML = ADM.table(cols, rows, {
        key: 'aimodels',
        empty: '还没有配置模型，先在上面的「AI 接口」里编辑接口、填上模型列表',
        actionsWidth: 130
    });
    ADM.mountTables(host);

    host.querySelectorAll('[data-copy]').forEach(function (b) {
        b.addEventListener('click', function () { ADM.copy(b.dataset.copy); });
    });
    host.querySelectorAll('[data-usage]').forEach(function (b) {
        b.addEventListener('click', function () { ADM.render('aiusage'); });
    });
}

/* 把「接口 × 模型」拍平：标注谁在用它（AI 助手 / 系统默认 / 各模块） */
function aiModelRows(cfg) {
    var providers = (cfg && cfg.providers) || [];
    var active = (cfg && cfg.active) || {};
    var sys = (cfg && cfg.sys) || {};
    var per = sys.per_module || {};
    var off = sys.off || [];
    var rows = [];
    providers.forEach(function (p) {
        var models = (p.models || []).slice();
        if (!models.length) models.push('');
        models.forEach(function (m) {
            var usedBy = [];
            if (m) {
                if (active.provider === p.id && active.model === m) usedBy.push('AI 助手');
                if (sys.model && sys.model === m && (!sys.provider || sys.provider === p.id)) usedBy.push('系统默认');
                Object.keys(per).forEach(function (k) {
                    var v = per[k] || {};
                    if (!v.model || v.model !== m) return;
                    if (v.provider && v.provider !== p.id) return;
                    if (off.indexOf(k) >= 0) return;
                    usedBy.push(k);
                });
            }
            rows.push({
                model: m, provider: p.name || p.id, pid: p.id,
                base_url: p.base_url || "", usedBy: usedBy,
                current: !!(m && active.provider === p.id && active.model === m)
            });
        });
    });
    return rows;
}

/* ---------------- 增 / 改 / 删 ---------------- */
function aimOpenProvider(idx) {
    var list = (AIM.cfg.providers || []);
    var cur = idx >= 0 ? list[idx] : { id: "", name: "", base_url: "", api_key: "", models: [] };
    var isNew = idx < 0;
    ADM.modal({
        title: (isNew ? '新增' : '编辑') + ' AI 接口',
        icon: 'bi-hdd-network',
        okText: '保存',
        html:
            '<div class="adm-form">' +
            '<div class="adm-field"><label>名称</label>' +
            '<input class="adm-input" id="aimName" value="' + ADM.esc(cur.name) +
            '" placeholder="例如 sensenova / 本地 Ollama" spellcheck="false"></div>' +
            '<div class="adm-field"><label>接口地址</label>' +
            '<input class="adm-input" id="aimBase" value="' + ADM.esc(cur.base_url) +
            '" placeholder="https://token.sensenova.cn/v1" spellcheck="false"></div>' +
            '<div class="adm-field"><label>API Key</label>' +
            '<input class="adm-input" id="aimKey" value="" spellcheck="false" ' +
            'placeholder="' + (isNew ? 'sk-…（必填）' : ADM.esc(cur.api_key || '') + '（留空保持不变）') + '"></div>' +
            '<div class="adm-field"><label>模型列表</label>' +
            '<textarea class="adm-textarea" id="aimModels" rows="6" spellcheck="false" ' +
            'placeholder="一行一个，或用逗号分隔">' +
            ADM.esc((cur.models || []).join('\n')) + '</textarea></div>' +
            '<div class="adm-hint">接口地址一般填到 <code>/v1</code>（不带 <code>/chat/completions</code>）；' +
            '模型名一行一个。保存后可以在列表里选一个作为默认模型。</div>' +
            '</div>',
        onOk: async function (box) {
            var name = (box.querySelector('#aimName').value || '').trim();
            var base = (box.querySelector('#aimBase').value || '').trim();
            var key = (box.querySelector('#aimKey').value || '').trim();
            var models = (box.querySelector('#aimModels').value || '')
                .replace(/，/g, ',').split(/[\n,]/).map(function (x) { return x.trim(); })
                .filter(Boolean);
            if (!name) { ADM.toast('请填写接口名称', 'warn'); return false; }
            if (!base) { ADM.toast('请填写接口地址', 'warn'); return false; }
            if (!models.length) { ADM.toast('至少填一个模型名', 'warn'); return false; }
            if (isNew && !key) { ADM.toast('新接口必须填 API Key', 'warn'); return false; }

            var pid = cur.id || aimNextPid();
            var out = list.slice();
            var item = { id: pid, name: name, base_url: base, models: models };
            var keys = {};
            if (key) keys[pid] = key;                 // 只有真的改了才传，留空沿用旧值
            if (isNew) out.push(item);
            else out[idx] = item;
            return await aimSave({ providers: aimPayload(out, keys) });
        }
    });
}

async function aimDeleteProvider(pid) {
    var list = (AIM.cfg.providers || []);
    var p = list.find(function (x) { return x.id === pid; });
    if (!p) return;
    if (list.length <= 1) {
        ADM.toast('至少要保留一个接口，不能删除最后一个', 'warn');
        return;
    }
    var ok = await ADM.confirm('删除 AI 接口',
        '删除「' + ADM.esc(p.name) + '」及它的 ' + (p.models || []).length + ' 个模型？<br>' +
        '<span class="adm-hint">如果它是默认接口，删除后会自动回退到其它接口。</span>', '删除');
    if (!ok) return;
    var out = list.filter(function (x) { return x.id !== pid; });
    await aimSave({ providers: aimPayload(out) });
}

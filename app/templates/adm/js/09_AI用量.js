/* 后台管理：AI 调用用量（复用 /api/ai/usage*）。 */
ADM.modules.push({
    id: 'aiusage',
    name: 'AI 用量',
    subtitle: '各模块调用次数与 token 统计',
    icon: 'bi-activity',
    async load(el) {
        el.innerHTML = ADM.loading('加载 AI 用量…');
        await refreshAiUsage(el);
    }
});

async function refreshAiUsage(el) {
    /* 顶部统计（与列表同源，取一次全量汇总；失败不阻塞列表） */
    var sum = {};
    try {
        var s = await ADM.api('/api/ai/usage/list?page=1&page_size=1');
        sum = { ok: s.total_ok || 0, fail: s.total_fail || 0, modules: s.total || 0,
            tin: s.tokens_in || 0, tout: s.tokens_out || 0 };
    } catch (e) { }
    var calls = (sum.ok || 0) + (sum.fail || 0);
    var pct = function (n) { return calls ? Math.round((n || 0) / calls * 100) + '%' : '暂无调用'; };

    var aiCols = [
        { label: '模块', render: function (r) { return '<span class="adm-cell-strong">' + ADM.esc(r.module) + '</span>'; } },
        { label: '成功', render: function (r) { return '<span style="color:#6ee7b7">' + r.ok + '</span>'; } },
        { label: '失败', render: function (r) { return r.fail ? '<span style="color:#fca5a5">' + r.fail + '</span>' : '0'; } },
        { label: 'Token', render: function (r) { return '入 ' + r.tokens_in + ' / 出 ' + r.tokens_out; } },
        { label: '最近耗时', render: function (r) { return r.last_ms ? r.last_ms + ' ms' : '-'; } },
        { label: '最近错误', render: function (r) { return ADM.esc(r.last_error || '-'); } },
        {
            label: '操作', render: function (r) {
                return '<button class="adm-btn sm" data-mod="' + ADM.esc(r.module) + '">明细</button>';
            }
        }
    ];
    /* ---- 用量总览（样式与其他模块统计卡一致） ---- */
    var html = '<div class="adm-section">' + ADM.sectionHead('bi-graph-up', '用量总览',
        '<span class="adm-hint">数据来源：store.db（ai_usage / ai_calls）</span>') + '<div class="adm-stat-grid">';
    html += ADM.stat('bi-activity', '累计调用', calls,
        '成功 ' + (sum.ok || 0) + ' · 失败 ' + (sum.fail || 0));
    html += ADM.stat('bi-check-circle', '成功调用', sum.ok || 0, '占比 ' + pct(sum.ok));
    html += ADM.stat('bi-x-circle', '失败调用', sum.fail || 0,
        calls ? ('失败率 ' + pct(sum.fail)) : '暂无调用');
    html += ADM.stat('bi-hash', 'Token 输入', sum.tin || 0, '输出 ' + (sum.tout || 0));
    html += ADM.stat('bi-collection', '调用模块', sum.modules || 0, '表内点「明细」查看单模块');
    html += '</div></div>';

    html += '<div class="adm-section">';
    html += ADM.sectionHead('bi-activity', 'AI 调用用量',
        '<div class="adm-btn-row"><span class="adm-hint" id="aiCount" style="align-self:center"></span>' +
        '<button class="adm-btn sm ghost" id="admAiClear" type="button"><i class="bi bi-eraser"></i> 清空统计</button></div>');
    html += ADM.servTable(aiCols, {
        key: 'ai-usage',
        fetch: function (p) {
            return ADM.api('/api/ai/usage/list?q=' + encodeURIComponent(p.q) +
                '&page=' + p.page + '&page_size=' + p.size);
        },
        onRender: function (host, last) {
            var c = el.querySelector('#aiCount');
            if (c) c.textContent = '成功 ' + (last.total_ok || 0) + ' · 失败 ' + (last.total_fail || 0);
            bindUsageEvents(host);
        }
    });
    html += '</div>';
    el.innerHTML = html;
    ADM.mountServTables(el);

    var clearBtn = el.querySelector('#admAiClear');
    if (clearBtn) clearBtn.addEventListener('click', async function () {
        var ok = await ADM.confirm('清空 AI 统计', '确认清空所有 AI 调用统计与明细？', '清空');
        if (!ok) return;
        await ADM.api('/api/ai/usage', { method: 'DELETE' });
        ADM.toast('已清空', 'ok');
        await refreshAiUsage(el);
    });
}

/* 行内按钮绑定（分页切换后由 onRender 重新调用） */
function bindUsageEvents(host) {
    host.querySelectorAll('[data-mod]').forEach(function (b) {
        b.addEventListener('click', function () { openAiDetail(b.dataset.mod); });
    });
}

async function openAiDetail(module) {
    var data = await ADM.api('/api/ai/usage/detail?module=' + encodeURIComponent(module) + '&limit=50');
    var days = data.days || [], calls = data.calls || [];

    var daysContent = ADM.table([
        { label: '日期', render: function (r) { return ADM.esc(r.day); } },
        { label: '成功', render: function (r) { return r.ok; } },
        { label: '失败', render: function (r) { return r.fail; } },
        { label: 'Token', render: function (r) { return '入 ' + r.tokens_in + ' / 出 ' + r.tokens_out; } }
    ], days, { key: 'ai-days', reset: true, pageSize: 10 });

    var callsContent = ADM.table([
        { label: '时间', render: function (r) { return ADM.esc(r.ts); } },
        { label: '结果', render: function (r) { return r.ok ? ADM.badge('成功', 'ok') : ADM.badge('失败', 'bad'); } },
        { label: '模型', render: function (r) { return ADM.esc(r.model || '-'); } },
        { label: '耗时', render: function (r) { return (r.ms || 0) + ' ms'; } },
        { label: '请求摘要', render: function (r) { return '<span class="adm-cell-mono" title="' + ADM.esc(r.req) + '">' + ADM.esc(r.req || '-') + '</span>'; } }
    ], calls, { key: 'ai-calls', reset: true, pageSize: 10 });

    var html = '<div class="adm-hint" style="margin-bottom:12px">模块：' + ADM.esc(module) +
        ' · 累计 Token 入 ' + (data.tokens_in || 0) + ' / 出 ' + (data.tokens_out || 0) + '</div>';
    html += ADM.tabs([
        { id: 'days', name: '最近 7 天（' + days.length + '）', icon: 'bi-calendar3', content: daysContent },
        { id: 'calls', name: '最近调用（' + calls.length + '）', icon: 'bi-list-ul', content: callsContent }
    ], { key: 'ai-detail-tabs' });

    await ADM.modal({ title: 'AI 调用明细 · ' + module, icon: 'bi-activity', size: 'big', noOk: true, cancelText: '关闭', html: html });
}

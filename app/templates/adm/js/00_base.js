/* 后台管理：基础框架（工具函数 / 请求封装 / 表格 / 弹窗 / Toast）。 */
var ADM = window.ADM = {
    user: window.ADM_USER || '',
    modules: [],
    current: null,
    _tables: {},          // 分页表格状态：key -> {cols, rows, page, size, sizes, empty, onRender}
    _tableSeq: 0,
    _tabs: {},            // Tab 状态：key -> {items, active}
    _tabSeq: 0,
    ACTIONS_WIDTH: 320,   // 「操作」列预留宽度（px）：保证按钮增减时列宽不变，杜绝抖动

    /* ---------------- 请求 ---------------- */
    api: async function (url, opts) {
        opts = opts || {};
        var init = { method: opts.method || 'GET', headers: {} };
        if (opts.form) {
            init.body = opts.form;                    // FormData：交给浏览器设置 Content-Type
        } else if (opts.body !== undefined && opts.body !== null) {
            init.headers['Content-Type'] = 'application/json';
            init.body = JSON.stringify(opts.body);
        }
        var res;
        try {
            res = await fetch(url, init);
        } catch (e) {
            throw new Error('网络请求失败：' + (e && e.message ? e.message : e));
        }
        if (res.status === 401) {
            location.href = '/login?next=/admin';
            throw new Error('登录已过期，请重新登录');
        }
        var text = await res.text();
        var data = {};
        if (text) {
            try {
                data = JSON.parse(text);
            } catch (e) {
                data = { raw: text };
            }
        }
        // 首次运行的初始密码未修改：后端一律 403，直接跳到改密页
        if (res.status === 403 && data && data.password_change_required) {
            location.href = '/change-password';
            throw new Error('请先修改初始密码');
        }
        if (!res.ok) {
            var msg = (data && (data.error || data.message)) || ('请求失败（HTTP ' + res.status + '）');
            throw new Error(msg);
        }
        return data;
    },

    /* ---------------- 格式化 ---------------- */
    esc: function (s) {
        return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    },

    bytes: function (n) {
        n = Number(n || 0);
        if (n < 1024) return n + ' B';
        var units = ['KB', 'MB', 'GB', 'TB', 'PB'];
        var i = -1;
        do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
        return n.toFixed(n >= 100 ? 0 : 1) + ' ' + units[i];
    },

    dt: function (ts) {
        if (!ts) return '-';
        var d = new Date(Number(ts) * 1000);
        if (isNaN(d.getTime())) return '-';
        var p = function (x) { return (x < 10 ? '0' : '') + x; };
        return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
            p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
    },

    tsText: function (s) {
        return s ? ADM.esc(s) : '-';
    },

    dur: function (sec) {
        sec = Math.max(0, Math.floor(Number(sec) || 0));
        if (sec < 60) return sec + ' 秒';
        var m = Math.floor(sec / 60), s = sec % 60;
        if (m < 60) return m + ' 分 ' + s + ' 秒';
        var h = Math.floor(m / 60); m = m % 60;
        if (h < 24) return h + ' 时 ' + m + ' 分';
        var d = Math.floor(h / 24); h = h % 24;
        return d + ' 天 ' + h + ' 时';
    },

    /* ---------------- 组件 ---------------- */
    badge: function (text, tone) {
        return '<span class="adm-badge ' + (tone || 'mute') + '">' + ADM.esc(text) + '</span>';
    },

    stat: function (icon, label, value, sub) {
        return '<div class="adm-stat">' +
            '<div class="adm-stat-top"><i class="bi ' + icon + '"></i>' + ADM.esc(label) + '</div>' +
            '<div class="adm-stat-val">' + (value === undefined || value === null ? '-' : value) + '</div>' +
            '<div class="adm-stat-sub">' + ADM.esc(sub || '') + '</div>' +
            '</div>';
    },

    loading: function (text) {
        return '<div class="adm-loading"><div class="adm-spinner"></div><div>' + ADM.esc(text || '加载中…') + '</div></div>';
    },

    table: function (cols, rows, opts) {
        opts = opts || {};
        var key = opts.key || ('adm_tbl_' + (++ADM._tableSeq));
        var prev = ADM._tables[key];
        var size = opts.pageSize || 10;
        var page = 1;
        // 默认保留上次所在页与每页条数（增删改后刷新不跳回第一页）；opts.reset 强制回到第一页
        if (prev && !opts.reset) {
            page = prev.page || 1;
            size = prev.size || size;
        }
        ADM._tables[key] = {
            cols: cols,
            rows: rows || [],
            page: page,
            size: size,
            sort: (prev && !opts.reset) ? (prev.sort || null) : null,  // 排序：{idx, dir}，点击表头切换
            q: (prev && !opts.reset) ? (prev.q || '') : '',   // 关键字搜索（刷新后保留）
            sizes: opts.sizes || [10, 20, 50, 100],
            empty: opts.empty || '暂无数据',
            onRender: opts.onRender || null,
            rowH: (prev && !opts.reset) ? (prev.rowH || 0) : 0,  // 单行实测高度（单调不缩，保证高度稳定）
            colW: (prev && !opts.reset) ? (prev.colW || null) : null,  // 冻结的列宽（避免内容变化抖动）
            actionsWidth: opts.actionsWidth || 0,                 // 操作列预留宽度（不传用全局默认）
            detail: opts.detail || null,                          // 可选：自定义行详情 (row) => HTML
            detailTitle: opts.detailTitle || null                 // 可选：自定义详情标题 (row) => 文本
        };
        return '<div class="adm-table-host" data-adm-table="' + key + '"></div>';
    },

    /* 只渲染「表头 + 数据行」部分（不含分页控件）。
     * widths 传入时用固定表格布局并锁定每列宽度（避免内容变化造成列宽抖动）。
     * sortOpt 传入时可点击表头排序：{active, dir, idOf}——idOf(col, idx) 返回该列的排序 id
     * （前端分页表用列下标，服务端分页表用后端字段名）；返回 null 表示该列不可排序。 */
    _tableHtml: function (cols, rows, empty, widths, sortOpt) {
        // 空数据：直接用固定高度的占位块，让空表与有数据的表看起来一样高
        if (!rows || !rows.length) {
            return '<div class="adm-table-wrap adm-table-empty">' + ADM.esc(empty || '暂无数据') + '</div>';
        }
        // 先渲染出每个单元格，便于识别「操作列」（含按钮 / 链接的列）
        var cells = rows.map(function (r, i) {
            return cols.map(function (c) {
                var v = c.render ? c.render(r, i) : ADM.esc(r[c.key]);
                return (v === null || v === undefined) ? '' : String(v);
            });
        });
        var isAct = cols.map(function (c, ci) {
            return cells.some(function (row) {
                return /adm-btn|data-act=|data-del=|data-log=|data-mod=/.test(row[ci]);
            });
        });

        var fixed = !!(widths && widths.length === cols.length);
        var html = '<div class="adm-table-wrap"><table class="adm-table' + (fixed ? ' adm-fixed' : '') + '"><thead><tr>';
        cols.forEach(function (c, ci) {
            var w = fixed && widths[ci] ? ' style="width:' + widths[ci] + 'px"' : '';
            // 排序表头：sortOpt 存在且该列可排序（未显式关闭 sortable，且有排序 id）
            var sid = (sortOpt && c.sortable !== false) ? sortOpt.idOf(c, ci) : null;
            var sortable = !!sid;
            var ind = '';
            if (sortable) {
                var on = (sortOpt.active === sid);
                ind = '<span class="adm-sort-ind' + (on ? ' on' : '') + '">' +
                    (on ? (sortOpt.dir === 'desc' ? '▼' : '▲') : '↕') + '</span>';
            }
            html += '<th class="' + (isAct[ci] ? 'adm-col-actions' : '') + (sortable ? ' adm-sortable' : '') + '"' +
                w + (sortable ? ' data-sort="' + ADM.esc(String(sid)) + '"' : '') + '>' +
                ADM.esc(c.label) + ind + '</th>';
        });
        html += '</tr></thead><tbody>';
        rows.forEach(function (r, i) {
            html += '<tr data-row="' + i + '">';
            cols.forEach(function (c, ci) {
                html += '<td class="' + (isAct[ci] ? 'adm-col-actions' : '') + '">' + cells[i][ci] + '</td>';
            });
            html += '</tr>';
        });
        html += '</tbody></table></div>';
        return html;
    },

    /* 首次渲染后测量各列宽度并冻结：
     * - 内容变化（如按钮增减、徽标文字变化）不再导致列宽重排 / 抖动；
     * - 操作列额外预留足够宽度，保证按钮增减时宽度不变。 */
    _freezeCols: function (host, st) {
        var table = host.querySelector('table');
        if (!table) return;
        var ths = table.querySelectorAll('thead th');
        if (!ths.length) return;
        var w = [];
        ths.forEach(function (th) { w.push(Math.round(th.offsetWidth)); });
        if (!w.length || w.some(function (x) { return !x; })) return;   // 隐藏状态量不到，等显示后再冻结

        var actIdx = -1;
        ths.forEach(function (th, i) { if (th.classList.contains('adm-col-actions')) actIdx = i; });
        if (actIdx >= 0) {
            w[actIdx] = Math.max(w[actIdx], st.actionsWidth || ADM.ACTIONS_WIDTH);
        }

        // 总宽超过可视宽度时，按比例压缩非操作列（避免出现横向滚动条），并保留最小可读宽度
        var wrap = host.querySelector('.adm-table-wrap');
        var avail = wrap ? (wrap.clientWidth - 2) : 0;
        if (avail > 0) {
            var total = w.reduce(function (a, b) { return a + b; }, 0);
            if (total > avail) {
                var actW = actIdx >= 0 ? w[actIdx] : 0;
                var others = total - actW;
                var allow = Math.max(0, avail - actW);
                if (others > 0 && allow > 0) {
                    var f = allow / others;
                    w = w.map(function (x, i) {
                        return (i === actIdx) ? x : Math.max(64, Math.round(x * f));
                    });
                }
            }
        }

        st.colW = w;
        table.classList.add('adm-fixed');
        ths.forEach(function (th, i) { if (w[i]) th.style.width = w[i] + 'px'; });
    },

    /* 渲染一个分页表格到 host 元素（由 mountTables 调用） */
    _renderTable: function (host, key, st) {
        // 关键字搜索：对所有列做不区分大小写的子串匹配（比对渲染后的纯文本）
        var rows = st.rows;
        if (st.q) {
            var _q = st.q.toLowerCase();
            rows = rows.filter(function (r) {
                return st.cols.some(function (c) {
                    var v = c.render ? c.render(r) : (r[c.key] == null ? '' : String(r[c.key]));
                    return String(v).replace(/<[^>]*>/g, ' ').toLowerCase().indexOf(_q) !== -1;
                });
            });
        }
        // 排序（点击表头）：数值列用 col.sortVal 返回数字，其余按渲染后的文本比较
        if (st.sort && st.cols[st.sort.idx]) {
            var _sc = st.cols[st.sort.idx];
            var _dir = st.sort.dir === 'desc' ? -1 : 1;
            var _sv = function (r) {
                if (_sc.sortVal) return _sc.sortVal(r);
                var v = _sc.render ? _sc.render(r) : (r[_sc.key] == null ? '' : r[_sc.key]);
                return String(v == null ? '' : v).replace(/<[^>]*>/g, ' ').trim();
            };
            rows = rows.slice().sort(function (a, b) {
                var x = _sv(a), y = _sv(b);
                if (typeof x === 'number' && typeof y === 'number') return (x - y) * _dir;
                return String(x).localeCompare(String(y), 'zh') * _dir;
            });
        }

        var total = rows.length;
        var size = st.size || 10;
        var pages = Math.max(1, Math.ceil(total / size));
        if (st.page > pages) st.page = pages;
        if (st.page < 1) st.page = 1;
        var page = st.page;
        var start = (page - 1) * size;
        var slice = rows.slice(start, start + size);
        // 每页条数下拉：把当前页长并入候选（如概览页用的 5/6 条）
        var sizes = st.sizes.slice();
        if (sizes.indexOf(size) === -1) sizes.push(size);
        sizes.sort(function (a, b) { return a - b; });

        var h = '<div class="adm-table-toolbar">' +
            '<input class="adm-input adm-table-search" type="search" placeholder="关键字搜索…" value="' +
            ADM.esc(st.q || '') + '" spellcheck="false">' +
            '<span class="adm-hint">共 <b>' + total + '</b> 条' +
            (total ? '，当前第 ' + (start + 1) + '-' + Math.min(start + size, total) + ' 条' : '') +
            '</span><span class="adm-spacer"></span><span class="adm-hint">每页</span>' +
            '<select class="adm-select adm-page-size">' +
            sizes.map(function (s) {
                return '<option value="' + s + '"' + (s === size ? ' selected' : '') + '>' + s + ' 条</option>';
            }).join('') + '</select></div>';

        // 始终传入 sortOpt：让「↕」占位从一开始就参与列宽测量，后续出现箭头时列宽不再变化
        h += ADM._tableHtml(st.cols, slice, st.empty, st.colW || null, {
            active: st.sort ? String(st.sort.idx) : null,
            dir: st.sort ? st.sort.dir : 'asc',
            idOf: function (c, ci) { return String(ci); }
        });

        if (pages > 1) {
            var from = Math.max(1, page - 2);
            var to = Math.min(pages, from + 4);
            from = Math.max(1, to - 4);
            h += '<div class="adm-pager">' +
                '<button class="adm-btn sm ghost" data-page="1"' + (page <= 1 ? ' disabled' : '') + '>首页</button>' +
                '<button class="adm-btn sm ghost" data-page="' + (page - 1) + '"' + (page <= 1 ? ' disabled' : '') + '>上一页</button>';
            for (var p = from; p <= to; p++) {
                h += '<button class="adm-btn sm ' + (p === page ? 'primary' : 'ghost') + '" data-page="' + p + '">' + p + '</button>';
            }
            h += '<button class="adm-btn sm ghost" data-page="' + (page + 1) + '"' + (page >= pages ? ' disabled' : '') + '>下一页</button>' +
                '<button class="adm-btn sm ghost" data-page="' + pages + '"' + (page >= pages ? ' disabled' : '') + '>末页</button>' +
                '<span class="adm-hint adm-page-info">第 ' + page + ' / ' + pages + ' 页</span>' +
                '<span class="adm-page-jump">跳至 <input class="adm-input adm-page-input" type="number" min="1" max="' +
                pages + '" value="' + page + '"> 页' +
                '<button class="adm-btn sm ghost" data-jump="1" type="button">跳转</button></span>' +
                '</div>';
        }

        host.innerHTML = h;

        // 首次渲染后测量并冻结列宽：之后无论内容怎么变（按钮增减、徽标文字变化），列宽都不再跳动
        if (!st.colW) ADM._freezeCols(host, st);

        // 表头点击排序：同列在 升序 / 降序 间切换，换列则从升序开始
        host.querySelectorAll('th[data-sort]').forEach(function (th) {
            th.addEventListener('click', function () {
                var idx = parseInt(th.dataset.sort, 10);
                if (isNaN(idx)) return;
                st.sort = (st.sort && st.sort.idx === idx)
                    ? { idx: idx, dir: st.sort.dir === 'asc' ? 'desc' : 'asc' }
                    : { idx: idx, dir: 'asc' };
                st.page = 1;
                ADM._renderTable(host, key, st);
            });
        });

        // 关键字搜索（防抖 250ms；重渲染后恢复焦点与光标位置）
        var searchInp = host.querySelector('.adm-table-search');
        if (searchInp) {
            var searchTimer = null;
            searchInp.addEventListener('input', function () {
                clearTimeout(searchTimer);
                searchTimer = setTimeout(function () {
                    st.q = searchInp.value.trim();
                    st.page = 1;
                    ADM._renderTable(host, key, st);
                    var ni = host.querySelector('.adm-table-search');
                    if (ni) {
                        ni.focus();
                        try { ni.setSelectionRange(ni.value.length, ni.value.length); } catch (_) {}
                    }
                }, 250);
            });
        }

        function goTo(p) {
            p = parseInt(p, 10);
            if (isNaN(p)) return;
            if (p < 1) p = 1;
            if (p > pages) p = pages;
            if (p === st.page) return;
            st.page = p;
            ADM._renderTable(host, key, st);
        }

        host.querySelectorAll('[data-page]').forEach(function (b) {
            b.addEventListener('click', function () { goTo(b.dataset.page); });
        });
        var jumpInput = host.querySelector('.adm-page-input');
        var jumpBtn = host.querySelector('[data-jump]');
        if (jumpBtn) jumpBtn.addEventListener('click', function () { if (jumpInput) goTo(jumpInput.value); });
        if (jumpInput) jumpInput.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') { e.preventDefault(); goTo(jumpInput.value); }
        });
        var sel = host.querySelector('.adm-page-size');
        if (sel) sel.addEventListener('change', function () {
            st.size = Math.max(1, parseInt(sel.value, 10) || 10);
            st.page = 1;
            ADM._renderTable(host, key, st);
        });

        // 点击整行 → 弹出该行信息（点行内按钮 / 链接时不触发）
        host.querySelectorAll('tbody tr[data-row]').forEach(function (tr) {
            tr.addEventListener('click', function (e) {
                if (e.target.closest('button, a, input, select, textarea, label')) return;
                var idx = start + parseInt(tr.dataset.row, 10);
                var row = st.rows[idx];
                if (row) ADM._rowInfo(row, st, tr);
            });
        });

        if (st.onRender) st.onRender(host);
        ADM._fitTable(host, st);
    },

    /* 表格视口固定为「FIT_ROWS 行」的高度：
     * - 每页 ≤FIT_ROWS 条时正好放下，不出现滚动条；
     * - 每页条数更大（20/50/100）时保持该高度，超出部分在区内滚动查看；
     * - 行少时也保留同样高度，底部分页条位置不跳动。
     * 隐藏（未选中的 Tab）时量不到尺寸，显示后再由 refitTables 重算。 */
    FIT_ROWS: 10,
    _fitTable: function (host, st) {
        var wrap = host.querySelector('.adm-table-wrap');
        if (!wrap) return;
        var table = wrap.querySelector('table');
        if (!table) {                      // 空态占位块：沿用已测算高度，否则交给 CSS 兜底
            wrap.style.height = st.rowH ? (38 + st.rowH * ADM.FIT_ROWS + 2) + 'px' : '';
            return;
        }
        var thead = wrap.querySelector('thead');
        var headH = thead ? thead.offsetHeight : 0;
        var rowH = 0;
        wrap.querySelectorAll('tbody tr').forEach(function (tr) {
            rowH = Math.max(rowH, tr.offsetHeight);
        });
        if (!headH || !rowH) return;       // 处于隐藏状态：量不到，等显示后重算
        st.rowH = Math.max(st.rowH || 0, rowH);

        var base = headH + st.rowH * ADM.FIT_ROWS;
        // 先按基础高度落一次，实测横向滚动条占用的高度：
        // 否则横向滚动条会挤掉接近一行的高度，导致 10 行时多出一条竖向滚动条。
        wrap.style.height = base + 'px';
        var bar = wrap.offsetHeight - wrap.clientHeight - 2;
        if (bar < 0) bar = 0;
        wrap.style.height = (base + 2 + bar) + 'px';
    },

    /* 重新适配 root 内所有表格高度（Tab 切换显示、窗口尺寸变化后调用） */
    refitTables: function (root) {
        (root || document).querySelectorAll('[data-adm-table]').forEach(function (host) {
            var st = ADM._tables[host.dataset.admTable];
            if (!st) return;
            if (!st.colW) ADM._freezeCols(host, st);   // 之前隐藏量不到列宽：显示后补冻结
            ADM._fitTable(host, st);
        });
    },

    /* ---------------- 行信息悬浮框 ---------------- */
    // 常见字段的中文标签（未收录的字段直接用原始键名）
    ROW_LABELS: {
        id: 'ID', name: '名称', path: '路径', target: '目标', command: '命令', cwd: '工作目录',
        cron: '调度表达式', next: '下次运行', enabled: '是否启用', running: '运行中', status: '状态',
        trigger: '触发方式', exit_code: '退出码', started_at: '开始时间', ended_at: '结束时间',
        start: '开始时间', end: '结束时间',
        duration: '耗时', attempt: '重试次序', log_path: '日志文件', log_size: '日志大小',
        task_id: '任务 ID', task_name: '任务名称', mode: '运行模式', pid: '进程 PID', orphan: '孤儿进程',
        promoted: '已转后台', timed_out: '已超时', stopped_by_user: '手动停止', paused: '已暂停',
        cpu: 'CPU(%)', mem: '内存', procs: '进程数', ports: '监听端口', lines: '日志行数',
        run_count: '运行次数', runs: '运行历史', last_status: '上次状态', last_at: '上次运行',
        last_ms: '上次耗时', last_exit: '上次退出码', ok_count: '成功次数', fail_count: '失败次数',
        max_retries: '最大重试', retry_interval: '重试间隔', depends_on: '依赖任务', pre_hook: '前置钩子',
        post_hook: '后置钩子', notify: '失败通知', remark: '备注', timeout: '超时(秒)',
        size: '大小', mtime: '修改时间', is_dir: '是否目录', views: '访问次数', max_views: '次数上限', revoked: '已取消',
        created_at: '创建时间', expires_at: '过期时间', last_view_at: '最近访问', note: '备注',
        token: '访问令牌', url: '访问地址', full_url: '完整地址', original_path: '原路径',
        trash_path: '回收站路径', deleted_at: '删除时间', exists: '回收站文件存在',
        kind: '类型', detail: '详情', time: '时间', module: '模块', ok: '成功', fail: '失败次数',
        model: '模型', ms: '耗时(ms)', tokens_in: 'Token 入', tokens_out: 'Token 出',
        req: '请求摘要', resp: '响应摘要', ts: '时间', est: 'Token 为估算', day: '日期', calls: '调用次数',
        last_error: '最近错误', channel: '渠道', title: '标题', body: '正文', channels: '通道状态',
        skipped: '跳过原因', run_id: '运行 ID', updated_at: '更新时间', installed_at: '安装时间',
        uninstalled_at: '卸载时间', sk: '跳过', percent: '占比', group_name: '分组', added: '添加时间',
        username: '用户名', role: '角色', created: '创建时间', banned: '是否封禁',
        host: '主机', port: '端口', user: '登录用户', auth: '认证方式', hasPassword: '有密码',
        hasKey: '有私钥', has_password: '有密码', password_masked: '密码(脱敏)', dbname: '库 / 文件',
        params: '连接参数', version: '版本', description: '描述', installed: '已安装', main: '入口文件',
        action: '动作', at: '时间', content: '内容', text: '内容', desc: '说明',
        label: '标签', icon: '图标', hint: '说明', value: '值', records: '记录', items: '条目',
        module_name: '所属模块', access: '访问级别', access_default: '默认级别',
        access_default_label: '默认级别', access_label: '访问级别', access_tone: '级别色调',
        access_override: '自定义级别', overridden: '是否改过权限', disabled: '是否停用',
        can_manage: '可管理', orphan: '已失效', rule: '路径规则', params: '路径参数',
        allowed: '角色允许情况', perm_override: '权限是否改过',
        total: '请求次数', last_status: '最近状态码',
        name: '名称', path: '路径', method: '方法', methods: '方法', endpoint: '端点',
        href: '预览地址', group: '分组', type: '类型', last_at: '最近访问'
    },
    rowLabel: function (k) {
        return ADM.ROW_LABELS[k] || k;
    },

    /* 时间类字段：形如 created_at / deleted_at / ts / time，以及运行记录的 start / end */
    _isTimeKey: function (k) {
        if (/^(start|end)$/i.test(k)) return true;
        return /(_at|_time|time|ts|created|deleted|opened)$/i.test(k) && !/(_str|_ms)$/i.test(k);
    },

    _rowVal: function (k, v) {
        if (v === null || v === undefined || v === '') return '<span class="adm-hint">-</span>';
        if (typeof v === 'boolean') return v ? ADM.badge('是', 'ok') : ADM.badge('否', 'mute');
        if (typeof v === 'object') {
            return '<code class="adm-rowjson">' + ADM.esc(JSON.stringify(v, null, 2)) + '</code>';
        }
        if (/^(size|log_size|mem|rss|trash_size)$/.test(k) && /^\d+$/.test(String(v))) {
            return ADM.bytes(v) + ' <span class="adm-hint">(' + ADM.esc(String(v)) + ' B)</span>';
        }
        if (k === 'ms') return ADM.esc(String(v)) + ' ms';
        // 秒级 / 毫秒级时间戳：同时给出可读时间与原始值
        if (ADM._isTimeKey(k) && /^\d{9,13}$/.test(String(v))) {
            var sec = String(v).length > 10 ? Math.floor(Number(v) / 1000) : Number(v);
            return ADM.dt(sec) + ' <span class="adm-hint">(' + ADM.esc(String(v)) + ')</span>';
        }
        return ADM.esc(String(v));
    },

    /* 弹出某一行信息；st.detail 可自定义内容；tr 用于复用该行「操作」列的动作按钮 */
    _rowInfo: function (row, st, tr) {
        var title = row.name || row.username || row.target || row.task_name || row.module || row.file || '详细信息';
        if (st && st.detailTitle) {
            try { title = st.detailTitle(row); } catch (e) { /* 忽略自定义标题异常 */ }
        }
        var html;
        if (st && st.detail) {
            try { html = st.detail(row); } catch (e) { html = ADM._rowInfoHtml(row); }
        } else {
            html = ADM._rowInfoHtml(row);
        }

        // 复用该行「操作」列里的按钮：同一套按钮在信息弹窗底部也能直接操作
        var actions = '';
        if (tr) {
            var tds = tr.querySelectorAll('td');
            for (var i = tds.length - 1; i >= 0; i--) {
                if (tds[i].querySelector('button, a')) { actions = tds[i].innerHTML; break; }
            }
        }

        ADM.modal({
            title: '行信息 · ' + title,
            icon: 'bi-info-circle',
            // 字段多时用两列排布，弹窗放宽一些以容纳两列
            size: Object.keys(row || {}).length >= ADM.ROWINFO_2COL_MIN ? 'wide' : '',
            noOk: true,
            cancelText: '关闭',
            html: html,
            footer: actions,
            onOpen: function (box, close) {
                var actHost = box.querySelector('.adm-modal-foot-left');
                if (!actHost) return;
                // 复用表格的行内事件绑定（靠 data-* 属性识别），使弹窗内的按钮同样可用
                if (st && st.onRender) {
                    try { st.onRender(actHost); } catch (e) { /* 绑定失败不影响查看信息 */ }
                }
                // 按钮自身的事件先执行（打开确认框 / 日志弹窗），随后再关掉信息弹窗
                actHost.addEventListener('click', function (ev) {
                    if (ev.target.closest('button, a')) close();
                });
            }
        });
    },

    /* 通用行详情：row 的全部字段按「标签 : 值」列出。
     * 字段较多（> 8 个）时自动改为两列排布，长内容（路径 / JSON 等）仍占满整行。 */
    ROWINFO_2COL_MIN: 9,
    _rowInfoHtml: function (row) {
        var keys = Object.keys(row || {});
        if (!keys.length) return '<div class="adm-hint">无字段信息</div>';
        var twoCol = keys.length >= ADM.ROWINFO_2COL_MIN;
        var h = '<div class="adm-rowinfo' + (twoCol ? ' two-col' : '') + '">';
        keys.forEach(function (k) {
            var v = row[k];
            var text = (v === null || v === undefined) ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
            var wide = (v !== null && typeof v === 'object') || text.length > 46;
            h += '<div class="adm-rowinfo-item' + (wide ? ' wide' : '') + '">' +
                '<div class="adm-rowinfo-k">' + ADM.esc(ADM.rowLabel(k)) + '</div>' +
                '<div class="adm-rowinfo-v">' + ADM._rowVal(k, v) + '</div>' +
                '</div>';
        });
        return h + '</div>';
    },

    /* 把 root 内所有分页表格宿主渲染出来（模块设置 innerHTML 后调用；弹窗由 modal 自动调用） */
    mountTables: function (root) {
        (root || document).querySelectorAll('[data-adm-table]').forEach(function (host) {
            var key = host.dataset.admTable;
            var st = ADM._tables[key];
            if (st) ADM._renderTable(host, key, st);
        });
    },

    /* ---------------- 服务端分页 / 搜索表格 ---------------- */
    // 数据由 opts.fetch({q,page,size}) 异步拉取，返回 {items, total, ...}。
    // 搜索框 / 翻页 / 每页条数均触发重新拉取（服务端过滤 + 分页）。
    // 用法：
    //   html += ADM.servTable(cols, { key:'users', fetch: fn, pageSize:10,
    //                                 sizes:[...], actionsWidth:400, onRender: fn, countEl:'#id', countFmt: function(n){return '共 '+n} });
    // 模块在 el.innerHTML = html 之后调用 ADM.mountServTables(el) 触发首次加载；
    // 刷新（如增删改后）复用同一 key 会自动保留搜索词与页码并重新拉取。
    _servSeq: 0,
    _servTables: {},
    servTable: function (cols, opts) {
        opts = opts || {};
        var key = opts.key || ('adm_serv_' + (++ADM._servSeq));
        if (opts.fresh || !ADM._servTables[key]) {
            ADM._servTables[key] = {
                cols: cols, opts: opts,
                q: '', page: 1,
                size: opts.pageSize || 10,
                sizes: opts.sizes || [10, 20, 50, 100],
                actionsWidth: opts.actionsWidth || 0,
                colW: null, rowH: 0,
                sort: null,          // 服务端排序：{key, dir}，key 为后端字段名
                onRender: opts.onRender || null,   // 供「行信息」弹窗复用行内按钮绑定
                detail: opts.detail || null,       // 可选：自定义行详情 (row) => HTML
                detailTitle: opts.detailTitle || null,
                last: null
            };
        }
        return '<div class="adm-table-host" data-adm-serv="' + key + '"></div>';
    },

    mountServTables: function (root) {
        (root || document).querySelectorAll('[data-adm-serv]').forEach(function (host) {
            var key = host.dataset.admServ;
            if (ADM._servTables[key]) ADM.loadServ(host, key);
        });
    },

    loadServ: function (host, key) {
        var st = ADM._servTables[key];
        if (!st || !host) return;
        host.innerHTML = '<div class="adm-table-wrap adm-table-empty">加载中…</div>';
        Promise.resolve()
            .then(function () {
                return st.opts.fetch({
                    q: st.q, page: st.page, size: st.size,
                    sort: st.sort ? st.sort.key : '',
                    order: st.sort ? st.sort.dir : ''
                });
            })
            .then(function (res) {
                if (!host || ADM._servTables[key] !== st) return;   // 已被新实例替换
                st.last = res || {};
                var ik = st.opts.itemsKey || 'items';
                var tk = st.opts.totalKey || 'total';
                var items = st.last[ik] || [];
                var total = (st.last[tk] != null) ? st.last[tk] : items.length;
                ADM._renderServ(host, key, st, items, total);
            })
            .catch(function (e) {
                if (!host || ADM._servTables[key] !== st) return;
                host.innerHTML = '<div class="adm-table-wrap adm-table-empty">加载失败：' +
                    ADM.esc(String((e && e.message) || e)) + '</div>';
            });
    },

    _renderServ: function (host, key, st, items, total) {
        var cols = st.cols, size = st.size;
        var pages = Math.max(1, Math.ceil(total / size));
        if (st.page > pages) st.page = pages;
        if (st.page < 1) st.page = 1;
        var page = st.page;
        var start = (page - 1) * size;

        // 把服务端返回的额外字段（如 running 数）透传给 onRender
        if (st.opts.countEl && st.opts.countFmt) {
            var cEl = host.closest('.adm-module, .adm-section, body');
            var target = cEl ? cEl.querySelector(st.opts.countEl) : null;
            if (target) target.innerHTML = st.opts.countFmt(total, st.last);
        }

        var h = '<div class="adm-table-toolbar">' +
            '<input class="adm-input adm-table-search" type="search" placeholder="' + ADM.esc(st.opts.searchPlaceholder || '关键字搜索…') + '" value="' + ADM.esc(st.q) + '" spellcheck="false">' +
            '<span class="adm-hint">共 <b>' + total + '</b> 条' +
            (total ? '，当前第 ' + (start + 1) + '-' + Math.min(start + size, total) + ' 条' : '') +
            '</span><span class="adm-spacer"></span><span class="adm-hint">每页</span>' +
            '<select class="adm-select adm-page-size">' +
            st.sizes.map(function (s) { return '<option value="' + s + '"' + (s === size ? ' selected' : '') + '>' + s + ' 条</option>'; }).join('') +
            '</select></div>';

        // 服务端排序：仅当 opts.sortable 开启时给表头加排序（列需提供 sortKey = 后端字段名）
        var sortOpt = st.opts.sortable ? {
            active: st.sort ? st.sort.key : null,
            dir: st.sort ? st.sort.dir : 'asc',
            idOf: function (c) { return c.sortKey || null; }
        } : null;
        h += ADM._tableHtml(cols, items, st.opts.empty || '暂无数据', st.colW || null, sortOpt);

        if (pages > 1) {
            var from = Math.max(1, page - 2);
            var to = Math.min(pages, from + 4);
            from = Math.max(1, to - 4);
            h += '<div class="adm-pager">' +
                '<button class="adm-btn sm ghost" data-page="1"' + (page <= 1 ? ' disabled' : '') + '>首页</button>' +
                '<button class="adm-btn sm ghost" data-page="' + (page - 1) + '"' + (page <= 1 ? ' disabled' : '') + '>上一页</button>';
            for (var p = from; p <= to; p++) {
                h += '<button class="adm-btn sm ' + (p === page ? 'primary' : 'ghost') + '" data-page="' + p + '">' + p + '</button>';
            }
            h += '<button class="adm-btn sm ghost" data-page="' + (page + 1) + '"' + (page >= pages ? ' disabled' : '') + '>下一页</button>' +
                '<button class="adm-btn sm ghost" data-page="' + pages + '"' + (page >= pages ? ' disabled' : '') + '>末页</button>' +
                '<span class="adm-hint adm-page-info">第 ' + page + ' / ' + pages + ' 页</span>' +
                '<span class="adm-page-jump">跳至 <input class="adm-input adm-page-input" type="number" min="1" max="' + pages + '" value="' + page + '"> 页' +
                '<button class="adm-btn sm ghost" data-jump="1" type="button">跳转</button></span>' +
                '</div>';
        }
        host.innerHTML = h;

        if (st.opts.onRender) st.opts.onRender(host, st.last);

        var inp = host.querySelector('.adm-table-search');
        if (inp) {
            var t = null;
            inp.addEventListener('input', function () {
                clearTimeout(t);
                t = setTimeout(function () { st.q = inp.value.trim(); st.page = 1; st._refocus = true; ADM.loadServ(host, key); }, 250);
            });
        }
        host.querySelectorAll('.adm-page-size').forEach(function (sel) {
            sel.addEventListener('change', function () { st.size = parseInt(sel.value, 10); st.page = 1; ADM.loadServ(host, key); });
        });
        host.querySelectorAll('[data-page]').forEach(function (b) {
            b.addEventListener('click', function () { st.page = parseInt(b.dataset.page, 10); ADM.loadServ(host, key); });
        });
        var jumpBtn = host.querySelector('[data-jump]');
        if (jumpBtn) {
            jumpBtn.addEventListener('click', function () {
                var v = parseInt(host.querySelector('.adm-page-input').value, 10);
                if (!isNaN(v)) { st.page = v; ADM.loadServ(host, key); }
            });
        }
        // 表头点击排序：把 sortKey 作为字段名交给后端排序，然后重新拉取
        if (st.opts.sortable) {
            host.querySelectorAll('th[data-sort]').forEach(function (th) {
                th.addEventListener('click', function () {
                    var sk = th.dataset.sort;
                    if (!sk) return;
                    st.sort = (st.sort && st.sort.key === sk)
                        ? { key: sk, dir: st.sort.dir === 'asc' ? 'desc' : 'asc' }
                        : { key: sk, dir: 'asc' };
                    st.page = 1;
                    ADM.loadServ(host, key);
                });
            });
        }

        // 整行点击 → 弹出该行信息（与服务端分页表格保持一致；点行内按钮 / 链接时不触发）
        host.querySelectorAll('tbody tr[data-row]').forEach(function (tr) {
            tr.addEventListener('click', function (e) {
                if (e.target.closest('button, a, input, select, textarea, label')) return;
                var idx = parseInt(tr.dataset.row, 10);
                var row = items[idx];
                if (row) ADM._rowInfo(row, st, tr);
            });
        });

        if (!st.colW) ADM._freezeCols(host, st);
        ADM._fitTable(host, st);

        // 由输入触发的重渲染：恢复焦点与光标位置，保证连续输入顺畅
        if (st._refocus) {
            st._refocus = false;
            var ninp = host.querySelector('.adm-table-search');
            if (ninp) {
                ninp.focus();
                try { ninp.setSelectionRange(ninp.value.length, ninp.value.length); } catch (_) {}
            }
        }
    },

    /* Tab 组件：items = [{id, name, icon, content, onShow(root)}]；返回 HTML 字符串。
     * 同一 key 会保留上次选中的标签页（模块刷新后不跳回第一个）。 */
    tabs: function (items, opts) {
        opts = opts || {};
        items = items || [];
        var key = opts.key || ('adm_tabs_' + (++ADM._tabSeq));
        var prev = ADM._tabs[key];
        var active = opts.active || (prev && prev.active) || (items[0] && items[0].id);
        if (!items.some(function (x) { return x.id === active; })) {
            active = items[0] && items[0].id;
        }
        ADM._tabs[key] = { items: items, active: active };

        var h = '<div class="adm-tabs" data-adm-tabs="' + key + '">';
        h += '<div class="adm-tabbar">';
        items.forEach(function (it) {
            h += '<button class="adm-tab' + (it.id === active ? ' active' : '') + '" type="button" data-tab="' +
                ADM.esc(it.id) + '">' + (it.icon ? '<i class="bi ' + it.icon + '"></i>' : '') + ADM.esc(it.name) + '</button>';
        });
        h += '</div>';
        items.forEach(function (it) {
            h += '<div class="adm-tabpanel' + (it.id === active ? ' active' : '') + '" data-panel="' +
                ADM.esc(it.id) + '">' + (it.content || '') + '</div>';
        });
        h += '</div>';
        return h;
    },

    /* 绑定 Tab 切换（模块设置 innerHTML 后调用）。
     * 注意：只选取「直接子级」的标签按钮与面板 —— 支持 Tab 内再嵌套 Tab，
     * 否则外层会误绑到内层的按钮、把内层选中态清掉。 */
    mountTabs: function (root) {
        function kids(node, cls) {
            return Array.prototype.filter.call(node.children, function (c) {
                return c.classList && c.classList.contains(cls);
            });
        }
        (root || document).querySelectorAll('[data-adm-tabs]').forEach(function (bar) {
            var key = bar.dataset.admTabs;
            var st = ADM._tabs[key];
            if (!st) return;
            var barInner = kids(bar, 'adm-tabbar')[0];
            var btns = barInner ? kids(barInner, 'adm-tab') : [];
            var panels = kids(bar, 'adm-tabpanel');

            function activate(id) {
                st.active = id;
                btns.forEach(function (b) { b.classList.toggle('active', b.dataset.tab === id); });
                panels.forEach(function (p) { p.classList.toggle('active', p.dataset.panel === id); });
                var cur = st.items.filter(function (x) { return x.id === id; })[0];
                if (cur && cur.onShow) cur.onShow(bar);
                // 面板显示后重新测量表格高度（隐藏时量不到尺寸）
                requestAnimationFrame(function () { ADM.refitTables(bar); });
            }
            btns.forEach(function (b) {
                b.addEventListener('click', function () {
                    if (b.dataset.tab === st.active) return;
                    activate(b.dataset.tab);
                });
            });
        });
    },

    sectionHead: function (icon, title, right) {
        return '<div class="adm-section-head"><h2><i class="bi ' + icon + '"></i>' + ADM.esc(title) + '</h2>' +
            '<span class="adm-spacer"></span>' + (right || '') + '</div>';
    },

    metric: function (label, value, percent, sub) {
        var cls = '';
        if (percent >= 90) cls = ' bad';
        else if (percent >= 75) cls = ' warn';
        var bar = (percent === undefined || percent === null || isNaN(percent)) ? '' :
            '<div class="adm-bar' + cls + '"><i style="width:' + Math.max(0, Math.min(100, percent)) + '%"></i></div>';
        return '<div class="adm-metric">' +
            '<div class="adm-metric-row"><span>' + ADM.esc(label) + '</span><b>' + ADM.esc(value) + '</b></div>' +
            bar + (sub ? '<div class="adm-hint" style="margin-top:6px">' + ADM.esc(sub) + '</div>' : '') +
            '</div>';
    },

    fieldHtml: function (f) {
        var v = f.value === null || f.value === undefined ? '' : f.value;
        var html = '<div class="adm-field"><label>' + ADM.esc(f.label || f.name) + '</label>';
        if (f.type === 'textarea') {
            html += '<textarea class="adm-textarea" name="' + f.name + '" placeholder="' +
                ADM.esc(f.placeholder || '') + '">' + ADM.esc(v) + '</textarea>';
        } else if (f.type === 'select') {
            html += '<select class="adm-select" name="' + f.name + '">';
            (f.options || []).forEach(function (op) {
                var ov = (typeof op === 'object') ? op.value : op;
                var ol = (typeof op === 'object') ? op.label : op;
                html += '<option value="' + ADM.esc(ov) + '"' + (String(ov) === String(v) ? ' selected' : '') + '>' +
                    ADM.esc(ol) + '</option>';
            });
            html += '</select>';
        } else {
            html += '<input class="adm-input" type="' + (f.type || 'text') + '" name="' + f.name +
                '" value="' + ADM.esc(v) + '" placeholder="' + ADM.esc(f.placeholder || '') + '">';
        }
        if (f.hint) html += '<span class="adm-field-hint">' + ADM.esc(f.hint) + '</span>';
        return html + '</div>';
    },

    readForm: function (box) {
        var out = {};
        box.querySelectorAll('[name]').forEach(function (el) {
            out[el.name] = (el.type === 'checkbox') ? el.checked : el.value;
        });
        return out;
    },

    /* ---------------- Toast ---------------- */
    toast: function (msg, tone) {
        var box = document.getElementById('admToast');
        var el = document.createElement('div');
        el.className = 'adm-toast ' + (tone || 'ok');
        el.textContent = msg;
        box.appendChild(el);
        requestAnimationFrame(function () { el.classList.add('show'); });
        setTimeout(function () {
            el.classList.remove('show');
            setTimeout(function () { el.remove(); }, 260);
        }, 2800);
    },

    /* ---------------- 弹窗 ---------------- */
    modal: function (opts) {
        opts = opts || {};
        return new Promise(function (resolve) {
            var root = document.getElementById('admModalRoot');
            var mask = document.createElement('div');
            mask.className = 'adm-modal-mask';
            var box = document.createElement('div');
            box.className = 'adm-modal' + (opts.size ? ' ' + opts.size : '');
            box.innerHTML =
                '<div class="adm-modal-head"><i class="bi ' + (opts.icon || 'bi-sliders') + '"></i>' +
                ADM.esc(opts.title || '') + '</div>' +
                '<div class="adm-modal-body">' + (opts.html || '') + '</div>' +
                '<div class="adm-modal-foot">' +
                (opts.footer ? '<div class="adm-modal-foot-left">' + opts.footer + '</div>' : '') +
                '<button class="adm-btn ghost" type="button" data-adm-cancel>' + ADM.esc(opts.cancelText || '取消') + '</button>' +
                (opts.noOk ? '' : '<button class="adm-btn ' + (opts.danger ? 'danger' : 'primary') +
                    '" type="button" data-adm-ok>' + ADM.esc(opts.okText || '确定') + '</button>') +
                '</div>';
            mask.appendChild(box);
            root.appendChild(mask);
            ADM.mountTables(box);      // 弹窗内的分页表格在插入后立即渲染
            ADM.mountTabs(box);        // 弹窗内的 Tab 在插入后立即生效

            var closed = false;
            function done(val) {
                if (closed) return;
                closed = true;
                mask.remove();
                resolve(val);
            }

            mask.addEventListener('click', function (e) { if (e.target === mask) done(null); });
            var cancelBtn = box.querySelector('[data-adm-cancel]');
            if (cancelBtn) cancelBtn.addEventListener('click', function () { done(null); });
            var okBtn = box.querySelector('[data-adm-ok]');
            if (okBtn) okBtn.addEventListener('click', async function () {
                okBtn.disabled = true;
                try {
                    var res = opts.onOk ? await opts.onOk(box) : true;
                    if (res === false) { okBtn.disabled = false; return; }
                    done(res === undefined ? true : res);
                } catch (e) {
                    ADM.toast((e && e.message) || String(e), 'err');
                    okBtn.disabled = false;
                }
            });
            if (opts.onOpen) opts.onOpen(box, done);
            var first = box.querySelector('input, textarea, select');
            if (first) setTimeout(function () { try { first.focus(); } catch (e) { } }, 40);
        });
    },

    confirm: function (title, html, okText) {
        return ADM.modal({
            title: title,
            icon: 'bi-exclamation-triangle',
            size: '',
            danger: true,
            html: '<div style="color:var(--adm-text-dim);line-height:1.7">' + (html || '') + '</div>',
            okText: okText || '确认执行',
            onOk: function () { return true; }
        });
    },

    copy: function (text) {
        var t = String(text || '');
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(t).then(function () {
                ADM.toast('已复制到剪贴板', 'ok');
            }, function () {
                ADM.toast('复制失败，请手动选择', 'warn');
            });
        } else {
            ADM.toast('当前环境不支持一键复制', 'warn');
        }
    },

    /* ---------------- 渲染当前视图 ---------------- */
    reload: function () {
        if (ADM.current) ADM.render(ADM.current);
    },

    render: async function (id) {
        var mod = ADM.modules.find(function (m) { return m.id === id; });
        if (!mod) return;
        ADM.current = id;
        /* 记住当前打开的模块：localStorage 供刷新后恢复，URL hash 便于收藏 / 分享直达 */
        try {
            localStorage.setItem('adm_module', id);
            if (window.history && history.replaceState) history.replaceState(null, '', '#' + id);
        } catch (e) { }
        document.querySelectorAll('.adm-nav-item').forEach(function (el) {
            el.classList.toggle('active', el.dataset.id === id);
        });
        document.getElementById('admTitle').textContent = mod.name;
        document.getElementById('admSubtitle').textContent = mod.subtitle || '';
        document.getElementById('admView').scrollTop = 0;
        try {
            await mod.load(document.getElementById('admView'));
        } catch (e) {
            document.getElementById('admView').innerHTML =
                '<div class="adm-card" style="border-color:rgba(248,113,113,.4)">' +
                '<div style="color:#fca5a5;font-weight:600;margin-bottom:6px">加载失败</div>' +
                '<div class="adm-hint">' + ADM.esc((e && e.message) || String(e)) + '</div></div>';
        }
    }
};

/* 通用日志查看器：fetcher(offset) 需返回 { text, offset, running, status } 结构。
 * 运行中自动逐秒轮询追加，关闭弹窗即停止。
 * 支持自定义关键字搜索：多个关键字用空格分隔；命中处高亮、可上下定位、可「仅显示匹配行」。 */
function openLogViewer(title, fetcher, runningKey) {
    var offset = 0, timer = null, closed = false;
    var raw = '';          // 累积的原始日志文本（搜索 / 过滤 / 高亮都基于它）
    var kw = '';           // 当前关键字（空格分隔多个）
    var active = 0;        // 当前定位到的匹配序号
    var boxRef = null;     // 弹窗容器

    function keywords() {
        return kw.split(/\s+/).filter(function (x) { return !!x; });
    }

    /* 在 text 中找出所有关键字命中区间（不区分大小写，重叠区间已合并） */
    function spansOf(text, kws) {
        var lower = text.toLowerCase(), spans = [];
        kws.forEach(function (k) {
            var kk = k.toLowerCase(), from = 0, i;
            if (!kk) return;
            while ((i = lower.indexOf(kk, from)) !== -1) {
                spans.push([i, i + kk.length]);
                from = i + kk.length;
            }
        });
        spans.sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
        var merged = [];
        spans.forEach(function (s) {
            var last = merged[merged.length - 1];
            if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
            else merged.push([s[0], s[1]]);
        });
        return merged;
    }

    /* 取「过滤后的文本」：勾选「仅显示匹配行」时只保留含关键字的行 */
    function currentText(kws, only) {
        if (!kws.length || !only) return raw;
        return raw.split('\n').filter(function (line) {
            var low = line.toLowerCase();
            return kws.some(function (k) { return low.indexOf(k.toLowerCase()) !== -1; });
        }).join('\n');
    }

    function render() {
        if (!boxRef) return;
        var pre = boxRef.querySelector('#admLogPre');
        var countEl = boxRef.querySelector('#admLogCount');
        if (!pre) return;
        var onlyEl = boxRef.querySelector('#admLogOnly');
        var only = !!(onlyEl && onlyEl.checked);
        var kws = keywords();
        var text = currentText(kws, only);
        var spans = kws.length ? spansOf(text, kws) : [];
        if (spans.length && active >= spans.length) active = spans.length - 1;   // 匹配数变少后夹紧

        if (!kws.length) {
            pre.textContent = text;
        } else if (only && !spans.length) {
            pre.innerHTML = '<span class="adm-hint">没有匹配的行</span>';
        } else {
            var out = [], cur = 0;
            spans.forEach(function (s, i) {
                out.push(ADM.esc(text.slice(cur, s[0])));
                out.push('<mark class="adm-log-hit' + (i === active ? ' cur' : '') + '">' +
                    ADM.esc(text.slice(s[0], s[1])) + '</mark>');
                cur = s[1];
            });
            out.push(ADM.esc(text.slice(cur)));
            pre.innerHTML = out.join('');
        }

        if (countEl) {
            countEl.textContent = kws.length
                ? (spans.length ? ('匹配 ' + spans.length + ' 处' +
                    (spans.length > 1 ? '（第 ' + Math.min(active + 1, spans.length) + ' 处）' : ''))
                    : '无匹配')
                : '';
        }

        var curEl = spans.length ? pre.querySelector('mark.cur') : null;
        if (curEl) {                            // 定位到当前匹配（在 pre 内滚动，不带动整页）
            var pr = pre.getBoundingClientRect(), cr = curEl.getBoundingClientRect();
            pre.scrollTop += (cr.top - pr.top) - pre.clientHeight / 2 + cr.height / 2;
        } else if (!kws.length) {
            pre.scrollTop = pre.scrollHeight;   // 无搜索时跟随最新日志
        }
    }

    /* 上一个 / 下一个匹配 */
    function step(delta) {
        if (!boxRef) return;
        var onlyEl = boxRef.querySelector('#admLogOnly');
        var kws = keywords();
        var n = kws.length ? spansOf(currentText(kws, !!(onlyEl && onlyEl.checked)), kws).length : 0;
        if (!n) return;
        active = (active + delta + n) % n;
        render();
    }

    function tick(pre, meta) {
        if (closed) return;
        fetcher(offset).then(function (res) {
            if (res.error) { meta.textContent = res.error; return; }
            if (res.text) {
                raw += res.text;
                if (typeof res.offset === 'number') offset = res.offset;
                render();
            }
            var running;
            if (runningKey === null) running = false;
            else running = runningKey ? !!res[runningKey] : !!res.running;
            meta.textContent = running ? '实时读取中…（每秒自动刷新）'
                : ('已结束' + (res.status && res.status !== 'running' ? ' · 状态：' + res.status : ''));
            if (running) timer = setTimeout(function () { tick(pre, meta); }, 1000);
        }).catch(function (e) {
            meta.textContent = '读取失败：' + ((e && e.message) || e);
        });
    }

    ADM.modal({
        title: title,
        icon: 'bi-terminal',
        size: 'big',
        noOk: true,
        cancelText: '关闭',
        html: '<div class="adm-log-search">' +
                '<input class="adm-input" id="admLogKw" type="search" spellcheck="false" ' +
                'placeholder="关键字搜索（空格分隔多个）">' +
                '<span class="adm-hint" id="admLogCount"></span>' +
                '<button class="adm-btn sm ghost" id="admLogPrev" type="button">上一个</button>' +
                '<button class="adm-btn sm ghost" id="admLogNext" type="button">下一个</button>' +
                '<label class="adm-switch" style="margin-left:auto"><input type="checkbox" id="admLogOnly"> 仅显示匹配行</label>' +
            '</div>' +
            '<pre class="adm-pre" id="admLogPre" style="min-height:220px"></pre>' +
            '<div class="adm-hint" id="admLogMeta" style="margin-top:8px">读取中…</div>',
        onOpen: function (box) {
            boxRef = box;
            var pre = box.querySelector('#admLogPre');
            var meta = box.querySelector('#admLogMeta');
            var inp = box.querySelector('#admLogKw');
            var kwTimer = null;

            inp.addEventListener('input', function () {          // 输入防抖后即时高亮
                clearTimeout(kwTimer);
                kwTimer = setTimeout(function () { kw = inp.value.trim(); active = 0; render(); }, 180);
            });
            inp.addEventListener('keydown', function (e) {        // 回车定位下一个，Shift+回车上一个
                if (e.key !== 'Enter') return;
                e.preventDefault();
                clearTimeout(kwTimer);
                var nv = inp.value.trim();
                if (nv !== kw) { kw = nv; active = 0; render(); }
                else step(e.shiftKey ? -1 : 1);
            });
            box.querySelector('#admLogPrev').addEventListener('click', function () { step(-1); });
            box.querySelector('#admLogNext').addEventListener('click', function () { step(1); });
            box.querySelector('#admLogOnly').addEventListener('change', function () { active = 0; render(); });

            tick(pre, meta);
        }
    }).then(function () {
        closed = true;
        if (timer) clearTimeout(timer);
    });
}

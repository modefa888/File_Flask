        // ========== 后台任务系统（压缩/解压/删除，同移动版：进度弹窗 + 左下角后台胶囊） ==========
        const _bgTasks = {};      // key -> {kind, taskId, timer, es, onDone, title, last, progUrl}
        let _activeBgTask = null; // 当前弹窗展示的任务 key
        let _bgSeq = 0;
        let _bgOverlay = null;

        function _bgVerb(kind) { return { zip: '压缩', uz: '解压', del: '删除', mv: '移动', cp: '复制' }[kind] || '处理'; }
        function _bgIco(kind) { return { zip: 'bi-file-zip-fill', uz: 'bi-folder2-open', del: 'bi-trash3', mv: 'bi-arrows-move', cp: 'bi-files' }[kind] || 'bi-arrow-repeat'; }

        function _bgFmt(n) {
            if (!n) return '0 B';
            const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0;
            while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
            return (n >= 100 || i === 0 ? n.toFixed(0) : n.toFixed(1)) + ' ' + u[i];
        }

        /* ---------- 刷新续航：把在跑的任务记到 localStorage，重新打开页面后接着显示 ---------- */
        const _BG_STORE_KEY = 'fm_bg_tasks';        // 在跑的任务清单
        const _BG_ACTIVE_KEY = 'fm_bg_active';      // 刷新前正打开着弹窗的那个任务
        const _BG_RESTORE_AGE = 3 * 3600 * 1000;    // 半天内的记录才尝试续上

        function _bgStoreRead() {
            try {
                const arr = JSON.parse(localStorage.getItem(_BG_STORE_KEY) || '[]');
                return Array.isArray(arr) ? arr : [];
            } catch (e) { return []; }
        }
        function _bgStoreWrite(list) {
            try { localStorage.setItem(_BG_STORE_KEY, JSON.stringify(list.slice(-10))); } catch (e) { }
        }
        function _bgStorePut(t) {
            if (!t || !t.taskId || !t.progUrl) return;
            const list = _bgStoreRead().filter(x => x && x.id !== t.taskId);
            list.push({ id: t.taskId, kind: t.kind, title: t.title, progUrl: t.progUrl, at: Date.now() });
            _bgStoreWrite(list);
        }
        function _bgStoreDel(id) {
            const list = _bgStoreRead();
            const next = list.filter(x => x && x.id !== id);
            if (next.length !== list.length) _bgStoreWrite(next);
        }
        function _bgSetActive(id) {
            try {
                if (id) localStorage.setItem(_BG_ACTIVE_KEY, id);
                else localStorage.removeItem(_BG_ACTIVE_KEY);
            } catch (e) { }
        }

        /* 页面加载：把上次没跑完的任务重新挂上，重新订阅进度（任务列表在服务端保留 30 分钟） */
        function _bgRestore() {
            const now = Date.now();
            const saved = _bgStoreRead().filter(x =>
                x && x.id && x.progUrl && (now - (x.at || 0)) < _BG_RESTORE_AGE);
            if (!saved.length) { _bgStoreWrite([]); return; }
            saved.forEach(x => {
                if (_bgTasks[x.id]) return;
                _bgTasks[x.id] = {
                    kind: x.kind || 'zip', taskId: x.id, timer: null, es: null, onDone: null,
                    title: x.title || '处理中…', last: null, progUrl: x.progUrl, restored: true
                };
                _bgPoll(x.id);
            });
            _bgRenderDock();
            // 刷新前弹窗是开着的，就继续打开同一个任务
            let act = '';
            try { act = localStorage.getItem(_BG_ACTIVE_KEY) || ''; } catch (e) { }
            if (act && _bgTasks[act]) _bgOpenModal(act);
        }

        function _bgEnsureOverlay() {
            if (_bgOverlay && document.body.contains(_bgOverlay)) return _bgOverlay;
            _bgOverlay = document.createElement('div');
            _bgOverlay.id = 'zipProgOverlay';
            _bgOverlay.className = 'preview-overlay';
            _bgOverlay.innerHTML = `
          <div class="zip-modal" style="width:460px;height:auto;">
            <div class="zip-header"><div class="zip-title-row">
              <div class="zip-title"><i class="bi bi-file-zip-fill"></i><span id="zipProgTitle">处理中…</span></div>
              <div class="zip-actions"><button class="btn btn-close-zip" id="zipProgMin" title="最小化到后台"><i class="bi bi-dash-lg"></i></button></div>
            </div></div>
            <div style="padding:16px 20px 20px;">
              <div class="zip-prog-top">
                <span id="zipProgFiles">准备中…</span>
                <button class="zip-prog-detail" id="zipProgDetail" hidden><span>详情</span><i class="bi bi-chevron-down"></i></button>
              </div>
              <div style="height:10px;background:#e2e8f0;border-radius:6px;overflow:hidden;"><div id="zipProgBar" style="height:100%;width:0%;background:linear-gradient(90deg,#2563eb,#1d4ed8);transition:width .3s;"></div></div>
              <div style="font-size:0.78rem;color:#718096;margin-top:8px;display:flex;justify-content:space-between;"><span id="zipProgBytes"></span><span id="zipProgPct">0%</span></div>
              <div style="font-size:0.75rem;color:#94a3b8;margin-top:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" id="zipProgCur"></div>
              <div id="zipProgList" class="zip-prog-list" hidden></div>
            </div>
          </div>`;
            document.body.appendChild(_bgOverlay);
            document.getElementById('zipProgMin').addEventListener('click', () => {
                _bgCloseModal();
                showToast('已转入后台', '任务在左下角胶囊继续，完成后会通知', 'info');
            });
            // 详情展开 / 收起：展开后按「每个文件一行」显示各自的进度与完成状态
            document.getElementById('zipProgDetail').addEventListener('click', () => {
                _bgDetailOpen = !_bgDetailOpen;
                const t = _bgTasks[_activeBgTask];
                if (t && t.last) _bgUpdateModal(t.last);
            });
            return _bgOverlay;
        }

        let _bgListKey = '';
        let _bgDetailOpen = false;      // 「详情」是否展开（移动 / 复制任务用）

        /* 详情按钮：只有带明细的移动 / 复制任务才显示 */
        function _bgSyncDetailBtn(d) {
            const btn = document.getElementById('zipProgDetail');
            if (!btn) return;
            const t = _bgTasks[_activeBgTask];
            const kind = t ? t.kind : '';
            const has = (kind === 'mv' || kind === 'cp') && d && ((d.files && d.files.length) || (d.items && d.items.length));
            btn.hidden = !has;
            btn.classList.toggle('open', _bgDetailOpen);
            const label = btn.querySelector('span');
            if (label) label.textContent = _bgDetailOpen ? '收起' : '详情';
        }

        /* 行首状态图标：进行中用 CSS 圆环转圈（Bootstrap 的 arrow-repeat 是断口箭头，
           旋转起来会像被切掉一块），其余用实心状态图标 */
        function _bgRowIco(st) {
            if (st === 'running') return '<span class="bgp-spin"></span>';
            const ico = st === 'done' ? 'bi-check-circle-fill'
                : (st === 'error' ? 'bi-exclamation-circle-fill' : 'bi-circle');
            return '<i class="bi ' + ico + ' bgp-ico"></i>';
        }

        // 移动 / 复制：每个文件一行（自己的进度条 + 完成情况）
        function _bgFileRows(d) {
            const list = d.files || [];
            const notes = [];
            const t = _bgTasks[_activeBgTask];
            const verb = (t && t.kind === 'mv') ? '移动' : '复制';
            if (d.detail_total && d.detail_total > list.length) {
                notes.push('另有 ' + (d.detail_total - list.length) + ' 个文件未展开（仅显示前 ' + list.length + ' 个）');
            }
            const rows = list.map(function (f) {
                const pct = f.size > 0
                    ? Math.min(100, (f.done / f.size) * 100)
                    : (f.status === 'done' ? 100 : 0);
                const st = f.status || 'pending';
                const cls = st === 'done' ? ' done' : (st === 'error' ? ' err' : (st === 'running' ? ' run' : ''));
                const detail = st === 'error' ? (f.error || '失败')
                    : (st === 'running' ? (verb + '中 ' + _bgFmt(f.done) + ' / ' + _bgFmt(f.size))
                        : (st === 'done' ? '已完成' : '等待中'));
                return '<div class="bgp-item' + cls + '">' +
                    _bgRowIco(st) +
                    '<div class="bgp-main">' +
                        '<div class="bgp-top"><span class="bgp-name" title="' + _escAttr(f.name) + '">' +
                            _escHtml(f.name) + '</span>' +
                            '<span class="bgp-size">' + _bgFmt(f.size) + '</span></div>' +
                        '<div class="bgp-bar"><div class="bgp-fill" style="width:' + pct.toFixed(1) + '%"></div></div>' +
                        '<div class="bgp-sub">' + _escHtml(detail) + '</div>' +
                    '</div>' +
                    '<span class="bgp-pct">' + Math.round(pct) + '%</span>' +
                '</div>';
            }).join('');
            return '<div class="bgp-head"><i class="bi bi-list-ul"></i>文件详情（' +
                list.length + ' 项）' + (notes.length ? ' · ' + _escHtml(notes[0]) : '') + '</div>' + rows;
        }

        // 兜底：没有逐文件明细时，按顶层条目列出（老后端 / 明细被截断时仍能看到进度）
        function _bgItemRows(d) {
            const list = d.items || [];
            const rows = list.map(function (it) {
                const pct = it.size > 0
                    ? Math.min(100, (it.done_bytes / it.size) * 100)
                    : (it.status === 'done' ? 100 : 0);
                const st = it.status || 'pending';
                const cls = st === 'done' ? ' done' : (st === 'error' ? ' err' : (st === 'running' ? ' run' : ''));
                const detail = st === 'error' ? (it.error || '失败')
                    : (st === 'running' ? (it.current || '处理中…')
                        : (st === 'done' ? '已完成' : '等待中'));
                return '<div class="bgp-item' + cls + '">' +
                    _bgRowIco(st) +
                    '<div class="bgp-main">' +
                        '<div class="bgp-top"><span class="bgp-name" title="' + _escAttr(it.name) + '">' +
                            _escHtml(it.name) + '</span>' +
                            '<span class="bgp-size">' + _bgFmt(it.size) +
                            (it.files > 1 ? ' · ' + it.files + ' 个文件' : '') + '</span></div>' +
                        '<div class="bgp-bar"><div class="bgp-fill" style="width:' + pct.toFixed(1) + '%"></div></div>' +
                        '<div class="bgp-sub">' + _escHtml(detail) + '</div>' +
                    '</div>' +
                    '<span class="bgp-pct">' + Math.round(pct) + '%</span>' +
                '</div>';
            }).join('');
            return '<div class="bgp-head"><i class="bi bi-list-ul"></i>详情（' + list.length + ' 项）</div>' + rows;
        }

        function _bgRenderList(d) {
            const box = document.getElementById('zipProgList');
            if (!box) return;
            const t = _bgTasks[_activeBgTask];
            const kind = t ? t.kind : '';
            const isMC = (kind === 'mv' || kind === 'cp');

            // 移动 / 复制：默认收起，点「详情」才展开文件明细
            if (isMC) {
                const files = (d && d.files) || [];
                const useItems = !files.length && d && d.items && d.items.length;
                const src = useItems ? d.items : files;
                if (!_bgDetailOpen || !src.length) {
                    if (!box.hidden) { box.hidden = true; box.innerHTML = ''; }
                    _bgListKey = '';
                    return;
                }
                const key = (useItems ? 'it|' : 'mc|') + src.map(function (f) {
                    if (useItems) {
                        return f.name + ':' + f.status + ':' +
                            Math.round(f.size ? (f.done_bytes / f.size) * 100 : (f.status === 'done' ? 100 : 0));
                    }
                    return f.name + ':' + f.status + ':' +
                        Math.round(f.size ? (f.done / f.size) * 100 : (f.status === 'done' ? 100 : 0));
                }).join('|');
                if (key === _bgListKey) return;      // 内容没变就不重建，避免闪烁
                _bgListKey = key;
                const keep = box.scrollTop;
                box.hidden = false;
                box.innerHTML = useItems ? _bgItemRows(d) : _bgFileRows(d);
                box.scrollTop = keep;
                return;
            }

            // 删除：实时列出刚搬进回收站的条目（一直显示，不需要点详情）
            const items = (kind === 'del' && d && d.recent && d.recent.length) ? d.recent : null;
            if (!items) {
                if (!box.hidden) { box.hidden = true; box.innerHTML = ''; }
                _bgListKey = '';
                return;
            }
            const key = items.length + '|' + items[items.length - 1];
            if (key === _bgListKey) return;          // SSE 每 0.3s 推一次，内容没变就不重建
            _bgListKey = key;
            box.hidden = false;
            box.innerHTML = items.slice(-40).reverse().map(function (n) {
                return '<div class="zpl-row"><i class="bi bi-file-earmark-x"></i><span title="' +
                    _escAttr(n) + '">' + _escHtml(n) + '</span></div>';
            }).join('');
            box.scrollTop = 0;
        }

        function _bgUpdateModal(d) {
            document.getElementById('zipProgBar').style.width = (d.percent || 0) + '%';
            document.getElementById('zipProgPct').textContent = (d.percent || 0).toFixed(0) + '%';
            document.getElementById('zipProgFiles').textContent = `已${_bgVerb(_bgTasks[_activeBgTask] ? _bgTasks[_activeBgTask].kind : 'zip')} ${d.done_files} / ${d.total_files} 个文件`;
            document.getElementById('zipProgCur').textContent = d.current || '';
            document.getElementById('zipProgBytes').textContent = (d.done_bytes != null)
                ? (_bgFmt(d.done_bytes) + (d.total_bytes ? ' / ' + _bgFmt(d.total_bytes) : '')) : '';
            _bgSyncDetailBtn(d);
            _bgRenderList(d);
        }

        function _bgOpenModal(key) {
            _activeBgTask = key;
            _bgListKey = '';       // 换任务了，进度表重新建
            const t = _bgTasks[key];
            const ov = _bgEnsureOverlay();
            document.getElementById('zipProgTitle').textContent = (t && t.title) || '处理中…';
            if (t && t.last) _bgUpdateModal(t.last);
            else {
                document.getElementById('zipProgBar').style.width = '0%';
                document.getElementById('zipProgPct').textContent = '0%';
                document.getElementById('zipProgFiles').textContent = '准备中…';
                document.getElementById('zipProgBytes').textContent = '';
                document.getElementById('zipProgCur').textContent = '';
                _bgSyncDetailBtn(null);
            }
            ov.style.display = 'flex';
            if (key && key.indexOf('pending') !== 0) _bgSetActive(key);
            _bgRenderDock();
        }

        function _bgCloseModal() {
            if (_bgOverlay) _bgOverlay.style.display = 'none';
            _activeBgTask = null;
            _bgSetActive('');            // 弹窗关掉：刷新后只留左下角胶囊
            _bgRenderDock();
        }

        function _bgRenderDock() {
            let dock = document.getElementById('bgTaskDock');
            if (!dock) {
                dock = document.createElement('div');
                dock.id = 'bgTaskDock';
                document.body.appendChild(dock);
                dock.addEventListener('click', (e) => {
                    const el = e.target.closest('.bg-task');
                    if (el && _bgTasks[el.dataset.task]) _bgOpenModal(el.dataset.task);
                });
            }
            const ids = Object.keys(_bgTasks);
            if (!ids.length) { dock.classList.remove('show'); dock.innerHTML = ''; return; }
            dock.classList.add('show');
            dock.innerHTML = ids.map(id => {
                const t = _bgTasks[id], d = t.last;
                const txt = d ? (Math.round(d.percent || 0) + '% · ' + _bgFmt(d.done_bytes)
                    + (d.total_bytes ? ' / ' + _bgFmt(d.total_bytes) : '')) : '准备中…';
                const fin = d && d.status !== 'running';
                return `<div class="bg-task${fin ? ' done' : ''}" data-task="${id}" title="${_escAttr(t.title)}（点击查看进度）"><i class="bi ${_bgIco(t.kind)}"></i><span class="bg-task-txt">${_escHtml(txt)}</span></div>`;
            }).join('');
        }

        function _bgFinish(key, d) {
            const t = _bgTasks[key];
            if (!t) return;
            if (t.es) { try { t.es.close(); } catch (e) { } t.es = null; }
            if (t.timer) { clearInterval(t.timer); t.timer = null; }
            delete _bgTasks[key];
            _bgStoreDel(key);            // 任务结束：删掉续航记录
            if (_activeBgTask === key) _bgCloseModal();
            else _bgRenderDock();
            const errs = (d.errors || []).concat((d.result && d.result.errors) || []);
            // 刷新后续上的任务若服务端已过期（30 分钟），静默移除，不打扰用户
            if (errs.length && !t.restored) showToast('错误', _bgVerb(t.kind) + '失败: ' + errs[0], 'danger');
            else if (t.restored && !errs.length) showToast('完成', _bgVerb(t.kind) + '已完成', 'success');
            if (t.onDone) t.onDone(!errs.length, d);
        }

        function _bgApply(key, d) {
            const t = _bgTasks[key];
            if (!t) return;
            if (d.error) { _bgFinish(key, { errors: [d.error] }); return; }
            t.last = d;
            if (_activeBgTask === key) _bgUpdateModal(d);
            // 胶囊始终跟着同一条进度刷新：弹窗开着时也要更新，否则两处数字会不一致
            _bgRenderDock();
            if (d.status !== 'running') _bgFinish(key, d);
        }

        function _bgPollFallback(key) {   // SSE 不可用时回退 400ms 轮询
            const t = _bgTasks[key];
            if (!t) return;
            t.timer = setInterval(() => {
                fetch(t.progUrl).then(r => r.json()).then(d => _bgApply(key, d))
                    .catch(() => { /* 单次轮询失败继续下一轮 */ });
            }, 400);
        }

        function _bgPoll(key) {
            const t = _bgTasks[key];
            if (!t) return;
            // 优先走 SSE 流式进度（同移动版），断流回退轮询
            if (typeof EventSource !== 'undefined') {
                // 移动 / 复制：带上 detail=1，服务端才会推送逐条 / 逐文件明细
                const detail = (t.kind === 'mv' || t.kind === 'cp') ? '&detail=1' : '';
                const es = new EventSource('/api/progress/stream?task_id=' + encodeURIComponent(t.taskId) + detail);
                t.es = es;
                es.onmessage = (ev) => { let d; try { d = JSON.parse(ev.data); } catch (e) { return; } _bgApply(key, d); };
                es.onerror = () => {
                    const tt = _bgTasks[key];
                    if (!tt || tt.es !== es) return;
                    es.close(); tt.es = null;
                    if (tt.last && tt.last.status !== 'running') return;
                    _bgPollFallback(key);
                };
                return;
            }
            _bgPollFallback(key);
        }

        function _bgStart(kind, startUrl, payload, opts) {
            opts = opts || {};
            if (_activeBgTask && _bgTasks[_activeBgTask]) _bgCloseModal();  // 旧任务转入后台胶囊
            _bgSeq++;
            _bgDetailOpen = false;      // 新任务默认收起详情
            const ph = 'pending' + _bgSeq;
            _bgTasks[ph] = { kind: kind, timer: null, es: null, onDone: opts.onDone, title: opts.title || '处理中…', last: null, progUrl: '' };
            _bgOpenModal(ph);
            fetch(startUrl, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            }).then(r => r.json()).then(d => {
                if (!_bgTasks[ph]) return;
                if (d.error) { _bgFinish(ph, { errors: [d.error] }); return; }
                const t = _bgTasks[ph];
                delete _bgTasks[ph];
                t.taskId = d.task_id;
                const progPath = { zip: 'zip/create', uz: 'zip/unzip', del: 'delete', mv: 'move', cp: 'copy' }[kind] || 'zip/create';
                t.progUrl = '/api/' + progPath + '/progress?task_id=' + encodeURIComponent(d.task_id);
                _bgTasks[d.task_id] = t;
                if (_activeBgTask === ph) { _activeBgTask = d.task_id; _bgSetActive(d.task_id); }
                _bgStorePut(t);          // 记下任务，刷新后可以继续显示进度
                _bgPoll(d.task_id);
                _bgRenderDock();
            }).catch(e => {
                if (!_bgTasks[ph]) return;
                if (opts.legacy) {
                    delete _bgTasks[ph];
                    if (_activeBgTask === ph) _bgCloseModal(); else _bgRenderDock();
                    opts.legacy(e);
                } else {
                    _bgFinish(ph, { errors: [e.message] });
                }
            });
        }

        // 页面加载：续上刷新前还没跑完的任务（进度条 / 胶囊会接着显示）
        _bgRestore();

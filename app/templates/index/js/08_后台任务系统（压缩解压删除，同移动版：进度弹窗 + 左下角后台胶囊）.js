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
              <div style="font-size:0.8rem;color:#475569;margin-bottom:6px;"><span id="zipProgFiles">准备中…</span></div>
              <div style="height:10px;background:#e2e8f0;border-radius:6px;overflow:hidden;"><div id="zipProgBar" style="height:100%;width:0%;background:linear-gradient(90deg,#2563eb,#1d4ed8);transition:width .3s;"></div></div>
              <div style="font-size:0.78rem;color:#718096;margin-top:8px;display:flex;justify-content:space-between;"><span id="zipProgBytes"></span><span id="zipProgPct">0%</span></div>
              <div style="font-size:0.75rem;color:#94a3b8;margin-top:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" id="zipProgCur"></div>
            </div>
          </div>`;
            document.body.appendChild(_bgOverlay);
            document.getElementById('zipProgMin').addEventListener('click', () => {
                _bgCloseModal();
                showToast('已转入后台', '任务在左下角胶囊继续，完成后会通知', 'info');
            });
            return _bgOverlay;
        }

        function _bgUpdateModal(d) {
            document.getElementById('zipProgBar').style.width = (d.percent || 0) + '%';
            document.getElementById('zipProgPct').textContent = (d.percent || 0).toFixed(0) + '%';
            document.getElementById('zipProgFiles').textContent = `已${_bgVerb(_bgTasks[_activeBgTask] ? _bgTasks[_activeBgTask].kind : 'zip')} ${d.done_files} / ${d.total_files} 个文件`;
            document.getElementById('zipProgCur').textContent = d.current || '';
            document.getElementById('zipProgBytes').textContent = (d.done_bytes != null)
                ? (_bgFmt(d.done_bytes) + (d.total_bytes ? ' / ' + _bgFmt(d.total_bytes) : '')) : '';
        }

        function _bgOpenModal(key) {
            _activeBgTask = key;
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
            }
            ov.style.display = 'flex';
            _bgRenderDock();
        }

        function _bgCloseModal() {
            if (_bgOverlay) _bgOverlay.style.display = 'none';
            _activeBgTask = null;
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
            delete _bgTasks[key];
            if (_activeBgTask === key) _bgCloseModal();
            else _bgRenderDock();
            const errs = (d.errors || []).concat((d.result && d.result.errors) || []);
            if (errs.length) showToast('错误', _bgVerb(t.kind) + '失败: ' + errs[0], 'danger');
            if (t.onDone) t.onDone(!errs.length, d);
        }

        function _bgApply(key, d) {
            const t = _bgTasks[key];
            if (!t) return;
            if (d.error) { _bgFinish(key, { errors: [d.error] }); return; }
            t.last = d;
            if (_activeBgTask === key) _bgUpdateModal(d);
            else _bgRenderDock();
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
                const es = new EventSource('/api/progress/stream?task_id=' + encodeURIComponent(t.taskId));
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
                if (_activeBgTask === ph) _activeBgTask = d.task_id;
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

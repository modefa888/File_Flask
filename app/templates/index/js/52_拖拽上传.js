        // ========== 上传：拖入文件 / 文件夹 → 进上传列表 → 手动「开始上传」 ==========
        // 流程参考宝塔：拖进来（或点「上传文件/上传文件夹」）只是把条目加进列表，
        // 显示文件名 / 大小 / 上传状态 / 操作，点「开始上传」才真正写入服务器。
        // · 文件夹用 webkitGetAsEntry 递归展开，保留原目录结构（keep_structure=1）；
        // · 拖拽提示遮罩全程 pointer-events:none —— 否则卡片盖住鼠标会反复 dragenter/dragleave 造成抖动；
        // · 单文件 > 25MB（后端上限）标红跳过；点「开始上传」后逐文件上传（并发 3），
        //   这样每个文件都有自己独立的进度条，也天然不会撞 32MB 的请求体上限。
        (function () {
            const MAX_ONE = 25 * 1024 * 1024;
            const MAX_ROWS = 500;          // 列表最多渲染行数，几千个文件时不至于卡死页面

            let _depth = 0;                // dragenter 计数：在子元素之间移动不算「离开」
            let _collecting = false;       // 正在递归展开文件夹
            let _busy = false;             // 正在上传

            // 拖拽提示
            let _hint = null, _hintTitle = null, _hintSub = null;
            // 上传列表对话框
            let _mask = null, _titleEl = null, _listEl = null, _emptyEl = null,
                _barEl = null, _fillEl = null, _pctEl = null, _startEl = null,
                _clearEl = null, _addFileEl = null, _addDirEl = null, _closeEl = null,
                _statEl = null, _cfMask = null, _cfCoverEl = null, _cfSkipEl = null, _cfXEl = null;

            let _queue = [];               // [{ key, rel, file, size, state, text, el }]
            let _dirs = [];                // 需要创建的空文件夹（相对路径）
            let _dir = '';                 // 本批上传的目标目录（打开列表时锁定）
            let _total = 0;
            let _st = null;                // 本轮统计：大小 / 成功数 / 耗时 / 实时速度
            let _statTimer = 0;            // 统计栏节流

            function _isFileDrag(e) {
                const dt = e && e.dataTransfer;
                return !!(dt && Array.prototype.indexOf.call(dt.types || [], 'Files') >= 0);
            }

            // ---------- 拖拽中的提示（固定尺寸 + 完全不吃鼠标事件，避免抖动） ----------
            function _ensureHint() {
                if (_hint && _hint.parentNode) return;
                _hint = document.createElement('div');
                _hint.className = 'fm-drop-mask';
                _hint.innerHTML =
                    '<div class="fm-drop-card">' +
                        '<i class="bi bi-cloud-arrow-up"></i>' +
                        '<div class="fm-drop-texts">' +
                            '<div class="fm-drop-title">松开鼠标，加入上传列表</div>' +
                            '<div class="fm-drop-sub"></div>' +
                        '</div>' +
                    '</div>';
                document.body.appendChild(_hint);
                _hintTitle = _hint.querySelector('.fm-drop-title');
                _hintSub = _hint.querySelector('.fm-drop-sub');
            }

            function _showHint() {
                if (_busy) return;
                _ensureHint();
                _hintSub.textContent = '目标：' + (currentPath || '-') + ' · 支持文件夹';
                _hint.classList.add('on');
            }

            function _hideHint() {
                if (_hint) _hint.classList.remove('on');
            }

            // ---------- 上传列表对话框 ----------
            function _ensureDlg() {
                if (_mask && _mask.parentNode) return;
                _mask = document.createElement('div');
                _mask.className = 'fm-up-mask';
                _mask.innerHTML =
                    '<div class="fm-up-dialog">' +
                        '<div class="fm-up-head">' +
                            '<span class="fm-up-title"></span>' +
                            '<span class="fm-up-tip">支持文件夹，保留目录结构 · 断点续传</span>' +
                            '<button type="button" class="fm-up-x" title="关闭">×</button>' +
                        '</div>' +
                        '<div class="fm-up-tools">' +
                            '<button type="button" class="fm-up-btn fm-up-add-file">' +
                                '<i class="bi bi-plus-lg"></i> 上传文件</button>' +
                            '<button type="button" class="fm-up-btn fm-up-add-dir">' +
                                '<i class="bi bi-folder-plus"></i> 上传文件夹</button>' +
                            '<button type="button" class="fm-up-btn fm-up-clear">清空列表</button>' +
                        '</div>' +
                        '<div class="fm-up-stat"></div>' +
                        '<div class="fm-up-body">' +
                            '<div class="fm-up-thead">' +
                                '<span>文件名</span><span>文件大小</span>' +
                                '<span>上传状态</span><span>操作</span>' +
                            '</div>' +
                            '<div class="fm-up-list"></div>' +
                            '<div class="fm-up-empty">还没有待上传的文件<br>' +
                                '<span>把文件 / 文件夹拖到这里，或点上面的「上传文件」添加</span></div>' +
                        '</div>' +
                        '<div class="fm-up-foot">' +
                            '<div class="fm-up-progress">' +
                                '<div class="fm-up-bar"><i></i></div>' +
                                '<span class="fm-up-pct"></span>' +
                            '</div>' +
                            '<button type="button" class="fm-up-start">开始上传</button>' +
                        '</div>' +
                        // 文件冲突确认（参考宝塔）：上传前发现同名文件，让用户选「跳过 / 覆盖」
                        '<div class="fm-up-cf-mask">' +
                            '<div class="fm-up-cf">' +
                                '<div class="fm-up-cf-head">' +
                                    '<span class="fm-up-cf-title">文件冲突确认</span>' +
                                    '<button type="button" class="fm-up-x fm-up-cf-x">×</button>' +
                                '</div>' +
                                '<div class="fm-up-cf-body">' +
                                    '<div class="fm-up-cf-tip">' +
                                        '<i class="bi bi-exclamation-triangle"></i>' +
                                        '<span>检测到上传目录包含重复文件，是否覆盖？</span>' +
                                    '</div>' +
                                    '<div class="fm-up-cf-scroll">' +
                                        '<table class="fm-up-cf-table">' +
                                            '<thead><tr><th>文件名</th><th>文件差异(本地 → 线上)</th></tr></thead>' +
                                            '<tbody></tbody>' +
                                        '</table>' +
                                    '</div>' +
                                '</div>' +
                                '<div class="fm-up-cf-foot">' +
                                    '<button type="button" class="fm-up-cf-skip">跳过</button>' +
                                    '<button type="button" class="fm-up-cf-cover">覆盖</button>' +
                                '</div>' +
                            '</div>' +
                        '</div>' +
                    '</div>';
                document.body.appendChild(_mask);

                _titleEl = _mask.querySelector('.fm-up-title');
                _listEl = _mask.querySelector('.fm-up-list');
                _emptyEl = _mask.querySelector('.fm-up-empty');
                _barEl = _mask.querySelector('.fm-up-bar');
                _fillEl = _barEl.firstElementChild;
                _pctEl = _mask.querySelector('.fm-up-pct');
                _startEl = _mask.querySelector('.fm-up-start');
                _clearEl = _mask.querySelector('.fm-up-clear');
                _addFileEl = _mask.querySelector('.fm-up-add-file');
                _addDirEl = _mask.querySelector('.fm-up-add-dir');
                _closeEl = _mask.querySelector('.fm-up-x');
                _statEl = _mask.querySelector('.fm-up-stat');
                _cfMask = _mask.querySelector('.fm-up-cf-mask');
                _cfCoverEl = _mask.querySelector('.fm-up-cf-cover');
                _cfSkipEl = _mask.querySelector('.fm-up-cf-skip');
                _cfXEl = _mask.querySelector('.fm-up-cf-x');
                _st = null;
                _renderStat();

                _closeEl.addEventListener('click', _closeDlg);
                _clearEl.addEventListener('click', function () {
                    if (_busy) return;
                    _queue = []; _dirs = [];
                    _barEl.classList.remove('on');
                    _pctEl.textContent = '';
                    _st = null; _total = 0;
                    _renderStat();
                    _render();
                });
                _addFileEl.addEventListener('click', function () { if (!_busy) _pick(false); });
                _addDirEl.addEventListener('click', function () { if (!_busy) _pick(true); });
                _startEl.addEventListener('click', function () {
                    if (_busy) return;
                    if (_startEl.dataset.mode === 'close') { _closeDlg(); return; }
                    _start();
                });
                // 对话框本身也接住拖放：已经打开时再拖文件直接追加
                _mask.addEventListener('dragover', function (e) {
                    if (!_isFileDrag(e)) return;
                    e.preventDefault();
                    if (e.dataTransfer) e.dataTransfer.dropEffect = _busy ? 'none' : 'copy';
                });
                _mask.addEventListener('drop', function (e) {
                    if (!_isFileDrag(e)) return;
                    e.preventDefault();
                    e.stopPropagation();
                    _hideHint();
                    _depth = 0;
                    if (_busy) { showToast('提示', '正在上传，请等这一批完成', 'warning'); return; }
                    _handleDrop(e.dataTransfer);
                });
            }

            function _openDlg() {
                if (!currentPath) { showToast('提示', '当前没有打开的目录', 'warning'); return false; }
                _ensureDlg();
                _dir = currentPath;
                _titleEl.textContent = '上传文件到 ' + currentPath;
                _titleEl.title = currentPath;
                _mask.classList.add('on');
                // 注意：这里不再清空 _st —— 统计是「上一轮上传的结果」，用户继续添加文件时保留，
                // 只有真正点「开始上传」或「清空列表」才重置（否则刚传完的信息会莫名其妙归零）
                _renderStat();
                _render();
                return true;
            }

            function _closeDlg() {
                if (_busy) { showToast('提示', '还有文件在上传，请等待完成', 'warning'); return; }
                if (_mask) _mask.classList.remove('on');
            }

            // 用 input[type=file] 追加本地文件 / 文件夹（webkitdirectory）
            function _pick(isDir) {
                const inp = document.createElement('input');
                inp.type = 'file';
                inp.multiple = true;
                if (isDir) inp.webkitdirectory = true;
                inp.style.display = 'none';
                document.body.appendChild(inp);
                inp.addEventListener('change', function () {
                    const files = Array.prototype.slice.call(inp.files || []);
                    if (inp.parentNode) inp.parentNode.removeChild(inp);
                    if (!files.length) return;
                    _addItems(files.map(function (f) {
                        return { file: f, rel: f.webkitRelativePath || f.name };
                    }), []);
                });
                inp.addEventListener('cancel', function () {
                    if (inp.parentNode) inp.parentNode.removeChild(inp);
                });
                inp.click();
            }

            // ---------- 队列 ----------
            function _addItems(files, dirs) {
                if (!files.length && !(dirs && dirs.length)) return;
                if (!_mask || !_mask.classList.contains('on')) {
                    if (!_openDlg()) return;
                }
                (dirs || []).forEach(function (d) {
                    if (d && _dirs.indexOf(d) < 0) _dirs.push(d);
                });
                files.forEach(function (it) {
                    const rel = String(it.rel || it.file.name).replace(/^\/+/, '');
                    const key = rel + '|' + it.file.size + '|' + (it.file.lastModified || 0);
                    if (_queue.some(function (q) { return q.key === key; })) return;
                    const q = {
                        key: key, rel: rel, file: it.file, size: it.file.size,
                        state: 'wait', text: '未上传', el: null,
                    };
                    // 只有明确传不上去的才标红；0 字节文件照常上传（空文件也是合法文件）
                    if (q.size > MAX_ONE) { q.state = 'fail'; q.text = '超过 25MB'; }
                    _queue.push(q);
                });
                _render();
            }

            function _render() {
                if (!_listEl) return;
                _listEl.innerHTML = '';
                const frag = document.createDocumentFragment();
                _queue.slice(0, MAX_ROWS).forEach(function (q) { frag.appendChild(_rowDom(q)); });
                if (_queue.length > MAX_ROWS) {
                    const more = document.createElement('div');
                    more.className = 'fm-up-more';
                    more.textContent = '… 还有 ' + (_queue.length - MAX_ROWS) + ' 个文件（仍会上传，只是不在这里列出）';
                    frag.appendChild(more);
                }
                _listEl.appendChild(frag);
                _emptyEl.style.display = _queue.length ? 'none' : 'flex';
                _clearEl.disabled = _busy || !_queue.length;
                _addFileEl.disabled = _busy;
                _addDirEl.disabled = _busy;
                _updateStart();
            }

            function _rowDom(q) {
                const row = document.createElement('div');
                row.className = 'fm-up-row';
                row.dataset.state = q.state;
                row.title = q.rel;
                row.innerHTML =
                    '<span class="fm-up-name"><i class="bi bi-file-earmark"></i><b></b></span>' +
                    '<span class="fm-up-size"></span>' +
                    '<span class="fm-up-state"></span>' +
                    '<span class="fm-up-op"></span>';
                row.querySelector('.fm-up-name b').textContent = q.rel;
                row.querySelector('.fm-up-size').textContent = formatSize(q.size);
                q.el = row;
                _paint(q);
                return row;
            }

            // 只刷新单行，上传过程中不整表重绘（避免闪烁 / 滚动跳）
            // 注意：_rowDom 里是「先 paint 再插入 DOM」，这里不能判断 parentNode
            function _paint(q) {
                const el = q.el;
                if (!el) return;
                el.dataset.state = q.state;
                const st = el.querySelector('.fm-up-state');
                if (q.state === 'up') {
                    _rowProgress(q, (q.pct || 0) / 100);   // 上传中：这一列显示本文件进度条 + 百分比
                } else {
                    st.textContent = q.text;
                }
                const op = el.querySelector('.fm-up-op');
                if (q.state === 'wait' || q.state === 'fail' || q.state === 'skip') {
                    op.innerHTML = '<button type="button" class="fm-up-del">移除</button>';
                    op.firstChild.addEventListener('click', function () { _remove(q); });
                } else {
                    op.innerHTML = q.state === 'up'
                        ? '<button type="button" class="fm-up-del" disabled>取消</button>'
                        : '';
                }
            }

            // 单文件进度：状态列里画一条 mini 进度条
            function _rowProgress(q, ratio) {
                const pct = Math.max(0, Math.min(100, Math.round(ratio * 100)));
                q.pct = pct;
                const el = q.el;
                if (!el) return;
                const st = el.querySelector('.fm-up-state');
                if (!st) return;
                if (!st.querySelector('.fm-up-mini')) {
                    st.innerHTML = '<i class="fm-up-mini"><b></b></i><em></em>';
                }
                st.querySelector('.fm-up-mini').firstElementChild.style.width = pct + '%';
                st.querySelector('em').textContent = pct + '%';
            }

            function _setState(q, state, text) {
                q.state = state;
                q.text = text;
                if (state !== 'up') q.pct = 0;
                _paint(q);
            }

            function _remove(q) {
                if (_busy) return;
                _queue = _queue.filter(function (x) { return x !== q; });
                _render();
            }

            function _updateStart() {
                if (!_startEl) return;
                if (_busy) {
                    _startEl.disabled = true;
                    _startEl.textContent = '上传中…';
                    _startEl.dataset.mode = '';
                    return;
                }
                const wait = _queue.filter(function (q) { return q.state === 'wait'; });
                _startEl.disabled = false;
                if (_queue.length && !wait.length && !_dirs.length) {
                    _startEl.textContent = '完成';
                    _startEl.dataset.mode = 'close';
                    return;
                }
                _startEl.textContent = wait.length ? ('开始上传' + (wait.length !== _queue.length ? '（' + wait.length + '）' : '')) : '开始上传';
                _startEl.dataset.mode = 'start';
                if (!_queue.length && !_dirs.length) _startEl.disabled = true;
            }

            function _progress(done, total) {
                const pct = total ? Math.min(100, done / total * 100) : 100;
                _barEl.classList.add('on');
                _fillEl.style.width = pct.toFixed(1) + '%';
                _pctEl.textContent = Math.round(pct) + '%';
            }

            // ---------- 统计栏（上传大小 / 耗时 / 速度 / 成功数） ----------
            function _fmtSec(sec) {
                sec = Math.max(0, sec || 0);
                if (sec < 60) return sec.toFixed(sec < 10 ? 1 : 0) + '秒';
                const m = Math.floor(sec / 60), s = Math.round(sec % 60);
                return m + '分' + (s ? s + '秒' : '');
            }

            // 速度统一保留两位小数（formatSize 对 <1KB 直接拼接原值，浮点速度会露出 185.3612167297098 这种尾巴）
            function _fmtSpeed(v) {
                v = Number(v) || 0;
                if (v <= 0) return '0 B/s';
                if (v < 1024) return v.toFixed(2) + ' B/s';
                if (v < 1024 * 1024) return (v / 1024).toFixed(2) + ' KB/s';
                if (v < 1024 * 1024 * 1024) return (v / 1024 / 1024).toFixed(2) + ' MB/s';
                return (v / 1024 / 1024 / 1024).toFixed(2) + ' GB/s';
            }

            function _renderStat() {
                if (!_statEl) return;
                const s = _st;
                if (!s) {
                    // 还没开始上传过：整条统计栏直接收起来，别显示一堆 0
                    _statEl.innerHTML = '';
                    _statEl.style.display = 'none';
                    return;
                }
                _statEl.style.display = '';
                const total = _total || 0;
                const done = Math.min(s.done || 0, total);
                const elapsed = s.start ? ((s.end || performance.now()) - s.start) / 1000 : 0;
                if (_busy && s.start) {
                    const pct = total ? Math.round(done / total * 100) : 100;
                    // 超过 2 秒没有新字节（网络卡 / 小文件间隙）就把速度压到 0，别一直显示旧值
                    if (s.speed && s.lastT && (performance.now() - s.lastT) > 2000) s.speed = 0;
                    const left = s.speed > 0 ? Math.max(0, (total - done) / s.speed) : 0;
                    _statEl.innerHTML =
                        '<span>总进度: <b>' + pct + '%</b> <em>(' + formatSize(done) +
                            ' / ' + formatSize(total) + ')</em></span>' +
                        '<span>正在上传: <b>(' + (s.up || 0) + '/' + (s.total || 0) + ')</b></span>' +
                        '<span>上传速度: <b>' + _fmtSpeed(s.speed) + '</b></span>' +
                        '<span>已用时: <b>' + _fmtSec(elapsed) + '</b></span>' +
                        (left ? '<span>预计剩余: <b>' + _fmtSec(left) + '</b></span>' : '');
                    return;
                }
                const avg = elapsed > 0 ? ((s.size || 0) / elapsed) : 0;
                _statEl.innerHTML =
                    '<span>上传大小: <b>' + formatSize(s.size || 0) + '</b></span>' +
                    '<span>共耗时: <b>' + (s.start ? _fmtSec(elapsed) : '0 秒') + '</b></span>' +
                    '<span>平均上传速度: <b>' + _fmtSpeed(avg) + '</b></span>' +
                    '<span>上传成功: <b>' + (s.ok || 0) + ' 个</b></span>' +
                    (s.fail ? '<span>失败: <b class="fm-up-bad">' + s.fail + ' 个</b></span>' : '') +
                    (s.skip ? '<span>跳过: <b>' + s.skip + ' 个</b></span>' : '');
            }

            function _refreshStatSoon() {
                if (_statTimer) return;
                _statTimer = setTimeout(function () { _statTimer = 0; _renderStat(); }, 250);
            }

            // ---------- 同名冲突检测（参考宝塔：跳过 / 覆盖） ----------
            function _checkConflicts(list) {
                return _postForm('/api/files/upload_check', {
                    dir: _dir,
                    keep_structure: '1',
                    rels: JSON.stringify(list.map(function (q) { return q.rel; })),
                });
            }

            // 冲突确认弹窗：resolve('cover' | 'skip' | 'cancel')
            function _confirmConflict(conflicts) {
                return new Promise(function (resolve) {
                    const tbody = _cfMask.querySelector('tbody');
                    tbody.innerHTML = '';
                    conflicts.forEach(function (c) {
                        const tr = document.createElement('tr');
                        const td1 = document.createElement('td');
                        td1.textContent = '/' + c.path;
                        td1.title = c.path;
                        const td2 = document.createElement('td');
                        td2.textContent = formatSize(c.local_size || 0) + ' → ' +
                            (c.is_dir ? '文件夹' : formatSize(c.online_size || 0));
                        tr.appendChild(td1);
                        tr.appendChild(td2);
                        tbody.appendChild(tr);
                    });
                    _cfMask.classList.add('on');
                    const finish = function (act) {
                        _cfMask.classList.remove('on');
                        _cfCoverEl.removeEventListener('click', onCover);
                        _cfSkipEl.removeEventListener('click', onSkip);
                        _cfXEl.removeEventListener('click', onCancel);
                        resolve(act);
                    };
                    const onCover = function () { finish('cover'); };
                    const onSkip = function () { finish('skip'); };
                    const onCancel = function () { finish('cancel'); };
                    _cfCoverEl.addEventListener('click', onCover);
                    _cfSkipEl.addEventListener('click', onSkip);
                    _cfXEl.addEventListener('click', onCancel);
                });
            }

            // 单次上传：返回 { uploaded: [相对路径], skipped: [{name, reason}] }
            function _postBatch(batch, dir, dirs, onProgress) {
                return new Promise(function (resolve, reject) {
                    const fd = new FormData();
                    batch.forEach(function (q) { fd.append('files', q.file, q.file.name); });
                    batch.forEach(function (q) { fd.append('paths', q.rel); });
                    fd.append('dir', dir);
                    fd.append('keep_structure', '1');
                    (dirs || []).forEach(function (d) { fd.append('dirs', d); });
                    const xhr = new XMLHttpRequest();
                    xhr.open('POST', '/api/files/upload');
                    xhr.upload.onprogress = function (ev) {
                        if (ev.lengthComputable) onProgress(ev.loaded, ev.total);
                    };
                    xhr.onload = function () {
                        let d = null;
                        try { d = JSON.parse(xhr.responseText); } catch (e) { /* 非 JSON（如 413 页面） */ }
                        if (xhr.status >= 200 && xhr.status < 300 && d && d.success) resolve(d);
                        else reject(new Error((d && d.error) || ('HTTP ' + xhr.status)));
                    };
                    xhr.onerror = function () { reject(new Error('网络错误，上传中断')); };
                    xhr.onabort = function () { reject(new Error('上传已取消')); };
                    xhr.send(fd);
                });
            }

            // ====================== 断点续传（分片上传） ======================
            const CHUNK = 4 * 1024 * 1024;     // 每片 4MB

            // 普通 form POST：用于查断点 / 合并 / 建空目录
            function _postForm(url, fields) {
                return new Promise(function (resolve, reject) {
                    const fd = new FormData();
                    Object.keys(fields).forEach(function (k) {
                        const v = fields[k];
                        if (Array.isArray(v)) v.forEach(function (x) { fd.append(k, x); });
                        else fd.append(k, v);
                    });
                    fetch(url, { method: 'POST', body: fd, credentials: 'same-origin' })
                        .then(function (r) { return r.json().then(function (d) { return { r: r, d: d }; }); })
                        .then(function (o) {
                            if (o.r.ok && o.d && o.d.success) resolve(o.d);
                            else reject(new Error((o.d && o.d.error) || ('HTTP ' + o.r.status)));
                        })
                        .catch(function (e) { reject(e); });
                });
            }

            function _resumeStatus(q, dir) {
                return _postForm('/api/files/upload_status', {
                    rel: q.rel, size: q.size, mtime: q.file.lastModified || 0, dir: dir,
                });
            }

            function _uploadChunk(q, index, total, blob, onProgress) {
                return new Promise(function (resolve, reject) {
                    const fd = new FormData();
                    fd.append('rel', q.rel);
                    fd.append('size', q.size);
                    fd.append('mtime', q.file.lastModified || 0);
                    fd.append('index', index);
                    fd.append('total', total);
                    fd.append('chunk', blob, q.file.name);
                    const xhr = new XMLHttpRequest();
                    xhr.open('POST', '/api/files/upload_chunk');
                    xhr.upload.onprogress = function (ev) {
                        if (ev.lengthComputable) onProgress(ev.loaded, ev.total);
                    };
                    xhr.onload = function () {
                        let d = null;
                        try { d = JSON.parse(xhr.responseText); } catch (e) { }
                        if (xhr.status >= 200 && xhr.status < 300 && d && d.success) resolve(d);
                        else reject(new Error((d && d.error) || ('HTTP ' + xhr.status)));
                    };
                    xhr.onerror = function () { reject(new Error('网络错误，分片上传中断')); };
                    xhr.send(fd);
                });
            }

            function _merge(q, dir, total, overwrite, costMs) {
                return _postForm('/api/files/upload_merge', {
                    rel: q.rel, size: q.size, mtime: q.file.lastModified || 0,
                    total: total, dir: dir, keep_structure: '1',
                    overwrite: overwrite ? '1' : '0',    // 用户选了「覆盖」时不再自动改名 -1
                    cost_ms: Math.max(0, Math.round(costMs || 0)),   // 单文件耗时，写进上传记录
                });
            }

            // 单个文件：先查断点（已接收分片），只传缺失分片，最后 merge
            async function _uploadFile(q, dir, fileBytes, inflightCur, flush, overwrite) {
                const t0 = performance.now();
                const total = Math.max(1, Math.ceil(q.size / CHUNK));
                const st = await _resumeStatus(q, dir);
                const received = new Set(st.received || []);
                let base = 0;                       // 已落盘分片折算的字节，作为进度起点
                for (let i = 0; i < total; i++) {
                    if (received.has(i)) base += Math.min(CHUNK, q.size - i * CHUNK);
                }
                fileBytes.set(q, base);
                for (let i = 0; i < total; i++) {
                    if (received.has(i)) continue;
                    const start = i * CHUNK, end = Math.min(q.size, start + CHUNK);
                    let tries = 0;
                    while (true) {
                        tries++;
                        try {
                            inflightCur.set(q, 0);
                            await _uploadChunk(q, i, total, q.file.slice(start, end), function (loaded) {
                                inflightCur.set(q, Math.min(end - start, loaded));
                                const done = fileBytes.get(q) + (inflightCur.get(q) || 0);
                                _rowProgress(q, q.size ? done / q.size : 1);
                                flush();
                            });
                            break;
                        } catch (e) {
                            if (tries >= 3) throw e;   // 单片最多重试 3 次，还不行就整文件失败
                        }
                    }
                    fileBytes.set(q, (fileBytes.get(q) || 0) + (end - start));
                    inflightCur.delete(q);
                    _rowProgress(q, q.size ? fileBytes.get(q) / q.size : 1);
                }
                const d = await _merge(q, dir, total, overwrite, performance.now() - t0);
                return d;
            }

            async function _start() {
                let pending = _queue.filter(function (q) { return q.state === 'wait'; });
                if (!pending.length && !_dirs.length) {
                    showToast('提示', '列表里没有待上传的文件', 'warning');
                    return;
                }

                // ---- 同名冲突检测：先问「跳过 / 覆盖」（参考宝塔） ----
                let overwrite = false;
                const skipRels = new Set();
                if (pending.length) {
                    let conflicts = [];
                    try {
                        const res = await _checkConflicts(pending);
                        conflicts = res.conflicts || [];
                    } catch (e) { conflicts = []; }
                    if (conflicts.length) {
                        const localMap = new Map();
                        pending.forEach(function (q) { localMap.set(q.rel, q.size); });
                        conflicts.forEach(function (c) { c.local_size = localMap.get(c.rel) || 0; });
                        const act = await _confirmConflict(conflicts);
                        if (act === 'cancel') return;               // 关闭弹窗 = 这次不传
                        if (act === 'cover') overwrite = true;
                        else conflicts.forEach(function (c) { skipRels.add(c.rel); });
                    }
                }
                const skipped = [];
                if (skipRels.size) {
                    pending = pending.filter(function (q) { return !skipRels.has(q.rel); });
                    skipRels.forEach(function (rel) {
                        const q = _queue.find(function (x) { return x.rel === rel; });
                        if (q) {
                            _setState(q, 'skip', '已跳过');
                            skipped.push({ name: rel, reason: '同名文件，已跳过' });
                        }
                    });
                }
                if (!pending.length && !_dirs.length) {
                    _titleEl.textContent = '已跳过重复文件';
                    showToast('已跳过', '列表里的文件在目标目录都已存在', 'warning');
                    _updateStart();
                    return;
                }

                _busy = true;
                _total = pending.reduce(function (s, q) { return s + q.size; }, 0);
                _st = {
                    size: _total, ok: 0, fail: 0, skip: skipRels.size,
                    done: 0, speed: 0, lastT: 0, lastB: 0,
                    start: performance.now(), end: 0,
                    total: pending.length, up: 0,
                };
                _barEl.classList.add('on');
                _progress(0, _total);
                _renderStat();
                _startEl.disabled = true;
                _startEl.textContent = '上传中…';
                _addFileEl.disabled = true;
                _addDirEl.disabled = true;
                _clearEl.disabled = true;
                // 上传期间每 400ms 刷一次统计条：「速度 / 已用时 / 预计剩余」必须一直在动，
                // 不能只靠分片回调（0 字节文件或网络卡住时没有回调，看起来就像不显示）
                const statTick = setInterval(_renderStat, 400);

                const uploaded = [];
                const fileBytes = new Map();     // 进行中的文件 → 已确认字节（含断点已存在分片）
                const inflightCur = new Map();   // 进行中的文件 → 当前分片在传字节
                let doneTotal = 0;               // 已完成文件的总字节（不再计入 fileBytes）
                let dirsPending = _dirs.slice();
                const flush = function () {
                    let s = doneTotal;
                    fileBytes.forEach(function (v) { s += v; });
                    inflightCur.forEach(function (v) { s += v; });
                    const done = Math.min(s, _total);
                    _progress(done, _total);
                    if (_st) {
                        _st.done = done;
                        const now = performance.now();
                        if (!_st.lastT) { _st.lastT = now; _st.lastB = done; }
                        const dt = (now - _st.lastT) / 1000;
                        if (dt >= 0.3) {                      // 300ms 窗口算一次瞬时速度，再做平滑
                            const inst = Math.max(0, (done - _st.lastB) / dt);
                            _st.speed = _st.speed ? (_st.speed * 0.6 + inst * 0.4) : inst;
                            _st.lastT = now;
                            _st.lastB = done;
                        }
                    }
                    _refreshStatSoon();
                };

                try {
                    // 只加了空文件夹：单独发一次请求把目录建出来
                    if (!pending.length && dirsPending.length) {
                        await _postBatch([], _dir, dirsPending, function () { });
                        dirsPending = [];
                    }

                    // 逐文件分片续传（并发 3）：每个文件有自己独立的进度，且支持断点续传
                    let cursor = 0;
                    const worker = async function () {
                        while (cursor < pending.length) {
                            const q = pending[cursor++];
                            if (q.state !== 'wait') continue;      // 已被取消 / 标记失败
                            const dirs = dirsPending;              // 空目录只在第一个文件上传前建一次
                            dirsPending = [];
                            _setState(q, 'up', '上传中');
                            if (_st) { _st.up = (_st.up || 0) + 1; _renderStat(); }
                            if (dirs.length) {
                                await _postBatch([], _dir, dirs, function () { }).catch(function () { });
                            }
                            const tFile = performance.now();
                            try {
                                const d = await _uploadFile(q, _dir, fileBytes, inflightCur, flush, overwrite);
                                _setState(q, 'done', '已完成');
                                doneTotal += q.size;
                                if (_st) _st.ok = (_st.ok || 0) + 1;
                                (d.uploaded || []).forEach(function (r) { if (uploaded.indexOf(r) < 0) uploaded.push(r); });
                            } catch (err) {
                                // 单个失败不影响其它文件，行上直接标原因；已传分片保留在磁盘，可重试续传
                                const reason = (err && err.message) ? err.message : '上传失败';
                                _setState(q, 'fail', reason);
                                if (_st) _st.fail = (_st.fail || 0) + 1;
                                skipped.push({ name: q.rel, reason: reason });
                                // 失败也写一条上传记录（分片中断不会走到 merge，所以这里单独上报）
                                _postForm('/api/files/upload_record_fail', {
                                    rel: q.rel, size: q.size, dir: _dir,
                                    cost_ms: Math.round(performance.now() - tFile), error: reason,
                                }).catch(function () { });
                            } finally {
                                if (_st) _st.up = Math.max(0, (_st.up || 0) - 1);
                                fileBytes.delete(q);
                                inflightCur.delete(q);
                                flush();
                            }
                        }
                    };
                    const workers = [];
                    const n = Math.max(1, Math.min(3, pending.length));
                    for (let i = 0; i < n; i++) workers.push(worker());
                    await Promise.all(workers);

                    // ---- 本地插入顶层条目，不整目录重新请求 ----
                    const base = _dir.replace(/[\\/]+$/, '');
                    const topDirs = new Set();
                    _dirs.forEach(function (d) { if (d) topDirs.add(d.split('/')[0]); });
                    uploaded.forEach(function (rel) {
                        const seg = rel.split('/');
                        if (seg.length > 1) topDirs.add(seg[0]);
                    });
                    topDirs.forEach(function (name) {
                        if (!fileItems.some(function (it) { return it.is_dir && it.name === name; })) {
                            localAddItem({
                                path: base + '/' + name, name: name, is_dir: true,
                                size: 0, size_str: '-', mtime: _nowStr(), ext: '',
                            });
                        }
                    });
                    uploaded.forEach(function (rel) {
                        if (rel.indexOf('/') >= 0) return;        // 子目录里的文件不在当前层显示
                        if (fileItems.some(function (it) { return !it.is_dir && it.name === rel; })) return;
                        const ext = rel.indexOf('.') > 0 ? rel.split('.').pop().toLowerCase() : '';
                        const src = _queue.find(function (q) { return q.rel === rel; });
                        localAddItem({
                            path: base + '/' + rel, name: rel, is_dir: false,
                            size: src ? src.size : 0,
                            size_str: src ? formatSize(src.size) : '-',
                            mtime: _nowStr(), ext: ext,
                        });
                    });

                    _dirs = [];          // 目录已建好，重试时不必再发
                    if (uploaded.length) {
                        showToast('上传完成', '已上传 ' + uploaded.length + ' 个文件到 ' + base, 'success');
                    }
                    if (skipped.length) {
                        showToast('部分未上传', _skipText(skipped), 'warning');
                    }
                    if (!skipped.length && _queue.every(function (q) { return q.state === 'done'; })) {
                        _titleEl.textContent = '上传完成';
                    } else {
                        _titleEl.textContent = skipped.length ? '上传结束（有跳过）' : '上传结束';
                    }
                } catch (err) {
                    const msg = (err && err.message) ? err.message : String(err);
                    _titleEl.textContent = '上传失败';
                    // 未传完的退回「待重试」，点「开始上传」即可重传，不用重新拖一遍
                    _queue.forEach(function (q) {
                        if (q.state === 'up') _setState(q, 'wait', '待重试');
                    });
                    showToast('上传失败', msg, 'danger');
                } finally {
                    clearInterval(statTick);
                    _busy = false;
                    if (_st) _st.end = performance.now();
                    flush();
                    _renderStat();
                    // 上传记录抽屉开着的话，让它拉一次最新记录（否则刚传完看不到新条目）
                    if (window.__uprRefreshIfOpen) window.__uprRefreshIfOpen();
                    _addFileEl.disabled = false;
                    _addDirEl.disabled = false;
                    _clearEl.disabled = !_queue.length;
                    _updateStart();
                }
            }

            function _skipText(skipped) {
                return skipped.slice(0, 3).map(function (s) { return s.name + '：' + s.reason; }).join('；') +
                    (skipped.length > 3 ? ' 等 ' + skipped.length + ' 个' : '');
            }

            // ---------- 递归展开拖入的 entry（文件夹） ----------
            function _collect(dt) {
                const entries = [];
                const items = Array.prototype.slice.call((dt && dt.items) || []);
                items.forEach(function (it) {
                    const en = it.webkitGetAsEntry && it.webkitGetAsEntry();
                    if (en) entries.push(en);
                });
                if (!entries.length) {
                    // 老浏览器没有 webkitGetAsEntry：退化成「只有文件、平铺上传」
                    return Promise.resolve({
                        files: Array.prototype.slice.call((dt && dt.files) || []).map(function (f) {
                            return { file: f, rel: f.name };
                        }),
                        dirs: [],
                    });
                }
                return _walk(entries);
            }

            async function _walk(entries) {
                const out = { files: [], dirs: [] };
                async function step(entry) {
                    if (!entry) return;
                    if (entry.isFile) {
                        const file = await new Promise(function (res, rej) { entry.file(res, rej); });
                        out.files.push({ file: file, rel: (entry.fullPath || file.name).replace(/^\/+/, '') });
                        return;
                    }
                    if (!entry.isDirectory) return;
                    out.dirs.push((entry.fullPath || entry.name).replace(/^\/+/, ''));
                    const reader = entry.createReader();
                    // readEntries 每次最多给 100 条，必须循环读到空，否则大文件夹会漏文件
                    while (true) {
                        const batch = await new Promise(function (res, rej) { reader.readEntries(res, rej); });
                        if (!batch || !batch.length) break;
                        for (let i = 0; i < batch.length; i++) await step(batch[i]);
                    }
                }
                for (let i = 0; i < entries.length; i++) await step(entries[i]);
                return out;
            }

            async function _handleDrop(dt) {
                if (_collecting) return;
                _collecting = true;
                try {
                    const collected = await _collect(dt);
                    if (!collected.files.length && !collected.dirs.length) {
                        showToast('提示', '没有读到文件（空文件夹也支持，可再试一次）', 'warning');
                        return;
                    }
                    if (!currentPath) { showToast('提示', '当前没有打开的目录', 'warning'); return; }
                    if (_mask && _mask.classList.contains('on') && _queue.length && _dir !== currentPath) {
                        showToast('提示', '列表里的文件目标目录是 ' + _dir + '，请先上传或清空列表', 'warning');
                        return;
                    }
                    if (!_openDlg()) return;
                    _addItems(collected.files, collected.dirs);
                    showToast('已加入上传列表',
                        '共 ' + collected.files.length + ' 个文件' +
                        (collected.dirs.length ? '、' + collected.dirs.length + ' 个文件夹' : '') +
                        '，点「开始上传」后才会写入', 'info');
                } catch (err) {
                    showToast('读取失败', (err && err.message) ? err.message : String(err), 'danger');
                } finally {
                    _collecting = false;
                }
            }

            function _bind() {
                const zone = document.querySelector('.file-table');
                if (!zone) return;
                zone.addEventListener('dragenter', function (e) {
                    if (!_isFileDrag(e)) return;
                    e.preventDefault();
                    _depth++;
                    _showHint();
                });
                zone.addEventListener('dragover', function (e) {
                    if (!_isFileDrag(e)) return;
                    e.preventDefault();                       // 必须阻止默认行为，drop 才会触发
                    if (e.dataTransfer) e.dataTransfer.dropEffect = (_collecting || _busy) ? 'none' : 'copy';
                });
                zone.addEventListener('dragleave', function (e) {
                    if (!_isFileDrag(e)) return;
                    _depth = Math.max(0, _depth - 1);
                    if (!_depth) _hideHint();
                });
                zone.addEventListener('drop', function (e) {
                    if (!_isFileDrag(e)) return;
                    e.preventDefault();
                    e.stopPropagation();
                    _depth = 0;
                    _hideHint();
                    if (_busy) { showToast('提示', '正在上传，请等这一批完成', 'warning'); return; }
                    // entries 必须在 drop 的同步阶段取，异步之后 dataTransfer 就失效了
                    _handleDrop(e.dataTransfer);
                });
                // 拖到区域外松手：别让浏览器直接把本地文件打开（整页被文件内容替换）
                window.addEventListener('dragover', function (e) { if (_isFileDrag(e)) e.preventDefault(); });
                window.addEventListener('drop', function (e) { if (_isFileDrag(e)) { e.preventDefault(); _depth = 0; _hideHint(); } });
                // 拖出浏览器窗口（或按 Esc 取消）：收起提示
                window.addEventListener('dragleave', function (e) {
                    if (!_isFileDrag(e)) return;
                    if (!e.relatedTarget) { _depth = 0; _hideHint(); }
                });
            }

            _bind();
        })();

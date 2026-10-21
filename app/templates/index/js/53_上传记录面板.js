        // ========== 上传记录（右侧抽屉，顶栏「上传记录」打开） ==========
        (function () {
            const PAGE_SIZE = 50;
            const DEF_W = 780;

            let _built = false;
            let _open = false;
            let _page = 1, _pages = 1, _kw = '', _status = '';
            let _searchTimer = 0;

            function $(id) { return document.getElementById(id); }

            function fmtCost(ms) {
                ms = Number(ms) || 0;
                if (ms < 1000) return ms + ' ms';
                const s = ms / 1000;
                if (s < 60) return s.toFixed(1) + ' 秒';
                return Math.floor(s / 60) + ' 分 ' + Math.round(s % 60) + ' 秒';
            }

            function esc(s) {
                return String(s == null ? '' : s)
                    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
            }

            function build() {
                if (_built) return;
                _built = true;

                const dr = document.createElement('div');
                dr.id = 'upRecDrawer';
                dr.innerHTML = `
                    <div class="upr-resizer" title="拖动调整宽度（双击复位）"></div>
                    <div class="upr-head">
                        <span class="upr-title"><i class="bi bi-cloud-arrow-up"></i> 上传记录</span>
                        <span class="upr-sub">最多保留最近 3000 条</span>
                        <span class="upr-hbtns">
                            <button class="upr-hbtn" id="uprRefresh" title="刷新"><i class="bi bi-arrow-clockwise"></i></button>
                            <button class="upr-hbtn upr-danger" id="uprClear" title="清空上传记录"><i class="bi bi-trash3"></i></button>
                            <button class="upr-hbtn" id="uprClose" title="关闭"><i class="bi bi-x-lg"></i></button>
                        </span>
                    </div>
                    <div class="upr-body">
                        <div class="upr-stats">
                            <div class="upr-stat"><span>全部记录</span><b id="uprStTotal">0</b></div>
                            <div class="upr-stat ok"><span>上传成功</span><b id="uprStOk">0</b></div>
                            <div class="upr-stat fail"><span>上传失败</span><b id="uprStFail">0</b></div>
                            <div class="upr-stat"><span>累计大小</span><b id="uprStBytes">0 B</b></div>
                        </div>
                        <div class="upr-list">
                            <div class="upr-tools">
                                <div class="upr-search">
                                    <i class="bi bi-search"></i>
                                    <input id="uprKw" type="text" placeholder="搜索文件名 / 路径 / 目录">
                                </div>
                                <select id="uprStatus">
                                    <option value="">全部状态</option>
                                    <option value="ok">仅成功</option>
                                    <option value="fail">仅失败</option>
                                </select>
                                <span class="upr-count" id="uprCount">共 0 条</span>
                            </div>
                            <div class="upr-tblwrap">
                                <table>
                                    <thead>
                                        <tr>
                                            <th style="width:126px">上传时间</th>
                                            <th>文件名 / 目标目录</th>
                                            <th style="width:76px">大小</th>
                                            <th style="width:74px">耗时</th>
                                            <th style="width:62px">状态</th>
                                            <th style="width:84px">上传者</th>
                                        </tr>
                                    </thead>
                                    <tbody id="uprTbody"></tbody>
                                </table>
                                <div class="upr-empty" id="uprEmpty" hidden>
                                    <i class="bi bi-inbox"></i>
                                    <p>还没有上传记录</p>
                                </div>
                            </div>
                            <div class="upr-pager">
                                <button id="uprPrev"><i class="bi bi-chevron-left"></i> 上一页</button>
                                <span class="upr-pageinfo" id="uprPageInfo">1 / 1</span>
                                <button id="uprNext">下一页 <i class="bi bi-chevron-right"></i></button>
                            </div>
                        </div>
                    </div>`;
                document.body.appendChild(dr);

                $('uprClose').addEventListener('click', close);
                $('uprRefresh').addEventListener('click', function () { load(); });
                $('uprPrev').addEventListener('click', function () { if (_page > 1) { _page--; load(); } });
                $('uprNext').addEventListener('click', function () { if (_page < _pages) { _page++; load(); } });
                $('uprClear').addEventListener('click', onClear);
                // 点记录行（文件名那一列）→ 左侧跳到该文件位置并高亮
                $('uprTbody').addEventListener('click', function (e) {
                    const tr = e.target.closest('tr[data-dir]');
                    if (!tr || !tr.dataset.dir) return;
                    jumpTo(tr.dataset.path || '', tr.dataset.dir, tr);
                });
                $('uprKw').addEventListener('input', function (e) {
                    clearTimeout(_searchTimer);
                    const v = e.target.value;
                    _searchTimer = setTimeout(function () { _kw = v.trim(); _page = 1; load(); }, 280);
                });
                $('uprStatus').addEventListener('change', function (e) {
                    _status = e.target.value; _page = 1; load();
                });

                // 左边缘拖动改宽度，双击复位
                const rz = dr.querySelector('.upr-resizer');
                let dragging = false, startX = 0, startW = 0;
                rz.addEventListener('mousedown', function (e) {
                    e.preventDefault();
                    dragging = true;
                    startX = e.clientX;
                    startW = dr.getBoundingClientRect().width;
                    dr.classList.add('resizing');
                    document.body.style.userSelect = 'none';
                });
                document.addEventListener('mousemove', function (e) {
                    if (!dragging) return;
                    const w = Math.min(Math.max(420, startW + (startX - e.clientX)), window.innerWidth - 40);
                    dr.style.width = w + 'px';
                });
                document.addEventListener('mouseup', function () {
                    if (!dragging) return;
                    dragging = false;
                    dr.classList.remove('resizing');
                    document.body.style.userSelect = '';
                });
                rz.addEventListener('dblclick', function () { dr.style.width = DEF_W + 'px'; });

                document.addEventListener('keydown', function (e) {
                    if (e.key === 'Escape' && _open) close();
                });
            }

            function renderStats(st) {
                st = st || {};
                $('uprStTotal').textContent = st.total || 0;
                $('uprStOk').textContent = st.ok || 0;
                $('uprStFail').textContent = st.fail || 0;
                $('uprStBytes').textContent = formatSize(st.bytes || 0);
            }

            // 状态标签：已删除 > 成功 / 失败
            function _stTag(it) {
                if (it.missing) {
                    return '<span class="upr-tag gone" title="文件已不在原位置">已删除</span>';
                }
                if (it.ok) return '<span class="upr-tag ok">成功</span>';
                return '<span class="upr-tag fail" title="' + esc(it.error || '上传失败') + '">失败</span>';
            }

            function renderRows(items) {
                const tb = $('uprTbody');
                tb.innerHTML = '';
                items.forEach(function (it) {
                    const tr = document.createElement('tr');
                    if (!it.ok) tr.className = 'bad';
                    const name = it.name || it.rel || '';
                    const dir = it.dir || '';
                    // 点这一行 = 左侧文件管理跳到该目录并高亮文件
                    tr.dataset.path = it.path || '';
                    tr.dataset.dir = dir;
                    tr.dataset.id = it.id || '';
                    tr.dataset.ok = it.ok ? '1' : '0';
                    tr.dataset.err = it.error || '';
                    tr.dataset.missing = it.missing ? '1' : '0';
                    if (it.missing) tr.classList.add('gone');
                    tr.innerHTML =
                        '<td class="upr-ts">' + esc(it.ts) + '</td>' +
                        '<td>' +
                            '<div class="upr-fn" title="' + esc(it.path || it.rel || name) + '">' + esc(name) + '</div>' +
                            '<div class="upr-fp" title="' + esc(dir) + '">' + esc(dir) + '</div>' +
                        '</td>' +
                        '<td class="upr-num">' + formatSize(it.size || 0) + '</td>' +
                        '<td class="upr-num">' + (it.ok ? fmtCost(it.cost_ms) : '-') + '</td>' +
                        '<td class="upr-st">' + _stTag(it) + '</td>' +
                        '<td class="upr-user" title="' + esc(it.ip || '') + '">' + esc(it.user || '-') + '</td>';
                    tb.appendChild(tr);
                });
                const empty = $('uprEmpty');
                empty.hidden = items.length > 0;
                empty.querySelector('p').textContent =
                    (_kw || _status) ? '没有符合条件的记录' : '还没有上传记录';
            }

            function renderPager() {
                $('uprPageInfo').textContent = _page + ' / ' + _pages;
                $('uprPrev').disabled = _page <= 1;
                $('uprNext').disabled = _page >= _pages;
            }

            async function load() {
                build();
                $('uprRefresh').disabled = true;
                const url = '/api/files/upload_records?page=' + _page + '&page_size=' + PAGE_SIZE +
                    '&q=' + encodeURIComponent(_kw) + '&status=' + encodeURIComponent(_status);
                let d = null;
                try {
                    const r = await fetch(url, { credentials: 'same-origin' });
                    d = await r.json();
                } catch (e) { d = null; }
                $('uprRefresh').disabled = false;

                if (!d || !d.success) {
                    $('uprTbody').innerHTML = '';
                    $('uprEmpty').hidden = false;
                    $('uprEmpty').querySelector('p').textContent = '读取上传记录失败，请稍后重试';
                    return;
                }
                const total = d.total || 0;
                _pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
                if (_page > _pages) { _page = _pages; return load(); }
                renderRows(d.items || []);
                renderStats(d.stats);
                $('uprCount').textContent = '共 ' + total + ' 条';
                renderPager();
            }

            async function onClear() {
                const btn = $('uprClear');
                const ok = await showConfirm(
                    '确定清空全部上传记录吗？<br>只清除这份记录列表，已上传的文件不受影响。');
                if (!ok) return;
                btn.disabled = true;
                fetch('/api/files/upload_records/clear', { method: 'POST', credentials: 'same-origin' })
                    .then(function (r) { return r.json(); })
                    .then(function (d) {
                        btn.disabled = false;
                        if (d && d.success) {
                            _page = 1;
                            load();
                            showToast('成功', '上传记录已清空', 'success');
                        } else {
                            showToast('失败', '清空失败，请稍后重试', 'warning');
                        }
                    })
                    .catch(function () {
                        btn.disabled = false;
                        showToast('失败', '清空失败，请检查网络', 'warning');
                    });
            }

            // 把某行标成 / 取消「已删除」，同时回写后端（重新打开也记得）
            function _markRow(tr, on) {
                if (!tr || !tr.parentNode) return;
                tr.dataset.missing = on ? '1' : '0';
                tr.classList.toggle('gone', !!on);
                const st = tr.querySelector('.upr-st');
                if (st) {
                    st.innerHTML = _stTag({
                        missing: on ? 1 : 0,
                        ok: tr.dataset.ok === '1',
                        error: tr.dataset.err || ''
                    });
                }
                const id = tr.dataset.id;
                if (!id) return;
                fetch('/api/files/upload_records/missing', {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: 'id=' + encodeURIComponent(id) + '&missing=' + (on ? 1 : 0)
                }).catch(function () { });
                if (on) showToast('提示', '该文件已不在原位置，已在记录里标记为「已删除」', 'warning');
            }

            // 路径比较：正反斜杠归一；再看一眼小写形式（宁可漏标，也别把还在的文件误标成已删除）
            function _samePath(a, b) {
                const n = function (p) {
                    return String(p == null ? '' : p).replace(/\\/g, '/')
                        .replace(/\/{2,}/g, '/').replace(/\/+$/, '');
                };
                const x = n(a), y = n(b);
                return !!x && (x === y || x.toLowerCase() === y.toLowerCase());
            }

            // fileItems 里的 path 是相对路径，这里还原成绝对路径再比
            function _itemAbsPath(f) {
                const p = String((f && f.path) || '');
                if (/^([A-Za-z]:[\\/]|[\\/])/.test(p)) return p;
                return currentPath ? currentPath.replace(/[\\/]+$/, '') + '/' + p : p;
            }

            // 高亮左侧列表里的某个文件并滚到可见（用 nearest，只挪必要的距离，避免整页跳动）
            function _flashRow(path) {
                if (!path) return false;
                const nodes = document.querySelectorAll('tr[data-path], .icon-item[data-path], .tree-line[data-path]');
                let el = null;
                for (const n of nodes) {
                    if (_samePath(n.dataset.path, path)) { el = n; break; }
                }
                if (!el) return false;
                try { el.scrollIntoView({ block: 'nearest', behavior: 'auto' }); } catch (e) { }
                el.classList.remove('fav-highlight');
                void el.offsetWidth;                 // 强制重排，让动画能重复触发
                el.classList.add('fav-highlight');
                setTimeout(function () {
                    document.querySelectorAll('.fav-highlight').forEach(function (n) { n.classList.remove('fav-highlight'); });
                }, 3000);
                return true;
            }

            let _goneTimer = 0;
            // 跳过去之后等列表加载完，再看文件还在不在：没了就标「已删除」
            function _watchGone(path, tr, flash) {
                if (!path || !tr) return;
                clearInterval(_goneTimer);
                const t0 = fileItems;
                const started = Date.now();
                _goneTimer = setInterval(function () {
                    const loaded = !_currentFetchController && fileItems !== t0;
                    if (!loaded && Date.now() - started < 15000) return;
                    clearInterval(_goneTimer);
                    if (!loaded) return;                 // 超时/目录回退：不猜，避免误标
                    if (!tr.parentNode) return;           // 行已被重新渲染
                    const hit = (fileItems || []).some(function (f) { return _samePath(_itemAbsPath(f), path); });
                    if (hit) {
                        if (flash) _flashRow(path);
                        if (tr.dataset.missing === '1') _markRow(tr, false);   // 文件又回来了
                    } else {
                        _markRow(tr, true);
                    }
                }, 200);
            }

            // 跳到左侧文件管理：打开文件所在目录并高亮该文件（抽屉不关闭，方便接着点下一条）
            // 高亮自己做（不用收藏夹那套 smooth+center 滚动），否则点一下整页会跟着滚/抖
            function jumpTo(path, dir, tr) {
                if (typeof navigateTo !== 'function') return;
                const p = path || '';
                const base = (dir || '').replace(/[\\/]+$/, '');
                // 上传文件夹时文件在子目录里：用文件自身路径的父目录，否则停在 dir 里根本找不到它
                let target = dir || '';
                if (p && base) {
                    const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
                    if (i > 0) {
                        const parent = p.slice(0, i);
                        if (_samePath(parent, base) || parent.indexOf(base + '/') === 0 || parent.indexOf(base + '\\') === 0) {
                            target = parent;
                        }
                    }
                }
                if (!target) return;
                if (_samePath(currentPath, target)) {
                    // 已经在这个目录里：直接高亮，不重新拉列表（重载会让整页闪一下，看着就是抖动）
                    if (!p) return;
                    const hit = (fileItems || []).some(function (f) { return _samePath(_itemAbsPath(f), p); });
                    if (hit) _flashRow(p);
                    else if (tr) _markRow(tr, true);
                    return;
                }
                navigateTo(target);
                _watchGone(p, tr, true);   // 等新目录加载完 → 高亮 + 校验是否还在
            }

            function open() {
                build();
                _open = true;
                $('upRecDrawer').classList.add('open');
                const btn = $('uploadRecordsBtn');
                if (btn) btn.classList.add('active');
                _page = 1;
                load();
            }

            function close() {
                _open = false;
                const dr = $('upRecDrawer');
                if (dr) dr.classList.remove('open');
                const btn = $('uploadRecordsBtn');
                if (btn) btn.classList.remove('active');
            }

            function toggle() {
                if (_open) close(); else open();
            }

            const btn = $('uploadRecordsBtn');
            if (btn) btn.addEventListener('click', toggle);

            // 供拖拽上传完成后调用：抽屉开着才刷新，关着不打扰
            window.__uprRefreshIfOpen = function () { if (_open) load(); };
        })();

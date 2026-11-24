        // ========== 全盘搜索 ==========
        let _searchToken = null;
        let _searchPollTimer = null;
        let _searchRunning = false;
        let _searchStartTime = 0;
        let _searchFailCount = 0;

        function showSearchModal() {
            const container = document.getElementById('searchContainer');
            const overlay = document.getElementById('searchOverlay');

            // 已存在则直接显示（保留历史搜索结果）
            if (overlay) {
                overlay.style.display = 'flex';
                const collBtn = document.getElementById('searchCollapsedBtn');
                if (collBtn) collBtn.style.display = 'none';
                return;
            }

            container.innerHTML = `
            <div class="search-float-overlay" id="searchOverlay">
                <div class="search-modal">
                    <div class="search-header">
                        <span class="search-title"><i class="bi bi-search"></i> 全盘搜索<span class="search-subtitle">基于本地索引，毫秒级响应</span></span>
                        <button class="search-close" id="searchCloseBtn" title="收起至右上角"><i class="bi bi-arrows-angle-contract"></i> 收起</button>
                    </div>
                    <div class="search-body">
                        <div class="search-params">
                            <div class="search-field search-field-root">
                                <label for="searchRootInput"><i class="bi bi-folder2-open"></i> 搜索范围</label>
                                <input type="text" id="searchRootInput" placeholder="根目录，默认系统盘 /" spellcheck="false" />
                            </div>
                            <div class="search-field search-field-key">
                                <label for="searchKeyInput"><i class="bi bi-search"></i> 关键字</label>
                                <input type="text" id="searchKeyInput" placeholder="输入文件名片段后按 Enter" spellcheck="false" />
                            </div>
                            <div class="search-field search-field-type">
                                <label for="searchTypeFilter"><i class="bi bi-funnel"></i> 类型</label>
                                <select id="searchTypeFilter">
                                    <option value="">全部</option>
                                    <option value="文件">文件</option>
                                    <option value="目录">目录</option>
                                </select>
                            </div>
                            <div class="search-field search-field-actions">
                                <div class="search-view-switch" id="searchViewSwitch">
                                    <button class="sv-btn active" data-view="list" title="列表视图"><i class="bi bi-list"></i></button>
                                    <button class="sv-btn" data-view="icon" title="图标视图"><i class="bi bi-grid-3x3-gap"></i></button>
                                </div>
                                <button class="btn btn-run" id="searchRunBtn"><i class="bi bi-search"></i> 搜索</button>
                                <button class="btn btn-clear" id="searchClearBtn" title="清空关键字与结果"><i class="bi bi-x-circle"></i> 清空</button>
                            </div>
                        </div>
                        <div class="search-meta">
                            <span class="meta-item meta-status" id="searchStatusMeta"><span class="text-muted">等待搜索...</span></span>
                            <span class="meta-sep"></span>
                            <span class="meta-item"><i class="bi bi-clock"></i> 耗时 <strong id="searchDuration">--</strong>s</span>
                            <span class="meta-sep"></span>
                            <span class="meta-item"><i class="bi bi-list-ul"></i> 命中 <strong id="searchCount">0</strong></span>
                            <span class="meta-sep"></span>
                            <span class="meta-item"><i class="bi bi-folder2"></i> 文件夹 <strong id="searchDirCount">0</strong></span>
                            <span class="meta-sep"></span>
                            <span class="meta-item"><i class="bi bi-file-earmark"></i> 文件 <strong id="searchFileCount">0</strong></span>
                            <span class="meta-sep"></span>
                            <span class="meta-item"><i class="bi bi-database"></i> 来源 <strong id="searchSource">--</strong></span>
                        </div>
                    </div>
                    <div class="search-progress" id="searchProgress"><div class="search-progress-bar"></div></div>
                    <div class="search-batch" id="searchBatch" style="display:none;">
                        <div class="batch-left">
                            <span><i class="bi bi-check2-square"></i> 已选 <span class="batch-count" id="batchCount">0</span> 项</span>
                            <span class="batch-note">点击「批量打开」跳转到第一个文件所在目录</span>
                        </div>
                        <div class="batch-right">
                            <button class="batch-open" id="batchOpenBtn" disabled><i class="bi bi-folder2-open"></i> 批量打开所在位置</button>
                            <button class="batch-deselect" id="batchDeselectBtn" title="清空勾选并退出顺序浏览"><i class="bi bi-x-square"></i> 取消</button>
                        </div>
                    </div>
                    <div class="search-results" id="searchResults">
                        <div class="search-empty"><i class="bi bi-search"></i><p class="mb-0">在上方填写关键字后点击「搜索」</p></div>
                    </div>
                </div>
            </div>
            <div class="search-collapsed" id="searchCollapsedBtn" style="display:none;" title="展开搜索结果"><i class="bi bi-search"></i><span class="collapsed-badge" id="searchCollapsedBadge">0</span></div>
        `;

            const rootVal = systemInfo.root || currentPath || '/';
            document.getElementById('searchRootInput').value = rootVal;

            // 索引是「上次扫描」时的快照：之后的下载 / 新建文件不在里面，搜不到不是坏了。
            // 这里把快照时间直接写在标题下，过期就标黄提醒。
            fetch('/api/index/meta').then(r => r.json()).then(m => {
                const el = document.querySelector('#searchOverlay .search-subtitle');
                if (!el || !m || !m.last_scan) return;
                const raw = String(m.last_scan);
                const ts = new Date(raw.replace(/-/g, '/'));
                if (isNaN(ts.getTime())) return;
                const days = Math.floor((Date.now() - ts.getTime()) / 86400000);
                el.textContent = days >= 1
                    ? '索引 ' + raw.slice(5, 16) + '（' + days + ' 天前）· 之后的新文件搜不到，需重建索引'
                    : '索引 ' + raw.slice(5, 16) + ' · 毫秒级响应';
                if (days >= 1) el.classList.add('stale');
                el.title = '索引只是上次扫描时的快照，重建索引后才会包含新文件';
            }).catch(() => {});

            // 事件绑定
            const ov = document.getElementById('searchOverlay');
            ov.addEventListener('click', (e) => { if (e.target === ov) _collapseSearch(); });
            document.getElementById('searchCloseBtn').addEventListener('click', _collapseSearch);
            document.getElementById('searchClearBtn').addEventListener('click', _clearSearchResults);
            document.getElementById('searchCollapsedBtn').addEventListener('click', _expandSearch);

            document.querySelectorAll('#searchViewSwitch .sv-btn').forEach(b => {
                b.addEventListener('click', () => {
                    _searchView = b.dataset.view;
                    document.querySelectorAll('#searchViewSwitch .sv-btn').forEach(x => x.classList.toggle('active', x === b));
                    _renderSearchResults(_searchItems);
                });
            });
            document.getElementById('searchRunBtn').addEventListener('click', startSearch);
            document.getElementById('batchOpenBtn').addEventListener('click', _batchOpenLocations);
            document.getElementById('batchDeselectBtn').addEventListener('click', _batchDeselect);
            document.getElementById('searchKeyInput').addEventListener('keydown', (e) => {
                if (e.key === 'Enter') startSearch();
            });
        }

        function _updateCollapsedBadge() {
            const badge = document.getElementById('searchCollapsedBadge');
            if (!badge) return;
            const n = _searchItems ? _searchItems.length : 0;
            badge.textContent = n > 999 ? '999+' : String(n);
            badge.classList.toggle('empty', n === 0);
            badge.classList.toggle('active', _searchRunning);
        }

        function _collapseSearch() {
            // 收起只是隐藏面板，不中断后台搜索：结果回来后轮询照常更新，徽标会同步
            const overlay = document.getElementById('searchOverlay');
            if (overlay) overlay.style.display = 'none';
            const collBtn = document.getElementById('searchCollapsedBtn');
            if (collBtn) collBtn.style.display = 'flex';
            _updateCollapsedBadge();
        }

        function _expandSearch() {
            const collBtn = document.getElementById('searchCollapsedBtn');
            if (collBtn) collBtn.style.display = 'none';
            const overlay = document.getElementById('searchOverlay');
            if (overlay) overlay.style.display = 'flex';
        }

        function cancelSearch(stopPolling) {
            const timer = _searchPollTimer;
            if (timer) { clearInterval(timer); _searchPollTimer = null; }
            _searchToken = null;
            _searchRunning = false;
            const progress = document.getElementById('searchProgress');
            if (progress) progress.classList.remove('active');
            const runBtn = document.getElementById('searchRunBtn');
            if (runBtn) { runBtn.disabled = false; runBtn.innerHTML = '<i class="bi bi-search"></i> 搜索'; }
        }

        function _clearSearchResults() {
            cancelSearch(true);
            _searchItems = [];
            _selectedSearchPaths.clear();
            const meta = document.getElementById('searchStatusMeta');
            if (meta) meta.innerHTML = '<span class="text-muted">等待搜索...</span>';
            const dur = document.getElementById('searchDuration');
            if (dur) dur.textContent = '--';
            const cnt = document.getElementById('searchCount');
            if (cnt) cnt.textContent = '0';
            const dirCnt = document.getElementById('searchDirCount');
            if (dirCnt) dirCnt.textContent = '0';
            const fileCnt = document.getElementById('searchFileCount');
            if (fileCnt) fileCnt.textContent = '0';
            const src = document.getElementById('searchSource');
            if (src) src.textContent = '--';
            const results = document.getElementById('searchResults');
            if (results) results.innerHTML = '<div class="search-empty"><i class="bi bi-search"></i><p class="mb-0">在上方填写关键字后点击「搜索」</p></div>';
            _showBatchBar(false);
            _updateCollapsedBadge();
            document.getElementById('searchKeyInput').value = '';
            document.getElementById('searchKeyInput').focus();
        }

        function startSearch() {
            const keyword = document.getElementById('searchKeyInput').value.trim();
            if (!keyword) { showToast('提示', '请输入搜索关键字', 'warning'); document.getElementById('searchKeyInput').focus(); return; }
            // 如果处于收缩状态，先展开
            _expandSearch();
            cancelSearch(true);
            document.getElementById('searchDuration').textContent = '--';
            document.getElementById('searchCount').textContent = '0';
            document.getElementById('searchDirCount').textContent = '0';
            document.getElementById('searchFileCount').textContent = '0';
            document.getElementById('searchSource').textContent = '--';
            document.getElementById('searchStatusMeta').innerHTML = '<span class="meta-loading"><span class="search-spin-ring"></span> 正在搜索...</span>';
            document.getElementById('searchProgress').classList.add('active');
            document.getElementById('searchResults').innerHTML = '<div class="search-empty"><span class="search-spin-ring lg"></span><p class="mb-0 mt-2">搜索中，请稍候...</p></div>';
            document.getElementById('searchRunBtn').disabled = true;
            document.getElementById('searchRunBtn').innerHTML = '<span class="search-spin-ring"></span> 搜索中';

            const root = document.getElementById('searchRootInput').value.trim();
            const typeF = document.getElementById('searchTypeFilter').value;

            const ctrl = new AbortController();
            const fetchTimer = setTimeout(() => ctrl.abort(), 20000);
            fetch(`/api/search?root=${encodeURIComponent(root)}&keyword=${encodeURIComponent(keyword)}&type=${encodeURIComponent(typeF)}&timeout=60`, { signal: ctrl.signal })
                .then(r => r.json())
                .then(data => {
                    clearTimeout(fetchTimer);
                    if (data.error) {
                        _searchPollTimer = null;
                        document.getElementById('searchStatusMeta').innerHTML = '<span class="text-danger"><i class="bi bi-exclamation-circle"></i> 错误</span>';
                        document.getElementById('searchResults').innerHTML = `<div class="search-empty"><i class="bi bi-exclamation-triangle text-danger"></i><p class="mb-0">${data.error}</p></div>`;
                        _resetSearchButtons();
                        return;
                    }
                    // 兼容后端未来可能的「同步直接返回」：当前 /api/search 一律返回 token，
                    // 正常路径都走下面的轮询；这里保留兜底以便后端改动时不至于卡在转圈。
                    if (data.done === true) {
                        document.getElementById('searchProgress').classList.remove('active');
                        _searchToken = null;
                        document.getElementById('searchCount').textContent = data.count || 0;
                        document.getElementById('searchDuration').textContent = _fmtDuration(data.duration);
                        document.getElementById('searchSource').textContent = data.source === 'index' ? '索引' : '实时';
                        const sourceLabel = data.source === 'index' ? ' (索引，毫秒级)' : ' (实时扫描)';
                        document.getElementById('searchStatusMeta').innerHTML = `<span class="text-success"><i class="bi bi-check-circle"></i> 搜索完成${sourceLabel}</span>`;
                        _renderSearchResults(data.items || []);
                        _resetSearchButtons();
                        _updateCollapsedBadge();
                        return;
                    }
                    // 异步轮询
                    _searchToken = data.token;
                    _searchRunning = true;
                    _searchStartTime = Date.now();
                    _searchFailCount = 0;
                    // 一开始就标出来源，避免用户以为又在扫文件系统
                    if (data.source === 'index') document.getElementById('searchSource').textContent = '索引';
                    else if (data.source === 'walk') document.getElementById('searchSource').textContent = '实时';
                    _searchPollTimer = setInterval(pollSearch, 300);
                })
                .catch(e => {
                    clearTimeout(fetchTimer);
                    _searchPollTimer = null;
                    const msg = e && e.name === 'AbortError' ? '搜索请求超时，请缩小搜索范围后重试' : `发起搜索失败: ${e.message}`;
                    document.getElementById('searchStatusMeta').innerHTML = '<span class="text-danger"><i class="bi bi-exclamation-circle"></i> 错误</span>';
                    document.getElementById('searchResults').innerHTML = `<div class="search-empty"><i class="bi bi-exclamation-triangle text-danger"></i><p class="mb-0">${msg}</p></div>`;
                    _resetSearchButtons();
                });
        }

        function _resetSearchButtons() {
            const runBtn = document.getElementById('searchRunBtn');
            if (runBtn) { runBtn.disabled = false; runBtn.innerHTML = '<i class="bi bi-search"></i> 搜索'; }
            _searchRunning = false;
        }

        function pollSearch() {
            if (!_searchToken || !_searchRunning) return;
            // 兜底：后端超时未响应或轮询异常时，最多等 90 秒就结束，绝不无限转圈
            // （索引库几百万行时整表扫描可能确实需要几十秒，后端自己也会按时限返回部分结果）
            if (Date.now() - _searchStartTime > 90000) { _finishTimeoutSearch(); return; }
            fetch(`/api/search/${_searchToken}`)
                .then(r => r.json())
                .then(data => {
                    _searchFailCount = 0;
                    if (data.error) {
                        // token 失效等，静默处理
                        if (data.error === "无效或已过期的搜索任务") {
                            _stopPolling();
                        }
                        return;
                    }
                    if (data.items) _searchItems = data.items;
                    const count = data.count || 0;
                    const dur = data.duration || 0;
                    const scanned = data.scanned || 0;
                    document.getElementById('searchCount').textContent = count;
                    document.getElementById('searchDuration').textContent = _fmtDuration(dur);
                    if (_searchItems.length) _updateCollapsedBadge();
                    // 索引整表扫描时给实时反馈：有匹配批次就报已扫描条数，没有就报已用秒数，
                    // 避免几十秒只有转圈、耗时一直停在 0 秒
                    if (!data.done) {
                        const tip = scanned
                            ? '已扫描 ' + Number(scanned).toLocaleString() + ' 条'
                            : '已用 ' + Math.max(0, Math.round(dur)) + ' 秒';
                        document.getElementById('searchStatusMeta').innerHTML =
                            '<span class="meta-loading"><span class="search-spin-ring"></span> 正在搜索... '
                            + tip + '</span>';
                    }
                    if (data.done) {
                        _stopPolling();
                        document.getElementById('searchProgress').classList.remove('active');
                        const runBtn = document.getElementById('searchRunBtn');
                        if (runBtn) { runBtn.disabled = false; runBtn.innerHTML = '<i class="bi bi-search"></i> 搜索'; }
                        const isIndex = data.source === 'index';
                        document.getElementById('searchSource').textContent = isIndex ? '索引' : '实时';
                        if (data.error) {
                            document.getElementById('searchStatusMeta').innerHTML = `<span class="text-warning"><i class="bi bi-exclamation-triangle"></i> ${_escHtml(data.error)}</span>`;
                        } else {
                            document.getElementById('searchStatusMeta').innerHTML = '<span class="text-success"><i class="bi bi-check-circle"></i> 搜索完成'
                                + (isIndex ? ' (索引)' : ' (实时扫描)') + '</span>';
                        }
                        _renderSearchResults(data.items || []);
                    }
                })
                .catch(() => {
                    if (++_searchFailCount >= 5) _finishTimeoutSearch();
                });
        }

        function _finishTimeoutSearch() {
            _stopPolling();
            const progress = document.getElementById('searchProgress');
            if (progress) progress.classList.remove('active');
            const status = document.getElementById('searchStatusMeta');
            if (status) status.innerHTML = '<span class="text-warning"><i class="bi bi-exclamation-triangle"></i> 搜索超时，已停止（可缩小搜索范围重试）</span>';
            _resetSearchButtons();
            _renderSearchResults(_searchItems || []);
        }

        function _stopPolling() {
            if (_searchPollTimer) { clearInterval(_searchPollTimer); _searchPollTimer = null; }
            _searchRunning = false;
        }

        // 图片 / 视频走 /api/thumbnail 出封面（服务端有缓存），失败回退文件图标
        function _searchThumbHtml(item, absPath) {
            if (item.is_dir) return _getSearchIconHtml(item);
            const ext = String(item.ext || (absPath.split('.').pop()) || '').toLowerCase();
            const imgExts = ['png','jpg','jpeg','gif','svg','webp','bmp','ico'];
            const vidExts = ['mp4','webm','mkv','avi','mov','m4v','ogg','flv'];
            if (imgExts.includes(ext) || vidExts.includes(ext)) {
                const fallback = _getSearchIconHtml(item);
                // onload 把图片地址写进容器 CSS 变量：竖版封面完整显示(contain)时，
                // 左右用同图模糊放大填充，避免出现空白边
                return `<img class="search-thumb-img" loading="lazy" src="/api/thumbnail?path=${encodeURIComponent(absPath)}" alt="" `
                    + `onload="this.parentElement.style.setProperty('--cover-url','url(&quot;'+this.src+'&quot;)');this.parentElement.classList.add('has-cover');" `
                    + `onerror="this.style.display='none';this.nextElementSibling.style.display='flex';" />`
                    + `<span class="search-thumb-fallback" style="display:none;">${fallback}</span>`;
            }
            return _getSearchIconHtml(item);
        }

        // 图标视图：网格卡片，复用 .search-row / data-path 让勾选与跳转逻辑通用
        function _renderSearchIconsHtml(items) {
            let html = `<div class="search-icon-bar"><label class="search-icon-select-all"><input type="checkbox" class="search-checkbox" id="searchSelectAll" title="全选"/> 全选</label></div><div class="search-icon-grid">`;
            for (const item of items) {
                const isDir = item.is_dir;
                const absPath = item.abs_path || item.path;
                const displayName = item.name || '(未知)';
                const displayPath = absPath || '';
                const sizeStr = item.size_str || (isDir ? '-' : formatSize(item.size || 0));
                let parentPath = absPath;
                if (absPath) {
                    const idx = Math.max(absPath.lastIndexOf('/'), absPath.lastIndexOf('\\'));
                    parentPath = idx >= 0 ? absPath.substring(0, idx) : absPath;
                }
                html += `<div class="search-icon-item search-row" data-abs-path="${_escAttr(absPath)}" data-parent-path="${_escAttr(parentPath)}" title="${_escAttr(displayPath)}">
                    <input type="checkbox" class="search-checkbox search-item-cb" data-path="${_escAttr(absPath)}"/>
                    <div class="search-icon-thumb">${_searchThumbHtml(item, absPath)}</div>
                    <div class="search-icon-name" title="${_escAttr(displayName)}">${_escHtml(displayName)}</div>
                    <div class="search-icon-meta"><span class="search-path" data-full-path="${_escAttr(displayPath)}">${_escHtml(sizeStr)}</span></div>
                    <div class="search-icon-actions">
                        <button class="search-open" data-parent-path="${_escAttr(parentPath)}" title="打开所在文件夹"><i class="bi bi-folder2-open"></i></button>
                        ${!isDir ? `<button class="search-preview" data-preview-path="${_escAttr(absPath)}" title="预览文件"><i class="bi bi-eye"></i></button>` : ''}
                    </div>
                </div>`;
            }
            return html + '</div>';
        }

        function _renderSearchResults(items) {
            _searchItems = items || [];
            _selectedSearchPaths.clear();
            _seqStop();   // 新结果重渲染：清空勾选 = 退出顺序浏览
            _updateCollapsedBadge();
            // 结果里的文件夹数 / 文件数
            const dirN = _searchItems.filter(it => it.is_dir).length;
            const fileN = _searchItems.length - dirN;
            const dirEl = document.getElementById('searchDirCount');
            const fileEl = document.getElementById('searchFileCount');
            if (dirEl) dirEl.textContent = dirN;
            if (fileEl) fileEl.textContent = fileN;
            const el = document.getElementById('searchResults');
            _showBatchBar(false);
            if (!items || items.length === 0) {
                el.innerHTML = '<div class="search-empty"><i class="bi bi-inbox"></i><p class="mb-0">未找到匹配的文件</p></div>';
                return;
            }
            const sorted = _sortSearchItems(items);
            el.classList.toggle('icon-view', _searchView === 'icon');
            if (_searchView === 'icon') {
                el.innerHTML = _renderSearchIconsHtml(sorted);
                _bindSearchItemEvents(el, sorted);
                return;
            }
            let html = `<table class="search-table"><thead><tr>
            <th class="search-cb"><input type="checkbox" class="search-checkbox" id="searchSelectAll" title="全选"/></th>
            ${_sortHeader('name', '名称')}
            ${_sortHeader('path', '路径')}
            ${_sortHeader('size', '大小')}
            ${_sortHeader('type', '类型')}
            ${_sortHeader('mtime', '修改时间')}
            <th style="width:92px;">操作</th>
        </tr></thead><tbody>`;
            for (const item of sorted) {
                const isDir = item.is_dir;
                const ext = (item.ext || '').toLowerCase();
                let badgeClass = isDir ? 'search-type-badge dir' : 'search-type-badge';
                let typeText = isDir ? '目录' : (ext ? ext.toUpperCase() : '未知');
                if (!isDir) {
                    if (ext === 'txt' || ext === 'md' || ext === 'py' || ext === 'js' || ext === 'json') badgeClass += ' text';
                    else if (ext === 'jpg' || ext === 'png' || ext === 'gif' || ext === 'svg' || ext === 'webp') badgeClass += ' image';
                    else if (ext === 'mp4' || ext === 'avi' || ext === 'mkv' || ext === 'mov') badgeClass += ' video';
                }
                const absPath = item.abs_path || item.path;
                const displayName = item.name || '(未知)';
                const displayPath = absPath || '';
                const when = item.mtime || '-';
                const sizeStr = item.size_str || (isDir ? '-' : formatSize(item.size || 0));
                let parentPath = absPath;
                if (absPath) {
                    const idx = absPath.lastIndexOf('/');
                    const idx2 = absPath.lastIndexOf(String.fromCharCode(92));
                    const bestIdx = idx >= 0 ? (idx2 > idx ? idx2 : idx) : idx2;
                    parentPath = bestIdx >= 0 ? absPath.substring(0, bestIdx) : absPath;
                }
                html += `<tr class="search-row" data-abs-path="${_escAttr(absPath)}" data-parent-path="${_escAttr(parentPath)}">
                <td><input type="checkbox" class="search-checkbox search-item-cb" data-path="${_escAttr(absPath)}"/></td>
                <td><div class="search-name-cell">${_getSearchIconHtml(item)}<span class="search-name" title="${_escAttr(displayName)}">${_escHtml(displayName)}</span></div></td>
                <td><span class="search-path" data-full-path="${_escAttr(displayPath)}" title="点击复制路径">${_escHtml(displayPath)}</span></td>
                <td class="text-end search-size">${_escHtml(sizeStr)}</td>
                <td><span class="${badgeClass}">${_escHtml(typeText)}</span></td>
                <td class="search-when">${_escHtml(when)}</td>
                <td class="search-actions">
                    <button class="search-open" data-parent-path="${_escAttr(parentPath)}" title="打开所在文件夹" aria-label="打开所在文件夹"><i class="bi bi-folder2-open"></i></button>
                    ${!isDir ? `<button class="search-preview" data-preview-path="${_escAttr(absPath)}" title="预览文件" aria-label="预览文件"><i class="bi bi-eye"></i></button>` : ''}
                </td>
            </tr>`;
            }
            html += '</tbody></table>';
            el.innerHTML = html;
            // 表头点击排序：同列切换升降序，换列默认升序（大小/时间默认降序更符合直觉）
            el.querySelectorAll('.search-sortable').forEach(th => {
                th.addEventListener('click', () => {
                    const key = th.dataset.sort;
                    if (_searchSort.key === key) {
                        _searchSort.asc = !_searchSort.asc;
                    } else {
                        _searchSort = { key, asc: key !== 'size' && key !== 'mtime' };
                    }
                    _renderSearchResults(_searchItems);
                });
            });
            _bindSearchItemEvents(el, sorted);
        }

        // 列表 / 图标两种视图共用的事件绑定：勾选、跳转高亮、复制路径、预览
        function _bindSearchItemEvents(el, sorted) {
            // 「打开」按钮：跳转并高亮对应文件/文件夹（弹窗保持打开）
            el.querySelectorAll('[data-parent-path]').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const row = btn.closest('.search-row');
                    if (!row) return;
                    const absPath = row.dataset.absPath;
                    _gotoAndHighlight(absPath, btn.dataset.parentPath);
                });
            });
            // 路径列：点击复制完整路径
            el.querySelectorAll('.search-path').forEach(span => {
                span.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const p = span.dataset.fullPath || span.textContent;
                    _copyText(p, '路径已复制到剪贴板');
                });
            });
            // 行点击：跳转到文件所在目录并高亮（排除按钮和复选框）
            el.querySelectorAll('.search-row').forEach(row => {
                row.addEventListener('click', (e) => {
                    if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON') return;
                    const absPath = row.dataset.absPath;
                    if (absPath) _gotoAndHighlight(absPath, row.dataset.parentPath);
                });
            });
            el.querySelectorAll('[data-preview-path]').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const p = btn.dataset.previewPath;
                    if (!_canPreviewPath(p)) { showToast('提示', '该文件类型不支持预览', 'warning'); return; }
                    // 把当前搜索结果（按排序后的顺序）作为预览队列，
                    // 让预览面板的「下一张/下一个」按搜索结果顺序切换，而不是按文件所在目录
                    const queue = (sorted || [])
                        .filter(it => !it.is_dir && _canPreviewPath(it.abs_path || it.path))
                        .map(it => it.abs_path || it.path);
                    if (typeof window._setPreviewQueue === 'function') window._setPreviewQueue(queue, p);
                    previewFile(p);
                });
            });
            const selectAll = el.querySelector('#searchSelectAll');
            if (selectAll) {
                selectAll.addEventListener('change', (e) => {
                    const checked = e.target.checked;
                    el.querySelectorAll('.search-item-cb').forEach(cb => {
                        cb.checked = checked;
                        const row = cb.closest('.search-row');
                        if (row) row.classList.toggle('selected', checked);
                        const p = cb.dataset.path;
                        if (checked) _selectedSearchPaths.add(p);
                        else _selectedSearchPaths.delete(p);
                    });
                    _updateSearchBatch();
                });
            }
            el.querySelectorAll('.search-item-cb').forEach(cb => {
                cb.addEventListener('change', (e) => {
                    const p = cb.dataset.path;
                    const row = cb.closest('.search-row');
                    if (row) row.classList.toggle('selected', e.target.checked);
                    if (e.target.checked) _selectedSearchPaths.add(p);
                    else _selectedSearchPaths.delete(p);
                    _updateSearchBatch();
                    const total = el.querySelectorAll('.search-item-cb').length;
                    const sa = el.querySelector('#searchSelectAll');
                    if (sa) sa.checked = _selectedSearchPaths.size === total && total > 0;
                });
            });
        }

        let _searchItems = [];
        let _selectedSearchPaths = new Set();
        let _searchView = 'list';   // 'list' | 'icon'
        // 表头排序状态：点击列切换升/降序，目录始终排在文件前面
        let _searchSort = { key: 'name', asc: true };

        function _sortSearchItems(items) {
            const { key, asc } = _searchSort;
            const sign = asc ? 1 : -1;
            const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
            return [...items].sort((a, b) => {
                const dirDiff = Number(!!b.is_dir) - Number(!!a.is_dir);
                if (dirDiff) return dirDiff;
                let cmp = 0;
                switch (key) {
                    case 'size':
                        cmp = (Number(a.size) || 0) - (Number(b.size) || 0);
                        break;
                    case 'mtime':
                        cmp = collator.compare(String(a.mtime || ''), String(b.mtime || ''));
                        break;
                    case 'type':
                        cmp = collator.compare(
                            String(a.is_dir ? '目录' : (a.ext || a.type || '')),
                            String(b.is_dir ? '目录' : (b.ext || b.type || '')));
                        break;
                    case 'path':
                        cmp = collator.compare(String(a.abs_path || a.path || ''), String(b.abs_path || b.path || ''));
                        break;
                    default:
                        cmp = collator.compare(String(a.name || ''), String(b.name || ''));
                }
                return cmp * sign;
            });
        }

        function _sortHeader(key, label) {
            const active = _searchSort.key === key;
            const icon = active
                ? `<i class="bi bi-arrow-${_searchSort.asc ? 'up' : 'down'}-short"></i>`
                : '<i class="bi bi-arrow-down-up sort-hint"></i>';
            return `<th class="search-sortable${active ? ' sorted' : ''}" data-sort="${key}" title="点击按${label}排序">${label} ${icon}</th>`;
        }

        function _showBatchBar(show) {
            const bar = document.getElementById('searchBatch');
            if (bar) bar.style.display = show ? 'flex' : 'none';
        }

        function _updateSearchBatch() {
            const count = _selectedSearchPaths.size;
            const countEl = document.getElementById('batchCount');
            const openBtn = document.getElementById('batchOpenBtn');
            if (countEl) countEl.textContent = count;
            if (openBtn) openBtn.disabled = count === 0;
            _showBatchBar(count > 0);
            _seqSync();   // 勾选与顺序浏览同一状态：取消勾选即更新/退出顺序浏览
        }

        function _batchDeselect() {
            _selectedSearchPaths.clear();
            const el = document.getElementById('searchResults');
            if (el) {
                el.querySelectorAll('.search-item-cb').forEach(cb => { cb.checked = false; });
                el.querySelectorAll('#searchSelectAll').forEach(cb => { cb.checked = false; });
                el.querySelectorAll('tr.selected').forEach(r => { r.classList.remove('selected'); });
            }
            _showBatchBar(false);
            _seqSync();   // 勾选清空 → 顺序浏览同步退出（同一状态）
        }

        // 从搜索结果行取绝对路径 / 父目录
        function _rowPaths(row) {
            if (!row) return null;
            const absPath = row.dataset.absPath || '';
            const parentPath = row.dataset.parentPath || absPath;
            return { absPath, parentPath };
        }

        // 跳转到目标所在目录并高亮对应条目；目录高亮自身，文件高亮它在目录里的那一行。
        // 复用收藏夹的 _pendingHighlightPath + _pollPendingHighlight（等列表渲染完再补高亮），
        // 保险箱/上传记录也用这套，兼容列表/图标/树三种视图。
        function _gotoAndHighlight(absPath, parentPath) {
            if (!absPath) return;
            if (!parentPath) {
                const i = Math.max(absPath.lastIndexOf('/'), absPath.lastIndexOf('\\'));
                parentPath = i > 0 ? absPath.slice(0, i) : absPath;
            }
            if (typeof _pendingHighlightPath !== 'undefined') {
                _pendingHighlightPath = absPath;
                if (typeof _pollPendingHighlight === 'function') _pollPendingHighlight();
            }
            navigateTo(parentPath);
        }

        // ===== 顺序浏览：与批量勾选共用同一份状态 _selectedSearchPaths =====
        // 浏览序列 = 当前勾选的项（按搜索结果顺序）；取消勾选 / 清空勾选即退出顺序浏览。
        let _seqIndex = -1;
        let _seqActive = false;

        // 当前勾选项按搜索结果（已排序）顺序组成的路径序列
        function _seqPaths() {
            const selected = new Set(_selectedSearchPaths);
            return (_searchItems || [])
                .map(it => it.abs_path || it.path)
                .filter(p => selected.has(p));
        }

        function _seqGoto(idx) {
            const paths = _seqPaths();
            if (idx < 0 || idx >= paths.length) return;
            _seqIndex = idx;
            _gotoAndHighlight(paths[idx]);
            _seqRender();
        }

        function _seqRender() {
            const nav = document.getElementById('seqNav');
            if (!nav) return;
            const paths = _seqPaths();
            if (!_seqActive || !_seqItemsExist(paths)) { nav.style.display = 'none'; return; }
            nav.style.display = 'inline-flex';
            if (_seqIndex < 0 || _seqIndex >= paths.length) _seqIndex = 0;
            const cnt = document.getElementById('seqCount');
            if (cnt) cnt.textContent = (_seqIndex + 1) + ' / ' + paths.length;
            const prev = document.getElementById('seqPrevBtn');
            const next = document.getElementById('seqNextBtn');
            if (prev) prev.disabled = _seqIndex <= 0;
            if (next) next.disabled = _seqIndex >= paths.length - 1;
        }

        function _seqItemsExist(paths) {
            return Array.isArray(paths) && paths.length > 0;
        }

        // 勾选状态变化后同步：无勾选自动退出顺序浏览
        function _seqSync() {
            if (_selectedSearchPaths.size === 0) {
                _seqStop();
            } else {
                _seqRender();
            }
        }

        function _seqStart(startPath) {
            const paths = _seqPaths();
            if (!paths.length) return;
            _seqActive = true;
            _seqIndex = Math.max(0, paths.indexOf(startPath));
            _seqRender();
            _seqGoto(_seqIndex);
        }

        function _seqStop() {
            _seqActive = false;
            _seqIndex = -1;
            _seqRender();
        }

        function _seqStep(delta) {
            if (!_seqActive) return;
            const idx = _seqIndex + delta;
            const paths = _seqPaths();
            if (idx < 0 || idx >= paths.length) return;
            _seqGoto(idx);
        }

        function _batchOpenLocations() {
            if (_selectedSearchPaths.size === 0) return;
            const first = _seqPaths()[0] || Array.from(_selectedSearchPaths)[0];
            // 开始顺序浏览：序列即当前勾选的项，从第一个开始跳转并高亮
            _seqStart(first);
            showToast('提示', '已进入顺序浏览：共 ' + _selectedSearchPaths.size + ' 项，点右上角「上一个 / 下一个」逐个查看', 'info');
        }

        function _getSearchIconHtml(item) {
            return fileIconHtml(item, "search-ic");   // 与 IDE 文件树 / 列表 / 图标 / 树型视图同一套 seti 图标
        }

        // 后端 walk 分支的 duration 是未取整的浮点秒数，统一保留 2 位，避免长串小数撑破元信息栏
        function _fmtDuration(sec) {
            const n = Number(sec);
            return Number.isFinite(n) ? n.toFixed(2) : '--';
        }

        function _escHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
        function _escAttr(s) { return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }


        function _copyPreview() {
            const pre = document.querySelector('.preview-body pre');
            if (pre) _copyText(pre.textContent, '文本已复制到剪贴板');
        }

        // ========== 全盘搜索 ==========
        let _searchToken = null;
        let _searchPollTimer = null;
        let _searchRunning = false;

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
            <div class="custom-modal-overlay" id="searchOverlay">
                <div class="search-modal">
                    <div class="search-header">
                        <span class="search-title"><i class="bi bi-search"></i> 全盘搜索<span class="search-subtitle">基于本地索引，毫秒级响应</span></span>
                        <button class="search-close" id="searchCloseBtn" title="收起至右上角"><i class="bi bi-arrows-angle-contract"></i> 收起</button>
                    </div>
                    <div class="search-body">
                        <div class="search-params">
                            <div class="search-root-input">
                                <span class="label"><i class="bi bi-folder2-open"></i></span>
                                <input type="text" id="searchRootInput" placeholder="搜索根目录（默认系统盘）" />
                                <span class="label" style="margin-left:6px;"><i class="bi bi-search"></i></span>
                                <input type="text" id="searchKeyInput" class="flex-grow-1" placeholder="搜索关键字（文件名）" style="min-width:160px;" />
                                <select id="searchTypeFilter">
                                    <option value="">全部</option>
                                    <option value="文件">文件</option>
                                    <option value="目录">目录</option>
                                </select>
                            </div>
                            <button class="btn btn-run" id="searchRunBtn"><i class="bi bi-search"></i> 搜索</button>
                            <button class="btn btn-clear" id="searchClearBtn" title="清空输入框"><i class="bi bi-x-circle"></i></button>
                        </div>
                        <div class="search-meta">
                            <span class="meta-item" id="searchStatusMeta"><span class="text-muted">等待搜索...</span></span>
                            <span class="meta-item"><i class="bi bi-clock"></i> 耗时: <strong id="searchDuration">--</strong> 秒</span>
                            <span class="meta-item"><i class="bi bi-list-ul"></i> 命中: <strong id="searchCount">0</strong> 个</span>
                            <span class="meta-item"><i class="bi bi-database"></i> 来源: <strong id="searchSource">--</strong></span>
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
                            <button class="batch-deselect" id="batchDeselectBtn"><i class="bi bi-x-square"></i> 取消</button>
                        </div>
                    </div>
                    <div class="search-results" id="searchResults">
                        <div class="search-empty"><i class="bi bi-search"></i><p class="mb-0">在上方填写关键字后点击「搜索」</p></div>
                    </div>
                </div>
            </div>
            <div class="search-collapsed" id="searchCollapsedBtn" style="display:none;" title="展开搜索结果"><i class="bi bi-search"></i><span class="collapsed-badge" id="searchCollapsedBadge">0</span></div>
            <div class="search-collapsed-tip" id="searchCollapsedTip">点击展开搜索结果</div>
        `;

            const rootVal = systemInfo.root || currentPath || '/';
            document.getElementById('searchRootInput').value = rootVal;

            // 事件绑定
            const ov = document.getElementById('searchOverlay');
            ov.addEventListener('click', (e) => { if (e.target === ov) _collapseSearch(); });
            document.getElementById('searchCloseBtn').addEventListener('click', _collapseSearch);
            document.getElementById('searchClearBtn').addEventListener('click', _clearSearchResults);
            document.getElementById('searchCollapsedBtn').addEventListener('click', _expandSearch);

            document.getElementById('searchRunBtn').addEventListener('click', startSearch);
            document.getElementById('batchOpenBtn').addEventListener('click', _batchOpenLocations);
            document.getElementById('batchDeselectBtn').addEventListener('click', _batchDeselect);
            document.getElementById('searchKeyInput').addEventListener('keydown', (e) => {
                if (e.key === 'Enter') startSearch();
            });
        }

        function _collapseSearch() {
            cancelSearch(false);
            const overlay = document.getElementById('searchOverlay');
            if (overlay) overlay.style.display = 'none';
            const collBtn = document.getElementById('searchCollapsedBtn');
            if (collBtn) {
                collBtn.style.display = 'flex';
                const badge = document.getElementById('searchCollapsedBadge');
                if (badge) {
                    if (_searchItems && _searchItems.length > 0) {
                        badge.textContent = _searchItems.length;
                        badge.classList.remove('empty');
                    } else {
                        badge.textContent = '0';
                        badge.classList.add('empty');
                    }
                }
            }
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
            const meta = document.getElementById('searchStatusMeta');
            if (meta) meta.innerHTML = '<span class="text-muted">等待搜索...</span>';
            const dur = document.getElementById('searchDuration');
            if (dur) dur.textContent = '--';
            const cnt = document.getElementById('searchCount');
            if (cnt) cnt.textContent = '0';
            const src = document.getElementById('searchSource');
            if (src) src.textContent = '--';
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
            document.getElementById('searchSource').textContent = '--';
            document.getElementById('searchStatusMeta').innerHTML = '<span class="meta-loading"><i class="bi bi-arrow-repeat spin" style="display:inline-block;animation:spin 1s linear infinite;"></i> 正在搜索...</span>';
            document.getElementById('searchProgress').classList.add('active');
            document.getElementById('searchResults').innerHTML = '<div class="search-empty"><div class="spinner-border text-primary" role="status"></div><p class="mb-0 mt-2">搜索中，请稍候...</p></div>';
            document.getElementById('searchRunBtn').disabled = true;
            document.getElementById('searchRunBtn').innerHTML = '<i class="bi bi-arrow-repeat" style="display:inline-block;animation:spin 1s linear infinite;"></i> 搜索中';

            const root = document.getElementById('searchRootInput').value.trim();
            const typeF = document.getElementById('searchTypeFilter').value;

            fetch(`/api/search?root=${encodeURIComponent(root)}&keyword=${encodeURIComponent(keyword)}&type=${encodeURIComponent(typeF)}`)
                .then(r => r.json())
                .then(data => {
                    if (data.error) {
                        _searchPollTimer = null;
                        document.getElementById('searchStatusMeta').innerHTML = '<span class="text-danger"><i class="bi bi-exclamation-circle"></i> 错误</span>';
                        document.getElementById('searchResults').innerHTML = `<div class="search-empty"><i class="bi bi-exclamation-triangle text-danger"></i><p class="mb-0">${data.error}</p></div>`;
                        _resetSearchButtons();
                        return;
                    }
                    // 索引直接返回（无需轮询）
                    if (data.done === true) {
                        document.getElementById('searchProgress').classList.remove('active');
                        document.getElementById('searchCount').textContent = data.count || 0;
                        document.getElementById('searchDuration').textContent = data.duration || 0;
                        document.getElementById('searchSource').textContent = data.source === 'index' ? '索引' : '实时';
                        const sourceLabel = data.source === 'index' ? ' (索引，毫秒级)' : ' (实时扫描)';
                        document.getElementById('searchStatusMeta').innerHTML = `<span class="text-success"><i class="bi bi-check-circle"></i> 搜索完成${sourceLabel}</span>`;
                        _renderSearchResults(data.items || []);
                        _resetSearchButtons();
                        return;
                    }
                    // 异步轮询
                    _searchToken = data.token;
                    _searchRunning = true;
                    _searchPollTimer = setInterval(pollSearch, 300);
                })
                .catch(e => {
                    _searchPollTimer = null;
                    document.getElementById('searchStatusMeta').innerHTML = '<span class="text-danger"><i class="bi bi-exclamation-circle"></i> 错误</span>';
                    document.getElementById('searchResults').innerHTML = `<div class="search-empty"><i class="bi bi-exclamation-triangle text-danger"></i><p class="mb-0">发起搜索失败: ${e.message}</p></div>`;
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
            fetch(`/api/search/${_searchToken}`)
                .then(r => r.json())
                .then(data => {
                    if (data.error) {
                        // token 失效等，静默处理
                        if (data.error === "无效或已过期的搜索任务") {
                            _stopPolling();
                        }
                        return;
                    }
                    const count = data.count || 0;
                    const dur = data.duration || 0;
                    document.getElementById('searchCount').textContent = count;
                    document.getElementById('searchDuration').textContent = dur;
                    if (data.done) {
                        _stopPolling();
                        document.getElementById('searchProgress').classList.remove('active');
                        const runBtn = document.getElementById('searchRunBtn');
                        if (runBtn) { runBtn.disabled = false; runBtn.innerHTML = '<i class="bi bi-search"></i> 搜索'; }
                        if (data.error) {
                            document.getElementById('searchStatusMeta').innerHTML = '<span class="text-warning"><i class="bi bi-exclamation-triangle"></i> 搜索完成（有异常）</span>';
                        } else {
                            document.getElementById('searchSource').textContent = '实时';
                            document.getElementById('searchStatusMeta').innerHTML = '<span class="text-success"><i class="bi bi-check-circle"></i> 搜索完成 (实时扫描)</span>';
                        }
                        _renderSearchResults(data.items || []);
                    }
                })
                .catch(() => { });
        }

        function _stopPolling() {
            if (_searchPollTimer) { clearInterval(_searchPollTimer); _searchPollTimer = null; }
            _searchRunning = false;
        }

        function _renderSearchResults(items) {
            _searchItems = items || [];
            _selectedSearchPaths.clear();
            const el = document.getElementById('searchResults');
            _showBatchBar(false);
            if (!items || items.length === 0) {
                el.innerHTML = '<div class="search-empty"><i class="bi bi-inbox"></i><p class="mb-0">未找到匹配的文件</p></div>';
                return;
            }
            const sorted = [...items].sort((a, b) => (a.is_dir ? -1 : 1) || a.name.localeCompare(b.name));
            let html = `<table class="search-table"><thead><tr>
            <th class="search-cb"><input type="checkbox" class="search-checkbox" id="searchSelectAll" title="全选"/></th>
            <th style="width:26%">名称</th>
            <th style="width:18%">路径</th>
            <th style="width:75px;text-align:right;">大小</th>
            <th style="width:75px;">类型</th>
            <th style="width:140px;">修改时间</th>
            <th style="width:180px;">操作</th>
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
                <td><i class="${_getSearchIconClass(item)}"></i> <span class="search-name" title="${_escAttr(displayName)}">${_escHtml(displayName)}</span></td>
                <td><span class="search-path" data-full-path="${_escAttr(displayPath)}" title="点击复制路径">${_escHtml(displayPath)}</span></td>
                <td class="text-end search-size">${_escHtml(sizeStr)}</td>
                <td><span class="${badgeClass}">${_escHtml(typeText)}</span></td>
                <td class="search-when">${_escHtml(when)}</td>
                <td class="search-actions">
                    <button class="search-open" data-parent-path="${_escAttr(parentPath)}" title="进入所在文件夹"><i class="bi bi-folder2-open"></i> 打开</button>
                    ${!isDir ? `<button class="search-preview" data-preview-path="${_escAttr(absPath)}" title="预览文件"><i class="bi bi-eye"></i> 预览</button>` : ''}
                </td>
            </tr>`;
            }
            html += '</tbody></table>';
            el.innerHTML = html;
            // 「打开」按钮：跳转文件所在位置（弹窗保持打开）
            el.querySelectorAll('[data-parent-path]').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    navigateTo(btn.dataset.parentPath);
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
            // 行点击：跳转到文件所在目录（排除按钮和复选框）
            el.querySelectorAll('.search-row').forEach(row => {
                row.addEventListener('click', (e) => {
                    if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON') return;
                    const parentPath = row.dataset.parentPath;
                    if (parentPath) navigateTo(parentPath);
                });
            });
            el.querySelectorAll('[data-preview-path]').forEach(btn => {
                btn.addEventListener('click', () => {
                    const p = btn.dataset.previewPath;
                    if (_canPreviewPath(p)) previewFile(p);
                    else showToast('提示', '该文件类型不支持预览', 'warning');
                });
            });
            const selectAll = el.querySelector('#searchSelectAll');
            if (selectAll) {
                selectAll.addEventListener('change', (e) => {
                    const checked = e.target.checked;
                    el.querySelectorAll('.search-item-cb').forEach(cb => {
                        cb.checked = checked;
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
                    const row = cb.closest('tr');
                    if (e.target.checked) { _selectedSearchPaths.add(p); row.classList.add('selected'); }
                    else { _selectedSearchPaths.delete(p); row.classList.remove('selected'); }
                    _updateSearchBatch();
                    const total = el.querySelectorAll('.search-item-cb').length;
                    const sa = el.querySelector('#searchSelectAll');
                    if (sa) sa.checked = _selectedSearchPaths.size === total && total > 0;
                });
            });
        }

        let _searchItems = [];
        let _selectedSearchPaths = new Set();

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
        }

        function _batchOpenLocations() {
            if (_selectedSearchPaths.size === 0) return;
            const paths = Array.from(_selectedSearchPaths);
            for (const p of paths) {
                for (const item of _searchItems) {
                    if ((item.abs_path || item.path) === p) {
                        const absPath = item.abs_path || item.path;
                        let parentPath = absPath;
                        if (absPath) {
                            const idx = absPath.lastIndexOf('/');
                            const idx2 = absPath.lastIndexOf(String.fromCharCode(92));
                            const bestIdx = idx >= 0 ? (idx2 > idx ? idx2 : idx) : idx2;
                            parentPath = bestIdx >= 0 ? absPath.substring(0, bestIdx) : absPath;
                        }
                        navigateTo(parentPath);
                        if (_selectedSearchPaths.size > 1) {
                            showToast('提示', '已跳转到第 1 个文件所在目录，其余 ' + (_selectedSearchPaths.size - 1) + ' 个项留在搜索结果中继续操作', 'info');
                        }
                        return;
                    }
                }
            }
        }

        function _getIconForSearch(item) {
            return item.is_dir ? '📁' : '📄';
        }

        function _getSearchIconClass(item) {
            if (item.is_dir) return 'bi bi-folder-fill text-warning';
            const ext = (item.ext || '').toLowerCase();
            const icons = { 'pdf': 'bi-filetype-pdf text-danger', 'jpg': 'bi-file-image text-success', 'jpeg': 'bi-file-image text-success', 'png': 'bi-file-image text-success', 'gif': 'bi-file-image text-success', 'svg': 'bi-file-image text-success', 'mp4': 'bi-file-play text-primary', 'avi': 'bi-file-play text-primary', 'mov': 'bi-file-play text-primary', 'mkv': 'bi-file-play text-primary', 'mp3': 'bi-file-music text-primary', 'wav': 'bi-file-music text-primary', 'zip': 'bi-file-zip text-secondary', 'rar': 'bi-file-zip text-secondary', '7z': 'bi-file-zip text-secondary', 'py': 'bi-file-code text-info', 'js': 'bi-file-code text-warning', 'html': 'bi-file-code text-danger', 'css': 'bi-file-code text-info', 'json': 'bi-file-code text-secondary', 'txt': 'bi-file-text text-secondary', 'md': 'bi-file-text text-secondary' };
            return `bi ${icons[ext] || 'bi-file-earmark'}`;
        }

        function _escHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
        function _escAttr(s) { return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }


        function _copyPreview() {
            const pre = document.querySelector('.preview-body pre');
            if (pre) _copyText(pre.textContent, '文本已复制到剪贴板');
        }

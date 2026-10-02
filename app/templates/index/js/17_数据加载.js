        // ========== 数据加载 ==========
        async function loadFiles(path) {
            _closeMenus();
            _abortPendingFetch();
            const ctrl = new AbortController();
            _currentFetchController = ctrl;
            _setLoading(true, path);
            try {
                const url = path
                    ? `/api/files?path=${encodeURIComponent(path)}&limit=0&offset=0`
                    : '/api/files?limit=0&offset=0';
                const resp = await fetch(url, { signal: ctrl.signal });
                if (!resp.ok && resp.status !== 400) {
                    throw new Error(`请求失败 (HTTP ${resp.status})`);
                }
                const data = await resp.json();
                _currentFetchController = null;
                _setLoading(false, '');
                if (data.error) {
                    showToast('错误', data.error, 'danger');
                    // 显示错误行到表格
                    const tbody = document.getElementById('fileBody');
                    if (tbody) {
                        tbody.innerHTML = `<tr><td colspan="${selectMode ? 6 : 5}" style="padding:20px;text-align:center;color:#dc2626;">${_escHtml(data.error)}</td></tr>`;
                    }
                    return;
                }
                if (data.items == null) {
                    showToast('错误', '服务器返回数据异常', 'danger');
                    return;
                }
                currentPath = data.current_path_abs || '';
                sessionStorage.removeItem('_fmAutoReloaded');   // 服务正常，重置自动刷新标记
                fileItems = data.items || [];
                selectedPaths.clear();
                // 保存当前类型筛选值，更新下拉框后恢复
                const prevTypeVal = document.getElementById('typeFilter') ? document.getElementById('typeFilter').value : '';
                _updateTypeFilter(fileItems);
                if (prevTypeVal && document.getElementById('typeFilter')) {
                    const opt = document.getElementById('typeFilter').querySelector(`option[value="${prevTypeVal}"]`);
                    if (opt) document.getElementById('typeFilter').value = prevTypeVal;
                }
                document.getElementById('totalFiles').textContent = data.stats.total_files;
                document.getElementById('totalDirs').textContent = data.stats.total_dirs;
                document.getElementById('totalSize').textContent = data.stats.total_size_str;
                // 底部提示条同步显示同一份统计
                const bf = document.getElementById('bottomFiles');
                if (bf) {
                    document.getElementById('bottomFiles').textContent = data.stats.total_files;
                    document.getElementById('bottomDirs').textContent = data.stats.total_dirs;
                    document.getElementById('bottomSize').textContent = data.stats.total_size_str;
                    _updateBottomTypeStats(fileItems);
                }
                document.getElementById('fileCountBadge').textContent = `${data.total_items != null ? data.total_items : data.items.length} 项`;
                document.getElementById('pathInput').value = currentPath;
                updateBreadcrumb(currentPath);
                // 上级目录按钮
                const parentBtn = document.getElementById('parentDirBtn');
                if (parentBtn) {
                    const pData = data.parent_path || '';
                    parentPath = pData;
                    if (pData) {
                        parentBtn.disabled = false;
                        parentBtn.dataset.target = pData;
                        parentBtn.title = '返回上级目录: ' + pData;
                    } else {
                        parentBtn.disabled = true;
                        parentBtn.title = '已是根目录';
                    }
                }
                localStorage.setItem(STORAGE_KEY, currentPath);
                applyFiltersAndSort();
                document.getElementById('selectAll').checked = false;
                document.getElementById('selectAll').indeterminate = false;
            } catch (e) {
                _currentFetchController = null;
                _setLoading(false, '');
                if (e && e.name === 'AbortError') {
                    // 已切换路径，忽略旧的加载结果
                    return;
                }
                const msg = (e && e.message) || String(e);
                // 网络级失败（服务重启/断开）：调试模式下自动刷新一次恢复页面
                if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) {
                    if (!sessionStorage.getItem('_fmAutoReloaded')) {
                        sessionStorage.setItem('_fmAutoReloaded', '1');
                        showToast('提示', '服务已重启，页面即将自动刷新…', 'warning');
                        setTimeout(() => location.reload(), 1500);
                        return;
                    }
                }
                showToast('错误', '加载文件列表失败: ' + msg, 'danger');
            }
        }

        function updateBreadcrumb(absPath) {
            const breadcrumb = document.getElementById('breadcrumb');
            const sysRoot = systemInfo.root || (navigator.platform.toLowerCase().includes('win') ? 'C:\\\\' : '/');
            let parts = (absPath || '').split(/[\\/]/).filter(p => p);
            // 根目录项使用真实系统根路径
            let html = `<li class="breadcrumb-item"><a href="#" data-path="${_escAttr(sysRoot)}" title="${_escAttr(sysRoot)}"><i class="bi bi-hdd"></i></a></li>`;
            if (parts.length > 0) {
                let cumulative = '';
                if (navigator.platform.toLowerCase().includes('win')) {
                    cumulative = parts[0] + '\\\\';
                    html += `<li class="breadcrumb-item"><a href="#" data-path="${_escAttr(cumulative)}">${_escHtml(parts[0])}</a></li>`;
                    parts = parts.slice(1);
                } else {
                    cumulative = '/';
                }
                for (let i = 0; i < parts.length; i++) {
                    cumulative += (i === 0 && cumulative === '/') ? '' : '/';
                    cumulative += parts[i];
                    const isLast = i === parts.length - 1;
                    if (isLast) html += `<li class="breadcrumb-item active">${_escHtml(parts[i])}</li>`;
                    else html += `<li class="breadcrumb-item"><a href="#" data-path="${_escAttr(cumulative)}">${_escHtml(parts[i])}</a></li>`;
                }
            }
            breadcrumb.innerHTML = html;
            breadcrumb.querySelectorAll('a[data-path]').forEach(el => {
                el.addEventListener('click', (e) => { e.preventDefault(); navigateTo(el.dataset.path); });
            });
            _updateFavCurState();   // 目录切换后同步收藏按钮点亮状态
        }

        function navigateTo(path) {
            if (path === 'loading' || path === 'undefined' || path === 'null' || path == null) return;
            // 已经在同一路径加载中：忽略重复点击，保留进行中的请求
            // （不能取消后又不重发，否则请求“已取消”且界面卡在旧目录）
            if (path === currentPath && _isNavigating) return;
            _abortPendingFetch();
            loadFiles(path || '');
        }

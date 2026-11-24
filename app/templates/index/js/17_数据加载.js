        // ========== 数据加载 ==========
        // 取上一级目录：'/' 再上一级为空（回退到根即停）；Windows 'C:\\' 同理
        function _parentPath(p) {
            if (!p) return '';
            const s = String(p).replace(/[\\/]+$/, '');
            if (!s) return '';
            const idx = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
            if (idx < 0) return '';
            if (idx === 0) return s[0];
            let parent = s.slice(0, idx);
            if (/^[A-Za-z]:$/.test(parent)) parent += '\\';
            return parent;
        }
        // 空目录统一占位：有上级目录时附带「返回上一级」快捷按钮（列表/图标/树型视图共用）
        function emptyStateHtml() {
            const backBtn = parentPath
                ? `<button type="button" class="btn btn-sm btn-outline-primary empty-parent-btn" title="返回上级目录"><i class="bi bi-arrow-up"></i> 返回上一级</button>`
                : '';
            return `<div class="empty-state"><i class="bi bi-folder2-open"></i><p class="mb-2">此目录为空</p>${backBtn}</div>`;
        }

        // 隐藏文件开关的视觉状态（图标 / 标题 / aria-pressed 同步）
        function updateHiddenToggleUI() {
            const btn = document.getElementById('hiddenToggleBtn');
            if (!btn) return;
            btn.classList.toggle('active', showHidden);
            btn.setAttribute('aria-pressed', showHidden ? 'true' : 'false');
            btn.title = showHidden ? '隐藏隐藏文件（以 . 开头）' : '显示隐藏文件（以 . 开头）';
            const icon = btn.querySelector('i');
            if (icon) icon.className = showHidden ? 'bi bi-eye' : 'bi bi-eye-slash';
        }

        async function loadFiles(path, _fromFallback) {
            _closeMenus();
            _abortPendingFetch();
            updateHiddenToggleUI();
            const ctrl = new AbortController();
            _currentFetchController = ctrl;
            _setLoading(true, path);
            try {
                const hiddenParam = showHidden ? '&hidden=1' : '';
                const url = path
                    ? `/api/files?path=${encodeURIComponent(path)}&limit=0&offset=0${hiddenParam}`
                    : `/api/files?limit=0&offset=0${hiddenParam}`;
                const resp = await fetch(url, { signal: ctrl.signal });
                if (!resp.ok && resp.status !== 400) {
                    throw new Error(`请求失败 (HTTP ${resp.status})`);
                }
                const data = await resp.json();
                _currentFetchController = null;
                _setLoading(false, '');
                if (data.error) {
                    // 路径已失效（目录被删除 / 重命名等）：自动逐级向上找最近存在的上级目录，
                    // 一路回退到根目录为止；中途静默，直到成功再提示一次。
                    const em = /不存在或不是目录[:：]\s*(.+)$/.exec(data.error || '');
                    if (em) {
                        const badPath = em[1].trim();
                        const up = _parentPath(badPath);
                        if (up && up !== badPath) {
                            return loadFiles(up, true);
                        }
                    }
                    showToast('错误', data.error, 'danger');
                    // 显示错误行到表格
                    const tbody = document.getElementById('fileBody');
                    if (tbody) {
                        tbody.innerHTML = `<tr><td colspan="${selectMode ? 8 : 7}" style="padding:20px;text-align:center;color:#dc2626;">${_escHtml(data.error)}</td></tr>`;
                    }
                    return;
                }
                if (data.items == null) {
                    showToast('错误', '服务器返回数据异常', 'danger');
                    return;
                }
                const _prevPath = currentPath;
                currentPath = data.current_path_abs || '';
                if (_prevPath !== currentPath) {
                    // 通知其它模块（AI 文件管理面板等）：工作目录已切换
                    try {
                        document.dispatchEvent(new CustomEvent('fm:pathchange', { detail: { path: currentPath } }));
                    } catch (e) { /* 忽略 */ }
                }
                if (_fromFallback) {
                    showToast('提示', '原路径不存在，已自动切换到上级目录：' + currentPath, 'warning');
                }
                sessionStorage.removeItem('_fmAutoReloaded');   // 服务正常，重置自动刷新标记
                fileItems = data.items || [];
                selectedPaths.clear();
                updateSelectedCount();
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
                _startSizePoll(currentPath);   // 有目录还在后台算大小 → 轮询原地补上，不整页刷新
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

        // 路径过深时折叠中间层级，避免把右侧统计项挤到下一行
        function _renderBreadcrumbSegments(breadcrumb, segments, sysRoot, expanded) {
            let html = `<li class="breadcrumb-item"><a href="#" data-path="${_escAttr(sysRoot)}" title="${_escAttr(sysRoot)}"><i class="bi bi-hdd"></i></a></li>`;
            let shown = segments;
            if (!expanded && segments.length > 6) {
                shown = segments.slice(0, 2).concat(
                    [{ collapsed: true, hiddenSegments: segments.slice(2, -3) }],
                    segments.slice(-3)
                );
            }
            shown.forEach((seg) => {
                if (seg.collapsed) {
                    const tip = seg.hiddenSegments.map(s => s.label).join(' / ');
                    html += `<li class="breadcrumb-item"><button type="button" class="breadcrumb-more" data-breadcrumb-expand="1" title="${_escAttr(tip)}（点击展开完整路径）">…</button></li>`;
                } else if (seg.isLast) {
                    html += `<li class="breadcrumb-item active" title="${_escAttr(seg.path)}">${_escHtml(seg.label)}</li>`;
                } else {
                    html += `<li class="breadcrumb-item"><a href="#" data-path="${_escAttr(seg.path)}" title="${_escAttr(seg.path)}">${_escHtml(seg.label)}</a></li>`;
                }
            });
            breadcrumb.innerHTML = html;
            breadcrumb.querySelectorAll('a[data-path]').forEach(el => {
                el.addEventListener('click', (e) => { e.preventDefault(); navigateTo(el.dataset.path); });
            });
            const more = breadcrumb.querySelector('[data-breadcrumb-expand]');
            if (more) more.addEventListener('click', (e) => {
                e.preventDefault();
                _renderBreadcrumbSegments(breadcrumb, segments, sysRoot, true);
            });
        }

        function updateBreadcrumb(absPath) {
            const breadcrumb = document.getElementById('breadcrumb');
            const isWin = navigator.platform.toLowerCase().includes('win');
            const sysRoot = systemInfo.root || (isWin ? 'C:\\\\' : '/');
            const parts = (absPath || '').split(/[\\/]/).filter(p => p);
            const segments = [];
            let cumulative = '';
            if (parts.length > 0 && isWin) {
                cumulative = parts[0] + '\\\\';
                segments.push({ label: parts[0], path: cumulative });
                parts.shift();
            } else {
                cumulative = '/';
            }
            for (let i = 0; i < parts.length; i++) {
                cumulative += (i === 0 && cumulative === '/') ? '' : '/';
                cumulative += parts[i];
                segments.push({ label: parts[i], path: cumulative, isLast: i === parts.length - 1 });
            }
            _renderBreadcrumbSegments(breadcrumb, segments, sysRoot, false);
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

        /* ========== 目录大小后台补齐（原地更新，不重新请求 /api/files） ==========
           后端列表请求只给「缓存/索引里已有」的目录大小，几百万行的子树（分区根等）
           一次求和要好几秒，会先返回 size_pending，然后在后台线程算完写缓存。
           这里轮询 /api/size-status，把算好的大小补进 fileItems 再重绘 ——
           全程不阻塞打开目录，也不会像重新 loadFiles 那样整页闪一下。 */
        let _sizePollTimer = null, _sizePollPath = '';
        function _stopSizePoll() {
            if (_sizePollTimer) { clearInterval(_sizePollTimer); _sizePollTimer = null; }
            _sizePollPath = '';
        }
        function _startSizePoll(dir) {
            _stopSizePoll();
            const pendingNow = fileItems.some(it => it.is_dir && it.size_pending);
            if (!pendingNow || !dir) return;
            _sizePollPath = dir;
            let tries = 0;
            _sizePollTimer = setInterval(async () => {
                if (_sizePollPath !== dir) { _stopSizePoll(); return; }
                if (dir !== currentPath) { _stopSizePoll(); return; }        // 已切到别的目录
                if (++tries > 45) { _stopSizePoll(); return; }               // 最多轮询约 90s，之后放弃
                try {
                    const resp = await fetch(`/api/size-status?path=${encodeURIComponent(dir)}${showHidden ? '&hidden=1' : ''}`);
                    const d = await resp.json();
                    if (!d || d.error || _sizePollPath !== dir || dir !== currentPath) return;
                    let changed = false;
                    fileItems.forEach(it => {
                        if (!it.is_dir || !it.size_pending) return;
                        if (d.sizes && Object.prototype.hasOwnProperty.call(d.sizes, it.name)) {
                            it.size = d.sizes[it.name];
                            it.size_str = formatSize(it.size);
                            it.size_pending = false;
                            changed = true;
                        }
                    });
                    if (changed) { applyFiltersAndSort(); _recomputeStats(); }
                    if (!d.pending || !d.pending.length) _stopSizePoll();     // 全部算完
                } catch (e) { /* 网络抖动忽略，下轮再试 */ }
            }, 2000);
        }

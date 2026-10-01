        // ========== 树型视图 ==========
        function renderTreeView(items) {
            const container = document.getElementById('treeContainer');
            if (!items || items.length === 0) {
                container.innerHTML = `<div style="text-align:center;padding:40px;color:#a0aec0;"><i class="bi bi-inbox" style="font-size:2rem;display:block;margin-bottom:8px;"></i>此目录为空</div>`;
                updateSelectedCount(); updateBatchDeleteBtn();
                return;
            }
            let html = '';
            for (const item of items) {
                const absPath = currentPath ? (currentPath + '/' + item.path).replace(/\\/g, '/').replace(/\\\\+/g, '/') : item.path;
                const isSelected = selectedPaths.has(absPath);
                const isDir = item.is_dir;
                const ext = (item.ext || '').toLowerCase();
                const previewable = isDir ? false : _canPreview(ext);
                const iconClass = isDir ? 'bi bi-folder-fill text-warning tree-icon' : (function () {
                    const icons = { 'pdf': 'bi-filetype-pdf text-danger', 'jpg': 'bi-file-image text-success', 'jpeg': 'bi-file-image text-success', 'png': 'bi-file-image text-success', 'gif': 'bi-file-image text-success', 'svg': 'bi-file-image text-success', 'mp4': 'bi-file-play text-primary', 'avi': 'bi-file-play text-primary', 'mov': 'bi-file-play text-primary', 'mkv': 'bi-file-play text-primary', 'mp3': 'bi-file-music text-primary', 'wav': 'bi-file-music text-primary', 'zip': 'bi-file-zip text-secondary', 'rar': 'bi-file-zip text-secondary', '7z': 'bi-file-zip text-secondary', 'py': 'bi-file-code text-info', 'js': 'bi-file-code text-warning', 'html': 'bi-file-code text-danger', 'css': 'bi-file-code text-info', 'json': 'bi-file-code text-secondary', 'txt': 'bi-file-text text-secondary', 'md': 'bi-file-text text-secondary' };
                    const cls = icons[ext] || 'bi-file-earmark';
                    return `bi ${cls} tree-icon`;
                })();
                const sizeStr = item.size_str || '';
                const metaText = item.is_dir ? sizeStr : sizeStr;
                const lineClass = `tree-line${isSelected ? ' selected' : ''}`;
                const nameClass = previewable ? 'tree-name clickable' : 'tree-name';
                const toggleClass = isDir ? 'tree-toggle' : 'tree-toggle leaf';
                const nameTag = previewable ? `<span class="${nameClass}" data-path="${absPath}" data-ext="${ext}" title="点击预览">${item.name}</span>` : `<span class="tree-name">${item.name}</span>`;
                const moreBtn = `<button class="tree-more" data-action-path="${absPath}" data-is-dir="${item.is_dir}" title="更多操作"><i class="bi bi-three-dots"></i></button>`;
                html += `
                <div class="${lineClass}" data-path="${absPath}">
                    <input class="form-check-input item-checkbox tree-checkbox" type="checkbox" name="files" value="${absPath}" data-path="${absPath}" ${isSelected ? 'checked' : ''} />
                    <span class="${toggleClass}">▶</span>
                    <i class="${iconClass}"></i>
                    ${nameTag}
                    ${metaText ? `<span class="tree-meta">${metaText}</span>` : ''}
                    ${moreBtn}
                </div>
                <div class="tree-children collapsed" data-parent="${absPath}"></div>
            `;
            }
            container.innerHTML = html;
            // 绑定事件
            document.querySelectorAll('.tree-line').forEach(el => {
                const absPath = el.dataset.path;
                const toggle = el.querySelector('.tree-toggle');
                const checkbox = el.querySelector('.item-checkbox');
                const nameEl = el.querySelector('.tree-name.clickable');
                const moreBtn = el.querySelector('.tree-more');
                const children = container.querySelector(`[data-parent="${absPath}"]`);
                let expanded = false;
                // Toggle 展开/折叠
                toggle.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (toggle.classList.contains('leaf')) return;
                    expanded = !expanded;
                    toggle.classList.toggle('expanded', expanded);
                    children.classList.toggle('collapsed', !expanded);
                    if (expanded && !children.dataset.loaded) {
                        children.dataset.loaded = 'true';
                        loadTreeChildren(absPath, children);
                    }
                });
                // 复选框
                checkbox.addEventListener('change', (e) => {
                    e.stopPropagation();
                    if (checkbox.checked) selectedPaths.add(absPath); else selectedPaths.delete(absPath);
                    el.classList.toggle('selected', checkbox.checked);
                    updateSelectedCount(); updateBatchDeleteBtn();
                });
                // 整行点击（展开目录）
                el.addEventListener('click', (e) => {
                    if (e.target.tagName === 'INPUT' || e.target.closest('.tree-more')) return;
                    if (e.target.classList.contains('tree-toggle')) return;
                    if (e.target.classList.contains('tree-name.clickable')) { previewFile(absPath); return; }
                    // 目录导航
                    const item = fileItems.find(it => {
                        const p = currentPath ? (currentPath + '/' + it.path).replace(/\\/g, '/').replace(/\\\\+/g, '/') : it.path;
                        return p === absPath;
                    });
                    if (item && item.is_dir) { navigateTo(absPath); }
                });
                // 预览
                if (nameEl && nameEl.dataset.ext) {
                    nameEl.addEventListener('click', (e) => { e.stopPropagation(); previewFile(absPath); });
                }
                // 更多
                if (moreBtn) moreBtn.addEventListener('click', (e) => { e.stopPropagation(); showActionMenu(moreBtn, absPath, moreBtn.dataset.isDir === 'true'); });
            });
            updateSelectedCount(); updateBatchDeleteBtn();
        }

        async function loadTreeChildren(absPath, container) {
            try {
                const resp = await fetch(`/api/files?path=${encodeURIComponent(absPath)}`);
                const data = await resp.json();
                if (data.error) { container.innerHTML = `<div style="padding:4px 0;color:#dc2626;font-size:0.8rem;">${data.error}</div>`; return; }
                let html = '';
                for (const item of _sortItems(data.items)) {
                    const childAbsPath = absPath + '/' + item.path;
                    const isDir = item.is_dir;
                    const ext = (item.ext || '').toLowerCase();
                    const previewable = isDir ? false : _canPreview(ext);
                    const iconClass = isDir ? 'bi bi-folder-fill text-warning tree-icon' : 'bi bi-file-earmark tree-icon';
                    const sizeStr = item.size_str || '';
                    const nameTag = previewable ? `<span class="tree-name clickable" data-path="${childAbsPath}" data-ext="${ext}">${item.name}</span>` : `<span class="tree-name">${item.name}</span>`;
                    html += `
                    <div class="tree-line" data-path="${childAbsPath}">
                        <input class="form-check-input item-checkbox tree-checkbox" type="checkbox" name="files" value="${childAbsPath}" data-path="${childAbsPath}" />
                        <span class="tree-toggle${isDir ? '' : ' leaf'}">▶</span>
                        <i class="${iconClass}"></i>
                        ${nameTag}
                        ${sizeStr ? `<span class="tree-meta">${sizeStr}</span>` : ''}
                        <button class="tree-more" data-action-path="${childAbsPath}" data-is-dir="${item.is_dir}" title="更多操作"><i class="bi bi-three-dots"></i></button>
                    </div>
                    <div class="tree-children collapsed" data-parent="${childAbsPath}"></div>
                `;
                }
                if (html === '') {
                    container.innerHTML = '<div style="padding:4px 0;color:#a0aec0;font-size:0.8rem;">(空)</div>';
                    return;
                }
                container.innerHTML = html;
                // 绑定子节点事件
                container.querySelectorAll('.tree-line').forEach(el => {
                    const childAbs = el.dataset.path;
                    const toggle = el.querySelector('.tree-toggle');
                    const checkbox = el.querySelector('.item-checkbox');
                    const nameEl = el.querySelector('.tree-name.clickable');
                    const childContainer = container.querySelector(`[data-parent="${childAbs}"]`);
                    const moreBtn = el.querySelector('.tree-more');
                    let childExpanded = false;
                    toggle.addEventListener('click', (e) => {
                        e.stopPropagation();
                        if (toggle.classList.contains('leaf')) return;
                        childExpanded = !childExpanded;
                        toggle.classList.toggle('expanded', childExpanded);
                        childContainer.classList.toggle('collapsed', !childExpanded);
                        if (childExpanded && !childContainer.dataset.loaded) {
                            childContainer.dataset.loaded = 'true';
                            loadTreeChildren(childAbs, childContainer);
                        }
                    });
                    checkbox.addEventListener('change', (e) => {
                        e.stopPropagation();
                        if (checkbox.checked) selectedPaths.add(childAbs); else selectedPaths.delete(childAbs);
                        el.classList.toggle('selected', checkbox.checked);
                        updateSelectedCount(); updateBatchDeleteBtn();
                    });
                    el.addEventListener('click', (e) => {
                        if (e.target.tagName === 'INPUT' || e.target.closest('.tree-more') || e.target.classList.contains('tree-toggle')) return;
                        if (e.target.classList.contains('tree-name.clickable')) { previewFile(childAbs); return; }
                        navigateTo(childAbs);
                    });
                    if (nameEl && nameEl.dataset.ext) {
                        nameEl.addEventListener('click', (e) => { e.stopPropagation(); previewFile(childAbs); });
                    }
                    if (moreBtn) moreBtn.addEventListener('click', (e) => { e.stopPropagation(); showActionMenu(moreBtn, childAbs, moreBtn.dataset.isDir === 'true'); });
                });
            } catch (e) {
                container.innerHTML = `<div style="padding:4px 0;color:#dc2626;font-size:0.8rem;">加载失败</div>`;
            }
        }

        let _currentFetchController = null;
        let _isNavigating = false;

        function _abortPendingFetch() {
            if (_currentFetchController) {
                try { _currentFetchController.abort(); } catch (e) { /* ignore */ }
                _currentFetchController = null;
            }
        }

        function _setLoading(loading, path) {
            _isNavigating = loading;
            // 全局加载遮罩：列表/图标/树型视图统一切换文件夹时的等待锁，
            // 加载中拦截点击，避免并发切换目录导致请求被中断(ERR_ABORTED)
            const overlay = document.getElementById('fmLoadingOverlay');
            if (overlay) {
                overlay.style.display = loading ? 'flex' : 'none';
                const txt = document.getElementById('fmLoadingText');
                if (txt) {
                    txt.textContent = loading
                        ? `正在加载目录…${path ? ' 「' + path.substring(0, 80) + (path.length > 80 ? '…' : '') + '」' : ''}`
                        : '正在加载目录…';
                }
            }
            const tbl = document.getElementById('fileBody');
            if (tbl) {
                tbl.classList.toggle('is-loading', loading);
                const existing = tbl.querySelector('.fm-loading-bar');
                if (loading && !existing) {
                    const rows = selectMode ? 6 : 5;
                    tbl.insertAdjacentHTML('afterbegin',
                        `<tr class="fm-loading-bar" data-fm-loading="true"><td colspan="${rows}">
                        <div style="display:flex;align-items:center;gap:8px;padding:10px 8px;color:#475569;font-size:0.85rem;">
                            <div class="spinner-border spinner-border-sm text-primary" role="status" style="width:1rem;height:1rem;"></div>
                            <span>正在加载目录…${path ? (' 「' + path.substring(0, 80) + (path.length > 80 ? '…' : '') + '」') : ''}</span>
                        </div>
                    </td></tr>`);
                } else if (!loading && existing) {
                    existing.remove();
                }
            }
        }

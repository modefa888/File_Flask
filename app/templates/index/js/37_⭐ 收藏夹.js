        // ========== ⭐ 收藏夹 ==========
        let _favs = [];              // 收藏条目 {path, name, added, group?, is_dir}
        let _favGroupOrder = [];     // 分组展示顺序（"__ungrouped__" 占位「其他」）
        let _favActiveTab = '__all__';

        function loadFavs() {
            return fetch('/api/favorites')
                .then(r => r.json())
                .then(d => {
                    _favs = (d.items || []).slice();
                    _favGroupOrder = (d.groups || []).slice();
                })
                .catch(() => { });
        }

        function _favBasename(p) {
            return (p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
        }

        // 收藏跳转后：等待列表渲染完成，滚动到对应行并闪烁高亮
        let _pendingHighlightPath = null;
        function _highlightRowByPath(path) {
            const rows = document.querySelectorAll('tr[data-path], .icon-item[data-path], .tree-line[data-path]');
            let el = null;
            for (const c of rows) { if (c.dataset.path === path) { el = c; break; } }
            if (!el) return false;
            try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) { try { el.scrollIntoView(); } catch (e2) { } }
            el.classList.remove('fav-highlight');
            void el.offsetWidth;   // 强制重排以重新触发动画
            el.classList.add('fav-highlight');
            // 动画自身约 2.7s 淡出；这里兜底清理所有高亮行（防止元素被重渲染替换后残留）
            setTimeout(() => {
                document.querySelectorAll('.fav-highlight').forEach(n => n.classList.remove('fav-highlight'));
            }, 3000);
            return true;
        }
        function _pollPendingHighlight() {
            if (!_pendingHighlightPath) return;
            const target = _pendingHighlightPath;
            const started = Date.now();
            const timer = setInterval(() => {
                if (_pendingHighlightPath !== target) { clearInterval(timer); return; }   // 已发起新的跳转
                if (_highlightRowByPath(target)) {
                    clearInterval(timer);
                    _pendingHighlightPath = null;
                } else if (Date.now() - started > 10000) {
                    clearInterval(timer);
                    _pendingHighlightPath = null;
                }
            }, 120);
        }

        function _fmtFavAdded(sec) {
            if (!sec) return '';
            const d = new Date(sec * 1000);
            const pad = n => String(n).padStart(2, '0');
            return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
                ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
        }

        function _favApi(method, url, body) {
            return fetch(url, {
                method: method,
                headers: { 'Content-Type': 'application/json' },
                body: body ? JSON.stringify(body) : undefined
            }).then(r => r.json());
        }

        // 收藏 / 取消收藏指定路径（菜单、收藏夹抽屉共用）
        async function toggleFavByPath(p) {
            if (!p) return;
            const exists = _favs.find(f => f.path === p);
            if (exists) {
                const ok = await showConfirm('取消收藏 "' + _favBasename(p) + '" 吗？');
                if (!ok) return;
                const d = await _favApi('DELETE', '/api/favorites', { path: p });
                if (d.error) { showToast('错误', d.error, 'danger'); return; }
                showToast('提示', '已取消收藏', 'info');
                await loadFavs();
                const panel = document.getElementById('favoritePanel');
                if (panel && panel.innerHTML) _renderFavTabs();
                return;
            }
            // 新增收藏：弹出分组选择悬浮框（点选现有分组或输入新分组）
            const groups = (_favGroupOrder || []).filter(g => g && g !== '__ungrouped__');
            showInputDialog('收藏「' + _favBasename(p) + '」', '选择分组，或输入新分组名称（留空归入「其他」）', '', async (name) => {
                name = (name || '').trim();
                const d = await _favApi('POST', '/api/favorites', { path: p, group: name });
                if (d.error) { showToast('错误', d.error, 'danger'); return false; }
                showToast('成功', '已收藏到「' + (name || '其他') + '」', 'success');
                await loadFavs();
                const panel = document.getElementById('favoritePanel');
                if (panel && panel.innerHTML) _renderFavTabs();
                return true;
            }, null, { suggestions: groups, suggestionsLabel: '选择分组' });
        }

        // 收藏 / 取消收藏当前目录（工具栏 ⭐ 收藏本目录）
        async function toggleFavCurrent() {
            if (!currentPath) { showToast('提示', '尚未进入任何目录', 'warning'); return; }
            await toggleFavByPath(currentPath);
        }

        function showFavorites() {
            const container = document.getElementById('favoritePanel');
            if (!container) return;
            container.innerHTML = `
            <div class="delhist-overlay">
                <div class="delhist-panel fav-panel">
                    <div class="panel-header">
                        <span class="panel-title"><i class="bi bi-star-fill"></i> 收藏夹</span>
                        <button class="panel-close" title="关闭"><i class="bi bi-x-lg"></i></button>
                    </div>
                    <div class="fav-tabs" id="favTabs"></div>
                    <div class="panel-body" id="favBody"></div>
                    <div class="panel-footer fav-footer">
                        <button class="fav-cur-btn" id="favCurPanelBtn"><i class="bi bi-star"></i> 收藏当前目录</button>
                        <span class="fav-tip">点名称跳转 · 🏷️ 改分组 · 🗑 取消收藏</span>
                    </div>
                </div>
            </div>
        `;
            container.querySelector('.panel-close').addEventListener('click', closeFavorites);
            container.querySelector('.delhist-overlay').addEventListener('click', (e) => {
                if (e.target === container.querySelector('.delhist-overlay')) closeFavorites();
            });
            document.getElementById('favCurPanelBtn').addEventListener('click', toggleFavCurrent);
            _renderFavTabs();
        }

        function closeFavorites() {
            const container = document.getElementById('favoritePanel');
            if (container) container.innerHTML = '';
        }

        function _favTabList() {
            // 顺序：全部 → 各分组（按保存顺序）→ 其他 → ＋新建
            const list = [{ key: '__all__', label: '全部' }];
            (_favGroupOrder || []).forEach(g => { if (g !== '__ungrouped__') list.push({ key: g, label: g }); });
            list.push({ key: '__ungrouped__', label: '其他' });
            return list;
        }

        function _renderFavTabs() {
            const wrap = document.getElementById('favTabs');
            if (!wrap) return;
            if (!_favTabList().some(t => t.key === _favActiveTab)) _favActiveTab = '__all__';
            let html = '';
            _favTabList().forEach(t => {
                const cnt = t.key === '__all__' ? _favs.length
                    : _favs.filter(f => (t.key === '__ungrouped__' ? !f.group : f.group === t.key)).length;
                html += `<button class="fav-tab${_favActiveTab === t.key ? ' on' : ''}" data-tab="${_escAttr(t.key)}">${_escapeHtml(t.label)}<span class="cnt">${cnt}</span></button>`;
            });
            html += `<button class="fav-tab fav-tab-add" id="favNewGroupBtn"><i class="bi bi-plus-lg"></i> 新建分组</button>`;
            wrap.innerHTML = html;
            wrap.querySelectorAll('.fav-tab[data-tab]').forEach(btn => {
                btn.addEventListener('click', () => {
                    _favActiveTab = btn.dataset.tab;
                    _renderFavTabs();
                });
            });
            wrap.addEventListener('wheel', (e) => {
                // 竖向滚轮映射为横向滚动（shift+滚轮或触摸板原生横向滚动不受影响）
                if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
                    if (wrap.scrollWidth > wrap.clientWidth) {
                        e.preventDefault();
                        wrap.scrollLeft += e.deltaY;
                    }
                }
            }, { passive: false });
            wrap.querySelector('#favNewGroupBtn').addEventListener('click', () => {
                showInputDialog('新建分组', '分组名称', '', async (name) => {
                    name = (name || '').trim();
                    if (!name) return false;
                    const d = await _favApi('POST', '/api/favorites/group', { name: name });
                    if (d.error) { showToast('错误', d.error, 'danger'); return false; }
                    await loadFavs();
                    _favActiveTab = name;
                    _renderFavTabs();
                    return true;
                });
            });
            _renderFavList();
        }

        function _renderFavList() {
            const body = document.getElementById('favBody');
            if (!body) return;
            let list = _favs;
            if (_favActiveTab !== '__all__') {
                list = _favs.filter(f => _favActiveTab === '__ungrouped__' ? !f.group : f.group === _favActiveTab);
            }
            let html = '';
            // 当前为具体分组：显示分组管理（重命名/删除分组）
            if (_favActiveTab !== '__all__' && _favActiveTab !== '__ungrouped__') {
                html += `<div class="fav-grp-head"><span>📁 ${_escapeHtml(_favActiveTab)}</span>
                <span class="fav-acts">
                    <button class="fav-mini" id="favRenameGroupBtn" title="重命名分组">✏️</button>
                    <button class="fav-mini" id="favDelGroupBtn" title="删除分组（收藏保留，归入其他）">🗑️</button>
                </span></div>`;
            }
            if (!list.length) {
                html += `<div class="delhist-empty"><i class="bi bi-star"></i>暂无收藏<br><span style="font-size:0.75rem;">进入目录后点击工具栏「⭐ 收藏本目录」</span></div>`;
                body.innerHTML = html;
                _bindFavGroupActs();
                return;
            }
            list.forEach(f => {
                const name = f.name || _favBasename(f.path);
                const ico = f.is_dir ? '📁' : '📄';
                html += `<div class="fav-row" data-path="${_escAttr(f.path)}" title="${_escAttr(f.path)}">
                <span class="fav-ico">${ico}</span>
                <span class="fav-name">${_escapeHtml(name)}</span>
                <span class="fav-time">${_fmtFavAdded(f.added)}</span>
                <span class="fav-acts">
                    <button class="fav-mini fav-act-group" data-path="${_escAttr(f.path)}" data-group="${_escAttr(f.group || '')}" title="改分组">🏷️</button>
                    <button class="fav-mini fav-act-del" data-path="${_escAttr(f.path)}" title="取消收藏">🗑️</button>
                </span>
            </div>`;
            });
            body.innerHTML = html;
            _bindFavGroupActs();
            // 行点击跳转：目录直接进入；文件进入其所在目录
            body.querySelectorAll('.fav-row').forEach(row => {
                row.addEventListener('click', (e) => {
                    if (e.target.closest('.fav-mini')) return;
                    const p = row.dataset.path;
                    const item = _favs.find(f => f.path === p);
                    const target = item && item.is_dir ? p : (p.replace(/[\\/][^\\/]+[\\/]?$/, '') || p);
                    _pendingHighlightPath = p;        // 跳转后高亮此条目（文件高亮所在目录中的它，目录高亮自身）
                    navigateTo(target);
                    closeFavorites();
                    _pollPendingHighlight();
                });
            });
            body.querySelectorAll('.fav-act-group').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const p = btn.dataset.path;
                    const existingGroups = (_favGroupOrder || []).filter(g => g && g !== '__ungrouped__');
                    showInputDialog('修改分组', '分组名称（留空归入「其他」，输入新名称自动创建）', btn.dataset.group, async (name) => {
                        name = (name || '').trim();
                        const d = await _favApi('PUT', '/api/favorites', { path: p, group: name });
                        if (d.error) { showToast('错误', d.error, 'danger'); return false; }
                        await loadFavs();
                        _renderFavTabs();
                        return true;
                    }, null, { suggestions: existingGroups, suggestionsLabel: '现有分组' });
                });
            });
            body.querySelectorAll('.fav-act-del').forEach(btn => {
                btn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    const p = btn.dataset.path;
                    const ok = await showConfirm('取消收藏 "' + _favBasename(p) + '" 吗？');
                    if (!ok) return;
                    const d = await _favApi('DELETE', '/api/favorites', { path: p });
                    if (d.error) { showToast('错误', d.error, 'danger'); return; }
                    await loadFavs();
                    _renderFavTabs();
                });
            });
        }

        function _bindFavGroupActs() {
            const rn = document.getElementById('favRenameGroupBtn');
            if (rn) rn.addEventListener('click', () => {
                showInputDialog('重命名分组', '新的分组名称', _favActiveTab, async (name) => {
                    name = (name || '').trim();
                    if (!name || name === _favActiveTab) return false;
                    const d = await _favApi('POST', '/api/favorites/group', { old: _favActiveTab, name: name });
                    if (d.error) { showToast('错误', d.error, 'danger'); return false; }
                    await loadFavs();
                    _favActiveTab = name;
                    _renderFavTabs();
                    return true;
                });
            });
            const del = document.getElementById('favDelGroupBtn');
            if (del) del.addEventListener('click', async () => {
                const ok = await showConfirm('删除分组 "' + _favActiveTab + '" 吗？组内收藏会保留并归入「其他」。');
                if (!ok) return;
                const d = await _favApi('DELETE', '/api/favorites/group', { name: _favActiveTab });
                if (d.error) { showToast('错误', d.error, 'danger'); return; }
                await loadFavs();
                _favActiveTab = '__all__';
                _renderFavTabs();
            });
        }

        function _initFavUI() {
            const favBtn = document.getElementById('favPanelBtn');
            if (favBtn) favBtn.addEventListener('click', showFavorites);
            const curBtn = document.getElementById('favCurBtn');
            if (curBtn) curBtn.addEventListener('click', toggleFavCurrent);
            loadFavs();
        }
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', _initFavUI);
        } else {
            _initFavUI();
        }

        function _formatTimeAgo(ts) {
            if (!ts) return '--';
            const diff = Math.floor((Date.now() / 1000) - ts);
            if (diff < 60) return diff + '秒前';
            if (diff < 3600) return Math.floor(diff / 60) + '分钟前';
            if (diff < 86400) return Math.floor(diff / 3600) + '小时前';
            return Math.floor(diff / 86400) + '天前';
        }

        function _loadDeleteHistoryList() {
            fetch('/api/delete-history')
                .then(r => r.json())
                .then(data => {
                    const body = document.getElementById('delhistBody');
                    const clearBtn = document.getElementById('delhistClearBtn');
                    const badge = document.getElementById('delhistCountBadge');
                    if (!body) return;
                    const items = data.items || [];
                    const count = data.count || 0;

                    // 更新顶部徽章
                    if (badge) {
                        badge.textContent = count > 0 ? (count > 99 ? '99+' : count) : '0';
                        badge.classList.toggle('empty', count === 0);
                    }

                    if (items.length === 0) {
                        body.innerHTML = '<div class="delhist-empty"><i class="bi bi-check-circle"></i>回收站为空</div>';
                        if (clearBtn) clearBtn.disabled = true;
                        return;
                    }

                    if (clearBtn) clearBtn.disabled = false;

                    let html = '';
                    for (const item of items) {
                        const iconClass = item.is_dir ? 'bi bi-folder-fill dh-icon dir' : 'bi bi-file-earmark dh-icon';
                        const timeStr = _formatTimeAgo(item.deleted_at);
                        const sizeStr = item.size > 0 ? formatSize(item.size) : (item.is_dir ? '目录' : '0 B');
                        const pathDisp = item.original_path.replace(/^[^:]+:/, '').replace(/^\/+/, '');
                        const exists = item.exists !== false;
                        const statusClass = exists ? '' : 'lost';
                        const statusText = exists ? '可恢复' : '文件已丢失';
                        html += `
                        <div class="delhist-item">
                            <span class="${iconClass}"></span>
                            <div class="dh-info">
                                <div class="dh-name">${item.name}</div>
                                <div class="dh-path">${item.original_path}</div>
                                <div class="dh-meta">
                                    <span class="dh-time"><i class="bi bi-clock"></i> ${timeStr}</span>
                                    <span class="dh-size"><i class="bi bi-hdd"></i> ${sizeStr}</span>
                                    <span class="dh-status ${statusClass}"><i class="bi bi-${exists ? 'check-circle' : 'x-circle'}"></i> ${statusText}</span>
                                </div>
                            </div>
                            <div class="dh-actions">
                                <button class="btn btn-restore" data-tid="${item.id}" ${exists ? '' : 'disabled'} title="恢复"><i class="bi bi-arrow-counterclockwise"></i> 恢复</button>
                                <button class="btn btn-remove" data-tid="${item.id}" title="永久删除"><i class="bi bi-trash3"></i> 删除</button>
                            </div>
                        </div>
                    `;
                    }
                    body.innerHTML = html;

                    // 绑定恢复按钮
                    body.querySelectorAll('.btn-restore').forEach(btn => {
                        btn.addEventListener('click', () => {
                            restoreFromTrash(btn.dataset.tid, btn);
                        });
                    });
                    // 绑定删除按钮
                    body.querySelectorAll('.btn-remove').forEach(btn => {
                        btn.addEventListener('click', () => {
                            permanentlyDeleteItem(btn.dataset.tid, btn);
                        });
                    });
                })
                .catch(e => {
                    const body = document.getElementById('delhistBody');
                    if (body) body.innerHTML = '<div class="delhist-empty"><i class="bi bi-exclamation-triangle"></i>加载失败</div>';
                });
        }

        function _loadDeleteHistoryCount() {
            fetch('/api/delete-history')
                .then(r => r.json())
                .then(data => {
                    const badge = document.getElementById('delhistCountBadge');
                    if (!badge) return;
                    const count = data.count || 0;
                    badge.textContent = count > 0 ? (count > 99 ? '99+' : count) : '0';
                    badge.classList.toggle('empty', count === 0);
                })
                .catch(() => { });
        }

        function loadDeleteHistoryCount() {
            _loadDeleteHistoryCount();
        }

        async function restoreFromTrash(trashId, btn) {
            btn.disabled = true;
            btn.innerHTML = '<i class="bi bi-hourglass-split"></i> 恢复中...';
            try {
                const resp = await fetch('/api/undo-delete', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ trash_id: trashId })
                });
                const data = await resp.json();
                if (data.success) {
                    showToast('恢复成功', data.message || '已恢复', 'success');
                    loadFiles(currentPath);
                    _loadDeleteHistoryList();
                } else {
                    showToast('恢复失败', data.error || '恢复失败', 'warning');
                    btn.disabled = false;
                    btn.innerHTML = '<i class="bi bi-arrow-counterclockwise"></i> 恢复';
                }
            } catch (e) {
                showToast('错误', '恢复失败: ' + e.message, 'danger');
                btn.disabled = false;
                btn.innerHTML = '<i class="bi bi-arrow-counterclockwise"></i> 恢复';
            }
        }

        async function permanentlyDeleteItem(trashId, btn) {
            btn.disabled = true;
            btn.innerHTML = '<i class="bi bi-trash3"></i> 删除中...';
            try {
                const resp = await fetch('/api/delete-history/one', {
                    method: 'DELETE',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ trash_id: trashId })
                });
                const data = await resp.json();
                if (data.success) {
                    showToast('已删除', '已永久删除: ' + data.removed, 'info');
                    _loadDeleteHistoryList();
                } else {
                    showToast('错误', data.error || '删除失败', 'danger');
                    btn.disabled = false;
                    btn.innerHTML = '<i class="bi bi-trash3"></i> 删除';
                }
            } catch (e) {
                showToast('错误', '删除失败: ' + e.message, 'danger');
                btn.disabled = false;
                btn.innerHTML = '<i class="bi bi-trash3"></i> 删除';
            }
        }

        async function clearDeleteHistory() {
            const confirmed = await showConfirm('确定要清空回收站吗？这将永久删除所有已删除的文件/目录，无法恢复！');
            if (!confirmed) return;
            const btn = document.getElementById('delhistClearBtn');
            btn.disabled = true;
            btn.innerHTML = '<i class="bi bi-hourglass-split"></i> 清理中...';
            try {
                const resp = await fetch('/api/delete-history/clear', { method: 'POST' });
                const data = await resp.json();
                if (data.success) {
                    showToast('已清空', '已永久删除 ' + data.removed + ' 项' + (data.errors > 0 ? '，' + data.errors + ' 项失败' : ''), 'success');
                    _loadDeleteHistoryList();
                } else {
                    showToast('错误', data.error || '清空失败', 'danger');
                    btn.disabled = false;
                    btn.innerHTML = '<i class="bi bi-trash3"></i> 清空回收站';
                }
            } catch (e) {
                showToast('错误', '清空失败: ' + e.message, 'danger');
                btn.disabled = false;
                btn.innerHTML = '<i class="bi bi-trash3"></i> 清空回收站';
            }
        }

        function _handleIndexRebuild() {
            const status = document.getElementById('idxStatus').textContent;
            if (status === '扫描中...') return;

            showConfirm('确定要重建索引吗？重建将重新扫描所有文件并更新统计信息，耗时较长。')
                .then(confirmed => {
                    if (!confirmed) return;
                    const rebuildBtn = document.getElementById('idxRebuildBtn');
                    const cancelBtn = document.getElementById('idxCancelBtn');
                    rebuildBtn.disabled = true;
                    rebuildBtn.innerHTML = '<i class="bi bi-arrow-repeat spin" style="display:inline-block;animation:spin 1s linear infinite;"></i> 启动中...';
                    cancelBtn.style.display = '';

                    fetch('/api/index/build', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ roots: '' }) })
                        .then(r => r.json())
                        .then(data => {
                            rebuildBtn.disabled = false;
                            rebuildBtn.innerHTML = '<i class="bi bi-arrow-clockwise"></i> 重建索引';
                            if (data.error) { showToast('错误', data.error, 'danger'); return; }
                            showToast('成功', '索引构建已启动', 'success');
                            startIndexPolling();
                            setTimeout(_loadIndexDetail, 1000);
                        })
                        .catch(e => {
                            rebuildBtn.disabled = false;
                            rebuildBtn.innerHTML = '<i class="bi bi-arrow-clockwise"></i> 重建索引';
                            showToast('错误', e.message, 'danger');
                        });
                });
        }

        function _handleIndexCancel() {
            fetch('/api/index/cancel', { method: 'POST' })
                .then(r => r.json())
                .then(() => {
                    const cancelBtn = document.getElementById('idxCancelBtn');
                    if (cancelBtn) cancelBtn.style.display = 'none';
                    showToast('提示', '已取消索引扫描', 'info');
                    setTimeout(_loadIndexDetail, 500);
                })
                .catch(() => { });
        }

        function _loadIndexDetail() {
            fetch('/api/index/detail')
                .then(r => r.json())
                .then(renderIndexDetail)
                .catch(() => { });
        }

        function renderIndexDetail(data) {
            const status = data.status || 'idle';
            const progress = data.progress || 0;
            const totalFiles = data.total_files || 0;
            const totalDirs = data.total_dirs || 0;
            const totalSizeStr = data.total_size_str || '--';
            const lastScan = data.last_scan || '--';
            const statusDetail = data.status_detail || '';

            document.getElementById('idxFileCount').textContent = totalFiles.toLocaleString();
            document.getElementById('idxDirCount').textContent = totalDirs.toLocaleString();
            document.getElementById('idxTotalSize').textContent = totalSizeStr;
            document.getElementById('idxLastScan').textContent = lastScan;

            // 状态
            const statusEl = document.getElementById('idxStatus');
            const progressArea = document.getElementById('idxProgressArea');
            const cancelBtn = document.getElementById('idxCancelBtn');
            if (status === 'scanning') {
                statusEl.textContent = '扫描中... ' + (statusDetail || '');
                progressArea.style.display = '';
                document.getElementById('idxProgressText').textContent = progress + '% ' + (statusDetail || '扫描中');
                document.getElementById('idxProgressFill').style.width = progress + '%';
                cancelBtn.style.display = '';
            } else if (status === 'error') {
                statusEl.textContent = '❌ 失败';
                progressArea.style.display = 'none';
                cancelBtn.style.display = 'none';
            } else {
                statusEl.textContent = '✅ 就绪';
                progressArea.style.display = 'none';
                cancelBtn.style.display = 'none';
            }

            // Top 15 目录
            const topDirsEl = document.getElementById('idxTopDirs');
            const topDirs = data.top_dirs || [];
            if (topDirs.length === 0) {
                topDirsEl.innerHTML = '<div class="idx-empty"><i class="bi bi-inbox"></i>暂无数据</div>';
            } else {
                let html = '<table class="idx-table"><thead><tr><th>#</th><th>目录</th><th>文件数</th><th class="num">大小</th></tr></thead><tbody>';
                topDirs.forEach((item, idx) => {
                    html += `<tr><td class="num">${idx + 1}</td><td class="path-cell" data-path="${_escAttr(item.path)}">${_escHtml(item.name)}</td><td class="num">${item.file_count.toLocaleString()}</td><td class="num">${item.size_str}</td></tr>`;
                });
                html += '</tbody></table>';
                topDirsEl.innerHTML = html;
                // 路径点击导航
                topDirsEl.querySelectorAll('.path-cell').forEach(el => {
                    el.addEventListener('click', () => {
                        closeIndexDetail();
                        navigateTo(el.dataset.path);
                    });
                });
            }

            // 类型分布
            const typeDistEl = document.getElementById('idxTypeDist');
            const typeDist = data.type_distribution || [];
            if (typeDist.length === 0) {
                typeDistEl.innerHTML = '<div class="idx-empty"><i class="bi bi-inbox"></i>暂无数据</div>';
            } else {
                let html = '<table class="idx-table"><thead><tr><th>后缀</th><th>数量</th><th class="num">总大小</th></tr></thead><tbody>';
                typeDist.forEach(item => {
                    html += `<tr><td><span class="ext-badge">${_escHtml(item.ext)}</span></td><td class="num">${item.count.toLocaleString()}</td><td class="num">${item.size_str}</td></tr>`;
                });
                html += '</tbody></table>';
                typeDistEl.innerHTML = html;
            }

            // 最大文件 Top 10
            const topFilesEl = document.getElementById('idxTopFiles');
            const topFiles = data.top_files || [];
            if (topFiles.length === 0) {
                topFilesEl.innerHTML = '<div class="idx-empty"><i class="bi bi-inbox"></i>暂无数据</div>';
            } else {
                let html = '<table class="idx-table"><thead><tr><th>文件名</th><th>后缀</th><th class="num">大小</th></tr></thead><tbody>';
                topFiles.forEach(item => {
                    html += `<tr><td class="path-cell" data-path="${_escAttr(item.parent)}">${_escHtml(item.name)}</td><td><span class="ext-badge">${_escHtml(item.ext)}</span></td><td class="num">${item.size_str}</td></tr>`;
                });
                html += '</tbody></table>';
                topFilesEl.innerHTML = html;
                topFilesEl.querySelectorAll('.path-cell').forEach(el => {
                    el.addEventListener('click', () => {
                        closeIndexDetail();
                        navigateTo(el.dataset.path);
                    });
                });
            }
        }

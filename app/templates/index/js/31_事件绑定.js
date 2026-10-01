        // ========== 事件绑定 ==========
        function initEvents() {
            document.getElementById('refreshBtn').addEventListener('click', () => loadFiles(currentPath));
            // 上级目录按钮
            document.getElementById('parentDirBtn').addEventListener('click', () => {
                const target = document.getElementById('parentDirBtn').dataset.target;
                if (target) navigateTo(target);
            });
            document.getElementById('selectAll').addEventListener('change', (e) => {
                const checked = e.target.checked;
                document.querySelectorAll('.item-checkbox:not(.parent-cb)').forEach(el => {
                    el.checked = checked;
                    const path = el.dataset.path;
                    if (checked) selectedPaths.add(path);
                    else selectedPaths.delete(path);
                    el.closest('tr').classList.toggle('selected', checked);
                });
                updateSelectedCount();
                updateBatchDeleteBtn();
            });
            // ===== 底部多选操作栏 =====
            document.getElementById('selAllBtn').addEventListener('click', () => {
                const boxes = document.querySelectorAll('.item-checkbox:not(.parent-cb)');
                const allSel = boxes.length > 0 && Array.from(boxes).every(b => b.checked);
                _setAllSelected(!allSel);
            });
            document.getElementById('selMoveBtn').addEventListener('click', () => {
                if (selectedPaths.size === 0) { showToast('提示', '请先选择条目', 'warning'); return; }
                setPendingOp('move', Array.from(selectedPaths));
                toggleSelectMode();
            });
            document.getElementById('selCopyBtn').addEventListener('click', () => {
                if (selectedPaths.size === 0) { showToast('提示', '请先选择条目', 'warning'); return; }
                setPendingOp('copy', Array.from(selectedPaths));
                toggleSelectMode();
            });
            document.getElementById('selDelBtn').addEventListener('click', () => {
                if (selectedPaths.size === 0) { showToast('提示', '请先选择条目', 'warning'); return; }
                deleteFiles(Array.from(selectedPaths));
            });
            document.getElementById('selZipBtn').addEventListener('click', () => {
                if (selectedPaths.size === 0) { showToast('提示', '请先选择条目', 'warning'); return; }
                const paths = Array.from(selectedPaths);
                // 目标目录：取第一个路径的父目录
                let destDir = paths[0];
                if (!paths[0].endsWith('/') && !paths[0].endsWith('\\')) {
                    const idx = paths[0].lastIndexOf('/');
                    const idx2 = paths[0].lastIndexOf('\\');
                    const best = idx >= 0 ? (idx2 > idx ? idx2 : idx) : idx2;
                    destDir = best >= 0 ? paths[0].substring(0, best) : paths[0];
                }
                compressSelected(paths, destDir);
            });
            document.getElementById('selCancelBtn').addEventListener('click', () => {
                if (selectMode) toggleSelectMode();
            });
            // 粘贴悬浮按钮：单击执行，右键取消
            document.getElementById('pasteFab').addEventListener('click', executePendingOp);
            document.getElementById('pasteFab').addEventListener('contextmenu', (e) => {
                e.preventDefault();
                if (!pendingOp) return;
                _clearPendingOp();
                showToast('提示', '已取消待执行的移动/复制操作', 'info');
            });
            document.getElementById('filterInput').addEventListener('input', applyFiltersAndSort);
            document.getElementById('typeFilter').addEventListener('change', applyFiltersAndSort);
            document.getElementById('goPathBtn').addEventListener('click', () => {
                const path = document.getElementById('pathInput').value.trim();
                navigateTo(path);
            });
            document.getElementById('pathInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') document.getElementById('goPathBtn').click(); });
            document.querySelectorAll('.sortable').forEach(el => {
                el.addEventListener('click', () => {
                    const field = el.dataset.sort;
                    if (field === sortField) sortAsc = !sortAsc;
                    else { sortField = field; sortAsc = true; }
                    applyFiltersAndSort();
                });
            });
            // 快捷键
            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') {
                    if (typeof _closeMenus === 'function') _closeMenus();   // Esc 也能关掉「更多操作」菜单
                    document.querySelectorAll('.item-checkbox').forEach(el => {
                        el.checked = false;
                        selectedPaths.delete(el.dataset.path);
                        // 列表视图是 <tr>，图标/树型视图分别是 .icon-item / .tree-line（找不到时不能直接 .classList）
                        const row = el.closest('tr, .icon-item, .tree-line');
                        if (row) row.classList.remove('selected');
                    });
                    updateSelectedCount();
                    updateBatchDeleteBtn();
                    document.getElementById('selectAll').checked = false;
                    document.getElementById('selectAll').indeterminate = false;
                }
                if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
                    e.preventDefault();
                    document.querySelectorAll('.item-checkbox').forEach(el => {
                        el.checked = true;
                        selectedPaths.add(el.dataset.path);
                        el.closest('tr').classList.add('selected');
                    });
                    updateSelectedCount();
                    updateBatchDeleteBtn();
                    document.getElementById('selectAll').checked = true;
                    document.getElementById('selectAll').indeterminate = false;
                }
            });
            // 视图切换
            document.querySelectorAll('.btn-view').forEach(btn => {
                btn.addEventListener('click', () => switchView(btn.dataset.view));
            });
            // 图标大小切换
            document.querySelectorAll('.icon-size-btn').forEach(btn => {
                btn.addEventListener('click', () => switchIconSize(btn.dataset.size));
            });
            // 选择模式
            document.getElementById('selectModeBtn').addEventListener('click', toggleSelectMode);
            // 双击列表空白处切换多选模式
            ['viewList', 'viewIcon', 'viewTree'].forEach(id => {
                const el = document.getElementById(id);
                if (!el) return;
                el.addEventListener('dblclick', (e) => {
                    // 双击文件/文件夹行由行级处理器选中该行；此处仅处理表格/网格真正的空白区域
                    if (e.target.closest('button, a, input, select, .dropdown-menu, tr[data-path], .icon-item, .tree-line')) return;
                    toggleSelectMode();
                    showToast('提示', selectMode ? '已开启多选模式，再次双击空白处可退出' : '已退出多选模式', selectMode ? 'info' : 'success');
                });
            });
            // 全盘搜索
            document.getElementById('searchBtn').addEventListener('click', () => showSearchModal());
            // 新建文件/文件夹
            document.getElementById('newFileMenuItem').addEventListener('click', (e) => { e.preventDefault(); showNewFileDialog(false); });
            document.getElementById('newFolderMenuItem').addEventListener('click', (e) => { e.preventDefault(); showNewFileDialog(true); });
            // 删除历史面板
            document.getElementById('deleteHistoryBtn').addEventListener('click', () => showDeleteHistory());
        }

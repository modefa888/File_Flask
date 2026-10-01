        // ========== 图标大小切换 ==========
        const STORAGE_ICON_SIZE_KEY = 'fileManager_iconSize';
        let iconSize = localStorage.getItem(STORAGE_ICON_SIZE_KEY) || 'sm';

        function switchIconSize(size) {
            if (!['sm', 'md', 'lg'].includes(size)) size = 'sm';
            iconSize = size;
            localStorage.setItem(STORAGE_ICON_SIZE_KEY, size);
            const group = document.getElementById('iconSizeGroup');
            if (group) {
                group.querySelectorAll('.icon-size-btn').forEach(btn => {
                    btn.classList.toggle('active', btn.dataset.size === size);
                });
            }
            // 更新网格列宽
            const grid = document.getElementById('iconGrid');
            if (grid) {
                grid.classList.remove('sm', 'md', 'lg');
                grid.classList.add(size);
            }
            // 重新渲染以应用新的 icon-item 大小类
            if (viewMode === 'icon') {
                applyFiltersAndSort();
            }
        }

        function toggleSelectMode() {
            selectMode = !selectMode;
            localStorage.setItem('fileManager_selectMode', selectMode.toString());
            document.body.classList.toggle('select-mode', selectMode);
            document.getElementById('selectModeBtn').classList.toggle('active', selectMode);
            const selBar = document.getElementById('selBar');
            if (selBar) selBar.classList.toggle('show', selectMode);
            // 选择模式关闭时清空已选
            if (!selectMode) {
                selectedPaths.clear();
                document.querySelectorAll('.item-checkbox, .icon-check, .tree-checkbox').forEach(el => {
                    el.checked = false;
                });
                document.querySelectorAll('.selected').forEach(el => el.classList.remove('selected'));
                document.getElementById('selectAll').checked = false;
                document.getElementById('selectAll').indeterminate = false;
                updateSelectedCount();
                updateBatchDeleteBtn();
            }
        }

        // 全选/取消全选（兼容列表/图标/树型视图）
        function _setAllSelected(checked) {
            document.querySelectorAll('.item-checkbox:not(.parent-cb), .tree-checkbox:not(.parent-cb)').forEach(el => {
                el.checked = checked;
                const path = el.dataset.path;
                if (path == null) return;
                if (checked) selectedPaths.add(path); else selectedPaths.delete(path);
                const row = el.closest('tr') || el.closest('.icon-item') || el.closest('.tree-line');
                if (row) row.classList.toggle('selected', checked);
            });
            const sa = document.getElementById('selectAll');
            if (sa) { sa.checked = checked; sa.indeterminate = false; }
            updateSelectedCount();
            updateBatchDeleteBtn();
        }

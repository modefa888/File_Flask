        // ========== 图标/树型视图排序工具栏 ==========
        const SORT_FIELDS = [
            { key: 'name', label: '名称' },
            { key: 'size', label: '大小' },
            { key: 'type', label: '类型' },
            { key: 'mtime', label: '修改时间' }
        ];

        function renderSortBar() {
            // 图标视图与树型视图各自显示对应的排序栏，列表视图隐藏
            ['iconSortBar', 'treeSortBar'].forEach(id => {
                const bar = document.getElementById(id);
                if (!bar) return;
                bar.style.display = (viewMode === 'list') ? 'none' : 'flex';
            });
            if (viewMode !== 'icon' && viewMode !== 'tree') return;
            const bar = document.getElementById(viewMode === 'tree' ? 'treeSortBar' : 'iconSortBar');
            if (!bar) return;
            let html = '<span class="sortbar-label"><i class="bi bi-sort-down"></i> 排序</span>';
            html += '<span class="sortbar-arrow">目录优先 ·</span>';
            SORT_FIELDS.forEach(f => {
                const on = sortField === f.key;
                html += `<button type="button" class="sortbar-btn${on ? ' active' : ''}" data-sort-field="${f.key}">${f.label}<span class="sortbar-dir">${on ? (sortAsc ? '↑' : '↓') : '⇅'}</span></button>`;
            });
            html += `<span class="sortbar-count">共 ${fileItems.length} 项</span>`;
            bar.innerHTML = html;
            bar.querySelectorAll('.sortbar-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    const field = btn.dataset.sortField;
                    if (field === sortField) sortAsc = !sortAsc;
                    else { sortField = field; sortAsc = true; }
                    applyFiltersAndSort();
                });
            });
        }

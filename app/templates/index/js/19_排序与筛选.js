        // ========== 排序与筛选 ==========
        // 通用排序：目录始终在前，其余按 sortField/sortAsc 排序
        function _sortItems(list) {
            const items = [...(list || [])];
            items.sort((a, b) => {
                // 第一层分组：目录始终在前
                if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
                let valA, valB;
                switch (sortField) {
                    case 'name': valA = a.name.toLowerCase(); valB = b.name.toLowerCase(); break;
                    case 'size': valA = Number(a.size || 0); valB = Number(b.size || 0); break;
                    case 'type': valA = (a.type || 'zzz').toLowerCase(); valB = (b.type || 'zzz').toLowerCase(); break;
                    case 'mtime': valA = a.mtime || ''; valB = b.mtime || ''; break;
                    default: valA = a.name.toLowerCase(); valB = b.name.toLowerCase();
                }
                if (valA < valB) return sortAsc ? -1 : 1;
                if (valA > valB) return sortAsc ? 1 : -1;
                // 同值按名称次排序保证稳定
                if (sortField !== 'name') {
                    if (a.name.toLowerCase() < b.name.toLowerCase()) return sortAsc ? -1 : 1;
                    if (a.name.toLowerCase() > b.name.toLowerCase()) return sortAsc ? 1 : -1;
                }
                return 0;
            });
            return items;
        }

        function applyFiltersAndSort() {
            let items = [...fileItems];
            const filterText = document.getElementById('filterInput').value.toLowerCase().trim();
            const typeFilter = document.getElementById('typeFilter').value;
            if (filterText) items = items.filter(item => item.name.toLowerCase().includes(filterText));
            if (typeFilter === '目录') items = items.filter(item => item.is_dir);
            else if (typeFilter) items = items.filter(item => !item.is_dir && (item.type || '').toLowerCase() === typeFilter.toLowerCase());
            items = _sortItems(items);
            document.querySelectorAll('.sort-indicator').forEach(el => el.classList.remove('active'));
            const indicator = document.getElementById(`sort-${sortField}`);
            if (indicator) { indicator.textContent = sortAsc ? '↑' : '↓'; indicator.classList.add('active'); }
            renderSortBar();
            if (viewMode === 'icon') { renderIconView(items); }
            else if (viewMode === 'tree') { renderTreeView(items); }
            else { renderTable(items); }
        }

        // ========== 视图切换 ==========
        function switchView(mode) {
            _closeMenus();
            viewMode = mode;
            localStorage.setItem(STORAGE_VIEW_KEY, mode);
            document.getElementById('viewList').style.display = (mode === 'list') ? 'block' : 'none';
            document.getElementById('viewIcon').style.display = (mode === 'icon') ? 'block' : 'none';
            document.getElementById('viewTree').style.display = (mode === 'tree') ? 'block' : 'none';
            document.querySelectorAll('.btn-view').forEach(btn => {
                btn.classList.toggle('active', btn.dataset.view === mode);
            });
            const sizeGroup = document.getElementById('iconSizeGroup');
            if (sizeGroup) {
                sizeGroup.classList.toggle('show-icon-size', mode === 'icon');
            }
            applyFiltersAndSort();
        }

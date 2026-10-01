        // ========== 初始化 ==========
        async function initApp() {
            try {
                const resp = await fetch('/api/system');
                const data = await resp.json();
                systemInfo = data;
                bindQuickButtons();
                bindIndexBadge();
                switchView(viewMode);
                switchIconSize(iconSize);
                toggleSelectMode();
                if (selectMode) toggleSelectMode();
                let startPath = localStorage.getItem(STORAGE_KEY);
                if (!startPath) startPath = systemInfo.root || '/';
                loadFiles(startPath);
                loadDeleteHistoryCount();
            } catch (e) {
                console.error('[initApp]', e);
                showToast('警告', '无法获取系统信息：' + e.message, 'warning');
                bindQuickButtons();
                bindIndexBadge();
                switchView(viewMode);
                switchIconSize(iconSize);
                toggleSelectMode();
                if (selectMode) toggleSelectMode();
                let startPath = localStorage.getItem(STORAGE_KEY);
                if (!startPath) startPath = '';
                loadFiles(startPath);
                loadDeleteHistoryCount();
            }
        }

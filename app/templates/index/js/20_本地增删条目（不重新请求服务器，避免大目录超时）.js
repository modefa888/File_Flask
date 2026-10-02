        // ========== 本地增删条目（不重新请求服务器，避免大目录超时） ==========
        function _nowStr() {
            const d = new Date();
            const p = (n) => String(n).padStart(2, '0');
            return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
        }

        function _recomputeStats() {
            let f = 0, dirs = 0, size = 0;
            for (const it of fileItems) {
                if (it.is_dir) dirs++; else f++;
                size += Number(it.size || 0);
            }
            const tf = document.getElementById('totalFiles');
            const td = document.getElementById('totalDirs');
            const ts = document.getElementById('totalSize');
            const badge = document.getElementById('fileCountBadge');
            if (tf) tf.textContent = f;
            if (td) td.textContent = dirs;
            if (ts) ts.textContent = formatSize(size);
            if (badge) badge.textContent = `${fileItems.length} 项`;
            // 底部提示条同步显示同一份统计
            const bf = document.getElementById('bottomFiles');
            if (bf) {
                document.getElementById('bottomFiles').textContent = f;
                document.getElementById('bottomDirs').textContent = dirs;
                document.getElementById('bottomSize').textContent = formatSize(size);
            }
        }

        function localAddItem(item) {
            const idx = fileItems.findIndex(it => it.path === item.path);
            if (idx >= 0) fileItems[idx] = Object.assign(fileItems[idx], item);
            else fileItems.push(item);
            applyFiltersAndSort();
            _recomputeStats();
            updateBatchDeleteBtn();
        }

        function localRemoveItems(paths) {
            const names = new Set(paths.map(p => p.split('/').pop()).filter(Boolean));
            if (names.size === 0) return;
            fileItems = fileItems.filter(it => !names.has(it.path));
            // 同步清理选中集合
            for (const p of paths) selectedPaths.delete(p);
            applyFiltersAndSort();
            _recomputeStats();
            updateSelectedCount();
            updateBatchDeleteBtn();
        }

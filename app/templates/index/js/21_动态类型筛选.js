        // ========== 动态类型筛选 ==========
        function _updateTypeFilter(items) {
            const select = document.getElementById('typeFilter');
            if (!select) return;
            // 收集当前目录下的文件扩展名及数量（排除目录）
            const extCounts = {};
            for (const item of items) {
                if (item.is_dir) continue;
                const ext = (item.type || '').toLowerCase();
                if (!ext || ext === '未知') continue;
                extCounts[ext] = (extCounts[ext] || 0) + 1;
            }
            // 按字母排序
            const exts = Object.keys(extCounts).sort();
            // 构建下拉选项
            let html = '<option value="">所有类型</option>';
            // 目录选项
            const dirCount = items.filter(i => i.is_dir).length;
            if (dirCount > 0) {
                html += `<option value="目录">📁 目录 (${dirCount})</option>`;
            }
            // 文件扩展名选项
            for (const ext of exts) {
                const label = ext;
                const count = extCounts[ext];
                html += `<option value="${ext}">.${label} (${count})</option>`;
            }
            select.innerHTML = html;
            // 在 loadFiles 中恢复之前选中的值
        }

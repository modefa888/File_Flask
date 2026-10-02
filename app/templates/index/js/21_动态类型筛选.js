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

        // ========== 按扩展名归类统计（底部信息条展示） ==========
        const _EXT_CATEGORIES = {
            '图片':   ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'heic', 'heif', 'avif', 'tiff', 'tif', 'ico', 'raw', 'cr2', 'cr3', 'nef', 'arw', 'dng'],
            '视频':   ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'mpg', 'mpeg', '3gp', 'ts', 'rmvb', 'rm', 'vob', 'm2ts'],
            '音频':   ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'wma', 'ape', 'amr', 'opus', 'mid', 'midi', 'aiff'],
            '文档':   ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md', 'csv', 'epub', 'mobi', 'rtf', 'odt', 'wps'],
            '压缩包': ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'tgz', 'zst', 'iso', 'cab'],
        };
        const _EXT_TO_CAT = {};
        for (const [cat, exts] of Object.entries(_EXT_CATEGORIES)) {
            for (const e of exts) _EXT_TO_CAT[e] = cat;
        }

        function _updateBottomTypeStats(items) {
            const el = document.getElementById('bottomTypeStats');
            if (!el) return;
            const icons = { '图片': 'bi-file-earmark-image', '视频': 'bi-file-earmark-play', '音频': 'bi-file-earmark-music', '文档': 'bi-file-earmark-text', '压缩包': 'bi-file-earmark-zip' };
            const counts = {};
            const sizes = {};
            for (const it of items) {
                if (it.is_dir) continue;
                const ext = (it.type || '').toLowerCase().replace(/^\./, '');
                const cat = _EXT_TO_CAT[ext];
                if (cat) {
                    counts[cat] = (counts[cat] || 0) + 1;
                    sizes[cat] = (sizes[cat] || 0) + Number(it.size || 0);
                }
            }
            // 只显示数量大于 0 的分类，避免信息条拥挤；同时显示该分类总大小
            el.innerHTML = Object.keys(_EXT_CATEGORIES)
                .filter(cat => counts[cat])
                .map(cat => `&nbsp;·&nbsp; <i class="bi ${icons[cat]}" title="${cat}文件数 / 总大小"></i> ${cat} <span>${counts[cat]}</span> <span class="text-secondary">(${formatSize(sizes[cat])})</span>`)
                .join('');
        }

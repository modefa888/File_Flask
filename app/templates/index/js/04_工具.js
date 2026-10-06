        // ========== 工具 ==========
        function formatSize(bytes) {
            if (bytes < 1024) return bytes + ' B';
            if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
            if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
            return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
        }

        function getFileIcon(item) {
            if (item.is_dir) return '<i class="bi bi-folder-fill text-warning file-icon"></i>';
            const ext = item.ext || '';
            const icons = {
                'pdf': 'bi-filetype-pdf text-danger', 'jpg': 'bi-file-image text-success', 'jpeg': 'bi-file-image text-success',
                'png': 'bi-file-image text-success', 'gif': 'bi-file-image text-success', 'svg': 'bi-file-image text-success',
                'mp4': 'bi-file-play text-primary', 'avi': 'bi-file-play text-primary', 'mov': 'bi-file-play text-primary',
                'mkv': 'bi-file-play text-primary', 'mp4': 'bi-file-play text-primary', 'mp3': 'bi-file-music text-primary', 'wav': 'bi-file-music text-primary',
                'zip': 'bi-file-zip text-secondary', 'rar': 'bi-file-zip text-secondary', '7z': 'bi-file-zip text-secondary',
                'tar': 'bi-file-zip text-secondary', 'gz': 'bi-file-zip text-secondary', 'exe': 'bi-filetype-exe text-danger',
                'msi': 'bi-filetype-exe text-danger', 'dmg': 'bi-filetype-exe text-danger', 'py': 'bi-file-code text-info',
                'js': 'bi-file-code text-warning', 'html': 'bi-file-code text-danger', 'css': 'bi-file-code text-info',
                'json': 'bi-file-code text-secondary', 'xml': 'bi-file-code text-secondary', 'txt': 'bi-file-text text-secondary',
                'md': 'bi-file-text text-secondary', 'doc': 'bi-file-word text-primary', 'docx': 'bi-file-word text-primary',
                'xls': 'bi-file-excel text-success', 'xlsx': 'bi-file-excel text-success', 'ppt': 'bi-file-ppt text-danger',
                'pptx': 'bi-file-ppt text-danger'
            };
            const icon = icons[ext.toLowerCase()] || 'bi-file-earmark';
            return `<i class="bi ${icon} file-icon"></i>`;
        }

        function getTypeBadge(item) {
            if (item.is_dir) return `<span class="file-type-badge dir">📁 目录</span>`;
            return `<span class="file-type-badge">${item.type || '未知'}</span>`;
        }

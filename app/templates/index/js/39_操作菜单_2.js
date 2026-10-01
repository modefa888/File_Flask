        // ========== 操作菜单 ==========
        let _activeMenu = null;

        function _closeMenus() {
            if (_activeMenu) { _activeMenu.remove(); _activeMenu = null; }
            document.querySelectorAll('.more-btn.active').forEach(b => b.classList.remove('active'));
        }

        function showActionMenu(btn, absPath, isDir) {
            _closeMenus();
            const rect = btn.getBoundingClientRect();
            const menu = document.createElement('div');
            menu.className = 'action-menu';
            menu.style.display = 'block';

            // 构建菜单项
            const items = [];
            // 视频：播放放最上面（常用操作优先）
            const _menuExt = isDir ? '' : _getExtFromPath(absPath);
            if (!isDir && _VIDEO_EXTS.has(_menuExt)) {
                items.push({ icon: 'bi bi-play-circle', label: '播放', action: 'play', cls: '' });
            }
            items.push({ icon: 'bi bi-pencil', label: '重命名', action: 'rename', cls: '' });
            items.push({
                icon: _favs.some(f => f.path === absPath) ? 'bi bi-star-fill' : 'bi bi-star',
                label: _favs.some(f => f.path === absPath) ? '取消收藏' : '收藏', action: 'fav', cls: ''
            });

            if (!isDir) {
                const ext = _menuExt;
                items.push({ icon: 'bi bi-folder-symlink', label: '打开所在文件夹', action: 'open-parent', cls: '' });
                if (_TEXT_EXTS.has(ext) || _IMAGE_EXTS.has(ext) || _isZip(ext) || _VIDEO_EXTS.has(ext)) {
                    items.push({ icon: 'bi bi-download', label: '下载文件', action: 'download', cls: '' });
                }
                if (_TEXT_EXTS.has(ext)) {
                    items.push({ icon: 'bi bi-pencil-square', label: '编辑', action: 'edit', cls: '' });
                }
                items.push({ icon: 'bi bi-file-zip', label: '压缩', action: 'compress', cls: '' });
                if (_isZip(ext)) {
                    items.push({ icon: 'bi bi-box-arrow-in-down', label: '查看压缩包内容', action: 'zip-view', cls: '' });
                }
            } else {
                items.push({ icon: 'bi bi-code-square', label: '打开项目 IDE', action: 'open-ide', cls: '' });
                items.push({ icon: 'bi bi-folder-plus', label: '新建子文件夹', action: 'new-folder', cls: '' });
                items.push({ icon: 'bi bi-file-zip', label: '压缩此文件夹', action: 'compress', cls: '' });
            }

            items.push({ divider: true });
            items.push({ icon: 'bi bi-info-circle', label: '文件信息', action: 'properties', cls: '' });

            if (!isDir) {
                items.push({ icon: 'bi bi-arrow-right', label: '移动到...', action: 'move', cls: '' });
                items.push({ icon: 'bi bi-plus-square', label: '复制到...', action: 'copy-to', cls: '' });
                items.push({ divider: true });
                items.push({ icon: 'bi bi-trash3', label: '删除', action: 'delete', cls: 'danger' });
            }

            items.forEach(item => {
                if (item.divider) {
                    const div = document.createElement('div');
                    div.className = 'menu-divider';
                    menu.appendChild(div);
                } else {
                    const el = document.createElement('button');
                    el.className = `menu-item ${item.cls}`;
                    el.innerHTML = `<i class="${item.icon}"></i><span>${item.label}</span>`;
                    el.addEventListener('click', () => { _closeMenus(); handleAction(item.action, absPath, isDir); });
                    menu.appendChild(el);
                }
            });

            document.body.appendChild(menu);

            // ===== 自动定位：检测溢出并翻转方向 =====
            const vw = window.innerWidth;
            const vh = window.innerHeight;
            const menuRect = menu.getBoundingClientRect();
            const menuW = menuRect.width;
            const menuH = menuRect.height;
            const btnCenterX = rect.left + rect.width / 2;
            const btnBottomY = rect.bottom;
            const btnTopY = rect.top;
            const padding = 4;

            // 水平定位：菜单尽量以按钮中心居中，溢出时贴边
            let left = btnCenterX - menuW / 2;
            if (left < padding) left = padding;                     // 左溢出 → 贴左
            if (left + menuW > vw - padding) left = vw - menuW - padding;  // 右溢出 → 贴右
            menu.style.left = left + 'px';

            // 垂直定位：优先向下，溢出则向上
            let top;
            const spaceBelow = vh - btnBottomY - padding;
            const spaceAbove = btnTopY - padding;
            if (spaceBelow >= menuH) {
                top = btnBottomY + 6;
            } else if (spaceAbove >= menuH) {
                top = btnTopY - menuH - 6;
            } else {
                top = Math.max(0, btnTopY - menuH - 6);
            }
            menu.style.top = top + 'px';

            _activeMenu = menu;
            btn.classList.add('active');
            setTimeout(() => { document.addEventListener('click', _clickOutsideMenu, { once: true }); }, 10);
        }

        function _clickOutsideMenu(e) {
            if (_activeMenu && !_activeMenu.contains(e.target) && !e.target.closest('.more-btn')) {
                _closeMenus();
            }
        }

        function _getExtFromPath(path) {
            const parts = path.split('/');
            const name = parts[parts.length - 1];
            const dotIdx = name.lastIndexOf('.');
            return dotIdx >= 0 ? name.substring(dotIdx + 1).toLowerCase() : '';
        }

        function handleAction(action, absPath, isDir) {
            switch (action) {
                case 'rename': showRenameDialog(absPath); break;
                case 'fav': toggleFavByPath(absPath); break;
                case 'open-parent': _openInExplorer(absPath); break;
                case 'play': previewFile(absPath); break;
                case 'download': _downloadFile(absPath); break;
                case 'zip-view': previewFile(absPath); break;
                case 'new-folder': showNewFolderDialog(absPath); break;
                case 'properties': showPropertiesDialog(absPath); break;
                case 'move': showMoveCopyDialog(absPath, 'move'); break;
                case 'copy-to': showMoveCopyDialog(absPath, 'copy'); break;
                case 'delete': deleteFiles([absPath]); break;
                case 'edit': openEditor(absPath, false); break;
                case 'open-ide': window.open('/ide?path=' + encodeURIComponent(absPath), '_blank'); break;
                case 'compress': {
                    // 压缩包生成在被压缩项的同级目录（父目录），而不是文件夹内部
                    const lastSlash = Math.max(absPath.lastIndexOf('/'), absPath.lastIndexOf('\\'));
                    const parentDir = lastSlash > 0 ? absPath.substring(0, lastSlash) : (currentPath || '/');
                    compressSelected([absPath], parentDir);
                    break;
                }
            }
        }

        function _copyToClipboard(text, successMsg) {
            navigator.clipboard.writeText(text).then(() => {
                showToast('成功', successMsg, 'success');
            }).catch(() => {
                const ta = document.createElement('textarea');
                ta.value = text; document.body.appendChild(ta); ta.select();
                document.execCommand('copy'); document.body.removeChild(ta);
                showToast('成功', successMsg, 'success');
            });
        }

        function _openInExplorer(absPath) {
            const parent = absPath.substring(0, absPath.lastIndexOf('/'));
            _copyToClipboard(parent, '已复制到剪切板');
            try {
                const win = window.open('file://' + parent, '_blank');
                if (!win) showToast('提示', '请在新窗口中打开: ' + parent, 'info');
            } catch (e) {
                showToast('提示', '已复制父目录路径: ' + parent, 'info');
            }
        }

        function _downloadFile(absPath) {
            // /api/download 以附件方式下载（带 Content-Disposition），/api/stream 只支持音视频流
            window.open(`/api/download?path=${encodeURIComponent(absPath)}`, '_blank');
        }

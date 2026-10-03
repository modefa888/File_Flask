        // ========== 图标视图 ==========
        function renderIconView(items) {
            const grid = document.getElementById('iconGrid');
            if (grid) {
                grid.classList.remove('sm', 'md', 'lg');
                grid.classList.add(iconSize);
            }
            if (!items || items.length === 0) {
                grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:40px;color:#a0aec0;"><i class="bi bi-inbox" style="font-size:2rem;display:block;margin-bottom:8px;"></i>此目录为空</div>`;
                updateSelectedCount(); updateBatchDeleteBtn();
                return;
            }
            let html = '';
            for (const item of items) {
                const absPath = currentPath ? (currentPath + '/' + item.path).replace(/\\/g, '/').replace(/\\\\+/g, '/') : item.path;
                const isSelected = selectedPaths.has(absPath);
                const ext = (item.ext || '').toLowerCase();
                const isImage = _IMAGE_EXTS.has(ext);
                const isVideo = _VIDEO_EXTS.has(ext);
                const previewable = _canPreviewPath(absPath);
                const isZip = _isZip(ext);
                const sizeStr = item.size_str || '-';
                const sizeText = item.is_dir ? (sizeStr !== '-' ? sizeStr : '') : sizeStr;
                const itemClass = (isSelected ? 'selected ' : '') + ((previewable || isZip) ? 'clickable ' : '') + iconSize + ' ';
                const nameTitle = (previewable || isZip) ? '点击查看' : '';
                const moreBtn = `<button class="icon-more" data-action-path="${absPath}" data-is-dir="${item.is_dir}" title="更多操作"><i class="bi bi-three-dots"></i></button>`;
                const iconClass = item.is_dir ? 'bi bi-folder-fill text-warning' : (function () {
                    const icons = { 'pdf': 'bi-filetype-pdf text-danger', 'jpg': 'bi-file-image text-success', 'jpeg': 'bi-file-image text-success', 'png': 'bi-file-image text-success', 'gif': 'bi-file-image text-success', 'svg': 'bi-file-image text-success', 'mp4': 'bi-file-play text-primary', 'avi': 'bi-file-play text-primary', 'mov': 'bi-file-play text-primary', 'mkv': 'bi-file-play text-primary', 'mp3': 'bi-file-music text-primary', 'wav': 'bi-file-music text-primary', 'zip': 'bi-file-zip text-secondary', 'rar': 'bi-file-zip text-secondary', '7z': 'bi-file-zip text-secondary', 'py': 'bi-file-code text-info', 'js': 'bi-file-code text-warning', 'html': 'bi-file-code text-danger', 'css': 'bi-file-code text-info', 'json': 'bi-file-code text-secondary', 'txt': 'bi-file-text text-secondary', 'md': 'bi-file-text text-secondary' };
                    return icons[ext] || 'bi-file-earmark';
                })();
                // 缩略图：图片/视频显示缩略图，其余显示图标；大小角标挂在图标右下角（视频徽标占用右下角时移到左下角）
                const thumbPath = isImage || isVideo ? absPath : null;
                const thumbInner = `<span class="thumb-icon"><i class="bi ${iconClass}"></i></span>${isVideo ? `<span class="thumb-badge">${ext.toUpperCase()}</span>` : ''}${sizeText ? `<span class="icon-size${isVideo ? ' icon-size--flip' : ''}">${sizeText}</span>` : ''}`;
                const thumbTag = thumbPath
                    ? `<div class="icon-thumb" data-thumb-path="${thumbPath}" data-thumb-type="${isImage ? 'image' : 'video'}">${thumbInner}</div>`
                    : `<div class="icon-thumb">${thumbInner}</div>`;
                html += `
                <div class="icon-item ${itemClass}" data-path="${absPath}" data-thumb-abs-path="${isImage || isVideo ? absPath : ''}">
                    <input class="form-check-input item-checkbox icon-check" type="checkbox" name="files" value="${absPath}" data-path="${absPath}" ${isSelected ? 'checked' : ''} />
                    ${moreBtn}
                    ${thumbTag}
                    <span class="icon-name" data-path="${absPath}" data-ext="${ext}" title="${nameTitle}">${item.name}</span>
                    <span class="icon-meta"><span class="icon-mtime">${item.mtime || ''}</span></span>
                </div>
            `;
            }
            grid.innerHTML = html;
            // 加载缩略图
            _loadIconThumbnails(grid);
            // 为图片/视频卡片绑定悬浮预览
            _bindHoverPreviews(grid);
            // 绑定事件
            document.querySelectorAll('.icon-item').forEach(el => {
                const absPath = el.dataset.path;
                const ext = (el.querySelector('.icon-name') || {}).dataset?.ext || '';
                const checkbox = el.querySelector('.item-checkbox');
                const nameEl = el.querySelector('.icon-name');
                const moreBtn = el.querySelector('.icon-more');
                const isParentRow = el.dataset.parentItem === 'true';
                // 点击卡片本身
                let _clickTimer = null;
                const _findItem = () => fileItems.find(it => {
                    const p = currentPath ? (currentPath + '/' + it.path).replace(/\\/g, '/').replace(/\\\\+/g, '/') : it.path;
                    return p === absPath;
                });
                el.addEventListener('click', (e) => {
                    if (e.target.tagName === 'INPUT' || e.target.closest('.icon-more')) return;
                    if (isParentRow) { navigateTo(absPath); return; }
                    // 多选模式：单击切换勾选，不进入/不预览
                    if (selectMode) {
                        if (el._clickTimer) clearTimeout(el._clickTimer);
                        el._clickTimer = setTimeout(() => { el._clickTimer = null; _toggleItemCheckbox(checkbox); }, 220);
                        return;
                    }
                    const item = _findItem();
                    if (item && item.is_dir) {
                        if (_clickTimer) clearTimeout(_clickTimer);
                        _clickTimer = setTimeout(() => { _clickTimer = null; navigateTo(absPath); }, 220);
                        return;
                    }
                    if (_canPreviewPath(absPath) || _isZip(nameEl.dataset.ext)) {
                        if (_clickTimer) clearTimeout(_clickTimer);
                        _clickTimer = setTimeout(() => { _clickTimer = null; previewFile(absPath); }, 220);
                    }
                });
                // 双击选中文件/文件夹
                el.addEventListener('dblclick', (e) => {
                    if (e.target.tagName === 'INPUT' || e.target.closest('.icon-more') || isParentRow) return;
                    if (el._clickTimer) { clearTimeout(el._clickTimer); el._clickTimer = null; }
                    if (_clickTimer) { clearTimeout(_clickTimer); _clickTimer = null; }
                    e.stopPropagation();
                    _selectItemByPath(absPath);
                });
                // 复选框
                checkbox.addEventListener('change', (e) => {
                    e.stopPropagation();
                    if (isParentRow) return;
                    if (checkbox.checked) selectedPaths.add(absPath); else selectedPaths.delete(absPath);
                    el.classList.toggle('selected', checkbox.checked);
                    updateSelectedCount(); updateBatchDeleteBtn();
                });
                // 更多按钮
                if (moreBtn && !isParentRow) moreBtn.addEventListener('click', (e) => { e.stopPropagation(); showActionMenu(moreBtn, absPath, moreBtn.dataset.isDir === 'true'); });
            });
            updateSelectedCount(); updateBatchDeleteBtn();
        }

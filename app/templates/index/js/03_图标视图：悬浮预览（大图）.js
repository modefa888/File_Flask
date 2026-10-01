        // ========== 图标视图：悬浮预览（大图） ==========
        const _hoverPreview = document.createElement('div');
        _hoverPreview.className = 'icon-hover-preview';
        _hoverPreview.innerHTML = `
        <img class="ihp-img" alt="" />
        <div class="ihp-meta">
            <div class="ihp-name"></div>
            <div class="ihp-info"><span class="ihp-size"></span><span class="ihp-date"></span></div>
        </div>`;
        document.body.appendChild(_hoverPreview);
        let _hoverHideTimer = null;
        let _hoverHideDelay = 220; // ms

        function _showHoverPreview(card, path, name, sizeStr, mtime) {
            clearTimeout(_hoverHideTimer);
            // 无路径（非图片/视频文件）不请求缩略图，避免产生 /api/thumbnail?path= 的无效请求
            if (!path) return;
            // 若缩略图已缓存，立即显示
            const dataUrl = _thumbnailCache[path];
            const img = _hoverPreview.querySelector('.ihp-img');
            const nameEl = _hoverPreview.querySelector('.ihp-name');
            const sizeEl = _hoverPreview.querySelector('.ihp-size');
            const dateEl = _hoverPreview.querySelector('.ihp-date');
            _hoverPreview._path = path;
            // 内存缓存命中直接显示；否则交给浏览器 HTTP 缓存（已由服务端 ETag/强缓存处理），
            // 不再单独 fetch + FileReader，避免同一张封面被重复请求和重复解码。
            img.src = dataUrl || _thumbUrl(path);
            nameEl.textContent = name;
            sizeEl.textContent = sizeStr || '';
            dateEl.textContent = mtime || '';
            _positionHoverPreview(card);
            _hoverPreview.classList.add('visible');
        }

        function _hideHoverPreview() {
            _hoverHideTimer = setTimeout(() => {
                _hoverPreview.classList.remove('visible');
                _hoverPreview._path = null;
            }, _hoverHideDelay);
        }

        function _positionHoverPreview(card) {
            const rect = card.getBoundingClientRect();
            let top = rect.bottom + 8;
            let left = rect.left + rect.width / 2 - 180;
            if (left < 8) left = 8;
            if (left + 360 > window.innerWidth - 8) left = window.innerWidth - 368;
            if (top + 280 > window.innerHeight) {
                top = rect.top - 280;
                if (top < 8) top = rect.bottom + 8;
            }
            _hoverPreview.style.top = top + 'px';
            _hoverPreview.style.left = left + 'px';
        }

        // 页面滚动/缩放时隐藏悬浮预览
        window.addEventListener('scroll', () => {
            if (_hoverPreview.classList.contains('visible')) {
                _hoverPreview.classList.remove('visible');
                _hoverPreview._path = null;
            }
        }, { passive: true });

        // 当 icon-view 渲染时，为带缩略图的卡片绑定悬浮预览
        function _bindHoverPreviews(grid) {
            const cards = grid.querySelectorAll('.icon-item[data-thumb-abs-path]');
            cards.forEach(card => {
                const absPath = card.dataset.thumbAbsPath;
                const nameEl = card.querySelector('.icon-name');
                const sizeEl = card.querySelector('.icon-size');
                const name = nameEl ? nameEl.textContent : '';
                const sizeStr = sizeEl ? sizeEl.textContent : '';
                // mtime 从 fileItems 取
                const absNorm = absPath.replace(/\\/g, '/').replace(/\/+/g, '/');
                let mtime = '';
                for (const it of fileItems) {
                    const p = currentPath ? (currentPath + '/' + it.path).replace(/\\/g, '/').replace(/\/+/g, '/') : it.path;
                    if (p === absNorm) { mtime = it.mtime || ''; break; }
                }
                if (card._boundHover) return;
                card._boundHover = true;
                card.addEventListener('mouseenter', (e) => {
                    _showHoverPreview(card, absPath, name, sizeStr, mtime);
                });
                card.addEventListener('mouseleave', () => {
                    _hideHoverPreview();
                });
            });
        }

        // ========== 媒体集合面板（视频/音频/图片，基于索引聚合） ==========
        let _mediaPanelRef = null;
        let _mediaCollapsedBtn = null;
        const _mediaState = { type: 'all', keyword: '', page: 1, page_size: 20, min_size: 0, max_size: 0, total: 0, total_pages: 0, loading: false };
        const _MEDIA_TYPE_META = {
            video: { label: '视频', icon: 'bi-file-play', color: '#dc2626' },
            audio: { label: '音频', icon: 'bi-file-music', color: '#7c3aed' },
            image: { label: '图片', icon: 'bi-file-image', color: '#059669' },
            other: { label: '文件', icon: 'bi-file-earmark', color: '#64748b' },
        };

        // ===== 大小过滤设置：全部/视频/音频/图片 各自独立，本地持久化 =====
        const _MEDIA_FILTER_KEY = 'media_filter_settings_v1';
        const _MEDIA_FILTER_UNITS = [[1, 'B'], [1024, 'KB'], [1048576, 'MB'], [1073741824, 'GB']];
        const _MEDIA_FILTER_LABELS = { all: '全部', video: '视频', audio: '音频', image: '图片' };
        const _mediaFilterSettings = {
            all: { min: '', max: '', unit: 1048576 },
            video: { min: '', max: '', unit: 1048576 },
            audio: { min: '', max: '', unit: 1048576 },
            image: { min: '', max: '', unit: 1048576 },
        };
        (function _loadMediaFilterSettings() {
            try {
                const obj = JSON.parse(localStorage.getItem(_MEDIA_FILTER_KEY) || 'null');
                if (!obj) return;
                Object.keys(_mediaFilterSettings).forEach(k => {
                    const it = obj[k];
                    if (!it) return;
                    _mediaFilterSettings[k] = {
                        min: (it.min === '' || it.min == null) ? '' : (Number(it.min) || ''),
                        max: (it.max === '' || it.max == null) ? '' : (Number(it.max) || ''),
                        unit: Number(it.unit) || 1048576,
                    };
                });
            } catch (err) { /* 本地数据损坏时忽略，用默认值 */ }
        })();

        // 把「当前分类」的设置换算成字节写入查询状态（0 = 不限）
        function _applyMediaSizeFilter() {
            const s = _mediaFilterSettings[_mediaState.type] || _mediaFilterSettings.all;
            const unit = Number(s.unit) || 1;
            const min = parseFloat(s.min);
            const max = parseFloat(s.max);
            _mediaState.min_size = (isFinite(min) && min > 0) ? Math.round(min * unit) : 0;
            _mediaState.max_size = (isFinite(max) && max > 0) ? Math.round(max * unit) : 0;
        }

        // 当前分类设了过滤时把设置按钮点亮
        function _updateMediaFilterBadge() {
            const btn = document.getElementById('mediaSettingsBtn');
            if (!btn) return;
            const s = _mediaFilterSettings[_mediaState.type] || _mediaFilterSettings.all;
            const on = (parseFloat(s.min) > 0) || (parseFloat(s.max) > 0);
            btn.classList.toggle('active', !!on);
        }

        // 大小过滤设置面板
        function showMediaFilterSettings() {
            const container = document.getElementById('customModalContainer');
            if (!container) return;
            const unitOpts = (cur) => _MEDIA_FILTER_UNITS
                .map(([v, n]) => `<option value="${v}"${Number(cur) === v ? ' selected' : ''}>${n}</option>`).join('');
            const rows = Object.keys(_MEDIA_FILTER_LABELS).map(key => {
                const s = _mediaFilterSettings[key] || {};
                const minV = (s.min === '' || s.min == null) ? '' : s.min;
                const maxV = (s.max === '' || s.max == null) ? '' : s.max;
                return `<div class="msm-row" data-key="${key}">
                    <span class="msm-name">${_MEDIA_FILTER_LABELS[key]}</span>
                    <input type="number" class="msm-input" data-role="min" min="0" step="1" placeholder="最小" value="${minV}">
                    <span class="msm-sep">~</span>
                    <input type="number" class="msm-input" data-role="max" min="0" step="1" placeholder="最大" value="${maxV}">
                    <select class="form-select form-select-sm msm-unit">${unitOpts(s.unit || 1048576)}</select>
                </div>`;
            }).join('');

            const overlay = document.createElement('div');
            overlay.className = 'custom-modal-overlay';
            overlay.innerHTML = `
                <div class="media-settings-modal">
                    <div class="msm-header">
                        <span class="msm-title"><i class="bi bi-sliders"></i> 大小过滤设置</span>
                        <button class="msm-close" id="msmCloseBtn" title="关闭"><i class="bi bi-x-lg"></i></button>
                    </div>
                    <div class="msm-tip">按分类分别设置文件大小范围（留空表示不限）。切换分类时会自动套用对应设置，设置会保存在本机。</div>
                    <div class="msm-body">${rows}</div>
                    <div class="msm-footer">
                        <button class="btn btn-cancel" id="msmResetBtn">重置</button>
                        <button class="btn btn-ok" id="msmApplyBtn"><i class="bi bi-check2"></i> 应用</button>
                    </div>
                </div>`;
            container.appendChild(overlay);

            const close = () => { if (document.body.contains(overlay)) overlay.remove(); };
            overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
            overlay.querySelector('#msmCloseBtn').addEventListener('click', close);

            overlay.querySelector('#msmResetBtn').addEventListener('click', () => {
                overlay.querySelectorAll('.msm-row').forEach(row => {
                    row.querySelectorAll('.msm-input').forEach(i => { i.value = ''; });
                    const u = row.querySelector('.msm-unit');
                    if (u) u.value = '1048576';
                });
            });

            overlay.querySelector('#msmApplyBtn').addEventListener('click', () => {
                overlay.querySelectorAll('.msm-row').forEach(row => {
                    const key = row.dataset.key;
                    const minEl = row.querySelector('[data-role="min"]');
                    const maxEl = row.querySelector('[data-role="max"]');
                    const unitEl = row.querySelector('.msm-unit');
                    const min = parseFloat((minEl && minEl.value) || '');
                    const max = parseFloat((maxEl && maxEl.value) || '');
                    if (isFinite(min) && isFinite(max) && min > 0 && max > 0 && min > max) {
                        showToast('提示', `${_MEDIA_FILTER_LABELS[key] || key} 的最小值不能大于最大值`, 'warning');
                    }
                    _mediaFilterSettings[key] = {
                        min: (isFinite(min) && min > 0) ? min : '',
                        max: (isFinite(max) && max > 0) ? max : '',
                        unit: Number((unitEl && unitEl.value) || 1048576) || 1048576,
                    };
                });
                try { localStorage.setItem(_MEDIA_FILTER_KEY, JSON.stringify(_mediaFilterSettings)); } catch (err) { /* ignore */ }
                close();
                _updateMediaFilterBadge();
                _mediaState.page = 1;
                _loadMediaCollection(true);
            });
        }

        function showMediaCollection() {
            const container = document.getElementById('mediaPanel');
            if (!container) return;
            if (_mediaPanelRef) return; // 已打开

            // 每次重新打开都重置查询状态，避免上次的分类/页码残留
            _mediaState.type = 'all';
            _mediaState.keyword = '';
            _mediaState.page = 1;
            _mediaState.page_size = 20;
            _mediaState.min_size = 0;
            _mediaState.max_size = 0;

            const overlay = document.createElement('div');
            overlay.className = 'media-viz-overlay';
            overlay.innerHTML = `
            <div class="media-viz-panel">
                <div class="panel-header">
                    <span class="panel-title"><i class="bi bi-collection-play"></i> 媒体集合</span>
                    <div style="display:flex;gap:6px;">
                        <button class="panel-close" id="mediaRefreshBtn" title="刷新"><i class="bi bi-arrow-clockwise"></i></button>
                        <button class="panel-close" id="mediaMinBtn" title="收起"><i class="bi bi-arrows-angle-contract"></i></button>
                        <button class="panel-close" id="mediaCloseBtn" title="关闭"><i class="bi bi-x-lg"></i></button>
                    </div>
                </div>
                <div class="media-toolbar">
                    <div class="media-tabs" id="mediaTabs">
                        <button class="media-tab active" data-type="all">全部</button>
                        <button class="media-tab" data-type="video"><i class="bi bi-film"></i> 视频</button>
                        <button class="media-tab" data-type="audio"><i class="bi bi-music-note"></i> 音频</button>
                        <button class="media-tab" data-type="image"><i class="bi bi-image"></i> 图片</button>
                    </div>
                    <button class="btn btn-outline-secondary btn-sm media-settings-btn" id="mediaSettingsBtn" type="button" title="按分类设置大小过滤"><i class="bi bi-sliders"></i> 过滤设置</button>
                    <div class="input-group input-group-sm media-search">
                        <input type="text" class="form-control" id="mediaKeyword" placeholder="按文件名过滤...">
                        <button class="btn btn-outline-primary" id="mediaSearchBtn" type="button">搜索</button>
                    </div>
                </div>
                <div class="media-meta-bar" id="mediaMetaBar"></div>
                <div class="media-grid-wrap" id="mediaGridWrap">
                    <div class="viz-loading"><i class="bi bi-hourglass-split"></i> 正在加载...</div>
                </div>
                <div class="media-batch-bar" id="mediaBatchBar" style="display:none;">
                    <span class="mbb-info"><i class="bi bi-check2-square"></i> 已选 <strong id="mediaBatchCount">0</strong> 项</span>
                    <button class="btn mbb-select-all" id="mediaBatchSelectAll" type="button"><i class="bi bi-check-all"></i> 全选本页</button>
                    <button class="btn mbb-clear" id="mediaBatchClear" type="button">取消选择</button>
                    <button class="btn mbb-del" id="mediaBatchDelete" type="button"><i class="bi bi-trash"></i> 删除</button>
                </div>
                <div class="media-pager-wrap" id="mediaPagerWrap" style="display:none;">
                    <div class="media-pager">
                        <button class="idx-btn" id="mediaPrevBtn"><i class="bi bi-chevron-left"></i> 上一页</button>
                        <span class="media-pager-info" id="mediaPagerInfo">第 1 / 1 页</span>
                        <button class="idx-btn" id="mediaNextBtn">下一页 <i class="bi bi-chevron-right"></i></button>
                        <select class="form-select form-select-sm media-page-size" id="mediaPageSize" title="每页条数">
                            <option value="20" selected>20/页</option>
                            <option value="40">40/页</option>
                            <option value="60">60/页</option>
                            <option value="100">100/页</option>
                        </select>
                        <span class="media-jump">
                            跳至
                            <input type="number" class="media-jump-input" id="mediaJumpInput" min="1" step="1" placeholder="页码" title="输入页码后回车跳转">
                            页
                            <button class="idx-btn media-jump-btn" id="mediaJumpBtn"><i class="bi bi-arrow-return-right"></i> 跳转</button>
                        </span>
                    </div>
                </div>
            </div>`;
            container.appendChild(overlay);
            _mediaPanelRef = overlay;

            // 收起后的角落悬浮按钮（点击重新展开），与搜索面板的收起一致
            const collapsed = document.createElement('div');
            collapsed.className = 'media-collapsed';
            collapsed.id = 'mediaCollapsedBtn';
            collapsed.style.display = 'none';
            collapsed.title = '展开媒体集合';
            collapsed.innerHTML = '<i class="bi bi-collection-play"></i><span class="media-collapsed-badge empty">0</span>';
            collapsed.addEventListener('click', _expandMediaCollection);
            container.appendChild(collapsed);
            _mediaCollapsedBtn = collapsed;

            overlay.querySelector('#mediaCloseBtn').addEventListener('click', _confirmCloseMediaCollection);
            overlay.querySelector('#mediaMinBtn').addEventListener('click', _collapseMediaCollection);
            overlay.querySelector('#mediaRefreshBtn').addEventListener('click', () => _loadMediaCollection(true));
            overlay.querySelector('#mediaSearchBtn').addEventListener('click', _mediaApplySearch);
            // 大小过滤设置（视频/音频/图片各自独立，本地持久化）
            overlay.querySelector('#mediaSettingsBtn').addEventListener('click', showMediaFilterSettings);
            // 多选批量操作
            overlay.querySelector('#mediaBatchSelectAll').addEventListener('click', _toggleSelectAllMedia);
            overlay.querySelector('#mediaBatchClear').addEventListener('click', _clearMediaSelection);
            overlay.querySelector('#mediaBatchDelete').addEventListener('click', () => {
                const paths = Array.from(_mediaSelected);
                if (paths.length) _deleteMediaPaths(paths);
            });
            overlay.querySelector('#mediaKeyword').addEventListener('keydown', (e) => {
                if (e.key === 'Enter') _mediaApplySearch();
            });
            overlay.querySelector('#mediaTabs').addEventListener('click', (e) => {
                const btn = e.target.closest('.media-tab');
                if (!btn || btn.dataset.type === _mediaState.type) return;
                overlay.querySelectorAll('.media-tab').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                _mediaState.type = btn.dataset.type;
                _mediaState.page = 1;
                _updateMediaFilterBadge();
                _loadMediaCollection(true);
            });
            overlay.querySelector('#mediaPrevBtn').addEventListener('click', () => _gotoMediaPage(_mediaState.page - 1));
            overlay.querySelector('#mediaNextBtn').addEventListener('click', () => _gotoMediaPage(_mediaState.page + 1));
            overlay.querySelector('#mediaPageSize').addEventListener('change', (e) => {
                _mediaState.page_size = parseInt(e.target.value, 10) || 20;
                _mediaState.page = 1;
                _loadMediaCollection(true);
            });
            // 跳转到指定页
            const jumpToPage = () => {
                const input = overlay.querySelector('#mediaJumpInput');
                const n = parseInt((input && input.value) || '', 10);
                if (!n || n < 1) {
                    showToast('提示', '请输入要跳转的页码', 'warning');
                    if (input) input.focus();
                    return;
                }
                _gotoMediaPage(n);
            };
            overlay.querySelector('#mediaJumpBtn').addEventListener('click', jumpToPage);
            overlay.querySelector('#mediaJumpInput').addEventListener('keydown', (e) => {
                if (e.key === 'Enter') { e.preventDefault(); jumpToPage(); }
            });
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) _confirmCloseMediaCollection();
            });
            _updateMediaFilterBadge();
            _loadMediaCollection(true);
        }

        function closeMediaCollection() {
            const container = document.getElementById('mediaPanel');
            if (container) {
                if (_mediaPanelRef && _mediaPanelRef.parentNode === container) {
                    container.removeChild(_mediaPanelRef);
                }
                if (_mediaCollapsedBtn && _mediaCollapsedBtn.parentNode === container) {
                    container.removeChild(_mediaCollapsedBtn);
                }
            }
            _mediaPanelRef = null;
            _mediaCollapsedBtn = null;
            _closeMediaCardMenu();
        }

        // 关闭前的二次确认：可选「收起」（折叠为右上角按钮）或「彻底关闭」（移除面板）
        async function _confirmCloseMediaCollection() {
            const result = await showChoiceModal({
                title: '<i class="bi bi-x-square"></i> 关闭媒体集合',
                message: '请选择关闭方式：<br>· <strong>收起</strong>：折叠为右上角悬浮按钮，之后可随时展开继续浏览<br>· <strong>彻底关闭</strong>：直接移除面板，并清空当前的分类与页码',
                actions: [
                    { value: 'collapse', text: '收起', cls: 'btn-ok', icon: 'bi-arrows-angle-contract' },
                    { value: 'close', text: '彻底关闭', cls: 'btn-confirm', icon: 'bi-x-lg' },
                ],
            });
            if (result === 'collapse') _collapseMediaCollection();
            else if (result === 'close') closeMediaCollection();
        }

        // 收起 / 展开悬浮框（收起后只留右上角圆形按钮，跳转目录后依然能一键展开）
        function _collapseMediaCollection() {
            _closeMediaCardMenu();
            if (_mediaPanelRef) _mediaPanelRef.style.display = 'none';
            if (_mediaCollapsedBtn) {
                _mediaCollapsedBtn.style.display = 'flex';
                const badge = _mediaCollapsedBtn.querySelector('.media-collapsed-badge');
                if (badge) {
                    const n = _mediaState.total || 0;
                    badge.textContent = n > 9999 ? '9999+' : String(n);
                    badge.classList.toggle('empty', n <= 0);
                }
            }
        }

        function _expandMediaCollection() {
            if (_mediaCollapsedBtn) _mediaCollapsedBtn.style.display = 'none';
            if (_mediaPanelRef) _mediaPanelRef.style.display = 'flex';
        }

        function _mediaApplySearch() {
            const input = document.getElementById('mediaKeyword');
            _mediaState.keyword = ((input && input.value) || '').trim();
            _mediaState.page = 1;
            _loadMediaCollection(true);
        }

        function _mediaEscape(s) {
            return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        }

        function _gotoMediaPage(target) {
            const p = Math.max(1, Math.min(target, _mediaState.total_pages || 1));
            if (p === _mediaState.page && p === target) return;
            _mediaState.page = p;
            _loadMediaCollection(true);
        }

        let _mediaReqToken = 0;

        function _loadMediaCollection(reset) {
            const wrap = document.getElementById('mediaGridWrap');
            if (!wrap) return;
            _mediaState.loading = true;
            if (reset) {
                // 只负责清空重绘，页码由调用方决定，避免翻页时被重置回第 1 页
                wrap.innerHTML = '<div class="viz-loading"><i class="bi bi-hourglass-split"></i> 正在加载...</div>';
                _clearMediaSelection();   // 换页/筛选后清空选择，避免跨页残留
            }
            const token = ++_mediaReqToken;   // 只采用最后一次请求的结果，快速翻页不会被丢弃
            _applyMediaSizeFilter();          // 按当前分类套用它自己的大小过滤设置
            const params = new URLSearchParams({
                type: _mediaState.type,
                keyword: _mediaState.keyword,
                page: _mediaState.page,
                page_size: _mediaState.page_size,
                min_size: _mediaState.min_size || 0,
                max_size: _mediaState.max_size || 0,
            });
            fetch('/api/media/collection?' + params.toString())
                .then(r => r.json())
                .then(data => { if (token === _mediaReqToken) _renderMediaPage(wrap, data, reset); })
                .catch(() => {
                    if (token === _mediaReqToken) wrap.innerHTML = '<div class="viz-loading"><i class="bi bi-wifi-off"></i> 加载失败，请重试</div>';
                })
                .finally(() => { if (token === _mediaReqToken) _mediaState.loading = false; });
        }

        function _renderMediaPage(wrap, data, reset) {
            const items = data.items || [];
            _mediaState.total = data.total || 0;
            _mediaState.page = data.page || _mediaState.page;
            _mediaState.total_pages = data.total_pages || 0;

            _updateMediaMetaBar();
            const pagerWrap = document.getElementById('mediaPagerWrap');
            if (pagerWrap) pagerWrap.style.display = (_mediaState.total_pages > 1) ? '' : 'none';
            _updatePager();

            const html = items.map(_mediaCardHtml).join('');
            // 当前页被整页删空时自动回退一页
            if (reset && items.length === 0 && _mediaState.page > 1 && _mediaState.total_pages > 0) {
                _mediaState.page = Math.min(_mediaState.page, _mediaState.total_pages);
                _loadMediaCollection(true);
                return;
            }
            if (reset) {
                wrap.innerHTML = html || '<div class="viz-loading"><i class="bi bi-inbox"></i> 没有找到媒体文件</div>';
            } else {
                const tip = wrap.querySelector('.viz-loading');
                if (tip) tip.remove();
                wrap.insertAdjacentHTML('beforeend', html);
            }
            _bindMediaCardEvents(wrap);
        }

        // 网格上方的统计条（数量/页码）：单独抽出来，删除后也能局部刷新
        function _updateMediaMetaBar() {
            const metaBar = document.getElementById('mediaMetaBar');
            if (!metaBar) return;
            metaBar.innerHTML = _mediaState.total > 0
                ? `<i class="bi bi-database"></i> 共 <strong>${_mediaState.total.toLocaleString()}</strong> 个媒体文件（按文件大小排序），第 ${_mediaState.page} / ${_mediaState.total_pages} 页`
                : '<i class="bi bi-inbox"></i> 没有找到媒体文件（请先构建索引或切换分类）';
        }

        function _updatePager() {
            const info = document.getElementById('mediaPagerInfo');
            const prev = document.getElementById('mediaPrevBtn');
            const next = document.getElementById('mediaNextBtn');
            if (info) info.textContent = `第 ${_mediaState.page} / ${_mediaState.total_pages} 页`;
            if (prev) prev.disabled = _mediaState.page <= 1;
            if (next) next.disabled = _mediaState.page >= _mediaState.total_pages;
            const jumpInput = document.getElementById('mediaJumpInput');
            if (jumpInput) {
                const tp = _mediaState.total_pages || 1;
                jumpInput.max = String(tp);
                jumpInput.placeholder = `1-${tp}`;
            }
        }

        function _mediaCardHtml(it) {
            const m = _MEDIA_TYPE_META[it.category] || _MEDIA_TYPE_META.other;
            // 缩略图走 /api/thumbnail（ffmpeg 抽帧 + 磁盘缓存），失败时移除 img 露出图标兜底
            const thumbUrl = '/api/thumbnail?path=' + encodeURIComponent(it.path);
            return `<div class="media-card" data-path="${_mediaEscape(it.path)}" data-parent="${_mediaEscape(it.parent || '')}" title="${_mediaEscape(it.path)}">
                <div class="media-thumb">
                    <div class="media-thumb-fallback"><i class="bi ${m.icon}" style="color:${m.color}"></i></div>
                    <img loading="lazy" alt="" src="${thumbUrl}" onerror="this.remove()">
                    <span class="media-cat-badge" style="background:${m.color}">${m.label}</span>
                    ${it.ext ? `<span class="media-ext-badge">${_mediaEscape(it.ext.toUpperCase())}</span>` : ''}
                    <input type="checkbox" class="media-check" data-path="${_mediaEscape(it.path)}" title="选择此文件">
                    <button class="media-menu-btn" title="文件菜单" aria-label="文件菜单"><i class="bi bi-three-dots-vertical"></i></button>
                </div>
                <div class="media-info">
                    <div class="media-name" title="${_mediaEscape(it.name)}">${_mediaEscape(it.name)}</div>
                    <div class="media-sub">
                        <span>${formatSize(it.size || 0)}</span>
                        <span>${_mediaEscape(it.mtime || '')}</span>
                    </div>
                </div>
            </div>`;
        }

        function _bindMediaCardEvents(wrap) {
            // 滚动时关闭已展开的文件菜单，避免菜单脱离卡片位置
            if (wrap.dataset.menuScroll !== '1') {
                wrap.dataset.menuScroll = '1';
                wrap.addEventListener('scroll', _closeMediaCardMenu, { passive: true });
            }
            wrap.querySelectorAll('.media-card:not([data-bound])').forEach(card => {
                card.dataset.bound = '1';
                const open = () => {
                    if (typeof _canPreviewPath === 'function' && !_canPreviewPath(card.dataset.path)) {
                        showToast('提示', '该格式暂不支持在线预览，可前往文件位置用系统播放器打开', 'warning');
                        return;
                    }
                    previewFile(card.dataset.path);
                };
                card.querySelector('.media-menu-btn').addEventListener('click', (e) => {
                    e.stopPropagation();
                    _openMediaCardMenu(card, e.currentTarget);
                });
                // 多选复选框：不触发卡片的「打开预览」
                const check = card.querySelector('.media-check');
                if (check) {
                    check.addEventListener('click', (e) => e.stopPropagation());
                    check.addEventListener('change', () => {
                        _toggleMediaSelect(card.dataset.path, check.checked, card);
                    });
                }
                card.addEventListener('click', open);
            });
        }

        // ========== 多选与删除 ==========
        const _mediaSelected = new Set();

        function _toggleMediaSelect(path, on, card) {
            if (!path) return;
            if (on) _mediaSelected.add(path); else _mediaSelected.delete(path);
            if (card) card.classList.toggle('selected', !!on);
            _updateMediaBatchBar();
        }

        // 全选 / 取消全选当前页
        function _toggleSelectAllMedia() {
            const wrap = document.getElementById('mediaGridWrap');
            if (!wrap) return;
            const cards = Array.from(wrap.querySelectorAll('.media-card'));
            const on = !cards.every(c => _mediaSelected.has(c.dataset.path));
            cards.forEach(card => {
                const cb = card.querySelector('.media-check');
                if (on) _mediaSelected.add(card.dataset.path); else _mediaSelected.delete(card.dataset.path);
                card.classList.toggle('selected', on);
                if (cb) cb.checked = on;
            });
            _updateMediaBatchBar();
        }

        function _clearMediaSelection() {
            _mediaSelected.clear();
            const wrap = document.getElementById('mediaGridWrap');
            if (wrap) {
                wrap.querySelectorAll('.media-card.selected').forEach(c => c.classList.remove('selected'));
                wrap.querySelectorAll('.media-check').forEach(cb => { cb.checked = false; });
            }
            _updateMediaBatchBar();
        }

        function _updateMediaBatchBar() {
            const bar = document.getElementById('mediaBatchBar');
            const cnt = document.getElementById('mediaBatchCount');
            if (cnt) cnt.textContent = _mediaSelected.size;
            if (bar) bar.style.display = _mediaSelected.size > 0 ? 'flex' : 'none';
        }

        // 供其它模块调用（如文件预览里删除图片后）：让媒体列表立即同步移除
        function notifyMediaCollectionDeleted(paths) {
            if (!_mediaPanelRef || !Array.isArray(paths) || !paths.length) return;
            const wrap = document.getElementById('mediaGridWrap');
            if (!wrap) return;
            const del = new Set(paths);
            let removed = 0;
            Array.from(wrap.querySelectorAll('.media-card')).forEach(card => {
                if (del.has(card.dataset.path)) {
                    _mediaSelected.delete(card.dataset.path);
                    card.remove();
                    removed++;
                }
            });
            if (!removed) return;
            _mediaState.total = Math.max(0, _mediaState.total - removed);
            _updateMediaBatchBar();
            _updateMediaMetaBar();
            // 本页被删空：重新拉取（必要时自动回退一页）
            if (!wrap.querySelector('.media-card')) _loadMediaCollection(true);
        }

        // 删除：复用后台任务系统（进度弹窗 + 回收站 + 5 秒撤销）
        async function _deleteMediaPaths(paths) {
            if (!paths || !paths.length) return;
            const count = paths.length;
            const msg = count === 1
                ? '确定要删除 "' + (paths[0].split('/').pop() || paths[0]) + '" 吗？将移入回收站，5 秒内可撤销。'
                : '确定要删除选中的 ' + count + ' 个文件吗？将移入回收站，5 秒内可撤销。';
            const confirmed = await showConfirm(msg);
            if (!confirmed) return;
            const progName = count === 1 ? (paths[0].split('/').pop() || '') : (count + ' 项');
            _bgStart('del', '/api/delete/start', { paths }, {
                title: '正在删除：' + progName,
                onDone: (ok, d) => {
                    const result = (d && d.result) || {};
                    const deleted = (result.deleted || []).length;
                    if (deleted > 0) {
                        if (ok) showToast('成功', '已删除 ' + deleted + ' 个（移入回收站）', 'success');
                        if (ok && (result.trash_items || []).length > 0) showUndoToast(result.trash_items);
                    }
                    _clearMediaSelection();
                    _loadMediaCollection(true);
                }
            });
        }

        // ========== 卡片文件菜单：打开预览 / 前往文件所在文件夹 / 复制完整路径 ==========
        let _mediaMenuEl = null;
        let _mediaMenuPath = '';
        let _mediaMenuParent = '';

        function _ensureMediaMenu() {
            if (_mediaMenuEl && document.body.contains(_mediaMenuEl)) return _mediaMenuEl;
            const el = document.createElement('div');
            el.className = 'media-card-menu';
            el.innerHTML = `
                <button class="media-menu-item" data-act="open"><i class="bi bi-eye"></i> 打开预览</button>
                <button class="media-menu-item" data-act="goto"><i class="bi bi-folder2-open"></i> 前往文件所在文件夹</button>
                <button class="media-menu-item" data-act="copy"><i class="bi bi-clipboard"></i> 复制完整路径</button>
                <button class="media-menu-item danger" data-act="delete"><i class="bi bi-trash"></i> 删除</button>`;
            el.addEventListener('click', (e) => {
                e.stopPropagation();
                const item = e.target.closest('.media-menu-item');
                if (item) _handleMediaMenuAction(item.dataset.act);
            });
            document.body.appendChild(el);
            document.addEventListener('click', (e) => {
                if (el.style.display !== 'none' && !el.contains(e.target)) _closeMediaCardMenu();
            });
            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') _closeMediaCardMenu();
            });
            _mediaMenuEl = el;
            return el;
        }

        function _openMediaCardMenu(card, btn) {
            const el = _ensureMediaMenu();
            _mediaMenuPath = card.dataset.path || '';
            _mediaMenuParent = card.dataset.parent || '';
            el.style.display = 'block';
            const r = btn.getBoundingClientRect();
            const mw = el.offsetWidth;
            const mh = el.offsetHeight;
            let left = Math.min(r.right - mw, window.innerWidth - mw - 8);
            if (left < 8) left = 8;
            let top = r.bottom + 6;
            if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 6);
            el.style.left = left + 'px';
            el.style.top = top + 'px';
        }

        function _closeMediaCardMenu() {
            if (_mediaMenuEl) _mediaMenuEl.style.display = 'none';
        }

        function _handleMediaMenuAction(act) {
            const path = _mediaMenuPath;
            const parent = _mediaMenuParent;
            _closeMediaCardMenu();
            if (!path) return;
            if (act === 'open') {
                if (typeof _canPreviewPath === 'function' && !_canPreviewPath(path)) {
                    showToast('提示', '该格式暂不支持在线预览，可前往文件位置用系统播放器打开', 'warning');
                    return;
                }
                previewFile(path);
            } else if (act === 'goto') {
                // 参考搜索的收起：跳转到所在文件夹后，把媒体悬浮框折叠为右上角按钮
                _collapseMediaCollection();
                if (parent) navigateTo(parent);
            } else if (act === 'copy') {
                _copyText(path, '路径已复制到剪贴板');
            } else if (act === 'delete') {
                _deleteMediaPaths([path]);
            }
        }

        // 顶部「媒体」按钮：已收起时点击直接展开，否则打开面板
        (function () {
            const btn = document.getElementById('mediaPanelBtn');
            if (btn) btn.addEventListener('click', () => {
                if (_mediaPanelRef && _mediaPanelRef.style.display === 'none') {
                    _expandMediaCollection();
                } else {
                    showMediaCollection();
                }
            });
        })();

        // ========== ⭐ 收藏夹 ==========
        let _favs = [];              // 收藏条目 {path, name, added, group?, is_dir}
        let _favGroupOrder = [];     // 分组展示顺序（"__ungrouped__" 占位「其他」）
        let _favActiveTab = '__all__';

        // 排序模式（选择后存 localStorage 记住偏好）
        const _FAV_SORTS = [
            { key: 'time_desc', label: '添加时间 新→旧', icon: 'bi-sort-down' },
            { key: 'time_asc', label: '添加时间 旧→新', icon: 'bi-sort-up' },
            { key: 'name_asc', label: '名称 A→Z', icon: 'bi-sort-alpha-down' },
            { key: 'name_desc', label: '名称 Z→A', icon: 'bi-sort-alpha-up' }
        ];
        let _favSortMode = (function () {
            try { const m = localStorage.getItem('favSortMode'); if (m && _FAV_SORTS.some(s => s.key === m)) return m; } catch (e) { }
            return 'time_desc';
        })();

        function _sortFavList(list) {
            const arr = list.slice();
            const nameOf = f => (f.name || _favBasename(f.path) || '').toLowerCase();
            const coll = (window.Intl && Intl.Collator) ? new Intl.Collator('zh-Hans-CN', { numeric: true }) : null;
            const cmpName = (a, b) => coll ? coll.compare(nameOf(a), nameOf(b)) : (nameOf(a) < nameOf(b) ? -1 : nameOf(a) > nameOf(b) ? 1 : 0);
            switch (_favSortMode) {
                case 'time_asc': arr.sort((a, b) => (a.added || 0) - (b.added || 0)); break;
                case 'name_asc': arr.sort(cmpName); break;
                case 'name_desc': arr.sort((a, b) => -cmpName(a, b)); break;
                default: arr.sort((a, b) => (b.added || 0) - (a.added || 0)); // time_desc
            }
            return arr;
        }

        function _renderFavSortBtn() {
            const btn = document.getElementById('favSortBtn');
            if (!btn) return;
            const cur = _FAV_SORTS.find(s => s.key === _favSortMode) || _FAV_SORTS[0];
            btn.innerHTML = `<i class="bi ${cur.icon}"></i>`;
            btn.title = '排序：' + cur.label + '（点击切换）';
            const menu = document.getElementById('favSortMenu');
            if (!menu) return;
            menu.innerHTML = _FAV_SORTS.map(s =>
                `<button class="fav-sort-item${s.key === _favSortMode ? ' on' : ''}" data-sort="${s.key}">
                    <i class="bi ${s.icon}"></i> ${_escapeHtml(s.label)}${s.key === _favSortMode ? ' <i class="bi bi-check2"></i>' : ''}
                </button>`).join('');
        }

        function loadFavs() {
            return fetch('/api/favorites')
                .then(r => r.json())
                .then(d => {
                    _favs = (d.items || []).slice();
                    _favGroupOrder = (d.groups || []).slice();
                    _updateFavCurState();
                })
                .catch(() => { });
        }

        // 面包屑旁的 ⭐ 收藏按钮：当前目录已收藏时点亮实心星
        function _updateFavCurState() {
            const btn = document.getElementById('favCurBtn');
            if (!btn) return;
            const fav = _favs.find(f => f.path === currentPath);
            btn.classList.toggle('active', !!fav);
            const icon = btn.querySelector('i');
            if (icon) icon.className = fav ? 'bi bi-star-fill' : 'bi bi-star';
            btn.title = fav ? '取消收藏本目录' : '收藏本目录';
        }

        function _favBasename(p) {
            return (p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
        }

        // 收藏跳转后：等待列表渲染完成，滚动到对应行并闪烁高亮
        let _pendingHighlightPath = null;
        function _highlightRowByPath(path) {
            const rows = document.querySelectorAll('tr[data-path], .icon-item[data-path], .tree-line[data-path]');
            let el = null;
            for (const c of rows) { if (c.dataset.path === path) { el = c; break; } }
            if (!el) return false;
            try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) { try { el.scrollIntoView(); } catch (e2) { } }
            el.classList.remove('fav-highlight');
            void el.offsetWidth;   // 强制重排以重新触发动画
            el.classList.add('fav-highlight');
            // 动画自身约 2.7s 淡出；这里兜底清理所有高亮行（防止元素被重渲染替换后残留）
            setTimeout(() => {
                document.querySelectorAll('.fav-highlight').forEach(n => n.classList.remove('fav-highlight'));
            }, 3000);
            return true;
        }
        function _pollPendingHighlight() {
            if (!_pendingHighlightPath) return;
            const target = _pendingHighlightPath;
            const started = Date.now();
            const timer = setInterval(() => {
                if (_pendingHighlightPath !== target) { clearInterval(timer); return; }   // 已发起新的跳转
                if (_highlightRowByPath(target)) {
                    clearInterval(timer);
                    _pendingHighlightPath = null;
                } else if (Date.now() - started > 10000) {
                    clearInterval(timer);
                    _pendingHighlightPath = null;
                }
            }, 120);
        }

        function _fmtFavAdded(sec) {
            if (!sec) return '';
            const d = new Date(sec * 1000);
            const pad = n => String(n).padStart(2, '0');
            return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
                ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
        }

        function _favApi(method, url, body) {
            return fetch(url, {
                method: method,
                headers: { 'Content-Type': 'application/json' },
                body: body ? JSON.stringify(body) : undefined
            }).then(r => r.json());
        }

        // 收藏 / 取消收藏指定路径（菜单、收藏夹抽屉共用）
        async function toggleFavByPath(p) {
            if (!p) return;
            const exists = _favs.find(f => f.path === p);
            if (exists) {
                const ok = await showConfirm('取消收藏 "' + _favBasename(p) + '" 吗？');
                if (!ok) return;
                const d = await _favApi('DELETE', '/api/favorites', { path: p });
                if (d.error) { showToast('错误', d.error, 'danger'); return; }
                showToast('提示', '已取消收藏', 'info');
                await loadFavs();
                const panel = document.getElementById('favoritePanel');
                if (panel && panel.innerHTML) _renderFavTabs();
                return;
            }
            // 新增收藏：弹出分组选择悬浮框（点选现有分组或输入新分组）
            const groups = (_favGroupOrder || []).filter(g => g && g !== '__ungrouped__');
            showInputDialog('收藏「' + _favBasename(p) + '」', '选择分组，或输入新分组名称（留空归入「其他」）', '', async (name) => {
                name = (name || '').trim();
                const d = await _favApi('POST', '/api/favorites', { path: p, group: name });
                if (d.error) { showToast('错误', d.error, 'danger'); return false; }
                showToast('成功', '已收藏到「' + (name || '其他') + '」', 'success');
                await loadFavs();
                const panel = document.getElementById('favoritePanel');
                if (panel && panel.innerHTML) _renderFavTabs();
                return true;
            }, null, { suggestions: groups, suggestionsLabel: '选择分组' });
        }

        // 收藏 / 取消收藏当前目录（工具栏 ⭐ 收藏本目录）
        async function toggleFavCurrent() {
            if (!currentPath) { showToast('提示', '尚未进入任何目录', 'warning'); return; }
            await toggleFavByPath(currentPath);
        }

        function showFavorites() {
            const container = document.getElementById('favoritePanel');
            if (!container) return;
            container.innerHTML = `
            <div class="delhist-overlay">
                <div class="delhist-panel fav-panel">
                    <div class="panel-header">
                        <span class="panel-title"><i class="bi bi-star-fill"></i> 收藏夹</span>
                        <span class="fav-header-acts">
                            <span class="fav-sort-wrap">
                                <button class="fav-sort-btn" id="favSortBtn" title="排序"></button>
                                <span class="fav-sort-menu" id="favSortMenu"></span>
                            </span>
                            <button class="panel-close" title="关闭"><i class="bi bi-x-lg"></i></button>
                        </span>
                    </div>
                    <div class="fav-tabs" id="favTabs"></div>
                    <div class="panel-body" id="favBody"></div>
                    <div class="panel-footer fav-footer">
                        <button class="fav-cur-btn" id="favCurPanelBtn"><i class="bi bi-star"></i> 收藏当前目录</button>
                        <span class="fav-tip">点名称跳转 · 🏷️ 改分组 · 🗑 取消收藏 · 拖动分组标签可排序</span>
                    </div>
                </div>
            </div>
        `;
            container.querySelector('.panel-close').addEventListener('click', closeFavorites);
            container.querySelector('.delhist-overlay').addEventListener('click', (e) => {
                if (e.target === container.querySelector('.delhist-overlay')) closeFavorites();
            });
            document.getElementById('favCurPanelBtn').addEventListener('click', toggleFavCurrent);
            // 排序按钮：点击切换下拉菜单，选择排序模式（记住偏好）
            const sortWrap = container.querySelector('.fav-sort-wrap');
            const sortBtn = container.querySelector('#favSortBtn');
            sortBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                sortWrap.classList.toggle('open');
            });
            document.getElementById('favSortMenu').addEventListener('click', (e) => {
                e.stopPropagation();
                const item = e.target.closest('.fav-sort-item');
                if (!item) return;
                _favSortMode = item.dataset.sort;
                try { localStorage.setItem('favSortMode', _favSortMode); } catch (err) { }
                sortWrap.classList.remove('open');
                _renderFavSortBtn();
                _renderFavList();
            });
            document.addEventListener('click', _favSortDocClose);
            _renderFavSortBtn();
            _renderFavTabs();
        }

        // 点击面板外部时收起排序下拉菜单
        function _favSortDocClose(e) {
            const wrap = document.querySelector('#favoritePanel .fav-sort-wrap');
            if (wrap && !wrap.contains(e.target)) wrap.classList.remove('open');
        }

        function closeFavorites() {
            document.removeEventListener('click', _favSortDocClose);
            const container = document.getElementById('favoritePanel');
            if (container) container.innerHTML = '';
        }

        function _favTabList() {
            // 顺序：全部 → 分组（按拖动保存的顺序，含「其他」占位 __ungrouped__）→ 数据中存在但顺序表缺失的分组兜底
            const order = (_favGroupOrder || []).filter(g => g);
            const list = [{ key: '__all__', label: '全部' }];
            order.forEach(g => list.push({ key: g, label: g === '__ungrouped__' ? '其他' : g }));
            const seen = new Set(order);
            const extra = [];
            _favs.forEach(f => {
                const g = f.group || '__ungrouped__';
                if (!seen.has(g)) { seen.add(g); extra.push(g); }
            });
            if (!seen.has('__ungrouped__')) extra.push('__ungrouped__');
            extra.forEach(g => list.push({ key: g, label: g === '__ungrouped__' ? '其他' : g }));
            return list;
        }

        // 分组 Tab 拖动排序：除「全部」和「＋新建」外均可拖动，落点保存到后端
        let _favDragKey = null;
        function _bindFavTabDrag(wrap) {
            const clearMarks = () => wrap.querySelectorAll('.fav-tab').forEach(b => b.classList.remove('dragging', 'drop-left', 'drop-right'));
            wrap.querySelectorAll('.fav-tab[data-tab]').forEach(btn => {
                if (btn.dataset.tab === '__all__') return;
                btn.draggable = true;
                btn.addEventListener('dragstart', (e) => {
                    _favDragKey = btn.dataset.tab;
                    btn.classList.add('dragging');
                    try { e.dataTransfer.setData('text/plain', _favDragKey); } catch (err) { }
                    e.dataTransfer.effectAllowed = 'move';
                });
                btn.addEventListener('dragend', () => {
                    _favDragKey = null;
                    clearMarks();
                });
            });
            wrap.addEventListener('dragover', (e) => {
                if (!_favDragKey) return;
                const tab = e.target.closest('.fav-tab[data-tab]');
                if (!tab || tab.dataset.tab === '__all__' || tab.dataset.tab === _favDragKey || tab.classList.contains('fav-tab-add')) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                const rect = tab.getBoundingClientRect();
                const before = e.clientX < rect.left + rect.width / 2;
                clearMarks();
                tab.classList.add(before ? 'drop-left' : 'drop-right');
            });
            wrap.addEventListener('dragleave', (e) => {
                if (e.target === wrap) clearMarks();
            });
            wrap.addEventListener('drop', (e) => {
                if (!_favDragKey) return;
                const tab = e.target.closest('.fav-tab[data-tab]');
                clearMarks();
                if (!tab || tab.dataset.tab === '__all__' || tab.dataset.tab === _favDragKey || tab.classList.contains('fav-tab-add')) return;
                e.preventDefault();
                const key = _favDragKey;
                _favDragKey = null;
                // 以「全部」之后的 Tab 顺序为基准重排
                const tabs = _favTabList().map(t => t.key).slice(1);
                const from = tabs.indexOf(key);
                let to = tabs.indexOf(tab.dataset.tab);
                if (from < 0 || to < 0) return;
                tabs.splice(from, 1);
                if (e.clientX >= tab.getBoundingClientRect().left + tab.getBoundingClientRect().width / 2) to += 1;
                tabs.splice(to, 0, key);
                _favGroupOrder = tabs;
                _persistFavGroupOrder();
                _renderFavTabs();
            });
        }

        function _persistFavGroupOrder() {
            _favApi('PUT', '/api/favorites/group', { groups: (_favGroupOrder || []).slice() })
                .then(d => { if (d && d.error) showToast('错误', d.error, 'danger'); })
                .catch(() => { });
        }

        function _renderFavTabs() {
            const wrap = document.getElementById('favTabs');
            if (!wrap) return;
            if (!_favTabList().some(t => t.key === _favActiveTab)) _favActiveTab = '__all__';
            let html = '';
            _favTabList().forEach(t => {
                const cnt = t.key === '__all__' ? _favs.length
                    : _favs.filter(f => (t.key === '__ungrouped__' ? !f.group : f.group === t.key)).length;
                html += `<button class="fav-tab${_favActiveTab === t.key ? ' on' : ''}" data-tab="${_escAttr(t.key)}">${_escapeHtml(t.label)}<span class="cnt">${cnt}</span></button>`;
            });
            html += `<button class="fav-tab fav-tab-add" id="favNewGroupBtn"><i class="bi bi-plus-lg"></i> 新建分组</button>`;
            wrap.innerHTML = html;
            wrap.querySelectorAll('.fav-tab[data-tab]').forEach(btn => {
                btn.addEventListener('click', () => {
                    _favActiveTab = btn.dataset.tab;
                    _renderFavTabs();
                });
            });
            _bindFavTabDrag(wrap);
            wrap.addEventListener('wheel', (e) => {
                // 竖向滚轮映射为横向滚动（shift+滚轮或触摸板原生横向滚动不受影响）
                if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
                    if (wrap.scrollWidth > wrap.clientWidth) {
                        e.preventDefault();
                        wrap.scrollLeft += e.deltaY;
                    }
                }
            }, { passive: false });
            wrap.querySelector('#favNewGroupBtn').addEventListener('click', () => {
                showInputDialog('新建分组', '分组名称', '', async (name) => {
                    name = (name || '').trim();
                    if (!name) return false;
                    const d = await _favApi('POST', '/api/favorites/group', { name: name });
                    if (d.error) { showToast('错误', d.error, 'danger'); return false; }
                    await loadFavs();
                    _favActiveTab = name;
                    _renderFavTabs();
                    return true;
                });
            });
            _renderFavList();
        }

        function _renderFavList() {
            const body = document.getElementById('favBody');
            if (!body) return;
            let list = _favs;
            if (_favActiveTab !== '__all__') {
                list = _favs.filter(f => _favActiveTab === '__ungrouped__' ? !f.group : f.group === _favActiveTab);
            }
            list = _sortFavList(list);
            let html = '';
            // 当前为具体分组：显示分组管理（重命名/删除分组）
            if (_favActiveTab !== '__all__' && _favActiveTab !== '__ungrouped__') {
                html += `<div class="fav-grp-head"><span>📁 ${_escapeHtml(_favActiveTab)}</span>
                <span class="fav-acts">
                    <button class="fav-mini" id="favRenameGroupBtn" title="重命名分组">✏️</button>
                    <button class="fav-mini" id="favDelGroupBtn" title="删除分组（收藏保留，归入其他）">🗑️</button>
                </span></div>`;
            }
            if (!list.length) {
                html += `<div class="delhist-empty"><i class="bi bi-star"></i>暂无收藏<br><span style="font-size:0.75rem;">进入目录后点击工具栏「⭐ 收藏本目录」</span></div>`;
                body.innerHTML = html;
                _bindFavGroupActs();
                return;
            }
            list.forEach(f => {
                const name = f.name || _favBasename(f.path);
                const ico = f.is_dir ? '📁' : '📄';
                html += `<div class="fav-row" data-path="${_escAttr(f.path)}" title="${_escAttr(f.path)}">
                <span class="fav-ico">${ico}</span>
                <span class="fav-name">${_escapeHtml(name)}</span>
                <span class="fav-time">${_fmtFavAdded(f.added)}</span>
                <span class="fav-acts">
                    <button class="fav-mini fav-act-group" data-path="${_escAttr(f.path)}" data-group="${_escAttr(f.group || '')}" title="改分组">🏷️</button>
                    <button class="fav-mini fav-act-del" data-path="${_escAttr(f.path)}" title="取消收藏">🗑️</button>
                </span>
            </div>`;
            });
            body.innerHTML = html;
            _bindFavGroupActs();
            // 行点击跳转：目录直接进入；文件进入其所在目录
            body.querySelectorAll('.fav-row').forEach(row => {
                row.addEventListener('click', (e) => {
                    if (e.target.closest('.fav-mini')) return;
                    const p = row.dataset.path;
                    const item = _favs.find(f => f.path === p);
                    const target = item && item.is_dir ? p : (p.replace(/[\\/][^\\/]+[\\/]?$/, '') || p);
                    _pendingHighlightPath = p;        // 跳转后高亮此条目（文件高亮所在目录中的它，目录高亮自身）
                    navigateTo(target);
                    closeFavorites();
                    _pollPendingHighlight();
                });
            });
            body.querySelectorAll('.fav-act-group').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const p = btn.dataset.path;
                    const existingGroups = (_favGroupOrder || []).filter(g => g && g !== '__ungrouped__');
                    showInputDialog('修改分组', '分组名称（留空归入「其他」，输入新名称自动创建）', btn.dataset.group, async (name) => {
                        name = (name || '').trim();
                        const d = await _favApi('PUT', '/api/favorites', { path: p, group: name });
                        if (d.error) { showToast('错误', d.error, 'danger'); return false; }
                        await loadFavs();
                        _renderFavTabs();
                        return true;
                    }, null, { suggestions: existingGroups, suggestionsLabel: '现有分组' });
                });
            });
            body.querySelectorAll('.fav-act-del').forEach(btn => {
                btn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    const p = btn.dataset.path;
                    const ok = await showConfirm('取消收藏 "' + _favBasename(p) + '" 吗？');
                    if (!ok) return;
                    const d = await _favApi('DELETE', '/api/favorites', { path: p });
                    if (d.error) { showToast('错误', d.error, 'danger'); return; }
                    await loadFavs();
                    _renderFavTabs();
                });
            });
        }

        function _bindFavGroupActs() {
            const rn = document.getElementById('favRenameGroupBtn');
            if (rn) rn.addEventListener('click', () => {
                showInputDialog('重命名分组', '新的分组名称', _favActiveTab, async (name) => {
                    name = (name || '').trim();
                    if (!name || name === _favActiveTab) return false;
                    const d = await _favApi('POST', '/api/favorites/group', { old: _favActiveTab, name: name });
                    if (d.error) { showToast('错误', d.error, 'danger'); return false; }
                    await loadFavs();
                    _favActiveTab = name;
                    _renderFavTabs();
                    return true;
                });
            });
            const del = document.getElementById('favDelGroupBtn');
            if (del) del.addEventListener('click', async () => {
                const ok = await showConfirm('删除分组 "' + _favActiveTab + '" 吗？组内收藏会保留并归入「其他」。');
                if (!ok) return;
                const d = await _favApi('DELETE', '/api/favorites/group', { name: _favActiveTab });
                if (d.error) { showToast('错误', d.error, 'danger'); return; }
                await loadFavs();
                _favActiveTab = '__all__';
                _renderFavTabs();
            });
        }

        function _initFavUI() {
            const favBtn = document.getElementById('favPanelBtn');
            if (favBtn) favBtn.addEventListener('click', showFavorites);
            const curBtn = document.getElementById('favCurBtn');
            if (curBtn) curBtn.addEventListener('click', toggleFavCurrent);
            loadFavs();
        }
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', _initFavUI);
        } else {
            _initFavUI();
        }

        function _formatTimeAgo(ts) {
            if (!ts) return '--';
            const diff = Math.floor((Date.now() / 1000) - ts);
            if (diff < 60) return diff + '秒前';
            if (diff < 3600) return Math.floor(diff / 60) + '分钟前';
            if (diff < 86400) return Math.floor(diff / 3600) + '小时前';
            return Math.floor(diff / 86400) + '天前';
        }

        // ===== 回收站条目：类型图标 / 是否可出缩略图 =====
        const _delhistItemMap = new Map();
        const _TRASH_IMG_EXT = ['jpg', 'jpeg', 'png', 'gif', 'svg', 'webp', 'bmp', 'ico'];
        const _TRASH_VIDEO_EXT = ['mp4', 'webm', 'mkv', 'avi', 'mov', 'm4v', 'ogg', 'flv', 'wmv', 'rmvb'];

        function _trashExt(name) {
            return (String(name || '').split('.').pop() || '').toLowerCase();
        }

        function _trashIconClass(item) {
            if (item.is_dir) return 'bi-folder-fill';
            const ext = _trashExt(item.name);
            if (_TRASH_IMG_EXT.includes(ext)) return 'bi-file-image';
            if (_TRASH_VIDEO_EXT.includes(ext)) return 'bi-file-play';
            if (['mp3', 'wav', 'flac', 'aac', 'm4a', 'opus', 'wma', 'ape'].includes(ext)) return 'bi-file-music';
            if (['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz'].includes(ext)) return 'bi-file-zip';
            if (['pdf'].includes(ext)) return 'bi-file-pdf';
            if (['py', 'js', 'ts', 'java', 'c', 'cpp', 'go', 'rs', 'sh', 'css', 'html'].includes(ext)) return 'bi-file-code';
            if (['txt', 'md', 'log', 'json', 'xml', 'yml', 'yaml', 'csv', 'ini', 'conf'].includes(ext)) return 'bi-file-text';
            return 'bi-file-earmark';
        }

        // 只有图片/视频能出缩略图（回收站文件无扩展名，需后端按原文件名判断）
        function _trashCanThumb(name, isDir) {
            if (isDir) return false;
            const ext = _trashExt(name);
            return _TRASH_IMG_EXT.includes(ext) || _TRASH_VIDEO_EXT.includes(ext);
        }

        // 查看回收站里的文件（图片/视频/音频/文本）
        function _viewTrashItem(item) {
            if (!item) return;
            if (item.exists === false) { showToast('提示', '文件已丢失，无法查看', 'warning'); return; }
            const name = item.name || '';
            const ext = _trashExt(name);
            const url = '/api/trash/raw?id=' + encodeURIComponent(item.id);
            const isImg = _TRASH_IMG_EXT.includes(ext);
            const isVideo = _TRASH_VIDEO_EXT.includes(ext);
            const isAudio = ['mp3', 'wav', 'flac', 'aac', 'm4a', 'opus', 'wma', 'ape'].includes(ext);
            const isText = ['txt', 'md', 'log', 'json', 'xml', 'yml', 'yaml', 'csv', 'ini', 'conf', 'py', 'js', 'ts', 'css', 'html', 'sh'].includes(ext);

            const container = document.getElementById('customModalContainer');
            if (!container) return;
            const overlay = document.createElement('div');
            overlay.className = 'custom-modal-overlay';
            overlay.innerHTML = `
                <div class="trash-view-modal">
                    <div class="tvm-header">
                        <span class="tvm-title"><i class="bi ${_trashIconClass(item)}"></i> ${_escHtml(name)}</span>
                        <button class="tvm-close" title="关闭"><i class="bi bi-x-lg"></i></button>
                    </div>
                    <div class="tvm-body"><div class="tvm-loading"><i class="bi bi-hourglass-split"></i> 加载中...</div></div>
                </div>`;
            container.appendChild(overlay);
            const close = () => { if (document.body.contains(overlay)) overlay.remove(); };
            overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
            overlay.querySelector('.tvm-close').addEventListener('click', close);

            const bodyEl = overlay.querySelector('.tvm-body');
            if (isImg) {
                bodyEl.innerHTML = `<img class="tvm-img" alt="" src="${url}">`;
                bodyEl.querySelector('img').addEventListener('error', () => {
                    bodyEl.innerHTML = '<div class="tvm-loading">图片加载失败</div>';
                });
            } else if (isVideo) {
                bodyEl.innerHTML = `<video class="tvm-video" src="${url}" controls autoplay playsinline></video>`;
                bodyEl.querySelector('video').addEventListener('error', () => {
                    bodyEl.innerHTML = '<div class="tvm-loading">该视频无法播放（可能是编码不受支持）</div>';
                });
            } else if (isAudio) {
                bodyEl.innerHTML = `<div class="tvm-audio"><i class="bi bi-music-note-beamed"></i><audio src="${url}" controls autoplay></audio></div>`;
            } else if (isText) {
                fetch(url).then(r => r.text()).then(t => {
                    bodyEl.innerHTML = '<pre class="tvm-text"></pre>';
                    bodyEl.querySelector('pre').textContent = t.length > 200000
                        ? t.slice(0, 200000) + '\n…（内容过长，已截断）' : t;
                }).catch(() => { bodyEl.innerHTML = '<div class="tvm-loading">读取失败</div>'; });
            } else {
                bodyEl.innerHTML = '<div class="tvm-loading"><i class="bi bi-eye-slash"></i> 该类型暂不支持在线查看，可先恢复再打开</div>';
            }
        }

        function _loadDeleteHistoryList() {
            fetch('/api/delete-history')
                .then(r => r.json())
                .then(data => {
                    const body = document.getElementById('delhistBody');
                    const clearBtn = document.getElementById('delhistClearBtn');
                    const badge = document.getElementById('delhistCountBadge');
                    if (!body) return;
                    const items = data.items || [];
                    const count = data.count || 0;

                    // 更新顶部徽章
                    if (badge) {
                        badge.textContent = count > 0 ? (count > 99 ? '99+' : count) : '0';
                        badge.classList.toggle('empty', count === 0);
                    }
                    // 面板标题上的总数
                    const totalEl = document.getElementById('delhistTotal');
                    if (totalEl) totalEl.textContent = count > 0 ? count + ' 项' : '';

                    if (items.length === 0) {
                        body.innerHTML = '<div class="delhist-empty"><i class="bi bi-check-circle"></i>回收站为空</div>';
                        if (clearBtn) clearBtn.disabled = true;
                        return;
                    }

                    if (clearBtn) clearBtn.disabled = false;

                    let html = '';
                    _delhistItemMap.clear();
                    for (const item of items) {
                        _delhistItemMap.set(item.id, item);
                        const timeStr = _formatTimeAgo(item.deleted_at);
                        const sizeStr = item.size > 0 ? formatSize(item.size) : (item.is_dir ? '目录' : '0 B');
                        const exists = item.exists !== false;
                        const icon = _trashIconClass(item);
                        // 小封面：图片/视频走后端缩略图，其余或加载失败时回落类型图标
                        const canThumb = exists && _trashCanThumb(item.name, item.is_dir);
                        const thumbInner = `<i class="bi ${icon} dh-thumb-icon${item.is_dir ? ' dir' : ''}"></i>`
                            + (canThumb ? `<img loading="lazy" alt="" src="/api/trash/thumb?id=${encodeURIComponent(item.id)}" onerror="this.remove()">` : '');
                        html += `
                        <div class="delhist-item${exists ? '' : ' lost'}">
                            <span class="dh-thumb">${thumbInner}</span>
                            <div class="dh-info">
                                <div class="dh-name" title="${_escHtml(item.name)}">${_escHtml(item.name)}</div>
                                <div class="dh-path" title="${_escHtml(item.original_path)}">${_escHtml(item.original_path)}</div>
                                <div class="dh-meta">
                                    <span class="dh-time"><i class="bi bi-clock"></i> ${timeStr}</span>
                                    <span class="dh-size"><i class="bi bi-hdd"></i> ${sizeStr}</span>
                                    <span class="dh-status ${exists ? '' : 'lost'}"><i class="bi bi-${exists ? 'check-circle' : 'x-circle'}"></i> ${exists ? '可恢复' : '文件已丢失'}</span>
                                </div>
                            </div>
                            <div class="dh-actions">
                                <button class="btn btn-view" data-tid="${item.id}" ${exists ? '' : 'disabled'} title="查看"><i class="bi bi-eye"></i> 查看</button>
                                <button class="btn btn-restore" data-tid="${item.id}" ${exists ? '' : 'disabled'} title="恢复"><i class="bi bi-arrow-counterclockwise"></i> 恢复</button>
                                <button class="btn btn-remove" data-tid="${item.id}" title="永久删除"><i class="bi bi-trash3"></i> 删除</button>
                            </div>
                        </div>
                    `;
                    }
                    body.innerHTML = html;

                    // 绑定查看按钮
                    body.querySelectorAll('.btn-view').forEach(btn => {
                        btn.addEventListener('click', () => {
                            _viewTrashItem(_delhistItemMap.get(btn.dataset.tid));
                        });
                    });
                    // 绑定恢复按钮
                    body.querySelectorAll('.btn-restore').forEach(btn => {
                        btn.addEventListener('click', () => {
                            restoreFromTrash(btn.dataset.tid, btn);
                        });
                    });
                    // 绑定删除按钮
                    body.querySelectorAll('.btn-remove').forEach(btn => {
                        btn.addEventListener('click', () => {
                            permanentlyDeleteItem(btn.dataset.tid, btn);
                        });
                    });
                })
                .catch(e => {
                    const body = document.getElementById('delhistBody');
                    if (body) body.innerHTML = '<div class="delhist-empty"><i class="bi bi-exclamation-triangle"></i>加载失败</div>';
                });
        }

        function _loadDeleteHistoryCount() {
            fetch('/api/delete-history')
                .then(r => r.json())
                .then(data => {
                    const badge = document.getElementById('delhistCountBadge');
                    if (!badge) return;
                    const count = data.count || 0;
                    badge.textContent = count > 0 ? (count > 99 ? '99+' : count) : '0';
                    badge.classList.toggle('empty', count === 0);
                })
                .catch(() => { });
        }

        function loadDeleteHistoryCount() {
            _loadDeleteHistoryCount();
        }

        async function restoreFromTrash(trashId, btn) {
            btn.disabled = true;
            btn.innerHTML = '<i class="bi bi-hourglass-split"></i> 恢复中...';
            try {
                const resp = await fetch('/api/undo-delete', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ trash_id: trashId })
                });
                const data = await resp.json();
                if (data.success) {
                    showToast('恢复成功', data.message || '已恢复', 'success');
                    loadFiles(currentPath);
                    _loadDeleteHistoryList();
                } else {
                    showToast('恢复失败', data.error || '恢复失败', 'warning');
                    btn.disabled = false;
                    btn.innerHTML = '<i class="bi bi-arrow-counterclockwise"></i> 恢复';
                }
            } catch (e) {
                showToast('错误', '恢复失败: ' + e.message, 'danger');
                btn.disabled = false;
                btn.innerHTML = '<i class="bi bi-arrow-counterclockwise"></i> 恢复';
            }
        }

        async function permanentlyDeleteItem(trashId, btn) {
            btn.disabled = true;
            btn.innerHTML = '<i class="bi bi-trash3"></i> 删除中...';
            try {
                const resp = await fetch('/api/delete-history/one', {
                    method: 'DELETE',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ trash_id: trashId })
                });
                const data = await resp.json();
                if (data.success) {
                    showToast('已删除', '已永久删除: ' + data.removed, 'info');
                    _loadDeleteHistoryList();
                } else {
                    showToast('错误', data.error || '删除失败', 'danger');
                    btn.disabled = false;
                    btn.innerHTML = '<i class="bi bi-trash3"></i> 删除';
                }
            } catch (e) {
                showToast('错误', '删除失败: ' + e.message, 'danger');
                btn.disabled = false;
                btn.innerHTML = '<i class="bi bi-trash3"></i> 删除';
            }
        }

        async function clearDeleteHistory() {
            const confirmed = await showConfirm('确定要清空回收站吗？这将永久删除所有已删除的文件/目录，无法恢复！');
            if (!confirmed) return;
            const btn = document.getElementById('delhistClearBtn');
            btn.disabled = true;
            btn.innerHTML = '<i class="bi bi-hourglass-split"></i> 清理中...';
            try {
                const resp = await fetch('/api/delete-history/clear', { method: 'POST' });
                const data = await resp.json();
                if (data.success) {
                    showToast('已清空', '已永久删除 ' + data.removed + ' 项' + (data.errors > 0 ? '，' + data.errors + ' 项失败' : ''), 'success');
                    _loadDeleteHistoryList();
                } else {
                    showToast('错误', data.error || '清空失败', 'danger');
                    btn.disabled = false;
                    btn.innerHTML = '<i class="bi bi-trash3"></i> 清空回收站';
                }
            } catch (e) {
                showToast('错误', '清空失败: ' + e.message, 'danger');
                btn.disabled = false;
                btn.innerHTML = '<i class="bi bi-trash3"></i> 清空回收站';
            }
        }

        function _handleIndexRebuild() {
            const status = document.getElementById('idxStatus').textContent;
            if (status === '扫描中...') return;

            showConfirm('确定要重建索引吗？重建将重新扫描所有文件并更新统计信息，耗时较长。')
                .then(confirmed => {
                    if (!confirmed) return;
                    const rebuildBtn = document.getElementById('idxRebuildBtn');
                    const cancelBtn = document.getElementById('idxCancelBtn');
                    rebuildBtn.disabled = true;
                    rebuildBtn.innerHTML = '<i class="bi bi-arrow-repeat spin" style="display:inline-block;animation:spin 1s linear infinite;"></i> 启动中...';
                    cancelBtn.style.display = '';

                    fetch('/api/index/build', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ roots: '' }) })
                        .then(r => r.json())
                        .then(data => {
                            rebuildBtn.disabled = false;
                            rebuildBtn.innerHTML = '<i class="bi bi-arrow-clockwise"></i> 重建索引';
                            if (data.error) { showToast('错误', data.error, 'danger'); return; }
                            showToast('成功', '索引构建已启动', 'success');
                            startIndexPolling();
                            setTimeout(_loadIndexDetail, 1000);
                        })
                        .catch(e => {
                            rebuildBtn.disabled = false;
                            rebuildBtn.innerHTML = '<i class="bi bi-arrow-clockwise"></i> 重建索引';
                            showToast('错误', e.message, 'danger');
                        });
                });
        }

        function _handleIndexCancel() {
            fetch('/api/index/cancel', { method: 'POST' })
                .then(r => r.json())
                .then(() => {
                    const cancelBtn = document.getElementById('idxCancelBtn');
                    if (cancelBtn) cancelBtn.style.display = 'none';
                    showToast('提示', '已取消索引扫描', 'info');
                    setTimeout(_loadIndexDetail, 500);
                })
                .catch(() => { });
        }

        function _loadIndexDetail() {
            fetch('/api/index/detail')
                .then(r => r.json())
                .then(renderIndexDetail)
                .catch(() => { });
        }

        function renderIndexDetail(data) {
            const status = data.status || 'idle';
            const progress = data.progress || 0;
            const totalFiles = data.total_files || 0;
            const totalDirs = data.total_dirs || 0;
            const totalSizeStr = data.total_size_str || '--';
            const lastScan = data.last_scan || '--';
            const statusDetail = data.status_detail || '';

            document.getElementById('idxFileCount').textContent = totalFiles.toLocaleString();
            document.getElementById('idxDirCount').textContent = totalDirs.toLocaleString();
            document.getElementById('idxTotalSize').textContent = totalSizeStr;
            document.getElementById('idxLastScan').textContent = lastScan;

            // 状态
            const statusEl = document.getElementById('idxStatus');
            const progressArea = document.getElementById('idxProgressArea');
            const cancelBtn = document.getElementById('idxCancelBtn');
            if (status === 'scanning') {
                statusEl.textContent = '扫描中... ' + (statusDetail || '');
                progressArea.style.display = '';
                document.getElementById('idxProgressText').textContent = progress + '% ' + (statusDetail || '扫描中');
                document.getElementById('idxProgressFill').style.width = progress + '%';
                cancelBtn.style.display = '';
            } else if (status === 'error') {
                statusEl.textContent = '❌ 失败';
                progressArea.style.display = 'none';
                cancelBtn.style.display = 'none';
            } else {
                statusEl.textContent = '✅ 就绪';
                progressArea.style.display = 'none';
                cancelBtn.style.display = 'none';
            }

            // Top 15 目录
            const topDirsEl = document.getElementById('idxTopDirs');
            const topDirs = data.top_dirs || [];
            if (topDirs.length === 0) {
                topDirsEl.innerHTML = '<div class="idx-empty"><i class="bi bi-inbox"></i>暂无数据</div>';
            } else {
                let html = '<table class="idx-table"><thead><tr><th>#</th><th>目录</th><th>文件数</th><th class="num">大小</th></tr></thead><tbody>';
                topDirs.forEach((item, idx) => {
                    html += `<tr><td class="num">${idx + 1}</td><td class="path-cell" data-path="${_escAttr(item.path)}">${_escHtml(item.name)}</td><td class="num">${item.file_count.toLocaleString()}</td><td class="num">${item.size_str}</td></tr>`;
                });
                html += '</tbody></table>';
                topDirsEl.innerHTML = html;
                // 路径点击导航
                topDirsEl.querySelectorAll('.path-cell').forEach(el => {
                    el.addEventListener('click', () => {
                        closeIndexDetail();
                        navigateTo(el.dataset.path);
                    });
                });
            }

            // 类型分布
            const typeDistEl = document.getElementById('idxTypeDist');
            const typeDist = data.type_distribution || [];
            if (typeDist.length === 0) {
                typeDistEl.innerHTML = '<div class="idx-empty"><i class="bi bi-inbox"></i>暂无数据</div>';
            } else {
                let html = '<table class="idx-table"><thead><tr><th>后缀</th><th>数量</th><th class="num">总大小</th></tr></thead><tbody>';
                typeDist.forEach(item => {
                    html += `<tr><td><span class="ext-badge">${_escHtml(item.ext)}</span></td><td class="num">${item.count.toLocaleString()}</td><td class="num">${item.size_str}</td></tr>`;
                });
                html += '</tbody></table>';
                typeDistEl.innerHTML = html;
            }

            // 最大文件 Top 10
            const topFilesEl = document.getElementById('idxTopFiles');
            const topFiles = data.top_files || [];
            if (topFiles.length === 0) {
                topFilesEl.innerHTML = '<div class="idx-empty"><i class="bi bi-inbox"></i>暂无数据</div>';
            } else {
                let html = '<table class="idx-table"><thead><tr><th>文件名</th><th>后缀</th><th class="num">大小</th></tr></thead><tbody>';
                topFiles.forEach(item => {
                    html += `<tr><td class="path-cell" data-path="${_escAttr(item.parent)}">${_escHtml(item.name)}</td><td><span class="ext-badge">${_escHtml(item.ext)}</span></td><td class="num">${item.size_str}</td></tr>`;
                });
                html += '</tbody></table>';
                topFilesEl.innerHTML = html;
                topFilesEl.querySelectorAll('.path-cell').forEach(el => {
                    el.addEventListener('click', () => {
                        closeIndexDetail();
                        navigateTo(el.dataset.path);
                    });
                });
            }
        }

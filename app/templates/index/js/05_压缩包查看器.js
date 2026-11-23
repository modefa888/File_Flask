        // ========== 压缩包查看器 ==========
        let _zipOuterPath = '';     // 外层 zip 绝对路径
        let _zipNestedEntry = '';   // 嵌套时的外层 entry（非空表示正在看嵌套 zip）
        let _currentZipEntry = '';  // 当前浏览的虚拟目录
        let _currentZipEntries = [];
        let _zipSortKey = 'default';  // 排序字段: 'default' | 'size' | 'type'
        let _zipSortDir = 1;          // 排序方向: 1 升序, -1 降序
        let _zipKeyHandler = null;    // 当前压缩包查看器的 Escape 监听
        const _zipViewerStack = [];   // 嵌套查看时上一层查看器 {el, keyHandler, state}，关闭时恢复

        function closeZipViewer() {
            const container = document.getElementById('previewContainer');
            const top = _zipViewerStack[_zipViewerStack.length - 1];
            if (top) {
                _zipViewerStack.pop();
                const cur = container.querySelector('.preview-overlay');
                if (cur) cur.remove();
                if (_zipKeyHandler) document.removeEventListener('keydown', _zipKeyHandler);
                const s = top.state;
                _zipOuterPath = s.outer;
                _zipNestedEntry = s.nestedEntry;
                _currentZipPath = s.zipPath;
                _currentZipEntry = s.entry;
                _zipKeyHandler = top.keyHandler;
                if (_zipKeyHandler) document.addEventListener('keydown', _zipKeyHandler);
                container.appendChild(top.el);
                return;
            }
            closePreview();
        }

        function _isZip(ext) {
            return ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz'].includes((ext || '').toLowerCase());
        }

        function _b64(s) { return btoa(unescape(encodeURIComponent(s))); }
        function _b64d(s) { return decodeURIComponent(escape(atob(s))); }

        function openZipViewer(absPath, startEntry, outerPath, nestedEntry) {
            const container = document.getElementById('previewContainer');
            // 若当前已打开压缩包查看页（从外层 zip 点进嵌套包），先入栈，关闭时恢复
            const prevOverlay = container.querySelector('.preview-overlay');
            if (prevOverlay && prevOverlay.querySelector('.zip-modal .zip-body')) {
                const prevKeyHandler = _zipKeyHandler;
                if (prevKeyHandler) document.removeEventListener('keydown', prevKeyHandler);
                _zipKeyHandler = null;
                prevOverlay.remove();
                _zipViewerStack.push({
                    el: prevOverlay, keyHandler: prevKeyHandler,
                    state: {
                        outer: _zipOuterPath, nestedEntry: _zipNestedEntry,
                        zipPath: _currentZipPath, entry: _currentZipEntry
                    }
                });
            }
            _zipOuterPath = outerPath || '';
            _zipNestedEntry = nestedEntry || '';
            _currentZipPath = absPath;
            _currentZipEntry = startEntry || '';
            _zipSortKey = 'default';
            _zipSortDir = 1;
            const isNested = !!outerPath;
            const displayName = absPath.split('/').pop();
            const nestedHint = isNested ? `<span class="zip-nested-hint"><i class="bi bi-file-zip"></i>嵌套包</span>` : '';
            container.innerHTML = `
            <div class="preview-overlay zip-overlay">
                <div class="zip-modal zip-viewer">
                    <div class="zip-header">
                        <div class="zip-title-row">
                            <div class="zip-title-main">
                                <span class="zip-icon-badge">${fileIconHtml({ is_dir: false, name: displayName, ext: (displayName.split('.').pop() || '') }, 'zip-title-icon')}</span>
                                <div class="zip-title-info">
                                    <div class="zip-title"><span id="zipTitleName">${_escHtml(displayName)}</span>${nestedHint}</div>
                                    <span class="zip-meta" id="zipMetaLine"></span>
                                </div>
                            </div>
                            <div class="zip-actions">
                                <button class="btn btn-extract" id="zipExtractBtn"><i class="bi bi-box-arrow-up"></i> 解压</button>
                                <button class="btn btn-close-zip" id="zipCloseBtn" title="关闭"><i class="bi bi-x-lg"></i></button>
                            </div>
                        </div>
                    </div>
                    <div class="zip-toolbar" id="zipBreadcrumb"></div>
                    <div class="zip-body" id="zipBody">
                        <div class="zip-loading"><div class="spinner-border" role="status"></div><span>正在加载压缩包内容…</span></div>
                    </div>
                </div>
            </div>
        `;
            // 只允许点右上角「×」关闭，点击遮罩/其他区域不关闭
            container.querySelector('.preview-overlay').addEventListener('click', (e) => e.stopPropagation());
            document.getElementById('zipCloseBtn').addEventListener('click', closeZipViewer);
            document.getElementById('zipExtractBtn').addEventListener('click', () => {
                if (isNested) {
                    // 嵌套压缩包：服务端把外层包内的该 zip 成员单独解压到外层 zip 所在目录
                    const memberName = nestedEntry.split('/').pop() || displayName;
                    const destDir = outerPath.substring(0, Math.max(outerPath.lastIndexOf('/'), 0)) || '/';
                    _bgStart('uz', '/api/zip/nested/unzip/start', {
                        path: outerPath, outer_entry: nestedEntry,
                        dest_dir: destDir, name: memberName.replace(/\.zip$/i, '')
                    }, {
                        title: '正在解压：' + displayName,
                        legacy: () => {   // 后端未升级兜底：退回下载该压缩包成员
                            window.open(`/api/zip/file?zip_path=${encodeURIComponent(outerPath)}&entry=${encodeURIComponent(nestedEntry)}`, '_blank');
                        },
                        onDone: (ok, d) => {
                            const r = d && d.result;
                            if (ok && r) {
                                showToast('成功', `已解压 ${r.files != null ? r.files : ''} 个文件到「${r.name}」`, 'success');
                                const resPath = r.path || '';
                                const parent = resPath ? resPath.substring(0, Math.max(resPath.lastIndexOf('/'), resPath.lastIndexOf('\\'))) : '';
                                if (parent === currentPath) {
                                    localAddItem({
                                        name: r.name, path: r.name,
                                        is_dir: true, size: 0, size_str: '', ext: '', type: '', mtime: _nowStr()
                                    });
                                }
                            }
                        }
                    });
                    return;
                }
                _startUnzip(absPath);
            });
            if (_zipKeyHandler) document.removeEventListener('keydown', _zipKeyHandler);
            _zipKeyHandler = null;   // Esc 不再退出压缩包查看，只能点右上角「×」
            _loadZipContents(absPath, startEntry || '');
        }

        function _loadZipContents(zipPath, entry) {
            const body = document.getElementById('zipBody');
            const meta = document.getElementById('zipMetaLine');
            if (body) body.innerHTML = '<div class="zip-loading"><div class="spinner-border" role="status"></div><span>正在加载…</span></div>';
            const cleanEntry = (entry || '').replace(/\/+$/, '');
            // 立即渲染面包屑，避免加载过程中路径区空闪/抖动
            _renderZipBreadcrumb(cleanEntry);
            const url = (_zipOuterPath
                ? `/api/zip/nested?zip_path=${encodeURIComponent(_zipOuterPath)}&outer_entry=${encodeURIComponent(_zipNestedEntry)}&inner_dir=${encodeURIComponent(cleanEntry)}`
                : `/api/zip/contents?path=${encodeURIComponent(zipPath)}${cleanEntry ? `&dir=${encodeURIComponent(cleanEntry)}` : ''}`);
            fetch(url)
                .then(r => r.json())
                .then(data => {
                    if (data.error) {
                        if (body) body.innerHTML = `<div class="zip-error"><i class="bi bi-exclamation-circle"></i><span>${_escHtml(data.error)}</span></div>`;
                        return;
                    }
                    _currentZipEntries = data.entries || [];
                    meta.innerHTML = `${data.zip_size_str} · ${data.entry_count} 项 · 原始 ${data.total_uncompressed_str}`;
                    _renderZipList(data.entries, cleanEntry);
                })
                .catch(err => {
                    if (body) body.innerHTML = `<div class="zip-error"><i class="bi bi-exclamation-circle"></i><span>加载失败: ${err.message}</span></div>`;
                });
        }

        function _renderZipList(entries, currentEntry) {
            const body = document.getElementById('zipBody');
            if (!body) return;
            if (!entries || entries.length === 0) {
                body.innerHTML = '<div class="zip-empty"><i class="bi bi-inbox"></i><span>压缩包内无文件</span></div>';
                _renderZipBreadcrumb('');
                return;
            }
            // 后端已经按 dir 参数过滤，直接使用返回的 entries（名称已是相对当前目录的）
            let visible = entries;
            // 应用排序
            const sortKey = _zipSortKey || 'default';
            const sortDir = _zipSortDir || 1;
            const sorted = [...visible];
            if (sortKey === 'size') {
                sorted.sort((a, b) => sortDir * ((a.size || 0) - (b.size || 0)));
            } else if (sortKey === 'compressed') {
                sorted.sort((a, b) => sortDir * ((a.compressed || 0) - (b.compressed || 0)));
            } else if (sortKey === 'name') {
                sorted.sort((a, b) => {
                    if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
                    return sortDir * a.name.localeCompare(b.name, 'zh-CN');
                });
            } else if (sortKey === 'type') {
                sorted.sort((a, b) => {
                    const ta = (a.ext || (a.is_dir ? '' : 'zzz')).toLowerCase();
                    const tb = (b.ext || (b.is_dir ? '' : 'zzz')).toLowerCase();
                    const da = a.is_dir ? 0 : 1;
                    const db = b.is_dir ? 0 : 1;
                    if (da !== db) return sortDir * (da - db);
                    return sortDir * ta.localeCompare(tb);
                });
            } else {
                sorted.sort((a, b) => {
                    if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
                    return a.name.localeCompare(b.name);
                });
            }

            const sortHeader = (field, label, extraCls) => {
                const active = sortKey === field;
                const cls = active ? (sortDir === 1 ? 'sort-asc' : 'sort-desc') : '';
                const arrow = active
                    ? `<i class="bi bi-caret-${sortDir === 1 ? 'up' : 'down'}-fill"></i>`
                    : `<i class="bi bi-arrow-down-up zip-sort-idle"></i>`;
                return `<th class="zip-sortable ${extraCls || ''} ${cls}" data-sort="${field}"><span class="zip-th-inner">${label}${arrow}</span></th>`;
            };

            let html = `<table class="zip-table">
            <colgroup>
                <col class="zip-col-icon">
                <col class="zip-col-name">
                <col class="zip-col-size">
                <col class="zip-col-compressed">
                <col class="zip-col-type">
                <col class="zip-col-actions">
            </colgroup>
            <thead><tr>
            <th class="zip-col-icon"></th>
            ${sortHeader('name', '名称', 'zip-col-name')}
            ${sortHeader('size', '大小', 'zip-col-size')}
            ${sortHeader('compressed', '压缩后', 'zip-col-compressed')}
            ${sortHeader('type', '类型', 'zip-col-type')}
            <th class="zip-col-actions">操作</th>
        </tr></thead><tbody>`;
            for (const e of sorted) {
                const isDir = !!e.is_dir;
                // 图标与文件管理器同一套（Seti / 自定义规则 / 彩色兜底）
                const icon = fileIconHtml({ is_dir: isDir, name: e.name, ext: e.ext || '' }, 'zip-item-icon');
                const sizeStr = e.size != null ? _humanSize(e.size) : '-';
                const compStr = e.compressed != null ? _humanSize(e.compressed) : '-';
                // 显示名是相对于当前目录的，拼接为完整相对路径
                const fullEntry = currentEntry ? (currentEntry + '/' + e.name) : e.name;
                const entryEsc = _escAttr(fullEntry);
                const nameEsc = _escHtml(e.name);
                const ext = (e.ext || '').toLowerCase();
                const isZipEntry = _isZip(ext);
                // 预览按钮：仅对可预览的文件显示（包内视频需整体解压，不提供在线预览）
                const canPreview = _canPreviewZipMember(ext);
                // 空文件夹不显示「进入」按钮
                const isEmptyDir = isDir && e.is_empty === true;
                // 类型显示
                const typeText = isDir ? '文件夹' : (ext ? ext.toUpperCase() : '未知');

                html += `<tr data-zip-entry="${entryEsc}" data-is-dir="${isDir}" data-is-empty="${isEmptyDir}">
                <td class="zip-col-icon">${icon}</td>
                <td class="zip-name-cell"><span class="name ${isDir ? (isEmptyDir ? 'dir-name dir-empty' : 'dir-name') : (canPreview ? 'clickable-name' : '')}" data-zip-entry="${entryEsc}" data-ext="${ext}">${nameEsc}</span></td>
                <td class="zip-size zip-col-size">${sizeStr}</td>
                <td class="zip-size zip-col-compressed">${compStr}</td>
                <td class="zip-col-type"><span class="file-type-badge${isDir ? ' dir' : ''}">${typeText}</span></td>
                <td class="zip-actions-cell zip-col-actions">
                    ${isDir ? (isEmptyDir ? '' : `<button class="btn btn-zip-open" data-zip-entry="${entryEsc}"><i class="bi bi-folder2-open"></i> 进入</button>`) :
                        (isZipEntry ?
                            `<button class="btn btn-zip-open" data-zip-entry="${entryEsc}"><i class="bi bi-box-arrow-in-right"></i> 打开</button>
                         <button class="btn btn-zip-download" data-zip-entry="${entryEsc}"><i class="bi bi-download"></i> 下载</button>` :
                            (canPreview ?
                                `<button class="btn btn-zip-preview" data-zip-entry="${entryEsc}"><i class="bi bi-eye"></i> 预览</button>
                           <button class="btn btn-zip-download" data-zip-entry="${entryEsc}"><i class="bi bi-download"></i> 下载</button>` :
                                `<button class="btn btn-zip-download" data-zip-entry="${entryEsc}"><i class="bi bi-download"></i> 下载</button>`
                            )
                        )}
                </td>
            </tr>`;
            }
            html += '</tbody></table>';
            body.innerHTML = html;

            // 排序头点击 —— 直接读全局变量（不用闭包捕获的局部 sortKey），防止闭包状态不一致
            body.querySelectorAll('.zip-sortable').forEach(th => {
                th.addEventListener('click', () => {
                    const field = th.dataset.sort;
                    if (_zipSortKey === field) {
                        _zipSortDir = -_zipSortDir;
                    } else {
                        _zipSortKey = field;
                        _zipSortDir = 1;
                    }
                    _renderZipList(visible, currentEntry);
                });
            });

            body.querySelectorAll('[data-zip-entry]').forEach(el => {
                const entry = el.dataset.zipEntry;
                const targetRow = el.closest('tr');
                const isDir = targetRow && targetRow.dataset.isDir === 'true';
                const isEmpty = targetRow && targetRow.dataset.isEmpty === 'true';
                el.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (isDir) {
                        if (isEmpty) return;  // 空文件夹：禁止点击
                        _navigateZipEntry(entry);
                        return;
                    }
                    // zip 包：点击文件名/行直接打开嵌套查看
                    const ext = el.dataset.ext || '';
                    if (_isZip(ext)) { _navigateZipEntry(entry); return; }
                    // 可预览文件：点击文件名也可打开预览（包内视频不支持，走下载）
                    if (_canPreviewZipMember(ext)) { _previewZipEntry(entry); }
                });
            });
            body.querySelectorAll('.btn-zip-open').forEach(btn => {
                btn.addEventListener('click', (e) => { e.stopPropagation(); _navigateZipEntry(btn.dataset.zipEntry); });
            });
            body.querySelectorAll('.btn-zip-preview').forEach(btn => {
                btn.addEventListener('click', (e) => { e.stopPropagation(); _previewZipEntry(btn.dataset.zipEntry); });
            });
            body.querySelectorAll('.btn-zip-download').forEach(btn => {
                btn.addEventListener('click', (e) => { e.stopPropagation(); _downloadZipEntry(btn.dataset.zipEntry); });
            });
            _renderZipBreadcrumb(currentEntry);
        }

        function _navigateZipEntry(entry) {
            const cleanEntry = entry.replace(/\/+$/, '');
            if (_isZip((entry.split('.').pop() || '').toLowerCase())) {
                openZipViewer(cleanEntry, '', _zipOuterPath ? (_zipNestedEntry ? _zipNestedEntry + '/' + cleanEntry : cleanEntry) : _currentZipPath, _zipOuterPath ? '' : cleanEntry);
                return;
            }
            _currentZipEntry = cleanEntry;
            _loadZipContents(_currentZipPath, cleanEntry);
        }

        function _previewZipEntry(entry) {
            const cleanEntry = entry.replace(/\/+$/, '');
            const url = _zipOuterPath
                ? `/api/zip/nested/preview?zip_path=${encodeURIComponent(_zipOuterPath)}&outer_entry=${encodeURIComponent(_zipNestedEntry)}&inner_path=${encodeURIComponent(cleanEntry)}`
                : `/api/zip/preview?zip_path=${encodeURIComponent(_currentZipPath)}&entry=${encodeURIComponent(cleanEntry)}`;
            fetch(url)
                .then(r => r.json())
                .then(data => {
                    if (data.error) { showToast('错误', data.error, 'danger'); return; }
                    const ext = (data.ext || '').toLowerCase();
                    if (_TEXT_EXTS.has(ext)) {
                        const bytes = Uint8Array.from(atob(data.content), c => c.charCodeAt(0));
                        const decoded = new TextDecoder('utf-8').decode(bytes);
                        _showInlineZipPreview(entry, `<pre>${_escapeHtml(decoded)}</pre>`, data.size_str);
                    } else if (_IMAGE_EXTS.has(ext)) {
                        _showInlineZipPreview(entry, `<img src="data:${data.content_type || 'image/png'};base64,${data.content}" style="max-width:100%;max-height:60vh;object-fit:contain;border-radius:6px;" />`, data.size_str);
                    } else if (_VIDEO_EXTS.has(ext)) {
                        showToast('提示', '压缩包内视频文件请通过「下载」保存后再播放', 'info');
                    } else {
                        _downloadZipEntry(entry);
                        showToast('提示', '该类型不支持在线预览，已触发下载', 'info');
                    }
                })
                .catch(err => { showToast('错误', err.message, 'danger'); });
        }

        function _showInlineZipPreview(entry, inner, sizeStr) {
            const body = document.getElementById('zipBody');
            if (!body) return;
            const name = entry.split('/').pop();
            body.innerHTML = `
            <div class="zip-inline">
                <div class="zip-inline-bar">
                    <button class="btn zip-inline-back" id="zipBackBtn"><i class="bi bi-arrow-left"></i> 返回列表</button>
                    <span class="zip-inline-name" title="${_escAttr(name)}">${_escHtml(name)}</span>
                    <span class="zip-inline-size">${sizeStr || ''}</span>
                    <button class="btn zip-inline-dl" data-zip-entry="${_escAttr(entry)}"><i class="bi bi-download"></i> 下载</button>
                </div>
                <div class="zip-inline-stage">${inner}</div>
            </div>`;
            body.querySelector('#zipBackBtn').addEventListener('click', () => _renderZipList(_currentZipEntries, _currentZipEntry));
            body.querySelector('[data-zip-entry]').addEventListener('click', (e) => { e.stopPropagation(); _downloadZipEntry(entry); });
        }

        function _downloadZipEntry(entry) {
            const cleanEntry = entry.replace(/\/+$/, '');
            const url = _zipOuterPath
                ? `/api/zip/nested/file?zip_path=${encodeURIComponent(_zipOuterPath)}&outer_entry=${encodeURIComponent(_zipNestedEntry)}&inner_path=${encodeURIComponent(cleanEntry)}`
                : `/api/zip/file?zip_path=${encodeURIComponent(_currentZipPath)}&entry=${encodeURIComponent(cleanEntry)}`;
            window.open(url, '_blank');
        }

        function _renderZipBreadcrumb(entry) {
            const bc = document.getElementById('zipBreadcrumb');
            if (!bc) return;
            let parts = [];
            if (entry) parts = entry.split('/').filter(Boolean);
            let html = `<span class="breadcrumb-item"><i class="bi bi-file-zip"></i> <a data-zip-bc="">压缩包</a></span>`;
            let pathHtml = '';
            let cumulative = '';
            for (let i = 0; i < parts.length; i++) {
                cumulative += (cumulative ? '/' : '') + parts[i];
                const isLast = i === parts.length - 1;
                const sep = '<span class="breadcrumb-sep"><i class="bi bi-chevron-right"></i></span>';
                if (isLast) pathHtml += `${sep}<span class="breadcrumb-item active">${_escHtml(parts[i])}</span>`;
                else pathHtml += `${sep}<span class="breadcrumb-item"><a data-zip-bc="${_escAttr(cumulative)}">${_escHtml(parts[i])}</a></span>`;
            }
            if (pathHtml) html += `<span class="breadcrumb-path">${pathHtml}</span>`;
            bc.innerHTML = html;
            bc.querySelectorAll('[data-zip-bc]').forEach(a => {
                a.addEventListener('click', () => {
                    const target = a.dataset.zipBc || '';
                    _currentZipEntry = target;
                    _loadZipContents(_currentZipPath, target);
                });
            });
        }

        function _humanSize(b) {
            if (b < 1024) return b + ' B';
            if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
            if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + ' MB';
            return (b / 1024 / 1024 / 1024).toFixed(2) + ' GB';
        }

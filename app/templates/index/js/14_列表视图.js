        // ========== 列表视图 ==========
        function renderTable(items) {
            const tbody = document.getElementById('fileBody');
            if (!items || items.length === 0) {
                tbody.innerHTML = `<tr><td colspan="${selectMode ? 6 : 5}"><div class="empty-state"><i class="bi bi-inbox"></i><p class="mb-0">此目录为空</p></div></td></tr>`;
                return;
            }
            const html = _buildTableHtml(items);
            if (items.length < 200) {
                tbody.innerHTML = html;
                _bindTableEvents(tbody);
                return;
            }
            // 大列表：用临时 <table><tbody> 解析 HTML，首屏 200 行立即渲染，剩余分片追加
            // 不能用 <div>.innerHTML 解析 <tr>（浏览器会套一层 <table>，childNodes 拿不到行）
            const tmpTable = document.createElement('table');
            tmpTable.innerHTML = `<tbody>${html}</tbody>`;
            const tmpTbody = tmpTable.querySelector('tbody');
            const nodes = Array.from(tmpTbody ? tmpTbody.childNodes : []);
            tbody.innerHTML = '';
            const first = 200;
            for (let i = 0; i < first && i < nodes.length; i++) tbody.appendChild(nodes[i]);
            const rest = nodes.slice(first);
            if (rest.length === 0) { _bindTableEvents(tbody); return; }
            const chunk = 200;
            let j = 0;
            function step() {
                const end = Math.min(j + chunk, rest.length);
                for (; j < end; j++) tbody.appendChild(rest[j]);
                if (j < rest.length) setTimeout(step, 0);
                else _bindTableEvents(tbody);
            }
            setTimeout(step, 0);
        }

        function _buildTableHtml(items) {
            let html = '';
            for (const item of items) {
                const absPath = currentPath ? (currentPath + '/' + item.path).replace(/\\/g, '/').replace(/\\\\+/g, '/') : item.path;
                const isSelected = selectedPaths.has(absPath);
                const iconHtml = getFileIcon(item);
                const typeBadge = getTypeBadge(item);
                let nameHtml;
                if (item.is_dir) {
                    nameHtml = `<a class="dir-link" data-path="${absPath}">${iconHtml} ${item.name}</a>`;
                } else {
                    const ext = (item.ext || '').toLowerCase();
                    const previewable = _canPreviewPath(absPath);
                    const isZip = _isZip(ext);
                    const nameClass = (previewable || isZip) ? 'file-name file-name-clickable' : 'file-name';
                    nameHtml = `${iconHtml} <span class="${nameClass}" data-path="${absPath}" data-ext="${ext}" data-zip="${isZip}" title="${previewable || isZip ? '点击查看' : '不支持预览'}">${item.name}</span>`;
                }
                const moreBtn = '<button class="more-btn" data-action-path="' + absPath + '" data-is-dir="' + item.is_dir + '" title="更多操作"><i class="bi bi-three-dots"></i></button>';
                html += `<tr class="${isSelected ? 'selected' : ''}" data-path="${absPath}">
                <td class="checkbox-col"><input class="form-check-input item-checkbox" type="checkbox" name="files" value="${absPath}" data-path="${absPath}" ${isSelected ? 'checked' : ''} /></td>
                <td>${nameHtml}</td><td class="text-end file-size">${item.size_str || '-'}</td>
                <td>${typeBadge}</td>
                <td style="font-size:0.85rem;color:#4a5568;">${item.mtime || '-'}</td>
                <td class="text-center">${moreBtn}</td>
            </tr>`;
            }
            return html;
        }

        function _bindTableEvents(tbody) {
            tbody.querySelectorAll('.dir-link').forEach(el => {
                let _clickTimer = null;
                el.addEventListener('click', (e) => {
                    e.preventDefault();
                    if (selectMode) return;  // 多选模式：交给行级点击切换勾选，不进入文件夹
                    if (_clickTimer) clearTimeout(_clickTimer);
                    _clickTimer = setTimeout(() => { _clickTimer = null; navigateTo(el.dataset.path); }, 220);
                });
                el.addEventListener('dblclick', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const tr = el.closest('tr');
                    if (tr && tr._clickTimer) { clearTimeout(tr._clickTimer); tr._clickTimer = null; }
                    if (_clickTimer) { clearTimeout(_clickTimer); _clickTimer = null; }
                    _selectItemByPath(el.dataset.path);
                });
            });
            tbody.querySelectorAll('.file-name-clickable').forEach(el => {
                let _clickTimer = null;
                el.addEventListener('click', (e) => {
                    if (selectMode) return;  // 多选模式：交给行级点击切换勾选，不预览
                    e.stopPropagation();
                    if (_clickTimer) clearTimeout(_clickTimer);
                    _clickTimer = setTimeout(() => { _clickTimer = null; previewFile(el.dataset.path); }, 220);
                });
                el.addEventListener('dblclick', (e) => {
                    e.stopPropagation();
                    const tr = el.closest('tr');
                    if (tr && tr._clickTimer) { clearTimeout(tr._clickTimer); tr._clickTimer = null; }
                    if (_clickTimer) { clearTimeout(_clickTimer); _clickTimer = null; }
                    _selectItemByPath(el.dataset.path);
                });
            });
            tbody.querySelectorAll('.item-checkbox').forEach(el => {
                el.addEventListener('change', (e) => {
                    const path = el.dataset.path;
                    if (el.checked) selectedPaths.add(path);
                    else selectedPaths.delete(path);
                    el.closest('tr').classList.toggle('selected', el.checked);
                    updateSelectedCount();
                    updateBatchDeleteBtn();
                    updateSelectAllState();
                });
            });
            tbody.querySelectorAll('.more-btn').forEach(el => {
                el.addEventListener('click', (e) => { e.stopPropagation(); showActionMenu(el, el.dataset.actionPath, el.dataset.isDir === 'true'); });
            });
            // 多选模式：单击行内任意空白处切换勾选；双击确保勾选
            tbody.querySelectorAll('tr[data-path]').forEach(tr => {
                tr.addEventListener('click', (e) => {
                    if (!selectMode) return;
                    if (e.target.closest('button, input, .dropdown-menu')) return;
                    const cb = tr.querySelector('.item-checkbox');
                    if (!cb) return;
                    if (tr._clickTimer) clearTimeout(tr._clickTimer);
                    tr._clickTimer = setTimeout(() => { tr._clickTimer = null; _toggleItemCheckbox(cb); }, 220);
                });
                tr.addEventListener('dblclick', (e) => {
                    if (e.target.closest('button, input, .dropdown-menu')) return;
                    if (tr._clickTimer) { clearTimeout(tr._clickTimer); tr._clickTimer = null; }
                    _selectItemByPath(tr.dataset.path);
                });
            });
        }

        function updateSelectedCount() {
            document.getElementById('selectedCount').textContent = `已选 ${selectedPaths.size} 个`;
        }
        function updateBatchDeleteBtn() {
            // 顶栏「删除选中/压缩选中」按钮已移除，多选操作统一走底部多选操作栏
        }
        function updateSelectAllState() {
            const checkboxes = document.querySelectorAll('.item-checkbox:not(.parent-cb)');
            const checked = document.querySelectorAll('.item-checkbox:not(.parent-cb):checked');
            const selectAll = document.getElementById('selectAll');
            if (checkboxes.length === 0) { selectAll.checked = false; selectAll.indeterminate = false; return; }
            if (checked.length === checkboxes.length) { selectAll.checked = true; selectAll.indeterminate = false; }
            else if (checked.length === 0) { selectAll.checked = false; selectAll.indeterminate = false; }
            else { selectAll.checked = false; selectAll.indeterminate = true; }
        }

        // ========== 编辑器查找/替换 ==========
        let _searchMarkers = [];
        let _searchCurrentMarker = null;
        let _searchCurrentIdx = 0;
        let _searchTotalCount = 0;
        let _pendingSearchText = '';
        let _readyPollTimer = null;

        function _editorReady() {
            return _editorInstance && typeof _editorInstance.getValue === 'function';
        }
        function _editorReadyPoll() {
            if (_readyPollTimer) return;
            let tries = 0;
            _readyPollTimer = setInterval(() => {
                tries++;
                if (_editorReady() && _editorInstance.getValue().length > 0) {
                    clearInterval(_readyPollTimer);
                    _readyPollTimer = null;
                    if (_pendingSearchText) _doFind(_pendingSearchText);
                } else if (tries > 50) {
                    clearInterval(_readyPollTimer);
                    _readyPollTimer = null;
                }
            }, 100);
        }

        function _clearSearchHighlights() {
            for (const s of _searchMarkers) { try { if (s.marker) s.marker.clear(); } catch (e) { } }
            _searchMarkers = [];
            _searchCurrentMarker = null;
            _searchCurrentIdx = 0;
            _searchTotalCount = 0;
        }

        function _buildSearchRegex(text, wholeWord) {
            if (!text) return null;
            const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const pattern = wholeWord ? '\\b' + escaped + '\\b' : escaped;
            const flags = 'g';
            return new RegExp(pattern, flags);
        }

        function _doFind(text) {
            // 编辑器未就绪：记录待搜索，轮询重试
            if (!_editorReady()) {
                _pendingSearchText = text;
                _editorReadyPoll();
                _updateSearchInfo('加载...', 0);
                return;
            }
            const editor = _editorInstance;
            _clearSearchHighlights();
            if (!text || !text.trim()) {
                _updateSearchInfo('', 0);
                return;
            }
            _pendingSearchText = text;

            const content = editor.getValue();
            // 内容为空（等待文件加载），记录待搜索并轮询
            if (!content || content.length === 0) {
                _updateSearchInfo('等待内容...', 0);
                _editorReadyPoll();
                return;
            }

            const matchCase = document.getElementById('edMatchCase').checked;
            const matchWhole = document.getElementById('edWholeWord').checked;

            // 手动实现搜索：getValue + posFromIndex + markText
            const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const pattern = matchWhole ? '\\b' + escaped + '\\b' : escaped;
            const flags = 'g' + (matchCase ? '' : 'i');
            const regex = new RegExp(pattern, flags);
            const matches = [];
            let m;
            while ((m = regex.exec(content)) !== null) {
                matches.push({ fromIdx: m.index, toIdx: m.index + m[0].length });
            }

            if (matches.length === 0) {
                _updateSearchInfo('未找到', 0);
                return;
            }

            // 高亮所有匹配
            for (const match of matches) {
                const from = editor.posFromIndex(match.fromIdx);
                const to = editor.posFromIndex(match.toIdx);
                const marker = editor.markText(from, to, { className: 'cm-search-match' });
                _searchMarkers.push({ from, to, marker });
            }

            _searchTotalCount = matches.length;
            _searchCurrentIdx = 1;
            _searchCurrentMarker = _searchMarkers[0];

            // 第一个为当前光标高亮（橙色）
            const first = _searchMarkers[0];
            first.marker.clear();
            _searchMarkers[0] = { from: first.from, to: first.to, marker: editor.markText(first.from, first.to, { className: 'cm-search-match-cursor' }) };
            editor.scrollIntoView(first.from, 50);
            _updateSearchInfo('1/' + matches.length, 1);
        }

        function _findInEditor(forward) {
            const si = document.getElementById('edSearchInput');
            if (!_editorReady() || !si || !si.value) return;

            // 如果还没搜索过（或内容为空），先执行搜索
            if (_searchMarkers.length === 0) {
                _doFind(si.value);
                if (_searchMarkers.length === 0) return;
            }

            const editor = _editorInstance;

            // 恢复上一个当前为普通高亮
            if (_searchCurrentIdx) {
                const prev = _searchMarkers[_searchCurrentIdx - 1];
                if (prev) {
                    prev.marker.clear();
                    _searchMarkers[_searchCurrentIdx - 1] = { from: prev.from, to: prev.to, marker: editor.markText(prev.from, prev.to, { className: 'cm-search-match' }) };
                }
            }

            _searchCurrentIdx += (forward ? 1 : -1);
            if (_searchCurrentIdx > _searchMarkers.length) _searchCurrentIdx = 1;
            if (_searchCurrentIdx < 1) _searchCurrentIdx = _searchMarkers.length;

            const cur = _searchMarkers[_searchCurrentIdx - 1];
            if (!cur) return;
            cur.marker.clear();
            _searchMarkers[_searchCurrentIdx - 1] = { from: cur.from, to: cur.to, marker: editor.markText(cur.from, cur.to, { className: 'cm-search-match-cursor' }) };
            _searchCurrentMarker = _searchMarkers[_searchCurrentIdx - 1];
            editor.scrollIntoView(_searchCurrentMarker.from, 50);
            _updateSearchInfo(_searchCurrentIdx + '/' + _searchMarkers.length, _searchCurrentIdx);
        }

        function _replaceInEditor(replaceAll) {
            if (!_editorReady()) { showToast('提示', '编辑器未就绪', 'warning'); return; }
            const editor = _editorInstance;
            const searchInput = document.getElementById('edSearchInput');
            const replaceInput = document.getElementById('edReplaceInput');
            if (!editor || !searchInput.value) { showToast('提示', '请输入查找内容', 'warning'); searchInput.focus(); return; }

            const matchCase = document.getElementById('edMatchCase').checked;
            const matchWhole = document.getElementById('edWholeWord').checked;
            const findText = searchInput.value;
            const replaceText = replaceInput.value;

            if (replaceAll) {
                const escaped = findText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const pattern = matchWhole ? '\\b' + escaped + '\\b' : escaped;
                const flags = 'g' + (matchCase ? '' : 'i');
                const regex = new RegExp(pattern, flags);
                const newContent = editor.getValue().replace(regex, replaceText);
                editor.setValue(newContent);
                if (_editorIsMarkdown) _updateEditorPreview();
                _doFind(findText);
                _updateSearchInfo('全部替换完成', _searchMarkers.length);
                showToast('成功', '已替换所有匹配项', 'success');
            } else {
                if (_searchMarkers.length === 0) { showToast('提示', '未找到匹配', 'warning'); searchInput.focus(); return; }
                const cur = _searchMarkers[_searchCurrentIdx - 1];
                if (!cur) return;
                editor.replaceRange(replaceText, cur.from, cur.to);
                _doFind(findText);
                if (_editorIsMarkdown) _updateEditorPreview();
            }
        }

        function _replaceAllWholeWord(text, findText, replaceText, matchCase) {
            const escaped = findText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const flags = 'g' + (matchCase ? '' : 'i');
            const regex = new RegExp('\\b' + escaped + '\\b', flags);
            return text.replace(regex, replaceText);
        }

        function _updateSearchInfo(text, current) {
            const el = document.getElementById('edSearchInfo');
            if (!el) return;
            el.textContent = text;
            el.className = 'ed-search-info' + (current === 0 ? ' error' : '');
        }

        function _openSearchPanel(panel, showReplace) {
            if (!panel) return;
            panel.classList.add('visible');
            const searchInput = document.getElementById('edSearchInput');
            const infoEl = document.getElementById('edSearchInfo');
            if (infoEl) infoEl.textContent = '--';

            if (_editorReady()) {
                const sel = _editorInstance.getSelection();
                if (sel) { searchInput.value = sel; searchInput.select(); }
            }
            searchInput.focus();

            if (showReplace) {
                document.getElementById('edReplaceRow').style.display = 'flex';
                document.getElementById('edReplaceInput').focus();
            }

            if (searchInput.value) {
                if (_editorReady() && _editorInstance.getValue().length > 0) {
                    _doFind(searchInput.value);
                } else {
                    _pendingSearchText = searchInput.value;
                    _updateSearchInfo('等待内容...', 0);
                    _editorReadyPoll();
                }
            }
        }

        function _closeSearchPanel(panel) {
            if (!panel) return;
            panel.classList.remove('visible');
            _clearSearchHighlights();
            if (_editorInstance) _editorInstance.focus();
        }
        function _goToLine() {
            const editor = _editorInstance;
            if (!editor) return;
            const total = editor.lineCount();
            const overlay = document.createElement('div');
            overlay.className = 'custom-modal-overlay';
            overlay.innerHTML = `
            <div class="custom-modal" style="max-width:320px;padding:20px 24px;">
                <div class="modal-title"><i class="bi bi-arrow-down-up"></i> 跳转到行</div>
                <div class="modal-body">
                    <input type="number" class="form-control" id="edGoLineInput" min="1" max="${total}" style="font-family:monospace;font-size:0.85rem;" />
                    <span style="font-size:0.72rem;color:#94a3b8;margin-top:4px;display:block;">共 ${total} 行</span>
                </div>
                <div class="modal-footer">
                    <button class="btn btn-cancel" id="edGoCancel">取消</button>
                    <button class="btn btn-ok" id="edGoOk">跳转</button>
                </div>
            </div>
        `;
            document.body.appendChild(overlay);
            const input = overlay.querySelector('#edGoLineInput');
            input.focus(); input.select();
            const jump = () => {
                const line = parseInt(input.value, 10);
                if (line >= 1 && line <= total) {
                    editor.setCursor({ line: line - 1, ch: 0 });
                    editor.scrollIntoView({ line: line - 1, ch: 0 }, 80);
                    overlay.remove();
                }
            };
            overlay.querySelector('#edGoOk').addEventListener('click', jump);
            overlay.querySelector('#edGoCancel').addEventListener('click', () => overlay.remove());
            overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
            input.addEventListener('keydown', (e) => { if (e.key === 'Enter') jump(); if (e.key === 'Escape') overlay.remove(); });
        }

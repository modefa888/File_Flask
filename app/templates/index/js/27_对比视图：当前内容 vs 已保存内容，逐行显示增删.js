        // ===== 对比视图：当前内容 vs 已保存内容，逐行显示增删 =====
        let _editorOriginal = '';   // 最近一次加载/保存的内容基准
        function _computeLineDiff(aText, bText) {
            const A = aText.split('\n'), B = bText.split('\n');
            const n = A.length, m = B.length;
            if ((n + 1) * (m + 1) > 6000000) return null;   // 过大时放弃精细对比
            const W = m + 1;
            const dp = new Int32Array((n + 1) * W);
            for (let i = n - 1; i >= 0; i--) {
                for (let j = m - 1; j >= 0; j--) {
                    dp[i * W + j] = A[i] === B[j]
                        ? dp[(i + 1) * W + j + 1] + 1
                        : Math.max(dp[(i + 1) * W + j], dp[i * W + j + 1]);
                }
            }
            const ops = [];
            let i = 0, j = 0;
            while (i < n && j < m) {
                if (A[i] === B[j]) { ops.push({ t: '=', s: A[i] }); i++; j++; }
                else if (dp[(i + 1) * W + j] >= dp[i * W + j + 1]) { ops.push({ t: '-', s: A[i] }); i++; }
                else { ops.push({ t: '+', s: B[j] }); j++; }
            }
            while (i < n) ops.push({ t: '-', s: A[i++] });
            while (j < m) ops.push({ t: '+', s: B[j++] });
            return ops;
        }
        function _updateDiffBadge() {
            const badge = document.getElementById('edDiffBadge');
            if (!badge) return;
            const ops = _computeLineDiff(_editorOriginal, _editorText());
            if (!ops) { badge.style.display = 'none'; return; }
            let addN = 0, delN = 0;
            ops.forEach(o => { if (o.t === '+') addN++; else if (o.t === '-') delN++; });
            if (addN === 0 && delN === 0) { badge.style.display = 'none'; return; }
            badge.innerHTML = '<span style="color:#86efac;">+' + addN + '</span> <span style="color:#fca5a5;">-' + delN + '</span>';
            badge.style.display = 'inline-block';
        }
        function _toggleDiffView() {
            const panel = document.getElementById('edDiffPanel');
            if (!panel) return;
            if (panel.style.display !== 'none') { panel.style.display = 'none'; return; }
            _renderDiffView(panel);
        }
        function _renderDiffView(panel) {
            const body = panel.querySelector('.ed-diff-body');
            const summary = document.getElementById('edDiffSummary');
            const cur = _editorText();
            const ops = _computeLineDiff(_editorOriginal, cur);
            if (!ops) {
                summary.innerHTML = '文件过大，无法精细对比';
                body.innerHTML = '<div class="ed-diff-gap" style="padding:14px;">文件过大（超过对比行数上限），请直接编辑或保存后查看。</div>';
                panel.style.display = 'flex';
                return;
            }
            let addN = 0, delN = 0;
            ops.forEach(o => { if (o.t === '+') addN++; else if (o.t === '-') delN++; });
            if (addN === 0 && delN === 0) {
                summary.innerHTML = '与已保存内容 <b>完全一致，无修改</b>';
                body.innerHTML = '<div class="ed-diff-gap" style="padding:14px;">✓ 当前内容与上次保存/加载时一致，没有新增或删除的行。</div>';
                panel.style.display = 'flex';
                return;
            }
            summary.innerHTML = '与已保存内容相比：<span class="ed-diff-add">+ ' + addN + ' 行新增</span>　<span class="ed-diff-del">- ' + delN + ' 行删除</span>';
            // 折叠连续相同的行：只保留变更前后各 3 行上下文
            const changed = ops.map(o => o.t !== '=');
            const keep = new Array(ops.length).fill(false);
            ops.forEach((o, k) => {
                if (!changed[k]) return;
                for (let x = Math.max(0, k - 3); x <= Math.min(ops.length - 1, k + 3); x++) keep[x] = true;
            });
            let html = '', i = 0;
            const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            while (i < ops.length) {
                if (!keep[i]) {
                    let s = i;
                    while (i < ops.length && !keep[i]) i++;
                    html += '<div class="ed-diff-gap">··· 中间省略 ' + (i - s) + ' 行相同内容 ···</div>';
                    continue;
                }
                const o = ops[i];
                const no = o.t === '+' ? '' : String(i + 1);
                const cls = o.t === '=' ? 'same' : o.t === '+' ? 'add' : 'del';
                const mark = o.t === '+' ? '+' : o.t === '-' ? '-' : ' ';
                html += '<div class="ed-diff-line ' + cls + '"><span class="dl-mark">' + mark + '</span><span>' + (esc(o.s) || ' ') + '</span></div>';
                i++;
            }
            body.innerHTML = html;
            panel.style.display = 'flex';
        }

        function _getEditorMode(ext) {
            const map = {
                'js': 'javascript', 'ts': 'javascript', 'jsx': 'javascript', 'tsx': 'javascript',
                'html': 'htmlmixed', 'htm': 'htmlmixed', 'css': 'css', 'scss': 'css', 'less': 'css',
                'json': 'javascript', 'xml': 'xml', 'svg': 'xml',
                'py': 'python', 'rb': 'ruby', 'lua': 'lua', 'sql': 'sql', 'go': 'go',
                'rs': 'clike', 'c': 'clike', 'cpp': 'clike', 'h': 'clike', 'java': 'clike', 'cs': 'clike',
                'php': 'php', 'md': 'markdown', 'yml': 'yaml', 'yaml': 'yaml',
                'ini': 'ini', 'cfg': 'ini', 'conf': 'ini',
                'properties': 'properties', 'sh': 'shell', 'bash': 'shell', 'bat': 'shell', 'ps1': 'shell',
                'txt': 'text', 'log': 'text', 'conf': 'text', 'env': 'text',
            };
            return map[ext] || 'text/plain';
        }

        function _renderMarkdown(text) {
            // 简易 Markdown 渲染器
            let html = text;
            // 代码块
            html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
                const langAttr = lang ? ` class="language-${lang}"` : '';
                return `<pre><code${langAttr}>${_escHtml(code.replace(/\n$/, ''))}</code></pre>`;
            });
            // 行内代码
            html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
            // 标题
            html = html.replace(/^######\s+(.+)$/gm, '<h6>$1</h6>');
            html = html.replace(/^#####\s+(.+)$/gm, '<h5>$1</h5>');
            html = html.replace(/^####\s+(.+)$/gm, '<h4>$1</h4>');
            html = html.replace(/^###\s+(.+)$/gm, '<h3>$1</h3>');
            html = html.replace(/^##\s+(.+)$/gm, '<h2>$1</h2>');
            html = html.replace(/^#\s+(.+)$/gm, '<h1>$1</h1>');
            // 粗体和斜体
            html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
            html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
            // 引用
            html = html.replace(/^>\s+(.+)$/gm, '<blockquote>$1</blockquote>');
            // 分割线
            html = html.replace(/^---$/gm, '<hr>');
            // 图片
            html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1">');
            // 链接
            html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
            // 无序列表
            html = html.replace(/^(\s*)[-*+]\s+(.+)$/gm, (_, indent, content) => {
                return `<li>${content}</li>`;
            });
            // 有序列表
            html = html.replace(/^(\s*)\d+\.\s+(.+)$/gm, (_, indent, content) => {
                return `<li>${content}</li>`;
            });
            // 包裹连续的 li 到 ul
            html = html.replace(/((?:<li>.+<\/li>\n?)+)/g, '<ul>$1</ul>');
            // 段落：连续非空白行
            html = html.replace(/^(?!<[uh]|<hr|<h|<pre|<blockquote|<img|<a|<strong|<em|<code)(.+)$/gm, '<p>$1</p>');
            // 任务列表
            html = html.replace(/<li>\[(\s|x)\]\s+(.+)<\/li>/g, '<li class="task-list-item"><input type="checkbox" disabled$1checked>$2</li>');
            return html;
        }

        function _updateEditorPreview() {
            if (!_editorIsMarkdown) return;
            const previewEl = document.getElementById('editorPreviewRender');
            const editor = _editorInstance;
            if (!previewEl || !editor) return;
            if (_editorPreviewTimer) clearTimeout(_editorPreviewTimer);
            _editorPreviewTimer = setTimeout(() => {
                const text = editor.getValue();
                previewEl.innerHTML = _renderMarkdown(text);
            }, 300);
        }

        function openEditor(filePath, isNewFile) {
            const container = document.getElementById('editorContainer');
            const ext = (filePath.split('.').pop() || '').toLowerCase();
            _editorIsMarkdown = ext === 'md';
            _editorFilePath = filePath;
            const fileName = filePath.split('/').pop() || (filePath.split('\\').pop() || '未命名');
            const displayName = isNewFile ? (fileName + '（新文件）') : fileName;
            const saveBtnId = isNewFile ? 'edSaveBtnNew' : 'edSaveBtn';

            container.innerHTML = `
            <div class="editor-overlay">
                <div class="editor-modal">
                    <div class="editor-header">
                        <div class="ed-title">
                            <div class="ed-name-part">
                                <i class="bi bi-pencil-square"></i>
                                <span class="ed-filename">${displayName}</span>
                            </div>
                            <div class="ed-actions">
                                <button class="btn" id="edDiffBtn" style="padding:5px 10px;border-radius:7px;font-size:0.78rem;border:none;cursor:pointer;background:#475569;color:#e2e8f0;" title="对比当前内容与已保存内容"><i class="bi bi-file-diff"></i> 对比 <span id="edDiffBadge" style="display:none;margin-left:2px;padding:0 6px;border-radius:9px;background:rgba(15,23,42,0.55);font-size:0.66rem;font-weight:700;line-height:15px;vertical-align:middle;"></span></button>
                                <button class="btn" id="edStyleBtn" style="padding:5px 10px;border-radius:7px;font-size:0.78rem;border:none;cursor:pointer;background:#475569;color:#e2e8f0;"><i class="bi bi-palette"></i> 样式</button>
                                <button class="btn" id="edSearchBtn" style="padding:5px 10px;border-radius:7px;font-size:0.78rem;border:none;cursor:pointer;background:#475569;color:#e2e8f0;"><i class="bi bi-search"></i> 查找</button>
                                <button class="btn ed-save-btn" id="${saveBtnId}" disabled title="修改内容后才可保存"><i class="bi bi-check-lg"></i> 保存</button>
                                <button class="btn ed-close-btn" id="edCloseBtn"><i class="bi bi-x-lg"></i></button>
                            </div>
                        <div class="ed-style-menu" id="edStyleMenu" style="display:none;">
                            <div class="esm-row"><span>主题</span><select id="edThemeSelect">${_ED_THEMES.map(t => `<option value="${t.key}">${t.label}</option>`).join('')}</select></div>
                            <div class="esm-row"><span>字号</span><select id="edFontSelect">${[12, 13, 14, 15, 16, 18, 20].map(s => `<option value="${s}">${s} px</option>`).join('')}</select></div>
                        </div>
                        </div>
                        <span class="ed-path">${filePath}</span>
                    </div>
                    <div class="editor-body">
                                                 ${_editorIsMarkdown ? `
                             <div class="editor-panel editor-full">
                                 <div class="ed-search-panel" id="edSearchPanel">
                                     <div class="ed-search-row">
                                         <span class="ed-search-label"><i class="bi bi-search"></i></span>
                                         <input type="text" class="ed-search-input" id="edSearchInput" placeholder="查找..." />
                                         <span class="ed-search-info" id="edSearchInfo">--</span>
                                         <button class="ed-search-btn" id="edPrevBtn" title="上一个"><i class="bi bi-chevron-up"></i></button>
                                         <button class="ed-search-btn" id="edNextBtn" title="下一个"><i class="bi bi-chevron-down"></i></button>
                                         <button class="ed-search-btn" id="edToggleReplaceBtn" title="替换"><i class="bi bi-arrow-left-right"></i></button>
                                         <button class="ed-search-btn danger" id="edCloseSearchBtn" title="关闭"><i class="bi bi-x-lg"></i></button>
                                     </div>
                                     <div class="ed-search-row" id="edReplaceRow" style="display:none;">
                                         <span class="ed-search-label"><i class="bi bi-pencil"></i></span>
                                         <input type="text" class="ed-search-input" id="edReplaceInput" placeholder="替换为..." />
                                         <button class="ed-search-btn" id="edReplaceOneBtn"><i class="bi bi-pencil"></i> 替换</button>
                                         <button class="ed-search-btn" id="edReplaceAllBtn"><i class="bi bi-pencil-square"></i> 全部</button>
                                     </div>
                                     <div class="ed-search-checks">
                                         <label><input type="checkbox" id="edMatchCase" /> 区分大小写</label>
                                         <label><input type="checkbox" id="edWholeWord" /> 全字匹配</label>
                                     </div>
                                 </div>
                                 <div class="editor-panel-label"><i class="bi bi-code-slash"></i> Markdown 编辑器（SimpleMDE）</div>
                                 <div class="ed-md-wrapper" style="flex:1;min-height:0;display:flex;flex-direction:column;">
                                     <textarea id="editorCodeMirror" class="ed-md-textarea" style="width:100%;height:100%;"></textarea>
                                 </div>
                             </div>
                         ` : `
                            <div class="editor-panel editor-full">
                                <div class="ed-search-panel" id="edSearchPanel">
                                    <div class="ed-search-row">
                                        <span class="ed-search-label"><i class="bi bi-search"></i></span>
                                        <input type="text" class="ed-search-input" id="edSearchInput" placeholder="查找..." />
                                        <span class="ed-search-info" id="edSearchInfo">--</span>
                                        <button class="ed-search-btn" id="edPrevBtn" title="上一个"><i class="bi bi-chevron-up"></i></button>
                                        <button class="ed-search-btn" id="edNextBtn" title="下一个"><i class="bi bi-chevron-down"></i></button>
                                        <button class="ed-search-btn" id="edToggleReplaceBtn" title="替换"><i class="bi bi-arrow-left-right"></i></button>
                                        <button class="ed-search-btn danger" id="edCloseSearchBtn" title="关闭"><i class="bi bi-x-lg"></i></button>
                                    </div>
                                    <div class="ed-search-row" id="edReplaceRow" style="display:none;">
                                        <span class="ed-search-label"><i class="bi bi-pencil"></i></span>
                                        <input type="text" class="ed-search-input" id="edReplaceInput" placeholder="替换为..." />
                                        <button class="ed-search-btn" id="edReplaceOneBtn"><i class="bi bi-pencil"></i> 替换</button>
                                        <button class="ed-search-btn" id="edReplaceAllBtn"><i class="bi bi-pencil-square"></i> 全部</button>
                                    </div>
                                    <div class="ed-search-checks">
                                        <label><input type="checkbox" id="edMatchCase" /> 区分大小写</label>
                                        <label><input type="checkbox" id="edWholeWord" /> 全字匹配</label>
                                    </div>
                                </div>
                                <div class="editor-panel-label"><i class="bi bi-code-slash"></i> 编辑 ${ext ? '.' + ext : '文件'}</div>
                                <div id="editorCodeMirror" style="flex:1;min-height:0;"></div>
                            </div>
                        `}
                        <div class="ed-diff-panel" id="edDiffPanel" style="display:none;">
                            <div class="ed-diff-header">
                                <span id="edDiffSummary"></span>
                                <button id="edDiffCloseBtn"><i class="bi bi-arrow-left"></i> 返回编辑</button>
                            </div>
                            <div class="ed-diff-body"></div>
                        </div>
                    </div>
                    <div class="editor-statusbar">
                        <span id="edStatusDot">🟢</span>
                        <span id="edStatus">加载中...</span>
                        <span class="esb-sep">|</span>
                        <span class="esb-hint">修改后点「对比」查看与已保存内容的增删差异</span>
                    </div>
                </div>
            </div>
        `;

            container.querySelector('.editor-overlay').addEventListener('click', (e) => {
                // 编辑状态下不允许点遮罩/外部关闭，只能通过「保存」或「×」退出
                if (!e.target.closest('.ed-style-menu')) {
                    const m = document.getElementById('edStyleMenu');
                    if (m) m.style.display = 'none';
                }
            });
            document.getElementById('edCloseBtn').addEventListener('click', closeEditor);

            // 样式菜单（主题/字号）
            const styleMenu = document.getElementById('edStyleMenu');
            const themeSel = document.getElementById('edThemeSelect');
            const fontSel = document.getElementById('edFontSelect');
            themeSel.value = _editorTheme();
            fontSel.value = String(_editorFontSize());
            document.getElementById('edStyleBtn').addEventListener('click', (e) => {
                e.stopPropagation();
                styleMenu.style.display = styleMenu.style.display === 'none' ? 'flex' : 'none';
            });
            styleMenu.addEventListener('click', (e) => e.stopPropagation());
            themeSel.addEventListener('change', () => {
                localStorage.setItem('edTheme', themeSel.value);
                _applyEditorAppearance();
            });
            fontSel.addEventListener('change', () => {
                localStorage.setItem('edFontSize', fontSel.value);
                _applyEditorAppearance();
            });
            // 对比视图
            document.getElementById('edDiffBtn').addEventListener('click', (e) => { e.stopPropagation(); _toggleDiffView(); });
            document.getElementById('edDiffCloseBtn').addEventListener('click', () => {
                const dp = document.getElementById('edDiffPanel');
                if (dp) dp.style.display = 'none';
            });

            // 查找面板事件绑定
            const searchPanel = document.getElementById('edSearchPanel');
            const searchInput = document.getElementById('edSearchInput');
            const replaceInput = document.getElementById('edReplaceInput');
            const _searchVisible = () => searchPanel.classList.contains('visible');

            document.getElementById('edSearchBtn').addEventListener('click', () => _openSearchPanel(searchPanel));
            document.getElementById('edCloseSearchBtn').addEventListener('click', () => _closeSearchPanel(searchPanel));
            document.getElementById('edPrevBtn').addEventListener('click', () => { _findInEditor(false); searchInput.focus(); });
            document.getElementById('edNextBtn').addEventListener('click', () => { _findInEditor(true); searchInput.focus(); });
            document.getElementById('edToggleReplaceBtn').addEventListener('click', () => {
                const row = document.getElementById('edReplaceRow');
                const v = row.style.display !== 'none';
                row.style.display = v ? 'none' : 'flex';
                if (!v) replaceInput.focus();
            });
            document.getElementById('edReplaceOneBtn').addEventListener('click', () => { _replaceInEditor(false); searchInput.focus(); });
            document.getElementById('edReplaceAllBtn').addEventListener('click', () => { _replaceInEditor(true); searchInput.focus(); });
            searchInput.addEventListener('input', () => {
                const val = searchInput.value;
                if (!val) { _clearSearchHighlights(); _updateSearchInfo('', 0); return; }
                if (_editorReady() && _editorInstance.getValue().length > 0) {
                    _doFind(val);
                } else {
                    _pendingSearchText = val;
                    _updateSearchInfo('等待内容...', 0);
                    _editorReadyPoll();
                }
            });
            searchInput.addEventListener('keydown', (e) => {
                if (e.key === 'ArrowDown') { _findInEditor(true); e.preventDefault(); }
                else if (e.key === 'ArrowUp') { _findInEditor(false); e.preventDefault(); }
                else if (e.key === 'Enter') { _findInEditor(!e.shiftKey); e.preventDefault(); }
                else if (e.key === 'Escape') { _closeSearchPanel(searchPanel); }
            });
            replaceInput.addEventListener('keydown', (e) => {
                if (e.key === 'ArrowDown') { _findInEditor(true); e.preventDefault(); }
                else if (e.key === 'ArrowUp') { _findInEditor(false); e.preventDefault(); }
                else if (e.key === 'Enter' && e.ctrlKey && !e.shiftKey) { _replaceInEditor(false); e.preventDefault(); }
                else if (e.key === 'Enter' && e.ctrlKey && e.shiftKey) { _replaceInEditor(true); e.preventDefault(); }
                else if (e.key === 'Escape') { _closeSearchPanel(searchPanel); }
            });

            // 全局快捷键（编辑器内时监听）
            document.addEventListener('keydown', function onEdKey(e) {
                const isSearchFocused = document.activeElement === searchInput || document.activeElement === replaceInput;

                if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                    e.preventDefault(); _saveEditorContent();
                } else if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
                    e.preventDefault(); _openSearchPanel(searchPanel);
                } else if ((e.ctrlKey || e.metaKey) && e.key === 'h') {
                    e.preventDefault(); _openSearchPanel(searchPanel, true);
                } else if (e.key === 'Escape') {
                    // Esc 只用于关闭查找面板，不退出编辑器（只能通过「保存」或「×」退出）
                    if (_searchVisible()) _closeSearchPanel(searchPanel);
                } else if ((e.ctrlKey || e.metaKey) && e.key === 'l') {
                    e.preventDefault(); _goToLine();
                } else if (isSearchFocused && _searchMarkers.length > 0) {
                    // 仅搜索框有焦点时拦截方向键
                    if (e.key === 'ArrowDown') { _findInEditor(true); e.preventDefault(); }
                    else if (e.key === 'ArrowUp') { _findInEditor(false); e.preventDefault(); }
                    else if (e.key === 'Enter') {
                        _findInEditor(e.shiftKey ? false : true); e.preventDefault();
                    }
                }
            });

            // 初始化 CodeMirror
            const mode = _getEditorMode(ext);
            const editorEl = document.getElementById('editorCodeMirror');

            if (isNewFile) {
                // 新文件：空编辑器，立即初始化（对比基准为空）
                _editorOriginal = '';
                _initCodeMirror(editorEl, '', mode);
            } else {
                // 已有文件：立即初始化空编辑器，用户可立即操作
                _initCodeMirror(editorEl, '', mode);
                // 异步加载内容后更新
                fetch(`/api/preview?path=${encodeURIComponent(filePath)}`)
                    .then(r => r.json())
                    .then(data => {
                        let content = '';
                        if (data.error) {
                            showToast('错误', '无法加载文件: ' + data.error, 'danger');
                            closeEditor();
                            return;
                        }
                        if (data.type === 'text') {
                            const bytes = Uint8Array.from(atob(data.content), c => c.charCodeAt(0));
                            content = new TextDecoder('utf-8').decode(bytes);
                        } else {
                            showToast('提示', '该文件类型不支持文本编辑', 'warning');
                            closeEditor();
                            return;
                        }
                        if (_simpleMDE) {
                            _simpleMDE.value(content);
                        } else if (_editorInstance) {
                            _editorInstance.setValue(content);
                        }
                        // 内容加载完成：重置修改标记，显示字符数/大小/未修改
                        _editorOriginal = content;
                        _edModified = false;
                        _updateDiffBadge();
                        if (_edDirtyTimer) { clearTimeout(_edDirtyTimer); _edDirtyTimer = null; }
                        _setEdStatus('unmodified');
                        if (_editorIsMarkdown && _simpleMDE) {
                            // SimpleMDE 自动渲染预览
                        } else if (_editorIsMarkdown && _editorInstance) {
                            _updateEditorPreview();
                        }
                        // 文件内容已加载，触发待搜索
                        if (_pendingSearchText && _editorInstance && _editorInstance.getValue().length > 0) {
                            _doFind(_pendingSearchText);
                            _pendingSearchText = '';
                            if (_readyPollTimer) { clearInterval(_readyPollTimer); _readyPollTimer = null; }
                        }
                    })
                    .catch(() => {
                        showToast('错误', '文件加载失败', 'danger');
                        closeEditor();
                    });
            }

            document.getElementById(saveBtnId).addEventListener('click', () => _confirmSave(isNewFile));
        }

        function _initCodeMirror(element, initialContent, mode) {
            try {
                if (_editorInstance) {
                    _editorInstance.toTextArea && _editorInstance.toTextArea();
                    _editorInstance = null;
                }
                if (_simpleMDE) {
                    try { _simpleMDE.toTextArea(); } catch (e) { }
                    _simpleMDE = null;
                }
                if (typeof CodeMirror === 'undefined') {
                    element.innerHTML = '<div class="cm-placeholder"><i class="bi bi-hourglass-split"></i> CodeMirror 未加载</div>';
                    return;
                }
                if (_editorIsMarkdown) {
                    // Markdown: use SimpleMDE if loaded, otherwise fall back to plain CodeMirror
                    if (typeof SimpleMDE !== 'undefined') {
                        _simpleMDE = new SimpleMDE({
                            element: element,
                            spellChecker: false,
                            status: false,
                            autosave: { enabled: false },
                            placeholder: '在此输入 Markdown 内容...',
                            toolbar: [
                                'bold', 'italic', 'heading', '|',
                                'quote', 'unordered-list', 'ordered-list', '|',
                                'link', 'image', 'code', 'table', 'hr', '|',
                                'preview', 'side-by-side', 'fullscreen', '|',
                                'guide'
                            ]
                        });
                        _editorInstance = _simpleMDE.codemirror;
                        if (_editorInstance) _applyEditorAppearance();
                        if (_editorInstance) _editorInstance.on('change', _edMarkDirty);
                        if (_pendingSearchText && _editorInstance.getValue().length > 0) {
                            _doFind(_pendingSearchText);
                            _pendingSearchText = '';
                            if (_readyPollTimer) { clearInterval(_readyPollTimer); _readyPollTimer = null; }
                        }
                        return;
                    } else {
                        // SimpleMDE 尚未加载，用普通 CodeMirror 占位
                        // 创建 wrapper div 供 CodeMirror 使用
                        const wrapper = document.createElement('div');
                        wrapper.style.cssText = 'width:100%;height:100%;position:absolute;top:0;left:0;';
                        element.style.display = 'none';
                        element.parentNode.insertBefore(wrapper, element);
                        _editorInstance = CodeMirror(wrapper, {
                            value: initialContent,
                            mode: 'markdown',
                            theme: _editorTheme(),
                            lineNumbers: true,
                            autoRefresh: true,
                            lineWrapping: true,
                            tabSize: 4,
                            indentUnit: 4,
                        });
                        if (!window._simpleMDEReady) {
                            window._simpleMDEReady = () => {
                                if (_editorInstance && _editorIsMarkdown) {
                                    try {
                                        if (_editorInstance) { _editorInstance.toTextArea && _editorInstance.toTextArea(); _editorInstance = null; }
                                        _simpleMDE = new SimpleMDE({
                                            element: element,
                                            spellChecker: false,
                                            status: false,
                                            autosave: { enabled: false },
                                            toolbar: [
                                                'bold', 'italic', 'heading', '|',
                                                'quote', 'unordered-list', 'ordered-list', '|',
                                                'link', 'image', 'code', 'table', 'hr', '|',
                                                'preview', 'side-by-side', 'fullscreen', '|',
                                                'guide'
                                            ]
                                        });
                                        _editorInstance = _simpleMDE.codemirror;
                                        if (_editorInstance) _applyEditorAppearance();
                                        if (_editorInstance) _editorInstance.on('change', _edMarkDirty);
                                        wrapper.remove();
                                    } catch (e) { console.error('SimpleMDE upgrade failed:', e); }
                                }
                            };
                            window.addEventListener('simplemde_loaded', () => {
                                if (window._simpleMDEReady) window._simpleMDEReady();
                            }, { once: true });
                        }
                        return;
                    }
                }
                _editorInstance = CodeMirror(element, {
                    value: initialContent,
                    mode: mode,
                    theme: _editorTheme(),
                    lineNumbers: true,
                    autoRefresh: true,
                    lineWrapping: true,
                    tabSize: 4,
                    indentUnit: 4,
                });
                _applyEditorAppearance();
                if (_editorIsMarkdown) {
                    _editorInstance.on('change', () => {
                        _edMarkDirty();
                        _updateEditorPreview();
                        if (_pendingSearchText) {
                            _doFind(_pendingSearchText);
                            _pendingSearchText = '';
                            if (_readyPollTimer) { clearInterval(_readyPollTimer); _readyPollTimer = null; }
                        }
                    });
                } else {
                    _editorInstance.on('change', () => {
                        _edMarkDirty();
                        if (_pendingSearchText) {
                            _doFind(_pendingSearchText);
                            _pendingSearchText = '';
                            if (_readyPollTimer) { clearInterval(_readyPollTimer); _readyPollTimer = null; }
                        }
                    });
                }
                // 编辑器就绪，触发待搜索（如果有内容）
                if (_pendingSearchText && _editorInstance.getValue().length > 0) {
                    _doFind(_pendingSearchText);
                    _pendingSearchText = '';
                    if (_readyPollTimer) { clearInterval(_readyPollTimer); _readyPollTimer = null; }
                }
            } catch (e) {
                console.error('_initCodeMirror failed:', e);
                element.innerHTML = '<div class="cm-placeholder"><i class="bi bi-exclamation-circle"></i> 初始化失败: ' + e.message + '</div>';
            }
        }

        // 保存前二次确认：展示本次新增/删除行数
        function _confirmSave(isNewFile) {
            const content = _simpleMDE ? _simpleMDE.value() : (_editorInstance ? _editorInstance.getValue() : '');
            const ops = _computeLineDiff(_editorOriginal, content);
            let addN = 0, delN = 0;
            if (ops) ops.forEach(o => { if (o.t === '+') addN++; else if (o.t === '-') delN++; });
            const container = document.getElementById('editorContainer');
            const overlay = document.createElement('div');
            overlay.className = 'preview-overlay';
            overlay.style.zIndex = '10010';
            const stats = ops
                ? `<div class="confirm-stats"><span class="cs-add">+ ${addN} 行新增</span><span class="cs-del">- ${delN} 行删除</span></div>
               <div class="confirm-sub">共 ${addN + delN} 处改动</div>`
                : `<div class="confirm-sub">文件较大，无法精确统计改动行数，仍要保存吗？</div>`;
            overlay.innerHTML = `
            <div class="confirm-modal">
                <div class="confirm-title"><i class="bi bi-exclamation-triangle"></i> 确认保存修改</div>
                <div class="confirm-body">${stats}</div>
                <div class="confirm-actions">
                    <button class="btn confirm-cancel" id="saveCancelBtn">取消</button>
                    <button class="btn ed-save-btn" id="saveOkBtn"><i class="bi bi-check-lg"></i> 确认保存</button>
                </div>
            </div>`;
            container.appendChild(overlay);
            const close = () => overlay.remove();
            overlay.querySelector('#saveCancelBtn').addEventListener('click', close);
            overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
            overlay.querySelector('#saveOkBtn').addEventListener('click', () => { close(); _saveEditorContent(isNewFile); });
        }
        function _saveEditorContent(isNewFile) {
            if (!_editorInstance && !_simpleMDE) { showToast('提示', '编辑器未初始化', 'warning'); return; }
            const content = _simpleMDE ? _simpleMDE.value() : (_editorInstance ? _editorInstance.getValue() : '');

            // 新文件：文件已由后端创建（空文件），现在只需保存编辑器内容
            // 已有文件：直接覆盖保存
            const btn = document.querySelector('.ed-save-btn');
            if (btn) { btn.disabled = true; btn.innerHTML = '<i class="bi bi-hourglass-split"></i> 保存中...'; }
            const statusEl = document.getElementById('edStatus');
            _setEdStatus('saving');

            fetch('/api/files/save', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path: _editorFilePath, content })
            })
                .then(r => r.json())
                .then(data => {
                    if (data.error) {
                        showToast('错误', '保存失败: ' + data.error, 'danger');
                        if (btn) { btn.disabled = false; btn.innerHTML = '<i class="bi bi-check-lg"></i> 保存'; }
                        _setEdStatus('error');
                        return;
                    }
                    showToast('成功', isNewFile ? ('文件已创建并保存: ' + _editorFilePath) : '已保存', 'success');
                    _edModified = false;
                    _editorOriginal = content;   // 保存后更新对比基准
                    _updateDiffBadge();          // 保存后徽章清零
                    _setEdStatus('saved');
                    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="bi bi-check-lg"></i> 保存'; }
                    loadFiles(currentPath);
                    setTimeout(closeEditor, 300);   // 保存成功后退出编辑器
                })
                .catch(e => {
                    showToast('错误', '保存失败: ' + e.message, 'danger');
                    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="bi bi-check-lg"></i> 保存'; }
                    _setEdStatus('error');
                });
        }

        function closeEditor() {
            if (_editorPreviewTimer) { clearTimeout(_editorPreviewTimer); _editorPreviewTimer = null; }
            _clearSearchHighlights();
            if (_simpleMDE) { try { _simpleMDE.toTextArea(); } catch (e) { } _simpleMDE = null; }
            if (_editorInstance) { _editorInstance.toTextArea && _editorInstance.toTextArea(); _editorInstance = null; }
            const container = document.getElementById('editorContainer');
            container.innerHTML = '';
        }

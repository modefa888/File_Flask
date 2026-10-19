        // ========== AI 文件管理：右侧智能体面板（复用 /api/ai/agent 后台运行 + SSE 续传） ==========
        // 功能：在文件管理主页直接用自然语言指挥 AI 整理 / 分析 / 操作当前目录。
        // 后端与 IDE 的 AI 智能体共用一套：POST /api/ai/agent {repo, messages, perm} → run_id
        // → GET /api/ai/agent/stream?run_id=&offset= （回放 + 实时事件）。
        // 对话落库：/api/ai/sessions（app=files，按当前目录隔离），刷新 / 重开面板都能续上。
        const _aiFm = {
            open: false, built: false,
            running: false, runId: '', offset: 0,
            history: [],                       // 多轮对话 [{mid, role, content}]
            perm: localStorage.getItem('fmAI_perm') || 'workspace',
            curText: '',                       // 当前流式回复累计文本
            curBubble: null, stepsBox: null,
            session: '',                       // 当前会话 id（数据库）
            sessionPath: '',                   // 会话所属目录
            savedMids: null,                   // 已入库的消息 mid 集合（Set）
            fresh: false,                      // 点了「新会话」、还没发第一条消息：不要自动回放旧对话
            runSteps: [],                      // 本轮工具步骤（落库用，刷新后能回放）
            runTodos: [],                      // 本轮任务清单（落库用）
            stepMap: {},                       // call_id → 步骤数据
        };

        function _aiFmEsc(s) {
            return String(s == null ? '' : s)
                .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        }

        // 行内渲染：`代码` / **加粗** / *斜体* / [链接](url)
        function _aiFmInline(s) {
            let html = _aiFmEsc(s);
            const codes = [];
            html = html.replace(/`([^`\n]+)`/g, function (_m, c) {
                codes.push(c);
                return '\x01IC' + (codes.length - 1) + '\x02';
            });
            html = html.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g,
                '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
            html = html.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
            // 只处理 *斜体*（不处理 __粗体__，否则 __init__.py 这类文件名会被误伤）；
            // 内容不能以空格开头 / 结尾，避免把 *.py *.js 这类通配符当成斜体
            html = html.replace(/(^|[^\w*])\*([^*\s](?:[^*\n]*[^*\s])?)\*(?![*\w])/g, '$1<em>$2</em>');
            html = html.replace(/\x01IC(\d+)\x02/g, function (_m, n) { return '<code>' + codes[+n] + '</code>'; });
            return html;
        }

        // 表格行拆列：去掉首尾的 |，再按 | 切分
        function _aiFmCells(line) {
            let s = String(line).trim();
            if (s.charAt(0) === '|') s = s.slice(1);
            if (s.charAt(s.length - 1) === '|') s = s.slice(0, -1);
            return s.split('|').map(function (x) { return x.trim(); });
        }
        // 表格分隔行：|---|:--:|---|
        function _aiFmIsTableSep(line) {
            return /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$/.test(line);
        }

        // 块级渲染：代码块 / 标题 #~###### / 列表 / 引用 / 分隔线 / 段落
        // 按行解析（不再依赖 white-space:pre-wrap），连续空行只会产生一个段落间隔，
        // 避免模型输出里的多余换行被当成一大片空白。
        function _aiFmRender(text) {
            const lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
            const out = [];
            let list = null;      // 当前打开的列表：'ul' | 'ol'
            let para = [];        // 当前段落累积的原始行

            function flushPara() {
                if (!para.length) return;
                const html = para.map(_aiFmInline).join('<br>');
                para = [];
                if (html.trim()) out.push('<p>' + html + '</p>');
            }
            function closeList() {
                if (list) { out.push('</' + list + '>'); list = null; }
            }

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i].replace(/\s+$/, '');
                let m;

                // ``` 代码块（未闭合时也按代码块渲染，流式输出更自然）
                if (/^\s*```/.test(line)) {
                    flushPara(); closeList();
                    const buf = [];
                    for (i++; i < lines.length; i++) {
                        if (/^\s*```\s*$/.test(lines[i])) break;
                        buf.push(lines[i]);
                    }
                    out.push('<pre><code>' + _aiFmEsc(buf.join('\n')) + '</code></pre>');
                    continue;
                }
                if (!line.trim()) { flushPara(); closeList(); continue; }

                // 表格：当前行是表头，下一行是分隔行才认
                if (line.indexOf('|') >= 0 && i + 1 < lines.length &&
                    _aiFmIsTableSep(lines[i + 1]) && lines[i + 1].indexOf('|') >= 0) {
                    flushPara(); closeList();
                    const head = _aiFmCells(line);
                    const rows = [];
                    let j = i + 2;
                    while (j < lines.length && lines[j].trim() && lines[j].indexOf('|') >= 0) {
                        rows.push(_aiFmCells(lines[j]));
                        j++;
                    }
                    i = j - 1;
                    out.push('<div class="aifm-table-wrap"><table><thead><tr>' +
                        head.map(function (c) { return '<th>' + _aiFmInline(c) + '</th>'; }).join('') +
                        '</tr></thead><tbody>' +
                        rows.map(function (r) {
                            return '<tr>' + r.map(function (c) { return '<td>' + _aiFmInline(c) + '</td>'; }).join('') + '</tr>';
                        }).join('') +
                        '</tbody></table></div>');
                    continue;
                }

                // 标题
                m = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/);
                if (m) {
                    flushPara(); closeList();
                    const lv = m[1].length;
                    out.push('<h' + lv + '>' + _aiFmInline(m[2].trim()) + '</h' + lv + '>');
                    continue;
                }
                // 分隔线
                if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
                    flushPara(); closeList(); out.push('<hr>'); continue;
                }
                // 引用
                m = line.match(/^\s{0,3}>\s?(.*)$/);
                if (m) {
                    flushPara(); closeList();
                    out.push('<blockquote>' + _aiFmInline(m[1]) + '</blockquote>');
                    continue;
                }
                // 无序列表
                m = line.match(/^\s*[-*+]\s+(.*)$/);
                if (m) {
                    flushPara();
                    if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; }
                    out.push('<li>' + _aiFmInline(m[1]) + '</li>');
                    continue;
                }
                // 有序列表
                m = line.match(/^\s*\d+[.)]\s+(.*)$/);
                if (m) {
                    flushPara();
                    if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; }
                    out.push('<li>' + _aiFmInline(m[1]) + '</li>');
                    continue;
                }
                // 普通段落行
                closeList();
                para.push(line);
            }
            flushPara(); closeList();
            return out.join('');
        }

        function _aiFmNewPid() {
            return 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
        }

        // 移动 / 修改 / 删除类操作：后端会给出 risk，老后端没这个字段时按命令关键字兜底判断
        const _aiFmDangerRe = new RegExp(
            '\\b(rm|rmdir|unlink|shred|truncate|mv|rename|ren)\\b' +
            '|\\bsed\\b[^\\n]*\\s-\\w*i' +
            '|\\bperl\\b[^\\n]*\\s-\\w*i' +
            '|\\b(chmod|chown|chgrp|chattr)\\b' +
            '|\\b(dd|tee)\\b' +
            '|\\bgit\\s+(clean|reset\\s+--hard|checkout\\s+--)\\b',
            'i'
        );

        function _aiFmRisk(ev) {
            if (ev && ev.risk) return ev.risk;
            if (!ev) return 'normal';
            if (ev.tool === 'edit_file') return 'danger';
            if (ev.tool === 'run_command') {
                const cmd = String((ev.args || {}).command || '');
                if (_aiFmDangerRe.test(cmd) || /(^|[^0-9&<>])>(?![>&])\s*(?!\/dev\/null)\S/.test(cmd)) return 'danger';
            }
            return 'normal';
        }

        function _aiFmShortArgs(tool, args) {
            args = args || {};
            const t = String(args.path || args.pattern || args.command || args.content || '');
            const label = {
                list_dir: '列目录', read_file: '读文件', write_file: '写文件', edit_file: '改文件',
                search_files: '搜索', run_command: '执行命令', web_search: '联网搜索',
                generate_image: '生成图片', code_intel: '代码分析', delegate_task: '子任务', todo_write: '任务清单',
            }[tool] || tool;
            if (!t) return label;
            return label + '：' + (t.length > 60 ? t.slice(0, 60) + '…' : t);
        }

        // ---------- 执行步骤折叠块 ----------
        function _aiFmStepsTitle(steps) {
            const n = steps.length;
            const bad = steps.filter(function (s) { return s.ok === false; }).length;
            return '执行步骤 · ' + n + ' 步' + (bad ? '（' + bad + ' 失败）' : '');
        }

        // 建出「标题 + 步骤容器」结构（幂等），返回步骤容器
        function _aiFmStepsBody(box) {
            if (!box.querySelector('.aifm-steps-body')) {
                box.innerHTML = '<button type="button" class="aifm-steps-head">' +
                    '<span class="aifm-steps-ico">🛠</span>' +
                    '<span class="aifm-steps-title">执行步骤</span>' +
                    '<span class="aifm-steps-arrow">▾</span></button>' +
                    '<div class="aifm-steps-body"></div>';
                box.querySelector('.aifm-steps-head').addEventListener('click', function () {
                    box.classList.toggle('collapsed');
                });
            }
            return box.querySelector('.aifm-steps-body');
        }

        function _aiFmStepsHead(box) {
            if (!box) return;
            const t = box.querySelector('.aifm-steps-title');
            if (t) t.textContent = _aiFmStepsTitle(_aiFm.runSteps);
        }

        function _aiFmBuild() {
            if (_aiFm.built) return;
            _aiFm.built = true;
            const drawer = document.createElement('div');
            drawer.id = 'aiFmDrawer';
            drawer.innerHTML = `
                <div class="aifm-resizer" title="拖动调整宽度（双击复位）"></div>
                <div class="aifm-head">
                    <span class="aifm-title"><i class="bi bi-robot"></i> AI 文件管理</span>
                    <span class="aifm-scope" id="aiFmScope" title="AI 工作目录">--</span>
                    <select class="aifm-perm" id="aiFmPerm" title="AI 操作权限">
                        <option value="readonly">只读</option>
                        <option value="workspace">目录内写</option>
                        <option value="full">完全</option>
                    </select>
                    <button class="aifm-hbtn ms-auto" id="aiFmHistBtn" title="历史对话"><i class="bi bi-clock-history"></i></button>
                    <button class="aifm-hbtn" id="aiFmNewBtn" title="新会话（清空对话）"><i class="bi bi-plus-circle"></i></button>
                    <button class="aifm-hbtn" id="aiFmCloseBtn" title="关闭（任务仍在后台继续）"><i class="bi bi-x-lg"></i></button>
                    <div class="aifm-hist" id="aiFmHist"></div>
                </div>
                <div class="aifm-body" id="aiFmBody"></div>
                <div class="aifm-foot">
                    <div class="aifm-input-wrap">
                        <textarea id="aiFmInput" rows="1" placeholder="让 AI 整理这个目录，如：把这些图片按日期归类到子文件夹"></textarea>
                        <button class="aifm-send" id="aiFmSendBtn" title="发送"><i class="bi bi-send"></i></button>
                    </div>
                    <div class="aifm-note">AI 以当前目录为工作区；写文件 / 执行命令按权限确认后才会执行</div>
                </div>`;
            document.body.appendChild(drawer);

            // 左右拖动调宽度：记住上次宽度，双击复位
            const savedW = parseInt(localStorage.getItem('fmAI_w') || '', 10);
            if (savedW >= 300) drawer.style.width = savedW + 'px';
            const resizer = drawer.querySelector('.aifm-resizer');
            const _aiFmClampW = function (w) {
                const max = Math.round(window.innerWidth * 0.85);
                return Math.max(320, Math.min(max, w));
            };
            if (resizer) {
                let dragging = false, startX = 0, startW = 0;
                resizer.addEventListener('pointerdown', function (e) {
                    dragging = true;
                    startX = e.clientX;
                    startW = drawer.getBoundingClientRect().width;
                    drawer.classList.add('resizing');
                    document.body.style.userSelect = 'none';
                    try { resizer.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
                    e.preventDefault();
                });
                resizer.addEventListener('pointermove', function (e) {
                    if (!dragging) return;
                    // 面板贴右边，鼠标左移 = 变宽
                    drawer.style.width = _aiFmClampW(startW + (startX - e.clientX)) + 'px';
                });
                const _endDrag = function (e) {
                    if (!dragging) return;
                    dragging = false;
                    drawer.classList.remove('resizing');
                    document.body.style.userSelect = '';
                    try { resizer.releasePointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
                    localStorage.setItem('fmAI_w', String(Math.round(drawer.getBoundingClientRect().width)));
                };
                resizer.addEventListener('pointerup', _endDrag);
                resizer.addEventListener('pointercancel', _endDrag);
                resizer.addEventListener('dblclick', function () {
                    drawer.style.width = '';
                    localStorage.removeItem('fmAI_w');
                });
            }

            const permSel = drawer.querySelector('#aiFmPerm');
            permSel.value = ['readonly', 'workspace', 'full'].includes(_aiFm.perm) ? _aiFm.perm : 'workspace';
            permSel.addEventListener('change', function () {
                _aiFm.perm = permSel.value;
                localStorage.setItem('fmAI_perm', _aiFm.perm);
            });

            drawer.querySelector('#aiFmCloseBtn').addEventListener('click', _aiFmToggle);
            drawer.querySelector('#aiFmNewBtn').addEventListener('click', _aiFmNewSession);
            drawer.querySelector('#aiFmHistBtn').addEventListener('click', function (e) {
                e.stopPropagation();
                _aiFmHistToggle();
            });
            // 点空白处收起历史列表
            document.addEventListener('click', function (e) {
                const box = document.getElementById('aiFmHist');
                if (!box || !box.classList.contains('open')) return;
                if (box.contains(e.target) || e.target.closest('#aiFmHistBtn')) return;
                box.classList.remove('open');
            });

            const input = drawer.querySelector('#aiFmInput');
            const sendBtn = drawer.querySelector('#aiFmSendBtn');
            sendBtn.addEventListener('click', _aiFmOnSend);
            input.addEventListener('keydown', function (e) {
                if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); _aiFmOnSend(); }
            });
            input.addEventListener('input', function () {
                input.style.height = 'auto';
                input.style.height = Math.min(input.scrollHeight, 120) + 'px';
            });

            _aiFmWelcome();
        }

        // 统一的「正在干活」提示：没有新内容输出时始终有个气泡转圈，
        // 避免工具执行 / 模型等待期间面板出现一大片空白。
        function _aiFmThink(label) {
            const b = _aiFmBodyEl();
            if (!b) return;
            if (!_aiFm.thinking) {
                const el = document.createElement('div');
                el.className = 'aifm-msg ai aifm-thinking';
                el.innerHTML = '<div class="aifm-bubble"><span class="spin"></span> <span class="aifm-think-txt">思考中…</span></div>';
                b.appendChild(el);
                _aiFm.thinking = el;
            }
            const t = _aiFm.thinking.querySelector('.aifm-think-txt');
            if (t) t.textContent = label || '思考中…';
            // 始终保持在最底部（后面又插入了步骤 / 任务清单时挪到最后）
            if (_aiFm.thinking.nextElementSibling) b.appendChild(_aiFm.thinking);
            _aiFmScroll();
        }
        function _aiFmThinkOff() {
            if (_aiFm.thinking) { _aiFm.thinking.remove(); _aiFm.thinking = null; }
        }

        function _aiFmBodyEl() { return document.getElementById('aiFmBody'); }
        function _aiFmScroll() {
            const b = _aiFmBodyEl();
            if (b) b.scrollTop = b.scrollHeight;
        }

        function _aiFmWelcome() {
            const b = _aiFmBodyEl();
            if (!b) return;
            b.innerHTML = `
                <div class="aifm-empty">
                    <div class="aifm-hint-ico"><i class="bi bi-robot"></i></div>
                    <div>对我说点什么，AI 会直接在<b>${_aiFmEsc(currentPath || '当前目录')}</b>里干活</div>
                    <div>可以整理文件 · 查找重复 · 分析目录 · 批量改名 · 写文件…</div>
                    <div class="aifm-chips">
                        <button data-q="帮我看看这个目录里都有什么，给个整理建议">看看这个目录，给整理建议</button>
                        <button data-q="找出这个目录下超过 100MB 的大文件">找出大文件</button>
                        <button data-q="把这个目录里的文件按类型分类到子文件夹">按类型归类</button>
                    </div>
                </div>`;
            b.querySelectorAll('.aifm-chips button').forEach(function (btn) {
                btn.addEventListener('click', function () {
                    const input = document.getElementById('aiFmInput');
                    if (input) { input.value = btn.dataset.q; input.focus(); }
                    _aiFmOnSend();
                });
            });
        }

        function _aiFmToggle() {
            _aiFmBuild();
            const drawer = document.getElementById('aiFmDrawer');
            const btn = document.getElementById('aiPanelBtn');
            _aiFm.open = !_aiFm.open;
            drawer.classList.toggle('open', _aiFm.open);
            if (btn) btn.classList.toggle('active', _aiFm.open);
            if (_aiFm.open) {
                const scope = document.getElementById('aiFmScope');
                if (scope) { scope.textContent = currentPath || '--'; scope.title = currentPath || ''; }
                // 换了目录（且没在跑任务）：清空重来，并载入该目录上次的对话
                if (!_aiFm.running && _aiFm.sessionPath !== (currentPath || '')) {
                    _aiFm.history = []; _aiFm.session = ''; _aiFm.savedMids = null;
                    _aiFm.runId = ''; _aiFm.offset = 0; _aiFm.curText = ''; _aiFm.curBubble = null;
                    _aiFm.stepsBox = null; _aiFm.fresh = false;
                    _aiFmWelcome();
                }
                // 面板是空的（且不是刚点「新会话」）：回放该目录最近一次对话。
                // 每次打开都尝试一次，避免上次请求失败后就再也不加载。
                if (!_aiFm.running && !_aiFm.history.length && !_aiFm.fresh) _aiFmLoadHistory();
                // 上次任务还在后台跑：按 offset 重连续看进度
                if (_aiFm.running && _aiFm.runId) _aiFmStream(_aiFm.runId, _aiFm.offset);
                const input = document.getElementById('aiFmInput');
                if (input) input.focus();
            }
        }

        function _aiFmNewSession() {
            if (_aiFm.running) { showToast('提示', '任务还在运行，请先停止再开新会话', 'warning'); return; }
            _aiFm.history = []; _aiFm.runId = ''; _aiFm.offset = 0; _aiFm.curText = ''; _aiFm.curBubble = null;
            _aiFm.stepsBox = null;
            // 新会话：id 留空，等第一条消息再建库记录（避免产生空会话）
            _aiFm.session = ''; _aiFm.savedMids = null; _aiFm.sessionPath = currentPath || '';
            _aiFm.fresh = true;                  // 明确表示「我要新开」，别再自动回放旧对话
            const box = document.getElementById('aiFmHist');
            if (box) box.classList.remove('open');
            _aiFmWelcome();
        }

        // ---------- 对话落库（/api/ai/sessions，app=files，按当前目录隔离） ----------
        // 打开面板时载入该目录最近一次对话，让刷新 / 关掉面板后都能接着聊。
        async function _aiFmLoadHistory() {
            const path = currentPath || '';
            _aiFm.sessionPath = path;
            if (!path || _aiFm.running || _aiFm.fresh || _aiFm.history.length) return;
            try {
                const r = await fetch('/api/ai/sessions?app=files&root=' + encodeURIComponent(path));
                const d = await r.json().catch(function () { return {}; });
                const latest = (d.sessions || [])[0];
                if (!r.ok || !latest || !latest.id) return;
                const r2 = await fetch('/api/ai/sessions/' + encodeURIComponent(latest.id));
                const conv = await r2.json().catch(function () { return {}; });
                if (!r2.ok || !conv.id || !(conv.msgs || []).length) return;
                // 载入期间用户可能已经开聊：有内容就不覆盖
                if (_aiFm.history.length) return;
                _aiFm.session = conv.id;
                _aiFm.savedMids = new Set((conv.msgs || []).map(function (m) { return m.pid; }).filter(Boolean));
                _aiFmRenderHistory(conv.msgs || []);
            } catch (e) { /* 读不到历史就保持欢迎页 */ }
        }

        // ---------- 历史对话列表（头部「时钟」按钮） ----------
        function _aiFmFmtTime(t) {
            const n = Number(t);
            if (!n) return '';
            const d = new Date(n * 1000);
            if (isNaN(d.getTime())) return '';
            const pad = function (x) { return x < 10 ? '0' + x : '' + x; };
            const hm = pad(d.getHours()) + ':' + pad(d.getMinutes());
            const now = new Date();
            if (d.toDateString() === now.toDateString()) return '今天 ' + hm;
            if (d.toDateString() === new Date(now - 86400000).toDateString()) return '昨天 ' + hm;
            return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hm;
        }

        async function _aiFmHistToggle() {
            const box = document.getElementById('aiFmHist');
            if (!box) return;
            if (box.classList.contains('open')) { box.classList.remove('open'); return; }
            box.classList.add('open');
            box.innerHTML = '<div class="aifm-hist-empty">加载中…</div>';
            try {
                const path = currentPath || '';
                const r = await fetch('/api/ai/sessions?app=files&root=' + encodeURIComponent(path));
                const d = await r.json().catch(function () { return {}; });
                const list = (d.sessions || []).filter(function (s) { return (s.msg_count || 0) > 0; });
                if (!list.length) {
                    box.innerHTML = '<div class="aifm-hist-empty">这个目录还没有历史对话</div>';
                    return;
                }
                box.innerHTML = list.map(function (s) {
                    const active = s.id === _aiFm.session ? ' active' : '';
                    return '<button class="aifm-hist-item' + active + '" data-id="' + _aiFmEsc(s.id) + '">' +
                        '<span class="aifm-hist-t">' + _aiFmEsc(s.title || '未命名对话') + '</span>' +
                        '<span class="aifm-hist-d">' + _aiFmEsc(_aiFmFmtTime(s.updated_at)) +
                        ' · ' + (s.msg_count || 0) + ' 条消息</span></button>';
                }).join('');
                box.querySelectorAll('.aifm-hist-item').forEach(function (btn) {
                    btn.addEventListener('click', function () {
                        box.classList.remove('open');
                        _aiFmOpenSession(btn.dataset.id);
                    });
                });
            } catch (e) {
                box.innerHTML = '<div class="aifm-hist-empty">读取失败，请稍后重试</div>';
            }
        }

        // 打开某条历史会话：切换内容，后续提问接着这个会话走
        async function _aiFmOpenSession(id) {
            if (!id) return;
            if (_aiFm.running) { showToast('提示', '任务还在运行，请先停止再切换会话', 'warning'); return; }
            try {
                const r = await fetch('/api/ai/sessions/' + encodeURIComponent(id));
                const conv = await r.json().catch(function () { return {}; });
                if (!r.ok || !conv.id) { showToast('提示', '会话不存在或已被删除', 'warning'); return; }
                _aiFm.session = conv.id;
                _aiFm.sessionPath = currentPath || '';
                _aiFm.fresh = false;
                _aiFm.savedMids = new Set((conv.msgs || []).map(function (m) { return m.pid; }).filter(Boolean));
                _aiFm.runId = ''; _aiFm.offset = 0;
                _aiFm.curBubble = null; _aiFm.curText = ''; _aiFm.stepsBox = null;
                if (!(conv.msgs || []).length) { _aiFmWelcome(); return; }
                _aiFmRenderHistory(conv.msgs || []);
            } catch (e) {
                showToast('提示', '读取会话失败：' + e, 'warning');
            }
        }

        function _aiFmRenderHistory(msgs) {
            const b = _aiFmBodyEl();
            if (!b) return;
            b.innerHTML = '';
            _aiFm.history = [];
            _aiFm.stepsBox = null;
            _aiFm.curBubble = null; _aiFm.curText = '';
            msgs.forEach(function (m) {
                if (m.role !== 'user' && m.role !== 'assistant') return;
                const text = m.text || '';
                const hasText = !!String(text).trim();
                const steps = (m.role === 'assistant' && Array.isArray(m.steps)) ? m.steps : [];
                const todos = (m.role === 'assistant' && Array.isArray(m.todos)) ? m.todos : [];
                // 只有工具调用、没有正文的 assistant 消息：不画空气泡，但步骤仍要回放
                if (!hasText && !steps.length && !todos.length) return;
                if (hasText) {
                    _aiFm.history.push({ mid: m.pid, role: m.role, content: text });
                    const el = document.createElement('div');
                    el.className = 'aifm-msg ' + (m.role === 'user' ? 'user' : 'ai');
                    el.innerHTML = '<div class="aifm-bubble">' + _aiFmRender(text) + '</div>';
                    b.appendChild(el);
                }
                // 历史步骤一并回放（危险命令仍然标红）；默认收起，点标题展开细看
                if (steps.length) {
                    const box = document.createElement('div');
                    box.className = 'aifm-steps collapsed';
                    b.appendChild(box);
                    _aiFmStepsBody(box).innerHTML = steps.map(function (s) {
                        const danger = _aiFmRisk(s) === 'danger';
                        return '<div class="aifm-step ' + (s.ok === false ? 'bad' : 'ok') + (danger ? ' danger' : '') + '">' +
                            '<span>' + (danger ? '🛑' : '🛠') + '</span>' +
                            '<span class="aifm-step-txt">' + _aiFmEsc(_aiFmShortArgs(s.tool, s.args)) + '</span>' +
                            (danger ? '<span class="aifm-step-tag">危险</span>' : '') +
                            '<span class="aifm-step-st">' + (s.ok === false ? '✗' : '✓') + '</span></div>';
                    }).join('');
                    const head = box.querySelector('.aifm-steps-title');
                    if (head) head.textContent = _aiFmStepsTitle(steps);
                }
                // 任务清单也一并回放
                if (todos.length) {
                    const tb = document.createElement('div');
                    tb.className = 'aifm-todos';
                    tb.innerHTML = _aiFmTodosHtml(todos);
                    b.appendChild(tb);
                }
            });
            _aiFmScroll();
        }

        // 把还没入库的消息写进会话（用户消息先落库，AI 回复由后端 save_reply 兜底写同一 mid）
        async function _aiFmPersist() {
            const path = _aiFm.sessionPath || currentPath || '';
            if (!path || !_aiFm.session) return;
            if (!_aiFm.savedMids) _aiFm.savedMids = new Set();
            const saved = _aiFm.savedMids;
            const pend = _aiFm.history.filter(function (m) { return m.mid && !saved.has(m.mid); });
            if (!pend.length) return;
            const firstUser = _aiFm.history.find(function (m) { return m.role === 'user'; });
            const title = String((firstUser && firstUser.content) || '文件管理对话').slice(0, 40);
            try {
                const r = await fetch('/api/ai/sessions', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        id: _aiFm.session, app: 'files', root: path, title: title, extra: {},
                        msgs: pend.map(function (m) {
                            const meta = { ts: m.ts || Date.now() };
                            // 步骤 / 任务清单存进 meta，刷新后由 _aiFmRenderHistory 回放
                            if (m.steps && m.steps.length) meta.steps = m.steps;
                            if (m.todos && m.todos.length) meta.todos = m.todos;
                            return {
                                mid: m.mid, role: m.role, text: m.content || '',
                                meta: meta,
                            };
                        }),
                    }),
                });
                const d = await r.json().catch(function () { return {}; });
                if (r.ok && d.saved_mids) {
                    d.saved_mids.forEach(function (mid) { saved.add(mid); });
                }
            } catch (e) { /* 落库失败不阻断对话 */ }
        }

        function _aiFmOnSend() {
            if (_aiFm.running) { _aiFmStop(); return; }
            const input = document.getElementById('aiFmInput');
            if (!input) return;
            const text = input.value.trim();
            if (!text) return;
            if (!currentPath) { showToast('提示', '请先进入一个目录再使用 AI 助手', 'warning'); return; }
            input.value = ''; input.style.height = 'auto';
            _aiFmSend(text);
        }

        async function _aiFmSend(text) {
            const b = _aiFmBodyEl();
            if (!b) return;
            _aiFm.fresh = false;                 // 新会话开始了，之后按正常逻辑落库 / 回放
            // 首次发送时清掉欢迎页
            if (b.querySelector('.aifm-empty')) b.innerHTML = '';

            // 会话 id 按目录惰性创建：第一条消息才建库记录，避免产生空会话
            if (!_aiFm.session || _aiFm.sessionPath !== currentPath) {
                _aiFm.session = _aiFmNewPid();
                _aiFm.sessionPath = currentPath;
                _aiFm.savedMids = new Set();
            }

            _aiFm.history.push({ mid: _aiFmNewPid(), role: 'user', content: text, ts: Date.now() });
            const userMsg = document.createElement('div');
            userMsg.className = 'aifm-msg user';
            userMsg.innerHTML = `<div class="aifm-bubble">${_aiFmRender(text)}</div>`;
            b.appendChild(userMsg);
            _aiFmScroll();

            _aiFm.running = true; _aiFm.offset = 0; _aiFm.curText = '';
            _aiFm.runSteps = []; _aiFm.runTodos = []; _aiFm.stepMap = {};
            _aiFm.stepsBox = null; _aiFm.curBubble = null;
            _aiFmSetSend(true);
            _aiFmThinkOff();
            _aiFmThink('思考中…');

            try {
                // 先把用户消息写进会话，后端拿到 session_id 后运行结束会把 AI 回复也落库
                await _aiFmPersist();
                const r = await fetch('/api/ai/agent', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        repo: currentPath, messages: _aiFm.history, perm: _aiFm.perm,
                        auto_run: 'ask', web_search: false, image_tool: false,
                        session_id: _aiFm.session,
                    }),
                });
                const d = await r.json().catch(function () { return {}; });
                if (!r.ok || !d.run_id) {
                    const msg = d.error || ('启动失败（HTTP ' + r.status + '）') +
                        (d.need_config ? '：请先在 IDE「设置 → AI」里配置模型接口' : '');
                    _aiFmErrorBubble(msg);
                    _aiFmDone(false);
                    return;
                }
                _aiFm.runId = d.run_id;
                await _aiFmStream(d.run_id, 0);
            } catch (err) {
                _aiFmErrorBubble('网络异常：' + err);
                _aiFmDone(false);
            }
        }

        async function _aiFmStream(runId, offset) {
            try {
                const resp = await fetch('/api/ai/agent/stream?run_id=' + encodeURIComponent(runId) +
                    '&offset=' + (offset || 0));
                if (!resp.ok || !resp.body) { return; }
                const reader = resp.body.getReader();
                const dec = new TextDecoder();
                let buf = '';
                while (true) {
                    const r = await reader.read();
                    if (r.done) break;
                    buf += dec.decode(r.value, { stream: true });
                    let idx;
                    while ((idx = buf.indexOf('\n')) >= 0) {
                        const line = buf.slice(0, idx).trim();
                        buf = buf.slice(idx + 1);
                        if (!line.startsWith('data:')) continue;
                        try { _aiFmEvent(JSON.parse(line.slice(5).trim())); } catch (e) { /* 忽略脏行 */ }
                    }
                }
            } catch (err) {
                if (_aiFm.running) _aiFmErrorBubble('连接中断：' + err);
            }
        }

        function _aiFmEvent(ev) {
            _aiFm.offset += 1;
            const b = _aiFmBodyEl();
            if (!b) return;
            const type = ev.type || '';

            if (type === 'delta') {
                // 模型在调用工具前后常会吐纯换行 / 空白：先累计，等真有内容再建气泡，
                // 否则会在对话里留下一块块空白的白框。
                _aiFm.curText += (ev.text || '');
                if (!_aiFm.curText.trim()) return;      // 只有空白：保持「思考中」气泡
                _aiFmThinkOff();
                if (!_aiFm.curBubble) {
                    _aiFm.curBubble = document.createElement('div');
                    _aiFm.curBubble.className = 'aifm-msg ai';
                    _aiFm.curBubble.innerHTML = '<div class="aifm-bubble"></div>';
                    b.appendChild(_aiFm.curBubble);
                    _aiFm.stepsBox = null;
                }
                _aiFm.curBubble.querySelector('.aifm-bubble').innerHTML = _aiFmRender(_aiFm.curText);
                _aiFmScroll();
            } else if (type === 'step') {
                _aiFmFinishBubble();
                if (!_aiFm.stepsBox) {
                    _aiFm.stepsBox = document.createElement('div');
                    _aiFm.stepsBox.className = 'aifm-steps';
                    b.appendChild(_aiFm.stepsBox);
                    _aiFmStepsBody(_aiFm.stepsBox);
                }
                const danger = _aiFmRisk(ev) === 'danger';
                const el = document.createElement('div');
                el.className = 'aifm-step' + (danger ? ' danger' : '');
                el.innerHTML = `<span>${danger ? '🛑' : '🛠'}</span><span class="aifm-step-txt">${_aiFmEsc(_aiFmShortArgs(ev.tool, ev.args))}</span>
                    ${danger ? '<span class="aifm-step-tag">危险</span>' : ''}
                    <span class="aifm-step-st"><span class="spin"></span></span>`;
                el._callId = ev.call_id;
                const stepBody = _aiFmStepsBody(_aiFm.stepsBox);
                stepBody.appendChild(el);
                stepBody.scrollTop = stepBody.scrollHeight;
                _aiFm['step_' + ev.call_id] = el;
                // 同步攒一份纯数据，结束时随消息一起落库（刷新后能回放步骤）
                const sd = { tool: ev.tool, args: ev.args || {}, call_id: ev.call_id };
                _aiFm.runSteps.push(sd);
                _aiFm.stepMap[ev.call_id] = sd;
                _aiFmStepsHead(_aiFm.stepsBox);
                _aiFmThink('执行中…');       // 工具执行期间也要有反馈
                _aiFmScroll();
            } else if (type === 'result') {
                const el = _aiFm['step_' + ev.call_id];
                if (el) {
                    el.classList.add(ev.ok === false ? 'bad' : 'ok');
                    const st = el.querySelector('.aifm-step-st');
                    if (st) st.textContent = ev.ok === false ? '✗ ' + (ev.ms ? ev.ms + 'ms' : '') : '✓' + (ev.ms ? ' ' + ev.ms + 'ms' : '');
                    if (ev.summary) el.title = ev.summary;
                    delete _aiFm['step_' + ev.call_id];
                }
                const sd = _aiFm.stepMap[ev.call_id];
                if (sd) {
                    sd.ok = ev.ok !== false;
                    if (ev.ms != null) sd.ms = ev.ms;
                    if (ev.summary) sd.summary = ev.summary;
                }
                _aiFmStepsHead(_aiFm.stepsBox);
                _aiFmThink(ev.ok === false ? '这一步失败了，正在处理…' : '思考中…');
            } else if (type === 'ask') {
                _aiFmFinishBubble();
                _aiFmAskCard(ev);
            } else if (type === 'todos') {
                _aiFm.runTodos = ev.todos || [];
                _aiFmTodos(_aiFm.runTodos);
            } else if (type === 'error') {
                _aiFmFinishBubble();
                _aiFmErrorBubble(ev.error || '执行出错');
            } else if (type === 'done') {
                _aiFmFinishBubble(true);
                _aiFmDone(true);
            }
        }

        // 模型开始调工具 / 结束时，把流式气泡固化进历史
        // 只有本轮的最终回复带 mid（= m+runId，与后端 save_reply 的落库 mid 一致，不会写重）
        function _aiFmFinishBubble(final) {
            _aiFmThinkOff();
            if (_aiFm.curBubble) {
                if (_aiFm.curText.trim()) {
                    const mid = (final && _aiFm.runId) ? 'm' + _aiFm.runId : '';
                    const item = { mid: mid, role: 'assistant', content: _aiFm.curText, ts: Date.now() };
                    if (mid) {
                        // 步骤 / 任务清单跟着最终回复一起入库，刷新后仍能看到
                        if (_aiFm.runSteps.length) item.steps = _aiFm.runSteps.slice();
                        if (_aiFm.runTodos.length) item.todos = _aiFm.runTodos.slice();
                    }
                    _aiFm.history.push(item);
                } else {
                    // 这一轮只有空白内容（模型只调了工具），把空气泡从界面上摘掉
                    _aiFm.curBubble.remove();
                }
            }
            _aiFm.curBubble = null; _aiFm.curText = '';
        }

        // 需要确认的调用：移动 / 修改 / 删除标红，普通写文件 / 执行命令保持黄色
        function _aiFmAskCard(ev) {
            const b = _aiFmBodyEl();
            if (!b) return;
            const danger = _aiFmRisk(ev) === 'danger';
            // 同步把对应的命令步骤也标红，一眼能看出哪一步是危险操作
            const stepEl = _aiFm['step_' + ev.call_id];
            if (danger && stepEl) stepEl.classList.add('danger');
            const card = document.createElement('div');
            card.className = 'aifm-ask' + (danger ? ' danger' : '');
            card.innerHTML = `
                <div class="aifm-ask-tool">${danger ? '🛑 危险操作（移动 / 修改 / 删除）' : '⚠️ 需要确认'}：${_aiFmEsc(ev.tool || '操作')}</div>
                ${danger && ev.risk_reason ? `<div class="aifm-ask-risk">${_aiFmEsc(ev.risk_reason)}</div>` : ''}
                ${ev.reason ? `<div>${_aiFmEsc(ev.reason)}</div>` : ''}
                <pre>${_aiFmEsc(_aiFmShortArgs(ev.tool, ev.args))}</pre>
                <div class="aifm-ask-btns">
                    <button class="btn-allow"><i class="bi bi-check-lg"></i> ${danger ? '确认执行' : '允许'}</button>
                    <button class="btn-deny"><i class="bi bi-x-lg"></i> 拒绝</button>
                </div>
                <div class="aifm-ask-verdict"></div>`;
            b.appendChild(card);
            _aiFmScroll();

            const decide = async function (allow) {
                card.classList.add('decided');
                const v = card.querySelector('.aifm-ask-verdict');
                if (v) v.textContent = allow ? '✓ 已允许执行' : '✗ 已拒绝';
                try {
                    await fetch('/api/ai/agent/approve', {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ run_id: _aiFm.runId, call_id: ev.call_id, allow: allow }),
                    });
                } catch (e) { /* 超时后端也会自动拒绝 */ }
            };
            card.querySelector('.btn-allow').addEventListener('click', function () { decide(true); });
            card.querySelector('.btn-deny').addEventListener('click', function () { decide(false); });
        }

        function _aiFmTodosHtml(todos) {
            const ICO = { completed: '✅', in_progress: '⏳', pending: '⬜' };
            return todos.map(function (t) {
                const st = t.status === 'completed' ? 'st-done' : (t.status === 'in_progress' ? 'st-doing' : '');
                return `<div class="aifm-todo"><span>${ICO[t.status] || '⬜'}</span><span class="${st}">${_aiFmEsc(t.content || '')}</span></div>`;
            }).join('');
        }

        function _aiFmTodos(todos) {
            const b = _aiFmBodyEl();
            if (!b || !todos.length) return;
            let box = b.querySelector('.aifm-todos.live');
            if (!box) {
                box = document.createElement('div');
                box.className = 'aifm-todos live';
                b.appendChild(box);
            }
            box.innerHTML = _aiFmTodosHtml(todos);
            _aiFmScroll();
        }

        function _aiFmErrorBubble(text) {
            const b = _aiFmBodyEl();
            if (!b) return;
            const el = document.createElement('div');
            el.className = 'aifm-msg err';
            el.innerHTML = `<div class="aifm-bubble">${_aiFmEsc(text)}</div>`;
            b.appendChild(el);
            _aiFmScroll();
        }

        function _aiFmSetSend(running) {
            const btn = document.getElementById('aiFmSendBtn');
            if (!btn) return;
            if (running) {
                btn.classList.add('stop');
                btn.innerHTML = '<i class="bi bi-stop-fill"></i>';
                btn.title = '停止任务（任务不会因关闭页面中断）';
            } else {
                btn.classList.remove('stop');
                btn.innerHTML = '<i class="bi bi-send"></i>';
                btn.title = '发送';
            }
        }

        function _aiFmDone(changed) {
            _aiFm.running = false;
            _aiFmSetSend(false);
            _aiFmThinkOff();
            // 跑完自动收起步骤列表，只留一行「执行步骤 · N 步」，点击可再展开
            if (_aiFm.stepsBox) {
                _aiFmStepsHead(_aiFm.stepsBox);
                _aiFm.stepsBox.classList.add('collapsed');
            }
            _aiFmPersist();          // 本轮回复落库（mid 与后端兜底一致，重复写只会覆盖）
            _aiFmSyncScope();        // 任务期间若切过目录，结束后把面板切回当前目录
            // AI 可能改动了文件：静默刷新当前目录列表
            if (changed && currentPath) { try { loadFiles(currentPath); } catch (e) { /* 忽略 */ } }
        }

        async function _aiFmStop() {
            if (!_aiFm.runId) return;
            try {
                await fetch('/api/ai/agent/stop', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ run_id: _aiFm.runId }),
                });
            } catch (e) { /* 忽略 */ }
        }

        // ---------- 工作目录跟随 ----------
        // 目录一切换（loadFiles 里派发 fm:pathchange）：头部徽标实时更新；
        // 面板开着时直接切到该目录自己的会话，避免在 A 目录的对话里操作 B 目录。
        function _aiFmSyncScope() {
            if (_aiFm.running) return;                     // 任务进行中：徽标保持任务所在目录
            const path = currentPath || '';
            const scope = document.getElementById('aiFmScope');
            if (scope) { scope.textContent = path || '--'; scope.title = path; }
            if (!_aiFm.built || !_aiFm.open) return;
            if (_aiFm.sessionPath === path) return;        // 目录没变（只是刷新列表）
            const box = document.getElementById('aiFmHist');
            if (box) box.classList.remove('open');
            _aiFm.history = []; _aiFm.session = ''; _aiFm.savedMids = null;
            _aiFm.runId = ''; _aiFm.offset = 0; _aiFm.curText = ''; _aiFm.curBubble = null;
            _aiFm.stepsBox = null; _aiFm.fresh = false;
            _aiFm.sessionPath = path;
            _aiFmWelcome();
            _aiFmLoadHistory();
        }

        // 入口按钮（body.html 工具栏）+ Esc 关闭
        document.addEventListener('DOMContentLoaded', function () {
            const btn = document.getElementById('aiPanelBtn');
            if (btn) btn.addEventListener('click', _aiFmToggle);
        });
        document.addEventListener('fm:pathchange', _aiFmSyncScope);
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && _aiFm.open) _aiFmToggle();
        });

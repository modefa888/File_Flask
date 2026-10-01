        /* ==================================================================
           自定义悬停提示：全局接管所有 title 属性
           —— 悬停时摘掉 title（原生气泡不再弹），用统一气泡显示，离开时还原，
              页面里原有 title 文案完全不用改；要改提示语直接改对应 title 即可。
           ================================================================== */
        (function initHoverTip() {
            const tip = document.createElement('div');
            tip.className = 'ide-tip';
            document.body.appendChild(tip);
            let cur = null, timer = null;

            function hide() {
                clearTimeout(timer); timer = null;
                tip.classList.remove('show');
                if (cur) {
                    // 还原 title（期间若被代码改成了新文案，则不覆盖）
                    if (cur.dataset.tipText !== undefined) {
                        if (!cur.getAttribute('title')) cur.setAttribute('title', cur.dataset.tipText);
                        delete cur.dataset.tipText;
                    }
                    cur = null;
                }
            }
            function show(el) {
                const text = el.getAttribute('title') || el.dataset.tipText || '';
                if (!text.trim()) return;
                if (el.dataset.tipText === undefined) el.dataset.tipText = text;
                el.removeAttribute('title');
                tip.textContent = text;
                tip.classList.add('show');
                // 默认显示在元素下方，贴边时自动翻转/夹取
                const r = el.getBoundingClientRect(), tr = tip.getBoundingClientRect();
                const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
                let left = Math.max(6, Math.min(r.left + Math.min(6, r.width / 2), vw - tr.width - 6));
                let top = r.bottom + 8;
                if (top + tr.height > vh - 6) top = Math.max(6, r.top - tr.height - 8);
                tip.style.left = Math.round(left) + 'px';
                tip.style.top = Math.round(top) + 'px';
            }

            document.addEventListener('mouseover', (e) => {
                const el = e.target && e.target.closest ? e.target.closest('[title]') : null;
                if (!el || el === cur) return;
                hide();
                cur = el;
                timer = setTimeout(() => { if (cur === el) show(el); }, 300);
            });
            document.addEventListener('mouseout', (e) => {
                if (!cur) return;
                if (e.relatedTarget && cur.contains(e.relatedTarget)) return;
                hide();
            });
            document.addEventListener('mousedown', hide, true);
            document.addEventListener('keydown', hide, true);
            window.addEventListener('scroll', hide, true);
            window.addEventListener('blur', hide);
        })();

        // Bootstrap 异步加载，不影响初始化
        (function () {
            const script = document.createElement('script');
            script.src = '/static/vendor/bootstrap/bootstrap.bundle.min.js';
            script.onload = () => {
            };
            script.onerror = () => {
            };
            document.head.appendChild(script);
        })();
        // CodeMirror 语言模式异步加载 + SimpleMDE 异步加载
        (function () {
            // vendor/codemirror/mode 下的文件是扁平存放的（mode/css.min.js），不能写成子目录路径。
            // xml / css / javascript 需先于 htmlmixed 加载（htmlmixed 会复用它们）。
            const MODE_FILE = {
                xml: 'xml.min.js', css: 'css.min.js', javascript: 'javascript.min.js',
                htmlmixed: 'htmlmixed.min.js', clike: 'clike.min.js', python: 'python.min.js',
                ruby: 'ruby.min.js', lua: 'lua.min.js', sql: 'sql.min.js', go: 'go.min.js',
                rust: 'clike.min.js', php: 'php.min.js', markdown: 'markdown.min.js',
                yaml: 'yaml.min.js', ini: 'properties.min.js', properties: 'properties.min.js',
                shell: 'shell.min.js',
            };
            const langs = Object.keys(MODE_FILE);
            let i = 0;
            function loadLangs() {
                if (i >= langs.length) { return; }
                const s = document.createElement('script');
                s.src = '/static/vendor/codemirror/mode/' + (MODE_FILE[langs[i]] || 'javascript.min.js');
                s.onload = () => { i++; loadLangs(); };
                s.onerror = () => { i++; loadLangs(); };
                document.head.appendChild(s);
            }
            loadLangs();
            const s = document.createElement('script');
            s.src = '/static/vendor/simplemde/simplemde.min.js';
            s.onload = () => {
                // SimpleMDE 就绪，触发待搜索
                if (_pendingSearchText) { _doFind(_pendingSearchText); _pendingSearchText = ''; }
                // 通知等待中的编辑器
                window.dispatchEvent(new Event('simplemde_loaded'));
                if (window._simpleMDEReady) window._simpleMDEReady();
            };
            document.head.appendChild(s);
        })();

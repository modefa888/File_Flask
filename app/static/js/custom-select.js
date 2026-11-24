        // ========== 自定义下拉框 ==========
        // 把页面上的原生 <select> 升级成自绘下拉面板：
        // 原生 select 仍留在原地（visibility: hidden 占位），value / options / change
        // 全部照旧，所以现有业务代码（读 .value、监听 change、动态改 option）无需改动。
        (function () {
            let _cur = null;          // { wrap, sel, btn }
            let _menuEl = null;
            let _optEls = [];
            let _curIdx = -1;

            function _menu() {
                if (_menuEl && document.body.contains(_menuEl)) return _menuEl;
                _menuEl = document.createElement('div');
                _menuEl.id = 'cselectMenu';
                _menuEl.className = 'cselect-menu';
                _menuEl.setAttribute('role', 'listbox');
                _menuEl.addEventListener('mousedown', function (e) {
                    // 菜单挂在 body 上，别让 IDE / 面板的「点外部关闭」逻辑把当前面板关掉
                    e.stopPropagation();
                });
                _menuEl.addEventListener('click', function (e) {
                    e.stopPropagation();
                    const el = e.target.closest('.cselect-opt');
                    if (!el || el.classList.contains('disabled')) return;
                    _pick(Number(el.dataset.idx));
                });
                document.body.appendChild(_menuEl);
                return _menuEl;
            }

            function _close() {
                if (_menuEl) {
                    _menuEl.classList.remove('open', 'cselect-dark');
                    _menuEl.innerHTML = '';
                }
                if (_cur && _cur.btn) _cur.btn.setAttribute('aria-expanded', 'false');
                _cur = null;
                _optEls = [];
                _curIdx = -1;
            }

            function _open(wrap, sel, btn) {
                const menu = _menu();
                if (_cur && _cur.sel === sel && menu.classList.contains('open')) { _close(); return; }
                _close();
                _cur = { wrap: wrap, sel: sel, btn: btn };
                // 打开时再量一次：有些面板是先插入 DOM、稍后才显示，插入瞬间量不到宽度
                if (wrap._csFit) wrap._csFit();

                // 每次打开都按当前 options 重建，兼容动态增删选项
                const frag = document.createDocumentFragment();
                let selectedEl = null;
                for (let i = 0; i < sel.options.length; i++) {
                    const opt = sel.options[i];
                    const el = document.createElement('div');
                    el.className = 'cselect-opt'
                        + (i === sel.selectedIndex ? ' selected' : '')
                        + (opt.disabled ? ' disabled' : '');
                    el.dataset.idx = i;
                    el.setAttribute('role', 'option');
                    const txt = document.createElement('span');
                    txt.className = 'cselect-opt-txt';
                    txt.textContent = opt.text;
                    el.appendChild(txt);
                    const chk = document.createElement('i');
                    chk.className = 'bi bi-check2 cselect-check';
                    el.appendChild(chk);
                    frag.appendChild(el);
                    if (i === sel.selectedIndex) selectedEl = el;
                }
                menu.appendChild(frag);
                _optEls = Array.prototype.slice.call(menu.querySelectorAll('.cselect-opt'));
                _curIdx = sel.selectedIndex;
                if (_optEls[_curIdx]) _optEls[_curIdx].classList.add('cursor');

                // 深色工具条里的下拉（如 SQLite 预览）配深色皮肤
                const dark = !!wrap.closest('.sq-toolbar');
                menu.classList.toggle('cselect-dark', dark);
                menu.classList.add('open');
                btn.setAttribute('aria-expanded', 'true');

                // 最多显示 5 条，其余靠菜单内滚动查看（行高由主题决定，这里实测取整）
                if (_optEls.length > 5) {
                    const oh = _optEls[0].getBoundingClientRect().height;
                    if (oh > 0) {
                        // 5 行 + 上下 padding 4×2 + 边框 1×2
                        menu.style.maxHeight = Math.ceil(oh * 5 + 10) + 'px';
                    }
                } else {
                    menu.style.maxHeight = '';
                }

                // 位置：贴在触发器下方，空间不够就翻上去，靠右溢出就往左挪
                const r = btn.getBoundingClientRect();
                menu.style.minWidth = Math.max(Math.round(r.width), 120) + 'px';
                menu.style.left = '0px';
                menu.style.top = '0px';
                const mw = menu.offsetWidth;
                const mh = menu.offsetHeight;
                let left = r.left;
                if (left + mw > window.innerWidth - 8) {
                    left = Math.max(8, window.innerWidth - mw - 8);
                }
                let top = r.bottom + 6;
                if (top + mh > window.innerHeight - 8) {
                    const up = r.top - mh - 6;
                    top = up >= 8 ? up : Math.max(8, window.innerHeight - mh - 8);
                }
                menu.style.left = Math.round(left) + 'px';
                menu.style.top = Math.round(top) + 'px';
                if (selectedEl) selectedEl.scrollIntoView({ block: 'nearest' });
            }

            function _pick(i) {
                if (!_cur) return;
                const c = _cur;
                const sel = c.sel;
                if (i < 0 || i >= sel.options.length) return;
                if (sel.options[i].disabled) return;
                sel.selectedIndex = i;
                // 派发 change，触发各面板原有的事件处理
                sel.dispatchEvent(new Event('change', { bubbles: true }));
                _sync(c.wrap, sel, c.btn);
                _close();
                try { c.btn.focus({ preventScroll: true }); } catch (e) { c.btn.focus(); }
            }

            function _move(step) {
                if (!_optEls.length) return;
                let i = _curIdx;
                for (let n = 0; n < _optEls.length; n++) {
                    i = (i + step + _optEls.length) % _optEls.length;
                    if (!_optEls[i].classList.contains('disabled')) break;
                }
                _curIdx = i;
                _optEls.forEach(function (el, k) { el.classList.toggle('cursor', k === i); });
                _optEls[i].scrollIntoView({ block: 'nearest' });
            }

            function _sync(wrap, sel, btn) {
                const opt = sel.options[sel.selectedIndex] || null;
                const text = opt ? opt.text : '';
                const label = btn.querySelector('.cselect-label');
                if (label && label.textContent !== text) label.textContent = text;
                if (btn.disabled !== !!sel.disabled) btn.disabled = !!sel.disabled;
                if (btn.title !== text) btn.title = text;
            }

            function _enhance(sel) {
                if (!sel || sel.tagName !== 'SELECT') return;
                if (sel.dataset.cselect === '1') return;
                if (sel.multiple || sel.size > 1) return;        // 多选 / 列表式保持原生
                if (sel.closest('.cselect')) return;
                // IDE 里各模块已有自己的自绘下拉（dbc / api / cdl / ssh / rv / v2v / dlc…），不再重复包裹
                if (/(^|\s)\S+-sel-native(\s|$)/.test(sel.className || '')) return;
                if (sel._dbcWrap || sel._csWrap) return;
                sel.dataset.cselect = '1';

                // 设置页的 .app-select 已经自带前置图标和样式，标记一下好让 CSS 隐藏它原来的箭头
                const appHost = sel.closest('.app-select');
                if (appHost) appHost.classList.add('cselect-host');

                const wrap = document.createElement('span');
                wrap.className = 'cselect';
                sel.parentNode.insertBefore(wrap, sel);
                wrap.appendChild(sel);
                sel.classList.add('cselect-native');
                sel._csWrap = wrap;

                // 原生 select 上写死的宽 / 最大宽同步给包裹层：
                // 否则放进 flex 容器会被拉伸（例如后台的监听地址下拉写死了 170px）
                if (sel.style.width) wrap.style.width = sel.style.width;
                if (sel.style.maxWidth) wrap.style.maxWidth = sel.style.maxWidth;
                if (sel.style.minWidth) wrap.style.minWidth = sel.style.minWidth;

                // 原来是 flex:1 的下拉，包裹层要接过同样的伸缩行为
                try {
                    const cs = getComputedStyle(sel);
                    if (cs.flexGrow !== '0' || cs.flexShrink !== '1' || cs.flexBasis !== 'auto') {
                        wrap.style.flexGrow = cs.flexGrow;
                        wrap.style.flexShrink = cs.flexShrink;
                        wrap.style.flexBasis = cs.flexBasis;
                    }
                    if (cs.alignSelf !== 'auto') wrap.style.alignSelf = cs.alignSelf;
                } catch (e) { }

                // width:100% 的下拉（如 .scr-in / .notify-select）：包裹层也占满整行
                function _fitWidth() {
                    try {
                        if (wrap.style.width === '100%') return;
                        const parent = wrap.parentElement;
                        if (!parent) return;
                        const pcs = getComputedStyle(parent);
                        const pr = parent.getBoundingClientRect();
                        const sr = sel.getBoundingClientRect();
                        const pad = (parseFloat(pcs.paddingLeft) || 0) + (parseFloat(pcs.paddingRight) || 0);
                        if (sr.width > 0 && pr.width > 0 && sr.width >= pr.width - pad - 2) {
                            wrap.style.width = '100%';
                        }
                    } catch (e) { }
                }
                wrap._csFit = _fitWidth;
                _fitWidth();
                setTimeout(_fitWidth, 80);

                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'cselect-btn';
                btn.setAttribute('aria-haspopup', 'listbox');
                btn.setAttribute('aria-expanded', 'false');
                btn.innerHTML = '<span class="cselect-label"></span><i class="bi bi-chevron-down cselect-arrow"></i>';
                wrap.appendChild(btn);

                _sync(wrap, sel, btn);
                sel.addEventListener('change', function () { _sync(wrap, sel, btn); });
                btn.addEventListener('click', function (e) {
                    e.preventDefault();
                    e.stopPropagation();
                    if (sel.disabled) return;
                    _open(wrap, sel, btn);
                });
                btn.addEventListener('keydown', function (e) {
                    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                        e.preventDefault();
                        _open(wrap, sel, btn);
                    }
                });

                // 动态增删 option、切换 disabled 时自动同步显示
                try {
                    new MutationObserver(function () { _sync(wrap, sel, btn); })
                        .observe(sel, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });
                } catch (e) { }
            }

            function _scan(root) {
                if (!root || root.nodeType !== 1) return;
                if (root.tagName === 'SELECT') _enhance(root);
                if (root.querySelectorAll) {
                    root.querySelectorAll('select').forEach(_enhance);
                }
            }

            // 全局交互：点外面关闭、滚动/缩放关闭、键盘上下选择
            document.addEventListener('mousedown', function (e) {
                if (!_menuEl || !_menuEl.classList.contains('open')) return;
                if (_menuEl.contains(e.target)) return;
                if (_cur && _cur.wrap.contains(e.target)) return;
                _close();
            }, true);

            window.addEventListener('resize', _close);
            window.addEventListener('scroll', function (e) {
                if (!_menuEl || !_menuEl.classList.contains('open')) return;
                if (_menuEl.contains(e.target)) return;
                _close();
            }, true);

            document.addEventListener('keydown', function (e) {
                if (!_menuEl || !_menuEl.classList.contains('open')) return;
                if (e.key === 'Escape') {
                    // 只收起下拉，不要再触发页面级的 Esc（如清空文件勾选、关查找面板）
                    e.stopPropagation();
                    const b = _cur && _cur.btn;
                    _close();
                    if (b) { try { b.focus({ preventScroll: true }); } catch (err) { b.focus(); } }
                } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                    e.preventDefault();
                    e.stopPropagation();
                    _move(e.key === 'ArrowDown' ? 1 : -1);
                } else if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    e.stopPropagation();
                    _pick(_curIdx);
                } else if (e.key === 'Tab') {
                    _close();
                }
            }, true);

            // 有些代码会直接改 select.value（不派发 change），这里轻量兜底同步
            setInterval(function () {
                if (!_menuEl) return;
                document.querySelectorAll('select.cselect-native').forEach(function (sel) {
                    const wrap = sel.closest('.cselect');
                    if (!wrap) return;
                    const btn = wrap.querySelector('.cselect-btn');
                    if (btn) _sync(wrap, sel, btn);
                });
            }, 500);

            // 初始扫描 + 监听后续动态插入（编辑器、分享弹窗、上传记录等）
            _scan(document.body);
            new MutationObserver(function (muts) {
                for (let i = 0; i < muts.length; i++) {
                    const added = muts[i].addedNodes;
                    for (let j = 0; j < added.length; j++) {
                        if (added[j].nodeType === 1) _scan(added[j]);
                    }
                }
            }).observe(document.body, { childList: true, subtree: true });
        })();

        // ========== 框选多选：在空白处按住鼠标拖动，画出矩形选中框内条目（列表/图标/树型通用） ==========
        (function () {
            const MIN_DRAG = 4;        // 位移超过该值才认为是框选，否则按“点空白”处理
            const EDGE = 28;           // 拖到滚动容器上下边缘多少像素内开始自动滚动
            const SCROLL_STEP = 14;    // 自动滚动速度（px/帧）
            // 这些元素上的按下属于点击/拖拽文件本身，不触发框选
            const SKIP = 'button, a, input, select, textarea, label, thead, .view-sortbar, .dropdown-menu, .icon-item, tr[data-path], .tree-line';
            let _mq = null;    // 当前框选状态
            let _raf = 0;      // 拖动期间的渲染/滚动循环

            // 参与框选的条目容器（只处理当前视图）
            function _scope() {
                const id = viewMode === 'icon' ? 'iconGrid' : (viewMode === 'tree' ? 'treeContainer' : 'fileBody');
                return document.getElementById(id);
            }

            function _selector() {
                if (viewMode === 'icon') return '.icon-item[data-path]';
                if (viewMode === 'tree') return '.tree-line[data-path]';
                return 'tr[data-path]';
            }

            // 排除占位行（如上级目录）与折叠隐藏的树节点
            function _items() {
                const scope = _scope();
                if (!scope) return [];
                return Array.from(scope.querySelectorAll(_selector())).filter(el =>
                    el.dataset.parentItem !== 'true' && el.offsetParent !== null
                );
            }

            function _clearSelection() {
                selectedPaths.clear();
                document.querySelectorAll('.item-checkbox').forEach(cb => { cb.checked = false; });
                document.querySelectorAll('tr.selected, .icon-item.selected, .tree-line.selected').forEach(el => el.classList.remove('selected'));
                const sa = document.getElementById('selectAll');
                if (sa) { sa.checked = false; sa.indeterminate = false; }
            }

            function _box() {
                let box = document.getElementById('fmMarqueeBox');
                if (!box) {
                    box = document.createElement('div');
                    box.id = 'fmMarqueeBox';
                    box.className = 'fm-marquee-box';
                    document.body.appendChild(box);
                }
                return box;
            }

            // 选择框矩形：跟随鼠标，并裁剪到当前滚动容器的可视范围内（配合边缘自动滚动）
            function _rect() {
                const c = _mq.container.getBoundingClientRect();
                const x1 = Math.min(_mq.startX, _mq.lastX);
                const x2 = Math.max(_mq.startX, _mq.lastX);
                const y1 = Math.min(_mq.startY, _mq.lastY);
                const y2 = Math.max(_mq.startY, _mq.lastY);
                const left = Math.max(c.left, x1);
                const right = Math.min(c.right, x2);
                const top = Math.max(c.top, y1);
                const bottom = Math.min(c.bottom, y2);
                return {
                    left,
                    top,
                    width: Math.max(0, right - left),
                    height: Math.max(0, bottom - top),
                };
            }

            // 命中即选中：矩形与条目外框相交；Ctrl/⌘/Shift 拖动时保留原有选择（追加）
            function _apply(rect) {
                const items = _items();
                if (!items.length) return;
                const right = rect.left + rect.width;
                const bottom = rect.top + rect.height;
                let changed = false;
                for (const el of items) {
                    const r = el.getBoundingClientRect();
                    const hit = r.right > rect.left && r.left < right && r.bottom > rect.top && r.top < bottom;
                    const path = el.dataset.path;
                    if (path == null) continue;
                    const on = hit || (_mq.additive && _mq.base.has(path));
                    const cb = el.querySelector('.item-checkbox');
                    if (cb && cb.checked !== on) cb.checked = on;
                    el.classList.toggle('selected', on);
                    if (on) {
                        if (!selectedPaths.has(path)) { selectedPaths.add(path); changed = true; }
                    } else if (selectedPaths.delete(path)) {
                        changed = true;
                    }
                }
                if (!changed) return;
                updateSelectedCount();
                updateBatchDeleteBtn();
                if (viewMode === 'list' && typeof updateSelectAllState === 'function') updateSelectAllState();
            }

            function _begin() {
                _mq.active = true;
                if (!_mq.additive) _clearSelection();
                document.body.classList.add('fm-marquee-on');
                _box().style.display = 'block';
                // 清掉按下瞬间可能已经产生的文字选区
                try {
                    const sel = window.getSelection();
                    if (sel && sel.removeAllRanges) sel.removeAllRanges();
                } catch (err) { /* 忽略 */ }
                // 拖动经过图片/视频卡片时不要弹出悬浮大图预览
                if (typeof _hideHoverPreview === 'function') _hideHoverPreview();
                updateSelectedCount();
                updateBatchDeleteBtn();
                if (!_raf) _raf = requestAnimationFrame(_tick);
            }

            // 拖到容器上下边缘时自动滚动，滚动了就重算命中
            function _scroll() {
                const c = _mq.container;
                if (c.scrollHeight <= c.clientHeight + 1) return false;
                const r = c.getBoundingClientRect();
                let dir = 0;
                if (_mq.lastY < r.top + EDGE) dir = -1;
                else if (_mq.lastY > r.bottom - EDGE) dir = 1;
                if (!dir) return false;
                const before = c.scrollTop;
                c.scrollTop = before + dir * SCROLL_STEP;
                return c.scrollTop !== before;
            }

            function _render() {
                const rect = _rect();
                const box = _box();
                box.style.left = rect.left + 'px';
                box.style.top = rect.top + 'px';
                box.style.width = rect.width + 'px';
                box.style.height = rect.height + 'px';
                _apply(rect);
            }

            // 拖动到边缘的自动滚动：跑在 rAF 上（普通移动不依赖 rAF，鼠标一动就重算）
            function _tick() {
                if (!_mq) { _raf = 0; return; }
                _raf = requestAnimationFrame(_tick);
                if (!_mq.active) return;
                if (_scroll()) _render();
            }

            function _onDown(e) {
                if (e.button !== 0 || !e.target || !e.target.closest) return;
                if (e.target.closest(SKIP)) return;
                const container = e.target.closest('.table-container');
                if (!container) return;
                _mq = {
                    startX: e.clientX,
                    startY: e.clientY,
                    lastX: e.clientX,
                    lastY: e.clientY,
                    additive: !!(e.ctrlKey || e.metaKey || e.shiftKey),   // 按下时的修饰键决定“替换/追加”
                    active: false,
                    container,
                    base: new Set(selectedPaths),
                };
                // 只加一个禁选文字的类：不 preventDefault，保证点空白处仍能正常让输入框失焦
                document.body.classList.add('fm-marquee-hold');
                document.addEventListener('mousemove', _onMove, true);
                document.addEventListener('mouseup', _onUp, true);
                window.addEventListener('blur', _onUp, true);
                if (!_raf) _raf = requestAnimationFrame(_tick);
            }

            function _onMove(e) {
                if (!_mq) return;
                _mq.lastX = e.clientX;
                _mq.lastY = e.clientY;
                if (!_mq.active) {
                    const dx = Math.abs(e.clientX - _mq.startX);
                    const dy = Math.abs(e.clientY - _mq.startY);
                    if (dx < MIN_DRAG && dy < MIN_DRAG) return;   // 还没拖开：仍按“点击空白”处理
                    _begin();
                }
                _render();
            }

            function _onUp() {
                if (!_mq) return;
                const wasActive = _mq.active;
                _mq = null;
                document.removeEventListener('mousemove', _onMove, true);
                document.removeEventListener('mouseup', _onUp, true);
                window.removeEventListener('blur', _onUp, true);
                if (_raf) { cancelAnimationFrame(_raf); _raf = 0; }
                document.body.classList.remove('fm-marquee-on', 'fm-marquee-hold');
                const box = document.getElementById('fmMarqueeBox');
                if (box) box.style.display = 'none';
                if (wasActive) {
                    // 供“双击空白处切换多选模式”识别拖动的尾巴，避免误触
                    window._fmMarqueeDraggedAt = Date.now();
                    // 鼠标松开时正停在卡片上：别让拖动期间积攒的悬浮预览立刻弹出来
                    if (typeof _hideHoverPreview === 'function') _hideHoverPreview();
                    const hp = document.querySelector('.icon-hover-preview');
                    if (hp) hp.classList.remove('visible');
                    updateSelectedCount();
                    updateBatchDeleteBtn();
                    // 框出了条目就自动进入多选状态：显示勾选框与底部操作栏，可直接移动/复制/删除
                    if (selectedPaths.size > 0 && !selectMode) toggleSelectMode();
                }
            }

            document.addEventListener('mousedown', _onDown, true);
        })();

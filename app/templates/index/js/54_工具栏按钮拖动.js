        // ========== 悬浮球拖动：全盘搜索 / 媒体集合收起后的圆球，按住拖到任意位置，双击复位 ==========
        // 目标：#searchCollapsedBtn（搜索收起球）、#mediaCollapsedBtn（媒体集合收起球）
        // · 两个球都是面板「收起」时才动态创建的，所以用 MutationObserver 等它们出现再绑定；
        // · 移动超过 4px 才算拖动，原地点一下仍是「展开面板」的点击；
        // · 拖动中跟手（禁用自身的 hover 缩放过渡），松手停在原地并写入 localStorage；
        // · 双击复位：清掉内联样式回到 CSS 默认位置（右上角），位置记录一并清除；
        // · 刷新页面后自动恢复上次位置（球显示出来时才应用，隐藏时不量尺寸）。
        (function () {
            const STORE_KEY = 'fm_ball_drag_pos_v2';
            const THRESHOLD = 4;   // 超过 4px 才算拖动，否则当点击
            const TARGETS = ['#searchCollapsedBtn', '#mediaCollapsedBtn'];

            const _bound = new WeakSet();
            let _drag = null;      // { el, moved, startX, startY, offX, offY, w, h }
            // 位置缓存：只在启动时读一次 localStorage，之后读写都走内存
            // （MutationObserver 回调很频繁，不能每次都 JSON.parse）
            let _posCache = null;

            // ---------- 位置持久化 ----------
            function _loadAll() {
                if (_posCache) return _posCache;
                try { _posCache = JSON.parse(localStorage.getItem(STORE_KEY) || '{}'); }
                catch (e) { _posCache = {}; }
                // v1 → v2 迁移：搜索球保留原来拖到的位置；
                // 眼睛球不迁移，按新默认位置（右下角）显示
                try {
                    const old = JSON.parse(localStorage.getItem('fm_ball_drag_pos_v1') || '{}');
                    if (old && old.searchCollapsedBtn && !_posCache.searchCollapsedBtn) {
                        _posCache.searchCollapsedBtn = old.searchCollapsedBtn;
                    }
                } catch (e) { /* 旧数据损坏就忽略 */ }
                return _posCache;
            }

            function _saveAll() {
                try { localStorage.setItem(STORE_KEY, JSON.stringify(_posCache || {})); }
                catch (e) { /* 隐私模式等忽略 */ }
            }

            function _savePos(el, left, top) {
                if (!el.id) return;
                _loadAll()[el.id] = { left: Math.round(left), top: Math.round(top) };
                _saveAll();
            }

            // 把位置夹回可视区内，避免窗口缩小后球跑出屏幕
            function _clamp(left, top, w, h) {
                const maxL = Math.max(0, window.innerWidth - w - 2);
                const maxT = Math.max(0, window.innerHeight - h - 2);
                return {
                    left: Math.min(Math.max(2, left), maxL),
                    top: Math.min(Math.max(2, top), maxT),
                };
            }

            function _isVisible(el) {
                return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
            }

            // ---------- 提示气泡跟随：搜索球的「点击展开搜索结果」气泡默认
            // 固定在右上角（top:134px / right:18px），球拖走后要让它跟着球走 ----------
            // ---------- 从默认位置拖出 / 应用保存位置：转 left/top 定位 ----------
            // 尺寸一律用 offsetWidth/offsetHeight（布局尺寸，不受 transform 影响）：
            // getBoundingClientRect 会把 hover 的 scale(1.12) 也量进去，
            // 反复拖几次宽度会滚雪球（52 → 58 → 65 → …），球就越拖越大。
            // 量之前先清掉内联宽高：球自身 CSS 就是 52px 定宽，无需内联尺寸，
            // 同时能把上一版遗留的膨胀内联宽度一并清掉（自愈）。
            function _detach(el) {
                el.style.width = '';
                el.style.height = '';
                const r = el.getBoundingClientRect();
                const w = el.offsetWidth || r.width;
                const h = el.offsetHeight || r.height;
                // 位置按「中心缩放」反推回未缩放坐标，避免 hover 放大时抓取点偏移
                const left = r.left + (r.width - w) / 2;
                const top = r.top + (r.height - h) / 2;
                el.style.left = left + 'px';
                el.style.top = top + 'px';
                el.style.right = 'auto';
                el.style.bottom = 'auto';
                return { left: left, top: top, width: w, height: h };
            }

            // ---------- 恢复上次位置（只在球可见时应用，隐藏时量不到尺寸） ----------
            function _applySaved(el) {
                if (!el.id || !_isVisible(el)) return;
                const p = _loadAll()[el.id];
                if (!p) return;
                const r = _detach(el);
                const c = _clamp(p.left, p.top, r.width, r.height);
                el.style.left = c.left + 'px';
                el.style.top = c.top + 'px';
                el.classList.add('tb-drag-float');
            }

            // ---------- 拖动逻辑（Pointer Events，鼠标 / 触屏通吃） ----------
            function _onPointerDown(e) {
                if (e.pointerType === 'mouse' && e.button !== 0) return;
                const el = e.currentTarget;
                const r = el.getBoundingClientRect();
                // 用布局尺寸反推未缩放位置，抵消 hover 放大造成的抓取点偏移
                const w = el.offsetWidth || r.width;
                const h = el.offsetHeight || r.height;
                const left = r.left + (r.width - w) / 2;
                const top = r.top + (r.height - h) / 2;
                _drag = {
                    el: el,
                    moved: false,
                    startX: e.clientX,
                    startY: e.clientY,
                    offX: e.clientX - left,
                    offY: e.clientY - top,
                    w: w,
                    h: h,
                };
                try { el.setPointerCapture(e.pointerId); } catch (err) { /* 老浏览器忽略 */ }
                el.addEventListener('pointermove', _onPointerMove);
                el.addEventListener('pointerup', _onPointerUp);
                el.addEventListener('pointercancel', _onPointerUp);
            }

            function _onPointerMove(e) {
                if (!_drag) return;
                const dx = e.clientX - _drag.startX;
                const dy = e.clientY - _drag.startY;
                if (!_drag.moved) {
                    if (Math.abs(dx) < THRESHOLD && Math.abs(dy) < THRESHOLD) return;
                    _drag.moved = true;
                    const el = _drag.el;
                    const r = _detach(el);          // 先按当前位置转 left/top，再跟手
                    _drag.w = r.width; _drag.h = r.height;
                    el.classList.add('tb-dragging');
                    document.body.classList.add('tb-drag-active');
                }
                e.preventDefault();
                const c = _clamp(e.clientX - _drag.offX, e.clientY - _drag.offY, _drag.w, _drag.h);
                _drag.el.style.left = c.left + 'px';
                _drag.el.style.top = c.top + 'px';
            }

            function _onPointerUp(e) {
                if (!_drag) return;
                const el = _drag.el;
                const moved = _drag.moved;
                el.removeEventListener('pointermove', _onPointerMove);
                el.removeEventListener('pointerup', _onPointerUp);
                el.removeEventListener('pointercancel', _onPointerUp);
                el.classList.remove('tb-dragging');
                document.body.classList.remove('tb-drag-active');
                if (moved) {
                    _savePos(el, parseFloat(el.style.left), parseFloat(el.style.top));
                    el.classList.add('tb-drag-float');
                    // 拖完松手紧接着会冒出一个 click，吃掉它，防止误展开面板
                    _suppressClick(el);
                }
                _drag = null;
            }

            function _suppressClick(el) {
                const kill = function (e) {
                    e.stopPropagation();
                    e.preventDefault();
                    el.removeEventListener('click', kill, true);
                };
                el.addEventListener('click', kill, true);
            }

            // 窗口缩放时把悬浮球夹回可视区
            function _onResize() {
                TARGETS.forEach(function (sel) {
                    const el = document.querySelector(sel);
                    if (!el || !el.classList.contains('tb-drag-float')) return;
                    const w = el.offsetWidth || 52;
                    const h = el.offsetHeight || 52;
                    const c = _clamp(parseFloat(el.style.left) || 0, parseFloat(el.style.top) || 0, w, h);
                    el.style.left = c.left + 'px';
                    el.style.top = c.top + 'px';
                });
            }

            // ---------- 绑定（球是收起时才创建的，需要反复尝试） ----------
            function _tryBind() {
                TARGETS.forEach(function (sel) {
                    const el = document.querySelector(sel);
                    if (!el || _bound.has(el)) return;
                    _bound.add(el);
                    el.classList.add('tb-draggable');
                    el.title = (el.title ? el.title + ' ' : '') + '（按住可拖动）';
                    el.addEventListener('pointerdown', _onPointerDown);
                });
            }

            // 球出现 / 由隐藏变可见时：补绑定 + 恢复保存的位置
            function _onMutation() {
                _tryBind();
                if (_drag) return;   // 拖动中 style 一直在变，别用旧位置覆盖跟手坐标
                TARGETS.forEach(function (sel) {
                    const el = document.querySelector(sel);
                    if (el && _isVisible(el) && !el.classList.contains('tb-drag-float') &&
                        !el.classList.contains('tb-dragging') && _loadAll()[el.id]) {
                        _applySaved(el);
                    }
                });
            }

            function _init() {
                _tryBind();
                // 两个球都是 JS 动态创建（收起面板时才插入 DOM），用观察器等它们出现
                const mo = new MutationObserver(_onMutation);
                mo.observe(document.body, {
                    childList: true, subtree: true,
                    attributes: true, attributeFilter: ['style', 'class'],
                });
                window.addEventListener('resize', _onResize);
            }

            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', _init);
            } else {
                _init();
            }
        })();

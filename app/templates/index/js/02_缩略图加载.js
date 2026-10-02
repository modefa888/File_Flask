        // ========== 缩略图加载 ==========
        // 服务端已做磁盘缓存 + ETag，浏览器也会本地缓存（Cache-Control: max-age=7天）。
        // 前端直接使用 <img src> 而不是 fetch+blob，好处：
        //   1. 刷新页面时浏览器直接命中 HTTP 磁盘缓存，不再发请求，也不重复 ffmpeg 抽帧；
        //   2. 配合 loading="lazy" 只加载可视区域内的缩略图。
        // 仍保留并发闸门（仅针对首次未缓存的请求）避免一次性启动大量 ffmpeg 进程。
        const _THUMB_MAX_CONCURRENT = 3;
        let _thumbActive = 0;
        const _thumbQueue = [];
        const _durationCache = {};   // 视频时长文本缓存（"3:45"），避免重复请求

        function _fmtDur(sec) {
            sec = Math.round(sec);
            const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
            const two = (n) => String(n).padStart(2, '0');
            return h ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
        }

        function _thumbUrl(path) {
            return `/api/thumbnail?path=${encodeURIComponent(path)}`;
        }

        function _pumpThumbQueue() {
            while (_thumbActive < _THUMB_MAX_CONCURRENT && _thumbQueue.length) {
                const task = _thumbQueue.shift();
                if (!task.el.isConnected) continue;   // 元素已被移除，跳过
                _thumbActive++;
                task.run(() => { _thumbActive--; _pumpThumbQueue(); });
            }
        }

        function _renderThumbAsync(thumbEl, path) {
            // 已渲染过（同一 DOM 节点重复调用）直接跳过
            if (thumbEl.dataset.thumbDone === '1') return;
            // 内存缓存命中：立即渲染，不占并发额度
            const cached = _thumbnailCache[path];
            if (cached) { _renderThumb(thumbEl, cached); return; }
            _thumbQueue.push({
                el: thumbEl,
                run: (done) => {
                    const img = new Image();
                    img.decoding = 'async';
                    img.onload = () => {
                        // 视频封面数据量小，转 dataURL 存入内存缓存，切换视图/目录时秒开
                        try {
                            const c = document.createElement('canvas');
                            c.width = img.naturalWidth;
                            c.height = img.naturalHeight;
                            c.getContext('2d').drawImage(img, 0, 0);
                            _thumbnailCache[path] = c.toDataURL('image/jpeg', 0.85);
                        } catch (err) { /* 跨域等异常忽略，不影响显示 */ }
                        _renderThumb(thumbEl, _thumbUrl(path));
                        done();
                    };
                    img.onerror = () => { done(); };
                    img.src = _thumbUrl(path);
                }
            });
            _pumpThumbQueue();
        }

        function _renderThumb(thumbEl, src) {
            const icon = thumbEl.querySelector('.thumb-icon');
            if (icon) {
                // 绝对定位铺满 .icon-thumb 取景框（span 本身只有图标大小，不能靠 100% 撑满）
                icon.innerHTML = `<img src="${src}" alt="" loading="lazy" decoding="async" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;border-radius:6px;" />`;
                icon.classList.add('has-thumb');
                // 竖屏封面（高>宽）：切换为 contain 完整显示，不裁切
                const im = icon.querySelector('img');
                if (im) im.addEventListener('load', () => {
                    if (im.naturalHeight > im.naturalWidth) thumbEl.classList.add('portrait');
                }, { once: true });
            }
            // 视频卡片：异步获取时长，显示在封面左上角角标
            if (thumbEl.dataset.thumbType === 'video' && !thumbEl.querySelector('.thumb-duration')) {
                const vp = thumbEl.dataset.thumbPath;
                const showDur = (txt) => {
                    const s = document.createElement('span');
                    s.className = 'thumb-duration';
                    s.textContent = txt;
                    thumbEl.appendChild(s);
                };
                if (_durationCache[vp]) { showDur(_durationCache[vp]); }
                else {
                    fetch(`/api/video_duration?path=${encodeURIComponent(vp)}`)
                        .then(r => r.ok ? r.json() : null)
                        .then(d => {
                            if (d && typeof d.duration === 'number') {
                                const txt = _fmtDur(d.duration);
                                _durationCache[vp] = txt;
                                if (thumbEl.isConnected) showDur(txt);
                            }
                        })
                        .catch(() => {});
                }
            }
            thumbEl.dataset.thumbDone = '1';
        }

        function _loadIconThumbnails(grid) {
            const thumbs = Array.from(grid.querySelectorAll('.icon-thumb[data-thumb-path]'));
            if (!thumbs.length) return;
            // 优先加载可视区域内的缩略图，其余进入队列
            if (!('IntersectionObserver' in window)) {
                thumbs.forEach(el => _renderThumbAsync(el, el.dataset.thumbPath));
                return;
            }
            const io = new IntersectionObserver((entries) => {
                entries.forEach(entry => {
                    if (!entry.isIntersecting) return;
                    const el = entry.target;
                    io.unobserve(el);
                    _renderThumbAsync(el, el.dataset.thumbPath);
                });
            }, { root: null, rootMargin: '200px 0px', threshold: 0.01 });
            thumbs.forEach(el => {
                if (el.dataset.thumbDone === '1') return;
                io.observe(el);
            });
        }

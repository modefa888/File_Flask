        // ========== 文件预览 ==========
        const _TEXT_EXTS = new Set(['txt', 'md', 'py', 'js', 'ts', 'jsx', 'tsx', 'html', 'htm', 'css', 'scss', 'less', 'json', 'xml', 'yml', 'yaml', 'ini', 'cfg', 'conf', 'env', 'sh', 'bat', 'ps1', 'rs', 'go', 'java', 'c', 'cpp', 'h', 'hpp', 'cs', 'rb', 'php', 'sql', 'log', 'csv', 'toml']);
        const _IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico']);
        const _VIDEO_EXTS = new Set(['mp4', 'webm', 'mkv', 'avi', 'mov', 'm4v', 'ogg', 'flv']);

        // 视频预览的键盘监听清理函数：由 previewFile 内部赋值，closePreview 时调用
        let _videoPreviewUnbind = null;

        function _canPreview(ext) {
            const e = (ext || '').toLowerCase();
            // 视频走 /api/stream 流式播放（支持 Range，边下边播），不会把整个文件读进内存
            return _TEXT_EXTS.has(e) || _IMAGE_EXTS.has(e) || _VIDEO_EXTS.has(e);
        }

        // 压缩包内成员：视频必须先整体解压才能播放，大文件会占满内存，因此仅支持下载
        function _canPreviewZipMember(ext) {
            const e = (ext || '').toLowerCase();
            return _TEXT_EXTS.has(e) || _IMAGE_EXTS.has(e);
        }

        function _escapeHtml(str) {
            return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        }

        function previewFile(absPath) {
            const ext = (absPath.split('.').pop() || '').toLowerCase();
            // 上一次视频预览可能仍挂着方向键监听，切换前先清理
            if (_videoPreviewUnbind) {
                try { _videoPreviewUnbind(); } catch (err) { /* ignore */ }
                _videoPreviewUnbind = null;
            }
            if (_isZip(ext)) {
                openZipViewer(absPath, '');
                return;
            }
            if (!_canPreview(ext)) return;
            const container = document.getElementById('previewContainer');
            const extLabel = ext ? ext.toUpperCase() : '未知';
            const fileName = absPath.split('/').pop();
            const isTextFile = _TEXT_EXTS.has(ext);
            const isVideoFile = _VIDEO_EXTS.has(ext);
            container.innerHTML = `
            <div class="preview-overlay">
                <div class="preview-modal">
                    <div class="preview-header">
                        <div style="display:flex;align-items:center;justify-content:space-between;flex:1;min-width:0;">
                            <div class="preview-title" style="display:flex;align-items:center;gap:8px;overflow:hidden;">
                                <span><i class="bi bi-eye"></i></span>
                                <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${fileName}</span>
                            </div>
                            <div class="preview-actions">
                                ${isTextFile ? `<button class="btn" id="previewEditBtn" style="background:#2563eb;color:white;padding:4px 10px;border-radius:6px;border:none;cursor:pointer;font-size:0.78rem;display:flex;align-items:center;gap:4px;"><i class="bi bi-pencil-square"></i> 编辑</button>` : ''}
                                <button class="btn btn-copy" id="previewCopyBtn"><i class="bi bi-clipboard"></i> 复制</button>
                                <button class="btn btn-close-preview" id="previewCloseBtn"><i class="bi bi-x-lg"></i></button>
                            </div>
                        </div>
                        ${isVideoFile ? '' : `<span class="file-path" style="display:block;width:100%;font-size:0.7rem;color:#718096;font-family:monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:4px 0 0 26px;">.${extLabel} · ${absPath}</span>`}
                    </div>
                    <div class="preview-body preview-loading">
                        <div class="spinner-border" role="status"></div>
                    </div>
                </div>
            </div>
        `;
            document.getElementById('previewCloseBtn').addEventListener('click', closePreview);
            document.getElementById('previewCopyBtn').addEventListener('click', _copyPreview);
            if (isTextFile) {
                document.getElementById('previewEditBtn').addEventListener('click', () => {
                    closePreview();
                    openEditor(absPath, false);
                });
            }
            // 只允许点右上角「×」关闭，点击遮罩/其他区域不关闭
            container.querySelector('.preview-overlay').addEventListener('click', (e) => e.stopPropagation());
            const body = container.querySelector('.preview-body');

            // 视频键盘快进/快退：单击方向键 ±5s
            const SEEK_STEP = 5;
            let videoKeyHandler = null;
            let videoTipTimer = null;
            let videoTipHideTimer = null;
            // 自定义播放器的额外清理（空格/M/F 键、自动隐藏等），由 _bindVideoPlayer 返回
            let _videoExtraCleanup = null;

            // 快进/快退屏幕提示（显示在播放控制条上方）
            function showSeekTip(text, icon) {
                const tip = body.querySelector('.video-seek-tip');
                if (!tip) return;
                tip.innerHTML = `<i class="bi ${icon}"></i> ${text}`;
                tip.style.opacity = '1';
                tip.style.transform = 'translate(-50%, 0)';
                clearTimeout(videoTipTimer);
                videoTipTimer = setTimeout(() => {
                    tip.style.opacity = '0';
                    tip.style.transform = 'translate(-50%, 8px)';
                }, 800);
            }

            function bindVideoKeys() {
                const video = body.querySelector('video');
                if (!video || videoKeyHandler) return;
                // 锁定默认步长（部分浏览器/UA 下默认方向键步长为 10s，仅作用于本视频元素）
                try { video.setAttribute('data-seek-step', SEEK_STEP); } catch (err) { /* ignore */ }
                videoKeyHandler = function (e) {
                    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
                    // 避免在输入框中触发
                    const tag = (e.target && e.target.tagName || '').toLowerCase();
                    if (tag === 'input' || tag === 'textarea' || (e.target && e.target.isContentEditable)) return;
                    // 阻止浏览器默认的 10s 步进，统一为 5s
                    e.preventDefault();
                    e.stopPropagation();
                    const dur = isFinite(video.duration) ? video.duration : Infinity;
                    if (e.key === 'ArrowRight') {
                        video.currentTime = Math.min(dur, video.currentTime + SEEK_STEP);
                        showSeekTip('快进 5 秒', 'bi-chevron-double-right');
                    } else {
                        video.currentTime = Math.max(0, video.currentTime - SEEK_STEP);
                        showSeekTip('后退 5 秒', 'bi-chevron-double-left');
                    }
                };
                // 捕获阶段拦截，确保先于默认行为执行
                document.addEventListener('keydown', videoKeyHandler, true);
            }
            function unbindVideoKeys() {
                if (videoKeyHandler) {
                    document.removeEventListener('keydown', videoKeyHandler, true);
                    videoKeyHandler = null;
                }
                clearTimeout(videoTipTimer);
                videoTipTimer = null;
                clearTimeout(videoTipHideTimer);
                videoTipHideTimer = null;
                if (_videoExtraCleanup) {
                    try { _videoExtraCleanup(); } catch (err) { /* ignore */ }
                    _videoExtraCleanup = null;
                }
            }
            // 暴露给 closePreview：关闭预览时解绑方向键监听，避免方向键被全局拦截
            _videoPreviewUnbind = unbindVideoKeys;

            // Esc 不再退出预览，只能点右上角「×」关闭
            fetch(`/api/preview?path=${encodeURIComponent(absPath)}`)
                .then(r => r.json())
                .then(data => {
                    if (data.error) {
                        body.className = 'preview-body preview-error';
                        body.innerHTML = `<i class="bi bi-exclamation-circle"></i><span>${data.error}</span>`;
                        document.getElementById('previewCopyBtn').style.display = 'none';
                        return;
                    }
                    if (data.type === 'image') {
                        document.getElementById('previewCopyBtn').style.display = 'none';
                        body.className = 'preview-body preview-image';
                        body.innerHTML = `<img src="data:${data.content_type || 'image/png'};base64,${data.content}" alt="${fileName}" />`;
                    } else if (data.type === 'video') {
                        document.getElementById('previewCopyBtn').style.display = 'none';
                        body.className = 'preview-body preview-video has-playlist';
                        // 视频弹窗加宽，给右侧播放列表留空间；列表条目绝对定位在「视频区」内
                        document.querySelector('#previewContainer .preview-modal').classList.add('preview-wide');
                        body.innerHTML = `
                        <div class="video-stage">
                            <div class="video-info" style="position:absolute;top:10px;left:10px;background:rgba(0,0,0,0.7);color:white;padding:4px 10px;border-radius:6px;font-size:0.75rem;z-index:10;">
                                ${data.size_str || ''}
                            </div>
                            <video autoplay playsinline style="width:100%;height:100%;">
                                <source src="${data.stream_url}" type="${data.content_type}">
                                您的浏览器不支持视频播放
                            </video>
                            <div class="video-seek-tip" style="position:absolute;bottom:92px;left:50%;transform:translate(-50%,8px);background:rgba(0,0,0,0.72);color:#fff;padding:8px 16px;border-radius:8px;font-size:0.85rem;font-weight:600;z-index:20;pointer-events:none;opacity:0;transition:opacity .2s ease,transform .2s ease;display:flex;align-items:center;gap:6px;white-space:nowrap;"></div>
                            <div class="video-tip" style="position:absolute;bottom:72px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,0.6);color:#fff;padding:4px 10px;border-radius:6px;font-size:0.72rem;z-index:10;opacity:0;transition:opacity .3s ease;pointer-events:none;">
                                <i class="bi bi-keyboard"></i> 空格 播放/暂停 &nbsp;·&nbsp; ← → 快退/快进 5s &nbsp;·&nbsp; M 静音 &nbsp;·&nbsp; F 全屏
                            </div>
                            <div class="vp-controls">
                                <div class="vpc-progress">
                                    <div class="vpc-track">
                                        <div class="vpc-buffered"></div>
                                        <div class="vpc-played"></div>
                                        <div class="vpc-knob"></div>
                                    </div>
                                </div>
                                <div class="vpc-row">
                                    <button class="vpc-btn vpc-play" title="播放/暂停 (空格)"><i class="bi bi-pause-fill"></i></button>
                                    <div class="vpc-vol">
                                        <button class="vpc-btn vpc-mute" title="静音 (M)"><i class="bi bi-volume-up-fill"></i></button>
                                        <input type="range" class="vpc-vol-range" min="0" max="1" step="0.01" value="1" title="音量旋钮">
                                    </div>
                                    <span class="vpc-time">00:00 / 00:00</span>
                                    <div class="vpc-spacer"></div>
                                    <div class="vpc-speed">
                                        <button class="vpc-btn vpc-speed-btn" title="倍速播放"><span class="vpc-speed-cur">1.0x</span></button>
                                        <div class="vpc-speed-menu">
                                            <button class="vpc-speed-item" data-rate="0.5">0.5x</button>
                                            <button class="vpc-speed-item" data-rate="0.75">0.75x</button>
                                            <button class="vpc-speed-item active" data-rate="1">1.0x</button>
                                            <button class="vpc-speed-item" data-rate="1.25">1.25x</button>
                                            <button class="vpc-speed-item" data-rate="1.5">1.5x</button>
                                            <button class="vpc-speed-item" data-rate="2">2.0x</button>
                                        </div>
                                    </div>
                                    <button class="vpc-btn vpc-mode" title="播放模式：顺序播放"><i class="bi bi-list-ol"></i></button>
                                    <button class="vpc-btn vpc-rotate" title="旋转画面 90°"><i class="bi bi-arrow-clockwise"></i></button>
                                    <button class="vpc-btn vpc-pip" title="画中画"><svg class="vpc-svg" viewBox="0 0 16 16" fill="currentColor" width="1em" height="1em" aria-hidden="true"><path d="M1.5 2A1.5 1.5 0 0 0 0 3.5v9A1.5 1.5 0 0 0 1.5 14h13a1.5 1.5 0 0 0 1.5-1.5v-9A1.5 1.5 0 0 0 14.5 2h-13zM1 3.5a.5.5 0 0 1 .5-.5h13a.5.5 0 0 1 .5.5v9a.5.5 0 0 1-.5.5h-13a.5.5 0 0 1-.5-.5v-9z"/><path d="M7.5 6a.5.5 0 0 0-.5.5v3a.5.5 0 0 0 .5.5h5a.5.5 0 0 0 .5-.5v-3a.5.5 0 0 0-.5-.5h-5z"/></svg></button>
                                    <button class="vpc-btn vpc-full" title="全屏 (F)"><i class="bi bi-fullscreen"></i></button>
                                </div>
                            </div>
                        </div>
                        <div class="video-playlist">
                            <div class="vp-head"><i class="bi bi-collection-play"></i> 播放列表 <span class="vp-count">…</span></div>
                            <div class="vp-list"><div class="vp-empty"><i class="bi bi-hourglass-split"></i>正在加载列表…</div></div>
                        </div>`;
                        bindVideoKeys();
                        _videoExtraCleanup = _bindVideoPlayer(body, showSeekTip);
                        _vpCurrentVideo = absPath;
                        _buildVideoPlaylist(absPath, body);
                        // 播放前 3 秒显示快捷键提示，之后自动淡出
                        const tipEl = body.querySelector('.video-tip');
                        if (tipEl) {
                            tipEl.style.opacity = '1';
                            clearTimeout(videoTipHideTimer);
                            videoTipHideTimer = setTimeout(() => { tipEl.style.opacity = '0'; }, 3000);
                        }
                    } else {
                        body.className = 'preview-body preview-text';
                        const bytes = Uint8Array.from(atob(data.content), c => c.charCodeAt(0));
                        const decoded = new TextDecoder('utf-8').decode(bytes);
                        body.innerHTML = `<pre>${_escapeHtml(decoded)}</pre>`;
                        document.getElementById('previewCopyBtn').style.display = '';
                    }
                })
                .catch(err => {
                    body.className = 'preview-body preview-error';
                    body.innerHTML = `<i class="bi bi-exclamation-circle"></i><span>加载失败: ${err.message}</span>`;
                    document.getElementById('previewCopyBtn').style.display = 'none';
                });
        }

        // ===== 自定义播放器控制条：进度拖拽 / 音量旋钮 / 倍速 / 播放模式 / 旋转 / 画中画 / 全屏 =====
        // 返回清理函数（解除空格、M、F 键等全局监听），由 previewFile 在关闭/切换时调用
        let _vpDocClickBound = false;   // 「点击空白处收起倍速菜单」的全局监听只绑一次
        let _vpPlayMode = 'order';      // 播放模式：order 顺序 / loop 循环 / shuffle 随机（切换视频时保留）

        function _bindVideoPlayer(body, showSeekTip) {
            const video = body.querySelector('video');
            const stage = body.querySelector('.video-stage');
            if (!video || !stage) return null;

            const $ = sel => body.querySelector(sel);
            const playBtn = $('.vpc-play'), muteBtn = $('.vpc-mute'), volRange = $('.vpc-vol-range');
            const timeEl = $('.vpc-time'), progress = $('.vpc-progress');
            const played = $('.vpc-played'), buffered = $('.vpc-buffered'), knob = $('.vpc-knob');
            const speedWrap = $('.vpc-speed'), speedCur = $('.vpc-speed-cur');
            const modeBtn = $('.vpc-mode'), rotateBtn = $('.vpc-rotate'), pipBtn = $('.vpc-pip'), fullBtn = $('.vpc-full');

            const fmt = s => {
                if (!isFinite(s)) return '--:--';
                s = Math.max(0, Math.floor(s));
                const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
                const mm = String(m).padStart(2, '0'), ss = String(sec).padStart(2, '0');
                return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
            };
            const togglePlay = () => { video.paused ? video.play().catch(() => {}) : video.pause(); };

            // 播放/暂停：按钮 + 点击画面；双击画面全屏
            const setPlayIcon = () => {
                playBtn.innerHTML = `<i class="bi ${video.paused ? 'bi-play-fill' : 'bi-pause-fill'}"></i>`;
            };
            playBtn.addEventListener('click', togglePlay);
            video.addEventListener('click', togglePlay);
            video.addEventListener('dblclick', () => fullBtn.click());
            video.addEventListener('play', setPlayIcon);
            video.addEventListener('pause', setPlayIcon);
            setPlayIcon();

            // 进度条 + 时间显示
            const updateProgress = () => {
                const dur = video.duration || 0;
                const pct = dur ? video.currentTime / dur * 100 : 0;
                played.style.width = pct + '%';
                knob.style.left = pct + '%';
                timeEl.textContent = `${fmt(video.currentTime)} / ${fmt(dur)}`;
                if (video.buffered.length && dur) {
                    const end = video.buffered.end(video.buffered.length - 1);
                    buffered.style.width = Math.min(100, end / dur * 100) + '%';
                }
            };
            video.addEventListener('timeupdate', updateProgress);
            video.addEventListener('progress', updateProgress);
            video.addEventListener('loadedmetadata', updateProgress);

            // 进度条点击/拖拽跳转
            let dragging = false;
            const seekTo = clientX => {
                if (!isFinite(video.duration)) return;
                const rect = progress.getBoundingClientRect();
                const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
                video.currentTime = ratio * video.duration;
                updateProgress();
            };
            const onDragMove = e => { if (dragging) seekTo(e.clientX); };
            progress.addEventListener('pointerdown', e => {
                dragging = true;
                progress.classList.add('dragging');
                try { progress.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
                seekTo(e.clientX);
            });
            progress.addEventListener('pointermove', onDragMove);
            progress.addEventListener('pointerup', () => { dragging = false; progress.classList.remove('dragging'); });
            progress.addEventListener('pointercancel', () => { dragging = false; progress.classList.remove('dragging'); });

            // 音量旋钮：滑杆调音量，喇叭按钮静音
            const volIcon = () => {
                const v = video.muted ? 0 : video.volume;
                muteBtn.innerHTML = `<i class="bi ${v === 0 ? 'bi-volume-mute-fill' : v < 0.5 ? 'bi-volume-down-fill' : 'bi-volume-up-fill'}"></i>`;
            };
            const applyVol = () => {
                video.volume = +volRange.value;
                video.muted = false;
                volRange.style.setProperty('--vol', (volRange.value * 100) + '%');
                volIcon();
            };
            volRange.addEventListener('input', applyVol);
            muteBtn.addEventListener('click', () => { video.muted = !video.muted; });
            video.addEventListener('volumechange', () => {
                const v = video.muted ? 0 : video.volume;
                volRange.style.setProperty('--vol', (v * 100) + '%');
                volIcon();
            });
            applyVol();

            // 倍速菜单：点击按钮弹出，选择后立即生效
            speedWrap.querySelector('.vpc-speed-btn').addEventListener('click', e => {
                e.stopPropagation();
                speedWrap.classList.toggle('open');
            });
            body.querySelectorAll('.vpc-speed-item').forEach(el => {
                el.addEventListener('click', e => {
                    e.stopPropagation();
                    const rate = +el.dataset.rate;
                    video.playbackRate = rate;
                    speedCur.textContent = el.textContent;   // 直接取菜单项文字，避免 0.75x 被 toFixed 成 0.8x
                    body.querySelectorAll('.vpc-speed-item').forEach(x => x.classList.toggle('active', x === el));
                    speedWrap.classList.remove('open');
                });
            });
            if (!_vpDocClickBound) {
                _vpDocClickBound = true;
                // 点击弹窗其他区域时收起倍速菜单（元素随弹窗销毁，监听器常驻但只做收起操作，无泄漏）
                document.addEventListener('click', () => {
                    document.querySelectorAll('.vpc-speed.open').forEach(el => el.classList.remove('open'));
                });
            }

            // 播放模式三态循环：顺序播放（默认）→ 循环播放 → 随机播放 → 回到顺序；切视频时保留所选模式
            const MODES = [
                { key: 'order',   label: '顺序播放', icon: 'bi-list-ol' },
                { key: 'loop',    label: '循环播放', icon: 'bi-arrow-repeat' },
                { key: 'shuffle', label: '随机播放', icon: 'bi-shuffle' },
            ];
            let modeIdx = Math.max(0, MODES.findIndex(m => m.key === _vpPlayMode));
            const applyMode = (announce) => {
                const m = MODES[modeIdx];
                _vpPlayMode = m.key;
                modeBtn.innerHTML = `<i class="bi ${m.icon}"></i>`;
                modeBtn.title = '播放模式：' + m.label;
                modeBtn.classList.toggle('active', m.key !== 'order');
                video.loop = m.key === 'loop';   // 循环模式交给原生 loop，播完不触发 ended
                if (announce && showSeekTip) showSeekTip(m.label, m.icon);
            };
            modeBtn.addEventListener('click', () => {
                modeIdx = (modeIdx + 1) % MODES.length;
                applyMode(true);
            });
            applyMode(false);

            // 旋转画面：每次 +90°（90→180→270→360…无限循环），横竖互换时自动缩放适配窗口
            let rotDeg = 0;
            const applyRotate = () => {
                const deg = ((rotDeg % 360) + 360) % 360;
                let scale = 1;
                if (deg === 90 || deg === 270) {
                    const r = stage.getBoundingClientRect();
                    if (r.width > 0 && r.height > 0) scale = Math.min(1, r.height / r.width);
                }
                video.style.transform = deg ? `rotate(${deg}deg) scale(${scale})` : '';
            };
            rotateBtn.addEventListener('click', () => {
                rotDeg += 90;
                applyRotate();
                if (showSeekTip) showSeekTip(`已旋转 ${((rotDeg % 360) + 360) % 360}°`, 'bi-arrow-clockwise');
            });
            window.addEventListener('resize', applyRotate);
            document.addEventListener('fullscreenchange', applyRotate);
            // 暴露给 _switchVideoInPlace：换视频时还原旋转角度
            body._vpResetRotation = () => { rotDeg = 0; applyRotate(); };

            // 画中画：始终显示按钮，浏览器不支持时点击给出提示
            pipBtn.addEventListener('click', async () => {
                if (!document.pictureInPictureEnabled) {
                    if (showSeekTip) showSeekTip('当前浏览器不支持画中画', 'bi-display');
                    return;
                }
                try {
                    if (document.pictureInPictureElement) await document.exitPictureInPicture();
                    else await video.requestPictureInPicture();
                } catch (err) {
                    if (showSeekTip) showSeekTip('画中画暂不可用', 'bi-exclamation-circle');
                }
            });

            // 全屏
            fullBtn.addEventListener('click', () => {
                if (document.fullscreenElement) document.exitFullscreen();
                else if (stage.requestFullscreen) stage.requestFullscreen();
                else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen();
            });

            // 控制条自动隐藏：播放中鼠标静止 2.5s 后淡出，移动鼠标恢复
            let idleTimer = null;
            const wake = () => {
                stage.classList.remove('idle');
                clearTimeout(idleTimer);
                idleTimer = setTimeout(() => {
                    if (!video.paused && !speedWrap.classList.contains('open')) stage.classList.add('idle');
                }, 2500);
            };
            stage.addEventListener('mousemove', wake);
            stage.addEventListener('mouseleave', () => { if (!video.paused) stage.classList.add('idle'); });
            video.addEventListener('pause', () => stage.classList.remove('idle'));
            wake();

            // 键盘增强：空格播放/暂停、M 静音、F 全屏（方向键 ±5s 由 bindVideoKeys 处理）
            const keyHandler = e => {
                const tag = (e.target && e.target.tagName || '').toLowerCase();
                if (tag === 'input' || tag === 'textarea' || (e.target && e.target.isContentEditable)) return;
                const k = e.key.toLowerCase();
                if (e.key === ' ') {
                    e.preventDefault();
                    e.stopPropagation();
                    togglePlay();
                } else if (k === 'm') {
                    e.preventDefault();
                    e.stopPropagation();
                    video.muted = !video.muted;
                } else if (k === 'f') {
                    e.preventDefault();
                    e.stopPropagation();
                    fullBtn.click();
                }
            };
            document.addEventListener('keydown', keyHandler, true);

            // 清理函数：解除本视频相关的全局监听（元素本身随 innerHTML 重建自动回收）
            return () => {
                document.removeEventListener('keydown', keyHandler, true);
                document.removeEventListener('fullscreenchange', applyRotate);
                window.removeEventListener('resize', applyRotate);
                clearTimeout(idleTimer);
            };
        }

        // ===== 原位切换视频：不重建播放模块，仅换源 + 同步标题/大小/列表高亮 =====
        let _vpCurrentVideo = '';   // 当前正在播放的视频绝对路径

        function _switchVideoInPlace(body, newPath) {
            const video = body.querySelector('video');
            if (!video || newPath === _vpCurrentVideo) return;
            _vpCurrentVideo = newPath;
            if (body._vpResetRotation) body._vpResetRotation();   // 新视频还原旋转角度

            // 并发点击防护：只让最后一次请求生效
            const token = (body._vpToken = (body._vpToken || 0) + 1);
            fetch(`/api/preview?path=${encodeURIComponent(newPath)}`)
                .then(r => r.json())
                .then(data => {
                    if (body._vpToken !== token) return;
                    if (data.error || !data.stream_url) {
                        video.pause();
                        const info = body.querySelector('.video-info');
                        if (info) info.textContent = data.error || '加载失败';
                        return;
                    }
                    video.src = data.stream_url;
                    video.load();
                    video.play().catch(() => {});
                    const info = body.querySelector('.video-info');
                    if (info) info.textContent = data.size_str || '';
                    // 同步弹窗标题与路径栏
                    const fileName = newPath.split('/').pop();
                    const extLabel = (newPath.split('.').pop() || '').toUpperCase();
                    const spans = document.querySelectorAll('#previewContainer .preview-title span');
                    if (spans.length > 1) spans[1].textContent = fileName;
                    const fp = document.querySelector('#previewContainer .file-path');
                    if (fp) fp.textContent = '.' + extLabel + ' · ' + newPath;
                    // 同步播放列表高亮
                    const listEl = body.querySelector('.vp-list');
                    if (listEl) {
                        listEl.querySelectorAll('.vp-item').forEach(el => {
                            const active = el.dataset.path === newPath;
                            el.classList.toggle('playing', active);
                            if (active) el.scrollIntoView({ block: 'nearest' });
                        });
                    }
                })
                .catch(() => {
                    if (body._vpToken !== token) return;
                    const info = body.querySelector('.video-info');
                    if (info) info.textContent = '加载失败';
                });
        }

        // ===== 视频播放列表：当前目录下的所有视频文件 =====
        // 数据优先取已加载的当前目录列表（fileItems），目录不一致时再请求 /api/files
        function _buildVideoPlaylist(absPath, body) {
            const dir = absPath.slice(0, absPath.lastIndexOf('/')) || '/';
            const listEl = body.querySelector('.vp-list');
            const countEl = body.querySelector('.vp-count');
            const curName = absPath.split('/').pop();

            const apply = (items) => {
                const vids = (items || [])
                    .filter(it => it && !it.is_dir && _VIDEO_EXTS.has((it.ext || '').toLowerCase()))
                    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
                if (countEl) countEl.textContent = vids.length;
                if (!listEl) return;
                if (!vids.length) {
                    listEl.innerHTML = '<div class="vp-empty"><i class="bi bi-film"></i>当前目录没有其他视频</div>';
                    return;
                }
                const curIdx = vids.findIndex(v => v.name === curName);
                listEl.innerHTML = vids.map((it, i) => {
                    const playing = i === curIdx;
                    const p = dir + '/' + it.name;
                    // 封面走 /api/thumbnail（ffmpeg 抽帧 + 磁盘缓存 + ETag 协商缓存），失败回落胶片图标
                    return `<div class="vp-item${playing ? ' playing' : ''}" data-i="${i}" data-path="${_escapeHtml(p)}" title="${_escapeHtml(it.name)}">
                        <div class="vp-thumb-wrap">
                            <i class="bi bi-film vp-thumb-fallback"></i>
                            <img class="vp-thumb" loading="lazy" alt="" src="/api/thumbnail?path=${encodeURIComponent(p)}" onerror="this.remove()">
                        </div>
                        <div class="vp-meta">
                            <div class="vp-name">${_escapeHtml(it.name)}</div>
                            <div class="vp-sub">${(it.ext || '').toUpperCase()} · ${it.size_str || '大小未知'}</div>
                        </div>
                        <div class="vp-eq"><span style="animation-delay:0s"></span><span style="animation-delay:.2s"></span><span style="animation-delay:.4s"></span></div>
                    </div>`;
                }).join('');
                // 点击原位切换视频（不重建播放模块，仅换源 + 更新高亮）
                listEl.querySelectorAll('.vp-item').forEach(el => {
                    el.addEventListener('click', () => {
                        _switchVideoInPlace(body, el.dataset.path);
                    });
                });
                // 播完行为按播放模式处理：顺序=播下一个（末尾停止）、循环=原生 loop、随机=随机换一个
                const video = body.querySelector('video');
                if (video) {
                    video.addEventListener('ended', () => {
                        if (_vpPlayMode === 'loop') return;
                        let nextIdx;
                        if (_vpPlayMode === 'shuffle') {
                            if (vids.length <= 1) {
                                video.currentTime = 0;
                                video.play().catch(() => {});
                                return;
                            }
                            do { nextIdx = Math.floor(Math.random() * vids.length); } while (nextIdx === curIdx);
                        } else {
                            if (curIdx < 0 || curIdx >= vids.length - 1) return;
                            nextIdx = curIdx + 1;
                        }
                        _switchVideoInPlace(body, dir + '/' + vids[nextIdx].name);
                    });
                }
                // 让正在播放的条目滚动到可视区
                const cur = listEl.querySelector('.vp-item.playing');
                if (cur) cur.scrollIntoView({ block: 'nearest' });
            };

            if (dir === currentPath && Array.isArray(fileItems) && fileItems.length) {
                apply(fileItems);
            } else {
                fetch(`/api/files?path=${encodeURIComponent(dir)}`)
                    .then(r => r.json())
                    .then(d => apply(d.items || []))
                    .catch(() => {
                        if (listEl) listEl.innerHTML = '<div class="vp-empty"><i class="bi bi-wifi-off"></i>列表加载失败</div>';
                        if (countEl) countEl.textContent = '0';
                    });
            }
        }

        function closePreview() {
            _closeMenus();
            if (_videoPreviewUnbind) {
                try { _videoPreviewUnbind(); } catch (err) { /* ignore */ }
                _videoPreviewUnbind = null;
            }
            _zipViewerStack.length = 0;   // 清空压缩包查看器返回栈
            const container = document.getElementById('previewContainer');
            container.innerHTML = '';
        }

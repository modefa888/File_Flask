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
                        <span class="file-path" style="display:block;width:100%;font-size:0.7rem;color:#718096;font-family:monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:4px 0 0 26px;">.${extLabel} · ${absPath}</span>
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
                        body.className = 'preview-body preview-video';
                        body.innerHTML = `
                        <div class="video-info" style="position:absolute;top:10px;left:10px;background:rgba(0,0,0,0.7);color:white;padding:4px 10px;border-radius:6px;font-size:0.75rem;z-index:10;">
                            ${data.size_str || ''}
                        </div>
                        <video controls autoplay style="width:100%;height:100%;">
                            <source src="${data.stream_url}" type="${data.content_type}">
                            您的浏览器不支持视频播放
                        </video>
                        <div class="video-seek-tip" style="position:absolute;bottom:54px;left:50%;transform:translate(-50%,8px);background:rgba(0,0,0,0.72);color:#fff;padding:8px 16px;border-radius:8px;font-size:0.85rem;font-weight:600;z-index:20;pointer-events:none;opacity:0;transition:opacity .2s ease,transform .2s ease;display:flex;align-items:center;gap:6px;white-space:nowrap;"></div>
                        <div class="video-tip" style="position:absolute;bottom:12px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,0.6);color:#fff;padding:4px 10px;border-radius:6px;font-size:0.72rem;z-index:10;opacity:0;transition:opacity .3s ease;pointer-events:none;">
                            <i class="bi bi-keyboard"></i> ← 后退 5s &nbsp;|&nbsp; → 快进 5s
                        </div>`;
                        bindVideoKeys();
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

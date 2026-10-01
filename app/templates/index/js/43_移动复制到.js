        // ========== 移动/复制到 ==========
        function showMoveCopyDialog(absPath, mode) {
            const isMove = mode === 'move';
            const title = isMove ? '移动到' : '复制到';
            const name = absPath.split('/').pop();
            const overlay = document.createElement('div');
            overlay.className = 'custom-modal-overlay';
            overlay.innerHTML = `
            <div class="mv-modal">
                <div class="mv-title"><i class="bi ${isMove ? 'bi-arrow-right' : 'bi-plus-square'}"></i> ${title}</div>
                <div class="mv-info">正在${title}: <code>${name}</code></div>
                <div class="mv-path-input">
                    <input type="text" id="mvDestInput" placeholder="目标目录绝对路径，如 /home/user/Downloads" />
                    <button class="btn btn-go" id="mvBrowseBtn">浏览</button>
                </div>
                <div class="mv-preview" id="mvPreview" style="display:none;"></div>
                <div class="mv-footer">
                    <button class="btn btn-cancel" id="mvCancel">取消</button>
                    <button class="btn btn-ok" id="mvOk" disabled>${isMove ? '移动' : '复制'}</button>
                </div>
            </div>
        `;
            document.body.appendChild(overlay);

            const input = overlay.querySelector('#mvDestInput');
            const preview = overlay.querySelector('#mvPreview');
            const okBtn = overlay.querySelector('#mvOk');

            input.addEventListener('input', () => {
                const val = input.value.trim();
                if (val) {
                    preview.textContent = `目标路径: ${val}/${name}`;
                    preview.style.display = '';
                    okBtn.disabled = false;
                } else {
                    preview.style.display = 'none';
                    okBtn.disabled = true;
                }
            });

            overlay.querySelector('#mvBrowseBtn').addEventListener('click', () => {
                navigateTo(input.value.trim());
                input.value = currentPath;
                input.dispatchEvent(new Event('input'));
            });

            okBtn.addEventListener('click', () => {
                const destDir = input.value.trim();
                if (!destDir) return;
                overlay.remove();
                fetch(`/api/${isMove ? 'move' : 'copy'}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path: absPath, dest_dir: destDir })
                }).then(r => r.json()).then(data => {
                    if (data.error) { showToast('错误', data.error, 'danger'); return; }
                    showToast('成功', `已${isMove ? '移动' : '复制'}到 ${destDir}`, 'success');
                    loadFiles(currentPath);
                }).catch(e => { showToast('错误', e.message, 'danger'); });
            });

            overlay.querySelector('#mvCancel').addEventListener('click', () => overlay.remove());
            overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
        }

        // ========== 压缩文件（选文件/目录打包） ==========
        function compressSelected(paths, destDir) {
            // 单个条目：用条目名作默认压缩包名前缀；多选：用日期式名称（精确到秒）
            const d = new Date();
            const ts = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0")
                + "_" + String(d.getHours()).padStart(2, "0") + String(d.getMinutes()).padStart(2, "0") + String(d.getSeconds()).padStart(2, "0");
            const defaultName = paths.length === 1
                ? (paths[0].split('/').filter(Boolean).pop() || '压缩包') + '_' + ts
                : `压缩包_${ts}`;
            const container = document.getElementById('previewContainer');
            container.innerHTML = `
            <div class="preview-overlay">
                <div class="zip-modal" style="width:460px;height:auto;">
                    <div class="zip-header">
                        <div class="zip-title-row">
                            <div class="zip-title"><i class="bi bi-file-zip-fill"></i><span>压缩文件</span></div>
                            <div class="zip-actions"><button class="btn btn-close-zip" id="zipCloseBtn"><i class="bi bi-x-lg"></i></button></div>
                        </div>
                    </div>
                    <div style="padding:8px 20px 18px;">
                        <label style="font-size:0.78rem;color:#4a5568;display:block;margin-bottom:4px;">压缩文件名</label>
                        <input class="zip-name-input" id="zipNewName" value="${defaultName}" />
                        <div class="zip-name-hint">将在 <span id="zipDestHint">${_escHtml(destDir || '-')}</span> 下生成</div>
                        <div style="font-size:0.78rem;color:#718096;margin-top:8px;">共 <b>${paths.length}</b> 项待压缩</div>
                        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px;">
                            <button class="btn" style="background:#f1f5f9;color:#475569;padding:6px 14px;border-radius:8px;border:none;cursor:pointer;font-size:0.85rem;" id="zipCancelBtn">取消</button>
                            <button class="btn" style="background:#2563eb;color:white;padding:6px 14px;border-radius:8px;border:none;cursor:pointer;font-size:0.85rem;" id="zipConfirmBtn"><i class="bi bi-file-zip"></i> 开始压缩</button>
                        </div>
                    </div>
                </div>
            </div>`;
            document.getElementById('zipCloseBtn').addEventListener('click', closePreview);
            document.getElementById('zipCancelBtn').addEventListener('click', closePreview);
            document.getElementById('zipConfirmBtn').addEventListener('click', () => {
                const name = (document.getElementById('zipNewName').value || '').trim() || defaultName;
                closePreview();
                _doCompress(paths, destDir, name);
            });
        }

        function _doCompress(paths, destDir, name) {
            _bgStart('zip', '/api/zip/create/start', { paths: paths, dest_dir: destDir || '', name }, {
                title: '正在压缩：' + name,
                legacy: () => _legacyZip(paths, destDir, name),   // 后端未升级退回旧同步接口
                onDone: (ok, d) => {
                    const r = d && d.result;
                    if (ok && r) {
                        showToast('成功', `已生成压缩包 ${r.name}（${r.size_str}，共 ${r.files} 个文件）`, 'success');
                        // 本地插入新 zip 条目，不重新请求 /api/files（大目录会超时）
                        localAddItem({
                            name: r.name, path: r.name,
                            is_dir: false, size: r.size || 0,
                            size_str: r.size_str || formatSize(r.size || 0),
                            ext: 'zip', type: 'ZIP', mtime: _nowStr()
                        });
                    }
                }
            });
        }

        function _legacyZip(paths, destDir, name) {
            fetch('/api/zip/create', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ paths: paths, dest_dir: destDir || '', name })
            }).then(r => r.json()).then(data => {
                if (data.error) { showToast('错误', data.error, 'danger'); return; }
                showToast('成功', `已生成压缩包 ${data.name}（${data.size_str}，共 ${data.files} 个文件）`, 'success');
                // 本地插入新 zip 条目，不重新请求 /api/files（大目录会超时）
                localAddItem({
                    name: data.name, path: data.name,
                    is_dir: false, size: data.size || 0,
                    size_str: data.size_str || formatSize(data.size || 0),
                    ext: 'zip', type: 'ZIP', mtime: _nowStr()
                });
            }).catch(e => { showToast('错误', e.message, 'danger'); });
        }

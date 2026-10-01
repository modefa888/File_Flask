        // ========== 文件信息面板 ==========
        function showPropertiesDialog(absPath) {
            fetch(`/api/properties?path=${encodeURIComponent(absPath)}`)
                .then(r => r.json()).then(data => {
                    if (data.error) { showToast('错误', data.error, 'danger'); return; }
                    _showPropPanel(data);
                }).catch(e => { showToast('错误', e.message, 'danger'); });
        }

        function _showPropPanel(data) {
            const isDir = data.is_dir;
            let bodyRows = '';
            bodyRows += `<div class="prop-row"><span class="prop-label">名称</span><span class="prop-value clickable" data-copy="${data.name}">${data.name}</span></div>`;
            bodyRows += `<div class="prop-row"><span class="prop-label">类型</span><span class="prop-value">${isDir ? '文件夹' : (data.mime_type || '未知')}</span></div>`;
            bodyRows += `<div class="prop-row"><span class="prop-label">大小</span><span class="prop-value">${data.size_str}</span></div>`;
            bodyRows += `<div class="prop-row"><span class="prop-label">路径</span><span class="prop-value clickable" data-copy="${data.path}">${data.path}</span></div>`;
            bodyRows += `<div class="prop-row"><span class="prop-label">所在目录</span><span class="prop-value clickable" data-copy="${data.parent}">${data.parent}</span></div>`;
            bodyRows += `<div class="prop-row"><span class="prop-label">创建时间</span><span class="prop-value">${data.created}</span></div>`;
            bodyRows += `<div class="prop-row"><span class="prop-label">修改时间</span><span class="prop-value">${data.modified}</span></div>`;
            bodyRows += `<div class="prop-row"><span class="prop-label">权限</span><span class="prop-value">${data.permissions || '-'}</span></div>`;

            if (isDir) {
                bodyRows += `<div class="prop-divider"></div>`;
                bodyRows += `<div class="prop-row"><span class="prop-label">子文件夹</span><span class="prop-value"><i class="bi bi-folder-fill text-warning"></i> ${data.sub_dirs || 0} 个</span></div>`;
                bodyRows += `<div class="prop-row"><span class="prop-label">子文件</span><span class="prop-value"><i class="bi bi-file-earmark"></i> ${data.sub_files || 0} 个</span></div>`;
                bodyRows += `<div class="prop-row"><span class="prop-label">总文件夹</span><span class="prop-value">${data.total_dirs || 0} 个</span></div>`;
                bodyRows += `<div class="prop-row"><span class="prop-label">总文件</span><span class="prop-value">${data.total_files || 0} 个</span></div>`;
            }

            const overlay = document.createElement('div');
            overlay.className = 'custom-modal-overlay';
            overlay.innerHTML = `
            <div class="prop-panel">
                <div class="prop-header">
                    <span class="prop-title"><i class="bi ${isDir ? 'bi-folder-fill' : 'bi-file-earmark'}"></i> ${isDir ? '文件夹信息' : '文件信息'}</span>
                    <button class="prop-close" title="关闭"><i class="bi bi-x-lg"></i></button>
                </div>
                <div class="prop-body">
                    ${bodyRows}
                </div>
            </div>
        `;
            document.body.appendChild(overlay);
            overlay.querySelector('.prop-close').addEventListener('click', () => overlay.remove());
            overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
            overlay.querySelectorAll('.prop-value.clickable').forEach(el => {
                el.addEventListener('click', () => { _copyToClipboard(el.dataset.copy, '已复制到剪切板'); });
            });
        }

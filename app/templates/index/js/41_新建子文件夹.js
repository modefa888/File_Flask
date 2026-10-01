        // ========== 新建子文件夹 ==========
        function showNewFolderDialog(parentPath) {
            showInputDialog('新建文件夹', '文件夹名称', '新文件夹', (name) => {
                name = (name || '').trim();
                if (!name) { showToast('错误', '名称不能为空', 'danger'); return false; }
                fetch('/api/new-folder', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ parent: parentPath, name }) })
                    .then(r => r.json()).then(data => {
                        if (data.error) { showToast('错误', data.error, 'danger'); return; }
                        showToast('成功', `已创建文件夹 ${name}`, 'success');
                        loadFiles(currentPath);
                    }).catch(e => { showToast('错误', e.message, 'danger'); });
            });
        }

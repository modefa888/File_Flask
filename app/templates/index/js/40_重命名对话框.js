        // ========== 重命名对话框 ==========
        function showRenameDialog(absPath) {
            const name = absPath.split('/').pop();
            const extIdx = name.lastIndexOf('.');
            const baseName = extIdx >= 0 ? name.substring(0, extIdx) : name;
            const ext = extIdx >= 0 ? name.substring(extIdx) : '';
            showInputDialog('重命名', '新文件名', baseName, (newName) => {
                newName = (newName || '').trim();
                if (!newName) { showToast('错误', '名称不能为空', 'danger'); return false; }
                const finalName = ext ? newName + ext : newName;
                fetch('/api/rename', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: absPath, new_name: finalName }) })
                    .then(r => r.json()).then(data => {
                        if (data.error) { showToast('错误', data.error, 'danger'); return; }
                        showToast('成功', `已重命名为 ${finalName}`, 'success');
                        loadFiles(currentPath);
                    }).catch(e => { showToast('错误', e.message, 'danger'); });
            });
        }

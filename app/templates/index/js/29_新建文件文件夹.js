        // ========== 新建文件/文件夹 ==========
        function showNewFileDialog(isDir) {
            const defaultName = isDir ? '新文件夹' : '新文件.txt';
            const placeholder = isDir ? '输入文件夹名称' : '输入文件名（如 note.txt）';
            const icon = isDir ? '📁' : '📄';
            // 收集当前目录下已有的文件名
            const existingNames = new Set();
            for (const item of fileItems) {
                existingNames.add(item.name);
            }
            showInputDialog(icon + ' 新建' + (isDir ? '文件夹' : '文件'), placeholder, defaultName, (name) => {
                if (!name || !name.trim()) return;
                name = name.trim();
                if (!isDir && !name.includes('.')) {
                    name += '.txt';
                }
                createFileOrDir(name, isDir);
            }, (name) => {
                if (!name || !name.trim()) {
                    return { valid: false, message: '名称不能为空' };
                }
                const cleanName = isDir && !name.includes('.') ? name : (name.includes('.') ? name : (name + (isDir ? '' : '.txt')));
                const checkName = isDir && !cleanName.includes('.') ? name.trim() : cleanName;
                if (existingNames.has(checkName)) {
                    return { valid: false, message: '「' + checkName + '」已存在，请换一个名称' };
                }
                return { valid: true };
            });
        }

        function createFileOrDir(name, isDir) {
            fetch('/api/files/create', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path: currentPath, name, is_dir: isDir })
            })
                .then(r => r.json())
                .then(data => {
                    if (data.error) {
                        showToast('错误', data.error, 'danger');
                        return;
                    }
                    showToast('成功', (isDir ? '文件夹 ' : '文件 ') + name + ' 已创建', 'success');
                    loadFiles(currentPath);
                    // 如果是新文件，直接打开编辑器
                    if (!isDir) {
                        openEditor(data.path, true);
                    }
                })
                .catch(e => showToast('错误', e.message, 'danger'));
        }

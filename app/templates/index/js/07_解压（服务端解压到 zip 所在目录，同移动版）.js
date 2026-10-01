        // ========== 解压（服务端解压到 zip 所在目录，同移动版） ==========
        function _startUnzip(zipPath) {
            const name = zipPath.split('/').pop();
            _bgStart('uz', '/api/zip/unzip/start', { path: zipPath }, {
                title: '正在解压：' + name,
                onDone: (ok, d) => {
                    const r = d && d.result;
                    if (ok && r) {
                        showToast('成功', `已解压 ${r.files != null ? r.files : ''} 个文件到「${r.name}」`, 'success');
                        // 解压出的目录在 zip 同级目录；若是当前浏览目录则本地插入
                        const resPath = r.path || '';
                        const parent = resPath ? resPath.substring(0, Math.max(resPath.lastIndexOf('/'), resPath.lastIndexOf('\\'))) : '';
                        if (parent === currentPath) {
                            localAddItem({
                                name: r.name, path: r.name,
                                is_dir: true, size: 0, size_str: '', ext: '', type: '', mtime: _nowStr()
                            });
                        }
                    }
                }
            });
        }

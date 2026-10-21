        // ========== 删除 ==========
        async function deleteFiles(paths) {
            if (!paths || paths.length === 0) return;
            const count = paths.length;
            let dirItems = [];
            let fileItems_ = [];
            // 列表项里的 path 是相对路径，按「当前目录 + 相对路径」还原绝对路径再匹配
            const _base = (currentPath || '').replace(/[\\/]+$/, '');
            const _absOf = (f) => {
                if (f.abs_path) return f.abs_path;
                const rel = String(f.path || '');
                if (!rel) return '';
                return /^([A-Za-z]:[\\/]|[\\/])/.test(rel) ? rel : (_base ? _base + '/' + rel : rel);
            };
            for (const p of paths) {
                const item = fileItems.find(f => _absOf(f) === p);
                if (item && item.is_dir) {
                    dirItems.push(item);
                } else {
                    fileItems_.push(p);
                }
            }
            let confirmMsg = '';
            if (dirItems.length > 0) {
                let msg = '以下文件夹会连同所有子文件一起移入回收站（5 秒内可撤销）：\n\n';
                for (const d of dirItems) {
                    msg += '· ' + d.name + (d.size > 0 ? '（' + formatSize(d.size) + '）' : '') + '\n';
                }
                if (fileItems_.length > 0) msg += '\n另 ' + fileItems_.length + ' 个文件\n';
                msg += '\n删除后可在 5 秒内点「撤销」恢复，继续？';
                confirmMsg = msg;
            } else {
                confirmMsg = count === 1
                    ? '确定要删除 "' + (paths[0].split('/').pop() || paths[0]) + '" 吗？已移入回收站，5秒内可撤销。'
                    : '确定要删除选中的 ' + count + ' 个文件吗？已移入回收站，5秒内可撤销。';
            }
            const confirmed = await showConfirm(confirmMsg);
            if (!confirmed) return;
            try {
                // 启动异步删除任务（同移动版），带进度条 + 后台胶囊
                const progName = count === 1 ? (paths[0].split('/').pop() || '') : (count + ' 项');
                _bgStart('del', '/api/delete/start', { paths }, {
                    title: '正在删除：' + progName,
                    onDone: (ok, d) => {
                        const result = (d && d.result) || {};
                        const deletedCount = (result.deleted || []).length;
                        if (deletedCount > 0) {
                            // 本地从列表移除已删条目，不重新请求 /api/files（大目录会超时）
                            localRemoveItems(paths);
                            if (ok) showToast('成功', '已删除 ' + deletedCount + ' 个（移入回收站）', 'success');
                            // 显示撤销 Toast（带倒计时）
                            if (ok && (result.trash_items || []).length > 0) showUndoToast(result.trash_items);
                        }
                        selectedPaths.clear();
                    }
                });
            } catch (e) {
                showToast('错误', '删除失败: ' + e.message, 'danger');
            }
        }

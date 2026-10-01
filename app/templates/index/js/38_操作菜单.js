        // ========== 操作菜单 ==========

        function startIndexPolling() {
            if (_indexPollTimer) clearInterval(_indexPollTimer);
            _indexPollTimer = setInterval(updateIndexBadge, 5000);
            updateIndexBadge();
        }

        function stopIndexPolling() {
            if (_indexPollTimer) { clearInterval(_indexPollTimer); _indexPollTimer = null; }
        }

        function updateIndexBadge() {
            return fetch('/api/index/meta')
                .then(r => r.json())
                .then(data => {
                    const badge = document.getElementById('indexBadge');
                    const text = document.getElementById('indexBadgeText');
                    if (!badge || !text) return null;
                    const status = data.status || 'idle';
                    const lastScan = data.last_scan || '--';
                    const totalFiles = data.total_files || 0;
                    const progress = data.progress || 0;
                    const statusDetail = data.status_detail || '';
                    if (status === 'scanning') {
                        const detail = statusDetail ? ' ' + statusDetail : '';
                        text.textContent = '扫描中... ' + totalFiles.toLocaleString() + ' 个文件' + (progress > 0 ? ' (' + progress + '%)' : '') + detail;
                        badge.className = 'badge bg-warning text-dark border';
                        badge.title = '扫描中...（' + (statusDetail || '正在进行') + '）';
                    } else if (status === 'error') {
                        text.textContent = '扫描失败';
                        badge.className = 'badge bg-danger text-white border';
                        if (statusDetail) badge.title = statusDetail;
                    } else if (totalFiles === 0 && (lastScan === '从未扫描' || lastScan === '等待中...')) {
                        text.textContent = '未扫描 (点击重建)';
                        badge.className = 'badge bg-light text-muted border';
                    } else {
                        text.textContent = totalFiles.toLocaleString() + ' 个文件 (' + lastScan + ')';
                        badge.className = 'badge bg-success text-white border';
                    }
                    // 索引不在更新中（完成/空闲/失败）则自动关闭轮询；只有更新索引时才需要持续轮询
                    if (status !== 'scanning') {
                        stopIndexPolling();
                    }
                    return status;
                })
                .catch(() => { stopIndexPolling(); return 'idle'; });
        }

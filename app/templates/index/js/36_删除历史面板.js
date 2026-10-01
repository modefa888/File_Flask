        // ========== 删除历史面板 ==========
        function showDeleteHistory() {
            const container = document.getElementById('deleteHistoryPanel');
            if (!container) return;
            container.innerHTML = `
            <div class="delhist-overlay">
                <div class="delhist-panel">
                    <div class="panel-header">
                        <span class="panel-title"><i class="bi bi-clock-history"></i> 删除历史（回收站）</span>
                        <button class="panel-close" title="关闭"><i class="bi bi-x-lg"></i></button>
                    </div>
                    <div class="panel-body" id="delhistBody">
                        <div class="delhist-empty"><i class="bi bi-hourglass-split"></i>加载中...</div>
                    </div>
                    <div class="panel-footer">
                        <button class="delhist-btn-clear" id="delhistClearBtn" disabled><i class="bi bi-trash3"></i> 清空回收站</button>
                    </div>
                </div>
            </div>
        `;
            container.querySelector('.panel-close').addEventListener('click', closeDeleteHistory);
            container.querySelector('.delhist-overlay').addEventListener('click', (e) => {
                if (e.target === container.querySelector('.delhist-overlay')) closeDeleteHistory();
            });
            document.getElementById('delhistClearBtn').addEventListener('click', clearDeleteHistory);
            _loadDeleteHistoryList();
        }

        function closeDeleteHistory() {
            const container = document.getElementById('deleteHistoryPanel');
            if (container) container.innerHTML = '';
        }

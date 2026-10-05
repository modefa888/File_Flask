        // ========== 索引详情面板 ==========
        let _indexPanelRef = null;

        function showIndexDetail() {
            const container = document.getElementById('indexDetailPanel');
            if (!container) return;

            // 如果面板已打开，先关闭
            if (container.childElementCount > 0) {
                closeIndexDetail();
            }

            const overlay = document.createElement('div');
            overlay.className = 'index-detail-overlay';

            const panel = document.createElement('div');
            panel.className = 'index-detail-panel';
            panel.innerHTML = `
            <div class="panel-header">
                <span class="panel-title"><i class="bi bi-database"></i> 索引详情</span>
                <div style="display:flex;gap:6px;">
                    <button class="panel-close" id="idxVizBtn" title="可视化面板"><i class="bi bi-graph-up"></i></button>
                    <button class="panel-close" title="关闭"><i class="bi bi-x-lg"></i></button>
                </div>
            </div>
            <div class="panel-body">
                <div class="idx-section">
                    <div class="idx-stats-grid">
                        <div class="idx-stat-card"><div class="stat-label"><i class="bi bi-file-earmark"></i> 文件数</div><div class="stat-value" id="idxFileCount">--</div></div>
                        <div class="idx-stat-card"><div class="stat-label"><i class="bi bi-folder"></i> 目录数</div><div class="stat-value" id="idxDirCount">--</div></div>
                        <div class="idx-stat-card full-width"><div class="stat-label"><i class="bi bi-hdd"></i> 总大小</div><div class="stat-value" id="idxTotalSize">--</div></div>
                        <div class="idx-stat-card info"><div class="stat-label"><i class="bi bi-clock"></i> 上次扫描</div><div class="stat-value" id="idxLastScan">--</div></div>
                        <div class="idx-stat-card"><div class="stat-label"><i class="bi bi-gear"></i> 状态</div><div class="stat-value" id="idxStatus">--</div></div>
                    </div>
                    <div id="idxProgressArea" style="display:none;"><div style="font-size:0.75rem;color:#475569;margin-bottom:2px;">扫描进度: <strong id="idxProgressText">0%</strong></div><div class="idx-progress-bar"><div class="progress-fill" id="idxProgressFill" style="width:0%;"></div></div></div>
                </div>
                <div class="idx-section">
                    <div class="idx-section-title"><i class="bi bi-bar-chart"></i> 占用空间 Top 15 目录</div>
                    <div id="idxTopDirs"></div>
                </div>
                <div class="idx-section">
                    <div class="idx-section-title"><i class="bi bi-tags"></i> 文件类型分布</div>
                    <div id="idxTypeDist"></div>
                </div>
                <div class="idx-section">
                    <div class="idx-section-title"><i class="bi bi-file-earmark-plus"></i> 最大文件 Top 10</div>
                    <div id="idxTopFiles"></div>
                </div>
            </div>
            <div class="panel-footer">
                <button class="idx-btn idx-btn-primary" id="idxRebuildBtn"><i class="bi bi-arrow-clockwise"></i> 重建索引</button>
                <button class="idx-btn idx-btn-cancel" id="idxCancelBtn" style="display:none;"><i class="bi bi-x-lg"></i> 取消扫描</button>
            </div>
        `;

            overlay.appendChild(panel);
            container.appendChild(overlay);
            _indexPanelRef = overlay;

            // 关闭按钮
            overlay.querySelector('.panel-close').addEventListener('click', closeIndexDetail);
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) closeIndexDetail();
            });

            // 重建索引按钮
            overlay.querySelector('#idxRebuildBtn').addEventListener('click', _handleIndexRebuild);
            overlay.querySelector('#idxCancelBtn').addEventListener('click', _handleIndexCancel);
            // 可视化面板按钮
            overlay.querySelector('#idxVizBtn').addEventListener('click', showIndexCharts);

            // 加载数据
            _loadIndexDetail();
        }

        function closeIndexDetail() {
            const container = document.getElementById('indexDetailPanel');
            if (!container) return;
            container.innerHTML = '';
            _indexPanelRef = null;
        }

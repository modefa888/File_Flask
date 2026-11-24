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
            <div class="idxd-head">
                <span class="idxd-title"><i class="bi bi-database-check"></i> 索引详情</span>
                <span class="idxd-sub" id="idxSub">基于本地索引</span>
                <div class="idxd-hbtns">
                    <button class="idxd-hbtn" id="idxRefreshBtn" title="刷新统计"><i class="bi bi-arrow-clockwise"></i></button>
                    <button class="idxd-hbtn" id="idxVizBtn" title="可视化面板"><i class="bi bi-graph-up"></i></button>
                    <button class="idxd-hbtn" id="idxCloseBtn" title="关闭"><i class="bi bi-x-lg"></i></button>
                </div>
            </div>
            <div class="idxd-body">
                <div class="idxd-stats">
                    <div class="idxd-stat"><span>文件数</span><b id="idxFileCount">--</b><em id="idxFileSub">--</em></div>
                    <div class="idxd-stat"><span>目录数</span><b id="idxDirCount">--</b><em id="idxDirSub">--</em></div>
                    <div class="idxd-stat"><span>总大小</span><b id="idxTotalSize">--</b><em id="idxSizeSub">--</em></div>
                    <div class="idxd-stat" id="idxStatusCard"><span>状态</span><b id="idxStatus">--</b><em id="idxStatusSub">--</em></div>
                </div>

                <div class="idxd-progress" id="idxProgressArea" style="display:none;">
                    <div class="idxd-progress-top">
                        <strong id="idxProgressText">0%</strong>
                        <span id="idxProgressDetail">正在扫描…</span>
                    </div>
                    <div class="idx-progress-bar"><div class="progress-fill" id="idxProgressFill" style="width:0%;"></div></div>
                    <div class="idxd-progress-nums" id="idxProgressNums"></div>
                </div>

                <div class="idxd-card">
                    <div class="idxd-card-head"><span><i class="bi bi-folder2-open"></i>占用空间 Top 15 目录</span><em>点击目录可跳转</em></div>
                    <div class="idxd-card-body" id="idxTopDirs"></div>
                </div>

                <div class="idxd-card">
                    <div class="idxd-card-head"><span><i class="bi bi-pie-chart"></i>文件类型分布</span><em id="idxTypeHint"></em></div>
                    <div class="idxd-card-body" id="idxTypeDist"></div>
                </div>

                <div class="idxd-card">
                    <div class="idxd-card-head"><span><i class="bi bi-bar-chart-line"></i>文件大小分布</span><em>按体积区间</em></div>
                    <div class="idxd-card-body" id="idxSizeDist"></div>
                </div>

                <div class="idxd-card">
                    <div class="idxd-card-head"><span><i class="bi bi-file-earmark-bar-graph"></i>最大文件 Top 10</span><em>点击定位目录</em></div>
                    <div class="idxd-card-body" id="idxTopFiles"></div>
                </div>
            </div>
            <div class="idxd-foot">
                <button class="idxd-btn idxd-btn-clear" id="idxClearBtn" title="删除索引主库、临时库及 WAL/SHM 文件；清空后只有再次点击「重建索引」才会重新创建"><i class="bi bi-trash3"></i> 清空索引库</button>
                <button class="idxd-btn idxd-btn-cancel" id="idxCancelBtn" style="display:none;"><i class="bi bi-x-lg"></i> 取消扫描</button>
                <button class="idxd-btn idxd-btn-primary" id="idxRebuildBtn"><i class="bi bi-arrow-clockwise"></i> 重建索引</button>
            </div>
        `;

            overlay.appendChild(panel);
            container.appendChild(overlay);
            _indexPanelRef = overlay;

            overlay.querySelector('#idxCloseBtn').addEventListener('click', closeIndexDetail);
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) closeIndexDetail();
            });

            // 刷新 / 重建 / 清空 / 取消 / 可视化
            overlay.querySelector('#idxRefreshBtn').addEventListener('click', () => {
                _loadIndexDetail(true);
                const btn = overlay.querySelector('#idxRefreshBtn');
                if (btn) {
                    btn.classList.add('spinning');
                    setTimeout(() => btn.classList.remove('spinning'), 600);
                }
            });
            overlay.querySelector('#idxRebuildBtn').addEventListener('click', _handleIndexRebuild);
            overlay.querySelector('#idxClearBtn').addEventListener('click', _handleIndexClear);
            overlay.querySelector('#idxCancelBtn').addEventListener('click', _handleIndexCancel);
            overlay.querySelector('#idxVizBtn').addEventListener('click', showIndexCharts);

            _loadIndexDetail(true);
        }

        function closeIndexDetail() {
            const container = document.getElementById('indexDetailPanel');
            if (!container) return;
            container.innerHTML = '';
            _indexPanelRef = null;
        }

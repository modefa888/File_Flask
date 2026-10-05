        // ========== 索引可视化面板（纯 SVG 图表，无外部依赖） ==========
        let _indexVizPanelRef = null;

        const _VIZ_COLORS = ['#2563eb', '#059669', '#d97706', '#dc2626', '#7c3aed', '#0891b2', '#db2777', '#65a30d', '#ea580c', '#4f46e5', '#0d9488', '#b45309', '#94a3b8'];

        function showIndexCharts() {
            const container = document.getElementById('indexDetailPanel');
            if (!container) return;
            if (_indexVizPanelRef) closeIndexCharts();

            const overlay = document.createElement('div');
            overlay.className = 'index-viz-overlay';
            overlay.innerHTML = `
            <div class="index-viz-panel">
                <div class="panel-header">
                    <span class="panel-title"><i class="bi bi-graph-up-arrow"></i> 索引可视化</span>
                    <div style="display:flex;gap:6px;">
                        <button class="panel-close" id="idxVizRefresh" title="刷新数据"><i class="bi bi-arrow-clockwise"></i></button>
                        <button class="panel-close" id="idxVizClose" title="关闭"><i class="bi bi-x-lg"></i></button>
                    </div>
                </div>
                <div class="panel-body" id="idxVizBody">
                    <div class="viz-loading"><i class="bi bi-hourglass-split"></i> 正在加载统计数据...</div>
                </div>
            </div>`;
            container.appendChild(overlay);
            _indexVizPanelRef = overlay;

            overlay.querySelector('#idxVizClose').addEventListener('click', closeIndexCharts);
            overlay.querySelector('#idxVizRefresh').addEventListener('click', _loadIndexCharts);
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) closeIndexCharts();
            });
            _loadIndexCharts();
        }

        function closeIndexCharts() {
            const container = document.getElementById('indexDetailPanel');
            if (container && _indexVizPanelRef && _indexVizPanelRef.parentNode === container) {
                container.removeChild(_indexVizPanelRef);
            }
            _indexVizPanelRef = null;
        }

        function _loadIndexCharts() {
            const body = document.getElementById('idxVizBody');
            if (!body) return;
            body.innerHTML = '<div class="viz-loading"><i class="bi bi-hourglass-split"></i> 正在加载统计数据...</div>';
            fetch('/api/index/charts')
                .then(r => r.json())
                .then(data => _renderIndexCharts(body, data))
                .catch(() => { body.innerHTML = '<div class="viz-loading"><i class="bi bi-wifi-off"></i> 加载失败，请重试</div>'; });
        }

        // 环形图（按 size 占比）
        function _vizSvgDonut(items) {
            const total = items.reduce((s, it) => s + (it.size || 0), 0) || 1;
            const R = 70, CX = 90, CY = 90, STROKE = 30;
            const C = 2 * Math.PI * R;
            let offset = 0;
            let segs = '';
            items.forEach((it, i) => {
                const frac = (it.size || 0) / total;
                if (frac <= 0) return;
                const len = frac * C;
                const color = _VIZ_COLORS[i % _VIZ_COLORS.length];
                segs += `<circle class="seg" cx="${CX}" cy="${CY}" r="${R}" fill="none" stroke="${color}" stroke-width="${STROKE}" stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-offset}" transform="rotate(-90 ${CX} ${CY})"><title>${_escAttr(it.ext)}: ${formatSize(it.size || 0)} (${(frac * 100).toFixed(1)}%)</title></circle>`;
                offset += len;
            });
            return `<svg viewBox="0 0 180 180" class="viz-donut">${segs}
                <text x="${CX}" y="${CY - 2}" text-anchor="middle" class="viz-donut-num">${_escHtml(formatSize(total))}</text>
                <text x="${CX}" y="${CY + 16}" text-anchor="middle" class="viz-donut-sub">总大小</text>
            </svg>`;
        }

        // 环形图图例
        function _vizLegend(items) {
            const total = items.reduce((s, it) => s + (it.size || 0), 0) || 1;
            return items.map((it, i) => {
                const pct = ((it.size || 0) / total * 100).toFixed(1);
                const color = _VIZ_COLORS[i % _VIZ_COLORS.length];
                return `<div class="viz-legend-item">
                    <span class="viz-dot" style="background:${color}"></span>
                    <span class="viz-legend-name" title="${_escAttr(it.ext)}">${_escHtml(it.ext)}</span>
                    <span class="viz-legend-val">${formatSize(it.size || 0)} · ${(it.count || 0).toLocaleString()} 个 · ${pct}%</span>
                </div>`;
            }).join('');
        }

        // 横向条形图（top_dirs / top_files）
        function _vizHBars(items, opts = {}) {
            const max = Math.max(...items.map(it => it.size || 0), 1);
            return items.map((it, i) => {
                const w = Math.max(2, ((it.size || 0) / max) * 100);
                const color = _VIZ_COLORS[i % _VIZ_COLORS.length];
                const label = opts.showPath ? _escHtml(it.path || it.name) : _escHtml(it.name);
                const val = opts.showCount && it.count != null
                    ? `${it.count.toLocaleString()} 个 · ${formatSize(it.size || 0)}`
                    : formatSize(it.size || 0);
                const dataPath = opts.showPath && it.path ? ` data-path="${_escAttr(it.path)}"` : '';
                const tip = opts.showPath ? _escAttr(it.path || it.name) : _escAttr(it.name);
                return `<div class="viz-hbar-row"${dataPath} title="${tip}">
                    <div class="viz-hbar-label">${label}</div>
                    <div class="viz-hbar-track"><div class="viz-hbar-fill" style="width:${w}%;background:${color}"></div></div>
                    <div class="viz-hbar-val">${val}</div>
                </div>`;
            }).join('');
        }

        // 纵向柱状图（大小分布 / 时间分布）
        function _vizVBars(items) {
            const max = Math.max(...items.map(it => it.count || 0), 1);
            return '<div class="viz-vbars">' + items.map((it, i) => {
                const h = Math.max(2, ((it.count || 0) / max) * 100);
                const color = _VIZ_COLORS[i % _VIZ_COLORS.length];
                const tip = it.size != null
                    ? `${it.label}: ${(it.count || 0).toLocaleString()} 个 · ${formatSize(it.size || 0)}`
                    : `${it.label}: ${(it.count || 0).toLocaleString()} 个`;
                return `<div class="viz-vbar-col" title="${_escAttr(tip)}">
                    <div class="viz-vbar-num">${(it.count || 0).toLocaleString()}</div>
                    <div class="viz-vbar-track"><div class="viz-vbar-fill" style="height:${h}%;background:${color}"></div></div>
                    <div class="viz-vbar-label">${_escHtml(it.label)}</div>
                </div>`;
            }).join('') + '</div>';
        }

        function _renderIndexCharts(body, data) {
            const types = data.type_distribution || [];
            const buckets = data.size_buckets || [];
            const mtimes = data.mtime_buckets || [];
            const topDirs = data.top_dirs || [];
            const topFiles = data.top_files || [];
            const meta = data.meta || {};

            let html = '';
            if (meta.status === 'scanning') {
                const src = meta.from_temp ? '实时扫描数据' : '旧索引数据';
                html += `<div class="viz-note"><i class="bi bi-info-circle"></i> 索引扫描中：当前显示${src}，完成后自动切换为最终数据（约 20 秒刷新一次）</div>`;
            }
            if (types.length) {
                html += `<div class="idx-section"><div class="idx-section-title"><i class="bi bi-pie-chart"></i> 文件类型分布（按占用空间）</div>
                    <div class="viz-donut-wrap">
                        <div class="viz-donut-box">${_vizSvgDonut(types)}</div>
                        <div class="viz-legend">${_vizLegend(types)}</div>
                    </div></div>`;
            }
            if (buckets.length) {
                html += `<div class="idx-section"><div class="idx-section-title"><i class="bi bi-bar-chart"></i> 文件大小分布</div>${_vizVBars(buckets)}</div>`;
            }
            if (mtimes.length) {
                html += `<div class="idx-section"><div class="idx-section-title"><i class="bi bi-clock-history"></i> 修改时间分布</div>${_vizVBars(mtimes)}</div>`;
            }
            if (topDirs.length) {
                html += `<div class="idx-section"><div class="idx-section-title"><i class="bi bi-folder-fill"></i> 占用空间 Top 15 目录（点击跳转）</div>${_vizHBars(topDirs, { showPath: true, showCount: true })}</div>`;
            }
            if (topFiles.length) {
                html += `<div class="idx-section"><div class="idx-section-title"><i class="bi bi-file-earmark-fill"></i> 最大文件 Top 10</div>${_vizHBars(topFiles, {})}</div>`;
            }
            if (!html) {
                html = '<div class="viz-loading"><i class="bi bi-inbox"></i> 暂无索引数据，请先构建索引</div>';
            }
            body.innerHTML = html;

            // 目录条目点击跳转
            body.querySelectorAll('.viz-hbar-row[data-path]').forEach(el => {
                el.addEventListener('click', () => {
                    closeIndexCharts();
                    closeIndexDetail();
                    navigateTo(el.dataset.path);
                });
            });
        }

        // ========== 文件信息面板 ==========
        function showPropertiesDialog(absPath) {
            fetch(`/api/properties?path=${encodeURIComponent(absPath)}`)
                .then(r => r.json()).then(data => {
                    if (data.error) { showToast('错误', data.error, 'danger'); return; }
                    _showPropPanel(data);
                }).catch(e => { showToast('错误', e.message, 'danger'); });
        }

        function _showPropPanel(data) {
            const isDir = !!data.is_dir;
            const esc = s => _escHtml(String(s == null ? '' : s));
            const escAttr = s => esc(s).replace(/"/g, '&quot;');
            const ext = String(data.ext || '');
            const extras = data.extras || {};
            const typeText = isDir
                ? '文件夹'
                : ((data.mime_type && data.mime_type !== 'unknown')
                    ? data.mime_type
                    : (ext ? '.' + ext + ' 文件' : '文件'));
            const icon = fileIconHtml({ is_dir: isDir, name: data.name, ext: ext }, 'prop-hero-fileicon');

            /* 一行信息：label + value +（可选）悬停出现的复制按钮 */
            const row = (label, valueHtml, opts) => {
                opts = opts || {};
                const copy = opts.copy != null
                    ? `<button class="prop-copy" title="复制" data-copy="${escAttr(opts.copy)}"><i class="bi bi-clipboard"></i></button>`
                    : '';
                const cls = 'prop-value' + (opts.mono === false ? '' : ' mono') + (opts.cls ? ' ' + opts.cls : '');
                return `<div class="prop-row"><span class="prop-label">${esc(label)}</span>` +
                    `<span class="${cls}">${valueHtml}</span>${copy}</div>`;
            };
            const section = (title, iconCls, rows) => rows
                ? `<div class="prop-section"><div class="prop-sec-title"><i class="bi ${iconCls}"></i>${esc(title)}</div>${rows}</div>`
                : '';

            /* ---------- 基本信息 ---------- */
            let base = '';
            base += row('类型', esc(typeText));
            base += row('大小',
                `<strong>${esc(data.size_str || '-')}</strong>` +
                (Number(data.size) > 0 ? ` <span class="prop-sub">(${Number(data.size).toLocaleString()} 字节)</span>` : ''),
                { mono: false });
            if (!isDir && data.disk_size_str && data.disk_size !== data.size) {
                base += row('占用空间', `${esc(data.disk_size_str)} <span class="prop-sub">（磁盘实际占用）</span>`, { mono: false });
            }
            if (ext) base += row('扩展名', '.' + esc(ext), { copy: '.' + ext });
            if (extras.image) {
                base += row('图片尺寸',
                    `${extras.image.width} × ${extras.image.height} 像素` +
                    (extras.image.mode ? ` <span class="prop-sub">（${esc(extras.image.mode)}）</span>` : ''),
                    { mono: false });
            }
            if (extras.text) {
                base += row('文本内容',
                    `${Number(extras.text.lines).toLocaleString()} 行 · ${Number(extras.text.chars).toLocaleString()} 字节`,
                    { mono: false });
            }
            if (extras.md5) base += row('MD5', esc(extras.md5), { copy: extras.md5, cls: 'prop-hash' });

            /* ---------- 时间 ---------- */
            let times = '';
            times += row('创建时间', esc(data.created || '-'));
            times += row('修改时间', esc(data.modified || '-'));
            times += row('访问时间', esc(data.accessed || '-'));

            /* ---------- 位置 ---------- */
            let loc = '';
            loc += row('完整路径', esc(data.path || ''), { copy: data.path });
            loc += row('所在目录', esc(data.parent || ''), { copy: data.parent });

            /* ---------- 权限与归属 ---------- */
            let perm = '';
            perm += row('权限', `${esc(data.permissions || '-')} <span class="prop-sub">${esc(data.mode_str || '')}</span>`);
            perm += row('所有者', `${esc(data.owner || '-')} <span class="prop-sub">:${esc(data.group || '')}</span>`);
            if (data.inode) perm += row('inode', String(data.inode) + (data.links ? ` <span class="prop-sub">（${data.links} 个硬链接）</span>` : ''));
            if (data.is_symlink) perm += row('符号链接', '→ ' + esc(data.link_target || ''));

            /* ---------- 文件夹统计 ---------- */
            let dirBlock = '';
            if (isDir) {
                const cards = [
                    { k: '总大小', v: data.size_str || '0 B', icon: 'bi-hdd' },
                    { k: '文件', v: Number(data.total_files || 0).toLocaleString(), icon: 'bi-file-earmark' },
                    { k: '文件夹', v: Number(data.total_dirs || 0).toLocaleString(), icon: 'bi-folder' },
                    { k: '隐藏项', v: Number(data.hidden || 0).toLocaleString(), icon: 'bi-eye-slash' },
                ].map(c => `<div class="prop-card"><i class="bi ${c.icon}"></i>` +
                    `<div class="prop-card-v">${esc(c.v)}</div><div class="prop-card-k">${esc(c.k)}</div></div>`).join('');

                let rows = '';
                rows += row('直接子项', `${data.sub_dirs || 0} 个文件夹 · ${data.sub_files || 0} 个文件`, { mono: false });
                if (data.newest) rows += row('最近改动', esc(data.newest));
                if (data.largest) {
                    rows += row('最大文件', `${esc(data.largest)} <span class="prop-sub">${esc(data.largest_size_str || '')}</span>`);
                }
                dirBlock = `<div class="prop-section prop-section-wide"><div class="prop-sec-title"><i class="bi bi-bar-chart"></i>内容统计</div>` +
                    `<div class="prop-cards">${cards}</div>${rows}</div>`;
            }

            const overlay = document.createElement('div');
            overlay.className = 'custom-modal-overlay';
            overlay.innerHTML = `
            <div class="prop-panel">
                <div class="prop-header">
                    <span class="prop-title"><i class="bi ${isDir ? 'bi-folder-fill text-warning' : 'bi-info-circle'}"></i>${isDir ? '文件夹信息' : '文件信息'}</span>
                    <button class="prop-close" title="关闭"><i class="bi bi-x-lg"></i></button>
                </div>
                <div class="prop-hero">
                    <div class="prop-hero-icon">${icon}</div>
                    <div class="prop-hero-main">
                        <div class="prop-hero-name" title="${escAttr(data.name)}">${esc(data.name)}</div>
                        <div class="prop-hero-sub">${esc(typeText)}${data.size_str ? ' · ' + esc(data.size_str) : ''}</div>
                    </div>
                </div>
                <div class="prop-body">
                    ${section('基本信息', 'bi-info-circle', base)}
                    ${section('时间', 'bi-clock-history', times)}
                    ${section('位置', 'bi-geo-alt', loc)}
                    ${section('权限与归属', 'bi-shield-lock', perm)}
                    ${dirBlock}
                </div>
            </div>
        `;
            document.body.appendChild(overlay);
            overlay.querySelector('.prop-close').addEventListener('click', () => overlay.remove());
            overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
            overlay.querySelectorAll('[data-copy]').forEach(el => {
                el.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    _copyToClipboard(el.dataset.copy, '已复制到剪切板');
                });
            });
        }

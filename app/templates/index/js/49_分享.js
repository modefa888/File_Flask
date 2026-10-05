        // ========== 文件分享：设置弹层 + 分享记录管理 ==========
        const _SHARE_EXPIRE_TEXT = { '1h': '1 小时', '1d': '1 天', '7d': '7 天', '30d': '30 天', forever: '永久有效' };
        let _sharePanelRef = null;

        function _shareStateText(state) {
            if (state === 'expired') return '已过期';
            if (state === 'exhausted') return '次数已用完';
            if (state === 'revoked') return '已删除';
            return '有效';
        }

        function _copyText(text, okMsg) {
            if (!text) return;
            // 兼容方案：navigator.clipboard 只在 https / localhost 等安全上下文可用，
            // 通过 http://内网IP 访问时必须回退到 execCommand
            const legacyCopy = () => {
                let ta = null;
                try {
                    ta = document.createElement('textarea');
                    ta.value = text;
                    ta.setAttribute('readonly', '');
                    ta.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0;';
                    document.body.appendChild(ta);
                    ta.focus();
                    ta.select();
                    ta.setSelectionRange(0, ta.value.length);
                    const ok = document.execCommand('copy');
                    if (ok) showToast('成功', okMsg || '已复制到剪贴板', 'success');
                    else showToast('复制失败', '请手动选中复制', 'warning');
                } catch (err) {
                    showToast('复制失败', '请手动选中复制', 'warning');
                } finally {
                    if (ta && ta.parentNode) ta.parentNode.removeChild(ta);
                }
            };
            if (navigator.clipboard && window.isSecureContext) {
                navigator.clipboard.writeText(text)
                    .then(() => showToast('成功', okMsg || '已复制到剪贴板', 'success'))
                    .catch(legacyCopy);
            } else {
                legacyCopy();
            }
        }

        async function _fetchShares() {
            try {
                const r = await fetch('/api/shares');
                const d = await r.json();
                return d.items || [];
            } catch (err) {
                return [];
            }
        }

        function _findShareByPath(items, absPath) {
            return (items || []).find(it => it.abs_path === absPath && it.state === 'ok')
                || (items || []).find(it => it.abs_path === absPath)
                || null;
        }

        // ---------- 分享设置弹层：传文件路径或已有分享记录 ----------
        async function openShareDialog(target) {
            const isRecord = target && typeof target === 'object';
            const absPath = isRecord ? (target.abs_path || '') : String(target || '');
            if (!absPath) return;
            const container = document.getElementById('customModalContainer');
            if (!container) return;

            const fileName = isRecord ? (target.name || '') : (absPath.split('/').pop() || absPath);
            let rec = isRecord ? target : null;
            if (!rec) rec = _findShareByPath(await _fetchShares(), absPath);

            const overlay = document.createElement('div');
            overlay.className = 'custom-modal-overlay';
            overlay.innerHTML = `
                <div class="share-dialog">
                    <div class="sd-header">
                        <span class="sd-title"><i class="bi bi-share"></i> 分享文件</span>
                        <button class="sd-close" title="关闭"><i class="bi bi-x-lg"></i></button>
                    </div>
                    <div class="sd-file">
                        <i class="bi bi-file-earmark"></i>
                        <span class="sd-file-name">${_escHtml(fileName)}</span>
                        ${rec ? `<span class="sd-state ${rec.state}">${_shareStateText(rec.state)}</span>` : ''}
                    </div>
                    <div class="sd-body">
                        <label class="sd-label">分享链接</label>
                        <div class="sd-link-row">
                            <input type="text" class="sd-link" readonly value="${rec ? _escHtml(rec.full_url || '') : ''}" placeholder="尚未创建分享，点下方按钮生成">
                            <button class="sd-copy" title="复制链接"><i class="bi bi-clipboard"></i></button>
                        </div>

                        <div class="sd-grid">
                            <div>
                                <label class="sd-label">有效期</label>
                                <select class="sd-expire">
                                    <option value="forever">永久有效</option>
                                    <option value="1h">1 小时</option>
                                    <option value="1d">1 天</option>
                                    <option value="7d">7 天</option>
                                    <option value="30d">30 天</option>
                                </select>
                            </div>
                            <div>
                                <label class="sd-label">访问次数上限</label>
                                <input type="number" class="sd-maxviews" min="0" step="1" placeholder="0 = 不限"
                                    value="${rec && rec.max_views ? rec.max_views : ''}">
                            </div>
                        </div>

                        <label class="sd-label">访问密码（可选）</label>
                        <input type="text" class="sd-password" placeholder="${rec && rec.has_password ? '已设置密码，留空表示保持不变' : '留空表示无需密码'}">

                        <div class="sd-hint">
                            ${rec
                                ? `已访问 <strong>${rec.views || 0}</strong> 次 · ${_escHtml(rec.expires_str || '')} · 同一文件复用同一链接`
                                : '创建的链接不包含服务器路径信息，对方打开即可查看或下载。'}
                        </div>
                    </div>
                    <div class="sd-footer">
                        <button class="btn sd-revoke" ${rec ? '' : 'style="display:none"'}><i class="bi bi-trash3"></i> 删除分享</button>
                        <span class="sd-spacer"></span>
                        <button class="btn sd-open" ${rec ? '' : 'style="display:none"'}><i class="bi bi-box-arrow-up-right"></i> 打开</button>
                        <button class="btn sd-save primary"><i class="bi bi-check2"></i> ${rec ? '保存设置' : '生成分享'}</button>
                    </div>
                </div>`;
            container.appendChild(overlay);

            const linkEl = overlay.querySelector('.sd-link');
            const expireEl = overlay.querySelector('.sd-expire');
            const maxViewsEl = overlay.querySelector('.sd-maxviews');
            const passwordEl = overlay.querySelector('.sd-password');
            const openBtn = overlay.querySelector('.sd-open');
            const revokeBtn = overlay.querySelector('.sd-revoke');
            const saveBtn = overlay.querySelector('.sd-save');

            if (rec) {
                const exp = rec.expires_at && rec.expires_str ? rec.expires_str : '';
                if (rec.expires_at && rec.expires_at * 1000 > Date.now()) {
                    const left = rec.expires_at * 1000 - Date.now();
                    expireEl.value = left <= 3600e3 ? '1h' : left <= 86400e3 ? '1d' : left <= 7 * 86400e3 ? '7d' : '30d';
                } else {
                    expireEl.value = 'forever';
                }
                if (exp) expireEl.title = '当前到期：' + exp;
            }

            const close = () => { if (document.body.contains(overlay)) overlay.remove(); };
            overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
            overlay.querySelector('.sd-close').addEventListener('click', close);

            overlay.querySelector('.sd-copy').addEventListener('click', () => {
                if (!linkEl.value) { showToast('提示', '请先生成分享链接', 'warning'); return; }
                _copyText(linkEl.value, '分享链接已复制');
            });
            if (openBtn) openBtn.addEventListener('click', () => {
                if (linkEl.value) window.open(linkEl.value, '_blank');
            });
            if (revokeBtn) revokeBtn.addEventListener('click', async () => {
                if (!rec) return;
                const ok = await showConfirm('确定删除该分享吗？删除后链接立即失效。');
                if (!ok) return;
                await _deleteShare(rec.id);
                close();
            });

            saveBtn.addEventListener('click', async () => {
                saveBtn.disabled = true;
                const password = (passwordEl.value || '').trim();
                const payload = {
                    expires_in: expireEl.value,
                    max_views: parseInt(maxViewsEl.value || '0', 10) || 0,
                };
                // 已有密码且输入为空 → 不改密码
                if (password || !rec || !rec.has_password) payload.password = password;
                let res;
                if (rec && rec.id) {
                    res = await fetch('/api/share/update', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(Object.assign({ id: rec.id }, payload)),
                    });
                } else {
                    res = await fetch('/api/share', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(Object.assign({ path: absPath }, payload)),
                    });
                }
                const data = await res.json().catch(() => ({}));
                saveBtn.disabled = false;
                if (!res.ok) { showToast('分享失败', data.error || '请重试', 'danger'); return; }
                rec = data;
                linkEl.value = data.full_url || '';
                if (openBtn) openBtn.style.display = '';
                if (revokeBtn) revokeBtn.style.display = '';
                saveBtn.innerHTML = '<i class="bi bi-check2"></i> 保存设置';
                passwordEl.value = '';
                passwordEl.placeholder = data.has_password ? '已设置密码，留空表示保持不变' : '留空表示无需密码';
                showToast('成功', '分享已就绪，链接已填入', 'success');
                _copyText(data.full_url, '分享链接已复制');
            });
        }

        async function _deleteShare(id) {
            try {
                const r = await fetch('/api/share', {
                    method: 'DELETE',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id }),
                });
                const d = await r.json().catch(() => ({}));
                if (!r.ok) { showToast('删除失败', d.error || '请重试', 'warning'); return false; }
                showToast('成功', '分享已删除', 'success');
                if (_sharePanelRef) _loadSharePanelList();
                return true;
            } catch (err) {
                showToast('删除失败', '网络错误', 'danger');
                return false;
            }
        }

        // ---------- 分享记录管理面板 ----------
        function showSharePanel() {
            const container = document.getElementById('sharePanel');
            if (!container) return;
            if (_sharePanelRef) return;
            container.innerHTML = `
                <div class="share-overlay">
                    <div class="share-panel">
                        <div class="panel-header">
                            <span class="panel-title"><i class="bi bi-share"></i> 分享记录<span class="share-total" id="shareTotal"></span></span>
                            <button class="panel-close" title="关闭"><i class="bi bi-x-lg"></i></button>
                        </div>
                        <div class="panel-body" id="sharePanelBody">
                            <div class="share-empty"><i class="bi bi-hourglass-split"></i>加载中...</div>
                        </div>
                        <div class="panel-footer">
                            <button class="share-btn-refresh" id="shareRefreshBtn"><i class="bi bi-arrow-clockwise"></i> 刷新</button>
                        </div>
                    </div>
                </div>`;
            const overlay = container.querySelector('.share-overlay');
            _sharePanelRef = overlay;
            container.querySelector('.panel-close').addEventListener('click', closeSharePanel);
            overlay.addEventListener('click', (e) => { if (e.target === overlay) closeSharePanel(); });
            container.querySelector('#shareRefreshBtn').addEventListener('click', _loadSharePanelList);
            _loadSharePanelList();
        }

        function closeSharePanel() {
            const container = document.getElementById('sharePanel');
            if (container) container.innerHTML = '';
            _sharePanelRef = null;
        }

        async function _loadSharePanelList() {
            const body = document.getElementById('sharePanelBody');
            if (!body) return;
            const items = await _fetchShares();
            const totalEl = document.getElementById('shareTotal');
            if (totalEl) totalEl.textContent = items.length ? items.length + ' 条' : '';
            if (!items.length) {
                body.innerHTML = '<div class="share-empty"><i class="bi bi-share"></i>还没有创建过分享</div>';
                return;
            }
            body.innerHTML = items.map(it => {
                const stateText = _shareStateText(it.state);
                const limit = it.max_views ? ` / ${it.max_views}` : '';
                return `
                <div class="share-item ${it.state}" data-id="${it.id}">
                    <div class="shi-icon"><i class="bi bi-file-earmark"></i></div>
                    <div class="shi-info">
                        <div class="shi-name" title="${_escHtml(it.abs_path || '')}">${_escHtml(it.name || '')}</div>
                        <div class="shi-link" title="${_escHtml(it.full_url || '')}">${_escHtml(it.full_url || '')}</div>
                        <div class="shi-meta">
                            <span class="shi-state ${it.state}"><i class="bi bi-${it.state === 'ok' ? 'check-circle' : 'exclamation-circle'}"></i> ${stateText}</span>
                            <span><i class="bi bi-eye"></i> ${it.views || 0}${limit}</span>
                            <span><i class="bi bi-clock"></i> ${_escHtml(it.expires_str || '')}</span>
                            ${it.has_password ? '<span><i class="bi bi-shield-lock"></i> 已加密</span>' : ''}
                        </div>
                    </div>
                    <div class="shi-actions">
                        <button class="btn shi-copy" title="复制链接"><i class="bi bi-clipboard"></i></button>
                        <button class="btn shi-open" title="打开链接"><i class="bi bi-box-arrow-up-right"></i></button>
                        <button class="btn shi-set" title="设置"><i class="bi bi-sliders"></i></button>
                        <button class="btn shi-del" title="删除"><i class="bi bi-trash3"></i></button>
                    </div>
                </div>`;
            }).join('');

            body.querySelectorAll('.share-item').forEach(el => {
                const rec = items.find(x => String(x.id) === el.dataset.id);
                if (!rec) return;
                el.querySelector('.shi-copy').addEventListener('click', () => _copyText(rec.full_url, '分享链接已复制'));
                el.querySelector('.shi-open').addEventListener('click', () => {
                    if (rec.full_url) window.open(rec.full_url, '_blank');
                });
                el.querySelector('.shi-set').addEventListener('click', () => openShareDialog(rec));
                el.querySelector('.shi-del').addEventListener('click', async () => {
                    const ok = await showConfirm('确定删除「' + (rec.name || '') + '」的分享吗？删除后链接立即失效。');
                    if (ok) _deleteShare(rec.id);
                });
            });
        }

        // 顶部「分享」按钮
        (function () {
            const btn = document.getElementById('sharePanelBtn');
            if (btn) btn.addEventListener('click', showSharePanel);
        })();

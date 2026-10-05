        // ========== 自定义弹窗 ==========
        const _toastIcons = { success: '✅', danger: '❌', warning: '⚠️', info: 'ℹ️' };

        function showToast(title, message, type = 'info') {
            const container = document.getElementById('customToastContainer');
            const icon = _toastIcons[type] || _toastIcons.info;
            const toast = document.createElement('div');
            toast.className = `custom-toast ${type}`;
            toast.innerHTML = `
            <span class="toast-icon">${icon}</span>
            <div>
                <strong>${title}</strong>
                <div style="margin-top:2px;opacity:0.9;font-size:0.85rem;">${message.replace(/\n/g, '<br>')}</div>
            </div>
        `;
            container.appendChild(toast);
            setTimeout(() => {
                toast.style.opacity = '0';
                toast.style.transform = 'translateY(-8px)';
                toast.style.transition = 'all 0.25s ease';
                setTimeout(() => toast.remove(), 250);
            }, 3000);
        }

        function showConfirm(message) {
            return new Promise((resolve) => {
                const container = document.getElementById('customModalContainer');
                const overlay = document.createElement('div');
                overlay.className = 'custom-modal-overlay';
                overlay.innerHTML = `
                <div class="custom-modal">
                    <div class="modal-title">⚠️ 确认操作</div>
                    <div class="modal-body">${message}</div>
                    <div class="modal-footer">
                        <button class="btn btn-cancel" data-result="false">取消</button>
                        <button class="btn btn-confirm" data-result="true">确认删除</button>
                    </div>
                </div>
            `;
                container.appendChild(overlay);
                const close = () => {
                    if (document.body.contains(overlay)) overlay.remove();
                };
                overlay.querySelectorAll('[data-result]').forEach(btn => {
                    btn.addEventListener('click', () => {
                        close();
                        resolve(btn.dataset.result === 'true');
                    });
                });
                overlay.addEventListener('click', (e) => {
                    if (e.target === overlay) { close(); resolve(false); }
                });
                document.addEventListener('keydown', function onKey(e) {
                    if (e.key === 'Escape') { close(); resolve(false); document.removeEventListener('keydown', onKey); }
                });
            });
        }

        /**
         * 多选确认框：在「取消」之外提供多个操作按钮。
         * @param {Object} opts
         * @param {string} opts.title    标题（可含 HTML）
         * @param {string} opts.message  正文（可含 HTML，注意 modal-body 为 pre-wrap，避免缩进换行）
         * @param {Array}  opts.actions  [{ value, text, cls, icon }]，cls 默认 btn-ok
         * @returns {Promise<string>} 'cancel' 或某个 action.value
         */
        function showChoiceModal(opts) {
            const o = opts || {};
            return new Promise((resolve) => {
                const container = document.getElementById('customModalContainer');
                if (!container) { resolve('cancel'); return; }
                const actions = o.actions || [];
                const btns = actions.map(a =>
                    `<button class="btn ${a.cls || 'btn-ok'}" data-result="${a.value}">${a.icon ? `<i class="bi ${a.icon}"></i> ` : ''}${a.text}</button>`
                ).join('');
                const overlay = document.createElement('div');
                overlay.className = 'custom-modal-overlay';
                overlay.innerHTML = `
                <div class="custom-modal">
                    <div class="modal-title">${o.title || '请选择操作'}</div>
                    <div class="modal-body">${o.message || ''}</div>
                    <div class="modal-footer">
                        <button class="btn btn-cancel" data-result="cancel">${o.cancelText || '取消'}</button>
                        ${btns}
                    </div>
                </div>`;
                const onKey = (e) => { if (e.key === 'Escape') done('cancel'); };
                const done = (result) => {
                    document.removeEventListener('keydown', onKey);
                    if (document.body.contains(overlay)) overlay.remove();
                    resolve(result);
                };
                container.appendChild(overlay);
                overlay.querySelectorAll('[data-result]').forEach(btn => {
                    btn.addEventListener('click', () => done(btn.dataset.result));
                });
                overlay.addEventListener('click', (e) => { if (e.target === overlay) done('cancel'); });
                document.addEventListener('keydown', onKey);
            });
        }

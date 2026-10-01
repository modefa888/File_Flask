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

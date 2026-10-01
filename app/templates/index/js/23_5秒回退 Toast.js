        // ========== 5秒回退 Toast ==========
        let _undoTimeouts = [];

        function showUndoToast(trashItems) {
            const container = document.getElementById('undoToastContainer');
            const count = trashItems.length;
            let displayName = '';
            if (count === 1) {
                displayName = trashItems[0].name;
            } else if (count <= 3) {
                displayName = trashItems.map(t => t.name).join('、');
            } else {
                displayName = trashItems[0].name + ' 等 ' + count + ' 项';
            }

            const toast = document.createElement('div');
            toast.className = 'undo-toast';
            toast.innerHTML = `
            <span class="undo-icon">🗑️</span>
            <div class="undo-content">
                <div class="undo-title"><span class="undo-countdown" id="udc_${trashItems[0].id}">5s</span></div>
                <div class="undo-msg">已删除 ${count} 项: ${displayName}</div>
            </div>
            <button class="undo-btn" id="undobtn_${trashItems[0].id}">
                <i class="bi bi-arrow-counterclockwise"></i> 撤销
            </button>
            <div class="undo-progress" style="width:100%"></div>
        `;
            container.appendChild(toast);

            const trashIds = trashItems.map(t => t.id);
            let remaining = 5;
            const countdownEl = toast.querySelector('.undo-countdown');
            const progressEl = toast.querySelector('.undo-progress');
            const undoBtn = toast.querySelector('.undo-btn');

            const undoAction = async () => {
                let allSuccess = true;
                for (const tid of trashIds) {
                    try {
                        const r = await fetch('/api/undo-delete', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ trash_id: tid })
                        });
                        const data = await r.json();
                        if (!data.success) { allSuccess = false; }
                    } catch (e) { allSuccess = false; }
                }
                if (allSuccess) {
                    showToast('恢复成功', '已恢复 ' + count + ' 项到原位置', 'success');
                    loadFiles(currentPath);
                    loadDeleteHistoryCount();
                } else {
                    showToast('恢复失败', '部分项目恢复失败', 'warning');
                }
                toast.remove();
                clearInterval(intervalId);
            };

            undoBtn.addEventListener('click', () => {
                undoAction();
            });

            const intervalId = setInterval(() => {
                remaining -= 0.1;
                if (remaining <= 0) {
                    clearInterval(intervalId);
                    toast.remove();
                    return;
                }
                const pct = (remaining / 5) * 100;
                progressEl.style.width = pct + '%';
                const sec = Math.ceil(remaining);
                countdownEl.textContent = sec + 's';
                countdownEl.style.background = sec <= 2 ? '#dc2626' : '#fee2e2';
                countdownEl.style.color = sec <= 2 ? 'white' : '#dc2626';
            }, 100);

            // 限制最多显示 3 个 toast
            while (container.children.length > 3) {
                container.firstChild.remove();
            }
        }

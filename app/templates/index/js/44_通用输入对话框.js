        // ========== 通用输入对话框 ==========
        function showInputDialog(title, label, defaultVal, onConfirm, validate, opts) {
            opts = opts || {};
            const sugg = Array.isArray(opts.suggestions) ? opts.suggestions.filter(Boolean) : [];
            const suggHtml = sugg.length ? `
                    <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:10px;">
                        <span style="font-size:0.75rem;color:#94a3b8;">${opts.suggestionsLabel || '快选'}：</span>
                        ${sugg.map(s => `<button type="button" class="input-sugg-chip" data-val="${_escAttr(s)}">${_escapeHtml(s)}</button>`).join('')}
                    </div>` : '';
            const overlay = document.createElement('div');
            overlay.className = 'custom-modal-overlay';
            overlay.innerHTML = `
            <div class="custom-modal">
                <div class="modal-title"><i class="bi bi-pencil"></i> ${title}</div>
                <div class="modal-body">
                    <label style="display:block;font-size:0.8rem;color:#718096;margin-bottom:6px;">${label}</label>
                    <input type="text" class="form-control" id="inputDialogValue" style="font-family:monospace;font-size:0.85rem;" value="${_escapeHtml(defaultVal)}" />
                    ${suggHtml}
                    <div id="inputDialogError" style="font-size:0.78rem;color:#dc2626;margin-top:6px;display:none;"></div>
                </div>
                <div class="modal-footer">
                    <button class="btn btn-cancel" id="inputCancel">取消</button>
                    <button class="btn btn-ok" id="inputOk">确定</button>
                </div>
            </div>
        `;
            document.body.appendChild(overlay);
            const input = overlay.querySelector('#inputDialogValue');
            const okBtn = overlay.querySelector('#inputOk');
            const errEl = overlay.querySelector('#inputDialogError');
            // 快选列表：点击填入输入框
            overlay.querySelectorAll('.input-sugg-chip').forEach(chip => {
                chip.addEventListener('click', () => {
                    input.value = chip.dataset.val;
                    input.dispatchEvent(new Event('input'));
                    input.focus();
                });
            });
            input.focus(); input.select();

            // 验证函数
            let isValid = true;
            const runValidation = () => {
                if (!validate) { isValid = true; errEl.style.display = 'none'; okBtn.disabled = false; return; }
                const result = validate(input.value);
                if (result.valid) {
                    isValid = true;
                    errEl.style.display = 'none';
                    okBtn.disabled = false;
                } else {
                    isValid = false;
                    errEl.textContent = result.message;
                    errEl.style.display = 'block';
                    okBtn.disabled = true;
                }
            };

            const confirm = () => {
                if (!isValid) return;
                const val = input.value;
                const ret = onConfirm(val);
                if (ret && typeof ret.then === 'function') {
                    // 异步确认：等待 Promise 结果，false 保持弹窗打开
                    okBtn.disabled = true;
                    ret.then(ok => {
                        if (ok === false) { okBtn.disabled = false; return; }
                        overlay.remove();
                    }).catch(() => { okBtn.disabled = false; });
                    return;
                }
                if (ret === false) return;
                overlay.remove();
            };

            overlay.querySelector('#inputOk').addEventListener('click', confirm);
            overlay.querySelector('#inputCancel').addEventListener('click', () => overlay.remove());
            overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
            input.addEventListener('input', runValidation);
            input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && isValid) confirm(); });

            // 初始验证
            runValidation();
        }

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
           <div class="custom-modal input-modal">
               <div class="modal-title"><i class="bi bi-pencil-square"></i><span>${title}</span></div>
               <div class="modal-body">
                   <label class="input-modal-label">${label}</label>
                   <input type="${opts.password ? "password" : "text"}" class="form-control" id="inputDialogValue" value="${_escapeHtml(defaultVal)}" />
                   ${suggHtml}
                   <div id="inputDialogError" class="input-modal-error"></div>
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
                    // 异步确认：false / 错误信息字符串 → 保持弹窗打开
                    okBtn.disabled = true;
                    ret.then(ok => {
                        okBtn.disabled = false;
                        if (ok === false) return;
                        // 返回字符串 = 失败原因：直接显示在弹窗里（比 toast 更贴近输入框）
                        if (typeof ok === 'string' && ok) {
                            errEl.textContent = ok;
                            errEl.style.display = 'block';
                            return;
                        }
                        overlay.remove();
                    }).catch(e => {
                        okBtn.disabled = false;
                        if (e && e.message) { errEl.textContent = e.message; errEl.style.display = 'block'; }
                    });
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

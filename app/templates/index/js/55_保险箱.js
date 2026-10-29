        // ========== 保险箱：私密文件加密存放（密码解锁，服务端 AES-256-GCM 密文落盘） ==========
        (function () {
            const host = () => document.getElementById('vaultPanel');
            const st = { enabled: false, unlocked: false, items: [] };
            let busy = false;

            const esc = s => _escHtml(String(s == null ? '' : s));
            const escAttr = s => esc(s);

            async function req(url, opts) {
                const res = await fetch(url, opts || {});
                let data = {};
                try { data = await res.json(); } catch (_) { data = {}; }
                if (!res.ok) throw new Error(data.error || ('请求失败（HTTP ' + res.status + '）'));
                return data;
            }

            function fmtTime(ts) {
                if (!ts) return '--';
                const d = new Date(ts * 1000);
                const p = n => (n < 10 ? '0' : '') + n;
                return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
                    ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
            }

            /* ---------------- 面板骨架 ---------------- */
            function ensureShell() {
                const box = host();
                if (box.dataset.ready === '1') return box;
                box.innerHTML = `
                    <div class="vault-mask"></div>
                    <aside class="vault-panel">
                        <div class="vault-hd">
                            <span class="vault-title"><i class="bi bi-shield-lock-fill"></i> 保险箱</span>
                            <span class="vault-state"></span>
                            <button class="vault-close" title="关闭"><i class="bi bi-x-lg"></i></button>
                        </div>
                        <div class="vault-body"></div>
                    </aside>`;
                box.dataset.ready = '1';
                box.querySelector('.vault-close').addEventListener('click', close);
                // 不再点遮罩关闭：面板打开时左侧仍可正常浏览，避免误触把面板关掉
                return box;
            }

            function open() {
                ensureShell();
                host().classList.add('show');
                refresh();
            }
            function close() {
                const box = host();
                if (box) box.classList.remove('show');
            }

            /* ---------------- 各状态视图 ---------------- */
            function renderSetup(box) {
                box.querySelector('.vault-state').textContent = '未启用';
                box.querySelector('.vault-body').innerHTML = `
                    <div class="vault-hero">
                        <i class="bi bi-shield-lock"></i>
                        <div>
                            <div class="vault-hero-t">首次使用，先设置一个密码</div>
                            <div class="vault-hero-d">密码只用于加解密保险箱里的文件，服务端不保存明文。忘记密码将无法恢复文件内容，请务必记牢。</div>
                        </div>
                    </div>
                    <div class="vault-form">
                        <label class="vault-lb">保险箱密码</label>
                        <input type="password" class="vault-in" id="vaultPw1" placeholder="至少 6 位" autocomplete="new-password">
                        <label class="vault-lb">再次输入</label>
                        <input type="password" class="vault-in" id="vaultPw2" placeholder="再输一次确认" autocomplete="new-password">
                        <div class="vault-err" id="vaultErr"></div>
                        <button class="vault-btn primary" id="vaultSetupBtn"><i class="bi bi-shield-check"></i> 创建保险箱</button>
                    </div>`;
                const err = msg => { box.querySelector('#vaultErr').textContent = msg || ''; };
                const go = async () => {
                    if (busy) return;
                    const p1 = box.querySelector('#vaultPw1').value;
                    const p2 = box.querySelector('#vaultPw2').value;
                    if (p1.length < 6) return err('密码至少 6 位');
                    if (p1 !== p2) return err('两次输入的密码不一致');
                    busy = true;
                    try {
                        const d = await req('/api/vault/setup', {
                            method: 'POST', headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ password: p1 }),
                        });
                        st.enabled = true; st.unlocked = true; st.items = d.items || [];
                        toast('成功', '保险箱已创建', 'success');
                        // 初始化成功后直接进入「已解锁」的文件页
                        await refresh();
                        if (!st.unlocked) render();
                    } catch (e) { err(e.message); }
                    finally { busy = false; }
                };
                box.querySelector('#vaultSetupBtn').addEventListener('click', go);
                box.querySelectorAll('.vault-in').forEach(inp => {
                    inp.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
                });
                box.querySelector('#vaultPw1').focus();
            }

            function renderLocked(box) {
                box.querySelector('.vault-state').textContent = '已锁定';
                box.querySelector('.vault-body').innerHTML = `
                    <div class="vault-hero">
                        <i class="bi bi-lock"></i>
                        <div>
                            <div class="vault-hero-t">保险箱已锁定</div>
                            <div class="vault-hero-d">输入密码解锁后可查看 / 上传 / 下载文件；解锁有效期 1 小时，期间有操作会自动续期。</div>
                        </div>
                    </div>
                    <div class="vault-form">
                        <label class="vault-lb">密码</label>
                        <input type="password" class="vault-in" id="vaultPw" placeholder="输入保险箱密码" autocomplete="current-password">
                        <div class="vault-err" id="vaultErr"></div>
                        <button class="vault-btn primary" id="vaultUnlockBtn"><i class="bi bi-unlock"></i> 解锁</button>
                    </div>`;
                const err = msg => { box.querySelector('#vaultErr').textContent = msg || ''; };
                const go = async () => {
                    if (busy) return;
                    const pw = box.querySelector('#vaultPw').value;
                    if (!pw) return err('请输入密码');
                    busy = true;
                    const btn = box.querySelector('#vaultUnlockBtn');
                    btn.disabled = true;
                    try {
                        const d = await req('/api/vault/unlock', {
                            method: 'POST', headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ password: pw }),
                        });
                        st.unlocked = true; st.items = d.items || [];
                        // 解锁后受保护的文件重新出现在文件列表里
                        if (typeof loadFiles === 'function' && typeof currentPath === 'string') loadFiles(currentPath);
                        render();
                    } catch (e) { err(e.message); }
                    finally { busy = false; btn.disabled = false; }
                };
                box.querySelector('#vaultUnlockBtn').addEventListener('click', go);
                box.querySelector('#vaultPw').addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
                box.querySelector('#vaultPw').focus();
            }

            function renderUnlocked(box) {
                const total = st.items.reduce((s, it) => s + (it.size || 0), 0);
                box.querySelector('.vault-state').textContent = '已解锁 · ' + st.items.length + ' 个文件 · ' + formatSize(total);
                const rows = st.items.length ? st.items.map(it => {
                    const isPath = it.kind === 'path';
                    const ico = isPath ? (it.is_dir ? 'bi-folder-fill' : 'bi-file-earmark-text') : 'bi-file-earmark-lock2';
                    const icoCls = 'vault-row-ico' + (isPath && it.is_dir ? ' dir' : '');
                    const sizeTxt = isPath && it.is_dir ? '文件夹' : formatSize(it.size || 0);
                    return `
                    <div class="vault-row${isPath ? ' vault-row-link' : ''}" data-id="${escAttr(it.id)}" data-kind="${isPath ? 'path' : 'file'}"
                         ${isPath ? 'title="点击在文件管理器中打开（' + escAttr(it.path) + '）"' : ''}>
                        <i class="bi ${ico} ${icoCls}"></i>
                        <span class="vault-row-main">
                            <span class="vault-row-name" title="${escAttr(it.name)}">${esc(it.name)}</span>
                            ${isPath ? `<span class="vault-row-path" title="${escAttr(it.path)}">${esc(it.path)}</span>` : ''}
                        </span>
                        <span class="vault-row-size">${sizeTxt}</span>
                        <span class="vault-row-time">${fmtTime(it.mtime || it.created)}</span>
                        ${isPath ? '' : '<button class="vault-act dl" title="下载"><i class="bi bi-download"></i></button>'}
                        <button class="vault-act del" title="${isPath ? '移出保险箱（不删除源文件）' : '删除'}">
                            <i class="bi ${isPath ? 'bi-box-arrow-up' : 'bi-trash3'}"></i></button>
                    </div>`;
                }).join('') : `
                    <div class="vault-empty"><i class="bi bi-inbox"></i><div>还没有内容：可以「上传文件」加密保存，或在文件上右键「加入保险箱」登记保护</div></div>`;

                box.querySelector('.vault-body').innerHTML = `
                    <div class="vault-bar">
                        <button class="vault-btn primary" id="vaultUploadBtn"><i class="bi bi-cloud-arrow-up"></i> 上传文件</button>
                        <input type="file" id="vaultFileInput" multiple hidden>
                        <span class="vault-bar-sp"></span>
                        <button class="vault-btn" id="vaultPwBtn" title="修改保险箱密码"><i class="bi bi-key"></i> 修改密码</button>
                        <button class="vault-btn" id="vaultLockBtn" title="立即锁定"><i class="bi bi-lock"></i> 锁定</button>
                    </div>
                    <div class="vault-tip"><i class="bi bi-info-circle"></i> 「上传文件」会以 AES-256-GCM 密文存进 <code>data/vault</code>；右键「加入保险箱」只是登记访问保护，<b>电脑上的源文件不会被移动或删除</b>。</div>
                    <div class="vault-list">${rows}</div>
                    <div class="vault-hint" id="vaultHint"></div>`;

                const hint = (msg, cls) => {
                    const el = box.querySelector('#vaultHint');
                    el.textContent = msg || '';
                    el.className = 'vault-hint' + (cls ? ' ' + cls : '');
                };

                const input = box.querySelector('#vaultFileInput');
                box.querySelector('#vaultUploadBtn').addEventListener('click', () => input.click());
                input.addEventListener('change', async () => {
                    const files = Array.from(input.files || []);
                    if (!files.length) return;
                    let ok = 0, fail = 0;
                    for (let i = 0; i < files.length; i++) {
                        const f = files[i];
                        hint('正在上传 ' + (i + 1) + '/' + files.length + '：' + f.name, 'busy');
                        const fd = new FormData();
                        fd.append('file', f, f.name);
                        try {
                            const d = await req('/api/vault/upload', { method: 'POST', body: fd });
                            st.items = d.items || st.items; ok++;
                        } catch (e) { fail++; hint('上传失败：' + e.message, 'bad'); }
                    }
                    input.value = '';
                    if (ok) toast('成功', '已加密保存 ' + ok + ' 个文件', 'success');
                    if (fail) toast('提示', fail + ' 个文件上传失败', 'danger');
                    render();
                });

                box.querySelector('#vaultLockBtn').addEventListener('click', async () => {
                    try { await req('/api/vault/lock', { method: 'POST' }); } catch (_) { }
                    st.unlocked = false; st.items = [];
                    // 锁定后刷新列表：受保护的文件重新隐藏
                    if (typeof loadFiles === 'function' && typeof currentPath === 'string') loadFiles(currentPath);
                    render();
                });

                box.querySelector('#vaultPwBtn').addEventListener('click', () => renderPasswd(box));

                box.querySelectorAll('.vault-row').forEach(row => {
                    const id = row.dataset.id;
                    const isPath = row.dataset.kind === 'path';
                    // 受保护路径：点整行直接跳到它在文件管理器里的位置（源文件本来就在磁盘上）
                    if (isPath) {
                        row.addEventListener('click', e => {
                            if (e.target.closest('.vault-act')) return;   // 操作按钮不触发跳转
                            const it = st.items.find(x => x.id === id);
                            if (!it || !it.path) return;
                            // 不关闭面板：可以在保险箱里连续点开多个条目查看
                            if (it.is_dir) {
                                if (typeof navigateTo === 'function') navigateTo(it.path);
                                return;
                            }
                            // 文件：跳到所在目录并闪烁高亮这一项
                            const p = String(it.path);
                            const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
                            const parent = idx > 0 ? p.slice(0, idx) : p;
                            if (typeof navigateTo === 'function') navigateTo(parent);
                            try {
                                if (typeof _highlightRowByPath === 'function') {
                                    // 列表还没渲染完：交给收藏模块的轮询高亮
                                    _pendingHighlightPath = p;
                                    _pollPendingHighlight();
                                }
                            } catch (_) { }
                        });
                    }
                    const dl = row.querySelector('.vault-act.dl');
                    if (dl) dl.addEventListener('click', () => {
                        window.location.href = '/api/vault/download/' + encodeURIComponent(id);
                    });
                    row.querySelector('.vault-act.del').addEventListener('click', async () => {
                        const askMsg = isPath
                            ? '把这个条目移出保险箱吗？\n（只是取消保护，电脑上的源文件不会被删除）'
                            : '删除后无法恢复，确定要继续吗？';
                        const ok = (typeof window.uiConfirmPop === 'function')
                            ? await window.uiConfirmPop(row.querySelector('.vault-act.del'), {
                                danger: !isPath, title: isPath ? '移出保险箱' : '删除文件',
                                msg: askMsg, okText: isPath ? '移出' : '删除',
                            })
                            : window.confirm(askMsg);
                        if (!ok) return;
                        try {
                            const d = await req('/api/vault/delete', {
                                method: 'POST', headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ id }),
                            });
                            st.items = d.items || [];
                            toast('提示', '已删除', 'info');
                            render();
                        } catch (e) { toast('错误', e.message, 'danger'); }
                    });
                });
            }

            function renderPasswd(box) {
                box.querySelector('.vault-body').innerHTML = `
                    <div class="vault-hero">
                        <i class="bi bi-key"></i>
                        <div>
                            <div class="vault-hero-t">修改保险箱密码</div>
                            <div class="vault-hero-d">会用新密码把现有文件全部重新加密，期间请不要关闭页面。</div>
                        </div>
                    </div>
                    <div class="vault-form">
                        <label class="vault-lb">原密码</label>
                        <input type="password" class="vault-in" id="vaultOldPw" autocomplete="current-password">
                        <label class="vault-lb">新密码</label>
                        <input type="password" class="vault-in" id="vaultNewPw" placeholder="至少 6 位" autocomplete="new-password">
                        <label class="vault-lb">确认新密码</label>
                        <input type="password" class="vault-in" id="vaultNewPw2" autocomplete="new-password">
                        <div class="vault-err" id="vaultErr"></div>
                        <div class="vault-form-row">
                            <button class="vault-btn primary" id="vaultPwOk"><i class="bi bi-check2"></i> 确认修改</button>
                            <button class="vault-btn" id="vaultPwCancel">返回</button>
                        </div>
                    </div>`;
                const err = msg => { box.querySelector('#vaultErr').textContent = msg || ''; };
                box.querySelector('#vaultPwCancel').addEventListener('click', () => render());
                box.querySelector('#vaultPwOk').addEventListener('click', async () => {
                    const oldPw = box.querySelector('#vaultOldPw').value;
                    const n1 = box.querySelector('#vaultNewPw').value;
                    const n2 = box.querySelector('#vaultNewPw2').value;
                    if (!oldPw) return err('请输入原密码');
                    if (n1.length < 6) return err('新密码至少 6 位');
                    if (n1 !== n2) return err('两次输入的新密码不一致');
                    const btn = box.querySelector('#vaultPwOk');
                    btn.disabled = true;
                    err('');
                    try {
                        await req('/api/vault/passwd', {
                            method: 'POST', headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ old: oldPw, new: n1 }),
                        });
                        toast('成功', '密码已修改，文件已重新加密', 'success');
                        render();
                    } catch (e) { err(e.message); }
                    finally { btn.disabled = false; }
                });
                box.querySelector('#vaultOldPw').focus();
            }

            function render() {
                const box = ensureShell();
                if (!st.enabled) return renderSetup(box);
                if (!st.unlocked) return renderLocked(box);
                return renderUnlocked(box);
            }

            async function refresh() {
                try {
                    const d = await req('/api/vault/status');
                    st.enabled = !!d.enabled;
                    st.unlocked = !!d.unlocked;
                    if (st.unlocked) {
                        try {
                            const l = await req('/api/vault/list');
                            st.items = l.items || [];
                        } catch (_) { st.unlocked = false; st.items = []; }
                    } else {
                        st.items = [];
                    }
                } catch (e) {
                    toast('错误', e.message, 'danger');
                }
                render();
            }

            /* ---------------- 右键「加入保险箱」 ---------------- */
            function askUnlock(onOk) {
                showInputDialog('解锁保险箱', '输入保险箱密码（解锁后 1 小时内有效）', '', async pw => {
                    if (!pw) return false;
                    try {
                        const d = await req('/api/vault/unlock', {
                            method: 'POST', headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ password: pw }),
                        });
                        st.enabled = true; st.unlocked = true; st.items = d.items || [];
                        // 解锁后受保护的文件重新出现在列表里
                        if (typeof loadFiles === 'function' && typeof currentPath === 'string') loadFiles(currentPath);
                        onOk && onOk();
                        return true;
                    } catch (e) {
                        // 返回字符串 → 直接显示在弹窗的提示区（保持打开，方便重输）
                        return e.message || '解锁失败';
                    }
                }, null, { password: true });
            }

            async function addToVault(absPath) {
                if (!absPath) return;
                const name = String(absPath).split(/[\\/]/).pop() || absPath;
                let s;
                try { s = await req('/api/vault/status'); }
                catch (e) { toast('错误', e.message, 'danger'); return; }

                if (!s.enabled) {
                    toast('提示', '请先在保险箱里设置密码，再把文件加进来', 'info');
                    open();
                    return;
                }

                const doAdd = async () => {
                    const ok = await showConfirm(
                        '把「' + esc(name) + '」加入保险箱？\n\n' +
                        '· 只做访问保护：电脑上的源文件保持不动，不加密、不移动、不删除\n' +
                        '· 保险箱锁定期间，它会从文件列表里隐藏，也打不开\n' +
                        '· 输入密码解锁后（1 小时有效）恢复正常显示与访问', '加入保险箱');
                    if (!ok) return;
                    try {
                        const d = await req('/api/vault/add', {
                            method: 'POST', headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ paths: [absPath] }),
                        });
                        st.items = d.items || st.items;
                        toast('成功', '已加入保险箱：' + name + '（源文件保持不动）', 'success');
                        if (d.errors && d.errors.length) toast('提示', d.errors[0], 'danger');
                        if (typeof loadFiles === 'function' && typeof currentPath === 'string') loadFiles(currentPath);
                        const box = host();
                        if (box && box.classList.contains('show')) render();
                    } catch (e) { toast('错误', e.message, 'danger'); }
                };

                if (s.unlocked) return doAdd();
                askUnlock(doAdd);
            }
            window.fmAddToVault = addToVault;      // 供右键菜单（39_操作菜单）调用

            const btn = document.getElementById('vaultBtn');
            if (btn) btn.addEventListener('click', open);
        })();

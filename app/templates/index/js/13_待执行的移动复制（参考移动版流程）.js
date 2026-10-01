        // ========== 待执行的移动/复制（参考移动版流程） ==========
        function setPendingOp(mode, paths) {
            if (!paths || !paths.length) return;
            pendingOp = { mode, paths };
            document.getElementById('pasteFabText').textContent =
                (mode === 'move' ? '移动' : '复制') + ' ' + paths.length + ' 项到当前目录';
            document.getElementById('pasteFab').classList.add('show');
            showToast('提示', (mode === 'move' ? '移动' : '复制') + '已记录 ' + paths.length +
                ' 项，打开目标文件夹后点击右下角按钮完成（右键按钮可取消）', 'info');
        }

        async function executePendingOp() {
            if (!pendingOp) return;
            const isMove = pendingOp.mode === 'move';
            const paths = pendingOp.paths.slice();
            const dest = currentPath || '/';
            _clearPendingOp();
            const name = paths.length === 1 ? (paths[0].split('/').pop() || '') : (paths.length + ' 项');
            _bgStart(isMove ? 'mv' : 'cp', isMove ? '/api/move/start' : '/api/copy/start',
                { paths: paths, dest_dir: dest }, {
                title: (isMove ? '正在移动：' : '正在复制：') + name,
                legacy: () => _legacyMoveCopy(isMove, paths, dest),
                onDone: (ok, d) => {
                    const result = (d && d.result) || {};
                    const doneN = result.done != null ? result.done : paths.length;
                    if (ok) showToast('成功', (isMove ? '移动' : '复制') + '完成 ' + doneN + ' 项', 'success');
                    // 移动：源条目从当前目录消失；复制：目标出现在当前目录
                    if (isMove) localRemoveItems(paths);
                    else for (const p of paths) {
                        const base = p.split('/').pop();
                        localAddItem({ name: base, path: base, is_dir: false, size: 0, size_str: '', ext: '', type: '', mtime: _nowStr() });
                    }
                    loadFiles(currentPath);
                }
            });
        }

        // 后端未升级兜底：退回旧的逐文件同步接口
        async function _legacyMoveCopy(isMove, paths, dest) {
            let ok = 0, fail = 0, firstErr = '';
            for (const p of paths) {
                try {
                    const resp = await fetch(isMove ? '/api/move' : '/api/copy', {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ path: p, dest_dir: dest })
                    });
                    const d = await resp.json();
                    if (d.success || !d.error) ok++;
                    else { fail++; if (!firstErr) firstErr = d.error; }
                } catch (err) { fail++; if (!firstErr) firstErr = err.message; }
            }
            if (fail === 0) showToast('成功', (isMove ? '移动' : '复制') + '完成 ' + ok + ' 项', 'success');
            else showToast(ok ? '警告' : '错误',
                (isMove ? '移动' : '复制') + '完成 ' + ok + ' 项，失败 ' + fail + ' 项' + (firstErr ? '：' + firstErr : ''),
                ok ? 'warning' : 'danger');
            loadFiles(currentPath);
        }

        function _clearPendingOp() {
            pendingOp = null;
            document.getElementById('pasteFab').classList.remove('show');
        }

        // 切换某个复选框的勾选状态（复用 change 事件逻辑）
        function _toggleItemCheckbox(cb) {
            if (!cb) return;
            cb.checked = !cb.checked;
            cb.dispatchEvent(new Event('change', { bubbles: true }));
        }

        // 双击文件时，确保处于多选模式并勾选该文件
        function _selectItemByPath(absPath) {
            if (!selectMode) toggleSelectMode();
            const esc = (s) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
            const sel = '.item-checkbox[data-path=\'' + esc(absPath) + '\'], .tree-checkbox[data-path=\'' + esc(absPath) + '\']';
            const cb = document.querySelector(sel);
            if (cb && !cb.checked) {
                cb.checked = true;
                cb.dispatchEvent(new Event('change', { bubbles: true }));
            }
        }

        // ===== 编辑器状态：N 字符 · 大小 · 未修改/已修改 =====
        let _edModified = false;
        let _edDirtyTimer = null;
        function _editorText() {
            try { return _simpleMDE ? _simpleMDE.value() : (_editorInstance ? _editorInstance.getValue() : ''); }
            catch (e) { return ''; }
        }
        function _fmtEditorSize(bytes) {
            if (bytes < 1024) return bytes + ' B';
            if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
            return (bytes / 1024 / 1024).toFixed(2) + ' MB';
        }
        function _setEdStatus(mode) {
            const el = document.getElementById('edStatus');
            const dot = document.getElementById('edStatusDot');
            if (!el) return;
            const text = _editorText();
            const meta = text.length + ' 字符 · ' + _fmtEditorSize(new Blob([text]).size);
            const map = {
                unmodified: ['未修改', '🟢'],
                modified: ['已修改', '🔴'],
                saving: ['保存中...', '🟡'],
                saved: ['已保存 ✓', '🟢'],
                error: ['保存失败', '🔴'],
            };
            const [label, icon] = map[mode] || map.unmodified;
            el.textContent = meta + ' · ' + label;
            if (dot) dot.textContent = icon;
            // 保存按钮：仅已修改/保存失败时可点击
            const saveBtn = document.querySelector('.ed-save-btn');
            if (saveBtn && mode !== 'saving') saveBtn.disabled = !(mode === 'modified' || mode === 'error');
            // 内容变化时自动关闭对比视图（避免显示过期差异）
            if (mode === 'modified') {
                const dp = document.getElementById('edDiffPanel');
                if (dp && dp.style.display !== 'none') dp.style.display = 'none';
            }
        }
        function _edMarkDirty() {
            if (_edDirtyTimer) clearTimeout(_edDirtyTimer);
            _edDirtyTimer = setTimeout(() => {
                // 以「当前内容 vs 已保存基准」的实际对比结果为准：
                // 改动后又改回原样（如撤销、删掉刚输入的字符）→ 视为未修改
                const changed = _editorText() !== _editorOriginal;
                _edModified = changed;
                _setEdStatus(changed ? 'modified' : 'unmodified');
                _updateDiffBadge();   // 实时刷新对比按钮上的 +N/-N 数量
            }, 200);
        }

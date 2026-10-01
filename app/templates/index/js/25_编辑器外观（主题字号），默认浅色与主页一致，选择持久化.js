        // ===== 编辑器外观（主题/字号），默认浅色与主页一致，选择持久化 =====
        const _ED_THEMES = [
            { key: 'default', label: '默认（浅色 · 同主页）' },
            { key: 'eclipse', label: 'Eclipse（浅色）' },
            { key: 'idea', label: 'IDEA（浅色）' },
            { key: 'material-darker', label: 'Material 深色' },
            { key: 'dracula', label: 'Dracula' },
            { key: 'monokai', label: 'Monokai' },
        ];
        function _editorTheme() { return localStorage.getItem('edTheme') || 'default'; }
        function _editorFontSize() { return parseInt(localStorage.getItem('edFontSize') || '14', 10) || 14; }
        function _applyEditorAppearance() {
            if (!_editorInstance) return;
            try {
                _editorInstance.setOption('theme', _editorTheme());
                _editorInstance.getWrapperElement().style.fontSize = _editorFontSize() + 'px';
                _editorInstance.refresh();
            } catch (e) { }
        }

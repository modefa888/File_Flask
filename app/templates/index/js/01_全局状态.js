        // ========== 全局状态 ==========
        let currentPath = '';
        let parentPath = '';  // 上级目录绝对路径，用于 ".." 行导航
        let fileItems = [];
        let selectedPaths = new Set();
        let sortField = 'name';
        let sortAsc = true;
        let viewMode = localStorage.getItem('fileManager_viewMode') || 'list';
        let selectMode = localStorage.getItem('fileManager_selectMode') === 'true';
        const STORAGE_KEY = 'fileManager_lastPath';
        const STORAGE_VIEW_KEY = 'fileManager_viewMode';
        // 缩略图缓存：path -> dataURL
        const _thumbnailCache = {};
        let systemInfo = { home: '', root: '' };
        let pendingOp = null;  // 待执行的移动/复制: { mode: 'move'|'copy', paths: [...] }

        // 调试面板：在页面右下角显示初始化状态
        // debug panel removed

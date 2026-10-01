        // ========== 索引状态 ==========
        let _indexPollTimer = null;

        function bindIndexBadge() {
            const badge = document.getElementById('indexBadge');
            if (!badge) return;
            badge.addEventListener('click', () => {
                showIndexDetail();
            });
            // 先立即渲染一次徽标；仅当索引正在更新时才启动轮询，更新结束后自动关闭
            updateIndexBadge().then(status => {
                if (status === 'scanning') startIndexPolling();
            });
        }

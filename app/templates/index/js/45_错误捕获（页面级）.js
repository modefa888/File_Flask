        // ========== 错误捕获（页面级） ==========
        window.addEventListener('error', (e) => {
            const errDiv = document.createElement('div');
            errDiv.style.cssText = 'position:fixed;top:0;left:0;right:0;background:#dc2626;color:white;padding:8px 16px;font-size:0.85rem;z-index:99999;text-align:center;';
            errDiv.textContent = 'JS 错误: ' + (e.message || '未知错误') + ' (' + (e.filename || '') + ':' + (e.lineno || '') + ')';
            document.body.appendChild(errDiv);
            console.error('JS Error:', e.message, e.filename + ':' + e.lineno);
        });

        function initLiveClock() {
            const dateEl = document.getElementById('liveClockDate');
            const timeEl = document.getElementById('liveClockTime');
            if (!dateEl || !timeEl) return;
            function tick() {
                const now = new Date();
                const pad = (n) => String(n).padStart(2, '0');
                dateEl.textContent = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
                timeEl.textContent = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
            }
            tick();
            setInterval(tick, 1000);
        }

        // 立即执行初始化（不依赖 window.onload，也不等 Bootstrap）
        try {
            initEvents();
        } catch (e) {
            console.error('[initEvents]', e);
        }
        try {
            initApp();
        } catch (e) {
            console.error('[initApp]', e);
        }
        try {
            initLiveClock();
        } catch (e) {
            console.error('[initLiveClock]', e);
        }

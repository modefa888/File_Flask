/* 后台管理：侧栏导航构建与初始化。 */
(function () {
    var nav = document.getElementById('admNav');
    ADM.modules.forEach(function (m) {
        var el = document.createElement('div');
        el.className = 'adm-nav-item';
        el.dataset.id = m.id;
        el.innerHTML = '<i class="bi ' + m.icon + '"></i><span>' + ADM.esc(m.name) + '</span>';
        el.addEventListener('click', function () {
            ADM.render(m.id);
            document.querySelector('.adm-shell').classList.remove('mobile-open');
        });
        nav.appendChild(el);
    });

    document.getElementById('admRefresh').addEventListener('click', function () {
        ADM.reload();
    });

    var menuBtn = document.getElementById('admMenuBtn');
    if (menuBtn) menuBtn.addEventListener('click', function () {
        var shell = document.querySelector('.adm-shell');
        if (window.innerWidth <= 900) {
            shell.classList.toggle('mobile-open');
        } else {
            shell.classList.toggle('collapsed');
        }
    });

    /* 主题切换：浅色 / 深色，选择持久化在 localStorage */
    var themeBtn = document.getElementById('admTheme');
    function currentTheme() {
        return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
    }
    function applyTheme(mode) {
        var light = (mode === 'light');
        if (light) {
            document.documentElement.setAttribute('data-theme', 'light');
        } else {
            document.documentElement.removeAttribute('data-theme');
        }
        var icon = themeBtn ? themeBtn.querySelector('i') : null;
        var text = document.getElementById('admThemeText');
        if (icon) icon.className = 'bi ' + (light ? 'bi-moon-stars' : 'bi-sun');
        if (text) text.textContent = light ? '深色' : '浅色';
        try { localStorage.setItem('adm_theme', mode); } catch (e) { }
    }
    if (themeBtn) themeBtn.addEventListener('click', function () {
        applyTheme(currentTheme() === 'light' ? 'dark' : 'light');
    });
    applyTheme(currentTheme());

    /* 窗口尺寸变化后重新适配表格高度（宽度变化会影响列宽 / 横向滚动条） */
    var resizeTimer = null;
    window.addEventListener('resize', function () {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(function () { ADM.refitTables(document); }, 120);
    });

    /* 初始模块优先级：#hash 直达 > 上次打开的模块（localStorage，刷新自动恢复） > 概览 */
    var initial = (location.hash || '').replace('#', '');
    if (!ADM.modules.some(function (m) { return m.id === initial; })) {
        try { initial = localStorage.getItem('adm_module') || ''; } catch (e) { initial = ''; }
    }
    var exists = ADM.modules.some(function (m) { return m.id === initial; });
    ADM.render(exists ? initial : 'overview');
})();

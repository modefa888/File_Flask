/* 后台管理：侧栏导航构建与初始化。 */
(function () {
    var nav = document.getElementById('admNav');
    ADM.modules.forEach(function (m) {
        var el = document.createElement('div');
        el.className = 'adm-nav-item';
        el.dataset.id = m.id;
        el.innerHTML = '<i class="bi ' + m.icon + '"></i><span>' + ADM.esc(m.name) + '</span>';
        el.title = m.name;              // 收起后只剩图标，靠悬浮提示识别
        el.addEventListener('click', function () {
            ADM.render(m.id);
            document.querySelector('.adm-shell').classList.remove('mobile-open');
        });
        nav.appendChild(el);
    });

    document.getElementById('admRefresh').addEventListener('click', function () {
        ADM.reload();
    });

    /* ---------------- 侧栏收起 / 展开 ----------------
     * 桌面端：点侧栏内的切换按钮把侧栏收成图标条，状态记忆在 localStorage；
     * 窄屏：改用顶部汉堡按钮唤出抽屉，折叠态在窄屏不生效。
     * 折叠标记挂在 <html> 上（同主题），可在首屏脚本里提前恢复、避免刷新时闪一下。 */
    var shell = document.querySelector('.adm-shell');
    var sideToggle = document.getElementById('admSideToggle');
    var root = document.documentElement;
    var SIDE_KEY = 'adm_side_collapsed';

    function isWide() { return window.innerWidth > 900; }
    function isCollapsed() { return root.classList.contains('adm-side-collapsed'); }
    function sidePref() {
        try { return localStorage.getItem(SIDE_KEY) === '1'; } catch (e) { return false; }
    }
    function paintSideToggle(collapsed) {
        if (!sideToggle) return;
        var ic = sideToggle.querySelector('i');
        if (ic) ic.className = 'bi ' + (collapsed ? 'bi-chevron-bar-right' : 'bi-chevron-bar-left');
        sideToggle.title = collapsed ? '展开侧栏' : '收起侧栏';
    }
    /* force 省略时按「上次状态 + 当前宽度」计算 */
    function applyCollapsed(force) {
        var on = (force === undefined ? sidePref() : !!force) && isWide();
        root.classList.toggle('adm-side-collapsed', on);
        paintSideToggle(on);
        return on;
    }
    /* 侧栏宽度变化会改变内容区可用宽度：清掉已冻结的列宽并重新测量，
     * 否则展开后表格可能残留横向滚动条、收起后右侧出现无谓空白。
     * 侧栏宽度是瞬时切换的（CSS 里没有 width 过渡，避免主区连续重排导致抖动），
     * 所以下一轮任务里重新测量即可，不需要等过渡结束。 */
    function refitAfterSideChange() {
        try {
            Object.keys(ADM._tables || {}).forEach(function (k) {
                if (ADM._tables[k]) ADM._tables[k].colW = null;
            });
            var serv = ADM._servTables || {};
            document.querySelectorAll('[data-adm-serv]').forEach(function (host) {
                var st = serv[host.dataset.admServ];
                if (!st || !host.querySelector('table')) return;   // 未渲染 / 隐藏：跳过
                st.colW = null;
                ADM._freezeCols(host, st);
                ADM._fitTable(host, st);
            });
            ADM.refitTables(document);
        } catch (e) { /* 重排失败不影响主流程 */ }
    }
    function setCollapsed(on) {
        var was = isCollapsed();
        var now = applyCollapsed(on);
        try { localStorage.setItem(SIDE_KEY, on ? '1' : '0'); } catch (e) { }
        if (now !== was) setTimeout(refitAfterSideChange, 0);
    }
    if (sideToggle) sideToggle.addEventListener('click', function () {
        setCollapsed(!isCollapsed());
    });

    var menuBtn = document.getElementById('admMenuBtn');
    if (menuBtn) menuBtn.addEventListener('click', function () {
        if (isWide()) setCollapsed(!isCollapsed());
        else shell.classList.toggle('mobile-open');
    });

    /* 首屏状态已由 <head> 脚本恢复；这里把按钮图标对齐到当前状态（窄屏会自动取消折叠） */
    paintSideToggle(applyCollapsed());

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
        applyCollapsed();                       // 跨过 900px 断点时同步折叠态
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(function () { ADM.refitTables(document); }, 120);
    });

    /* 侧栏底部「设置」：默认收起，点一下在按钮上方弹出 桌面端 / IDE / 退出登录 */
    var footMore = document.getElementById('admFootMore');
    var footPop = document.getElementById('admFootPop');
    if (footMore && footPop) {
        function setFootPop(open) {
            footPop.hidden = !open;
            footMore.setAttribute('aria-expanded', open ? 'true' : 'false');
        }
        footMore.addEventListener('click', function (e) {
            e.stopPropagation();
            setFootPop(footPop.hidden);      // 展开 <-> 收起
        });
        document.addEventListener('click', function (e) {
            if (footPop.hidden) return;
            if (!footPop.contains(e.target) && !footMore.contains(e.target)) setFootPop(false);
        });
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && !footPop.hidden) setFootPop(false);
        });
    }

    /* 初始模块优先级：#hash 直达 > 上次打开的模块（localStorage，刷新自动恢复） > 概览 */
    var initial = (location.hash || '').replace('#', '');
    if (!ADM.modules.some(function (m) { return m.id === initial; })) {
        try { initial = localStorage.getItem('adm_module') || ''; } catch (e) { initial = ''; }
    }
    var exists = ADM.modules.some(function (m) { return m.id === initial; });
    ADM.render(exists ? initial : 'overview');
})();

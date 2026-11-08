/* 首页顶栏账户按钮：用户图标 → 下方菜单（注销）→ 贴按钮的二次确认悬浮框。
   原生实现，不依赖 Bootstrap JS（首页只引了 bootstrap.min.css）。 */
(function () {
    const wrap = document.getElementById('userMenuWrap');
    const btn = document.getElementById('userMenuBtn');
    const menu = document.getElementById('userMenuPop');
    const confirmPop = document.getElementById('userConfirmPop');
    const logoutBtn = document.getElementById('userLogoutBtn');
    if (!wrap || !btn || !menu || !confirmPop || !logoutBtn) return;

    function closeAll() {
        menu.hidden = true;
        confirmPop.hidden = true;
        btn.setAttribute('aria-expanded', 'false');
        wrap.classList.remove('open');
    }
    function show(which) {
        closeAll();
        which.hidden = false;
        wrap.classList.add('open');
        btn.setAttribute('aria-expanded', which === menu ? 'true' : 'false');
    }

    btn.addEventListener('click', function (e) {
        e.stopPropagation();
        if (menu.hidden) show(menu);
        else closeAll();
    });
    logoutBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        show(confirmPop);
    });
    confirmPop.addEventListener('click', function (e) {
        e.stopPropagation();
        const b = e.target.closest('[data-ucp]');
        if (!b) return;
        if (b.dataset.ucp === 'ok') { location.href = '/logout'; return; }
        closeAll();
    });
    document.addEventListener('click', function (e) {
        if (!wrap.contains(e.target)) closeAll();
    });
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') closeAll();
    });
    window.addEventListener('resize', closeAll);
})();

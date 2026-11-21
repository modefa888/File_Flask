  // ---------- 🧰 代理与下载（独立移动版页面 /mtools） ----------
  // 注意：39_ 文件末尾的 })(); 已关闭主 IIFE，这里拿不到 toggleMoreMenu，
  // 直接操作菜单 DOM 收起后跳转，避免依赖闭包内变量。
  (function () {
    var btn = document.getElementById("mmToolsBtn");
    if (!btn) return;
    btn.addEventListener("click", function () {
      var menu = document.getElementById("moreMenu");
      if (menu) menu.classList.remove("show");
      var mask = document.getElementById("addMenuMask");
      if (mask) mask.classList.remove("show");
      location.href = "/mtools";
    });
  })();

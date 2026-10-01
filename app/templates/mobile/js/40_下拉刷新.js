  // ---------- 下拉刷新：列表顶部下拉重新加载当前目录（顶栏下方小转圈，无遮罩） ----------
  (function () {
    var list = document.getElementById("list");
    var ptr = document.getElementById("ptr");
    if (!list || !ptr) return;

    var START_DY = 10;   // 触发下拉判定的最小纵向位移（px）
    var TRIGGER = 20;    // 指示器位移达到该值即「释放刷新」
    var MAXDIST = 24;    // 指示器最大位移（阻尼上限）
    var RESIST = 0.4;    // 阻尼系数：指示器移动量 = 手指位移 × RESIST
    var HIDDEN_Y = -36;  // 默认藏进顶栏后方的位移（CSS 默认值一致）

    var startY = 0, startX = 0;
    var armed = false;       // 本次触摸有资格触发下拉（起手时页面在顶部）
    var pulling = false;     // 已进入下拉手势
    var refreshing = false;
    var suppressClickUntil = 0;

    function setMove(dist) {
      ptr.classList.add("pull");
      ptr.classList.remove("spin");
      ptr.style.transform = "translateY(" + (dist + HIDDEN_Y) + "px)";
      // 列表整体下推，给转圈腾出位置，不遮挡第一个条目
      list.style.transition = "none";          // 跟随手指，无过渡
      list.style.paddingTop = (8 + dist) + "px";
    }

    function reset() {
      ptr.classList.remove("pull", "spin");
      ptr.style.transform = "";
      // 列表带回弹动画收回
      list.style.transition = "padding-top .25s ease";
      list.style.paddingTop = "";
      setTimeout(function () { list.style.transition = ""; }, 300);
    }

    list.addEventListener("touchstart", function (e) {
      if (refreshing) { armed = false; return; }
      armed = window.scrollY <= 2;
      if (!armed) return;
      var t = e.touches[0];
      startX = t.clientX; startY = t.clientY;
      pulling = false;
    }, { passive: true });

    list.addEventListener("touchmove", function (e) {
      if (!armed || refreshing) return;
      var t = e.touches[0];
      var dy = t.clientY - startY, dx = t.clientX - startX;
      if (!pulling) {
        if (dy < START_DY || Math.abs(dx) > Math.abs(dy)) return;   // 非纵向下拉不接管
        if (window.scrollY > 2) { armed = false; return; }          // 起手后页面已滚动则放弃
        pulling = true;
      }
      setMove(Math.min(dy * RESIST, MAXDIST));
      e.preventDefault();   // 顶部下拉时接管手势，避免整页橡皮筋干扰
    }, { passive: false });

    list.addEventListener("touchend", function () {
      if (!pulling || refreshing) { armed = false; pulling = false; return; }
      var ready = ptr.style.transform !== "" &&
        parseFloat(ptr.style.transform.replace(/[^-\d.]/g, "")) >= HIDDEN_Y + TRIGGER;
      armed = false; pulling = false;
      suppressClickUntil = Date.now() + 400;   // 下拉手势不算点击，避免误开文件
      if (!ready) { reset(); return; }
      refreshing = true;
      ptr.classList.add("pull", "spin");
      ptr.style.transform = "translateY(" + (HIDDEN_Y + TRIGGER + 6) + "px)";
      list.style.paddingTop = (8 + TRIGGER + 6) + "px";   // 刷新期间保持下推（转圈完全落在空档内）
      Promise.resolve(load(state.path, true, { silent: true })).catch(function () {}).then(function () {
        refreshing = false;
        reset();
      });
    });

    // 下拉后的释放不触发列表项 click（捕获阶段拦截）
    list.addEventListener("click", function (e) {
      if (Date.now() < suppressClickUntil) { e.stopPropagation(); e.preventDefault(); }
    }, true);
  })();

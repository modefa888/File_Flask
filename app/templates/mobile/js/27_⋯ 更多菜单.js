  // ---------- ⋯ 更多菜单 ----------
  var moreMenu = document.getElementById("moreMenu");
  function toggleMoreMenu(on) {
    moreMenu.classList.toggle("show", on);
    addMenuMask.classList.toggle("show", on);
  }
  function applyView() {
    // 直接切换容器类即可，无需重新拉取列表
    document.getElementById("list").className = "list body-pad " + (state.view === "grid" ? "grid" : "rows");
    var sr = document.getElementById("spResults");
    if (sr) sr.className = "list " + (state.view === "grid" ? "grid" : "rows");
  }
  function updateViewBtn() {
    document.getElementById("mmViewBtn").textContent =
      state.view === "grid" ? "☰ 切换为列表视图" : "▦ 切换为图标视图";
  }
  function updateHiddenBtn() {
    document.getElementById("mmHiddenBtn").textContent =
      state.showHidden ? "🙈 隐藏隐藏文件" : "👁️ 显示隐藏文件";
  }
  document.getElementById("moreBtn").addEventListener("click", function () {
    toggleAddMenu(false);
    updateViewBtn();
    updateHiddenBtn();
    var dis = !!state.selMode;   // 选择模式下排序/视图不可用
    document.getElementById("mmSortBtn").disabled = dis;
    document.getElementById("mmViewBtn").disabled = dis;
    toggleMoreMenu(!moreMenu.classList.contains("show"));
  });
  document.getElementById("mmSortBtn").addEventListener("click", function () {
    toggleMoreMenu(false); openSortSheet();
  });
  document.getElementById("mmViewBtn").addEventListener("click", function () {
    state.view = state.view === "grid" ? "list" : "grid";
    spLsSet(VIEW_KEY, state.view);
    updateViewBtn();
    applyView();
  });
  // 显示/隐藏 以点开头的文件（.gitignore、.env 等）：切换后重载当前目录
  document.getElementById("mmHiddenBtn").addEventListener("click", function () {
    state.showHidden = !state.showHidden;
    spLsSet(HIDDEN_KEY, state.showHidden);
    updateHiddenBtn();
    toggleMoreMenu(false);
    load(state.path);            // _loadingPath 已在 finally 复位，可安全重载同目录
  });

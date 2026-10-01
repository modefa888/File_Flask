  // ---------- ➕ 新建下拉菜单 ----------
  var addMenu = document.getElementById("addMenu");
  var addMenuMask = document.getElementById("addMenuMask");
  function toggleAddMenu(on) {
    if (on) updateFavLabel();
    addMenu.classList.toggle("show", on);
    addMenuMask.classList.toggle("show", on);
  }
  document.getElementById("newFolderBtn").addEventListener("click", function () {
    toggleMoreMenu(false);
    toggleAddMenu(!addMenu.classList.contains("show"));
  });
  addMenuMask.addEventListener("click", function () { toggleAddMenu(false); toggleMoreMenu(false); });
  document.getElementById("addFolderBtn").addEventListener("click", function () {
    toggleAddMenu(false); doNewFolder();
  });
  document.getElementById("addFileBtn").addEventListener("click", function () {
    toggleAddMenu(false); doNewFile();
  });

  // ---------- 多选模式 ----------
  function bindLongPress(el, fn) {
    var t = null;
    el.addEventListener("touchstart", function () {
      t = setTimeout(function () { t = null; lpFired = true; fn(); }, 500);
    }, { passive: true });
    ["touchmove", "touchend"].forEach(function (ev) {
      el.addEventListener(ev, function () { if (t) { clearTimeout(t); t = null; } }, { passive: true });
    });
    el.addEventListener("contextmenu", function (e) { e.preventDefault(); fn(); });
  }
  function enterSelMode() {
    if (state.selMode) return;
    state.selMode = true;
    state.selSet = {};
    document.getElementById("selBar").classList.add("show");
    document.getElementById("searchBtn").disabled = true;
    document.getElementById("newFolderBtn").disabled = true;
    renderList(); updateSelTitle();
  }
  function exitSelMode() {
    if (!state.selMode) return;
    state.selMode = false;
    state.selSet = {};
    document.getElementById("selBar").classList.remove("show");
    document.getElementById("searchBtn").disabled = false;
    document.getElementById("newFolderBtn").disabled = false;
    renderList(); updateSelTitle();
  }
  function toggleSel(abs) {
    if (state.selSet[abs]) delete state.selSet[abs];
    else state.selSet[abs] = true;
    // 只更新当前卡片的勾选状态，不重建列表，避免缩略图重新请求/闪烁
    var row = document.querySelector('#list [data-abs="' + abs.replace(/"/g, '\\"') + '"]');
    if (row) {
      var chk = row.querySelector(".sel-check");
      if (chk) chk.classList.toggle("on", !!state.selSet[abs]);
      row.classList.toggle("sel-on", !!state.selSet[abs]);
    }
    updateSelTitle();
  }
  function selCount() { return Object.keys(state.selSet).length; }
  function selPaths() { return Object.keys(state.selSet); }
  function updateSelTitle() {
    var el = document.getElementById("appTitle");
    if (state.selMode) { el.textContent = "已选 " + selCount() + " 项"; return; }
    el.textContent = (state.path === "/" || !state.path) ? "根目录" : state.path.split("/").filter(Boolean).pop();
  }
  document.getElementById("selAllBtn").addEventListener("click", function () {
    var all = selCount() === state.items.length;
    state.selSet = {};
    if (!all) state.items.forEach(function (it) { state.selSet[itemAbs(it)] = true; });
    // 仅更新各卡片勾选状态，不重建列表，避免缩略图重请求/闪烁
    document.querySelectorAll("#list .item").forEach(function (row) {
      var on = !!state.selSet[row.getAttribute("data-abs")];
      var chk = row.querySelector(".sel-check");
      if (chk) chk.classList.toggle("on", on);
      row.classList.toggle("sel-on", on);
    });
    updateSelTitle();
  });
  document.getElementById("selCancelBtn").addEventListener("click", exitSelMode);
  document.getElementById("selMoveBtn").addEventListener("click", function () {
    var paths = selPaths();
    if (!paths.length) { toast("请先选择条目", "warn"); return; }
    setPendingOp("move", paths); exitSelMode();
  });
  document.getElementById("selCopyBtn").addEventListener("click", function () {
    var paths = selPaths();
    if (!paths.length) { toast("请先选择条目", "warn"); return; }
    setPendingOp("copy", paths); exitSelMode();
  });
  document.getElementById("selDelBtn").addEventListener("click", function () {
    var paths = selPaths();
    if (!paths.length) { toast("请先选择条目", "warn"); return; }
    confirmBox({
      title: "删除确认",
      message: "确定删除选中的 " + paths.length + " 项吗？此操作不可恢复！",
      okText: "删除", danger: true,
      onOk: function () { batchDelete(paths); }
    });
  });
  function batchDelete(paths) {
    // 一次请求交给后台任务，弹窗内实时显示删除进度
    startDelete(paths, function () { exitSelMode(); localRemoveItems(paths); });
  }
  document.getElementById("selZipBtn").addEventListener("click", function () {
    var paths = selPaths();
    if (!paths.length) { toast("请先选择条目", "warn"); return; }
    // 单个条目：用条目名作默认压缩包名前缀；多选：用日期式名称（精确到秒）
    var d = new Date();
    var ts = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0")
      + "_" + String(d.getHours()).padStart(2, "0") + String(d.getMinutes()).padStart(2, "0") + String(d.getSeconds()).padStart(2, "0");
    var defName = paths.length === 1
      ? (paths[0].split("/").filter(Boolean).pop() || "压缩包") + "_" + ts
      : "压缩包_" + ts;
    showDialog("压缩为 ZIP（存于当前目录）", defName, function (name) {
      name = (name || "").trim();
      if (!name) { toast("请输入压缩包名称", "warn"); return; }
      // 走后台任务进度（同解压），可挂后台胶囊显示挂载状态
      bgStart("zip", "/api/zip/create/start", { paths: paths, dest_dir: state.path || "/", name: name }, {
        title: "正在压缩…",
        label: "压缩",
        onDone: function (ok, dd) {
          if (ok && dd && dd.result) {
            toast("已生成 " + dd.result.name + (dd.result.size_str ? "（" + dd.result.size_str + "）" : ""), "success");
          }
          exitSelMode();
          // 本地插入新 zip 条目，不重新请求 /api/files（大目录会超时）
          if (ok && dd && dd.result) {
            localAddItem({ name: dd.result.name, path: dd.result.name, abs_path: dd.result.path,
              is_dir: false, size: dd.result.size || 0,
              size_str: dd.result.size_str || fmtDelBytes(dd.result.size || 0),
              ext: "zip", type: "ZIP", mtime: nowStrLocal() });
          }
        },
        legacy: function () { legacyZipCreate(paths, state.path || "/", name); exitSelMode(); }
      });
    });
  });

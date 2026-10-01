  // ---------- 本地增量更新列表（删除/压缩/解压完成后不重新请求 /api/files，避免大目录超时） ----------
  function nowStrLocal() {
    var d = new Date();
    function p2(n) { return String(n).padStart(2, "0"); }
    return d.getFullYear() + "-" + p2(d.getMonth() + 1) + "-" + p2(d.getDate()) + " " +
      p2(d.getHours()) + ":" + p2(d.getMinutes()) + ":" + p2(d.getSeconds());
  }
  function updateStatsLocal() {
    var dirs = 0, files = 0, total = 0;
    (state.items || []).forEach(function (it) {
      if (it.is_dir) dirs++;
      else files++;
      if (it.size >= 0) total += (it.size || 0);
    });
    renderStats({ total_dirs: dirs, total_files: files, total_size: total, total_size_str: fmtDelBytes(total) });
  }
  function localRemoveItems(paths) {
    if (!state.items || !state.items.length) return false;
    var names = {};
    (paths || []).forEach(function (p) {
      var n = String(p).split("/").filter(Boolean).pop();
      if (n) names[n] = true;
    });
    var before = state.items.length;
    state.items = state.items.filter(function (it) { return !names[it.name]; });
    if (state.items.length === before) return false;
    renderList();
    updateStatsLocal();
    return true;
  }
  function localAddItem(item) {
    if (!state.items) state.items = [];
    for (var i = 0; i < state.items.length; i++) {
      if (state.items[i].name === item.name) return false;
    }
    state.items.push(item);
    renderList();
    updateStatsLocal();
    return true;
  }

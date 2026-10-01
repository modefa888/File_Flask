  // ---------- 排序 ----------
  var SORT_DEFS = [
    { mode: "name", ico: "🔤", label: "按名称" },
    { mode: "type", ico: "🗂️", label: "按类型" },
    { mode: "size", ico: "📦", label: "按大小" },
    { mode: "time", ico: "🕐", label: "按时间" }
  ];
  function cmpName(a, b) {
    return String(a.name).localeCompare(String(b.name), "zh-Hans-CN");
  }
  function sortItems(src) {
    var m = state.sort.mode, d = state.sort.dir;
    return src.slice().sort(function (a, b) {
      if (!!a.is_dir !== !!b.is_dir) return a.is_dir ? -1 : 1;   // 文件夹始终在前
      var r = 0;
      if (m === "name") r = cmpName(a, b);
      else if (m === "type") {
        r = String(a.ext || "").localeCompare(String(b.ext || ""), "zh-Hans-CN");
        if (!r) r = String(a.type || "").localeCompare(String(b.type || ""), "zh-Hans-CN");
      }
      else if (m === "size") r = (Number(a.size) || 0) - (Number(b.size) || 0);
      else if (m === "time") r = String(a.mtime || "").localeCompare(String(b.mtime || ""));
      if (!r) r = cmpName(a, b);
      return r * d;
    });
  }
  function openSortSheet() {
    var head = document.getElementById("sheetHead");
    var btns = document.getElementById("sheetBtns");
    head.textContent = "排序方式";
    btns.innerHTML = "";
    SORT_DEFS.forEach(function (def) {
      var active = state.sort.mode === def.mode;
      var arrow = active ? (state.sort.dir === 1 ? " ↑" : " ↓") : "";
      var b = document.createElement("button");
      b.className = "sheet-btn";
      b.innerHTML = '<span class="ico">' + (active ? "✅" : def.ico) + '</span><span>' +
        def.label + arrow + '</span>';
      b.addEventListener("click", function () {
        // 同一项再点 = 切换升降序；不同项 = 切换方式（大小/时间默认降序：大的/新的在前）
        if (state.sort.mode === def.mode) state.sort.dir = -state.sort.dir;
        else {
          state.sort.mode = def.mode;
          state.sort.dir = (def.mode === "size" || def.mode === "time") ? -1 : 1;
        }
        spLsSet(SORT_KEY, state.sort);
        renderList();
        openSortSheet();   // 刷新 ✓/箭头，弹层保持打开方便连续调整
      });
      btns.appendChild(b);
    });
    var tip = document.createElement("div");
    tip.className = "sheet-tip";
    tip.textContent = "点选项切换排序方式，再点一次切换升/降序（文件夹始终在前）";
    btns.appendChild(tip);
    document.getElementById("sheetMask").classList.add("show");
    document.getElementById("sheet").classList.add("show");
  }

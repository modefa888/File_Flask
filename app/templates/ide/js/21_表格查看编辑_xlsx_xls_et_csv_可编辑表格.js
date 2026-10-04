  /* ================================================================
   * 表格查看 / 编辑（xlsx / xlsm / xls / et / csv / tsv）
   * 在 openFile（00_preamble.js）中按扩展名调用 setupSheetView；
   * 数据由 /api/sheet/read 提供，保存经 saveSheetTab → /api/sheet/write，
   * 并接入 02_ 的 saveTab（Mod+S 保存当前 / 保存全部）。
   * xls / et（WPS 表格）为只读格式，仅支持查看。
   * ================================================================ */

  function _shEsc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  // 列序号 → 列名：0→A, 25→Z, 26→AA
  function _shColName(i) {
    let s = "";
    i += 1;
    while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); }
    return s;
  }

  function setupSheetView(tab, host, path, name) {
    // 注意：activate(tab) 由 00_preamble.js 的 openFile 调用（闭包内函数，这里访问不到）
    tab.isSheet = true;
    tab.sheetChanges = {};
    const st = tab.sheetState = { active: null, writable: false, isCsv: false, ext: "", data: [], cols: 0 };

    host.innerHTML =
      '<div class="sheetv">' +
        '<div class="sheetv-toolbar">' +
          '<span class="sheetv-name"><i class="bi bi-table"></i> ' + _shEsc(name) + '</span>' +
          '<select class="sheetv-sheets"></select>' +
          '<span class="sheetv-meta"></span>' +
          '<span class="sheetv-flex"></span>' +
          '<span class="sheetv-tip"></span>' +
          '<button class="g-btn sheetv-save">保存</button>' +
        '</div>' +
        '<div class="sheetv-grid"><div class="sheetv-empty">加载中…</div></div>' +
      '</div>';

    const sel = host.querySelector(".sheetv-sheets");
    const grid = host.querySelector(".sheetv-grid");
    const meta = host.querySelector(".sheetv-meta");
    const tip = host.querySelector(".sheetv-tip");
    const saveBtn = host.querySelector(".sheetv-save");

    function markDirty() {
      if (tab.dirty) return;
      tab.dirty = true;
      if (tab.el) tab.el.classList.add("dirty");
      refreshTreeDirty();
    }

    function renderGrid() {
      const data = st.data;
      const nCols = Math.max(st.cols || 0, 1);
      let html = '<table class="sheetv-table"><thead><tr><th class="sheetv-corner"></th>';
      for (let c = 0; c < nCols; c++) html += '<th class="sheetv-colhead">' + _shColName(c) + '</th>';
      html += '</tr></thead><tbody>';
      data.forEach((row, r) => {
        html += '<tr><td class="sheetv-rownum">' + (r + 1) + '</td>';
        for (let c = 0; c < nCols; c++) {
          const v = row[c] == null ? "" : row[c];
          html += '<td class="sheetv-cell" data-r="' + r + '" data-c="' + c + '"' +
            (st.writable ? ' contenteditable="true"' : '') + '>' + _shEsc(v) + '</td>';
        }
        html += '</tr>';
      });
      html += '</tbody></table>';
      grid.innerHTML = html;
      if (st.writable) {
        grid.querySelectorAll(".sheetv-cell").forEach(td => {
          td.addEventListener("input", () => {
            tab.sheetChanges[td.dataset.r + "," + td.dataset.c] = td.textContent;
            markDirty();
          });
        });
      }
    }

    function load(sheetName) {
      grid.innerHTML = '<div class="sheetv-empty">加载中…</div>';
      const url = "/api/sheet/read?path=" + encodeURIComponent(path) +
        (sheetName ? "&sheet=" + encodeURIComponent(sheetName) : "");
      fetch(url).then(r => r.json()).then(d => {
        if (!d.ok) { grid.innerHTML = '<div class="sheetv-err">' + _shEsc(d.error || "读取失败") + '</div>'; return; }
        st.active = d.active;
        st.writable = !!d.writable;
        st.isCsv = !!d.is_csv;
        st.ext = d.ext;
        st.data = d.data || [];
        st.cols = d.cols || 0;
        const sheets = d.sheets || [];
        sel.innerHTML = sheets.map(s => '<option' + (s === d.active ? " selected" : "") + '>' + _shEsc(s) + '</option>').join("");
        sel.style.display = sheets.length > 1 ? "" : "none";
        saveBtn.disabled = !st.writable;
        saveBtn.textContent = st.writable ? "保存" : "只读";
        meta.textContent = st.data.length + " 行 × " + st.cols + " 列" + (d.truncated ? "（超出上限已截断）" : "");
        tip.textContent = st.writable ? "双击单元格编辑" : ("." + st.ext + " 为只读格式，另存为 .xlsx 后可编辑");
        tab.sheetChanges = {};
        tab.dirty = false;
        if (tab.el) tab.el.classList.remove("dirty");
        renderGrid();
      }).catch(e => {
        grid.innerHTML = '<div class="sheetv-err">加载失败：' + _shEsc(e.message || e) + '</div>';
      });
    }

    sel.addEventListener("change", async () => {
      if (tab.dirty && !(await uiConfirm("切换工作表", "将丢弃当前未保存的修改，确定继续？", "继续", true))) {
        sel.value = st.active;
        return;
      }
      load(sel.value);
    });
    saveBtn.addEventListener("click", () => saveSheetTab(tab));

    load(null);
  }

  // 保存表格：把编辑过的单元格作为补丁提交（csv/tsv 由后端按补丁回写）
  async function saveSheetTab(tab) {
    if (!tab || !tab.isSheet) return;
    const st = tab.sheetState;
    if (!st || !st.writable) { toast("该格式为只读，无法保存（请另存为 .xlsx）", "warn"); return; }
    const changes = [];
    for (const k in tab.sheetChanges) {
      const p = k.split(",");
      changes.push([parseInt(p[0], 10), parseInt(p[1], 10), tab.sheetChanges[k]]);
    }
    if (!changes.length && !tab.dirty) { toast("没有改动", "warn"); return; }
    try {
      toast("正在保存 " + tab.name + " …", "info");
      const r = await fetch("/api/sheet/write", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: tab.path, sheet: st.active, changes: changes }),
      });
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      tab.sheetChanges = {};
      tab.dirty = false;
      if (tab.el) tab.el.classList.remove("dirty");
      refreshTreeDirty();
      toast("已保存：" + tab.name, "ok");
    } catch (e) {
      toast("保存失败：" + (e.message || e), "err");
    }
  }

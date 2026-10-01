  /* ================================================================
   * SQLite 数据库查看器（db / sqlite / sqlite3 / db3，只读）
   * 左侧表/视图列表，右侧分页数据表；数据由 /api/sqlite/tables、/api/sqlite/rows 提供
   * ================================================================ */

  function _sqliteEsc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function _sqliteFmtRows(n) {
    if (n == null) return "?";
    return n.toLocaleString();
  }

  function setupSqliteView(tab, host, path, name) {
    // 注意：activate(tab) 由 00_preamble.js 的 openFile 调用（闭包内函数，这里访问不到）
    tab.isDb = true;
    host.innerHTML =
      '<div class="dbv">' +
        '<div class="dbv-side"><div class="dbv-title"><i class="bi bi-database"></i> ' + _sqliteEsc(name) + '</div>' +
        '<div class="dbv-list"><div class="dbv-empty">正在读取表结构…</div></div></div>' +
        '<div class="dbv-main"><div class="dbv-toolbar"><span class="dbv-tname">—</span>' +
        '<span class="dbv-meta"></span><span class="dbv-flex"></span>' +
        '<button class="dbv-btn dbv-prev" title="上一页"><i class="bi bi-chevron-left"></i></button>' +
        '<span class="dbv-page">0 / 0</span>' +
        '<button class="dbv-btn dbv-next" title="下一页"><i class="bi bi-chevron-right"></i></button>' +
        '<select class="dbv-size" title="每页行数"><option>50</option><option selected>100</option><option>200</option><option>500</option></select>' +
        '</div><div class="dbv-grid"><div class="dbv-empty">选择左侧的表查看数据</div></div></div>' +
      '</div>';

    const sideList = host.querySelector(".dbv-list");
    const grid = host.querySelector(".dbv-grid");
    const tname = host.querySelector(".dbv-tname");
    const meta = host.querySelector(".dbv-meta");
    const pageEl = host.querySelector(".dbv-page");
    const prevBtn = host.querySelector(".dbv-prev");
    const nextBtn = host.querySelector(".dbv-next");
    const sizeSel = host.querySelector(".dbv-size");

    const state = { table: null, total: 0, offset: 0, limit: 100, seq: 0 };

    function renderRowsTable(d) {
      tname.textContent = d.table;
      meta.textContent = _sqliteFmtRows(d.total) + " 行";
      const cols = d.columns.length ? d.columns : d.rows.map((_, i) => "col" + (i + 1));
      let html = '<table class="dbv-table"><thead><tr>' +
        '<th class="dbv-rownum">#</th>' +
        cols.map(c => "<th>" + _sqliteEsc(c) + "</th>").join("") + "</tr></thead><tbody>";
      if (!d.rows.length) {
        html += '<tr><td class="dbv-nodata" colspan="' + (cols.length + 1) + '">空表（0 行）</td></tr>';
      }
      d.rows.forEach((row, ri) => {
        html += "<tr><td class=\"dbv-rownum\">" + (d.offset + ri + 1) + "</td>" +
          row.map(v => "<td>" + (v == null ? '<span class="dbv-null">NULL</span>' : _sqliteEsc(v)) + "</td>").join("") + "</tr>";
      });
      html += "</tbody></table>";
      grid.innerHTML = html;
      grid.scrollTop = 0;
      const page = Math.floor(d.offset / d.limit) + 1;
      const pages = Math.max(1, Math.ceil(d.total / d.limit));
      pageEl.textContent = page + " / " + pages;
      prevBtn.disabled = d.offset <= 0;
      nextBtn.disabled = d.offset + d.limit >= d.total;
    }

    function loadRows(offset) {
      const seq = ++state.seq;
      state.offset = offset;
      grid.innerHTML = '<div class="dbv-empty">加载中…</div>';
      fetch("/api/sqlite/rows?path=" + encodeURIComponent(path) +
            "&table=" + encodeURIComponent(state.table) +
            "&limit=" + state.limit + "&offset=" + offset)
        .then(r => r.json())
        .then(d => {
          if (seq !== state.seq) return;          // 已切到其它表/页，丢弃旧结果
          if (d.error) { grid.innerHTML = '<div class="dbv-err">' + _sqliteEsc(d.error) + "</div>"; return; }
          renderRowsTable(d);
        })
        .catch(e => {
          if (seq !== state.seq) return;
          grid.innerHTML = '<div class="dbv-err">加载失败：' + _sqliteEsc(e.message || e) + "</div>";
        });
    }

    function selectTable(item) {
      sideList.querySelectorAll(".dbv-item").forEach(el => el.classList.toggle("active", el === item));
      state.table = item.dataset.table;
      state.total = parseInt(item.dataset.rows || "0", 10) || 0;
      loadRows(0);
    }

    prevBtn.addEventListener("click", () => loadRows(Math.max(0, state.offset - state.limit)));
    nextBtn.addEventListener("click", () => loadRows(state.offset + state.limit));
    sizeSel.addEventListener("change", () => {
      state.limit = parseInt(sizeSel.value, 10) || 100;
      loadRows(0);
    });

    fetch("/api/sqlite/tables?path=" + encodeURIComponent(path))
      .then(r => r.json())
      .then(d => {
        if (d.error) { sideList.innerHTML = '<div class="dbv-err">' + _sqliteEsc(d.error) + "</div>"; return; }
        const tables = d.tables || [];
        if (!tables.length) {
          sideList.innerHTML = '<div class="dbv-empty">空数据库（没有用户表）</div>';
          return;
        }
        sideList.innerHTML = tables.map(t =>
          '<div class="dbv-item" data-table="' + _sqliteEsc(t.name) + '" data-rows="' + (t.rows == null ? "" : t.rows) + '">' +
          '<i class="bi ' + (t.kind === "view" ? "bi-eye" : "bi-table") + '"></i>' +
          '<span class="dbv-iname">' + _sqliteEsc(t.name) + "</span>" +
          '<span class="dbv-icount">' + _sqliteFmtRows(t.rows) + "</span></div>").join("");
        sideList.querySelectorAll(".dbv-item").forEach(el =>
          el.addEventListener("click", () => selectTable(el)));
        selectTable(sideList.querySelector(".dbv-item"));   // 默认打开第一个表
      })
      .catch(e => { sideList.innerHTML = '<div class="dbv-err">读取失败：' + _sqliteEsc(e.message || e) + "</div>"; });
  }

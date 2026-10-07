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
        '<button class="dbv-btn dbv-sql-toggle" title="SQL 查询（只读）"><i class="bi bi-terminal"></i> SQL</button>' +
        '</div>' +
        '<div class="dbv-sql" hidden>' +
          '<div class="dbv-sql-head">' +
            '<span class="dbv-sql-title"><i class="bi bi-terminal"></i>SQL 查询</span>' +
            '<span class="dbv-sql-hint">只读 · Ctrl+Enter 运行 · 拖动标题可移动</span>' +
            '<span class="dbv-flex"></span>' +
            '<button class="dbv-btn dbv-sql-max" title="全屏"><i class="bi bi-fullscreen"></i></button>' +
            '<button class="dbv-btn dbv-sql-close" title="收起"><i class="bi bi-x-lg"></i></button>' +
          '</div>' +
          '<div class="dbv-sql-ai">' +
            '<input class="dbv-sql-ai-input" type="text" spellcheck="false" placeholder="✨ 用一句话描述要查什么，回车即生成 SQL">' +
            '<button class="dbv-btn dbv-sql-ai-run" title="生成 SQL（回车）"><i class="bi bi-stars"></i></button>' +
          '</div>' +
          '<textarea class="dbv-sql-input" spellcheck="false" placeholder="SELECT * FROM ai_active LIMIT 100;"></textarea>' +
          '<div class="dbv-sql-bar">' +
            '<span class="dbv-sql-msg"></span>' +
            '<button class="dbv-btn dbv-sql-clear">清空</button>' +
            '<button class="dbv-btn dbv-sql-run"><i class="bi bi-play-fill"></i>运行</button>' +
          '</div>' +
        '</div>' +
        '<div class="dbv-grid"><div class="dbv-empty">选择左侧的表查看数据</div></div></div>' +
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

    // 画数据表：cols 列名、rows 行、offset 行号起点、emptyText 无数据文案
    function renderGrid(cols, rows, offset, emptyText) {
      let html = '<table class="dbv-table"><thead><tr>' +
        '<th class="dbv-rownum">#</th>' +
        cols.map(c => "<th>" + _sqliteEsc(c) + "</th>").join("") + "</tr></thead><tbody>";
      if (!rows.length) {
        html += '<tr><td class="dbv-nodata" colspan="' + (cols.length + 1) + '">' + _sqliteEsc(emptyText) + "</td></tr>";
      }
      rows.forEach((row, ri) => {
        html += "<tr><td class=\"dbv-rownum\">" + (offset + ri + 1) + "</td>" +
          row.map(v => "<td>" + (v == null ? '<span class="dbv-null">NULL</span>' : _sqliteEsc(v)) + "</td>").join("") + "</tr>";
      });
      grid.innerHTML = html + "</tbody></table>";
      grid.scrollTop = 0;
    }

    function renderRowsTable(d) {
      tname.textContent = d.table;
      meta.textContent = _sqliteFmtRows(d.total) + " 行";
      const cols = d.columns.length ? d.columns : d.rows.map((_, i) => "col" + (i + 1));
      renderGrid(cols, d.rows, d.offset, "空表（0 行）");
      const page = Math.floor(d.offset / d.limit) + 1;
      const pages = Math.max(1, Math.ceil(d.total / d.limit));
      pageEl.textContent = page + " / " + pages;
      // 回到「按表浏览」：恢复分页控件（SQL 查询结果没有分页）
      sizeSel.disabled = false;
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

    // ---- SQL 查询（只读：写操作由后端拒绝；结果渲染到下方网格）----
    const sqlPanel = host.querySelector(".dbv-sql");
    const sqlInput = host.querySelector(".dbv-sql-input");
    const sqlMsg = host.querySelector(".dbv-sql-msg");
    const sqlToggle = host.querySelector(".dbv-sql-toggle");
    let sqlSeq = 0;

    // 该功能在「设置 → 系统 AI」里被停用时，整行 AI 输入都收起来（后端也会拒绝调用）
    const aiRow = host.querySelector(".dbv-sql-ai");
    if (typeof onSysAiOffChange === "function") {
      onSysAiOffChange(() => {
        if (aiRow) aiRow.hidden = (typeof sysAiOff === "function") && sysAiOff("nl2sql");
      });
    }

    function setSqlPanel(show) {
      sqlPanel.hidden = !show;
      sqlToggle.classList.toggle("on", show);
      if (show) sqlInput.focus();
    }
    sqlToggle.addEventListener("click", () => setSqlPanel(sqlPanel.hidden));
    host.querySelector(".dbv-sql-close").addEventListener("click", () => setSqlPanel(false));

    // ---- 悬浮窗：拖标题栏移动、按钮切全屏（都限制在数据区内）----
    const sqlHead = host.querySelector(".dbv-sql-head");
    const sqlMaxBtn = host.querySelector(".dbv-sql-max");
    let dragFrom = null;

    function onDragMove(e) {
      if (!dragFrom) return;
      const box = sqlPanel.parentElement.getBoundingClientRect();   // .dbv-main
      const maxL = Math.max(0, box.width - sqlPanel.offsetWidth);
      const maxT = Math.max(0, box.height - sqlPanel.offsetHeight);
      const left = Math.max(0, Math.min(e.clientX - box.left - dragFrom.x, maxL));
      const top = Math.max(0, Math.min(e.clientY - box.top - dragFrom.y, maxT));
      sqlPanel.style.right = "auto";
      sqlPanel.style.left = left + "px";
      sqlPanel.style.top = top + "px";
    }
    function endDrag() {
      dragFrom = null;
      document.removeEventListener("mousemove", onDragMove);
      document.removeEventListener("mouseup", endDrag);
    }
    sqlHead.addEventListener("mousedown", e => {
      if (e.button !== 0 || (e.target.closest && e.target.closest(".dbv-btn"))) return;
      if (sqlPanel.classList.contains("max")) return;     // 全屏状态下无需拖动
      const r = sqlPanel.getBoundingClientRect();
      dragFrom = { x: e.clientX - r.left, y: e.clientY - r.top };
      e.preventDefault();
      document.addEventListener("mousemove", onDragMove);
      document.addEventListener("mouseup", endDrag);
    });
    sqlMaxBtn.addEventListener("click", () => {
      const on = sqlPanel.classList.toggle("max");
      sqlPanel.style.left = "";
      sqlPanel.style.top = "";
      sqlPanel.style.right = "";
      sqlMaxBtn.title = on ? "还原" : "全屏";
      sqlMaxBtn.innerHTML = '<i class="bi ' + (on ? "bi-arrows-angle-contract" : "bi-fullscreen") + '"></i>';
      sqlInput.focus();
    });
    host.querySelector(".dbv-sql-clear").addEventListener("click", () => {
      sqlInput.value = "";
      sqlMsg.textContent = "";
      sqlMsg.className = "dbv-sql-msg";
      sqlInput.focus();
    });

    function renderQueryResult(d) {
      if (!d.columns.length) {            // 无结果集的语句（如 PRAGMA 的写入型）
        grid.innerHTML = '<div class="dbv-ok">执行成功，无返回结果</div>';
        return;
      }
      renderGrid(d.columns, d.rows, 0, "查询没有返回任何行");
    }

    function runQuery() {
      const sql = sqlInput.value.trim();
      if (!sql) { sqlMsg.className = "dbv-sql-msg err"; sqlMsg.textContent = "请输入要执行的 SQL"; return; }
      const seq = ++sqlSeq;
      sqlMsg.className = "dbv-sql-msg";
      sqlMsg.textContent = "执行中…";
      grid.innerHTML = '<div class="dbv-empty">执行中…</div>';
      fetch("/api/sqlite/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: path, sql: sql, limit: state.limit }),
      })
        .then(r => r.json())
        .then(d => {
          if (seq !== sqlSeq) return;     // 已发起新的查询，丢弃旧结果
          if (d.error) {
            sqlMsg.className = "dbv-sql-msg err";
            sqlMsg.textContent = d.error;
            grid.innerHTML = '<div class="dbv-err">' + _sqliteEsc(d.error) + "</div>";
            return;
          }
          const tail = d.truncated ? "（仅显示前 " + d.limit + " 行）" : "";
          sqlMsg.className = "dbv-sql-msg ok";
          sqlMsg.textContent = "成功 · " + _sqliteFmtRows(d.row_count) + " 行 · " + d.elapsed_ms + " ms" + tail;
          // 结果集是独立的，与分页浏览互斥：先禁用分页控件
          tname.textContent = "SQL 结果";
          meta.textContent = _sqliteFmtRows(d.row_count) + " 行 · " + d.elapsed_ms + " ms" + tail;
          pageEl.textContent = "—";
          sizeSel.disabled = true;
          prevBtn.disabled = true;
          nextBtn.disabled = true;
          renderQueryResult(d);
        })
        .catch(e => {
          if (seq !== sqlSeq) return;
          sqlMsg.className = "dbv-sql-msg err";
          sqlMsg.textContent = "请求失败：" + (e.message || e);
          grid.innerHTML = '<div class="dbv-err">请求失败：' + _sqliteEsc(e.message || e) + "</div>";
        });
    }
    host.querySelector(".dbv-sql-run").addEventListener("click", runQuery);
    sqlInput.addEventListener("keydown", e => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); runQuery(); }
    });

    // ---- 一句话生成 SQL：交给系统 AI（设置 → AI 助手 的当前接口/模型）----
    // 只生成不执行：结果填进上面的输入框，确认无误后再 Ctrl+Enter 运行
    const aiInput = host.querySelector(".dbv-sql-ai-input");
    const aiRun = host.querySelector(".dbv-sql-ai-run");
    let aiBusy = false;

    function setAiBusy(on) {
      aiBusy = on;
      aiRun.disabled = on;
      aiInput.disabled = on;
      aiRun.classList.toggle("loading", on);
      aiRun.title = on ? "生成中…" : "生成 SQL（回车）";
      aiRun.innerHTML = '<i class="bi ' + (on ? "bi-arrow-repeat" : "bi-stars") + '"></i>';
    }

    function genSql() {
      if (aiBusy) return;
      const question = aiInput.value.trim();
      if (!question) {
        sqlMsg.className = "dbv-sql-msg err";
        sqlMsg.textContent = "请先用一句话描述要查什么";
        aiInput.focus();
        return;
      }
      setAiBusy(true);
      sqlMsg.className = "dbv-sql-msg";
      sqlMsg.textContent = "正在让 AI 生成 SQL…";
      fetch("/api/db/nl2sql", {          // 与数据库连接工具同一个入口，用 path 指明目标库
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: path, question: question }),
      })
        .then(r => r.json())
        .then(d => {
          setAiBusy(false);
          if (d.error) {
            sqlMsg.className = "dbv-sql-msg err";
            sqlMsg.textContent = d.error;
            if (d.sql) sqlInput.value = d.sql;      // 被拒的语句也放出来，便于人工改写
            return;
          }
          sqlInput.value = d.sql;
          sqlMsg.className = "dbv-sql-msg ok";
          sqlMsg.textContent = "已生成（" + (d.model || "AI") + " · " + d.elapsed_ms + " ms）· 确认后按 Ctrl+Enter 运行";
          sqlInput.focus();
        })
        .catch(e => {
          setAiBusy(false);
          sqlMsg.className = "dbv-sql-msg err";
          sqlMsg.textContent = "请求失败：" + (e.message || e);
        });
    }
    aiRun.addEventListener("click", genSql);
    aiInput.addEventListener("keydown", e => {
      if (e.key === "Enter") { e.preventDefault(); genSql(); }
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

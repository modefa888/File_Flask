  /* ==================================================================
     数据库连接工具：
       · 左栏「数据库」面板 —— 连接的新建 / 编辑 / 删除 / 测试；
       · 右侧编辑器区域 —— 打开某个连接后浏览库表与数据、执行只读 SQL。

     后端：app/routes/common/dbconn.py（SQLite 用标准库，MySQL/PG 走各自驱动）。
     密码加密存在服务端，前端只拿到脱敏串（password_masked），编辑时留空表示不改。
     ================================================================== */
  var DBC = {
    kinds: [],            // [{kind,label,icon,need_host,default_port,hint,driver,ready,install}]
    conns: [],            // [{id,name,kind,host,port,username,dbname,password_masked,has_password}]
    loaded: false,
  };
  var DBC_VIEW_PREFIX = "\u0000db:";

  function dbcKind(kind) {
    for (var i = 0; i < DBC.kinds.length; i++) if (DBC.kinds[i].kind === kind) return DBC.kinds[i];
    return { kind: kind, label: kind, icon: "bi-database", need_host: kind !== "sqlite", ready: true };
  }
  function dbcSub(c) {
    var k = dbcKind(c.kind);
    if (c.kind === "sqlite") return c.dbname || "";
    return (c.host || "") + (c.port ? ":" + c.port : "") + (c.dbname ? " / " + c.dbname : "");
  }

  async function dbcApi(url, opts) {
    var r = await fetch(url, opts);
    var d = await r.json();
    if (d && d.error) throw new Error(d.error);
    return d || {};
  }

  /* ---------- 左栏：连接列表 ---------- */
  async function loadDbConns(force) {
    var box = $("dbcList");
    if (!box) return;
    if (!DBC.loaded || force) {
      box.innerHTML = '<div class="ph">加载中…</div>';
      try {
        var d = await dbcApi("/api/db/conns");
        DBC.conns = d.conns || [];
        if (!DBC.kinds.length) {
          try { DBC.kinds = (await dbcApi("/api/db/kinds")).kinds || []; } catch (e) { DBC.kinds = []; }
        }
        DBC.loaded = true;
      } catch (e) {
        box.innerHTML = '<div class="ph">读取连接失败：' + esc(e.message || e) + "</div>";
        return;
      }
    }
    renderDbConns();
  }

  function renderDbConns() {
    var box = $("dbcList");
    if (!box) return;
    if (!DBC.conns.length) {
      box.innerHTML = '<div class="ph">还没有连接。<br>点上方「新建连接」，可连接 SQLite / MySQL / PostgreSQL。</div>';
      return;
    }
    box.innerHTML = DBC.conns.map(function (c) {
      var k = dbcKind(c.kind);
      return '<div class="dbc-item" data-id="' + escAttr(c.id) + '" title="' + escAttr(dbcSub(c)) + '">' +
        '<i class="bi ' + escAttr(k.icon || "bi-database") + ' dbc-ico"></i>' +
        '<div class="dbc-main">' +
          '<div class="dbc-name">' + esc(c.name) + '</div>' +
          '<div class="dbc-sub">' + esc(k.label) + ' · ' + esc(dbcSub(c)) + '</div>' +
        '</div>' +
        '<button class="dbc-act dbc-edit" title="编辑"><i class="bi bi-pencil"></i></button>' +
        '<button class="dbc-act dbc-del" title="删除"><i class="bi bi-trash"></i></button>' +
      '</div>';
    }).join("");
    box.querySelectorAll(".dbc-item").forEach(function (it) {
      var c = dbcFind(it.dataset.id);
      if (!c) return;
      it.querySelector(".dbc-main").onclick = function () { openDbView(c); };
      it.querySelector(".dbc-ico").onclick = function () { openDbView(c); };
      it.querySelector(".dbc-edit").onclick = function (e) { e.stopPropagation(); dbcDialog(c); };
      it.querySelector(".dbc-del").onclick = async function (e) {
        e.stopPropagation();
        var ok = await uiConfirm("删除连接", "确定删除连接「" + c.name + "」吗？\n（只删除保存的配置，不影响数据库本身）",
                                 "删除", true);
        if (!ok) return;
        try {
          await dbcApi("/api/db/conns/delete", { method: "POST",
            headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: c.id }) });
          toast("已删除连接：" + c.name, "ok");
          await loadDbConns(true);
        } catch (err) { toast("删除失败：" + (err.message || err), "err"); }
      };
    });
  }
  function dbcFind(id) {
    for (var i = 0; i < DBC.conns.length; i++) if (DBC.conns[i].id === id) return DBC.conns[i];
    return null;
  }

  /* ---------- 新建 / 编辑弹窗 ---------- */
  function dbcDialog(conn) {
    return new Promise(function (resolve) {
      var ov = $("modalOverlay");
      var box = document.createElement("div");
      box.className = "ide-modal wide dbc-modal";
      var cur = conn || {};
      box.innerHTML =
        '<div class="m-title"><i class="bi bi-database-add"></i><span>' +
          (conn ? "编辑连接" : "新建数据库连接") + "</span></div>" +
        '<div class="m-body">' +
          '<div class="dbc-row"><span class="dbc-lb">类型</span><div class="dbc-kinds"></div></div>' +
          '<div class="dbc-row"><span class="dbc-lb">名称</span>' +
            '<input class="dbc-in dbc-name-in" spellcheck="false" placeholder="我的数据库"></div>' +
          '<div class="dbc-row dbc-host-row"><span class="dbc-lb">主机</span>' +
            '<input class="dbc-in dbc-host-in" spellcheck="false" placeholder="127.0.0.1"></div>' +
          '<div class="dbc-row dbc-host-row"><span class="dbc-lb">端口</span>' +
            '<input class="dbc-in dbc-port-in" spellcheck="false" placeholder="3306"></div>' +
          '<div class="dbc-row dbc-host-row"><span class="dbc-lb">用户</span>' +
            '<input class="dbc-in dbc-user-in" spellcheck="false" placeholder="root"></div>' +
          '<div class="dbc-row dbc-host-row"><span class="dbc-lb">密码</span>' +
            '<input class="dbc-in dbc-pwd-in" type="password" spellcheck="false" placeholder="留空表示不修改"></div>' +
          '<div class="dbc-row"><span class="dbc-lb dbc-db-lb">库名</span>' +
            '<input class="dbc-in dbc-db-in" spellcheck="false"></div>' +
          '<div class="dbc-tip"><i class="bi bi-info-circle"></i><span class="dbc-tip-t"></span></div>' +
          '<div class="dbc-msg"></div>' +
        "</div>" +
        '<div class="m-foot"><button class="dbc-test">测试连接</button><span class="dbc-sp"></span>' +
        '<button class="m-cancel">取消</button><button class="m-ok">保存</button></div>';
      ov.innerHTML = "";
      ov.appendChild(box);
      ov.classList.add("show");
      var kindEls = box.querySelector(".dbc-kinds");
      var nameIn = box.querySelector(".dbc-name-in"), hostIn = box.querySelector(".dbc-host-in");
      var portIn = box.querySelector(".dbc-port-in"), userIn = box.querySelector(".dbc-user-in");
      var pwdIn = box.querySelector(".dbc-pwd-in"), dbIn = box.querySelector(".dbc-db-in");
      var tipEl = box.querySelector(".dbc-tip-t"), msgEl = box.querySelector(".dbc-msg");
      var okBtn = box.querySelector(".m-ok"), testBtn = box.querySelector(".dbc-test");
      var kind = cur.kind || (DBC.kinds[0] ? DBC.kinds[0].kind : "sqlite");
      var busy = false;

      function close(v) {
        ov.classList.remove("show"); ov.innerHTML = "";
        ov.onkeydown = null; ov.onmousedown = null;
        resolve(v);
      }
      function say(msg, isErr, isOk) {
        msgEl.textContent = msg || "";
        msgEl.className = "dbc-msg" + (isErr ? " err" : (isOk ? " ok" : ""));
      }
      function renderKinds() {
        kindEls.innerHTML = DBC.kinds.map(function (k) {
          return '<button type="button" class="dbc-kind' + (k.kind === kind ? " on" : "") +
            (k.ready ? "" : " off") + '" data-k="' + escAttr(k.kind) + '" title="' +
            escAttr(k.ready ? k.hint : "未安装驱动，需先执行：" + k.install) + '">' +
            '<i class="bi ' + escAttr(k.icon) + '"></i>' + esc(k.label) +
            (k.ready ? "" : '<span class="dbc-nodrv">缺驱动</span>') + "</button>";
        }).join("");
        kindEls.querySelectorAll(".dbc-kind").forEach(function (b) {
          b.onclick = function () {
            var k = b.dataset.k;
            var meta = dbcKind(k);
            if (!meta.ready) { say("未安装 " + meta.driver + "，请先执行：" + meta.install, true); return; }
            kind = k; renderKinds(); refresh();
          };
        });
      }
      function refresh() {
        var k = dbcKind(kind);
        var isSqlite = kind === "sqlite";
        box.querySelectorAll(".dbc-host-row").forEach(function (r) { r.hidden = isSqlite; });
        box.querySelector(".dbc-tip-t").textContent = k.hint || "";
        box.querySelector(".dbc-db-lb").textContent = isSqlite ? "文件" : "库名";
        dbIn.placeholder = isSqlite ? "/path/to/database.db" : "可留空，连上后再选库";
        if (!portIn.value) portIn.placeholder = String(k.default_port || "");
      }
      function payload() {
        return { id: cur.id || "", kind: kind, name: nameIn.value.trim(),
                 host: hostIn.value.trim(), port: parseInt(portIn.value, 10) || 0,
                 username: userIn.value.trim(), password: pwdIn.value,
                 dbname: dbIn.value.trim() };
      }
      async function test() {
        if (busy) return;
        busy = true; testBtn.disabled = true; say("正在测试连接…");
        try {
          var d = await dbcApi("/api/db/test", { method: "POST",
            headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload()) });
          say(d.ok ? "连接成功：" + (d.version || "") + "（" + d.elapsed_ms + " ms）" : (d.error || "连接失败"), !d.ok, d.ok);
        } catch (e) { say("测试失败：" + (e.message || e), true); }
        finally { busy = false; testBtn.disabled = false; }
      }
      async function save() {
        if (busy) return;
        if (!nameIn.value.trim()) { say("请填写连接名称", true); nameIn.focus(); return; }
        busy = true; okBtn.disabled = true; okBtn.textContent = "保存中…";
        try {
          var d = await dbcApi("/api/db/conns", { method: "POST",
            headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload()) });
          close(d.conn || true);
        } catch (e) { say(e.message || String(e), true); }
        finally { busy = false; okBtn.disabled = false; okBtn.textContent = "保存"; }
      }

      kindEls.dataset.k = kind;
      nameIn.value = cur.name || "";
      hostIn.value = cur.host || "";
      portIn.value = cur.port ? String(cur.port) : "";
      userIn.value = cur.username || "";
      dbIn.value = cur.dbname || "";
      pwdIn.placeholder = cur.has_password ? "留空表示不修改（已存 " + (cur.password_masked || "") + "）" : "密码";
      renderKinds(); refresh();
      box.querySelector(".dbc-test").onclick = test;
      okBtn.onclick = save;
      box.querySelector(".m-cancel").onclick = function () { close(null); };
      ov.onmousedown = function (e) { if (e.target === ov) close(null); };
      ov.onkeydown = function (e) {
        if (e.key === "Escape") { e.preventDefault(); close(null); }
        else if (e.key === "Enter" && !busy) { e.preventDefault(); save(); }
      };
      nameIn.focus();
    });
  }

  /* ---------- 编辑器区域：数据库视图 ---------- */
  function openDbView(conn) {
    var path = DBC_VIEW_PREFIX + conn.id;
    var tab = findTab(path);
    if (!tab) {
      var host = document.createElement("div");
      host.className = "cm-host dbc-host";
      tab = { path: path, displayPath: conn.name, name: conn.name, host: host, cm: null,
              original: "", dirty: false, big: false, group: curGroup, isDbConn: true,
              connId: conn.id,
              iconHtml: '<i class="bi ' + escAttr(dbcKind(conn.kind).icon || "bi-database") + '"></i>' };
      tabs.push(tab);
      renderTabsAll();
      buildDbView(tab, conn);
    }
    activate(tab);
    return tab;
  }

  function buildDbView(tab, conn) {
    tab.host.innerHTML =
      '<div class="dbc">' +
        '<div class="dbc-side">' +
          '<div class="dbc-side-hd">' +
            '<select class="dbc-db-sel" title="切换数据库"></select>' +
            '<button class="dbc-mini dbc-refresh" title="刷新结构与数据"><i class="bi bi-arrow-clockwise"></i></button>' +
          "</div>" +
          '<div class="dbc-tabs-sel">表 / 视图</div>' +
          '<div class="dbc-tables scroll-thin"></div>' +
        "</div>" +
        '<div class="dbc-main">' +
          '<div class="dbc-bar">' +
            '<span class="dbc-cur" title="当前表">—</span>' +
            '<span class="dbc-sp"></span>' +
            '<button class="dbc-mini dbc-sql-toggle" title="显示 / 隐藏 SQL 执行区"><i class="bi bi-terminal"></i> SQL</button>' +
          "</div>" +
          '<div class="dbc-sql" hidden>' +
            "<textarea class=\"dbc-sql-in\" spellcheck=\"false\" placeholder=\"输入只读 SQL，Ctrl+Enter 执行（仅允许 SELECT / SHOW / EXPLAIN 等）\"></textarea>" +
            '<div class="dbc-sql-bar"><span class="dbc-sql-msg"></span>' +
            '<button class="ai-set-btn dbc-sql-run">执行</button></div>' +
          "</div>" +
          '<div class="dbc-grid-wrap scroll-thin"></div>' +
          '<div class="dbc-pager"></div>' +
        "</div>" +
      "</div>";

    var state = { db: conn.dbname || "", table: "", schema: "", limit: 100, offset: 0,
                  total: null, seq: 0, kind: conn.kind };
    tab.dbcState = state;

    var dbSel = tab.host.querySelector(".dbc-db-sel");
    var tabsBox = tab.host.querySelector(".dbc-tables");
    var gridBox = tab.host.querySelector(".dbc-grid-wrap");
    var pagerEl = tab.host.querySelector(".dbc-pager");
    var curEl = tab.host.querySelector(".dbc-cur");
    var sqlBox = tab.host.querySelector(".dbc-sql");
    var sqlIn = tab.host.querySelector(".dbc-sql-in");
    var sqlMsg = tab.host.querySelector(".dbc-sql-msg");

    function err(e) { return '<div class="dbc-empty">' + esc(e.message || e) + "</div>"; }

    function drawGrid(cols, rows, emptyText, opts) {
      if (!cols || !cols.length) return '<div class="dbc-empty">' + esc(emptyText || "没有数据") + "</div>";
      var head = "<tr>" + cols.map(function (c) { return "<th>" + esc(c) + "</th>"; }).join("") + "</tr>";
      var body = rows.length
        ? rows.map(function (r) {
            return "<tr>" + r.map(function (v) {
              if (v === null || v === undefined) return '<td class="dbc-null">NULL</td>';
              return "<td>" + esc(v) + "</td>";
            }).join("") + "</tr>";
          }).join("")
        : '<tr><td class="dbc-empty" colspan="' + cols.length + '">没有数据</td></tr>';
      var cls = (opts && opts.single) ? "dbc-grid single" : "dbc-grid";
      return '<table class="' + cls + '"><thead>' + head + "</thead><tbody>" + body + "</tbody></table>";
    }

    async function loadSchema() {
      tabsBox.innerHTML = '<div class="dbc-empty">加载中…</div>';
      try {
        var d = await dbcApi("/api/db/schema?conn=" + encodeURIComponent(conn.id) +
                             "&dbname=" + encodeURIComponent(state.db));
        state.kind = d.kind || state.kind;
        state.db = d.dbname || state.db;
        dbSel.innerHTML = (d.databases || []).map(function (x) {
          return '<option value="' + escAttr(x.name) + '"' + (x.current ? " selected" : "") + ">" +
            esc(x.name) + "</option>";
        }).join("") || '<option value="">（无）</option>';
        var list = d.tables || [];
        tabsBox.innerHTML = list.length
          ? list.map(function (t) {
              return '<div class="dbc-table" data-name="' + escAttr(t.name) + '" data-schema="' +
                escAttr(t.schema || "") + '" title="' + escAttr(t.name) + '">' +
                '<i class="bi ' + (String(t.kind).toLowerCase().indexOf("view") >= 0 ? "bi-eye" : "bi-table") + '"></i>' +
                '<span class="dbc-tn">' + esc(t.name) + "</span>" +
                '<span class="dbc-tc">' + (t.rows === null || t.rows === undefined ? "" : t.rows) + "</span></div>";
            }).join("")
          : '<div class="dbc-empty">这个库里没有表</div>';
        tabsBox.querySelectorAll(".dbc-table").forEach(function (it) {
          it.onclick = function () {
            state.table = it.dataset.name;
            state.schema = it.dataset.schema;
            tabsBox.querySelectorAll(".dbc-table").forEach(function (x) {
              x.classList.toggle("on", x === it);
            });
            loadRows(0);
          };
        });
        var first = tabsBox.querySelector(".dbc-table");
        if (first) first.onclick();
        else { curEl.textContent = "—"; gridBox.innerHTML = '<div class="dbc-empty">选择左侧的表查看数据</div>'; pagerEl.innerHTML = ""; }
      } catch (e) {
        tabsBox.innerHTML = err(e);
      }
    }

    async function loadRows(offset) {
      if (!state.table) return;
      var seq = ++state.seq;
      gridBox.innerHTML = '<div class="dbc-empty">加载中…</div>';
      curEl.textContent = state.table;
      try {
        var d = await dbcApi("/api/db/rows?conn=" + encodeURIComponent(conn.id) +
                             "&dbname=" + encodeURIComponent(state.db) +
                             "&schema=" + encodeURIComponent(state.schema) +
                             "&table=" + encodeURIComponent(state.table) +
                             "&limit=" + state.limit + "&offset=" + (offset || 0));
        if (seq !== state.seq) return;                    // 快速切换时丢弃过期结果
        state.offset = d.offset || 0;
        state.total = d.total;
        gridBox.innerHTML = drawGrid(d.columns, d.rows, "表里没有数据");
        var from = d.rows.length ? state.offset + 1 : 0;
        var to = state.offset + d.rows.length;
        pagerEl.innerHTML =
          '<span class="dbc-pg-info">' + (state.total === null || state.total === undefined
            ? "第 " + from + "-" + to + " 行"
            : "第 " + from + "-" + to + " 行 / 共 " + state.total + " 行") + "</span>" +
          '<span class="dbc-sp"></span>' +
          '<button class="dbc-mini dbc-prev"' + (state.offset <= 0 ? " disabled" : "") + '><i class="bi bi-chevron-left"></i></button>' +
          '<button class="dbc-mini dbc-next"' + (d.rows.length < state.limit ? " disabled" : "") + '><i class="bi bi-chevron-right"></i></button>' +
          '<select class="dbc-limit"><option value="50">50</option><option value="100">100</option>' +
          '<option value="200">200</option><option value="500">500</option></select>';
        var lim = pagerEl.querySelector(".dbc-limit");
        lim.value = String(state.limit);
        lim.onchange = function () { state.limit = parseInt(lim.value, 10) || 100; loadRows(0); };
        pagerEl.querySelector(".dbc-prev").onclick = function () { loadRows(Math.max(0, state.offset - state.limit)); };
        pagerEl.querySelector(".dbc-next").onclick = function () { loadRows(state.offset + state.limit); };
      } catch (e) {
        if (seq === state.seq) gridBox.innerHTML = err(e);
      }
    }

    async function runQuery() {
      var sql = sqlIn.value.trim();
      if (!sql) { sqlMsg.textContent = "请先输入 SQL"; return; }
      sqlMsg.textContent = "执行中…";
      gridBox.innerHTML = '<div class="dbc-empty">执行中…</div>';
      curEl.textContent = "查询结果";
      try {
        var d = await dbcApi("/api/db/query", { method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ conn: conn.id, dbname: state.db, sql: sql }) });
        sqlMsg.textContent = "返回 " + d.row_count + " 行" + (d.truncated ? "（已截断到 " + d.limit + "）" : "") +
          " · " + (d.elapsed_ms || 0) + " ms";
        gridBox.innerHTML = drawGrid(d.columns, d.rows, "查询成功，没有返回行");
        pagerEl.innerHTML = "";
      } catch (e) {
        sqlMsg.textContent = e.message || String(e);
        gridBox.innerHTML = err(e);
      }
    }

    dbSel.onchange = function () { state.db = dbSel.value; state.table = ""; loadSchema(); };
    tab.host.querySelector(".dbc-refresh").onclick = function () {
      if (state.table) { loadRows(state.offset); } else { loadSchema(); }
    };
    tab.host.querySelector(".dbc-sql-toggle").onclick = function () {
      sqlBox.hidden = !sqlBox.hidden;
      if (!sqlBox.hidden) sqlIn.focus();
    };
    tab.host.querySelector(".dbc-sql-run").onclick = runQuery;
    sqlIn.addEventListener("keydown", function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); runQuery(); }
    });
    loadSchema();
  }

  function dbcInit() {
    if ($("dbcNew")) {
      $("dbcNew").onclick = async function () {
        if (!DBC.kinds.length) { try { DBC.kinds = (await dbcApi("/api/db/kinds")).kinds || []; } catch (e) { /* 忽略 */ } }
        var r = await dbcDialog(null);
        if (r) { toast("已保存连接", "ok"); await loadDbConns(true); }
      };
    }
    if ($("dbcRefresh")) $("dbcRefresh").onclick = function () { loadDbConns(true); };
  }
  dbcInit();

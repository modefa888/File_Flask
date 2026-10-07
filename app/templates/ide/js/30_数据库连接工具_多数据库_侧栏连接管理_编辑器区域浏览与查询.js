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

  /* ---------- 每个连接在编辑器区域的浏览状态（选中的库 / 表 / SQL 文本等）----------
     刷新后据此还原，避免每次都回到初始（第一张表、SQL 窗关闭）。按连接 id 存 localStorage。 */
  function dbcStateKey(id) { return "ide.dbconn.state." + id; }
  function dbcLoadState(id) {
    try { return JSON.parse(localStorage.getItem(dbcStateKey(id)) || "{}") || {}; } catch (e) { return {}; }
  }
  function dbcSaveState(id, patch) {
    try {
      var s = dbcLoadState(id);
      for (var k in patch) if (Object.prototype.hasOwnProperty.call(patch, k)) s[k] = patch[k];
      localStorage.setItem(dbcStateKey(id), JSON.stringify(s));
    } catch (e) { /* 忽略（隐私模式 / 空间不足等） */ }
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
          try { localStorage.removeItem(dbcStateKey(c.id)); } catch (e2) { /* 忽略 */ }   // 顺带清掉浏览状态
          toast("已删除连接：" + c.name, "ok");
          await loadDbConns(true);
        } catch (err) { toast("删除失败：" + (err.message || err), "err"); }
      };
    });
    dbcSyncOpenMarks();          // 侧栏高亮：已打开 / 当前正在查看的连接
  }
  function dbcFind(id) {
    for (var i = 0; i < DBC.conns.length; i++) if (DBC.conns[i].id === id) return DBC.conns[i];
    return null;
  }

  /* ---------- 侧栏高亮：已打开（open）/ 当前正在查看（active）的连接 ----------
     标签的增删切换统一会走到 00_preamble 的 renderTabsAll / activate，
     那里会回调本函数，所以这里只按当前标签状态刷一遍样式。 */
  function dbcSyncOpenMarks() {
    var box = $("dbcList");
    if (!box || typeof DBC_VIEW_PREFIX !== "string") return;    // 尚未初始化时跳过
    box.querySelectorAll(".dbc-item").forEach(function (it) {
      var t = findTab(DBC_VIEW_PREFIX + it.dataset.id);
      it.classList.toggle("open", !!t);
      it.classList.toggle("active", !!(t && t.host.classList.contains("active")));
    });
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
        box.querySelector(".dbc-db-lb").textContent = isSqlite ? "文件" : (kind === "redis" ? "库序号" : "库名");
        dbIn.placeholder = { sqlite: "/path/to/database.db", redis: "0（默认 0 号库）" }[kind] || "可留空，连上后再选库";
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
            '<button class="dbc-mini dbc-sql-toggle" title="显示 / 隐藏 SQL 执行区"><i class="bi bi-terminal"></i> <span class="dbc-sql-btn-t">SQL</span></button>' +
          "</div>" +
          '<div class="dbc-grid-wrap scroll-thin"></div>' +
          '<div class="dbc-pager"></div>' +
          /* SQL 悬浮查询窗：绝对定位在数据区之上，可拖动 / 可全屏，不占数据表空间 */
          '<div class="dbc-sql" hidden>' +
            '<div class="dbc-sql-head">' +
              '<span class="dbc-sql-title"><i class="bi bi-terminal"></i>SQL 查询</span>' +
              '<span class="dbc-sql-hint">只读 · Ctrl+Enter 运行 · 拖动标题可移动</span>' +
              '<span class="dbc-sp"></span>' +
              '<button class="dbc-mini dbc-sql-max" title="全屏"><i class="bi bi-fullscreen"></i></button>' +
              '<button class="dbc-mini dbc-sql-close" title="收起"><i class="bi bi-x-lg"></i></button>' +
            "</div>" +
            '<div class="dbc-sql-ai">' +
              '<input class="dbc-sql-ai-input" type="text" spellcheck="false" placeholder="✨ 用一句话描述要查什么，回车即生成 SQL">' +
              '<button class="dbc-mini dbc-sql-ai-run" title="生成 SQL（回车）"><i class="bi bi-stars"></i></button>' +
            "</div>" +
            '<textarea class="dbc-sql-input" spellcheck="false" placeholder="SELECT * FROM 表名 LIMIT 100;"></textarea>' +
            '<div class="dbc-sql-bar">' +
              '<span class="dbc-sql-msg"></span>' +
              '<button class="dbc-mini dbc-sql-clear">清空</button>' +
              '<button class="dbc-mini dbc-sql-run"><i class="bi bi-play-fill"></i>运行</button>' +
            "</div>" +
          "</div>" +
          /* 行详情悬浮窗：点表格任意一行弹出，字段 / 值全量展示（不截断、可换行、可复制） */
          '<div class="dbc-sql dbc-row" hidden>' +
            '<div class="dbc-sql-head">' +
              '<span class="dbc-sql-title"><i class="bi bi-list-columns-reverse"></i>行详情</span>' +
              '<span class="dbc-sql-hint">点表格任意一行查看全部字段 · 拖动标题可移动</span>' +
              '<span class="dbc-sp"></span>' +
              '<button class="dbc-mini dbc-row-max" title="全屏"><i class="bi bi-fullscreen"></i></button>' +
              '<button class="dbc-mini dbc-row-close" title="关闭"><i class="bi bi-x-lg"></i></button>' +
            "</div>" +
            '<div class="dbc-row-body scroll-thin"></div>' +
            '<div class="dbc-sql-bar"><span class="dbc-sql-msg dbc-row-info"></span>' +
              '<button class="dbc-mini dbc-row-edit"><i class="bi bi-pencil"></i> 编辑</button>' +
              '<button class="dbc-mini dbc-row-save" hidden><i class="bi bi-check-lg"></i> 保存</button>' +
              '<button class="dbc-mini dbc-row-cancel" hidden>取消</button>' +
              '<button class="dbc-mini dbc-row-copy"><i class="bi bi-clipboard"></i> 复制 JSON</button></div>' +
          "</div>" +
        "</div>" +
      "</div>";

    var saved = dbcLoadState(conn.id);        // 上次的浏览状态（刷新后还原）
    var state = { db: saved.db || conn.dbname || "", table: saved.table || "",
                  schema: saved.schema || "", limit: saved.limit || 100, offset: 0,
                  total: null, seq: 0, kind: conn.kind };
    tab.dbcState = state;

    var dbSel = tab.host.querySelector(".dbc-db-sel");
    var tabsBox = tab.host.querySelector(".dbc-tables");
    var gridBox = tab.host.querySelector(".dbc-grid-wrap");
    var pagerEl = tab.host.querySelector(".dbc-pager");
    var curEl = tab.host.querySelector(".dbc-cur");
    var sqlBox = tab.host.querySelector(".dbc-sql");
    var sqlIn = tab.host.querySelector(".dbc-sql-input");
    var sqlMsg = tab.host.querySelector(".dbc-sql-msg");
    var lastGrid = { cols: [], rows: [] };     // 当前网格的数据，供「行详情」取用

    // 非 SQL 库（Redis / MongoDB）没有「表 / SQL 语句」概念：左侧改为键 / 集合，右侧查询区改为命令 / JSON
    var isRedis = conn.kind === "redis", isMongo = conn.kind === "mongodb";
    var isNosql = isRedis || isMongo;
    tab.host.querySelector(".dbc-tabs-sel").textContent = isRedis ? "键（Key）" : (isMongo ? "集合" : "表 / 视图");
    tab.host.querySelector(".dbc-sql-btn-t").textContent = isRedis ? "命令" : (isMongo ? "查询" : "SQL");
    tab.host.querySelector(".dbc-sql-toggle").title =
      isRedis ? "显示 / 隐藏 Redis 命令区" : (isMongo ? "显示 / 隐藏 MongoDB 查询区" : "显示 / 隐藏 SQL 执行区");
    if (isNosql) {
      tab.host.querySelector(".dbc-sql-title").innerHTML =
        '<i class="bi bi-terminal"></i>' + (isRedis ? "Redis 命令" : "MongoDB 查询");
      tab.host.querySelector(".dbc-sql-hint").textContent = isRedis
        ? "只读 · Ctrl+Enter 执行 · 仅允许读取类命令"
        : "只读 · Ctrl+Enter 执行 · JSON 过滤（默认作用于左侧选中的集合，可用 collection 指定）";
      sqlIn.placeholder = isRedis ? "HGETALL user:1"
                                  : '{"collection": "users", "filter": {}, "limit": 50}';
    }

    function err(e) { return '<div class="dbc-empty">' + esc(e.message || e) + "</div>"; }

    function drawGrid(cols, rows, emptyText, opts) {
      lastGrid = { cols: (cols && cols.length) ? cols : [], rows: rows || [] };   // 供「行详情」取用
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

    var _schemaRetry = false;
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
            dbcSaveState(conn.id, { db: state.db, table: state.table, schema: state.schema });
            tabsBox.querySelectorAll(".dbc-table").forEach(function (x) {
              x.classList.toggle("on", x === it);
            });
            loadRows(0);
          };
        });
        // 优先还原上次选中的表；该表不存在（或没记录）时退回第一张
        var pick = null;
        tabsBox.querySelectorAll(".dbc-table").forEach(function (it) {
          if (!pick && state.table && it.dataset.name === state.table) pick = it;
        });
        var target = pick || tabsBox.querySelector(".dbc-table");
        if (target) target.onclick();
        else { curEl.textContent = "—"; gridBox.innerHTML = '<div class="dbc-empty">选择左侧的表查看数据</div>'; pagerEl.innerHTML = ""; }
      } catch (e) {
        // 上次记住的库已不可用（被删 / 改名）：退回连接自身的库重试一次，避免卡死
        if (!_schemaRetry && state.db && state.db !== (conn.dbname || "")) {
          _schemaRetry = true;
          state.db = conn.dbname || ""; state.table = ""; state.schema = "";
          dbcSaveState(conn.id, { db: state.db, table: "", schema: "" });
          return loadSchema();
        }
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
        lastGrid.pk = d.pk || [];            // 主键（编辑行时用来定位）
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
      if (!sql) { sqlMsg.className = "dbc-sql-msg err"; sqlMsg.textContent = "请先输入 SQL"; return; }
      dbcSaveState(conn.id, { sql: sqlIn.value });
      sqlMsg.className = "dbc-sql-msg";
      sqlMsg.textContent = "执行中…";
      gridBox.innerHTML = '<div class="dbc-empty">执行中…</div>';
      curEl.textContent = "查询结果";
      try {
        var d = await dbcApi("/api/db/query", { method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ conn: conn.id, dbname: state.db, schema: state.schema,
                                 table: state.table, sql: sql }) });
        // 后端会回传「实际查询的表 / 集合」（MongoDB 可能由 JSON 里的 collection 指定）：
        // 与左侧选中的不一致时同步过去，避免侧栏高亮与结果对不上
        var usedEl = null;
        tabsBox.querySelectorAll(".dbc-table").forEach(function (x) {
          if (!usedEl && d.table && x.dataset.name === d.table) usedEl = x;
        });
        if (usedEl && d.table !== state.table) {
          state.table = d.table;
          tabsBox.querySelectorAll(".dbc-table").forEach(function (x) { x.classList.toggle("on", x === usedEl); });
          dbcSaveState(conn.id, { table: d.table, schema: state.schema });
        }
        sqlMsg.className = "dbc-sql-msg ok";
        sqlMsg.textContent = (d.table ? d.table + " · " : "") + "返回 " + d.row_count + " 行" +
          (d.truncated ? "（已截断到 " + d.limit + "）" : "") + " · " + (d.elapsed_ms || 0) + " ms";
        gridBox.innerHTML = drawGrid(d.columns, d.rows, "查询成功，没有返回行");
        lastGrid.pk = d.pk || [];
        pagerEl.innerHTML = "";
      } catch (e) {
        sqlMsg.className = "dbc-sql-msg err";
        sqlMsg.textContent = e.message || String(e);
        gridBox.innerHTML = err(e);
      }
    }

    // ---- 一句话生成 SQL：交给系统 AI（设置 → AI 助手 的当前接口/模型），只生成不执行 ----
    var aiRow = tab.host.querySelector(".dbc-sql-ai");
    var aiInput = tab.host.querySelector(".dbc-sql-ai-input");
    var aiRun = tab.host.querySelector(".dbc-sql-ai-run");
    var aiBusy = false;
    // 该功能在「设置 → 系统 AI」里被停用时，整行 AI 输入都收起来（后端也会拒绝调用）
    function refreshAiRow() {
      if (!aiRow) return;
      aiRow.hidden = (typeof sysAiOff === "function") && sysAiOff("nl2sql");
    }
    if (typeof onSysAiOffChange === "function") onSysAiOffChange(refreshAiRow);
    else refreshAiRow();
    // 非 SQL 库同样支持「一句话生成」，只是产物不同：命令 / JSON
    var aiTip = isRedis ? "生成命令（回车）" : (isMongo ? "生成查询（回车）" : "生成 SQL（回车）");
    if (isRedis) aiInput.placeholder = "✨ 用一句话描述要查什么，回车即生成命令";
    else if (isMongo) aiInput.placeholder = "✨ 用一句话描述要查什么，回车即生成 JSON";
    aiRun.title = aiTip;
    function setAiBusy(on) {
      aiBusy = on;
      aiRun.disabled = on; aiInput.disabled = on;
      aiRun.classList.toggle("loading", on);
      aiRun.title = on ? "生成中…" : aiTip;
      aiRun.innerHTML = '<i class="bi ' + (on ? "bi-arrow-repeat" : "bi-stars") + '"></i>';
    }
    async function genSql() {
      if (aiBusy) return;
      var q = aiInput.value.trim();
      if (!q) { sqlMsg.className = "dbc-sql-msg err"; sqlMsg.textContent = "请先用一句话描述要查什么"; aiInput.focus(); return; }
      setAiBusy(true);
      sqlMsg.className = "dbc-sql-msg";
      sqlMsg.textContent = isRedis ? "正在让 AI 生成命令…" : (isMongo ? "正在让 AI 生成查询…" : "正在让 AI 生成 SQL…");
      try {
        var d = await dbcApi("/api/db/nl2sql", { method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ conn: conn.id, dbname: state.db, question: q }) });
        sqlIn.value = d.sql || "";
        dbcSaveState(conn.id, { sql: sqlIn.value });
        sqlMsg.className = "dbc-sql-msg ok";
        sqlMsg.textContent = "已生成（" + (d.model || "AI") + " · " + (d.elapsed_ms || 0) + " ms）· 确认后按 Ctrl+Enter 运行";
        sqlIn.focus();
      } catch (e) {
        sqlMsg.className = "dbc-sql-msg err";
        sqlMsg.textContent = e.message || String(e);
      } finally { setAiBusy(false); }
    }

    // ---- 悬浮窗通用：拖标题栏移动、按钮切全屏（限制在数据区内），并按连接记住位置 / 全屏状态 ----
    function makeCard(box, head, maxBtn, name) {
      var pos = saved[name + "Pos"] || null;
      var drag = null;
      function clamp() {                            // 把位置夹回数据区内（宿主不可见时不动）
        if (box.classList.contains("max") || !box.style.left) return;
        var area = box.parentElement.getBoundingClientRect();    // .dbc-main
        if (!area.width || !area.height) return;   // 尺寸为 0 说明宿主还没显示，夹了会被压到左上角
        var maxL = Math.max(0, area.width - box.offsetWidth);
        var maxT = Math.max(0, area.height - box.offsetHeight);
        box.style.left = Math.max(0, Math.min(parseFloat(box.style.left) || 0, maxL)) + "px";
        box.style.top = Math.max(0, Math.min(parseFloat(box.style.top) || 0, maxT)) + "px";
      }
      function place() {                            // 清掉内联定位，按「记录的位置」或 CSS 默认值摆放
        box.style.left = ""; box.style.top = ""; box.style.right = "";
        if (!box.classList.contains("max") && pos && pos.left) {
          box.style.right = "auto";
          box.style.left = pos.left; box.style.top = pos.top;
          clamp();
        }
      }
      function onMove(e) {
        if (!drag) return;
        var area = box.parentElement.getBoundingClientRect();
        var maxL = Math.max(0, area.width - box.offsetWidth);
        var maxT = Math.max(0, area.height - box.offsetHeight);
        box.style.right = "auto";
        box.style.left = Math.max(0, Math.min(e.clientX - area.left - drag.x, maxL)) + "px";
        box.style.top = Math.max(0, Math.min(e.clientY - area.top - drag.y, maxT)) + "px";
      }
      function endDrag() {
        if (drag) {                                 // 记住拖动后的位置
          pos = { left: box.style.left, top: box.style.top };
          var p = {}; p[name + "Pos"] = pos; dbcSaveState(conn.id, p);
        }
        drag = null;
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", endDrag);
      }
      head.addEventListener("mousedown", function (e) {
        if (e.button !== 0 || (e.target.closest && e.target.closest("button"))) return;
        if (box.classList.contains("max")) return;     // 全屏状态下无需拖动
        var r = box.getBoundingClientRect();
        drag = { x: e.clientX - r.left, y: e.clientY - r.top };
        e.preventDefault();
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", endDrag);
      });
      function setMax(on) {
        box.classList.toggle("max", !!on);
        place();
        maxBtn.title = on ? "还原" : "全屏";
        maxBtn.innerHTML = '<i class="bi ' + (on ? "bi-arrows-angle-contract" : "bi-fullscreen") + '"></i>';
        var p = {}; p[name + "Max"] = !!on; dbcSaveState(conn.id, p);
      }
      maxBtn.onclick = function () { setMax(!box.classList.contains("max")); };
      if (saved[name + "Max"]) setMax(true); else place();   // 还原上次的全屏 / 位置
      return { setMax: setMax, place: place, clamp: clamp };
    }

    var sqlToggle = tab.host.querySelector(".dbc-sql-toggle");
    var sqlMaxBtn = tab.host.querySelector(".dbc-sql-max");
    var sqlCard = makeCard(sqlBox, tab.host.querySelector(".dbc-sql-head"), sqlMaxBtn, "sql");
    var sqlMaxClick = sqlMaxBtn.onclick;            // 全屏切换后把焦点还给编辑框
    sqlMaxBtn.onclick = function () { sqlMaxClick(); sqlIn.focus(); };

    function setSqlPanel(show) {
      sqlBox.hidden = !show;
      sqlToggle.classList.toggle("on", show);
      if (show) { sqlCard.clamp(); sqlIn.focus(); }
      dbcSaveState(conn.id, { sqlOpen: !!show });
    }

    // ---- 行详情：点数据表格任意一行，把这行的所有字段完整列出来（各数据库通用）；
    //      有主键的行还能直接改字段并写回数据库 ----
    var rowBox = tab.host.querySelector(".dbc-row");
    var rowBody = tab.host.querySelector(".dbc-row-body");
    var rowInfo = tab.host.querySelector(".dbc-row-info");
    var rowEditBtn = tab.host.querySelector(".dbc-row-edit");
    var rowSaveBtn = tab.host.querySelector(".dbc-row-save");
    var rowCancelBtn = tab.host.querySelector(".dbc-row-cancel");
    var rowCard = makeCard(rowBox, tab.host.querySelector(".dbc-row .dbc-sql-head"),
                           tab.host.querySelector(".dbc-row-max"), "row");
    var curRow = null;

    function setRowPanel(show) {
      rowBox.hidden = !show;
      if (show) rowCard.clamp();
    }
    // 每行都能定位到原始值（data-v），编辑时据此判断哪些字段真的改了
    function rowTableHtml(cols, rec) {
      return '<table class="dbc-row-tb"><thead><tr><th>字段</th><th>值</th></tr></thead><tbody>' +
        cols.map(function (c, i) {
          var v = rec[i], isNull = (v === null || v === undefined);
          var txt = isNull ? "NULL" : String(v);
          return '<tr><td class="dbc-row-k">' + esc(c) + '</td><td class="dbc-row-v"' +
            (isNull ? ' data-null="1"' : "") + ' data-v="' + escAttr(txt) + '">' +
            (isNull ? '<span class="dbc-null">NULL</span>' : esc(txt)) + "</td></tr>";
        }).join("") + "</tbody></table>";
    }
    // 能不能编辑：必须有主键（MongoDB 是 _id），且主键值都在这一行里
    function canEditRow(cols, rec) {
      var pk = lastGrid.pk || [];
      if (!pk.length) return false;
      for (var i = 0; i < pk.length; i++) {
        var idx = cols.indexOf(pk[i]);
        if (idx < 0 || rec[idx] === null || rec[idx] === undefined) return false;
      }
      return true;
    }
    function setEditMode(on) {
      rowBox.classList.toggle("editing", !!on);
      rowEditBtn.hidden = !!on;
      rowSaveBtn.hidden = !on;
      rowCancelBtn.hidden = !on;
    }
    function openRow(idx) {
      var cols = lastGrid.cols, rec = lastGrid.rows[idx];
      if (!cols.length || !rec) return;
      curRow = { cols: cols, rec: rec, idx: idx };
      setEditMode(false);
      rowBody.innerHTML = rowTableHtml(cols, rec);
      rowBody.scrollTop = 0;
      var can = canEditRow(cols, rec);
      rowEditBtn.hidden = !can;
      rowInfo.textContent = (state.table ? state.table + " · " : "") + "第 " + (idx + 1) + " 行 · " +
        cols.length + " 个字段" + (can ? "" : "（缺主键，不可编辑）");
      setRowPanel(true);
    }
    gridBox.addEventListener("click", function (e) {
      var tr = e.target && e.target.closest ? e.target.closest("tr") : null;
      if (!tr || !tr.parentNode || tr.parentNode.tagName !== "TBODY") return;   // 表头 / 空数据行不算
      var kids = tr.parentNode.children;
      var idx = Array.prototype.indexOf.call(kids, tr);
      if (idx < 0 || !lastGrid.rows[idx]) return;
      Array.prototype.forEach.call(kids, function (r) { r.classList.toggle("on", r === tr); });
      openRow(idx);
    });
    // 进入编辑：值单元格换成输入框（原值放 data-v 里比对）
    rowEditBtn.onclick = function () {
      if (!curRow) return;
      Array.prototype.forEach.call(rowBody.querySelectorAll(".dbc-row-v"), function (td) {
        var wasNull = td.getAttribute("data-null") === "1";
        var ta = document.createElement("textarea");
        ta.className = "dbc-row-in";
        ta.rows = 1;
        ta.spellcheck = false;
        ta.value = wasNull ? "" : (td.getAttribute("data-v") || "");
        if (wasNull) ta.placeholder = "NULL（留空不修改）";
        td.textContent = "";
        td.appendChild(ta);
      });
      setEditMode(true);
      rowInfo.textContent = "编辑中 · 改完点「保存」会直接写入数据库（空串会写成空字符串，NULL 留空即不改动）";
      var first = rowBody.querySelector(".dbc-row-in");
      if (first) first.focus();
    };
    rowCancelBtn.onclick = function () {
      if (!curRow) return;
      setEditMode(false);
      rowBody.innerHTML = rowTableHtml(curRow.cols, curRow.rec);
      rowInfo.textContent = (state.table ? state.table + " · " : "") + "第 " + (curRow.idx + 1) + " 行";
    };
    rowSaveBtn.onclick = async function () {
      if (!curRow || !canEditRow(curRow.cols, curRow.rec)) return;
      var ins = Array.prototype.slice.call(rowBody.querySelectorAll(".dbc-row-in"));
      var changes = {}, key = {}, n = 0;
      curRow.cols.forEach(function (c, i) {
        var before = curRow.rec[i];
        var wasNull = (before === null || before === undefined);
        var after = ins[i] ? ins[i].value : (wasNull ? "" : String(before));
        if (wasNull && after === "") return;                     // 原本 NULL、没填 → 不动
        if (!wasNull && after === String(before)) return;        // 没改 → 不动
        changes[c] = after;
        n++;
      });
      if (!n) { rowInfo.textContent = "没有检测到改动"; return; }
      (lastGrid.pk || []).forEach(function (c) { key[c] = curRow.rec[curRow.cols.indexOf(c)]; });
      var ok = await uiConfirm("保存修改",
        "将把 " + n + " 处改动写入「" + (state.table || "") + "」，会直接作用于数据库，确定继续？",
        "保存", true);
      if (!ok) return;
      rowSaveBtn.disabled = true;
      try {
        var d = await dbcApi("/api/db/row/update", { method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ conn: conn.id, dbname: state.db, schema: state.schema,
                                 table: state.table, key: key, changes: changes }) });
        // 本地基线同步成新值，表格里对应单元格也一起更新（不重新拉数据，避免打乱面板）
        var tr = gridBox.querySelectorAll("tbody tr")[curRow.idx];
        Object.keys(changes).forEach(function (c) {
          var i = curRow.cols.indexOf(c);
          curRow.rec[i] = changes[c];
          if (lastGrid.rows[curRow.idx]) lastGrid.rows[curRow.idx][i] = changes[c];
          var td = tr && tr.children[i];
          if (td) { td.classList.remove("dbc-null"); td.textContent = changes[c]; }
        });
        setEditMode(false);
        rowBody.innerHTML = rowTableHtml(curRow.cols, curRow.rec);
        rowInfo.textContent = "已保存 " + n + " 处改动（影响 " + (d.updated || 0) + " 行）";
        toast("已保存 " + n + " 处改动", "ok");
      } catch (e) {
        rowInfo.textContent = e.message || String(e);
      } finally { rowSaveBtn.disabled = false; }
    };
    tab.host.querySelector(".dbc-row-close").onclick = function () { setRowPanel(false); };
    tab.host.querySelector(".dbc-row-copy").onclick = function () {
      if (!curRow) return;
      var obj = {};
      curRow.cols.forEach(function (c, i) { obj[c] = (curRow.rec[i] === undefined ? null : curRow.rec[i]); });
      copyText(JSON.stringify(obj, null, 2));
    };

    dbSel.onchange = function () {
      state.db = dbSel.value; state.table = ""; state.schema = "";
      dbcSaveState(conn.id, { db: state.db, table: "", schema: "" });
      loadSchema();
    };
    tab.host.querySelector(".dbc-refresh").onclick = function () {
      if (state.table) { loadRows(state.offset); } else { loadSchema(); }
    };
    sqlToggle.onclick = function () { setSqlPanel(sqlBox.hidden); };
    tab.host.querySelector(".dbc-sql-close").onclick = function () { setSqlPanel(false); };
    tab.host.querySelector(".dbc-sql-clear").onclick = function () {
      sqlIn.value = "";
      sqlMsg.textContent = ""; sqlMsg.className = "dbc-sql-msg";
      dbcSaveState(conn.id, { sql: "" });
      sqlIn.focus();
    };
    tab.host.querySelector(".dbc-sql-run").onclick = runQuery;
    sqlIn.addEventListener("keydown", function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); runQuery(); }
    });
    // 输入停顿即落盘 SQL 文本，刷新后不丢
    var sqlSaveTimer = null;
    sqlIn.addEventListener("input", function () {
      clearTimeout(sqlSaveTimer);
      sqlSaveTimer = setTimeout(function () { dbcSaveState(conn.id, { sql: sqlIn.value }); }, 400);
    });
    aiRun.onclick = genSql;
    aiInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); genSql(); }
    });
    // 还原上次的 SQL 文本与悬浮窗开合状态（位置 / 全屏已由 makeCard 还原），再加载结构
    //（结构会按记录还原选中的库 / 表）
    if (saved.sql) sqlIn.value = saved.sql;
    if (saved.sqlOpen) setSqlPanel(true);   // 显示时再夹一次边界，适配当前窗口尺寸
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

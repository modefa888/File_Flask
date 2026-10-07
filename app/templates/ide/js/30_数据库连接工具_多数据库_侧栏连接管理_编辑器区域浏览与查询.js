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
            '<button class="dbc-mini dbc-new-table" title="新建表 / 集合 / Key"><i class="bi bi-file-plus"></i></button>' +
            '<button class="dbc-mini dbc-refresh" title="刷新结构与数据"><i class="bi bi-arrow-clockwise"></i></button>' +
          "</div>" +
          '<div class="dbc-tabs-sel">表 / 视图</div>' +
          '<div class="dbc-tables scroll-thin"></div>' +
        "</div>" +
        '<div class="dbc-main">' +
          '<div class="dbc-bar">' +
            '<span class="dbc-cur" title="当前表">—</span>' +
            '<button class="dbc-mini dbc-cur-edit" title="编辑表结构" hidden>' +
              '<i class="bi bi-pencil"></i></button>' +
            '<span class="dbc-sp"></span>' +
            '<button class="dbc-mini dbc-add-row" title="在当前表 / 集合里新增一行"><i class="bi bi-plus-lg"></i> 新增行</button>' +
            '<button class="dbc-mini dbc-undo" title="查看最近写操作，可选择性回撤（表级操作不可回撤）"><i class="bi bi-arrow-counterclockwise"></i> 回撤<span class="dbc-undo-n"></span></button>' +
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
              '<button class="dbc-mini dbc-row-del"><i class="bi bi-trash3"></i> 假删除</button>' +
              '<button class="dbc-mini dbc-row-edit"><i class="bi bi-pencil"></i> 编辑</button>' +
              '<button class="dbc-mini dbc-row-save" hidden><i class="bi bi-check-lg"></i> 保存</button>' +
              '<button class="dbc-mini dbc-row-cancel" hidden>取消</button>' +
              '<button class="dbc-mini dbc-row-fake" hidden title="按表结构随机造数（纯规则，不调用 AI）">' +
                '<i class="bi bi-shuffle"></i> 随机数据</button>' +
              '<button class="dbc-mini dbc-row-copy"><i class="bi bi-clipboard"></i> 复制 JSON</button></div>' +
          "</div>" +
        "</div>" +
      "</div>";

    var saved = dbcLoadState(conn.id);        // 上次的浏览状态（刷新后还原）
    var state = { db: saved.db || conn.dbname || "", table: saved.table || "",
                  schema: saved.schema || "", limit: saved.limit || 100, offset: 0,
                  total: null, seq: 0, kind: conn.kind, includeDeleted: false };
    tab.dbcState = state;

    var dbSel = tab.host.querySelector(".dbc-db-sel");
    var tabsBox = tab.host.querySelector(".dbc-tables");
    var gridBox = tab.host.querySelector(".dbc-grid-wrap");
    var pagerEl = tab.host.querySelector(".dbc-pager");
    var curEl = tab.host.querySelector(".dbc-cur");
    var curEditEl = tab.host.querySelector(".dbc-cur-edit");
    /* 当前表名旁边的笔：SQL 库开表结构设计弹窗，MongoDB 看集合字段；
       Redis 没有结构概念、视图不能改结构，这两种情况直接藏起来 */
    function curIsView() {
      var hit = null;
      tabsBox.querySelectorAll(".dbc-table").forEach(function (x) {
        if (!hit && x.dataset.name === state.table) hit = x;
      });
      return !!(hit && String(hit.dataset.kind || "").toLowerCase().indexOf("view") >= 0);
    }
    function setCur(label, editable) {
      curEl.textContent = label;
      var can = !!editable && !!state.table && !isRedis && !curIsView();
      curEditEl.hidden = !can;
      if (can) {
        curEditEl.title = isMongo ? "查看集合字段（采样首条文档）"
                                  : "编辑表结构（加列 / 改列 / 删列 / 重命名）";
      }
    }
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

    function isSoftDeleted(row) {
      var sc = lastGrid.softCol, sm = lastGrid.softMode;
      if (!sc) return false;
      var i = lastGrid.cols.indexOf(sc);
      if (i < 0) return false;
      var v = row[i];
      if (sm === "timestamp") return !(v === null || v === undefined || v === "");
      return v === 1 || v === true || v === "1";
    }
    function drawGrid(cols, rows, emptyText, opts) {
      lastGrid = { cols: (cols && cols.length) ? cols : [], rows: rows || [] };   // 供「行详情」取用
      if (!cols || !cols.length) return '<div class="dbc-empty">' + esc(emptyText || "没有数据") + "</div>";
      var actions = !!(opts && opts.actions);
      var head = (actions ? "<th class=\"dbc-ract-h\"></th>" : "") +
                 cols.map(function (c) { return "<th>" + esc(c) + "</th>"; }).join("");
      var body = rows.length
        ? rows.map(function (r, ri) {
            var act = "";
            if (actions) {
              act = isSoftDeleted(r)
                ? '<button class="dbc-mini dbc-rrestore" title="恢复（取消假删除）"><i class="bi bi-arrow-counterclockwise"></i></button>'
                : '<button class="dbc-mini dbc-rdel" title="假删除这一行"><i class="bi bi-trash3"></i></button>';
              act = '<td class="dbc-ract">' + act + "</td>";
            }
            var cls = isSoftDeleted(r) ? ' class="dbc-del"' : "";
            return "<tr data-ri=\"" + ri + "\"" + cls + ">" + act + r.map(function (v) {
              if (v === null || v === undefined) return '<td class="dbc-null">NULL</td>';
              return "<td>" + esc(v) + "</td>";
            }).join("") + "</tr>";
          }).join("")
        : '<tr><td class="dbc-empty" colspan="' + (cols.length + (actions ? 1 : 0)) + '">没有数据</td></tr>';
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
                escAttr(t.schema || "") + '" data-kind="' + escAttr(t.kind || "") +
                '" title="' + escAttr(t.name) + '">' +
                '<i class="bi ' + (String(t.kind).toLowerCase().indexOf("view") >= 0 ? "bi-eye" : "bi-table") + '"></i>' +
                '<span class="dbc-tn">' + esc(t.name) + "</span>" +
                '<span class="dbc-tc">' + (t.rows === null || t.rows === undefined ? "" : t.rows) + "</span>" +
                '<button class="dbc-to" title="更多操作（新建 / 表结构 / 重命名 / 清空 / 删除）"><i class="bi bi-three-dots"></i></button>' +
                "</div>";
            }).join("")
          : '<div class="dbc-empty">' + (isRedis ? "这个库里没有 key" : (isMongo ? "这个库里没有集合" : "这个库里没有表")) +
            "<br>点左上角「＋」新建</div>";
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
          // 表 / 集合操作：悬停出现的「⋯」或右键
          it.querySelector(".dbc-to").onclick = function (e) {
            e.stopPropagation();
            tableMenu(it.dataset.name, it.dataset.schema, e.currentTarget);
          };
          it.oncontextmenu = function (e) {
            e.preventDefault();
            tableMenu(it.dataset.name, it.dataset.schema, it);
          };
        });
        // 优先还原上次选中的表；该表不存在（或没记录）时退回第一张
        var pick = null;
        tabsBox.querySelectorAll(".dbc-table").forEach(function (it) {
          if (!pick && state.table && it.dataset.name === state.table) pick = it;
        });
        var target = pick || tabsBox.querySelector(".dbc-table");
        if (target) target.onclick();
        else {
          setCur("—", false);
          gridBox.innerHTML = '<div class="dbc-empty">选择左侧的表查看数据</div>';
          pagerEl.innerHTML = "";
        }
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
      setCur(state.table, true);
      try {
        var d = await dbcApi("/api/db/rows?conn=" + encodeURIComponent(conn.id) +
                             "&dbname=" + encodeURIComponent(state.db) +
                             "&schema=" + encodeURIComponent(state.schema) +
                             "&table=" + encodeURIComponent(state.table) +
                             "&limit=" + state.limit + "&offset=" + (offset || 0) +
                             (state.includeDeleted ? "&include_deleted=1" : ""));
        if (seq !== state.seq) return;                    // 快速切换时丢弃过期结果
        state.offset = d.offset || 0;
        state.total = d.total;
        lastGrid.softCol = d.soft_col || null;
        lastGrid.softMode = d.soft_mode || null;
        gridBox.innerHTML = drawGrid(d.columns, d.rows, "表里没有数据",
                                      { actions: state.kind !== "redis" });
        lastGrid.pk = d.pk || [];            // 主键（编辑行时用来定位）
        var from = d.rows.length ? state.offset + 1 : 0;
        var to = state.offset + d.rows.length;
        var softBtn = lastGrid.softCol
          ? '<button class="dbc-mini dbc-toggle-del' + (state.includeDeleted ? " on" : "") + '" title="切换是否显示已逻辑删除的行">'
            + (state.includeDeleted ? "隐藏已删除" : "显示已删除") + "</button>"
          : "";
        pagerEl.innerHTML =
          softBtn +
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
        var sbtn = pagerEl.querySelector(".dbc-toggle-del");
        if (sbtn) sbtn.onclick = function () { state.includeDeleted = !state.includeDeleted; loadRows(0); };
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
      setCur("查询结果", false);         // 结果未必来自当前表，笔先收起来
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
    var rowDelBtn = tab.host.querySelector(".dbc-row-del");
    var rowSaveBtn = tab.host.querySelector(".dbc-row-save");
    var rowCancelBtn = tab.host.querySelector(".dbc-row-cancel");
    var rowTitleEl = tab.host.querySelector(".dbc-row .dbc-sql-title");
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
    // 面板三种模式：view（只读）/ edit（改这一行）/ insert（新增一行）
    var rowMode = "view";
    function setRowMode(mode) {
      rowMode = mode;
      rowBox.classList.toggle("editing", mode !== "view");
      rowEditBtn.hidden = (mode !== "view");
      rowDelBtn.hidden = (mode !== "view");
      rowSaveBtn.hidden = (mode === "view");
      rowCancelBtn.hidden = (mode === "view");
      // 随机造数只在「新增行」里有意义：Redis / MongoDB 没有可依的列类型，直接不给入口
      fakeBtn.hidden = (mode !== "insert") || conn.kind === "redis" || conn.kind === "mongodb";
      rowTitleEl.innerHTML = '<i class="bi ' + (mode === "insert" ? "bi-plus-square" : "bi-list-columns-reverse") +
        '"></i>' + (mode === "insert" ? "新增行" : "行详情");
    }
    function openRow(idx) {
      var cols = lastGrid.cols, rec = lastGrid.rows[idx];
      if (!cols.length || !rec) return;
      curRow = { cols: cols, rec: rec, idx: idx };
      setRowMode("view");
      rowBody.innerHTML = rowTableHtml(cols, rec);
      rowBody.scrollTop = 0;
      var can = canEditRow(cols, rec);
      rowEditBtn.hidden = rowDelBtn.hidden = !can;
      rowInfo.textContent = (state.table ? state.table + " · " : "") + "第 " + (idx + 1) + " 行 · " +
        cols.length + " 个字段" + (can ? "" : "（缺主键，不可改 / 删）");
      setRowPanel(true);
    }
    gridBox.addEventListener("click", function (e) {
      var actBtn = e.target.closest ? e.target.closest(".dbc-rdel, .dbc-rrestore") : null;
      if (actBtn) {                                   // 操作列：假删除 / 恢复，不触发行详情
        e.stopPropagation();
        var tr = actBtn.closest("tr");
        var ri = tr ? parseInt(tr.getAttribute("data-ri"), 10) : -1;
        if (ri < 0 || !lastGrid.rows[ri]) return;
        if (actBtn.classList.contains("dbc-rrestore")) softDelRow(ri, true);
        else softDelRow(ri, false);
        return;
      }
      var tr = e.target && e.target.closest ? e.target.closest("tr") : null;
      if (!tr || !tr.parentNode || tr.parentNode.tagName !== "TBODY") return;   // 表头 / 空数据行不算
      var kids = tr.parentNode.children;
      var idx = Array.prototype.indexOf.call(kids, tr);
      if (idx < 0 || !lastGrid.rows[idx]) return;
      Array.prototype.forEach.call(kids, function (r) { r.classList.toggle("on", r === tr); });
      openRow(idx);
    });
    // 新增行：按当前列渲染一组空输入框（留空的字段不写入）
    function openInsert() {
      if (!state.table) { toast("请先在左侧选一张表 / 集合", "warn"); return; }
      if (!lastGrid.cols.length) { toast("请先选中一张表读到字段列表", "warn"); return; }
      curRow = null;
      setRowMode("insert");
      rowBody.innerHTML = '<table class="dbc-row-tb"><thead><tr><th>字段</th><th>值</th></tr></thead><tbody>' +
        lastGrid.cols.map(function (c) {
          return '<tr><td class="dbc-row-k">' + esc(c) + "</td><td>" +
            '<textarea class="dbc-row-in" rows="1" spellcheck="false" placeholder="留空则不写入该字段"></textarea>' +
            "</td></tr>";
        }).join("") + "</tbody></table>";
      rowBody.scrollTop = 0;
      rowInfo.textContent = "新增到「" + state.table + "」· 留空的字段不写入 · 保存后可用「回撤」撤销";
      rowInfo.title = "";
      setRowPanel(true);
      var first = rowBody.querySelector(".dbc-row-in");
      if (first) first.focus();
    }
    // 列表里点图标：逻辑删除（假删除）/ 恢复（取消标记）；写库并记一条可回撤的日志
    async function softDelRow(ri, restore) {
      var rec = lastGrid.rows[ri];
      var pk = lastGrid.pk || [];
      if (!pk.length) { toast("该表没有主键，无法定位这一行做假删除", "warn"); return; }
      var key = {};
      for (var i = 0; i < pk.length; i++) {
        var idx = lastGrid.cols.indexOf(pk[i]);
        key[pk[i]] = rec[idx];
      }
      var ok = await uiConfirm(restore ? "恢复这一行" : "假删除这一行",
        "将把「" + (state.table || "") + "」第 " + (ri + 1) + " 行标记为" +
        (restore ? "未删除（可回撤）" : "已删除，列表默认隐藏（可回撤）") + "，确定继续？",
        restore ? "恢复" : "假删除", true);
      if (!ok) return;
      try {
        await dbcApi("/api/db/row/soft-delete", { method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ conn: conn.id, dbname: state.db, schema: state.schema,
                                 table: state.table, key: key, restore: !!restore }) });
        toast((restore ? "已恢复 1 行" : "已假删除 1 行（可回撤）"), "ok");
        loadRows(state.offset);
        refreshUndo();
      } catch (e) { toast(e.message || String(e), "err"); }
    }
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
      setRowMode("edit");
      rowInfo.textContent = "编辑中 · 改完点「保存」会直接写入数据库（空串会写成空字符串，NULL 留空即不改动）";
      rowInfo.title = "";
      var first = rowBody.querySelector(".dbc-row-in");
      if (first) first.focus();
    };
    rowCancelBtn.onclick = function () {
      if (rowMode === "view") return;
      if (rowMode === "insert" || !curRow) { setRowPanel(false); return; }
      setRowMode("view");
      rowBody.innerHTML = rowTableHtml(curRow.cols, curRow.rec);
      rowInfo.textContent = (state.table ? state.table + " · " : "") + "第 " + (curRow.idx + 1) + " 行";
    };
    /* ---- 随机数据：后端按「列名语义 + 列类型」纯规则造数（不调用 AI）----
       「填充表单」只填不写库，人还能改；「插入 N 行」批量写入，整体只记 1 条回撤 ---- */
    var fakeBtn = tab.host.querySelector(".dbc-row-fake");
    var fakePz = null, fakeBusy = false;
    function fakeClose() {
      if (fakePz && fakePz.parentNode) fakePz.parentNode.removeChild(fakePz);
      fakePz = null;
      document.removeEventListener("mousedown", fakeOutside, true);
    }
    function fakeOutside(e) {
      if (!fakePz) return;
      if (fakePz.contains(e.target) || (fakeBtn && fakeBtn.contains(e.target))) return;
      fakeClose();
    }
    function fakeMenu() {
      fakeClose();
      var items = [
        { fill: 1, text: "填充表单 · 1 行（先不写库，可改完再点保存）" },
        { head: "直接写入数据库（记 1 条回撤）" },
        { n: 5, text: "插入 5 行" }, { n: 10, text: "插入 10 行" },
        { n: 20, text: "插入 20 行" }, { n: 50, text: "插入 50 行" },
      ];
      var p = document.createElement("div");
      p.className = "dbc-pz";
      p.innerHTML = items.map(function (x, i) {
        return x.head ? '<div class="dbc-pz-h">' + esc(x.head) + "</div>"
                      : '<div class="dbc-pz-i" data-i="' + i + '">' + esc(x.text) + "</div>";
      }).join("");
      document.body.appendChild(p);
      var r = fakeBtn.getBoundingClientRect(), w = p.offsetWidth, h = p.offsetHeight;
      var top = r.top - h - 4;                                  // 面板在窗口底部，默认往上弹
      if (top < 8) top = Math.min(window.innerHeight - h - 8, r.bottom + 4);
      p.style.left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8)) + "px";
      p.style.top = Math.max(8, top) + "px";
      Array.prototype.forEach.call(p.querySelectorAll(".dbc-pz-i"), function (el) {
        el.onclick = function () { var v = items[+el.dataset.i]; fakeClose(); fakeGen(v); };
      });
      fakePz = p;
      setTimeout(function () { document.addEventListener("mousedown", fakeOutside, true); }, 0);
    }
    async function fakeGen(item) {
      if (fakeBusy) return;
      fakeBusy = true;
      var count = item.fill || item.n;
      rowInfo.textContent = "正在按表结构生成 " + count + " 行随机数据…";
      rowInfo.title = "";
      try {
        var d = await dbcApi("/api/db/row/fake", { method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ conn: conn.id, dbname: state.db, schema: state.schema,
                                 table: state.table, count: count }) });
        var data = d.rows || [];
        if (!data.length) { rowInfo.textContent = "没有生成到可用数据"; return; }
        var skipped = d.skipped || [];
        var extra = skipped.length ? "（" + skipped.length + " 列不写入，悬浮查看）" : "";
        if (item.fill) {                                       // 只填表单，先不落库
          var ins = rowBody.querySelectorAll(".dbc-row-in");
          lastGrid.cols.forEach(function (c, i) {
            var v = data[0][c];
            if (ins[i]) ins[i].value = (v === null || v === undefined) ? "" : String(v);
          });
          rowInfo.textContent = "已填充 1 行随机数据" + extra + " · 可改完点「保存」";
          rowInfo.title = skipped.length ? "以下列不写入：" + skipped.join("、") : "";
          return;
        }
        var ok = await uiConfirm("插入 " + data.length + " 行随机数据",
          "将往「" + (state.table || "") + "」写入 " + data.length + " 行测试数据，确定继续？" +
          "（之后可用「回撤」整体撤销）", "插入", true);
        if (!ok) { rowInfo.textContent = ""; rowInfo.title = ""; return; }
        var res = await dbcApi("/api/db/row/insert-many", { method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ conn: conn.id, dbname: state.db, schema: state.schema,
                                 table: state.table, rows: data }) });
        toast("已插入 " + (res.inserted || data.length) + " 行随机数据" +
              (res.undoable ? "（可回撤）" : ""), "ok");
        setRowPanel(false);
        loadRows(state.offset);
        refreshUndo();
      } catch (e) {
        rowInfo.textContent = e.message || String(e);
      } finally { fakeBusy = false; }
    }
    fakeBtn.onclick = fakeMenu;

    async function saveRow() {
      var ins = Array.prototype.slice.call(rowBody.querySelectorAll(".dbc-row-in"));
      if (rowMode === "insert") {                              // ---- 新增
        var values = {};
        lastGrid.cols.forEach(function (c, i) {
          var v = ins[i] ? ins[i].value : "";
          if (v !== "") values[c] = v;                         // 留空 = 不写入该字段
        });
        if (!Object.keys(values).length) { rowInfo.textContent = "至少填一个字段"; return; }
        var okAdd = await uiConfirm("新增一行",
          "将往「" + (state.table || "") + "」插入 1 行（" + Object.keys(values).length + " 个字段），确定继续？",
          "新增", false);
        if (!okAdd) return;
        rowSaveBtn.disabled = true;
        try {
          await dbcApi("/api/db/row/insert", { method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ conn: conn.id, dbname: state.db, schema: state.schema,
                                   table: state.table, values: values }) });
          toast("已新增 1 行", "ok");
          setRowPanel(false);
          loadRows(state.offset);
          refreshUndo();
        } catch (e) { rowInfo.textContent = e.message || String(e); }
        finally { rowSaveBtn.disabled = false; }
        return;
      }
      // ---- 修改
      if (!curRow || !canEditRow(curRow.cols, curRow.rec)) return;
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
        setRowMode("view");
        rowBody.innerHTML = rowTableHtml(curRow.cols, curRow.rec);
        rowInfo.textContent = "已保存 " + n + " 处改动（影响 " + (d.updated || 0) + " 行）· 可「回撤」";
        toast("已保存 " + n + " 处改动", "ok");
        refreshUndo();
      } catch (e) {
        rowInfo.textContent = e.message || String(e);
      } finally { rowSaveBtn.disabled = false; }
    }
    rowSaveBtn.onclick = saveRow;
    // 假删除这一行（逻辑删除：标记软删除列，列表默认隐藏，可回撤还原）
    rowDelBtn.onclick = async function () {
      if (!curRow || !canEditRow(curRow.cols, curRow.rec)) return;
      var key = {};
      (lastGrid.pk || []).forEach(function (c) { key[c] = curRow.rec[curRow.cols.indexOf(c)]; });
      var ok = await uiConfirm("假删除这一行",
        "将把「" + (state.table || "") + "」第 " + (curRow.idx + 1) +
        " 行标记为已删除（数据库行仍在，列表默认隐藏，之后可用「回撤」恢复）",
        "假删除", true);
      if (!ok) return;
      try {
        await dbcApi("/api/db/row/soft-delete", { method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ conn: conn.id, dbname: state.db, schema: state.schema,
                                 table: state.table, key: key }) });
        toast("已假删除 1 行（可回撤）", "ok");
        setRowPanel(false);
        loadRows(state.offset);
        refreshUndo();
      } catch (e) { rowInfo.textContent = e.message || String(e); }
    };
    tab.host.querySelector(".dbc-add-row").onclick = openInsert;
    tab.host.querySelector(".dbc-row-close").onclick = function () { setRowPanel(false); };
    tab.host.querySelector(".dbc-row-copy").onclick = function () {
      if (!curRow) return;
      var obj = {};
      curRow.cols.forEach(function (c, i) { obj[c] = (curRow.rec[i] === undefined ? null : curRow.rec[i]); });
      copyText(JSON.stringify(obj, null, 2));
    };

    // ---- 回撤：点「回撤」展开最近写操作列表，可选择性回撤；表头保留「直接回撤最近一次」----
    var undoBtn = tab.host.querySelector(".dbc-undo");
    var undoN = tab.host.querySelector(".dbc-undo-n");
    var undoPz = null;
    var UNDO_OP = { insert: "新增", update: "修改", delete: "删除", truncate: "清空",
                    drop: "删除", create: "新建", hash: "哈希", rename: "重命名", soft_delete: "假删除" };
    function undoClose() {
      if (undoPz && undoPz.parentNode) undoPz.parentNode.removeChild(undoPz);
      undoPz = null;
      document.removeEventListener("mousedown", undoOutside, true);
    }
    function undoOutside(e) {
      if (!undoPz) return;
      if (undoPz.contains(e.target) || (undoBtn && undoBtn.contains(e.target))) return;
      undoClose();
    }
    function undoTime(ts) {                                   // 秒 → 今天显示 HH:MM:SS，跨天带日期
      var d = new Date((ts || 0) * 1000), n = new Date();
      var p = function (x) { return (x < 10 ? "0" : "") + x; };
      var hm = p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
      return (d.toDateString() === n.toDateString()) ? hm
             : (p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes()));
    }
    function refreshUndo() {
      dbcApi("/api/db/writes?conn=" + encodeURIComponent(conn.id)).then(function (d) {
        var n = d.undoable || 0;
        undoN.textContent = n ? " " + n : "";
        undoBtn.disabled = !n;
        undoBtn.title = n ? ("可回撤 " + n + " 步；最近：" + ((d.writes[0] || {}).summary || "") + "（点击查看列表）")
                          : "没有可回撤的操作（表级操作不可回撤）";
      }).catch(function () { /* 忽略 */ });
    }
    // 回撤某一条记录（w 来自 /api/db/writes）；成功返回 true
    async function doUndo(w) {
      var ok = await uiConfirm("回撤操作",
        "将撤销「" + (w.table || "") + " · " + (w.summary || "") + "」，把数据恢复成操作前的样子，确定继续？",
        "回撤", false);
      if (!ok) return false;
      try {
        var r = await dbcApi("/api/db/undo", { method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ conn: conn.id, id: w.id }) });
        toast("已回撤：" + (((r.undo || {}).summary) || ""), "ok");
        if (state.table) loadRows(state.offset);
        refreshUndo();
        return true;
      } catch (e) { toast(e.message || String(e), "err"); return false; }
    }
    async function undoMenu() {
      undoClose();
      var d = {};
      try { d = await dbcApi("/api/db/writes?conn=" + encodeURIComponent(conn.id)); } catch (e) { /* 忽略 */ }
      var ws = (d.writes || []).slice(0, 30);
      var first = ws.filter(function (w) { return w.undoable && !w.undone; })[0];
      var p = document.createElement("div");
      p.className = "dbc-undopz";
      p.innerHTML =
        '<div class="dbc-undopz-h"><span>最近写操作（可单独回撤）</span>' +
          '<button class="dbc-undopz-quick"' + (first ? "" : " disabled") + '>' +
            '<i class="bi bi-arrow-counterclockwise"></i> 直接回撤最近一次</button></div>' +
        '<div class="dbc-undopz-list scroll-thin">' +
        (ws.length ? ws.map(function (w, i) {
          var can = w.undoable && !w.undone;
          var tail = w.undone ? '<span class="dbc-undopz-s">已回撤</span>'
                   : (!w.undoable ? '<span class="dbc-undopz-s">不可回撤</span>'
                   : '<button class="dbc-mini dbc-undopz-go" data-i="' + i + '">回撤</button>');
          return '<div class="dbc-undopz-r' + (can ? "" : " off") + '">' +
            '<span class="dbc-undopz-op v-' + escAttr(w.op || "") + '">' +
              esc(UNDO_OP[w.op] || w.op || "") + "</span>" +
            '<span class="dbc-undopz-tx"><b>' + esc(w.table || "") + "</b> · " + esc(w.summary || "") + "</span>" +
            '<span class="dbc-undopz-t">' + esc(undoTime(w.created_at)) + "</span>" + tail + "</div>";
        }).join("") : '<div class="dbc-undopz-e">暂无写操作</div>') +
        "</div>";
      document.body.appendChild(p);
      var r = undoBtn.getBoundingClientRect(), w2 = p.offsetWidth, h = p.offsetHeight;
      var top = r.bottom + 4;                                  // 工具栏在顶部，默认往下弹
      if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 4);
      p.style.left = Math.max(8, Math.min(r.right - w2, window.innerWidth - w2 - 8)) + "px";
      p.style.top = Math.max(8, top) + "px";
      if (first) {
        p.querySelector(".dbc-undopz-quick").onclick = async function () {
          if (await doUndo(first)) undoClose();
        };
      }
      Array.prototype.forEach.call(p.querySelectorAll(".dbc-undopz-go"), function (el) {
        el.onclick = async function () {
          if (await doUndo(ws[+el.dataset.i])) undoClose();
        };
      });
      undoPz = p;
      setTimeout(function () { document.addEventListener("mousedown", undoOutside, true); }, 0);
    }
    undoBtn.onclick = function () { undoMenu(); };

    // ---- 表 / 集合 / key 操作：全部走 /api/db/table，按库类型给对应语义 ----
    var whatName = isRedis ? "key" : (isMongo ? "集合" : "表");
    function postTable(body) {
      return dbcApi("/api/db/table", { method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(Object.assign({ conn: conn.id, dbname: state.db }, body)) });
    }
    async function reloadSchema(keep) {
      if (!keep) state.table = "";
      await loadSchema();
    }

    /* 通用小表单弹窗：fields = [{key,label,placeholder,type,options,required}]，返回对象或 null */
    function dbcFormModal(title, fields, okText) {
      return new Promise(function (resolve) {
        var ov = $("modalOverlay");
        var box = document.createElement("div");
        box.className = "ide-modal dbc-modal";
        box.innerHTML =
          '<div class="m-title"><i class="bi bi-plus-square"></i><span>' + esc(title) + "</span></div>" +
          '<div class="m-body">' + fields.map(function (f) {
            if (f.type === "select") {
              return '<div class="dbc-row"><span class="dbc-lb">' + esc(f.label) + "</span>" +
                '<select class="dbc-in dbc-fm">' +
                (f.options || []).map(function (o) {
                  return '<option value="' + escAttr(o) + '"' + (o === f.value ? " selected" : "") + ">" +
                    esc(o) + "</option>";
                }).join("") + "</select></div>";
            }
            return '<div class="dbc-row"><span class="dbc-lb">' + esc(f.label) + "</span>" +
              '<input class="dbc-in dbc-fm" spellcheck="false" placeholder="' + escAttr(f.placeholder || "") +
              '" value="' + escAttr(f.value || "") + '"></div>';
          }).join("") + '<div class="dbc-msg"></div></div>' +
          '<div class="m-foot"><button class="m-cancel">取消</button><button class="m-ok">' +
          esc(okText || "确定") + "</button></div>";
        ov.innerHTML = "";
        ov.appendChild(box);
        ov.classList.add("show");
        var els = box.querySelectorAll(".dbc-fm");
        var msg = box.querySelector(".dbc-msg");
        function close(v) {
          ov.classList.remove("show"); ov.innerHTML = "";
          ov.onkeydown = null; ov.onmousedown = null;
          resolve(v);
        }
        box.querySelector(".m-cancel").onclick = function () { close(null); };
        box.querySelector(".m-ok").onclick = function () {
          var out = {};
          for (var i = 0; i < fields.length; i++) {
            var v = els[i] ? els[i].value.trim() : "";
            if (fields[i].required !== false && !v && fields[i].type !== "select") {
              msg.textContent = "请填写「" + fields[i].label + "」";
              return;
            }
            out[fields[i].key] = v;
          }
          close(out);
        };
        ov.onmousedown = function (e) { if (e.target === ov) close(null); };
        ov.onkeydown = function (e) { if (e.key === "Escape") { e.preventDefault(); close(null); } };
        if (els[0]) els[0].focus();
      });
    }

    function quoteCol(kind, n) {
      return kind === "mysql" ? "`" + String(n).replace(/`/g, "``") + "`"
                              : '"' + String(n).replace(/"/g, '""') + '"';
    }
    function colDef(row) {
      var s = String(row.type || "").trim();
      if (!row.nullable) s += " NOT NULL";
      if (row.def !== "" && row.def !== null && row.def !== undefined) s += " DEFAULT " + row.def;
      return s.replace(/\s+/g, " ").trim();
    }
    // MySQL 的 CHANGE / MODIFY 要重建完整定义，带上 extra（auto_increment、
    // on update CURRENT_TIMESTAMP 等），否则改列名 / 改类型时会把这些属性弄丢
    function colDefKeep(row) {
      var s = colDef(row);
      if (row.extra) s += " " + String(row.extra).trim();
      return s.replace(/\s+/g, " ").trim();
    }

    /* 表结构设计弹窗：
        · 新建表：逐列填写（列名 / 类型定义 / 可空 / 默认值），底部「添加列」继续加；
        · 已有表：直接改列名（= 重命名）、类型 / 可空 / 默认值（= 修改），或删除 / 新增列，
          点「保存」时与读到的原始结构做 diff，只执行真正变化的那些 ALTER。 */
    async function tableDesigner(tableName, sch) {
      var isNew = !tableName;
      var useSchema = sch || state.schema;
      var rows = [], orig = [];
      if (isNew) {
        var auto = conn.kind === "sqlite" ? "INTEGER PRIMARY KEY AUTOINCREMENT"
                 : conn.kind === "postgres" ? "SERIAL PRIMARY KEY"
                 : "INT PRIMARY KEY AUTO_INCREMENT";
        rows = [{ name: "id", type: auto, nullable: false, def: "", pk: true, old: false }];
      } else {
        try {
          var d = await dbcApi("/api/db/table/columns?conn=" + encodeURIComponent(conn.id) +
            "&dbname=" + encodeURIComponent(state.db) +
            "&schema=" + encodeURIComponent(useSchema) + "&table=" + encodeURIComponent(tableName));
          rows = (d.columns || []).map(function (c) {
            return { name: c.name, type: c.type || "", nullable: !!c.nullable,
                     def: (c.default === null || c.default === undefined) ? "" : String(c.default),
                     pk: !!c.pk, old: true };
          });
          orig = rows.slice();
        } catch (e) { toast(e.message || String(e), "err"); return; }
        if (!rows.length) { toast("没有读到这张表的列结构", "warn"); return; }
      }
      var ov = $("modalOverlay");
      var box = document.createElement("div");
      box.className = "ide-modal wide dbc-modal dbc-dz";
      box.innerHTML =
        '<div class="m-title"><i class="bi bi-table"></i><span>' +
          (isNew ? "新建表" : "表结构 · " + esc(tableName)) + "</span>" +
          '<span class="dbc-sp"></span>' +
          '<button class="dbc-mini dbc-dz-aibtn" title="用一句话描述，让 AI 推荐表名与列定义">' +
            '<i class="bi bi-stars"></i> AI 推荐表设计</button>' +
        "</div>" +
        '<div class="m-body">' +
          '<div class="dbc-dz-ai" hidden>' +
            '<div class="dbc-dz-air">' +
              '<input class="dbc-in dbc-dz-aiq" spellcheck="false" placeholder="' +
                escAttr(isNew ? "用一句话描述这张表要存什么，如：电商订单表，含用户、商品、金额、状态、下单时间"
                              : "描述要补充什么，如：加上物流单号、发货时间、售后状态") + '">' +
              '<button class="dbc-mini dbc-dz-aigo"><i class="bi bi-stars"></i> 生成</button>' +
              '<button class="dbc-mini dbc-dz-aix" title="收起"><i class="bi bi-x-lg"></i></button>' +
            "</div>" +
            '<div class="dbc-msg dbc-dz-aimsg"></div>' +
          "</div>" +
          '<div class="dbc-row"><span class="dbc-lb">表名</span>' +
            '<input class="dbc-in dbc-dz-name" spellcheck="false" value="' + escAttr(tableName || "") +
            '" placeholder="表名"></div>' +
          '<div class="dbc-dz-tb scroll-thin"><table class="dbc-dz-t"><thead><tr>' +
            "<th>列名</th><th>类型 / 定义</th><th>可空</th><th>默认值</th><th>主键</th><th></th>" +
          "</tr></thead><tbody></tbody></table></div>" +
          '<div class="dbc-dz-bar"><button class="dbc-mini dbc-dz-add">' +
            '<i class="bi bi-plus-lg"></i> 添加列</button><span class="dbc-sp"></span>' +
            '<span class="dbc-msg dbc-dz-msg"></span></div>' +
          (isNew ? "" : '<div class="dbc-tip"><i class="bi bi-info-circle"></i><span>改列名=重命名列；' +
            "改类型 / 可空 / 默认值=修改列；删除该行=删除列。表结构变更不可回撤。</span></div>") +
        "</div>" +
        '<div class="m-foot"><button class="m-cancel">取消</button><button class="m-ok">保存</button></div>';
      ov.innerHTML = "";
      ov.appendChild(box);
      ov.classList.add("show");
      var nameIn = box.querySelector(".dbc-dz-name");
      var tbody = box.querySelector(".dbc-dz-t tbody");
      var msg = box.querySelector(".dbc-dz-msg");
      var okBtn = box.querySelector(".m-ok");
      function say(t) { msg.textContent = t || ""; }

      /* ---- AI 推荐表设计：一句话 → 一份列定义（+ 表名）。
         结果只填进表单，落库仍然要点「保存」，所以模型给得不对也只是表单不对，取消即可。 */
      var aiBox = box.querySelector(".dbc-dz-ai");
      var aiBtn = box.querySelector(".dbc-dz-aibtn");
      var aiQ = box.querySelector(".dbc-dz-aiq");
      var aiGo = box.querySelector(".dbc-dz-aigo");
      var aiMsg = box.querySelector(".dbc-dz-aimsg");
      var aiBusy = false;
      function aiSay(t, isErr) {
        say("");
        aiMsg.className = "dbc-msg dbc-dz-aimsg" + (isErr ? " err" : "");
        aiMsg.textContent = t || "";
      }
      // 该功能在「设置 → 系统 AI」里被停用时，按钮直接不出现（后端也会拒绝调用）
      if (typeof sysAiOff === "function" && sysAiOff("tabledesign")) aiBtn.hidden = true;
      function aiToggle(on) {
        aiBox.hidden = (on === undefined) ? !aiBox.hidden : !on;
        if (!aiBox.hidden) aiQ.focus();
      }
      function setAiBusy(on) {
        aiBusy = on;
        aiGo.disabled = on; aiQ.disabled = on; aiBtn.disabled = on;
        aiGo.innerHTML = '<i class="bi ' + (on ? "bi-arrow-repeat" : "bi-stars") + '"></i> ' +
          (on ? "生成中…" : "生成");
      }
      /* 把 AI 的列合并进当前表单：
         · 新建表：整表替换（AI 本来就是来设计整张表的），表名还空着就一并填上；
         · 已有表：只补「库里还没有的列」，已有列一律不动 —— 改列在 SQLite 上不支持，
           而且按位置比对很容易把新列误判成重命名，交给用户自己决定更稳。 */
      async function applyAi(d) {
        var cols = d.columns || [];
        if (!cols.length) { aiSay("AI 没有给出可用的列", true); return; }
        if (isNew) {
          var trs = tbody.querySelectorAll("tr");
          var auto = conn.kind === "sqlite" ? "INTEGER PRIMARY KEY AUTOINCREMENT"
                   : conn.kind === "postgres" ? "SERIAL PRIMARY KEY" : "INT PRIMARY KEY AUTO_INCREMENT";
          var untouched = trs.length === 1 &&
            trs[0].querySelector(".dbc-dz-n").value.trim() === "id" &&
            trs[0].querySelector(".dbc-dz-tp").value.trim() === auto;
          if (!untouched) {
            var okGo = await uiConfirm("应用 AI 建议",
              "将用 AI 建议的 " + cols.length + " 列覆盖当前表单里填的内容（只是填表，还没保存，取消不影响数据库），确定？",
              "覆盖", false);
            if (!okGo) return;
          }
          rows = cols.map(function (c) {
            return { name: c.name, type: c.type, nullable: !!c.nullable,
                     def: c.default || "", pk: !!c.pk, old: false };
          });
          if (d.table && !nameIn.value.trim()) nameIn.value = d.table;
          render();
          aiSay("已按 AI 建议填充 " + rows.length + " 列" + (d.note ? "：" + d.note : "") + " · 确认后点「保存」");
          return;
        }
        var have = {};
        rows.forEach(function (r) { if (r.name) have[String(r.name).toLowerCase()] = 1; });
        var added = [];
        cols.forEach(function (c) {
          var k = String(c.name).toLowerCase();
          if (have[k]) return;                     // 已有列不动
          have[k] = 1;
          rows.push({ name: c.name, type: c.type, nullable: !!c.nullable,
                      def: c.default || "", pk: false, old: false });
          added.push(c.name);
        });
        if (!added.length) { aiSay("没有需要补充的新列，这张表已经覆盖了 AI 的建议"); return; }
        render();
        aiSay("已建议补充 " + added.length + " 列：" + added.join("、") +
              "（原有列保持不变）· 确认后点「保存」");
      }
      async function aiGen() {
        if (aiBusy) return;
        var q = aiQ.value.trim();
        if (!q) { aiSay("请先用一句话描述这张表要存什么", true); aiQ.focus(); return; }
        setAiBusy(true);
        aiSay("正在让 AI 设计「" + (isNew ? (nameIn.value.trim() || "新表") : tableName) + "」…");
        try {
          var d = await dbcApi("/api/db/table/ai-design", { method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ conn: conn.id, dbname: state.db, schema: useSchema,
                                   table: isNew ? "" : tableName, question: q }) });
          await applyAi(d);
        } catch (e) {
          aiSay(e.message || String(e), true);
        } finally { setAiBusy(false); }
      }
      aiBtn.onclick = function () { aiToggle(); };
      box.querySelector(".dbc-dz-aix").onclick = function () { aiToggle(false); };
      aiGo.onclick = aiGen;
      aiQ.onkeydown = function (e) { if (e.key === "Enter") { e.preventDefault(); aiGen(); } };

      /* ---- 常用定义预设：点列上的「▾」直接挑一个，也能继续手写 ---- */
      function typePresets() {
        if (conn.kind === "mysql") return [
          { label: "主键 / 自增" },
          "INT PRIMARY KEY AUTO_INCREMENT", "BIGINT PRIMARY KEY AUTO_INCREMENT",
          { label: "整数 / 布尔" },
          "INT", "INT NOT NULL DEFAULT 0", "BIGINT", "SMALLINT", "TINYINT(1) DEFAULT 0",
          { label: "字符串" },
          "VARCHAR(50)", "VARCHAR(255)", "VARCHAR(255) NOT NULL DEFAULT ''", "TEXT", "LONGTEXT",
          "CHAR(36)",
          { label: "数值" },
          "DECIMAL(10,2)", "DOUBLE", "FLOAT",
          { label: "时间" },
          "DATETIME DEFAULT CURRENT_TIMESTAMP", "TIMESTAMP DEFAULT CURRENT_TIMESTAMP",
          "TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP", "DATE", "TIME",
          { label: "其他" },
          "JSON", "BLOB", "ENUM('a','b')",
        ];
        if (conn.kind === "postgres") return [
          { label: "主键 / 自增" },
          "SERIAL PRIMARY KEY", "BIGSERIAL PRIMARY KEY", "uuid PRIMARY KEY DEFAULT gen_random_uuid()",
          { label: "整数 / 布尔" },
          "integer", "integer NOT NULL DEFAULT 0", "bigint", "smallint", "boolean DEFAULT false",
          { label: "字符串" },
          "varchar(50)", "varchar(255)", "varchar(255) NOT NULL DEFAULT ''", "text", "char(36)",
          { label: "数值" },
          "numeric(10,2)", "double precision", "real",
          { label: "时间" },
          "timestamp DEFAULT now()", "timestamptz DEFAULT now()", "date", "time",
          { label: "其他" },
          "jsonb", "json", "bytea",
        ];
        return [
          { label: "主键 / 自增" },
          "INTEGER PRIMARY KEY AUTOINCREMENT",
          { label: "整数 / 布尔" },
          "INTEGER", "INTEGER NOT NULL", "INTEGER NOT NULL DEFAULT 0", "BIGINT", "BOOLEAN DEFAULT 0",
          { label: "字符串" },
          "TEXT", "TEXT NOT NULL", "VARCHAR(255)", "VARCHAR(50) NOT NULL DEFAULT ''",
          { label: "数值 / 时间 / 其他" },
          "REAL", "NUMERIC", "DECIMAL(10,2)", "DATETIME DEFAULT CURRENT_TIMESTAMP", "DATE", "BLOB",
        ];
      }
      function defaultPresets() {
        if (conn.kind === "postgres") return ["now()", "CURRENT_TIMESTAMP", "CURRENT_DATE",
                                              "true", "false", "0", "''", "NULL"];
        if (conn.kind === "mysql") return ["CURRENT_TIMESTAMP", "CURRENT_DATE", "0", "1", "''", "NULL"];
        return ["CURRENT_TIMESTAMP", "0", "1", "''", "NULL"];
      }
      /* 挑完类型后把「NOT NULL / DEFAULT ?」拆到对应的勾选框和输入框里，
         避免和 colDef() 再拼一次造成 `INT NOT NULL DEFAULT 0 DEFAULT 0` 这种重复 */
      function applyTypePreset(tr, val) {
        var tp = tr.querySelector(".dbc-dz-tp");
        var nl = tr.querySelector(".dbc-dz-nl");
        var df = tr.querySelector(".dbc-dz-df");
        var s = String(val);
        if (/ NOT NULL/i.test(s)) { s = s.replace(/ NOT NULL/i, ""); nl.checked = false; }
        var i = s.toUpperCase().indexOf(" DEFAULT ");
        if (i >= 0 && s.toUpperCase().indexOf(" ON UPDATE ") < 0) {
          df.value = s.slice(i + 9).trim();
          s = s.slice(0, i);
        }
        tp.value = s.replace(/\s+/g, " ").trim();
        tp.focus();
      }

      /* 预设面板：挂在 #modalOverlay 上（弹窗遮罩 z-index 2500，普通下拉菜单 1001 会被压住），
         用 fixed 定位贴在「▾」按钮下方，空间不够就翻到上方 */
      var pz = null, pzAnchor = null;
      function closePresets() {
        if (pz && pz.parentNode) pz.parentNode.removeChild(pz);
        pz = null; pzAnchor = null;
        document.removeEventListener("mousedown", pzOutside, true);
      }
      function pzOutside(e) {
        if (!pz) return;
        if (pz.contains(e.target)) return;
        if (pzAnchor && (pzAnchor === e.target || pzAnchor.contains(e.target))) return;
        closePresets();
      }
      function openPresets(anchor, presets, onPick) {
        closePresets();
        var p = document.createElement("div");
        p.className = "dbc-pz";
        p.innerHTML = presets.map(function (x, i) {
          return typeof x === "string"
            ? '<div class="dbc-pz-i" data-i="' + i + '">' + esc(x) + "</div>"
            : '<div class="dbc-pz-h">' + esc(x.label) + "</div>";
        }).join("");
        $("modalOverlay").appendChild(p);
        var r = anchor.getBoundingClientRect(), w = p.offsetWidth, h = p.offsetHeight;
        var top = r.bottom + 3;
        if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 3);
        p.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + "px";
        p.style.top = top + "px";
        Array.prototype.forEach.call(p.querySelectorAll(".dbc-pz-i"), function (el) {
          el.onclick = function () { var v = presets[+el.dataset.i]; closePresets(); onPick(v); };
        });
        pz = p; pzAnchor = anchor;
        setTimeout(function () { document.addEventListener("mousedown", pzOutside, true); }, 0);
      }
      function render() {
        closePresets();
        tbody.innerHTML = rows.map(function (r) {
          return "<tr>" +
            '<td><input class="dbc-in dbc-dz-n" spellcheck="false" value="' + escAttr(r.name) +
              '" placeholder="列名"></td>' +
            '<td><div class="dbc-dz-tpw"><input class="dbc-in dbc-dz-tp" spellcheck="false" value="' +
              escAttr(r.type) + '" placeholder="' +
              escAttr(conn.kind === "postgres" ? "类型，如 varchar(50)" : "类型 / 定义，如 int not null default 0") +
              '"><button class="dbc-mini dbc-dz-pick dbc-dz-tp-pick" title="选择常用定义">' +
              '<i class="bi bi-caret-down-fill"></i></button></div></td>' +
            '<td class="dbc-dz-c"><input type="checkbox" class="dbc-dz-nl"' +
              (r.nullable ? " checked" : "") + "></td>" +
            '<td><div class="dbc-dz-dfw"><input class="dbc-in dbc-dz-df" spellcheck="false" value="' +
              escAttr(String(r.def == null ? "" : r.def)) + '" placeholder="可空">' +
              '<button class="dbc-mini dbc-dz-pick dbc-dz-df-pick" title="选择常用默认值">' +
              '<i class="bi bi-caret-down-fill"></i></button></div></td>' +
            '<td class="dbc-dz-c"><input type="checkbox" class="dbc-dz-pk"' +
              (r.pk ? " checked" : "") + " disabled></td>" +
            '<td class="dbc-dz-c"><button class="dbc-mini dbc-dz-del" title="删除这一列">' +
              '<i class="bi bi-trash"></i></button></td>' +
          "</tr>";
        }).join("");
        var trs = tbody.querySelectorAll("tr");
        Array.prototype.forEach.call(tbody.querySelectorAll(".dbc-dz-del"), function (b, i) {
          b.onclick = function () { rows.splice(i, 1); render(); };
        });
        Array.prototype.forEach.call(tbody.querySelectorAll(".dbc-dz-tp-pick"), function (b, i) {
          b.onclick = function () {
            openPresets(b, typePresets(), function (v) { applyTypePreset(trs[i], v); });
          };
        });
        Array.prototype.forEach.call(tbody.querySelectorAll(".dbc-dz-df-pick"), function (b, i) {
          b.onclick = function () {
            openPresets(b, defaultPresets(), function (v) {
              var f = trs[i].querySelector(".dbc-dz-df");
              f.value = v;
              f.focus();
            });
          };
        });
      }
      function close() {
        closePresets();
        ov.classList.remove("show"); ov.innerHTML = "";
        ov.onkeydown = null; ov.onmousedown = null;
      }
      render();
      box.querySelector(".dbc-dz-add").onclick = function () {
        rows.push({ name: "", type: "", nullable: true, def: "", pk: false, old: false });
        render();
        var ns = tbody.querySelectorAll(".dbc-dz-n");
        if (ns.length) ns[ns.length - 1].focus();
      };
      box.querySelector(".m-cancel").onclick = close;
      ov.onmousedown = function (e) { if (e.target === ov) close(); };
      ov.onkeydown = function (e) { if (e.key === "Escape") { e.preventDefault(); close(); } };

      okBtn.onclick = async function () {
        var nm = nameIn.value.trim();
        if (!nm) { say("请填写表名"); return; }
        var cur = [];
        Array.prototype.forEach.call(tbody.querySelectorAll("tr"), function (tr, i) {
          cur.push({
            name: tr.querySelector(".dbc-dz-n").value.trim(),
            type: tr.querySelector(".dbc-dz-tp").value.trim(),
            nullable: tr.querySelector(".dbc-dz-nl").checked,
            def: tr.querySelector(".dbc-dz-df").value.trim(),
            pk: rows[i] ? rows[i].pk : false,
            old: rows[i] ? rows[i].old : false,
            extra: rows[i] ? (rows[i].extra || "") : "",
          });
        });
        if (!cur.length) { say("至少要有一列"); return; }
        var seen = {};
        for (var i = 0; i < cur.length; i++) {
          if (!cur[i].name) { say("第 " + (i + 1) + " 列还没填列名"); return; }
          if (seen[cur[i].name]) { say("列名重复：" + cur[i].name); return; }
          if (!String(cur[i].type).trim()) { say("列「" + cur[i].name + "」还没填类型"); return; }
          seen[cur[i].name] = 1;
        }

        // ---------- 新建 ----------
        if (isNew) {
          var defs = cur.map(function (c) { return quoteCol(conn.kind, c.name) + " " + colDef(c); });
          var okNew = await uiConfirm("新建表",
            "将创建「" + nm + "」，共 " + cur.length + " 列：\n" + defs.join(",\n"), "创建", false);
          if (!okNew) return;
          okBtn.disabled = true;
          try {
            await postTable({ action: "create", name: nm, columns: defs.join(", "), schema: useSchema });
            toast("已新建表 " + nm, "ok");
            close();
            state.table = nm; state.schema = useSchema;
            dbcSaveState(conn.id, { table: nm, schema: useSchema });
            await loadSchema();
          } catch (e) { say("创建失败：" + (e.message || String(e))); }
          finally { okBtn.disabled = false; }
          return;
        }

        // ---------- 改结构：与原始结构 diff ----------
        var actions = [];
        orig.forEach(function (o) {                     // 被删掉的列
          if (rows.indexOf(o) < 0) actions.push({ op: "drop", column: o.name });
        });
        cur.forEach(function (c, i) {                   // 改名 / 改定义 / 新增
          var o = rows[i];
          if (!o || !o.old) {
            actions.push({ op: "add", column: c.name, definition: colDef(c) });
            return;
          }
          if (c.name !== o.name) {
            actions.push({ op: "rename", column: o.name, new_name: c.name,
                           definition: conn.kind === "mysql" ? colDefKeep(c) : "" });
          }
          var oldDef = (o.def === null || o.def === undefined) ? "" : String(o.def);
          var parts = [];
          if (c.type !== o.type) parts.push("type");
          if (!!c.nullable !== !!o.nullable) parts.push("nullable");
          if (c.def !== oldDef) parts.push("default");
          if (parts.length) {
            actions.push({ op: "modify", column: c.name, parts: parts,
                           type: String(c.type || "").trim(), nullable: !!c.nullable, "default": c.def,
                           definition: conn.kind === "mysql" ? colDefKeep(c) : colDef(c) });
          }
        });
        var renameTo = (nm !== tableName) ? nm : "";
        if (!actions.length && !renameTo) { say("没有检测到结构改动"); return; }
        if (conn.kind === "sqlite" && actions.some(function (a) { return a.op === "modify"; })) {
          say("SQLite 不支持修改列类型 / 约束，请改用 新增列 / 删除列 / 重命名列");
          return;
        }
        var lines = [];
        if (renameTo) lines.push("重命名表 → " + renameTo);
        actions.forEach(function (a) {
          var what = { type: "类型", nullable: "可空", "default": "默认值" };
          lines.push({ add: "新增列 " + a.column + "  " + a.definition,
                       drop: "删除列 " + a.column,
                       rename: "重命名列 " + a.column + " → " + a.new_name,
                       modify: "修改列 " + a.column + "（" +
                         (a.parts || []).map(function (p) { return what[p] || p; }).join(" / ") + "）"
                     }[a.op]);
        });
        var okGo = await uiConfirm("修改表结构",
          "将对「" + tableName + "」执行 " + lines.length + " 处结构性变更：\n" + lines.join("\n") +
          "\n\n表结构变更不可回撤，确定继续？", "执行", true);
        if (!okGo) return;
        okBtn.disabled = true;
        try {
          if (renameTo) {
            await postTable({ action: "rename", table: tableName, schema: useSchema, new_name: renameTo });
          }
          for (var k = 0; k < actions.length; k++) {
            say("正在执行 " + (k + 1) + " / " + actions.length + " …");
            await postTable(Object.assign({ action: "alter", table: nm, schema: useSchema }, actions[k]));
          }
          toast("表结构已更新（" + lines.length + " 处）", "ok");
          close();
          state.table = nm; state.schema = useSchema;
          dbcSaveState(conn.id, { table: nm, schema: useSchema });
          await loadSchema();
        } catch (e) {
          say("失败：" + (e.message || String(e)));
          await loadSchema();          // 前面几条可能已生效，刷新左侧避免状态对不上
        } finally { okBtn.disabled = false; }
      };
    }

    async function newTable() {
      try {
        if (isRedis) {
          var rk = await dbcFormModal("新建 key", [
            { key: "name", label: "key", placeholder: "如 user:1" },
            { key: "type", label: "类型", type: "select", options: ["string", "hash", "list"] },
            { key: "field", label: "字段名", placeholder: "仅 hash 需要", required: false },
            { key: "value", label: "值", placeholder: "可留空", required: false },
          ], "创建");
          if (!rk) return;
          await postTable({ action: "create", name: rk.name, type: rk.type, field: rk.field, value: rk.value });
          toast("已创建 key：" + rk.name, "ok");
          await reloadSchema(false);
          return;
        }
        if (isMongo) {
          var cn = await uiPrompt("新建集合", "", "集合名");
          if (!cn || !cn.trim()) return;
          await postTable({ action: "create", name: cn.trim() });
          toast("已创建集合 " + cn.trim(), "ok");
          await reloadSchema(false);
          return;
        }
        await tableDesigner("", state.schema);
      } catch (e) { toast(e.message || String(e), "err"); }
    }
    async function renameTable(name, sch) {
      var nn = await uiPrompt("重命名" + whatName, name, "新的名称");
      if (!nn || !nn.trim() || nn.trim() === name) return;
      try {
        await postTable({ action: "rename", table: name, schema: sch, new_name: nn.trim() });
        toast("已重命名为 " + nn.trim(), "ok");
        await reloadSchema(false);
      } catch (e) { toast(e.message || String(e), "err"); }
    }
    async function truncateTable(name, sch) {
      var ok = await uiConfirm("清空" + whatName,
        "将删除「" + name + "」里的全部数据（结构保留），且不可回撤，确定继续？", "清空", true);
      if (!ok) return;
      try {
        await postTable({ action: "truncate", table: name, schema: sch });
        toast("已清空 " + name, "ok");
        if (state.table === name) loadRows(0);
      } catch (e) { toast(e.message || String(e), "err"); }
    }
    async function dropTable(name, sch) {
      var ok = await uiConfirm("删除" + whatName,
        "将删除「" + name + "」及其全部数据，且不可回撤，确定继续？", "删除", true);
      if (!ok) return;
      try {
        await postTable({ action: "drop", table: name, schema: sch });
        toast("已删除 " + name, "ok");
        await reloadSchema(false);
      } catch (e) { toast(e.message || String(e), "err"); }
    }
    // MongoDB：采样首条文档，列出集合字段（没有固定结构，只看个大概）
    async function showFields(name, sch) {
      var cols;
      try {
        var d = await dbcApi("/api/db/table/columns?conn=" + encodeURIComponent(conn.id) +
          "&dbname=" + encodeURIComponent(state.db) +
          "&schema=" + encodeURIComponent(sch || state.schema) + "&table=" + encodeURIComponent(name));
        cols = d.columns || [];
      } catch (e) { toast(e.message || String(e), "err"); return; }
      var html = cols.length
        ? '<table class="dbc-info-t"><thead><tr><th>字段</th><th>类型</th><th>说明</th></tr></thead><tbody>' +
          cols.map(function (c) {
            return "<tr><td>" + esc(c.name) + "</td><td>" + esc(c.type || "") + "</td><td>" +
              (c.pk ? "主键" : "") + "</td></tr>";
          }).join("") + "</tbody></table>"
        : '<div class="m-msg">这个集合还没有文档，字段未知</div>';
      await uiModal({ title: "集合字段 · " + name, wide: true, html: html,
                      hideCancel: true, okText: "知道了" });
    }
    async function mongoAddField(name) {
      var r = await dbcFormModal("为全部文档新增字段", [
        { key: "field", label: "字段名", placeholder: "如 status" },
        { key: "value", label: "默认值", placeholder: "可留空；数字 / true / null 按 JSON 解析", required: false },
      ], "写入");
      if (!r) return;
      try {
        await postTable({ action: "addfield", table: name, field: r.field, value: r.value });
        toast("已为全部文档写入字段 " + r.field, "ok");
        if (state.table === name) loadRows(state.offset);
      } catch (e) { toast(e.message || String(e), "err"); }
    }
    async function redisExpireKey(name) {
      var r = await dbcFormModal("设置 key 过期", [
        { key: "seconds", label: "秒数", placeholder: "0 = 取消过期（永久）", value: "0" },
      ], "设置");
      if (!r) return;
      try {
        await postTable({ action: "expire", table: name, seconds: parseInt(r.seconds, 10) || 0 });
        toast(parseInt(r.seconds, 10) > 0 ? "已设置过期" : "已设为永久", "ok");
      } catch (e) { toast(e.message || String(e), "err"); }
    }

    function tableMenu(name, sch, anchor) {
      var items = [];
      if (isRedis) {
        items.push({ label: "新建 key…", icon: "bi-plus-square", act: function () { newTable(); } });
        if (name) {
          items.push({ label: "重命名 key…", icon: "bi-input-cursor-text",
                       act: function () { renameTable(name, sch); } });
          items.push({ label: "设置过期…", icon: "bi-clock",
                       act: function () { redisExpireKey(name); } });
          items.push({ label: "删除 key", icon: "bi-trash", danger: true,
                       act: function () { dropTable(name, sch); } });
        }
      } else if (isMongo) {
        items.push({ label: "新建集合…", icon: "bi-plus-square", act: function () { newTable(); } });
        if (name) {
          items.push({ divider: true });
          items.push({ label: "查看字段…", icon: "bi-list-columns",
                       act: function () { showFields(name, sch); } });
          items.push({ label: "为全部文档新增字段…", icon: "bi-plus-circle",
                       act: function () { mongoAddField(name); } });
          items.push({ label: "重命名集合…", icon: "bi-input-cursor-text",
                       act: function () { renameTable(name, sch); } });
          items.push({ label: "清空集合（删掉全部文档）", icon: "bi-eraser", danger: true,
                       act: function () { truncateTable(name, sch); } });
          items.push({ label: "删除集合", icon: "bi-trash", danger: true,
                       act: function () { dropTable(name, sch); } });
        }
      } else {
        items.push({ label: "新建表…", icon: "bi-plus-square", act: function () { newTable(); } });
        if (name) {
          items.push({ divider: true });
          items.push({ label: "表结构（查看 / 修改）…", icon: "bi-table",
                       act: function () { tableDesigner(name, sch); } });
          items.push({ label: "重命名表…", icon: "bi-input-cursor-text",
                       act: function () { renameTable(name, sch); } });
          items.push({ label: "清空表（删掉全部数据）", icon: "bi-eraser", danger: true,
                       act: function () { truncateTable(name, sch); } });
          items.push({ label: "删除表", icon: "bi-trash", danger: true,
                       act: function () { dropTable(name, sch); } });
        }
      }
      MENUS.dbcTable = items;
      openDrop("dbcTable", anchor);
    }

    dbSel.onchange = function () {
      state.db = dbSel.value; state.table = ""; state.schema = "";
      dbcSaveState(conn.id, { db: state.db, table: "", schema: "" });
      loadSchema();
    };
    tab.host.querySelector(".dbc-refresh").onclick = function () {
      if (state.table) { loadRows(state.offset); } else { loadSchema(); }
    };
    // 侧栏「＋」：新建表 / 集合 / key（表列表为空时也能从这里进）
    tab.host.querySelector(".dbc-new-table").onclick = function () { newTable(); };
    // 当前表名旁边的笔：直接进表结构设计（MongoDB 则看集合字段）
    curEditEl.onclick = function () {
      if (!state.table) { toast("请先在左侧选一张表 / 集合", "warn"); return; }
      if (isMongo) showFields(state.table, state.schema);
      else tableDesigner(state.table, state.schema);
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
    refreshUndo();                          // 工具栏「回撤」上的可回撤步数
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

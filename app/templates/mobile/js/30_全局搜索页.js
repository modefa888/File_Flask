  // ---------- 全局搜索页 ----------
  var SP_MAX_SHOW = 200;          // 最多渲染的条数，避免 DOM 过大
  var spSession = 0;              // 会话号，用于取消过期的轮询/渲染
  var spScope = "local";          // global | local（默认搜索当前文件夹）
  var spScopeGlobal = document.getElementById("spScopeGlobal");
  var spScopeLocal = document.getElementById("spScopeLocal");
  var spInput = document.getElementById("spInput");
  var spResults = document.getElementById("spResults");
  var spStatus = document.getElementById("spStatus");
  var spHistWrap = document.getElementById("spHistWrap");
  var spHistBtn = document.getElementById("spHistBtn");
  var spLastQuery = null;         // 最近一次实际执行的搜索 {q, scope, root}，用于避免重复自动搜索
  var spCache = {};               // 搜索结果缓存：sig → {items, status}，持久化到 localStorage
  var SP_CACHE_MAX = 8;
  var SP_CACHE_KEY = "fm_sp_cache";
  var SP_HIST_KEY = "fm_sp_history";    // 搜索历史（localStorage 持久化）
  var SP_STATE_KEY = "fm_sp_state";     // 上次搜索状态（localStorage 持久化）
  var SP_HIST_MAX = 10;

  function pathBaseName(p) {
    p = String(p || "").replace(/\/+$/, "");
    var i = p.lastIndexOf("/");
    return i >= 0 ? (p.slice(i + 1) || p) : p;
  }
  function spLsGet(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) || fallback; }
    catch (e) { return fallback; }
  }
  function spLsSet(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
  }
  function spSig(q, scope, root) {
    return q + "|" + scope + "|" + root;
  }
  function spCacheLoad() {
    var obj = spLsGet(SP_CACHE_KEY, {});
    if (obj && typeof obj === "object") spCache = obj;
  }
  function spCachePut(sig, q, scope, root, items, status) {
    spCache[sig] = { q: q, scope: scope, root: root, items: items, status: status, ts: Date.now() };
    var keys = Object.keys(spCache);
    if (keys.length > SP_CACHE_MAX) {
      keys.sort(function (a, b) { return (spCache[a].ts || 0) - (spCache[b].ts || 0); });
      while (keys.length > SP_CACHE_MAX) delete spCache[keys.shift()];
    }
    spLsSet(SP_CACHE_KEY, spCache);
  }
  function spWhereTag(root) {
    return root ? "📁 " + (pathBaseName(root) || "/") : "🌐 全局";
  }
  function addHistory(entry) {
    var list = spLsGet(SP_HIST_KEY, []);
    list = list.filter(function (h) {
      return !(h.q === entry.q && h.scope === entry.scope && h.root === entry.root);
    });
    list.unshift(entry);
    spLsSet(SP_HIST_KEY, list.slice(0, SP_HIST_MAX));
  }
  // 历史面板：固定表头（标题 + 条数 + 清空）+ 可滚动列表，每条一行「图标 / 关键词 / 范围 / 删除」
  var spHistListEl = null;
  function updateHistMore() {
    if (!spHistListEl) return;
    var rest = spHistListEl.scrollHeight - spHistListEl.clientHeight - spHistListEl.scrollTop;
    spHistWrap.classList.toggle("has-more", rest > 4);   // 还有更多 → 显示底部渐隐箭头
  }
  function renderHistChips() {
    spHistWrap.innerHTML = "";
    spHistWrap.classList.remove("has-more");
    var list = spLsGet(SP_HIST_KEY, []);

    var head = document.createElement("div");
    head.className = "sp-hist-head";
    var title = document.createElement("span");
    title.textContent = list.length ? "搜索历史 · 共 " + list.length + " 条" : "搜索历史";
    head.appendChild(title);
    if (list.length) {
      var clear = document.createElement("span");
      clear.className = "sp-hist-clear";
      clear.textContent = "清空";
      clear.addEventListener("click", function (e) {
        e.stopPropagation();
        try { localStorage.removeItem(SP_HIST_KEY); } catch (err) {}
        renderHistChips();
        updateHistMore();
      });
      head.appendChild(clear);
    }
    spHistWrap.appendChild(head);

    var box = document.createElement("div");
    box.className = "sp-hist-list";
    spHistListEl = box;
    box.addEventListener("scroll", updateHistMore, { passive: true });

    if (!list.length) {
      var empty = document.createElement("div");
      empty.className = "sp-hist-empty";
      empty.textContent = "暂无搜索历史";
      box.appendChild(empty);
      spHistWrap.appendChild(box);
      return;
    }

    list.forEach(function (h) {   // 全部列出（存储上限 10 条），超出部分滚动查看
      var isLocal = h.scope !== "global";
      var dirName = isLocal ? (pathBaseName(h.root) || "/") : "";

      var row = document.createElement("div");
      row.className = "sp-hist-item";
      row.title = (isLocal ? (h.root || "/") : "全部目录") + " · " + h.q;

      var ico = document.createElement("span");
      ico.className = "sp-hist-ico";
      ico.textContent = isLocal ? "📁" : "🌐";

      var q = document.createElement("span");
      q.className = "sp-hist-q";
      q.textContent = h.q;

      var where = document.createElement("span");
      where.className = "sp-hist-where";
      where.textContent = isLocal ? "在 " + dirName + " 内" : "全部目录";

      var del = document.createElement("button");
      del.type = "button";
      del.className = "sp-hist-del";
      del.title = "删除这条历史";
      del.textContent = "✕";
      del.addEventListener("click", function (e) {   // 只删这条，不触发搜索
        e.stopPropagation();
        spLsSet(SP_HIST_KEY, spLsGet(SP_HIST_KEY, []).filter(function (x) {
          return !(x.q === h.q && x.scope === h.scope && x.root === h.root);
        }));
        renderHistChips();
        updateHistMore();
      });

      row.append(ico, q, where, del);
      row.addEventListener("click", function () {
        spHistWrap.classList.add("hidden");
        spInput.value = h.q;
        setScope(isLocal ? "local" : "global");
        runSearch(isLocal ? (h.root || "") : "");
      });
      box.appendChild(row);
    });
    spHistWrap.appendChild(box);
    updateHistMore();
  }
  function toggleHist() {
    if (spHistWrap.classList.contains("hidden")) {
      spHistWrap.classList.remove("hidden");   // 先显示再渲染，才能量出是否需要滚动提示
      renderHistChips();
    } else {
      spHistWrap.classList.add("hidden");
    }
  }
  spHistBtn.addEventListener("click", toggleHist);
  // 点结果区/页面别处自动收起历史面板
  var spBodyEl = document.querySelector("#searchPage .sp-body");
  if (spBodyEl) spBodyEl.addEventListener("click", function () { spHistWrap.classList.add("hidden"); });
  function openSearchPage() {
    setScope("local");            // 每次打开记录当前目录，默认搜索当前文件夹
    document.getElementById("searchPage").classList.add("show");
    document.body.classList.add("lock");
    setTimeout(function () { spInput.focus(); }, 60);
  }
  function closeSearchPage() {
    spSession++;                  // 终止进行中的搜索
    document.getElementById("searchPage").classList.remove("show");
    document.body.classList.remove("lock");
    spStatus.textContent = "";
  }
  function setScope(s) {
    spScope = s;
    spScopeGlobal.classList.toggle("active", s === "global");
    spScopeLocal.classList.toggle("active", s === "local");
    spScopeLocal.textContent = "📁 " + (pathBaseName(state.path) || "当前目录");
  }
  function onScopeTap(s) {
    setScope(s);
    var q = spInput.value.trim();
    if (!q) return;               // 无关键字：只切换范围
    var root = (s === "local") ? (state.path || "") : "";
    var sig = spSig(q, s, root);
    if (spCache[sig]) {           // 该 关键字+范围 已搜过：直接恢复本地缓存，不再请求
      var my = ++spSession;
      renderSearchResults(spCache[sig].items, my, false);
      spStatus.textContent = spCache[sig].status || "";
      spLastQuery = { q: q, scope: s, root: root };
      return;
    }
    runSearch();                  // 第一次切到该范围才真正请求
  }
  spScopeGlobal.addEventListener("click", function () { onScopeTap("global"); });
  spScopeLocal.addEventListener("click", function () { onScopeTap("local"); });
  document.getElementById("spBack").addEventListener("click", closeSearchPage);
  document.getElementById("searchBtn").addEventListener("click", openSearchPage);
  document.getElementById("spGo").addEventListener("click", function () {
    spInput.blur();
    runSearch();
  });
  spInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter") { spInput.blur(); runSearch(); }
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") closeSearchPage();
  });

  async function runSearch(forceRoot) {
    var q = spInput.value.trim();
    if (!q) { toast("请输入搜索关键字", "warn"); return; }
    var rootUsed = (spScope === "local") ? (forceRoot || state.path || "") : "";
    addHistory({ q: q, scope: spScope, root: rootUsed });
    var my = ++spSession;
    spResults.innerHTML = '<div class="empty">搜索中…</div>';
    spHistWrap.classList.add("hidden");
    spStatus.textContent = "";
    var url = "/api/search?keyword=" + encodeURIComponent(q) + "&use_index=auto&timeout=120";
    if (rootUsed) url += "&root=" + encodeURIComponent(rootUsed);
    try {
      var resp = await fetch(url);
      if (!resp.ok) {
        var msg = "HTTP " + resp.status;
        try { var j = await resp.json(); if (j.error) msg = j.error; } catch (e) {}
        throw new Error(msg);
      }
      var data = await resp.json();
      if (my !== spSession) return;
      if (data.token) { pollSearch(data.token, my, rootUsed); return; }   // 遍历模式：后台任务
      if (data.items) {
        renderSearchResults(data.items, my, false);
        spLastQuery = { q: q, scope: spScope, root: rootUsed };
        var status = "共 " + (data.count || data.items.length) + " 条 · " +
          (data.duration != null ? data.duration + "s · " : "") + "索引 · " + spWhereTag(rootUsed);
        spStatus.textContent = status;
        spCachePut(spSig(q, spScope, rootUsed), q, spScope, rootUsed,
          data.items.slice(0, SP_MAX_SHOW), status);
        spLsSet(SP_STATE_KEY, { q: q, scope: spScope, root: rootUsed, status: status,
          items: data.items.slice(0, SP_MAX_SHOW) });
      }
    } catch (e) {
      if (my !== spSession) return;
      spResults.innerHTML = '<div class="empty">搜索失败: ' + esc(e.message || e) + '</div>';
    }
  }

  async function pollSearch(token, my, rootUsed) {
    while (true) {
      if (my !== spSession) return;
      await new Promise(function (r) { setTimeout(r, 500); });
      if (my !== spSession) return;
      var data;
      try {
        var resp = await fetch("/api/search/" + token);
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        data = await resp.json();
      } catch (e) {
        if (my !== spSession) return;
        spResults.innerHTML = '<div class="empty">搜索失败: ' + esc(e.message || e) + '</div>';
        return;
      }
      if (my !== spSession) return;
      if (data.error) {
        spResults.innerHTML = '<div class="empty">' + esc(data.error) + '</div>';
        return;
      }
      renderSearchResults(data.items || [], my, !data.done);
      if (data.done) {
        var tip = "共 " + (data.count || 0) + " 条";
        if (data.error === null && data.duration != null) tip += " · " + data.duration.toFixed(1) + "s";
        if (data.items && data.items.length >= 5000) tip += "（已达上限，请细化关键字）";
        tip += " · " + spWhereTag(rootUsed);
        spStatus.textContent = tip;
        spLastQuery = { q: spInput.value.trim(), scope: spScope, root: rootUsed };
        spCachePut(spSig(spInput.value.trim(), spScope, rootUsed), spInput.value.trim(),
          spScope, rootUsed, (data.items || []).slice(0, SP_MAX_SHOW), tip);
        spLsSet(SP_STATE_KEY, { q: spInput.value.trim(), scope: spScope, root: rootUsed,
          status: tip, items: (data.items || []).slice(0, SP_MAX_SHOW) });
        return;
      }
    }
  }

  function dirnameOf(p) {
    p = String(p).replace(/\/+$/, "");
    var i = p.lastIndexOf("/");
    return i > 0 ? p.slice(0, i) : "/";
  }

  function renderSearchResults(items, my, running) {
    if (my !== spSession) return;
    spResults.className = "list " + (state.view === "grid" ? "grid" : "rows");
    spResults.innerHTML = "";
    var total = items.length;
    if (total === 0) {
      spResults.innerHTML = '<div class="empty">' + (running ? "搜索中… 尚未找到匹配项" : "没有匹配的结果") + '</div>';
      spStatus.textContent = running ? "搜索中…" : "";
      return;
    }
    var shown = items.slice(0, SP_MAX_SHOW);
    // 搜索命中的音视频（跨目录），作为播放器列表上下文
    var srCtx = shown.filter(function (x) {
      return !isDir(x) &&
        (VIDEO_EXT.indexOf(extOf(x.name)) >= 0 || AUDIO_EXT.indexOf(extOf(x.name)) >= 0);
    });
    shown.forEach(function (item) {
      var row = document.createElement("div");
      row.className = "item";
      var sub2 = isDir(item)
        ? "文件夹" + (item.mtime ? " · " + fmtTime(item.mtime) : "")
        : (item.size_str || "—") + (item.mtime ? " · " + fmtTime(item.mtime) : "") + " · " + fileTypeName(item);
      var thumbHtml;
      if (canThumb(item)) {
        thumbHtml = '<img loading="lazy" src="/api/thumbnail?path=' +
          encodeURIComponent(itemAbs(item)) + '" alt="" onerror="this.parentNode.textContent=\'' +
          iconFor(item) + '\'">';
      } else {
        thumbHtml = iconHtmlFor(item);
      }
      row.innerHTML =
        '<div class="thumb">' + thumbHtml + '</div>' +
        '<div class="meta">' +
          '<div class="name">' + esc(item.name) + '</div>' +
          '<div class="sub">' + esc(dirnameOf(item.abs_path || "/")) + '</div>' +
          '<div class="sub">' + esc(sub2) + '</div>' +
        '</div>' +
        // 文件点行即打开操作菜单，无需 ⋯；文件夹保留（点行是进入目录）
        (isDir(item) ? '<button class="more" aria-label="更多">⋯</button>' : '');
      function activate() {
        if (isDir(item)) { closeSearchPage(); load(itemAbs(item)); }
        else openActions(item, srCtx);
      }
      row.addEventListener("click", activate);
      var srMore = row.querySelector(".more");
      if (srMore) srMore.addEventListener("click", function (e) {
        e.stopPropagation(); activate();
      });
      // 文件：点缩略图图标直接预览
      if (!isDir(item)) {
        var srTh = row.querySelector(".thumb");
        if (srTh) srTh.addEventListener("click", function (e) {
          e.stopPropagation();
          openPreview(item, srCtx);
        });
      }
      spResults.appendChild(row);
    });
    if (total > shown.length) {
      var note = document.createElement("div");
      note.className = "sp-note";
      note.textContent = "已显示前 " + shown.length + " 条（共 " + total + " 条），请细化关键字";
      spResults.appendChild(note);
    }
    spStatus.textContent = (running ? "搜索中… 已找到 " : "共 ") + total + " 条" +
      (total > shown.length ? "（仅显示前 " + shown.length + "）" : "");
  }

  // 恢复上次搜索状态（localStorage 持久化，页面刷新后仍保留；重新搜索才会清空）
  spCacheLoad();
  (function restoreSpState() {
    var s = spLsGet(SP_STATE_KEY, null);
    if (!s || !s.q) return;
    spInput.value = s.q;
    setScope(s.scope === "global" ? "global" : "local");
    spLastQuery = { q: s.q, scope: s.scope === "global" ? "global" : "local", root: s.root || "" };
    if (s.items && s.items.length) {
      spCachePut(spSig(s.q, spLastQuery.scope, spLastQuery.root), s.q,
        spLastQuery.scope, spLastQuery.root, s.items, s.status || "");
    }
    if (s.items && s.items.length) {
      renderSearchResults(s.items, spSession, false);
      spStatus.textContent = s.status || "";
    }
  })();

  // 浏览器前进/后退：hash 变化时切换目录（load 内自己设置的 hash 会因路径相同而忽略）
  window.addEventListener("hashchange", function () {
    var p = readHashPath();
    if (p === null) return;                                   // 无效 hash 不响应
    if (normDirPath(p) === normDirPath(state.path)) return;
    load(p);
  });

  // 首次加载：优先恢复 URL hash 里的目录（无效则回根目录）

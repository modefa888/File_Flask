  // ---------- 待执行的移动/复制（全局记录） ----------
  function setPendingOp(mode, paths) {
    pendingOp = { mode: mode, paths: paths };
    document.getElementById("pasteBtn").classList.remove("hidden");
    toast((mode === "move" ? "移动" : "复制") + "已记录 " + paths.length +
      " 项，打开目标文件夹后点击 📋 完成", "info");
  }
  async function executePendingOp() {
    if (!pendingOp) return;
    var isMove = pendingOp.mode === "move";
    var paths = pendingOp.paths.slice();
    var dest = state.path || "/";
    pendingOp = null;
    document.getElementById("pasteBtn").classList.add("hidden");
    if (!paths.length) return;
    var name = paths.length === 1 ? (paths[0].split("/").pop() || "") : (paths.length + " 项");
    bgStart(isMove ? "mv" : "cp", isMove ? "/api/move/start" : "/api/copy/start",
      { paths: paths, dest_dir: dest }, {
      title: (isMove ? "正在移动：" : "正在复制：") + name,
      label: (isMove ? "移动" : "复制"),
      legacy: function () { _legacyMoveCopy(isMove, paths, dest); },
      onDone: function (ok, d) {
        var result = (d && d.result) || {};
        var doneN = result.done != null ? result.done : paths.length;
        if (ok) toast((isMove ? "已移动 " : "已复制 ") + doneN + " 项到当前目录", "success");
        load(state.path);
      }
    });
  }

  // 后端未升级兜底：退回旧的逐文件同步接口
  async function _legacyMoveCopy(isMove, paths, dest) {
    var ok = 0, fail = 0, firstErr = "";
    for (var i = 0; i < paths.length; i++) {
      try {
        var resp = await fetch(isMove ? "/api/move" : "/api/copy", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: paths[i], dest_dir: dest })
        });
        var d = await resp.json();
        if (d.success || !d.error) ok++;
        else { fail++; if (!firstErr) firstErr = d.error; }
      } catch (e) { fail++; if (!firstErr) firstErr = "网络错误"; }
    }
    if (fail === 0) {
      toast((isMove ? "已移动 " : "已复制 ") + ok + " 项到当前目录", "success");
    } else if (ok === 0 && paths.length === 1) {
      toast((isMove ? "移动失败：" : "复制失败：") + firstErr, "error");
    } else {
      toast((isMove ? "移动" : "复制") + "完成：成功 " + ok + "，失败 " + fail +
        (firstErr ? "（" + firstErr + "）" : ""), "warn");
    }
    load(state.path);
  }
  function cancelPendingOp() {
    if (!pendingOp) return;
    pendingOp = null;
    document.getElementById("pasteBtn").classList.add("hidden");
    toast("已取消待执行的操作", "info");
  }
  document.getElementById("pasteBtn").addEventListener("click", executePendingOp);
  (function () {   // 长按 📋 取消待执行操作
    var btn = document.getElementById("pasteBtn"), t = null;
    btn.addEventListener("touchstart", function () {
      t = setTimeout(function () { t = null; cancelPendingOp(); }, 600);
    }, { passive: true });
    ["touchend", "touchmove"].forEach(function (ev) {
      btn.addEventListener(ev, function () { if (t) { clearTimeout(t); t = null; } });
    });
    btn.addEventListener("contextmenu", function (e) { e.preventDefault(); cancelPendingOp(); });
  })();

  function normDirPath(p) { return (!p || p === "/") ? "/" : p; }
  // 路径编码成 base64url 再放进 hash，地址栏不显示明文路径
  function b64urlEncode(s) {
    var bytes = new TextEncoder().encode(s), bin = "";
    bytes.forEach(function (b) { bin += String.fromCharCode(b); });
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function b64urlDecode(s) {
    s = s.replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    var bin = atob(s), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }
  // 返回 ""(根目录) / 路径 / null(无效 hash)
  function readHashPath() {
    var h = location.hash.replace(/^#\/?/, "");
    if (!h) return "";
    try {
      var p = b64urlDecode(h);
      return (p && p.charAt(0) === "/") ? p : null;
    } catch (e) { return null; }
  }
  // 带超时的 fetch：超时自动中断（AbortError），避免请求卡住一直转圈
  function fetchTimeout(url, ms, opts) {
    ms = ms || 15000;
    var ctrl = (typeof AbortController !== "undefined") ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, ms);
    var init = Object.assign({}, opts || {});
    if (ctrl) init.signal = ctrl.signal;
    return fetch(url, init)
      .finally(function () { clearTimeout(timer); });
  }

  // 预览卡片内加载同级文件列表：带超时，失败/超时可重试
  function loadSiblingsInto(listEl, dirAbs, render) {
    function run() {
      listEl.innerHTML = '<div class="pv-vempty">加载中…</div>';
      fetchTimeout("/api/files?path=" + encodeURIComponent(dirAbs) + "&limit=0&offset=0", 10000)
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (d.error) { listEl.innerHTML = '<div class="pv-vempty">' + esc(d.error) + '</div>'; return; }
          render(d.items || []);
        })
        .catch(function (e) {
          var reason = (e && e.name === "AbortError") ? "加载超时" : "列表加载失败";
          listEl.innerHTML = "";
          var tip = document.createElement("div");
          tip.className = "pv-vempty";
          tip.textContent = reason;
          var btn = document.createElement("button");
          btn.type = "button";
          btn.className = "pv-retry";
          btn.textContent = "↻ 重试";
          btn.addEventListener("click", run);
          tip.appendChild(btn);
          listEl.appendChild(tip);
        });
    }
    run();
  }

  var _loadingPath = null;
  async function load(path, fallbackRoot) {
    if (_loadingPath === (path || "")) return;   // 同一目录正在加载，忽略重复触发
    _loadingPath = path || "";
    exitSelMode();
    showLoading(true);
    try {
      var url = path
        ? "/api/files?path=" + encodeURIComponent(path) + "&limit=0&offset=0"
        : "/api/files?limit=0&offset=0";
      if (state.showHidden) url += "&hidden=1";   // 显示隐藏文件（后端 list_directory 过滤点开头条目）
      var resp = await fetchTimeout(url, 15000);
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      var data = await resp.json();
      if (data.error) {
        toast(data.error, "error");
        if (fallbackRoot) load("");   // hash 里的目录已不存在，回根目录
        return;
      }
      state.path = data.current_path_abs || "";
      // 同步 URL hash（编码后）：刷新/分享链接可直接回到当前目录，浏览器前进后退也可用
      var wantPath = (state.path && state.path !== "/") ? state.path : "/";
      var curHash = readHashPath();
      if (curHash === null || normDirPath(curHash) !== wantPath) {
        location.hash = wantPath === "/" ? "#/" : "#/" + b64urlEncode(wantPath);
      }
      state.parentPath = data.parent_path || null;
      state.items = data.items || [];
      renderBreadcrumb(state.path);
      renderList();
      renderStats(data.stats);
      startSizePoll(state.path);
      document.getElementById("appTitle").textContent =
        (state.path === "/" || !state.path) ? "根目录" : state.path.split("/").filter(Boolean).pop();
    } catch (e) {
      var msg = (e && e.name === "AbortError")
        ? "加载超时，请点重试或检查网络"
        : "加载失败: " + (e.message || e);
      toast(msg, "error");
    } finally {
      _loadingPath = null;
      showLoading(false);
    }
  }

  function renderStats(stats) {
    if (!stats) return;
    document.getElementById("statCount").textContent =
      (stats.total_dirs || 0) + " 文件夹 · " + (stats.total_files || 0) + " 文件";
    document.getElementById("statSize").textContent = stats.total_size_str || "";
  }

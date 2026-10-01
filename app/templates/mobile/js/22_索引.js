  // ---------- 索引 ----------
  var _idxTimer = null;
  function openIdxPage() {
    document.getElementById("idxPage").classList.add("show");
    document.body.classList.add("lock");
    idxFetch();
  }
  function closeIdxPage() {
    document.getElementById("idxPage").classList.remove("show");
    document.body.classList.remove("lock");
    ensureIdxPoll(false);
  }
  function ensureIdxPoll(on) {
    if (on && !_idxTimer) {
      _idxTimer = setInterval(function () {
        if (!document.getElementById("idxPage").classList.contains("show")) {
          clearInterval(_idxTimer); _idxTimer = null; return;
        }
        idxFetch();
      }, 2000);
    } else if (!on && _idxTimer) { clearInterval(_idxTimer); _idxTimer = null; }
  }
  function idxFetch() {
    fetchTimeout("/api/index/detail", 8000)
      .then(function (r) { return r.json(); })
      .then(function (d) { renderIdx(d); })
      .catch(function () {});
  }
  function idxRow(dir, name, inner) {
    return '<div class="tr-item" style="display:flex;align-items:center;gap:8px" data-goto="' + esc(dir) + '" data-name="' + esc(name) + '">' + inner + '</div>';
  }
  function renderIdx(d) {
    var body = document.getElementById("idxBody");
    var stat = document.getElementById("idxStat");
    if (d.error) {
      body.innerHTML = '<div class="tr-empty">' + esc(d.error) + '</div>';
      stat.textContent = ""; ensureIdxPoll(false); return;
    }
    var status = d.status || "idle";
    var scanning = status === "scanning";
    ensureIdxPoll(scanning);
    stat.textContent = scanning ? "扫描中 " + (d.progress || 0) + "%" : "基于本地索引，全盘搜索毫秒级响应";
    var h = '<div class="idx-grid">' +
      '<div class="idx-cell"><b>' + (d.total_files || 0).toLocaleString() + '</b><span>文件</span></div>' +
      '<div class="idx-cell"><b>' + (d.total_dirs || 0).toLocaleString() + '</b><span>目录</span></div>' +
      '<div class="idx-cell"><b>' + esc(d.total_size_str || "--") + '</b><span>总大小</span></div>' +
      '<div class="idx-cell"><b>' + esc(d.last_scan || "--") + '</b><span>上次扫描</span></div>' +
    '</div>';
    if (scanning) {
      h += '<div class="idx-status scan">⏳ 扫描中 ' + (d.progress || 0) + '% ' + esc(d.status_detail || "") + '</div>' +
        '<div class="idx-progress"><div class="idx-progress-fill" style="width:' + (d.progress || 0) + '%"></div></div>' +
        '<button class="idx-cancel" id="idxCancel">✕ 取消扫描</button>';
    } else if (status === "error") {
      h += '<div class="idx-status err">❌ 上次扫描失败，可点击右上角「重建」重试</div>';
    } else {
      h += '<div class="idx-status ok">✅ 索引就绪</div>';
    }
    // 占用空间 Top 15 目录（点击跳转该目录）
    var topDirs = d.top_dirs || [];
    h += '<div class="idx-sec">📁 占用空间 Top ' + topDirs.length + ' 目录</div>';
    if (!topDirs.length) h += '<div class="tr-empty">暂无数据</div>';
    topDirs.forEach(function (it, i) {
      h += idxRow(dirnameOf(it.path), it.name,
        '<span class="idx-rank">' + (i + 1) + '</span>' +
        '<span class="idx-name">' + esc(it.name) + '</span>' +
        '<span class="idx-sub">' + (it.file_count || 0).toLocaleString() + ' 文件</span>' +
        '<span class="idx-size">' + esc(it.size_str) + '</span>');
    });
    // 文件类型分布
    var tdist = (d.type_distribution || []).slice(0, 12);
    h += '<div class="idx-sec">🏷️ 文件类型分布</div>';
    if (!tdist.length) h += '<div class="tr-empty">暂无数据</div>';
    tdist.forEach(function (it) {
      h += '<div class="idx-trow">' +
        '<span class="idx-ext">' + esc(it.ext) + '</span>' +
        '<span class="idx-name" style="font-weight:400">' + it.count.toLocaleString() + ' 个</span>' +
        '<span class="idx-size">' + esc(it.size_str) + '</span></div>';
    });
    // 最大文件 Top 10（点击跳转所在目录）
    var topFiles = d.top_files || [];
    h += '<div class="idx-sec">🗃️ 最大文件 Top ' + topFiles.length + '</div>';
    if (!topFiles.length) h += '<div class="tr-empty">暂无数据</div>';
    topFiles.forEach(function (it) {
      h += idxRow(it.parent, it.name,
        '<span class="idx-name">' + esc(it.name) + '</span>' +
        '<span class="idx-ext">' + esc(it.ext) + '</span>' +
        '<span class="idx-size">' + esc(it.size_str) + '</span>');
    });
    body.innerHTML = h;
    Array.prototype.forEach.call(body.querySelectorAll("[data-goto]"), function (el) {
      el.addEventListener("click", function () {
        var dir = el.getAttribute("data-goto");
        var nm = el.getAttribute("data-name");
        closeIdxPage();
        gotoAndHighlight(dir, nm);
      });
    });
    var cancel = document.getElementById("idxCancel");
    if (cancel) cancel.addEventListener("click", function () {
      fetchTimeout("/api/index/cancel", 8000, { method: "POST" })
        .then(function () { toast("已取消扫描", "info"); idxFetch(); })
        .catch(function () { toast("取消失败", "error"); });
    });
  }
  document.getElementById("idxRebuild").addEventListener("click", function () {
    confirmBox({
      title: "重建索引",
      message: "将重新全盘扫描文件索引（后台进行，不影响浏览）。确定开始？",
      okText: "开始扫描",
      onOk: function () {
        toast("索引构建已启动", "success");
        fetchTimeout("/api/index/build", 15000, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ roots: "" })
        })
          .then(function (r) { return r.json(); })
          .then(function (d) {
            if (d.error) { toast(d.error, "error"); return; }
            idxFetch();
          })
          .catch(function () { toast("启动失败", "error"); });
      }
    });
  });
  document.getElementById("idxBack").addEventListener("click", closeIdxPage);
  document.getElementById("mmIdxBtn").addEventListener("click", function () {
    toggleMoreMenu(false); openIdxPage();
  });

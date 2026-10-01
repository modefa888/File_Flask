  // ---------- 目录大小后台补齐：有目录在算就轮询，算完自动刷新一次 ----------
  var _sizePollTimer = null, _sizePollPath = null;
  function stopSizePoll() {
    if (_sizePollTimer) { clearInterval(_sizePollTimer); _sizePollTimer = null; }
    _sizePollPath = null;
  }
  function startSizePoll(dir) {
    if (_sizePollTimer && _sizePollPath === dir) return;   // 同目录继续轮
    stopSizePoll();
    if (!state.items.some(function (it) { return it.is_dir && it.size_pending; })) return;
    _sizePollPath = dir;
    _sizePollTimer = setInterval(function () {
      fetchTimeout("/api/size-status?path=" + encodeURIComponent(dir) +
        (state.showHidden ? "&hidden=1" : ""), 10000)
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (_sizePollPath !== dir) return;
          // 本地更新已算好的目录大小，不重新请求 /api/files（大目录会超时）
          if (d && d.sizes && state.path === dir) {
            var changed = false;
            state.items.forEach(function (it) {
              if (it.is_dir && Object.prototype.hasOwnProperty.call(d.sizes, it.name)) {
                it.size = d.sizes[it.name];
                it.size_str = fmtDelBytes(it.size);
                it.size_pending = false;
                changed = true;
              }
            });
            if (changed) { renderList(); updateStatsLocal(); }
          }
          if (d.error || !d.pending || !d.pending.length) {
            stopSizePoll();   // 全部算完，本地已更新，不再 load 刷新
          }
        })
        .catch(function () { /* 网络抖动忽略，下轮再试 */ });
    }, 2500);
  }

  function renderBreadcrumb(absPath) {
    var bc = document.getElementById("bcScroll");
    bc.innerHTML = "";
    var parts = (absPath || "/").split("/").filter(Boolean);
    function addCrumb(text, target, current) {
      var c = document.createElement("span");
      c.className = "crumb" + (current ? " current" : "");
      c.textContent = text;
      if (!current && target !== undefined) {
        c.addEventListener("click", function () { load(target); });
      }
      bc.appendChild(c);
      if (!current) {
        var sep = document.createElement("span");
        sep.className = "crumb sep";
        sep.textContent = "/";
        bc.appendChild(sep);
      }
    }
    addCrumb("🏠", "/", false);
    var cum = "";
    for (var i = 0; i < parts.length; i++) {
      cum += "/" + parts[i];
      var isLast = i === parts.length - 1;
      addCrumb(parts[i], isLast ? undefined : cum, isLast);
    }
    bc.scrollLeft = bc.scrollWidth;
  }

  // 智能时间显示：今年省略年份，去年/前年用文字，更早显示完整日期
  function fmtTime(s) {
    if (!s) return "";
    var m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}:\d{2})/.exec(s);
    if (!m) return s;
    var thisY = new Date().getFullYear();
    var y = +m[1], md = m[2] + "-" + m[3], hm = m[4];
    if (y === thisY) return md + " " + hm;
    if (y === thisY - 1) return "去年 " + md + " " + hm;
    if (y === thisY - 2) return "前年 " + md + " " + hm;
    return s;   // 更早的年份：完整显示
  }

  function renderList() {
    var list = document.getElementById("list");
    list.className = "list body-pad " + (state.view === "grid" ? "grid" : "rows");
    list.innerHTML = "";
    var items = sortItems(state.items);
    if (items.length === 0) {
      var empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "空目录";
      list.appendChild(empty);
      return;
    }
    items.forEach(function (item) {
      var row = document.createElement("div");
      row.className = "item";
      var thumbHtml;
      if (canThumb(item)) {
        thumbHtml = '<img loading="lazy" src="/api/thumbnail?path=' +
          encodeURIComponent(itemAbs(item)) + '" alt="" onerror="this.parentNode.textContent=\'' +
          iconFor(item) + '\'">';
      } else {
        thumbHtml = iconHtmlFor(item);
      }
      var sub = item.size_str || "";
      if (item.mtime) sub += (sub ? "  ·  " : "") + fmtTime(item.mtime);
      if (!isDir(item)) sub += "  ·  " + fileTypeName(item);
      // 文件夹：下一级子项计数徽标（文件夹数 · 文件数）
      var cntHtml = "";
      if (isDir(item) && item.n_dirs != null) {
        var cp = [];
        if (item.n_dirs) cp.push("📁" + item.n_dirs);
        if (item.n_files) cp.push("📄" + item.n_files);
        cntHtml = '<span class="cnt">' + (cp.length ? cp.join(" · ") : "空") + '</span>';
      }
      row.innerHTML =
        '<div class="thumb">' + thumbHtml + '</div>' +
        '<div class="meta">' +
          '<div class="name-row"><div class="name">' + esc(item.name) + '</div>' + cntHtml + '</div>' +
          '<div class="gtime">' + esc(fmtTime(item.ctime || "")) + '</div>' +
          '<div class="sub">' + esc(sub) + '</div>' +
        '</div>' +
        // 文件点行即打开操作菜单，无需 ⋯；文件夹保留（点行是进入目录，⋯ 是唯一操作入口）
        (isDir(item) ? '<button class="more" aria-label="更多">⋯</button>' : '');
      var abs = itemAbs(item);
      row.setAttribute("data-abs", abs);
      if (state.selMode) {
        var chk = document.createElement("span");
        chk.className = "sel-check" + (state.selSet[abs] ? " on" : "");
        chk.textContent = "✓";
        row.insertBefore(chk, row.firstChild);
        if (state.selSet[abs]) row.classList.add("sel-on");
        var moreBtn = row.querySelector(".more");
        if (moreBtn) moreBtn.style.display = "none";
        row.addEventListener("click", function () {
          if (lpFired) { lpFired = false; return; }
          toggleSel(abs);
        });
      } else {
        row.addEventListener("click", function () {
          if (lpFired) { lpFired = false; return; }
          if (isDir(item)) load(itemAbs(item));
          else openActions(item);
        });
        var moreBtn2 = row.querySelector(".more");
        if (moreBtn2) moreBtn2.addEventListener("click", function (e) {
          e.stopPropagation();
          openActions(item);
        });
        // 文件：点缩略图图标直接预览（点行其余部分仍是操作菜单）
        if (!isDir(item)) {
          var th = row.querySelector(".thumb");
          if (th) th.addEventListener("click", function (e) {
            e.stopPropagation();
            if (lpFired) { lpFired = false; return; }
            openPreview(item);
          });
        }
        bindLongPress(row, function () { enterSelMode(); toggleSel(itemAbs(item)); });
      }
      list.appendChild(row);
    });
  }

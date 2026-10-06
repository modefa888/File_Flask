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
    // 列表重建：先丢弃旧的时长观察目标，避免残留
    if (_vdurObserver) { _vdurObserver.disconnect(); _vdurObserver = null; }
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
        // 缩略图加载失败只替换这张图本身，别把父节点内容整体清掉（大小角标会被一起抹掉）
        thumbHtml = '<img loading="lazy" src="/api/thumbnail?path=' +
          encodeURIComponent(itemAbs(item)) + '" alt="" onerror="this.outerHTML=\'' +
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
      // 图标视图也看得到大小：贴在缩略图底部当角标；目录还在后台统计时先占位"计算中…"
      var gsize = item.size_str || (item.is_dir && item.size_pending ? "计算中…" : "");
      // 图片缩略图底图不可控，角标要用深色胶囊；图标/文件夹是浅色底，纯灰字更干净
      var gsizeHtml = gsize
        ? '<span class="gsize' + (canThumb(item) ? " over" : "") + '">' + esc(gsize) + '</span>'
        : "";
      // 视频：左上角时长角标（与电脑版一致）。时长要问后端（ffprobe），先占位，进入视口再请求。
      // 注意：这里不能按 state.view 判断——切视图只改容器 class、不会重渲染列表，
      // 若列表视图下不生成元素，之后切到图标视图就永远补不出来（显示与否交给 CSS）。
      var vdurHtml = (!isDir(item) && VIDEO_EXT.indexOf(extOf(item.name)) >= 0)
        ? '<span class="vdur" data-path="' + esc(itemAbs(item)) + '"></span>'
        : "";
      row.innerHTML =
        '<div class="thumb">' + thumbHtml + vdurHtml + gsizeHtml + '</div>' +
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
      // 时长懒加载：滚到附近才去问后端，避免一屏视频同时打出几十个 ffprobe
      var vdurEl = row.querySelector(".vdur");
      if (vdurEl) observeVideoDuration(vdurEl);
    });
  }


  // ---------- 视频时长（图标视图左上角角标） ----------
  var _vdurObserver = null;
  function observeVideoDuration(el) {
    if (!("IntersectionObserver" in window)) { loadVideoDuration(el); return; }
    if (!_vdurObserver) {
      _vdurObserver = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          if (!en.isIntersecting) return;
          _vdurObserver.unobserve(en.target);
          loadVideoDuration(en.target);
        });
      }, { rootMargin: "300px 0px" });
    }
    _vdurObserver.observe(el);
  }
  function loadVideoDuration(el) {
    var path = el.getAttribute("data-path");
    if (!path) { el.remove(); return; }
    fetchTimeout("/api/video_duration?path=" + encodeURIComponent(path), 20000)
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (d && d.duration != null) { setVdurText(el, d.duration); return; }
        probeDurationByVideo(el, path);   // 服务端读不到（缺 ffprobe / 非常规容器）→ 交给浏览器
      })
      .catch(function () { probeDurationByVideo(el, path); });
  }
  // 兜底：让浏览器自己解析媒体元数据（走 Range 只读文件头，大文件也就几百毫秒）
  function probeDurationByVideo(el, path) {
    var v = document.createElement("video");
    v.preload = "metadata";
    v.muted = true;
    var done = false;
    function finish(ok) {
      if (done) return;
      done = true;
      try { v.removeAttribute("src"); v.load(); } catch (e) {}
      if (!ok) el.remove();          // 两边都拿不到就收掉，别留个空角标
    }
    v.addEventListener("loadedmetadata", function () {
      var d = v.duration;
      if (d && isFinite(d) && d > 0) { setVdurText(el, d); finish(true); }
      else finish(false);
    });
    v.addEventListener("error", function () { finish(false); });
    setTimeout(function () { finish(false); }, 15000);
    v.src = "/api/stream?path=" + encodeURIComponent(path);
  }
  function setVdurText(el, sec) {
    var txt = fmtDuration(sec);
    el.textContent = txt;
    el.title = "时长 " + txt;
  }
  // 秒 → mm:ss / h:mm:ss
  function fmtDuration(sec) {
    sec = Math.max(0, Math.round(Number(sec) || 0));
    var h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
    function pad(n) { return (n < 10 ? "0" : "") + n; }
    return (h ? h + ":" + pad(m) : String(m)) + ":" + pad(s);
  }

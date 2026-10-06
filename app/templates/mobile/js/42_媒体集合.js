  // ---------- 媒体集合：图片 / 视频 / 音频（基于本地索引聚合） ----------
  var _md = {
    type: "all", keyword: "", page: 0, size: 30,
    total: 0, pages: 0, loading: false, items: [], token: 0,
    min_size: 0, max_size: 0, lastSig: ""
  };
  // 切换结果缓存：条件签名 -> {page,total,pages,items}。
  // 切回已经看过的分类 / 页时直接渲染缓存，不再重复请求。
  var _mdCache = {};

  // 各条件（不含页码）最后浏览的页码：切走再切回来停在原来那一页
  var _mdPageMem = {};

  // 各面板最后停留的滚动位置：切回来仍停在原来的位置
  var _mdScrollMem = {};

  var MD_CAT = {
    image: { label: "图片", ico: "🖼️", color: "#059669" },
    video: { label: "视频", ico: "🎬", color: "#dc2626" },
    audio: { label: "音频", ico: "🎵", color: "#7c3aed" },
    other: { label: "文件", ico: "📄", color: "#64748b" }
  };

  // ===== 大小筛选：全部/视频/音频/图片 各自独立，本地持久化（与电脑版同一套规则） =====
  var MD_FILTER_KEY = "fm_mobile_media_filter_v1";
  var MD_FILTER_UNITS = [[1, "B"], [1024, "KB"], [1048576, "MB"], [1073741824, "GB"]];
  var MD_FILTER_LABELS = { all: "全部", video: "视频", audio: "音频", image: "图片" };
  var _mdFilter = {
    all: { min: "", max: "", unit: 1048576 },
    video: { min: "", max: "", unit: 1048576 },
    audio: { min: "", max: "", unit: 1048576 },
    image: { min: "", max: "", unit: 1048576 }
  };
  (function loadMdFilter() {
    var obj = spLsGet(MD_FILTER_KEY, null);
    if (!obj) return;
    Object.keys(_mdFilter).forEach(function (k) {
      var it = obj[k];
      if (!it) return;
      var mn = Number(it.min), mx = Number(it.max);
      _mdFilter[k] = {
        min: (it.min === "" || it.min == null || !isFinite(mn) || mn <= 0) ? "" : mn,
        max: (it.max === "" || it.max == null || !isFinite(mx) || mx <= 0) ? "" : mx,
        unit: Number(it.unit) || 1048576
      };
    });
  })();

  // 把「当前分类」的设置换算成字节写入查询条件（0 = 不限）
  function mdApplyFilter() {
    var s = _mdFilter[_md.type] || _mdFilter.all;
    var unit = Number(s.unit) || 1;
    var mn = parseFloat(s.min), mx = parseFloat(s.max);
    _md.min_size = (isFinite(mn) && mn > 0) ? Math.round(mn * unit) : 0;
    _md.max_size = (isFinite(mx) && mx > 0) ? Math.round(mx * unit) : 0;
  }

  // 「全部」视图下：把三个分类各自的区间拼成 filters 参数（只包含设置过的分类，
  // 没设置的分类保持全部保留）。切到具体分类时不传，只套用该分类自己的设置。
  function mdCatFilterParam() {
    if (_md.type !== "all") return "";
    var parts = [];
    ["video", "audio", "image"].forEach(function (k) {
      var s = _mdFilter[k] || {};
      var unit = Number(s.unit) || 1;
      var mn = parseFloat(s.min), mx = parseFloat(s.max);
      var a = (isFinite(mn) && mn > 0) ? Math.round(mn * unit) : 0;
      var b = (isFinite(mx) && mx > 0) ? Math.round(mx * unit) : 0;
      if (a || b) parts.push(k + ":" + a + "-" + b);
    });
    return parts.join(",");
  }

  // 当前分类设了筛选就把 ⚙️ 点亮
  function mdUpdateFilterBadge() {
    var btn = document.getElementById("mdFilterBtn");
    if (!btn) return;
    var s = _mdFilter[_md.type] || _mdFilter.all;
    btn.classList.toggle("on", (parseFloat(s.min) > 0) || (parseFloat(s.max) > 0));
  }

  function mdSize(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
    if (n < 1073741824) return (n / 1048576).toFixed(1) + " MB";
    return (n / 1073741824).toFixed(2) + " GB";
  }

  // 媒体项 → 通用文件项（供预览 / 操作弹窗 / 播放器复用）
  function mdToItem(it) {
    return {
      name: it.name, is_dir: false, abs_path: it.path,
      size: it.size || 0, size_str: mdSize(it.size),
      mtime: it.mtime || "", ext: it.ext || ""
    };
  }

  function mdStat(text) {
    document.getElementById("mdStat").textContent = text || "";
  }

  function openMediaPage() {
    document.getElementById("mediaPage").classList.add("show");
    document.body.classList.add("lock");
    _mdCache = {};          // 每次打开都重新取数据，避免看到已删除 / 已改动的旧列表
    _mdPageMem = {};        // 页码记忆一并重置
    _mdScrollMem = {};      // 滚动位置记忆一并重置
    var mb = document.getElementById("mdBody");
    if (mb) mb.innerHTML = "";   // 同时清掉上一次留下的结果面板与提示
    _md.type = "all";
    _md.keyword = "";
    var kw = document.getElementById("mdKeyword");
    if (kw) kw.value = "";
    Array.prototype.forEach.call(document.querySelectorAll("#mdTabs .md-tab"), function (b) {
      b.classList.toggle("on", b.getAttribute("data-type") === "all");
    });
    mdUpdateFilterBadge();
    mdLoad(1);
  }

  function closeMediaPage() {
    mdCloseSearch();        // 顺手收起搜索浮层，避免下次打开还挂着
    document.getElementById("mediaPage").classList.remove("show");
    document.body.classList.remove("lock");
    _md.token++;            // 让在途请求失效，避免关闭后仍渲染
    _md.loading = false;
  }

  // 不含页码的条件键：用来记住每个分类 / 搜索 / 筛选各自看到第几页
  function mdCondKey() {
    mdApplyFilter();
    return _md.type + "|" + _md.keyword + "|" + _md.size +
      "|" + mdCatFilterParam() + "|" + _md.min_size + "|" + _md.max_size;
  }

  // 切回某个分类时，恢复上次浏览的页码
  function mdRememberedPage() {
    var p = parseInt(_mdPageMem[mdCondKey()], 10);
    return p > 0 ? p : 1;
  }

  // 加载一页数据：结果按条件签名缓存，并渲染到独立面板，切回来直接复用
  function mdLoad(page) {
    page = Math.max(1, parseInt(page, 10) || 1);
    var body = document.getElementById("mdBody");
    mdApplyFilter();
    var catParam = mdCatFilterParam();
    // condKey = 不含页码的条件；sig = 条件 + 页码，任一变化都会得到不同的键
    var condKey = _md.type + "|" + _md.keyword + "|" + _md.size +
      "|" + catParam + "|" + _md.min_size + "|" + _md.max_size;
    var sig = condKey + "|" + page;

    // 命中缓存：直接渲染，切分类 / 切回来都不再发请求
    var hit = _mdCache[sig];
    if (hit) {
      _md.token++;          // 作废在途请求，避免它的响应回来覆盖当前列表
      _md.loading = false;
      _md.lastSig = sig;
      _md.page = hit.page; _md.total = hit.total; _md.pages = hit.pages;
      _md.items = hit.items;
      _mdPageMem[condKey] = _md.page;
      mdRender();               // 位置由 mdShowPane 按记忆恢复
      return;
    }
    // 只有「条件完全相同」的重复点击（连点翻页）才忽略
    if (_md.loading && sig === _md.lastSig) return;
    _md.lastSig = sig;
    _md.loading = true;
    _md.items = [];
    mdShowMsg("加载中…");
    var tk = ++_md.token;
    var params = "type=" + encodeURIComponent(_md.type) +
      "&keyword=" + encodeURIComponent(_md.keyword) +
      "&page=" + page + "&page_size=" + _md.size;
    // 「全部」视图：带上各分类自己的区间，列表与统计都按分类规则合并
    if (catParam) params += "&filters=" + encodeURIComponent(catParam);
    params += "&min_size=" + (_md.min_size || 0) + "&max_size=" + (_md.max_size || 0);
    fetchTimeout("/api/media/collection?" + params, 25000)
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (tk !== _md.token) return;
        _md.loading = false;
        if (d.error) {
          mdShowMsg(esc(d.error));
          mdStat("");
          return;
        }
        _md.page = d.page || page;
        _md.total = d.total || 0;
        _md.pages = d.total_pages || 0;
        _md.items = d.items || [];
        // 写入缓存，下次切回同一分类 / 同一页直接复用
        _mdCache[sig] = { page: _md.page, total: _md.total, pages: _md.pages, items: _md.items };
        _mdPageMem[condKey] = _md.page;      // 记住该分类看到第几页
        mdRender();                          // 新页面无位置记忆，自然回到顶部
      })
      .catch(function () {
        if (tk !== _md.token) return;
        _md.loading = false;
        mdShowMsg("加载失败，请重试");
        mdStat("");
      });
  }

  // 切换结果面板：已渲染过的条件直接复用原面板 —— 里面的图片元素不重建，
  // 所以切分类不会再发一遍缩略图请求，也不会有重新加载的闪烁。
  function mdShowPane(sig) {
    var body = document.getElementById("mdBody");
    Array.prototype.forEach.call(body.querySelectorAll(".md-pane"), function (p) {
      p.style.display = (p.getAttribute("data-sig") === sig) ? "" : "none";
    });
    var msg = body.querySelector(".md-msg");
    if (msg) msg.style.display = "none";
    body.scrollTop = _mdScrollMem[sig] || 0;   // 回到上次停留的位置
  }

  // 实时记录当前面板的滚动位置，切回来时才能恢复到原处
  document.getElementById("mdBody").addEventListener("scroll", function () {
    if (_md.lastSig) _mdScrollMem[_md.lastSig] = this.scrollTop;
  }, { passive: true });

  // 加载中 / 出错 / 空结果提示：隐藏所有面板，只显示一条居中提示
  function mdShowMsg(html) {
    var body = document.getElementById("mdBody");
    Array.prototype.forEach.call(body.querySelectorAll(".md-pane"), function (p) { p.style.display = "none"; });
    var msg = body.querySelector(".md-msg");
    if (!msg) {
      msg = document.createElement("div");
      msg.className = "md-empty md-msg";
      body.appendChild(msg);
    }
    msg.innerHTML = html;
    msg.style.display = "";
    body.scrollTop = 0;
  }

  function mdRender() {
    var body = document.getElementById("mdBody");
    var sig = _md.lastSig;
    var items = _md.items;
    mdStat((_md.total || 0).toLocaleString() + " 个");

    // 这个条件已经渲染过：直接显示原面板，不重建 DOM
    var cached = _mdCache[sig];
    if (cached && cached.pane && cached.pane.parentNode === body) {
      mdShowPane(sig);
      return;
    }

    var pane = document.createElement("div");
    pane.className = "md-pane";
    pane.setAttribute("data-sig", sig);
    var h;
    if (!items.length) {
      h = '<div class="md-empty"><span class="md-empty-ico">🖼️</span><br>没有找到媒体文件<br>（换个分类或清空关键字再试）</div>';
    } else {
      h = '<div class="md-grid">' + items.map(function (it, i) {
        var c = MD_CAT[it.category] || MD_CAT.other;
        // 只有图片 / 视频才有缩略图；音频等类型直接用图标，省掉无谓的 thumbnail 请求
        var thumbHtml = (it.category === "image" || it.category === "video")
          ? '<img loading="lazy" alt="" src="/api/thumbnail?path=' + encodeURIComponent(it.path) + '" onerror="this.remove()">'
          : "";
        return '<div class="md-card" data-i="' + i + '">' +
          '<div class="md-thumb">' +
            '<div class="md-fb">' + c.ico + '</div>' +
            thumbHtml +
            '<span class="md-cat" style="background:' + c.color + '">' + c.label + '</span>' +
            '<button class="md-more" data-act="more" title="更多操作">⋯</button>' +
          '</div>' +
          '<div class="md-info">' +
            '<div class="md-name">' + esc(it.name) + '</div>' +
            '<div class="md-sub">' + mdSize(it.size) + (it.ext ? ' · ' + esc(String(it.ext).toUpperCase()) : '') + '</div>' +
          '</div>' +
        '</div>';
      }).join("") + '</div>';
      // 分页条
      var pages = Math.max(1, _md.pages || 1);
      h += '<div class="md-pager">' +
        '<button class="md-pg-btn" data-pg="prev"' + (_md.page <= 1 ? " disabled" : "") + '>‹ 上一页</button>' +
        '<span class="md-pg-info">第 ' +
          '<input class="md-pg-input" type="number" inputmode="numeric" min="1" max="' + pages +
          '" value="' + _md.page + '"> / ' + pages + ' 页</span>' +
        '<button class="md-pg-btn" data-pg="go">跳转</button>' +
        '<button class="md-pg-btn" data-pg="next"' + (_md.page >= pages ? " disabled" : "") + '>下一页 ›</button>' +
      '</div>';
    }
    pane.innerHTML = h;
    body.appendChild(pane);
    if (cached) cached.pane = pane;      // 挂到缓存上，下次切换直接复用
    mdShowPane(sig);
  }

  // 跳到页码输入框里指定的页（超出范围自动夹在 1 ~ 总页数之间）
  function mdGotoTyped(btn) {
    var pane = btn && btn.closest ? btn.closest(".md-pane") : null;
    var inp = pane && pane.querySelector(".md-pg-input");
    if (!inp) return;
    var total = Math.max(1, _md.pages || 1);
    var p = parseInt(inp.value, 10);
    if (!(p > 0)) p = 1;
    p = Math.max(1, Math.min(total, p));
    inp.value = p;
    if (p === _md.page) return;
    mdLoad(p);
  }

  // 页码输入框里回车 = 点「跳转」
  document.getElementById("mdBody").addEventListener("keydown", function (e) {
    if (e.key !== "Enter") return;
    var inp = e.target.closest && e.target.closest(".md-pg-input");
    if (!inp) return;
    e.preventDefault();
    var pager = inp.closest(".md-pager");
    mdGotoTyped(pager && pager.querySelector('[data-pg="go"]'));
  });

  // 点分页按钮：翻页 / 跳页；点卡片：预览；点 ⋯：完整操作菜单（分享、下载、删除…）
  document.getElementById("mdBody").addEventListener("click", function (e) {
    var pg = e.target.closest && e.target.closest("[data-pg]");
    if (pg) {
      if (pg.disabled) return;
      var act = pg.getAttribute("data-pg");
      if (act === "go") { mdGotoTyped(pg); return; }
      mdLoad(act === "next" ? _md.page + 1 : _md.page - 1);
      return;
    }
    var card = e.target.closest && e.target.closest(".md-card");
    if (!card) return;
    var it = _md.items[parseInt(card.getAttribute("data-i"), 10)];
    if (!it) return;
    var item = mdToItem(it);
    var ctx = _md.items.map(mdToItem);
    if (e.target.closest(".md-more")) { openActions(item, ctx); return; }
    openPreview(item, ctx);
  });

  function mdSearch() {
    var kw = document.getElementById("mdKeyword");
    _md.keyword = kw ? kw.value.trim() : "";
    mdLoad(1);
  }

  Array.prototype.forEach.call(document.querySelectorAll("#mdTabs .md-tab"), function (b) {
    b.addEventListener("click", function () {
      if (b.classList.contains("on")) return;
      Array.prototype.forEach.call(document.querySelectorAll("#mdTabs .md-tab"), function (x) {
        x.classList.toggle("on", x === b);
      });
      _md.type = b.getAttribute("data-type");
      mdUpdateFilterBadge();
      mdLoad(mdRememberedPage());   // 回到该分类上次浏览的页码
    });
  });

  // 搜索浮层：点顶栏 🔍 从底部弹出，输入后回车或点「搜索」执行
  function mdOpenSearch() {
    var pop = document.getElementById("mdSearchPop");
    var mask = document.getElementById("mdSearchMask");
    if (!pop) return;
    pop.classList.add("show");
    if (mask) mask.classList.add("show");
    var kw = document.getElementById("mdKeyword");
    if (kw) {
      kw.value = _md.keyword || "";
      setTimeout(function () { try { kw.focus(); } catch (e) {} }, 60);
    }
  }
  function mdCloseSearch() {
    var pop = document.getElementById("mdSearchPop");
    var mask = document.getElementById("mdSearchMask");
    if (pop) pop.classList.remove("show");
    if (mask) mask.classList.remove("show");
  }
  document.getElementById("mdSearchBtn").addEventListener("click", mdOpenSearch);
  document.getElementById("mdSearchMask").addEventListener("click", mdCloseSearch);
  document.getElementById("mdGo").addEventListener("click", function () {
    mdSearch();
    mdCloseSearch();
  });
  document.getElementById("mdKeyword").addEventListener("keydown", function (e) {
    if (e.key === "Enter") {
      e.preventDefault();
      mdSearch();
      mdCloseSearch();
      this.blur();
    } else if (e.key === "Escape") {
      mdCloseSearch();
      this.blur();
    }
  });
  // ===== 大小筛选设置面板（按分类分别设置，留空表示不限） =====
  function showMdFilterSettings() {
    var rows = ["all", "video", "audio", "image"].map(function (key) {
      var s = _mdFilter[key] || {};
      var cur = Number(s.unit || 1048576);
      var units = MD_FILTER_UNITS.map(function (u) {
        return '<option value="' + u[0] + '"' + (cur === u[0] ? " selected" : "") + '>' + u[1] + '</option>';
      }).join("");
      var minV = (s.min === "" || s.min == null) ? "" : s.min;
      var maxV = (s.max === "" || s.max == null) ? "" : s.max;
      return '<div class="msf-row" data-key="' + key + '">' +
        '<span class="msf-name">' + MD_FILTER_LABELS[key] + '</span>' +
        '<input class="msf-input" data-role="min" type="number" inputmode="decimal" min="0" step="1" placeholder="最小" value="' + minV + '">' +
        '<span class="msf-sep">~</span>' +
        '<input class="msf-input" data-role="max" type="number" inputmode="decimal" min="0" step="1" placeholder="最大" value="' + maxV + '">' +
        '<select class="msf-unit">' + units + '</select>' +
      '</div>';
    }).join("");

    var body = document.getElementById("ssBody");
    body.innerHTML =
      '<div class="ss-hint" style="margin-top:0">按分类分别设置文件大小范围（留空表示不限）。「全部」下会按各分类的规则合并显示与统计（视频 ≥1MB、图片 ≥0.1MB …），切到具体分类则只套用该分类的设置；设置保存在本机。</div>' +
      '<div class="msf-body">' + rows + '</div>' +
      '<div class="ss-btns">' +
        '<button class="ss-btn" id="msfReset">重置</button>' +
        '<button class="ss-btn primary" id="msfApply">应用筛选</button>' +
      '</div>';

    document.getElementById("msfReset").addEventListener("click", function () {
      Array.prototype.forEach.call(body.querySelectorAll(".msf-row"), function (row) {
        Array.prototype.forEach.call(row.querySelectorAll(".msf-input"), function (i) { i.value = ""; });
        var u = row.querySelector(".msf-unit");
        if (u) u.value = "1048576";
      });
    });

    document.getElementById("msfApply").addEventListener("click", function () {
      var swapped = [];
      Array.prototype.forEach.call(body.querySelectorAll(".msf-row"), function (row) {
        var key = row.getAttribute("data-key");
        var minEl = row.querySelector('[data-role="min"]');
        var maxEl = row.querySelector('[data-role="max"]');
        var unitEl = row.querySelector(".msf-unit");
        var mn = parseFloat((minEl && minEl.value) || "");
        var mx = parseFloat((maxEl && maxEl.value) || "");
        if (isFinite(mn) && isFinite(mx) && mn > 0 && mx > 0 && mn > mx) {
          swapped.push(MD_FILTER_LABELS[key] || key);
          var t = mn; mn = mx; mx = t;      // 写反了自动对调
        }
        _mdFilter[key] = {
          min: (isFinite(mn) && mn > 0) ? mn : "",
          max: (isFinite(mx) && mx > 0) ? mx : "",
          unit: Number((unitEl && unitEl.value) || 1048576) || 1048576
        };
      });
      spLsSet(MD_FILTER_KEY, _mdFilter);
      if (swapped.length) toast(swapped.join("、") + " 的最小值大于最大值，已自动对调", "info");
      shareSheetClose();
      mdUpdateFilterBadge();
      mdLoad(1);
    });

    shareSheetOpen("设置大小筛选");
  }

  document.getElementById("mdFilterBtn").addEventListener("click", showMdFilterSettings);
  document.getElementById("mdBack").addEventListener("click", closeMediaPage);
  document.getElementById("mdClose").addEventListener("click", closeMediaPage);
  document.getElementById("mmMediaBtn").addEventListener("click", function () {
    toggleMoreMenu(false);
    openMediaPage();
  });

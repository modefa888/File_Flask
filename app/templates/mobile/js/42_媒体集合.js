  // ---------- 媒体集合：图片 / 视频 / 音频（基于本地索引聚合） ----------
  var _md = {
    type: "all", keyword: "", page: 0, size: 30,
    total: 0, pages: 0, loading: false, items: [], token: 0,
    min_size: 0, max_size: 0
  };
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
    _md.type = "all";
    _md.keyword = "";
    var kw = document.getElementById("mdKeyword");
    if (kw) kw.value = "";
    Array.prototype.forEach.call(document.querySelectorAll("#mdTabs .md-tab"), function (b) {
      b.classList.toggle("on", b.getAttribute("data-type") === "all");
    });
    mdUpdateFilterBadge();
    mdLoad(false);
  }

  function closeMediaPage() {
    document.getElementById("mediaPage").classList.remove("show");
    document.body.classList.remove("lock");
    _md.token++;            // 让在途请求失效，避免关闭后仍渲染
    _md.loading = false;
  }

  function mdLoad(more) {
    if (_md.loading) return;
    if (more && (!_md.pages || _md.page >= _md.pages)) return;
    var body = document.getElementById("mdBody");
    _md.loading = true;
    var page = more ? _md.page + 1 : 1;
    if (!more) {
      _md.items = [];
      _md.page = 0;
      body.innerHTML = '<div class="md-empty">加载中…</div>';
      mdStat("");
    }
    var tk = ++_md.token;
    mdApplyFilter();
    var params = "type=" + encodeURIComponent(_md.type) +
      "&keyword=" + encodeURIComponent(_md.keyword) +
      "&page=" + page + "&page_size=" + _md.size;
    // 「全部」视图：带上各分类自己的区间，列表与统计都按分类规则合并
    var catParam = mdCatFilterParam();
    if (catParam) params += "&filters=" + encodeURIComponent(catParam);
    params += "&min_size=" + (_md.min_size || 0) + "&max_size=" + (_md.max_size || 0);
    fetchTimeout("/api/media/collection?" + params, 25000)
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (tk !== _md.token) return;
        _md.loading = false;
        if (d.error) {
          body.innerHTML = '<div class="md-empty">' + esc(d.error) + '</div>';
          mdStat("");
          return;
        }
        _md.page = d.page || page;
        _md.total = d.total || 0;
        _md.pages = d.total_pages || 0;
        _md.items = _md.items.concat(d.items || []);
        mdRender();
      })
      .catch(function () {
        if (tk !== _md.token) return;
        _md.loading = false;
        if (!_md.items.length) {
          body.innerHTML = '<div class="md-empty">加载失败，请下拉重试</div>';
          mdStat("");
        } else {
          toast("加载失败，请重试", "error");
        }
      });
  }

  function mdRender() {
    var body = document.getElementById("mdBody");
    var items = _md.items;
    var keepTop = body.scrollTop;      // 追加加载时保持滚动位置
    mdStat("共 " + (_md.total || 0).toLocaleString() + " 个媒体 · 已显示 " + items.length);
    if (!items.length) {
      body.innerHTML = '<div class="md-empty">🖼️<br>没有找到媒体文件<br>（换个分类或清空关键字再试）</div>';
      return;
    }
    var h = '<div class="md-grid">' + items.map(function (it, i) {
      var c = MD_CAT[it.category] || MD_CAT.other;
      return '<div class="md-card" data-i="' + i + '">' +
        '<div class="md-thumb">' +
          '<div class="md-fb">' + c.ico + '</div>' +
          '<img loading="lazy" alt="" src="/api/thumbnail?path=' + encodeURIComponent(it.path) + '" onerror="this.remove()">' +
          '<span class="md-cat" style="background:' + c.color + '">' + c.label + '</span>' +
          '<button class="md-more" data-act="more" title="更多操作">⋯</button>' +
        '</div>' +
        '<div class="md-info">' +
          '<div class="md-name">' + esc(it.name) + '</div>' +
          '<div class="md-sub">' + mdSize(it.size) + (it.ext ? ' · ' + esc(String(it.ext).toUpperCase()) : '') + '</div>' +
        '</div>' +
      '</div>';
    }).join("") + '</div>';
    if (_md.pages && _md.page < _md.pages) {
      h += '<div class="md-foot"><button id="mdMoreBtn">加载更多（' + items.length + '/' + _md.total + '）</button></div>';
    } else {
      h += '<div class="md-foot"><span>— 已全部加载 —</span></div>';
    }
    body.innerHTML = h;
    body.scrollTop = keepTop;
    var more = document.getElementById("mdMoreBtn");
    if (more) more.addEventListener("click", function () { mdLoad(true); });
  }

  // 点卡片：预览（图片 / 视频 / 音频按类型自动分流）；点 ⋯：完整操作菜单（分享、下载、删除…）
  document.getElementById("mdBody").addEventListener("click", function (e) {
    var card = e.target.closest && e.target.closest(".md-card");
    if (!card) return;
    var it = _md.items[parseInt(card.getAttribute("data-i"), 10)];
    if (!it) return;
    var item = mdToItem(it);
    var ctx = _md.items.map(mdToItem);
    if (e.target.closest(".md-more")) { openActions(item, ctx); return; }
    openPreview(item, ctx);
  });

  // 滚动接近底部自动加载下一页
  document.getElementById("mdBody").addEventListener("scroll", function () {
    if (_md.loading || !_md.pages || _md.page >= _md.pages) return;
    var el = this;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 260) mdLoad(true);
  }, { passive: true });

  function mdSearch() {
    var kw = document.getElementById("mdKeyword");
    _md.keyword = kw ? kw.value.trim() : "";
    mdLoad(false);
  }

  Array.prototype.forEach.call(document.querySelectorAll("#mdTabs .md-tab"), function (b) {
    b.addEventListener("click", function () {
      if (b.classList.contains("on")) return;
      Array.prototype.forEach.call(document.querySelectorAll("#mdTabs .md-tab"), function (x) {
        x.classList.toggle("on", x === b);
      });
      _md.type = b.getAttribute("data-type");
      mdUpdateFilterBadge();
      mdLoad(false);
    });
  });

  document.getElementById("mdGo").addEventListener("click", mdSearch);
  document.getElementById("mdKeyword").addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); mdSearch(); }
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
      mdLoad(false);
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

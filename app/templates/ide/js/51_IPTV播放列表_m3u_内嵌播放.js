  /* ================================================================
   * IPTV 播放列表（.m3u / .m3u8）标签页内播放
   * ----------------------------------------------------------------
   * 打开 iptv-fe.m3u 这类播放列表时仍是普通文本编辑（方便改台标 / 换源），
   * 编辑器右上角多一个「▶ 播放」按钮：点一下原标签页内切成播放器 ——
   * 左侧画面，右侧「播放列表」（按 group-title 分组、可搜索、点台即切），
   * 视觉完全复用 22_ 视频播放器的 .vpv-* 皮肤（深色 / 白天主题一起跟着走）。
   *
   * 数据来源：POST /api/iptv/playlist {path, text}  服务端解析 #EXTINF（名称 / 分组 / 台标），
   * 带上编辑器缓冲区 → 「改了还没保存」的播放列表点播放也立刻按新内容生效
   * 播放链路：远端 m3u8 → /api/iptv/proxy（解决跨域 + 混合内容，并把子播放列表、
   *           分片、密钥 URI 改写成代理地址）→ hls.js（/static/vendor/hls/hls.min.js）。
   * 本文件在 00_preamble 的大 IIFE 关闭之后加载，只能拿到 window 上导出的东西，
   * 因此对外只暴露 setupM3uView（由 openFile 的 m3u 分支调用）。
   * ================================================================ */

  // 交给本播放器的扩展名：m3u 是 IPTV 频道列表；单码率 m3u8 也能打开（解析不到频道会给提示）
  var IDE_IPTV_EXTS = ["m3u", "m3u8"];

  var _iptvHlsLoader = null;
  /* 懒加载 hls.js：只有真的要播 HLS 才去拉这 500KB，普通 m3u 只看不改的不受影响 */
  function iptvLoadHls() {
    if (window.Hls) return Promise.resolve(window.Hls);
    if (_iptvHlsLoader) return _iptvHlsLoader;
    _iptvHlsLoader = new Promise(function (resolve) {
      var s = document.createElement("script");
      s.src = "/static/vendor/hls/hls.min.js";
      s.onload = function () { resolve(window.Hls || null); };
      s.onerror = function () { resolve(null); };
      document.head.appendChild(s);
    });
    return _iptvHlsLoader;
  }

  function iptvEsc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // 音量 / 静音与视频播放器共用一份偏好（localStorage["ide.videoPlayer"]），
  // 这样在播放器里调过音量，回头打开普通视频也是同一个音量
  var _iptvPrefs = (function () {
    var def = { volume: 1, muted: false, plFold: false };
    try { return Object.assign(def, JSON.parse(localStorage.getItem("ide.videoPlayer") || "{}")); }
    catch (_) { return def; }
  })();
  function _iptvSavePrefs() {
    try { localStorage.setItem("ide.videoPlayer", JSON.stringify(_iptvPrefs)); } catch (_) { }
  }

  /* 本地观看记录：最近看过的频道，按 URL 去重、最多 50 条，
     存 localStorage["ide.iptv.history"]，关页面 / 换播放列表都还在 */
  var IPTV_HIS_KEY = "ide.iptv.history";
  var IPTV_HIS_MAX = 50;
  function iptvLoadHistory() {
    try {
      var arr = JSON.parse(localStorage.getItem(IPTV_HIS_KEY) || "[]");
      return Array.isArray(arr) ? arr : [];
    } catch (_) { return []; }
  }
  function iptvSaveHistory(list) {
    try { localStorage.setItem(IPTV_HIS_KEY, JSON.stringify(list.slice(0, IPTV_HIS_MAX))); } catch (_) { }
  }
  function iptvTimeAgo(t) {
    var d = Date.now() - (t || 0);
    if (d < 60e3) return "刚刚";
    if (d < 3600e3) return Math.floor(d / 60e3) + "分钟前";
    if (d < 86400e3) return Math.floor(d / 3600e3) + "小时前";
    var dt = new Date(t);
    var pad = function (n) { return (n < 10 ? "0" : "") + n; };
    return (dt.getFullYear() !== new Date().getFullYear() ? dt.getFullYear() + "年" : "") +
      (dt.getMonth() + 1) + "月" + dt.getDate() + "日 " + pad(dt.getHours()) + ":" + pad(dt.getMinutes());
  }

  /* ================================================================
   * 一、文本编辑页右上角的「播放」按钮
   * ================================================================ */
  function setupM3uView(tab) {
    if (!tab || !tab.host || tab.iptvTb) return;
    var tb = document.createElement("div");
    tb.className = "m3u-tb";
    tb.innerHTML = '<button data-a="play" title="解析这个播放列表并在当前标签页内播放">' +
      '<i class="bi bi-play-circle-fill"></i>播放</button>';
    var btn = tb.querySelector("button");
    btn.addEventListener("mousedown", function (e) { e.preventDefault(); });   // 不抢编辑器焦点
    btn.addEventListener("click", function () { iptvEnter(tab); });
    tab.host.appendChild(tb);
    tab.iptvTb = tb;
  }
  window.setupM3uView = setupM3uView;   // 供 00_preamble 的 openFile 调用

  /* ================================================================
   * 二、文本 ⇄ 播放器 切换
   * 编辑器不销毁、只是藏起来：返回编辑时内容 / 撤销历史 / 未保存改动全都在
   * ================================================================ */
  function iptvEnter(tab) {
    if (!tab || !tab.host || tab.iptvPlaying) return;
    var host = tab.host;
    var cmWrap = tab.cm ? tab.cm.getWrapperElement() : null;
    tab._iptvCmWrap = cmWrap;
    tab._iptvHidden = [];
    // 编辑器 + 各种浮动工具条（JSON / Markdown / 播放按钮）先全部藏起来，返回时按原样恢复
    Array.prototype.forEach.call(host.children, function (el) {
      if (el === cmWrap) return;
      tab._iptvHidden.push([el, el.style.display]);
      el.style.display = "none";
    });
    if (cmWrap) cmWrap.style.display = "none";
    tab.iptvPlaying = true;
    host.appendChild(iptvBuildView(tab));
  }

  function iptvExit(tab) {
    if (!tab || !tab.iptvPlaying) return;
    if (typeof tab._iptvDestroy === "function") {
      try { tab._iptvDestroy(); } catch (_) { }
      tab._iptvDestroy = null;
    }
    var root = tab.host.querySelector(".iptv-root");
    if (root) root.remove();
    (tab._iptvHidden || []).forEach(function (pair) {
      if (pair[0] && pair[0].parentNode) pair[0].style.display = pair[1] || "";
    });
    tab._iptvHidden = [];
    var cmWrap = tab._iptvCmWrap;
    if (cmWrap) {
      cmWrap.style.display = "";
      // 编辑器在 display:none 期间量不到尺寸，恢复后必须 refresh，否则行号/滚动条错乱
      if (tab.cm) setTimeout(function () { try { tab.cm.refresh(); } catch (_) { } }, 0);
    }
    tab.iptvPlaying = false;
  }

  /* ================================================================
   * 三、播放器本体
   * ================================================================ */
  function iptvBuildView(tab) {
    var host = tab.host;

    var root = document.createElement("div");
    root.className = "iptv-root vpv-wrap";
    if (_iptvPrefs.plFold) root.classList.add("no-side");
    root.innerHTML =
      '<div class="vpv-stage">' +
        '<video playsinline preload="none"></video>' +
        '<div class="vpv-title"></div>' +
        '<div class="vpv-seek-tip"></div>' +
        '<button class="vpv-side-toggle" title="收起播放列表"><i class="bi bi-chevron-right"></i></button>' +
        '<div class="vpv-controls">' +
          '<div class="vpv-row">' +
            '<button class="vpv-btn iptv-play" title="播放/暂停 (空格)"><i class="bi bi-play-fill"></i></button>' +
            '<div class="vpv-vol">' +
              '<button class="vpv-btn iptv-mute" title="静音 (M)"><i class="bi bi-volume-up-fill"></i></button>' +
              '<input type="range" class="vpv-vol-range" min="0" max="1" step="0.01" value="1" title="音量">' +
              '<span class="vpv-vol-pct">100%</span>' +
            '</div>' +
            '<span class="vpv-time iptv-state">直播</span>' +
            '<span class="iptv-live-dot" title="正在直播"></span>' +
            '<div class="vpv-spacer"></div>' +
            '<button class="vpv-btn iptv-reload" title="重新连接当前频道"><i class="bi bi-arrow-clockwise"></i></button>' +
            '<button class="vpv-btn iptv-pip" title="画中画"><svg class="vpv-svg" viewBox="0 0 16 16" fill="currentColor" width="1em" height="1em" aria-hidden="true"><path d="M1.5 2A1.5 1.5 0 0 0 0 3.5v9A1.5 1.5 0 0 0 1.5 14h13a1.5 1.5 0 0 0 1.5-1.5v-9A1.5 1.5 0 0 0 14.5 2h-13zM1 3.5a.5.5 0 0 1 .5-.5h13a.5.5 0 0 1 .5.5v9a.5.5 0 0 1-.5.5h-13a.5.5 0 0 1-.5-.5v-9z"/><path d="M7.5 6a.5.5 0 0 0-.5.5v3a.5.5 0 0 0 .5.5h5a.5.5 0 0 0 .5-.5v-3a.5.5 0 0 0-.5-.5h-5z"/></svg></button>' +
            '<button class="vpv-btn iptv-full" title="全屏 (F)"><i class="bi bi-fullscreen"></i></button>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div class="vpv-side">' +
        '<div class="vpv-pl-head">' +
          '<button class="iptv-tab active" data-t="pl" title="播放列表">' +
            '<i class="bi bi-collection-play"></i>列表 <span class="vpv-pl-count">…</span>' +
          '</button>' +
          '<button class="iptv-tab" data-t="his" title="本地观看记录">' +
            '<i class="bi bi-clock-history"></i>记录 <span class="iptv-his-count">0</span>' +
          '</button>' +
          '<button class="iptv-his-clear" title="清空观看记录"><i class="bi bi-trash3"></i></button>' +
          '<button class="iptv-back" title="回到文本编辑"><i class="bi bi-pencil-square"></i></button>' +
        '</div>' +
        '<div class="iptv-search">' +
          '<i class="bi bi-search"></i>' +
          '<input type="text" placeholder="搜索频道 / 分组" spellcheck="false">' +
        '</div>' +
        '<div class="vpv-pl-list"><div class="vpv-pl-empty"><i class="bi bi-hourglass-split"></i> 正在解析播放列表…</div></div>' +
        '<div class="iptv-history"></div>' +
      '</div>';

    var stage = root.querySelector(".vpv-stage");
    var video = root.querySelector("video");
    var titleEl = root.querySelector(".vpv-title");
    var tipEl = root.querySelector(".vpv-seek-tip");
    var stateEl = root.querySelector(".iptv-state");
    var liveDot = root.querySelector(".iptv-live-dot");
    var playBtn = root.querySelector(".iptv-play");
    var muteBtn = root.querySelector(".iptv-mute");
    var volRange = root.querySelector(".vpv-vol-range");
    var volPct = root.querySelector(".vpv-vol-pct");
    var listEl = root.querySelector(".vpv-pl-list");
    var countEl = root.querySelector(".vpv-pl-count");
    var searchEl = root.querySelector(".iptv-search input");
    var sideToggle = root.querySelector(".vpv-side-toggle");
    var hisEl = root.querySelector(".iptv-history");
    var hisCountEl = root.querySelector(".iptv-his-count");
    var hisClearBtn = root.querySelector(".iptv-his-clear");
    var tabs = Array.prototype.slice.call(root.querySelectorAll(".iptv-tab"));

    var data = null;                      // 解析结果（本次进入播放器时重新解析）
    var cur = null;                       // 当前频道
    var hls = null;
    var retry = 0;
    var destroyed = false;

    /* ---------- 主题：与 22_ 视频播放器同一套判定 ---------- */
    try {
      if (typeof vpvThemeIsLight === "function") root.classList.toggle("vpv-light", vpvThemeIsLight());
    } catch (_) { }

    /* ---------- 提示气泡 ---------- */
    var tipTimer = null;
    function showTip(text, icon) {
      tipEl.innerHTML = icon ? '<i class="bi ' + icon + '"></i> ' + iptvEsc(text) : iptvEsc(text);
      tipEl.classList.add("show");
      clearTimeout(tipTimer);
      tipTimer = setTimeout(function () { tipEl.classList.remove("show"); }, 2200);
    }

    /* ---------- 音量 / 静音 ---------- */
    function syncVol() {
      var v = video.muted ? 0 : video.volume;
      volRange.value = v;
      volRange.style.setProperty("--vol", (v * 100) + "%");
      volPct.textContent = Math.round(v * 100) + "%";
      muteBtn.innerHTML = '<i class="bi ' + (v === 0 ? "bi-volume-mute-fill" :
        v < 0.5 ? "bi-volume-down-fill" : "bi-volume-up-fill") + '"></i>';
    }
    video.volume = Math.min(1, Math.max(0, +_iptvPrefs.volume || 1));
    video.muted = !!_iptvPrefs.muted;
    syncVol();
    volRange.addEventListener("input", function () {
      video.volume = +volRange.value;
      video.muted = false;
      syncVol();
    });
    muteBtn.addEventListener("click", function () { video.muted = !video.muted; });
    video.addEventListener("volumechange", function () {
      _iptvPrefs.volume = video.volume;
      _iptvPrefs.muted = video.muted;
      _iptvSavePrefs();
      syncVol();
    });

    /* ---------- 播放 / 暂停 ---------- */
    function setPlayIcon() {
      playBtn.innerHTML = '<i class="bi ' + (video.paused ? "bi-play-fill" : "bi-pause-fill") + '"></i>';
    }
    function tryPlay() {
      var p = video.play();
      if (p && p.catch) p.catch(function () { showTip("浏览器拦下了自动播放，点画面开始播放", "bi-hand-index"); });
    }
    function togglePlay() { if (video.paused) tryPlay(); else video.pause(); }
    playBtn.addEventListener("click", togglePlay);
    video.addEventListener("click", togglePlay);
    video.addEventListener("dblclick", function () { root.querySelector(".iptv-full").click(); });
    video.addEventListener("play", setPlayIcon);
    video.addEventListener("pause", setPlayIcon);
    /* 直播中指示灯：只有真的在出画面才闪（缓冲 / 暂停 / 出错都灭掉） */
    function setLive(on) { liveDot.classList.toggle("on", !!on); }
    video.addEventListener("playing", function () { stateEl.textContent = "直播中"; setLive(true); });
    video.addEventListener("waiting", function () { stateEl.textContent = "缓冲中…"; setLive(false); });
    video.addEventListener("error", function () {
      // hls.js 自己会走 fatal 回调；这里只兜底直连媒体（mp4 等）的失败
      if (hls) return;
      stateEl.textContent = "播放出错";
      setLive(false);
      showTip("无法播放该地址（源可能已失效）", "bi-exclamation-circle");
    });
    setPlayIcon();

    /* ---------- 画中画 / 全屏 / 重连 ---------- */
    root.querySelector(".iptv-pip").addEventListener("click", function () {
      if (!document.pictureInPictureEnabled) { showTip("当前浏览器不支持画中画", "bi-display"); return; }
      try {
        if (document.pictureInPictureElement) document.exitPictureInPicture();
        else video.requestPictureInPicture();
      } catch (e) { showTip("画中画暂不可用", "bi-exclamation-circle"); }
    });
    root.querySelector(".iptv-full").addEventListener("click", function () {
      if (document.fullscreenElement) document.exitFullscreen();
      else if (stage.requestFullscreen) stage.requestFullscreen();
      else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen();
    });
    root.querySelector(".iptv-reload").addEventListener("click", function () {
      if (!cur) return;
      var it = cur;
      cur = null;               // 允许同频道重新走一遍
      play(it, true);
      showTip("正在重新连接…", "bi-arrow-clockwise");
    });

    /* ---------- 控制条自动隐藏：播放中鼠标静止 3s 淡出，划出画面立刻收起 ---------- */
    var idleTimer = null;
    function wake() {
      stage.classList.remove("idle");
      clearTimeout(idleTimer);
      idleTimer = setTimeout(function () {
        if (!video.paused) stage.classList.add("idle");
      }, 3000);
    }
    stage.addEventListener("mousemove", wake);
    stage.addEventListener("mouseleave", function () {
      if (!video.paused) stage.classList.add("idle");
    });
    video.addEventListener("pause", function () { stage.classList.remove("idle"); setLive(false); });
    video.addEventListener("play", wake);
    wake();

    /* ---------- 播放列表收起 / 展开（状态持久化，同视频播放器） ---------- */
    sideToggle.addEventListener("click", function () {
      var folded = root.classList.toggle("no-side");
      sideToggle.querySelector("i").className = folded ? "bi bi-chevron-left" : "bi bi-chevron-right";
      sideToggle.title = folded ? "展开播放列表" : "收起播放列表";
      _iptvPrefs.plFold = folded;
      _iptvSavePrefs();
    });
    if (_iptvPrefs.plFold) sideToggle.querySelector("i").className = "bi bi-chevron-left";

    /* ---------- 频道列表 ---------- */
    function rowHtml(it, idx) {
      var on = cur && cur.url === it.url;
      return '<div class="vpv-pl-row' + (on ? " cur" : "") + '" data-i="' + idx + '"' +
          ' title="' + iptvEsc(it.name + (it.group ? " · " + it.group : "")) + '">' +
          '<span class="vpv-pl-thumb">📺' +
            (it.logo ? '<img loading="lazy" alt="" src="' + iptvEsc(it.logo) + '" onerror="this.remove()">' : '') +
          '</span>' +
          '<span class="vpv-pl-name">' + iptvEsc(it.name) + '</span>' +
        '</div>';
    }
    function renderList() {
      if (!data) return;
      var kw = (searchEl.value || "").trim().toLowerCase();
      var html = [];
      var lastGroup = null;
      var shown = 0;
      data.items.forEach(function (it, idx) {
        if (kw && (it.name + " " + it.group).toLowerCase().indexOf(kw) < 0) return;
        if (it.group !== lastGroup) {
          html.push('<div class="iptv-grp">' + iptvEsc(it.group) + '</div>');
          lastGroup = it.group;
        }
        html.push(rowHtml(it, idx));
        shown++;
      });
      if (!shown) {
        listEl.innerHTML = '<div class="vpv-pl-empty"><i class="bi bi-search"></i> 没有匹配的频道</div>';
        return;
      }
      listEl.innerHTML = html.join("");
      Array.prototype.forEach.call(listEl.querySelectorAll(".vpv-pl-row"), function (row) {
        row.addEventListener("click", function () {
          var it = data.items[+row.dataset.i];
          if (it) play(it, true);
        });
      });
      var curRow = listEl.querySelector(".vpv-pl-row.cur");
      if (curRow) try { curRow.scrollIntoView({ block: "nearest" }); } catch (_) { }
    }
    function markCur() {
      Array.prototype.forEach.call(listEl.querySelectorAll(".vpv-pl-row"), function (row) {
        var it = data && data.items[+row.dataset.i];
        row.classList.toggle("cur", !!(it && cur && it.url === cur.url));
      });
    }
    searchEl.addEventListener("input", function () {
      // 搜索框两个视图共用：按当前页签过滤对应列表
      if (root.classList.contains("hist-mode")) renderHistory();
      else renderList();
    });

    /* ---------- 本地观看记录：最近看过的频道，点一下直接回看 ---------- */
    var hisList = iptvLoadHistory();
    function syncHisCount() {
      hisCountEl.textContent = hisList.length;
      hisCountEl.title = hisList.length ? "最近看过 " + hisList.length + " 个频道" : "还没有观看记录";
    }
    function recordHis(it) {
      if (!it || !it.url) return;
      hisList = hisList.filter(function (h) { return h.url !== it.url; });
      hisList.unshift({ name: it.name, group: it.group, url: it.url, logo: it.logo, kind: it.kind, t: Date.now() });
      hisList = hisList.slice(0, IPTV_HIS_MAX);
      iptvSaveHistory(hisList);
      syncHisCount();
      if (root.classList.contains("hist-mode")) renderHistory();
    }
    function renderHistory() {
      var kw = (searchEl.value || "").trim().toLowerCase();
      var html = [];
      var shown = 0;
      hisList.forEach(function (h, i) {
        if (kw && ((h.name || "") + " " + (h.group || "")).toLowerCase().indexOf(kw) < 0) return;
        var on = cur && cur.url === h.url;
        html.push('<div class="vpv-pl-row' + (on ? " cur" : "") + '" data-i="' + i + '"' +
            ' title="' + iptvEsc(h.name + (h.group ? " · " + h.group : "")) + '">' +
            '<span class="vpv-pl-thumb">📺' +
              (h.logo ? '<img loading="lazy" alt="" src="' + iptvEsc(h.logo) + '" onerror="this.remove()">' : '') +
            '</span>' +
            '<span class="vpv-pl-name">' + iptvEsc(h.name) + '</span>' +
            '<span class="iptv-his-time">' + iptvTimeAgo(h.t) + '</span>' +
          '</div>');
        shown++;
      });
      if (!shown) {
        hisEl.innerHTML = '<div class="vpv-pl-empty"><i class="bi bi-' +
          (hisList.length ? "search" : "clock-history") + '"></i> ' +
          (hisList.length ? "没有匹配的记录" : "还没有观看记录") + '</div>';
        return;
      }
      hisEl.innerHTML = html.join("");
      Array.prototype.forEach.call(hisEl.querySelectorAll(".vpv-pl-row"), function (row) {
        row.addEventListener("click", function () {
          var it = hisList[+row.dataset.i];
          if (it) play(it, true);
        });
      });
    }
    hisClearBtn.addEventListener("click", function () {
      if (!hisList.length) return;
      // 二次确认：复用全局悬浮确认框（Esc / 点外部 = 取消），缺省时退回原生 confirm
      var ask = (typeof window.uiConfirmPop === "function")
        ? window.uiConfirmPop(hisClearBtn, {
            danger: true,
            title: "清空观看记录",
            msg: "将删除全部 " + hisList.length + " 条观看记录，此操作无法恢复。",
            okText: "清空",
          })
        : Promise.resolve(window.confirm("清空全部 " + hisList.length + " 条观看记录？"));
      ask.then(function (ok) {
        if (!ok) return;
        hisList = [];
        iptvSaveHistory(hisList);
        syncHisCount();
        renderHistory();
        showTip("已清空观看记录", "bi-trash3");
      });
    });
    tabs.forEach(function (t) {
      t.addEventListener("click", function () {
        var his = t.dataset.t === "his";
        root.classList.toggle("hist-mode", his);
        tabs.forEach(function (x) { x.classList.toggle("active", x === t); });
        // 搜索框共用，只换提示文案（关键词保留，两边都按它过滤）
        searchEl.placeholder = his ? "搜索观看记录" : "搜索频道 / 分组";
        if (his) renderHistory();
      });
    });
    syncHisCount();

    /* ---------- HLS 播放 ---------- */
    function stopHls() {
      if (!hls) return;
      try { hls.destroy(); } catch (_) { }
      hls = null;
    }
    function onFatal(d) {
      var type = d && d.type;
      setLive(false);
      if (type === "networkError") {
        if (retry < 3) {
          retry++;
          stateEl.textContent = "重连中…";
          showTip("网络抖动，正在重连（" + retry + "/3）", "bi-arrow-repeat");
          setTimeout(function () { if (hls && !destroyed) try { hls.startLoad(); } catch (_) { } }, 800);
          return;
        }
        // 代理返回的 JSON 里通常带着上游的真实原因（如「上游返回 HTTP 660」），一并显示出来
        var why = "";
        try {
          var j = JSON.parse((d.response && d.response.text) || "");
          if (j && j.error) why = "：" + j.error;
        } catch (_) { }
        stateEl.textContent = "连接失败";
        showTip("连不上这个源" + why, "bi-wifi-off");
        return;
      }
      if (type === "mediaError" && hls && retry < 2) {
        retry++;
        try { hls.recoverMediaError(); return; } catch (_) { }
      }
      stateEl.textContent = "播放出错";
      showTip("播放出错：" + ((d && (d.details || d.reason)) || "未知原因"), "bi-exclamation-circle");
    }

    function play(it, autoplay) {
      if (!it || destroyed) return;
      if (cur && cur.url === it.url && autoplay) return;   // 已在播这个台
      cur = it;
      retry = 0;
      titleEl.textContent = it.name + (it.group && it.group !== "未分组" ? " · " + it.group : "");
      stateEl.textContent = "加载中…";
      setLive(false);
      recordHis(it);
      markCur();
      stopHls();
      video.removeAttribute("src");
      try { video.load(); } catch (_) { }

      var src = it.kind === "file"
        ? "/api/stream?path=" + encodeURIComponent(it.url)
        : "/api/iptv/proxy?url=" + encodeURIComponent(it.url);

      if (it.kind === "file" || it.kind === "media") {
        video.src = src;
        if (autoplay) tryPlay();
        return;
      }
      // HLS：优先 hls.js（Chrome / Firefox / Edge），Safari 走原生
      iptvLoadHls().then(function (Hls) {
        if (destroyed || cur !== it) return;
        if (Hls && Hls.isSupported()) {
          hls = new Hls({
            enableWorker: true,
            lowLatencyMode: false,
            backBufferLength: 30,
            manifestLoadingMaxRetry: 2,
            levelLoadingMaxRetry: 2,
            fragLoadingMaxRetry: 4,
          });
          hls.on(Hls.Events.ERROR, function (evt, d) { if (d && d.fatal) onFatal(d); });
          hls.loadSource(src);
          hls.attachMedia(video);
          if (autoplay) tryPlay();
        } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
          video.src = src;
          if (autoplay) tryPlay();
        } else {
          stateEl.textContent = "不支持";
          showTip("当前浏览器不支持 HLS 播放", "bi-exclamation-circle");
        }
      });
    }

    /* ---------- 拉取播放列表 ---------- */
    function showError(msg) {
      countEl.textContent = "";
      stateEl.textContent = "解析失败";
      listEl.innerHTML = '<div class="vpv-pl-empty"><i class="bi bi-exclamation-triangle"></i> ' +
        iptvEsc(msg || "解析失败") + '</div>';
    }
    function load() {
      listEl.innerHTML = '<div class="vpv-pl-empty"><i class="bi bi-hourglass-split"></i> 正在解析播放列表…</div>';
      var body = { path: tab.path };
      // 把编辑器缓冲区一并发给服务端：改了还没保存也按「眼前看到的」解析 / 播放
      try { if (tab.cm) body.text = tab.cm.getValue(); } catch (_) { }
      fetch("/api/iptv/playlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (destroyed) return;
          if (!d || !d.ok) { showError(d && d.error); return; }
          data = d;
          countEl.textContent = d.total;
          renderList();
          if (d.items[0]) play(d.items[0], true);
        })
        .catch(function (e) { if (!destroyed) showError("解析失败：" + (e.message || e)); });
    }

    /* ---------- 键盘：空格 / M / F（仅当前标签可见时接管） ---------- */
    function onKey(e) {
      if (destroyed || !host.isConnected || !host.classList.contains("active")) return;
      var tag = (e.target && e.target.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select" || (e.target && e.target.isContentEditable)) return;
      var k = (e.key || "").toLowerCase();
      if (e.key === " ") { e.preventDefault(); e.stopPropagation(); togglePlay(); }
      else if (k === "m") { e.preventDefault(); e.stopPropagation(); video.muted = !video.muted; }
      else if (k === "f") { e.preventDefault(); e.stopPropagation(); root.querySelector(".iptv-full").click(); }
    }
    document.addEventListener("keydown", onKey, true);

    /* ---------- 返回文本编辑 / 标签关闭时清理 ---------- */
    root.querySelector(".iptv-back").addEventListener("click", function () { iptvExit(tab); });

    var observer = new MutationObserver(function () {
      if (host.isConnected) return;
      observer.disconnect();
      destroy();
    });
    if (host.parentNode) observer.observe(host.parentNode, { childList: true });

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      document.removeEventListener("keydown", onKey, true);
      clearTimeout(tipTimer);
      clearTimeout(idleTimer);
      stopHls();
      try { video.pause(); } catch (_) { }
      try { video.removeAttribute("src"); video.load(); } catch (_) { }
    }
    tab._iptvDestroy = destroy;

    // 等 root 挂进文档再解析 / 起播：video.play() 在游离节点上有浏览器差异
    setTimeout(load, 0);
    return root;
  }

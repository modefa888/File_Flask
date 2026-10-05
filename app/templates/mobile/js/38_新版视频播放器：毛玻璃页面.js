  // ================= 新版视频播放器：毛玻璃页面 =================
  var vpPage = document.getElementById("vpPage");
  var vpVideo = document.getElementById("vpVideo");
  var vpList = [];        // [{name, abs}]
  var vpIndex = -1;

  function vpSyncPlayIcon() {
    var paused = vpVideo.paused;
    document.getElementById("vpPlay").innerHTML = paused ? _svgPlay : _svgPause;
    document.getElementById("vpBig").innerHTML = paused ? _svgPlay : _svgPause;
    vpPage.classList.toggle("paused", paused);
  }
  function vpPlayIndex(i, autoplay) {
    if (i < 0 || i >= vpList.length) return;
    vpIndex = i;
    var it = vpList[i];
    vpVideo.src = "/api/stream?path=" + encodeURIComponent(it.abs);
    document.getElementById("vpName").textContent = it.name;
    var sk = document.getElementById("vpSeek");
    sk.value = 0; sk.style.setProperty("--p", "0");
    document.getElementById("vpCur").textContent = "0:00";
    document.getElementById("vpDur").textContent = "0:00";
    // 氛围背景：抽帧缩略图模糊放大（延迟到视频可播放后再请求，避免 ffmpeg 抽帧与视频流抢占磁盘 I/O 拖慢起播）
    var bg = document.getElementById("vpBg");
    bg.classList.add("has-cover");
    var bgIdx = vpIndex;                       // 换视频后旧的延迟加载作废
    var vpLoadBg = function () {
      if (vpIndex !== bgIdx) return;
      bg.style.backgroundImage = 'url("/api/thumbnail?path=' + encodeURIComponent(it.abs) + '")';
    };
    if (vpVideo.readyState >= 3) vpLoadBg();
    else vpVideo.addEventListener("canplay", vpLoadBg, { once: true });
    vpSeeking = false;
    vpCloseRatePop();                      // 换视频时收起倍速菜单
    vpApplyRate();                         // 换视频后重新套用当前倍速
    vpSyncFavBtn();                        // 同步喜欢状态
    if (autoplay) { var pp = vpVideo.play(); if (pp && pp.catch) pp.catch(function () {}); }
    vpSyncPlayIcon();
    // 播放列表抽屉开着时同步高亮
    if (document.getElementById("vpPl").classList.contains("show")) vpRenderPlaylist();
  }
  function vpToggle() {
    if (vpVideo.paused) { var pp = vpVideo.play(); if (pp && pp.catch) pp.catch(function () {}); }
    else vpVideo.pause();
  }
  function vpApplyVolume(save) {
    var v = vpVideo.volume;
    var range = document.getElementById("vpVol");
    range.value = Math.round(v * 100);
    range.style.setProperty("--v", v.toFixed(3));
    document.getElementById("vpVolVal").textContent = Math.round(v * 100) + "%";
    document.getElementById("vpVolBtn").innerHTML = v > 0 ? _svgVolOn : _svgVolOff;
    if (save) { try { localStorage.setItem("ff_music_vol", String(Math.round(v * 100))); } catch (e) {} }
  }
  function vpRestoreVolume() {
    try {
      var lv = parseInt(localStorage.getItem("ff_music_vol"), 10);
      if (isFinite(lv)) vpVideo.volume = Math.max(0, Math.min(1, lv / 100));
    } catch (e) {}
    vpApplyVolume(false);
  }
  // items: [{name, abs}]，idx 为当前播放项
  function openVPlayer(items, idx) {
    if (!items || !items.length) return;
    vpList = items.map(function (x) { return { name: x.name, abs: x.abs || x.abs_path }; });
    vpIndex = Math.max(0, Math.min(idx || 0, vpList.length - 1));
    vpPage.classList.add("show");
    vpRestoreVolume();
    vpRestoreRate();
    vpPlayIndex(vpIndex, true);
  }
  function closeVPlayer() {
    vpVideo.pause();
    try { vpVideo.removeAttribute("src"); vpVideo.load(); } catch (e) {}
    vpPage.classList.remove("show");
    document.getElementById("vpVolBar").classList.remove("show");
    vpCloseRatePop();
    vpClosePlaylist();
    if (document.fullscreenElement) { try { document.exitFullscreen(); } catch (e) {} }
  }

  // 分享当前正在播放的视频（走统一的分享面板：有效期 / 密码 / 次数 / 二维码）
  document.getElementById("vpShareBtn").addEventListener("click", function () {
    var it = vpList[vpIndex];
    if (!it) { toast("还没有正在播放的视频", "info"); return; }
    openShareSheet({ name: it.name, is_dir: false, abs_path: it.abs });
  });

  document.getElementById("vpCollapse").addEventListener("click", closeVPlayer);
  document.getElementById("vpPlay").addEventListener("click", vpToggle);
  document.getElementById("vpBig").addEventListener("click", vpToggle);
  vpVideo.addEventListener("click", vpToggle);        // 点画面也能播放/暂停
  document.getElementById("vpPrev").addEventListener("click", function () {
    if (vpIndex > 0) vpPlayIndex(vpIndex - 1, true);
    else { vpVideo.currentTime = 0; var pp = vpVideo.play(); if (pp && pp.catch) pp.catch(function () {}); }
  });
  document.getElementById("vpNext").addEventListener("click", function () {
    if (vpIndex < vpList.length - 1) vpPlayIndex(vpIndex + 1, true);
  });
  // 播放列表抽屉：☰ 打开/收起，按钮有高亮状态反馈
  // 缩略图：封面拉不到时露出 🎬 兜底，不出现裂图
  function vpThumbEl(abs) {
    var thumb = document.createElement("span");
    thumb.className = "vp-pl-thumb";
    thumb.textContent = "🎬";
    var img = document.createElement("img");
    img.loading = "lazy";
    img.alt = "";
    img.src = "/api/thumbnail?path=" + encodeURIComponent(abs);
    img.onerror = function () { img.remove(); };
    thumb.appendChild(img);
    return thumb;
  }
  function vpPlCounts() {
    document.getElementById("vpCntPl").textContent = vpList.length || "";
    document.getElementById("vpCntFav").textContent = vpFavList().length || "";
  }
  function vpSetTab(t) {
    vpPlTab = t;
    Array.prototype.forEach.call(document.querySelectorAll("#vpPl .pp-tab"), function (b) {
      b.classList.toggle("active", b.getAttribute("data-tab") === t);
    });
    vpRenderPlaylist();
  }
  var vpPlTab = "pl";
  function vpRenderPlaylist() {
    var box = document.getElementById("vpPlList");
    box.innerHTML = "";
    vpPlCounts();
    if (vpPlTab === "fav") { vpRenderFavList(box); return; }
    // ---- 播放列表 tab：当前播放队列 ----
    vpList.forEach(function (it, i) {
      var row = document.createElement("div");
      row.className = "vp-pl-row" + (i === vpIndex ? " cur" : "");
      var meta = document.createElement("div");
      meta.className = "vp-pl-meta";
      var nm = document.createElement("div");
      nm.className = "vp-pl-name";
      nm.textContent = it.name;
      nm.title = it.name;
      var tag = document.createElement("div");
      tag.className = "vp-pl-tag";
      tag.textContent = (i === vpIndex) ? "正在播放" : ("第 " + (i + 1) + " 个");
      meta.append(nm, tag);
      row.append(vpThumbEl(it.abs), meta);
      if (vpIsFav(it.abs)) {
        var h = document.createElement("span");
        h.className = "vp-pl-fav";
        h.textContent = "♥";
        h.title = "已喜欢";
        row.appendChild(h);
      }
      row.addEventListener("click", function () {
        vpClosePlaylist();
        if (i !== vpIndex) vpPlayIndex(i, true);
      });
      box.appendChild(row);
    });
    var cur = box.querySelector(".vp-pl-row.cur");
    if (cur) try { cur.scrollIntoView({ block: "center" }); } catch (e) {}
  }

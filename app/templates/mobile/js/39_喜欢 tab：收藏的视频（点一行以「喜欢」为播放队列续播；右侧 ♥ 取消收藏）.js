  // ---- 喜欢 tab：收藏的视频（点一行以「喜欢」为播放队列续播；右侧 ♥ 取消收藏）----
  function vpRenderFavList(box) {
    var favs = vpFavList();
    if (!favs.length) {
      var empty = document.createElement("div");
      empty.className = "vp-pl-empty";
      empty.textContent = "还没有喜欢的视频（播放页点 ♥ 收藏）";
      box.appendChild(empty);
      return;
    }
    var curAbs = (vpIndex >= 0 && vpList[vpIndex]) ? vpList[vpIndex].abs : "";
    favs.forEach(function (f, i) {
      var row = document.createElement("div");
      row.className = "vp-pl-row" + (f.p === curAbs ? " cur" : "");
      var meta = document.createElement("div");
      meta.className = "vp-pl-meta";
      var nm = document.createElement("div");
      nm.className = "vp-pl-name";
      nm.textContent = f.n || pathBaseName(f.p);
      nm.title = f.p;
      var tag = document.createElement("div");
      tag.className = "vp-pl-tag";
      tag.textContent = f.d ? (pathBaseName(f.d) || "/") : "/";
      meta.append(nm, tag);
      var rm = document.createElement("button");
      rm.type = "button";
      rm.className = "vp-pl-rm";
      rm.title = "取消喜欢";
      rm.textContent = "♥";
      rm.addEventListener("click", function (ev) {
        ev.stopPropagation();
        try {
          localStorage.setItem(VP_FAV_KEY, JSON.stringify(
            vpFavList().filter(function (x) { return x.p !== f.p; })));
        } catch (e2) {}
        vpSyncFavBtn();
        vpRenderPlaylist();
        toast("已取消喜欢");
      });
      row.append(vpThumbEl(f.p), meta, rm);
      row.addEventListener("click", function () {
        vpClosePlaylist();
        // 以「喜欢」作为播放队列，方便在收藏里上下切换
        vpList = favs.map(function (x) { return { name: x.n || pathBaseName(x.p), abs: x.p }; });
        vpPlayIndex(i, true);
      });
      box.appendChild(row);
    });
    var cur = box.querySelector(".vp-pl-row.cur");
    if (cur) try { cur.scrollIntoView({ block: "center" }); } catch (e) {}
  }
  function vpOpenPlaylist() {
    vpRenderPlaylist();
    document.getElementById("vpPlMask").classList.add("show");
    document.getElementById("vpPl").classList.add("show");
    document.getElementById("vpListBtn").classList.add("on");
  }
  function vpClosePlaylist() {
    document.getElementById("vpPlMask").classList.remove("show");
    document.getElementById("vpPl").classList.remove("show");
    document.getElementById("vpListBtn").classList.remove("on");
  }
  document.getElementById("vpListBtn").addEventListener("click", function () {
    if (document.getElementById("vpPl").classList.contains("show")) vpClosePlaylist();
    else vpOpenPlaylist();
  });
  document.getElementById("vpPlClose").addEventListener("click", vpClosePlaylist);
  document.getElementById("vpPlMask").addEventListener("click", vpClosePlaylist);
  // 两个 tab：播放列表 / 喜欢
  Array.prototype.forEach.call(document.querySelectorAll("#vpPl .pp-tab"), function (b) {
    b.addEventListener("click", function () { vpSetTab(b.getAttribute("data-tab")); });
  });

  // 喜欢：视频独立收藏列表（localStorage 持久化，键 ff_video_favs）
  var VP_FAV_KEY = "ff_video_favs";
  function vpFavList() {
    try { return JSON.parse(localStorage.getItem(VP_FAV_KEY) || "[]"); } catch (e) { return []; }
  }
  function vpIsFav(abs) {
    return vpFavList().some(function (r) { return r.p === abs; });
  }
  function vpSyncFavBtn() {
    var on = vpIndex >= 0 && vpList[vpIndex] && vpIsFav(vpList[vpIndex].abs);
    document.getElementById("vpFavBtn").classList.toggle("on", !!on);
  }
  document.getElementById("vpFavBtn").addEventListener("click", function () {
    if (vpIndex < 0 || !vpList[vpIndex]) return;
    var it = vpList[vpIndex], abs = it.abs;
    var hit = vpIsFav(abs);
    var list = vpFavList().filter(function (r) { return r.p !== abs; });
    if (!hit) list.unshift({ p: abs, n: it.name, d: abs.slice(0, abs.lastIndexOf("/")) || "/" });
    try { localStorage.setItem(VP_FAV_KEY, JSON.stringify(list)); } catch (e) {}
    vpSyncFavBtn();
    if (document.getElementById("vpPl").classList.contains("show")) vpRenderPlaylist();
    toast(hit ? "已取消喜欢" : "已加入喜欢");
  });
  document.getElementById("vpFs").addEventListener("click", function () {
    if (document.fullscreenElement) { try { document.exitFullscreen(); } catch (e) {} return; }
    if (vpVideo.requestFullscreen) vpVideo.requestFullscreen().catch(function () {});
    else if (vpVideo.webkitEnterFullscreen) { try { vpVideo.webkitEnterFullscreen(); } catch (e) {} }  // iOS Safari
  });
  vpVideo.addEventListener("play", vpSyncPlayIcon);
  vpVideo.addEventListener("pause", vpSyncPlayIcon);
  vpVideo.addEventListener("loadedmetadata", function () {
    document.getElementById("vpDur").textContent = _fmtTime(vpVideo.duration);
  });
  var vpSeeking = false;      // 手指按在进度条上时不回写滑块，避免和播放进度"抢"
  vpVideo.addEventListener("timeupdate", function () {
    if (vpSeeking) return;
    var d = vpVideo.duration, c = vpVideo.currentTime;
    document.getElementById("vpCur").textContent = _fmtTime(c);
    if (isFinite(d) && d > 0) {
      var sk = document.getElementById("vpSeek");
      sk.value = Math.round(c / d * 1000);
      sk.style.setProperty("--p", (c / d).toFixed(4));
    }
  });
  vpVideo.addEventListener("ended", function () {       // 播完接下一个
    if (vpIndex >= 0 && vpIndex < vpList.length - 1) vpPlayIndex(vpIndex + 1, true);
    else vpSyncPlayIcon();
  });
  var vpSeekEl = document.getElementById("vpSeek");
  vpSeekEl.addEventListener("input", function () {
    vpSeeking = true;
    var d = vpVideo.duration;
    vpSeekEl.style.setProperty("--p", (vpSeekEl.value / 1000).toFixed(4));
    if (isFinite(d) && d > 0) document.getElementById("vpCur").textContent = _fmtTime(d * vpSeekEl.value / 1000);
  });
  vpSeekEl.addEventListener("change", function () {
    var d = vpVideo.duration;
    if (isFinite(d) && d > 0) {
      var t = d * vpSeekEl.value / 1000;
      vpVideo.currentTime = t;
      document.getElementById("vpCur").textContent = _fmtTime(t);
      vpSeekEl.style.setProperty("--p", (vpSeekEl.value / 1000).toFixed(4));
    }
    vpSeeking = false;
  });
  // 兜底：某些浏览器松手不一定触发 change，抬起手指后解除保护
  ["pointerup", "touchend", "mouseup"].forEach(function (ev) {
    vpSeekEl.addEventListener(ev, function () {
      setTimeout(function () { vpSeeking = false; }, 0);
    });
  });
  // 倍速（快进播放）：点按钮向上弹出竖向菜单选择；换视频后重新套用；取值持久化
  var VP_RATES = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 8];
  var vpRate = 1;
  function vpRateLabel(r) { return (Number.isInteger(r) ? r.toFixed(1) : String(r)) + "×"; }
  function vpApplyRate() {
    try { vpVideo.playbackRate = vpRate; } catch (e) {}
    var btn = document.getElementById("vpRate");
    btn.textContent = vpRateLabel(vpRate);
    btn.classList.toggle("fast", vpRate !== 1);
  }
  function vpRenderRatePop() {
    var box = document.getElementById("vpRateList");
    box.innerHTML = "";
    VP_RATES.forEach(function (r) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "vp-rate-item" + (r === vpRate ? " cur" : "");
      var t = document.createElement("span");
      t.textContent = vpRateLabel(r);
      var tick = document.createElement("span");
      tick.className = "rp-tick";
      tick.textContent = "✓";
      b.append(t, tick);
      b.addEventListener("click", function () {
        vpRate = r;
        vpApplyRate();
        try { localStorage.setItem("ff_video_rate", String(r)); } catch (e) {}
        vpCloseRatePop();
      });
      box.appendChild(b);
    });
    var cur = box.querySelector(".vp-rate-item.cur");
    if (cur) try { cur.scrollIntoView({ block: "nearest" }); } catch (e) {}
  }
  function vpOpenRatePop() {
    vpRenderRatePop();
    document.getElementById("vpRatePop").classList.add("show");
    document.getElementById("vpRate").classList.add("on");
  }
  function vpCloseRatePop() {
    document.getElementById("vpRatePop").classList.remove("show");
    document.getElementById("vpRate").classList.remove("on");
  }
  function vpRestoreRate() {
    try {
      var r = parseFloat(localStorage.getItem("ff_video_rate"));
      if (isFinite(r) && r > 0) vpRate = r;
    } catch (e) {}
    vpApplyRate();
  }
  document.getElementById("vpRate").addEventListener("click", function () {
    var pop = document.getElementById("vpRatePop");
    if (pop.classList.contains("show")) vpCloseRatePop();
    else vpOpenRatePop();
  });
  document.addEventListener("click", function (e) {   // 点别处收起菜单
    var pop = document.getElementById("vpRatePop");
    if (!pop.classList.contains("show")) return;
    if (e.target.closest("#vpRatePop") || e.target.closest("#vpRate")) return;
    vpCloseRatePop();
  });
  var vpVolBar = document.getElementById("vpVolBar");
  var vpVolRange = document.getElementById("vpVol");
  document.getElementById("vpVolBtn").addEventListener("click", function () {
    vpVolBar.classList.toggle("show");
  });
  vpVolRange.addEventListener("input", function () {
    vpVideo.volume = Math.max(0, Math.min(1, vpVolRange.value / 100));
    vpApplyVolume(true);
  });
  document.addEventListener("click", function (e) {
    if (!vpVolBar.classList.contains("show")) return;
    if (e.target.closest("#vpVolBar") || e.target.closest("#vpVolBtn")) return;
    vpVolBar.classList.remove("show");
  });
  vpSyncPlayIcon();

  var initPath = readHashPath();
  updateViewBtn();
  load(initPath === null ? "" : initPath, true);
})();

  // ===== 播放模式：顺序 / 单曲循环 / 随机 =====
  var _playMode = "seq";
  try { _playMode = localStorage.getItem("ff_music_mode") || "seq"; } catch (e) {}
  var _modeIcons = {
    seq: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 9H2v2h17V9zm0-4H2v2h17V5zM2 15h13v-2H2v2zm15-2v6l5-3-5-3z"/></svg>',
    one: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4zm-4-2V9h-1l-2 1v1.5l1-.5V15h1z"/></svg>',
    shuf: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z"/></svg>'
  };
  var _modeNames = { seq: "顺序播放", one: "单曲循环", shuf: "随机播放" };
  function _applyModeBtn() {
    var b = document.getElementById("ppMode");
    b.innerHTML = _modeIcons[_playMode];
    b.title = _modeNames[_playMode];
  }
  function _setMode(m) {
    _playMode = m;
    try { localStorage.setItem("ff_music_mode", m); } catch (e) {}
    _applyModeBtn();
    toast(_modeNames[m], "info");
  }
  // 自动接续（歌曲播完）：按模式决定下一曲；返回 -1 表示停止
  function _autoNextIdx() {
    var n = _plItems.length;
    if (!n) return -1;
    if (_playMode === "one") return _plIndex;
    if (_playMode === "shuf") {
      if (n === 1) return _plIndex;
      var r; do { r = Math.floor(Math.random() * n); } while (r === _plIndex);
      return r;
    }
    return _plIndex < n - 1 ? _plIndex + 1 : -1;
  }

  _audio.addEventListener("ended", function () {
    var nxt = _autoNextIdx();
    if (nxt < 0) { _audio.currentTime = 0; _syncPlayIcon(true); return; }
    if (nxt === _plIndex) { _audio.currentTime = 0; _audio.play().catch(function () {}); return; }
    playIndex(nxt, true);
  });

  // 播放失败（文件被移动/删除，stream 404 等）：提示并从列表移除，自动接着播下一首
  _audio.addEventListener("error", function () {
    if (_plIndex < 0 || _plIndex >= _plItems.length) return;
    if (!_audio.error) return;   // 非媒体错误（如主动清空 src），忽略
    var bad = _plItems[_plIndex];
    var badAbs = itemAbs(bad);
    _plItems.splice(_plIndex, 1);
    // 同步移除持久化播放列表里的这首歌
    _plSave("ff_music_user_pl", _plStore("ff_music_user_pl").filter(function (r) { return r.p !== badAbs; }));
    toast("「" + _baseOf(bad.name) + "」文件不存在，已从列表移除", "warn");
    _renderTab();
    if (!_plItems.length) {           // 列表空了：停止并收起播放器
      _plIndex = -1;
      _audio.pause();
      _audio.removeAttribute("src");
      try { _audio.load(); } catch (e) {}
      _showMini(false);
      _syncPlayIcon(true);
      return;
    }
    if (_plIndex >= _plItems.length) _plIndex = _plItems.length - 1;
    playIndex(_plIndex, true);        // 原位置已被下一首补上，接着播
  });

  // 手动切下一首：随机模式随机跳，其余按顺序（到末尾回到第一首）
  function _manualNext() {
    var n = _plItems.length;
    if (!n) return;
    if (_playMode === "shuf" && n > 1) {
      var r; do { r = Math.floor(Math.random() * n); } while (r === _plIndex);
      playIndex(r, true);
      return;
    }
    playIndex((_plIndex + 1) % n, true);
  }

  document.getElementById("ppMode").addEventListener("click", function () {
    _setMode(_playMode === "seq" ? "one" : (_playMode === "one" ? "shuf" : "seq"));
  });
  _applyModeBtn();

  document.getElementById("mpToggle").addEventListener("click", _toggle);
  document.getElementById("ppPlayBig").addEventListener("click", _toggle);
  // 点封面唱片也能播放/暂停，与中间主按钮同一套逻辑
  // （迷你条的 mpDisc 在「点开播放页」的点击区内，不绑这里，避免一次点击做两件事）
  document.getElementById("ppDisc").addEventListener("click", _toggle);
  document.getElementById("mpNext").addEventListener("click", _manualNext);
  document.getElementById("ppNext").addEventListener("click", _manualNext);
  document.getElementById("ppPrev").addEventListener("click", function () {
    if (_plIndex > 0) playIndex(_plIndex - 1, true);
    else { _audio.currentTime = 0; _audio.play().catch(function () {}); }
  });
  document.getElementById("mpClose").addEventListener("click", function () {
    _audio.pause(); _audio.removeAttribute("src"); _audio.load();
    _plIndex = -1; _plItems = []; _plSave("ff_music_user_pl", []); _showMini(false); closePlayerPage();
  });
  document.getElementById("mpInfo").addEventListener("click", openPlayerPage);
  document.getElementById("ppCollapse").addEventListener("click", closePlayerPage);
  // 缩小为悬浮圆封面 / 点击圆封面恢复
  document.getElementById("mpDock").addEventListener("click", function () {
    document.getElementById("miniPlayer").classList.add("dock");
  });
  document.getElementById("mpDisc").addEventListener("click", function (e) {
    var mp = document.getElementById("miniPlayer");
    if (mp.classList.contains("dock")) {
      e.stopPropagation();     // 圆封面模式：点封面恢复，不打开全屏页
      mp.classList.remove("dock");
    }
  });
  document.getElementById("ppListBtn").addEventListener("click", function () {
    var open = document.getElementById("ppPlaylist").classList.toggle("show");
    document.getElementById("ppPlMask").classList.toggle("show", open);
    if (open) _renderTab();
  });
  document.querySelectorAll(".pp-tab").forEach(function (b) {
    b.addEventListener("click", function () { _plTab = b.dataset.tab; _renderTab(); });
  });
  document.getElementById("ppFavBtn").addEventListener("click", function () {
    if (_plIndex < 0) return;
    _toggleFav(_plItems[_plIndex]);
    _syncFavBtn();
    if (_plTab !== "pl" && document.getElementById("ppPlaylist").classList.contains("show")) _renderTab();
  });
  function _closePlaylist() {
    document.getElementById("ppPlaylist").classList.remove("show");
    document.getElementById("ppPlMask").classList.remove("show");
  }
  document.getElementById("ppPlMask").addEventListener("click", _closePlaylist);
  document.getElementById("ppPlClose").addEventListener("click", _closePlaylist);
  function openPlayerPage() {
    if (_plIndex < 0) return;
    document.getElementById("playerPage").classList.add("show");
    // 打开时立即按当前播放进度定位：重置索引强制刷新高亮并居中当前句
    _lrcIdx = -1;
    _lrcHoldUntil = 0;
    requestAnimationFrame(function () { _syncLrc(_audio.currentTime); });
  }
  function closePlayerPage() {
    document.getElementById("playerPage").classList.remove("show");
    _closePlaylist();
  }

  var ppSeek = document.getElementById("ppSeek");
  ppSeek.addEventListener("input", function () {
    _seeking = true;
    var dur = _audio.duration;
    ppSeek.style.setProperty("--p", (ppSeek.value / 1000).toFixed(4));   // 拖动时实时更新填充
    if (isFinite(dur) && dur > 0) document.getElementById("ppCur").textContent = _fmtTime(dur * ppSeek.value / 1000);
  });
  ppSeek.addEventListener("change", function () {
    var dur = _audio.duration;
    if (isFinite(dur) && dur > 0) _audio.currentTime = dur * ppSeek.value / 1000;
    _seeking = false;
  });

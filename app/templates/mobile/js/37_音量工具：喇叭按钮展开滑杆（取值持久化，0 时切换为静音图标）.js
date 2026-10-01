  // ===== 音量工具：喇叭按钮展开滑杆（取值持久化，0 时切换为静音图标） =====
  var _svgVolOn = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>';
  var _svgVolOff = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 4v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg>';
  var _volBar = document.getElementById("ppVolBar");
  var _volRange = document.getElementById("ppVol");
  var _volVal = document.getElementById("ppVolVal");
  var _volBtn = document.getElementById("ppVolBtn");
  function _syncVol(save) {
    var v = _audio.volume;
    _volRange.value = Math.round(v * 100);
    _volRange.style.setProperty("--v", v.toFixed(3));
    _volVal.textContent = Math.round(v * 100) + "%";
    _volBtn.innerHTML = v > 0 ? _svgVolOn : _svgVolOff;
    if (save) { try { localStorage.setItem("ff_music_vol", String(Math.round(v * 100))); } catch (e) {} }
  }
  try {
    var _sv = parseInt(localStorage.getItem("ff_music_vol"), 10);
    if (isFinite(_sv)) _audio.volume = Math.max(0, Math.min(1, _sv / 100));
  } catch (e) {}
  _syncVol(false);
  _volBtn.addEventListener("click", function () { _volBar.classList.toggle("show"); });
  _volRange.addEventListener("input", function () {
    _audio.volume = Math.max(0, Math.min(1, _volRange.value / 100));
    _syncVol(true);
  });
  // 点空白处收起音量悬浮条（点喇叭或其内部不算）
  document.addEventListener("click", function (e) {
    if (!_volBar.classList.contains("show")) return;
    if (e.target.closest("#ppVolBar") || e.target.closest("#ppVolBtn")) return;
    _volBar.classList.remove("show");
  });

  if (navigator.mediaSession) {
    try {
      navigator.mediaSession.setActionHandler("play", function () { _audio.play().catch(function () {}); });
      navigator.mediaSession.setActionHandler("pause", function () { _audio.pause(); });
      navigator.mediaSession.setActionHandler("previoustrack", function () { if (_plIndex > 0) playIndex(_plIndex - 1, true); });
      navigator.mediaSession.setActionHandler("nexttrack", function () { if (_plIndex < _plItems.length - 1) playIndex(_plIndex + 1, true); });
    } catch (e) {}
  }

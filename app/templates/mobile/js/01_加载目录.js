  // ---------- 加载目录 ----------
  function showLoading(on) {
    document.getElementById("loading").classList.toggle("show", !!on);
  }
  // 提示条同时只显示一条：新提示先顶掉旧的（含旧定时器），不堆叠
  var _toastEl = null, _toastFade = null, _toastKill = null;
  function toast(msg, type) {
    var wrap = document.getElementById("toastWrap");
    if (_toastFade) { clearTimeout(_toastFade); _toastFade = null; }
    if (_toastKill) { clearTimeout(_toastKill); _toastKill = null; }
    if (_toastEl && _toastEl.parentNode) _toastEl.parentNode.removeChild(_toastEl);
    var el = document.createElement("div");
    el.className = "toast" + (type ? " " + type : "");
    el.textContent = msg;
    wrap.appendChild(el);
    _toastEl = el;
    _toastFade = setTimeout(function () { el.style.opacity = "0"; el.style.transition = "opacity .3s"; }, 1800);
    _toastKill = setTimeout(function () {
      if (el.parentNode) el.parentNode.removeChild(el);
      if (_toastEl === el) _toastEl = null;
    }, 2200);
  }

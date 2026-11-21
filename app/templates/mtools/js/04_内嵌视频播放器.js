/* ============================================================================
 * 内嵌视频播放器（自定义控制条）
 *   · 点画面显示 / 隐藏控制条，播放中 3 秒自动隐藏；
 *   · 进度条拖动即 seek；后退 5s / 播放暂停 / 快进 5s；
 *   · 倍速（0.5× ~ 2×，记忆上次选择）、选集（本次下载列表里的其它视频）、全屏；
 *   · 视频源走 /api/stream?path=<产物路径>：支持 Range，且不会改动下载任务状态。
 * ========================================================================== */

let PL_TASK = null;          // 当前播放的任务（关闭置空，用于忽略关闭后的 error 事件）
let PL_SEEKING = false;      // 是否正在拖动进度条
let PL_HIDE_T = null;        // 控制条自动隐藏定时器
let PL_FLASH_T = null;       // 快进提示定时器

const PL_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];
let PL_RATE = 1;
try {
  const _r = parseFloat(localStorage.getItem("mtools.player.rate"));
  if (PL_RATES.indexOf(_r) >= 0) PL_RATE = _r;
} catch (_) { /* 隐私模式忽略 */ }

/* ---------------- 小工具 ---------------- */
function plFmtDur(sec) {
  sec = Math.max(0, Math.round(Number(sec) || 0));
  const p = function (n) { return (n < 10 ? "0" : "") + n; };
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? h + ":" + p(m) + ":" + p(s) : m + ":" + p(s);
}
function plRateLabel(r) {
  return (Number(r) === Math.round(Number(r)) ? Number(r).toFixed(1) : String(r)) + "×";
}
function plTipShow(msg, isErr) {
  const tip = $("plTip");
  if (!tip) return;
  tip.hidden = false;
  tip.className = "pl-tip" + (isErr ? " err" : "");
  tip.textContent = msg;
}
function plTipHide() {
  const tip = $("plTip");
  if (tip) tip.hidden = true;
}
function plFlash(msg) {
  const el = $("plFlash");
  if (!el) return;
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(PL_FLASH_T);
  PL_FLASH_T = setTimeout(function () { el.classList.remove("show"); }, 700);
}

/* ---------------- 控制条显示 / 隐藏 ---------------- */
function plShowCtrl(show, keep) {
  const page = $("playerPage");
  clearTimeout(PL_HIDE_T);
  if (!show) {
    page.classList.add("idle");
    plHideRate();
    return;
  }
  page.classList.remove("idle");
  const v = $("plVideo");
  const popupOpen = $("plRatePop").classList.contains("show") ||
    $("plEps").classList.contains("show");
  // 播放中才自动隐藏；暂停 / 正在拖进度 / 面板打开时保持显示
  if (!keep && PL_TASK && !v.paused && !popupOpen) {
    PL_HIDE_T = setTimeout(function () { page.classList.add("idle"); }, 3000);
  }
}

/* ---------------- 播放状态 / 时间 ---------------- */
function plUpdatePlayUI() {
  const v = $("plVideo");
  const paused = v.paused;
  $("plPlay").innerHTML = paused
    ? '<i class="bi bi-play-fill"></i>'
    : '<i class="bi bi-pause-fill"></i>';
  $("plBig").hidden = !(paused && PL_TASK);
}

function plRefreshTime() {
  const v = $("plVideo");
  const dur = v.duration;
  const ok = isFinite(dur) && dur > 0;
  $("plCur").textContent = plFmtDur(v.currentTime);
  $("plDur").textContent = ok ? plFmtDur(dur) : "0:00";
  const pct = ok ? Math.max(0, Math.min(100, v.currentTime / dur * 100)) : 0;
  const seek = $("plSeek");
  seek.style.setProperty("--p", pct.toFixed(2) + "%");
  if (!PL_SEEKING) seek.value = String(Math.round(pct * 10));
}

function plUpdateMeta() {
  if (!PL_TASK) return;
  const v = $("plVideo");
  const parts = [];
  if (PL_TASK.size > 0) parts.push(fmtBytes(PL_TASK.size));
  if (isFinite(v.duration) && v.duration > 0) parts.push(plFmtDur(v.duration));
  if (v.videoWidth && v.videoHeight) parts.push(v.videoWidth + "×" + v.videoHeight);
  const eps = plEpisodeList();
  if (eps.length > 1) {
    const idx = eps.findIndex(function (x) { return PL_TASK && x.id === PL_TASK.id; });
    if (idx >= 0) parts.push("第 " + (idx + 1) + " / " + eps.length + " 集");
  }
  $("plMeta").textContent = parts.join(" · ");
}

/* ---------------- 选集 ---------------- */
function plEpisodeList() {
  return D.items.filter(downloadIsVideo).slice().sort(function (a, b) {
    return String(a.name || "").localeCompare(String(b.name || ""), "zh-CN", { numeric: true });
  });
}

function plBuildEps() {
  const list = plEpisodeList();
  if (!list.length) {
    $("plEpsList").innerHTML = '<div class="pl-ep">没有可播放的视频</div>';
    return;
  }
  $("plEpsList").innerHTML = list.map(function (t, i) {
    return '<button class="pl-ep' + (PL_TASK && t.id === PL_TASK.id ? " on" : "") +
      '" type="button" data-ep="' + esc(t.id) + '">' +
      '<span class="n">' + (i + 1) + "</span>" +
      '<span class="nm">' + esc(t.name || "未命名") + "</span></button>";
  }).join("");
}
function plOpenEps() {
  plBuildEps();
  $("plEps").classList.add("show");
  $("plEpsMask").classList.add("show");
  plShowCtrl(true, true);
}
function plCloseEps() {
  $("plEps").classList.remove("show");
  $("plEpsMask").classList.remove("show");
}

/* ---------------- 倍速 ---------------- */
function plBuildRate() {
  $("plRateList").innerHTML = PL_RATES.map(function (r) {
    return '<button class="pl-rate-item' + (r === PL_RATE ? " on" : "") +
      '" type="button" data-rate="' + r + '">' + plRateLabel(r) + "</button>";
  }).join("");
}
function plSetRate(r) {
  r = Number(r) || 1;
  PL_RATE = r;
  $("plVideo").playbackRate = r;
  $("plRateBtn").textContent = plRateLabel(r);
  try { localStorage.setItem("mtools.player.rate", String(r)); } catch (_) { /* 忽略 */ }
  plBuildRate();
  plHideRate();
  plFlash("倍速 " + plRateLabel(r));
  plShowCtrl(true);
}
function plToggleRate() {
  const pop = $("plRatePop");
  if (pop.classList.contains("show")) return plHideRate();
  plBuildRate();
  pop.classList.add("show");
  plShowCtrl(true, true);
}
function plHideRate() {
  $("plRatePop").classList.remove("show");
}

/* ---------------- 播放控制 ---------------- */
function plTogglePlay() {
  const v = $("plVideo");
  if (!PL_TASK) return;
  if (v.paused) {
    const p = v.play();
    if (p && p.catch) p.catch(function () { /* 忽略自动播放被拦 */ });
  } else {
    v.pause();
  }
}
function plSeekBy(delta) {
  const v = $("plVideo");
  const dur = v.duration;
  if (!PL_TASK || !isFinite(dur) || dur <= 0) return;
  v.currentTime = Math.max(0, Math.min(dur - 0.05, v.currentTime + delta));
  plFlash(delta > 0 ? "快进 5 秒" : "后退 5 秒");
  plRefreshTime();
  plShowCtrl(true);
}

function plToggleFullscreen() {
  const page = $("playerPage");
  const v = $("plVideo");
  if (document.fullscreenElement || document.webkitFullscreenElement) {
    (document.exitFullscreen || document.webkitExitFullscreen || function () {}).call(document);
    return;
  }
  if (page.requestFullscreen) {
    page.requestFullscreen().catch(function () { /* 忽略 */ });
  } else if (page.webkitRequestFullscreen) {
    page.webkitRequestFullscreen();
  } else if (v.webkitEnterFullscreen) {
    v.webkitEnterFullscreen();          // iOS 只能让 video 元素进全屏
  }
}
function plSyncFullIcon() {
  const on = !!(document.fullscreenElement || document.webkitFullscreenElement);
  $("plFullBtn").innerHTML = '<i class="bi ' +
    (on ? "bi-fullscreen-exit" : "bi-arrows-fullscreen") + '"></i>';
}

/* ---------------- 打开 / 切换 / 关闭 ---------------- */
function plLoadTask(t) {
  const artifact = String(t.artifact || "");
  if (!artifact) {
    toast("产物路径缺失，无法播放，可点「保存」取回文件", "err");
    return false;
  }
  const v = $("plVideo");
  PL_TASK = t;
  plHideRate();
  plCloseEps();

  $("plTitle").textContent = t.name || "视频";
  $("plSave").href = "/api/dl/stream/" + enc(t.id);
  $("plMeta").textContent = t.size > 0 ? fmtBytes(t.size) : "";
  $("plEpBtn").hidden = plEpisodeList().length <= 1;
  plTipHide();

  v.pause();
  v.playbackRate = PL_RATE;
  $("plRateBtn").textContent = plRateLabel(PL_RATE);
  v.src = "/api/stream?path=" + encodeURIComponent(artifact);
  v.load();
  plRefreshTime();
  plUpdatePlayUI();
  plShowCtrl(true);

  const p = v.play();
  if (p && p.catch) p.catch(function () { /* 由用户点播放键 */ });
  return true;
}

function downloadPlay(id) {
  const t = D.items.filter(function (x) { return x.id === id; })[0];
  if (!t) return toast("任务不存在", "err");
  if (!t.exists) return toast("产物文件已清理，无法播放，请重新下载", "err");
  if (!t.artifact) return toast("产物路径缺失，无法播放，可点「保存」取回文件", "err");

  $("playerMask").classList.add("show");
  $("playerPage").classList.add("show");
  if (sheetVisible()) closeSheet();
  plLoadTask(t);
}

function closePlayer() {
  const v = $("plVideo");
  PL_TASK = null;
  PL_SEEKING = false;
  clearTimeout(PL_HIDE_T);
  plHideRate();
  plCloseEps();
  if (v) {
    try { v.pause(); } catch (_) { /* 忽略 */ }
    v.removeAttribute("src");
    try { v.load(); } catch (_) { /* 忽略 */ }
  }
  $("playerPage").classList.remove("show", "idle");
  $("playerMask").classList.remove("show");
  plTipHide();
}

/* ==================================================================
   事件绑定
   ================================================================== */
$("plClose").addEventListener("click", closePlayer);
$("playerMask").addEventListener("click", closePlayer);

$("plPlay").addEventListener("click", plTogglePlay);
$("plBig").addEventListener("click", plTogglePlay);
$("plBack5").addEventListener("click", function () { plSeekBy(-5); });
$("plFwd5").addEventListener("click", function () { plSeekBy(5); });
$("plRateBtn").addEventListener("click", plToggleRate);
$("plEpBtn").addEventListener("click", plOpenEps);
$("plFullBtn").addEventListener("click", plToggleFullscreen);
$("plEpsClose").addEventListener("click", plCloseEps);
$("plEpsMask").addEventListener("click", plCloseEps);

$("plRateList").addEventListener("click", function (e) {
  const b = e.target.closest("[data-rate]");
  if (b) plSetRate(parseFloat(b.getAttribute("data-rate")));
});

$("plEpsList").addEventListener("click", function (e) {
  const b = e.target.closest("[data-ep]");
  if (!b) return;
  const t = D.items.filter(function (x) { return x.id === b.getAttribute("data-ep"); })[0];
  if (t) plLoadTask(t);
  plCloseEps();
});

/* 点画面：显示 / 隐藏控制条（点在控制条、大按钮、面板上不处理） */
$("plStage").addEventListener("click", function (e) {
  if (e.target.closest(".pl-ctrl, .pl-big, .pl-rate, .pl-eps, .pl-eps-mask, .pl-tip")) return;
  if ($("plRatePop").classList.contains("show")) return plHideRate();
  plShowCtrl($("playerPage").classList.contains("idle"));
});

/* 进度条 */
$("plSeek").addEventListener("input", function () {
  const v = $("plVideo");
  if (!isFinite(v.duration) || v.duration <= 0) return;
  PL_SEEKING = true;
  const pct = Number(this.value) / 1000;
  this.style.setProperty("--p", (pct * 100).toFixed(2) + "%");
  $("plCur").textContent = plFmtDur(v.duration * pct);
});
$("plSeek").addEventListener("change", function () {
  const v = $("plVideo");
  PL_SEEKING = false;
  if (!isFinite(v.duration) || v.duration <= 0) return;
  v.currentTime = Math.max(0, Math.min(v.duration - 0.05, Number(this.value) / 1000 * v.duration));
  plRefreshTime();
  plShowCtrl(true);
});

/* 视频事件 */
$("plVideo").addEventListener("play", function () {
  plUpdatePlayUI();
  plShowCtrl(true);
});
$("plVideo").addEventListener("pause", function () {
  plUpdatePlayUI();
  plShowCtrl(true, true);
});
$("plVideo").addEventListener("timeupdate", plRefreshTime);
$("plVideo").addEventListener("ended", function () {
  plUpdatePlayUI();
  plShowCtrl(true, true);
});
$("plVideo").addEventListener("loadedmetadata", function () {
  if (!PL_TASK) return;
  plTipHide();
  plUpdateMeta();
  plRefreshTime();
});
$("plVideo").addEventListener("waiting", function () {
  if (PL_TASK) plTipShow("缓冲中…", false);
});
$("plVideo").addEventListener("playing", function () {
  if (PL_TASK) plTipHide();
});
$("plVideo").addEventListener("canplay", function () {
  if (PL_TASK) plTipHide();
});
$("plVideo").addEventListener("error", function () {
  if (!PL_TASK) return;                    // 关闭播放器时刻意卸载 src，忽略这类报错
  $("plBig").hidden = true;                // 错误提示居中显示，别和大播放键叠在一起
  const v = $("plVideo");
  const code = v.error ? v.error.code : 0;
  if (code === 4) {
    plTipShow("浏览器无法直接播放该格式（如 MKV / AVI / TS），可点右上角「保存」后用本地播放器观看。", true);
  } else if (code === 3) {
    plTipShow("视频解码失败，编码格式可能不受支持，可保存后用本地播放器观看。", true);
  } else {
    plTipShow("视频加载失败，产物文件可能已被清理，请刷新后重试。", true);
  }
});

/* 全屏图标同步 */
document.addEventListener("fullscreenchange", plSyncFullIcon);
document.addEventListener("webkitfullscreenchange", plSyncFullIcon);

/* 键盘：空格播放暂停 / ←→ 快退快进 / F 全屏 / Esc 关闭 */
document.addEventListener("keydown", function (e) {
  if (!$("playerPage").classList.contains("show")) return;
  const tag = String((e.target && e.target.tagName) || "").toLowerCase();
  if (tag === "input" || tag === "textarea") return;

  if (e.key === " " || e.key === "k" || e.key === "K") {
    e.preventDefault();
    plTogglePlay();
  } else if (e.key === "ArrowLeft") {
    e.preventDefault();
    plSeekBy(-5);
  } else if (e.key === "ArrowRight") {
    e.preventDefault();
    plSeekBy(5);
  } else if (e.key === "f" || e.key === "F") {
    plToggleFullscreen();
  } else if (e.key === "Escape") {
    if ($("plEps").classList.contains("show")) return plCloseEps();
    if ($("plRatePop").classList.contains("show")) return plHideRate();
    closePlayer();
  }
});

/* 初始化倍速按钮文案 */
$("plRateBtn").textContent = plRateLabel(PL_RATE);

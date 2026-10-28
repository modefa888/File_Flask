/* ================================================================
 * 标签页内嵌音频播放器（mp3 / flac / wav / m4a / ogg / ape …，只读试听）
 *
 * 交互对齐 22_ 视频播放器：进度拖拽（带缓冲条）/ 音量 / 静音 / 倍速 /
 * 播放模式（顺序 · 单曲循环 · 随机）/ 上一首·下一首 / 同目录播放列表原位换歌 /
 * 空格·←→·↑↓ 快捷键 / 状态（音量·倍速·模式）永久记忆。
 * 音频流走 /api/stream（支持 Range，可拖进度），时长走 /api/video_duration。
 *
 * 注意：本文件在 00_preamble 大 IIFE 关闭之后加载，setupAudioView 是全局函数，
 * 由 openFile 的音频分支调用（activate(tab) 由调用方负责）。
 * ================================================================ */

var IDE_AUDIO_EXTS = ["mp3", "wav", "flac", "aac", "m4a", "ogg", "oga", "opus",
                      "wma", "ape", "aif", "aiff", "mka", "amr", "mid", "midi"];

var _apvDurCache = {};          // 时长缓存（abs -> 秒），列表滚动/重绘不重复请求
var _apvCleanups = [];          // 当前实例挂在 document/window 上的监听，切换曲目/关标签前清掉

// 播放器状态持久化：localStorage["ide.audioPlayer"]，下次打开沿用上次的音量/倍速/模式
var _apvState = (() => {
  const def = { volume: 1, muted: false, rate: 1, mode: "order", fold: false };
  try { return Object.assign(def, JSON.parse(localStorage.getItem("ide.audioPlayer") || "{}")); }
  catch (_) { return def; }
})();
function _apvSave() { try { localStorage.setItem("ide.audioPlayer", JSON.stringify(_apvState)); } catch (_) {} }

function _apvCleanupRun() {
  _apvCleanups.forEach(f => { try { f(); } catch (_) {} });
  _apvCleanups = [];
}

function _apvEsc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function _apvFmt(s) {
  if (!isFinite(s)) return "--:--";
  s = Math.max(0, Math.floor(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const mm = String(m).padStart(2, "0"), ss = String(sec).padStart(2, "0");
  return h ? h + ":" + mm + ":" + ss : mm + ":" + ss;
}

// 复用视频播放器的主题判定（设置 → 外观 → 播放器主题：light / dark / auto）
function _apvIsLight() {
  try { if (typeof vpvThemeIsLight === "function") return vpvThemeIsLight(); } catch (_) {}
  return false;
}

// 切换主题时由 applyVideoPlayerTheme（22_）统一调用：同步页面上所有音频播放器皮肤
window.applyAudioPlayerTheme = function (light) {
  const isLight = typeof light === "boolean" ? light : _apvIsLight();
  document.querySelectorAll(".apv-wrap").forEach(w => w.classList.toggle("apv-light", isLight));
};

function setupAudioView(tab, host, path, name) {
  _apvCleanupRun();                       // 复用标签页换歌：先摘掉旧实例的全局监听
  tab.isAudio = true;
  /* 全局唯一播放器：新实例接管前先停掉页面上其它音频 / 视频，避免两处同时出声 */
  document.querySelectorAll(".apv-wrap audio, .vpv-wrap video").forEach(m => { try { m.pause(); } catch (e) {} });

  const dir = path.slice(0, path.lastIndexOf("/")) || "/";
  const urlStream = p => "/api/stream?path=" + encodeURIComponent(p);

  host.innerHTML =
    '<div class="apv-wrap' + (_apvIsLight() ? " apv-light" : "") + (_apvState.fold ? " apv-fold" : "") + '">' +
      '<div class="apv-main">' +
        '<div class="apv-badge"></div>' +
        '<div class="apv-art"><div class="apv-disc"><i class="bi bi-music-note-beamed"></i>' +
          '<span class="apv-ring"></span></div></div>' +
        '<div class="apv-name"></div>' +
        '<div class="apv-sub"></div>' +
        '<div class="apv-timerow">' +
          '<span class="apv-t apv-cur">00:00</span>' +
          '<div class="apv-bar"><div class="apv-track">' +
            '<div class="apv-buf"></div><div class="apv-played"><span class="apv-knob"></span></div>' +
          '</div></div>' +
          '<span class="apv-t apv-dur">--:--</span>' +
        '</div>' +
        '<div class="apv-btns">' +
          '<button class="apv-btn apv-mode" title="播放模式：顺序播放"><i class="bi bi-list-ol"></i></button>' +
          '<button class="apv-btn apv-prev" title="上一首"><i class="bi bi-skip-start-fill"></i></button>' +
          '<button class="apv-btn apv-play apv-play-main" title="播放 / 暂停 (空格)"><i class="bi bi-play-fill"></i></button>' +
          '<button class="apv-btn apv-next" title="下一首"><i class="bi bi-skip-end-fill"></i></button>' +
          '<button class="apv-btn apv-list-toggle" title="显示 / 隐藏播放列表"><i class="bi bi-music-note-list"></i></button>' +
        '</div>' +
        '<div class="apv-row">' +
          '<button class="apv-btn apv-mute" title="静音 (M)"><i class="bi bi-volume-up-fill"></i></button>' +
          '<input type="range" class="apv-vol" min="0" max="1" step="0.01" value="1" title="音量">' +
          '<span class="apv-row-spacer"></span>' +
          '<div class="apv-speed">' +
            '<button class="apv-btn apv-speed-btn" title="倍速播放"><span class="apv-speed-cur">1.0x</span></button>' +
            '<div class="apv-speed-menu">' +
              '<button class="apv-speed-item" data-rate="0.5">0.5x</button>' +
              '<button class="apv-speed-item" data-rate="0.75">0.75x</button>' +
              '<button class="apv-speed-item active" data-rate="1">1.0x</button>' +
              '<button class="apv-speed-item" data-rate="1.25">1.25x</button>' +
              '<button class="apv-speed-item" data-rate="1.5">1.5x</button>' +
              '<button class="apv-speed-item" data-rate="2">2.0x</button>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="apv-err" style="display:none;"></div>' +
        '<audio preload="metadata"></audio>' +
      '</div>' +
      '<div class="apv-side">' +
        '<div class="apv-side-head"><i class="bi bi-music-note-list"></i> 播放列表' +
          '<span class="apv-count"></span></div>' +
        '<div class="apv-pl"></div>' +
      '</div>' +
    '</div>';

  const $ = sel => host.querySelector(sel);
  const wrap = $(".apv-wrap");
  const audio = $("audio");
  const bar = $(".apv-bar"), barTrack = $(".apv-track"), playedEl = $(".apv-played");
  const bufEl = $(".apv-buf");
  const curEl = $(".apv-cur"), durEl = $(".apv-dur");
  const playBtn = $(".apv-play-main"), prevBtn = $(".apv-prev"), nextBtn = $(".apv-next");
  const modeBtn = $(".apv-mode"), listBtn = $(".apv-list-toggle");
  const muteBtn = $(".apv-mute"), volEl = $(".apv-vol");
  const speedWrap = $(".apv-speed"), speedCur = $(".apv-speed-cur");
  const nameEl = $(".apv-name"), subEl = $(".apv-sub"), badgeEl = $(".apv-badge");
  const plList = $(".apv-pl"), plCount = $(".apv-count"), errEl = $(".apv-err");
  const sideEl = $(".apv-side");

  let curPath = path;
  let plItems = [];                 // [{abs, name, size_str}]
  let dragging = false;
  let switchToken = 0;

  /* ---------- 音量 / 静音 / 倍速：初始值来自持久化状态 ---------- */
  audio.volume = typeof _apvState.volume === "number" ? _apvState.volume : 1;
  audio.muted = !!_apvState.muted;
  audio.playbackRate = _apvState.rate || 1;
  volEl.value = String(audio.volume);

  const syncVolIcon = () => {
    const icon = audio.muted || audio.volume === 0 ? "bi-volume-mute-fill"
      : (audio.volume < 0.5 ? "bi-volume-down-fill" : "bi-volume-up-fill");
    muteBtn.innerHTML = '<i class="bi ' + icon + '"></i>';
    muteBtn.classList.toggle("on", audio.muted);
  };
  syncVolIcon();

  muteBtn.onclick = () => {
    audio.muted = !audio.muted;
    _apvState.muted = audio.muted; _apvSave();
    syncVolIcon();
  };
  volEl.addEventListener("input", () => {
    const v = parseFloat(volEl.value);
    audio.volume = isNaN(v) ? 1 : v;
    if (audio.volume > 0 && audio.muted) audio.muted = false;
    _apvState.volume = audio.volume; _apvState.muted = audio.muted; _apvSave();
    syncVolIcon();
  });

  const rateItems = [...host.querySelectorAll(".apv-speed-item")];
  const syncRate = () => {
    rateItems.forEach(x => x.classList.toggle("active", parseFloat(x.dataset.rate) === audio.playbackRate));
    speedCur.textContent = (audio.playbackRate || 1).toFixed(1) + "x";
  };
  rateItems.forEach(it => {
    it.onclick = e => {
      e.stopPropagation();
      audio.playbackRate = parseFloat(it.dataset.rate) || 1;
      _apvState.rate = audio.playbackRate; _apvSave();
      syncRate();
      speedWrap.classList.remove("open");
    };
  });
  speedCur.parentNode.onclick = e => { e.stopPropagation(); speedWrap.classList.toggle("open"); };
  syncRate();
  const closeSpeedMenu = () => { if (host.isConnected) speedWrap.classList.remove("open"); };
  document.addEventListener("click", closeSpeedMenu);
  _apvCleanups.push(() => document.removeEventListener("click", closeSpeedMenu));

  /* ---------- 播放模式：顺序 → 单曲循环 → 随机 ---------- */
  const MODES = [
    { key: "order", label: "顺序播放", icon: "bi-list-ol" },
    { key: "one", label: "单曲循环", icon: "bi-repeat-1" },
    { key: "shuffle", label: "随机播放", icon: "bi-shuffle" },
  ];
  const modeOf = key => MODES.find(m => m.key === key) || MODES[0];
  const syncMode = () => {
    const m = modeOf(_apvState.mode);
    modeBtn.innerHTML = '<i class="bi ' + m.icon + '"></i>';
    modeBtn.title = "播放模式：" + m.label;
    modeBtn.classList.toggle("on", m.key !== "order");
  };
  syncMode();
  modeBtn.onclick = () => {
    const i = MODES.findIndex(m => m.key === _apvState.mode);
    _apvState.mode = MODES[(i + 1) % MODES.length].key;
    _apvSave(); syncMode();
  };

  /* ---------- 播放 / 暂停 ---------- */
  const syncPlayIcon = () => {
    const playing = !audio.paused && !audio.ended;
    playBtn.innerHTML = '<i class="bi ' + (playing ? "bi-pause-fill" : "bi-play-fill") + '"></i>';
    $(".apv-disc").classList.toggle("spin", playing);
  };
  const togglePlay = () => {
    errEl.style.display = "none";
    if (audio.paused) audio.play().catch(() => {
      errEl.textContent = "无法播放：浏览器可能不支持该音频编码（如 ape / wma），可下载后用本地播放器试听";
      errEl.style.display = "";
    });
    else audio.pause();
  };
  playBtn.onclick = togglePlay;
  audio.addEventListener("play", () => {
    // 同一时刻只允许一个媒体在播：新音频开始，暂停其它音频 / 视频
    document.querySelectorAll(".apv-wrap audio, .vpv-wrap video").forEach(m => {
      if (m !== audio) { try { m.pause(); } catch (e) {} }
    });
    syncPlayIcon();
  });
  audio.addEventListener("pause", syncPlayIcon);
  audio.addEventListener("ended", syncPlayIcon);

  /* ---------- 进度：时间 / 缓冲 / 拖拽 ---------- */
  const setPlayed = ratio => {
    const r = Math.max(0, Math.min(1, ratio || 0));
    playedEl.style.width = (r * 100) + "%";   // 圆点贴在已播放条右端（定位交给 CSS），这里只改宽度
  };
  const syncBuffered = () => {
    try {
      if (!audio.duration || !audio.buffered.length) return;
      const end = audio.buffered.end(audio.buffered.length - 1);
      bufEl.style.width = Math.min(100, (end / audio.duration) * 100) + "%";
    } catch (_) {}
  };
  audio.addEventListener("loadedmetadata", () => {
    durEl.textContent = _apvFmt(audio.duration);
    if (curPath && isFinite(audio.duration)) _apvDurCache[curPath] = audio.duration;
    syncBuffered();
  });
  audio.addEventListener("timeupdate", () => {
    if (dragging) return;
    curEl.textContent = _apvFmt(audio.currentTime);
    setPlayed(audio.duration ? audio.currentTime / audio.duration : 0);
  });
  audio.addEventListener("progress", syncBuffered);
  audio.addEventListener("error", () => {
    errEl.textContent = "音频加载失败：文件可能已损坏、被移动，或编码不被浏览器支持";
    errEl.style.display = "";
  });

  const ratioAt = e => {
    const r = barTrack.getBoundingClientRect();
    if (!r.width) return 0;
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  };
  const seekTo = ratio => {
    if (!isFinite(audio.duration) || !audio.duration) return;
    audio.currentTime = ratio * audio.duration;
    curEl.textContent = _apvFmt(audio.currentTime);
    setPlayed(ratio);
  };
  bar.addEventListener("pointerdown", e => {
    if (!isFinite(audio.duration) || !audio.duration) return;
    dragging = true;
    bar.setPointerCapture && bar.setPointerCapture(e.pointerId);
    seekTo(ratioAt(e));
  });
  bar.addEventListener("pointermove", e => {
    if (!dragging) return;
    const r = ratioAt(e);
    setPlayed(r);
    curEl.textContent = _apvFmt((audio.duration || 0) * r);
  });
  const endDrag = e => {
    if (!dragging) return;
    dragging = false;
    seekTo(ratioAt(e));
    if (bar.releasePointerCapture && e.pointerId != null) {
      try { bar.releasePointerCapture(e.pointerId); } catch (_) {}
    }
  };
  bar.addEventListener("pointerup", endDrag);
  bar.addEventListener("pointercancel", () => { dragging = false; });

  /* ---------- 列表：同目录音频，点击原位换歌 ---------- */
  const fetchDuration = (abs, el) => {
    const cached = _apvDurCache[abs];
    if (cached != null) { el.textContent = _apvFmt(cached); return; }
    fetch("/api/video_duration?path=" + encodeURIComponent(abs))
      .then(r => r.json())
      .then(d => {
        if (!d || d.duration == null || !el.isConnected) return;
        _apvDurCache[abs] = d.duration;
        el.textContent = _apvFmt(d.duration);
      })
      .catch(() => {});
  };

  const scrollCurIntoView = () => {
    const cur = plList.querySelector(".apv-pl-row.cur");
    if (cur) try { cur.scrollIntoView({ block: "nearest" }); } catch (_) {}
  };

  const renderPlaylist = () => {
    if (!plItems.length) {
      plCount.textContent = "";
      plList.innerHTML = '<div class="apv-pl-empty"><i class="bi bi-folder2-open"></i> 同目录下没有其他音频</div>';
      return;
    }
    plCount.textContent = plItems.length;
    plList.innerHTML = plItems.map((it, i) =>
      '<div class="apv-pl-row' + (it.abs === curPath ? " cur" : "") + '" data-i="' + i + '" title="' + _apvEsc(it.name) + '">' +
        '<span class="apv-pl-ic">' + (it.abs === curPath ? '<i class="bi bi-soundwave"></i>' : '<i class="bi bi-music-note"></i>') + '</span>' +
        '<span class="apv-pl-name">' + _apvEsc(it.name) + '</span>' +
        '<span class="apv-pl-dur" data-dur="' + i + '">--:--</span>' +
      '</div>').join("");
    plList.querySelectorAll(".apv-pl-row").forEach(row => {
      const it = plItems[+row.dataset.i];
      fetchDuration(it.abs, row.querySelector(".apv-pl-dur"));
      row.addEventListener("click", () => playPath(it.abs, true));
    });
    scrollCurIntoView();
  };

  // 换歌：不重建播放器，只换源 + 同步标题 / 列表高亮 / 标签页
  const playPath = (abs, autoplay) => {
    if (!abs || abs === curPath) {
      if (autoplay && audio.paused) togglePlay();
      return;
    }
    curPath = abs;
    const nm = abs.split("/").pop() || "";
    if (++switchToken === 0) switchToken = 1;
    const token = switchToken;
    errEl.style.display = "none";
    dragging = false;
    nameEl.textContent = nm;
    nameEl.title = nm;
    const it = plItems.find(x => x.abs === abs);
    subEl.textContent = ((nm.split(".").pop() || "").toUpperCase() || "音频") +
      (it && it.size_str ? " · " + it.size_str : "");
    curEl.textContent = "00:00";
    durEl.textContent = _apvDurCache[abs] != null ? _apvFmt(_apvDurCache[abs]) : "--:--";
    setPlayed(0);
    bufEl.style.width = "0%";
    audio.pause();
    audio.src = urlStream(abs);
    audio.load();
    audio.addEventListener("loadedmetadata", function onMeta() {
      audio.removeEventListener("loadedmetadata", onMeta);
      if (token !== switchToken) return;
      if (autoplay) audio.play().catch(() => {});
    });
    renderPlaylist();
    try {
      if (typeof window.IDE_SYNC_VIDEO_TAB === "function") window.IDE_SYNC_VIDEO_TAB(tab, abs, nm);
    } catch (_) {}
  };

  const step = dirStep => {
    if (plItems.length < 2) return;
    const idx = plItems.findIndex(it => it.abs === curPath);
    if (idx < 0) return;
    const next = (idx + dirStep + plItems.length) % plItems.length;
    playPath(plItems[next].abs, true);
  };
  prevBtn.onclick = () => step(-1);
  nextBtn.onclick = () => step(1);
  audio.addEventListener("ended", () => {
    const mode = _apvState.mode;
    if (mode === "one") { audio.currentTime = 0; audio.play().catch(() => {}); return; }
    if (mode === "shuffle" && plItems.length > 1) {
      const others = plItems.filter(it => it.abs !== curPath);
      playPath(others[Math.floor(Math.random() * others.length)].abs, true);
      return;
    }
    const idx = plItems.findIndex(it => it.abs === curPath);
    if (idx >= 0 && idx < plItems.length - 1) playPath(plItems[idx + 1].abs, true);
  });

  /* ---------- 播放列表显隐 ---------- */
  listBtn.onclick = () => {
    _apvState.fold = !_apvState.fold;
    _apvSave();
    wrap.classList.toggle("apv-fold", _apvState.fold);
    sideEl.style.display = _apvState.fold ? "none" : "";
    listBtn.classList.toggle("on", !_apvState.fold);
  };
  listBtn.classList.toggle("on", !_apvState.fold);

  /* ---------- 键盘：空格 / M / ←→ / ↑↓（仅当前标签可见时接管） ---------- */
  const keyHandler = e => {
    if (!host.isConnected || !host.classList.contains("active")) return;
    const tag = (e.target && e.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select" || (e.target && e.target.isContentEditable)) return;
    const k = (e.key || "").toLowerCase();
    if (e.key === " ") {
      e.preventDefault(); e.stopPropagation(); togglePlay();
    } else if (k === "m") {
      e.preventDefault(); e.stopPropagation(); muteBtn.click();
    } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault(); e.stopPropagation();
      if (!isFinite(audio.duration)) return;
      audio.currentTime = Math.max(0, Math.min(audio.duration,
        audio.currentTime + (e.key === "ArrowRight" ? 5 : -5)));
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault(); e.stopPropagation();
      const v = Math.max(0, Math.min(1, (audio.volume || 0) + (e.key === "ArrowUp" ? 0.05 : -0.05)));
      audio.volume = v; volEl.value = String(v);
      _apvState.volume = v; _apvState.muted = false; audio.muted = false; _apvSave();
      syncVolIcon();
    }
  };
  document.addEventListener("keydown", keyHandler, true);
  _apvCleanups.push(() => document.removeEventListener("keydown", keyHandler, true));

  /* ---------- 首次渲染：填标题 / 载入同目录列表 ---------- */
  const fillMeta = (sizeStr) => {
    const nm = curPath.split("/").pop() || name || "";
    nameEl.textContent = nm;
    nameEl.title = nm;
    const ext = (nm.split(".").pop() || "").toUpperCase() || "音频";
    subEl.textContent = ext + (sizeStr ? " · " + sizeStr : "");
    badgeEl.textContent = sizeStr || "";
    badgeEl.style.display = sizeStr ? "" : "none";
  };
  fillMeta("");
  curEl.textContent = "00:00";
  setPlayed(0);
  audio.src = urlStream(curPath);

  fetch("/api/files?path=" + encodeURIComponent(dir))
    .then(r => r.json())
    .then(d => {
      if (!host.isConnected) return;
      if (d.error) throw new Error(d.error);
      plItems = (d.items || [])
        .filter(it => !it.is_dir && IDE_AUDIO_EXTS.indexOf((it.name || "").split(".").pop().toLowerCase()) >= 0)
        .sort((a, b) => (a.name || "").localeCompare(b.name || "", "zh-Hans-CN"))
        .map(it => ({ abs: dir.replace(/\/+$/, "") + "/" + it.name, name: it.name, size_str: it.size_str || "" }));
      const cur = plItems.find(it => it.abs === curPath);
      if (cur && cur.size_str) fillMeta(cur.size_str);
      renderPlaylist();
    })
    .catch(() => {
      if (!host.isConnected) return;
      plItems = [];
      renderPlaylist();
    });

  /* ---------- 清理：标签关闭 / 换源重建时停播并解绑 ---------- */
  const cleanup = () => {
    _apvCleanupRun();
    try { audio.pause(); } catch (_) {}
    document.removeEventListener("click", closeSpeedMenu);
    document.removeEventListener("keydown", keyHandler, true);
  };
  // 同一标签页换歌会重跑本函数：旧 observer 先断开，避免越积越多
  if (host._apvObserver) { try { host._apvObserver.disconnect(); } catch (_) {} }
  const cleanObserver = new MutationObserver(() => {
    if (!host.isConnected) { cleanObserver.disconnect(); cleanup(); }
  });
  host._apvObserver = cleanObserver;
  if (host.parentNode) cleanObserver.observe(host.parentNode, { childList: true });
}

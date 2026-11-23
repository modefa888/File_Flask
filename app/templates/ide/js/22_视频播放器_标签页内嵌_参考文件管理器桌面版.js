  /* ================================================================
   * 标签页内嵌视频播放器（mp4/mkv/webm/…，只读预览，不做文本编辑）
   * 交互参考文件管理器桌面版的视频预览：进度拖拽（带缓冲条）/ 音量 / 倍速 /
   * 播放模式（顺序·循环·随机）/ 旋转 / 画中画 / 全屏 / 封面海报层 /
   * 控制条自动隐藏 / 空格·M·F·←→ 快捷键，另带同目录视频播放列表（原位切换）。
   * 视频流走 /api/stream（Range），封面走 /api/thumbnail，时长走 /api/video_duration。
   * 注意：本文件在 00_preamble 大 IIFE 关闭之后加载，setupVideoView 是全局函数，
   * 由 openFile 的视频分支调用（activate(tab) 由调用方负责）。
   * ================================================================ */

  var IDE_VIDEO_EXTS = ["mp4", "mkv", "avi", "mov", "wmv", "flv", "webm", "m4v", "rmvb", "mpg", "mpeg", "3gp"];
  var _vpvDurCache = {};      // 播放列表时长缓存（abs -> 秒），避免重复请求
  var _vpvPlayMode = "order"; // 播放模式：order 顺序 / loop 循环 / shuffle 随机（与 _vpvStore.mode 保持同步）

  // 播放器状态持久化：单独 JSON（localStorage["ide.videoPlayer"]），永久记住
  // 音量 / 静音 / 倍速 / 播放模式——下次打开视频标签页沿用上一次的状态（如静音仍静音）
  var _vpvStore = (() => {
    const def = { volume: 1, muted: false, rate: 1, mode: "order", plFold: false };
    try { return Object.assign(def, JSON.parse(localStorage.getItem("ide.videoPlayer") || "{}")); }
    catch (_) { return def; }
  })();
  var _vpvSave = () => { try { localStorage.setItem("ide.videoPlayer", JSON.stringify(_vpvStore)); } catch (_) {} };

  /* ---------- 播放器主题：白天 / 黑夜 / 跟随编辑器 ----------
     偏好在 ide.settings.playerTheme（light / dark / auto），由「设置 → 外观 → 播放器主题」写入；
     auto（默认）= 跟随「界面主题」，界面切浅色播放器也变白天，切深色跟着变回黑夜。
     解析结果以 vpv-light 类挂在 .vpv-wrap 上，白天皮肤见 28_标签页内嵌视频播放器.css。 */
  function vpvThemeIsLight() {
    var pref = "auto", ide = "dark";
    try {
      var s = JSON.parse(localStorage.getItem("ide.settings") || "{}") || {};
      pref = s.playerTheme || "auto";
      ide = s.theme || "dark";
    } catch (_) { }
    if (pref === "light" || pref === "dark") return pref === "light";
    // 跟随编辑器：交给设置页统一判定（支持「跟随系统」主题）
    return (typeof window.ideThemeLight === "function") ? window.ideThemeLight() : ide === "light";
  }
  // 切换主题 / 打开新播放器时调用：一次性同步页面上所有播放器实例
  function applyVideoPlayerTheme() {
    var light = vpvThemeIsLight();
    document.querySelectorAll(".vpv-wrap").forEach(function (w) { w.classList.toggle("vpv-light", light); });
    // 音频播放器（48_）同一套主题偏好：加载顺序在 22_ 之后，这里按需调用
    if (typeof window.applyAudioPlayerTheme === "function") window.applyAudioPlayerTheme(light);
  }

  // 全局唯一播放器：切换视频时复用同一标签页重跑 setupVideoView，
  // 旧实例挂在 document/window 上的监听（快捷键等）必须先移除，否则会双重触发
  var _vpvCleanups = [];
  function _vpvCleanupRun() {
    _vpvCleanups.forEach(f => { try { f(); } catch (_) {} });
    _vpvCleanups = [];
  }

  function _vpvEsc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function _vpvFmt(s) {
    if (!isFinite(s)) return "--:--";
    s = Math.max(0, Math.floor(s));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const mm = String(m).padStart(2, "0"), ss = String(sec).padStart(2, "0");
    return h ? h + ":" + mm + ":" + ss : mm + ":" + ss;
  }

  /* opts（可选，用于复用本播放器播远程 / 其它来源的视频）：
     · streamUrl(abs)   视频流地址，默认 /api/stream
     · posterUrl(abs)   封面图地址，返回 "" 则不加载封面（远程没有缩略图）
     · durationUrl(abs) 时长接口，传 null 表示不查询（远程拿不到，列表里显示 --:--）
     · thumbUrl(abs)    播放列表缩略图，传 null 表示只显示图标
     · transcode        是否允许 ffmpeg 转码兜底，默认 true（远程文件传 false）
     · listVideos(dir)  返回 Promise<[{abs,name,size_str}]>，不传则用本地 /api/files
     · activeHost       判断快捷键是否生效的元素（默认 host 自身；远程播放器传标签根节点）
     · fileSize         当前视频字节数（可选，用于估算「实时加载速度」；本地文件会自动取列表里的 size）
     · onSwitch(abs,name) 播放列表切歌后的回调，默认同步 IDE 标签页
     · noMark           不打 tab.isVideo（远程文件标签不能被本地视频的「复用标签」逻辑抢走） */
  function setupVideoView(tab, host, path, name, opts) {
    _vpvCleanupRun();          // 复用标签页切换视频时，先清掉旧实例的全局监听
    const _o = opts || {};
    if (!_o.noMark) tab.isVideo = true;   // 远程文件标签不能被 openFile 当成「可复用的本地视频标签」
    /* 全局唯一播放器：新实例接管前先停掉页面上其它视频，避免两处同时出声 */
    document.querySelectorAll(".vpv-wrap video").forEach(v => { try { v.pause(); } catch (e) {} });
    const urlStream = _o.streamUrl || (p => "/api/stream?path=" + encodeURIComponent(p));
    const urlPoster = _o.posterUrl || (p => "/api/thumbnail?path=" + encodeURIComponent(p));
    const urlDuration = _o.durationUrl === null ? null : (_o.durationUrl || (p => "/api/video_duration?path=" + encodeURIComponent(p)));
    const urlThumb = _o.thumbUrl === null ? null : (_o.thumbUrl || (p => "/api/thumbnail?path=" + encodeURIComponent(p)));
    const canTranscode = _o.transcode !== false;
    const dir = path.slice(0, path.lastIndexOf("/")) || "/";
    const streamUrl = urlStream(path);
    const posterUrl = urlPoster(path);

    host.innerHTML =
      '<div class="vpv-wrap">' +
        '<div class="vpv-stage">' +
          '<div class="vpv-info" style="display:none;"></div>' +
          '<div class="vpv-title"></div>' +
          '<button class="vpv-title-toggle" title="隐藏标题"><i class="bi bi-eye"></i></button>' +
          '<video playsinline preload="metadata" src="' + streamUrl + '"></video>' +
          '<button class="vpv-center-btn" title="播放 (空格)"><i class="bi bi-play-fill"></i></button>' +
          '<div class="vpv-poster"' + (posterUrl ? ' style="background-image:url(\'' + posterUrl + '\')"' : '') + '>' +
            '<div class="vpv-name">' + _vpvEsc(name) + '</div>' +
          '</div>' +
          '<div class="vpv-seek-tip"></div>' +
          '<button class="vpv-side-toggle" title="收起播放列表"><i class="bi bi-chevron-right"></i></button>' +
          '<div class="vpv-controls">' +
            '<div class="vpv-timerow">' +
              '<span class="vpv-time vpv-time-cur">00:00</span>' +
              '<div class="vpv-progress"><div class="vpv-track">' +
                '<div class="vpv-buffered"></div><div class="vpv-played"></div><div class="vpv-knob"></div>' +
              '</div></div>' +
              '<span class="vpv-time vpv-time-dur">00:00</span>' +
            '</div>' +
            '<div class="vpv-row">' +
              '<button class="vpv-btn vpv-play" title="播放/暂停 (空格)"><i class="bi bi-play-fill"></i></button>' +
              '<div class="vpv-vol">' +
                '<button class="vpv-btn vpv-mute" title="静音 (M)"><i class="bi bi-volume-up-fill"></i></button>' +
                '<input type="range" class="vpv-vol-range" min="0" max="1" step="0.01" value="1" title="音量">' +
              '</div>' +
              '<div class="vpv-spacer"></div>' +
              '<div class="vpv-netspeed-wrap">' +
                '<button class="vpv-netspeed" title="实时加载速度 · 点击查看缓存并保存视频">' +
                  '<i class="bi bi-arrow-down-circle"></i><em class="vpv-netspeed-val">--</em>' +
                '</button>' +
                '<div class="vpv-cache-pop">' +
                  '<div class="vpv-cache-head"><i class="bi bi-hdd-stack"></i> 视频缓存</div>' +
                  '<div class="vpv-cache-name"></div>' +
                  '<div class="vpv-cache-meta">' +
                    '<span class="vpv-cache-size">--</span><span class="vpv-cache-dur">--:--</span>' +
                  '</div>' +
                  '<div class="vpv-cache-track"><div class="vpv-cache-bar"></div></div>' +
                  '<div class="vpv-cache-state">检测中…</div>' +
                  '<button class="vpv-cache-save"><i class="bi bi-download"></i><span>保存视频</span></button>' +
                  '<div class="vpv-cache-note">保存时优先复用浏览器已缓存的数据，不重复下载</div>' +
                '</div>' +
              '</div>' +
              '<div class="vpv-speed">' +
                '<button class="vpv-btn vpv-speed-btn" title="倍速播放"><span class="vpv-speed-cur">1.0x</span></button>' +
                '<div class="vpv-speed-menu">' +
                  '<button class="vpv-speed-item" data-rate="0.5">0.5x</button>' +
                  '<button class="vpv-speed-item" data-rate="0.75">0.75x</button>' +
                  '<button class="vpv-speed-item active" data-rate="1">1.0x</button>' +
                  '<button class="vpv-speed-item" data-rate="1.25">1.25x</button>' +
                  '<button class="vpv-speed-item" data-rate="1.5">1.5x</button>' +
                  '<button class="vpv-speed-item" data-rate="2">2.0x</button>' +
                '</div>' +
              '</div>' +
              '<button class="vpv-btn vpv-mode" title="播放模式：顺序播放"><i class="bi bi-list-ol"></i></button>' +
              '<button class="vpv-btn vpv-rotate" title="旋转画面 90°"><i class="bi bi-arrow-clockwise"></i></button>' +
              '<button class="vpv-btn vpv-pip" title="画中画"><svg class="vpv-svg" viewBox="0 0 16 16" fill="currentColor" width="1em" height="1em" aria-hidden="true"><path d="M1.5 2A1.5 1.5 0 0 0 0 3.5v9A1.5 1.5 0 0 0 1.5 14h13a1.5 1.5 0 0 0 1.5-1.5v-9A1.5 1.5 0 0 0 14.5 2h-13zM1 3.5a.5.5 0 0 1 .5-.5h13a.5.5 0 0 1 .5.5v9a.5.5 0 0 1-.5.5h-13a.5.5 0 0 1-.5-.5v-9z"/><path d="M7.5 6a.5.5 0 0 0-.5.5v3a.5.5 0 0 0 .5.5h5a.5.5 0 0 0 .5-.5v-3a.5.5 0 0 0-.5-.5h-5z"/></svg></button>' +
              '<button class="vpv-btn vpv-fillpage" title="充满页面（网页全屏）"><i class="bi bi-arrows-angle-expand"></i></button>' +
              '<button class="vpv-btn vpv-full" title="全屏 (F)"><i class="bi bi-fullscreen"></i></button>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="vpv-side">' +
          '<div class="vpv-pl-head"><i class="bi bi-collection-play"></i> 播放列表 <span class="vpv-pl-count">…</span></div>' +
          '<div class="vpv-pl-list"><div class="vpv-pl-empty"><i class="bi bi-hourglass-split"></i> 正在加载列表…</div></div>' +
        '</div>' +
      '</div>';

    const wrap = host.querySelector(".vpv-wrap");
    wrap.classList.toggle("vpv-light", vpvThemeIsLight());   // 白天 / 黑夜 / 跟随编辑器
    const stage = host.querySelector(".vpv-stage");
    const video = host.querySelector("video");
    const poster = host.querySelector(".vpv-poster");
    const infoEl = host.querySelector(".vpv-info");
    const titleEl = host.querySelector(".vpv-title");
    titleEl.textContent = name;   // 顶部居中显示视频标题
    const seekTip = host.querySelector(".vpv-seek-tip");
    const sideToggle = host.querySelector(".vpv-side-toggle");
    // 播放列表收起状态持久化：上次收起过，本次打开直接保持收起
    if (_vpvStore.plFold) {
      wrap.classList.add("no-side");
      sideToggle.querySelector("i").className = "bi bi-chevron-left";
      sideToggle.title = "展开播放列表";
    }

    /* ---------- 标题显示 / 隐藏（眼睛按钮，状态持久化） ---------- */
    const titleBtn = host.querySelector(".vpv-title-toggle");
    const applyTitleVis = hidden => {
      wrap.classList.toggle("title-hidden", hidden);
      titleBtn.querySelector("i").className = hidden ? "bi bi-eye-slash" : "bi bi-eye";
      titleBtn.title = hidden ? "显示标题" : "隐藏标题";
    };
    titleBtn.addEventListener("click", e => {
      e.stopPropagation();
      const hidden = !wrap.classList.contains("title-hidden");
      applyTitleVis(hidden);
      _vpvStore.titleHidden = hidden; _vpvSave();   // 记住偏好，下次打开沿用
    });
    if (_vpvStore.titleHidden) applyTitleVis(true);
    const $ = sel => host.querySelector(sel);

    /* ---------- 提示气泡（倍速/模式/旋转等操作反馈，1.6s 后淡出） ---------- */
    let tipTimer = null;
    const showTip = (text, icon) => {
      seekTip.innerHTML = icon ? '<i class="bi ' + icon + '"></i> ' + _vpvEsc(text) : _vpvEsc(text);
      seekTip.classList.add("show");
      clearTimeout(tipTimer);
      tipTimer = setTimeout(() => seekTip.classList.remove("show"), 1600);
    };

    /* ---------- 海报封面层：首帧渲染后隐藏，缓冲卡顿（未播过）时重新浮现 ---------- */
    video.addEventListener("canplay", () => poster.classList.add("hide"));
    video.addEventListener("loadeddata", () => poster.classList.add("hide"));   // 默认暂停时也隐去海报，露出静止首帧
    video.addEventListener("playing", () => { poster.dataset.played = "1"; poster.classList.add("hide"); });
    video.addEventListener("waiting", () => { if (!poster.dataset.played) poster.classList.remove("hide"); });
    /* ---------- 编码兜底：HEVC/10bit 等浏览器解不了的视频轨（症状：黑屏有声有时长）
       → 自动切到服务端实时转码源 /api/stream_transcode（ffmpeg 转 H.264/AAC） ---------- */
    let transMode = false;   // 当前源是否为转码兜底源
    let transStart = 0;      // 转码源 -ss 起播偏移（currentTime 从 0 计，显示时需加回）
    let transDur = 0;        // 转码源实际总时长（fMP4 流无总时长，从时长接口获取）
    let transToken = 0;      // 转码会话序号（预留，配合快速连续切换防串流）
    const transUrl = (abs, ss) => "/api/stream_transcode?path=" + encodeURIComponent(abs) + "&ss=" + encodeURIComponent(String(ss || 0));
    const startTranscode = (abs, ss, autoplay) => {
      if (!canTranscode) return;          // 远程 / 外部来源没有本地转码接口
      const first = !transMode;
      transToken++;
      transMode = true;
      transStart = +ss || 0;
      video.dataset.trans = "1";
      video.src = transUrl(abs, ss);
      if (autoplay) video.play().catch(() => {});   // 仅当原本处于播放态时才续播；默认暂停打开则保持暂停
      if (!transDur && urlDuration) {       // 拉取真实总时长，供进度显示与拖拽换算
        fetch(urlDuration(abs))
          .then(r => r.json()).then(d => { if (d && d.duration) { transDur = d.duration; updateProgress(); } })
          .catch(() => {});
      }
      if (first) showTip("该视频编码浏览器不支持，已切换服务器转码播放", "bi-cpu");
    };
    // 检测：开始出数据后画面宽度仍为 0（只有音轨被解码）→ 走转码兜底
    const tryTransFallback = () => {
      if (!canTranscode) return;
      if (transMode || video.videoWidth !== 0 || video.readyState < 2) return;
      startTranscode(curPath, 0, !video.paused);
    };
    video.addEventListener("loadeddata", tryTransFallback);
    video.addEventListener("playing", tryTransFallback);
    video.addEventListener("error", () => {
      poster.classList.add("hide");
      // 直连源解码失败（不支持编码 / 容器异常）也先试一次转码；转码源再错才报错
      if (!canTranscode) { showTip("视频加载失败（编码不支持或文件不可读）", "bi-exclamation-circle"); return; }
      if (!transMode) startTranscode(curPath, video.currentTime || 0, !video.paused);
      else showTip("视频加载失败，请确认文件可读", "bi-exclamation-circle");
    });
    // 打开即默认暂停（不自动播放）：由用户点击播放键 / 空格 / 点画面后再开始

    /* ---------- 播放/暂停：按钮 + 点画面；双击全屏 ---------- */
    const playBtn = $(".vpv-play");
    const centerBtn = $(".vpv-center-btn"), centerIcon = centerBtn.querySelector("i");
    const setPlayIcon = () => {
      const paused = video.paused;
      const icon = paused ? "bi-play-fill" : "bi-pause-fill";
      playBtn.innerHTML = '<i class="bi ' + icon + '"></i>';
      centerIcon.className = "bi " + icon;            // 画面中央大按钮随播放状态切换
      stage.classList.toggle("paused", paused);
      centerBtn.title = paused ? "播放 (空格)" : "暂停 (空格)";
    };
    const togglePlay = () => { if (video.paused) video.play().catch(() => {}); else video.pause(); };
    playBtn.addEventListener("click", togglePlay);
    centerBtn.addEventListener("click", togglePlay);   // 与点画面同效；冒泡到 document 顺便关掉倍速菜单
    video.addEventListener("click", togglePlay);
    video.addEventListener("dblclick", () => $(".vpv-full").click());
    video.addEventListener("play", setPlayIcon);
    video.addEventListener("pause", setPlayIcon);
    // 与 48_ 音频播放器互斥：视频开始播放时暂停正在试听的音频，避免两处同时出声
    video.addEventListener("play", () => {
      document.querySelectorAll(".apv-wrap audio").forEach(a => { try { a.pause(); } catch (_) {} });
    });
    setPlayIcon();

    /* ---------- 进度条 + 时间 + 缓冲 ---------- */
    const timeCur = $(".vpv-time-cur"), timeDur = $(".vpv-time-dur"), progress = $(".vpv-progress");
    const played = $(".vpv-played"), buffered = $(".vpv-buffered"), knob = $(".vpv-knob");
    const updateProgress = () => {
      // 转码模式：fMP4 流 duration 为 Infinity，用真实总时长 + ss 偏移换算显示
      const dur = transMode ? transDur : (video.duration || 0);
      const cur = transMode ? (transStart + video.currentTime) : video.currentTime;
      const pct = dur ? cur / dur * 100 : 0;
      played.style.width = pct + "%";
      knob.style.left = pct + "%";
      timeCur.textContent = _vpvFmt(cur);
      timeDur.textContent = "-" + _vpvFmt(Math.max(0, dur - cur));   // 右侧显示倒计时：还剩多少没播
      if (video.buffered.length && dur) {
        const end = video.buffered.end(video.buffered.length - 1) + (transMode ? transStart : 0);
        buffered.style.width = Math.min(100, end / dur * 100) + "%";
      }
    };
    video.addEventListener("timeupdate", updateProgress);
    video.addEventListener("progress", updateProgress);
    video.addEventListener("loadedmetadata", updateProgress);

    let dragging = false;
    const seekTo = clientX => {
      const dur = transMode ? transDur : video.duration;
      if (!isFinite(dur) || !dur) return;
      const rect = progress.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      const target = ratio * dur;
      if (transMode) {   // 转码流不支持 Range 定位：用 -ss 重启转码流到目标位置
        startTranscode(curPath, target, !video.paused);
        updateProgress();
        return;
      }
      video.currentTime = target;
      updateProgress();
    };
    progress.addEventListener("pointerdown", e => {
      dragging = true;
      progress.classList.add("dragging");
      try { progress.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      seekTo(e.clientX);
    });
    progress.addEventListener("pointermove", e => { if (dragging) seekTo(e.clientX); });
    progress.addEventListener("pointerup", () => { dragging = false; progress.classList.remove("dragging"); });
    progress.addEventListener("pointercancel", () => { dragging = false; progress.classList.remove("dragging"); });

    /* ---------- 音量（音量 / 静音状态持久化，下次打开沿用） ---------- */
    const muteBtn = $(".vpv-mute"), volRange = $(".vpv-vol-range");
    const volIcon = () => {
      const v = video.muted ? 0 : video.volume;
      muteBtn.innerHTML = '<i class="bi ' + (v === 0 ? "bi-volume-mute-fill" : v < 0.5 ? "bi-volume-down-fill" : "bi-volume-up-fill") + '"></i>';
    };
    const syncVolUi = () => {
      const v = video.muted ? 0 : video.volume;
      volRange.value = v;
      volRange.style.setProperty("--vol", (v * 100) + "%");
      volIcon();
    };
    const applyVol = () => {
      video.volume = +volRange.value;
      video.muted = false;                      // 主动拖动音量条视为解除静音
      _vpvStore.volume = video.volume;
      _vpvStore.muted = false;
      _vpvSave();
      syncVolUi();
    };
    volRange.addEventListener("input", applyVol);
    muteBtn.addEventListener("click", () => { video.muted = !video.muted; });
    video.addEventListener("volumechange", () => {
      _vpvStore.volume = video.volume;          // 静音键 / 快捷键 M 也走这里持久化
      _vpvStore.muted = video.muted;
      _vpvSave();
      syncVolUi();
    });
    // 恢复上次的音量与静音状态（不经过 applyVol，避免把静音强制解除）
    video.volume = Math.min(1, Math.max(0, +_vpvStore.volume || 1));
    video.muted = !!_vpvStore.muted;
    syncVolUi();

    /* ---------- 倍速菜单 ---------- */
    const speedWrap = $(".vpv-speed"), speedCur = $(".vpv-speed-cur");
    $(".vpv-speed-btn").addEventListener("click", e => {
      e.stopPropagation();
      host.querySelectorAll(".vpv-netspeed-wrap.open").forEach(el => el.classList.remove("open"));   // 与缓存面板互斥
      speedWrap.classList.toggle("open");
    });
    host.querySelectorAll(".vpv-speed-item").forEach(el => {
      el.addEventListener("click", e => {
        e.stopPropagation();
        video.playbackRate = +el.dataset.rate;
        _vpvStore.rate = +el.dataset.rate; _vpvSave();   // 倍速持久化
        speedCur.textContent = el.textContent;
        host.querySelectorAll(".vpv-speed-item").forEach(x => x.classList.toggle("active", x === el));
        speedWrap.classList.remove("open");
        showTip("倍速 " + el.textContent, "bi-speedometer2");
      });
    });
    // 恢复上次的倍速状态
    const _initRate = Math.min(4, Math.max(0.25, +_vpvStore.rate || 1));
    video.playbackRate = _initRate;
    const _rateItem = host.querySelector('.vpv-speed-item[data-rate="' + _initRate + '"]');
    if (_rateItem) {
      speedCur.textContent = _rateItem.textContent;
      host.querySelectorAll(".vpv-speed-item").forEach(x => x.classList.toggle("active", x === _rateItem));
    } else {
      speedCur.textContent = _initRate + "x";
    }
    const closeSpeedMenu = () => {
      if (!host.isConnected) return;
      host.querySelectorAll(".vpv-speed.open").forEach(el => el.classList.remove("open"));
      host.querySelectorAll(".vpv-netspeed-wrap.open").forEach(el => el.classList.remove("open"));
    };
    document.addEventListener("click", closeSpeedMenu);
    _vpvCleanups.push(() => document.removeEventListener("click", closeSpeedMenu));

    /* ---------- 实时加载速度（控制条右侧） ----------
       浏览器不暴露 <video> 流的实时字节数，这里用「缓冲时长增量 × 平均码率」反推：
       平均码率 = 文件字节数 / 总时长（字节数取 /api/files 的 size，拿不到就显示 --）。
       每 500ms 采样一次 buffered 末端，指数平滑后显示，避免数字乱跳。
       缓冲已顶到片尾且余量充足时改显示「已缓存」（整段已下载完，速度没有意义）。 */
    const netBox = $(".vpv-netspeed"), netIcon = netBox.querySelector("i"), netVal = netBox.querySelector(".vpv-netspeed-val");
    let netBytes = 0;                 // 当前文件字节数（0 = 未知）
    let netLastEnd = -1, netLastAt = 0, netEma = 0, netIdle = 0, netState = "";
    const netFmt = bps => {
      if (!isFinite(bps) || bps < 512) return "0 KB/s";
      const units = ["KB/s", "MB/s", "GB/s"];
      let v = bps / 1024, i = 0;
      while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
      return (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)) + " " + units[i];
    };
    const netShow = (text, state, icon) => {
      netVal.textContent = text;
      if (state !== netState) {
        netState = state;
        netBox.classList.toggle("cached", state === "cached");
        netBox.classList.toggle("idle", state === "idle");
        netIcon.className = "bi " + (icon || (state === "cached" ? "bi-check-circle" : "bi-arrow-down-circle"));
      }
    };
    const netReset = () => {
      netLastEnd = -1; netLastAt = 0; netEma = 0; netIdle = 0; netState = "";
      netShow("--", "unknown");
    };
    const netTick = () => {
      if (!host.isConnected) return;
      const dur = transMode ? transDur : (video.duration || 0);
      let end = 0;
      try { if (video.buffered.length) end = video.buffered.end(video.buffered.length - 1); } catch (_) { }
      const now = performance.now();
      const bytesPerSec = (netBytes > 0 && dur > 0) ? netBytes / dur : 0;
      // 转码源是 ffmpeg 实时生成的分片流，码率与原文件无关，估算会失真 → 不显示
      if (transMode) { netShow("--", "unknown"); netLastEnd = end; netLastAt = now; return; }
      if (!(dur > 0) || end <= 0 || !bytesPerSec) {        // 时长或文件大小未知：无从估算
        netShow("--", "unknown"); netLastEnd = end; netLastAt = now; return;
      }
      // 缓冲顶到片尾 → 整段已缓存，速度没意义
      if (end >= dur - 0.3) {
        netEma = 0; netShow("已缓存", "cached"); netLastEnd = end; netLastAt = now; return;
      }
      if (netLastEnd >= 0 && netLastAt && now - netLastAt > 60) {
        const dEnd = Math.max(0, end - netLastEnd);         // 这段时间新下载的内容时长
        const inst = dEnd * bytesPerSec / ((now - netLastAt) / 1000);
        if (inst > 0) {
          netEma = netEma > 0 ? netEma * 0.6 + inst * 0.4 : inst;
          netIdle = 0;
        } else {
          netEma *= 0.5;                                    // 没有新数据：快速回落
          if (++netIdle >= 3) netEma = 0;                   // 连续约 1.5s 停住 → 归零
        }
        netShow(netEma > 0 ? netFmt(netEma) : "0 KB/s", netEma > 0 ? "speed" : "idle");
      }
      netLastEnd = end; netLastAt = now;
    };
    const netTimer = setInterval(netTick, 500);
    _vpvCleanups.push(() => clearInterval(netTimer));
    // 列表加载前先用调用方给的 fileSize（可选），本地文件随后由 /api/files 的 size 覆盖
    if (_o.fileSize > 0) netBytes = +_o.fileSize;

    /* ---------- 播放模式：顺序 → 循环 → 随机 ---------- */
    const MODES = [
      { key: "order",   label: "顺序播放", icon: "bi-list-ol" },
      { key: "loop",    label: "循环播放", icon: "bi-arrow-repeat" },
      { key: "shuffle", label: "随机播放", icon: "bi-shuffle" },
    ];
    const modeBtn = $(".vpv-mode");
    let modeIdx = Math.max(0, MODES.findIndex(m => m.key === (_vpvStore.mode || _vpvPlayMode)));
    const applyMode = announce => {
      const m = MODES[modeIdx];
      _vpvPlayMode = m.key;
      _vpvStore.mode = m.key; _vpvSave();            // 播放模式持久化
      modeBtn.innerHTML = '<i class="bi ' + m.icon + '"></i>';
      modeBtn.title = "播放模式：" + m.label;
      modeBtn.classList.toggle("active", m.key !== "order");
      video.loop = m.key === "loop";   // 循环交给原生 loop，播完不触发 ended
      if (announce) showTip(m.label, m.icon);
    };
    modeBtn.addEventListener("click", () => { modeIdx = (modeIdx + 1) % MODES.length; applyMode(true); });
    applyMode(false);

    /* ---------- 旋转画面：横竖互换时自动缩放适配 ---------- */
    const rotateBtn = $(".vpv-rotate");
    let rotDeg = 0;
    const applyRotate = () => {
      const deg = ((rotDeg % 360) + 360) % 360;
      let scale = 1;
      if (deg === 90 || deg === 270) {
        const r = stage.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) scale = Math.min(1, r.height / r.width);
      }
      video.style.transform = deg ? "rotate(" + deg + "deg) scale(" + scale + ")" : "";
    };
    rotateBtn.addEventListener("click", () => {
      rotDeg += 90;
      applyRotate();
      showTip("已旋转 " + (((rotDeg % 360) + 360) % 360) + "°", "bi-arrow-clockwise");
    });
    const onWinResize = () => applyRotate();
    window.addEventListener("resize", onWinResize);
    document.addEventListener("fullscreenchange", applyRotate);
    _vpvCleanups.push(() => { window.removeEventListener("resize", onWinResize); document.removeEventListener("fullscreenchange", applyRotate); });

    /* ---------- 画中画 / 全屏 ---------- */
    $(".vpv-pip").addEventListener("click", async () => {
      if (!document.pictureInPictureEnabled) { showTip("当前浏览器不支持画中画", "bi-display"); return; }
      try {
        if (document.pictureInPictureElement) await document.exitPictureInPicture();
        else await video.requestPictureInPicture();
      } catch (err) { showTip("画中画暂不可用", "bi-exclamation-circle"); }
    });
    const fullBtn = $(".vpv-full");
    fullBtn.addEventListener("click", () => {
      if (document.fullscreenElement) document.exitFullscreen();
      else if (stage.requestFullscreen) stage.requestFullscreen();
      else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen();
    });

    /* ---------- 充满页面（网页全屏）：播放器铺满整个浏览器视口，再点一次还原 ----------
       只改变播放器自身定位（position:fixed），不进入浏览器全屏 API，
       所以 IDE 的其它面板、系统任务栏依然可用；Esc 也能退出。 */
    const fillBtn = $(".vpv-fillpage");
    let pageFilled = false;
    const applyFillPage = on => {
      pageFilled = !!on;
      wrap.classList.toggle("vpv-fillpage", pageFilled);
      fillBtn.classList.toggle("active", pageFilled);
      fillBtn.innerHTML = '<i class="bi ' + (pageFilled ? "bi-arrows-angle-contract" : "bi-arrows-angle-expand") + '"></i>';
      fillBtn.title = pageFilled ? "还原窗口" : "充满页面（网页全屏）";
      document.documentElement.classList.toggle("vpv-fillpage-lock", pageFilled);   // 锁住整页滚动
      applyRotate();                                                               // 舞台尺寸变了，重算旋转缩放
    };
    fillBtn.addEventListener("click", () => applyFillPage(!pageFilled));
    const onFillEsc = e => { if (pageFilled && e.key === "Escape") applyFillPage(false); };
    document.addEventListener("keydown", onFillEsc);
    _vpvCleanups.push(() => {
      document.removeEventListener("keydown", onFillEsc);
      document.documentElement.classList.remove("vpv-fillpage-lock");   // 换视频/关标签时不能把页面锁死
    });

    /* ---------- 控制条自动隐藏：播放中鼠标静止 2.5s 淡出 ---------- */
    let idleTimer = null;
    const wake = () => {
      stage.classList.remove("idle");
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        // 倍速菜单 / 缓存面板打开时不能隐藏控制条，否则面板会跟着消失
        if (!video.paused && !speedWrap.classList.contains("open") && !netWrap.classList.contains("open")) {
          stage.classList.add("idle");
        }
      }, 2500);
    };
    stage.addEventListener("mousemove", wake);
    stage.addEventListener("mouseleave", () => {
      // 缓存面板 / 倍速菜单开着时移出鼠标也不隐藏，否则用户点「保存」前面板就没了
      if (!video.paused && !speedWrap.classList.contains("open") && !netWrap.classList.contains("open")) {
        stage.classList.add("idle");
      }
    });
    video.addEventListener("pause", () => stage.classList.remove("idle"));
    wake();

    /* ---------- 键盘：空格 / M / F / ←→（仅当前标签可见时接管） ---------- */
    const actHost = _o.activeHost || host;   // 远程播放器挂在 .rfv-cm 里，active 类在标签根节点上
    const keyHandler = e => {
      if (!host.isConnected || !actHost.classList.contains("active")) return;
      const tag = (e.target && e.target.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select" || (e.target && e.target.isContentEditable)) return;
      const k = (e.key || "").toLowerCase();
      if (e.key === " ") {
        e.preventDefault(); e.stopPropagation(); togglePlay();
      } else if (k === "m") {
        e.preventDefault(); e.stopPropagation(); video.muted = !video.muted;
      } else if (k === "f") {
        e.preventDefault(); e.stopPropagation(); fullBtn.click();
      } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault(); e.stopPropagation();
        if (transMode) {   // 转码模式：±5s 同样走 -ss 重启定位
          const target = Math.max(0, Math.min(transDur || 0, transStart + video.currentTime + (e.key === "ArrowRight" ? 5 : -5)));
          startTranscode(curPath, target, !video.paused);
        } else {
          video.currentTime = Math.max(0, Math.min(video.duration || 0, video.currentTime + (e.key === "ArrowRight" ? 5 : -5)));
        }
        showTip((e.key === "ArrowRight" ? "快进 " : "快退 ") + "5s", e.key === "ArrowRight" ? "bi-skip-forward-fill" : "bi-skip-backward-fill");
      }
    };
    document.addEventListener("keydown", keyHandler, true);
    _vpvCleanups.push(() => document.removeEventListener("keydown", keyHandler, true));

    /* ---------- 播放列表：同目录视频，点击原位切换；播完按模式续播 ---------- */
    const plList = $(".vpv-pl-list"), plCount = $(".vpv-pl-count");
    let plItems = [];           // [{abs, name, size_str}]
    let curPath = path;

    const durCacheKey = abs => { return _vpvDurCache[abs]; };
    const fetchDuration = (abs, el) => {
      if (!urlDuration) return;                 // 远程文件查不到时长，保留 --:--
      const cached = durCacheKey(abs);
      if (cached != null) { el.textContent = _vpvFmt(cached); return; }
      fetch(urlDuration(abs))
        .then(r => r.json())
        .then(d => {
          if (!d || d.duration == null || !el.isConnected) return;
          _vpvDurCache[abs] = d.duration;
          el.textContent = _vpvFmt(d.duration);
        })
        .catch(() => {});
    };

    const renderPlaylist = () => {
      if (!plItems.length) {
        plCount.textContent = "";
        plList.innerHTML = '<div class="vpv-pl-empty"><i class="bi bi-folder2-open"></i> 同目录下没有其他视频</div>';
        return;
      }
      plCount.textContent = plItems.length;
      plList.innerHTML = plItems.map((it, i) => {
        const tSrc = urlThumb ? urlThumb(it.abs) : "";   // 取不到缩略图（如远程无封面）就只留图标
        return '<div class="vpv-pl-row' + (it.abs === curPath ? " cur" : "") + '" data-i="' + i + '">' +
          '<span class="vpv-pl-thumb">🎬' + (tSrc ? '<img loading="lazy" alt="" src="' + _vpvEsc(tSrc) + '" onerror="this.remove()">' : '') + '</span>' +
          '<span class="vpv-pl-name" title="' + _vpvEsc(it.name) + '">' + _vpvEsc(it.name) + '</span>' +
          '<span class="vpv-pl-dur" data-dur="' + i + '">' +
            (urlDuration ? "--:--" : _vpvEsc(it.size_str || "")) + '</span>' +
        '</div>';
      }).join("");
      plList.querySelectorAll(".vpv-pl-row").forEach(row => {
        const it = plItems[+row.dataset.i];
        if (urlDuration) fetchDuration(it.abs, row.querySelector(".vpv-pl-dur"));
        row.addEventListener("click", () => playPath(it.abs, true));
      });
      const cur = plList.querySelector(".vpv-pl-row.cur");
      if (cur) try { cur.scrollIntoView({ block: "nearest" }); } catch (e) {}
    };

    // 原位切换：不重建播放模块，只换源 + 同步封面 / 高亮 / 文件名
    let switchToken = 0;
    const playPath = (abs, autoplay) => {
      if (!abs || abs === curPath) return;
      curPath = abs;
      if (++switchToken === 0) switchToken = 1;   // 避免 0 作 token
      const token = switchToken;
      video.pause();
      const nextPoster = urlPoster(abs);
      poster.style.backgroundImage = nextPoster ? "url('" + nextPoster + "')" : "none";
      const nameEl = poster.querySelector(".vpv-name");
      if (nameEl) nameEl.textContent = abs.split("/").pop() || "";
      if (titleEl) titleEl.textContent = abs.split("/").pop() || "";   // 标题同步切换
      poster.classList.remove("hide");
      delete poster.dataset.played;
      rotDeg = 0; applyRotate();
      transMode = false; transStart = 0; transDur = 0; delete video.dataset.trans;   // 新文件重新走直连 → 兜底检测
      const nextItem = plItems.find(x => x.abs === abs);                             // 换文件同步实时速度的码率基准
      netBytes = nextItem && +nextItem.size > 0 ? +nextItem.size : 0;
      netReset();
      video.src = urlStream(abs);
      video.addEventListener("loadedmetadata", function onMeta() {
        video.removeEventListener("loadedmetadata", onMeta);
        if (token !== switchToken) return;
        if (autoplay) video.play().catch(() => {});
      });
      plList.querySelectorAll(".vpv-pl-row").forEach(row => {
        row.classList.toggle("cur", plItems[+row.dataset.i] && plItems[+row.dataset.i].abs === abs);
      });
      const cur = plList.querySelector(".vpv-pl-row.cur");
      if (cur) try { cur.scrollIntoView({ block: "nearest" }); } catch (e) {}
      // 换源完成后同步标签页（标题/图标/面包屑）；放最后且捕获异常，同步出错也绝不能影响切换播放
      try {
        const nm = abs.split("/").pop() || "";
        if (typeof _o.onSwitch === "function") _o.onSwitch(abs, nm);
        else if (typeof window.IDE_SYNC_VIDEO_TAB === "function") window.IDE_SYNC_VIDEO_TAB(tab, abs, nm);
      } catch (e) {}
    };

    video.addEventListener("ended", () => {
      if (_vpvPlayMode !== "shuffle") return;   // order 顺序交给浏览器自然停下（列表内手动切换）；loop 是原生循环
      const others = plItems.filter(it => it.abs !== curPath);
      const next = others.length ? others[Math.floor(Math.random() * others.length)] : plItems[0];
      if (next) playPath(next.abs, true);
    });

    // 顺序模式下播完自动切下一个（有列表时）
    video.addEventListener("ended", () => {
      if (_vpvPlayMode !== "order") return;
      const idx = plItems.findIndex(it => it.abs === curPath);
      if (idx >= 0 && idx < plItems.length - 1) playPath(plItems[idx + 1].abs, true);
    });

    // 拉取同目录视频列表 + 当前文件大小（远程由调用方提供 listVideos）
    const listPromise = (typeof _o.listVideos === "function")
      ? Promise.resolve(_o.listVideos(dir))
      : fetch("/api/files?path=" + encodeURIComponent(dir))
          .then(r => r.json())
          .then(d => {
            if (d.error) throw new Error(d.error);
            return (d.items || [])
              .filter(it => !it.is_dir && IDE_VIDEO_EXTS.indexOf((it.name || "").split(".").pop().toLowerCase()) >= 0)
              .map(it => ({ abs: dir.replace(/\/+$/, "") + "/" + it.name, name: it.name, size_str: it.size_str || "", size: it.size || 0 }));
          });
    listPromise
      .then(items => {
        if (!host.isConnected) return;
        plItems = items || [];
        renderPlaylist();
        const cur = plItems.find(it => it.abs === path);
        if (cur && cur.size_str) { infoEl.textContent = cur.size_str; infoEl.style.display = ""; }
        if (cur && +cur.size > 0 && +cur.size !== netBytes) {   // 拿到文件大小后才有码率基准
          netBytes = +cur.size; netReset();
        }
      })
      .catch(() => { if (host.isConnected) plList.innerHTML = '<div class="vpv-pl-empty"><i class="bi bi-wifi-off"></i> 列表加载失败</div>'; });

    /* ---------- 播放列表面板收起 / 展开 ---------- */
    sideToggle.addEventListener("click", e => {
      e.stopPropagation();
      const folded = wrap.classList.toggle("no-side");
      sideToggle.querySelector("i").className = folded ? "bi bi-chevron-left" : "bi bi-chevron-right";
      sideToggle.title = folded ? "展开播放列表" : "收起播放列表";
      _vpvStore.plFold = folded; _vpvSave();   // 记住收起状态，下次打开沿用
    });

    /* ---------- 缓存面板：点「已缓存 / 速度」胶囊弹出，直接把当前视频保存到本地 ----------
       面板里显示文件名、大小、时长与缓冲进度；「保存视频」优先用 cache:"force-cache"
       复用浏览器已经下载过的媒体分片（/api/stream 带 Cache-Control），命中就不再走网络；
       未命中则按流读取并实时显示进度，最后用 Blob 触发浏览器下载。
       超大文件（>800MB）不塞进内存，直接交给浏览器原生下载。 */
    const netWrap = $(".vpv-netspeed-wrap");
    const cachePop = $(".vpv-cache-pop");
    const cacheName = $(".vpv-cache-name"), cacheSize = $(".vpv-cache-size"), cacheDur = $(".vpv-cache-dur");
    const cacheBar = $(".vpv-cache-bar"), cacheState = $(".vpv-cache-state");
    const cacheSave = $(".vpv-cache-save"), cacheNote = $(".vpv-cache-note");
    let saving = false, cacheTimer = null;

    const vpvSize = n => {
      if (!(n > 0)) return "--";
      const units = ["B", "KB", "MB", "GB", "TB"];
      let v = n, i = 0;
      while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
      return (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)) + " " + units[i];
    };
    const bufferedEnd = () => {
      let end = 0;
      try { if (video.buffered.length) end = video.buffered.end(video.buffered.length - 1); } catch (_) { }
      return end;
    };
    const downloadBlob = (blob, fname) => {
      const href = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = href; a.download = fname; a.style.display = "none";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(href), 60000);
    };
    const refreshCachePop = () => {
      if (saving) return;                       // 保存进度不被定时刷新覆盖
      const dur = transMode ? transDur : (video.duration || 0);
      const pct = dur > 0 ? Math.min(100, bufferedEnd() / dur * 100) : 0;
      cacheName.textContent = curPath.split("/").pop() || "";
      cacheName.title = curPath;
      cacheSize.textContent = netBytes > 0 ? vpvSize(netBytes) : "--";
      cacheDur.textContent = dur > 0 ? _vpvFmt(dur) : "--:--";
      cacheBar.style.width = pct + "%";
      if (transMode) {
        cacheState.textContent = "服务器转码播放，无法保存原文件";
        cacheNote.textContent = "转码流由 ffmpeg 实时生成，请对源文件本身另存";
        cacheSave.disabled = true;
        return;
      }
      cacheState.textContent = pct >= 99.5 ? "已完整缓存 · 可直接保存" : "已缓存 " + pct.toFixed(0) + "%";
      cacheNote.textContent = "保存时优先复用浏览器已缓存的数据，不重复下载";
      cacheSave.disabled = false;
    };

    const saveCurrentVideo = async () => {
      if (saving) return;
      const abs = curPath;
      const fname = abs.split("/").pop() || "video.mp4";
      const btnText = cacheSave.querySelector("span");
      saving = true;
      cacheSave.disabled = true;
      btnText.textContent = "读取中…";
      cacheBar.style.width = "0%";
      cacheState.textContent = "正在准备…";
      try {
        // 超大文件不读进内存：直接交给浏览器下载（流式写盘）
        if (netBytes > 800 * 1024 * 1024) {
          const a = document.createElement("a");
          a.href = urlStream(abs); a.download = fname; a.style.display = "none";
          document.body.appendChild(a); a.click(); a.remove();
          cacheBar.style.width = "100%";
          cacheState.textContent = "文件较大，已交给浏览器下载";
          return;
        }
        const resp = await fetch(urlStream(abs), { cache: "force-cache" });   // 已缓存分片优先命中
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        const total = +(resp.headers.get("Content-Length") || 0) || netBytes || 0;
        const type = resp.headers.get("Content-Type") || "video/mp4";
        if (!resp.body || typeof resp.body.getReader !== "function") {
          const blob = await resp.blob();
          downloadBlob(blob, fname);
          cacheBar.style.width = "100%";
          cacheState.textContent = "已保存 · " + vpvSize(blob.size);
          return;
        }
        const reader = resp.body.getReader();
        const chunks = [];
        let got = 0, lastPaint = 0;
        for (; ;) {
          const r = await reader.read();
          if (r.done) break;
          chunks.push(r.value);
          got += r.value.length;
          const now = performance.now();
          if (now - lastPaint > 100) {
            lastPaint = now;
            const pct = total ? Math.min(100, got / total * 100) : 0;
            if (pct) cacheBar.style.width = pct + "%";
            cacheState.textContent = "保存中 " + (pct ? pct.toFixed(0) + "%" : "") +
              (total ? " · " + vpvSize(got) + " / " + vpvSize(total) : " · " + vpvSize(got));
          }
        }
        const blob = new Blob(chunks, { type });
        downloadBlob(blob, fname);
        cacheBar.style.width = "100%";
        cacheState.textContent = "已保存 · " + vpvSize(blob.size);
      } catch (e) {
        cacheState.textContent = "保存失败：" + ((e && e.message) || "网络错误");
        cacheSave.disabled = false;
        btnText.textContent = "重试保存";
        saving = false;
        return;
      }
      saving = false;
      cacheSave.disabled = false;
      btnText.textContent = "保存视频";
    };

    netBox.addEventListener("click", e => {
      e.stopPropagation();
      host.querySelectorAll(".vpv-speed.open").forEach(el => el.classList.remove("open"));   // 与倍速菜单互斥
      const open = netWrap.classList.toggle("open");
      if (open) {
        refreshCachePop();
        clearInterval(cacheTimer);
        cacheTimer = setInterval(refreshCachePop, 600);   // 面板开着时实时刷新缓冲进度
      } else {
        clearInterval(cacheTimer); cacheTimer = null;
      }
    });
    cachePop.addEventListener("click", e => e.stopPropagation());   // 面板内操作不触发关闭
    cacheSave.addEventListener("click", saveCurrentVideo);
    _vpvCleanups.push(() => clearInterval(cacheTimer));
    // 点面板外任意处关闭：document 上的 click 会先清掉 .open，这里顺手停刷新
    const onDocClickStopCache = () => { clearInterval(cacheTimer); cacheTimer = null; };
    document.addEventListener("click", onDocClickStopCache);
    _vpvCleanups.push(() => document.removeEventListener("click", onDocClickStopCache));

    /* ---------- 标签被关闭（host 脱离文档）时解除全局监听并停播 ---------- */
    const cleanup = () => {
      document.removeEventListener("keydown", keyHandler, true);
      document.removeEventListener("click", closeSpeedMenu);
      document.removeEventListener("fullscreenchange", applyRotate);
      window.removeEventListener("resize", onWinResize);
      clearTimeout(idleTimer); clearTimeout(tipTimer); clearInterval(netTimer); clearInterval(cacheTimer);
      document.documentElement.classList.remove("vpv-fillpage-lock");   // 关标签时解除页面滚动锁
      try { video.pause(); } catch (e) {}
    };
    // host 从编辑组移除（标签被关闭 / 被新内容覆盖）时触发一次清理
    const cleanObserver = new MutationObserver(() => {
      if (!host.isConnected) { cleanObserver.disconnect(); cleanup(); }
    });
    if (host.parentNode) cleanObserver.observe(host.parentNode, { childList: true });
  }

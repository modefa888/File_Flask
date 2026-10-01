  // ---------- 封面 / 歌词关联（同名匹配） ----------
  function _dirnameOf(p) { var i = p.lastIndexOf("/"); return i <= 0 ? "/" : p.slice(0, i); }
  function _baseOf(name) { return name.replace(/\.[^.]+$/, ""); }

  function _coverUrlFor(trackAbs) {
    var base = _baseOf(trackAbs.split("/").pop()).toLowerCase();
    var rawExts = ["jpg", "jpeg", "png", "webp", "bmp", "gif"];   // /api/raw 可直出的格式
    var cands = _ctxItems.filter(function (it) {
      if (isDir(it)) return false;
      var nm = it.name.toLowerCase();
      if (rawExts.indexOf(extOf(nm)) < 0) return false;
      var b = _baseOf(nm);
      return b === base || b === "cover" || b === "folder" || b === "album" || b === "front";
    });
    cands.sort(function (a, b) {   // 同名封面优先于 cover/folder/album
      return (_baseOf(a.name.toLowerCase()) === base ? 0 : 1) -
             (_baseOf(b.name.toLowerCase()) === base ? 0 : 1);
    });
    if (!cands.length) {
      // 模糊兜底：文件名含歌名/歌手的图片；目录里仅有一张图片时直接采用
      var fname = trackAbs.split("/").pop();
      var tr = _parseTrack(fname);
      var tKey = _normKey(tr.title), aKey = _normKey(tr.artist);
      var imgs = _ctxItems.filter(function (it) {
        return !isDir(it) && rawExts.indexOf(extOf(it.name)) >= 0;
      });
      cands = imgs.filter(function (it) {
        var nb = _normKey(_baseOf(it.name));
        return (tKey && nb.indexOf(tKey) >= 0) || (aKey && nb.indexOf(aKey) >= 0);
      });
      if (!cands.length && imgs.length === 1) cands = imgs;
    }
    return cands.length ? "/api/raw?path=" + encodeURIComponent(itemAbs(cands[0])) : "";
  }

  function _normKey(s) { return (s || "").toLowerCase().replace(/\s+/g, ""); }

  // 歌词匹配：同名 .lrc 优先；否则按 歌名/歌手 模糊匹配
  // （兼容 音频为乱码名、lrc 命名为「歌名 - 歌手.lrc」等场景）
  function _findLrcItem(trackAbs) {
    var fname = trackAbs.split("/").pop();
    var base = _baseOf(fname).toLowerCase();
    var tr = _parseTrack(fname);
    var tKey = _normKey(tr.title), aKey = _normKey(tr.artist);
    var best = null, bestScore = -1;
    for (var i = 0; i < _ctxItems.length; i++) {
      var it = _ctxItems[i];
      if (isDir(it) || extOf(it.name) !== "lrc") continue;
      var b = _baseOf(it.name).toLowerCase();
      var nb = _normKey(b);
      var score = -1;
      if (b === base) score = 100;                                                          // 同名
      else if (tKey && nb.indexOf(tKey) >= 0 && (!aKey || nb.indexOf(aKey) >= 0)) score = 80; // 含歌名+歌手
      else if (tKey && nb.indexOf(tKey) >= 0) score = 60;                                    // 仅含歌名
      else if (aKey && nb.indexOf(aKey) >= 0 && nb.length <= aKey.length + 12) score = 40;   // 仅含歌手
      if (score > bestScore) { bestScore = score; best = it; }
    }
    return bestScore >= 40 ? best : null;
  }

  // 拉取目录列表并补全每项的绝对路径（接口列表项不带 abs_path，
  // itemAbs 会按「当前浏览目录」拼接——后台拉取时目录与浏览目录不一致会全部拼错）
  function _fetchDirItems(dir) {
    return fetchTimeout("/api/files?path=" + encodeURIComponent(dir) + "&limit=0&offset=0", 10000)
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var items = (d && d.items) || [];
        items.forEach(function (it) { if (!it.abs_path) it.abs_path = joinPath(dir, it.name); });
        return items;
      });
  }

  // 上下文不是曲目所在目录（如搜索结果进入）时，先拉取该目录列表再匹配
  function _loadExtras(abs) {
    var dir = _dirnameOf(abs);
    if (_ctxDir === dir) { _applyExtras(abs); return; }
    _fetchDirItems(dir)
      .then(function (items) { _ctxItems = items; _ctxDir = dir; _applyExtras(abs); })
      .catch(function () { _applyExtras(abs); });
  }

  function _applyExtras(abs) {
    if (_plIndex < 0 || !_plItems[_plIndex] || itemAbs(_plItems[_plIndex]) !== abs) return; // 已切歌
    var coverUrl = _coverUrlFor(abs);
    var mpDisc = document.getElementById("mpDisc");
    var ppDisc = document.getElementById("ppDisc");
    if (coverUrl) {
      var bg = 'url("' + coverUrl + '") center/cover no-repeat';
      mpDisc.style.background = bg;
      ppDisc.style.background = bg;
      mpDisc.textContent = "";
    } else {
      mpDisc.style.background = "";
      ppDisc.style.background = "";
      mpDisc.textContent = "🎵";
    }
    // 氛围背景：模糊放大的封面（无封面时回落到按曲目生成的渐变底色）
    var ppBg = document.getElementById("ppBg");
    if (ppBg) {
      ppBg.style.backgroundImage = coverUrl ? 'url("' + coverUrl + '")' : "";
      ppBg.classList.toggle("has-cover", !!coverUrl);
    }
    if (coverUrl && navigator.mediaSession && navigator.mediaSession.metadata) {
      try {
        var tr2 = _parseTrack(_plItems[_plIndex].name);
        navigator.mediaSession.metadata = new MediaMetadata({
          title: tr2.title, artist: tr2.artist || "", album: "文件管理",
          artwork: [{ src: coverUrl, sizes: "512x512" }]
        });
      } catch (e) {}
    }
    _loadLrc(abs);
  }

  function _loadLrc(abs) {
    _lrcLines = [];
    _lrcIdx = -1;
    var box = document.getElementById("ppLyrics");
    box.innerHTML = '<div class="pp-lyr-empty">暂无歌词</div>';
    box.scrollTop = 0;
    document.getElementById("mpLyric").textContent = "";
    var lrcItem = _findLrcItem(abs);
    if (!lrcItem) return;
    fetch("/api/preview?path=" + encodeURIComponent(itemAbs(lrcItem)))
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d || d.type !== "text" || !d.content) return;
        if (_plIndex < 0 || !_plItems[_plIndex] || itemAbs(_plItems[_plIndex]) !== abs) return;
        _lrcLines = _parseLrc(_decodeLrcContent(d.content));
        if (!_lrcLines.length) {
          // 内容拿到了但解析不出时间戳：多半是加密歌词（如 kwl/qrc）或损坏文件
          box.innerHTML = '<div class="pp-lyr-empty">歌词格式无法识别（可能是加密或损坏的 LRC）</div>';
          return;
        }
        _renderLrc();
      })
      .catch(function () {});
  }

  // LRC 内容解码：接口返回 base64（传输层）。再按实际情况：
  // 1) 部分下载工具把 .lrc 内容本身又做了 base64（二次编码），需再解一次；
  // 2) 文本可能是 UTF-8 或 GBK/GB18030（Windows「ANSI」）
  function _decodeLrcContent(b64) {
    var bin = atob(b64);   // 解传输层，得到 .lrc 文件内容
    var t = bin.trim();
    // 若内容本身不含时间戳且整体像 base64（纯字母数字+/=、长度 4 的倍数）→ 再解一层
    if (t.indexOf("[") < 0 && /^[A-Za-z0-9+/=\r\n]+$/.test(t) && t.replace(/\s+/g, "").length % 4 === 0 && t.length > 24) {
      try { bin = atob(t); } catch (e) {}
    }
    if (bin.charCodeAt(0) === 0xEF && bin.charCodeAt(1) === 0xBB && bin.charCodeAt(2) === 0xBF) {
      bin = bin.slice(3);   // 去 UTF-8 BOM
    }
    var bytes = Uint8Array.from(bin, function (c) { return c.charCodeAt(0); });
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch (e) {}
    try { return new TextDecoder("gbk").decode(bytes); } catch (e) {}
    try { return new TextDecoder("gb18030").decode(bytes); } catch (e) {}
    return bin;   // 兜底：按 Latin-1 原样返回
  }

  function _parseLrc(txt) {
    var out = [];
    txt.split(/\r\n|\n|\r/).forEach(function (line) {
      var tags = line.match(/\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g);
      if (!tags) return;
      var text = line.replace(/\[[^\]]*\]/g, "").trim();
      if (!text) return;
      tags.forEach(function (tag) {
        var m = tag.match(/\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/);
        var t = parseInt(m[1], 10) * 60 + parseInt(m[2], 10) +
                (m[3] ? parseInt((m[3] + "00").slice(0, 3), 10) / 1000 : 0);
        out.push({ t: t, text: text });
      });
    });
    out.sort(function (a, b) { return a.t - b.t; });
    return out;
  }

  function _renderLrc() {
    var box = document.getElementById("ppLyrics");
    box.innerHTML = "";
    if (!_lrcLines.length) { box.innerHTML = '<div class="pp-lyr-empty">纯音乐 · 无有效歌词</div>'; return; }
    _lrcLines.forEach(function (l) {
      var d = document.createElement("div");
      d.className = "pp-line";
      d.textContent = l.text;
      d.addEventListener("click", function () {   // 点歌词行跳转播放位置
        _audio.currentTime = l.t;
        if (_audio.paused) _audio.play().catch(function () {});
      });
      box.appendChild(d);
    });
    // 下一帧再定位：确保容器尺寸就绪、并按音频真实进度（而非刚 load 时的 0 秒）高亮
    requestAnimationFrame(function () { _syncLrc(_audio.currentTime); });
  }

  // 迷你条歌词超出一行时，启用跑马灯来回滚动（外层裁剪、内层文字平移）
  function _updateMpLyricScroll() {
    var mp = document.getElementById("mpLyric");
    mp.classList.remove("marquee");
    var span = document.createElement("span");
    span.className = "mpl-inner";
    span.textContent = mp.textContent;
    mp.textContent = "";
    mp.appendChild(span);
    var over = span.scrollWidth - mp.clientWidth;
    if (over > 4) {
      mp.style.setProperty("--shift", (over + 12) + "px");
      mp.style.setProperty("--dur", Math.max(6, Math.min(16, over / 15)) + "s");
      void mp.offsetWidth;   // 强制重启动画
      mp.classList.add("marquee");
    }
  }

  var _lrcHoldUntil = 0;   // 用户手动滚动歌词时，暂停自动跟随 3.5 秒
  function _syncLrc(cur) {
    if (!_lrcLines.length) return;
    var idx = -1;
    for (var i = 0; i < _lrcLines.length; i++) {
      if (_lrcLines[i].t <= cur + 0.25) idx = i; else break;
    }
    if (idx === _lrcIdx) return;
    _lrcIdx = idx;
    var box = document.getElementById("ppLyrics");
    var lines = box.querySelectorAll(".pp-line");
    lines.forEach(function (el, i) { el.classList.toggle("cur", i === idx); });
    document.getElementById("mpLyric").textContent = (idx >= 0) ? _lrcLines[idx].text : "";
    _updateMpLyricScroll();
    var curEl = lines[idx];
    if (curEl && Date.now() >= _lrcHoldUntil) {
      var y = curEl.offsetTop - box.clientHeight / 2 + curEl.offsetHeight / 2;
      try { box.scrollTo({ top: y, behavior: "smooth" }); } catch (e) { box.scrollTop = y; }
    }
  }
  document.getElementById("ppLyrics").addEventListener("touchstart", function () {
    _lrcHoldUntil = Date.now() + 3500;
  }, { passive: true });
  document.getElementById("ppLyrics").addEventListener("wheel", function () {
    _lrcHoldUntil = Date.now() + 3500;
  }, { passive: true });

  // 歌词常驻显示于唱片下方，无需视图切换

  function openAudioPlayer(item, contextItems, folderDir) {
    var src = (contextItems && contextItems.length) ? contextItems : (state.items || []);
    _plItems = src.filter(function (it) { return !isDir(it) && _isAudio(it); });
    if (!_plItems.length) { toast("该目录没有可播放的音频", "warn"); return; }
    // 保存上下文供封面/歌词匹配：来自指定目录/当前目录的列表可直接复用，搜索结果则按需拉取
    _ctxItems = src;
    _ctxDir = folderDir || ((contextItems && contextItems.length) ? null : (state.path || "/"));
    _plFolder = folderDir || state.path || "";
    if (folderDir) _grpSet(_plItems, folderDir);   // 记录分组根文件夹
    var idx = -1;
    for (var i = 0; i < _plItems.length; i++) {
      if (itemAbs(_plItems[i]) === itemAbs(item)) { idx = i; break; }
    }
    if (idx < 0) idx = 0;
    _mergeSavedPlaylist();   // 并回之前手动添加的歌曲，避免积累列表被重建冲掉
    _saveUserPlaylist();
    _renderTab();
    playIndex(idx, true);
    _showMini(true);
    // 单曲上下文（如一歌一文件夹布局）：自动向上扫描父目录汇总播放列表
    if (_plItems.length <= 1) _tryExpandPlaylist(itemAbs(item));
  }

  // 播放列表只有单曲时：查看父目录，若其下有子文件夹（或直接音频），
  // 则拉取全部音频汇成完整播放列表，当前歌保持播放
  function _tryExpandPlaylist(curAbs) {
    var dir = _plFolder || _dirnameOf(curAbs);
    var parent = _dirOf(dir);
    if (!parent || parent === dir) return;          // 已是根目录
    _fetchDirItems(parent)
      .then(function (items) {
        var subs = items.filter(function (it) { return isDir(it); });
        var direct = items.filter(function (it) { return !isDir(it) && _isAudio(it); });
        if (!subs.length) return null;              // 父目录无子文件夹，维持单曲
        if (subs.length > 40) subs = subs.slice(0, 40);
        return Promise.all(subs.map(function (sd) {
          return _fetchDirItems(itemAbs(sd))
            .then(function (list) {
              return list.filter(function (it) { return !isDir(it) && _isAudio(it); });
            })
            .catch(function () { return []; });
        })).then(function (arrs) {
          var all = direct.slice();
          arrs.forEach(function (a) { all = all.concat(a); });
          return all;
        });
      })
      .then(function (all) {
        if (!all || all.length <= 1) return;
        // 已切歌/播放列表已变化则放弃
        if (_plIndex < 0 || !_plItems[_plIndex] || itemAbs(_plItems[_plIndex]) !== curAbs) return;
        var idx = 0;
        for (var i = 0; i < all.length; i++) {
          if (itemAbs(all[i]) === curAbs) { idx = i; break; }
        }
        _plItems = all;
        _ctxItems = all;
        _ctxDir = null;                             // 各曲目目录不同，按曲目所在目录拉取封面/歌词
        _plFolder = parent;
        _plIndex = idx;
        _renderTab();
      })
      .catch(function () {});
  }

  function playIndex(i, autoplay) {
    if (i < 0 || i >= _plItems.length) return;
    _plIndex = i;
    var it = _plItems[i];
    var abs = itemAbs(it);
    var tr = _parseTrack(it.name);
    _audio.src = "/api/stream?path=" + encodeURIComponent(abs);
    _audio.load();
    document.getElementById("mpName").textContent = tr.artist ? (tr.title + " · " + tr.artist) : tr.title;
    document.getElementById("ppName").textContent = tr.title;
    document.getElementById("ppArtist").textContent = tr.artist || "未知艺术家";
    document.getElementById("playerPage").style.background = _coverColor(it.name);
    var sk0 = document.getElementById("ppSeek");   // 换曲后进度归零，填充比例同步重置
    sk0.value = 0; sk0.style.setProperty("--p", "0");
    _lrcIdx = -1;
    _loadExtras(abs);          // 匹配同名封面 + .lrc 歌词
    _highlightPlaylist();
    _pushHistory(it);          // 写入最近播放
    _syncFavBtn();
    if (typeof MediaMetadata !== "undefined" && navigator.mediaSession) {
      try {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: tr.title, artist: tr.artist || "", album: "文件管理"
        });
      } catch (e) {}
    }
    if (autoplay) _audio.play().catch(function () {});
    _syncPlayIcon(_audio.paused);
  }

  var _svgPlay = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
  var _svgPause = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>';

  function _syncPlayIcon(paused) {
    var ico = paused ? _svgPlay : _svgPause;
    document.getElementById("mpToggle").innerHTML = ico;
    document.getElementById("ppPlayBig").innerHTML = ico;
    document.getElementById("mpDisc").classList.toggle("paused", paused);
    document.getElementById("ppDisc").classList.toggle("paused", paused);
    if (navigator.mediaSession) navigator.mediaSession.playbackState = paused ? "paused" : "playing";
  }

  function _showMini(show) {
    document.getElementById("miniPlayer").classList.toggle("show", show);
    document.body.classList.toggle("has-mini", show);
  }

  function _renderPlaylist() {
    _dedupePlaylist();                     // 渲染前兜底去重
    var wrap = document.getElementById("ppPlItems");
    wrap.innerHTML = "";
    document.getElementById("cntPl").textContent = _plItems.length ? "(" + _plItems.length + ")" : "";
    // 预统计每个分组的歌曲数，用于判断是否隐藏冗余标题
    var grpCount = {};
    _plItems.forEach(function (it) {
      var g = _grpNameOf(itemAbs(it));
      grpCount[g] = (grpCount[g] || 0) + 1;
    });
    var lastDir = null;
    _plItems.forEach(function (it, i) {
      // 按「添加时的根文件夹」分组，变化时插入分隔标题
      var gname = _grpNameOf(itemAbs(it));
      if (gname !== lastDir) {
        lastDir = gname;
        // 分组里只有一首、且歌名与分组名一致/以其开头（歌独占同名文件夹）：标题与歌名重复，隐藏
        var norm = function (s) { return String(s).toLowerCase().replace(/\s+/g, ""); };
        var soloRedundant = grpCount[gname] === 1 &&
          norm(_baseOf(it.name)).indexOf(norm(gname)) === 0;
        if (!soloRedundant) {
          var g = document.createElement("div");
          g.className = "pl-group";
          g.textContent = "📁 " + gname;
          wrap.appendChild(g);
        }
      }
      var tr = _parseTrack(it.name);
      var d = document.createElement("div");
      d.className = "pl-item" + (i === _plIndex ? " cur" : "");
      d.innerHTML = '<span class="pl-ico">🎵</span><span class="pl-name">' + esc(tr.title) + '</span><button class="pl-fav' + (_isFav(it) ? " on" : "") + '" title="喜欢">' + _svgHeart + '</button>';
      d.addEventListener("click", function () { playIndex(i, true); _showMini(true); });
      d.querySelector(".pl-fav").addEventListener("click", function (e) {
        e.stopPropagation(); _toggleFav(it); _renderTab(); _syncFavBtn();
      });
      wrap.appendChild(d);
    });
    _highlightPlaylist();
  }

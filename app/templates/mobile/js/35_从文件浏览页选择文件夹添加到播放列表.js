  // ===== 从文件浏览页选择文件夹添加到播放列表 =====
  // 扫描文件夹（含子文件夹，最多 40 个）里的全部音频
  function _scanDirSongs(dir) {
    return _fetchDirItems(dir).then(function (items) {
      var songs = items.filter(function (it) { return !isDir(it) && _isAudio(it); });
      var subs = items.filter(function (it) { return isDir(it); }).slice(0, 40);
      return Promise.all(subs.map(function (sd) {
        return _fetchDirItems(itemAbs(sd))
          .then(function (l) { return l.filter(function (it) { return !isDir(it) && _isAudio(it); }); })
          .catch(function () { return []; });
      })).then(function (arrs) {
        arrs.forEach(function (a) { songs = songs.concat(a); });
        return songs;
      });
    });
  }
  // 去重并入播放列表；无音频则提示
  function _addDirToPlaylist(dir) {
    _scanDirSongs(dir)
      .then(function (songs) {
        if (!songs.length) { toast("该文件夹没有音频文件", "warn"); return; }
        var have = {};
        _plItems.forEach(function (it) { have[itemAbs(it)] = 1; });
        var added = [], addedCount = 0;
        songs.forEach(function (s) {
          var sk = _songKey(s.name);
          // 已有同首歌（按解析歌名匹配，文件改过名也能识别）：把首个匹配更新为最新路径
          var first = -1;
          for (var i = 0; i < _plItems.length; i++) {
            if (_songKey(_plItems[i].name) === sk) { first = i; break; }
          }
          if (first >= 0) {
            if (itemAbs(_plItems[first]) !== itemAbs(s)) {
              _plItems[first] = s;
              for (var j = 0; j < _ctxItems.length; j++) {
                if (_songKey(_ctxItems[j].name) === sk) { _ctxItems[j] = s; break; }
              }
            }
            return;
          }
          if (!have[itemAbs(s)]) { _plItems.push(s); _ctxItems.push(s); added.push(s); addedCount++; }
        });
        _dedupePlaylist();                     // 兜底：清掉残余的重复条目
        _saveUserPlaylist();                   // 持久化当前播放列表
        if (addedCount) _grpSet(added, dir);   // 分组名 = 添加时的根文件夹
        if (_plIndex < 0 && _plItems.length) { playIndex(0, true); _showMini(true); }
        else _renderTab();
        toast(addedCount ? "已添加 " + addedCount + " 首歌曲" : "没有新增歌曲（可能已存在）", "info");
      })
      .catch(function () { toast("添加失败", "error"); });
  }
  // 抽屉按钮：关闭播放器回到文件浏览页，由用户在文件夹菜单里添加
  // 点它才「激活」文件夹菜单里的「添加到音乐播放列表」，而且只生效一次
  document.getElementById("ppPlAdd").addEventListener("click", function () {
    _plAddPending = true;
    _closePlaylist();
    closePlayerPage();
    toast("请选择一个文件夹，点「添加到音乐播放列表」（本次只显示一次）", "info");
  });

  function _syncFavBtn() {
    var btn = document.getElementById("ppFavBtn");
    if (_plIndex < 0 || !_plItems[_plIndex]) return;
    btn.classList.toggle("on", _isFav(_plItems[_plIndex]));
  }
  function _highlightPlaylist() {
    var items = document.querySelectorAll("#ppPlaylist .pl-item");
    items.forEach(function (el, i) { el.classList.toggle("cur", i === _plIndex); });
  }

  function _toggle() { if (_audio.paused) _audio.play().catch(function () {}); else _audio.pause(); }

  _audio.addEventListener("play", function () { _syncPlayIcon(false); });
  _audio.addEventListener("pause", function () { _syncPlayIcon(true); });
  _audio.addEventListener("timeupdate", function () {
    if (_seeking) return;
    var cur = _audio.currentTime, dur = _audio.duration;
    _syncLrc(cur);
    document.getElementById("ppCur").textContent = _fmtTime(cur);
    document.getElementById("ppDur").textContent = _fmtTime(dur);
    if (isFinite(dur) && dur > 0) {
      var sk1 = document.getElementById("ppSeek");
      sk1.value = Math.round(cur / dur * 1000);
      sk1.style.setProperty("--p", (cur / dur).toFixed(4));   // 驱动轨道已播放段填充
    }
  });
  _audio.addEventListener("loadedmetadata", function () {
    document.getElementById("ppDur").textContent = _fmtTime(_audio.duration);
  });

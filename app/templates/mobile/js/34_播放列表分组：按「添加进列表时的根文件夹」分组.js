  // ===== 播放列表分组：按「添加进列表时的根文件夹」分组 =====
  var _grpStore = (function () {
    try { return JSON.parse(localStorage.getItem("ff_music_groups") || "{}"); } catch (e) { return {}; }
  })();
  function _grpSave() { try { localStorage.setItem("ff_music_groups", JSON.stringify(_grpStore)); } catch (e) {} }
  function _grpNameOf(abs) {
    if (_grpStore[abs]) return _grpStore[abs];               // 优先用添加时的根文件夹名
    var d = _dirOf(abs);
    return d === "/" ? "/" : (d.split("/").pop() || d);      // 兜底：直接所在目录名
  }
  function _grpSet(items, rootDir) {
    var name = !rootDir || rootDir === "/" ? "/" : (rootDir.split("/").pop() || rootDir);
    items.forEach(function (it) { _grpStore[itemAbs(it)] = name; });
    _grpSave();
  }
  // 歌曲唯一键：解析后的歌名（忽略大小写/空格/连接符），文件改名也能识别为同一首
  function _songKey(name) {
    return _parseTrack(String(name || "")).title.toLowerCase().replace(/[\s\-_.]+/g, "");
  }
  // 播放列表整体去重：同歌名只保留最先出现的一条
  function _dedupePlaylist() {
    var seen = {};
    for (var i = _plItems.length - 1; i >= 0; i--) {
      var k = _songKey(_plItems[i].name);
      if (seen[k]) {
        var staleAbs = itemAbs(_plItems[i]);
        _plItems.splice(i, 1);
        if (_plIndex >= i) _plIndex--;
        for (var j = _ctxItems.length - 1; j >= 0; j--) {
          try { if (itemAbs(_ctxItems[j]) === staleAbs) _ctxItems.splice(j, 1); } catch (e) {}
        }
      } else seen[k] = 1;
    }
  }
  // 「添加到音乐播放列表」积累的歌曲持久化：点开其它目录播放重建队列时不会丢失
  function _saveUserPlaylist() {
    _plSave("ff_music_user_pl", _plItems.map(function (it) { return { p: itemAbs(it), n: it.name }; }));
  }
  function _mergeSavedPlaylist() {
    var saved = _plStore("ff_music_user_pl");
    if (!saved.length) return;
    var have = {};
    _plItems.forEach(function (it) { have[itemAbs(it)] = 1; });
    saved.forEach(function (r) {
      if (r && r.p && !have[r.p]) { _plItems.push(_recItem(r)); have[r.p] = 1; }
    });
    _dedupePlaylist();
  }
  // 页面加载/项目重启后恢复上次保存的播放列表（不自动播放，点列表行即播）
  (function _restorePlaylist() {
    var saved = _plStore("ff_music_user_pl");
    if (!saved.length) return;
    _plItems = saved.filter(function (r) { return r && r.p && r.n; }).map(_recItem);
    _dedupePlaylist();
  })();

  // 点历史/喜欢列表：拉取文件所在目录列表，恢复整个文件夹播放队列后定位到该曲。
  // 文件在原目录找不到（被移动/改名）时，用搜索按文件名找回新位置并修正记录。
  function _healRecord(rec) {
    var kw = rec.n.replace(/\.[^.]+$/, "");
    return fetchTimeout("/api/search?keyword=" + encodeURIComponent(kw) + "&use_index=1&timeout=15", 20000)
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var items = (d && d.items) || [];
        if (!items.length) return null;
        for (var i = 0; i < items.length; i++) {
          var ap = items[i].abs_path || "";
          if (!isDir(items[i]) && _isAudio(items[i]) &&
              (ap === rec.p || ap.split("/").pop() === rec.n)) {
            return { p: ap, n: rec.n, d: _dirOf(ap) };
          }
        }
        return null;
      })
      .catch(function () { return null; });
  }
  function _updateStoredRec(oldP, fixed) {
    ["ff_music_history", "ff_music_favs"].forEach(function (key) {
      var arr = _plStore(key);
      var changed = false;
      arr.forEach(function (r) {
        if (r.p === oldP) { r.p = fixed.p; r.d = fixed.d; changed = true; }
      });
      if (changed) _plSave(key, arr);
    });
  }
  function _playFromRecord(rec) {
    var dir = rec.d || _dirOf(rec.p);
    var fallback = function () {
      _closePlaylist();
      openAudioPlayer(_recItem(rec), [_recItem(rec)], dir);   // 彻底找不到：按旧路径单曲兜底
    };
    _fetchDirItems(dir)
      .then(function (items) {
        var hit = null;
        for (var i = 0; i < items.length; i++) {
          if (!isDir(items[i]) && _isAudio(items[i]) && itemAbs(items[i]) === rec.p) { hit = items[i]; break; }
        }
        if (hit) {
          _closePlaylist();
          openAudioPlayer(hit, items, dir);      // 恢复文件夹队列
          return null;
        }
        // 原目录没有该文件：尝试按文件名搜索新位置（文件被移动/改名的情况）
        return _healRecord(rec).then(function (fixed) {
          if (!fixed) { fallback(); return null; }
          _updateStoredRec(rec.p, fixed);        // 修正历史/喜欢里的旧路径
          return _fetchDirItems(fixed.d).then(function (items2) {
            var hit2 = null;
            for (var j = 0; j < items2.length; j++) {
              if (!isDir(items2[j]) && _isAudio(items2[j]) && itemAbs(items2[j]) === fixed.p) { hit2 = items2[j]; break; }
            }
            _closePlaylist();
            if (hit2) openAudioPlayer(hit2, items2, fixed.d);   // 新位置恢复文件夹队列
            else openAudioPlayer(_recItem(fixed), [_recItem(fixed)], fixed.d);
          });
        });
      })
      .catch(fallback);
  }

  function _renderStoreList(kind) {
    var wrap = document.getElementById("ppPlItems");
    wrap.innerHTML = "";
    var recs = _plStore(kind === "his" ? "ff_music_history" : "ff_music_favs");
    document.getElementById(kind === "his" ? "cntHis" : "cntFav").textContent = recs.length ? "(" + recs.length + ")" : "";
    if (!recs.length) {
      wrap.innerHTML = '<div class="pl-empty">' + (kind === "his" ? "还没有播放记录" : "还没有喜欢的歌曲，点击歌曲右侧 ♥ 收藏") + "</div>";
      return;
    }
    recs.forEach(function (rec) {
      var it = _recItem(rec);
      var tr = _parseTrack(it.name);
      var d = document.createElement("div");
      d.className = "pl-item";
      d.innerHTML = '<span class="pl-ico">🎵</span><span class="pl-name">' + esc(tr.title) + '</span><button class="pl-fav' + (_isFav(it) ? " on" : "") + '" title="喜欢">' + _svgHeart + '</button>';
      d.addEventListener("click", function () { _playFromRecord(rec); });
      d.querySelector(".pl-fav").addEventListener("click", function (e) {
        e.stopPropagation(); _toggleFav(it); _renderTab(); _syncFavBtn();
      });
      wrap.appendChild(d);
    });
  }

  function _renderTab() {
    document.querySelectorAll(".pp-tab").forEach(function (b) {
      b.classList.toggle("active", b.dataset.tab === _plTab);
    });
    document.getElementById("ppPlClear").style.display = _plTab === "pl" ? "none" : "";
    document.getElementById("ppPlAdd").style.display = _plTab === "pl" ? "" : "none";
    if (_plTab === "pl") _renderPlaylist();
    else _renderStoreList(_plTab);
  }

  document.getElementById("ppPlClear").addEventListener("click", function () {
    if (_plTab === "pl") return;
    var isFav = _plTab === "fav";
    var doClear = function () {
      _plSave(isFav ? "ff_music_favs" : "ff_music_history", []);
      _renderTab();
      if (_plIndex >= 0) _syncFavBtn();
      toast(isFav ? "已清空喜欢列表" : "已清空播放记录", "info");
    };
    if (isFav) {
      confirmBox({ title: "清空喜欢列表", message: "确定要清空全部喜欢的歌曲吗？", okText: "清空", onOk: doClear });
    } else {
      doClear();
    }
  });

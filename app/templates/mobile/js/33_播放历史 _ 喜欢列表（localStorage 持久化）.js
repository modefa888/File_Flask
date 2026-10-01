  // ===== 播放历史 / 喜欢列表（localStorage 持久化）=====
  var _plTab = "pl";
  var _svgHeart = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>';

  function _plStore(key) {
    try { return JSON.parse(localStorage.getItem(key) || "[]"); } catch (e) { return []; }
  }
  function _plSave(key, arr) { try { localStorage.setItem(key, JSON.stringify(arr)); } catch (e) {} }
  function _recItem(rec) { return { abs_path: rec.p, name: rec.n }; }
  function _isFav(it) {
    var k = itemAbs(it);
    return _plStore("ff_music_favs").some(function (r) { return r.p === k; });
  }
  function _toggleFav(it) {
    var k = itemAbs(it);
    var had = _isFav(it);
    var arr = _plStore("ff_music_favs").filter(function (r) { return r.p !== k; });
    if (!had) arr.unshift({ p: k, n: it.name, d: _dirOf(k) });
    _plSave("ff_music_favs", arr);
  }
  function _pushHistory(it) {
    var k = itemAbs(it);
    var arr = _plStore("ff_music_history").filter(function (r) { return r.p !== k; });
    arr.unshift({ p: k, n: it.name, d: _dirOf(k) });
    if (arr.length > 50) arr.length = 50;
    _plSave("ff_music_history", arr);
  }
  function _dirOf(abs) {
    var i = abs.lastIndexOf("/");
    return i > 0 ? abs.slice(0, i) : "/";
  }

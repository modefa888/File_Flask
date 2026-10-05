  // ---------- 音频播放器 ----------
  var _audio = new Audio();
  _audio.preload = "auto";
  var _plItems = [];      // 播放列表（当前目录下的音频文件）[{name, abs}]
  var _plIndex = -1;
  var _plFolder = "";
  // 「添加到音乐播放列表」只在点了播放器列表里的「＋ 添加文件夹」后才出现，
  // 且一次触发只能用一次（加完即失效），想再添加需要再次触发
  var _plAddPending = false;
  var _seeking = false;
  var _ctxItems = [];     // 封面/歌词匹配用的目录文件列表
  var _ctxDir = null;     // _ctxItems 对应的目录；null 表示需按曲目目录拉取
  var _lrcLines = [];     // 解析后的歌词 [{t, text}]
  var _lrcIdx = -1;

  function _isAudio(item) { return AUDIO_EXT.indexOf(extOf(item.name)) >= 0; }
  function _fmtTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    sec = Math.floor(sec);
    var s = sec % 60, m = Math.floor(sec / 60) % 60, h = Math.floor(sec / 3600);
    // 超过 1 小时显示 h:mm:ss，否则保持 m:ss
    if (h) return h + ":" + (m < 10 ? "0" : "") + m + ":" + (s < 10 ? "0" : "") + s;
    return m + ":" + (s < 10 ? "0" : "") + s;
  }
  function _parseTrack(name) {
    // 约定「歌名 - 歌手.扩展名」：第一段是歌名，第二段是歌手
    var base = name.replace(/\.[^.]+$/, "");
    var i = base.indexOf(" - ");
    if (i > 0) return { title: base.slice(0, i), artist: base.slice(i + 3) };
    return { title: base, artist: "" };
  }
  function _coverColor(name) {
    var h = 0;
    for (var k = 0; k < name.length; k++) h = (h * 31 + name.charCodeAt(k)) % 360;
    return "linear-gradient(165deg, hsl(" + h + ",45%,42%), hsl(" + ((h + 40) % 360) + ",50%,30%))";
  }

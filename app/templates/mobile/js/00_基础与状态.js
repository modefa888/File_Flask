
(function () {
  "use strict";

  var SORT_KEY = "fm_mobile_sort";        // 排序偏好（localStorage 持久化）
  var VIEW_KEY = "fm_mobile_view";        // 视图：list / grid
  var state = { path: "", parentPath: null, items: [], selMode: false, selSet: {},
                sort: { mode: "name", dir: 1 }, view: "list" };
  (function () {   // 恢复上次排序/视图偏好
    var s = spLsGet(SORT_KEY, null);
    if (s && ["name", "type", "size", "time"].indexOf(s.mode) >= 0 && (s.dir === 1 || s.dir === -1)) {
      state.sort = { mode: s.mode, dir: s.dir };
    }
    var v = spLsGet(VIEW_KEY, null);
    if (v === "grid" || v === "list") state.view = v;
  })();
  var pendingOp = null;   // 待执行的移动/复制: { mode: "move"|"copy", paths: [...] }
  var lpFired = false;    // 长按已触发标记，用于抑制随后的 click
  var MOBILE_IMG_EXT = ["jpg","jpeg","png","gif","bmp","webp","heic","tiff","svg"];
  var VIDEO_EXT = ["mp4","webm","mkv","mov","avi","flv","wmv","m4v","mpg","mpeg","ts","3gp","ogv"];
  var AUDIO_EXT = ["mp3","wav","ogg","flac","aac","m4a","opus","wma","mid","midi"];
  var TEXT_EXT = ["txt","md","log","json","csv","xml","yml","yaml","ini","conf","cfg","toml","py","js","ts","css","html","htm","sh","bat","c","cpp","h","java","go","rs","php","sql","gitignore"];
  var ARCHIVE_EXT = ["zip","rar","7z","tar","gz","tgz","bz2","xz"];

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function extOf(name) {
    var i = name.lastIndexOf(".");
    return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
  }
  function isDir(item) { return !!item.is_dir; }
  function joinPath(base, name) {
    if (!base || base === "/") return "/" + name;
    return base.replace(/\/+$/, "") + "/" + name;
  }
  function itemAbs(item) {
    // 搜索结果自带绝对路径；普通列表项按当前目录拼接
    if (item.abs_path) return item.abs_path;
    return joinPath(state.path, item.name);
  }

  function iconFor(item) {
    if (isDir(item)) return "📁";
    var ext = extOf(item.name);
    if (MOBILE_IMG_EXT.indexOf(ext) >= 0) return "🖼️";
    if (VIDEO_EXT.indexOf(ext) >= 0) return "🎬";
    if (AUDIO_EXT.indexOf(ext) >= 0) return "🎵";
    if (ext === "pdf") return "📕";
    // Office 文档
    if (ext === "xls" || ext === "xlsx" || ext === "csv") return "📊";
    if (ext === "ppt" || ext === "pptx") return "📽️";
    if (ext === "doc" || ext === "docx" || ext === "wps" || ext === "rtf") return "📝";
    if (ARCHIVE_EXT.indexOf(ext) >= 0) return "📦";
    // 应用 / 安装包 / 镜像 / 种子：不用文本图标
    if (ext === "apk") return "📱";
    if (ext === "exe" || ext === "msi") return "💻";
    if (ext === "dmg" || ext === "iso") return "💿";
    if (ext === "torrent") return "🧲";
    if (TEXT_EXT.indexOf(ext) >= 0) return "📄";
    return "📄";
  }
  // 常见文本/代码格式的彩色扩展名徽标：[标签, 背景色, 文字色]
  var EXT_BADGE = {
    js: ["JS", "#f7df1e", "#3b3300"], mjs: ["JS", "#f7df1e", "#3b3300"], cjs: ["JS", "#f7df1e", "#3b3300"],
    jsx: ["JSX", "#61dafb", "#00303f"],
    ts: ["TS", "#3178c6", "#fff"], tsx: ["TSX", "#3178c6", "#fff"],
    json: ["{}", "#7cb342", "#fff"], jsonc: ["{}", "#7cb342", "#fff"],
    md: ["MD", "#42a5f5", "#fff"], markdown: ["MD", "#42a5f5", "#fff"],
    html: ["<>", "#e44d26", "#fff"], htm: ["<>", "#e44d26", "#fff"],
    vue: ["VUE", "#42b883", "#fff"],
    css: ["#", "#1565c0", "#fff"], scss: ["SCSS", "#c6538c", "#fff"], less: ["LESS", "#2f6db3", "#fff"],
    py: ["PY", "#3572a5", "#fff"],
    sh: ["$", "#89e051", "#1d3b00"], bash: ["$", "#89e051", "#1d3b00"], zsh: ["$", "#89e051", "#1d3b00"],
    bat: ["BAT", "#7a9f35", "#fff"], cmd: ["BAT", "#7a9f35", "#fff"], ps1: ["PS", "#5391fe", "#fff"],
    c: ["C", "#0288d1", "#fff"], h: ["H", "#7e8c9a", "#fff"],
    cpp: ["C++", "#f34b7d", "#fff"], hpp: ["C++", "#f34b7d", "#fff"], cc: ["C++", "#f34b7d", "#fff"],
    java: ["JVA", "#b07219", "#fff"], kt: ["KT", "#a97bff", "#fff"],
    go: ["GO", "#00add8", "#fff"], rs: ["RS", "#dea584", "#3b2104"],
    php: ["PHP", "#777bb4", "#fff"], rb: ["RB", "#cc342d", "#fff"],
    sql: ["SQL", "#e38c00", "#fff"],
    xml: ["XML", "#0060ac", "#fff"],
    yml: ["YML", "#cb171e", "#fff"], yaml: ["YML", "#cb171e", "#fff"],
    toml: ["CFG", "#607d8b", "#fff"], ini: ["CFG", "#607d8b", "#fff"],
    cfg: ["CFG", "#607d8b", "#fff"], conf: ["CFG", "#607d8b", "#fff"], env: ["ENV", "#607d8b", "#fff"],
    txt: ["TXT", "#9e9e9e", "#fff"], log: ["LOG", "#78909c", "#fff"],
    csv: ["CSV", "#2e7d32", "#fff"], tsv: ["CSV", "#2e7d32", "#fff"],
    gitignore: ["GIT", "#f14e32", "#fff"], gitattributes: ["GIT", "#f14e32", "#fff"]
  };
  // 特殊文件名（无扩展名或按文件名识别）
  var FILENAME_BADGE = {
    dockerfile: ["🐳", "#2496ed", "#fff"],
    makefile: ["MK", "#6a737d", "#fff"],
    license: ["©", "#8d6e63", "#fff"],
    "license.md": ["©", "#8d6e63", "#fff"]
  };

  // 优先返回彩色徽标 HTML；未命中返回 emoji（与 iconFor 一致）
  function iconHtmlFor(item) {
    if (isDir(item)) return iconFor(item);
    var ext = extOf(item.name);
    var hit = EXT_BADGE[ext] || FILENAME_BADGE[String(item.name || "").toLowerCase()];
    if (!hit) return iconFor(item);
    return '<span class="ext-badge" style="background:' + hit[1] + ';color:' + hit[2] + '">' +
      esc(hit[0]) + '</span>';
  }

  // 弹窗/卡片标题用的小缩略块：可出缩略图的用真图，否则用彩色扩展名徽标/图标（与列表项同款）
  function _titleThumbHtml(item) {
    if (!isDir(item) && canThumb(item)) {
      return '<img loading="lazy" src="/api/thumbnail?path=' +
        encodeURIComponent(itemAbs(item)) + '" alt="" onerror="this.parentNode.textContent=\'' +
        iconFor(item) + '\'">';
    }
    return iconHtmlFor(item);
  }

  function fileTypeName(item) {
    // "后缀 + 中文类型"提示，如 "ZIP 压缩包"；目录返回 "文件夹"
    if (isDir(item)) return "文件夹";
    var ext = extOf(item.name);
    if (!ext) return "文件";
    var map = {
      jpg: "图片", jpeg: "图片", png: "图片", gif: "图片", webp: "图片", bmp: "图片",
      svg: "图片", ico: "图标", heic: "图片", tif: "图片", tiff: "图片",
      mp4: "视频", avi: "视频", mkv: "视频", mov: "视频", wmv: "视频", flv: "视频",
      webm: "视频", m4v: "视频", rmvb: "视频", ts: "视频", mpg: "视频",
      mp3: "音频", wav: "音频", flac: "音频", aac: "音频", ogg: "音频", m4a: "音频", wma: "音频",
      pdf: "PDF 文档", doc: "Word 文档", docx: "Word 文档", wps: "文档",
      xls: "Excel 表格", xlsx: "Excel 表格", csv: "表格",
      ppt: "PPT 演示", pptx: "PPT 演示",
      txt: "文本", md: "Markdown 笔记", log: "日志", rtf: "文档",
      zip: "压缩包", rar: "压缩包", "7z": "压缩包", tar: "压缩包", gz: "压缩包",
      bz2: "压缩包", xz: "压缩包", tgz: "压缩包",
      html: "网页", htm: "网页", css: "样式表", js: "脚本", json: "数据", xml: "数据",
      py: "脚本", sh: "脚本", bat: "脚本", java: "代码", c: "代码", cpp: "代码",
      exe: "程序", msi: "安装包", apk: "安装包", dmg: "镜像", iso: "镜像", torrent: "种子"
    };
    var label = map[ext];
    return ext.toUpperCase() + (label ? " " + label : " 文件");
  }
  function canThumb(item) {
    if (isDir(item)) return false;
    var ext = extOf(item.name);
    return MOBILE_IMG_EXT.indexOf(ext) >= 0 || VIDEO_EXT.indexOf(ext) >= 0;
  }

/* ================================================================
 * 标签页内嵌压缩包查看器（zip / rar 可在线浏览；7z、tar.gz 等提示下载）
 *
 * 能力：
 *   · 目录内浏览：面包屑逐级进入 / 返回上级（Backspace、Alt+←）
 *   · 列表：图标 + 名称 + 原始大小 + 压缩后大小，按名称 / 大小排序，支持目录内过滤
 *   · 右侧预览：文本（等宽滚动）、图片、音频、视频、PDF 直接看；其它类型提示下载
 *   · 单文件下载 / 整个压缩包下载（都走二次确认悬浮框）
 *   · 一键解压到压缩包所在目录（zip；rar 需系统 unrar，不支持时按钮自动禁用）
 *
 * 全部复用已有后端接口（app/routes/common/zip.py）：
 *   GET  /api/zip/contents?path=&dir=      列目录（zip / rar）
 *   GET  /api/zip/preview?zip_path=&entry= 单个成员 base64（≤50MB）
 *   GET  /api/zip/file?zip_path=&entry=    单个成员下载
 *   POST /api/zip/unzip  {path}            解压到 zip 所在目录
 *
 * 注意：本文件在 00_preamble 大 IIFE 关闭之后加载，setupArchiveView 是全局函数，
 * 由 openFile 的压缩包分支调用（activate(tab) 由调用方负责）。
 * ================================================================ */

var IDE_ARCHIVE_EXTS = ["zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "xz", "zst"];
// 后端目前只解析这两种；其余格式只能下载
var IDE_ARCHIVE_VIEWABLE = ["zip", "rar"];

var _azvCleanups = [];

function _azvCleanupRun() {
  _azvCleanups.forEach(f => { try { f(); } catch (_) {} });
  _azvCleanups = [];
}

function _azvEsc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function _azvFmt(n) {
  if (!isFinite(n) || n <= 0) return "—";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (i === 0 ? v : v.toFixed(1)) + " " + u[i];
}

function _azvB64ToBytes(b64) {
  const bin = atob(b64 || "");
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const AZV_TEXT_EXTS = ["txt", "md", "markdown", "log", "json", "xml", "yml", "yaml", "ini", "cfg", "conf",
  "env", "py", "js", "mjs", "cjs", "ts", "tsx", "jsx", "html", "htm", "css", "scss", "less",
  "sh", "bash", "bat", "ps1", "rs", "go", "java", "c", "cpp", "h", "hpp", "cs", "rb", "php",
  "sql", "csv", "tsv", "toml", "lock", "gitignore", "dockerfile", "makefile", "lrc", "srt", "vtt"];
const AZV_IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg", "avif"];
const AZV_AUDIO_EXTS = ["mp3", "wav", "flac", "aac", "m4a", "ogg", "opus"];
const AZV_VIDEO_EXTS = ["mp4", "webm", "mkv", "mov", "m4v"];

function setupArchiveView(tab, host, path, name) {
  _azvCleanupRun();
  tab.isArchive = true;

  const fileName = name || path.split("/").pop() || "";
  const ext = (fileName.split(".").pop() || "").toLowerCase();
  const viewable = IDE_ARCHIVE_VIEWABLE.indexOf(ext) >= 0;

  host.innerHTML =
    '<div class="azv-wrap">' +
      '<div class="azv-head">' +
        '<div class="azv-crumbs"></div>' +
        '<div class="azv-tools">' +
          '<input class="azv-filter" type="search" placeholder="过滤当前目录…" ' + (viewable ? "" : "disabled") + '>' +
          '<button class="azv-btn azv-sort" title="排序：名称 / 大小（点击切换）"><i class="bi bi-sort-alpha-down"></i><span class="azv-sort-t">名称</span></button>' +
          '<button class="azv-btn azv-wrapbtn" title="代码预览自动换行：长行折行显示（不出现横向滚动条）"><i class="bi bi-text-wrap"></i>换行</button>' +
          '<button class="azv-btn azv-extract" title="解压到压缩包所在目录"><i class="bi bi-box-arrow-down"></i>解压</button>' +
          '<button class="azv-btn azv-dl" title="下载整个压缩包"><i class="bi bi-download"></i>下载</button>' +
        '</div>' +
      '</div>' +
      '<div class="azv-body">' +
        '<div class="azv-list">' +
          '<div class="azv-row azv-row-head"><span class="azv-c-name">名称</span>' +
            '<span class="azv-c-size">大小</span><span class="azv-c-comp">压缩后</span></div>' +
          '<div class="azv-rows"></div>' +
        '</div>' +
        '<div class="azv-preview">' +
          '<div class="azv-pv-head"><span class="azv-pv-name">选择左侧文件预览</span>' +
            '<span class="azv-pv-act"></span></div>' +
          '<div class="azv-pv-body"><div class="azv-pv-empty"><i class="bi bi-file-earmark-text"></i>' +
            '<div>点左侧文件在这里预览，目录点一下即可进入</div></div></div>' +
        '</div>' +
      '</div>' +
    '</div>';

  const $ = sel => host.querySelector(sel);
  const wrap = $(".azv-wrap");
  const crumbsEl = $(".azv-crumbs"), rowsEl = $(".azv-rows");
  const filterEl = $(".azv-filter"), sortBtn = $(".azv-sort"), sortLabel = $(".azv-sort-t");
  const wrapBtn = $(".azv-wrapbtn");
  const extractBtn = $(".azv-extract"), dlBtn = $(".azv-dl");
  const pvName = $(".azv-pv-name"), pvAct = $(".azv-pv-act"), pvBody = $(".azv-pv-body");
  const listEl = $(".azv-list"), pvEl = $(".azv-preview");

  let curDir = "";              // 当前 zip 内的相对目录（无前导 /、无尾随 /）
  let entries = [];             // 当前目录全部条目
  let sortKey = "name";         // name | size
  let sortDesc = false;
  let selected = "";            // 当前选中成员（完整相对路径）
  let curPreviewUrl = "";       // 预览用的 blob URL，切换 / 关闭时释放
  let loadSeq = 0;
  let curCm = null;             // 当前文本预览的 CodeMirror 实例（切换 / 关闭时丢弃）
  // 代码预览自动换行：默认开（长 JSON / 长日志一行到底没法读），选择记在 localStorage
  let wrapOn = true;
  try {
    const v = localStorage.getItem("ide.archiveWrap");
    if (v === "0") wrapOn = false;
  } catch (_) {}
  const syncWrapBtn = () => wrapBtn.classList.toggle("on", wrapOn);
  syncWrapBtn();

  /* ---------- 轻量提示（本模块在 IIFE 之外，拿不到全局 toast） ---------- */
  let toastTimer = null;
  const azvToast = (msg, type) => {
    let el = $(".azv-toast");
    if (!el) { el = document.createElement("div"); el.className = "azv-toast"; wrap.appendChild(el); }
    el.textContent = msg;
    el.className = "azv-toast show " + (type || "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = "azv-toast " + (type || ""); }, 3200);
  };

  /* ---------- 面包屑 ---------- */
  const renderCrumbs = () => {
    const segs = curDir ? curDir.split("/") : [];
    let acc = "";
    let html = '<span class="azv-crumb" data-p=""><i class="bi bi-file-earmark-zip"></i>' + _azvEsc(fileName) + '</span>';
    segs.forEach((s) => {
      acc = acc ? acc + "/" + s : s;
      html += '<i class="bi bi-chevron-right azv-crumb-sep"></i>' +
        '<span class="azv-crumb" data-p="' + _azvEsc(acc) + '">' + _azvEsc(s) + '</span>';
    });
    if (!viewable) {
      html = '<span class="azv-crumb"><i class="bi bi-file-earmark-zip"></i>' + _azvEsc(fileName) + '</span>';
    }
    crumbsEl.innerHTML = html;
    crumbsEl.querySelectorAll(".azv-crumb").forEach(el => {
      el.onclick = () => { if (!viewable) return; load(el.dataset.p || ""); };
    });
  };

  /* ---------- 预览区 ---------- */
  const clearPreviewUrl = () => {
    if (curPreviewUrl) { try { URL.revokeObjectURL(curPreviewUrl); } catch (_) {} curPreviewUrl = ""; }
  };
  const pvEmpty = (icon, text) => {
    clearPreviewUrl(); curCm = null;
    pvName.textContent = "选择左侧文件预览";
    pvAct.innerHTML = "";
    pvBody.innerHTML = '<div class="azv-pv-empty"><i class="bi ' + icon + '"></i><div>' + _azvEsc(text) + '</div></div>';
  };
  const pvError = msg => {
    clearPreviewUrl(); curCm = null;
    pvBody.innerHTML = '<div class="azv-pv-err"><i class="bi bi-exclamation-triangle"></i><div>' + _azvEsc(msg) + '</div></div>';
  };

  /* 只读 CodeMirror：真正的语法高亮 + 行号（与 IDE 编辑器同一套 mode / 主题）。
     返回 false 表示 CodeMirror 不可用或初始化失败，调用方退回纯文本渲染。 */
  const renderCodeMirror = (text, ext) => {
    if (typeof CodeMirror !== "function") return false;
    pvBody.innerHTML = '<div class="azv-pv-cm"></div>';
    const box = pvBody.querySelector(".azv-pv-cm");
    const light = (typeof window.ideThemeLight === "function") ? window.ideThemeLight() : false;
    let cm = null;
    try {
      cm = CodeMirror(box, {
        value: text,
        mode: "text/plain",                        // 先纯文本立即可见，模式异步套上
        theme: light ? "default" : "material-darker",
        lineNumbers: true, readOnly: true, lineWrapping: wrapOn,
        gutters: ["CodeMirror-linenumbers"], viewportMargin: 30,
        tabSize: 4, indentUnit: 4,
      });
    } catch (_) { return false; }
    curCm = cm;
    if (typeof window.ideEnsureMode === "function") {
      // 模式脚本按扩展名按需加载（go / python / sql …），加载失败就保持纯文本
      Promise.resolve(window.ideEnsureMode(ext)).then(m => {
        if (m && curCm === cm) { cm.setOption("mode", m); cm.refresh(); }
      }).catch(() => {});
    }
    requestAnimationFrame(() => { if (curCm === cm) cm.refresh(); });
    return true;
  };

  // 纯文本兜底（CodeMirror 未加载 / 初始化失败）：行号列 + 正文
  const renderPlainCode = (shown) => {
    const lines = shown.split("\n");
    let gutter = "";
    for (let i = 1; i <= lines.length; i++) gutter += i + (i < lines.length ? "\n" : "");
    pvBody.innerHTML = '<div class="azv-pv-code"><div class="azv-gutter"></div>' +
      '<pre class="azv-pv-text' + (wrapOn ? " wrap" : "") + '"></pre></div>';
    const gEl = pvBody.querySelector(".azv-gutter");
    gEl.textContent = gutter;
    // 换行后一个逻辑行可能占多屏行，行号会错位，这里直接隐藏行号列
    if (wrapOn) gEl.style.display = "none";
    pvBody.querySelector(".azv-pv-text").textContent = shown;
    pvBody.querySelector(".azv-pv-code").scrollTop = 0;
  };

  const httpDownload = (url, dlName) => {
    const a = document.createElement("a");
    a.href = url;
    a.download = dlName;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const previewEntry = (entry, size) => {
    const clean = entry.replace(/\/+$/, "");
    const nm = clean.split("/").pop() || clean;
    const e = (nm.split(".").pop() || "").toLowerCase();
    // 标题图标与列表 / 资源管理器保持一致（seti 图标，模块未加载时退回 bootstrap）
    const headIco = (typeof window.ideIconFor === "function")
      ? window.ideIconFor(nm, false)
      : '<i class="bi bi-file-earmark"></i>';
    pvName.innerHTML = '<span class="azv-ico">' + headIco + '</span>' + _azvEsc(nm) +
      (size ? '<span class="azv-pv-size">' + _azvFmt(size) + '</span>' : "");
    pvAct.innerHTML = '<button class="azv-btn azv-pv-dl" title="下载该文件"><i class="bi bi-download"></i>下载</button>';
    pvAct.querySelector(".azv-pv-dl").onclick = () => {
      const url = "/api/zip/file?zip_path=" + encodeURIComponent(path) + "&entry=" + encodeURIComponent(clean);
      askConfirm(pvAct.querySelector(".azv-pv-dl"), "下载确认", nm + "（" + _azvFmt(size) + "）", "下载")
        .then(ok => { if (ok) httpDownload(url, nm); });
    };
    curCm = null;                                   // 上一个文件的编辑器实例随 DOM 一起丢弃
    pvBody.innerHTML = '<div class="azv-pv-load">正在读取 <b>' + _azvEsc(nm) + '</b> …</div>';
    fetch("/api/zip/preview?zip_path=" + encodeURIComponent(path) + "&entry=" + encodeURIComponent(clean))
      .then(r => r.json())
      .then(d => {
        if (selected !== clean) return;                 // 期间用户已切到别的文件
        if (d.error) { pvError(d.error); return; }
        const bytes = _azvB64ToBytes(d.content);
        const ctype = d.content_type || "";
        if (AZV_IMAGE_EXTS.indexOf(e) >= 0 || ctype.indexOf("image/") === 0) {
          clearPreviewUrl();
          curPreviewUrl = URL.createObjectURL(new Blob([bytes], { type: ctype || "image/*" }));
          pvBody.innerHTML = '<div class="azv-pv-img"><img alt="" src="' + curPreviewUrl + '"></div>';
          return;
        }
        if (AZV_AUDIO_EXTS.indexOf(e) >= 0 || ctype.indexOf("audio/") === 0) {
          clearPreviewUrl();
          curPreviewUrl = URL.createObjectURL(new Blob([bytes], { type: ctype || "audio/mpeg" }));
          pvBody.innerHTML = '<div class="azv-pv-media"><i class="bi bi-music-note-beamed"></i>' +
            '<audio controls preload="metadata" src="' + curPreviewUrl + '"></audio></div>';
          return;
        }
        if (AZV_VIDEO_EXTS.indexOf(e) >= 0 || ctype.indexOf("video/") === 0) {
          clearPreviewUrl();
          curPreviewUrl = URL.createObjectURL(new Blob([bytes], { type: ctype || "video/mp4" }));
          pvBody.innerHTML = '<div class="azv-pv-media"><video controls preload="metadata" src="' + curPreviewUrl + '"></video></div>';
          return;
        }
        if (e === "pdf" || ctype === "application/pdf") {
          clearPreviewUrl();
          curPreviewUrl = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
          pvBody.innerHTML = '<iframe class="azv-pv-pdf" src="' + curPreviewUrl + '"></iframe>';
          return;
        }
        // 文本：按 UTF-8 解码（坏字节替换），用只读 CodeMirror 做语法高亮 + 行号
        if (AZV_TEXT_EXTS.indexOf(e) >= 0 || ctype.indexOf("text/") === 0 || ctype.indexOf("json") >= 0) {
          const txt = new TextDecoder("utf-8").decode(bytes);
          const shown = txt.length > 400000 ? txt.slice(0, 400000) + "\n…（内容过长，已截断）" : txt;
          if (!renderCodeMirror(shown, e)) renderPlainCode(shown);
          return;
        }
        pvError("该类型不支持在线预览（" + (e ? "." + e : "未知类型") + "），可点右上角「下载」用本地程序打开");
      })
      .catch(err => { if (selected === clean) pvError("读取失败：" + ((err && err.message) || err)); });
  };

  /* ---------- 二次确认（复用统一悬浮框，缺失时退回原生 confirm） ---------- */
  function askConfirm(anchor, title, msg, okText) {
    if (typeof window.uiConfirmPop === "function") return window.uiConfirmPop(anchor, { title, msg, okText });
    return Promise.resolve(window.confirm(title + "\n" + msg));
  }

  /* ---------- 列表渲染 ---------- */
  const renderRows = () => {
    const kw = (filterEl.value || "").trim().toLowerCase();
    let list = entries.filter(e => !kw || (e.name || "").toLowerCase().indexOf(kw) >= 0);
    list = list.slice().sort((a, b) => {
      // 目录恒在前
      if (!!a.is_dir !== !!b.is_dir) return a.is_dir ? -1 : 1;
      let r;
      if (sortKey === "size") r = (a.size || 0) - (b.size || 0);
      else r = (a.name || "").localeCompare(b.name || "", "zh-Hans-CN");
      if (sortDesc) r = -r;
      return r;
    });
    if (!list.length) {
      rowsEl.innerHTML = '<div class="azv-empty"><i class="bi bi-inbox"></i>' +
        (kw ? '没有匹配「' + _azvEsc(kw) + '」的条目' : (curDir ? "这个目录是空的" : "压缩包是空的")) + '</div>';
      return;
    }
    rowsEl.innerHTML = list.map((e) => {
      const full = curDir ? curDir + "/" + e.name : e.name;
      const isSel = !e.is_dir && full === selected;
      // 图标与左侧资源管理器同款（seti 图标 + 后台自定义图标映射）；模块未加载时退回 bootstrap 图标
      const ico = (typeof window.ideIconFor === "function")
        ? window.ideIconFor(e.name, !!e.is_dir)
        : (e.is_dir ? '<i class="bi bi-folder2 azv-ico-dir"></i>'
                    : '<i class="bi ' + (e.icon || "bi-file-earmark") + ' azv-ico-file"></i>');
      return '<div class="azv-row' + (isSel ? " cur" : "") + '" data-entry="' + _azvEsc(full) + '"' +
        ' data-dir="' + (e.is_dir ? "1" : "0") + '" data-size="' + (e.size || 0) + '" title="' + _azvEsc(e.name) + '">' +
          '<span class="azv-c-name"><span class="azv-ico">' + ico + '</span>' +
            '<span class="azv-nm">' + _azvEsc(e.name) + '</span></span>' +
          '<span class="azv-c-size">' + (e.is_dir ? (e.is_empty ? "空" : _azvFmt(e.size)) : _azvFmt(e.size)) + '</span>' +
          '<span class="azv-c-comp">' + (e.is_dir ? "" : _azvFmt(e.compressed)) + '</span>' +
        '</div>';
    }).join("");
    rowsEl.querySelectorAll(".azv-row").forEach(row => {
      row.onclick = () => {
        const p = row.dataset.entry;
        if (row.dataset.dir === "1") { load(p); return; }
        selected = p;
        rowsEl.querySelectorAll(".azv-row").forEach(r => r.classList.toggle("cur", r === row));
        previewEntry(p, +row.dataset.size || 0);
      };
    });
  };

  /* ---------- 加载目录 ---------- */
  const setStats = (d) => {
    const n = (d.entries || []).length;
    const head = rowsEl.parentNode.querySelector(".azv-row-head");
    if (head) head.classList.toggle("hidden", !n);
    sortLabel.textContent = sortKey === "size" ? "大小" : "名称";
    sortBtn.classList.toggle("desc", sortDesc);
    sortBtn.querySelector("i").className = sortKey === "size"
      ? "bi bi-sort-numeric-down" : "bi bi-sort-alpha-down";
  };

  function load(dir) {
    const seq = ++loadSeq;
    curDir = (dir || "").replace(/^\/+|\/+$/g, "");
    selected = "";
    renderCrumbs();
    rowsEl.innerHTML = '<div class="azv-load"><i class="bi bi-hourglass-split"></i> 正在读取压缩包…</div>';
    pvEmpty("bi-file-earmark-text", "点左侧文件在这里预览，目录点一下即可进入");
    if (!viewable) {
      rowsEl.innerHTML = '<div class="azv-empty"><i class="bi bi-exclamation-circle"></i>' +
        '暂不支持在线浏览 .' + _azvEsc(ext) + ' 格式，可点右上角「下载」后用本地工具打开<br>' +
        '<span class="azv-empty-sub">当前支持在线浏览：zip / rar</span></div>';
      return;
    }
    const url = "/api/zip/contents?path=" + encodeURIComponent(path) +
      (curDir ? "&dir=" + encodeURIComponent(curDir) : "");
    fetch(url)
      .then(r => r.json())
      .then(d => {
        if (seq !== loadSeq) return;
        if (d.error) {
          rowsEl.innerHTML = '<div class="azv-empty"><i class="bi bi-x-circle"></i>' + _azvEsc(d.error) + '</div>';
          return;
        }
        if (d.zip_size) tab._azvZipSize = d.zip_size;   // 供「下载压缩包」确认框显示大小
        entries = d.entries || [];
        setStats(d);
        renderRows();
      })
      .catch(e => {
        if (seq !== loadSeq) return;
        rowsEl.innerHTML = '<div class="azv-empty"><i class="bi bi-x-circle"></i>读取失败：' + _azvEsc((e && e.message) || e) + '</div>';
      });
  }

  /* ---------- 工具条 ---------- */
  filterEl.addEventListener("input", () => renderRows());

  // 自动换行开关：CodeMirror 直接改选项（其行号栏会跟着折行自动对齐）；兜底纯文本切换 .wrap
  wrapBtn.onclick = () => {
    wrapOn = !wrapOn;
    try { localStorage.setItem("ide.archiveWrap", wrapOn ? "1" : "0"); } catch (_) {}
    syncWrapBtn();
    if (curCm) {
      try { curCm.setOption("lineWrapping", wrapOn); curCm.refresh(); } catch (_) {}
    } else {
      const pre = pvBody.querySelector(".azv-pv-text");
      if (pre) pre.classList.toggle("wrap", wrapOn);
      const gEl = pvBody.querySelector(".azv-gutter");
      if (gEl) gEl.style.display = wrapOn ? "none" : "";   // 兜底渲染下行号会错位，换行时先隐藏
    }
  };
  sortBtn.onclick = () => {
    if (sortKey === "name") { sortKey = "size"; sortDesc = true; }
    else if (sortDesc) { sortDesc = false; }
    else { sortKey = "name"; sortDesc = false; }
    sortLabel.textContent = sortKey === "size" ? "大小" : "名称";
    sortBtn.querySelector("i").className = sortKey === "size" ? "bi bi-sort-numeric-down" : "bi bi-sort-alpha-down";
    renderRows();
  };

  // 下载整个压缩包（二次确认）
  dlBtn.onclick = () => {
    askConfirm(dlBtn, "下载压缩包", fileName + "（" + _azvFmt(tab._azvZipSize || 0) + "）", "下载")
      .then(ok => { if (ok) httpDownload("/api/download?path=" + encodeURIComponent(path), fileName); });
  };

  // 解压到压缩包所在目录（仅 zip；rar 后端只支持浏览/预览）
  if (ext !== "zip") {
    extractBtn.disabled = true;
    extractBtn.title = "仅 zip 支持一键解压；rar / 其它格式请下载后解压";
  }
  extractBtn.onclick = () => {
    if (ext !== "zip" || extractBtn.disabled) return;
    askConfirm(extractBtn, "解压确认", "把 " + fileName + " 解压到它所在的目录？同名目录会自动加序号。", "开始解压")
      .then(ok => {
        if (!ok) return;
        const old = extractBtn.innerHTML;
        extractBtn.disabled = true;
        extractBtn.innerHTML = '<i class="bi bi-hourglass-split"></i>解压中…';
        fetch("/api/zip/unzip", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: path }),
        })
          .then(r => r.json())
          .then(d => {
            if (d.error) { azvToast("解压失败：" + d.error, "err"); return; }
            azvToast("解压完成：" + (d.path || "") + "（" + (d.files || 0) + " 个文件）", "ok");
          })
          .catch(e => azvToast("解压失败：" + ((e && e.message) || e), "err"))
          .finally(() => {
            extractBtn.disabled = false;
            extractBtn.innerHTML = old;
          });
      });
  };

  /* ---------- 键盘：Backspace / Alt+← 返回上级 ---------- */
  const keyHandler = e => {
    if (!host.isConnected || !host.classList.contains("active")) return;
    const tag = (e.target && e.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select" || (e.target && e.target.isContentEditable)) return;
    const back = e.key === "Backspace" || (e.altKey && e.key === "ArrowLeft");
    if (!back || !curDir) return;
    e.preventDefault(); e.stopPropagation();
    load(curDir.indexOf("/") >= 0 ? curDir.slice(0, curDir.lastIndexOf("/")) : "");
  };
  document.addEventListener("keydown", keyHandler, true);
  _azvCleanups.push(() => document.removeEventListener("keydown", keyHandler, true));

  /* ---------- 尺寸自适应：窄屏时预览区改为下方 ---------- */
  let resizeTimer = null;
  const onResize = () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!host.isConnected) return;
      $(".azv-wrap").classList.toggle("azv-narrow", host.clientWidth < 720);
      if (curCm) { try { curCm.refresh(); } catch (_) {} }
    }, 120);
  };
  window.addEventListener("resize", onResize);
  onResize();
  _azvCleanups.push(() => {
    window.removeEventListener("resize", onResize);
    clearTimeout(resizeTimer);
  });

  /* ---------- 首次加载（压缩包大小随列表接口一起拿到） ---------- */
  renderCrumbs();
  load("");

  // 从别的标签切回来时刷新只读编辑器：隐藏期间创建 / 容器尺寸变化会导致行号与内容错位
  tab.onActivate = () => { if (curCm) { try { curCm.refresh(); } catch (_) {} } };

  /* ---------- 标签关闭时释放 blob / 监听 ---------- */
  const cleanup = () => {
    clearPreviewUrl();
    curCm = null;
    if (tab.onActivate) tab.onActivate = null;
    _azvCleanupRun();
  };
  if (host._azvObserver) { try { host._azvObserver.disconnect(); } catch (_) {} }
  const cleanObserver = new MutationObserver(() => {
    if (!host.isConnected) { cleanObserver.disconnect(); cleanup(); }
  });
  host._azvObserver = cleanObserver;
  if (host.parentNode) cleanObserver.observe(host.parentNode, { childList: true });
}

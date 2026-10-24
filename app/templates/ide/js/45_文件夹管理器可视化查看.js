/* ==================================================================
   文件夹管理器可视化查看（编辑器区域标签页）
     · 本机模式（虚拟路径 \u0000fm）：浏览 File_Flask 所在服务器的文件系统；
     · 远程模式（虚拟路径 \u0000sshfm:<连接id>）：在 SSH 连接上打开，
       经后端 SFTP（/api/ssh/fs/*，实现见 routes/ide/sshfile.py）浏览
       远程主机的文件系统，可同时打开多台主机（每个标签独立状态）；
     · 两种模式共用一套 UI：网格 / 列表视图、前进后退、路径跳转、面包屑、
       隐藏文件、图片缩略图、下载、复制路径；远程模式额外支持
       新建文件夹 / 重命名 / 删除 / 上传，双击文件打开远程文件查看器；
     · 远程文件查看器（\u0000sshfile:<连接id>:<绝对路径>）：CodeMirror 编辑，
       Ctrl+S / 工具行保存按钮写回远程（≤4MB 文本）；
     · 会话恢复：本机目录、远程目录、远程文件标签刷新后原样重开；
     · 须放在 16_（关闭大 IIFE）之前，复用闭包内的 $ / esc / escAttr / toast /
       apiFiles / iconFor / getExt / openFile / findTab / activate / renderTabsAll /
       uiConfirm / uiPrompt / copyText / ensureMode 等。
   ================================================================== */
const FM_VIEW_PATH = "\u0000fm";                 // 本机模式
const FM_SSHFM_PREFIX = "\u0000sshfm:";          // 远程文件管理器：<连接id>
const FM_SSHFILE_PREFIX = "\u0000sshfile:";      // 远程文件查看器：<连接id>:<绝对路径>
const FM_PATH_KEY = "ide.fmView.path";           // 本机模式：上次浏览的目录
const FM_MODE_KEY = "ide.fmView.mode";           // grid | list（两种模式共用偏好）
const FM_HIDDEN_KEY = "ide.fmView.hidden";       // 是否显示隐藏文件（共用偏好）
const FM_CONNS_CACHE = { list: null, ts: 0 };
const FM_IMG_EXTS = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg", "avif"];

/* 全局视图偏好（模式 / 隐藏开关），新开标签时继承 */
const FM_PREFS = { mode: "grid", hidden: false };
try { FM_PREFS.mode = localStorage.getItem(FM_MODE_KEY) === "list" ? "list" : "grid"; } catch (_) {}
try { FM_PREFS.hidden = localStorage.getItem(FM_HIDDEN_KEY) === "1"; } catch (_) {}
/* 本机模式：上次浏览目录（远程目录按连接 id 另存） */
try { var FM_LAST_LOCAL = localStorage.getItem(FM_PATH_KEY) || ""; } catch (_) { var FM_LAST_LOCAL = ""; }

function fmJoin(dir, name) { return dir.replace(/\/+$/, "") + "/" + name; }
function fmParent(p) {
  const s = String(p || "").replace(/\/+$/, "");
  if (!s || s === "/") return null;
  const i = s.lastIndexOf("/");
  return i <= 0 ? "/" : s.slice(0, i);
}
function fmIsImg(name) { return FM_IMG_EXTS.includes(getExt(String(name || "").toLowerCase())); }
/* 目录列表：本机走 /api/files（counts=1 附带子项计数），远程走 /api/ssh/fs/list */
async function fmFetch(fm, path, showHidden) {
  if (fm.conn) {
    const r = await fetch("/api/ssh/fs/list", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: fm.conn.id, path: path, hidden: showHidden ? 1 : 0 }),
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    if (!fm.home && d.home) fm.home = d.home;
    return d;
  }
  const url = "/api/files?path=" + encodeURIComponent(path) +
    (showHidden ? "&hidden=1" : "") + "&counts=1";
  const r = await fetch(url);
  const d = await r.json();
  if (d.error) throw new Error(d.error);
  return d;
}
/* SSH 连接列表（侧栏与远程模式共用一份缓存，30 秒过期） */
async function fmConns() {
  if (FM_CONNS_CACHE.list && Date.now() - FM_CONNS_CACHE.ts < 30000) return FM_CONNS_CACHE.list;
  const r = await fetch("/api/ssh/list");
  const d = await r.json();
  if (d.error) throw new Error(d.error);
  FM_CONNS_CACHE.list = d.connections || [];
  FM_CONNS_CACHE.ts = Date.now();
  return FM_CONNS_CACHE.list;
}

/* ---------- 打开本机 / 远程文件管理器标签 ---------- */
function _fmMakeTab(conn, startPath) {
  const remote = !!conn;
  const vpath = remote ? FM_SSHFM_PREFIX + conn.id : FM_VIEW_PATH;
  const existed = findTab(vpath);
  if (existed) return existed;
  const host = document.createElement("div");
  host.className = "cm-host fm-view-host";
  host.innerHTML =
    '<div class="fmv">' +
      '<div class="fmv-tools">' +
        '<button class="g-ico" data-fm="back" title="后退"><i class="bi bi-arrow-left"></i></button>' +
        '<button class="g-ico" data-fm="fwd" title="前进"><i class="bi bi-arrow-right"></i></button>' +
        '<button class="g-ico" data-fm="up" title="上级目录"><i class="bi bi-arrow-bar-up"></i></button>' +
        '<button class="g-ico" data-fm="home" title="' + (remote ? "回到根目录 /" : "回到项目根目录") + '"><i class="bi bi-house"></i></button>' +
        '<input class="fmv-path" spellcheck="false" autocomplete="off" title="输入绝对路径后回车跳转">' +
        '<button class="g-ico" data-fm="refresh" title="刷新"><i class="bi bi-arrow-clockwise"></i></button>' +
        '<button class="g-ico" data-fm="hidden" title="显示 / 隐藏隐藏文件"><i class="bi bi-eye-slash"></i></button>' +
        '<button class="g-ico" data-fm="mode" title="切换 网格 / 列表 视图"><i class="bi bi-list-ul"></i></button>' +
        (remote ? '<button class="g-ico" data-fm="mkdir" title="新建文件夹"><i class="bi bi-folder-plus"></i></button>' +
                  '<button class="g-ico" data-fm="upload" title="上传文件到当前目录"><i class="bi bi-upload"></i></button>' : "") +
      '</div>' +
      '<div class="fmv-crumbs"></div>' +
      '<div class="fmv-body scroll-thin"><div class="fmv-ph">正在加载…</div></div>' +
      '<div class="fmv-status">—</div>' +
      (remote
        ? '<div class="fmv-drop" style="display:none"><i class="bi bi-cloud-arrow-up"></i><span class="fmv-drop-t">松开加入上传列表</span></div>' +
          '<div class="fmv-upmask" style="display:none">' +
            '<div class="fmv-up">' +
              '<div class="fmv-up-hd"><div class="fmv-up-title">上传文件到 <span class="fmv-up-path"></span></div>' +
                '<div class="fmv-up-sub">文件夹保持目录结构 · 同名覆盖 · 拖拽可直接加入列表</div>' +
                '<button class="g-ico fmv-up-x" title="关闭"><i class="bi bi-x-lg"></i></button></div>' +
              '<div class="fmv-up-tools">' +
                '<button class="g-btn outline" data-up="files"><i class="bi bi-plus-lg"></i> 上传文件</button>' +
                '<button class="g-btn outline" data-up="dirs"><i class="bi bi-folder-plus"></i> 上传文件夹</button>' +
                '<span class="fmv-up-flex"></span>' +
                '<button class="g-ico" data-up="clear" title="清空列表"><i class="bi bi-trash"></i> 清空列表</button>' +
              '</div>' +
              '<div class="fmv-up-list scroll-thin">' +
                '<div class="fmv-up-head"><span class="u-nm">文件名</span><span class="u-sz">文件大小</span><span class="u-st">上传状态</span><span class="u-op">操作</span></div>' +
                '<div class="fmv-up-rows"></div>' +
              '</div>' +
              '<div class="fmv-up-ft"><div class="fmv-up-prog" style="display:none"><i></i></div><span class="fmv-up-sum"></span><button class="g-btn fmv-up-start" disabled>开始上传</button></div>' +
              '<input type="file" class="fmv-file" style="display:none" multiple>' +
              '<input type="file" class="fmv-dirfile" style="display:none" webkitdirectory>' +
            '</div>' +
          '</div>'
        : "") +
    '</div>';
  const dw = (typeof currentWrap === "function") ? currentWrap() : null;
  (dw || edGroups).appendChild(host);
  const fm = {
    conn: remote ? { id: conn.id, name: conn.name, host: conn.host, user: conn.user } : null,
    path: "", home: "",
    mode: FM_PREFS.mode, hidden: FM_PREFS.hidden,
    items: [], back: [], fwd: [], sel: "", loading: false, seq: 0,
  };
  const tab = {
    path: vpath, host: host, cm: null, original: "", dirty: false,
    group: curGroup, fm: fm,
    name: remote ? (conn.name || conn.host) : "文件夹管理器",
    displayPath: remote ? ("文件管理器 · " + (conn.user || "root") + "@" + conn.host) : "文件夹管理器",
    relPath: "",
    iconHtml: remote
      ? '<i class="bi bi-folder2-open" style="color:#e2a04a"></i>'
      : '<i class="bi bi-folder2-open" style="color:#c09553"></i>',
  };
  tab.onBeforeClose = () => {
    try {
      if (remote) localStorage.setItem("ide.fmView.rpath:" + conn.id, fm.path);
      else { FM_LAST_LOCAL = fm.path; localStorage.setItem(FM_PATH_KEY, fm.path); }
    } catch (_) {}
    return true;
  };
  fmBindTab(tab);
  tabs.push(tab);
  renderTabsAll();
  return tab;
}

function openFolderManagerView(conn, startPath) {
  const tab = _fmMakeTab(conn, startPath);
  activate(tab);
  const fm = tab.fm;
  const initial = startPath || fm.path ||
    (fm.conn ? (() => { try { return localStorage.getItem("ide.fmView.rpath:" + fm.conn.id) || ""; } catch (_) { return ""; } })() : FM_LAST_LOCAL) ||
    (fm.conn ? "" : (ROOT || "/"));
  fmNavigate(tab, initial, { noPush: true });
  return tab;
}
/* 会话恢复用：按连接 id 找回 SSH 连接并重开远程文件管理器 */
async function openSshFileManagerById(cid) {
  try {
    const conns = await fmConns();
    const c = conns.find(x => x.id === cid);
    if (c) { openFolderManagerView(c); return; }
  } catch (e) { /* 连接可能已被删除 */ }
  toast("找不到对应的 SSH 连接（可能已删除），无法恢复文件管理器标签", "warn");
}
function fmViewOpen() {
  return tabs.some(t => t && t.fm);
}

/* ---------- 每个标签的事件绑定（元素都在各自 host 内，按 tab 作用域查询） ---------- */
function fmQ(tab, sel) { return tab.host.querySelector(sel); }
function fmBindTab(tab) {
  const fm = tab.fm;
  const on = (key, fn) => { const el = fmQ(tab, '[data-fm="' + key + '"]'); if (el) el.onclick = fn; };
  on("back", () => {
    if (!fm.back.length) return;
    fm.fwd.push(fm.path);
    fmNavigate(tab, fm.back.pop(), { noPush: true });
  });
  on("fwd", () => {
    if (!fm.fwd.length) return;
    fm.back.push(fm.path);
    fmNavigate(tab, fm.fwd.pop(), { noPush: true });
  });
  on("up", () => { const p = fmParent(fm.path); if (p) fmNavigate(tab, p); });
  on("home", () => fmNavigate(tab, fm.conn ? "/" : (ROOT || "/")));
  on("refresh", () => fmNavigate(tab, fm.path, { noPush: true }));
  on("hidden", () => {
    fm.hidden = !fm.hidden;
    FM_PREFS.hidden = fm.hidden;
    try { localStorage.setItem(FM_HIDDEN_KEY, fm.hidden ? "1" : "0"); } catch (_) {}
    fmNavigate(tab, fm.path, { noPush: true });
  });
  on("mode", () => {
    fm.mode = fm.mode === "grid" ? "list" : "grid";
    FM_PREFS.mode = fm.mode;
    try { localStorage.setItem(FM_MODE_KEY, fm.mode); } catch (_) {}
    fmPaint(tab);
  });
  on("mkdir", () => fmRemoteMkdir(tab));
  on("upload", () => fmUpOpen(tab));
  if (fm.conn) {
    fmBindDrag(tab);
    fmUpBind(tab);
  }
  /* 文件管理器区域内右键：不弹编辑器菜单（条目上的右键已在上面自行处理并阻断冒泡） */
  const fmRoot = tab.host.querySelector(".fmv");
  if (fmRoot) fmRoot.addEventListener("contextmenu", (e) => { e.preventDefault(); e.stopPropagation(); });
  const inp = fmQ(tab, ".fmv-path");
  if (inp) inp.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const v = inp.value.trim();
    if (v) fmNavigate(tab, v);
  });
  const body = fmQ(tab, ".fmv-body");
  if (body) body.addEventListener("click", (e) => {
    if (e.target === body || e.target.classList.contains("fmv-grid") || e.target.classList.contains("fmv-list")) {
      fm.sel = ""; fmPaintSel(tab);
    }
  });
  /* 切回本标签时刷新（目录可能在别处被改动） */
  tab.onFmActivate = () => {
    if (!fm.loading && fm.path) fmNavigate(tab, fm.path, { noPush: true });
  };
}

/* ---------- 导航 ---------- */
async function fmNavigate(tab, path, opts) {
  if (!tab || !tab.fm) return;
  const fm = tab.fm;
  if (path === undefined || path === null || path === "") path = fm.conn ? (fm.home || ".") : "/";
  opts = opts || {};
  if (!opts.noPush && path !== fm.path) {
    if (fm.path) fm.back.push(fm.path);
    fm.fwd.length = 0;
  }
  const seq = ++fm.seq;
  fm.loading = true;
  fmPaintNav(tab);
  const body = fmQ(tab, ".fmv-body");
  if (body) body.innerHTML = '<div class="fmv-ph">正在加载…</div>';
  try {
    const d = await fmFetch(fm, path, fm.hidden);
    if (seq !== fm.seq) return;               // 已有更新的请求，丢弃过期结果
    fm.path = d.current_path_abs || d.current_path || path;
    if (d.home) fm.home = d.home;
    fm.items = (d.items || []).slice();
    fm.sel = "";
    fm.loading = false;
    fmPaintNav(tab); fmPaintCrumbs(tab); fmPaint(tab);
  } catch (e) {
    if (seq !== fm.seq) return;
    fm.loading = false;
    fmPaintNav(tab);
    if (body) body.innerHTML = '<div class="fmv-ph">加载失败：' + esc(e.message || String(e)) + '</div>';
    toast("打开目录失败：" + (e.message || e), "err");
  }
}
function fmPaintNav(tab) {
  const fm = tab.fm;
  const inp = fmQ(tab, ".fmv-path");
  if (inp && document.activeElement !== inp) inp.value = fm.path;
  const back = fmQ(tab, '[data-fm="back"]'), fwd = fmQ(tab, '[data-fm="fwd"]'), up = fmQ(tab, '[data-fm="up"]');
  if (back) back.disabled = !fm.back.length;
  if (fwd) fwd.disabled = !fm.fwd.length;
  if (up) up.disabled = !fmParent(fm.path);
  const hid = fmQ(tab, '[data-fm="hidden"]');
  if (hid) hid.classList.toggle("on", fm.hidden);
  fmPaintModeBtn(tab);
}
function fmPaintModeBtn(tab) {
  const fm = tab.fm;
  const btn = fmQ(tab, '[data-fm="mode"]');
  if (!btn) return;
  btn.innerHTML = fm.mode === "grid" ? '<i class="bi bi-list-ul"></i>' : '<i class="bi bi-grid-3x3-gap"></i>';
  btn.title = fm.mode === "grid" ? "切换到列表视图" : "切换到网格视图";
  const body = fmQ(tab, ".fmv-body");
  if (body) body.classList.toggle("as-list", fm.mode === "list");
}

/* ---------- 面包屑（远程模式带 user@host 前缀） ---------- */
function fmPaintCrumbs(tab) {
  const fm = tab.fm;
  const box = fmQ(tab, ".fmv-crumbs");
  if (!box) return;
  const p = fm.path || "/";
  const parts = p.split("/").filter(Boolean);
  let acc = "";
  const mk = (label, target, icon) =>
    '<span class="fmv-crumb" data-p="' + escAttr(target) + '">' + (icon || "") + esc(label) + "</span>";
  let html = fm.conn
    ? '<span class="fmv-host"><i class="bi bi-hdd-network"></i>' + esc(fm.conn.user || "root") + "@" + esc(fm.conn.host) + '</span>'
    : mk("/", "/", '<i class="bi bi-hdd"></i>');
  parts.forEach((seg) => {
    acc += "/" + seg;
    html += '<i class="bi bi-chevron-right fmv-sep"></i>' + mk(seg, acc);
  });
  box.innerHTML = html;
  box.querySelectorAll(".fmv-crumb").forEach((el) => {
    el.onclick = () => fmNavigate(tab, el.dataset.p);
  });
}

/* ---------- 列表渲染 ---------- */
function fmItemIcon(it) {
  if (it.is_dir) return iconFor(it.name, true);
  return iconFor(it.name, false);   // 图片在网格视图另走缩略图
}
function fmItemSub(tab, it) {
  const fm = tab.fm;
  if (it.is_dir) {
    if (!fm.conn && (typeof it.n_dirs === "number" || typeof it.n_files === "number"))
      return (it.n_dirs || 0) + " 个文件夹 · " + (it.n_files || 0) + " 个文件";
    return "文件夹";
  }
  return it.size_str || "";
}
function fmOpenItem(tab, it) {
  const fm = tab.fm;
  const full = fmJoin(fm.path, it.name);
  if (it.is_dir) { fmNavigate(tab, full); return; }
  if (fm.conn) { openSshFileViewer(fm.conn, full, it.name); return; }
  openFile(full, it.name).catch((e) => toast("打开失败：" + (e.message || e), "err"));
}
function fmItemSrc(fm, it) {
  return fm.conn
    ? "/api/ssh/fs/raw?id=" + encodeURIComponent(fm.conn.id) + "&path=" + encodeURIComponent(fmJoin(fm.path, it.name))
    : "/api/preview?path=" + encodeURIComponent(fmJoin(fm.path, it.name)) + "&raw=1";
}
function fmDownloadHref(fm, it) {
  const full = fmJoin(fm.path, it.name);
  return fm.conn
    ? "/api/ssh/fs/download?id=" + encodeURIComponent(fm.conn.id) + "&path=" + encodeURIComponent(full)
    : "/api/download?path=" + encodeURIComponent(full);
}
/* ---------- 下载：二次确认悬浮框（右键菜单入口） ---------- */
function fmConfirmDownload(tab, it, anchor, at) {
  const fm = tab.fm;
  const sizeTxt = it.size_str || (it.is_dir ? "文件夹" : fmFmtBytes(it.size));
  uiConfirmPop(anchor || document.body, {
    title: "下载确认",
    msg: (fm.conn ? (fm.conn.user || "root") + "@" + fm.conn.host + " · " : "") +
         fmJoin(fm.path, it.name) + "（" + sizeTxt + "）",
    okText: "下载",
    at: at || null,
  }).then((ok) => {
    if (!ok) return;
    const a = document.createElement("a");
    a.href = fmDownloadHref(fm, it);
    a.download = it.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  });
}
/* ---------- 右键菜单（自建轻量版，本机 / 远程通用） ---------- */
function fmCloseCtx() {
  const el = document.getElementById("fmCtxMenu");
  if (el) el.remove();
  document.removeEventListener("mousedown", _fmCtxDoc, true);
  document.removeEventListener("keydown", _fmCtxKey, true);
}
function _fmCtxDoc(e) {
  const el = document.getElementById("fmCtxMenu");
  if (el && !el.contains(e.target)) fmCloseCtx();
}
function _fmCtxKey(e) { if (e.key === "Escape") fmCloseCtx(); }
function fmCtxMenu(tab, it, x, y, anchor) {
  const fm = tab.fm;
  fmCloseCtx();
  const items = [
    { ico: it.is_dir ? "bi-folder2-open" : "bi-pencil-square", label: it.is_dir ? "进入" : (fm.conn ? "打开" : "用编辑器打开"), fn: () => fmOpenItem(tab, it) },
  ];
  if (!it.is_dir) items.push({ ico: "bi-download", label: "下载…", fn: (at) => fmConfirmDownload(tab, it, anchor, at) });
  items.push({ ico: "bi-clipboard", label: "复制路径", fn: () => {
    Promise.resolve(copyText(fmJoin(fm.path, it.name))).then(() => toast("已复制路径", "ok")).catch(() => toast("复制失败", "err"));
  } });
  if (fm.conn) {
    items.push({ ico: "bi-pencil", label: "重命名", fn: () => fmRemoteRename(tab, it) });
    items.push({ ico: "bi-files", label: "复制到…", fn: () => fmRemoteTransfer(tab, it, "copy") });
    items.push({ ico: "bi-box-arrow-in-right", label: "移动到…", fn: () => fmRemoteTransfer(tab, it, "move") });
    items.push({ ico: "bi-trash", label: "删除", danger: true, fn: () => fmRemoteDelete(tab, it) });
  }
  const menu = document.createElement("div");
  menu.className = "fm-ctx";
  menu.id = "fmCtxMenu";
  menu.innerHTML = items.map((m, i) =>
    '<button class="fm-ctx-i' + (m.danger ? " danger" : "") + '" data-i="' + i + '">' +
    '<i class="bi ' + m.ico + '"></i>' + esc(m.label) + '</button>').join("");
  document.body.appendChild(menu);
  const pw = menu.offsetWidth, ph = menu.offsetHeight;
  menu.style.left = Math.max(6, Math.min(x, window.innerWidth - pw - 8)) + "px";
  menu.style.top = Math.max(6, Math.min(y, window.innerHeight - ph - 8)) + "px";
  menu.querySelectorAll(".fm-ctx-i").forEach((btn) => {
    btn.onclick = () => {
      const m = items[Number(btn.dataset.i)];
      // 先记录菜单位置（关闭后 getBoundingClientRect 会失效），确认框从菜单右侧弹出
      const br = btn.getBoundingClientRect(), mr = menu.getBoundingClientRect();
      const at = { left: mr.right + 6, top: br.top - 4 };
      fmCloseCtx();
      if (m) m.fn(at);
    };
  });
  document.addEventListener("mousedown", _fmCtxDoc, true);
  document.addEventListener("keydown", _fmCtxKey, true);
}
function fmBindItem(tab, el, it) {
  const fm = tab.fm;
  const doOpen = () => fmOpenItem(tab, it);
  el.onclick = () => {
    fm.sel = it.name; fmPaintSel(tab);
    doOpen();                                   // 单击即打开 / 进入（操作统一走右键菜单）
  };
  el.oncontextmenu = (e) => {
    e.preventDefault();
    e.stopPropagation();                        // 阻断冒泡到 edGroups，避免同时弹出编辑器右键菜单
    fm.sel = it.name; fmPaintSel(tab);
    fmCtxMenu(tab, it, e.clientX, e.clientY, el);
  };
}
function fmPaint(tab) {
  const fm = tab.fm;
  const body = fmQ(tab, ".fmv-body");
  if (!body) return;
  fmPaintModeBtn(tab);
  if (!fm.items.length) {
    body.innerHTML = '<div class="fmv-ph">此目录为空</div>';
    fmPaintStatus(tab);
    return;
  }
  if (fm.mode === "grid") {
    let html = '<div class="fmv-grid">';
    fm.items.forEach((it) => {
      const thumb = (!it.is_dir && fmIsImg(it.name))
        ? '<span class="fmv-thumb"><img loading="lazy" alt="" src="' + fmItemSrc(fm, it) + '"></span>'
        : '<span class="fmv-ic">' + fmItemIcon(it) + '</span>';
      html += '<div class="fmv-cell" data-n="' + escAttr(it.name) + '">' +
        thumb +
        '<span class="fmv-nm" title="' + escAttr(it.name) + '">' + esc(it.name) + '</span>' +
        '<span class="fmv-sub">' + esc(fmItemSub(tab, it)) + '</span>' +
        '</div>';
    });
    body.innerHTML = html + '</div>';
    body.querySelectorAll(".fmv-cell").forEach((el) => {
      const it = fm.items.find(x => x.name === el.dataset.n);
      if (it) fmBindItem(tab, el, it);
    });
  } else {
    let html = '<div class="fmv-list">' +
      '<div class="fmv-row fmv-head"><span class="c-nm">名称</span><span class="c-sz">大小</span><span class="c-mt">修改时间</span><span class="c-ty">类型</span></div>';
    fm.items.forEach((it) => {
      html += '<div class="fmv-row fmv-item" data-n="' + escAttr(it.name) + '">' +
        '<span class="c-nm"><span class="fmv-ic-sm">' + fmItemIcon(it) + '</span>' + esc(it.name) + '</span>' +
        '<span class="c-sz">' + esc(it.is_dir ? "—" : (it.size_str || "")) + '</span>' +
        '<span class="c-mt">' + esc(it.mtime || "") + '</span>' +
        '<span class="c-ty">' + esc((it.type || "") + (it.is_link ? " (链接)" : "")) + '</span>' +
        '</div>';
    });
    body.innerHTML = html + '</div>';
    body.querySelectorAll(".fmv-item").forEach((el) => {
      const it = fm.items.find(x => x.name === el.dataset.n);
      if (it) fmBindItem(tab, el, it);
    });
  }
  fmPaintSel(tab);
  fmPaintStatus(tab);
}
function fmPaintSel(tab) {
  const fm = tab.fm;
  const body = fmQ(tab, ".fmv-body");
  if (!body) return;
  body.querySelectorAll(".fmv-cell,.fmv-item").forEach((el) => {
    el.classList.toggle("sel", el.dataset.n === fm.sel);
  });
}
function fmPaintStatus(tab) {
  const fm = tab.fm;
  const el = fmQ(tab, ".fmv-status");
  if (!el) return;
  if (fm.loading) { el.textContent = "加载中…"; return; }
  const dirs = fm.items.filter(x => x.is_dir).length;
  const files = fm.items.length - dirs;
  el.textContent = "共 " + fm.items.length + " 项：" + dirs + " 个文件夹 · " + files + " 个文件";
}

/* ---------- 远程操作：新建文件夹 / 重命名 / 删除 / 上传 ---------- */
async function fmSshApi(action, payload) {
  const r = await fetch("/api/ssh/fs/" + action, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error);
  return d;
}
async function fmRemoteMkdir(tab) {
  const fm = tab.fm;
  if (!fm.conn) return;
  const name = await uiPrompt("新建文件夹（" + (fm.conn.user || "root") + "@" + fm.conn.host + "）", "新建文件夹", "文件夹名称");
  if (name === null || !name.trim()) return;
  try {
    await fmSshApi("mkdir", { id: fm.conn.id, path: fmJoin(fm.path, name.trim()) });
    toast("已创建", "ok");
    fmNavigate(tab, fm.path, { noPush: true });
  } catch (e) { toast("创建失败：" + (e.message || e), "err"); }
}
async function fmRemoteRename(tab, it) {
  const fm = tab.fm;
  const name = await uiPrompt("重命名", it.name, "新的名称");
  if (name === null || !name.trim() || name.trim() === it.name) return;
  try {
    await fmSshApi("rename", { id: fm.conn.id, path: fmJoin(fm.path, it.name), name: name.trim() });
    toast("已重命名", "ok");
    fmNavigate(tab, fm.path, { noPush: true });
  } catch (e) { toast("重命名失败：" + (e.message || e), "err"); }
}
async function fmRemoteDelete(tab, it) {
  const fm = tab.fm;
  const ok = await uiConfirm("删除" + (it.is_dir ? "文件夹" : "文件"),
    "确定删除远程主机上的 " + it.name + (it.is_dir ? "（含全部内容，不可恢复）" : "") + "？",
    "删除", true);
  if (!ok) return;
  try {
    await fmSshApi("delete", { id: fm.conn.id, path: fmJoin(fm.path, it.name) });
    toast("已删除", "ok");
    fmNavigate(tab, fm.path, { noPush: true });
  } catch (e) { toast("删除失败：" + (e.message || e), "err"); }
}
/* 复制 / 移动到指定目录（后端 /api/ssh/fs/copy、/api/ssh/fs/move，to=目标目录绝对路径） */
async function fmRemoteTransfer(tab, it, action) {
  const fm = tab.fm;
  if (!fm.conn) return;
  const label = action === "copy" ? "复制" : "移动";
  const to = await uiPrompt(
    label + "「" + it.name + "」到（" + (fm.conn.user || "root") + "@" + fm.conn.host + "）",
    fm.path, "目标目录的绝对路径，如 /www/wwwroot");
  if (to === null || !to.trim()) return;
  try {
    const d = await fmSshApi(action, { id: fm.conn.id, path: fmJoin(fm.path, it.name), to: to.trim() });
    toast("已" + label + "到 " + d.path, "ok");
    fmNavigate(tab, fm.path, { noPush: true });   // 刷新当前目录（移动后条目消失 / 复制不变）
  } catch (e) { toast(label + "失败：" + (e.message || e), "err"); }
}
/* ---------- 上传列表对话框（参考桌面文件管理器：先入列表，点「开始上传」才真正上传） ---------- */
const FM_UP_ST = { WAIT: "待上传", RUN: "上传中", OK: "已上传", FAIL: "失败" };
function fmUpEnsure(tab) {
  if (!tab.fmUp) tab.fmUp = { list: [], seq: 0, busy: false, runIds: [] };
  const mask = tab.host.querySelector(".fmv-upmask");
  if (!mask) return;
  if (mask.dataset.bound === "1") return;   // 只绑定一次（重复 onclick 赋值也无害，这里省事）
  mask.dataset.bound = "1";
  mask.querySelector(".fmv-up-x").onclick = () => { if (!tab.fmUp.busy) mask.style.display = "none"; };
  mask.onclick = (e) => { if (e.target === mask && !tab.fmUp.busy) mask.style.display = "none"; };
  mask.querySelector('[data-up="files"]').onclick = () => tab.host.querySelector(".fmv-file").click();
  mask.querySelector('[data-up="dirs"]').onclick = () => tab.host.querySelector(".fmv-dirfile").click();
  mask.querySelector('[data-up="clear"]').onclick = () => {
    if (tab.fmUp.busy) return;
    tab.fmUp.list = [];
    fmUpPaint(tab);
  };
  mask.querySelector(".fmv-up-start").onclick = () => fmUpStart(tab);
  const fi = tab.host.querySelector(".fmv-file"), di = tab.host.querySelector(".fmv-dirfile");
  const onPick = (input, withPath) => () => {
    const files = Array.from(input.files || []);
    input.value = "";
    if (!files.length) return;
    fmUpAdd(tab, files.map((f) => ({
      file: f,
      rel: (withPath && f.webkitRelativePath) ? f.webkitRelativePath : f.name,
    })));
  };
  fi.onchange = onPick(fi, false);
  di.onchange = onPick(di, true);
}
function fmUpOpen(tab) {
  fmUpEnsure(tab);
  const mask = tab.host.querySelector(".fmv-upmask");
  if (!mask) return;
  mask.style.display = "flex";
  fmUpPaint(tab);
}
/* 把一批 {file, rel} 加入上传列表并弹出对话框（拖拽与手动选择共用） */
function fmUpAdd(tab, list) {
  fmUpEnsure(tab);
  const st = tab.fmUp;
  const dirs = new Set();
  list.forEach((x) => {
    st.seq++;
    const i = x.rel.lastIndexOf("/");
    if (i > 0) dirs.add(x.rel.slice(0, i));
    st.list.push({ id: st.seq, file: x.file, rel: x.rel, status: FM_UP_ST.WAIT });
  });
  fmUpOpen(tab);
  toast("已加入上传列表：共 " + list.length + " 个文件" +
    (dirs.size ? "、" + dirs.size + " 个文件夹，保持目录结构" : "") +
    "，点击「开始上传」", "info");
}
function fmUpPaint(tab) {
  const st = tab.fmUp;
  const fm = tab.fm;
  const mask = tab.host.querySelector(".fmv-upmask");
  if (!mask) return;
  mask.querySelector(".fmv-up-path").textContent = fm.path;
  const rows = mask.querySelector(".fmv-up-rows");
  const stCls = { [FM_UP_ST.WAIT]: "", [FM_UP_ST.RUN]: "run", [FM_UP_ST.OK]: "ok", [FM_UP_ST.FAIL]: "fail" };
  rows.innerHTML = st.list.map((x) =>
    '<div class="fmv-up-row" data-id="' + x.id + '">' +
      '<span class="u-nm" title="' + escAttr(x.rel) + '">' + esc(x.rel) + '</span>' +
      '<span class="u-sz">' + esc(fmFmtBytes(x.file.size)) + '</span>' +
      '<span class="u-st ' + (stCls[x.status] || "") + '">' +
        esc(x.status === FM_UP_ST.RUN && x.pct ? Math.round(x.pct * 100) + "%" : x.status) + '</span>' +
      '<span class="u-op">' + (x.status === FM_UP_ST.RUN
        ? '<span class="u-dis">…</span>'
        : '<button class="u-del" data-del="' + x.id + '">移除</button>') + '</span>' +
    '</div>').join("") ||
    '<div class="fmv-up-empty">列表为空：点上方按钮选择，或直接把文件 / 文件夹拖进文件区</div>';
  rows.querySelectorAll("[data-del]").forEach((b) => {
    b.onclick = () => {
      if (st.busy) return;
      st.list = st.list.filter(x => x.id !== Number(b.dataset.del));
      fmUpPaint(tab);
    };
  });
  const dirs = new Set();
  let bytes = 0, pending = 0;
  st.list.forEach((x) => {
    bytes += x.file.size;
    const i = x.rel.lastIndexOf("/");
    if (i > 0) dirs.add(x.rel.slice(0, i));
    if (x.status === FM_UP_ST.WAIT || x.status === FM_UP_ST.FAIL) pending++;
  });
  mask.querySelector(".fmv-up-sum").textContent =
    st.list.length ? ("共 " + st.list.length + " 个文件" + (dirs.size ? " · " + dirs.size + " 个文件夹" : "") +
      " · 合计 " + fmFmtBytes(bytes)) : "";
  /* 总进度条：本轮要传的文件里，已完成字节数 / 总字节数 */
  const bar = mask.querySelector(".fmv-up-prog i");
  if (bar) {
    let loaded = 0, total = 0;
    st.list.forEach((x) => {
      if (st.runIds.indexOf(x.id) < 0) return;
      total += x.file.size;
      if (x.status === FM_UP_ST.OK || x.status === FM_UP_ST.FAIL) loaded += x.file.size;
      else if (x.status === FM_UP_ST.RUN) loaded += x.file.size * (x.pct || 0);
    });
    const pct = total ? Math.round((loaded / total) * 100) : 0;
    bar.style.width = pct + "%";
    bar.parentElement.style.display = st.busy ? "block" : (pct >= 100 && total ? "block" : "none");
  }
  const start = mask.querySelector(".fmv-up-start");
  start.disabled = st.busy || !pending;
  start.textContent = st.busy ? "上传中…" : (st.list.some(x => x.status === FM_UP_ST.FAIL) ? "重传失败项" : "开始上传");
}
/* 单文件上传（XMLHttpRequest 才能拿到上传进度；fetch 不行） */
function fmUpOne(x, connId, dir, onProg) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/ssh/fs/upload");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProg) onProg(e.loaded / e.total);
    };
    xhr.onload = () => {
      try {
        const d = JSON.parse(xhr.responseText);
        if (d.error) reject(new Error(d.error)); else resolve(d);
      } catch (e) { reject(new Error("响应解析失败（HTTP " + xhr.status + "）")); }
    };
    xhr.onerror = () => reject(new Error("网络错误"));
    const fd = new FormData();
    fd.append("id", connId);
    fd.append("path", dir);
    fd.append("file", x.file);
    xhr.send(fd);
  });
}
async function fmUpStart(tab) {
  const st = tab.fmUp;
  const fm = tab.fm;
  if (st.busy || !fm.conn) return;
  const items = st.list.filter(x => x.status === FM_UP_ST.WAIT || x.status === FM_UP_ST.FAIL);
  if (!items.length) return;
  st.busy = true;
  st.runIds = items.map(x => x.id);
  items.forEach(x => { x.pct = 0; });
  fmUpPaint(tab);
  /* 先按相对路径逐级建目录（后端 recursive 模式会跳过已存在目录） */
  const dirs = new Set();
  items.forEach((x) => {
    const i = x.rel.lastIndexOf("/");
    if (i > 0) dirs.add(x.rel.slice(0, i));
  });
  for (const d of [...dirs].sort()) {
    try { await fmSshApi("mkdir", { id: fm.conn.id, path: fmJoin(fm.path, d), recursive: 1 }); } catch (_) {}
  }
  /* 同名覆盖确认：按目标目录各拉一次列表，比对文件名 */
  const nameSets = {};
  for (const d of dirs) {
    try {
      const d2 = await fmSshApi("list", { id: fm.conn.id, path: fmJoin(fm.path, d), hidden: 1 });
      nameSets[d] = new Set((d2.items || []).map(i2 => i2.name));
    } catch (_) { nameSets[d] = new Set(); }
  }
  const local = new Set();   // 当前目录直传的文件名也要互相比较
  try {
    const d2 = await fmSshApi("list", { id: fm.conn.id, path: fm.path, hidden: 1 });
    (d2.items || []).forEach(i2 => local.add(i2.name));
  } catch (_) {}
  const conflicts = items.filter((x) => {
    const di = x.rel.lastIndexOf("/");
    const name = x.rel.slice(di + 1);
    if (di > 0) return (nameSets[x.rel.slice(0, di)] || new Set()).has(name);
    if (local.has(name)) return true;
    local.add(name);         // 同批互撞
    return false;
  });
  if (conflicts.length) {
    const names = conflicts.map(x => x.rel.slice(x.rel.lastIndexOf("/") + 1));
    const shown = names.slice(0, 8).join("、") + (names.length > 8 ? " 等 " + names.length + " 个文件" : "");
    const okOver = await uiConfirmPop(tab.host.querySelector(".fmv-up-start"), {
      title: "发现同名文件",
      msg: "以下同名文件将被覆盖：" + shown,
      okText: "覆盖并上传",
      danger: true,
    });
    if (!okOver) { st.busy = false; fmUpPaint(tab); return; }
  }
  let ok = 0, fail = 0;
  for (const x of items) {
    x.status = FM_UP_ST.RUN;
    x.pct = 0;
    fmUpPaint(tab);
    const di = x.rel.lastIndexOf("/");
    const dir = di > 0 ? fmJoin(fm.path, x.rel.slice(0, di)) : fm.path;
    try {
      await fmUpOne(x, fm.conn.id, dir, (p) => {
        x.pct = p;
        if (!st._pt) st._pt = setTimeout(() => { st._pt = null; fmUpPaint(tab); }, 120);  // onprogress 很密，节流重绘
      });
      x.status = FM_UP_ST.OK;
      ok++;
    } catch (e) {
      x.status = FM_UP_ST.FAIL;
      x.err = e.message || String(e);
      fail++;
      toast("上传 " + x.rel + " 失败：" + x.err, "err");
    }
    fmUpPaint(tab);
  }
  st.busy = false;
  st.runIds = [];
  fmUpPaint(tab);
  toast("上传结束：成功 " + ok + " 个" + (fail ? "，失败 " + fail + " 个（可点「重传失败项」）" : ""), fail ? "warn" : "ok");
  if (ok) fmNavigate(tab, fm.path, { noPush: true });
}
/* 上传对话框内的两个选择框（文件 / 文件夹） */
function fmUpBind(tab) {
  /* 输入框的 onchange 已在 fmUpEnsure 里绑定，这里仅确保打开过一次对话框完成构建 */
  fmUpEnsure(tab);
}

/* ---------- 拖拽上传（支持文件夹，保持目录结构；拖入先加入上传列表，点「开始上传」才上传） ---------- */
function fmBindDrag(tab) {
  const root = tab.host.querySelector(".fmv");
  if (!root) return;
  let depth = 0;
  const ov = root.querySelector(".fmv-drop");
  const show = (txt) => { if (ov) { ov.style.display = "flex"; const t = ov.querySelector(".fmv-drop-t"); if (txt && t) t.textContent = txt; } };
  const hide = () => { depth = 0; if (ov) ov.style.display = "none"; };
  root.addEventListener("dragenter", (e) => {
    if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes("Files")) return;
    e.preventDefault(); e.stopPropagation();
    depth++;
    show("松开加入上传列表");
  });
  root.addEventListener("dragover", (e) => {
    if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes("Files")) return;
    e.preventDefault(); e.stopPropagation();
    if (e.dataTransfer.dropEffect !== "copy") e.dataTransfer.dropEffect = "copy";
  });
  root.addEventListener("dragleave", (e) => {
    e.preventDefault();
    depth--; if (depth <= 0) hide();
  });
  root.addEventListener("drop", (e) => {
    if (!e.dataTransfer) return;
    e.preventDefault(); e.stopPropagation();
    hide();
    /* fmCollectDrops 内部同步取 entry / files（事件结束后 dataTransfer 即失效），异步展开目录树 */
    fmCollectDrops(e.dataTransfer).then((list) => {
      if (list.length) fmUpAdd(tab, list);
    });
  });
}
/* 从 dataTransfer 展开拖入的文件 / 文件夹树 → [{file, rel}]，rel 为保留结构的相对路径 */
function fmCollectDrops(dt) {
  const out = [];
  const plain = Array.from(dt.files || []);
  const entries = [];
  if (dt.items) {
    for (const it of dt.items) {
      const en = it.webkitGetAsEntry && it.webkitGetAsEntry();
      if (en) entries.push(en);
    }
  }
  if (!entries.length) {
    plain.forEach((f) => out.push({ file: f, rel: f.name }));
    return out;
  }
  const walk = (entry, base) => new Promise((res) => {
    if (entry.isFile) {
      entry.file((f) => { out.push({ file: f, rel: base + entry.name }); res(); }, () => res());
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const batch = [];
      const readBatch = () => {
        reader.readEntries(async (arr) => {
          if (!arr.length) {                       // readEntries 必须循环读到空，否则大文件夹漏文件
            for (const e2 of batch) await walk(e2, base + entry.name + "/");
            res();
            return;
          }
          batch.push(...arr);
          readBatch();
        }, () => res());
      };
      readBatch();
    } else res();
  });
  return (async () => {
    for (const e of entries) await walk(e, "");
    if (!out.length) plain.forEach((f) => out.push({ file: f, rel: f.name }));
    return out;
  })();
}

/* ---------- 远程文件查看 / 编辑标签页（\u0000sshfile:<cid>:<绝对路径>） ---------- */
function fmFmtBytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1024 / 1024).toFixed(2) + " MB";
}
function openSshFileViewer(conn, fspath, name) {
  const vpath = FM_SSHFILE_PREFIX + conn.id + ":" + fspath;
  let tab = findTab(vpath);
  if (tab) { activate(tab); return tab; }
  const host = document.createElement("div");
  host.className = "cm-host sshfile-host";
  host.innerHTML =
    '<div class="rfv">' +
      '<div class="rfv-tools">' +
        '<i class="bi bi-hdd-network"></i><span class="rfv-host">' + esc(conn.user || "root") + '@' + esc(conn.host) + '</span>' +
        '<span class="rfv-path" title="' + escAttr(fspath) + '">' + esc(fspath) + '</span>' +
        '<span class="rfv-info"></span><span class="rfv-flex"></span>' +
        '<button class="g-btn split-main rfv-save" title="保存到远程主机 (Ctrl+S)" disabled><i class="bi bi-check-lg"></i> 保存</button>' +
        '<button class="g-ico" data-rfv="bak" title="打开时内容备份 / 还原" disabled><i class="bi bi-clock-history"></i></button>' +
        '<button class="g-ico" data-rfv="dl" title="下载此文件（需确认）"><i class="bi bi-download"></i></button>' +
      '</div>' +
      '<div class="rfv-cm"></div>' +
    '</div>';
  const dw = (typeof currentWrap === "function") ? currentWrap() : null;
  (dw || edGroups).appendChild(host);
  tab = {
    path: vpath, host: host, cm: null, original: "", dirty: false,
    group: curGroup, name: name, displayPath: "远程 · " + name, relPath: "",
    iconHtml: '<span class="fmv-ic-sm">' + iconFor(name, false) + '</span>',
    isSshFile: true, connId: conn.id,
  };
  tab.onBeforeClose = async () => {
    if (tab.dirty && typeof uiConfirm === "function") {
      const ok = await uiConfirm("关闭标签", name + " 有未保存的修改，确定不保存并关闭？", "不保存并关闭", true);
      if (!ok) return false;
    }
    return true;
  };
  tabs.push(tab);
  renderTabsAll();
  activate(tab);
  /* 下载：二次确认悬浮框（确认后才真正发起下载） */
  const dlBtn = host.querySelector('[data-rfv="dl"]');
  dlBtn.onclick = () => {
    const b = tab.fmBak;
    uiConfirmPop(dlBtn, {
      title: "下载确认",
      msg: (conn.user || "root") + "@" + conn.host + " · " + fspath + (b ? "（" + fmFmtBytes(b.size) + "）" : ""),
      okText: "下载",
    }).then((ok) => {
      if (!ok) return;
      const a = document.createElement("a");
      a.href = "/api/ssh/fs/download?id=" + encodeURIComponent(conn.id) + "&path=" + encodeURIComponent(fspath);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
    });
  };
  /* 拉取内容 → 建 CodeMirror */
  (async () => {
    try {
      const r = await fetch("/api/ssh/fs/read", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: conn.id, path: fspath }),
      });
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      if (d.binary) {
        host.querySelector(".rfv-cm").innerHTML =
          '<div class="rfv-bin"><i class="bi bi-file-earmark-binary"></i><p>这是二进制文件，无法以文本方式查看。</p>' +
          '<a class="g-btn outline" href="/api/ssh/fs/download?id=' + encodeURIComponent(conn.id) + '&path=' + encodeURIComponent(fspath) + '"><i class="bi bi-download"></i> 下载查看</a></div>';
        host.querySelector(".rfv-save").style.display = "none";
        return;
      }
      const cmBox = host.querySelector(".rfv-cm");
      const cm = CodeMirror(cmBox, {
        value: d.content || "", lineNumbers: true, lineWrapping: false,
        autofocus: false, dragDrop: false,
      });
      tab.cm = cm;
      tab.original = d.content || "";
      if (d.truncated) toast("文件较大，仅加载前 " + Math.round((d.content || "").length / 1024) + "KB（保存会覆盖整个文件，请勿保存截断内容）", "warn");
      const info = host.querySelector(".rfv-info");
      if (info) info.textContent = (d.size ? d.size + " 字节" : "") + (d.truncated ? " · 已截断" : "");
      /* 打开时内容备份：悬浮框展示备份信息，可一键还原（还原后仍是「已修改」状态，需再保存） */
      tab.fmBak = {
        time: Date.now(), size: d.size || (d.content || "").length,
        content: d.content || "",
        host: (conn.user || "root") + "@" + conn.host, path: fspath,
      };
      const bakBtn = host.querySelector('[data-rfv="bak"]');
      bakBtn.disabled = false;
      bakBtn.onclick = () => {
        const b = tab.fmBak;
        if (!b) return;
        uiConfirmPop(bakBtn, {
          title: "还原到打开时备份",
          msg: b.host + " · " + b.path + "（" + fmFmtBytes(b.size) + "，打开于 " + new Date(b.time).toLocaleTimeString() + "）。" +
               (tab.dirty ? "当前未保存的修改将被丢弃。" : "当前内容与备份一致，无需还原。"),
          okText: "还原备份",
          okDisabled: !tab.dirty,
        }).then((ok) => {
          if (!ok || !tab.cm) return;
          tab.cm.setValue(b.content);
          toast("已还原到打开时的内容（尚未保存，确认后请点保存）", "ok");
        });
      };
      const saveBtn = host.querySelector(".rfv-save");
      saveBtn.onclick = () => fmSshFileSave(tab);
      saveBtn.disabled = true;                 // 无修改时不允许保存
      cm.setOption("extraKeys", {
        "Ctrl-S": () => fmSshFileSave(tab),
        "Cmd-S": () => fmSshFileSave(tab),
      });
      cm.on("change", () => {
        const dirtyNow = cm.getValue() !== tab.original;
        if (dirtyNow !== tab.dirty) { tab.dirty = dirtyNow; renderTabsAll(); }
        saveBtn.disabled = !dirtyNow;
      });
      const ext = getExt(name.toLowerCase());
      if (typeof ensureMode === "function") ensureMode(ext).then(m => { if (m && tab.cm === cm) { cm.setOption("mode", m); if (typeof scheduleRefresh === "function") scheduleRefresh(tab); } }).catch(() => {});
      if (typeof scheduleRefresh === "function") scheduleRefresh(tab);
    } catch (e) {
      host.querySelector(".rfv-cm").innerHTML = '<div class="rfv-bin"><p>加载失败：' + esc(e.message || String(e)) + '</p></div>';
      host.querySelector(".rfv-save").style.display = "none";
    }
  })();
  return tab;
}
/* 会话恢复用：按连接 id + 路径重开远程文件查看器 */
async function openSshFileRestored(cid, fspath) {
  try {
    const conns = await fmConns();
    const c = conns.find(x => x.id === cid);
    if (c) { openSshFileViewer(c, fspath, fspath.split("/").filter(Boolean).pop() || fspath); return; }
  } catch (e) { /* 忽略 */ }
  toast("找不到对应的 SSH 连接，无法恢复远程文件标签", "warn");
}
async function fmSshFileSave(tab) {
  if (!tab || !tab.cm || !tab.connId) return;
  if (!tab.dirty) { toast("没有修改，无需保存", "ok"); return; }
  // 虚拟路径形如 \u0000sshfile:<连接id>:<远程绝对路径>，必须把「连接id:」一并剥掉，
  // 否则 SFTP 会把 "1ce920dd6336://www/..." 当相对路径解析而报 No such file
  const prefix = FM_SSHFILE_PREFIX + tab.connId + ":";
  const fspath = String(tab.path).slice(prefix.length);
  const content = tab.cm.getValue();
  if (content.length > 4 * 1024 * 1024) { toast("内容超过 4MB，无法保存", "err"); return; }
  try {
    await fmSshApi("write", { id: tab.connId, path: fspath, content: content });
    tab.original = content;
    tab.dirty = false;
    renderTabsAll();
    toast("已保存到远程主机", "ok");
  } catch (e) { toast("保存失败：" + (e.message || e), "err"); }
}

/* ---------- 侧栏「文件夹管理器」面板 ---------- */
/* 侧栏高亮：已打开（open）/ 当前正在查看（active）的远程文件管理器连接。
   回调来自 00_preamble 的 activate / 标签栏重建，与数据库、API 面板的做法一致。 */
function fmSyncOpenMarks() {
  const box = $("fmRemoteList");
  if (!box) return;
  box.querySelectorAll(".fm-remote-item").forEach((el) => {
    const t = findTab(FM_SSHFM_PREFIX + el.dataset.cid);
    el.classList.toggle("open", !!t);
    el.classList.toggle("active", !!(t && t.host.classList.contains("active")));
  });
}
async function fmLoadRemoteList() {
  const box = $("fmRemoteList");
  if (!box) return;
  try {
    const conns = await fmConns();
    if (!conns.length) {
      box.innerHTML = '<div class="fmv-rph">暂无 SSH 连接，可在「终端连接」面板添加远程主机。</div>';
      return;
    }
    box.innerHTML = '<div class="fmv-rhd"><i class="bi bi-hdd-network"></i> 远程服务器</div>';
    conns.forEach((c) => {
      const el = document.createElement("button");
      el.className = "g-btn block outline fm-remote-item";
      el.dataset.cid = c.id;
      el.title = "打开 " + (c.user || "root") + "@" + c.host + " 的文件管理器";
      el.innerHTML = '<i class="bi bi-folder2-open"></i> ' + esc(c.name || c.host) +
        '<span class="fm-remote-sub">' + esc((c.user || "root") + "@" + c.host) + '</span>';
      el.onclick = () => openFolderManagerView(c);
      box.appendChild(el);
    });
    fmSyncOpenMarks();
  } catch (e) {
    box.innerHTML = '<div class="fmv-rph">连接列表加载失败：' + esc(e.message || String(e)) + '</div>';
  }
}
(function fmBindSidePanel() {
  const open = $("fmOpenView");
  if (open) open.onclick = () => openFolderManagerView();
  const openRoot = $("fmOpenRoot");
  if (openRoot) openRoot.onclick = () => openFolderManagerView(null, ROOT || "/");
})();

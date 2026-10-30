/* ==================================================================
   下载中心（编辑器区域标签页）
     · 任务：可视化勾选任意文件 / 文件夹 → 打包 → 下载，实时进度 / 速度 / 剩余时间；
     · 记录：全部下载历史，支持搜索 / 筛选 / 分页 / 导出 CSV / 清空；
     · 设置：默认下载目录（可视化选择）、断点续传、并发、限速、压缩级别、自动清理；
     · 续传：后端 /api/dl/stream/<id> 支持 Range（206），前端按已下载字节续传；
            浏览器支持 File System Access API 时用「另存为」句柄，可真正写盘续写。
     须放在 16_（关闭大 IIFE）之前，复用闭包内的 $ / esc / toast / findTab / tabs /
     activate / renderTabsAll / curGroup / currentWrap / edGroups / uiPrompt / uiConfirm。
   ================================================================== */
const DL_VIEW_PATH = "\u0000downloads";
const DL_ACTIVE = ["pending", "building", "ready", "downloading", "paused"];

const DL = {
  tasks: [], items: [], total: 0, page: 1, pages: 1, kw: "", status: "all",
  stats: {}, cfg: null, usage: null, tab: "act",
  running: {},          // 传输中：id -> {ctrl, bytes, total, speed, writable, useFs, chunks}
  handles: {},          // id -> FileSystemFileHandle（本页会话内有效）
  sel: {},              // 记录多选：id -> 1（仅当前列表内的选中项有效）
  pendingAuto: [],      // 新建后待自动开始的任务 id
  poll: null, view: "tasks", pick: null,
};

/* 注册侧栏面板（与 SSH / V2Ray 同一套做法：panels[id] 指向 .side-panel 的 id） */
if (typeof panels !== "undefined") panels.downloads = "downloadsPanel";
if (typeof titles !== "undefined") titles.downloads = "下载中心";

/* ---------------- 工具 ---------------- */
function dlA(s) { return esc(s).replace(/"/g, "&quot;"); }
function dlSize(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + " B";
  const u = ["KB", "MB", "GB", "TB"];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return (n < 10 ? n.toFixed(2) : n.toFixed(1)) + " " + u[i];
}
function dlSpeed(bps) { return (Number(bps) || 0) < 1 ? "" : dlSize(bps) + "/s"; }
function dlEta(sec) {
  if (!isFinite(sec) || sec <= 0) return "";
  if (sec < 60) return Math.ceil(sec) + " 秒";
  if (sec < 3600) return Math.floor(sec / 60) + " 分 " + Math.round(sec % 60) + " 秒";
  return Math.floor(sec / 3600) + " 小时 " + Math.round((sec % 3600) / 60) + " 分";
}
function dlIcon(task) {
  if (task.kind === "zip") return { i: "bi-file-earmark-zip", cls: "zip" };
  if (task.kind === "text") return { i: "bi-file-earmark-text", cls: "txt" };
  if (task.kind === "torrent") return { i: "bi-magnet", cls: "txt" };
  if (task.kind === "url") return { i: "bi-globe2", cls: "" };
  const ext = String(task.name || "").split(".").pop().toLowerCase();
  if (["mp4", "mkv", "webm", "avi", "mov", "flv"].indexOf(ext) >= 0) return { i: "bi-film", cls: "" };
  if (["mp3", "wav", "flac", "aac", "m4a", "ogg"].indexOf(ext) >= 0) return { i: "bi-music-note-beamed", cls: "" };
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"].indexOf(ext) >= 0) return { i: "bi-image", cls: "" };
  if (["zip", "rar", "7z", "tar", "gz"].indexOf(ext) >= 0) return { i: "bi-file-earmark-zip", cls: "zip" };
  if (["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx"].indexOf(ext) >= 0) return { i: "bi-file-earmark-text", cls: "txt" };
  return { i: "bi-file-earmark", cls: "" };
}
function dlStatusText(s, t) {
  if (t && t.exists === false && (s === "ready" || s === "done"))
    s = "cleaned";                                       // 产物文件已被删除 → 不再叫「已完成」
  else if (s === "ready" && t && dlIsRemote(t)) s = "done";   // 远程任务就绪 = 服务器端已完成
  return ({ pending: "排队中", building: "打包中", ready: "待下载", downloading: "下载中",
            paused: "已暂停", done: "已完成", failed: "失败", canceled: "已取消",
            probing: "解析中", merging: "合并中", cleaned: "文件已清理" })[s] || s;
}
/* 网络下载（服务器多线程抓取）与本地任务的区别 */
function dlIsRemote(t) { return !!t && (t.kind === "url" || t.kind === "torrent" || t.kind === "hls"); }
function dlDur(sec) {
  sec = Math.max(0, Math.round(Number(sec) || 0));
  const p = function (n) { return (n < 10 ? "0" : "") + n; };
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? h + ":" + p(m) + ":" + p(s) : m + ":" + p(s);
}
function dlSrvPhase(t) {
  return dlIsRemote(t) && ["probing", "downloading", "merging"].indexOf(t.status) >= 0;
}
function dlSrvView(t) {
  /* 服务器端进度还值得展示：正在抓取、暂停在中间，或服务器已就绪（显示 100%） */
  if (!dlIsRemote(t)) return false;
  if (dlSrvPhase(t)) return true;
  if (t.status === "ready" || t.status === "done") return (t.srv_size || 0) > 0;
  return t.status === "paused" && (t.srv_done || 0) > 0 &&
    ((t.srv_size || 0) === 0 || (t.srv_done || 0) < (t.srv_size || 0));
}
/* 统一的进度 / 大小计算（侧栏条目与任务卡片共用）。
 * 注意：ffmpeg 拉流的加密 HLS，srv_size 是万分比（0~10000），不是字节数，不能当大小显示；
 *       普通 HLS 下载初期 srv_size 是估算值，可能为 0，此时显示「大小未知」。 */
function dlCalcProg(t, live, st) {
  const srv = dlSrvView(t);
  const ffPct = !!(srv && (t.meta || {}).enc && t.srv_size === 10000 &&
    (st === "downloading" || st === "paused"));
  const size = ffPct ? 0 : (srv ? (t.srv_size || 0) : (t.size || 0));
  const done = ffPct ? 0 : (srv ? (t.srv_done || 0) : (live ? live.bytes : (t.done || 0)));
  let pct = size > 0 ? Math.min(100, done * 100 / size) : 0;
  if (ffPct) pct = Math.min(99, (t.srv_done || 0) / 100);
  const noSize = ffPct || (srv && size === 0 && (st === "downloading" || st === "paused"));
  return { srv: srv, size: size, done: done, pct: pct, ffPct: ffPct, noSize: noSize };
}
function dlTaskClass(s, t) {
  if (t && t.exists === false && (s === "ready" || s === "done")) s = "cleaned";
  else if (t && dlIsRemote(t) && s === "ready") s = "done";   // 远程任务就绪 → 绿色已完成样式
  if (s === "downloading") return "running";
  if (s === "paused") return "paused";
  if (s === "done") return "done";
  if (s === "cleaned") return "cleaned";
  if (s === "failed" || s === "canceled") return "failed";
  return "";
}
/* 是否算「进行中」：远程任务 ready（服务器已抓好，等用户取回）不算 */
function dlIsActive(t) {
  if (DL.running[t.id]) return true;
  if (DL_ACTIVE.indexOf(t.status) < 0) return false;
  return !(dlIsRemote(t) && t.status === "ready");
}
async function dlReq(url, opt) {
  try {
    const r = await fetch(url, Object.assign({
      credentials: "same-origin", cache: "no-store",
      headers: { "Content-Type": "application/json" },
    }, opt || {}));
    let d = null;
    try { d = await r.json(); } catch (_) { }
    if (!d) return { ok: false, error: "HTTP " + r.status };
    if (!r.ok) return Object.assign({}, d, { ok: false, error: (d && d.error) || ("HTTP " + r.status) });
    return d;
  } catch (e) {
    return { ok: false, error: (e && e.message) || "网络异常" };
  }
}
async function dlProgress(id, offset, status) {
  try {
    await fetch("/api/dl/progress", {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: id, offset: offset, status: status || "" }),
    });
  } catch (_) { /* 进度上报失败不影响下载本身 */ }
}

/* ---------------- 标签页 ---------------- */
function openDownloadCenter(view) {
  let tab = findTab(DL_VIEW_PATH);
  if (!tab) {
    const host = document.createElement("div");
    host.className = "cm-host dlc-host";
    host.innerHTML = '<div class="dlc" id="dlCenter"></div>';
    const dw = (typeof currentWrap === "function") ? currentWrap() : null;
    (dw || edGroups).appendChild(host);
    tab = {
      path: DL_VIEW_PATH, host: host, cm: null, original: "", dirty: false,
      group: curGroup, name: "下载中心", displayPath: "下载中心", relPath: "",
      iconHtml: '<i class="bi bi-cloud-arrow-down" style="color:#4fc1ff"></i>',
    };
    tab.onBeforeClose = function () { dlStopAll(); dlPollStop(); return true; };
    tabs.push(tab);
    renderTabsAll();
    dlBuild();
  }
  activate(tab);
  if (view) DL.view = view;
  dlRender();
  dlPollStart();
  dlReload(true);
  return tab;
}
function downloadCenterVisible() {
  return !!findTab(DL_VIEW_PATH) && !!active && active.path === DL_VIEW_PATH;
}

function dlBuild() {
  const root = $("dlCenter");
  if (!root || root.dataset.built === "1") return;
  root.dataset.built = "1";
  root.innerHTML =
    '<div class="dlc-nav">' +
      '<div class="dlc-brand"><i class="bi bi-cloud-arrow-down"></i>' +
        '<div><b>下载中心</b><small>多文件 · 打包 · 断点续传</small></div></div>' +
      '<div class="dlc-navitem on" data-view="tasks"><i class="bi bi-list-task"></i><span>下载任务</span>' +
        '<span class="dlc-nbadge" id="dlNavActive" style="display:none">0</span></div>' +
      '<div class="dlc-navitem" data-view="records"><i class="bi bi-clock-history"></i><span>下载记录</span>' +
        '<span class="dlc-nbadge ghost" id="dlNavTotal">0</span></div>' +
      '<div class="dlc-navitem" data-view="settings"><i class="bi bi-sliders2"></i><span>设置</span></div>' +
      '<div class="dlc-navsep"></div>' +
      '<div class="dlc-navitem" data-view="tasks" data-act="new"><i class="bi bi-plus-circle"></i><span>新建下载</span></div>' +
      '<div class="dlc-navfoot">' +
        '<div class="dlc-urow"><span>产物占用</span><b id="dlNavUsage">-</b></div>' +
        '<div class="dlc-urow"><span>记录条数</span><b id="dlNavRec">-</b></div>' +
      '</div>' +
    '</div>' +
    '<div class="dlc-main">' +
      '<div class="dlc-head" id="dlHead"></div>' +
      '<div class="dlc-scroll" id="dlScroll"></div>' +
    '</div>';
  const scroll = $("dlScroll");
  scroll.addEventListener("click", dlOnClick);
  scroll.addEventListener("change", dlOnChange);
  scroll.addEventListener("input", dlOnInput);
  scroll.addEventListener("contextmenu", dlOnCtx);
  const head = $("dlHead");                 // 顶部工具行（新建 / 刷新 / 导出 / 清理 …）
  if (head) head.addEventListener("click", dlOnClick);
  root.querySelector(".dlc-nav").addEventListener("click", function (e) {
    const it = e.target.closest(".dlc-navitem");
    if (!it) return;
    if (it.dataset.act === "new") { dlPickOpen({}); return; }
    dlView(it.dataset.view);
  });
}

function dlView(v) {
  DL.view = v || "tasks";
  document.querySelectorAll("#dlCenter .dlc-navitem").forEach(function (n) {
    n.classList.toggle("on", n.dataset.view === DL.view && !n.dataset.act);
  });
  dlRender();
  if (DL.view === "records") dlLoadRecords();
  else if (DL.view === "settings") dlLoadUsage();
  else dlLoadTasks();
}

/* ---------------- 数据 ---------------- */
async function dlLoadTasks(silent) {
  const d = await dlReq("/api/dl/tasks?status=all&page_size=200");
  if (!d.ok) { if (!silent) toast("读取下载任务失败：" + (d.error || ""), "err"); return; }
  DL.tasks = d.items || [];
  DL.stats = d.stats || {};
  if (d.settings) DL.cfg = d.settings;
  dlPaintNav();
  if (DL.view === "tasks") dlRenderTasks();
  if (dlSideVisible()) dlSideRender();
  dlKickAuto();
}
function dlSideVisible() {
  const p = document.getElementById("downloadsPanel");
  const sb = document.getElementById("sidebar");
  return !!(p && p.classList.contains("active") && sb && !sb.classList.contains("collapsed"));
}
async function dlLoadRecords(silent) {
  const d = await dlReq("/api/dl/tasks?q=" + encodeURIComponent(DL.kw) +
    "&status=" + encodeURIComponent(DL.status) + "&page=" + DL.page + "&page_size=30");
  if (!d.ok) { if (!silent) toast("读取下载记录失败", "err"); return; }
  DL.items = d.items || [];
  DL.total = d.total || 0;
  DL.pages = Math.max(1, Math.ceil(DL.total / 30));
  if (d.stats) DL.stats = d.stats;
  dlPaintNav();
  if (DL.view === "records") dlRenderRecords();
}
async function dlLoadUsage() {
  const d = await dlReq("/api/dl/settings");       // 一次拿到设置 + 占用，打开设置页即可见
  if (!d.ok) return;
  DL.cfg = d.settings || DL.cfg;
  DL.usage = d.usage || null;
  dlPaintNav();
  if (DL.view === "settings") dlRenderSettings();
}
async function dlLoadEnv() {
  const d = await dlReq("/api/dl/env");
  if (d && d.ok) DL.env = d.env || {};
}
async function dlReload(silent) {
  if (DL.view === "records") return dlLoadRecords(silent);
  if (DL.view === "settings") return dlLoadUsage();
  return dlLoadTasks(silent);
}
function dlPaintNav() {
  // 与任务页口径一致：只数真正在传输的（实时进度或 downloading 状态）
  const act = DL.tasks.filter(function (t) { return !!DL.running[t.id] || t.status === "downloading"; }).length;
  const badge = $("dlNavActive");
  if (badge) { badge.textContent = act; badge.style.display = act ? "" : "none"; }
  const tb = $("dlNavTotal");
  if (tb) tb.textContent = (DL.stats && DL.stats.total) || 0;
  const u = $("dlNavUsage");
  if (u) u.textContent = DL.usage ? dlSize(DL.usage.artifact_bytes) : "-";
  const rc = $("dlNavRec");
  if (rc) rc.textContent = (DL.usage && DL.usage.records) || (DL.stats && DL.stats.total) || 0;
  const ab = $("actDlBadge");
  if (ab) { ab.textContent = act; ab.style.display = act ? "" : "none"; }
}
function dlKickAuto() {
  if (!DL.pendingAuto.length) return;
  const keep = [];
  DL.pendingAuto.forEach(function (id) {
    const t = (DL.tasks || []).filter(function (x) { return x.id === id; })[0];
    if (!t) return;
    if (t.status === "pending" || t.status === "building") { keep.push(id); return; }
    if (t.status === "ready" && !DL.running[id]) dlTransfer(t);
  });
  DL.pendingAuto = keep;
}
function dlPollStart() {
  if (DL.poll) return;
  DL.poll = setInterval(function () {
    if (document.hidden) return;
    const tabOn = downloadCenterVisible(), sideOn = dlSideVisible();
    if (!tabOn && !sideOn) return;
    const busy = Object.keys(DL.running).length > 0 || DL.pendingAuto.length > 0 ||
      (DL.tasks || []).some(dlIsActive);
    if (tabOn && DL.view === "records") { if (busy) dlLoadRecords(true); return; }
    if (tabOn && DL.view === "settings") { if (busy) dlLoadUsage(); return; }
    dlLoadTasks(true);                               // 任务页 / 侧栏：保持进度新鲜
  }, 1500);
}
function dlPollStop() { if (DL.poll) { clearInterval(DL.poll); DL.poll = null; } }

/* ---------------- 侧栏面板（任务速览） ---------------- */
function dlSideRender() {
  const list = document.getElementById("dlsList");
  if (!list) return;
  const isAct = dlIsActive;
  const act = (DL.tasks || []).filter(isAct);
  const fin = (DL.tasks || []).filter(function (t) { return !isAct(t); });
  const st = DL.stats || {};

  const sum = document.getElementById("dlsSum");
  if (sum) {
    sum.innerHTML =
      '<span><b>' + act.length + '</b> 进行中</span>' +
      '<span>完成 <b>' + (st.done || 0) + '</b></span>' +
      '<span>累计 <b>' + dlSize(st.done_bytes || 0) + '</b></span>';
  }

  if (!act.length && !fin.length) {
    list.innerHTML =
      '<div class="dls-empty"><i class="bi bi-cloud-arrow-down"></i>' +
      '<b>还没有下载任务</b>' +
      '<p>点上面的「新建下载」，勾选文件或文件夹即可打包下载，支持暂停与断点续传。</p></div>';
  } else {
    let html = "";
    if (act.length) {
      html += '<div class="dls-sec">进行中 · ' + act.length + '</div>';
      html += act.map(dlSideItem).join("");
    }
    if (fin.length) {
      html += '<div class="dls-sec">已结束 · 共 ' + fin.length + ' 条</div>';
      html += fin.map(dlSideItem).join("");
    }
    list.innerHTML = html;
  }

  const foot = document.getElementById("dlsFoot");
  if (foot) {
    foot.innerHTML = '<span>共 <b>' + (st.total || 0) + '</b> 条记录</span>' +
      '<button class="dls-link" data-dls="open">完整面板 <i class="bi bi-chevron-right"></i></button>';
  }
}
function dlSideItem(t) {
  const live = DL.running[t.id];
  const st = live ? "downloading" : t.status;
  const pr = dlCalcProg(t, live, st);
  const size = pr.size, pct = pr.pct, noSize = pr.noSize;
  const speed = pr.srv ? (t.speed || 0) : (live ? live.speed : 0);
  const ic = dlIcon(t);
  let acts = "";
  if (st === "downloading") {
    acts = '<button class="dls-ico" data-dls="pause" data-id="' + dlA(t.id) +
      '" title="暂停（保留进度）"><i class="bi bi-pause-fill"></i></button>';
  } else if (st === "building" || st === "pending" || st === "probing" || st === "merging") {
    acts = '<span class="dls-tag">' + dlStatusText(st, t) + '</span>';
  } else {
    if (t.exists) {
      // 产物还在 → 打开（视频/音频/图片走内置播放器，其它走内置编辑器）
      acts = '<button class="dls-ico" data-dls="view" data-id="' + dlA(t.id) +
        '" title="用内置播放器 / 编辑器打开"><i class="bi bi-play-circle"></i></button>';
    } else {
      // 产物已被清理 → 重新根据链接下载到服务器
      acts = '<button class="dls-ico" data-dls="start" data-id="' + dlA(t.id) +
        '" title="重新根据链接下载到服务器"><i class="bi bi-arrow-repeat"></i></button>';
    }
  }
  return '<div class="dls-item ' + dlTaskClass(st, t) + '" data-id="' + dlA(t.id) + '" title="' +
    dlA(dlIsRemote(t) ? (t.url || t.name) : t.name) + '">' +
    '<div class="dls-top"><i class="bi ' + ic.i + '"></i>' +
      '<span class="dls-nm">' + esc(t.name) + '</span>' + acts + '</div>' +
    '<div class="dls-bar"><i style="width:' + pct.toFixed(1) + '%"></i></div>' +
    '<div class="dls-meta"><span>' + dlStatusText(st, t) +
      (speed > 0 ? " · " + dlSpeed(speed) : "") + '</span>' +
      '<span>' + (noSize ? (pct ? pct.toFixed(0) + "%" : "-")
        : (size ? pct.toFixed(0) + "% · " + dlSize(size) : "-")) + '</span></div>' +
  '</div>';
}

/* ---------------- 顶部工具行 ---------------- */
function dlHeadRender() {
  const el = $("dlHead");
  if (!el) return;
  if (DL.view === "tasks") {
    el.innerHTML =
      '<h2><i class="bi bi-list-task"></i>下载任务<span class="dlc-sub" id="dlQueSub"></span></h2>' +
      '<span class="dlc-sp"></span>' +
      '<button class="dlc-btn sm" data-act="cur"><i class="bi bi-file-earmark-arrow-down"></i>当前文件</button>' +
      '<button class="dlc-btn sm" data-act="refresh"><i class="bi bi-arrow-clockwise"></i>刷新</button>' +
      '<button class="dlc-btn primary" data-act="new"><i class="bi bi-plus-lg"></i>新建下载</button>';
  } else if (DL.view === "records") {
    el.innerHTML =
      '<h2><i class="bi bi-clock-history"></i>下载记录<span class="dlc-sub" id="dlQueSub"></span></h2>' +
      '<span class="dlc-sp"></span>' +
      '<button class="dlc-btn sm" data-act="export"><i class="bi bi-filetype-csv"></i>导出 CSV</button>' +
      '<button class="dlc-btn sm danger" data-act="clear"><i class="bi bi-trash3"></i>清空记录</button>' +
      '<button class="dlc-btn sm" data-act="refresh"><i class="bi bi-arrow-clockwise"></i>刷新</button>';
  } else {
    el.innerHTML =
      '<h2><i class="bi bi-sliders2"></i>下载设置<span class="dlc-sub">默认目录 · 续传 · 速度 · 清理</span></h2>' +
      '<span class="dlc-sp"></span>' +
      '<button class="dlc-btn sm danger" data-act="clean"><i class="bi bi-eraser"></i>清理产物</button>' +
      '<button class="dlc-btn sm" data-act="reset-cfg"><i class="bi bi-arrow-counterclockwise"></i>恢复默认</button>';
  }
}
function dlRender() {
  dlHeadRender();
  if (DL.view === "tasks") dlRenderTasks();
  else if (DL.view === "records") dlRenderRecords();
  else dlRenderSettings();
}
/* ---------------- 视图一：下载任务（正在下载 / 下载完成 双 tab） ---------------- */
function dlIsWaiting(t) {
  return ["pending", "building", "probing", "merging"].indexOf(t.status) >= 0;
}
function dlRenderTasks() {
  const box = $("dlScroll");
  if (!box) return;
  box.classList.remove("rec-mode");
  const st = DL.stats || {};
  // 「正在下载」包含一切进行中的任务：真正在传输的 + 排队 / 解析 / 打包 / 合并中
  const run = DL.tasks.filter(function (t) {
    return !!DL.running[t.id] || t.status === "downloading" || dlIsWaiting(t);
  });
  const wait = DL.tasks.filter(dlIsWaiting).length;
  const fin = DL.tasks.filter(function (t) {
    return !DL.running[t.id] && t.status !== "downloading" && !dlIsWaiting(t);
  });
  if (DL.tab !== "fin") DL.tab = "act";
  const sub = $("dlQueSub");
  if (sub) sub.textContent = " · " + run.length + " 个正在下载 / 共 " + (st.total || 0) + " 条记录";

  let html =
    '<div class="dlc-stats">' +
      dlStatCard("bi-arrow-down-circle", "正在下载", run.length, "dlc-stat") +
      dlStatCard("bi-hourglass-split", "等待下载", wait, "dlc-stat warn") +
      dlStatCard("bi-check2-circle", "下载成功", st.done || 0, "dlc-stat ok") +
      dlStatCard("bi-exclamation-octagon", "下载失败", st.fail || 0, "dlc-stat bad") +
    '</div>' +
    '<div class="dlc-tabs">' +
      '<button class="dlc-tab' + (DL.tab === "act" ? " on" : "") + '" data-act="tab-act">' +
        '<i class="bi bi-arrow-down-circle"></i>正在下载<em>' + run.length + '</em></button>' +
      '<button class="dlc-tab' + (DL.tab === "fin" ? " on" : "") + '" data-act="tab-fin">' +
        '<i class="bi bi-check2-circle"></i>下载完成<em>' + fin.length + '</em></button>' +
    '</div>';
  const show = DL.tab === "act" ? run : fin;
  if (!show.length) {
    html += DL.tab === "act"
      ? '<div class="dlc-empty"><div class="dlc-ebox"><i class="bi bi-cloud-arrow-down"></i></div>' +
        '<b>没有进行中的任务</b>' +
        '<p>点「新建下载」打开可视化目录选择器，勾选任意数量的文件与文件夹，' +
        '系统打包成 zip 后下载，全程可暂停并从断点继续。</p>' +
        '<button class="dlc-btn primary" data-act="new"><i class="bi bi-plus-lg"></i>新建下载</button></div>'
      : '<div class="dlc-empty"><div class="dlc-ebox"><i class="bi bi-check2-circle"></i></div>' +
        '<b>还没有已完成的下载</b><p>任务结束后会出现在这里，可随时重新下载到本机。</p></div>';
  } else {
    html += '<div class="dlc-list" id="dlQueList">' + show.map(dlTaskCard).join("") + '</div>';
  }
  box.innerHTML = html;
}
function dlStatCard(icon, label, val, cls) {
  return '<div class="' + cls + '"><div class="dlc-sic"><i class="bi ' + icon + '"></i></div>' +
    '<div><div class="dlc-sv">' + dlA(val) + '</div><div class="dlc-sl">' + label + '</div></div></div>';
}
function dlTaskCard(t) {
  const live = DL.running[t.id];
  const st = live ? "downloading" : t.status;
  const pr = dlCalcProg(t, live, st);
  const srv = pr.srv;
  const size = pr.size, done = pr.done, pct = pr.pct, noSize = pr.noSize;
  const ic = dlIcon(t);
  const waitBar = st === "building" || st === "probing" || st === "merging";
  const speed = srv ? (t.speed || 0) : (live ? live.speed : 0);
  return '<div class="dlc-task ' + dlTaskClass(st, t) + '" data-id="' + dlA(t.id) + '">' +
    '<div class="dlc-tico ' + ic.cls + '"><i class="bi ' + ic.i + '"></i></div>' +
    '<div class="dlc-tbody">' +
      '<div class="dlc-trow1">' +
        '<span class="dlc-tname" data-act="copy" title="' + dlA(t.name) + '">' + esc(t.name) + '</span>' +
        '<span class="dlc-pill ' + st + '">' + dlStatusText(st, t) + '</span>' +
        (dlIsRemote(t) && t.threads ? '<span class="dlc-tsize" title="服务器端并发连接数"><i class="bi bi-diagram-3"></i>' + t.threads + '</span>' : '') +
        (t.hits > 0 ? '<span class="dlc-tsize" title="下载次数"><i class="bi bi-arrow-repeat"></i>' + t.hits + '</span>' : '') +
        (noSize
          ? '<span class="dlc-tsize" title="该类型需下载完成后才能确定总大小">大小未知</span>'
          : '<span class="dlc-tsize">' + dlSize(size) + '</span>') +
      '</div>' +
      '<div class="dlc-trow2"><span class="dlc-path" title="' +
        dlA(dlIsRemote(t) ? (t.url || "") : ((t.src || []).join(" | ") || t.src_dir || t.artifact)) + '">' +
        esc(dlIsRemote(t) ? (t.url || "") : ((t.src || []).join(" | ") || t.src_dir || t.artifact || "")) + '</span>' +
        '<span>' + esc(t.note || t.ts || "") + '</span></div>' +
      '<div class="dlc-bar' + (waitBar ? " building" : "") + '"><i style="width:' + pct.toFixed(2) + '%"></i></div>' +
      '<div class="dlc-trow3">' +
        '<span class="dlc-pct">' + pct.toFixed(1) + '%</span>' +
        '<span class="dlc-bytes">' + (noSize
          ? dlSize(done) + ' 已下载'
          : dlSize(done) + ' / ' + dlSize(size)) + '</span>' +
        '<span class="dlc-sp"></span>' +
        (t.error ? '<span style="color:var(--dlc-bad)" title="' + dlA(t.error) + '">' + esc(String(t.error).slice(0, 40)) + '</span>' : '') +
        '<span class="dlc-speed">' + dlSpeed(speed) + '</span>' +
        '<span class="dlc-eta">' + (speed > 0 ? dlEta((size - done) / speed) : "") + '</span>' +
      '</div>' +
    '</div>' +
    '<div class="dlc-tacts">' + dlTaskActs(t, st) + '</div>' +
  '</div>';
}
function dlHasSegs(t) {
  return !!t && (t.kind === "hls" || String(t.note || "").indexOf("HLS") === 0);
}
function dlSegsBtn() {
  return '<button class="dlc-iconbtn" data-act="segs" title="查看切片下载 / 重试情况"><i class="bi bi-stack"></i></button>';
}
function dlTaskActs(t, st) {
  let a = "";
  if (dlIsRemote(t)) {
    if (st === "probing" || st === "merging" || st === "pending") {
      return '<span class="dlc-tsize">' + (st === "merging" ? "合并中…" : "连接中…") + '</span>' +
        '<button class="dlc-iconbtn bad" data-act="cancel" title="取消"><i class="bi bi-x-lg"></i></button>';
    }
    if (st === "downloading") {
      return (dlHasSegs(t) ? dlSegsBtn() : "") +
        '<button class="dlc-iconbtn" data-act="pause" title="暂停（分片进度已保存，可续传）"><i class="bi bi-pause-fill"></i></button>' +
        '<button class="dlc-iconbtn bad" data-act="cancel" title="取消下载"><i class="bi bi-x-lg"></i></button>';
    }
    if (st === "paused" || st === "failed" || st === "canceled") {
      return (dlHasSegs(t) ? dlSegsBtn() : "") +
        '<button class="dlc-iconbtn" data-act="start" title="继续下载（按分片断点续传）"><i class="bi bi-play-fill"></i></button>' +
        '<button class="dlc-iconbtn bad" data-act="delete" title="删除任务"><i class="bi bi-trash3"></i></button>';
    }
    // ready：产物还在 → 拉到本机；产物被清理 → 重新让服务器抓一遍（不再开空标签页）
    if (t.exists === false) {
      return '<button class="dlc-iconbtn" data-act="start" title="产物已被清理，点击重新下载"><i class="bi bi-arrow-repeat"></i></button>' +
        '<button class="dlc-iconbtn bad" data-act="delete" title="删除任务"><i class="bi bi-trash3"></i></button>';
    }
    return dlOpenBtn(t) +
      '<button class="dlc-iconbtn" data-act="native" title="下载到本机（支持续传）"><i class="bi bi-download"></i></button>' +
      '<button class="dlc-iconbtn" data-act="copy" title="复制下载链接"><i class="bi bi-link-45deg"></i></button>' +
      '<button class="dlc-iconbtn bad" data-act="delete" title="删除任务"><i class="bi bi-trash3"></i></button>';
  }
  if (st === "building" || st === "pending") {
    a += '<button class="dlc-iconbtn bad" data-act="cancel" title="取消打包"><i class="bi bi-x-lg"></i></button>';
  } else if (st === "downloading") {
    a += '<button class="dlc-iconbtn" data-act="pause" title="暂停（保留进度，可续传）"><i class="bi bi-pause-fill"></i></button>';
  } else {
    const tip = (t.done > 0 && t.done < (t.size || 0)) ? "继续下载（从 " + dlSize(t.done) + " 续传）" : "开始下载";
    a += '<button class="dlc-iconbtn" data-act="start" title="' + dlA(tip) + '"><i class="bi bi-play-fill"></i></button>';
    if (t.done > 0) a += '<button class="dlc-iconbtn" data-act="reset" title="从头重新下载"><i class="bi bi-arrow-counterclockwise"></i></button>';
  }
  if (st !== "building" && st !== "pending" && t.exists) {
    a += dlOpenBtn(t);
    a += '<button class="dlc-iconbtn" data-act="native" title="浏览器 / 下载工具直链下载（支持续传）"><i class="bi bi-box-arrow-up-right"></i></button>';
    a += '<button class="dlc-iconbtn" data-act="copy" title="复制下载链接"><i class="bi bi-link-45deg"></i></button>';
  }
  a += '<button class="dlc-iconbtn bad" data-act="delete" title="删除任务（记录同时移除）"><i class="bi bi-trash3"></i></button>';
  return a;
}
function dlPaintLive(id) {
  const card = document.querySelector('#dlQueList .dlc-task[data-id="' + id + '"]');
  if (!card) return;
  const st = DL.running[id];
  if (!st) return;
  const size = st.total || 0;
  const pct = size > 0 ? Math.min(100, st.bytes * 100 / size) : 0;
  const bar = card.querySelector(".dlc-bar > i");
  if (bar) bar.style.width = pct.toFixed(2) + "%";
  const p = card.querySelector(".dlc-pct");
  if (p) p.textContent = pct.toFixed(1) + "%";
  const b = card.querySelector(".dlc-bytes");
  if (b) b.textContent = dlSize(st.bytes) + " / " + dlSize(size);
  const s = card.querySelector(".dlc-speed");
  if (s) s.textContent = dlSpeed(st.speed);
  const e = card.querySelector(".dlc-eta");
  if (e) e.textContent = st.speed > 0 ? dlEta((size - st.bytes) / st.speed) : "";
}

/* ---------------- 视图二：下载记录 ---------------- */
function dlRenderRecords() {
  const box = $("dlScroll");
  if (!box) return;
  const sub = $("dlQueSub");
  if (sub) sub.textContent = " · 共 " + DL.total + " 条";
  box.classList.add("rec-mode");           // 工具行固定、只有表格滚动
  dlSelPrune();                            // 清掉已不在当前列表里的选中项
  const nSel = dlSelCount();
  let html =
    '<div class="dlc-tools">' +
      '<div class="dlc-search"><i class="bi bi-search"></i>' +
        '<input id="dlRecKw" type="text" spellcheck="false" autocomplete="off" ' +
        'placeholder="搜索文件名 / 来源路径 / 备注" value="' + dlA(DL.kw) + '"></div>' +
      '<select class="dlc-select" id="dlRecStatus">' +
        '<option value="all"' + (DL.status === "all" ? " selected" : "") + '>全部状态</option>' +
        '<option value="active"' + (DL.status === "active" ? " selected" : "") + '>进行中</option>' +
        '<option value="done"' + (DL.status === "done" ? " selected" : "") + '>已完成</option>' +
        '<option value="failed"' + (DL.status === "failed" ? " selected" : "") + '>失败 / 取消</option>' +
      '</select>' +
      '<span style="flex:1"></span>' +
      '<span class="dlc-selbar"' + (nSel ? "" : " hidden") + '>' +
        '已选 <b>' + nSel + '</b> 项' +
        '<button class="dlc-btn sm danger" data-act="sel-del"><i class="bi bi-trash3"></i>删除所选</button>' +
        '<button class="dlc-btn sm" data-act="sel-clear">取消选择</button>' +
      '</span>' +
      '<span style="font-size:11.5px;color:var(--dlc-dim)">共 ' + DL.total + ' 条</span>' +
    '</div>' +
    '<div class="dlc-recscroll">' +
    '<div class="dlc-tablewrap"><table class="dlc-table">' +
      '<thead><tr>' +
        '<th style="width:30px"><input type="checkbox" class="dlc-ck" id="dlSelAll" title="全选 / 全不选"></th>' +
        '<th style="width:112px">时间</th><th>文件 / 来源</th><th style="width:66px">类型</th>' +
        '<th style="width:82px">大小</th><th style="width:96px">进度</th>' +
        '<th style="width:80px">状态</th><th style="width:150px">操作</th>' +
      '</tr></thead><tbody>';
  if (!DL.items.length) {
    html += '<tr><td colspan="8"><div class="dlc-empty" style="padding:38px 0">' +
      '<div class="dlc-ebox"><i class="bi bi-inbox"></i></div><b>' +
      ((DL.kw || DL.status !== "all") ? "没有符合条件的记录" : "还没有下载记录") + '</b></div></td></tr>';
  }
  DL.items.forEach(function (t) {
    const live = DL.running[t.id];
    const st = live ? "downloading" : t.status;
    const srv = dlSrvView(t);
    const size = srv ? (t.srv_size || 0) : (t.size || 0);
    const done = srv ? (t.srv_done || 0) : (live ? live.bytes : (t.done || 0));
    const pct = size > 0 ? Math.min(100, done * 100 / size) : 0;
    const sel = !!DL.sel[t.id];
    html += '<tr class="dlc-rrow' + (sel ? " sel" : "") + '" data-id="' + dlA(t.id) + '">' +
      '<td style="text-align:center"><input type="checkbox" class="dlc-ck" data-id="' +
        dlA(t.id) + '"' + (sel ? " checked" : "") + '></td>' +
      '<td style="color:var(--dlc-dim);white-space:nowrap">' + esc(String(t.ts || "").slice(5)) + '</td>' +
      '<td><div class="dlc-fn" title="' + dlA(t.name) + '">' + esc(t.name) + '</div>' +
        '<div class="dlc-fp" title="' + dlA((t.src || []).join(" | ") || t.artifact) + '">' +
        esc((t.src || []).join(" | ") || t.artifact || "") + '</div></td>' +
      '<td>' + (({ zip: "zip 包", text: "文本", url: "链接", torrent: "磁力" })[t.kind] || "单文件") + '</td>' +
      '<td class="dlc-num">' + dlSize(size) + '</td>' +
      '<td class="dlc-num">' + (size ? pct.toFixed(0) + "% · " + dlSize(done) : "-") + '</td>' +
      '<td><span class="dlc-pill ' + st + '">' + dlStatusText(st, t) + '</span></td>' +
      '<td>' +
        dlOpenBtn(t) +
        (!t.exists && dlIsRemote(t)
          ? '<button class="dlc-iconbtn" data-act="start" title="产物已清理 · 重新根据链接下载到服务器"><i class="bi bi-arrow-repeat"></i></button>'
          : '') +
        (t.exists && dlIsRemote(t)
          ? '<button class="dlc-iconbtn" data-act="native" title="下载到本机"><i class="bi bi-download"></i></button>'
          : '') +
        '<button class="dlc-iconbtn" data-act="copy" title="复制下载链接"><i class="bi bi-link-45deg"></i></button>' +
        '<button class="dlc-iconbtn bad" data-act="delete" title="删除记录"><i class="bi bi-trash3"></i></button>' +
      '</td></tr>';
  });
  html += '</tbody></table></div>' +
    '<div class="dlc-pager">' +
      '<button class="dlc-btn sm" data-act="p-prev"' + (DL.page <= 1 ? " disabled" : "") + '>上一页</button>' +
      '<span><b>' + DL.page + '</b> / ' + DL.pages + '</span>' +
      '<button class="dlc-btn sm" data-act="p-next"' + (DL.page >= DL.pages ? " disabled" : "") + '>下一页</button>' +
    '</div>' +
    '</div>';
  box.innerHTML = html;
}

/* ---------------- 视图三：设置 ---------------- */
function dlSw(key, on) {
  return '<label class="dlc-sw"><input type="checkbox" data-cfg="' + key + '" data-kind="bool"' +
    (on ? " checked" : "") + '><span></span></label>';
}
function dlSel(key, opts, val) {
  return '<select class="dlc-select" data-cfg="' + key + '" data-kind="str">' +
    opts.map(function (o) {
      return '<option value="' + dlA(o.v) + '"' +
        (String(val) === String(o.v) ? " selected" : "") + '>' + esc(o.t) + '</option>';
    }).join("") + '</select>';
}
function dlNum(key, val) {
  return '<input class="dlc-input" type="number" data-cfg="' + key +
    '" data-kind="num" value="' + dlA(val) + '">';
}
function dlSRow(label, desc, ctl) {
  return '<div class="dlc-srow"><div class="dlc-sinfo"><div class="dlc-slabel">' + label +
    '</div><div class="dlc-sdesc">' + desc + '</div></div><div class="dlc-sctl">' + ctl + '</div></div>';
}
function dlRenderSettings() {
  const box = $("dlScroll");
  if (!box) return;
  box.classList.remove("rec-mode");
  const c = DL.cfg || {};
  const u = DL.usage || {};
  box.innerHTML =
    '<div class="dlc-sec"><h3><i class="bi bi-folder2-open"></i>下载位置' +
      '<small>打包产物先落到这里，再下发给浏览器</small></h3>' +
      dlSRow("打包产物目录",
        "多文件 / 文件夹的 zip 先生成在这里；单文件直接读源文件，不额外占用空间",
        '<div class="dlc-pathbox"><span><bdi>' + esc(c.artifact_dir || "-") + '</bdi></span></div>' +
        '<button class="dlc-btn sm" data-act="pickdir"><i class="bi bi-folder2-open"></i>选择</button>') +
      dlSRow("产物保留天数", "超过这个天数的已结束任务会被自动清理（0 = 不自动清理）",
        dlNum("keep_days", c.keep_days)) +
      dlSRow("记录最多保留", "超出后自动删除最旧的已结束记录（进行中的任务不会被删）",
        dlNum("max_rows", c.max_rows)) +
    '</div>' +
    '<div class="dlc-sec"><h3><i class="bi bi-lightning-charge"></i>传输' +
      '<small>断点续传 · 并发 · 限速</small></h3>' +
      dlSRow("断点续传", "中断 / 暂停后从上次位置继续，而不是重新下载整个文件",
        dlSw("resume", c.resume)) +
      dlSRow("优先用「另存为」写盘",
        "浏览器支持时先选保存位置，边下边写；刷新页面后接着续写（不支持时自动退回内存方式）",
        dlSw("use_fs", c.use_fs)) +
      dlSRow("同时下载任务数", "同时进行的最大任务数（1–5）",
        dlSel("concurrency", [{ v: 1, t: "1 个" }, { v: 2, t: "2 个" }, { v: 3, t: "3 个" },
          { v: 4, t: "4 个" }, { v: 5, t: "5 个" }], c.concurrency)) +
      dlSRow("下载限速（KB/s）", "0 = 不限速；需要给别的程序留带宽时设置",
        dlNum("throttle_kbps", c.throttle_kbps)) +
      dlSRow("新建后自动开始", "打包完成后自动开始下载（关闭则只入队，等你点开始）",
        dlSw("auto_start", c.auto_start)) +
      dlSRow("完成 / 失败时提示", "右下角 Toast 提示下载结果", dlSw("notify", c.notify)) +
    '</div>' +
    '<div class="dlc-sec"><h3><i class="bi bi-file-earmark-zip"></i>打包' +
      '<small>新建下载时的默认打包方式</small></h3>' +
      dlSRow("压缩级别", "0 = 仅存储（最快、包最大）；6 = 默认；9 = 最高压缩（最慢）",
        dlSel("zip_level", [{ v: 0, t: "0 · 仅存储" }, { v: 1, t: "1 · 最快" }, { v: 3, t: "3" },
          { v: 6, t: "6 · 默认" }, { v: 9, t: "9 · 最高" }], c.zip_level)) +
      dlSRow("包含隐藏文件", "打包时带上 .env、.gitignore 这类点开头的文件",
        dlSw("include_hidden", c.include_hidden)) +
      dlSRow("保留目录结构", "关闭后所有文件平铺在压缩包根目录（重名自动加序号）",
        dlSw("keep_structure", c.keep_structure)) +
    '</div>' +
    '<div class="dlc-sec"><h3><i class="bi bi-globe2"></i>网络下载' +
      '<small>链接 / 磁力 的默认参数（服务器端多线程抓取）</small></h3>' +
      dlSRow("默认保存目录",
        "新建链接下载时落盘的位置；磁力 / BT 也下载到这里",
        '<div class="dlc-pathbox"><span><bdi>' + esc(c.save_dir || c.artifact_dir || "-") + '</bdi></span></div>' +
        '<button class="dlc-btn sm" data-act="picknetdir"><i class="bi bi-folder2-open"></i>选择</button>') +
      dlSRow("默认线程数", "HTTP / HTTPS 多线程分段下载的连接数（1–32，FTP 始终单连接）",
        dlNum("threads", c.threads)) +
      dlSRow("默认代理", "留空则走系统 / 环境变量代理；例：http://127.0.0.1:7890",
        '<input class="dlc-input" type="text" data-cfg="proxy" data-kind="str" ' +
        'placeholder="http://127.0.0.1:7890" value="' + dlA(c.proxy || "") + '" style="width:220px">') +
    '</div>' +
    '<div class="dlc-sec"><h3><i class="bi bi-hdd-stack"></i>存储' +
      '<small>产物与记录占用</small></h3>' +
      '<div class="dlc-srow"><div class="dlc-sinfo"><div class="dlc-slabel">当前占用</div>' +
        '<div class="dlc-sdesc">产物目录里未被清理的 zip / 文本文件</div>' +
        '<div class="dlc-usage">' +
          '<div><span>产物文件</span><b>' + (u.artifacts || 0) + ' 个</b></div>' +
          '<div><span>磁盘占用</span><b>' + dlSize(u.artifact_bytes || 0) + '</b></div>' +
          '<div><span>记录条数</span><b>' + (u.records || 0) + ' 条</b></div>' +
        '</div></div>' +
        '<div class="dlc-sctl"><button class="dlc-btn sm danger" data-act="clean">' +
          '<i class="bi bi-eraser"></i>清理产物</button></div></div>' +
      '<div style="margin-top:10px;font-size:11px;color:var(--dlc-dim);line-height:1.8">' +
        '提示：单文件下载直接读源文件，不复制；只有「多文件 / 文件夹」才生成 zip 产物。' +
        '清理产物后记录仍在，重新下载会提示「请重新创建任务」。</div>' +
    '</div>';
}
/* ---------------- 事件 ---------------- */
function dlFindTask(id) {
  return (DL.tasks || []).filter(function (x) { return x.id === id; })[0] ||
    (DL.items || []).filter(function (x) { return x.id === id; })[0] || null;
}
/* 「打开」按钮：产物存在时，用内置编辑器区打开（视频/音频/图片走内嵌播放器，
 * zip 走压缩包查看器，文本走编辑器）。产物路径是服务器绝对路径，/api/stream、
 * /api/preview 均支持任意绝对路径，openFile 能正确按扩展名分发。 */
function dlOpenBtn(t) {
  if (!t || !t.exists || !t.artifact) return "";
  const ext = String(t.name || t.artifact || "").split(".").pop().toLowerCase();
  const media = ["mp4", "mkv", "webm", "avi", "mov", "flv", "m4v", "ts", "wmv",
    "mp3", "wav", "flac", "aac", "m4a", "ogg", "opus",
    "jpg", "jpeg", "png", "gif", "webp", "bmp", "svg"].indexOf(ext) >= 0;
  return '<button class="dlc-iconbtn" data-act="open" title="' +
    (media ? "用内置播放器打开" : "用内置编辑器打开") +
    '"><i class="bi ' + (media ? "bi-play-circle" : "bi-file-earmark-text") + '"></i></button>';
}
function dlOpenArtifact(id) {
  const t = dlFindTask(id);
  if (!t || !t.exists || !t.artifact) { toast("产物不存在或已被清理", "warn"); return; }
  if (typeof openFile !== "function") { toast("编辑器未就绪，请刷新页面", "err"); return; }
  openFile(t.artifact, t.name || String(t.artifact).split("/").pop());
}
function dlOnClick(e) {
  const el = e.target.closest("[data-act]");
  if (!el) return;
  const act = el.dataset.act;
  const row = el.closest("[data-id]");
  const id = row ? row.dataset.id : "";
  const t = id ? dlFindTask(id) : null;
  if (act === "new") return dlPickOpen({});
  if (act === "tab-act" || act === "tab-fin") {
    DL.tab = act === "tab-act" ? "act" : "fin";
    return dlRender();
  }
  if (act === "refresh") return dlReload();
  if (act === "cur") return dlAddCurrent();
  if (act === "export") { window.open("/api/dl/export.csv", "_blank"); return; }
  if (act === "clear") return dlClearRecords();
  if (act === "clean") return dlCleanArtifacts();
  if (act === "reset-cfg") return dlResetCfg();
  if (act === "pickdir") return dlPickDir();
  if (act === "picknetdir") return dlPickNetDir();
  if (act === "p-prev") { if (DL.page > 1) { DL.page--; dlLoadRecords(); } return; }
  if (act === "p-next") { if (DL.page < DL.pages) { DL.page++; dlLoadRecords(); } return; }
  if (act === "sel-del") return dlDeleteSelected();
  if (act === "sel-clear") { DL.sel = {}; return dlSelRefresh(); }
  if (!t && (act === "start" || act === "retry")) { toast("任务信息已过期，请刷新", "warn"); return; }
  if (act === "start") return dlStartTask(t);
  if (act === "pause") return dlStopTask(id);
  if (act === "cancel") return dlTaskAction(id, "cancel").then(function () { dlReload(true); });
  if (act === "reset") return dlTaskAction(id, "reset").then(function () { dlReload(true); });
  if (act === "delete") return dlDeleteTask(id);
  if (act === "native") return dlConfirmNative(el, id);
  if (act === "open") return dlOpenArtifact(id);
  if (act === "copy") return dlCopyLink(id);
  if (act === "segs") return dlSegsOpen(id);
}
let _dlRecTimer = 0;
function dlOnInput(e) {
  if (e.target.id !== "dlRecKw") return;
  clearTimeout(_dlRecTimer);
  const v = e.target.value;
  _dlRecTimer = setTimeout(function () {
    DL.kw = v.trim(); DL.page = 1; dlLoadRecords();
  }, 280);
}
function dlOnChange(e) {
  const ck = e.target.closest ? e.target.closest("input.dlc-ck") : null;
  if (ck) {                                  // 记录多选：单行勾选 / 表头全选
    if (ck.id === "dlSelAll") {
      DL.sel = {};
      if (ck.checked) DL.items.forEach(function (t) { DL.sel[t.id] = 1; });
    } else if (ck.dataset.id) {
      if (ck.checked) DL.sel[ck.dataset.id] = 1;
      else delete DL.sel[ck.dataset.id];
    }
    return dlSelRefresh();
  }
  if (e.target.id === "dlRecStatus") {
    DL.status = e.target.value || "all";
    DL.page = 1;
    return dlLoadRecords();
  }
  const el = e.target.closest("[data-cfg]");
  if (!el) return;
  const key = el.dataset.cfg;
  const kind = el.dataset.kind;
  const val = kind === "bool" ? !!el.checked : (kind === "num" ? Number(el.value) : el.value);
  const patch = {};
  patch[key] = val;
  dlSaveCfg(patch);
}

/* ---------------- 任务操作 ---------------- */
async function dlTaskAction(id, action, extra) {
  const d = await dlReq("/api/dl/tasks/" + encodeURIComponent(id) + "/action", {
    method: "POST",
    body: JSON.stringify(Object.assign({ action: action }, extra || {})),
  });
  if (!d.ok) { toast(d.error || "操作失败", "err"); return null; }
  return d.task || null;
}

/* ---------------- 切片查看：m3u8 分片下载 / 重试情况 ---------------- */
let _dlSegsTimer = 0;
function dlSegsMask() {
  let m = document.getElementById("dlcSegsMask");
  if (!m) {
    m = document.createElement("div");
    m.id = "dlcSegsMask";
    m.className = "dlc-mask";
    m.addEventListener("click", function (e) {
      if (e.target === m || e.target.closest("[data-segs]")) dlSegsClose();
    });
    document.body.appendChild(m);
  }
  return m;
}
function dlSegsClose() {
  clearInterval(_dlSegsTimer);
  const m = document.getElementById("dlcSegsMask");
  if (m) { m.classList.remove("show"); m.innerHTML = ""; }
}
async function dlSegsOpen(id) {
  const m = dlSegsMask();
  m.innerHTML = '<div class="dlc-pick dlc-segs"><div class="dlc-loading">加载中…</div></div>';
  m.classList.add("show");
  clearInterval(_dlSegsTimer);
  const tick = function () {
    const mm = document.getElementById("dlcSegsMask");
    if (!mm || !mm.classList.contains("show")) { clearInterval(_dlSegsTimer); return; }
    dlSegsPaint(id);
  };
  await dlSegsPaint(id);
  _dlSegsTimer = setInterval(tick, 2000);
}
const SEGS_ST_TXT = { ok: "已完成", run: "下载中", retry: "重试中", wait: "等待", fail: "失败" };
async function dlSegsPaint(id) {
  const m = document.getElementById("dlcSegsMask");
  const box = m ? m.querySelector(".dlc-segs") : null;
  if (!box) return;
  const d = await dlReq("/api/dl/tasks/" + encodeURIComponent(id) + "/segs")
    .catch(function () { return null; });
  if (!d || !d.ok) {
    box.innerHTML = '<div class="dlc-loading">' + esc((d && d.error) || "加载失败") + '</div>';
    return;
  }
  const sv = d.segs;
  let head = '<div class="dlc-segs-head">' +
    '<i class="bi bi-stack"></i><b class="dlc-segs-title">' + esc(d.name || "任务") + '</b>' +
    '<span class="dlc-pill ' + esc(d.status || "") + '">' + esc(dlStatusText(d.status || "", null)) + '</span>' +
    '<span class="dlc-sp"></span>' +
    '<button class="dlc-iconbtn" data-segs="close" title="关闭"><i class="bi bi-x-lg"></i></button>' +
    '</div>';
  let body = "";
  if (sv && sv.mode === "ffmpeg") {
    // 加密流：展示 ffmpeg 整体拉流指标
    const run = d.status === "downloading";
    const stale = run && sv.ts > 0 && (Date.now() / 1000 - sv.ts) > 8;
    const total = Number(sv.total) || 0;
    const cells = [];
    if (sv.out_time) cells.push(["已处理时长", sv.out_time]);
    if (total > 0) cells.push(["总时长", dlDur(total)]);
    if (sv.speed) cells.push(["拉流速度", sv.speed + "（相对时长）"]);
    if (sv.bitrate) cells.push(["平均码率", sv.bitrate]);
    if (sv.size) cells.push(["已产出", dlSize(Number(sv.size) || 0)]);
    body = '<div class="dlc-ffstat">' +
      '<div class="dlc-ffrow"><span>整体进度</span><b>' + (sv.percent || 0) + '%</b></div>' +
      '<div class="dlc-bar"><i style="width:' + (sv.percent || 0) + '%"></i></div>' +
      (cells.length
        ? '<div class="dlc-ffgrid">' + cells.map(function (c) {
            return '<div><label>' + esc(c[0]) + '</label><b>' + esc(c[1]) + '</b></div>';
          }).join("") + '</div>'
        : '<div class="dlc-loading">正在启动 ffmpeg，等待第一个进度包…</div>') +
      (stale ? '<p class="dlc-ffwarn"><i class="bi bi-exclamation-triangle"></i> ' +
        Math.round(Date.now() / 1000 - sv.ts) + ' 秒没有新进度——大概率是源站限速，只能慢慢等；不是程序卡死。</p>' : '') +
      '<p class="dlc-ffnote">该任务为加密 HLS 流，由 ffmpeg 单连接整体拉流解密封装，' +
      '不按切片下载，因此没有单切片状态。速度取决于源站，暂停后继续会从头重新下载。</p>' +
      '</div>';
  } else if (!sv || !sv.segs || !Object.keys(sv.segs).length) {
    body = '<div class="dlc-segs-empty">' +
      '<i class="bi bi-inbox"></i><b>暂无切片信息</b>' +
      '<p>分片台账在下载过程中生成；任务合并完成后切片数据会随临时目录清理。</p>' +
      '</div>';
  } else {
    const segs = sv.segs;
    const keys = Object.keys(segs).sort(function (a, b) {
      return (parseInt(a, 10) || 0) - (parseInt(b, 10) || 0);
    });
    const cnt = { ok: 0, run: 0, retry: 0, wait: 0, fail: 0 };
    keys.forEach(function (k) {
      const s = segs[k] || {};
      const st = s.st || "wait";
      cnt[st] = (cnt[st] || 0) + 1;
    });
    const retryN = keys.filter(function (k) { return (segs[k].tries || 0) > 0; }).length;
    body = '<div class="dlc-segs-sum">' +
      '<span>共 <b>' + keys.length + '</b> 片</span>' +
      '<span class="ok"><i class="bi bi-check2"></i>完成 ' + (cnt.ok || 0) + '</span>' +
      '<span class="run"><i class="bi bi-arrow-down"></i>下载中 ' + (cnt.run || 0) + '</span>' +
      '<span class="retry"><i class="bi bi-arrow-repeat"></i>重试中 ' + (cnt.retry || 0) + '</span>' +
      '<span class="wait"><i class="bi bi-hourglass"></i>等待 ' + (cnt.wait || 0) + '</span>' +
      '<span class="bad"><i class="bi bi-x"></i>失败 ' + (cnt.fail || 0) + '</span>' +
      (retryN ? '<span class="warn"><i class="bi bi-history"></i>触发过重试 ' + retryN + ' 片</span>' : '') +
      '</div>';
    body += '<div class="dlc-segs-grid">';
    keys.forEach(function (k) {
      const s = segs[k] || {};
      const st = s.st || "wait";
      const isInit = k === "init";
      const label = isInit ? "init" : (parseInt(k, 10) + 1);
      const bits = ["#" + label + " · " + (SEGS_ST_TXT[st] || st)];
      if (s.tries > 0) bits.push("尝试 " + (s.tries + (st === "fail" ? 0 : 1)) + " 次");
      if (s.size) bits.push(dlSize(s.size));
      if (s.err) bits.push(s.err);
      body += '<div class="dlc-segc ' + esc(st) + '" title="' + dlA(bits.join(" · ")) + '">' +
        esc(String(label)) +
        (s.tries > 0 && st !== "fail" ? '<u>' + s.tries + '</u>' : '') +
        (st === "fail" ? '<i class="bi bi-x"></i>' : '') +
        '</div>';
    });
    body += '</div>';
  }
  box.innerHTML = head + '<div class="dlc-segs-body">' + body + '</div>';
}

async function dlStartTask(t) {
  if (!t || DL.running[t.id]) return;
  if (dlIsRemote(t)) {
    // 网络下载由服务器完成；已就绪且产物还在 → 直接拉到本机
    // 产物已被清理（重启清理 / 手动清理）→ 不开新标签页，改为让服务器重新抓一遍
    if ((t.status === "ready" || t.status === "done") && t.exists !== false) return dlNative(t.id);
    await dlTaskAction(t.id, "start");
    return dlReload(true);
  }
  if (t.status === "building" || t.status === "pending") { toast("还在打包，请稍候", "warn"); return; }
  if (!t.exists) { toast("产物已被清理，请重新创建任务", "err"); return; }
  const cfg = DL.cfg || {};
  const max = Math.max(1, Number(cfg.concurrency) || 2);
  if (Object.keys(DL.running).length >= max) {
    toast("已达同时下载上限（" + max + " 个），先暂停一个再试", "warn");
    return;
  }
  // 用后端返回的最新任务（已下完的任务会被重置游标），避免拿旧的 done 去续传
  const nt = await dlTaskAction(t.id, "start");
  dlTransfer(nt || t);
}

function dlStopTask(id) {
  const t = dlFindTask(id);
  if (t && dlIsRemote(t)) {                     // 服务器端下载：让引擎停下并保存分片进度
    dlTaskAction(id, "pause").then(function () { dlReload(true); });
    return;
  }
  const st = DL.running[id];
  if (!st) { toast("该任务当前没有在传输", "warn"); return; }
  try { st.ctrl.abort(); } catch (_) { }
}
function dlStopAll() {
  Object.keys(DL.running).forEach(function (id) {
    try { DL.running[id].ctrl.abort(); } catch (_) { }
  });
}

async function dlDeleteTask(id) {
  const ok = await uiConfirm("删除下载任务",
    "会同时移除这条下载记录，并删除打包产生的 zip 文件（源文件不受影响）。", "删除", true);
  if (!ok) return;
  const d = await dlReq("/api/dl/tasks/" + encodeURIComponent(id) + "/action", {
    method: "POST", body: JSON.stringify({ action: "delete" }),
  });
  if (!d.ok) { toast(d.error || "删除失败", "err"); return; }
  delete DL.running[id];
  delete DL.handles[id];
  toast("已删除", "ok");
  dlReload(true);
}

/* ---------------- 记录多选：勾选 / 全选 / 批量删除 ---------------- */
function dlSelCount() { return Object.keys(DL.sel).length; }
function dlSelPrune() {                       // 只保留当前列表里存在的选中项
  const ids = {};
  (DL.items || []).forEach(function (t) { ids[t.id] = 1; });
  Object.keys(DL.sel).forEach(function (id) { if (!ids[id]) delete DL.sel[id]; });
}
function dlSelRefresh() {                     // 不重绘表格，只刷新选中相关 UI
  const n = dlSelCount();
  const bar = document.querySelector("#dlScroll .dlc-selbar");
  if (bar) {
    bar.hidden = n === 0;
    const b = bar.querySelector("b");
    if (b) b.textContent = n;
  }
  const all = document.getElementById("dlSelAll");
  if (all) {
    all.checked = n > 0 && DL.items.length > 0 && n === DL.items.length;
    all.indeterminate = n > 0 && n < DL.items.length;
  }
  document.querySelectorAll("#dlScroll .dlc-rrow").forEach(function (tr) {
    const on = !!DL.sel[tr.dataset.id];
    tr.classList.toggle("sel", on);
    const ck = tr.querySelector("input.dlc-ck");
    if (ck) ck.checked = on;               // 同步行内勾选框（全选 / 全不选 / 右键菜单触发时）
  });
}
/* 批量删除确认（带「是否删除服务器上的下载文件」勾选）：
 * 返回 Promise<{ok:true, delFiles:boolean}> 或 {ok:false} */
function dlAskDelSel(n) {
  return new Promise(function (resolve) {
    const m = document.createElement("div");
    m.className = "dlc-mask";
    m.innerHTML =
      '<div class="dlc-delbox">' +
        '<div class="dlc-cpop-tt"><i class="bi bi-exclamation-triangle"></i>批量删除下载记录</div>' +
        '<div class="dlc-cpop-msg" id="dlDelMsg"></div>' +
        '<label class="dlc-delck"><input type="checkbox" id="dlDelFilesChk" checked>' +
          '<span>同时删除服务器上的下载文件</span></label>' +
        '<div class="dlc-cpop-btns">' +
          '<button class="dlc-cpop-no">取消</button>' +
          '<button class="dlc-cpop-ok"><i class="bi bi-trash3"></i>删除</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(m);
    const msg = m.querySelector("#dlDelMsg");
    const ck = m.querySelector("#dlDelFilesChk");
    const paintMsg = function () {
      msg.innerHTML = ck.checked
        ? '将删除选中的 <b>' + n + '</b> 条记录，<b>服务器上的下载文件会被一并删除</b>（来源源文件不受影响）。'
        : '将删除选中的 <b>' + n + '</b> 条记录，服务器上的下载文件会保留，源文件不受影响。';
      msg.classList.toggle("warn", ck.checked);
    };
    ck.addEventListener("change", paintMsg);
    paintMsg();
    requestAnimationFrame(function () { m.classList.add("show"); });
    const onKey = function (ev) {
      if (ev.key === "Escape") { ev.stopPropagation(); done({ ok: false }); }
    };
    const done = function (val) {
      m.classList.remove("show");
      setTimeout(function () { m.remove(); }, 180);
      document.removeEventListener("keydown", onKey, true);
      resolve(val);
    };
    document.addEventListener("keydown", onKey, true);
    m.addEventListener("click", function (ev) {
      if (ev.target === m) return done({ ok: false });
      if (ev.target.closest(".dlc-cpop-no")) return done({ ok: false });
      if (ev.target.closest(".dlc-cpop-ok")) {
        return done({ ok: true, delFiles: m.querySelector("#dlDelFilesChk").checked });
      }
    });
  });
}
async function dlDeleteSelected() {
  const ids = Object.keys(DL.sel);
  if (!ids.length) { toast("请先勾选要删除的记录", "warn"); return; }
  const res = await dlAskDelSel(ids.length);
  if (!res || !res.ok) return;
  const keepFile = !res.delFiles;               // 勾选 = 连产物一起删；不勾 = 只删记录
  let okN = 0, failN = 0;
  for (let i = 0; i < ids.length; i++) {
    try {
      const d = await dlReq("/api/dl/tasks/" + encodeURIComponent(ids[i]) + "/action",
        { method: "POST", body: JSON.stringify({ action: "delete", keep_file: keepFile }) });
      if (d.ok) { okN++; delete DL.running[ids[i]]; delete DL.handles[ids[i]]; }
      else failN++;
    } catch (_) { failN++; }
  }
  DL.sel = {};
  toast("已删除 " + okN + " 条记录" +
    (keepFile ? "及对应文件" : "（服务器文件已保留）") +
    (failN ? "，失败 " + failN + " 条" : ""), failN ? "warn" : "ok");
  dlReload(true);
}

/* ---------------- 右键菜单：复用 IDE 菜单组件 renderDrop（与编辑器菜单同一套样式与定位） ---------------- */
function dlCtxOpen(e, id) {
  const t = id ? dlFindTask(id) : null;
  const px = e.clientX, py = e.clientY;        // 右键坐标：确认悬浮框的定位锚点
  const items = [];
  if (t) {
    if (t.exists) items.push({ label: "打开 / 播放", icon: "bi-play-circle", act: () => dlOpenArtifact(id) });
    if (t.exists) items.push({ label: "下载到本机", icon: "bi-download",
      act: () => dlConfirmNative({ x: px, y: py }, id) });
    if (!t.exists && dlIsRemote(t))
      items.push({ label: "重新下载到服务器", icon: "bi-arrow-repeat", act: () => dlStartTask(t) });
    items.push({ label: "复制下载链接", icon: "bi-link-45deg", act: () => dlCopyLink(id) });
    items.push({ divider: true });
    items.push({ label: "删除记录", icon: "bi-trash3", danger: true, act: () => dlDeleteTask(id) });
  } else {
    items.push({ label: "全选 / 全不选", icon: "bi-check2-all", act: () => {
      const all = document.getElementById("dlSelAll");
      if (all) { all.checked = dlSelCount() !== DL.items.length; dlOnChange({ target: all }); }
    } });
  }
  if (dlSelCount() > 0) {
    items.push({ divider: true });
    items.push({ label: "删除所选（" + dlSelCount() + " 条）", icon: "bi-trash3", danger: true,
      act: () => dlDeleteSelected() });
  }
  renderDrop(items, null, "dl-ctx", { x: e.clientX, y: e.clientY });
}
function dlOnCtx(e) {
  if (!e.target.closest(".dlc-tablewrap")) return;   // 只接管记录表格区域
  e.preventDefault();
  e.stopPropagation();   // 下载中心是编辑器里的一个 cm-host 标签：不阻断冒泡的话，
                         // 02_ 的 edGroups contextmenu 会再弹「保存 / 运行当前文件」菜单
  const row = e.target.closest(".dlc-rrow");
  dlCtxOpen(e, row && row.dataset.id ? row.dataset.id : "");
}

async function dlClearRecords() {
  const ok = await uiConfirm("清空下载记录",
    "只清除已结束（已完成 / 失败 / 取消）的记录，进行中的任务会保留。", "清空", true);
  if (!ok) return;
  const d = await dlReq("/api/dl/clean", { method: "POST", body: JSON.stringify({ what: "finished" }) });
  if (!d.ok) { toast(d.error || "清空失败", "err"); return; }
  toast(d.message || "已清空", "ok");
  DL.page = 1;
  dlLoadTasks(true);
  if (DL.view === "records") dlLoadRecords();
}

async function dlCleanArtifacts() {
  const ok = await uiConfirm("清理产物文件",
    "删除所有已结束任务的 zip / 文本产物，释放磁盘空间；下载记录会保留。", "清理", true);
  if (!ok) return;
  const d = await dlReq("/api/dl/clean", { method: "POST", body: JSON.stringify({ what: "artifacts" }) });
  if (!d.ok) { toast(d.error || "清理失败", "err"); return; }
  toast(d.message || "已清理", "ok");
  dlLoadUsage();
  dlLoadTasks(true);
}

const DL_CFG_DEFAULT = {
  keep_days: 7, max_rows: 500, resume: true, use_fs: true, auto_start: true,
  notify: true, concurrency: 2, throttle_kbps: 0, zip_level: 6,
  include_hidden: false, keep_structure: true,
};

async function dlSaveCfg(patch) {
  const d = await dlReq("/api/dl/settings", { method: "POST", body: JSON.stringify(patch) });
  if (!d.ok) { toast(d.error || "保存失败", "err"); return; }
  DL.cfg = d.settings || DL.cfg;
  DL.usage = d.usage || DL.usage;
  dlPaintNav();
  toast("设置已保存", "ok");
}
async function dlResetCfg() {
  const ok = await uiConfirm("恢复默认设置", "所有下载设置（除产物目录外）恢复为默认值。", "恢复", false);
  if (!ok) return;
  const patch = Object.assign({}, DL_CFG_DEFAULT);
  patch.artifact_dir = (DL.cfg || {}).artifact_dir;
  const d = await dlReq("/api/dl/settings", { method: "POST", body: JSON.stringify(patch) });
  if (!d.ok) { toast(d.error || "恢复失败", "err"); return; }
  DL.cfg = d.settings;
  toast("已恢复默认", "ok");
  dlRenderSettings();
}

async function dlAddCurrent() {
  const p = (typeof active !== "undefined" && active && active.path) || "";
  if (!p || p.charAt(0) === "\u0000") { toast("请先在编辑器里打开一个文件", "warn"); return; }
  const d = await dlReq("/api/dl/tasks", {
    method: "POST", body: JSON.stringify({ paths: [p], kind: "file" }),
  });
  if (!d.ok) { toast(d.error || "创建失败", "err"); return; }
  toast("已加入下载：" + d.task.name, "ok");
  if (DL.view !== "tasks") dlView("tasks");
  await dlLoadTasks(true);
  if ((DL.cfg || {}).auto_start) DL.pendingAuto.push(d.task.id);
  dlKickAuto();
}

/* ---------------- 下载按钮二次确认悬浮框 ---------------- */
function dlConfirmClose() {
  const p = document.getElementById("dlcCpop");
  if (p) p.remove();
  document.removeEventListener("mousedown", dlConfirmOut, true);
  document.removeEventListener("keydown", dlConfirmKey, true);
  window.removeEventListener("resize", dlConfirmClose);
  window.removeEventListener("scroll", dlConfirmClose, true);
}
function dlConfirmOut(e) {
  const p = document.getElementById("dlcCpop");
  if (p && !p.contains(e.target)) dlConfirmClose();
}
function dlConfirmKey(e) {
  if (e.key === "Escape") { e.stopPropagation(); dlConfirmClose(); }
}
function dlConfirmNative(btn, id) {
  const t = dlFindTask(id) || {};
  const old = document.getElementById("dlcCpop");
  if (old && old._btn === btn) return dlConfirmClose();      // 再点同一按钮 → 关闭
  dlConfirmClose();
  const p = document.createElement("div");
  p.id = "dlcCpop";
  p._btn = btn;
  p.innerHTML =
    '<div class="dlc-cpop-tt"><i class="bi bi-download"></i>下载到本机</div>' +
    '<div class="dlc-cpop-nm" title="' + dlA(t.name || id) + '">' + esc(t.name || id) + '</div>' +
    '<div class="dlc-cpop-msg">将交给浏览器 / 下载工具直链下载' +
      (t.size ? "（" + dlSize(t.size) + "）" : "") + '，确定继续？</div>' +
    '<div class="dlc-cpop-btns">' +
      '<button class="dlc-cpop-ok"><i class="bi bi-check-lg"></i>确认下载</button>' +
      '<button class="dlc-cpop-no">取消</button>' +
    '</div>';
  document.body.appendChild(p);
  const pr = p.getBoundingClientRect();
  let top, left;
  if (btn && typeof btn.getBoundingClientRect === "function") {
    const r = btn.getBoundingClientRect();       // 按钮触发：浮框贴按钮上方
    top = r.top - pr.height - 8;
    if (top < 8) top = Math.min(r.bottom + 8, window.innerHeight - pr.height - 8);
    left = Math.min(Math.max(8, r.left + r.width / 2 - pr.width / 2),
                    window.innerWidth - pr.width - 8);
  } else {
    // 右键菜单触发：菜单项点击后即被移除，改用右键坐标定位
    const pt = (btn && typeof btn.x === "number") ? btn
      : { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    top = pt.y - pr.height - 10;
    if (top < 8) top = Math.min(pt.y + 10, window.innerHeight - pr.height - 8);
    left = Math.min(Math.max(8, pt.x - pr.width / 2), window.innerWidth - pr.width - 8);
  }
  p.style.top = Math.max(8, top) + "px";
  p.style.left = left + "px";
  p.querySelector(".dlc-cpop-ok").addEventListener("click", function () {
    dlConfirmClose();
    dlNative(id);
  });
  p.querySelector(".dlc-cpop-no").addEventListener("click", dlConfirmClose);
  document.addEventListener("mousedown", dlConfirmOut, true);
  document.addEventListener("keydown", dlConfirmKey, true);
  window.addEventListener("resize", dlConfirmClose);
  window.addEventListener("scroll", dlConfirmClose, true);
}
function dlNative(id) {
  const url = "/api/dl/stream/" + encodeURIComponent(id);
  const w = window.open(url, "_blank");
  if (!w) { window.location.href = url; }
  toast("已交给浏览器下载（可断点续传）", "ok");
}
function dlCopyLink(id) {
  const url = location.origin + "/api/dl/stream/" + encodeURIComponent(id);
  const done = function () { toast("下载链接已复制（需登录态，也可给 aria2 / IDM 用）", "ok"); };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(done).catch(function () { window.prompt("复制下载链接", url); });
  } else if (typeof copyText === "function") {
    try { copyText(url); done(); } catch (_) { window.prompt("复制下载链接", url); }
  } else {
    window.prompt("复制下载链接", url);
  }
}

/* ---------------- 传输引擎（断点续传） ---------------- */
async function dlTransfer(t) {
  if (!t || DL.running[t.id]) return;
  const cfg = DL.cfg || {};
  const size = t.size || 0;
  let start = 0;
  if (cfg.resume !== false && t.done > 0 && t.done < size) start = t.done;

  let writable = null, useFs = false, chunks = null;
  // 1) 优先 File System Access API：真正写盘 + 可跨刷新续写
  if (window.showSaveFilePicker && cfg.use_fs !== false) {
    try {
      let h = DL.handles[t.id] || null;
      if (!h) {
        h = await window.showSaveFilePicker({ suggestedName: t.name });
        DL.handles[t.id] = h;
      }
      writable = await h.createWritable({ keepExistingData: start > 0 });
      if (start > 0 && writable.seek) await writable.seek(start);
      useFs = true;
    } catch (e) {
      if (e && e.name === "AbortError") { toast("已取消选择保存位置", "warn"); return; }
      writable = null;
      useFs = false;
    }
  }
  if (!useFs) {
    if (start > 0 && !DL.handles[t.id]) start = 0;      // 内存方式无法跨会话续写
    if (size > 1.5 * 1024 * 1024 * 1024 && !DL.handles[t.id]) {
      toast("文件超过 1.5GB，已改用浏览器原生下载（同样支持续传）", "warn");
      dlNative(t.id);
      return;
    }
    chunks = [];
  }

  const ctrl = new AbortController();
  const state = {
    ctrl: ctrl, bytes: start, total: size, speed: 0,
    lastT: performance.now(), lastB: start, writable: writable, useFs: useFs, chunks: chunks,
  };
  DL.running[t.id] = state;
  DL.tasks.forEach(function (x) { if (x.id === t.id) x.status = "downloading"; });
  if (DL.view === "tasks") dlRenderTasks();
  dlProgress(t.id, start, "downloading");

  let lastPost = 0, lastPaint = 0, got = start, completed = false;
  try {
    const res = await fetch("/api/dl/stream/" + encodeURIComponent(t.id), {
      method: "GET",
      headers: start > 0 ? { Range: "bytes=" + start + "-" } : {},
      signal: ctrl.signal, credentials: "same-origin", cache: "no-store",
    });
    if (res.status === 409) throw new Error("还在打包，请稍候再试");
    if (res.status === 410) throw new Error("产物已被清理，请重新创建任务");
    if (!res.ok && res.status !== 206) throw new Error("下载失败（HTTP " + res.status + "）");
    const cl = parseInt(res.headers.get("Content-Length") || "0", 10) || 0;
    if (!state.total) state.total = start + cl;

    const reader = res.body.getReader();
    const limit = Math.max(0, Number(cfg.throttle_kbps) || 0) * 1024;   // 字节/秒
    const tStart = performance.now();
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      const chunk = r.value;
      if (!chunk || !chunk.length) continue;
      if (useFs) await writable.write(chunk);
      else chunks.push(chunk);
      got += chunk.length;
      state.bytes = got;
      const now = performance.now();
      if (now - state.lastT >= 400) {
        state.speed = (got - state.lastB) / ((now - state.lastT) / 1000);
        state.lastT = now;
        state.lastB = got;
      }
      if (limit > 0) {
        const expect = (got - start) / limit * 1000;
        const spent = now - tStart;
        if (expect > spent) {
          await new Promise(function (r2) { setTimeout(r2, Math.min(600, expect - spent)); });
        }
      }
      if (now - lastPaint > 220) { lastPaint = now; dlPaintLive(t.id); }
      if (Date.now() - lastPost > 2000) { lastPost = Date.now(); dlProgress(t.id, got, ""); }
    }

    if (useFs && writable) {
      await writable.close();
    } else {
      const blob = new Blob(chunks, { type: "application/octet-stream" });
      chunks = null;
      dlSaveBlob(blob, t.name);
    }
    await dlProgress(t.id, state.total || got, "done");
    completed = true;
    delete DL.running[t.id];
    DL.handles[t.id] = null;
    if (cfg.notify !== false) toast("下载完成：" + t.name + "（" + dlSize(state.total || got) + "）", "ok");
  } catch (e) {
    const msg = (e && e.message) || "下载中断";
    if (useFs && writable) { try { await writable.close(); } catch (_) { } }
    delete DL.running[t.id];
    if (e && e.name === "AbortError") {
      await dlProgress(t.id, got, "paused");
      toast("已暂停（已保存 " + dlSize(got) + "，可继续续传）", "warn");
    } else {
      await dlProgress(t.id, got, "paused");
      toast(msg, "err");
    }
  } finally {
    if (DL.running[t.id]) delete DL.running[t.id];
    DL.tasks.forEach(function (x) {
      if (x.id === t.id) { x.status = completed ? "done" : "paused"; x.done = got; }
    });
    dlLoadTasks(true);
  }
}

function dlSaveBlob(blob, name) {
  try {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name || "download";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      try { URL.revokeObjectURL(url); a.remove(); } catch (_) { }
    }, 4000);
  } catch (e) {
    toast("保存文件失败：" + (e.message || e), "err");
  }
}
/* ---------------- 可视化目录选择器 ---------------- */
function dlPickOpen(opts) {
  opts = opts || {};
  const P = DL.pick = {
    mode: opts.mode || "files", tab: (opts.mode === "dir" ? "files" : (opts.tab || "files")),
    cb: opts.cb || null, dirFor: "",
    path: opts.path || (typeof ROOT !== "undefined" ? ROOT : ""),
    sep: "/", parent: null, items: [], roots: [], recent: [], sel: [],
    q: "", hidden: false, adv: false,
    url: "", urlName: "", threads: (DL.cfg || {}).threads || 8,
    saveDir: opts.saveDir || (DL.cfg || {}).save_dir || (DL.cfg || {}).artifact_dir || "",
    referer: "", cookie: "", proxy: "", urlAdv: false,
    probe: null, probeInfo: "", footHtml: "", footVal: null,
  };
  let mask = document.getElementById("dlcPickMask");
  if (!mask) {
    mask = document.createElement("div");
    mask.id = "dlcPickMask";
    mask.className = "dlc-mask";
    document.body.appendChild(mask);
  }
  const isDir = P.mode === "dir";
  mask.innerHTML =
    '<div class="dlc-pick">' +
      '<div class="dlc-pick-head">' +
        '<i class="bi ' + (isDir ? "bi-folder2-open" : "bi-cloud-arrow-down") + '"></i>' +
        '<b>' + (isDir ? "选择下载产物目录" : "选择要下载的内容") + '</b>' +
        '<small>' + (isDir ? "打包生成的 zip 会落在这个目录下"
          : "可勾选多个文件与文件夹，文件夹会连同子目录一起打包") + '</small>' +
        '<span style="flex:1"></span>' +
        '<button class="dlc-iconbtn" data-pk="close" title="关闭"><i class="bi bi-x-lg"></i></button>' +
      '</div>' +
      '<div class="dlc-pick-body">' +
        '<div class="dlc-pick-side" id="dlPkSide"></div>' +
        '<div class="dlc-pick-main">' +
          '<div class="dlc-pick-tools">' +
            '<button class="dlc-iconbtn" data-pk="up" title="上一级"><i class="bi bi-arrow-up"></i></button>' +
            '<div class="dlc-crumb" id="dlPkCrumb"></div>' +
            '<button class="dlc-iconbtn" data-pk="new" title="新建文件夹"><i class="bi bi-folder-plus"></i></button>' +
            '<button class="dlc-iconbtn" data-pk="refresh" title="刷新"><i class="bi bi-arrow-clockwise"></i></button>' +
          '</div>' +
          '<div class="dlc-pick-tools" style="padding-top:0;border-bottom:0">' +
            '<div class="dlc-search" style="max-width:none"><i class="bi bi-search"></i>' +
              '<input id="dlPkQ" type="text" placeholder="在当前目录中筛选" spellcheck="false" autocomplete="off"></div>' +
            '<label class="dlc-btn sm" style="cursor:pointer"><input type="checkbox" id="dlPkHidden"> 显示隐藏</label>' +
            (isDir ? "" : '<button class="dlc-btn sm" data-pk="all"><i class="bi bi-check2-square"></i>全选</button>') +
          '</div>' +
          '<div class="dlc-plist" id="dlPkList"></div>' +
        '</div>' +
      '</div>' +
      '<div class="dlc-pick-foot">' +
        (isDir
          ? '<div class="dlc-pick-acts"><span class="dlc-pick-sum" id="dlPkSum"></span>' +
            '<button class="dlc-btn" data-pk="close">取消</button>' +
            '<button class="dlc-btn primary" data-pk="ok"><i class="bi bi-check2"></i>使用此目录</button></div>'
          : '<div class="dlc-pick-opts">' +
              '<label>打包方式 <select class="dlc-select" id="dlPkKind">' +
                '<option value="auto">自动（单个文件直传，其余打包）</option>' +
                '<option value="zip">全部打包成 zip</option>' +
                '<option value="file">不打包（只支持单个文件）</option>' +
              '</select></label>' +
              '<label>压缩包名 <input class="dlc-input" id="dlPkName" type="text" ' +
                'placeholder="留空自动命名" style="width:200px"></label>' +
              '<button class="dlc-btn sm" data-pk="adv"><i class="bi bi-sliders2"></i>高级选项</button>' +
            '</div>' +
            '<div class="dlc-pick-adv" id="dlPkAdv">' +
              '<label>压缩级别 <select class="dlc-select" id="dlPkLevel">' +
                '<option value="0">0 · 仅存储</option><option value="1">1 · 最快</option>' +
                '<option value="3">3</option><option value="6" selected>6 · 默认</option>' +
                '<option value="9">9 · 最高</option></select></label>' +
              '<label><input type="checkbox" id="dlPkStruct" checked> 保留目录结构</label>' +
              '<label><input type="checkbox" id="dlPkIncHidden"> 包含隐藏文件</label>' +
            '</div>' +
            '<div class="dlc-pick-acts">' +
              '<span class="dlc-pick-sum" id="dlPkSum"></span>' +
              '<button class="dlc-btn" data-pk="close">取消</button>' +
              '<button class="dlc-btn primary" data-pk="ok"><i class="bi bi-download"></i>开始下载</button>' +
            '</div>') +
      '</div>' +
    '</div>';

  // 顶部标签：本机文件 / 链接·磁力（目录选择模式下不显示）
  if (!isDir) {
    const headEl = mask.querySelector(".dlc-pick-head");
    if (headEl) {
      headEl.insertAdjacentHTML("afterend",
        '<div class="dlc-pick-tabs">' +
          '<div class="dlc-tab on" data-pk="tab" data-tab="files"><i class="bi bi-hdd"></i>本机文件</div>' +
          '<div class="dlc-tab" data-pk="tab" data-tab="url"><i class="bi bi-globe2"></i>链接 / 磁力</div>' +
          '<span style="flex:1"></span>' +
          '<span class="dlc-tab-hint">本机文件 = 打包下载；链接 = 服务器多线程抓取</span>' +
        '</div>');
    }
    const footEl = mask.querySelector(".dlc-pick-foot");
    if (footEl) footEl.insertAdjacentHTML("beforebegin", '<div class="dlc-pick-urlpage" id="dlPkUrlPage" hidden></div>');
  }

  mask.classList.add("show");
  const cfg = DL.cfg || {};
  const lv = document.getElementById("dlPkLevel");
  if (lv) lv.value = String(cfg.zip_level === undefined ? 6 : cfg.zip_level);
  const st = document.getElementById("dlPkStruct");
  if (st) st.checked = cfg.keep_structure !== false;
  const hd = document.getElementById("dlPkIncHidden");
  if (hd) hd.checked = !!cfg.include_hidden;

  mask.onclick = function (e) {
    const tabEl = e.target.closest(".dlc-tab");
    if (tabEl) { dlPickTabSet(tabEl.dataset.tab); return; }
    const b = e.target.closest("[data-pk]");
    if (b) { dlPickAction(b.dataset.pk, b.dataset.path || ""); return; }
    const item = e.target.closest(".dlc-pitem");
    if (item) { dlPickItem(item); return; }
    if (e.target === mask) dlPickClose();
  };
  mask.ondblclick = function (e) {
    const item = e.target.closest(".dlc-pitem");
    if (item && item.dataset.dir === "1") dlPickLoad(item.dataset.path);
  };
  mask.onchange = function (e) {
    const P = DL.pick;
    if (!P) return;
    if (e.target.id === "dlPkHidden") {
      P.hidden = !!e.target.checked;
      dlPickLoad(P.path);
    }
    if (e.target.id === "dlPkKind") dlPickSum();
    if (e.target.id === "dlPkThreads") P.threads = Number(e.target.value) || 8;
    if (e.target.id === "dlPkUrlName") P.urlName = e.target.value;
    if (e.target.id === "dlPkReferer") P.referer = e.target.value;
    if (e.target.id === "dlPkCookie") P.cookie = e.target.value;
    if (e.target.id === "dlPkProxy") P.proxy = e.target.value;
  };
  mask.oninput = function (e) {
    const P = DL.pick;
    if (!P) return;
    const id = e.target.id;
    if (id === "dlPkQ") { P.q = e.target.value.trim().toLowerCase(); dlPickRenderList(); return; }
    if (id === "dlPkUrl") { P.url = e.target.value; return; }
    if (id === "dlPkUrlName") { P.urlName = e.target.value; return; }
    if (id === "dlPkReferer") { P.referer = e.target.value; return; }
    if (id === "dlPkCookie") { P.cookie = e.target.value; return; }
    if (id === "dlPkProxy") { P.proxy = e.target.value; return; }
  };
  if (!DL.pickEsc) {
    DL.pickEsc = true;
    document.addEventListener("keydown", function (ev) {
      if (ev.key !== "Escape" || !DL.pick) return;
      const m = document.getElementById("dlcPickMask");
      if (m && m.classList.contains("show")) dlPickClose();
    }, true);
  }
  dlLoadEnv();                       // 刷新 aria2 检测状态（磁力 / BT 用）
  if (P.tab === "url") dlPickTabSet("url");
  dlPickLoad(P.path || (typeof ROOT !== "undefined" ? ROOT : ""));
}

function dlPickClose() {
  const m = document.getElementById("dlcPickMask");
  if (m) { m.classList.remove("show"); m.innerHTML = ""; }
  DL.pick = null;
}

/* ---------------- 标签切换：本机文件 ↔ 链接 / 磁力 ---------------- */
function dlPickFooter() {
  const m = document.getElementById("dlcPickMask");
  return m ? m.querySelector(".dlc-pick-foot") : null;
}
function dlPickFootSave() {
  const P = DL.pick, foot = dlPickFooter();
  if (!P || !foot) return;
  P.footHtml = foot.innerHTML;
  const g = function (id) { const el = document.getElementById(id); return el ? el.value : ""; };
  const c = function (id) { const el = document.getElementById(id); return el ? el.checked : false; };
  P.footVal = { kind: g("dlPkKind"), name: g("dlPkName"), level: g("dlPkLevel"),
                struct: c("dlPkStruct"), inc: c("dlPkIncHidden") };
}
function dlPickFootRestore() {
  const P = DL.pick, foot = dlPickFooter();
  if (!P || !foot || !P.footHtml) return;
  foot.innerHTML = P.footHtml;
  const v = P.footVal || {};
  const s = function (id, val) { const el = document.getElementById(id); if (el && val) el.value = val; };
  const k = function (id, on) { const el = document.getElementById(id); if (el) el.checked = !!on; };
  s("dlPkKind", v.kind); s("dlPkName", v.name); s("dlPkLevel", v.level);
  k("dlPkStruct", v.struct); k("dlPkIncHidden", v.inc);
}
function dlPickTabsShow(on) {
  document.querySelectorAll("#dlcPickMask .dlc-pick-tabs").forEach(function (t) {
    t.style.display = on ? "" : "none";
  });
}
function dlPickTabSet(tab) {
  const P = DL.pick;
  if (!P) return;
  const next = tab === "url" ? "url" : "files";
  const m = document.getElementById("dlcPickMask");
  const body = m ? m.querySelector(".dlc-pick-body") : null;
  const page = document.getElementById("dlPkUrlPage");
  const foot = dlPickFooter();
  document.querySelectorAll("#dlcPickMask .dlc-tab").forEach(function (t) {
    t.classList.toggle("on", t.dataset.tab === next);
  });
  if (next === "url") {
    dlPickFootSave();
    if (body) body.style.display = "none";
    if (page) { page.hidden = false; page.innerHTML = dlUrlPageHtml(); }
    if (foot) foot.innerHTML = dlUrlFootHtml();
  } else {
    if (body) body.style.display = "";
    if (page) page.hidden = true;
    if (foot) {
      if (P.mode === "dir") foot.innerHTML = dlDirFootHtml();
      else { foot.innerHTML = P.footHtml || ""; dlPickFootRestore(); }
    }
    dlPickRenderSide();
    dlPickRenderList();
    dlPickSum();
  }
  P.tab = next;
}
function dlUrlFootHtml() {
  return '<div class="dlc-pick-acts">' +
    '<span class="dlc-pick-sum">服务器端多线程抓取，支持断点续传</span>' +
    '<button class="dlc-btn" data-pk="close">取消</button>' +
    '<button class="dlc-btn primary" data-pk="url-ok"><i class="bi bi-cloud-arrow-down"></i>开始下载</button>' +
  '</div>';
}
function dlDirFootHtml() {
  return '<div class="dlc-pick-acts">' +
    '<span class="dlc-pick-sum">选中的目录将作为保存位置</span>' +
    '<button class="dlc-btn" data-pk="close">取消</button>' +
    '<button class="dlc-btn primary" data-pk="ok"><i class="bi bi-check2"></i>使用此目录</button>' +
  '</div>';
}
function dlUrlPageHtml() {
  const P = DL.pick || {};
  const c = DL.cfg || {};
  const th = [1, 2, 4, 8, 12, 16, 24, 32];
  const cur = Number(P.threads || c.threads || 8);
  const opts = th.map(function (n) {
    return '<option value="' + n + '"' + (n === cur ? " selected" : "") + '>' + n + ' 线程</option>';
  }).join("");
  const env = DL.env || {};
  return '<div class="dlc-url">' +
    '<div class="dlc-url-t">下载链接</div>' +
    '<textarea id="dlPkUrl" spellcheck="false" placeholder="粘贴 http:// https:// ftp:// 链接、m3u8 视频地址（自动拼接成 MP4），或 magnet:?xt=urn:btih:… 磁力链接（一行一个，可批量）">' + esc(P.url || "") + '</textarea>' +
    '<div class="dlc-urlrow">' +
      '<span class="dlc-urllab">保存到</span>' +
      '<div class="dlc-pathbox"><span><bdi>' + esc(P.saveDir || c.save_dir || c.artifact_dir || "-") + '</bdi></span></div>' +
      '<button class="dlc-btn sm" data-pk="url-dir"><i class="bi bi-folder2-open"></i>选择</button>' +
      '<button class="dlc-btn sm" data-pk="probe"><i class="bi bi-search"></i>探测</button>' +
    '</div>' +
    '<div class="dlc-urlinfo" id="dlPkUrlInfo">' + (P.probeInfo ||
      '<span style="color:var(--dlc-dim)">点「探测」可先看文件大小、是否支持多线程</span>') + '</div>' +
    '<div class="dlc-urlrow">' +
      '<label>文件名 <input class="dlc-input" id="dlPkUrlName" type="text" placeholder="留空自动识别" style="width:170px" value="' + dlA(P.urlName || "") + '"></label>' +
      '<label>线程数 <select class="dlc-select" id="dlPkThreads">' + opts + '</select></label>' +
      '<button class="dlc-btn sm" data-pk="url-adv"><i class="bi bi-sliders2"></i>高级</button>' +
    '</div>' +
    '<div class="dlc-urladv' + (P.urlAdv ? " show" : "") + '" id="dlPkUrlAdv">' +
      '<label>Referer <input class="dlc-input" id="dlPkReferer" type="text" style="width:200px" value="' + dlA(P.referer || "") + '"></label>' +
      '<label>Cookie <input class="dlc-input" id="dlPkCookie" type="text" style="width:200px" value="' + dlA(P.cookie || "") + '"></label>' +
      '<label>代理 <input class="dlc-input" id="dlPkProxy" type="text" placeholder="http://127.0.0.1:7890" style="width:200px" value="' + dlA(P.proxy || "") + '"></label>' +
    '</div>' +
    '<div class="dlc-urlhint"><i class="bi bi-info-circle"></i> 下载由服务器端完成（多线程分段 + 断点续传），' +
      '完成后可直接在本机任务里「下载到本机」，也可以去文件管理器里直接使用；磁力 / BT 需要服务器已安装 aria2' +
      (env.aria2 ? '（已检测到 aria2c）' : '（<b style="color:var(--dlc-warn)">未检测到 aria2c</b>）') +
      '；m3u8 视频会自动下载全部分片并无损拼接封装为 MP4（加密流需 ffmpeg' +
      (env.ffmpeg ? '，已检测到 ffmpeg）' : '，<b style="color:var(--dlc-warn)">未检测到 ffmpeg，将拼接为 TS</b>）') + '。</div>' +
  '</div>';
}
async function dlPickProbe() {
  const P = DL.pick;
  if (!P) return;
  const box = document.getElementById("dlPkUrlInfo");
  const url = (P.url || "").trim();
  if (!url) { if (box) box.innerHTML = '<span style="color:var(--dlc-warn)">先填链接再探测</span>'; return; }
  if (box) box.innerHTML = '<span>正在解析…</span>';
  const d = await dlReq("/api/dl/probe", { method: "POST", body: JSON.stringify({
    url: url, opts: { referer: P.referer, cookie: P.cookie, proxy: P.proxy } }) });
  if (!box) return;
  if (!d.ok) { box.innerHTML = '<span style="color:var(--dlc-bad)">' + esc((d.error) || "探测失败") + '</span>'; return; }
  const i = d.info || {};
  P.probe = i;
  if (i.hls) {
    P.probeInfo =
      'HLS 视频流（m3u8）· <b>' + (i.segs || 0) + '</b> 个分片 · 时长 <b>' + dlDur(i.duration) + '</b> · ' +
      (i.enc ? '加密流（AES-128）· ' : '') +
      (i.ffmpeg
        ? '<b style="color:var(--dlc-ok)">将自动拼接封装为 MP4</b>'
        : '<b style="color:var(--dlc-warn)">服务器未装 ffmpeg，将拼接为 TS</b>');
  } else {
    P.probeInfo =
      '文件名 <b>' + esc(i.name || "-") + '</b> · 大小 <b>' + dlSize(i.size || 0) + '</b> · ' +
      (i.range ? '<b style="color:var(--dlc-ok)">支持多线程分段</b>' : '<b style="color:var(--dlc-warn)">不支持分段（单线程）</b>') +
      (i.type ? ' · ' + esc(i.type) : "");
  }
  if (!P.urlName && i.name) P.urlName = i.name;
  box.innerHTML = P.probeInfo;
  const nm = document.getElementById("dlPkUrlName");
  if (nm && !nm.value && i.name) nm.value = i.name;
}
async function dlUrlConfirm() {
  const P = DL.pick;
  if (!P) return;
  const raw = (P.url || "").trim();
  if (!raw) { toast("请先粘贴下载链接", "warn"); return; }
  const urls = raw.split(/[\r\n,]+/).map(function (s) { return s.trim(); }).filter(Boolean);
  if (urls.length > 20) { toast("一次最多 20 个链接", "warn"); return; }
  const btn = document.querySelector('#dlcPickMask [data-pk="url-ok"]');
  if (btn) btn.disabled = true;
  let ok = 0, errMsg = "";
  for (let k = 0; k < urls.length; k++) {
    const u = urls[k];
    const d = await dlReq("/api/dl/url", { method: "POST", body: JSON.stringify({
      url: u, save_dir: P.saveDir, filename: urls.length === 1 ? P.urlName : "",
      threads: P.threads, opts: { referer: P.referer, cookie: P.cookie, proxy: P.proxy } }) });
    if (d && d.ok) ok++; else errMsg = (d && d.error) || "创建失败";
  }
  if (btn) btn.disabled = false;
  if (!ok) { toast(errMsg || "创建失败", "err"); return; }
  dlPickClose();
  toast("已开始下载：" + ok + " 个链接（服务器端多线程）", "ok");
  if (DL.view !== "tasks") dlView("tasks");
  dlLoadTasks(true);
}

async function dlPickLoad(path) {
  const P = DL.pick;
  if (!P) return;
  const list = document.getElementById("dlPkList");
  if (list) list.innerHTML = '<div class="dlc-loading">读取目录…</div>';
  const d = await dlReq("/api/dl/browse?path=" + encodeURIComponent(path || "") +
    "&hidden=" + (P.hidden ? 1 : 0));
  if (!DL.pick) return;
  if (!d.ok) {
    if (list) list.innerHTML = '<div class="dlc-loading" style="color:var(--dlc-bad)">' +
      esc(d.error || "读取目录失败") + "</div>";
    return;
  }
  P.path = d.path;
  P.parent = d.parent;
  P.sep = d.sep || "/";
  P.items = d.items || [];
  P.roots = d.roots || [];
  P.recent = d.recent || [];
  dlPickRenderSide();
  dlPickRenderList();
  dlPickSum();
}

function dlPickRenderSide() {
  const P = DL.pick;
  const side = document.getElementById("dlPkSide");
  if (!P || !side) return;
  let h = '<h4>快捷位置</h4>';
  (P.roots || []).forEach(function (r) {
    h += '<div class="dlc-root' + (r.path === P.path ? " on" : "") + '" data-pk="goto" data-path="' +
      dlA(r.path) + '"><i class="bi ' + (r.icon || "bi-folder2") + '"></i>' +
      '<span><bdi>' + esc(r.name) + '</bdi></span></div>';
  });
  if ((P.recent || []).length) {
    h += '<h4>最近使用</h4>';
    P.recent.forEach(function (r) {
      h += '<div class="dlc-root" data-pk="goto" data-path="' + dlA(r.path) + '">' +
        '<i class="bi bi-clock-history"></i><span><bdi>' + esc(r.path) + '</bdi></span></div>';
    });
  }
  if (P.mode !== "dir") {
    h += '<h4>已选 <span style="color:var(--dlc-acc)">' + P.sel.length + '</span></h4>' +
      '<div class="dlc-selbox">';
    if (!P.sel.length) h += '<div class="dlc-selnone">还没有选择内容</div>';
    P.sel.forEach(function (s) {
      h += '<div class="dlc-selitem"><i class="bi ' + (s.is_dir ? "bi-folder-fill" : "bi-file-earmark") + '"></i>' +
        '<span title="' + dlA(s.path) + '">' + esc(s.name) + '</span>' +
        '<button class="dlc-x2" data-pk="unsel" data-path="' + dlA(s.path) + '" title="移除">' +
        '<i class="bi bi-x"></i></button></div>';
    });
    h += "</div>";
  }
  side.innerHTML = h;
}

function dlPickRenderList() {
  const P = DL.pick;
  const list = document.getElementById("dlPkList");
  const crumb = document.getElementById("dlPkCrumb");
  if (!P || !list) return;
  if (crumb) {
    let c = '<a data-pk="goto" data-path="' + dlA(P.sep) + '">' + esc(P.sep) + "</a>";
    let acc = "";
    String(P.path || "").split(P.sep).filter(Boolean).forEach(function (p) {
      acc += P.sep + p;
      c += '<i class="bi bi-chevron-right"></i><a data-pk="goto" data-path="' + dlA(acc) + '">' + esc(p) + "</a>";
    });
    crumb.innerHTML = c;
  }
  const selMap = {};
  P.sel.forEach(function (s) { selMap[s.path] = 1; });
  const kw = P.q || "";
  const items = (P.items || []).filter(function (it) {
    if (P.mode === "dir" && !it.is_dir) return false;
    return !kw || it.name.toLowerCase().indexOf(kw) >= 0;
  });
  if (!items.length) {
    list.innerHTML = '<div class="dlc-loading">' +
      (kw ? "没有匹配的内容" : (P.mode === "dir" ? "这个目录里没有子文件夹" : "这个目录是空的")) + "</div>";
    return;
  }
  list.innerHTML = items.map(function (it) {
    const sel = !!selMap[it.path];
    return '<div class="dlc-pitem' + (it.is_dir ? " dir" : "") + (sel ? " sel" : "") +
      '" data-path="' + dlA(it.path) + '" data-dir="' + (it.is_dir ? 1 : 0) +
      '" data-name="' + dlA(it.name) + '" data-size="' + (it.size || 0) + '">' +
      '<span class="dlc-cb"><i class="bi bi-check"></i></span>' +
      '<i class="bi ' + (it.is_dir ? "bi-folder-fill" : dlIcon({ name: it.name }).i) + '"></i>' +
      '<span class="dlc-pname">' + esc(it.name) + "</span>" +
      (it.is_dir ? "" : '<span class="dlc-psize">' + dlSize(it.size) + "</span>") +
      (it.is_dir ? '<span class="dlc-penter" data-pk="enter" data-path="' + dlA(it.path) +
        '" title="进入此目录"><i class="bi bi-chevron-right"></i></span>' : "") +
      "</div>";
  }).join("");
}

function dlPickItem(item) {
  const P = DL.pick;
  if (!P) return;
  const path = item.dataset.path;
  const isDir = item.dataset.dir === "1";
  if (P.mode === "dir") { if (isDir) dlPickLoad(path); return; }
  const i = P.sel.findIndex(function (s) { return s.path === path; });
  if (i >= 0) P.sel.splice(i, 1);
  else P.sel.push({ path: path, name: item.dataset.name, is_dir: isDir, size: Number(item.dataset.size) || 0 });
  item.classList.toggle("sel", i < 0);
  dlPickRenderSide();
  dlPickSum();
}

function dlPickSum() {
  const P = DL.pick;
  const el = document.getElementById("dlPkSum");
  if (!P || !el) return;
  if (P.mode === "dir") {
    el.innerHTML = "当前目录：<b>" + esc(P.path) + "</b>";
    return;
  }
  const kind = (document.getElementById("dlPkKind") || {}).value || "auto";
  let bytes = 0;
  P.sel.forEach(function (s) { bytes += s.size || 0; });
  const names = P.sel.map(function (s) { return s.name; });
  const out = kind === "file" ? names[0] : "";
  el.innerHTML = P.sel.length
    ? "已选 <b>" + P.sel.length + "</b> 项 · 约 " + dlSize(bytes) +
      (out ? " · 直传 <b>" + esc(out) + "</b>" : "")
    : "勾选文件或文件夹后开始下载";
}

async function dlPickAction(act, path) {
  const P = DL.pick;
  if (!P) return;
  if (act === "close") return dlPickClose();
  if (act === "tab") return dlPickTabSet(P.tab === "url" ? "files" : "url");
  if (act === "url-dir") {
    P.dirFor = "url";
    P.mode = "dir";
    dlPickTabSet("files");
    dlPickTabsShow(false);
    return;
  }
  if (act === "url-adv") {
    P.urlAdv = !P.urlAdv;
    const adv = document.getElementById("dlPkUrlAdv");
    if (adv) adv.classList.toggle("show", P.urlAdv);
    return;
  }
  if (act === "probe") return dlPickProbe();
  if (act === "url-ok") return dlUrlConfirm();
  if (act === "goto" || act === "enter") return dlPickLoad(path);
  if (act === "up") return dlPickLoad(P.parent || P.sep);
  if (act === "refresh") return dlPickLoad(P.path);
  if (act === "adv") {
    const box = document.getElementById("dlPkAdv");
    if (box) box.classList.toggle("show");
    return;
  }
  if (act === "unsel") {
    P.sel = P.sel.filter(function (s) { return s.path !== path; });
    dlPickRenderSide();
    dlPickRenderList();
    dlPickSum();
    return;
  }
  if (act === "all") {
    const selMap = {};
    P.sel.forEach(function (s) { selMap[s.path] = 1; });
    (P.items || []).forEach(function (it) {
      if (P.mode === "dir" && !it.is_dir) return;
      if (!selMap[it.path]) {
        P.sel.push({ path: it.path, name: it.name, is_dir: it.is_dir, size: it.size || 0 });
      }
    });
    dlPickRenderSide();
    dlPickRenderList();
    dlPickSum();
    return;
  }
  if (act === "new") {
    const name = await uiPrompt("新建文件夹", "", "文件夹名称");
    if (!name) return;
    const d = await dlReq("/api/dl/mkdir", { method: "POST", body: JSON.stringify({ path: P.path, name: name }) });
    if (!d.ok) { toast(d.error || "创建失败", "err"); return; }
    toast("已创建：" + name, "ok");
    return dlPickLoad(P.path);
  }
  if (act === "ok") return dlPickConfirm();
}

async function dlPickConfirm() {
  const P = DL.pick;
  if (!P) return;
  if (P.mode === "dir") {
    const p = P.path;
    if (P.dirFor === "url") {
      P.saveDir = p;
      P.dirFor = "";
      P.mode = "files";
      P.tab = "url";
      dlPickTabsShow(true);
      dlPickTabSet("url");
      return;
    }
    const cb = P.cb;
    dlPickClose();
    if (cb) cb(p);
    return;
  }
  if (!P.sel.length) { toast("请先勾选要下载的文件或文件夹", "warn"); return; }
  const kindEl = document.getElementById("dlPkKind");
  const nameEl = document.getElementById("dlPkName");
  const lvEl = document.getElementById("dlPkLevel");
  const stEl = document.getElementById("dlPkStruct");
  const hdEl = document.getElementById("dlPkIncHidden");
  const kind = (kindEl && kindEl.value) || "auto";
  const hasDir = P.sel.some(function (s) { return s.is_dir; });
  if (kind === "file" && (P.sel.length > 1 || hasDir)) {
    toast("「不打包」只支持单个文件，已自动改用打包", "warn");
  }
  const btn = document.querySelector('#dlcPickMask [data-pk="ok"]');
  if (btn) btn.disabled = true;
  const d = await dlReq("/api/dl/tasks", {
    method: "POST",
    body: JSON.stringify({
      paths: P.sel.map(function (s) { return s.path; }),
      kind: kind,
      name: ((nameEl && nameEl.value) || "").trim(),
      opts: {
        zip_level: Number((lvEl && lvEl.value) || 6),
        keep_structure: !stEl || stEl.checked,
        include_hidden: !!(hdEl && hdEl.checked),
      },
    }),
  });
  if (btn) btn.disabled = false;
  if (!d.ok) { toast(d.error || "创建失败", "err"); return; }
  dlPickClose();
  toast("已创建下载任务：" + d.task.name, "ok");
  if (DL.view !== "tasks") dlView("tasks");
  await dlLoadTasks(true);
  if ((DL.cfg || {}).auto_start) DL.pendingAuto.push(d.task.id);
  dlKickAuto();
}

function dlPickDir() {
  dlPickOpen({
    mode: "dir",
    path: (DL.cfg || {}).artifact_dir || "",
    cb: function (p) {
      dlSaveCfg({ artifact_dir: p });
      setTimeout(dlRenderSettings, 60);
    },
  });
}
function dlPickNetDir() {
  dlPickOpen({
    mode: "dir",
    path: (DL.cfg || {}).save_dir || (DL.cfg || {}).artifact_dir || "",
    cb: function (p) {
      dlSaveCfg({ save_dir: p });
      setTimeout(dlRenderSettings, 60);
    },
  });
}

/* ---------------- 初始化：活动栏入口 ---------------- */
(function dlInit() {
  const panel = document.getElementById("downloadsPanel");
  const newBtn = document.getElementById("dlsNew");
  const openBtn = document.getElementById("dlsOpen");
  const refreshBtn = document.getElementById("dlsRefresh");
  if (newBtn) newBtn.addEventListener("click", function () { dlPickOpen({}); });
  if (openBtn) openBtn.addEventListener("click", function () { openDownloadCenter(); });
  if (refreshBtn) refreshBtn.addEventListener("click", function () { dlLoadTasks(); });

  if (panel) {
    panel.addEventListener("click", function (e) {
      const b = e.target.closest("[data-dls]");
      if (b) {
        const act = b.dataset.dls;
        const id = b.dataset.id || "";
        if (act === "open") return openDownloadCenter();
        if (act === "view") return dlOpenArtifact(id);
        if (act === "start") {
          const tt = id ? dlFindTask(id) : null;
          return dlStartTask(tt);
        }
        if (act === "pause") return dlStopTask(id);
        return;
      }
      if (e.target.closest(".dls-item")) openDownloadCenter();   // 点任务卡片 → 完整面板
    });
  }

  // 活动栏图标：交给 02_ 的 showPanel 打开侧栏面板，这里只负责切过去之后渲染一次
  const act = document.getElementById("actDownloads");
  if (act) {
    act.addEventListener("click", function () {
      setTimeout(function () {
        dlSideRender();
        dlPollStart();
        if (!(DL.tasks || []).length) dlLoadTasks(true);
      }, 0);
    });
  }

  dlSideRender();
  dlPollStart();          // 轮询本身很轻：两个界面都没显示时直接 return
  window.openDownloadCenter = openDownloadCenter;
  window.openDownloadsPanel = function () {
    if (typeof showPanel === "function") showPanel("downloads");
    setTimeout(dlSideRender, 0);
  };
})();

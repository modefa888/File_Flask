/* ============================================================================
 * 进程资源管理器（可拖动浮窗，参考 Trae 的「进程资源管理器」）
 *
 * 入口：左下角活动栏图标 #actProc（在设置齿轮上方），点一下打开 / 收起浮窗；
 *      窗口也可被拖动、最大化；关闭后再次打开会记住上次的位置与大小。
 * 标签页：概览（CPU / 内存 / 磁盘 三张卡片 + 系统概览）、CPU 与内存（进程表格，
 *         可搜索 / 排序 / 结束进程）、磁盘（各分区用量）、网络（实时速率 + 监听端口）。
 * 数据：/api/proc/overview、/api/proc/list、/api/proc/ports、POST /api/proc/kill，
 *      默认 2 秒轮询一次（可在窗口底部暂停），采集逻辑见 services/ide/procinfo.py。
 * AI 诊断：POST /api/proc/diagnose（专用内置接口）→ 独立的「AI 资源诊断」浮窗展示，
 *      与 AI 助手面板的对话完全分开，见下面 PROCDIAG 段。
 *
 * 注意：本文件须放在 16_（关闭大 IIFE）之前加载，才能复用闭包内的 $ / esc / toast /
 *      uiConfirm / aiMd / aiOpenPath / aiCopyText。
 * ========================================================================== */

const PROCPM_TICK = 2000;
const PROCPM = {
  built: false, open: false, tab: "overview", timer: null, paused: false, autoResume: false,
  sort: "cpu", q: "", ov: null, procs: [], count: 0, ports: [], max: false, pos: null,
};

/* ------------------------------- 小工具 ------------------------------- */
function procPmSize(n) {
  n = Number(n) || 0;
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i === 0 ? Math.round(n) : n.toFixed(n >= 100 ? 0 : 1)) + " " + u[i];
}
function procPmPct(n) {
  n = Number(n) || 0;
  return (n >= 10 ? n.toFixed(0) : n.toFixed(1)) + "%";
}
function procPmRate(bps) {                                  // 字节/秒
  const v = Number(bps) || 0;
  if (v < 1024) return Math.round(v) + " B/s";
  if (v < 1024 * 1024) return (v / 1024).toFixed(1) + " KB/s";
  return (v / 1048576).toFixed(2) + " MB/s";
}
function procPmDur(sec) {
  sec = Math.max(0, Math.floor(Number(sec) || 0));
  const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60);
  if (d) return d + " 天 " + h + " 小时";
  if (h) return h + " 小时 " + m + " 分";
  return m + " 分 " + (sec % 60) + " 秒";
}
function procPmClock(ts) {
  const d = ts ? new Date(ts * 1000) : new Date();
  const p = n => String(n).padStart(2, "0");
  return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
}
function procPmAttr(s) { return esc(s).replace(/"/g, "&quot;").replace(/'/g, "&#39;"); }
function procPmBar(pct, cls) {
  const v = Math.max(0, Math.min(100, Number(pct) || 0));
  return '<span class="pm-bar ' + (cls || "") + '"><i style="width:' + v.toFixed(1) + '%"></i></span>';
}
async function procPmApi(url, opt) {
  const r = await fetch(url, opt);
  let d = {};
  try { d = await r.json(); } catch (_) { d = {}; }
  if (!r.ok) throw new Error(d.error || ("请求失败（HTTP " + r.status + "）"));
  if (d.error) throw new Error(d.error);
  return d;
}

/* ------------------------------- 浮窗骨架 ------------------------------- */
const PROCPM_TABS = [
  { key: "overview", label: "概览" },
  { key: "cpu", label: "CPU 与内存" },
  { key: "disk", label: "磁盘" },
  { key: "net", label: "网络" },
];

function procPmBuild() {
  if (PROCPM.built) return;
  PROCPM.built = true;
  try { PROCPM.pos = JSON.parse(localStorage.getItem("ide.procpm.pos") || "null"); } catch (_) { PROCPM.pos = null; }
  PROCPM.max = localStorage.getItem("ide.procpm.max") === "1";
  if (PROCPM.pos && (!PROCPM.pos.w || !PROCPM.pos.h)) PROCPM.pos = null;

  const win = document.createElement("div");
  win.className = "procpm";
  win.id = "procPm";
  win.hidden = true;
  win.innerHTML =
    '<div class="pm-head" id="pmHead">' +
      '<span class="pm-title"><i class="bi bi-activity"></i> 进程资源管理器</span>' +
      '<span class="pm-hbtns">' +
        '<button class="pm-hbtn" id="pmRefresh" title="立即刷新一次"><i class="bi bi-arrow-clockwise"></i></button>' +
        '<button class="pm-hbtn" id="pmPause" title="暂停 / 恢复自动刷新（2 秒）"><i class="bi bi-pause"></i></button>' +
        '<button class="pm-hbtn" id="pmMax" title="最大化 / 还原"><i class="bi bi-square"></i></button>' +
        '<button class="pm-hbtn pm-close" id="pmClose" title="关闭浮窗"><i class="bi bi-x-lg"></i></button>' +
      '</span>' +
    '</div>' +
    '<div class="pm-tabs">' +
      PROCPM_TABS.map(t => '<button class="pm-tab' + (t.key === PROCPM.tab ? " active" : "") +
        '" data-tab="' + t.key + '">' + t.label + '</button>').join("") +
      '<span class="pm-tspace"></span>' +
      '<button class="pm-opt" id="pmOptimize" title="自动筛出可安全结束的高占用进程，确认后一键清理"><i class="bi bi-magic"></i> 一键优化</button>' +
      '<button class="pm-ai" id="pmAi" title="用内置接口 POST /api/proc/diagnose 分析当前资源占用（结论在独立的诊断窗口里展示，不占用 AI 对话）"><i class="bi bi-stars"></i> AI 诊断</button>' +
    '</div>' +
    '<div class="procpm-body" id="pmBody"></div>' +
    '<div class="pm-foot"><span id="pmFoot">正在采集…</span></div>';
  document.body.appendChild(win);

  // 拖动（点标题空白处拖动，点按钮不触发）
  const head = $("pmHead");
  procWinDrag(win, head, "ide.procpm.pos", PROCPM);
  head.addEventListener("dblclick", e => { if (!e.target.closest("button")) procPmMaxToggle(); });

  $("pmClose").onclick = () => procPmToggle(false);
  $("pmMax").onclick = () => procPmMaxToggle();
  $("pmRefresh").onclick = () => procPmTick(true);
  $("pmPause").onclick = () => procPmPause(!PROCPM.paused);
  $("pmOptimize").onclick = () => procPmOptimize();
  $("pmAi").onclick = () => procPmDiagnose();

  win.querySelectorAll(".pm-tab").forEach(b => {
    b.onclick = () => procPmSetTab(b.dataset.tab);
  });

  // 内容区事件委托：排序 / 结束进程 / 搜索 / 卡片跳转
  const body = $("pmBody");
  body.addEventListener("click", e => {
    const go = e.target.closest("[data-goto]");
    if (go) { procPmSetTab(go.dataset.goto === "mem" ? "cpu" : go.dataset.goto); return; }
    const sb = e.target.closest("[data-psort]");
    if (sb) {
      PROCPM.sort = sb.dataset.psort;
      body.querySelectorAll("[data-psort]").forEach(x => x.classList.toggle("active", x === sb));
      procPmTick(true);
      return;
    }
    const kb = e.target.closest("[data-kill]");
    if (kb) { procPmKill(Number(kb.dataset.kill), kb.dataset.name || "", kb.dataset.kind || "proc"); return; }
  });
  body.addEventListener("input", e => {
    if (!e.target.closest("#pmSearch")) return;
    PROCPM.q = e.target.value;
    clearTimeout(PROCPM.qTimer);
    PROCPM.qTimer = setTimeout(() => procPmTick(true), 250);   // 输入防抖
  });
  window.addEventListener("resize", () => { if (PROCPM.open) procPmPlace(); });
}

/* 可放置区域 = 工作区（标题栏与状态栏之间），最大化也贴这块区域 */
function procPmArea() {
  const el = document.querySelector(".workbench") || document.body;
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
}

function procPmPlace() {
  procWinPlace($("procPm"), PROCPM, 880, 600);
}

function procPmMaxToggle() {
  procWinMaxToggle($("procPm"), PROCPM, "ide.procpm.max", $("pmMax"), procPmPlace);
}

/* --------------------------- 浮窗通用能力（进程资源管理器 / AI 诊断共用） --------------------------- */
/* 拖动：拖标题栏（点按钮 / 输入框不触发），松手后把位置记进 localStorage */
function procWinDrag(win, head, key, state) {
  head.addEventListener("mousedown", e => {
    if (e.target.closest("button") || e.target.closest("input") || state.max) return;
    const r = win.getBoundingClientRect();
    const dx = e.clientX - r.left, dy = e.clientY - r.top;
    const move = ev => {
      const a = procPmArea();
      state.pos = state.pos || { w: r.width, h: r.height };
      state.pos.x = Math.max(a.x, Math.min(ev.clientX - dx, a.x + a.w - r.width));
      state.pos.y = Math.max(a.y, Math.min(ev.clientY - dy, a.y + a.h - r.height));
      win.style.left = state.pos.x + "px";
      win.style.top = state.pos.y + "px";
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      try { localStorage.setItem(key, JSON.stringify(state.pos)); } catch (_) {}
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
    e.preventDefault();
  });
}

/* 摆位：最大化时贴满工作区，否则用记住的位置（默认居中、夹在工作区内） */
function procWinPlace(win, state, maxW, maxH) {
  if (!win) return;
  const a = procPmArea();
  win.classList.toggle("max", state.max);
  if (state.max) {
    win.style.left = (a.x + 6) + "px";
    win.style.top = (a.y + 6) + "px";
    win.style.width = Math.max(320, a.w - 12) + "px";
    win.style.height = Math.max(240, a.h - 12) + "px";
    return;
  }
  let p = state.pos;
  if (!p) {
    const w = Math.min(maxW, Math.max(360, a.w - 80));
    const h = Math.min(maxH, Math.max(300, a.h - 80));
    p = { x: a.x + Math.round((a.w - w) / 2), y: a.y + Math.max(16, Math.round((a.h - h) / 2)), w: w, h: h };
  }
  p.w = Math.min(p.w, Math.max(320, a.w - 12));
  p.h = Math.min(p.h, Math.max(240, a.h - 12));
  p.x = Math.max(a.x + 4, Math.min(p.x, a.x + a.w - p.w - 4));
  p.y = Math.max(a.y + 4, Math.min(p.y, a.y + a.h - p.h - 4));
  state.pos = p;
  win.style.left = p.x + "px";
  win.style.top = p.y + "px";
  win.style.width = p.w + "px";
  win.style.height = p.h + "px";
}

/* 最大化 / 还原：状态记进 localStorage，图标跟着换 */
function procWinMaxToggle(win, state, key, btn, place) {
  state.max = !state.max;
  try { localStorage.setItem(key, state.max ? "1" : "0"); } catch (_) {}
  if (btn) btn.innerHTML = '<i class="bi ' + (state.max ? "bi-copy" : "bi-square") + '"></i>';
  place();
}

function procPmToggle(force) {
  procPmBuild();
  const open = force === undefined ? !PROCPM.open : !!force;
  PROCPM.open = open;
  const win = $("procPm");
  win.hidden = !open;
  const act = $("actProc");
  if (act) act.classList.toggle("active", open);
  if (open) {
    procPmPlace();
    procPmSetTab(PROCPM.tab);                       // 内部会立即拉一次数据
    procPmPause(false);
  } else {
    procPmPause(true);
  }
}

function procPmPause(on) {
  PROCPM.paused = !!on;
  if (PROCPM.timer) { clearInterval(PROCPM.timer); PROCPM.timer = null; }
  const b = $("pmPause");
  if (b) {
    b.innerHTML = '<i class="bi ' + (PROCPM.paused ? "bi-play" : "bi-pause") + '"></i>';
    b.title = PROCPM.paused ? "恢复自动刷新（2 秒）" : "暂停自动刷新";
  }
  if (!PROCPM.paused && PROCPM.open) {
    PROCPM.timer = setInterval(() => procPmTick(true), PROCPM_TICK);
  }
}

/* ------------------------------- 标签页骨架 ------------------------------- */
function procPmSetTab(key) {
  PROCPM.tab = key;
  document.querySelectorAll("#procPm .pm-tab").forEach(b => b.classList.toggle("active", b.dataset.tab === key));
  const body = $("pmBody");
  if (body.dataset.tab !== key) {
    body.dataset.tab = key;
    body.innerHTML = procPmSkeleton(key);
    body.scrollTop = 0;
  }
  if (PROCPM.ov) procPmPaint();
  procPmTick(true);
}

function procPmSkeleton(key) {
  if (key === "overview") {
    return '<div class="pm-cards">' +
      procPmCardHtml("cpu", "CPU（系统）", "bi-cpu") +
      procPmCardHtml("mem", "内存（系统）", "bi-memory") +
      procPmCardHtml("disk", "磁盘（系统）", "bi-device-hdd") +
      '</div>' +
      '<div class="pm-sumbox"><div class="pm-sub-t">系统概览</div><div id="pmSumTxt" class="pm-sum-txt">正在采集…</div>' +
      '<div id="pmFacts" class="pm-facts"></div></div>';
  }
  if (key === "cpu") {
    const sorts = [["cpu", "CPU"], ["mem", "内存"], ["threads", "线程"], ["pid", "PID"], ["name", "名称"], ["started", "启动时间"]];
    return '<div class="pm-tools">' +
        '<input id="pmSearch" class="pm-search" placeholder="搜索进程名 / 命令行 / 用户 / pid" spellcheck="false" autocomplete="off" value="' +
          procPmAttr(PROCPM.q) + '">' +
        '<span class="pm-sortwrap">' + sorts.map(s => '<button class="pm-sort' + (PROCPM.sort === s[0] ? " active" : "") +
          '" data-psort="' + s[0] + '" title="按' + s[1] + '排序">' + s[1] + '</button>').join("") + '</span>' +
        '<span class="pm-tinfo" id="pmCpuInfo"></span>' +
      '</div>' +
      '<div class="pm-tblwrap"><table class="pm-table"><thead><tr>' +
        '<th>进程</th><th class="pm-c-num">PID</th><th>用户</th><th class="pm-c-num">CPU</th>' +
        '<th class="pm-c-num">内存</th><th class="pm-c-num">线程</th><th>操作</th>' +
      '</tr></thead><tbody id="pmTbody"><tr><td colspan="7" class="pm-empty">正在采集…</td></tr></tbody></table></div>';
  }
  if (key === "disk") {
    return '<div class="pm-card pm-card-wide"><div class="pm-card-hd"><i class="bi bi-device-hdd"></i><span>磁盘分区（按容量排序）</span></div>' +
      '<div id="pmDiskBig" class="pm-big">--</div><div id="pmDiskRows" class="pm-rows"></div></div>' +
      '<div class="pm-tblwrap"><table class="pm-table"><thead><tr>' +
        '<th>挂载点</th><th>文件系统</th><th class="pm-c-num">总量</th><th class="pm-c-num">已用</th>' +
        '<th class="pm-c-num">可用</th><th class="pm-c-num">使用率</th><th>占用</th>' +
      '</tr></thead><tbody id="pmDiskBody"><tr><td colspan="7" class="pm-empty">正在采集…</td></tr></tbody></table></div>';
  }
  // net
  return '<div class="pm-cards">' +
      '<div class="pm-card"><div class="pm-card-hd"><i class="bi bi-arrow-up-circle"></i><span>上行（发送）</span></div>' +
        '<div class="pm-big" id="pmNetUp">--</div><div class="pm-rows" id="pmNetUpRows"></div></div>' +
      '<div class="pm-card"><div class="pm-card-hd"><i class="bi bi-arrow-down-circle"></i><span>下行（接收）</span></div>' +
        '<div class="pm-big" id="pmNetDown">--</div><div class="pm-rows" id="pmNetDownRows"></div></div>' +
    '</div>' +
    '<div class="pm-tools"><span class="pm-tinfo" id="pmPortInfo">监听中的端口</span></div>' +
    '<div class="pm-tblwrap"><table class="pm-table"><thead><tr>' +
      '<th class="pm-c-num">端口</th><th>协议</th><th>监听地址</th><th>进程</th><th class="pm-c-num">PID</th><th>操作</th>' +
    '</tr></thead><tbody id="pmPortBody"><tr><td colspan="6" class="pm-empty">正在采集…</td></tr></tbody></table></div>';
}

function procPmCardHtml(kind, title, icon) {
  return '<div class="pm-card"><div class="pm-card-hd" data-goto="' + kind + '" title="查看明细">' +
    '<i class="bi ' + icon + '"></i><span>' + title + '</span><i class="bi bi-chevron-right pm-go"></i></div>' +
    '<div class="pm-big" id="pmBig-' + kind + '">--</div>' +
    '<div class="pm-subline" id="pmSub-' + kind + '"></div>' +
    '<div class="pm-rows" id="pmRows-' + kind + '"></div></div>';
}

/* ------------------------------- 数据刷新 ------------------------------- */
async function procPmTick(force) {
  if (!PROCPM.open && !force) return;
  try {
    const ov = await procPmApi("/api/proc/overview");
    PROCPM.ov = ov;
    if (PROCPM.tab === "cpu") {
      const d = await procPmApi("/api/proc/list?sort=" + encodeURIComponent(PROCPM.sort) +
        "&q=" + encodeURIComponent(PROCPM.q) + "&limit=200");
      PROCPM.procs = d.procs || [];
      PROCPM.count = d.count || 0;
    }
    if (PROCPM.tab === "net") {
      const p = await procPmApi("/api/proc/ports");
      PROCPM.ports = p.ports || [];
    }
    procPmPaint();
    const f = $("pmFoot");
    if (f) f.textContent = "共 " + ((ov.counts && ov.counts.total) || 0) + " 个进程 · 本服务 " +
      ((ov.counts && ov.counts.app) || 0) + " 个 · 采样于 " + procPmClock(ov.time) +
      (PROCPM.paused ? "（已暂停自动刷新）" : "（每 2 秒自动刷新）");
  } catch (e) {
    procPmError(e);
  }
}

function procPmPaint() {
  const ov = PROCPM.ov;
  if (!ov) return;
  if (PROCPM.tab === "overview") procPmPaintOverview(ov);
  else if (PROCPM.tab === "cpu") procPmPaintCpu(ov);
  else if (PROCPM.tab === "disk") procPmPaintDisk(ov);
  else procPmPaintNet(ov);
}

function procPmCls(pct) {
  const v = Number(pct) || 0;
  return v >= 90 ? "bad" : (v >= 75 ? "warn" : "ok");
}

function procPmPaintOverview(ov) {
  const cpu = ov.cpu || {}, mem = ov.mem || {}, disk = ov.disk || {};
  const set = (id, html) => { const el = $(id); if (el) el.innerHTML = html; };
  set("pmBig-cpu", procPmPct(cpu.percent));
  const cbig = $("pmBig-cpu");
  if (cbig) cbig.className = "pm-big pm-" + procPmCls(cpu.percent);
  set("pmSub-cpu", (cpu.cores || 1) + " 核" + ((cpu.load && cpu.load.length) ? " · 负载 " + cpu.load.join(" / ") : ""));
  set("pmRows-cpu", (cpu.groups || []).map(g =>
    '<div class="pm-kv"><span class="k" title="' + procPmAttr(g.name + "（" + g.count + " 个进程）") + '">' + esc(g.name) + '</span>' +
    '<span class="v">' + procPmPct(g.percent) + '</span></div>').join(""));

  set("pmBig-mem", procPmPct(mem.percent));
  const mbig = $("pmBig-mem");
  if (mbig) mbig.className = "pm-big pm-" + procPmCls(mem.percent);
  set("pmSub-mem", "已用 " + procPmSize(mem.used) + " / 共 " + procPmSize(mem.total) +
    (mem.swap_total ? " · 交换 " + procPmSize(mem.swap_used) + " / " + procPmSize(mem.swap_total) : ""));
  set("pmRows-mem", (mem.groups || []).map(g =>
    '<div class="pm-kv"><span class="k" title="' + procPmAttr(g.name) + '">' + esc(g.name) + '</span>' +
    '<span class="v">' + procPmSize(g.bytes) + '</span></div>').join(""));

  set("pmBig-disk", procPmPct(disk.percent));
  const dbig = $("pmBig-disk");
  if (dbig) dbig.className = "pm-big pm-" + procPmCls(disk.percent);
  set("pmSub-disk", "可用 " + procPmSize(disk.free) + " / 共 " + procPmSize(disk.total) +
    (disk.mount ? " · " + esc(disk.mount) : ""));
  set("pmRows-disk", (disk.parts || []).slice(0, 5).map(p =>
    '<div class="pm-kv"><span class="k" title="' + procPmAttr(p.mount + "（" + (p.fstype || "") + "）") + '">' +
    esc(p.mount) + '</span><span class="v">' + procPmPct(p.percent) + '</span></div>').join(""));

  set("pmSumTxt", esc(ov.summary || "-"));
  const st = $("pmSumTxt");
  if (st) st.className = "pm-sum-txt pm-lv-" + (ov.health || "ok");
  set("pmFacts", [
    ["进程总数", ((ov.counts || {}).total || 0) + " 个（本服务 " + ((ov.counts || {}).app || 0) + " 个）"],
    ["网络速率", "↑ " + procPmRate((ov.net || {}).up) + " · ↓ " + procPmRate((ov.net || {}).down)],
    ["系统已运行", procPmDur(ov.uptime)],
    ["本服务自身", "pid " + ((ov.self || {}).pid || "-") + " · " + procPmSize((ov.self || {}).rss) +
      " · CPU " + procPmPct((ov.self || {}).cpu)],
  ].map(x => '<div class="pm-kv"><span class="k">' + esc(x[0]) + '</span><span class="v">' + x[1] + '</span></div>').join(""));
}

function procPmPaintCpu(ov) {
  const tb = $("pmTbody");
  if (!tb) return;
  const rows = PROCPM.procs || [];
  const info = $("pmCpuInfo");
  if (info) {
    const pick = (arr) => (arr || []).filter(g => g.name.indexOf("IDE 服务") === 0)[0] || {};
    const cg = pick(ov.cpu && ov.cpu.groups), mg = pick(ov.mem && ov.mem.groups);
    info.textContent = "匹配 " + (PROCPM.count || 0) + " 个，显示 " + rows.length +
      " 个 · 本服务相关进程 " + (cg.count || 0) + " 个（CPU " + procPmPct(cg.percent) +
      "，内存 " + procPmSize(mg.bytes || 0) + "）";
  }
  if (!rows.length) {
    tb.innerHTML = '<tr><td colspan="7" class="pm-empty">没有匹配的进程</td></tr>';
    return;
  }
  tb.innerHTML = rows.map(r => {
    const tag = r.in_app ? ["app", "本服务"] : (r.mine ? ["mine", "我的"] : ["sys", "系统"]);
    const kill = r.can_kill
      ? '<button class="pm-kill" data-kill="' + r.pid + '" data-kind="proc" data-name="' + procPmAttr(r.name) +
        '" title="结束该进程（先 SIGTERM，3 秒未退出再强制结束）"><i class="bi bi-x-circle"></i> 结束</button>'
      : '<button class="pm-kill off" disabled title="' + procPmAttr(r.kill_hint || "不可操作") +
        '"><i class="bi bi-slash-circle"></i></button>';
    return '<tr' + (r.in_app ? ' class="is-app"' : '') + '>' +
      '<td class="pm-c-name"><div class="pm-name-line"><span class="pm-tag ' + tag[0] + '">' + tag[1] + '</span>' +
        '<span class="pm-name" title="' + procPmAttr(r.cmd || r.name) + '">' + esc(r.name || "(未知)") + '</span></div>' +
        '<div class="pm-sub" title="' + procPmAttr(r.cmd || "") + '">' + esc((r.cmd || "").slice(0, 160)) + '</div></td>' +
      '<td class="pm-c-num">' + r.pid + '</td>' +
      '<td>' + esc(r.user || "-") + '</td>' +
      '<td class="pm-c-num">' + procPmPct(r.cpu) + '</td>' +
      '<td class="pm-c-num">' + procPmSize(r.rss) + '</td>' +
      '<td class="pm-c-num">' + (r.threads || 0) + '</td>' +
      '<td class="pm-c-act">' + kill + '</td></tr>';
  }).join("");
}

function procPmPaintDisk(ov) {
  const disk = ov.disk || {};
  const big = $("pmDiskBig");
  if (big) {
    big.className = "pm-big pm-" + procPmCls(disk.percent);
    big.innerHTML = procPmPct(disk.percent) + '<span class="pm-unit">' + esc(disk.mount || "") +
      " · 可用 " + procPmSize(disk.free) + " / 共 " + procPmSize(disk.total) + '</span>';
  }
  const rows = $("pmDiskRows");
  if (rows) {
    rows.innerHTML = (disk.parts || []).map(p =>
      '<div class="pm-kv"><span class="k" title="' + procPmAttr(p.mount + "（" + (p.fstype || "") + "）") + '">' +
      esc(p.mount) + (p.main ? " · 工作区" : "") + '</span><span class="v">' + procPmSize(p.free) + ' 可用 / ' +
      procPmSize(p.total) + '</span></div>').join("");
  }
  const tb = $("pmDiskBody");
  if (!tb) return;
  const parts = disk.parts || [];
  tb.innerHTML = parts.length ? parts.map(p =>
    '<tr' + (p.main ? ' class="is-main"' : '') + '>' +
    '<td><span class="pm-name">' + esc(p.mount) + '</span>' + (p.main ? '<span class="pm-tag app">工作区</span>' : '') +
      '<div class="pm-sub" title="' + procPmAttr(p.device || "") + '">' + esc(p.device || "") + '</div></td>' +
    '<td>' + esc(p.fstype || "-") + '</td>' +
    '<td class="pm-c-num">' + procPmSize(p.total) + '</td>' +
    '<td class="pm-c-num">' + procPmSize(p.used) + '</td>' +
    '<td class="pm-c-num">' + procPmSize(p.free) + '</td>' +
    '<td class="pm-c-num">' + procPmPct(p.percent) + '</td>' +
    '<td>' + procPmBar(p.percent, "pm-" + procPmCls(p.percent)) + '</td></tr>').join("")
    : '<tr><td colspan="7" class="pm-empty">没有读到分区信息</td></tr>';
}

function procPmPaintNet(ov) {
  const net = ov.net || {};
  const set = (id, html) => { const el = $(id); if (el) el.innerHTML = html; };
  set("pmNetUp", procPmRate(net.up));
  set("pmNetDown", procPmRate(net.down));
  set("pmNetUpRows", '<div class="pm-kv"><span class="k">本次开机累计发送</span><span class="v">' +
    procPmSize(net.sent) + '</span></div>');
  set("pmNetDownRows", '<div class="pm-kv"><span class="k">本次开机累计接收</span><span class="v">' +
    procPmSize(net.recv) + '</span></div>');

  const tb = $("pmPortBody");
  if (!tb) return;
  const rows = PROCPM.ports || [];
  const info = $("pmPortInfo");
  if (info) info.textContent = "监听中的端口：" + rows.length + " 个（只列出监听状态，UDP 为无对端 socket）";
  tb.innerHTML = rows.length ? rows.map(p => {
    const kill = p.can_kill
      ? '<button class="pm-kill" data-kill="' + p.pid + '" data-kind="port" data-name="' + procPmAttr(p.name || "") +
        '" title="结束占用该端口的进程"><i class="bi bi-x-circle"></i> 结束</button>'
      : '<button class="pm-kill off" disabled title="不可操作（非当前用户或无 pid）"><i class="bi bi-slash-circle"></i></button>';
    return '<tr>' +
      '<td class="pm-c-num pm-name">' + p.port + '</td>' +
      '<td>' + esc((p.proto || "").toUpperCase()) + '</td>' +
      '<td>' + esc(p.addr || "*") + '</td>' +
      '<td><span class="pm-name">' + esc(p.name || "-") + '</span><div class="pm-sub" title="' +
        procPmAttr(p.cmd || "") + '">' + esc((p.cmd || "").slice(0, 140)) + '</div>' +
        (p.mine ? '<span class="pm-tag mine">我的</span>' : '') + '</td>' +
      '<td class="pm-c-num">' + (p.pid || "-") + '</td>' +
      '<td class="pm-c-act">' + kill + '</td></tr>';
  }).join("") : '<tr><td colspan="6" class="pm-empty">没有读到监听端口</td></tr>';
}

function procPmError(e) {
  const msg = (e && e.message) || String(e);
  const body = $("pmBody");
  const f = $("pmFoot");
  if (f) f.textContent = "采集失败：" + msg;
  if (body && !body.querySelector(".pm-err")) {
    body.insertAdjacentHTML("afterbegin", '<div class="pm-err"><i class="bi bi-exclamation-triangle"></i> ' + esc(msg) + '</div>');
  }
}

/* ------------------------------- 结束进程 ------------------------------- */
/* 返回 true 表示确实结束了（供 AI 诊断窗口判断要不要划掉候选行） */
async function procPmKill(pid, name, kind) {
  if (!pid) return false;
  const ok = await uiConfirm("结束进程",
    "将结束" + (kind === "port" ? "占用端口的" : "") + "进程" + (name ? "「" + name + "」" : "") + "（pid " + pid + "）：\n" +
    "先发送 SIGTERM 请求退出，3 秒后仍未退出则强制结束。确定继续？", "结束", true);
  if (!ok) return false;
  try {
    const d = await procPmApi("/api/proc/kill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pid: pid }),
    });
    toast(d.already_gone ? "该进程已经不存在了" : "已结束进程 " + pid + "（" + (d.signal || "") + "）", "ok");
    setTimeout(() => procPmTick(true), 300);
    return true;
  } catch (e) {
    toast((e && e.message) || String(e), "err");
    return false;
  }
}

/* ============================================================================
 * AI 资源诊断：专用内置接口（POST /api/proc/diagnose）+ 专用显示模块
 *
 * 与「AI 助手面板」彻底分开：点「AI 诊断」不再把报告当成聊天消息发给 AI 助手，而是打开下面
 * 这个独立浮窗；快照采集与提问组织全在服务端完成（services/ide/procdiag.py），前端只负责展示。
 * 模型取自「设置 → 系统 AI」的「资源占用诊断」模块（可单独指定接口/模型，或整块停用）。
 * ========================================================================== */
const PROCDIAG = {
  built: false, open: false, busy: false, max: false, pos: null,
  data: null, error: "", started: 0, timer: null,
};

function procDiagBuild() {
  if (PROCDIAG.built) return;
  PROCDIAG.built = true;
  try { PROCDIAG.pos = JSON.parse(localStorage.getItem("ide.procdiag.pos") || "null"); } catch (_) { PROCDIAG.pos = null; }
  if (PROCDIAG.pos && (!PROCDIAG.pos.w || !PROCDIAG.pos.h)) PROCDIAG.pos = null;
  PROCDIAG.max = localStorage.getItem("ide.procdiag.max") === "1";

  const win = document.createElement("div");
  win.className = "procpm procai";
  win.id = "procDiag";
  win.hidden = true;
  win.innerHTML =
    '<div class="pm-head" id="paHead">' +
      '<span class="pm-title"><i class="bi bi-stars"></i> AI 资源诊断<span class="pa-model" id="paModel"></span></span>' +
      '<span class="pm-hbtns">' +
        '<button class="pm-hbtn" id="paCopy" title="复制诊断结论"><i class="bi bi-clipboard"></i></button>' +
        '<button class="pm-hbtn" id="paMax" title="最大化 / 还原"><i class="bi bi-square"></i></button>' +
        '<button class="pm-hbtn pm-close" id="paClose" title="关闭诊断窗口"><i class="bi bi-x-lg"></i></button>' +
      '</span>' +
    '</div>' +
    '<div class="pm-tabs">' +
      '<span class="pa-state" id="paState">准备中…</span>' +
      '<input class="pa-focus" id="paFocus" placeholder="补充关注点（可选，例如：为什么风扇一直很响）" spellcheck="false" autocomplete="off">' +
      '<span class="pm-tspace"></span>' +
      '<button class="pm-opt" id="paOptimize" title="按阈值结束可安全结束的高占用进程"><i class="bi bi-magic"></i> 一键优化</button>' +
      '<button class="pm-tab" id="paRerun" title="重新采集快照并分析"><i class="bi bi-arrow-clockwise"></i> 重新分析</button>' +
    '</div>' +
    '<div class="procpm-body" id="paBody"></div>' +
    '<div class="pm-foot" id="paFoot">等待分析…</div>';
  document.body.appendChild(win);

  const head = $("paHead");
  procWinDrag(win, head, "ide.procdiag.pos", PROCDIAG);
  head.addEventListener("dblclick", e => { if (!e.target.closest("button")) procDiagMaxToggle(); });
  $("paClose").onclick = () => procDiagToggle(false);
  $("paMax").onclick = () => procDiagMaxToggle();
  $("paRerun").onclick = () => procDiagRun(true);
  $("paOptimize").onclick = () => procDiagOptimize();
  $("paCopy").onclick = () => procDiagCopy();
  $("paFocus").addEventListener("keydown", e => { if (e.key === "Enter") procDiagRun(true); });
  $("paBody").addEventListener("click", e => {
    if (e.target.closest("#paRetry")) { procDiagRun(true); return; }
    const kb = e.target.closest("[data-pa-kill]");
    if (kb) { procDiagKill(Number(kb.dataset.paKill), kb.dataset.paName || ""); return; }
    const cp = e.target.closest(".ai-md-copy");              // 代码块复制：AI 面板的委托只作用于它自己的消息区
    if (cp) { procDiagCopyCode(cp); return; }
    const ap = e.target.closest("a.ai-path");                // 结论里的文件路径：复用 AI 助手的跳转
    if (ap && typeof aiOpenPath === "function") {
      e.preventDefault();
      aiOpenPath(String(ap.dataset.path || ap.textContent || ""), ap,
        parseInt(ap.dataset.line, 10) || 0, parseInt(ap.dataset.col, 10) || 0);
    }
  });
  window.addEventListener("resize", () => { if (PROCDIAG.open) procDiagPlace(); });
  // 「设置 → 系统 AI」里停用 / 启用该模块时，窗口内的提示同步刷新
  if (typeof onSysAiOffChange === "function") onSysAiOffChange(() => { if (PROCDIAG.open) procDiagPaint(); });
}

function procDiagPlace() { procWinPlace($("procDiag"), PROCDIAG, 780, 620); }

function procDiagMaxToggle() {
  procWinMaxToggle($("procDiag"), PROCDIAG, "ide.procdiag.max", $("paMax"), procDiagPlace);
}

function procDiagToggle(force) {
  procDiagBuild();
  const open = force === undefined ? !PROCDIAG.open : !!force;
  PROCDIAG.open = open;
  $("procDiag").hidden = !open;
  if (open) {
    procDiagPlace();
    procDiagPaint();
    // 首次打开（还没有结论）自动分析一次；再次打开沿用上次结论
    if (!PROCDIAG.busy && !PROCDIAG.data && !PROCDIAG.error) procDiagRun(false);
  } else {
    procDiagStopTimer();
  }
}

/* 进程资源管理器工具栏上的「AI 诊断」按钮：打开专用窗口并重新分析 */
function procPmDiagnose() {
  procDiagToggle(true);
  procDiagRun(true);
}

/* ------------------------------- 发起分析 ------------------------------- */
async function procDiagRun(manual) {
  procDiagBuild();
  if (PROCDIAG.busy) { if (manual) toast("正在分析中，稍等一下", "warn"); return; }
  if (typeof sysAiOff === "function" && sysAiOff("proc")) {
    PROCDIAG.data = null;
    PROCDIAG.error = "该功能已在「设置 → 系统 AI」中关闭，开启后即可使用";
    procDiagPaint();
    return;
  }
  PROCDIAG.busy = true;
  PROCDIAG.error = "";
  PROCDIAG.data = null;
  PROCDIAG.started = Date.now();
  procDiagPaint();
  procDiagStartTimer();
  const el = $("paFocus");
  const focus = ((el && el.value) || "").trim();
  try {
    PROCDIAG.data = await procPmApi("/api/proc/diagnose", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ focus: focus }),
    });
  } catch (e) {
    PROCDIAG.error = (e && e.message) || String(e);
  } finally {
    PROCDIAG.busy = false;
    procDiagStopTimer();
    procDiagPaint();
  }
}

function procDiagStartTimer() {
  procDiagStopTimer();
  PROCDIAG.timer = setInterval(() => {
    // 只更新秒数：文案与图标交给 procDiagPaintState 一次性渲染
    // （这里若整段重写 paState.innerHTML，会每 800ms 重建 <i>，使 1s 的旋转动画不断从头开始、看起来一抖一抖）
    const t = $("paTime");
    if (t) t.textContent = Math.round((Date.now() - PROCDIAG.started) / 1000) + " 秒";
  }, 800);
}

function procDiagStopTimer() {
  if (PROCDIAG.timer) { clearInterval(PROCDIAG.timer); PROCDIAG.timer = null; }
}

/* ------------------------------- 渲染 ------------------------------- */
function procDiagPaint() {
  const body = $("paBody");
  if (!body) return;
  if (!body.dataset.built) {
    body.dataset.built = "1";
    body.innerHTML =
      '<div class="pm-cards" id="paCards"></div>' +
      '<div class="pa-sec"><div class="pa-sec-hd"><i class="bi bi-stars"></i> 诊断结论' +
        '<span class="pa-sec-tip" id="paTip"></span></div><div id="paResult"></div></div>' +
      '<div class="pa-sec"><div class="pa-sec-hd"><i class="bi bi-lightning-charge"></i> 可安全结束的高占用进程' +
        '<span class="pa-sec-tip" id="paCandTip"></span>' +
        '<button class="pm-kill" id="paKillAll" title="结束下面列出的全部进程"><i class="bi bi-lightning-charge"></i> 全部结束</button>' +
        '</div><div class="pa-cands" id="paCands"></div></div>';
    $("paKillAll").onclick = () => procDiagOptimize();
  }
  procDiagPaintState();
  procDiagPaintCards();
  procDiagPaintResult();
  procDiagPaintCands();
}

/* 标签栏状态 + 底部信息栏 + 标题上的模型名 */
function procDiagPaintState() {
  const st = $("paState");
  if (st) {
    if (PROCDIAG.busy) st.innerHTML = '<i class="bi bi-arrow-repeat pa-spin"></i> 正在分析…';
    else if (PROCDIAG.error) st.innerHTML = '<i class="bi bi-exclamation-triangle"></i> 分析失败';
    else if (PROCDIAG.data) st.innerHTML = '<i class="bi bi-check2-circle"></i> 已生成结论';
    else st.textContent = "准备中…";
  }
  const m = $("paModel");
  const d = PROCDIAG.data;
  if (m) m.textContent = (d && d.model) ? d.model : "";
  const f = $("paFoot");
  if (!f) return;
  if (PROCDIAG.busy) {
    f.textContent = "正在采集快照并交给模型分析（通常 10 ~ 40 秒）";
    return;
  }
  if (PROCDIAG.error) { f.textContent = PROCDIAG.error; return; }
  if (!d) { f.textContent = "点「重新分析」把当前资源快照交给内置 AI 分析"; return; }
  const tk = (d.estimated ? "≈" : "") + ((d.tokens_in || 0) + (d.tokens_out || 0));
  f.textContent = "模型 " + (d.model || "-") + " · 用时 " + procDiagDur(d.elapsed_ms) + " · tokens " + tk +
    "（输入 " + (d.tokens_in || 0) + " / 输出 " + (d.tokens_out || 0) + "）· 快照 " +
    procPmClock((d.snapshot || {}).time);
}

/* 毫秒 → 分秒：20395 → 20 秒，95000 → 1 分 35 秒 */
function procDiagDur(ms) {
  const s = Math.max(0, Math.round((ms || 0) / 1000));
  const m = Math.floor(s / 60);
  return m > 0 ? m + " 分 " + (s % 60) + " 秒" : s + " 秒";
}

/* 顶部四张快照卡片（复用进程管理器的卡片样式） */
function procDiagPaintCards() {
  const box = $("paCards");
  if (!box) return;
  const ov = PROCDIAG.data && PROCDIAG.data.snapshot && PROCDIAG.data.snapshot.ov;
  if (!ov) { box.innerHTML = ""; return; }
  const cpu = ov.cpu || {}, mem = ov.mem || {}, disk = ov.disk || {}, net = ov.net || {};
  const kv = (k, v) => '<div class="pm-kv"><span class="k">' + esc(k) + '</span><span class="v">' + v + '</span></div>';
  const card = (icon, title, big, cls, sub, rows) =>
    '<div class="pm-card"><div class="pm-card-hd"><i class="bi ' + icon + '"></i><span>' + title + '</span></div>' +
    '<div class="pm-big pm-' + cls + '">' + big + '</div>' +
    '<div class="pm-subline">' + sub + '</div><div class="pm-rows">' + rows + '</div></div>';
  const idle = ((cpu.groups || []).filter(g => (g.name || "").indexOf("空闲") >= 0)[0] || {}).percent || 0;
  box.innerHTML =
    card("bi-cpu", "CPU（系统）", procPmPct(cpu.percent), procPmCls(cpu.percent),
      (cpu.cores || 1) + " 核" + ((cpu.load || []).length ? " · 负载 " + cpu.load.join(" / ") : ""),
      kv("已空闲", procPmPct(idle))) +
    card("bi-memory", "内存（系统）", procPmPct(mem.percent), procPmCls(mem.percent),
      "已用 " + procPmSize(mem.used) + " / 共 " + procPmSize(mem.total),
      kv("交换分区", mem.swap_total ? procPmSize(mem.swap_used) + " / " + procPmSize(mem.swap_total) : "未启用")) +
    card("bi-device-hdd", "磁盘（系统）", procPmPct(disk.percent), procPmCls(disk.percent),
      esc(disk.mount || "") + " · 可用 " + procPmSize(disk.free),
      kv("总量", procPmSize(disk.total))) +
    card("bi-arrow-down-up", "网络", procPmRate(net.down), "ok",
      "↑ " + procPmRate(net.up) + " · ↓ " + procPmRate(net.down),
      kv("进程总数", ((ov.counts || {}).total || 0) + " 个"));
}

/* 结论区：分析中 / 失败 / 结论正文（复用 AI 助手的 Markdown 渲染） */
function procDiagPaintResult() {
  const box = $("paResult");
  if (!box) return;
  if (PROCDIAG.busy) {
    box.innerHTML = '<div class="pa-loading">' +
      '<div class="pa-loading-row"><i class="bi bi-arrow-repeat pa-spin"></i>' +
      '正在分析本机资源占用…已等待 <b id="paTime">0 秒</b></div>' +
      '<div class="pa-skel"><span></span><span></span><span></span></div>' +
      '<div class="pa-loading-tip">快照已采集，正在等模型给出结论；接口越慢这里等得越久</div></div>';
    return;
  }
  if (PROCDIAG.error) {
    box.innerHTML = '<div class="pm-err"><i class="bi bi-exclamation-triangle"></i> ' + esc(PROCDIAG.error) + '</div>' +
      '<div class="pa-retry"><button class="pm-tab" id="paRetry"><i class="bi bi-arrow-clockwise"></i> 重试</button>' +
      '<span class="pa-retry-tip">也可以到「设置 → 系统 AI」检查「资源占用诊断」用的是哪个接口与模型</span></div>';
    return;
  }
  const d = PROCDIAG.data;
  if (!d) {
    box.innerHTML = '<div class="pa-empty">还没有诊断结论，点上方「重新分析」开始。</div>';
    return;
  }
  const tip = $("paTip");
  if (tip) tip.textContent = "由内置接口 POST /api/proc/diagnose 生成，结论仅供参考";
  box.innerHTML = '<div class="bubble ai-md pa-md">' +
    (typeof aiMd === "function" ? aiMd(d.text || "") : esc(d.text || "").replace(/\n/g, "<br>")) + '</div>';
}

/* 候选进程：后端按与「一键优化」相同的阈值筛出来的可安全结束列表 */
function procDiagPaintCands() {
  const box = $("paCands");
  if (!box) return;
  const snap = PROCDIAG.data && PROCDIAG.data.snapshot;
  const rows = (snap && snap.candidates) || [];
  const tip = $("paCandTip");
  if (tip) tip.textContent = snap ? "CPU ≥ 25% 或内存 ≥ 500 MB，且属于当前用户、不在本服务进程链上" : "";
  const btn = $("paKillAll");
  if (btn) btn.hidden = !rows.length;
  if (!snap) { box.innerHTML = '<div class="pa-empty">分析完成后会列出可以安全结束的高占用进程。</div>'; return; }
  if (!rows.length) { box.innerHTML = '<div class="pa-empty">没有符合阈值且可安全结束的进程，当前不需要清理。</div>'; return; }
  box.innerHTML = rows.map(r =>
    '<div class="pa-cand">' +
      '<span class="pm-name" title="' + procPmAttr(r.cmd || r.name) + '">' + esc(r.name) + '</span>' +
      '<span class="pa-cpid">pid ' + r.pid + '</span>' +
      '<span class="pa-ctag">' + esc(r.why || "") + '</span>' +
      '<span class="pa-cuser">' + esc(r.user || "-") + '</span>' +
      '<button class="pm-kill" data-pa-kill="' + r.pid + '" data-pa-name="' + procPmAttr(r.name) +
        '" title="结束该进程（先 SIGTERM，3 秒未退出再强制结束）"><i class="bi bi-x-circle"></i> 结束</button>' +
    '</div>').join("");
}

/* ------------------------------- 窗口内操作 ------------------------------- */
async function procDiagKill(pid, name) {
  const done = await procPmKill(pid, name, "proc");        // 复用统一的确认与结束流程
  if (done) procDiagDropCands([pid]);
}

async function procDiagOptimize() {
  const killed = await procPmOptimize();                   // 复用进程管理器里的一键优化
  if (killed && killed.length) procDiagDropCands(killed);
}

/* 结束成功后把对应行从候选里移除（不重新请求模型，省一次等待） */
function procDiagDropCands(pids) {
  const snap = PROCDIAG.data && PROCDIAG.data.snapshot;
  if (!snap || !snap.candidates) return;
  snap.candidates = snap.candidates.filter(c => pids.indexOf(c.pid) < 0);
  procDiagPaintCands();
}

async function procDiagCopy() {
  const d = PROCDIAG.data;
  if (!d || !d.text) { toast("还没有可复制的诊断结论", "warn"); return; }
  procDiagCopyText("【AI 资源诊断】" + (d.model ? "（" + d.model + "）" : "") + "\n\n" + d.text + "\n");
}

function procDiagCopyCode(btn) {
  const box = btn.closest(".ai-md-pre");
  const code = box && box.querySelector("pre code");
  if (code) procDiagCopyText(code.textContent || "");
}

async function procDiagCopyText(txt) {
  try {
    // 复用 AI 助手的复制实现（http 非安全上下文也能用），它自己不出提示，这里统一补一句
    if (typeof aiCopyText === "function") await aiCopyText(txt);
    else await navigator.clipboard.writeText(txt);
    toast("已复制到剪贴板", "ok");
  } catch (_) {
    toast("复制失败，请手动选择文本", "warn");
  }
}

/* ------------------------------- 一键优化 ------------------------------- */
const PROCPM_OPT = { cpu: 25, mem: 500 * 1024 * 1024 };   // 高占用阈值：CPU ≥ 25% 或常驻内存 ≥ 500MB

/* 筛出「可以安全结束、又确实占资源」的进程：
   can_kill 由后端把关（非本服务进程链、非系统关键进程、必须是当前用户自己的进程） */
function procPmCandidates(list) {
  return (list || []).filter(r => {
    if (!r.can_kill || r.in_app) return false;
    return (r.cpu || 0) >= PROCPM_OPT.cpu || (r.rss || 0) >= PROCPM_OPT.mem;
  }).map(r => {
    const bits = [];
    if ((r.cpu || 0) >= PROCPM_OPT.cpu) bits.push("CPU " + procPmPct(r.cpu));
    if ((r.rss || 0) >= PROCPM_OPT.mem) bits.push("内存 " + procPmSize(r.rss));
    return Object.assign({ why: bits.join(" / ") }, r);
  }).sort((a, b) => (b.rss || 0) - (a.rss || 0));
}

async function procPmOptimize() {
  let procs = PROCPM.procs || [];
  try {                                                 // 用全量列表（表格默认只取 200 条）
    const d = await procPmApi("/api/proc/list?sort=cpu&limit=400");
    procs = d.procs || procs;
    PROCPM.procs = procs;
  } catch (e) { toast((e && e.message) || "读取进程列表失败", "err"); return null; }

  const cand = procPmCandidates(procs).slice(0, 20);
  if (!cand.length) {
    toast("没有符合阈值的高占用进程（CPU ≥ " + PROCPM_OPT.cpu + "% 或内存 ≥ " + procPmSize(PROCPM_OPT.mem) +
      "）；想进一步分析可以点右边的「AI 诊断」", "ok");
    return null;
  }
  const lines = cand.map(r => "· " + r.name + "（pid " + r.pid + "）" + r.why + "，用户 " + (r.user || "-")).join("\n");
  const ok = await uiConfirm("一键优化：结束高占用进程",
    "发现 " + cand.length + " 个高占用进程：\n\n" + lines + "\n\n" +
    "只包含可安全结束的进程（当前用户所有、不属于本服务进程链）。\n" +
    "结束方式：先 SIGTERM 请求退出，3 秒未退出再强制结束。\n\n确定全部结束吗？", "全部结束", true);
  if (!ok) return null;

  let done = 0, fail = 0, freed = 0;
  const killed = [];                                   // 真正结束成功的 pid（AI 诊断窗口据此划掉候选行）
  for (const r of cand) {
    try {
      await procPmApi("/api/proc/kill", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pid: r.pid }),
      });
      done++; freed += (r.rss || 0);
      killed.push(r.pid);
    } catch (_) { fail++; }
  }
  toast("一键优化完成：已结束 " + done + " 个进程" + (done ? "（约释放 " + procPmSize(freed) + " 内存）" : "") +
    (fail ? "，" + fail + " 个失败（可能已自行退出）" : ""), done ? "ok" : "warn");
  setTimeout(() => procPmTick(true), 400);
  return killed;
}

/* ------------------------------- 入口绑定 ------------------------------- */
(function procPmInit() {
  const act = $("actProc");
  if (act) {
    act.onclick = () => procPmToggle();
    act.title = "进程资源管理器（CPU / 内存 / 磁盘 / 网络 / 进程）";
  }
  document.addEventListener("visibilitychange", () => {          // 页面切到后台时停一下轮询，回来自动恢复
    if (!PROCPM.open) return;
    if (document.hidden) {
      PROCPM.autoResume = !PROCPM.paused;                        // 只有「非用户手动暂停」才在回前台时恢复
      procPmPause(true);
    } else if (PROCPM.autoResume) {
      PROCPM.autoResume = false;
      procPmPause(false);
    }
  });
})();

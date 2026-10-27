/* ============================================================================
 * 47_ V2Ray / Xray 代理：订阅 + 节点 + 10808 代理出口
 *
 *   · 侧栏：连接 / 断开、运行状态、分享地址（局域网 + 本机）、节点快选；
 *   · 编辑区「V2Ray 代理」管理大页（虚拟标签页）：概览 / 节点 / 订阅 / 设置 / 日志；
 *   · 内核探测与下载走后台任务，进度用 SSE（EventSource）实时画进度条；
 *   · 后端：app/routes/ide/v2ray.py，服务层 app/services/ide/v2ray{cfg,db,mgr}.py。
 *
 *   连接后内核监听 0.0.0.0:10808（可在设置里改为仅本机），同网段的其他用户
 *   把「本机IP:10808」填成 SOCKS5 代理即可共用本机出口。
 *
 *   本文件须 include 在 16_ 之前，才能复用闭包内的 $ / esc / toast / uiConfirm /
 *   uiPrompt / uiModal / copyText / findTab / activate / renderTabsAll / tabs / currentWrap。
 * ========================================================================== */
(function () {
  "use strict";

  /* 注册侧栏面板（与插件系统一致：panels[id] 指向对应 .side-panel 的 id） */
  if (typeof panels !== "undefined") panels.v2ray = "v2rayPanel";
  if (typeof titles !== "undefined") titles.v2ray = "V2Ray 代理";

  const VIEW_PATH = "\u0000v2ray";           // 虚拟路径：不可见字符，避免与真实文件冲突
  const V2 = { st: null, nodes: [], subs: [], cores: [], coreInfo: null, sec: "overview",
               pick: "", selSub: null, logTimer: null, autoLog: false, log: "",
               trafTimer: null, traffic: null,
               busy: false, showManual: false, exit: null, ping: {}, dl: {}, kw: "",
               nodeTab: "__all__", sortPing: false, hideFail: false,
               subBusy: {}, subAllBusy: false,
               job: null, es: null, pendingUrl: "" };

  function escA(s) { return esc(String(s == null ? "" : s)).replace(/"/g, "&quot;"); }
  function api(path, opts) {
    return fetch(path, Object.assign({ headers: { "Content-Type": "application/json" } }, opts))
      .then(r => r.json().catch(() => ({ error: "响应解析失败" })))
      .catch(() => ({ error: "请求失败（服务未响应）" }));
  }
  function post(path, body) {
    return api(path, { method: "POST", body: JSON.stringify(body || {}) });
  }
  function fmtTime(ts) {
    if (!ts) return "-";
    const d = new Date(ts * 1000);
    const p = n => (n < 10 ? "0" : "") + n;
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " +
           p(d.getHours()) + ":" + p(d.getMinutes());
  }
  function fmtUp(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    if (h) return h + " 小时 " + m + " 分";
    if (m) return m + " 分 " + s + " 秒";
    return s + " 秒";
  }
  function fmtBytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(2) + " MB";
    return (n / 1024 / 1024 / 1024).toFixed(2) + " GB";
  }
  function protoIcon(p) {
    return ({ vmess: "bi-shield-lock", vless: "bi-shield-check", trojan: "bi-horse",
              ss: "bi-shadows", socks: "bi-diagram-3" })[p] || "bi-hdd-network";
  }
  /* 协议着色：给列表图标加一个 p-xxx 类，不同类型节点一眼区分 */
  function protoCls(p) { return "p-" + String(p || "x").toLowerCase(); }
  function nodeOf(id) { return V2.nodes.find(n => n.id === id) || null; }
  function curNodeId() { return (V2.st && V2.st.node && V2.st.node.id) || ""; }
  function pickNodeId() { return V2.pick || curNodeId() || ((V2.nodes[0] || {}).id || ""); }
  function val(id) { const el = $(id); return el ? el.value.trim() : ""; }

  /* ==================================================================
     统一拉取：状态 + 节点 + 订阅 + 内核（侧栏与大页共用同一份数据）
     ================================================================== */
  async function v2FetchAll() {
    const [st, nd, sb, co] = await Promise.all([
      api("/api/v2ray/status"), api("/api/v2ray/nodes"), api("/api/v2ray/subs"),
      api("/api/v2ray/core"),
    ]);
    if (!st.error) V2.st = st;
    if (!nd.error) {
      V2.nodes = nd.nodes || [];
      const m = nd.metrics || {};                 // 持久化的测速结果（覆盖到本地缓存）
      Object.keys(m).forEach(id => {
        if (!V2.nodes.some(n => n.id === id)) return;
        const row = m[id] || {};
        if (V2.ping[id] === undefined && row.ping !== undefined)
          V2.ping[id] = { ok: row.ping >= 0, ms: row.ping };
        if (V2.dl[id] === undefined && row.dl !== undefined) V2.dl[id] = row.dl;
      });
    }
    if (!sb.error) V2.subs = sb.subs || [];
    if (!co.error) { V2.cores = co.found || []; V2.coreInfo = co; }
    return V2.st;
  }
  async function v2Reload() {
    await v2FetchAll();
    v2SideRender();
    // 标签存在就渲染（包括后台标签）：会话恢复时可能先开标签又被别的标签抢走焦点，
    // 若只在「激活中」才渲染，竞态会让大页内容永远空白
    if (findTab(VIEW_PATH)) v2vRender();
  }

  /* ==================================================================
     内核任务：探测 / 下载的实时进度（EventSource 订阅 SSE）
     ================================================================== */
  function v2JobBusy() { return !!(V2.job && !V2.job.done); }

  function v2JobClose() {
    if (V2.es) { try { V2.es.close(); } catch (_) { /* 忽略 */ } V2.es = null; }
  }

  function v2JobFail(kind, msg) {
    v2JobClose();
    V2.job = { kind: kind, phase: "失败", pct: 0, log: [], done: true, ok: false, error: msg };
    v2ProgPaint();
    toast(msg, "err");
  }

  /** 启动一个内核后台任务，并用 SSE 实时刷新进度条。 */
  function v2JobRun(kind, path, body) {
    if (v2JobBusy()) return toast("已有任务在进行中，请稍候", "warn");
    v2JobClose();
    V2.job = { kind: kind, phase: "准备中", pct: 0, log: [], done: false, ok: null, error: "" };
    v2ProgPaint();
    post(path, body || {}).then(r => {
      if (!r || r.error || !r.job) return v2JobFail(kind, (r && r.error) || "任务启动失败");
      const es = new EventSource("/api/v2ray/core/job/" + r.job + "/stream");
      V2.es = es;
      es.onmessage = (ev) => {
        let j;
        try { j = JSON.parse(ev.data); } catch (_) { return; }
        V2.job = j;
        v2ProgPaint();
        if (!j.done) return;
        v2JobClose();
        if (j.ok) {
          const found = ((j.result || {}).found || []).length;
          toast(j.kind === "detect" ? ("探测完成，找到 " + found + " 个可用内核")
                                    : ("内核已就绪：" + ((j.result || {}).version || "")), "ok");
          v2Reload().catch(() => {});
        } else {
          toast(j.error || "任务失败", "err");
        }
      };
      // 任务结束后服务端会主动断开连接，此时 done 已为 true，属正常收尾
      es.onerror = () => {
        if (V2.job && !V2.job.done) v2JobFail(kind, "进度连接中断，请刷新后重试");
        else v2JobClose();
      };
    });
  }

  /* 进度条 DOM 就地更新（不整页重渲染，保证条纹动画不闪） */
  function v2ProgPaint() {
    const box = $("v2Prog");
    if (!box) return;
    const j = V2.job;
    if (!j) { box.style.display = "none"; return; }
    box.style.display = "";
    const doneOk = j.done && j.ok === true, doneErr = j.done && j.ok === false;
    box.classList.toggle("ok", doneOk);
    box.classList.toggle("err", doneErr);
    // 下载时拿不到 Content-Length 就退化为「不确定态」来回滑动的条纹
    const indet = j.kind === "download" && !j.done && !(j.total > 0);
    box.classList.toggle("indet", indet);
    const pct = indet ? 100 : Math.max(0, Math.min(100, Number(j.pct) || 0));
    const ico = $("v2ProgIco");
    if (ico) ico.className = "bi " + (j.kind === "detect" ? "bi-search" : "bi-cloud-arrow-down");
    const ph = $("v2ProgPhase");
    if (ph) ph.textContent = j.phase || "处理中";
    const pc = $("v2ProgPct");
    if (pc) {
      if (j.kind === "download" && j.total > 0) pc.textContent = fmtBytes(j.got) + " / " + fmtBytes(j.total) + " · " + pct + "%";
      else pc.textContent = pct + "%";
    }
    const fill = $("v2ProgFill");
    if (fill) fill.style.width = pct + "%";
    const sub = $("v2ProgSub");
    if (sub) sub.textContent = j.error || (j.done ? (doneOk ? "任务已完成" : "任务失败") : "");
    const lg = $("v2ProgLog");
    if (lg) {
      lg.innerHTML = (j.log || []).slice(-20).map(l => "<div>" + esc(l) + "</div>").join("");
      lg.scrollTop = lg.scrollHeight;
    }
  }

  function v2ProgHtml() {
    return '<div class="v2-prog" id="v2Prog" style="display:none">' +
      '<div class="v2-prog-head"><i class="bi bi-cloud-arrow-down" id="v2ProgIco"></i>' +
      '<span class="v2-prog-phase" id="v2ProgPhase">准备中</span>' +
      '<span class="v2-prog-pct" id="v2ProgPct"></span></div>' +
      '<div class="v2-prog-track"><div class="v2-prog-fill" id="v2ProgFill"></div></div>' +
      '<div class="v2-prog-sub" id="v2ProgSub"></div>' +
      '<div class="v2-prog-log" id="v2ProgLog"></div>' +
      "</div>";
  }

  /* ==================================================================
     侧栏
     ================================================================== */
  function v2SideRender() {
    const st = V2.st || {};
    const running = !!st.running;
    const badge = $("actV2Badge");
    if (badge) {
      const okN = V2.nodes.filter(n => V2.ping[n.id] && V2.ping[n.id].ok).length;
      badge.textContent = String(okN);        // 只显示测速连接成功的节点数
      badge.title = "测速成功节点 " + okN + " / " + V2.nodes.length;
      badge.style.display = okN ? "" : "none";
    }
    const hero = $("v2Hero");
    if (hero) hero.classList.toggle("on", running);
    const bt = $("v2Connect");
    if (bt) {
      bt.className = "v2-btn " + (running ? "danger" : "v2-btn-pri");
      bt.innerHTML = running
        ? '<i class="bi bi-stop-fill"></i><span>断开</span>'
        : '<i class="bi bi-play-fill"></i><span>连接</span>';
    }
    const run = $("v2StRun");
    if (run) run.textContent = running ? "运行中" : "未运行";
    const port = $("v2StPort");
    if (port) {
      const inb = st.inbound || {};
      port.textContent = running
        ? ((st.node ? st.node.name : "已连接") + " · " + inb.listen + ":" + inb.socks_port)
        : "尚未连接节点";
      port.title = port.textContent;
    }
    const core = $("v2StCore");
    if (core) {
      const c = st.core || {};
      core.classList.toggle("err", !c.ok);
      core.title = c.path || "";
      core.innerHTML = '<i class="bi bi-cpu"></i><span>' +
        esc(c.ok ? ((c.version || "已就绪") + " · " + c.path) : "未找到内核") + "</span>";
    }
    const sh = $("v2Share");
    if (sh) {
      const list = (running && st.share) ? st.share : [];
      sh.innerHTML = list.map(s =>
        '<div class="v2-share-row"><span class="v2-share-tag">' + esc(s.label) + "</span>" +
        '<span class="v2-share-url" title="' + escA(s.url) + '">' + esc(s.url) + "</span>" +
        '<i class="bi bi-clipboard v2-share-cp" data-copy="' + escA(s.url) + '" title="复制"></i></div>'
      ).join("");
    }
    const num = $("v2NodeNum");
    if (num) {
      const okN = V2.nodes.filter(n => V2.ping[n.id] && V2.ping[n.id].ok).length;
      num.textContent = String(okN);          // 只显示测速成功的节点数
      num.title = "测速连接成功的节点数";
    }
    const lst = $("v2NodeList");
    if (lst) {
      if (!V2.nodes.length) {
        lst.innerHTML = '<div class="v2v-empty" style="padding:16px 8px;font-size:11px">' +
          '<i class="bi bi-inbox"></i>还没有节点<br>点下方「打开管理面板」添加</div>';
      } else {
        // 隐藏测速超时的节点；未测速的节点照常显示
        const alive = V2.nodes.filter(n => !(V2.ping[n.id] && !V2.ping[n.id].ok));
        if (!alive.length) {
          lst.innerHTML = '<div class="v2v-empty" style="padding:16px 8px;font-size:11px">' +
            '<i class="bi bi-wifi-off"></i>没有可用的节点<br>所有节点测速均超时</div>';
        } else {
          const cid = curNodeId(), pid = pickNodeId();
          const sorted = alive.slice().sort((a, b) => {
            const va = (V2.ping[a.id] && V2.ping[a.id].ok) ? V2.ping[a.id].ms : 9e9;
            const vb = (V2.ping[b.id] && V2.ping[b.id].ok) ? V2.ping[b.id].ms : 9e9;
            return va - vb;
          });
          lst.innerHTML = sorted.map(n => {
            const p = V2.ping[n.id];
            const tag = (p && p.ok) ? '<span class="v2-tag-ping" title="延迟">' + p.ms + 'ms</span>' : "";
            return '<div class="v2-item' + (n.id === pid ? " on" : "") + '" data-node="' + escA(n.id) + '">' +
            '<i class="bi ' + protoIcon(n.proto) + '"></i>' +
            '<div class="v2-it-info"><div class="v2-it-nm">' + esc(n.name || "(未命名)") + "</div>" +
            '<div class="v2-it-sub">' + esc(n.proto || "") + " · " + esc(n.server || "") + ":" + esc(n.port || "") + "</div></div>" +
            (n.id === cid ? '<span class="v2-tag-live">已连接</span>' : "") + tag + "</div>";
          }).join("");
        }
      }
    }
  }

  async function v2ToggleConnect() {
    if (V2.busy) return;
    V2.busy = true;
    try {
      const running = !!(V2.st && V2.st.running);
      if (running) {
        const ok = await uiConfirm("断开连接", "停止内核后，正在使用 10808 代理的用户会立即断网。", "断开", true);
        if (!ok) return;
        const r = await post("/api/v2ray/disconnect");
        if (r.error) return toast(r.error, "err");
        toast("已断开", "ok");
      } else {
        const id = pickNodeId();
        if (!id) { toast("请先在管理面板里添加节点", "warn"); return v2OpenView("nodes"); }
        const r = await post("/api/v2ray/connect", { id: id });
        if (r.error) return toast(r.error, "err");
        toast("已连接：" + ((nodeOf(id) || {}).name || id), "ok");
      }
      await v2Reload();
    } finally { V2.busy = false; }
  }

  (function v2SideInit() {
    const cn = $("v2Connect"); if (cn) cn.onclick = v2ToggleConnect;
    const rf = $("v2Refresh"); if (rf) rf.onclick = () => v2Reload();
    const ov = $("v2OpenView"); if (ov) ov.onclick = () => v2OpenView();
    const sh = $("v2Share");
    if (sh) sh.addEventListener("click", (e) => {
      const cp = e.target.closest("[data-copy]"); if (cp) copyText(cp.dataset.copy);
    });
    const lst = $("v2NodeList");
    if (lst) lst.addEventListener("click", async (e) => {
      const it = e.target.closest(".v2-item[data-node]"); if (!it) return;
      const id = it.dataset.node;
      V2.pick = id;
      v2SideRender();
      if (id === curNodeId() || V2.busy) return;
      V2.busy = true;
      try {
        toast("正在切换节点…", "info");
        const r = await post("/api/v2ray/connect", { id: id });
        if (r.error) return toast(r.error, "err");
        toast("已连接：" + ((nodeOf(id) || {}).name || id), "ok");
        await v2Reload();
      } finally { V2.busy = false; }
    });
    // 活动栏图标：点一下补一次实时刷新（面板显隐由 02_ 的通用机制驱动）
    const act = document.querySelector('.activitybar .act[data-panel="v2ray"]');
    if (act) act.addEventListener("click", () => { v2Reload(); });
    v2FetchAll().then(v2SideRender).catch(() => {});
  })();

  // 供 00_preamble 的会话恢复调用：刷新后重开「V2Ray 代理」大页（分区沿用上次打开的）
  window.v2rayRestoreView = function () {
    let sec;
    try { sec = (JSON.parse(localStorage.getItem(LS_VIEW) || "null") || {}).sec; } catch (_) { sec = undefined; }
    v2OpenView(sec);
  };

  // 供 02_ 的 showPanel 在切到本面板时调用（会话恢复 / 代码调用也会走到）
  window.v2rayLoad = function () { v2Reload().catch(() => {}); };

  /* ==================================================================
     编辑区「V2Ray 代理」管理大页（虚拟标签页）
     ================================================================== */
  function v2vActive() { return !!findTab(VIEW_PATH) && active && active.path === VIEW_PATH; }

  /* 打开状态持久化：刷新后自动恢复「V2Ray 代理」大页及其所在分区 */
  const LS_VIEW = "ide_v2ray_view";

  /* 节点列表视图状态持久化：延迟排序 / 隐藏超时 / 分组 tab / 搜索关键词，刷新后仍在 */
  const LS_NODES_VIEW = "ide_v2ray_nodes_view";
  function v2SaveNodesView() {
    try {
      localStorage.setItem(LS_NODES_VIEW, JSON.stringify({
        sortPing: !!V2.sortPing,
        hideFail: !!V2.hideFail,
        nodeTab: V2.nodeTab || "__all__",
        kw: V2.kw || "",
      }));
    } catch (_) { /* 隐私模式等场景忽略 */ }
  }
  function v2LoadNodesView() {
    try {
      const s = JSON.parse(localStorage.getItem(LS_NODES_VIEW) || "null") || {};
      V2.sortPing = !!s.sortPing;
      V2.hideFail = !!s.hideFail;
      V2.nodeTab = s.nodeTab || "__all__";
      V2.kw = s.kw || "";
    } catch (_) { /* 解析失败就用默认值 */ }
  }
  v2LoadNodesView();
  function v2SaveView(open) {
    try {
      localStorage.setItem(LS_VIEW, JSON.stringify({
        open: open === undefined ? !!findTab(VIEW_PATH) : !!open,
        sec: V2.sec || "overview",
      }));
    } catch (_) { /* 隐私模式等场景忽略 */ }
  }

  function v2OpenView(sec) {
    if (sec) V2.sec = sec;
    let tab = findTab(VIEW_PATH);
    if (!tab) {
      const host = document.createElement("div");
      host.className = "cm-host v2-view-host";
      host.innerHTML = '<div class="v2-view" id="v2View"></div>';
      const dw = currentWrap();
      (dw || edGroups).appendChild(host);
      v2vBind($("v2View"));
      tab = {
        path: VIEW_PATH, host: host, cm: null, original: "", dirty: false,
        group: curGroup, name: "V2Ray 代理", displayPath: "V2Ray 代理", relPath: "",
        iconHtml: '<i class="bi bi-shield-shaded" style="color:#4fc9a8"></i>',
      };
      tab.onBeforeClose = () => { v2LogStop(); v2TrafStop(); v2JobClose(); v2SaveView(false); return true; };
      tab.onActivate = () => {
        v2Reload().catch(() => {});
        if (V2.autoLog) v2LogStart();
        if (V2.sec === "overview") v2TrafStart();
      };
      tabs.push(tab);
      renderTabsAll();
    }
    activate(tab);
    v2SaveView();
    v2Reload().catch(() => {});
    return tab;
  }

  /* ---------- 渲染 ---------- */
  /** 卡片标题：图标 + 主标题 / 副标题 + 右侧操作区 */
  function v2vSecHead(ico, title, sub, extra) {
    return '<div class="v2v-sec-t"><i class="bi ' + ico + '"></i>' +
      '<div class="v2v-sec-tt"><b>' + esc(title) + "</b>" +
      (sub ? "<span>" + sub + "</span>" : "") + "</div>" + (extra || "") + "</div>";
  }

  function v2vRender() {
    const box = $("v2View"); if (!box) return;
    const secs = [["overview", "概览", "bi-speedometer2"], ["nodes", "节点", "bi-diagram-3"],
                  ["subs", "订阅", "bi-rss"], ["settings", "设置", "bi-sliders"],
                  ["log", "日志", "bi-journal-text"]];
    const st = V2.st || {}, running = !!st.running;
    const inb = st.inbound || {}, c = st.core || {}, n = st.node;
    // 页头副标题：把「节点 / 订阅 / 内核」的关键信息压成一行胶囊
    const bits = [];
    if (running) {
      bits.push('<span class="v2v-sub-on"><i class="bi bi-diagram-3"></i>' +
        esc((n && n.name) || "已连接") + "</span>");
      if (inb.socks_port) bits.push('<span><i class="bi bi-hdd-network"></i>' +
        esc(inb.listen + ":" + inb.socks_port) + "</span>");
    }
    bits.push('<span><i class="bi bi-collection"></i>' + V2.nodes.length + " 个节点</span>");
    bits.push('<span><i class="bi bi-rss"></i>' + V2.subs.length + " 个订阅</span>");
    bits.push(c.ok
      ? '<span class="ok"><i class="bi bi-cpu"></i>' + esc(c.version || "内核已就绪") + "</span>"
      : '<span class="bad"><i class="bi bi-cpu"></i>内核未安装</span>');
    const head =
      '<div class="v2v-hero">' +
      '<span class="v2v-glow"></span>' +
      '<span class="v2v-logo' + (running ? " on" : "") + '"><i class="bi bi-shield-shaded"></i></span>' +
      '<div class="v2v-brand">' +
      '<div class="v2v-title">V2Ray 代理' +
      '<span class="v2v-state' + (running ? " on" : "") + '">' + (running ? "运行中" : "未运行") + "</span></div>" +
      '<div class="v2v-sub">' + bits.join('<i class="v2v-dotsep"></i>') + "</div>" +
      "</div>" +
      '<div class="v2v-head-ops">' +
      '<button class="v2v-btn ' + (running ? "danger" : "primary") + '" data-act="toggle">' +
      '<i class="bi ' + (running ? "bi-stop-fill" : "bi-play-fill") + '"></i>' + (running ? "断开" : "连接") + "</button>" +
      '<button class="v2v-btn" data-act="restart"' + (running ? "" : " disabled") + '><i class="bi bi-arrow-repeat"></i>重启</button>' +
      '<button class="v2v-btn" data-act="refresh" title="刷新状态、节点与订阅"><i class="bi bi-arrow-clockwise"></i>刷新</button>' +
      "</div></div>";
    const tabbar = '<div class="v2v-tabs">' + secs.map(s => {
      const num = s[0] === "nodes" ? V2.nodes.length : (s[0] === "subs" ? V2.subs.length : 0);
      return '<button class="v2v-tab' + (V2.sec === s[0] ? " on" : "") + '" data-sec="' + s[0] + '">' +
        '<i class="bi ' + s[2] + '"></i><span>' + s[1] + "</span>" +
        (num ? '<span class="v2v-num">' + num + "</span>" : "") + "</button>";
    }).join("") + "</div>";
    let body = "";
    if (V2.sec === "overview") body = v2vOverview(st);
    else if (V2.sec === "nodes") body = v2vNodes();
    else if (V2.sec === "subs") body = v2vSubs();
    else if (V2.sec === "settings") body = v2vSettings(st);
    else body = v2vLog();
    box.innerHTML = head + tabbar + body;
    v2ProgPaint();
  }

  function v2vBanner() {
    const st = V2.st || {};
    if (st.core && st.core.ok) return "";
    return '<div class="v2v-hint warn"><i class="bi bi-exclamation-triangle"></i><div>' +
      "<strong>还没有可用的内核。</strong>到「设置」里点「一键下载 Xray-core」，" +
      "或把已有的 xray / v2ray 可执行文件路径填进去。</div></div>";
  }

  function v2vOverview(st) {
    const inb = st.inbound || {}, c = st.core || {}, n = st.node, running = !!st.running;
    // 指标卡：一眼看清「状态 / 节点 / 内核 / 端口」
    const stat = (ico, label, value, extra, cls) =>
      '<div class="v2v-stat' + (cls ? " " + cls : "") + '">' +
      '<span class="v2v-stat-ico"><i class="bi ' + ico + '"></i></span>' +
      '<div class="v2v-stat-tx"><b>' + esc(label) + "</b>" +
      '<strong title="' + escA(value) + '">' + esc(value) + "</strong>" +
      (extra ? '<em title="' + escA(extra) + '">' + esc(extra) + "</em>" : "") + "</div></div>";
    const kv = (k, v, cls) =>
      "<div><b>" + esc(k) + "</b><span" + (cls ? ' class="' + cls + '"' : "") +
      ' title="' + escA(v) + '">' + esc(v) + "</span></div>";

    let h = v2vBanner();
    h += '<div class="v2v-sec">' +
      v2vSecHead("bi-activity", "运行状态",
        running ? "已稳定运行 " + esc(fmtUp(st.uptime)) : "内核未启动，点右上角「连接」即可启动") +
      '<div class="v2v-stats">' +
      stat("bi-broadcast", "代理状态", running ? "运行中" : "未运行",
        running ? ("PID " + st.pid) : "等待连接", running ? "on" : "off") +
      stat("bi-diagram-3", "当前节点", n ? (n.name || "(未命名)") : "未选择",
        n ? (n.proto + " · " + n.server + ":" + n.port) : "从「节点」里挑一个") +
      stat("bi-cpu", "内核", c.ok ? (c.version || "已就绪") : "未找到",
        c.ok ? "xray / v2ray 已就绪" : "到「设置」一键下载", c.ok ? "" : "bad") +
      stat("bi-hdd-network", "代理监听", inb.socks_port ? ("SOCKS5 · " + inb.socks_port) : "-",
        inb.listen ? ("监听 " + inb.listen) : "未启动", running ? "on" : "") +
      '<div class="v2v-stat' + (running ? " on" : "") + '" id="v2vSpdCard">' +
      '<span class="v2v-stat-ico"><i class="bi bi-arrow-down-up"></i></span>' +
      '<div class="v2v-stat-tx"><b>实时网速</b><strong id="v2vSpdTx">' +
      esc(v2vSpeedText()) + '</strong><em>每 5 秒自动刷新 · 采样自内核统计</em></div></div>' +
      "</div>" +
      '<div class="v2v-kv">' +
      kv("内核路径", c.path || "-", "mono") +
      kv("代理认证", inb.auth ? "已开启（用户名 / 密码）" : "无认证") +
      kv("HTTP 代理", inb.http_port ? ("端口 " + inb.http_port + " · " + inb.listen) : "未开启", inb.http_port ? "mono" : "") +
      kv("节点地址", n ? (n.server + ":" + n.port) : "-", "mono") +
      "</div></div>";

    const share = (running && st.share) ? st.share : [];
    h += '<div class="v2v-sec">' +
      v2vSecHead("bi-broadcast", "代理出口", "把地址填进其它设备的代理设置即可共用本机出口");
    if (share.length) {
      h += '<div class="v2v-list">' + share.map(s =>
        '<div class="v2v-item"><span class="v2v-ico p-share"><i class="bi bi-broadcast"></i></span>' +
        '<div class="v2v-info"><div class="v2v-nm">' + esc(s.label) + "</div>" +
        '<div class="v2v-meta"><span class="v2v-code">' + esc(s.url) + "</span></div></div>" +
        '<div class="v2v-ops"><button class="v2v-btn ico" data-act="copy" data-v="' + escA(s.url) +
        '" title="复制地址"><i class="bi bi-clipboard"></i></button></div></div>'
      ).join("") + "</div>";
      h += '<div class="v2v-hint"><i class="bi bi-info-circle"></i><div>局域网地址要求对方与本机在同一网段；' +
        "<strong>若监听地址设为 127.0.0.1，则只有本机可用</strong>。" +
        "担心被滥用时可以到「设置」里加上 SOCKS5 用户名 / 密码。</div></div>";
    } else {
      h += '<div class="v2v-empty"><i class="bi bi-broadcast-pin"></i><b>暂无可分享的地址</b>' +
        "<span>连接一个节点后，这里会列出局域网与本机的代理地址</span></div>";
    }
    h += "</div>";

    h += '<div class="v2v-sec" id="v2vTrafSec">' + v2vTrafSecHTML() + "</div>";

    const e = V2.exit;
    const exCls = e ? (e.ok ? "ok" : "err") : "idle";
    const exIco = e ? (e.ok ? "bi-globe-americas" : "bi-exclamation-octagon") : "bi-globe2";
    const g = (e && e.geo) || {};
    const geoBits = [g.country, g.city].filter(Boolean).join(" ");
    const exTitle = e ? (e.ok ? ("出口 IP · " + e.ip) : "测试失败") : "尚未测试";
    const exSub = e ? (e.ok ? ((geoBits || "归属地未知") + (g.isp ? " · ISP：" + g.isp : " · 未获取到 ISP"))
                    : (e.error || "请检查节点与网络连通性"))
                    : "点右上角「测试出口」发起一次探测，显示出口 IP 与归属地";
    h += '<div class="v2v-sec">' +
      v2vSecHead("bi-globe2", "出口测试", "经本机代理访问 api.ipify.org，确认真实出口 IP",
        '<span class="v2v-flex"></span><button class="v2v-btn primary" data-act="exit-test"' +
        (running ? "" : " disabled") + '><i class="bi bi-send-check"></i>测试出口</button>') +
      '<div class="v2v-exit ' + exCls + '">' +
      '<span class="v2v-exit-ico"><i class="bi ' + exIco + '"></i></span>' +
      '<div class="v2v-exit-tx"><b>' + esc(exTitle) + "</b><span>" + esc(exSub) + "</span></div>" +
      "</div></div>";
    return h;
  }

  /* ---------- 实时网速 + 流量统计（概览页专属，5 秒轮询局部更新） ---------- */
  function v2vSpeedText() {
    const t = V2.traffic;
    if (!t) return "…";
    const sp = t.speed || { up: 0, down: 0 };
    return fmtBytes(sp.up) + "/s ↑ · " + fmtBytes(sp.down) + "/s ↓";
  }

  function v2vTrafSecHTML() {
    const t = V2.traffic;
    return v2vSecHead("bi-bar-chart-line", "流量统计",
      "按节点累计的上下行流量，持久化保存，重启不丢",
      '<span class="v2v-flex"></span>' +
      '<button class="v2v-btn" data-act="traffic-refresh" title="立即刷新"><i class="bi bi-arrow-clockwise"></i></button>' +
      '<button class="v2v-btn danger" data-act="traffic-reset"><i class="bi bi-eraser"></i>清零</button>') +
      v2vTrafficHTML(t);
  }

  function v2vTrafficHTML(t) {
    t = t || { speed: { up: 0, down: 0 }, total: { up: 0, down: 0 }, nodes: [] };
    const sp = t.speed || {}, tot = t.total || { up: 0, down: 0 };
    const chip = (ico, label, val, cls) =>
      '<div class="v2v-tsp ' + (cls || "") + '"><i class="bi ' + ico + '"></i>' +
      "<span>" + esc(label) + '</span><b title="' + escA(val) + '">' + esc(val) + "</b></div>";
    let h = '<div class="v2v-trow">' +
      chip("bi-graph-up-arrow", "实时上行", fmtBytes(sp.up || 0) + "/s", "up") +
      chip("bi-graph-down-arrow", "实时下行", fmtBytes(sp.down || 0) + "/s", "down") +
      chip("bi-cloud-arrow-up", "累计上行", fmtBytes(tot.up || 0)) +
      chip("bi-cloud-arrow-down", "累计下行", fmtBytes(tot.down || 0)) +
      "</div>";
    const nodes = t.nodes || [];
    if (!nodes.length) {
      h += '<div class="v2v-empty"><i class="bi bi-bar-chart-line"></i><b>还没有节点流量记录</b>' +
        "<span>连接节点并产生流量后，这里会按节点分别统计</span></div>";
    } else {
      const max = Math.max(1, nodes[0].up + nodes[0].down);
      h += '<div class="v2v-list">' + nodes.map(nd => {
        const sum = nd.up + nd.down;
        const pct = Math.max(2, Math.round(sum * 100 / max));
        const cur = nd.id === curNodeId();
        return '<div class="v2v-item' + (cur ? " on" : "") + '">' +
          '<span class="v2v-ico ' + protoCls(nd.proto) + '"><i class="bi ' + protoIcon(nd.proto) + '"></i></span>' +
          '<div class="v2v-info"><div class="v2v-nm">' + esc(nd.name || "(未命名)") +
            (cur ? '<span class="v2v-pill on"><i class="bi bi-broadcast"></i>当前</span>' : "") + "</div>" +
          '<div class="v2v-meta"><em title="上行">↑ ' + fmtBytes(nd.up) + "</em>" +
            '<em title="下行">↓ ' + fmtBytes(nd.down) + "</em>" +
            "<em>共 " + fmtBytes(sum) + "</em></div>" +
          '<div class="v2v-tbar"><i style="width:' + pct + '%"></i></div>' +
          "</div></div>";
      }).join("") + "</div>";
    }
    if (t.api_ok === false || (!nodes.length && !tot.up && !tot.down)) {
      h += '<div class="v2v-hint"><i class="bi bi-info-circle"></i><div>实时速度需要<strong>已连接节点</strong>且开启统计 API' +
        "（设置里「统计 API 端口」默认 15490，改过设置后需重连一次生效）；流量累计在连接期间持续写入，重启服务不丢失。</div></div>";
    }
    return h;
  }

  async function v2TrafficFetch() {
    const r = await api("/api/v2ray/traffic");
    if (r.error) return;
    V2.traffic = r;
    if (!v2vActive()) return;
    const tx = $("v2vSpdTx");
    if (tx) tx.textContent = v2vSpeedText();
    const sec = $("v2vTrafSec");
    if (sec) sec.innerHTML = v2vTrafSecHTML();
  }

  function v2TrafStop() { clearTimeout(V2.trafTimer); V2.trafTimer = null; }
  function v2TrafStart() {
    v2TrafStop();
    const tick = async () => {
      if (!v2vActive() || V2.sec !== "overview") { V2.trafTimer = null; return; }
      await v2TrafficFetch().catch(() => {});
      if (V2.trafTimer === null) return;
      V2.trafTimer = setTimeout(tick, 5000);
    };
    tick();
  }

  function v2vNodes() {
    const kw = (V2.kw || "").trim().toLowerCase();
    // tab 分组：全部 / 按订阅名 / 自定义分组（节点编辑里填的 grp）
    const grpNames = [...new Set(V2.nodes.map(n => (n.grp || "").trim()).filter(Boolean))];
    const tabs = [{ k: "__all__", label: "全部" }]
      .concat((V2.subs || []).map(s => ({ k: "sub:" + s.id, label: s.name || s.id })))
      .concat(grpNames.map(g => ({ k: "grp:" + g, label: g })));
    if (!tabs.some(t => t.k === V2.nodeTab)) V2.nodeTab = "__all__";
    let list = V2.nodes.filter(n => !kw ||
      String(n.name || "").toLowerCase().includes(kw) || String(n.server || "").toLowerCase().includes(kw));
    if (V2.nodeTab.indexOf("sub:") === 0) list = list.filter(n => n.sub_id === V2.nodeTab.slice(4));
    else if (V2.nodeTab.indexOf("grp:") === 0) list = list.filter(n => (n.grp || "").trim() === V2.nodeTab.slice(4));
    if (V2.hideFail) list = list.filter(n => !(V2.ping[n.id] && !V2.ping[n.id].ok));   // 隐藏超时节点
    if (V2.sortPing) list = list.slice().sort((a, b) => {   // 按延迟升序，未测的排最后
      const va = (V2.ping[a.id] && V2.ping[a.id].ok) ? V2.ping[a.id].ms : 9e9;
      const vb = (V2.ping[b.id] && V2.ping[b.id].ok) ? V2.ping[b.id].ms : 9e9;
      return va - vb;
    });
    // 大量节点（上千条）时一次性 innerHTML 全量渲染会严重卡顿：
    // 只渲染前 V2.nodeShow 条，列表末尾放「加载更多」，点一次补一批
    if (!V2.nodeShow) V2.nodeShow = 60;
    const shown = list.slice(0, V2.nodeShow);
    const tabHtml = '<div class="v2v-tabs">' + tabs.map(t =>
      '<button class="v2v-tab' + (V2.nodeTab === t.k ? " on" : "") + '" data-act="node-tab" data-tab="' +
      escA(t.k) + '">' + esc(t.label) + (t.k === "__all__" ? " " + V2.nodes.length : "") + "</button>").join("") + "</div>";
    const cid = curNodeId();
    // 测速超时的节点数（当前已连接的节点不算，避免误删导致断网）
    const failN = V2.nodes.filter(n => n.id !== cid && V2.ping[n.id] && !V2.ping[n.id].ok).length;
    let h = '<div class="v2v-sec">' +
      v2vSecHead("bi-plus-circle", "导入节点", "支持 vmess / vless / trojan / ss 分享链接，可一次粘贴多行") +
      '<div class="v2v-grid"><label class="v2v-field v2v-field-wide">' +
      '<span>粘贴分享链接（每行一条）</span>' +
      '<textarea id="v2vLinks" placeholder="vmess://...&#10;vless://...&#10;trojan://...&#10;ss://..."></textarea></label></div>' +
      '<div class="v2v-actions"><button class="v2v-btn primary" data-act="add-links"><i class="bi bi-box-arrow-in-down"></i>添加链接</button>' +
      '<button class="v2v-btn" data-act="toggle-manual"><i class="bi bi-pencil-square"></i>' +
        (V2.showManual ? "收起手填表单" : "手填节点参数") + "</button></div>";
    if (V2.showManual) {
      h += '<div class="v2v-subhead"><span>手填参数</span></div>' +
        '<div class="v2v-grid">' +
        '<label class="v2v-field"><span>协议</span><select id="v2vMProto">' +
          ["vmess", "vless", "trojan", "ss"].map(p => '<option value="' + p + '">' + p + "</option>").join("") +
        "</select></label>" +
        '<label class="v2v-field"><span>名称（备注）</span><input type="text" id="v2vMName" placeholder="可留空"></label>' +
        '<label class="v2v-field"><span>服务器地址</span><input type="text" id="v2vMServer" placeholder="example.com"></label>' +
        '<label class="v2v-field"><span>端口</span><input type="number" id="v2vMPort" placeholder="443"></label>' +
        '<label class="v2v-field"><span>UUID / 密码</span><input type="text" id="v2vMUuid" placeholder="vmess / vless 填 uuid，trojan / ss 填密码"></label>' +
        '<label class="v2v-field"><span>加密方式（ss）</span><input type="text" id="v2vMMethod" placeholder="aes-256-gcm"></label>' +
        '<label class="v2v-field"><span>传输方式</span><select id="v2vMNet">' +
          ["tcp", "ws", "grpc", "h2", "http"].map(p => '<option value="' + p + '">' + p + "</option>").join("") +
        "</select></label>" +
        '<label class="v2v-field"><span>TLS</span><select id="v2vMTls">' +
          '<option value="none">无</option><option value="tls">tls</option></select></label>' +
        '<label class="v2v-field"><span>Host 头</span><input type="text" id="v2vMHost"></label>' +
        '<label class="v2v-field"><span>路径 / serviceName</span><input type="text" id="v2vMPath"></label>' +
        '<label class="v2v-field"><span>SNI</span><input type="text" id="v2vMSni"></label>' +
        '<label class="v2v-field"><span>alterId（vmess）</span><input type="number" id="v2vMAid" value="0"></label>' +
      "</div>" +
      '<div class="v2v-actions"><button class="v2v-btn primary" data-act="add-manual"><i class="bi bi-check2"></i>添加节点</button></div>';
    }
    h += "</div>";

    h += '<div class="v2v-sec">' +
      v2vSecHead("bi-diagram-3", "节点列表",
        (V2.pingProg ? "并发测速中 " + V2.pingProg.done + "/" + V2.pingProg.total + " · " : "") +
        (list.length ? ("共 " + list.length + " 个节点" + (kw ? "（已过滤）" : "")) : "还没有可用的节点"),
        '<span class="v2v-flex"></span>' +
        '<input type="text" id="v2vKw" class="v2v-kw" placeholder="搜索名称 / 地址" value="' + escA(V2.kw || "") + '">' +
        '<button class="v2v-tab' + (V2.sortPing ? " on" : "") + '" data-act="sort-ping" title="按延迟从低到高排序">' +
        '<i class="bi bi-sort-down"></i>延迟</button>' +
        '<button class="v2v-tab' + (V2.hideFail ? " on" : "") + '" data-act="hide-fail" title="隐藏测速超时的节点">' +
        '<i class="bi bi-eye-slash"></i>隐藏超时</button>' +
        '<button class="v2v-btn" data-act="ping-all"' + (list.length && !V2.pingProg ? "" : " disabled") +
        '><i class="bi bi-lightning-charge"></i>' + (V2.pingProg ? "测速中…" : "全部测速") + "</button>" +
        '<button class="v2v-btn danger" data-act="del-timeout"' + (failN && !V2.pingProg ? "" : " disabled") +
        ' title="删除所有测速超时的节点"><i class="bi bi-trash"></i>删除超时' + (failN ? " " + failN : "") + "</button>" + tabHtml);
    if (!list.length) {
      h += '<div class="v2v-empty"><i class="bi bi-inbox"></i><b>' +
        (V2.nodes.length ? "没有匹配的节点" : "还没有节点") + "</b><span>" +
        (V2.nodes.length ? "换个关键词试试，或清空搜索框"
                         : "在上方粘贴分享链接，或到「订阅」里添加一个订阅地址") + "</span></div>";
    } else {
      h += '<div class="v2v-list">' + shown.map(n => {
        const p = V2.ping[n.id];
        let ping = "";
        if (p !== undefined) {
          ping = '<span class="v2v-ping ' + (p.ok ? "good" : "fail") + '"><i class="bi ' +
            (p.ok ? "bi-lightning-charge-fill" : "bi-x-circle") + '"></i>' +
            (p.ok ? (p.ms + " ms") : "超时") + "</span>";
        }
        const dl = V2.dl[n.id];
        const dlTag = (dl !== undefined)
          ? '<span class="v2v-ping good" title="下载测速"><i class="bi bi-cloud-download"></i>' + dl + " Mbps</span>"
          : "";
        return '<div class="v2v-item' + (n.id === cid ? " on" : "") + '">' +
          '<span class="v2v-ico ' + protoCls(n.proto) + '"><i class="bi ' + protoIcon(n.proto) + '"></i></span>' +
          '<div class="v2v-info"><div class="v2v-nm">' + esc(n.name || "(未命名)") +
            (n.id === cid ? '<span class="v2v-pill on"><i class="bi bi-broadcast"></i>已连接</span>' : "") + "</div>" +
          '<div class="v2v-meta"><span class="v2v-pill proto">' + esc(n.proto || "") + "</span>" +
            "<em>" + esc(n.server || "") + ":" + esc(n.port || "") + "</em>" +
            (n.remark ? "<span>" + esc(n.remark) + "</span>" : "") + ping + dlTag +
          "</div></div>" +
          '<div class="v2v-ops">' +
            (n.id === cid
              ? '<button class="v2v-btn danger" data-act="disconnect" data-id="' + escA(n.id) + '"><i class="bi bi-stop-fill"></i>断开</button>'
              : '<button class="v2v-btn primary" data-act="connect" data-id="' + escA(n.id) + '"><i class="bi bi-plug"></i>连接</button>') +
            '<button class="v2v-btn ico" data-act="dl-test" data-id="' + escA(n.id) + '" title="下载测速"><i class="bi bi-cloud-download"></i></button>' +
            '<button class="v2v-btn ico" data-act="copy-link" data-id="' + escA(n.id) + '" title="复制分享链接"><i class="bi bi-clipboard"></i></button>' +
            '<button class="v2v-btn ico" data-act="ping" data-id="' + escA(n.id) + '" title="测速"><i class="bi bi-lightning-charge"></i></button>' +
            '<button class="v2v-btn ico" data-act="preview" data-id="' + escA(n.id) + '" title="预览配置"><i class="bi bi-code-square"></i></button>' +
            '<button class="v2v-btn ico" data-act="rename" data-id="' + escA(n.id) + '" title="编辑节点信息"><i class="bi bi-pencil"></i></button>' +
            '<button class="v2v-btn ico danger" data-act="del-node" data-id="' + escA(n.id) + '" title="删除"><i class="bi bi-trash"></i></button>' +
          "</div></div>";
      }).join("") +
      (list.length > shown.length
        ? '<div class="v2v-more"><button class="v2v-btn" data-act="nodes-more">' +
          '<i class="bi bi-chevron-down"></i>加载更多（已显示 ' + shown.length + " / " + list.length + "）</button></div>"
        : "") + "</div>";
    }
    return h + "</div>";
  }

  function v2vSubs() {
    const e = V2.selSub || {};
    const editing = !!e.id;
    let h = '<div class="v2v-sec">' +
      v2vSecHead(editing ? "bi-pencil-square" : "bi-rss", editing ? "编辑订阅" : "新建订阅",
        editing ? "修改后保存会自动重新拉取节点" : "填入订阅地址，保存后自动拉取并导入节点") +
      '<div class="v2v-grid">' +
      '<label class="v2v-field v2v-field-wide"><span>订阅地址（http:// 或 https://）</span>' +
      '<input type="text" id="v2vSubUrl" value="' + escA(e.url || "") + '" placeholder="https://example.com/sub?token=..."></label>' +
      '<label class="v2v-field"><span>名称</span><input type="text" id="v2vSubName" value="' + escA(e.name || "") + '" placeholder="例如：机场 A"></label>' +
      '<label class="v2v-field"><span>拉取时走的代理（可选）</span>' +
      '<input type="text" id="v2vSubProxy" value="' + escA(e.proxy || "") + '" placeholder="socks5://127.0.0.1:10808"></label>' +
      '<label class="v2v-field"><span>状态</span><select id="v2vSubEnabled">' +
      '<option value="1"' + (e.enabled === 0 ? "" : " selected") + ">启用</option>" +
      '<option value="0"' + (e.enabled === 0 ? " selected" : "") + ">停用</option></select></label>" +
      "</div>" +
      '<div class="v2v-actions">' +
      '<button class="v2v-btn primary" data-act="save-sub"><i class="bi bi-check2"></i>' + (editing ? "保存修改" : "添加订阅") + "</button>" +
      (editing ? '<button class="v2v-btn" data-act="cancel-sub">取消编辑</button>' : "") +
      '<div class="v2v-flex"></div>' +
      '<button class="v2v-btn" data-act="refresh-all-subs"' + (V2.subAllBusy ? " disabled" : "") + '>' +
      '<i class="bi bi-cloud-download' + (V2.subAllBusy ? " spin" : "") + '"></i>' +
      (V2.subAllBusy ? "更新中…" : "刷新全部订阅") + "</button>" +
      "</div>" +
      '<div class="v2v-hint"><i class="bi bi-info-circle"></i><div>订阅内容里的分享链接会被解析成节点；刷新会<strong>覆盖该订阅下已有的节点</strong>，' +
      "手动添加的节点（不属于任何订阅）不受影响。</div></div></div>";

    h += '<div class="v2v-sec">' +
      v2vSecHead("bi-list-ul", "订阅列表", V2.subs.length ? ("共 " + V2.subs.length + " 个订阅") : "还没有订阅");
    if (!V2.subs.length) {
      h += '<div class="v2v-empty"><i class="bi bi-rss"></i><b>还没有订阅</b>' +
        "<span>在上方填入订阅地址，保存后会自动拉取节点</span></div>";
    } else {
      h += '<div class="v2v-list">' + V2.subs.map(s => {
        const cnt = V2.nodes.filter(n => n.sub_id === s.id).length;
        return '<div class="v2v-item"><span class="v2v-ico p-sub"><i class="bi bi-rss"></i></span>' +
          '<div class="v2v-info"><div class="v2v-nm">' + esc(s.name || "(未命名)") +
            '<span class="v2v-pill ' + (s.enabled ? "on" : "off") + '">' + (s.enabled ? "启用" : "停用") + "</span></div>" +
          '<div class="v2v-meta"><span class="v2v-long" title="' + escA(s.url) + '">' + esc(s.url) + "</span>" +
            "<em>" + cnt + " 个节点</em>" +
            (s.proxy ? "<span>代理 " + esc(s.proxy) + "</span>" : "") +
            (s.updated_at ? "<span>更新于 " + esc(fmtTime(s.updated_at)) + "</span>" : "") +
            (s.last_error ? '<span class="fail">' + esc(s.last_error) + "</span>" : "") +
          "</div></div>" +
          '<div class="v2v-ops">' +
            '<button class="v2v-btn" data-act="refresh-sub" data-id="' + escA(s.id) + '"' +
              (V2.subBusy[s.id] || V2.subAllBusy ? " disabled" : "") + '>' +
              '<i class="bi bi-arrow-repeat' + (V2.subBusy[s.id] ? " spin" : "") + '"></i>' +
              (V2.subBusy[s.id] ? "更新中…" : "刷新") + "</button>" +
            '<button class="v2v-btn ico" data-act="edit-sub" data-id="' + escA(s.id) + '" title="编辑"><i class="bi bi-pencil"></i></button>' +
            '<button class="v2v-btn ico danger" data-act="del-sub" data-id="' + escA(s.id) + '" title="删除"><i class="bi bi-trash"></i></button>' +
          "</div></div>";
      }).join("") + "</div>";
    }
    return h + "</div>";
  }

  function v2vSettings(st) {
    const s = st.settings || {};
    const cores = V2.cores || [];
    const busy = v2JobBusy();
    const core = st.core || {};
    const plat = (V2.coreInfo && V2.coreInfo.platform) || "linux/64";
    const lan = (s.socks_listen || "127.0.0.1") === "0.0.0.0";
    const authOn = lan || String(s.auth_enabled === undefined ? 1 : s.auth_enabled) !== "0";
    let h = v2vBanner();
    h += '<div class="v2v-sec">' +
      v2vSecHead("bi-cpu", "内核", "自动探测本机的 xray / v2ray，找不到可一键下载官方版本") +
      '<div class="v2v-grid">' +
      '<label class="v2v-field v2v-field-wide"><span>内核可执行文件路径（留空 = 自动探测）</span>' +
      '<input type="text" id="v2vSetCore" value="' + escA(s.core_path || "") + '" placeholder="' +
      escA(core.path || "/path/to/xray") + '"></label>' +
      '<label class="v2v-field v2v-field-wide"><span>下载源（留空 = 官方 GitHub Release；可填镜像前缀或完整 zip 地址）</span>' +
      '<input type="text" id="v2vSetCoreUrl" value="' + escA(s.core_url || "") + '" placeholder="' +
      escA("https://github.com/XTLS/Xray-core/releases/latest/download/Xray-" +
           plat.replace("/", "-") + ".zip") + '"></label>' +
      "</div>";
    h += '<div class="v2v-actions">' +
      '<button class="v2v-btn primary" data-act="download-core"' + (busy ? " disabled" : "") +
      '><i class="bi bi-cloud-arrow-down"></i>一键下载 Xray-core</button>' +
      '<button class="v2v-btn" data-act="detect-core"' + (busy ? " disabled" : "") +
      '><i class="bi bi-search"></i>重新探测</button>' +
      '<span class="v2v-plat"><i class="bi bi-pc-display"></i>当前平台 · ' + esc(plat) + "</span>" +
      "</div>" + v2ProgHtml();
    if (cores.length) {
      h += '<div class="v2v-cores">' + cores.map(c =>
        '<div class="v2v-core' + (c.ok ? " ok" : "") + '">' +
        '<span class="v2v-core-nm"><i class="bi bi-terminal"></i>' + esc(c.name) + "</span>" +
        '<span class="v2v-core-v">' + esc(c.version || "不可用") + "</span>" +
        '<span class="v2v-core-p" title="' + escA(c.path) + '">' + esc(c.path) + "</span>" +
        "</div>").join("") + "</div>";
    } else {
      h += '<div class="v2v-hint warn"><i class="bi bi-exclamation-triangle"></i><div>' +
        "系统里没有探测到 xray / v2ray，请点上面的「一键下载 Xray-core」（会装到 data/v2ray/core）。</div></div>";
    }
    h += "</div>";

    h += '<div class="v2v-sec">' +
      v2vSecHead("bi-hdd-network", "代理出口", "端口 / 监听地址的改动会在下次「连接」时生效") +
      '<div class="v2v-subhead"><span>端口与监听</span></div>' +
      '<div class="v2v-grid">' +
      '<label class="v2v-field"><span>SOCKS5 端口</span><input type="number" id="v2vSetPort" value="' + escA(s.socks_port || 10808) + '"></label>' +
      '<label class="v2v-field"><span>监听地址</span><select id="v2vSetListen">' +
        '<option value="0.0.0.0"' + (s.socks_listen === "127.0.0.1" ? "" : " selected") + ">0.0.0.0（供局域网使用）</option>" +
        '<option value="127.0.0.1"' + (s.socks_listen === "127.0.0.1" ? " selected" : "") + ">127.0.0.1（仅本机）</option>" +
      "</select></label>" +
      '<label class="v2v-field"><span>HTTP 代理端口（0 = 不开启）</span>' +
      '<input type="number" id="v2vSetHttp" value="' + escA(s.http_port || 0) + '"></label>' +
      '<label class="v2v-field"><span>统计 API 端口（0 = 关闭实时网速）</span>' +
      '<input type="number" id="v2vSetApi" value="' + escA(s.api_port || 0) + '"></label>' +
      '<label class="v2v-field"><span>内核日志级别</span><select id="v2vSetLog">' +
        ["debug", "info", "warning", "error", "none"].map(l =>
          '<option value="' + l + '"' + (s.log_level === l ? " selected" : "") + ">" + l + "</option>").join("") +
      "</select></label>" +
      "</div>" +
      '<div class="v2v-subhead"><span>访问认证</span>' +
      '<em class="v2v-sub-note" id="v2vAuthNote">' +
      (lan ? "0.0.0.0 模式强制启用认证：账号 / 密码留空将在连接时自动生成并保存"
           : (authOn ? "" : "认证已停用：本机连接无需账号密码（凭据仍保留，随时可重新启用）")) +
      "</em></div>" +
      '<form class="v2v-grid" autocomplete="new-password" onsubmit="return false">' +
      '<label class="v2v-field"><span>SOCKS5 认证' + (lan ? "（0.0.0.0 强制启用）" : "") + "</span>" +
      '<select id="v2vSetAuth"' + (lan ? " disabled" : "") + ">" +
      '<option value="1"' + (authOn ? " selected" : "") + ">启用（连接需要账号密码）</option>" +
      '<option value="0"' + (!authOn && !lan ? " selected" : "") + ">停用（免认证直连）</option>" +
      "</select></label>" +
      '<label class="v2v-field"><span>SOCKS5 用户名（可选）</span>' +
      '<input type="text" id="v2vSetUser" value="' + escA(s.socks_user || "") + '" autocomplete="off"></label>' +
      '<label class="v2v-field"><span>SOCKS5 密码' + (st.has_pass ? "（已设置，留空不修改）" : "（可选）") + "</span>" +
      '<div class="v2v-pass-row">' +
      '<input type="password" id="v2vSetPass" value="" placeholder="' + (st.has_pass ? "••••••（留空保持不变）" : "") +
      '" autocomplete="new-password">' +
      '<button type="button" class="v2v-btn ico" id="v2vPassEye" title="显示 / 隐藏密码"><i class="bi bi-eye"></i></button>' +
      '<button type="button" class="v2v-btn ico" id="v2vPassCopy" title="复制密码"><i class="bi bi-clipboard"></i></button>' +
      "</div></label>" +
      "</form>" +
      '<div class="v2v-subhead"><span>其它</span></div>' +
      '<div class="v2v-grid">' +
      '<label class="v2v-field"><span>订阅拉取代理（可选，默认直连）</span>' +
      '<input type="text" id="v2vSetSubProxy" value="' + escA(s.sub_proxy || "") + '" placeholder="socks5://127.0.0.1:10808"></label>' +
      '<label class="v2v-field"><span>服务启动时自动连接上次的节点</span><select id="v2vSetAuto">' +
        '<option value="1"' + (Number(s.auto_start) ? " selected" : "") + ">开启</option>" +
        '<option value="0"' + (Number(s.auto_start) ? "" : " selected") + ">关闭</option></select></label>" +
      "</div>" +
      '<div class="v2v-actions">' +
      '<button class="v2v-btn primary" data-act="save-settings"><i class="bi bi-check2"></i>保存设置</button>' +
      (st.has_pass ? '<button class="v2v-btn danger" data-act="clear-pass"><i class="bi bi-key"></i>清空密码</button>' : "") +
      "</div>" +
      '<div class="v2v-hint"><i class="bi bi-info-circle"></i><div>监听 <strong>0.0.0.0</strong> 时，同网段的设备（如手机）都能通过「本机IP:端口」使用本代理；' +
      "改成 <strong>127.0.0.1</strong> 则只有本机能用。HTTP 代理端口给手机 / 只支持 HTTP 代理的应用使用，与 SOCKS5 共用账号密码。</div></div></div>";
    return h;
  }

  function v2vLog() {
    return '<div class="v2v-sec">' +
      v2vSecHead("bi-journal-text", "内核运行日志", "来自内核进程输出（data/v2ray/xray.log）",
        '<span class="v2v-flex"></span>' +
        '<span class="v2v-live' + (V2.autoLog ? " on" : "") + '"><i></i>' +
        (V2.autoLog ? "实时刷新中" : "已暂停") + "</span>" +
        '<button class="v2v-btn" data-act="log-toggle"><i class="bi ' + (V2.autoLog ? "bi-pause" : "bi-play") + '"></i>' +
        (V2.autoLog ? "暂停刷新" : "自动刷新") + "</button>" +
        '<button class="v2v-btn ico" data-act="log-refresh" title="刷新日志"><i class="bi bi-arrow-clockwise"></i></button>' +
        '<button class="v2v-btn ico danger" data-act="log-clear" title="清空日志"><i class="bi bi-eraser"></i></button>') +
      '<pre class="v2v-log" id="v2vLog">' + esc(V2.log || "（暂无日志）") + "</pre>" +
      '<div class="v2v-hint"><i class="bi bi-info-circle"></i><div>连接失败时先看这里的报错，' +
      "常见原因是节点参数不对（uuid / 密码 / sni）或服务器不可达。</div></div></div>";
  }

  /* ---------- 日志轮询 ---------- */
  function v2LogStop() { clearTimeout(V2.logTimer); V2.logTimer = null; }
  async function v2LogFetch() {
    const r = await api("/api/v2ray/log?lines=400");
    V2.log = r.log || "";
    const el = $("v2vLog");
    if (el) { el.textContent = V2.log || "（暂无日志）"; el.scrollTop = el.scrollHeight; }
  }
  function v2LogStart() {
    v2LogStop();
    const tick = async () => {
      if (!V2.autoLog || !v2vActive() || V2.sec !== "log") { V2.logTimer = null; return; }
      await v2LogFetch().catch(() => {});
      V2.logTimer = setTimeout(tick, 2000);
    };
    tick();
  }

  /* ---------- 事件（委托：绑在 #v2View 上，随标签页创建时绑定一次） ---------- */
  function v2vBind(box) {
    if (!box || box.dataset.v2bound) return;
    box.dataset.v2bound = "1";
    box.addEventListener("click", (e) => {
      const tb = e.target.closest(".v2v-tab[data-sec]");
      if (tb) {
        V2.sec = tb.dataset.sec;
        v2SaveView();
        if (V2.sec === "log") { v2LogFetch().catch(() => {}); if (V2.autoLog) v2LogStart(); } else v2LogStop();
        if (V2.sec === "overview") v2TrafStart(); else v2TrafStop();
        v2vRender();
        return;
      }
      // 密码显示 / 复制：输入框有值直接用，没值（只存过密文）就从后端解密取回
      const eye = e.target.closest("#v2vPassEye");
      if (eye) {
        const p = $("v2vSetPass"); if (!p) return;
        (async () => {
          if (!p.value) {
            const r = await post("/api/v2ray/get-pass");
            if (r.error || !r.socks_pass) return toast(r.error || "尚未设置密码", "err");
            p.value = r.socks_pass;
          }
          p.type = p.type === "password" ? "text" : "password";
          const ic = eye.querySelector("i");
          if (ic) ic.className = "bi " + (p.type === "password" ? "bi-eye" : "bi-eye-slash");
        })();
        return;
      }
      const cpy = e.target.closest("#v2vPassCopy");
      if (cpy) {
        const p = $("v2vSetPass"); if (!p) return;
        (async () => {
          if (!p.value) {
            const r = await post("/api/v2ray/get-pass");
            if (r.error || !r.socks_pass) return toast(r.error || "尚未设置密码", "err");
            p.value = r.socks_pass;
          }
          await copyText(p.value);
          toast("密码已复制到剪贴板", "ok");
        })();
        return;
      }
      const btn = e.target.closest("[data-act]");
      if (btn) v2vAction(btn.dataset.act, btn.dataset);
    });
    // 监听地址 / 认证开关联动：不用等保存，下拉切到哪边认证选项即时跟着变
    const authNoteSync = () => {
      const sel = $("v2vSetListen"), note = $("v2vAuthNote"), auth = $("v2vSetAuth");
      if (!sel || !note) return;
      const isLan = sel.value === "0.0.0.0";
      if (auth) {
        auth.disabled = isLan;
        if (isLan) auth.value = "1";          // 0.0.0.0 强制启用
      }
      note.textContent = isLan
        ? "0.0.0.0 模式强制启用认证：账号 / 密码留空将在连接时自动生成并保存"
        : (auth && auth.value === "0" ? "认证已停用：本机连接无需账号密码（凭据仍保留，随时可重新启用）" : "");
    };
    box.addEventListener("change", (e) => {
      if (e.target.id === "v2vSetAuth") { authNoteSync(); return; }
      if (e.target.id !== "v2vSetListen") return;
      authNoteSync();
      if (e.target.value !== "0.0.0.0") return;
      // 切到 0.0.0.0（局域网）时：账号密码为空就立即生成并回填，用户看得见
      const u = $("v2vSetUser"), p = $("v2vSetPass");
      if ((u && u.value.trim()) || (p && p.value)) return;
      (async () => {
        const r = await post("/api/v2ray/gen-auth");
        if (r.error) return toast(r.error, "err");
        if (u) u.value = r.socks_user || "";
        if (p) p.value = r.socks_pass || "";
        toast("已自动生成 SOCKS5 账号密码，请点「保存设置」", "ok");
      })();
    });
    box.addEventListener("input", (e) => {
      if (e.target.id !== "v2vKw") return;
      V2.kw = e.target.value;
      // 输入即过滤：重渲染后把焦点与光标位置还原，避免搜索框被打断
      clearTimeout(V2.kwTimer);
      V2.kwTimer = setTimeout(() => {
        const pos = e.target.selectionStart;
        V2.nodeShow = 60;   // 搜索词变了，重置回首屏批量
        v2SaveNodesView();
        v2vRender();
        const el = $("v2vKw");
        if (el) { el.focus(); try { el.setSelectionRange(pos, pos); } catch (_) { /* 忽略 */ } }
      }, 220);
    });
  }

  /* ---------- 节点编辑悬浮框：按协议给出对应字段，保存后下次连接生效 ---------- */
  function v2NodeEditModal(n) {
    return new Promise((resolve) => {
      const isSS = n.proto === "ss";
      const fd = (id, label, val, ph, type) =>
        '<label class="v2v-field"><span>' + label + '</span><input type="' + (type || "text") +
        '" id="' + id + '" value="' + escA(val == null ? "" : val) + '"' +
        (ph ? ' placeholder="' + escA(ph) + '"' : "") + "></label>";
      const sel = (id, label, cur, opts) =>
        '<label class="v2v-field"><span>' + label + "</span><select id=\"" + id + "\">" +
        opts.map(o => '<option value="' + o + '"' + (o === cur ? " selected" : "") + ">" + o + "</option>").join("") +
        "</select></label>";

      let h = '<div class="v2v-grid">' +
        fd("v2vENName", "节点名称", n.name) + fd("v2vENRemark", "备注", n.remark, "可留空") +
        fd("v2vENGrp", "自定义分组（节点列表 tab）", n.grp, "如：机场A / 日常；留空 = 不分组") +
        fd("v2vENServer", "服务器地址", n.server) + fd("v2vENPort", "端口", n.port, "", "number");
      if (n.proto === "vmess" || n.proto === "vless") {
        h += fd("v2vENUuid", "UUID", n.uuid);
        if (n.proto === "vmess") h += fd("v2vENAid", "alterId", n.aid == null ? 0 : n.aid, "", "number");
        else h += fd("v2vENFlow", "flow", n.flow, "可留空，如 xtls-rprx-vision");
      } else if (isSS) {
        h += fd("v2vENMethod", "加密方式", n.method, "aes-256-gcm") + fd("v2vENPass", "密码", n.password);
      } else if (n.proto === "trojan") {
        h += fd("v2vENPass", "密码", n.password);
      }
      if (!isSS) {
        h += sel("v2vENNet", "传输方式", n.net || "tcp", ["tcp", "ws", "grpc", "h2"]) +
          sel("v2vENTls", "TLS", n.tls || "none", ["none", "tls", "reality"]) +
          fd("v2vENHost", "Host 头", n.host, "可留空") +
          fd("v2vENPath", "路径 / serviceName", n.path, "可留空") +
          fd("v2vENSni", "SNI", n.sni, "可留空") +
          '<div id="v2vENReality" style="display:' + (n.tls === "reality" ? "contents" : "none") + '">' +
          fd("v2vENPbk", "Reality publicKey", n.pbk) + fd("v2vENSid", "Reality shortId", n.sid) + "</div>";
      }
      h += "</div>";

      const ov = document.createElement("div");
      ov.className = "v2v-modal-ov";
      ov.innerHTML =
        '<div class="v2v-modal">' +
          '<div class="v2v-modal-t"><i class="bi bi-pencil-square"></i>编辑节点 · ' + esc(n.proto || "") +
            '<button class="v2v-modal-x" id="v2vENX" title="关闭"><i class="bi bi-x-lg"></i></button></div>' +
          '<div class="v2v-modal-b">' + h +
            '<div class="v2v-hint"><i class="bi bi-info-circle"></i><div>修改直接写入节点参数，下次连接生效；' +
            "若节点来自订阅，刷新订阅时会被覆盖。</div></div>" +
          "</div>" +
          '<div class="v2v-modal-f"><button class="v2v-btn" id="v2vENCancel">取消</button>' +
            '<button class="v2v-btn primary" id="v2vENOk"><i class="bi bi-check2"></i>保存</button></div>' +
        "</div>";
      // 挂到 .v2-view 里，输入框才能吃到模块的表单主题样式（fixed 定位不受影响）
      ($("v2View") || document.body).appendChild(ov);

      const tlsSel = ov.querySelector("#v2vENTls");
      if (tlsSel) tlsSel.onchange = () => {
        const box = ov.querySelector("#v2vENReality");
        if (box) box.style.display = tlsSel.value === "reality" ? "contents" : "none";
      };

      const g = id => { const el = ov.querySelector("#" + id); return el ? el.value.trim() : ""; };
      const done = (ok) => {
        let data = null;
        if (ok) {
          data = { id: n.id, name: g("v2vENName"), remark: g("v2vENRemark"), grp: g("v2vENGrp"),
                   server: g("v2vENServer"), port: g("v2vENPort"), fields: {} };
          if (n.proto === "vmess") { data.fields.uuid = g("v2vENUuid"); data.fields.aid = g("v2vENAid"); }
          else if (n.proto === "vless") { data.fields.uuid = g("v2vENUuid"); data.fields.flow = g("v2vENFlow"); }
          else if (isSS) { data.fields.method = g("v2vENMethod"); data.fields.password = g("v2vENPass"); }
          else if (n.proto === "trojan") { data.fields.password = g("v2vENPass"); }
          if (!isSS) {
            data.fields.net = g("v2vENNet");
            data.fields.tls = g("v2vENTls");
            data.fields.host = g("v2vENHost");
            data.fields.path = g("v2vENPath");
            data.fields.sni = g("v2vENSni");
            if (data.fields.tls === "reality") {
              data.fields.pbk = g("v2vENPbk");
              data.fields.sid = g("v2vENSid");
            }
          }
        }
        ov.remove();
        resolve(data);
      };
      ov.querySelector("#v2vENOk").onclick = () => done(true);
      ov.querySelector("#v2vENCancel").onclick = () => done(false);
      ov.querySelector("#v2vENX").onclick = () => done(false);
      ov.addEventListener("mousedown", (e) => { if (e.target === ov) done(false); });
      ov.addEventListener("keydown", (e) => { if (e.key === "Escape") done(false); });
      const first = ov.querySelector("#v2vENName");
      if (first) first.focus();
    });
  }

  async function v2vAction(act, ds) {
    switch (act) {
      case "refresh": await v2Reload(); toast("已刷新", "ok"); break;
      case "toggle": await v2ToggleConnect(); break;
      case "node-tab": {
        V2.nodeTab = ds.tab || "__all__";
        V2.nodeShow = 60;   // 过滤条件变了，重置回首屏批量
        v2SaveNodesView();
        if (v2vActive()) v2vRender();
        break;
      }
      case "sort-ping": {
        V2.sortPing = !V2.sortPing;
        V2.nodeShow = 60;
        v2SaveNodesView();
        if (v2vActive()) v2vRender();
        break;
      }
      case "hide-fail": {
        V2.hideFail = !V2.hideFail;
        V2.nodeShow = 60;
        v2SaveNodesView();
        if (v2vActive()) v2vRender();
        break;
      }
      case "nodes-more": {
        // 追加一批节点：重渲染后把滚动位置还原，避免视口跳回顶部
        V2.nodeShow = (V2.nodeShow || 60) + 150;
        const vbox = $("v2View");
        const sc = (function findScroll(el) {
          while (el && el.parentElement) {
            el = el.parentElement;
            if (el.scrollHeight > el.clientHeight + 1) return el;
          }
          return null;
        })(vbox);
        const stTop = sc ? sc.scrollTop : 0;
        if (v2vActive()) v2vRender();
        if (sc) sc.scrollTop = stTop;
        break;
      }
      case "restart": {
        const r = await post("/api/v2ray/restart");
        if (r.error) toast(r.error, "err"); else { toast("已重启", "ok"); await v2Reload(); }
        break;
      }
      case "exit-test": {
        toast("正在测试出口…", "info");
        const r = await post("/api/v2ray/exit-test");
        V2.exit = r;
        if (v2vActive()) v2vRender();
        toast(r.ok ? "出口 IP：" + r.ip : (r.error || "测试失败"), r.ok ? "ok" : "err");
        break;
      }
      case "copy": copyText(ds.v); break;

      /* -------- 流量统计 -------- */
      case "traffic-refresh": await v2TrafficFetch(); toast("流量数据已刷新", "ok"); break;
      case "traffic-reset": {
        const ok = await uiConfirm("流量清零", "确定清空全部节点的流量统计？该操作不可恢复。", "清零", true);
        if (!ok) return;
        const r = await post("/api/v2ray/traffic/reset");
        if (r.error) return toast(r.error, "err");
        V2.traffic = r.traffic || null;
        if (v2vActive()) v2vRender();
        toast("流量统计已清零", "ok");
        break;
      }

      /* -------- 节点 -------- */
      case "add-links": {
        const ta = $("v2vLinks");
        const links = (ta && ta.value || "").trim();
        if (!links) return toast("请先粘贴分享链接", "warn");
        const r = await post("/api/v2ray/nodes/add", { links: links });
        if (r.error) return toast(r.error, "err");
        toast("已添加 " + r.added + " 个节点" + (r.errors && r.errors.length ? "（" + r.errors.length + " 条被跳过）" : ""), "ok");
        await v2Reload();
        break;
      }
      case "toggle-manual": V2.showManual = !V2.showManual; v2vRender(); break;
      case "add-manual": {
        const node = {
          proto: val("v2vMProto"), name: val("v2vMName"), server: val("v2vMServer"), port: val("v2vMPort"),
          uuid: val("v2vMUuid"), password: val("v2vMUuid"), method: val("v2vMMethod"),
          net: val("v2vMNet"), tls: val("v2vMTls"), host: val("v2vMHost"), path: val("v2vMPath"),
          sni: val("v2vMSni"), aid: val("v2vMAid"),
        };
        const r = await post("/api/v2ray/nodes/add", { node: node });
        if (r.error) return toast(r.error, "err");
        toast("已添加 " + r.added + " 个节点", "ok");
        V2.showManual = false;
        await v2Reload();
        break;
      }
      case "connect": {
        toast("正在连接…", "info");
        const r = await post("/api/v2ray/connect", { id: ds.id });
        if (r.error) return toast(r.error, "err");
        toast("已连接", "ok");
        V2.pick = ds.id;
        await v2Reload();
        break;
      }
      case "disconnect": {
        const ok = await uiConfirm("断开连接", "停止内核后，正在使用 10808 代理的用户会立即断网。", "断开", true);
        if (!ok) break;
        toast("正在断开…", "info");
        const r = await post("/api/v2ray/disconnect");
        if (r.error) return toast(r.error, "err");
        toast("已断开", "ok");
        await v2Reload();
        break;
      }
      case "dl-test": {
        toast("下载测速中…（未连接时会临时切换节点，可能要半分钟）", "info");
        const r = await post("/api/v2ray/dl-test", { id: ds.id });
        if (r.error) return toast(r.error, "err");
        V2.dl[ds.id] = r.mbps;
        if (v2vActive()) v2vRender();
        toast("下载速度：" + r.mbps + " Mbps", "ok");
        break;
      }
      case "copy-link": {
        const r = await post("/api/v2ray/share-link", { id: ds.id });
        if (r.error) return toast(r.error, "err");
        await copyText(r.link);
        toast("已复制分享链接", "ok");
        break;
      }
      case "ping": {
        toast("测速中…", "info");
        V2.ping[ds.id] = await post("/api/v2ray/ping", { id: ds.id });
        if (v2vActive()) v2vRender();
        v2SideRender();
        break;
      }
      case "ping-all": {
        if (V2.pingProg) break;                 // 已在进行中，防止重复触发
        const ids = V2.nodes.map(n => n.id);
        if (!ids.length) { toast("还没有节点", "warn"); break; }
        V2.pingProg = { done: 0, total: ids.length };
        if (v2vActive()) v2vRender();
        // 分批走后端并发测速（每批 100、后端内部 40 线程），每批只重绘一次，
        // 避免大列表上千次 HTTP 请求 + 频繁全量重绘导致卡顿
        const CHUNK = 100;
        for (let i = 0; i < ids.length; i += CHUNK) {
          const batch = ids.slice(i, i + CHUNK);
          const r = await post("/api/v2ray/ping-batch", { ids: batch }).catch(() => null);
          const res = (r && r.results) || {};
          for (const k of Object.keys(res)) V2.ping[k] = res[k];
          if (V2.pingProg) V2.pingProg.done += batch.length;
          if (v2vActive()) v2vRender();
          v2SideRender();
        }
        V2.pingProg = null;
        if (v2vActive()) v2vRender();
        v2SideRender();
        toast("测速完成", "ok");
        break;
      }
      case "preview": {
        const r = await post("/api/v2ray/preview", { id: ds.id });
        if (r.error) return toast(r.error, "err");
        uiModal({ title: "运行配置预览", icon: "bi-code-square", hideCancel: true, okText: "关闭",
                  html: '<pre class="v2v-log" style="max-height:56vh">' + esc(r.json) + "</pre>" });
        break;
      }
      case "rename": {
        const n = nodeOf(ds.id); if (!n) return;
        const f = await v2NodeEditModal(n);
        if (!f) return;
        const r = await post("/api/v2ray/nodes/update", f);
        if (r.error) return toast(r.error, "err");
        toast("节点已保存，下次连接生效", "ok");
        await v2Reload();
        break;
      }
      case "del-node": {
        const n = nodeOf(ds.id);
        const ok = await uiConfirm("删除节点", "确定删除「" + ((n && n.name) || ds.id) + "」？", "删除", true);
        if (!ok) return;
        const r = await post("/api/v2ray/nodes/delete", { ids: [ds.id] });
        if (r.error) return toast(r.error, "err");
        toast("已删除", "ok");
        await v2Reload();
        break;
      }
      case "del-timeout": {
        // 批量删除测速超时的节点（排除当前已连接的节点，避免误删导致断网）
        const ids = V2.nodes
          .filter(n => n.id !== curNodeId() && V2.ping[n.id] && !V2.ping[n.id].ok)
          .map(n => n.id);
        if (!ids.length) { toast("没有测速超时的节点", "warn"); break; }
        const ok = await uiConfirm("删除超时节点",
          "确定删除 " + ids.length + " 个测速超时的节点？该操作不可恢复。", "删除", true);
        if (!ok) break;
        const r = await post("/api/v2ray/nodes/delete", { ids: ids });
        if (r.error) return toast(r.error, "err");
        toast("已删除 " + ids.length + " 个超时节点", "ok");
        await v2Reload();
        break;
      }

      /* -------- 订阅 -------- */
      case "save-sub": {
        const body = { name: val("v2vSubName"), url: val("v2vSubUrl"), proxy: val("v2vSubProxy"),
                       enabled: val("v2vSubEnabled") !== "0" };
        if (V2.selSub && V2.selSub.id) body.id = V2.selSub.id;
        const r = await post("/api/v2ray/subs/save", body);
        if (r.error) return toast(r.error, "err");
        V2.selSub = null;
        toast("订阅已保存，正在拉取节点…", "info");
        await v2Reload();
        if (r.sub && r.sub.id) {
          const rr = await post("/api/v2ray/subs/refresh", { id: r.sub.id });
          const one = (rr.results || [])[0] || {};
          toast(one.error ? one.error : ("已导入 " + (one.count || 0) + " 个节点"), one.error ? "err" : "ok");
          await v2Reload();
        }
        break;
      }
      case "cancel-sub": V2.selSub = null; v2vRender(); break;
      case "edit-sub": V2.selSub = V2.subs.find(s => s.id === ds.id) || null; v2vRender(); break;
      case "refresh-sub": {
        // 更新中不允许重复点击
        if (V2.subBusy[ds.id] || V2.subAllBusy) break;
        V2.subBusy[ds.id] = true;
        if (v2vActive()) v2vRender();
        toast("正在拉取订阅…", "info");
        try {
          const r = await post("/api/v2ray/subs/refresh", { id: ds.id });
          const one = (r.results || [])[0] || {};
          toast(one.error ? one.error : ("已更新 " + (one.count || 0) + " 个节点"), one.error ? "err" : "ok");
          await v2Reload();
        } finally {
          delete V2.subBusy[ds.id];
          if (v2vActive()) v2vRender();
          v2SideRender();
        }
        break;
      }
      case "refresh-all-subs": {
        if (V2.subAllBusy) break;
        V2.subAllBusy = true;
        if (v2vActive()) v2vRender();
        toast("正在拉取全部订阅…", "info");
        try {
          const r = await post("/api/v2ray/subs/refresh", {});
          if (r.error) { toast(r.error, "err"); break; }
          const bad = (r.results || []).filter(x => x.error).length;
          toast("共导入 " + (r.total || 0) + " 个节点" + (bad ? "，" + bad + " 个订阅失败" : ""), bad ? "warn" : "ok");
          await v2Reload();
        } finally {
          V2.subAllBusy = false;
          if (v2vActive()) v2vRender();
        }
        break;
      }
      case "del-sub": {
        const s = V2.subs.find(x => x.id === ds.id);
        const ok = await uiConfirm("删除订阅", "确定删除「" + ((s && s.name) || ds.id) + "」？其下所有节点也会被删除。", "删除", true);
        if (!ok) return;
        const r = await post("/api/v2ray/subs/delete", { id: ds.id, confirm: 1 });
        if (r.error) return toast(r.error, "err");
        if (V2.selSub && V2.selSub.id === ds.id) V2.selSub = null;
        toast("已删除", "ok");
        await v2Reload();
        break;
      }

      /* -------- 设置 / 内核 -------- */
      case "detect-core": v2JobRun("detect", "/api/v2ray/core/detect"); break;
      case "download-core": {
        V2.pendingUrl = val("v2vSetCoreUrl");
        v2JobRun("download", "/api/v2ray/core/download", { url: V2.pendingUrl });
        break;
      }
      case "save-settings": {
        const body = {
          core_path: val("v2vSetCore"), core_url: val("v2vSetCoreUrl"),
          socks_port: val("v2vSetPort"), socks_listen: val("v2vSetListen"),
          http_port: val("v2vSetHttp"), api_port: val("v2vSetApi"), log_level: val("v2vSetLog"),
          socks_user: val("v2vSetUser"), sub_proxy: val("v2vSetSubProxy"),
          auto_start: val("v2vSetAuto") === "1" ? 1 : 0,
          auth_enabled: val("v2vSetAuth") === "0" ? 0 : 1,
        };
        const pw = val("v2vSetPass");
        if (pw) body.socks_pass = (window.TP && window.TP.encrypt) ? window.TP.encrypt(pw) : pw;
        const r = await post("/api/v2ray/settings", body);
        if (r.error) return toast(r.error, "err");
        await v2Reload();
        // 保存成功：弹出设置信息悬浮框，「重启内核」与页头「重启」是同一动作
        const s2 = (V2.st && V2.st.settings) || {};
        const rows = [
          ["SOCKS5 端口", s2.socks_port], ["监听地址", s2.socks_listen],
          ["HTTP 代理端口", s2.http_port ? s2.http_port : "未开启"],
          ["认证", String(s2.auth_enabled === undefined ? 1 : s2.auth_enabled) === "0" ? "停用" : "启用"],
          ["SOCKS5 用户名", s2.socks_user || "—"], ["日志级别", s2.log_level],
        ];
        const ok = await uiModal({
          title: "设置已保存", icon: "bi-check2-circle",
          html: '<div class="m-msg v2-save-info">' + rows.map(x =>
            "<div><span>" + esc(x[0]) + "</span><b>" + esc(String(x[1] === undefined ? "" : x[1])) + "</b></div>").join("") +
            '<div class="v2-save-tip">端口 / 监听 / 认证等改动重启内核后生效（沿用当前节点）</div></div>',
          okText: "重启内核", cancelText: "稍后",
        });
        if (ok) return v2vAction("restart", {});
        break;
      }
      case "clear-pass": {
        const ok = await uiConfirm("清空密码", "清空后代理将不再需要认证（任何能访问该端口的人都能使用）。", "清空", true);
        if (!ok) return;
        const r = await post("/api/v2ray/settings", { clear_pass: 1 });
        if (r.error) return toast(r.error, "err");
        toast("已清空密码", "ok");
        await v2Reload();
        break;
      }

      /* -------- 日志 -------- */
      case "log-toggle": V2.autoLog = !V2.autoLog; v2vRender(); if (V2.autoLog) v2LogStart(); else v2LogStop(); break;
      case "log-refresh": await v2LogFetch(); break;
      case "log-clear": {
        const ok = await uiConfirm("清空日志", "确定清空内核运行日志？", "清空", true);
        if (!ok) return;
        await post("/api/v2ray/log/clear");
        V2.log = "";
        await v2LogFetch();
        break;
      }
      default: break;
    }
  }

  // 供其他模块（如设置页的模块入口）直接打开管理页
  window.v2rayOpenView = v2OpenView;
})();

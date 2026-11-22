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
               pick: "", selSub: null, logTimer: null, autoLog: true, log: "", logTab: "core",
               trafTimer: null, traffic: null, usage: [],
               busy: false, connPhase: "", showManual: false, nodeForm: false, exit: null, ping: {}, dl: {}, kw: "",
               nodeTab: "__all__", sortPing: false, hideFail: false,
               subBusy: {}, subAllBusy: false, subForm: false,
               job: null, es: null, pendingUrl: "", versKind: "xray", coreKind: "",
              pathDraft: {}, instVer: "", progTimer: null, shareOpen: false,
              server: null, serverQr: false, serverLog: "",
              serverNodes: [], srvCur: "", serverLanIp: "", serverCoreReady: false,
              sharedCore: true, srvTraffic: null, srvTrafTimer: null };

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
    const [st, nd, sb, co, fl] = await Promise.all([
      api("/api/v2ray/status"), api("/api/v2ray/nodes"), api("/api/v2ray/subs"),
      api("/api/v2ray/core"), api("/api/v2ray/float/status"),
    ]);
    if (!st.error) V2.st = st;
    if (fl && !fl.error) V2.floatOn = !!fl.running;
    if (!nd.error) {
      V2.nodes = nd.nodes || [];
      V2.groups = nd.groups || [];                // 手动新建的自定义分组（可能还是空的）
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
  /* ---------- 回收站（软删除的节点） ---------- */
  function v2TrashFetch() {
    return post("/api/v2ray/nodes/trash", {}).then(r => {
      V2.trash = (r && r.items) || [];
      V2.trashN = V2.trash.length;
      if (v2vActive() && V2.sec === "nodes" && V2.trashOpen) v2vRender();
    });
  }

  async function v2Reload() {
    await v2FetchAll();
    v2TrashFetch().catch(() => {});     // 回收站数量角标（不阻塞主流程）
    v2SideRender();
    // 标签存在就渲染（包括后台标签）：会话恢复时可能先开标签又被别的标签抢走焦点，
    // 若只在「激活中」才渲染，竞态会让大页内容永远空白
    if (findTab(VIEW_PATH)) v2vRender();
  }

  /* 侧栏按钮与大页按钮共用同一份连接状态：连接 / 断开期间两处同步显示
     「启动中… / 停止中…」并禁用，避免一处已在操作、另一处还点得动。 */
  function v2ConnPaint() {
    v2SideRender();
    if (findTab(VIEW_PATH)) v2vRender();
  }

  /* 只重画侧栏「今日流量」：定时刷新时不整块重绘节点列表，避免滚动位置被重置 */
  function v2TodayPaint(st) {
    const td = $("v2Today"); if (!td) return;
    const t = (st && st.today) || {};
    const up = Number(t.up) || 0, down = Number(t.down) || 0;
    td.innerHTML = '<span class="v2-today-k"><i class="bi bi-calendar2-range"></i>今日流量</span>' +
      '<span class="v2-today-v">↑ ' + esc(fmtBytes(up)) + " · ↓ " + esc(fmtBytes(down)) + "</span>";
    td.title = "今日（" + (t.day || "本地日期") + "）累计：上行 " + fmtBytes(up) +
      " / 下行 " + fmtBytes(down);
  }

  /* 切换 / 连接节点后：服务端会异步实测一次真延迟并写入测速台账（几秒），
     本地缓存的旧延迟要先清掉，补拉时才会采纳服务端新值，界面即时更新 */
  function v2PingRefresh(id) {
    if (!id) return;
    delete V2.ping[id];
    setTimeout(async () => {
      try {
        delete V2.ping[id];
        await v2FetchAll();
        v2SideRender();
        if (findTab(VIEW_PATH)) v2vRender();
      } catch (_) {}
    }, 4500);
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
    V2.instVer = "";
    V2.job = { kind: kind, phase: "失败", pct: 0, log: [], done: true, ok: false, error: msg };
    v2ProgPaint();
    toast(msg, "err");
    if (v2vActive()) v2vRender();
  }

  /** 拉取多版本信息（已安装 + 官方发布列表），按内核类型取，存 V2.vers 供设置页渲染。 */
  function v2VersLoad(kind) {
    const k = kind === "sing-box" ? "sing-box" : "xray";
    return api("/api/v2ray/core/versions?kind=" + k).then(r => {
      // 请求期间用户可能又切了内核类型：过期的结果直接丢弃，否则面板会串台
      if (r && !r.error && k === v2CoreKind()) {
        V2.vers = r;
        V2.versKind = k;
        v2vRenderKeep(["v2vSetCore"]);        // 别把用户正在改的设置抹掉
      }
      return r;
    });
  }

  /** 启动一个内核后台任务，并用 SSE 实时刷新进度条。 */
  function v2JobRun(kind, path, body) {
    if (v2JobBusy()) return toast("已有任务在进行中，请稍候", "warn");
    v2JobClose();
    clearTimeout(V2.progTimer);
    V2.job = { kind: kind, phase: "准备中", pct: 0, log: [], done: false, ok: null, error: "" };
    v2ProgPaint();
    // 从版本列表里点「安装」时进度面板在上方，滚到可见位置，免得以为没反应
    requestAnimationFrame(() => {
      const b = $("v2Prog");
      if (b && b.offsetParent !== null) b.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
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
        V2.instVer = "";
        if (j.ok) {
          if (j.kind === "geo") {
            toast("geo 数据已下载，重启内核后生效", "ok");
            v2Reload().catch(() => {});
            uiModal({
              title: "geo 数据已就绪", icon: "bi-check2-circle",
              html: '<div class="m-msg">大陆分流所需的 <strong>geoip.dat</strong> / <strong>geosite.dat</strong> ' +
                "已下载到内核目录，重启内核后生效。</div>",
              okText: "重启内核", cancelText: "稍后",
            }).then(ok => { if (ok) v2vAction("restart", {}); });
            return;
          }
          const found = ((j.result || {}).found || []).length;
          toast(j.kind === "detect" ? ("探测完成，找到 " + found + " 个可用内核")
                                    : ("内核已就绪：" + ((j.result || {}).version || "")), "ok");
          v2Reload().catch(() => {});
          if (V2.vers) v2VersLoad(V2.versKind).catch(() => {});   // 版本面板开着就同步刷新它
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
    // 成功后过几秒自动收起，否则「安装完成 100%」会一直挂在页面上
    clearTimeout(V2.progTimer);
    V2.progTimer = null;
    if (doneOk) {
      V2.progTimer = setTimeout(() => {
        if (V2.job === j) { V2.job = null; V2.instVer = ""; v2ProgPaint(); }
      }, 8000);
    }
    // 下载时拿不到 Content-Length 就退化为「不确定态」来回滑动的条纹
    const indet = (j.kind === "download" || j.kind === "geo") && !j.done && !(j.total > 0);
    box.classList.toggle("indet", indet);
    const pct = indet ? 100 : Math.max(0, Math.min(100, Number(j.pct) || 0));
    const ico = $("v2ProgIco");
    if (ico) ico.className = "bi " + (j.kind === "detect" ? "bi-search" : "bi-cloud-arrow-down");
    const ph = $("v2ProgPhase");
    if (ph) ph.textContent = j.phase || "处理中";
    const pc = $("v2ProgPct");
    if (pc) {
      if ((j.kind === "download" || j.kind === "geo") && j.total > 0) {
        pc.textContent = fmtBytes(j.got) + " / " + fmtBytes(j.total) + " · " + pct + "%";
      } else {
        pc.textContent = pct + "%";
      }
    }
    const fill = $("v2ProgFill");
    if (fill) fill.style.width = pct + "%";
    const x = box.querySelector(".v2-prog-x");
    if (x) x.style.display = j.done ? "" : "none";   // 任务跑着时不给收起，避免以为任务停了
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
      '<span class="v2-prog-pct" id="v2ProgPct"></span>' +
      '<button type="button" class="v2-prog-x" data-act="prog-close" title="收起进度">' +
      '<i class="bi bi-x-lg"></i></button></div>' +
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
      // 侧栏徽标只在代理运行中显示；未连接时显示节点数会让人以为已经连上了
      const okN = V2.nodes.filter(n => V2.ping[n.id] && V2.ping[n.id].ok).length;
      const show = running && okN > 0;
      badge.textContent = String(okN);        // 只显示测速连接成功的节点数
      badge.title = "测速成功节点 " + okN + " / " + V2.nodes.length;
      badge.style.display = show ? "" : "none";
    }
    const hero = $("v2Hero");
    if (hero) hero.classList.toggle("on", running);
    const phase = V2.connPhase;
    const busy = !!phase;
    const phaseTxt = phase === "start" ? "启动中…" : phase === "stop" ? "停止中…" : "";
    const bt = $("v2Connect");
    if (bt) {
      bt.className = "v2-btn " + (busy ? "" : running ? "danger" : "v2-btn-pri");
      bt.disabled = busy;
      bt.innerHTML = busy
        ? '<i class="v2-spin"></i><span>' + phaseTxt + "</span>"
        : running
          ? '<i class="bi bi-stop-fill"></i><span>断开</span>'
          : '<i class="bi bi-play-fill"></i><span>连接</span>';
    }
    const run = $("v2StRun");
    if (run) {
      run.textContent = phaseTxt || (running ? "运行中" : "未运行");
      run.classList.toggle("busy", busy);
    }
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
      // 默认折叠，只露一条；点下面的按钮再展开全部（侧栏空间留给节点列表）
      const shown = V2.shareOpen ? list : list.slice(0, 1);
      sh.innerHTML = shown.map(s =>
        '<div class="v2-share-row"><span class="v2-share-tag">' + esc(s.label) + "</span>" +
        '<span class="v2-share-url" title="' + escA(s.url) + '">' + esc(s.url) + "</span>" +
        '<i class="bi bi-clipboard v2-share-cp" data-copy="' + escA(s.url) + '" title="复制"></i></div>'
      ).join("") + (list.length > 1
        ? '<button class="v2-share-more" data-share-more="1" title="展开 / 收起全部代理地址">' +
          '<i class="bi bi-chevron-' + (V2.shareOpen ? "up" : "down") + '"></i>' +
          (V2.shareOpen ? "收起地址" : "共 " + list.length + " 个地址") + "</button>"
        : "");
    }
    v2TodayPaint(st);
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
    const running = !!(V2.st && V2.st.running);
    const id = running ? "" : pickNodeId();
    if (running) {
      const ok = await uiConfirm("断开连接", "停止内核后，正在使用 10808 代理的用户会立即断网。", "断开", true);
      if (!ok) return;
    } else if (!id) {
      toast("请先在管理面板里添加节点", "warn");
      return v2OpenView("nodes");
    }
    V2.busy = true;
    V2.connPhase = running ? "stop" : "start";
    v2ConnPaint();                 // 侧栏与大页按钮同时进入「启动中 / 停止中」
    try {
      if (running) {
        const r = await post("/api/v2ray/disconnect");
        if (r.error) return toast(r.error, "err");
        toast("已断开", "ok");
      } else {
        const r = await post("/api/v2ray/connect", { id: id });
        if (r.error) return toast(r.error, "err");
        toast("已连接：" + ((nodeOf(id) || {}).name || id), "ok");
        v2PingRefresh(id);               // 服务端正在实测该节点延迟，稍后补拉更新
      }
      await v2Reload();
    } finally {
      V2.busy = false;
      V2.connPhase = "";
      v2ConnPaint();                 // 两处按钮同时退出过渡态
    }
  }

  (function v2SideInit() {
    const cn = $("v2Connect"); if (cn) cn.onclick = v2ToggleConnect;
    const rf = $("v2Refresh"); if (rf) rf.onclick = () => v2Reload();
    const ov = $("v2OpenView"); if (ov) ov.onclick = () => v2OpenView();
    const sh = $("v2Share");
    if (sh) sh.addEventListener("click", (e) => {
      const more = e.target.closest("[data-share-more]");
      if (more) { V2.shareOpen = !V2.shareOpen; v2SideRender(); return; }
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
      V2.connPhase = "start";
      v2ConnPaint();                   // 节点快选切换也走同一套过渡态，两处按钮同步
      try {
        toast("正在切换节点…", "info");
        const r = await post("/api/v2ray/connect", { id: id });
        if (r.error) return toast(r.error, "err");
        toast("已连接：" + ((nodeOf(id) || {}).name || id), "ok");
        await v2Reload();
        v2PingRefresh(id);               // 服务端正在实测该节点延迟，稍后补拉更新
      } finally { V2.busy = false; V2.connPhase = ""; v2ConnPaint(); }
    });
    // 活动栏图标：点一下补一次实时刷新（面板显隐由 02_ 的通用机制驱动）
    const act = document.querySelector('.activitybar .act[data-panel="v2ray"]');
    if (act) act.addEventListener("click", () => { v2Reload(); });
    // 侧栏「今日流量」每 60 秒补拉一次状态：服务端持续采样落库，不必等手动刷新
    setInterval(async () => {
      if (document.hidden || V2.busy) return;
      const st = await api("/api/v2ray/status").catch(() => null);
      if (!st || st.error) return;
      V2.st = st;
      v2TodayPaint(st);                // 只更新流量数字，节点列表滚动位置保持不变
    }, 60000);
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
        // 与左侧「V2Ray 代理」活动栏图标同色（--ide-c-v2ray）
        iconHtml: '<i class="bi bi-shield-shaded" style="color:var(--ide-c-v2ray)"></i>',
      };
      tab.onBeforeClose = () => { v2LogStop(); v2TrafStop(); v2ClientsStop(); v2SrvTrafStop(); v2JobClose(); v2SaveView(false); return true; };
      tab.onActivate = () => {
        v2Reload().catch(() => {});
        if (V2.autoLog) v2LogStart();
        if (V2.sec === "overview") v2TrafStart();
        if (V2.sec === "clients") v2ClientsStart();
        if (V2.sec === "server") { v2vServerFetch().catch(() => {}); v2SrvTrafStart(); }
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
                  ["clients", "连接", "bi-people"], ["server", "本地节点", "bi-hdd-rack"],
                  ["log", "日志", "bi-journal-text"],
                  ["module", "路由分流", "bi-signpost-split"]];
    const st = V2.st || {}, running = !!st.running;
    const phase = V2.connPhase, busy = !!phase;
    const phaseTxt = phase === "start" ? "启动中…" : phase === "stop" ? "停止中…" : "";
    const stateTxt = phaseTxt || (running ? "运行中" : "未运行");
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
      '<span class="v2v-state' + (busy ? " busy" : running ? " on" : "") + '">' +
      (busy ? '<i class="v2-spin"></i>' : "") + stateTxt + "</span></div>" +
      '<div class="v2v-sub">' + bits.join('<i class="v2v-dotsep"></i>') + "</div>" +
      "</div>" +
      '<div class="v2v-head-ops">' +
      '<button class="v2v-btn ' + (busy ? "" : running ? "danger" : "primary") + '" data-act="toggle"' +
      (busy ? " disabled" : "") + ">" +
      (busy ? '<i class="v2-spin"></i>' + phaseTxt
            : '<i class="bi ' + (running ? "bi-stop-fill" : "bi-play-fill") + '"></i>' +
              (running ? "断开" : "连接")) + "</button>" +
      '<button class="v2v-btn" data-act="restart"' + ((busy || !running) ? " disabled" : "") +
      '><i class="bi bi-arrow-repeat"></i>重启</button>' +
      '<button class="v2v-btn" data-act="refresh" title="刷新状态、节点与订阅"><i class="bi bi-arrow-clockwise"></i>刷新</button>' +
      "</div></div>";
    const tabbar = '<div class="v2v-tabs">' + secs.map(s => {
      const num = s[0] === "nodes"
        ? (V2.nodes.length && V2.nodes.some(n => V2.ping[n.id] !== undefined)
          ? (V2.nodes.reduce((s, n) => s + ((V2.ping[n.id] && V2.ping[n.id].ok) ? 1 : 0), 0) + "/" + V2.nodes.length)
          : V2.nodes.length)
        : (s[0] === "subs" ? V2.subs.length :
          (s[0] === "clients" && V2.clients && V2.clients.items ? V2.clients.items.length : 0));
      return '<button class="v2v-tab' + (V2.sec === s[0] ? " on" : "") + '" data-sec="' + s[0] + '">' +
        '<i class="bi ' + s[2] + '"></i><span>' + s[1] + "</span>" +
        (num ? '<span class="v2v-num">' + num + "</span>" : "") + "</button>";
    }).join("") + "</div>";
    let body = "";
    if (V2.sec === "overview") body = v2vOverview(st);
    else if (V2.sec === "nodes") body = v2vNodes();
    else if (V2.sec === "subs") body = v2vSubs();
    else if (V2.sec === "settings") body = v2vSettings(st);
    else if (V2.sec === "clients") body = v2vClients();
    else if (V2.sec === "server") body = v2vServer();
    else if (V2.sec === "module") body = v2vModule(st);
    else body = v2vLog();
    box.innerHTML = head + tabbar + body;
    v2ProgPaint();
    v2TrafListFit();
    v2NodeListFit();
    const nl = box.querySelector(".v2v-node-list");
    if (nl) nl.addEventListener("scroll", () => {
      if (nl.scrollTop + nl.clientHeight >= nl.scrollHeight - 24) v2MoreNodes(nl);
    }, { passive: true });
  }

  function v2vBanner() {
    const st = V2.st || {};
    if (st.core && st.core.ok) return "";
    return '<div class="v2v-hint warn"><i class="bi bi-exclamation-triangle"></i><div>' +
      "<strong>还没有可用的内核。</strong>到「设置」里点「一键下载」（可选 Xray-core / sing-box），" +
      "或把已有的 xray / v2ray / sing-box 可执行文件路径填进去。</div></div>";
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
        running ? "已稳定运行 " + esc(fmtUp(st.uptime)) : "内核未启动，点右上角「连接」即可启动",
        '<span class="v2v-flex"></span>' +
        '<button class="v2v-tab' + (V2.floatOn ? " on" : "") + '" data-act="float-toggle"' +
        ' title="在桌面悬浮一个流量胶囊：点击胶囊可展开菜单，切换节点 / 路由模式">' +
        '<i class="bi ' + (V2.floatOn ? "bi-pip-fill" : "bi-pip") + '"></i>' +
        (V2.floatOn ? "关闭悬浮" : "桌面悬浮") + "</button>" +
        '<button class="v2v-tab' + (v2FailOn() ? " on" : "") + '" data-act="auto-fail"' +
        ' title="由后端持续守护：开启后每 60 秒探测当前节点，连续两次超时自动切换到最优可用节点（关掉网页也生效）">' +
        '<i class="bi bi-shield-check"></i>失效自动切换</button>') +
      '<div class="v2v-stats">' +
      stat("bi-broadcast", "代理状态", running ? "运行中" : "未运行",
        running ? ("PID " + st.pid) : "等待连接", running ? "on" : "off") +
      stat("bi-diagram-3", "当前节点", n ? (n.name || "(未命名)") : "未选择",
        n ? (n.proto + " · " + n.server + ":" + n.port) : "从「节点」里挑一个") +
      stat("bi-cpu", "使用中的内核",
        c.ok ? ((c.kind === "sing-box" ? "sing-box" : "xray") + (c.version ? " " + c.version : ""))
             : "未找到",
        c.ok ? (running ? "本次连接正在使用" : "已就绪，连接后生效") : "到「设置」一键下载",
        c.ok ? "" : "bad") +
      stat("bi-hdd-network", "代理监听", inb.socks_port ? ("SOCKS5 · " + inb.socks_port) : "-",
        inb.listen ? ("监听 " + inb.listen) : "未启动", running ? "on" : "") +
      '<div class="v2v-stat' + (running ? " on" : "") + '" id="v2vSpdCard">' +
      '<span class="v2v-stat-ico"><i class="bi bi-arrow-down-up"></i></span>' +
      '<div class="v2v-stat-tx"><b>实时网速</b><strong id="v2vSpdTx">' +
      esc(v2vSpeedText()) + '</strong><em>每 5 秒自动刷新 · 采样自内核统计</em></div></div>' +
      '<div class="v2v-stat' + (running ? " on" : "") + '" id="v2vMemCard">' +
      '<span class="v2v-stat-ico"><i class="bi bi-memory"></i></span>' +
      '<div class="v2v-stat-tx"><b>内存占用</b><strong id="v2vMemTx">' +
      esc(v2MemText(st)) + '</strong><em id="v2vMemSub">' +
      esc(running ? ("内核进程 PID " + st.pid + " · 每 5 秒刷新") : "内核未启动") +
      "</em></div></div>" +
      "</div>" +
      '<div class="v2v-kv">' +
      kv("内核路径", c.path || "-", "mono") +
      kv("代理认证", inb.auth ? "已开启（用户名 / 密码）" : "无认证") +
      kv("HTTP 代理", inb.http_port ? ("端口 " + inb.http_port + " · " + inb.listen) : "未开启", inb.http_port ? "mono" : "") +
      kv("节点地址", n ? (n.server + ":" + n.port) : "-", "mono") +
      "</div></div>";

    // 先看用量再看分享地址：流量统计放前面
    h += '<div class="v2v-sec" id="v2vTrafSec">' + v2vTrafSecHTML() + "</div>";

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
  /** 内核进程常驻内存（后端 /status 与 /traffic 都带 mem.rss 字节数）。 */
  function v2MemText(st) {
    const rss = Number((((st || {}).mem) || {}).rss) || 0;
    return rss ? fmtBytes(rss) : "-";
  }

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
      h += '<div class="v2v-list v2v-traf-list">' + nodes.map(nd => {
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

  /* 流量列表只露出 5 行：按实际行高计算 max-height，主题 / 窄屏下也不会写死像素跑偏 */
  function v2TrafListFit() {
    const list = document.querySelector("#v2vTrafSec .v2v-traf-list");
    if (!list) return;
    const first = list.querySelector(".v2v-item");
    if (!first) { list.style.maxHeight = ""; return; }
    const row = first.getBoundingClientRect().height || first.offsetHeight;
    if (!row) return;                       // 标签隐藏时分不到高度，等下次渲染再算
    const gap = parseFloat(getComputedStyle(list).rowGap) || 0;
    list.style.maxHeight = (Math.ceil(row) * 5 + gap * 4) + "px";
  }
  window.addEventListener("resize", v2TrafListFit);

  /* 节点列表只露出 5 行：按实际行高计算 max-height，主题 / 窄屏下也不会写死像素跑偏 */
  function v2NodeListFit() {
    const list = document.querySelector("#v2View .v2v-node-list");
    if (!list) return;
    const first = list.querySelector(".v2v-item");
    if (!first) { list.style.maxHeight = ""; return; }
    const row = first.getBoundingClientRect().height || first.offsetHeight;
    if (!row) return;                       // 标签隐藏时分不到高度，等下次渲染再算
    const gap = parseFloat(getComputedStyle(list).rowGap) || 0;
    list.style.maxHeight = (Math.ceil(row) * 5 + gap * 4) + "px";
  }
  window.addEventListener("resize", v2NodeListFit);

  /* 节点列表分批渲染：滚动到底自动追加下一批，避免上千节点一次性 innerHTML 卡顿 */
  let v2MoreLoading = false;
  function v2MoreNodes(list) {
    if (v2MoreLoading || !list || !list.querySelector('[data-act="nodes-more"]')) return;
    v2MoreLoading = true;
    try {
      const vbox = $("v2View");
      const outer = (function findScroll(el) {
        while (el && el.parentElement) {
          el = el.parentElement;
          if (el.scrollHeight > el.clientHeight + 1) return el;
        }
        return null;
      })(vbox);
      const outerTop = outer ? outer.scrollTop : 0;
      const innerTop = list.scrollTop;
      V2.nodeShow = (V2.nodeShow || 60) + 150;
      if (v2vActive()) v2vRender();
      const nl = $("v2View") && $("v2View").querySelector(".v2v-node-list");
      if (nl) nl.scrollTop = innerTop;
      if (outer) outer.scrollTop = outerTop;
    } finally {
      v2MoreLoading = false;
    }
  }

  async function v2TrafficFetch() {
    const r = await api("/api/v2ray/traffic");
    if (r.error) return;
    V2.traffic = r;
    if (!v2vActive()) return;
    const tx = $("v2vSpdTx");
    if (tx) tx.textContent = v2vSpeedText();
    const mt = $("v2vMemTx");                 // 内存占用跟着一起刷新
    if (mt) mt.textContent = Number(r.mem) ? fmtBytes(r.mem) : "-";
    const sec = $("v2vTrafSec");
    if (sec) sec.innerHTML = v2vTrafSecHTML();
    v2TrafListFit();
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

  /* ==================================================================
     桌面悬浮流量胶囊（Document Picture-in-Picture）
       · 胶囊常驻桌面最上层：上行 / 下行速度 + 当前节点 + 路由模式；
       · 点击胶囊展开菜单：切路由模式（全局 / 绕过大陆 / 直连）、切节点、断开 / 连接；
       · Chrome / Edge 116+ 支持，窗口可拖动、始终置顶。
     ================================================================== */
  const V2_FLOAT_CSS = [
    '*{box-sizing:border-box}',
    'html,body{margin:0;padding:0;height:100%;overflow:hidden;background:#1b1c21;color:#e6e6e6;',
    'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,"PingFang SC","Microsoft YaHei",sans-serif}',
    '.vf-host{display:flex;flex-direction:column;height:100%;padding:8px;gap:8px}',
    '.vf-pill{display:flex;align-items:center;gap:10px;height:56px;padding:0 12px;border-radius:14px;',
    'background:#24262d;border:1px solid #3a3d46;cursor:pointer;user-select:none;flex:none}',
    '.vf-pill:hover{border-color:#4a4e59}',
    '.vf-dot{width:8px;height:8px;border-radius:50%;background:#6b7280;flex:none}',
    '.vf-dot.on{background:#35d0a5;box-shadow:0 0 8px rgba(53,208,165,.7)}',
    '.vf-spd{display:flex;flex-direction:column;gap:1px;min-width:0}',
    '.vf-spd b{font-size:13px;font-weight:600;white-space:nowrap}',
    '.vf-spd span{font-size:10.5px;color:#8b93a1;white-space:nowrap}',
    '.vf-node{flex:1;min-width:0;text-align:right}',
    '.vf-node b{display:block;font-size:11.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.vf-node span{font-size:10px;color:#8b93a1}',
    '.vf-caret{flex:none;font-size:11px;color:#8b93a1}',
    '.vf-menu{flex:1;min-height:0;display:flex;flex-direction:column;gap:6px;background:#1e2027;',
    'border:1px solid #343742;border-radius:12px;padding:8px}',
    '.vf-sec{font-size:10px;color:#7f8794;margin-top:2px;display:flex;justify-content:space-between}',
    '.vf-sec em{font-style:normal;color:#5f6673}',
    '.vf-modes{display:grid;grid-template-columns:repeat(3,1fr);gap:4px}',
    '.vf-modes button{height:28px;border-radius:7px;border:1px solid #3a3d46;background:#262931;',
    'color:#aeb6c2;font-size:11px;cursor:pointer;font-family:inherit}',
    '.vf-modes button:hover{border-color:#4a4e59;color:#e6e6e6}',
    '.vf-modes button.on{background:rgba(53,208,165,.16);border-color:#35d0a5;color:#eafff8}',
    '.vf-modes button:disabled{opacity:.55;cursor:default}',
    '.vf-nodes{flex:1;min-height:80px;overflow:auto;display:flex;flex-direction:column;gap:3px;padding-right:2px}',
    '.vf-nodes button{display:flex;align-items:center;gap:6px;min-height:26px;padding:3px 8px;border-radius:6px;',
    'border:1px solid transparent;background:transparent;color:#b9c0cc;font-size:11px;text-align:left;',
    'cursor:pointer;font-family:inherit}',
    '.vf-nodes button span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.vf-nodes button:hover{background:#262931;color:#fff}',
    '.vf-nodes button.on{background:rgba(53,208,165,.14);color:#eafff8}',
    '.vf-nodes button:disabled{opacity:.55;cursor:default}',
    '.vf-nodes .bi{flex:none;font-size:10px;color:#5f6673}',
    '.vf-nodes button.on .bi{color:#35d0a5}',
    '.vf-empty{padding:14px;text-align:center;font-size:11px;color:#7f8794}',
    '.vf-acts{display:grid;grid-template-columns:repeat(3,1fr);gap:4px;flex:none}',
    '.vf-acts button{height:28px;border-radius:7px;border:1px solid #3a3d46;background:#262931;',
    'color:#aeb6c2;font-size:11px;cursor:pointer;font-family:inherit}',
    '.vf-acts button:hover{border-color:#4a4e59;color:#fff}',
    '.vf-acts button.danger{color:#f28d96;border-color:rgba(240,97,109,.38)}',
    'html.theme-light,html.theme-light body{background:#fff;color:#1f2328}',
    'html.theme-light .vf-pill{background:#f6f8fa;border-color:#d8dee4}',
    'html.theme-light .vf-spd span,html.theme-light .vf-node span,html.theme-light .vf-sec{color:#8c959f}',
    'html.theme-light .vf-menu{background:#fafbfc;border-color:#d8dee4}',
    'html.theme-light .vf-modes button,html.theme-light .vf-acts button{background:#fff;border-color:#d0d7de;color:#57606a}',
    'html.theme-light .vf-modes button.on{background:#e8f1fb;border-color:#0969da;color:#0969da}',
    'html.theme-light .vf-nodes button{color:#33404d}',
    'html.theme-light .vf-nodes button:hover{background:#f0f3f6;color:#1f2328}',
    'html.theme-light .vf-nodes button.on{background:#e8f1fb;color:#0969da}',
  ].join("");

  function v2FloatModeName(m) {
    return m === "global" ? "全局代理" : (m === "direct" ? "全局直连" : "绕过大陆");
  }
  function v2FloatAlive() { return !!(V2.floatWin && !V2.floatWin.closed); }

  async function v2FloatToggle() {
    // 系统级悬浮窗：由后端启动一个独立的 tkinter 桌面进程（不是浏览器小窗）
    // 顺手关掉旧版浏览器 PiP 小窗，避免两个胶囊同时在桌面上
    try {
      if (window.documentPictureInPicture && window.documentPictureInPicture.window) {
        window.documentPictureInPicture.window.close();
      }
    } catch (_) { /* 忽略 */ }
    try {
      const cur = await api("/api/v2ray/float/status");
      if (cur && cur.running) {
        const r = await post("/api/v2ray/float/stop");
        if (r.error) return toast(r.error, "err");
        V2.floatOn = false;
        toast("桌面胶囊已关闭", "ok");
      } else {
        const r = await post("/api/v2ray/float/start");
        if (r.error) return toast(r.error, "err");
        V2.floatOn = !!r.running;
        toast("桌面胶囊已启动：屏幕右下角，可拖动，点击展开菜单", "ok");
      }
      if (v2vActive()) v2vRender();
    } catch (e) {
      toast("操作失败：" + ((e && e.message) || e), "err");
    }
  }

  function v2FloatClosed() {
    v2FloatStop();
    V2.floatWin = null;
    V2.floatOpen = false;
    if (v2vActive()) v2vRender();
  }

  function v2FloatStart() {
    v2FloatStop();
    V2.floatTimer = setInterval(async () => {
      if (!v2FloatAlive()) { v2FloatStop(); return; }
      const tr = await api("/api/v2ray/traffic").catch(() => null);
      if (tr && !tr.error) { V2.traffic = tr; v2FloatTick(); }
    }, 1500);
    V2.floatStTimer = setInterval(async () => {
      if (!v2FloatAlive()) return;
      const st = await api("/api/v2ray/status").catch(() => null);
      if (st && !st.error) { V2.st = st; v2FloatTick(); }
    }, 5000);
  }
  function v2FloatStop() {
    clearInterval(V2.floatTimer); V2.floatTimer = null;
    clearInterval(V2.floatStTimer); V2.floatStTimer = null;
  }

  function v2FloatBuild() {
    const win = V2.floatWin;
    if (!win || win.closed) return;
    const doc = win.document;
    const st = V2.st || {};
    const s = st.settings || {};
    const mode = ["global", "rule", "direct"].indexOf(s.route_mode) >= 0 ? s.route_mode : "rule";
    const node = st.node;
    const all = V2.nodes || [];
    const nodes = all.slice(0, 40);
    let html = '<div class="vf-host">' +
      '<div class="vf-pill" id="vfPill" title="点击展开 / 收起菜单">' +
      '<span class="vf-dot' + (st.running ? " on" : "") + '" id="vfDot"></span>' +
      '<div class="vf-spd"><b id="vfUp">↑ 0 B/s</b><span id="vfDown">↓ 0 B/s</span></div>' +
      '<div class="vf-node"><b id="vfNodeName">' + esc(node ? (node.name || node.server) : "未连接") + "</b>" +
      '<span id="vfModeName">' + esc(v2FloatModeName(mode)) + "</span></div>" +
      '<i class="bi bi-chevron-' + (V2.floatOpen ? "up" : "down") + ' vf-caret"></i>' +
      "</div>";
    if (V2.floatOpen) {
      html += '<div class="vf-menu">' +
        '<div class="vf-sec"><span>路由模式</span></div>' +
        '<div class="vf-modes">' + ["global", "rule", "direct"].map(m =>
          '<button data-vf-mode="' + m + '"' + (m === mode ? ' class="on"' : "") + ">" +
          { global: "全局", rule: "绕过大陆", direct: "直连" }[m] + "</button>").join("") + "</div>" +
        '<div class="vf-sec"><span>切换节点</span><em>' + all.length + " 个</em></div>" +
        '<div class="vf-nodes">' + (nodes.length
          ? nodes.map(n => '<button data-vf-node="' + escA(n.id) + '"' +
              (node && node.id === n.id ? ' class="on"' : "") +
              ' title="' + escA(n.name || n.server) + '">' +
              '<i class="bi bi-record-circle"></i><span>' + esc(n.name || n.server) + "</span></button>").join("")
          : '<div class="vf-empty">还没有节点</div>') + "</div>" +
        '<div class="vf-acts">' +
        '<button data-vf-act="toggle">' + (st.running ? "断开" : "连接") + "</button>" +
        '<button data-vf-act="open">主界面</button>' +
        '<button data-vf-act="close" class="danger">关闭胶囊</button>' +
        "</div></div>";
    }
    html += "</div>";
    doc.body.innerHTML = html;

    const pill = doc.getElementById("vfPill");
    if (pill) pill.onclick = () => {
      V2.floatOpen = !V2.floatOpen;
      try { win.resizeTo(320, V2.floatOpen ? 470 : 86); } catch (_) { /* 部分浏览器不允许，忽略 */ }
      v2FloatBuild();
    };
    doc.querySelectorAll("[data-vf-mode]").forEach(b => {
      b.onclick = () => { if (b.dataset.vfMode !== mode) v2FloatSetMode(b.dataset.vfMode); };
    });
    doc.querySelectorAll("[data-vf-node]").forEach(b => {
      b.onclick = () => { if (!node || node.id !== b.dataset.vfNode) v2FloatConnect(b.dataset.vfNode); };
    });
    const act = (name, fn) => {
      const el = doc.querySelector('[data-vf-act="' + name + '"]');
      if (el) el.onclick = fn;
    };
    act("toggle", () => v2FloatToggleConnect());
    act("open", () => { try { window.focus(); } catch (_) { /* 忽略 */ } v2OpenView("overview"); });
    act("close", () => { try { V2.floatWin.close(); } catch (_) { v2FloatClosed(); } });
    v2FloatTick();
  }

  function v2FloatTick() {
    const win = V2.floatWin;
    if (!win || win.closed) return;
    const doc = win.document;
    const sp = (V2.traffic && V2.traffic.speed) || { up: 0, down: 0 };
    const up = doc.getElementById("vfUp"), down = doc.getElementById("vfDown");
    if (up) up.textContent = "↑ " + fmtBytes(sp.up || 0) + "/s";
    if (down) down.textContent = "↓ " + fmtBytes(sp.down || 0) + "/s";
    const st = V2.st || {}, node = st.node;
    const dot = doc.getElementById("vfDot");
    if (dot) dot.classList.toggle("on", !!st.running);
    const nm = doc.getElementById("vfNodeName");
    if (nm) nm.textContent = node ? (node.name || node.server) : "未连接";
    const md = doc.getElementById("vfModeName");
    if (md) md.textContent = v2FloatModeName((st.settings || {}).route_mode || "rule");
  }

  async function v2FloatSetMode(m) {
    const doc = V2.floatWin && V2.floatWin.document;
    if (doc) doc.querySelectorAll("[data-vf-mode]").forEach(b => {
      b.disabled = true;
      b.classList.toggle("on", b.dataset.vfMode === m);
    });
    try {
      const r = await post("/api/v2ray/settings",
        { route_mode: m, bypass_cn: m === "rule" ? 1 : 0 });
      if (r.error) throw new Error(r.error);
      if (V2.st && V2.st.settings) {
        V2.st.settings.route_mode = m;
        V2.st.settings.bypass_cn = m === "rule" ? 1 : 0;
      }
      if (V2.st && V2.st.running) {
        toast("正在重启内核切换模式…", "info");
        const rr = await post("/api/v2ray/restart");
        if (rr && rr.error) throw new Error(rr.error);
      }
      await v2Reload();
      toast("已切换为「" + v2FloatModeName(m) + "」", "ok");
    } catch (e) {
      toast("切换失败：" + ((e && e.message) || e), "err");
    } finally {
      v2FloatBuild();
    }
  }

  async function v2FloatConnect(id) {
    const doc = V2.floatWin && V2.floatWin.document;
    if (doc) doc.querySelectorAll("[data-vf-node]").forEach(b => { b.disabled = true; });
    try {
      const r = await post("/api/v2ray/connect", { id: id });
      if (r.error) throw new Error(r.error);
      await v2Reload();
      toast("已切换节点：" + ((nodeOf(id) || {}).name || id), "ok");
    } catch (e) {
      toast("切换节点失败：" + ((e && e.message) || e), "err");
    } finally {
      v2FloatBuild();
    }
  }

  async function v2FloatToggleConnect() {
    const running = !!(V2.st && V2.st.running);
    try {
      if (running) {
        const r = await post("/api/v2ray/disconnect");
        if (r.error) throw new Error(r.error);
        toast("已断开", "ok");
      } else {
        const id = pickNodeId();
        if (!id) { toast("还没有节点，请先在主界面添加", "warn"); return; }
        const r = await post("/api/v2ray/connect", { id: id });
        if (r.error) throw new Error(r.error);
        toast("已连接：" + ((nodeOf(id) || {}).name || id), "ok");
      }
      await v2Reload();
    } catch (e) {
      toast("操作失败：" + ((e && e.message) || e), "err");
    } finally {
      v2FloatBuild();
    }
  }

  /* ---------- 实时连接：连到代理入站端口（SOCKS5 / HTTP）的客户端 ---------- */
  function v2ClientsFetch() {
    return Promise.all([
      post("/api/v2ray/clients", {}),
      api("/api/v2ray/client_usage").catch(() => ({ items: [] })),
    ]).then(([r, u]) => {
      V2.clients = r || null;
      V2.usage = (u && u.items) || [];
      if (v2vActive() && V2.sec === "clients") v2vRender();
    });
  }
  function v2ClientsStop() { clearTimeout(V2.clientsTimer); V2.clientsTimer = null; }
  function v2ClientsStart() {
    v2ClientsStop();
    const tick = async () => {
      if (!v2vActive() || V2.sec !== "clients") { V2.clientsTimer = null; return; }
      await v2ClientsFetch().catch(() => {});
      if (V2.clientsTimer === null) return;
      V2.clientsTimer = setTimeout(tick, 3000);
    };
    tick();
  }
  function v2vClients() {
    const d = V2.clients;
    let inner = "";
    if (!d) {
      inner = '<div class="v2v-empty"><i class="bi bi-arrow-repeat"></i><b>加载中…</b></div>';
    } else if (d.error) {
      inner = '<div class="v2v-empty"><i class="bi bi-x-circle"></i><b>' + esc(d.error) + "</b></div>";
    } else if (!d.items || !d.items.length) {
      inner = '<div class="v2v-empty"><i class="bi bi-people"></i><b>暂无客户端连接</b><span>' +
        esc(d.hint || "还没有客户端连到代理入站端口；有新连接后 3 秒内会出现在这里") + "</span></div>";
    } else {
      inner = '<div class="v2v-list">' + d.items.map(it =>
        '<div class="v2v-item"><span class="v2v-ico" style="background:rgba(59,130,246,.12);color:#3b82f6">' +
        '<i class="bi bi-person"></i></span>' +
        '<div style="min-width:0;flex:1"><b style="font-size:13px">' + esc(it.ip) + "</b>" +
        '<div style="font-size:11.5px;opacity:.65;margin-top:2px">入站 ' + esc(it.inbound) +
        (it.procs && it.procs.length ? " · 内核进程 " + esc(it.procs.join(", ")) : "") + "</div></div>" +
        '<span class="v2v-ping good"><i class="bi bi-arrow-left-right"></i>' + it.conns + " 连接</span></div>"
      ).join("") + "</div>";
    }
    return '<div class="v2v-sec">' +
      v2vSecHead("bi-people", "实时连接",
        (d && d.items && d.items.length ? ("客户端 " + d.items.length + " · 连接 " + d.total + " · ") : "") +
        "每 3 秒自动刷新") +
      inner + "</div>" + v2vUsage();
  }

  /* ---------- 使用统计：按来源 IP 的流量 / 时长 / 首末使用 ---------- */
  function v2FmtDur(sec) {
    sec = Math.max(0, Math.floor(Number(sec) || 0));
    const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600),
          m = Math.floor(sec % 3600 / 60);
    if (d) return d + " 天 " + h + " 小时";
    if (h) return h + " 小时 " + m + " 分";
    if (m) return m + " 分 " + Math.floor(sec % 60) + " 秒";
    return Math.floor(sec % 60) + " 秒";
  }
  function v2FmtTs(t) {
    t = Number(t) || 0;
    if (!t) return "—";
    return new Date(t * 1000).toLocaleString("zh-CN", { hour12: false });
  }
  /* ---------- 本地服务端节点：把本机做成 v2 代理，供其他设备连接 ---------- */
  function v2vServerFetch() {
    // 同时刷新主代理状态（拿 10808 当前节点）与多节点列表
    return Promise.all([
      api("/api/v2ray/server/nodes"),
      api("/api/v2ray/status").catch(() => null),
    ]).then(([r, st]) => {
      if (st && !st.error) V2.st = st;
      if (!r.error) {
        V2.serverNodes = r.nodes || [];
        V2.serverLanIp = r.lan_ip || "";
        V2.serverCoreReady = !!r.core_ready;
        V2.sharedCore = r.shared_core !== false;
        // 选中项失效则回落到第一个
        if (!V2.serverNodes.some(n => n.id === V2.srvCur)) {
          V2.srvCur = V2.serverNodes.length ? V2.serverNodes[0].id : "";
        }
        if (v2vActive() && V2.sec === "server") v2vRender();
      }
      return r;
    });
  }

  /* ---------- 本地节点流量统计：每 3 秒轮询 stats API 采样结果 ---------- */
  function v2SrvTrafficFetch() {
    return api("/api/v2ray/server/traffic").then(r => {
      if (r.error) return r;
      V2.srvTraffic = r;
      // 只局部替换流量卡片，避免重绘整页打断正在编辑的配额 / 配置输入框
      if (v2vActive() && V2.sec === "server") {
        const ae = document.activeElement;
        const editing = ae && (ae.id === "v2vSrvQuota" || ae.id === "v2vSrvQuotaAct");
        const cur = (V2.serverNodes || []).find(n => n.id === V2.srvCur);
        const box = $("v2vSrvTrafCard");
        if (cur && box && !editing) box.outerHTML = v2vSrvTrafCard(cur);
        else if (!cur) v2vRender();
      }
      return r;
    });
  }
  function v2SrvTrafStart() {
    v2SrvTrafficFetch().catch(() => {});
    if (V2.srvTrafTimer) return;
    V2.srvTrafTimer = setInterval(() => {
      if (v2vActive() && V2.sec === "server") v2SrvTrafficFetch().catch(() => {});
    }, 3000);
  }
  function v2SrvTrafStop() {
    if (V2.srvTrafTimer) { clearInterval(V2.srvTrafTimer); V2.srvTrafTimer = null; }
  }

  /* 流量统计卡片：单独成函数，供整页渲染与轮询局部更新共用 */
  function v2vSrvTrafCard(s) {
    const traf = ((V2.srvTraffic && V2.srvTraffic.nodes) || []).find(t => t.id === s.id) || null;
    const tf = traf || { up: 0, down: 0, speed_up: 0, speed_down: 0,
                          quota_gb: s.quota_gb || 0, quota_bytes: 0,
                          quota_action: s.quota_action || "stop", exceeded: false, api_ok: false };
    const used = (tf.up || 0) + (tf.down || 0);
    const quotaBytes = tf.quota_bytes || 0;
    const pct = quotaBytes > 0 ? Math.min(100, Math.round(used * 100 / quotaBytes)) : 0;
    const chip = (ico, label, value, cls) =>
      '<div class="v2v-stat' + (cls ? " " + cls : "") + '">' +
      '<span class="v2v-stat-ico"><i class="bi ' + ico + '"></i></span>' +
      '<div class="v2v-stat-tx"><b>' + esc(label) + "</b><strong>" + esc(value) + "</strong></div></div>";
    let quotaHtml = "";
    if (quotaBytes > 0) {
      const qcls = tf.exceeded ? "err" : (pct >= 80 ? "warn" : "");
      quotaHtml =
        '<div class="v2v-quota">' +
        '<div class="v2v-quota-head"><span>配额用量</span>' +
        '<b class="' + qcls + '">' +
        fmtBytes(used) + " / " + esc(String(tf.quota_gb)) + " GB（" + pct + "%）</b></div>" +
        '<div class="v2v-quota-track"><i class="' + qcls +
        '" style="width:' + pct + '%"></i></div>' +
        (tf.exceeded ? '<div class="v2v-quota-tip err"><i class="bi bi-exclamation-triangle"></i>' +
          "已超流量配额，节点" + (tf.quota_action === "stop" ? "已自动停止" : "仅提示（未停止）") +
          "。请清零流量或调高上限后重新启动。</div>" : "") +
        "</div>";
    }
    return '<div class="v2v-sec" id="v2vSrvTrafCard">' +
      v2vSecHead("bi-bar-chart-line", "流量统计 · " + esc(s.name),
        "每个节点独立统计 · 数据落库，重启不丢",
        '<span class="v2v-flex"></span>' +
        '<button class="v2v-btn" data-act="server-traffic-refresh"><i class="bi bi-arrow-clockwise"></i>刷新</button>' +
        '<button class="v2v-btn danger" data-act="server-traffic-reset" data-id="' + escA(s.id) +
        '"><i class="bi bi-eraser"></i>清零</button>') +
      '<div class="v2v-trow">' +
      chip("bi-graph-up-arrow", "实时上行", fmtBytes(tf.speed_up || 0) + "/s", "up") +
      chip("bi-graph-down-arrow", "实时下行", fmtBytes(tf.speed_down || 0) + "/s", "down") +
      chip("bi-cloud-arrow-up", "累计上行", fmtBytes(tf.up || 0)) +
      chip("bi-cloud-arrow-down", "累计下行", fmtBytes(tf.down || 0)) +
      "</div>" + quotaHtml +
      (tf.api_ok === false && s.running
        ? '<div class="v2v-hint"><i class="bi bi-info-circle"></i>该节点统计 API 尚未就绪：确认节点已重启、统计端口未被占用后，流量数据才开始累计。</div>'
        : "") +
      '<div class="v2v-subhead"><span>流量配额</span></div>' +
      '<div class="v2v-grid">' +
      '<label class="v2v-field"><span>流量上限（GB，0 = 不限）</span>' +
      '<input type="number" id="v2vSrvQuota" min="0" step="0.1" value="' + escA(tf.quota_gb || 0) + '"></label>' +
      '<label class="v2v-field"><span>超限动作</span><select id="v2vSrvQuotaAct">' +
      '<option value="stop"' + (tf.quota_action === "stop" ? " selected" : "") + '>自动停止节点</option>' +
      '<option value="notify"' + (tf.quota_action === "notify" ? " selected" : "") + '>仅标记提示</option>' +
      "</select></label></div>" +
      '<div class="v2v-actions"><span class="v2v-hint" style="margin:0;border:0;padding:0;background:none">' +
      "累计用量达上限后按所选动作处理；保存后立即生效，无需重启。</span>" +
      '<span class="v2v-flex"></span>' +
      '<button class="v2v-btn primary" data-act="server-quota-save"><i class="bi bi-check2"></i>保存配额</button>' +
      "</div></div>";
  }

  function v2vServer() {
    const nodes = V2.serverNodes || [];
    const cur = nodes.find(n => n.id === V2.srvCur) || null;
    const s = cur || {};
    const running = !!s.running;
    const uptime = s.started_at ? fmtUp(Math.max(0, Date.now() / 1000 - s.started_at)) : "-";
    const curNode = (V2.st && V2.st.node) || null;
    const mainOn = !!(V2.st && V2.st.running);
    const curNodeTxt = curNode ? (curNode.name || (curNode.server + ":" + curNode.port) || "-") : "未连接节点";
    const stat = (ico, label, value, extra, cls) =>
      '<div class="v2v-stat' + (cls ? " " + cls : "") + '">' +
      '<span class="v2v-stat-ico"><i class="bi ' + ico + '"></i></span>' +
      '<div class="v2v-stat-tx"><b>' + esc(label) + "</b>" +
      '<strong title="' + escA(value) + '">' + esc(value) + "</strong>" +
      (extra ? '<em title="' + escA(extra) + '">' + esc(extra) + "</em>" : "") + "</div></div>";
    const kv = (k, v, cls) =>
      "<div><b>" + esc(k) + "</b><span" + (cls ? ' class="' + cls + '"' : "") +
      ' title="' + escA(v) + '">' + esc(v) + "</span></div>";

    let h = "";
    // ===== 节点列表 =====
    h += '<div class="v2v-sec">' +
      v2vSecHead("bi-hdd-rack", "本地节点列表",
        "共 " + nodes.length + " 个节点 · " + nodes.filter(n => n.running).length + " 个运行中",
        '<span class="v2v-flex"></span>' +
        '<button class="v2v-btn primary" data-act="server-auto-create" title="自动生成 UUID / 密钥 / 端口等关键配置并创建节点">' +
        '<i class="bi bi-magic"></i>一键生成节点</button>' +
        '<button class="v2v-btn" data-act="server-refresh"><i class="bi bi-arrow-clockwise"></i>刷新</button>') +
      '<div class="v2v-hint"><i class="bi bi-info-circle"></i><div>' +
      "点「一键生成节点」会自动生成 UUID、REALITY 密钥对、ShortID、空闲端口等全部关键配置，立即创建一个可用节点；" +
      "也可在下方手动微调参数。" +
      (V2.sharedCore
        ? "当前为<strong>共用内核</strong>模式：所有节点并入主代理的同一内核进程，共享出口，启动节点前需先在「概览」连接主节点。"
        : "当前为独立进程模式：每个节点独立监听端口、独立进程。") +
      " 本机局域网 IP：<strong>" + esc(V2.serverLanIp || "未取到") + "</strong></div></div>";
    if (!nodes.length) {
      h += '<div class="v2v-empty"><i class="bi bi-hdd-rack"></i><b>还没有本地节点</b>' +
        "<span>点右上角「一键生成节点」创建一个 VLESS + REALITY 节点</span></div>";
    } else {
      h += '<div class="v2v-list">' + nodes.map(n =>
        '<div class="v2v-item' + (n.id === V2.srvCur ? " on" : "") + '">' +
        '<span class="v2v-ico ' + protoCls(n.proto) + '"><i class="bi bi-hdd-rack"></i></span>' +
        '<div class="v2v-info"><div class="v2v-nm">' + esc(n.name) +
          '<span class="v2v-pill ' + (n.running ? "on" : (n.enabled ? "" : "off")) + '">' +
          (n.running ? "● 运行中" : (n.enabled ? "◐ 待主内核" : "○ 未运行")) + "</span>" +
          (n.id === V2.srvCur ? '<span class="v2v-pill"><i class="bi bi-pencil-square"></i>编辑中</span>' : "") +
        '</div><div class="v2v-meta"><span class="v2v-pill proto">' + esc(n.proto) + "</span>" +
          '<span class="v2v-pill">' + esc((n.security || "").toUpperCase()) + "</span>" +
          "<em>0.0.0.0:" + esc(n.port) + "</em>" +
          (n.security === "reality" ? "<span>SNI " + esc(n.sni) + "</span>" : "") +
          (n.running ? "<span>" + (n.shared_core ? "共用主内核 " : "PID ") + n.pid + "</span>" : "") +
        "</div></div>" +
        '<div class="v2v-ops">' +
          '<button class="v2v-btn' + (n.running ? " danger" : " primary") +
            '" data-act="server-node-toggle" data-id="' + escA(n.id) + '"><i class="bi ' +
            (n.running ? "bi-stop-fill" : "bi-play-fill") + '"></i>' + (n.running ? "停止" : "启动") + "</button>" +
          '<button class="v2v-btn" data-act="server-node-select" data-id="' + escA(n.id) +
            '" title="编辑此节点"><i class="bi bi-pencil"></i></button>' +
          '<button class="v2v-btn ico" data-act="server-node-copy" data-id="' + escA(n.id) +
            '" title="复制分享链接"><i class="bi bi-clipboard"></i></button>' +
          '<button class="v2v-btn ico danger" data-act="server-node-delete" data-id="' + escA(n.id) +
            '" title="删除节点"><i class="bi bi-trash"></i></button>' +
        "</div></div>").join("") + "</div>";
    }
    h += "</div>";

    if (!cur) return h;   // 没有选中节点时只显示列表

    // ===== 选中节点：概览 =====
    h += '<div class="v2v-sec">' +
      v2vSecHead("bi-diagram-3", "节点概览 · " + esc(s.name),
        running ? ("已运行 " + uptime) : "未运行",
        '<span class="v2v-flex"></span>' +
        '<button class="v2v-btn ' + (running ? "danger" : "primary") + '" data-act="server-toggle"' +
        (!running && !V2.serverCoreReady ? ' disabled title="未找到 Xray 内核"' : "") + ">" +
        '<i class="bi ' + (running ? "bi-stop-fill" : "bi-play-fill") + '"></i>' +
        (running ? "停止服务" : "启动服务") + "</button>") +
      '<div class="v2v-stats">' +
      stat("bi-broadcast", "服务状态", running ? "运行中" : (s.enabled ? "待主内核" : "未运行"),
        running ? ((s.shared_core ? "共用主内核 PID " : "PID ") + s.pid)
                : (s.enabled ? "已启用，连接主节点后生效" : "等待启动"),
        running ? "on" : (s.enabled ? "" : "off")) +
      stat("bi-hdd-network", "入站监听", "0.0.0.0:" + (s.port || "-"),
        (s.proto || "").toUpperCase() + " · " + (s.security === "reality" ? "REALITY" : "明文"), running ? "on" : "") +
      stat("bi-arrow-left-right", "出站方式",
        s.outbound === "direct" ? "本机直连外网" : "经主代理出口",
        s.outbound === "direct" ? "需本机能直接上网"
          : (mainOn && curNode ? ("当前节点：" + curNodeTxt) : "未连节点，需先在主界面连接"),
        s.outbound === "direct" ? "" : (mainOn && curNode ? "on" : "bad")) +
      "</div>" +
      '<div class="v2v-kv">' +
      kv("节点 ID", s.id || "-", "mono") +
      (s.outbound !== "direct"
        ? kv("当前连接节点", mainOn && curNode ? curNodeTxt : (curNode ? curNodeTxt + "（未运行）" : "未连接节点"),
            mainOn && curNode ? "ok" : "err") : "") +
      (s.security === "reality"
        ? kv("REALITY 密钥", s.reality_ready ? "已就绪（pbk " + (s.publickey || "").slice(0, 12) + "…）" : "未生成",
            s.reality_ready ? "ok" : "err") + kv("伪装 SNI", s.sni || "-", "mono") : "") +
      "</div></div>";

    // ===== 流量统计 / 配额 =====
    h += v2vSrvTrafCard(s);

    // ===== 节点配置（编辑选中节点） =====
    h += '<div class="v2v-sec">' +
      v2vSecHead("bi-sliders", "节点配置 · " + esc(s.name), "修改后需重启该节点才会生效",
        '<span class="v2v-flex"></span>' +
        '<button class="v2v-btn primary" data-act="server-save"><i class="bi bi-check2"></i>保存配置</button>' +
        '<button class="v2v-btn" data-act="server-preview"><i class="bi bi-code-square"></i>预览配置</button>') +
      '<div class="v2v-grid">' +
      '<label class="v2v-field"><span>节点名称</span><input type="text" id="v2vSrvName" value="' + escA(s.name || "") + '"></label>' +
      '<label class="v2v-field"><span>协议</span><select id="v2vSrvProto">' +
      '<option value="vmess"' + (s.proto === "vmess" ? " selected" : "") + '>VMess</option>' +
      '<option value="vless"' + (s.proto === "vless" ? " selected" : "") + '>VLESS</option></select></label>' +
      '<label class="v2v-field"><span>监听端口</span><input type="number" id="v2vSrvPort" value="' +
      escA(s.port || 10810) + '" min="1" max="65535"></label>' +
      '<label class="v2v-field"><span>安全类型</span><select id="v2vSrvSec">' +
      '<option value="reality"' + (s.security !== "none" ? " selected" : "") + '>VLESS + REALITY</option>' +
      '<option value="none"' + (s.security === "none" ? " selected" : "") + '>明文</option></select></label>' +
      '<label class="v2v-field"><span>出站方式</span><select id="v2vSrvOut">' +
      '<option value="proxy"' + (s.outbound !== "direct" ? " selected" : "") + '>经本机 10808 代理</option>' +
      '<option value="direct"' + (s.outbound === "direct" ? " selected" : "") + '>本机直连外网</option></select></label>' +
      '<label class="v2v-field v2v-field-wide"><span>客户端 UUID</span>' +
      '<div style="display:flex;gap:6px"><input type="text" id="v2vSrvUuid" value="' + escA(s.uuid || "") + '">' +
      '<button class="v2v-btn" data-act="server-new-uuid"><i class="bi bi-shuffle"></i>换一个</button></div></label>' +
      "</div>" +
      '<div id="v2vSrvReality" style="display:' + (s.security !== "none" ? "" : "none") + '">' +
      '<div class="v2v-subhead"><span>REALITY 参数</span></div>' +
      '<div class="v2v-grid">' +
      '<label class="v2v-field"><span>SNI（伪装域名）</span><input type="text" id="v2vSrvSni" value="' + escA(s.sni || "www.overleaf.com") + '"></label>' +
      '<label class="v2v-field"><span>伪装目标 dest</span><input type="text" id="v2vSrvDest" value="' + escA(s.dest || "www.overleaf.com:443") + '"></label>' +
      '<label class="v2v-field"><span>ShortID (sid)</span><input type="text" id="v2vSrvSid" value="' + escA(s.shortid || "") + '"></label>' +
      '<label class="v2v-field"><span>Flow</span><input type="text" id="v2vSrvFlow" value="' + escA(s.flow || "xtls-rprx-vision") + '"></label>' +
      '<label class="v2v-field"><span>指纹 (fp)</span><input type="text" id="v2vSrvFp" value="' + escA(s.fp || "chrome") + '"></label>' +
      '<label class="v2v-field v2v-field-wide"><span>服务端私钥 privateKey（不要泄露）</span>' +
      '<div style="display:flex;gap:6px"><input type="text" id="v2vSrvPriv" value="' + escA(s.privatekey || "") + '">' +
      '<button class="v2v-btn" data-act="server-gen-keys"><i class="bi bi-key"></i>生成密钥对</button></div></label>' +
      (s.publickey ? '<label class="v2v-field v2v-field-wide"><span>派生 PublicKey (pbk) · 已写入分享链接</span>' +
        '<span class="v2v-code" style="word-break:break-all">' + esc(s.publickey) + "</span></label>" : "") +
      "</div></div></div>";

    // ===== 分享链接 / 二维码 =====
    const link = s.share_url || "";
    h += '<div class="v2v-sec">' +
      v2vSecHead("bi-qr-code", "分享链接 / 二维码 · " + esc(s.name), "手机扫一扫或复制链接导入客户端",
        '<span class="v2v-flex"></span>' +
        '<button class="v2v-btn primary" data-act="server-copy"' + (link ? "" : " disabled") + '><i class="bi bi-clipboard"></i>复制链接</button>' +
        '<button class="v2v-btn' + (V2.serverQr ? " on" : "") + '" data-act="server-qr"' + (link ? "" : " disabled") +
        '><i class="bi bi-qr-code"></i>' + (V2.serverQr ? "收起二维码" : "显示二维码") + "</button>") +
      '<div class="v2v-meta" style="padding:6px 0"><span class="v2v-code" style="white-space:normal;word-break:break-all;max-width:100%">' +
      esc(link) + "</span></div>" +
      (V2.serverQr && link ? '<div style="display:flex;justify-content:center;padding:12px;background:#fff;border-radius:10px">' +
        '<img src="/api/v2ray/server/qr?text=' + encodeURIComponent(link) + '" alt="节点二维码" style="width:220px;height:220px"></div>' : "") +
      "</div>";

    // ===== 日志 =====
    h += '<div class="v2v-sec">' +
      v2vSecHead("bi-journal-text", "服务端日志 · " + esc(s.name), "该节点内核的最近输出",
        '<span class="v2v-flex"></span>' +
        '<button class="v2v-btn" data-act="server-log-refresh"><i class="bi bi-arrow-clockwise"></i>刷新</button>' +
        '<button class="v2v-btn danger" data-act="server-log-clear"><i class="bi bi-eraser"></i>清空</button>') +
      '<pre class="v2v-log">' + esc(V2.serverLog || "暂无日志") + "</pre></div>";
    return h;
  }

  function v2vUsage() {
    const rows = (V2.usage || []).filter(r => (r.up + r.down) > 0 || r.dur > 0);
    let list;
    if (!rows.length) {
      list = '<div class="v2v-empty"><i class="bi bi-clock-history"></i><b>暂无使用记录</b>' +
        "<span>客户端经代理产生流量后会在这里按 IP 累计：流量 · 使用时长 · 首次 / 最后使用</span></div>";
    } else {
      list = '<div class="v2v-list">' + rows.slice(0, 50).map(r =>
        '<div class="v2v-item">' +
        '<span class="v2v-ico" style="background:rgba(16,185,129,.12);color:#10b981">' +
        '<i class="bi bi-person-check"></i></span>' +
        '<div style="min-width:0;flex:1"><b style="font-size:13px">' + esc(r.ip) + "</b>" +
        '<div style="font-size:11.5px;opacity:.65;margin-top:2px">↑ ' + fmtBytes(r.up) +
        " · ↓ " + fmtBytes(r.down) + " · 使用时长 " + v2FmtDur(r.dur) +
        "<br>首次 " + v2FmtTs(r.first) + " · 最后 " + v2FmtTs(r.last) + "</div></div>" +
        '<span class="v2v-ping ' + (r.online ? "good" : "") + '">' +
        (r.online ? "在线 · " : "") + fmtBytes(r.up + r.down) + "</span></div>"
      ).join("") + "</div>";
    }
    return '<div class="v2v-sec">' +
      v2vSecHead("bi-clock-history", "使用统计",
        "按来源 IP 累计 · 数据落库，重启服务不清零 · 每 3 秒刷新",
        '<span class="v2v-flex"></span>' +
        '<button class="v2v-btn ico danger" data-act="usage-clear" title="清空统计"><i class="bi bi-eraser"></i></button>') +
      list + "</div>";
  }

  /* ---------- 节点失效自动切换（看门狗在后端运行，与网页是否打开无关） ----------
     前端只负责开关 UI 与把开关同步给后端 /api/v2ray/auto-failover；
     真正的定时探测 + 自动切换由后端 v2raymgr 的后台线程执行，关掉浏览器也持续运行。 */
  function v2FailOn() {
    // 当前开关状态以后端返回的 settings.auto_failover 为准
    return !!(V2.st && V2.st.settings && V2.st.settings.auto_failover);
  }

  // 当前过滤条件（搜索词 + 分组 tab + 隐藏超时 + 延迟排序）下的节点列表。
  // 节点页渲染与「全部测速」共用，保证测速范围和列表显示一致。
  // opts.hideFail：显式传 false 可忽略「隐藏超时」（测速时要包含超时节点才有机会重测）
  function v2NodeFilteredList(opts) {
    const o = opts || {};
    const hideF = ("hideFail" in o) ? o.hideFail : V2.hideFail;
    const kw = (V2.kw || "").trim().toLowerCase();
    let list = V2.nodes.filter(n => !kw ||
      String(n.name || "").toLowerCase().includes(kw) || String(n.server || "").toLowerCase().includes(kw));
    if (V2.nodeTab.indexOf("sub:") === 0) list = list.filter(n => n.sub_id === V2.nodeTab.slice(4));
    else if (V2.nodeTab.indexOf("grp:") === 0) list = list.filter(n => (n.grp || "").trim() === V2.nodeTab.slice(4));
    if (hideF) list = list.filter(n => !(V2.ping[n.id] && !V2.ping[n.id].ok));   // 隐藏超时节点
    if (V2.sortPing) list = list.slice().sort((a, b) => {   // 按延迟升序，未测的排最后
      const va = (V2.ping[a.id] && V2.ping[a.id].ok) ? V2.ping[a.id].ms : 9e9;
      const vb = (V2.ping[b.id] && V2.ping[b.id].ok) ? V2.ping[b.id].ms : 9e9;
      return va - vb;
    });
    // 当前已连接的节点始终排到第一条（连接后 v2Reload 重绘即生效）
    const cid = curNodeId();
    if (cid) {
      const i = list.findIndex(n => n.id === cid);
      if (i > 0) list.unshift(list.splice(i, 1)[0]);
    }
    return list;
  }

  // 手动添加节点时的归属：当前打开的是自定义分组 tab → 归组；订阅 tab → 挂到该订阅下
  function v2AddTarget() {
    const t = V2.nodeTab || "__all__";
    if (t.indexOf("grp:") === 0) return { grp: t.slice(4) };
    if (t.indexOf("sub:") === 0) return { sub_id: t.slice(4) };
    return {};
  }

  function v2vNodes() {
    // tab 分组：全部 / 按订阅名 / 自定义分组（节点编辑里填的 grp + 「+」手动新建的空分组）
    const grpNames = [...new Set(V2.nodes.map(n => (n.grp || "").trim()).filter(Boolean))];
    const customGrps = (V2.groups || []).filter(g => grpNames.indexOf(g) < 0);   // 还没有节点的空分组
    const tabs = [{ k: "__all__", label: "全部", ids: V2.nodes.map(n => n.id) }]
      .concat((V2.subs || []).map(s => ({
        k: "sub:" + s.id, label: s.name || s.id,
        ids: V2.nodes.filter(n => n.sub_id === s.id).map(n => n.id),
      })))
      .concat(grpNames.map(g => ({
        k: "grp:" + g, label: g, grp: true,
        ids: V2.nodes.filter(n => (n.grp || "").trim() === g).map(n => n.id),
      })))
      .concat(customGrps.map(g => ({ k: "grp:" + g, label: g, grp: true, ids: [] })));
    if (!tabs.some(t => t.k === V2.nodeTab)) V2.nodeTab = "__all__";
    // 每个分组 tab 显示「可用/总数」：组内延迟测速可用的节点数 / 组内节点总数；
    // 整组一个都没测过时只显示总数（避免没测速就满屏 0/408 误导）
    const tabCnt = t => {
      const n = t.ids.length;
      if (!n || !t.ids.some(id => V2.ping[id] !== undefined)) return String(n);
      return t.ids.reduce((s, id) => s + ((V2.ping[id] && V2.ping[id].ok) ? 1 : 0), 0) + "/" + n;
    };
    const list = v2NodeFilteredList();
    // 大量节点（上千条）时一次性 innerHTML 全量渲染会严重卡顿：
    // 只渲染前 V2.nodeShow 条，列表末尾放「加载更多」，点一次补一批
    if (!V2.nodeShow) V2.nodeShow = 60;
    const shown = list.slice(0, V2.nodeShow);
    // 每个 tab 后面跟当前组的节点数；末尾的「+」新建自定义分组；
    // 自定义分组 tab 内还有一个「×」删分组（组内节点保留，回到「全部」）
    const tabHtml = '<div class="v2v-tabs">' + tabs.map(t =>
      '<button class="v2v-tab' + (V2.nodeTab === t.k ? " on" : "") + '" data-act="node-tab" data-tab="' +
      escA(t.k) + '">' + esc(t.label) + " " + tabCnt(t) +
      (t.grp ? '<span class="v2v-tab-x" data-act="node-grp-del" data-grp="' + escA(t.label) +
        '" title="删除该分组（组内节点保留，回到全部）"><i class="bi bi-x-lg"></i></span>' : "") +
      "</button>").join("") +
      '<button class="v2v-tab v2v-tab-add" data-act="node-grp-new" title="新建自定义分组">' +
      '<i class="bi bi-plus-lg"></i></button></div>';
    const cid = curNodeId();
    // 测速超时的节点数（当前已连接的节点不算，避免误删导致断网）
    const failN = V2.nodes.filter(n => n.id !== cid && V2.ping[n.id] && !V2.ping[n.id].ok).length;
    // 导入面板默认收起，点「节点列表」右上角的「导入节点」才展开
    const importOpen = !!V2.nodeForm || !!V2.showManual;
    let h = "";
    if (importOpen) {
      h += '<div class="v2v-sec">' +
        v2vSecHead("bi-plus-circle", "导入节点", "支持 vmess / vless / trojan / ss 分享链接，可一次粘贴多行",
          '<span class="v2v-flex"></span>' +
          '<button class="v2v-btn ico" data-act="node-import" title="收起导入面板"><i class="bi bi-x-lg"></i></button>') +
        '<div class="v2v-grid"><label class="v2v-field v2v-field-wide">' +
        '<span>粘贴分享链接（每行一条）</span>' +
        '<textarea id="v2vLinks" placeholder="vmess://...&#10;vless://...&#10;trojan://...&#10;ss://..."></textarea></label></div>' +
        '<div class="v2v-actions"><button class="v2v-btn primary" data-act="add-links"><i class="bi bi-box-arrow-in-down"></i>添加链接</button>' +
        '<button class="v2v-btn" data-act="toggle-manual"><i class="bi bi-pencil-square"></i>' +
        (V2.showManual ? "收起手填表单" : "手填节点参数") + "</button></div>";
    }
    if (importOpen && V2.showManual) {
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
        '<label class="v2v-field"><span>TLS / 安全</span><select id="v2vMTls">' +
          '<option value="none">无</option><option value="tls">tls</option>' +
          '<option value="reality">reality</option></select></label>' +
        '<label class="v2v-field"><span>Host 头</span><input type="text" id="v2vMHost"></label>' +
        '<label class="v2v-field"><span>路径 / serviceName</span><input type="text" id="v2vMPath"></label>' +
        '<label class="v2v-field"><span>SNI（伪装域名）</span><input type="text" id="v2vMSni"></label>' +
        '<label class="v2v-field"><span>Flow（vless）</span><input type="text" id="v2vMFlow" placeholder="xtls-rprx-vision"></label>' +
        '<label class="v2v-field"><span>证书指纹 pin（可选）</span><input type="text" id="v2vMPin"></label>' +
        '<label class="v2v-field"><span>alterId（vmess）</span><input type="number" id="v2vMAid" value="0"></label>' +
      "</div>" +
      '<div id="v2vMReality" style="display:none">' +
        '<div class="v2v-subhead"><span>REALITY 参数（上面 TLS 选 reality 时填写）</span></div>' +
        '<div class="v2v-grid">' +
        '<label class="v2v-field"><span>PublicKey (pbk)</span><input type="text" id="v2vMPbk"></label>' +
        '<label class="v2v-field"><span>ShortID (sid)</span><input type="text" id="v2vMSid"></label>' +
        '<label class="v2v-field"><span>指纹 (fp)</span><input type="text" id="v2vMFp" value="chrome" placeholder="chrome"></label>' +
        '<label class="v2v-field"><span>spiderX (spx)</span><input type="text" id="v2vMSpx" placeholder="/"></label>' +
        "</div></div>" +
      '<div class="v2v-actions"><button class="v2v-btn primary" data-act="add-manual"><i class="bi bi-check2"></i>添加节点</button></div>';
    }
    if (importOpen) h += "</div>";

    h += '<div class="v2v-sec">' +
      v2vSecHead("bi-diagram-3", "节点列表",
        (V2.pingProg ? "并发测速中 " + V2.pingProg.done + "/" + V2.pingProg.total + " · " : "") +
        (V2.dlProg ? "下载测速中 " + V2.dlProg.done + "/" + V2.dlProg.total + " · " : "") +
        (list.length ? ("共 " + list.length + " 个节点" + ((V2.kw || "").trim() ? "（已过滤）" : "")) : "还没有可用的节点"),
        // 导入面板默认收起，入口紧贴标题，行内其余按钮换行时它也不会跑丢
        '<button class="v2v-btn' + (V2.nodeForm ? "" : " primary") + '" data-act="node-import" title="' +
        (V2.nodeForm ? "收起导入面板" : "粘贴分享链接 / 手填参数导入节点") + '">' +
        '<i class="bi ' + (V2.nodeForm ? "bi-chevron-up" : "bi-plus-lg") + '"></i>' +
        (V2.nodeForm ? "收起导入" : "导入节点") + "</button>" +
        '<span class="v2v-flex"></span>' +
        '<input type="text" id="v2vKw" class="v2v-kw" placeholder="搜索名称 / 地址" value="' + escA(V2.kw || "") + '">' +
        '<button class="v2v-tab' + (V2.sortPing ? " on" : "") + '" data-act="sort-ping" title="按延迟从低到高排序">' +
        '<i class="bi bi-sort-down"></i>延迟</button>' +
        '<button class="v2v-tab' + (V2.hideFail ? " on" : "") + '" data-act="hide-fail" title="隐藏测速超时的节点">' +
        '<i class="bi bi-eye-slash"></i>隐藏超时</button>' +
        '<button class="v2v-btn" data-act="ping-all" title="测速当前列表下的全部节点（当前 tab + 搜索过滤）"' +
        (list.length && !V2.pingProg && !V2.dlProg ? "" : " disabled") +
        '><i class="bi bi-lightning-charge"></i>' + (V2.pingProg ? "测速中…" : "全部测速") + "</button>" +
        '<button class="v2v-btn" data-act="dl-all" title="逐个实测当前列表里「测速可用」节点的下载速度（每个节点起临时内核实测，耗时较长）"' +
        (list.length && !V2.pingProg && !V2.dlProg ? "" : " disabled") +
        '><i class="bi bi-cloud-download"></i>' + (V2.dlProg ? ("测速中 " + V2.dlProg.done + "/" + V2.dlProg.total) : "测下载") + "</button>" +
        '<button class="v2v-btn danger" data-act="del-timeout"' + (failN && !V2.pingProg ? "" : " disabled") +
        ' title="删除所有测速超时的节点（进回收站，可恢复）"><i class="bi bi-trash"></i>删除超时' + (failN ? " " + failN : "") + "</button>" +
        '<button class="v2v-btn' + (V2.trashOpen ? " on" : "") + '" data-act="trash" title="回收站：删除的节点可在这里恢复">' +
        '<i class="bi bi-archive"></i>回收站' + (V2.trashN ? " " + V2.trashN : "") + "</button>" +
        tabHtml);
    // 回收站面板：软删除的节点，可恢复 / 彻底删除
    if (V2.trashOpen) {
      const tr = V2.trash || [];
      h += '<div class="v2v-sec">' +
        v2vSecHead("bi-archive", "回收站",
          tr.length ? ("已删除 " + tr.length + " 个节点 · 可恢复或彻底清除") : "空",
          '<span class="v2v-flex"></span>' +
          '<button class="v2v-btn danger" data-act="trash-clear"' + (tr.length ? "" : " disabled") +
          '><i class="bi bi-x-circle"></i>清空</button>' +
          '<button class="v2v-btn ico" data-act="trash" title="收起回收站"><i class="bi bi-x-lg"></i></button>');
      if (!tr.length) {
        h += '<div class="v2v-empty"><i class="bi bi-archive"></i><b>回收站是空的</b></div>';
      } else {
        h += '<div class="v2v-list">' + tr.map(n =>
          '<div class="v2v-item"><span class="v2v-ico ' + protoCls(n.proto) +
          '"><i class="bi ' + protoIcon(n.proto) + '"></i></span>' +
          '<div class="v2v-info"><div class="v2v-nm">' + esc(n.name || "(未命名)") + "</div>" +
          '<div class="v2v-meta"><span class="v2v-pill proto">' + esc(n.proto || "") + "</span>" +
          "<em>" + esc(n.server || "") + ":" + esc(n.port || "") + "</em>" +
          (n.deleted_at ? "<span>" + fmtTime(n.deleted_at) + " 删除</span>" : "") + "</div></div>" +
          '<div class="v2v-ops">' +
          '<button class="v2v-btn" data-act="trash-restore" data-id="' + escA(n.id) +
          '"><i class="bi bi-arrow-counterclockwise"></i>恢复</button>' +
          '<button class="v2v-btn ico danger" data-act="trash-purge" data-id="' + escA(n.id) +
          '" title="彻底删除（真删库，不可恢复）"><i class="bi bi-trash"></i></button>' +
          "</div></div>").join("") + "</div>";
      }
      h += "</div>";
    }
    if (!list.length) {
      h += '<div class="v2v-empty"><i class="bi bi-inbox"></i><b>' +
        (V2.nodes.length ? "没有匹配的节点" : "还没有节点") + "</b><span>" +
        (V2.nodes.length ? "换个关键词试试，或清空搜索框"
                         : "点右上角「导入节点」粘贴分享链接，或到「订阅」里添加一个订阅地址") + "</span></div>";
    } else {
      h += '<div class="v2v-list v2v-node-list">' + shown.map(n => {
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
    const formOpen = editing || !!V2.subForm;
    let h = "";

    // —— 新建 / 编辑表单：默认收起，点「新建订阅」或行内「编辑」才展开 ——
    if (formOpen) {
      h += '<div class="v2v-sec">' +
        v2vSecHead(editing ? "bi-pencil-square" : "bi-rss", editing ? "编辑订阅" : "新建订阅",
          editing ? "修改后保存会自动重新拉取节点" : "填入订阅地址，保存后自动拉取并导入节点",
          '<span class="v2v-flex"></span>' +
          '<button class="v2v-btn ico" data-act="cancel-sub" title="收起表单"><i class="bi bi-x-lg"></i></button>') +
        '<div class="v2v-grid">' +
        '<label class="v2v-field v2v-field-wide"><span>订阅地址（http:// 或 https://）</span>' +
        '<input type="text" id="v2vSubUrl" value="' + escA(e.url || "") + '" placeholder="https://example.com/sub?token=..."></label>' +
        '<label class="v2v-field"><span>名称</span><input type="text" id="v2vSubName" value="' + escA(e.name || "") + '" placeholder="例如：机场 A"></label>' +
        '<label class="v2v-field"><span>拉取时走的代理（可选）</span>' +
        '<input type="text" id="v2vSubProxy" value="' + escA(e.proxy || "") +
        '" placeholder="留空 = 自动：直连不行就用当前节点"></label>' +
        '<label class="v2v-field"><span>状态</span><select id="v2vSubEnabled">' +
        '<option value="1"' + (e.enabled === 0 ? "" : " selected") + ">启用</option>" +
        '<option value="0"' + (e.enabled === 0 ? " selected" : "") + ">停用</option></select></label>" +
        "</div>" +
        '<div class="v2v-actions">' +
        '<button class="v2v-btn primary" data-act="save-sub"><i class="bi bi-check2"></i>' +
        (editing ? "保存修改" : "添加订阅") + "</button>" +
        '<button class="v2v-btn" data-act="cancel-sub">取消</button>' +
        "</div>" +
        '<div class="v2v-hint"><i class="bi bi-info-circle"></i><div>订阅内容里的分享链接会被解析成节点；刷新会<strong>覆盖该订阅下已有的节点</strong>，' +
        "手动添加的节点（不属于任何订阅）不受影响。<br>" +
        "拉取顺序：<strong>上面填的代理 → 当前连接的节点 → 直连</strong>，" +
        "所以代理留空就行，需要翻墙的订阅会自动走正在连的节点；" +
        "返回网页时会自动找页面里的 .txt 订阅地址再抓。</div></div></div>";
    }

    // —— 订阅列表：右上角统一放「刷新全部订阅」+「新建订阅」 ——
    h += '<div class="v2v-sec">' +
      v2vSecHead("bi-list-ul", "订阅列表",
        V2.subs.length ? ("共 " + V2.subs.length + " 个订阅") : "还没有订阅",
        '<span class="v2v-flex"></span>' +
        '<button class="v2v-btn" data-act="refresh-all-subs"' +
        (V2.subAllBusy || !V2.subs.length ? " disabled" : "") + ' title="逐个重新拉取全部订阅">' +
        '<i class="bi bi-cloud-download' + (V2.subAllBusy ? " spin" : "") + '"></i>' +
        (V2.subAllBusy ? "更新中…" : "刷新全部订阅") + "</button>" +
        '<button class="v2v-btn primary" data-act="new-sub"' +
        (formOpen && !editing ? " disabled" : "") + ' title="展开新建订阅表单">' +
        '<i class="bi bi-plus-lg"></i>新建订阅</button>');
    if (!V2.subs.length) {
      h += '<div class="v2v-empty"><i class="bi bi-rss"></i><b>还没有订阅</b>' +
        "<span>点右上角「新建订阅」填一个订阅地址，保存后会自动拉取节点</span></div>";
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

  /** 设置页当前选中的内核类型（Tab 切换优先，其次落库值）。 */
  function v2CoreKind() {
    if (V2.coreKind === "sing-box" || V2.coreKind === "xray") return V2.coreKind;
    const s = (V2.st && V2.st.settings) || {};
    return s.core_kind === "sing-box" ? "sing-box" : "xray";
  }

  /** 某种内核「已保存 / 正在编辑」的路径（两种内核各存一份，切 Tab 不互相覆盖）。 */
  function v2PathOf(kind) {
    if (V2.pathDraft[kind] !== undefined) return V2.pathDraft[kind];
    const s = (V2.st && V2.st.settings) || {};
    return (kind === "sing-box" ? s.core_path_singbox : s.core_path) || "";
  }

  /** 探测到的、可用的某类内核路径（用来给输入框做占位提示）。 */
  function v2KindCorePath(kind) {
    const c = (V2.cores || []).find(x => (x.kind || "xray") === kind && x.ok);
    return c ? (c.path || "") : "";
  }

  /** 路径输入框下面的说明：当前实际在用哪个 / 自动探测到的路径 / 没找到时的提示。 */
  function v2KindTip(kind) {
    const c = (V2.st || {}).core || {};
    if (c.ok && c.path && (c.kind || "xray") === kind) {
      return "当前使用：" + c.path + (c.version ? "（" + c.version + "）" : "");
    }
    const det = v2KindCorePath(kind);
    if (det) return "自动探测到：" + det;
    return "本机没探测到 " + v2CoreName(kind) + " 内核，可直接下载或用「使用」按钮指定";
  }

  /** 切 Tab 要整页重绘，但不想丢掉用户正在输入的设置：先快照，重绘后回填。 */
  function v2SnapInputs(skip) {
    const out = {};
    document.querySelectorAll("#v2View input[id], #v2View select[id], #v2View textarea[id]")
      .forEach(el => {
        if (skip && skip.indexOf(el.id) >= 0) return;
        out[el.id] = el.type === "checkbox" ? !!el.checked : el.value;
      });
    return out;
  }

  function v2RestoreInputs(snap) {
    Object.keys(snap || {}).forEach(id => {
      const el = $(id);
      if (!el) return;
      if (el.type === "checkbox") el.checked = !!snap[id];
      else el.value = snap[id];
    });
  }

  /** 整页重绘但保留正在输入的内容（skip = 不保留的控件 id 列表）。 */
  function v2vRenderKeep(skip) {
    if (!v2vActive()) return;
    const snap = v2SnapInputs(skip);
    v2vRender();
    v2RestoreInputs(snap);
  }
  function v2CoreName(kind) { return kind === "sing-box" ? "sing-box" : "Xray-core"; }
  function v2CoreUrlPlaceholder(kind) {
    // sing-box 的压缩包文件名里带版本号，所以给 releases 总目录最省事：填目录页会自动取最新版
    if (kind === "sing-box") return "https://github.com/SagerNet/sing-box/releases（留空 = 自动取最新版）";
    const plat = ((V2.coreInfo || {}).platform || "linux/64").replace("/", "-");
    return "https://github.com/XTLS/Xray-core/releases/latest/download/Xray-" + plat + ".zip";
  }

  function v2vSettings(st) {
    const s = st.settings || {};
    const cores = V2.cores || [];
    const busy = v2JobBusy();
    const core = st.core || {};
    const plat = (V2.coreInfo && V2.coreInfo.platform) || "linux/64";
    const kind = v2CoreKind();
    const lan = (s.socks_listen || "127.0.0.1") === "0.0.0.0";
    const authOn = lan || String(s.auth_enabled === undefined ? 1 : s.auth_enabled) !== "0";
    let h = v2vBanner();
    h += '<div class="v2v-sec">' +
      v2vSecHead("bi-cpu", "内核", "自动探测本机的 xray / v2ray / sing-box，找不到可一键下载官方版本") +
      '<div class="v2v-grid">' +
      '<div class="v2v-field v2v-field-wide"><span>内核类型（决定下载哪个内核、管理谁的版本列表；连接时按选中的内核自动选配置格式）</span>' +
      '<div class="v2v-kindtabs">' +
        [["xray", "Xray-core", "bi-cpu"], ["sing-box", "sing-box", "bi-box"]].map(t =>
          '<button type="button" class="v2v-kindtab' + (kind === t[0] ? " on" : "") +
          '" data-act="core-kind" data-kind="' + t[0] + '"><i class="bi ' + t[2] + '"></i>' + t[1] + "</button>"
        ).join("") +
      "</div></div>" +
      '<div class="v2v-field v2v-field-wide"><span>' + esc(v2CoreName(kind)) +
      ' 内核可执行文件路径（留空 = 自动探测）</span>' +
      '<input type="text" id="v2vSetCore" value="' + escA(v2PathOf(kind)) + '" placeholder="' +
      escA(v2KindCorePath(kind) || ("/path/to/" + (kind === "sing-box" ? "sing-box" : "xray"))) + '">' +
      '<div class="v2v-tip" id="v2vCoreTip">' + esc(v2KindTip(kind)) + "</div></div>" +
      '<label class="v2v-field v2v-field-wide"><span>下载源（留空 = 官方最新版；也可填 releases 页面地址、镜像前缀或完整压缩包地址）</span>' +
      '<input type="text" id="v2vSetCoreUrl" value="' + escA(s.core_url || "") + '" placeholder="' +
      escA(v2CoreUrlPlaceholder(kind)) + '"></label>' +
      "</div>";
    h += '<div class="v2v-actions">' +
      '<button class="v2v-btn primary" data-act="download-core"' + (busy ? " disabled" : "") +
      '><i class="bi bi-cloud-arrow-down"></i><span id="v2vDlLabel">一键下载 ' + esc(v2CoreName(kind)) + "</span></button>" +
      '<button class="v2v-btn" data-act="detect-core"' + (busy ? " disabled" : "") +
      ' title="只探测当前选择的 ' + escA(v2CoreName(kind)) + ' 内核">' +
      '<i class="bi bi-search"></i>重新探测</button>' +
      '<button class="v2v-btn" data-act="ver-list"' + (busy || V2.versBusy ? " disabled" : "") +
      '><i class="bi ' + (V2.versBusy ? "bi-arrow-repeat spin"
        : (V2.vers ? "bi-chevron-up" : "bi-list-stars")) + '"></i>' +
      (V2.vers ? "收起版本列表" : "查看其他版本") + "</button>" +
      '<span class="v2v-plat"><i class="bi bi-pc-display"></i>当前平台 · ' + esc(plat) + "</span>" +
      "</div>" + v2ProgHtml();
    // 只展示当前 Tab 那一类内核（探测结果也按类型分开），避免两种内核混在一列
    const myCores = cores.filter(c => (c.kind || "xray") === kind);
    if (myCores.length) {
      h += '<div class="v2v-cores">' + myCores.map(c =>
        '<div class="v2v-core' + (c.ok ? " ok" : "") + '">' +
        '<span class="v2v-core-nm"><i class="bi bi-terminal"></i>' + esc(c.name) + "</span>" +
        '<span class="v2v-core-v">' + esc(c.version || "不可用") + "</span>" +
        '<span class="v2v-core-p" title="' + escA(c.path) + '">' + esc(c.path) + "</span>" +
        (c.ok
          ? (c.path === core.path
              ? '<span class="v2v-core-v">使用中</span>'
              : '<button class="v2v-btn sm" data-act="core-use" data-path="' + escA(c.path) +
                '"' + (busy ? " disabled" : "") +
                ' title="把该内核设为当前使用（会覆盖上面的路径设置）"><i class="bi bi-check2"></i>使用</button>')
          : "") +
        "</div>").join("") + "</div>";
    } else if (cores.length) {
      h += '<div class="v2v-hint"><i class="bi bi-info-circle"></i><div>' +
        "本机还没有 " + esc(v2CoreName(kind)) + " 内核（已探测到 " +
        esc(cores.map(c => c.name).join(" / ")) + "）：点上面的「一键下载 " +
        esc(v2CoreName(kind)) + "」即可装到 data/v2ray/core，或把已有可执行文件路径填进去。</div></div>";
    } else {
      h += '<div class="v2v-hint warn"><i class="bi bi-exclamation-triangle"></i><div>' +
        "系统里没有探测到 xray / v2ray / sing-box，请点上面的「一键下载 " + esc(v2CoreName(kind)) +
        "」（会装到 data/v2ray/core）。</div></div>";
    }
    // —— 版本管理：已安装多版本切换 + 官方发布版本按需安装（按内核类型分别管理） ——
    if (V2.vers) {
      const vs = V2.vers;
      const vKind = vs.kind === "sing-box" ? "sing-box" : "xray";
      const curV = vs.current_version || "";
      // 该类型没在用（比如正在跑 xray）时，别显示成「未知」，讲清楚现在用的是谁
      const curText = curV ? curV
        : ("未使用" + (vs.current_kind && vs.current_kind !== vKind
            ? "（当前内核：" + v2CoreName(vs.current_kind) + "）" : ""));
      h += '<div id="v2vVersBox"><div class="v2v-subhead"><span>' + esc(v2CoreName(vKind)) +
        " 版本管理</span>" +
        '<em class="v2v-sub-note">当前使用：' + esc(curText) +
        " · 安装到 data/v2ray/versions/，切换后若内核在跑会自动重启</em>" +
        '<span class="v2v-flex"></span>' +
        '<button class="v2v-btn sm" data-act="ver-hide"><i class="bi bi-x-lg"></i>收起</button></div>';
      if (vs.installed && vs.installed.length) {
        h += '<div class="v2v-cores">' + vs.installed.map(v =>
          '<div class="v2v-core' + (v.ok ? " ok" : "") + '">' +
          '<span class="v2v-core-nm"><i class="bi bi-box-seam"></i>' + esc(v.version || v.dir) + "</span>" +
          '<span class="v2v-core-v">' + (v.version && v.version === curV ? "使用中" : (v.ok ? "就绪" : "不可用")) + "</span>" +
          '<span class="v2v-core-p" title="' + escA(v.path) + '">' + esc(v.path) + "</span>" +
          (v.ok && v.version !== curV
            ? '<button class="v2v-btn sm" data-act="ver-use" data-ver="' + escA(v.version || v.dir) +
              '" data-kind="' + escA(vKind) + '" title="切换到该版本"><i class="bi bi-arrow-left-right"></i>使用</button>'
            : "") +
          "</div>").join("") + "</div>";
      }
      if (vs.remote_error) {
        h += '<div class="v2v-hint warn"><i class="bi bi-exclamation-triangle"></i><div>' + esc(vs.remote_error) + "</div></div>";
      } else if (vs.remote && vs.remote.length) {
        const instList = vs.installed || [];
        h += '<div class="v2v-cores">' + vs.remote.slice(0, 15).map(v => {
          const inst = instList.find(x => x.version === v.version);
          const isCur = !!curV && v.version === curV;
          let act;
          if (isCur) {
            act = '<span class="v2v-core-v">使用中</span>';
          } else if (inst) {
            // 已经装过的版本就别再给「安装」，直接给「使用」
            act = '<span class="v2v-core-v">已安装</span>' +
              '<button class="v2v-btn sm" data-act="ver-use" data-ver="' + escA(v.version) +
              '" data-kind="' + escA(vKind) + '" title="切换到该版本">' +
              '<i class="bi bi-arrow-left-right"></i>使用</button>';
          } else {
            act = '<button class="v2v-btn sm" data-act="ver-install" data-ver="' + escA(v.version) +
              '" data-kind="' + escA(vKind) + '"' + (busy ? " disabled" : "") +
              ' title="下载安装该版本（不自动切换）">' +
              '<i class="bi ' + (V2.instVer === v.version ? "bi-arrow-repeat spin" : "bi-cloud-arrow-down") +
              '"></i>' + (V2.instVer === v.version ? "安装中…" : "安装") + "</button>";
          }
          return '<div class="v2v-core' + (isCur || inst ? " ok" : "") + '">' +
            '<span class="v2v-core-nm"><i class="bi bi-tag"></i>' + esc(v.version) + "</span>" +
            '<span class="v2v-core-v">' + esc(v.published || "") + "</span>" +
            '<span class="v2v-core-p">' + (isCur ? "当前版本" : "") + "</span>" +
            act + "</div>";
        }).join("") + "</div>";
      }
      h += "</div>";
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
      '<input type="password" id="v2vSetPass" value="" autocomplete="new-password" data-lpignore="true" data-1p-ignore placeholder="' + (st.has_pass ? "••••••（留空保持不变）" : "") +
      '" autocomplete="new-password">' +
      '<button type="button" class="v2v-btn ico" id="v2vPassEye" title="显示 / 隐藏密码"><i class="bi bi-eye"></i></button>' +
      '<button type="button" class="v2v-btn ico" id="v2vPassCopy" title="复制密码"><i class="bi bi-clipboard"></i></button>' +
      "</div></label>" +
      "</form>" +
      '<div class="v2v-subhead"><span>其它</span></div>' +
      '<div class="v2v-grid">' +
      '<label class="v2v-field"><span>订阅拉取代理（可选，留空 = 自动用当前节点）</span>' +
      '<input type="text" id="v2vSetSubProxy" value="' + escA(s.sub_proxy || "") +
      '" placeholder="留空即自动：直连不行就用当前连接的节点"></label>' +
      '<label class="v2v-field"><span>服务启动时自动连接上次的节点</span><select id="v2vSetAuto">' +
        '<option value="1"' + (Number(s.auto_start) ? " selected" : "") + ">开启</option>" +
        '<option value="0"' + (Number(s.auto_start) ? "" : " selected") + ">关闭</option></select></label>" +
      '<label class="v2v-field"><span>本地节点共用主内核（节省资源，推荐）</span><select id="v2vSetShared">' +
        '<option value="1"' + (s.shared_core === undefined || Number(s.shared_core) ? " selected" : "") +
        ">开启（并入主配置同一进程）</option>" +
        '<option value="0"' + (Number(s.shared_core) === 0 ? " selected" : "") +
        ">关闭（每节点独立进程）</option></select></label>" +
      "</div>" +
      '<div class="v2v-actions">' +
      '<button class="v2v-btn primary" data-act="save-settings"><i class="bi bi-check2"></i>保存设置</button>' +
      (st.has_pass ? '<button class="v2v-btn danger" data-act="clear-pass"><i class="bi bi-key"></i>清空密码</button>' : "") +
      "</div>" +
      '<div class="v2v-hint"><i class="bi bi-info-circle"></i><div>监听 <strong>0.0.0.0</strong> 时，同网段的设备（如手机）都能通过「本机IP:端口」使用本代理；' +
      "改成 <strong>127.0.0.1</strong> 则只有本机能用。HTTP 代理端口给手机 / 只支持 HTTP 代理的应用使用，与 SOCKS5 共用账号密码。</div></div></div>";
    return h;
  }

  /* ---------- 路由分流：路由模式 / 大陆分流 / 始终直连 ---------- */
  function v2ModeName(m) {
    return m === "global" ? "全局代理" : (m === "direct" ? "全局直连" : "智能分流");
  }
  function v2vModule(st) {
    const s = (st && st.settings) || {};
    const mode = ["global", "rule", "direct"].indexOf(s.route_mode) >= 0 ? s.route_mode : "rule";
    const cn = Number(s.bypass_cn === undefined ? 1 : s.bypass_cn) ? 1 : 0;
    const kind = v2CoreKind();
    const assets = (st && st.route_assets) || {};
    const geoFull = !!(assets.geoip && assets.geosite);
    const modes = [
      ["global", "全局代理", "bi-globe2", "除本机 / 局域网外，所有流量都走代理节点"],
      ["rule", "智能分流", "bi-signpost-split", "大陆直连，其余流量走代理（推荐）"],
      ["direct", "全局直连", "bi-arrow-right-circle", "所有流量直连；代理入口保留，便于随时切回"],
    ];
    const cur = modes.filter(m => m[0] === mode)[0] || modes[1];
    // 只有 Xray 需要 geo 文件；没拿到检测结果（旧后端 / 正在加载）时也给出下载入口，避免卡在「检测中」
    const needGeo = kind !== "sing-box" && !geoFull;
    let h = v2vBanner();
    h += '<div class="v2v-sec">' +
      v2vSecHead("bi-signpost-split", "路由模式", "决定哪些流量走代理、哪些直接连接；保存并重启内核后生效") +
      '<div class="v2v-kindtabs v2v-routetabs">' + modes.map(m =>
        '<button type="button" class="v2v-kindtab' + (mode === m[0] ? " on" : "") +
        '" data-act="route-mode" data-mode="' + m[0] + '" title="' + escA(m[3]) + '">' +
        '<i class="bi ' + m[2] + '"></i>' + m[1] + "</button>").join("") +
      "</div>" +
      '<div class="v2v-tip" id="v2vRouteTip">' + esc(cur[3]) + "</div>" +
      "</div>";

    h += '<div class="v2v-sec">' +
      v2vSecHead("bi-geo-alt", "大陆分流", "过滤大陆：大陆域名 / IP 直接连接，其余流量走代理") +
      '<div class="v2v-grid">' +
      '<label class="v2v-field"><span>过滤大陆</span><select id="v2vModBypass"' +
      (mode !== "rule" ? " disabled" : "") + ">" +
      '<option value="1"' + (cn ? " selected" : "") + ">开启（大陆直连）</option>" +
      '<option value="0"' + (!cn ? " selected" : "") + ">关闭（全部走代理）</option>" +
      "</select></label></div>" +
      '<div class="v2v-hint v2v-geo-hint"><i class="bi bi-info-circle"></i><div>' +
      (kind === "sing-box"
        ? "sing-box 内核按 <strong>.cn 域名</strong>直连；需要完整的大陆 IP / 域名分流，请切换到 Xray-core。"
        : (geoFull
            ? "已检测到 geo 数据：大陆域名 + 大陆 IP 网段双重判断，未收录的视频 CDN 也会自动直连。"
            : (st.route_assets
                ? "内核目录缺少 geo 文件，将退回按 <strong>.cn 域名</strong>直连；点右侧按钮可只下载 geo 数据（不用重下整个内核）。"
                : "未获取到 geo 数据状态（后端可能尚未重启）；点右侧按钮可直接下载 geo 数据到内核目录。"))) +
      "</div>" +
      (needGeo
        ? '<button type="button" class="v2v-btn sm v2v-geo-dl" data-act="geo-download"' +
          (v2JobBusy() ? " disabled" : "") +
          ' title="只下载 geoip.dat / geosite.dat 到内核目录，不用重下整个内核">' +
          '<i class="bi bi-cloud-arrow-down"></i>下载 geo 数据</button>'
        : "") +
      "</div></div></div>";

    h += '<div class="v2v-sec">' +
      v2vSecHead("bi-shield-lock", "始终直连", "以下地址不会被代理，避免内网访问绕远路") +
      '<div class="v2v-tip">127.0.0.0/8 · 10.0.0.0/8 · 172.16.0.0/12 · 192.168.0.0/16 · 169.254.0.0/16 · localhost</div>' +
      "</div>";

    h += '<div class="v2v-actions">' +
      '<button class="v2v-btn primary" data-act="save-route"><i class="bi bi-arrow-repeat"></i>保存并重启内核</button>' +
      '<span class="v2v-sub-note">路由规则写入内核配置，保存后会立即重启内核生效</span>' +
      "</div>";
    return h;
  }

  function v2vLog() {
    const core = V2.logTab !== "conn";
    const ctl =
      '<span class="v2v-live' + (V2.autoLog ? " on" : "") + '"><i></i>' +
      (V2.autoLog ? "实时刷新中" : "已暂停") + "</span>" +
      '<button class="v2v-btn" data-act="log-toggle"><i class="bi ' + (V2.autoLog ? "bi-pause" : "bi-play") + '"></i>' +
      (V2.autoLog ? "暂停刷新" : "自动刷新") + "</button>" +
      '<button class="v2v-btn ico" data-act="' + (core ? "log-refresh" : "connlog-refresh") + '" title="刷新"><i class="bi bi-arrow-clockwise"></i></button>' +
      '<button class="v2v-btn ico danger" data-act="log-clear" title="清空"><i class="bi bi-eraser"></i></button>';
    const tabs = '<div class="v2v-tabs" style="margin-bottom:8px">' +
      '<button class="v2v-tab' + (core ? " on" : "") + '" data-act="log-tab" data-tab="core"><i class="bi bi-journal-text"></i>内核运行日志</button>' +
      '<button class="v2v-tab' + (core ? "" : " on") + '" data-act="log-tab" data-tab="conn"><i class="bi bi-arrow-left-right"></i>节点连接记录</button>' +
      '<span class="v2v-flex"></span>' + ctl + "</div>";
    let body;
    if (core) {
      body = '<pre class="v2v-log" id="v2vLog">' + esc(V2.log || "（暂无日志）") + "</pre>" +
        '<div class="v2v-hint"><i class="bi bi-info-circle"></i><div>来自内核进程输出（data/v2ray/xray.log，Xray / sing-box 共用）。' +
        "连接失败时先看这里的报错，常见原因是节点参数不对（uuid / 密码 / sni）或服务器不可达。</div></div>";
    } else {
      body = '<pre class="v2v-log" id="v2vConnLog">' + esc(V2.connLogText || "（暂无连接记录）") + "</pre>" +
        '<div class="v2v-hint"><i class="bi bi-info-circle"></i><div>手动连接 / 自动切换 / 连通验证 / 移回收站的全过程（最新在前）：' +
        "每次手动连接、断开、自动切换链的每一步（探测异常 → 切换 → 验证），以及验证超时被自动移入回收站的节点。</div></div>";
    }
    return '<div class="v2v-sec">' + tabs + body + "</div>";
  }

  /* ---------- 连接记录渲染 ---------- */
  const CONN_KIND_TXT = { manual: "手动", disconnect: "断开", auto: "自动切换", probe: "验证", trash: "回收站", fail: "失败" };
  function v2ConnRender() {
    const el = $("v2vConnLog");
    if (!el) return;
    const evs = V2.connLog || [];
    if (!evs.length) { V2.connLogText = "（暂无连接记录）"; }
    else {
      V2.connLogText = evs.map((e) => {
        const tag = CONN_KIND_TXT[e.kind] || "信息";
        return "[" + (e.ts || "") + "][" + tag + "] " + (e.msg || "");
      }).join("\n");
    }
    el.textContent = V2.connLogText;
  }
  async function v2ConnFetch() {
    const r = await api("/api/v2ray/conn_log?lines=200");
    V2.connLog = r.events || [];
    v2ConnRender();
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
      // 只刷新当前正看着的那个 tab，省一半请求
      await (V2.logTab === "conn" ? v2ConnFetch() : v2LogFetch()).catch(() => {});
      V2.logTimer = setTimeout(tick, 2000);
    };
    tick();
  }

  /* ---------- 事件（委托：绑在 #v2View 上，随标签页创建时绑定一次） ---------- */
  function v2vBind(box) {
    if (!box || box.dataset.v2bound) return;
    box.dataset.v2bound = "1";
    box.addEventListener("click", async (e) => {
      const tb = e.target.closest(".v2v-tab[data-sec]");
      if (tb) {
        V2.sec = tb.dataset.sec;
        v2SaveView();
        if (V2.sec === "log") { v2LogFetch().catch(() => {}); v2ConnFetch().catch(() => {}); if (V2.autoLog) v2LogStart(); } else v2LogStop();
        if (V2.sec === "overview") v2TrafStart(); else v2TrafStop();
        if (V2.sec === "clients") { v2ClientsFetch().catch(() => {}); v2ClientsStart(); } else v2ClientsStop();
        if (V2.sec === "server") { v2vServerFetch().catch(() => {}); v2SrvTrafStart(); } else v2SrvTrafStop();
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
      if (!btn || btn.disabled) return;
      // 重启 / 刷新 / 保存并重启 / 本地节点启停：请求期间图标旋转并禁用，防止重复点击；
      // 连接 / 断开由 v2ToggleConnect 统一处理，两处按钮同步显示过渡态
      const slow = { restart: 1, refresh: 1, "save-route": 1,
                     "server-node-toggle": 1, "server-toggle": 1,
                     "server-auto-create": 1 };
      if (!slow[btn.dataset.act]) { v2vAction(btn.dataset.act, btn.dataset); return; }
      const oldHtml = btn.innerHTML;
      const label = (btn.textContent || "").trim();
      btn.disabled = true;
      btn.innerHTML = '<i class="v2-spin"></i>' + (label ? " " + esc(label) : "");
      try {
        await v2vAction(btn.dataset.act, btn.dataset);
      } finally {
        if (btn.isConnected) {
          btn.disabled = false;
          btn.innerHTML = oldHtml;
        }
      }
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
      if (e.target.id === "v2vSrvSec") {
        const r = $("v2vSrvReality");
        if (r) r.style.display = e.target.value === "reality" ? "" : "none";
        return;
      }
      if (e.target.id === "v2vMTls") {
        const boxR = $("v2vMReality");
        if (boxR) boxR.style.display = e.target.value === "reality" ? "" : "none";
        return;
      }
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
          fd("v2vENPin", "证书指纹 pin（可选）", n.pin, "Xray 26 自签证书：SHA256 hex，多个用逗号分隔") +
          '<div id="v2vENReality" style="display:' + (n.tls === "reality" ? "contents" : "none") + '">' +
          fd("v2vENPbk", "Reality publicKey (pbk)", n.pbk) +
          fd("v2vENSid", "Reality shortId (sid)", n.sid) +
          fd("v2vENFp", "指纹 (fp)", n.fp || "chrome", "chrome") +
          fd("v2vENSpx", "spiderX (spx)", n.spx, "/") + "</div>";
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
            data.fields.pin = g("v2vENPin");
            if (data.fields.tls === "reality") {
              data.fields.pbk = g("v2vENPbk");
              data.fields.sid = g("v2vENSid");
              data.fields.fp = g("v2vENFp");
              data.fields.spx = g("v2vENSpx");
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
      case "float-toggle": await v2FloatToggle(); break;
      case "node-tab": {
        V2.nodeTab = ds.tab || "__all__";
        V2.nodeShow = 60;   // 过滤条件变了，重置回首屏批量
        v2SaveNodesView();
        if (v2vActive()) v2vRender();
        break;
      }
      case "node-grp-new": {
        // 「+」新建自定义分组：建好直接切到该分组 tab，之后手动添加的节点都会归到这里
        const gn = (await uiPrompt("新建自定义分组", "", "例如：日常 / 流媒；之后手动添加的节点会进入该组")) || "";
        const name = gn.trim();
        if (!name) break;
        if (name.length > 40) { toast("分组名过长（最多 40 字）", "warn"); break; }
        const r = await post("/api/v2ray/groups/save", { name: name });
        if (r.error) { toast(r.error, "err"); break; }
        V2.groups = r.groups || [];
        V2.nodeTab = "grp:" + name;
        V2.nodeShow = 60;
        v2SaveNodesView();
        if (v2vActive()) v2vRender();
        toast("已新建分组「" + name + "」", "ok");
        break;
      }
      case "node-grp-del": {
        // 删除自定义分组：组内节点保留（grp 清空后回到「全部」），仅去掉这个 tab
        const gname = ds.grp || "";
        const okd = await uiConfirm("删除分组",
          "确定删除分组「" + gname + "」？组内节点不会被删除，会回到「全部」。", "删除", true);
        if (!okd) break;
        const r = await post("/api/v2ray/groups/delete", { name: gname });
        if (r.error) { toast(r.error, "err"); break; }
        V2.groups = r.groups || [];
        if (V2.nodeTab === "grp:" + gname) { V2.nodeTab = "__all__"; V2.nodeShow = 60; v2SaveNodesView(); }
        if (v2vActive()) v2vRender();
        toast("已删除分组" + (r.moved ? "，" + r.moved + " 个节点回到「全部」" : ""), "ok");
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
      case "server-auto-create": {
        const r = await post("/api/v2ray/server/nodes/create", { auto: true });
        if (r.error) return toast(r.error, "err");
        toast("节点已自动生成：" + (r.node ? r.node.name + " · 端口 " + r.node.port : ""), "ok");
        if (r.node) V2.srvCur = r.node.id;
        V2.serverQr = false;
        await v2vServerFetch();
        break;
      }
      case "server-node-select": {
        V2.srvCur = ds.id;
        V2.serverQr = false;
        V2.serverLog = "";
        v2vRender();
        v2vServerFetch().then(() => api("/api/v2ray/server/nodes/" + encodeURIComponent(ds.id) + "/log?lines=200")
          .then(r => { if (!r.error) { V2.serverLog = r.log || "（空）"; if (v2vActive() && V2.sec === "server") v2vRender(); } })).catch(() => {});
        break;
      }
      case "server-node-toggle": {
        const n = (V2.serverNodes || []).find(x => x.id === ds.id) || {};
        const r = n.running
          ? await post("/api/v2ray/server/nodes/" + encodeURIComponent(ds.id) + "/stop", {})
          : await post("/api/v2ray/server/nodes/" + encodeURIComponent(ds.id) + "/start", {});
        if (r.error) return toast(r.error, "err");
        toast(r.message || ((n.name || "节点") + (n.running ? " 已停止" : " 已启动")),
              r.pending ? "warn" : "ok");
        await Promise.all([v2vServerFetch(), v2SrvTrafficFetch()]);
        break;
      }
      case "server-node-delete": {
        const n = (V2.serverNodes || []).find(x => x.id === ds.id) || {};
        const ok = await uiConfirm("删除本地节点", "确定删除「" + (n.name || ds.id) + "」？运行中的节点会先停止。", "删除", true);
        if (!ok) return;
        const r = await post("/api/v2ray/server/nodes/" + encodeURIComponent(ds.id) + "/delete", {});
        if (r.error) return toast(r.error, "err");
        toast("节点已删除", "ok");
        if (V2.srvCur === ds.id) V2.srvCur = "";
        await v2vServerFetch();
        break;
      }
      case "server-node-copy": {
        const n = (V2.serverNodes || []).find(x => x.id === ds.id) || {};
        if (!n.share_url) return toast("该节点没有分享链接", "err");
        await copyText(n.share_url);
        toast("已复制「" + (n.name || "") + "」的分享链接", "ok");
        break;
      }
      case "server-toggle": {
        const n = (V2.serverNodes || []).find(x => x.id === V2.srvCur) || {};
        const r = n.running
          ? await post("/api/v2ray/server/nodes/" + encodeURIComponent(V2.srvCur) + "/stop", {})
          : await post("/api/v2ray/server/nodes/" + encodeURIComponent(V2.srvCur) + "/start", {});
        if (r.error) return toast(r.error, "err");
        toast(n.running ? "服务已停止" : "服务已启动", "ok");
        await v2vServerFetch();
        break;
      }
      case "server-refresh": {
        await Promise.all([v2vServerFetch(), v2SrvTrafficFetch()]);
        toast("已刷新", "ok");
        break;
      }
      case "server-traffic-refresh": {
        await v2SrvTrafficFetch();
        toast("流量数据已刷新", "ok");
        break;
      }
      case "server-traffic-reset": {
        const ok = await uiConfirm("清零流量", "确定清零该节点的流量统计？配额用量会一并归零。", "清零", true);
        if (!ok) return;
        const r = await post("/api/v2ray/server/traffic/reset", { sid: ds.id || V2.srvCur });
        if (r.error) return toast(r.error, "err");
        toast("流量已清零", "ok");
        await Promise.all([v2vServerFetch(), v2SrvTrafficFetch()]);
        break;
      }
      case "server-quota-save": {
        const r = await post("/api/v2ray/server/nodes/" + encodeURIComponent(V2.srvCur) + "/update", {
          quota_gb: val("v2vSrvQuota"), quota_action: val("v2vSrvQuotaAct"),
        });
        if (r.error) return toast(r.error, "err");
        toast("流量配额已保存", "ok");
        await Promise.all([v2vServerFetch(), v2SrvTrafficFetch()]);
        break;
      }
      case "server-save": {
        const sec = val("v2vSrvSec");
        const body = {
          name: val("v2vSrvName"), proto: val("v2vSrvProto"), port: val("v2vSrvPort"),
          outbound: val("v2vSrvOut"), uuid: val("v2vSrvUuid"), security: sec,
        };
        if (sec === "reality") {
          body.sni = val("v2vSrvSni");
          body.dest = val("v2vSrvDest");
          body.shortid = val("v2vSrvSid");
          body.flow = val("v2vSrvFlow");
          body.fp = val("v2vSrvFp");
          body.privatekey = val("v2vSrvPriv");
        }
        const r = await post("/api/v2ray/server/nodes/" + encodeURIComponent(V2.srvCur) + "/update", body);
        if (r.error) return toast(r.error, "err");
        toast("配置已保存，重启该节点后生效", "ok");
        await v2vServerFetch();
        break;
      }
      case "server-gen-keys": {
        const r = await post("/api/v2ray/server/nodes/" + encodeURIComponent(V2.srvCur) + "/gen-keys", {});
        if (r.error) return toast(r.error, "err");
        toast("密钥对已生成并保存，公钥已写入分享链接", "ok");
        await v2vServerFetch();
        break;
      }
      case "server-new-uuid": {
        const ok = await uiConfirm("更换 UUID", "换号后旧分享链接立即失效，确定继续？", "换一个", false);
        if (!ok) return;
        const r = await post("/api/v2ray/server/nodes/" + encodeURIComponent(V2.srvCur) + "/new-uuid", {});
        if (r.error) return toast(r.error, "err");
        toast("UUID 已更换", "ok");
        V2.serverQr = false;
        await v2vServerFetch();
        break;
      }
      case "server-copy": {
        const n = (V2.serverNodes || []).find(x => x.id === V2.srvCur) || {};
        if (!n.share_url) return toast("还没有分享链接", "err");
        await copyText(n.share_url);
        toast("分享链接已复制", "ok");
        break;
      }
      case "server-qr": {
        V2.serverQr = !V2.serverQr;
        v2vRender();
        break;
      }
      case "server-preview": {
        const r = await api("/api/v2ray/server/preview?id=" + encodeURIComponent(V2.srvCur));
        if (r.error) return toast(r.error, "err");
        await uiModal({ title: "服务端配置预览", icon: "bi-code-square",
          html: '<pre class="v2v-log">' + esc(JSON.stringify(r.config, null, 2)) + "</pre>",
          okText: "关闭", hideCancel: true, wide: true });
        break;
      }
      case "server-log-refresh": {
        const r = await api("/api/v2ray/server/nodes/" + encodeURIComponent(V2.srvCur) + "/log?lines=200");
        if (r.error) return toast(r.error, "err");
        V2.serverLog = r.log || "（空）";
        v2vRender();
        break;
      }
      case "server-log-clear": {
        const ok = await uiConfirm("清空日志", "确定清空该节点运行日志？", "清空", true);
        if (!ok) return;
        const r = await post("/api/v2ray/server/nodes/" + encodeURIComponent(V2.srvCur) + "/log/clear", {});
        if (r.error) return toast(r.error, "err");
        V2.serverLog = "";
        v2vRender();
        toast("日志已清空", "ok");
        break;
      }
      case "nodes-more": {
        const box = $("v2View");
        v2MoreNodes(box && box.querySelector(".v2v-node-list"));
        break;
      }
      case "auto-fail": {
        // 开关交给后端看门狗：前端只发状态，后端落库并启动/停止后台守护线程
        const next = !v2FailOn();
        const r = await post("/api/v2ray/auto-failover", { on: next });
        if (r.error) { toast(r.error, "err"); break; }
        // 后端返回完整 status（含最新 settings）：同步进本地缓存，按钮 on 态立即切换
        if (r.settings) V2.st = r;
        toast(next ? "已开启节点失效自动切换（后端后台守护，关掉网页也生效）" : "已关闭节点失效自动切换", next ? "ok" : "info");
        if (v2vActive()) v2vRender();
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
        const r = await post("/api/v2ray/nodes/add", Object.assign({ links: links }, v2AddTarget()));
        if (r.error) return toast(r.error, "err");
        toast("已添加 " + r.added + " 个节点" + (r.errors && r.errors.length ? "（" + r.errors.length + " 条被跳过）" : ""), "ok");
        await v2Reload();
        break;
      }
      case "node-import":
        V2.nodeForm = !V2.nodeForm;
        if (!V2.nodeForm) V2.showManual = false;   // 收起面板时连带收起手填表单
        v2vRender();
        break;
      case "toggle-manual":
        V2.nodeForm = true;                    // 手填表单一定在导入面板里
        V2.showManual = !V2.showManual;
        v2vRender();
        break;
      case "add-manual": {
        const node = {
          proto: val("v2vMProto"), name: val("v2vMName"), server: val("v2vMServer"), port: val("v2vMPort"),
          uuid: val("v2vMUuid"), password: val("v2vMUuid"), method: val("v2vMMethod"),
          net: val("v2vMNet"), tls: val("v2vMTls"), host: val("v2vMHost"), path: val("v2vMPath"),
          sni: val("v2vMSni"), aid: val("v2vMAid"), flow: val("v2vMFlow"), pin: val("v2vMPin"),
          pbk: val("v2vMPbk"), sid: val("v2vMSid"), spx: val("v2vMSpx"), fp: val("v2vMFp"),
        };
        const r = await post("/api/v2ray/nodes/add", Object.assign({ node: node }, v2AddTarget()));
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
        v2PingRefresh(ds.id);            // 服务端正在实测该节点延迟，稍后补拉更新
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
        toast("可用性测试中…（会临时切到该节点实测出网，几秒钟）", "info");
        const pr = await post("/api/v2ray/ping", { id: ds.id, real: true });
        V2.ping[ds.id] = pr;                    // {ok,ms} 或 {ok:false}，不可用即按超时处理
        if (v2vActive()) v2vRender();
        v2SideRender();
        toast(pr.error ? ("节点不可用：" + pr.error)
          : ("可用，真延迟 " + pr.ms + " ms"), pr.error ? "err" : "ok");
        break;
      }
      case "dl-all": {
        if (V2.dlProg || V2.pingProg) break;    // 已在进行中，防止重复触发
        // 只测当前列表（当前 tab + 搜索过滤）里「延迟可用」的节点
        const dlIds = v2NodeFilteredList({ hideFail: false })
          .filter(n => V2.ping[n.id] && V2.ping[n.id].ok).map(n => n.id);
        if (!dlIds.length) { toast("当前列表没有「测速可用」的节点，请先全部测速", "warn"); break; }
        V2.dlProg = { done: 0, total: dlIds.length };
        if (v2vActive()) v2vRender();
        toast("下载测速中：并发实测 " + dlIds.length + " 个可用节点（每个起临时内核，较耗时）", "info");
        // 有限并发：原来逐个 await，每个节点都要等临时内核启动 + 下载；
        // 现在 3 路同时在飞，接口与每个节点的测速结果都不变。
        let dlCursor = 0;
        const DL_PARALLEL = Math.min(3, dlIds.length);
        const dlWorker = async () => {
          while (dlCursor < dlIds.length) {
            const nid = dlIds[dlCursor++];
            const r = await post("/api/v2ray/dl-temp", { id: nid }).catch(() => null);
            if (r && r.ok) V2.dl[nid] = r.mbps;
            if (V2.dlProg) V2.dlProg.done++;
            if (v2vActive()) v2vRender();
            v2SideRender();
          }
        };
        await Promise.all(Array.from({ length: DL_PARALLEL }, dlWorker));
        V2.dlProg = null;
        if (v2vActive()) v2vRender();
        v2SideRender();
        toast("下载测速完成", "ok");
        break;
      }
      case "ping-all": {
        if (V2.pingProg) break;                 // 已在进行中，防止重复触发
        // 只测当前列表（当前 tab + 搜索过滤）下的节点；忽略「隐藏超时」，
        // 否则开了隐藏超时后超时节点永远没机会重测
        const ids = v2NodeFilteredList({ hideFail: false }).map(n => n.id);
        if (!ids.length) { toast("当前列表没有节点", "warn"); break; }
        V2.pingProg = { done: 0, total: ids.length };
        if (v2vActive()) v2vRender();
        // 分批走后端并发测速（每批 100、后端内部 8 线程）；原来一批测完才发下一批，
        // 现在最多 3 批同时在飞，接口、探测方式与每个节点的结果都不变，
        // 每批仍只重绘一次，避免大列表上千次 HTTP 请求 + 频繁全量重绘。
        const CHUNK = 100;
        const batches = [];
        for (let i = 0; i < ids.length; i += CHUNK) batches.push(ids.slice(i, i + CHUNK));
        let batchCursor = 0;
        const PARALLEL = Math.min(3, batches.length);
        const batchWorker = async () => {
          while (batchCursor < batches.length) {
            const batch = batches[batchCursor++];
            const r = await post("/api/v2ray/ping-batch", { ids: batch, real: true }).catch(() => null);
            const res = (r && r.results) || {};
            for (const k of Object.keys(res)) V2.ping[k] = res[k];
            if (V2.pingProg) V2.pingProg.done += batch.length;
            if (v2vActive()) v2vRender();
            v2SideRender();
          }
        };
        await Promise.all(Array.from({ length: PARALLEL }, batchWorker));
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
        const ok = await uiConfirm("删除节点", "确定删除「" + ((n && n.name) || ds.id) +
          "」？删除后进入回收站，可随时恢复。", "删除", true);
        if (!ok) return;
        const r = await post("/api/v2ray/nodes/delete", { ids: [ds.id] });
        if (r.error) return toast(r.error, "err");
        toast("已删除（可在回收站恢复）", "ok");
        v2TrashFetch().catch(() => {});
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
          "确定删除 " + ids.length + " 个测速超时的节点？删除后进入回收站，可随时恢复。", "删除", true);
        if (!ok) break;
        const r = await post("/api/v2ray/nodes/delete", { ids: ids });
        if (r.error) return toast(r.error, "err");
        toast("已删除 " + ids.length + " 个超时节点（可在回收站恢复）", "ok");
        v2TrashFetch().catch(() => {});
        await v2Reload();
        break;
      }

      /* -------- 回收站 -------- */
      case "trash": {
        V2.trashOpen = !V2.trashOpen;
        if (V2.trashOpen) v2TrashFetch().catch(() => {});
        v2vRender();
        break;
      }
      case "trash-restore": {
        const r = await post("/api/v2ray/nodes/restore", { ids: [ds.id] });
        if (r.error) return toast(r.error, "err");
        toast("已恢复 " + (r.restored || 0) + " 个节点", "ok");
        v2TrashFetch().catch(() => {});
        await v2Reload();
        break;
      }
      case "trash-purge": {
        const ok = await uiConfirm("彻底删除",
          "从数据库彻底删除该节点？此操作不可恢复。", "彻底删除", true);
        if (!ok) break;
        const r = await post("/api/v2ray/nodes/purge", { ids: [ds.id] });
        if (r.error) return toast(r.error, "err");
        toast("已彻底删除", "ok");
        v2TrashFetch().catch(() => {});
        break;
      }
      case "trash-clear": {
        const ok = await uiConfirm("清空回收站",
          "彻底删除回收站里的全部节点？此操作不可恢复。", "清空", true);
        if (!ok) break;
        const r = await post("/api/v2ray/nodes/purge", {});
        if (r.error) return toast(r.error, "err");
        toast("已清空回收站（" + (r.deleted || 0) + " 个）", "ok");
        V2.trash = []; V2.trashN = 0;
        v2vRender();
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
        V2.subForm = false;              // 保存后收起表单，回到列表
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
      case "new-sub":
        if (V2.subForm && !V2.selSub) break;      // 已经在新建，别把输入清掉
        V2.subForm = true;
        V2.selSub = null;
        v2vRender();
        break;
      case "cancel-sub": V2.subForm = false; V2.selSub = null; v2vRender(); break;
      case "edit-sub":
        V2.selSub = V2.subs.find(s => s.id === ds.id) || null;
        V2.subForm = true;
        v2vRender();
        break;
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
        if (V2.selSub && V2.selSub.id === ds.id) { V2.selSub = null; V2.subForm = false; }
        toast("已删除", "ok");
        await v2Reload();
        break;
      }

      /* -------- 设置 / 内核 -------- */
      case "core-kind": {
        const k = ds.kind === "sing-box" ? "sing-box" : "xray";
        const prev = v2CoreKind();
        if (k === prev) break;
        const wasOpen = !!V2.vers;          // 版本面板开着就跟着切到新类型重新拉
        // 整页重绘：内核列表 / 下载按钮 / 路径 / 版本面板一次全切到位，
        // 不用等版本信息回来才更新；其它输入框的内容先快照再回填
        const cur = $("v2vSetCore");
        if (cur) V2.pathDraft[prev] = cur.value;
        V2.coreKind = k;
        V2.vers = null;
        v2vRenderKeep(["v2vSetCore"]);
        if (wasOpen) {
          V2.versBusy = true;
          v2VersLoad(k).catch(() => {}).then(() => {
            V2.versBusy = false;
            v2vRenderKeep(["v2vSetCore"]);
          });
        }
        break;
      }
      case "detect-core":
        // 只探测当前 Tab 选的那类内核，避免日志里混进另一类内核的路径
        v2JobRun("detect", "/api/v2ray/core/detect", { kind: v2CoreKind() });
        break;
      case "prog-close": {
        clearTimeout(V2.progTimer);
        V2.job = null;
        V2.instVer = "";
        v2ProgPaint();
        if (v2vActive()) v2vRender();
        break;
      }
      case "core-use": {
        const kind = v2CoreKind();
        const r = await post("/api/v2ray/core/path", { path: ds.path || "", kind: kind });
        if (r.error) return toast(r.error, "err");
        delete V2.pathDraft[kind];          // 后端已写好该类型的路径，让输入框显示新值
        toast("已切换到 " + (ds.path || ""), "ok");
        await v2Reload();
        if ((V2.st || {}).running) {
          const ok = await uiConfirm("重启内核", "当前内核正在运行，重启后才会用新内核加载配置。", "重启", false);
          if (ok) await post("/api/v2ray/restart");
          await v2Reload();
        }
        break;
      }
      case "download-core": {
        V2.pendingUrl = val("v2vSetCoreUrl");
        v2JobRun("download", "/api/v2ray/core/download",
                 { url: V2.pendingUrl, kind: v2CoreKind() });
        break;
      }
      case "ver-hide": V2.vers = null; if (v2vActive()) v2vRender(); break;
      case "ver-list": {
        // 开关：再点收起；拉取期间按钮禁用转圈（防止重复请求）
        if (V2.versBusy) break;
        if (V2.vers) {
          V2.vers = null;
          if (v2vActive()) v2vRender();
          break;
        }
        V2.versBusy = true;
        if (v2vActive()) v2vRender();
        try {
          const rv = await v2VersLoad(v2CoreKind());
          if (rv && rv.error) toast(rv.error, "err");
        } finally {
          V2.versBusy = false;
          if (v2vActive()) v2vRender();
        }
        break;
      }
      case "ver-install": {
        if (v2JobBusy()) return toast("已有任务在进行中，请稍候", "warn");
        V2.instVer = ds.ver || "";          // 让被点的那一行显示「安装中…」
        // 就地禁用所有「安装」，被点的那行换成转圈文案：
        // 不能先重绘再启动任务（那时 busy 还是 false，按钮会留成可点状态）
        document.querySelectorAll('#v2View [data-act="ver-install"]').forEach(b => {
          b.disabled = true;
          if (b.dataset.ver === V2.instVer) {
            b.innerHTML = '<i class="bi bi-arrow-repeat spin"></i>安装中…';
          }
        });
        v2JobRun("download", "/api/v2ray/core/install-version",
                 { version: ds.ver, kind: ds.kind || v2CoreKind() });
        break;
      }
      case "ver-use": {
        const kind = ds.kind || v2CoreKind();
        const ru = await post("/api/v2ray/core/use-version", { version: ds.ver, kind: kind });
        if (ru.error) return toast(ru.error, "err");
        toast("已切换到 " + (ru.version || ds.ver) + (ru.restarted ? "，内核已自动重启" : ""), "ok");
        await v2Reload().catch(() => {});
        await v2VersLoad(kind).catch(() => {});
        break;
      }
      case "save-settings": {
        const body = {
          core_path: val("v2vSetCore"), core_url: val("v2vSetCoreUrl"),
          core_kind: v2CoreKind(),
          socks_port: val("v2vSetPort"), socks_listen: val("v2vSetListen"),
          http_port: val("v2vSetHttp"), api_port: val("v2vSetApi"), log_level: val("v2vSetLog"),
          socks_user: val("v2vSetUser"), sub_proxy: val("v2vSetSubProxy"),
          auto_start: val("v2vSetAuto") === "1" ? 1 : 0,
          auth_enabled: val("v2vSetAuth") === "0" ? 0 : 1,
          shared_core: val("v2vSetShared") === "0" ? 0 : 1,
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
      /* -------- 路由分流：路由模式 / 大陆分流 -------- */
      case "route-mode": {
        const m = ds.mode;
        if (["global", "rule", "direct"].indexOf(m) < 0) return;
        if (V2.st && V2.st.settings) V2.st.settings.route_mode = m;
        document.querySelectorAll('#v2View [data-act="route-mode"]').forEach(b =>
          b.classList.toggle("on", b.dataset.mode === m));
        const sel = $("v2vModBypass");
        if (sel) sel.disabled = m !== "rule";
        const tip = $("v2vRouteTip");
        const tips = {
          global: "除本机 / 局域网外，所有流量都走代理节点",
          rule: "大陆直连，其余流量走代理（推荐）",
          direct: "所有流量直连；代理入口保留，便于随时切回",
        };
        if (tip) tip.textContent = tips[m] || "";
        break;
      }
      case "save-route": {
        const m = (V2.st && V2.st.settings && V2.st.settings.route_mode) || "rule";
        const cn = val("v2vModBypass") === "1" ? 1 : 0;
        const r = await post("/api/v2ray/settings", { route_mode: m, bypass_cn: cn });
        if (r.error) return toast(r.error, "err");
        // 先只更新本地状态，不整页重绘：让按钮的旋转 / 禁用一直持续到重启结束
        if (V2.st && V2.st.settings) {
          V2.st.settings.route_mode = m;
          V2.st.settings.bypass_cn = cn;
        }
        if (!(V2.st && V2.st.running)) {
          await v2Reload();
          return toast("路由设置已保存，连接节点后生效", "ok");
        }
        // 路由规则写在生成的内核配置里：内核在跑就顺手重启，避免「保存了但没生效」
        toast("路由设置已保存，正在重启内核…", "info");
        const rr = await post("/api/v2ray/restart");
        if (rr && rr.error) {
          await v2Reload();
          return toast("设置已保存，但重启失败：" + rr.error, "err");
        }
        await v2Reload();
        toast("路由设置已生效：" + v2ModeName(m) +
              (m === "rule" && cn ? " · 大陆直连" : ""), "ok");
        break;
      }
      case "geo-download": {
        if (v2JobBusy()) return toast("已有任务在进行中，请稍候", "warn");
        v2JobRun("geo", "/api/v2ray/geo/download");
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
      case "log-tab": {
        V2.logTab = ds.tab === "conn" ? "conn" : "core";
        v2vRender();
        await (V2.logTab === "conn" ? v2ConnFetch() : v2LogFetch()).catch(() => {});
        if (V2.logTab === "conn") v2ConnRender();
        break;
      }
      case "log-refresh": await v2LogFetch(); break;
      case "connlog-refresh": await v2ConnFetch(); v2ConnRender(); break;
      case "usage-clear": {
        const ok = await uiConfirm("清空使用统计", "确定清空所有客户端的使用统计？流量 / 时长 / 时间记录都会归零。", "清空", true);
        if (!ok) return;
        await post("/api/v2ray/client_usage/clear");
        V2.usage = [];
        v2vRender();
        break;
      }
      case "log-clear": {
        const conn = V2.logTab === "conn";
        const ok = await uiConfirm("清空" + (conn ? "连接记录" : "日志"),
          conn ? "确定清空全部节点连接记录？" : "确定清空内核运行日志？", "清空", true);
        if (!ok) return;
        if (conn) {
          await post("/api/v2ray/conn_log/clear");
          V2.connLog = [];
          v2ConnRender();
        } else {
          await post("/api/v2ray/log/clear");
          V2.log = "";
          await v2LogFetch();
        }
        break;
      }
      default: break;
    }
  }

  // 供其他模块（如设置页的模块入口）直接打开管理页
  window.v2rayOpenView = v2OpenView;
})();

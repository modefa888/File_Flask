/* ============================================================================
 * 代理页：V2Ray / Xray 状态、连接 / 断开、节点快选、测速、代理地址复制、设置
 * 后端接口：app/routes/ide/v2ray.py（/api/v2ray/*）
 * ========================================================================== */

const P = {
  st: null,          // /api/v2ray/status
  traffic: null,     // /api/v2ray/traffic
  nodes: [],         // /api/v2ray/nodes
  metrics: {},       // 节点测速台账 {id: {ping, dl}}
  busy: "",          // "" / "start" / "stop"
  loading: false,
  shareOpen: false,
  pingBusy: false,
  lastAt: 0,
  nodesAt: 0,        // 节点列表上次拉取时间（轮询时不必每次都查库）
};

function proxyProtoIcon(p) {
  return ({
    vmess: "bi-shield-lock",
    vless: "bi-shield-check",
    trojan: "bi-fire",
    ss: "bi-record-circle",
    socks: "bi-diagram-3",
  })[String(p || "").toLowerCase()] || "bi-hdd-network";
}
function proxyProtoCls(p) { return "p-" + String(p || "x").toLowerCase(); }

function proxyPingOf(id) {
  const m = P.metrics[id];
  if (!m || typeof m.ping !== "number") return null;
  return m.ping;
}
function proxyPingCls(ms) {
  if (ms === null || ms === undefined) return "";
  if (ms < 0) return "bad";
  if (ms < 200) return "good";
  if (ms < 500) return "mid";
  if (ms < 1000) return "slow";
  return "bad";
}
function proxyRunning() { return !!(P.st && P.st.running); }
function proxyCurNodeId() {
  return (P.st && P.st.node && P.st.node.id) || "";
}
function proxyPickId() {
  if (proxyRunning()) return proxyCurNodeId();
  const s = (P.st && P.st.settings) || {};
  if (s.active_node && P.nodes.some(function (n) { return n.id === s.active_node; })) {
    return s.active_node;
  }
  return (P.nodes[0] || {}).id || "";
}
function proxyNodeById(id) {
  return P.nodes.filter(function (n) { return n.id === id; })[0] || null;
}

/* ==================================================================
   数据加载
   ================================================================== */
async function proxyLoad(silent) {
  if (P.loading) return;
  P.loading = true;
  // 节点 / 测速台账变化不频繁，轮询时 20 秒才拉一次；状态与实时网速每轮都拉
  const needNodes = !P.nodesAt || Date.now() - P.nodesAt > 20000;
  const res = await Promise.all([
    apiGet("/api/v2ray/status"),
    needNodes ? apiGet("/api/v2ray/nodes") : Promise.resolve(null),
    apiGet("/api/v2ray/traffic"),
  ]);
  P.loading = false;
  P.lastAt = Date.now();
  const st = res[0], nd = res[1], tf = res[2];
  if (st && !st.error) P.st = st;
  if (nd && !nd.error) {
    P.nodes = nd.nodes || [];
    P.metrics = nd.metrics || {};
    P.nodesAt = Date.now();
  }
  if (tf && !tf.error) P.traffic = tf;
  proxyPaint();
  if (!silent && st && st.error) toast("读取代理状态失败：" + st.error, "err");
}

/* ==================================================================
   绘制
   ================================================================== */
function proxyPaint() {
  proxyPaintHero();
  proxyPaintShare();
  proxyPaintNodes();
  proxyPaintTabDot();
}

function proxyPaintHero() {
  const st = P.st || {};
  const running = !!st.running;
  const busy = !!P.busy;
  const hero = $("proxyHero");
  hero.classList.toggle("on", running && !busy);

  const state = $("p2State");
  const nodeTx = $("p2Node");
  const btn = $("p2Toggle");

  if (busy) {
    state.textContent = P.busy === "start" ? "正在启动内核…" : "正在断开…";
    state.className = "hero-t busy";
    btn.className = "btn hero-btn busy";
    btn.disabled = true;
    btn.innerHTML = '<i class="bi bi-arrow-repeat"></i><span>' +
      (P.busy === "start" ? "启动中" : "停止中") + "</span>";
  } else {
    state.className = "hero-t";
    state.textContent = running ? "运行中" : "未运行";
    btn.disabled = false;
    btn.className = "btn hero-btn" + (running ? " danger" : "");
    btn.innerHTML = running
      ? '<i class="bi bi-stop-fill"></i><span>断开</span>'
      : '<i class="bi bi-play-fill"></i><span>连接</span>';
  }

  if (nodeTx) {
    if (running && st.node) {
      const inb = st.inbound || {};
      nodeTx.textContent = (st.node.name || "已连接") + " · " +
        (inb.listen || "0.0.0.0") + ":" + (inb.socks_port || 10808);
    } else if (P.nodes.length) {
      const pick = proxyNodeById(proxyPickId());
      nodeTx.textContent = pick
        ? "待连接：" + (pick.name || pick.server || "未命名节点")
        : "尚未选择节点";
    } else {
      nodeTx.textContent = "还没有节点，请先在桌面版添加订阅";
    }
  }

  const tf = P.traffic || {};
  const sp = tf.speed || {};
  $("p2Speed").textContent = "↑" + fmtSpeedTight(sp.up) + " ↓" + fmtSpeedTight(sp.down);

  const today = st.today || {};
  $("p2Today").textContent = "↑" + fmtBytesTight(today.up) + " ↓" + fmtBytesTight(today.down);

  const core = st.core || {};
  $("p2Core").textContent = core.ok ? (core.version || "已就绪") : "未找到内核";
  $("p2Core").title = core.path || "";
}

function proxyPaintShare() {
  const box = $("p2Share");
  const more = $("p2ShareMore");
  if (!box) return;
  const st = P.st || {};
  const list = (st.running && Array.isArray(st.share)) ? st.share : [];
  if (!list.length) {
    box.innerHTML = '<div class="share-empty">连接节点后显示可共享的 SOCKS5 / HTTP 地址</div>';
    if (more) more.hidden = true;
    return;
  }
  const shown = P.shareOpen ? list : list.slice(0, 1);
  box.innerHTML = shown.map(function (s) {
    return '<div class="share-row">' +
      '<span class="share-tag">' + esc(s.label || "代理") + "</span>" +
      '<span class="share-url" title="' + esc(s.url || "") + '">' + esc(s.url || "") + "</span>" +
      '<button class="share-cp" type="button" data-copy="' + esc(s.url || "") + '" title="复制">' +
      '<i class="bi bi-clipboard"></i></button>' +
      "</div>";
  }).join("");
  if (more) {
    more.hidden = list.length <= 1;
    more.textContent = P.shareOpen ? "收起地址" : "共 " + list.length + " 个地址";
  }
}

function proxyVisibleNodes() {
  const input = $("p2Search");
  const q = (input && input.value || "").trim().toLowerCase();
  let arr = P.nodes.filter(function (n) {
    if (!q) return true;
    return String(n.name || "").toLowerCase().indexOf(q) >= 0 ||
      String(n.server || "").toLowerCase().indexOf(q) >= 0 ||
      String(n.proto || "").toLowerCase().indexOf(q) >= 0;
  });
  const cur = proxyCurNodeId();
  arr = arr.slice().sort(function (a, b) {
    if (a.id === cur) return -1;
    if (b.id === cur) return 1;
    const pa = proxyPingOf(a.id), pb = proxyPingOf(b.id);
    const va = (pa === null || pa < 0) ? 9e9 : pa;
    const vb = (pb === null || pb < 0) ? 9e9 : pb;
    return va - vb;
  });
  return arr;
}

function proxyPaintNodes() {
  const list = $("p2Nodes");
  if (!list) return;
  $("p2NodeNum").textContent = String(P.nodes.length);

  const searchRow = $("p2SearchRow");
  if (searchRow) searchRow.hidden = P.nodes.length <= 6;

  if (!P.nodes.length) {
    list.innerHTML = '<div class="empty-box"><i class="bi bi-inbox"></i>' +
      "<b>还没有可用节点</b>" +
      "<span>请在桌面版「V2Ray 代理 → 订阅 / 节点」里添加订阅链接或节点，<br>回到这里点右上角刷新即可看到。</span></div>";
    return;
  }

  const arr = proxyVisibleNodes();
  if (!arr.length) {
    list.innerHTML = '<div class="empty-box"><i class="bi bi-search"></i>' +
      "<b>没有匹配的节点</b><span>换个关键字试试</span></div>";
    return;
  }

  const cur = proxyCurNodeId();
  const pingBtn = $("p2PingAll");
  if (pingBtn) {
    pingBtn.disabled = P.pingBusy;
    pingBtn.innerHTML = P.pingBusy
      ? '<i class="bi bi-arrow-repeat"></i>测速中'
      : '<i class="bi bi-speedometer2"></i>测速';
  }

  list.innerHTML = arr.map(function (n) {
    const ms = proxyPingOf(n.id);
    const live = n.id === cur;
    const pingHtml = ms === null ? "" :
      (ms < 0
        ? '<span class="tag ping bad">超时</span>'
        : '<span class="tag ping ' + proxyPingCls(ms) + '">' + ms + "ms</span>");
    return '<div class="node' + (live ? " on" : "") + '" data-node="' + esc(n.id) + '">' +
      '<div class="node-ic ' + proxyProtoCls(n.proto) + '"><i class="bi ' + proxyProtoIcon(n.proto) + '"></i></div>' +
      '<div class="node-tx">' +
      '<div class="node-name">' + esc(n.name || "(未命名节点)") + "</div>" +
      '<div class="node-sub">' + esc(n.proto || "node") + " · " +
      esc(n.server || "") + ":" + esc(n.port || "") + "</div></div>" +
      '<div class="node-right">' +
      (live ? '<span class="tag live">已连接</span>' : "") + pingHtml +
      '<i class="bi bi-chevron-right"></i></div></div>';
  }).join("");
}

function proxyPaintTabDot() {
  const dot = $("tabProxyDot");
  if (dot) dot.classList.toggle("on", proxyRunning() && !P.busy);
}

/* ==================================================================
   连接 / 断开
   ================================================================== */
async function proxyToggle() {
  if (P.busy) return toast("正在处理，请稍候", "warn");
  if (proxyRunning()) {
    const ok = await uiConfirm("断开当前代理连接？已连接的设备将无法继续通过本机代理上网。",
      { title: "断开代理", okText: "断开" });
    if (!ok) return;
    P.busy = "stop";
    proxyPaintHero();
    const r = await apiPost("/api/v2ray/disconnect", {});
    P.busy = "";
    if (r.error) toast("断开失败：" + r.error, "err");
    else toast("已断开代理", "ok");
    proxyPaintHero();
    proxyPaintTabDot();
    proxyLoad(true);
    return;
  }
  const id = proxyPickId();
  if (!id) return toast("还没有节点，请先在桌面版添加订阅或节点", "warn");
  await proxyConnect(id);
}

async function proxyConnect(id) {
  if (P.busy) return toast("正在处理，请稍候", "warn");
  const node = proxyNodeById(id);
  P.busy = "start";
  proxyPaintHero();
  const r = await apiPost("/api/v2ray/connect", { id: id });
  P.busy = "";
  if (r.error) {
    toast("连接失败：" + r.error, "err");
  } else {
    toast("已连接" + (node && node.name ? "：" + node.name : ""), "ok");
  }
  proxyPaintHero();
  proxyPaintTabDot();
  await proxyLoad(true);
}

/* ==================================================================
   节点操作弹层
   ================================================================== */
function proxyNodeSheet(id) {
  const n = proxyNodeById(id);
  if (!n) return toast("节点不存在", "err");
  const ms = proxyPingOf(id);
  const live = id === proxyCurNodeId();
  const rows = [
    ["协议", n.proto || "—"],
    ["地址", (n.server || "—") + ":" + (n.port || "")],
    ["延迟", ms === null ? "未测速" : (ms < 0 ? "超时 / 不可用" : ms + " ms")],
  ];
  if (n.remark) rows.push(["备注", n.remark]);
  if (n.grp) rows.push(["分组", n.grp]);
  const html =
    '<div class="info-list">' + rows.map(function (r) {
      return '<div class="info-row"><span class="ik">' + esc(r[0]) + '</span>' +
        '<span class="iv">' + esc(r[1]) + "</span></div>";
    }).join("") + "</div>" +
    '<div class="sheet-actions">' +
    '<button class="btn primary block" data-act="connect">' +
    '<i class="bi bi-lightning-charge-fill"></i>' + (live ? "重新连接" : "连接此节点") + "</button>" +
    '<div class="sheet-grid">' +
    '<button class="btn ghost" data-act="ping"><i class="bi bi-speedometer2"></i>测速</button>' +
    '<button class="btn ghost" data-act="copy"><i class="bi bi-clipboard"></i>复制链接</button>' +
    "</div></div>";

  openSheet(n.name || "节点详情", html, async function (act, el) {
    if (act === "connect") {
      closeSheet();
      await proxyConnect(id);
    } else if (act === "ping") {
      el.disabled = true;
      el.innerHTML = '<i class="bi bi-arrow-repeat"></i>测速中…';
      const r = await apiPost("/api/v2ray/ping", { id: id });
      if (r.error) toast("测速失败：" + r.error, "err");
      else if (r.ok) {
        P.metrics[id] = Object.assign({}, P.metrics[id] || {}, { ping: r.ms });
        toast("延迟 " + r.ms + " ms", "ok");
      } else {
        P.metrics[id] = Object.assign({}, P.metrics[id] || {}, { ping: -1 });
        toast(r.error || "节点不可用", "err");
      }
      proxyPaintNodes();
      if (sheetVisible()) proxyNodeSheet(id);
    } else if (act === "copy") {
      const r = await apiPost("/api/v2ray/share-link", { id: id });
      if (r.error) toast("获取链接失败：" + r.error, "err");
      else copyText(r.link);
    }
  });
}

/* ==================================================================
   批量测速
   ================================================================== */
async function proxyPingAll() {
  if (P.pingBusy) return;
  const ids = proxyVisibleNodes().slice(0, 200).map(function (n) { return n.id; });
  if (!ids.length) return toast("没有可测速的节点", "warn");
  P.pingBusy = true;
  proxyPaintNodes();
  const r = await apiPost("/api/v2ray/ping-batch", { ids: ids });
  P.pingBusy = false;
  if (r.error) {
    toast("测速失败：" + r.error, "err");
    proxyPaintNodes();
    return;
  }
  const results = r.results || {};
  Object.keys(results).forEach(function (id) {
    const x = results[id] || {};
    P.metrics[id] = Object.assign({}, P.metrics[id] || {},
      { ping: x.ok ? Number(x.ms) : -1 });
  });
  const okN = Object.keys(results).filter(function (k) { return results[k] && results[k].ok; }).length;
  toast("测速完成：" + okN + " / " + ids.length + " 个可用", "ok");
  proxyPaintNodes();
}

/* ==================================================================
   代理设置（路由模式 / 自动切换）
   ================================================================== */
function proxySettingsSheet() {
  const s = (P.st && P.st.settings) || {};
  const mode = s.route_mode || "rule";
  const failover = String(s.auto_failover == null ? 1 : s.auto_failover) !== "0";
  const html =
    '<div class="fld"><label>路由模式</label>' +
    '<div class="seg small" id="p2Mode">' +
    '<button type="button" data-mode="rule" class="' + (mode === "rule" ? "on" : "") + '">智能分流</button>' +
    '<button type="button" data-mode="global" class="' + (mode === "global" ? "on" : "") + '">全局代理</button>' +
    '<button type="button" data-mode="direct" class="' + (mode === "direct" ? "on" : "") + '">全局直连</button>' +
    "</div>" +
    '<div class="hint" style="margin-top:7px">智能分流：国内地址直连，国外走代理；切换后内核会自动重启。</div></div>' +
    '<div class="switch-row">' +
    '<div><b>节点失效自动切换</b><span class="hint">当前节点不可用时自动换一个可用节点</span></div>' +
    '<label class="switch"><input type="checkbox" id="p2Failover"' + (failover ? " checked" : "") + "><i></i></label></div>" +
    '<button class="btn primary block" data-act="save" style="margin-top:16px">保存设置</button>';

  openSheet("代理设置", html, async function (act, el) {
    if (act !== "save") return;
    const picked = document.querySelector("#p2Mode button.on");
    const newMode = picked ? picked.getAttribute("data-mode") : mode;
    el.disabled = true;
    el.innerHTML = '<i class="bi bi-arrow-repeat"></i>保存中…';
    const r = await apiPost("/api/v2ray/settings", {
      route_mode: newMode,
      bypass_cn: newMode === "rule" ? 1 : 0,
    });
    if (r.error) {
      el.disabled = false;
      el.innerHTML = "保存设置";
      return toast("保存失败：" + r.error, "err");
    }
    await apiPost("/api/v2ray/auto-failover", { on: !!($("p2Failover") && $("p2Failover").checked) });
    if (proxyRunning() && newMode !== mode) {
      const rr = await apiPost("/api/v2ray/restart", {});
      if (rr.error) toast("已保存，但重启内核失败：" + rr.error, "err");
      else toast("设置已保存，内核已重启", "ok");
    } else {
      toast("设置已保存", "ok");
    }
    closeSheet();
    proxyLoad(true);
  });

  // 模式切换：单选高亮（保存时才提交）
  const modeBox = $("p2Mode");
  if (modeBox) {
    modeBox.addEventListener("click", function (e) {
      const b = e.target.closest("button[data-mode]");
      if (!b) return;
      modeBox.querySelectorAll("button").forEach(function (x) { x.classList.remove("on"); });
      b.classList.add("on");
    });
  }
}

/* ==================================================================
   事件绑定
   ================================================================== */
$("p2Toggle").addEventListener("click", proxyToggle);

$("p2Nodes").addEventListener("click", function (e) {
  const row = e.target.closest(".node[data-node]");
  if (row) proxyNodeSheet(row.getAttribute("data-node"));
});

$("p2Share").addEventListener("click", function (e) {
  const b = e.target.closest("[data-copy]");
  if (b) copyText(b.getAttribute("data-copy"));
});

$("p2ShareMore").addEventListener("click", function () {
  P.shareOpen = !P.shareOpen;
  proxyPaintShare();
});

$("p2PingAll").addEventListener("click", proxyPingAll);
$("p2SetBtn").addEventListener("click", proxySettingsSheet);

$("p2Search").addEventListener("input", function () {
  $("p2SearchClear").hidden = !$("p2Search").value;
  proxyPaintNodes();
});
$("p2SearchClear").addEventListener("click", function () {
  $("p2Search").value = "";
  $("p2SearchClear").hidden = true;
  proxyPaintNodes();
});

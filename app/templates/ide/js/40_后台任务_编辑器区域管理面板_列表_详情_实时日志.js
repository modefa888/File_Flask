/* ==================================================================
   后台任务：编辑器区域管理面板（标签页形式）
     · 左侧：任务卡片列表（筛选 / 搜索），点卡片即选中；
     · 右侧：选中任务的完整详情（复用 11_ 的 taskInfoRows）＋ 实时日志；
     · 顶部工具行可直接暂停 / 继续 / 重启 / 停止 / 移除 / 底部面板查看；
     · 左侧任务列表可收起（窗口窄 / 只想看日志时让日志区占满），偏好记在 localStorage。
     与侧栏「后台任务」面板共用同一份数据（RUNNER.tasks）与同一批操作函数，
     所以在任一处操作，另一处会自动跟着变；日志用独立的 SSE 连接（不影响底部面板）。
     须放在 16_（关闭大 IIFE）之前，复用闭包内的 $ / esc / findTab / tabs / activate 等。
     · 日志区自带搜索（🔍）：关键字整行高亮、上一个 / 下一个跳转、命中计数。
   ================================================================== */
const RUNNER_VIEW_PATH = "\u0000runner";
const RV_LIST_KEY = "ide.runnerView.listCollapsed";   // 左栏收起偏好
const RV_INFO_H_KEY = "ide.runnerView.infoH";         // 详情区高度（分隔条拖动结果）
const RUNVIEW = {
  sel: "", kw: "", filter: "all",
  es: null, poll: null, tick: null,      // 日志流 / 轮询兜底 / 视图自动刷新定时器
  logId: "", logOff: 0, lines: 0, logDone: false, follow: true,
  listCollapsed: false,                  // 左栏（任务列表）是否收起
  infoH: 0,                              // 详情区高度（px，0 = 按 CSS 的 30% 自适应）
  findKw: "", findHits: 0, findIdx: -1,  // 日志搜索：关键字（小写）/ 命中数 / 当前命中序号
  findT: null,                           // 输入防抖定时器
};
const RV_LOG_MAX = 4000;                 // 视图里最多保留的日志行数
try { RUNVIEW.listCollapsed = localStorage.getItem(RV_LIST_KEY) === "1"; } catch (_) { /* 忽略隐私模式报错 */ }
try { RUNVIEW.infoH = parseInt(localStorage.getItem(RV_INFO_H_KEY) || "0", 10) || 0; } catch (_) { /* 忽略隐私模式报错 */ }

function rvRoot() { return document.getElementById("runnerView"); }
function rvQ(sel) { const r = rvRoot(); return r ? r.querySelector(sel) : null; }
function rvCur() { return (RUNNER.tasks || []).filter(x => String(x.id) === String(RUNVIEW.sel))[0]; }

/* ---------- 打开 / 关闭面板 ---------- */
function openRunnerView(tid) {
  let tab = findTab(RUNNER_VIEW_PATH);
  if (!tab) {
    const host = document.createElement("div");
    host.className = "cm-host runner-view-host";
    host.innerHTML = '<div class="rv" id="runnerView"></div>';
    const dw = (typeof currentWrap === "function") ? currentWrap() : null;
    (dw || edGroups).appendChild(host);
    tab = {
      path: RUNNER_VIEW_PATH, host: host, cm: null, original: "", dirty: false,
      group: curGroup, name: "后台任务", displayPath: "后台任务", relPath: "",
      iconHtml: '<i class="bi bi-play-btn" style="color:#7ec96f"></i>',
    };
    tab.onBeforeClose = () => {          // 关标签：断日志连接、停自动刷新
      clearTimeout(RUNVIEW.tick);
      RUNVIEW.tick = null;
      rvLogClose();
      RUNVIEW.sel = ""; RUNVIEW.logId = "";
      return true;
    };
    tabs.push(tab);
    renderTabsAll();
    rvBuild();
  }
  activate(tab);
  if (tid) RUNVIEW.sel = tid;
  rvSplitRestore();        // 面板可见后，按实际高度把「详情 / 日志」的分隔位置重新夹紧
  rvPaint();
  loadRunnerList({ silent: true }).then(() => { rvPaint(); rvTick(); });
  return tab;
}
function runnerViewOpen() { return !!findTab(RUNNER_VIEW_PATH); }

/* 侧栏 / 卡片操作后同步视图（11_ 的 loadRunnerList、removeTaskCard 会调用） */
function rvSync() {
  if (!runnerViewOpen() || !rvRoot()) return;
  rvPaint();
}
/* 视图存在时自己按 3s 刷新：侧栏面板关掉、切到别的面板也不会停更 */
function rvTick() {
  clearTimeout(RUNVIEW.tick);
  if (!runnerViewOpen()) return;
  RUNVIEW.tick = setTimeout(() => {
    loadRunnerList({ silent: true }).then(() => { rvPaint(); rvTick(); });
  }, 3000);
}

/* ---------- 任务显示名称（点标题即可改） ----------
   名称按「目标文件路径」记住：任务重启后 id 会变、路径不变，所以自定义名照样生效。 */
const RV_ALIAS_KEY = "ide.runner.alias";
const RV_ALIAS = (() => { try { return JSON.parse(localStorage.getItem(RV_ALIAS_KEY) || "{}") || {}; } catch (_) { return {}; } })();

function rvAliasKey(t) { return String((t && (t.target || t.cwd)) || "").trim(); }
function rvAliasGet(t) {
  const k = rvAliasKey(t);
  return (k && String(RV_ALIAS[k] || "").trim()) || "";
}
/* 把别名写回任务的 name：侧栏卡片、详情悬浮框、各确认提示、本视图标题都读 name，改一处即全同步 */
function applyRunnerAliases() {
  (RUNNER.tasks || []).forEach(t => {
    if (!t) return;
    if (!t.orig_name) t.orig_name = t.name || "";
    t.name = rvAliasGet(t) || t.orig_name;
  });
}
function rvAliasSet(t, name) {
  const k = rvAliasKey(t);
  if (!k) return false;
  name = String(name || "").trim();
  if (name && name !== (t.orig_name || t.name)) RV_ALIAS[k] = name;
  else delete RV_ALIAS[k];                                  // 留空 = 恢复默认名
  try { localStorage.setItem(RV_ALIAS_KEY, JSON.stringify(RV_ALIAS)); } catch (_) { /* 忽略 */ }
  return true;
}
async function rvRenameTask() {
  const t = rvCur();
  if (!t) return;
  const def = t.orig_name || t.name || "";
  const v = await uiPrompt("修改任务显示名称", rvAliasGet(t) || def, "留空恢复默认名：" + def);
  if (v === null || v === undefined) return;                 // 取消 / 点外部 / Esc
  if (!rvAliasSet(t, v)) { toast("该任务没有可用的文件路径，无法保存名称", "warn"); return; }
  applyRunnerAliases();
  renderRunnerList();                                        // 侧栏卡片
  if (typeof refreshTaskInfo === "function") refreshTaskInfo();
  rvPaint();                                                 // 本视图标题 + 列表
  toast(v ? "已重命名为「" + v + "」" : "已恢复默认名称", "ok");
}

/* ---------- 左栏（任务列表）收起 / 展开 ---------- */
function rvListSet(collapsed) {
  RUNVIEW.listCollapsed = !!collapsed;
  try { localStorage.setItem(RV_LIST_KEY, RUNVIEW.listCollapsed ? "1" : "0"); } catch (_) { /* 忽略 */ }
  rvApplyList();
}
function rvApplyList() {
  const root = rvRoot();
  if (!root) return;
  const wrap = root.querySelector(".rv");
  if (wrap) wrap.classList.toggle("no-left", !!RUNVIEW.listCollapsed);
}

/* ---------- 详情 / 日志 分隔条：上下拖动调整两块高度 ----------
   详情区（.rv-info）默认 flex:none + max-height:30%（内容少时按内容高度收）。
   一旦拖动过，就改成显式 height（并解除 30% 上限），结果记在 localStorage，下次打开沿用。
   双击分隔条 = 清除显式高度，恢复默认的 30% 自适应。 */
function rvSplitBody() { const el = rvQ(".rv-logwrap"); return el ? el.parentElement : null; }
function rvSplitClamp(h) {                 // 详情区最小 40px；日志区至少留 80px（日志栏 + 几行）
  const body = rvSplitBody();
  const total = body ? body.clientHeight : 0;
  const minInfo = 40, minLog = 80;
  if (!total) return Math.max(minInfo, Math.round(h || 0));
  return Math.min(Math.max(minInfo, Math.round(h || 0)), Math.max(minInfo, total - minLog));
}
function rvSplitApply(h) {                 // h <= 0 → 恢复默认（30% 自适应）
  const info = rvQ(".rv-info");
  if (!info) return;
  RUNVIEW.infoH = Math.max(0, Math.round(h || 0));
  if (RUNVIEW.infoH) {
    info.style.height = RUNVIEW.infoH + "px";
    info.style.maxHeight = "none";
  } else {
    info.style.height = "";
    info.style.maxHeight = "";
  }
}
function rvSplitSave() {
  try { localStorage.setItem(RV_INFO_H_KEY, RUNVIEW.infoH ? String(RUNVIEW.infoH) : ""); } catch (_) { /* 忽略 */ }
}
/* 面板变为可见 / 窗口尺寸变化时，按当前实际高度重新夹紧已保存的值 */
function rvSplitRestore() {
  if (!RUNVIEW.infoH) return;
  const h = rvSplitClamp(RUNVIEW.infoH);
  rvSplitApply(h);
  if (h !== RUNVIEW.infoH) rvSplitSave();
}
function rvSplitBind() {
  const bar = rvQ(".rv-split");
  const body = rvSplitBody();
  if (!bar || !body) return;
  let startY = 0, startH = 0;
  const onMove = (e) => {
    rvSplitApply(rvSplitClamp(startH + (e.clientY - startY)));
    e.preventDefault();
  };
  const onUp = () => {
    bar.classList.remove("on");
    document.body.classList.remove("rv-split-drag");
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
    rvSplitSave();
  };
  bar.addEventListener("pointerdown", (e) => {
    const info = rvQ(".rv-info");
    if (!info || e.button !== 0) return;
    e.preventDefault();
    startY = e.clientY;
    startH = info.getBoundingClientRect().height;
    bar.classList.add("on");
    document.body.classList.add("rv-split-drag");   // 拖动期间全局光标保持 ns-resize
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  });
  bar.addEventListener("dblclick", () => { rvSplitApply(0); rvSplitSave(); });
  window.addEventListener("resize", rvSplitRestore);
  rvSplitRestore();                                  // 沿用上次拖出的高度
}

/* ---------- 骨架（只建一次） ---------- */
function rvBuild() {
  const root = rvRoot();
  if (!root || root.dataset.built === "1") return;
  root.dataset.built = "1";
  root.innerHTML =
    '<div class="rv">' +
      '<div class="rv-left">' +
        '<div class="rv-lhead">' +
          '<div class="rv-tools">' +
            '<select class="rv-filter" title="按状态筛选任务">' +
              '<option value="all">全部任务</option>' +
              '<option value="running">运行中</option>' +
              '<option value="paused">已暂停</option>' +
              '<option value="done">已结束</option>' +
            '</select>' +
            '<input class="rv-search" type="text" spellcheck="false" placeholder="搜索名称 / 文件 / 命令">' +
            '<button class="rv-mini rv-refresh" title="立即刷新状态与日志"><i class="bi bi-arrow-clockwise"></i></button>' +
          '</div>' +
          '<div class="rv-statrow">' +
            '<div class="rv-stat"></div>' +
            '<button class="rv-mini rv-collapse" title="收起任务列表（日志区占满整个面板）"><i class="bi bi-chevron-double-left"></i></button>' +
          '</div>' +
        '</div>' +
        '<div class="rv-list scroll-thin"></div>' +
      '</div>' +
      '<div class="rv-right">' +
        '<div class="rv-rhead">' +
          '<button class="rv-mini rv-expand" title="展开任务列表"><i class="bi bi-chevron-double-right"></i> 任务列表</button>' +
          '<span class="rv-title">未选择任务</span>' +
          '<span class="rv-state"></span>' +
          '<span class="rv-sp"></span>' +
          '<div class="rv-acts"></div>' +
        '</div>' +
        '<div class="rv-body">' +
          '<div class="rv-info scroll-thin"></div>' +
          '<div class="rv-split" title="上下拖动调整「详情」与「日志」的高度 · 双击恢复默认"></div>' +
          '<div class="rv-logwrap">' +
            '<div class="rv-logbar">' +
              '<span class="rv-logtitle"><i class="bi bi-terminal"></i> 实时日志</span>' +
              '<span class="rv-logmsg"></span>' +
              '<span class="rv-sp"></span>' +
              '<label class="rv-chk" title="有新输出时自动滚到底部"><input type="checkbox" class="rv-follow" checked> 自动滚底</label>' +
              '<span class="rv-findbox" hidden>' +
                '<i class="bi bi-search"></i>' +
                '<input class="rv-findinput" type="text" spellcheck="false" placeholder="在日志中搜索…">' +
                '<span class="rv-findnum">0/0</span>' +
                '<button class="rv-mini rv-find-prev" title="上一个命中（Shift+Enter）"><i class="bi bi-chevron-up"></i></button>' +
                '<button class="rv-mini rv-find-next" title="下一个命中（Enter / F3）"><i class="bi bi-chevron-down"></i></button>' +
                '<button class="rv-mini rv-find-close" title="关闭搜索（Esc）"><i class="bi bi-x-lg"></i></button>' +
              '</span>' +
              '<button class="rv-mini rv-findbtn" title="在日志中搜索（Ctrl+F）"><i class="bi bi-search"></i> 搜索</button>' +
              '<button class="rv-mini rv-copy" title="复制当前显示的全部日志"><i class="bi bi-clipboard"></i> 复制</button>' +
              '<button class="rv-mini rv-clear" title="只清空这里的显示，不影响任务与日志文件"><i class="bi bi-eraser"></i> 清屏</button>' +
            '</div>' +
            '<pre class="rv-log"></pre>' +
          '</div>' +
        '</div>' +
      '</div>' +
    '</div>';

  const fEl = rvQ(".rv-filter");
  fEl.value = RUNVIEW.filter;
  fEl.onchange = () => { RUNVIEW.filter = fEl.value; rvPaintList(); };

  const kEl = rvQ(".rv-search");
  kEl.value = RUNVIEW.kw;
  kEl.oninput = () => { RUNVIEW.kw = kEl.value; rvPaintList(); };

  rvQ(".rv-refresh").onclick = () => {
    loadRunnerList({ silent: true }).then(() => {
      rvPaint();
      const t = rvCur();
      if (t && RUNVIEW.logId === t.id) rvLogOpen(t);   // 立即补上最新日志
    });
  };

  const colEl = rvQ(".rv-collapse");
  if (colEl) colEl.onclick = () => rvListSet(true);
  const expEl = rvQ(".rv-expand");
  if (expEl) expEl.onclick = () => rvListSet(false);
  rvApplyList();                       // 沿用上次的收起 / 展开偏好

  // 点标题改名（留空 = 恢复默认的文件名）
  const ttlEl = rvQ(".rv-title");
  if (ttlEl) {
    ttlEl.classList.add("rv-title-edit");
    ttlEl.onclick = () => { if (rvCur()) rvRenameTask(); };
  }

  const followEl = rvQ(".rv-follow");
  followEl.checked = RUNVIEW.follow;
  followEl.onchange = () => {
    RUNVIEW.follow = followEl.checked;
    if (RUNVIEW.follow) { const pre = rvQ(".rv-log"); if (pre) pre.scrollTop = pre.scrollHeight; }
  };

  rvQ(".rv-copy").onclick = () => {
    const pre = rvQ(".rv-log");
    if (!pre || !pre.textContent.trim()) { toast("当前没有日志内容", "warn"); return; }
    copyText(pre.textContent);
  };
  rvQ(".rv-clear").onclick = () => {
    const pre = rvQ(".rv-log");
    if (pre) pre.innerHTML = "";
    RUNVIEW.lines = 0;
    rvFindScan(true);                    // 行都没了，命中计数同步归零
    rvLogMsg("已清屏 · 实时推送不受影响");
  };
  rvFindBind();                          // 日志搜索（🔍）
  rvSplitBind();                         // 详情 / 日志 分隔条（上下拖动）

  // 左栏：点卡片选中（端口链接照旧打开新标签，不触发选中）
  const listEl = rvQ(".rv-list");
  listEl.addEventListener("click", (e) => {
    if (e.target.closest && e.target.closest("a")) return;
    const item = e.target.closest(".rv-item");
    if (item) rvSelect(item.dataset.tid);
  });
  // 按住卡片时跳过自动重绘，避免把要点的卡片换掉（与侧栏同一机制）
  listEl.addEventListener("pointerdown", () => { RUNNER.holdUntil = Date.now() + 1200; }, true);

  // 右栏同理：正按着按钮 / 链接时，自动刷新不重建按钮（否则这一下点击会丢）
  const rightEl = rvQ(".rv-right");
  if (rightEl) rightEl.addEventListener("pointerdown", () => { RUNNER.holdUntil = Date.now() + 1200; }, true);

  // 右栏：操作按钮
  rvQ(".rv-acts").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const t = rvCur();
    if (!t) return;
    switch (btn.dataset.act) {
      case "attach":  attachTask(t); break;                 // 底部输出面板查看（可转后台）
      case "pause":   pauseTaskById(t); break;
      case "resume":  resumeTaskById(t); break;
      case "restart": restartTaskById(t); break;
      case "stop":    stopTaskById(t); break;
      case "remove":  removeTaskById(t); break;
      case "open":    if (t.ports && t.ports.length) window.open(portUrl(t.ports[0]), "_blank"); break;
    }
  });
}

/* 光标 / 选区正落在容器里（用户选好了文字、准备右键复制）时不要重绘它：
   innerHTML 重建会把选区清掉，表现为"明明选了文字，复制却是空的" */
function rvSelHoldIn(sel) {
  try {
    const box = rvQ(sel);
    if (!box) return false;
    const s = window.getSelection();
    if (!s || !s.rangeCount || s.isCollapsed) return false;
    const n = s.getRangeAt(0).commonAncestorContainer;
    const el = n && n.nodeType === 1 ? n : (n ? n.parentNode : null);
    return !!(el && box.contains(el));
  } catch (_) { return false; }
}

/* ---------- 绘制 ---------- */
function rvPaint() {
  if (!rvRoot()) return;
  rvPaintList();
  rvPaintRight();
}

function rvFiltered() {
  const kw = (RUNVIEW.kw || "").trim().toLowerCase();
  return (RUNNER.tasks || []).filter(t => {
    if (RUNVIEW.filter === "running" && !(t.running && !t.paused)) return false;
    if (RUNVIEW.filter === "paused" && !(t.running && t.paused)) return false;
    if (RUNVIEW.filter === "done" && t.running) return false;
    if (!kw) return true;
    return ((t.name || "") + " " + (t.target || "") + " " + (t.command || "") + " " + (t.cwd || ""))
      .toLowerCase().indexOf(kw) >= 0;
  });
}

function rvItemHtml(t) {
  const tag = t.mode === "bg" ? (t.promoted ? "后台·已转" : "后台") : "前台";
  const state = t.paused
    ? '<span class="dot paused"></span>已暂停'
    : t.running
      ? '<span class="dot"></span>运行中'
      : '<span class="dot off"></span>已结束' +
        (t.exit_code === null || t.exit_code === undefined ? "" : "（代码 " + t.exit_code + "）");
  const on = String(t.id) === String(RUNVIEW.sel) ? " on" : "";
  return '<div class="runner-item rv-item' + (t.running ? " running" : "") + (t.paused ? " paused" : "") + on +
      '" data-tid="' + escAttr(t.id) + '">' +
    '<div class="ri-top">' + state +
      '<span class="ri-name" title="' + escAttr(t.target || "") + '">' + esc(t.name || "") + '</span>' +
      '<span class="ri-tag">' + esc(tag) + '</span></div>' +
    '<div class="ri-cmd" title="' + escAttr(t.command || "") + '">' + esc(t.command || "") + '</div>' +
    '<div class="ri-meta">' + fmtDur(t.duration) + ' · ' + (t.lines || 0) + ' 行 · ' + fmtSize(t.log_size || 0) +
      ' · 启动于 ' + esc(t.started_at || "-") + '</div>' +
    resLine(t) +
    '</div>';
}

function rvPaintList() {
  const box = rvQ(".rv-list");
  if (!box) return;
  const all = RUNNER.tasks || [];
  const stat = rvQ(".rv-stat");
  if (stat) {
    stat.innerHTML = '共 <b>' + all.length + '</b> 个 · 运行中 <b class="ok">' +
      all.filter(t => t.running && !t.paused).length + '</b> · 暂停 <b class="warn">' +
      all.filter(t => t.running && t.paused).length + '</b> · 结束 <b>' + all.filter(t => !t.running).length + '</b>';
  }
  const list = rvFiltered();
  // 选中的任务被过滤掉 / 被移除 → 自动改选第一条可见任务
  if (!list.some(t => String(t.id) === String(RUNVIEW.sel))) RUNVIEW.sel = list.length ? list[0].id : "";

  // 正按着卡片、或正在列表里选文字（准备复制）→ 跳过本次重绘，别把选区 / 要点的按钮换掉
  if (box.childElementCount && (Date.now() < RUNNER.holdUntil || rvSelHoldIn(".rv-list"))) return;
  if (!list.length) {
    box.innerHTML = '<div class="ph">' + (all.length
      ? "没有符合筛选条件的任务"
      : "暂时没有任务。<br>在「运行和调试」面板点「运行当前文件」或「后台运行（服务模式）」。") + '</div>';
    return;
  }
  box.innerHTML = list.map(rvItemHtml).join("");
}

function rvActsHtml(t) {
  let h = '<button class="rv-btn" data-act="attach" title="在底部输出面板查看日志（前台任务可转后台）">' +
    '<i class="bi bi-file-earmark-text"></i> 底部查看</button>';
  if (t.running && t.paused) {
    h += '<button class="rv-btn v-go" data-act="resume" title="继续运行（从挂起点恢复）"><i class="bi bi-play-fill"></i> 继续</button>' +
         '<button class="rv-btn v-re" data-act="restart" title="重启（先停止再启动）"><i class="bi bi-arrow-clockwise"></i> 重启</button>' +
         '<button class="rv-btn v-stop" data-act="stop" title="停止（终止进程）"><i class="bi bi-stop-fill"></i> 停止</button>';
  } else if (t.running) {
    h += '<button class="rv-btn v-pause" data-act="pause" title="暂停（挂起进程，端口仍占用）"><i class="bi bi-pause-fill"></i> 暂停</button>' +
         '<button class="rv-btn v-re" data-act="restart" title="重启（先停止再启动）"><i class="bi bi-arrow-clockwise"></i> 重启</button>' +
         '<button class="rv-btn v-stop" data-act="stop" title="停止（终止进程）"><i class="bi bi-stop-fill"></i> 停止</button>';
  } else {
    h += '<button class="rv-btn v-go" data-act="restart" title="用原文件与参数重新启动"><i class="bi bi-play-fill"></i> 启动</button>' +
         '<button class="rv-btn v-del" data-act="remove" title="移除这条记录（连同日志文件）"><i class="bi bi-trash"></i> 移除</button>';
  }
  if (t.running && (t.ports || []).filter(p => p > 0).length) {
    h += '<button class="rv-btn v-port" data-act="open" title="在新标签打开该服务端口"><i class="bi bi-box-arrow-up-right"></i> 打开端口</button>';
  }
  return h;
}

function rvPaintRight() {
  const root = rvRoot();
  if (!root) return;
  const t = rvCur();
  const titleEl = rvQ(".rv-title");
  const stateEl = rvQ(".rv-state");
  const actsEl = rvQ(".rv-acts");
  const infoEl = rvQ(".rv-info");
  if (!t) {
    if (titleEl) { titleEl.textContent = "未选择任务"; titleEl.title = ""; }
    if (stateEl) { stateEl.textContent = ""; stateEl.className = "rv-state"; }
    if (actsEl) actsEl.innerHTML = "";
    if (infoEl) infoEl.innerHTML = '<div class="ph">左侧选择一个任务后，这里显示完整详情与实时日志。</div>';
    rvLogClose();
    rvLogMsg("");
    return;
  }
  if (titleEl) {
    const orig = t.orig_name || "";
    titleEl.textContent = t.name || "任务";
    titleEl.title = "点击修改显示名称" +
      (orig && orig !== t.name ? "（原文件名 " + orig + "）" : (t.target ? "：" + t.target : ""));
  }
  if (stateEl) {
    stateEl.textContent = taskStatusText(t);
    stateEl.className = "rv-state " + (t.paused ? "paused" : t.running ? "running" : "off");
  }
  const hold = Date.now() < RUNNER.holdUntil;      // 用户正按着右栏：别把按钮 / 链接换掉
  if (actsEl && !hold) actsEl.innerHTML = rvActsHtml(t);
  else if (actsEl && !actsEl.innerHTML) actsEl.innerHTML = rvActsHtml(t);
  if (infoEl && !hold && !rvSelHoldIn(".rv-info")) infoEl.innerHTML = taskInfoRows(t);   // 选文字时不重建
  if (RUNVIEW.logId !== t.id) rvLogOpen(t);            // 切换任务 → 换日志源
}

/* ---------- 选中 ---------- */
function rvSelect(id) {
  if (!id) return;
  RUNVIEW.sel = id;
  const root = rvRoot();
  if (!root) return;
  root.querySelectorAll(".rv-item").forEach(el => el.classList.toggle("on", el.dataset.tid === String(id)));
  rvPaintRight();
}

/* ---------- 实时日志（独立 SSE，不影响底部面板那条） ---------- */
function rvLogMsg(s, cls) {
  const el = rvQ(".rv-logmsg");
  if (!el) return;
  el.textContent = s || "";
  el.className = "rv-logmsg" + (cls ? " " + cls : "");
}
function rvLogClose() {
  if (RUNVIEW.es) { try { RUNVIEW.es.close(); } catch (_) { /* 忽略 */ } RUNVIEW.es = null; }
  clearTimeout(RUNVIEW.poll);
  RUNVIEW.poll = null;
}
async function rvLogOpen(t) {
  const pre = rvQ(".rv-log");
  if (!pre || !t || !t.id) return;
  rvLogClose();
  RUNVIEW.logId = t.id; RUNVIEW.logOff = 0; RUNVIEW.lines = 0; RUNVIEW.logDone = false;
  RUNVIEW.findHits = 0; RUNVIEW.findIdx = -1;          // 换任务：搜索命中重新累计（关键字保留）
  pre.innerHTML = "";
  rvLogMsg("读取日志…");
  try {
    const r = await fetch("/api/run/log?id=" + encodeURIComponent(t.id) + "&offset=0");
    const d = await r.json();
    if (RUNVIEW.logId !== t.id) return;                 // 期间切了任务
    (d.lines || []).forEach(l => rvLogLine(l.m, runLineClass(l.c)));
    RUNVIEW.logOff = d.offset || 0;
    RUNVIEW.logDone = !!d.done;
    pre.scrollTop = pre.scrollHeight;
    if (d.done) { rvLogMsg("日志已结束 · 共 " + RUNVIEW.lines + " 行"); return; }
    rvLogMsg("实时推送中 · " + RUNVIEW.lines + " 行");
    if (window.EventSource) rvLogStream(t.id);
    else rvLogPoll(t.id);
  } catch (e) {
    rvLogMsg("日志读取失败：" + (e.message || e), "err");
  }
}
function rvLogStream(id) {
  const es = new EventSource("/api/run/stream?id=" + encodeURIComponent(id) + "&offset=" + RUNVIEW.logOff);
  RUNVIEW.es = es;
  es.onmessage = (ev) => {
    if (RUNVIEW.logId !== id) { es.close(); return; }
    let d = null;
    try { d = JSON.parse(ev.data); } catch (_) { return; }
    RUNVIEW.logOff = d.offset || RUNVIEW.logOff;
    (d.lines || []).forEach(l => rvLogLine(l.m, runLineClass(l.c)));
    if (d.done) {
      RUNVIEW.logDone = true;
      rvLogClose();
      rvLogMsg("日志已结束 · 共 " + RUNVIEW.lines + " 行");
      loadRunnerList({ silent: true }).then(rvPaint);
      return;
    }
    rvLogMsg("实时推送中 · " + RUNVIEW.lines + " 行");
  };
  es.onerror = () => {                                  // 断线 → 退回轮询兜底
    es.close();
    if (RUNVIEW.es === es) RUNVIEW.es = null;
    if (!RUNVIEW.logDone && RUNVIEW.logId === id) rvLogPoll(id);
  };
}
async function rvLogPoll(id) {
  clearTimeout(RUNVIEW.poll);
  if (RUNVIEW.logId !== id || RUNVIEW.logDone) return;
  try {
    const r = await fetch("/api/run/log?id=" + encodeURIComponent(id) + "&offset=" + RUNVIEW.logOff);
    const d = await r.json();
    if (RUNVIEW.logId !== id) return;
    RUNVIEW.logOff = d.offset || RUNVIEW.logOff;
    (d.lines || []).forEach(l => rvLogLine(l.m, runLineClass(l.c)));
    if (d.done) {
      RUNVIEW.logDone = true;
      rvLogMsg("日志已结束 · 共 " + RUNVIEW.lines + " 行");
      loadRunnerList({ silent: true }).then(rvPaint);
      return;
    }
    rvLogMsg("轮询中 · " + RUNVIEW.lines + " 行");
  } catch (_) { /* 下一次再试 */ }
  RUNVIEW.poll = setTimeout(() => rvLogPoll(id), 1200);
}
function rvLogLine(m, cls) {
  const pre = rvQ(".rv-log");
  if (!pre) return;
  const near = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 60;
  const d = document.createElement("div");
  d.className = "log-line" + (cls ? " " + cls : "");
  d.textContent = m;
  if (rvFindMark(d)) { d.classList.add("hit"); RUNVIEW.findHits++; rvFindNum(); }   // 新推来的行也参与高亮
  pre.appendChild(d);
  RUNVIEW.lines++;
  while (pre.childElementCount > RV_LOG_MAX) {          // 超出上限：淘汰最旧的行
    const gone = pre.firstElementChild;
    if (gone && gone.classList.contains("hit") && RUNVIEW.findHits > 0) RUNVIEW.findHits--;   // 命中行被淘汰要扣计数
    if (gone) gone.remove();
  }
  // 正在日志里选文字时不自动滚底，免得选中的行被滚走
  if (RUNVIEW.follow && near && !rvSelHoldIn(".rv-log")) pre.scrollTop = pre.scrollHeight;
}

/* ---------- 日志搜索（🔍）：整行黄底 + 关键字红字 + 上一个 / 下一个 ----------
   只扫当前已显示在 DOM 里的日志行（不重新读文件），新推来的行会实时参与匹配。 */
function rvFindPaint(el, kw) {                        // 行内关键字包 <span class="rv-kw">；返回该行是否命中
  if (!el) return false;
  if (el.__rvText == null) el.__rvText = el.textContent;   // 行是纯文本、建好后不再变，缓存原文本便于还原
  const raw = el.__rvText;
  const low = raw.toLowerCase();
  const first = kw ? low.indexOf(kw) : -1;
  if (first < 0) {                                    // 不命中：还原成纯文本（去掉上次的红字节点）
    if (el.childElementCount) el.textContent = raw;
    return false;
  }
  const frag = document.createDocumentFragment();
  let from = 0, at = first;
  while (at >= 0) {
    if (at > from) frag.appendChild(document.createTextNode(raw.slice(from, at)));
    const s = document.createElement("span");
    s.className = "rv-kw";
    s.textContent = raw.slice(at, at + kw.length);
    frag.appendChild(s);
    from = at + kw.length;
    at = low.indexOf(kw, from);
  }
  if (from < raw.length) frag.appendChild(document.createTextNode(raw.slice(from)));
  el.textContent = "";
  el.appendChild(frag);
  return true;
}
function rvFindMark(el) {                             // 该行是否命中（命中则给关键字着红字）
  return rvFindPaint(el, RUNVIEW.findKw);
}
function rvFindNum() {
  const el = rvQ(".rv-findnum");
  if (!el) return;
  const txt = (RUNVIEW.findHits ? (RUNVIEW.findIdx + 1) : 0) + "/" + RUNVIEW.findHits;
  if (el.textContent !== txt) el.textContent = txt;
}
function rvFindScan(reset) {                          // 全量重扫（改关键字 / 清屏 / 换任务后）
  const pre = rvQ(".rv-log");
  if (!pre) return;
  RUNVIEW.findKw = String(RUNVIEW.findKw || "").trim().toLowerCase();
  let hits = 0;
  [...pre.children].forEach(el => {
    const on = rvFindMark(el);
    el.classList.toggle("hit", on);
    el.classList.remove("hit-on");
    if (on) hits++;
  });
  RUNVIEW.findHits = hits;
  RUNVIEW.findIdx = hits ? (reset ? 0 : Math.min(Math.max(RUNVIEW.findIdx, 0), hits - 1)) : -1;
  if (hits) rvFindGoto(RUNVIEW.findIdx, true);
  else rvFindNum();
}
function rvFindGoto(i, silent) {                      // 跳到第 i 个命中（自动取模循环）
  const pre = rvQ(".rv-log");
  if (!pre) return;
  const hits = [...pre.querySelectorAll(".log-line.hit")];
  RUNVIEW.findHits = hits.length;
  if (!hits.length) { RUNVIEW.findIdx = -1; rvFindNum(); return; }
  RUNVIEW.findIdx = ((i % hits.length) + hits.length) % hits.length;
  hits.forEach((el, k) => el.classList.toggle("hit-on", k === RUNVIEW.findIdx));
  const el = hits[RUNVIEW.findIdx];
  const er = el.getBoundingClientRect(), pr = pre.getBoundingClientRect();
  pre.scrollTop += (er.top - pr.top) - (pre.clientHeight - er.height) / 2;   // 让命中行居中
  if (RUNVIEW.follow) {                               // 否则新日志一到就被拉回底部，看不到命中
    RUNVIEW.follow = false;
    const chk = rvQ(".rv-follow");
    if (chk) chk.checked = false;
    if (!silent) toast("已暂停自动滚底，方便逐条查看命中", "info");
  }
  rvFindNum();
}
function rvFindOpen() {
  const box = rvQ(".rv-findbox");
  if (!box) return;
  box.hidden = false;
  const inp = rvQ(".rv-findinput");
  if (inp) {
    if (inp.value !== RUNVIEW.findKw) inp.value = RUNVIEW.findKw;
    inp.focus();
    inp.select();
  }
  if (RUNVIEW.findKw) rvFindScan(false);
}
function rvFindClose() {
  const box = rvQ(".rv-findbox");
  if (box) box.hidden = true;
  RUNVIEW.findKw = ""; RUNVIEW.findHits = 0; RUNVIEW.findIdx = -1;
  const pre = rvQ(".rv-log");
  if (pre) pre.querySelectorAll(".log-line.hit, .log-line.hit-on").forEach(el => {
    el.classList.remove("hit", "hit-on");
    if (el.childElementCount) el.textContent = el.__rvText != null ? el.__rvText : el.textContent;   // 去掉红字节点
  });
  rvFindNum();
}
function rvFindStep(dir) {                            // 供快捷键 F3 / Shift+F3（搜索条开着时由它接管）
  const box = rvQ(".rv-findbox");
  if (!box || box.hidden) return false;
  rvFindGoto(RUNVIEW.findIdx + (dir > 0 ? 1 : -1));
  return true;
}
function rvFindBind() {
  const btn = rvQ(".rv-findbtn");
  if (btn) btn.onclick = () => rvFindOpen();
  const closeEl = rvQ(".rv-find-close");
  if (closeEl) closeEl.onclick = () => rvFindClose();
  const prevEl = rvQ(".rv-find-prev");
  if (prevEl) prevEl.onclick = () => rvFindGoto(RUNVIEW.findIdx - 1);
  const nextEl = rvQ(".rv-find-next");
  if (nextEl) nextEl.onclick = () => rvFindGoto(RUNVIEW.findIdx + 1);
  const inp = rvQ(".rv-findinput");
  if (!inp) return;
  inp.oninput = () => {                               // 输入防抖：日志多时别每敲一个字就全量重扫
    RUNVIEW.findKw = inp.value;
    clearTimeout(RUNVIEW.findT);
    RUNVIEW.findT = setTimeout(() => rvFindScan(true), 120);
  };
  inp.addEventListener("keydown", (e) => {
    const back = e.shiftKey ? -1 : 1;
    if (e.key === "Enter" || e.key === "F3") { e.preventDefault(); rvFindGoto(RUNVIEW.findIdx + back); }
    else if (e.key === "Escape") {
      e.preventDefault();
      rvFindClose();
      const pre = rvQ(".rv-log");
      if (pre) pre.scrollTop = RUNVIEW.follow ? pre.scrollHeight : pre.scrollTop;
    }
  });
}

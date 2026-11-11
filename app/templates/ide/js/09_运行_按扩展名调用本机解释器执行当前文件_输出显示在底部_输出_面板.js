  /* ==================================================================
     运行：按扩展名调用本机解释器执行当前文件，输出显示在底部“输出”面板
     ================================================================== */
  const RUN_LABELS = {
    py: "Python 3", js: "Node.js", mjs: "Node.js", cjs: "Node.js",
    sh: "Bash", bash: "Bash", rb: "Ruby", php: "PHP", pl: "Perl", lua: "Lua", r: "R",
  };

  /* ---------- 运行记录：右侧悬浮列表，每次运行一条，点击回看对应输出 ---------- */
  var RUN_HISTORY = [];               // { taskId, name, target, time, running, exit, bg, buf:[] }
  var curHist = null;                 // 当前实时输出写入的记录
  var viewHist = null;                // 正在回看的记录（null = 跟随实时输出）

  /* ---------- 运行记录持久化到浏览器本地（localStorage） ----------
     按项目根目录隔离；定时做快照而不是每写一行就序列化，日志再多也不拖慢输出。
     只保留最近 20 次、每次最近 200 行，配额不够时自动减半重试。 */
  const HIST_KEY = "ide.run.history." + ((typeof ROOT !== "undefined" && ROOT) ? ROOT : location.pathname);
  const HIST_MAX = 20;
  const HIST_LINES = 200;
  let histLastJson = "";

  function histSaveNow() {
    try {
      let list = RUN_HISTORY.slice(0, HIST_MAX).map(function (rec) {
        const lines = rec.buf.slice(-HIST_LINES).map(function (l) {
          return { m: String(l.m == null ? "" : l.m).slice(0, 2000), c: l.c || "" };
        });
        if (rec.buf.length > HIST_LINES) {
          lines.unshift({ m: "…（本地仅保留最近 " + HIST_LINES + " 行输出）", c: "op-dim" });
        }
        return {
          name: rec.name, target: rec.target,
          time: (rec.time instanceof Date ? rec.time.getTime() : Date.now()),
          running: false,
          exit: rec.running ? -1 : (rec.exit == null ? -1 : rec.exit),
          bg: !!rec.bg, buf: lines,
        };
      });
      let txt = JSON.stringify(list);
      if (txt === histLastJson) return;                 // 内容没变就不写盘
      while (list.length) {
        try { localStorage.setItem(HIST_KEY, txt); histLastJson = txt; return; }
        catch (e) {                                     // 配额不足 → 少存几条再试
          list = list.slice(0, Math.floor(list.length / 2));
          txt = JSON.stringify(list);
        }
      }
      localStorage.setItem(HIST_KEY, "[]");
      histLastJson = "[]";
    } catch (e) { /* 隐私模式 / 存储异常：忽略，不影响运行 */ }
  }

  function histLoad() {
    try {
      const raw = localStorage.getItem(HIST_KEY);
      histLastJson = raw || "";
      const arr = JSON.parse(raw || "[]");
      if (!Array.isArray(arr)) return;
      RUN_HISTORY = arr.slice(0, HIST_MAX).map(function (d) {
        const t = new Date(d.time || Date.now());
        return {
          taskId: null,                               // 旧任务不复活：点记录一律回看本地缓存
          name: String(d.name || "运行"), target: String(d.target || ""),
          time: isNaN(t.getTime()) ? new Date() : t,
          running: false, exit: (d.exit == null ? -1 : d.exit), bg: !!d.bg,
          buf: Array.isArray(d.buf) ? d.buf.map(function (l) {
            return { m: String(l && l.m != null ? l.m : ""), c: (l && l.c) || "" };
          }) : [],
        };
      });
    } catch (e) { /* 本地数据损坏：忽略，不影响运行 */ }
  }

  histLoad();
  histRender();                                        // 恢复后立刻把记录画到右侧悬浮框
  setInterval(histSaveNow, 2000);                      // 定时快照：运行中的输出也会逐步存下来
  window.addEventListener("beforeunload", histSaveNow);
  document.addEventListener("click", function (e) {     // 清空按钮：本地记录一起清掉
    if (e.target && e.target.closest && e.target.closest(".rh-clear")) {
      try { localStorage.removeItem(HIST_KEY); } catch (_) { /* 忽略 */ }
      histLastJson = "";
    }
  }, true);
  const histHead = document.querySelector("#runHistBox .rh-head > span");
  if (histHead) histHead.title = "运行记录已保存在浏览器本地，刷新页面后仍可回看";
  const histClr = document.querySelector("#runHistBox .rh-clear");
  if (histClr) histClr.title = "清空运行记录（同时清除浏览器本地保存）";

  function histTime(d) {
    var p = function(n) { return (n < 10 ? "0" : "") + n; };
    return p(d.getHours()) + ":" + p(d.getMinutes());
  }
  function histPush(rec, m, cls) {
    rec.buf.push({ m: String(m), c: cls || "" });
    if (rec.buf.length > 2000) rec.buf.splice(0, 500);   // 超长裁剪，防内存膨胀
  }
  function histAdd(target, taskId, mode) {
    var rec = { taskId: taskId || null, name: baseName(target), target: target,
                time: new Date(), running: true, exit: null, bg: mode === "bg", buf: [] };
    RUN_HISTORY.unshift(rec);
    if (RUN_HISTORY.length > 30) RUN_HISTORY.length = 30;   // 只保留最近 30 次
    curHist = rec; viewHist = null;
    histRender();
    return rec;
  }
  function histFinish(exit) {
    if (!curHist) return;
    curHist.running = false;
    curHist.exit = exit;
    histRender();
  }
  // 回看某次运行的输出（后台任务 → 直接切到它的日志标签）
  function viewHistory(rec) {
    if (rec.taskId && LOGS[rec.taskId]) { selectLogTab(rec.taskId); return; }
    viewHist = rec;
    toggleBottom(true, "output");
    var body = $("opBody");
    body.innerHTML = "";
    var t = $("bpTitle"); if (t) t.textContent = "运行记录 · " + rec.name + " · " + histTime(rec.time);
    if (!rec.buf.length) {
      var tip = document.createElement("span");
      tip.style.color = "#6d7482";
      tip.textContent = "（无输出）";
      body.appendChild(tip);
    } else {
      var frag = document.createDocumentFragment();
      rec.buf.forEach(function(l) {
        var s = document.createElement("span");
        if (l.c) s.className = l.c;
        s.textContent = l.m;
        frag.appendChild(s);
      });
      body.appendChild(frag);
    }
    body.scrollTop = body.scrollHeight;
    if (typeof opFindRescan === "function") opFindRescan();
    histRender();
  }
  // 从「回看历史」复位为「跟随实时输出」（切回输出页签 / 新运行开始时）
  function viewLive() {
    viewHist = null;
    var body = $("opBody");
    body.innerHTML = "";
    var t = $("bpTitle"); if (t) t.textContent = "";
    (curHist ? curHist.buf : []).forEach(function(l) {
      var s = document.createElement("span");
      if (l.c) s.className = l.c;
      s.textContent = l.m;
      body.appendChild(s);
    });
    body.scrollTop = body.scrollHeight;
    if (typeof opFindRescan === "function") opFindRescan();
    histRender();
  }
  // 右侧悬浮列表渲染
  function histRender() {
    var box = document.getElementById("runHistBox");
    if (!box) {
      var st = document.createElement("style");
      st.textContent = ".bottom-panel{position:relative}" +
        ".op-body{--obg-env:rgba(76,141,255,.12);--obg-code:rgba(255,255,255,.04);--obg-ok:rgba(63,191,111,.14);--obg-err:rgba(224,86,86,.14)} html.theme-light .op-body{--obg-env:rgba(37,99,235,.09);--obg-code:rgba(0,0,0,.035);--obg-ok:rgba(34,118,74,.11);--obg-err:rgba(220,53,69,.11)} :where(.op-body)>span{display:block;box-sizing:border-box;padding:2px 10px;border-left:3px solid transparent;background:var(--obg-code)} :where(.op-body) .op-cmd,:where(.op-body) .op-dim,:where(.op-body) .op-head{background:var(--obg-env);border-left-color:#4c8dff} :where(.op-body) .op-result{background:var(--obg-ok);border-left-color:#3fbf6f} :where(.op-body) .op-result.op-err{background:var(--obg-err);border-left-color:#e05656}" +
        "#runHistBox{position:absolute;right:14px;top:50%;transform:translateY(-50%);" +
        "z-index:900;width:172px;background:rgba(28,30,36,.96);border:1px solid #3a3e48;" +
        "border-radius:10px;box-shadow:-4px 8px 24px rgba(0,0,0,.35);" +
        "font-size:12px;color:#cfd3dc;overflow:hidden}" +
        "#runHistBox .rh-head{padding:6px 10px;border-bottom:1px solid #3a3e48;color:#8b93a3;" +
        "display:flex;align-items:center;gap:6px}" +
        "#runHistBox .rh-list{max-height:180px;overflow-y:auto}" +
        ".rh-item{display:flex;align-items:center;gap:6px;padding:6px 10px;cursor:pointer}" +
        ".rh-item:hover{background:rgba(255,255,255,.06)}" +
        ".rh-item.on{background:rgba(34,118,74,.28)}" +
        ".rh-dot{width:8px;height:8px;border-radius:50%;flex:none}" +
        ".rh-dot.ok{background:#3fbf6f}.rh-dot.err{background:#e05656}" +
        ".rh-dot.run{background:#4c8dff;animation:rhPulse 1.2s infinite}" +
        ".rh-nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
        ".rh-tm{color:#6d7482;font-size:10px;flex:none}" +
        "@keyframes rhPulse{50%{opacity:.35}}" +
        "html.theme-light #runHistBox{background:rgba(255,255,255,.97);border-color:#d5d7dc;color:#333a45}" +
        "html.theme-light #runHistBox .rh-head{border-bottom-color:#d5d7dc;color:#6b7280}" +
        "html.theme-light .rh-item:hover{background:rgba(0,0,0,.05)}" +
        "html.theme-light .rh-item.on{background:rgba(34,118,74,.14)}" +
        "html.theme-light .rh-tm{color:#9aa0aa}" +
        "#runHistBox .rh-flex{flex:1}" +
        "#runHistBox .rh-clear{background:none;border:none;color:#8b93a3;cursor:pointer;font-size:11px;padding:0 2px}" +
        "#runHistBox .rh-clear:hover{color:#f48771}" +
        "html.theme-light #runHistBox .rh-clear{color:#9aa0aa}";
      document.head.appendChild(st);
      box = document.createElement("div");
      box.id = "runHistBox";
      box.innerHTML = '<div class="rh-head"><i class="bi bi-clock-history"></i><span>运行记录</span>' +
                      '<span class="rh-flex"></span>' +
                      '<button class="rh-clear" title="清空运行记录"><i class="bi bi-trash3"></i></button></div>' +
                      '<div class="rh-list"></div>';
      box.querySelector(".rh-clear").onclick = function (e) {
        e.stopPropagation();
        RUN_HISTORY.length = 0;                 // 只清记录，当前输出与 AI 分析用的缓冲仍保留
        if (viewHist) viewLive();               // 正在回看历史 → 回到实时输出
        histRender();
        toast("运行记录已清空", "ok");
      };
      ($("bottomPanel") || document.body).appendChild(box);   // 挂到底部面板内：随面板显隐并定位在其右侧
    }
    var list = box.querySelector(".rh-list");
    list.innerHTML = "";
    if (!RUN_HISTORY.length) { box.style.display = "none"; return; }
    box.style.display = "";
    RUN_HISTORY.forEach(function(rec) {
      var item = document.createElement("div");
      item.className = "rh-item" + (rec === viewHist ? " on" : "");
      var dot = document.createElement("span");
      dot.className = "rh-dot " + (rec.running ? "run" : (rec.exit === 0 ? "ok" : "err"));
      var nm = document.createElement("span");
      nm.className = "rh-nm";
      nm.textContent = rec.name;
      nm.title = rec.name + " · " +
        (rec.running ? "运行中" : (rec.exit === 0 ? "已完成" : "退出码 " + rec.exit)) +
        "（点击查看该次输出）";
      var tm = document.createElement("span");
      tm.className = "rh-tm";
      tm.textContent = histTime(rec.time);
      item.appendChild(dot); item.appendChild(nm); item.appendChild(tm);
      item.addEventListener("click", function() { viewHistory(rec); });
      list.appendChild(item);
    });
  }

  /* ---------- 底部面板：输出 / 终端 两个页签 ---------- */
  let bottomPane = "output";
  // 上次是否为「用户主动关闭」底部面板：为 true 时，刷新后重连运行任务（前台输出 / 后台日志）不再自动弹出
  let bottomUserClosed = false;
  try {
    if (ideSettingGet("restoreSession", true)) {
      const b = JSON.parse(localStorage.getItem("ide.session.bottom") || "");
      if (b && b.show === false) bottomUserClosed = true;
    }
  } catch (_) { /* 忽略 */ }

  function setBottomPane(name) {
    bottomPane = (name === "term") ? "term" : (name === "log") ? "log" : "output";
    document.querySelectorAll(".bp-tab[data-pane]").forEach(b => b.classList.toggle("active", b.dataset.pane === bottomPane));
    // 切换 pane 时取消其它动态标签的选中态（互斥，避免两个同时高亮）
    if (bottomPane !== "log") document.querySelectorAll(".bp-log-tab").forEach(b => b.classList.remove("active"));
    if (bottomPane !== "term") document.querySelectorAll(".bp-term-tab").forEach(b => b.classList.remove("active"));
    $("paneOutput").classList.toggle("active", bottomPane === "output");
    $("paneTerm").classList.toggle("active", bottomPane === "term");
    $("paneLog").classList.toggle("active", bottomPane === "log");
    if (bottomPane === "term") termEnsure().then(ok => { if (ok) $("termInput").focus(); });
    if (bottomPane === "log") { const lb = $("logBody"); if (lb) lb.scrollTop = lb.scrollHeight; }
    // 切回「输出」页签不再自动复位回看：viewHistory 打开面板时也会走这里，否则会把刚设的 viewHist 冲掉
    bpKillMode();                                      // 右侧按钮随当前标签刷新状态
    // 搜索按钮归「输出」「运行日志」两个页签（终端页签隐藏）
    if (typeof opFindShow === "function") opFindShow(bottomPane === "output" || bottomPane === "log");
    if (typeof sessionSaveBottom === "function") sessionSaveBottom();   // 记住当前标签，刷新后恢复
  }
  function toggleBottom(force, pane) {
    const p = $("bottomPanel");
    const show = (force === undefined) ? !p.classList.contains("show") : !!force;
    if (pane) setBottomPane(pane);
    p.classList.toggle("show", show);
    const bb = $("tbBottom");
    if (bb) bb.classList.toggle("on", show);   // 顶栏底部面板按钮同步高亮
    const sp = $("bpSplitter");
    if (sp) sp.classList.toggle("hidden", !show);      // 分割条随面板一起显隐
    if (show) applyBottomHeight(p.offsetHeight || BP_DEFAULT_H, false);
    refreshAllEditors();                 // 编辑区高度变化，重绘编辑器避免行号错位
    if (show && bottomPane === "term") termEnsure().then(ok => { if (ok) $("termInput").focus(); });
    bottomUserClosed = !show;                                          // 记录用户意图：关了下次刷新就别自动弹
    if (typeof sessionSaveBottom === "function") sessionSaveBottom();   // 记住显隐状态（开 / 关），刷新后恢复
  }
  // 刷新后自动接回运行任务时用：用户上次主动关了底部面板就不打扰
  //（后台仍照常收日志，点「输出 / 任务名」标签可随时查看）
  function autoShowBottom(pane) {
    if (bottomUserClosed) { if (pane) setBottomPane(pane); return; }
    toggleBottom(true, pane);
  }
  function toggleOutput(force) { toggleBottom(force, "output"); }
  function clearOutput() {
    if (typeof opAiReset === "function") opAiReset();  // 清空输出时，AI 分析结论一起清掉
    if (bottomPane === "term") { if (curTerm) curTerm.body.innerHTML = ""; return; }
    if (bottomPane === "log" && currentLogId && LOGS[currentLogId]) {
      LOGS[currentLogId].buf = [];                      // 清当前标签的缓冲与显示
      $("logBody").innerHTML = "";
      if (typeof opFindReset === "function") opFindReset();   // 清空 → 搜索命中计数归零
      return;
    }
    viewHist = null;
    if (curHist) curHist.buf = [];                      // 当前记录的缓存一起清
    $("opBody").innerHTML = "";
    $("bpTitle").textContent = "";
    if (typeof opFindReset === "function") opFindReset();   // 输出清空 → 搜索命中计数归零
    histRender();
  }
  function opLine(text, cls) {
    if (/进程已退出，代码/.test(text || "")) cls = ((cls || "") + " op-result").trim();   // 运行结果单独一类
    if (curHist) histPush(curHist, text, cls);                  // 运行记录缓存
    if (viewHist && viewHist !== curHist) return;               // 正在回看历史：实时行只进缓存
    const body = $("opBody");
    const span = document.createElement("span");
    if (cls) span.className = cls;
    span.textContent = (text || "");
    body.appendChild(span);
    if (typeof opFindNewLine === "function") opFindNewLine(span);   // 搜索条开着时新行实时参与匹配
    body.scrollTop = body.scrollHeight;
  }
  function opLineHtml(html, cls) {
    if (curHist) histPush(curHist, html, cls);
    if (viewHist && viewHist !== curHist) return;
    const body = $("opBody");
    const span = document.createElement("span");
    if (cls) span.className = cls;
    span.innerHTML = html;
    body.appendChild(span);
    if (typeof opFindNewLine === "function") opFindNewLine(span);
    body.scrollTop = body.scrollHeight;
  }

  async function saveQuiet(tab) {
    const r = await fetch("/api/files/save", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: tab.displayPath || tab.path, content: tab.cm.getValue() }),
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    tab.original = tab.cm.getValue(); tab.dirty = false; tab.el.classList.remove("dirty");
    refreshTreeDirty();
  }

  async function runCurrentFile(argsStr) {
    if (!active || !active.cm || active.diff) { toast("请先打开一个可运行的文件", "warn"); return; }
    const target = active.displayPath || active.path;
    const ext = getExt(target);
    if (!RUN_LABELS[ext]) { toast("暂不支持直接运行 ." + ext + " 文件", "warn"); return; }
    if (active.dirty) {
      const ok = await uiConfirm("运行前保存", "文件有未保存的修改，是否先保存再运行？", "保存并运行", false);
      if (!ok) return;
      try { await saveQuiet(active); } catch (e) { toast("保存失败：" + (e.message || e), "err"); return; }
    }
    // 只有「要运行的这个文件本身已经在跑」才需要先停一下 —— 别的项目在跑互不影响。
    // （不能用 RUNBG.id 判断：那只是"当前在看谁的日志"，见 10_ 的 runningTaskFor）
    const prev = runningTaskFor(target);
    if (prev) {
      const ok = await uiConfirm("该文件已有程序在运行",
        "「" + (prev.name || baseName(target)) + "」正在运行：\n" + (prev.target || target) +
        "\n要停止它，再用当前内容重新运行吗？", "停止并重新运行", false);
      if (!ok) return;
      await stopRunTask(prev.id);                      // 按 id 停（可能不是当前在看的那个任务）
      await new Promise(r => setTimeout(r, 500));
    }
    try {
      const r = await fetch("/api/run", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: target, args: argsStr || "", stream: true }),
      });
      const d = await r.json();
      if (d.error) {
        toast("运行失败：" + d.error, "err");
        return;
      }
      startRunStream(d, target, "fg", argsStr);
    } catch (e) {
      toast("运行失败：" + (e.message || e), "err");
    }
  }

  async function runWithArgs() {
    if (!active || !active.cm || active.diff) { toast("请先打开一个可运行的文件", "warn"); return; }
    const s = await uiPrompt("运行参数（按空格分隔）", "", "例如：--verbose input.txt");
    if (s === null) return;
    runCurrentFile(s);
  }

  /* ==================================================================
     运行结束后的「AI 分享项目报错」悬浮框
     · 默认隐藏，只有「运行报错」才自动弹出（平时点工具条「✦ AI 报错」手动打开）；
     · 标题栏可拖动，位置记在 localStorage，松手即固定；
     · 「收起」折叠成一条标题栏（再点展开），「×」完全关闭浮框；
     · 「AI 分享项目报错」把本次命令、退出码与完整输出交给 /api/ai/chat
       流式分析，结论（Markdown）显示在浮框里；「清空」清掉结论。
     ================================================================== */
  var OP_AI = { el: null, busy: false, ac: null, text: "", info: null, pos: null };

  function opAiClip(s, n) {
    s = String(s || "");
    return s.length > n ? s.slice(0, n) + "\n…（输出过长已截断）" : s;
  }

  /* 这次运行算不算「报错」：非 0 退出码 / 手动终止 / 超时；
     退出码为 0 但日志里出现 Traceback、XXXError、[ERROR] 等明显异常时也算。 */
  function opAiHasError(info) {
    if (!info) return false;
    const code = info.exit_code;
    if (code !== 0 && code !== null && code !== undefined) return true;
    if (info.stopped || info.timed_out) return true;
    return /Traceback \(most recent call last\)|\[ERROR\]|\bERROR\b|\bFATAL\b|\bException\b|\b[A-Za-z.]+Error\b/
      .test(String(info.lines || ""));
  }

  function opAiSetCollapsed(collapsed) {
    const box = opAiEnsure();
    if (collapsed) opAiSetMax(false);               // 收起前先还原，避免留下一大片空标题栏
    box.classList.toggle("collapsed", collapsed);
    const fold = box.querySelector(".op-ai-fold");
    fold.title = collapsed ? "展开浮框" : "收起（只留标题栏）";
    fold.innerHTML = '<i class="bi ' + (collapsed ? "bi-chevron-up" : "bi-chevron-down") + '"></i>';
  }

  /* 放大 / 还原：撑满底部面板，长篇 AI 分析不用在小窗里来回滚 */
  function opAiSetMax(on) {
    const box = opAiEnsure();
    box.classList.toggle("max", !!on);
    const btn = box.querySelector(".op-ai-max");
    if (btn) {
      btn.title = on ? "还原大小" : "放大浮框（便于查看长分析）";
      btn.innerHTML = '<i class="bi ' + (on ? "bi-arrows-angle-contract" : "bi-arrows-angle-expand") + '"></i>';
    }
    if (on) opAiSetCollapsed(false);               // 放大时总是展开内容
    try { localStorage.setItem("ide.opai.max", on ? "1" : "0"); } catch (_) { /* 忽略 */ }
  }

  /* 拖标题栏移动浮框：首次拖动把「居中 + transform」切成相对面板的 left/top；
     面板高度可被分隔条调整，所以每次显示时再夹回可视范围。放大态由 CSS 定位，不参与拖动/钳制。 */
  function opAiClamp() {
    const box = OP_AI.el;
    if (!box || !OP_AI.pos || !box.parentNode || box.classList.contains("max")) return;
    const p = box.parentNode;
    const maxX = Math.max(0, p.clientWidth - box.offsetWidth);
    const maxY = Math.max(0, p.clientHeight - box.offsetHeight);
    const x = Math.max(0, Math.min(OP_AI.pos.x, maxX));
    const y = Math.max(0, Math.min(OP_AI.pos.y, maxY));
    OP_AI.pos = { x: x, y: y };
    box.style.left = x + "px";
    box.style.top = y + "px";
  }

  function opAiDrag(box, head) {
    head.addEventListener("mousedown", function (e) {
      if (e.target.closest("button") || box.classList.contains("max")) return;   // 按钮 / 放大态不拖动
      const panel = box.parentNode;
      const pr = panel.getBoundingClientRect();
      const br = box.getBoundingClientRect();
      const dx = e.clientX - br.left, dy = e.clientY - br.top;
      box.style.left = (br.left - pr.left) + "px";
      box.style.top = (br.top - pr.top) + "px";
      box.style.right = "auto";
      box.style.bottom = "auto";
      box.style.transform = "none";
      const move = function (ev) {
        const maxX = Math.max(0, pr.width - box.offsetWidth);
        const maxY = Math.max(0, pr.height - box.offsetHeight);
        const x = Math.max(0, Math.min(ev.clientX - pr.left - dx, maxX));
        const y = Math.max(0, Math.min(ev.clientY - pr.top - dy, maxY));
        OP_AI.pos = { x: x, y: y };
        box.style.left = x + "px";
        box.style.top = y + "px";
      };
      const up = function () {
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
        box.classList.remove("dragging");
        try { localStorage.setItem("ide.opai.pos", JSON.stringify(OP_AI.pos)); } catch (_) { /* 忽略 */ }
      };
      box.classList.add("dragging");
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
      e.preventDefault();
    });
  }

  function opAiEnsure() {
    if (OP_AI.el && OP_AI.el.parentNode) return OP_AI.el;
    const old = document.getElementById("opAiBox");
    if (old) { OP_AI.el = old; return old; }        // 防御：创建过程中被重入时不生成第二个浮框
    const box = document.createElement("div");
    box.id = "opAiBox";
    box.style.display = "none";                     // 默认不打开
    box.innerHTML =
      '<div class="op-ai-hd"><i class="bi bi-stars"></i><span class="op-ai-tt">AI 报错分析</span>' +
        '<span class="op-ai-st"></span><span class="op-ai-flex"></span>' +
        '<button class="op-ai-icon op-ai-max" title="放大浮框（便于查看长分析）"><i class="bi bi-arrows-angle-expand"></i></button>' +
        '<button class="op-ai-icon op-ai-fold" title="收起（只留标题栏）"><i class="bi bi-chevron-down"></i></button>' +
        '<button class="op-ai-icon op-ai-close" title="关闭浮框（工具条 ✦ AI 报错 可再打开）"><i class="bi bi-x-lg"></i></button></div>' +
      '<div class="op-ai-tools">' +
        '<button class="op-ai-btn main op-ai-go"><i class="bi bi-share"></i> AI 分享项目报错</button>' +
        '<button class="op-ai-btn op-ai-clear"><i class="bi bi-trash3"></i> 清空</button>' +
        '<button class="op-ai-btn op-ai-stop" hidden><i class="bi bi-stop-fill"></i> 停止</button>' +
      '</div><div class="op-ai-md"></div>';
    ($("bottomPanel") || document.body).appendChild(box);
    box.querySelector(".op-ai-max").onclick = function () {
      opAiSetMax(!box.classList.contains("max"));
    };
    box.querySelector(".op-ai-fold").onclick = function () {
      opAiSetCollapsed(!box.classList.contains("collapsed"));
    };
    box.querySelector(".op-ai-close").onclick = function () { box.style.display = "none"; };
    box.querySelector(".op-ai-go").onclick = function () { opAiAnalyze(); };
    box.querySelector(".op-ai-clear").onclick = function () { opAiClear(); };
    box.querySelector(".op-ai-stop").onclick = function () { if (OP_AI.ac) OP_AI.ac.abort(); };
    const tabBtn = $("bpAiBtn");
    if (tabBtn) tabBtn.onclick = function () { opAiToggle(); };
    opAiDrag(box, box.querySelector(".op-ai-hd"));
    try {
      const saved = JSON.parse(localStorage.getItem("ide.opai.pos") || "null");
      if (saved && isFinite(saved.x) && isFinite(saved.y)) {
        OP_AI.pos = { x: saved.x, y: saved.y };
        box.style.left = saved.x + "px";
        box.style.top = saved.y + "px";
        box.style.bottom = "auto";
        box.style.transform = "none";
      }
    } catch (_) { /* 隐私模式等，忽略 */ }
    try {
      if (localStorage.getItem("ide.opai.max") === "1") {   // 恢复放大态（不调 opAiSetMax，避免重入创建）
        box.classList.add("max");
        const mb = box.querySelector(".op-ai-max");
        mb.title = "还原大小";
        mb.innerHTML = '<i class="bi bi-arrows-angle-contract"></i>';
      }
    } catch (_) { /* 忽略 */ }
    OP_AI.el = box;
    return box;
  }

  function opAiToggle() {
    const box = opAiEnsure();
    if (box.style.display === "none") {
      box.style.display = "";
      opAiClamp();                                 // 面板尺寸可能变过，夹回可视范围
    } else {
      box.style.display = "none";
    }
  }

  function opAiBusyUI() {
    const box = OP_AI.el;
    if (!box) return;
    const go = box.querySelector(".op-ai-go");
    const stop = box.querySelector(".op-ai-stop");
    if (go) go.disabled = OP_AI.busy;
    if (stop) stop.hidden = !OP_AI.busy;
  }

  function opAiPaint(extra) {
    const md = OP_AI.el && OP_AI.el.querySelector(".op-ai-md");
    if (!md) return;
    md.innerHTML = (typeof aiMd === "function" ? aiMd(OP_AI.text)
                    : esc(OP_AI.text).replace(/\n/g, "<br>")) +
      (extra ? '<div class="op-ai-err">' + esc(extra) + "</div>" : "");
    md.scrollTop = md.scrollHeight;
  }

  function opAiClear() {
    if (OP_AI.ac) { try { OP_AI.ac.abort(); } catch (_) { /* 忽略 */ } OP_AI.ac = null; }
    OP_AI.busy = false; OP_AI.text = "";
    const box = opAiEnsure();
    box.classList.remove("open");
    box.querySelector(".op-ai-md").innerHTML =
      '<div class="op-ai-empty">已清空。点「AI 分享项目报错」可重新分析本次运行输出。</div>';
    opAiBusyUI();
  }

  function opAiReset() {
    if (OP_AI.ac) { try { OP_AI.ac.abort(); } catch (_) { /* 忽略 */ } OP_AI.ac = null; }
    OP_AI.busy = false; OP_AI.text = ""; OP_AI.info = null;
    const box = opAiEnsure();
    box.style.display = "none";
    box.classList.remove("open", "has-err");
    box.querySelector(".op-ai-md").innerHTML = "";
    opAiBusyUI();
  }

  function opAiOnFinish(info) {
    OP_AI.info = info || null;
    opAiClear();                                    // 丢掉上一次的分析结论
    const box = opAiEnsure();
    const hasErr = opAiHasError(info);
    const code = (info && info.exit_code !== null && info.exit_code !== undefined)
      ? info.exit_code : "?";
    box.classList.toggle("has-err", hasErr);
    box.querySelector(".op-ai-st").textContent = hasErr
      ? "运行报错 · 退出码 " + code + " · 可分享给 AI"
      : "运行完成 · 可分析本次输出";
    box.querySelector(".op-ai-md").innerHTML =
      '<div class="op-ai-empty">' +
      (hasErr ? "检测到运行报错，点「AI 分享项目报错」把命令与完整输出交给 AI 分析。"
              : "本次运行成功，也可以把输出交给 AI 分析。") +
      "</div>";
    box.classList.add("open");                     // 展开一行提示，AI 结论稍后写在同一区域
    if (!hasErr) return;                           // 默认不打开：成功运行不自动弹出
    opAiSetCollapsed(false);                      // 报错自动弹出时总是展开
    box.style.display = "";
    opAiClamp();
  }

  async function opAiAnalyze() {
    if (OP_AI.busy) { toast("AI 正在分析，请稍候", "warn"); return; }
    const info = OP_AI.info;
    if (!info) { toast("请先运行一次文件再分析", "warn"); return; }
    const out = opAiClip(info.lines || "", 12000);
    if (!out.trim()) { toast("本次运行没有输出可分析", "warn"); return; }
    const box = opAiEnsure();
    if (typeof sysAiOff === "function" && sysAiOff("chat")) {
      toast("AI 助手对话已在「设置 → 系统 AI」中关闭", "warn");
      box.classList.add("open");
      box.querySelector(".op-ai-md").innerHTML =
        '<div class="op-ai-err">AI 助手对话已在「设置 → 系统 AI」中关闭，开启后即可分析本次报错。</div>';
      return;
    }
    const sys = "你是 IDE 内置的项目报错分析助手。用户会把一次运行的命令、退出码和完整控制台输出给你。" +
      "请用简体中文、按 Markdown 输出：① 报错或异常的根因（引用关键报错行）；② 可能相关的文件与代码位置；" +
      "③ 具体可执行的修复步骤；④ 必要时给出可直接复制的命令或代码。不要复述全部日志，不要编造不存在的报错。";
    const user = "项目文件：" + (info.target || "未知") + "\n运行名称：" + (info.name || "") +
      "\n退出码：" + (info.exit_code === null || info.exit_code === undefined ? "未知" : info.exit_code) +
      "\n用时：" + (info.duration || 0) + "s\n\n本次运行完整输出：\n```text\n" + out + "\n```";
    OP_AI.busy = true; OP_AI.text = "";
    const ac = OP_AI.ac = new AbortController();
    opAiSetCollapsed(false);                       // 若之前收起了，分析时自动展开
    box.classList.add("open");
    box.querySelector(".op-ai-md").innerHTML = "";
    box.querySelector(".op-ai-st").textContent = "AI 分析中…";
    opAiBusyUI();
    try {
      const r = await fetch("/api/ai/chat", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          use_tools: false, perm: "readonly", web_search: false,
          messages: [{ role: "system", content: sys }, { role: "user", content: user }],
        }),
        signal: ac.signal,
      });
      if (!r.ok || !r.body) {
        let msg = "HTTP " + r.status;
        try { const j = await r.json(); msg = j.error || msg; } catch (_) { /* 忽略 */ }
        throw new Error(msg);
      }
      const reader = r.body.getReader(), dec = new TextDecoder();
      let buf = "";
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        buf += dec.decode(part.value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const evt = buf.slice(0, idx); buf = buf.slice(idx + 2);
          const lines = evt.split("\n");
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (line.indexOf("data:") !== 0) continue;
            const data = line.slice(5).trim();
            if (!data || data === "[DONE]") continue;
            let obj; try { obj = JSON.parse(data); } catch (_) { continue; }
            if (obj.error) throw new Error(obj.error);
            if (obj.delta) { OP_AI.text += obj.delta; opAiPaint(); }
          }
        }
      }
      if (!OP_AI.text.trim()) opAiPaint("（AI 没有返回分析内容）");
      box.querySelector(".op-ai-st").textContent = "分析完成 · 可清空后重新分析";
    } catch (e) {
      const msg = (e && e.message) ? e.message : String(e);
      const aborted = (e && e.name === "AbortError") || /abort/i.test(msg);
      if (!aborted) toast("AI 分析失败：" + msg, "err");
      opAiPaint(aborted ? "（已停止分析）" : "分析失败：" + msg);
      box.querySelector(".op-ai-st").textContent = aborted ? "已停止分析" : "分析失败";
    } finally {
      if (OP_AI.ac === ac) OP_AI.ac = null;
      OP_AI.busy = false;
      opAiBusyUI();
    }
  }

  // 页面加载即创建浮框（此时 body.html 已渲染完），工具条「✦ AI 报错」随时可打开
  opAiEnsure();


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
      tip.textContent = "（无输出）\n";
      body.appendChild(tip);
    } else {
      var frag = document.createDocumentFragment();
      rec.buf.forEach(function(l) {
        var s = document.createElement("span");
        if (l.c) s.className = l.c;
        s.textContent = l.m + "\n";
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
      s.textContent = l.m + "\n";
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
        "html.theme-light .rh-tm{color:#9aa0aa}";
      document.head.appendChild(st);
      box = document.createElement("div");
      box.id = "runHistBox";
      box.innerHTML = '<div class="rh-head"><i class="bi bi-clock-history"></i><span>运行记录</span></div>' +
                      '<div class="rh-list"></div>';
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
    if (bottomPane === "output" && typeof viewHist !== "undefined" && viewHist) viewLive();
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
    if (curHist) histPush(curHist, text, cls);                  // 运行记录缓存
    if (viewHist && viewHist !== curHist) return;               // 正在回看历史：实时行只进缓存
    const body = $("opBody");
    const span = document.createElement("span");
    if (cls) span.className = cls;
    span.textContent = (text || "") + "\n";
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
    span.innerHTML = html + "\n";
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


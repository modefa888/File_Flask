  /* ==================================================================
     运行：按扩展名调用本机解释器执行当前文件，输出显示在底部“输出”面板
     ================================================================== */
  const RUN_LABELS = {
    py: "Python 3", js: "Node.js", mjs: "Node.js", cjs: "Node.js",
    sh: "Bash", bash: "Bash", rb: "Ruby", php: "PHP", pl: "Perl", lua: "Lua", r: "R",
  };

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
    bpKillMode();                                      // 右侧按钮随当前标签刷新状态
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
      return;
    }
    $("opBody").innerHTML = "";
    $("bpTitle").textContent = "";
  }
  function opLine(text, cls) {
    const body = $("opBody");
    const span = document.createElement("span");
    if (cls) span.className = cls;
    span.textContent = (text || "") + "\n";
    body.appendChild(span);
    body.scrollTop = body.scrollHeight;
  }
  function opLineHtml(html, cls) {
    const body = $("opBody");
    const span = document.createElement("span");
    if (cls) span.className = cls;
    span.innerHTML = html + "\n";
    body.appendChild(span);
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
    if (RUNBG.id) {
      const ok = await uiConfirm("已有程序在运行",
        "当前正在运行：" + RUNBG.name + "\n要停止它并重新运行吗？", "停止并运行", false);
      if (!ok) return;
      await stopBackground(true);
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


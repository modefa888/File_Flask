  /* ==================================================================
     查找 / 替换（VS Code 风格：Aa 大小写、ab 全字、.* 正则、匹配计数、
     上一个/下一个、可展开替换行、单个替换/全部替换）
     ================================================================== */
  const FF_MAX_MATCHES = 20000;      // 单次最多统计的匹配数，避免超大文件卡顿
  const FIND = {
    open: false, expanded: false,
    caseSensitive: false, wholeWord: false, regex: false,
    inSelection: false, selRange: null,        // 在选定内容中查找
    matches: [], index: -1, marks: [], curMark: null, timer: null, suspend: false,
  };

  const ffWrap = document.createElement("div");
  ffWrap.className = "ff-widget";
  ffWrap.innerHTML =
    '<button class="ff-expand" id="ffExpand" title="展开替换 (Ctrl+H)">›</button>' +
    '<div class="ff-row">' +
      '<input class="ff-input" id="ffFind" placeholder="查找" spellcheck="false" autocomplete="off">' +
      '<button class="ff-opt" data-opt="case" title="区分大小写 (Alt+C)">Aa</button>' +
      '<button class="ff-opt" data-opt="word" title="全字匹配 (Alt+W)">ab</button>' +
      '<button class="ff-opt" data-opt="regex" title="使用正则表达式 (Alt+R)">.*</button>' +
      '<button class="ff-opt" id="ffInSel" title="在选定内容中查找 (Alt+L)"><i class="bi bi-bounding-box"></i></button>' +
      '<span class="ff-count" id="ffCount"></span>' +
      '<button class="ff-nav" id="ffPrev" title="上一个 (Shift+Enter)">↑</button>' +
      '<button class="ff-nav" id="ffNext" title="下一个 (Enter)">↓</button>' +
      '<button class="ff-close" id="ffClose" title="关闭 (Esc)">×</button>' +
    '</div>' +
    '<div class="ff-row ff-replace-row">' +
      '<input class="ff-input" id="ffReplace" placeholder="替换" spellcheck="false" autocomplete="off">' +
      '<button class="ff-btn" id="ffReplaceOne" title="替换当前项">替换</button>' +
      '<button class="ff-btn" id="ffReplaceAll" title="全部替换">全部替换</button>' +
    '</div>';
  edGroups.appendChild(ffWrap);   // 初始挂点；打开查找时会被移入激活标签（见 ffOpen）

  const ffFind = $("ffFind"), ffReplace = $("ffReplace"), ffCount = $("ffCount");

  function ffEscape(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

  // 生成查询：字符串 → 正则；正则模式直接用用户输入（非法时返回 "invalid"）
  function ffQuery() {
    const src = ffFind.value;
    if (!src) return null;
    if (FIND.regex) {
      try { return new RegExp(src, FIND.caseSensitive ? "g" : "gi"); } catch (_) { return "invalid"; }
    }
    let body = ffEscape(src);
    if (FIND.wholeWord) body = "\\b" + body + "\\b";
    try { return new RegExp(body, FIND.caseSensitive ? "g" : "gi"); } catch (_) { return "invalid"; }
  }

  function ffClearMarks() {
    FIND.marks.forEach(m => { try { m.clear(); } catch (_) {} });
    FIND.marks = [];
    if (FIND.curMark) { try { FIND.curMark.clear(); } catch (_) {} FIND.curMark = null; }
  }

  function ffSetCount(text, noMatch) {
    ffCount.textContent = text || "";
    ffFind.classList.toggle("no-match", !!noMatch);
  }

  // 当前光标之后（含）的第一个匹配，与 VS Code 行为一致
  function ffNearestIndex() {
    const cm = active && active.cm;
    if (!cm || !FIND.matches.length) return -1;
    const pos = cm.getCursor("start");
    for (let i = 0; i < FIND.matches.length; i++) {
      const f = FIND.matches[i].from;
      if (f.line > pos.line || (f.line === pos.line && f.ch >= pos.ch)) return i;
    }
    return 0;
  }

  function ffFocusCurrent(scroll) {
    const cm = active && active.cm;
    if (!cm || FIND.index < 0 || !FIND.matches.length) return;
    if (FIND.curMark) { try { FIND.curMark.clear(); } catch (_) {} FIND.curMark = null; }
    const m = FIND.matches[FIND.index];
    FIND.curMark = cm.markText(m.from, m.to, { className: "cm-find-cur" });
    ffSetCount("第 " + (FIND.index + 1) + " 项，共 " + FIND.matches.length + (FIND.capped ? "+" : "") + " 项", false);
    if (scroll !== false) {
      cm.setSelection(m.from, m.to, { scroll: false });
      cm.scrollIntoView({ from: m.from, to: m.to }, 80);
      scrollLineToComfort(cm, m.from.line);     // 匹配行停在视口偏上位置，上方保留上下文
    }
    $("ffPrev").classList.toggle("disabled", FIND.matches.length < 2);
    $("ffNext").classList.toggle("disabled", FIND.matches.length < 2);
  }

  // 全量搜索 + 高亮 + 计数（keep=true 时尽量保持当前项）
  function ffRender(keep) {
    const cm = active && active.cm;
    const prevFrom = (keep && FIND.index >= 0 && FIND.matches[FIND.index]) ? FIND.matches[FIND.index].from : null;
    ffClearMarks();
    FIND.matches = []; FIND.capped = false;
    if (!cm) { ffSetCount(""); return; }
    const q = ffQuery();
    if (!q) { FIND.index = -1; ffSetCount(""); return; }
    if (q === "invalid") { FIND.index = -1; ffSetCount("正则无效", true); return; }
    // 限定在选定区域内查找时，只扫描该范围
    const scope = (FIND.inSelection && FIND.selRange) ? FIND.selRange : null;
    const cur = cm.getSearchCursor(q, scope ? scope.from : { line: 0, ch: 0 });
    while (cur.findNext()) {
      const from = cur.from(), to = cur.to();
      if (scope && (from.line > scope.to.line || (from.line === scope.to.line && from.ch > scope.to.ch))) break;
      if (from.line === to.line && from.ch === to.ch) continue;   // 跳过空匹配
      FIND.matches.push({ from, to });
      FIND.marks.push(cm.markText(from, to, { className: "cm-find-hl" }));
      if (FIND.matches.length >= FF_MAX_MATCHES) { FIND.capped = true; break; }
    }
    if (!FIND.matches.length) { FIND.index = -1; ffSetCount("无结果", true); $("ffPrev").classList.add("disabled"); $("ffNext").classList.add("disabled"); return; }
    if (prevFrom) {
      let i = FIND.matches.findIndex(m => m.from.line === prevFrom.line && m.from.ch === prevFrom.ch);
      FIND.index = i >= 0 ? i : ffNearestIndex();
    } else {
      FIND.index = ffNearestIndex();
    }
    ffFocusCurrent(true);
  }

  function ffDebounced() {
    clearTimeout(FIND.timer);
    FIND.timer = setTimeout(() => { if (FIND.open) ffRender(true); }, 140);
  }

  function ffNext(dir) {
    if (!FIND.open) { ffOpen(false); return; }
    if (!FIND.matches.length) { ffRender(false); if (!FIND.matches.length) return; }
    FIND.index = (FIND.index + dir + FIND.matches.length) % FIND.matches.length;
    ffFocusCurrent(true);
  }

  function ffReplacementFor(text) {
    const rep = ffReplace.value;
    if (!FIND.regex) return rep;
    try { return text.replace(new RegExp(ffFind.value, FIND.caseSensitive ? "" : "i"), rep); }
    catch (_) { return rep; }
  }

  function ffDoReplaceOne() {
    const cm = active && active.cm;
    if (!cm) return;
    if (!FIND.matches.length || FIND.index < 0) { ffRender(false); if (FIND.index < 0) return; }
    const m = FIND.matches[FIND.index];
    const rep = ffReplacementFor(cm.getRange(m.from, m.to));
    FIND.suspend = true;
    cm.replaceRange(rep, m.from, m.to, "ff-replace");
    FIND.suspend = false;
    cm.setCursor({ line: m.from.line, ch: m.from.ch + rep.length });
    ffRender(false);
  }

  function ffDoReplaceAll() {
    const cm = active && active.cm;
    if (!cm) return;
    ffRender(true);
    if (!FIND.matches.length) { toast("没有可替换的内容", "warn"); return; }
    const list = FIND.matches.slice();
    FIND.suspend = true;
    cm.operation(() => {
      for (let i = list.length - 1; i >= 0; i--) {
        const m = list[i];
        cm.replaceRange(ffReplacementFor(cm.getRange(m.from, m.to)), m.from, m.to, "ff-replace");
      }
    });
    FIND.suspend = false;
    toast("已替换 " + list.length + " 处", "ok");
    ffRender(false);
  }

  // 在选定内容中查找：把搜索范围限制在当前选中的文本区间内
  function ffToggleInSelection() {
    const cm = active && active.cm;
    if (!cm) { toast("请先打开一个文件", "warn"); return; }
    if (FIND.inSelection) {
      FIND.inSelection = false; FIND.selRange = null;
    } else {
      const sel = cm.listSelections()[0];
      const from = sel.from(), to = sel.to();
      if (from.line === to.line && from.ch === to.ch) { toast("请先在编辑器中选中一段文本", "warn"); return; }
      FIND.inSelection = true; FIND.selRange = { from, to };
    }
    $("ffInSel").classList.toggle("active", FIND.inSelection);
    $("ffInSel").title = FIND.inSelection ? "取消限定范围（当前仅搜索选中区域）(Alt+L)" : "在选定内容中查找 (Alt+L)";
    if (FIND.open) ffRender(false);
  }

  function ffExpand(on) {
    FIND.expanded = (on === undefined) ? !FIND.expanded : !!on;
    ffWrap.classList.toggle("expanded", FIND.expanded);
    if (FIND.expanded) ffReplace.focus();
  }

  function ffOpen(withReplace) {
    if (!active || !active.cm) { toast("请先打开一个文件", "warn"); return; }
    const sel = active.cm.getSelection();
    if (sel && sel.indexOf("\n") < 0 && sel.length < 200) ffFind.value = sel;   // 用选中文本作查询
    FIND.open = true;
    active.host.appendChild(ffWrap);   // 跟随激活标签所在分屏
    ffWrap.classList.add("show");
    ffExpand(!!withReplace);
    ffFind.focus(); ffFind.select();
    ffRender(false);
  }

  function ffClose() {
    FIND.open = false; FIND.index = -1;
    clearTimeout(FIND.timer);
    ffWrap.classList.remove("show");
    ffClearMarks();
    const cm = active && active.cm;
    if (cm) cm.focus();
  }

  // 事件绑定
  ffFind.addEventListener("input", ffDebounced);
  ffFind.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); ffNext(e.shiftKey ? -1 : 1); }
    else if (e.key === "Escape") { e.preventDefault(); ffClose(); }
    else if (e.altKey && e.key.toLowerCase() === "c") { e.preventDefault(); ffToggleOpt("case"); }
    else if (e.altKey && e.key.toLowerCase() === "w") { e.preventDefault(); ffToggleOpt("word"); }
    else if (e.altKey && e.key.toLowerCase() === "r") { e.preventDefault(); ffToggleOpt("regex"); }
    else if (e.altKey && e.key.toLowerCase() === "l") { e.preventDefault(); ffToggleInSelection(); }
  });
  ffReplace.addEventListener("input", ffDebounced);
  ffReplace.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); ffDoReplaceOne(); }
    else if (e.key === "Escape") { e.preventDefault(); ffClose(); }
  });
  const FF_OPT_KEY = { case: "caseSensitive", word: "wholeWord", regex: "regex" };
  function ffToggleOpt(name) {
    const key = FF_OPT_KEY[name] || name;
    FIND[key] = !FIND[key];
    document.querySelectorAll(".ff-opt[data-opt]").forEach(b => b.classList.toggle("active", !!FIND[FF_OPT_KEY[b.dataset.opt]]));
    ffFind.focus();
    ffRender(false);
  }
  document.querySelectorAll(".ff-opt[data-opt]").forEach(b => { b.onclick = () => ffToggleOpt(b.dataset.opt); });
  $("ffInSel").onclick = ffToggleInSelection;
  $("ffNext").onclick = () => ffNext(1);
  $("ffPrev").onclick = () => ffNext(-1);
  $("ffClose").onclick = ffClose;
  $("ffExpand").onclick = () => ffExpand();
  $("ffReplaceOne").onclick = ffDoReplaceOne;
  $("ffReplaceAll").onclick = ffDoReplaceAll;

  // 标签切换 / 文档变化时同步刷新
  function ffOnTabChange() {
    // 选区范围属于某个文档，切换标签后失效，自动关闭限定
    if (FIND.inSelection) {
      FIND.inSelection = false; FIND.selRange = null;
      $("ffInSel").classList.remove("active");
    }
    if (FIND.open) ffRender(false); else ffClearMarks();
  }
  function ffOnDocChange() { if (FIND.open && !FIND.suspend) ffDebounced(); }

  /* ---------- 保存（带二次确认 + 增删行数） ---------- */
  function computeLineDiff(a, b) {
    // 文件以换行结尾时 split 会产生一个“幽灵空行”，会让纯删除被统计成 +1/-1，先去掉
    const strip = (s) => (s.endsWith("\n") ? s.slice(0, -1) : s);
    const A = strip(a).split("\n"), B = strip(b).split("\n"), n = A.length, m = B.length;
    if ((n + 1) * (m + 1) > 6000000) return null;
    const W = m + 1, dp = new Int32Array((n + 1) * W);
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
      dp[i * W + j] = A[i] === B[j] ? dp[(i + 1) * W + j + 1] + 1 : Math.max(dp[(i + 1) * W + j], dp[i * W + j + 1]);
    let i = 0, j = 0, add = 0, del = 0;
    // 注意：两个分支都必须推进游标，否则遇到“改动行”会死循环（曾导致 Ctrl+S 卡死页面）
    while (i < n && j < m) {
      if (A[i] === B[j]) { i++; j++; }
      else if (dp[(i + 1) * W + j] >= dp[i * W + j + 1]) { del++; i++; }
      else { add++; j++; }
    }
    while (i < n) { del++; i++; } while (j < m) { add++; j++; }
    return { add, del };
  }
  function showSaveConfirm(tab) {
    return new Promise((resolve) => {
      const overlay = $("saveConfirm");
      const diff = computeLineDiff(tab.original, tab.cm.getValue());
      const stats = diff
        ? '<div class="confirm-stats"><span class="cs-add">+ ' + diff.add + ' 行新增</span><span class="cs-del">- ' + diff.del + ' 行删除</span></div><div class="confirm-sub">共 ' + (diff.add + diff.del) + ' 处改动</div>'
        : '<div class="confirm-sub">文件较大，无法精确统计改动行数，仍要保存吗？</div>';
      overlay.innerHTML = '<div class="confirm-modal"><div class="confirm-title"><i class="bi bi-exclamation-triangle"></i> 确认保存修改</div><div class="confirm-body">' + esc(tab.name) + stats + '</div><div class="confirm-actions"><button class="cancel" id="scCancel">取消</button><button class="ok" id="scOk"><i class="bi bi-check-lg"></i> 确认保存</button></div></div>';
      overlay.classList.add("show");
      $("scCancel").onclick = () => { overlay.classList.remove("show"); resolve(false); };
      $("scOk").onclick = () => { overlay.classList.remove("show"); resolve(true); };
    });
  }
  async function saveTab(tab) {
    if (tab && tab.isSheet) { await saveSheetTab(tab); return; }   // 表格视图：走表格保存接口
    if (!tab || !tab.cm) return;
    if (tab.diff) { toast("差异视图为只读，不能保存", "warn"); return; }
    if (!tab.dirty) { toast("没有改动", "warn"); return; }
    if (!(await showSaveConfirm(tab))) return;
    try {
      const r = await fetch("/api/files/save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: tab.path, content: tab.cm.getValue() }) });
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      tab.original = tab.cm.getValue(); tab.dirty = false; tab.el.classList.remove("dirty");
      refreshTreeDirty(); toast("已保存：" + tab.name, "ok");
      if (tab.path === ROOT + "/.gitignore") loadGitignoreRules();   // 保存 .gitignore → 文件树灰色状态实时刷新
    } catch (e) { toast("保存失败：" + (e.message || e), "err"); }
  }

  /* ---------- 资源管理器右键菜单（仿 VS Code：打开/侧边打开/打开方式/文件操作/复制路径） ---------- */
  let ctxTarget = null;
  let treeSel = null;              // 最近点击的树节点：F2 / Delete / Ctrl+Enter 等快捷键的目标
  let fileClip = null;             // 文件剪贴板：{ mode: "cut"|"copy", path, name }
  let compareBase = null;          // 比较基准文件：{ path, name }
  const relPathOf = (p) => (ROOT && p.startsWith(ROOT + "/")) ? p.slice(ROOT.length + 1) : p;

  // 在侧边（新的编辑组）打开当前文件
  async function openFileToSide(path, name) {
    if (groupIds().length >= MAX_GROUPS) { toast("最多拆分 " + MAX_GROUPS + " 个编辑器", "warn"); return; }
    const newGid = tabs.reduce((m, t) => Math.max(m, t.group), -1) + 1;
    registerSplit(curGroup, newGid, "right");
    await openFile(path, name, newGid);
  }
  // 在文件管理器（浏览页）里打开某个目录
  function revealInManager(dir) { window.open("/?path=" + encodeURIComponent(dir), "_blank", "noopener"); }
  // 粘贴：把剪切/复制过的条目移动或复制到目标目录
  async function pasteClip(destDir) {
    if (!fileClip) { toast("剪贴板为空，请先剪切或复制一个文件", "info"); return; }
    const clip = fileClip;
    try {
      const r = await fetch(clip.mode === "cut" ? "/api/move" : "/api/copy", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: clip.path, dest_dir: destDir }),
      });
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      if (clip.mode === "cut") fileClip = null;
      toast((clip.mode === "cut" ? "已移动到：" : "已复制到：") + destDir, "ok");
      refreshTree(destDir);                       // 整树重建，源目录/目标目录都会刷新
    } catch (e) { toast("粘贴失败：" + (e.message || e), "err"); }
  }
  function showCtxMenu(x, y, path, name, isDir) {
    ctxTarget = { path, name, isDir };
    const destDir = isDir ? path : dirName(path);
    const items = [];
    if (isDir) {
      items.push({ label: "在此新建文件", act: () => ctxAction("newfile") });
      items.push({ label: "在此新建文件夹", act: () => ctxAction("newfolder") });
    } else {
      items.push({ label: "打开", sc: "Enter", act: () => ctxAction("open") });
      items.push({ label: "在侧边打开", sc: "Ctrl+Enter", act: () => ctxAction("open-side") });
    }
    items.push({ label: "打开方式…", sub: () => {
      const isSheet = /\.(xlsx|xlsm|xltx|xltm|xls|et|ett|csv|tsv)$/i.test(name);
      const list = [{ label: isSheet ? "表格查看 / 编辑" : "编辑器打开", act: () => openFile(path, name) }];
      if (/\.(csv|tsv)$/i.test(name)) {
        list.push({ label: "以文本编辑器打开", act: () => openFile(path, name, null, true) });
      }
      if (/\.(md|markdown|html|htm)$/i.test(name)) {
        list.push({ label: "渲染预览（Markdown / HTML）", act: async () => { await openFile(path, name); mdSetMode("preview"); } });
      }
      list.push({ label: "浏览器打开（原文件）", act: () => window.open(rawFileUrl(path), "_blank", "noopener") });
      list.push({ label: "在文件管理器中打开", act: () => revealInManager(destDir) });
      return list;
    }});
    // 文件与文件夹都能加进 AI 对话：文件带内容，文件夹带目录结构（只列名称，不读内容）
    // 多选（Ctrl 点选 / Shift 范围选）时对整个选区生效——右键已选中项即批量操作，与 VS Code 一致
    const selItems = treeSelectedItems();
    items.push({
      label: selItems.length > 1
        ? "添加 " + selItems.length + " 项到 AI 对话"
        : (isDir ? "添加到 AI 对话（目录结构）" : "添加到 AI 对话"),
      act: () => selItems.length > 1
        ? aiAddManyFromTree(selItems)
        : aiAddFileFromTree(path, name, isDir),
    });
    if (!isDir) {
      const isBase = !!(compareBase && compareBase.path === path);
      items.push({ divider: true });
      items.push({ label: isBase ? "已选为比较基准（点击取消）" : "选择以进行比较",
        act: () => ctxAction("compare-select") });
      if (compareBase && !isBase) {
        items.push({ label: "与「" + compareBase.name + "」比较", act: () => ctxAction("compare-with") });
      }
      items.push({ label: "打开时间线", act: () => ctxAction("timeline") });
    }
    items.push({ divider: true });
    if (!isDir) {
      items.push({ label: "剪切", sc: "Ctrl+X", act: () => ctxAction("cut") });
      items.push({ label: "复制", sc: "Ctrl+C", act: () => ctxAction("copy") });
    }
    items.push({ label: "粘贴", sc: "Ctrl+V", disabled: !fileClip, act: () => ctxAction("paste") });
    items.push({ divider: true });
    items.push({ label: "复制路径", sc: "Ctrl+Alt+C", act: () => copyText(path) });
    items.push({ label: "复制相对路径", sc: "Ctrl+Shift+Alt+C", act: () => copyText(relPathOf(path)) });
    items.push({ divider: true });
    items.push({ label: "重命名…", sc: "F2", act: () => ctxAction("rename") });
    const selCount = explorerPanel.querySelectorAll(".tree-row.selected").length;
    items.push({ label: selCount > 1 ? ("删除 " + selCount + " 项") : "删除", sc: "Delete", danger: true, act: () => ctxAction("delete") });
    renderDrop(items, null, "tree-ctx", { x, y });
  }
  async function ctxAction(act) {
    if (!ctxTarget) return;
    const { path, name, isDir } = ctxTarget;
    if (act === "open") { openFile(path, name); return; }
    if (act === "open-side") { await openFileToSide(path, name); return; }
    if (act === "reveal") { revealInManager(isDir ? path : dirName(path)); return; }
    if (act === "cut" || act === "copy") {
      fileClip = { mode: act, path, name };
      toast((act === "cut" ? "已剪切：" : "已复制：") + name + "（右键目标文件夹 → 粘贴）", "ok");
      return;
    }
    if (act === "paste") { await pasteClip(isDir ? path : dirName(path)); return; }
    if (act === "compare-select") {
      if (compareBase && compareBase.path === path) { compareBase = null; toast("已取消比较基准", "info"); }
      else { compareBase = { path, name }; toast("已选择「" + name + "」为比较基准，右键另一个文件 → 与已选文件比较", "ok"); }
      return;
    }
    if (act === "compare-with") {
      if (!compareBase) { toast("请先用「选择以进行比较」选一个基准文件", "info"); return; }
      if (compareBase.path === path) { toast("请选择另一个文件进行比较", "warn"); return; }
      openCompareTab(compareBase.path, path);
      return;
    }
    if (act === "timeline") { await openFileTimeline(path, name); return; }
    if (act === "newfile" || act === "newfolder") {
      const nm = await uiPrompt(isDir ? "新建文件夹" : "新建文件", isDir ? "新建文件夹" : "新建文件.txt", "输入名称");
      if (!nm) return;
      const fd = isDir ? path : dirName(path);
      fetch("/api/files/create", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: fd, name: nm, is_dir: act === "newfolder" }) })
        .then(r => r.json()).then(d => { if (d.error) throw new Error(d.error); toast("已创建：" + nm, "ok"); refreshTree(fd); if (act === "newfile") openFile(d.path, nm); })
        .catch(e => toast("创建失败：" + (e.message || e), "err"));
      return;
    }
    if (act === "rename") {
      const nn = await uiPrompt("重命名", name, "输入新名称"); if (!nn || nn === name) return;
      fetch("/api/rename", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path, new_name: nn }) })
        .then(r => r.json()).then(d => { if (d.error) throw new Error(d.error); toast("已重命名", "ok"); refreshTree(dirName(path)); })
        .catch(e => toast("重命名失败：" + (e.message || e), "err"));
      return;
    }
    if (act === "delete") {
      // 多选时批量删除：选中多于一个 → 删除全部选中项；否则删除右键 / 当前项
      const selRows = [...explorerPanel.querySelectorAll(".tree-row.selected")];
      let targets = selRows.length > 1
        ? selRows.map(r => ({ path: r.dataset.path, name: r.dataset.name, isDir: r.dataset.isdir === "1" }))
        : [{ path, name, isDir }];
      // 若同时选中目录与其子项，只保留最上层路径，避免「父目录已移走 → 子项不存在」的多余报错
      const dirPaths = targets.filter(t => t.isDir).map(t => t.path);
      targets = targets.filter(t => !dirPaths.some(dp => t.path !== dp && t.path.startsWith(dp + "/")));
      const isBatch = targets.length > 1;
      const msg = isBatch
        ? "确定删除选中的 " + targets.length + " 个项目吗？此操作不可撤销。"
        : "确定删除 " + name + " ？此操作不可撤销。";
      if (!(await uiConfirm(isBatch ? "批量删除确认" : "删除确认", msg, "删除", true))) return;
      // 请求期间先关掉后台自动刷新的整树重建，保证下面捕获的行引用不会被中途换掉
      holdTreeRefresh(6000);
      // 删除进行中：在树行图标处显示旋转图标，文件真实删除后随行一起消失
      const rows = targets.map(t => {
        const row = document.querySelector('.tree-row[data-path="' + t.path.replace(/"/g, '\\"') + '"]');
        const ic = row ? row.querySelector(".ic") : null;
        if (ic) {
          ic._origHtml = ic.innerHTML;
          ic.innerHTML = '<i class="bi bi-arrow-clockwise tree-delete-spin"></i>';
          row.classList.add("tree-deleting");
        }
        return { row, ic };
      });
      fetch("/api/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paths: targets.map(t => t.path) }) })
        .then(r => r.json()).then(d => {
          if (d.error) throw new Error(d.error);
          // 本端已在 DOM 里精确移除了这些节点：让后台自动刷新跳过整树重建（仅更新签名基线），
          // 避免"删除成功 → 文件列表自己折叠/整树重绘"
          holdTreeRefresh(6000);
          const okCount = (d.deleted || []).length;
          if (d.errors && d.errors.length) {
            toast("已删除 " + okCount + " 项，" + d.errors.length + " 项失败：" + d.errors[0], "warn");
          } else {
            toast(isBatch ? ("已删除 " + okCount + " 项") : ("已删除：" + name), "ok");
          }
          // 直接从树里移除这些节点（目录连子容器），不重拉整棵树，避免展开状态/滚动位置抖动
          // 注意：带引号的属性选择器值不能套 CSS.escape（会把 . 转成 \. 导致匹配失败），直接拼接即可
          for (const { row } of rows) {
            if (!row) continue;
            const kids = row.nextElementSibling;
            if (kids && kids.classList.contains("tree-children")) kids.remove();
            row.remove();
          }
          loadGitStatus();                                    // 只刷新 Git 角标/更改列表，不动树
          targets.forEach(t => closeTabsForDeletedPath(t.path));   // 列表文件被删除时，自动关闭对应编辑标签
        })
        .catch(e => {
          // 删除失败：还原原图标和行状态
          for (const { row, ic } of rows) {
            if (ic) ic.innerHTML = ic._origHtml || "";
            if (row) row.classList.remove("tree-deleting");
          }
          toast("删除失败：" + (e.message || e), "err");
        });
    }
  }
  function closeTabSilent(tab) { tab.host.remove(); const i = tabs.indexOf(tab); if (i >= 0) tabs.splice(i, 1); renderTabsAll(); }

  // 文件 / 目录被删除后自动关闭对应标签页（含目录下所有子文件标签）。
  // 若被关闭的标签中有活动的，则激活同组剩余标签（行为与 closeTab 一致），避免留下空白编辑区。
  function closeTabsForDeletedPath(absPath) {
    absPath = canonPath(absPath);
    const hit = tabs.filter(t => t.path === absPath || t.path.startsWith(absPath + "/"));
    if (!hit.length) return;
    hit.forEach(t => { t.host.remove(); const i = tabs.indexOf(t); if (i >= 0) tabs.splice(i, 1); });
    renderTabsAll();
    const activeHit = hit.find(t => t === active || groupActive.get(t.group) === t);
    if (activeHit) {
      const g = activeHit.group;
      const rest = tabs.filter(t => t.group === g);
      const next = rest[rest.length - 1] || tabs[tabs.length - 1] || null;
      if (next) activate(next);
      else { active = null; groupActive.delete(g); curGroup = 0; $("breadcrumbs").innerHTML = ""; updateStatus(); ffClose(); }
    }
  }

  // AI 助手删除文件后（SSE result 事件的 changes 里 action=deleted），自动关闭对应标签页
  function aiCloseTabsForChanges(changes) {
    (changes || []).forEach(c => {
      if (!c || c.action !== "deleted" || !c.path) return;
      closeTabsForDeletedPath(ROOT + "/" + String(c.path).replace(/\\/g, "/"));
    });
  }

  // 编辑器右键「重命名…」：复用 /api/rename，同步更新标签、树与 Git 状态
  async function renameCurrentFile(path, name) {
    const nn = await uiPrompt("重命名", name, "输入新名称");
    if (!nn || nn === name) return;
    try {
      const r = await fetch("/api/rename", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path, new_name: nn }) });
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      toast("已重命名：" + nn, "ok");
      const op = tabs.find(t => t.path === path);
      if (op) closeTabSilent(op);
      openFile(dirName(path) + "/" + nn, nn);
      refreshTree(dirName(path));
    } catch (e) { toast("重命名失败：" + (e.message || e), "err"); }
  }

  /* ---------- 标签拖拽：组内排序 / 跨组移动（分屏） ---------- */
  let dragTab = null;
  function clearDropHints() {
    document.querySelectorAll(".tab.drop-before, .tab.drop-after").forEach(el => el.classList.remove("drop-before", "drop-after"));
    groupBundles.forEach(b => b.el.classList.remove("drag-over"));
  }
  function setupTabDrag(el, tab) {
    el.draggable = true;
    el.addEventListener("dragstart", (e) => {
      dragTab = tab;
      e.dataTransfer.effectAllowed = "move";
      try { e.dataTransfer.setData("text/plain", tab.path || tab.name); } catch (_) {}
    });
    el.addEventListener("dragend", () => { dragTab = null; clearDropHints(); });
    el.addEventListener("dragover", (e) => {
      if (!dragTab || dragTab === tab) return;
      e.preventDefault(); e.dataTransfer.dropEffect = "move";
      const r = el.getBoundingClientRect();
      const after = e.clientX > r.left + r.width / 2;
      el.classList.toggle("drop-after", after);
      el.classList.toggle("drop-before", !after);
    });
    el.addEventListener("dragleave", () => el.classList.remove("drop-before", "drop-after"));
    el.addEventListener("drop", (e) => {
      if (!dragTab || dragTab === tab) return;
      e.preventDefault(); e.stopPropagation();
      const r = el.getBoundingClientRect();
      const after = e.clientX > r.left + r.width / 2;
      clearDropHints();
      const moved = dragTab; dragTab = null;
      const from = tabs.indexOf(moved);
      if (from < 0) return;
      tabs.splice(from, 1);
      moved.group = tab.group;
      tabs.splice(tabs.indexOf(tab) + (after ? 1 : 0), 0, moved);
      const b = groupBundles.get(moved.group);
      if (b && moved.host.parentElement !== b.wrap) b.wrap.appendChild(moved.host);
      renderTabsAll();
      activate(moved);
    });
  }
  function moveToGroup(tab, g) {
    if (!tab || tab.group === g) return;
    tab.group = g;
    const b = groupBundles.get(g);
    if (b) b.wrap.appendChild(tab.host);
    renderTabsAll();
    activate(tab);
  }
  function setupGroupDrop(zone, g) {
    zone.addEventListener("dragover", (e) => {
      if (!dragTab) return;
      e.preventDefault(); e.dataTransfer.dropEffect = "move";
      zone.classList.add("drag-over");
    });
    zone.addEventListener("dragleave", () => zone.classList.remove("drag-over"));
    zone.addEventListener("drop", (e) => {
      if (!dragTab) return;
      e.preventDefault();
      zone.classList.remove("drag-over");
      const t = dragTab; dragTab = null;
      moveToGroup(t, g);
    });
  }
  /* 拖拽落区与分屏宽度拖动已随组 DOM 动态创建（见 makeGroupDom / makeGroupSplitter） */
  /* 这里曾定义 function refreshTree(dirPath) 做「整树重置」，但它会静默覆盖
     00_preamble.js 里的同名实现（同一 IIFE 内后声明者生效），导致后台自动刷新时
     资源管理器整棵树被折叠。故删除：所有调用统一走 00_preamble 的保状态版本。 */
  // capture 阶段拦截：资源管理器树节点的 click 会 stopPropagation（冒泡阶段收不到），
  // 导致右键菜单点了别处也不消失；改在捕获阶段关闭即可覆盖所有点击。
  // 菜单自身 / 菜单栏的点击除外——它们各自的处理逻辑负责开合，避免误关破坏切换。
  document.addEventListener("click", (e) => {
    if (e.target.closest && (e.target.closest("#menuDrop") || e.target.closest("#menubar"))) return;
    $("ctxMenu").style.display = "none"; closeDrop();
  }, true);

  /* ---------- 自定义弹窗（Webview 下原生 prompt/confirm 不可用） ---------- */
  function uiModal(opts) {
    return new Promise((resolve) => {
      const ov = $("modalOverlay");
      const hasInput = opts.input !== undefined;
      ov.innerHTML =
        '<div class="ide-modal' + (opts.wide ? " wide" : "") + (opts.danger ? " danger" : "") + '">' +
          '<div class="m-title"><i class="bi ' + (opts.icon || "bi-info-circle") + '"></i><span>' + esc(opts.title || "") + "</span></div>" +
          '<div class="m-body">' + (opts.html || '<div class="m-msg">' + esc(opts.msg || "") + "</div>") +
          (hasInput ? '<input id="umInput" spellcheck="false" autocomplete="off">' : "") +
          "</div>" +
          '<div class="m-foot">' +
          (opts.hideCancel ? "" : '<button class="m-cancel" id="umCancel">' + (opts.cancelText || "取消") + "</button>") +
          '<button class="m-ok" id="umOk">' + (opts.okText || "确定") + "</button></div>" +
        "</div>";
      ov.classList.add("show");
      const inp = $("umInput");
      if (inp) { inp.value = opts.input || ""; inp.placeholder = opts.placeholder || ""; }
      const close = (val) => { ov.classList.remove("show"); ov.innerHTML = ""; resolve(val); };
      $("umOk").onclick = () => close(inp ? inp.value.trim() : true);
      if (!opts.hideCancel) $("umCancel").onclick = () => close(inp ? null : false);
      ov.onmousedown = (e) => { if (e.target === ov) close(inp ? null : false); };
      ov.onkeydown = (e) => {
        if (e.key === "Escape") { e.preventDefault(); close(inp ? null : false); }
        else if (e.key === "Enter") { e.preventDefault(); close(inp ? inp.value.trim() : true); }
      };
      (inp || $("umOk")).focus();
      if (inp) inp.select();
    });
  }
  const uiPrompt = (title, value, placeholder) => uiModal({ title, icon: "bi-pencil-square", input: value || "", placeholder: placeholder || "", okText: "确定" });
  const uiConfirm = (title, msg, okText, danger) => uiModal({ title, icon: danger ? "bi-exclamation-triangle" : "bi-question-circle", msg, okText: okText || "确定", danger: !!danger });
  const uiAlert = (title, msg) => uiModal({ title, icon: "bi-info-circle", msg, hideCancel: true, okText: "知道了" });

  /* 轻量二次确认悬浮框：贴着触发元素弹出（下方空间不足自动改上方）。
     点击弹窗外部 / Esc = 取消；返回 Promise<boolean>，用于 Git 面板等高频危险操作 */
  function uiConfirmPop(anchor, opts) {
    return new Promise((resolve) => {
      const old = document.getElementById("uiPopConfirm");
      if (old) old.remove();
      const pop = document.createElement("div");
      pop.className = "ui-pop-confirm" + (opts.danger ? " danger" : "");
      pop.id = "uiPopConfirm";
      pop.innerHTML =
        '<div class="upc-t"><i class="bi ' + (opts.danger ? "bi-exclamation-triangle" : "bi-question-circle") + '"></i><span>' + esc(opts.title || "确认操作") + '</span></div>' +
        '<div class="upc-m">' + esc(opts.msg || "") + '</div>' +
        '<div class="upc-f"><button class="upc-no">取消</button><button class="upc-ok">' + esc(opts.okText || "确定") + '</button></div>';
      document.body.appendChild(pop);
      const r = anchor.getBoundingClientRect();
      const pw = pop.offsetWidth, ph = pop.offsetHeight;
      let left = Math.max(6, Math.min(r.left, window.innerWidth - pw - 8));
      let top = r.bottom + 6;
      if (top + ph > window.innerHeight - 6) top = r.top - ph - 6;
      pop.style.left = left + "px";
      pop.style.top = Math.max(6, top) + "px";
      const done = (v) => {
        pop.remove();
        document.removeEventListener("mousedown", onDoc, true);
        document.removeEventListener("keydown", onKey, true);
        resolve(v);
      };
      const onDoc = (e) => { if (!pop.contains(e.target) && !anchor.contains(e.target)) done(false); };
      const onKey = (e) => { if (e.key === "Escape") done(false); };
      document.addEventListener("mousedown", onDoc, true);
      document.addEventListener("keydown", onKey, true);
      pop.querySelector(".upc-no").onclick = () => done(false);
      pop.querySelector(".upc-ok").onclick = () => done(true);
    });
  }

  /* ---------- 菜单栏动作 ---------- */
  function cmCmd(name) {
    if (!active || !active.cm) { toast("请先打开一个文件", "warn"); return; }
    if (!CodeMirror.commands[name]) { toast("该命令当前不可用", "warn"); return; }
    active.cm.focus();
    active.cm.execCommand(name);
  }
  let fontPx = 13;
  function chFont(delta) {
    fontPx = delta === 0 ? 13 : Math.min(28, Math.max(10, fontPx + delta));
    document.querySelectorAll(".cm-host .CodeMirror").forEach(el => { el.style.fontSize = fontPx + "px"; });
    tabs.forEach(t => { if (t.cm) t.cm.refresh(); });
  }
  function toggleWrap() {
    if (!active || !active.cm) { toast("请先打开一个文件", "warn"); return; }
    const w = !active.cm.getOption("lineWrapping");
    active.cm.setOption("lineWrapping", w);
    toast(w ? "已开启自动换行" : "已关闭自动换行");
  }
  function selCurLine() {
    if (!active || !active.cm) return;
    const l = active.cm.getCursor().line;
    active.cm.setSelection({ line: l, ch: 0 }, { line: l, ch: active.cm.getLine(l).length });
    active.cm.focus();
  }
  async function gotoLine() {
    if (!active || !active.cm) { toast("请先打开一个文件", "warn"); return; }
    const s = await uiPrompt("跳转到行（1 - " + active.cm.lineCount() + "）", "", "输入行号");
    if (s === null) return;
    const n = parseInt(s, 10);
    if (!n || n < 1 || n > active.cm.lineCount()) { if (s) toast("行号无效", "warn"); return; }
    active.cm.setCursor({ line: n - 1, ch: 0 });
    active.cm.focus();
  }
  function openSearch() { showPanel("search"); setSearchMode("name"); $("searchInput").focus(); $("searchInput").select(); }
  function openGrepSearch() { showPanel("search"); setSearchMode("content"); $("searchInput").focus(); $("searchInput").select(); }
  function showShortcuts() {
    const KB = [
      { head: "通用", items: [
        ["Ctrl+S", "保存"], ["Ctrl+W", "关闭标签"], ["Ctrl+N", "新建文件"],
        ["Ctrl+B", "切换侧边栏"], ["Ctrl+P", "搜索文件名"], ["Ctrl+Shift+F", "在文件中搜索内容"],
        ["Ctrl+G", "跳转到行"], ["Ctrl+= / Ctrl+-", "缩放字体"], ["Alt+Z", "切换自动换行"],
        ["Ctrl+Shift+V", "预览 / 返回编辑（Markdown、HTML）"], ["Ctrl+Shift+M", "分屏预览：编辑+预览同时显示"],
        ["Ctrl+\\", "向右拆分编辑器：把当前文件在右侧新组打开（也可点标签栏右侧的分屏图标）"],
        ["Alt+\\", "向下拆分编辑器：把当前文件在下方新组打开（Alt+点击分屏图标同效）"],
        ["拖动分隔条", "拖动两块之间的分隔条调整宽度/高度，双击分隔条恢复均分"],
        ["Ctrl+K S", "保存全部"], ["Ctrl+K W", "关闭全部标签"], ["Ctrl+K U", "关闭已保存的标签"],
        ["标签栏 ⋯", "编辑器操作菜单：暂存更改 / 显示打开的编辑器 / 关闭等"],
        ["编辑器内右键", "撤销重做、剪切复制粘贴、查找替换、转到行、查找所有引用、保存 / 运行、Markdown 预览等"],
        ["资源管理器", "右键：打开 / 在侧边打开 / 打开方式… / 打开所在文件夹 / 选择以进行比较 / 打开时间线 / 剪切复制粘贴 / 复制路径 / 复制相对路径 / 重命名 / 删除"],
        ["资源管理器按键", "选中文件后：Enter 打开，Ctrl+Enter 侧边打开，F2 重命名，Delete 删除，Ctrl+C/X/V 复制剪切粘贴，Ctrl+Alt+C 复制路径，Ctrl+Shift+Alt+C 复制相对路径"],
      ]},
      { head: "运行", items: [
        ["F5", "运行当前文件（日志实时推送，超时可手动转后台）"],
        ["Ctrl+F5", "后台运行（服务模式：Web 服务等常驻程序，不超时、可停止）"],
        ["Ctrl+`", "显示 / 隐藏输出面板　拖动面板上沿可调整高度（双击恢复默认）"],
        ["菜单 · 运行", "运行环境管理…（也可点活动栏「运行环境」图标）"],
      ]},
      { head: "后台任务", items: [
        ["活动栏 · 后台任务", "查看运行中 / 已结束的任务：看日志、停止、清理"],
        ["—", "后台程序不随页面关闭而结束，重启本服务后也会自动接管"],
      ]},
      { head: "终端", items: [
        ["Ctrl+Shift+`", "新建 / 聚焦终端（可多开，最多 6 个）"],
        ["Enter", "执行命令"], ["↑ / ↓", "历史命令"],
        ["Ctrl+L", "清屏"], ["Ctrl+C", "终止当前命令"],
        ["菜单 · 终端", "运行所选文本 / 命令安全策略"],
      ]},
      { head: "查找 / 替换", items: [
        ["Ctrl+F", "查找"], ["Ctrl+H / Ctrl+Alt+F", "替换"],
        ["Enter / Shift+Enter", "下一个 / 上一个"], ["F3 / Shift+F3", "下一个 / 上一个"],
        ["Esc", "关闭"], ["Alt+C / Alt+W / Alt+R", "区分大小写 / 全字匹配 / 正则"],
        ["Alt+L", "在选定内容中查找 / 取消限定"], ["替换行内 Enter", "替换当前项"],
      ]},
    ];
    const html = KB.map(g =>
      '<div class="kb-group"><div class="kb-head">【' + esc(g.head) + '】</div><div class="kb-grid">' +
      g.items.map(it => "<kbd>" + esc(it[0]) + "</kbd><span>" + esc(it[1]) + "</span>").join("") +
      "</div></div>").join("");
    uiModal({ title: "键盘快捷方式", icon: "bi-keyboard", html, wide: true, hideCancel: true, okText: "知道了" });
  }

  /* ---------- 菜单栏下拉（文件/编辑/选择/查看/转到/运行/帮助） ---------- */
  const MENUS = {
    file: [
      { label: "新建文件", sc: "Ctrl+N", icon: "bi-file-earmark-plus", act: () => newInRoot(false) },
      { label: "新建文件夹", icon: "bi-folder-plus", act: () => newInRoot(true) },
      { label: "打开文件夹…", icon: "bi-folder-symlink", act: openFolderDialog },
      { label: "新建项目…", icon: "bi-diagram-3", act: newProjectFlow },
      { label: "最近打开", icon: "bi-clock-history", sub: () => {
          if (!RECENT.length) return [{ label: "（暂无最近打开的文件夹）", icon: "bi-dash", disabled: true }];
          return RECENT.map(f => f.exists ? ({
            label: f.path, icon: "bi-folder2",
            act: () => { location.href = "/ide?path=" + encodeURIComponent(f.path); },
          }) : ({
            label: f.path + "（已失效）", icon: "bi-exclamation-triangle",
            act: async () => {                         // 点击失效项 = 从记录中移除
              await fetch("/api/recent/folders/remove", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ path: f.path }),
              });
              await loadRecentFolders();
              toast("已移除失效记录：" + f.path, "ok");
            },
          }));
        } },
      { divider: true },
      { label: "保存", sc: "Ctrl+S", icon: "bi-check-lg", act: () => active && saveTab(active) },
      { label: "关闭标签", sc: "Ctrl+W", icon: "bi-x-lg", act: () => active && closeTab(active) },
      { divider: true },
      { label: "返回文件管理器", icon: "bi-house", act: () => { location.href = "/"; } },
    ],
    edit: [
      { label: "撤销", sc: "Ctrl+Z", icon: "bi-arrow-counterclockwise", act: () => cmCmd("undo") },
      { label: "重做", sc: "Ctrl+Y", icon: "bi-arrow-clockwise", act: () => cmCmd("redo") },
      { divider: true },
      { label: "查找", sc: "Ctrl+F", icon: "bi-search", act: () => ffOpen(false) },
      { label: "查找下一个", sc: "F3", icon: "bi-arrow-down", act: () => ffNext(1) },
      { label: "查找上一个", sc: "Shift+F3", icon: "bi-arrow-up", act: () => ffNext(-1) },
      { divider: true },
      { label: "替换", sc: "Ctrl+H", icon: "bi-arrow-left-right", act: () => ffOpen(true) },
    ],
    sel: [
      { label: "全选", sc: "Ctrl+A", icon: "bi-textarea-t", act: () => cmCmd("selectAll") },
      { label: "选中当前行", icon: "bi-list-ul", act: selCurLine },
    ],
    view: [
      { label: "放大字体", sc: "Ctrl+=", icon: "bi-zoom-in", act: () => chFont(1) },
      { label: "缩小字体", sc: "Ctrl+-", icon: "bi-zoom-out", act: () => chFont(-1) },
      { label: "重置字体", icon: "bi-aspect-ratio", act: () => chFont(0) },
      { divider: true },
      { label: "切换自动换行", sc: "Alt+Z", icon: "bi-text-paragraph", act: toggleWrap },
      { divider: true },
      { label: "预览：编辑模式", icon: "bi-pencil", act: () => mdSetMode("edit") },
      { label: "预览：分屏（编辑+预览）", sc: "Ctrl+Shift+M", icon: "bi-layout-split", act: () => mdSetMode("split") },
      { label: "预览：预览 / 返回编辑", sc: "Ctrl+Shift+V", icon: "bi-eye", act: mdTogglePreview },
      { divider: true },
      { label: "切换侧边栏", sc: "Ctrl+B", icon: "bi-layout-sidebar", act: toggleSidebar },
    ],
    goto: [
      { label: "跳转到行…", sc: "Ctrl+G", icon: "bi-hash", act: gotoLine },
      { label: "跳转到文件…", sc: "Ctrl+P", icon: "bi-file-earmark", act: openSearch },
    ],
    run: [
      { label: "运行当前文件", sc: "F5", icon: "bi-play-circle", act: () => runCurrentFile() },
      { label: "运行并传入参数…", icon: "bi-sliders", act: runWithArgs },
      { divider: true },
      { label: "后台运行（服务模式）", sc: "Ctrl+F5", icon: "bi-broadcast", act: () => runBackground() },
      { label: "停止运行的程序", icon: "bi-stop-circle", act: () => stopBackground() },
      { label: "后台任务管理…", icon: "bi-play-btn", act: openRunnerPanel },
      { divider: true },
      { label: "运行环境管理…", sc: "", icon: "bi-cpu", act: openEnvPanel },
      { label: "重新检测运行环境", icon: "bi-arrow-clockwise", act: () => { openEnvPanel(); loadEnv(true); } },
      { divider: true },
      { label: "清空输出", icon: "bi-eraser", act: clearOutput },
      { label: "显示 / 隐藏输出面板", sc: "Ctrl+`", icon: "bi-terminal", act: () => toggleOutput() },
    ],
    term: [
      { label: "新建终端", sc: "Ctrl+Shift+`", icon: "bi-terminal", act: () => termNew() },
      { label: "运行所选文本", icon: "bi-play-fill", act: runSelectionInTerminal },
      { label: "终止正在运行的命令", icon: "bi-stop-circle", act: termKill },
      { divider: true },
      { label: "清空当前终端", icon: "bi-eraser", act: () => { if (curTerm) curTerm.body.innerHTML = ""; } },
      { label: "关闭当前终端", icon: "bi-x-lg", act: () => { if (curTerm) closeTerm(curTerm); } },
      { label: "关闭终端面板", icon: "bi-box-arrow-down", act: () => toggleBottom(false) },
      { divider: true },
      { label: "命令安全策略…", icon: "bi-shield-check", act: showTermRules },
    ],
    help: [
      { label: "键盘快捷方式", icon: "bi-keyboard", act: showShortcuts },
      { label: "关于", icon: "bi-info-circle", act: () => uiAlert("关于", "在线项目 IDE\n基于 CodeMirror 的自建轻量代码编辑器\n支持多标签、语法高亮、差异确认保存。") },
    ],
  };

  const menuDrop = $("menuDrop");
  let openMenuKey = null;
  function closeDrop() {
    menuDrop.style.display = "none"; openMenuKey = null;
    document.querySelectorAll(".menubar span, .ed-tools").forEach(s => s.classList.remove("m-open"));
  }
  function renderDrop(items, anchor, key, at) {
    menuDrop.innerHTML = "";
    items.forEach(it => {
      if (it.divider) { const d = document.createElement("div"); d.className = "div"; menuDrop.appendChild(d); return; }
      const el = document.createElement("div");
      el.className = "mi" + (it.danger ? " danger" : "") + (it.disabled ? " disabled" : "");
      const subItems = it.sub ? ((typeof it.sub === "function" ? it.sub() : it.sub) || []) : null;
      el.innerHTML = (it.icon ? '<i class="bi ' + it.icon + '"></i>' : "") + '<span>' + it.label + "</span>" +
        (it.sc ? '<span class="sc">' + it.sc + "</span>" : "") +
        (subItems ? '<span class="sub-arrow"><i class="bi bi-chevron-right"></i></span>' : "");
      if (subItems) {
        // 二级子菜单：hover 展开（如「文件 → 最近打开」）
        el.classList.add("has-sub");
        const sub = document.createElement("div");
        sub.className = "menu-sub";
        subItems.forEach(s => {
          const se = document.createElement("div");
          se.className = "mi" + (s.disabled ? " disabled" : "");
          se.innerHTML = '<i class="bi ' + (s.icon || "bi-folder2") + '"></i><span class="lt-nm">' + esc(s.label) + "</span>";
          if (s.act && !s.disabled) se.onclick = (ev) => { ev.stopPropagation(); closeDrop(); s.act(); };
          sub.appendChild(se);
        });
        el.appendChild(sub);
        // 展开前先量一下：右侧空间不够就翻到左边、下方空间不够就整体上移，
        // 避免子菜单贴着窗口边缘时显示不全
        el.addEventListener("mouseenter", () => {
          sub.classList.remove("open-left");
          sub.style.top = "";
          const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
          if (sub.getBoundingClientRect().right > vw - 6) sub.classList.add("open-left");
          const r = sub.getBoundingClientRect();
          let dy = 0;
          if (r.bottom > vh - 6) dy = Math.min(r.bottom - (vh - 6), Math.max(0, r.top - 6));
          if (dy > 0) sub.style.top = (-5 - dy) + "px";
        });
        el.onclick = (ev) => ev.stopPropagation();       // 父项本身无动作，仅展开子菜单
      } else if (!it.disabled) {
        el.onclick = (ev) => { ev.stopPropagation(); closeDrop(); it.act(); };
      }
      menuDrop.appendChild(el);
    });
    // at = {x, y} 时表示右键菜单，直接以鼠标位置为锚点
    const r = at ? { left: at.x, right: at.x, top: at.y, bottom: at.y } : anchor.getBoundingClientRect();
    menuDrop.style.display = "block";
    // 用真实尺寸定位：原先把菜单宽度写死成 280，菜单实际更窄时右侧会空出一大截
    const mw = menuDrop.offsetWidth, mh = menuDrop.offsetHeight;
    const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
    const left = Math.max(6, Math.min(r.left, vw - mw - 6));
    let top = r.bottom + 2;
    if (top + mh > vh - 6) top = Math.max(6, Math.min(r.top - mh - 2, vh - 6 - mh));   // 贴底触发时向上展开
    menuDrop.style.left = left + "px";
    menuDrop.style.top = top + "px";
    openMenuKey = key;
    if (anchor && anchor.classList) anchor.classList.add("m-open");
  }
  function openDrop(key, anchor) { const items = MENUS[key]; if (!items) return; renderDrop(items, anchor, key); }
  $("menubar").addEventListener("click", (e) => {
    const sp = e.target.closest("span[data-menu]"); if (!sp) return;
    e.stopPropagation();
    const key = sp.dataset.menu;
    if (openMenuKey === key) closeDrop(); else { closeDrop(); openDrop(key, sp); }
  });
  $("menubar").addEventListener("mouseover", (e) => {
    const sp = e.target.closest("span[data-menu]");
    if (!sp || !openMenuKey || openMenuKey === sp.dataset.menu) return;
    closeDrop(); openDrop(sp.dataset.menu, sp);
  });

  /* ---------- 编辑器组操作菜单（标签栏右上角 ⋯，仿 VS Code） ---------- */
  /* 拆分编辑器：把当前组的活动文件复制到一个新的编辑组（同 VS Code，最多 4 组）
     dir = "right" 向右拆分（默认，Ctrl+\）；dir = "down" 向下拆分（Alt+\ 或 Alt+点拆分按钮） */
  const MAX_GROUPS = 4;
  async function splitEditor(gid, dir) {
    const g = gid == null ? curGroup : gid;
    const src = groupActive.get(g) || tabs.filter(t => t.group === g).pop() || active;
    if (!src) { toast("先打开一个文件，再拆分编辑器", "info"); return; }
    if (src.noSplit) { toast("该视图无法拆分", "info"); return; }   // 插件声明禁止拆分
    if (groupIds().length >= MAX_GROUPS) { toast("最多拆分 " + MAX_GROUPS + " 个编辑器", "warn"); return; }
    const newGid = tabs.reduce((m, t) => Math.max(m, t.group), -1) + 1;
    const sdir = dir === "down" ? "down" : "right";
    // 其它内部虚拟标签（设置页 \u0000settings、差异 / 更改汇总视图 path 含 \u0001 等）：
    // path 不是真实文件，按路径 openFile 必然会报「路径不存在或不是文件」，直接给出提示
    const isInternalVirtual = !src.pluginView &&
      (src.diff || src.allDiff || (typeof src.path === "string" && src.path.charCodeAt(0) < 32));
    if (isInternalVirtual) { toast("该视图不支持拆分", "info"); return; }
    registerSplit(g, newGid, sdir);   // 先登记新组位置，再打开内容
    // 插件自定义视图：path 是虚拟路径（\u0000plugin:…），改用插件登记过的 render 在新组重建一个独立实例
    if (src.pluginView) {
      const IDE = window.IDE;
      const v = (IDE && IDE.editors && typeof IDE.editors.split === "function")
        ? IDE.editors.split(src.pluginViewId, newGid) : null;
      if (!v) toast("该插件视图无法拆分", "warn");
      return;
    }
    await openFile(src.path, src.name, newGid);   // 新组必定新建，不会在两侧来回切换
  }
  async function saveAllTabs() {
    const dirty = tabs.filter(t => t.dirty);
    if (!dirty.length) { toast("没有未保存的修改", "info"); return; }
    for (const t of dirty) await saveTab(t);
  }
  async function closeGroupTabs(g, onlySaved) {
    const list = tabs.filter(t => t.group === g && (!onlySaved || !t.dirty));
    for (const t of list) { if (tabs.includes(t)) await closeTab(t); }
  }
  function openEditorMenu(anchor, g) {
    const items = [
      { label: "向右拆分编辑器", sc: "Ctrl+\\", icon: "bi-layout-split", act: () => splitEditor(g, "right") },
      { label: "向下拆分编辑器", sc: "Alt+\\", icon: "bi-distribute-vertical", act: () => splitEditor(g, "down") },
      { label: "暂存更改", icon: "bi-plus-lg", disabled: !gitState.isRepo,
        act: () => gitPost("/api/git/stage", { repo: gitState.repo, all: true }, "已暂存所有更改") },
      { label: "显示打开的编辑器", icon: "bi-collection", sub: () =>
          tabs.length
            ? tabs.map(t => ({
                label: groupLabel(t.group) + t.name + (t.dirty ? " ●" : ""),
                icon: "bi-file-earmark", act: () => activate(t),
              }))
            : [{ label: "（没有打开的编辑器）", icon: "bi-dash", disabled: true }] },
      { divider: true },
      { label: "全部关闭", sc: "Ctrl+K W", icon: "bi-x-lg", act: () => closeGroupTabs(g) },
      { label: "关闭已保存", sc: "Ctrl+K U", icon: "bi-check2-square", act: () => closeGroupTabs(g, true) },
      { divider: true },
      { label: "保存全部", sc: "Ctrl+K S", icon: "bi-save", act: saveAllTabs },
    ];
    renderDrop(items, anchor, "edtools" + g);
  }

  /* ---------- 编辑器区域右键菜单（仿 VS Code，无图标、右侧显示快捷键） ---------- */
  // 光标处（或选中）的单词，「查找所有引用」用它做全项目搜索
  function wordAtCursor(cm) {
    if (!cm) return "";
    const sel = cm.getSelection();
    if (sel && !/\s/.test(sel.trim())) return sel.trim();
    try {
      const range = cm.findWordAt(cm.getCursor());
      return cm.getRange(range.anchor, range.head).trim();
    } catch (_) { return ""; }
  }
  function findReferencesOf(tab) {
    const w = wordAtCursor(tab && tab.cm);
    if (!w) { toast("请先把光标放在单词上，或选中一段文字", "info"); return; }
    showPanel("search");
    setSearchMode("content");
    $("searchInput").value = w;
    runSearch(w);
  }
  async function pasteIntoEditor(tab) {
    if (!tab || !tab.cm) return;
    try {
      const text = await navigator.clipboard.readText();
      if (text) tab.cm.replaceSelection(text);
      tab.cm.focus();
    } catch (_) {
      toast("浏览器未授权读取剪贴板，请用 Ctrl+V 粘贴", "warn");
    }
  }
  function openEditorCtxMenu(tab, x, y) {
    const cm = tab.cm;
    const ro = !!tab.diff;                                    // 差异视图只读
    const hasSel = !!(cm && cm.somethingSelected());
    const isMd = ["md", "markdown"].includes(getExt(tab.name));
    const items = [];
    if (!ro) {
      items.push({ label: "撤销", sc: "Ctrl+Z", disabled: !cm, act: () => { cm.undo(); cm.focus(); } });
      items.push({ label: "重做", sc: "Ctrl+Y", disabled: !cm, act: () => { cm.redo(); cm.focus(); } });
      items.push({ divider: true });
      items.push({ label: "剪切", sc: "Ctrl+X", disabled: !hasSel, act: () => { copyText(cm.getSelection()); cm.replaceSelection(""); cm.focus(); } });
      items.push({ label: "复制", sc: "Ctrl+C", disabled: !hasSel, act: () => copyText(cm.getSelection()) });
      items.push({ label: "粘贴", sc: "Ctrl+V", disabled: !cm, act: () => pasteIntoEditor(tab) });
      items.push({ divider: true });
    } else if (hasSel) {
      items.push({ label: "复制", sc: "Ctrl+C", act: () => copyText(cm.getSelection()) });
      items.push({ divider: true });
    }
    items.push({ label: "全选", sc: "Ctrl+A", disabled: !cm, act: () => { cm.execCommand("selectAll"); cm.focus(); } });
    items.push({ label: "查找", sc: "Ctrl+F", act: () => { activate(tab); ffOpen(false); } });
    items.push({ label: "替换", sc: "Ctrl+H", disabled: ro, act: () => { activate(tab); ffOpen(true); } });
    items.push({ label: "转到行…", sc: "Ctrl+G", act: () => { activate(tab); gotoLine(); } });
    items.push({ divider: true });
    items.push({ label: "查找所有引用", sc: "Shift+Alt+F12", disabled: ro,
      act: () => { activate(tab); findReferencesOf(tab); } });
    // 文件级操作：与资源管理器右键菜单能力对齐（编辑器内文件定位/重命名/复制路径/历史）
    if (!tab.diff && !tab.displayPath) {
      const p = tab.path, n = tab.name;
      items.push({ divider: true });
      items.push({ label: "打开时间线", act: () => openFileTimeline(p, n) });
      items.push({ label: "复制路径", sc: "Ctrl+Alt+C", act: () => copyText(p) });
      items.push({ label: "复制相对路径", sc: "Ctrl+Shift+Alt+C", act: () => copyText(relPathOf(p)) });
      items.push({ divider: true });
      items.push({ label: "重命名…", sc: "F2", act: () => renameCurrentFile(p, n) });
    }
    if (!ro) {
      items.push({ label: "保存", sc: "Ctrl+S", act: () => saveTab(tab) });
      items.push({ label: "运行当前文件", sc: "F5", act: () => { activate(tab); runCurrentFile(); } });
    }
    if (isMd && !ro) {
      items.push({ divider: true });
      items.push({ label: "Markdown 预览", sc: "Ctrl+Shift+V", act: () => { activate(tab); mdTogglePreview(); } });
      items.push({ label: "Markdown 分屏预览", sc: "Ctrl+Shift+M", act: () => { activate(tab); mdSetMode("split"); } });
    }
    items.push({ divider: true });
    items.push({ label: "键盘快捷方式…", act: showShortcuts });
    renderDrop(items, null, "editor-ctx", { x, y });
  }
  // 在编辑器（含差异视图）上右键：先激活该标签，再弹出菜单
  edGroups.addEventListener("contextmenu", (e) => {
    const host = e.target && e.target.closest ? e.target.closest(".cm-host") : null;
    if (!host) return;
    const tab = tabs.find(t => t.host === host);
    if (!tab) return;
    e.preventDefault(); e.stopPropagation();
    activate(tab);
    openEditorCtxMenu(tab, e.clientX, e.clientY);
  });
  document.addEventListener("contextmenu", () => closeDrop(), true);   // 在别处右键时收起菜单

  /* ---------- 侧边栏面板切换 ---------- */
  const panels = { explorer: "explorerPanel", search: "searchPanel", git: "gitPanel", run: "runPanel", runner: "runnerPanel", env: "envPanel", ext: "extPanel", dbconn: "dbconnPanel", api: "apiPanel" };
  const titles = { explorer: "资源管理器", search: "搜索", git: "源代码管理", run: "运行和调试", runner: "后台任务", env: "运行环境", ext: "扩展", dbconn: "数据库", api: "API 调试" };
  function showPanel(name) {
    // 未知面板（例如会话恢复时插件面板尚未注册、或插件已被卸载）回退到资源管理器，
    // 否则下面的循环会把所有面板隐藏却没有目标可显示，导致侧栏空白。
    if (!panels[name]) name = "explorer";
    // 统一显式设置显示状态：隐藏时置 none，显示时清空内联样式交给 CSS（搜索面板需要 flex 布局）
    Object.keys(panels).forEach(k => {
      const el = $(panels[k]), on = (k === name);
      el.classList.toggle("active", on);
      el.style.display = on ? "" : "none";
    });
    if (typeof sessionSavePanel === "function") sessionSavePanel(name);
    $("sideTitle").textContent = titles[name];
    document.querySelectorAll(".activitybar .act[data-panel]").forEach(a => a.classList.toggle("active", a.dataset.panel === name));
    // 「新建文件 / 新建文件夹」与项目根目录行只在资源管理器面板显示，其他面板不显示；
    // 端口搜索框只在「后台任务」面板显示
    [$("sideNewFile"), $("sideNewFolder"), $("sideTreeToggle"), $("sideShowAll"), $("sideRefresh"), $("sideRoot")].forEach(b => { if (b) b.style.display = (name === "explorer") ? "" : "none"; });
    if ($("sidePortSearch")) $("sidePortSearch").style.display = (name === "runner") ? "block" : "none";   // CSS 默认隐藏，runner 面板显式放开
    if (name !== "runner") clearTimeout(RUNNER.timer);      // 面板不可见时停止自动刷新
  }
  document.getElementById("activitybar").addEventListener("click", (e) => {
    const a = e.target.closest(".act[data-panel]"); if (!a) return;
    const p = a.dataset.panel;
    // 再点一次当前面板则折叠侧栏
    if (a.classList.contains("active") && !$("sidebar").classList.contains("collapsed") && p === "explorer") { toggleSidebar(); return; }
    $("sidebar").classList.remove("collapsed");
    showPanel(p);
    if (p === "git") loadGitStatus();
    if (p === "run") loadRuntimes();
    if (p === "runner") loadRunnerList().then(runnerTick);
    if (p === "env") loadEnv(false);
    if (p === "dbconn" && typeof loadDbConns === "function") loadDbConns();
    if (p === "api" && typeof loadApiReqs === "function") loadApiReqs();
  });
  function toggleSidebar() {
    $("sidebar").classList.toggle("collapsed");
    const b = $("tbSide");
    if (b) b.classList.toggle("on", !$("sidebar").classList.contains("collapsed"));
  }
  $("sideCollapse").onclick = toggleSidebar;

  /* ---------- 侧边栏宽度拖动（左搜索区 / 右编辑区） ---------- */
  const SIDEBAR_DEFAULT_W = 280;
  function refreshAllEditors() {
    tabs.forEach(t => {
      if (t.cm) t.cm.refresh();
      // 差异视图：窗口宽度变了要重新测量长行宽度，重算底部自定义水平滚动条
      if (t.diff && t.diffView === "diff") refreshDiffScrollbars(t);
    });
  }

  /* ---------- 底部面板高度拖动（输出 / 终端） ---------- */
  const BP_DEFAULT_H = 240;
  function applyBottomHeight(h, save) {
    const bp = $("bottomPanel");
    if (!bp) return 0;
    const ea = document.querySelector(".editorarea");
    const max = Math.max(120, (ea ? ea.clientHeight : window.innerHeight) - 140);   // 至少给编辑区留 140px
    const height = Math.max(80, Math.min(max, Math.round(h)));
    bp.style.height = height + "px";
    if (save) { try { localStorage.setItem("ide.bottomHeight", String(height)); } catch (_) {} }
    return height;
  }
  (function initBpSplitter() {
    const sp = $("bpSplitter");
    if (!sp) return;                       // 元素缺失时直接跳过，避免阻塞后续初始化
    try {
      const saved = parseInt(localStorage.getItem("ide.bottomHeight") || "0", 10);
      if (saved > 0) applyBottomHeight(saved, false);
    } catch (_) {}
    let startY = 0, startH = 0, raf = 0, dragging = false;
    const onMove = (e) => {
      if (!dragging) return;
      if (!(e.buttons & 1)) { onUp(); return; }   // 左键已松开（可能松在 iframe / 窗口外），立即结束拖动
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        applyBottomHeight(startH + (startY - e.clientY), false);   // 向上拖变高
        refreshAllEditors();
      });
      e.preventDefault();
    };
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      sp.classList.remove("dragging");
      document.body.classList.remove("resizing-v");
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      applyBottomHeight($("bottomPanel").offsetHeight, true);
      refreshAllEditors();
    };
    sp.addEventListener("mousedown", (e) => {
      e.preventDefault();
      dragging = true;
      startY = e.clientY;
      startH = $("bottomPanel").offsetHeight || BP_DEFAULT_H;
      sp.classList.add("dragging");
      document.body.classList.add("resizing-v");
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
    sp.addEventListener("dblclick", () => {                 // 双击恢复默认高度
      applyBottomHeight(BP_DEFAULT_H, true);
      refreshAllEditors();
    });
  })();
  function applySidebarWidth(w, save) {
    const sb = $("sidebar");
    const max = Math.max(180, window.innerWidth - 340);        // 至少给编辑区留 340px
    const width = Math.max(172, Math.min(max, Math.round(w))); // 最小 172px：再窄按钮/标题文字会竖排挤压
    sb.style.width = width + "px";
    if (save) { try { localStorage.setItem("ide.sidebarWidth", String(width)); } catch (_) {} }
    return width;
  }
  (function initSplitter() {
    const sp = $("splitter");
    try {
      const saved = parseInt(localStorage.getItem("ide.sidebarWidth") || "0", 10);
      if (saved > 0) applySidebarWidth(saved, false);
    } catch (_) {}
    let dragging = false;
    const onMove = (e) => {
      if (!dragging) return;
      if (!(e.buttons & 1)) { onUp(); return; }   // 左键已松开（可能松在 iframe / 窗口外），立即结束拖动
      const left = $("activitybar").getBoundingClientRect().right;
      applySidebarWidth(e.clientX - left, false);
      e.preventDefault();
    };
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      sp.classList.remove("dragging");
      document.body.classList.remove("resizing");
      try { localStorage.setItem("ide.sidebarWidth", String(parseInt($("sidebar").style.width, 10) || SIDEBAR_DEFAULT_W)); } catch (_) {}
      refreshAllEditors();
    };
    sp.addEventListener("mousedown", (e) => {
      dragging = true;
      sp.classList.add("dragging");
      document.body.classList.add("resizing");
      e.preventDefault();
    });
    sp.addEventListener("dblclick", () => { applySidebarWidth(SIDEBAR_DEFAULT_W, true); refreshAllEditors(); });
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  })();


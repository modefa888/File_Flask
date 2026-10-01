  /* ================================================================
     Quick Open 悬浮命令面板（Ctrl+P，仿 VS Code / Trae）
       · 空输入：功能列表 + 最近打开
       · 纯文本：模糊搜索文件名（/api/search），回车打开；支持 路径:行号
       · :123    跳转当前文件行
       · @符号   跳转当前文件的函数 / 类定义
       · >命令   运行常用命令
     ================================================================ */
  const qoMask = document.createElement("div");
  qoMask.id = "qopen-mask";
  qoMask.innerHTML = '<div id="qopen"><input id="qopen-input" spellcheck="false" autocomplete="off">' +
    '<div id="qopen-list"></div></div>';
  document.body.appendChild(qoMask);
  const qoInput = qoMask.querySelector("#qopen-input");
  const qoList = qoMask.querySelector("#qopen-list");
  qoInput.placeholder = "按名称搜索文件（添加 :行号 转到行，@ 转到符号，> 运行命令）";
  let qoRows = [], qoSel = 0, qoSeq = 0;

  const QO_COMMANDS = [
    ["新建文件", () => newInRoot(false)],
    ["新建文件夹", () => newInRoot(true)],
    ["保存当前文件", () => { if (active) saveTab(active); }],
    ["保存全部", saveAllTabs],
    ["关闭当前标签", () => { if (active) closeTab(active); }],
    ["右侧拆分编辑器", () => splitEditor(null, "right")],
    ["下方拆分编辑器", () => splitEditor(null, "down")],
    ["折叠 / 展开侧边栏", toggleSidebar],
    ["跳转到行", gotoLine],
    ["打开搜索面板", openSearch],
    ["搜索文件内容", () => { showPanel("search"); setSearchMode("content"); $("searchInput").focus(); }],
    ["按文件名搜索", () => { showPanel("search"); setSearchMode("name"); $("searchInput").focus(); }],
    ["打开设置", openSettingsTab],
  ];

  function quickOpen(pre) {
    if (qoMask.classList.contains("open")) { qoClose(); return; }
    qoMask.classList.add("open");
    qoInput.value = pre || "";
    qoRender();
    qoInput.focus();
  }
  function qoClose() { qoMask.classList.remove("open"); qoInput.blur(); }

  function qoSec(title) {
    const d = document.createElement("div");
    d.className = "qo-sec"; d.textContent = title;
    qoList.appendChild(d);
  }
  function qoMsg(text) {
    const d = document.createElement("div");
    d.className = "qo-empty"; d.textContent = text;
    qoList.appendChild(d);
  }
  /* 可选中的行：ic=图标HTML, main=主文本HTML, rest=右侧附加HTML, run=执行 */
  function qoRowEl(ic, main, rest, run) {
    const row = document.createElement("div");
    row.className = "qo-row";
    row.innerHTML = '<span class="ic">' + ic + '</span><span class="qo-main">' + main + '</span>' + (rest || "");
    row.onmouseenter = () => qoSetSel(qoRows.indexOf(qoEntry(row)));
    row.onclick = () => run();
    qoList.appendChild(row);                       // 挂到面板列表（否则行永远不显示）
    const entry = { el: row, run };
    qoRows.push(entry);
    return row;
  }
  function qoEntry(el) { return qoRows.find(r => r.el === el) || { el, run() {} }; }
  function qoSetSel(i) {
    if (!qoRows.length) { qoSel = 0; return; }
    qoSel = Math.max(0, Math.min(i, qoRows.length - 1));
    qoRows.forEach((r, j) => r.el.classList.toggle("sel", j === qoSel));
    qoRows[qoSel].el.scrollIntoView({ block: "nearest" });
  }
  function qoFinish() { qoSetSel(0); }

  /* 空状态：功能列表 + 最近打开 */
  function qoEmptyState() {
    qoSec("功能");
    qoRowEl('<i class="bi bi-search"></i>', "跳转至文件", '<span class="qo-kbd">Ctrl P</span>',
      () => { qoInput.value = ""; qoRender(); qoInput.focus(); });   // 进入文件名搜索模式
    qoRowEl('<i class="bi bi-text-left"></i>', "搜索文件内容", '<span class="qo-kbd">Ctrl Shift F</span>',
      () => { qoClose(); showPanel("search"); setSearchMode("content"); $("searchInput").focus(); });
    qoRowEl('<i class="bi bi-file-text"></i>', "搜索文件名",
      "",
      () => { qoClose(); showPanel("search"); setSearchMode("name"); $("searchInput").focus(); });
    qoRowEl('<i class="bi bi-arrow-right"></i>', "转到行（输入 : 行号）", '<span class="qo-kbd">Ctrl G</span>', () => { qoClose(); gotoLine(); });
    qoRowEl('<i class="bi bi-braces"></i>', "转到符号（输入 @）", "", () => { qoInput.value = "@"; qoRender(); qoInput.focus(); });
    qoRowEl('<i class="bi bi-terminal"></i>', "运行命令（输入 >）", "", () => { qoInput.value = ">"; qoRender(); qoInput.focus(); });
    let rec = [];
    try { rec = JSON.parse(localStorage.getItem("ide.recentFiles") || "[]"); } catch (_) {}
    if (!rec.length) rec = tabs.filter(t => !t.diff).slice(-8).reverse().map(t => ({ path: t.path, name: t.name }));
    if (rec.length) {
      qoSec("最近打开");
      rec.slice(0, 8).forEach(f => qoFileRow(f.path, f.name, null));
    }
    qoFinish();
  }

  function qoFileRow(abs, name, lineNo) {
    const rel = (ROOT && abs.startsWith(ROOT + "/")) ? abs.substring(ROOT.length + 1) : abs;
    const dir = rel.indexOf("/") >= 0 ? rel.substring(0, rel.lastIndexOf("/")) : "";
    const rest = (dir ? '<span class="qo-path">' + esc(dir) + "</span>" : "") +
      (lineNo ? '<span class="qo-kbd">: ' + lineNo + "</span>" : "");
    const row = qoRowEl(iconFor(name, false), esc(name), rest,
      () => { qoClose(); if (lineNo) openFileAt(abs, name, lineNo - 1, 0, 0); else openFile(abs, name); });
    return row;
  }

  /* 文件名模糊搜索（独立 seq 防抖，支持后端 token 轮询） */
  function qoFiles(kw, lineNo) {
    const seq = ++qoSeq;
    if (!kw) { qoEmptyState(); return; }
    qoMsg("搜索中…");
    const params = new URLSearchParams({ root: ROOT, keyword: kw, use_index: "never", timeout: "15", skip: SEARCH_SKIP_DIRS });
    fetch("/api/search?" + params.toString()).then(r => r.json()).then(d => {
      if (seq !== qoSeq) return;
      if (d.error) { qoList.innerHTML = ""; qoRows = []; qoMsg("搜索失败：" + d.error); return; }
      if (d.items) { qoRenderFiles(d.items, lineNo); return; }
      if (d.token) { qoPoll(d.token, seq, lineNo); return; }
      qoRenderFiles([], lineNo);
    }).catch(() => { if (seq === qoSeq) { qoList.innerHTML = ""; qoRows = []; qoMsg("搜索请求失败"); } });
  }
  function qoPoll(token, seq, lineNo) {
    fetch("/api/search/" + encodeURIComponent(token)).then(r => r.json()).then(d => {
      if (seq !== qoSeq || !qoMask.classList.contains("open")) return;
      if (!d.done) { setTimeout(() => qoPoll(token, seq, lineNo), 500); return; }
      if (d.error) { qoList.innerHTML = ""; qoRows = []; qoMsg("搜索失败：" + d.error); return; }
      qoRenderFiles(d.items || [], lineNo);
    }).catch(() => {});
  }
  function qoRenderFiles(items, lineNo) {
    qoList.innerHTML = ""; qoRows = []; qoSel = 0;
    const files = items.filter(it => !it.is_dir && (it.abs_path || it.path));
    if (!files.length) qoMsg("没有匹配的文件");
    files.slice(0, 50).forEach(it => {
      const abs = it.abs_path || it.path;
      qoFileRow(abs, it.name || baseName(abs), lineNo);
    });
    qoFinish();
  }

  /* 当前文件符号（def/class/function） */
  function qoSymbols(kw) {
    const tab = active;
    if (!tab || !tab.cm) { qoMsg("没有已打开的编辑器文件"); return; }
    const re = /^\s*(?:async\s+)?(?:def|class|function)\s+([A-Za-z_]\w*)/;
    const found = [];
    tab.cm.eachLine(l => {
      const m = l.text.match(re);
      if (m) found.push({ name: m[1], line: tab.cm.getLineNumber(l) });
    });
    const hit = found.filter(s => !kw || s.name.toLowerCase().includes(kw));
    if (!hit.length) { qoMsg(kw ? "没有匹配的符号" : "当前文件没有 def / class / function"); qoFinish(); return; }
    hit.slice(0, 100).forEach(s => {
      qoRowEl('<i class="bi bi-braces"></i>', esc(s.name),
        '<span class="qo-path">第 ' + (s.line + 1) + " 行</span>",
        () => { qoClose(); tab.cm.setCursor({ line: s.line, ch: 0 }); tab.cm.focus(); scrollLineToComfort(tab.cm, s.line); });
    });
    qoFinish();
  }

  /* 命令模式 */
  function qoCmds(kw) {
    QO_COMMANDS.filter(c => !kw || c[0].toLowerCase().includes(kw))
      .forEach(c => qoRowEl('<i class="bi bi-arrow-right"></i>', esc(c[0]), "", () => { qoClose(); c[1](); }));
    if (!qoRows.length) qoMsg("没有匹配的命令");
    qoFinish();
  }

  /* 行号模式 */
  function qoLine(str) {
    const n = parseInt(str, 10);
    if (!n || n < 1) { qoMsg("输入行号，如 :42"); return; }
    if (!active) { qoMsg("没有已打开的文件"); return; }
    qoClose();
    openFileAt(active.path, active.name, n - 1, 0, 0);
  }

  function qoRender() {
    const q = qoInput.value;
    qoList.innerHTML = ""; qoRows = []; qoSel = 0;
    if (q.startsWith(">")) { qoCmds(q.slice(1).trim().toLowerCase()); return; }
    if (q.startsWith("@")) { qoSymbols(q.slice(1).trim().toLowerCase()); return; }
    if (q.startsWith(":")) { qoLine(q.slice(1).trim()); return; }
    if (!q.trim()) { qoEmptyState(); return; }
    let kw = q.trim(), lineNo = null;
    const m = kw.match(/^(\S[\s\S]*?)\s*:(\d+)$/);          // 路径:行号
    if (m) { kw = m[1]; lineNo = parseInt(m[2], 10); }
    qoFiles(kw, lineNo);
  }

  qoInput.addEventListener("input", () => qoRender());
  qoInput.addEventListener("keydown", (e) => {
    e.stopPropagation();                       // 面板打开期间屏蔽全局快捷键
    if (e.key === "Escape") { e.preventDefault(); qoClose(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); qoSetSel(qoSel + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); qoSetSel(qoSel - 1); }
    else if (e.key === "Enter") { e.preventDefault(); const r = qoRows[qoSel]; if (r) r.run(); }
  });
  qoMask.addEventListener("mousedown", (e) => { if (e.target === qoMask) qoClose(); });

  /* ---------- 编辑器导航历史（右上角 ← →） ---------- */
  const navHist = { list: [], idx: -1, lock: false };
  function navBtns() {
    $("tbNavBack").disabled = navHist.idx <= 0;
    $("tbNavFwd").disabled = navHist.idx >= navHist.list.length - 1;
  }
  function navPush(path, name) {
    if (navHist.lock) return;
    const cur = navHist.list[navHist.idx];
    if (cur && cur.path === path) return;
    if (cur && active && active.cm) cur.line = active.cm.getCursor().line;   // 记录离开时位置
    navHist.list = navHist.list.slice(0, navHist.idx + 1);
    navHist.list.push({ path, name, line: 0 });
    if (navHist.list.length > 100) navHist.list.shift();
    navHist.idx = navHist.list.length - 1;
    navBtns();
  }
  async function navGo(delta) {
    const target = navHist.list[navHist.idx + delta];
    if (!target) return;
    navHist.idx += delta;
    navHist.lock = true;
    try { await openFileAt(target.path, target.name, target.line || 0, 0, 0); }
    finally { navHist.lock = false; }
    navBtns();
  }
  /* ---------- 专注模式 ---------- */
  let zenSaved = null;
  function toggleZen() {
    const sideVisible = !$("sidebar").classList.contains("collapsed");
    const bottomVisible = $("bottomPanel").classList.contains("show");
    if (!zenSaved) {
      zenSaved = { side: sideVisible, bottom: bottomVisible };
      if (sideVisible) toggleSidebar();
      if (bottomVisible) toggleBottom();
    } else {
      if (zenSaved.side) toggleSidebar();
      if (zenSaved.bottom) toggleBottom();
      zenSaved = null;
    }
  }
  $("tbNavBack").onclick = () => navGo(-1);
  $("tbNavFwd").onclick = () => navGo(1);
  $("tbSide").onclick = () => toggleSidebar();
  $("tbBottom").onclick = () => toggleBottom();
  $("tbZen").onclick = () => toggleZen();
  $("actSettings").onclick = () => openSettingsTab();   // 左下角活动栏齿轮 → 设置标签页


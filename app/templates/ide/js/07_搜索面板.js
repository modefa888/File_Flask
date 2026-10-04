  /* ==================================================================
     搜索面板
       · 内容模式：在文件中搜索（/api/grep），结果按文件分组、可跳转/替换
       · 文件名模式：递归搜索文件名 / 文件夹名（/api/search）
     ================================================================== */
  const SEARCH_SKIP_DIRS = "node_modules,dist,build,out,__pycache__,.venv,venv,.git";
  const SEARCH_MAX_SHOW = 300;        // 文件名模式最多渲染条数
  const GREP_MAX_FILES = 100;         // 内容模式最多渲染的文件数
  let searchMode = "content";
  let searchTimer = null, searchToken = null, searchSeq = 0;
  let searchSkipping = true, searchCase = false, searchWord = false, searchRegex = false;
  let grepData = null;                // 最近一次内容搜索结果（供替换使用）

  function searchHint(text, isErr) {
    const el = $("searchHint");
    el.textContent = text;
    el.classList.toggle("err", !!isErr);
  }

  function renderNameResults(items, duration) {
    const box = $("searchResults");
    box.innerHTML = "";
    const shown = items.slice(0, SEARCH_MAX_SHOW);
    shown.forEach(it => {
      const abs = it.abs_path || it.path || "";
      if (!abs || !abs.startsWith("/")) return;
      const name = it.name || baseName(abs);
      const isDir = !!it.is_dir;
      const rel = abs.startsWith(ROOT + "/") ? abs.substring(ROOT.length + 1) : abs;
      const parent = rel.indexOf("/") >= 0 ? rel.substring(0, rel.lastIndexOf("/")) : "";
      const row = document.createElement("div");
      row.className = "sres";
      row.innerHTML = '<span class="ic">' + iconFor(name, isDir) + '</span>' +
        '<span class="sres-main"><span class="sres-name">' + esc(name) + '</span>' +
        (parent ? '<span class="sres-path">' + esc(parent) + '</span>' : '') + '</span>';
      row.onclick = () => {
        if (isDir) revealInTree(abs);
        else { openFile(abs, name); }
      };
      box.appendChild(row);
    });
    let msg = "共 " + items.length + " 项";
    if (items.length > shown.length) msg += "（仅显示前 " + shown.length + " 项）";
    if (duration) msg += "　用时 " + duration + "s";
    searchHint(msg);
  }

  function pollNameSearch(token, seq) {
    fetch("/api/search/" + encodeURIComponent(token))
      .then(r => r.json())
      .then(d => {
        if (seq !== searchSeq) return;                  // 关键字已变更，丢弃过期结果
        if (!d.done) { setTimeout(() => pollNameSearch(token, seq), 700); return; }
        if (d.error) { searchHint("搜索失败：" + d.error, true); return; }
        renderNameResults(d.items || [], d.duration ? d.duration.toFixed(2) : "");
      })
      .catch(e => { if (seq === searchSeq) searchHint("搜索失败：" + (e.message || e), true); });
  }

  function runNameSearch(kw) {
    const box = $("searchResults");
    const seq = ++searchSeq;
    searchToken = null;
    if (!kw) { box.innerHTML = ""; searchHint("输入关键字，递归搜索项目内的文件名与文件夹名"); return; }
    searchHint("搜索中…");
    // 直接走文件系统遍历：IDE 搜索范围固定在项目根目录，索引对限定 root 的过滤不可靠
    const params = new URLSearchParams({ root: ROOT, keyword: kw, use_index: "never", timeout: "30" });
    if (searchSkipping) params.set("skip", SEARCH_SKIP_DIRS);
    if (searchCase) params.set("case", "1");     // 默认不区分大小写
    fetch("/api/search?" + params.toString())
      .then(r => r.json())
      .then(d => {
        if (seq !== searchSeq) return;
        if (d.error) { searchHint("搜索失败：" + d.error, true); return; }
        if (d.items) { renderNameResults(d.items, d.duration ? d.duration.toFixed(2) : ""); return; }
        if (d.token) { searchToken = d.token; pollNameSearch(d.token, seq); return; }
        searchHint("搜索无结果");
      })
      .catch(e => { if (seq === searchSeq) searchHint("搜索失败：" + (e.message || e), true); });
  }

  /* ---------- 内容搜索 ---------- */
  function isValidRegex(s) { try { new RegExp(s); return true; } catch (_) { return false; } }

  function renderGrepResults(d) {
    const box = $("searchResults");
    box.innerHTML = "";
    grepData = d;
    const files = d.files || [];
    if (!files.length) { searchHint("没有找到匹配结果"); return; }
    files.slice(0, GREP_MAX_FILES).forEach(f => {
      const name = baseName(f.rel);
      const relDir = f.rel.indexOf("/") >= 0 ? f.rel.substring(0, f.rel.lastIndexOf("/")) : "";
      const g = document.createElement("div");
      g.className = "gfile";
      const head = document.createElement("div");
      head.className = "gf-head";
      head.innerHTML = '<i class="bi bi-chevron-down gf-twist"></i>' +
        '<span class="ic">' + iconFor(name, false) + '</span>' +
        '<span class="gf-name">' + esc(name) + '</span>' +
        (relDir ? '<span class="gf-rel">' + esc(relDir) + '</span>' : '') +
        '<span class="gf-count">' + (f.total || f.count) + '</span>' +
        '<button class="gf-rep" title="在本文件全部替换"><i class="bi bi-arrow-repeat"></i></button>';
      const body = document.createElement("div");
      body.className = "gf-body";
      (f.matches || []).forEach(m => {
        const row = document.createElement("div");
        row.className = "gm";
        const off = m.trim || 0;                     // 展示片段相对原始行的偏移
        const at = Math.max(0, m.col - off);
        const before = m.text.slice(0, at);
        const hit = m.text.slice(at, at + m.len);
        const after = m.text.slice(at + m.len);
        row.innerHTML = '<span class="gm-ln">' + m.line + '</span>' +
          '<span class="gm-tx">' + (off > 0 ? '…' : '') + esc(before) +
          '<mark>' + esc(hit) + '</mark>' + esc(after) + '</span>';
        row.onclick = () => openFileAt(f.path, name, m.line - 1, m.col, m.len);
        body.appendChild(row);
      });
      head.querySelector(".gf-rep").onclick = (e) => { e.stopPropagation(); grepReplaceFiles([f]); };
      head.onclick = () => {
        const collapsed = !g.classList.contains("collapsed");
        g.classList.toggle("collapsed", collapsed);
        head.querySelector(".gf-twist").className = "bi " + (collapsed ? "bi-chevron-right" : "bi-chevron-down") + " gf-twist";
      };
      g.appendChild(head);
      g.appendChild(body);
      box.appendChild(g);
    });
    let msg = d.file_count + " 个文件中有 " + d.match_count + " 个结果";
    if (d.file_count > GREP_MAX_FILES) msg += "（仅显示前 " + GREP_MAX_FILES + " 个文件）";
    if (d.truncated) msg += "　结果较多，可能不完整";
    if (d.duration != null) msg += "　用时 " + d.duration + "s";
    searchHint(msg);
  }

  function runGrepSearch(kw) {
    const box = $("searchResults");
    const seq = ++searchSeq;
    grepData = null;
    if (!kw) { box.innerHTML = ""; searchHint("输入关键字，在项目所有文件中搜索内容；结果可点击跳转"); return; }
    if (searchRegex && !isValidRegex(kw)) { box.innerHTML = ""; searchHint("正则表达式无效", true); return; }
    searchHint("搜索中…");
    const params = new URLSearchParams({
      root: ROOT, keyword: kw, timeout: "20",
      max_files: String(GREP_MAX_FILES), per_file: "40",
    });
    if (searchCase) params.set("case", "1");
    if (searchWord) params.set("word", "1");
    if (searchRegex) params.set("regex", "1");
    if (searchSkipping) params.set("skip", SEARCH_SKIP_DIRS);
    fetch("/api/grep?" + params.toString())
      .then(r => r.json())
      .then(d => {
        if (seq !== searchSeq) return;
        if (d.error) { searchHint("搜索失败：" + d.error, true); return; }
        renderGrepResults(d);
      })
      .catch(e => { if (seq === searchSeq) searchHint("搜索失败：" + (e.message || e), true); });
  }

  function runSearch(kw) {
    if (searchMode === "content") runGrepSearch(kw); else runNameSearch(kw);
  }

  /* ---------- 跳转到匹配位置 ---------- */
  // 把指定行滚到视口约 1/3 高度处，保证匹配行上方留出足够上下文（而不是贴在最上/最下边缘）
  function scrollLineToComfort(cm, line, ratio) {
    if (!cm) return;
    const wrap = cm.getWrapperElement();
    const wrapRect = wrap.getBoundingClientRect();
    const lineTop = cm.charCoords({ line: line, ch: 0 }, "window").top;
    const r = (ratio === undefined ? 0.33 : ratio);
    const delta = lineTop - wrapRect.top - wrapRect.height * r;   // 相对当前视口需要滚动的距离
    const info = cm.getScrollInfo();
    cm.scrollTo(null, Math.max(0, Math.round(info.top + delta)));
  }

  async function openFileAt(abs, name, line, col, len) {
    const tab = await openFile(abs, name);
    if (!tab || !tab.cm) return;
    const cm = tab.cm;
    const l = Math.max(0, Math.min(line, cm.lineCount() - 1));
    const ch = Math.max(0, Math.min(col, cm.getLine(l).length));
    const end = Math.min(cm.getLine(l).length, ch + Math.max(1, len || 0));
    cm.setSelection({ line: l, ch }, { line: l, ch: end });
    scrollLineToComfort(cm, l);
    cm.focus();
  }

  /* ---------- 在文件中替换 ---------- */
  function grepReplaceRegex() {
    const kw = $("searchInput").value.trim();
    if (!kw) return null;
    const flags = "g" + (searchCase ? "" : "i");
    try {
      if (searchRegex) return new RegExp(kw, flags);
      let body = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (searchWord) body = "\\b" + body + "\\b";
      return new RegExp(body, flags);
    } catch (_) { return null; }
  }
  function grepReplacementText() {
    const rep = $("replaceInput").value;
    // 非正则模式下替换文本按字面量处理（$ 需转义）
    return searchRegex ? rep : rep.replace(/\$/g, "$$$$");
  }

  async function grepReplaceFiles(files) {
    const re = grepReplaceRegex();
    if (!re) { toast("替换失败：查询条件无效", "err"); return; }
    const targets = [], dirtySkipped = [];
    files.forEach(f => {
      const t = findTab(f.path);
      if (t && t.dirty) { dirtySkipped.push(f.rel); return; }
      targets.push(f);
    });
    if (!targets.length) { toast("匹配的文件都有未保存修改，已跳过", "warn"); return; }
    const total = targets.reduce((s, f) => s + (f.total || f.count || 0), 0);
    const ok = await uiConfirm("全部替换",
      "将在 " + targets.length + " 个文件中替换 " + total + " 处内容。\n\n替换后立即写入磁盘，不可撤销。",
      "全部替换", true);
    if (!ok) return;
    const rep = grepReplacementText();
    let doneFiles = 0, doneHits = 0;
    const failed = [];
    for (const f of targets) {
      try {
        const r = await fetch("/api/preview?path=" + encodeURIComponent(f.path) + "&raw=1");
        if (!r.ok || r.headers.get("X-Preview-Type") !== "text") { failed.push(f.rel); continue; }
        const text = await r.text();
        const hits = (text.match(re) || []).length;
        if (!hits) continue;
        const out = text.replace(re, rep);
        const res = await fetch("/api/files/save", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: f.path, content: out }),
        });
        const d = await res.json();
        if (d.error) { failed.push(f.rel); continue; }
        doneFiles++; doneHits += hits;
        const t = findTab(f.path);
        if (t && t.cm) { t.cm.setValue(out); t.original = out; t.dirty = false; t.el.classList.remove("dirty"); }
      } catch (e) { failed.push(f.rel); }
    }
    refreshTreeDirty();
    if (doneFiles) toast("已在 " + doneFiles + " 个文件中替换 " + doneHits + " 处" +
      (dirtySkipped.length ? "，跳过 " + dirtySkipped.length + " 个有未保存修改的文件" : ""), "ok");
    if (failed.length) toast("失败 " + failed.length + " 个文件：" + failed.slice(0, 3).join("、"), "err");
    const kw = $("searchInput").value.trim();
    if (kw) runSearch(kw);
  }

  /* ---------- 会话持久化：搜索面板状态（刷新后保留） ---------- */
  function sessionSaveSearch() {
    if (!ideSettingGet("restoreSession", true)) return;
    try {
      const state = {
        mode: searchMode,
        kw: $("searchInput").value,
        replace: $("replaceInput") ? $("replaceInput").value : "",
        skipDep: searchSkipping, caseSensitive: searchCase, word: searchWord, regex: searchRegex
      };
      localStorage.setItem("ide.session.search", JSON.stringify(state));
    } catch (_) {}
  }
  function sessionRestoreSearch() {
    if (!ideSettingGet("restoreSession", true)) return;
    let state = null;
    try { state = JSON.parse(localStorage.getItem("ide.session.search") || ""); } catch (_) { state = null; }
    if (!state) return;
    try {
      searchMode = state.mode === "name" ? "name" : "content";
      $("searchPanel").classList.toggle("mode-name", searchMode === "name");
      $("searchPanel").classList.toggle("mode-content", searchMode === "content");
      document.querySelectorAll(".s-mode").forEach(b => b.classList.toggle("active", b.dataset.mode === searchMode));
      $("searchInput").placeholder = searchMode === "content" ? "在文件中搜索…" : "搜索文件名 / 文件夹名…";
      searchSkipping = !!state.skipDep;
      searchCase = !!state.caseSensitive;
      searchWord = !!state.word;
      searchRegex = !!state.regex;
      $("searchSkipDep").classList.toggle("active", searchSkipping);
      $("searchCase").classList.toggle("active", searchCase);
      $("grepWord").classList.toggle("active", searchWord);
      $("grepRegex").classList.toggle("active", searchRegex);
      $("searchInput").value = state.kw || "";
      if ($("replaceInput")) $("replaceInput").value = state.replace || "";
      const kw = ($("searchInput").value || "").trim();
      if (kw) runSearch(kw);
      else searchHint(searchMode === "content"
        ? "输入关键字，在项目所有文件中搜索内容；结果可点击跳转"
        : "输入关键字，递归搜索项目内的文件名与文件夹名");
    } catch (_) {}
  }
  window.sessionRestoreSearch = sessionRestoreSearch;

  if ($("replaceInput")) $("replaceInput").addEventListener("input", () => sessionSaveSearch());

  /* ---------- 模式切换与事件绑定 ---------- */
  function setSearchMode(mode) {
    searchMode = mode === "name" ? "name" : "content";
    $("searchPanel").classList.toggle("mode-name", searchMode === "name");
    $("searchPanel").classList.toggle("mode-content", searchMode === "content");
    document.querySelectorAll(".s-mode").forEach(b => b.classList.toggle("active", b.dataset.mode === searchMode));
    $("searchInput").placeholder = searchMode === "content" ? "在文件中搜索…" : "搜索文件名 / 文件夹名…";
    $("searchResults").innerHTML = "";
    grepData = null;
    const kw = $("searchInput").value.trim();
    if (kw) runSearch(kw);
    else searchHint(searchMode === "content"
      ? "输入关键字，在项目所有文件中搜索内容；结果可点击跳转"
      : "输入关键字，递归搜索项目内的文件名与文件夹名");
    sessionSaveSearch();
  }
  document.querySelectorAll(".s-mode").forEach(b => { b.onclick = () => { setSearchMode(b.dataset.mode); $("searchInput").focus(); }; });
  $("searchInput").addEventListener("input", (e) => {
    const kw = e.target.value.trim();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { runSearch(kw); sessionSaveSearch(); }, 300);
  });
  $("searchSkipDep").onclick = () => {
    searchSkipping = !searchSkipping;
    $("searchSkipDep").classList.toggle("active", searchSkipping);
    const kw = $("searchInput").value.trim();
    if (kw) runSearch(kw);
    sessionSaveSearch();
  };
  $("searchCase").onclick = () => {
    searchCase = !searchCase;
    $("searchCase").classList.toggle("active", searchCase);
    const kw = $("searchInput").value.trim();
    if (kw) runSearch(kw);
    sessionSaveSearch();
  };
  $("grepWord").onclick = () => {
    searchWord = !searchWord;
    $("grepWord").classList.toggle("active", searchWord);
    const kw = $("searchInput").value.trim();
    if (kw) runSearch(kw);
    sessionSaveSearch();
  };
  $("grepRegex").onclick = () => {
    searchRegex = !searchRegex;
    $("grepRegex").classList.toggle("active", searchRegex);
    const kw = $("searchInput").value.trim();
    if (kw) runSearch(kw);
    sessionSaveSearch();
  };
  $("grepReplaceAll").onclick = () => {
    if (searchMode !== "content") return;
    if (!grepData || !grepData.files || !grepData.files.length) { toast("请先搜索出结果", "warn"); return; }
    grepReplaceFiles(grepData.files);
  };

  /* ---------- 结果区自定义迷你横向滚动条 ----------
     长行内容可横向延伸，底部固定一条细滚动条：
     拖动滑块 / 点击轨道即可左右滚动，内容不溢出时自动隐藏 */
  (function () {
    const box = $("searchResults");
    const bar = document.createElement("div");
    bar.className = "s-hscroll";
    const thumb = document.createElement("div");
    thumb.className = "s-hscroll-thumb";
    bar.appendChild(thumb);
    box.after(bar);                        // 固定在结果区正下方（搜索模块底部）

    function update() {
      // 分组标题粘性固定需要知道结果区可视宽度（.gf-head width: var(--sw)）
      box.style.setProperty("--sw", box.clientWidth + "px");
      if (!$("searchPanel").classList.contains("active")) { bar.classList.remove("show"); return; }
      const sw = box.scrollWidth, cw = box.clientWidth;
      if (sw <= cw + 1) { bar.classList.remove("show"); return; }
      bar.classList.add("show");
      const bw = bar.clientWidth;
      const tw = Math.max(24, Math.round(cw / sw * bw));
      const maxScroll = sw - cw;
      const pos = Math.max(0, Math.min(bw - tw, Math.round(box.scrollLeft / maxScroll * (bw - tw))));
      thumb.style.width = tw + "px";
      thumb.style.left = pos + "px";
    }

    // 纵向滚动吸附检测：分组标题吸顶时给分组加 .stuck（驱动标题底部渐隐阴影）
    function updateStuck() {
      const top = box.getBoundingClientRect().top;
      box.querySelectorAll(".gfile").forEach(g => {
        const head = g.firstElementChild;
        if (!head) return;
        const gr = g.getBoundingClientRect();
        const hr = head.getBoundingClientRect();
        g.classList.toggle("stuck", gr.top <= top && gr.bottom > top + hr.height);
      });
    }

    const refresh = () => { update(); updateStuck(); };

    // 拖动滑块滚动
    let drag = null;                       // {startX, sl, maxScroll, maxThumb}
    thumb.addEventListener("pointerdown", (e) => {
      e.preventDefault(); e.stopPropagation();
      thumb.setPointerCapture(e.pointerId);
      thumb.classList.add("dragging");
      const sw = box.scrollWidth, cw = box.clientWidth;
      drag = { startX: e.clientX, sl: box.scrollLeft, maxScroll: sw - cw, maxThumb: bar.clientWidth - thumb.offsetWidth };
    });
    thumb.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.startX;
      box.scrollLeft = Math.max(0, Math.min(drag.maxScroll, drag.sl + dx / drag.maxThumb * drag.maxScroll));
    });
    const endDrag = () => { drag = null; thumb.classList.remove("dragging"); };
    thumb.addEventListener("pointerup", endDrag);
    thumb.addEventListener("pointercancel", endDrag);

    // 点击轨道：滑块跳到点击处（以点击点为中心）
    bar.addEventListener("pointerdown", (e) => {
      if (e.target === thumb) return;
      const r = bar.getBoundingClientRect();
      const sw = box.scrollWidth, cw = box.clientWidth;
      const ratio = (e.clientX - r.left) / r.width;
      box.scrollLeft = Math.max(0, Math.min(sw - cw, ratio * (sw - cw) - cw / 2));
      update();
    });

    box.addEventListener("scroll", refresh, { passive: true });
    window.addEventListener("resize", refresh);
    // 结果重渲染（新搜索/折叠展开/替换完成）后自动刷新滑块状态
    new MutationObserver(refresh).observe(box, { childList: true, subtree: true });
    refresh();

    // 悬停结果行时，若该行高亮关键字在横向可视区外，自动滚动到可见位置（滚到视口左 1/3 处）
    // · 用"鼠标 Y 坐标定位 .gm 行"，而不是 closest('.gm')
    //   —— 因为 .gm 有 overflow:hidden，.gm-tx 里的文字被横向裁剪后，鼠标停在裁剪区时
    //   e.target 已经不是 .gm 的子元素，closest('.gm') 找不到对应行；改成坐标匹配后，
    //   鼠标停在 .gm 可视区、以及右侧延伸的空白/被裁剪文字区，都能正确归属到该行。
    // · 横向不做限制：鼠标只要在 Y 方向对应到某行（不管 X 是在行内、行右侧空白、还是行号栏外）都触发
    // · rAF 节流，避免同一次移动内重复触发 scrollTo
    // · 缓存失效条件：内容变化 / 垂直滚动 / 窗口 resize
    let hoverRow = null, rafId = 0, rowCache = null;
    function buildCache() {
      const brTop = box.getBoundingClientRect().top;
      rowCache = Array.prototype.slice.call(box.querySelectorAll(".gm")).map(r => {
        const rc = r.getBoundingClientRect();
        return { el: r, top: rc.top - brTop, bottom: rc.bottom - brTop };
      });
    }
    function locateRowByY(relY) {   // relY 相对 box 顶部
      if (!rowCache) buildCache();
      for (const it of rowCache) {
        if (relY >= it.top && relY < it.bottom) return it.el;
      }
      return null;
    }
    function clearHover() {
      if (hoverRow) hoverRow = null;
      if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    }
    function ensureMarkVisible() {
      rafId = 0;
      if (!hoverRow) return;
      const mark = hoverRow.querySelector("mark");
      if (!mark) return;
      const mr = mark.getBoundingClientRect();
      if (!mr.width) return;                          // 已折叠/隐藏
      const br = box.getBoundingClientRect();
      const mLeft = mr.left - br.left + box.scrollLeft;   // 关键字相对内容起点
      const mRight = mLeft + mr.width;
      const viewL = box.scrollLeft, viewR = viewL + box.clientWidth;
      if (mLeft >= viewL && mRight <= viewR) return;  // 已完整可见，不再滚
      const target = Math.max(0, Math.min(box.scrollWidth - box.clientWidth, mLeft - box.clientWidth / 3));
      box.scrollTo({ left: target, behavior: "smooth" });
    }
    // 在整个 searchPanel 上监听（而不是 box 上），这样鼠标停在右侧空白、被裁剪的文字、
    // 甚至横向滚动条区域时都能触发；Y 方向仍然只匹配到 .gm 行的位置
    const listenTarget = $("searchPanel") || box;
    listenTarget.addEventListener("mousemove", (e) => {
      const br = box.getBoundingClientRect();
      // 只按 Y 定位对应行；X 不做限制——鼠标停在搜索面板右侧空白、
      // 甚至刚划到编辑器区域时，只要 Y 恰好对齐某个 .gm 行，也让该行关键字滚到可见位置
      if (e.clientY < br.top || e.clientY >= br.bottom) { clearHover(); return; }
      const relY = e.clientY - br.top;
      const row = locateRowByY(relY);
      if (!row) { clearHover(); return; }
      hoverRow = row;
      if (rafId) return;                              // 已经有一帧在排队
      rafId = requestAnimationFrame(ensureMarkVisible);
    });
    // 内容变化（分组展开/折叠、追加分组）时，行位置缓存失效
    new MutationObserver(() => { rowCache = null; })
      .observe(box, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
    // 垂直滚动会改变 .gm 的可视位置，缓存失效
    box.addEventListener("scroll", () => { rowCache = null; });
    window.addEventListener("resize", () => { rowCache = null; });
    // 鼠标离开整个 searchPanel 时清掉缓存
    listenTarget.addEventListener("mouseleave", clearHover);
  })();


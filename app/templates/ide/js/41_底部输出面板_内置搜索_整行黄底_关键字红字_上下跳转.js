/* ==================================================================
   底部面板：内置搜索（🔍）—— 整行黄底 + 行内关键字红字 + 上一个 / 下一个 + 命中计数
   跟随当前页签生效：「输出」= #opBody，「运行日志」= #logBody。
   只匹配已打印出来的内容，运行中新打印的行会实时参与（logPush / opLine 都会通知这里）。
   ================================================================== */
const OPFIND = { kw: "", hits: 0, idx: -1, t: null };

function opFindBody() {
  const pane = (typeof bottomPane !== "undefined") ? bottomPane : "output";
  return pane === "log" ? $("logBody") : (pane === "output" ? $("opBody") : null);
}
function opFindRows() { const b = opFindBody(); return b ? [...b.children] : []; }
function opFindClearPaint() {                        // 去掉两个面板上的黄底 / 红字（命中行通常不多）
  [$("opBody"), $("logBody")].forEach(b => {
    if (b) b.querySelectorAll(".op-hit, .op-hit-on").forEach(el => opFindPaint(el, ""));
  });
}

/* 文本节点级包裹：只拆文本、不动元素结构（行内 <a class="op-link"> 之类照旧可用），
   同时也让选中 / 复制得到的内容与原文完全一致。 */
function opFindPaint(el, kw) {
  if (!el || !el.querySelectorAll) return false;
  el.querySelectorAll(".op-kw").forEach(s => {                  // 先还原上一次的包裹
    const p = s.parentNode;
    if (p) { p.replaceChild(document.createTextNode(s.textContent), s); p.normalize(); }
  });
  el.classList.remove("op-hit", "op-hit-on");
  if (!kw || String(el.textContent || "").toLowerCase().indexOf(kw) < 0) return false;
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
  const nodes = [];
  while (w.nextNode()) nodes.push(w.currentNode);               // 先收集，改写时免得 live 遍历错乱
  let n = 0;
  nodes.forEach(nd => {
    const raw = nd.nodeValue || "";
    const low = raw.toLowerCase();
    if (low.indexOf(kw) < 0) return;
    const frag = document.createDocumentFragment();
    let from = 0, at = low.indexOf(kw);
    while (at >= 0) {
      if (at > from) frag.appendChild(document.createTextNode(raw.slice(from, at)));
      const s = document.createElement("span");
      s.className = "op-kw";
      s.textContent = raw.slice(at, at + kw.length);
      frag.appendChild(s);
      n++;
      from = at + kw.length;
      at = low.indexOf(kw, from);
    }
    if (from < raw.length) frag.appendChild(document.createTextNode(raw.slice(from)));
    if (nd.parentNode) nd.parentNode.replaceChild(frag, nd);
  });
  return n > 0;
}
function opFindNum() {
  const el = $("opFindNum");
  if (!el) return;
  const t = (OPFIND.hits ? (OPFIND.idx + 1) : 0) + "/" + OPFIND.hits;
  if (el.textContent !== t) el.textContent = t;
}
function opFindScan(reset) {                                    // 全量重扫（改关键字 / 重开搜索条）
  const body = opFindBody();
  if (!body) return;
  OPFIND.kw = String(OPFIND.kw || "").trim().toLowerCase();
  let hits = 0;
  opFindRows().forEach(el => { if (opFindPaint(el, OPFIND.kw)) { el.classList.add("op-hit"); hits++; } });
  OPFIND.hits = hits;
  OPFIND.idx = hits ? (reset ? 0 : Math.min(Math.max(OPFIND.idx, 0), hits - 1)) : -1;
  if (hits) opFindGoto(OPFIND.idx, true);
  else opFindNum();
}
function opFindGoto(i) {                                        // 跳到第 i 个命中（取模循环）
  const body = opFindBody();
  if (!body) return;
  const hits = [...body.querySelectorAll(".op-hit")];
  OPFIND.hits = hits.length;
  if (!hits.length) { OPFIND.idx = -1; opFindNum(); return; }
  OPFIND.idx = ((i % hits.length) + hits.length) % hits.length;
  hits.forEach((el, k) => el.classList.toggle("op-hit-on", k === OPFIND.idx));
  const el = hits[OPFIND.idx];
  const er = el.getBoundingClientRect(), br = body.getBoundingClientRect();
  body.scrollTop += (er.top - br.top) - (body.clientHeight - er.height) / 2;   // 命中行滚到中间
  opFindNum();
}
function opFindNewLine(span) {                                  // 新打印的行：搜索条开着就实时参与匹配
  if (!span || !OPFIND.kw) return;
  const box = $("opFind");
  if (!box || box.hidden) return;
  if (span.parentNode !== opFindBody()) return;                 // 只统计当前页签那个面板的行，计数才对得上
  if (opFindPaint(span, OPFIND.kw)) { span.classList.add("op-hit"); OPFIND.hits++; opFindNum(); }
}
function opFindDropLine(span) {                                 // 超上限被淘汰的命中行：计数跟着减
  if (!span || !OPFIND.hits) return;
  if (span.parentNode !== opFindBody()) return;
  if (span.classList.contains("op-hit") || span.classList.contains("op-hit-on")) { OPFIND.hits--; opFindNum(); }
}
function opFindReset() {                                        // 清空输出后：计数归零（关键字保留）
  OPFIND.hits = 0; OPFIND.idx = -1;
  opFindNum();
}
function opFindOpen() {
  const box = $("opFind");
  if (!box) return;
  box.hidden = false;
  const btn = $("opFindBtn");
  if (btn) btn.style.display = "none";          // 搜索条已展开：按钮让位，窄面板 / 矮面板下也点得到「清空」
  const inp = $("opFindIn");
  if (inp) {
    if (inp.value !== OPFIND.kw) inp.value = OPFIND.kw;
    inp.focus();
    inp.select();
  }
  if (OPFIND.kw) opFindScan(false);
}
function opFindClose() {
  const box = $("opFind");
  if (box) box.hidden = true;
  const btn = $("opFindBtn");
  // 只有「输出 / 运行日志」页签才需要这个按钮（终端页签不显示）
  if (btn && (typeof bottomPane === "undefined" || bottomPane === "output" || bottomPane === "log")) {
    btn.style.display = "";
  }
  OPFIND.kw = ""; OPFIND.hits = 0; OPFIND.idx = -1;
  opFindClearPaint();                                            // 去掉黄底与红字
  opFindNum();
}
function opFindRescan() {                                        // 切页签 / 重绘缓冲后：搜索条开着就重扫
  const box = $("opFind");
  if (box && !box.hidden && OPFIND.kw) opFindScan(false);
}
/* 页签切换：「输出」「运行日志」两个页签都能搜（终端没有日志文本，隐藏按钮与搜索条）。
   目标面板变了 → 先清掉旧面板的高亮，搜索条还开着就在新面板上重扫一遍。 */
function opFindShow(keep) {
  const btn = $("opFindBtn"), box = $("opFind");
  if (!keep && box) box.hidden = true;
  // 搜索条开着时不显示「搜索」按钮（避免和输入框抢位置）
  if (btn) btn.style.display = (keep && box && box.hidden) ? "" : "none";
  opFindClearPaint();
  if (box && !box.hidden && OPFIND.kw) opFindScan(false);
  else { OPFIND.hits = 0; OPFIND.idx = -1; opFindNum(); }
}
(function opFindInit() {
  const btn = $("opFindBtn");
  if (btn) btn.onclick = () => opFindOpen();
  const closeEl = $("opFindClose");
  if (closeEl) closeEl.onclick = () => opFindClose();
  const prevEl = $("opFindPrev");
  if (prevEl) prevEl.onclick = () => opFindGoto(OPFIND.idx - 1);
  const nextEl = $("opFindNext");
  if (nextEl) nextEl.onclick = () => opFindGoto(OPFIND.idx + 1);
  const inp = $("opFindIn");
  if (inp) {
    inp.addEventListener("input", () => {                        // 防抖：输出多时别每敲一个字就全量重扫
      OPFIND.kw = inp.value;
      clearTimeout(OPFIND.t);
      OPFIND.t = setTimeout(() => opFindScan(true), 120);
    });
    inp.addEventListener("keydown", e => {
      const back = e.shiftKey ? -1 : 1;
      if (e.key === "Enter" || e.key === "F3") { e.preventDefault(); opFindGoto(OPFIND.idx + back); }
      else if (e.key === "Escape") { e.preventDefault(); opFindClose(); }
    });
  }
  opFindShow(bottomPane === "output" || bottomPane === "log");
})();

  /* ===== 消息下方「文件变更」模块：任务完成（或中途停止）后展示本次改动的文件 ===== */
  const AI_CHG_ICON = {
    created: ["bi-file-earmark-plus", "add", "新建"],
    modified: ["bi-pencil-square", "mod", "修改"],
    deleted: ["bi-file-earmark-x", "del", "删除"],
  };
  function aiChangesBox(m, mi) {
    const list = (m.changes || []).filter(c => c && c.path);
    if (!list.length) return null;
    // 同一文件多次改动（新建 + 多次修改）合成一个胶囊：动作取净效果，差异看全部操作
    const groups = new Map();
    list.forEach(c => {
      let g = groups.get(c.path);
      if (!g) { g = { first: c, last: c, ops: [] }; groups.set(c.path, g); }
      g.last = c; g.ops.push(c);
    });
    const items = [];
    groups.forEach((g, path) => {
      if (g.last.action === "deleted" && g.first.action === "created") return;   // 本轮新建又删除：净效果为零
      items.push({
        path: path,
        action: g.last.action === "deleted" ? "deleted" : (g.first.action === "created" ? "created" : "modified"),
        ops: g.ops,
      });
    });
    if (!items.length) return null;
    // 删除的文件排在最后：先看新建/修改，最后看本轮删掉了什么（sort 稳定，同组保持原顺序）
    items.sort((a, b) => (a.action === "deleted" ? 1 : 0) - (b.action === "deleted" ? 1 : 0));
    const box = document.createElement("div");
    box.className = "ai-chg";
    const head = document.createElement("div");
    head.className = "ai-chg-head";
    head.innerHTML = '<i class="bi bi-file-earmark-diff"></i><span>文件变更（' + items.length + '）</span>' +
      '<a class="ai-chg-all">查看文件变更 <i class="bi bi-arrow-right-short"></i></a>';
    const row = document.createElement("div");
    row.className = "ai-chg-list";
    items.forEach(c => {
      const [icon, cls, label] = AI_CHG_ICON[c.action] || AI_CHG_ICON.modified;
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "ai-chg-chip " + cls;
      chip.title = label + "：" + c.path;
      chip.innerHTML = '<i class="bi ' + icon + '"></i><span>' + esc(baseName(c.path)) + '</span>';
      chip.onclick = () => aiOpenChangesTab(c.ops);
      row.appendChild(chip);
    });
    head.querySelector(".ai-chg-all").onclick = () => aiOpenChangesTab(list);
    box.appendChild(head);
    box.appendChild(row);
    return box;
  }
  function aiAppendChangesBox(row, m, mi) {
    if (!row || !m) return;
    try {
      const b = aiChangesBox(m, mi);
      if (b) row.appendChild(b);
    } catch (e) { console.error("文件变更模块渲染失败：", e); }
  }
  /* 「查看文件变更」：打开一个标签页，参考 Git 更改视图汇总展示所有改动差异 */
  function aiOpenChangesTab(changes) {
    const ids = (changes || []).map(c => (c && c.id) || c).filter(Boolean);
    if (!ids.length) { toast("没有可查看的文件变更", "warn"); return; }
    const key = "aiChanges\u0001" + ids.join(",");
    const exist = findTab(key);
    if (exist) { activate(exist); return; }
    const host = document.createElement("div");
    host.className = "cm-host diff-host";
    host.innerHTML =
      '<div class="diff-tools ad-tools"><span class="dt-label">AI 文件变更</span>' +
      '<button class="ad-expand">全部展开</button>' +
      '<button class="ad-collapse">全部折叠</button>' +
      '<span class="ad-count"></span></div><div class="diff-cm all-diff-body"></div>';
    const dw = currentWrap();
    (dw || edGroups).appendChild(host);
    const tab = {
      path: key, host, cm: null, original: "", dirty: false, group: curGroup,
      name: "文件变更", big: false, diff: true, diffView: "diff",
      displayPath: (typeof ROOT !== "undefined" ? ROOT : ""), relPath: "",
      iconHtml: '<i class="bi bi-file-earmark-diff" style="color:#7ec4ff"></i>',
      cmBox: host.querySelector(".all-diff-body"),
      tools: host.querySelector(".diff-tools"),
    };
    tabs.push(tab);
    renderTabsAll();
    activate(tab);   // 统一激活：标签高亮 + active 状态 + 面包屑（同「更改」汇总标签的修复）
    tab.tools.querySelector(".ad-expand").onclick = (e) => { e.stopPropagation(); setAllChangesCollapsed(tab, false); };
    tab.tools.querySelector(".ad-collapse").onclick = (e) => { e.stopPropagation(); setAllChangesCollapsed(tab, true); };
    tab.cmBox.innerHTML = '<div class="ad-loading">正在读取变更差异…</div>';
    fetch("/api/ai/changes", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: ids.slice(0, 500), repo: (typeof ROOT !== "undefined" ? ROOT : "") }),
    }).then(r => r.json()).then(d => {
      if (d.error) throw new Error(d.error);
      const files = d.changes || [];
      let ins = 0, del = 0;
      files.forEach(f => { ins += f.additions || 0; del += f.deletions || 0; });
      tab.name = files.length ? "文件变更 (" + files.length + ")" : "文件变更";
      if (tab.el) { const nm = tab.el.querySelector(".t-nm"); if (nm) nm.textContent = tab.name; }
      const cnt = tab.tools.querySelector(".ad-count");
      if (cnt) cnt.innerHTML = files.length
        ? files.length + " 个文件" +
          (ins ? ' <span class="ad-add">+' + ins + "</span>" : "") +
          (del ? ' <span class="ad-del">−' + del + "</span>" : "")
        : "";
      renderAiChanges(tab, files);
    }).catch(e => {
      tab.cmBox.innerHTML = '<div style="padding:30px;color:#c66;">无法读取变更：' + esc(e.message || e) +
        '（若刚改过后端代码，请重启服务）</div>';
    });
  }
  function renderAiChanges(tab, files) {
    const box = tab.cmBox;
    box.innerHTML = "";
    tab.allBlocks = [];
    if (!files.length) { box.innerHTML = '<div class="ad-loading">没有可显示的变更。</div>'; return; }
    const wrap = document.createElement("div");
    wrap.className = "ad-wrap";
    // 删除的文件排在最后（与消息下方「文件变更」一致；sort 稳定，同组保持原顺序）
    const ordered = files.slice().sort((a, b) => (a.action === "deleted" ? 1 : 0) - (b.action === "deleted" ? 1 : 0));
    ordered.forEach(f => wrap.appendChild(aiChangeFileBlock(tab, f)));
    box.appendChild(wrap);
  }
  function aiChangeFileBlock(tab, f) {
    const name = baseName(f.path);
    const dir = f.path.indexOf("/") >= 0 ? f.path.substring(0, f.path.lastIndexOf("/")) : "";
    const [, cls, label] = AI_CHG_ICON[f.action] || AI_CHG_ICON.modified;
    const sec = document.createElement("div");
    sec.className = "ad-file";
    const head = document.createElement("div");
    head.className = "ad-file-head";
    head.innerHTML =
      '<i class="bi bi-chevron-down ad-tw"></i>' +
      '<span class="ic">' + iconFor(name, false) + '</span>' +
      '<span class="ad-name">' + esc(name) + '</span>' +
      (dir ? '<span class="ad-dir">' + esc(dir) + '</span>' : "") +
      '<span class="ad-tag ' + cls + '">' + esc(label) + '</span>' +
      '<span class="ad-stat">' +
        (f.additions ? '<span class="ad-add">+' + f.additions + "</span> " : "") +
        (f.deletions ? '<span class="ad-del">−' + f.deletions + "</span>" : "") +
      '</span>' +
      '<span class="ad-open" title="打开文件"><i class="bi bi-box-arrow-up-right"></i></span>';
    const body = document.createElement("div");
    body.className = "ad-file-body";
    sec.appendChild(head);
    sec.appendChild(body);
    head.onclick = (e) => {
      if (e.target.closest(".ad-open")) {
        e.stopPropagation();
        const abs = (typeof ROOT !== "undefined" ? ROOT : "") + "/" + f.path;
        if (f.action !== "deleted") openFile(abs, name);
        else toast("该文件已被删除", "warn");
        return;
      }
      const collapsed = sec.classList.toggle("collapsed");
      head.querySelector(".ad-tw").className = "bi " + (collapsed ? "bi-chevron-right" : "bi-chevron-down") + " ad-tw";
    };
    tab.allBlocks.push({ sec: sec, head: head });
    if (!f.diff || !f.diff.trim()) {
      body.innerHTML = '<div class="ad-loading">（没有差异）</div>';
      return sec;
    }
    try {
      mountSplitDiff({ cmBox: body, relPath: f.path, untracked: f.action === "created",
                       diffText: f.diff, diffView: "diff" });
    } catch (e) {
      body.innerHTML = '<div class="ad-loading">无法生成差异：' + esc(e.message || e) + "</div>";
    }
    return sec;
  }
  /* 旧会话里的「选中代码」可能没存真实路径：按文件名在已打开的标签里找一次（找到就补上） */
  function aiResolvePathByName(name) {
    const base = String(name || "").replace(/:\d+(?:-\d+)?$/, "").trim();
    if (!base || typeof tabs === "undefined") return "";
    const t = tabs.find(x => x && x.name === base && x.path);
    return t ? t.path : "";
  }
  /* 点击消息里的附件芯片：在编辑器打开该文件并跳到对应行段（没有行号就只打开文件） */
  async function aiOpenAtLines(path, name, start, end) {
    try {
      const tab = await openFile(path, name);
      if (!tab || !tab.cm) return;
      const cm = tab.cm;
      const s = parseInt(start, 10) || 0;
      if (s > 0) {                                   // 带行段：选中并滚动到该区间
        const a = Math.max(0, Math.min(s - 1, cm.lineCount() - 1));
        const e = parseInt(end, 10) || s;
        const b = Math.max(a, Math.min(e - 1, cm.lineCount() - 1));
        cm.setSelection({ line: a, ch: 0 }, { line: b, ch: cm.getLine(b).length });
        if (typeof scrollLineToComfort === "function") scrollLineToComfort(cm, a);
      }
      cm.focus();
    } catch (err) { toast("打开失败：" + (err.message || err), "err"); }
  }
  function aiBubble(role, text, cls, imgs, md, files, imgNames) {
    const row = document.createElement("div");
    row.className = "ai-row " + role;
    // 「深度思考」：折叠块（默认收起，点标题展开）；返回正文容器供流式更新
    if (cls === "ai-think") {
      row.classList.add("ai-think-box");
      row.innerHTML =
        '<button class="ai-think-hd" type="button">' +
          '<i class="bi bi-chevron-right tw"></i><i class="bi bi-cpu"></i><span>深度思考</span>' +
        '</button>' +
        '<div class="ai-think-bd"></div>';
      const bd = row.querySelector(".ai-think-bd");
      bd.textContent = text || "";
      row.querySelector(".ai-think-hd").addEventListener("click", () => row.classList.toggle("open"));
      $("aiMsgs").appendChild(row);
      aiScrollToBottom(true);
      return bd;   // bd.parentElement 就是整行，调用方隐藏它即可不占位
    }
    // 助手身份行：圆形头像 + 名称（参考 CodeBuddy；用户消息不显示发送者标签）
    if (role === "assistant") {
      const who = document.createElement("div");
      who.className = "who";
      who.innerHTML = '<span class="who-av"><i class="bi bi-stars"></i></span><span class="who-nm">AI 助手</span>';
      row.appendChild(who);
    }
    const b = document.createElement("div");
    b.className = "bubble" + (cls ? " " + cls : "");
    if (md) { b.classList.add("ai-md"); b.innerHTML = aiMd(text || ""); }
    else if (role === "user") { b.innerHTML = aiRenderUserText(text || ""); }
    else { b.textContent = text || ""; }
    row.appendChild(b);
    if (files && files.length) {                 // 本条消息附带的文件 / 文件夹 / 选中代码：与正文同一行排在气泡内
      const g = document.createElement("div");
      g.className = "ai-bfiles";
      files.forEach(it => {
        const f = (typeof it === "string") ? { name: it } : it;   // 兼容历史会话里存的纯字符串
        const label = f.isDir ? (f.name + "/") : f.name;          // 目录带尾斜杠
        // 真实文件路径：选中代码存在 src；旧会话没存时按文件名在已打开标签里找回
        let realPath = f.src || f.path || "";
        if (!/^(\/|[A-Za-z]:[\\/])/.test(String(realPath))) {
          realPath = aiResolvePathByName(f.name) || (String(realPath).indexOf("sel#") === 0 ? "" : realPath);
        }
        const isReal = /^(\/|[A-Za-z]:[\\/])/.test(String(realPath));
        // 行段：新数据直接带；旧数据从「文件名:18-35」里解析
        let st = parseInt(f.start, 10) || 0, en = parseInt(f.end, 10) || 0;
        if (!st) { const mm = /:(\d+)(?:-(\d+))?$/.exec(label); if (mm) { st = +mm[1]; en = mm[2] ? +mm[2] : st; } }
        const s = document.createElement("span");
        s.className = "ai-bfile" + (f.isDir ? " is-dir" : "") + (f.kind === "sel" ? " is-sel" : "");
        s.title = aiPathTip(realPath) || label;    // 悬浮显示「相对项目根的路径」
        if (f.kind === "sel" && f.lang) {          // 选中代码：与输入框芯片一致，显示语言徽标
          const lang = document.createElement("span");
          lang.className = "ai-bfile-lang";
          lang.textContent = f.lang;
          s.appendChild(lang);
          s.appendChild(document.createTextNode(label));
        } else {
          s.innerHTML = '<i class="bi ' + (f.isDir ? "bi-folder2" : "bi-file-earmark-text") + '"></i>';
          s.appendChild(document.createTextNode(label));
        }
        if (isReal) {                              // 点击：打开并跳到对应行段（目录 → 资源管理器定位）
          s.classList.add("ai-bfile-open");
          s.addEventListener("click", () => {
            if (f.isDir) { if (typeof revealInTree === "function") revealInTree(realPath); return; }
            aiOpenAtLines(realPath, realPath.split("/").pop() || f.name, st, en);
          });
        }
        g.appendChild(s);
      });
      b.insertBefore(g, b.firstChild);           // 插到正文最前面：芯片 + 文字同排（参考 CodeBuddy）
    }
    if (imgs && imgs.length) {                   // 图片以「文件名小卡片」加进消息正文（参考 CodeBuddy），点击放大查看
      const g = document.createElement("div");
      g.className = "ai-bimgs";
      imgs.forEach((u, i) => {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "ai-img-chip";
        // 优先用真实文件名（新消息会带上）；旧会话没有记录时退回 Image.png
        const nm = (imgNames && imgNames[i]) || (imgs.length > 1 ? ("Image-" + (i + 1) + ".png") : "Image.png");
        chip.title = nm + "（点击查看）";
        chip.dataset.src = u;
        chip.innerHTML = '<i class="bi bi-file-earmark-image"></i><span></span>';
        chip.querySelector("span").textContent = nm;
        g.appendChild(chip);
      });
      b.appendChild(g);                          // 放进气泡内（即消息文本里）
    }
    $("aiMsgs").appendChild(row);
    aiScrollToBottom(true);
    return b;
  }

  /* ---------- 图片放大查看：点击聊天里的图片 → 全屏查看（滚轮缩放 / 拖动平移 / Esc 关闭） ---------- */
  let _aiLb = null;
  function aiOpenImage(src) {
    const lb = _aiLb || aiBuildLightbox();
    lb.open(src);
  }
  function aiBuildLightbox() {
    const wrap = document.createElement("div");
    wrap.className = "ai-lb";
    wrap.innerHTML =
      '<div class="ai-lb-view"><div class="ai-lb-inner"><img alt="图片预览"></div></div>' +
      '<div class="ai-lb-bar">' +
      '<button class="zout" title="缩小"><i class="bi bi-zoom-out"></i></button>' +
      '<span class="pct">100%</span>' +
      '<button class="zin" title="放大"><i class="bi bi-zoom-in"></i></button>' +
      '<button class="fit" title="适应窗口"><i class="bi bi-arrows-angle-contract"></i></button>' +
      '<button class="one" title="原始大小 1:1">1:1</button>' +
      '<button class="close" title="关闭（Esc）"><i class="bi bi-x-lg"></i></button>' +
      '</div>';
    document.body.appendChild(wrap);
    const view = wrap.querySelector(".ai-lb-view");
    const img = wrap.querySelector("img");
    const pct = wrap.querySelector(".pct");
    const st = { nw: 1, nh: 1, scale: 1 };
    const apply = () => {
      img.style.width = Math.max(1, Math.round(st.nw * st.scale)) + "px";
      img.style.height = Math.max(1, Math.round(st.nh * st.scale)) + "px";
      pct.textContent = Math.round(st.scale * 100) + "%";
    };
    const setScale = (s) => { st.scale = Math.max(0.05, Math.min(8, s)); apply(); };
    const fitScale = () => Math.min(1, (view.clientWidth - 80) / st.nw, (view.clientHeight - 80) / st.nh) || 1;
    const center = () => {
      view.scrollLeft = (img.offsetWidth - view.clientWidth) / 2;
      view.scrollTop = (img.offsetHeight - view.clientHeight) / 2;
    };
    const close = () => wrap.classList.remove("open");
    wrap.querySelector(".zin").onclick = () => setScale(st.scale * 1.25);
    wrap.querySelector(".zout").onclick = () => setScale(st.scale / 1.25);
    wrap.querySelector(".fit").onclick = () => { setScale(fitScale()); center(); };
    wrap.querySelector(".one").onclick = () => { setScale(1); center(); };
    wrap.querySelector(".close").onclick = close;
    view.addEventListener("mousedown", (e) => { if (e.target === view) close(); });
    view.addEventListener("wheel", (e) => { e.preventDefault(); setScale(st.scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15)); }, { passive: false });
    let drag = null;
    img.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      drag = { x: e.clientX, y: e.clientY, sl: view.scrollLeft, st: view.scrollTop };
      img.classList.add("dragging");
      e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (!drag) return;
      view.scrollLeft = drag.sl - (e.clientX - drag.x);
      view.scrollTop = drag.st - (e.clientY - drag.y);
    });
    window.addEventListener("mouseup", () => { if (!drag) return; drag = null; img.classList.remove("dragging"); });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && wrap.classList.contains("open")) close();
    });
    _aiLb = { open(src) {
      const start = () => {
        st.nw = img.naturalWidth || 1; st.nh = img.naturalHeight || 1;
        wrap.classList.add("open");
        setScale(fitScale());
        requestAnimationFrame(center);
      };
      if ((img.getAttribute("src") === src || img.src === src) && img.complete && img.naturalWidth) { start(); return; }
      img.onload = start;
      img.onerror = () => toast("图片加载失败", "warn");
      img.src = src;
    } };
    return _aiLb;
  }
  /* 点击聊天里的任意图片放大查看（历史重渲染 / 流式生成的图片同样生效） */
  $("aiMsgs").addEventListener("click", (e) => {
    const im = e.target.closest(".ai-bimgs img, .ai-img-chip");
    if (!im) return;
    e.preventDefault();
    e.stopPropagation();
    aiOpenImage(im.dataset.src || im.src);
  });

  /* 悬停在图片文件名卡片上：浮出缩略图预览（跟随卡片位置，上方放不下自动翻到下方） */
  let _aiImgPeek = null;
  function aiImgPeekEl() {
    if (!_aiImgPeek || !_aiImgPeek.isConnected) {
      _aiImgPeek = document.createElement("div");
      _aiImgPeek.className = "ai-img-peek";
      _aiImgPeek.innerHTML = '<img alt="预览">';
      document.body.appendChild(_aiImgPeek);
    }
    return _aiImgPeek;
  }
  function aiShowImgPeek(chip) {
    const src = chip.dataset.src;
    if (!src) return;
    const peek = aiImgPeekEl();
    peek.querySelector("img").src = src;
    peek.style.display = "block";
    const r = chip.getBoundingClientRect();
    const pw = peek.offsetWidth || 220, ph = peek.offsetHeight || 160;
    let top = r.top - ph - 8;
    if (top < 8) top = Math.min(window.innerHeight - ph - 8, r.bottom + 8);
    let left = r.left + r.width / 2 - pw / 2;
    left = Math.max(8, Math.min(window.innerWidth - pw - 8, left));
    peek.style.left = left + "px";
    peek.style.top = Math.max(8, top) + "px";
  }
  function aiHideImgPeek() { if (_aiImgPeek) _aiImgPeek.style.display = "none"; }
  $("aiMsgs").addEventListener("mouseover", (e) => {
    const chip = e.target.closest(".ai-img-chip");
    if (chip) aiShowImgPeek(chip);
  });
  $("aiMsgs").addEventListener("mouseout", (e) => {
    const chip = e.target.closest(".ai-img-chip");
    if (!chip) return;
    if (e.relatedTarget && chip.contains(e.relatedTarget)) return;   // 仍在卡片内：不隐藏
    aiHideImgPeek();
  });
  $("aiMsgs").addEventListener("scroll", aiHideImgPeek, { passive: true });

  /* 滚动消息列表到底部，让最后一条完整露出（而不是被输入框挡住半截）。
     force=true 强制滚动；否则只在用户原本就贴底时跟随滚动，避免打断用户回看历史。 */
  function aiScrollToBottom(force) {
    const box = $("aiMsgs");
    if (!box) return;
    const nearBottom = force || (box.scrollHeight - box.scrollTop - box.clientHeight < 120);
    if (!nearBottom) return;
    requestAnimationFrame(() => {
      // 直接滚到最底部：底部内边距（悬浮任务清单预留）也会被算进去，
      // 这样最新内容落在悬浮面板上方，不会被挡住。
      box.scrollTop = box.scrollHeight;
    });
  }

  /* 「回到最新」悬浮按钮：用户上滑离开底部时出现（参考 CodeBuddy 右下角 ⬇） */
  (function initAiToBottom() {
    const box = $("aiMsgs"), btn = $("aiToBottom");
    if (!box || !btn) return;
    const sync = () => {
      const far = box.scrollHeight - box.scrollTop - box.clientHeight > 200;
      btn.style.display = far ? "" : "none";
    };
    box.addEventListener("scroll", sync, { passive: true });
    try { new MutationObserver(sync).observe(box, { childList: true, subtree: true }); } catch (_) {}
    btn.addEventListener("click", () => aiScrollToBottom(true));
    sync();
  })();

  function aiRenderAll() {
    aiRenderFiles();                     // 附加文件的小卡片（右键「添加到 AI 对话」）
    const box = $("aiMsgs");
    box.innerHTML = aiEmptyHtml();       // 空会话时的中间提示（含当前项目名）
    AI.msgs.forEach((m, mi) => {
      const text = m.text || m.content || "";
      const imgs = m.images || [];
      const extra = (!imgs.length && m.imgs) ? "\n[图片 ×" + m.imgs + "]" : "";
      if (m.reasoning) aiBubble("assistant", m.reasoning, "ai-think");
      const b = aiBubble(m.role, text + extra, "", imgs, m.role === "assistant", m.files, m.imgNames);
      b.parentElement.dataset.mi = String(mi);         // 行上标记消息下标，供「历史提问」跳转定位
      if (m.steps && m.steps.length) {                 // 智能体：过程记录收进消息下方的折叠区域
        b.parentElement.appendChild(aiBuildStepsBox(m.steps));
      }
      if (m.role === "assistant" && m.changes && m.changes.length) {   // 文件变更模块
        b.parentElement.appendChild(aiChangesBox(m, mi));
      }
      if (m.role === "assistant") {
        const meta = aiMetaHtml(m, mi);
        if (meta) b.insertAdjacentHTML("afterend", meta);
      } else {
        b.parentElement.insertAdjacentHTML("beforeend", aiUserMetaHtml(m, mi));   // 用户消息：时间 + 复制
      }
    });
    // 任务清单不再内嵌在消息里：改为消息区底部常驻的悬浮面板（取最后一条带清单的回复回放）
    aiTodoFloatSyncFromMsgs();
  }
  async function aiLoadCfg() {
    try {
      const r = await fetch("/api/ai/config");
      const d = await r.json();
      AI.providers = Array.isArray(d.providers) ? d.providers : [];
      AI.active = d.active || {};
      AI.sys = d.sys || {};
      aiFillModelSelect();
      aiRenderSkillBtn();
      if (document.getElementById("aiProvList")) aiRenderProvSettings();   // 设置页已打开则刷新卡片
      if (document.getElementById("sysAiPick")) sysAiMountSettings();      // 设置页已打开则刷新下拉
      return d;
    } catch (_) { return {}; }
  }
  function aiCurrentPick() {
    const provs = AI.providers || [];
    let prov = provs.find(p => p.id === (AI.active || {}).provider) || provs[0];
    const model = prov && (AI.active || {}).model && (prov.models || []).includes(AI.active.model)
      ? AI.active.model : (prov && prov.models && prov.models[0] || "");
    return { prov, model };
  }
  /* ---------- 上下文占用指示：模型下拉前的空心圆环 ---------- */
  function aiCtxWindow(model) {                        // 按模型名粗略估算上下文窗口
    const m = String(model || "").toLowerCase();
    let hit = m.match(/(\d+(?:\.\d+)?)\s*k(?:\s*(?:tok|tokens|context))?\b/);
    if (hit) return Math.round(parseFloat(hit[1]) * 1000);
    hit = m.match(/(\d+(?:\.\d+)?)\s*m(?:\s*(?:tok|tokens|context))?\b/);
    if (hit) return Math.round(parseFloat(hit[1]) * 1000000);
    return 128000;                                     // 未知时按 128K 估计
  }
  function aiFmtTok(n) {
    n = Math.max(0, Math.round(n || 0));
    if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
    if (n >= 1000) return (n / 1000).toFixed(n >= 100000 ? 0 : 1) + "K";
    return String(n);
  }
  function aiUpdateCtxRing(used) {
    const arc = $("aiCtxArc"), ring = $("aiCtxRing");
    if (!arc || !ring) return;
    // 无参调用时优先取「最近一次请求的上下文大小」（= 当前上下文占用，这才是圆环该表示的）；
    // 旧会话没有 ctxLast 字段时退回累计消耗，保证圆环不为 0
    if (typeof used !== "number") {
      const cur = AI.sessions.find(x => x.id === AI.curId);
      const st = (cur && cur.stats) || {};
      used = st.ctxLast || ((st.inSum || 0) + (st.outSum || 0));
    }
    AI.ctxUsed = used || 0;
    const pick = aiCurrentPick();
    const total = aiCtxWindow(pick.model);
    const ratio = total > 0 ? Math.min(1, (AI.ctxUsed || 0) / total) : 0;
    const C = 2 * Math.PI * 6.2;
    arc.setAttribute("stroke-dasharray", C.toFixed(2));
    arc.setAttribute("stroke-dashoffset", (C * (1 - ratio)).toFixed(2));
    const pct = Math.round(ratio * 100);
    ring.classList.toggle("warn", pct >= 60 && pct < 85);
    ring.classList.toggle("bad", pct >= 85);
    ring.title = "上下文占用：约 " + aiFmtTok(AI.ctxUsed || 0) + " / " + aiFmtTok(total) + " tokens（" + pct + "%）\n" +
      "模型：" + (pick.model || "未选择") + "\n（最近一次请求发给模型的上下文大小；窗口大小按模型名估算）";
  }

  function aiFillModelSelect() {
    const btnName = $("aiMselName"), btn = $("aiMselBtn"), pop = $("aiMselPop");
    if (!btnName) return;
    aiUpdateCtxRing();                                 // 换模型后按新窗口重算占用比例
    const provs = AI.providers || [];
    if (!provs.length) {
      btnName.textContent = "未配置接口"; btn.title = "先到 设置 → AI 助手 添加接口";
      pop.innerHTML = ""; return;
    }
    const pick = aiCurrentPick();
    btnName.textContent = pick.model || "未配置模型";
    btn.title = (pick.prov ? pick.prov.name + " · " : "") + (pick.model || "");
    pop.innerHTML = "";
    provs.forEach(p => {
      const g = document.createElement("div");
      g.className = "ai-msel-g"; g.textContent = p.name;
      pop.appendChild(g);
      (p.models || []).forEach(m => {
        const o = document.createElement("div");
        o.className = "ai-msel-opt" + (pick.prov && p.id === pick.prov.id && m === pick.model ? " on" : "");
        o.innerHTML = '<i class="bi bi-check2"></i><span></span>';
        o.querySelector("span").textContent = m;      // 完整模型名
        o.title = m;
        o.addEventListener("click", () => {
          AI.active = { provider: p.id, model: m };
          fetch("/api/ai/config", { method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ active: { provider: p.id, model: m } }) }).catch(() => {});
          aiFillModelSelect();
          pop.style.display = "none";
        });
        pop.appendChild(o);
      });
    });
  }
  $("aiMselBtn").addEventListener("click", (e) => {
    e.stopPropagation();
    const pop = $("aiMselPop");
    const show = pop.style.display === "none";
    if (show) aiFillModelSelect();
    pop.style.display = show ? "" : "none";
  });
  document.addEventListener("click", (e) => {
    const pop = $("aiMselPop");
    if (pop && pop.style.display !== "none" && !pop.contains(e.target)) pop.style.display = "none";
  });

  function aiGetCustomSkills() {
    try { return JSON.parse(localStorage.getItem("ide.ai.customSkills") || "[]"); }
    catch (_) { return []; }
  }
  function aiSaveCustomSkills(list) {
    try { localStorage.setItem("ide.ai.customSkills", JSON.stringify(list)); } catch (_) {}
  }
  /* 本地覆盖：内置/自定义 Skill 修改后存这里，内置技能本身不落库、可随时恢复默认 */
  function aiGetSkillOverrides() {
    try { return JSON.parse(localStorage.getItem("ide.ai.skillOverrides") || "{}") || {}; }
    catch (_) { return {}; }
  }
  function aiSaveSkillOverrides(obj) {
    try { localStorage.setItem("ide.ai.skillOverrides", JSON.stringify(obj || {})); } catch (_) {}
  }
  function aiHasSkillOverride(id) {
    const o = aiGetSkillOverrides()[id];
    return !!(o && (o.name || o.prompt || o.desc != null));
  }
  /* 合并内置 + 自定义 Skill，并套用本地覆盖，返回统一结构 */
  function aiAllSkills() {
    const ov = aiGetSkillOverrides();
    const list = AI_SKILLS.map(s => {
      const o = ov[s.id] || {};
      return { id: s.id, name: o.name || s.name, desc: o.desc != null ? o.desc : s.desc,
               prompt: o.prompt || s.prompt, icon: s.icon || "bi-stars", builtin: true,
               overridden: !!(o.name || o.prompt || o.desc != null), promptOverridden: !!o.prompt };
    });
    aiGetCustomSkills().forEach(s => {
      const o = ov[s.id] || {};
      list.push({ id: s.id, name: o.name || s.name, desc: o.desc != null ? o.desc : (s.desc || ""),
                  prompt: o.prompt || s.prompt || "", icon: "bi-lightning", builtin: false,
                  overridden: !!(o.name || o.prompt || o.desc != null), promptOverridden: !!o.prompt });
    });
    return list;
  }
  function aiFindSkill(id) { return aiAllSkills().find(s => s.id === id) || null; }
  /* 技能改名后，同步输入框标签与当前会话里已保存的消息文本 */
  function aiSyncSkillName(id, oldName, newName) {
    const ta = $("aiText");
    if (ta) ta.querySelectorAll(".ai-tag[data-id]").forEach(t => { if (t.dataset.id === id) t.textContent = "@" + newName; });
    if (!oldName || oldName === newName) return;
    let changed = false;
    (AI.msgs || []).forEach(m => {
      if (m.role !== "user" || !m.text) return;
      let t = m.text.split("[Skill:" + oldName + "]").join("[Skill:" + newName + "]").split("@" + oldName).join("@" + newName);
      if (t !== m.text) { m.text = t; changed = true; }
    });
    if (changed) aiPersistCurrent();
    aiRenderActiveSkills();
  }
  /* 保存修改：内置 → 写覆盖；自定义 → 直接改本地自定义列表 */
  function aiSaveSkillEdit(id, data) {
    const sk = aiFindSkill(id);
    if (!sk) return;
    const oldName = sk.name;
    if (sk.builtin) {
      const ov = aiGetSkillOverrides();
      ov[id] = { name: data.name, desc: data.desc, prompt: data.prompt };
      aiSaveSkillOverrides(ov);
    } else {
      const list = aiGetCustomSkills();
      const i = list.findIndex(s => s.id === id);
      if (i >= 0) list[i] = Object.assign({}, list[i], { name: data.name, desc: data.desc, prompt: data.prompt });
      else list.push({ id, name: data.name, desc: data.desc, prompt: data.prompt });
      aiSaveCustomSkills(list);
      const ov = aiGetSkillOverrides();
      if (ov[id]) { delete ov[id]; aiSaveSkillOverrides(ov); }
    }
    if (oldName !== data.name) aiSyncSkillName(id, oldName, data.name);
  }
  function aiDeleteSkill(id) {
    const sk = aiFindSkill(id);
    if (!sk || sk.builtin) return;
    aiSaveCustomSkills(aiGetCustomSkills().filter(s => s.id !== id));
    const ov = aiGetSkillOverrides();
    if (ov[id]) { delete ov[id]; aiSaveSkillOverrides(ov); }
  }
  /* 技能数据变化后：刷新消息气泡里的标签、若下拉打开则重建 */
  function aiAfterSkillChange() {
    try { aiRenderAll(); } catch (_) {}
    const pop = $("aiSkillPop");
    if (pop && pop.style.display !== "none") aiBuildSkillPop();
    aiRenderActiveSkills();
  }

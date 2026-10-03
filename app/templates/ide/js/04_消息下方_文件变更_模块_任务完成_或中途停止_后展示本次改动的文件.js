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
    files.forEach(f => wrap.appendChild(aiChangeFileBlock(tab, f)));
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
  function aiBubble(role, text, cls, imgs, md, files) {
    const row = document.createElement("div");
    row.className = "ai-row " + role;
    const who = document.createElement("div");
    who.className = "who";
    who.textContent = role === "user" ? "我" : (cls === "ai-think" ? "思考" : "AI");
    row.appendChild(who);
    if (files && files.length) {                 // 本条消息附带的文件：显示在消息上方
      const g = document.createElement("div");
      g.className = "ai-bfiles";
      files.forEach(n => {
        const s = document.createElement("span");
        s.className = "ai-bfile";
        s.title = n;
        s.innerHTML = '<i class="bi bi-file-earmark-text"></i>';
        s.appendChild(document.createTextNode(n));
        g.appendChild(s);
      });
      row.appendChild(g);
    }
    const b = document.createElement("div");
    b.className = "bubble" + (cls ? " " + cls : "");
    if (md) { b.classList.add("ai-md"); b.innerHTML = aiMd(text || ""); }
    else if (role === "user") { b.innerHTML = aiRenderUserText(text || ""); }
    else { b.textContent = text || ""; }
    row.appendChild(b);
    if (imgs && imgs.length) {
      const g = document.createElement("div");
      g.className = "ai-bimgs";
      imgs.forEach(u => { const im = document.createElement("img"); im.src = u; g.appendChild(im); });
      row.appendChild(g);
    }
    $("aiMsgs").appendChild(row);
    aiScrollToBottom(true);
    return b;
  }

  /* 滚动消息列表到底部，让最后一条完整露出（而不是被输入框挡住半截）。
     force=true 强制滚动；否则只在用户原本就贴底时跟随滚动，避免打断用户回看历史。 */
  function aiScrollToBottom(force) {
    const box = $("aiMsgs");
    if (!box) return;
    const nearBottom = force || (box.scrollHeight - box.scrollTop - box.clientHeight < 120);
    if (!nearBottom) return;
    requestAnimationFrame(() => {
      const last = box.lastElementChild;
      if (last && last.scrollIntoView) {
        last.scrollIntoView({ block: "end", behavior: "auto" });
      } else {
        box.scrollTop = box.scrollHeight;
      }
    });
  }

  function aiRenderAll() {
    aiRenderFiles();                     // 附加文件的小卡片（右键「添加到 AI 对话」）
    const box = $("aiMsgs");
    box.innerHTML = '<div class="ai-empty" id="aiEmpty" style="display:' + (AI.msgs.length ? "none" : "") + '">' +
      '<i class="bi bi-stars"></i><div class="t">AI 助手</div>' +
      '<div class="s">支持解释代码、排查报错、生成片段。可附带当前文件与图片提问。</div></div>';
    AI.msgs.forEach((m, mi) => {
      const text = m.text || m.content || "";
      const imgs = m.images || [];
      const extra = (!imgs.length && m.imgs) ? "\n[图片 ×" + m.imgs + "]" : "";
      if (m.reasoning) aiBubble("assistant", m.reasoning, "ai-think");
      const b = aiBubble(m.role, text + extra, "", imgs, m.role === "assistant", m.files);
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
    // 无参调用时读当前会话累计消耗（inSum + outSum），跟底部"输入 X tok"一致
    // 之前默认取 AI.ctxUsed（初始化时为 0），导致圆环永远显示 0
    if (typeof used !== "number") {
      const cur = AI.sessions.find(x => x.id === AI.curId);
      used = (cur && cur.stats && (cur.stats.inSum || 0)) + (cur && cur.stats && (cur.stats.outSum || 0));
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
      "模型：" + (pick.model || "未选择") + "\n（窗口大小按模型名估算，显示当前会话累计消耗）";
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

  /* ===== Skill 查看 / 修改悬浮框 ===== */
  function aiEnsureSkillEditPop() {
    let pop = $("aiSkillEditPop");
    if (pop) return pop;
    pop = document.createElement("div");
    pop.id = "aiSkillEditPop";
    pop.className = "ai-skedit-pop";
    pop.style.display = "none";
    document.body.appendChild(pop);
    document.addEventListener("mousedown", (e) => {
      if (pop.style.display !== "none" && !pop.contains(e.target) && !e.target.closest(".ai-tag-chip") &&
          !e.target.closest(".ai-tag") && !e.target.closest(".ai-sk-act")) {
        pop.style.display = "none"; pop.innerHTML = "";
      }
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && pop.style.display !== "none") { pop.style.display = "none"; pop.innerHTML = ""; }
    });
    return pop;
  }
  function aiCloseSkillEditPop() {
    const pop = $("aiSkillEditPop");
    if (pop) { pop.style.display = "none"; pop.innerHTML = ""; }
  }
  function aiOpenSkillEditPop(skillId, anchor) {
    const sk = aiFindSkill(skillId);
    if (!sk) { toast("找不到该 Skill", "warn"); return; }
    const pop = aiEnsureSkillEditPop();
    const hasOv = aiHasSkillOverride(skillId);
    pop.innerHTML =
      '<div class="p-title"><i class="bi ' + esc(sk.icon || "bi-stars") + '"></i><span>' + esc(sk.name) + '</span>' +
        '<span class="p-badge' + (hasOv ? " ov" : "") + '">' + (sk.builtin ? "内置" : "自定义") + (hasOv ? " · 已修改" : "") + '</span></div>' +
      '<div class="p-row"><label>名称</label><input id="skEditName" autocomplete="off"></div>' +
      '<div class="p-row"><label>描述</label><input id="skEditDesc" autocomplete="off"></div>' +
      '<div class="p-row"><label>提示词</label><textarea id="skEditPrompt"></textarea></div>' +
      '<div class="p-foot">' +
        (sk.builtin && hasOv ? '<button class="p-reset" id="skEditReset">恢复默认</button>' : '') +
        (!sk.builtin ? '<button class="p-del" id="skEditDel">删除</button>' : '') +
        '<span class="p-sp"></span>' +
        '<button class="p-cancel" id="skEditCancel">取消</button>' +
        '<button class="p-save" id="skEditSave">保存</button>' +
      '</div>';
    pop.querySelector("#skEditName").value = sk.name;
    pop.querySelector("#skEditDesc").value = sk.desc || "";
    pop.querySelector("#skEditPrompt").value = sk.prompt || "";
    pop.style.display = "";
    const r = anchor && anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { left: 40, top: 60, bottom: 80 };
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    let left = Math.min(Math.max(8, r.left), Math.max(8, window.innerWidth - pw - 8));
    let top = r.bottom + 8;
    if (top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - 8);
    pop.style.left = left + "px";
    pop.style.top = top + "px";
    pop.querySelector("#skEditCancel").onclick = aiCloseSkillEditPop;
    pop.querySelector("#skEditSave").onclick = () => {
      const name = pop.querySelector("#skEditName").value.trim();
      const desc = pop.querySelector("#skEditDesc").value.trim();
      const prompt = pop.querySelector("#skEditPrompt").value.trim();
      if (!name) { toast("请输入名称", "warn"); return; }
      if (!prompt) { toast("请输入提示词", "warn"); return; }
      aiSaveSkillEdit(skillId, { name, desc, prompt });
      aiAfterSkillChange();
      toast("已保存：内置技能以本地覆盖生效，可随时恢复默认", "ok");
      aiCloseSkillEditPop();
    };
    const rst = pop.querySelector("#skEditReset");
    if (rst) rst.onclick = () => {
      const ov = aiGetSkillOverrides();
      delete ov[skillId];
      aiSaveSkillOverrides(ov);
      aiAfterSkillChange();
      toast("已恢复默认", "ok");
      aiCloseSkillEditPop();
    };
    const del = pop.querySelector("#skEditDel");
    if (del) del.onclick = async (e) => {
      const ok = await uiConfirmPop(e.currentTarget, {
        title: "删除 Skill",
        msg: "确定删除自定义 Skill「" + sk.name + "」？",
        okText: "删除",
        danger: true
      });
      if (!ok) return;
      aiDeleteSkill(skillId);
      aiAfterSkillChange();
      toast("已删除", "ok");
      aiCloseSkillEditPop();
    };
  }
  function aiRenderSkillBtn() {
    const btn = $("aiSkillBtn"), nm = $("aiSkillName");
    if (!btn || !nm) return;
    nm.textContent = "技能";
    btn.classList.remove("on");
  }
  function aiBuildSkillPop() {
    const pop = $("aiSkillPop");
    if (!pop) return;
    pop.innerHTML = '<div class="ai-skill-g">点击插入到输入框（可同时使用多个）</div>';
    const all = aiAllSkills();
    const mk = (s) => {
      const o = document.createElement("div");
      o.className = "ai-skill-opt";
      o.innerHTML = '<i class="bi ' + esc(s.icon || "bi-stars") + '"></i>' +
        '<div class="m"><div class="t"></div><div class="d"></div></div>' +
        '<button class="ai-sk-act ai-sk-edit" title="查看 / 修改"><i class="bi bi-pencil"></i></button>' +
        (s.builtin
          ? '<button class="ai-sk-act ai-sk-del dis" title="内置技能不可删除" disabled><i class="bi bi-lock"></i></button>'
          : '<button class="ai-sk-act ai-sk-del" title="删除"><i class="bi bi-trash"></i></button>');
      const t = o.querySelector(".t");
      t.textContent = s.name;
      if (s.overridden) {
        const sub = document.createElement("span");
        sub.className = "sub"; sub.textContent = "· 已修改";
        t.appendChild(sub);
      }
      o.querySelector(".d").textContent = s.desc || (s.builtin ? "" : "自定义 Skill");
      o.addEventListener("click", (e) => {
        if (e.target.closest(".ai-sk-act")) return;
        aiInsertSkillTag(s);
        pop.style.display = "none";
      });
      o.querySelector(".ai-sk-edit").addEventListener("click", (e) => {
        e.stopPropagation();
        const rect = e.currentTarget.getBoundingClientRect();
        pop.style.display = "none";
        aiOpenSkillEditPop(s.id, { getBoundingClientRect: () => rect });
      });
      const del = o.querySelector(".ai-sk-del");
      if (del && !s.builtin) {
        del.addEventListener("click", async (e) => {
          e.stopPropagation();
          const ok = await uiConfirmPop(e.currentTarget, {
            title: "删除 Skill",
            msg: "确定删除自定义 Skill「" + s.name + "」？",
            okText: "删除",
            danger: true
          });
          if (!ok) return;
          aiDeleteSkill(s.id);
          aiAfterSkillChange();
          toast("已删除", "ok");
        });
      }
      return o;
    };
    all.filter(s => s.builtin).forEach(s => pop.appendChild(mk(s)));
    const customs = all.filter(s => !s.builtin);
    if (customs.length) {
      const g = document.createElement("div");
      g.className = "ai-skill-g"; g.textContent = "自定义";
      pop.appendChild(g);
      customs.forEach(s => pop.appendChild(mk(s)));
    }
    const imp = document.createElement("div");
    imp.className = "ai-skill-opt ai-skill-import";
    imp.innerHTML = '<i class="bi bi-plus-circle"></i><div class="m"><div class="t">导入技能</div><div class="d">自定义名称和提示词</div></div>';
    imp.addEventListener("click", () => {
      uiImportSkill().then((s) => {
        if (!s) return;
        const list = aiGetCustomSkills();
        list.push(s);
        aiSaveCustomSkills(list);
        aiInsertSkillTag(s);
        pop.style.display = "none";
      });
    });
    pop.appendChild(imp);
  }
  $("aiSkillBtn").addEventListener("click", (e) => {
    e.stopPropagation();
    const ta = $("aiText");
    const sel = window.getSelection();
    if (ta && sel.rangeCount > 0 && ta.contains(sel.getRangeAt(0).commonAncestorContainer)) {
      AI._skillRange = sel.getRangeAt(0).cloneRange();
    } else {
      AI._skillRange = null;
    }
    const pop = $("aiSkillPop");
    const show = pop.style.display === "none";
    if (show) aiBuildSkillPop();
    pop.style.display = show ? "block" : "none";
  });
  document.addEventListener("click", (e) => {
    const pop = $("aiSkillPop");
    if (pop && pop.style.display !== "none" && !e.target.closest(".ai-skill-wrap")) pop.style.display = "none";
  });

  function aiCopyText(t) {                                // 兼容 http 非安全上下文
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(t);
    return new Promise((res, rej) => {
      const ta = document.createElement("textarea");
      ta.value = t;
      ta.style.cssText = "position:fixed;left:-9999px;top:-9999px;opacity:0";
      document.body.appendChild(ta);
      ta.focus(); ta.select();
      try { document.execCommand("copy") ? res() : rej(new Error("copy failed")); }
      catch (e) { rej(e); } finally { ta.remove(); }
    });
  }
  $("aiMsgs").addEventListener("click", (e) => {          // 代码块：插入到项目 / 复制；回复：复制 / 重新生成
    const chip = e.target.closest(".ai-tag-chip");        // 消息里的 Skill 标签：查看 / 修改
    if (chip) {
      aiOpenSkillEditPop(chip.dataset.skillId, chip);
      return;
    }
    const mc = e.target.closest(".ai-mcopy");             // 复制整条消息（文字 + 图片）
    if (mc) {
      const m = AI.msgs[+mc.dataset.mi];
      if (!m) return;
      aiCopyMessage(m).then(() => {
        mc.innerHTML = '<i class="bi bi-check2"></i>';
        setTimeout(() => { mc.innerHTML = '<i class="bi bi-clipboard"></i>'; }, 1500);
      }).catch(() => { toast("复制失败", "warn"); });
      return;
    }
    const un = e.target.closest(".ai-mundo");             // 回撤本次 AI 改动
    if (un) {
      const mi = +un.dataset.mi;
      const m = AI.msgs[mi];
      if (!m || !m.changes || !m.changes.length) return;
      aiUndoChanges(mi, un);
      return;
    }
    const rg = e.target.closest(".ai-mregen");            // 删除此回复并重新生成
    if (rg) {
      if (AI.busy) { toast("正在回复中，请先停止", "warn"); return; }
      const mi = +rg.dataset.mi;
      const u = AI.msgs[mi - 1];
      if (!u || u.role !== "user") { toast("找不到原始提问，无法重新生成", "warn"); return; }
      AI.msgs.splice(mi);                                 // 移除该回复及其后所有消息
      aiPersistCurrent(); aiRenderAll();
      aiSend({ text: u.text || "", imgs: (u.images || []).slice(), imgNames: (u.imgNames || []).slice(), skills: (u.skills || []).slice() });
      return;
    }
    const rt = e.target.closest(".ai-mretry");            // 重新提问（保留上下文再试一次）
    if (rt) {
      if (AI.busy) { toast("正在回复中，请先停止", "warn"); return; }
      const mi = +rt.dataset.mi;
      const u = AI.msgs[mi - 1];
      if (!u || u.role !== "user") { toast("找不到原始提问，无法重新提问", "warn"); return; }
      aiSend({ text: u.text || "", imgs: (u.images || []).slice(), imgNames: (u.imgNames || []).slice(), skills: (u.skills || []).slice() });
      return;
    }
    const ed = e.target.closest(".ai-medit");             // 编辑用户消息并重新发送：载入输入框并截断其后内容
    if (ed) {
      if (AI.busy) { toast("正在回复中，请先停止", "warn"); return; }
      const mi = +ed.dataset.mi;
      const m = AI.msgs[mi];
      if (!m || m.role !== "user") return;
      AI.msgs.splice(mi);                                 // 移除这条提问及其后的所有内容
      aiPersistCurrent(); aiRenderAll();
      const box = $("aiText");
      if (box) {
        box.textContent = m.text || m.content || "";
        box.focus();
        try {                                              // 光标移到末尾，附件芯片接着正文插入
          const r = document.createRange();
          r.selectNodeContents(box); r.collapse(false);
          const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
        } catch (_) {}
      }
      // 还原这条消息附带的附件：图片直接用缓存的 dataURL；文件按路径重新读取（选中代码重新选取更直观）
      AI.pending = [];
      if (typeof aiRenderPending === "function") aiRenderPending();
      AI.files = [];
      (m.images || []).forEach((u, i) => aiInsertImgTag(u, (m.imgNames && m.imgNames[i]) || "Image.png"));
      (m.files || []).forEach(async (it) => {
        const f = (typeof it === "string") ? { name: it } : it;
        if (f.kind === "sel" || !f.path) return;
        const r = await aiAttachOne(f.path, f.name, f.isDir);
        if (r.ok) aiInsertFileTag({ path: f.path, name: f.name, isDir: !!f.isDir });
      });
      toast("已载入输入框，修改后回车重新发送", "ok");
      return;
    }
    const dl = e.target.closest(".ai-mdel");              // 删除这条消息
    if (dl) {
      if (AI.busy) { toast("正在回复中，请先停止", "warn"); return; }
      const mi = +dl.dataset.mi;
      if (!AI.msgs[mi]) return;
      AI.msgs.splice(mi, 1);
      aiPersistCurrent();
      aiRenderAll();
      toast("已删除该消息", "ok");
      return;
    }
    const ins = e.target.closest(".ai-md-ins");
    if (ins) {
      (async () => {
        if (AI.perm === "readonly") {                     // 仅可查看：禁止写入
          toast("当前权限为「仅可查看」，AI 不能写入文件。可在输入框左下角切换为「工作区内修改」。", "warn");
          return;
        }
        const pre = ins.closest(".ai-md-pre");
        const code = pre && pre.querySelector("code");
        if (!code) return;
        let name = (pre.dataset.file || "").trim();
        if (!name) {                                      // 无文件名提示 → 按语言生成默认名
          const lang = (pre.querySelector(".ai-md-ch span") || {}).textContent || "";
          const extMap = { python: "py", javascript: "js", html: "html", css: "css", json: "json", shell: "sh", sql: "sql", yaml: "yml", 代码: "txt" };
          name = "ai_snippet_" + Date.now().toString(36) + "." + (extMap[lang.trim().toLowerCase()] || "txt");
        }
        let abs;
        if (AI.perm === "full") {                         // 完全权限：允许绝对路径与 ..
          abs = name.startsWith("/") ? canonPath(name) : canonPath(ROOT + "/" + name);
        } else {                                          // 工作区内：只允许项目内的相对路径
          name = name.replace(/^\.\//, "");
          if (name.startsWith("/") || name.split("/").includes("..")) {
            toast("工作区权限下只允许项目内的相对路径：" + name, "warn");
            return;
          }
          abs = canonPath(ROOT + "/" + name);
          if (ROOT && abs !== ROOT && !abs.startsWith(ROOT + "/")) {
            toast("超出工作区范围：" + abs, "warn");
            return;
          }
        }
        try {
          const r = await fetch("/api/files/save", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: abs, content: code.textContent }),
          });
          const d = await r.json().catch(() => ({}));
          if (!r.ok || d.error) { toast("插入失败：" + (d.error || ("HTTP " + r.status)), "warn"); return; }
          toast("已保存 " + name + "，正在打开…");
          refreshTree(ROOT);
          openFile(abs, name.split("/").pop());
        } catch (err) { toast("插入失败：" + err.message, "warn"); }
      })();
      return;
    }
    const btn = e.target.closest(".ai-md-copy");
    if (!btn) return;
    const pre = btn.closest(".ai-md-pre");
    const code = pre && pre.querySelector("code");
    if (!code) return;
    aiCopyText(code.textContent).then(() => {
      btn.innerHTML = '<i class="bi bi-check2"></i>';
      setTimeout(() => { btn.innerHTML = '<i class="bi bi-clipboard"></i>'; }, 1500);
    }).catch(() => {
      btn.innerHTML = '<i class="bi bi-x"></i>';
      setTimeout(() => { btn.innerHTML = '<i class="bi bi-clipboard"></i>'; }, 1500);
    });
  });
  function aiRenderProvSettings() {
    const list = $("aiProvList");
    list.innerHTML = "";
    const provs = AI.providers || [];
    if (!provs.length) list.innerHTML = '<div class="ai-prov-empty">还没有接口，点下方「+ 添加接口」。</div>';
    provs.forEach(p => {
      const card = document.createElement("div");
      card.className = "ai-prov";
      card.dataset.pid = p.id;
      card.innerHTML =
        '<div class="ai-prov-hd"><input class="nm" placeholder="接口名称" value="">' +
        '<button class="ai-prov-del" title="删除该接口"><i class="bi bi-trash3"></i></button></div>' +
        '<div class="lbl">接口地址（OpenAI 兼容）</div>' +
        '<input class="u" placeholder="https://api.deepseek.com" spellcheck="false">' +
        '<div class="lbl">API Key（留空沿用已保存的）</div>' +
        '<form class="ai-pwd-form" autocomplete="off" onsubmit="return false">' +
          '<input class="k" type="password" placeholder="' + (p.api_key ? "已保存 " + p.api_key : "sk-...") + '" spellcheck="false" autocomplete="off">' +
        '</form>' +
        '<div class="lbl ai-lbl-row"><span>模型列表（可手动填写或自动获取）</span>' +
        '<button class="ai-prov-fetch" type="button" title="从接口拉取可用模型列表"><i class="bi bi-arrow-repeat"></i> 自动获取</button></div>' +
        '<textarea class="ms" rows="2" spellcheck="false" placeholder="deepseek-chat, deepseek-reasoner"></textarea>' +
        '<div class="ai-prov-mlist" style="display:none"></div>';
      card.querySelector(".nm").value = p.name || "";
      card.querySelector(".u").value = p.base_url || "";
      card.querySelector(".ms").value = (p.models || []).join(", ");
      const msEl = card.querySelector(".ms"), mlList = card.querySelector(".ai-prov-mlist");
      /* 「自动获取」：调后端拉取 /models，返回的模型渲染成复选框，勾选同步进 textarea */
      card.querySelector(".ai-prov-fetch").addEventListener("click", async () => {
        const btn = card.querySelector(".ai-prov-fetch");
        if (btn.disabled) return;
        btn.disabled = true; btn.innerHTML = '<i class="bi bi-hourglass-split"></i> 获取中…';
        try {
          const r = await fetch("/api/ai/models", { method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ base_url: card.querySelector(".u").value.trim(), api_key: card.querySelector(".k").value, provider_id: p.id }) });
          const d = await r.json();
          if (!r.ok || d.error) throw new Error(d.error || "获取失败");
          const cur = msEl.value.split(/[，,]/).map(s => s.trim()).filter(Boolean);
          mlList.innerHTML = "";
          d.models.forEach(m => {
            const lab = document.createElement("label");
            lab.className = "ai-prov-mopt";
            const cb = document.createElement("input");
            cb.type = "checkbox"; cb.checked = cur.includes(m);
            const sp = document.createElement("span");
            sp.textContent = m; sp.title = m;
            cb.addEventListener("change", () => {
              const sel = Array.from(mlList.querySelectorAll("input:checked")).map(x => x.closest("label").querySelector("span").textContent);
              const manual = msEl.value.split(/[，,]/).map(s => s.trim()).filter(Boolean).filter(x => !d.models.includes(x));
              msEl.value = manual.concat(sel).join(", ");
            });
            lab.appendChild(cb); lab.appendChild(sp);
            mlList.appendChild(lab);
          });
          if (!d.models.length) { mlList.style.display = "none"; toast("接口未返回任何模型", "warn"); }
          else mlList.style.display = "";
          /* 手动编辑 textarea 时反向同步勾选状态 */
          msEl.oninput = () => {
            if (mlList.style.display === "none") return;
            const now = msEl.value.split(/[，,]/).map(s => s.trim());
            mlList.querySelectorAll(".ai-prov-mopt").forEach(lab => {
              lab.querySelector("input").checked = now.includes(lab.querySelector("span").textContent);
            });
          };
        } catch (err) { toast("自动获取模型失败：" + err.message, "warn"); }
        finally { btn.disabled = false; btn.innerHTML = '<i class="bi bi-arrow-repeat"></i> 自动获取'; }
      });
      card.querySelector(".ai-prov-del").addEventListener("click", () => {
        AI.providers = AI.providers.filter(x => x.id !== p.id);
        aiRenderProvSettings();
        aiFillModelSelect();
      });
      list.appendChild(card);
    });
  }
  function aiOpenSettings(secId) {
    openSettingsTab();          // 打开 / 聚焦「设置」标签页（内容已含 AI 分区）
    setTimeout(() => {          // 定位到指定分区（默认 AI 助手）
      const item = document.querySelector('.set-navitem[data-sec="' + (secId || "sec-ai") + '"]');
      if (item) item.click();
    }, 60);
  }
  /* 挂载设置页里的 AI 接口配置（每次 buildSettingsContent 重建后调用） */
  function aiMountSettings() {
    if (!document.getElementById("aiProvList")) return;
    aiRenderProvSettings();
    $("aiProvAdd").onclick = () => {
      if (!Array.isArray(AI.providers)) AI.providers = [];
      AI.providers.push({ id: "p" + Date.now().toString(36), name: "接口 " + (AI.providers.length + 1),
                          base_url: "", api_key: "", models: [] });
      aiRenderProvSettings();
      const cards = $("aiProvList").querySelectorAll(".ai-prov");
      cards[cards.length - 1] && cards[cards.length - 1].querySelector(".nm").focus();
    };
    $("aiCfgSave").onclick = async () => {
      const tip = $("aiCfgTip");
      tip.className = "ai-set-tip"; tip.textContent = "保存中…";
      try {
        const r = await fetch("/api/ai/config", {
          method: "POST", headers: { "Content-Type": "application/json" },
          // api_key 传输加密（见 js/24_敏感字段传输加密.js）
          body: JSON.stringify({ providers: aiCollectProviders().map(p => ({
            ...p, api_key: window.TP ? window.TP.encrypt(p.api_key) : p.api_key })) }),
        });
        const d = await r.json();
        if (d.error) { tip.textContent = d.error; return; }
        tip.className = "ai-set-tip ok"; tip.textContent = "已保存 ✓";
        AI.providers = Array.isArray(d.providers) ? d.providers : [];
        AI.active = d.active || {};
        aiFillModelSelect();
        setTimeout(() => { tip.textContent = ""; }, 2500);
      } catch (e) { tip.textContent = "保存失败：" + e; }
    };
  }
  /* ---------- 设置 → 系统 AI：选择「生成提交内容」等系统功能使用的接口与模型 ---------- */
  function sysAiMountSettings() {
    const sel = document.getElementById("sysAiPick");
    if (!sel) return;
    const provs = AI.providers || [];
    const cur = AI.sys || {};
    const act = AI.active || {};
    const actProv = provs.find(p => p.id === act.provider);
    sel.innerHTML = "";
    const follow = document.createElement("option");
    follow.value = "";
    follow.textContent = "跟随 AI 助手" + (actProv ? "（" + actProv.name + " · " + (act.model || "未选模型") + "）" : "");
    sel.appendChild(follow);
    provs.forEach(p => (p.models || []).forEach(m => {
      const o = document.createElement("option");
      o.value = p.id + "\u0001" + m;
      o.textContent = p.name + " · " + m;
      sel.appendChild(o);
    }));
    sel.value = (cur.provider && cur.model) ? (cur.provider + "\u0001" + cur.model) : "";
    sel.disabled = !provs.length;
    const tip = document.getElementById("sysAiTip");
    if (tip && !provs.length) { tip.className = "ai-set-tip"; tip.textContent = "还没有接口：请先到「AI 助手」分区添加接口。"; }
    const btn = document.getElementById("sysAiSave");
    if (btn) btn.onclick = async () => {
      const v = sel.value;
      const pick = v ? { provider: v.split("\u0001")[0], model: v.split("\u0001").slice(1).join("\u0001") }
                     : { provider: "", model: "" };
      if (tip) { tip.className = "ai-set-tip"; tip.textContent = "保存中…"; }
      try {
        // 合并式保存：只改「默认接口 / 模型」，不动各模块的单独指定与启用开关
        await sysAiPatchSys(pick);
        if (tip) { tip.className = "ai-set-tip ok"; tip.textContent = "已保存 ✓"; setTimeout(() => { tip.textContent = ""; }, 2500); }
        toast("系统 AI 设置已保存", "ok");
      } catch (e) { if (tip) tip.textContent = "保存失败：" + e; }
      sysAiSyncSwitches();
    };
    sysAiBindSwitches();
    sysAiSyncSwitches();
    sysAiFillModSelects();                     // 每个模块的「单独指定模型」下拉
    sysAiBindUsageReset();
    sysAiBindModRows();
    sysAiBindBoard();                          // 「总统计」按钮：所有模块的调用汇总表
  }
  /* 点击模块行 → 弹窗展示调用明细（最近 7 天柱状 + 最近调用记录）。
     顺序与「设置 → 系统 AI」里的模块清单一致，「总统计」表也按这个顺序排。 */
  var SYS_MOD_TITLE = {
    chat: "AI 助手对话", agent: "Agent 任务", commit: "生成提交信息",
    nl2sql: "一句话生成查询", tabledesign: "AI 推荐表设计", scaffold: "新建项目 AI",
    summary: "对话记忆压缩", plugin: "插件宿主 AI", models: "拉取模型列表",
    proc: "资源占用诊断",
  };
  var sysAiDetailMod = "";
  /* 弹窗关闭统一走 sysAiBindOverlay：点「关闭」、点弹窗外面任意位置、按 Esc 都能关。
     两个坑：
       1) Esc 只挂在 overlay 元素上时，得先点一下弹窗让焦点落进去才收得到按键；
       2) 点遮罩关闭依赖 e.target 正好是遮罩本身，弹窗铺得比较大 / 上层还有别的面板时
          就点不着，看起来就像「只有点关闭按钮才关得掉」。
     所以统一改成监听 document 捕获阶段的 mousedown：只要点在弹窗盒子外面就关。
     另外「明细」是盖在「总览」上面的：sysAiOvLayer 记住最上层用的是哪一层遮罩，
     关掉明细后把「点外面 / Esc」还给下面还开着的总览。 */
  var sysAiOvClose = null;               // 最上层 AI 弹窗的关闭函数（null = 没有）
  var sysAiOvLayer = null;               // 它所在的遮罩层
  var sysAiOvBound = false;
  /* 明细弹窗要用的遮罩：总览开着时另造一层压在上面（关掉明细就回到总览）；
     总览没开（比如从设置页直接点模块行）时，仍旧用主遮罩。 */
  function sysAiDetailLayer() {
    var ov = $("modalOverlay");
    if (!ov || !ov.querySelector(".sysai-board-box")) return ov;
    var lay = document.getElementById("sysAiDetailLayer");
    if (!lay) {
      // 内嵌在 #modalOverlay 里面：既有的 .sysai-modal 尺寸规则（#modalOverlay .sysai-modal …）
      // 对它一样生效，不用再写一套
      lay = document.createElement("div");
      lay.className = "sysai-detail-layer";
      lay.id = "sysAiDetailLayer";
      ov.appendChild(lay);
    }
    return lay;
  }
  function sysAiCloseDetail() {
    sysAiCloseCallDetail();
    var lay = document.getElementById("sysAiDetailLayer");
    if (lay) { lay.classList.remove("show"); lay.innerHTML = ""; }   // 只收明细那一层
    sysAiDetailMod = "";
    var ov = $("modalOverlay");
    var board = ov && ov.querySelector(".sysai-board-box");
    if (ov && !board) {                  // 明细自己占着主遮罩 → 整层收掉
      ov.classList.remove("show");
      ov.innerHTML = "";
    }
    // 明细关掉后总览还开着：把「点外面 / Esc」继续交给它
    if (board) { sysAiOvClose = sysAiCloseBoard; sysAiOvLayer = ov; }
    else { sysAiOvClose = null; sysAiOvLayer = null; }
  }
  /* 统一的「怎么关」：点弹窗外面 / 按 Esc（都挂 document，不受遮罩层级和焦点位置影响） */
  function sysAiBindOverlay(closeFn, layer) {
    var ov = layer || $("modalOverlay");
    if (!ov) return;
    sysAiOvClose = closeFn;
    sysAiOvLayer = ov;
    if (sysAiOvBound) return;            // document 上只挂一次
    sysAiOvBound = true;
    function keep() {                    // 当前层还开着、且装的确实是我们的弹窗
      var L = sysAiOvLayer;
      if (!L || !L.isConnected || !L.classList.contains("show")) return null;
      var dlg = L.querySelector(".ide-modal");
      return dlg && dlg.classList.contains("sysai-modal") ? dlg : null;
    }
    document.addEventListener("mousedown", function (e) {
      if (!sysAiOvClose) return;
      var dlg = keep();
      if (!dlg) { sysAiOvClose = null; sysAiOvLayer = null; return; }   // 已被别的弹窗顶掉
      if (dlg.contains(e.target)) return;          // 点在弹窗里面 → 不关
      var fn = sysAiOvClose;
      sysAiOvClose = null;
      sysAiOvLayer = null;
      fn();
    }, true);
    document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape" || !sysAiOvClose) return;
      var dlg = keep();
      if (!dlg) { sysAiOvClose = null; sysAiOvLayer = null; return; }   // 已被别的弹窗顶掉
      e.preventDefault();
      var fn = sysAiOvClose;
      sysAiOvClose = null;
      sysAiOvLayer = null;
      fn();
    });
  }
  /* 点模块行 → 弹窗展示调用明细（行内展开高度太挤，看不全几行） */
  function sysAiToggleDetail(row) {
    var mod = row.dataset.modRow;
    if (!mod) return;
    if (sysAiDetailMod === mod) { sysAiCloseDetail(); return; }   // 再点同一行收起
    sysAiOpenDetail(mod);
  }
  /* 打开某个模块的调用明细弹窗（模块行、「总统计」表格里的行都走这里） */
  async function sysAiOpenDetail(mod) {
    if (!mod || !SYS_MOD_TITLE[mod]) return;
    sysAiCloseDetail();                       // 先收掉上一个明细（总览不受影响）
    var ov = sysAiDetailLayer();              // 总览开着 → 盖在它上面单独一层
    if (!ov) return;
    var box = document.createElement("div");
    box.className = "ide-modal wide sysai-modal";
    box.innerHTML =
      '<div class="m-title"><i class="bi bi-bar-chart-line"></i>' +
        '<span>' + esc(SYS_MOD_TITLE[mod] || mod) + " · 调用明细</span>" +
        '<span class="sysai-mods-sp"></span>' +
        '<span class="sysai-detail-sub" id="sysAiDetailSub">加载中…</span>' +
        '<button class="ai-set-btn sysai-all sysai-detail-close">关闭</button></div>' +
      '<div class="m-body"><div class="sysai-detail-none">加载中…</div></div>';
    ov.innerHTML = "";
    ov.appendChild(box);
    ov.classList.add("show");
    sysAiDetailMod = mod;
    var closeBtn = box.querySelector(".sysai-detail-close");
    closeBtn.onclick = function () { sysAiCloseDetail(); };
    if (ov.id === "sysAiDetailLayer") {       // 明细盖在总览上：按钮说「返回」更贴切
      closeBtn.textContent = "返回";
      closeBtn.title = "关掉明细，回到总览统计";
    }
    sysAiBindOverlay(sysAiCloseDetail, ov);   // 点外面任意位置 / 按 Esc 关明细，关完回到总览
    var body = box.querySelector(".m-body");
    try {
      // 一次多取些：弹窗空间够，比行内多得多
      var d = await (await fetch("/api/ai/usage/detail?module=" + encodeURIComponent(mod) +
                                 "&limit=200")).json();
      if (d.error) throw new Error(d.error);
      sysAiRenderDetail(body, d);
    } catch (e) {
      body.innerHTML = '<div class="sysai-detail-none">读取失败：' + esc(e.message || e) + "</div>";
    }
  }
  /* token 数缩写：12345 → 12.3k */
  function sysAiFmtTok(n) {
    n = Number(n) || 0;
    if (!n) return "0";
    return n >= 10000 ? (n / 1000).toFixed(1) + "k" : String(n);
  }
  function sysAiRenderDetail(box, d) {
    var days = d.days || [], calls = d.calls || [];
    var total = days.reduce(function (s, x) { return s + x.ok + x.fail; }, 0);
    var tkAll = (d.tokens_in || 0) + (d.tokens_out || 0);
    var hasEst = calls.some(function (c) { return c.est; });
    var sub = document.getElementById("sysAiDetailSub");
    if (sub) {                             // 概要在弹窗标题栏里
      sub.textContent =
        (days.length ? "最近 " + days.length + " 天共 " + total + " 次" : "暂无记录") +
        (tkAll ? " · 累计 " + (hasEst ? "≈ " : "") + sysAiFmtTok(tkAll) + " tokens" : "") +
        (calls.length ? " · 列出最近 " + calls.length + " 条" : "");
    }
    var max = Math.max.apply(null, [1].concat(days.map(function (x) { return x.ok + x.fail; })));
    var html = '<div class="sysai-days">' + (days.length ? days.map(function (x) {
      var oh = x.ok ? Math.max(Math.round(x.ok / max * 64), 3) : 0;
      var fh = x.fail ? Math.max(Math.round(x.fail / max * 64), 3) : 0;
      return '<div class="sysai-day" title="' + esc(x.day) + "：成功 " + x.ok + " · 失败 " + x.fail +
          (x.tokens_in || x.tokens_out
            ? " · " + sysAiFmtTok((x.tokens_in || 0) + (x.tokens_out || 0)) + " tokens" : "") + '">' +
        '<div class="sysai-day-col">' +
          (fh ? '<div class="sysai-day-fail" style="height:' + fh + 'px"></div>' : "") +
          (oh ? '<div class="sysai-day-ok" style="height:' + oh + 'px"></div>' : "") +
        '</div><div class="sysai-day-lb">' + esc(x.day.slice(5)) + "</div></div>";
    }).join("") : '<span class="sysai-detail-none">最近 7 天没有调用</span>') + "</div>";
    html += '<div class="sysai-calls">' +
      (calls.length ? '<div class="sysai-call sysai-call-hd">' +
        '<span class="sysai-call-ts">时间</span>' +
        '<span class="sysai-call-r">结果</span>' +
        '<span class="sysai-call-ms">耗时</span>' +
        '<span class="sysai-call-model">模型</span>' +
        '<span class="sysai-call-tok">tokens</span>' +
        '<span class="sysai-call-req">请求</span>' +
        '<span class="sysai-call-err">说明</span></div>' : "") +
      (calls.length ? calls.map(function (c) {
      var tk = (c.tokens_in || c.tokens_out)
        ? (c.est ? "≈ " : "") + sysAiFmtTok(c.tokens_in) + " → " + sysAiFmtTok(c.tokens_out) : "-";
      return '<div class="sysai-call' + (c.ok ? "" : " err") +
        '" data-call-id="' + esc(c.id == null ? "" : c.id) + '" title="点击查看这次调用的详情">' +
        '<span class="sysai-call-ts">' + esc(c.ts) + "</span>" +
        '<span class="sysai-call-r">' + (c.ok ? "成功" : "失败") + "</span>" +
        '<span class="sysai-call-ms">' + (c.ms ? c.ms + " ms" : "-") + "</span>" +
        '<span class="sysai-call-model" title="' + esc(c.model || "未记录") + '">' +
          esc(c.model || "-") + "</span>" +
        '<span class="sysai-call-tok" title="' + (c.est
          ? "按字数估算（上游未返回用量）：输入 → 输出"
          : "输入 → 输出 tokens") + '">' + esc(tk) + "</span>" +
        '<span class="sysai-call-req" title="' + esc(c.req || "未记录") + '">' +
          (c.req ? esc(c.req) : '<span class="sysai-pop-none">-</span>') + "</span>" +
        '<span class="sysai-call-err">' + esc(c.error || "") + "</span></div>";
    }).join("") : '<div class="sysai-detail-none">还没有调用记录</div>') + "</div>";
    box.innerHTML = "";                  // 先清掉「加载中…」占位（原来是追加，占位会留在最上面）
    box.insertAdjacentHTML("beforeend", html);
    // 每行可点开：按 id 拉取该次调用的请求 / 响应摘要，就地弹一个悬浮框
    box.querySelectorAll(".sysai-call[data-call-id]").forEach(function (row) {
      if (!row.dataset.callId) return;
      row.classList.add("clickable");
      row.onclick = function () { sysAiToggleCallDetail(row); };
    });
  }
  /* 点击某一行 → 该行下方就地弹出「这次调用的详情」（请求 / 响应摘要） */
  var sysAiPopId = "";
  function sysAiCloseCallDetail() {
    var el = document.getElementById("sysAiCallPop");
    if (el) el.remove();
    sysAiPopId = "";
    document.querySelectorAll(".sysai-call.sel").forEach(function (x) {
      x.classList.remove("sel");
    });
  }
  async function sysAiToggleCallDetail(row) {
    var id = row.dataset.callId;
    if (!id) return;
    if (sysAiPopId === id) { sysAiCloseCallDetail(); return; }   // 再点一次收起
    sysAiCloseCallDetail();
    sysAiPopId = id;
    row.classList.add("sel");
    var pop = document.createElement("div");
    pop.className = "sysai-pop";
    pop.id = "sysAiCallPop";
    pop.innerHTML = '<div class="sysai-pop-hd"><i class="bi bi-hourglass-split"></i>' +
      "调用详情<span class=\"sysai-mods-sp\"></span>加载中…</div>";
    row.after(pop);                       // 就地展开，跟着当前滚动位置
    try {
      var d = await (await fetch("/api/ai/usage/call?id=" + encodeURIComponent(id))).json();
      if (d.error) throw new Error(d.error);
      sysAiRenderCallPop(pop, d.call || {});
    } catch (e) {
      pop.innerHTML = '<div class="sysai-pop-hd"><i class="bi bi-exclamation-triangle"></i>' +
        "读取失败：" + esc(e.message || e) +
        '<span class="sysai-mods-sp"></span><button class="ai-set-btn sysai-pop-close">关闭</button></div>';
      pop.querySelector(".sysai-pop-close").onclick = sysAiCloseCallDetail;
    }
  }
  function sysAiRenderCallPop(pop, c) {
    var tk = (c.tokens_in || c.tokens_out)
      ? (c.est ? "≈ " : "") + sysAiFmtTok(c.tokens_in) + " → " + sysAiFmtTok(c.tokens_out) +
        (c.est ? "（估算）" : "")
      : "未记录";
    var kvs = [
      ["时间", esc(c.ts || "-")],
      ["结果", c.ok ? "成功" : "失败"],
      ["耗时", c.ms ? c.ms + " ms" : "-"],
      ["模型", esc(c.model || "未记录")],
      ["tokens", esc(tk)],
    ];
    if (c.error) kvs.push(["错误", esc(c.error), "err"]);   // 第三项 = 附加 class
    pop.innerHTML =
      '<div class="sysai-pop-hd"><i class="bi bi-info-circle"></i>' +
        esc(SYS_MOD_TITLE[c.module] || c.module || "") + " · 调用详情" +
        '<span class="sysai-mods-sp"></span>' +
        '<button class="ai-set-btn sysai-pop-close">关闭</button></div>' +
      '<div class="sysai-pop-meta">' + kvs.map(function (kv) {
        return '<span class="sysai-pop-kv' + (kv[2] ? " " + kv[2] : "") + '"><b>' + kv[0] +
          "</b>" + kv[1] + "</span>";
      }).join("") + "</div>" +
      '<div class="sysai-pop-sec"><div class="sysai-pop-lb">请求</div>' +
        '<pre class="sysai-pop-txt">' +
          (c.req ? esc(c.req) : '<span class="sysai-pop-none">未记录</span>') + "</pre></div>" +
      '<div class="sysai-pop-sec"><div class="sysai-pop-lb">响应</div>' +
        '<pre class="sysai-pop-txt">' +
          (c.resp ? esc(c.resp) : '<span class="sysai-pop-none">未记录</span>') + "</pre></div>";
    pop.querySelector(".sysai-pop-close").onclick = sysAiCloseCallDetail;
  }
  function sysAiBindModRows() {
    document.querySelectorAll(".sysai-mod[data-mod-row]").forEach(function (row) {
      row.classList.add("clickable");
      row.onclick = function (e) {
        if (e.target.closest && e.target.closest(".sysai-sw")) return;   // 点开关不展开明细
        sysAiToggleDetail(row);
      };
    });
  }
  /* 调用次数统计：读 /api/ai/usage 填到每行的 .sysai-stat 上 */
  function sysAiRenderUsage(u) {
    sysAiUsageCache = u || {};         // 顺手喂给「总统计」弹窗，点开时不必等网络
    document.querySelectorAll(".sysai-stat").forEach(sp => {
      const d = (u || {})[sp.dataset.stat];
      if (!d || (!d.ok && !d.fail)) {
        sp.textContent = "暂无调用";
        sp.className = "sysai-stat";
        sp.title = "";
        return;
      }
      // 成功、失败分开着色：之前有失败时整段变红，把「成功 5」也染红了
      if (d.fail) {
        sp.innerHTML = '<span class="sysai-ok">成功 ' + d.ok + "</span> · " +
          '<span class="sysai-bad">失败 ' + d.fail + "</span>";
      } else {
        sp.innerHTML = '<span class="sysai-ok">成功 ' + d.ok + "</span>";
      }
      sp.className = "sysai-stat" + (d.fail ? " has-fail" : " ok");
      const tk = (d.tokens_in || 0) + (d.tokens_out || 0);
      sp.title = "共 " + (d.ok + d.fail) + " 次" +
        (tk ? "；累计 " + sysAiFmtTok(tk) + " tokens（输入 " + sysAiFmtTok(d.tokens_in) +
              " / 输出 " + sysAiFmtTok(d.tokens_out) + "）" : "") +
        (d.last_at ? "；最近一次 " + d.last_at + (d.last_ms ? "（" + d.last_ms + " ms）" : "") : "") +
        (d.last_error ? "；最近错误：" + d.last_error : "");
    });
  }
  async function sysAiLoadUsage() {
    try {
      const r = await fetch("/api/ai/usage");
      const d = await r.json();
      if (!d.error) sysAiRenderUsage(d.usage || {});
    } catch (_) { /* 统计拿不到不影响设置页 */ }
  }
  function sysAiBindUsageReset() {
    const btn = document.getElementById("sysAiUsageReset");
    if (!btn) return;
    btn.onclick = async () => {
      const ok = await uiConfirm("重置调用统计", "把各模块的成功 / 失败次数清零？（不影响其他设置）", "重置", false);
      if (!ok) return;
      btn.disabled = true;
      try {
        const d = await (await fetch("/api/ai/usage", { method: "DELETE" })).json();
        if (d.error) throw new Error(d.error);
        sysAiRenderUsage(d.usage || {});
        toast("调用统计已重置", "ok");
      } catch (e) {
        toast("重置失败：" + (e.message || e), "warn");
      } finally {
        btn.disabled = false;
      }
    };
  }
  /* ---------------- 「总统计」：所有模块的调用汇总表（悬浮框） ---------------- */
  var sysAiUsageCache = null;        // 最近一次 /api/ai/usage 的结果：弹窗先用它渲染，再拉新数据
  /* 表格排序状态：key = 列（空 = 模块原始顺序），dir = -1 降序 / 1 升序。
     点表头切换，状态存在这里，「刷新」或重画后继续保持。 */
  var sysAiBoardSort = { key: "", dir: -1 };
  function sysAiSortVal(r, k) {
    var n = r.ok + r.fail;
    if (k === "ok") return r.ok;
    if (k === "fail") return r.fail;
    if (k === "total") return n;
    if (k === "rate") return n ? r.ok / n : -1;      // 没调用过的排最后
    if (k === "tok") return r.tin + r.tout;
    if (k === "last") return r.last_at || "";        // "2026-10-07 14:45:11" 直接按字符串比
    return 0;
  }
  function sysAiBoardAttr(s) {       // 放进属性里的小转义（错误信息可能带引号）
    return esc(s == null ? "" : s).replace(/"/g, "&quot;");
  }
  function sysAiCloseBoard() {
    sysAiCloseDetail();                       // 明细（如果开着）一起收掉
    var ov = $("modalOverlay");
    if (ov && ov.querySelector(".sysai-board-box")) {
      ov.classList.remove("show");            // 再收总览自己
      ov.innerHTML = "";
    }
    sysAiOvClose = null;
    sysAiOvLayer = null;
  }
  async function sysAiOpenBoard() {
    var ov = $("modalOverlay");
    if (!ov) return;
    var box = document.createElement("div");
    box.className = "ide-modal wide sysai-modal sysai-board-box";
    box.innerHTML =
      '<div class="m-title"><i class="bi bi-table"></i>' +
        '<span>系统 AI · 所有模块使用统计</span>' +
        '<span class="sysai-mods-sp"></span>' +
        '<span class="sysai-detail-sub" id="sysAiBoardSub">加载中…</span>' +
        '<button class="ai-set-btn sysai-all" id="sysAiBoardRefresh" title="重新读取统计">' +
          '<i class="bi bi-arrow-clockwise"></i> 刷新</button>' +
        '<button class="ai-set-btn sysai-all sysai-board-close">关闭</button></div>' +
      '<div class="m-body sysai-board-body"><div class="sysai-detail-none">加载中…</div></div>';
    ov.innerHTML = "";
    ov.appendChild(box);
    ov.classList.add("show");
    box.querySelector(".sysai-board-close").onclick = sysAiCloseBoard;
    sysAiBindOverlay(sysAiCloseBoard);        // 点弹窗外面任意位置 / 按 Esc 也能关
    var body = box.querySelector(".m-body");
    if (sysAiUsageCache) sysAiRenderBoard(body, sysAiUsageCache);   // 有缓存先画，避免白屏
    var load = async function () {
      try {
        var d = await (await fetch("/api/ai/usage")).json();
        if (d.error) throw new Error(d.error);
        sysAiRenderBoard(body, d.usage || {});
      } catch (e) {
        body.innerHTML = '<div class="sysai-detail-none">读取失败：' + esc(e.message || e) + "</div>";
      }
    };
    box.querySelector("#sysAiBoardRefresh").onclick = load;
    await load();
  }
  function sysAiRenderBoard(box, u) {
    sysAiUsageCache = u;
    var tot = { ok: 0, fail: 0, tin: 0, tout: 0 };
    var rows = Object.keys(SYS_MOD_TITLE).map(function (m) {
      var d = u[m] || {};
      var ok = d.ok || 0, fail = d.fail || 0;
      tot.ok += ok; tot.fail += fail;
      tot.tin += d.tokens_in || 0; tot.tout += d.tokens_out || 0;
      return { m: m, ok: ok, fail: fail, tin: d.tokens_in || 0, tout: d.tokens_out || 0,
               last_at: d.last_at || "", last_ms: d.last_ms || 0, err: d.last_error || "" };
    });
    if (sysAiBoardSort.key) {                  // 点过表头才排序，没点保持模块原始顺序
      var sk = sysAiBoardSort.key, sd = sysAiBoardSort.dir;
      rows.sort(function (a, b) {
        var va = sysAiSortVal(a, sk), vb = sysAiSortVal(b, sk);
        if (va === vb) return (b.ok + b.fail) - (a.ok + a.fail);   // 同值按调用次数兜底，顺序稳定
        return va > vb ? sd : -sd;
      });
    }
    var all = tot.ok + tot.fail;
    var sub = document.getElementById("sysAiBoardSub");
    if (sub) {
      sub.textContent = all
        ? "共 " + all + " 次调用 · 成功 " + tot.ok + " · 失败 " + tot.fail
        : "还没有任何调用记录";
    }
    var cards =
      '<div class="sysai-board-card"><b>' + all + "</b><span>总调用</span></div>" +
      '<div class="sysai-board-card ok"><b>' + tot.ok + "</b><span>成功</span></div>" +
      '<div class="sysai-board-card bad"><b>' + tot.fail + "</b><span>失败</span></div>" +
      '<div class="sysai-board-card"><b>' + (all ? Math.round(tot.ok / all * 100) + "%" : "-") +
        "</b><span>成功率</span></div>" +
      '<div class="sysai-board-card"><b>' + sysAiFmtTok(tot.tin + tot.tout) +
        "</b><span>累计 tokens</span></div>";
    var body = rows.map(function (r) {
      var n = r.ok + r.fail;
      var tk = (r.tin || r.tout) ? sysAiFmtTok(r.tin) + " → " + sysAiFmtTok(r.tout) : "-";
      var last = r.last_at ? (r.last_at + (r.last_ms ? " · " + r.last_ms + " ms" : "")) : "-";
      return '<div class="sysai-board-row' + (r.fail ? " has-fail" : "") + (n ? " clickable" : "") +
        '" data-board-mod="' + sysAiBoardAttr(r.m) + '">' +
        '<span class="sb-name">' + esc(SYS_MOD_TITLE[r.m] || r.m) + "</span>" +
        '<span class="sb-num ok">' + r.ok + "</span>" +
        '<span class="sb-num' + (r.fail ? " bad" : "") + '">' + r.fail + "</span>" +
        '<span class="sb-num">' + n + "</span>" +
        '<span class="sb-num">' + (n ? Math.round(r.ok / n * 100) + "%" : "-") + "</span>" +
        '<span class="sb-tok">' + esc(tk) + "</span>" +
        '<span class="sb-last">' + esc(last) + "</span>" +
        '<span class="sb-err" title="' + sysAiBoardAttr(r.err) + '">' +
          (r.err ? esc(r.err) : '<span class="sysai-pop-none">-</span>') + "</span></div>";
    }).join("");
    var sum = '<div class="sysai-board-row sum">' +
      '<span class="sb-name">全部模块</span>' +
      '<span class="sb-num ok">' + tot.ok + "</span>" +
      '<span class="sb-num' + (tot.fail ? " bad" : "") + '">' + tot.fail + "</span>" +
      '<span class="sb-num">' + all + "</span>" +
      '<span class="sb-num">' + (all ? Math.round(tot.ok / all * 100) + "%" : "-") + "</span>" +
      '<span class="sb-tok">' + sysAiFmtTok(tot.tin) + " → " + sysAiFmtTok(tot.tout) + "</span>" +
      '<span class="sb-last">-</span><span class="sb-err sysai-pop-none">-</span></div>';
    // 表头：能排序的列挂 data-sort（模块 / 最近错误不参与排序），当前排序列带箭头
    var cols = [
      ["sb-name", "", "模块"],
      ["sb-num", "ok", "成功"],
      ["sb-num", "fail", "失败"],
      ["sb-num", "total", "合计"],
      ["sb-num", "rate", "成功率"],
      ["sb-tok", "tok", "tokens（入 → 出）"],
      ["sb-last", "last", "最近调用"],
      ["sb-err", "", "最近错误 / 说明"]
    ];
    var hd = '<div class="sysai-board-row hd">' + cols.map(function (c) {
      if (!c[1]) {                     // 模块列：点一下恢复默认顺序；错误说明列不可点
        return c[0] === "sb-name"
          ? '<span class="sb-name sortable" data-reset="1" title="点击：恢复模块默认顺序">模块</span>'
          : '<span class="' + c[0] + '">' + c[2] + "</span>";
      }
      var on = sysAiBoardSort.key === c[1];
      var next = on && sysAiBoardSort.dir < 0 ? "升序" : "降序";
      return '<span class="' + c[0] + " sortable" + (on ? " on" : "") + '" data-sort="' + c[1] +
        '" title="点击按「' + c[2].replace("（入 → 出）", "") + "」" + next + '排序">' + c[2] +
        (on ? '<i class="bi bi-caret-' + (sysAiBoardSort.dir < 0 ? "down" : "up") + '-fill"></i>' : "") +
        "</span>";
    }).join("") + "</div>";
    box.innerHTML =
      '<div class="sysai-board">' +
        '<div class="sysai-board-sum">' + cards + "</div>" +
        '<div class="sysai-board-tb scroll-thin">' + hd +
          (all ? body + sum
               : '<div class="sysai-detail-none" style="padding:10px 12px">还没有任何 AI 调用记录</div>') +
        "</div>" +
        sysAiBoardChart(rows, tot) +
      "</div>";
    // 点表头排序：同一列再点一下反过来，换列则从降序开始；用缓存重画，不再请求接口
    box.querySelectorAll(".sysai-board-row.hd .sortable").forEach(function (th) {
      th.onclick = function () {
        if (th.dataset.reset) { sysAiBoardSort.key = ""; sysAiBoardSort.dir = -1; }   // 点「模块」→ 还原默认顺序
        else {
          var k = th.dataset.sort;
          if (sysAiBoardSort.key === k) sysAiBoardSort.dir = -sysAiBoardSort.dir;
          else { sysAiBoardSort.key = k; sysAiBoardSort.dir = -1; }
        }
        var tb = box.querySelector(".sysai-board-tb");
        var st = tb ? tb.scrollTop : 0;
        sysAiRenderBoard(box, sysAiUsageCache);
        var tb2 = box.querySelector(".sysai-board-tb");
        if (tb2) tb2.scrollTop = st;              // 保持原来的滚动位置
      };
    });
    // 表格行 / 图表横条都能点：跳到该模块的调用明细（最近 7 天柱状 + 调用列表）
    box.querySelectorAll(".sysai-board-row[data-board-mod], .sysai-bar-row[data-board-mod]")
      .forEach(function (row) {
        if (row.classList.contains("sysai-board-row") && !row.classList.contains("clickable")) return;
        row.onclick = function () { sysAiOpenDetail(row.dataset.boardMod); };
      });
  }
  /* 图表区：左边各模块调用次数堆叠横条（绿=成功 / 红=失败，长度按最多的那个模块归一），
     右边整体成功率环 + 成功 / 失败 / tokens 概要。用纯 SVG + div 画，不引第三方库。 */
  function sysAiBoardChart(rows, tot) {
    var all = tot.ok + tot.fail;
    var max = Math.max.apply(null, [1].concat(rows.map(function (r) { return r.ok + r.fail; })));
    var list = rows.filter(function (r) { return r.ok + r.fail > 0; });
    if (!sysAiBoardSort.key) {             // 没点表头排序时：按调用次数从多到少（图表原本的顺序）
      list.sort(function (a, b) { return (b.ok + b.fail) - (a.ok + a.fail); });
    }                                      // 点过表头排序时，横条顺序跟着表格一起走（rows 已排好）
    var bars = list.length ? list.map(function (r) {
      var okW = (r.ok / max * 100).toFixed(2), badW = (r.fail / max * 100).toFixed(2);
      return '<div class="sysai-bar-row clickable" data-board-mod="' + sysAiBoardAttr(r.m) +
        '" title="' + sysAiBoardAttr(SYS_MOD_TITLE[r.m] || r.m) + "：成功 " + r.ok + " · 失败 " + r.fail +
        '，点击查看调用明细">' +
        '<span class="sysai-bar-nm">' + esc(SYS_MOD_TITLE[r.m] || r.m) + "</span>" +
        '<span class="sysai-bar-track">' +
          (r.ok ? '<span class="sysai-bar-ok" style="width:' + okW + '%"></span>' : "") +
          (r.fail ? '<span class="sysai-bar-fail" style="width:' + badW + '%"></span>' : "") +
        "</span>" +
        '<span class="sysai-bar-vl" title="成功 / 失败">' + r.ok + " / " + r.fail + "</span></div>";
    }).join("") : '<div class="sysai-detail-none">还没有调用记录，图表暂无数据</div>';
    var pct = all ? tot.ok / all * 100 : 0;
    // r=15.915 → 周长 100，所以 dasharray 直接写百分比；offset 25 让起点落在 12 点方向
    var ring = '<svg viewBox="0 0 42 42">' +
      '<circle class="sysai-ring-bg" cx="21" cy="21" r="15.915"></circle>' +
      (all ? '<circle class="sysai-ring-ok" cx="21" cy="21" r="15.915" stroke-dasharray="' +
               pct.toFixed(2) + " " + (100 - pct).toFixed(2) + '" stroke-dashoffset="25"></circle>' : "") +
      (tot.fail ? '<circle class="sysai-ring-bad" cx="21" cy="21" r="15.915" stroke-dasharray="' +
               (100 - pct).toFixed(2) + " " + pct.toFixed(2) + '" stroke-dashoffset="' +
               (25 - pct).toFixed(2) + '"></circle>' : "") +
      "</svg>";
    return '<div class="sysai-chart">' +
      '<div class="sysai-chart-l">' +
        '<div class="sysai-chart-hd"><i class="bi bi-bar-chart"></i>各模块调用次数' +
          '<span class="sysai-legend"><span class="ok"><i></i>成功</span>' +
          '<span class="bad"><i></i>失败</span></span></div>' +
        '<div class="sysai-bars">' + bars + "</div></div>" +
      '<div class="sysai-chart-r">' +
        '<div class="sysai-ring">' + ring +
          '<div class="sysai-ring-c"><b>' + (all ? Math.round(pct) + "%" : "—") +
          "</b><span>成功率</span></div></div>" +
        '<div class="sysai-ring-t">成功 <b class="ok">' + tot.ok + '</b> · 失败 <b class="bad">' +
          tot.fail + "</b></div>" +
        '<div class="sysai-ring-t2">累计 ' + sysAiFmtTok(tot.tin + tot.tout) + " tokens</div>" +
      "</div></div>";
  }
  function sysAiBindBoard() {
    var btn = document.getElementById("sysAiBoard");
    if (btn) btn.onclick = sysAiOpenBoard;
  }
  /* 合并式保存系统 AI 设置：只改传入的字段，其余（off / per_module / provider / model）保持原样。
     整体覆盖会把别处刚改的值冲掉（历史上顶部「保存」就会把模块开关状态清空），所以统一走这里。 */
  async function sysAiPatchSys(patch, okMsg) {
    const cur = AI.sys || {};
    const sys = {
      provider: cur.provider || "", model: cur.model || "",
      off: (cur.off || []).slice(),
      per_module: Object.assign({}, cur.per_module || {}),
    };
    Object.assign(sys, patch || {});
    const r = await fetch("/api/ai/config", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sys: sys }) });
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    AI.sys = d.sys || {};                     // 以后端落库结果为准
    if (okMsg) toast(okMsg, "ok");
    // 停用状态变了：通知各功能入口（SQL 的 AI 生成、新建项目的 AI 生成…）跟着显示 / 隐藏
    if (typeof window.refreshSysAiOff === "function") window.refreshSysAiOff();
    return AI.sys;
  }

  /* 模块启停：只改 off 列表 */
  function sysAiSaveSys(off, okMsg) {
    return sysAiPatchSys({ off: off }, okMsg);
  }

  /* 每个模块单独指定接口 / 模型（留空 = 用顶部那套默认；再没有就跟随 AI 助手） */
  function sysAiFillModSelects() {
    const provs = AI.providers || [];
    const per = (AI.sys || {}).per_module || {};
    document.querySelectorAll(".sysai-sw").forEach(lb => {
      const mod = lb.dataset.mod;
      const row = lb.closest(".sysai-mod");
      if (!mod || !row) return;
      let sel = row.querySelector(".sysai-model");
      if (!sel) {
        sel = document.createElement("select");
        sel.className = "sysai-model";
        sel.title = "该功能单独使用的接口 / 模型（默认 = 用上面的设置）";
        lb.parentNode.insertBefore(sel, lb);  // 放在开关左边（开关已包在 .sysai-mod-ctl 内，须插到它的父容器里）
      }
      sel.innerHTML = "";
      const dflt = document.createElement("option");
      dflt.value = "";
      dflt.textContent = "默认模型";
      sel.appendChild(dflt);
      provs.forEach(p => (p.models || []).forEach(m => {
        const o = document.createElement("option");
        o.value = p.id + "\u0001" + m;
        o.textContent = p.name + " · " + m;
        sel.appendChild(o);
      }));
      const cur = per[mod] || {};
      sel.value = cur.provider ? (cur.provider + "\u0001" + (cur.model || "")) : "";
      sel.disabled = !provs.length;
      sel.onchange = async () => {
        const v = sel.value;
        const per2 = Object.assign({}, (AI.sys || {}).per_module || {});
        if (v) per2[mod] = { provider: v.split("\u0001")[0], model: v.split("\u0001").slice(1).join("\u0001") };
        else delete per2[mod];
        sel.disabled = true;
        try {
          await sysAiPatchSys({ per_module: per2 }, "已保存该功能的模型选择");
        } catch (e) {
          toast("保存失败：" + (e.message || e), "err");
        } finally {
          sysAiFillModSelects();
        }
      };
    });
  }
  function sysAiSyncSwitches() {
    const off = (AI.sys || {}).off || [];
    document.querySelectorAll(".sysai-sw").forEach(lb => {
      const inp = lb.querySelector("input");
      if (!inp) return;
      inp.checked = off.indexOf(lb.dataset.mod) < 0;
      inp.disabled = false;
      const row = lb.closest(".sysai-mod");
      if (row) {
        row.classList.toggle("off", !inp.checked);   // 停用的整行变淡
        row.dataset.modRow = lb.dataset.mod;         // 供「点击看明细」识别模块
      }
    });
    const all = document.getElementById("sysAiAllOn");
    if (all) all.disabled = !off.length;
  }
  function sysAiBindSwitches() {
    document.querySelectorAll(".sysai-sw").forEach(lb => {
      const inp = lb.querySelector("input");
      if (!inp) return;
      inp.onchange = async () => {              // 用 onchange 赋值，重复挂载也不会叠加监听
        const mod = lb.dataset.mod;
        const on = inp.checked;
        const off = ((AI.sys || {}).off || []).filter(m => m !== mod);
        if (!on) off.push(mod);
        inp.disabled = true;
        try {
          await sysAiSaveSys(off, on ? "已启用该模块" : "已停用该模块");
        } catch (e) {
          inp.checked = !on;                    // 保存失败回滚，避免界面与实际不一致
          toast("保存失败：" + (e.message || e), "warn");
        } finally {
          sysAiSyncSwitches();
        }
      };
    });
    const all = document.getElementById("sysAiAllOn");
    if (all) all.onclick = async () => {
      all.disabled = true;
      try { await sysAiSaveSys([], "已全部启用"); }
      catch (e) { toast("保存失败：" + (e.message || e), "warn"); }
      finally { sysAiSyncSwitches(); }
    };
  }
  // 设置页打开时：确保配置已加载再渲染下拉（避免与 aiLoadCfg 互相递归）
  async function sysAiEnsure() {
    if (!(AI.providers || []).length) await aiLoadCfg();
    sysAiMountSettings();
    sysAiLoadUsage();        // 调用次数统计（异步，不阻塞设置页渲染）
  }
  function aiCollectProviders() {
    return Array.from($("aiProvList").querySelectorAll(".ai-prov")).map(card => ({
      id: card.dataset.pid,
      name: card.querySelector(".nm").value.trim(),
      base_url: card.querySelector(".u").value.trim(),
      api_key: card.querySelector(".k").value.trim(),
      models: card.querySelector(".ms").value.split(/[，,]/).map(s => s.trim()).filter(Boolean),
    }));
  }
  function aiRecordStat(ok, ms, chars, ttft, inTok, realIn, realOut, ctxTok) {   // 每次请求统计（参考 Trae 底部状态栏）
    const s = AI.sessions.find(x => x.id === AI.curId);
    if (!s) return;
    s.stats = s.stats || { total: 0, ok: 0, msSum: 0, msLast: 0, tokLast: 0, ttftSum: 0, ttftN: 0, inSum: 0, outSum: 0, estN: 0 };
    const st = s.stats;
    st.total++;
    if (ok) st.ok++;
    st.msSum = (st.msSum || 0) + Math.round(ms || 0);      // || 0 兜底：旧版 stats 无这些字段（undefined/NaN）也能自愈
    st.msLast = Math.round(ms || 0);
    st.tokLast = Math.ceil((chars || 0) / 2);
    if (ttft > 0) { st.ttftSum = (st.ttftSum || 0) + ttft; st.ttftN = (st.ttftN || 0) + 1; }
    // token：接口给了真实 usage 就用真实值（无「~」），拿不到才按字数估算（estN 记录估算次数，界面据此决定是否加「~」）
    const exact = (realIn > 0) || (realOut > 0);
    st.inSum = (st.inSum || 0) + (realIn > 0 ? Math.round(realIn) : Math.round(inTok || 0));
    st.outSum = (st.outSum || 0) + (realOut > 0 ? Math.round(realOut) : st.tokLast);   // 输出无条件累计：失败/中途停止也可能已产出内容
    if (exact) {
      st.realIn = (st.realIn || 0) + Math.round(realIn || 0);
      st.realOut = (st.realOut || 0) + Math.round(realOut || 0);
    } else {
      st.estN = (st.estN || 0) + 1;
    }
    if (ctxTok > 0) st.ctxLast = Math.round(ctxTok);   // 最近一次请求的输入规模（= 当前上下文占用，非累计）
    aiPersistCurrent();
    aiRenderStats();
    aiUpdateCtxRing();   // 上下文占用圆环：优先用「最近一次请求的上下文大小」
  }
  function aiRenderStats() {                              // 面板最底部总览状态栏
    const el = $("aiStats");
    if (!el) return;
    const s = AI.sessions.find(x => x.id === AI.curId);
    const st = s && s.stats;
    const memLen = (s && s.mem || "").length;
    // 兜底：旧版本仅在「成功」时才累计输出 token，历史会话 outSum 会一直停在 0 —— 按当前会话的回复内容重算一次
    if (st && st.total && !st.outSum) {
      const chars = (AI.msgs || []).reduce((a, m) => a + ((m && m.role === "assistant") ? (m.text || "").length : 0), 0);
      if (chars) st.outSum = Math.ceil(chars / 2);
    }
    if ((!st || !st.total) && !memLen) { el.style.display = "none"; return; }
    const fmtT = ms => { const v = ms / 1000; return v >= 60 ? Math.floor(v / 60) + "分" + Math.round(v % 60) + "秒" : v.toFixed(1) + "s"; };
    const fmtK = n => n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1000 ? (n / 1000).toFixed(1) + "K" : String(Math.round(n));
    const parts = [];
    if (st && st.total) {
      const rate = Math.round(st.ok / st.total * 100);
      const rc = rate >= 80 ? "good" : (rate >= 50 ? "mid" : "bad");
      parts.push(st.total + ' 轮 · <span class="ai-rate ' + rc + '">成功率 ' + rate + '%</span>');
      parts.push('LLM ' + fmtT(st.msSum || 0));
      if (st.ttftN) {
        const avgTtft = (st.ttftSum / st.ttftN) / 1000;
        const genMs = (st.msSum || 0) - (st.ttftSum || 0);
        const speed = genMs > 0 && st.outSum > 0 ? Math.round(st.outSum / (genMs / 1000)) : 0;
        parts.push('首 token 平均 ' + avgTtft.toFixed(1) + 's' + (speed ? ' · ' + speed + ' tok/s' : ''));
      }
      const est = (st.estN || 0) > 0;        // 会话里出现过估算轮次 → 数字前加「~」提示不是精确值
      // 「累计」= 本会话所有请求的 token 总和：智能体每一步都要重发一遍上下文，所以会远大于「当前上下文」
      parts.push('累计 输入 ' + (est ? '~' : '') + fmtK(st.inSum || 0) + ' tok · 输出 ' + (est ? '~' : '') + fmtK(st.outSum || 0) + ' tok');
      if (st.ctxLast) parts.push('当前上下文 ' + fmtK(st.ctxLast) + ' tok');
    }
    if (memLen) parts.push('记忆 ' + memLen + ' 字' + (s.cmp ? '（压缩×' + s.cmp + ' 省~' + (s.savedTok || 0) + ' tok）' : ''));
    el.innerHTML = parts.join(' <span class="ai-sep">|</span> ');
    el.style.display = "";
  }
  function aiRenderConv() {
    const s = AI.sessions.find(x => x.id === AI.curId);
    $("aiConvTitle").textContent = (s && s.title) || "新对话";
    aiRenderStats();                                      // 统计条跟随当前会话
    aiUpdateCtxRing();                                    // 上下文占用圆环也跟随当前会话（切换/删除对话后重算）
    aiRenderActiveSkills();                               // 标题栏激活技能跟随当前输入框
  }
  function aiRenderHist() {
    const box = $("aiHist");
    // 按「最后消息时间」倒序展示，与后端列表顺序一致（发消息后该行更新并置顶）
    const list = AI.sessions.slice().sort((a, b) => (b.time || 0) - (a.time || 0));
    // 对话按项目隔离：空列表说明「这个项目」还没有对话，提示里点明归属避免误解
    const pn = (typeof aiProjectName === "function") ? aiProjectName() : "";
    box.innerHTML = list.length ? "" : '<div class="ai-hist-empty">' +
      (pn ? '项目「' + esc(pn) + '」暂无历史对话' : "暂无历史对话") +
      '<div class="sub">对话记录随项目保存，切换项目各自独立</div></div>';
    list.forEach(s => {
      const row = document.createElement("div");
      row.className = "ai-hist-row" + (s.id === AI.curId ? " on" : "");
      const t = document.createElement("span"); t.className = "tt";
      t.textContent = s.title || "新对话"; t.title = s.title || "";
      const tm = document.createElement("span"); tm.className = "tm";
      tm.textContent = s.time ? new Date(s.time).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";
      const del = document.createElement("button"); del.className = "rm"; del.title = "删除该对话";
      del.innerHTML = '<i class="bi bi-trash3"></i>';
      del.addEventListener("click", async (e) => {
        e.stopPropagation();
        const sid = s.id;
        try { await fetch("/api/ai/sessions/" + encodeURIComponent(sid), { method: "DELETE" }); } catch (_) {}
        AI.sessions = AI.sessions.filter(x => x.id !== sid);
        if (AI.curId === sid) {
          AI.curId = AI.sessions[0] ? AI.sessions[0].id : "";
          AI.msgs = AI.sessions[0] ? (AI.sessions[0].msgs || []) : [];
          if (AI.curId) aiSetCur(AI.curId);
          aiRenderAll();
        }
        aiRenderHist(); aiRenderConv();
      });
      row.addEventListener("click", () => aiSwitchSession(s.id));
      row.appendChild(t); row.appendChild(tm); row.appendChild(del);
      box.appendChild(row);
    });
  }
  function aiSwitchSession(id) {
    $("aiHist").style.display = "none";
    if (id === AI.curId) return;
    if (AI.busy) aiHaltRun();                    // 切换前停止正在生成的回复（并通知服务端停止后台任务）
    aiPersistCurrent();                          // 先保存当前会话（异步）
    AI.curId = id;
    aiSetCur(id);
    const s = AI.sessions.find(x => x.id === id);
    if (s && s.msgs == null) {                   // 尚未加载过完整消息 → 从后端拉取
      aiFetchSession(id).then(() => {
        const cur = AI.sessions.find(x => x.id === id);
        AI.msgs = (cur && cur.msgs) || [];
        aiRenderAll(); aiRenderConv();
      });
      AI.msgs = [];
    } else {
      AI.msgs = s ? (s.msgs || []) : [];
    }
    aiRenderAll(); aiRenderConv();
  }
  $("aiToggle").addEventListener("click", () => toggleAI());
  $("aiCloseBtn").addEventListener("click", () => toggleAI(false));
  $("aiCfgBtn").addEventListener("click", () => aiOpenSettings());
  $("aiNewBtn").addEventListener("click", () => {
    if (AI.busy) aiHaltRun();
    aiPersistCurrent();                          // 保存上一个会话
    AI.curId = "s" + Date.now().toString(36);
    AI.msgs = [];
    AI.files = [];                               // 新对话不继承上一个对话附加的文件
    const _taNew = $("aiText");                  // 输入框里的文件 / 图片芯片一并清掉
    if (_taNew) Array.from(_taNew.querySelectorAll(".ai-tag-file, .ai-tag-img")).forEach(el => el.remove());
    const s = { id: AI.curId, title: "", time: Date.now(), msgs: [], _dirty: true, _savedPids: new Set() };
    AI.sessions.unshift(s);
    aiSetCur(AI.curId);
    $("aiHist").style.display = "none";
    aiRenderAll(); aiRenderConv(); aiRenderHist();
    $("aiText").focus();
  });
  $("aiConvBtn").addEventListener("click", () => {
    const box = $("aiHist");
    const show = box.style.display === "none";
    if (show) aiRenderHist();
    box.style.display = show ? "" : "none";
  });
  document.addEventListener("click", (e) => {           // 点击面板其他位置自动收起历史列表
    const box = $("aiHist");
    if (box.style.display !== "none" && !e.target.closest("#aiHist") && !e.target.closest("#aiConvBtn")) {
      box.style.display = "none";
    }
  });
  $("aiCtxBtn").addEventListener("click", () => {
    AI.ctx = !AI.ctx;
    $("aiCtxBtn").classList.toggle("on", AI.ctx);
    $("aiCtxFlag").style.display = AI.ctx ? "" : "none";
  });
  $("aiStop").addEventListener("click", () => {
    aiHaltRun();                       // 断流 + 通知服务端停止后台运行
    aiTodoFloatSetPaused(true);        // 立即暂停任务清单（停止转圈），不等流收尾
  });

  /* ---------- AI 操作权限：仅可查看 / 工作区内修改 / 完全权限 ---------- */
  const AI_PERMS = [
    { id: "readonly", label: "仅可查看", icon: "bi-eye",
      desc: "只做解释与答疑，不写入任何文件" },
    { id: "workspace", label: "工作区内修改", icon: "bi-pencil-square",
      desc: "可读写项目内文件；普通命令直接执行，删除/高风险命令需确认" },
    { id: "full", label: "完全权限", icon: "bi-exclamation-triangle",
      desc: "可写入任意路径（含项目外部），请谨慎使用" },
  ];
  function aiPermDef() { return AI_PERMS.find(p => p.id === AI.perm) || AI_PERMS[1]; }
  function aiSetPerm(id) {
    if (!AI_PERMS.some(p => p.id === id)) return;
    AI.perm = id;
    try { localStorage.setItem("ide.ai.perm", id); } catch (_) {}
    aiRenderPerm();
    toast("AI 权限已切换为「" + aiPermDef().label + "」", "ok");
  }
  function aiRenderPerm() {
    const panel = $("aiPanel");
    if (panel) panel.dataset.perm = AI.perm;            // 只读时把「插入到项目」置灰
    const btn = $("aiPermBtn"), nm = $("aiPermName");
    if (!btn || !nm) return;
    const p = aiPermDef();
    nm.textContent = p.label;
    btn.querySelector("i.bi").className = "bi " + p.icon;
    btn.classList.toggle("ro", p.id === "readonly");
    btn.classList.toggle("full", p.id === "full");
    btn.title = "AI 操作权限：" + p.label + " —— " + p.desc;
  }
  function aiShowPermMenu() {
    const pop = $("aiPermPop");
    if (!pop) return;
    pop.innerHTML = "";
    AI_PERMS.forEach(p => {
      const el = document.createElement("div");
      el.className = "ai-perm-opt" + (p.id === AI.perm ? " on" : "");
      el.innerHTML = '<i class="bi ' + p.icon + '"></i><span><div class="t">' + p.label +
        '</div><div class="d">' + p.desc + '</div></span><i class="bi bi-check2"></i>';
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        pop.style.display = "none";
        aiSetPerm(p.id);
      });
      pop.appendChild(el);
    });
    pop.style.display = "";
  }
  $("aiPermBtn").addEventListener("click", (e) => {
    e.stopPropagation();
    const pop = $("aiPermPop");
    if (!pop) return;
    if (pop.style.display !== "none") { pop.style.display = "none"; return; }
    aiShowPermMenu();
  });
  document.addEventListener("click", (e) => {           // 点面板其他位置收起
    const pop = $("aiPermPop");
    if (pop && pop.style.display !== "none" && !e.target.closest(".ai-perm-wrap")) pop.style.display = "none";
  });

  /* ---------- 智能体（Agent）：AI 自动读文件 / 改文件 / 执行命令 ---------- */
  const AI_TOOL_LABEL = {
    read_file: "读取文件", write_file: "写入文件", edit_file: "修改文件",
    list_dir: "列出目录", search_files: "搜索代码", run_command: "执行命令",
    todo_write: "更新任务清单", web_search: "联网搜索", generate_image: "生成图片",
    code_intel: "代码分析", delegate_task: "子 Agent",
  };
  const AI_TOOL_ICON = {
    read_file: "bi-file-earmark-text", write_file: "bi-file-earmark-plus", edit_file: "bi-pencil-square",
    list_dir: "bi-folder2-open", search_files: "bi-search", run_command: "bi-terminal",
    todo_write: "bi-list-check", web_search: "bi-globe2", generate_image: "bi-image",
    code_intel: "bi-braces", delegate_task: "bi-diagram-3",
  };
  function aiRenderAgentToggle() {
    const btn = $("aiAgentBtn");
    if (!btn) return;
    btn.classList.toggle("on", !!AI.agent);
    btn.title = AI.agent
      ? "智能体模式已开启：AI 会自动读文件、改文件、执行命令（当前权限：" + aiPermDef().label + "）"
      : "智能体模式已关闭：点击开启后，AI 可以自动读写文件、执行命令";
  }
  $("aiAgentBtn").addEventListener("click", () => {
    AI.agent = !AI.agent;
    try { localStorage.setItem("ide.ai.agent", AI.agent ? "1" : "0"); } catch (_) {}
    aiRenderAgentToggle();
    toast(AI.agent ? "已开启智能体模式（权限：" + aiPermDef().label + "）" : "已关闭智能体模式", "ok");
  });
  function aiRenderWebToggle() {
    const btn = $("aiWebBtn");
    if (!btn) return;
    btn.classList.toggle("on", !!AI.webSearch);
    btn.title = AI.webSearch
      ? "联网模式已开启：AI 会自动搜索网络实时信息"
      : "联网模式已关闭：点击开启后，AI 会在回答前自动搜索网络实时信息";
  }
  $("aiWebBtn").addEventListener("click", () => {
    AI.webSearch = !AI.webSearch;
    try { localStorage.setItem("ide.ai.webSearch", AI.webSearch ? "1" : "0"); } catch (_) {}
    aiRenderWebToggle();
    toast(AI.webSearch ? "已开启联网模式" : "已关闭联网模式", "ok");
  });
  aiRenderWebToggle();

  /* 增强提示词：把输入框里的粗略需求交给 AI 改写成清晰、完整、结构化的提示词，再填回输入框 */
  async function aiEnhancePrompt() {
    const box = $("aiText");
    const raw = (box ? box.textContent : "").trim();
    if (!raw) { toast("先输入你的需求，再点「增强提示词」", "warn"); if (box) box.focus(); return; }
    if (AI.busy) { toast("AI 正在回复中，请稍候", "warn"); return; }
    const pick = aiCurrentPick();
    if (!pick || !pick.prov) { toast("请先在设置里配置 AI 接口", "warn"); return; }
    const btn = $("aiEnhanceBtn");
    const html0 = btn ? btn.innerHTML : "";
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="bi bi-hourglass-split"></i>'; }
    try {
      const r = await fetch("/api/ai/chat", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider_id: pick.prov.id,
          model: pick.model,
          perm: "readonly",
          messages: [
            { role: "system", content: "你是提示词优化助手。把用户给出的粗略需求改写为一条清晰、具体、结构化的提示词：点明目标、关键约束、期望输出与验收标准；保留用户原意，不添加无关内容，也不要去执行任务。只输出改写后的提示词本身。" },
            { role: "user", content: raw },
          ],
        }),
      });
      if (!r.ok) { let m = "HTTP " + r.status; try { m = (await r.json()).error || m; } catch (_) {} throw new Error(m); }
      const reader = r.body.getReader(), dec = new TextDecoder();
      let buf = "", acc = "";
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const evt = buf.slice(0, idx); buf = buf.slice(idx + 2);
          for (const line of evt.split("\n")) {
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (data === "[DONE]") continue;
            let obj; try { obj = JSON.parse(data); } catch (_) { continue; }
            if (obj.error) throw new Error(obj.error);
            if (obj.delta) acc += obj.delta;
          }
        }
      }
      const out = acc.replace(/^\s+/, "").trim();
      if (!out) throw new Error("未返回内容");
      box.textContent = out;
      box.focus();
      try {                                          // 光标移到末尾，方便继续编辑
        const rng = document.createRange(); rng.selectNodeContents(box); rng.collapse(false);
        const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(rng);
      } catch (_) {}
      toast("已增强提示词", "ok");
    } catch (e) {
      toast("增强提示词失败：" + (e.message || e), "err");
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = html0; }
    }
  }
  $("aiEnhanceBtn") && $("aiEnhanceBtn").addEventListener("click", aiEnhancePrompt);

  /* ================================================================
   * 添加上下文（@ 按钮）：编辑区打开的文件 / 选择文件或文件夹 / 终端输出
   * 候选项点击即附加到 AI.files（输入框上方的文件小卡片），发送时由 aiBuildContext() 拼进请求。
   * ================================================================ */
  let _aiCtxView = "main";          // main 主视图 / browse 目录浏览
  let _aiCtxDir = "";
  function aiCtxRow(icon, name, sub, onClick) {
    const row = document.createElement("div");
    row.className = "ai-ctx-row";
    row.innerHTML = '<i class="bi ' + icon + '"></i><span class="m"><span class="t"></span>' +
      (sub ? '<span class="d"></span>' : "") + '</span>';
    row.querySelector(".t").textContent = name;
    if (sub) row.querySelector(".d").textContent = sub;
    row.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
    return row;
  }
  function aiCtxSection(title) {
    const h = document.createElement("div");
    h.className = "ai-ctx-g";
    h.textContent = title;
    return h;
  }
  function aiCloseCtxPop() {
    const p = $("aiCtxPop");
    if (p) { p.style.display = "none"; p.innerHTML = ""; }
  }
  // 附加一项（复用 aiAttachOne 的读取/去重/上限逻辑），成功返回 true
  async function aiAttachPath(path, name, isDir) {
    const r = await aiAttachOne(path, name, isDir);
    if (!r.ok) {
      if (r.reason === "dup") toast(name + " 已经在对话里了", "info");
      else if (r.reason === "limit") toast("最多同时附加 " + AI_FILE_LIMIT + " 个文件 / 文件夹", "warn");
      else if (r.reason === "unsupported") toast("该文件类型不支持作为文本附加：" + name, "warn");
      else toast(r.msg || "添加失败", "err");
      return false;
    }
    aiRenderFiles();
    aiInsertFileTag({ path: path, name: name, isDir: !!isDir });   // 芯片直接排进输入框
    return true;
  }
  // 当前终端的输出文本（作为上下文附加）
  function aiTerminalText() {
    try {
      if (typeof curTerm !== "undefined" && curTerm && curTerm.body) {
        return (curTerm.body.textContent || "").trim();
      }
    } catch (_) {}
    return "";
  }
  // 主视图：编辑区打开的文件 → 选择文件/文件夹 → 终端输出 → 已附加
  function aiBuildCtxPop() {
    const p = $("aiCtxPop");
    if (!p) return;
    if (_aiCtxView === "browse") { aiCtxRenderBrowse(); return; }
    p.innerHTML = '<div class="ai-ctx-head">添加文件、知识库和其他材料作为上下文</div><div class="ai-ctx-body"></div>';
    const body = p.querySelector(".ai-ctx-body");

    // 1) 编辑区打开的文件（放最上面）
    const openTabs = (typeof tabs !== "undefined" ? tabs : []).filter(t => t && !t.diff && t.path);
    if (openTabs.length) {
      body.appendChild(aiCtxSection("编辑区打开的文件"));
      openTabs.slice(0, 10).forEach(t => {
        body.appendChild(aiCtxRow("bi-file-earmark-text", t.name, t.path, async () => {
          if (await aiAttachPath(t.path, t.name, false)) { aiBuildCtxPop(); toast("已添加：" + t.name, "ok"); }
        }));
      });
    }

    // 2) 选择文件或文件夹
    body.appendChild(aiCtxSection("选择"));
    body.appendChild(aiCtxRow("bi-folder2-open", "File & Folders", "选择文件或文件夹作为上下文", () => {
      aiCtxOpenBrowse(ROOT || "/");
    }));

    // 3) 终端输出
    const termTxt = aiTerminalText();
    body.appendChild(aiCtxRow("bi-terminal", "Terminal",
      termTxt ? "添加当前终端的输出内容" : "当前没有终端输出", () => {
        if (!termTxt) { toast("当前没有终端输出", "warn"); return; }
        if (!Array.isArray(AI.files)) AI.files = [];
        if (AI.files.some(f => f.path === "::terminal")) { toast("终端输出已在对话中", "info"); return; }
        if (AI.files.length >= AI_FILE_LIMIT) { toast("最多同时附加 " + AI_FILE_LIMIT + " 项", "warn"); return; }
        const text = termTxt.length > 8000 ? "…（前文已截断）\n" + termTxt.slice(-8000) : termTxt;
        // 虚拟路径用 "::terminal"：不能带 \u0000 —— DOM 属性里的 NUL 会被解析成 U+FFFD，芯片和缓存就对不上了
        AI.files.push({ path: "::terminal", kind: "term", name: "终端输出", text: text, isDir: false });
        aiRenderFiles(); aiBuildCtxPop();
        aiInsertFileTag({ path: "::terminal", name: "终端输出", isDir: false });   // 同样作为芯片排进输入框
        toast("已添加上下文：终端输出", "ok");
      }));

    // 4) 已附加（可移除）
    const files = AI.files || [];
    body.appendChild(aiCtxSection("已附加 " + files.length + "/" + AI_FILE_LIMIT));
    if (!files.length) {
      const e = document.createElement("div");
      e.className = "ai-ctx-empty";
      e.textContent = "还没有附加任何内容";
      body.appendChild(e);
    } else {
      files.forEach((f, i) => {
        const row = aiCtxRow(f.isDir ? "bi-folder2" : "bi-file-earmark-text", f.name, f.path, () => {});
        const rm = document.createElement("button");
        rm.className = "rm"; rm.title = "移除"; rm.innerHTML = '<i class="bi bi-x-lg"></i>';
        rm.addEventListener("click", (e) => {
          e.stopPropagation();
          AI.files.splice(i, 1); aiRenderFiles(); aiBuildCtxPop();
        });
        row.appendChild(rm);
        body.appendChild(row);
      });
    }
  }
  // 进入「选择文件或文件夹」浏览视图
  function aiCtxOpenBrowse(dir) {
    _aiCtxView = "browse";
    _aiCtxDir = dir || "/";
    aiCtxRenderBrowse();
  }
  async function aiCtxRenderBrowse() {
    const p = $("aiCtxPop");
    if (!p) return;
    const dir = _aiCtxDir || "/";
    p.innerHTML = '<div class="ai-ctx-head">选择文件或文件夹作为上下文（点文件即添加）</div>';
    const bar = document.createElement("div");
    bar.className = "ai-ctx-browsebar";
    const up = document.createElement("button");
    up.className = "ai-ctx-upbtn"; up.title = "上一级"; up.innerHTML = '<i class="bi bi-arrow-up"></i>';
    up.addEventListener("click", () => {
      const clean = dir.replace(/\/+$/, "");
      const par = clean.split("/").slice(0, -1).join("/") || "/";
      if (par !== clean) aiCtxOpenBrowse(par);
    });
    const pathEl = document.createElement("span");
    pathEl.className = "ai-ctx-path"; pathEl.textContent = dir; pathEl.title = dir;
    const addDir = document.createElement("button");
    addDir.className = "ai-ctx-adddir"; addDir.textContent = "添加此文件夹";
    addDir.addEventListener("click", async () => {
      const nm = dir.replace(/\/+$/, "").split("/").pop() || dir;
      if (await aiAttachPath(dir, nm, true)) { toast("已添加目录结构：" + nm, "ok"); aiCtxRenderBrowse(); }
    });
    const back = document.createElement("button");
    back.className = "ai-ctx-backbtn"; back.textContent = "返回";
    back.addEventListener("click", () => { _aiCtxView = "main"; aiBuildCtxPop(); });
    bar.appendChild(up); bar.appendChild(pathEl); bar.appendChild(addDir); bar.appendChild(back);
    p.appendChild(bar);

    const list = document.createElement("div");
    list.className = "ai-ctx-list";
    list.innerHTML = '<div class="ai-ctx-empty">加载中…</div>';
    p.appendChild(list);
    try {
      const d = await (await fetch("/api/files?path=" + encodeURIComponent(dir))).json();
      if (!list.isConnected) return;
      if (d.error) { list.innerHTML = '<div class="ai-ctx-empty">无法读取该目录</div>'; return; }
      const items = (d.items || [])
        .filter(it => it && !it.name.startsWith("."))
        .sort((a, b) => (b.is_dir - a.is_dir) || a.name.localeCompare(b.name, "zh"));
      list.innerHTML = "";
      if (!items.length) { list.innerHTML = '<div class="ai-ctx-empty">（空目录）</div>'; return; }
      items.slice(0, 300).forEach(it => {
        const full = dir.replace(/\/+$/, "") + "/" + it.name;
        list.appendChild(aiCtxRow(it.is_dir ? "bi-folder2" : "bi-file-earmark-text",
          it.name, it.is_dir ? "文件夹" : "", async () => {
            if (it.is_dir) { aiCtxOpenBrowse(full); return; }
            if (await aiAttachPath(full, it.name, false)) {
              _aiCtxView = "main"; aiBuildCtxPop(); toast("已添加：" + it.name, "ok");
            }
          }));
      });
    } catch (_) {
      if (list.isConnected) list.innerHTML = '<div class="ai-ctx-empty">加载失败</div>';
    }
  }
  function aiOpenCtxPop() {
    const p = $("aiCtxPop");
    if (!p) return;
    if (p.style.display === "block") { aiCloseCtxPop(); return; }
    _aiCtxView = "main";                             // 每次打开都回到主视图
    aiBuildCtxPop();
    p.style.display = "block";
  }
  $("aiCtxAddBtn") && $("aiCtxAddBtn").addEventListener("click", (e) => { e.stopPropagation(); aiOpenCtxPop(); });
  document.addEventListener("click", (e) => {
    const p = $("aiCtxPop");
    if (!p || p.style.display !== "block") return;
    if (e.target.closest && (e.target.closest("#aiCtxPop") || e.target.closest("#aiCtxAddBtn"))) return;
    aiCloseCtxPop();
  });

  /* ================================================================
   * 历史提问：列出当前会话里问过的问题（去重，最新在上）
   * 点击某条 → 滚动到对话中对应的消息并高亮
   * ================================================================ */
  let _aiHistHlTimer = null;
  function aiHistQuestions() {
    const out = [], seen = new Set();
    const msgs = AI.msgs || [];
    for (let i = msgs.length - 1; i >= 0; i--) {   // 倒序：最新的在最上面，重复问题保留最近一次的下标
      const m = msgs[i];
      if (!m || m.role !== "user") continue;
      const t = (m.text || m.content || "").trim();
      if (!t || seen.has(t)) continue;
      seen.add(t);
      out.push({ text: t, mi: i });
    }
    return out;
  }
  // 滚动到第 mi 条消息并短暂高亮（找不到时提示）
  function aiScrollToMsg(mi) {
    const box = $("aiMsgs");
    if (!box) return;
    const row = box.querySelector('.ai-row[data-mi="' + mi + '"]');
    if (!row) { toast("这条消息已不在当前对话里", "warn"); return; }
    try { row.scrollIntoView({ block: "center", behavior: "smooth" }); }
    catch (_) { try { row.scrollIntoView(); } catch (e) { /* ignore */ } }
    box.querySelectorAll(".ai-row.ai-hl").forEach(el => el.classList.remove("ai-hl"));
    row.classList.add("ai-hl");
    clearTimeout(_aiHistHlTimer);
    _aiHistHlTimer = setTimeout(() => row.classList.remove("ai-hl"), 2600);
  }
  function aiCloseHistQPop() {
    const p = $("aiHistQPop");
    if (p) { p.style.display = "none"; p.innerHTML = ""; }
  }
  function aiBuildHistQPop() {
    const p = $("aiHistQPop");
    if (!p) return;
    const list = aiHistQuestions();
    p.innerHTML =
      '<div class="ai-histq-head"><i class="bi bi-list-ul"></i><span>历史提问</span>' +
      '<span class="cnt">(' + list.length + ')</span>' +
      '<button class="x" title="关闭"><i class="bi bi-x-lg"></i></button></div>' +
      '<div class="ai-histq-body"></div>';
    p.querySelector(".x").addEventListener("click", (e) => { e.stopPropagation(); aiCloseHistQPop(); });
    const body = p.querySelector(".ai-histq-body");
    if (!list.length) {
      const e = document.createElement("div");
      e.className = "ai-ctx-empty";
      e.textContent = "还没有历史提问";
      body.appendChild(e);
      return;
    }
    list.forEach(item => {
      const row = document.createElement("div");
      row.className = "ai-histq-row";
      row.textContent = item.text;
      row.title = item.text;
      row.addEventListener("click", () => { aiCloseHistQPop(); aiScrollToMsg(item.mi); });
      body.appendChild(row);
    });
  }
  function aiOpenHistQPop() {
    const p = $("aiHistQPop");
    if (!p) return;
    if (p.style.display === "block") { aiCloseHistQPop(); return; }
    aiBuildHistQPop();
    p.style.display = "block";
  }
  $("aiHistQBtn") && $("aiHistQBtn").addEventListener("click", (e) => { e.stopPropagation(); aiOpenHistQPop(); });
  document.addEventListener("click", (e) => {
    const p = $("aiHistQPop");
    if (!p || p.style.display !== "block") return;
    if (e.target.closest && (e.target.closest("#aiHistQPop") || e.target.closest("#aiHistQBtn"))) return;
    aiCloseHistQPop();
  });

  /* 工具调用步骤卡片 */
  function aiRetryHint(ev) {
    const reason = (ev && ev.reason) || "接口限流";
    const wait = ev && ev.wait != null ? ev.wait : 0;
    const n = (ev && ev.attempt) || 1;
    return '<span class="ai-waiting">' + esc(reason) + '，' + wait + ' 秒后自动重试（第 ' + n +
      ' 次）<span class="d"></span><span class="d"></span><span class="d"></span></span>';
  }
  function aiStepRow(ev) {
    const row = document.createElement("div");
    row.className = "ai-step";
    const args = ev.args || {};
    row.innerHTML = '<span class="st-ic"><i class="bi ' + (AI_TOOL_ICON[ev.tool] || "bi-gear") + '"></i></span>' +
      '<span class="st-name"></span><span class="st-arg"></span>' +
      '<span class="st-res"><span class="d">执行中…</span></span>';
    row.querySelector(".st-name").textContent = AI_TOOL_LABEL[ev.tool] || ev.tool;
    const argEl = row.querySelector(".st-arg");
    argEl.textContent = args.path || args.command || args.pattern || "";
    argEl.title = JSON.stringify(args, null, 1);
    row.addEventListener("click", () => {
      const d = row.querySelector(".st-detail");
      if (d) d.classList.toggle("open");
    });
    return row;
  }
  function aiStepDone(row, ev) {
    if (!row) return;
    const d = row.querySelector(".st-res .d");
    if (!d) return;
    d.className = ev.ok ? "ok" : (ev.denied ? "deny" : "bad");
    d.textContent = ev.ok ? "完成 " + (ev.ms || 0) + "ms" : (ev.denied ? "已拦截" : "失败");
    row.title = (ev.summary || "") + (ev.detail ? "\n（点击查看详情）" : "");
    let pre = row.querySelector(".st-detail");
    if (!pre) { pre = document.createElement("pre"); pre.className = "st-detail"; row.appendChild(pre); }
    pre.textContent = [ev.summary ? "结果：" + ev.summary : "", ev.detail || ""].filter(Boolean).join("\n\n");
  }
  /* 子 Agent 进度：把 subagent 事件实时渲染到父级 delegate_task 步骤行内 */
  function aiSubStepEvent(row, ev) {
    if (!row) return;
    let box = row.querySelector(".ai-substeps");
    if (!box) {
      box = document.createElement("div");
      box.className = "ai-substeps";
      box._sidMap = {};
      row.appendChild(box);
    }
    const e2 = ev || {};
    if (e2.kind === "start") {
      const h = document.createElement("div");
      h.className = "ai-sub-hd";
      h.textContent = (e2.task || "").slice(0, 160);
      box.appendChild(h);
    } else if (e2.kind === "step") {
      const r = document.createElement("div");
      r.className = "ai-sub-step";
      const a = e2.args || {};
      const arg = a.path || a.command || a.pattern || a.query || a.prompt || "";
      r.innerHTML = '<i class="bi ' + (AI_TOOL_ICON[e2.tool] || "bi-gear") + '"></i>' +
        '<span class="s-name"></span><span class="s-arg"></span><span class="s-res">执行中…</span>';
      r.querySelector(".s-name").textContent = AI_TOOL_LABEL[e2.tool] || e2.tool;
      r.querySelector(".s-arg").textContent = (arg || "").toString().slice(0, 120);
      r.querySelector(".s-arg").title = JSON.stringify(a, null, 1);
      box.appendChild(r);
      box._sidMap[e2.sid] = r;
    } else if (e2.kind === "result") {
      const r = box._sidMap[e2.sid];
      if (r) {
        const d = r.querySelector(".s-res");
        d.className = "s-res " + (e2.ok ? "ok" : "bad");
        d.textContent = e2.ok ? "完成" : "失败";
        r.title = e2.summary || "";
      }
    } else if (e2.kind === "final") {
      const f = document.createElement("div");
      f.className = "ai-sub-final";
      f.textContent = "结论：" + (e2.text || "").slice(0, 600);
      box.appendChild(f);
    } else if (e2.kind === "error") {
      const f = document.createElement("div");
      f.className = "ai-sub-final bad";
      f.textContent = "错误：" + (e2.msg || "");
      box.appendChild(f);
    }
  }

  /* 工具步骤汇总文案：列出目录 ×2 · 读取文件 ×3 · 1 项被拦截 */
  function aiStepsSummary(steps) {
    const cnt = {};
    let denied = 0;
    (steps || []).forEach(s => {
      const k = AI_TOOL_LABEL[s.tool] || s.tool;
      cnt[k] = (cnt[k] || 0) + 1;
      if (s.denied) denied++;
    });
    return Object.keys(cnt).map(k => k + " ×" + cnt[k]).join(" · ") + (denied ? " · " + denied + " 项被拦截" : "");
  }
  /* 把一次智能体执行的所有工具步骤收进一个可折叠区域（默认折叠，只占一行） */
  function aiBuildStepsBox(steps) {
    const box = document.createElement("div");
    box.className = "ai-steps collapsed";
    box.innerHTML =
      '<div class="ai-steps-head"><i class="bi bi-chevron-right tw"></i>' +
      '<span class="ttl"></span><span class="sum"></span></div>' +
      '<div class="ai-steps-body"></div>';
    box._list = [];
    box._body = box.querySelector(".ai-steps-body");
    box._head = box.querySelector(".ai-steps-head");
    box._live = "";
    box._pending = 0;                 // 同时进行中的步骤数（同一轮多个工具会并行，可能 >1）
    box._paint = function () {
      const running = box._pending > 0;
      const ttl = box._head.querySelector(".ttl");
      ttl.innerHTML = running
        ? '<i class="bi bi-arrow-repeat spin"></i> 正在执行… <span style="color:#9aa4b2">' +
          esc(box._live) + (box._pending > 1 ? " 等 " + box._pending + " 项" : "") + "</span>"
        : "已执行 " + box._list.length + " 步";
      box._head.querySelector(".sum").textContent = aiStepsSummary(box._list);
    };
    box._setCollapsed = function (collapsed) {           // 统一控制展开/折叠，供点击与「执行完成后自动折叠」复用
      box.classList.toggle("collapsed", collapsed);
      box._head.querySelector(".tw").className =
        "bi " + (collapsed ? "bi-chevron-right" : "bi-chevron-down") + " tw";
    };
    box._head.onclick = () => {
      box._setCollapsed(!box.classList.contains("collapsed"));
    };
    (steps || []).forEach(s => {                       // 回放历史时一次性填充
      const row = aiStepRow(s);
      aiStepDone(row, s);
      box._body.appendChild(row);
      box._list.push(s);
    });
    box._paint();
    return box;
  }

  /* ---------- 任务清单（todo_write）：AI 把多步任务拆成清单并实时更新进度 ---------- */
  const AI_TODO_ICON = {
    completed: "bi-check-circle-fill",
    in_progress: "bi-arrow-repeat",
    pending: "bi-circle",
  };
  function aiTodoStats(todos) {
    const list = (todos || []).filter(t => t && t.content);
    const done = list.filter(t => t.status === "completed").length;
    return { done: done, total: list.length, all: list.length > 0 && done === list.length };
  }
  /* 构造可折叠的「任务列表」面板：头部显示 已完成/总数，正文逐项列出（含状态图标）。
     返回的元素带 .update(todos) 方法，流式过程中反复调用即可原地刷新。 */
  function aiTodoBox(todos) {
    const list = (todos || []).filter(t => t && t.content);
    if (!list.length) return null;
    const box = document.createElement("div");
    box.className = "ai-todo";
    box.innerHTML =
      '<div class="ai-todo-head"><i class="bi bi-chevron-down tw"></i>' +
      '<span class="ttl">任务列表</span><span class="cnt"></span></div>' +
      '<div class="ai-todo-body"><div class="ai-todo-state"></div><div class="ai-todo-list"></div></div>';
    box._head = box.querySelector(".ai-todo-head");
    box._listEl = box.querySelector(".ai-todo-list");
    box._stateEl = box.querySelector(".ai-todo-state");
    box._setCollapsed = function (collapsed) {
      box.classList.toggle("collapsed", collapsed);
      box._head.querySelector(".tw").className =
        "bi " + (collapsed ? "bi-chevron-right" : "bi-chevron-down") + " tw";
      if (typeof aiTodoFloatPad === "function") aiTodoFloatPad();   // 展开/收起后同步消息区底部留白
    };
    box._head.onclick = () => {
      const collapsed = !box.classList.contains("collapsed");
      box._setCollapsed(collapsed);
      try { localStorage.setItem("ide.aiTodoCollapsed", collapsed ? "1" : "0"); } catch (_) {}   // 记住展开/收起偏好
    };
    // 恢复上次收起状态：新建面板（含悬浮任务卡）时沿用偏好
    let _savedFold = false;
    try { _savedFold = localStorage.getItem("ide.aiTodoCollapsed") === "1"; } catch (_) {}
    if (_savedFold) box._setCollapsed(true);
    box._paused = false;
    box._items = list;
    box.update = function (next) {
      const items = (next || []).filter(t => t && t.content);
      box._items = items;
      box._listEl.innerHTML = "";
      items.forEach(t => {
        const st = t.status || "pending";
        const row = document.createElement("div");
        row.className = "ai-todo-row " + st;
        // 进行中：运行中转圈；会话停止/结束后换成暂停图标（静止）
        const ic = (st === "in_progress" && box._paused)
          ? "bi-pause-circle" : (AI_TODO_ICON[st] || AI_TODO_ICON.pending);
        row.innerHTML = '<i class="bi ' + ic + ' ic"></i><span class="tx"></span>';
        row.querySelector(".tx").textContent = t.content;
        row.title = t.content;
        box._listEl.appendChild(row);
      });
      const s = aiTodoStats(items);
      box._head.querySelector(".cnt").textContent = s.done + "/" + s.total;
      const cur = (items.find(t => t.status === "in_progress") || {}).content || "";
      if (s.all) {
        box._stateEl.textContent = "所有任务已完成";
        box._stateEl.className = "ai-todo-state done";
      } else if (box._paused) {
        box._stateEl.textContent = "已暂停 " + s.done + "/" + s.total + (cur ? "：" + cur : "");
        box._stateEl.className = "ai-todo-state paused";
      } else {
        box._stateEl.textContent = "进行中 " + s.done + "/" + s.total + (cur ? "：" + cur : "");
        box._stateEl.className = "ai-todo-state";
      }
    };
    /* 运行中 / 已暂停（会话停止、异常结束、回放历史都算暂停）：暂停时不再转圈 */
    box.setPaused = function (p) {
      p = !!p;
      if (box._paused === p) return;
      box._paused = p;
      box.classList.toggle("paused", p);
      box.update(box._items || []);
    };
    box.update(list);
    return box;
  }

  /* ---------- 消息区底部「任务列表 / 文件列表」并排折叠条（参考 Trae / CodeBuddy） ----------
     常驻在消息区底部的悬浮卡片，不随消息滚动、也不会被消息清空（aiRenderAll 只重建 #aiMsgs）：
       · 任务列表：当前（或最近一次）任务清单，随运行实时更新；
       · 文件列表：本次会话中 AI 改动过的文件汇总，点击直接打开对应文件。 */
  let _aiDockTodos = null;                 // 当前任务清单（含流式中途增量更新的那一份）
  function aiTodoFloatHost() { return $("aiTodoFloat"); }
  /* 悬浮面板压在消息区底部：给消息区补一段底部内边距，避免最新内容被面板挡住 */
  function aiTodoFloatPad() {
    const box = $("aiMsgs"), host = aiTodoFloatHost();
    if (!box || !host) return;
    if (host.style.display === "none" || !host.offsetHeight) { box.style.paddingBottom = ""; return; }
    box.style.paddingBottom = (host.offsetHeight + 12) + "px";
  }
  // 汇总本次会话所有回复里改动过的文件（同一路径取最新动作）
  function aiDockCollectFiles() {
    const map = new Map();
    (AI.msgs || []).forEach(m => {
      if (!m || m.role !== "assistant" || !m.changes) return;
      m.changes.forEach(c => {
        const p = (c && c.path) || "";
        if (!p) return;
        const act = (c && c.action) || "modified";
        const old = map.get(p);
        if (!old || old.action === "modified") map.set(p, { path: p, action: act });
      });
    });
    return [...map.values()];
  }
  // 文件列表卡片（可折叠，点条目直接打开文件）
  function aiDockFilesCard(files) {
    const card = document.createElement("div");
    card.className = "ai-todo ai-dock-card";
    let folded = false;
    try { folded = localStorage.getItem("ide.aiFilesCollapsed") === "1"; } catch (_) {}
    card.innerHTML =
      '<div class="ai-todo-head"><i class="bi ' + (folded ? "bi-chevron-right" : "bi-chevron-down") + ' tw"></i>' +
      '<span class="ttl">文件列表</span><span class="cnt"></span></div>' +
      '<div class="ai-todo-body"><div class="ai-dock-list"></div></div>';
    if (folded) card.classList.add("collapsed");
    card.querySelector(".cnt").textContent = files.length;
    const listEl = card.querySelector(".ai-dock-list");
    files.forEach(f => {
      const meta = AI_CHG_ICON[f.action] || AI_CHG_ICON.modified;
      const row = document.createElement("div");
      row.className = "ai-dock-row " + meta[1];
      row.title = f.path;
      row.innerHTML = '<i class="bi ' + meta[0] + '"></i><span class="nm"></span>';
      row.querySelector(".nm").textContent = f.path;
      row.addEventListener("click", () => { try { openFile(f.path, f.path.split("/").pop()); } catch (_) {} });
      listEl.appendChild(row);
    });
    card.querySelector(".ai-todo-head").addEventListener("click", () => {
      const c = !card.classList.contains("collapsed");
      card.classList.toggle("collapsed", c);
      card.querySelector(".tw").className = "bi " + (c ? "bi-chevron-right" : "bi-chevron-down") + " tw";
      try { localStorage.setItem("ide.aiFilesCollapsed", c ? "1" : "0"); } catch (_) {}
      aiTodoFloatPad();
    });
    return card;
  }
  // 重新渲染底部 dock：任务列表 / 文件列表 用 tab 切换展示（不再左右并排，避免一边收起后留空白）
  function aiDockTab() {
    let t = "todo";
    try { t = localStorage.getItem("ide.aiDockTab") || "todo"; } catch (_) {}
    return t === "files" ? "files" : "todo";
  }
  function aiDockRender() {
    const host = aiTodoFloatHost();
    if (!host) return;
    const todos = (_aiDockTodos || []).filter(t => t && t.content);
    const files = aiDockCollectFiles();
    if (!todos.length && !files.length) {
      host.innerHTML = ""; host._todoPanel = null;
      host.style.display = "none"; aiTodoFloatPad();
      return;
    }
    let tab = aiDockTab();
    if (tab === "todo" && !todos.length) tab = "files";      // 当前 tab 没内容时自动切到另一个
    if (tab === "files" && !files.length) tab = "todo";

    host.innerHTML = "";
    const cards = document.createElement("div");
    cards.className = "ai-dock-cards";
    const card = document.createElement("div");
    card.className = "ai-todo ai-dock-card ai-dock-tabs";
    let folded = false;
    try { folded = localStorage.getItem("ide.aiDockFold") === "1"; } catch (_) {}
    if (folded) card.classList.add("collapsed");

    const stats = todos.length ? aiTodoStats(todos) : { done: 0, total: 0 };
    const head = document.createElement("div");
    head.className = "ai-dock-tabhead";
    // 参考 CodeBuddy：一条内嵌圆角行，左「任务列表 4/4 ⌄」右「文件列表 (6) ⌄」，
    // 纯文字 + 计数 + 小箭头（无图标、无选中底色、没有单独的收起按钮）
    head.innerHTML =
      '<button type="button" class="ai-dock-tab' + (!folded && tab === "todo" ? " on" : "") +
        '" data-tab="todo"' + (todos.length ? "" : " disabled") + ">任务列表" +
        (todos.length ? '<span class="cnt">' + stats.done + "/" + stats.total + "</span>" : "") +
        '<i class="bi bi-chevron-down cv"></i></button>' +
      '<button type="button" class="ai-dock-tab' + (!folded && tab === "files" ? " on" : "") +
        '" data-tab="files"' + (files.length ? "" : " disabled") + ">文件列表" +
        '<span class="cnt">(' + files.length + ")</span>" +
        '<i class="bi bi-chevron-down cv"></i></button>';
    card.appendChild(head);

    const body = document.createElement("div");
    body.className = "ai-dock-tabbody";
    card.appendChild(body);

    head.addEventListener("click", (e) => {
      const b = e.target.closest(".ai-dock-tab");
      if (!b || b.disabled) return;
      const t = b.dataset.tab;
      const open = !card.classList.contains("collapsed");
      const next = !(open && t === tab);                      // 再点当前项 = 整块收起/展开
      try {
        localStorage.setItem("ide.aiDockTab", t);
        localStorage.setItem("ide.aiDockFold", next ? "0" : "1");
      } catch (_) {}
      aiDockRender();
    });

    if (tab === "todo") {                                     // 任务列表：复用 aiTodoBox（标题交给 tab，隐藏原头）
      const t = aiTodoBox(todos);
      t.classList.add("ai-dock-embedded");
      t._head.style.display = "none";
      t._setCollapsed(false);
      t.setPaused(!AI.busy);                                  // 没有正在运行的会话 → 暂停态（不转圈）
      host._todoPanel = t;
      body.appendChild(t);
    } else {                                                  // 文件列表
      host._todoPanel = null;
      const fc = aiDockFilesCard(files);
      fc.classList.add("ai-dock-embedded");
      const fh = fc.querySelector(".ai-todo-head");
      if (fh) fh.style.display = "none";
      fc.classList.remove("collapsed");
      body.appendChild(fc);
    }
    cards.appendChild(card);
    host.appendChild(cards);
    host.style.display = "";
    aiTodoFloatPad();
  }
  function aiTodoFloatShow(todos) {
    const list = (todos || []).filter(t => t && t.content);
    _aiDockTodos = list.length ? list : null;
    aiDockRender();
    if (typeof aiScrollToBottom === "function") aiScrollToBottom();
  }
  function aiTodoFloatHide() {
    _aiDockTodos = null;
    aiDockRender();
  }
  /* 会话停止 / 结束时调用：把「进行中」的项切到暂停态（停止转圈） */
  function aiTodoFloatSetPaused(p) {
    const host = aiTodoFloatHost();
    if (host && host._todoPanel && host._todoPanel.setPaused) host._todoPanel.setPaused(p);
  }
  /* 一轮「正常结束」时的清单收尾：模型偶尔会忘记把最后几项标成 completed，
     导致任务已经做完、界面却停在「已暂停 1/4」。这里把仍未完成的项补成已完成。
     （用户主动停止 / 出错时不调用，保持真实的中间状态） */
  function aiTodoFinalize(list) {
    const arr = (list || []).filter(t => t && t.content);
    if (!arr.length || !arr.some(t => t.status !== "completed")) return arr;
    return arr.map(t => (t.status === "completed" ? t : Object.assign({}, t, { status: "completed" })));
  }
  /* 加载 / 切换会话、或一轮结束后：取最后一条带清单的回复回放任务，并刷新文件列表 */
  function aiTodoFloatSyncFromMsgs() {
    let todos = null;
    for (let i = (AI.msgs || []).length - 1; i >= 0; i--) {
      const m = AI.msgs[i];
      if (m && m.role === "assistant" && m.todos && m.todos.length) { todos = m.todos; break; }
    }
    _aiDockTodos = todos;
    aiDockRender();
  }
  window.addEventListener("resize", () => { try { aiTodoFloatPad(); } catch (_) {} });
  (function initTodoFloatObserver() {                  // 面板高度变化（展开/收起、换行）时同步底部留白
    const host = $("aiTodoFloat");
    if (!host || typeof ResizeObserver === "undefined") return;
    try { new ResizeObserver(() => { try { aiTodoFloatPad(); } catch (_) {} }).observe(host); } catch (_) {}
  })();

  /* 需要用户确认的调用（例如执行命令） */
  /* 命令确认卡片：用户已操作后延迟自动淡出并移除，避免确认面板在消息里堆积 */
  function aiAskCardAutoRemove(row) {
    setTimeout(() => {
      try {
        row.style.transition = "opacity .35s ease, transform .35s ease";
        row.style.opacity = "0";
        row.style.transform = "translateY(-6px)";
      } catch (_) {}
      setTimeout(() => { try { row.remove(); } catch (_) {} }, 380);
    }, 1000);
  }
  function aiAskCard(ev, runId) {
    const row = document.createElement("div");
    row.className = "ai-ask";
    row.innerHTML = '<div class="q"><i class="bi bi-terminal"></i> <code></code></div>' +
      '<div class="r"></div><div class="btns">' +
      '<button class="ok">允许执行</button>' +
      '<button class="all">本次会话都允许</button>' +
      '<button class="glo" title="加入全局放行名单：以后任何项目遇到同一条命令都直接执行，不再弹确认">全局允许</button>' +
      '<button class="no">拒绝</button>' +
      '<button class="set" title="打开设置 → 命令安全"><i class="bi bi-gear"></i></button>' +
      '</div>';
    const args = ev.args || {};
    row.querySelector("code").textContent = args.command || args.path || JSON.stringify(args);
    row.querySelector(".r").textContent = ev.reason || "需要你确认后才会执行";
    const isCmd = ev.tool === "run_command" && !!args.command;
    // 「全局允许」只对执行命令有意义：写文件等其余确认项隐藏该按钮
    if (!isCmd) row.querySelector(".glo").style.display = "none";
    const decide = (allow, always, glo) => {
      if (row._decided) return;                         // 防重复点击
      row._decided = true;
      fetch("/api/ai/agent/approve", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ run_id: runId, call_id: ev.call_id, allow: allow,
                               always: always, global: !!glo }),
      }).then(r => r.json()).then(d => {
        if (d && d.warn) toast("已允许执行，但加入全局放行名单失败：" + d.warn, "warn");
        else if (d && d.global_added) toast("已全局允许：以后任何项目都将直接执行", "ok");
      }).catch(() => {});
      row.classList.add(allow ? "allowed" : "denied");
      const btns = row.querySelector(".btns");
      if (btns) btns.remove();
      row.querySelector(".r").textContent = allow
        ? (glo ? "已全局允许：以后任何项目都将直接执行" : "已允许执行")
        : "已拒绝执行";
      aiAskCardAutoRemove(row);                         // 用户已操作：1 秒后自动移除该面板
    };
    row.querySelector(".ok").onclick = () => decide(true, false, false);
    row.querySelector(".all").onclick = () => decide(true, true, false);
    row.querySelector(".glo").onclick = () => decide(true, false, true);
    row.querySelector(".no").onclick = () => decide(false, false, false);
    // 齿轮：跳到「设置 → 命令安全」，先看策略再决定是否放行（不代答本次确认）
    row.querySelector(".set").onclick = () => {
      if (typeof openSettingsTab === "function") openSettingsTab("sec-cmdguard");
      else toast("无法打开设置页", "warn");
    };
    return row;
  }

  /* 运行智能体：解析 SSE（步骤 / 确认 / 流式回答），返回 { text, steps }
     过程记录统一收进「AI 消息下方」的一个折叠区域，默认只占一行。 */
  async function aiRunAgent(payload, bodyB, onDelta, opts) {
    opts = opts || {};
    const msgsBox = $("aiMsgs");
    const bodyRow = bodyB.parentElement;
    const stepMeta = new Map();          // call_id -> {tool, args}
    const rows = new Map();              // call_id -> 步骤行
    const steps = [];
    const changes = [];                  // 本次 AI 回复产生的文件改动 id（供回撤）
    const todos = [];                    // 本次运行的任务清单（todo_write 实时更新）
    AI._agentTurnChanges = changes;      // 中断时也能拿到已产生的改动，供回撤按钮使用
    AI._agentTurnSteps = steps;          // 中断（手动停止）时也能拿到已完成的步骤，刷新后仍能展开查看
    AI._agentTurnTodos = todos;          // 中断时也能拿到当前任务清单
    let realIn = 0, realOut = 0;         // 本轮真实 token 用量（后端每轮透传 usage，累加得到总消耗）
    let ctxLast = 0;                     // 最后一轮请求的输入规模（= 当前上下文占用，不是累计）
    let stepsBox = null;
    const ensureStepsBox = () => {
      if (!stepsBox) {
        stepsBox = aiBuildStepsBox([]);
        bodyRow.appendChild(stepsBox);               // 追加在 AI 气泡/元信息之后（即消息下面）
        AI._agentStepsBox = stepsBox;                // 中断时收尾用：停掉转圈并折叠成一行
      }
      return stepsBox;
    };
    // 后台运行：请求只负责「启动 + 返回 run_id」，执行放服务端后台线程。
    // · 新任务：启动后用 SSE 接收（边推边渲染，延迟最低）
    // · 刷新续接：改用「轮询事件接口」把已产生的进度取回来再增量续取 —— 比长期挂一条 SSE 稳，
    //   不会被浏览器/代理卡住而永远停在「思考中」或空白。
    let runId = opts.runId || "", text = "";

    /* 统一事件处理：SSE 与轮询两种来源共用同一套渲染逻辑 */
    const handleEvent = (e) => {
      if (!e || typeof e !== "object") return;
      if (e.type === "run") { runId = e.run_id; AI._agentRunId = runId; }
      else if (e.type === "retry") {
        text = "";                                        // 限流重试：清空本轮已显示内容
        if (onDelta) onDelta("");
        if (bodyB) bodyB.innerHTML = aiRetryHint(e);
      } else if (e.type === "delta") {
        text += e.text;
        if (onDelta) onDelta(text);
      } else if (e.type === "step") {
        stepMeta.set(e.call_id, { tool: e.tool, args: e.args });
        const box = ensureStepsBox();
        const row = aiStepRow(e);
        box._body.appendChild(row);
        rows.set(e.call_id, row);
        const a = e.args || {};
        box._live = (AI_TOOL_LABEL[e.tool] || e.tool) +
          (a.path || a.command || a.pattern ? " " + (a.path || a.command || a.pattern) : "");
        box._pending++;
        box._paint();
      } else if (e.type === "ask") {
        // 需要用户确认：卡片必须「单独弹出来」且始终可见。
        // 若塞进 .ai-steps-body，而该区域默认折叠（.ai-steps.collapsed 隐藏 body），
        // 用户根本看不到，AI 只能干等到确认超时。所以直接挂在消息下方，
        // 滚动到可见处，并做弹入 + 脉冲高亮提醒。
        ensureStepsBox();
        const askCard = aiAskCard(e, runId);
        bodyRow.appendChild(askCard);
        try {                                   // 还没输出正文：气泡里明说是「等你确认」，别只显示思考中
          if (bodyB && !String(acc || "").trim()) {
            bodyB.innerHTML = '<span class="ai-waiting">等待你确认后继续' +
              '<span class="d"></span><span class="d"></span><span class="d"></span></span>';
          }
        } catch (_) {}
        try {
          askCard.scrollIntoView({ block: "nearest", behavior: "smooth" });
        } catch (_) { try { askCard.scrollIntoView(); } catch (_) {} }
        askCard.classList.add("attn");
        try { toast("AI 正在等待你确认一个操作", "warn"); } catch (_) {}
      } else if (e.type === "result") {
        const meta = stepMeta.get(e.call_id) || { tool: e.tool, args: {} };
        aiStepDone(rows.get(e.call_id), e);
        if (e.changes && e.changes.length) changes.push(...e.changes);
        aiCloseTabsForChanges(e.changes);   // AI 删除了文件：对应编辑标签自动关闭
        const rec = { tool: meta.tool, args: meta.args, ok: !!e.ok, denied: !!e.denied,
                      ms: e.ms, summary: e.summary || "", detail: e.detail || "" };
        steps.push(rec);
        if (stepsBox) {
          stepsBox._list.push(rec);
          stepsBox._pending = Math.max(0, stepsBox._pending - 1);
          stepsBox._paint();
        }
      } else if (e.type === "todos") {
        // 任务清单更新（todo_write）：刷新底部悬浮面板（不随消息滚动）
        const list = (e.todos || []).filter(t => t && t.content);
        if (list.length) {
          todos.length = 0;
          todos.push(...list);
          aiTodoFloatShow(todos);
        }
      } else if (e.type === "subagent") {
        // 子 Agent 实时进度：渲染到对应的 delegate_task 步骤行内
        aiSubStepEvent(rows.get(e.call_id), e.event);
      } else if (e.type === "usage") {
        // 每轮真实用量（后端透传 usage）：realIn/realOut 累加＝本轮总消耗；
        // ctxLast 取最后一轮＝当前上下文占用（圆环显示用）
        const u = e.usage || {};
        realIn += +u.prompt_tokens || 0;
        realOut += +u.completion_tokens || 0;
        ctxLast = +u.context_tokens || (+u.prompt_tokens || ctxLast);
      } else if (e.type === "stopped") {
        // 服务端已停止这场运行（例如在另一个标签页点了停止）：按「已停止」收尾
        const err = new Error("已停止");
        err.name = "AbortError";
        throw err;
      } else if (e.type === "error") {
        throw new Error(e.error);
      }
    };

    if (!runId) {
      const r = await fetch("/api/ai/agent", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload), signal: AI.ctrl.signal,
      });
      if (!r.ok) {
        let msg = "HTTP " + r.status;
        try { msg = (await r.json()).error || msg; } catch (_) {}
        throw new Error(msg);
      }
      const jd = await r.json().catch(() => ({}));
      runId = jd.run_id || "";
      if (!runId) throw new Error(jd.error || "启动任务失败：未返回 run_id");
      AI._agentRunId = runId;
      if (opts.onRunId) { try { opts.onRunId(runId); } catch (_) {} }
    } else {
      AI._agentRunId = runId;                        // 刷新后重连：沿用原 run_id
    }

    if (opts.runId) {
      // —— 刷新续接：轮询事件接口（offset 递增），跑完即停 ——
      let offset = 0, fails = 0;
      const guard = Date.now() + 60 * 60 * 1000;
      while (true) {
        let d = null;
        try {
          const rr = await fetch("/api/ai/agent/events?run_id=" + encodeURIComponent(runId) +
                                 "&offset=" + offset, { signal: AI.ctrl.signal });
          d = await rr.json();
        } catch (err) {
          if (err && err.name === "AbortError") throw err;    // 用户点了停止 / 页面卸载（上层区分）
          d = null;
        }
        if (d === null) {                                     // 网络抖动：重试，别把这一轮当结束
          if (++fails >= 10) {
            const err = new Error("与后台任务的连接中断");      // 交给上层按「中断」处理：保留续连标记
            err.name = "TypeError";
            throw err;
          }
          await new Promise(res => setTimeout(res, 1200));
          continue;
        }
        fails = 0;
        if (!d.exists) break;                                 // 运行已不在：交给上层按会话历史兜底
        const got = (d.events || []).length;
        for (const e of (d.events || [])) handleEvent(e);
        offset = (typeof d.next === "number") ? d.next : (offset + got);
        if (d.done) break;
        if (Date.now() > guard) {
          const err = new Error("等待后台任务超时");           // 同上：保留续连标记，刷新还能接上
          err.name = "TypeError";
          throw err;
        }
        aiScrollToBottom(true);
        // 有事件就快轮询（跟得紧），空转（例如正等你确认工具调用）就慢一点，少点请求
        await new Promise(res => setTimeout(res, got ? 500 : 1500));
      }
    } else {
      const r = await fetch("/api/ai/agent/stream?run_id=" + encodeURIComponent(runId) + "&offset=0",
                            { signal: AI.ctrl.signal });
      if (!r.ok) {
        let msg = "HTTP " + r.status;
        try { msg = (await r.json()).error || msg; } catch (_) {}
        throw new Error(msg);
      }
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const evt = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of evt.split("\n")) {
            if (!line.startsWith("data:")) continue;
            let e;
            try { e = JSON.parse(line.slice(5).trim()); } catch (_) { continue; }
            handleEvent(e);
          }
        }
        aiScrollToBottom(true);
      }
    }
    if (stepsBox) { stepsBox._pending = 0; stepsBox._paint(); stepsBox._setCollapsed(true); }  // 本轮结束：自动折叠为一行
    return { text: text, steps: steps, changes: changes, todos: todos,
             usage: { in: realIn, out: realOut, ctx: ctxLast } };
  }

  /* ---------- 附加文件 / 文件夹到对话：资源管理器右键「添加到 AI 对话」→ 输入框上方出现小卡片 ---------- */
  const AI_FILE_LIMIT = 6;          // 最多同时附加几项（文件 / 文件夹）
  const AI_FILE_CHARS = 8000;       // 单个文件最多带入多少字符
  const AI_DIR_CHARS = 6000;        // 文件夹目录结构最多带入多少字符
  const AI_DIR_ENTRIES = 400;       // 目录结构最多列出多少条
  const AI_DIR_DEPTH = 4;           // 目录结构最多往下展开几层
  /* 文件夹 → 目录结构清单（缩进文本树）：让 AI 知道这个目录里有什么。
     只列名称、不读内容，避免把大文件 / 二进制 / .env 内容塞进上下文；
     过滤规则与资源管理器一致（依赖目录走 TREE_IGNORE，隐藏文件跟随「显示全部」开关）。 */
  async function aiDirDigest(dirPath) {
    const lines = [];
    let dirs = 0, files = 0, truncated = false, folded = 0;
    const showAll = (typeof showAllFiles !== "undefined") && !!showAllFiles;
    const showHid = (typeof showHidden !== "undefined") && !!showHidden;
    const walk = async (p, depth) => {
      let d;
      try { d = await apiFiles(p, showHid); }
      catch (_) { if (!depth) throw new Error("目录读取失败"); return; }
      const items = (d.items || [])
        .filter(it => showAll || !TREE_IGNORE.has(it.name))
        .sort((a, b) => (b.is_dir - a.is_dir) || a.name.localeCompare(b.name, "zh"));
      for (const it of items) {
        if (lines.length >= AI_DIR_ENTRIES) { truncated = true; return; }
        const deep = depth + 1;
        if (it.is_dir) {
          dirs++;
          lines.push("  ".repeat(deep) + it.name + "/");
          if (deep < AI_DIR_DEPTH) await walk(p + "/" + it.name, deep);
          else folded++;                       // 超过层数上限：只列目录名，不再往下
        } else {
          files++;
          lines.push("  ".repeat(deep) + it.name);
        }
      }
    };
    await walk(dirPath, 0);
    if (!lines.length) return "（空目录）";
    const note = [];
    if (truncated) note.push("已达 " + AI_DIR_ENTRIES + " 条上限，其余未列出");
    if (folded) note.push(folded + " 个目录超过 " + AI_DIR_DEPTH + " 层未展开");
    return "共 " + dirs + " 个目录 / " + files + " 个文件"
      + (note.length ? "（" + note.join("；") + "）" : "") + "\n" + lines.join("\n");
  }
  /* 单项附加内核：只做读取 + 入列，不弹提示（提示交给调用方，便于批量时汇总成一条）。
     返回 { ok:true } 或 { ok:false, reason:"dup"|"limit"|"unsupported"|"err", msg } */
  /* 输入框里被删掉的芯片 → 同步清理 AI.files 缓存（否则再次添加同一文件会被判为重复） */
  function aiPruneFilesByInput() {
    const ta = $("aiText");
    if (!ta || !Array.isArray(AI.files) || !AI.files.length) return;
    const paths = new Set(Array.from(ta.querySelectorAll(".ai-tag-file")).map(el => el.dataset.path));
    AI.files = AI.files.filter(f => paths.has(f.path));
  }
  async function aiAttachOne(path, name, isDir, opts) {
    opts = opts || {};
    if (!Array.isArray(AI.files)) AI.files = [];
    aiPruneFilesByInput();
    if (AI.files.some(f => f.path === path)) return { ok: false, reason: "dup" };
    if (AI.files.length >= AI_FILE_LIMIT) return { ok: false, reason: "limit" };
    let text = "";
    if (isDir) {
      if (!opts.quiet) toast("正在整理目录结构：" + name, "info");   // 目录要逐层读取，先给个反馈（toast 是单例，完成后再覆盖）
      try { text = await aiDirDigest(path); }
      catch (e) { return { ok: false, reason: "err", msg: "无法读取目录 " + name + "：" + (e.message || e) }; }
    } else {
      try {
        const res = await loadFileText(path, name);
        if (res.unsupported) return { ok: false, reason: "unsupported" };
        if (res.error) return { ok: false, reason: "err", msg: "无法读取 " + name + "：" + res.error };
        text = res.text || "";
      } catch (e) { return { ok: false, reason: "err", msg: "无法读取 " + name + "：" + (e.message || e) }; }
    }
    const cap = isDir ? AI_DIR_CHARS : AI_FILE_CHARS;
    if (text.length > cap) text = text.slice(0, cap) + "\n…（内容过长已截断）";
    AI.files.push({ path: path, name: name, text: text, isDir: !!isDir });
    return { ok: true };
  }
  /* ---------- 输入框内联芯片：文件 / 图片和文字一样排在输入框里（退格键整块删除） ---------- */
  function aiAttr(s) { return esc(String(s == null ? "" : s)).replace(/"/g, "&quot;"); }
  // 芯片悬浮提示：真实文件显示「相对项目根的路径」；
  // 虚拟路径（选中代码的 sel#N、终端输出的 ::terminal 等）不是真实文件，不给提示
  function aiPathTip(p) {
    const s = String(p || "");
    if (!s || s.indexOf("::") === 0 || s.indexOf("sel#") === 0) return "";
    const abs = s.charAt(0) === "/" || /^[A-Za-z]:[\\/]/.test(s);
    if (!abs) return "";
    return (typeof relPathOf === "function") ? relPathOf(s) : s;
  }
  // 在输入框光标处插入一段 HTML（与 aiInsertSkillTag 同样的定位逻辑）
  function aiInsertTagAtCaret(html) {
    const ta = $("aiText");
    if (!ta) return;
    ta.focus();
    const sel = window.getSelection();
    let range;
    if (AI._skillRange && ta.contains(AI._skillRange.commonAncestorContainer)) {
      range = AI._skillRange.cloneRange();
      AI._skillRange = null;
    } else if (sel.rangeCount > 0 && ta.contains(sel.getRangeAt(0).commonAncestorContainer)) {
      range = sel.getRangeAt(0);
    } else {
      range = document.createRange();
      range.selectNodeContents(ta);
      range.collapse(false);
    }
    range.deleteContents();
    range.insertNode(range.createContextualFragment(html));
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
    aiRenderActiveSkills();
  }
  // 文件 / 文件夹芯片（内容在添加时已读进 AI.files，发送时按芯片顺序取用）；
  // 悬浮时图标位置变成「×」，点一下即可把这一项从输入框里删掉
  function aiInsertFileTag(f) {
    aiInsertTagAtCaret(
      '<span class="ai-tag ai-tag-file' + (f.isDir ? " is-dir" : "") + '" contenteditable="false"' +
      ' title="' + aiAttr(aiPathTip(f.path) || f.name) + '"' +
      ' data-path="' + aiAttr(f.path) + '" data-name="' + aiAttr(f.name) + '"' +
      ' data-isdir="' + (f.isDir ? "1" : "0") + '">' +
      '<button type="button" class="ai-tag-x" title="移除"><i class="bi bi-x"></i></button>' +
      '<i class="bi ' + (f.isDir ? "bi-folder2" : "bi-file-earmark-text") + ' ai-tag-ic"></i>' +
      esc(f.name) +
      '</span>&nbsp;');
  }
  // 图片芯片：只显示图标 + 文件名，dataURL 存在 data-src 上（发送时取出）；
  // 悬浮时图标位置变成「×」，点一下即可把这张图片从输入框里删掉
  function aiInsertImgTag(src, name) {
    aiInsertTagAtCaret(
      '<span class="ai-tag ai-tag-img" contenteditable="false" data-src="' + aiAttr(src) + '"' +
      ' data-name="' + aiAttr(name) + '">' +
      '<button type="button" class="ai-tag-x" title="移除此图片"><i class="bi bi-x"></i></button>' +
      '<i class="bi bi-file-earmark-image ai-tag-ic"></i>' +
      esc(name) + '</span>&nbsp;');
  }
  /* ---------- 编辑器里「选中的代码」→ 芯片（形如 [JS] 文件名:22-30） ---------- */
  let _aiSelSeq = 0;
  // 由文件名推断语言标签（用于芯片上的高亮徽标与代码块围栏）
  function aiLangOf(name) {
    const ext = String(name || "").split(".").pop().toLowerCase();
    const m = { js: "JS", mjs: "JS", cjs: "JS", jsx: "JSX", ts: "TS", tsx: "TSX", py: "PY", json: "JSON",
      html: "HTML", htm: "HTML", css: "CSS", scss: "SCSS", less: "LESS", md: "MD", markdown: "MD",
      xml: "XML", yml: "YAML", yaml: "YAML", sh: "SH", bash: "SH", zsh: "SH", sql: "SQL", java: "Java",
      c: "C", h: "C", cpp: "C++", cc: "C++", hpp: "C++", cs: "C#", go: "Go", rs: "RS", php: "PHP",
      rb: "RB", lua: "Lua", vue: "Vue", ini: "INI", toml: "TOML", conf: "CONF", txt: "TXT" };
    return m[ext] || (ext ? ext.toUpperCase().slice(0, 4) : "TXT");
  }
  // 代码片段芯片：语言徽标 + 文件名:起止行（内容存在 AI.files 里，芯片只带路径）
  function aiInsertSelTag(s) {
    aiInsertTagAtCaret(
      '<span class="ai-tag ai-tag-file ai-tag-sel" contenteditable="false"' +
      ' title="' + aiAttr(aiPathTip(s.src) || s.name) + '"' +
      ' data-path="' + aiAttr(s.path) + '" data-name="' + aiAttr(s.name) + '" data-isdir="0">' +
      '<button type="button" class="ai-tag-x" title="移除"><i class="bi bi-x"></i></button>' +
      '<span class="ai-tag-lang ai-tag-ic">' + esc(s.lang) + '</span>' +
      esc(s.name) +
      '</span>&nbsp;');
  }
  // 编辑器右键「添加到 AI 对话」：把当前选中的代码作为一段上下文加进来
  function aiAddSelectionToChat(tab) {
    const cm = tab && tab.cm;
    if (!cm) { toast("当前编辑器不支持取选中内容", "warn"); return; }
    const code = cm.getSelection();
    if (!code || !code.trim()) { toast("请先在编辑器里选中一段代码", "info"); return; }
    let lineInfo = "", selStart = 0, selEnd = 0;       // 文件名:起-止（单行只写一个行号）
    const rs = cm.listSelections();
    if (rs && rs.length) {
      const s = Math.min(rs[0].anchor.line, rs[0].head.line) + 1;
      const e = Math.max(rs[0].anchor.line, rs[0].head.line) + 1;
      selStart = s; selEnd = e;
      lineInfo = (s === e) ? (":" + s) : (":" + s + "-" + e);
    }
    if (!Array.isArray(AI.files)) AI.files = [];
    if (AI.files.length >= AI_FILE_LIMIT) { toast("最多同时附加 " + AI_FILE_LIMIT + " 项", "warn"); return; }
    const name = tab.name + lineInfo;
    const lang = aiLangOf(tab.name);
    const path = "sel#" + (++_aiSelSeq);               // 虚拟路径（不会与真实文件路径冲突）
    AI.files.push({ path: path, kind: "sel", name: name, lang: lang, text: code, isDir: false,
                    src: tab.path || "", start: selStart, end: selEnd });   // src/行段：消息里点芯片可跳回编辑器
    toggleAI(true);                                    // 面板没打开时自动打开
    aiRenderFiles();
    aiInsertSelTag({ path: path, name: name, lang: lang, src: tab.path || "" });
    toast("已添加选中代码：" + name, "ok");
  }
  /* 读取输入框：纯文字（不含芯片自带的文字）+ 文件芯片 + 图片芯片 */
  function aiReadInputBox() {
    const box = $("aiText");
    const out = { text: "", files: [], imgs: [] };
    if (!box) return out;
    const buf = { s: "" };
    const walk = (parent) => {
      parent.childNodes.forEach(n => {
        if (n.nodeType === 3) { buf.s += n.nodeValue; return; }
        if (n.nodeType !== 1) return;
        const el = n;
        if (el.classList.contains("ai-tag-file")) {
          out.files.push({ path: el.dataset.path, name: el.dataset.name, isDir: el.dataset.isdir === "1" });
          return;
        }
        if (el.classList.contains("ai-tag-img")) {
          out.imgs.push({ src: el.dataset.src, name: el.dataset.name || "Image.png" });
          return;
        }
        if (el.tagName === "BR") { buf.s += "\n"; return; }
        const isBlock = el.tagName === "DIV" || el.tagName === "P";
        if (isBlock && buf.s && !buf.s.endsWith("\n")) buf.s += "\n";
        walk(el);
        if (isBlock && !buf.s.endsWith("\n")) buf.s += "\n";
      });
    };
    walk(box);
    out.text = buf.s.replace(/\u00a0/g, " ").replace(/\n{3,}/g, "\n\n").replace(/^\s+|\s+$/g, "");
    return out;
  }
  async function aiAddFileFromTree(path, name, isDir) {
    const r = await aiAttachOne(path, name, isDir);
    if (!r.ok) {
      toggleAI(true);                          // 即使没加成也把面板亮出来，让用户看到现有卡片
      if (r.reason === "dup") toast(name + " 已经在 AI 对话里了", "info");
      else if (r.reason === "limit") toast("最多同时附加 " + AI_FILE_LIMIT + " 个文件 / 文件夹", "warn");
      else if (r.reason === "unsupported") toast("该文件类型不支持作为文本附加：" + name, "warn");
      else toast(r.msg || "添加失败", "err");
      return;
    }
    toggleAI(true);                            // 面板没打开时自动打开
    aiRenderFiles();
    aiInsertFileTag({ path: path, name: name, isDir: !!isDir });   // 直接插进输入框，和文字排在一起
    toast((isDir ? "已添加目录结构：" : "已添加到 AI 对话：") + name, "ok");
  }
  /* 多选批量添加：把选中的文件 / 文件夹一次性加进对话。
     逐项失败（重复 / 不支持 / 读取失败）只跳过，最后汇总成一条提示，避免 toast 刷屏。 */
  async function aiAddManyFromTree(items) {
    if (!Array.isArray(AI.files)) AI.files = [];
    const list = (items || []).filter(x => x && x.path);
    if (!list.length) return;
    toggleAI(true);                            // 面板没打开时自动打开
    toast("正在整理 " + list.length + " 项…", "info");   // 目录要逐层读取，先给反馈（完成后被汇总提示覆盖）
    const added = [], dup = [], bad = [];
    let hitLimit = false;
    for (const it of list) {
      const r = await aiAttachOne(it.path, it.name, it.isDir, { quiet: true });
      if (r.ok) { added.push(it); continue; }
      if (r.reason === "dup") { dup.push(it.name); continue; }
      if (r.reason === "limit") { hitLimit = true; break; }   // 已达上限，后面的都放不下，不必再读
      bad.push(r.msg || (it.name + "（不支持的类型）"));   // r.msg 里已含条目名，不再重复拼接
    }
    if (added.length) {
      aiRenderFiles();
      // 批量插进输入框：一次插入，保持原顺序（和文字排在一起）
      aiInsertTagAtCaret(added.map(it =>
        '<span class="ai-tag ai-tag-file' + (it.isDir ? " is-dir" : "") + '" contenteditable="false"' +
        ' title="' + aiAttr(aiPathTip(it.path) || it.name) + '"' +
        ' data-path="' + aiAttr(it.path) + '" data-name="' + aiAttr(it.name) + '"' +
        ' data-isdir="' + (it.isDir ? "1" : "0") + '">' +
        '<button type="button" class="ai-tag-x" title="移除"><i class="bi bi-x"></i></button>' +
        '<i class="bi ' + (it.isDir ? "bi-folder2" : "bi-file-earmark-text") + ' ai-tag-ic"></i>' +
        esc(it.name) +
        '</span>&nbsp;').join(""));
    }
    if (bad.length) console.warn("[AI] 以下条目未能加入对话：", bad);
    const nDir = added.filter(x => x.isDir).length, nFile = added.length - nDir;
    const parts = [];
    if (nFile) parts.push(nFile + " 个文件");
    if (nDir) parts.push(nDir + " 个目录结构");
    let msg = added.length ? ("已添加 " + parts.join(" + ") + " 到 AI 对话") : "没有可添加的项";
    const skipped = list.length - added.length;
    if (skipped) {
      const why = [];
      if (dup.length) why.push(dup.length + " 项已在对话中");
      if (bad.length) why.push(bad.length + " 项读取失败或不支持");
      if (hitLimit) why.push("已达 " + AI_FILE_LIMIT + " 项上限");
      msg += "，跳过 " + skipped + " 项（" + why.join("；") + "）";
    }
    toast(msg, added.length ? "ok" : "warn");
  }
  function aiRenderFiles() {
    // 文件芯片已改为直接排在输入框内（见 aiInsertFileTag）：输入框上方的旧卡片区不再渲染
    const box = $("aiFiles");
    if (box) { box.style.display = "none"; box.innerHTML = ""; }
    aiScrollToBottom();
  }
  function aiBuildContext() {
    let out = "";
    if (AI.ctx && active && active.cm) {       // 「附带当前文件」开关
      let text = active.cm.getValue();
      if (text.length > 6000) text = text.slice(0, 6000) + "\n…（内容过长已截断）";
      out += "\n\n【参考：当前打开文件 " + active.name + "】\n```\n" + text + "\n```";
    }
    (AI.files || []).forEach(f => {            // 附加进来的文件 / 文件夹 / 选中代码 / 终端输出
      if (!f.text) return;
      if (f.kind === "sel") {                  // 编辑器里选中的代码片段（形如 文件名:22-30）
        out += "\n\n【参考：选中代码 " + f.name + "】\n```" + (f.lang || "") + "\n" + f.text + "\n```";
        return;
      }
      if (f.kind === "term") {                 // 终端输出
        out += "\n\n【参考：终端输出】\n```\n" + f.text + "\n```";
        return;
      }
      out += "\n\n【参考：" + (f.isDir ? "目录结构 " : "文件 ") + relPathOf(f.path) +
        "】\n```\n" + f.text + "\n```";
    });
    return out;
  }
  /* ---------- 图片输入：选择 / 粘贴 / 待发预览 / 大图降采样 ---------- */
  function aiMaybeDownscale(dataUrl) {
    return new Promise(resolve => {
      if (dataUrl.length < 1600000) { resolve(dataUrl); return; }  // 小于 ~1.2MB 直接用原图（截图清晰度优先）
      const im = new Image();
      im.onload = () => {
        const MAX = 2048;                                        // 长边上限：保证截图文字仍可辨认
        const k = Math.min(1, MAX / Math.max(im.width, im.height));
        const cv = document.createElement("canvas");
        cv.width = Math.max(1, Math.round(im.width * k));
        cv.height = Math.max(1, Math.round(im.height * k));
        cv.getContext("2d").drawImage(im, 0, 0, cv.width, cv.height);
        try { resolve(cv.toDataURL("image/jpeg", 0.92)); } catch (_) { resolve(dataUrl); }
      };
      im.onerror = () => resolve(dataUrl);
      im.src = dataUrl;
    });
  }
  function aiCountImgTags() {                            // 输入框里已有的图片芯片数（上限 6 张）
    const ta = $("aiText");
    return ta ? ta.querySelectorAll(".ai-tag-img").length : 0;
  }
  function aiAddImgs(fileList) {
    const files = Array.from(fileList || []).filter(f => f.type && f.type.startsWith("image/"));
    if (!files.length) return;
    let n = aiCountImgTags();
    files.forEach(f => {
      if (n >= 6) { toast("最多同时附带 6 张图片", "warn"); return; }
      n++;
      const rd = new FileReader();
      rd.onload = () => {
        aiMaybeDownscale(rd.result).then(u => {
          aiInsertImgTag(u, f.name || "Image.png");      // 图片也作为芯片插进输入框，与文字混排
          const t = $("aiText"); if (t) t.focus();
        });
      };
      rd.readAsDataURL(f);
    });
  }
  function aiRenderPending() {
    const box = $("aiImgs");
    box.style.display = AI.pending.length ? "" : "none";
    box.innerHTML = "";
    AI.pending.forEach((u, i) => {
      const d = document.createElement("div");
      d.className = "ai-img-thumb";
      const im = document.createElement("img"); im.src = u;
      const rm = document.createElement("button"); rm.className = "rm"; rm.textContent = "×"; rm.title = "移除";
      rm.addEventListener("click", () => { AI.pending.splice(i, 1); aiRenderPending(); });
      d.appendChild(im); d.appendChild(rm); box.appendChild(d);
    });
  }
  $("aiImgBtn").addEventListener("click", () => $("aiFile").click());
  $("aiFile").addEventListener("change", () => { aiAddImgs($("aiFile").files); $("aiFile").value = ""; });
  $("aiText").addEventListener("paste", (e) => {
    const fs = e.clipboardData && e.clipboardData.files;
    if (fs && fs.length) { e.preventDefault(); aiAddImgs(fs); return; }
    const txt = e.clipboardData && e.clipboardData.getData("text/plain");
    if (txt != null) {
      e.preventDefault();
      document.execCommand("insertText", false, txt);
    }
  });
  /* ---------- 图片芯片悬浮预览：鼠标停在输入框里的图片芯片上 → 弹出一张小图 ---------- */
  let _aiImgTip = null;
  function aiHideImgTip() {
    if (_aiImgTip) { _aiImgTip.remove(); _aiImgTip = null; }
  }
  function aiShowImgTip(src, anchor) {
    if (!src) return;
    if (_aiImgTip && _aiImgTip._anchor === anchor) return;    // 同一张芯片不重复弹
    aiHideImgTip();
    const d = document.createElement("div");
    d.className = "ai-img-hover";
    const im = document.createElement("img");
    im.src = src;
    im.alt = "图片预览";
    d.appendChild(im);
    d._anchor = anchor;
    document.body.appendChild(d);
    const r = anchor.getBoundingClientRect();
    const w = d.offsetWidth, h = d.offsetHeight;
    let left = r.left + r.width / 2 - w / 2;
    left = Math.max(8, Math.min(window.innerWidth - w - 8, left));
    let top = r.top - h - 8;                                  // 默认浮在芯片上方
    if (top < 8) top = Math.min(window.innerHeight - h - 8, r.bottom + 8);   // 上方放不下就放到下方
    d.style.left = Math.round(left) + "px";
    d.style.top = Math.round(top) + "px";
    _aiImgTip = d;
  }
  $("aiText").addEventListener("mouseover", (e) => {
    const tag = e.target.closest(".ai-tag-img");
    if (!tag || !e.currentTarget.contains(tag)) return;
    aiShowImgTip(tag.dataset.src, tag);
  });
  $("aiText").addEventListener("mouseout", (e) => {
    const tag = e.target.closest(".ai-tag-img");
    if (!tag) return;
    if (e.relatedTarget && tag.contains(e.relatedTarget)) return;   // 芯片内部移动不算离开
    aiHideImgTip();
  });
  $("aiText").addEventListener("scroll", aiHideImgTip);
  document.addEventListener("scroll", aiHideImgTip, true);   // 面板 / 页面滚动时收起
  window.addEventListener("blur", aiHideImgTip);

  /* ---------- 助手回复按 pid 去重：刷新重连 / 服务端已落库时，避免同一轮回复被渲染两遍 ---------- */
  function aiMsgIndexOfPid(pid) {
    return (AI.msgs || []).findIndex(m => m && m.pid && m.pid === pid);
  }
  function aiDedupeMsgs() {                               // 按 pid 去重（同 pid 只保留最后一条）
    const last = new Map();
    (AI.msgs || []).forEach((m, i) => { if (m && m.pid) last.set(m.pid, i); });
    if (last.size === (AI.msgs || []).length) return false;
    const keep = new Set(last.values());
    AI.msgs = (AI.msgs || []).filter((m, i) => !m || !m.pid || keep.get(m.pid) === i);
    return true;
  }
  function aiUpsertAssistantMsg(msg) {                    // 覆盖写入（未提供的字段保留旧值），返回下标
    const i = aiMsgIndexOfPid(msg.pid);
    if (i >= 0) {
      const merged = Object.assign({}, AI.msgs[i]);
      for (const k in msg) if (msg[k] !== undefined) merged[k] = msg[k];
      AI.msgs[i] = merged;
      return i;
    }
    AI.msgs.push(msg);
    return AI.msgs.length - 1;
  }
  /* 收尾一条助手回复：已在列表里（如服务端已落库 / 重连回放）→ 覆盖并整表重渲染，杜绝重复气泡 */
  function aiFinalizeAssistant(msg) {
    const existed = aiMsgIndexOfPid(msg.pid) >= 0;
    return { mi: aiUpsertAssistantMsg(msg), existed: existed };
  }

  async function aiSend(reuse) {                          // reuse={text,imgs}：重新生成，不重复 push 用户消息
    if (AI.busy) return;
    AI._userStop = false; AI._unloading = false;   // 新一轮开始：重置「用户停止 / 页面卸载」标记
    let rawText, text, imgs, skillIds = [];
    const resumeRunId = (reuse && reuse.resumeRunId) || "";   // 非空＝刷新后重连上一次后台运行
    let imgNamesOfTurn = [];                        // 图片芯片的真实文件名（消息里按原名显示）
    if (reuse) {
      rawText = reuse.text || "";
      text = rawText;
      imgs = (reuse.imgs || []).slice();
      imgNamesOfTurn = (reuse.imgNames || []).slice();
      skillIds = (reuse.skills || []).slice();      // 重新生成时沿用原消息的 Skill
    }
    else {
      const ta = $("aiText");
      const box = aiReadInputBox();               // 文字 + 文件芯片 + 图片芯片（芯片自带的文字不计入正文）
      rawText = box.text;
      const parsed = aiParseSkillTags(rawText);
      skillIds = parsed.ids;
      // 输入框里的 @技能 标签带 data-id：改名后也能准确识别
      ta.querySelectorAll(".ai-tag[data-id]").forEach(t => {
        const id = t.dataset.id;
        if (id && !skillIds.includes(id)) skillIds.push(id);
      });
      text = parsed.text;
      // 文件芯片：按芯片顺序重建本轮要带的文件（内容在添加时已读进 AI.files 缓存）
      const cached = AI.files || [];
      AI.files = box.files.map(f => cached.find(x => x.path === f.path)).filter(Boolean);
      imgs = box.imgs.map(x => x.src);            // 图片芯片：取出各自的 dataURL
      imgNamesOfTurn = box.imgs.map(x => x.name || "Image.png");
      if (!text && !imgs.length && !AI.files.length) return;
    }
    await aiLoadCfg();
    const pick = aiCurrentPick();
    const prov = pick.prov;
    if (!prov || !pick.model) {
      console.warn("[AI] 未配置可用接口，已取消发送", { hasProvider: !!prov, model: pick.model });
      aiOpenSettings();
      toast("请先在 设置 → AI 助手 里添加接口（地址 / API Key / 模型列表）", "warn");
      return;
    }
    $("aiEmpty") && ($("aiEmpty").style.display = "none");
    aiTodoFloatHide();            // 新一轮开始：先收起上一轮的任务清单，等本轮产生清单再显示
    let userMsgForPending = null;
    if (!reuse) {
      const userText = text || (imgs.length ? "（见图）" : "");
      // 本条消息附带的文件 / 文件夹 / 选中代码：与输入框芯片同序同形，显示在消息上方
      const attFiles = (AI.files || []).map(f => ({ name: f.name, path: f.path, src: f.src || "",
                                                    isDir: !!f.isDir, kind: f.kind || "", lang: f.lang || "",
                                                    start: f.start || 0, end: f.end || 0 }));
      const userMsg = { role: "user", pid: aiNewPid(), text: userText, ts: Date.now(),
                        imgs: imgs.length || undefined,
                        images: imgs.length ? imgs : undefined,
                        imgNames: imgNamesOfTurn.length ? imgNamesOfTurn : undefined,
                        files: attFiles.length ? attFiles : undefined,
                        skills: skillIds.length ? skillIds : undefined };
      AI.msgs.push(userMsg);
      userMsgForPending = { text: userText, ts: userMsg.ts, files: attFiles, skills: skillIds };
      const ub = aiBubble("user", userText, "", imgs, false, attFiles, imgNamesOfTurn);
      ub.parentElement.insertAdjacentHTML("beforeend", aiUserMetaHtml(AI.msgs[AI.msgs.length - 1], AI.msgs.length - 1));
      $("aiText").innerHTML = "";
      aiHideImgTip();                            // 输入框清空（芯片一并消失）→ 收起图片预览
      AI.pending = [];
      aiRenderPending();
      aiRenderActiveSkills();
    }
    aiPersistCurrent(); aiRenderConv();
    aiSavePendingTurn(text, imgs, skillIds, userMsgForPending, resumeRunId);   // 记录本轮生成：刷新后可自动续接

    // ---- dsh 式记忆压缩：旧历史攒够就压成摘要，之后只带 摘要 + 最近几条 发送 ----
    const sess = AI.sessions.find(x => x.id === AI.curId);
    const curIdx = AI.msgs.length - 1;                    // 刚 push 的当前消息索引
    if (sess) {
      const start = sess.cmpLen || 0;
      const toSum = AI.msgs.slice(start, curIdx);
      const needCmp = start === 0 ? toSum.length >= 12 : toSum.length >= 8;
      if (needCmp) {
        try {
          const sr = await fetch("/api/ai/summarize", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              prev: sess.mem || "",
              messages: toSum.map(m => ({ role: m.role, text: m.text || "" })),
            }),
          });
          const sd = await sr.json();
          if (sr.ok && sd.summary) {
            const savedChars = toSum.reduce((a, m) => a + (m.text || "").length, 0);
            sess.mem = sd.summary;
            sess.cmp = (sess.cmp || 0) + 1;
            sess.cmpLen = curIdx;
            sess.savedTok = (sess.savedTok || 0) + Math.round(savedChars / 2);
            aiPersistCurrent();
          }
        } catch (_) { /* 压缩失败静默：不影响本轮发送 */ }
      }
    }
    const mem = (sess && sess.mem) || "";
    const t0 = performance.now();

    AI.busy = true;
    $("aiSend").style.display = "none";
    $("aiStop").style.display = "";
    const permHint = (AI.perm === "readonly"
      ? "当前权限「仅可查看」：只做解释与建议，不要声称自己已经修改了文件。"
      : (AI.perm === "full"
        ? "当前权限「完全权限」：可以给出任意路径下的完整文件内容。"
        : "当前权限「工作区内修改」：给出可直接保存到项目内的完整文件内容。")) +
      "你可以直接调用工具读取项目文件（list_dir / read_file / search_files），不要要求用户手动粘贴代码。";
    // 内置 skill 由后端根据 skills 列表注入；自定义 / 被本地覆盖的 skill 的 prompt 在这里追加到 system
    const _allSk = aiAllSkills();
    const _of = (id) => _allSk.find(s => s.id === id);
    const activeSkillNames = skillIds.map(id => (_of(id) || {}).name).filter(Boolean);
    const customSkillPrompts = skillIds
      .filter(id => { const s = _of(id); return s && (!s.builtin || s.promptOverridden); })
      .map(id => aiSkillPrompt(id))
      .filter(Boolean);
    const backendSkills = skillIds.filter(id => { const s = _of(id); return s && s.builtin && !s.promptOverridden; });
    const skillNote = activeSkillNames.length
      ? "\n\n[本轮激活的 Skill]\n" + activeSkillNames.map(n => "- " + n).join("\n") +
        "\n注意：用户消息里的 @技能名 会转换为 [Skill:技能名] 发送给你；这些标记是 Skill 引用，绝对不是文件路径。" +
        "不要要求用户为 Skill 标记补充文件路径，直接根据该 Skill 的能力回答即可。如需引用文件，用户会提供具体路径。"
      : "";
    const sysPrompt = "你是一个自托管文件管理器内置的 AI 编程助手。当前项目根目录：" +
      (typeof ROOT !== "undefined" ? ROOT : "/") +
      "。" + permHint + "回答使用简体中文，代码块标注语言，简洁直接。" +
      skillNote +
      (customSkillPrompts.length ? "\n\n[Skill 激活说明]\n" + customSkillPrompts.join("\n\n") : "");
    // 当前这条消息：带图片/上下文时用多模态数组，否则纯文本
    const modelText = aiReplaceSkillTagsForModel(text);
    const curText = modelText + aiBuildContext();
    if (!reuse) {                            // 上下文已抓取进本条消息，发送后清空输入区的附加文件卡片
      AI.files = [];
      aiRenderFiles();
    }
    const curContent = imgs.length
      ? [{ type: "text", text: curText }, ...imgs.map(u => ({ type: "image_url", image_url: { url: u } }))]
      : curText;
    // 有记忆摘要时只发最近 6 条历史 + 摘要注入 system；无记忆则全量（dsh 行为）
    const hist = AI.msgs.slice(0, -1);
    const usedHist = mem ? hist.slice(-6) : hist;
    const historyMapper = (m) => ({
      role: m.role,
      content: m.role === "user" ? aiReplaceSkillTagsForModel(m.text || m.content || "") : (m.text || m.content || ""),
    });
    // inTok 估算：system + 记忆 + 完整历史（含图片） + 当前消息；中英混合粗估 1.5 char/token
    const _estLen = (c) => {
      if (typeof c === "string") return c.length;
      if (Array.isArray(c)) {
        let n = 0;
        for (const p of c) {
          if (!p) continue;
          if (p.type === "text") n += (p.text || "").length;
          else if (p.type === "image_url") n += 1050;   // 图片约 700 tok * 1.5
        }
        return n;
      }
      return JSON.stringify(c || "").length;
    };
    const histTokChars = hist.reduce((a, m) => a + _estLen(m.content), 0);
    const skillChars = customSkillPrompts.reduce((a, p) => a + (p || "").length, 0);
    const inTok = Math.ceil((sysPrompt.length + mem.length + histTokChars + _estLen(curContent) + skillChars) / 1.5);
    const payload = {
      session_id: AI.curId,                            // 供服务端把回复落库（刷新/关页面也不丢）
      provider_id: prov.id,
      model: pick.model,
      web_search: AI.webSearch,
      image_tool: (typeof chatBool === "function") ? chatBool("chatImageGen") : true,
      lsp_tool: (typeof chatBool === "function") ? chatBool("chatLspTool") : true,
      image_model: (typeof chatGet === "function") ? (chatGet("chatImageModel") || "") : "",
      skills: backendSkills,
      perm: AI.perm,
      repo: (typeof ROOT !== "undefined" ? ROOT : ""),
      messages: [
        { role: "system", content: sysPrompt + (mem ? "\n\n[本对话早期内容记忆摘要]\n" + mem : "") },
        ...usedHist.map(historyMapper),
        { role: "user", content: curContent },
      ],
    };
    const thinkB = aiBubble("assistant", "", "ai-think");
    thinkB.parentElement.style.display = "none";        // 无思考内容时不占位
    const bodyB = aiBubble("assistant", "", "", null, true);
    bodyB.innerHTML = '<span class="ai-waiting">思考中<span class="d"></span><span class="d"></span><span class="d"></span></span>';
    let acc = "", thinking = "", ttft = 0;                // ttft：首 token 到达耗时
    let realIn = 0, realOut = 0;                          // 后端透传的真实 token 用量（拿不到时退回字数估算）
    let ctxTok = 0;                                       // 最后一轮请求的输入规模（= 当前上下文占用）
    let turnChanges = [];                                 // 本轮 AI 产生的文件改动 id（供回撤）
    let turnSteps = [];                                   // 本轮工具步骤（普通对话路径用；智能体路径见 AI._agentTurnSteps）
    let turnTodos = [];                                   // 本轮任务清单（todo_write）
    let turnDone = false;                                 // 回复已入列：之后收尾出错不再覆盖/重复插入
    let keepPending = false;                              // 流中断（刷新/断网）时保留续连标记，别清 pending
    /* 流式正文渲染节流：一帧最多重渲染一次（原本每收到一批 delta 就整段重解析 Markdown，密集流下易掉帧） */
    let _spPending = false, _spLast = "", _spAlive = true;
    const paintStream = () => {
      _spPending = false;
      if (!_spAlive) return;
      const t = acc.replace(/^\s+/, "");
      if (t === _spLast) return;                          // 文本没变就不重复渲染
      _spLast = t;
      bodyB.innerHTML = aiMd(t) + '<span class="ai-cursor"></span>';
    };
    const schedulePaintStream = () => {
      if (_spAlive && !_spPending) { _spPending = true; requestAnimationFrame(paintStream); }
    };
    const stopPaintStream = () => { _spAlive = false; };   // 结束/出错时停掉排队中的渲染，避免覆盖最终结果
    AI._agentTurnChanges = [];
    AI._agentTurnSteps = [];                              // 由 aiRunAgent 填充：手动停止时保存步骤用
    AI._agentTurnTodos = [];                              // 由 aiRunAgent 填充：手动停止时保存任务清单用
    AI._agentStepsBox = null;
    AI._agentRunId = "";                                  // 本场运行的 id（停止后补拉变更用）
    AI.ctrl = new AbortController();
    // 助手回复的消息 id 与后台运行绑定：服务端用同一个 mid 落库，重连时覆盖更新而不是新增一条
    const runPid = () => (AI._agentRunId ? ("m" + AI._agentRunId) : aiNewPid());
    try {
      if (AI.agent || resumeRunId) {                      // 智能体模式：走带工具的 Agent 接口
        const res = await aiRunAgent({
          session_id: AI.curId,                        // 供服务端把回复落库（刷新/关页面也不丢）
          repo: (typeof ROOT !== "undefined" ? ROOT : ""),
          perm: AI.perm,
          provider_id: prov.id,
          model: pick.model,
          web_search: AI.webSearch,
          auto_run: (typeof chatAutoRunMode === "function") ? chatAutoRunMode() : "safe",
          task_list: (typeof chatBool === "function") ? chatBool("chatTaskList") : true,
          web_tool: (typeof chatBool === "function") ? chatBool("chatWebTool") : true,
          web_auto: (typeof chatBool === "function") ? chatBool("chatWebAuto") : true,
          max_steps: (typeof chatMaxStepsMain === "function") ? chatMaxStepsMain() : 0,
          max_steps_sub: (typeof chatMaxStepsSub === "function") ? chatMaxStepsSub() : 0,
          image_tool: (typeof chatBool === "function") ? chatBool("chatImageGen") : true,
          lsp_tool: (typeof chatBool === "function") ? chatBool("chatLspTool") : true,
          image_model: (typeof chatGet === "function") ? (chatGet("chatImageModel") || "") : "",
          skills: backendSkills,
          skill_prompts: customSkillPrompts,
          skill_names: activeSkillNames,
          messages: [
            ...usedHist.map(m => ({
              role: m.role,
              content: m.role === "user" ? aiReplaceSkillTagsForModel(m.text || m.content || "") : (m.text || m.content || ""),
            })),
            { role: "user", content: curContent },
          ],
        }, bodyB, (t) => {
          acc = t;
          schedulePaintStream();
        }, {
          runId: resumeRunId,                           // 刷新后重连：沿用原 run_id
          onRunId: (rid) => aiSavePendingTurn(text, imgs, skillIds, userMsgForPending, rid),
        });
        stopPaintStream();                              // 结束：停掉排队中的流式重渲染
        if (resumeRunId && !String(acc || "").trim() && !(res.steps || []).length &&
            !(res.changes || []).length && !(res.todos || []).length) {
          // 续接没取到任何内容（运行已结束 / 被清理）：直接以服务端会话历史为准重绘，
          // 绝不写一条空回复进去（否则就会出现「刷新后一片空白」）
          try { await aiFetchSession(AI.curId); } catch (_) {}
          const _s2 = AI.sessions.find(x => x.id === AI.curId);
          if (_s2 && _s2.msgs) AI.msgs = _s2.msgs;
          aiRenderAll(); aiRenderConv(); aiTodoFloatSyncFromMsgs();
          return;
        }
        acc = res.text || "";
        turnChanges = (res.changes && res.changes.length) ? res.changes : (AI._agentTurnChanges || []);
        turnTodos = (res.todos && res.todos.length) ? res.todos : (AI._agentTurnTodos || []);
        turnTodos = aiTodoFinalize(turnTodos);          // 正常跑完：剩余项补成已完成（模型偶尔忘记收尾）
        bodyB.innerHTML = aiMd(acc) || "（已完成，未产生文字说明）";
        const aMeta = { ms: Math.round(performance.now() - t0), ts: Date.now() };
        const aFin = aiFinalizeAssistant({ role: "assistant", pid: runPid(), text: acc, ms: aMeta.ms, ts: aMeta.ts,
                       steps: res.steps.length ? res.steps : undefined,
                       changes: turnChanges.length ? turnChanges : undefined,
                       todos: turnTodos.length ? turnTodos : undefined });
        turnDone = true;                                // 回复已落定：后续收尾出错只提示，不覆盖
        if (aFin.existed) {                             // 服务端已存过（重连回放）：整表重渲染，避免两条
          aiPersistCurrent(); aiRenderAll(); aiRenderConv(); aiTodoFloatSyncFromMsgs();
        } else {
          bodyB.insertAdjacentHTML("afterend", aiMetaHtml(AI.msgs[aFin.mi], aFin.mi));
          aiAppendChangesBox(bodyB.parentElement, AI.msgs[aFin.mi], aFin.mi);
          aiPersistCurrent(); aiRenderConv();
          aiTodoFloatSyncFromMsgs();                    // 刷新底部「任务列表 / 文件列表」
        }
        aiRecordStat(true, aMeta.ms, acc.length, ttft, inTok, (res.usage || {}).in, (res.usage || {}).out,
                     (res.usage || {}).ctx);
        return;
      }
      // 普通对话同样走后台运行（bg=1）+ 可重连的事件流
      let chatRunId = resumeRunId;
      if (!chatRunId) {
        const r = await fetch("/api/ai/chat", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(Object.assign({ bg: 1 }, payload)), signal: AI.ctrl.signal,
        });
        if (!r.ok) {
          let msg = "HTTP " + r.status;
          try { msg = (await r.json()).error || msg; } catch (_) {}
          throw new Error(msg);
        }
        const jd = await r.json().catch(() => ({}));
        chatRunId = jd.run_id || "";
        if (!chatRunId) throw new Error(jd.error || "启动对话失败：未返回 run_id");
        AI._agentRunId = chatRunId;
        aiSavePendingTurn(text, imgs, skillIds, userMsgForPending, chatRunId);
      } else {
        AI._agentRunId = chatRunId;                    // 刷新后重连
      }
      const sr = await fetch("/api/ai/agent/stream?run_id=" + encodeURIComponent(chatRunId) + "&offset=0",
                             { signal: AI.ctrl.signal });
      if (!sr.ok) {
        let msg = "HTTP " + sr.status;
        try { msg = (await sr.json()).error || msg; } catch (_) {}
        throw new Error(msg);
      }
      const reader = sr.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      // 普通对话也会调用读取类工具：把过程记录渲染在消息下方
      const chatSteps = turnSteps, chatStepRows = new Map(), chatStepMeta = new Map();
      let chatStepsBox = null;
      const ensureChatSteps = () => {
        if (!chatStepsBox) { chatStepsBox = aiBuildStepsBox([]); bodyB.parentElement.appendChild(chatStepsBox); }
        return chatStepsBox;
      };
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const evt = buf.slice(0, idx); buf = buf.slice(idx + 2);
          for (const line of evt.split("\n")) {
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (data === "[DONE]") continue;
            let obj; try { obj = JSON.parse(data); } catch (_) { continue; }
            if (obj.type === "retry") {                       // 限流：清空已显示内容，提示后自动重试
              acc = ""; thinking = "";
              thinkB.parentElement.style.display = "none"; thinkB.textContent = "";
              bodyB.innerHTML = aiRetryHint(obj);
              continue;
            }
            if (obj.error) throw new Error(obj.error);
            if (obj.type === "usage") {                       // 后端透传的真实用量（prompt_tokens 为整轮累计）
              const u = obj.usage || {};
              realIn = +u.prompt_tokens || 0;
              realOut = +u.completion_tokens || 0;
              if (+u.context_tokens > 0) ctxTok = +u.context_tokens;   // 本轮输入规模＝当前上下文占用
              continue;
            }
            if (obj.type === "step") {
              chatStepMeta.set(obj.call_id, { tool: obj.tool, args: obj.args });
              const box = ensureChatSteps();
              const row = aiStepRow(obj);
              box._body.appendChild(row);
              chatStepRows.set(obj.call_id, row);
              const a = obj.args || {};
              box._live = (AI_TOOL_LABEL[obj.tool] || obj.tool) +
                (a.path || a.command || a.pattern ? " " + (a.path || a.command || a.pattern) : "");
              box._pending++; box._paint();
              continue;
            }
            if (obj.type === "result") {
              const md = chatStepMeta.get(obj.call_id) || { tool: obj.tool, args: {} };
              aiStepDone(chatStepRows.get(obj.call_id), obj);
              if (obj.changes && obj.changes.length) turnChanges.push(...obj.changes);
              aiCloseTabsForChanges(obj.changes);   // AI 删除了文件：对应编辑标签自动关闭
              const rec = { tool: md.tool, args: md.args, ok: !!obj.ok, denied: !!obj.denied,
                            ms: obj.ms, summary: obj.summary || "", detail: obj.detail || "" };
              chatSteps.push(rec);
              if (chatStepsBox) {
                chatStepsBox._list.push(rec);
                chatStepsBox._pending = Math.max(0, chatStepsBox._pending - 1);
                chatStepsBox._paint();
              }
              continue;
            }
            if (obj.type === "todos") {
              const list = (obj.todos || []).filter(t => t && t.content);
              if (list.length) {
                turnTodos.length = 0;
                turnTodos.push(...list);
                aiTodoFloatShow(turnTodos);
              }
              continue;
            }
            if (obj.type === "subagent") {
              aiSubStepEvent(chatStepRows.get(obj.call_id), obj.event);
              continue;
            }
            if ((obj.reasoning || obj.delta) && !ttft) ttft = performance.now() - t0;
            if (obj.reasoning) thinking += obj.reasoning;
            if (obj.delta) acc += obj.delta;
          }
        }
        if (thinking.trim()) {
          thinkB.parentElement.style.display = "";
          thinkB.textContent = thinking;
        }
        schedulePaintStream();                          // 边流边渲染 MD（每帧最多一次）
        aiScrollToBottom();
      }
      if (chatStepsBox) { chatStepsBox._pending = 0; chatStepsBox._paint(); chatStepsBox._setCollapsed(true); }  // 本轮结束：自动折叠为一行
      stopPaintStream();
      const out = acc.replace(/^\s+/, "");
      bodyB.innerHTML = aiMd(out) || (chatSteps.length ? "（已完成工具调用）" : "（空回复）");
      thinkB.parentElement.style.display = thinking.trim() ? "" : "none";
      const meta = { ms: Math.round(performance.now() - t0), ts: Date.now() };
      turnTodos = aiTodoFinalize(turnTodos);            // 正常跑完：剩余项补成已完成
      const cFin = aiFinalizeAssistant({ role: "assistant", pid: runPid(), text: out, reasoning: thinking.trim() || undefined,
                     ms: meta.ms, ts: meta.ts, steps: chatSteps.length ? chatSteps : undefined,
                     changes: turnChanges.length ? turnChanges : undefined,
                     todos: turnTodos.length ? turnTodos : undefined });
      turnDone = true;                                  // 回复已落定：后续收尾出错只提示，不覆盖
      if (cFin.existed) {                               // 已在列表里（重连回放等）：整表重渲染，避免两条
        aiPersistCurrent(); aiRenderAll(); aiRenderConv(); aiTodoFloatSyncFromMsgs();
      } else {
        bodyB.insertAdjacentHTML("afterend", aiMetaHtml(AI.msgs[cFin.mi], cFin.mi));
        aiAppendChangesBox(bodyB.parentElement, AI.msgs[cFin.mi], cFin.mi);
        aiPersistCurrent(); aiRenderConv();
        aiTodoFloatSyncFromMsgs();                      // 刷新底部「任务列表 / 文件列表」
      }
      aiRecordStat(true, performance.now() - t0, out.length, ttft, inTok, realIn, realOut, ctxTok);
    } catch (e) {
      stopPaintStream();
      console.error("AI 回复处理出错：", e);
      if (turnDone) {                                   // 回复已成功入列：只提示，不覆盖已完成的回复
        toast("回复已完成，但界面更新出错：" + (e.message || e), "warn");
      } else if (e.name === "AbortError" && !AI._userStop) {
        // 刷新 / 关闭页面导致的中断（不是用户点「停止」）：后台任务其实还在跑，
        // 绝不能写「已停止 / 出错了」的回复，也绝不能清掉续连标记 —— 否则刷新后就啥也看不到。
        console.warn("[AI] 页面卸载导致事件流中断，保留续连标记：", e.message || e);
        keepPending = true;
        if (!AI._unloading) {
          bodyB.innerHTML = aiMd(acc.replace(/^\s+/, "")) ||
            '<span class="ai-waiting">后台任务仍在运行，刷新后会自动续上进度' +
            '<span class="d"></span><span class="d"></span><span class="d"></span></span>';
        }
      } else if (e.name === "AbortError") {
        bodyB.innerHTML = aiMd(acc.replace(/^\s+/, "")) + "\n（已停止）";
        const out = acc.trim();
        const ab0 = turnChanges.length ? turnChanges : (AI._agentTurnChanges || []);
        // 手动停止时 aiRunAgent 还没返回，步骤只能从它暴露的数组里取（否则刷新后步骤全丢）
        const abSteps = (turnSteps.length ? turnSteps : (AI._agentTurnSteps || [])).slice();
        const abTodos = (turnTodos.length ? turnTodos : (AI._agentTurnTodos || [])).slice();
        const abBox = AI._agentStepsBox;                 // 步骤框收尾：停掉转圈 + 折叠成一行
        if (abBox) { abBox._pending = 0; abBox._paint(); abBox._setCollapsed(true); }
        const finalizeAbort = (abChanges) => {
          // 有文字 / 有文件改动 / 有步骤 / 有任务清单都保留模块（刷新后仍可见）
          if (out || abChanges.length || abSteps.length || abTodos.length) {
            const meta = { ms: Math.round(performance.now() - t0), ts: Date.now() };
            const abFin = aiFinalizeAssistant({ role: "assistant", pid: runPid(), text: out, ms: meta.ms, ts: meta.ts,
                           steps: abSteps.length ? abSteps : undefined,
                           changes: abChanges.length ? abChanges : undefined,
                           todos: abTodos.length ? abTodos : undefined });
            turnDone = true;
            if (abFin.existed) {
              aiPersistCurrent(); aiRenderAll(); aiRenderConv();
            } else {
              bodyB.insertAdjacentHTML("afterend", aiMetaHtml(AI.msgs[abFin.mi], abFin.mi));
              aiAppendChangesBox(bodyB.parentElement, AI.msgs[abFin.mi], abFin.mi);
              aiPersistCurrent(); aiRenderConv();
            }
          }
          aiRecordStat(!!out, performance.now() - t0, acc.length, ttft, inTok, realIn, realOut, ctxTok);   // 用户主动停止：有内容算成功，完全空回复才算失败
        };
        if (ab0.length || !AI._agentRunId) {
          finalizeAbort(ab0);
        } else {
          // 停止瞬间最后一批 result 事件可能没送达：按 run_id 向后端补拉本场累计变更
          fetch("/api/ai/run-changes", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ run_id: AI._agentRunId }),
          }).then(r => r.json()).then(d => {
            const got = (d.changes || []).filter(c => c && c.path);
            finalizeAbort(got.length ? got : ab0);
          }).catch(() => finalizeAbort(ab0));
        }
      } else if (e && (e.name === "TypeError" ||
                       /failed to fetch|networkerror|load failed|network request failed|aborted/i.test(e.message || ""))) {
        // 刷新页面 / 断网导致事件流中断：后台任务其实还在跑，
        // 这里不能写一条「出错了」的回复进会话，也不能清掉续连标记（否则刷新后就接不上了）
        console.warn("[AI] 事件流中断（可能是刷新页面）：", e.message || e);
        bodyB.innerHTML = aiMd(acc.replace(/^\s+/, "")) ||
          '<span class="ai-waiting">后台任务仍在运行，刷新后会自动续上进度' +
          '<span class="d"></span><span class="d"></span><span class="d"></span></span>';
        keepPending = true;
      } else {
        bodyB.classList.remove("ai-md");
        const errText = "出错了：" + e.message;
        bodyB.textContent = errText;
        bodyB.classList.add("err");
        const meta = { ms: Math.round(performance.now() - t0), ts: Date.now(), err: true };
        const errChanges = (turnChanges.length ? turnChanges : (AI._agentTurnChanges || []));
        const errSteps = (turnSteps.length ? turnSteps : (AI._agentTurnSteps || [])).slice();   // 出错同样保留已完成的步骤
        const eFin = aiFinalizeAssistant({ role: "assistant", pid: runPid(), text: errText, err: true,
                       ms: meta.ms, ts: meta.ts,
                       steps: errSteps.length ? errSteps : undefined,
                       changes: errChanges.length ? errChanges : undefined });
        if (eFin.existed) {
          aiPersistCurrent(); aiRenderAll(); aiRenderConv();
        } else {
          bodyB.insertAdjacentHTML("afterend", aiMetaHtml(AI.msgs[eFin.mi], eFin.mi));
          aiAppendChangesBox(bodyB.parentElement, AI.msgs[eFin.mi], eFin.mi);
          aiPersistCurrent(); aiRenderConv();
        }
        aiRecordStat(false, performance.now() - t0, acc.replace(/^\s+/, "").length, ttft, inTok, realIn, realOut, ctxTok);
      }
    } finally {
      AI.busy = false; AI.ctrl = null;
      $("aiSend").style.display = ""; $("aiStop").style.display = "none";
      aiTodoFloatSetPaused(true);   // 本轮结束（完成/停止/异常）：任务清单暂停，停止转圈
      aiScrollToBottom(true);
      // 正常结束 / 出错 / 用户主动停止才清掉续连标记；
      // 刷新、关闭页面导致的中断必须保留，否则刷新后就接不上了
      if (!keepPending && !AI._unloading) aiClearPendingTurn();
      if (typeof aiMaybeAutoTitle === "function") aiMaybeAutoTitle();   // 首轮完成后尝试智能标题
    }
  }

  function aiSavePendingTurn(text, imgs, skillIds, userMsg, runId) {
    if (!ideSettingGet("restoreSession", true)) return;
    let prev = null;
    try { prev = JSON.parse(localStorage.getItem("ide.ai.pendingTurn") || "null"); } catch (_) { prev = null; }
    const keep = (prev && prev.sid === AI.curId) ? prev : {};   // 同一会话的旧记录：合并保留（run_id / userMsg）
    try {
      localStorage.setItem("ide.ai.pendingTurn", JSON.stringify({
        sid: AI.curId,
        text: text || keep.text || "",
        imgs: (imgs && imgs.length) ? imgs.slice(0, 10) : (keep.imgs || []),
        skills: (skillIds && skillIds.length) ? skillIds.slice() : (keep.skills || []),
        userMsg: userMsg || keep.userMsg || null,   // 轻量备份：防止后端 flush 未完成时刷新导致用户消息丢失
        // 后台运行 id：刷新后据此重连、回放实时进度。显式传空串＝新一轮（清掉旧 id）；
        // 完全不传（undefined）＝沿用旧值（重连过程中保存时用）。
        runId: (runId === undefined) ? (keep.runId || "") : (runId || ""),
        ts: Date.now()
      }));
    } catch (_) {}
  }
  function aiClearPendingTurn() {
    try { localStorage.removeItem("ide.ai.pendingTurn"); } catch (_) {}
  }
  /* 主动停止当前生成：本地断开事件流 + 通知服务端停止后台运行 */
  function aiHaltRun() {
    AI._userStop = true;                 // 标记「这是用户主动停止」，区别于刷新/关闭页面导致的中断
    if (AI._agentRunId) {
      try {
        fetch("/api/ai/agent/stop", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ run_id: AI._agentRunId }),
        }).catch(() => {});
      } catch (_) {}
    }
    if (AI.ctrl) { try { AI.ctrl.abort(); } catch (_) {} }
  }
  /* 页面被刷新 / 关闭时：卸载会 abort 正在进行的 fetch，
     这个中断必须与「用户点停止」区分开，否则会误清续连标记（刷新后就接不上了） */
  window.addEventListener("pagehide", () => { AI._unloading = true; });
  window.addEventListener("beforeunload", () => { AI._unloading = true; });
  /* 刷新 / 首次加载后：若上一轮还在后台运行，就重连它的进度（回放 + 续传）。
     —— 这样刷新网页不会丢进度，能看到实时进度继续跑。 */
  async function aiResumePendingTurn() {
    if (!AI.curId) return;
    let p = null;
    try { p = JSON.parse(localStorage.getItem("ide.ai.pendingTurn") || "null"); } catch (_) { p = null; }
    if (!p || p.sid !== AI.curId) return;
    let last = AI.msgs[AI.msgs.length - 1];
    if (!last || last.role !== "user") {
      // 最后一条不是用户消息：可能是「回复已落库（本轮已完成）」或「用户消息还没落库」。
      // 用 pendingTurn 里备份的 userMsg.ts 判断用户消息是否真的缺失 —— 只有真缺失才补回，
      // 否则会把同一个提问重复插一条（之前「同一问题显示两遍」就是这个原因）。
      const um = p.userMsg || {};
      const umMissing = um.ts ? !AI.msgs.some(m => m && m.role === "user" && m.ts === um.ts) : !um.text;
      if (!umMissing) { aiClearPendingTurn(); return; }     // 提问已在，说明本轮已结束/已被处理
      const imgs = (p.imgs || []).slice();
      AI.msgs.push({
        role: "user", pid: aiNewPid(),
        text: um.text || "",
        ts: um.ts || Date.now(),
        imgs: imgs.length || undefined,
        images: imgs.length ? imgs : undefined,
        files: um.files && um.files.length ? um.files : undefined,
        skills: um.skills && um.skills.length ? um.skills : undefined,
      });
      aiPersistCurrent(); aiRenderConv();
      last = AI.msgs[AI.msgs.length - 1];
    }
    if (!last || last.role !== "user") { aiClearPendingTurn(); return; }
    // 找可以重连的后台运行：① 本地记录的 run_id ② 丢了就按会话 id 向服务端问
    let runId = p.runId || "", done = false, found = false;
    if (runId) {
      let st = null;
      try {
        st = await (await fetch("/api/ai/agent/status?run_id=" + encodeURIComponent(runId))).json();
      } catch (_) { st = null; }
      if (st && st.exists) { found = true; done = !!st.done; }
    }
    if (!found) {
      let st = null;
      try {
        st = await (await fetch("/api/ai/agent/for-session?sid=" + encodeURIComponent(AI.curId))).json();
      } catch (_) { st = null; }
      if (st && st.exists && st.run_id) { runId = st.run_id; done = !!st.done; found = true; }
    }
    console.info("[AI] 刷新续接：", { runId: runId, found: found, done: done, localRunId: p.runId || "" });
    if (found) {
      if (aiMsgIndexOfPid("m" + runId) >= 0) {  // 这一轮的回复已在列表里（已落库）：不再回放，避免出现两条一样的
        aiClearPendingTurn();
        return;
      }
      if (done) {                               // 后台已结束：直接从会话历史拉最新内容重绘（最可靠，不会卡在「思考中」）
        toast("已取回上一次任务的结果…", "info");
        setTimeout(async () => {
          let got = false;
          for (let k = 0; k < 4; k++) {         // 等服务端把回复落库（刚结束时可能有几百毫秒延迟）
            try { await aiFetchSession(AI.curId); } catch (_) {}
            const s = AI.sessions.find(x => x.id === AI.curId);
            if (s && s.msgs) AI.msgs = s.msgs;
            if (aiMsgIndexOfPid("m" + runId) >= 0) { got = true; break; }
            await new Promise(r => setTimeout(r, 500));
          }
          if (got) {
            aiRenderAll(); aiRenderConv(); aiTodoFloatSyncFromMsgs();
            aiClearPendingTurn();
          } else {                              // 服务端还没落库（少见）：退回按 run_id 回放
            try {
              await aiSend({ text: p.text || "", imgs: p.imgs || [], skills: p.skills || [], resumeRunId: runId });
            } catch (e) { console.warn("[AI] 重连失败：", e); }
          }
        }, 50);
        return;
      }
      toast("已重新连接后台任务，正在同步实时进度…", "info");   // 还在跑：回放 + 实时续传
      setTimeout(() => aiSend({ text: p.text || "", imgs: p.imgs || [], skills: p.skills || [],
                                resumeRunId: runId }), 50);
      return;
    }
    if (p.runId) {
      aiClearPendingTurn();                    // 后台运行已不在（服务重启 / 已过期）：不重复执行，避免副作用
      toast("上一次任务已结束；如需继续请重新发送", "warn");
      return;
    }
    // 兼容旧数据（没有 run_id）且服务端也没记录：沿用原「重发」行为
    //  slight delay so UI is fully mounted after toggleAI
    setTimeout(() => aiSend({ text: p.text || "", imgs: p.imgs || [], skills: p.skills || [] }), 50);
  }

  // 注意：不能直接把 aiSend 当回调——aiSend(reuse) 的第一个参数会被当成「重新生成」参数，
  // 结果点击发送按钮会走 reuse 分支（不插入用户消息、不清空输入框）
  $("aiSend").addEventListener("click", () => aiSend());
  $("aiText").addEventListener("keydown", (e) => {
    // 发送快捷键由「设置 → 对话 → 发送消息」控制：默认 Enter 发送；切到 Ctrl/⌘+Enter 后 Enter 换行
    const needsCtrl = (typeof chatSendNeedsCtrl === "function") ? chatSendNeedsCtrl() : false;
    if (e.key === "Enter" && !e.shiftKey && (needsCtrl ? (e.ctrlKey || e.metaKey) : true)) {
      e.preventDefault(); aiSend();
    }
  });
  // 文件 / 图片芯片上的「×」：按下即移除（阻止默认行为，避免把输入框焦点抢走、光标乱跳）
  $("aiText").addEventListener("mousedown", (e) => {
    const x = e.target.closest(".ai-tag-x");
    if (!x) return;
    e.preventDefault(); e.stopPropagation();
    const chip = x.closest(".ai-tag-file, .ai-tag-img");
    if (chip) { aiHideImgTip(); chip.remove(); }
  });
  $("aiText").addEventListener("click", (e) => {          // 输入框里的 @技能 标签：点击查看/修改
    const tag = e.target.closest(".ai-tag");
    if (tag && tag.dataset.id) { e.preventDefault(); aiOpenSkillEditPop(tag.dataset.id, tag); }
  });
  $("aiText").addEventListener("input", () => { aiRenderActiveSkills(); aiHideImgTip(); });   // 输入变化时刷新激活技能并收起图片预览
  // 标题栏「当前激活技能」：点击展开列表，点外部关闭
  $("aiActiveSkillsBtn").addEventListener("click", (e) => {
    e.stopPropagation();
    const pop = $("aiActiveSkillsPop");
    const show = pop.style.display === "none";
    if (show) aiBuildActiveSkillsPop(aiActiveSkillsList());
    pop.style.display = show ? "" : "none";
  });
  document.addEventListener("click", (e) => {
    const pop = $("aiActiveSkillsPop");
    if (pop && pop.style.display !== "none" && !e.target.closest(".ai-hsk-wrap")) pop.style.display = "none";
  });
  aiLoadSessions().then(() => aiResumePendingTurn().catch(e => console.error("[AI] 刷新续接失败：", e)));
  aiRenderActiveSkills();
  try { if (localStorage.getItem("ide.ai.open") === "1") toggleAI(true); } catch (_) {}



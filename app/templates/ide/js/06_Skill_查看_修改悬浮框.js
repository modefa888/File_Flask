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
      aiSend({ text: u.text || "", imgs: (u.images || []).slice(), skills: (u.skills || []).slice() });
      return;
    }
    const rt = e.target.closest(".ai-mretry");            // 重新提问（保留上下文再试一次）
    if (rt) {
      if (AI.busy) { toast("正在回复中，请先停止", "warn"); return; }
      const mi = +rt.dataset.mi;
      const u = AI.msgs[mi - 1];
      if (!u || u.role !== "user") { toast("找不到原始提问，无法重新提问", "warn"); return; }
      aiSend({ text: u.text || "", imgs: (u.images || []).slice(), skills: (u.skills || []).slice() });
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
  function aiRecordStat(ok, ms, chars, ttft, inTok) {     // 每次请求统计（参考 Trae 底部状态栏）
    const s = AI.sessions.find(x => x.id === AI.curId);
    if (!s) return;
    s.stats = s.stats || { total: 0, ok: 0, msSum: 0, msLast: 0, tokLast: 0, ttftSum: 0, ttftN: 0, inSum: 0, outSum: 0 };
    const st = s.stats;
    st.total++;
    if (ok) st.ok++;
    st.msSum = (st.msSum || 0) + Math.round(ms || 0);      // || 0 兜底：旧版 stats 无这些字段（undefined/NaN）也能自愈
    st.msLast = Math.round(ms || 0);
    st.tokLast = Math.ceil((chars || 0) / 2);
    if (ttft > 0) { st.ttftSum = (st.ttftSum || 0) + ttft; st.ttftN = (st.ttftN || 0) + 1; }
    st.inSum = (st.inSum || 0) + Math.round(inTok || 0);
    if (ok) st.outSum = (st.outSum || 0) + st.tokLast;
    aiPersistCurrent();
    aiRenderStats();
    aiUpdateCtxRing();   // 上下文占用圆环：显示当前会话累计（inSum + outSum）
  }
  function aiRenderStats() {                              // 面板最底部总览状态栏
    const el = $("aiStats");
    if (!el) return;
    const s = AI.sessions.find(x => x.id === AI.curId);
    const st = s && s.stats;
    const memLen = (s && s.mem || "").length;
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
      parts.push('输入 ~' + fmtK(st.inSum || 0) + ' tok · 输出 ~' + fmtK(st.outSum || 0) + ' tok');
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
    if (AI.busy && AI.ctrl) AI.ctrl.abort();     // 切换前停止正在生成的回复
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
    if (AI.busy && AI.ctrl) AI.ctrl.abort();
    aiPersistCurrent();                          // 保存上一个会话
    AI.curId = "s" + Date.now().toString(36);
    AI.msgs = [];
    AI.files = [];                               // 新对话不继承上一个对话附加的文件
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
  $("aiStop").addEventListener("click", () => { if (AI.ctrl) AI.ctrl.abort(); });

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
  };
  const AI_TOOL_ICON = {
    read_file: "bi-file-earmark-text", write_file: "bi-file-earmark-plus", edit_file: "bi-pencil-square",
    list_dir: "bi-folder2-open", search_files: "bi-search", run_command: "bi-terminal",
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

  /* 需要用户确认的调用（例如执行命令） */
  function aiAskCard(ev, runId) {
    const row = document.createElement("div");
    row.className = "ai-ask";
    row.innerHTML = '<div class="q"><i class="bi bi-terminal"></i> <code></code></div>' +
      '<div class="r"></div><div class="btns">' +
      '<button class="ok">允许执行</button>' +
      '<button class="all">本次会话都允许</button>' +
      '<button class="no">拒绝</button></div>';
    const args = ev.args || {};
    row.querySelector("code").textContent = args.command || args.path || JSON.stringify(args);
    row.querySelector(".r").textContent = ev.reason || "需要你确认后才会执行";
    const decide = (allow, always) => {
      fetch("/api/ai/agent/approve", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ run_id: runId, call_id: ev.call_id, allow: allow, always: always }),
      }).catch(() => {});
      row.classList.add(allow ? "allowed" : "denied");
      row.querySelector(".btns").remove();
      row.querySelector(".r").textContent = allow ? "已允许执行" : "已拒绝执行";
    };
    row.querySelector(".ok").onclick = () => decide(true, false);
    row.querySelector(".all").onclick = () => decide(true, true);
    row.querySelector(".no").onclick = () => decide(false, false);
    return row;
  }

  /* 运行智能体：解析 SSE（步骤 / 确认 / 流式回答），返回 { text, steps }
     过程记录统一收进「AI 消息下方」的一个折叠区域，默认只占一行。 */
  async function aiRunAgent(payload, bodyB, onDelta) {
    const msgsBox = $("aiMsgs");
    const bodyRow = bodyB.parentElement;
    const stepMeta = new Map();          // call_id -> {tool, args}
    const rows = new Map();              // call_id -> 步骤行
    const steps = [];
    const changes = [];                  // 本次 AI 回复产生的文件改动 id（供回撤）
    AI._agentTurnChanges = changes;      // 中断时也能拿到已产生的改动，供回撤按钮使用
    let stepsBox = null;
    const ensureStepsBox = () => {
      if (!stepsBox) {
        stepsBox = aiBuildStepsBox([]);
        bodyRow.appendChild(stepsBox);               // 追加在 AI 气泡/元信息之后（即消息下面）
      }
      return stepsBox;
    };
    let runId = "", text = "";
    const r = await fetch("/api/ai/agent", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload), signal: AI.ctrl.signal,
    });
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
          } else if (e.type === "subagent") {
            // 子 Agent 实时进度：渲染到对应的 delegate_task 步骤行内
            aiSubStepEvent(rows.get(e.call_id), e.event);
          } else if (e.type === "error") {
            throw new Error(e.error);
          }
        }
      }
      aiScrollToBottom(true);
    }
    if (stepsBox) { stepsBox._pending = 0; stepsBox._paint(); stepsBox._setCollapsed(true); }  // 本轮结束：自动折叠为一行
    return { text: text, steps: steps, changes: changes };
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
  async function aiAttachOne(path, name, isDir, opts) {
    opts = opts || {};
    if (!Array.isArray(AI.files)) AI.files = [];
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
    const t = $("aiText"); if (t) t.focus();   // 焦点给输入框，直接接着提问
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
      if (r.ok) { added.push(!!it.isDir); continue; }
      if (r.reason === "dup") { dup.push(it.name); continue; }
      if (r.reason === "limit") { hitLimit = true; break; }   // 已达上限，后面的都放不下，不必再读
      bad.push(r.msg || (it.name + "（不支持的类型）"));   // r.msg 里已含条目名，不再重复拼接
    }
    if (added.length) {
      aiRenderFiles();
      const t = $("aiText"); if (t) t.focus();   // 焦点给输入框，直接接着提问
    }
    if (bad.length) console.warn("[AI] 以下条目未能加入对话：", bad);
    const nDir = added.filter(Boolean).length, nFile = added.length - nDir;
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
    const box = $("aiFiles");
    if (!box) return;
    const list = AI.files || [];
    box.style.display = list.length ? "" : "none";
    box.innerHTML = "";
    list.forEach((f, i) => {
      const chip = document.createElement("span");
      chip.className = "ai-file-chip" + (f.isDir ? " is-dir" : "");
      chip.title = f.path + (f.isDir ? "（目录结构，点击在资源管理器中定位）" : "（点击打开，× 移除）");
      chip.innerHTML = '<i class="bi ' + (f.isDir ? "bi-folder2" : "bi-file-earmark-text") +
        '"></i><span class="nm"></span>';
      chip.querySelector(".nm").textContent = f.name;
      const rm = document.createElement("button");
      rm.className = "rm"; rm.title = "从对话中移除"; rm.textContent = "×";
      rm.addEventListener("click", (e) => { e.stopPropagation(); AI.files.splice(i, 1); aiRenderFiles(); });
      chip.appendChild(rm);
      // 文件夹没有可打开的编辑器标签，改成在资源管理器里展开定位
      chip.addEventListener("click", () => {
        if (!f.isDir) { openFile(f.path, f.name); return; }
        if (typeof revealInTree === "function") revealInTree(f.path);
      });
      box.appendChild(chip);
    });
    // 卡片出现/消失会改变输入框高度：消息列表原本贴底时保持贴底，避免最后一条被挤出可视区
    aiScrollToBottom();
  }
  function aiBuildContext() {
    let out = "";
    if (AI.ctx && active && active.cm) {       // 「附带当前文件」开关
      let text = active.cm.getValue();
      if (text.length > 6000) text = text.slice(0, 6000) + "\n…（内容过长已截断）";
      out += "\n\n【参考：当前打开文件 " + active.name + "】\n```\n" + text + "\n```";
    }
    (AI.files || []).forEach(f => {            // 从资源管理器附加进来的文件 / 文件夹
      if (!f.text) return;
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
  function aiAddImgs(fileList) {
    const files = Array.from(fileList || []).filter(f => f.type && f.type.startsWith("image/"));
    files.forEach(f => {
      if (AI.pending.length >= 6) { toast("最多同时附带 6 张图片", "warn"); return; }
      const rd = new FileReader();
      rd.onload = () => {
        aiMaybeDownscale(rd.result).then(u => { AI.pending.push(u); aiRenderPending(); });
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

  async function aiSend(reuse) {                          // reuse={text,imgs}：重新生成，不重复 push 用户消息
    if (AI.busy) return;
    let rawText, text, imgs, skillIds = [];
    if (reuse) {
      rawText = reuse.text || "";
      text = rawText;
      imgs = (reuse.imgs || []).slice();
      skillIds = (reuse.skills || []).slice();      // 重新生成时沿用原消息的 Skill
    }
    else {
      const ta = $("aiText");
      rawText = ta.innerText || "";
      const parsed = aiParseSkillTags(rawText);
      skillIds = parsed.ids;
      // 输入框里的 @技能 标签带 data-id：改名后也能准确识别
      ta.querySelectorAll(".ai-tag[data-id]").forEach(t => {
        const id = t.dataset.id;
        if (id && !skillIds.includes(id)) skillIds.push(id);
      });
      text = parsed.text;
      imgs = AI.pending.slice();
      if (!text && !imgs.length) return;
    }
    await aiLoadCfg();
    const pick = aiCurrentPick();
    const prov = pick.prov;
    if (!prov || !pick.model) {
      aiOpenSettings();
      toast("请先在 设置 → AI 助手 里添加接口（地址 / API Key / 模型列表）", "warn");
      return;
    }
    $("aiEmpty") && ($("aiEmpty").style.display = "none");
    let userMsgForPending = null;
    if (!reuse) {
      const userText = text || (imgs.length ? "（见图）" : "");
      const attFiles = (AI.files || []).map(f => f.isDir ? f.name + "/" : f.name);   // 本条消息附带的文件 / 文件夹（消息上方显示）
      const userMsg = { role: "user", pid: aiNewPid(), text: userText, ts: Date.now(),
                        imgs: imgs.length || undefined,
                        images: imgs.length ? imgs : undefined,
                        files: attFiles.length ? attFiles : undefined,
                        skills: skillIds.length ? skillIds : undefined };
      AI.msgs.push(userMsg);
      userMsgForPending = { text: userText, ts: userMsg.ts, files: attFiles, skills: skillIds };
      const ub = aiBubble("user", userText, "", imgs, false, attFiles);
      ub.parentElement.insertAdjacentHTML("beforeend", aiUserMetaHtml(AI.msgs[AI.msgs.length - 1], AI.msgs.length - 1));
      $("aiText").innerHTML = "";
      AI.pending = [];
      aiRenderPending();
      aiRenderActiveSkills();
    }
    aiPersistCurrent(); aiRenderConv();
    aiSavePendingTurn(text, imgs, skillIds, userMsgForPending);   // 记录本轮生成：刷新后可自动续接

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
    let turnChanges = [];                                 // 本轮 AI 产生的文件改动 id（供回撤）
    let turnDone = false;                                 // 回复已入列：之后收尾出错不再覆盖/重复插入
    AI._agentTurnChanges = [];
    AI._agentRunId = "";                                  // 本场运行的 id（停止后补拉变更用）
    AI.ctrl = new AbortController();
    try {
      if (AI.agent) {                                     // 智能体模式：走带工具的 Agent 接口
        const res = await aiRunAgent({
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
          bodyB.innerHTML = aiMd(t) + '<span class="ai-cursor"></span>';
        });
        acc = res.text || "";
        turnChanges = (res.changes && res.changes.length) ? res.changes : (AI._agentTurnChanges || []);
        bodyB.innerHTML = aiMd(acc) || "（已完成，未产生文字说明）";
        const aMeta = { ms: Math.round(performance.now() - t0), ts: Date.now() };
        AI.msgs.push({ role: "assistant", pid: aiNewPid(), text: acc, ms: aMeta.ms, ts: aMeta.ts,
                       steps: res.steps.length ? res.steps : undefined,
                       changes: turnChanges.length ? turnChanges : undefined });
        bodyB.insertAdjacentHTML("afterend", aiMetaHtml(AI.msgs[AI.msgs.length - 1], AI.msgs.length - 1));
        turnDone = true;                                // 回复已落定：后续收尾出错只提示，不覆盖
        aiAppendChangesBox(bodyB.parentElement, AI.msgs[AI.msgs.length - 1], AI.msgs.length - 1);
        aiPersistCurrent(); aiRenderConv();
        aiRecordStat(true, aMeta.ms, acc.length, ttft, inTok);
        return;
      }
      const r = await fetch("/api/ai/chat", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload), signal: AI.ctrl.signal,
      });
      if (!r.ok) {
        let msg = "HTTP " + r.status;
        try { msg = (await r.json()).error || msg; } catch (_) {}
        throw new Error(msg);
      }
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      // 普通对话也会调用读取类工具：把过程记录渲染在消息下方
      const chatSteps = [], chatStepRows = new Map(), chatStepMeta = new Map();
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
        bodyB.innerHTML = aiMd(acc.replace(/^\s+/, "")) + '<span class="ai-cursor"></span>';   // 边流边渲染 MD
        aiScrollToBottom();
      }
      if (chatStepsBox) { chatStepsBox._pending = 0; chatStepsBox._paint(); chatStepsBox._setCollapsed(true); }  // 本轮结束：自动折叠为一行
      const out = acc.replace(/^\s+/, "");
      bodyB.innerHTML = aiMd(out) || (chatSteps.length ? "（已完成工具调用）" : "（空回复）");
      thinkB.parentElement.style.display = thinking.trim() ? "" : "none";
      const meta = { ms: Math.round(performance.now() - t0), ts: Date.now() };
      AI.msgs.push({ role: "assistant", pid: aiNewPid(), text: out, reasoning: thinking.trim() || undefined,
                     ms: meta.ms, ts: meta.ts, steps: chatSteps.length ? chatSteps : undefined,
                     changes: turnChanges.length ? turnChanges : undefined });
      bodyB.insertAdjacentHTML("afterend", aiMetaHtml(AI.msgs[AI.msgs.length - 1], AI.msgs.length - 1));
      turnDone = true;                                  // 回复已落定：后续收尾出错只提示，不覆盖
      aiAppendChangesBox(bodyB.parentElement, AI.msgs[AI.msgs.length - 1], AI.msgs.length - 1);
      aiPersistCurrent(); aiRenderConv();
      aiRecordStat(true, performance.now() - t0, out.length, ttft, inTok);
    } catch (e) {
      console.error("AI 回复处理出错：", e);
      if (turnDone) {                                   // 回复已成功入列：只提示，不覆盖已完成的回复
        toast("回复已完成，但界面更新出错：" + (e.message || e), "warn");
      } else if (e.name === "AbortError") {
        bodyB.innerHTML = aiMd(acc.replace(/^\s+/, "")) + "\n（已停止）";
        const out = acc.trim();
        const ab0 = turnChanges.length ? turnChanges : (AI._agentTurnChanges || []);
        const finalizeAbort = (abChanges) => {
          if (out || abChanges.length) {                  // 即使没有文字，只要改过文件也保留模块与回撤
            const meta = { ms: Math.round(performance.now() - t0), ts: Date.now() };
            AI.msgs.push({ role: "assistant", pid: aiNewPid(), text: out, ms: meta.ms, ts: meta.ts,
                           changes: abChanges.length ? abChanges : undefined });
            bodyB.insertAdjacentHTML("afterend", aiMetaHtml(AI.msgs[AI.msgs.length - 1], AI.msgs.length - 1));
            turnDone = true;
            aiAppendChangesBox(bodyB.parentElement, AI.msgs[AI.msgs.length - 1], AI.msgs.length - 1);
            aiPersistCurrent(); aiRenderConv();
          }
          aiRecordStat(false, performance.now() - t0, acc.length, ttft, inTok);
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
      } else {
        bodyB.classList.remove("ai-md");
        const errText = "出错了：" + e.message;
        bodyB.textContent = errText;
        bodyB.classList.add("err");
        const meta = { ms: Math.round(performance.now() - t0), ts: Date.now(), err: true };
        const errChanges = (turnChanges.length ? turnChanges : (AI._agentTurnChanges || []));
        AI.msgs.push({ role: "assistant", pid: aiNewPid(), text: errText, err: true, ms: meta.ms, ts: meta.ts,
                       changes: errChanges.length ? errChanges : undefined });
        bodyB.insertAdjacentHTML("afterend", aiMetaHtml(AI.msgs[AI.msgs.length - 1], AI.msgs.length - 1));
        aiAppendChangesBox(bodyB.parentElement, AI.msgs[AI.msgs.length - 1], AI.msgs.length - 1);
        aiPersistCurrent(); aiRenderConv();
        aiRecordStat(false, performance.now() - t0, 0, ttft, inTok);
      }
    } finally {
      AI.busy = false; AI.ctrl = null;
      $("aiSend").style.display = ""; $("aiStop").style.display = "none";
      aiScrollToBottom(true);
      aiClearPendingTurn();   // 无论成功/失败/停止，本轮已结束
      if (typeof aiMaybeAutoTitle === "function") aiMaybeAutoTitle();   // 首轮完成后尝试智能标题
    }
  }

  function aiSavePendingTurn(text, imgs, skillIds, userMsg) {
    if (!ideSettingGet("restoreSession", true)) return;
    try {
      localStorage.setItem("ide.ai.pendingTurn", JSON.stringify({
        sid: AI.curId,
        text: text || "",
        imgs: (imgs || []).slice(0, 10),
        skills: (skillIds || []).slice(),
        userMsg: userMsg || null,                 // 轻量备份：防止后端 flush 未完成时刷新导致用户消息丢失
        ts: Date.now()
      }));
    } catch (_) {}
  }
  function aiClearPendingTurn() {
    try { localStorage.removeItem("ide.ai.pendingTurn"); } catch (_) {}
  }
  function aiResumePendingTurn() {
    if (!AI.curId) return;
    let p = null;
    try { p = JSON.parse(localStorage.getItem("ide.ai.pendingTurn") || "null"); } catch (_) { p = null; }
    if (!p || p.sid !== AI.curId) return;
    let last = AI.msgs[AI.msgs.length - 1];
    // 后端 flush 有 300ms 防抖：刷新时用户消息可能还没落库，从 localStorage 补回
    if ((!last || last.role !== "user") && p.userMsg) {
      const um = p.userMsg;
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
    if (!last || last.role !== "user") return;
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
  $("aiText").addEventListener("click", (e) => {          // 输入框里的 @技能 标签：点击查看/修改
    const tag = e.target.closest(".ai-tag");
    if (tag && tag.dataset.id) { e.preventDefault(); aiOpenSkillEditPop(tag.dataset.id, tag); }
  });
  $("aiText").addEventListener("input", () => aiRenderActiveSkills());   // 输入变化时刷新标题栏激活技能
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
  aiLoadSessions().then(() => aiResumePendingTurn());
  aiRenderActiveSkills();
  try { if (localStorage.getItem("ide.ai.open") === "1") toggleAI(true); } catch (_) {}



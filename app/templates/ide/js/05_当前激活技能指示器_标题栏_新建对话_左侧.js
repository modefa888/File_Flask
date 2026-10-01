  /* ===== 当前激活技能指示器（标题栏「新建对话」左侧） ===== */
  function aiActiveSkillIdsFromInput() {
    const ta = $("aiText");
    if (!ta) return [];
    const ids = (aiParseSkillTags(ta.innerText || "").ids || []).slice();
    ta.querySelectorAll(".ai-tag[data-id]").forEach(t => {
      const id = t.dataset.id;
      if (id && !ids.includes(id)) ids.push(id);
    });
    return ids;
  }
  /* 当前会话最近一条提问激活的技能（发送后仍能显示本轮激活技能） */
  function aiSessionSkillIds() {
    for (let i = AI.msgs.length - 1; i >= 0; i--) {
      const m = AI.msgs[i];
      if (m.role === "user") return (m.skills || []).slice();
    }
    return [];
  }
  function aiActiveSkillsList() {
    const ids = aiActiveSkillIdsFromInput();
    aiSessionSkillIds().forEach(id => { if (!ids.includes(id)) ids.push(id); });
    return ids.map(id => aiFindSkill(id)).filter(Boolean);
  }
  function aiCloseActiveSkillsPop() {
    const pop = $("aiActiveSkillsPop");
    if (pop) pop.style.display = "none";
  }
  function aiBuildActiveSkillsPop(list) {
    const pop = $("aiActiveSkillsPop");
    if (!pop) return;
    pop.innerHTML = "";
    if (!list.length) {
      const e = document.createElement("div");
      e.className = "empty"; e.textContent = "当前没有激活技能";
      pop.appendChild(e);
      return;
    }
    const inputIds = aiActiveSkillIdsFromInput();
    const g = document.createElement("div");
    g.className = "g"; g.textContent = "已激活的技能（输入框中的可点 × 移除）";
    pop.appendChild(g);
    list.forEach(s => {
      const it = document.createElement("div");
      it.className = "ai-hsk-item";
      const inInput = inputIds.includes(s.id);
      it.innerHTML = '<i class="bi ' + esc(s.icon || "bi-stars") + '"></i><span class="t"></span>' +
        (inInput
          ? '<button class="x" title="从输入框移除"><i class="bi bi-x-lg"></i></button>'
          : '<span class="sent" title="已随最近一条提问发送"><i class="bi bi-check2"></i></span>');
      const tEl = it.querySelector(".t");
      tEl.textContent = s.name;
      const x = it.querySelector(".x");
      if (x) x.addEventListener("click", (e) => { e.stopPropagation(); aiRemoveActiveSkill(s); });
      pop.appendChild(it);
    });
    if (inputIds.length) {
      const clr = document.createElement("div");
      clr.className = "ai-hsk-item clr";
      clr.innerHTML = '<i class="bi bi-eraser"></i><span class="t">清空输入框中的技能标签</span>';
      clr.addEventListener("click", () => aiClearActiveSkills());
      pop.appendChild(clr);
    }
  }
  /* 从输入框里移除某个技能：删掉它的 DOM 标签，并清掉手打的 @名称 文本 */
  function aiStripSkillText(name) {
    const ta = $("aiText");
    if (!ta || !name) return;
    const re = new RegExp("(^|[^A-Za-z0-9_@.])@(" + _escapeRegExp(name) + ")(?=\\s|$|[" + _escapeRegExp(_SKILL_PUNC) +
      "])|\\[Skill:" + _escapeRegExp(name) + "\\]", "g");
    const walker = document.createTreeWalker(ta, NodeFilter.SHOW_TEXT, null);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach(node => {
      if (node.parentElement && node.parentElement.classList && node.parentElement.classList.contains("ai-tag")) return;
      const nv = node.nodeValue;
      if (nv && (nv.indexOf("@") >= 0 || nv.indexOf("[Skill:") >= 0)) {
        node.nodeValue = nv.replace(re, (m, ws) => ws || "");
      }
    });
  }
  function aiRemoveActiveSkill(s) {
    const ta = $("aiText");
    if (ta) ta.querySelectorAll(".ai-tag[data-id]").forEach(t => { if (t.dataset.id === s.id) t.remove(); });
    aiStripSkillText(s.name);
    aiRenderActiveSkills();
  }
  function aiClearActiveSkills() {
    const ta = $("aiText");
    if (!ta) return;
    const list = aiActiveSkillIdsFromInput().map(id => aiFindSkill(id)).filter(Boolean);
    ta.querySelectorAll(".ai-tag[data-id]").forEach(t => t.remove());
    list.forEach(s => aiStripSkillText(s.name));
    aiRenderActiveSkills();
  }
  function aiRenderActiveSkills() {
    const wrap = $("aiActiveSkillsWrap"), nameEl = $("aiActiveSkillsName"), btn = $("aiActiveSkillsBtn");
    if (!wrap || !nameEl || !btn) return;
    const list = aiActiveSkillsList();
    if (!list.length) { wrap.style.display = "none"; aiCloseActiveSkillsPop(); return; }
    wrap.style.display = "";
    const names = list.map(s => s.name);
    nameEl.textContent = names.length <= 2 ? names.join("、") : (names[0] + " 等 " + names.length + " 个");
    btn.title = "当前激活的技能（" + names.length + "）：" + names.join("、");
    const pop = $("aiActiveSkillsPop");
    if (pop && pop.style.display !== "none") aiBuildActiveSkillsPop(list);
  }
  /* 自定义 Skill 导入弹窗：名称 / 描述 / 提示词，结果 {id,name,desc,prompt} 或 null */
  /* 让 AI 根据一句话需求生成 {name, desc, prompt} */
  async function aiGenerateSkill(requirement) {
    const pick = aiCurrentPick();
    if (!pick.prov) throw new Error("尚未配置 AI 接口，无法生成");
    const sys = (
      "你是一名 CodeBuddy Skill 设计师。根据用户的需求，设计一个 Skill 并返回 JSON，不要任何解释或 Markdown 代码块外的内容。" +
      "JSON 必须包含 name（Skill 名称，简短中文）、desc（下拉列表展示用的一句话描述）、prompt（激活该 Skill 时追加到 system prompt 的指令）。" +
      "prompt 应清晰说明 AI 在该 Skill 激活时如何回答，长度适中。"
    );
    const payload = {
      provider_id: pick.prov.id,
      model: pick.model,
      web_search: false,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: requirement },
      ],
    };
    const r = await fetch("/api/ai/chat", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      let msg = "HTTP " + r.status;
      try { msg = (await r.json()).error || msg; } catch (_) {}
      throw new Error(msg);
    }
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "", acc = "";
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
          if (obj.error) throw new Error(obj.error);
          if (obj.delta) acc += obj.delta;
        }
      }
    }
    const text = acc.trim();
    if (!text) throw new Error("AI 未返回内容");
    let jsonText = text;
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (fence) jsonText = fence[1];
    else {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) jsonText = m[0];
    }
    let parsed;
    try { parsed = JSON.parse(jsonText); } catch (e) { throw new Error("AI 返回的内容不是有效 JSON：" + e.message); }
    const name = (parsed.name || "").trim();
    const desc = (parsed.desc || "").trim();
    const prompt = (parsed.prompt || "").trim();
    if (!name || !prompt) throw new Error("AI 返回的 JSON 缺少 name 或 prompt");
    return { name, desc: desc || prompt.slice(0, 40), prompt };
  }

  function uiImportSkill() {
    return new Promise((resolve) => {
      const ov = $("modalOverlay");
      ov.innerHTML =
        '<div class="ide-modal">' +
          '<div class="m-title"><i class="bi bi-plus-circle"></i><span>导入自定义 Skill</span></div>' +
          '<div class="m-body">' +
            '<div class="m-row"><label>需求</label><textarea id="skReq" class="req" placeholder="描述你想让 AI 以什么专长帮你，例如：帮我根据图片生成 3D 模型"></textarea><div class="hint">一句话描述需求，点击「AI 生成」自动填写下方字段。</div></div>' +
            '<div class="m-row"><label>名称</label><input id="skName" placeholder="例如：图片转 3D" autocomplete="off"></div>' +
            '<div class="m-row"><label>描述（可选）</label><input id="skDesc" placeholder="简短描述，用于下拉列表展示" autocomplete="off"></div>' +
            '<div class="m-row"><label>提示词</label><textarea id="skPrompt" placeholder="激活该 Skill 时注入给 AI 的指令…"></textarea><div class="hint">提示词会追加到 system prompt，用于告诉模型当前应具备什么专长。</div></div>' +
          '</div>' +
          '<div class="m-foot"><button class="m-gen" id="skGen">AI 生成</button><button class="m-cancel" id="skCancel">取消</button><button class="m-ok" id="skOk">确定</button></div>' +
        '</div>';
      ov.classList.add("show");
      const rq = $("skReq"), nm = $("skName"), dc = $("skDesc"), pt = $("skPrompt");
      const gen = $("skGen"), ok = $("skOk"), cancel = $("skCancel");
      (rq || ok).focus();
      const close = (v) => { ov.classList.remove("show"); ov.innerHTML = ""; resolve(v); };
      const doOk = () => {
        const name = (nm.value || "").trim();
        const prompt = (pt.value || "").trim();
        if (!name) { toast("请输入 Skill 名称", "warn"); nm.focus(); return; }
        if (!prompt) { toast("请输入提示词", "warn"); pt.focus(); return; }
        const id = "custom_" + Date.now().toString(36);
        const desc = (dc.value || "").trim() || prompt.slice(0, 40);
        close({ id, name, prompt, desc });
      };
      ok.onclick = doOk;
      cancel.onclick = () => close(null);
      gen.onclick = () => {
        const requirement = (rq.value || "").trim();
        if (!requirement) { toast("请先输入需求", "warn"); rq.focus(); return; }
        const pick = aiCurrentPick();
        if (!pick.prov) { toast("尚未配置 AI 接口，无法生成", "warn"); return; }
        gen.disabled = true; gen.textContent = "生成中…";
        ok.disabled = true; cancel.disabled = true;
        aiGenerateSkill(requirement).then((s) => {
          nm.value = s.name; dc.value = s.desc; pt.value = s.prompt;
          toast("已根据需求生成 Skill，请检查后点击确定", "ok");
        }).catch((e) => {
          toast("生成失败：" + e.message, "err");
        }).finally(() => {
          gen.disabled = false; gen.textContent = "AI 生成";
          ok.disabled = false; cancel.disabled = false;
        });
      };
      ov.onmousedown = (e) => { if (e.target === ov) close(null); };
      ov.onkeydown = (e) => {
        if (e.key === "Escape") { e.preventDefault(); close(null); }
        else if (e.key === "Enter" && e.ctrlKey) { e.preventDefault(); doOk(); }
      };
    });
  }
  function aiSkillPrompt(sid) {
    if (!sid) return "";
    const s = aiFindSkill(sid);
    return s ? (s.prompt || "") : "";
  }
  function _escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
  /* 把 @技能名 以带颜色的小标签形式插入到输入框光标处 */
  function aiInsertSkillTag(skill) {
    const ta = $("aiText");
    if (!ta || !skill || !skill.name) return;
    const isCustom = String(skill.id).startsWith("custom_");
    const cls = "ai-tag" + (isCustom ? " custom" : "");
    const html = '<span class="' + cls + '" contenteditable="false" data-id="' + esc(skill.id).replace(/"/g, "&quot;") + '">@' + esc(skill.name) + '</span>&nbsp;';
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
  const _SKILL_PUNC = "，。！？、；：“”‘’（）【】.,;:!?'\"()[]{}";
  /* 从文本中解析出所有已知的 @技能名，返回 { ids: [...], text: 保留标签的原文 } */
  function aiParseSkillTags(raw) {
    const ids = [];
    const allSkills = aiAllSkills();
    const byName = new Map(allSkills.map(s => [s.name, s]));
    const names = allSkills.map(s => s.name).filter(Boolean).sort((a, b) => b.length - a.length);
    if (!names.length) return { ids, text: raw };
    const re = new RegExp("(^|[^A-Za-z0-9_@.])@(" + names.map(_escapeRegExp).join("|") + ")(?=\\s|$|[" + _escapeRegExp(_SKILL_PUNC) + "])", "g");
    let m;
    while ((m = re.exec(raw)) !== null) {
      const skill = byName.get(m[2]);
      if (skill && !ids.includes(skill.id)) ids.push(skill.id);
    }
    return { ids, text: raw };
  }
  /* 把 @技能名 替换成不会和文件引用混淆的 [Skill:名称]，用于发给模型 */
  function aiReplaceSkillTagsForModel(raw) {
    const names = aiAllSkills().map(s => s.name).filter(Boolean).sort((a, b) => b.length - a.length);
    if (!names.length) return raw;
    const re = new RegExp("(^|[^A-Za-z0-9_@.])@(" + names.map(_escapeRegExp).join("|") + ")(?=\\s|$|[" + _escapeRegExp(_SKILL_PUNC) + "])", "g");
    return raw.replace(re, (match, ws, name) => ws + "[Skill:" + name + "]");
  }
  /* 用户消息展示：把 @技能名 / [Skill:名称] 渲染成可点击的 [Skill:名称] 标签 */
  function aiRenderUserText(raw) {
    let out = esc(raw || "");
    const skills = aiAllSkills().filter(s => s.name).sort((a, b) => b.name.length - a.name.length);
    skills.forEach(s => {
      const nm = esc(s.name);
      const chip = '<span class="ai-tag-chip' + (s.builtin ? "" : " custom") +
        '" data-skill-id="' + esc(s.id).replace(/"/g, "&quot;") + '" title="点击查看 / 修改该 Skill">[Skill:' + nm + ']</span>';
      out = out.split("[Skill:" + nm + "]").join(chip);
      const re = new RegExp("(^|[^A-Za-z0-9_@.])@" + _escapeRegExp(nm) + "(?=\\s|$|[" + _escapeRegExp(_SKILL_PUNC) + "])", "g");
      out = out.replace(re, (m, ws) => ws + chip);
    });
    return out;
  }

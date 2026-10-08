  /* ==================================================================
     设置 → 命令安全：把命令校验规则按用途分组，可整组开关，也可加自己的正则。
     匹配到「已启用规则或自定义模式」的命令才会打断用户（终端弹确认条 /
     AI 智能体弹「允许执行」卡片）；关掉某组就等于放行该组命令 —— 直接执行、不再等确认。

     规则本体在 config.EXEC_RULE_GROUPS，开关与自定义正则存在服务端 store.db，
     终端与 AI 智能体共用同一份策略，所以这里改完两边同时生效。
     没有保存按钮：每次改动立即提交完整状态，省掉「改了没生效」的困惑。
     ================================================================== */
  var CMD_GUARD = { data: null, open: {}, busy: false };

  function cgRank(lv) { return lv === "blocked" ? 3 : (lv === "confirm" ? 2 : 1); }
  function cgTitle(s) { return escAttr(s == null ? "" : s).replace(/\n/g, "&#10;"); }

  /* 设置页里的分区骨架，内容由 cmdGuardMountSettings() 拉取后填充 */
  function cmdGuardBuildSectionHTML() {
    return '<div class="set-sec" id="sec-cmdguard" data-kw="命令安全 命令 校验 确认 拦截 危险 白名单 正则 终端 智能体 safety command exec 自动执行">' +
      '<h2 data-kw="命令安全 命令 校验 确认 拦截 危险 白名单">命令安全</h2>' +
      '<div class="set-desc" data-kw="命令安全 命令 校验 确认 拦截 正则 自动执行 终端 智能体" style="margin-bottom:10px;">' +
        '匹配已启用规则或自定义模式的命令需要用户确认；关闭类开关可禁用对应检查 —— ' +
        '关掉后该组命令直接执行，终端不再弹确认条、AI 智能体不再弹「允许执行」卡片。' +
        '标记为硬拦截的规则（删根目录、格式化磁盘这类不可逆操作）始终生效，不受开关影响。' +
      '</div>' +
      '<div id="cgBody"><div class="cg-loading">正在读取规则…</div></div>' +
    '</div>';
  }

  /* ---------- 渲染 ---------- */
  function cgChipsHtml(g, levels) {
    // 同一条说明可能对应多条正则（例如「写入系统目录」），合并成一个标签，正则放进 title
    const merged = [];
    (g.rules || []).forEach(r => {
      const hit = merged.find(x => x.reason === r.reason);
      if (hit) {
        hit.pats.push(r.pattern);
        if (cgRank(r.level) > cgRank(hit.level)) hit.level = r.level;
      } else merged.push({ reason: r.reason, level: r.level, pats: [r.pattern] });
    });
    return merged.map(x =>
      '<span class="cg-chip lv-' + x.level + '" title="' +
        cgTitle((levels[x.level] || x.level) + "：" + x.pats.join("\n")) + '">' +
        (x.level === "blocked" ? '<i class="bi bi-lock-fill"></i>' : "") +
        esc(x.reason) + (x.pats.length > 1 ? " ×" + x.pats.length : "") +
      '</span>').join("");
  }

  function cgGroupHtml(g, levels) {
    const open = !!CMD_GUARD.open[g.id];
    return '<div class="cg-group' + (g.on ? "" : " off") + '" data-gid="' + escAttr(g.id) + '"' +
             ' data-kw="' + cgTitle("命令安全 " + g.name + " " + g.desc) + '">' +
      '<div class="cg-head">' +
        '<i class="bi bi-chevron-' + (open ? "down" : "right") + ' cg-caret"></i>' +
        '<span class="cg-name">' + esc(g.name) + '</span>' +
        '<span class="cg-count" title="该分组共 ' + g.count + ' 条规则">' + g.count + '</span>' +
        (g.lock ? '<span class="cg-lock" title="其中 ' + g.lock + ' 条为硬拦截规则，始终生效，开关不会放行">' +
                  '<i class="bi bi-shield-fill-exclamation"></i>' + g.lock + '</span>' : "") +
        '<label class="set-switch" title="' + (g.on ? "已启用：该组命令会打断确认" : "已关闭：该组命令直接执行") + '">' +
          '<input type="checkbox" class="cg-switch"' + (g.on ? " checked" : "") + '><span></span></label>' +
      '</div>' +
      '<div class="cg-desc">' + esc(g.desc) + '</div>' +
      (open ? '<div class="cg-rules">' + cgChipsHtml(g, levels) + '</div>' : "") +
    '</div>';
  }

  /* 全局放行名单：命令级白名单，跨项目生效（AI 卡片上的「全局允许」会写到这里） */
  function cgAllowHtml(g) {
    const allow = g.allow || [];
    const max = g.allow_max || 200;
    return '<div class="cg-allow">' +
      '<div class="cg-allow-hd"><i class="bi bi-unlock"></i>全局放行名单' +
        '<span class="cg-allow-n" title="已放行 ' + allow.length + ' 条，上限 ' + max + ' 条">' +
          allow.length + ' / ' + max + '</span></div>' +
      '<div class="cg-allow-desc">在 AI 助手的确认卡片上选「全局允许」会把这条命令记到这里：' +
        '之后终端与智能体在<b>任何项目</b>里遇到同一条命令都直接执行、不再弹确认。' +
        '仅精确匹配命令原文（不做正则 / 前缀匹配），移除后该命令会重新需要确认。</div>' +
      (allow.length
        ? allow.map((c, i) =>
            '<div class="cg-arow" data-kw="全局放行 ' + cgTitle(c) + '">' +
              '<code title="' + cgTitle("放行命令：" + c) + '">' + esc(c) + '</code>' +
              '<button class="set-btn cg-allow-del" title="从名单移除，之后该命令会重新需要确认">移除</button>' +
            '</div>').join("")
        : '<div class="cg-allow-empty">名单为空：目前没有任何命令被全局放行</div>') +
      '<div class="cg-allow-add">' +
        '<input type="text" id="cgAllowPat" placeholder="手动添加要放行的命令（精确匹配，如 docker ps）" autocomplete="off" spellcheck="false">' +
        '<button class="set-btn" id="cgAllowAdd">添加</button>' +
      '</div>' +
    '</div>';
  }

  function cmdGuardPaint() {
    const box = $("cgBody");
    const g = CMD_GUARD.data;
    if (!box || !g) return;
    const levels = g.levels || {};
    const groups = g.groups || [];
    const offN = groups.filter(x => !x.on).length;
    const total = groups.reduce((n, x) => n + (x.count || 0), 0);
    let h = "";
    if (!g.env_enabled) {
      h += '<div class="cg-warn"><i class="bi bi-exclamation-triangle"></i>' +
           '服务端已用环境变量关闭命令校验（EXEC_ENFORCE_SAFETY=False），下面的开关不会生效。</div>';
    }
    h +=
      '<div class="set-row" data-kw="命令安全 总开关 启用 校验 确认 拦截 safety 自动执行">' +
        '<div class="set-info"><div class="set-label">启用命令安全检查</div><div class="set-desc">' +
          '关闭后命令不再逐条确认、直接执行' + (offN ? '（另有 ' + offN + ' 个分组已单独关闭）' : "") +
          '；硬拦截规则仍然生效</div></div>' +
        '<label class="set-switch"><input type="checkbox" id="cgMaster"' +
          (g.enabled ? " checked" : "") + '><span></span></label>' +
      '</div>' +
      '<div class="set-row" data-kw="自定义 模式 正则 规则 regex custom 命令安全">' +
        '<div class="set-info"><div class="set-label">自定义模式</div>' +
          '<div class="set-desc">支持正则表达式，匹配到的命令一律需要确认，例如 <code>docker|kubectl</code></div></div>' +
        '<input type="text" id="cgCustomPat" placeholder="例如 docker|kubectl" style="width:190px" autocomplete="off" spellcheck="false">' +
        '<input type="text" id="cgCustomWhy" placeholder="说明（可选）" style="width:110px" autocomplete="off" spellcheck="false">' +
        '<button class="set-btn" id="cgCustomAdd">添加</button>' +
      '</div>';
    if ((g.custom || []).length) {
      h += '<div class="cg-custom">' + g.custom.map((c, i) =>
        '<div class="cg-crow" data-kw="自定义 正则 ' + cgTitle(c.pattern + " " + c.reason) + '">' +
          '<code title="' + cgTitle("正则：" + c.pattern) + '">' + esc(c.pattern) + '</code>' +
          '<span class="cg-why">' + esc(c.reason) + '</span>' +
          '<label class="set-switch" title="' + (c.on ? "已启用" : "已停用") + '">' +
            '<input type="checkbox" class="cg-cust-sw"' + (c.on ? " checked" : "") + '><span></span></label>' +
          '<button class="set-btn cg-del" title="移除这条自定义规则">移除</button>' +
        '</div>').join("") + '</div>';
    }
    h += '<div class="cg-tools">' +
           '<span class="cg-sum">内置规则 ' + total + ' 条 / ' + groups.length + ' 个分组' +
             (offN ? '，已关闭 ' + offN + ' 组' : "") + '</span>' +
           '<button class="set-btn" id="cgToggleAll">' +
             (groups.some(x => CMD_GUARD.open[x.id]) ? "全部收起" : "展开全部") + '</button>' +
         '</div>' +
         '<div class="cg-list">' + groups.map(x => cgGroupHtml(x, levels)).join("") + '</div>';
    h += cgAllowHtml(g);
    box.innerHTML = h;
    cgBind(box);
  }

  /* ---------- 交互 ---------- */
  function cgBind(box) {
    const g = CMD_GUARD.data;

    const master = box.querySelector("#cgMaster");
    if (master) master.onchange = () => {
      g.enabled = master.checked;
      cmdGuardSave(master.checked ? "已启用命令安全检查" : "已关闭命令安全检查：命令将直接执行");
    };

    box.querySelectorAll(".cg-group").forEach(el => {
      const gid = el.dataset.gid;
      const grp = (g.groups || []).find(x => x.id === gid);
      el.querySelector(".cg-head").onclick = (e) => {
        if (e.target.closest(".set-switch")) return;         // 点开关时别顺带收起
        CMD_GUARD.open[gid] = !CMD_GUARD.open[gid];
        cmdGuardPaint();
      };
      const sw = el.querySelector(".cg-switch");
      if (sw) sw.onchange = () => {
        grp.on = sw.checked;
        cmdGuardSave(sw.checked ? "已启用「" + grp.name + "」检查"
                                : "已关闭「" + grp.name + "」检查：该组命令直接执行");
      };
    });

    box.querySelectorAll(".cg-crow").forEach((row, i) => {
      const sw = row.querySelector(".cg-cust-sw");
      if (sw) sw.onchange = () => { g.custom[i].on = sw.checked; cmdGuardSave("自定义规则已更新"); };
      const del = row.querySelector(".cg-del");
      if (del) del.onclick = () => { g.custom.splice(i, 1); cmdGuardSave("已移除自定义规则"); };
    });

    const addBtn = box.querySelector("#cgCustomAdd");
    if (addBtn) {
      const patEl = box.querySelector("#cgCustomPat");
      const whyEl = box.querySelector("#cgCustomWhy");
      const add = () => {
        const pat = (patEl.value || "").trim();
        if (!pat) { toast("请输入要匹配的正则表达式", "warn"); patEl.focus(); return; }
        try { new RegExp(pat); } catch (e) { toast("正则表达式不合法：" + e.message, "err"); patEl.focus(); return; }
        if ((g.custom || []).some(c => c.pattern === pat)) { toast("这条规则已经有了", "warn"); return; }
        if ((g.custom || []).length >= (g.custom_max || 50)) {
          toast("自定义规则最多 " + (g.custom_max || 50) + " 条", "warn"); return;
        }
        g.custom = (g.custom || []).concat([{
          pattern: pat, reason: (whyEl.value || "").trim() || "自定义规则", on: true,
        }]);
        cmdGuardSave("已添加自定义规则");
      };
      addBtn.onclick = add;
      [patEl, whyEl].forEach(el => {
        el.onkeydown = (e) => { e.stopPropagation(); if (e.key === "Enter") add(); };
      });
    }

    box.querySelectorAll(".cg-arow").forEach((row, i) => {
      const del = row.querySelector(".cg-allow-del");
      if (del) del.onclick = () => {
        g.allow.splice(i, 1);
        cmdGuardSave("已从全局放行名单移除");
      };
    });

    const allowAdd = box.querySelector("#cgAllowAdd");
    if (allowAdd) {
      const el = box.querySelector("#cgAllowPat");
      const add = () => {
        const v = (el.value || "").trim();
        if (!v) { toast("请输入要放行的命令", "warn"); el.focus(); return; }
        g.allow = g.allow || [];
        if (g.allow.includes(v)) { toast("这条命令已在放行名单里", "warn"); return; }
        if (g.allow.length >= (g.allow_max || 200)) {
          toast("全局放行名单最多 " + (g.allow_max || 200) + " 条", "warn"); return;
        }
        g.allow.push(v);
        cmdGuardSave("已加入全局放行名单");
      };
      allowAdd.onclick = add;
      el.onkeydown = (e) => { e.stopPropagation(); if (e.key === "Enter") add(); };
    }

    const allBtn = box.querySelector("#cgToggleAll");
    if (allBtn) allBtn.onclick = () => {
      const anyOpen = (g.groups || []).some(x => CMD_GUARD.open[x.id]);
      (g.groups || []).forEach(x => { CMD_GUARD.open[x.id] = !anyOpen; });
      cmdGuardPaint();
    };
  }

  /* ---------- 读写服务端 ---------- */
  function cmdGuardPayload() {
    const g = CMD_GUARD.data || {};
    return {
      enabled: g.enabled !== false,
      off: (g.groups || []).filter(x => !x.on).map(x => x.id),
      custom: (g.custom || []).map(c => ({ pattern: c.pattern, reason: c.reason, on: c.on !== false })),
      allow: (g.allow || []).slice(),          // 全局放行名单（整份覆盖保存）
    };
  }

  async function cmdGuardSave(done) {
    if (CMD_GUARD.busy) return;
    CMD_GUARD.busy = true;
    try {
      const r = await fetch("/api/term/rules", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cmdGuardPayload()),
      });
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      if (d.rules && d.rules.guard) CMD_GUARD.data = d.rules.guard;
      cmdGuardPaint();
      toast(done || "已保存", "ok");
    } catch (e) {
      toast("保存失败：" + (e.message || e), "err");
      cmdGuardLoad();          // 拉回服务端真实状态，避免界面停在「看起来改了其实没存上」
    } finally {
      CMD_GUARD.busy = false;
    }
  }

  async function cmdGuardLoad() {
    const box = $("cgBody");
    if (box && !CMD_GUARD.data) box.innerHTML = '<div class="cg-loading">正在读取规则…</div>';
    try {
      const r = await fetch("/api/term/rules");
      const d = await r.json();
      CMD_GUARD.data = d.guard || { enabled: true, env_enabled: true, levels: {}, groups: [], custom: [] };
      if (!Object.keys(CMD_GUARD.open).length) {           // 首次默认展开前 3 组，免得一屏全是折叠的
        (CMD_GUARD.data.groups || []).slice(0, 3).forEach(g => { CMD_GUARD.open[g.id] = true; });
      }
      cmdGuardPaint();
    } catch (e) {
      if (box) box.innerHTML = '<div class="cg-warn">读取命令安全规则失败：' + esc(e.message || e) + '</div>';
    }
  }

  /* 设置页挂载入口（由 15_设置页.js 调用） */
  function cmdGuardMountSettings(host) {
    if (!host || !host.querySelector("#sec-cmdguard")) return;
    CMD_GUARD.data = null;          // 每次打开设置都重新拉一遍，保证是服务端最新状态
    cmdGuardLoad();
  }

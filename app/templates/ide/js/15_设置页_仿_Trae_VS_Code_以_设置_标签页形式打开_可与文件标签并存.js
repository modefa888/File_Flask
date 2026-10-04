  /* ================================================================
     设置页（仿 Trae / VS Code：以「设置」标签页形式打开，可与文件标签并存）
     ================================================================ */
  const IDE_SETTINGS = Object.assign(
    { fontSize: 13, lineWrap: false, activeLine: true, indent: 4, hints: true,
      showAllFiles: false, gitViewMode: "list", gitCommitFileMode: "tree" },
    (() => { try { return JSON.parse(localStorage.getItem("ide.settings") || "{}"); } catch (_) { return {}; } })()
  );
  function saveIdeSettings() {
    // 合并写入：保留其它模块通过 ideSettingSet 写入的开关键，避免整对象覆盖丢失
    let cur = {};
    try { cur = JSON.parse(localStorage.getItem("ide.settings") || "{}"); } catch (_) { }
    localStorage.setItem("ide.settings", JSON.stringify(Object.assign(cur, IDE_SETTINGS)));
  }
  function applyIdeSettings() {
    document.documentElement.style.setProperty("--cm-font-size", IDE_SETTINGS.fontSize + "px");
    document.body.classList.toggle("hide-nm-hints", !IDE_SETTINGS.hints);
    tabs.forEach(t => {
      if (!t.cm) return;
      t.cm.setOption("lineWrapping", IDE_SETTINGS.lineWrap);
      t.cm.setOption("styleActiveLine", IDE_SETTINGS.activeLine && !t.big);
      t.cm.setOption("indentUnit", IDE_SETTINGS.indent);
      t.cm.setOption("tabSize", IDE_SETTINGS.indent);
      t.cm.refresh();
    });
  }

  const SETTINGS_PATH = "\u0000settings";   // 设置页虚拟路径（不与真实文件冲突）
  function openSettingsTab() {
    let tab = findTab(SETTINGS_PATH);
    if (!tab) {
      const host = document.createElement("div");
      host.className = "cm-host set-host";
      tab = { path: SETTINGS_PATH, displayPath: "设置", name: "设置", host, cm: null,
              original: "", dirty: false, big: false, group: curGroup, isSettings: true };
      tabs.push(tab);
      renderTabsAll();
      buildSettingsContent(host);
    }
    activate(tab);   // 已打开则直接聚焦；正常文件仍可随时打开
  }
  function buildSettingsContent(host) {
    host.innerHTML =
    '<div class="set-layout">' +
      '<div class="set-nav"><h1>设置</h1><input class="set-search" placeholder="搜索设置项" autocomplete="off" spellcheck="false">' +
        '<div class="set-navitem" data-sec="sec-editor"><i class="bi bi-sliders"></i>编辑器</div>' +
        '<div class="set-navitem" data-sec="sec-files"><i class="bi bi-folder2"></i>文件</div>' +
        '<div class="set-navitem" data-sec="sec-keys"><i class="bi bi-keyboard"></i>快捷键</div>' +
        '<div class="set-navitem" data-sec="sec-data"><i class="bi bi-database"></i>数据</div>' +
        '<div class="set-navitem" data-sec="sec-ai"><i class="bi bi-stars"></i>AI 助手</div>' +
        '<div class="set-navitem" data-sec="sec-sysai"><i class="bi bi-cpu"></i>系统 AI</div>' +
        '<div class="set-navitem" data-sec="sec-notify"><i class="bi bi-bell"></i>通知</div>' +
        '<div class="set-navitem" data-sec="sec-git-creds"><i class="bi bi-git"></i>Git 认证</div>' +
      '</div>' +
      '<div class="set-content">' +
        '<div class="set-sec" id="sec-editor"><h2>编辑器</h2>' +
          '<div class="set-row" data-kw="字体 字号 font size"><div class="set-info"><div class="set-label">字体大小</div><div class="set-desc">编辑器代码字体大小（10–24）</div></div><input type="number" min="10" max="24" id="setFontSize"></div>' +
          '<div class="set-row" data-kw="换行 wrap line"><div class="set-info"><div class="set-label">自动换行</div><div class="set-desc">过长的行折行显示，不出现横向滚动条</div></div><input type="checkbox" id="setLineWrap"></div>' +
          '<div class="set-row" data-kw="高亮 当前行 active line"><div class="set-info"><div class="set-label">高亮当前行</div><div class="set-desc">光标所在行加背景色</div></div><input type="checkbox" id="setActiveLine"></div>' +
          '<div class="set-row" data-kw="缩进 tab indent"><div class="set-info"><div class="set-label">缩进空格数</div><div class="set-desc">Tab 与自动缩进的空格宽度</div></div><select id="setIndent"><option value="2">2</option><option value="4">4</option><option value="8">8</option></select></div>' +
        '</div>' +
        '<div class="set-sec" id="sec-files"><h2>文件</h2>' +
          '<div class="set-row" data-kw="显示 全部 依赖 隐藏 node_modules eye"><div class="set-info"><div class="set-label">显示全部文件</div><div class="set-desc">资源管理器中显示依赖目录（node_modules 等）与点开头隐藏文件（.gitignore、.env 等），与「眼睛」图标按钮联动</div></div><input type="checkbox" id="setShowAll"></div>' +
          '<div class="set-row" data-kw="源代码管理 git 视图 树形 列表"><div class="set-info"><div class="set-label">源代码管理视图</div><div class="set-desc">更改文件清单的展示方式</div></div><select id="setGitView"><option value="list">列表（平铺）</option><option value="tree">树形（按目录）</option></select></div>' +
          '<div class="set-row" data-kw="图形 提交 文件 清单 视图 树形 列表"><div class="set-info"><div class="set-label">图形提交文件清单</div><div class="set-desc">「图形」中每个提交的文件展示方式</div></div><select id="setGitCommitMode"><option value="tree">树形（默认）</option><option value="list">列表</option></select></div>' +
          '<div class="set-row" data-kw="提示 注释 命名 hint"><div class="set-info"><div class="set-label">文件树命名提示</div><div class="set-desc">在文件名后显示说明注释（如 README → 项目说明）</div></div><input type="checkbox" id="setHints"></div>' +
        '</div>' +
        '<div class="set-sec" id="sec-keys"><h2 class="set-extra">快捷键</h2>' +
          '<div class="set-desc set-extra" style="margin-bottom:10px;">点击「修改」后按下新组合键即可重新绑定；「清除」禁用该快捷键；冲突时原命令自动禁用。</div>' +
          '<div id="setKeybinds"></div>' +
          '<button class="set-btn set-extra" id="setKbReset" style="margin-top:8px;">恢复默认快捷键</button>' +
          '<h2 style="font-size:15px;margin-top:26px;">系统快捷键（固定）</h2>' +
          '<div class="set-desc" style="margin-bottom:10px;">以下在左侧文件树获得焦点（点击文件树后）时生效：</div>' +
          '<div class="set-keys" id="setSysKeys"></div>' +
        '</div>' +
        '<div class="set-sec" id="sec-data"><h2>数据</h2>' +
          '<div class="set-row" data-kw="最近 打开 记录 清除 recent"><div class="set-info"><div class="set-label">清除最近打开记录</div><div class="set-desc">清空 Quick Open 面板的「最近打开」列表</div></div><button class="set-btn" id="setClearRecent">清除</button></div>' +
          '<div class="set-row" data-kw="默认 重置 设置 reset"><div class="set-info"><div class="set-label">恢复默认设置</div><div class="set-desc">将所有设置项恢复为默认值</div></div><button class="set-btn" id="setReset">重置</button></div>' +
        '</div>' +
        '<div class="set-sec" id="sec-ai"><h2 data-kw="ai 助手 接口 token 模型 api">AI 助手</h2>' +
          '<div class="set-desc" data-kw="ai 助手 接口 token 模型 api" style="margin-bottom:10px;">配置 OpenAI 兼容接口（DeepSeek / SenseNova / OpenAI / Ollama 等），可添加多个。API Key 只保存在服务器本地 data/ 目录，不会回传浏览器。模型列表逗号分隔可填多个，保存后在 AI 面板顶部下拉切换。</div>' +
          '<div class="ai-prov-list" id="aiProvList" data-kw="ai 助手 接口 token 模型 api"></div>' +
          '<div class="ai-set-acts" data-kw="ai 助手 接口 token 模型 api"><button class="ai-set-btn" id="aiProvAdd">+ 添加接口</button><span class="ai-spacer"></span><button class="ai-set-btn primary" id="aiCfgSave">保存全部</button></div>' +
          '<div class="ai-set-tip" id="aiCfgTip"></div>' +
        '</div>' +
        '<div class="set-sec" id="sec-sysai"><h2 data-kw="系统 ai token 接口 模型 提交信息 生成">系统 AI</h2>' +
          '<div class="set-desc" data-kw="系统 ai token 接口 模型 提交信息 生成" style="margin-bottom:10px;">供「生成提交内容」等系统功能使用。与 AI 助手共用同一份接口配置（API Key 只保存在服务器本地），这里只选择用哪个接口与模型；选「跟随 AI 助手」时使用 AI 面板当前选中的接口。</div>' +
          '<div class="set-row" data-kw="系统 ai token 接口 模型 提交信息 生成"><div class="set-info"><div class="set-label">使用的接口 / 模型</div><div class="set-desc">生成提交信息时调用的接口与模型</div></div><select id="sysAiPick"></select></div>' +
          '<div class="ai-set-acts" data-kw="系统 ai token 接口 模型 保存"><span class="ai-spacer"></span><button class="ai-set-btn primary" id="sysAiSave">保存</button></div>' +
          '<div class="ai-set-tip" id="sysAiTip"></div>' +
        '</div>' +

        '<div class="set-sec" id="sec-git-creds" data-kw="git 认证 token 远程仓库 密钥">' +
          '<h2>Git 认证</h2>' +
          '<div class="set-desc" style="margin-bottom:10px;">配置 push / pull / fetch 时的远程仓库认证信息。Token 仅保存在服务器本地，不会回传浏览器。</div>' +
          '<div class="gc-card">' +
            '<div id="gcSummary" class="gc-summary"></div>' +
            '<div class="gc-row">' +
              '<label>认证方式</label>' +
              '<select id="gcType">' +
                '<option value="none">不启用</option>' +
                '<option value="https_token">HTTPS Token</option>' +
              '</select>' +
            '</div>' +
            '<div class="gc-row gc-field" id="gcTokenWrap">' +
              '<label>Personal Access Token</label>' +
              '<input type="password" id="gcToken" placeholder="输入 Token" autocomplete="off" spellcheck="false">' +
              '<div class="gc-hint">' +
                'GitHub 推荐使用 classic token，至少勾选 repo 权限。' +
                '<a class="gc-link" href="https://github.com/settings/tokens/new?scopes=repo&description=File_Flask_IDE" target="_blank" rel="noopener">' +
                  '<i class="bi bi-box-arrow-up-right"></i> 前往 GitHub 创建 Token' +
                '</a>' +
              '</div>' +
            '</div>' +
            '<div class="gc-row gc-field" id="gcUsernameWrap">' +
              '<label>用户名（可选）</label>' +
              '<input type="text" id="gcUsername" placeholder="GitHub 用户名，留空则使用 Token 作为用户名" autocomplete="off" spellcheck="false">' +
            '</div>' +
            '<div class="gc-row gc-field" id="gcHostWrap">' +
              '<label>限定主机（可选）</label>' +
              '<input type="text" id="gcHost" placeholder="例如 github.com，留空则对所有 HTTPS 远程生效" autocomplete="off" spellcheck="false">' +
            '</div>' +
            '<div class="gc-actions">' +
              '<button class="gc-btn secondary" id="gcTest"><i class="bi bi-wifi"></i> 测试认证</button>' +
              '<button class="gc-btn primary" id="gcSave">保存</button>' +
            '</div>' +
            '<div id="gcTip" class="gc-tip"></div>' +
          '</div>' +
        '</div>' +

        notifyBuildSectionHTML() +
      '</div>' +
    '</div>';
    const q = (s) => host.querySelector(s);
    const setSearchInput = q(".set-search");

  const SYS_KEYS = [
    ["重命名", "F2"], ["删除", "Delete"],
    ["打开 / 展开目录", "Enter"], ["在侧边打开", "Ctrl Enter"],
    ["复制文件", "Ctrl C"], ["剪切文件", "Ctrl X"], ["粘贴", "Ctrl V"],
    ["复制绝对路径", "Ctrl Alt C"], ["复制相对路径", "Ctrl Alt Shift C"],
    ["关闭下拉菜单", "Esc"],
  ];

    // ---- 标签页模式：右侧只显示当前选中的分区，其余隐藏，靠左侧导航切换 ----
    let activeSetSec = "sec-editor";   // 默认选中「编辑器」
    function showSettingsSec(secId) {
      activeSetSec = secId;
      host.querySelectorAll(".set-sec").forEach(sec => {
        sec.style.display = (sec.id === secId) ? "" : "none";
      });
      const content = host.querySelector(".set-content");
      if (content) content.scrollTop = 0;   // 切换后回到顶部
    }
    function filterSettingsRows(kw) {
      const k = kw.trim().toLowerCase();
      if (!k) {
        // 搜索清空：恢复所有行，回到「只显示当前分区」的标签页模式
        host.querySelectorAll(".set-row, .set-key, .kb-row, .set-extra").forEach(r => { r.style.display = ""; });
        showSettingsSec(activeSetSec);
        return;
      }
      // 搜索时跨全部分区匹配（不受当前标签限制）
      host.querySelectorAll(".set-row").forEach(r => {
        r.style.display = ((r.dataset.kw || "").includes(k) || r.textContent.toLowerCase().includes(k)) ? "" : "none";
      });
      host.querySelectorAll(".set-key, .kb-row").forEach(r => {
        r.style.display = ((r.dataset.kw || "").includes(k) || r.textContent.toLowerCase().includes(k)) ? "" : "none";
      });
      host.querySelectorAll(".set-extra").forEach(r => {
        r.style.display = r.textContent.toLowerCase().includes(k) ? "" : "none";
      });
      host.querySelectorAll(".set-sec").forEach(sec => {
        const any = [...sec.querySelectorAll(".set-row, .set-key, .kb-row")].some(el => el.style.display !== "none");
        sec.style.display = any ? "" : "none";
      });
    }
    function setNavActive(secId) {
      host.querySelectorAll(".set-navitem").forEach(n => n.classList.toggle("on", n.dataset.sec === secId));
    }
    host.querySelectorAll(".set-navitem").forEach(n => {
      n.onclick = () => {
        showSettingsSec(n.dataset.sec);
        setNavActive(n.dataset.sec);
      };
    });
    setNavActive(activeSetSec);
    showSettingsSec(activeSetSec);   // 初始只显示「编辑器」分区
    setSearchInput.addEventListener("input", () => filterSettingsRows(setSearchInput.value));
    setSearchInput.addEventListener("keydown", e => e.stopPropagation());   // 面板内按键不触发全局快捷键；关闭走标签页 ×
    // 当前值填入（每次重建标签页内容时都会刷新）
    q("#setFontSize").value = IDE_SETTINGS.fontSize;
    q("#setLineWrap").checked = IDE_SETTINGS.lineWrap;
    q("#setActiveLine").checked = IDE_SETTINGS.activeLine;
    q("#setIndent").value = IDE_SETTINGS.indent;
    q("#setHints").checked = IDE_SETTINGS.hints;
    q("#setShowAll").checked = !!IDE_SETTINGS.showAllFiles;
    q("#setGitView").value = IDE_SETTINGS.gitViewMode === "tree" ? "tree" : "list";
    q("#setGitCommitMode").value = IDE_SETTINGS.gitCommitFileMode === "list" ? "list" : "tree";
    q("#setFontSize").addEventListener("change", e => {
      const v = Math.max(10, Math.min(24, parseInt(e.target.value, 10) || 13));
      IDE_SETTINGS.fontSize = v; e.target.value = v; saveIdeSettings(); applyIdeSettings();
    });
    q("#setLineWrap").addEventListener("change", e => { IDE_SETTINGS.lineWrap = e.target.checked; saveIdeSettings(); applyIdeSettings(); });
    q("#setActiveLine").addEventListener("change", e => { IDE_SETTINGS.activeLine = e.target.checked; saveIdeSettings(); applyIdeSettings(); });
    q("#setIndent").addEventListener("change", e => { IDE_SETTINGS.indent = parseInt(e.target.value, 10) || 4; saveIdeSettings(); applyIdeSettings(); });
    q("#setHints").addEventListener("change", e => { IDE_SETTINGS.hints = e.target.checked; saveIdeSettings(); applyIdeSettings(); });
    // 显示全部文件：与资源管理器「眼睛」图标同源（showAllFiles/showHidden），改动即时刷新文件树
    q("#setShowAll").addEventListener("change", e => {
      const on = e.target.checked;
      IDE_SETTINGS.showAllFiles = on;
      saveIdeSettings(); ideSettingSet("showAllFiles", on);
      showAllFiles = on; showHidden = on;
      const btn = $("sideShowAll");
      if (btn) {
        btn.querySelector("i").className = on ? "bi bi-eye" : "bi bi-eye-slash";
        btn.classList.toggle("on", on);
        btn.title = on ? "隐藏全部（依赖目录与隐藏文件）" : "显示全部（含 node_modules、.gitignore 等）";
      }
      refreshTree(ROOT);
    });
    // 源代码管理视图：list/tree，同步头部切换按钮图标并重渲染
    q("#setGitView").addEventListener("change", e => {
      const v = e.target.value === "tree" ? "tree" : "list";
      IDE_SETTINGS.gitViewMode = v;
      saveIdeSettings(); ideSettingSet("gitViewMode", v);
      gitViewMode = v;
      const tg = $("gitViewToggle");
      if (tg) {
        tg.innerHTML = '<i class="bi ' + (v === "tree" ? "bi-list-ul" : "bi-diagram-3") + '"></i>';
        tg.title = v === "tree" ? "切换到列表视图" : "切换到树形视图";
      }
      if (gitState.isRepo && gitState.last) renderGitStatus(gitState.last);
    });
    // 图形提交文件清单：tree/list，改动后重载提交文件列表
    q("#setGitCommitMode").addEventListener("change", e => {
      const v = e.target.value === "list" ? "list" : "tree";
      IDE_SETTINGS.gitCommitFileMode = v;
      saveIdeSettings(); ideSettingSet("gitCommitFileMode", v);
      gitCommitFileMode = v;
      if (typeof reloadCommitLists === "function") reloadCommitLists();
    });
    q("#setClearRecent").onclick = () => { localStorage.removeItem("ide.recentFiles"); toast("已清除最近打开记录", "ok"); };
    q("#setReset").onclick = () => {
      Object.assign(IDE_SETTINGS, { fontSize: 13, lineWrap: false, activeLine: true, indent: 4, hints: true,
        showAllFiles: false, gitViewMode: "list", gitCommitFileMode: "tree" });
      saveIdeSettings(); applyIdeSettings();
      q("#setFontSize").value = 13; q("#setLineWrap").checked = false; q("#setActiveLine").checked = true;
      q("#setIndent").value = 4; q("#setHints").checked = true;
      q("#setShowAll").checked = false; q("#setGitView").value = "list"; q("#setGitCommitMode").value = "tree";
      // 同步重置各开关的运行时状态
      showAllFiles = false; showHidden = false;
      gitViewMode = "list"; gitCommitFileMode = "tree";
      const btn = $("sideShowAll");
      if (btn) { btn.querySelector("i").className = "bi bi-eye-slash"; btn.classList.remove("on"); btn.title = "显示全部（含 node_modules、.gitignore 等）"; }
      const tg = $("gitViewToggle");
      if (tg) { tg.innerHTML = '<i class="bi bi-diagram-3"></i>'; tg.title = "切换到树形视图"; }
      refreshTree(ROOT);
      if (gitState.isRepo && gitState.last) renderGitStatus(gitState.last);
      if (typeof reloadCommitLists === "function") reloadCommitLists();
      toast("已恢复默认设置", "ok");
    };
    // ---- 自定义快捷键：渲染 + 捕获新组合键 ----
    let kbCapture = null;
    const KB_MOD_KEY = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? "Cmd" : "Ctrl";   // Mod 仅内部存储，展示时按平台翻译
    const fmtBind = (b) => b.split(" ").map(p => p === "Mod" ? KB_MOD_KEY : p.replace(/^Mod\+/, KB_MOD_KEY + "+")).join(" ");
    function renderKeybinds() {
      const box = q("#setKeybinds");
      box.innerHTML = KEY_COMMANDS.map(c => {
        const cur = effBind(c);
        const cap = kbCapture === c.id;
        const keysHtml = cap ? '<kbd style="color:#7ab8ff;">按下新组合键…</kbd>'
          : (cur ? fmtBind(cur).split(" ").map(p => "<kbd>" + esc(p) + "</kbd>").join("")
                 : '<span style="color:#777;font-size:11px;">未设置</span>');
        return '<div class="kb-row' + (cap ? " capturing" : "") + '" data-kw="快捷键 ' + esc(c.label) + '">' +
          '<span class="set-label">' + esc(c.label) + '</span><span class="kb-keys">' + keysHtml + '</span>' +
          '<button class="kb-btn" data-kb="' + c.id + '">' + (cap ? "取消" : "修改") + '</button>' +
          (cur ? '<button class="kb-btn" data-kbclr="' + c.id + '">清除</button>' : '') +
        '</div>';
      }).join("");
      box.querySelectorAll("[data-kb]").forEach(b => { b.onclick = () => startKbCapture(b.dataset.kb); });
      box.querySelectorAll("[data-kbclr]").forEach(b => {
        b.onclick = () => { kbCustom[b.dataset.kbclr] = ""; saveKeybinds(); applyKeybinds(); renderKeybinds(); toast("已禁用该快捷键", "ok"); };
      });
    }
    function stopKbCapture() {
      kbCapture = null;
      document.removeEventListener("keydown", kbCaptureHandler, true);
    }
    function kbCaptureHandler(e) {
      e.preventDefault(); e.stopPropagation();
      if (e.key === "Escape") { stopKbCapture(); renderKeybinds(); return; }
      if (["Control", "Meta", "Alt", "Shift"].includes(e.key)) return;   // 只按了修饰键，继续等待
      const parts = [];
      if (e.ctrlKey || e.metaKey) parts.push("Mod");
      if (e.altKey) parts.push("Alt");
      if (e.shiftKey) parts.push("Shift");
      let k = e.key;
      if (k === "+") k = "=";
      if (k === "~") k = "`";
      parts.push(k.toLowerCase());
      const sig = parts.join("+");
      const clash = KEY_COMMANDS.find(c => c.id !== kbCapture && effBind(c) && effBind(c).toLowerCase() === sig.toLowerCase());
      if (clash) { kbCustom[clash.id] = ""; toast("与「" + clash.label + "」冲突，原命令快捷键已禁用", "err"); }
      const target = KEY_COMMANDS.find(c => c.id === kbCapture);
      kbCustom[kbCapture] = sig;
      stopKbCapture(); saveKeybinds(); applyKeybinds(); renderKeybinds();
      toast("「" + target.label + "」已绑定 " + fmtBind(sig), "ok");
    }
    function startKbCapture(id) {
      if (kbCapture === id) { stopKbCapture(); renderKeybinds(); return; }   // 再次点击 = 取消
      if (kbCapture) stopKbCapture();
      kbCapture = id;
      renderKeybinds();
      document.addEventListener("keydown", kbCaptureHandler, true);
    }
    q("#setKbReset").onclick = () => {
      kbCustom = {}; saveKeybinds(); applyKeybinds(); renderKeybinds();
      toast("已恢复默认快捷键", "ok");
    };
    renderKeybinds();
    q("#setSysKeys").innerHTML = SYS_KEYS.map(k => '<div class="set-key"><span>' + k[0] + "</span><kbd>" + k[1] + "</kbd></div>").join("");
    aiMountSettings();   // 挂载 AI 助手接口配置（设置 → AI 助手）
    sysAiEnsure();       // 挂载「系统 AI」分区（设置 → 系统 AI）
    notifyMountSettings(); // 挂载「通知」分区（设置 → 通知）
    if (typeof gitCredsMountSettings === "function") gitCredsMountSettings(host); // 挂载「Git 认证」分区
  }
  /* ---------- 命令注册表 + 自定义快捷键（设置 → 快捷键 可视化修改，localStorage 持久化） ---------- */
  const KEY_COMMANDS = [
    { id: "kb-save",        label: "保存当前文件",       def: "Mod+S",        run: () => { if (active) saveTab(active); } },
    { id: "kb-save-all",    label: "保存全部",           def: "Mod+K S",      run: () => saveAllTabs() },
    { id: "kb-close-all",   label: "关闭所有标签",       def: "Mod+K W",      run: () => closeGroupTabs(curGroup) },
    { id: "kb-close-saved", label: "关闭已保存标签",     def: "Mod+K U",      run: () => closeGroupTabs(curGroup, true) },
    { id: "kb-cmd",         label: "命令面板",           def: "Mod+P",        run: () => quickOpen() },
    { id: "kb-search",      label: "搜索文件内容",       def: "Mod+Shift+F",  run: () => openSearch() },
    { id: "kb-goto",        label: "跳转到行",           def: "Mod+G",        run: () => gotoLine() },
    { id: "kb-gen-commit",  label: "生成提交内容",       def: "Mod+Alt+G",    run: () => gitGenerateCommitMsg() },
    { id: "kb-find",        label: "文件内查找",         def: "Mod+F",        run: () => ffOpen(false) },
    { id: "kb-replace",     label: "文件内替换",         def: "Mod+H",        run: () => ffOpen(true) },
    { id: "kb-find-next",   label: "查找下一个",         def: "F3",           run: () => ffNext(1) },
    { id: "kb-find-prev",   label: "查找上一个",         def: "Shift+F3",     run: () => ffNext(-1) },
    { id: "kb-new",         label: "新建文件",           def: "Mod+N",        run: () => newInRoot(false) },
    { id: "kb-close-tab",   label: "关闭标签",           def: "Mod+W",        run: () => { if (active) closeTab(active); } },
    { id: "kb-sidebar",     label: "切换侧边栏",         def: "Mod+B",        run: () => toggleSidebar() },
    { id: "kb-bottom",      label: "切换底部面板",       def: "Mod+J",        run: () => toggleBottom() },
    { id: "kb-back",        label: "后退",               def: "Alt+ArrowLeft",  run: () => navGo(-1) },
    { id: "kb-fwd",         label: "前进",               def: "Alt+ArrowRight", run: () => navGo(1) },
    { id: "kb-split-r",     label: "向右拆分编辑器",     def: "Mod+\\",       run: () => splitEditor(null, "right") },
    { id: "kb-split-d",     label: "向下拆分编辑器",     def: "Alt+\\",       run: () => splitEditor(null, "down") },
    { id: "kb-wrap",        label: "切换自动换行",       def: "Alt+Z",        run: () => toggleWrap() },
    { id: "kb-font-up",     label: "放大字体",           def: "Mod+=",        run: () => chFont(1) },
    { id: "kb-font-down",   label: "缩小字体",           def: "Mod+-",        run: () => chFont(-1) },
    { id: "kb-sel-match",   label: "查找：匹配选定内容", def: "Alt+L",        run: () => ffToggleInSelection() },
    { id: "kb-run",         label: "运行当前文件",       def: "F5",           run: () => runCurrentFile() },
    { id: "kb-run-bg",      label: "后台运行当前文件",   def: "Mod+F5",       run: () => runBackground() },
    { id: "kb-md-preview",  label: "Markdown 预览",      def: "Mod+Shift+V",  run: () => mdTogglePreview() },
    { id: "kb-md-split",    label: "Markdown 分屏",      def: "Mod+Shift+M",  run: () => mdSetMode("split") },
    { id: "kb-term-new",    label: "新建终端",           def: "Mod+Shift+`",  run: () => { if (curTerm) selectTerm(curTerm); else termNew(); } },
    { id: "kb-output",      label: "切换输出面板",       def: "Mod+`",        run: () => toggleOutput() },
    { id: "kb-settings",    label: "打开设置",           def: "Mod+,",        run: () => openSettingsTab() },
  ];
  let kbCustom = (() => {
    try {
      const raw = JSON.parse(localStorage.getItem("ide.keybinds") || "{}");
      const out = {};
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        for (const k in raw) if (typeof raw[k] === "string" && raw[k]) out[k] = raw[k];
      }
      return out;
    } catch (_) { return {}; }
  })();
  function saveKeybinds() { localStorage.setItem("ide.keybinds", JSON.stringify(kbCustom)); }
  function effBind(c) { const v = kbCustom[c.id]; return typeof v === "string" && v ? v : c.def; }
  let kbMap = new Map();
  function applyKeybinds() {
    kbMap = new Map();
    for (const c of KEY_COMMANDS) {
      // 统一为分发器的空格分隔格式："Mod+K S" → "mod k s"，"Alt+ArrowLeft" → "alt arrowleft"
      const b = (effBind(c) || "").trim().toLowerCase().replace(/\+/g, " ").replace(/\s+/g, " ");
      if (b && !kbMap.has(b)) kbMap.set(b, c);   // 重复组合时按注册顺序优先
    }
  }
  applyKeybinds();

  applyIdeSettings();   // 启动时应用一次（新开编辑器读取 IDE_SETTINGS 默认值）

  /* ---------- 键盘快捷键 ---------- */
  let chordK = false;   // Ctrl+K 两段式快捷键（仿 VS Code）
  document.addEventListener("keydown", (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === "Escape" && openMenuKey) { e.preventDefault(); closeDrop(); return; }   // Esc 收起下拉/右键菜单
    // 资源管理器聚焦时：F2 重命名 / Delete 删除 / Ctrl+Enter 侧边打开 / Ctrl+C/X/V 文件复制剪切粘贴 / Ctrl+Alt+C 复制路径
    const ae = document.activeElement;
    if (ae && ae.classList && ae.classList.contains("tree-row") && treeSel) {
      const k = (e.key || "").toLowerCase();
      if (e.key === "F2") { e.preventDefault(); ctxTarget = treeSel; ctxAction("rename"); return; }
      if (e.key === "Delete") { e.preventDefault(); ctxTarget = treeSel; ctxAction("delete"); return; }
      if (e.key === "Enter" && !mod) { e.preventDefault(); ae.click(); return; }          // 文件=打开，目录=展开/收起
      if (mod && e.key === "Enter") { e.preventDefault(); ctxTarget = treeSel; ctxAction("open-side"); return; }
      if (mod && e.altKey && e.shiftKey && k === "c") { e.preventDefault(); copyText(relPathOf(treeSel.path)); return; }
      if (mod && e.altKey && k === "c") { e.preventDefault(); copyText(treeSel.path); return; }
      if (mod && k === "c" && !treeSel.isDir) { e.preventDefault(); ctxTarget = treeSel; ctxAction("copy"); return; }
      if (mod && k === "x" && !treeSel.isDir) { e.preventDefault(); ctxTarget = treeSel; ctxAction("cut"); return; }
      if (mod && k === "v") { e.preventDefault(); ctxTarget = treeSel; ctxAction("paste"); return; }
    }
    if (chordK) {   // Ctrl+K 两段式的第二段
      chordK = false;
      if (mod || e.altKey) return;
      const ccmd = kbMap.get("mod k " + e.key.toLowerCase());
      if (ccmd) { e.preventDefault(); ccmd.run(); }
      return;
    }
    if (mod && e.key.toLowerCase() === "k") { e.preventDefault(); chordK = true; return; }
    // 通用命令分发（组合键签名 → 设置页可自定义）
    const parts = [];
    if (mod) parts.push("mod");
    if (e.altKey) parts.push("alt");
    if (e.shiftKey) parts.push("shift");
    let kk = e.key;
    if (kk === "+") kk = "=";   // Ctrl+= 与 Ctrl++ 视为同一组合
    if (kk === "~") kk = "`";   // Shift+` 在多数键盘布局产生 ~
    parts.push(kk.toLowerCase());
    const cmd = kbMap.get(parts.join(" "));
    if (cmd) { e.preventDefault(); cmd.run(); }
  });

  // 窗口尺寸变化时重新测量所有已打开的编辑器，避免行号/内容错位
  let _resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(_resizeTimer);
    _resizeTimer = setTimeout(() => {
      const w = parseInt($("sidebar").style.width, 10);      // 窗口变窄时收敛已拖动的宽度
      if (w) applySidebarWidth(w, false);
      const bp = $("bottomPanel");                           // 窗口变矮时重新夹取底部面板高度
      if (bp && bp.classList.contains("show")) applyBottomHeight(bp.offsetHeight, false);
      refreshAllEditors();
    }, 150);
  });
  // 页面完全加载（字体/CSS 就绪）后再统一重绘一次
  window.addEventListener("load", () => { refreshAllEditors(); });


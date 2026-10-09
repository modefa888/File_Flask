  /* ================================================================
     设置页（仿 Trae / VS Code：以「设置」标签页形式打开，可与文件标签并存）
     ================================================================ */
  const IDE_SETTINGS = Object.assign(
    { fontSize: 13, lineWrap: false, activeLine: true, indent: 4, hints: true,
      codeComplete: true, autoComplete: true,
      showAllFiles: false, gitViewMode: "list", gitCommitFileMode: "tree", restoreSession: true,
      httpProxyMode: "", httpProxy: "", httpNoProxy: "", httpTimeout: 20,
      httpInsecure: false, httpFilterMode: "", httpFilterList: "",
      httpForApiDebug: false, httpTestUrl: "",
      theme: "dark", playerTheme: "auto", actOrder: [] },
    (() => { try { return JSON.parse(localStorage.getItem("ide.settings") || "{}"); } catch (_) { return {}; } })()
  );
  /* ---------- 网络 / 代理：模式与出站策略（设置页、插件宿主 API、API 调试共用） ---------- */
  // 代理模式：none 直连 / manual 用自定义地址 / system 跟随系统环境变量。
  // 未显式设置时按「填了地址就算 manual」推断，兼容旧版本只有 httpProxy 的存储。
  function httpProxyMode() {
    const m = IDE_SETTINGS.httpProxyMode;
    if (m === "none" || m === "manual" || m === "system") return m;
    return String(IDE_SETTINGS.httpProxy || "").trim() ? "manual" : "none";
  }
  // 网站过滤：off 不启用 / block 名单内禁止访问 / allow 仅名单内允许访问
  function httpFilterMode() {
    const m = IDE_SETTINGS.httpFilterMode;
    return (m === "block" || m === "allow") ? m : "off";
  }
  function httpProxySettings() {
    const t = parseInt(IDE_SETTINGS.httpTimeout, 10);
    return {
      mode: httpProxyMode(),
      proxy: String(IDE_SETTINGS.httpProxy || "").trim(),
      noProxy: String(IDE_SETTINGS.httpNoProxy || "").trim(),
      timeout: Math.max(1, Math.min(120, isNaN(t) ? 20 : t)),
      insecure: !!IDE_SETTINGS.httpInsecure,
      filterMode: httpFilterMode(),
      filterList: String(IDE_SETTINGS.httpFilterList || "").trim(),
    };
  }
  function ideIsLight() { return IDE_SETTINGS.theme === "light"; }                 // 当前是否浅色（白底）主题
  function ideCmTheme() { return ideIsLight() ? "default" : "material-darker"; }   // CodeMirror 主题名
  function saveIdeSettings() {
    // 合并写入：保留其它模块通过 ideSettingSet 写入的开关键，避免整对象覆盖丢失
    let cur = {};
    try { cur = JSON.parse(localStorage.getItem("ide.settings") || "{}"); } catch (_) { }
    localStorage.setItem("ide.settings", JSON.stringify(Object.assign(cur, IDE_SETTINGS)));
  }
  function applyIdeSettings() {
    document.documentElement.style.setProperty("--cm-font-size", IDE_SETTINGS.fontSize + "px");
    document.body.classList.toggle("hide-nm-hints", !IDE_SETTINGS.hints);
    // 界面主题：在 <html> 上加 theme-light 类，浅色样式表 (29_浅色主题.css) 据此覆盖
    document.documentElement.classList.toggle("theme-light", ideIsLight());
    tabs.forEach(t => {
      if (!t.cm) return;
      t.cm.setOption("lineWrapping", IDE_SETTINGS.lineWrap);
      t.cm.setOption("styleActiveLine", IDE_SETTINGS.activeLine && !t.big);
      t.cm.setOption("indentUnit", IDE_SETTINGS.indent);
      t.cm.setOption("tabSize", IDE_SETTINGS.indent);
      t.cm.setOption("theme", ideCmTheme());
      t.cm.refresh();
    });
    // 已打开的差异视图：切换 CodeMirror 主题类，让语法着色跟随深浅
    document.querySelectorAll(".sd-grid").forEach(g => {
      g.classList.toggle("cm-s-default", ideIsLight());
      g.classList.toggle("cm-s-material-darker", !ideIsLight());
    });
    // 视频播放器皮肤：白天 / 黑夜 / 跟随编辑器（auto 时界面主题一变播放器跟着变）
    if (typeof applyVideoPlayerTheme === "function") applyVideoPlayerTheme();
  }

  /* ---------- 活动栏图标顺序（设置 → 外观 可修改） ----------
   顺序存 ide.settings.actOrder（data-panel 组成的数组），启动时按它重排活动栏；
   插件运行期注册的图标不在数组里，保持在末尾（底部图标组之前），用户拖动后即被记入。 */
const ACT_SHORT = { explorer: "资源管理器", search: "搜索", git: "源代码管理", run: "运行和调试",
  runner: "后台任务", env: "运行环境", dbconn: "数据库", api: "API 调试", ext: "扩展" };
// 默认顺序（与 partials/body.html 的书写顺序一致）：「恢复默认顺序」即回到这里，而不是回到「当前看到的顺序」
const ACT_DEFAULT_ORDER = ["explorer", "search", "git", "run", "runner", "env", "dbconn", "api", "ext"];
function actOrderSaved() {
  const v = ideSettingGet("actOrder", []);
  return Array.isArray(v) ? v.filter(x => typeof x === "string" && x) : [];
}
function actOrderEffective() {
  const saved = actOrderSaved();
  return saved.length ? saved : ACT_DEFAULT_ORDER;   // 未自定义（含已恢复默认）→ 用内置默认顺序
}
function actOrderLabel(act) {   // 活动栏 title 里常带括号说明，列表只取短名
  const id = act.dataset.panel;
  return ACT_SHORT[id] || String(act.title || id).replace(/（.*$/, "");
}
function applyActOrder() {
  const bar = document.getElementById("activitybar");
  if (!bar) return;
  const acts = [...bar.querySelectorAll(".act[data-panel]")];
  if (!acts.length) return;
  // 排序锚点 = 底部图标组里的第一个（进程资源管理器图标），锚点之后的「设置」永远在最底下。
  // 不能用 #actSettings 当锚点：那样被插入的图标会落到锚点之后的底部图标下面去，整列图标会被挤到底部。
  const anchor = bar.querySelector(".act.bottom") || document.getElementById("actSettings") || null;
  const rank = new Map();
  actOrderEffective().forEach((id, i) => { if (!rank.has(id)) rank.set(id, i); });
  const BIG = 1e9;
  acts.map((a, i) => ({ a: a, i: i }))
    .sort((x, y) => {
      const rx = rank.has(x.a.dataset.panel) ? rank.get(x.a.dataset.panel) : BIG;
      const ry = rank.has(y.a.dataset.panel) ? rank.get(y.a.dataset.panel) : BIG;
      return (rx - ry) || (x.i - y.i);   // 未记录的图标（插件新增）保持原相对位置，排在最后
    })
    .forEach(o => bar.insertBefore(o.a, anchor));
}
window.applyActOrder = applyActOrder;   // 插件注册 / 移除面板后由 20_ 插件系统补调一次

const SETTINGS_PATH = "\u0000settings";   // 设置页虚拟路径（不与真实文件冲突）
  function openSettingsTab(section) {
    let tab = findTab(SETTINGS_PATH);
    if (!tab) {
      const host = document.createElement("div");
      host.className = "cm-host set-host";
      tab = { path: SETTINGS_PATH, displayPath: "设置", name: "设置", host, cm: null,
              original: "", dirty: false, big: false, group: curGroup, isSettings: true,
              iconHtml: '<i class="bi bi-gear"></i>' };  // 左侧固定显示齿轮图标，而非默认文件图标
      tabs.push(tab);
      renderTabsAll();
      buildSettingsContent(host);
    }
    activate(tab);   // 已打开则直接聚焦；正常文件仍可随时打开
    if (section) {
      const nav = tab.host.querySelector('.set-navitem[data-sec="' + section + '"]');
      if (nav) nav.click();
    }
  }
  function buildSettingsContent(host) {
    host.innerHTML =
    '<div class="set-layout">' +
      '<div class="set-nav"><h1>设置</h1><input class="set-search" placeholder="搜索设置项" autocomplete="off" spellcheck="false">' +
        '<div class="set-navitem" data-sec="sec-appearance"><i class="bi bi-palette"></i>外观</div>' +
        '<div class="set-navitem" data-sec="sec-editor"><i class="bi bi-sliders"></i>编辑器</div>' +
        '<div class="set-navitem" data-sec="sec-files"><i class="bi bi-folder2"></i>文件</div>' +
        '<div class="set-navitem" data-sec="sec-keys"><i class="bi bi-keyboard"></i>快捷键</div>' +
        '<div class="set-navitem" data-sec="sec-data"><i class="bi bi-database"></i>数据</div>' +
        '<div class="set-navitem" data-sec="sec-ai"><i class="bi bi-stars"></i>AI 助手</div>' +
        '<div class="set-navitem" data-sec="sec-sysai"><i class="bi bi-cpu"></i>系统 AI</div>' +
        '<div class="set-navitem" data-sec="sec-notify"><i class="bi bi-bell"></i>通知</div>' +
        '<div class="set-navitem" data-sec="sec-cron-notify"><i class="bi bi-alarm"></i>定时任务通知</div>' +
        '<div class="set-navitem" data-sec="sec-git-creds"><i class="bi bi-git"></i>Git 认证</div>' +
        '<div class="set-navitem" data-sec="sec-network"><i class="bi bi-globe2"></i>网络/代理</div>' +
        '<div class="set-navitem" data-sec="sec-cmdguard"><i class="bi bi-shield-shaded"></i>命令安全</div>' +
        '<div class="set-navitem" data-sec="sec-chat"><i class="bi bi-chat-square-text"></i>对话</div>' +
        '<div class="set-navitem" data-sec="sec-hints"><i class="bi bi-card-text"></i>文件说明</div>' +
      '</div>' +
      '<div class="set-content">' +
        '<div class="set-sec" id="sec-appearance"><h2 data-kw="外观 主题 背景 颜色 深色 浅色 白 黑 白天 黑夜 theme dark light">外观</h2>' +
          '<div class="set-row" data-kw="外观 主题 界面 颜色 背景 深色 浅色 白 黑 白天 黑夜 theme dark light"><div class="set-info"><div class="set-label">界面主题</div><div class="set-desc">黑夜（深色，默认）与白天（白色背景）之间切换，立即生效并记住选择</div></div><select id="setTheme"><option value="dark">黑夜（深色）</option><option value="light">白天（白色背景）</option></select></div>' +
          '<div class="set-row" data-kw="外观 主题 播放器 视频 皮肤 白天 黑夜 跟随编辑器 player video theme skin light dark auto"><div class="set-info"><div class="set-label">播放器主题</div><div class="set-desc">标签页内嵌视频播放器的皮肤：白天（浅色控制条与播放列表）/ 黑夜（深色，默认）/ 跟随编辑器（跟随上面的「界面主题」）</div></div><select id="setPlayerTheme"><option value="auto">跟随编辑器</option><option value="light">白天（浅色）</option><option value="dark">黑夜（深色）</option></select></div>' +
          '<div class="set-row actord" data-kw="外观 活动栏 图标 顺序 排序 排列 拖动 activity bar order sort"><div class="set-info"><div class="set-label">活动栏图标顺序</div><div class="set-desc">拖动条目（或点 ↑ ↓）调整左侧活动栏图标的上下顺序，立即生效并记住选择；插件添加的图标也可一起调整</div></div><div class="actord-box"><div class="actord-list" id="setActOrder"></div><button class="set-btn" id="setActOrderReset" style="margin-top:8px;">恢复默认顺序</button></div></div>' +
        '</div>' +
        '<div class="set-sec" id="sec-editor"><h2>编辑器</h2>' +
          '<div class="set-row" data-kw="字体 字号 font size"><div class="set-info"><div class="set-label">字体大小</div><div class="set-desc">编辑器代码字体大小（10–24）</div></div><input type="number" min="10" max="24" id="setFontSize"></div>' +
          '<div class="set-row" data-kw="换行 wrap line"><div class="set-info"><div class="set-label">自动换行</div><div class="set-desc">过长的行折行显示，不出现横向滚动条</div></div><input type="checkbox" id="setLineWrap"></div>' +
          '<div class="set-row" data-kw="高亮 当前行 active line"><div class="set-info"><div class="set-label">高亮当前行</div><div class="set-desc">光标所在行加背景色</div></div><input type="checkbox" id="setActiveLine"></div>' +
          '<div class="set-row" data-kw="缩进 tab indent"><div class="set-info"><div class="set-label">缩进空格数</div><div class="set-desc">Tab 与自动缩进的空格宽度</div></div><select id="setIndent"><option value="2">2</option><option value="4">4</option><option value="8">8</option></select></div>' +
          '<div class="set-row" data-kw="代码 补全 智能 提示 自动 联想 IntelliSense autocomplete suggest"><div class="set-info"><div class="set-label">代码补全</div><div class="set-desc">输入时联想文件名内符号、语言关键字、模块/类成员与文档中出现过的词；手动触发键 <kbd>Ctrl+Space</kbd>（也可用 <kbd>Alt+/</kbd>）</div></div><input type="checkbox" id="setCodeComplete"></div>' +
          '<div class="set-row" data-kw="自动 弹出 补全 输入 触发 suggest"><div class="set-info"><div class="set-label">输入时自动弹出补全</div><div class="set-desc">关闭后只在按 Ctrl+Space 时弹出候选列表</div></div><input type="checkbox" id="setAutoComplete"></div>' +
        '</div>' +
        '<div class="set-sec" id="sec-files"><h2>文件</h2>' +
          '<div class="set-row" data-kw="显示 全部 依赖 隐藏 node_modules eye"><div class="set-info"><div class="set-label">显示全部文件</div><div class="set-desc">资源管理器中显示依赖目录（node_modules 等）与点开头隐藏文件（.gitignore、.env 等），与「眼睛」图标按钮联动</div></div><input type="checkbox" id="setShowAll"></div>' +
          '<div class="set-row" data-kw="源代码管理 git 视图 树形 列表"><div class="set-info"><div class="set-label">源代码管理视图</div><div class="set-desc">更改文件清单的展示方式</div></div><select id="setGitView"><option value="list">列表（平铺）</option><option value="tree">树形（按目录）</option></select></div>' +
          '<div class="set-row" data-kw="图形 提交 文件 清单 视图 树形 列表"><div class="set-info"><div class="set-label">图形提交文件清单</div><div class="set-desc">「图形」中每个提交的文件展示方式</div></div><select id="setGitCommitMode"><option value="tree">树形（默认）</option><option value="list">列表</option></select></div>' +
          '<div class="set-row" data-kw="提示 注释 命名 hint"><div class="set-info"><div class="set-label">文件树命名提示</div><div class="set-desc">在文件名后显示说明注释（如 README → 项目说明）</div></div><input type="checkbox" id="setHints"></div>' +
          '<div class="set-row" data-kw="恢复 会话 刷新 重启 标签 侧边栏 restore session"><div class="set-info"><div class="set-label">刷新/重启后恢复会话</div><div class="set-desc">重新加载后自动恢复上次打开的侧边栏面板与文件标签</div></div><input type="checkbox" id="setRestoreSession"></div>' +
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
          '<div class="set-row" data-kw="会话 状态 面板 标签 布局 恢复 session"><div class="set-info"><div class="set-label">清除界面会话状态</div><div class="set-desc">清空记录的面板、打开的标签页、底部高度等，下次刷新回到初始界面</div></div><button class="set-btn" id="setClearSession">清除</button></div>' +
          '<div class="set-row" data-kw="ai 助手 技能 待发 清除 custom skills"><div class="set-info"><div class="set-label">清除 AI 助手数据</div><div class="set-desc">删除自定义技能、技能开关覆盖与未发送的待发消息</div></div><button class="set-btn" id="setClearAI">清除</button></div>' +
          '<div class="set-row" data-kw="布局 窗口 宽度 高度 浮窗 播放器 清除"><div class="set-info"><div class="set-label">清除窗口布局记录</div><div class="set-desc">重置侧边栏宽度、底部高度、浮窗位置与播放器记忆</div></div><button class="set-btn" id="setClearLayout">清除</button></div>' +
          '<div class="set-row" data-kw="导出 备份 设置 下载 export"><div class="set-info"><div class="set-label">导出设置备份</div><div class="set-desc">将所有设置与自定义快捷键下载为 JSON 文件</div></div><button class="set-btn" id="setExport">导出</button></div>' +
          '<div class="set-row" data-kw="导入 恢复 备份 设置 上传 import"><div class="set-info"><div class="set-label">导入设置备份</div><div class="set-desc">从导出的 JSON 文件恢复设置与快捷键</div></div><button class="set-btn" id="setImport">导入</button><input type="file" id="setImportFile" accept=".json,application/json" style="display:none"></div>' +
          '<div class="set-row" data-kw="存储 占用 空间 磁盘 storage"><div class="set-info"><div class="set-label">本地存储占用</div><div class="set-desc">浏览器 localStorage 中本 IDE 相关数据的体积</div><div class="stor-list" id="setStorageInfo"></div></div></div>' +
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
          '<div class="sysai-mods" data-kw="系统 ai 使用模块 功能 清单 提交信息 sql agent 插件 摘要 模型">' +
            '<div class="sysai-mods-hd"><i class="bi bi-diagram-3"></i>使用系统 AI 的模块' +
              '<span class="sysai-mods-sp"></span>' +
              '<button class="ai-set-btn sysai-all" id="sysAiBoard" title="所有模块的调用汇总（成功 / 失败 / 耗时 / tokens），点行看明细"><i class="bi bi-table"></i> 总统计</button>' +
              '<button class="ai-set-btn sysai-all" id="sysAiUsageReset" title="把各模块的成功 / 失败次数清零">重置统计</button>' +
              '<button class="ai-set-btn sysai-all" id="sysAiAllOn" title="把所有已停用的模块重新启用">全部启用</button>' +
            '</div>' +
            '<div class="sysai-mods-desc">下面这些功能共用同一套 AI 接口配置；未单独指定时跟随 AI 助手当前选中的接口与模型。右侧开关可单独停用某个功能（停用后它不会再调用 AI）。</div>' +
            '<div class="sysai-mod"><i class="bi bi-chat-left-quote"></i><div class="sysai-mod-main">' +
              '<div class="sysai-mod-name">AI 助手对话<span class="sysai-stat" data-stat="chat"></span></div>' +
              '<div class="sysai-mod-desc">右侧 AI 面板的提问、代码解释与整段改写</div></div>' +
              '<div class="sysai-mod-ctl"><code>POST /api/ai/chat</code>' +
              '<label class="set-switch sysai-sw" data-mod="chat" title="启用 / 停用"><input type="checkbox"><span></span></label></div></div>' +
            '<div class="sysai-mod"><i class="bi bi-cpu"></i><div class="sysai-mod-main">' +
              '<div class="sysai-mod-name">Agent 任务<span class="sysai-stat" data-stat="agent"></span></div>' +
              '<div class="sysai-mod-desc">让 AI 自动读写多个文件、连续执行任务</div></div>' +
              '<div class="sysai-mod-ctl"><code>POST /api/ai/agent</code>' +
              '<label class="set-switch sysai-sw" data-mod="agent" title="启用 / 停用"><input type="checkbox"><span></span></label></div></div>' +
            '<div class="sysai-mod"><i class="bi bi-git"></i><div class="sysai-mod-main">' +
              '<div class="sysai-mod-name">生成提交信息<span class="sysai-stat" data-stat="commit"></span></div>' +
              '<div class="sysai-mod-desc">源代码管理里按本次改动生成 Git 提交说明</div></div>' +
              '<div class="sysai-mod-ctl"><code>POST /api/ai/commit-message</code>' +
              '<label class="set-switch sysai-sw" data-mod="commit" title="启用 / 停用"><input type="checkbox"><span></span></label></div></div>' +
            '<div class="sysai-mod"><i class="bi bi-database"></i><div class="sysai-mod-main">' +
              '<div class="sysai-mod-name">一句话生成查询<span class="sysai-stat" data-stat="nl2sql"></span></div>' +
              '<div class="sysai-mod-desc">数据库查看器 / 连接工具里把自然语言翻译成 SQL、Redis 命令或 Mongo 查询</div></div>' +
              '<div class="sysai-mod-ctl"><code>POST /api/db/nl2sql</code>' +
              '<label class="set-switch sysai-sw" data-mod="nl2sql" title="启用 / 停用"><input type="checkbox"><span></span></label></div></div>' +
            '<div class="sysai-mod"><i class="bi bi-diagram-3"></i><div class="sysai-mod-main">' +
              '<div class="sysai-mod-name">AI 推荐表设计<span class="sysai-stat" data-stat="tabledesign"></span></div>' +
              '<div class="sysai-mod-desc">表结构设计弹窗里按一句话描述推荐表名与列定义</div></div>' +
              '<div class="sysai-mod-ctl"><code>POST /api/db/table/ai-design</code>' +
              '<label class="set-switch sysai-sw" data-mod="tabledesign" title="启用 / 停用"><input type="checkbox"><span></span></label></div></div>' +
            '<div class="sysai-mod"><i class="bi bi-diagram-3"></i><div class="sysai-mod-main">' +
              '<div class="sysai-mod-name">新建项目 AI<span class="sysai-stat" data-stat="scaffold"></span></div>' +
              '<div class="sysai-mod-desc">新建项目时按一句话描述生成项目初始框架</div></div>' +
              '<div class="sysai-mod-ctl"><code>POST /api/projects/create</code>' +
              '<label class="set-switch sysai-sw" data-mod="scaffold" title="启用 / 停用"><input type="checkbox"><span></span></label></div></div>' +
            '<div class="sysai-mod"><i class="bi bi-collection"></i><div class="sysai-mod-main">' +
              '<div class="sysai-mod-name">对话记忆压缩<span class="sysai-stat" data-stat="summary"></span></div>' +
              '<div class="sysai-mod-desc">长对话自动压缩成记忆摘要，节省上下文</div></div>' +
              '<div class="sysai-mod-ctl"><code>POST /api/ai/summarize</code>' +
              '<label class="set-switch sysai-sw" data-mod="summary" title="启用 / 停用"><input type="checkbox"><span></span></label></div></div>' +
            '<div class="sysai-mod"><i class="bi bi-puzzle"></i><div class="sysai-mod-main">' +
              '<div class="sysai-mod-name">插件宿主 AI<span class="sysai-stat" data-stat="plugin"></span></div>' +
              '<div class="sysai-mod-desc">插件通过 host.ai 调用当前接口与模型</div></div>' +
              '<div class="sysai-mod-ctl"><code>POST /api/ai/plugin</code>' +
              '<label class="set-switch sysai-sw" data-mod="plugin" title="启用 / 停用"><input type="checkbox"><span></span></label></div></div>' +
            '<div class="sysai-mod"><i class="bi bi-cloud-download"></i><div class="sysai-mod-main">' +
              '<div class="sysai-mod-name">拉取模型列表<span class="sysai-stat" data-stat="models"></span></div>' +
              '<div class="sysai-mod-desc">设置里「拉取模型」按钮探测接口有哪些模型可用</div></div>' +
              '<div class="sysai-mod-ctl"><code>POST /api/ai/models</code>' +
              '<label class="set-switch sysai-sw" data-mod="models" title="启用 / 停用"><input type="checkbox"><span></span></label></div></div>' +
            '<div class="sysai-mod"><i class="bi bi-activity"></i><div class="sysai-mod-main">' +
              '<div class="sysai-mod-name">资源占用诊断<span class="sysai-stat" data-stat="proc"></span></div>' +
              '<div class="sysai-mod-desc">进程资源管理器里的「AI 诊断」：把本机 CPU / 内存 / 磁盘 / 网络与高占用进程交给 AI 分析</div></div>' +
              '<div class="sysai-mod-ctl"><code>POST /api/proc/diagnose</code>' +
              '<label class="set-switch sysai-sw" data-mod="proc" title="启用 / 停用"><input type="checkbox"><span></span></label></div></div>' +
          '</div>' +
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

        '<div class="set-sec" id="sec-network"><h2 data-kw="网络 代理 proxy 插件 接口 请求 超时 证书 socks 直连 系统 环境变量 网站过滤 黑名单 白名单 屏蔽 拦截 禁止">网络 / 代理</h2>' +
          '<div class="set-desc" data-kw="网络 代理 proxy 插件 接口 请求 超时 证书 socks 直连 系统 环境变量 网站过滤 黑名单 白名单 屏蔽 拦截 禁止" style="margin-bottom:10px;">插件通过 <code>IDE.api.proxy()</code>、「API 调试」代发请求时使用的代理与出站策略。支持 <code>http</code> / <code>https</code> / <code>socks5</code> / <code>socks5h</code> 代理，可为内网地址设置例外，也可按网站过滤访问。</div>' +
          '<div class="set-row" data-kw="代理 模式 直连 系统 环境变量 proxy mode direct system"><div class="set-info"><div class="set-label">代理模式</div><div class="set-desc">不使用代理（直连）/ 自定义代理（用下面的地址）/ 跟随系统环境变量（http_proxy、https_proxy、all_proxy）</div></div><select id="setHttpProxyMode"><option value="none">不使用代理（直连）</option><option value="manual">自定义代理</option><option value="system">跟随系统环境变量</option></select></div>' +
          '<div class="set-row" data-kw="代理 地址 http https socks5 socks5h proxy 认证 用户名 密码"><div class="set-info"><div class="set-label">代理地址</div><div class="set-desc">如 <code>http://127.0.0.1:7890</code>、<code>socks5://127.0.0.1:1080</code>；需认证写成 <code>socks5://用户:密码@主机:端口</code>。仅「自定义代理」模式生效</div></div><input type="text" id="setHttpProxy" placeholder="http://127.0.0.1:7890" autocomplete="off" spellcheck="false" style="width:300px"></div>' +
          '<div class="set-row" data-kw="不走代理 例外 白名单 内网 no_proxy bypass 直连"><div class="set-info"><div class="set-label">不走代理的地址</div><div class="set-desc">逗号分隔，命中则直连。支持域名后缀（<code>internal</code>）、通配（<code>*.corp.com</code>）与 IP，例如 <code>localhost,127.0.0.1,*.internal</code></div></div><input type="text" id="setHttpNoProxy" placeholder="localhost,127.0.0.1" autocomplete="off" spellcheck="false" style="width:300px"></div>' +
          '<div class="set-row" data-kw="网站过滤 黑名单 白名单 屏蔽 拦截 禁止 域名 规则 filter blocklist allowlist site"><div class="set-info"><div class="set-label">网站过滤</div><div class="set-desc">对经服务端转发的请求生效（插件 <code>IDE.api.proxy()</code>、「API 调试」、连通性测试）：黑名单 = 名单内禁止访问，白名单 = 只允许访问名单内的网站，命中时直接拒绝、不发请求</div></div><select id="setHttpFilterMode"><option value="off">不启用</option><option value="block">黑名单（禁止访问名单内的网站）</option><option value="allow">白名单（只允许访问名单内的网站）</option></select></div>' +
          '<div class="set-row" data-kw="网站过滤 名单 域名 后缀 通配 规则 filter list"><div class="set-info"><div class="set-label">过滤名单</div><div class="set-desc">逗号分隔。支持域名后缀（<code>ads.com</code> 同时匹配其子域名）、通配（<code>*.doubleclick.net</code>）与 IP，例如 <code>*.ads.com,doubleclick.net,127.0.0.1</code></div></div><input type="text" id="setHttpFilterList" placeholder="*.ads.com,example.net" autocomplete="off" spellcheck="false" style="width:300px"></div>' +
          '<div class="set-row" data-kw="超时 timeout 秒 连接 读取"><div class="set-info"><div class="set-label">请求超时（秒）</div><div class="set-desc">出站请求的连接 / 读取超时，1–120</div></div><input type="number" min="1" max="120" id="setHttpTimeout"></div>' +
          '<div class="set-row" data-kw="ssl 证书 校验 跳过 insecure https 自签名"><div class="set-info"><div class="set-label">跳过 SSL 证书校验</div><div class="set-desc">自签名 / 内网证书时勾选（存在中间人风险，请仅在可信网络下使用）</div></div><input type="checkbox" id="setHttpInsecure"></div>' +
          '<div class="set-row" data-kw="api 调试 接口 请求 postman 走代理"><div class="set-info"><div class="set-label">「API 调试」也走此代理</div><div class="set-desc">开启后，仿 Postman 的接口调试代发请求同样套用上面的代理与出站策略</div></div><input type="checkbox" id="setHttpForApiDebug"></div>' +
          '<div class="set-row" data-kw="测试 代理 连通 检测 可用 test"><div class="set-info"><div class="set-label">连通性测试</div><div class="set-desc">用当前设置请求下面的地址，检验代理是否可用</div></div>' +
            '<div class="net-test-row"><input type="text" class="set-text" id="setHttpTestUrl" placeholder="https://www.google.com/generate_204" autocomplete="off" spellcheck="false"><button class="set-btn" id="setHttpTestBtn">测试</button><span class="net-test-res" id="setHttpTestRes"></span></div></div>' +
        '</div>' +

        notifyBuildSectionHTML() +
        cronNotifyBuildSectionHTML() +
        cmdGuardBuildSectionHTML() +
        chatBuildSectionHTML() +
        hintsBuildSectionHTML() +
      '</div>' +
    '</div>';
    const q = (s) => host.querySelector(s);
    const setSearchInput = q(".set-search");
    // 仅「自定义代理」模式允许编辑代理地址；「网站过滤」关闭时名单置灰
    function syncProxyAddrUI() {
      const el = q("#setHttpProxy");
      if (el) {
        const manual = httpProxyMode() === "manual";
        el.disabled = !manual;
        el.style.opacity = manual ? "" : ".55";
      }
      const fl = q("#setHttpFilterList");
      if (fl) {
        const on = httpFilterMode() !== "off";
        fl.disabled = !on;
        fl.style.opacity = on ? "" : ".55";
      }
    }
    // 网络 / 代理相关的设置项统一落盘，避免漏存某一项
    function saveProxySettings() {
      saveIdeSettings();
      ideSettingSet("httpProxyMode", IDE_SETTINGS.httpProxyMode || "");
      ideSettingSet("httpProxy", IDE_SETTINGS.httpProxy || "");
      ideSettingSet("httpNoProxy", IDE_SETTINGS.httpNoProxy || "");
      ideSettingSet("httpTimeout", httpProxySettings().timeout);
      ideSettingSet("httpInsecure", !!IDE_SETTINGS.httpInsecure);
      ideSettingSet("httpFilterMode", IDE_SETTINGS.httpFilterMode || "");
      ideSettingSet("httpFilterList", IDE_SETTINGS.httpFilterList || "");
      ideSettingSet("httpForApiDebug", !!IDE_SETTINGS.httpForApiDebug);
      ideSettingSet("httpTestUrl", IDE_SETTINGS.httpTestUrl || "");
    }

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
      host.querySelectorAll(".set-row, .cg-group, .cg-crow, .cg-arow").forEach(r => {
        r.style.display = ((r.dataset.kw || "").includes(k) || r.textContent.toLowerCase().includes(k)) ? "" : "none";
      });
      host.querySelectorAll(".set-key, .kb-row").forEach(r => {
        r.style.display = ((r.dataset.kw || "").includes(k) || r.textContent.toLowerCase().includes(k)) ? "" : "none";
      });
      host.querySelectorAll(".set-extra").forEach(r => {
        r.style.display = r.textContent.toLowerCase().includes(k) ? "" : "none";
      });
      host.querySelectorAll(".set-sec").forEach(sec => {
        const any = [...sec.querySelectorAll(".set-row, .set-key, .kb-row, .cg-group, .cg-crow")].some(el => el.style.display !== "none");
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
        try { localStorage.setItem("ide.session.settingsSec", n.dataset.sec); } catch (_) {}
        if (typeof sessionSaveTabs === "function") sessionSaveTabs();
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
    q("#setCodeComplete").checked = IDE_SETTINGS.codeComplete !== false;
    q("#setAutoComplete").checked = IDE_SETTINGS.autoComplete !== false;
    q("#setHints").checked = IDE_SETTINGS.hints;
    q("#setShowAll").checked = !!IDE_SETTINGS.showAllFiles;
    q("#setGitView").value = IDE_SETTINGS.gitViewMode === "tree" ? "tree" : "list";
    q("#setGitCommitMode").value = IDE_SETTINGS.gitCommitFileMode === "list" ? "list" : "tree";
    q("#setRestoreSession").checked = IDE_SETTINGS.restoreSession !== false;
    q("#setHttpProxyMode").value = httpProxyMode();
    q("#setHttpProxy").value = IDE_SETTINGS.httpProxy || "";
    q("#setHttpNoProxy").value = IDE_SETTINGS.httpNoProxy || "";
    q("#setHttpTimeout").value = httpProxySettings().timeout;
    q("#setHttpInsecure").checked = !!IDE_SETTINGS.httpInsecure;
    q("#setHttpFilterMode").value = httpFilterMode();
    q("#setHttpFilterList").value = IDE_SETTINGS.httpFilterList || "";
    q("#setHttpForApiDebug").checked = !!IDE_SETTINGS.httpForApiDebug;
    q("#setHttpTestUrl").value = IDE_SETTINGS.httpTestUrl || "";
    syncProxyAddrUI();
    q("#setTheme").value = ideIsLight() ? "light" : "dark";
    q("#setPlayerTheme").value = ["light", "dark"].indexOf(IDE_SETTINGS.playerTheme) >= 0 ? IDE_SETTINGS.playerTheme : "auto";
    q("#setFontSize").addEventListener("change", e => {
      const v = Math.max(10, Math.min(24, parseInt(e.target.value, 10) || 13));
      IDE_SETTINGS.fontSize = v; e.target.value = v; saveIdeSettings(); applyIdeSettings();
    });
    q("#setLineWrap").addEventListener("change", e => { IDE_SETTINGS.lineWrap = e.target.checked; saveIdeSettings(); applyIdeSettings(); });
    q("#setActiveLine").addEventListener("change", e => { IDE_SETTINGS.activeLine = e.target.checked; saveIdeSettings(); applyIdeSettings(); });
    q("#setIndent").addEventListener("change", e => { IDE_SETTINGS.indent = parseInt(e.target.value, 10) || 4; saveIdeSettings(); applyIdeSettings(); });
    // 代码补全：关闭时顺手收起已弹出的候选列表（触发逻辑实时判断开关，无需重建编辑器）
    q("#setCodeComplete").addEventListener("change", e => {
      IDE_SETTINGS.codeComplete = e.target.checked;
      saveIdeSettings();
      if (!e.target.checked) ideCompleteCloseAll();
      toast(e.target.checked ? "已开启代码补全" : "已关闭代码补全", "ok");
    });
    q("#setAutoComplete").addEventListener("change", e => {
      IDE_SETTINGS.autoComplete = e.target.checked;
      saveIdeSettings();
      toast(e.target.checked ? "输入时将自动弹出补全列表" : "已改为仅 Ctrl+Space 手动触发", "ok");
    });
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
    q("#setRestoreSession").addEventListener("change", e => {
      const on = e.target.checked;
      IDE_SETTINGS.restoreSession = on;
      saveIdeSettings(); ideSettingSet("restoreSession", on);
      if (!on) {
        try {
          localStorage.removeItem("ide.session.panel");
          localStorage.removeItem("ide.session.tabs");
          localStorage.removeItem("ide.session.activeTab");
          localStorage.removeItem("ide.session.bottom");
          localStorage.removeItem("ide.session.settingsSec");
          localStorage.removeItem("ide.session.search");
        } catch (_) {}
      }
    });
    // ---- 网络 / 代理：模式 / 地址 / 例外 / 超时 / 证书 / API 调试 / 连通性测试 ----
    q("#setHttpProxyMode").addEventListener("change", e => {
      IDE_SETTINGS.httpProxyMode = e.target.value;
      saveProxySettings();
      syncProxyAddrUI();
      toast(e.target.value === "system" ? "代理已跟随系统环境变量"
          : e.target.value === "manual" ? "代理已改为自定义地址"
          : "代理已关闭（直连）", "ok");
    });
    q("#setHttpProxy").addEventListener("change", e => {
      IDE_SETTINGS.httpProxy = e.target.value.trim();
      // 填了地址但模式还停在「直连 / 跟随系统」→ 自动切到「自定义代理」，省一步
      if (IDE_SETTINGS.httpProxy && httpProxyMode() !== "manual") {
        IDE_SETTINGS.httpProxyMode = "manual";
        q("#setHttpProxyMode").value = "manual";
        syncProxyAddrUI();
      }
      saveProxySettings();
      toast(IDE_SETTINGS.httpProxy ? "已保存代理地址" : "已清空代理地址", "ok");
    });
    q("#setHttpNoProxy").addEventListener("change", e => {
      IDE_SETTINGS.httpNoProxy = e.target.value.trim();
      saveProxySettings();
      toast("已保存「不走代理」列表", "ok");
    });
    q("#setHttpFilterMode").addEventListener("change", e => {
      IDE_SETTINGS.httpFilterMode = e.target.value;
      saveProxySettings();
      syncProxyAddrUI();
      const hasList = String(IDE_SETTINGS.httpFilterList || "").trim().length > 0;
      toast(e.target.value === "off" ? "已关闭网站过滤"
          : e.target.value === "block" ? (hasList ? "已启用黑名单：名单内网站将被拒绝访问"
                                                  : "已启用黑名单，请填写要屏蔽的网站")
          : (hasList ? "已启用白名单：只允许访问名单内的网站"
                     : "已启用白名单，请填写允许访问的网站"),
          e.target.value === "off" ? "ok" : "warn");
    });
    q("#setHttpFilterList").addEventListener("change", e => {
      IDE_SETTINGS.httpFilterList = e.target.value.trim();
      saveProxySettings();
      toast("已保存网站过滤名单", "ok");
    });
    q("#setHttpTimeout").addEventListener("change", e => {
      const v = Math.max(1, Math.min(120, parseInt(e.target.value, 10) || 20));
      IDE_SETTINGS.httpTimeout = v; e.target.value = v;
      saveProxySettings();
    });
    q("#setHttpInsecure").addEventListener("change", e => {
      IDE_SETTINGS.httpInsecure = e.target.checked;
      saveProxySettings();
      toast(e.target.checked ? "已跳过 SSL 证书校验（请注意安全）" : "已恢复 SSL 证书校验",
            e.target.checked ? "warn" : "ok");
    });
    q("#setHttpForApiDebug").addEventListener("change", e => {
      IDE_SETTINGS.httpForApiDebug = e.target.checked;
      saveProxySettings();
      toast(e.target.checked ? "「API 调试」将使用此代理" : "「API 调试」已恢复直连", "ok");
    });
    q("#setHttpTestUrl").addEventListener("change", e => {
      IDE_SETTINGS.httpTestUrl = e.target.value.trim();
      saveProxySettings();
    });
    q("#setHttpTestBtn").addEventListener("click", () => {
      const btn = q("#setHttpTestBtn"), res = q("#setHttpTestRes");
      const url = (q("#setHttpTestUrl").value || "").trim() || "https://www.google.com/generate_204";
      const cfg = httpProxySettings();
      res.className = "net-test-res busy"; res.textContent = "测试中…";
      btn.disabled = true;
      fetch("/api/plugins/http", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url, method: "GET", mode: cfg.mode, proxy: cfg.proxy,
                               noProxy: cfg.noProxy, timeout: cfg.timeout, insecure: cfg.insecure,
                               filterMode: cfg.filterMode, filterList: cfg.filterList }),
      }).then(r => r.json()).then(d => {
        btn.disabled = false;
        if (d && d.success) {
          res.className = "net-test-res ok";
          res.textContent = "可用 · HTTP " + d.status +
            (d.elapsed ? " · " + d.elapsed + " ms" : "") + (d.proxy ? " · 经 " + d.proxy : " · 直连");
        } else {
          res.className = "net-test-res bad";
          res.textContent = "失败：" + ((d && d.error) || "未知错误");
        }
      }).catch(err => {
        btn.disabled = false;
        res.className = "net-test-res bad";
        res.textContent = "失败：" + ((err && err.message) || err);
      });
    });
    // 界面主题：黑夜 / 白天（白色背景）切换，立即生效
    q("#setTheme").addEventListener("change", e => {
      IDE_SETTINGS.theme = e.target.value === "light" ? "light" : "dark";
      saveIdeSettings(); applyIdeSettings();
      toast(ideIsLight() ? "已切换到白天主题" : "已切换到黑夜主题", "ok");
    });
    // 播放器主题：白天 / 黑夜 / 跟随编辑器（auto 跟随「界面主题」，界面一换播放器跟着换）
    q("#setPlayerTheme").addEventListener("change", e => {
      const v = e.target.value === "light" ? "light" : (e.target.value === "dark" ? "dark" : "auto");
      IDE_SETTINGS.playerTheme = v;
      saveIdeSettings(); ideSettingSet("playerTheme", v);
      if (typeof applyVideoPlayerTheme === "function") applyVideoPlayerTheme();
      toast(v === "auto" ? "播放器已跟随编辑器主题" : (v === "light" ? "播放器已切换到白天皮肤" : "播放器已切换到黑夜皮肤"), "ok");
    });
    // ---- 活动栏图标顺序（外观）：拖动 / 上下移动，改动即时保存并应用到左侧活动栏 ----
    const actList = q("#setActOrder");
    function actOrderIds() { return [...actList.querySelectorAll(".actord-item:not(.actord-ph)")].map(el => el.dataset.panel); }
    function actOrderCommit() {
      const ids = actOrderIds();
      IDE_SETTINGS.actOrder = ids;
      saveIdeSettings(); ideSettingSet("actOrder", ids);
      applyActOrder();
    }
    function actOrderRender() {
      if (!actList) return;
      const bar = $("activitybar");
      if (!bar) return;
      // 列表按活动栏当前实际顺序渲染（applyActOrder 已把 DOM 排好）
      const acts = [...bar.querySelectorAll(".act[data-panel]")];
      actList.innerHTML = acts.map(a => {
        const ic = a.querySelector("i");
        return '<div class="actord-item" draggable="true" data-panel="' + esc(a.dataset.panel) + '" title="' + esc(a.title || a.dataset.panel) + '">' +
          '<span class="actord-grip"><i class="bi bi-grip-vertical"></i></span>' +
          '<span class="actord-ic">' + (ic ? ic.outerHTML : '<i class="bi bi-square"></i>') + '</span>' +
          '<span class="actord-nm">' + esc(actOrderLabel(a)) + '</span>' +
          '<button class="actord-mv" data-mv="-1" title="上移"><i class="bi bi-chevron-up"></i></button>' +
          '<button class="actord-mv" data-mv="1" title="下移"><i class="bi bi-chevron-down"></i></button>' +
        '</div>';
      }).join("");
      // 上移 / 下移按钮
      actList.querySelectorAll(".actord-mv").forEach(b => {
        b.onclick = (e) => {
          e.stopPropagation();
          const it = b.closest(".actord-item");
          const up = b.dataset.mv === "-1";
          const sib = up ? it.previousElementSibling : it.nextElementSibling;
          if (!sib) return;
          if (up) actList.insertBefore(it, sib); else actList.insertBefore(sib, it);
          actOrderCommit(); actOrderRender();
        };
      });
      // 拖动排序：拖动期间用占位块标出落点（不移动被拖元素本身，避免 Firefox 中断拖拽），
      // 松手后再把条目挪到占位块处；拖到条目下半区 = 插到该条目之后
      let ph = null;
      actList.querySelectorAll(".actord-item").forEach(it => {
        it.addEventListener("dragstart", (e) => {
          it.classList.add("dragging");
          ph = document.createElement("div");
          ph.className = "actord-item actord-ph";
          actList.insertBefore(ph, it.nextElementSibling);
          try { e.dataTransfer.setData("text/plain", it.dataset.panel); e.dataTransfer.effectAllowed = "move"; } catch (_) {}
        });
        it.addEventListener("dragover", (e) => {
          if (!ph || it.classList.contains("actord-ph")) return;
          e.preventDefault();
          const r = it.getBoundingClientRect();
          actList.insertBefore(ph, (e.clientY - r.top) > r.height / 2 ? it.nextElementSibling : it);
        });
        it.addEventListener("dragend", () => {
          it.classList.remove("dragging");
          if (ph && ph.parentNode) { actList.insertBefore(it, ph); ph.remove(); }
          ph = null;
          actOrderCommit(); actOrderRender();
        });
      });
    }
    actOrderRender();
    q("#setActOrderReset").onclick = () => {
      IDE_SETTINGS.actOrder = [];
      saveIdeSettings(); ideSettingSet("actOrder", []);
      applyActOrder(); actOrderRender();
      toast("活动栏图标已恢复默认顺序", "ok");
    };
    q("#setClearRecent").onclick = () => { localStorage.removeItem("ide.recentFiles"); toast("已清除最近打开记录", "ok"); renderStorageInfo(); };
    /* ---- 数据：分类清除 / 备份导入导出 / 存储占用 ---- */
    const rmKeys = (keys, msg) => { keys.forEach(k => localStorage.removeItem(k)); toast(msg, "ok"); renderStorageInfo(); };
    q("#setClearSession").onclick = () => rmKeys(
      ["ide.session.panel", "ide.session.tabs", "ide.session.activeTab", "ide.session.bottom", "ide.session.settingsSec", "ide.session.search"],
      "已清除界面会话状态，刷新后回到初始界面");
    q("#setClearAI").onclick = () => rmKeys(
      ["ide.ai.customSkills", "ide.ai.skillOverrides", "ide.ai.pendingTurn", "ide.aiTodoCollapsed"],
      "已清除 AI 助手数据");
    q("#setClearLayout").onclick = () => rmKeys(
      ["ide.sidebarWidth", "ide.bottomHeight", "ide.ai.width", "ide.procpm.pos", "ide.procpm.max", "ide.procdiag.pos", "ide.procdiag.max", "ide.videoPlayer"],
      "已清除窗口布局记录，刷新后生效");
    q("#setExport").onclick = () => {
      const data = { exportedAt: new Date().toISOString(), settings: {}, keybinds: {} };
      try { data.settings = JSON.parse(localStorage.getItem("ide.settings") || "{}"); } catch (_) {}
      try { data.keybinds = JSON.parse(localStorage.getItem("ide.keybinds") || "{}"); } catch (_) {}
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "ide-settings-" + new Date().toISOString().slice(0, 10) + ".json";
      a.click(); URL.revokeObjectURL(a.href);
      toast("设置已导出为 JSON 文件", "ok");
    };
    q("#setImport").onclick = () => q("#setImportFile").click();
    q("#setImportFile").onchange = (e) => {
      const f = e.target.files && e.target.files[0];
      e.target.value = "";
      if (!f) return;
      const rd = new FileReader();
      rd.onload = () => {
        try {
          const d = JSON.parse(rd.result);
          if (!d || typeof d !== "object" || Array.isArray(d)) throw new Error("bad");
          if (d.settings && typeof d.settings === "object" && !Array.isArray(d.settings))
            localStorage.setItem("ide.settings", JSON.stringify(d.settings));
          if (d.keybinds && typeof d.keybinds === "object" && !Array.isArray(d.keybinds)) {
            kbCustom = d.keybinds; saveKeybinds(); applyKeybinds(); renderKeybinds();
          }
          applyIdeSettings();
          toast("设置已导入，部分项刷新页面后生效", "ok");
          renderStorageInfo();
        } catch (_) { toast("导入失败：不是有效的设置备份文件", "err"); }
      };
      rd.readAsText(f);
    };
    function renderStorageInfo() {
      const box = q("#setStorageInfo");
      if (!box) return;
      const rows = []; let total = 0;
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k || !(k.startsWith("ide.") || k.startsWith("cb-") || k.startsWith("git"))) continue;
        const n = k.length + (localStorage.getItem(k) || "").length;
        total += n; rows.push([k, n]);
      }
      const fmt = (n) => n < 1024 ? n + " B" : (n / 1024).toFixed(1) + " KB";
      rows.sort((a, b) => b[1] - a[1]);
      box.innerHTML = '<div class="stor-total">共 ' + rows.length + ' 项，占用约 ' + fmt(total) + '</div>' +
        rows.slice(0, 10).map(r => '<div class="stor-row"><span class="stor-k">' + esc(r[0]) + '</span><span class="stor-s">' + fmt(r[1]) + '</span></div>').join("") +
        (rows.length > 10 ? '<div class="stor-total">…以及 ' + (rows.length - 10) + ' 个更小的项</div>' : '');
    }
    renderStorageInfo();
    q("#setReset").onclick = () => {
      Object.assign(IDE_SETTINGS, { fontSize: 13, lineWrap: false, activeLine: true, indent: 4, hints: true,
        codeComplete: true, autoComplete: true,
        showAllFiles: false, gitViewMode: "list", gitCommitFileMode: "tree", restoreSession: true,
        httpProxyMode: "", httpProxy: "", httpNoProxy: "", httpTimeout: 20, httpInsecure: false,
        httpFilterMode: "", httpFilterList: "",
        httpForApiDebug: false, httpTestUrl: "",
        theme: "dark", playerTheme: "auto", actOrder: [] });
      saveIdeSettings(); applyIdeSettings();
      ideSettingSet("actOrder", []); applyActOrder(); actOrderRender();   // 活动栏图标顺序也恢复默认
      q("#setFontSize").value = 13; q("#setLineWrap").checked = false; q("#setActiveLine").checked = true;
      q("#setIndent").value = 4; q("#setHints").checked = true;
      q("#setCodeComplete").checked = true; q("#setAutoComplete").checked = true;
      q("#setShowAll").checked = false; q("#setGitView").value = "list"; q("#setGitCommitMode").value = "tree";
      q("#setRestoreSession").checked = true;
      q("#setHttpProxyMode").value = "none";
      q("#setHttpProxy").value = ""; q("#setHttpNoProxy").value = ""; q("#setHttpTimeout").value = 20;
      q("#setHttpInsecure").checked = false; q("#setHttpForApiDebug").checked = false;
      q("#setHttpFilterMode").value = "off"; q("#setHttpFilterList").value = "";
      q("#setHttpTestUrl").value = ""; q("#setHttpTestRes").textContent = "";
      q("#setHttpTestRes").className = "net-test-res";
      syncProxyAddrUI();
      q("#setTheme").value = "dark";
      q("#setPlayerTheme").value = "auto";
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
    const KEY_PRETTY = { arrowleft: "ArrowLeft", arrowright: "ArrowRight", arrowup: "ArrowUp", arrowdown: "ArrowDown",
      escape: "Esc", backspace: "Backspace", pageup: "PageUp", pagedown: "PageDown", enter: "Enter", tab: "Tab", space: "Space" };
    const fmtBind = (b) => b.split(" ").map(p => {
      if (p === "Mod") return KB_MOD_KEY;
      return p.replace(/^Mod\+/, KB_MOD_KEY + "+").split("+")
        .map(s => KEY_PRETTY[s.toLowerCase()] || (s.length === 1 ? s.toUpperCase() : s)).join("+");
    }).join(" ");
    function renderKeybinds() {
      const box = q("#setKeybinds");
      box.innerHTML = KEY_COMMANDS.map(c => {
        const cur = effBind(c);
        const cap = kbCapture === c.id;
        const off = !cur && typeof kbCustom[c.id] === "string";
        const keysHtml = cap ? '<kbd style="color:#7ab8ff;">按下新组合键…</kbd>'
          : (cur ? fmtBind(cur).split(" ").map(p => "<kbd>" + esc(p) + "</kbd>").join("")
                 : (off ? fmtBind(c.def).split(" ").map(p => "<kbd>" + esc(p) + "</kbd>").join("")
                    : '<span style="color:#777;font-size:11px;">未设置</span>'));
        return '<div class="kb-row' + (cap ? " capturing" : "") + (off ? " kb-off" : "") + '" data-kw="快捷键 ' + esc(c.label) + '">' +
          '<span class="set-label">' + esc(c.label) + (off ? ' <span class="kb-off-tag">已禁用</span>' : '') + '</span>' +
          '<div class="kb-foot"><span class="kb-keys">' + keysHtml + '</span>' +
          '<span class="kb-acts"><button class="kb-btn" data-kb="' + c.id + '">' + (cap ? "取消" : "修改") + '</button>' +
          (cur ? '<button class="kb-btn kb-danger" data-kbclr="' + c.id + '">禁用</button>'
               : (typeof kbCustom[c.id] === "string" ? '<button class="kb-btn" data-kbdef="' + c.id + '">默认</button>' : '')) + '</span></div>' +
        '</div>';
      }).join("");
      box.querySelectorAll("[data-kb]").forEach(b => { b.onclick = () => startKbCapture(b.dataset.kb); });
      box.querySelectorAll("[data-kbclr]").forEach(b => {
        b.onclick = () => { kbCustom[b.dataset.kbclr] = ""; saveKeybinds(); applyKeybinds(); renderKeybinds(); toast("已禁用该快捷键", "ok"); };
      });
      box.querySelectorAll("[data-kbdef]").forEach(b => {
        b.onclick = () => { delete kbCustom[b.dataset.kbdef]; saveKeybinds(); applyKeybinds(); renderKeybinds(); toast("已恢复默认快捷键", "ok"); };
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
    cmdGuardMountSettings(host); // 挂载「命令安全」分区（设置 → 命令安全）
    chatMountSettings(host);   // 挂载「对话」分区（设置 → 对话）
    hintsMountSettings(host);  // 挂载「文件说明」分区（设置 → 文件说明）
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
    { id: "kb-inline-chat", label: "内联对话（编辑器 / 终端）", def: "Mod+I",   run: () => inlineChatDispatch() },
  ];
  let kbCustom = (() => {
    try {
      const raw = JSON.parse(localStorage.getItem("ide.keybinds") || "{}");
      const out = {};
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        for (const k in raw) if (typeof raw[k] === "string") out[k] = raw[k];   // 空字符串 = 已禁用，也要保留
      }
      return out;
    } catch (_) { return {}; }
  })();
  function saveKeybinds() { localStorage.setItem("ide.keybinds", JSON.stringify(kbCustom)); }
  function effBind(c) { const v = kbCustom[c.id]; return typeof v === "string" ? v : c.def; }   // "" = 已禁用，不再回退默认
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
  applyActOrder();      // 活动栏图标顺序（设置 → 外观 可修改；插件注册的图标稍后由 20_ 补调）

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
      const ap = $("aiPanel");                               // AI 面板同样在窗口变窄 / 变宽时收敛
      if (ap && ap.classList.contains("open")) applyAiWidth(parseInt(ap.style.width, 10) || AI_DEFAULT_W, false);
      const bp = $("bottomPanel");                           // 窗口变矮时重新夹取底部面板高度
      if (bp && bp.classList.contains("show")) applyBottomHeight(bp.offsetHeight, false);
      refreshAllEditors();
    }, 150);
  });
  // 页面完全加载（字体/CSS 就绪）后再统一重绘一次
  window.addEventListener("load", () => { refreshAllEditors(); });

  window.openSettingsTab = openSettingsTab;

  /* ================================================================
   * 设置 → 文件说明：管理资源管理器文件名后显示的中文说明。
   * 内置基础说明来自 static/special_hints.json（只读，随代码维护）；
   * 此处新增 / 修改的说明保存到数据库（/api/file_hints），同名时覆盖内置说明。
   * ================================================================ */
  function hintsBuildSectionHTML() {
    return '<div class="set-sec" id="sec-hints">' +
      '<h2 data-kw="文件说明 注释 命名 提示 hint 说明 自定义 内置">文件说明</h2>' +
      '<div class="set-desc" data-kw="文件说明 注释 命名 提示 hint 说明 自定义 内置" style="margin-bottom:12px;">' +
        '资源管理器中文件名后显示的灰色说明。内置基础说明来自 <code>static/special_hints.json</code>（只读）；' +
        '此处新增或修改的说明会保存到数据库，同名时覆盖内置说明（留空保存 = 恢复默认）。</div>' +
      '<div class="fh-add" data-kw="文件说明 新增 添加 名称 说明 hint add">' +
        '<input type="text" class="fh-name" id="fhName" placeholder="文件名 / 文件夹名（如 requirements.txt）" autocomplete="off" spellcheck="false">' +
        '<input type="text" class="fh-text" id="fhText" placeholder="说明（如 依赖列表）" autocomplete="off" spellcheck="false">' +
        '<button class="set-btn" id="fhSaveBtn">添加 / 更新</button>' +
      '</div>' +
      '<div class="fh-tip" id="fhTip"></div>' +
      '<div class="fh-toolbar" data-kw="文件说明 筛选 搜索 filter 自定义 内置">' +
        '<div class="fh-seg" id="fhSeg">' +
          '<button type="button" class="fh-seg-btn on" data-view="all">全部</button>' +
          '<button type="button" class="fh-seg-btn" data-view="custom">自定义</button>' +
          '<button type="button" class="fh-seg-btn" data-view="base">内置</button>' +
        '</div>' +
        '<input type="text" id="fhFilter" placeholder="筛选说明…" autocomplete="off" spellcheck="false">' +
        '<span class="fh-count" id="fhCount"></span>' +
      '</div>' +
      '<div class="fh-list" id="fhList"></div>' +
    '</div>';
  }

  function hintsMountSettings(host) {
    const q = (s) => host.querySelector(s);
    const listEl = q("#fhList"), nameEl = q("#fhName"), textEl = q("#fhText"),
          tipEl = q("#fhTip"), countEl = q("#fhCount"), filterEl = q("#fhFilter");
    let tipTimer = null;
    let fhView = "all";                        // 列表视图：all 全部 / custom 仅自定义 / base 仅内置

    const tip = (msg, isErr) => {
      if (!tipEl) return;
      tipEl.textContent = msg || "";
      tipEl.style.color = isErr ? "#f14c4c" : "#7fd88f";
      clearTimeout(tipTimer);
      if (msg) tipTimer = setTimeout(() => { tipEl.textContent = ""; }, 2600);
    };

    // 保存一条说明（hint 为空 = 删除自定义项、恢复内置默认），并同步文件树与该列表
    const doSave = async (name, hint) => {
      name = (name || "").trim();
      hint = (hint == null ? "" : String(hint)).trim();
      if (!name) { tip("请输入文件名 / 文件夹名", true); if (nameEl) nameEl.focus(); return false; }
      try {
        await saveFileHint(name, hint);          // 存数据库 + 合并 + 刷新文件树
        tip(hint ? ("已保存：" + name) : ("已恢复默认：" + name), false);
        renderHintsList();
        toast(hint ? "已保存说明" : "已恢复默认说明", "ok");
        return true;
      } catch (e) {
        tip("保存失败：" + (e.message || e), true);
        toast("保存说明失败：" + (e.message || e), "err");
        return false;
      }
    };

    const doEdit = async (name) => {
      const cur = SPECIAL_NAME_CUSTOM[name] || SPECIAL_NAME_BASE[name] || "";
      const v = await uiPrompt("编辑说明：" + name, cur, "输入说明文字（留空恢复默认）");
      if (v === null) return;                    // 取消
      await doSave(name, v);
    };

    function renderHintsList() {
      if (!listEl) return;
      const kw = ((filterEl && filterEl.value) || "").trim().toLowerCase();
      const names = {};
      if (fhView !== "custom") Object.keys(SPECIAL_NAME_BASE).forEach((n) => { names[n] = 1; });
      if (fhView !== "base") Object.keys(SPECIAL_NAME_CUSTOM).forEach((n) => { names[n] = 1; });
      const rows = Object.keys(names)
        .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
        .filter((n) => {
          if (!kw) return true;
          const h = SPECIAL_NAME_CUSTOM[n] || SPECIAL_NAME_BASE[n] || "";
          return n.toLowerCase().includes(kw) || h.toLowerCase().includes(kw);
        });
      if (countEl) countEl.textContent = rows.length + " 项";
      if (!rows.length) {
        listEl.innerHTML = '<div class="fh-empty">' + (fhView === "custom"
          ? "还没有自定义说明：在上方填写后点「添加 / 更新」，或右键文件 → 编辑说明"
          : "没有匹配的说明") + '</div>';
        return;
      }
      listEl.innerHTML = rows.map((n) => {
        const custom = Object.prototype.hasOwnProperty.call(SPECIAL_NAME_CUSTOM, n);
        const h = custom ? SPECIAL_NAME_CUSTOM[n] : (SPECIAL_NAME_BASE[n] || "");
        return '<div class="set-row fh-row" data-name="' + esc(n) + '" data-kw="' +
            esc((n + " " + h + " 文件说明 说明").toLowerCase()) + '">' +
          '<div class="set-info"><div class="set-label">' + esc(n) +
            '<span class="fh-badge' + (custom ? " on" : "") + '">' + (custom ? "自定义" : "内置") + '</span></div>' +
            '<div class="set-desc">' + esc(h) + '</div></div>' +
          '<div class="fh-acts">' +
            '<button class="set-btn" data-fh="edit">' + (custom ? "编辑" : "覆盖") + '</button>' +
            (custom ? '<button class="set-btn fh-danger" data-fh="del">恢复默认</button>' : "") +
          '</div></div>';
      }).join("");
    }

    if (listEl) listEl.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-fh]"); if (!btn) return;
      const row = btn.closest(".fh-row"); if (!row) return;
      const name = row.dataset.name;
      if (btn.dataset.fh === "edit") doEdit(name);
      else if (btn.dataset.fh === "del") doSave(name, "");
    });

    const saveBtn = q("#fhSaveBtn");
    const submitForm = async () => {
      const ok = await doSave(nameEl ? nameEl.value : "", textEl ? textEl.value : "");
      if (ok) { if (nameEl) nameEl.value = ""; if (textEl) textEl.value = ""; }
    };
    if (saveBtn) saveBtn.onclick = submitForm;
    [nameEl, textEl].forEach((el) => {
      if (el) el.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); submitForm(); } });
    });
    const segEl = q("#fhSeg");
    if (segEl) segEl.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-view]"); if (!btn) return;
      fhView = btn.dataset.view;
      segEl.querySelectorAll("[data-view]").forEach((b) => b.classList.toggle("on", b === btn));
      renderHintsList();
    });
    if (filterEl) filterEl.addEventListener("input", renderHintsList);

    renderHintsList();
    // 极端情况下（设置页比说明数据先就绪）再补拉一次
    if (!Object.keys(SPECIAL_NAME_BASE).length && !Object.keys(SPECIAL_NAME_CUSTOM).length) {
      try { loadSpecialHints().then(renderHintsList); } catch (_) {}
    }
  }


(function () {
  "use strict";
  const BASE = "/static/vendor/codemirror/mode/";
  /* ---------- 路径混淆 + 本地持久化 ----------
     1) 用 ?path=<明文> 打开 IDE 后，把明文 URL 立即替换成 ?id=<混淆token>，地址栏不再暴露路径；
     2) 明文路径写入 localStorage，下次访问 /ide 不带参数时自动恢复上次的文件夹。
     混淆方式：字符 code 加 XOR 偏移 + Base64。纯前端、无密钥，仅用于视觉遮挡。 */
  const LAST_PATH_KEY = "ide_last_path";
  const PATH_OBFUS_KEY = 0x5f;
  function obfuscatePath(raw) {
    try {
      const s = String(raw || "").replace(/\/+$/, "");
      if (!s) return "";
      const bytes = new Uint8Array(s.length);
      for (let i = 0; i < s.length; i++) { bytes[i] = (s.charCodeAt(i) ^ PATH_OBFUS_KEY) & 0xff; }
      return btoa(String.fromCharCode.apply(null, Array.from(bytes)));
    } catch (e) { return ""; }
  }
  function deobfuscatePath(id) {
    try {
      const bytes = Uint8Array.from(atob(String(id || "")), c => c.charCodeAt(0));
      let s = "";
      for (let i = 0; i < bytes.length; i++) { s += String.fromCharCode(bytes[i] ^ PATH_OBFUS_KEY); }
      return s.replace(/\/+$/, "");
    } catch (e) { return ""; }
  }
  // 工作区根目录：?path 优先，其次 localStorage（不带参数访问时自动恢复上次项目）；
  // 去掉尾部斜杠，否则文件树会拼出 "a//b" 这种路径，与搜索/新建等入口的标准路径对不上，
  // 同一个文件会被当成两个文件重复打开
  const ROOT = (() => {
    let raw = (new URLSearchParams(location.search).get("path") || "").trim();
    if (!raw) {
      try { raw = localStorage.getItem(LAST_PATH_KEY) || ""; } catch (e) {}
    }
    return raw.length > 1 ? raw.replace(/\/+$/, "") : raw;
  })();
  // 打开 IDE 后：把路径持久化到 localStorage，并把 URL 替换成 ?id=<token>（不显示明文路径）
  if (ROOT) {
    try { localStorage.setItem(LAST_PATH_KEY, ROOT); } catch (e) {}
    try {
      const tok = obfuscatePath(ROOT);
      if (tok) history.replaceState(null, "", "/ide?id=" + encodeURIComponent(tok));
    } catch (e) {}
  }

  const $ = (id) => document.getElementById(id);
  const explorerPanel = $("explorerPanel");
  const welcome = $("welcome");
  // 分屏：动态多组。tab.group 为组 id（递增不复用），组按 id 升序横向排列，空组自动消失
  const edGroups = $("edGroups");
  let curGroup = 0;                  // 焦点所在组：新打开的文件进入该组
  let groupBundles = new Map();      // gid -> { el, tabbar, wrap }
  const groupActive = new Map();     // gid -> 该组当前显示的标签
  let builtGroupKey = "\u0000init";

  // 打开的标签页
  const tabs = [];         // {path, name, host, cm, original, dirty}
  let active = null;
  let openSeq = 0;         // 打开文件序号：异步加载完成后对比，防止快速连点时旧请求抢焦点

  /* ---------- 工具 ---------- */
  function toast(msg, type) {
    const t = $("toast");
    t.textContent = msg;
    t.className = "ide-toast show " + (type || "");
    setTimeout(() => { t.className = "ide-toast " + (type || ""); }, 2200);
  }
  function esc(s) { s = s == null ? "" : String(s); return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
  function getExt(name) { const i = name.lastIndexOf("."); return i >= 0 ? name.substring(i + 1).toLowerCase() : ""; }
  function baseName(p) { p = String(p == null ? "" : p); return p.split("/").pop() || p; }
  function dirName(p) { const i = p.lastIndexOf("/"); return i > 0 ? p.substring(0, i) : (i === 0 ? "/" : p); }

  /* ---------- 文件树 ---------- */
  // 全局设置 JSON（localStorage "ide.settings"）通用读写：所有开关型设置统一收口，永久保存
  function ideSettingGet(k, def) {
    try { const s = JSON.parse(localStorage.getItem("ide.settings") || "{}"); return (s && s[k] !== undefined) ? s[k] : def; } catch (_) { return def; }
  }
  function ideSettingSet(k, v) {
    try {
      const s = JSON.parse(localStorage.getItem("ide.settings") || "{}");
      s[k] = v; localStorage.setItem("ide.settings", JSON.stringify(s));
    } catch (_) { }
  }
  // 是否使用浅色（白色背景）主题：由「设置 → 外观 → 界面主题」写入 localStorage
  function ideThemeLight() { return ideSettingGet("theme", "dark") === "light"; }
  /* ---------- 会话持久化：侧边栏面板 + 底部面板 + 打开的文件标签 ---------- */
  function sessionSavePanel(name) {
    if (!ideSettingGet("restoreSession", true)) return;
    try { localStorage.setItem("ide.session.panel", name); } catch (_) {}
  }
  // 底部面板（输出 / 终端 / 运行日志）：记录显隐状态与当前标签，刷新后原样恢复
  function sessionSaveBottom() {
    if (!ideSettingGet("restoreSession", true)) return;
    try {
      const p = $("bottomPanel");
      const tab = document.querySelector(".bp-tab[data-pane].active");
      localStorage.setItem("ide.session.bottom", JSON.stringify({
        show: !!(p && p.classList.contains("show")),
        pane: (typeof bottomPane === "string" ? bottomPane : (tab ? tab.dataset.pane : "output")) || "output",
      }));
    } catch (_) {}
  }
  // 只有「真实的源码文件标签」和「设置页」才值得恢复：
  // 跳过 diff 视图 / 打开更改汇总 / 文件比较等内部标签（它们的 path 是带 \u0001 的内部 key，用 openFile 去读必然报错）。
  function sessionIsRestorable(t) {
    if (!t || !t.path) return false;
    if (t.pluginView) return false;   // 插件自定义视图：不参与会话恢复（由插件激活时自行打开）
    if (t.diff || t.allDiff) return false;
    if (t.path.indexOf("\u0001") >= 0) return false;   // 内部 key：差异 / 比较视图
    return true;
  }
  function sessionSaveTabs() {
    if (!ideSettingGet("restoreSession", true)) return;
    try {
      const list = tabs.filter(sessionIsRestorable).map(t => {
        const o = { path: t.path, name: t.name, group: t.group };
        if (t.isSettings) {
          o.isSettings = true;
          try { o.settingsSec = localStorage.getItem("ide.session.settingsSec") || ""; } catch (_) {}
        }
        return o;
      });
      localStorage.setItem("ide.session.tabs", JSON.stringify(list));
      localStorage.setItem("ide.session.activeTab", (active && sessionIsRestorable(active)) ? active.path : "");
    } catch (_) {}
  }
  async function sessionRestore() {
    if (!ideSettingGet("restoreSession", true)) return;
    try {
      const panel = localStorage.getItem("ide.session.panel");
      if (panel && typeof showPanel === "function") showPanel(panel);
      if (panel === "search" && typeof window.sessionRestoreSearch === "function") window.sessionRestoreSearch();
      // 数据库连接面板：连接列表是懒加载的（点侧栏图标才拉取），会话恢复时要主动补一次，否则刷新后左栏空白
      if (panel === "dbconn" && typeof loadDbConns === "function") loadDbConns();
      // 定时任务面板：同样懒加载，恢复会话时补一次并启动自动刷新
      if (panel === "cron" && typeof loadCron === "function") loadCron().then(cronTick);
      const raw = localStorage.getItem("ide.session.tabs");
      const list = raw ? JSON.parse(raw) : [];
      const activePath = localStorage.getItem("ide.session.activeTab") || "";
      for (const t of list) {
        if (!t || !t.path) continue;
        if (t.isSettings && typeof window.openSettingsTab === "function") {
          let sec = t.settingsSec || "";
          try { sec = localStorage.getItem("ide.session.settingsSec") || sec; } catch (_) {}
          window.openSettingsTab(sec);
          continue;
        }
        // 数据库连接视图（虚拟路径 \u0000db:<连接 id>）：不是真实文件，走 openFile 必然报「路径不存在」。
        // 先加载连接列表，再按 id 还原成数据库视图标签。
        if (typeof DBC_VIEW_PREFIX === "string" && t.path.indexOf(DBC_VIEW_PREFIX) === 0) {
          if (typeof loadDbConns === "function") await loadDbConns();
          const dbcConn = (typeof dbcFind === "function") ? dbcFind(t.path.slice(DBC_VIEW_PREFIX.length)) : null;
          if (dbcConn && typeof openDbView === "function") openDbView(dbcConn);
          continue;
        }
        // API 调试视图（虚拟路径 \u0000http:<请求 id>）：集合存 localStorage，按 id 还原成请求标签
        if (typeof API_VIEW_PREFIX === "string" && t.path.indexOf(API_VIEW_PREFIX) === 0) {
          const apiReq = (typeof apiFind === "function") ? apiFind(t.path.slice(API_VIEW_PREFIX.length)) : null;
          if (apiReq && typeof apiOpen === "function") apiOpen(apiReq.id);
          continue;
        }
        // 定时任务管理大页（虚拟路径 \u0000cron）：不是真实文件，直接重开这个大页
        if (t.path === "\u0000cron" && typeof cronOpenView === "function") { cronOpenView(); continue; }
        if (t.path.indexOf("\u0001") >= 0) continue;
        // 其它内部虚拟视图（\u0000 前缀，如未识别的工具视图）：不是真实文件，直接跳过。
        // 否则 openFile 会去后端读一个不存在的路径，刷新后冒出「路径不存在」的错误标签
        if (t.path.indexOf("\u0000") >= 0) continue;
        await openFile(t.path, t.name, t.group || 0).catch(() => {});
      }
      if (activePath && activePath.indexOf("\u0001") < 0) {
        const tab = findTab(activePath);
        if (tab) activate(tab);
      }
      // 底部面板：恢复上次的显隐状态与当前标签（输出 / 终端 / 运行日志）
      try {
        const bp = JSON.parse(localStorage.getItem("ide.session.bottom") || "");
        if (bp && bp.show && typeof toggleBottom === "function") toggleBottom(true, bp.pane || "output");
      } catch (_) {}
    } catch (_) {}
  }
  // IDE 树中隐藏的目录：各类语言/工具的依赖与缓存目录（对任何项目生效）
  // 「显示全部」开关：开启后依赖目录（node_modules 等）也会显示，可手动展开，「全部展开」会跳过
  // 初始值从全局设置恢复（设置页 → 文件 → 显示全部；资源管理器眼睛图标与之联动）
  let showAllFiles = !!ideSettingGet("showAllFiles", false);
  let showHidden = showAllFiles;
  const TREE_IGNORE = new Set([
    "node_modules",                      // Node.js / 前端
    "__pycache__", ".venv", "venv", ".pytest_cache", ".mypy_cache",  // Python
    "vendor", "Pods",                    // PHP Composer / Go / iOS CocoaPods
    ".gradle",                           // Java / Gradle
    ".terraform",                        // Terraform
    ".git", ".svn", ".hg",               // 版本控制元数据
    ".idea", ".vscode",                  // 编辑器配置
  ]);
  // 特殊命名的中文说明从 /static/special_hints.json 加载（便于单独维护）
  let SPECIAL_NAME_HINTS = {};

  /* 系统 AI 模块的启用状态：设置页可单独停用某模块，停用后「后端接口 + 前端入口」都不可用。
     这里缓存一份，功能模块（SQL 的一句话生成、新建项目的 AI 生成…）据此决定入口是否显示。 */
  let SYS_AI_OFF = [];
  const SYS_AI_OFF_HOOKS = [];
  function sysAiOff(mod) { return SYS_AI_OFF.indexOf(mod) >= 0; }
  function onSysAiOffChange(fn) { SYS_AI_OFF_HOOKS.push(fn); try { fn(); } catch (e) { /* 忽略 */ } }
  window.refreshSysAiOff = async function () {
    try {
      const r = await fetch("/api/ai/config");
      const d = await r.json();
      SYS_AI_OFF = (d && d.sys && d.sys.off) || [];
    } catch (e) { SYS_AI_OFF = []; }
    SYS_AI_OFF_HOOKS.forEach(fn => { try { fn(); } catch (e) { /* 忽略 */ } });
  };
  window.sysAiOff = sysAiOff;
  window.onSysAiOffChange = onSysAiOffChange;

  async function apiFiles(path, showHidden) {
    const url = "/api/files?path=" + encodeURIComponent(path) + (showHidden ? "&hidden=1" : "");
    const r = await fetch(url);
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    return d;
  }
  // 加载特殊命名 → 中文含义的映射表（独立 JSON，便于维护）
  async function loadSpecialHints() {
    try {
      const r = await fetch("/static/special_hints.json");
      if (r.ok) SPECIAL_NAME_HINTS = await r.json();
    } catch (e) { /* 加载失败时维持空映射，即不显示说明 */ }
  }
  async function loadChildren(path, container, depth) {
    const spinner = document.createElement("div");
    spinner.className = "tree-row"; spinner.style.paddingLeft = (depth * 14 + 8) + "px";
    spinner.innerHTML = '<span class="twist"></span><span class="ic"><i class="bi bi-hourglass-split"></i></span><span class="nm">加载中…</span>';
    container.appendChild(spinner);
    try {
      const d = await apiFiles(path, showHidden);
      spinner.remove();
      // 附加项目（_strict）：后端遇到失效路径会「逐级回退到最近存在的上级目录」并照常返回 200，
      // 这里必须识别出来 —— 否则会把别的目录的内容当成该项目的（历史现象：子项目里显示主项目内容）。
      // 用响应里的 current_path_abs（回退后的实际目录）与请求路径比对即可判断是否发生了回退。
      if (container._strict && d.current_path_abs &&
          d.current_path_abs.replace(/\/+$/, "") !== String(path).replace(/\/+$/, "")) {
        throw new Error("路径不存在：" + path);
      }
      // 剔除依赖 / 环境目录（任何项目通用）：node_modules、venv、__pycache__ 等
      const items = (d.items || [])
        .filter(it => showAllFiles || !TREE_IGNORE.has(it.name))
        .sort((a, b) => (b.is_dir - a.is_dir) || a.name.localeCompare(b.name, "zh"));
      if (!items.length) {
        // 空目录：不插入任何占位行（展开后一片空白即表示空），
        // 只把该行的展开/收起三角藏起来；目录行本身照常可以点选 / 右键 / 收起。
        // 用 visibility 而非删除：保留 16px 占位，缩进对齐不受影响。
        const hostRow = container.previousElementSibling;
        const tw = hostRow && hostRow.querySelector(".twist");
        if (tw) tw.style.visibility = "hidden";
        return;
      }
      items.forEach(it => renderNode(it, container, depth + 1));
      applyGitDecorations(gitState.last);          // 新加载的节点也套用 Git 状态着色
    } catch (e) {
      spinner.remove();
      const er = document.createElement("div");
      er.className = "tree-row"; er.style.paddingLeft = (depth * 14 + 26) + "px"; er.style.color = "#c66";
      er.innerHTML = '<span class="nm">' + esc(e.message || "加载失败") + "</span>";
      container.appendChild(er);
    }
  }
  /* ---------- 树内联新建（仿 VS Code：在树里就地输入名称，取代模态框） ----------
     流程：目标目录自动展开并加载 → 在其子项最前面插入一个带输入框的临时行
     （默认名已填入并选中主名）→ Enter 确认 / Esc 取消 / 失焦确认。 */
  let treeNewRow = null;                  // 当前打开的内联新建行（同时只允许一个）
  // 关闭时打上 _cancelled：移除带焦点的输入框会触发 blur，若不标记会被当成「失焦确认」误创建
  function treeNewRowClose() {
    if (treeNewRow) { treeNewRow._cancelled = true; treeNewRow.remove(); treeNewRow = null; }
  }
  /* 取得某个目录的子容器：主项目根 / 附加项目分区根 / 普通目录行 */
  function treeKidsOf(dir) {
    if (!dir) return null;
    if (dir === ROOT) return explorerPanel.querySelector(":scope > .tree-children");
    const ws = [...explorerPanel.querySelectorAll(".tree-ws")].find(s => s.dataset.wsRoot === dir);
    if (ws) return ws.querySelector(":scope > .tree-children");
    const row = [...explorerPanel.querySelectorAll(".tree-row")].find(r => r.dataset.path === dir);
    if (!row) return null;
    const kids = row.nextElementSibling;
    return (kids && kids.classList.contains("tree-children")) ? kids : null;
  }
  // 行 / 子项的层级深度（renderNode 用 paddingLeft = depth*14+8 记录，与 treeWalkExpand 同一算法）
  const treeDepthOf = (row) => Math.round((parseFloat(row.style.paddingLeft || "8") - 8) / 14);
  /* 展开并（首次）加载目标目录，保证内联行有地方可插：与点击目录行的展开逻辑保持一致 */
  async function treeEnsureOpen(dir) {
    if (!dir || dir === ROOT) return;      // 主项目根始终展开
    const ws = [...explorerPanel.querySelectorAll(".tree-ws")].find(s => s.dataset.wsRoot === dir);
    if (ws) {
      const kids = ws.querySelector(":scope > .tree-children");
      if (!kids) return;
      if (!kids.classList.contains("open")) {
        kids.classList.add("open");
        const t = ws.querySelector(".tree-ws-head .twist i"); if (t) t.className = "bi bi-chevron-down";
        treeOpenDirs.add(dir); saveTreeOpenDirs();
      }
      if (!kids._loaded) { kids._loaded = true; await loadChildren(dir, kids, 0); }
      return;
    }
    const row = [...explorerPanel.querySelectorAll(".tree-row")].find(r => r.dataset.path === dir);
    if (!row) return;
    const kids = row.nextElementSibling;
    if (!kids || !kids.classList.contains("tree-children")) return;
    if (!kids.classList.contains("open")) {
      kids.classList.add("open");
      const t = row.querySelector(".twist i"); if (t) t.className = "bi bi-chevron-down";
      treeOpenDirs.add(dir); saveTreeOpenDirs();
    }
    if (!kids._loaded) { kids._loaded = true; await loadChildren(dir, kids, treeDepthOf(row)); }
  }
  /* 在 dir 下就地新建（isDir=true 新建文件夹），失败时把输入行放回来方便改名重试 */
  async function treeInlineCreate(dir, isDir, initialName) {
    dir = dir || ROOT;
    if (!dir) { toast("请先打开一个文件夹", "warn"); return; }
    treeNewRowClose();
    await treeEnsureOpen(dir);
    const box = treeKidsOf(dir);
    if (!box) { toast("找不到目标文件夹，请刷新资源管理器后重试", "err"); return; }
    // 子项层级：主项目根 / 附加项目分区根的子项为 1，普通目录为其行深度 + 1
    let depth = 1;
    if (dir !== ROOT && ![...explorerPanel.querySelectorAll(".tree-ws")].some(s => s.dataset.wsRoot === dir)) {
      const row = [...explorerPanel.querySelectorAll(".tree-row")].find(r => r.dataset.path === dir);
      if (row) depth = treeDepthOf(row) + 1;
    }
    const defName = initialName || (isDir ? "新建文件夹" : "新建文件.txt");
    const row = document.createElement("div");
    row.className = "tree-row tree-new";
    row.style.paddingLeft = (depth * 14 + 8) + "px";
    row.innerHTML = '<span class="twist"></span><span class="ic">' + iconFor(defName, isDir) + "</span>" +
      '<input class="tree-new-input" spellcheck="false" autocomplete="off">';
    const inp = row.querySelector(".tree-new-input");
    inp.value = defName;
    box.insertBefore(row, box.firstChild);          // 与 VS Code 一致：新项出现在同级最前面
    treeNewRow = row;
    // 输入期间抑制「后台变更自动刷新」的整树重建，否则打字打到一半整行会被刷掉
    holdTreeRefresh(60000);
    inp.addEventListener("input", () => {
      holdTreeRefresh(60000);                       // 边输入边续期，避免长时间输入时被自动刷新刷掉
      if (isDir) return;
      const ic = row.querySelector(".ic"), v = inp.value.trim();
      if (ic && v) ic.innerHTML = iconFor(v, false);   // 图标跟着扩展名实时变化（仿 VS Code）
    });
    inp.addEventListener("click", (e) => e.stopPropagation());
    inp.addEventListener("keydown", (e) => {
      e.stopPropagation();                          // 别让 F2 / Esc 等资源管理器快捷键接管
      if (e.key === "Enter") { e.preventDefault(); finish(true); }
      else if (e.key === "Escape") { e.preventDefault(); finish(false); }
    });
    inp.addEventListener("blur", () => finish(true));   // 失焦即确认（仿 VS Code）
    inp.focus();
    if (row.scrollIntoView) row.scrollIntoView({ block: "nearest" });   // 新建行可能在可视区之外
    // 默认名只选中主名，扩展名留在后面（新建文件.txt → 选中「新建文件」）
    const dot = isDir ? -1 : defName.lastIndexOf(".");
    if (dot > 0) inp.setSelectionRange(0, dot); else inp.select();
    let done = false;                               // Enter 与随后触发的 blur 只允许提交一次
    async function finish(commit) {
      if (done || row._cancelled) return;           // 已被新一轮输入 / 整树重建收走：不要提交
      done = true;
      const name = inp.value.trim();
      treeNewRowClose();
      treeQuietUntil = 0;                           // 收手后恢复正常自动刷新
      if (!commit || !name) return;
      if (/[\/\\]/.test(name)) { toast("名称不能包含 / 或 \\", "err"); return; }
      try {
        const r = await fetch("/api/files/create", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: dir, name: name, is_dir: !!isDir }),
        });
        const d = await r.json();
        if (d.error) throw new Error(d.error);
        toast("已创建：" + name, "ok");
        const newPath = d.path || (dir + "/" + name);
        treeSel = { path: newPath, name: name, isDir: !!isDir };   // 让刷新后新项呈选中态
        treeAnchor = newPath;
        await refreshTree();
        if (!isDir) openFile(newPath, name);
      } catch (e) {
        toast("创建失败：" + (e.message || e), "err");
        treeInlineCreate(dir, isDir, name);         // 失败：带着刚输入的名字放回输入行，方便改名重试
      }
    }
  }
  /* Seti 官方文件图标（microsoft/vscode theme-seti，本地化于 /static/vendor/seti/）：
     文件按官方映射渲染字形+官方配色；文件夹用 bootstrap 近似 VS Code 默认样式 */
  const _si = (cls, color) => '<i class="bi ' + cls + '" style="color:' + color + '"></i>';
  let SETI = null;
  fetch("/static/vendor/seti/seti-icons.json").then(r => r.ok ? r.json() : Promise.reject(new Error("http " + r.status))).then(j => {
    if (!j || !j.iconDefinitions) return;
    SETI = { defs: j.iconDefinitions, names: j.fileNames || {}, exts: j.fileExtensions || {},
             langs: j.languageIds || {}, fileDef: j.file || "_default" };
    // 仅当树已渲染（首屏用了兜底图标）时才重绘；启动早期 ROOT/树未就绪则跳过，
    // 否则会与 initTree 并发建树（这正是树显示两遍的根因）
    if (typeof refreshTree === "function" && typeof ROOT !== "undefined" && ROOT &&
        explorerPanel.querySelector(".tree-children")) {
      try { refreshTree(); } catch (e) {}
    }
  }).catch(() => {});
  const SETI_LANG = {   // 常见扩展名 → 语言 ID（vs-seti 主题按 languageId 映射）
    py: "python", pyw: "python", ipy: "python",
    js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
    ts: "typescript", tsx: "typescript",
    html: "html", htm: "html", css: "css", scss: "scss", sass: "sass", less: "less",
    json: "json", md: "markdown", markdown: "markdown",
    yml: "yaml", yaml: "yaml", sh: "shellscript", bash: "shellscript", zsh: "shellscript",
    xml: "xml", xsl: "xml",
    gitignore: "ignore", gitattributes: "ignore", gitmodules: "ignore", dockerignore: "ignore",
    // ↓ 补齐语言图标：seti 的 languageIds 收录了这些语言，但本表此前只列了上面 14 种，
    // 于是 .go/.rs/.java 等只能在 iconFor 里落到「通用灰色文件」兜底（表现为「没有图标」）。
    // 映射值必须是 seti-icons.json 的 languageIds 里真实存在的键，否则查不到图标。
    go: "go",
    mod: "go", sum: "go",
    rs: "rust",
    java: "java", jar: "java",
    php: "php", phtml: "php",
    rb: "ruby", rake: "ruby", gemspec: "ruby", erb: "erb",
    c: "c", h: "c",
    cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp", inl: "cpp",
    cs: "csharp", csx: "csharp",
    kt: "kotlin", kts: "kotlin",
    swift: "swift",
    lua: "lua",
    r: "r",
    dart: "dart",
    vue: "vue",
    ex: "elixir", exs: "elixir",
    hs: "haskell", lhs: "haskell",
    jl: "julia",
    pl: "perl", pm: "perl",
    tf: "terraform", tfvars: "terraform",
    gradle: "gradle",
    groovy: "groovy", gvy: "groovy",
    clj: "clojure", cljs: "clojure", cljc: "clojure", edn: "clojure",
    elm: "elm",
    fs: "fsharp", fsx: "fsharp", fsi: "fsharp",
    m: "objective-c", mm: "objective-cpp",
    ml: "ocaml", mli: "ocaml",
    bat: "bat", cmd: "bat",
    ps1: "powershell", psm1: "powershell", psd1: "powershell",
    tex: "latex", ltx: "latex", sty: "latex", cls: "latex", bib: "latex",
    properties: "properties", dotenv: "dotenv",
    styl: "stylus", pcss: "postcss",
    handlebars: "handlebars", hbs: "handlebars",
    njk: "nunjucks", mustache: "mustache",
  };
  // 表格类扩展名 → 官方图标别名：.et/.ett（WPS）等 SETI 未收录，复用 xls/csv 的官方表格图标
  const SHEET_ICON_ALIAS = {
    et: "xls", ett: "xls", xlsx: "xls", xlsm: "xls", xltx: "xls", xltm: "xls", xlsb: "xls", ods: "xls",
    tsv: "csv",
  };
  // 文件名 → 图标键：Go 项目里 go.mod / go.sum 等没有独立语言 ID（seti 的 fileNames 也未收录），
  // 统一借用 languageIds.go 的 _go2 图标，与 .go 文件保持同一视觉
  const SETI_NAME_ALIAS = {
    "go.mod": "_go2", "go.sum": "_go2", "go.work": "_go2", "go.work.sum": "_go2",
  };
  function iconFor(name, isDir) {
    if (isDir) return _si("bi-folder2", "#c09553");
    const lower = name.toLowerCase();
    const ext = getExt(lower);
    const setiExt = SHEET_ICON_ALIAS[ext] || ext;   // 表格格式统一取官方表格图标
    if (SETI) {
      let def = SETI.defs[SETI.names[lower]] || SETI.defs[SETI_NAME_ALIAS[lower]] || SETI.defs[SETI.exts[setiExt]];
      if (!def && SETI_LANG[ext]) def = SETI.defs[SETI.langs[SETI_LANG[ext]]];
      if (def && def.fontCharacter) {
        const code = String(def.fontCharacter).replace(/\\+/g, "");
        return '<span class="seti-ic" style="color:' + (def.fontColor || "#9da8ab") + '">&#x' + code + ";</span>";
      }
    }
    // bootstrap 兜底（映射未加载或未命中时）
    if (lower.startsWith("dockerfile")) return _si("bi-file-earmark-code", "#438eec");
    if (ext === "spec") return _si("bi-gear", "#a074c4");
    const map = {
      py:    ["bi-filetype-py", "#519aba"],
      // Go：bootstrap-icons v1.10.5 没有 filetype-go，用代码文档图标 + Go 官方色兜底
      // （正常渲染由上面的 SETI 分支负责，这里只覆盖图标数据尚未加载完的首屏瞬间）
      go:    ["bi-file-earmark-code", "#00add8"],
      mod:   ["bi-file-earmark-code", "#00add8"], sum: ["bi-file-earmark-code", "#00add8"],
      // Go：bootstrap-icons v1.10.5 没有 filetype-go，用代码文档图标 + Go 官方色兜底
      // （正常渲染由上面的 SETI 分支负责，这里只覆盖图标数据尚未加载完的首屏瞬间）
      go:    ["bi-file-earmark-code", "#00add8"],
      mod:   ["bi-file-earmark-code", "#00add8"], sum: ["bi-file-earmark-code", "#00add8"],
      html:  ["bi-filetype-html", "#e37933"], htm: ["bi-filetype-html", "#e37933"],
      css:   ["bi-filetype-css", "#519aba"], scss: ["bi-filetype-css", "#e37933"], less: ["bi-filetype-css", "#519aba"],
      js:    ["bi-filetype-js", "#cbcb41"], mjs: ["bi-filetype-js", "#cbcb41"], cjs: ["bi-filetype-js", "#cbcb41"],
      jsx:   ["bi-filetype-js", "#519aba"], ts: ["bi-filetype-js", "#519aba"], tsx: ["bi-filetype-js", "#519aba"],
      json:  ["bi-filetype-json", "#cbcb41"],
      md:    ["bi-filetype-md", "#519aba"], markdown: ["bi-filetype-md", "#519aba"],
      yml:   ["bi-filetype-yml", "#a074c4"], yaml: ["bi-filetype-yml", "#a074c4"],
      txt:   ["bi-file-earmark-text", "#6d8086"], log: ["bi-file-text", "#6d8086"], lrc: ["bi-file-text", "#6d8086"],
      ini:   ["bi-gear", "#6d8086"], cfg: ["bi-gear", "#6d8086"], conf: ["bi-gear", "#6d8086"],
      env:   ["bi-gear", "#6d8086"], toml: ["bi-gear", "#6d8086"],
      sh:    ["bi-terminal", "#4ec9b0"], bash: ["bi-terminal", "#4ec9b0"], zsh: ["bi-terminal", "#4ec9b0"],
      bat:   ["bi-terminal", "#4ec9b0"], cmd: ["bi-terminal", "#4ec9b0"], ps1: ["bi-terminal", "#4ec9b0"],
      sql:   ["bi-database", "#519aba"],
      // SQLite 数据库文件（与后端 _SQLITE_EXTS 一致）：seti 主题未收录这些扩展名，
      // 这里不显式指定就会落到默认的通用文件图标
      db:    ["bi-database", "#519aba"], sqlite: ["bi-database", "#519aba"],
      sqlite3: ["bi-database", "#519aba"], db3: ["bi-database", "#519aba"],
      xls:   ["bi-file-earmark-spreadsheet", "#8dc149"], xlsx: ["bi-file-earmark-spreadsheet", "#8dc149"],
      xlsm:  ["bi-file-earmark-spreadsheet", "#8dc149"], xlsb: ["bi-file-earmark-spreadsheet", "#8dc149"],
      et:    ["bi-file-earmark-spreadsheet", "#8dc149"], ett: ["bi-file-earmark-spreadsheet", "#8dc149"],
      ods:   ["bi-file-earmark-spreadsheet", "#8dc149"],
      csv:   ["bi-file-earmark-spreadsheet", "#8dc149"], tsv: ["bi-file-earmark-spreadsheet", "#8dc149"],
      png:   ["bi-image", "#a074c4"], jpg: ["bi-image", "#a074c4"], jpeg: ["bi-image", "#a074c4"],
      gif:   ["bi-image", "#a074c4"], svg: ["bi-image", "#a074c4"], webp: ["bi-image", "#a074c4"],
      bmp:   ["bi-image", "#a074c4"], ico: ["bi-image", "#a074c4"],
      mp4:   ["bi-film", "#dd7e2e"], webm: ["bi-film", "#dd7e2e"], mkv: ["bi-film", "#dd7e2e"],
      avi:   ["bi-film", "#dd7e2e"], mov: ["bi-film", "#dd7e2e"],
      mp3:   ["bi-music-note", "#519aba"], wav: ["bi-music-note", "#519aba"], flac: ["bi-music-note", "#519aba"],
      aac:   ["bi-music-note", "#519aba"], m4a: ["bi-music-note", "#519aba"], ogg: ["bi-music-note", "#519aba"],
      zip:   ["bi-file-earmark-zip", "#b5895f"], tar: ["bi-file-earmark-zip", "#b5895f"],
      gz:    ["bi-file-earmark-zip", "#b5895f"], rar: ["bi-file-earmark-zip", "#b5895f"], "7z": ["bi-file-earmark-zip", "#b5895f"],
    };
    const hit = map[ext];
    if (hit) return _si(hit[0], hit[1]);
    if (name.startsWith(".")) return _si("bi-file-earmark", "#6d8086");   // 其它隐藏文件
    return _si("bi-file-earmark", "#8a8a8a");
  }
  /* ---------- .gitignore 规则引擎（文件树中被忽略的条目灰色显示） ---------- */
  let giRules = null;                              // null=未加载；[]=无 .gitignore 或为空
  function giGlobRe(pat) {
    let p = pat, pre = "", post = "";
    if (p.startsWith("**/")) { pre = "(?:[^/]*/)*"; p = p.slice(3); }
    if (p.endsWith("/**")) { post = "(?:/.*)?"; p = p.slice(0, -3); }
    p = p.replace(/\/\*\*\//g, "/(?:[^/]*/)*");    // a/**/b
    let re = "";
    for (const c of p) {
      if (c === "*") re += "[^/]*";
      else if (c === "?") re += "[^/]";
      else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
    return new RegExp("^" + pre + re + post + "$");
  }
  function parseGitignoreFull(text) {
    const rules = [];
    String(text || "").split("\n").forEach(raw => {
      let s = raw.replace(/\r$/, "").trim();
      if (!s || s.startsWith("#")) return;
      let negated = false;
      if (s.startsWith("!")) { negated = true; s = s.slice(1); }
      let dirOnly = false;
      if (s.endsWith("/")) { dirOnly = true; s = s.slice(0, -1); }
      if (!s) return;
      const anchored = s.includes("/");            // 含 / 的模式锚定到根，否则匹配任意层级的同名
      if (s.startsWith("/")) s = s.slice(1);
      if (!s) return;
      rules.push({ negated, dirOnly, anchored, re: giGlobRe(s) });
    });
    return rules;
  }
  function giMatchOne(rule, rel, isDir) {
    if (rule.dirOnly && !isDir) return false;      // 目录规则只作用于目录（文件经由祖先目录被忽略）
    return rule.re.test(rule.anchored ? rel : rel.substring(rel.lastIndexOf("/") + 1));
  }
  function isGitIgnored(rel, isDir) {              // rel：相对 ROOT 的路径
    if (!giRules || !giRules.length || !rel) return false;
    const segs = rel.split("/");
    let ignored = false, prefix = "";
    for (let i = 0; i < segs.length; i++) {        // 逐段下溯：祖先目录被忽略 → 子项同样忽略
      prefix = prefix ? prefix + "/" + segs[i] : segs[i];
      for (const r of giRules) {
        if (giMatchOne(r, prefix, i < segs.length - 1 ? true : isDir)) ignored = !r.negated;
      }
    }
    return ignored;
  }
  function loadGitignoreRules() {                  // 读取根 .gitignore 并重算树中灰色状态
    return loadFileText(ROOT + "/.gitignore", ".gitignore")
      .then(d => { giRules = parseGitignoreFull(d.text); })
      .catch(() => { giRules = []; })
      .then(() => applyGiDecorations());
  }
  function applyGiDecorations() {                  // 对已渲染的树行重算灰色状态（无需重新拉目录）
    if (!giRules) return;
    document.querySelectorAll(".tree-row").forEach(r => {
      const full = r.dataset.path;
      if (!full) return;
      const isDir = r.dataset.isdir === "1";
      const dim = (isDir && TREE_IGNORE.has(r.dataset.name)) ||
        isGitIgnored(full.startsWith(ROOT + "/") ? full.slice(ROOT.length + 1) : full, isDir);
      r.classList.toggle("tree-ignored", dim);
    });
  }

  // ---------- 资源管理器多选支持（Shift 范围选择 / Ctrl 点选累加） ----------
  let treeAnchor = null;          // 范围选择的锚点行路径（普通点击 / Ctrl 点击更新，Shift 点击沿用）
  // 文件树展开状态持久化：记住展开的目录路径（含附加项目分区根），
  // 刷新页面后逐层恢复之前的展开状态。存入 ide.settings 的 treeOpenDirs。
  let treeOpenDirs = (() => {
    const v = ideSettingGet("treeOpenDirs", []);
    return new Set(Array.isArray(v) ? v.filter(x => typeof x === "string" && x) : []);
  })();
  function saveTreeOpenDirs() {
    let arr = [...treeOpenDirs];
    if (arr.length > 800) arr = arr.slice(-800);   // 防止长期使用无限增长
    ideSettingSet("treeOpenDirs", arr);
  }
  function visibleTreeRows() {    // 当前可见（所有祖先目录均已展开）的树行，按 DOM 顺序
    return [...explorerPanel.querySelectorAll(".tree-row")].filter(r => {
      let p = r.parentElement;
      while (p && p !== explorerPanel) {
        if (p.classList.contains("tree-children") && !p.classList.contains("open")) return false;
        p = p.parentElement;
      }
      return true;
    });
  }
  function setTreeSelFromRow(r) { // 让 treeSel 指向某行（供 F2 / Delete / Ctrl+C 等快捷键使用）
    if (r) treeSel = { path: r.dataset.path, name: r.dataset.name, isDir: r.dataset.isdir === "1" };
  }
  function treeSelectedItems() {  // 当前选中的树行（按 DOM 顺序）：供「添加到 AI 对话」等批量操作使用
    return [...explorerPanel.querySelectorAll(".tree-row.selected")]
      .map(r => ({ path: r.dataset.path, name: r.dataset.name, isDir: r.dataset.isdir === "1" }));
  }

  function renderNode(it, container, depth) {
    const full = (it.path && it.path.startsWith("/")) ? it.path : container._base + "/" + it.name;
    const row = document.createElement("div");
    row.className = "tree-row";
    row.tabIndex = -1;                       // 可聚焦：F2 / Delete / Ctrl+Enter 等快捷键作用于选中项
    row.style.paddingLeft = (depth * 14 + 8) + "px";
    row.dataset.path = full;
    row.dataset.name = it.name;
    row.dataset.isdir = it.is_dir ? "1" : "0";
    // 依赖目录弱化显示，可手动展开（仅「全部展开」会跳过）；.gitignore 命中的条目同样灰色
    const isIgnored = (it.is_dir && TREE_IGNORE.has(it.name)) ||
      (giRules && giRules.length && isGitIgnored(full.startsWith(ROOT + "/") ? full.slice(ROOT.length + 1) : full, !!it.is_dir));
    if (isIgnored) row.classList.add("tree-ignored");
    const twist = it.is_dir ? '<span class="twist"><i class="bi bi-chevron-right"></i></span>' : '<span class="twist"></span>';
    const hint = SPECIAL_NAME_HINTS[it.name] ? '<span class="nm-hint">' + esc(SPECIAL_NAME_HINTS[it.name]) + '</span>' : "";
    row.innerHTML = twist + '<span class="ic">' + iconFor(it.name, it.is_dir) + '</span><span class="nm">' + esc(it.name) + '</span>' + hint;
    container.appendChild(row);

    const kids = document.createElement("div");
    kids.className = "tree-children"; kids._base = full; kids._loaded = false;
    container.appendChild(kids);

    row.addEventListener("click", (e) => {
      e.stopPropagation();
      const allSel = () => [...explorerPanel.querySelectorAll(".tree-row.selected")];
      const focusRow = () => { try { row.focus({ preventScroll: true }); } catch (_) { row.focus(); } };

      // Shift+点击：从「锚点」到当前行做范围选择（不打开文件 / 不展开目录）
      if (e.shiftKey && treeAnchor) {
        const vis = visibleTreeRows();
        const iA = vis.findIndex(r => r.dataset.path === treeAnchor);
        const iB = vis.findIndex(r => r.dataset.path === full);
        if (iA >= 0 && iB >= 0) {
          allSel().forEach(r => r.classList.remove("selected"));
          const [s, t] = iA < iB ? [iA, iB] : [iB, iA];
          for (let i = s; i <= t; i++) vis[i].classList.add("selected");
          setTreeSelFromRow(row);
          focusRow();
          return;
        }
      }

      // Ctrl / Cmd+点击：切换当前行的选中状态（累加多选，不打开文件 / 不展开目录）
      if (e.ctrlKey || e.metaKey) {
        const nowSel = row.classList.toggle("selected");
        treeAnchor = full;
        setTreeSelFromRow(nowSel ? row : (allSel().slice(-1)[0] || row));
        focusRow();
        return;
      }

      // 普通点击：清空其它选中，只选中当前行（保持原有「打开文件 / 展开目录」行为）
      allSel().forEach(r => r.classList.remove("selected"));
      row.classList.add("selected");
      treeAnchor = full;
      // 记录选中项并让其可聚焦：这样 F2 / Delete / Ctrl+Enter / Ctrl+C 等按键才作用于资源管理器
      setTreeSelFromRow(row);
      focusRow();
      if (it.is_dir) {
        const willOpen = !kids.classList.contains("open");
        kids.classList.toggle("open", willOpen);
        row.querySelector(".twist i").className = "bi " + (willOpen ? "bi-chevron-down" : "bi-chevron-right");
        if (willOpen) {
          treeOpenDirs.add(full);                       // 展开状态持久化
          if (!kids._loaded) { kids._loaded = true; loadChildren(full, kids, depth); }
        } else {
          treeOpenDirs.delete(full);
        }
        saveTreeOpenDirs();
      } else {
        openFile(full, it.name);
      }
    });
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault(); e.stopPropagation();
      // 右键：若该行不在多选集合里，则先把它变成唯一选中项（与 VS Code 一致，避免批量操作误伤其它选中项）
      if (!row.classList.contains("selected")) {
        explorerPanel.querySelectorAll(".tree-row.selected").forEach(r => r.classList.remove("selected"));
        row.classList.add("selected");
        treeAnchor = full;
        setTreeSelFromRow(row);
        try { row.focus({ preventScroll: true }); } catch (_) { row.focus(); }
      }
      showCtxMenu(e.clientX, e.clientY, full, it.name, it.is_dir);
    });
  }

  /* ---------- 全部展开 / 全部折叠 ---------- */
  // 递归展开：目录未加载过则先异步加载再继续深入
  async function treeWalkExpand(container) {
    const rows = [...container.children].filter(el =>
      el.classList.contains("tree-row") && el.dataset.isdir === "1");
    for (const row of rows) {
      if (TREE_IGNORE.has(row.dataset.name)) continue;   // 依赖目录不参与全部展开
      const kids = row.nextElementSibling;
      if (!kids || !kids.classList.contains("tree-children")) continue;
      const twist = row.querySelector(".twist i");
      if (twist) twist.className = "bi bi-chevron-down";
      kids.classList.add("open");
      const depth = (parseFloat(row.style.paddingLeft) - 8) / 14;
      if (!kids._loaded) { kids._loaded = true; await loadChildren(kids._base, kids, depth); }
      await treeWalkExpand(kids);
    }
  }
  async function treeExpandAll() {
    const root = ROOT && explorerPanel.querySelector(".tree-children");
    if (root) await treeWalkExpand(root).catch(e => toast("展开失败：" + (e.message || e), "err"));
    syncTreeOpenDirsFromDom();   // 展开状态持久化
    syncTreeToggleBtn();
  }
  function treeCollapseAll() {
    explorerPanel.querySelectorAll(".tree-children.open").forEach(k => {
      const row = k.previousElementSibling;
      // 根容器（前一个兄弟不是 tree-row）保持展开，否则整棵树会被隐藏
      if (!row || !row.classList.contains("tree-row")) return;
      k.classList.remove("open");
      const t = row.querySelector(".twist i");
      if (t) t.className = "bi bi-chevron-right";
    });
    syncTreeOpenDirsFromDom();   // 折叠状态持久化
    syncTreeToggleBtn();
  }
  /* 从当前 DOM 收集展开中的目录路径并持久化（全部展开 / 全部折叠后调用） */
  function syncTreeOpenDirsFromDom() {
    treeOpenDirs = new Set();
    explorerPanel.querySelectorAll(".tree-children.open").forEach(k => {
      // 根容器（前一个兄弟不是 tree-row，主项目根 / 未加载分区）不计入
      if (k._base && k.previousElementSibling && k.previousElementSibling.classList.contains("tree-row")) treeOpenDirs.add(k._base);
    });
    saveTreeOpenDirs();
  }
  /* 树上是否有展开着的子目录（根容器不算）——用于切换按钮状态 */
  function treeHasOpenDirs() {
    const open = explorerPanel.querySelectorAll(".tree-children.open");
    for (const k of open) {
      const row = k.previousElementSibling;
      if (row && row.classList.contains("tree-row")) return true;
    }
    return false;
  }
  function syncTreeToggleBtn() {
    const btn = $("sideTreeToggle");
    const anyOpen = treeHasOpenDirs();
    btn.querySelector("i").className = anyOpen ? "bi bi-arrows-collapse" : "bi bi-arrows-expand";
    btn.title = anyOpen ? "全部折叠" : "全部展开";
  }

  /* ---------- 抑制「后台变更自动刷新」的整树重建（配合 19_ 的轮询） ----------
     本端已经在 DOM 里精确增删过节点时（如删除文件），再整树重建只会打断展开状态、
     造成"文件列表自己折叠"的观感；调用后一段时间内只更新轮询签名基线、不重建。 */
  let treeQuietUntil = 0;
  function holdTreeRefresh(ms) { treeQuietUntil = Date.now() + (ms || 6000); }

  /* ---------- 刷新资源管理器：重建目录树并恢复刷新前展开的目录 ----------
     同时保留：选中项（自动刷新时不打断用户当前操作）与滚动位置
     注意：全项目「唯一」的 refreshTree 实现在这里；其它文件不要再声明同名函数，
           否则会静默覆盖它（同一 IIFE 内后声明者生效），自动刷新就会把整棵树折叠。 */
  async function refreshTree() {
    if (!ROOT) return;
    treeNewRowClose();                 // 重建会连带删掉内联新建行，先主动收掉（避免其失焦后误提交）
    const openBases = new Set();
    explorerPanel.querySelectorAll(".tree-children.open").forEach(k => { if (k._base) openBases.add(k._base); });
    const prevScroll = explorerPanel.scrollTop;
    const prevSelPath = treeSel ? treeSel.path : "";
    treeSel = null;
    treeAnchor = null;
    explorerPanel.innerHTML = "";
    const root = document.createElement("div");
    root.className = "tree-children open"; root._base = ROOT; root._loaded = true;
    explorerPanel.appendChild(root);
    try {
      await loadChildren(ROOT, root, 0);
      // 恢复刷新前处于展开状态的目录（逐层异步加载，与单击展开行为一致）
      const restore = async (container) => {
        for (const kids of container.children) {
          if (!kids.classList || !kids.classList.contains("tree-children")) continue;
          const row = kids.previousElementSibling;
          if (!row || !row.classList.contains("tree-row")) continue;
          if (kids._base && openBases.has(kids._base)) {
            kids.classList.add("open");
            const t = row.querySelector(".twist i");
            if (t) t.className = "bi bi-chevron-down";
            if (!kids._loaded) {
              kids._loaded = true;
              const pad = parseFloat(row.style.paddingLeft);
              const depth = isNaN(pad) ? 0 : (pad - 8) / 14;
              await loadChildren(kids._base, kids, depth);
            }
            await restore(kids);
          }
        }
      };
      await restore(root);
      renderExtraRoots(openBases);            // 附加项目分区一并重建（openBases 已记录其展开态）
      // 恢复选中项与滚动位置
      if (prevSelPath) {
        const row = [...explorerPanel.querySelectorAll(".tree-row")].find(r => r.dataset.path === prevSelPath);
        if (row) {
          row.classList.add("selected");
          treeSel = { path: prevSelPath, name: row.dataset.name, isDir: row.dataset.isdir === "1" };
          treeAnchor = prevSelPath;
        }
      }
      explorerPanel.scrollTop = prevScroll;
    } catch (e) { toast("刷新失败：" + (e.message || e), "err"); }
    syncTreeToggleBtn();
  }
  $("sideRefresh").onclick = () => refreshTree();

  /* ---------- 资源管理器空白处 / 项目根标题行右键菜单（仿 VS Code 工作区菜单） ----------
     树节点的右键菜单在 renderNode 里（showCtxMenu）；这里补上「空白区域」与项目根标题行，
     两者都以整个工作区根目录为操作对象。 */
  explorerPanel.addEventListener("contextmenu", (e) => {
    if (!ROOT) return;
    if (e.target.closest && e.target.closest(".tree-row")) return;   // 行内右键由各行的处理器负责
    e.preventDefault();
    showTreeBgMenu(e.clientX, e.clientY, ROOT, null);
  });
  {
    const sr = $("sideRoot");
    if (sr) sr.addEventListener("contextmenu", (e) => {
      if (!ROOT) return;
      e.preventDefault();
      showTreeBgMenu(e.clientX, e.clientY, ROOT, null);
    });
  }

  /* ---------- 多根工作区：在主项目之外追加更多项目，资源管理器里同级显示 ----------
     附加项目持久记忆（ide.settings 的 extraRoots），刷新页面后仍在；
     点击折叠占位区 / 无主项目引导卡里的「打开文件夹…」即可追加。
     注意：搜索 / Git / 终端等仍以主项目（ROOT）为准，附加项目主要提供浏览与编辑。 */
  let extraRoots = (() => {
    const v = ideSettingGet("extraRoots", []);
    // 只接受绝对路径：早期「打开文件夹」支持手输，可能存进了相对路径（如 "m3u8_web"），
    // 那种路径会失效并被后端回退，表现为「子项目里显示的是别的项目内容」，这里顺手清掉。
    const raw = Array.isArray(v) ? v : [];
    const list = raw.filter(x => typeof x === "string" && x.startsWith("/"));
    if (list.length !== raw.length) ideSettingSet("extraRoots", list);
    return list;
  })();
  function saveExtraRoots() { ideSettingSet("extraRoots", extraRoots); }

  /* 渲染一个「附加项目」分区：标题行（点击折叠 / 展开）+ 文件树容器 */
  function renderWorkspaceFolder(base, opts) {
    const open = !opts || opts.open !== false;
    const sec = document.createElement("div");
    sec.className = "tree-ws";
    sec.dataset.wsRoot = base;
    const head = document.createElement("div");
    head.className = "tree-row tree-ws-head";
    head.tabIndex = -1;
    head.style.paddingLeft = "4px";
    head.innerHTML =
      '<span class="twist"><i class="bi ' + (open ? "bi-chevron-down" : "bi-chevron-right") + '"></i></span>' +
      '<span class="ic">' + iconFor(baseName(base) || base, true) + '</span>' +
      '<span class="nm">' + esc(baseName(base) || base) + '</span>' +
      '<span class="ws-rm" title="从工作区移除该项目"><i class="bi bi-x-lg"></i></span>';
    const kids = document.createElement("div");
    kids.className = "tree-children" + (open ? " open" : "");
    kids._base = base; kids._loaded = false;
    kids._strict = true;   // 附加项目：路径失效要报错，不接受后端「向上回退」后的内容
    sec.appendChild(head); sec.appendChild(kids);
    head.addEventListener("click", (e) => {
      if (e.target.closest(".ws-rm")) return;
      const show = !kids.classList.contains("open");
      kids.classList.toggle("open", show);
      head.querySelector(".twist i").className = "bi " + (show ? "bi-chevron-down" : "bi-chevron-right");
      if (show) {
        treeOpenDirs.add(base);   // 分区展开状态持久化
        if (!kids._loaded) { kids._loaded = true; loadChildren(base, kids, 0); }
      } else {
        treeOpenDirs.delete(base);
      }
      saveTreeOpenDirs();
    });
    // 从工作区移除该项目：标题行 × 与右键菜单共用同一实现
    head.querySelector(".ws-rm").addEventListener("click", (e) => {
      e.stopPropagation();
      removeWorkspaceFolder(base);
    });
    // 右键附加项目标题行：弹出「工作区分区」菜单（含「将文件夹从工作区移除」）
    head.addEventListener("contextmenu", (e) => {
      e.preventDefault(); e.stopPropagation();
      showTreeBgMenu(e.clientX, e.clientY, base, base);
    });
    explorerPanel.appendChild(sec);
    if (open) { kids._loaded = true; loadChildren(base, kids, 0); }
    return kids;
  }
  function updateSideRootName() {   // 根目录行显示主项目名 + 附加项目数
    if (!ROOT) return;
    const n = extraRoots.length;
    $("sideRootName").textContent = (baseName(ROOT) || ROOT) + (n ? "（+" + n + " 个项目）" : "");
  }
  /* initTree / refreshTree 共用：主树渲染完后把附加项目分区补回来
     （refreshTree 传 openBases 按运行时 DOM 恢复；initTree 不传则按持久化的展开状态决定） */
  function renderExtraRoots(openBases) {
    extraRoots.forEach(b => renderWorkspaceFolder(b, { open: openBases ? openBases.has(b) : treeOpenDirs.has(b) }));
    updateSideRootName();
  }
  function addWorkspaceFolder(path) {
    if (!path || !String(path).startsWith("/")) { toast("只能添加绝对路径的文件夹", "err"); return false; }
    if (path === ROOT) { toast("该文件夹已是主项目"); return false; }
    if (extraRoots.includes(path)) { toast("该项目已在工作区中"); return false; }
    extraRoots.push(path); saveExtraRoots();
    renderWorkspaceFolder(path, { open: true });
    updateSideRootName();
    toast("已添加项目：" + (baseName(path) || path), "ok");
    return true;
  }
  /* 从工作区移除一个附加项目（标题行 × 与右键菜单共用）：清持久化 + 移除对应 DOM 分区 */
  function removeWorkspaceFolder(base) {
    if (!base || !extraRoots.includes(base)) return;
    extraRoots = extraRoots.filter(x => x !== base); saveExtraRoots();
    const sec = [...explorerPanel.querySelectorAll(".tree-ws")].find(s => s.dataset.wsRoot === base);
    if (sec) sec.remove();
    updateSideRootName();
    toast("已从工作区移除：" + (baseName(base) || base));
  }
  /* 追加项目后确保它真的看得见：文件树折叠时先自动展开，再滚动到该项目分区。
     （折叠状态下 #explorerPanel 是 display:none，新分区会被藏起来，看起来像「点了没反应」） */
  function revealWorkspaceFolder(base) {
    if (ideSettingGet("explorerCollapsed", false)) {
      ideSettingSet("explorerCollapsed", false);
      explorerPanel.classList.remove("tree-hidden");
      const op = $("sideRootOpen"); if (op) op.style.display = "none";
      const chev = $("sideRootChevron"); if (chev) chev.className = "bi bi-chevron-down";
    }
    const sec = [...explorerPanel.querySelectorAll(".tree-ws")].find(s => s.dataset.wsRoot === base);
    if (sec && sec.scrollIntoView) sec.scrollIntoView({ block: "nearest" });
  }

  /* 页面加载后恢复持久化的展开状态：只在 treeOpenDirs 里的目录逐层展开（懒加载），
     覆盖主项目树与附加项目分区；已删除 / 不存在的路径自动跳过（不清理也无副作用） */
  async function restoreTreeOpenDirs() {
    const walk = async (container) => {
      const rows = [...container.children].filter(el => el.classList.contains("tree-row") && el.dataset.isdir === "1");
      for (const row of rows) {
        if (!treeOpenDirs.has(row.dataset.path)) continue;
        const kids = row.nextElementSibling;
        if (!kids || !kids.classList.contains("tree-children")) continue;
        kids.classList.add("open");
        const t = row.querySelector(".twist i");
        if (t) t.className = "bi bi-chevron-down";
        if (!kids._loaded) {
          kids._loaded = true;
          const pad = parseFloat(row.style.paddingLeft);
          await loadChildren(kids._base, kids, isNaN(pad) ? 0 : (pad - 8) / 14);
        }
        await walk(kids);
      }
    };
    // 顶层容器：主项目根 + 各附加项目分区
    const tops = [];
    explorerPanel.querySelectorAll(":scope > .tree-children, :scope > .tree-ws > .tree-children")
      .forEach(k => tops.push(k));
    for (const k of tops) await walk(k);
    syncTreeToggleBtn();
  }

  async function initTree() {
    if (ROOT) addRecentFolder(ROOT);   // 通过 URL 直接打开的文件夹也记入「最近打开」
    if (!ROOT) {
      // 空工作区：居中的引导卡片（比左上角挤两行字更清晰美观）
      explorerPanel.style.display = "flex";          // 让引导卡片在面板内垂直居中
      explorerPanel.style.flexDirection = "column";
      explorerPanel.innerHTML =
        '<div class="empty-workspace">' +
          '<i class="bi bi-folder2-open"></i>' +
          '<div class="ew-title">未打开文件夹</div>' +
          '<div class="ew-sub">选择一个文件夹，开始浏览与编辑</div>' +
          '<button class="g-btn outline" id="ewOpenBtn"><i class="bi bi-folder-symlink"></i> 打开文件夹…</button>' +
        '</div>';
      const btn = $("ewOpenBtn");
      if (btn) btn.onclick = () => openFolderDialog();
      explorerPanel.classList.remove("tree-hidden");   // 无工作区视图始终可见
      $("sideRootOpen").style.display = "none";        // 空工作区不需要折叠占位区
      return;
    }
    updateSideRootName();
    // 折叠占位区里的「打开文件夹」入口（绑定一次即可，onclick 重复赋值无副作用）
    const _openBtn = $("sideOpenFolderBtn");
    if (_openBtn) _openBtn.onclick = () => openFolderDialog();
    // 全局配置最优先：构建 / 加载树之前就应用折叠状态，
    // 避免先看到「加载中…」再闪一下才收起。
    // 注意：用类名（tree-hidden）而非内联 display，否则会被 showPanel 的显隐管理清掉
    const _explorerCollapsed = !!ideSettingGet("explorerCollapsed", false);
    explorerPanel.classList.toggle("tree-hidden", _explorerCollapsed);
    $("sideRootOpen").style.display = _explorerCollapsed ? "" : "none";
    {
      const chev = $("sideRootChevron");
      if (chev) chev.className = "bi " + (_explorerCollapsed ? "bi-chevron-right" : "bi-chevron-down");
    }
    // 根目录行点击 = 折叠 / 展开整个文件树（仿 VS Code 根目录折叠），状态持久记忆
    $("sideRoot").onclick = () => {
      const tree = $("explorerPanel");
      const show = tree.classList.contains("tree-hidden");   // 当前是收起 → 展开
      tree.classList.toggle("tree-hidden", !show);
      $("sideRootOpen").style.display = show ? "none" : "";  // 折叠时显示「打开文件夹」占位区
      const chev = $("sideRootChevron");
      if (chev) chev.className = "bi " + (show ? "bi-chevron-down" : "bi-chevron-right");
      ideSettingSet("explorerCollapsed", !show);
    };
    $("tbTitle").textContent = "在线项目 IDE — " + baseName(ROOT);
    $("welcomeSub").textContent = "项目：" + baseName(ROOT) + "\n从左侧资源管理器选择文件开始编辑。";
    explorerPanel.innerHTML = "";                 // 防御重复建树：先清空再追加（并发触发时只保留最后一次）
    const root = document.createElement("div");
    root.className = "tree-children open"; root._base = ROOT; root._loaded = true;
    explorerPanel.appendChild(root);
    await loadChildren(ROOT, root, 0);
    renderExtraRoots();                      // 主项目树之后渲染附加项目分区（同级显示）
    await restoreTreeOpenDirs().catch(() => {});   // 恢复上次刷新前的展开状态（含附加项目分区）
    syncTreeToggleBtn();
  }

  /* ---------- CodeMirror 模式动态加载 ---------- */
  const MODES = {
    js: ["javascript", "javascript.min.js"], ts: ["javascript", "javascript.min.js"], jsx: ["javascript", "javascript.min.js"],
    json: ["javascript", "javascript.min.js"], mjs: ["javascript", "javascript.min.js"], cjs: ["javascript", "javascript.min.js"],
    py: ["python", "python.min.js"], html: ["htmlmixed", "htmlmixed.min.js"], htm: ["htmlmixed", "htmlmixed.min.js"],
    xml: ["xml", "xml.min.js"], css: ["css", "css.min.js"], scss: ["css", "css.min.js"], less: ["css", "css.min.js"],
    md: ["markdown", "markdown.min.js"], c: ["clike", "clike.min.js"], cpp: ["clike", "clike.min.js"], h: ["clike", "clike.min.js"],
    hpp: ["clike", "clike.min.js"], java: ["clike", "clike.min.js"], cs: ["clike", "clike.min.js"], go: ["go", "go.min.js"],
    rs: ["clike", "clike.min.js"], php: ["php", "php.min.js"], rb: ["ruby", "ruby.min.js"], sh: ["shell", "shell.min.js"],
    bash: ["shell", "shell.min.js"], yml: ["yaml", "yaml.min.js"], yaml: ["yaml", "yaml.min.js"],
    toml: ["properties", "properties.min.js"], ini: ["properties", "properties.min.js"], conf: ["properties", "properties.min.js"],
    sql: ["sql", "sql.min.js"], lua: ["lua", "lua.min.js"],
  };
  const _loaded = new Set(), _promises = {};
  function ensureMode(ext) {
    const m = MODES[ext]; if (!m) return Promise.resolve(null);
    const [mode, rel] = m;
    if (_loaded.has(mode)) return Promise.resolve(mode);
    if (_promises[mode]) return _promises[mode];
    const deps = mode === "htmlmixed" ? ["xml.min.js", "css.min.js", "javascript.min.js"] : [];
    const p = new Promise((resolve) => {
      let pending = deps.length + 1;
      const done = () => { if (--pending === 0) { _loaded.add(mode); resolve(mode); } };
      const loadOne = (r) => {
        const s = document.createElement("script");
        s.src = BASE + r;
        s.onload = done;
        s.onerror = () => { pending--; if (pending <= 0) { _loaded.add(mode); resolve(mode); } };
        document.head.appendChild(s);
      };
      loadOne(rel); deps.forEach(loadOne);
    });
    _promises[mode] = p; return p;
  }

  /* ---------- 打开/切换标签 ---------- */
  function findTab(path) { return tabs.find(t => t.path === path); }

  // 大文件阈值：超过则关闭语法高亮与全量脏值比对，保证流畅
  const BIG_FILE_BYTES = 400 * 1024;

  // 查找/替换对话框的中文文案（CodeMirror 的 phrases 选项）
  const CM_PHRASES = {
    "Search:": "查找：",
    "Replace:": "替换：",
    "Replace with:": "替换为：",
    "Replace all:": "全部替换为：",
    "Replace?": "是否替换？",
    "With:": "替换为：",
    "(Use /re/ syntax for regexp search)": "（支持 /正则/ 语法）",
    "All": "全部",
    "Yes": "是",
    "No": "否",
    "Stop": "停止",
  };

  // raw=1：后端直接返回纯文本，省去 base64(膨胀33%) + JSON解析 + atob，大文件快很多
  async function loadFileText(path, name) {
    const r = await fetch("/api/preview?path=" + encodeURIComponent(path) + "&raw=1");
    let body = "";
    if (r.headers.get("X-Preview-Type") === "text") {
      body = await r.text();
      return { text: body, size: parseInt(r.headers.get("X-File-Size") || "0", 10) || 0 };
    }
    // 后端未升级（没有 raw 支持）时，回退到老的 JSON + base64 接口，保证仍能打开文件
    try { body = await r.text(); } catch (_) {}
    if (r.ok) {
      try {
        const d = JSON.parse(body);
        if (d.type === "text" && d.content) {
          const bytes = Uint8Array.from(atob(d.content), c => c.charCodeAt(0));
          return { text: new TextDecoder("utf-8").decode(bytes), size: bytes.length };
        }
        if (!d.type) return { unsupported: true };
      } catch (_) {}
      return { unsupported: true };
    }
    let msg = "服务器响应异常 (HTTP " + r.status + ")";
    try { const d = JSON.parse(body); if (d && d.error) msg = d.error; } catch (_) {}
    return { error: msg };
  }

  // 多次延迟重绘：字体/CSS 延迟就绪或容器刚显示时，避免编辑器空白或行号错位
  function scheduleRefresh(tab) {
    if (!tab || !tab.cm) return;
    const doIt = () => { if (tab.cm) tab.cm.refresh(); };
    requestAnimationFrame(doIt);
    setTimeout(doIt, 60);
    setTimeout(doIt, 300);
  }

  function fmtSize(n) {
    if (!n) return "0 B";
    const u = ["B", "KB", "MB", "GB"];
    let i = 0, v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return (i === 0 ? v : v.toFixed(1)) + " " + u[i];
  }

  // 路径规范化：不同入口可能给出 "a//b"、"a/./b"、相对路径等写法，
  // 统一成绝对路径后才能命中同一个标签（否则同一文件会被重复打开）
  function canonPath(p) {
    if (!p) return p;
    let s = String(p).replace(/\\/g, "/");
    if (!s.startsWith("/") && ROOT) s = ROOT + "/" + s;   // 相对路径补上工作区前缀
    const parts = [];
    s.split("/").forEach(seg => {
      if (!seg || seg === ".") return;
      if (seg === "..") { parts.pop(); return; }
      parts.push(seg);
    });
    return (s.startsWith("/") ? "/" : "") + parts.join("/");
  }
  async function openFile(path, name, forceGroup, forceText) {
    path = canonPath(path);
    // forceGroup 指定目标编辑组（拆分编辑器用）；不指定时全局查找已有标签并聚焦
    let tab = forceGroup == null ? findTab(path) : tabs.find(t => t.path === path && t.group === forceGroup);
    // 播放器全局唯一：已存在视频标签页时（正在播放另一个视频），复用该标签页切换到新视频，
    // 旧播放器由 setupVideoView 开头的 _vpvCleanupRun 暂停并释放流（DOM 摘除不会自动停），「播放另一个自动切换播放」；
    // 点的就是当前视频则只聚焦。其余文件类型不受影响。
    if (!forceText && (window.IDE_VIDEO_EXTS || []).includes(getExt(name)) && typeof window.setupVideoView === "function") {
      const vt = tabs.find(t => t.isVideo);
      if (vt) {
        if (vt.path !== path) {
          vt.path = path; vt.name = name; vt.dirty = false; vt.big = false; vt.cm = null;
          renderTabsAll();
          activate(vt);
          setupVideoView(vt, vt.host, path, name);
        } else {
          activate(vt);
        }
        return;
      }
    }
    if (!tab) {
      const host = document.createElement("div");
      host.className = "cm-host";
      const grp = forceGroup == null ? curGroup : forceGroup;
      tab = { path, name, host, cm: null, original: "", dirty: false, big: false, group: grp };
      tabs.push(tab);
      renderTabsAll();
      const seq = ++openSeq;           // 本次打开的序号；await 期间用户又点了别的文件则 seq 过期
      const wasActive = active;        // 记录打开前的活动标签，用于判断用户是否中途切换
      // 只切 host 显示（同组其它 host 先取消 active，避免两个「加载中」同时可见）；
      // 完整 activate 留到内容就绪后，避免 CodeMirror 在不可见容器里测量出错
      tabs.forEach(t => { if (t !== tab && t.group === grp) t.host.classList.remove("active"); });
      host.classList.add("active");
      host.innerHTML = '<div style="padding:30px;color:#888;">正在加载 ' + esc(name) + ' …</div>';
      try {
        const ext = getExt(name);
        // 图片类型：内嵌图片预览（后端 raw=1 直接返回图片字节），点击图片切换 1:1 / 适应窗口
        if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg"].includes(ext)) {
          tab.isImage = true;
          const url = "/api/preview?path=" + encodeURIComponent(path) + "&raw=1";
          host.innerHTML =
            '<div class="img-preview"><img alt="' + esc(name) + '" src="' + url + '">' +
            '<div class="ip-err" style="display:none;">图片加载失败（可能超出 50MB 预览限制）</div></div>';
          const im = host.querySelector("img");
          im.addEventListener("error", () => {
            im.style.display = "none";
            host.querySelector(".ip-err").style.display = "block";
          });
          im.addEventListener("click", () => im.classList.toggle("zoom"));
          activate(tab);   // 挂载编辑组容器并高亮标签（与文本文件打开行为一致）
          return;
        }
        // SQLite 数据库：只读表格查看器（表列表 + 分页数据），不做文本编辑
        if (["db", "sqlite", "sqlite3", "db3"].includes(ext)) {
          activate(tab);   // activate 是本闭包内函数，须在这里调用（同图片分支）
          setupSqliteView(tab, host, path, name);
          return;
        }
        // 电子表格：可编辑表格视图（xlsx/xlsm 读写、csv/tsv 读写、xls/et 只读）
        if (!forceText && ["xlsx", "xlsm", "xltx", "xltm", "xls", "et", "ett", "csv", "tsv"].includes(ext)) {
          activate(tab);
          setupSheetView(tab, host, path, name);
          return;
        }
        // 视频类型：标签页内嵌播放器（实现见 22_视频播放器 js，交互参考文件管理器桌面版）
        if (!forceText && (window.IDE_VIDEO_EXTS || []).includes(ext) && typeof window.setupVideoView === "function") {
          activate(tab);
          setupVideoView(tab, host, path, name);
          return;
        }
        // 文件内容与语法模式并行加载，减少串行等待
        const [res, mode] = await Promise.all([loadFileText(path, name), ensureMode(ext)]);
        // 不支持 / 打开失败：同样要走激活（否则只有内容切了、标签不高亮、面包屑还是旧文件）；
        // 竞态防护与正常路径一致：用户已切走就不抢焦点，提示信息留在后台标签里
        if (res.unsupported || res.error) {
          host.innerHTML = res.unsupported
            ? '<div style="padding:30px;color:#888;">该文件类型（' + ext + '）不支持文本编辑，预览请用文件管理器。</div>'
            : '<div style="padding:30px;color:#c66;">无法打开：' + esc(res.error) + '</div>';
          if (active === tab) return;
          if (seq === openSeq && active === wasActive) activate(tab);
          return;
        }
        const text = res.text;
        const big = text.length > BIG_FILE_BYTES;
        tab.original = text;
        tab.big = big;
        host.innerHTML = "";
        // 容器此刻已可见（active），CodeMirror 才能测量正确，避免内容压住行号/错位
        tab.cm = CodeMirror(host, {
          value: text, mode: big ? "text/plain" : (mode || "text/plain"), theme: ideThemeLight() ? "default" : "material-darker",
          lineNumbers: true, lineWrapping: IDE_SETTINGS.lineWrap, indentUnit: IDE_SETTINGS.indent, tabSize: IDE_SETTINGS.indent,
          styleActiveLine: IDE_SETTINGS.activeLine && !big, matchBrackets: !big, autoCloseBrackets: true,
          phrases: CM_PHRASES,
        });
        // 代码补全（仿 VS Code IntelliSense）：候选来源与触发逻辑见 37_ 模块
        if (typeof cmAttachCompletion === "function") cmAttachCompletion(tab.cm, ext);
        if (big) toast("文件较大（" + fmtSize(res.size || text.length) + "），已关闭语法高亮以保证编辑流畅", "warn");
        tab.cm.on("change", () => {
          if (tab.big) {
            // 大文件不做全量字符串比对（每次按键 getValue 会卡）
            if (!tab.dirty) { tab.dirty = true; tab.el.classList.add("dirty"); refreshTreeDirty(); }
          } else {
            tab.dirty = tab.cm.getValue() !== tab.original;
            tab.el.classList.toggle("dirty", tab.dirty);
          }
          if (tab === active) { updateStatus(); ffOnDocChange(); }
          if (tab.mdMode === "split") schedulePreviewUpdate(tab);   // 分屏模式：编辑时实时刷新预览
        });
        tab.cm.on("cursorActivity", () => { if (tab === active) updateStatus(); });
        // 光标/焦点在哪一侧编辑器，新文件就打开到哪一侧（同 VS Code 焦点组行为）
        tab.cm.on("focus", () => { curGroup = tab.group; });
        if (["md", "markdown"].includes(ext)) setupMarkdownView(tab);
        else if (["html", "htm"].includes(ext)) setupHtmlView(tab);
        else if (name === ".gitignore") setupGitignoreView(tab);
        else if (name.toLowerCase() === "requirements.txt") setupRequirementsView(tab);
        else if (name.toLowerCase() === "package.json") setupPackageJsonView(tab);
        // 可运行文件（py / js / sh / rb …）：在「程序入口」那一行的行首加「▶ 启动」按钮
        else if (typeof RUN_LABELS !== "undefined" && RUN_LABELS[ext]) setupRunButtonView(tab);
        // .env / .env.local / .env.example 等：可视化编辑浮框（setupEnvView 见 23_ 文件）
        else if (/^\.env(\.[A-Za-z0-9_-]+)?$/.test(name)) setupEnvView(tab);
        // 竞态防护：加载期间用户又点了其它文件（activate 过别的标签 / 又发起新打开），
        // 则本次不抢焦点，只把内容挂好留在后台标签里（用户最后一次点击优先）
        if (active === tab) { scheduleRefresh(tab); }
        else if (seq === openSeq && active === wasActive) { activate(tab); scheduleRefresh(tab); }
        else { tab.host.classList.remove("active"); }
      } catch (e) {
        host.innerHTML = '<div style="padding:30px;color:#c66;">无法打开：' + esc(e.message || e) + '</div>';
        // 出错也一样守规矩：用户已切到别的文件就不抢焦点，错误信息留在后台标签里
        if (active === tab || (seq === openSeq && active === wasActive)) host.classList.add("active");
      }
    } else {
      activate(tab);
    }
    refreshTreeDirty();
    navPush(path, name);   // 右上角 ← → 导航历史
    // 记录最近打开（Quick Open 面板「最近打开」数据源）
    try {
      const rec = JSON.parse(localStorage.getItem("ide.recentFiles") || "[]").filter(f => f.path !== path);
      rec.unshift({ path, name });
      localStorage.setItem("ide.recentFiles", JSON.stringify(rec.slice(0, 12)));
    } catch (_) {}
    sessionSaveTabs();
    return tab;   // 调用方（如 openFileAt 定位行）可直接拿到标签，避免再按路径查一遍
  }
  // 把标签的编辑器容器挂到所属编辑组；组布局重建时的兜底挂载也走这里
  function mountHost(tab) {
    const b = groupBundles.get(tab.group);
    if (b && tab.host.parentElement !== b.wrap) b.wrap.appendChild(tab.host);
  }
  function renderTab(tab) {
    // 同一标签的旧节点先摘掉，避免重复挂载（标签栏出现重影/点击错位）
    if (tab.el && tab.el.parentNode) tab.el.parentNode.removeChild(tab.el);
    const el = document.createElement("div");
    // tab-db：数据库连接标签，加一条类型色边（激活时整条着色），与侧栏高亮呼应
    el.className = "tab" + (tab.dirty ? " dirty" : "") + (tab.isDbConn ? " tab-db" : "");
    // 差异标签的 name 带 "@提交哈希" 后缀（如 ide.html@895cd54），直接匹配取不到类型图标，
    // 用 relPath 的真实文件名来取图标；大小 1.4em 由 .t-ic 规则统一控制
    const iconName = (tab.diff && tab.relPath) ? baseName(tab.relPath) : tab.name;
    const ic = tab.iconHtml || iconFor(iconName, false);   // 汇总标签页可自带图标
    el.innerHTML = '<span class="t-ic">' + ic + '</span><span class="t-nm">' + esc(tab.name) + '</span><span class="t-dot"></span><span class="t-close"><i class="bi bi-x"></i></span>';
    el.addEventListener("click", (e) => { e.stopPropagation(); if (e.target.closest(".t-close")) closeTab(tab); else activate(tab); });
    setupTabDrag(el, tab);
    const bundle = groupBundles.get(tab.group);
    if (bundle) bundle.tabbar.appendChild(el);
    if (tab === groupActive.get(tab.group)) el.classList.add("active");
    tab.el = el;
  }
  // 视频播放器播放列表原位切换时同步标签页（22 号视频播放器 js 调用）：
  // 更新 path/name 并重绘标签节点；当前激活时顺带刷新面包屑与状态栏
  window.IDE_SYNC_VIDEO_TAB = function (tab, path, name) {
    tab.path = path; tab.name = name; tab.dirty = false; tab.big = false; tab.cm = null;
    if (tab.el) renderTab(tab);   // 重绘标签节点（带新文件名与图标）
    if (active === tab) { renderBreadcrumbs(tab.displayPath || tab.path); updateStatus(); revealInTree(tab.path); }
    sessionSaveTabs();
  };
  function renderTabsAll() {
    rebuildGroups();
    // 标签栏是 tabs 的唯一投影：先清空再按顺序重建，
    // 否则 rebuildGroups 命中缓存提前返回时，旧标签节点会残留并不断累积
    groupBundles.forEach(b => { b.tabbar.textContent = ""; });
    tabs.forEach(t => { t.el = null; renderTab(t); mountHost(t); });
    if (typeof apiSyncOpenMarks === "function") apiSyncOpenMarks();   // 标签栏重建后刷新 API 已打开标记
    if (typeof dbcSyncOpenMarks === "function") dbcSyncOpenMarks();   // 数据库侧栏「已打开」高亮跟随标签
  }
  /* ---------- 动态编辑组：组按「行」排布，每行内可并排多个组 ----------
     向右拆分：与源组同行、插在其右侧；向下拆分：在源组所在行的下方新起一行 */
  let groupLayout = [];              // [[gid, gid...], [gid...]] 行 → 组
  function groupIds() { return [...new Set(tabs.map(t => t.group))].sort((a, b) => a - b); }
  // 布局与「当前真正存在的组」对齐：丢弃已关闭的组与空行，补上未登记的组
  function layoutRows() {
    const present = new Set(groupIds());
    const rows = [];
    groupLayout.forEach(row => {
      const kept = row.filter(g => present.has(g));
      kept.forEach(g => present.delete(g));
      if (kept.length) rows.push(kept);
    });
    if (present.size) {
      const rest = [...present].sort((a, b) => a - b);
      if (rows.length) rows[rows.length - 1].push(...rest); else rows.push(rest);
    }
    groupLayout = rows;
    return rows;
  }
  function flatGroupIds() { return layoutRows().flat(); }
  function groupLabel(g) { const i = flatGroupIds().indexOf(g); return i <= 0 ? "" : "组" + (i + 1) + " · "; }
  // 登记一次拆分：dir='right' 同行插到源组右侧；dir='down' 在源组所在行下方新起一行
  function registerSplit(srcGid, newGid, dir) {
    const rows = layoutRows();
    const ri = rows.findIndex(row => row.includes(srcGid));
    if (ri < 0) { groupLayout = rows.concat([[newGid]]); }
    else if (dir === "down") { groupLayout = rows.slice(0, ri + 1).concat([[newGid]], rows.slice(ri + 1)); }
    else {
      const row = rows[ri].slice();
      row.splice(row.indexOf(srcGid) + 1, 0, newGid);
      groupLayout = rows.slice();
      groupLayout[ri] = row;
    }
    builtGroupKey = "\u0000split";   // 强制按新布局重排
  }
  function currentWrap() {
    const b = groupBundles.get(curGroup);
    if (b) return b.wrap;
    const first = groupBundles.values().next();
    return first.done ? null : first.value.wrap;
  }
  function makeGroupDom(gid) {
    const el = document.createElement("div");
    el.className = "editor-group";
    const tbar = document.createElement("div");
    tbar.className = "tabbar scroll-thin";
    // 标签栏隐藏了滚动条，用滚轮也能横向浏览标签（鼠标用户无需拖滚动条）
    tbar.addEventListener("wheel", (e) => {
      if (!e.deltaY || tbar.scrollWidth <= tbar.clientWidth) return;
      tbar.scrollLeft += e.deltaY;
      e.preventDefault();
    }, { passive: false });
    const splitBtn = document.createElement("button");
    splitBtn.type = "button"; splitBtn.className = "ed-tools ed-split";
    splitBtn.title = "向右拆分编辑器 (Ctrl+\\)；按住 Alt 点击 = 向下拆分 (Alt+\\)";
    splitBtn.innerHTML = '<i class="bi bi-layout-split"></i>';
    // Alt+点击 = 向下拆分（与 VS Code 「向下拆分编辑器」对应）
    splitBtn.addEventListener("click", (e) => { e.stopPropagation(); splitEditor(gid, e.altKey ? "down" : "right"); });
    const toolsBtn = document.createElement("button");
    toolsBtn.type = "button"; toolsBtn.className = "ed-tools"; toolsBtn.title = "编辑器操作";
    toolsBtn.innerHTML = '<i class="bi bi-three-dots"></i>';
    toolsBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const key = "edtools" + gid;
      if (openMenuKey === key) closeDrop();
      else { closeDrop(); openEditorMenu(toolsBtn, gid); }
    });
    const wrap = document.createElement("div");
    wrap.className = "editor-host-wrap";
    const row = document.createElement("div");
    row.className = "tab-row";
    row.append(tbar, splitBtn, toolsBtn);
    el.append(row, wrap);
    setupGroupDrop(wrap, gid);
    setupGroupDrop(tbar, gid);
    return { el, tabbar: tbar, wrap };
  }
  // 分隔条拖动：文档级 mousemove/mouseup 只注册一次，避免每次重建布局都堆积监听器
  let _dragSep = null;
  document.addEventListener("mousemove", (e) => {
    if (!_dragSep) return;
    if (!(e.buttons & 1)) { const s = _dragSep; _dragSep = null; s.end(); return; }   // 左键已松开，结束拖动
    _dragSep.move(e);
  });
  document.addEventListener("mouseup", () => { if (_dragSep) { const s = _dragSep; _dragSep = null; s.end(); } });

  function makeGroupSplitter() {          // 行内：左右两块调宽度
    const sp = document.createElement("div");
    sp.className = "gsep"; sp.title = "拖动调整分屏宽度（双击恢复默认）";
    let sx = 0, wL = 0, total = 0;
    sp.addEventListener("mousedown", (e) => {
      if (!sp.previousElementSibling || !sp.nextElementSibling) return;
      sx = e.clientX; wL = sp.previousElementSibling.getBoundingClientRect().width;
      total = (sp.parentElement || edGroups).getBoundingClientRect().width;
      sp.classList.add("dragging"); document.body.classList.add("resizing-x");
      _dragSep = {
        move: (ev) => {
          const left = sp.previousElementSibling, right = sp.nextElementSibling;
          if (!left || !right) return;
          const pct = Math.min(80, Math.max(10, (wL + ev.clientX - sx) / total * 100));
          left.style.flex = "0 0 " + pct + "%";
          right.style.flex = "1 1 0";
        },
        end: () => { sp.classList.remove("dragging"); document.body.classList.remove("resizing-x"); },
      };
      e.preventDefault();
    });
    sp.addEventListener("dblclick", () => {
      if (sp.previousElementSibling) sp.previousElementSibling.style.flex = "";
      if (sp.nextElementSibling) sp.nextElementSibling.style.flex = "";
    });
    return sp;
  }
  function makeRowSplitter() {            // 行间：上下两块调高度
    const sp = document.createElement("div");
    sp.className = "gsep-h"; sp.title = "拖动调整上下分屏高度（双击恢复默认）";
    let sy = 0, hT = 0, total = 0;
    sp.addEventListener("mousedown", (e) => {
      if (!sp.previousElementSibling || !sp.nextElementSibling) return;
      sy = e.clientY; hT = sp.previousElementSibling.getBoundingClientRect().height;
      total = (sp.parentElement || edGroups).getBoundingClientRect().height;
      sp.classList.add("dragging"); document.body.classList.add("resizing-y");
      _dragSep = {
        move: (ev) => {
          const top = sp.previousElementSibling, bottom = sp.nextElementSibling;
          if (!top || !bottom) return;
          const pct = Math.min(85, Math.max(15, (hT + ev.clientY - sy) / total * 100));
          top.style.flex = "0 0 " + pct + "%";
          bottom.style.flex = "1 1 0";
        },
        end: () => { sp.classList.remove("dragging"); document.body.classList.remove("resizing-y"); },
      };
      e.preventDefault();
    });
    sp.addEventListener("dblclick", () => {
      if (sp.previousElementSibling) sp.previousElementSibling.style.flex = "";
      if (sp.nextElementSibling) sp.nextElementSibling.style.flex = "";
    });
    return sp;
  }
  // 组集合/排布变化时重建布局（复用已有组 DOM，尺寸设置得以保留），并把各标签内容区挂回所属组
  function rebuildGroups() {
    const rows = layoutRows();
    const flat = rows.flat();
    welcome.style.display = flat.length ? "none" : "flex";
    const key = rows.map(r => r.join("+")).join("|");
    if (key === builtGroupKey) return;
    builtGroupKey = key;
    edGroups.innerHTML = "";
    const next = new Map();
    rows.forEach((row, ri) => {
      if (ri > 0) edGroups.appendChild(makeRowSplitter());
      const rowEl = document.createElement("div");
      rowEl.className = "ed-row";
      row.forEach((gid, i) => {
        if (i > 0) rowEl.appendChild(makeGroupSplitter());
        let b = groupBundles.get(gid);
        if (!b) b = makeGroupDom(gid);
        next.set(gid, b);
        rowEl.appendChild(b.el);
      });
      edGroups.appendChild(rowEl);
    });
    groupBundles = next;
    edGroups.appendChild(welcome);   // innerHTML 清空会把 welcome 一并移除，需挂回
    tabs.forEach(mountHost);
    if (active && tabs.includes(active)) {
      groupBundles.forEach((b, gid) => b.el.classList.toggle("active-group", gid === active.group));
      if (active.cm) scheduleRefresh(active);
    }
  }
  // 打开/切换文件时，把激活标签滚进标签栏可视区（标签多时不再“藏在”滚动区域外）
  function scrollTabIntoView(tab) {
    const el = tab && tab.el, bar = el && el.parentElement;
    if (!el || !bar || bar.scrollWidth <= bar.clientWidth) return;
    const r = el.getBoundingClientRect(), br = bar.getBoundingClientRect();
    if (r.left < br.left) bar.scrollLeft -= (br.left - r.left);
    else if (r.right > br.right) bar.scrollLeft += (r.right - br.right);
  }
  /* 资源管理器联动：激活标签时在树中选中对应文件，并逐级展开未打开的祖先目录 */
  let revealSeq = 0;
  async function revealInTree(abs) {
    if (!ROOT || !abs || !abs.startsWith(ROOT + "/")) return;
    const seq = ++revealSeq;
    const segs = abs.slice(ROOT.length + 1).split("/");
    let base = ROOT;
    for (let i = 0; i < segs.length - 1; i++) {       // 逐级展开祖先目录
      base += "/" + segs[i];
      const row = [...explorerPanel.querySelectorAll(".tree-row")]
        .find(r => r.dataset.path === base && r.dataset.isdir === "1");
      if (!row) return;
      const kids = row.nextElementSibling;
      if (!kids || !kids.classList.contains("tree-children")) return;
      if (!kids.classList.contains("open")) {
        const twist = row.querySelector(".twist i");
        if (twist) twist.className = "bi bi-chevron-down";
        kids.classList.add("open");
        if (!kids._loaded) {
          kids._loaded = true;
          try { await loadChildren(kids._base, kids, (parseFloat(row.style.paddingLeft) - 8) / 14); }
          catch (_) { kids._loaded = false; return; }
        }
      }
      if (seq !== revealSeq) return;                    // 期间用户已切换其它文件，放弃本次
    }
    const target = [...explorerPanel.querySelectorAll(".tree-row")].find(r => r.dataset.path === abs);
    if (!target) return;
    document.querySelectorAll(".tree-row.selected").forEach(r => r.classList.remove("selected"));
    target.classList.add("selected");
    treeSel = { path: abs, name: segs[segs.length - 1], isDir: false };
    treeAnchor = abs;
    target.scrollIntoView({ block: "nearest" });
  }

  function activate(tab) {
    mountHost(tab);   // 编辑器容器必须先在所属组里，切换才会真正显示内容
    tabs.forEach(t => { if (t.group === tab.group) { t.host.classList.remove("active"); t.el.classList.remove("active"); } });
    tab.host.classList.add("active"); tab.el.classList.add("active");
    active = tab; curGroup = tab.group; groupActive.set(tab.group, tab);
    // 拆分按钮只跟当前激活组走
    groupBundles.forEach((b, gid) => b.el.classList.toggle("active-group", gid === tab.group));
    // 切换显示后重绘，修正隐藏期间创建/变更导致的尺寸测量偏差
    scheduleRefresh(tab);
    renderBreadcrumbs(tab.displayPath || tab.path); updateStatus();
    refreshTreeDirty(); ffOnTabChange();
    revealInTree(tab.path);          // 树列表跟随当前打开的文件高亮
    scrollTabIntoView(tab);
    sessionSaveTabs();
    if (typeof dbcSyncOpenMarks === "function") dbcSyncOpenMarks();   // 数据库侧栏高亮跟随当前标签
    if (typeof apiSyncOpenMarks === "function") apiSyncOpenMarks();   // API 调试侧栏高亮跟随当前标签
  }
  async function closeTab(tab) {
    const i = tabs.indexOf(tab);
    if (i < 0) return;
    if (tab.dirty && !(await uiConfirm("关闭标签", "文件 " + tab.name + " 有未保存的修改，确定不保存并关闭？", "不保存并关闭", true))) return;
    // 自定义标签（如插件视图）的关闭钩子：可异步，返回 false 可取消关闭
    if (typeof tab.onBeforeClose === "function") {
      let ok = true;
      try { ok = await tab.onBeforeClose(); } catch (e) { console.error(e); }
      if (ok === false) return;
    }
    const g = tab.group;
    tab.host.remove(); tabs.splice(i, 1);
    renderTabsAll();
    if (active === tab || groupActive.get(g) === tab) {
      const rest = tabs.filter(t => t.group === g);
      const next = rest[rest.length - 1] || tabs[tabs.length - 1] || null;
      if (next) activate(next);
      else { active = null; groupActive.delete(g); curGroup = 0; $("breadcrumbs").innerHTML = ""; updateStatus(); ffClose(); }
    }
    sessionSaveTabs();
  }


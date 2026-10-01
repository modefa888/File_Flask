  /* ==================================================================
     AI 助手（右侧面板）：OpenAI 兼容接口的流式对话
     配置存服务端 data/storage/.file_manager_ai.json（Key 不回传）；
     会话历史存 localStorage（按项目根目录区分）。
     ================================================================== */
  const AI_DEFAULT_W = 400;
  // 内置 Skill 列表（与后端 _SKILL_PROMPTS 的 key 保持一致）
  const AI_SKILLS = [
    { id: "lsp-code-analysis", name: "代码分析", icon: "bi-search", desc: "用 LSP 语义分析定位定义、引用与实现", prompt: "你擅长代码语义分析，优先使用 LSP/IDE 的「转到定义」「查找引用」等功能定位代码，避免凭空猜测。" },
    { id: "multi-modal", name: "多模态生成", icon: "bi-image", desc: "生成/处理图片、视频、3D 等媒体内容", prompt: "你具备多模态内容生成能力。当用户请求生成/创建/处理图片、视频、3D 模型或给图片/视频加特效时，给出可调用 image_gen 等多模态接口的实施方案。" },
    { id: "skill-creator", name: "Skill 创建", icon: "bi-stars", desc: "引导并生成新的 Skill 扩展", prompt: "你擅长指导用户创建和扩展 CodeBuddy Skill。引导其明确触发条件、能力描述、所需工具/脚本，并生成对应的 skill 定义文件与示例实现。" },
    { id: "pptx", name: "PPT", icon: "bi-file-slides", desc: "创建、编辑、提取 PowerPoint 文件", prompt: "你擅长处理 PowerPoint 文件。当用户需要创建、编辑、合并、拆分、提取 PPTX 时，优先使用 python-pptx 库，给出完整可运行代码。" },
    { id: "pdf", name: "PDF", icon: "bi-file-earmark-pdf", desc: "读取、合并、拆分、OCR 等 PDF 处理", prompt: "你擅长处理 PDF 文件。当用户需要读取、合并、拆分、旋转、加水印、OCR、填表 PDF 时，优先使用 PyPDF2/pikepdf/pdfplumber 等库，给出完整可运行代码。" },
    { id: "docx", name: "Word", icon: "bi-file-earmark-word", desc: "创建、编辑、提取 Word 文档", prompt: "你擅长处理 Word 文档。当用户需要创建、编辑、提取 docx 时，优先使用 python-docx 库，给出完整可运行代码。" },
    { id: "xlsx", name: "Excel", icon: "bi-file-earmark-spreadsheet", desc: "处理表格、公式、图表、数据清洗", prompt: "你擅长处理 Excel/CSV 表格。当用户需要创建、编辑、公式、图表、清洗数据时，优先使用 openpyxl/pandas 库，给出完整可运行代码。" },
  ];

  const AI = {
    open: false, busy: false, ctx: false, ctrl: null,
    msgs: [],                                          // 当前会话消息 [{role, text, images?, imgs?, reasoning?}]
    providers: [], active: {}, sys: {},                // 多接口配置（服务端持久化）；sys = 系统功能使用的接口
    pending: [],                                       // 待发送图片 dataURL 列表
    files: [],                                         // 附加到对话的文件 [{path, name, text}]（右键「添加到 AI 对话」）
    perm: (() => {                                     // AI 操作权限：readonly / workspace / full
      try { return localStorage.getItem("ide.ai.perm") || "workspace"; } catch (_) { return "workspace"; }
    })(),
    agent: (() => {                                    // 智能体模式：AI 自动读写文件 / 执行命令
      try { return localStorage.getItem("ide.ai.agent") === "1"; } catch (_) { return false; }
    })(),
    webSearch: (() => {                                // 普通对话联网搜索开关
      try { return localStorage.getItem("ide.ai.webSearch") === "1"; } catch (_) { return false; }
    })(),
    ctxUsed: 0,                                        // 最近一次请求的上下文占用（token 估算）
    sessions: [], curId: "",                           // 对话列表（localStorage 持久化）
  };
  function aiRootKey() { return (typeof ROOT !== "undefined" ? ROOT : "default"); }
  function aiSessKey() { return "ide.ai.sessions." + aiRootKey(); }
  function aiCurKey() { return "ide.ai.cur." + aiRootKey(); }
  function aiHistKey() { return "ide.ai.chat." + aiRootKey(); }   // 旧版单会话键（仅用于迁移）
  // —— 以下改为后端持久化（SQLite，跨设备/跨浏览器同步），不再写 localStorage ——
  function aiNewPid() { return "m" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  async function aiLoadSessions() {
    AI.sessions = []; AI.curId = ""; AI.msgs = [];
    let ok = false;
    try {
      const r = await fetch("/api/ai/sessions");
      const d = await r.json();
      if (r.ok && d.sessions) {
        AI.sessions = (d.sessions || []).map(s => ({
          id: s.id, title: s.title || "新对话", time: (s.updated_at || 0) * 1000,
          msgs: null, _dirty: false, _savedPids: new Set(),
          mem: (s.extra && s.extra.mem) || "", cmp: (s.extra && s.extra.cmp) || 0,
          cmpLen: (s.extra && s.extra.cmpLen) || 0, savedTok: (s.extra && s.extra.savedTok) || 0,
          stats: (s.extra && s.extra.stats) || null,
        }));
        AI.curId = d.cur || (AI.sessions[0] ? AI.sessions[0].id : "");
        ok = true;
      }
    } catch (e) {}
    if (!ok) {                                    // 后端不可用：回退到本地 localStorage
      try { AI.sessions = JSON.parse(localStorage.getItem(aiSessKey()) || "[]"); } catch (_) { AI.sessions = []; }
      try { AI.curId = localStorage.getItem(aiCurKey()) || (AI.sessions[0] ? AI.sessions[0].id : ""); } catch (_) { AI.curId = ""; }
      const cur = AI.sessions.find(s => s.id === AI.curId);
      AI.msgs = cur ? (cur.msgs || []) : [];
      for (const m of AI.msgs) if (!m.pid) m.pid = aiNewPid();
      aiRenderHist(); aiRenderConv(); aiRenderAll();
      return;
    }
    // 首次迁移：本地旧数据上传到后端（仅当后端为空时执行一次）
    try {
      const legacy = JSON.parse(localStorage.getItem(aiSessKey()) || "[]");
      if (Array.isArray(legacy) && legacy.length) await aiMigrateLocal(legacy);
    } catch (_) {}
    // 加载当前会话完整消息
    const cur = AI.sessions.find(s => s.id === AI.curId);
    if (cur) await aiFetchSession(cur.id);
    AI.msgs = (AI.sessions.find(s => s.id === AI.curId) || {}).msgs || [];
    aiRenderHist(); aiRenderConv(); aiRenderAll();
  }
  async function aiMigrateLocal(legacy) {
    for (const s of legacy) {
      const msgs = (s.msgs || []).map(m => ({
        mid: m.pid || aiNewPid(), role: m.role, text: m.text || m.content || "",
        images: m.images || [], reasoning: m.reasoning || "",
        meta: { ms: m.ms, ts: m.ts, steps: m.steps, files: m.files,
                changes: m.changes, undone: m.undone, err: m.err },
      }));
      if (!msgs.length) continue;
      try {
        await fetch("/api/ai/sessions", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: s.id, title: s.title || "新对话",
            extra: { mem: s.mem, cmp: s.cmp, cmpLen: s.cmpLen, savedTok: s.savedTok, stats: s.stats }, msgs,
          }),
        });
      } catch (_) {}
    }
    try { localStorage.removeItem(aiSessKey()); localStorage.removeItem(aiCurKey()); } catch (_) {}
  }
  async function aiFetchSession(id) {
    try {
      const r = await fetch("/api/ai/sessions/" + encodeURIComponent(id));
      const d = await r.json();
      if (r.ok && d.id) {
        const s = AI.sessions.find(x => x.id === id);
        if (s) {
          s.msgs = (d.msgs || []).map(m => ({ ...m, _saved: true }));
          s._savedPids = new Set((d.msgs || []).map(m => m.pid).filter(Boolean));
          if (d.extra) Object.assign(s, {
            mem: d.extra.mem || "", cmp: d.extra.cmp || 0, cmpLen: d.extra.cmpLen || 0,
            savedTok: d.extra.savedTok || 0, stats: d.extra.stats || null,
          });
        }
      }
    } catch (e) {}
  }
  function aiSessionExtra(s) {
    return { mem: s.mem || "", cmp: s.cmp || 0, cmpLen: s.cmpLen || 0, savedTok: s.savedTok || 0, stats: s.stats || null };
  }
  let _aiFlushTimer = null, _aiFlushing = false;
  function aiPersistCurrent() {
    if (!AI.curId) AI.curId = "s" + Date.now().toString(36);
    let s = AI.sessions.find(x => x.id === AI.curId);
    if (!s) { s = { id: AI.curId, title: "", time: Date.now(), msgs: [], _dirty: true, _savedPids: new Set() }; AI.sessions.unshift(s); }
    if (AI.msgs.length) {
      if (!s.title) {
        const first = AI.msgs.find(m => m.role === "user");
        s.title = ((first && (first.text || "")) || "新对话").slice(0, 24);
      }
      s.time = Date.now();
    }
    s.msgs = AI.msgs;
    for (const m of AI.msgs) if (!m.pid) m.pid = aiNewPid();
    if (!AI.msgs.length && !s.title) AI.sessions = AI.sessions.filter(x => x.id !== s.id);  // 空会话不占列表
    s._dirty = true;
    aiScheduleFlush();
  }
  function aiScheduleFlush() {                       // 防抖：多次变更合并为一次请求；捕获触发时的会话
    if (_aiFlushTimer) return;
    const cid = AI.curId;
    _aiFlushTimer = setTimeout(async () => {
      _aiFlushTimer = null;
      await aiFlushFor(cid);
    }, 300);
  }
  async function aiFlushFor(cid) {
    if (_aiFlushing) { aiScheduleFlush(); return; }
    const s = AI.sessions.find(x => x.id === cid);
    if (!s || !s._dirty) return;
    const all = s.msgs || [];
    const toSave = all.filter(m => m && !m._saved && m.pid).map(m => ({
      mid: m.pid, role: m.role, text: m.text || "",
      images: m.images || [], reasoning: m.reasoning || "",
      meta: { ms: m.ms, ts: m.ts, steps: m.steps, files: m.files,
              changes: m.changes, undone: m.undone, err: m.err },
    }));
    const savedPids = s._savedPids || new Set();
    const currentPids = new Set(all.filter(m => m && m.pid).map(m => m.pid));
    const deleted = [...savedPids].filter(p => !currentPids.has(p));   // 本地删除但后端仍存的消息
    if (!toSave.length && !deleted.length) { s._dirty = false; return; }
    _aiFlushing = true;
    try {
      const r = await fetch("/api/ai/sessions", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: cid, title: s.title || "新对话", extra: aiSessionExtra(s), msgs: toSave, deleted }),
      });
      const d = await r.json();
      if (r.ok && d.saved_mids) {
        const set = new Set(d.saved_mids);
        for (const m of all) if (m && set.has(m.pid)) m._saved = true;
        for (const mid of d.saved_mids) savedPids.add(mid);
        s._dirty = false;
      }
      if (d.deleted) for (const mid of d.deleted) savedPids.delete(mid);
      s._savedPids = savedPids;
    } catch (e) {}
    finally { _aiFlushing = false; }
    if (s._dirty) aiScheduleFlush();                // 保存期间又有变更，再保存一次
  }
  async function aiSetCur(id) {
    try { await fetch("/api/ai/cur", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) }); } catch (_) {}
  }
  function applyAiWidth(w, save) {
    const max = Math.min(620, Math.max(300, window.innerWidth - 420));
    const width = Math.max(260, Math.min(max, Math.round(w)));
    $("aiPanel").style.width = width + "px";
    if (save) { try { localStorage.setItem("ide.ai.width", String(width)); } catch (_) {} }
    refreshAllEditors();
    return width;
  }
  function toggleAI(force) {
    const open = force === undefined ? !AI.open : !!force;
    AI.open = open;
    $("aiPanel").classList.toggle("open", open);
    document.querySelector(".workbench").classList.toggle("ai-open", open);
    $("aiToggle").classList.toggle("on", open);
    try { localStorage.setItem("ide.ai.open", open ? "1" : "0"); } catch (_) {}
    if (open) {
      const saved = parseInt(localStorage.getItem("ide.ai.width") || "0", 10);
      applyAiWidth(saved > 0 ? saved : AI_DEFAULT_W, false);
      $("aiHist").style.display = "none";
      const mp = $("aiMselPop"); mp && (mp.style.display = "none");
      aiRenderAll(); aiRenderConv(); aiRenderPerm(); aiRenderAgentToggle(); aiRenderWebToggle();
      aiUpdateCtxRing();                 // 上下文占用圆环（按当前模型窗口）
      aiLoadCfg();                       // 打开面板即拉取配置，填充底部模型下拉
      if (!AI.busy) $("aiText").focus();
    } else {
      refreshAllEditors();
    }
  }
  (function initAiSplitter() {
    const sp = $("aiSplitter");
    let dragging = false;
    const onMove = (e) => {
      if (!dragging) return;
      applyAiWidth(window.innerWidth - e.clientX, false);
      e.preventDefault();
    };
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      sp.classList.remove("dragging");
      document.body.classList.remove("resizing");
      try { localStorage.setItem("ide.ai.width", String(parseInt($("aiPanel").style.width, 10) || AI_DEFAULT_W)); } catch (_) {}
    };
    sp.addEventListener("mousedown", (e) => { dragging = true; sp.classList.add("dragging"); document.body.classList.add("resizing"); e.preventDefault(); });
    sp.addEventListener("dblclick", () => { applyAiWidth(AI_DEFAULT_W, true); });
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  })();

  /* ---------- 轻量 Markdown 渲染（先整体转义防 XSS，再按行解析） ---------- */
  /* ---------- 消息里的文件路径：可点击跳转打开对应文件 ---------- */
  const AI_PATH_EXT = new Set(("py pyi pyw js mjs cjs jsx ts tsx json json5 jsonc md markdown mdx " +
    "txt text rst html htm xhtml css scss sass less styl yml yaml toml ini cfg conf config " +
    "properties env spec sh bash zsh fish bat cmd ps1 sql xml svg png jpg jpeg gif webp bmp ico " +
    "csv tsv log lock ipynb vue svelte astro lua pl rb go rs java kt kts scala php swift dart cs " +
    "c cc cpp cxx h hpp m mm ex exs erl clj tpl ejs hbs pug jade db sqlite sqlite3 whl tar gz tgz " +
    "bz2 xz zip rar exe dll so dylib bin dat bak pid map patch diff").split(" "));
  const AI_PATH_NAMES = new Set(["dockerfile", "makefile", "license", "licence", "procfile",
    "vagrantfile", "gemfile", "rakefile", "cmakelists.txt", ".gitignore", ".gitattributes",
    ".dockerignore", ".editorconfig", ".env", ".env.example", ".npmrc", ".babelrc"]);

  /* 判断一段行内代码是否像「文件/目录路径」（宁可少识别，也不要误伤普通代码片段） */
  function aiPathLike(s) {
    const t = String(s || "").trim();
    if (!t || t.length > 220 || /\s/.test(t)) return false;           // 含空格：命令、说明文字
    if (/^(https?:|mailto:|www\.)/i.test(t)) return false;
    if (/^[\d.\/]+$/.test(t)) return false;                           // 纯数字/版本号，如 1/2、1.0
    // 只接受路径常见字符（\p{L} 兼容中文等非 ASCII 文件名）
    if (!/^[\p{L}\p{N}_.@~+\-\/]+$/u.test(t)) return false;
    const base = t.replace(/\/+$/, "");
    if (!base || base === "." || base === "..") return false;
    const name = base.slice(base.lastIndexOf("/") + 1).toLowerCase();
    if (AI_PATH_NAMES.has(name)) return true;
    if (t.indexOf("/") >= 0) return true;                             // 带斜杠：目录或路径
    const ext = name.lastIndexOf(".") > 0 ? name.slice(name.lastIndexOf(".") + 1) : "";
    return !!ext && AI_PATH_EXT.has(ext);
  }
  /* 从路径文本里拆出行号/列号：run.py:12:5、README.md#L10 */
  function aiPathSplit(s) {
    const t = String(s || "");
    let m = t.match(/^(.*?):(\d+)(?::(\d+))?$/);
    if (!m) m = t.match(/^(.*?)#L?(\d+)(?:-L?\d+)?$/);
    if (!m || !m[1]) return { path: t, line: 0, col: 0 };
    return { path: m[1], line: parseInt(m[2], 10) || 0, col: parseInt(m[3], 10) || 0 };
  }
  /* 正文里没有反引号的裸路径：判定更严格，避免把 node.js、1.2.3 之类也变成标签 */
  const AI_PATH_STOP = new Set(["node.js", "npm.js", "vue.js", "react.js", "jquery.js",
    "next.js", "nuxt.js", "vue3.js", "vite.js", "express.js"]);
  function aiBarePathLike(t) {
    if (!aiPathLike(t)) return false;
    if (AI_PATH_STOP.has(t.toLowerCase())) return false;
    if (t.indexOf("/") < 0) {                            // 单个文件名：必须是 名字.已知扩展名
      const low = t.toLowerCase(), dot = low.lastIndexOf(".");
      return dot > 0 && !!low.slice(dot + 1) && AI_PATH_EXT.has(low.slice(dot + 1));
    }
    const segs = t.split("/").filter(Boolean);
    const last = (segs[segs.length - 1] || "").toLowerCase();
    const dot = last.lastIndexOf(".");
    const ext = dot > 0 ? last.slice(dot + 1) : "";
    if (ext) return AI_PATH_EXT.has(ext);
    return t.endsWith("/");                              // 无扩展名时只认以 / 结尾的目录
  }
  function aiPathChip(text, sp) {                        // 生成可点击的路径标签
    const q = String(sp.path).replace(/"/g, "&quot;");
    const attr = ' data-path="' + q + '"' +
      (sp.line ? ' data-line="' + sp.line + '"' : "") +
      (sp.col ? ' data-col="' + sp.col + '"' : "");
    const tip = "点击打开 " + q + (sp.line ? "（第 " + sp.line + " 行）" : "");
    return '<a class="ai-path"' + attr + ' title="' + tip + '">' + text + "</a>";
  }
  function aiMdCode(code) {                              // 行内代码：规则宽松
    const sp = aiPathSplit(code);
    return aiPathLike(sp.path) ? aiPathChip(code, sp) : "<code>" + code + "</code>";
  }
  /* 一次性扫描：URL / 行内代码 / 正文裸路径。URL 先被吃掉，
     否则链接里的路径（http://x.com/a.py）也会被当成文件。 */
  const AI_PATH_TOK = "(?:[\\p{L}\\p{N}_.@~+\\-]+/)+[\\p{L}\\p{N}_.@~+\\-/]*" +
    "|[\\p{L}\\p{N}_@~+\\-]+(?:\\.[\\p{L}\\p{N}]+)+";
  const AI_PATH_RE = new RegExp("(https?://[^\\s<>\"'`\\]]+)|`([^`]+)`|(" +
    AI_PATH_TOK + ")(?::\\d+(?::\\d+)?|#L?\\d+)?", "gu");
  function aiMdInline(s) {
    return s
      .replace(AI_PATH_RE, (m, url, code, tok) => {
        if (url) return m;
        if (code !== undefined) return aiMdCode(code);
        const sp = aiPathSplit(m);                       // 正文裸路径：规则严格
        return aiBarePathLike(sp.path) ? aiPathChip(m, sp) : m;
      })
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  }

  async function aiListDir(dir) {                    // 列目录：用来精确判断某个路径是否存在
    try {
      const r = await fetch("/api/files?path=" + encodeURIComponent(dir));
      const d = await r.json();
      return d && !d.error ? (d.items || []) : null;
    } catch (_) { return null; }
  }
  function aiPollSearch(token, n) {
    n = n || 0;
    return fetch("/api/search/" + encodeURIComponent(token))
      .then(r => r.json())
      .then(d => {
        if (d.error) return [];
        if (!d.done && n < 20) {
          return new Promise(res => setTimeout(res, 500)).then(() => aiPollSearch(token, n + 1));
        }
        return d.items || [];
      })
      .catch(() => []);
  }
  /* 回退：AI 只写了文件名或省略了一级目录时，在项目内按名字搜一次 */
  function aiSearchPath(q) {
    if (!ROOT) return Promise.resolve(null);
    const name = q.slice(q.lastIndexOf("/") + 1) || q;
    const params = new URLSearchParams({ root: ROOT, keyword: name, use_index: "never", timeout: "20" });
    if (typeof SEARCH_SKIP_DIRS !== "undefined" && SEARCH_SKIP_DIRS) params.set("skip", SEARCH_SKIP_DIRS);
    const rel = (it) => String(it.abs_path || it.path || "").replace(/\\/g, "/");
    const pick = (items) => {
      const list = (items || []).filter(it => rel(it).startsWith("/"));
      const tail = "/" + q.replace(/^\/+|\/+$/g, "");
      const best = list.find(it => rel(it) === ROOT + tail) ||
        list.find(it => rel(it).endsWith(tail)) ||
        list.filter(it => (it.name || "").toLowerCase() === name.toLowerCase())
            .sort((a, b) => rel(a).length - rel(b).length)[0];
      return best ? { abs: rel(best), is_dir: !!best.is_dir } : null;
    };
    return fetch("/api/search?" + params.toString())
      .then(r => r.json())
      .then(d => {
        if (d.items) return pick(d.items);
        if (d.token) return aiPollSearch(d.token).then(pick);
        return null;
      })
      .catch(() => null);
  }
  /* 把消息里的路径解析为项目内的真实路径（先精确命中，再按名字搜索回退） */
  async function aiResolvePath(q) {
    q = String(q || "").trim().replace(/^`|`$/g, "").replace(/^\.\//, "").replace(/:\d+(?::\d+)?$/, "");
    if (!q) return null;
    const cands = [];
    if (q.startsWith("/")) cands.push(q.replace(/\/+$/, ""));
    else if (ROOT) cands.push(ROOT + "/" + q.replace(/\/+$/, ""));
    for (const c of cands) {
      const parent = c.slice(0, c.lastIndexOf("/")) || "/";
      const name = c.slice(c.lastIndexOf("/") + 1);
      const items = await aiListDir(parent);
      if (!items) continue;
      const hit = items.find(x => x.name === name);
      if (hit) return { abs: c, is_dir: !!hit.is_dir, exact: true };
    }
    return await aiSearchPath(q);
  }
  /* 点击消息里的路径：文件→在编辑器打开（带行号则直接跳到该行）；目录→在资源管理器定位 */
  async function aiOpenPath(q, el, line, col) {
    if (el) el.classList.add("ask");
    let hit = null;
    try { hit = await aiResolvePath(q); } catch (_) {}
    if (!hit || !hit.abs) {
      if (el) el.classList.remove("ask");
      toast("未找到 " + q + (ROOT ? "" : "（当前没有打开项目）"), "warn");
      return;
    }
    if (el) el.classList.remove("ask");
    if (hit.is_dir) {
      const sb = $("sidebar");
      if (sb && sb.classList.contains("collapsed")) toggleSidebar();
      showPanel("explorer");
      revealInTree(hit.abs);
      toast("已定位目录：" + (ROOT && hit.abs.startsWith(ROOT + "/") ? hit.abs.slice(ROOT.length + 1) : hit.abs), "ok");
    } else {
      const name = baseName(hit.abs);
      const tab = await openFile(hit.abs, name);
      if (line > 0) aiGotoLine(tab, line, col);       // 带行号：打开文件后跳到该行
    }
  }
  /* 跳到指定行（1 基）：给了列号就选中该列的字符，没给就把光标放在行首 */
  function aiGotoLine(tab, line, col) {
    const go = () => {
      const cm = tab && tab.cm;
      if (!cm || !cm.lineCount()) return false;
      const l = Math.max(0, Math.min(line - 1, cm.lineCount() - 1));
      if (col > 0) {
        const ch = Math.max(0, Math.min(col - 1, cm.getLine(l).length));
        cm.setSelection({ line: l, ch: ch },
                        { line: l, ch: Math.min(cm.getLine(l).length, ch + 1) });
      } else {
        cm.setCursor({ line: l, ch: 0 });
      }
      scrollLineToComfort(cm, l);
      cm.focus();
      return true;
    };
    if (!go()) {                                       // 内容还没就绪时重试一小会儿
      let n = 0;
      const t = setInterval(() => { if (go() || ++n > 40) clearInterval(t); }, 100);
    }
  }
  /* 事件委托：点击消息里的路径标签即跳转（流式输出中新生成的标签同样生效） */
  $("aiMsgs").addEventListener("click", (e) => {
    const a = e.target.closest("a.ai-path");
    if (!a) return;
    e.preventDefault();
    e.stopPropagation();
    const q = String(a.dataset.path || a.textContent || "")
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
    aiOpenPath(q, a, parseInt(a.dataset.line, 10) || 0, parseInt(a.dataset.col, 10) || 0);
  });
  /* ---------- 代码高亮（零依赖，One Dark 配色） ---------- */
  function aiHlHtml(code) {
    const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    let html = "", i = 0, m;
    // 注释正则用字符串拼接，避免源码里出现 HTML 注释序列干扰解析
    const re = new RegExp("(<!" + "--[\\s\\S]*?--" + ">)|(<\\/?)([A-Za-z][\\w-]*)((?:[^>\"']|\"[^\"]*\"|'[^']*')*)(>|\\/>)", "g");
    while ((m = re.exec(code))) {
      html += esc(code.slice(i, m.index));
      if (m[1]) html += '<span class="hl-c">' + esc(m[1]) + "</span>";
      else {
        html += '<span class="hl-o">' + esc(m[2]) + '</span><span class="hl-k">' + m[3] + "</span>";
        const are = /([A-Za-z_:@][\w:.-]*)(\s*=\s*)?("[^"]*"|'[^']*')|(\s+)/g;
        let am;
        while ((am = are.exec(m[4]))) {
          if (am[1]) html += '<span class="hl-a">' + am[1] + "</span>" +
            (am[2] ? '<span class="hl-o">' + esc(am[2]) + "</span>" : "") +
            (am[3] ? '<span class="hl-s">' + esc(am[3]) + "</span>" : "");
          else html += am[4];
        }
        html += '<span class="hl-o">' + esc(m[5]) + "</span>";
      }
      i = re.lastIndex;
    }
    return html + esc(code.slice(i));
  }
  function aiHl(code, lang) {
    lang = (lang || "").toLowerCase();
    const alias = { py: "python", js: "javascript", ts: "javascript", jsx: "javascript", tsx: "javascript",
      node: "javascript", sh: "shell", bash: "shell", zsh: "shell", console: "shell",
      yml: "yaml", htm: "html", xml: "html", svg: "html", vue: "html" };
    lang = alias[lang] || lang;
    if (lang === "html") return aiHlHtml(code);
    const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const defs = {
      python: { c: "#", kw: ["False","None","True","and","as","assert","async","await","break","class","continue","def","del","elif","else","except","finally","for","from","global","if","import","in","is","lambda","nonlocal","not","or","pass","raise","return","try","while","with","yield"],
        bi: ["print","range","len","str","int","float","list","dict","set","tuple","open","enumerate","zip","map","sorted","abs","min","max","sum","round","isinstance","type","super","self","format"] },
      javascript: { c: "//", kw: ["const","let","var","function","return","if","else","for","while","class","new","this","typeof","instanceof","import","export","from","async","await","try","catch","finally","throw","break","continue","switch","case","default","do","extends","super","yield","delete","of","null","undefined","true","false"],
        bi: ["console","document","window","JSON","Math","Object","Array","String","Number","Boolean","Promise","Map","Set","fetch","setTimeout","setInterval","require","alert"] },
      json: { c: null, kw: ["true","false","null"], bi: [] },
      shell: { c: "#", kw: ["if","then","else","elif","fi","for","in","do","done","while","case","esac","function","return","export","local","echo","exit","source"], bi: ["cd","ls","grep","cat","rm","cp","mv","mkdir","touch","chmod","chown","curl","wget","git","python","pip","node","npm","sed","awk","find","sudo","apt"] },
      css: { c: null, kw: ["important","media","keyframes","import","supports"], bi: ["color","background","margin","padding","border","display","flex","width","height","font-size","position","top","left","right","bottom"] },
      yaml: { c: "#", kw: ["true","false","null","yes","no"], bi: [] },
      sql: { c: "--", kw: ["SELECT","FROM","WHERE","INSERT","INTO","VALUES","UPDATE","SET","DELETE","CREATE","TABLE","DROP","ALTER","JOIN","LEFT","RIGHT","INNER","OUTER","ON","GROUP","BY","ORDER","HAVING","LIMIT","AND","OR","NOT","NULL","AS","DISTINCT","COUNT","SUM","AVG","MIN","MAX"], bi: [] },
    };
    const d = defs[lang] || { c: null, kw: [], bi: [] };
    const kwSet = {}, biSet = {};
    d.kw.forEach(w => kwSet[w] = 1);
    d.bi.forEach(w => biSet[w] = 1);
    const re = /('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)|(\s+)|(.)/g;
    let html = "", m;
    while ((m = re.exec(code))) {
      if (m[1] !== undefined) html += '<span class="hl-s">' + esc(m[1]) + "</span>";
      else if (m[2] !== undefined) html += '<span class="hl-n">' + esc(m[2]) + "</span>";
      else if (m[3] !== undefined) {
        const w = m[3], isKw = kwSet[w] || (d.kw.length && kwSet[w.toUpperCase()] && lang === "sql");
        if (isKw) html += '<span class="hl-k">' + w + "</span>";
        else if (biSet[w]) html += '<span class="hl-f">' + w + "</span>";
        else if (code[re.lastIndex] === "(") html += '<span class="hl-f">' + w + "</span>";
        else html += w;
      }
      else if (m[4] !== undefined) html += m[4];
      else if (d.c && code.startsWith(d.c, re.lastIndex - 1)) {
        let end = code.indexOf("\n", re.lastIndex);
        if (end < 0) end = code.length;
        html += '<span class="hl-c">' + esc(code.slice(re.lastIndex - 1, end)) + "</span>";
        re.lastIndex = end;
      }
      else html += esc(m[5]);
    }
    return html;
  }
  function aiFileHint(rawLine) {                          // 识别“文件名行”（如 **main.py**）
    const t = rawLine.replace(/[`*~#>\s]+/g, " ").trim();
    const m = t.match(/([A-Za-z0-9_\-]+(?:[\/.][A-Za-z0-9_\-]+)*\.[A-Za-z0-9]{1,10})$/);
    if (!m) return "";
    if (t.length - m[1].length > 12) return "";           // 除文件名外还有较多文字 → 不是文件名行
    return m[1];
  }
  function aiMd(src) {
    // 有些模型把工具调用写在正文里（<tool_call>…</tool_call> / <tool_use>…</tool_use>）：
    // 后端已按兼容模式解析执行，这里把原始文本折叠成一行提示，避免整屏 XML 污染消息
    const clean = String(src || "").replace(/<(?:tool_call|tool_use)>[\s\S]*?(?:<\/(?:tool_call|tool_use)>|$)/gi,
      "\n\n> 已按兼容模式解析为工具调用\n\n");
    const lines = clean.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").split("\n");
    const flushP = (buf) => buf.length ? "<p>" + buf.map(aiMdInline).join("<br>") + "</p>" : "";
    let html = "", pbuf = [], i = 0, lastFile = "";
    while (i < lines.length) {
      const L = lines[i];
      const fh = aiFileHint(L);
      if (fh) lastFile = fh;                                // 记录最近的文件名提示，供代码块插入用
      const fence = L.match(/^\s*```\s*(\S*)\s*$/);          // 围栏代码块
      if (fence) {
        html += flushP(pbuf); pbuf = [];
        const body = [];
        i++;
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) { body.push(lines[i]); i++; }
        i++;                                                  // 跳过结束 ```
        const lang = fence[1] || "代码";
        const n = Math.max(1, body.length);
        html += '<div class="ai-md-pre" data-file="' + lastFile.replace(/"/g, "&quot;") + '">' +
          '<div class="ai-md-ch"><span>' + lang + '</span>' +
          '<span class="ai-md-btns">' +
          '<button class="ai-md-ins" title="插入到项目：保存到当前项目并打开"><i class="bi bi-file-earmark-plus"></i></button>' +
          '<button class="ai-md-copy" title="复制代码"><i class="bi bi-clipboard"></i></button>' +
          '</span></div>' +
          '<div class="ai-md-code"><div class="ai-md-ln">' +
          Array.from({ length: n }, (_, k) => '<div>' + (k + 1) + '</div>').join("") + "</div>" +
          "<pre><code>" + aiHl(body.join("\n"), fence[1]) + "</code></pre></div></div>";
        continue;
      }
      const h = L.match(/^(#{1,4})\s+(.*)$/);                 // 标题
      if (h) {
        html += flushP(pbuf); pbuf = [];
        const lv = Math.min(h[1].length + 2, 5);
        html += "<h" + lv + ">" + aiMdInline(h[2]) + "</h" + lv + ">";
        i++; continue;
      }
      if (/^\s*(-{3,}|\*{3,})\s*$/.test(L)) { html += flushP(pbuf); pbuf = []; html += "<hr>"; i++; continue; }
      if (/^\s*&gt;\s?/.test(L)) {                            // 引用（> 已被转义为 &gt;）
        html += flushP(pbuf); pbuf = [];
        const body = [];
        while (i < lines.length && /^\s*&gt;\s?/.test(lines[i])) { body.push(lines[i].replace(/^\s*&gt;\s?/, "")); i++; }
        html += "<blockquote>" + body.map(aiMdInline).join("<br>") + "</blockquote>";
        continue;
      }
      const isUl = /^\s*[-*+]\s+\S/.test(L);
      const isOl = /^\s*\d+[.)]\s+\S/.test(L);
      if (isUl || isOl) {                                     // 列表
        html += flushP(pbuf); pbuf = [];
        const items = [];
        while (i < lines.length) {
          const m2 = isUl ? lines[i].match(/^\s*[-*+]\s+(.*)$/) : lines[i].match(/^\s*\d+[.)]\s+(.*)$/);
          if (!m2) break;
          items.push("<li>" + aiMdInline(m2[1]) + "</li>"); i++;
        }
        html += (isUl ? "<ul>" : "<ol>") + items.join("") + (isUl ? "</ul>" : "</ol>");
        continue;
      }
      const isRow = /^\s*\|.*\|\s*$/.test(L);                 // 表格行
      if (isRow && i + 1 < lines.length &&
          /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(lines[i + 1])) {   // 表头 + 分隔行
        html += flushP(pbuf); pbuf = [];
        const cells = (row) => row.trim().replace(/^\|/, "").replace(/\|$/, "")
          .split("|").map(c => aiMdInline(c.trim()));
        const ths = cells(L);
        i += 2;
        const rows = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { rows.push(cells(lines[i])); i++; }
        html += "<table><thead><tr>" + ths.map(t => "<th>" + t + "</th>").join("") + "</tr></thead><tbody>" +
          rows.map(r => "<tr>" + r.map(c => "<td>" + c + "</td>").join("") + "</tr>").join("") +
          "</tbody></table>";
        continue;
      }
      if (!L.trim()) { html += flushP(pbuf); pbuf = []; i++; continue; }
      pbuf.push(L); i++;
    }
    html += flushP(pbuf);
    return html;
  }
  function aiFmtTime(ts) {
    if (!ts) return "";
    const d = new Date(ts), p2 = n => String(n).padStart(2, "0");
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
  }
  /* 复制一条消息：文字 + 图片一起复制（不支持多类型剪贴板时退回纯文本） */
  async function aiCopyMessage(m) {
    const text = m.text || m.content || "";
    const imgs = (m.images || []).slice(0, 8);
    if (imgs.length && navigator.clipboard && window.ClipboardItem) {
      try {
        const items = [new ClipboardItem({ "text/plain": new Blob([text], { type: "text/plain" }) })];
        for (const u of imgs) {
          const blob = await (await fetch(u)).blob();
          items.push(new ClipboardItem({ [blob.type || "image/png"]: blob }));
        }
        await navigator.clipboard.write(items);
        return true;
      } catch (_) { /* 继续退回纯文本 */ }
    }
    await aiCopyText(text);
    return true;
  }
  function aiUserMetaHtml(m, mi) {                        // 用户消息：时间 + 复制（含图片）
    const t = aiFmtTime(m.ts);
    return '<div class="ai-meta user">' +
      (t ? '<span>' + t + '</span>' : '') +
      '<button class="ai-mcopy" data-mi="' + mi + '" title="复制（文字与图片一起复制）"><i class="bi bi-clipboard"></i></button>' +
      '</div>';
  }
  function aiMetaHtml(m, mi) {                            // 回复下方元信息行：复制/重答/重试/回撤 + tok · 用时 · 日期
    const parts = [];
    const tok = Math.ceil((m.text || "").length / 2);
    if (tok) parts.push('~' + tok + ' tok');
    if (m.ms) {
      const s = m.ms / 1000;
      parts.push('用时 ' + (s >= 60 ? Math.floor(s / 60) + '分' + Math.round(s % 60) + '秒' : s.toFixed(1) + 's'));
    }
    if (m.ts) parts.push(aiFmtTime(m.ts));
    const retryBtn = m.role === "assistant" && m.err
      ? '<button class="ai-mretry" data-mi="' + mi + '" title="重新提问"><i class="bi bi-arrow-repeat"></i></button>'
      : '';
    let undoBtn = '';
    if (m.role === "assistant" && m.changes && m.changes.length) {
      undoBtn = '<button class="ai-mundo" data-mi="' + mi + '" title="回撤本次 AI 改动（' + m.changes.length +
        ' 个文件操作）"><i class="bi bi-arrow-counterclockwise"></i></button>';
    } else if (m.role === "assistant" && m.undone) {
      undoBtn = '<span class="ai-undone" title="本次改动已回撤"><i class="bi bi-check2-circle"></i> 已回撤</span>';
    }
    return '<div class="ai-meta">' +
      '<button class="ai-mcopy" data-mi="' + mi + '" title="复制回复全文"><i class="bi bi-clipboard"></i></button>' +
      '<button class="ai-mregen" data-mi="' + mi + '" title="删除此回复并重新生成"><i class="bi bi-arrow-clockwise"></i></button>' +
      retryBtn + undoBtn +
      '<span>' + parts.join(' · ') + '</span></div>';
  }
  /* 回撤某条 AI 回复造成的文件改动 */
  function aiUndoChanges(mi, btn) {
    const m = AI.msgs[mi];
    if (!m || !m.changes || !m.changes.length) return;
    if (!confirm("回撤这次 AI 的改动？将把 " + m.changes.length + " 个文件操作恢复到修改前的状态。")) return;
    const old = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i class="bi bi-hourglass-split"></i>';
    fetch("/api/ai/undo", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: m.changes.map(c => (c && c.id) || c) }),
    }).then(async (r) => ({ ok: r.ok, d: await r.json().catch(() => ({})) }))
      .then(({ ok, d }) => {
        if (!ok || d.error) throw new Error(d.error || "回撤接口不可用（请重启服务）");
        const results = d.results || [];
        const failed = results.filter(x => !x.ok);
        m.undone = true; m.changes = [];
        m._saved = false;                       // 状态变了：允许重新保存，刷新后「已回撤」不丢
        aiReloadAfterUndo(results);
        aiPersistCurrent(); aiRenderAll();
        toast("已回撤 " + (d.restored || 0) + "/" + (d.total || results.length) + " 项改动" +
              (failed.length ? "（" + failed.length + " 项失败）" : ""), failed.length ? "warn" : "ok");
      })
      .catch((err) => {
        btn.disabled = false;
        btn.innerHTML = old;
        toast("回撤失败：" + err.message, "err");
      });
  }
  function aiReloadAfterUndo(results) {
    (results || []).forEach(r => {
      const p = r && r.path;
      if (!p) return;
      const t = findTab(p);
      if (r.action === "removed") { if (t) closeTabSilent(t); return; }
      if (t) { closeTabSilent(t); openFile(p, baseName(p)); }
    });
    try { refreshTree(); } catch (_) {}
  }

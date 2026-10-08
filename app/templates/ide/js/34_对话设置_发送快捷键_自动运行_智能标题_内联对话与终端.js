/* ============================================================================
   34_对话设置：设置页「对话」分区 + 内联对话（编辑器 / 终端）
   - 设置项：发送消息快捷键、自动运行模式、智能标题、独立终端、内联对话（含提示开关）
   - 行为：发送快捷键、智能标题（轻量模型自动命名）、编辑器/终端内联对话
   复刻参考：Trae / Cursor 的「对话」设置页
   ============================================================================ */
// ---------- 设置项默认值（localStorage "ide.settings" 持久化） ----------
const CHAT_DEFAULTS = {
  chatSendKey: "enter",        // 发送消息：enter | ctrlenter
  chatAutoRun: "safe",         // 自动运行模式：all | safe | ask
  chatSmartTitle: true,        // 智能标题
  chatIndepTerm: true,         // 独立终端
  chatInline: true,            // 内联对话（编辑器）
  chatInlineHint: false,       // 内联对话快捷键提示
  chatTermInline: true,        // 终端内联对话
  chatTermInlineHint: true,    // 终端内联对话快捷键提示
  chatTaskList: true,          // 任务清单（Agent 多步任务时维护计划清单）
  chatWebTool: true,           // 网络搜索工具（允许 Agent 联网搜索）
  chatWebAuto: true,           // 自动接受网络搜索结果（关闭则搜索前需确认）
  chatMaxStepsMain: 100,       // 最大步数（主 Agent），0 = 不限制
  chatMaxStepsSub: 500,        // 最大步数（子 Agent），0 = 不限制
  chatImageGen: true,          // 图片生成（允许 Agent 依据文字描述生成图片）
  chatImageModel: "",          // 默认图片模型（留空则 gpt-image-1）
  chatLspTool: true,           // LSP 工具（跳转定义 / 查找引用等语言智能）
  chatCommitLang: "zh",        // 提交消息语言：zh | en
};
function chatGet(k) { const v = ideSettingGet(k, CHAT_DEFAULTS[k]); return v === undefined ? CHAT_DEFAULTS[k] : v; }
function chatBool(k) { return chatGet(k) !== false; }
function chatNum(k) { const v = parseInt(chatGet(k), 10); return (isFinite(v) && v >= 0) ? v : (Number(CHAT_DEFAULTS[k]) || 0); }
function chatCommitLang() { return chatGet("chatCommitLang") === "en" ? "en" : "zh"; }
function chatSetKv(k, v) { ideSettingSet(k, v); }

// 供 AI 发送逻辑调用：当前自动运行模式
function chatAutoRunMode() { const v = chatGet("chatAutoRun"); return (v === "all" || v === "ask") ? v : "safe"; }
// 供 AI 输入框 keydown 调用：是否需要配合 Ctrl/⌘ 才发送
function chatSendNeedsCtrl() { return chatGet("chatSendKey") === "ctrlenter"; }
// 供智能体请求调用：主 / 子 Agent 最大步数（0 = 不限制）
function chatMaxStepsMain() { return chatNum("chatMaxStepsMain"); }
function chatMaxStepsSub() { return chatNum("chatMaxStepsSub"); }

/* ---------- 设置页行构建小工具（统一开关 / 下拉 / 数字输入外观） ---------- */
function chatChkRow(id, label, desc, kw) {
  return '<div class="set-row" data-kw="' + kw + '">' +
    '<div class="set-info"><div class="set-label">' + label + '</div><div class="set-desc">' + desc + '</div></div>' +
    '<label class="set-switch"><input type="checkbox" id="' + id + '"><span></span></label>' +
  '</div>';
}
function chatSelectRow(id, label, desc, kw, opts) {
  return '<div class="set-row" data-kw="' + kw + '">' +
    '<div class="set-info"><div class="set-label">' + label + '</div><div class="set-desc">' + desc + '</div></div>' +
    '<select id="' + id + '">' + opts + '</select>' +
  '</div>';
}
function chatNumRow(id, label, desc, kw) {
  return '<div class="set-row" data-kw="' + kw + '">' +
    '<div class="set-info"><div class="set-label">' + label + '</div><div class="set-desc">' + desc + '</div></div>' +
    '<input type="number" id="' + id + '" min="0" step="10">' +
  '</div>';
}
function chatTextRow(id, label, desc, kw) {
  return '<div class="set-row" data-kw="' + kw + '">' +
    '<div class="set-info"><div class="set-label">' + label + '</div><div class="set-desc">' + desc + '</div></div>' +
    '<input type="text" id="' + id + '" class="set-text" placeholder="留空使用默认" autocomplete="off" spellcheck="false">' +
  '</div>';
}
function chatGroup(title, kw, rows) {
  return '<div class="set-group" data-kw="' + kw + '">' +
    '<div class="set-group-hd">' + title + '</div>' +
    '<div class="set-group-bd">' + rows + '</div>' +
  '</div>';
}

/* ---------- 设置页「对话」分区 HTML ---------- */
function chatBuildSectionHTML() {
  return '' +
  '<div class="set-sec" id="sec-chat">' +
    '<h2 data-kw="对话 聊天 chat 发送 快捷键 回车 自动运行 智能标题 内联 终端 独立 任务清单 网络搜索 步数 图片 生成 LSP 提交消息 语言">对话</h2>' +

    chatGroup('发送消息', '发送消息 快捷键 回车 enter ctrl',
      chatSelectRow('chatSendKey', '发送消息', '设置聊天输入框中发送消息的快捷键', '发送消息 快捷键 回车 enter ctrl',
        '<option value="enter">Enter</option><option value="ctrlenter">Ctrl/⌘ + Enter</option>')) +

    chatGroup('自动运行模式', '自动运行 模式 命令 权限 执行 所有 安全 询问',
      chatSelectRow('chatAutoRun', '自动运行模式',
        'Agent 模式下工具（写文件 / 执行命令）的运行策略：运行所有内容（不再逐条确认）、只运行安全命令（高风险/破坏性才询问）、每次询问',
        '自动运行 模式 命令 执行 所有 安全 询问',
        '<option value="all">运行所有内容</option><option value="safe">只运行安全命令</option><option value="ask">每次询问</option>')) +

    chatGroup('智能标题', '智能 标题 自动 命名 title 生成',
      chatChkRow('chatSmartTitle', '智能标题', '对话首轮完成后，由轻量模型自动生成简短标题（替代默认的「第一条消息截断」）', '智能 标题 自动 命名 title 生成')) +

    chatGroup('独立终端', '独立 终端 命令 执行 进程 新会话',
      chatChkRow('chatIndepTerm', '独立终端', '内联对话/智能体执行命令时，使用独立终端进程（新会话）而非复用当前终端', '独立 终端 命令 执行 进程 新会话')) +

    chatGroup('内联对话', '内联 对话 编辑 选中 代码 快捷键 提示',
      chatChkRow('chatInline', '内联对话', '在编辑器中选中代码后，按 Mod+I 呼出内联对话，让 AI 直接改写选中代码', '内联 对话 编辑 选中 代码 开启') +
      chatChkRow('chatInlineHint', '内联对话快捷键提示', '编辑器内有选中代码时，在选区旁显示「Mod+I 让 AI 编辑」提示', '内联 对话 快捷键 提示 显示')) +

    chatGroup('终端内联对话', '终端 内联 对话 命令 快捷键 提示',
      chatChkRow('chatTermInline', '终端内联对话', '在终端输入框聚焦时，按 Mod+I 用自然语言描述要执行的命令，由 AI 生成并填入', '终端 内联 对话 命令 开启') +
      chatChkRow('chatTermInlineHint', '终端内联对话快捷键提示', '终端输入框聚焦时，显示「Mod+I 描述要执行的操作」提示', '终端 内联 对话 快捷键 提示 显示')) +

    // ---- 以下为参照 Trae「对话」补充的分组 ----
    chatGroup('任务清单', '任务清单 待办 todo task 计划 进度',
      chatChkRow('chatTaskList', '任务清单', '允许 Agent 使用任务清单来跟踪任务进度', '任务清单 待办 todo task 计划 进度')) +

    chatGroup('网络搜索', '网络搜索 联网 web search 搜索工具 自动接受',
      chatChkRow('chatWebTool', '网络搜索工具', '允许 Agent 搜索网络获取相关信息', '网络搜索 联网 web search 搜索工具') +
      chatChkRow('chatWebAuto', '自动接受网络搜索结果', '允许 Agent 自动接受网络搜索结果（关闭后，发起搜索前会先征求确认）', '自动接受 网络搜索结果 确认')) +

    chatGroup('Agent', 'Agent 步数 最大 主 子 限制',
      chatNumRow('chatMaxStepsMain', '最大步数（主 Agent）', '每轮对话中主 Agent 自动暂停前的最大步数。0 表示不限制。默认为 100。', 'Agent 最大步数 主 限制') +
      chatNumRow('chatMaxStepsSub', '最大步数（子 Agent）', '每次调用子 Agent（自定义 Agent）时的最大步数。0 表示不限制。默认为 500。', 'Agent 最大步数 子 自定义 限制')) +

    chatGroup('图片生成', '图片生成 绘图 image 文字描述 模型',
      chatChkRow('chatImageGen', '图片生成', '允许 Agent 根据文字描述生成图片', '图片生成 绘图 image 文生图') +
      chatTextRow('chatImageModel', '默认图片模型', '生成图片时使用的模型名（如 gpt-image-1 / dall-e-3）。留空则使用接口的默认（gpt-image-1）。', '图片生成 模型 文生图 model')) +

    chatGroup('LSP', 'LSP 语言服务 跳转定义 查找引用',
      chatChkRow('chatLspTool', 'LSP 工具', '启用 LSP（语言服务）工具。启用后，Agent 可以使用跳转定义、查找引用等语言智能功能。', 'LSP 语言服务 跳转定义 查找引用')) +

    chatGroup('提交消息', '提交消息 commit 语言 中文 english',
      chatSelectRow('chatCommitLang', '提交消息语言', '选择生成提交消息的语言', '提交消息 commit 语言 中文 english',
        '<option value="zh">中文</option><option value="en">English</option>')) +

  '</div>';
}

/* ---------- 设置页「对话」分区挂载 ---------- */
function chatMountSettings(host) {
  const q = (s) => host.querySelector(s);
  const sk = q("#chatSendKey"); if (sk) { sk.value = chatGet("chatSendKey"); sk.addEventListener("change", e => chatSetKv("chatSendKey", e.target.value)); }
  const ar = q("#chatAutoRun"); if (ar) { ar.value = chatGet("chatAutoRun"); ar.addEventListener("change", e => chatSetKv("chatAutoRun", e.target.value)); }
  const cl = q("#chatCommitLang"); if (cl) { cl.value = chatCommitLang(); cl.addEventListener("change", e => chatSetKv("chatCommitLang", e.target.value)); }
  bindChatChk(q("#chatSmartTitle"), "chatSmartTitle");
  bindChatChk(q("#chatIndepTerm"), "chatIndepTerm");
  bindChatChk(q("#chatInline"), "chatInline");
  bindChatChk(q("#chatInlineHint"), "chatInlineHint");
  bindChatChk(q("#chatTermInline"), "chatTermInline");
  bindChatChk(q("#chatTermInlineHint"), "chatTermInlineHint");
  bindChatChk(q("#chatTaskList"), "chatTaskList");
  bindChatChk(q("#chatWebTool"), "chatWebTool");
  bindChatChk(q("#chatWebAuto"), "chatWebAuto");
  bindChatChk(q("#chatImageGen"), "chatImageGen");
  bindChatText(q("#chatImageModel"), "chatImageModel");
  bindChatChk(q("#chatLspTool"), "chatLspTool");
  bindChatNum(q("#chatMaxStepsMain"), "chatMaxStepsMain");
  bindChatNum(q("#chatMaxStepsSub"), "chatMaxStepsSub");
  // 重置设置时一并恢复本分区默认值
  const reset = q("#setReset");
  if (reset) reset.addEventListener("click", () => {
    for (const k in CHAT_DEFAULTS) chatSetKv(k, CHAT_DEFAULTS[k]);
    chatMountSettings(host);
  });
}
function bindChatChk(el, k) {
  if (!el) return;
  el.checked = chatBool(k);
  el.addEventListener("change", e => chatSetKv(k, e.target.checked));
}
function bindChatNum(el, k) {
  if (!el) return;
  el.value = chatNum(k);
  el.addEventListener("change", () => {
    let v = parseInt(el.value, 10);
    if (!isFinite(v) || v < 0) v = Number(CHAT_DEFAULTS[k]) || 0;
    el.value = v; chatSetKv(k, v);
  });
}
function bindChatText(el, k) {
  if (!el) return;
  el.value = chatGet(k) || "";
  const save = () => chatSetKv(k, (el.value || "").trim());
  el.addEventListener("change", save);
  el.addEventListener("input", save);
}

/* ---------- 智能标题：首轮完成后由轻量模型生成标题 ---------- */
const chatTitlePending = new Set();
async function aiMaybeAutoTitle() {
  if (!chatBool("chatSmartTitle")) return;
  if (typeof AI === "undefined" || !AI.curId) return;
  const sess = (AI.sessions || []).find(s => s.id === AI.curId);
  if (!sess || sess.titleAuto) return;
  const msgs = (AI.msgs || []).filter(m => !m.err);
  const firstUser = msgs.find(m => m.role === "user" && (m.text || "").trim());
  const firstAi = msgs.find(m => m.role === "assistant" && (m.text || "").trim());
  if (!firstUser || !firstAi) return;            // 还没完成首轮问答
  if (chatTitlePending.has(AI.curId)) return;
  chatTitlePending.add(AI.curId);
  try {
    const r = await fetch("/api/ai/title", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [
        { role: "user", text: firstUser.text || "" },
        { role: "assistant", text: firstAi.text || "" },
      ] }),
    });
    const d = await r.json();
    if (!r.ok || !d.title) return;
    sess.title = String(d.title).slice(0, 24);
    sess.titleAuto = true;
    aiPersistCurrent();
    if (typeof aiRenderConv === "function") aiRenderConv();
  } catch (_) { /* 静默失败，不影响对话 */ }
  finally { chatTitlePending.delete(AI.curId); }
}

/* ============================================================================
   内联对话：编辑器内联编辑 + 终端内联命令
   快捷键：Mod+I（在编辑器或终端聚焦时呼出；设置页「快捷键」可改）
   ============================================================================ */
let iceState = null;     // { mode, cm, from, to, sel, result, cwd }

// 由快捷键 / 命令面板触发：根据当前焦点决定编辑器还是终端内联
function inlineChatDispatch() {
  if ($("iceBox")) { closeInlineChat(); return; }   // 已打开则关闭
  const inp = document.activeElement;
  const inTerm = inp === $("termInput") || (inp && inp.closest && inp.closest(".term-input-row"));
  if (inTerm) { termInlineOpen(); return; }
  if (inp && inp.id === "aiText") { toast("内联对话请在编辑器或终端中使用", "info"); return; }   // 不抢占 AI 聊天框
  if (active && active.cm && !active.diff) { editorInlineOpen(); return; }
  toast("请先把光标放到编辑器或终端里再呼出内联对话", "info");
}

function positionIce(box, left, top) {
  const w = box.offsetWidth, h = box.offsetHeight;
  box.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, left)) + "px";
  box.style.top = Math.max(8, Math.min(window.innerHeight - h - 8, top)) + "px";
}

function closeInlineChat() {
  const b = $("iceBox"); if (b) b.remove();
  iceState = null;
  // 终端提示：若焦点仍在终端且开启提示，则恢复显示
  if (document.activeElement === $("termInput") && chatBool("chatTermInlineHint")) {
    const c = $("iceTermHint"); if (c) c.style.display = "";
  }
}

/* ---------- 编辑器内联对话 ---------- */
function editorInlineOpen() {
  if ($("iceBox")) return;
  if (!chatBool("chatInline")) { toast("内联对话已关闭（设置 → 对话 → 内联对话）", "info"); return; }
  const cm = active.cm;
  const sel = cm.getSelection();
  const from = cm.getCursor("from"), to = cm.getCursor("to");
  iceState = { mode: "edit", cm, from, to, sel };
  const box = document.createElement("div");
  box.className = "ice ice-edit"; box.id = "iceBox";
  box.innerHTML =
    '<div class="ice-hd"><i class="bi bi-stars"></i> 内联对话' +
      '<span class="ice-close" title="关闭 (Esc)">×</span></div>' +
    '<div class="ice-sub">对选中的 ' + (sel ? sel.split("\n").length : 0) + ' 行代码应用修改</div>' +
    '<textarea class="ice-input" placeholder="描述你想对选中代码做什么，例如：加上参数校验 / 改成异步 / 提取为函数"></textarea>' +
    '<div class="ice-err" style="display:none"></div>' +
    '<pre class="ice-preview" style="display:none"></pre>' +
    '<div class="ice-actions">' +
      '<button class="ice-btn ice-cancel">取消</button>' +
      '<button class="ice-btn ice-ok primary">生成</button>' +
    '</div>' +
    '<div class="ice-actions ice-actions2" style="display:none">' +
      '<button class="ice-btn ice-reject">不用</button>' +
      '<button class="ice-btn ice-accept primary">采纳</button>' +
    '</div>';
  document.body.appendChild(box);
  const ta = box.querySelector(".ice-input");
  const err = box.querySelector(".ice-err");
  const prev = box.querySelector(".ice-preview");
  const a1 = box.querySelector(".ice-actions");
  const a2 = box.querySelector(".ice-actions2");
  const c = cm.cursorCoords(to, "page");
  positionIce(box, c.left, c.bottom + 8);
  ta.focus();
  box.querySelector(".ice-close").onclick = closeInlineChat;
  box.querySelector(".ice-cancel").onclick = closeInlineChat;
  box.querySelector(".ice-reject").onclick = closeInlineChat;
  box.querySelector(".ice-ok").onclick = () => iceGenerate(box, ta, err, prev, a1, a2, sel);
  box.querySelector(".ice-accept").onclick = () => {
    if (iceState && iceState.result != null) {
      try { cm.focus(); cm.replaceRange(iceState.result, iceState.from, iceState.to); } catch (_) {}
    }
    closeInlineChat();
  };
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); closeInlineChat(); }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); box.querySelector(".ice-ok").click(); }
  });
}

/* ---------- 终端内联对话 ---------- */
function termInlineOpen() {
  if ($("iceBox")) return;
  if (!chatBool("chatTermInline")) { toast("终端内联对话已关闭（设置 → 对话 → 终端内联对话）", "info"); return; }
  const ti = $("termInput");
  const cwd = (curTerm && curTerm.cwd) || (typeof ROOT !== "undefined" ? ROOT : "");
  iceState = { mode: "term", cwd };
  const box = document.createElement("div");
  box.className = "ice ice-term"; box.id = "iceBox";
  box.innerHTML =
    '<div class="ice-hd"><i class="bi bi-stars"></i> 终端内联对话' +
      '<span class="ice-close" title="关闭 (Esc)">×</span></div>' +
    '<div class="ice-sub">用自然语言描述要执行的操作</div>' +
    '<textarea class="ice-input" placeholder="例如：列出大于 10MB 的文件 / 重启开发服务器 / 看看 8080 端口被谁占用"></textarea>' +
    '<div class="ice-err" style="display:none"></div>' +
    '<pre class="ice-preview" style="display:none"></pre>' +
    '<div class="ice-actions">' +
      '<button class="ice-btn ice-cancel">取消</button>' +
      '<button class="ice-btn ice-ok primary">生成</button>' +
    '</div>' +
    '<div class="ice-actions ice-actions2" style="display:none">' +
      '<button class="ice-btn ice-insert">插入输入框</button>' +
      '<button class="ice-btn ice-run primary">执行</button>' +
    '</div>';
  document.body.appendChild(box);
  const ta = box.querySelector(".ice-input");
  const err = box.querySelector(".ice-err");
  const prev = box.querySelector(".ice-preview");
  const a1 = box.querySelector(".ice-actions");
  const a2 = box.querySelector(".ice-actions2");
  const rect = ti.getBoundingClientRect();
  let top = rect.top - box.offsetHeight - 8;
  if (top < 8) top = rect.bottom + 8;               // 空间不足则放到输入框下方
  positionIce(box, rect.left, top);
  const hint = $("iceTermHint"); if (hint) hint.style.display = "none";   // 呼出时隐藏底部提示
  ta.focus();
  box.querySelector(".ice-close").onclick = closeInlineChat;
  box.querySelector(".ice-cancel").onclick = closeInlineChat;
  box.querySelector(".ice-ok").onclick = () => iceGenerate(box, ta, err, prev, a1, a2, "", cwd);
  box.querySelector(".ice-insert").onclick = () => {
    if (iceState && iceState.result != null) { ti.value = iceState.result; ti.focus(); }
    closeInlineChat();
  };
  box.querySelector(".ice-run").onclick = () => {
    const cmd = iceState && iceState.result != null ? iceState.result : "";
    if (cmd) runInlineCmd(cmd);
    closeInlineChat();
  };
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); closeInlineChat(); }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); box.querySelector(".ice-ok").click(); }
  });
}

function runInlineCmd(cmd) {
  if (!cmd) return;
  // 独立终端：在新会话里执行，避免影响当前终端的 cd/历史
  if (chatBool("chatIndepTerm")) {
    termNew().then(s => { if (s) termRun(cmd); else termRun(cmd); });
  } else {
    termRun(cmd);
  }
}

/* ---------- 生成（编辑器/终端共用） ---------- */
async function iceGenerate(box, ta, err, prev, a1, a2, sel, cwd) {
  const instruction = ta.value.trim();
  if (!instruction) { ta.focus(); return; }
  const okBtn = box.querySelector(".ice-ok");
  okBtn.disabled = true; err.style.display = "none";
  try {
    const body = { instruction, mode: iceState.mode };
    if (iceState.mode === "edit") {
      body.code = sel || "";
      body.language = getExt((active && active.path) || "");
    } else {
      body.cwd = cwd || "";
    }
    const r = await fetch("/api/ai/inline", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const d = await r.json();
    if (!r.ok || !d.text) { err.textContent = d.error || "生成失败"; err.style.display = ""; return; }
    prev.textContent = d.text; prev.style.display = "";
    a1.style.display = "none"; a2.style.display = "flex";
    iceState.result = d.text;
    ta.disabled = true;
  } catch (e) { err.textContent = "请求出错：" + (e.message || e); err.style.display = ""; }
  finally { okBtn.disabled = false; }
}

/* ============================================================================
   快捷键提示：编辑器选区提示 + 终端输入框提示
   ============================================================================ */
let iceHintEl = null;
function iceHintElGet() {
  if (!iceHintEl) {
    iceHintEl = document.createElement("div");
    iceHintEl.className = "ice-hint";
    iceHintEl.textContent = (navigator.platform.indexOf("Mac") >= 0 ? "⌘I" : "Ctrl+I") + " 让 AI 编辑";
    iceHintEl.style.display = "none";
    document.body.appendChild(iceHintEl);
  }
  return iceHintEl;
}
function iceHintUpdate() {
  const el = iceHintElGet();
  if (!chatBool("chatInlineHint") || $("iceBox") || !active || !active.cm) { el.style.display = "none"; return; }
  const ae = document.activeElement;
  const cmHost = ae && ae.closest ? ae.closest(".CodeMirror") : null;
  if (!cmHost) { el.style.display = "none"; return; }
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) { el.style.display = "none"; return; }
  const r = sel.getRangeAt(0).getBoundingClientRect();
  if (!r || (r.width === 0 && r.height === 0)) { el.style.display = "none"; return; }
  el.style.display = "";
  el.style.left = Math.min(window.innerWidth - 150, r.left + r.width - 10) + "px";
  el.style.top = (r.bottom + 6) + "px";
}
function iceHintInit() {
  document.addEventListener("selectionchange", () => { try { iceHintUpdate(); } catch (_) {} });
  window.addEventListener("blur", () => { if (iceHintEl) iceHintEl.style.display = "none"; });
}

function termInlineHintInit() {
  const ti = $("termInput");
  if (!ti) return;
  const chip = document.createElement("div");
  chip.className = "ice-term-hint"; chip.id = "iceTermHint";
  chip.textContent = (navigator.platform.indexOf("Mac") >= 0 ? "⌘I" : "Ctrl+I") + " 描述要执行的操作";
  chip.style.display = "none";
  ti.parentElement.appendChild(chip);
  ti.addEventListener("focus", () => {
    if (chatBool("chatTermInlineHint") && !$("iceBox")) chip.style.display = "";
  });
  ti.addEventListener("blur", () => { chip.style.display = "none"; });
}

/* ---------- 初始化（脚本加载时执行一次） ---------- */
iceHintInit();
termInlineHintInit();

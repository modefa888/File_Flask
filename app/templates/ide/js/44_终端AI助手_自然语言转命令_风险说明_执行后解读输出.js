/* ============================================================================
   44_终端 AI 助手：自然语言 → 命令建议（风险说明）→ 执行 → 输出解读
   参考腾讯云 OrcaTerm 的终端 AI Agent，两处终端都支持：

   ① 底部「内置终端」
      · 直接说人话（「查看当前ip」）回车 → 「意图 + 风险 + 命令 + 说明」卡片；
      · 点「执行」照常走 /api/term/exec 的安全校验（拦截 / 二次确认）；
      · 执行完在终端里流式解读输出；
      · 输入框左侧「AI」开关：所有输入都交给 AI（命令前加 ! 强制直接执行）。

   ② 编辑器区 SSH 远程终端（xterm + PTY）
      · 顶部栏「✦ AI」按钮打开助手浮层，或用 Enter 提交中文需求自动唤起；
      · 命令通过 /api/ssh/input 发到远端，输出回读后再流式解读。
   ============================================================================ */
const TAI = {
  on: false,          // 内置终端 AI 模式（输入框左侧按钮）
  busy: false,        // 正在生成建议 / 执行中
  abort: null,        // 解读流的 AbortController
};

const TAI_RISK = {
  low: { label: "风险低", cls: "low", icon: "bi-shield-check", tip: "只读操作，不会修改系统状态" },
  medium: { label: "需谨慎", cls: "mid", icon: "bi-exclamation-triangle", tip: "会改动文件或服务，执行前请确认" },
  high: { label: "高风险", cls: "high", icon: "bi-exclamation-octagon", tip: "可能破坏数据或系统，执行前请确认" },
};

/* ---------- 输入判定 ---------- */
function taiHasCJK(s) { return /[\u3400-\u9fff]/.test(String(s || "")); }

/* 首个词是不是「命令」：路径形式，或 ASCII 开头且不含中文（mkdir 测试、git status -s 都算命令） */
function taiLooksLikeCmd(text) {
  const tok = String(text || "").trim().split(/\s+/)[0] || "";
  if (!tok) return false;
  if (/^(\.\/|\/|~\/)/.test(tok)) return true;          // ./启动.sh、/usr/bin/xxx：一定是命令
  return !taiHasCJK(tok) && /^[A-Za-z0-9_$.-]/.test(tok);
}

/* 这段输入要不要交给 AI */
function taiNatural(text) {
  const s = String(text || "").trim();
  if (!s) return false;
  if (TAI.on) return true;                       // AI 模式：全部交给 AI
  if (/^[?？]/.test(s)) return true;             // 显式前缀
  if (!taiHasCJK(s)) return false;               // 没中文 → 是命令
  return !taiLooksLikeCmd(s);                    // 首词是命令 → 仍然当命令
}

/* SSH 终端里输入的一行：判定要保守 —— 只认明显是「人话」的行，
   避免在 python REPL / 密码提示里误伤（那会白白 Ctrl+U 掉用户输入）。 */
const TAI_CN_VERBS = /^(查看|看看|看下|看一下|查一下|查下|查询|列出|列一下|显示|统计|清理|删除|安装|启动|停止|重启|进入|找到|找一下|怎么|如何|为什么|帮我|我想|请|把|给我)/;
function taiSshNatural(text) {
  const s = String(text || "").trim();
  if (!s || s.length > 300) return false;
  if (!taiHasCJK(s)) return false;
  if (taiLooksLikeCmd(s)) return false;
  if (/[()=;`"'\\]/.test(s)) return false;              // 像代码 / 正则 / 带引号的参数，不拦
  if (TAI_CN_VERBS.test(s)) return true;
  const first = s.split(/\s+/)[0] || "";
  return /^[\u3400-\u9fff]/.test(s) && /[\u3400-\u9fff]/.test(first);
}

/* ---------- 小工具 ---------- */
/* 超长输出保留头尾（结尾往往是报错），避免把几 MB 的日志整段 POST 上去 */
function taiClip(text, limit) {
  const s = String(text || "");
  if (s.length <= limit) return s;
  const head = Math.floor(limit * 0.35);
  return s.slice(0, head) + "\n…（中间省略 " + (s.length - limit) + " 字符）…\n" +
         s.slice(s.length - (limit - head));
}

/* 去掉终端里的 ANSI / 控制序列（SSH 回读输出时用） */
function taiStripAnsi(s) {
  return String(s || "")
    .replace(/\x1b\][^\x07]*\x07/g, "")
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
    .replace(/\x1b[()][A-Za-z0-9]/g, "")
    .replace(/\r/g, "");
}

function taiBody(S) { return (S || curTerm || {}).body || null; }
function taiScroll(S) { const b = taiBody(S); if (b) b.scrollTop = b.scrollHeight; }
function taiMd(src) {
  return (typeof aiMd === "function") ? aiMd(src || "")
    : esc(src || "").replace(/\n/g, "<br>");
}
function taiSetText(el, text) { if (el) el.textContent = text == null ? "" : String(text); }

/* ---------- 内联 SVG 图标 ----------
   面板不依赖 bootstrap-icons 字体：字体没加载 / 版本较旧 / 被缓存时，
   图标会显示成方框（tofu）。这里全部用内联 SVG（currentColor + stroke），
   在任何环境、任何缩放比例下都能正常显示。 */
const TAI_SVG = {
  star: '<path fill="currentColor" stroke="none" d="M6.7 2.9l1.6 3.9 3.9 1.6-3.9 1.6-1.6 3.9-1.6-3.9-3.9-1.6 3.9-1.6z"/>' +
        '<path fill="currentColor" stroke="none" d="M12.3 1.9l.7 1.7 1.7.7-1.7.7-.7 1.7-.7-1.7-1.7-.7 1.7-.7z"/>' +
        '<path fill="currentColor" stroke="none" d="M13.2 9.9l.9 1.1-.9 1.1-.9-1.1z"/>',
  clock: '<circle cx="8" cy="8" r="5.7"/><path d="M8 4.5V8l2.6 1.7"/>',
  x: '<path d="M3.6 3.6l8.8 8.8M12.4 3.6l-8.8 8.8"/>',
  play: '<path d="M4.6 2.9l8 5.1-8 5.1z" fill="currentColor" stroke="none"/>',
  stop: '<rect x="4.2" y="4.2" width="7.6" height="7.6" rx="1.2" fill="currentColor" stroke="none"/>',
  copy: '<rect x="5.6" y="3" width="7.4" height="9.4" rx="1.4"/><path d="M10.4 3V2.2c0-.7-.5-1.2-1.2-1.2H3.2c-.7 0-1.2.5-1.2 1.2v7.1c0 .7.5 1.2 1.2 1.2h.9"/>',
  pencil: '<path d="M2.4 13.6l.8-3.1 7.3-7.3 2.3 2.3-7.3 7.3z"/><path d="M9.9 3.9l2.3 2.3"/>',
  plus: '<path d="M8 3.2v9.6M3.2 8h9.6"/>',
  trash: '<path d="M2.8 4.8h10.4M6.3 4.8V3.2h3.4v1.6"/><path d="M4.3 4.8l.7 8.3h6l.7-8.3"/><path d="M6.6 7.2v3.6M9.4 7.2v3.6"/>',
  enter: '<path d="M13 3.2v5a2 2 0 01-2 2H3.6"/><path d="M6.2 7.4L3.5 10.2l2.7 2.8"/>',
  shield: '<path d="M8 1.4l5.3 2v3.8c0 3.5-2.2 5.5-5.3 6.8-3.1-1.3-5.3-3.3-5.3-6.8V3.4z"/><path d="M5.9 8l1.6 1.6 3-3.1"/>',
  warn: '<path d="M8 2.1l6 10.7H2z"/><path d="M8 6.3v3.2M8 11.4v.1"/>',
  info: '<circle cx="8" cy="8" r="5.9"/><path d="M8 7.2v4M8 4.9v.1"/>',
  gear: '<circle cx="8" cy="8" r="2.2"/><path d="M8 1.6v1.7M8 12.7v1.7M2.2 8h1.7M12.1 8h1.7M3.9 3.9l1.2 1.2M10.9 10.9l1.2 1.2M12.1 3.9l-1.2 1.2M5.1 10.9l-1.2 1.2"/>',
  bulb: '<path d="M8 1.8a4.2 4.2 0 00-2.4 7.6v1.4h4.8V9.4A4.2 4.2 0 008 1.8z"/><path d="M6.3 12.6h3.4M7 14.3h2"/>',
  spin: '<path d="M13 8a5 5 0 11-1.6-3.7"/><path d="M13 2.6V5h-2.4"/>',
  terminal: '<rect x="1.8" y="2.6" width="12.4" height="10.7" rx="1.6"/><path d="M4.4 6.4l2.1 2.1-2.1 2.1M8.6 10.8h3"/>',
  network: '<rect x="2.2" y="2.2" width="11.6" height="4.4" rx="1.2"/><rect x="2.2" y="9.4" width="11.6" height="4.4" rx="1.2"/><path d="M4.8 4.4h.01M4.8 11.6h.01"/>',
  globe: '<circle cx="8" cy="8" r="6"/><path d="M2 8h12"/><path d="M8 2c2.3 2.4 2.3 9.6 0 12M8 2c-2.3 2.4-2.3 9.6 0 12"/>',
  dot: '<circle cx="8" cy="8" r="2.8"/>',
  session: '<rect x="2.6" y="1.9" width="10.8" height="12.2" rx="1.5"/>' +
        '<path d="M5 5.3h6M5 7.9h6M5 10.5h3.6"/>',
};
const TAI_ICON_MAP = {
  "bi-stars": "star", "bi-magic": "star", "bi-play-fill": "play", "bi-stop-fill": "stop",
  "bi-globe": "globe", "bi-globe2": "globe",
  "bi-pencil-square": "pencil", "bi-clipboard": "copy", "bi-plus-lg": "plus", "bi-x-lg": "x",
  "bi-gear": "gear", "bi-info-circle": "info", "bi-exclamation-triangle": "warn",
  "bi-exclamation-octagon": "warn", "bi-shield-check": "shield", "bi-lightbulb": "bulb",
  "bi-arrow-repeat": "spin", "bi-arrow-return-left": "enter", "bi-trash3": "trash",
  "bi-terminal": "terminal", "bi-clock-history": "clock", "bi-hdd-network": "network",
  "bi-clipboard-data": "session", "bi-journal-text": "session", "bi-list-ul": "session",
};

function taiIco(name, cls) {
  const key = TAI_ICON_MAP[name] || (TAI_SVG[name] ? name : "dot");
  return '<svg class="tai-svg' + (cls ? " " + cls : "") + '" viewBox="0 0 16 16" width="14" height="14" ' +
    'fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" ' +
    'aria-hidden="true">' + TAI_SVG[key] + "</svg>";
}

function taiBtn(cls, icon, label, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "tai-btn" + (cls ? " " + cls : "");
  b.innerHTML = (icon ? taiIco(icon) : "") + "<span></span>";
  taiSetText(b.querySelector("span"), label);
  b.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); onClick(); });
  return b;
}

/* ---------- 网络 ---------- */
async function taiPost(url, payload) {
  const r = await fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
  let d = {};
  try { d = await r.json(); } catch (_) { d = {}; }
  if (!r.ok && !d.error) {
    d.error = (r.status === 404)
      ? "接口 " + url + " 不存在：后端可能还是旧版本，请重启一次服务后再试"
      : "HTTP " + r.status;
  }
  return d;
}

/* 读 SSE（POST 不能用 EventSource，这里手工按帧解析） */
async function taiStream(url, payload, signal, onDelta) {
  const r = await fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}), signal,
  });
  if (!r.ok || !r.body) {
    let msg = "HTTP " + r.status;
    try { const d = await r.json(); if (d && d.error) msg = d.error; } catch (_) { /* 忽略 */ }
    throw new Error(msg);
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "", err = "", done = false;
  while (!done) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buf += dec.decode(chunk.value, { stream: true });
    let k;
    while ((k = buf.indexOf("\n\n")) >= 0) {
      const raw = buf.slice(0, k);
      buf = buf.slice(k + 2);
      const line = raw.split("\n").find(x => x.indexOf("data:") === 0);
      if (!line) continue;
      const body = line.slice(5).trim();
      if (body === "[DONE]") { done = true; break; }
      let obj;
      try { obj = JSON.parse(body); } catch (_) { continue; }
      if (obj.error) { err = String(obj.error); continue; }
      if (obj.delta) onDelta(obj.delta);
    }
  }
  return err;
}

/* ---------- 通用元素 ---------- */
function taiUserLineEl(text) {
  const d = document.createElement("div");
  d.className = "tai-user";
  d.innerHTML = '' + taiIco("bi-stars", "tai-user-ic") + '<span class="tai-user-tx"></span>';
  taiSetText(d.querySelector(".tai-user-tx"), text);
  return d;
}

function taiLoadingEl(text) {
  const d = document.createElement("div");
  d.className = "tai-card tai-wait";
  d.innerHTML =
    '<div class="tai-hd"><span class="tai-ic">' + taiIco("bi-stars") + '</span>' +
      '<span class="tai-tt">AI 终端助手</span><span class="tai-sp"></span>' +
      '<span class="tai-live">' + taiIco("bi-arrow-repeat", "tai-spin") + ' 思考中…</span></div>' +
    '<div class="tai-note tai-wait-tx"></div>';
  taiSetText(d.querySelector(".tai-wait-tx"), text || "正在理解你的需求…");
  return d;
}

function taiErrorEl(msg, needCfg) {
  const d = document.createElement("div");
  d.className = "tai-card tai-bad";
  d.innerHTML =
    '<div class="tai-hd"><span class="tai-ic bad">' + taiIco("bi-exclamation-triangle") + '</span>' +
      '<span class="tai-tt">AI 暂时不可用</span></div>' +
    '<div class="tai-explain tai-err-tx"></div>' +
    '<div class="tai-actions"></div>';
  taiSetText(d.querySelector(".tai-err-tx"), msg || "未知错误");
  const acts = d.querySelector(".tai-actions");
  if (needCfg) {
    acts.appendChild(taiBtn("primary", "bi-gear", "配置 AI 接口", () => {
      if (typeof aiOpenSettings === "function") aiOpenSettings("sec-ai");
      else if (typeof openSettingsTab === "function") openSettingsTab("sec-ai");
    }));
  }
  if (!acts.childElementCount) acts.remove();
  return d;
}

/* 把命令打到终端输入行（不执行）：SSH 走远端 PTY，内置终端走输入框 */
function taiPasteToTerm(o, cmd) {
  if (!cmd) return;
  try {
    if (o && typeof o.paste === "function") { o.paste(cmd); return; }
    const inp = $("termInput");
    if (inp) { inp.value = cmd; inp.focus(); }
  } catch (_) { /* 忽略 */ }
}

/* 记录到 store.db 的 term_ai_history（失败不影响主流程）。
   question 存用户的原始输入（填回输入框用），title 存 AI 生成的意图标题（列表展示用） */
function taiSaveHist(host, question, plan, res) {
  const failed = !!(res && (res.blocked || res.cancelled || res.error));
  const title = String((plan && plan.intent) || "").trim();
  try {
    fetch("/api/term/ai/history", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        host: host || "", question: question || "",
        title: title,
        command: (plan && plan.command) || "",
        risk: (plan && plan.risk) || "",
        ok: failed ? 0 : 1,
        exit_code: (res && typeof res.exit_code === "number") ? res.exit_code : null,
      }),
    }).catch(() => { /* 忽略 */ });
  } catch (_) { /* 忽略 */ }
}

/* ---------- 建议卡片（内置终端 / SSH 浮层共用） ----------
   ctx = { exec(cmd), fill(cmd), newSession(), onDone(res) } */
function taiBuildPlanCard(plan, question, ctx) {
  const card = document.createElement("div");
  card.className = "tai-card";
  const risk = TAI_RISK[plan.risk] || TAI_RISK.medium;
  const cmd = String(plan.command || "").trim();

  const hd = document.createElement("div");
  hd.className = "tai-hd";
  hd.innerHTML =
    '<span class="tai-ic">' + taiIco("bi-stars") + '</span>' +
    '<span class="tai-tt"></span>' +
    '<span class="tai-risk ' + risk.cls + '" title="' + esc(risk.tip) + '">' +
      taiIco(risk.icon) + risk.label + '</span>' +
    '<span class="tai-sp"></span>' +
    '<button type="button" class="tai-mini tai-new" title="开启新会话：清空当前 AI 上下文">' +
      '' + taiIco("bi-plus-lg") + '开启新会话</button>';
  taiSetText(hd.querySelector(".tai-tt"), plan.intent || question);
  hd.querySelector(".tai-new").addEventListener("click", (e) => {
    e.stopPropagation();
    if (ctx.newSession) ctx.newSession();
  });
  card.appendChild(hd);

  if (plan.reason) {
    const n = document.createElement("div");
    n.className = "tai-note";
    n.innerHTML = '' + taiIco("bi-info-circle", "tai-note-ic") + '<span></span>';
    taiSetText(n.querySelector("span"), plan.reason);
    card.appendChild(n);
  }
  if (plan.note) {
    const n = document.createElement("div");
    n.className = "tai-note warn";
    n.innerHTML = '' + taiIco("bi-exclamation-triangle") + '<span></span>';
    taiSetText(n.querySelector("span"), plan.note);
    card.appendChild(n);
  }

  if (cmd) {
    const box = document.createElement("div");
    box.className = "tai-cmd";
    box.innerHTML =
      '<span class="tai-ps">$</span><code></code>' +
      '<button type="button" class="tai-copy" title="复制命令">' + taiIco("bi-clipboard") + '</button>' +
      '<span class="tai-state">待执行</span>';
    const code = box.querySelector("code");
    taiSetText(code, cmd);
    box.querySelector(".tai-copy").addEventListener("click", (e) => {
      e.stopPropagation();
      const text = plan.command || "";
      if (!text) return;
      if (typeof copyText === "function") copyText(text);
      else if (navigator.clipboard) navigator.clipboard.writeText(text).then(() => toast("已复制", "ok"), () => {});
    });
    card.appendChild(box);

    // 备选命令：点一下替换主命令
    const alts = (plan.alternatives || []).filter(a => a && a !== plan.command).slice(0, 2);
    if (alts.length) {
      const row = document.createElement("div");
      row.className = "tai-alts";
      row.appendChild(document.createTextNode("也可："));
      alts.forEach(altCmd => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "tai-alt";
        taiSetText(b, altCmd);
        b.addEventListener("click", (e) => {
          e.stopPropagation();
          plan.command = altCmd;
          taiSetText(code, altCmd);
          const st = box.querySelector(".tai-state");
          if (st) { st.textContent = "待执行"; st.className = "tai-state"; }
        });
        row.appendChild(b);
      });
      card.appendChild(row);
    }
  }

  if (plan.explain) {
    const ex = document.createElement("div");
    ex.className = "tai-explain";
    taiSetText(ex, plan.explain);
    card.appendChild(ex);
  }

  const acts = document.createElement("div");
  acts.className = "tai-actions";
  if (cmd) {
    if (!plan.blocked) {
      acts.appendChild(taiBtn("primary", "bi-play-fill", "执行", () => taiRunPlan(card, plan, question, ctx)));
    }
    acts.appendChild(taiBtn("", "bi-pencil-square", "仅填入输入框", () => {
      if (ctx.fill) ctx.fill(cmd);
    }));
    acts.appendChild(taiBtn("", "bi-star-plus", "加入常用", () => {   // 存进侧栏「常用命令」，点击即可在 SSH 终端执行
      const name = String(plan.intent || question || "").trim();      // 名称优先用 AI 生成的意图标题
      const r = (typeof window.sshCmdsAdd === "function") ? window.sshCmdsAdd(name, cmd) : null;
      toast(!r ? "常用命令模块不可用（请刷新页面）"
               : (r.added ? "已加入常用命令：" + (name || cmd) : "该命令已在常用命令里"), r ? "ok" : "warn");
    }));
  }
  if (plan.blocked) {
    const tip = document.createElement("span");
    tip.className = "tai-hint bad";
    tip.textContent = "已被命令安全策略拦截，不会执行";
    acts.appendChild(tip);
  } else if (cmd) {
    const tip = document.createElement("span");
    tip.className = "tai-hint";
    tip.textContent = plan.need_confirm ? "执行时会再次确认" : "执行后自动解读输出";
    acts.appendChild(tip);
  }
  if (acts.childElementCount) card.appendChild(acts);
  return card;
}

/* 执行一条建议命令：状态回填 + 成功后回调 ctx.onDone(res) */
async function taiRunPlan(card, plan, question, ctx) {
  const cmd = String(plan.command || "").trim();
  if (!cmd || TAI.busy) return;
  const st = card.querySelector(".tai-state");
  const acts = card.querySelector(".tai-actions");
  const btns = acts ? Array.from(acts.querySelectorAll("button")) : [];
  btns.forEach(b => { b.disabled = true; });
  if (st) { st.textContent = "执行中…"; st.className = "tai-state run"; }

  TAI.busy = true;
  let res = null;
  try { res = await ctx.exec(cmd); }
  catch (e) { res = { error: (e && e.message) ? e.message : String(e) }; }
  TAI.busy = false;
  btns.forEach(b => { b.disabled = false; });

  const blocked = !!(res && res.blocked);
  const cancelled = !res || !!res.cancelled;
  const failed = cancelled || blocked || !!(res && res.error);
  if (st) {
    st.textContent = cancelled ? "已取消" : (blocked ? "已拦截" : (failed ? "执行失败" : "已执行"));
    st.className = "tai-state " + (cancelled ? "" : (blocked ? "bad" : (failed ? "warn" : "ok")));
  }
  if (failed) {
    if (!cancelled) {
      const n = document.createElement("div");
      n.className = "tai-note warn";
      taiSetText(n, (res && (res.error || res.reason)) || "命令没有执行");
      card.appendChild(n);
    }
    if (ctx.onFail) ctx.onFail(res);
    return;
  }
  if (ctx.onDone) await ctx.onDone(res);
}

/* ---------- 解读 / 复盘卡片（共用） ----------
   opt = { url, title, icon, live, onEnd }：默认是「单条命令的输出解读」；
   会话复盘复用它，只换端点 / 标题 / 图标。 */
function taiAnalyzeCard(mount, payload, scroll, opt) {
  if (!mount) return;
  opt = opt || {};
  const card = document.createElement("div");
  card.className = "tai-card tai-ana";
  card.innerHTML =
    '<div class="tai-hd"><span class="tai-ic">' + taiIco(opt.icon || "bi-lightbulb") + '</span>' +
      '<span class="tai-tt"></span><span class="tai-sp"></span>' +
      '<span class="tai-live">' + taiIco("bi-arrow-repeat", "tai-spin") + ' ' + (opt.live || "分析中…") + '</span>' +
      '<button type="button" class="tai-mini tai-stop" title="停止生成">' + taiIco("bi-stop-fill") + '停止</button>' +
    '</div>' +
    '<div class="tai-md"></div>';
  taiSetText(card.querySelector(".tai-tt"), opt.title || "输出解读");
  mount.appendChild(card);
  const md = card.querySelector(".tai-md");
  const live = card.querySelector(".tai-live");
  const stop = card.querySelector(".tai-stop");
  const ac = new AbortController();
  TAI.abort = ac;
  stop.addEventListener("click", (e) => {
    e.stopPropagation();
    try { ac.abort(); } catch (_) { /* 忽略 */ }
  });

  let acc = "";
  const bump = () => { if (scroll) scroll(); };
  bump();

  taiStream(opt.url || "/api/term/ai/analyze", payload, ac.signal, (delta) => {
    acc += delta;
    md.innerHTML = taiMd(acc);
    bump();
  }).then((err) => {
    if (err) {
      const e = document.createElement("div");
      e.className = "tai-err";
      taiSetText(e, err);
      md.appendChild(e);
    }
  }).catch((e) => {
    const msg = (e && e.message) ? e.message : String(e);
    const aborted = (e && e.name === "AbortError") || /abort/i.test(msg);
    const tip = document.createElement("div");
    tip.className = "tai-err";
    taiSetText(tip, aborted ? "（已停止解读）" : ("解读失败：" + msg));
    md.innerHTML = acc ? taiMd(acc) : "";
    md.appendChild(tip);
  }).finally(() => {
    TAI.abort = null;
    if (live) live.remove();
    if (stop) stop.remove();
    if (!acc && !md.querySelector(".tai-err")) {
      const tip = document.createElement("div");
      tip.className = "tai-err";
      tip.textContent = "（没有拿到解读内容）";
      md.appendChild(tip);
    }
    if (typeof opt.onEnd === "function") { try { opt.onEnd(); } catch (_) { /* 忽略 */ } }
    bump();
  });
}

function taiAnalyzePayload(question, plan, res, prevText) {
  return {
    question: question, command: plan.command,
    stdout: taiClip(res.stdout, 12000), stderr: taiClip(res.stderr, 4000),
    exit_code: res.exit_code, cwd: res.cwd || "",
    context: prevText || "",
  };
}

/* ============================================================================
   ① 底部内置终端
   ============================================================================ */
function taiAsk(raw) {
  if (TAI.busy) { toast("上一条 AI 指令还在处理，请稍候", "warn"); return Promise.resolve(); }
  return taiAskInner(raw);
}

async function taiAskInner(raw) {
  let text = String(raw || "").trim().replace(/^[?？]\s*/, "");
  if (!text) return;
  if (text.charAt(0) === "!") {                 // AI 模式下用 ! 强制当命令执行
    const cmd = text.slice(1).trim();
    if (cmd) termRun(cmd);
    return;
  }
  if (!(await termEnsure()) || !curTerm) return;
  const S = curTerm;
  toggleBottom(true, "term");

  TAI.busy = true;
  S.body.appendChild(taiUserLineEl(text));
  const wait = taiLoadingEl();
  S.body.appendChild(wait);
  taiScroll(S);
  try {
    const d = await taiPost("/api/term/ai/plan", {
      input: text,
      cwd: S.cwd || (typeof ROOT !== "undefined" ? ROOT : "") || "",
      web_search: (localStorage.getItem("ide.termAi.webSearch") !== "0"),
      history: (S.aiHist || []).slice(-2).map(x => ({ q: x.q, cmd: x.cmd })),
    });
    wait.remove();
    if (d.error) { S.body.appendChild(taiErrorEl(d.error, d.need_config || d.disabled)); taiScroll(S); return; }
    const ctx = {
      exec: (cmd) => {
        if (TERMS.indexOf(S) < 0) return { error: "终端会话已关闭，请重新提问" };
        if (S.busy) return { error: "该终端正在执行其他命令，请稍候" };
        if (S !== curTerm) selectTerm(S);
        return termRun(cmd);
      },
      fill: (cmd) => {
        const inp = $("termInput");
        if (inp) { inp.value = cmd; inp.focus(); }
      },
      newSession: taiNewSession,
      onDone: (res) => {
        S.aiHist = Array.isArray(S.aiHist) ? S.aiHist : [];
        S.aiHist.push({ q: text, cmd: d.command, out: String(res.stdout || "").slice(0, 1200) });
        if (S.aiHist.length > 4) S.aiHist.shift();
        taiSaveHist("", text, d, res);
        const prev = S.aiHist.slice(-2, -1).map(x => "需求：" + (x.q || "") + "；命令：" + (x.cmd || "")).join("\n");
        taiAnalyzeCard(S.body, taiAnalyzePayload(text, d, res, prev), () => taiScroll(S));
      },
      onFail: (res) => taiSaveHist("", text, d, res),
    };
    S.body.appendChild(taiBuildPlanCard(d, text, ctx));
    taiScroll(S);
  } catch (e) {
    wait.remove();
    S.body.appendChild(taiErrorEl("请求失败：" + ((e && e.message) ? e.message : e)));
    taiScroll(S);
  } finally {
    TAI.busy = false;
    const inp = $("termInput");
    if (inp) inp.focus();
  }
}

/* 开启新会话：新建终端（AI 上下文随旧会话一起丢弃） */
function taiNewSession() {
  if (curTerm && curTerm.aiHist) curTerm.aiHist = [];
  termNew().then((s) => {
    if (!s) return;
    const inp = $("termInput");
    if (inp) inp.focus();
    toast("已开启新的 AI 会话", "ok");
  });
}

/* ---------- 输入框：AI 开关 + 自然语言拦截 ---------- */
function taiSyncToggle() {
  const btn = $("taiToggle");
  const inp = $("termInput");
  if (btn) {
    btn.classList.toggle("on", TAI.on);
    btn.title = TAI.on
      ? "AI 模式已开启：输入内容交给 AI（想直接执行命令时在命令前加 !）"
      : "AI 模式：用自然语言描述操作，由 AI 生成命令并解读结果";
  }
  if (inp) {
    inp.placeholder = TAI.on
      ? "描述你要做什么，Enter 交给 AI（如：查看当前服务器的 IP）"
      : "输入命令并回车（↑↓ 历史 · Ctrl+L 清屏 · Ctrl+C 终止）";
  }
}

function taiInit() {
  const inp = $("termInput");
  if (!inp || $("taiToggle")) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.id = "taiToggle";
  btn.className = "tai-toggle";
  btn.innerHTML = '' + taiIco("bi-stars") + '<span>AI</span>';
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    TAI.on = !TAI.on;
    taiSyncToggle();
    if (!$("bottomPanel").classList.contains("show")) toggleBottom(true, "term");
    if (TAI.on) termEnsure();                // 打开 AI 模式时顺手建一个终端会话
    inp.focus();
    toast(TAI.on ? "AI 模式已开启：直接描述你要做什么（命令前加 ! 可直接执行）"
                 : "已切回命令模式（中文需求仍会自动交给 AI）", "info");
  });
  inp.parentElement.insertBefore(btn, inp);
  taiSyncToggle();
}

/* 捕获阶段拦 Enter：比 13_ 里终端自己的 keydown 更早，
   判定为自然语言就交给 AI，并阻止它把这句话当命令执行。 */
document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
  const inp = e.target;
  if (!inp || inp.id !== "termInput") return;
  const v = String(inp.value || "");
  if (!v.trim()) return;
  if (!taiNatural(v)) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.stopImmediatePropagation) e.stopImmediatePropagation();
  inp.value = "";
  taiAsk(v);
}, true);

/* ============================================================================
   ② SSH 远程终端：浮层助手
   o = { label, env, run(cmd)=>Promise<res>, paste(cmd), prefill }
   ============================================================================ */
let taiPopState = null;

function taiPopClose() {
  try { if (TAI.abort) TAI.abort.abort(); } catch (_) { /* 忽略 */ }
  const el = $("taiPop");
  if (el) el.remove();
  taiPopState = null;
}

/* 浮动面板可拖动：按住标题栏拖，双击标题栏回到右下角默认位置（位置记在 localStorage） */
const TAI_POP_POS_KEY = "ide.ai.popPos";

function taiMakeDraggable(pop) {
  const hd = pop.querySelector(".tai-pop-hd");
  if (!hd) return;
  let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;

  const apply = (left, top) => {
    const w = pop.offsetWidth || 0;
    const maxL = Math.max(8, window.innerWidth - w - 8);
    const maxT = Math.max(8, window.innerHeight - 48);
    pop.style.left = Math.min(Math.max(8, left), maxL) + "px";
    pop.style.top = Math.min(Math.max(8, top), maxT) + "px";
    pop.style.right = "auto";
    pop.style.bottom = "auto";
  };

  // 恢复上次拖动后的位置（窗口变小则回到可见区域）
  try {
    const saved = JSON.parse(localStorage.getItem(TAI_POP_POS_KEY) || "null");
    if (saved && isFinite(saved.left) && isFinite(saved.top)) apply(saved.left, saved.top);
  } catch (_) { /* 忽略 */ }

  const onMove = (e) => {
    if (!dragging) return;
    apply(ox + e.clientX - sx, oy + e.clientY - sy);
  };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    pop.classList.remove("dragging");
    document.body.classList.remove("tai-dragging");
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    try {
      localStorage.setItem(TAI_POP_POS_KEY, JSON.stringify({
        left: parseInt(pop.style.left, 10) || 0,
        top: parseInt(pop.style.top, 10) || 0,
      }));
    } catch (_) { /* 忽略 */ }
  };

  hd.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    if (e.target.closest("button")) return;          // 标题栏上的按钮不触发拖动
    const r = pop.getBoundingClientRect();
    sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
    dragging = true;
    pop.classList.add("dragging");
    document.body.classList.add("tai-dragging");
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    e.preventDefault();
  });

  hd.addEventListener("dblclick", () => {            // 双击标题栏：回到默认位置
    pop.style.left = pop.style.top = pop.style.right = pop.style.bottom = "";
    try { localStorage.removeItem(TAI_POP_POS_KEY); } catch (_) { /* 忽略 */ }
  });

  window.addEventListener("resize", () => {
    if (!pop.isConnected || !pop.style.left) return;
    apply(parseInt(pop.style.left, 10) || 0, parseInt(pop.style.top, 10) || 0);
  });
}

function taiOpenSsh(o) {
  o = o || {};
  if (typeof o.run !== "function") { toast("AI 助手未就绪：缺少 SSH 执行通道", "err"); return null; }
  // 停靠模式（SSH 终端内）按挂载点隔离，多个终端标签互不干扰
  const old = o.mount ? o.mount.querySelector(".tai-pop") : $("taiPop");
  if (old) old.remove();

  const pop = document.createElement("div");
  pop.className = "tai-pop" + (o.mount ? " tai-pop-dock" : "");
  if (!o.mount) pop.id = "taiPop";
  pop.innerHTML =
    '<div class="tai-pop-hd" title="拖动可移动面板 · 双击回到默认位置">' +
      '<span class="tai-pop-t">' + taiIco("bi-stars") + '<b>' + (o.mount ? "Agent" : "AI 助手") + '</b>' +
        (o.label ? '<em>' + esc(o.label) + '</em>' : '') + '</span>' +
      '<span class="tai-pop-sp"></span>' +
      '<button type="button" class="tai-pop-hbtn tai-web-btn" title="联网搜索（安装 / 下载类需求会先搜索官方地址，避免生成错误 URL）">' +
        taiIco("bi-globe") + '</button>' +
      '<button type="button" class="tai-pop-hbtn tai-hist-btn" title="历史记录（保存在数据库）">' +
        '' + taiIco("bi-clock-history") + '</button>' +
      '<button type="button" class="tai-pop-x" title="' + (o.mount ? "切回 Shell" : "关闭（Esc）") + '">' +
        taiIco(o.mount ? "bi-terminal" : "bi-x-lg") + '</button>' +
    '</div>' +
    '<div class="tai-pop-bd">' +
      '<div class="tai-hist" hidden>' +
        '<div class="tai-hist-hd">' + taiIco("bi-clock-history") + '<span>历史记录</span>' +
          '<span class="tai-hist-sp"></span>' +
          '<button type="button" class="tai-hist-clear" title="清空全部历史">清空</button></div>' +
        '<div class="tai-hist-list"></div>' +
      '</div>' +
      '<textarea class="tai-pop-in" spellcheck="false" rows="2" ' +
        'placeholder="用一句话描述要在这台主机上做什么，例如：查看当前 IP / 磁盘占用 / 8080 端口被谁占用"></textarea>' +
      '<div class="tai-pop-tip">Enter 生成命令 · Shift+Enter 换行 · ' +
        (o.mount ? 'Esc 切回 Shell' : 'Esc 关闭') + '（先点「生成命令」再决定是否执行）</div>' +
      '<div class="tai-pop-acts">' +
        (typeof o.transcript === "function"
          ? '<button type="button" class="tai-btn tai-pop-ana" title="把当前终端里已执行过的命令与系统回显整体交给 AI 复盘">' +
              taiIco("bi-clipboard-data") + '<span>分析本次会话</span></button>'
          : '') +
        '<button type="button" class="tai-btn primary tai-pop-gen">' + taiIco("bi-stars") + '<span>生成命令</span></button>' +
      '</div>' +
      '<div class="tai-pop-out"></div>' +
    '</div>';
  (o.mount || document.body).appendChild(pop);
  if (!o.mount) taiMakeDraggable(pop);              // 浮动面板支持拖动

  const ta = pop.querySelector(".tai-pop-in");
  const genBtn = pop.querySelector(".tai-pop-gen");
  const out = pop.querySelector(".tai-pop-out");
  const histWrap = pop.querySelector(".tai-hist");
  const histList = pop.querySelector(".tai-hist-list");
  const histBtn = pop.querySelector(".tai-hist-btn");
  const histClear = pop.querySelector(".tai-hist-clear");
  const state = { el: pop, out: out, ta: ta, hist: [], host: o.host || o.label || "" };
  taiPopState = state;
  let histOpen = false;

  /* 联网开关：默认开启。安装 / 下载类需求会先搜索，把官方地址喂给模型，避免编造 URL */
  const webBtn = pop.querySelector(".tai-web-btn");
  const webOn = () => localStorage.getItem("ide.termAi.webSearch") !== "0";
  const webSync = () => webBtn.classList.toggle("on", webOn());
  webSync();
  webBtn.addEventListener("click", () => {
    localStorage.setItem("ide.termAi.webSearch", webOn() ? "0" : "1");
    webSync();
    toast(webOn() ? "已开启联网：生成命令前会先搜索官方地址" : "已关闭联网", "ok");
  });

  const closeSelf = () => {
    if (o.mount && typeof o.onClose === "function") { o.onClose(); return; }
    taiPopClose();
  };
  pop.querySelector(".tai-pop-x").addEventListener("click", closeSelf);
  pop.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); closeSelf(); }
  });
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      gen();
    }
  });
  genBtn.addEventListener("click", gen);

  /* ---------- 历史记录（存 store.db 的 term_ai_history 表） ---------- */
  function histEmpty(msg, cls) {
    histList.innerHTML = '<div class="tai-hist-empty' + (cls ? " " + cls : "") + '"></div>';
    taiSetText(histList.firstChild, msg);
  }

  function renderHist(items) {
    histList.innerHTML = "";
    if (!items || !items.length) { histEmpty("还没有历史记录，生成并执行一条命令后就会出现在这里"); return; }
    items.forEach(it => {
      const row = document.createElement("div");
      row.className = "tai-hist-i";
      row.title = "点击把这条需求填回输入框" + (it.question ? "\n原始输入：" + it.question : "");

      const l1 = document.createElement("div");
      l1.className = "tai-hist-l1";
      const t = document.createElement("span");
      t.className = "tai-hist-t";
      t.textContent = String(it.ts || "").slice(5, 16);        // MM-DD HH:MM
      l1.appendChild(t);
      if (it.host) {
        const h = document.createElement("span");
        h.className = "tai-hist-host";
        h.textContent = it.host;
        l1.appendChild(h);
      }
      const risk = TAI_RISK[it.risk];
      if (risk) {
        const r = document.createElement("span");
        r.className = "tai-risk " + risk.cls;
        r.textContent = risk.label;
        l1.appendChild(r);
      }
      const st = document.createElement("span");
      st.className = "tai-hist-ok " + (it.ok ? "ok" : "no");
      st.textContent = it.ok ? "✓ 已执行" : "未成功";
      l1.appendChild(st);
      row.appendChild(l1);

      const q = document.createElement("div");
      q.className = "tai-hist-q";
      q.textContent = it.title || it.question || "（无描述）";   // 优先显示 AI 标题
      row.appendChild(q);

      const l3 = document.createElement("div");
      l3.className = "tai-hist-l3";
      const code = document.createElement("code");
      code.textContent = it.command || "";
      l3.appendChild(code);

      const use = document.createElement("button");
      use.type = "button";
      use.className = "tai-hist-use";
      use.title = "填入终端输入行（不执行）";
      use.innerHTML = '' + taiIco("bi-arrow-return-left") + '填入';
      use.addEventListener("click", (e) => {
        e.stopPropagation();
        taiPasteToTerm(o, it.command || "");
        toast("已填入终端输入行（未执行）", "ok");
      });
      l3.appendChild(use);

      const del = document.createElement("button");
      del.type = "button";
      del.className = "tai-hist-del";
      del.title = "删除这条历史";
      del.innerHTML = '' + taiIco("bi-trash3") + '';
      del.addEventListener("click", async (e) => {
        e.stopPropagation();
        const msg = "确定删除这条历史记录吗？删除后不可恢复。";
        // 与「清空」一致：优先用项目里的轻量二次确认悬浮框（贴着删除按钮弹出，层级在 AI 面板之上）
        let ask;
        if (typeof uiConfirmPop === "function") {
          ask = uiConfirmPop(del, { title: "删除历史", msg: msg, okText: "删除", danger: true });
        } else if (typeof uiConfirm === "function") {
          ask = uiConfirm("删除历史", msg, "删除", true);
        } else {
          ask = Promise.resolve(window.confirm(msg));
        }
        const ok = await ask;
        if (!ok) return;
        try { await fetch("/api/term/ai/history?id=" + encodeURIComponent(it.id), { method: "DELETE" }); } catch (_) {}
        row.remove();
        if (!histList.childElementCount) histEmpty("还没有历史记录");
      });
      l3.appendChild(del);
      row.appendChild(l3);

      row.addEventListener("click", () => {
        ta.value = it.question || it.command || "";
        ta.focus();
        try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch (_) {}
      });
      histList.appendChild(row);
    });
  }

  async function loadHist() {
    histEmpty("加载中…");
    try {
      const r = await fetch("/api/term/ai/history?limit=50");
      const d = await r.json();
      if (!r.ok || d.error) { histEmpty(d.error || ("HTTP " + r.status), "bad"); return; }
      renderHist(d.items || []);
    } catch (e) {
      histEmpty("读取历史失败：" + ((e && e.message) ? e.message : e), "bad");
    }
  }

  histBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    histOpen = !histOpen;
    histWrap.hidden = !histOpen;
    histBtn.classList.toggle("on", histOpen);
    if (histOpen) loadHist();
  });
  histClear.addEventListener("click", async (e) => {
    e.stopPropagation();
    const msg = "确定清空所有终端 AI 历史记录吗？此操作不可恢复。";
    // 优先用项目里的轻量二次确认悬浮框（贴着「清空」按钮弹出，层级在 AI 面板之上）
    let ask;
    if (typeof uiConfirmPop === "function") {
      ask = uiConfirmPop(histClear, { title: "清空历史", msg: msg, okText: "清空", danger: true });
    } else if (typeof uiConfirm === "function") {
      ask = uiConfirm("清空历史", msg, "清空", true);
    } else {
      ask = Promise.resolve(window.confirm(msg));
    }
    const ok = await ask;
    if (!ok) return;
    try { await fetch("/api/term/ai/history?all=1", { method: "DELETE" }); } catch (_) {}
    loadHist();
  });

  if (o.prefill) ta.value = o.prefill;
  ta.focus();
  if (o.prefill) ta.setSelectionRange(ta.value.length, ta.value.length);

  function ctxFor(plan, question) {
    return {
      exec: (cmd) => o.run(cmd),
      fill: (cmd) => {
        // 「仅填入输入框」：把命令打到终端输入行，但**不关闭面板、不执行**
        taiPasteToTerm(o, cmd);
        if (o.mount && typeof o.onFill === "function") o.onFill();
        toast("已填入终端输入行（未执行）", "ok");
      },
      newSession: () => {
        state.hist = [];
        out.innerHTML = "";
        ta.value = "";
        ta.focus();
        toast("已开始新的 AI 对话", "ok");
      },
      onDone: (res) => {
        state.hist.push({ q: question, cmd: plan.command, out: String(res.stdout || "").slice(0, 1200) });
        if (state.hist.length > 4) state.hist.shift();
        taiSaveHist(state.host, question, plan, res);
        if (histOpen) loadHist();
        const prev = state.hist.slice(-2, -1).map(x => "需求：" + (x.q || "") + "；命令：" + (x.cmd || "")).join("\n");
        taiAnalyzeCard(out, taiAnalyzePayload(question, plan, res, prev), () => { out.scrollTop = out.scrollHeight; });
      },
      onFail: (res) => {
        taiSaveHist(state.host, question, plan, res);
        if (histOpen) loadHist();
      },
    };
  }

  // 把某张卡片滚到可视区顶部（不要一路滚到最底部，否则卡片标题会被顶出视野）
  function scrollToCard(card) {
    try {
      const top = card.getBoundingClientRect().top - out.getBoundingClientRect().top + out.scrollTop - 6;
      out.scrollTop = Math.max(0, top);
    } catch (_) { /* 忽略 */ }
  }

  async function gen() {
    const text = ta.value.trim();
    if (!text) { ta.focus(); return; }
    if (TAI.busy) { toast("上一条指令还在处理，请稍候", "warn"); return; }
    if (histOpen) { histOpen = false; histWrap.hidden = true; histBtn.classList.remove("on"); }
    TAI.busy = true;
    genBtn.disabled = true;
    const wait = taiLoadingEl("正在生成命令…");
    out.appendChild(wait);
    out.scrollTop = out.scrollHeight;
    try {
      const d = await taiPost("/api/term/ai/plan", {
        input: text,
        env: o.env || "",
        web_search: (localStorage.getItem("ide.termAi.webSearch") !== "0"),
        history: state.hist.slice(-2).map(x => ({ q: x.q, cmd: x.cmd })),
      });
      wait.remove();
      if (d.error) {
        out.appendChild(taiErrorEl(d.error, d.need_config || d.disabled));
        out.scrollTop = out.scrollHeight;
      } else {
        const card = taiBuildPlanCard(d, text, ctxFor(d, text));
        out.appendChild(card);
        scrollToCard(card);
      }
    } catch (e) {
      wait.remove();
      out.appendChild(taiErrorEl("请求失败：" + ((e && e.message) ? e.message : e)));
      out.scrollTop = out.scrollHeight;
    } finally {
      TAI.busy = false;
      genBtn.disabled = false;
      ta.focus();
    }
  }

  /* ---------- 一键分析本次会话 ----------
     把当前终端 buffer 里的全部内容（用户执行过的命令 + 系统回显）一次性交给
     后端复盘：做了什么、哪条失败、有无风险、下一步怎么查。服务端会先把长会话
     压缩（保留命令与报错）再喂给模型，避免超长记录把上下文撑爆。 */
  const anaBtn = pop.querySelector(".tai-pop-ana");
  if (anaBtn) anaBtn.addEventListener("click", analyseSession);

  function analyseSession() {
    if (anaBtn.disabled) return;
    if (TAI.busy) { toast("上一条指令还在处理，请稍候", "warn"); return; }
    let text = "";
    try { text = String(o.transcript() || ""); } catch (_) { text = ""; }
    if (!text.trim()) { toast("当前终端还没有输出，先执行几条命令再来分析", "warn"); return; }
    if (histOpen) { histOpen = false; histWrap.hidden = true; histBtn.classList.remove("on"); }
    const lines = text.split("\n").length;
    anaBtn.disabled = true;
    out.appendChild(taiUserLineEl("分析本次会话：共 " + lines + " 行，约 " +
      Math.max(1, Math.round(text.length / 1000)) + "k 字符"));
    out.scrollTop = out.scrollHeight;
    taiAnalyzeCard(out, {
      transcript: text,
      host: state.host || "",
      env: o.env || "",
      question: ta.value.trim(),        // 输入框里已写的疑问，一并作为关注点
    }, () => { out.scrollTop = out.scrollHeight; }, {
      url: "/api/term/ai/session",
      title: "会话复盘",
      icon: "bi-clipboard-data",
      live: "通读会话…",
      onEnd: () => { anaBtn.disabled = false; },
    });
  }

  return {
    el: pop,
    close: closeSelf,
    focus: () => ta.focus(),
    prefill: (t) => {
      ta.value = t || "";
      ta.focus();
      try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch (_) { /* 忽略 */ }
    },
    clear: () => { state.hist = []; out.innerHTML = ""; ta.value = ""; },
  };
}

/* 供其它模块（SSH 终端）调用 */
window.TermAI = {
  openSsh: taiOpenSsh,
  icon: taiIco,
  close: taiPopClose,
  stripAnsi: taiStripAnsi,
  sshNatural: taiSshNatural,
  looksNatural: taiNatural,
};

/* ---------- Ctrl+Shift+I：Shell ⇄ Agent 切换（参考 OrcaTerm） ----------
   SSH 终端由 38_ 注册的 aiToggleMode 处理；其余情况（底部内置终端）切 AI 模式。 */
document.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey && e.shiftKey) || e.altKey || e.metaKey) return;
  if (String(e.key || "").toLowerCase() !== "i") return;
  const t = (typeof active !== "undefined") ? active : null;
  if (t && t.isSshTerm) {
    if (typeof t.aiToggleMode === "function") { e.preventDefault(); t.aiToggleMode(); }
    return;
  }
  e.preventDefault();
  if (TAI.on) {
    TAI.on = false;
    taiSyncToggle();
    toast("已切回 Shell 模式", "info");
    const inp0 = $("termInput");
    if (inp0) inp0.focus();
    return;
  }
  toggleBottom(true, "term");
  termEnsure().then(() => {
    TAI.on = true;
    taiSyncToggle();
    const inp = $("termInput");
    if (inp) inp.focus();
    toast("已切换到 Agent 模式：直接描述你要做什么", "ok");
  });
}, true);

taiInit();

/* ---------- 离开 / 从往返缓存恢复时清理：避免「刷新后又冒出旧的悬浮框 / 已断开的终端」 ---------- */
window.addEventListener("pagehide", () => {
  try { if ($("taiPop")) taiPopClose(); } catch (_) { /* 忽略 */ }
});

window.addEventListener("pageshow", (e) => {
  if (!e || !e.persisted) return;                 // 只有从 bfcache 恢复才需要处理
  try { if (window.TermAI) window.TermAI.close(); } catch (_) { /* 忽略 */ }
  try {
    const list = (typeof tabs !== "undefined" && Array.isArray(tabs)) ? tabs.slice() : [];
    list.filter(t => t && t.isSshTerm).forEach(t => {
      try { if (typeof t.onBeforeClose === "function") t.onBeforeClose(); } catch (_) { /* 忽略 */ }
    });
  } catch (_) { /* 忽略 */ }
});

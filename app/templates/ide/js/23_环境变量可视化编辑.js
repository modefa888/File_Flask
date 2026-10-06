/* ================================================================
   项目根 .env：可视化编辑浮框
   ----------------------------------------------------------------
   打开 .env（含 .env.local / .env.example 等）时，在编辑器右上角悬浮一个
   图形化表单：按 .env 里的注释分组，一行一个参数（左名称 + 变量名/说明，右控件），
   实时写回 CodeMirror 文本（文本是唯一真源，注释与其它内容不动）。
   底部「添加字段」可新增 KEY=VALUE（追加到文件末尾，带变量名校验与去重）。
   文本被改动时（输入 / 撤销 / 重新加载等）浮框会动态重建，保持与文件一致。
   由 00_preamble.js 的 openFile 文本分支在 CodeMirror 建好后调用。
   注意：类名前缀统一用 env-edit-，避免与 14_运行环境面板 的 .env-* 冲突。
   ================================================================ */
function setupEnvView(tab) {
  if (!tab || !tab.cm) return;
  if (tab.host.querySelector(".env-edit-panel")) return;

  // ---- 已知系统参数的友好名称 / 控件类型 / 提示（未知 KEY 自动推断）----
  var META = {
    SECRET_KEY:          { label: "会话签名密钥", type: "password", hint: "务必改成随机强值，否则他人可伪造登录 cookie" },
    AUTH_USERNAME:       { label: "登录用户名", type: "text" },
    AUTH_PASSWORD:       { label: "登录密码", type: "password" },
    HOST:                { label: "监听地址", type: "text", hint: "0.0.0.0 = 所有网卡；127.0.0.1 = 仅本机" },
    PORT:                { label: "服务端口", type: "number", min: 1, max: 65535 },
    DEBUG:               { label: "调试模式", type: "bool" },
    DEFAULT_START_PATH:  { label: "默认浏览根目录", type: "text", hint: "留空 = 系统根（Linux 的 / 或 Windows 的 C:\\）" },
    ENABLE_EXEC:         { label: "允许执行命令", type: "bool", hint: "公网部署请关闭" },
    EXEC_ENFORCE_SAFETY: { label: "危险命令拦截校验", type: "bool" },
    ENABLE_AUTO_INSTALL: { label: "运行环境一键安装", type: "bool", hint: "下载官方包到 ~/.local" },
    RUN_TIMEOUT:         { label: "默认超时（秒）", type: "number", min: 0 },
    RUN_TIMEOUT_MAX:     { label: "最大超时（秒）", type: "number", min: 0 },
    RUN_TIMEOUT_ACTION:  { label: "超时后动作", type: "select",
                           options: [["background", "转为后台继续运行"], ["kill", "终止进程"]] }
  };

  function inferType(key, value) {
    if (value === "true" || value === "false") return "bool";
    if (/^-?\d+$/.test(value)) return "number";
    if (/(PASSWORD|PASSWD|SECRET|TOKEN|API_KEY|APIKEY)/i.test(key) || /_KEY$/.test(key)) return "password";
    return "text";
  }
  function metaFor(key, value) {
    var m = META[key] || { label: key, type: inferType(key, value) };
    return { label: m.label || key, type: m.type, hint: m.hint, min: m.min, max: m.max, options: m.options };
  }

  // ---- 解析 .env 文本为分组：[{title, items:[{key,value,comment}]}] ----
  function parse() {
    var lines = tab.cm.getValue().split("\n");
    var groups = [];
    var cur = { title: "", items: [] };
    var pending = [];
    // 分组标题形如 `# ---- 安全 ----`；分隔线内部必须夹着真实文字，
    // 纯 `# ==========` 分隔线不再被误判成名为 "=" 的分组。
    var groupRe = /^\s*#+\s*[=\-]{3,}\s*([^=\-\s].*?)\s*[=\-]{3,}\s*$/;
    var kvRe = /^\s*(?:export\s+)?([A-Za-z_][\w.]*)\s*=(.*)$/;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (/^\s*#/.test(line)) {
        var g = line.match(groupRe);
        if (g && g[1] && g[1].trim()) {
          if (cur.items.length || cur.title) groups.push(cur);
          cur = { title: g[1].trim(), items: [] };
          pending = [];
        } else {
          var txt = line.replace(/^\s*#+\s?/, "").trim();
          if (txt) pending.push(txt);
        }
        continue;
      }
      var m = line.match(kvRe);
      if (m) {
        cur.items.push({ key: m[1], value: (m[2] || "").trim(), comment: pending.join(" ") });
        pending = [];
        continue;
      }
      if (line.trim() === "") pending = [];
    }
    if (cur.items.length || cur.title) groups.push(cur);
    return groups;
  }

  function keyExists(key) {
    var groups = parse();
    for (var i = 0; i < groups.length; i++) {
      for (var j = 0; j < groups[i].items.length; j++) {
        if (groups[i].items[j].key === key) return true;
      }
    }
    return false;
  }

  // ---- 浮框骨架（配色与结构对齐 IDE 系统风格）----
  var panel = document.createElement("div");
  panel.className = "env-edit-panel";
  var head = document.createElement("div");
  head.className = "env-edit-head";
  head.innerHTML =
    '<span class="title"><i class="bi bi-sliders"></i>可视化编辑</span>' +
    '<span class="sub">.env</span>' +
    '<span class="spacer"></span>' +
    '<button class="env-edit-refresh" title="从 .env 文本重新读取"><i class="bi bi-arrow-clockwise"></i></button>' +
    '<button class="env-edit-collapse" title="收起为悬浮按钮"><i class="bi bi-chevron-right"></i></button>';
  var body = document.createElement("div");
  body.className = "env-edit-body scroll-thin";
  var foot = document.createElement("div");
  foot.className = "env-edit-foot";
  foot.innerHTML =
    '<button class="env-edit-add"><i class="bi bi-plus-lg"></i>添加字段</button>' +
    '<span class="env-edit-tip">新增项追加到文件末尾</span>';
  panel.appendChild(head);
  panel.appendChild(body);
  panel.appendChild(foot);
  tab.host.appendChild(panel);

  var openBtn = document.createElement("button");
  openBtn.className = "env-edit-open";
  openBtn.title = "可视化编辑 .env";
  openBtn.innerHTML = '<i class="bi bi-sliders"></i>可视化编辑';
  openBtn.style.display = "none";
  tab.host.appendChild(openBtn);

  function collapse() { panel.classList.add("hidden"); openBtn.style.display = ""; }
  function expand() { panel.classList.remove("hidden"); openBtn.style.display = "none"; }
  head.querySelector(".env-edit-collapse").addEventListener("click", collapse);
  openBtn.addEventListener("click", expand);

  // ---- 写回：按 key 定位行，只替换 “=” 右侧的值，其余原样保留 ----
  var suppress = false;   // 浮框自身写入时，忽略由此触发的 change，避免自我重绘
  function writeValue(key, val) {
    var cm = tab.cm;
    if (!cm) return;
    suppress = true;
    try {
      var n = cm.lineCount();
      for (var i = 0; i < n; i++) {
        var line = cm.getLine(i);
        var m = line.match(/^(\s*(?:export\s+)?([A-Za-z_][\w.]*)\s*=)(.*)$/);
        if (m && m[2] === key) {
          cm.replaceRange(m[1] + val, { line: i, ch: 0 }, { line: i, ch: line.length });
          break;
        }
      }
    } finally { suppress = false; }
  }

  // ---- 新增字段：追加到文件末尾 ----
  function fmtVal(v) {
    if (v === "") return "";
    if (/^".*"$/.test(v) || /^'.*'$/.test(v)) return v;
    if (/[\s#]/.test(v)) return '"' + v.replace(/"/g, '\\"') + '"';   // 含空格 / # 的值自动加引号
    return v;
  }
  function appendField(key, value) {
    var cm = tab.cm;
    var last = cm.lastLine();
    var lastText = cm.getLine(last);
    suppress = true;
    try {
      cm.replaceRange((lastText ? "\n" : "") + key + "=" + value, { line: last, ch: lastText.length });
    } finally { suppress = false; }
    cm.scrollIntoView({ line: cm.lastLine(), ch: 0 });
  }

  // ---- 随机强值：密钥类字段一键生成 ----
  // 名字里带 KEY / SECRET / SALT / TOKEN / PASSWORD 的视为「密钥类」，
  // 控件旁给一个「随机强值」按钮，省得手动凑强度（如 SECRET_KEY、SECRET_SALT）。
  var STRONG_NAME_RE = /(SECRET|SALT|TOKEN|PASSWORD|PASSWD|KEY)/i;
  function needsStrongValue(key) { return STRONG_NAME_RE.test(key || ""); }

  function randomStrong(len) {
    len = len || 48;
    // 字符集 64 个：256 % 64 === 0，按低 6 位取值不会有取模偏差
    var chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    var buf = new Uint8Array(len);
    try { (window.crypto || window.msCrypto).getRandomValues(buf); }
    catch (e) { for (var i = 0; i < len; i++) buf[i] = Math.floor(Math.random() * 256); }
    var out = "";
    for (var j = 0; j < len; j++) out += chars[buf[j] & 63];
    return out;
  }

  // 可选的随机串长度（字符数）
  var RAND_LENS = [16, 24, 32, 48, 64];
  var randDismissBound = false;
  var randAnchor = null;      // 当前浮层对应的按钮（再点同一个按钮 = 收起）

  function closeRandPop() {
    var el = document.querySelector(".env-rand-pop");
    if (el) el.remove();
    randAnchor = null;
  }

  // 位数选择浮层：挂到 body 上并 fixed 定位 —— 面板自身有 overflow，
  // 内部绝对定位的浮层会被裁掉，只有脱离面板才不会被挡。
  function openRandPop(anchor, input, key) {
    randAnchor = anchor;
    var pop = document.createElement("div");
    pop.className = "env-rand-pop";
    var title = document.createElement("div");
    title.className = "env-rand-pop-title";
    title.textContent = "随机强值位数";
    pop.appendChild(title);
    RAND_LENS.forEach(function (len) {
      var item = document.createElement("button");
      item.type = "button";
      item.className = "env-rand-pop-item";
      item.textContent = len + " 位";
      item.addEventListener("click", function () {
        closeRandPop();
        input.value = randomStrong(len);
        writeValue(key, input.value);
        toast("已生成 " + len + " 位随机强值", "ok");
      });
      pop.appendChild(item);
    });
    document.body.appendChild(pop);
    // 默认贴在按钮左下方；下方或右侧放不下时自动上翻 / 左移
    var r = anchor.getBoundingClientRect();
    var left = Math.min(r.left, window.innerWidth - pop.offsetWidth - 8);
    var top = r.bottom + 6;
    if (top + pop.offsetHeight > window.innerHeight - 8) top = r.top - pop.offsetHeight - 6;
    pop.style.left = Math.max(8, left) + "px";
    pop.style.top = Math.max(8, top) + "px";
  }

  // 关闭时机：点别处 / Esc / 滚动 / 改窗口大小（全局只绑一次）
  function bindRandDismiss() {
    if (randDismissBound) return;
    randDismissBound = true;
    document.addEventListener("mousedown", function (e) {
      var t = e.target;
      if (t && t.closest && t.closest(".env-rand-pop, .env-edit-rand")) return;
      closeRandPop();
    }, true);
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeRandPop(); }, true);
    window.addEventListener("resize", closeRandPop);
    window.addEventListener("scroll", closeRandPop, true);
  }

  function makeRandBtn(input, key) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "env-edit-rand";
    btn.title = "生成随机强值（可选位数）";
    btn.innerHTML = '<i class="bi bi-shuffle"></i>';
    btn.addEventListener("mousedown", function (e) { e.preventDefault(); });
    btn.addEventListener("click", function () {
      var same = (randAnchor === btn);  // 再点同一个按钮 = 收起
      closeRandPop();
      if (same) return;
      bindRandDismiss();
      openRandPop(btn, input, key);
    });
    return btn;
  }

  // ---- 渲染：单个参数（一行一个，系统设置行样式）----
  function renderRow(it) {
    var meta = metaFor(it.key, it.value);
    var hint = meta.hint || it.comment || "";

    var row = document.createElement("div");
    row.className = "env-edit-row";
    if (hint) row.title = hint;

    var info = document.createElement("div");
    info.className = "env-edit-info";
    var name = document.createElement("span");
    name.className = "env-edit-name";
    name.textContent = meta.label;
    info.appendChild(name);
    // 名称为中文时补一行「变量名 · 说明」；名称为 keys 本身且无说明则不重复显示
    if (meta.label !== it.key || hint) {
      var metaLine = document.createElement("span");
      metaLine.className = "env-edit-meta";
      if (meta.label !== it.key) {
        var code = document.createElement("code");
        code.textContent = it.key;
        metaLine.appendChild(code);
      }
      if (hint) {
        var em = document.createElement("em");
        em.textContent = hint;
        metaLine.appendChild(em);
      }
      info.appendChild(metaLine);
    }
    row.appendChild(info);

    var ctrl = document.createElement("span");
    ctrl.className = "env-edit-ctrl";
    row.appendChild(ctrl);

    var input;
    if (meta.type === "bool") {
      var sw = document.createElement("label");
      sw.className = "env-edit-switch";
      input = document.createElement("input");
      input.type = "checkbox";
      input.checked = it.value === "true";
      var track = document.createElement("span");
      track.className = "env-edit-switch-track";
      var txt = document.createElement("span");
      txt.className = "env-edit-switch-txt";
      txt.textContent = input.checked ? "开启" : "关闭";
      sw.appendChild(input); sw.appendChild(track); sw.appendChild(txt);
      ctrl.appendChild(sw);
      input.addEventListener("change", function () {
        txt.textContent = input.checked ? "开启" : "关闭";
        writeValue(it.key, input.checked ? "true" : "false");
      });
    } else if (meta.type === "select") {
      ctrl.classList.add("grow");
      input = document.createElement("select");
      (meta.options || []).forEach(function (opt) {
        var o = document.createElement("option");
        o.value = opt[0]; o.textContent = opt[1];
        if (opt[0] === it.value) o.selected = true;
        input.appendChild(o);
      });
      if (!input.querySelector("option[selected]")) input.selectedIndex = 0;
      ctrl.appendChild(input);
      input.addEventListener("change", function () { writeValue(it.key, input.value); });
    } else if (meta.type === "password") {
      ctrl.classList.add("grow");
      var pw = document.createElement("span");
      pw.className = "env-edit-pw";
      input = document.createElement("input");
      input.type = "password";
      input.value = it.value;
      var eye = document.createElement("button");
      eye.type = "button";
      eye.className = "env-edit-eye";
      eye.title = "显示 / 隐藏";
      eye.innerHTML = '<i class="bi bi-eye"></i>';
      eye.addEventListener("mousedown", function (e) { e.preventDefault(); });
      eye.addEventListener("click", function () {
        var show = input.type === "password";
        input.type = show ? "text" : "password";
        eye.innerHTML = show ? '<i class="bi bi-eye-slash"></i>' : '<i class="bi bi-eye"></i>';
      });
      pw.appendChild(input); pw.appendChild(eye);
      if (needsStrongValue(it.key)) ctrl.appendChild(makeRandBtn(input, it.key));
      ctrl.appendChild(pw);
      input.addEventListener("input", function () { writeValue(it.key, input.value); });
    } else {
      ctrl.classList.add("grow");
      input = document.createElement("input");
      input.type = meta.type === "number" ? "number" : "text";
      if (meta.min != null) input.min = meta.min;
      if (meta.max != null) input.max = meta.max;
      input.value = it.value;
      if (needsStrongValue(it.key)) ctrl.appendChild(makeRandBtn(input, it.key));
      ctrl.appendChild(input);
      input.addEventListener("input", function () { writeValue(it.key, input.value); });
    }
    // 注意：这里不做 keydown 拦截（不 stopPropagation）——否则会把全局 Ctrl+S 保存也挡掉；
    // 浮框内 Ctrl+S 保存 / Ctrl+P 等全局快捷键与 VS Code 行为一致。

    return row;
  }

  // ---- 渲染：新增字段表单 ----
  var adding = false;
  function buildNewForm() {
    var wrap = document.createElement("div");
    wrap.className = "env-edit-new";
    var kEl = document.createElement("input");
    kEl.className = "env-edit-new-key";
    kEl.placeholder = "变量名，如 API_URL";
    kEl.spellcheck = false;
    var vEl = document.createElement("input");
    vEl.className = "env-edit-new-val";
    vEl.placeholder = "值（可留空）";
    var ok = document.createElement("button");
    ok.className = "env-edit-new-ok";
    ok.textContent = "添加";
    var no = document.createElement("button");
    no.className = "env-edit-new-no";
    no.textContent = "取消";
    wrap.appendChild(kEl); wrap.appendChild(vEl); wrap.appendChild(ok); wrap.appendChild(no);

    function submit() {
      var key = (kEl.value || "").trim();
      var val = (vEl.value || "").trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        kEl.classList.add("bad"); kEl.focus();
        toast("变量名只能用字母 / 数字 / 下划线，且不能以数字开头", "warn");
        return;
      }
      kEl.classList.remove("bad");
      if (keyExists(key)) {
        kEl.classList.add("bad"); kEl.focus();
        toast("已存在同名配置：" + key + "，请直接修改原项", "warn");
        return;
      }
      appendField(key, fmtVal(val));
      adding = false;
      render();
      body.scrollTop = body.scrollHeight;
      toast("已添加：" + key, "ok");
    }
    ok.addEventListener("click", submit);
    no.addEventListener("click", function () { adding = false; render(); });
    kEl.addEventListener("input", function () { kEl.classList.remove("bad"); });
    [kEl, vEl].forEach(function (el) {
      el.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); submit(); }
        else if (e.key === "Escape") { e.preventDefault(); adding = false; render(); }
      });
    });
    return wrap;
  }

  function render() {
    var st = body.scrollTop;      // 重建后保持滚动位置
    body.innerHTML = "";
    var groups = parse();
    var total = 0;
    groups.forEach(function (grp) {
      var g = document.createElement("div");
      g.className = "env-edit-group";
      if (grp.title) {
        var t = document.createElement("div");
        t.className = "env-edit-group-title";
        t.textContent = grp.title;
        g.appendChild(t);
      }
      grp.items.forEach(function (it) { total++; g.appendChild(renderRow(it)); });
      if (g.children.length) body.appendChild(g);
    });
    if (!total && !adding) body.innerHTML = '<div class="env-edit-empty">未检测到有效的 KEY=VALUE 配置项。</div>';
    if (adding) body.appendChild(buildNewForm());
    body.scrollTop = st;
  }

  // ---- 底部「添加字段」----
  foot.querySelector(".env-edit-add").addEventListener("click", function () {
    adding = true;
    render();
    var k = body.querySelector(".env-edit-new-key");
    if (k) k.focus();
    body.scrollTop = body.scrollHeight;
  });

  // ---- 动态同步：文本被改动（输入 / 撤销 / 外部重载）时按需重建 ----
  var syncTimer = null;
  tab.cm.on("change", function () {
    if (suppress) return;                                   // 浮框自己写入，忽略
    if (adding) return;                                     // 正在新增字段，避免清空表单
    if (panel.contains(document.activeElement)) return;     // 正在浮框内编辑，避免打断输入
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(function () { syncTimer = null; render(); }, 250);
  });

  head.querySelector(".env-edit-refresh").addEventListener("click", render);
  render();
}

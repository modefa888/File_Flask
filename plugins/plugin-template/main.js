// ============================================================================
// 插件开发模板 —— 宿主 API 全量 Demo
//
// 该插件做两件事：
//   1) 在左侧活动栏注册一个「API Demo」面板，里面每个按钮对应一个 IDE.* 能力；
//   2) 把每个 demo 同时注册成命令，可直接在命令面板（Ctrl+Shift+P）调用。
// 读完这个文件，你就掌握了 window.IDE 提供的全部宿主能力。
//
// 宿主 API（window.IDE）：
//   IDE.registerCommand(id, { title, run })       注册命令（进命令面板）
//   IDE.executeCommand(id, ...args)               执行命令
//   IDE.registerPanel({ id, title, icon, render }) 注册侧边栏面板
//   IDE.notifications.show(msg, type)             type: ok|warn|err|info
//   IDE.workspace.getRoot()                        当前浏览根目录
//   IDE.workspace.getCurrentFile()                 当前打开文件的绝对路径（无则 null）
//   IDE.workspace.openFile(path, name)             在编辑区打开文件
//   IDE.workspace.readFile(path)                   读文本文件 → Promise<string>
//   IDE.workspace.writeFile(path, content)         写文本文件 → Promise<string>
//   IDE.editors.open(spec)                         在编辑区打开自定义视图（复用文件标签机制）
//   IDE.editors.get(id)/focus(id)/close(id)/list()/closeAll(pluginId)
//   IDE.events.on(ev, fn) / emit(ev, data)         事件总线（含 viewOpened/viewClosed/...）
//   IDE.api.get(url) / post(url, body) / request   封装好的 fetch
// ============================================================================

// ---------- 小工具 ----------
function el(html) {
  const d = document.createElement("div");
  d.innerHTML = html.trim();
  return d.firstElementChild;
}
function logLine(box, txt) {
  if (!box) return;
  const line = document.createElement("div");
  line.textContent = "• " + txt;
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
}

// ---------- 各 API 的 demo ----------

// 1) registerCommand + executeCommand
// （命令在 activate 中注册；这里演示「用 executeCommand 在面板里触发它」）

// 2) notifications.show
function demoNotify(IDE, type) {
  IDE.notifications.show("这是一条 [" + type + "] 通知", type);
}

// 3) registerPanel —— 由 activate 调用，这里给出 render 内容
function demoPanelRender(panel, ctx) {
  const IDE = ctx && ctx.IDE;
  panel.innerHTML =
    '<div class="pl-pad">' +
      '<h4 style="margin:0 0 6px">宿主 API 演示面板</h4>' +
      '<p>每个按钮对应一个 IDE.* 能力；命令面板（Ctrl+Shift+P）里也能搜到它们。</p>' +
      '<div class="pl-out" id="demoEvtLog" style="max-height:160px">事件日志：（触发「事件监听」后此处更新）</div>' +
      '<div class="demo-btns" style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px"></div>' +
    '</div>';
  const btns = panel.querySelector(".demo-btns");
  const defs = [
    ["命令/executeCommand", () => IDE.executeCommand("demo.cmd.echo", { demo: true, t: Date.now() })],
    ["通知 ok",   () => demoNotify(IDE, "ok")],
    ["通知 warn", () => demoNotify(IDE, "warn")],
    ["通知 err",  () => demoNotify(IDE, "err")],
    ["通知 info", () => demoNotify(IDE, "info")],
    ["getRoot",        () => demoRoot(IDE)],
    ["当前文件",        () => demoCurrent(IDE)],
    ["打开文件",        () => demoOpen(IDE)],
    ["读取文件",        () => demoRead(IDE)],
    ["写入文件",        () => demoWrite(IDE)],
    ["编辑区视图",      () => demoEditors(IDE)],
    ["编辑区视图(禁止拆分)", () => demoEditorsNoSplit(IDE)],
    ["事件监听",        () => demoEvents(IDE)],
    ["API 请求",        () => demoApi(IDE)],
    ["HTTP 不代理",     () => demoHttp(IDE, false)],
    ["HTTP 走代理",     () => demoHttp(IDE, true)],
    ["AI 默认模型",     () => demoAi(IDE)],
    ["系统弹窗",        () => demoDialog(IDE)],
  ];
  defs.forEach(([label, fn]) => {
    const b = el('<button class="g-btn outline">' + label + "</button>");
    b.style.fontSize = "12px";
    b.onclick = fn;
    btns.appendChild(b);
  });
}

// 4) workspace.getRoot
function demoRoot(IDE) {
  const root = IDE.workspace.getRoot();
  IDE.notifications.show("当前浏览根目录：" + (root || "(空)"), "info");
  return root;
}

// 5) workspace.getCurrentFile
function demoCurrent(IDE) {
  const p = IDE.workspace.getCurrentFile();
  IDE.notifications.show(p ? "当前打开文件：" + p : "当前没有打开任何文件", p ? "ok" : "warn");
  return p;
}

// 6) workspace.openFile（先写再打开，保证路径存在）
function demoOpen(IDE) {
  const root = IDE.workspace.getRoot();
  const target = (root || "") + "/demo-plugin-sample.txt";
  IDE.workspace.writeFile(target, "这是插件写入的示例文件。\n时间：" + new Date().toLocaleString())
    .then(() => IDE.workspace.openFile(target, "demo-plugin-sample.txt"))
    .catch(e => IDE.notifications.show("打开失败：" + e.message, "err"));
}

// 7) workspace.readFile
function demoRead(IDE) {
  const p = IDE.workspace.getCurrentFile();
  if (!p) { IDE.notifications.show("请先在编辑区打开一个文件再读取", "warn"); return; }
  IDE.workspace.readFile(p)
    .then(c => IDE.notifications.show("已读取 " + p + "（" + c.length + " 字符）", "ok"))
    .catch(e => IDE.notifications.show("读取失败：" + e.message, "err"));
}

// 8) workspace.writeFile
function demoWrite(IDE) {
  const root = IDE.workspace.getRoot();
  const target = (root || "") + "/demo-plugin-output.txt";
  const content = "由插件写入。\n时间：" + new Date().toLocaleString() + "\n随机：" + Math.random().toFixed(6) + "\n";
  IDE.workspace.writeFile(target, content)
    .then(() => IDE.notifications.show("已写入：" + target, "ok"))
    .catch(e => IDE.notifications.show("写入失败：" + e.message, "err"));
}

// 9) editors.open + view 句柄（setTitle / setDirty / focus / list / close / get）
function demoEditors(IDE) {
  let n = 0;
  const view = IDE.editors.open({
    id: "demo-editors",                                   // 同 id 再次 open 只聚焦，不重复开标签；如需禁止拆分可加 noSplit:true
    title: "API Demo · 编辑区视图",
    // 省略 icon：标签默认用「插件列表里的图标」（来自 plugin.json 的 icon / 面板图标 bi-lightbulb）
    render(container, v) {
      container.innerHTML =
        '<div class="pl-pad">' +
          '<p>这就是「和打开文件一样」的插件视图：可切换标签、可 Ctrl+\\ 拆分、可点 × 关闭。</p>' +
          '<div class="demo-btns" style="display:flex;flex-wrap:wrap;gap:6px">' +
            '<button class="g-btn outline" data-a="add">标题 +1 / 脏标记</button>' +
            '<button class="g-btn outline" data-a="focus">focus()</button>' +
            '<button class="g-btn outline" data-a="list">list()</button>' +
            '<button class="g-btn outline" data-a="close">close()</button>' +
          '</div>' +
          '<div class="pl-out" data-out>当前计数：0</div>' +
        '</div>';
      const out = container.querySelector("[data-out]");
      container.querySelector('[data-a="add"]').onclick = () => {
        n++;
        v.setTitle("API Demo · 编辑区视图 (" + n + ")");   // 动态改标签标题
        v.setDirty(n % 2 === 1);                            // 切换「未保存」小圆点
        out.textContent = "当前计数：" + n;
      };
      container.querySelector('[data-a="focus"]').onclick = () => v.focus();
      container.querySelector('[data-a="list"]').onclick = () => {
        const all = IDE.editors.list();
        out.textContent = "视图列表：" + all.map(x => x.id + ":" + x.title).join(" | ");
      };
      container.querySelector('[data-a="close"]').onclick = () => v.close();
    },
    onClose() { IDE.notifications.show("demo 编辑区视图已关闭", "info"); return true; }  // 返回 false 可阻止关闭
  });
  const got = IDE.editors.get("demo-editors");               // get：取已打开的视图句柄
  IDE.notifications.show("已打开编辑区视图，句柄在册：" + (!!got), "ok");
}

// 9b) editors.open + noSplit：禁止拆分的视图（点击拆分按钮 / Ctrl+\ 会提示「该视图无法拆分」）
function demoEditorsNoSplit(IDE) {
  const view = IDE.editors.open({
    id: "demo-editors-nosplit",                              // 同 id 再次 open 只聚焦，不重复开标签
    title: "API Demo · 禁止拆分的视图",
    icon: "bi-lock",
    noSplit: true,                                           // ← 关键：禁止拆分
    render(container, v) {
      container.innerHTML =
        '<div class="pl-pad">' +
          '<p>这个视图在 <code>open</code> 时带了 <code>noSplit: true</code>：</p>' +
          '<ul style="margin:6px 0 6px 18px;line-height:1.7">' +
            '<li>同一个 id 再次 open 只聚焦，不会重复开标签；</li>' +
            '<li>点击拆分按钮 / 按 Ctrl+\\（或 Alt+\\）都会提示「该视图无法拆分」，不会把虚拟路径当文件去读。</li>' +
          '</ul>' +
          '<p style="opacity:.7">对比：上面「编辑区视图」可以正常拆分。试试点本视图的拆分按钮。</p>' +
        '</div>';
    },
    onClose() { IDE.notifications.show("禁止拆分的视图已关闭", "info"); return true; }
  });
  IDE.notifications.show("已打开「禁止拆分的视图」，试试拆分它", "ok");
}

// 10) events.on / emit
let _demoEvtOff = [];
function demoEvents(IDE) {
  if (_demoEvtOff.length) { IDE.notifications.show("事件监听已开启，打开/关闭编辑区视图即可看到", "info"); return; }
  const events = ["viewOpened", "viewClosed", "pluginActivated", "pluginDeactivated", "ready"];
  events.forEach(ev => {
    const off = IDE.events.on(ev, (data) => {
      IDE.notifications.show("事件：" + ev, "info");
      const log = document.getElementById("demoEvtLog");
      logLine(log, ev + " → " + JSON.stringify(data || {}));
    });
    _demoEvtOff.push(off);
  });
  IDE.events.emit("demoCustom", { hello: "world" });   // 也可以自己 emit 自定义事件
  IDE.notifications.show("已监听：" + events.join(", "), "ok");
}

// 11) api.get / post
function demoApi(IDE) {
  IDE.api.get("/api/plugins")
    .then(list => {
      const names = (list || []).map(p => p.name || p.id).join("、") || "（无）";
      IDE.notifications.show("已安装插件：" + names, "ok");
    })
    .catch(e => IDE.notifications.show("请求失败：" + e.message, "err"));
}

// 12) 请求外部网站：不代理（direct）/ 走代理（proxy）
// 代理地址统一在「设置 → 网络/代理」里配置，IDE.api.proxy() 会自动读取，无需每次输入。
function demoHttp(IDE, useProxy) {
  const url = "https://api.github.com/zen";   // 一个公开、无需鉴权、返回纯文本的接口
  if (useProxy && !IDE.api.getProxy()) {
    IDE.notifications.show("尚未配置代理：请在「设置 → 网络/代理」填写代理地址（如 http://127.0.0.1:7890）", "warn");
    try { window.openSettingsTab("sec-network"); } catch (e) {}   // 自动打开对应设置分区
    return;
  }
  IDE.api[useProxy ? "proxy" : "direct"](url, { method: "GET" })
    .then(d => {
      const tag = useProxy ? ("代理 " + IDE.api.getProxy()) : "直连";
      IDE.notifications.show(tag + " 成功：状态码 " + d.status + "，内容长度 " + (d.text || "").length, "ok");
      const log = document.getElementById("demoEvtLog");
      logLine(log, "[" + tag + "] " + url + " → " + d.status);
      logLine(log, "    响应前 120 字：" + (d.text || "").slice(0, 120));
    })
    .catch(e => IDE.notifications.show((useProxy ? "代理" : "直连") + "请求失败：" + e.message, "err"));
}

// 13) ai —— 使用系统设置 + 默认模型对话（IDE.ai.chat 转发到后端 /api/ai/chat，省略模型即走默认）
async function demoAi(IDE) {
  const prompt = (typeof window !== "undefined" && window.prompt)
    ? window.prompt("向 AI 提问（使用系统设置 / 默认模型）：", "用一句话解释什么是闭包。")
    : "用一句话解释什么是闭包。";
  if (prompt === null) return;
  IDE.notifications.show("正在用系统默认模型请求 AI…", "info");
  try {
    const r = await IDE.ai.chat([{ role: "user", content: prompt }], {
      onChunk: (full) => {
        const box = document.getElementById("demoEvtLog");
        if (box) box.textContent = "AI 回复：" + full;
      }
    });
    IDE.notifications.show("AI 回复完成，共 " + (r.text || "").length + " 字", "ok");
    IDE.editors.open({
      id: "demo-ai-out",
      title: "AI 回复(默认模型).md",
      noSplit: true,   // 演示：该视图禁止拆分（点击拆分按钮 / Ctrl+\ 会提示「无法拆分」）
      language: "markdown",
      content: "# 提问\n\n" + prompt + "\n\n---\n\n" + (r.text || ""),
      dirty: true
    });
  } catch (e) {
    IDE.notifications.show("AI 请求失败：" + e.message, "err");
  }
}

// 14) dialog —— 系统级自定义弹窗：自定义内容与按钮（IDE.dialog）
function demoDialog(IDE) {
  let captured = "World";
  IDE.dialog({
    title: "自定义弹窗 Demo",
    icon: "bi-sliders",
    html:
      '<div class="m-msg">这是一个<b>自定义内容</b>的弹窗（支持 HTML）：</div>' +
      '<div class="m-row"><label>请输入你的名字</label>' +
      '<input id="dlgName" placeholder="名字" value="World"></div>',
    buttons: [
      { text: "打招呼", value: "hello", primary: true },
      { text: "取消",   value: "cancel" }
    ],
    onMount: ({ q }) => {
      const inp = q("#dlgName");
      if (inp) { captured = inp.value; inp.addEventListener("input", () => { captured = inp.value; }); inp.focus(); }
    }
  }).then(val => {
    if (val === "hello") IDE.notifications.show("你好，" + captured + "！", "ok");
    else IDE.notifications.show("已取消弹窗", "info");
  });
}

return {
  activate(IDE) {
    // 3) 注册侧边栏面板（含所有 demo 按钮）
    IDE.registerPanel({
      id: "demo-panel",
      title: "API Demo",
      icon: "bi-lightbulb",
      render: demoPanelRender
    });

    // 1) 注册命令（命令面板可调用；executeCommand 在面板按钮里演示）
    IDE.registerCommand("demo.cmd.echo", {
      title: "Demo: 执行命令 (executeCommand)",
      run(a) { IDE.notifications.show("命令被调用，参数：" + JSON.stringify(a), "ok"); }
    });
    ["ok", "warn", "err", "info"].forEach(t =>
      IDE.registerCommand("demo.notify." + t, {
        title: "Demo: 通知 (" + t + ")",
        run() { demoNotify(IDE, t); }
      })
    );
    IDE.registerCommand("demo.workspace.root",    { title: "Demo: getRoot",      run: () => demoRoot(IDE) });
    IDE.registerCommand("demo.workspace.current", { title: "Demo: 当前文件",     run: () => demoCurrent(IDE) });
    IDE.registerCommand("demo.workspace.open",    { title: "Demo: 打开文件",     run: () => demoOpen(IDE) });
    IDE.registerCommand("demo.workspace.read",    { title: "Demo: 读取文件",     run: () => demoRead(IDE) });
    IDE.registerCommand("demo.workspace.write",   { title: "Demo: 写入文件",     run: () => demoWrite(IDE) });
    IDE.registerCommand("demo.editors.view",      { title: "Demo: 编辑区视图",   run: () => demoEditors(IDE) });
    IDE.registerCommand("demo.editors.nosplit",   { title: "Demo: 编辑区视图(禁止拆分)", run: () => demoEditorsNoSplit(IDE) });
    IDE.registerCommand("demo.events.listen",     { title: "Demo: 事件监听",     run: () => demoEvents(IDE) });
    IDE.registerCommand("demo.api.plugins",       { title: "Demo: API 请求",     run: () => demoApi(IDE) });
    IDE.registerCommand("demo.http.direct",        { title: "Demo: 请求外部接口(不代理)", run: () => demoHttp(IDE, false) });
    IDE.registerCommand("demo.http.proxy",         { title: "Demo: 请求外部接口(走代理)", run: () => demoHttp(IDE, true) });
    IDE.registerCommand("demo.ai.ask",             { title: "Demo: AI 调用(系统默认模型)", run: () => demoAi(IDE) });
    IDE.registerCommand("demo.dialog.show",        { title: "Demo: 系统级自定义弹窗", run: () => demoDialog(IDE) });

    // 11) 顺手演示一次 api（静默）
    IDE.api.get("/api/plugins").catch(() => {});

    IDE.notifications.show("API Demo 插件已激活，左侧活动栏有「API Demo」面板", "ok");

    return function deactivate() {
      // 清理事件监听（closeAll 由宿主在停用时自动完成）
      _demoEvtOff.forEach(off => { try { off(); } catch (e) {} });
      _demoEvtOff = [];
      IDE.editors.close("demo-editors");
    };
  }
};

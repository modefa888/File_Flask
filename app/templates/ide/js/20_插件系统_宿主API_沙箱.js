/* ============================================================================
 * 20_ 插件系统：宿主 API（window.IDE）+ 插件生命周期 + 扩展面板 UI
 *
 * 本文件被 include 在 16_ 之前，处于 00_preamble 的大 IIFE 闭包内，
 * 因此可直接访问闭包内的 openFile / toast / showPanel / panels / titles /
 * ROOT / active / QO_COMMANDS 等。挂到 window.IDE 后供插件（运行时动态
 * 加载、在全局作用域执行）通过参数注入使用。
 * ========================================================================== */
(function () {
  if (typeof window === "undefined") return;

  // ---- 注入插件相关样式（避免改动 ide.html 的 css include 列表）----
  const _plStyle = document.createElement("style");
  _plStyle.textContent = [
    ".pl-pad{padding:10px;color:var(--fg,#ddd);font-size:13px;line-height:1.6}",
    ".pl-pad p{margin:0 0 8px}",
    ".pl-out{margin-top:8px;max-height:240px;overflow:auto;white-space:pre-wrap;word-break:break-all;background:rgba(127,127,127,.12);border-radius:6px;padding:8px;font-size:12px}",
    ".pl-card{border:1px solid rgba(127,127,127,.25);border-radius:8px;padding:8px 10px;margin:8px}",
    ".pl-card .pl-row{display:flex;align-items:center;gap:6px}",
    ".pl-card .pl-ver{color:#8a8;font-size:11px}",
    ".pl-card .pl-desc{color:#aaa;font-size:12px;margin:4px 0}",
    ".pl-card .pl-author{color:#888;font-size:11px}",
    ".pl-card .pl-acts{display:flex;align-items:center;gap:10px;margin-top:6px}",
    ".pl-card .pl-sw{font-size:12px;color:#bbb;display:flex;align-items:center;gap:4px}",
    // 插件「编辑区视图」：与打开文件同款标签页容器，内容由插件自行渲染
    ".pl-view-host{height:100%;overflow:hidden}",
    ".pl-view-body{height:100%;overflow:auto;color:var(--fg,#ddd);font-size:13px}",
    ".pl-iframe-host{width:100%;height:100%;overflow:hidden}",
    ".pl-iframe{width:100%;height:100%;border:0;background:transparent;display:block}"
  ].join("");
  document.head.appendChild(_plStyle);

  const IDE = window.IDE || {};
  IDE.host = "file-flask";
  IDE.version = "1.0.0";

  // 当前正在激活 / 正在执行命令的插件 id：用于把期间创建的编辑区视图、注册的命令归属到该插件
  let _plCurrentId = "";

  // 插件图标表：插件 id → 图标 class（取自 plugin.json 的 icon，或 contributes.panels[0].icon）。
  // 插件编辑区视图未单独指定 icon/iconHtml 时，标签默认用该图标（即「插件列表里的图标」）。
  const _plIcons = new Map();
  function _plResolveIcon(meta) {
    meta = meta || {};
    let ic = meta.icon;
    if (!ic && meta.contributes && Array.isArray(meta.contributes.panels) && meta.contributes.panels[0]) {
      ic = meta.contributes.panels[0].icon;
    }
    return typeof ic === "string" ? ic : "";
  }

  // 将插件的 index.html（+ css）挂载进容器：以 iframe 加载插件静态资源，
  // 富页面可经「同源 iframe」直接访问 window.parent.IDE（可信插件模型）。
  // 插件 iframe 是独立文档，宿主全局的滚动条样式进不去，会退回系统默认样式（暗色下很突兀）。
  // 这里在 iframe 加载完成后注入一份与 IDE 一致的自定义滚动条（同源 + allow-same-origin 才可访问）。
  const _PL_SCROLLBAR_CSS =
    "html{scrollbar-width:thin;scrollbar-color:rgba(150,152,165,.55) transparent}" +
    "::-webkit-scrollbar{width:10px;height:10px}" +
    "::-webkit-scrollbar-track{background:transparent}" +
    "::-webkit-scrollbar-thumb{background:rgba(150,152,165,.5);border-radius:5px;border:2px solid transparent;background-clip:content-box}" +
    "::-webkit-scrollbar-thumb:hover{background:rgba(170,172,185,.8);border:2px solid transparent;background-clip:content-box}" +
    "::-webkit-scrollbar-thumb:active{background:rgba(190,192,205,.95);border:2px solid transparent;background-clip:content-box}" +
    "::-webkit-scrollbar-corner{background:transparent}" +
    "::-webkit-scrollbar-button{display:none;height:0;width:0}";
  // 插件 iframe 主题变量：跟随「界面主题」（html.pl-dark / html.pl-light 由宿主切换）
  const _PL_THEME_CSS =
    "html.pl-dark{--pl-fg:#c9ced6;--pl-strong:#e8eaed;--pl-dim:#8a9098;--pl-border:rgba(127,127,127,.28);--pl-card:rgba(127,127,127,.07);--pl-hover:rgba(127,127,127,.12)}" +
    "html.pl-light{--pl-fg:#30363d;--pl-strong:#1f2328;--pl-dim:#6b7078;--pl-border:rgba(0,0,0,.16);--pl-card:rgba(0,0,0,.045);--pl-hover:rgba(0,0,0,.05)}";
  function _plInjectScrollbar(f) {
    const inject = () => {
      try {
        const d = f.contentDocument;
        if (!d) return;
        if (!d.getElementById("__pl_scrollbar__")) {
          const st = d.createElement("style");
          st.id = "__pl_scrollbar__";
          st.textContent = _PL_SCROLLBAR_CSS;
          (d.head || d.documentElement).appendChild(st);
        }
        // 主题变量：插件页面用 var(--pl-fg) 等取色即可随「界面主题」变化
        if (!d.getElementById("__pl_theme__")) {
          const th = d.createElement("style");
          th.id = "__pl_theme__";
          th.textContent = _PL_THEME_CSS;
          (d.head || d.documentElement).appendChild(th);
        }
        _plSyncFrameTheme(f);
      } catch (e) { /* 非同源/被禁止访问时忽略 */ }
    };
    f.addEventListener("load", inject);
    if (f.contentDocument && f.contentDocument.readyState === "complete") inject();
  }

  // 把当前「界面主题」同步到某个插件 iframe：<html> 上挂 pl-light / pl-dark 类，
  // 配合 _PL_THEME_CSS 的变量与插件页面的 html.pl-light 样式实现主题跟随
  function _plSyncFrameTheme(f) {
    try {
      const light = (typeof ideThemeLight === "function") ? ideThemeLight() : false;
      const html = f.contentDocument && f.contentDocument.documentElement;
      if (html) {
        html.classList.toggle("pl-light", light);
        html.classList.toggle("pl-dark", !light);
      }
    } catch (e) { /* 非同源时忽略 */ }
  }
  // 主题切换（themeChanged）时同步全部插件 iframe：侧栏面板 + 编辑区视图
  function _plApplyThemeAll() {
    const list = [];
    _plPanels.forEach(h => { if (h.iframe) list.push(h.iframe); });
    _plViews.forEach(v => { if (v.iframe) list.push(v.iframe); });
    list.forEach(_plSyncFrameTheme);
  }

  function _plMountIndex(el, pid, indexFile, cssFile) {
    pid = pid || _plCurrentId || "";
    if (indexFile) {
      const host = document.createElement("div");
      host.className = "pl-iframe-host";
      const f = document.createElement("iframe");
      f.className = "pl-iframe";
      f.setAttribute("frameborder", "0");
      f.setAttribute("sandbox", "allow-scripts allow-same-origin allow-popups allow-forms");
      _plInjectScrollbar(f);
      f.src = "/api/plugins/" + encodeURIComponent(pid) + "/asset/" + String(indexFile).replace(/^\/+/, "");
      host.appendChild(f);
      el.innerHTML = "";
      el.appendChild(host);
      return f;
    }
    if (cssFile) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = "/api/plugins/" + encodeURIComponent(pid) + "/asset/" + String(cssFile).replace(/^\/+/, "");
      document.head.appendChild(link);
    }
    return null;
  }

  // ---------- 命令注册表 ----------
  const _plCommands = new Map();
  IDE.registerCommand = function (id, opts) {
    if (typeof opts === "function") opts = { run: opts };
    if (!opts || typeof opts.run !== "function") {
      console.warn("[IDE] registerCommand 需要一个 run 函数:", id); return id;
    }
    if (opts._owner == null) opts._owner = _plCurrentId;   // 记录归属插件（执行时用于视图归属）
    _plCommands.set(id, opts);
    const label = opts.title || id;
    if (typeof QO_COMMANDS !== "undefined" && Array.isArray(QO_COMMANDS)) {
      const i = QO_COMMANDS.findIndex(c => c[0] === label || (c[2] && c[2] === id));
      const entry = [label, () => IDE.executeCommand(id), id];
      if (i >= 0) QO_COMMANDS[i] = entry; else QO_COMMANDS.push(entry);
    }
    return id;
  };
  IDE.executeCommand = function (id) {
    const c = _plCommands.get(id);
    if (!c) { if (typeof toast === "function") toast("命令不存在: " + id, "warn"); return; }
    const prev = _plCurrentId; _plCurrentId = c._owner || prev;   // 命令内打开的视图归属该插件
    try { return c.run.apply(null, Array.prototype.slice.call(arguments, 1)); }
    finally { _plCurrentId = prev; }
  };

  // ---------- 面板注册 ----------
  const _plPanels = new Map();
  IDE.registerPanel = function (spec) {
    spec = spec || {};
    const id = spec.id;
    if (!id) { console.warn("[IDE] registerPanel 需要 id"); return null; }
    if (spec._owner == null) spec._owner = _plCurrentId;   // 记录归属插件（面板内打开的视图据此归属）
    if (_plPanels.has(id)) return _plPanels.get(id);
    if (typeof panels !== "undefined") panels[id] = id + "Panel";
    if (typeof titles !== "undefined") titles[id] = spec.title || id;
    // 活动栏按钮（插在「设置」按钮之前）
    const act = document.createElement("div");
    act.className = "act";
    act.dataset.panel = id;
    act.title = spec.title || id;
    act.innerHTML = '<i class="bi ' + (spec.icon || "bi-puzzle") + '"></i>';
    const settingsAct = document.getElementById("actSettings");
    if (settingsAct && settingsAct.parentNode) settingsAct.parentNode.insertBefore(act, settingsAct);
    // 活动栏图标顺序可由「设置 → 外观」自定义：新注册的图标按已保存顺序落位
    if (typeof window.applyActOrder === "function") window.applyActOrder();
    // 侧边栏面板容器
    const panel = document.createElement("div");
    panel.className = "side-panel";
    panel.id = id + "Panel";
    panel.style.display = "none";
    const sidebar = document.getElementById("sidebar");
    if (sidebar) sidebar.appendChild(panel);
    const handle = { id: id, el: panel, act: act, _owner: spec._owner || _plCurrentId, iframe: null };
    _plPanels.set(id, handle);
    const owner = spec._owner || _plCurrentId;
    if (spec.index) {
      // 以 iframe 加载插件的 index.html（+ 其相对引用的 css/图片）
      handle.iframe = _plMountIndex(panel, owner, spec.index, spec.css);
    }
    if (typeof spec.render === "function") {
      const prev = _plCurrentId; _plCurrentId = owner;   // 面板内打开的视图归属该插件
      try { spec.render(panel, { IDE: IDE, iframe: handle.iframe }); }
      catch (e) { console.error("[IDE] panel render 失败:", id, e); }
      finally { _plCurrentId = prev; }
    }
    return handle;
  };

  // ---------- 通知 ----------
  IDE.notifications = {
    show(msg, type) {
      if (typeof toast === "function") toast(msg, type);
      else console.log("[notify]", msg);
    }
  };

  // ---------- 工作区 ----------
  IDE.workspace = {
    getRoot() { return (typeof ROOT !== "undefined") ? ROOT : ""; },
    openFile(path, name) {
      if (typeof openFile === "function") return openFile(path, name);
      return Promise.reject(new Error("openFile 不可用"));
    },
    getCurrentFile() {
      if (typeof active !== "undefined" && active && active.path) return active.path;
      return null;
    },
    async readFile(path) {
      const r = await fetch("/api/plugins/fs/read", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: path })
      });
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      return d.content;
    },
    async writeFile(path, content) {
      const r = await fetch("/api/plugins/fs/write", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: path, content: content })
      });
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      return d.path;
    }
  };

  // ---------- 编辑区：插件自定义视图 ----------
  // 与「打开文件」共用同一套标签页机制：同一标签再次 open 只聚焦、可切换到其它编辑组
  // （Ctrl+\ 拆分）、可拖拽排序、可关闭、状态栏/面包屑随激活标签更新；
  // 区别仅是内容由插件通过 render(container, view) 自行渲染（类似 VS Code 的 WebviewPanel）。
  //   IDE.editors.open({ id, title, icon, iconHtml, render, group, noSplit }) → view
  //     icon/iconHtml 省略时默认用「打开该视图的插件」在插件列表中的图标；可单独指定覆盖
  //     noSplit:true 时该视图禁止拆分（点击拆分按钮 / Ctrl+\ 会提示「无法拆分」）
  //   view.setTitle(name) / setIcon(html) / setDirty(bool) / onClose(fn) / focus() / close()
  let _plViewSeq = 0;
  const _plViews = new Map();                            // 实例键 → view（同一 id 可在不同编辑组各存一个实例）
  const PL_VIEW_PREFIX = "\u0000plugin:";                // 虚拟路径（与真实文件、内部 key 均不冲突）
  const PL_DEFAULT_ICON = '<i class="bi bi-puzzle"></i>';

  // 取某 id 处于打开状态的视图实例；group 不为 null 时限定编辑组（拆分后同 id 会有多个实例）
  function _plFindView(id, group) {
    id = String(id);
    for (const v of _plViews.values()) {
      if (String(v.id) === id && tabs.indexOf(v.tab) >= 0 && (group == null || v.tab.group === group)) return v;
    }
    return null;
  }

  // 语言名 → 扩展名（IDE.editors.open 的 language 可传扩展名 md/js/py，也可传语言名 markdown/python）
  const _PL_LANG2EXT = {
    javascript: "js", typescript: "ts", python: "py", markdown: "md", gfm: "md",
    html: "html", css: "css", json: "json", xml: "xml", yaml: "yml", yml: "yml",
    shell: "sh", bash: "sh", sql: "sql", c: "c", cpp: "cpp", clike: "c", go: "go",
    rust: "rs", ruby: "rb", php: "php", lua: "lua", properties: "ini",
  };

  // 内容文档模式：把一个 CodeMirror 编辑器挂进标签页容器。
  // 与 openFile 打开真实文件同款体验：行号 / 语法高亮（异步套用）/ 脏标记 / 光标位置进状态栏 /
  // Ctrl+S 保存（走 tab.pluginSave → spec.onSave 钩子，而非 /api/files/save）。
  function _plMountDoc(tab, view) {
    const spec = view.spec;
    const text = String(spec.content);
    const readOnly = !!spec.readOnly;
    const cm = CodeMirror(tab.host, {
      value: text, mode: "text/plain",
      theme: (typeof ideThemeLight === "function" && ideThemeLight()) ? "default" : "material-darker",
      lineNumbers: true, lineWrapping: (typeof IDE_SETTINGS !== "undefined") ? !!IDE_SETTINGS.lineWrap : false,
      indentUnit: (typeof IDE_SETTINGS !== "undefined") ? IDE_SETTINGS.indent : 4,
      tabSize: (typeof IDE_SETTINGS !== "undefined") ? IDE_SETTINGS.indent : 4,
      readOnly: readOnly, matchBrackets: true, autoCloseBrackets: !readOnly,
      phrases: (typeof CM_PHRASES !== "undefined") ? CM_PHRASES : undefined,
    });
    tab.cm = cm;
    tab.original = text;
    tab.dirty = !!spec.dirty;                          // 允许插件声明初始脏标记（如 AI 生成的未保存内容）
    if (tab.dirty && tab.el) tab.el.classList.add("dirty");
    // 语言标签：状态栏右侧显示（updateStatus 优先读 langLabel）
    const langRaw = String(spec.language || (spec.filename ? String(spec.filename).split(".").pop() : "") || "").toLowerCase();
    if (langRaw) tab.langLabel = langRaw.charAt(0).toUpperCase() + langRaw.slice(1);
    // 语法高亮异步套用：与 openFile 同策略，内容先可见，模式脚本慢/失败只退化为纯文本
    const ext = _PL_LANG2EXT[langRaw] || langRaw;
    if (ext && typeof ideEnsureMode === "function") {
      ideEnsureMode(ext).then(m => {
        if (m && tab.cm === cm) { cm.setOption("mode", m); if (typeof scheduleRefresh === "function") scheduleRefresh(tab); }
      }).catch(() => {});
    }
    if (!readOnly) {
      cm.on("change", () => {
        tab.dirty = cm.getValue() !== tab.original;
        if (tab.el) tab.el.classList.toggle("dirty", tab.dirty);
        if (typeof refreshTreeDirty === "function") refreshTreeDirty();
        if (typeof active !== "undefined" && active === tab && typeof updateStatus === "function") updateStatus();
      });
      // Ctrl+S 保存通道：02_ 的 saveTab 检测到 tab.pluginSave 后改走插件自己的保存钩子
      tab.pluginSave = async function () {
        const now = cm.getValue();
        if (typeof spec.onSave === "function") {
          const r = await spec.onSave(now, view);
          if (r === false) return;                     // 钩子返回 false：保存失败/取消，保持脏标记
        }
        tab.original = now; tab.dirty = false;
        if (tab.el) tab.el.classList.remove("dirty");
        if (typeof refreshTreeDirty === "function") refreshTreeDirty();
        IDE.events.emit("viewSaved", { id: view.id, view: view, text: now });
        if (typeof toast === "function") toast("已保存：" + tab.name, "ok");
      };
    }
    cm.on("cursorActivity", () => {
      if (typeof active !== "undefined" && active === tab && typeof updateStatus === "function") updateStatus();
    });
    cm.on("focus", () => { if (typeof curGroup !== "undefined") curGroup = tab.group; });
    if (typeof scheduleRefresh === "function") scheduleRefresh(tab);
  }

  function _plOpenEditor(spec) {
    if (typeof spec === "string") spec = { title: spec };
    spec = spec || {};
    if (typeof tabs === "undefined" || typeof activate !== "function" || typeof renderTabsAll !== "function") {
      console.warn("[IDE] editors.open 不可用：编辑区尚未就绪");
      return null;
    }
    const id = String(spec.id || spec.title || ("view-" + (++_plViewSeq)));
    // 去重：指定 group 时同 id 同组、未指定 group 时同 id 任一实例已打开 → 刷新内容并聚焦（不重复开标签）
    const opened = _plFindView(id, spec.group == null ? null : spec.group);
    if (opened) {
      if (opened.body && typeof spec.render === "function") {
        try { spec.render(opened.body, opened); }
        catch (e) { console.error("[IDE] view render 失败:", id, e); }
      }
      if (spec.title) opened.setTitle(spec.title);
      if (spec.iconHtml || spec.icon) opened.setIcon(spec.iconHtml || ('<i class="bi ' + spec.icon + '"></i>'));
      activate(opened.tab);
      return opened;
    }
    // 兜底：清掉已关闭实例残留的键
    for (const k of [..._plViews.keys()]) { const v = _plViews.get(k); if (tabs.indexOf(v.tab) < 0) _plViews.delete(k); }

    const key = id + "\u0000" + (++_plViewSeq);          // 实例唯一键：同 id 拆分出的多个实例各自独立
    // 默认标签图标：未指定 icon/iconHtml 时，用打开该视图的插件在插件列表中的图标，兜底为通用拼图图标
    const _ownerIcon = (_plCurrentId && _plIcons.get(_plCurrentId)) || "";
    const _defIconHtml = _ownerIcon ? ('<i class="bi ' + _ownerIcon + '"></i>') : PL_DEFAULT_ICON;
    // 内容文档模式：spec.content 为字符串时，标签页内直接挂 CodeMirror（等同打开真实文件的体验）；
    // 未传 content 时仍是插件自绘视图（render 自定义渲染 / iframe 加载 index.html）。
    const isDoc = typeof spec.content === "string";
    const host = document.createElement("div");
    host.className = "cm-host pl-view-host";
    let body = null;
    if (!isDoc) {
      body = document.createElement("div");
      body.className = "pl-view-body";
      host.appendChild(body);
    }

    const tab = {
      path: PL_VIEW_PREFIX + key, displayPath: spec.title || id, name: spec.title || id,
      host, cm: null, original: "", dirty: false, big: false,
      group: spec.group != null ? spec.group : curGroup,
      pluginView: true, pluginViewId: id, pluginOwner: _plCurrentId || "",
      pluginDoc: isDoc, langLabel: "",
      noSplit: !!spec.noSplit,   // 插件声明禁止拆分
      iconHtml: spec.iconHtml || (spec.icon ? '<i class="bi ' + spec.icon + '"></i>' : _defIconHtml),
    };

    const view = {
      id, key, tab, host, body, spec, noSplit: !!spec.noSplit,
      setTitle(name) {
        tab.name = String(name == null ? "" : name); tab.displayPath = tab.name;
        if (tab.el) { const nm = tab.el.querySelector(".t-nm"); if (nm) nm.textContent = tab.name; }
        if (typeof active !== "undefined" && active === tab) renderBreadcrumbs(tab.name);
        return view;
      },
      setIcon(icon) {
        tab.iconHtml = icon || tab.iconHtml;
        if (tab.el) { const ic = tab.el.querySelector(".t-ic"); if (ic) ic.innerHTML = tab.iconHtml; }
        return view;
      },
      setDirty(on) {
        tab.dirty = !!on;
        if (tab.el) tab.el.classList.toggle("dirty", tab.dirty);
        refreshTreeDirty();
        return view;
      },
      focus() { activate(tab); return view; },
      onClose(fn) { view._onClose = fn; return view; },
      close() { return closeTab(tab); },
      // ---- 内容文档模式专用（isDoc 时才有意义）----
      getDocument() { return tab.cm; },                    // CodeMirror 实例（可注册快捷键/取光标等）
      getText() { return tab.cm ? tab.cm.getValue() : ""; },
      setText(text) { if (tab.cm) tab.cm.setValue(String(text == null ? "" : text)); return view; },
      isDirty() { return !!tab.dirty; },
      // 与 Ctrl+S 同一条保存通道（onSave 钩子 → 清脏标记 → viewSaved 事件）
      save() { if (typeof saveTab === "function") return saveTab(tab); return Promise.resolve(); },
    };
    // 关闭钩子（closeTab 统一调用）：插件可先清理，返回 false 可取消关闭；
    // 关闭后从注册表移除并广播 viewClosed
    tab.onBeforeClose = async function () {
      try {
        if (typeof view._onClose === "function" && (await view._onClose()) === false) return false;
      } catch (e) { console.error("[IDE] view onClose 失败:", id, e); }
      _plViews.delete(key);
      IDE.events.emit("viewClosed", { id: id });
      return true;
    };

    tabs.push(tab);
    renderTabsAll();
    _plViews.set(key, view);
    activate(tab);                                       // 与打开文件一致：创建即激活
    if (isDoc) {
      // 内容文档：挂 CodeMirror 编辑器（行号 / 高亮 / 脏标记 / Ctrl+S onSave）
      _plMountDoc(tab, view);
    } else if (spec.index) {
      // 以 iframe 加载插件的 index.html（+ css），渲染富页面视图
      view.iframe = _plMountIndex(body, _plCurrentId, spec.index, spec.css);
    } else if (typeof spec.render === "function") {
      try { spec.render(body, view); } catch (e) {
        console.error("[IDE] view render 失败:", id, e);
        body.innerHTML = '<div class="pl-pad" style="color:#c66">视图渲染失败：' + _esc(e.message || e) + "</div>";
      }
    }
    IDE.events.emit("viewOpened", { id: id, view: view });
    return view;
  }

  IDE.editors = {
    // 打开（或聚焦已打开的）插件编辑区视图
    open: _plOpenEditor,
    get(id) { return _plFindView(id, null); },
    focus(id) { const v = _plFindView(id, null); if (v) v.focus(); return v; },
    close(id) { const v = _plFindView(id, null); return v ? v.close() : Promise.resolve(false); },
    // 拆分：按插件登记过的 render 把某视图实例复制到指定编辑组（供 Ctrl+\ 使用，同 id 多实例并存）
    split(id, group) {
      const v = _plFindView(id, null);
      if (!v || v.noSplit) return null;   // 禁止拆分的视图不创建新实例（splitEditor 会给出提示）
      const spec2 = Object.assign({}, v.spec, { id: v.id, group: group, title: v.tab.name });
      if (typeof v.getText === "function" && v.spec.content != null) spec2.content = v.getText();   // 内容文档：复制当前文本
      return _plOpenEditor(spec2);
    },
    list() {
      return [..._plViews.values()].filter(v => tabs.indexOf(v.tab) >= 0).map(v => ({ id: v.id, title: v.tab.name }));
    },
    // 关闭视图：不传 pluginId 时关闭全部；传则只关该插件打开的视图
    closeAll(pluginId) {
      const list = [..._plViews.values()].filter(v => tabs.indexOf(v.tab) >= 0 &&
        (pluginId == null || v.tab.pluginOwner === String(pluginId)));
      return Promise.all(list.map(v => v.close()));
    }
  };

  // ---------- 事件总线 ----------
  const _plEvents = new Map();
  IDE.events = {
    on(ev, fn) {
      if (!_plEvents.has(ev)) _plEvents.set(ev, []);
      _plEvents.get(ev).push(fn);
      return () => { const a = _plEvents.get(ev) || []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); };
    },
    emit(ev, data) {
      (_plEvents.get(ev) || []).forEach(fn => { try { fn(data); } catch (e) { console.error(e); } });
    }
  };

  // ---------- 通用请求封装 ----------
  IDE.api = {
    async get(url) { const r = await fetch(url); return r.json(); },
    async post(url, body) {
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
      return r.json();
    },
    request: fetch,
    // 读取「设置 → 网络/代理」里配置的默认代理（留空 = 直连）
    getProxy() {
      try { return String((typeof IDE_SETTINGS !== "undefined" && IDE_SETTINGS.httpProxy) || "").trim(); }
      catch (_) { return ""; }
    },
    // 经由后端转发请求「其他网站/接口」：可指定代理（留空则服务端直连）。
    // 代理优先级：显式 proxyUrl 参数 > opts.proxy > 「设置 → 网络/代理」里配置的默认代理。
    // 返回 { success, status, headers, text }，可绕开浏览器 CORS 限制。
    async requestProxy(url, opts, proxyUrl) {
      opts = opts || {};
      // 显式传了 proxyUrl / opts.proxy（含 direct() 传的空串）→ 严格按参数来，不套用设置里的模式；
      // 否则套用「设置 → 网络/代理」里的模式、例外、超时与证书策略。
      const explicit = (proxyUrl !== undefined) || (opts.proxy !== undefined);
      const proxy = (proxyUrl !== undefined) ? proxyUrl
                  : (opts.proxy !== undefined ? opts.proxy : IDE.api.getProxy());
      const body = {
        url: url,
        method: (opts.method || "GET").toUpperCase(),
        headers: opts.headers || {},
        body: opts.body != null ? String(opts.body) : null,
        proxy: proxy || ""
      };
      if (explicit) {
        body.mode = String(proxy || "").trim() ? "manual" : "none";
      }
      if (typeof httpProxySettings === "function") {
        const cfg = httpProxySettings();
        // 网站过滤属于全局策略：无论是否显式指定代理都照常生效
        body.filterMode = cfg.filterMode; body.filterList = cfg.filterList;
        if (!explicit) {
          body.mode = cfg.mode; body.noProxy = cfg.noProxy;
          body.timeout = cfg.timeout; body.insecure = cfg.insecure;
        }
      }
      const r = await fetch("/api/plugins/http", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const d = await r.json();
      if (!d.success) throw new Error(d.error || ("HTTP " + (d.status || r.status)));
      return d;   // { status, headers, text }
    },
    // 直连：明确不走代理（忽略设置页里的默认代理）
    async direct(url, opts) { return IDE.api.requestProxy(url, opts, ""); },
    // 走代理：默认用「设置 → 网络/代理」的配置；也可显式传入 proxyUrl 覆盖（如 http://127.0.0.1:7890）
    async proxy(url, opts, proxyUrl) { return IDE.api.requestProxy(url, opts, proxyUrl); }
  };

  // ---------- 系统 AI（使用「设置」里配置的接口与默认模型）----------
  // 转发到后端的 /api/ai/plugin（SSE 流式）—— 插件宿主的独立入口，
  // 在「设置 → 系统 AI」里对应「插件宿主 AI」一行，可单独启停、单独选模型。
  IDE.ai = {
    /**
     * 使用系统设置的 AI 与默认模型对话（流式）。
     * @param {Array<{role:string,content:string}>} messages
     * @param {Object} [opts] { onChunk, onReasoning, webSearch, skills, perm }
     * @returns {Promise<{text:string, reasoning:string}>}
     */
    async chat(messages, opts) {
      opts = opts || {};
      const body = { messages: messages, source: "plugin" };   // source 保留：兼容只认它的旧后端
      if (opts.webSearch) body.web_search = true;
      if (opts.skills) body.skills = opts.skills;
      if (opts.perm) body.perm = opts.perm;
      const resp = await fetch("/api/ai/plugin", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "text/event-stream" },
        body: JSON.stringify(body)
      });
      if (!resp.ok) {
        let msg = "HTTP " + resp.status;
        try { const j = await resp.json(); if (j && j.error) msg = j.error; } catch (_) {}
        throw new Error(msg);
      }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buf = "", text = "", reasoning = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const raw = buf.slice(0, idx); buf = buf.slice(idx + 2);
          const lines = raw.split("\n").filter(l => l.indexOf("data:") === 0);
          for (const l of lines) {
            const d = l.slice(5).trim();
            if (d === "[DONE]") continue;
            let obj; try { obj = JSON.parse(d); } catch (_) { continue; }
            if (obj.error) throw new Error(String(obj.error));
            if (typeof obj.delta === "string") {
              text += obj.delta;
              if (opts.onChunk) { try { opts.onChunk(text, obj.delta); } catch (_) {} }
            }
            if (typeof obj.reasoning === "string" && obj.reasoning) {
              reasoning += obj.reasoning;
              if (opts.onReasoning) { try { opts.onReasoning(reasoning, obj.reasoning); } catch (_) {} }
            }
          }
        }
      }
      return { text, reasoning };
    },
    // 便捷封装：单轮提问，直接返回文本
    async ask(prompt, opts) {
      const r = await IDE.ai.chat([{ role: "user", content: String(prompt) }], opts);
      return r.text;
    }
  };

  // ---------- 系统级弹窗（自定义内容 + 自定义按钮）----------
  function _escHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  // opts: { title, icon?, message?, html?, buttons?[{text,value,primary,gen}], danger?, wide?,
  //        draggable?, maximizable?, resizable?,      ← 拖动 / 放大还原 / 右下角缩放
  //        dismissible?, cancelValue?, onMount?({box, el, close, q, qa}) }
  // 返回 Promise，resolve 为被点击按钮的 value（点遮罩/Esc 解析 cancelValue 或最后一个按钮 value）
  IDE.dialog = function (opts) {
    opts = opts || {};
    return new Promise((resolve) => {
      const ov = document.getElementById("modalOverlay");
      if (!ov) { resolve(opts.cancelValue != null ? opts.cancelValue : null); return; }
      const title = _escHtml(opts.title || "提示");
      const icon = opts.icon ? '<i class="bi ' + _escHtml(opts.icon) + '"></i>' : "";
      const danger = opts.danger ? " danger" : "";
      const wide = opts.wide ? " wide" : "";
      const buttons = (opts.buttons && opts.buttons.length)
        ? opts.buttons
        : [{ text: "确定", value: "ok", primary: true }];
      const foot = buttons.map(b => {
        const cls = b.primary ? "m-ok" : (b.gen ? "m-gen" : "m-cancel");
        const val = (b.value != null) ? b.value : (b.text || "ok");
        return '<button class="' + cls + '" data-val="' + _escHtml(String(val)) + '">' +
               _escHtml(b.text != null ? b.text : val) + '</button>';
      }).join("");
      const bodyHtml = opts.html
        ? opts.html
        : '<div class="m-msg">' + _escHtml(opts.message || "") + '</div>';
      ov.innerHTML =
        '<div class="ide-modal' + wide + danger + '">' +
          '<div class="m-title">' + icon + '<span>' + title + '</span></div>' +
          '<div class="m-body">' + bodyHtml + '</div>' +
          '<div class="m-foot">' + foot + '</div>' +
        '</div>';
      const box = ov.querySelector(".ide-modal");
      const tEl = ov.querySelector(".m-title");
      /* ---- 放大 / 还原（maximizable）---- */
      if (opts.maximizable) {
        const maxBtn = document.createElement("button");
        maxBtn.type = "button"; maxBtn.className = "m-tbtn m-max";
        maxBtn.title = "放大 / 还原";
        maxBtn.innerHTML = '<i class="bi bi-arrows-fullscreen"></i>';
        maxBtn.addEventListener("click", () => {
          if (box.classList.contains("maximized")) {
            box.classList.remove("maximized", "sized");
            box.style.cssText = box._prevStyle || "";   // 还原拖动/缩放前的位置与尺寸
          } else {
            box._prevStyle = box.style.cssText;
            box.classList.add("maximized", "sized");
            box.style.cssText = "";                     // 交给 .maximized 全屏样式
          }
        });
        tEl.appendChild(maxBtn);
      }
      /* ---- 标题栏拖动（draggable）---- */
      if (opts.draggable) {
        box.classList.add("draggable");
        tEl.addEventListener("mousedown", (e) => {
          if (e.target.closest(".m-tbtn") || box.classList.contains("maximized")) return;
          const r = box.getBoundingClientRect();
          box._prevStyle = box._prevStyle || box.style.cssText;
          box.classList.add("sized", "dragging");
          // 关掉 pop 动画：否则松开移除 .dragging 时 animation 会重新触发一次（表现为松手“抖动/闪一下”）
          box.style.animation = "none";
          box.style.position = "fixed"; box.style.margin = "0";
          box.style.left = r.left + "px"; box.style.top = r.top + "px";
          box.style.width = r.width + "px"; box.style.height = r.height + "px";
          box.style.maxWidth = "none";
          const sx = e.clientX - r.left, sy = e.clientY - r.top;
          let moved = false;
          const move = (ev) => {
            const w = box.offsetWidth, h = box.offsetHeight;
            box.style.left = Math.min(window.innerWidth - 60, Math.max(60 - w, ev.clientX - sx)) + "px";
            box.style.top = Math.min(window.innerHeight - 40, Math.max(0, ev.clientY - sy)) + "px";
            if (!moved && Math.abs(ev.clientX - (r.left + sx)) + Math.abs(ev.clientY - (r.top + sy)) > 3) {
              moved = true; box._plDragged = true;   // 标记发生过拖动：mouseup 落在遮罩上的 click 不应关闭弹窗
            }
          };
          const up = () => {
            box.classList.remove("dragging");
            document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up);
          };
          document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
          e.preventDefault();
        });
      }
      /* ---- 右下角缩放（resizable）---- */
      if (opts.resizable) {
        box.classList.add("resizable");
        const hnd = document.createElement("div");
        hnd.className = "m-resize"; hnd.title = "拖动调整大小";
        box.appendChild(hnd);
        hnd.addEventListener("mousedown", (e) => {
          if (box.classList.contains("maximized")) return;
          e.stopPropagation(); e.preventDefault();
          const r = box.getBoundingClientRect();
          box._prevStyle = box._prevStyle || box.style.cssText;
          box.classList.add("sized", "dragging");
          box.style.animation = "none";
          box.style.position = "fixed"; box.style.margin = "0";
          box.style.left = r.left + "px"; box.style.top = r.top + "px";
          box.style.maxWidth = "none";
          const sx = e.clientX, sy = e.clientY, w0 = r.width, h0 = r.height;
          let moved = false;
          const move = (ev) => {
            box.style.width = Math.max(320, Math.min(window.innerWidth - 24, w0 + ev.clientX - sx)) + "px";
            box.style.height = Math.max(200, Math.min(window.innerHeight - 24, h0 + ev.clientY - sy)) + "px";
            if (!moved && Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) > 3) {
              moved = true; box._plDragged = true;
            }
          };
          const up = () => {
            box.classList.remove("dragging");
            document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up);
          };
          document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
        });
      }
      ov.classList.add("show");
      let closed = false;
      const onKey = (e) => {
        if (e.key === "Escape") {
          const last = buttons[buttons.length - 1];
          close(opts.cancelValue != null ? opts.cancelValue
              : (last.value != null ? last.value : null));
        }
      };
      const close = (val) => {
        if (closed) return; closed = true;
        ov.classList.remove("show");
        ov.innerHTML = "";
        document.removeEventListener("keydown", onKey);
        resolve(val);
      };
      document.addEventListener("keydown", onKey);
      ov.querySelectorAll(".m-foot button").forEach(btn => {
        btn.addEventListener("click", () => close(btn.dataset.val));
      });
      ov.addEventListener("click", (e) => {
        // 拖动/缩放结束时鼠标常落在遮罩上：mousedown 与 mouseup 的共同祖先是 ov，
        // 会派发一次 target===ov 的 click —— 不能把它当成「点遮罩关闭」
        const wasDragged = box._plDragged;
        box._plDragged = false;
        if (e.target === ov && !wasDragged && opts.dismissible !== false) {
          close(opts.cancelValue != null ? opts.cancelValue : null);
        }
      });
      if (typeof opts.onMount === "function") {
        try {
          opts.onMount({
            box: ov.querySelector(".ide-modal"),
            el: ov.querySelector(".m-body"),
            close: (val) => close(val),
            q: (s) => ov.querySelector(s),
            qa: (s) => ov.querySelectorAll(s)
          });
        } catch (_) {}
      }
    });
  };



  // 二次确认弹窗：IDE.confirm({ title?, message?, html?, okText?, cancelText?, danger?, icon? })
  // → Promise<boolean>（点「确定」resolve true；取消 / Esc / 点遮罩 resolve false）
  IDE.confirm = function (opts) {
    opts = opts || {};
    const danger = !!opts.danger;
    return IDE.dialog({
      title: opts.title || "确认操作",
      icon: opts.icon || (danger ? "bi-exclamation-triangle" : "bi-question-circle"),
      danger: danger,
      wide: !!opts.wide,
      html: opts.html || ('<div class="m-msg">' + _escHtml(opts.message || "确定执行该操作吗？") + '</div>'),
      buttons: [
        { text: opts.okText || "确定", value: "ok", primary: !danger, gen: danger },
        { text: opts.cancelText || "取消", value: "cancel" }
      ]
    }).then(v => v === "ok");
  };

  // ---------- 状态栏自定义项 ----------
  // IDE.statusBar.set(id, { text, icon?, title?, onClick?, align?("left"|"right"), visible? })
  // 插件可往底部状态栏放自定义按钮/指示器；停用/卸载插件时自动随 _plRemovePluginUI 移除。
  const _plSbItems = new Map();
  IDE.statusBar = {
    set(id, opts) {
      id = String(id); opts = opts || {};
      let it = _plSbItems.get(id);
      if (!it) {
        const span = document.createElement("span");
        span.className = "sb-item";
        span.id = "plsb-" + id;
        const right = document.querySelector(".statusbar .sb-right");
        const anchor = document.getElementById("sbBranch");   // 左侧默认插在 Git 指示器后面
        if (opts.align === "right" && right) right.insertBefore(span, right.firstChild);
        else if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(span, anchor.nextSibling);
        else if (right && right.parentNode) right.parentNode.insertBefore(span, right);
        span.addEventListener("click", () => {
          const o = _plSbItems.get(id);
          if (o && typeof o.onClick === "function") o.onClick();
        });
        it = { span: span, onClick: null, _owner: _plCurrentId || "" };
        _plSbItems.set(id, it);
      }
      it.onClick = opts.onClick || null;
      it.span.innerHTML = (opts.icon ? '<i class="bi ' + _esc(opts.icon) + '"></i> ' : "") + _esc(opts.text != null ? opts.text : "");
      if (opts.title != null) it.span.title = opts.title;
      it.span.style.display = opts.visible === false ? "none" : "";
      return it.span;
    },
    remove(id) {
      const it = _plSbItems.get(String(id));
      if (it) { try { it.span.remove(); } catch (_) {} _plSbItems.delete(String(id)); }
    }
  };

  // 已注册命令列表（插件详情弹窗展示用；pluginId 省略时返回全部）
  IDE.getCommands = function (pluginId) {
    const out = [];
    _plCommands.forEach((c, cid) => {
      if (pluginId == null || String(c._owner) === String(pluginId)) {
        out.push({ id: cid, title: c.title || cid, owner: c._owner || "" });
      }
    });
    return out;
  };



  // ---------- 插件生命周期 ----------
  const _plInstances = new Map();
  IDE.plugins = _plInstances;

  async function _plActivate(meta) {
    if (_plInstances.has(meta.id)) return;
    _plIcons.set(meta.id, _plResolveIcon(meta));   // 记录插件图标（其视图标签的默认图标）
    const _prevOwner = _plCurrentId; _plCurrentId = meta.id;   // activate 期间创建的视图/命令归属该插件
    try {
      const code = await (await fetch("/api/plugins/" + encodeURIComponent(meta.id) + "/main.js", { cache: "no-store" })).text();
      // 受限执行：插件在全局作用域运行，但仅能拿到宿主注入的全局；
      // 直接在页面内执行（可信插件模型，与 VS Code 默认信任用户安装的扩展一致）。
      const factory = new Function(
        "IDE", "window", "document", "fetch", "console",
        "setTimeout", "setInterval", "clearInterval", code
      );
      const mod = factory(IDE, window, document, fetch, console, setTimeout, setInterval, clearInterval);
      let deactivate = null;
      if (mod && typeof mod === "object" && typeof mod.activate === "function") {
        deactivate = (await mod.activate(IDE)) || null;
      } else if (typeof mod === "function") {
        deactivate = (await mod(IDE)) || null;
      }
      _plInstances.set(meta.id, { meta: meta, deactivate: deactivate });
      IDE.events.emit("pluginActivated", meta);
    } catch (e) {
      console.error("[IDE] 插件加载失败:", meta.id, e);
      if (typeof toast === "function") toast("插件[" + (meta.name || meta.id) + "]加载失败: " + e.message, "err");
    } finally {
      _plCurrentId = _prevOwner;
    }
  }

  // 移除某插件注册的面板与命令（禁用 / 卸载 / 重装时调用，使界面即时恢复，无需刷新）
  function _plRemovePluginUI(pid) {
    pid = String(pid);
    for (const [id, h] of [..._plPanels.entries()]) {
      if (String(h._owner) !== pid) continue;
      try { if (h.act && h.act.parentNode) h.act.parentNode.removeChild(h.act); } catch (e) { console.error(e); }
      try { if (h.el && h.el.parentNode) h.el.parentNode.removeChild(h.el); } catch (e) { console.error(e); }
      _plPanels.delete(id);
      try { if (typeof panels !== "undefined") delete panels[id]; } catch (_) {}
      try { if (typeof titles !== "undefined") delete titles[id]; } catch (_) {}
      // 当前正显示被移除的面板 → 切回资源管理器，避免侧栏空白
      try {
        if (typeof localStorage !== "undefined" && localStorage.getItem("ide.session.panel") === id &&
            typeof showPanel === "function") {
          showPanel("explorer");
        }
      } catch (_) {}
    }
    for (const [cid, c] of [..._plCommands.entries()]) {
      if (String(c._owner) !== pid) continue;
      _plCommands.delete(cid);
      if (typeof QO_COMMANDS !== "undefined" && Array.isArray(QO_COMMANDS)) {
        for (let i = QO_COMMANDS.length - 1; i >= 0; i--) {
          if (QO_COMMANDS[i] && QO_COMMANDS[i][2] === cid) QO_COMMANDS.splice(i, 1);
        }
      }
    }
    // 该插件的状态栏自定义项一并移除
    for (const [sid, it] of [..._plSbItems.entries()]) {
      if (String(it._owner) !== pid) continue;
      try { it.span.remove(); } catch (_) {}
      _plSbItems.delete(sid);
    }
  }

  function _plDeactivate(id) {
    const inst = _plInstances.get(id);
    if (inst) {
      try { if (typeof inst.deactivate === "function") inst.deactivate(); } catch (e) { console.error(e); }
      _plInstances.delete(id);
    }
    // 关闭该插件打开的编辑区视图，避免禁用/卸载后残留孤儿标签
    try { IDE.editors.closeAll(id); } catch (e) { console.error(e); }
    // 移除该插件注册的面板 / 命令，使禁用、卸载能立即在界面上生效（无需刷新页面）
    try { _plRemovePluginUI(id); } catch (e) { console.error(e); }
    if (typeof window.applyActOrder === "function") window.applyActOrder();   // 图标已移除，重排剩余图标
    IDE.events.emit("pluginDeactivated", id);
    // 停用后命令/面板已移除：同步刷新欢迎页「扩展入口」
    try { if (typeof renderWelcomeExtra === "function") renderWelcomeExtra(); } catch (_) {}
  }

  IDE.activate = _plActivate;
  IDE.deactivate = _plDeactivate;
  IDE.reload = _plReload;   // 重载插件（清理旧实例 → 重新拉清单 → 重新激活），无需刷新页面

  // ---------- 启动：加载所有 enabled 插件 ----------
  IDE.start = async function () {
    try {
      const list = await IDE.api.get("/api/plugins");
      for (const p of (list || [])) {
        if (p.enabled) await _plActivate(p);
      }
      IDE.events.emit("ready", list);
    } catch (e) {
      console.error("[IDE] start 失败:", e);
    }
    // 插件面板是在运行时注册的，而会话恢复（16_ 的 sessionRestore）可能早于插件激活执行：
    // 此时「上次打开的插件面板」还没注册，showPanel 找不到目标会把所有面板隐藏 → 侧栏空白。
    // 这里在插件全部激活后，按已保存的面板名补一次恢复。
    try {
      const saved = (typeof localStorage !== "undefined") ? localStorage.getItem("ide.session.panel") : "";
      if (saved && typeof panels !== "undefined" && panels[saved] && typeof showPanel === "function") {
        showPanel(saved);
      }
    } catch (e) { console.error("[IDE] 恢复插件面板失败:", e); }
    if (typeof window.applyActOrder === "function") window.applyActOrder();   // 插件图标纳入「活动栏图标顺序」
    _plRenderPanel();
    // 主题切换 → 同步全部插件 iframe 的 pl-light / pl-dark 类（含之后新开的 iframe，注入时也会取当前主题）
    IDE.events.on("themeChanged", function () { _plApplyThemeAll(); });
    // 插件激活后命令/面板已注册：刷新欢迎页「扩展入口」（空编辑器起始页）
    try { if (typeof renderWelcomeExtra === "function") renderWelcomeExtra(); } catch (_) {}
  };

  // ---------- 扩展面板 UI ----------
  function _esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  // 插件列表始终取最新（禁用浏览器缓存，避免刚上传/切换启用状态后读到旧数据）
  function _plFetchList() {
    return fetch("/api/plugins", { cache: "no-store" }).then(r => r.json());
  }

  // 重载插件：停用（清理面板/命令/视图/状态栏项）→ 重新拉清单 → 重新激活（无需刷新页面）
  async function _plReload(id) {
    _plDeactivate(id);
    let meta = null;
    try {
      const list = await _plFetchList();
      meta = (list || []).find(p => String(p.id) === String(id)) || null;
    } catch (e) { /* 拉取失败时至少旧实例已清理 */ }
    if (meta && meta.enabled) await _plActivate(meta);
    IDE.notifications.show("已重载「" + ((meta && meta.name) || id) + "」", "ok");
    _plRenderPanel();
  }

  // 插件详情弹窗：元信息 + 贡献的面板/命令（命令可点击直接执行）
  function _plOpenDetail(p) {
    const cmds = (typeof IDE.getCommands === "function") ? IDE.getCommands(p.id) : [];
    const panels = (p.contributes && Array.isArray(p.contributes.panels)) ? p.contributes.panels : [];
    const row = (k, v) =>
      '<div style="display:flex;gap:10px;padding:2px 0;font-size:13px">' +
        '<span style="color:#888;min-width:64px;flex:none">' + k + '</span>' +
        '<span style="flex:1;word-break:break-all">' + v + '</span>' +
      '</div>';
    let html =
      '<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">' +
        '<i class="bi ' + _esc(_plResolveIcon(p) || "bi-puzzle") + '" style="font-size:28px"></i>' +
        '<div>' +
          '<div style="font-size:15px;font-weight:600">' + _esc(p.name || p.id) +
            ' <span style="color:#8a8;font-size:12px">v' + _esc(p.version || "0.0.0") + '</span></div>' +
          '<div style="color:#888;font-size:12px">' + _esc(p.id) + (p.author ? " · " + _esc(p.author) : "") + '</div>' +
        '</div>' +
      '</div>';
    if (p.description) html += '<div style="margin:6px 0 10px;line-height:1.6">' + _esc(p.description) + '</div>';
    html += row("状态", p.enabled
      ? '<span style="color:#7bd88f">已启用</span>'
      : '<span style="color:#888">已禁用</span>');
    if (p.installed_at) html += row("安装时间", _esc(_plFmtTime(p.installed_at)));
    if (p.updated_at) html += row("更新时间", _esc(_plFmtTime(p.updated_at)));
    if (panels.length) {
      html += '<div style="margin-top:10px;font-weight:600">侧边栏面板（' + panels.length + '）</div>' +
        panels.map(x =>
          '<div style="padding:2px 0;color:#aaa;font-size:13px">· ' + _esc(x.title || x.id) +
          (x.icon ? ' <i class="bi ' + _esc(x.icon) + '"></i>' : '') + '</div>').join("");
    }
    html += '<div style="margin-top:10px;font-weight:600">命令（' + cmds.length + '）</div>';
    html += cmds.length
      ? '<div style="max-height:180px;overflow:auto;margin-top:4px">' + cmds.map(c =>
          '<button class="g-btn outline" data-cmd="' + _esc(c.id) + '" title="点击执行该命令" ' +
          'style="display:block;width:100%;text-align:left;margin:3px 0;padding:3px 8px;font-size:12px">' +
          _esc(c.title) + ' <span style="color:#8a8;font-size:11px">' + _esc(c.id) + '</span></button>').join("") + '</div>'
      : '<div style="color:#888;font-size:12px">该插件未注册命令。</div>';
    IDE.dialog({
      title: "扩展详情",
      icon: "bi-puzzle",
      wide: true,
      html: html,
      buttons: [{ text: "关闭", value: "close", primary: true }],
      onMount: ({ qa, close }) => {
        qa("[data-cmd]").forEach(b => {
          b.addEventListener("click", () => { close("run"); IDE.executeCommand(b.dataset.cmd); });
        });
      }
    });
  }

  function _plRenderPanel() {
    const box = document.getElementById("extPanel");
    if (!box) return;
    _plFetchList().then(list => {
      list = list || [];
      let html =
        '<div class="ph" style="display:flex;justify-content:space-between;align-items:center;gap:8px">' +
          '<span>已安装扩展（' + list.length + '）</span>' +
          '<span style="display:flex;gap:6px">' +
            '<button class="g-btn outline" id="plHistory" style="padding:2px 8px;font-size:12px">历史</button>' +
            '<button class="g-btn outline" id="plUpload" style="padding:2px 8px;font-size:12px">上传插件(zip)</button>' +
          '</span>' +
        '</div>';
      if (list.length) {
        html += '<div style="padding:0 8px 6px">' +
          '<input id="plSearch" placeholder="搜索已安装的扩展…" ' +
          'style="width:100%;box-sizing:border-box;padding:3px 8px;font-size:12px;background:rgba(127,127,127,.1);border:1px solid rgba(127,127,127,.25);border-radius:6px;color:inherit;outline:none">' +
          '</div>';
      }
      if (!list.length) html += '<div class="ph" style="color:#888">暂无插件。把插件目录打包成 zip 上传即可。</div>';
      for (const p of list) {
        _plIcons.set(p.id, _plResolveIcon(p));   // 同步插件图标（视图标签默认图标即取自此）
        const search = ((p.name || "") + " " + p.id + " " + (p.description || "") + " " + (p.author || "")).toLowerCase();
        html +=
          '<div class="pl-card" data-id="' + _esc(p.id) + '" data-search="' + _esc(search) + '" style="cursor:pointer" title="点击查看详情">' +
            '<div class="pl-row"><i class="bi ' + _esc(_plResolveIcon(p) || "bi-puzzle") + '"></i> <b>' + _esc(p.name || p.id) + '</b> <span class="pl-ver">v' + _esc(p.version || "0.0.0") + '</span>' +
              '<span style="margin-left:auto;font-size:11px;color:' + (p.enabled ? "#7bd88f" : "#888") + '">' + (p.enabled ? "已启用" : "已禁用") + '</span></div>' +
            (p.description ? '<div class="pl-desc">' + _esc(p.description) + '</div>' : '') +
            (p.author ? '<div class="pl-author">作者：' + _esc(p.author) + '</div>' : '') +
            '<div class="pl-acts">' +
              '<label class="pl-sw"><input type="checkbox" data-act="toggle" ' + (p.enabled ? "checked" : "") + '> 启用</label>' +
              '<span style="flex:1"></span>' +
              '<button class="g-btn outline" data-act="reload" title="重新加载插件代码（无需刷新页面）" style="padding:1px 6px;font-size:11px">重载</button>' +
              '<button class="g-btn outline" data-act="uninstall" style="padding:1px 6px;font-size:11px">卸载</button>' +
            '</div>' +
          '</div>';
      }
      box.innerHTML = html;
      const up = box.querySelector("#plUpload");
      if (up) up.addEventListener("click", _plOpenUpload);
      const hi = box.querySelector("#plHistory");
      if (hi) hi.addEventListener("click", _plOpenHistory);
      // 搜索过滤：按名称 / id / 描述 / 作者实时筛选卡片
      const sInp = box.querySelector("#plSearch");
      if (sInp) sInp.addEventListener("input", () => {
        const kw = sInp.value.trim().toLowerCase();
        box.querySelectorAll(".pl-card").forEach(c => {
          c.style.display = (!kw || (c.dataset.search || "").indexOf(kw) >= 0) ? "" : "none";
        });
      });
      box.querySelectorAll(".pl-card").forEach(card => {
        const id = card.dataset.id;
        // 点卡片（按钮 / 开关除外）→ 详情弹窗
        card.addEventListener("click", (e) => {
          if (e.target.closest("button") || e.target.closest("label") || e.target.closest("input")) return;
          const meta = (list || []).find(p => String(p.id) === String(id));
          if (meta) _plOpenDetail(meta);
        });
        const tog = card.querySelector('[data-act="toggle"]');
        if (tog) tog.addEventListener("change", async (e) => {
          const on = e.target.checked;
          e.target.disabled = true;
          try {
            await IDE.api.post("/api/plugins/" + encodeURIComponent(id) + "/toggle", { enabled: on });
            if (on) {
              const list2 = await _plFetchList();
              const meta = (list2 || []).find(p => String(p.id) === String(id)) || { id: id, enabled: true };
              await _plActivate(meta);           // 立即激活，无需刷新
            } else {
              _plDeactivate(id);                 // 立即停用并移除其面板 / 命令 / 视图
            }
            IDE.notifications.show("已" + (on ? "启用" : "禁用"), "ok");
            _plRenderPanel();                    // 重绘以刷新「已启用 / 已禁用」徽标
          } catch (err) {
            e.target.checked = !on;              // 失败回滚开关状态
            IDE.notifications.show("操作失败：" + ((err && err.message) || err), "err");
          } finally {
            e.target.disabled = false;
          }
        });
        const rl = card.querySelector('[data-act="reload"]');
        if (rl) rl.addEventListener("click", async (e) => {
          e.stopPropagation();
          rl.disabled = true;
          try { await _plReload(id); } finally { rl.disabled = false; }
        });
        const un = card.querySelector('[data-act="uninstall"]');
        if (un) un.addEventListener("click", async (e) => {
          // 自定义悬浮确认框（贴着「卸载」按钮弹出），替代原生 confirm
          const ok = await uiConfirmPop(e.currentTarget, {
            title: "卸载插件",
            msg: "确定卸载「" + id + "」吗？该插件的面板、命令与已打开的视图会立即移除。",
            okText: "卸载",
            danger: true
          });
          if (!ok) return;
          const res = await IDE.api.post("/api/plugins/" + encodeURIComponent(id) + "/uninstall", {});
          if (res && res.error) { IDE.notifications.show("卸载失败：" + res.error, "err"); return; }
          _plDeactivate(id);                     // 立即停用并清理界面，无需刷新
          IDE.notifications.show("已卸载「" + id + "」", "ok");
          _plRenderPanel();
        });
      });
    }).catch(() => {
      box.innerHTML = '<div class="ph">扩展列表加载失败</div>';
    });
  }

  // ISO 时间 → 本地「YYYY-MM-DD HH:mm」
  function _plFmtTime(iso) {
    const d = new Date(iso);
    if (!iso || isNaN(d.getTime())) return String(iso || "");
    const p = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
           " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }

  // 查看「安装 / 卸载」历史（读取后端登记簿 /api/plugins/registry）
  function _plOpenHistory() {
    fetch("/api/plugins/registry", { cache: "no-store" })
      .then(r => r.json())
      .then(data => {
        const hist = ((data && data.history) || []).slice().reverse();   // 新 → 旧
        const rows = hist.map(h => {
          const install = h.action === "install";
          return '<div style="display:flex;align-items:center;gap:10px;padding:6px 2px;border-bottom:1px solid rgba(127,127,127,.16)">' +
            '<span style="color:' + (install ? "#7bd88f" : "#e57373") + ';min-width:36px;font-size:12px">' + (install ? "安装" : "卸载") + '</span>' +
            '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + _esc(h.name || h.id) +
              ' <span style="color:#8a8;font-size:11px">v' + _esc(h.version || "0.0.0") + '</span></span>' +
            '<span style="color:#888;font-size:12px;white-space:nowrap">' + _esc(_plFmtTime(h.at)) + '</span>' +
          '</div>';
        }).join("");
        IDE.dialog({
          title: "安装 / 卸载历史",
          icon: "bi-clock-history",
          wide: true,
          html: rows
            ? '<div style="max-height:56vh;overflow:auto">' + rows + '</div>' +
              '<div style="color:#888;font-size:12px;margin-top:8px">共 ' + hist.length + ' 条记录（最多保留 500 条）。</div>'
            : '<div style="color:#888;padding:10px 0">暂无安装 / 卸载历史记录。</div>',
          buttons: [{ text: "关闭", value: "close", primary: true }]
        });
      })
      .catch(() => IDE.notifications.show("读取历史失败", "err"));
  }

  function _plOpenUpload() {
    const inp = document.createElement("input");
    inp.type = "file";
    inp.accept = ".zip";
    inp.onchange = async () => {
      const f = inp.files && inp.files[0];
      if (!f) return;
      const fd = new FormData();
      fd.append("file", f);
      IDE.notifications.show("正在安装…", "info");
      try {
        const r = await fetch("/api/plugins/install", { method: "POST", body: fd });
        const d = await r.json();
        if (d.error) IDE.notifications.show("安装失败：" + d.error, "err");
        else {
          const meta = d.plugin || {};
          IDE.notifications.show("安装成功：" + (meta.name || meta.id || ""), "ok");
          _plRenderPanel();
          // 立即生效，无需刷新页面：同名插件若已在运行，先卸载旧实例，再加载新代码（main.js 不带缓存）
          if (meta.id && meta.enabled !== false) {
            _plDeactivate(meta.id);
            await _plActivate(meta);
          }
        }
      } catch (e) {
        IDE.notifications.show("安装失败：" + e.message, "err");
      }
    };
    inp.click();
  }

  // 暴露到全局
  window.IDE = IDE;

  // 自动启动（DOM 就绪后）
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => setTimeout(() => IDE.start(), 0));
  } else {
    setTimeout(() => IDE.start(), 0);
  }
})();

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

  // ---------- 编辑器 / 界面动作：把宿主各模块的内置能力开放给插件 ----------
  // 每个动作都带 typeof 守卫：对应模块脚本未加载 / 未就绪时弹通知并返回 false，不会抛错中断插件。
  IDE.actions = {
    /** 快速打开（Ctrl+P 悬浮面板）；pre 以 ">" 开头即命令面板模式 */
    quickOpen(pre) {
      if (typeof quickOpen !== "function") return _plActNo("快速打开");
      quickOpen(pre || ""); return true;
    },
    /** 命令面板（等价 quickOpen(">")） */
    commandPalette() { return IDE.actions.quickOpen(">"); },
    /** 全局内容搜索（搜索面板 · 内容模式） */
    searchInProject() {
      if (typeof openGrepSearch !== "function") return _plActNo("全局搜索");
      openGrepSearch(); return true;
    },
    /** 跳转到行 */
    gotoLine() {
      if (typeof gotoLine !== "function") return _plActNo("跳转到行");
      gotoLine(); return true;
    },
    /** 新建文件 / 新建文件夹（文件树内联重命名创建） */
    newFile() {
      if (typeof newInRoot !== "function") return _plActNo("新建文件");
      newInRoot(false); return true;
    },
    newFolder() {
      if (typeof newInRoot !== "function") return _plActNo("新建文件夹");
      newInRoot(true); return true;
    },
    /** 刷新文件树 */
    refreshTree() {
      if (typeof refreshTree !== "function") return _plActNo("刷新文件树");
      refreshTree(); return true;
    },
    /** 终端 / 底部面板：openTerminal 展开终端；toggleTerminal 开合切换 */
    openTerminal() {
      if (typeof toggleBottom !== "function") return _plActNo("终端");
      toggleBottom(true, "terminal"); return true;
    },
    toggleTerminal() {
      if (typeof toggleBottom !== "function") return _plActNo("终端");
      toggleBottom(); return true;
    },
    /** 运行当前文件（按扩展名调用本机解释器，输出到底部面板） */
    runFile() {
      if (typeof runCurrentFile !== "function") return _plActNo("运行当前文件");
      runCurrentFile(); return true;
    },
    /** 拆分编辑器：dir = "right"(默认) | "down" */
    splitEditor(dir) {
      if (typeof splitEditor !== "function") return _plActNo("拆分编辑器");
      splitEditor(null, dir === "down" ? "down" : "right"); return true;
    },
    /** 快捷键面板 */
    showShortcuts() {
      if (typeof showShortcuts !== "function") return _plActNo("快捷键面板");
      showShortcuts(); return true;
    },
    /** 打开设置页（section 可选，如 "appearance"） */
    openSettings(section) {
      if (typeof openSettingsTab !== "function") return _plActNo("设置页");
      openSettingsTab(section); return true;
    },
    /** 打开文件并定位到行/列（行/列省略时定位到 1,1） */
    async openFileAt(path, line, col) {
      if (typeof openFileAt !== "function") { _plActNo("定位打开"); return null; }
      return openFileAt(path, (typeof baseName === "function" ? baseName(path) : String(path)), line || 1, col || 1);
    },
    /** 保存当前标签（插件内容文档会走其 onSave 钩子） */
    saveActive() {
      if (typeof saveTab !== "function" || typeof active === "undefined" || !active) {
        IDE.notifications.show("没有可保存的标签", "warn"); return false;
      }
      saveTab(active); return true;
    },
    /** 最近打开的文件列表（与欢迎页「最近打开」同源：localStorage ide.recentFiles） */
    recentFiles() {
      try {
        const r = JSON.parse(localStorage.getItem("ide.recentFiles") || "[]");
        return Array.isArray(r) ? r.filter(x => x && x.path) : [];
      } catch (_) { return []; }
    },
    clearRecent() {
      try { localStorage.setItem("ide.recentFiles", "[]"); } catch (_) {}
      if (typeof renderWelcomeExtra === "function") renderWelcomeExtra();
      return true;
    },
    /** 界面主题：getTheme() → boolean(是否浅色)；setTheme(light) 切换并广播 themeChanged */
    getTheme() { return (typeof ideThemeLight === "function") ? ideThemeLight() : false; },
    setTheme(light) {
      if (typeof IDE_SETTINGS === "undefined" || typeof applyIdeSettings !== "function") {
        return _plActNo("主题切换");
      }
      IDE_SETTINGS.theme = light ? "light" : "dark";
      if (typeof saveIdeSettings === "function") saveIdeSettings();
      applyIdeSettings();       // 内部会广播 themeChanged → 插件 iframe 跟随
      return true;
    },
  };
  function _plActNo(name) {
    IDE.notifications.show("「" + name + "」依赖的编辑器模块尚未就绪", "warn");
    return false;
  }

  // ---------- 全局设置读写：与「设置」页同一份持久化存储（localStorage ide.settings） ----------
  // get(k, def) 读；set(k, v) 写并立即应用外观类设置（主题/字号/换行/缩进等）与广播 themeChanged。
  IDE.settings = {
    get(k, def) { return ideSettingGet(k, def); },
    set(k, v) {
      ideSettingSet(k, v);
      if (typeof applyIdeSettings === "function") applyIdeSettings();
      IDE.events.emit("settingChanged", { key: k, value: v });
    }
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

  // ============================================================================
  // 内置扩展：API 管理面板（总览 / 测试 / AI 开发插件）
  // 不依赖任何插件，始终可用；插件侧命令可通过 IDE.extConsole.open(tab) 转发到这里
  // ============================================================================
  const _extConsole = (function () {
    let _tab = "overview", _switch = null;

    const _esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
    const _join = (a, b) => String(a || "").replace(/\/+$/, "") + "/" + String(b || "").replace(/^\/+/, "");

    // —— API 目录（静态精选 + 运行时反射互补）——
    const _API_CATALOG = [
      ["元信息 / 管理", [
        ["IDE.host / IDE.version", "宿主标识与插件 API 版本"],
        ["IDE.plugins", "Map：已激活插件实例（id → {meta, deactivate}）"],
        ["IDE.getCommands(pluginId?)", "已注册命令列表 [{id, title, owner}]"],
        ["IDE.reload(pluginId)", "热重载插件（重新读取目录并重启）"],
      ]],
      ["面板 / 命令", [
        ["IDE.registerPanel({id,title,icon,render|index})", "注册侧边栏面板：render 自绘 或 index iframe"],
        ["IDE.registerCommand(id, {title, run})", "注册命令（面板按钮 / 命令面板均可触发）"],
        ["IDE.executeCommand(id)", "执行一条已注册命令"],
      ]],
      ["通知 / 弹窗", [
        ["IDE.notifications.show(msg, type)", "类型 ok|info|warn|err"],
        ["IDE.dialog({title,html,buttons,onMount})", "自定义 HTML 弹窗；可加 draggable/maximizable/resizable"],
        ["IDE.confirm(msg)", "二次确认 → Promise<boolean>"],
      ]],
      ["工作区 workspace", [
        ["IDE.workspace.getRoot()", "当前工作区根目录（未打开为 null）"],
        ["IDE.workspace.getCurrentFile()", "当前激活文件绝对路径"],
        ["IDE.workspace.readFile(path)", "读文件 → Promise<string>"],
        ["IDE.workspace.writeFile(path, text)", "写文件（自动建目录）→ Promise"],
        ["IDE.workspace.openFile(path)", "在编辑区打开真实文件"],
      ]],
      ["编辑区 editors", [
        ["IDE.editors.open(spec)", "三种形态：content 内容文档 / render 自绘 / index iframe；支持 onSave/onClose"],
        ["IDE.editors.get(id) / list()", "取视图句柄 / 列出全部；句柄含 setTitle/setIcon/setDirty/getText/setText/getDocument/save/close"],
        ["IDE.editors.closeAll(pluginId)", "关闭某插件的全部视图"],
      ]],
      ["动作 actions", [
        ["IDE.actions.quickOpen(pre)", "快速打开；pre 以 > 开头即命令面板"],
        ["IDE.actions.searchInProject() / gotoLine()", "全局内容搜索 / 跳转到行"],
        ["IDE.actions.newFile() / newFolder() / refreshTree()", "文件树操作"],
        ["IDE.actions.openTerminal() / toggleTerminal() / runFile()", "终端与运行当前文件"],
        ["IDE.actions.splitEditor(dir) / showShortcuts()", "拆分编辑器 / 快捷键面板"],
        ["IDE.actions.openSettings(section)", "打开设置页指定节"],
        ["IDE.actions.openFileAt(path, line, col)", "打开文件并定位到行/列"],
        ["IDE.actions.saveActive() / recentFiles() / clearRecent()", "保存 / 最近打开记录"],
        ["IDE.actions.getTheme() / setTheme(light)", "读取 / 切换界面主题（广播 themeChanged）"],
      ]],
      ["设置 / 事件 / 状态栏", [
        ["IDE.settings.get(k, def) / set(k, v)", "与「设置」页同源的持久化读写；set 会即时应用外观"],
        ["IDE.events.on(ev, fn) / emit(ev, data)", "事件总线：viewOpened/viewClosed/fileOpened/themeChanged/settingChanged…"],
        ["IDE.statusBar.set(id, {icon,text,align,onClick}) / remove(id)", "状态栏自定义项"],
      ]],
      ["请求 api", [
        ["IDE.api.get(url) / post(url, body)", "IDE 自身接口（fetch 封装）"],
        ["IDE.api.direct(url, opts)", "外部请求·服务端直连转发（绕 CORS）"],
        ["IDE.api.proxy(url, opts, proxyUrl?)", "外部请求·走代理（设置→网络/代理）"],
      ]],
      ["AI", [
        ["IDE.ai.ask(prompt)", "单轮提问 → Promise<string>"],
        ["IDE.ai.chat(messages, {onChunk,onReasoning})", "SSE 流式对话 → Promise<{text, reasoning}>"],
      ]],
    ];

    // —— 运行时反射：把 window.IDE 的实际结构扫出来 ——
    function _reflect(IDE) {
      const rows = [];
      Object.keys(IDE).sort().forEach((k) => {
        const val = IDE[k];
        try {
          if (val && typeof val === "object") {
            const ms = Object.keys(val).filter((m) => typeof val[m] === "function");
            rows.push(["IDE." + k, ms.length ? "{ " + ms.join(", ") + " }" : "{…}"]);
          } else if (typeof val === "function") rows.push(["IDE." + k + "()", "函数"]);
          else rows.push(["IDE." + k, JSON.stringify(val).slice(0, 60)]);
        } catch (e) { rows.push(["IDE." + k, "（不可序列化）"]); }
      });
      return rows;
    }

    // —— 测试用例：每条返回 Promise<detail>，失败则 reject ——
    function _tests(IDE) {
      return [
        { name: "宿主元信息", desc: "IDE.host / IDE.version / IDE.plugins",
          run: () => {
            if (!IDE.host || !IDE.version) throw new Error("host/version 缺失");
            return "host=" + IDE.host + "，api v" + IDE.version + "，已激活插件 " + (IDE.plugins ? IDE.plugins.size : 0) + " 个";
          } },
        { name: "命令注册", desc: "IDE.getCommands() 数量与归属",
          run: () => {
            const all = IDE.getCommands();
            if (!all.length) throw new Error("没有任何已注册命令");
            return all.length + " 条命令，本插件贡献 " + all.filter((c) => c.owner === "system-api").length + " 条";
          } },
        { name: "通知 / 状态栏", desc: "notifications.show + statusBar.set/remove（无残留）",
          run: () => {
            IDE.notifications.show("管理面板测试通知", "info");
            IDE.statusBar.set("extc-test", { icon: "bi-check2-circle", text: "测试中", align: "right" });
            IDE.statusBar.remove("extc-test");
            return "通知已弹出，状态栏项已挂载又移除";
          } },
        { name: "工作区读写", desc: "writeFile → readFile 比对",
          run: () => {
            if (!IDE.workspace.getRoot()) throw new Error("请先打开一个文件夹");
            const p = _join(IDE.workspace.getRoot(), ".ide-workspace-tools/api-console-test.md");
            const s = "# console-test " + Date.now();
            return IDE.workspace.writeFile(p, s).then(() => IDE.workspace.readFile(p)).then((back) => {
              if (back !== s) throw new Error("内容不一致");
              return "写入并读回 " + s.length + " 字符：" + p;
            });
          } },
        { name: "编辑区开合", desc: "editors.open(content) → get → close",
          run: () => {
            const v = IDE.editors.open({ id: "extc-tmp", title: "临时测试.md", filename: "tmp.md", language: "markdown", content: "临时视图，即将自动关闭。" });
            if (!IDE.editors.get("extc-tmp")) throw new Error("open 后 get 不到");
            if (v && v.close) v.close();
            return new Promise((res, rej) => setTimeout(() => {
              if (IDE.editors.get("extc-tmp")) rej(new Error("close 后仍存在"));
              else res("打开 → 校验 → 关闭，全部成功");
            }, 80));
          } },
        { name: "动作 / 主题", desc: "actions.recentFiles / getTheme 类型校验",
          run: () => {
            const r = IDE.actions.recentFiles(), t = IDE.actions.getTheme();
            if (!Array.isArray(r) || typeof t !== "boolean") throw new Error("返回类型异常");
            return "最近打开 " + r.length + " 条；当前主题：" + (t ? "浅色" : "深色");
          } },
        { name: "设置读写", desc: "settings.get → set → get → 还原",
          run: () => {
            const prev = IDE.settings.get("_extcProbe", null);
            IDE.settings.set("_extcProbe", "probe-" + Date.now());
            const now = IDE.settings.get("_extcProbe");
            IDE.settings.set("_extcProbe", prev);
            if (!now) throw new Error("set 后读不到");
            return "roundtrip 成功，已还原原值";
          } },
        { name: "事件总线", desc: "events.on → emit → 收到 → off",
          run: () => new Promise((res, rej) => {
            const off = IDE.events.on("extc-echo", () => { off(); res("自定义事件 extc-echo 往返成功"); });
            IDE.events.emit("extc-echo", { at: Date.now() });
            setTimeout(() => rej(new Error("300ms 内未收到事件")), 300);
          }) },
        { name: "网络 api.get", desc: "GET /api/plugins（IDE 自身接口）",
          run: () => IDE.api.get("/api/plugins").then((list) => {
            if (!Array.isArray(list)) throw new Error("返回不是数组");
            return "后端返回 " + list.length + " 个插件，其中启用 " + list.filter((p) => p.enabled).length + " 个";
          }) },
      ];
    }

    function _parseAiBlocks(md) {
      const out = { json: null, js: null };
      const re = /```(\w+)?[^\n]*\n([\s\S]*?)```/g;
      let m;
      while ((m = re.exec(md))) {
        const lang = (m[1] || "").toLowerCase(), code = m[2].trim();
        if (!out.json && (lang === "json" || /"contributes"\s*:/.test(code))) out.json = code;
        else if (!out.js && (lang === "javascript" || lang === "js" || /activate\s*\(/.test(code))) out.js = code;
      }
      return out;
    }

    function _render(box, IDE) {
      box.innerHTML =
        '<div class="extc">' +
          '<style>' +
            '.extc{height:100%;display:flex;flex-direction:column;font-size:12.5px;color:#c2c6cc}' +
            '.extc .c-top{display:flex;gap:6px;align-items:center;padding:8px 12px;border-bottom:1px solid rgba(127,127,127,.25);flex:none;flex-wrap:wrap}' +
            '.extc .c-tab{font-family:inherit;font-size:12px;padding:4px 14px;border-radius:6px;cursor:pointer;' +
              'border:1px solid rgba(127,127,127,.3);background:rgba(127,127,127,.08);color:#c2c6cc}' +
            '.extc .c-tab.on{background:#0d7ec4;border-color:#0d7ec4;color:#fff}' +
            '.extc .c-meta{margin-left:auto;color:#8a9098;font-size:11.5px}' +
            '.extc .c-body{flex:1;overflow:auto;padding:12px 16px 24px}' +
            '.extc h5{margin:14px 0 6px;font-size:12px;color:#8a9098;letter-spacing:.4px}' +
            '.extc .row{display:flex;gap:12px;padding:4px 8px;border-radius:6px;align-items:baseline}' +
            '.extc .row:hover{background:rgba(127,127,127,.12)}' +
            '.extc .row code{color:#6cb6ff;font-size:11.5px;flex:none;min-width:300px}' +
            '.extc .row span{color:#8a9098}' +
            '.extc .srch{font-family:inherit;font-size:12px;padding:4px 10px;border-radius:6px;width:220px;' +
              'border:1px solid rgba(127,127,127,.3);background:rgba(127,127,127,.08);color:#c2c6cc;outline:none}' +
            '.extc .trow{display:flex;gap:10px;align-items:flex-start;padding:7px 10px;border:1px solid rgba(127,127,127,.22);border-radius:8px;margin-bottom:6px}' +
            '.extc .badge{flex:none;font-size:10.5px;padding:2px 8px;border-radius:99px;border:1px solid rgba(127,127,127,.35);color:#8a9098;min-width:52px;text-align:center}' +
            '.extc .badge.ok{color:#3fb950;border-color:#3fb950}' +
            '.extc .badge.bad{color:#f85149;border-color:#f85149}' +
            '.extc .badge.run{color:#d29922;border-color:#d29922}' +
            '.extc .tname{font-weight:600;flex:none;min-width:96px}' +
            '.extc .tdesc{color:#8a9098;flex:1}' +
            '.extc .tdet{color:#8a9098;font-size:11.5px;flex:2}' +
            '.extc .trun,.extc .b{font-family:inherit;font-size:12px;padding:5px 14px;border-radius:6px;cursor:pointer;' +
              'border:1px solid rgba(127,127,127,.3);background:rgba(127,127,127,.08);color:#c2c6cc}' +
            '.extc .trun{font-size:11px;padding:2px 10px}' +
            '.extc .trun:hover,.extc .b:hover{background:#0d7ec4;border-color:#0d7ec4;color:#fff}' +
            '.extc .b.pri{background:#0d7ec4;border-color:#0d7ec4;color:#fff}' +
            '.extc .b:disabled{opacity:.45;cursor:default}' +
            '.extc textarea{font-family:inherit;font-size:12px;line-height:1.6;width:100%;box-sizing:border-box;min-height:88px;' +
              'resize:vertical;padding:8px 10px;border-radius:8px;border:1px solid rgba(127,127,127,.3);' +
              'background:rgba(127,127,127,.08);color:#c2c6cc;outline:none}' +
            '.extc textarea:focus{border-color:#0d7ec4}' +
            '.extc pre{white-space:pre-wrap;word-break:break-word;font-size:11.5px;line-height:1.6;padding:10px 12px;' +
              'border-radius:8px;border:1px solid rgba(127,127,127,.22);background:rgba(0,0,0,.25);max-height:260px;overflow:auto;margin:6px 0}' +
            '.extc .fhead{display:flex;gap:8px;align-items:center;margin:10px 0 0}' +
            '.extc .fhead b{color:#6cb6ff;font-size:12px}' +
            '.extc .stat{font-size:11.5px;color:#8a9098;margin:8px 0}' +
            '.extc .stat.err{color:#f85149}' +
            /* 浅色主题跟随（视图活在宿主文档里，html.theme-light 直接覆盖） */
            'html.theme-light .extc{color:#30363d}' +
            'html.theme-light .extc h5,html.theme-light .extc .row span,html.theme-light .extc .tdesc,' +
            'html.theme-light .extc .tdet,html.theme-light .extc .c-meta,html.theme-light .extc .stat{color:#6b7078}' +
            'html.theme-light .extc .row code,html.theme-light .extc .fhead b{color:#0550ae}' +
            'html.theme-light .extc .c-tab,html.theme-light .extc .b,html.theme-light .extc .trun,html.theme-light .extc .srch,' +
            'html.theme-light .extc textarea{color:#30363d;border-color:rgba(0,0,0,.16);background:rgba(0,0,0,.045)}' +
            'html.theme-light .extc .c-tab.on,html.theme-light .extc .b.pri{background:#0d7ec4;border-color:#0d7ec4;color:#fff}' +
            'html.theme-light .extc .trow,html.theme-light .extc pre{border-color:rgba(0,0,0,.14);background:rgba(0,0,0,.03)}' +
          '</style>' +
          '<div class="c-top">' +
            '<button class="c-tab" data-t="overview">API 总览</button>' +
            '<button class="c-tab" data-t="tests">API 测试</button>' +
            '<button class="c-tab" data-t="ai">AI 开发插件</button>' +
            '<button class="c-tab" data-t="docs">文档</button>' +
            '<span class="c-meta">v' + _esc(IDE.version) + '</span>' +
          '</div>' +
          '<div class="c-body">' +
            '<section data-tab="overview"></section>' +
            '<section data-tab="tests" style="display:none"></section>' +
            '<section data-tab="ai" style="display:none"></section>' +
            '<section data-tab="docs" style="display:none"></section>' +
          '</div>' +
        '</div>';

      const tabs = box.querySelectorAll(".c-tab");
      const secs = box.querySelectorAll("section[data-tab]");
      _switch = (tab) => {
        _tab = tab;
        try { IDE.settings.set("_extConsole.open", tab); } catch (e) {}   // 记住所在标签，刷新后恢复
        tabs.forEach((t) => t.classList.toggle("on", t.dataset.t === tab));
        secs.forEach((s) => { s.style.display = s.dataset.tab === tab ? "" : "none"; });
      };
      tabs.forEach((t) => t.addEventListener("click", () => _switch(t.dataset.t)));
      _renderTabOverview(secs[0], IDE);
      _renderTabTests(secs[1], IDE);
      _renderTabAi(secs[2], IDE);
      _renderTabDocs(secs[3], IDE);
      _switch(_tab || "overview");
    }

    // —— 标签一：API 总览（静态目录 + 实时反射，带搜索过滤）——
    function _renderTabOverview(sec, IDE) {
      sec.innerHTML =
        '<div style="display:flex;gap:8px;align-items:center;margin-bottom:6px">' +
          '<input class="srch" type="text" placeholder="过滤 API…（如 workspace / ai / open）">' +
          '<span style="color:#8a9098;font-size:11.5px">静态精选目录 + 运行时实时反射，悬停行查看说明</span></div><div data-list></div>';
      const list = sec.querySelector("[data-list]");
      const refl = _reflect(IDE);
      const render = (filter) => {
        const f = String(filter || "").toLowerCase();
        let out = "";
        _API_CATALOG.forEach((g) => {
          const rows = g[1].filter((it) => !f || (it[0] + " " + it[1]).toLowerCase().indexOf(f) >= 0);
          if (!rows.length) return;
          out += '<h5>' + _esc(g[0]) + '</h5>';
          rows.forEach((it) => { out += '<div class="row"><code>' + _esc(it[0]) + '</code><span>' + _esc(it[1]) + '</span></div>'; });
        });
        const rrows = refl.filter((it) => !f || (it[0] + " " + it[1]).toLowerCase().indexOf(f) >= 0);
        if (rrows.length) {
          out += '<h5>实时反射 window.IDE（' + rrows.length + ' 项）</h5>';
          rrows.forEach((it) => { out += '<div class="row"><code>' + _esc(it[0]) + '</code><span>' + _esc(it[1]) + '</span></div>'; });
        }
        list.innerHTML = out || '<div style="color:#8a9098;padding:20px 0">没有匹配的 API</div>';
      };
      render("");
      sec.querySelector(".srch").addEventListener("input", (e) => render(e.target.value));
    }

    // —— 标签二：API 测试（逐项运行 / 全部运行，带耗时与详情）——
    function _renderTabTests(sec, IDE) {
      const tests = _tests(IDE);
      const row = (t, i) =>
        '<div class="trow" data-i="' + i + '">' +
          '<span class="badge">待运行</span>' +
          '<span class="tname">' + _esc(t.name) + '</span>' +
          '<span class="tdesc">' + _esc(t.desc) + '</span>' +
          '<span class="tdet"></span>' +
          '<button class="trun">运行</button></div>';
      sec.innerHTML =
        '<div style="display:flex;gap:8px;margin-bottom:10px">' +
          '<button class="b pri" data-a="all">运行全部</button>' +
          '<button class="b" data-a="clear">清除结果</button>' +
          '<span class="stat" data-sum style="margin:0 0 0 8px"></span>' +
        '</div><div data-list>' + tests.map(row).join("") + '</div>';
      const list = sec.querySelector("[data-list]"), sum = sec.querySelector("[data-sum]");

      const runOne = (i, el) => {
        const t = tests[i], badge = el.querySelector(".badge"), det = el.querySelector(".tdet");
        badge.className = "badge run"; badge.textContent = "运行中"; det.textContent = "";
        const t0 = Date.now();
        return Promise.resolve().then(t.run).then((msg) => {
          badge.className = "badge ok"; badge.textContent = "通过";
          det.textContent = "(" + (Date.now() - t0) + "ms) " + msg;
        }).catch((e) => {
          badge.className = "badge bad"; badge.textContent = "失败";
          det.textContent = "(" + (Date.now() - t0) + "ms) " + (e.message || e);
        });
      };
      const bindRows = () => sec.querySelectorAll(".trow").forEach((el) =>
        el.querySelector(".trun").addEventListener("click", () => runOne(+el.dataset.i, el)));
      bindRows();
      sec.querySelector('[data-a="all"]').addEventListener("click", () => {
        let chain = Promise.resolve();
        sec.querySelectorAll(".trow").forEach((el) => { chain = chain.then(() => runOne(+el.dataset.i, el)); });
        chain.then(() => {
          const rows = [...sec.querySelectorAll(".trow")];
          const ok = rows.filter((r) => r.querySelector(".badge").classList.contains("ok")).length;
          sum.textContent = "完成：" + ok + "/" + rows.length + " 通过";
        });
      });
      sec.querySelector('[data-a="clear"]').addEventListener("click", () => {
        list.innerHTML = tests.map(row).join(""); sum.textContent = ""; bindRows();
      });
    }

    // —— 标签三：AI 开发插件（需求 → 流式生成 → 解析 plugin.json / main.js → 写入工作区）——
    function _renderTabAi(sec, IDE) {
      sec.innerHTML =
        '<h5 style="margin-top:0">基于已有插件二次开发（可选）</h5>' +
        '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">' +
          '<select data-pl style="font-family:inherit;font-size:12px;padding:4px 8px;border-radius:6px;max-width:340px;' +
            'border:1px solid rgba(127,127,127,.3);background:rgba(127,127,127,.08);color:inherit;outline:none">' +
            '<option value="">— 从零开始（不基于已有插件）—</option></select>' +
          '<button class="b" data-a="load" disabled>载入现有代码</button>' +
          '<button class="b" data-a="unload" style="display:none">退出二次开发</button>' +
        '</div>' +
        '<div class="stat" data-base style="margin:4px 0 0">选择已安装插件并载入其现有代码，AI 将在原有实现上按需求升级；id 保持不变，生成后一键覆盖热部署。</div>' +
        '<h5>需求描述</h5>' +
        '<textarea data-prompt>开发一个「番茄钟」插件：侧边栏面板里显示 25 分钟倒计时，可开始/暂停/重置，结束后弹通知；倒计时进行中在状态栏显示剩余时间。</textarea>' +
        '<div style="display:flex;gap:8px;margin:8px 0;flex-wrap:wrap">' +
          '<button class="b" data-a="gen">生成插件</button>' +
          '<button class="b pri" data-a="install" disabled>安装并热部署</button>' +
          '<button class="b" data-a="copy" disabled>复制 main.js</button>' +
          '<button class="b" data-a="write" disabled>写入工作区检查</button>' +
        '</div>' +
        '<div class="stat" data-stat>使用「设置 → 系统 AI」里配置的插件宿主模型；生成后可一键「安装并热部署」到插件系统（无需刷新），也可先写入工作区人工检查。</div>' +
        '<pre data-out style="display:none"></pre>' +
        '<div data-files></div>';

      const ta = sec.querySelector("[data-prompt]"), out = sec.querySelector("[data-out]"),
            stat = sec.querySelector("[data-stat]"), files = sec.querySelector("[data-files]"),
            bGen = sec.querySelector('[data-a="gen"]'), bCopy = sec.querySelector('[data-a="copy"]'),
            bWrite = sec.querySelector('[data-a="write"]'), bInstall = sec.querySelector('[data-a="install"]'),
            sel = sec.querySelector("[data-pl]"), bLoad = sec.querySelector('[data-a="load"]'),
            bUnload = sec.querySelector('[data-a="unload"]'), baseInfo = sec.querySelector("[data-base]");
      let parsed = null;
      let base = null;   // 二次开发基线：{ id, name, version, main, jsonText, js }

      // —— 已安装插件下拉列表（进入标签时刷新）——
      IDE.api.get("/api/plugins").then((list) => {
        (list || []).forEach((p) => {
          const o = document.createElement("option");
          o.value = p.id;
          o.textContent = (p.name || p.id) + "  v" + (p.version || "0.0.0") + "（" + p.id + "）" + (p.enabled ? "" : " · 已禁用");
          sel.appendChild(o);
        });
      }).catch(() => {});
      sel.addEventListener("change", () => { bLoad.disabled = !sel.value; });

      // —— 载入现有代码：plugin.json + main.js 经 asset 接口原样取回（基线 id 持久化，刷新后自动恢复）——
      function _loadBase(silent) {
        const id = sel.value;
        if (!id) return;
        bLoad.disabled = true;
        baseInfo.textContent = "正在载入 " + id + " 的现有代码…";
        fetch("/api/plugins/" + encodeURIComponent(id) + "/asset/plugin.json", { cache: "no-store" })
          .then((r) => { if (!r.ok) throw new Error("plugin.json 读取失败（" + r.status + "）"); return r.text(); })
          .then((jsonText) => {
            let meta = {};
            try { meta = JSON.parse(jsonText); } catch (e) {}
            const main = String(meta.main || "main.js");
            return fetch("/api/plugins/" + encodeURIComponent(id) + "/asset/" + main, { cache: "no-store" })
              .then((r) => { if (!r.ok) throw new Error(main + " 读取失败（" + r.status + "）"); return r.text(); })
              .then((js) => { base = { id: meta.id || id, name: meta.name || id, version: meta.version || "0.0.0", main, jsonText, js }; });
          })
          .then(() => {
            parsed = null; bCopy.disabled = true; bWrite.disabled = true; bInstall.disabled = true; files.innerHTML = "";
            if (!silent) ta.value = "在保持现有功能不回退的前提下：";
            bUnload.style.display = ""; sel.disabled = true;
            try { IDE.settings.set("_extConsole.base", base.id); } catch (e) {}
            baseInfo.textContent = "✓ 已载入「" + base.name + "」v" + base.version + "（" + base.main + " " + base.js.length + " 字符 / plugin.json " + base.jsonText.length + " 字符）。" +
              "在下方描述修改需求后点「生成插件」；id 将保持 " + base.id + " 不变，生成后可直接覆盖热部署。" + (silent ? "（刷新后自动恢复）" : "");
            if (!silent) IDE.notifications.show("已载入现有插件代码：" + base.name, "ok");
          })
          .catch((e) => {
            baseInfo.textContent = "载入失败：" + (e.message || e);
            bLoad.disabled = !sel.value;
            try { IDE.settings.set("_extConsole.base", null); } catch (e2) {}
          });
      }
      bLoad.addEventListener("click", () => _loadBase(false));

      // —— 退出二次开发：清空基线，回到从零生成 ——
      bUnload.addEventListener("click", () => {
        base = null; parsed = null; bCopy.disabled = true; bWrite.disabled = true; bInstall.disabled = true;
        files.innerHTML = ""; bUnload.style.display = "none"; sel.disabled = false; bLoad.disabled = !sel.value;
        try { IDE.settings.set("_extConsole.base", null); } catch (e) {}
        baseInfo.textContent = "已退出二次开发模式，回到从零开始生成。";
      });

      // —— 刷新恢复：上次在二次开发某插件 → 自动重新载入其代码 ——
      const _savedBase = IDE.settings.get("_extConsole.base", null);
      if (_savedBase) IDE.api.get("/api/plugins").then((list) => {
        if (!((list || []).some((p) => p.id === _savedBase))) return;   // 插件已被卸载则不恢复
        sel.value = _savedBase;
        if (sel.value === _savedBase) _loadBase(true);
      }).catch(() => {});

      // —— 组装提示词：从零生成 / 基于现有代码二次开发 ——
      function buildSpec() {
        const API_DESC =
          "可用 IDE API：registerPanel/registerCommand/executeCommand/notifications.show/dialog/confirm、" +
          "workspace(getRoot/getCurrentFile/readFile/writeFile/openFile)、editors.open({id,title,icon,render(box,v)|content|index})、" +
          "actions.*/settings.*/events.on|emit/statusBar.set|remove/api.get|direct|proxy/ai.ask|ai.chat。\n";
        const FMT =
          "1) plugin.json：字段 name、id（英文短横线）、version、title、description、icon（bootstrap-icons 名，如 bi-clock）、" +
          "contributes:{panels:[{id,title,icon}],commands:[{id,title}]}——面板/命令字段只需 id/title 级别信息，不必逐字匹配宿主 schema。\n" +
          "2) main.js：纯浏览器 JS，结尾 return { activate(IDE){ …注册面板/命令/状态栏… return function deactivate(){ 清理副作用 } } }。\n";
        const TAIL =
          "代码要完整可运行（两个代码块都必须是完整文件，不要省略未修改部分）、防御式判空、注释中文。" +
          "只输出两个代码块：```json 和 ```javascript，不要任何其他文字。\n\n";
        if (base) {
          const req = ta.value.trim() || "请审查并优化这个插件的代码质量与健壮性";
          return "你是本自研 Web IDE 的插件开发专家。下面是一个**现有插件**的完整代码，请在其基础上做二次开发（按用户需求升级修改）。\n" +
            "硬性要求：\n" +
            "- plugin.json 的 id 必须保持 \"" + base.id + "\" 不变（保存后会直接覆盖安装并热部署）；version 在现有 " + base.version + " 基础上递增。\n" +
            "- 现有功能不得回退；新增/修改按用户需求来；保留原有代码风格与中文注释。\n" +
            FMT + API_DESC + TAIL +
            "=== 现有 plugin.json ===\n" + base.jsonText + "\n\n" +
            "=== 现有 " + base.main + " ===\n" + base.js + "\n\n" +
            "用户修改需求：" + req;
        }
        const req = ta.value.trim() || "自由发挥一个实用小插件";
        return "你是本自研 Web IDE 的插件开发专家。请根据用户需求编写一个完整插件，目录含两个文件：\n" +
          FMT + API_DESC + TAIL + "用户需求：" + req;
      }

      bGen.addEventListener("click", () => {
        parsed = null; bCopy.disabled = true; bWrite.disabled = true; bInstall.disabled = true;
        files.innerHTML = "";
        out.style.display = ""; out.textContent = "";
        stat.className = "stat"; stat.textContent = "AI 生成中（流式）…" + (base ? "（二次开发基线：" + base.id + " v" + base.version + "）" : "");
        bGen.disabled = true;
        const t0 = Date.now();
        IDE.ai.chat([{ role: "user", content: buildSpec() }], {
          onChunk: (full) => { out.textContent = full; out.scrollTop = out.scrollHeight; }
        }).then((r) => {
          parsed = _parseAiBlocks(r.text || "");
          stat.textContent = "生成完成，共 " + (r.text || "").length + " 字，耗时 " + ((Date.now() - t0) / 1000).toFixed(1) + "s";
          _showFiles();
        }).catch((e) => {
          stat.className = "stat err";
          stat.textContent = "生成失败：" + (e.message || e) + "（请检查 设置 → 系统 AI 是否已配置可用）";
        }).finally(() => { bGen.disabled = false; });
      });

      const _showFiles = () => {
        let html = "";
        [["plugin.json", parsed.json], ["main.js", parsed.js]].forEach((p) => {
          html += '<div class="fhead"><b>' + p[0] + '</b>' + (p[1] ? "（" + p[1].length + " 字符）" : "（AI 未输出该块）") + '</div>';
          if (p[1]) html += '<pre>' + _esc(p[1]) + '</pre>';
        });
        files.innerHTML = html;
        bCopy.disabled = !parsed.js;
        bWrite.disabled = !(parsed.json && parsed.js);
        bInstall.disabled = !(parsed.json && parsed.js);
      };
      bCopy.addEventListener("click", () => {
        if (!parsed || !parsed.js) return;
        navigator.clipboard.writeText(parsed.js).then(() => IDE.notifications.show("main.js 已复制到剪贴板", "ok"));
      });
      bWrite.addEventListener("click", () => {
        const root = IDE.workspace.getRoot();
        if (!root) { IDE.notifications.show("请先打开一个文件夹（工作区）", "warn"); return; }
        if (!parsed || !parsed.json || !parsed.js) return;
        const dir = _join(root, ".ide-workspace-tools/ai-plugin-" + Date.now());
        Promise.all([
          IDE.workspace.writeFile(_join(dir, "plugin.json"), parsed.json + "\n"),
          IDE.workspace.writeFile(_join(dir, "main.js"), parsed.js + "\n")
        ]).then(() => {
          IDE.notifications.show("已写入 " + dir.split("/").pop() + "/，可在文件树查看", "ok");
          return IDE.workspace.openFile(_join(dir, "main.js"));
        }).catch((e) => IDE.notifications.show("写入失败：" + (e.message || e), "err"));
      });

      // —— 一键安装 + 热部署：JSON 直装接口写入插件目录 → 停用旧实例 → 立即激活新代码（无需刷新） ——
      bInstall.addEventListener("click", () => {
        if (!parsed || !parsed.json || !parsed.js) return;
        stat.className = "stat";
        stat.textContent = "正在安装（写入插件目录）…";
        bInstall.disabled = true;
        IDE.api.post("/api/plugins/install-files", {
          files: { "plugin.json": parsed.json, "main.js": parsed.js }
        }).then((res) => {
          if (res && res.error) throw new Error(res.error);
          const meta = (res && res.plugin) || {};
          stat.textContent = "已写入插件目录：" + (meta.id || "?") + "，正在热部署…";
          try { _plDeactivate(meta.id); } catch (e) {}          // 同 id 已在跑则先停用旧实例
          return Promise.resolve(_plActivate(meta)).then(() => { // 立即加载新 main.js（不缓存）
            stat.textContent = "✓ 插件「" + (meta.name || meta.id) + "」已安装并激活（热部署完成，扩展列表已刷新）。";
            try { _plRenderPanel(); } catch (e) {}
            IDE.notifications.show("插件已安装并热部署：" + (meta.name || meta.id), "ok");
          });
        }).catch((e) => {
          stat.className = "stat err";
          stat.textContent = "安装失败：" + (e.message || e);
        }).finally(() => { if (parsed && parsed.json && parsed.js) bInstall.disabled = false; });
      });
    }

    // —— 标签四：文档（内置渲染 docs/window.IDE宿主API使用文档.md：轻量 md 渲染 + 目录跳转）——
    function _renderTabDocs(sec, IDE) {
      sec.innerHTML =
        '<style>' +
          '.docmd{max-width:980px;line-height:1.7;font-size:13px}' +
          '.docmd h2{margin:18px 0 8px;font-size:19px;border-bottom:1px solid rgba(127,127,127,.3);padding-bottom:6px}' +
          '.docmd h3{margin:16px 0 6px;font-size:16px;color:#6cb6ff}' +
          '.docmd h4{margin:14px 0 6px;font-size:14px;color:#9fb6cc}' +
          '.docmd h5{margin:12px 0 6px;font-size:13px}' +
          '.docmd p{margin:6px 0}' +
          '.docmd code{background:rgba(127,127,127,.16);border-radius:4px;padding:1px 5px;font-size:12px;color:#6cb6ff;word-break:break-word}' +
          '.docmd pre{background:rgba(0,0,0,.3);border:1px solid rgba(127,127,127,.22);border-radius:8px;padding:10px 12px;overflow:auto;' +
            'font-size:12px;line-height:1.6;white-space:pre;max-height:420px;margin:8px 0}' +
          '.docmd pre code{background:none;padding:0;color:#c2c6cc}' +
          '.docmd blockquote{margin:8px 0;padding:2px 12px;border-left:3px solid rgba(127,127,127,.4);color:#8a9098}' +
          '.docmd blockquote p{margin:4px 0}' +
          '.docmd table{border-collapse:collapse;margin:8px 0;font-size:12.5px;max-width:100%}' +
          '.docmd th,.docmd td{border:1px solid rgba(127,127,127,.3);padding:4px 10px;text-align:left;vertical-align:top}' +
          '.docmd th{background:rgba(127,127,127,.12)}' +
          '.docmd hr{border:none;border-top:1px solid rgba(127,127,127,.25);margin:14px 0}' +
          '.docmd ul,.docmd ol{margin:6px 0;padding-left:22px}' +
          '.docmd a{color:#6cb6ff}' +
          '.extc .toc{font-family:inherit;font-size:11.5px;padding:2px 10px;border-radius:99px;cursor:pointer;' +
            'border:1px solid rgba(127,127,127,.3);background:rgba(127,127,127,.08);color:#c2c6cc}' +
          '.extc .toc.sub{opacity:.72;font-size:11px}' +
          '.extc .toc:hover{background:#0d7ec4;border-color:#0d7ec4;color:#fff}' +
          /* 浅色主题跟随 */
          'html.theme-light .docmd{color:#30363d}' +
          'html.theme-light .docmd h3,html.theme-light .docmd h4{color:#0550ae}' +
          'html.theme-light .docmd code,html.theme-light .docmd a{color:#0550ae}' +
          'html.theme-light .docmd code{background:rgba(0,0,0,.06)}' +
          'html.theme-light .docmd pre{background:rgba(0,0,0,.04);border-color:rgba(0,0,0,.14)}' +
          'html.theme-light .docmd pre code{color:#30363d}' +
          'html.theme-light .docmd blockquote{color:#6b7078}' +
          'html.theme-light .docmd th,html.theme-light .docmd td{border-color:rgba(0,0,0,.18)}' +
          'html.theme-light .extc .toc{color:#30363d;border-color:rgba(0,0,0,.16);background:rgba(0,0,0,.045)}' +
        '</style>' +
        '<div style="display:flex;gap:8px;align-items:center;margin-bottom:4px;flex-wrap:wrap">' +
          '<button class="b" data-a="reload">刷新</button>' +
          '<button class="b" data-a="open">在编辑器打开</button>' +
          '<span class="stat" data-meta style="margin:0"></span>' +
        '</div>' +
        '<div data-toc style="display:flex;gap:6px;flex-wrap:wrap;margin:4px 0 12px"></div>' +
        '<div class="docmd" data-doc><div style="color:#8a9098">加载中…</div></div>';

      const doc = sec.querySelector("[data-doc]"), toc = sec.querySelector("[data-toc]"),
            meta = sec.querySelector("[data-meta]"), bReload = sec.querySelector('[data-a="reload"]'),
            bOpen = sec.querySelector('[data-a="open"]');
      const DOC_REL = "docs/window.IDE宿主API使用文档.md";

      // —— 轻量 Markdown 渲染：标题/表格/代码块/行内代码/列表/引用/链接/粗体/水平线 ——
      function md(src) {
        const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        const blocks = [];
        src = src.replace(/```(\w*)[^\n]*\n?([\s\S]*?)```/g, (m, lang, code) => {
          blocks.push('<pre>' + esc(code.replace(/^> ?/gm, "").replace(/\n+$/, "")) + '</pre>');
          return "\u0000B" + (blocks.length - 1) + "\u0000";
        });
        const inline = (s) => esc(s)
          .replace(/`([^`]+)`/g, "<code>$1</code>")
          .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
          .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
        const lines = src.split("\n");
        let out = "", para = [], list = null, quote = false, hid = 0;
        const flushP = () => { if (para.length) { out += "<p>" + para.map(inline).join("<br>") + "</p>"; para = []; } };
        const flushL = () => { if (list) { out += "<" + list.t + ">" + list.items.map((it) => "<li>" + it.map(inline).join("<br>") + "</li>").join("") + "</" + list.t + ">"; list = null; } };
        const flushAll = () => { flushP(); flushL(); if (quote) { out += "</blockquote>"; quote = false; } };
        const isRow = (l) => /^>?\s*\|.*\|\s*$/.test(l);
        for (let i = 0; i < lines.length; i++) {
          const raw = lines[i], inQ = raw.startsWith(">"), t = raw.replace(/^>\s?/, "");
          const bm = t.match(/^\u0000B(\d+)\u0000\s*$/);
          if (bm) { flushAll(); out += blocks[+bm[1]]; continue; }
          const h = t.match(/^(#{1,4})\s+(.*)$/);
          if (h) { flushAll(); out += "<h" + (h[1].length + 1) + ' id="mdh' + (++hid) + '">' + inline(h[2]) + "</h" + (h[1].length + 1) + ">"; continue; }
          if (/^\s*---+\s*$/.test(t)) { flushAll(); out += "<hr>"; continue; }
          // 表格：| … | 行 + 下一行 |---| 分隔
          if (isRow(t) && i + 1 < lines.length && /^>?\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
            flushAll();
            const aligns = lines[i + 1].replace(/^>?\s*\|/, "").replace(/\|\s*$/, "").split("|")
              .map((c) => { c = c.trim(); return c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : "left"; });
            let tbl = "<table><tr>";
            t.replace(/^\|/, "").replace(/\|\s*$/, "").split("|").forEach((c, j) =>
              { tbl += '<th' + (aligns[j] !== "left" ? ' style="text-align:' + aligns[j] + '"' : "") + ">" + inline(c.trim()) + "</th>"; });
            tbl += "</tr>"; i += 2;
            while (i < lines.length && isRow(lines[i])) {
              const r = lines[i].replace(/^>\s?/, "").trim();
              if (!isRow(r)) break;
              tbl += "<tr>";
              r.replace(/^\|/, "").replace(/\|\s*$/, "").split("|").forEach((c, j) =>
                { tbl += '<td' + (aligns[j] !== "left" ? ' style="text-align:' + aligns[j] + '"' : "") + ">" + inline(c.trim()) + "</td>"; });
              tbl += "</tr>"; i++;
            }
            out += tbl + "</table>"; i--; continue;
          }
          if (inQ) { flushP(); flushL(); if (!quote) { out += "<blockquote>"; quote = true; } out += "<p>" + inline(t) + "</p>"; continue; }
          const li = t.match(/^\s*[-*]\s+(.+)$/), ol = t.match(/^\s*\d+[.、]\s+(.+)$/);
          if (li || ol) {
            flushP(); const kind = li ? "ul" : "ol";
            if (!list || list.t !== kind) { flushL(); list = { t: kind, items: [] }; }
            list.items.push([(li || ol)[1]]); continue;
          }
          if (!t.trim()) { flushAll(); continue; }
          flushL(); para.push(t);
        }
        flushAll();
        return out;
      }

      function load() {
        const root = IDE.workspace.getRoot();
        bOpen.disabled = !root;
        if (!root) {
          doc.innerHTML = '<div style="color:#8a9098;padding:20px 0">请先打开工作区文件夹（文档位于 <code>' + DOC_REL + '</code>）。</div>';
          toc.style.display = "none"; meta.textContent = ""; return;
        }
        const p = _join(root, DOC_REL);
        toc.style.display = ""; toc.innerHTML = "";
        doc.innerHTML = '<div style="color:#8a9098">加载中…</div>';
        meta.textContent = "读取中…";
        IDE.workspace.readFile(p).then((txt) => {
          doc.innerHTML = md(txt);
          meta.textContent = txt.length + " 字 · 读取于 " + new Date().toLocaleTimeString();
          const heads = doc.querySelectorAll("h3[id], h4[id]");
          let major = 0, sub = 0;   // 目录自动编号：章节取文档自带「N.」，小节编为 N.M
          heads.forEach((h) => {
            const b = document.createElement("button");
            let label = h.textContent;
            if (h.tagName === "H4") {
              sub += 1;
              b.className = "toc sub";
              if (major) label = major + "." + sub + "  " + label;
            } else {
              const m = label.match(/^(\d+)[.、]/);
              major = m ? +m[1] : major + 1;
              sub = 0;
              b.className = "toc";
            }
            b.textContent = label;
            b.addEventListener("click", () => h.scrollIntoView({ behavior: "smooth", block: "start" }));
            toc.appendChild(b);
          });
          if (!heads.length) toc.style.display = "none";
        }).catch((e) => {
          doc.innerHTML = '<div style="color:#f85149;padding:12px 0">读取失败：' + _esc(e.message || e) +
            '<br>（请确认工作区打开的是本项目根目录 File_Flask）</div>';
          meta.textContent = ""; toc.style.display = "none";
        });
      }

      bReload.addEventListener("click", load);
      bOpen.addEventListener("click", () => {
        const root = IDE.workspace.getRoot();
        if (root) IDE.workspace.openFile(_join(root, DOC_REL), "window.IDE宿主API使用文档.md");
      });
      load();
    }

    // 对外：打开面板（可带初始标签 overview | tests | ai | docs）；已打开则聚焦并切换
    // 开启状态持久化到 IDE.settings：刷新页面后自动恢复（见下方启动恢复逻辑）
    function open(tab) {
      if (tab) _tab = tab;
      try { IDE.settings.set("_extConsole.open", _tab || "overview"); } catch (e) {}
      const ex = IDE.editors.get("builtin-console");
      if (ex) {
        if (typeof _switch === "function") _switch(_tab);
        if (ex.focus) ex.focus();
        return;
      }
      IDE.editors.open({
        id: "builtin-console",
        title: "API 管理面板",
        icon: "bi-grid-1x2",
        noSplit: true,
        render: (box) => _render(box, IDE),
        onClose: () => { _switch = null; try { IDE.settings.set("_extConsole.open", null); } catch (e) {} return true; }
      });
    }
    return { open };
  })();
  IDE.extConsole = _extConsole;   // 内置管理面板：扩展模块卡片与插件命令共用入口

  // 刷新页面后恢复面板：上次会话面板开着 → 延迟自动重开（含上次所在标签 / 二次开发基线）
  (function () {
    const saved = IDE.settings.get("_extConsole.open", null);
    if (!saved) return;
    setTimeout(() => { try { _extConsole.open(saved); } catch (e) { /* 编辑器尚未就绪时忽略 */ } }, 400);
  })();

  // 内置扩展卡片（扩展列表顶部，始终可用、不可卸载）
  function _extConsoleCard() {
    return '<div class="pl-card" data-builtin="console" data-search="api 管理面板 内置 builtin console 总览 测试 ai" style="cursor:pointer" title="内置扩展 · 点击查看说明">' +
      '<div class="pl-row"><i class="bi bi-grid-1x2"></i> <b>API 管理面板</b> <span class="pl-ver">内置</span>' +
        '<span style="margin-left:auto;font-size:11px;color:#7bd88f">始终可用</span></div>' +
      '<div class="pl-desc">系统 API 总览 / API 测试 / AI 开发插件 / 文档：浏览宿主全部接口、一键自检测试、用 AI 生成插件代码骨架、内置查看宿主 API 文档。</div>' +
      '<div class="pl-acts">' +
        '<button class="g-btn" data-btab="" style="padding:1px 10px;font-size:11px">打开面板</button>' +
        '<span style="flex:1"></span>' +
        '<button class="g-btn outline" data-btab="tests" style="padding:1px 8px;font-size:11px">API 测试</button>' +
        '<button class="g-btn outline" data-btab="ai" style="padding:1px 8px;font-size:11px">AI 开发</button>' +
        '<button class="g-btn outline" data-btab="docs" style="padding:1px 8px;font-size:11px">文档</button>' +
      '</div></div>';
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
      html += _extConsoleCard();               // 内置扩展（API 管理面板）：始终置顶展示
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
      // 内置扩展卡片按钮：打开面板（可带初始标签）
      const bcard = box.querySelector('[data-builtin="console"]');
      if (bcard) bcard.querySelectorAll("[data-btab]").forEach((b) =>
        b.addEventListener("click", (e) => { e.stopPropagation(); _extConsole.open(b.dataset.btab || undefined); }));
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
  // 每条记录标注插件代码是否已删除；代码仍在且未运行 → 可一键「重新安装热部署」
  function _plOpenHistory() {
    fetch("/api/plugins/registry", { cache: "no-store" })
      .then(r => r.json())
      .then(data => {
        const hist = ((data && data.history) || []).slice().reverse();   // 新 → 旧
        const rows = hist.map(h => {
          const install = h.action === "install";
          const exists = !!h.exists, active = _plInstances.has(h.id);
          const codeTag = exists
            ? '<span style="color:#7bd88f;font-size:11px;white-space:nowrap">代码在</span>'
            : '<span style="color:#888;font-size:11px;white-space:nowrap">代码已删除</span>';
          const act = exists && !active
            ? '<button class="g-btn outline" data-reinstall="' + _esc(h.id) + '" style="padding:1px 8px;font-size:11px;flex:none">重新安装热部署</button>'
            : (exists ? '<span style="color:#7bd88f;font-size:11px;white-space:nowrap">运行中</span>' : "");
          return '<div style="display:flex;align-items:center;gap:10px;padding:6px 2px;border-bottom:1px solid rgba(127,127,127,.16)">' +
            '<span style="color:' + (install ? "#7bd88f" : "#e57373") + ';min-width:36px;font-size:12px">' + (install ? "安装" : "卸载") + '</span>' +
            '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + _esc(h.name || h.id) +
              ' <span style="color:#8a8;font-size:11px">v' + _esc(h.version || "0.0.0") + '</span></span>' +
            codeTag + act +
            '<span style="color:#888;font-size:12px;white-space:nowrap">' + _esc(_plFmtTime(h.at)) + '</span>' +
          '</div>';
        }).join("");
        IDE.dialog({
          title: "安装 / 卸载历史",
          icon: "bi-clock-history",
          wide: true,
          html: rows
            ? '<div style="max-height:56vh;overflow:auto">' + rows + '</div>' +
              '<div style="color:#888;font-size:12px;margin-top:8px">共 ' + hist.length + ' 条记录（最多保留 500 条）。代码仍在的插件可一键重新安装并热部署，无需重新上传。</div>'
            : '<div style="color:#888;padding:10px 0">暂无安装 / 卸载历史记录。</div>',
          buttons: [{ text: "关闭", value: "close", primary: true }],
          onMount: ({ box }) => {
            box.querySelectorAll("[data-reinstall]").forEach(btn => {
              btn.addEventListener("click", () => {
                const id = btn.dataset.reinstall;
                const rec = hist.find(h => h.id === id && h.exists);
                if (!rec) return;
                btn.disabled = true; btn.textContent = "部署中…";
                _plDeactivate(id);   // 先清理旧实例（若在运行）
                Promise.resolve(_plActivate(rec.meta || { id: id })).then(() => {
                  btn.textContent = "已激活";
                  btn.outerHTML = '<span style="color:#7bd88f;font-size:11px;white-space:nowrap">运行中</span>';
                  IDE.notifications.show("已重新安装并热部署：" + ((rec.meta && rec.meta.name) || id), "ok");
                  _plRenderPanel();
                }).catch(e => {
                  btn.disabled = false; btn.textContent = "重新安装热部署";
                  IDE.notifications.show("热部署失败：" + (e.message || e), "err");
                });
              });
            });
          }
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

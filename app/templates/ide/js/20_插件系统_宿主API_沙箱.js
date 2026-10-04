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
    ".pl-view-body{height:100%;overflow:auto;color:var(--fg,#ddd);font-size:13px}"
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
    // 侧边栏面板容器
    const panel = document.createElement("div");
    panel.className = "side-panel";
    panel.id = id + "Panel";
    panel.style.display = "none";
    const sidebar = document.getElementById("sidebar");
    if (sidebar) sidebar.appendChild(panel);
    const handle = { id: id, el: panel, act: act, _owner: spec._owner || _plCurrentId };
    _plPanels.set(id, handle);
    if (typeof spec.render === "function") {
      const prev = _plCurrentId; _plCurrentId = spec._owner || prev;   // 面板内打开的视图归属该插件
      try { spec.render(panel, { IDE: IDE }); }
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
      if (typeof spec.render === "function") {
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
    const host = document.createElement("div");
    host.className = "cm-host pl-view-host";
    const body = document.createElement("div");
    body.className = "pl-view-body";
    host.appendChild(body);

    const tab = {
      path: PL_VIEW_PREFIX + key, displayPath: spec.title || id, name: spec.title || id,
      host, cm: null, original: "", dirty: false, big: false,
      group: spec.group != null ? spec.group : curGroup,
      pluginView: true, pluginViewId: id, pluginOwner: _plCurrentId || "",
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
    if (typeof spec.render === "function") {
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
      return _plOpenEditor(Object.assign({}, v.spec, { id: v.id, group: group, title: v.tab.name }));
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
      const proxy = (proxyUrl !== undefined) ? proxyUrl
                  : (opts.proxy !== undefined ? opts.proxy : IDE.api.getProxy());
      const r = await fetch("/api/plugins/http", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: url,
          method: (opts.method || "GET").toUpperCase(),
          headers: opts.headers || {},
          body: opts.body != null ? String(opts.body) : null,
          proxy: proxy || ""
        })
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
  // 转发到后端的 /api/ai/chat（SSE 流式）；不传 provider_id/model 即走系统默认。
  IDE.ai = {
    /**
     * 使用系统设置的 AI 与默认模型对话（流式）。
     * @param {Array<{role:string,content:string}>} messages
     * @param {Object} [opts] { onChunk, onReasoning, webSearch, skills, perm }
     * @returns {Promise<{text:string, reasoning:string}>}
     */
    async chat(messages, opts) {
      opts = opts || {};
      const body = { messages: messages };
      if (opts.webSearch) body.web_search = true;
      if (opts.skills) body.skills = opts.skills;
      if (opts.perm) body.perm = opts.perm;
      const resp = await fetch("/api/ai/chat", {
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
        if (e.target === ov && opts.dismissible !== false) {
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
    IDE.events.emit("pluginDeactivated", id);
  }

  IDE.activate = _plActivate;
  IDE.deactivate = _plDeactivate;

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
    _plRenderPanel();
  };

  // ---------- 扩展面板 UI ----------
  function _esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  // 插件列表始终取最新（禁用浏览器缓存，避免刚上传/切换启用状态后读到旧数据）
  function _plFetchList() {
    return fetch("/api/plugins", { cache: "no-store" }).then(r => r.json());
  }

  function _plRenderPanel() {
    const box = document.getElementById("extPanel");
    if (!box) return;
    _plFetchList().then(list => {
      list = list || [];
      let html =
        '<div class="ph" style="display:flex;justify-content:space-between;align-items:center;gap:8px">' +
          '<span>已安装扩展（' + list.length + '）</span>' +
          '<button class="g-btn outline" id="plUpload" style="padding:2px 8px;font-size:12px">上传插件(zip)</button>' +
        '</div>';
      if (!list.length) html += '<div class="ph" style="color:#888">暂无插件。把插件目录打包成 zip 上传即可。</div>';
      for (const p of list) {
        _plIcons.set(p.id, _plResolveIcon(p));   // 同步插件图标（视图标签默认图标即取自此）
        html +=
          '<div class="pl-card" data-id="' + _esc(p.id) + '">' +
            '<div class="pl-row"><i class="bi ' + _esc(_plResolveIcon(p) || "bi-puzzle") + '"></i> <b>' + _esc(p.name || p.id) + '</b> <span class="pl-ver">v' + _esc(p.version || "0.0.0") + '</span></div>' +
            (p.description ? '<div class="pl-desc">' + _esc(p.description) + '</div>' : '') +
            (p.author ? '<div class="pl-author">作者：' + _esc(p.author) + '</div>' : '') +
            '<div class="pl-acts">' +
              '<label class="pl-sw"><input type="checkbox" data-act="toggle" ' + (p.enabled ? "checked" : "") + '> 启用</label>' +
              '<button class="g-btn outline" data-act="uninstall" style="padding:1px 6px;font-size:11px">卸载</button>' +
            '</div>' +
          '</div>';
      }
      box.innerHTML = html;
      const up = box.querySelector("#plUpload");
      if (up) up.addEventListener("click", _plOpenUpload);
      box.querySelectorAll(".pl-card").forEach(card => {
        const id = card.dataset.id;
        const tog = card.querySelector('[data-act="toggle"]');
        if (tog) tog.addEventListener("change", async (e) => {
          const on = e.target.checked;
          e.target.disabled = true;
          try {
            await IDE.api.post("/api/plugins/" + encodeURIComponent(id) + "/toggle", { enabled: on });
            if (on) {
              const list = await _plFetchList();
              const meta = (list || []).find(p => String(p.id) === String(id)) || { id: id, enabled: true };
              await _plActivate(meta);           // 立即激活，无需刷新
            } else {
              _plDeactivate(id);                 // 立即停用并移除其面板 / 命令 / 视图
            }
            IDE.notifications.show("已" + (on ? "启用" : "禁用"), "ok");
          } catch (err) {
            e.target.checked = !on;              // 失败回滚开关状态
            IDE.notifications.show("操作失败：" + ((err && err.message) || err), "err");
          } finally {
            e.target.disabled = false;
          }
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

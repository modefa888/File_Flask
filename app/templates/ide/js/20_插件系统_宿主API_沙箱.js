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
    ".pl-card .pl-sw{font-size:12px;color:#bbb;display:flex;align-items:center;gap:4px}"
  ].join("");
  document.head.appendChild(_plStyle);

  const IDE = window.IDE || {};
  IDE.host = "file-flask";
  IDE.version = "1.0.0";

  // ---------- 命令注册表 ----------
  const _plCommands = new Map();
  IDE.registerCommand = function (id, opts) {
    if (typeof opts === "function") opts = { run: opts };
    if (!opts || typeof opts.run !== "function") {
      console.warn("[IDE] registerCommand 需要一个 run 函数:", id); return id;
    }
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
    return c.run.apply(null, Array.prototype.slice.call(arguments, 1));
  };

  // ---------- 面板注册 ----------
  const _plPanels = new Map();
  IDE.registerPanel = function (spec) {
    spec = spec || {};
    const id = spec.id;
    if (!id) { console.warn("[IDE] registerPanel 需要 id"); return null; }
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
    const handle = { id: id, el: panel, act: act };
    _plPanels.set(id, handle);
    if (typeof spec.render === "function") {
      try { spec.render(panel, { IDE: IDE }); }
      catch (e) { console.error("[IDE] panel render 失败:", id, e); }
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
    request: fetch
  };

  // ---------- 插件生命周期 ----------
  const _plInstances = new Map();
  IDE.plugins = _plInstances;

  async function _plActivate(meta) {
    if (_plInstances.has(meta.id)) return;
    try {
      const code = await (await fetch("/api/plugins/" + encodeURIComponent(meta.id) + "/main.js")).text();
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
    }
  }

  function _plDeactivate(id) {
    const inst = _plInstances.get(id);
    if (!inst) return;
    try { if (typeof inst.deactivate === "function") inst.deactivate(); } catch (e) { console.error(e); }
    _plInstances.delete(id);
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
    _plRenderPanel();
  };

  // ---------- 扩展面板 UI ----------
  function _esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  function _plRenderPanel() {
    const box = document.getElementById("extPanel");
    if (!box) return;
    IDE.api.get("/api/plugins").then(list => {
      list = list || [];
      let html =
        '<div class="ph" style="display:flex;justify-content:space-between;align-items:center;gap:8px">' +
          '<span>已安装扩展（' + list.length + '）</span>' +
          '<button class="g-btn outline" id="plUpload" style="padding:2px 8px;font-size:12px">上传插件(zip)</button>' +
        '</div>';
      if (!list.length) html += '<div class="ph" style="color:#888">暂无插件。把插件目录打包成 zip 上传即可。</div>';
      for (const p of list) {
        html +=
          '<div class="pl-card" data-id="' + _esc(p.id) + '">' +
            '<div class="pl-row"><b>' + _esc(p.name || p.id) + '</b> <span class="pl-ver">v' + _esc(p.version || "0.0.0") + '</span></div>' +
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
          await IDE.api.post("/api/plugins/" + encodeURIComponent(id) + "/toggle", { enabled: e.target.checked });
          IDE.notifications.show("已" + (e.target.checked ? "启用" : "禁用") + "，刷新页面生效", "ok");
        });
        const un = card.querySelector('[data-act="uninstall"]');
        if (un) un.addEventListener("click", async () => {
          if (!confirm("卸载插件 " + id + "？")) return;
          await IDE.api.post("/api/plugins/" + encodeURIComponent(id) + "/uninstall", {});
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
        else { IDE.notifications.show("安装成功：" + ((d.plugin && (d.plugin.name || d.plugin.id)) || ""), "ok"); _plRenderPanel(); }
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

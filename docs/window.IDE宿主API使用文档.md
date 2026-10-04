# window.IDE 宿主 API 使用文档

> 适用于「在线项目 IDE」的插件开发。插件运行在浏览器页面内，通过宿主注入的 `window.IDE` 对象访问编辑器能力。
> 完整可运行示例见 `plugins/plugin-template/`（含 `plugin.json` 与 `main.js`）。

---

## 1. 插件包结构

一个插件是一个目录，最少包含两个文件：

```
my-plugin/
├── plugin.json   # 元数据 + 贡献声明
└── main.js       # 入口，必须返回 activate / deactivate 契约
```

`plugin.json` 字段：

| 字段 | 说明 |
|---|---|
| `id` | 唯一标识，决定访问路径 `/api/plugins/<id>/main.js`（必填） |
| `name` | 展示名（扩展面板、标签图标） |
| `version` | 版本号 |
| `description` / `author` | 描述 / 作者（扩展面板展示） |
| `icon` | 图标 class，如 `"bi-lightbulb"`（插件视图标签的默认图标） |
| `main` | 入口文件，默认 `main.js` |
| `enabled` | 是否默认启用 |
| `contributes.panels` / `contributes.commands` | **声明性信息**（目前仅用于图标解析与列表展示），并不会自动注册；真正的面板/命令必须在 `activate` 里用 API 注册 |

插件以**目录**形式放到 `data/plugins/<id>/`（或用软链接指向你的开发目录，便于热更新）。

---

## 2. 插件入口契约

`main.js` 被执行后，其**返回值**会被宿主解释为插件模块：

```js
// main.js
return {
  activate(IDE) {
    // 在这里调用 IDE.registerPanel / registerCommand / editors.open ...
    IDE.notifications.show("插件已激活", "ok");

    // 返回值是一个「停用函数」，禁用/卸载时由宿主调用，用于清理
    return function deactivate() {
      // 清理事件监听、定时器等
    };
  }
};
```

- 返回 `{ activate(IDE){...} }`：标准写法（推荐）。
- 返回 `(IDE) => {...}` 函数：宿主会直接调用它，其返回值作为 `deactivate`。
- `activate` 可以是 `async`，可返回 Promise。
- 宿主在页面加载时自动 `IDE.start()`，对所有 `enabled` 插件调用 `activate`（**无需刷新页面**即可启用/禁用/卸载，见第 6 节）。

**沙箱说明**：`main.js` 在页面全局作用域执行，但只注入了以下全局：`IDE`、`window`、`document`、`fetch`、`console`、`setTimeout`、`setInterval`、`clearInterval`。插件模型为「可信插件」（与 VS Code 默认信任用户安装的扩展一致），即对页面有完全访问权，请只安装可信来源。

---

## 3. 命令（命令面板）

### `IDE.registerCommand(id, opts)`
注册一条命令，进入命令面板（`Ctrl+Shift+P` / `Ctrl+P`）可被搜索执行。

- `id`：`string`，唯一。
- `opts`：`{ title, run }`；也可直接传 `run` 函数（`registerCommand(id, fn)`）。
- `opts.title`：面板里展示的名称。
- `opts.run(...args)`：执行体。
- 返回 `id`。

### `IDE.executeCommand(id, ...args)`
手动执行某条命令（参数原样透传给 `run`）。

```js
IDE.registerCommand("my.echo", {
  title: "My: 打个招呼",
  run(a) { IDE.notifications.show("参数：" + JSON.stringify(a), "ok"); }
});
IDE.executeCommand("my.echo", { demo: true });
```

---

## 4. 活动栏面板（侧边栏）

### `IDE.registerPanel(spec)`
在左侧活动栏注册一个按钮 + 一个侧边栏面板容器（插在「设置」按钮之前）。

- `spec.id`：唯一（必填）。重复注册同 id 会直接复用已有面板。
- `spec.title`：按钮标题 / 侧栏标题。
- `spec.icon`：图标 class，缺省 `bi-puzzle`。
- `spec.render(panel, ctx)`：`(panel, { IDE })` —— 把内容渲染进侧栏容器。

```js
IDE.registerPanel({
  id: "my-panel",
  title: "我的面板",
  icon: "bi-stars",
  render(panel, ctx) {
    panel.innerHTML = '<div class="pl-pad"><p>Hello from plugin</p></div>';
  }
});
```

> 侧栏容器已带 `.pl-pad` / `.pl-out` 等预设样式（在宿主注入的 `<style>` 中），可直接复用。

---

## 5. 通知

### `IDE.notifications.show(msg, type)`
顶部轻提示。`type` 取值：`ok` | `warn` | `err` | `info`。

```js
IDE.notifications.show("保存成功", "ok");
IDE.notifications.show("路径无效", "err");
```

---

## 6. 工作区（文件读写 / 打开）

### `IDE.workspace.getRoot()`
返回当前浏览根目录（`ROOT`），无则 `""`。

### `IDE.workspace.getCurrentFile()`
返回当前编辑区打开文件的绝对路径，无则 `null`。

### `IDE.workspace.openFile(path, name)`
在编辑区打开一个文件（走内置打开逻辑，支持语法高亮等）。

### `IDE.workspace.readFile(path)` → `Promise<string>`
读取文本文件内容。失败抛错。

### `IDE.workspace.writeFile(path, content)` → `Promise<string>`
写入文本文件，返回写入后的路径。失败抛错。

```js
const root = IDE.workspace.getRoot();
await IDE.workspace.writeFile(root + "/out.txt", "hello");
await IDE.workspace.openFile(root + "/out.txt", "out.txt");
const txt = await IDE.workspace.readFile(root + "/out.txt");
```

---

## 7. 编辑区自定义视图（WebviewPanel 风格）

插件可在编辑区打开「内容自渲染」的标签页，与打开文件共用同一套标签机制（可切换、可 `Ctrl+\` 拆分、可拖拽排序、可关闭、状态栏/面包屑随激活更新）。

### `IDE.editors.open(spec)` → `view`
- `id`：视图唯一 id。**同 id 再次 open 只聚焦、刷新内容，不会重复开标签**。
- `title`：标签标题。
- `icon` / `iconHtml`：标签图标；省略时默认用「打开该视图的插件」在插件列表里的图标，再兜底是 `bi-puzzle`。
- `render(container, view)`：把内容渲染进 `container`（`.pl-view-body`）。
- `group`：指定编辑组（拆分时使用）。
- `noSplit: true`：禁止该视图被拆分（`Ctrl+\` / 拆分按钮会提示「无法拆分」）。
- `onClose()`：关闭钩子，可异步；返回 `false` 可取消关闭。

返回的 `view` 句柄：

| 方法 / 属性 | 说明 |
|---|---|
| `view.setTitle(name)` | 动态改标签标题 |
| `view.setIcon(iconHtml)` | 动态改标签图标 |
| `view.setDirty(bool)` | 切换「未保存」小圆点 |
| `view.focus()` | 聚焦该视图 |
| `view.onClose(fn)` | 设置关闭钩子（`fn` 返回 `false` 取消关闭） |
| `view.close()` | 关闭 |
| `view.id` / `view.tab` / `view.body` / `view.host` / `view.spec` | 底层引用 |

```js
const view = IDE.editors.open({
  id: "my-view",
  title: "我的视图",
  render(container, v) {
    container.innerHTML = '<div class="pl-pad">计数：<span data-n>0</span></div>';
    container.querySelector('[data-n]').onclick = () => {
      v.setDirty(true);
      v.setTitle("我的视图 (clicked)");
    };
  },
  onClose() { console.log("closed"); return true; }
});
```

### 其它编辑器方法
- `IDE.editors.get(id)` → 取已打开视图句柄（无则 `null`）。
- `IDE.editors.focus(id)` → 聚焦。
- `IDE.editors.close(id)` → 关闭视图。
- `IDE.editors.split(id, group)` → 按登记的 `render` 把视图复制到指定编辑组（**禁止拆分的视图返回 `null`**）。
- `IDE.editors.list()` → 所有打开中的视图 `[{ id, title }]`。
- `IDE.editors.closeAll(pluginId?)` → 关闭全部（传 `pluginId` 只关该插件的视图；宿主在停用插件时自动调用）。

---

## 8. 事件总线

### `IDE.events.on(ev, fn)` → `off`
订阅事件，返回取消订阅函数 `off()`。

### `IDE.events.emit(ev, data)`
发布事件（插件也可发布自定义事件）。

内置事件：`viewOpened`、`viewClosed`、`pluginActivated`、`pluginDeactivated`、`ready`（携带插件列表）。

```js
const off = IDE.events.on("viewOpened", (d) => console.log("打开：", d.id));
IDE.events.emit("myEvent", { x: 1 });
off(); // 取消订阅
```

---

## 9. HTTP 请求封装

### `IDE.api.get(url)` / `IDE.api.post(url, body)` / `IDE.api.request`
封装 `fetch`，返回 `Promise<json>`。

### `IDE.api.getProxy()`
返回「设置 → 网络/代理」里配置的默认代理地址（空字符串 = 直连）。

### `IDE.api.requestProxy(url, opts, proxyUrl?)`
经后端 `/api/plugins/http` **转发**请求（可绕开浏览器 CORS），返回 `{ success, status, headers, text }`。
- `opts`：`{ method, headers, body }`。
- `proxy` 优先级：显式 `proxyUrl` > `opts.proxy` > 默认代理配置。
- 失败抛 `Error`。

### `IDE.api.direct(url, opts)` / `IDE.api.proxy(url, opts, proxyUrl?)`
便捷封装：`direct` 强制不走代理；`proxy` 默认用设置的代理（可显式覆盖）。

```js
const d = await IDE.api.proxy("https://api.github.com/zen");
console.log(d.status, d.text);
```

---

## 10. 系统 AI

使用「设置」里配置的接口与默认模型，转发到后端 `/api/ai/chat`（SSE 流式）。

### `IDE.ai.chat(messages, opts)` → `Promise<{ text, reasoning }>`
- `messages`：`[{ role: "user"|"assistant"|"system", content: string }]`。
- `opts.onChunk(fullText, delta)`：每收到一段文本增量回调。
- `opts.onReasoning(full, delta)`：推理内容（如模型支持）。
- `opts.webSearch` / `opts.skills` / `opts.perm`：可选能力开关。
- 省略模型即走系统默认。

### `IDE.ai.ask(prompt, opts)` → `Promise<string>`
单轮提问，直接返回回复文本。

```js
const r = await IDE.ai.chat([{ role: "user", content: "用一句话解释闭包" }], {
  onChunk: (full) => console.log(full)
});
console.log(r.text, r.reasoning);
```

---

## 11. 系统级自定义弹窗

### `IDE.dialog(opts)` → `Promise<value>`
渲染一个居中模态框，返回 Promise，解析值为被点击按钮的 `value`（点遮罩 / `Esc` 解析 `cancelValue` 或最后一个按钮的 `value`）。

`opts`：

| 字段 | 说明 |
|---|---|
| `title` | 标题 |
| `icon` | 标题图标 class |
| `message` / `html` | 内容（二选一；`html` 支持任意 HTML） |
| `buttons` | `[{ text, value, primary?, gen? }]`，`value` 缺省取 `text` |
| `danger` | `true` 时弹窗变红（危险操作） |
| `wide` | 加宽（760px） |
| `dismissible` | 默认 `true`；`false` 时禁止点遮罩关闭 |
| `cancelValue` | 点遮罩 / `Esc` 时解析的值 |
| `onMount({ box, el, close, q, qa })` | 挂载后回调，`q`/`qa` 为 `querySelector(All)` 封装，便于绑定交互 |

```js
const val = await IDE.dialog({
  title: "确认操作",
  icon: "bi-exclamation-triangle",
  message: "确定要执行吗？",
  danger: true,
  buttons: [
    { text: "执行", value: "run", primary: true },
    { text: "取消", value: "cancel" }
  ]
});
if (val === "run") { /* ... */ }
```

> 需要**贴着按钮弹出**的轻量悬浮确认框，用宿主内的 `uiConfirmPop(anchorEl, { title, msg, okText, danger })`（返回 `Promise<boolean>`）。

---

## 12. 生命周期（供宿主/调试使用）

| API | 说明 |
|---|---|
| `IDE.host` / `IDE.version` | 宿主标识（固定 `"file-flask"` / `"1.0.0"`） |
| `IDE.plugins` | `Map<id, { meta, deactivate }>`，当前已激活实例 |
| `IDE.activate(meta)` | 手动激活某个插件（内部用；已 `enabled` 时重复调用无效） |
| `IDE.deactivate(id)` | 手动停用：调用 `deactivate`、关闭其视图、移除其面板/命令 |
| `IDE.start()` | 页面加载时自动调用，加载全部 `enabled` 插件 |

**免刷新**：上传安装、启用/禁用、卸载现在都会**立即生效**（安装/启用会现场激活并刷新面板与命令，卸载/禁用会立即移除面板、命令与已打开视图），无需刷新页面。

---

## 13. 快速上手清单

1. 复制 `plugins/plugin-template/` 作为起点。
2. 改 `plugin.json` 的 `id` / `name` / `icon`。
3. 在 `main.js` 的 `activate` 里用上面的 API 写功能，并在 `return function deactivate(){...}` 里清理。
4. 把目录软链到 `data/plugins/<id>/`（开发期改完 `main.js`，在扩展面板「卸载→重新上传」或重启后端即可拿到新代码；`main.js` 不做浏览器缓存）。
5. 在扩展面板勾选「启用」，或刷新页面让 `IDE.start()` 自动加载。

---

## 14. 调试技巧

- 所有异常会打印到浏览器 Console（前缀 `[IDE]`）。
- 加载失败会有 `toast` 提示，并 `console.error` 具体原因。
- 在控制台可直接调用 `window.IDE` 验证 API：`IDE.editors.list()`、`IDE.plugins` 等。
- `registerPanel` / `registerCommand` 重复注册同 id 会被忽略或复用，确保插件能被多次 activate 而不报错。

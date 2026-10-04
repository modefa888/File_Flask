// ============================================================================
// 插件开发模板（main.js）
//
// 约定：
//   1) 本文件顶层必须 return 一个插件对象：{ activate(IDE) { ...; return deactivate } }
//   2) 宿主以参数形式向插件注入：IDE、window、document、fetch、console、
//      setTimeout、setInterval、clearInterval。
//   3) 插件启用时调用 activate(IDE)；返回的函数（可选）在禁用/卸载时调用。
//
// 宿主 API（window.IDE）：
//   IDE.registerCommand(id, { title, run })       注册命令（自动进命令面板）
//   IDE.executeCommand(id, ...args)               执行命令
//   IDE.registerPanel({ id, title, icon, render }) 注册侧边栏面板
//   IDE.notifications.show(msg, type)             type: ok|warn|err|info
//   IDE.workspace.getRoot()                        当前浏览根目录
//   IDE.workspace.getCurrentFile()                 当前打开文件的绝对路径（无则返回 null）
//   IDE.workspace.openFile(path, name)             在编辑区打开文件
//   IDE.workspace.readFile(path)                   读文本文件 → Promise<string>
//   IDE.workspace.writeFile(path, content)         写文本文件 → Promise<string>
//   IDE.events.on(event, fn) / IDE.events.emit(...) 简易事件总线
//   IDE.api.get(url) / IDE.api.post(url, body)     封装好的 fetch
// ============================================================================

return {
  activate(IDE) {
    IDE.registerPanel({
      id: "yourPanelId",
      title: "面板标题",
      icon: "bi-puzzle",
      render(el) {
        el.innerHTML = '<div class="pl-pad"><p>在这里渲染你的面板内容。</p></div>';
      }
    });

    IDE.registerCommand("your.cmd", {
      title: "命令面板中显示的文字",
      run() { IDE.notifications.show("命令被触发", "ok"); }
    });

    IDE.notifications.show("你的插件已激活", "ok");

    return function deactivate() {
      // 卸载/禁用时的清理逻辑
    };
  }
};

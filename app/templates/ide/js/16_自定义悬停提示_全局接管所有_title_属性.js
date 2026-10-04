  /* ==================================================================
     自定义悬停提示：全局接管所有 title 属性
     —— 悬停时把 title 摘下来（原生气泡就不会再弹），改由 #ideTip 统一显示，
        离开时再还原，所以页面里原有的 title 文案完全不用改。
        想单独定制某处文案，直接改它的 title（或动态赋值）即可。
     ================================================================== */
  (function initHoverTip() {
    const tip = document.createElement("div");
    tip.className = "ide-tip";
    document.body.appendChild(tip);
    let cur = null, timer = null;

    function hide() {
      clearTimeout(timer); timer = null;
      tip.classList.remove("show");
      if (cur) {
        // 还原 title（期间若被代码改成了新文案，则不覆盖）
        if (cur.dataset.tipText !== undefined) {
          if (!cur.getAttribute("title")) cur.setAttribute("title", cur.dataset.tipText);
          delete cur.dataset.tipText;
        }
        cur = null;
      }
    }
    function show(el) {
      const text = el.getAttribute("title") || el.dataset.tipText || "";
      if (!text.trim()) return;
      if (el.dataset.tipText === undefined) el.dataset.tipText = text;
      el.removeAttribute("title");            // 让浏览器原生提示闭嘴
      tip.textContent = text;
      tip.classList.add("show");
      // 默认显示在元素下方，贴边时自动翻转/夹取
      const r = el.getBoundingClientRect(), tr = tip.getBoundingClientRect();
      const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
      let left = Math.max(6, Math.min(r.left + Math.min(6, r.width / 2), vw - tr.width - 6));
      let top = r.bottom + 8;
      if (top + tr.height > vh - 6) top = Math.max(6, r.top - tr.height - 8);
      tip.style.left = Math.round(left) + "px";
      tip.style.top = Math.round(top) + "px";
    }

    document.addEventListener("mouseover", (e) => {
      const el = e.target && e.target.closest ? e.target.closest("[title]") : null;
      if (!el || el === cur) return;
      hide();
      cur = el;
      timer = setTimeout(() => { if (cur === el) show(el); }, 300);   // 稍作延迟，快速划过不弹
    });
    document.addEventListener("mouseout", (e) => {
      if (!cur) return;
      if (e.relatedTarget && cur.contains(e.relatedTarget)) return;   // 还在同一元素内部移动
      hide();
    });
    document.addEventListener("mousedown", hide, true);
    document.addEventListener("keydown", hide, true);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("blur", hide);
    // 目标元素被移除（树刷新/标签重建等）时浏览器不会派发 mouseout，气泡会残留；
    // 定期检查，元素已不在文档中就收起
    setInterval(() => { if (cur && !cur.isConnected) hide(); }, 300);
  })();

  loadRecentFolders().then(() => loadSpecialHints()).then(async () => {  // 先取最近打开，再加载命名说明
    initTree();
    loadGitStatus();          // 启动时同步分支信息到状态栏
    loadGitignoreRules();     // 启动时加载 .gitignore 规则，文件树忽略条目置灰
    if (typeof sessionRestore === "function") await sessionRestore();
  });
})();

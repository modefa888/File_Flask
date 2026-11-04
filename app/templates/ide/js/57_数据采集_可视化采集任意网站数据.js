/* ==================================================================
   数据采集（可视化采集任意网站数据）
     · 抓取：服务端请求网址 → 清洗 HTML → 在 iframe 里预览（预览不执行站点脚本）；
     · 点选：点页面元素自动生成 CSS 选择器（列表项 / 字段两种模式），零代码；
     · 采集：按规则批量提取文本 / 属性 / 内层 HTML，支持 URL 模板、下一页链接翻页；
     · 结果：表格预览、导出 CSV / JSON / Excel，方案可保存复用。
     须放在 16_（关闭大 IIFE）之前，复用闭包内的 $ / esc / toast / panels / titles /
     tabs / findTab / activate / renderTabsAll / curGroup / currentWrap / edGroups。
   ================================================================== */

if (typeof panels !== "undefined") panels.scraper = "scraperPanel";
if (typeof titles !== "undefined") titles.scraper = "数据采集";

const SCR_VIEW_PATH = "\u0000scraper";
const SCR_DRAFT_KEY = "ide.scraper.draft";
const SCR_MAX_RENDER = 300;      // 表格最多渲染多少行（再多滚动会卡，导出不受影响）

const SCR = {
  url: "", pageUrl: "", pageTitle: "", previewUrl: "",
  itemSel: "", fields: [], rows: [], rowsAll: [], columns: [],
  siteKey: "", sites: {},                  // 按域名分别记一套选择器（切站点不串台）
  hideSelectors: [],                       // 隐藏掉的浮层选择器（换文档后自动再隐藏一遍）
  filters: [], filterAnd: true, filterNoEmpty: false, lastMeta: {},
  mode: "", busy: false, loaded: false,
  taskId: "", taskName: "",
  pages: 1, pageMode: "none", urlTemplate: "", nextSel: "",
  ua: "", cookie: "", insecure: false, delay: 300, dedupe: true,
  noImg: false, fetchTimeout: 30,        // 不代理图片资源 / 抓取超时（秒）
  lowMem: false,                         // 低内存模式（迷你版 Chromium）
  render: false, scrollTimes: 0, scrollLoops: 6, rendered: false, pendingScrollY: null,
  live: false, interactive: false, agentSeq: 0, agentMap: {},
  logs: [], resultMin: false, advOpen: false, tasks: [],
  genLang: "py", genCode: "", genAiCode: false, genAbort: null,
  itemLock: false,                        // 🔒 锁定后点选 / 自动识别不再改动列表项选择器
  hlEl: null, saveTimer: 0
};

/* ---------------- 小工具 ---------------- */
function scrA(s) { return esc(s == null ? "" : s).replace(/"/g, "&quot;"); }

function scrReq(url, body) {
  return fetch(url, {
    method: "POST", credentials: "same-origin", cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  }).then(function (r) {
    return r.json().catch(function () { return { error: "HTTP " + r.status }; });
  }).catch(function (e) {
    return { error: (e && e.message) || "网络异常" };
  });
}

function scrConfirm(title, msg) {
  return new Promise(function (res) {
    if (typeof uiConfirm === "function") {
      try {
        // 统一弹窗签名：uiConfirm(标题, 正文, 确定按钮文字, 是否危险操作)
        Promise.resolve(uiConfirm(title, msg, "删除", true))
          .then(function (v) { res(!!v); })
          .catch(function () { res(false); });
        return;
      } catch (_) { }
    }
    res(window.confirm(title + "\n\n" + String(msg || "").replace(/<[^>]+>/g, "")));
  });
}

function scrSize(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + " B";
  if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
  return (n / 1048576).toFixed(2) + " MB";
}

/* ---------------- 实时内存占用（数据采集模块） ---------------- */
function scrMemApply(d) {
  if (!d || d.error) return;
  const badge = $("scrMemBadge");
  const info = $("scrMemInfo");
  const rss = d.rss_h || scrSize(d.rss || 0);
  const chromN = (d.chromium && d.chromium.n) || 0;
  const chromH = (d.chromium && d.chromium.bytes_h) || "0 KB";
  const chromOrphan = (d.chromium && d.chromium.orphans) || 0;
  const orphanTip = chromOrphan ? "（树外残留 " + chromOrphan + " 个）" : "";
  const otherH = d.other_h || "0 KB";
  if (badge) {
    badge.textContent = "内存 " + rss + (chromN ? " + Chromium " + chromH : "");
    badge.title = "数据采集模块内存占用（含未归还的堆，不等于各项缓存之和）\n" +
      "Flask 进程 RSS：" + rss + "\n" +
      "线程数：" + (d.threads || 0) + " 个\n" +
      "其他（线程栈 / 解析临时对象 / 未归还的堆）：" + otherH + "\n" +
      "Chromium（渲染子进程）：" + chromN + " 个 / " + chromH + orphanTip + "\n" +
      "图片代理缓存：" + ((d.img && d.img.n) || 0) + " 项 / " + ((d.img && d.img.bytes_h) || "0") + "\n" +
      "镜像缓存：" + ((d.mirror && d.mirror.n) || 0) + " 项 / " + ((d.mirror && d.mirror.bytes_h) || "0") + "\n" +
      "预览页缓存：" + ((d.previews && d.previews.n) || 0) + " 份 / " + ((d.previews && d.previews.bytes_h) || "0") + "\n" +
      "渲染会话：" + (d.render_sessions || 0) + " 个\n点击打开「高级」查看明细与释放";
  }
  if (info) {
    info.innerHTML = "进程 <b>" + rss + "</b>" +
      " · 线程 " + (d.threads || 0) + " 个" +
      " · 其他（堆/栈） " + otherH +
      " · Chromium <b>" + chromN + "</b> 个 / " + chromH + orphanTip +
      " · 图片缓存 " + ((d.img && d.img.n) || 0) + " 项 " + ((d.img && d.img.bytes_h) || "") +
      " · 镜像缓存 " + ((d.mirror && d.mirror.n) || 0) + " 项 " + ((d.mirror && d.mirror.bytes_h) || "") +
      " · 预览 " + ((d.previews && d.previews.n) || 0) + " 份 " + ((d.previews && d.previews.bytes_h) || "") +
      " · 渲染会话 " + (d.render_sessions || 0) + " 个";
  }
}

function scrMemRefresh() {
  fetch("/api/scraper/mem", { credentials: "same-origin", cache: "no-store" })
    .then(function (r) { return r.json(); })
    .then(scrMemApply)
    .catch(function () { });
}

/* ---------------- 标签页 ---------------- */
function scrOpenCenter() {
  let tab = findTab(SCR_VIEW_PATH);
  if (!tab) {
    const host = document.createElement("div");
    host.className = "cm-host scr-host";
    host.innerHTML = '<div class="scr" id="scrRoot"></div>';
    const dw = (typeof currentWrap === "function") ? currentWrap() : null;
    (dw || edGroups).appendChild(host);
    tab = {
      path: SCR_VIEW_PATH, host: host, cm: null, original: "", dirty: false,
      group: curGroup, name: "数据采集", displayPath: "数据采集", relPath: "",
      iconHtml: '<i class="bi bi-radar" style="color:var(--ide-c-scraper)"></i>',
      isScraper: true,
    };
    tabs.push(tab);
    renderTabsAll();
    scrBuild();
  }
  activate(tab);
  document.querySelectorAll(".scr-host").forEach(function (h) {
    if (h !== tab.host) { try { h.remove(); } catch (_) { } }
  });
  return tab;
}

function scrVisible() {
  return !!findTab(SCR_VIEW_PATH) && !!active && active.path === SCR_VIEW_PATH;
}

/* ---------------- 构建界面 ---------------- */
function scrBuild() {
  const root = $("scrRoot");
  if (!root || root.dataset.built === "1") return;
  root.dataset.built = "1";
  root.innerHTML = [
    '<div class="scr-top">',
      '<div class="scr-urlrow">',
        '<i class="bi bi-globe2"></i>',
        '<input class="scr-url" id="scrUrl" spellcheck="false" autocomplete="off" ',
          'placeholder="输入要采集的网址，例如 https://example.com/list">',
        '<button class="scr-btn primary" id="scrGo"><i class="bi bi-cloud-download"></i> 抓取页面</button>',
        '<button class="scr-btn" id="scrAdvBtn" title="请求头 / Cookie / 延时等高级设置"><i class="bi bi-sliders"></i> 高级</button>',
        '<span class="scr-stat scr-membadge" id="scrMemBadge" title="数据采集模块内存占用（点击查看明细）"></span>',
        '<span class="scr-stat" id="scrStat"></span>',
      '</div>',
      '<div class="scr-adv" id="scrAdv" hidden>',
        '<div class="scr-membar">',
          '<i class="bi bi-memory"></i>',
          '<span id="scrMemInfo">内存：读取中…</span>',
          '<button class="scr-mini" id="scrMemFree" title="清空图片 / 镜像 / 预览缓存并关闭渲染会话（当前预览会失效，需重新抓取页面）">' +
            '<i class="bi bi-eraser"></i> 释放内存</button>',
        '</div>',
        '<label>User-Agent<input type="text" id="scrUa" placeholder="留空用默认浏览器 UA"></label>',
        '<label>Cookie<input type="text" id="scrCookie" placeholder="需要登录态时粘贴 Cookie"></label>',
        '<label>翻页延时（毫秒）<input type="number" id="scrDelay" min="0" max="5000" step="100"></label>',
        '<label title="单页请求的最长等待时间，慢站可以调大">超时（秒）<input type="number" id="scrTimeout" min="5" max="60" step="5"></label>',
        '<label class="scr-check"><input type="checkbox" id="scrInsecure"> 忽略证书错误</label>',
        '<label class="scr-check" title="用无头浏览器真实执行站点脚本：懒加载图片、滚动到底加载更多的站点必须打开。可与工具条的「交互模式」同时使用（先渲染再交互）"><input type="checkbox" id="scrRender"> 浏览器渲染（执行 JS）</label>',
        '<label title="开启渲染时，打开页面后先自动往下滚几屏再交给点选">先滚 N 屏<input type="number" id="scrScrollTimes" min="0" max="20" step="1" placeholder="0"></label>',
        '<label class="scr-check" title="预览里的图片不再走本机代理，直接用原站地址加载：预览更快、更省流量；有防盗链的站点可能显示裂图"><input type="checkbox" id="scrNoImg"> 不代理图片资源</label>',
        '<label class="scr-check" title="迷你版 Chromium：启动参数瘦身（不加载图片 / 限制 V8 堆 / 合并渲染进程 / 缩小视口），内存能省一半以上；代价是页面更慢、极端重型的页面可能打不开。勾选后重新抓取生效"><input type="checkbox" id="scrLowMem"> 低内存模式（迷你版）</label>',
      '</div>',
    '</div>',

    '<div class="scr-main">',
      '<div class="scr-stage">',
        '<div class="scr-stagebar">',
          '<button class="scr-mode on" data-scr-mode="item"><i class="bi bi-bounding-box"></i> ① 点选列表项</button>',
          '<button class="scr-mode pick-field" data-scr-mode="field"><i class="bi bi-input-cursor-text"></i> ② 点选字段</button>',
          '<button class="scr-mode" id="scrLiveBtn" title="进入正常浏览器状态：站点脚本真正执行，可以滚动 / 点击 / 播放 / 站内翻页。再点一次回到静态预览，继续点选采集">' +
            '<i class="bi bi-pc-display-horizontal"></i> 交互模式</button>',
          '<button class="scr-mode" data-scr-mode="clean" title="隐藏广告 / 登录弹窗 / 悬浮条等浮层：进入后先自动清一遍，之后点哪个清哪个">' +
            '<i class="bi bi-eraser"></i> 清浮层</button>',
          '<span class="scr-tip" id="scrTip">先抓取页面，再点选要采集的元素</span>',
          '<button class="scr-mode" id="scrUnhide" title="把隐藏过的浮层恢复回来（重新加载预览）">' +
            '<i class="bi bi-arrow-counterclockwise"></i> 恢复浮层</button>',
          '<button class="scr-mode" id="scrMore" title="让页面继续往下滚，触发懒加载 / 无限滚动（需先在「高级」里开启浏览器渲染）">' +
            '<i class="bi bi-arrow-down-circle"></i> 滚动加载更多</button>',
        '</div>',
        '<div class="scr-framewrap">',
          '<iframe class="scr-frame" id="scrFrame" sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-modals"></iframe>',
          '<div class="scr-loading" id="scrLoading"><span class="scr-spin"></span><span id="scrLoadingText">正在抓取页面…</span></div>',
          '<div class="scr-empty" id="scrEmpty">',
            '<i class="bi bi-radar"></i>',
            '<h3>可视化采集任意网站数据</h3>',
            '<p>输入网址抓取页面，然后在预览里点一下「列表项」，再逐个点要采集的字段，' +
              '选择器会自动生成；翻页与导出都帮你做好，全程不需要写代码。</p>',
            '<div class="scr-steps">',
              '<div class="scr-step">① 输入网址 → 抓取页面</div>',
              '<div class="scr-step">② 点选列表项 → 点选字段</div>',
              '<div class="scr-step">③ 开始采集 → 导出表格</div>',
            '</div>',
          '</div>',
          '<div class="scr-adjbar" id="scrAdjbar" hidden>',
            '<i class="bi bi-bounding-box-circles"></i>',
            '<b>列表项调整</b>',
            '<code id="scrAdjSel"></code>',
            '<span class="scr-badge" id="scrAdjCount"></span>',
            '<button class="scr-mini" id="scrAdjUp" title="选中元素的上一级（选择范围更大）"><i class="bi bi-arrows-expand"></i> 扩大</button>',
            '<button class="scr-mini" id="scrAdjDown" title="退回上一级（选择范围更小）"><i class="bi bi-arrows-collapse"></i> 缩小</button>',
            '<button class="scr-mini" id="scrAdjOk" title="保存这个选择器"><i class="bi bi-check-lg"></i> 确认</button>',
            '<button class="scr-mini" id="scrAdjNo" title="放弃本次选择"><i class="bi bi-x-lg"></i> 取消</button>',
          '</div>',
        '</div>',
      '</div>',

      '<div class="scr-side">',
        '<div class="scr-card">',
          '<div class="scr-cardhead"><i class="bi bi-list-stars"></i>列表项选择器',
            '<span class="scr-badge" id="scrSiteName" style="margin-left:auto" title="当前配置所属站点"></span>',
            '<button class="scr-mini scr-itemlock" id="scrItemLock" title="锁定选择器：锁定后点选 / 自动识别都不会再改动它">' +
              '<i class="bi bi-unlock"></i></button>',
          '</div>',
          '<input class="scr-in mono" id="scrItemSel" spellcheck="false" autocomplete="off" ',
            'placeholder="点左侧任意一条数据，自动生成">',
          '<div class="scr-row">',
            '<button class="scr-mini" id="scrGuess"><i class="bi bi-magic"></i> 自动识别</button>',
            '<button class="scr-mini" id="scrTest"><i class="bi bi-check2-circle"></i> 测试匹配</button>',
            '<span class="scr-badge" id="scrItemCount"></span>',
          '</div>',
          '<div class="scr-hint">列表项 = 一「行」数据的容器，例如 <code>li.item</code>、<code>tr</code>；也支持 XPath，' +
            '如 <code>//div[@class=\'card\']</code>。</div>',
        '</div>',

        '<div class="scr-card">',
          '<div class="scr-cardhead"><i class="bi bi-input-cursor-text"></i>字段',
            '<span class="scr-badge" id="scrFieldCount">0</span>',
            '<button class="scr-mini scr-mini" id="scrAddField" style="margin-left:auto">+ 手动添加</button>',
          '</div>',
          '<div class="scr-fields" id="scrFieldList"></div>',
          '<div class="scr-hint">选择器支持 CSS 与 XPath：字段名右边 <b>⇄ CSS</b> 按钮一键切换，' +
            '<i class="bi bi-code-slash"></i> 查看该元素的 HTML / XPath，可复制后改成 <code>.//a/@href</code> 这类高级写法。</div>',
        '</div>',

        '<div class="scr-card">',
          '<div class="scr-cardhead"><i class="bi bi-arrow-repeat"></i>翻页</div>',
          '<select class="scr-in" id="scrPageMode">',
            '<option value="none">不翻页（只采当前页）</option>',
            '<option value="url">URL 模板（含 {page}）</option>',
            '<option value="next">点「下一页」链接</option>',
            '<option value="scroll">滚动加载（懒加载 / 无限滚动）</option>',
          '</select>',
          '<div id="scrPageUrl" style="margin-top:7px" hidden>',
            '<input class="scr-in mono" id="scrUrlTpl" spellcheck="false" ',
              'placeholder="https://example.com/list?page={page}">',
            '<div class="scr-row">',
              '<label class="scr-badge">页数</label>',
              '<input class="scr-in" id="scrPages" type="number" min="1" max="30" value="1" style="width:76px">',
            '</div>',
          '</div>',
          '<div id="scrPageNext" style="margin-top:7px" hidden>',
            '<input class="scr-in mono" id="scrNextSel" spellcheck="false" ',
              'placeholder="下一页链接的选择器（留空自动找）">',
            '<div class="scr-row">',
              '<label class="scr-badge">最多页数</label>',
              '<input class="scr-in" id="scrPages2" type="number" min="1" max="30" value="3" style="width:76px">',
            '</div>',
          '</div>',
          '<div id="scrPageScroll" style="margin-top:7px" hidden>',
            '<div class="scr-row" style="margin-top:0">',
              '<label class="scr-badge">最多滚动</label>',
              '<input class="scr-in" id="scrScrollLoops" type="number" min="1" max="20" value="6" style="width:76px">',
              '<span class="scr-badge">次（滚到底会自动提前停）</span>',
            '</div>',
            '<div class="scr-hint">此模式自动启用浏览器渲染：边往下滚边把新内容加载出来，适合「滚到底才出数据」的站点。</div>',
          '</div>',
        '</div>',

        '<div class="scr-card">',
          '<div class="scr-cardhead"><i class="bi bi-play-circle"></i>执行</div>',
          '<div class="scr-row" style="margin-top:0">',
            '<input class="scr-in" id="scrTaskName" placeholder="方案名称（保存后可复用）" style="flex:1;min-width:0;width:auto">',
            '<button class="scr-mini" id="scrSaveTask" title="保存这套选择器，下次直接点开"><i class="bi bi-bookmark-plus"></i> 保存</button>',
          '</div>',
          '<div class="scr-row">',
            '<button class="scr-btn go" id="scrRun"><i class="bi bi-play-fill"></i> 开始采集</button>',
            '<button class="scr-btn" id="scrPreviewBtn"><i class="bi bi-table"></i> 预览当前页</button>',
            '<button class="scr-btn" id="scrGenCode" title="一键生成可运行的采集代码（多语言 / AI 按说明生成）">' +
              '<i class="bi bi-code-square"></i> 代码生成</button>',
          '</div>',
          '<div class="scr-hint" id="scrRunHint">采集会在服务端按规则抓取，翻页越多耗时越长。</div>',
        '</div>',
      '</div>',
    '</div>',

    '<div class="scr-resizer" id="scrResizer" title="上下拖动调整结果区高度"></div>',

    '<div class="scr-result" id="scrResult">',
      '<div class="scr-resulthead">',
        '<i class="bi bi-chevron-down" id="scrResultToggle" title="收起 / 展开结果"></i>',
        '<b>采集结果</b>',
        '<span class="scr-counts" id="scrCounts">还没有数据</span>',
        '<span class="scr-resultacts">',
          '<button class="scr-mini" id="scrFilterBtn" title="按字符串筛选结果行（过滤空值 / 异常链接 / 广告行）"><i class="bi bi-funnel"></i> 筛选<span id="scrFilterBadge"></span></button>',
          '<button class="scr-mini" id="scrExpCsv" title="下载 CSV（Excel 可直接打开）"><i class="bi bi-filetype-csv"></i> CSV</button>',
          '<button class="scr-mini" id="scrExpXlsx" title="下载 Excel 工作簿"><i class="bi bi-file-earmark-excel"></i> Excel</button>',
          '<button class="scr-mini" id="scrExpJson" title="下载 JSON"><i class="bi bi-filetype-json"></i> JSON</button>',
        '</span>',
      '</div>',
      '<div class="scr-filterbar" id="scrFilterBar" hidden>',
        '<div class="scr-fb-row">',
          '<select class="scr-in" id="scrFCol" title="按哪一列筛选"></select>',
          '<select class="scr-in" id="scrFOp" title="匹配方式">',
            '<option value="contains">包含</option>',
            '<option value="not_contains">不包含</option>',
            '<option value="eq">等于</option>',
            '<option value="ne">不等于</option>',
            '<option value="regex">正则匹配</option>',
            '<option value="empty">为空</option>',
            '<option value="not_empty">不为空</option>',
          '</select>',
          '<input class="scr-in" id="scrFVal" spellcheck="false" placeholder="筛选字符串（选「为空 / 不为空」时可留空）">',
          '<button class="scr-mini" id="scrFAdd"><i class="bi bi-plus-lg"></i> 添加规则</button>',
          '<button class="scr-mini" id="scrFNoEmpty" title="任意字段为空的行直接丢掉（广告卡 / 缺作者这类脏行）">丢弃空值行</button>',
          '<span class="scr-fb-mode">',
            '<button class="scr-mini on" data-fmode="and" title="所有规则都满足才保留">全部满足</button>',
            '<button class="scr-mini" data-fmode="or" title="满足任意一条就保留">任意满足</button>',
          '</span>',
          '<span class="scr-fb-count" id="scrFCount"></span>',
          '<button class="scr-mini" id="scrFClear">清除</button>',
        '</div>',
        '<div class="scr-fb-chips" id="scrFChips"></div>',
      '</div>',
      '<div class="scr-tablewrap" id="scrTableWrap">',
        '<div class="scr-tblempty">还没有采集结果：抓取页面 → 点选列表项和字段 → 开始采集</div>',
      '</div>',
      '<div class="scr-logs" id="scrLogs" hidden></div>',
      '<div class="scr-ai-pop scr-exp-pop" id="scrExpPop" hidden>',
        '<div class="scr-ai-pop-title"><i class="bi bi-download"></i> 确认导出</div>',
        '<div>将下载 <code id="scrExpName">CSV</code>（<span id="scrExpRows">0</span> 行），是否继续？</div>',
        '<div class="scr-ai-pop-acts">',
          '<button class="scr-mini" id="scrExpNo">取消</button>',
          '<button class="scr-mini" id="scrExpOk"><i class="bi bi-download"></i> 确认导出</button>',
        '</div>',
      '</div>',
    '</div>',

    /* 查看元素（树形）：点左边树里的节点，右边自动给出相对列表项的 XPath / CSS，可一键写回字段 */
    '<div class="scr-viewer" id="scrViewer" hidden>',
      '<div class="scr-vw-box">',
        '<div class="scr-vw-head"><i class="bi bi-diagram-3"></i> 元素树<span class="scr-vw-sub" id="scrVwRoot"></span>',
          '<button class="scr-vw-x" id="scrVwClose" title="关闭"><i class="bi bi-x-lg"></i></button>',
        '</div>',
        '<div class="scr-vw-main">',
          '<div class="scr-vw-tree" id="scrVwTree"></div>',
          '<div class="scr-vw-side">',
            '<div class="scr-vw-diag" id="scrVwDiag" hidden></div>',
            '<div class="scr-vw-row"><b>XPath</b><code id="scrVwXp"></code></div>',
            '<div class="scr-vw-row"><b>CSS</b><code id="scrVwCss"></code></div>',
            '<div class="scr-vw-attrs" id="scrVwAttrs"></div>',
            '<div class="scr-vw-acts">',
              '<button class="scr-mini" data-use="xpath" title="把这条 XPath 设为该字段的选择器">用这个 XPath</button>',
              '<button class="scr-mini" data-use="css" title="把这条 CSS 设为该字段的选择器">用这个 CSS</button>',
            '</div>',
            '<div class="scr-vw-acts">',
              '<button class="scr-mini" data-copy="xp">复制 XPath</button>',
              '<button class="scr-mini" data-copy="css">复制 CSS</button>',
            '</div>',
            '<div class="scr-vw-tip">左边点节点即可切换目标；鼠标划过节点会在页面上高亮。' +
              '想要属性 / 文本节点，可以把 XPath 改成 <code>.//a/@href</code>、<code>.//span/text()</code>。</div>',
            '<pre class="scr-vw-html" id="scrVwHtml"></pre>',
          '</div>',
        '</div>',
      '</div>',
    '</div>',

    /* 生成代码：按当前配置一键生成可运行脚本，可交给 AI 优化 */
    '<div class="scr-viewer" id="scrCodeGen" hidden>',
      '<div class="scr-vw-box scr-cgen-box">',
        '<div class="scr-vw-head"><i class="bi bi-code-square"></i> 生成采集代码',
          '<select class="scr-in scr-cgen-lang" id="scrCodeGenLang">',
            '<option value="ai">✦ AI · 按一句话说明生成（任意语言）</option>',
            '<option value="py">Python · requests + parsel（CSS / XPath 通用）</option>',
            '<option value="py_bs4">Python · requests + BeautifulSoup</option>',
            '<option value="py_lxml">Python · requests + lxml（支持 XPath）</option>',
            '<option value="go">Go · net/http + goquery</option>',
            '<option value="node">Node.js · axios + cheerio</option>',
            '<option value="js">浏览器 JS · fetch + DOMParser</option>',
          '</select>',
          '<button class="scr-mini" id="scrCodeGenAi" title="把当前代码交给 AI 优化：异常重试 / 反爬 / 翻页 / 注释，一键替换">' +
            '<i class="bi bi-stars"></i> AI 优化</button>',
          '<button class="scr-mini" id="scrCodeGenCopy" title="复制代码"><i class="bi bi-clipboard"></i> 复制</button>',
          '<button class="scr-mini" id="scrCodeGenDl" title="下载代码文件"><i class="bi bi-download"></i> 下载</button>',
          '<button class="scr-vw-x" id="scrCodeGenClose" title="关闭"><i class="bi bi-x-lg"></i></button>',
        '</div>',
        '<pre class="scr-cgen-code" id="scrCodeGenOut"></pre>',
        '<div class="scr-ai-pop" id="scrAiPop" hidden>',
          '<div class="scr-ai-pop-title"><i class="bi bi-stars"></i> 一句话告诉 AI 怎么优化</div>',
          '<textarea class="scr-in" id="scrAiInput" rows="3" ' +
            'placeholder="例如：加上失败重试和随机延时 / 最多翻 10 页 / 字段里加发布时间…（留空则按默认方式优化）"></textarea>',
          '<div class="scr-ai-pop-acts">',
            '<button class="scr-mini" id="scrAiNo">取消</button>',
            '<button class="scr-mini" id="scrAiOk"><i class="bi bi-stars"></i> 开始优化</button>',
          '</div>',
        '</div>',
        '<div class="scr-ai-pop scr-dl-pop" id="scrDlPop" hidden>',
          '<div class="scr-ai-pop-title"><i class="bi bi-download"></i> 确认下载</div>',
          '<div>将下载 <code id="scrDlName">scraper.py</code>，是否继续？</div>',
          '<div class="scr-ai-pop-acts">',
            '<button class="scr-mini" id="scrDlNo">取消</button>',
            '<button class="scr-mini" id="scrDlOk"><i class="bi bi-download"></i> 确认下载</button>',
          '</div>',
        '</div>',
      '</div>',
    '</div>',

    /* 取值规则：点字段行的「规则」按钮弹出（替换 / 前后缀拼接 / 多值） */
    '<div class="scr-rulepop" id="scrRulePop" hidden>',
      '<div class="scr-rulepop-head"><i class="bi bi-sliders"></i> 取值规则',
        '<span class="scr-rulepop-name" id="scrRulePopName"></span>',
        '<button class="scr-vw-x" id="scrRulePopClose" title="关闭"><i class="bi bi-x-lg"></i></button>',
      '</div>',
      '<label class="scr-rule-check" title="同一字段匹配多个元素时，用 | 拼起来">' +
        '<input type="checkbox" id="scrRuleMulti"> 多值（多个匹配用 | 拼接）</label>',
      '<div class="scr-rule-prev" id="scrRulePrev"></div>',
      '<div class="scr-rule-row">',
        '<span class="scr-badge">替换</span>',
        '<input class="scr-in" id="scrRuleFind" placeholder="查找">',
        '<input class="scr-in" id="scrRuleTo" placeholder="替换为">',
        '<label class="scr-rule-check" title="按正则表达式替换"><input type="checkbox" id="scrRuleRe">正则</label>',
        '<button class="scr-mini" id="scrRuleReAdd" title="把这条替换规则加到该字段">添加</button>',
      '</div>',
      '<div class="scr-rule-chips" id="scrRuleChips"></div>',
      '<div class="scr-rule-row">',
        '<span class="scr-badge">拼接</span>',
        '<input class="scr-in" id="scrRulePre" placeholder="前缀">',
        '<input class="scr-in" id="scrRuleSuf" placeholder="后缀">',
      '</div>',
      '<div class="scr-rule-hint">替换 / 拼接在预览与开始采集时自动生效；AI 生成 / 优化也会带上这些规则。</div>',
    '</div>',
  ].join("");

  scrBindOnce();
  scrRestoreDraft();
  scrRenderFields();
  scrApplyDraftToInputs();
  scrModeSet("item");
  scrLoadTasks();
}

/* ---------------- 事件绑定（一次性） ---------------- */
function scrBindOnce() {
  const root = $("scrRoot");
  if (!root || root.dataset.bound === "1") return;
  root.dataset.bound = "1";

  $("scrGo").addEventListener("click", function () { scrFetchPage(($("scrUrl").value || "").trim()); });
  $("scrUrl").addEventListener("keydown", function (e) {
    if (e.key === "Enter") scrFetchPage(($("scrUrl").value || "").trim());
  });
  $("scrAdvBtn").addEventListener("click", function () {
    SCR.advOpen = !SCR.advOpen;
    $("scrAdv").hidden = !SCR.advOpen;
    this.classList.toggle("on", SCR.advOpen);
    if (SCR.advOpen) scrMemRefresh();
  });
  // 实时内存：徽标点击打开高级面板；5 秒自动刷新（仅数据采集页可见时）
  $("scrMemBadge").addEventListener("click", function () {
    if (!SCR.advOpen) $("scrAdvBtn").click();
    else scrMemRefresh();
  });
  $("scrMemFree").addEventListener("click", function () {
    const btn = this;
    btn.disabled = true;
    scrReq("/api/scraper/mem/clear", {}).then(function (d) {
      btn.disabled = false;
      if (!d || d.error) { toast((d && d.error) || "释放失败", "err"); return; }
      scrMemApply(d);
      toast("已释放内存（关闭渲染会话 " + (d.closed_sessions || 0) + " 个）；当前预览已失效，请重新抓取页面", "ok");
      SCR.previewUrl = "";
      const fr = $("scrFrame");
      if (fr) fr.src = "about:blank";
      SCR.interactive = false;
    });
  });
  if (!SCR.__memTimer) {
    SCR.__memTimer = setInterval(function () {
      if (SCR.busy || !scrVisible()) return;
      scrMemRefresh();
    }, 5000);
  }
  // 悬浮面板：点到面板和「高级」按钮外面就自动收起
  if (!SCR.__advOutsideBound) {
    SCR.__advOutsideBound = true;
    document.addEventListener("mousedown", function (e) {
      if (!SCR.advOpen) return;
      const t = e.target;
      if (t && t.closest && (t.closest("#scrAdv") || t.closest("#scrAdvBtn"))) return;
      SCR.advOpen = false;
      const adv = $("scrAdv");
      if (adv) adv.hidden = true;
      const btn = $("scrAdvBtn");
      if (btn) btn.classList.remove("on");
    });
  }
  $("scrUa").addEventListener("input", function () { SCR.ua = this.value.trim(); scrSaveDraft(); });
  $("scrCookie").addEventListener("input", function () { SCR.cookie = this.value.trim(); scrSaveDraft(); });
  $("scrDelay").addEventListener("change", function () { SCR.delay = Math.max(0, Math.min(5000, Number(this.value) || 0)); scrSaveDraft(); });
  $("scrInsecure").addEventListener("change", function () { SCR.insecure = !!this.checked; scrSaveDraft(); });
  $("scrNoImg").addEventListener("change", function () {
    SCR.noImg = !!this.checked;
    scrSaveDraft();
    if (SCR.noImg) toast("已勾选「不代理图片资源」：重新抓取页面后生效，图片直连原站（防盗链站可能裂图）", "ok");
  });
  $("scrLowMem").addEventListener("change", function () {
    SCR.lowMem = !!this.checked;
    scrSaveDraft();
    toast(SCR.lowMem
      ? "已开启「低内存模式（迷你版）」：重新抓取页面后生效，Chromium 内存可省一半以上"
      : "已关闭「低内存模式」：重新抓取页面后恢复正常渲染", SCR.lowMem ? "ok" : "warn");
  });
  $("scrTimeout").addEventListener("change", function () {
    SCR.fetchTimeout = Math.max(5, Math.min(60, Number(this.value) || 30));
    this.value = SCR.fetchTimeout;
    scrSaveDraft();
  });
  $("scrRender").addEventListener("change", function () {
    SCR.render = !!this.checked;
    scrSyncRenderUI();
    scrSaveDraft();
    if (SCR.render) {
      toast(SCR.live
        ? "已开启浏览器渲染 + 交互模式：先在服务端渲染出完整 DOM，再保留脚本做交互"
        : "已开启浏览器渲染：抓取会慢几秒，但懒加载 / 滚动加载的站点才能采", "ok");
    }
  });
  // 交互模式（工具条按钮）：只有从静态页「进入网页」这一步才重新抓取；
  // 交互页上 浏览 ⇄ 点选 直接切换（点选由代理脚本接管），全程不刷新页面
  $("scrLiveBtn").addEventListener("click", function () {
    if (SCR.busy) return;
    if (SCR.interactive) {
      if (SCR.mode === "") {
        // 正在交互浏览 → 直接切回点选，不刷新
        SCR.live = false;               // 下次手动「抓取页面」回静态
        SCR.mode = "item";
        scrModeSet("item");
        toast("已切到「点选列表项」（页面保持交互，不刷新）", "ok");
      } else {
        // 在交互页上点选 → 切回浏览，不刷新
        SCR.mode = "";
        scrModeSet("");
        toast("回到交互浏览：可正常滚动 / 点击 / 播放", "ok");
      }
      scrSaveDraft();
      return;
    }
    // 静态页 → 进入交互网页：唯一需要重新抓取的入口
    SCR.live = true;
    SCR.mode = "";
    scrModeSet("");
    scrSaveDraft();
    toast("正在进入交互模式：站点脚本经本机代理执行，可正常滚动 / 点击", "ok");
    const u = (($("scrUrl") && $("scrUrl").value) || SCR.url || "").trim();
    if (u) scrFetchPage(u);
  });
  $("scrScrollTimes").addEventListener("change", function () {
    SCR.scrollTimes = Math.max(0, Math.min(20, Number(this.value) || 0));
    this.value = SCR.scrollTimes || "";
    scrSaveDraft();
  });
  $("scrMore").addEventListener("click", function () { scrLoadMore(); });
  $("scrUnhide").addEventListener("click", function () {
    if (!(SCR.hideSelectors || []).length) { toast("还没有隐藏过浮层", "warn"); return; }
    SCR.hideSelectors = [];
    scrSaveDraft();
    const fr = $("scrFrame");
    if (fr && SCR.previewUrl) {
      // 加个时间戳强制重新加载同一份预览，隐藏样式才会被清掉
      fr.src = SCR.previewUrl + (SCR.previewUrl.indexOf("?") >= 0 ? "&" : "?") + "_r=" + Date.now();
    }
    toast("已恢复所有浮层", "ok");
  });

  root.querySelectorAll("[data-scr-mode]").forEach(function (b) {
    b.addEventListener("click", function () { scrModeSet(b.dataset.scrMode); });
  });

  $("scrItemSel").addEventListener("input", function () {
    SCR.itemSel = this.value.trim();
    scrItemCountLocal();
    scrSaveDraft();
  });
  // 🔒 锁定列表项选择器：点选 / 自动识别不再改动
  $("scrItemLock").addEventListener("click", function () {
    SCR.itemLock = !SCR.itemLock;
    scrSyncLock();
    scrSaveDraft();
    toast(SCR.itemLock
      ? "已锁定列表项选择器：点选 / 自动识别都不会再改动它"
      : "已解锁：点选 / 自动识别可以重新选择列表项", SCR.itemLock ? "ok" : "warn");
  });
  $("scrGuess").addEventListener("click", scrGuessList);
  // 列表项调整条：扩大 / 缩小 / 确认 / 取消
  $("scrAdjUp").addEventListener("click", function () { scrAdjApply("up"); });
  $("scrAdjDown").addEventListener("click", function () { scrAdjApply("down"); });
  $("scrAdjOk").addEventListener("click", scrAdjConfirm);
  $("scrAdjNo").addEventListener("click", function () { scrAdjCancel(false); });
  // 代码生成悬浮框
  $("scrGenCode").addEventListener("click", scrCodeGenOpen);
  // 结果区高度：上下拖动调整（与底部面板分隔条同款逻辑，记到 localStorage）
  (function () {
    const sp = $("scrResizer");
    const res = $("scrResult");
    if (!sp || !res) return;
    let savedH = 0;
    try { savedH = Number(localStorage.getItem("ide.scraper.resH")) || 0; } catch (_) { }
    if (savedH >= 120) res.style.height = savedH + "px";
    let startY = 0, startH = 0, raf = 0, dragging = false;
    const apply = (h) => {
      res.style.height = Math.min(Math.max(120, h), Math.max(160, window.innerHeight * 0.75)) + "px";
    };
    const onMove = (e) => {
      if (!dragging) return;
      if (!(e.buttons & 1)) { onUp(); return; }   // 左键已松开（可能松在 iframe / 窗口外），立即结束拖动
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        apply(startH + (startY - e.clientY));     // 向上拖变高
      });
      e.preventDefault();
    };
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      sp.classList.remove("dragging");
      document.body.classList.remove("scr-resizing");
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      try { localStorage.setItem("ide.scraper.resH", String(Math.round(res.getBoundingClientRect().height))); } catch (_) { }
    };
    sp.addEventListener("mousedown", (e) => {
      e.preventDefault();
      dragging = true;
      startY = e.clientY;
      startH = res.getBoundingClientRect().height;
      sp.classList.add("dragging");
      document.body.classList.add("scr-resizing");
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
    sp.addEventListener("dblclick", () => {       // 双击恢复默认高度
      res.style.height = "";
      try { localStorage.removeItem("ide.scraper.resH"); } catch (_) { }
    });
  })();
  $("scrCodeGenLang").addEventListener("change", function () {
    SCR.genLang = this.value;
    scrCodeGenRender();
    if (SCR.genLang === "ai") scrCodeGenAiGenAsk();   // 选中 AI 选项：直接弹说明输入框
  });
  $("scrCodeGenClose").addEventListener("click", scrCodeGenClose);
  $("scrCodeGenCopy").addEventListener("click", scrCodeGenCopy);
  $("scrCodeGenDl").addEventListener("click", scrCodeGenDownloadAsk);
  $("scrCodeGenAi").addEventListener("click", scrCodeGenAiAsk);
  // AI 一句话输入弹层
  $("scrAiOk").addEventListener("click", scrAiPopGo);
  $("scrAiNo").addEventListener("click", function () { scrPopHide($("scrAiPop")); });
  $("scrAiInput").addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); scrAiPopGo(); }
    if (e.key === "Escape") scrPopHide($("scrAiPop"));
  });
  // 下载二次确认弹层
  $("scrDlOk").addEventListener("click", function () { scrPopHide($("scrDlPop")); scrCodeGenDownload(); });
  $("scrDlNo").addEventListener("click", function () { scrPopHide($("scrDlPop")); });
  // 取值规则弹层
  $("scrRulePopClose").addEventListener("click", scrRuleClose);
  $("scrRuleMulti").addEventListener("change", function () {
    const f = SCR.fields[SCR.ruleFi || 0];
    if (!f) return;
    f.multi = !!this.checked;
    scrRuleRefresh();
    scrSaveDraft();
  });
  $("scrRuleReAdd").addEventListener("click", function () {
    const f = SCR.fields[SCR.ruleFi || 0];
    if (!f) return;
    const find = $("scrRuleFind").value || "";
    if (!find.trim()) { toast("先填「查找」内容", "warn"); return; }
    f.replaces = f.replaces || [];
    f.replaces.push({ find: find, to: $("scrRuleTo").value || "", regex: !!$("scrRuleRe").checked });
    $("scrRuleFind").value = "";
    $("scrRuleTo").value = "";
    $("scrRuleRe").checked = false;
    scrRuleRefresh();
    scrSaveDraft();
  });
  $("scrRulePre").addEventListener("input", function () {
    const f = SCR.fields[SCR.ruleFi || 0];
    if (!f) return;
    f.prefix = this.value;
    scrRuleRefresh();
    scrSaveDraft();
  });
  $("scrRuleSuf").addEventListener("input", function () {
    const f = SCR.fields[SCR.ruleFi || 0];
    if (!f) return;
    f.suffix = this.value;
    scrRuleRefresh();
    scrSaveDraft();
  });
  $("scrRuleChips").addEventListener("click", function (e) {
    const x = e.target.closest("[data-ri]");
    if (!x) return;
    const f = SCR.fields[SCR.ruleFi || 0];
    if (!f || !f.replaces) return;
    f.replaces.splice(Number(x.dataset.ri), 1);
    scrRuleRefresh();
    scrSaveDraft();
  });
  // 点弹层外面自动收起
  if (!SCR.__ruleOutsideBound) {
    SCR.__ruleOutsideBound = true;
    document.addEventListener("mousedown", function (e) {
      const pop = $("scrRulePop");
      if (!pop || pop.hidden) return;
      const t = e.target;
      if (t && t.closest && (t.closest("#scrRulePop") || t.closest(".scr-frule"))) return;
      scrRuleClose();
    });
  }
  $("scrTest").addEventListener("click", function () {
    scrItemCountLocal(true);
  });
  $("scrAddField").addEventListener("click", function () {
    scrAddField({ name: "字段" + (SCR.fields.length + 1), selector: "", type: "text" });
  });

  // 字段列表：输入 / 下拉 / 删除（委托，避免每行单独绑）
  $("scrFieldList").addEventListener("input", function (e) {
    const box = e.target.closest("[data-fi]");
    if (!box) return;
    const i = Number(box.dataset.fi);
    const f = SCR.fields[i];
    if (!f) return;
    if (e.target.classList.contains("scr-fname")) f.name = e.target.value;
    else if (e.target.classList.contains("scr-fattr")) f.attr = e.target.value.trim();
    else if (e.target.classList.contains("scr-fsel")) {
      f.selector = e.target.value.trim();
      // 手改了选择器，另一种语法就对不上了：清掉，切语法时会提示需要手填
      if (scrIsXPath(f.selector)) { f.syntax = "xpath"; f.xpath = f.selector; f.css = ""; }
      else { f.syntax = "css"; f.css = f.selector; f.xpath = ""; }
      // 绝对 XPath（/html/...）在「每行」里都会指向同一个节点，采集出来会全一样
      if (/^\/(?!\/)/.test(f.selector)) {
        toast("绝对 XPath（/html/…）每行都会取到同一个节点，请改成 .// 开头（相对列表项）", "warn");
      }
    }
    scrSaveDraft();
  });
  $("scrFieldList").addEventListener("change", function (e) {
    const box = e.target.closest("[data-fi]");
    if (!box) return;
    const i = Number(box.dataset.fi);
    const f = SCR.fields[i];
    if (!f) return;
    if (e.target.classList.contains("scr-ftype")) {
      f.type = e.target.value;
      if (f.type === "attr" && !f.attr) f.attr = "href";
      scrRenderFields();
      scrSaveDraft();
    } else if (e.target.classList.contains("scr-fmulti")) {
      f.multi = !!e.target.checked;
      scrSaveDraft();
    }
  });
  /* 「多值」勾选框已并入「规则」弹层，此分支仅作旧草稿兼容 */
  $("scrFieldList").addEventListener("click", function (e) {
    const box = e.target.closest("[data-fi]");
    if (!box) return;
    const i = Number(box.dataset.fi);
    const f = SCR.fields[i];
    if (!f) return;

    // 取值规则弹层（替换 / 拼接 / 多值）
    if (e.target.closest(".scr-frule")) {
      scrRuleOpen(i);
      return;
    }
    if (e.target.closest(".scr-fdel")) {
      SCR.fields.splice(i, 1);
      scrRenderFields();
      scrSaveDraft();
      return;
    }
    // CSS ⇄ XPath 切换（缺少另一种写法时，按当前预览里的元素现场换算）
    if (e.target.closest(".scr-fsyn")) {
      const to = scrIsXPath(f.selector) ? "css" : "xpath";
      let target = to === "xpath" ? f.xpath : f.css;
      if (!target) {
        const doc = scrFrameDoc();
        if (doc) target = scrConvertField(f, to, doc);
        if (target) {
          if (to === "xpath") f.xpath = target; else f.css = target;
        }
      }
      if (!target) {
        toast("当前页面里定位不到这个字段，没法自动换算；可以直接粘贴 " +
          (to === "xpath" ? "XPath（用 .// 开头）" : "CSS 选择器"), "warn");
        return;
      }
      f.syntax = to;
      f.selector = target;
      scrRenderFields();
      scrSaveDraft();
      toast("已切换为 " + (to === "xpath" ? "XPath" : "CSS") + "：" + target, "ok");
      return;
    }
    // 查看元素（HTML / XPath / CSS）
    if (e.target.closest(".scr-fview")) {
      scrOpenViewer(f);
      return;
    }
  });

  $("scrPageMode").addEventListener("change", function () {
    SCR.pageMode = this.value;
    $("scrPageUrl").hidden = SCR.pageMode !== "url";
    $("scrPageNext").hidden = SCR.pageMode !== "next";
    if ($("scrPageScroll")) $("scrPageScroll").hidden = SCR.pageMode !== "scroll";
    if (SCR.pageMode === "scroll") {
      toast("滚动加载模式会自动启用浏览器渲染，采集会慢一些", "ok");
    }
    scrSaveDraft();
  });
  if ($("scrScrollLoops")) {
    $("scrScrollLoops").addEventListener("change", function () {
      SCR.scrollLoops = Math.max(1, Math.min(20, Number(this.value) || 6));
      this.value = SCR.scrollLoops;
      scrSaveDraft();
    });
  }
  $("scrUrlTpl").addEventListener("input", function () { SCR.urlTemplate = this.value.trim(); scrSaveDraft(); });
  $("scrNextSel").addEventListener("input", function () { SCR.nextSel = this.value.trim(); scrSaveDraft(); });
  $("scrPages").addEventListener("change", function () { SCR.pages = Math.max(1, Math.min(30, Number(this.value) || 1)); scrSaveDraft(); });
  $("scrPages2").addEventListener("change", function () { SCR.pages = Math.max(1, Math.min(30, Number(this.value) || 1)); scrSaveDraft(); });

  $("scrTaskName").addEventListener("input", function () { SCR.taskName = this.value.trim(); scrSaveDraft(); });
  $("scrSaveTask").addEventListener("click", scrSaveTask);
  $("scrRun").addEventListener("click", scrRun);
  $("scrPreviewBtn").addEventListener("click", function () { scrPreviewLocal(); });

  $("scrResultToggle").addEventListener("click", function () {
    SCR.resultMin = !SCR.resultMin;
    const box = $("scrResult");
    box.classList.toggle("min", SCR.resultMin);
    this.className = "bi " + (SCR.resultMin ? "bi-chevron-up" : "bi-chevron-down");
  });
  // 还没有采集数据时默认收起结果区（scrRenderResult 渲染出数据后会自动展开）
  if (!SCR.rows || !SCR.rows.length) {
    SCR.resultMin = true;
    $("scrResult").classList.add("min");
    $("scrResultToggle").className = "bi bi-chevron-up";
  }
  $("scrExpCsv").addEventListener("click", function () { scrExportAsk("csv"); });
  $("scrExpXlsx").addEventListener("click", function () { scrExportAsk("xlsx"); });
  $("scrExpJson").addEventListener("click", function () { scrExportAsk("json"); });
  // 导出二次确认弹层
  $("scrExpOk").addEventListener("click", function () {
    scrPopHide($("scrExpPop"));
    if (SCR.expFmt) scrExport(SCR.expFmt);
  });
  $("scrExpNo").addEventListener("click", function () { scrPopHide($("scrExpPop")); });
  if (!SCR.__expOutsideBound) {
    SCR.__expOutsideBound = true;
    document.addEventListener("mousedown", function (e) {
      const pop = $("scrExpPop");
      if (!pop || pop.hidden) return;
      const t = e.target;
      if (t && t.closest && (t.closest("#scrExpPop") || t.closest("#scrExpCsv") ||
        t.closest("#scrExpXlsx") || t.closest("#scrExpJson"))) return;
      scrPopHide(pop);
    });
  }
  // 结果表分页
  $("scrTableWrap").addEventListener("click", function (e) {
    const b = e.target.closest("[data-scr-page]");
    if (!b || b.disabled) return;
    const pages = Math.max(1, Math.ceil(SCR.rows.length / SCR_RES_PAGE));
    const a = b.dataset.scrPage;
    if (a === "first") SCR.resPage = 1;
    else if (a === "prev") SCR.resPage = Math.max(1, (SCR.resPage || 1) - 1);
    else if (a === "next") SCR.resPage = Math.min(pages, (SCR.resPage || 1) + 1);
    else if (a === "last") SCR.resPage = pages;
    else return;
    scrRenderResult(SCR.rows);
  });
  $("scrTableWrap").addEventListener("keydown", function (e) {
    if (!e.target || e.target.id !== "scrPagerJump" || e.key !== "Enter") return;
    const pages = Math.max(1, Math.ceil(SCR.rows.length / SCR_RES_PAGE));
    SCR.resPage = Math.min(pages, Math.max(1, Number(e.target.value) || 1));
    scrRenderResult(SCR.rows);
  });

  // ---- 结果筛选 ----
  $("scrFilterBtn").addEventListener("click", function () {
    const bar = $("scrFilterBar");
    bar.hidden = !bar.hidden;
    this.classList.toggle("on", !bar.hidden);
    if (!bar.hidden) {
      // 结果区被收起时先展开，否则筛选条刚打开就被 CSS 藏掉了
      if (SCR.resultMin) {
        SCR.resultMin = false;
        $("scrResult").classList.remove("min");
        if ($("scrResultToggle")) $("scrResultToggle").className = "bi bi-chevron-down";
      }
      scrFilterColsRefresh();
      scrRenderFilterChips();
    }
  });
  $("scrFAdd").addEventListener("click", scrAddFilter);
  $("scrFVal").addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); scrAddFilter(); }
  });
  $("scrFClear").addEventListener("click", function () {
    SCR.filters = [];
    SCR.filterNoEmpty = false;
    $("scrFNoEmpty").classList.remove("on");
    scrApplyFilters();
  });
  $("scrFNoEmpty").addEventListener("click", function () {
    SCR.filterNoEmpty = !SCR.filterNoEmpty;
    this.classList.toggle("on", SCR.filterNoEmpty);
    scrApplyFilters();
  });
  root.querySelectorAll("[data-fmode]").forEach(function (b) {
    b.addEventListener("click", function () {
      SCR.filterAnd = (b.dataset.fmode || "and") === "and";
      root.querySelectorAll("[data-fmode]").forEach(function (x) {
        x.classList.toggle("on", x === b);
      });
      scrApplyFilters();
    });
  });
  $("scrFChips").addEventListener("click", function (e) {
    const chip = e.target.closest(".scr-chip[data-fi]");
    if (!chip) return;
    SCR.filters.splice(Number(chip.dataset.fi), 1);
    scrApplyFilters();
  });

  // 元素树浮层：选节点 / 悬停高亮 / 写回字段 / 复制 / 关闭
  const vw = $("scrViewer");
  if (vw) {
    vw.addEventListener("click", function (e) {
      // 属性行「用」：直接把字段设成取这个属性（data-keys / data-id 这类）
      const attrBtn = e.target.closest("[data-attr]");
      if (attrBtn) {
        scrViewerUseAttr(attrBtn.dataset.attr || "");
        return;
      }
      const use = e.target.closest("[data-use]");
      if (use) {
        const kind = use.dataset.use;                    // xpath | css
        const f = SCR.viewerField;
        const val = kind === "xpath" ? SCR.viewerXp : SCR.viewerCss;
        if (!f || !val) { toast("先在左边树里选一个节点", "warn"); return; }
        f.syntax = kind;
        f.selector = val;
        if (kind === "xpath") f.xpath = val; else f.css = val;
        scrRenderFields();
        scrSaveDraft();
        vw.hidden = true;
        scrHover(null);
        toast("已应用 " + (kind === "xpath" ? "XPath" : "CSS") + "：" + val, "ok");
        return;
      }
      const cp = e.target.closest("[data-copy]");
      if (cp) {
        const v = cp.dataset.copy === "xp" ? (SCR.viewerXp || "") : (SCR.viewerCss || "");
        try {
          if (typeof copyText === "function") copyText(v);
          else navigator.clipboard.writeText(v);
        } catch (_) { }
        toast(v ? "已复制" : "先选一个节点", v ? "ok" : "warn");
        return;
      }
      if (e.target === vw || e.target.closest("#scrVwClose")) {
        vw.hidden = true;
        scrHover(null);
      }
    });

    const tree = $("scrVwTree");
    if (tree) {
      tree.addEventListener("click", function (e) {
        const row = e.target.closest(".scr-tnode");
        if (!row) return;
        if (SCR.interactive) { scrAgentSelectIndex(Number(row.dataset.i)); return; }
        const node = SCR.viewerNodes[Number(row.dataset.i)];
        if (node) { scrViewerSelect(node); scrHover(null); }
      });
      tree.addEventListener("mouseover", function (e) {
        const row = e.target.closest(".scr-tnode");
        if (!row) return;
        if (SCR.interactive) { scrAgentCall("hoverIndex", { index: Number(row.dataset.i) }, 1500); return; }
        const node = SCR.viewerNodes[Number(row.dataset.i)];
        if (node) scrHover(node);          // 在预览页里高亮对应元素
      });
      tree.addEventListener("mouseleave", function () {
        if (SCR.interactive) { scrAgentCall("hoverIndex", { index: -1 }, 1500); return; }
        scrHover(null);
      });
    }
  }

  // 侧栏面板 / 活动栏图标的绑定在文件末尾的 scrInit() 里做：
  // 那些元素不依赖工作台标签页，用户还没打开工作台时也要能点。
}

/* ---------------- 抓取页面 ---------------- */
function scrSetLoading(on, text) {
  const box = $("scrLoading");
  if (!box) return;
  box.classList.toggle("on", !!on);
  if (text) $("scrLoadingText").textContent = text;
}

function scrStat(text, cls) {
  const el = $("scrStat");
  if (!el) return;
  el.textContent = text || "";
  el.className = "scr-stat" + (cls ? " " + cls : "");
}

async function scrFetchPage(url) {
  url = (url || "").trim();
  if (!url) { toast("请先输入网址", "warn"); return; }
  if (SCR.busy) return;
  SCR.busy = true;
  scrSetLoading(true, "正在抓取页面…");
  scrStat("抓取中…");
  const d = await scrReq("/api/scraper/fetch", {
    url: url, ua: SCR.ua, cookie: SCR.cookie, insecure: SCR.insecure,
    timeout: SCR.fetchTimeout || 30, no_img: !!SCR.noImg, low_mem: !!SCR.lowMem,
    render: SCR.render, scroll_times: SCR.scrollTimes,
    // 交互预览：让后端保留并执行站点脚本、把所有资源改写成镜像代理地址
    live: !!SCR.live
  });
  SCR.busy = false;
  scrSetLoading(false);
  // 内存泄漏修复：旧预览文档马上要被换掉，SCR 里还攥着它的 DOM 节点
  // （元素树节点 / 选中节点 / 高亮节点）会把整棵旧页面树拖住没法回收，
  // 反复抓取 / 切换交互，内存就越占越多。这里全部置空，让旧文档能被回收。
  scrHover(null);
  SCR.viewerNodes = [];
  SCR.viewerRows = [];
  SCR.viewerSel = null;
  SCR.viewerRoot = null;
  SCR.viewerField = null;
  SCR.hlEl = null;
  if (!d || d.error) {
    scrStat("抓取失败：" + ((d && d.error) || "未知错误"), "bad");
    toast((d && d.error) || "抓取失败", "err");
    return;
  }
  SCR.url = url;
  SCR.pageUrl = d.url || url;
  SCR.pageTitle = d.title || "";
  SCR.rendered = !!d.rendered;
  SCR.interactive = !!d.interactive;
  $("scrUrl").value = url;

  // 切换站点：把上一个站点的选择器收好，再恢复 / 重置成当前站点的配置，
  // 否则会出现「页面已经是 v.qq.com，右侧还挂着 bilibili 的字段」这种串台状态。
  const host = scrHostOf(d.url || url);
  let siteRestored = false;
  let hadConfig = false;
  if (host && host !== SCR.siteKey) {
    hadConfig = !!(SCR.itemSel || (SCR.fields || []).length);
    scrStashSite();
    SCR.siteKey = host;
    SCR.rows = [];
    SCR.rowsAll = [];
    SCR.columns = [];
    // 采集方案、翻页配置都属于旧站点：不重置的话，点「开始采集」会跑去采旧站的 URL
    SCR.taskId = "";
    SCR.taskName = "";
    const saved = SCR.sites && SCR.sites[host];
    if (saved) {
      scrApplySite(saved);
      siteRestored = true;
    } else {
      SCR.itemSel = "";
      SCR.fields = [];
      SCR.hideSelectors = [];
      SCR.pageMode = "none";
      SCR.urlTemplate = "";
      SCR.nextSel = "";
      if ($("scrItemSel")) $("scrItemSel").value = "";
      scrRenderFields();
      scrRenderResult([], {});
      scrFilterColsRefresh();
      scrApplyDraftToInputs();
    }
  }
  if ($("scrSiteName")) $("scrSiteName").textContent = host || "";
  if (siteRestored) toast("已切到 " + host + "：载入该站点上次的选择器", "ok");
  else if (hadConfig) toast("已切到 " + host + "：上一个站点的选择器已清空", "warn");

  scrSyncRenderUI();
  scrStat((SCR.rendered ? "渲染抓取" : "已抓取") + " · " +
    (d.title ? d.title.slice(0, 36) + " · " : "") + scrSize(d.bytes) +
    " · " + d.cost_ms + " ms", "ok");

  const fr = $("scrFrame");
  const empty = $("scrEmpty");
  if (empty) empty.hidden = true;
  fr.onload = function () { scrAfterFrameLoad(); };
  // 交互预览：允许脚本执行，但**不给** allow-same-origin —— 文档变成不透明源，
  // 站点脚本读不到父页面 / 登录态，我们改用 postMessage 与代理脚本通信。
  // 静态模式也带上 allow-scripts：那份 HTML 里的脚本已经被清空了，加权限没有风险，
  // 但能避免「切换模式时 iframe 里还挂着上一份文档，sandbox 一收紧就刷
  // Blocked script execution … allow-scripts is not set」这种误导性报错。
  fr.setAttribute("sandbox", SCR.interactive
    ? "allow-scripts allow-forms allow-popups allow-modals"
    : "allow-same-origin allow-scripts allow-forms allow-popups allow-modals");
  if (SCR.interactive) {
    SCR.agentReady = false;
    setTimeout(function () {
      if (!SCR.agentReady && SCR.interactive) {
        toast("交互预览的代理脚本没就绪：页面可能被站点重定向或脚本被拦，点选暂时不可用", "warn");
      }
    }, 5000);
  }
  if (d.preview) {
    // 服务端出的预览页（真实 HTTP 文档）：图片走本地代理不会 403，
    // 也不会再出现 about:srcdoc 的沙箱脚本提示
    SCR.previewUrl = d.preview;
    fr.removeAttribute("srcdoc");
    fr.src = d.preview;
  } else if (d.html) {
    fr.srcdoc = d.html;          // 老后端兜底
  }
  scrSaveDraft();
}

/* 渲染模式相关控件状态：没有真实渲染过的页面，「滚动加载更多」是点不动的 */
function scrSyncRenderUI() {
  const more = $("scrMore");
  if (more) {
    more.disabled = !SCR.rendered;
    more.classList.toggle("on", !!SCR.rendered);
    more.title = SCR.rendered
      ? "让页面继续往下滚，触发懒加载 / 无限滚动"
      : "需先在「高级」里勾选「浏览器渲染（执行 JS）」再抓取页面";
  }
  if ($("scrScrollTimes")) $("scrScrollTimes").disabled = !SCR.render;
  if ($("scrRender")) $("scrRender").checked = !!SCR.render;
}

/* 滚动加载更多：让服务端那个还开着的无头浏览器继续往下滚，再把新 DOM 换回来 */
async function scrLoadMore() {
  if (SCR.busy) return;
  if (!SCR.rendered) {
    toast("当前是静态抓取：请在「高级」里勾选「浏览器渲染（执行 JS）」后重新抓取", "warn");
    return;
  }
  const token = String(SCR.previewUrl || "").split("?")[0].split("/").pop();
  if (!token) { toast("先抓取页面", "warn"); return; }
  const doc = scrFrameDoc();
  let y = 0;
  try {
    y = doc ? ((doc.scrollingElement || doc.body || {}).scrollTop || 0) : 0;
  } catch (_) { y = 0; }
  SCR.busy = true;
  scrSetLoading(true, "正在往下滚动，等待新内容加载…");
  if ($("scrMore")) $("scrMore").disabled = true;
  const d = await scrReq("/api/scraper/scroll", { token: token, times: 3, delay: 1.2 });
  SCR.busy = false;
  scrSetLoading(false);
  scrSyncRenderUI();
  if (!d || d.error) { toast((d && d.error) || "滚动加载失败", "err"); return; }
  SCR.previewUrl = d.preview;
  SCR.pendingScrollY = Number(d.scroll_y) || y;   // 换文档后回到原来的位置，别一滚就跳回顶部
  $("scrFrame").src = d.preview;
  toast("已加载更多内容（多滚 3 屏）", "ok");
}

function scrAfterFrameLoad() {
  if (SCR.interactive) {
    // 交互预览是跨源沙箱，DOM 读不到；点选 / 高亮 / 树都由代理脚本负责，
    // 这里等它 postMessage 过来的 ready 再把当前模式和隐藏规则下发
    return;
  }
  const doc = scrFrameDoc();
  if (!doc) return;
  // 预览缓存会过期（服务重启 / 超过 30 分钟），后端这时回的是 JSON 错误页
  const txt = ((doc.body && doc.body.textContent) || "").trim();
  if (txt.length < 200 && /^\{"error"/.test(txt)) {
    scrStat("预览已过期，请重新抓取页面", "bad");
    toast("预览已过期，点「抓取页面」重新加载", "warn");
    return;
  }
  scrInjectStyle(doc);
  scrBindPick(doc);
  scrApplyHidden(doc);          // 之前清掉的广告 / 弹窗，换文档后继续隐藏
  scrItemCountLocal();
  // 新文档要重新贴上「点选中」的指针状态，否则抓完页面回来十字光标就没了
  if (doc.body) {
    doc.body.classList.toggle("scr-picking", !!SCR.mode);
    doc.body.classList.toggle("scr-cleaning", SCR.mode === "clean");
  }
  // 「滚动加载更多」会换一份新文档：把滚动位置还原回去，别让用户一下子回到顶部
  if (SCR.pendingScrollY != null) {
    const y = SCR.pendingScrollY;
    SCR.pendingScrollY = null;
    setTimeout(function () {
      try {
        const fr = $("scrFrame");
        if (fr && fr.contentWindow) fr.contentWindow.scrollTo(0, y);
        if (doc.scrollingElement) doc.scrollingElement.scrollTop = y;
      } catch (_) { }
    }, 120);
  }
  scrSyncRenderUI();
}

function scrFrameDoc() {
  const fr = $("scrFrame");
  if (!fr) return null;
  try { return fr.contentDocument || (fr.contentWindow && fr.contentWindow.document) || null; } catch (_) { return null; }
}

/* ---------------- 点选：高亮 + 选择器生成 ---------------- */
function scrInjectStyle(doc) {
  if (doc.getElementById("scr-pick-style")) return;
  const st = doc.createElement("style");
  st.id = "scr-pick-style";
  st.textContent = [
    ".scr-hover{outline:2px solid #38bdf8 !important;outline-offset:-2px;",
    "background:rgba(56,189,248,.12) !important;cursor:crosshair !important;}",
    ".scr-picked{outline:3px dashed #f59e0b !important;outline-offset:-2px;}",
    ".scr-match{outline:2px dashed rgba(56,189,248,.9) !important;outline-offset:-2px;}",
    // 只有进入点选模式才把整页指针改成十字，浏览模式下还是正常指针
    "body.scr-picking,body.scr-picking *{cursor:crosshair !important;}",
    // 清浮层模式：悬停框改成红色，表示「点一下就删掉」
    "body.scr-cleaning .scr-hover{outline-color:#ef4444 !important;",
    "background:rgba(239,68,68,.14) !important;}",
  ].join("");
  (doc.head || doc.documentElement).appendChild(st);
}

function scrBindPick(doc) {
  if (!doc || doc.__scrBound) return;
  doc.__scrBound = true;

  doc.addEventListener("mouseover", function (e) {
    if (!SCR.mode) return;
    const el = e.target;
    if (!el || el.nodeType !== 1) return;
    if (/^(HTML|BODY)$/.test(el.tagName)) return;
    scrHover(el);
  }, true);

  doc.addEventListener("mouseleave", function () { scrHover(null); }, true);

  doc.addEventListener("click", function (e) {
    // 预览里永远不跳转：点链接会把当前页面冲掉，采集就没得点了
    const a = e.target && e.target.closest ? e.target.closest("a") : null;
    if (a) e.preventDefault();
    if (!SCR.mode) return;
    const el = e.target;
    if (!el || el.nodeType !== 1) return;
    if (/^(HTML|BODY)$/.test(el.tagName)) return;
    e.preventDefault();
    e.stopPropagation();
    if (SCR.mode === "item") scrPickItem(el, doc);
    else if (SCR.mode === "field") scrPickField(el, doc);
    else if (SCR.mode === "clean") scrHideEl(el, doc);
  }, true);
}

function scrHover(el) {
  if (SCR.hlEl === el) return;
  if (SCR.hlEl) { try { SCR.hlEl.classList.remove("scr-hover"); } catch (_) { } }
  SCR.hlEl = el;
  if (el) { try { el.classList.add("scr-hover"); } catch (_) { } }
}

function scrClassOk(c) {
  // 点选时自己加的临时类（scr-hover / scr-picked / scr-match / 挂在 body 上的 scr-picking）
  // 不能进选择器，否则生成出来的是 body.scr-picking > div…，换页就匹配不到了
  return /^[A-Za-z_][\w-]*$/.test(c) && !/^scr-/.test(c);
}

/* 单个层级的选择器片段：能用类名就用类名，否则退回 nth-of-type */
function scrSeg(el) {
  const tag = el.tagName.toLowerCase();
  // 有干净的 id 就优先用 id：路径最短，也不受兄弟节点增减影响
  const id = el.id && /^[A-Za-z][\w-]*$/.test(el.id) ? el.id : "";
  if (id) {
    try {
      if ((el.ownerDocument || document).querySelectorAll("#" + id).length === 1) return "#" + id;
    } catch (_) { }
  }
  const cls = Array.prototype.slice.call(el.classList || []).filter(scrClassOk).slice(0, 2);
  if (cls.length) {
    const sel = tag + "." + cls.join(".");
    const parent = el.parentElement;
    if (parent) {
      try {
        if (parent.querySelectorAll(sel).length === 1) return sel;
      } catch (_) { }
    }
  }
  const parent = el.parentElement;
  let idx = 1;
  if (parent) {
    const sibs = Array.prototype.filter.call(parent.children, function (x) { return x.tagName === el.tagName; });
    idx = Math.max(1, sibs.indexOf(el) + 1);
  }
  return tag + ":nth-of-type(" + idx + ")";
}

/* 字段选择器：相对列表项（root）的路径 */
function scrRelSel(el, root) {
  if (!root) return scrAbsPath(el);
  const parts = [];
  let cur = el;
  let guard = 0;
  while (cur && cur !== root && cur.nodeType === 1 && guard++ < 12) {
    parts.unshift(scrSeg(cur));
    cur = cur.parentElement;
  }
  if (cur !== root) return scrAbsPath(el);      // 不在列表项里 → 退回绝对路径
  return parts.length ? parts.join(" > ") : ".";
}

/* 绝对路径（从文档根往下，逐层 nth-of-type） */
function scrAbsPath(el) {
  const parts = [];
  let cur = el;
  let guard = 0;
  while (cur && cur.nodeType === 1 && cur !== document.documentElement && guard++ < 20) {
    const tag = cur.tagName.toLowerCase();
    if (tag === "html" || tag === "body") break;   // body 只用来定位，不进选择器
    parts.unshift(scrSeg(cur));
    cur = cur.parentElement;
  }
  return parts.join(" > ");
}

/* 列表项选择器：优先「会重复出现的类名」，其次允许的重复标签，最后退回绝对路径 */
function scrItemSelOf(el, doc) {
  const allowBare = ["li", "tr", "article", "dd", "dt", "figure", "section", "option"];
  let cur = el;
  let fallback = "";
  let guard = 0;
  while (cur && cur.nodeType === 1 && cur !== doc.documentElement && guard++ < 7) {
    const tag = cur.tagName.toLowerCase();
    if (tag === "body" || tag === "html") break;
    const cls = Array.prototype.slice.call(cur.classList || []).filter(scrClassOk).slice(0, 2);
    if (cls.length) {
      const cand = tag + "." + cls.join(".");
      let n = 0;
      try { n = doc.querySelectorAll(cand).length; } catch (_) { n = 0; }
      if (n >= 2) return cand;
      if (n === 1 && !fallback) fallback = cand;
    } else if (allowBare.indexOf(tag) >= 0) {
      let n = 0;
      try { n = doc.querySelectorAll(tag).length; } catch (_) { n = 0; }
      if (n >= 2) return tag;
    }
    cur = cur.parentElement;
  }
  return fallback || scrAbsPath(el);
}

function scrPickItem(el, doc) {
  if (SCR.itemLock) { toast("列表项选择器已锁定（点 🔒 解锁后再选）", "warn"); return; }
  // 不直接保存：先进「调整」状态，调整条上可扩大 / 缩小，确认才生效
  SCR.adjEl = el; SCR.adjDoc = doc; SCR.adjStack = [el];
  scrAdjUpdate(scrItemSelOf(el, doc), doc);
}

/* ---------------- 列表项调整条（点选后先预览，扩大 / 缩小，确认才保存） ---------------- */
function scrNodesBySel(sel, doc) {
  const s = String(sel || "").trim();
  if (!s || !doc) return [];
  if (scrIsXPath(s)) {
    const res = scrEvalXPath(doc, doc, s);
    const arr = Array.isArray(res) ? res : (res ? [res] : []);
    return arr.filter(function (n) { return n && n.nodeType === 1; });
  }
  try { return Array.prototype.slice.call(doc.querySelectorAll(s)); } catch (_) { return []; }
}

/* 刷新调整条与候选命中高亮；交互模式 doc 传 null（高亮由代理脚本负责，匹配数走 knownCount） */
function scrAdjUpdate(sel, doc, knownCount) {
  SCR.adjSel = sel || "";
  let n = (typeof knownCount === "number") ? knownCount : 0;
  if (doc) {
    const nodes = scrNodesBySel(sel, doc);
    n = nodes.length;
    try {
      doc.querySelectorAll(".scr-match").forEach(function (x) { x.classList.remove("scr-match"); });
      nodes.slice(0, 200).forEach(function (x) { x.classList.add("scr-match"); });
    } catch (_) { }
  }
  const bar = $("scrAdjbar");
  if (bar) bar.hidden = false;
  const selBox = $("scrAdjSel");
  if (selBox) { selBox.textContent = SCR.adjSel; selBox.title = SCR.adjSel; }
  const cnt = $("scrAdjCount");
  if (cnt) {
    cnt.textContent = "匹配 " + n + " 项";
    cnt.className = "scr-badge" + (n ? " ok" : " bad");
  }
}

function scrAdjApply(dir) {
  if (SCR.interactive) {
    if (!SCR.adjSel) { toast("先在页面上点选列表项", "warn"); return; }
    scrAgentCall("adjItem", { dir: dir });   // 代理脚本在 iframe 里调，回传 pending picked
    return;
  }
  if (!SCR.adjEl || !SCR.adjDoc) { toast("先在页面上点选列表项", "warn"); return; }
  if (dir === "up") {
    const p = SCR.adjEl.parentElement;
    if (!p || /^(HTML|BODY)$/.test(p.tagName)) { toast("已经到最外层了", "warn"); return; }
    SCR.adjStack.push(p); SCR.adjEl = p;
  } else {
    if (SCR.adjStack.length <= 1) { toast("已经是最初点选的元素了", "warn"); return; }
    SCR.adjStack.pop(); SCR.adjEl = SCR.adjStack[SCR.adjStack.length - 1];
  }
  scrAdjUpdate(scrItemSelOf(SCR.adjEl, SCR.adjDoc), SCR.adjDoc);
}

function scrAdjConfirm() {
  const sel = SCR.adjSel || "";
  if (!sel) { toast("先在页面上点选列表项", "warn"); return; }
  SCR.itemSel = sel;
  if ($("scrItemSel")) $("scrItemSel").value = sel;
  SCR.adjEl = null; SCR.adjDoc = null; SCR.adjStack = []; SCR.adjSel = "";
  const bar = $("scrAdjbar"); if (bar) bar.hidden = true;
  scrSaveDraft();
  if (SCR.interactive) {
    scrAgentCall("adjConfirm");   // 清掉调整状态，保留命中高亮
    scrAgentCount();
  } else {
    scrItemCountLocal();
  }
  // 确认后自动切到「点字段」，省一次点击
  if (SCR.mode === "item") scrModeSet("field");
  toast("已选中列表项：" + sel, "ok");
}

function scrAdjCancel(silent) {
  const had = !!(SCR.adjEl || SCR.adjSel);
  SCR.adjEl = null; SCR.adjDoc = null; SCR.adjStack = []; SCR.adjSel = "";
  const bar = $("scrAdjbar"); if (bar) bar.hidden = true;
  if (!had) return;
  if (SCR.interactive) {
    scrAgentCall("adjClear");     // 清掉候选高亮
    scrAgentCount();              // 按已保存的选择器重新框
  } else {
    const doc = scrFrameDoc();
    if (doc && !SCR.itemSel) {
      try { doc.querySelectorAll(".scr-match").forEach(function (x) { x.classList.remove("scr-match"); }); } catch (_) { }
    }
    scrItemCountLocal();
  }
  if (!silent) toast("已取消本次选择", "warn");
}

/* ---------------- 生成采集代码（Python / Node / 浏览器 JS，可交给 AI 优化） ---------------- */
function scrCodeGenOpen() {
  if (!SCR.itemSel) { toast("先点选列表项，再生成代码", "warn"); return; }
  if (!(SCR.fields || []).length) { toast("先添加至少一个字段，再生成代码", "warn"); return; }
  const m = $("scrCodeGen");
  if (!m) return;
  m.hidden = false;
  const sel = $("scrCodeGenLang");
  if (sel && SCR.genLang) sel.value = SCR.genLang;
  scrCodeGenRender();
}

function scrCodeGenClose() {
  const m = $("scrCodeGen");
  if (m) m.hidden = true;
  scrPopHide($("scrAiPop"));
  scrPopHide($("scrDlPop"));
  if (SCR.genAbort) { try { SCR.genAbort.abort(); } catch (_) { } SCR.genAbort = null; }
}

function scrPopHide(pop) { if (pop) pop.hidden = true; }

function scrGenFields() {
  return (SCR.fields || []).map(function (f, i) {
    return {
      name: f.name || ("字段" + (i + 1)),
      sel: f.selector || "",
      type: f.type || "text",
      attr: f.attr || "href",
      multi: !!f.multi,
    };
  });
}

function scrGenMeta() {
  return {
    url: SCR.pageUrl || SCR.url || "",
    pageMode: SCR.pageMode === "url" ? "url" : (SCR.pageMode === "next" ? "next" : "none"),
    tpl: SCR.urlTemplate || "",
    nextSel: SCR.nextSel || 'a[rel="next"]',
    pages: Math.max(1, Number(SCR.pages) || 1),
    delay: Math.max(0, Number(SCR.delay) || 0),
    ua: SCR.ua || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    cookie: SCR.cookie || "",
  };
}

/* Python · requests + parsel（CSS / XPath 通用，含 URL 模板 / 下一页翻页 + CSV 导出） */
function scrGenPy() {
  const m = scrGenMeta(), q = JSON.stringify;
  const fld = scrGenFields().map(function (f) {
    return "    (" + q(f.name) + ", " + q(f.sel) + ", " + q(f.type) + ", " + q(f.attr) + ", " + (f.multi ? "True" : "False") + "),";
  }).join("\n");
  const L = [
    '# -*- coding: utf-8 -*-',
    '"""自动生成的采集脚本（可视化采集配置导出）',
    '',
    '用法：pip install requests parsel  →  python scraper.py',
    '"""',
    'import csv',
    'import time',
    'from urllib.parse import urljoin',
    '',
    'import requests',
    'from parsel import Selector',
    '',
    'URL = ' + q(m.url),
    '',
    'HEADERS = {',
    '    "User-Agent": ' + q(m.ua) + ',',
    '    "Accept-Language": "zh-CN,zh;q=0.9",',
    m.cookie ? '    "Cookie": ' + q(m.cookie) + ',' : '    # 需要登录态时在这里加 "Cookie": "..."',
    '}',
    '',
    'ITEM_SEL = ' + q(SCR.itemSel) + '        # 列表项（CSS 或 XPath 均可）',
    'FIELDS = [                 # (字段名, 选择器, text/html/attr, 属性名, 是否多值)',
    fld,
    ']',
    'PAGE_MODE = ' + q(m.pageMode) + '      # none=单页 / url=URL模板翻页 / next=下一页链接',
    'URL_TEMPLATE = ' + q(m.tpl) + '        # PAGE_MODE == "url" 时用，{page} 是页码占位',
    'NEXT_SEL = ' + q(m.nextSel) + '        # PAGE_MODE == "next" 时用',
    'PAGES = ' + m.pages,
    'DELAY = ' + (m.delay / 1000) + '            # 每页间隔秒数，别把站点打挂',
    'OUT_CSV = "data.csv"',
    '',
    '',
    'def pick(scope, s):',
    '    """按选择器取元素：/ 或 // 开头按 XPath，其余按 CSS"""',
    '    s = (s or "").strip()',
    '    if s[:1] == "/" or s[:3] == "(//":',
    '        return scope.xpath(s)',
    '    return scope.css(s)',
    '',
    '',
    'def get_val(node, how, attr):',
    '    if node is None:',
    '        return ""',
    '    if how == "html":',
    '        return node.get() or ""',
    '    if how == "attr":',
    '        return node.attrib.get(attr, "") or ""',
    '    return node.xpath("normalize-space(.)").get() or ""',
    '',
    '',
    'def parse(html):',
    '    sel = Selector(text=html)',
    '    rows = []',
    '    for card in pick(sel, ITEM_SEL):',
    '        row = {}',
    '        for name, s, how, attr, multi in FIELDS:',
    '            nodes = pick(card, s) if s else card',
    '            if multi:',
    '                vals = [get_val(n, how, attr) for n in nodes]',
    '                row[name] = " | ".join(v for v in vals if v)',
    '            else:',
    '                row[name] = get_val(nodes[0] if len(nodes) else None, how, attr)',
    '        rows.append(row)',
    '    return rows',
    '',
    '',
    'def fetch(url):',
    '    try:',
    '        r = requests.get(url, headers=HEADERS, timeout=15)',
    '        r.raise_for_status()',
    '        return r.text',
    '    except Exception as e:',
    '        print("请求失败", url, e)',
    '        return ""',
    '',
    '',
    'def next_link(html, base):',
    '    sel = Selector(text=html)',
    '    for a in (pick(sel, NEXT_SEL) if NEXT_SEL else []):',
    '        href = a.attrib.get("href")',
    '        if href:',
    '            return urljoin(base, href)',
    '    return None',
    '',
    '',
    'def main():',
    '    rows = []',
    '    if PAGE_MODE == "url":',
    '        for page in range(1, PAGES + 1):',
    '            u = URL_TEMPLATE.format(page=page) if "{page}" in URL_TEMPLATE else URL_TEMPLATE',
    '            print("抓取", u)',
    '            html = fetch(u)',
    '            if html:',
    '                rows += parse(html)',
    '            time.sleep(DELAY)',
    '    elif PAGE_MODE == "next":',
    '        u = URL',
    '        for _ in range(PAGES):',
    '            print("抓取", u)',
    '            html = fetch(u)',
    '            if not html:',
    '                break',
    '            rows += parse(html)',
    '            u = next_link(html, u)',
    '            if not u:',
    '                break',
    '            time.sleep(DELAY)',
    '    else:',
    '        print("抓取", URL)',
    '        html = fetch(URL)',
    '        if html:',
    '            rows += parse(html)',
    '',
    '    with open(OUT_CSV, "w", newline="", encoding="utf-8-sig") as f:',
    '        w = csv.DictWriter(f, fieldnames=[n for n, *_ in FIELDS])',
    '        w.writeheader()',
    '        w.writerows(rows)',
    '    print("完成：", len(rows), "行 ->", OUT_CSV)',
    '',
    '',
    'if __name__ == "__main__":',
    '    main()',
  ];
  if (SCR.pageMode === "scroll") {
    L.splice(4, 0, '注意：站点是「滚动加载」，本脚本只能采到首屏；懒加载内容请改用 Playwright 渲染。');
  }
  return L.join("\n");
}

/* Python · requests + BeautifulSoup（仅 CSS 选择器） */
function scrGenPyBs4() {
  const m = scrGenMeta(), q = JSON.stringify;
  const fld = scrGenFields().map(function (f) {
    return "    (" + q(f.name) + ", " + q(f.sel) + ", " + q(f.type) + ", " + q(f.attr) + ", " + (f.multi ? "True" : "False") + "),";
  }).join("\n");
  const L = [
    '# -*- coding: utf-8 -*-',
    '"""自动生成的采集脚本（可视化采集配置导出）',
    '',
    '用法：pip install requests beautifulsoup4  →  python scraper.py',
    '注意：BeautifulSoup 只支持 CSS 选择器；XPath 字段请改写成 CSS（或用 lxml 版）',
    '"""',
    'import csv',
    'import time',
    'from urllib.parse import urljoin',
    '',
    'import requests',
    'from bs4 import BeautifulSoup',
    '',
    'URL = ' + q(m.url),
    '',
    'HEADERS = {',
    '    "User-Agent": ' + q(m.ua) + ',',
    '    "Accept-Language": "zh-CN,zh;q=0.9",',
    m.cookie ? '    "Cookie": ' + q(m.cookie) + ',' : '    # 需要登录态时在这里加 "Cookie": "..."',
    '}',
    '',
    'ITEM_SEL = ' + q(SCR.itemSel) + '        # 列表项（CSS）',
    'FIELDS = [                 # (字段名, CSS选择器, text/html/attr, 属性名, 是否多值)',
    fld,
    ']',
    'PAGE_MODE = ' + q(m.pageMode) + '      # none=单页 / url=URL模板翻页 / next=下一页链接',
    'URL_TEMPLATE = ' + q(m.tpl) + '        # PAGE_MODE == "url" 时用，{page} 是页码占位',
    'NEXT_SEL = ' + q(m.nextSel) + '        # PAGE_MODE == "next" 时用',
    'PAGES = ' + m.pages,
    'DELAY = ' + (m.delay / 1000) + '            # 每页间隔秒数，别把站点打挂',
    'OUT_CSV = "data.csv"',
    '',
    '',
    'def get_val(node, how, attr):',
    '    if node is None:',
    '        return ""',
    '    if how == "html":',
    '        return str(node)',
    '    if how == "attr":',
    '        return node.get(attr, "") or ""',
    '    return node.get_text(" ", strip=True)',
    '',
    '',
    'def parse(html):',
    '    soup = BeautifulSoup(html, "html.parser")',
    '    rows = []',
    '    for card in soup.select(ITEM_SEL):',
    '        row = {}',
    '        for name, s, how, attr, multi in FIELDS:',
    '            try:',
    '                nodes = card.select(s) if s else [card]',
    '            except Exception:',
    '                nodes = []',
    '            if multi:',
    '                vals = [get_val(n, how, attr) for n in nodes]',
    '                row[name] = " | ".join(v for v in vals if v)',
    '            else:',
    '                row[name] = get_val(nodes[0] if nodes else None, how, attr)',
    '        rows.append(row)',
    '    return rows',
    '',
    '',
    'def fetch(url):',
    '    try:',
    '        r = requests.get(url, headers=HEADERS, timeout=15)',
    '        r.raise_for_status()',
    '        return r.text',
    '    except Exception as e:',
    '        print("请求失败", url, e)',
    '        return ""',
    '',
    '',
    'def next_link(html, base):',
    '    soup = BeautifulSoup(html, "html.parser")',
    '    for a in soup.select(NEXT_SEL) if NEXT_SEL else []:',
    '        href = a.get("href")',
    '        if href:',
    '            return urljoin(base, href)',
    '    return None',
    '',
    '',
    'def main():',
    '    rows = []',
    '    if PAGE_MODE == "url":',
    '        for page in range(1, PAGES + 1):',
    '            u = URL_TEMPLATE.format(page=page) if "{page}" in URL_TEMPLATE else URL_TEMPLATE',
    '            print("抓取", u)',
    '            html = fetch(u)',
    '            if html:',
    '                rows += parse(html)',
    '            time.sleep(DELAY)',
    '    elif PAGE_MODE == "next":',
    '        u = URL',
    '        for _ in range(PAGES):',
    '            print("抓取", u)',
    '            html = fetch(u)',
    '            if not html:',
    '                break',
    '            rows += parse(html)',
    '            u = next_link(html, u)',
    '            if not u:',
    '                break',
    '            time.sleep(DELAY)',
    '    else:',
    '        print("抓取", URL)',
    '        html = fetch(URL)',
    '        if html:',
    '            rows += parse(html)',
    '',
    '    with open(OUT_CSV, "w", newline="", encoding="utf-8-sig") as f:',
    '        w = csv.DictWriter(f, fieldnames=[n for n, *_ in FIELDS])',
    '        w.writeheader()',
    '        w.writerows(rows)',
    '    print("完成：", len(rows), "行 ->", OUT_CSV)',
    '',
    '',
    'if __name__ == "__main__":',
    '    main()',
  ];
  if (SCR.pageMode === "scroll") {
    L.splice(5, 0, '注意：站点是「滚动加载」，本脚本只能采到首屏；懒加载内容请改用 Playwright 渲染。');
  }
  return L.join("\n");
}

/* Python · requests + lxml（支持 XPath，也兼容 CSS） */
function scrGenPyLxml() {
  const m = scrGenMeta(), q = JSON.stringify;
  const fld = scrGenFields().map(function (f) {
    return "    (" + q(f.name) + ", " + q(f.sel) + ", " + q(f.type) + ", " + q(f.attr) + ", " + (f.multi ? "True" : "False") + "),";
  }).join("\n");
  const L = [
    '# -*- coding: utf-8 -*-',
    '"""自动生成的采集脚本（可视化采集配置导出）',
    '',
    '用法：pip install requests lxml  →  python scraper.py',
    '支持 XPath（/ 或 // 开头）与 CSS 选择器，速度快、内存省。',
    '"""',
    'import csv',
    'import time',
    'from urllib.parse import urljoin',
    '',
    'import requests',
    'from lxml import html as lhtml',
    '',
    'URL = ' + q(m.url),
    '',
    'HEADERS = {',
    '    "User-Agent": ' + q(m.ua) + ',',
    '    "Accept-Language": "zh-CN,zh;q=0.9",',
    m.cookie ? '    "Cookie": ' + q(m.cookie) + ',' : '    # 需要登录态时在这里加 "Cookie": "..."',
    '}',
    '',
    'ITEM_SEL = ' + q(SCR.itemSel) + '        # 列表项（CSS 或 XPath 均可）',
    'FIELDS = [                 # (字段名, 选择器, text/html/attr, 属性名, 是否多值)',
    fld,
    ']',
    'PAGE_MODE = ' + q(m.pageMode) + '      # none=单页 / url=URL模板翻页 / next=下一页链接',
    'URL_TEMPLATE = ' + q(m.tpl) + '        # PAGE_MODE == "url" 时用，{page} 是页码占位',
    'NEXT_SEL = ' + q(m.nextSel) + '        # PAGE_MODE == "next" 时用',
    'PAGES = ' + m.pages,
    'DELAY = ' + (m.delay / 1000) + '            # 每页间隔秒数，别把站点打挂',
    'OUT_CSV = "data.csv"',
    '',
    '',
    'def pick(scope, s):',
    '    """按选择器取元素：/ 或 // 开头按 XPath，其余按 CSS（cssselect 随 lxml 一起装好）"""',
    '    s = (s or "").strip()',
    '    if s[:1] == "/" or s[:3] == "(//":',
    '        return scope.xpath(s)',
    '    return scope.cssselect(s)',
    '',
    '',
    'def get_val(node, how, attr):',
    '    if node is None:',
    '        return ""',
    '    if how == "html":',
    '        return lhtml.tostring(node, encoding="unicode")',
    '    if how == "attr":',
    '        return node.get(attr, "") or ""',
    '    return " ".join(node.text_content().split())',
    '',
    '',
    'def parse(text):',
    '    doc = lhtml.fromstring(text)',
    '    rows = []',
    '    for card in pick(doc, ITEM_SEL):',
    '        row = {}',
    '        for name, s, how, attr, multi in FIELDS:',
    '            try:',
    '                nodes = pick(card, s) if s else [card]',
    '            except Exception:',
    '                nodes = []',
    '            if multi:',
    '                vals = [get_val(n, how, attr) for n in nodes]',
    '                row[name] = " | ".join(v for v in vals if v)',
    '            else:',
    '                row[name] = get_val(nodes[0] if nodes else None, how, attr)',
    '        rows.append(row)',
    '    return rows',
    '',
    '',
    'def fetch(url):',
    '    try:',
    '        r = requests.get(url, headers=HEADERS, timeout=15)',
    '        r.raise_for_status()',
    '        return r.text',
    '    except Exception as e:',
    '        print("请求失败", url, e)',
    '        return ""',
    '',
    '',
    'def next_link(text, base):',
    '    doc = lhtml.fromstring(text)',
    '    for a in (pick(doc, NEXT_SEL) if NEXT_SEL else []):',
    '        href = a.get("href")',
    '        if href:',
    '            return urljoin(base, href)',
    '    return None',
    '',
    '',
    'def main():',
    '    rows = []',
    '    if PAGE_MODE == "url":',
    '        for page in range(1, PAGES + 1):',
    '            u = URL_TEMPLATE.format(page=page) if "{page}" in URL_TEMPLATE else URL_TEMPLATE',
    '            print("抓取", u)',
    '            text = fetch(u)',
    '            if text:',
    '                rows += parse(text)',
    '            time.sleep(DELAY)',
    '    elif PAGE_MODE == "next":',
    '        u = URL',
    '        for _ in range(PAGES):',
    '            print("抓取", u)',
    '            text = fetch(u)',
    '            if not text:',
    '                break',
    '            rows += parse(text)',
    '            u = next_link(text, u)',
    '            if not u:',
    '                break',
    '            time.sleep(DELAY)',
    '    else:',
    '        print("抓取", URL)',
    '        text = fetch(URL)',
    '        if text:',
    '            rows += parse(text)',
    '',
    '    with open(OUT_CSV, "w", newline="", encoding="utf-8-sig") as f:',
    '        w = csv.DictWriter(f, fieldnames=[n for n, *_ in FIELDS])',
    '        w.writeheader()',
    '        w.writerows(rows)',
    '    print("完成：", len(rows), "行 ->", OUT_CSV)',
    '',
    '',
    'if __name__ == "__main__":',
    '    main()',
  ];
  if (SCR.pageMode === "scroll") {
    L.splice(5, 0, '注意：站点是「滚动加载」，本脚本只能采到首屏；懒加载内容请改用 Playwright 渲染。');
  }
  return L.join("\n");
}

/* Go · net/http + goquery（仅 CSS 选择器，编译成单文件跑得快） */
function scrGenGo() {
  const m = scrGenMeta(), q = JSON.stringify;
  const fld = scrGenFields().map(function (f) {
    return '\t{"' + f.name + '", ' + q(f.sel) + ', ' + q(f.type) + ', ' + q(f.attr) + ', ' + f.multi + '},';
  }).join("\n");
  return [
    '/**',
    ' * 自动生成的采集脚本（可视化采集配置导出）',
    ' * 用法：go mod init scraper && go get github.com/PuerkitoBio/goquery && go run scraper.go',
    ' * 注意：goquery 只支持 CSS 选择器；XPath 字段请改写成 CSS（或用 python lxml 版）',
    ' */',
    'package main',
    '',
    'import (',
    '\t"encoding/csv"',
    '\t"fmt"',
    '\t"log"',
    '\t"net/http"',
    '\t"net/url"',
    '\t"os"',
    '\t"strconv"',
    '\t"strings"',
    '\t"time"',
    '',
    '\t"github.com/PuerkitoBio/goquery"',
    ')',
    '',
    'const (',
    '\tstartURL    = ' + q(m.url),
    '\titemSel     = ' + q(SCR.itemSel) + ' // 列表项（CSS）',
    '\tpageMode    = ' + q(m.pageMode) + ' // none / url / next',
    '\turlTemplate = ' + q(m.tpl) + ' // {page} 是页码占位',
    '\tnextSel     = ' + q(m.nextSel),
    '\tmaxPages    = ' + m.pages,
    '\tdelayMS     = ' + m.delay + ' // 翻页间隔毫秒',
    '\toutCSV      = "data.csv"',
    '\tuserAgent   = ' + q(m.ua),
    '\tcookie      = "" // 需要登录态时填 "k=v; k2=v2"',
    ')',
    '',
    'type field struct {',
    '\tname  string',
    '\tsel   string',
    '\thow   string // text / html / attr',
    '\tattr  string',
    '\tmulti bool',
    '}',
    '',
    'var fields = []field{',
    fld,
    '}',
    '',
    'func value(s *goquery.Selection, f field) string {',
    '\tif s.Length() == 0 {',
    '\t\treturn ""',
    '\t}',
    '\tif f.how == "html" {',
    '\t\th, _ := goquery.OuterHtml(s)',
    '\t\treturn h',
    '\t}',
    '\tif f.how == "attr" {',
    '\t\treturn s.AttrOr(f.attr, "")',
    '\t}',
    '\treturn strings.Join(strings.Fields(s.Text()), " ")',
    '}',
    '',
    'func parse(doc *goquery.Document) (rows [][]string) {',
    '\tdoc.Find(itemSel).Each(func(_ int, card *goquery.Selection) {',
    '\t\trow := make([]string, 0, len(fields))',
    '\t\tfor _, f := range fields {',
    '\t\t\tnodes := card',
    '\t\t\tif f.sel != "" {',
    '\t\t\t\tnodes = card.Find(f.sel)',
    '\t\t\t}',
    '\t\t\tif f.multi {',
    '\t\t\t\tvar vals []string',
    '\t\t\t\tnodes.Each(func(_ int, n *goquery.Selection) {',
    '\t\t\t\t\tif v := value(n, f); v != "" {',
    '\t\t\t\t\t\tvals = append(vals, v)',
    '\t\t\t\t\t}',
    '\t\t\t\t})',
    '\t\t\t\trow = append(row, strings.Join(vals, " | "))',
    '\t\t\t} else {',
    '\t\t\t\trow = append(row, value(nodes.First(), f))',
    '\t\t\t}',
    '\t\t}',
    '\t\trows = append(rows, row)',
    '\t})',
    '\treturn rows',
    '}',
    '',
    'func fetch(u string) (*goquery.Document, error) {',
    '\treq, err := http.NewRequest("GET", u, nil)',
    '\tif err != nil {',
    '\t\treturn nil, err',
    '\t}',
    '\treq.Header.Set("User-Agent", userAgent)',
    '\treq.Header.Set("Accept-Language", "zh-CN,zh;q=0.9")',
    '\tif cookie != "" {',
    '\t\treq.Header.Set("Cookie", cookie)',
    '\t}',
    '\tclient := &http.Client{Timeout: 15 * time.Second}',
    '\tresp, err := client.Do(req)',
    '\tif err != nil {',
    '\t\treturn nil, err',
    '\t}',
    '\tdefer resp.Body.Close()',
    '\tif resp.StatusCode != http.StatusOK {',
    '\t\treturn nil, fmt.Errorf("HTTP %d", resp.StatusCode)',
    '\t}',
    '\treturn goquery.NewDocumentFromReader(resp.Body)',
    '}',
    '',
    'func main() {',
    '\tout := [][]string{}',
    '\thead := make([]string, 0, len(fields))',
    '\tfor _, f := range fields {',
    '\t\thead = append(head, f.name)',
    '\t}',
    '\tout = append(out, head)',
    '',
    '\tpage := func(u string) {',
    '\t\tfmt.Println("抓取", u)',
    '\t\tdoc, err := fetch(u)',
    '\t\tif err != nil {',
    '\t\t\tfmt.Println("请求失败:", err)',
    '\t\t\treturn',
    '\t\t}',
    '\t\tout = append(out, parse(doc)...)',
    '\t}',
    '',
    '\tswitch pageMode {',
    '\tcase "url":',
    '\t\tfor p := 1; p <= maxPages; p++ {',
    '\t\t\ttpl := urlTemplate',
    '\t\t\tif strings.Contains(tpl, "{page}") {',
    '\t\t\t\ttpl = strings.ReplaceAll(tpl, "{page}", strconv.Itoa(p))',
    '\t\t\t}',
    '\t\t\tpage(tpl)',
    '\t\t\ttime.Sleep(time.Duration(delayMS) * time.Millisecond)',
    '\t\t}',
    '\tcase "next":',
    '\t\tu := startURL',
    '\t\tfor i := 0; i < maxPages; i++ {',
    '\t\t\tpage(u)',
    '\t\t\tdoc, err := fetch(u)',
    '\t\t\tif err != nil {',
    '\t\t\t\tbreak',
    '\t\t\t}',
    '\t\t\thref := doc.Find(nextSel).First().AttrOr("href", "")',
    '\t\t\tif href == "" {',
    '\t\t\t\tbreak',
    '\t\t\t}',
    '\t\t\tref, err := url.Parse(href)',
    '\t\t\tif err != nil {',
    '\t\t\t\tbreak',
    '\t\t\t}',
    '\t\t\tbase, err := url.Parse(u)',
    '\t\t\tif err != nil {',
    '\t\t\t\tbreak',
    '\t\t\t}',
    '\t\t\tu = base.ResolveReference(ref).String()',
    '\t\t\ttime.Sleep(time.Duration(delayMS) * time.Millisecond)',
    '\t\t}',
    '\tdefault:',
    '\t\tpage(startURL)',
    '\t}',
    '',
    '\tf, err := os.Create(outCSV)',
    '\tif err != nil {',
    '\t\tlog.Fatal(err)',
    '\t}',
    '\tdefer f.Close()',
    '\tf.WriteString("\\xEF\\xBB\\xBF") // BOM，Excel 打开不乱码',
    '\tw := csv.NewWriter(f)',
    '\tw.WriteAll(out)',
    '\tw.Flush()',
    '\tfmt.Println("完成：", len(out)-1, "行 ->", outCSV)',
    '}',
  ].join("\n");
}

/* Node.js · axios + cheerio（仅 CSS 选择器） */
function scrGenNode() {
  const m = scrGenMeta(), q = JSON.stringify;
  const fld = scrGenFields().map(function (f) {
    return "  { name: " + q(f.name) + ", sel: " + q(f.sel) + ", how: " + q(f.type) + ", attr: " + q(f.attr) + ", multi: " + f.multi + " },";
  }).join("\n");
  return [
    '/**',
    ' * 自动生成的采集脚本（可视化采集配置导出）',
    ' * 用法：npm i axios cheerio  →  node scraper.js',
    ' * 注意：cheerio 只支持 CSS 选择器；XPath 字段请改写成 CSS（或用 Python parsel 版）',
    ' */',
    'const axios = require("axios");',
    'const cheerio = require("cheerio");',
    'const fs = require("fs");',
    '',
    'const URL = ' + q(m.url) + ';',
    'const HEADERS = {',
    '  "User-Agent": ' + q(m.ua) + ',',
    '  "Accept-Language": "zh-CN,zh;q=0.9",',
    m.cookie ? '  "Cookie": ' + q(m.cookie) + ',' : '  // 需要登录态时在这里加 "Cookie": "..."',
    '};',
    'const ITEM_SEL = ' + q(SCR.itemSel) + ';',
    'const FIELDS = [',
    fld,
    '];',
    'const PAGE_MODE = ' + q(m.pageMode) + ';   // none / url / next',
    'const URL_TEMPLATE = ' + q(m.tpl) + ';',
    'const NEXT_SEL = ' + q(m.nextSel) + ';',
    'const PAGES = ' + m.pages + ';',
    'const DELAY = ' + m.delay + ';            // 翻页间隔毫秒',
    'const OUT_CSV = "data.csv";',
    '',
    'const sleep = (ms) => new Promise((r) => setTimeout(r, ms));',
    '',
    'function value($, node, f) {',
    '  if (!node || !node.length) return "";',
    '  if (f.how === "html") return $.html(node) || "";',
    '  if (f.how === "attr") return node.attr(f.attr) || "";',
    '  return (node.text() || "").replace(/\\s+/g, " ").trim();',
    '}',
    '',
    'function parse(html) {',
    '  const $ = cheerio.load(html);',
    '  const rows = [];',
    '  $(ITEM_SEL).each((_, card) => {',
    '    const row = {};',
    '    FIELDS.forEach((f) => {',
    '      const nodes = f.sel ? $(card).find(f.sel) : $(card);',
    '      if (f.multi) {',
    '        const vals = [];',
    '        nodes.each((__, n) => vals.push(value($, $(n), f)));',
    '        row[f.name] = vals.filter(Boolean).join(" | ");',
    '      } else {',
    '        row[f.name] = value($, nodes.first(), f);',
    '      }',
    '    });',
    '    rows.push(row);',
    '  });',
    '  return rows;',
    '}',
    '',
    'async function fetchHtml(url) {',
    '  try {',
    '    const r = await axios.get(url, { headers: HEADERS, timeout: 15000 });',
    '    return r.data;',
    '  } catch (e) {',
    '    console.error("请求失败", url, e.message);',
    '    return "";',
    '  }',
    '}',
    '',
    'function toCsv(rows) {',
    '  if (!rows.length) return "";',
    '  const cols = Object.keys(rows[0]);',
    '  const esc = (v) => \'"\' + String(v == null ? "" : v).replace(/"/g, \'""\') + \'"\';',
    '  return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\\n");',
    '}',
    '',
    '(async () => {',
    '  let rows = [];',
    '  if (PAGE_MODE === "url") {',
    '    for (let p = 1; p <= PAGES; p++) {',
    '      const u = URL_TEMPLATE.includes("{page}") ? URL_TEMPLATE.replace("{page}", p) : URL_TEMPLATE;',
    '      console.log("抓取", u);',
    '      const html = await fetchHtml(u);',
    '      if (html) rows = rows.concat(parse(html));',
    '      await sleep(DELAY);',
    '    }',
    '  } else if (PAGE_MODE === "next") {',
    '    let u = URL;',
    '    for (let i = 0; i < PAGES; i++) {',
    '      console.log("抓取", u);',
    '      const html = await fetchHtml(u);',
    '      if (!html) break;',
    '      rows = rows.concat(parse(html));',
    '      const href = cheerio.load(html)(NEXT_SEL).first().attr("href");',
    '      if (!href) break;',
    '      u = new URL(href, u).href;',
    '      await sleep(DELAY);',
    '    }',
    '  } else {',
    '    const html = await fetchHtml(URL);',
    '    if (html) rows = parse(html);',
    '  }',
    '  fs.writeFileSync(OUT_CSV, "\\ufeff" + toCsv(rows));',
    '  console.log("完成：", rows.length, "行 ->", OUT_CSV);',
    '})();',
  ].join("\n");
}

/* 浏览器 JS · fetch + DOMParser（控制台直接粘贴运行） */
function scrGenJs() {
  const m = scrGenMeta(), q = JSON.stringify;
  const fld = scrGenFields().map(function (f) {
    return "    { name: " + q(f.name) + ", sel: " + q(f.sel) + ", how: " + q(f.type) + ", attr: " + q(f.attr) + ", multi: " + f.multi + " },";
  }).join("\n");
  return [
    '/**',
    ' * 自动生成的采集脚本（可视化采集配置导出）',
    ' * 用法：在目标站点的控制台（F12）里粘贴运行；只采当前页',
    ' */',
    'const URL = ' + q(m.url) + ';',
    'const ITEM_SEL = ' + q(SCR.itemSel) + ';',
    'const FIELDS = [',
    fld,
    '];',
    '',
    'function one(n, f) {',
    '  if (!n) return "";',
    '  if (f.how === "html") return n.innerHTML || "";',
    '  if (f.how === "attr") return n.getAttribute(f.attr) || "";',
    '  return (n.textContent || "").replace(/\\s+/g, " ").trim();',
    '}',
    '',
    'function parse(html) {',
    '  const doc = new DOMParser().parseFromString(html, "text/html");',
    '  const rows = [];',
    '  doc.querySelectorAll(ITEM_SEL).forEach((card) => {',
    '    const row = {};',
    '    FIELDS.forEach((f) => {',
    '      const nodes = f.sel ? card.querySelectorAll(f.sel) : [card];',
    '      if (f.multi) row[f.name] = Array.from(nodes).map((n) => one(n, f)).filter(Boolean).join(" | ");',
    '      else row[f.name] = one(nodes[0], f);',
    '    });',
    '    rows.push(row);',
    '  });',
    '  return rows;',
    '}',
    '',
    '(async () => {',
    '  const res = await fetch(URL, { credentials: "include" });',
    '  const rows = parse(await res.text());',
    '  console.table(rows.slice(0, 20));',
    '  console.log("共", rows.length, "行；JSON：");',
    '  console.log(JSON.stringify(rows, null, 2));',
    '})();',
  ].join("\n");
}

function scrCodeGenRender() {
  scrPopHide($("scrAiPop"));
  scrPopHide($("scrDlPop"));
  const lang = SCR.genLang || "py";
  if (lang === "ai") {
    // AI 生成模式：没有本地模板，等用户输入说明后由 AI 生成
    SCR.genCode = "";
    SCR.genAiCode = false;
    const out = $("scrCodeGenOut");
    if (out) {
      out.textContent = "已选择「AI 生成」：输入一句话说明（想用什么语言 / 库、怎么采集、怎么翻页…），" +
        "AI 会按你的说明和上方采集配置生成完整可运行的代码。";
      out.classList.remove("busy");
    }
    const ai = $("scrCodeGenAi");
    if (ai) { ai.dataset.busy = ""; ai.classList.remove("on"); }
    return;
  }
  let code = "";
  if (lang === "py") code = scrGenPy();
  else if (lang === "py_bs4") code = scrGenPyBs4();
  else if (lang === "py_lxml") code = scrGenPyLxml();
  else if (lang === "go") code = scrGenGo();
  else if (lang === "node") code = scrGenNode();
  else code = scrGenJs();
  SCR.genCode = code;
  SCR.genAiCode = false;
  const out = $("scrCodeGenOut");
  if (out) { out.textContent = code; out.classList.remove("busy"); }
  const ai = $("scrCodeGenAi");
  if (ai) { ai.dataset.busy = ""; ai.classList.remove("on"); }
}

function scrCodeGenCopy() {
  const code = SCR.genCode || "";
  if (!code) { toast("还没有生成代码", "warn"); return; }
  const done = function () { toast("代码已复制到剪贴板", "ok"); };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(code).then(done, function () { scrCodeGenCopyFallback(code, done); });
  } else {
    scrCodeGenCopyFallback(code, done);
  }
}

function scrCodeGenCopyFallback(code, done) {
  const ta = document.createElement("textarea");
  ta.value = code;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand("copy"); done(); } catch (_) { toast("复制失败，请手动选择复制", "err"); }
  ta.remove();
}

const SCR_GEN_EXT = { py: "py", py_bs4: "py", py_lxml: "py", go: "go", node: "js", js: "js" };
const SCR_GEN_LANG_NAMES = {
  py: "Python（requests + parsel）",
  py_bs4: "Python（requests + BeautifulSoup）",
  py_lxml: "Python（requests + lxml，支持 XPath）",
  go: "Go（net/http + goquery）",
  node: "Node.js（axios + cheerio）",
  js: "浏览器 JavaScript（fetch + DOMParser）",
  ai: "AI 生成的代码（保持其语言不变）",
};

/* 文件扩展名：AI 生成的代码按内容识别语言 */
function scrGenExt() {
  const lang = SCR.genLang || "py";
  if (lang !== "ai") return SCR_GEN_EXT[lang] || "txt";
  const c = SCR.genCode || "";
  if (/^\s*package\s+\w+/m.test(c)) return "go";
  if (/^\s*(import\s+requests|from\s+(bs4|lxml|parsel)|def\s+\w+\()/m.test(c) && !/require\(/.test(c)) return "py";
  if (/require\(["']|import\s+axios|console\.log/.test(c)) return "js";
  if (/\bfn\s+main\s*\(|use\s+std::/.test(c)) return "rs";
  if (/public\s+(class|static\s+void)|System\.out\.print/.test(c)) return "java";
  if (/<\?php/.test(c)) return "php";
  if (/^\s*package\s|^\s*func\s+/m.test(c)) return "kt";
  return "txt";
}

function scrCodeGenDownloadAsk() {
  const code = SCR.genCode || "";
  if (!code) { toast("还没有生成代码", "warn"); return; }
  const pop = $("scrDlPop");
  if (!pop) { scrCodeGenDownload(); return; }
  const name = "scraper." + scrGenExt();
  const n = $("scrDlName");
  if (n) n.textContent = name;
  scrPopHide($("scrAiPop"));
  pop.hidden = false;
}

function scrCodeGenDownload() {
  const code = SCR.genCode || "";
  if (!code) { toast("还没有生成代码", "warn"); return; }
  const name = "scraper." + scrGenExt();
  const blob = new Blob([code], { type: "text/plain;charset=utf-8" });
  const a = document.createElement("a");
  a.href = window.URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  try { window.URL.revokeObjectURL(a.href); } catch (_) { }
}

/* ---- AI 优化：把当前代码交给 /api/ai/chat 流式改写 ---- */

/* SSE 流式对话：messages → 逐段回调，resolve 完整文本 */
function scrAiChat(messages, onDelta, signal) {
  return new Promise(function (resolve, reject) {
    fetch("/api/ai/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: messages, use_tools: false, perm: "readonly" }),
      signal: signal,
    }).then(function (r) {
      if (!r.ok || !r.body) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          throw new Error(j.error || ("HTTP " + r.status));
        });
      }
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = "", acc = "";
      (function pump() {
        reader.read().then(function (res) {
          if (res.done) { resolve(acc); return; }
          buf += dec.decode(res.value, { stream: true });
          let idx;
          while ((idx = buf.indexOf("\n\n")) >= 0) {
            const evt = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            evt.split("\n").forEach(function (line) {
              if (line.indexOf("data:") !== 0) return;
              const data = line.slice(5).trim();
              if (!data || data === "[DONE]") return;
              let obj;
              try { obj = JSON.parse(data); } catch (_) { return; }
              if (obj.error) { reject(new Error(obj.error)); return; }
              if (obj.delta) { acc += obj.delta; if (onDelta) onDelta(acc); }
            });
          }
          pump();
        }).catch(reject);
      })();
    }).catch(reject);
  });
}

/* 剥掉 AI 回复里的 ``` 代码块围栏 */
function scrStripFence(t) {
  const m = String(t || "").match(/```[a-zA-Z0-9]*[ \t]*\r?\n([\s\S]*?)\r?\n?[ \t]*```/);
  return m ? m[1] : t;
}

/* AI 优化入口：先弹一句话输入框，按这句话优化；留空走默认优化 */
function scrCodeGenAiAsk() {
  const btn = $("scrCodeGenAi");
  if (btn && btn.dataset.busy === "1") return;
  const base = SCR.genCode || (($("scrCodeGenOut") || {}).textContent) || "";
  if (!base.trim()) { toast("先生成一份代码，再交给 AI 优化", "warn"); return; }
  const pop = $("scrAiPop");
  if (!pop) { scrCodeGenAiRun(""); return; }
  SCR.aiMode = "opt";
  const inp = $("scrAiInput");
  if (inp) inp.placeholder = "例如：加上失败重试和随机延时 / 最多翻 10 页 / 字段里加发布时间…（留空则按默认方式优化）";
  scrPopHide($("scrDlPop"));
  pop.hidden = false;
  if (inp) { inp.value = ""; setTimeout(function () { try { inp.focus(); } catch (_) { } }, 30); }
}

/* AI 生成入口：下拉选「AI」时弹说明输入框，按说明生成任意语言代码 */
function scrCodeGenAiGenAsk() {
  const btn = $("scrCodeGenAi");
  if (btn && btn.dataset.busy === "1") return;
  const pop = $("scrAiPop");
  if (!pop) return;
  SCR.aiMode = "gen";
  const inp = $("scrAiInput");
  if (inp) {
    inp.placeholder = "例如：用 Python + httpx 异步采集，带重试 / 用 Go 并发抓取标题和链接 / 用 Playwright 渲染后再采…";
    inp.value = "";
    setTimeout(function () { try { inp.focus(); } catch (_) { } }, 30);
  }
  scrPopHide($("scrDlPop"));
  pop.hidden = false;
}

function scrAiPopGo() {
  const inp = $("scrAiInput");
  const ask = inp ? inp.value.trim() : "";
  scrPopHide($("scrAiPop"));
  if (SCR.aiMode === "gen") scrCodeGenAiGenerate(ask);
  else scrCodeGenAiRun(ask);
}

/* AI 按说明从零生成代码（语言 / 库由说明决定） */
function scrCodeGenAiGenerate(ask) {
  const btn = $("scrCodeGenAi");
  const out = $("scrCodeGenOut");
  if (!out || (btn && btn.dataset.busy === "1")) return;
  const askTxt = String(ask || "").trim();
  if (!askTxt) {
    toast("请输入一句话说明，AI 才知道要生成什么", "warn");
    scrCodeGenAiGenAsk();
    return;
  }
  const fs = scrGenFields().map(function (f) {
    return "- " + f.name + "：" + (f.sel || "（列表项本身）") + "（" + f.type + (f.type === "attr" ? ":" + f.attr : "") + (f.multi ? "，多值" : "") + "）" + scrFieldRulesTxt(f);
  }).join("\n");
  const sys = "你是资深爬虫工程师。根据下面的采集配置和用户说明，选择最合适的编程语言与库" +
    "（用户说明里指定了语言 / 库就严格照做，没指定就选最合适的并在代码头部注释里说明理由），" +
    "生成一份完整、可直接运行的采集代码：包含请求头 / 超时 / 异常处理与重试、翻页、CSV 导出和简明中文注释。" +
    "只输出完整代码，用 ``` 代码块包裹，不要输出任何解释文字。";
  const user = "采集目标 URL：" + (SCR.pageUrl || SCR.url || "") +
    "\n列表项选择器：" + SCR.itemSel +
    "\n字段：\n" + fs +
    "\n翻页方式：" + (SCR.pageMode || "none") +
    "\nURL 模板：" + (SCR.urlTemplate || "（无）") +
    "\n下一页选择器：" + (SCR.nextSel || "（无）") +
    "\n页数：" + (Math.max(1, Number(SCR.pages) || 1)) +
    "\n请求头：UA=" + (SCR.ua || "（默认）") + "；Cookie=" + (SCR.cookie ? "（已配置）" : "（无）") +
    "\n\n用户说明（按这句话生成代码）：" + askTxt;
  const ctl = new AbortController();
  SCR.genAbort = ctl;
  if (btn) { btn.dataset.busy = "1"; btn.classList.add("on"); }
  out.classList.add("busy");
  out.textContent = "AI 正在按说明生成代码…";
  toast("正在让 AI 按说明生成代码…", "ok");
  scrAiChat(
    [{ role: "system", content: sys }, { role: "user", content: user }],
    function (acc) { out.textContent = acc; },
    ctl.signal
  ).then(function (acc) {
    const code = scrStripFence(acc).trim();
    if (!code) {
      out.classList.remove("busy");
      if (btn) { btn.dataset.busy = ""; btn.classList.remove("on"); }
      toast("AI 没有返回代码，重试或换个说法", "err");
      return;
    }
    SCR.genCode = code;
    SCR.genAiCode = true;
    out.textContent = code;
    out.classList.remove("busy");
    if (btn) { btn.dataset.busy = ""; btn.classList.remove("on"); }
    toast("AI 生成完成，可直接复制 / 下载", "ok");
  }).catch(function (e) {
    out.classList.remove("busy");
    if (btn) { btn.dataset.busy = ""; btn.classList.remove("on"); }
    if (e && /abort/i.test(String(e.message || e))) return;
    toast("AI 生成失败：" + ((e && e.message) || e), "err");
    out.textContent = "已选择「AI 生成」：输入一句话说明（想用什么语言 / 库、怎么采集、怎么翻页…），" +
      "AI 会按你的说明和上方采集配置生成完整可运行的代码。";
  });
}

function scrCodeGenAiRun(ask) {
  const btn = $("scrCodeGenAi");
  const out = $("scrCodeGenOut");
  if (!btn || !out || btn.dataset.busy === "1") return;
  const base = SCR.genCode || out.textContent || "";
  if (!base.trim()) { toast("先生成一份代码，再交给 AI 优化", "warn"); return; }
  const askTxt = String(ask || "").trim();
  const lang = SCR.genLang || "py";
  const langName = SCR_GEN_LANG_NAMES[lang] || lang;
  const fs = scrGenFields().map(function (f) {
    return "- " + f.name + "：" + (f.sel || "（列表项本身）") + "（" + f.type + (f.type === "attr" ? ":" + f.attr : "") + (f.multi ? "，多值" : "") + "）" + scrFieldRulesTxt(f);
  }).join("\n");
  const sys = askTxt
    ? "你是资深爬虫工程师。请在保持采集目标、选择器与解析逻辑大体不变的前提下，严格按用户的这句话优化这段代码，" +
      "其余方面也顺手做好异常处理、超时与中文注释。只输出优化后的完整代码，用 ``` 代码块包裹，不要输出任何解释文字。"
    : "你是资深爬虫工程师。请在保持采集目标、选择器与解析逻辑不变的前提下优化这段代码：" +
      "补全异常处理与失败重试、完善请求头 / 超时 / 翻页间隔、修正选择器或解析问题、加上简明的中文注释。" +
      "只输出优化后的完整代码，用 ``` 代码块包裹，不要输出任何解释文字。";
  const user = "采集目标 URL：" + (SCR.pageUrl || SCR.url || "") +
    "\n列表项选择器：" + SCR.itemSel +
    "\n字段：\n" + fs +
    "\n翻页方式：" + (SCR.pageMode || "none") +
    "\n目标语言：" + langName +
    (askTxt ? "\n用户要求（必须按这句话优化）：" + askTxt : "") +
    "\n\n当前代码：\n" + base;
  const ctl = new AbortController();
  SCR.genAbort = ctl;
  btn.dataset.busy = "1";
  btn.classList.add("on");
  out.classList.add("busy");
  out.textContent = "AI 正在优化代码…";
  toast("正在交给 AI 优化代码…", "ok");
  scrAiChat(
    [{ role: "system", content: sys }, { role: "user", content: user }],
    function (acc) { out.textContent = acc; },
    ctl.signal
  ).then(function (acc) {
    const code = scrStripFence(acc).trim() || base;
    SCR.genCode = code;
    SCR.genAiCode = true;
    out.textContent = code;
    out.classList.remove("busy");
    btn.dataset.busy = "";
    btn.classList.remove("on");
    toast("AI 优化完成，可直接复制 / 下载", "ok");
  }).catch(function (e) {
    out.classList.remove("busy");
    btn.dataset.busy = "";
    btn.classList.remove("on");
    if (e && /abort/i.test(String(e.message || e))) return;
    toast("AI 优化失败：" + ((e && e.message) || e), "err");
    out.textContent = base;   // 失败还原成本地生成的版本
  });
}

function scrPickField(el, doc) {
  if (!SCR.itemSel) {
    toast("先点选「列表项」，再点字段", "warn");
    return;
  }
  const roots = scrItemNodes(doc);
  if (!roots.length) { toast("列表项选择器在当前页面匹配不到元素", "warn"); return; }
  // 关键：用「被点的那个元素所属的列表项」当根，而不是固定拿第一个。
  // 用第一个当根时，点第 2 张卡片里的元素会因为「不在根内」退化成绝对路径，
  // 采集时每行都取到文档里同一个节点 —— 结果就是每行数据一模一样。
  const root = scrItemRootOf(el, doc);
  if (!root) {
    toast("这个元素不在列表项里：请点列表项内部的内容（标题 / 时间 / 链接 / 图片）", "warn");
    return;
  }
  const cssSel = scrRelSel(el, root);
  const xpSel = scrXPathOf(el, root);
  const info = scrSuggestField(el);
  scrAddField({
    name: info.name, selector: cssSel, css: cssSel, xpath: xpSel, syntax: "css",
    type: info.type, attr: info.attr, abs: false,
    html: (el.outerHTML || "").slice(0, 6000),
  });
  try { el.classList.add("scr-picked"); } catch (_) { }
  toast("已添加字段：" + cssSel, "ok");
  // 立刻在「第一条」上验一下：不同卡片结构不一致（广告卡 / 大卡）时，这条字段可能在别的行取不到
  try {
    const first = roots[0];
    if (first && root !== first && !first.querySelector(cssSel)) {
      toast("提示：这个字段在第 1 条数据里定位不到，采集时可能有空值", "warn");
    }
  } catch (_) { }
}

/* 根据元素猜一个字段名 / 取值方式 */
function scrSuggestField(el) {
  const tag = el.tagName.toLowerCase();
  const text = (el.innerText || el.textContent || "").trim().slice(0, 16);
  let name = "";
  const cls = Array.prototype.slice.call(el.classList || []).filter(scrClassOk);
  if (cls.length) name = cls[0].replace(/^(item|list|post|card)[-_]?/i, "") || cls[0];
  if (!name) {
    if (tag === "a") name = "链接";
    else if (tag === "img") name = "图片";
    else if (/^h[1-6]$/.test(tag)) name = "标题";
    else if (tag === "time") name = "时间";
    else if (tag === "td" || tag === "th") name = "列" + (scrColIndex(el) + 1);
    else name = text.slice(0, 8) || tag;
  }
  // 名字不能重复
  const base = name;
  let i = 2;
  while (SCR.fields.some(function (f) { return f.name === name; })) { name = base + i; i++; }
  let type = "text", attr = "";
  if (tag === "a" && el.getAttribute("href")) { type = "attr"; attr = "href"; name = name === "链接" ? "链接" : name + "链接"; }
  else if (tag === "img" && el.getAttribute("src")) { type = "attr"; attr = "src"; }
  return { name: name, type: type, attr: attr };
}

function scrColIndex(td) {
  try { return Array.prototype.indexOf.call(td.parentElement.children, td); } catch (_) { return 0; }
}

/* ---------------- 清浮层：广告 / 登录弹窗 / 吸底条 ----------------
   预览页不跑站点脚本，但这些浮层本身就是 HTML + CSS（fixed / 高 z-index），
   所以「关掉弹窗」的按钮没用，直接把它们从渲染结果里隐藏掉最省事。 */
const SCR_OVERLAY_WORD_RE = /(^|[\s_-])(ad|ads|adv|advert|advertisement|promo|popup|modal|dialog|layer|mask|overlay|login|float|floating|banner|toast|guide|qrcode|suspend|recommend|notice|tips?)([\s_-]|$)/i;

function scrHideEl(el, doc) {
  if (!el || !doc || el === doc.body || el === doc.documentElement) return;
  const sel = scrAbsPath(el);
  try { el.style.setProperty("display", "none", "important"); } catch (_) { return; }
  if (sel && SCR.hideSelectors.indexOf(sel) < 0) SCR.hideSelectors.push(sel);
  scrSaveDraft();
  toast("已隐藏这个浮层（规则已记住，重新加载也保持隐藏）", "ok");
}

/* 换文档（重抓 / 滚动加载）后，把隐藏过的浮层再隐藏一遍 */
function scrApplyHidden(doc) {
  if (!doc || !(SCR.hideSelectors || []).length) return;
  SCR.hideSelectors.forEach(function (sel) {
    try {
      doc.querySelectorAll(sel).forEach(function (el) {
        el.style.setProperty("display", "none", "important");
      });
    } catch (_) { }
  });
}

/* 自动识别：固定 / 悬浮 + （高 z-index 或类名像广告弹窗）→ 直接隐藏 */
function scrAutoHideOverlays(doc) {
  if (!doc || !doc.body) return 0;
  const win = doc.defaultView || window;
  const vpArea = Math.max(1, (win.innerWidth || 1280) * (win.innerHeight || 900));
  const skipTags = /^(SCRIPT|STYLE|LINK|META|IMG|A|SPAN|P|LI|TD|TR|BR|VIDEO|CANVAS|SVG|PATH)$/;
  const nodes = doc.body.querySelectorAll("*");
  let n = 0;
  for (let i = 0; i < nodes.length && i < 4000; i++) {
    const el = nodes[i];
    if (!el.tagName || skipTags.test(el.tagName)) continue;
    if (el.closest("header,nav,footer")) continue;          // 站点导航 / 页脚不动
    let cs = null;
    try { cs = win.getComputedStyle(el); } catch (_) { continue; }
    if (!cs || (cs.position !== "fixed" && cs.position !== "sticky")) continue;
    const r = el.getBoundingClientRect();
    if (r.width * r.height < vpArea * 0.04) continue;        // 太小的角标先放过
    const z = parseInt(cs.zIndex, 10) || 0;
    const cls = typeof el.className === "string" ? el.className : "";
    const sig = ((el.id || "") + " " + cls).toLowerCase();
    if (/header|navbar|topbar|toolbar|footer|search/.test(sig)) continue;
    const named = SCR_OVERLAY_WORD_RE.test(sig);
    if (cs.position === "sticky" && !named) continue;        // 普通吸顶条不动
    if (!named && z < 100) continue;                         // 只有明显压在最上层的才自动清
    const sel = scrAbsPath(el);
    try { el.style.setProperty("display", "none", "important"); } catch (_) { continue; }
    if (sel && SCR.hideSelectors.indexOf(sel) < 0) SCR.hideSelectors.push(sel);
    n++;
  }
  if (n) {
    scrSaveDraft();
    toast("已自动清理 " + n + " 个浮层，剩下的点一下就能清掉", "ok");
  }
  return n;
}

/* ---------------- 字段面板 ---------------- */
function scrRenderFields() {
  const box = $("scrFieldList");
  if (!box) return;
  $("scrFieldCount").textContent = SCR.fields.length;
  if (!SCR.fields.length) {
    box.innerHTML = '<div class="scr-fempty">还没有字段。切到「② 点选字段」，在左侧页面上点要采集的内容即可（标题、时间、链接、图片都可以）。</div>';
    return;
  }
  box.innerHTML = SCR.fields.map(function (f, i) {
    const typeOpts = [
      ["text", "文本"], ["html", "HTML"], ["attr", "属性"]
    ].map(function (o) {
      return '<option value="' + o[0] + '"' + (f.type === o[0] ? " selected" : "") + ">" + o[1] + "</option>";
    }).join("");
    const isXp = (f.syntax === "xpath") || scrIsXPath(f.selector);
    const ph = isXp
      ? "XPath，如 .//div[@class=\'x\']/a/@href"
      : "CSS 选择器（可在页面上点选）";
    const rn = (f.replaces || []).length + (f.prefix ? 1 : 0) + (f.suffix ? 1 : 0) + (f.multi ? 1 : 0);
    return '<div class="scr-field" data-fi="' + i + '">' +
      '<div class="scr-frow">' +
        '<input class="scr-in scr-fname" value="' + scrA(f.name) + '" placeholder="字段名">' +
        '<button class="scr-fsyn' + (isXp ? " xp" : "") + '" title="点击在 CSS / XPath 之间切换（缺少的写法会按当前页面自动换算）">' +
          '<i class="bi bi-arrow-left-right"></i> ' + (isXp ? "XPath" : "CSS") + '</button>' +
        '<button class="scr-fview" title="查看该元素的 HTML / XPath / CSS，可复制后改写成高级 XPath"><i class="bi bi-code-slash"></i></button>' +
        '<button class="scr-fdel" title="删除字段"><i class="bi bi-x-lg"></i></button>' +
      '</div>' +
      '<input class="scr-in mono scr-fsel" value="' + scrA(f.selector) + '" placeholder="' + ph + '">' +
      '<div class="scr-fopts">' +
        '<select class="scr-ftype">' + typeOpts + "</select>" +
        (f.type === "attr"
          ? '<input class="scr-in scr-fattr" value="' + scrA(f.attr || "href") + '" placeholder="href / src">'
          : "") +
        '<button class="scr-frule' + (rn ? " on" : "") + '" data-frule="1" ' +
          'title="取值规则：字符串替换（普通 / 正则）、前后缀拼接、多值">' +
          '<i class="bi bi-sliders"></i> 规则' + (rn ? "(" + rn + ")" : "") + '</button>' +
      '</div>' +
    "</div>";
  }).join("");
}

function scrAddField(f) {
  SCR.fields.push({
    name: f.name || ("字段" + (SCR.fields.length + 1)),
    selector: f.selector || "",
    type: f.type || "text",
    attr: f.attr || "",
    multi: !!f.multi,
    replaces: f.replaces || [],     // 取值规则：[{find,to,regex}]
    prefix: f.prefix || "",         // 取值规则：前缀拼接
    suffix: f.suffix || "",         // 取值规则：后缀拼接
    abs: !!f.abs,         // true = 文档级选择器（不进列表项），只有这种才在整页里兜底查找
    syntax: f.syntax || (scrIsXPath(f.selector) ? "xpath" : "css"),
    css: f.css || "",     // 点选时同时记下两种写法，方便一键切换
    xpath: f.xpath || "",
    html: f.html || "",   // 元素快照，供「查看元素」用
  });
  scrRenderFields();
  scrSaveDraft();
  const box = $("scrFieldList");
  if (box && box.lastElementChild) {
    box.lastElementChild.classList.add("flash");
    setTimeout(function () { box.lastElementChild && box.lastElementChild.classList.remove("flash"); }, 900);
    box.lastElementChild.scrollIntoView({ block: "nearest" });
  }
}

/* ---------------- 取值规则（替换 / 前后缀拼接 / 多值） ----------------
   预览（本地 + 代理脚本）与服务端「开始采集」都会套用，随字段一起存草稿。 */
function scrApplyRules(v, f) {
  let s = v == null ? "" : String(v);
  (f.replaces || []).forEach(function (r) {
    const find = String(r.find || "");
    if (!find) return;
    if (r.regex) { try { s = s.replace(new RegExp(find, "g"), r.to || ""); } catch (_) { } }
    else s = s.split(find).join(r.to || "");
  });
  const pre = f.prefix || "", suf = f.suffix || "";
  if (s && (pre || suf)) s = pre + s + suf;
  return s;
}

/* 一条列表项里某字段的「原始值」（不套规则），供预览与规则弹层复用 */
function scrRawFieldValue(root, f, doc) {
  if (f.multi) {
    const vals = [];
    try {
      if (scrIsXPath(f.selector)) {
        const res = scrEvalXPath(doc, root, f.selector);
        const arr = Array.isArray(res) ? res : (res ? [res] : []);
        arr.forEach(function (n) {
          vals.push(typeof n === "string" ? n : scrValueFromEl(n, { type: f.type, attr: f.attr }, doc));
        });
      } else {
        root.querySelectorAll(f.selector || "*").forEach(function (n) {
          vals.push(scrLocalValue(n, { type: f.type, attr: f.attr, selector: "." }, doc));
        });
      }
    } catch (_) { }
    return vals.filter(Boolean).join(" | ");
  }
  return scrLocalValue(root, f, doc);
}

function scrRuleOpen(i) {
  const f = SCR.fields[i];
  const pop = $("scrRulePop");
  if (!f || !pop) return;
  SCR.ruleFi = i;
  pop.hidden = false;
  scrRuleRefresh();
}

function scrRuleClose() {
  const pop = $("scrRulePop");
  if (pop) pop.hidden = true;
  SCR.ruleFi = null;
}

function scrRuleRefresh() {
  const f = SCR.fields[SCR.ruleFi];
  const pop = $("scrRulePop");
  if (!f || !pop || pop.hidden) return;
  $("scrRulePopName").textContent = f.name || "";
  $("scrRuleMulti").checked = !!f.multi;
  $("scrRulePre").value = f.prefix || "";
  $("scrRuleSuf").value = f.suffix || "";
  const chips = (f.replaces || []).map(function (r, ri) {
    return '<span class="scr-rule-chip" title="' + scrA((r.regex ? "正则 " : "") + (r.find || "") + " → " + (r.to || "")) + '">' +
      esc((r.regex ? "正则 " : "") + (r.find || "") + " → " + (r.to || "")) +
      '<i class="bi bi-x-lg" data-ri="' + ri + '" title="删除这条替换规则"></i></span>';
  }).join("") || '<span class="scr-rule-chip empty">还没有替换规则</span>';
  $("scrRuleChips").innerHTML = chips;
  scrRenderFields();          // 刷新字段行上的「规则(N)」角标
  scrRulePreview();
}

function scrRulePreview() {
  const f = SCR.fields[SCR.ruleFi];
  const box = $("scrRulePrev");
  if (!f || !box) return;
  const rulesTxt = [];
  (f.replaces || []).forEach(function (r) {
    rulesTxt.push((r.regex ? "正则替换 " : "替换 ") + (r.find || "") + " → " + (r.to || ""));
  });
  if (f.prefix) rulesTxt.push("前缀 +" + f.prefix);
  if (f.suffix) rulesTxt.push("后缀 +" + f.suffix);
  if (SCR.interactive) {
    if (!SCR.itemSel) { box.textContent = "先在页面上点选列表项，才能预览"; return; }
    box.textContent = "正在取第 1 条数据预览…";
    scrAgentCall("extract", { itemSel: SCR.itemSel, fields: [f] }, 8000).then(function (d) {
      if (SCR.ruleFi == null || SCR.fields[SCR.ruleFi] !== f) return;   // 弹层已切走
      const v = d && d.rows && d.rows.length ? String(d.rows[0][f.name] == null ? "" : d.rows[0][f.name]) : "";
      box.innerHTML = "<b>第 1 条结果</b>" + esc(v || "（空）") +
        (rulesTxt.length ? '<br><span class="dim">已套规则：' + esc(rulesTxt.join("；")) + "</span>" : "");
    });
    return;
  }
  const doc = scrFrameDoc();
  const roots = doc ? scrItemNodes(doc) : [];
  const raw = roots.length ? scrRawFieldValue(roots[0], f, doc) : "";
  const fin = scrApplyRules(raw, f);
  box.innerHTML = "<b>原始值</b>" + esc(raw || "（空）") + "<br><b>套规则后</b>" + esc(fin || "（空）") +
    (rulesTxt.length ? '<br><span class="dim">规则：' + esc(rulesTxt.join("；")) + "</span>" : "");
}

/* 给 AI 提示词用的规则描述 */
function scrFieldRulesTxt(f) {
  const t = [];
  (f.replaces || []).forEach(function (r) {
    t.push("把「" + (r.find || "") + "」替换成「" + (r.to || "") + "」" + (r.regex ? "（正则）" : ""));
  });
  if (f.prefix) t.push("值前拼上「" + f.prefix + "」");
  if (f.suffix) t.push("值后拼上「" + f.suffix + "」");
  return t.length ? "；取值规则：" + t.join("，") : "";
}

/* 在当前预览里按字段选择器找元素（优先在列表项内找，避免命中页面上的导航链接） */
function scrFindFieldEl(f, doc) {
  const sel = String((f && f.selector) || "").trim();
  if (!sel) return null;
  if (scrIsXPath(sel)) {
    const res = scrEvalXPath(doc, doc, sel);
    const el = Array.isArray(res) ? res[0] : res;
    return (el && el.nodeType === 1) ? el : null;
  }
  const items = scrItemNodes(doc);
  const scopes = items.length ? items : [doc];
  for (let i = 0; i < scopes.length; i++) {
    let el = null;
    try { el = scopes[i].querySelector(sel); } catch (_) { el = null; }
    if (el) return el;
  }
  try { return doc.querySelector(sel); } catch (_) { return null; }
}

/* 把选择器换算成另一种写法：CSS ⇄ XPath（页面里找不到元素就返回空串） */
function scrConvertField(f, to, doc) {
  const el = scrFindFieldEl(f, doc);
  if (!el) return "";
  const root = scrItemRootOf(el, doc);
  return to === "xpath" ? scrXPathOf(el, root) : scrRelSel(el, root);
}

/* 元素树里一行的标签：tag#id.class + 文本预览 */
function scrNodeLabel(el) {
  const tag = el.tagName.toLowerCase();
  const id = el.id ? "#" + el.id : "";
  const cls = (typeof el.className === "string" ? el.className : "")
    .trim().split(/\s+/).filter(scrClassOk).slice(0, 2)
    .map(function (c) { return "." + c; }).join("");
  let tx = "";
  try { tx = (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 28); } catch (_) { }
  return '<i class="bi bi-braces"></i><span class="scr-tn-tag">' + esc(tag + id + cls) + "</span>" +
    (tx ? '<span class="scr-tn-tx">' + esc(tx) + "</span>" : "");
}

/* 把 root 的子树拍平成带缩进的行（限深度 / 数量，页面再大也不卡） */
function scrViewerTree(rootEl, selEl) {
  const box = $("scrVwTree");
  if (!box) return;
  const nodes = [];
  const html = [];
  const MAX_NODES = 600, MAX_DEPTH = 8;
  (function walk(el, depth) {
    if (!el || el.nodeType !== 1 || nodes.length >= MAX_NODES) return;
    const idx = nodes.length;
    nodes.push(el);
    html.push('<div class="scr-tnode' + (el === selEl ? " on" : "") + '" data-i="' + idx + '"' +
      (depth ? ' style="padding-left:' + (8 + depth * 14) + 'px"' : "") + ">" +
      scrNodeLabel(el) + "</div>");
    if (depth >= MAX_DEPTH) return;
    const kids = el.children;
    for (let i = 0; i < kids.length; i++) walk(kids[i], depth + 1);
  })(rootEl, 0);
  box.innerHTML = html.join("") || '<div class="scr-vw-empty">没有可显示的节点</div>';
  SCR.viewerNodes = nodes;
  SCR.viewerRoot = rootEl;
  const cur = box.querySelector(".scr-tnode.on");
  if (cur) { try { cur.scrollIntoView({ block: "nearest" }); } catch (_) { } }
}

/* 选中树节点：算「相对列表项」的 XPath / CSS，并显示该节点 HTML */
function scrViewerSelect(el) {
  SCR.viewerSel = el;
  const box = $("scrVwTree");
  if (box) {
    box.querySelectorAll(".scr-tnode").forEach(function (n) {
      n.classList.toggle("on", SCR.viewerNodes[Number(n.dataset.i)] === el);
    });
  }
  const root = SCR.viewerRoot;
  const xp = el === root ? "." : scrXPathOf(el, root);
  const css = el === root ? "." : scrRelSel(el, root);
  SCR.viewerXp = xp || "";
  SCR.viewerCss = css || "";
  if ($("scrVwXp")) $("scrVwXp").textContent = SCR.viewerXp || "(空)";
  if ($("scrVwCss")) $("scrVwCss").textContent = SCR.viewerCss || "(空)";
  if ($("scrVwHtml")) $("scrVwHtml").textContent = (el.outerHTML || "").slice(0, 4000);
  scrViewerAttrs(el);
}

/* 列出节点上的所有属性（data-* 排最前），点「用」= 把字段设成取这个属性 */
function scrViewerAttrs(el) {
  const box = $("scrVwAttrs");
  if (!box) return;
  if (!el || !el.attributes) { box.innerHTML = ""; return; }
  const list = [];
  for (let i = 0; i < el.attributes.length; i++) {
    const a = el.attributes[i];
    if (!a || !a.name) continue;
    list.push({ name: a.name, value: String(a.value == null ? "" : a.value) });
  }
  if (!list.length) {
    box.innerHTML = '<div class="scr-vw-sec">属性</div><div class="scr-vw-tip">这个节点没有属性</div>';
    return;
  }
  list.sort(function (a, b) {
    const da = /^data-/.test(a.name) ? 0 : 1;
    const db = /^data-/.test(b.name) ? 0 : 1;
    if (da !== db) return da - db;
    return a.name < b.name ? -1 : 1;
  });
  box.innerHTML = '<div class="scr-vw-sec">属性（点「用」直接取这个值）</div>' +
    list.map(function (a) {
      const v = a.value.length > 46 ? a.value.slice(0, 46) + "…" : a.value;
      return '<div class="scr-atr">' +
        '<code class="scr-atr-n">' + esc(a.name) + "</code>" +
        '<code class="scr-atr-v" title="' + scrA(a.value) + '">' + esc(v) + "</code>" +
        '<button class="scr-mini" data-attr="' + scrA(a.name) + '" title="把该字段设为取这个属性">用</button>' +
        "</div>";
    }).join("");
}

/* 用属性重设当前字段：选择器仍是相对列表项的，取值方式改成「属性」 */
function scrViewerUseAttr(name) {
  const f = SCR.viewerField;
  if (!f) { toast("先选一个字段", "warn"); return; }
  let css = "", xp = "";
  if (SCR.interactive) {
    // 交互预览读不到 DOM，用代理脚本回传的选择器
    css = SCR.viewerCss || "";
    xp = SCR.viewerXp || "";
    if (!css) { toast("先在左边树里选一个节点", "warn"); return; }
  } else {
    const el = SCR.viewerSel;
    if (!el) { toast("先在左边树里选一个节点", "warn"); return; }
    const root = SCR.viewerRoot;
    css = el === root ? "." : scrRelSel(el, root);
    xp = el === root ? "." : scrXPathOf(el, root);
  }
  f.type = "attr";
  f.attr = name;
  f.syntax = "css";
  f.selector = css || ".";
  f.css = f.selector;
  f.xpath = xp || "";
  if (!f.name || /^字段\d+$/.test(f.name)) f.name = name;   // 没起过名就用属性名
  scrRenderFields();
  scrSaveDraft();
  const vw = $("scrViewer");
  if (vw) vw.hidden = true;
  scrHover(null);
  toast("已设为取属性 " + name + "（" + f.selector + "）", "ok");
}

/* 打开元素树：以「字段所属的列表项」为根，选中当前字段元素 */
/* 统计一个选择器在某个范围里匹配多少个（CSS / XPath 都支持，非法返回 -1） */
function scrCountIn(scope, sel, doc) {
  const s = String(sel || "").trim();
  if (!s) return 0;
  if (scrIsXPath(s)) {
    const res = scrEvalXPath(doc, scope, s);
    if (res === null) return -1;
    return Array.isArray(res) ? res.length : 1;
  }
  try { return scope.querySelectorAll(s).length; } catch (_) { return -1; }
}

/* 字段在当前页面上定位不到时，说明「为什么」+ 给出下一步建议 */
function scrViewerDiag(f, doc, items) {
  const sel = String(f.selector || "").trim();
  const itemSel = String(SCR.itemSel || "").trim();
  const inDoc = scrCountIn(doc, sel, doc);
  const inItem = items.length ? scrCountIn(items[0], sel, doc) : -1;
  const rows = [];
  const num = function (n) {
    return n < 0
      ? '<b class="bad">选择器不合法</b>'
      : (n ? '<b class="ok">' + n + "</b>" : '<b class="bad">0</b>');
  };
  rows.push('<div class="scr-diag-q"><i class="bi bi-question-circle"></i> 这个字段在当前页面里没匹配到元素</div>');
  rows.push('<div class="scr-diag-row">字段选择器 <code>' + esc(sel || "(空)") + "</code></div>");
  rows.push('<div class="scr-diag-row">· 在列表项内匹配 ' + num(inItem) + " 个 · 整页匹配 " + num(inDoc) + " 个</div>");
  rows.push('<div class="scr-diag-row">列表项选择器 <code>' + esc(itemSel || "(空)") + "</code> · 匹配 " + num(items.length) + " 项</div>");
  const tips = [];
  if (!sel) {
    tips.push("这个字段还没有选择器：在左边树里点一个节点，再点「用这个 CSS」；想取自定义 id 就点属性行右边的「用」。");
  }
  if (!items.length) {
    tips.push("列表项选择器都匹配不到，说明页面结构和保存规则时不一样了：换页 / 换站，或这页内容是 JS 渲染出来的（在「高级」里勾选「浏览器渲染」后重新抓取）。");
  } else if (inDoc > 0) {
    tips.push("整页能匹配、列表项内匹配不到：字段多半选到了列表项外面，重新点选列表项内部的内容即可。");
  } else {
    tips.push("整页也没有这个元素：多半是换页 / 换站，或者元素由脚本动态生成（用「浏览器渲染」重新抓取）。");
  }
  tips.push("也可以直接在左侧树里点选节点，再点「用这个 CSS / XPath」重设该字段。");
  if (!items.length) tips.push("左侧现在是整页树，选出来的路径是整页绝对路径（每行都会相同），修好列表项后再选。");
  rows.push('<ul class="scr-diag-tips">' + tips.map(function (t) { return "<li>" + esc(t) + "</li>"; }).join("") + "</ul>");
  return rows.join("");
}

function scrOpenViewer(f) {
  if (SCR.interactive) { scrAgentViewer(f); return; }
  const box = $("scrViewer");
  if (!box || !f) return;
  box.hidden = false;
  SCR.viewerField = f;
  SCR.viewerNodes = [];
  SCR.viewerSel = null;
  SCR.viewerXp = "";
  SCR.viewerCss = "";
  const doc = scrFrameDoc();
  const tree = $("scrVwTree");
  const diag = $("scrVwDiag");
  if (diag) { diag.innerHTML = ""; diag.hidden = true; }
  if (!doc) {
    if (tree) tree.innerHTML = '<div class="scr-vw-empty">先把页面抓下来，再查看元素</div>';
    return;
  }
  const items = scrItemNodes(doc);
  const el = scrFindFieldEl(f, doc);
  // 找不到字段也照样出树：优先用第一个列表项做根，连列表项都没有就用整页
  const root = (el && (scrItemRootOf(el, doc) || el.parentElement)) || items[0] || doc.body;
  if ($("scrVwRoot")) {
    $("scrVwRoot").textContent = el
      ? "· 相对列表项 " + (SCR.itemSel || "(未设置)")
      : "· " + (items.length ? "列表项内选节点" : "整页（列表项未匹配）");
  }
  scrViewerTree(root, el);
  if (el) {
    scrViewerSelect(el);
  } else {
    if ($("scrVwXp")) $("scrVwXp").textContent = f.xpath || "(未匹配到)";
    if ($("scrVwCss")) $("scrVwCss").textContent = f.css || (scrIsXPath(f.selector) ? "(未匹配到)" : (f.selector || "(空)"));
    if ($("scrVwHtml")) $("scrVwHtml").textContent = "";
    if ($("scrVwAttrs")) $("scrVwAttrs").innerHTML = "";
    if (diag) { diag.innerHTML = scrViewerDiag(f, doc, items); diag.hidden = false; }
  }
}

/* ---------------- 选择器辅助：自动识别 / 匹配数 ---------------- */
function scrItemCountLocal(showToast) {
  if (SCR.interactive) return scrAgentCount();
  const doc = scrFrameDoc();
  const badge = $("scrItemCount");
  if (!badge) return 0;
  if (!doc || !SCR.itemSel) {
    badge.textContent = "";
    badge.className = "scr-badge";
    return 0;
  }
  const nodes = scrItemNodes(doc);   // CSS / XPath 都支持
  const n = nodes.length;
  badge.textContent = "匹配 " + n + " 项";
  badge.className = "scr-badge" + (n ? " ok" : " bad");
  // 把命中的行框出来，一眼能看出选择器选对了没有（只框前 200 个，页面再大也不卡）
  try {
    doc.querySelectorAll(".scr-match").forEach(function (x) { x.classList.remove("scr-match"); });
    nodes.slice(0, 200).forEach(function (x) { x.classList.add("scr-match"); });
  } catch (_) { }
  if (showToast) toast(n ? ("当前页匹配到 " + n + " 个列表项") : "没有匹配到元素", n ? "ok" : "warn");
  return n;
}

function scrGuessList() {
  if (SCR.itemLock) { toast("列表项选择器已锁定（点 🔒 解锁后再识别）", "warn"); return; }
  if (SCR.interactive) {
    // 交互页读不到 DOM：让代理脚本用同一套启发式识别，回传选择器
    scrAgentCall("guess", {}, 10000).then(function (d) {
      if (!d || !d.selector) { toast("没识别出明显的列表，直接点页面上的一条数据试试", "warn"); return; }
      SCR.itemSel = d.selector;
      $("scrItemSel").value = d.selector;
      scrItemCountLocal();
      scrSaveDraft();
      toast("识别到 " + (d.count || 0) + " 条：" + d.selector, "ok");
    });
    return;
  }
  const doc = scrFrameDoc();
  if (!doc) { toast("先抓取一个页面", "warn"); return; }
  const groups = {};
  const all = doc.querySelectorAll("body *");
  const limit = Math.min(all.length, 2500);
  for (let i = 0; i < limit; i++) {
    const el = all[i];
    const tag = el.tagName.toLowerCase();
    if (tag === "script" || tag === "style" || tag === "br") continue;
    const cls = Array.prototype.slice.call(el.classList || []).filter(scrClassOk);
    let key = "";
    if (cls.length) key = tag + "." + cls[0];
    else if (["li", "tr", "article", "dd"].indexOf(tag) >= 0) key = tag;
    else continue;
    const g = groups[key] || (groups[key] = { key: key, n: 0, text: 0 });
    g.n++;
    g.text += (el.textContent || "").length;
  }
  let best = null;
  Object.keys(groups).forEach(function (k) {
    const g = groups[k];
    if (g.n < 3) return;
    if (g.text / g.n < 8) return;                     // 基本没文字的多半是布局容器
    if (!best) { best = g; return; }
    if (g.n > best.n || (g.n === best.n && g.text / g.n > best.text / best.n)) best = g;
  });
  if (!best) { toast("没识别出明显的列表，直接点页面上的一条数据试试", "warn"); return; }
  SCR.itemSel = best.key;
  $("scrItemSel").value = best.key;
  scrItemCountLocal();
  scrSaveDraft();
  toast("识别到 " + best.n + " 条：" + best.key, "ok");
}

/* ---------------- 本地预览提取 ---------------- */
/* 预览页里的图片地址被改写成了本地代理（/api/scraper/proxy?u=…），
   表格里要显示 / 导出成原图地址，不能把代理地址当成数据 */
function scrUnproxy(v) {
  const s = String(v == null ? "" : v);
  if (s.indexOf("/api/scraper/proxy?") < 0) return s;
  return s.replace(
    /https?:\/\/[^/"'\s]+\/api\/scraper\/proxy\?u=([^&"'\s]+)(?:&(?:amp;)?ref=[^"'\s&]*)?/g,
    function (m, enc) {
      try { return decodeURIComponent(enc); } catch (_) { return m; }
    }
  );
}

/* ---------------- XPath 支持 ----------------
   以 / 或 (// 开头的选择器当 XPath；其余仍是 CSS。
   `//a` 会自动补成 `.//a`（相对当前列表项），和后端 lxml 片段的语义保持一致。 */
function scrIsXPath(sel) {
  const s = String(sel || "").trim();
  return s.indexOf("/") === 0 || s.indexOf(".//") === 0 ||
    s.indexOf("(//") === 0 || s.indexOf("(.//") === 0;
}

function scrXPathExpr(sel) {
  const s = String(sel || "").trim();
  return s.indexOf("//") === 0 ? "." + s : s;
}

function scrEvalXPath(doc, root, sel) {
  const expr = scrXPathExpr(sel);
  try {
    const r = doc.evaluate(expr, root, null, XPathResult.ANY_TYPE, null);
    if (r.resultType === XPathResult.STRING_TYPE) return r.stringValue;
    if (r.resultType === XPathResult.NUMBER_TYPE) return String(r.numberValue);
    if (r.resultType === XPathResult.BOOLEAN_TYPE) return String(r.booleanValue);
    if (r.resultType === XPathResult.FIRST_ORDERED_NODE_TYPE) return r.singleNodeValue;
    const out = [];
    let n = null;
    while ((n = r.iterateNext())) out.push(n);
    return out;
  } catch (_) {
    return null;
  }
}

/* 生成元素对应的 XPath（相对列表项 root，形如 .//div[2]/a[1]） */
function scrXPathOf(el, root) {
  const segs = [];
  let cur = el;
  let guard = 0;
  while (cur && cur.nodeType === 1 && cur !== root && guard++ < 30) {
    const tag = cur.tagName.toLowerCase();
    if (tag === "html" || tag === "body") break;
    const parent = cur.parentElement;
    let idx = 1;
    if (parent) {
      const sibs = Array.prototype.filter.call(parent.children, function (x) {
        return x.tagName === cur.tagName;
      });
      idx = Math.max(1, sibs.indexOf(cur) + 1);
    }
    segs.unshift(tag + "[" + idx + "]");
    cur = cur.parentElement;
  }
  if (root && cur === root) return segs.length ? ".//" + segs.join("/") : ".";
  return "//" + segs.join("/");
}

/* 当前页面里所有「列表项」节点（CSS / XPath 都支持） */
function scrItemNodes(doc) {
  const sel = String(SCR.itemSel || "").trim();
  if (!sel) return [];
  if (scrIsXPath(sel)) {
    const res = scrEvalXPath(doc, doc, sel);
    const arr = Array.isArray(res) ? res : (res ? [res] : []);
    return arr.filter(function (n) { return n && n.nodeType === 1; });
  }
  try { return Array.prototype.slice.call(doc.querySelectorAll(sel)); } catch (_) { return []; }
}

/* 列表项选择器可能是 XPath：找出把 el 包在里面的那个「项」 */
function scrItemRootOf(el, doc) {
  const sel = String(SCR.itemSel || "").trim();
  if (!sel) return null;
  if (scrIsXPath(sel)) {
    const res = scrEvalXPath(doc, doc, sel);
    const arr = Array.isArray(res) ? res : (res ? [res] : []);
    let best = null;
    arr.forEach(function (n) {
      if (!n || n.nodeType !== 1 || !n.contains(el)) return;
      if (!best || best.contains(n)) best = n;
    });
    return best;
  }
  try { return el.closest(sel); } catch (_) { return null; }
}

function scrValueFromEl(el, f, doc) {
  if (!el) return "";
  if (f.type === "html") return scrUnproxy((el.innerHTML || "").trim());
  if (f.type === "attr") {
    let v = el.getAttribute(f.attr || "href") || "";
    if (v && (f.attr === "href" || f.attr === "src")) {
      try { v = new URL(v, SCR.pageUrl || doc.baseURI || location.href).href; } catch (_) { }
    }
    return scrUnproxy(v);
  }
  return scrUnproxy((el.innerText || el.textContent || "").replace(/\s+/g, " ").trim());
}

function scrLocalValue(root, f, doc) {
  const sel = (f.selector || "").trim();
  if (scrIsXPath(sel)) {
    const res = scrEvalXPath(doc, root, sel);
    if (typeof res === "string") return scrUnproxy(res);       // //a/@href、//span/text()
    const el = Array.isArray(res) ? res[0] : res;
    return scrValueFromEl(el, f, doc);
  }
  let el = null;
  if (!sel || sel === ".") el = root;
  else {
    // 只在「这一行」里查，查不到就留空（绝不要退化成全文档第一个匹配：
    // 那样每一行都会拿到同一个元素，看着就是「全部数据都一样」）
    try { el = root.querySelector(sel); } catch (_) { el = null; }
    if (!el && f.abs) { try { el = doc.querySelector(sel); } catch (_) { } }
  }
  return scrValueFromEl(el, f, doc);
}

function scrPreviewLocal() {
  if (SCR.interactive) { scrPreviewAgent(); return; }   // 交互页：交给代理脚本在沙箱内提取
  const doc = scrFrameDoc();
  if (!doc) { toast("先抓取一个页面", "warn"); return; }
  if (!SCR.itemSel) { toast("先在页面上点选列表项", "warn"); return; }
  if (!SCR.fields.length) { toast("先添加至少一个字段", "warn"); return; }
  const roots = scrItemNodes(doc);
  if (!roots.length) {
    toast(scrIsXPath(SCR.itemSel) ? "当前页没有 XPath 匹配结果" : "当前页没有匹配到列表项", "warn");
    return;
  }
  const rows = roots.slice(0, 2000).map(function (r) {
    const row = {};
    SCR.fields.forEach(function (f) {
      row[f.name] = scrApplyRules(scrRawFieldValue(r, f, doc), f);
    });
    return row;
  });
  // 整列都空的字段 = 选择器在列表项里匹配不到（常见于点选时不小心点到了列表项外面）
  const emptyFields = SCR.fields.filter(function (f) {
    return rows.length > 0 && rows.every(function (r) {
      const v = r[f.name];
      return !String(v == null ? "" : v).trim();
    });
  });
  if (emptyFields.length) {
    toast("字段「" + emptyFields.map(function (f) { return f.name; }).join("、") +
      "」在列表项里没匹配到，请重新点选（要点列表项内部的内容）", "warn");
  }
  SCR.rowsAll = rows;
  scrFilterColsRefresh();
  scrApplyFilters({ local: true, total: roots.length });
  toast("当前页预览：" + (SCR.rows || []).length + " / " + roots.length + " 条", "ok");
}

/* 交互模式下的「预览当前页」：父页面读不到沙箱 DOM，
   让代理脚本在 iframe 里按规则提取，回传后走同一套结果渲染 / 筛选 */
function scrPreviewAgent() {
  if (!SCR.itemSel) { toast("先在页面上点选列表项", "warn"); return; }
  if (!SCR.fields.length) { toast("先添加至少一个字段", "warn"); return; }
  scrAgentCall("extract", { itemSel: SCR.itemSel, fields: SCR.fields }, 15000).then(function (d) {
    if (!d || d.error) {
      toast((d && d.error) || "提取失败：代理脚本没有响应（重新抓取试试）", "err");
      return;
    }
    SCR.rowsAll = d.rows || [];
    scrFilterColsRefresh();
    scrApplyFilters({ local: true, total: d.total || 0 });
    toast("当前页预览：" + (SCR.rows || []).length + " / " + (d.total || 0) + " 条", "ok");
  });
}

/* ---------------- 结果筛选（自定义字符串规则） ----------------
   rowsAll 永远保存原始数据，筛选只影响 SCR.rows（表格展示 + 导出），
   所以随时「清除」就能回到全量。 */
const SCR_OP_TEXT = {
  contains: "包含", not_contains: "不包含", eq: "等于", ne: "不等于",
  regex: "正则", empty: "为空", not_empty: "不为空"
};

function scrFilterColsRefresh() {
  const sel = $("scrFCol");
  if (!sel) return;
  const cols = (SCR.columns && SCR.columns.length)
    ? SCR.columns
    : (SCR.fields || []).map(function (f) { return f.name; });
  const keep = sel.value;
  sel.innerHTML = '<option value="*">任意列</option>' + cols.map(function (c) {
    return '<option value="' + scrA(c) + '">' + esc(c) + "</option>";
  }).join("");
  if (keep && (keep === "*" || cols.indexOf(keep) >= 0)) sel.value = keep;
}

function scrRowMatch(row) {
  const cols = SCR.columns || [];
  const fs = SCR.filters || [];
  const tests = fs.map(function (r) {
    const val = (r.col === "*" || !r.col)
      ? cols.map(function (c) { return String(row[c] == null ? "" : row[c]); }).join(" ")
      : String(row[r.col] == null ? "" : row[r.col]);
    const v = String(r.value == null ? "" : r.value);
    switch (r.op) {
      case "empty": return !val.trim();
      case "not_empty": return !!val.trim();
      case "eq": return val.trim() === v.trim();
      case "ne": return val.trim() !== v.trim();
      case "not_contains": return v ? val.indexOf(v) < 0 : true;
      case "regex":
        try { return new RegExp(v).test(val); } catch (_) { return true; }
      default: return v ? val.indexOf(v) >= 0 : true;
    }
  });
  let ok = tests.length ? (SCR.filterAnd ? tests.every(Boolean) : tests.some(Boolean)) : true;
  if (ok && SCR.filterNoEmpty) {
    ok = cols.every(function (c) { return String(row[c] == null ? "" : row[c]).trim() !== ""; });
  }
  return ok;
}

function scrApplyFilters(meta) {
  if (meta) SCR.lastMeta = meta;
  const all = SCR.rowsAll || [];
  const rows = all.filter(scrRowMatch);
  scrRenderResult(rows, Object.assign({}, SCR.lastMeta || {}, { all: all.length }));
  scrRenderFilterChips();
  return rows;
}

function scrRenderFilterChips() {
  const box = $("scrFChips");
  if (!box) return;
  const fs = SCR.filters || [];
  box.innerHTML = fs.map(function (r, i) {
    const col = (r.col === "*" || !r.col) ? "任意列" : r.col;
    const val = (r.op === "empty" || r.op === "not_empty") ? "" : ("「" + r.value + "」");
    return '<span class="scr-chip" data-fi="' + i + '">' +
      esc(col) + " " + (SCR_OP_TEXT[r.op] || r.op) + " " + esc(val) +
      '<i class="bi bi-x" title="删除这条规则"></i></span>';
  }).join("") + (SCR.filterNoEmpty ? '<span class="scr-chip static">丢弃空值行</span>' : "");

  const n = fs.length + (SCR.filterNoEmpty ? 1 : 0);
  const all = (SCR.rowsAll || []).length;
  const shown = (SCR.rows || []).length;
  const badge = $("scrFilterBadge");
  if (badge) badge.textContent = n ? ("（" + shown + "/" + all + "）") : "";
  const cnt = $("scrFCount");
  if (cnt) cnt.textContent = n ? ("已筛选 " + shown + " / " + all + " 行") : ("共 " + all + " 行");
}

function scrAddFilter() {
  const col = ($("scrFCol") && $("scrFCol").value) || "*";
  const op = ($("scrFOp") && $("scrFOp").value) || "contains";
  const val = (($("scrFVal") && $("scrFVal").value) || "").trim();
  if (op !== "empty" && op !== "not_empty" && !val) {
    toast("先填要筛选的字符串（比如广告行可以选「链接 · 不包含 · bilibili.com/video」）", "warn");
    if ($("scrFVal")) $("scrFVal").focus();
    return;
  }
  SCR.filters.push({ col: col, op: op, value: val });
  if ($("scrFVal")) $("scrFVal").value = "";
  scrApplyFilters();
}

/* ---------------- 渲染结果表 ---------------- */
const SCR_RES_PAGE = 50;          // 结果表每页显示多少行（分页查看全量数据）

function scrRenderResult(rows, meta) {
  meta = meta || {};
  if (rows !== SCR.__lastRows) SCR.resPage = 1;   // 新数据 / 重新筛选 → 回到第 1 页
  SCR.__lastRows = rows || null;
  SCR.rows = rows || [];
  SCR.columns = SCR.columns && SCR.columns.length
    ? SCR.columns
    : (SCR.rows[0] ? Object.keys(SCR.rows[0]) : SCR.fields.map(function (f) { return f.name; }));
  if (SCR.rows[0]) SCR.columns = Object.keys(SCR.rows[0]);

  const wrap = $("scrTableWrap");
  const counts = $("scrCounts");
  if (!wrap || !counts) return;

  const allN = Number(meta.all) || SCR.rows.length;
  if (!SCR.rows.length) {
    wrap.innerHTML = '<div class="scr-tblempty">' +
      (allN
        ? "筛选后没有符合条件的行：调整条件，或点「清除」回到全量"
        : "没有提取到数据：检查一下列表项 / 字段选择器是否匹配") + "</div>";
    counts.textContent = allN ? ("筛选后 0 / " + allN + " 行") : "0 行";
    return;
  }

  const pages = Math.max(1, Math.ceil(SCR.rows.length / SCR_RES_PAGE));
  SCR.resPage = Math.min(Math.max(1, SCR.resPage || 1), pages);
  const start = (SCR.resPage - 1) * SCR_RES_PAGE;
  const view = SCR.rows.slice(start, start + SCR_RES_PAGE);

  counts.innerHTML = "共 <b>" + SCR.rows.length + "</b> 行" +
    (allN > SCR.rows.length ? '<span class="scr-counts-dim">（原始 ' + allN + " 行，已筛选）</span>" : "") +
    " · " + SCR.columns.length + " 列" +
    (meta.total ? '（当前页匹配 ' + meta.total + " 项）" : "") +
    (meta.pages ? " · 翻了 " + meta.pages + " 页" : "") +
    (meta.scroll ? " · 滚动加载 " + meta.scroll + " 次" : "") +
    (pages > 1 ? ' · 第 <b>' + SCR.resPage + "</b> / " + pages + " 页" : "");

  const head = ['<table class="scr-table"><thead><tr><th style="width:52px">#</th>'].concat(
    SCR.columns.map(function (c) { return "<th>" + esc(c) + "</th>"; })
  ).join("");
  const body = view.map(function (r, i) {
    const tds = SCR.columns.map(function (c) {
      const v = r[c] == null ? "" : String(r[c]);
      return '<td title="' + scrA(v) + '">' + esc(v) + "</td>";
    }).join("");
    return "<tr><td class='num'>" + (start + i + 1) + "</td>" + tds + "</tr>";
  }).join("");
  const pager = pages > 1
    ? '<div class="scr-pager">' +
      '<span class="scr-pager-info">第 <b>' + SCR.resPage + "</b> / " + pages + " 页 · 每页 " + SCR_RES_PAGE + " 行</span>" +
      '<button class="scr-mini" data-scr-page="first"' + (SCR.resPage <= 1 ? " disabled" : "") + '>首页</button>' +
      '<button class="scr-mini" data-scr-page="prev"' + (SCR.resPage <= 1 ? " disabled" : "") + '>上一页</button>' +
      '<button class="scr-mini" data-scr-page="next"' + (SCR.resPage >= pages ? " disabled" : "") + '>下一页</button>' +
      '<button class="scr-mini" data-scr-page="last"' + (SCR.resPage >= pages ? " disabled" : "") + '>末页</button>' +
      '<input class="scr-in scr-pager-jump" id="scrPagerJump" type="number" min="1" max="' + pages +
        '" value="' + SCR.resPage + '" title="输入页码后回车跳转">' +
      '<span class="scr-pager-info">页</span>' +
      "</div>"
    : "";
  wrap.innerHTML = head + "</tr></thead><tbody>" + body + "</tbody></table>" + pager;

  if (SCR.resultMin) {
    SCR.resultMin = false;
    $("scrResult").classList.remove("min");
    const tg = $("scrResultToggle");
    if (tg) tg.className = "bi bi-chevron-down";
  }
}

function scrRenderLogs(logs) {
  const box = $("scrLogs");
  if (!box) return;
  if (!logs || !logs.length) { box.hidden = true; box.innerHTML = ""; return; }
  box.hidden = false;
  box.innerHTML = logs.map(function (l) {
    return l.ok
      ? '<div class="ok">第 ' + l.page + " 页 · 抓到 " + (l.found || 0) + " 条（新增 " + (l.added || 0) +
        "）· " + (l.cost_ms || 0) + " ms</div>"
      : '<div class="bad">第 ' + l.page + " 页失败：" + esc(l.error || "") + "</div>";
  }).join("");
}

/* ---------------- 采集 / 导出 ---------------- */
const SCR_EXP_NAMES = { csv: "CSV", xlsx: "Excel 工作簿", json: "JSON" };

/* 导出先弹二次确认，确认后才真正下载 */
function scrExportAsk(fmt) {
  if (!SCR.rows.length) { toast("还没有数据可导出", "warn"); return; }
  const pop = $("scrExpPop");
  if (!pop) { scrExport(fmt); return; }
  SCR.expFmt = fmt;
  const n = $("scrExpName");
  if (n) n.textContent = SCR_EXP_NAMES[fmt] || fmt;
  const r = $("scrExpRows");
  if (r) r.textContent = SCR.rows.length;
  scrPopHide($("scrAiPop"));
  scrPopHide($("scrDlPop"));
  pop.hidden = false;
}

function scrCollectCfg() {
  return {
    item_selector: SCR.itemSel,
    fields: SCR.fields,
    pages: SCR.pages,
    page_mode: SCR.pageMode,
    url_template: SCR.urlTemplate,
    next_selector: SCR.nextSel,
    delay_ms: SCR.delay,
    insecure: SCR.insecure,
    timeout: SCR.fetchTimeout || 30,
    ua: SCR.ua,
    cookie: SCR.cookie,
    render: SCR.render,
    // 滚动加载模式下，滚动次数用「翻页 → 最多滚动」那个值
    scroll_times: SCR.pageMode === "scroll" ? SCR.scrollLoops : SCR.scrollTimes,
    scroll_loops: SCR.scrollLoops,
    low_mem: !!SCR.lowMem,
  };
}

async function scrRun() {
  if (SCR.busy) return;
  const url = ($("scrUrl").value || "").trim() || SCR.url;
  if (!url) { toast("请先输入网址", "warn"); return; }
  if (!SCR.itemSel) { toast("请先点选列表项", "warn"); return; }
  if (!SCR.fields.length) { toast("请先添加至少一个字段", "warn"); return; }
  if (SCR.pageMode === "url" && SCR.urlTemplate.indexOf("{page}") < 0) {
    toast("URL 模板里要有 {page} 占位符", "warn");
    return;
  }

  SCR.busy = true;
  $("scrRun").disabled = true;
  scrSetLoading(true, SCR.pageMode === "none" ? "正在采集…" : "正在翻页采集…");
  scrStat("采集中…");
  const body = Object.assign({ url: url, task_id: SCR.taskId, name: SCR.taskName }, scrCollectCfg());
  const d = await scrReq("/api/scraper/run", body);
  SCR.busy = false;
  $("scrRun").disabled = false;
  scrSetLoading(false);

  if (!d || d.error) {
    scrStat("采集失败：" + ((d && d.error) || "未知错误"), "bad");
    toast((d && d.error) || "采集失败", "err");
    return;
  }
  SCR.rowsAll = d.rows || [];
  scrFilterColsRefresh();
  scrApplyFilters(d.mode === "scroll"
    ? { scroll: d.scroll_times || 0 }
    : { pages: d.pages });
  scrRenderLogs(d.logs || []);
  // 整列都空 = 这个字段的选择器在列表项里匹配不到，提示用户重新点选
  const badCols = ((d.rows || []).length ? (d.columns || []) : []).filter(function (c) {
    return d.rows.every(function (r) { return !String(r[c] == null ? "" : r[c]).trim(); });
  });
  if (badCols.length) {
    toast("这些字段没采到内容：" + badCols.join("、") + "（检查选择器是否在列表项内部）", "warn");
  }
  scrStat("采集完成 · " + d.count + " 条" +
    (d.mode === "scroll"
      ? " · 滚动加载 " + (d.scroll_times || 0) + " 次"
      : " · " + (d.pages || 0) + " 页"), "ok");
  toast("采集完成：" + d.count + " 条数据", d.count ? "ok" : "warn");
  if (!SCR.taskName) SCR.taskName = "采集 " + (SCR.pageTitle || url);
  if (!$("scrTaskName").value) $("scrTaskName").value = SCR.taskName;
  scrLoadTasks();
}

async function scrExport(fmt) {
  if (!SCR.rows.length) { toast("还没有数据可导出", "warn"); return; }
  // 列以实际数据为准：换过字段 / 只预览过的时候 SCR.columns 可能是旧的
  const cols = (SCR.rows[0] && Object.keys(SCR.rows[0]).length)
    ? Object.keys(SCR.rows[0])
    : ((SCR.columns && SCR.columns.length) ? SCR.columns : SCR.fields.map(function (f) { return f.name; }));
  try {
    const r = await fetch("/api/scraper/export", {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rows: SCR.rows, columns: cols, format: fmt }),
    });
    if (!r.ok) {
      let msg = "HTTP " + r.status;
      try { const j = await r.json(); msg = j.error || msg; } catch (_) { }
      toast("导出失败：" + msg, "err");
      return;
    }
    const blob = await r.blob();
    const cd = r.headers.get("Content-Disposition") || "";
    const m = /filename="?([^"]+)"?/.exec(cd);
    const name = m ? m[1] : ("scrape." + fmt);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 3000);
    toast("已导出 " + name, "ok");
  } catch (e) {
    toast("导出失败：" + (e && e.message), "err");
  }
}

/* ---------------- 采集方案 ---------------- */
function scrCfgApplied(cfg) {
  cfg = cfg || {};
  SCR.itemSel = cfg.item_selector || "";
  SCR.fields = Array.isArray(cfg.fields) ? cfg.fields.map(function (f) {
    return {
      name: f.name || "", selector: f.selector || "", type: f.type || "text",
      attr: f.attr || "", multi: !!f.multi, abs: !!f.abs,
      syntax: f.syntax || (scrIsXPath(f.selector) ? "xpath" : "css"),
      css: f.css || "", xpath: f.xpath || "", html: f.html || "",
    };
  }) : [];
  SCR.pages = Math.max(1, Math.min(30, Number(cfg.pages) || 1));
  SCR.pageMode = ["none", "url", "next"].indexOf(cfg.page_mode) >= 0 ? cfg.page_mode : "none";
  SCR.urlTemplate = cfg.url_template || "";
  SCR.nextSel = cfg.next_selector || "";
  SCR.delay = Number(cfg.delay_ms) >= 0 ? Number(cfg.delay_ms) : 300;
  SCR.insecure = !!cfg.insecure;
  SCR.ua = cfg.ua || "";
  SCR.cookie = cfg.cookie || "";
  SCR.render = !!cfg.render;
  SCR.scrollTimes = Math.max(0, Math.min(20, Number(cfg.scroll_times) || 0));
  SCR.scrollLoops = Math.max(1, Math.min(20, Number(cfg.scroll_loops || cfg.scroll_times) || 6));
}

function scrApplyDraftToInputs() {
  const set = function (id, v) { const el = $(id); if (el && v != null) el.value = v; };
  set("scrUrl", SCR.url);
  set("scrItemSel", SCR.itemSel);
  set("scrTaskName", SCR.taskName);
  set("scrUrlTpl", SCR.urlTemplate);
  set("scrNextSel", SCR.nextSel);
  set("scrPages", SCR.pages);
  set("scrPages2", SCR.pages);
  set("scrUa", SCR.ua);
  set("scrCookie", SCR.cookie);
  set("scrDelay", SCR.delay);
  const pm = $("scrPageMode");
  if (pm) pm.value = SCR.pageMode;
  if ($("scrPageUrl")) $("scrPageUrl").hidden = SCR.pageMode !== "url";
  if ($("scrPageNext")) $("scrPageNext").hidden = SCR.pageMode !== "next";
  if ($("scrPageScroll")) $("scrPageScroll").hidden = SCR.pageMode !== "scroll";
  if ($("scrScrollLoops")) $("scrScrollLoops").value = SCR.scrollLoops || 6;
  if ($("scrInsecure")) $("scrInsecure").checked = SCR.insecure;
  if ($("scrRender")) $("scrRender").checked = !!SCR.render;
  if ($("scrLiveBtn")) $("scrLiveBtn").classList.toggle("on", !!SCR.live);
  if ($("scrScrollTimes")) $("scrScrollTimes").value = SCR.scrollTimes || "";
  if ($("scrNoImg")) $("scrNoImg").checked = !!SCR.noImg;
  if ($("scrLowMem")) $("scrLowMem").checked = !!SCR.lowMem;
  if ($("scrTimeout")) $("scrTimeout").value = SCR.fetchTimeout || 30;
  if ($("scrAdv")) $("scrAdv").hidden = !SCR.advOpen;
  if ($("scrAdvBtn")) $("scrAdvBtn").classList.toggle("on", SCR.advOpen);
  scrSyncLock();
  scrSyncRenderUI();
}

/* 🔒 锁定状态同步：图标 / 提示 / 输入框只读 */
function scrSyncLock() {
  const b = $("scrItemLock");
  if (b) {
    b.classList.toggle("on", !!SCR.itemLock);
    b.innerHTML = '<i class="bi bi-' + (SCR.itemLock ? "lock-fill" : "unlock") + '"></i>';
    b.title = SCR.itemLock
      ? "选择器已锁定：点选 / 自动识别不会再改动它，点击解锁"
      : "锁定选择器：锁定后点选 / 自动识别都不会再改动它";
  }
  const inp = $("scrItemSel");
  if (inp) inp.readOnly = !!SCR.itemLock;
}

/* ---------------- 交互预览：与代理脚本通信 ----------------
   交互模式下 iframe 是 sandbox="allow-scripts"（无 allow-same-origin），
   父页面读不到 contentDocument，点选 / 树 / 计数全部走 postMessage。 */
function scrAgentCall(cmd, data, timeout) {
  return new Promise(function (resolve) {
    const fr = $("scrFrame");
    const w = fr && fr.contentWindow;
    if (!w) return resolve(null);
    SCR.agentMap = SCR.agentMap || {};
    const id = "a" + (++SCR.agentSeq);
    const timer = setTimeout(function () { delete SCR.agentMap[id]; resolve(null); }, timeout || 6000);
    SCR.agentMap[id] = function (d) { clearTimeout(timer); resolve(d); };
    try {
      w.postMessage(Object.assign({ __scr: 1, cmd: cmd, id: id }, data || {}), "*");
    } catch (_) {
      clearTimeout(timer);
      resolve(null);
    }
  });
}

/* 代理脚本 ready：下发当前模式 + 已隐藏的浮层规则 */
function scrAgentReady() {
  SCR.agentReady = true;
  scrAgentCall("mode", { mode: SCR.mode, itemSel: SCR.itemSel });
  if ((SCR.hideSelectors || []).length) {
    scrAgentCall("hide", { selectors: SCR.hideSelectors });
  }
  scrAgentCount();
}

function scrAgentCount() {
  if (!SCR.interactive) return 0;
  scrAgentCall("count", { itemSel: SCR.itemSel }).then(function (d) {
    const n = (d && typeof d.count === "number") ? d.count : 0;
    if ($("scrItemCount")) {
      $("scrItemCount").textContent = "匹配 " + n + " 项";
      $("scrItemCount").className = "scr-badge" + (n ? " ok" : " bad");
    }
  });
  return 0;
}

function scrAgentOnMessage(e) {
  const fr = $("scrFrame");
  if (!fr || e.source !== fr.contentWindow) return;   // 只收自己 iframe 的消息
  const d = e.data || {};
  if (!d.__scr) return;
  if (d.id && SCR.agentMap && SCR.agentMap[d.id]) {
    SCR.agentMap[d.id](d);
    delete SCR.agentMap[d.id];
    return;
  }
  if (d.type === "ready") { scrAgentReady(); return; }
  if (d.type === "picked") { scrLivePicked(d); return; }
  if (d.type === "hiddenOne") {
    if (d.selector && (SCR.hideSelectors || []).indexOf(d.selector) < 0) {
      SCR.hideSelectors.push(d.selector);
      scrSaveDraft();
    }
    return;
  }
}

/* 交互模式下点选结果的落地（等价于静态模式的 scrPickItem / scrPickField） */
function scrLivePicked(d) {
  if (d.mode === "item") {
    if (d.pending) {                  // 调整中：先不保存，等用户在调整条上确认
      if (SCR.itemLock) { toast("列表项选择器已锁定（点 🔒 解锁后再选）", "warn"); return; }
      scrAdjUpdate(d.selector || "", null, d.count || 0);
      return;
    }
    SCR.itemSel = d.selector || "";
    if ($("scrItemSel")) $("scrItemSel").value = SCR.itemSel;
    if ($("scrItemCount")) {
      $("scrItemCount").textContent = "匹配 " + (d.count || 0) + " 项";
      $("scrItemCount").className = "scr-badge" + (d.count ? " ok" : " bad");
    }
    scrModeSet("field");
    scrSaveDraft();
    toast("已选中列表项：" + SCR.itemSel, "ok");
    return;
  }
  if (d.error === "not-in-item") {
    toast("这个元素不在列表项里：请点列表项内部的内容（标题 / 时间 / 链接 / 图片）", "warn");
    return;
  }
  const tag = d.tag || "";
  let name = tag === "a" ? "链接" : (tag === "img" ? "图片" : ((d.text || "").slice(0, 8) || tag || "字段"));
  const base = name;
  let i = 2;
  while (SCR.fields.some(function (f) { return f.name === name; })) { name = base + i; i++; }
  let type = "text", attr = "";
  if (tag === "a") { type = "attr"; attr = "href"; }
  else if (tag === "img") { type = "attr"; attr = "src"; }
  scrAddField({
    name: name, selector: d.css || "", css: d.css || "", xpath: d.xpath || "",
    syntax: "css", type: type, attr: attr, html: d.html || "",
  });
  scrSaveDraft();
  toast("已添加字段：" + (d.css || ""), "ok");
}

/* 交互模式的元素树：结构由代理脚本回传，这里只负责渲染 */
function scrViewerTreeData(rows, selIdx) {
  const box = $("scrVwTree");
  if (!box) return;
  SCR.viewerRows = rows || [];
  box.innerHTML = SCR.viewerRows.map(function (r) {
    const lb = r.label || {};
    return '<div class="scr-tnode' + (r.i === selIdx ? " on" : "") + '" data-i="' + r.i + '"' +
      (r.depth ? ' style="padding-left:' + (8 + r.depth * 14) + 'px"' : "") + ">" +
      '<i class="bi bi-braces"></i><span class="scr-tn-tag">' + esc(lb.tag || "") + "</span>" +
      (lb.text ? '<span class="scr-tn-tx">' + esc(lb.text) + "</span>" : "") +
      "</div>";
  }).join("") || '<div class="scr-vw-empty">没有可显示的节点</div>';
  const cur = box.querySelector(".scr-tnode.on");
  if (cur) { try { cur.scrollIntoView({ block: "nearest" }); } catch (_) { } }
}

function scrAgentSelectIndex(i) {
  const box = $("scrVwTree");
  if (box) {
    box.querySelectorAll(".scr-tnode").forEach(function (n) {
      n.classList.toggle("on", Number(n.dataset.i) === i);
    });
  }
  scrAgentCall("selectIndex", { index: i }).then(function (d) {
    if (!d || d.error) return;
    SCR.viewerXp = d.xpath || "";
    SCR.viewerCss = d.css || "";
    if ($("scrVwXp")) $("scrVwXp").textContent = SCR.viewerXp || "(空)";
    if ($("scrVwCss")) $("scrVwCss").textContent = SCR.viewerCss || "(空)";
    if ($("scrVwHtml")) $("scrVwHtml").textContent = d.html || "";
    scrViewerAttrsData(d.attrs || []);
  });
}

function scrViewerAttrsData(attrs) {
  const box = $("scrVwAttrs");
  if (!box) return;
  if (!attrs.length) {
    box.innerHTML = '<div class="scr-vw-sec">属性</div><div class="scr-vw-tip">这个节点没有属性</div>';
    return;
  }
  box.innerHTML = '<div class="scr-vw-sec">属性（点「用」直接取这个值）</div>' +
    attrs.map(function (a) {
      const v = a.value.length > 46 ? a.value.slice(0, 46) + "…" : a.value;
      return '<div class="scr-atr">' +
        '<code class="scr-atr-n">' + esc(a.name) + "</code>" +
        '<code class="scr-atr-v" title="' + scrA(a.value) + '">' + esc(v) + "</code>" +
        '<button class="scr-mini" data-attr="' + scrA(a.name) + '" title="把该字段设为取这个属性">用</button>' +
        "</div>";
    }).join("");
}

function scrAgentViewer(f) {
  const box = $("scrViewer");
  if (!box) return;
  box.hidden = false;
  SCR.viewerField = f;
  SCR.viewerNodes = [];
  SCR.viewerRows = [];
  SCR.viewerXp = "";
  SCR.viewerCss = "";
  const diag = $("scrVwDiag");
  if (diag) { diag.innerHTML = ""; diag.hidden = true; }
  if ($("scrVwAttrs")) $("scrVwAttrs").innerHTML = "";
  const tree = $("scrVwTree");
  if (tree) tree.innerHTML = '<div class="scr-vw-empty">正在读取页面结构…</div>';
  scrAgentCall("tree", { itemSel: SCR.itemSel, selector: f.selector }, 10000).then(function (d) {
    if (!d || !d.nodes) {
      if (tree) tree.innerHTML = '<div class="scr-vw-empty">读取失败：代理脚本没有响应（页面可能被站点重定向了），重新抓取试试</div>';
      return;
    }
    scrViewerTreeData(d.nodes, d.selIndex);
    if ($("scrVwRoot")) $("scrVwRoot").textContent = "· " + (d.rootLabel || "");
    if (d.found && d.selIndex >= 0) {
      scrAgentSelectIndex(d.selIndex);
    } else {
      if ($("scrVwXp")) $("scrVwXp").textContent = f.xpath || "(未匹配到)";
      if ($("scrVwCss")) $("scrVwCss").textContent = f.css || "(未匹配到)";
      if (diag) {
        diag.innerHTML = '<div class="scr-diag-q"><i class="bi bi-question-circle"></i> 这个字段在当前页面里没匹配到元素</div>' +
          '<div class="scr-diag-row">字段选择器 <code>' + esc(f.selector || "(空)") + "</code></div>" +
          '<ul class="scr-diag-tips"><li>在左边树里点一个节点，再点「用这个 CSS / XPath」重设该字段。</li>' +
          "<li>页面若是脚本渲染的，等它加载完再点（交互预览会执行站点脚本）。</li></ul>";
        diag.hidden = false;
      }
    }
  });
}

/* ---------------- 按站点隔离的配置 ----------------
   同一域名下换页面（首页 → 搜索页）选择器继续用；换了域名就把旧站点的配置收好，
   再恢复新站点上次的配置（没存过就清空）。这样既不会串台，
   切回原站点也能直接接着用。 */
function scrHostOf(u) {
  let host = "";
  try { host = new URL(String(u || ""), location.href).host.toLowerCase(); }
  catch (_) { return ""; }
  // 按主域归并：www.bilibili.com / search.bilibili.com 共用一套选择器，
  // 免得在「首页 → 搜索页」之间来回切时也被当成换站点。IP 地址原样保留。
  const parts = host.split(":");
  const bare = parts[0];
  const labels = bare.split(".");
  if (labels.length >= 3 && !/^\d+$/.test(labels[labels.length - 1])) {
    const last2 = labels.slice(-2).join(".");
    if (/^(com|net|org|gov|edu|co|ac)\.[a-z]{2}$/.test(last2) && labels.length >= 4) {
      return labels.slice(-3).join(".");
    }
    return last2;
  }
  return host;
}

function scrCloneFields() {
  return (SCR.fields || []).map(function (f) {
    return {
      name: f.name, selector: f.selector, type: f.type,
      attr: f.attr || "", multi: !!f.multi, abs: !!f.abs,
      syntax: f.syntax || "css", css: f.css || "", xpath: f.xpath || "", html: f.html || "",
    };
  });
}

function scrStashSite() {
  const key = SCR.siteKey;
  if (!key) return;
  SCR.sites[key] = {
    itemSel: SCR.itemSel || "",
    fields: scrCloneFields(),
    pageMode: SCR.pageMode,
    urlTemplate: SCR.urlTemplate,
    nextSel: SCR.nextSel,
    scrollLoops: SCR.scrollLoops,
    hideSelectors: (SCR.hideSelectors || []).slice(0, 200),
  };
  const keys = Object.keys(SCR.sites);
  if (keys.length > 20) delete SCR.sites[keys[0]];   // 只留最近 20 个站点
}

function scrApplySite(s) {
  s = s || {};
  SCR.itemSel = s.itemSel || "";
  SCR.fields = Array.isArray(s.fields) ? s.fields.map(function (f) {
    return {
      name: f.name || "", selector: f.selector || "", type: f.type || "text",
      attr: f.attr || "", multi: !!f.multi, abs: !!f.abs
    };
  }) : [];
  if (["none", "url", "next", "scroll"].indexOf(s.pageMode) >= 0) SCR.pageMode = s.pageMode;
  SCR.urlTemplate = s.urlTemplate || "";
  SCR.nextSel = s.nextSel || "";
  SCR.scrollLoops = Math.max(1, Math.min(20, Number(s.scrollLoops) || 6));
  SCR.hideSelectors = Array.isArray(s.hideSelectors) ? s.hideSelectors.slice(0, 200) : [];
  if ($("scrItemSel")) $("scrItemSel").value = SCR.itemSel;
  scrRenderFields();
  scrApplyDraftToInputs();
  scrRenderResult([], {});
  scrFilterColsRefresh();
  scrSaveDraft();
}

/* ---------------- 草稿：刷新 / 关掉页面再回来，选择器还在 ---------------- */
function scrDraftPayload() {
  return {
    url: (($("scrUrl") && $("scrUrl").value) || "").trim() || SCR.url,
    taskId: SCR.taskId || "",
    taskName: SCR.taskName || "",
    itemSel: SCR.itemSel || "",
    fields: SCR.fields || [],
    pages: SCR.pages, pageMode: SCR.pageMode,
    urlTemplate: SCR.urlTemplate, nextSel: SCR.nextSel,
    ua: SCR.ua, cookie: SCR.cookie, insecure: SCR.insecure,
    delay: SCR.delay, advOpen: SCR.advOpen,
    render: SCR.render, scrollTimes: SCR.scrollTimes, scrollLoops: SCR.scrollLoops,
    noImg: !!SCR.noImg, fetchTimeout: SCR.fetchTimeout || 30,
    lowMem: !!SCR.lowMem,
    live: !!SCR.live,
    itemLock: !!SCR.itemLock,
    hideSelectors: (SCR.hideSelectors || []).slice(0, 200),
    siteKey: SCR.siteKey || "",
    sites: SCR.sites || {},              // 各站点各存一套，切回来直接接着用
  };
}

function scrSaveDraft() {
  clearTimeout(SCR.saveTimer);
  scrStashSite();                        // 当前站点的改动先归位，再落盘
  SCR.saveTimer = setTimeout(function () {
    try { localStorage.setItem(SCR_DRAFT_KEY, JSON.stringify(scrDraftPayload())); } catch (_) { }
  }, 250);
}

function scrRestoreDraft() {
  let d = null;
  try { d = JSON.parse(localStorage.getItem(SCR_DRAFT_KEY) || "null"); } catch (_) { d = null; }
  if (!d) return;
  scrCfgApplied({
    item_selector: d.itemSel || "",
    fields: Array.isArray(d.fields) ? d.fields : [],
    pages: d.pages, page_mode: d.pageMode,
    url_template: d.urlTemplate, next_selector: d.nextSel,
    delay_ms: d.delay, insecure: d.insecure,
    ua: d.ua, cookie: d.cookie,
    render: d.render, scroll_times: d.scrollTimes, scroll_loops: d.scrollLoops,
  });
  SCR.url = d.url || "";
  SCR.taskId = d.taskId || "";
  SCR.taskName = d.taskName || "";
  SCR.advOpen = !!d.advOpen;
  SCR.live = !!d.live;
  SCR.noImg = !!d.noImg;
  SCR.lowMem = !!d.lowMem;
  SCR.fetchTimeout = Math.max(5, Math.min(60, Number(d.fetchTimeout) || 30));
  SCR.itemLock = !!d.itemLock;
  SCR.hideSelectors = Array.isArray(d.hideSelectors) ? d.hideSelectors.slice(0, 200) : [];
  SCR.sites = (d.sites && typeof d.sites === "object") ? d.sites : {};
  SCR.siteKey = d.siteKey || scrHostOf(SCR.url);
}

/* ---------------- 点选模式切换 ---------------- */
function scrModeSet(mode) {
  SCR.mode = ["item", "field", "clean", ""].indexOf(mode) >= 0 ? mode : "";
  // 离开「点选列表项」模式时，未确认的调整作废
  if (SCR.mode !== "item") scrAdjCancel(true);
  // 只挑点选模式按钮：工具条最右的「滚动加载更多 / 恢复浮层」也是 .scr-mode，但不参与模式切换
  document.querySelectorAll(".scr-mode[data-scr-mode]").forEach(function (b) {
    b.classList.toggle("on", (b.dataset.scrMode || "") === SCR.mode);
  });
  // 「交互模式」按钮：当前页面是交互页且处于浏览状态时点亮（切到点选就熄灭，不刷新页面）
  const lb = $("scrLiveBtn");
  if (lb) lb.classList.toggle("on", !!SCR.interactive && SCR.mode === "");
  const tip = $("scrTip");
  if (tip) {
    tip.textContent = SCR.mode === "item"
      ? "① 在左侧页面上点任意一条数据（整行 / 整张卡片）"
      : (SCR.mode === "field"
        ? "② 在左侧页面上点要采集的内容（标题 / 时间 / 链接 / 图片）"
        : (SCR.mode === "clean"
          ? "清浮层：先自动清掉明显的广告 / 弹窗，剩下的点哪个清哪个"
          : (SCR.live
            ? "交互模式：正常浏览器状态，可滚动 / 点击 / 播放，不会生成选择器"
            : "点「交互模式」可进入正常浏览器状态")));
  }
  scrHover(null);
  if (SCR.interactive) {
    // 交互预览（跨源沙箱）：指令发给代理脚本
    scrAgentCall("mode", { mode: SCR.mode, itemSel: SCR.itemSel });
    if (SCR.mode === "clean") {
      scrAgentCall("clean", {}, 10000).then(function (d) {
        if (d && d.selectors) {
          SCR.hideSelectors = d.selectors.slice(0, 200);
          scrSaveDraft();
        }
        if (d && d.count) toast("已自动清理 " + d.count + " 个浮层，剩下的点一下就能清掉", "ok");
      });
    }
    return;
  }
  const doc = scrFrameDoc();
  if (doc && doc.body) {
    doc.body.classList.toggle("scr-picking", !!SCR.mode);
    doc.body.classList.toggle("scr-cleaning", SCR.mode === "clean");
  }
  if (SCR.mode === "clean" && doc) scrAutoHideOverlays(doc);
}

/* ---------------- 采集方案（侧栏列表） ---------------- */
function scrRenderTasks() {
  const box = document.getElementById("scrTaskList");
  if (!box) return;
  const tasks = SCR.tasks || [];
  if (!tasks.length) {
    box.innerHTML = '<div class="scrp-empty">还没有保存的采集方案。<br>打开工作台点选页面元素后，点「保存」即可留在这里。</div>';
    return;
  }
  box.innerHTML = tasks.map(function (t) {
    const cfg = t.cfg || {};
    const fc = Array.isArray(cfg.fields) ? cfg.fields.length : 0;
    const host = String(t.url || "").replace(/^https?:\/\//, "");
    return '<div class="scrp-item" data-id="' + scrA(t.id) + '" title="' + scrA(t.url || "") + '">' +
      '<i class="bi bi-radar"></i>' +
      '<div class="scrp-main">' +
        '<div class="scrp-name">' + esc(t.name || "未命名方案") + '</div>' +
        '<div class="scrp-sub">' + esc(host.slice(0, 46)) +
          (fc ? " · " + fc + " 字段" : "") +
          (t.rows ? " · " + t.rows + " 条" : "") + '</div>' +
      '</div>' +
      '<button class="scrp-del" data-id="' + scrA(t.id) + '" data-name="' + scrA(t.name || "") +
        '" title="删除方案"><i class="bi bi-trash3"></i></button>' +
    '</div>';
  }).join("");
}

async function scrLoadTasks(showToast) {
  try {
    const r = await fetch("/api/scraper/tasks", { credentials: "same-origin", cache: "no-store" });
    const d = await r.json();
    if (!d || !d.ok) throw new Error((d && d.error) || ("HTTP " + r.status));
    SCR.tasks = d.tasks || [];
    scrRenderTasks();
    if (showToast) toast("方案列表已刷新（" + SCR.tasks.length + " 个）", "ok");
  } catch (e) {
    if (showToast) toast("读取采集方案失败：" + (e && e.message), "err");
  }
}

function scrOpenTask(id) {
  const t = (SCR.tasks || []).filter(function (x) { return x.id === id; })[0];
  if (!t) { toast("方案不存在，刷新一下列表", "warn"); return; }
  scrOpenCenter();
  scrStashSite();                       // 先把当前站点的配置收好
  scrCfgApplied(t.cfg || {});
  SCR.taskId = t.id || "";
  SCR.taskName = t.name || "";
  SCR.url = t.url || "";
  // 方案自带网址：把「当前站点」直接对齐它，避免接下来抓取时被当成切站而清空方案配置
  SCR.siteKey = scrHostOf(SCR.url) || SCR.siteKey;
  if ($("scrSiteName")) $("scrSiteName").textContent = SCR.siteKey || "";
  SCR.rows = [];
  SCR.rowsAll = [];
  SCR.columns = [];
  scrRenderFields();
  scrApplyDraftToInputs();
  scrRenderResult([], {});
  scrFilterColsRefresh();
  scrRenderFilterChips();
  scrSaveDraft();
  toast("已载入方案：" + (t.name || ""), "ok");
  // 方案里带了网址就顺手抓一次页面，用户点开就能继续点选
  if (SCR.url) scrFetchPage(SCR.url);
}

async function scrSaveTask() {
  const url = (($("scrUrl") && $("scrUrl").value) || "").trim() || SCR.url;
  const name = ((($("scrTaskName") && $("scrTaskName").value) || "").trim()) || SCR.taskName;
  if (!name) {
    toast("先给方案起个名字", "warn");
    if ($("scrTaskName")) $("scrTaskName").focus();
    return;
  }
  if (!SCR.itemSel && !SCR.fields.length) {
    toast("还没有选择器，先在页面上点选一下", "warn");
    return;
  }
  SCR.taskName = name;
  SCR.url = url;
  const btn = $("scrSaveTask");
  if (btn) btn.disabled = true;
  const d = await scrReq("/api/scraper/tasks", {
    id: SCR.taskId, name: name, url: url,
    cfg: scrCollectCfg(), rows: (SCR.rowsAll || SCR.rows || []).length,
  });
  if (btn) btn.disabled = false;
  if (!d || d.error || !d.ok) {
    toast((d && d.error) || "保存失败", "err");
    return;
  }
  SCR.taskId = (d.task && d.task.id) || SCR.taskId;
  scrSaveDraft();
  toast("已保存方案：" + name, "ok");
  scrLoadTasks();
}

async function scrDeleteTask(id, name) {
  if (!id) return;
  const ok = await scrConfirm("删除采集方案",
    "确定删除「" + (name || "未命名") + "」吗？只删除保存的选择器，已导出的数据不受影响。");
  if (!ok) return;
  const d = await scrReq("/api/scraper/tasks/delete", { id: id });
  if (!d || !d.ok) { toast((d && d.error) || "删除失败", "err"); return; }
  if (SCR.taskId === id) SCR.taskId = "";
  toast("已删除方案", "ok");
  scrLoadTasks();
}

/* ---------------- 初始化：活动栏图标 + 侧栏面板 ----------------
   这些元素不依赖工作台标签页（用户还没打开工作台时也要能点），所以放在模块末尾绑定。 */
function scrBindSidebar() {
  const openBtn = document.getElementById("scrsOpen");
  if (openBtn) openBtn.addEventListener("click", function () { scrOpenCenter(); });

  const refreshBtn = document.getElementById("scrsRefresh");
  if (refreshBtn) refreshBtn.addEventListener("click", function () { scrLoadTasks(true); });

  const list = document.getElementById("scrTaskList");
  if (list && list.dataset.bound !== "1") {
    list.dataset.bound = "1";
    list.addEventListener("click", function (e) {
      const del = e.target.closest(".scrp-del");
      if (del) {
        e.stopPropagation();
        scrDeleteTask(del.dataset.id, del.dataset.name || "");
        return;
      }
      const it = e.target.closest(".scrp-item");
      if (it) scrOpenTask(it.dataset.id);
    });
  }

  const act = document.getElementById("actScraper");
  if (act && act.dataset.bound !== "1") {
    act.dataset.bound = "1";
    act.addEventListener("click", function () {
      // 侧栏切换由 02_ 的 showPanel 负责；这里把工作台标签页也一起打开，点一下就进入可视化界面
      setTimeout(function () { scrOpenCenter(); }, 0);
    });
  }
}

(function scrInit() {
  scrBindSidebar();
  scrRenderTasks();      // 先把「还没有保存的方案」占位显示出来，别空白一片
  scrLoadTasks();
  // 交互预览的代理脚本会往父页面发消息（点选结果 / 元素树 / 计数）
  window.addEventListener("message", scrAgentOnMessage);
  // 会话恢复（00_preamble 的 sessionRestore）按这个函数重开标签页
  window.openScraperWorkbench = scrOpenCenter;
  window.scrOpenTaskById = scrOpenTask;
})();
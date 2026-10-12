/* ==================================================================
   后台任务：历史日志（按日历选日期回看）
     · 入口：「后台任务」面板日志栏右上角的「历史」按钮；
     · 弹层里是一个小日历：有归档的日期带小圆点，点日期看当天每次运行的列表，
       再点某一次运行，就把它的日志读出来显示在下面的日志区（只读回看）；
     · 回看期间不连实时流（新推来的行不会冲掉历史内容），点「返回实时」恢复推送；
     · 支持「只看当前任务」，以及沿用日志区已有的搜索（🔍）/ 复制 / 清屏。
   数据来自后端 data/run_logs_history/<日期>/（每次运行结束自动归档一份），
   接口：/api/run/history/days、/api/run/history、/api/run/history/log。

   须放在 16_（关闭大 IIFE）之前，复用闭包内的 $ / esc / escAttr / toast /
   rvQ / rvCur / rvLogOpen / rvLogClose / rvLogMsg / fmtTs / fmtDur / fmtSize 等。
   ================================================================== */
const RVH = {
  days: [],                       // [{date, count, size}] 有历史日志的日期
  month: "",                      // 日历当前显示的年月："YYYY-MM"
  day: "",                        // 选中的日期："YYYY-MM-DD"
  items: [],                      // 当天归档下来的每次运行
  sel: "",                        // 选中的归档键（高亮用）
  onlyCur: false,                 // 只看当前选中任务的日志
  el: null,                       // 弹层 DOM
  msg: "",                        // 弹层列表区的提示（读取中 / 失败 / 空）
  logMax: 4000,                   // 回看时最多渲染的行数（超出只显示末尾）
};
const RVH_WK = ["日", "一", "二", "三", "四", "五", "六"];

function rvhPad(n) { return (n < 10 ? "0" : "") + n; }
function rvhToday() {
  const d = new Date();
  return d.getFullYear() + "-" + rvhPad(d.getMonth() + 1) + "-" + rvhPad(d.getDate());
}
function rvhMonthOf(ds) { return String(ds || rvhToday()).slice(0, 7); }
function rvhDayMap() {
  const m = {};
  (RVH.days || []).forEach(d => { if (d && d.date) m[d.date] = d; });
  return m;
}
function rvhCurTarget() { const t = rvCur(); return t ? String(t.target || "") : ""; }

/* 显示名：目标文件与当前任务相同时用当前任务的名字（这样用户改过的别名照样生效） */
function rvhName(it) {
  const tgt = String((it && it.target) || "");
  if (tgt) {
    const t = (RUNNER.tasks || []).filter(x => String(x.target || "") === tgt)[0];
    if (t && t.name) return t.name;
  }
  return String((it && (it.name || it.target)) || "任务");
}
function rvhStatus(it) {
  if (!it) return "";
  if (it.end == null) return "未收尾";
  if (it.stopped_by_user) return "手动停止";
  if (it.timed_out) return "超时终止";
  if (it.exit_code === 0 || it.exit_code === "0") return "正常退出";
  return it.exit_code === null || it.exit_code === undefined ? "已结束" : "退出码 " + it.exit_code;
}
function rvhStatusCls(it) {
  if (!it || it.end == null) return "";
  if (it.stopped_by_user || it.timed_out) return "warn";
  return (it.exit_code === 0 || it.exit_code === "0") ? "ok" : "err";
}

/* ---------- 弹层：打开 / 关闭 ---------- */
function rvHistClosePop() {
  if (RVH.el) { RVH.el.remove(); RVH.el = null; }
}
function rvHistToggle() {
  if (RVH.el) { rvHistClosePop(); return; }
  rvHistOpenPop();
}
function rvHistOpenPop() {
  const anchor = rvQ(".rv-histbtn");
  if (!anchor) return;
  rvHistClosePop();
  const pop = document.createElement("div");
  pop.className = "rv-hist-pop";
  pop.innerHTML =
    '<div class="rv-hist-h">' +
      '<button class="rv-hist-nav" data-nav="-1" title="上一个月"><i class="bi bi-chevron-left"></i></button>' +
      '<span class="rv-hist-mon"></span>' +
      '<button class="rv-hist-nav" data-nav="1" title="下一个月"><i class="bi bi-chevron-right"></i></button>' +
      '<span class="rv-sp"></span>' +
      '<button class="rv-mini rv-hist-today" title="跳到今天">今天</button>' +
      '<button class="rv-hist-x" title="关闭（Esc）"><i class="bi bi-x-lg"></i></button>' +
    '</div>' +
    '<div class="rv-hist-wk">' + RVH_WK.map(w => "<span>" + w + "</span>").join("") + '</div>' +
    '<div class="rv-hist-grid"></div>' +
    '<label class="rv-chk rv-hist-only" title="只列出当前选中任务的归档日志">' +
      '<input type="checkbox" class="rv-hist-onlyc"> 只看当前任务</label>' +
    '<div class="rv-hist-list scroll-thin"></div>';
  document.body.appendChild(pop);
  RVH.el = pop;

  pop.querySelectorAll(".rv-hist-nav").forEach(b => {
    b.onclick = () => rvHistMonth(parseInt(b.dataset.nav, 10));
  });
  pop.querySelector(".rv-hist-x").onclick = () => rvHistClosePop();
  pop.querySelector(".rv-hist-today").onclick = () => rvHistPick(rvhToday());
  const only = pop.querySelector(".rv-hist-onlyc");
  only.checked = !!RVH.onlyCur;
  only.onchange = () => { RVH.onlyCur = only.checked; rvHistRenderList(); };
  pop.querySelector(".rv-hist-grid").addEventListener("click", (e) => {
    const b = e.target.closest ? e.target.closest("[data-day]") : null;
    if (b) rvHistPick(b.dataset.day);
  });
  pop.querySelector(".rv-hist-list").addEventListener("click", (e) => {
    const it = e.target.closest ? e.target.closest("[data-key]") : null;
    if (it) rvHistView(it.dataset.key);
  });

  // 定位：优先贴在按钮上方（日志栏在面板底部），放不下再翻到下面
  const r = anchor.getBoundingClientRect();
  const pr = pop.getBoundingClientRect();
  const left = Math.min(Math.max(8, r.right - pr.width), Math.max(8, window.innerWidth - pr.width - 8));
  let top = r.top - pr.height - 6;
  if (top < 8) top = Math.min(r.bottom + 6, Math.max(8, window.innerHeight - pr.height - 8));
  pop.style.left = left + "px";
  pop.style.top = Math.max(8, top) + "px";

  rvHistLoadDays();
}

/* 点弹层外部 / Esc 收起（与任务详情悬浮框同一套做法） */
document.addEventListener("click", (e) => {
  if (!RVH.el) return;
  const t = e.target;
  if (t && t.closest && (t.closest(".rv-hist-pop") || t.closest(".rv-histbtn"))) return;
  rvHistClosePop();
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && RVH.el) rvHistClosePop(); });

/* ---------- 日历 ---------- */
function rvHistMonth(step) {
  const parts = String(RVH.month || rvhMonthOf("")).split("-").map(Number);
  let y = parts[0] || new Date().getFullYear(), m = (parts[1] || 1) + (step || 0);
  while (m < 1) { m += 12; y -= 1; }
  while (m > 12) { m -= 12; y += 1; }
  RVH.month = y + "-" + rvhPad(m);
  rvHistRenderCal();
}
function rvHistRenderCal() {
  const pop = RVH.el;
  if (!pop) return;
  const grid = pop.querySelector(".rv-hist-grid");
  const mon = pop.querySelector(".rv-hist-mon");
  if (!grid) return;
  const parts = String(RVH.month || rvhMonthOf("")).split("-").map(Number);
  const y = parts[0], m = parts[1];
  if (mon) mon.textContent = y + " 年 " + m + " 月";
  const map = rvhDayMap();
  const today = rvhToday();
  const first = new Date(y, m - 1, 1).getDay();          // 0 = 周日
  const total = new Date(y, m, 0).getDate();
  let h = "";
  for (let i = 0; i < first; i++) h += '<span class="rv-hist-pad"></span>';
  for (let d = 1; d <= total; d++) {
    const ds = y + "-" + rvhPad(m) + "-" + rvhPad(d);
    const info = map[ds];
    const cls = "rv-hist-d" + (info ? " has" : "") +
      (ds === RVH.day ? " on" : "") + (ds === today ? " today" : "");
    const tip = info
      ? ds + "：共 " + info.count + " 次运行 · " + fmtSize(info.size)
      : ds + "：这一天没有历史日志";
    h += '<button class="' + cls + '" data-day="' + ds + '" title="' + escAttr(tip) + '">' +
      d + (info ? '<i class="rv-hist-dot"></i>' : '') + '</button>';
  }
  grid.innerHTML = h;
}
function rvHistPick(ds) {
  if (!ds) return;
  RVH.day = ds;
  RVH.month = rvhMonthOf(ds);
  RVH.sel = "";
  rvHistRenderCal();
  rvHistLoadItems();
}

/* ---------- 数据 ---------- */
async function rvHistLoadDays() {
  RVH.msg = "正在读取历史日志…";
  rvHistRenderAll();
  try {
    const r = await fetch("/api/run/history/days");
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    RVH.days = d.days || [];
    if (!RVH.day) {
      const hit = (RVH.days || []).filter(x => x.date === rvhToday())[0];
      RVH.day = (hit || RVH.days[0] || {}).date || rvhToday();
    }
    RVH.month = rvhMonthOf(RVH.day);
    RVH.msg = "";
    rvHistRenderAll();
    rvHistLoadItems();
  } catch (e) {
    RVH.msg = "读取失败：" + (e.message || e);
    rvHistRenderAll();
  }
}
async function rvHistLoadItems() {
  const day = RVH.day;
  if (!day) return;
  RVH.items = [];
  RVH.sel = "";
  RVH.msg = "正在读取 " + day + " 的日志…";
  rvHistRenderList();
  try {
    const r = await fetch("/api/run/history?date=" + encodeURIComponent(day));
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    if (RVH.day !== day) return;                    // 读取期间用户又换了日期
    RVH.items = d.items || [];
    RVH.msg = "";
  } catch (e) {
    if (RVH.day !== day) return;
    RVH.msg = "读取失败：" + (e.message || e);
  }
  rvHistRenderList();
}
function rvHistRenderAll() {
  rvHistRenderCal();
  rvHistRenderList();
}
function rvHistRenderList() {
  const pop = RVH.el;
  if (!pop) return;
  const box = pop.querySelector(".rv-hist-list");
  if (!box) return;
  if (RVH.msg) {
    box.innerHTML = '<div class="ph">' + esc(RVH.msg) + '</div>';
    return;
  }
  const cur = rvhCurTarget();
  let list = RVH.items || [];
  if (RVH.onlyCur && cur) list = list.filter(it => String(it.target || "") === cur);
  if (!list.length) {
    box.innerHTML = '<div class="ph">' + esc(RVH.day) + " 没有" +
      (RVH.onlyCur ? "当前任务的" : "") + "历史日志<br>（每次运行结束会自动归档一份）</div>";
    return;
  }
  box.innerHTML = list.map(it => {
    const on = it.key === RVH.sel ? " on" : "";
    const range = fmtTs(it.start) + " → " + (it.end != null ? fmtTs(it.end) : "运行中");
    return '<div class="rv-hist-i' + on + '" data-key="' + escAttr(it.key) + '" ' +
        'title="点击查看这次运行的日志">' +
      '<div class="rv-hist-i1">' +
        '<span class="nm">' + esc(rvhName(it)) + '</span>' +
        '<span class="st ' + rvhStatusCls(it) + '">' + esc(rvhStatus(it)) + '</span>' +
      '</div>' +
      '<div class="rv-hist-i2">' + esc(range) + ' · ' + fmtDur(it.duration || 0) +
        ' · ' + fmtSize(it.size || 0) + (it.mode === "fg" ? " · 前台" : " · 后台") + '</div>' +
    '</div>';
  }).join("");
}

/* ---------- 回看某一次运行的日志 ---------- */
async function rvHistView(key) {
  const it = (RVH.items || []).filter(x => x.key === key)[0];
  if (!it) return;
  RVH.sel = key;
  rvHistRenderList();
  rvLogMsg("正在读取 " + fmtTs(it.start) + " 的历史日志…");
  try {
    const r = await fetch("/api/run/history/log?date=" + encodeURIComponent(it.date || RVH.day) +
                          "&key=" + encodeURIComponent(key));
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    rvHistPaint(d.text || "", it, !!d.truncated);
  } catch (e) {
    toast("历史日志读取失败：" + (e.message || e), "err");
  }
}
function rvHistPaint(text, it, truncated) {
  const pre = rvQ(".rv-log");
  if (!pre) return;
  rvLogClose();                                   // 回看期间不连实时流
  RUNVIEW.logId = "";
  RUNVIEW.histOn = true;
  RUNVIEW.histTask = String(it.id || "");

  const arr = String(text || "").split("\n");
  if (arr.length && arr[arr.length - 1] === "") arr.pop();
  const cut = Math.max(0, arr.length - RVH.logMax);
  const frag = document.createDocumentFragment();
  for (let i = cut; i < arr.length; i++) {
    const d = document.createElement("div");
    d.className = "log-line";
    d.textContent = arr[i];
    frag.appendChild(d);
  }
  pre.innerHTML = "";
  pre.appendChild(frag);
  RUNVIEW.lines = arr.length - cut;
  RUNVIEW.follow = true;
  pre.scrollTop = pre.scrollHeight;

  const bar = rvQ(".rv-logbar");
  if (bar) bar.classList.add("hist");
  const tEl = rvQ(".rv-logtitle-t");
  if (tEl) tEl.textContent = "历史日志";
  const hb = rvQ(".rv-histbar");
  if (hb) hb.hidden = false;
  const ht = rvQ(".rv-histtext");
  if (ht) {
    ht.textContent = fmtTs(it.start) + " → " + (it.end != null ? fmtTs(it.end) : "运行中") +
      " · " + rvhName(it) + " · " + rvhStatus(it);
  }
  rvLogMsg((truncated ? "文件较大，仅显示末尾部分 · " : "") + (arr.length - cut) + " 行" +
    (cut ? "（更早的 " + cut + " 行未加载）" : " · 只读回看"));
  if (typeof rvFindScan === "function") rvFindScan(false);   // 搜索条开着时重扫命中
}

/* ---------- 退出回看，回到实时 ---------- */
function rvHistExit() {
  RUNVIEW.histOn = false;
  RUNVIEW.histTask = "";
  const bar = rvQ(".rv-logbar");
  if (bar) bar.classList.remove("hist");
  const hb = rvQ(".rv-histbar");
  if (hb) hb.hidden = true;
  const tEl = rvQ(".rv-logtitle-t");
  if (tEl) tEl.textContent = "实时日志";
  const pre = rvQ(".rv-log");
  if (pre) pre.innerHTML = "";
  RUNVIEW.logId = "";
  RUNVIEW.lines = 0;
  const t = (typeof rvCur === "function") ? rvCur() : null;
  if (t && t.id) rvLogOpen(t);                    // 重新接上实时推送
}

/* ---------- 绑定（由 40_ 的 rvBuild 调用） ---------- */
function rvHistBind() {
  const btn = rvQ(".rv-histbtn");
  if (btn) btn.onclick = (e) => { e.stopPropagation(); rvHistToggle(); };
  const back = rvQ(".rv-histback");
  if (back) back.onclick = () => rvHistExit();
}

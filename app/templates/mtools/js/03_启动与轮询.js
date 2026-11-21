/* ============================================================================
 * 启动与轮询：首屏切页、定时刷新（仅当前页）、回到前台立即刷新
 * ========================================================================== */

const POLL_MS = 4000;      // 代理状态 / 下载进度刷新间隔
let _pollTimer = null;

function currentPageFromHash() {
  return String(location.hash || "").replace(/^#/, "") === "dl" ? "dl" : "proxy";
}

function pollTick() {
  if (document.hidden) return;          // 后台标签页不请求，省电
  if (sheetVisible()) return;           // 弹层打开时先不重建列表，避免打断操作
  if (CURRENT_PAGE === "proxy") proxyLoad(true);
  else downloadLoad(true);
}

function startPolling() {
  clearInterval(_pollTimer);
  _pollTimer = setInterval(pollTick, POLL_MS);
}

document.addEventListener("visibilitychange", function () {
  if (document.hidden) return;
  if (CURRENT_PAGE === "proxy") proxyLoad(true);
  else downloadLoad(true);
});

window.addEventListener("hashchange", function () {
  const p = currentPageFromHash();
  if (p !== CURRENT_PAGE) switchPage(p);
});

// 首屏：按 hash 决定打开哪一页；同时把切页写进 hash（方便返回 / 刷新保持位置）
switchPage(currentPageFromHash());
const _origSwitch = switchPage;
switchPage = function (name) {
  _origSwitch(name);
  history.replaceState(null, "", "#" + CURRENT_PAGE);
};
startPolling();
// 首屏顺手把下载汇总拉一次：即使当前在代理页，底部「下载」角标也能显示进行中数量
if (CURRENT_PAGE !== "dl") downloadLoad(true);

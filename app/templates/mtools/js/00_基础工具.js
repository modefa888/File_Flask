/* ============================================================================
 * 代理与下载 · 移动版 —— 基础工具：DOM / 请求 / 格式化 / Toast / 弹层 / 确认框
 * 说明：本页四个 JS 文件共用同一个 <script> 作用域，后面的文件直接复用这里
 *       声明的函数与状态，不依赖 IDE 内的任何闭包变量。
 * ========================================================================== */
"use strict";

const $ = function (id) { return document.getElementById(id); };

const _ESC_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (m) { return _ESC_MAP[m]; });
}
function enc(s) { return encodeURIComponent(String(s == null ? "" : s)); }

/* ---------------- 请求 ---------------- */
async function apiFetch(path, opts) {
  const o = Object.assign({
    credentials: "same-origin",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
  }, opts || {});
  try {
    const r = await fetch(path, o);
    let d = null;
    try { d = await r.json(); } catch (_) { d = null; }
    if (d && d.login_required) {
      location.href = "/login?next=" + enc(location.pathname + location.search);
      return { ok: false, error: "登录已过期" };
    }
    if (!d || typeof d !== "object") {
      return { ok: false, error: "HTTP " + r.status };
    }
    if (!r.ok) {
      d.ok = false;
      d.error = d.error || ("HTTP " + r.status);
    }
    return d;
  } catch (e) {
    return { ok: false, error: "请求失败（服务未响应）" };
  }
}
function apiGet(path) { return apiFetch(path); }
function apiPost(path, body) {
  return apiFetch(path, { method: "POST", body: JSON.stringify(body || {}) });
}

/* ---------------- 格式化 ---------------- */
function fmtBytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + " B";
  const u = ["KB", "MB", "GB", "TB", "PB"];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return (n < 10 ? n.toFixed(2) : n.toFixed(1)) + " " + u[i];
}
function fmtSpeed(bps) {
  const n = Number(bps) || 0;
  if (n < 1) return "0 B/s";
  return fmtBytes(n) + "/s";
}
/* 窄屏卡片里用的紧凑写法：数值与单位之间不留空格（↑241.6KB ↓75.86MB） */
function fmtBytesTight(n) { return fmtBytes(n).replace(" ", ""); }
function fmtSpeedTight(bps) {
  const n = Number(bps) || 0;
  if (n < 1) return "0B/s";
  return fmtBytesTight(n) + "/s";
}
function fmtTime(ts) {
  if (!ts) return "—";
  const d = new Date(Number(ts) * 1000);
  if (isNaN(d.getTime())) return "—";
  const p = function (n) { return (n < 10 ? "0" : "") + n; };
  return (d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
}
/* ---------------- Toast ---------------- */
let _toastTimer = null;
function toast(msg, type) {
  const el = $("toast");
  if (!el) return;
  el.textContent = String(msg == null ? "" : msg);
  el.className = "toast show " + (type || "");
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(function () { el.className = "toast " + (type || ""); }, 2400);
}

/* ---------------- 复制 ---------------- */
async function copyText(txt) {
  const text = String(txt == null ? "" : txt);
  if (!text) return false;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      toast("已复制", "ok");
      return true;
    }
  } catch (_) { /* 继续走兜底 */ }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.top = "-1000px";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch (_) { ok = false; }
  ta.remove();
  toast(ok ? "已复制" : "复制失败，请手动选择", ok ? "ok" : "err");
  return ok;
}

/* ---------------- 底部弹层 ---------------- */
let _sheetHandler = null;

function openSheet(title, html, onAct) {
  $("sheetTitle").textContent = title || "操作";
  $("sheetBody").innerHTML = html || "";
  $("sheetBody").scrollTop = 0;
  $("sheetMask").classList.add("show");
  $("sheet").classList.add("show");
  _sheetHandler = (typeof onAct === "function") ? onAct : null;
}
function closeSheet() {
  $("sheet").classList.remove("show");
  $("sheetMask").classList.remove("show");
  _sheetHandler = null;
}
function sheetVisible() {
  return $("sheet").classList.contains("show");
}

/* ---------------- 自定义确认框 ---------------- */
let _confirmResolve = null;

function uiConfirm(msg, opt) {
  opt = opt || {};
  $("confirmTitle").textContent = opt.title || "提示";
  $("confirmMsg").textContent = msg || "";
  $("confirmOk").textContent = opt.okText || "确定";
  $("confirmCancel").textContent = opt.cancelText || "取消";
  $("confirmOk").className = "btn " + (opt.danger === false ? "primary" : "danger");
  $("confirmBox").classList.add("show");
  return new Promise(function (resolve) { _confirmResolve = resolve; });
}
function _confirmClose(val) {
  $("confirmBox").classList.remove("show");
  const fn = _confirmResolve;
  _confirmResolve = null;
  if (fn) fn(val);
}

/* ---------------- 通用事件绑定（只绑一次） ---------------- */
$("sheetMask").addEventListener("click", closeSheet);
$("sheetClose").addEventListener("click", closeSheet);
$("sheetBody").addEventListener("click", function (e) {
  const el = e.target.closest("[data-act]");
  if (!el || !_sheetHandler) return;
  _sheetHandler(el.getAttribute("data-act"), el, e);
});
$("confirmOk").addEventListener("click", function () { _confirmClose(true); });
$("confirmCancel").addEventListener("click", function () { _confirmClose(false); });
$("confirmBox").addEventListener("click", function (e) {
  if (e.target === $("confirmBox")) _confirmClose(false);
});
document.addEventListener("keydown", function (e) {
  if (e.key !== "Escape") return;
  if ($("confirmBox").classList.contains("show")) return _confirmClose(false);
  if (sheetVisible()) closeSheet();
});

/* ---------------- 页面骨架：切页 / 刷新按钮 ---------------- */
let CURRENT_PAGE = "proxy";

function switchPage(name) {
  if (name !== "proxy" && name !== "dl") name = "proxy";
  CURRENT_PAGE = name;
  $("pageProxy").classList.toggle("active", name === "proxy");
  $("pageDl").classList.toggle("active", name === "dl");
  document.querySelectorAll("#tabbar .tab").forEach(function (b) {
    b.classList.toggle("on", b.getAttribute("data-page") === name);
  });
  $("appTitle").textContent = name === "proxy" ? "代理" : "下载";
  $("appSub").textContent = name === "proxy" ? "V2Ray 出口 · 节点快选" : "下载中心 · 多线程与断点续传";
  $("content").scrollTop = 0;
  if (name === "proxy") proxyLoad(false);
  else downloadLoad(false);
}

document.querySelectorAll("#tabbar .tab").forEach(function (b) {
  b.addEventListener("click", function () {
    if (sheetVisible()) closeSheet();
    switchPage(b.getAttribute("data-page"));
  });
});

$("refreshBtn").addEventListener("click", async function () {
  const btn = $("refreshBtn");
  btn.classList.add("spin");
  try {
    if (CURRENT_PAGE === "proxy") await proxyLoad(false);
    else await downloadLoad(false);
  } finally {
    setTimeout(function () { btn.classList.remove("spin"); }, 380);
  }
});

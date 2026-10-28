/* ================================================================
 * 标签页内嵌图片查看器（png/jpg/gif/webp/bmp/ico/svg/avif…，只读预览）
 *
 * 能力：
 *   · 缩放：工具栏 ±、百分比、适应窗口、1:1，鼠标滚轮以光标为锚点缩放
 *   · 平移：放大后按住拖拽（超出容器才可拖，边界自动夹紧）
 *   · 旋转 90° / 水平镜像；切换图片后自动复位
 *   · 同目录图片上一张 / 下一张（工具栏计数 3/12、←→ 快捷键）
 *   · 背景：棋盘格（透明图用）/ 深色 / 浅色
 *   · 信息条：像素尺寸 · 文件大小 · 当前缩放比例
 *   · 下载原图（/api/download）
 *   · 快捷键：+ - 缩放、0 适应、1 一比一、R 右转、Shift+R 左转、H 镜像、← → 切图
 *
 * 注意：本文件在 00_preamble 大 IIFE 关闭之后加载，setupImageView 是全局函数，
 * 由 openFile 的图片分支调用（activate(tab) 由调用方负责）。
 * opts.onError(data)：图片加载失败且后端能给出原因时回调（data = {error, code, hint}），
 * 由调用方决定是否展示「一键获取访问权限」等按钮；不传则只在查看器里显示文字。
 * ================================================================ */

// 只列浏览器能直接显示的格式（tif/heic 等显示不了，别放进同目录切图列表）
var IDE_IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg", "avif"];

var _ipvCleanups = [];

function _ipvCleanupRun() {
  _ipvCleanups.forEach(f => { try { f(); } catch (_) {} });
  _ipvCleanups = [];
}

function _ipvEsc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function _ipvSize(n) {
  if (!isFinite(n) || n <= 0) return "";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (i === 0 ? v : v.toFixed(1)) + " " + u[i];
}

function setupImageView(tab, host, path, name, opts) {
  _ipvCleanupRun();
  const _o = opts || {};
  tab.isImage = true;

  const dir = path.slice(0, path.lastIndexOf("/")) || "/";
  const urlRaw = p => "/api/preview?path=" + encodeURIComponent(p) + "&raw=1";

  // 背景模式：0 棋盘格（默认，看透明图）/ 1 深色 / 2 浅色（持久化）
  let bgMode = 0;
  try { bgMode = parseInt(localStorage.getItem("ide.imageBg") || "0", 10) || 0; } catch (_) {}

  host.innerHTML =
    '<div class="ipv-wrap">' +
      '<div class="ipv-stage">' +
        '<img class="ipv-img" alt="" draggable="false">' +
        '<div class="ipv-err" style="display:none;"></div>' +
        '<div class="ipv-toolbar">' +
          '<button class="ipv-btn ipv-prev" title="上一张（←）"><i class="bi bi-chevron-left"></i></button>' +
          '<span class="ipv-count">-/-</span>' +
          '<button class="ipv-btn ipv-next" title="下一张（→）"><i class="bi bi-chevron-right"></i></button>' +
          '<span class="ipv-sep"></span>' +
          '<button class="ipv-btn ipv-out" title="缩小（-）"><i class="bi bi-dash-lg"></i></button>' +
          '<button class="ipv-btn ipv-zoom" title="点击切换 适应窗口 / 100%">100%</button>' +
          '<button class="ipv-btn ipv-in" title="放大（+）"><i class="bi bi-plus-lg"></i></button>' +
          '<button class="ipv-btn ipv-fit" title="适应窗口（0）"><i class="bi bi-aspect-ratio"></i></button>' +
          '<button class="ipv-btn ipv-one" title="原始大小 1:1（1）"><span class="ipv-one-t">1:1</span></button>' +
          '<span class="ipv-sep"></span>' +
          '<button class="ipv-btn ipv-rotl" title="向左旋转 90°（Shift+R）"><i class="bi bi-arrow-counterclockwise"></i></button>' +
          '<button class="ipv-btn ipv-rotr" title="向右旋转 90°（R）"><i class="bi bi-arrow-clockwise"></i></button>' +
          '<button class="ipv-btn ipv-flip" title="水平镜像（H）"><i class="bi bi-symmetry-horizontal"></i></button>' +
          '<button class="ipv-btn ipv-bg" title="切换预览背景：棋盘格 / 深色 / 浅色"><i class="bi bi-circle-half"></i></button>' +
          '<button class="ipv-btn ipv-dl" title="下载原图"><i class="bi bi-download"></i></button>' +
        '</div>' +
        '<div class="ipv-info"></div>' +
        '<div class="ipv-tip">滚轮缩放 · 拖拽平移 · 双击切换 1:1 / 适应窗口</div>' +
      '</div>' +
    '</div>';

  const $ = sel => host.querySelector(sel);
  const wrap = $(".ipv-wrap"), stage = $(".ipv-stage"), img = $(".ipv-img");
  const errEl = $(".ipv-err"), infoEl = $(".ipv-info"), tipEl = $(".ipv-tip");
  const countEl = $(".ipv-count"), zoomEl = $(".ipv-zoom");
  const btnPrev = $(".ipv-prev"), btnNext = $(".ipv-next"), btnBg = $(".ipv-bg");

  let curPath = path;
  let natW = 0, natH = 0, natSize = 0, natSizeStr = "";
  let scale = 1, rot = 0, flip = false, posX = 0, posY = 0;
  let fitMode = true;                 // true=适应窗口（容器尺寸变化时自动重新适配）
  let dragging = false, dragStart = null;
  let plItems = [];                   // 同目录图片 [{abs, name, size}]

  /* ---------- 背景 ---------- */
  const applyBg = () => {
    wrap.classList.remove("ipv-bg-checker", "ipv-bg-dark", "ipv-bg-light");
    wrap.classList.add(["ipv-bg-checker", "ipv-bg-dark", "ipv-bg-light"][bgMode] || "ipv-bg-checker");
    try { localStorage.setItem("ide.imageBg", String(bgMode)); } catch (_) {}
  };
  btnBg.onclick = () => { bgMode = (bgMode + 1) % 3; applyBg(); };
  applyBg();

  /* ---------- 变换与尺寸 ---------- */
  // 旋转 90/270 时显示宽高互换，用于适配与边界计算
  const dispSize = () => {
    const w = (rot % 180 === 0) ? natW : natH;
    const h = (rot % 180 === 0) ? natH : natW;
    return { w: w * scale, h: h * scale };
  };
  const render = () => {
    img.style.transform =
      "translate(" + posX + "px," + posY + "px) rotate(" + rot + "deg) scale(" + scale + ")" +
      (flip ? " scaleX(-1)" : "");
    zoomEl.textContent = Math.round(scale * 100) + "%";
    const d = dispSize();
    const sizeTxt = natSizeStr || (natSize ? _ipvSize(natSize) : "");
    infoEl.textContent = (natW ? natW + "×" + natH : "") +
      (sizeTxt ? " · " + sizeTxt : "") +
      (natW ? " · 显示 " + Math.round(d.w) + "×" + Math.round(d.h) : "");
    stage.classList.toggle("ipv-zoomable", d.w > stage.clientWidth + 1 || d.h > stage.clientHeight + 1);
  };
  // 平移边界：图片比容器大时最多拖到边缘对齐，比容器小时强制居中
  const clampPan = () => {
    const d = dispSize();
    const mx = Math.max(0, (d.w - stage.clientWidth) / 2);
    const my = Math.max(0, (d.h - stage.clientHeight) / 2);
    posX = Math.max(-mx, Math.min(mx, posX));
    posY = Math.max(-my, Math.min(my, posY));
  };
  const fit = () => {
    if (!natW || !natH) return;
    const w = (rot % 180 === 0) ? natW : natH;
    const h = (rot % 180 === 0) ? natH : natW;
    const pad = 28;                     // 四周留白，避免贴边
    scale = Math.min((stage.clientWidth - pad) / w, (stage.clientHeight - pad) / h) || 1;
    scale = Math.max(0.02, Math.min(scale, 8));
    posX = posY = 0;
    fitMode = true;
    render();
  };
  const setScale = (next, anchor) => {
    const s = Math.max(0.02, Math.min(8, next));
    if (!isFinite(s) || s === scale) return;
    const cw = stage.clientWidth, ch = stage.clientHeight;
    const r = stage.getBoundingClientRect();
    const px = anchor ? anchor.x - r.left - cw / 2 : 0;   // 光标相对容器中心
    const py = anchor ? anchor.y - r.top - ch / 2 : 0;
    if (anchor && natW) {
      // 以光标为锚点：先反解出光标下的图片坐标，再按新比例重新求平移量
      const rad = rot * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad);
      const dx = (px - posX) / scale, dy = (py - posY) / scale;
      const ix = dx * cos + dy * sin;
      const iy = -dx * sin + dy * cos;
      posX = px - s * (ix * cos - iy * sin);
      posY = py - s * (ix * sin + iy * cos);
    }
    scale = s;
    fitMode = false;
    clampPan();
    render();
  };
  const zoomStep = dir => setScale(scale * (dir > 0 ? 1.25 : 1 / 1.25));

  /* ---------- 工具条 ---------- */
  $(".ipv-in").onclick = () => zoomStep(1);
  $(".ipv-out").onclick = () => zoomStep(-1);
  $(".ipv-fit").onclick = () => fit();
  $(".ipv-one").onclick = () => { setScale(1); posX = posY = 0; clampPan(); render(); };
  zoomEl.onclick = () => { if (fitMode) { setScale(1); } else { fit(); } };
  $(".ipv-rotr").onclick = () => { rot = (rot + 90) % 360; posX = posY = 0; if (fitMode) fit(); else { clampPan(); render(); } };
  $(".ipv-rotl").onclick = () => { rot = (rot + 270) % 360; posX = posY = 0; if (fitMode) fit(); else { clampPan(); render(); } };
  $(".ipv-flip").onclick = () => { flip = !flip; $(".ipv-flip").classList.toggle("on", flip); render(); };
  // 下载：先弹二次确认悬浮框（文件名 + 大小），确认后才真正开始下载
  const dlBtn = $(".ipv-dl");
  dlBtn.onclick = () => {
    if (!curPath) return;
    const fileName = curPath.split("/").pop() || "文件";
    const sizeTxt = natSizeStr || (natSize ? _ipvSize(natSize) : "大小未知");
    const ask = (typeof window.uiConfirmPop === "function")
      ? window.uiConfirmPop(dlBtn, {
          title: "下载确认",
          msg: fileName + "（" + sizeTxt + "）",
          okText: "下载",
        })
      : Promise.resolve(window.confirm("下载 " + fileName + "（" + sizeTxt + "）？"));
    Promise.resolve(ask).then(ok => {
      if (!ok) return;
      // 用 <a download> 触发：比 window.open 更稳（不会被浏览器拦截成弹窗），且能带上文件名
      const a = document.createElement("a");
      a.href = "/api/download?path=" + encodeURIComponent(curPath);
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
    });
  };

  /* ---------- 滚轮缩放（以光标为锚点） ---------- */
  const onWheel = e => {
    if (!natW) return;
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    setScale(scale * factor, { x: e.clientX, y: e.clientY });
  };
  stage.addEventListener("wheel", onWheel, { passive: false });
  _ipvCleanups.push(() => stage.removeEventListener("wheel", onWheel));

  /* ---------- 拖拽平移 / 双击切换 ---------- */
  stage.addEventListener("pointerdown", e => {
    if (e.button !== 0 || !natW) return;
    if (e.target.closest(".ipv-toolbar")) return;      // 点工具栏按钮不触发拖拽
    const d = dispSize();
    if (d.w <= stage.clientWidth + 1 && d.h <= stage.clientHeight + 1) return;   // 未溢出：不拖
    dragging = true;
    dragStart = { x: e.clientX, y: e.clientY, px: posX, py: posY };
    stage.setPointerCapture && stage.setPointerCapture(e.pointerId);
    stage.classList.add("ipv-dragging");
  });
  stage.addEventListener("pointermove", e => {
    if (!dragging || !dragStart) return;
    posX = dragStart.px + (e.clientX - dragStart.x);
    posY = dragStart.py + (e.clientY - dragStart.y);
    clampPan();
    render();
  });
  const endDrag = () => {
    dragging = false; dragStart = null;
    stage.classList.remove("ipv-dragging");
  };
  stage.addEventListener("pointerup", endDrag);
  stage.addEventListener("pointercancel", endDrag);

  stage.addEventListener("dblclick", e => {
    if (!natW || e.target.closest(".ipv-toolbar")) return;
    if (fitMode) setScale(1); else fit();
  });

  /* ---------- 同目录图片列表：上一张 / 下一张 ---------- */
  const syncCount = () => {
    if (!plItems.length) { countEl.textContent = "-/-"; return; }
    const i = plItems.findIndex(it => it.abs === curPath);
    countEl.textContent = (i < 0 ? "-" : i + 1) + "/" + plItems.length;
    btnPrev.disabled = plItems.length < 2;
    btnNext.disabled = plItems.length < 2;
  };
  const stepImage = dirStep => {
    if (plItems.length < 2) return;
    const i = plItems.findIndex(it => it.abs === curPath);
    if (i < 0) return;
    const next = (i + dirStep + plItems.length) % plItems.length;
    const it = plItems[next];
    openPath(it.abs, it.name, it.size, it.size_str);
  };
  btnPrev.onclick = () => stepImage(-1);
  btnNext.onclick = () => stepImage(1);

  // 在同一个标签页里换图：重置缩放/旋转/平移，重新加载，并同步标签页名称
  const openPath = (abs, nm, size, sizeStr) => {
    if (!abs || abs === curPath) return;
    curPath = abs;
    const fileName = nm || abs.split("/").pop() || "";
    natW = natH = 0;
    natSize = size || 0;
    natSizeStr = sizeStr || "";
    scale = 1; rot = 0; flip = false; posX = posY = 0; fitMode = true;
    dragging = false; dragStart = null;
    $(".ipv-flip").classList.remove("on");
    errEl.style.display = "none";
    img.style.display = "";
    img.style.transform = "";
    img.alt = fileName;
    img.src = urlRaw(abs);      // 加载完成后由常驻的 load 监听重新适配
    tipEl.style.display = "";
    render();
    syncCount();
    try {
      if (typeof window.IDE_SYNC_VIDEO_TAB === "function") window.IDE_SYNC_VIDEO_TAB(tab, abs, fileName);
    } catch (_) {}
  };

  /* ---------- 图片加载完成 / 失败 ---------- */
  const onMeta = () => {
    natW = img.naturalWidth || 0;
    natH = img.naturalHeight || 0;
    // 少数 SVG 没有内联宽高（只有 viewBox），naturalWidth 为 0：退回 CSS contain，别让它撑爆舞台
    img.classList.toggle("ipv-img-auto", !natW || !natH);
    fit();
    tipEl.style.display = "";
  };
  img.addEventListener("load", onMeta);
  img.addEventListener("error", () => {
    img.style.display = "none";
    tipEl.style.display = "none";
    // <img> 失败信息太笼统：回头问后端要统一提示（可能是没权限 / 超大 / 不是有效图片）
    fetch("/api/preview?path=" + encodeURIComponent(curPath))
      .then(r => r.json().catch(() => null))
      .then(d => {
        if (d && d.error) {
          if (typeof _o.onError === "function") { _o.onError(d); return; }
          errEl.textContent = d.error + (d.hint ? "　" + d.hint : "");
          errEl.style.display = "";
          return;
        }
        errEl.textContent = "图片解析失败：文件可能已损坏，或不是浏览器支持的图片格式；可点右上角下载后查看。";
        errEl.style.display = "";
      })
      .catch(() => {
        errEl.textContent = "图片加载失败：请检查文件是否被移动、删除，或改用下载查看。";
        errEl.style.display = "";
      });
  });

  /* ---------- 键盘：缩放 / 旋转 / 切图（仅当前标签可见时接管） ---------- */
  const keyHandler = e => {
    if (!host.isConnected || !host.classList.contains("active")) return;
    const tag = (e.target && e.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select" || (e.target && e.target.isContentEditable)) return;
    const k = (e.key || "").toLowerCase();
    if (k === "+" || k === "=") { e.preventDefault(); e.stopPropagation(); zoomStep(1); }
    else if (k === "-" || k === "_") { e.preventDefault(); e.stopPropagation(); zoomStep(-1); }
    else if (k === "0") { e.preventDefault(); e.stopPropagation(); fit(); }
    else if (k === "1") { e.preventDefault(); e.stopPropagation(); setScale(1); }
    else if (k === "r") { e.preventDefault(); e.stopPropagation(); (e.shiftKey ? $(".ipv-rotl") : $(".ipv-rotr")).click(); }
    else if (k === "h") { e.preventDefault(); e.stopPropagation(); $(".ipv-flip").click(); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); e.stopPropagation(); stepImage(-1); }
    else if (e.key === "ArrowRight") { e.preventDefault(); e.stopPropagation(); stepImage(1); }
  };
  document.addEventListener("keydown", keyHandler, true);
  _ipvCleanups.push(() => document.removeEventListener("keydown", keyHandler, true));

  /* ---------- 容器尺寸变化：适应模式下重新适配 ---------- */
  let resizeTimer = null;
  const onResize = () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!host.isConnected || !natW) return;
      if (fitMode) fit(); else { clampPan(); render(); }
    }, 120);
  };
  window.addEventListener("resize", onResize);
  let ro = null;
  if (window.ResizeObserver) {
    ro = new ResizeObserver(onResize);
    ro.observe(stage);
  }
  _ipvCleanups.push(() => {
    window.removeEventListener("resize", onResize);
    clearTimeout(resizeTimer);
    if (ro) { try { ro.disconnect(); } catch (_) {} }
  });

  /* ---------- 首次加载：填信息、拉同目录图片列表 ---------- */
  img.alt = name || "";
  img.src = urlRaw(curPath);
  infoEl.textContent = "";

  fetch("/api/files?path=" + encodeURIComponent(dir))
    .then(r => r.json())
    .then(d => {
      if (!host.isConnected) return;
      if (d.error) throw new Error(d.error);
      plItems = (d.items || [])
        .filter(it => !it.is_dir && IDE_IMAGE_EXTS.indexOf((it.name || "").split(".").pop().toLowerCase()) >= 0)
        .sort((a, b) => (a.name || "").localeCompare(b.name || "", "zh-Hans-CN"))
        .map(it => ({ abs: dir.replace(/\/+$/, "") + "/" + it.name, name: it.name,
                      size: it.size || 0, size_str: it.size_str || "" }));
      const cur = plItems.find(it => it.abs === curPath);
      if (cur && (cur.size || cur.size_str)) {
        natSize = cur.size || 0; natSizeStr = cur.size_str || "";
        render();
      }
      syncCount();
    })
    .catch(() => { plItems = []; syncCount(); });

  /* ---------- 标签关闭时清理全局监听 ---------- */
  const cleanup = () => _ipvCleanupRun();
  if (host._ipvObserver) { try { host._ipvObserver.disconnect(); } catch (_) {} }
  const cleanObserver = new MutationObserver(() => {
    if (!host.isConnected) { cleanObserver.disconnect(); cleanup(); }
  });
  host._ipvObserver = cleanObserver;
  if (host.parentNode) cleanObserver.observe(host.parentNode, { childList: true });
}

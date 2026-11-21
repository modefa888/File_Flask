/* ============================================================================
 * 下载页：任务 / 进度 / 新建网络下载 / 暂停继续 / 删除 / 设置
 * 后端接口：app/routes/ide/downloads.py（/api/dl/*）
 * ========================================================================== */

const D = {
  items: [],       // 任务列表（最多 200 条，前端按 tab 过滤）
  stats: {},       // 汇总
  cfg: null,       // 下载设置
  usage: null,     // 产物占用
  tab: "all",      // all / active / ended
  loading: false,
  lastAt: 0,
};

const DL_ACTIVE_ST = ["pending", "building", "ready", "downloading", "paused"];

function downloadIsRemote(t) {
  return !!t && (t.kind === "url" || t.kind === "torrent" || t.kind === "hls");
}
function downloadStatusText(t) {
  let s = t.status;
  if (!t.exists && (s === "ready" || s === "done")) s = "cleaned";
  else if (s === "ready" && downloadIsRemote(t)) s = "done";
  return ({
    pending: "排队中", building: "打包中", ready: "待下载", downloading: "下载中",
    paused: "已暂停", done: "已完成", failed: "失败", canceled: "已取消",
    probing: "解析中", merging: "合并中", cleaned: "文件已清理",
  })[s] || s;
}
function downloadIsActive(t) {
  if (!t) return false;
  if (DL_ACTIVE_ST.indexOf(t.status) < 0) return false;
  // 远程任务 ready = 服务器已抓好，等用户取回，不算「进行中」
  return !(downloadIsRemote(t) && t.status === "ready");
}
function downloadStatusCls(t) {
  const s = t.status;
  if (!t.exists && (s === "ready" || s === "done")) return "";
  if (s === "downloading" || s === "probing" || s === "merging") return "running";
  if (s === "paused") return "paused";
  if (s === "failed" || s === "canceled") return "fail";
  if (s === "done" || (s === "ready" && downloadIsRemote(t))) return "done";
  return "";
}
/* 进度换算：远程任务看服务器端 srv_done/srv_size，本地任务看 done/size */
function downloadProg(t) {
  const remote = downloadIsRemote(t);
  const srv = remote && (
    ["probing", "downloading", "merging"].indexOf(t.status) >= 0 ||
    ((t.status === "ready" || t.status === "done") && (t.srv_size || 0) > 0) ||
    (t.status === "paused" && (t.srv_done || 0) > 0)
  );
  const encPct = !!(srv && (t.meta || {}).enc && Number(t.srv_size) === 10000);
  const size = encPct ? 0 : (srv ? (t.srv_size || 0) : (t.size || 0));
  const done = encPct ? 0 : (srv ? (t.srv_done || 0) : (t.done || 0));
  let pct = encPct ? Math.min(99, (t.srv_done || 0) / 100)
    : (size > 0 ? Math.min(100, done * 100 / size) : 0);
  if (t.status === "done") pct = 100;
  const noSize = encPct || (srv && size === 0 && (t.status === "downloading" || t.status === "paused"));
  return { size: size, done: done, pct: pct, noSize: noSize, srv: srv };
}
function downloadIcon(t) {
  const name = String(t.name || "").toLowerCase();
  const ext = name.split(".").pop();
  if (t.kind === "zip") return { i: "bi-file-earmark-zip", cls: "zip" };
  if (t.kind === "text") return { i: "bi-file-earmark-text", cls: "txt" };
  if (t.kind === "torrent") return { i: "bi-magnet", cls: "txt" };
  if (["mp4", "mkv", "webm", "avi", "mov", "flv", "m4v", "rmvb"].indexOf(ext) >= 0) return { i: "bi-film", cls: "" };
  if (["mp3", "wav", "flac", "aac", "m4a", "ogg"].indexOf(ext) >= 0) return { i: "bi-music-note-beamed", cls: "" };
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"].indexOf(ext) >= 0) return { i: "bi-image", cls: "" };
  if (["zip", "rar", "7z", "tar", "gz"].indexOf(ext) >= 0) return { i: "bi-file-earmark-zip", cls: "zip" };
  if (["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx"].indexOf(ext) >= 0) return { i: "bi-file-earmark-text", cls: "txt" };
  if (t.kind === "url" || t.kind === "hls") return { i: "bi-globe2", cls: "" };
  return { i: "bi-file-earmark", cls: "" };
}

/* 可内嵌播放的视频扩展名（与后端 /api/stream 的 _VIDEO_EXTS 保持一致）。
   产物仍在磁盘上、且状态允许时才给「播放」按钮。 */
const DOWNLOAD_VIDEO_EXT = ["mp4", "m4v", "webm", "mkv", "avi", "mov", "ogg", "flv"];
function downloadIsVideo(t) {
  if (!t || !t.exists) return false;
  // 只有「已就绪 / 已完成 / 下载中 / 已暂停」的视频才给播放按钮：
  // 排队、打包、合并、失败、取消这些阶段产物还不完整，播出来必然是坏文件
  if (["downloading", "paused", "done", "ready"].indexOf(t.status) < 0) return false;
  const ext = String(t.name || "").split(".").pop().toLowerCase();
  return DOWNLOAD_VIDEO_EXT.indexOf(ext) >= 0;
}

/* ==================================================================
   数据
   ================================================================== */
async function downloadLoad(silent) {
  if (D.loading) return;
  D.loading = true;
  const r = await apiGet("/api/dl/tasks?status=all&page_size=200");
  D.loading = false;
  D.lastAt = Date.now();
  if (r.error) {
    if (!silent) toast("读取下载任务失败：" + r.error, "err");
    return;
  }
  D.items = r.items || [];
  D.stats = r.stats || {};
  if (r.settings) D.cfg = r.settings;
  downloadPaint();
}

/* ==================================================================
   绘制
   ================================================================== */
function downloadVisible() {
  return D.items.filter(function (t) {
    if (D.tab === "active") return downloadIsActive(t);
    if (D.tab === "ended") return !downloadIsActive(t);
    return true;
  });
}

function downloadPaint() {
  const st = D.stats || {};
  $("dlActive").textContent = String(st.active || 0);
  $("dlDone").textContent = String(st.done || 0);
  $("dlBytes").textContent = fmtBytes(st.done_bytes || 0);

  const total = Number(st.total || D.items.length || 0);
  const active = Number(st.active || 0);
  $("dlCntAll").textContent = total;
  $("dlCntActive").textContent = active;
  $("dlCntEnded").textContent = Math.max(0, total - active);

  const pauseList = D.items.filter(function (t) {
    return ["downloading", "probing", "merging"].indexOf(t.status) >= 0;
  });
  const resumeList = D.items.filter(function (t) { return t.status === "paused"; });
  $("dlPauseNum").textContent = pauseList.length;
  $("dlResumeNum").textContent = resumeList.length;
  $("dlPauseAll").disabled = !pauseList.length;
  $("dlResumeAll").disabled = !resumeList.length;

  document.querySelectorAll("#dlTabs button").forEach(function (b) {
    b.classList.toggle("on", b.getAttribute("data-tab") === D.tab);
  });

  downloadPaintTabBadge();
  downloadPaintList();
}

function downloadPaintList() {
  const list = $("dlList");
  if (!list) return;
  const arr = downloadVisible();
  const content = $("content");
  const sc = content.scrollTop;

  if (!arr.length) {
    list.innerHTML = '<div class="empty-box"><i class="bi bi-hourglass-split"></i>' +
      "<b>" + (D.tab === "active" ? "没有进行中的任务" : (D.tab === "ended" ? "还没有已结束的任务" : "还没有下载任务")) + "</b>" +
      "<span>" + (D.tab === "active"
        ? "当前所有下载都已完成或已结束。"
        : "点上方「新建下载」填一个链接即可开始。") + "</span></div>";
  } else {
    list.innerHTML = arr.map(downloadCard).join("");
  }
  content.scrollTop = sc;
}

function downloadCard(t) {
  const pr = downloadProg(t);
  const stCls = downloadStatusCls(t);
  const stText = downloadStatusText(t);
  const ic = downloadIcon(t);

  let sub = "";
  if (t.status === "probing" || t.status === "merging") {
    sub = t.phase || (t.status === "probing" ? "正在解析链接…" : "正在合并分片…");
  } else if (pr.noSize) {
    sub = (t.status === "downloading" ? "大小未知" : "已暂停") +
      (t.speed > 0 && t.status === "downloading" ? " · " + fmtSpeed(t.speed) : "");
  } else if (pr.size > 0) {
    sub = fmtBytes(pr.done) + " / " + fmtBytes(pr.size);
    if (t.status === "downloading" && t.speed > 0) sub += " · " + fmtSpeed(t.speed);
  } else if (pr.done > 0) {
    sub = fmtBytes(pr.done);
  } else {
    sub = fmtTime(t.ts);
  }

  const indet = (t.status === "probing" || t.status === "merging") ||
    (t.status === "downloading" && pr.noSize);
  const barCls = t.status === "done" ? "done"
    : (stCls === "fail" ? "fail" : (indet ? "indet" : ""));
  const barPct = pr.noSize ? 0 : Math.max(0, Math.min(100, pr.pct));

  let ops = "";
  const op = function (act, label, icon, extra) {
    return '<button class="dl-op' + (extra ? " " + extra : "") + '" type="button" data-act="' + act +
      '" data-id="' + esc(t.id) + '"><i class="bi ' + icon + '"></i>' + label + "</button>";
  };
  // 视频产物：直接在本页播放（走 /api/dl/stream?inline=1，支持拖动 = Range 续传）
  if (downloadIsVideo(t)) ops += op("play", "播放", "bi-play-circle-fill", "primary");
  if (["downloading", "probing", "merging"].indexOf(t.status) >= 0) {
    ops += op("pause", "暂停", "bi-pause-fill");
  }
  if (t.status === "pending" || t.status === "building") {
    ops += op("cancel", "取消", "bi-x-lg");
  }
  if (t.status === "paused") ops += op("start", "继续", "bi-play-fill");
  if (t.status === "failed" || t.status === "canceled") ops += op("retry", "重试", "bi-arrow-clockwise");
  if (t.exists) {
    ops += '<a class="dl-op' + (downloadIsVideo(t) ? "" : " primary") +
      '" href="/api/dl/stream/' + enc(t.id) + '">' +
      '<i class="bi bi-download"></i>保存</a>';
  }
  ops += op("delete", "删除", "bi-trash3", "bad");

  const err = (t.error && (t.status === "failed" || t.status === "canceled"))
    ? '<div class="dl-err">' + esc(t.error) + "</div>" : "";

  return '<div class="dl-card" data-id="' + esc(t.id) + '">' +
    '<div class="dl-ic ' + ic.cls + (stCls === "fail" ? " fail" : (stCls === "done" ? " done" : "")) + '">' +
    '<i class="bi ' + ic.i + '"></i></div>' +
    '<div class="dl-main">' +
    '<div class="dl-head-row"><div class="dl-name">' + esc(t.name || "(未命名)") + "</div>" +
    '<span class="dl-state ' + stCls + '">' + esc(stText) + "</span></div>" +
    '<div class="dl-sub">' + esc(sub) + "</div>" +
    (indet || pr.size > 0
      ? '<div class="dl-bar ' + barCls + '"><i style="width:' + barPct + '%"></i></div>' : "") +
    err +
    '<div class="dl-ops">' + ops + "</div>" +
    "</div></div>";
}

function downloadPaintTabBadge() {
  const badge = $("tabDlBadge");
  if (!badge) return;
  const n = Number((D.stats || {}).active || 0);
  badge.textContent = n > 99 ? "99+" : String(n);
  badge.classList.toggle("on", n > 0);
}

/* ==================================================================
   任务操作
   ================================================================== */
async function downloadAction(id, act) {
  const t = D.items.filter(function (x) { return x.id === id; })[0];
  if (!t) return;
  if (act === "play") {
    downloadPlay(id);
    return;
  }
  if (act === "delete") {
    const ok = await uiConfirm("删除任务「" + (t.name || "未命名") + "」？产物文件会一起清理，且不可恢复。",
      { title: "删除任务", okText: "删除" });
    if (!ok) return;
  }
  const r = await apiPost("/api/dl/tasks/" + enc(id) + "/action", { action: act });
  if (r.error) toast(r.error, "err");
  else if (act === "delete") toast("已删除", "ok");
  else if (act === "pause") toast("已暂停", "ok");
  else if (act === "start") toast("已开始", "ok");
  else if (act === "cancel") toast("已取消", "ok");
  else if (act === "retry") toast("已重新开始", "ok");
  await downloadLoad(true);
}

async function downloadBulk(action) {
  const arr = D.items.filter(function (t) {
    if (action === "pause") return ["downloading", "probing", "merging"].indexOf(t.status) >= 0;
    return t.status === "paused";
  });
  if (!arr.length) return toast(action === "pause" ? "没有正在下载的任务" : "没有已暂停的任务", "warn");
  const btns = document.querySelectorAll("#dlPauseAll,#dlResumeAll");
  btns.forEach(function (b) { b.disabled = true; });
  let ok = 0;
  for (let i = 0; i < arr.length; i++) {
    const r = await apiPost("/api/dl/tasks/" + enc(arr[i].id) + "/action", { action: action });
    if (!r.error) ok++;
  }
  toast((action === "pause" ? "已暂停 " : "已继续 ") + ok + " 个任务", ok ? "ok" : "err");
  await downloadLoad(true);
}

/* ==================================================================
   新建下载
   ================================================================== */
function downloadSplitUrls(raw) {
  const out = [];
  String(raw || "").split(/[\r\n]+/).forEach(function (line) {
    line.split(/,(?=\s*(?:https?|ftp|magnet):)/).forEach(function (s) {
      const v = s.trim();
      if (v) out.push(v);
    });
  });
  return out;
}
function downloadCleanName(name) {
  return String(name || "").replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, "")
    .replace(/^[. ]+/, "").replace(/[. ]+$/, "").slice(0, 180);
}

function downloadNewSheet() {
  const cfg = D.cfg || {};
  const threads = Number(cfg.threads || 2);
  let threadOpts = "";
  const threadList = [1, 2, 4, 8, 16, 32];
  if (threadList.indexOf(threads) < 0) threadList.push(threads);
  threadList.sort(function (a, b) { return a - b; }).forEach(function (n) {
    threadOpts += '<option value="' + n + '"' + (n === threads ? " selected" : "") + ">" + n + " 线程</option>";
  });
  const html =
    '<div class="fld"><label>下载链接' +
    '<button class="linkbtn" type="button" data-act="probe"><i class="bi bi-search"></i>解析链接</button></label>' +
    '<textarea id="dlUrls" placeholder="支持 http / https / ftp / magnet，每行一个链接"></textarea>' +
    '<div class="hint" id="dlProbeHint">填好后可先点「解析链接」自动识别文件名与大小。</div></div>' +
    '<div class="fld"><label>文件名（可选）</label>' +
    '<input id="dlFilename" type="text" placeholder="留空按链接 / 响应头自动识别"></div>' +
    '<div class="fld-row">' +
    '<div class="fld"><label>线程数</label><select id="dlThreads">' + threadOpts + "</select></div>" +
    '<div class="fld"><label>保存目录（可选）</label>' +
    '<input id="dlSaveDir" type="text" value="' + esc(cfg.save_dir || "") + '" placeholder="留空用默认目录"></div>' +
    "</div>" +
    '<label class="check"><input type="checkbox" id="dlForce"> 已存在相同链接时覆盖旧任务</label>' +
    '<button class="btn primary block" data-act="submit"><i class="bi bi-cloud-arrow-down-fill"></i>开始下载</button>' +
    '<div class="sheet-note" style="margin-top:14px">下载在服务器端进行，完成后点任务上的「保存」即可把文件取回手机。</div>';

  openSheet("新建下载", html, async function (act, el) {
    if (act === "probe") {
      const urls = downloadSplitUrls($("dlUrls").value);
      const hint = $("dlProbeHint");
      if (!urls.length) {
        hint.className = "hint err";
        hint.textContent = "请先填写下载链接";
        return;
      }
      el.disabled = true;
      hint.className = "hint";
      hint.textContent = "正在解析链接…";
      const r = await apiPost("/api/dl/probe", { url: urls[0] });
      el.disabled = false;
      if (r.error) {
        hint.className = "hint err";
        hint.textContent = r.error;
        return;
      }
      const info = r.info || {};
      if (!($("dlFilename").value || "").trim() && info.name) {
        $("dlFilename").value = downloadCleanName(info.name);
      }
      hint.className = "hint ok";
      hint.textContent = [
        info.name || "未知文件名",
        info.size > 0 ? fmtBytes(info.size) : "大小未知",
        info.range ? "支持多线程 / 断点续传" : "不支持分段",
      ].join(" · ");
      return;
    }

    if (act !== "submit") return;
    const urls = downloadSplitUrls($("dlUrls").value);
    if (!urls.length) {
      $("dlProbeHint").className = "hint err";
      $("dlProbeHint").textContent = "请至少填写一个下载链接";
      return;
    }
    const name = downloadCleanName($("dlFilename").value);
    const dir = ($("dlSaveDir").value || "").trim();
    const threads = Number($("dlThreads").value) || 2;
    const force = !!$("dlForce").checked;
    el.disabled = true;
    el.innerHTML = '<i class="bi bi-arrow-repeat"></i>正在创建…';

    let ok = 0, lastErr = "", dup = false;
    for (let i = 0; i < urls.length; i++) {
      const body = {
        url: urls[i], save_dir: dir, threads: threads, force: force,
      };
      if (urls.length === 1 && name) body.filename = name;
      const r = await apiPost("/api/dl/url", body);
      if (r.error) {
        lastErr = (urls.length > 1 ? urls[i].slice(0, 30) + "…：" : "") + r.error;
        if (r.need_confirm) dup = true;
      } else {
        ok++;
      }
    }
    el.disabled = false;
    el.innerHTML = '<i class="bi bi-cloud-arrow-down-fill"></i>开始下载';
    if (ok) {
      closeSheet();
      toast("已创建 " + ok + " 个下载任务", "ok");
      D.tab = "all";
      await downloadLoad(true);
    }
    if (lastErr) {
      toast(dup ? "已存在相同链接的任务，可勾选「覆盖旧任务」后重试" : lastErr, "err");
    }
  });
}

/* ==================================================================
   下载设置
   ================================================================== */
async function downloadSettingsSheet() {
  openSheet("下载设置", '<div class="hint">正在读取设置…</div>');
  const r = await apiGet("/api/dl/settings");
  if (!sheetVisible()) return;          // 读取期间用户已经关掉弹层
  if (r.error) {
    toast("读取设置失败：" + r.error, "err");
    return;
  }
  const cfg = r.settings || {};
  const usage = r.usage || {};
  D.cfg = cfg;
  D.usage = usage;

  const sel = function (id, cur, items) {
    const list = items.slice();
    const v = Number(cur);
    // 当前值不在候选里（比如旧的 3 线程配置）也要能选中，避免一保存就被改成别的值
    if (list.indexOf(v) < 0 && isFinite(v)) {
      list.push(v);
      list.sort(function (a, b) { return a - b; });
    }
    return '<select id="' + id + '">' + list.map(function (n) {
      return '<option value="' + n + '"' + (v === n ? " selected" : "") + ">" + n + "</option>";
    }).join("") + "</select>";
  };

  const html =
    '<div class="usage-grid">' +
    '<div class="usage-cell"><span>产物占用</span><b>' + esc(fmtBytes(usage.artifact_bytes || 0)) + "</b></div>" +
    '<div class="usage-cell"><span>磁盘剩余</span><b>' + esc(fmtBytes(usage.disk_free || 0)) + "</b></div>" +
    '<div class="usage-cell"><span>记录条数</span><b>' + esc(usage.records || 0) + "</b></div>" +
    '<div class="usage-cell"><span>产物文件</span><b>' + esc(usage.artifacts || 0) + " 个</b></div>" +
    "</div>" +
    '<div class="fld"><label>默认保存目录</label>' +
    '<input id="dlCfgDir" type="text" value="' + esc(cfg.save_dir || "") + '"></div>' +
    '<div class="fld-row">' +
    '<div class="fld"><label>下载线程</label>' + sel("dlCfgThreads", cfg.threads, [1, 2, 4, 8, 16, 32]) + "</div>" +
    '<div class="fld"><label>并发任务</label>' + sel("dlCfgConc", cfg.concurrency, [1, 2, 3, 4, 5]) + "</div>" +
    "</div>" +
    '<div class="fld"><label>限速（KB/s，0 = 不限）</label>' +
    '<input id="dlCfgThrottle" type="number" min="0" step="64" value="' + Number(cfg.throttle_kbps || 0) + '"></div>' +
    '<div class="switch-row"><div><b>断点续传</b><span class="hint">中断后从已下载位置继续</span></div>' +
    '<label class="switch"><input type="checkbox" id="dlCfgResume"' + (cfg.resume ? " checked" : "") + "><i></i></label></div>" +
    '<div class="switch-row"><div><b>完成通知</b><span class="hint">下载完成 / 失败时推送通知</span></div>' +
    '<label class="switch"><input type="checkbox" id="dlCfgNotify"' + (cfg.notify ? " checked" : "") + "><i></i></label></div>" +
    '<button class="btn primary block" data-act="save" style="margin-top:16px">保存设置</button>';

  openSheet("下载设置", html, async function (act, el) {
    if (act !== "save") return;
    el.disabled = true;
    el.innerHTML = '<i class="bi bi-arrow-repeat"></i>保存中…';
    const payload = {
      save_dir: ($("dlCfgDir").value || "").trim(),
      threads: Number($("dlCfgThreads").value) || 2,
      concurrency: Number($("dlCfgConc").value) || 2,
      throttle_kbps: Math.max(0, Number($("dlCfgThrottle").value) || 0),
      resume: !!$("dlCfgResume").checked,
      notify: !!$("dlCfgNotify").checked,
    };
    const res = await apiPost("/api/dl/settings", payload);
    el.disabled = false;
    el.innerHTML = "保存设置";
    if (res.error) return toast("保存失败：" + res.error, "err");
    D.cfg = res.settings || D.cfg;
    closeSheet();
    toast("下载设置已保存", "ok");
  });
}

/* ==================================================================
   事件绑定
   ================================================================== */
$("dlTabs").addEventListener("click", function (e) {
  const b = e.target.closest("button[data-tab]");
  if (!b) return;
  D.tab = b.getAttribute("data-tab");
  // 先回到顶部再重绘：重绘时会把滚动位置原样还原，顺序反了会先停在旧位置再跳一下
  $("content").scrollTop = 0;
  downloadPaint();
});

$("dlList").addEventListener("click", function (e) {
  const b = e.target.closest(".dl-op[data-act]");
  if (!b) return;
  const id = b.getAttribute("data-id");
  if (id) downloadAction(id, b.getAttribute("data-act"));
});

$("dlNewBtn").addEventListener("click", downloadNewSheet);
$("dlSetBtn").addEventListener("click", downloadSettingsSheet);
$("dlRefreshBtn").addEventListener("click", function () { downloadLoad(false); });
$("dlPauseAll").addEventListener("click", function () { downloadBulk("pause"); });
$("dlResumeAll").addEventListener("click", function () { downloadBulk("start"); });

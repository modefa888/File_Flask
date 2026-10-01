  // ---------- 后台任务通用进度（删除 / 解压 等，可挂后台胶囊） ----------
  var _bgTasks = {};      // key -> {kind, timer, onDone, title, last, progUrl}
  var _activeBg = null;
  var _bgSeq = 0;

  function fmtDelBytes(n) {
    if (!n) return "0 B";
    var u = ["B", "KB", "MB", "GB", "TB"], i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return n.toFixed(n >= 100 || i === 0 ? 0 : 1) + " " + u[i];
  }
  function bgIco(kind) { return kind === "uz" ? "📂" : (kind === "zip" ? "📦" : (kind === "mv" ? "↔️" : (kind === "cp" ? "📄" : "🗑️"))); }
  function bgUpdateModal(d) {
    document.getElementById("delProgBar").style.width = (d.percent || 0) + "%";
    document.getElementById("delProgFiles").textContent =
      d.done_files + " / " + d.total_files + " 个文件";
    document.getElementById("delProgBytes").textContent =
      fmtDelBytes(d.done_bytes) + " / " + fmtDelBytes(d.total_bytes);
    document.getElementById("delProgCur").textContent = d.current || "";
  }
  function bgOpenModal(key) {
    _activeBg = key;
    var t = _bgTasks[key];
    document.getElementById("delProgTitle").textContent = (t && t.title) || "处理中…";
    if (t && t.last) bgUpdateModal(t.last);
    else {
      document.getElementById("delProgBar").style.width = "0%";
      document.getElementById("delProgFiles").textContent = "准备中…";
      document.getElementById("delProgBytes").textContent = "";
      document.getElementById("delProgCur").textContent = "";
    }
    document.getElementById("delProgBox").classList.add("show");
    bgRenderDock();
  }
  function bgCloseModal() {  // 仅收起弹窗，任务继续在后台跑
    document.getElementById("delProgBox").classList.remove("show");
    _activeBg = null;
    bgRenderDock();
  }
  function bgRenderDock() {
    var dock = document.getElementById("delTaskDock");
    var ids = Object.keys(_bgTasks);
    if (!ids.length) { dock.classList.remove("show"); dock.innerHTML = ""; return; }
    dock.classList.add("show");
    dock.innerHTML = ids.map(function (id) {
      var t = _bgTasks[id], d = t.last;
      var txt = d ? (Math.round(d.percent || 0) + "% · " + fmtDelBytes(d.done_bytes) +
        (d.total_bytes ? " / " + fmtDelBytes(d.total_bytes) : "")) : "准备中…";
      var fin = d && d.status !== "running";
      return '<div class="del-task' + (fin ? " done" : "") + '" data-task="' + id + '">' +
        '<span>' + bgIco(t.kind) + '</span><span class="dt-txt">' + esc(txt) + '</span></div>';
    }).join("");
  }
  document.getElementById("delTaskDock").addEventListener("click", function (e) {
    var el = e.target.closest && e.target.closest(".del-task");
    if (el && _bgTasks[el.getAttribute("data-task")]) bgOpenModal(el.getAttribute("data-task"));
  });
  document.getElementById("delProgMin").addEventListener("click", bgCloseModal);

  function bgFinish(key, d) {
    var t = _bgTasks[key];
    if (!t) return;
    clearInterval(t.timer);
    if (t.es) { try { t.es.close(); } catch (e) {} t.es = null; }
    delete _bgTasks[key];
    if (_activeBg === key) bgCloseModal();
    else bgRenderDock();
    var errs = (d.errors || []).concat((d.result && d.result.errors) || []);
    var _lbl = t.kind === "uz" ? "解压" : (t.kind === "zip" ? "压缩" : (t.kind === "mv" ? "移动" : (t.kind === "cp" ? "复制" : "删除")));
    if (errs.length) toast(_lbl + "失败：" + errs[0], "error");
    if (t.onDone) t.onDone(!errs.length, d);
  }
  function bgPollApply(key, d) {
    var tt = _bgTasks[key];
    if (!tt) return;
    if (d.error) { bgFinish(key, { errors: [d.error] }); return; }
    tt.last = d;
    if (_activeBg === key) bgUpdateModal(d);
    else bgRenderDock();
    if (d.status !== "running") bgFinish(key, d);
  }
  function bgPollFallback(key) {   // SSE 不可用时回退到 400ms 轮询
    var t = _bgTasks[key];
    if (!t) return;
    t.timer = setInterval(function () {
      fetchTimeout(t.progUrl, 8000).then(function (r) { return r.json(); })
        .then(function (d) { bgPollApply(key, d); })
        .catch(function () { /* 单次轮询失败继续下一轮 */ });
    }, 400);
  }
  function bgPoll(key) {
    var t = _bgTasks[key];
    if (!t) return;
    // 优先走 SSE 流式进度：一个长连接收完整个任务生命周期，不再几百次轮询
    if (typeof EventSource !== "undefined") {
      var es = new EventSource("/api/progress/stream?task_id=" + encodeURIComponent(t.taskId));
      t.es = es;
      es.onmessage = function (ev) {
        var d;
        try { d = JSON.parse(ev.data); } catch (e) { return; }
        bgPollApply(key, d);
      };
      es.onerror = function () {
        var tt = _bgTasks[key];
        if (!tt || tt.es !== es) return;   // 已被结束/替换
        es.close(); tt.es = null;
        if (tt.last && tt.last.status !== "running") return;   // 已收尾，无需回退
        bgPollFallback(key);   // 流断开/后端未升级 → 回退轮询
      };
      return;
    }
    bgPollFallback(key);
  }
  function bgStart(kind, startUrl, payload, opts) {
    opts = opts || {};
    if (_activeBg && _bgTasks[_activeBg]) _activeBg = null;  // 旧任务转入后台胶囊
    _bgSeq++;
    var ph = "pending" + _bgSeq;
    _bgTasks[ph] = {
      kind: kind, timer: null, onDone: opts.onDone,
      title: opts.title || "处理中…", last: null, progUrl: ""
    };
    bgOpenModal(ph);
    fetchTimeout(startUrl, 15000, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    })
      .then(function (r) {
        if (r.status === 404) throw new Error("no-api");  // 后端未重启升级 → 旧接口兜底
        return r.json();
      })
      .then(function (d) {
        var t = _bgTasks[ph];
        if (!t) return;
        if (d.error) {
          delete _bgTasks[ph]; bgCloseModal();
          toast(d.error, "error");
          if (opts.onDone) opts.onDone(false, d);
          return;
        }
        var key = kind + ":" + d.task_id;
        _bgTasks[key] = t;
        delete _bgTasks[ph];
        t.taskId = d.task_id;
        var progPath = kind === "uz" ? "zip/unzip" : (kind === "zip" ? "zip/create" : (kind === "mv" ? "move" : (kind === "cp" ? "copy" : "delete")));
        t.progUrl = "/api/" + progPath + "/progress?task_id=" + encodeURIComponent(d.task_id);
        if (_activeBg === ph) _activeBg = key;
        bgPoll(key);
        bgRenderDock();
      })
      .catch(function (er) {
        var t = _bgTasks[ph];
        if (er && er.message === "no-api") {   // 旧接口兜底（无进度条）
          delete _bgTasks[ph]; bgCloseModal();
          if (opts.legacy) opts.legacy();
          return;
        }
        delete _bgTasks[ph]; bgCloseModal();
        toast((er && er.name === "AbortError") ? "请求超时" : (opts.label || "操作") + "请求失败", "error");
        if (opts.onDone) opts.onDone(false);
      });
  }

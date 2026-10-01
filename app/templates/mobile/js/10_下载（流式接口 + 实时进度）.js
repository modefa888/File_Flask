  // ---------- 下载（流式接口 + 实时进度） ----------
  var _dlCtrl = null;

  function showDlProgress(name) {
    document.getElementById("dlProgTitle").textContent = "正在下载 " + (name || "");
    document.getElementById("dlProgBar").className = "delprog-bar indet";
    document.getElementById("dlProgBar").style.width = "";
    document.getElementById("dlProgBytes").textContent = "连接中…";
    document.getElementById("dlProgSpeed").textContent = "";
    document.getElementById("dlProgBox").classList.add("show");
  }
  function hideDlProgress() {
    document.getElementById("dlProgBox").classList.remove("show");
    _dlCtrl = null;
  }
  function updateDlProgress(got, total, speed) {
    var bar = document.getElementById("dlProgBar");
    if (total > 0) {
      bar.classList.remove("indet");
      bar.style.width = Math.min(100, got / total * 100).toFixed(1) + "%";
    } else {
      bar.classList.add("indet");
    }
    document.getElementById("dlProgBytes").textContent =
      fmtDelBytes(got) + (total > 0 ? " / " + fmtDelBytes(total) : "");
    document.getElementById("dlProgSpeed").textContent = speed || "";
  }
  function saveDlBlob(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 3000);
  }
  function download(item) {
    var abs = itemAbs(item);
    showDlProgress(item.name);
    _dlCtrl = (typeof AbortController !== "undefined") ? new AbortController() : null;
    fetch("/api/download?path=" + encodeURIComponent(abs),
          _dlCtrl ? { signal: _dlCtrl.signal } : {})
      .then(function (r) {
        if (!r.ok) {
          return r.json().catch(function () { return {}; }).then(function (d) {
            throw new Error(d.error || ("HTTP " + r.status));
          });
        }
        var total = parseInt(r.headers.get("Content-Length") || "0", 10) || 0;
        // 老浏览器无流式接口：整体 blob 后保存
        if (!r.body || !r.body.getReader) {
          return r.blob().then(function (b) {
            saveDlBlob(b, item.name); hideDlProgress(); toast("下载完成", "success");
          });
        }
        // 超大文件（>1GB）避免占满内存：转系统直链下载
        if (total > 1024 * 1024 * 1024) {
          hideDlProgress();
          toast("文件较大，已转系统下载", "warn");
          var a = document.createElement("a");
          a.href = "/api/download?path=" + encodeURIComponent(abs);
          a.download = item.name;
          document.body.appendChild(a); a.click(); a.remove();
          return;
        }
        var reader = r.body.getReader();
        var chunks = [], got = 0, lastT = Date.now(), lastB = 0, speed = "";
        function pump() {
          return reader.read().then(function (res) {
            if (res.done) {
              var type = r.headers.get("Content-Type") || "application/octet-stream";
              saveDlBlob(new Blob(chunks, { type: type }), item.name);
              hideDlProgress();
              toast("下载完成", "success");
              return;
            }
            chunks.push(res.value);
            got += res.value.length;
            var now = Date.now();
            if (now - lastT >= 500) {
              speed = fmtDelBytes((got - lastB) * 1000 / (now - lastT)) + "/s";
              lastT = now; lastB = got;
            }
            updateDlProgress(got, total, speed);
            return pump();
          });
        }
        return pump();
      })
      .catch(function (e) {
        hideDlProgress();
        toast((e && e.name === "AbortError") ? "已取消下载"
              : ("下载失败：" + ((e && e.message) || "")), "error");
      });
  }
  document.getElementById("dlProgCancel").addEventListener("click", function () {
    if (_dlCtrl) _dlCtrl.abort();
    hideDlProgress();
  });

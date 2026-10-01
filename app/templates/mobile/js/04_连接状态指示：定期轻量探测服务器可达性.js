  // ---------- 连接状态指示：定期轻量探测服务器可达性 ----------
  var _connState = "";
  function setConnState(s) {
    if (_connState === s) return;
    _connState = s;
    var dot = document.getElementById("connDot");
    if (!dot) return;
    dot.className = "conn-dot " + s;
    dot.title = s === "on" ? "已连接服务器"
      : (s === "off" ? "无法连接服务器（显示的可能是缓存数据）" : "检测连接…");
  }
  function pingConn() {
    if (!navigator.onLine) { setConnState("off"); return; }
    fetchTimeout("/", 5000, { method: "HEAD" })
      .then(function () { setConnState("on"); })
      .catch(function () { setConnState("off"); });
  }
  window.addEventListener("online", pingConn);
  window.addEventListener("offline", function () { setConnState("off"); });
  setInterval(pingConn, 30000);
  pingConn();

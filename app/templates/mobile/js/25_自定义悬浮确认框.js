  // ---------- 自定义悬浮确认框 ----------
  function confirmBox(opts) {
    opts = opts || {};
    document.getElementById("confirmTitle").textContent = opts.title || "提示";
    document.getElementById("confirmMsg").textContent = opts.message || "";
    var okBtn = document.getElementById("confirmOk");
    okBtn.textContent = opts.okText || "确定";
    okBtn.classList.toggle("danger", !!opts.danger);
    document.getElementById("confirmBox").classList.add("show");
    document.body.classList.add("lock");
    var done = false;
    function close() {
      if (done) return; done = true;
      document.getElementById("confirmBox").classList.remove("show");
      document.body.classList.remove("lock");
    }
    document.getElementById("confirmOk").onclick = function () { close(); if (opts.onOk) opts.onOk(); };
    document.getElementById("confirmCancel").onclick = close;
    document.getElementById("confirmBox").onclick = function (e) { if (e.target === this) close(); };
  }

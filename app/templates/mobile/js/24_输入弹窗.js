  // ---------- 输入弹窗 ----------
  var dialogCallback = null;
  function showDialog(title, value, cb) {
    dialogCallback = cb;
    document.getElementById("dialogTitle").textContent = title;
    var inp = document.getElementById("dialogInput");
    inp.value = value || "";
    document.getElementById("dialog").classList.add("show");
    setTimeout(function () { inp.focus(); inp.select(); }, 50);
  }
  function closeDialog() {
    document.getElementById("dialog").classList.remove("show");
    dialogCallback = null;
  }
  document.getElementById("dialogCancel").addEventListener("click", closeDialog);
  document.getElementById("dialog").addEventListener("click", function (e) {
    if (e.target === this) closeDialog();
  });
  document.getElementById("dialogOk").addEventListener("click", function () {
    if (dialogCallback) dialogCallback(document.getElementById("dialogInput").value);
    closeDialog();
  });
  document.getElementById("dialogInput").addEventListener("keydown", function (e) {
    if (e.key === "Enter") { if (dialogCallback) dialogCallback(this.value); closeDialog(); }
  });

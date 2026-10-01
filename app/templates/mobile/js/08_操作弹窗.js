  // ---------- 操作弹窗 ----------
  function openActions(item, contextItems) {
    var ext = extOf(item.name);
    var head = document.getElementById("sheetHead");
    var btns = document.getElementById("sheetBtns");
    btns.innerHTML = "";
    var abs = itemAbs(item);
    head.innerHTML = '<span class="sh-thumb">' + _titleThumbHtml(item) + '</span>' +
      '<span class="sh-name">' + esc(item.name) + '</span>';

    function addBtn(label, ico, cls, handler, disabled) {
      var b = document.createElement("button");
      b.className = "sheet-btn" + (cls ? " " + cls : "") + (disabled ? " disabled" : "");
      b.innerHTML = '<span class="ico">' + ico + '</span><span>' + label + '</span>';
      if (!disabled && handler) b.addEventListener("click", function () { closeSheet(); handler(); });
      btns.appendChild(b);
    }

    addBtn("预览 / 打开", "👁️", "", function () { openPreview(item, contextItems); }, isDir(item));
    addBtn("收藏", "⭐", "", function () {
      pickGroup(function (g) {
        if (g === "__new__") newGroupThen(function (name) { addFav(abs, name); });
        else addFav(abs, g);
      });
    });
    // 只在「＋ 添加文件夹」触发后出现，且一触发只能用一次
    if (isDir(item) && _plAddPending) {
      addBtn("添加到音乐播放列表", "🎶", "", function () {
        _plAddPending = false;          // 用完即失效：想再添加需再次点播放器里的「＋ 添加文件夹」
        _addDirToPlaylist(abs);
      });
    }
    if (AUDIO_EXT.indexOf(ext) >= 0) {
      addBtn("播放", "🎵", "", function () { openAudioPlayer(item, contextItems); });
    }
    if (item.abs_path) {          // 搜索结果：支持直接跳到文件所在文件夹
      addBtn("前往所在文件夹", "🧭", "", function () {
        closeSearchPage();
        load(dirnameOf(item.abs_path));
      });
    }
    addBtn("重命名", "✏️", "", function () { doRename(item); });
    if (!isDir(item)) {
      addBtn("移动到…", "➡️", "", function () { setPendingOp("move", [itemAbs(item)]); });
      addBtn("复制到…", "📑", "", function () { setPendingOp("copy", [itemAbs(item)]); });
    }
    addBtn("压缩为 ZIP", "📦", "", function () { doCompress(item); });
    if (ext === "zip" || ext === "rar") {
      addBtn("查看压缩包", "📦", "", function () { openZipViewer(item); });
    }
    if (ext === "zip") {
      addBtn("解压到当前目录", "📂", "", function () { doUnzip(item); });
    }
    addBtn("属性", "ℹ️", "", function () { showProperties(item); });
    var canDl = (VIDEO_EXT.indexOf(ext) >= 0 || MOBILE_IMG_EXT.indexOf(ext) >= 0 ||
                 TEXT_EXT.indexOf(ext) >= 0 || ARCHIVE_EXT.indexOf(ext) >= 0);
    addBtn("下载", "⬇️", "", function () {
      confirmBox({
        title: "确认下载",
        message: "确定要下载「" + item.name + "」吗？" +
          (item.size_str ? "（" + item.size_str + "）" : ""),
        okText: "下载",
        onOk: function () { download(item); }
      });
    }, !canDl);
    addBtn("删除", "🗑️", "danger", function () { doDelete(item); });

    document.getElementById("sheetMask").classList.add("show");
    document.getElementById("sheet").classList.add("show");
    // 底部弹窗与迷你播放条重叠：打开时暂时收起，关闭后恢复
    var mp = document.getElementById("miniPlayer");
    if (mp.classList.contains("show")) {
      mp.classList.remove("show");
      mp.setAttribute("data-restore", "1");
    }
  }
  function closeSheet() {
    document.getElementById("sheetMask").classList.remove("show");
    document.getElementById("sheet").classList.remove("show");
    document.getElementById("sheet").classList.remove("favmode");
    var mp = document.getElementById("miniPlayer");
    if (mp.getAttribute("data-restore")) {
      mp.removeAttribute("data-restore");
      mp.classList.add("show");
    }
  }
  document.getElementById("sheetMask").addEventListener("click", closeSheet);

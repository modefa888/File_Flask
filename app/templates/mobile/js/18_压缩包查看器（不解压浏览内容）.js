  // ---------- 压缩包查看器（不解压浏览内容） ----------
  var _zipAbs = "", _zipName = "", _zipDir = "", _zipView = "list", _zipMeta = null;
  var _zipPwd = "";
  var _zipOuter = "", _zipNestedEntry = "", _zipOuterName = "";   // 嵌套压缩包：外层包 + 成员路径
  var _zipOuterDir = "", _zipOuterPwd = "";                       // 外层包当时的目录/密码（返回时恢复）

  function openZipViewer(item) {
    _zipAbs = itemAbs(item);
    _zipName = item.name;
    _zipDir = "";
    _zipPwd = "";                                 // 每次打开重置密码
    _zipOuter = ""; _zipNestedEntry = ""; _zipOuterName = ""; _zipOuterDir = ""; _zipOuterPwd = "";
    document.getElementById("zpTitle").textContent = _zipName;
    document.getElementById("zipPage").classList.add("show");
    loadZipDir("");
  }
  // 打开外层包内的 zip 成员（嵌套查看）
  function openNestedZipViewer(outerAbs, outerName, memberEntry) {
    _zipOuter = outerAbs;
    _zipOuterName = outerName;
    _zipOuterDir = _zipDir;                       // 记住外层包当前目录，返回时恢复
    _zipOuterPwd = _zipPwd;
    _zipNestedEntry = memberEntry;
    _zipAbs = "";
    _zipName = memberEntry.split("/").pop() || memberEntry;
    _zipDir = ""; _zipView = "list"; _zipPwd = "";
    document.getElementById("zpTitle").textContent = _zipName;
    document.getElementById("zipPage").classList.add("show");
    loadZipDir("");
  }
  // 从嵌套包退回外层包刚才所在的目录
  function backToOuterZip() {
    _zipAbs = _zipOuter;
    _zipName = _zipOuterName || _zipName;
    var dir = _zipOuterDir || "";
    _zipPwd = _zipOuterPwd || "";
    _zipOuter = ""; _zipNestedEntry = ""; _zipOuterName = ""; _zipOuterDir = ""; _zipOuterPwd = "";
    document.getElementById("zpTitle").textContent = _zipName;
    loadZipDir(dir);
  }
  function zipPwdQ() { return _zipPwd ? "&pwd=" + encodeURIComponent(_zipPwd) : ""; }
  function askZipPwd(then) {                      // 输入密码后回调
    showDialog("输入压缩包密码", "", function (v) {
      _zipPwd = (v || "").trim();
      then();
    });
  }
  function closeZipViewer() {
    document.getElementById("zipPage").classList.remove("show");
    _zipAbs = ""; _zipDir = ""; _zipView = "list";
    _zipOuter = ""; _zipNestedEntry = ""; _zipOuterName = ""; _zipOuterDir = ""; _zipOuterPwd = "";
  }
  function zipEntryPath(name) { return _zipDir ? _zipDir + "/" + name : name; }
  function fmtZipSize(n) {
    if (n == null) return "";
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
    if (n < 1073741824) return (n / 1048576).toFixed(2) + " MB";
    return (n / 1073741824).toFixed(2) + " GB";
  }
  function loadZipDir(dir) {
    _zipDir = dir; _zipView = "list";
    var body = document.getElementById("zpBody");
    body.innerHTML = '<div class="empty">加载中…</div>';
    renderZipCrumb();
    var url = _zipOuter
      ? "/api/zip/nested?zip_path=" + encodeURIComponent(_zipOuter) +
        "&outer_entry=" + encodeURIComponent(_zipNestedEntry) +
        "&inner_dir=" + encodeURIComponent(dir)
      : "/api/zip/contents?path=" + encodeURIComponent(_zipAbs) +
        (dir ? "&dir=" + encodeURIComponent(dir) : "") + zipPwdQ();
    fetchTimeout(url, 10000)
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.error) {
          // 加密 RAR：首次未输密码时提示输入，输入后自动重试
          if (/密码/.test(d.error) && !_zipPwd) {
            body.innerHTML = '<div class="empty">' + esc(d.error) +
              ' <a href="javascript:void(0)" id="zpPwd" style="color:var(--primary)">🔑 输入密码</a></div>';
            var pe = document.getElementById("zpPwd");
            if (pe) pe.addEventListener("click", function () {
              askZipPwd(function () { loadZipDir(_zipDir); });
            });
            return;
          }
          body.innerHTML = '<div class="empty">' + esc(d.error) + '</div>';
          return;
        }
        _zipMeta = d;
        renderZipList(d.entries || []);
      })
      .catch(function (e) {
        var msg = (e && e.name === "AbortError") ? "加载超时" : (e.message || e);
        body.innerHTML = '<div class="empty">' + esc(msg) +
          ' <a href="javascript:void(0)" id="zpRetry" style="color:var(--primary)">↻ 重试</a></div>';
        var rt = document.getElementById("zpRetry");
        if (rt) rt.addEventListener("click", function () { loadZipDir(_zipDir); });
      });
  }
  function renderZipCrumb() {
    var crumb = document.getElementById("zpCrumb");
    var html = '<button data-d="">📦 ' + esc(_zipName) + '</button>';
    var acc = "";
    (_zipDir ? _zipDir.split("/") : []).forEach(function (p) {
      acc += (acc ? "/" : "") + p;
      html += '<span>›</span><button data-d="' + esc(acc) + '">' + esc(p) + '</button>';
    });
    crumb.innerHTML = html;
    Array.prototype.forEach.call(crumb.querySelectorAll("button"), function (b) {
      b.addEventListener("click", function () { loadZipDir(b.getAttribute("data-d")); });
    });
  }
  function renderZipList(entries) {
    var body = document.getElementById("zpBody");
    var meta = _zipMeta || {};
    var metaLine = "";
    if (meta.entry_count != null) {
      metaLine = '<div class="zp-meta">📦 ' + esc(meta.zip_size_str || "") +
        ' · ' + meta.entry_count + ' 项' +
        (meta.total_uncompressed_str ? ' · 解压后 ' + esc(meta.total_uncompressed_str) : '') +
        '</div>';
    }
    if (!entries.length) {
      body.innerHTML = metaLine + '<div class="empty">空文件夹</div>';
      return;
    }
    entries = entries.slice().sort(function (a, b) {
      if (!!a.is_dir !== !!b.is_dir) return a.is_dir ? -1 : 1;
      return a.name.localeCompare(b.name, "zh-CN");
    });
    var frag = document.createDocumentFragment();
    entries.forEach(function (e) {
      var row = document.createElement("div");
      row.className = "item";                      // 与主列表同款行布局
      var sub = e.is_dir
        ? "文件夹"
        : (fmtZipSize(e.size) + " · " + fileTypeName(e));
      row.innerHTML =
        '<div class="thumb">' + iconHtmlFor({ name: e.name, is_dir: e.is_dir }) + '</div>' +
        '<div class="meta">' +
          '<div class="name-row"><div class="name">' + esc(e.name) + '</div></div>' +
          '<div class="sub">' + esc(sub) + '</div>' +
        '</div>';
      row.addEventListener("click", function () {
        if (e.is_dir) { loadZipDir(zipEntryPath(e.name)); } else { zipEntryInfo(e); }
      });
      frag.appendChild(row);
    });
    body.innerHTML = metaLine;
    body.appendChild(frag);
  }
  // 嵌套解压：把外层包内的 zip 成员单独解压到外层包所在目录（走后台任务进度）
  function nestedUnzip(outerAbs, memberEntry, memberName) {
    bgStart("uz", "/api/zip/nested/unzip/start", {
      path: outerAbs, outer_entry: memberEntry,
      name: (memberName || "解压结果").replace(/\.zip$/i, "")
    }, {
      title: "正在解压：" + (memberName || "嵌套压缩包"),
      label: "解压",
      onDone: function (ok, d) {
        if (ok && d && d.result && d.result.files != null) {
          toast("已解压 " + d.result.files + " 个文件到「" + d.result.name + "」", "success");
        }
        if (ok && d && d.result && d.result.name && d.result.path &&
            normDirPath(dirnameOf(d.result.path)) === normDirPath(state.path)) {
          localAddItem({ name: d.result.name, path: d.result.name, abs_path: d.result.path,
            is_dir: true, size: 0, size_str: "", mtime: nowStrLocal() });
        }
      },
      legacy: function () {   // 后端未升级兜底：退回下载该压缩包成员
        window.open("/api/zip/file?zip_path=" + encodeURIComponent(outerAbs) +
          "&entry=" + encodeURIComponent(memberEntry), "_blank");
      }
    });
  }
  // 点击包内文件：弹出文件信息卡片（不再直接跳转下载）
  function zipEntryInfo(e) {
    var full = zipEntryPath(e.name);
    var ext = extOf(e.name);
    var isNested = !!_zipOuter;
    var isZipMember = ext === "zip";
    var fileUrl = isNested
      ? "/api/zip/nested/file?zip_path=" + encodeURIComponent(_zipOuter) +
        "&outer_entry=" + encodeURIComponent(_zipNestedEntry) + "&inner_path=" + encodeURIComponent(full)
      : "/api/zip/file?zip_path=" + encodeURIComponent(_zipAbs) +
        "&entry=" + encodeURIComponent(full) + zipPwdQ();
    var previewUrl = isNested
      ? "/api/zip/nested/preview?zip_path=" + encodeURIComponent(_zipOuter) +
        "&outer_entry=" + encodeURIComponent(_zipNestedEntry) + "&inner_path=" + encodeURIComponent(full)
      : "/api/zip/preview?zip_path=" + encodeURIComponent(_zipAbs) +
        "&entry=" + encodeURIComponent(full) + zipPwdQ();
    var isImg = MOBILE_IMG_EXT.indexOf(ext) >= 0;
    var isTxt = TEXT_EXT.indexOf(ext) >= 0;
    var mask = document.getElementById("previewMask");
    var body = document.getElementById("previewBody");
    document.getElementById("previewClose").style.display = "none";   // 遮罩层自带的 ✕ 隐藏，卡片内已有关闭

    var card = document.createElement("div");
    card.className = "pv-card zp-fcard";
    card.innerHTML =
      '<div class="pv-head">' +
        '<span class="pv-title">' + esc(e.name) + '</span>' +
        '<button type="button" class="pv-close" data-op="close">✕</button>' +
      '</div>' +
      '<div class="zp-fbody">' +
        '<div class="zp-finfo">' +
          '<div class="zp-finfo-toggle"><span>📄 文件信息</span><span class="tg">收起 ▴</span></div>' +
          '<div class="zp-finfo-rows">' +
            '<div><span>类型</span>' + esc(fileTypeName(e)) + '</div>' +
            '<div><span>大小</span>' + esc(fmtZipSize(e.size)) +
              (e.compressed ? '（压缩后 ' + esc(fmtZipSize(e.compressed)) + '）' : '') + '</div>' +
            '<div><span>路径</span>' + esc(full) + '</div>' +
            '<div><span>所在包</span>' + esc(_zipName) + '</div>' +
          '</div>' +
        '</div>' +
        (isImg ? '<div class="zp-fprev"><img alt=""></div>' : '') +
        (isTxt ? '<pre class="zp-ftext">加载中…</pre>' : '') +
        (!isImg && !isTxt
          ? '<div class="preview-msg" style="padding:4px 0 10px">该类型不支持在线预览，可点击下方下载</div>'
          : '') +
      '</div>' +
      '<div class="zp-fops">' +
        (isZipMember ? '<button type="button" data-op="open">📦 打开</button>' : '') +
        (isZipMember ? '<button type="button" data-op="unzip">📂 解压</button>' : '') +
        '<button type="button" data-op="dl">⬇️ 下载</button>' +
      '</div>';
    body.innerHTML = "";
    body.appendChild(card);
    mask.classList.add("show");

    card.querySelector('[data-op="close"]').addEventListener("click", function () {
      mask.classList.remove("show");
      body.innerHTML = "";
      document.getElementById("previewClose").style.display = "";
    });
    card.querySelector('[data-op="dl"]').addEventListener("click", function () {
      window.open(fileUrl, "_blank");
    });
    if (isZipMember) {
      // 打开：进入嵌套压缩包查看
      card.querySelector('[data-op="open"]').addEventListener("click", function () {
        mask.classList.remove("show"); body.innerHTML = "";
        document.getElementById("previewClose").style.display = "";
        var outerAbs = _zipOuter || _zipAbs;
        var outerName = _zipName;
        var memberEntry = isNested ? (_zipNestedEntry + "/" + full) : full;
        openNestedZipViewer(outerAbs, outerName, memberEntry);
      });
      // 解压：把该压缩包成员单独解压到外层 zip 所在目录
      card.querySelector('[data-op="unzip"]').addEventListener("click", function () {
        mask.classList.remove("show"); body.innerHTML = "";
        document.getElementById("previewClose").style.display = "";
        var outerAbs = _zipOuter || _zipAbs;
        var memberEntry = isNested ? (_zipNestedEntry + "/" + full) : full;
        nestedUnzip(outerAbs, memberEntry, e.name);
      });
    }
    // 文件信息折叠/展开
    var finfo = card.querySelector(".zp-finfo");
    var ftg = card.querySelector(".zp-finfo-toggle");
    ftg.addEventListener("click", function () {
      var folded = finfo.classList.toggle("folded");
      ftg.querySelector(".tg").textContent = folded ? "展开 ▾" : "收起 ▴";
    });
    // 图片预览：用 fetch 带密码加载为 blob，失败（如加密）提示输入密码
    if (isImg) {
      var img = card.querySelector(".zp-fprev");
      fetchTimeout(fileUrl, 15000)
        .then(function (r) {
          if (!r.ok) return r.json().then(function (d) { throw new Error(d.error || "加载失败"); });
          return r.blob();
        })
        .then(function (blob) {
          var u = URL.createObjectURL(blob);
          var im = new Image();
          im.onload = function () { img.innerHTML = ""; img.appendChild(im); URL.revokeObjectURL(u); };
          im.onerror = function () { img.innerHTML = '<div class="empty">图片预览失败</div>'; };
          im.src = u;
        })
        .catch(function (er) {
          if (/密码/.test(er.message) && !_zipPwd) {
            img.innerHTML = '<div class="empty">' + esc(er.message) +
              ' <a href="javascript:void(0)" style="color:var(--primary)">🔑 输入密码</a></div>';
            img.querySelector("a").addEventListener("click", function () {
              askZipPwd(function () { zipEntryInfo(e); });
            });
          } else {
            img.innerHTML = '<div class="empty">图片预览失败</div>';
          }
        });
    }
    if (isTxt) {
      var pre = card.querySelector(".zp-ftext");
      if (e.size > 2 * 1024 * 1024) {
        pre.textContent = "文件过大（超过 2MB），请下载后查看";
      } else {
        fetchTimeout(previewUrl, 15000)
          .then(function (r) { return r.json(); })
          .then(function (d) {
            if (d.error) {
              if (/密码/.test(d.error) && !_zipPwd) {
                pre.textContent = d.error + "（点击输入密码）";
                pre.style.cursor = "pointer";
                pre.onclick = function () { askZipPwd(function () { zipEntryInfo(e); }); };
                return;
              }
              pre.textContent = d.error; return;
            }
            var bin = atob(d.content);
            var bytes = new Uint8Array(bin.length);
            for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            pre.textContent = new TextDecoder("utf-8").decode(bytes);
          })
          .catch(function (er) {
            pre.textContent = (er && er.name === "AbortError") ? "加载超时" : "预览失败";
          });
      }
    }
  }
  document.getElementById("zpClose").addEventListener("click", function () {
    if (_zipOuter) { backToOuterZip(); return; }               // 嵌套查看中 → 先退回外层包
    closeZipViewer();
  });
  document.getElementById("zpBack").addEventListener("click", function () {
    if (_zipView === "img") { loadZipDir(_zipDir); return; }   // 从图片视图返回列表
    if (_zipDir) {                                             // 子目录 → 上一级
      var parts = _zipDir.split("/");
      parts.pop();
      loadZipDir(parts.join("/"));
      return;
    }
    if (_zipOuter) {                                           // 嵌套包根目录 → 返回外层包刚才的目录
      backToOuterZip();
      return;
    }
    closeZipViewer();                                          // 根目录 → 关闭
  });
  document.getElementById("zpExtract").addEventListener("click", function () {
    if (_zipOuter) {                                           // 嵌套包 → 解压到外层包所在目录
      var outerAbs = _zipOuter, entry = _zipNestedEntry, name = _zipName;
      closeZipViewer();
      nestedUnzip(outerAbs, entry, name);
      return;
    }
    if (!_zipAbs) return;
    closeZipViewer();
    doUnzip({ name: _zipName, abs_path: _zipAbs });            // 解压到 zip 所在目录
  });

  // ---------- 预览 ----------
  // 缩略图懒加载：底部横向列表可能有上百张，逐个创建 <img> 并设 src 会一次性并发
  // 几十上百个请求（横向滚动容器里 loading="lazy" 基本不生效）。
  // 这里改为先只记 URL，元素进入可视区附近才真正加载。
  var _pvThumbObserver = null;
  function observePvThumb(el) {
    var url = el.dataset && el.dataset.src;
    if (!url) return;
    if (typeof IntersectionObserver === "undefined") {   // 老浏览器：直接加载
      el.src = url;
      return;
    }
    if (!_pvThumbObserver) {
      _pvThumbObserver = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          if (!en.isIntersecting) return;
          var img = en.target;
          if (!img.getAttribute("src") && img.dataset.src) img.src = img.dataset.src;
          _pvThumbObserver.unobserve(img);
        });
      }, { rootMargin: "160px 0px" });                   // 左右各预载 160px
    }
    _pvThumbObserver.observe(el);
  }

  function openPreview(item, contextItems) {
    // 上一次预览留下的缩略图观察器先清掉（底部列表马上会重建）
    if (_pvThumbObserver) { _pvThumbObserver.disconnect(); _pvThumbObserver = null; }
    var ext = extOf(item.name);
    var abs = itemAbs(item);
    // 音频走独立播放器，不占用预览遮罩（避免遮罩停留在“加载中…”）
    if (AUDIO_EXT.indexOf(ext) >= 0) {
      openAudioPlayer(item, contextItems);
      return;
    }
    // 视频直接进新版播放器：不占用预览遮罩，也不再出现中间卡片
    if (VIDEO_EXT.indexOf(ext) >= 0) {
      vpOpenVideo(item, abs, contextItems);
      return;
    }
    var mask = document.getElementById("previewMask");
    var body = document.getElementById("previewBody");
    body.innerHTML = '<div class="preview-msg">加载中…</div>';
    document.getElementById("previewClose").style.display = "";
    mask.classList.add("show");

    if (MOBILE_IMG_EXT.indexOf(ext) >= 0) {
      buildImagePreview(item, abs);
      return;
    }
    if (TEXT_EXT.indexOf(ext) >= 0) {
      fetchTimeout("/api/preview?path=" + encodeURIComponent(abs), 15000)
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (d.error) { body.innerHTML = '<div class="preview-msg">' + esc(d.error) + '</div>'; return; }
          var bin = atob(d.content);
          var bytes = new Uint8Array(bin.length);
          for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          var text = new TextDecoder("utf-8").decode(bytes);
          buildTextPreview(item, text);
        })
        .catch(function (e) {
          var msg = (e && e.name === "AbortError") ? "加载超时" : (e.message || e);
          body.innerHTML = '<div class="preview-msg">预览失败: ' + esc(msg) + '</div>';
        });
      return;
    }
    // 压缩包：直接打开压缩包查看器（浏览/解压/下载包内文件）
    if (ext === "zip" || ext === "rar") {
      mask.classList.remove("show");
      body.innerHTML = "";
      openZipViewer(item);
      return;
    }
    body.innerHTML = '<div class="preview-msg">暂不支持预览该类型<br/>（移动版仅支持 图片 / 视频 / 文本 / 压缩包）</div>';
  }
  // ---------- 视频：直接进新版播放器（不再有中间预览卡片） ----------
  var VP_MIN_SIZE = 5 * 1024 * 1024;   // 小于 5MB 的小视频不进播放队列（当前播放项除外）

  // 播放队列：外部上下文（媒体集合 / 搜索结果）> 当前目录 > 同级目录
  function vpBuildQueue(list, dirAbs, curAbs, curName) {
    var out = [], hasCur = false;
    (list || []).forEach(function (it) {
      if (isDir(it) || VIDEO_EXT.indexOf(extOf(it.name)) < 0) return;
      var abs = it.abs_path || joinPath(dirAbs, it.name);
      if (abs === curAbs) {
        hasCur = true;                       // 当前项一定保留（再小也留着）
      } else if (it.size != null && it.size < VP_MIN_SIZE) {
        return;
      }
      out.push({ name: it.name, abs: abs });
    });
    if (!hasCur) out.unshift({ name: curName, abs: curAbs });
    return out;
  }

  function vpQueueIndex(queue, abs) {
    for (var i = 0; i < queue.length; i++) {
      if (queue[i].abs === abs) return i;
    }
    return 0;
  }

  function vpOpenVideo(item, abs, contextItems) {
    var dirAbs = abs.slice(0, abs.lastIndexOf("/")) || "/";
    var ctx = (contextItems || []).filter(function (it) {
      return !isDir(it) && VIDEO_EXT.indexOf(extOf(it.name)) >= 0;
    });
    if (ctx.length > 1) {
      var q1 = vpBuildQueue(ctx, dirAbs, abs, item.name);
      openVPlayer(q1, vpQueueIndex(q1, abs));
      return;
    }
    if (normDirPath(dirAbs) === normDirPath(state.path) && state.items && state.items.length) {
      var q2 = vpBuildQueue(state.items, dirAbs, abs, item.name);
      openVPlayer(q2, vpQueueIndex(q2, abs));
      return;
    }
    // 媒体集合里的文件不一定在当前目录：拉同级目录视频作为播放队列
    fetchTimeout("/api/files?path=" + encodeURIComponent(dirAbs) + "&limit=0&offset=0", 10000)
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var q3 = vpBuildQueue(d.items || [], dirAbs, abs, item.name);
        openVPlayer(q3, vpQueueIndex(q3, abs));
      })
      .catch(function () {
        openVPlayer([{ name: item.name, abs: abs }], 0);   // 拉取失败：至少能播当前这个
      });
  }

  // 图片预览卡片：文件名 + 可缩放看图区（双指捏合/双击/滚轮）+ 同级图片列表
  function buildImagePreview(item, abs) {
    var body = document.getElementById("previewBody");
    var card = document.createElement("div");
    card.className = "pv-card";
    card.innerHTML =
      '<div class="pv-head">' +
        '<span class="pv-title">' + esc(item.name) + '</span>' +
        '<button type="button" class="pv-close" data-op="close">✕</button>' +
      '</div>' +
      '<div class="pv-imgarea"><img class="pv-img" draggable="false" alt="' + esc(item.name) + '"></div>' +
      '<div class="pv-vlist"><div class="pv-vload">加载图片…</div></div>';
    body.innerHTML = "";
    body.appendChild(card);
    document.getElementById("previewClose").style.display = "none";

    var title = card.querySelector(".pv-title");
    var img = card.querySelector("img");
    var area = card.querySelector(".pv-imgarea");
    var listEl = card.querySelector(".pv-vlist");
    var dirAbs = abs.slice(0, abs.lastIndexOf("/")) || "/";

    // ===== 缩放 / 拖动（transform: translate + scale，1x~8x），未放大时横滑切图 =====
    var scale = 1, tx = 0, ty = 0, MIN_S = 1, MAX_S = 8, imgToken = 0;
    var imgList = [];      // 同级图片顺序表 [{path, name}]，供左右滑动切换
    var curPath = "";
    function apply(anim) {
      img.classList.toggle("anim", !!anim);
      img.style.transform = "translate(" + tx + "px," + ty + "px) scale(" + scale + ")";
    }
    // 把平移量夹在合法范围内：放大后不能拖出边界，未占满时保持居中
    function clampT() {
      var aw = area.clientWidth, ah = area.clientHeight;
      var iw = img.clientWidth * scale, ih = img.clientHeight * scale;
      var ox = (aw - img.clientWidth) / 2, oy = (ah - img.clientHeight) / 2;
      if (iw <= aw) tx = (aw - iw) / 2 - ox;
      else tx = Math.max(aw - iw - ox, Math.min(-ox, tx));
      if (ih <= ah) ty = (ah - ih) / 2 - oy;
      else ty = Math.max(ah - ih - oy, Math.min(-oy, ty));
    }
    function resetZoom() {
      scale = 1; tx = 0; ty = 0; apply(true);
    }
    // 围绕某点缩放到 s（保持该点下的图像位置不动）
    function zoomAt(mx, my, s, anim) {
      var k = s / scale;
      tx = mx - (mx - tx) * k;
      ty = my - (my - ty) * k;
      scale = s;
      clampT(); apply(anim);
    }
    function dblTap(cx, cy) {
      var rect = area.getBoundingClientRect();
      if (scale > 1.02) resetZoom();
      else zoomAt(cx - rect.left, cy - rect.top, 2.5, true);
    }

    var pinch = null, pan = null, lastTap = 0, lastTapX = 0, lastTapY = 0;
    function tdist(t) {
      var dx = t[0].clientX - t[1].clientX, dy = t[0].clientY - t[1].clientY;
      return Math.sqrt(dx * dx + dy * dy) || 1;
    }
    area.addEventListener("touchstart", function (e) {
      if (e.touches.length === 2) {
        var rect = area.getBoundingClientRect(), t = e.touches;
        pinch = {
          d0: tdist(t), s0: scale, tx0: tx, ty0: ty,
          mx: (t[0].clientX + t[1].clientX) / 2 - rect.left,
          my: (t[0].clientY + t[1].clientY) / 2 - rect.top,
        };
        pan = null;
      } else if (e.touches.length === 1) {
        pinch = null;
        var now = Date.now();
        // 双击：300ms 内二次点按
        if (now - lastTap < 300 &&
            Math.abs(e.touches[0].clientX - lastTapX) < 40 &&
            Math.abs(e.touches[0].clientY - lastTapY) < 40) {
          lastTap = 0;
          dblTap(e.touches[0].clientX, e.touches[0].clientY);
          pan = null;
          return;
        }
        lastTap = now; lastTapX = e.touches[0].clientX; lastTapY = e.touches[0].clientY;
        pan = { x: e.touches[0].clientX, y: e.touches[0].clientY, tx: tx, ty: ty, t0: Date.now() };
      }
    }, { passive: false });
    area.addEventListener("touchmove", function (e) {
      e.preventDefault();   // 阻止页面滚动/浏览器默认缩放
      if (pinch && e.touches.length === 2) {
        var rect = area.getBoundingClientRect();
        var s = Math.min(MAX_S, Math.max(MIN_S, pinch.s0 * tdist(e.touches) / pinch.d0));
        var mx = (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left;
        var my = (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top;
        var k = s / pinch.s0;
        tx = mx - (mx - pinch.tx0) * k;
        ty = my - (my - pinch.ty0) * k;
        scale = s;
        clampT(); apply(false);
      } else if (pan && e.touches.length === 1) {
        var dx = e.touches[0].clientX - pan.x;
        if (scale > 1.02) {
          tx = pan.tx + dx;
          ty = pan.ty + (e.touches[0].clientY - pan.y);
          clampT(); apply(false);
        } else {
          // 未放大：横向跟手滑动，松手按距离/速度切上一张或下一张
          tx = pan.tx + dx; ty = 0;
          apply(false);
        }
      }
    }, { passive: false });
    area.addEventListener("touchend", function (e) {
      if (e.touches.length < 2) pinch = null;
      if (e.touches.length === 0) {
        if (scale > 1.02) {
          clampT(); apply(true);
        } else {
          var dx = tx;
          var fast = pan && (Date.now() - pan.t0) < 250 && Math.abs(dx) > 40;
          if (Math.abs(dx) > area.clientWidth * 0.25 || fast) {
            if (!step(dx < 0 ? 1 : -1)) resetZoom();
          } else {
            resetZoom();
          }
        }
        pan = null;
      }
    });
    area.addEventListener("touchcancel", function () {
      pinch = null; pan = null;
      if (scale <= 1.02) resetZoom(); else { clampT(); apply(true); }
    });
    // 桌面端：滚轮缩放
    area.addEventListener("wheel", function (e) {
      e.preventDefault();
      var rect = area.getBoundingClientRect();
      var s = Math.min(MAX_S, Math.max(MIN_S, scale * (e.deltaY < 0 ? 1.2 : 1 / 1.2)));
      zoomAt(e.clientX - rect.left, e.clientY - rect.top, s, false);
      if (scale <= 1.001) resetZoom();
    }, { passive: false });

    // 同步底部列表高亮并滚动到可视位置
    function markCur(path) {
      Array.prototype.forEach.call(listEl.children, function (n) {
        if (n.classList && n.classList.contains("pv-vitem")) {
          n.classList.toggle("cur", n.getAttribute("data-path") === path);
        }
      });
      var cur = listEl.querySelector(".pv-vitem.cur");
      if (cur) try { cur.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" }); } catch (e) {}
    }
    // 左右切换：dir=1 下一张，-1 上一张；返回 false 表示已到头
    function step(dir) {
      var idx = -1, i;
      for (i = 0; i < imgList.length; i++) {
        if (imgList[i].path === curPath) { idx = i; break; }
      }
      if (idx < 0) return false;
      var n = idx + dir;
      if (n < 0 || n >= imgList.length) return false;
      var it = imgList[n];
      // 当前图滑出，新图从对侧滑入
      tx = -dir * area.clientWidth; ty = 0; apply(true);
      setTimeout(function () {
        setImg(it.path, it.name);                       // 换图并复位（带动画从当前位移回 0）
        tx = dir * area.clientWidth; ty = 0; apply(false);   // 瞬移到进入侧
        requestAnimationFrame(function () {
          requestAnimationFrame(function () { resetZoom(); });  // 滑入
        });
      }, 180);
      return true;
    }

    // ===== 图片加载：img 只加载 /api/image 的清晰预览图（服务端按最长边 2560px 降采样） =====
    // 缩略图（/api/thumbnail，最长边 512px）只作为加载期间的背景占位。
    // 原来是把缩略图直接设进 img、等原图就绪再替换，一旦原图加载慢或解码失败，
    // 预览里就一直停在压缩封面上，看着像"最终结果"。
    function setImg(path, name) {
      var tk = ++imgToken;
      curPath = path;
      title.textContent = name;
      markCur(path);
      area.style.backgroundImage = 'url("/api/thumbnail?path=' + encodeURIComponent(path) + '")';
      area.style.backgroundSize = "contain";
      area.style.backgroundPosition = "center";
      area.style.backgroundRepeat = "no-repeat";
      img.style.transition = "opacity .2s ease";
      img.style.opacity = "0";             // 原图就绪前先露出背景缩略图
      img.onload = function () {
        if (tk !== imgToken) return;
        img.style.opacity = "1";           // 原图到位 → 淡入覆盖占位
        resetZoom();                       // 尺寸就绪后重算缩放边界
      };
      img.onerror = function () {
        if (tk !== imgToken) return;
        // 用 HEAD 探出具体原因：401=会话过期（会表现为"只有缩略图、很模糊"）
        fetch(img.src, { method: "HEAD", credentials: "same-origin" }).then(function (r) {
          if (tk !== imgToken) return;
          if (r.status === 401) {
            toast("登录已过期，请重新登录后再预览", "error");
            return;
          }
          // 非 401：尝试回退原图直出（/api/raw），避免只能看模糊缩略图
          var rawTk = tk;
          img.onerror = function () {
            if (rawTk !== imgToken) return;
            toast("图片加载失败（当前显示的是缩略图）", "error");
          };
          img.src = "/api/raw?path=" + encodeURIComponent(path) + "&_=" + Date.now();
        }).catch(function () {
          if (tk !== imgToken) return;
          // 网络异常时也回退原图
          var rawTk = tk;
          img.onerror = function () {
            if (rawTk !== imgToken) return;
            toast("图片加载失败（当前显示的是缩略图）", "error");
          };
          img.src = "/api/raw?path=" + encodeURIComponent(path) + "&_=" + Date.now();
        });
      };
      resetZoom();
      // 清晰预览图：服务端按最长边 2560px 降采样（原图几十 MB 时也能秒开、不糊）
      img.src = "/api/image?path=" + encodeURIComponent(path);
    }

    function renderImgs(items) {
      var imgs = (items || []).filter(function (it) {
        return !isDir(it) && MOBILE_IMG_EXT.indexOf(extOf(it.name)) >= 0;
      });
      imgList = imgs.map(function (it) {
        return { path: it.abs_path || joinPath(dirAbs, it.name), name: it.name };
      });
      if (!imgs.length) {
        listEl.innerHTML = '<div class="pv-vempty">当前文件夹没有其他图片</div>';
        return;
      }
      listEl.innerHTML = "";
      if (_pvThumbObserver) {          // 列表重建：先丢弃旧观察目标，避免残留
        _pvThumbObserver.disconnect();
        _pvThumbObserver = null;
      }
      imgList.forEach(function (it) {
        var row = document.createElement("div");
        row.className = "pv-vitem img" + (it.path === curPath ? " cur" : "");
        row.setAttribute("data-path", it.path);
        var t = document.createElement("img");
        t.loading = "lazy";
        t.alt = "";
        t.dataset.src = "/api/thumbnail?path=" + encodeURIComponent(it.path);   // 进入可视区才加载
        t.onerror = function () { t.style.display = "none"; row.classList.add("noimg"); };
        var nm = document.createElement("span");
        nm.className = "pv-vname"; nm.textContent = it.name; nm.title = it.name;
        row.appendChild(t); row.appendChild(nm);
        row.addEventListener("click", function () { setImg(it.path, it.name); });
        listEl.appendChild(row);
        observePvThumb(t);
      });
      markCur(curPath);
    }

    setImg(abs, item.name);

    if (normDirPath(dirAbs) === normDirPath(state.path) && state.items && state.items.length) {
      renderImgs(state.items);
    } else {
      loadSiblingsInto(listEl, dirAbs, renderImgs);
    }

    card.querySelector('[data-op="close"]').addEventListener("click", function () {
      var mask = document.getElementById("previewMask");
      mask.classList.remove("show");
      document.getElementById("previewBody").innerHTML = "";
      document.getElementById("previewClose").style.display = "";
    });
  }
  // 文本预览卡片：文件名 + 操作栏（含搜索）+ 带行号的内容区
  function buildTextPreview(item, text) {
    var body = document.getElementById("previewBody");
    var card = document.createElement("div");
    card.className = "pv-card";
    card.innerHTML =
      '<div class="pv-head">' +
        '<span class="pv-title">' + esc(item.name) + '</span>' +
        '<span class="pv-badge">未修改</span>' +
        '<button type="button" class="pv-close" data-op="close">✕</button>' +
      '</div>' +
      '<div class="pv-meta"></div>' +
      '<div class="pv-ops">' +
        '<button type="button" data-op="copy">📋 复制</button>' +
        '<button type="button" data-op="wrap">↩️ 换行</button>' +
        '<button type="button" data-op="search">🔍 搜索</button>' +
        '<button type="button" data-op="download">⬇️ 下载</button>' +
        '<button type="button" data-op="edit">✏️ 编辑</button>' +
        '<button type="button" class="hide" data-op="save">💾 保存</button>' +
        '<button type="button" class="hide" data-op="cancel">✖️ 取消</button>' +
        '<div class="pv-confirm">' +
          '<div>确认下载该文件？</div>' +
          '<div class="pv-confirm-btns">' +
            '<button type="button" class="yes" data-op="dl-yes">确认下载</button>' +
            '<button type="button" data-op="dl-no">取消</button>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div class="pv-search">' +
        '<input type="text" placeholder="搜索关键字…">' +
        '<span class="pv-scount"></span>' +
        '<button type="button" data-op="prev">▲</button>' +
        '<button type="button" data-op="next">▼</button>' +
        '<button type="button" data-op="sclose">✕</button>' +
      '</div>';
    var pre = document.createElement("pre");
    pre.className = "pv-pre";
    var lines = [], contentSpans = [];
    function renderContent(t) {
      lines = t.replace(/\r\n?/g, "\n").split("\n");
      contentSpans = [];
      pre.innerHTML = "";
      var frag = document.createDocumentFragment();
      for (var i = 0; i < lines.length; i++) {
        var row = document.createElement("span"); row.className = "pv-line";
        var ln = document.createElement("span"); ln.className = "ln"; ln.textContent = i + 1;
        var lc = document.createElement("span"); lc.className = "lc"; lc.textContent = lines[i];
        row.appendChild(ln); row.appendChild(lc);
        frag.appendChild(row); contentSpans.push(lc);
      }
      pre.appendChild(frag);
    }
    renderContent(text);

    // 编辑用文本框（带行号栏）
    var editWrap = document.createElement("div"); editWrap.className = "pv-editwrap";
    var gutter = document.createElement("div"); gutter.className = "pv-gutter";
    var ta = document.createElement("textarea");
    ta.className = "pv-edit"; ta.setAttribute("wrap", "off"); ta.value = text;
    editWrap.appendChild(gutter); editWrap.appendChild(ta);
    editWrap.style.display = "none";
    card.appendChild(editWrap);
    function syncGutter() {
      var n = ta.value.split("\n").length, s = "";
      for (var i = 1; i <= n; i++) s += i + "\n";
      gutter.textContent = s;
      gutter.scrollTop = ta.scrollTop;
    }
    ta.addEventListener("scroll", function () { gutter.scrollTop = ta.scrollTop; });
    ta.addEventListener("input", syncGutter);
    // 修改状态跟踪：内容与原文件不一致时徽标变红
    function updateModified() {
      var changed = ta.value !== text;
      badge.textContent = changed ? "已修改" : "未修改";
      badge.classList.toggle("dirty", changed);
      saveBtn.disabled = !changed;   // 未修改时禁止保存
      updateMeta(ta.value);
    }
    ta.addEventListener("input", updateModified);
    // 文件信息：大小 / 行数 / 字符数
    var meta = card.querySelector(".pv-meta");
    function fmtBytes(n) {
      if (n < 1024) return n + " B";
      if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
      if (n < 1073741824) return (n / 1048576).toFixed(2) + " MB";
      return (n / 1073741824).toFixed(2) + " GB";
    }
    function updateMeta(t) {
      meta.textContent = fmtBytes(new Blob([t]).size) + " · " +
        t.split("\n").length.toLocaleString() + " 行 · " +
        t.length.toLocaleString() + " 字符";
    }
    updateMeta(text);

    card.appendChild(pre);
    body.innerHTML = "";
    body.appendChild(card);
    // 文本预览使用卡片内关闭按钮，隐藏遮罩右上角的关闭圆钮
    document.getElementById("previewClose").style.display = "none";

    // ---- 关键字搜索 / 高亮 ----
    var sbar = card.querySelector(".pv-search");
    var sInput = sbar.querySelector("input");
    var sCount = sbar.querySelector(".pv-scount");
    var hits = [], hitIdx = -1, dirty = [], debounceT = null;
    var editing = false, editHits = [], editHitIdx = -1;

    function escHtml(s) {
      return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    }
    function clearHits() {
      for (var k = 0; k < dirty.length; k++) contentSpans[dirty[k]].textContent = lines[dirty[k]];
      dirty = []; hits = []; hitIdx = -1; sCount.textContent = "";
    }
    function doSearch() {
      if (editing) { doSearchEdit(); return; }
      clearHits();
      var q = sInput.value;
      if (!q) return;
      var lq = q.toLowerCase();
      for (var i = 0; i < lines.length; i++) {
        var ll = lines[i].toLowerCase();
        if (ll.indexOf(lq) < 0) continue;
        var html = "", pos = 0, idx;
        while ((idx = ll.indexOf(lq, pos)) >= 0) {
          html += escHtml(lines[i].slice(pos, idx)) +
                  "<mark class='pv-hit'>" + escHtml(lines[i].slice(idx, idx + q.length)) + "</mark>";
          pos = idx + q.length;
        }
        html += escHtml(lines[i].slice(pos));
        contentSpans[i].innerHTML = html;
        dirty.push(i);
      }
      hits = Array.prototype.slice.call(pre.querySelectorAll("mark.pv-hit"));
      if (hits.length) goHit(0); else sCount.textContent = "无匹配";
    }
    function goHit(n) {
      if (!hits.length) return;
      if (hitIdx >= 0 && hits[hitIdx]) hits[hitIdx].classList.remove("cur");
      hitIdx = (n % hits.length + hits.length) % hits.length;
      var m = hits[hitIdx];
      m.classList.add("cur");
      sCount.textContent = (hitIdx + 1) + "/" + hits.length;
      pre.scrollTop = m.offsetTop - pre.clientHeight / 2;
    }

    // 编辑模式搜索：定位匹配处并选中
    function doSearchEdit() {
      editHits = []; editHitIdx = -1;
      var q = sInput.value;
      if (!q) { sCount.textContent = ""; return; }
      var lv = ta.value.toLowerCase(), lq = q.toLowerCase();
      var idx = lv.indexOf(lq);
      while (idx >= 0) { editHits.push(idx); idx = lv.indexOf(lq, idx + q.length); }
      if (!editHits.length) { sCount.textContent = "无匹配"; return; }
      goEditHit(0);
    }
    function goEditHit(n) {
      if (!editHits.length) return;
      editHitIdx = (n % editHits.length + editHits.length) % editHits.length;
      var start = editHits[editHitIdx], end = start + sInput.value.length;
      ta.focus();
      ta.setSelectionRange(start, end);
      sCount.textContent = (editHitIdx + 1) + "/" + editHits.length;
      var lineNum = (ta.value.slice(0, start).match(/\n/g) || []).length;
      var lineH = parseFloat(getComputedStyle(ta).lineHeight) || 19.5;
      ta.scrollTop = lineNum * lineH - ta.clientHeight / 2;
      gutter.scrollTop = ta.scrollTop;
    }
    function navHit(d) { if (editing) goEditHit(editHitIdx + d); else goHit(hitIdx + d); }

    card.querySelector('[data-op="search"]').addEventListener("click", function () {
      var show = !sbar.classList.contains("show");
      sbar.classList.toggle("show", show);
      this.classList.toggle("on", show);
      if (show) sInput.focus();
      else { sInput.value = ""; clearHits(); editHits = []; editHitIdx = -1; }
    });
    sInput.addEventListener("input", function () {
      clearTimeout(debounceT);
      debounceT = setTimeout(doSearch, 300);
    });
    sInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); navHit(1); }
      else if (e.key === "Escape") { card.querySelector('[data-op="search"]').click(); }
    });
    card.querySelector('[data-op="prev"]').addEventListener("click", function () { navHit(-1); });
    card.querySelector('[data-op="next"]').addEventListener("click", function () { navHit(1); });
    card.querySelector('[data-op="sclose"]').addEventListener("click", function () {
      card.querySelector('[data-op="search"]').click();
    });

    // ---- 换行切换 / 复制 / 下载 ----
    card.querySelector('[data-op="wrap"]').addEventListener("click", function () {
      var wrapOn = pre.style.whiteSpace === "pre-wrap";
      pre.style.whiteSpace = wrapOn ? "pre" : "pre-wrap";
      pre.style.wordBreak = wrapOn ? "normal" : "break-all";
      pre.classList.toggle("wrap", !wrapOn);
      this.classList.toggle("on", !wrapOn);
    });
    card.querySelector('[data-op="copy"]').addEventListener("click", function () {
      var btn = this;
      function ok() { btn.textContent = "✅ 已复制"; setTimeout(function () { btn.textContent = "📋 复制"; }, 1200); }
      function fallbackCopy() {
        var ta = document.createElement("textarea");
        ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
        document.body.appendChild(ta); ta.select();
        try { document.execCommand("copy"); ok(); } catch (e) { toast("复制失败", "error"); }
        document.body.removeChild(ta);
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(ok, fallbackCopy);
      } else fallbackCopy();
    });
    // 下载需二次确认（自定义悬浮框）
    var confirmBox = card.querySelector(".pv-confirm");
    card.querySelector('[data-op="download"]').addEventListener("click", function (e) {
      e.stopPropagation();
      confirmBox.classList.toggle("show");
    });
    card.querySelector('[data-op="dl-yes"]').addEventListener("click", function () {
      confirmBox.classList.remove("show");
      download(item);
    });
    card.querySelector('[data-op="dl-no"]').addEventListener("click", function () {
      confirmBox.classList.remove("show");
    });
    card.addEventListener("click", function (e) {
      if (!(e.target.closest && e.target.closest('[data-op="download"], .pv-confirm'))) {
        confirmBox.classList.remove("show");
      }
    });

    // ---- 编辑 / 保存 ----
    var abs = itemAbs(item);
    var editBtn = card.querySelector('[data-op="edit"]');
    var saveBtn = card.querySelector('[data-op="save"]');
    var cancelBtn = card.querySelector('[data-op="cancel"]');
    var badge = card.querySelector(".pv-badge");
    var viewBtns = ["copy", "wrap", "download"].map(function (op) {
      return card.querySelector('[data-op="' + op + '"]');
    });
    function setEditMode(on) {
      editing = on;
      editWrap.style.display = on ? "" : "none";
      pre.style.display = on ? "none" : "";
      editBtn.classList.toggle("hide", on);
      saveBtn.classList.toggle("hide", !on);
      cancelBtn.classList.toggle("hide", !on);
      // 复制/换行/下载 仅查看状态显示；搜索两种状态都可用
      viewBtns.forEach(function (b) { b.classList.toggle("hide", on); });
      badge.classList.toggle("show", on);
      if (on) {
        confirmBox.classList.remove("show");
        ta.value = text;
        syncGutter();
        badge.textContent = "未修改";
        badge.classList.remove("dirty");
        saveBtn.disabled = true;   // 未修改时不可保存
        clearHits();
        if (sbar.classList.contains("show") && sInput.value) {
          doSearchEdit();
        } else {
          ta.scrollTop = 0; gutter.scrollTop = 0;   // 停在顶部，不跳到末行
        }
        ta.setSelectionRange(0, 0);
      } else {
        editHits = []; editHitIdx = -1;
        // 退出编辑时自动清除搜索状态
        if (sbar.classList.contains("show")) {
          sbar.classList.remove("show");
          card.querySelector('[data-op="search"]').classList.remove("on");
          sInput.value = "";
          clearHits();
        }
      }
    }
    editBtn.addEventListener("click", function () { setEditMode(true); });
    cancelBtn.addEventListener("click", function () { setEditMode(false); });
    saveBtn.addEventListener("click", function () {
      saveBtn.disabled = true; saveBtn.textContent = "保存中…";
      fetch("/api/files/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: abs, content: ta.value })
      }).then(function (r) { return r.json(); }).then(function (d) {
        if (d.error) { toast(d.error, "error"); return; }
        text = ta.value;
        renderContent(text);
        setEditMode(false);
        toast("已保存", "success");
      }).catch(function () { toast("保存失败", "error"); })
        .finally(function () { saveBtn.disabled = false; saveBtn.textContent = "💾 保存"; });
    });

    // 卡片内关闭按钮
    card.querySelector('[data-op="close"]').addEventListener("click", function () {
      var mask = document.getElementById("previewMask");
      mask.classList.remove("show");
      document.getElementById("previewBody").innerHTML = "";
      document.getElementById("previewClose").style.display = "";
    });
  }
  document.getElementById("previewClose").addEventListener("click", function () {
    var mask = document.getElementById("previewMask");
    mask.classList.remove("show");
    document.getElementById("previewBody").innerHTML = "";
  });
  document.getElementById("previewMask").addEventListener("click", function (e) {
    if (e.target === this) {
      this.classList.remove("show");
      document.getElementById("previewBody").innerHTML = "";
    }
  });

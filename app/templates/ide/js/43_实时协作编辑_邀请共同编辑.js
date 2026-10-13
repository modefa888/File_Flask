  /* =====================================================================
   * 43 · 实时协作编辑（邀请共同编辑）· 多文件并行
   *   - 每个被共享的文件各有一条独立 WebSocket 连接（会话），互不影响
   *   - 可在多个标签页同时实时协作：各自同步文本、各自显示远端光标
   *   - 弹窗统一管理「协作中的文件」列表（创建 / 接入 / 载入 / 停止 / 邀请）
   * 依赖闭包内变量：$、esc、toast、copyText、uiConfirm、uiConfirmPop、
   *   active、tabs、findTab、openFile、activate
   * ===================================================================== */
  (function () {
    "use strict";

    const _COLORS = ["#e06c75", "#61afef", "#98c379", "#e5c07b", "#c678dd",
                     "#56b6c2", "#d19a66", "#ff79c6", "#7ee787", "#f78c6c"];
    const _rand = (n) => Math.floor(Math.random() * n);
    const _randColor = () => _COLORS[_rand(_COLORS.length)];
    /* 颜色由昵称确定（与服务端 color_for 同一算法）：同一个人刷新 / 换页面颜色都不变，
       否则「谁改的」记录会随每次刷新的随机色而变。 */
    const _colorFor = (name) => {
      const s = String(name == null ? "" : name).trim();
      if (!s) return _randColor();
      let h = 0;
      for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 1000000007;
      return _COLORS[h % _COLORS.length];
    };
    const _initial = (s) => (s || "?").trim().charAt(0).toUpperCase();
    const _enc = encodeURIComponent;

    // 全局状态：会话按 token 存放（一个共享文件 = 一个会话 = 一条连接）
    const S = {
      sessions: {},     // token -> session
      knownRooms: [],   // 服务端现存房间（含非本机会话），用于列表展示
      overlay: null,
      nameDraft: "",    // 昵称输入草稿（避免弹窗重绘时丢失）
      folded: {},       // 左侧列表按文件夹分组的折叠状态（key -> true=已折叠）
    };

    const _isOpen = (s) => !!(s && s.ws && s.ws.readyState === 1);
    // 连接中(0)或已连接(1)都算「活着」：避免 CONNECTING 阶段被误判为未连接而重复建连
    const _isLive = (s) => !!(s && s.ws && (s.ws.readyState === 0 || s.ws.readyState === 1));
    const _listSessions = () => Object.keys(S.sessions).map((t) => S.sessions[t]);
    const _anyConnected = () => _listSessions().some(_isLive);

    /* ---------------- 服务端现存房间 ---------------- */
    function _refreshRooms() {
      return fetch("/api/collab/rooms").then((r) => r.json())
        .then((d) => { S.knownRooms = (d && d.items) || []; _updateUI(); return S.knownRooms; })
        .catch(() => { _updateUI(); return S.knownRooms; });
    }

    /* ---------------- 顶栏按钮 / 弹窗刷新 ---------------- */
    function _updateTbBtn(on) {
      const btn = $("tbCollab");
      if (!btn) return;
      btn.classList.toggle("on", !!on);
      let dot = btn.querySelector(".c-dot");
      if (on && !dot) { dot = document.createElement("span"); dot.className = "c-dot"; btn.appendChild(dot); }
      else if (!on && dot) dot.remove();
    }

    function _updateUI() {
      _updateTbBtn(_anyConnected() || S.knownRooms.length > 0);
      _markTabs();
      _syncFab();
      if (!S.overlay) return;
      _updateCurFile();
      _updateCurPanel();
      _updateRoomsList();
    }

    /* 编辑器标签上的「协作中」标记：给所有标签重算一次（会话增删/连接变化时调用）。
       凡带此标记的标签，出现在编辑区就自动载入房间权威内容（见 _autoLoadTab）。 */
    function _markTabs() {
      (tabs || []).forEach((t) => {
        if (t.el && typeof window.IDECollabTabMark === "function") window.IDECollabTabMark(t.el, t);
        try { _autoLoadTab(t); } catch (e) {}
      });
    }
    window.IDECollabTabMark = function (el, tab) {
      if (!el || !tab) return;
      el.classList.toggle("tab-collab", !!_sessByPath(tab.path));
    };

    /* 某路径对应的协作会话（一个共享文件一条连接） */
    function _sessByPath(path) {
      if (!path) return null;
      for (const k in S.sessions) {
        const s = S.sessions[k];
        if (s && s.room && s.room.path === path) return s;
      }
      return null;
    }

    /* 「带协作标记的标签」自动载入：编辑器一出现（重开标签、长时间未打开导致绑定失效、
       刷新自动恢复后又被打开）就重新绑定并拉取房间最新文本，不必手动点「载入」。 */
    function _autoLoadTab(tab) {
      if (!tab || !tab.path || !tab.cm) return;
      const s = _sessByPath(tab.path);
      if (!s) return;                        // 没有会话就没标记，不打扰普通文件
      if (s.cm === tab.cm) return;           // 已绑定这个编辑器（也避免 _updateUI 反复触发）
      if (s._autoSkip === tab.cm) return;    // 用户拒绝过：不再自动载入这个编辑器
      if (tab.dirty) {                       // 本地有未保存改动：先确认，别静默覆盖
        s._autoSkip = tab.cm;                // 先记下，避免 _markTabs 反复触发时弹多个
        uiConfirmPop(tab.el || tab.cm.getWrapperElement(), {
          title: "载入协作内容",
          msg: "「" + (tab.name || _baseName(tab.path)) +
               "」有未保存的改动，载入房间里的最新内容会覆盖它们。确定继续？",
          okText: "载入", danger: true,
        }).then((ok) => {
          if (!ok) return;
          s._autoSkip = null;
          _bindAndLoad(s, tab);
        });
        return;
      }
      _bindAndLoad(s, tab);
    }

    /* 绑定到当前编辑器并拉一次权威文本；会话已掉线则先重连（welcome 会带回最新内容） */
    function _bindAndLoad(s, tab) {
      if (!_isLive(s)) {
        try {
          _connectSession(s.token, s.myName, s.myColor, _hostKeys()[s.token], { autoOpen: false });
        } catch (e) {}
        return;
      }
      if (active !== tab) s.wantFocus = false;  // 后台标签自动载入时不抢当前焦点
      _bindCM(s, tab.cm);                    // 指向当前编辑器（重开标签后旧编辑器已失效）
      if (_isOpen(s)) {                      // 拉一次权威文本，补齐未绑定期间错过的远端操作
        s.pending = [];
        try { s.ws.send(JSON.stringify({ type: "resync" })); } catch (e) {}
      }
    }

    /* 每次重绘标签后自动补上「协作中」标记。
       说明：00_preamble.js 属主为 root、当前进程无写权限，不便直接在其内部改 renderTab，
       这里对同一闭包内的 renderTab 做运行时包装（函数声明绑定可被重新赋值），效果一致。 */
    (function _wrapRenderTab() {
      if (typeof renderTab !== "function" || renderTab.__collabWrapped) return;
      const orig = renderTab;
      const wrapped = function (tab) {
        orig(tab);
        try { window.IDECollabTabMark(tab && tab.el, tab); } catch (e) {}
        try { _autoLoadTab(tab); } catch (e) {}    // 带协作标记的文件：标签一出现就自动载入
      };
      wrapped.__collabWrapped = true;
      try { renderTab = wrapped; } catch (e) {}
    })();

    /* ================= 悬浮按钮 +「分享前 / 当前」版本对比 ================= */
    let _fab = null, _diffOverlay = null, _topRight = null;

    /* 编辑区右上角容器：协作图例（谁改过）+ 停止分享 + 版本对比按钮 */
    function _ensureTopRight() {
      if (_topRight) return _topRight;
      _topRight = document.createElement("div");
      _topRight.className = "collab-topright";
      _topRight.innerHTML =
        '<div class="collab-legend" id="collabLegend"></div>' +
        '<button class="collab-fab stop" id="collabShareStop" data-tip-pos="bottom" ' +
          'title="停止分享当前文件：所有协作者断开，邀请链接失效">' +
          '<i class="bi bi-stop-circle"></i><span>停止分享</span></button>';
      document.body.appendChild(_topRight);
      _topRight.querySelector("#collabShareStop").onclick = (e) => _stopShareCurrent(e.currentTarget);
      return _topRight;
    }
    function _ensureFab() {
      _ensureTopRight();
      if (_fab) return _fab;
      _fab = document.createElement("button");
      _fab.id = "collabDiffFab";
      _fab.className = "collab-fab";
      _fab.title = "对比「分享前」与「当前协作编辑后」的代码差异";
      _fab.innerHTML = '<i class="bi bi-file-diff"></i><span>版本对比</span>';
      _fab.onclick = _openDiff;
      _topRight.appendChild(_fab);
      return _fab;
    }

    function _positionTopRight() {
      if (!_topRight) return;
      const area = document.querySelector(".editorarea");
      if (!area) return;
      const r = area.getBoundingClientRect();
      if (!r.width) return;
      _topRight.style.top = Math.round(r.top + 46) + "px";
      _topRight.style.right = Math.round(Math.max(10, window.innerWidth - r.right + 14)) + "px";
    }

    /* 当前活动文件在协作中、且已在编辑区打开时显示右上角的图例与按钮 */
    function _syncFab() {
      const s = _activeSess();
      const cm = s && (s.cm || (active && active.cm));
      const el = _ensureFab();
      const on = !!(s && cm);
      const was = el.classList.contains("on");
      if (on) { if (!was) el.classList.add("on"); }
      else if (was) { el.classList.remove("on"); _closeDiff(); }
      // 「停止分享」与「版本对比」同条件显示：仅当前文件在协作中时出现
      const stop = _topRight && _topRight.querySelector("#collabShareStop");
      if (stop) stop.classList.toggle("on", on);
      _updateLegend();
      _positionTopRight();
    }

    /* 编辑区右上角「停止分享」：停掉当前文件的协作（等同弹窗里的「停止该文件协作」） */
    function _stopShareCurrent(btn) {
      const s = _activeSess();
      if (!s) { toast("当前文件未在协作中", "warn"); return; }
      uiConfirmPop(btn, {
        title: "停止分享",
        msg: "停止分享「" + (s.room.name || _baseName(s.room.path || "")) +
             "」后所有协作者都会断开，且邀请链接失效。确定继续？",
        okText: "停止分享", danger: true,
      }).then((ok) => {
        if (!ok) return;
        _endSession(s.token, { stopRoom: true });
        toast("已停止分享：" + (s.room.name || _baseName(s.room.path || "")), "ok");
      });
    }

    let _diffState = null, _diffKey = null;

    function _closeDiff() {
      if (_diffOverlay) { _diffOverlay.remove(); _diffOverlay = null; }
      if (_diffKey) { document.removeEventListener("keydown", _diffKey, true); _diffKey = null; }
    }

    /* 在差异行之间跳转（dir=±1，首尾循环），并把该行滚动到视野中间 */
    function _diffJump(dir) {
      const st = _diffState;
      if (!st || !st.diffs.length) { toast("两者没有差异", "warn"); return; }
      st.ptr = (st.ptr + dir + st.diffs.length) % st.diffs.length;
      const bodyEl = _diffOverlay && _diffOverlay.querySelector(".collab-diff-body");
      if (!bodyEl) return;
      Array.prototype.forEach.call(bodyEl.querySelectorAll(".cd-cur"), (n) => n.classList.remove("cd-cur"));
      const el = bodyEl.children[st.diffs[st.ptr]];
      if (el) {
        el.classList.add("cd-cur");
        bodyEl.scrollTop = Math.max(0, el.offsetTop - bodyEl.clientHeight / 2 + el.offsetHeight / 2);
      }
      const lbl = _diffOverlay.querySelector("#cdPos");
      if (lbl) lbl.textContent = (st.ptr + 1) + " / " + st.diffs.length;
    }

    function _openDiff() {
      const s = _activeSess();
      if (!s) { toast("当前文件未在协作中", "warn"); return; }
      const cm = s.cm || (active && active.cm);
      const curText = cm ? cm.getValue() : "";
      const name = (s.room && s.room.name) || ((active && active.name) || "");
      fetch("/api/collab/" + _enc(s.token) + "/baseline")
        .then((r) => {
          if (!r.ok) throw new Error("接口返回 " + r.status + (r.status === 404 ? "（服务可能未重启）" : ""));
          return r.json();
        })
        .then((d) => {
          if (d && d.hasBaseline === false) {
            _renderDiffNotice(name, curText,
              "该房间创建于「版本对比」功能之前，没有『分享前』的快照。停止协作并重新创建房间后即可对比。");
            return;
          }
          _renderDiff(name, (d && d.text) || "", curText, _extOf(name), s);
        })
        .catch((e) => _renderDiffNotice(name, curText,
          "无法获取「分享前」的版本：" + ((e && e.message) || e) +
          "。若刚更新过代码，请先重启 Flask 服务再重试。"));
    }

    /* 拿不到基线时的提示弹层（不再静默当成空基线导致「右边全绿」的误导） */
    function _renderDiffNotice(name, curText, msg) {
      _closeDiff();
      _diffState = null;
      const ov = document.createElement("div");
      ov.className = "collab-diff-overlay";
      ov.innerHTML =
        '<div class="collab-diff-modal cd-auto">' +
          '<div class="collab-head"><i class="bi bi-file-diff"></i> 版本对比 · ' + esc(name) +
            '<span class="cd-nav"><button id="cdCopy2" data-tip-pos="top" title="复制「当前（协作编辑后）」的全部内容">复制当前版本</button></span>' +
            '<button class="c-close" id="cdClose" data-tip-pos="top" title="关闭 (Esc)">×</button></div>' +
          '<div class="cd-notice">' + esc(msg) + '</div>' +
        '</div>';
      document.body.appendChild(ov);
      _diffOverlay = ov;
      _diffKey = (ev) => { if (ev.key === "Escape") { ev.stopPropagation(); _closeDiff(); } };
      document.addEventListener("keydown", _diffKey, true);
      ov.addEventListener("mousedown", (e) => { if (e.target === ov) _closeDiff(); });
      ov.querySelector("#cdClose").onclick = _closeDiff;
      ov.querySelector("#cdCopy2").onclick = () => {
        copyText(String(curText == null ? "" : curText));
        toast("已复制当前版本内容", "ok");
      };
    }

    /* 行级 LCS 差异 → 对齐后的行对 [{l, r, ln, rn, type}] */
    function _diffRows(A, B) {
      const n = A.length, m = B.length, rows = [];
      if (n * m > 3000000) {                 // 文件过大：跳过逐行对齐，按位置并列展示
        const max = Math.max(n, m);
        for (let k = 0; k < max; k++) {
          rows.push({
            l: k < n ? A[k] : null, r: k < m ? B[k] : null,
            ln: k < n ? k + 1 : null, rn: k < m ? k + 1 : null,
            type: k < n && k < m ? "same" : (k < n ? "del" : "add"),
          });
        }
        return { rows: rows, capped: true };
      }
      const W = m + 1;
      const dp = new Int32Array((n + 1) * W);
      for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
          dp[i * W + j] = A[i] === B[j]
            ? dp[(i + 1) * W + (j + 1)] + 1
            : Math.max(dp[(i + 1) * W + j], dp[i * W + (j + 1)]);
        }
      }
      let i = 0, j = 0;
      while (i < n && j < m) {
        if (A[i] === B[j]) { rows.push({ l: A[i], r: B[j], ln: i + 1, rn: j + 1, type: "same" }); i++; j++; }
        else if (dp[(i + 1) * W + j] >= dp[i * W + (j + 1)]) { rows.push({ l: A[i], r: null, ln: i + 1, rn: null, type: "del" }); i++; }
        else { rows.push({ l: null, r: B[j], ln: null, rn: j + 1, type: "add" }); j++; }
      }
      while (i < n) { rows.push({ l: A[i], r: null, ln: i + 1, rn: null, type: "del" }); i++; }
      while (j < m) { rows.push({ l: null, r: B[j], ln: null, rn: j + 1, type: "add" }); j++; }
      return { rows: rows, capped: false };
    }

    /* ---- 语法着色：复用 CodeMirror 的 tokenizer（无需 runMode addon） ----
       用一个隐藏的 CodeMirror 实例按 mode 分词，逐行取 getLineTokens(precise)，
       拼成 <span class="cm-xxx"> 交给 CSS 上色（深/浅色分别定义）。 */
    let _tokCM = null;
    function _extOf(n) {
      const s = String(n || "").toLowerCase();
      const i = s.lastIndexOf(".");
      return i >= 0 ? s.slice(i + 1) : "";
    }
    function _tokenizer() {
      if (_tokCM) return _tokCM;
      const host = document.createElement("div");
      host.style.cssText = "position:fixed;left:-9999px;top:0;width:800px;height:200px;visibility:hidden;pointer-events:none;";
      document.body.appendChild(host);
      _tokCM = CodeMirror(host, { value: "", lineNumbers: false });
      return _tokCM;
    }
    function _escTok(s) {
      return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }
    function _highlightLines(lines, mode) {
      const cm = _tokenizer();
      try { cm.setOption("mode", mode); } catch (e) {}
      try { cm.setValue(lines.join("\n")); } catch (e) {}
      const out = [];
      for (let i = 0; i < lines.length; i++) {
        let h = "";
        let toks = [];
        try { toks = cm.getLineTokens(i, true) || []; } catch (e) {}
        for (const t of toks) {
          const cls = t.type ? "cm-" + String(t.type).replace(/\s+/g, " cm-") : "";
          h += cls ? '<span class="' + cls + '">' + _escTok(t.string) + "</span>" : _escTok(t.string);
        }
        out.push(h);
      }
      return out;
    }

    /* 把相邻的「删除块 + 新增块」逐行配对成一行「修改」（左旧右新），
       避免用户只改了一行却看到「一行删除 + 一行新增」两行。 */
    function _pairChg(rows) {
      const out = [];
      let i = 0;
      while (i < rows.length) {
        if (rows[i].type !== "del") { out.push(rows[i]); i++; continue; }
        let j = i;
        while (j < rows.length && rows[j].type === "del") j++;
        let k = j;
        while (k < rows.length && rows[k].type === "add") k++;
        const dels = rows.slice(i, j), adds = rows.slice(j, k);
        if (!adds.length) { Array.prototype.push.apply(out, dels); i = j; continue; }
        const n = Math.min(dels.length, adds.length);
        for (let m = 0; m < n; m++) {
          out.push({ l: dels[m].l, r: adds[m].r, ln: dels[m].ln, rn: adds[m].rn, type: "chg" });
        }
        for (let m = n; m < dels.length; m++) out.push(dels[m]);
        for (let m = n; m < adds.length; m++) out.push(adds[m]);
        i = k;
      }
      return out;
    }

    function _renderDiff(name, baseText, curText, ext, sess) {
      _closeDiff();
      const A = String(baseText == null ? "" : baseText).replace(/\r\n/g, "\n").split("\n");
      const B = String(curText == null ? "" : curText).replace(/\r\n/g, "\n").split("\n");
      const d = _diffRows(A, B);
      const rows = _pairChg(d.rows);        // 相邻的「删除+新增」合并为一行「修改」
      const diffs = [];
      let add = 0, del = 0;
      rows.forEach((x, i) => {
        if (x.type === "add") { add++; diffs.push(i); }
        else if (x.type === "del") { del++; diffs.push(i); }
        else if (x.type === "chg") { add++; del++; diffs.push(i); }
      });
      const MAXR = 6000;
      const moreHtml =
        (rows.length > MAXR ? '<div class="cd-more">内容较多，仅显示前 ' + MAXR + ' 行差异。</div>' : "") +
        (d.capped ? '<div class="cd-more">文件较大，未逐行对齐，仅左右并列展示。</div>' : "");
      // hlA / hlB：逐行的高亮 HTML（传 null 时按纯文本转义）
      const buildBody = (hlA, hlB) => rows.slice(0, MAXR).map((x) => {
        const lt = x.l == null ? "" : (hlA ? hlA[x.ln - 1] : esc(x.l));
        const rt = x.r == null ? "" : (hlB ? hlB[x.rn - 1] : esc(x.r));
        const l = x.l == null ? "" : '<span class="cd-ln">' + x.ln + '</span><span class="cd-tx">' + lt + '</span>';
        const r = x.r == null ? "" : '<span class="cd-ln">' + x.rn + '</span><span class="cd-tx">' + rt + '</span>';
        return '<div class="cd-row ' + x.type + '"><div class="cd-cell l">' + l + '</div><div class="cd-cell r">' + r + '</div></div>';
      }).join("");
      const body = buildBody(null, null);
      const ov = document.createElement("div");
      ov.className = "collab-diff-overlay";
      ov.innerHTML =
        '<div class="collab-diff-modal">' +
          '<div class="collab-head"><i class="bi bi-file-diff"></i> 版本对比 · ' + esc(name) +
            '<span class="cd-sum"><b class="add">+' + add + '</b><b class="del">-' + del + '</b></span>' +
            '<span class="cd-nav">' +
              '<button id="cdPrev" data-tip-pos="top" title="上一处差异 (Shift+F3)">上一处</button>' +
              '<span id="cdPos">—</span>' +
              '<button id="cdNext" data-tip-pos="top" title="下一处差异 (F3)">下一处</button>' +
              '<button id="cdCopy" data-tip-pos="top" title="复制「当前（协作编辑后）」的全部内容">复制当前版本</button>' +
              '<button class="cd-restore" id="cdRestore" data-tip-pos="top" title="用「分享前的版本」覆盖当前内容，并同步给房间内所有人（可用 Ctrl+Z 撤销）">恢复备份版本</button>' +
            '</span>' +
            '<button class="c-close" id="cdClose" data-tip-pos="top" title="关闭 (Esc)">×</button></div>' +
          '<div class="collab-diff-head"><div class="cd-cell l">分享前的版本</div><div class="cd-cell r">当前（协作编辑后）</div></div>' +
          '<div class="collab-diff-body">' + body + moreHtml + '</div>' +
        '</div>';
      document.body.appendChild(ov);
      _diffOverlay = ov;
      _diffState = {
        diffs: diffs, ptr: -1,
        curText: String(curText == null ? "" : curText),
        baseText: String(baseText == null ? "" : baseText),   // 「恢复备份版本」要用
        sess: sess || null,
      };
      ov.addEventListener("mousedown", (e) => { if (e.target === ov) _closeDiff(); });
      ov.querySelector("#cdClose").onclick = _closeDiff;
      ov.querySelector("#cdPrev").onclick = () => _diffJump(-1);
      ov.querySelector("#cdNext").onclick = () => _diffJump(1);
      ov.querySelector("#cdCopy").onclick = () => {
        copyText((_diffState && _diffState.curText) || "");
        toast("已复制当前版本内容", "ok");
      };
      ov.querySelector("#cdRestore").onclick = (e) => _restoreBaseline(e.currentTarget);
      const pos = ov.querySelector("#cdPos");
      if (pos) pos.textContent = diffs.length ? "0 / " + diffs.length : "无差异";
      _diffKey = (ev) => {
        if (ev.key === "Escape") { ev.stopPropagation(); _closeDiff(); }
        else if (ev.key === "F3") { ev.preventDefault(); ev.stopPropagation(); _diffJump(ev.shiftKey ? -1 : 1); }
      };
      document.addEventListener("keydown", _diffKey, true);

      // 模式脚本就绪后，用带语法着色的行重建对比主体（先纯文本秒出，再升级配色）
      if (ext && A.length <= 3000 && B.length <= 3000) {
        ensureMode(ext).then((mode) => {
          if (!mode || !_diffOverlay) return;
          const bodyEl = _diffOverlay.querySelector(".collab-diff-body");
          if (!bodyEl) return;
          bodyEl.innerHTML = buildBody(_highlightLines(A, mode), _highlightLines(B, mode)) + moreHtml;
          if (_diffState && _diffState.ptr >= 0) _diffJump(0);   // 保留当前跳转命中的高亮
        }).catch(() => {});
      }
    }

    /* 「恢复备份版本」：用「分享前（= 已备份）版本」覆盖当前协作内容。

       走的是普通本地修改路径（cm.setValue），所以它会作为一次整文替换的操作同步给
       房间内所有人，大家收敛到同一版本；不直接写盘——恢复后按 Ctrl+S 保存即生效
       （保存时还会把共享前版本再备份一份）。Ctrl+Z 可撤销。 */
    function _restoreBaseline(btn) {
      const st = _diffState;
      if (!st || typeof st.baseText !== "string") { toast("没有可恢复的备份版本", "warn"); return; }
      uiConfirmPop(btn, {
        title: "恢复备份版本",
        msg: "将用「分享前的版本」覆盖当前协作内容，并同步给房间内所有人；恢复后可按 Ctrl+S 保存到文件（Ctrl+Z 可撤销）。确定继续？",
        okText: "恢复", danger: true,
      }).then((ok) => {
        if (!ok) return;
        const s = st.sess || _activeSess();
        const cm = (s && s.cm) || (active && active.cm);
        if (!cm) { toast("找不到对应编辑器", "warn"); return; }
        _closeDiff();
        cm.setValue(st.baseText);      // 触发本地修改 → 自动作为一次操作同步给所有人
        toast("已恢复「分享前版本」；按 Ctrl+S 保存到文件（Ctrl+Z 可撤销）", "ok");
      });
    }

    /* ---------------- 入口：打开协作弹层 ---------------- */
    function openCollab() {
      // 无活动文件也允许打开：方便查看/管理正在分享的房间
      _refreshRooms().then(() => _render());
    }

    function _render() {
      if (S.overlay) { S.overlay.remove(); S.overlay = null; }
      const ov = document.createElement("div");
      ov.className = "collab-overlay";
      ov.innerHTML =
        '<div class="collab-modal">' +
          '<div class="collab-head"><i class="bi bi-people-fill"></i> 邀请协作编辑' +
            '<button class="c-close" id="cClose" title="关闭">×</button></div>' +
          '<div class="collab-body" id="cBody"></div>' +
        '</div>';
      document.body.appendChild(ov);
      S.overlay = ov;
      ov.addEventListener("mousedown", (e) => { if (e.target === ov) _closeModal(); });
      ov.querySelector("#cClose").onclick = _closeModal;
      _renderBody();
    }

    function _closeModal() {
      if (S.overlay) { S.overlay.remove(); S.overlay = null; }
    }

    function _renderBody() {
      if (!S.overlay) return;
      const b = S.overlay.querySelector("#cBody");
      if (!b) return;
      _defaultName();
      b.innerHTML =
        /* 左右两栏：左侧=其它协作中的文件；右侧=昵称/当前文件/加入 */
        '<div class="collab-cols">' +
          '<div class="collab-left" id="cRooms"></div>' +
          '<div class="collab-right">' +
            '<div class="collab-row"><label>昵称</label>' +
              '<input class="collab-input" id="cName" placeholder="协作中显示的名字" value="' + esc(S.nameDraft) + '"></div>' +
            '<div id="cCurPanel"></div>' +
            '<div class="collab-file" id="cCurFile"></div>' +
            '<div class="collab-limits">' +
              '<div class="lt-hd"><i class="bi bi-sliders"></i> 共享限制（均可留空/不限）</div>' +
              '<div class="collab-row"><label>指定用户</label>' +
                '<input class="collab-input" id="cLimitUsers" placeholder="仅这些用户名可加入，逗号分隔，留空不限"></div>' +
              '<div class="collab-row"><label>人数上限</label>' +
                '<input class="collab-input" id="cLimitPeers" type="number" min="1" max="99" placeholder="不限"></div>' +
              '<div class="collab-row"><label>有效时间</label>' +
                '<select class="collab-input" id="cLimitTtl">' +
                  '<option value="0">永久有效</option>' +
                  '<option value="1800">30 分钟</option>' +
                  '<option value="3600">1 小时</option>' +
                  '<option value="21600">6 小时</option>' +
                  '<option value="86400">24 小时</option>' +
                  '<option value="604800">7 天</option>' +
                '</select></div>' +
            '</div>' +
            '<button class="collab-btn" id="cCreate">共享当前文件并邀请</button>' +
            '<div style="border-top:1px solid #333;margin:2px 0"></div>' +
            '<div class="collab-row"><label>加入</label>' +
              '<input class="collab-input" id="cJoin" placeholder="粘贴邀请链接或令牌">' +
              '<button class="collab-btn ghost" id="cJoinBtn">加入</button></div>' +
          '</div>' +
        '</div>';

      const nameEl = b.querySelector("#cName");
      nameEl.addEventListener("input", () => { S.nameDraft = nameEl.value; });
      b.querySelector("#cCreate").onclick = () => {
        _createAndConnect((nameEl.value || "").trim() || S.nameDraft);
      };
      b.querySelector("#cJoinBtn").onclick = () => {
        const tok = _extractToken((b.querySelector("#cJoin").value || "").trim());
        if (!tok) { toast("无法识别邀请链接/令牌", "warn"); return; }
        const nm = (nameEl.value || "").trim() || _defaultName();
        _connectSession(tok, nm, _randColor(), _hostKeys()[tok], { focus: true });
      };
      _updateUI();
    }

    /* 统一昵称：所有会话（含自动恢复）共用同一个显示名。
       优先用登录用户名（数据库 users 表，页面注入 window.__collabUser）——固定不变；
       随机名会让每次刷新都变成新身份，「谁改的」记录也跟着乱。未登录时才兜底随机。 */
    function _defaultName() {
      if (!S.nameDraft) {
        const u = String(window.__collabUser || "").trim();
        S.nameDraft = u || ("访客" + _rand(9000 + 1000));
      }
      return S.nameDraft;
    }

    /* 当前活动文件对应的「在线会话」（用于详情面板与列表去重） */
    function _activeSess() {
      if (!active || !active.path) return null;
      return _listSessions().find((s) => s.room.path === active.path && _isLive(s)) || null;
    }

    /* 生成一段在线成员标记（列表与详情面板共用） */
    function _peersHtml(s) {
      const list = (s.peers || []).slice();
      if (s.myId && !list.some((p) => p.id === s.myId))
        list.unshift({ id: s.myId, name: s.myName, color: s.myColor, host: false });
      if (!list.length) return '<span class="collab-hint">暂无其他协作者</span>';
      return list.map((p) =>
        '<span class="collab-peer"><span class="dot" style="background:' + esc(p.color || "#888") + '">' +
        esc(_initial(p.name)) + '</span>' + esc(p.name) +
        (p.host ? '<b class="c-host-badge">· 房主</b>' : "") +
        (p.viewer && !p.host ? ' <span class="cr-limits" title="该成员仅查看，不参与编辑"><i class="bi bi-eye"></i> 仅查看</span>' : "") +
        (p.id === s.myId ? "（你）" : "") + '</span>').join("");
    }

    function _updateCurFile() {
      if (!S.overlay) return;
      const shared = !!_activeSess();
      const el = S.overlay.querySelector("#cCurFile");
      if (el) {
        const cur = active && active.path;
        el.innerHTML = '当前文件：<b>' + esc((active && active.name) || "-") + "</b><br>" +
                       (cur ? esc(cur) : "");
      }
      const btn = S.overlay.querySelector("#cCreate");
      if (btn) {
        const ok = !!(active && active.path) && !shared;
        btn.disabled = !ok;
        btn.title = shared ? "该文件已在协作中" : (ok ? "" : "请先打开文件");
      }
    }

    /* 当前文件的协作详情：沿用之前单文件时的展示（链接 / 二维码 / 在线 / 载入 / 停止） */
    function _updateCurPanel() {
      const box = S.overlay && S.overlay.querySelector("#cCurPanel");
      if (!box) return;
      const s = _activeSess();
      if (!s) { box.innerHTML = ""; return; }
      const token = s.token;
      const url = location.origin + "/?collab=" + _enc(token);
      box.innerHTML =
        '<div class="collab-file">协作文件：<b>' + esc(s.room.name || "") + "</b><br>" + esc(s.room.path || "") + "</div>" +
        '<div class="collab-row"><label>邀请链接</label>' +
          '<input class="collab-link" id="cLink" readonly value="' + esc(url) + '">' +
          '<button class="collab-btn ghost" id="cCopy" title="复制"><i class="bi bi-clipboard"></i></button>' +
          '<a class="collab-btn ghost" href="' + esc(url) + '" target="_blank" rel="noopener" title="在新标签打开邀请链接"><i class="bi bi-box-arrow-up-right"></i></a></div>' +
        '<div class="collab-qr-wrap">' +
          '<div class="collab-qr"><img src="/api/collab/' + _enc(token) + '/qr" alt="qr"></div>' +
          '<div class="collab-hint">用手机或同事浏览器扫码 / 打开链接，即可加入实时协作。<br>链接凭随机令牌访问，停止协作后即失效。</div>' +
        '</div>' +
        '<div class="collab-row"><label>在线</label><div class="collab-peers">' + _peersHtml(s) + '</div></div>' +
        '<div class="collab-row"><label>载入</label>' +
          '<button class="collab-btn ghost" id="cReload" title="用服务器最新内容重新载入该文件"><i class="bi bi-arrow-clockwise"></i> 重新载入</button>' +
          '<button class="collab-btn danger" id="cStopCur">停止该文件协作</button></div>';
      box.querySelector("#cCopy").onclick = () => { copyText(url); toast("邀请链接已复制", "ok"); };
      box.querySelector("#cReload").onclick = (e) => {
        uiConfirmPop(e.currentTarget, {
          title: "重新载入",
          msg: "将丢弃本地未同步的修改，用服务器权威内容重新填充该文件。确定继续？",
          okText: "重新载入", danger: false,
        }).then((ok) => { if (ok) { _closeModal(); _reloadFromServer(s); } });
      };
      box.querySelector("#cStopCur").onclick = (e) => {
        uiConfirmPop(e.currentTarget, {
          title: "停止协作",
          msg: "关闭「" + (s.room.name || "") + "」后所有协作者都会断开，且邀请链接失效。",
          okText: "停止", danger: true,
        }).then((ok) => { if (ok) { _endSession(token, { stopRoom: true }); toast("房间已关闭", "ok"); } });
      };
    }

    /* 合并「在线会话」与「服务端已知房间」，按 token 去重（会话信息优先） */
    function _roomRows() {
      const map = new Map();
      S.knownRooms.forEach((r) => {
        if (!r || !r.token) return;
        map.set(r.token, {
          token: r.token, name: r.name, path: r.path, peers: r.peers || 0, sess: null,
          group: r.group || null,
          maxPeers: r.max_peers || null, expiresAt: r.expires_at || null,
          allowedUsers: r.allowed_users || [],
        });
      });
      _listSessions().forEach((s) => {
        const cur = map.get(s.token) || {};
        map.set(s.token, {
          token: s.token,
          name: s.room.name || cur.name || "未命名文件",
          path: s.room.path || cur.path || "",
          peers: _isOpen(s) ? (s.peers || []).length : (cur.peers || 0),
          sess: s,
          group: cur.group || null,     // 批量分享组 id（服务端随房间列表下发）
          maxPeers: cur.maxPeers || null,
          expiresAt: cur.expiresAt || null,
          allowedUsers: cur.allowedUsers || [],
        });
      });
      return Array.from(map.values());
    }

    /* 一组路径的最长公共目录前缀（用作分享组名与组内相对路径显示） */
    function _commonRoot(paths) {
      let root = (paths[0] || "").replace(/\/[^/]*$/, "") || "/";
      let again = true;
      while (again) {
        again = false;
        for (const p of paths) {
          if (p && p !== root && p.indexOf(root + "/") !== 0) {
            root = root.replace(/\/[^/]*$/, "") || "/";
            again = true;
            break;
          }
        }
      }
      return root;
    }

    function _updateRoomsList() {
      const box = S.overlay && S.overlay.querySelector("#cRooms");
      if (!box) return;
      const cur = _activeSess();
      // 当前文件的共享已在上方详情面板展示，这里不再重复列出
      const rows = _roomRows().filter((r) => !cur || r.token !== cur.token);
      if (!rows.length) {
        box.innerHTML = '<div class="collab-hint">' +
          (cur ? "没有其它协作中的文件。切换到别的文件后可再次「共享当前文件并邀请」。"
               : "还没有共享任何文件。打开一个文件后点上方「共享当前文件并邀请」。") + '</div>';
        return;
      }
      /* 顶部先分「批量分享组 / 普通文件」，组内再按目录层级嵌套折叠（二级及更深
         的文件夹各自成可折叠节点）。折叠状态记在 S.folded，重绘时保持不丢。 */
      const groups = new Map(), plain = [];
      rows.forEach((r) => {
        if (r.group) {
          if (!groups.has(r.group)) groups.set(r.group, []);
          groups.get(r.group).push(r);
        } else plain.push(r);
      });
      let html = '<div class="collab-sharing-head"><b><i class="bi bi-broadcast c-share-ic"></i> 其它协作中的文件</b></div>';
      const wired = [];
      groups.forEach((grp, gid) => {
        const base = _commonRoot(grp.map((r) => r.path)) || "/";
        html += _groupFolderHtml(gid, grp, base);
        grp.forEach((r) => wired.push(r));
      });
      if (plain.length) {
        const base = _commonRoot(plain.map((r) => r.path)) || "/";
        html += _treeHtml(_dirTree(plain, base), "");
        plain.forEach((r) => wired.push(r));
      }
      box.innerHTML = html;
      wired.forEach((r) => _wireRoomOps(box, r));
      groups.forEach((grp, gid) => {
        const card = box.querySelector('.collab-folder[data-gid="' + gid + '"]');
        if (card) _wireGroupOps(card, gid, grp);
      });
      // 点组头折叠/展开（组头上的按钮除外）；重绘后 onclick 重新绑，无需解绑
      box.onclick = (e) => {
        const head = e.target.closest && e.target.closest(".cf-head");
        if (!head || e.target.closest("[data-gact]")) return;
        const card = head.closest(".collab-folder");
        if (!card || !card.dataset.fkey) return;
        S.folded[card.dataset.fkey] = !S.folded[card.dataset.fkey];
        card.classList.toggle("folded", !!S.folded[card.dataset.fkey]);
      };
    }

    /* 文件所在目录（用于按文件夹分组） */
    function _dirname(p) {
      const s = String(p || "").replace(/\/+$/, "");
      const i = s.lastIndexOf("/");
      return i > 0 ? s.slice(0, i) : "/";
    }

    /* 有效期剩余的可读文本（列表行内小字展示） */
    function _fmtLeft(ms) {
      const m = Math.floor(ms / 60000);
      if (m < 1) return "不足1分钟";
      if (m < 60) return m + "分钟";
      const h = Math.floor(m / 60);
      if (h < 24) return h + " 小时" + (m % 60 ? " " + (m % 60) + " 分" : "");
      return Math.floor(h / 24) + " 天" + (h % 24 ? " " + (h % 24) + " 小时" : "");
    }
    /* 房间限制摘要：≤N人 · 剩余时间（无限制则返回空串） */
    function _limitBadges(r) {
      const parts = [];
      if (r.maxPeers) parts.push("≤" + r.maxPeers + " 人");
      if (r.allowedUsers && r.allowedUsers.length) parts.push("指定用户");
      if (r.expiresAt) {
        const left = r.expiresAt * 1000 - Date.now();
        parts.push(left <= 0 ? "已过期" : "剩 " + _fmtLeft(left));
      }
      return parts.join(" · ");
    }

    /* 左侧房间卡片（完整信息版）：文件名 + 在线数/状态 + 路径与限制摘要 + 在线成员 */
    function _roomCardHtml(r) {
      const s = r.sess;
      const on = s && _isOpen(s);
      const st = s
        ? '<span class="collab-status">' + (on ? '<span class="on">● 已连接</span>' : '<span class="off">○ 未连接</span>') + '</span>'
        : "";
      const peersHtml = on ? '<div class="collab-peers">' + _peersHtml(s) + '</div>' : "";
      const lim = _limitBadges(r);
      return '<div class="collab-room" data-tok="' + esc(r.token) + '">' +
        '<div class="cr-info"><div class="cr-name"><b>' + esc(r.name) + '</b>' +
          (r.view ? ' <span class="cr-limits" title="二进制等文件不参与共同编辑，协作者只能查看/下载"><i class="bi bi-eye"></i> 仅查看</span>' : "") +
          '<span class="cr-peers">' + (r.peers || 0) + ' 人在线</span>' + st + '</div>' +
          '<div class="cr-path">' + esc(r.path || "") +
            (lim ? ' <span class="cr-limits">· ' + esc(lim) + '</span>' : '') + '</div>' +
          peersHtml + '</div>' +
        '<div class="cr-ops">' +
          '<button class="collab-btn ghost" data-act="link" title="复制邀请链接"><i class="bi bi-clipboard"></i> 链接</button>' +
          '<a class="collab-btn ghost" href="/api/collab/' + _enc(r.token) + '/qr" target="_blank" rel="noopener" title="查看二维码"><i class="bi bi-qr-code"></i> 二维码</a>' +
          (on
            ? '<button class="collab-btn ghost" data-act="reload" title="用服务器最新内容重新载入该文件"><i class="bi bi-arrow-clockwise"></i> 载入</button>'
            : '<button class="collab-btn ghost" data-act="join" title="接入该房间继续同步">接入</button>') +
          '<button class="collab-btn danger" data-act="stop" title="关闭该房间">停止</button>' +
        '</div></div>';
    }

    /* 把若干房间按目录层级组织成树：base 为公共根（会被剥掉），每级子目录一个节点 */
    function _dirTree(rows, base) {
      const root = { name: "", path: base, dirs: new Map(), files: [] };
      rows.forEach((r) => {
        let dir = _dirname(r.path);
        if (base && base !== "/" && dir.indexOf(base) === 0) dir = dir.slice(base.length);
        let node = root;
        dir.split("/").filter(Boolean).forEach((s) => {
          const p = (node.path === "/" ? "" : node.path) + "/" + s;
          if (!node.dirs.has(s)) node.dirs.set(s, { name: s, path: p, dirs: new Map(), files: [] });
          node = node.dirs.get(s);
        });
        node.files.push(r);
      });
      return root;
    }
    function _treeCount(n) { let c = n.files.length; n.dirs.forEach((d) => { c += _treeCount(d); }); return c; }
    function _treePeers(n) {
      let p = n.files.reduce((a, r) => a + (r.peers || 0), 0);
      n.dirs.forEach((d) => { p += _treePeers(d); });
      return p;
    }
    /* 渲染一层：子文件夹在前（各为可折叠节点），其后是本层文件卡片 */
    function _treeHtml(node, keyPrefix) {
      let html = "";
      Array.from(node.dirs.values()).sort((a, b) => a.name.localeCompare(b.name))
        .forEach((d) => { html += _folderSection(d, keyPrefix); });
      node.files.forEach((r) => { html += _roomCardHtml(r); });
      return html;
    }
    /* 文件夹节点（任意层级通用）：组头可折叠，组内继续嵌套子文件夹/文件卡片 */
    function _folderSection(d, keyPrefix) {
      const key = keyPrefix + d.path;
      const folded = !!S.folded[key];
      return '<div class="collab-folder' + (folded ? " folded" : "") + '" data-fkey="' + esc(key) + '">' +
        '<div class="cf-head" title="' + esc(d.path) + '">' +
          '<span class="cf-arrow"><i class="bi bi-chevron-down"></i></span>' +
          '<span class="cf-ic"><i class="bi bi-folder2"></i></span>' +
          '<span class="cf-name">' + esc(d.name) + '</span>' +
          '<span class="cf-meta">' + _treeCount(d) + ' 个文件 · ' + _treePeers(d) + ' 人在线</span>' +
        '</div>' +
        '<div class="cf-body">' + _treeHtml(d, keyPrefix) + '</div>' +
        '</div>';
    }
    /* 批量分享组顶层卡片：组名取公共根目录名，组内再按目录层级嵌套折叠 */
    function _groupFolderHtml(gid, grp, base) {
      const key = "g:" + gid;
      const folded = !!S.folded[key];
      const name = base.split("/").filter(Boolean).pop() || "批量分享";
      const peers = grp.reduce((n, r) => n + (r.peers || 0), 0);
      return '<div class="collab-folder' + (folded ? " folded" : "") + '" data-fkey="' + esc(key) + '" data-gid="' + esc(gid) + '">' +
        '<div class="cf-head" title="' + esc(base) + '">' +
          '<span class="cf-arrow"><i class="bi bi-chevron-down"></i></span>' +
          '<span class="cf-ic"><i class="bi bi-collection"></i></span>' +
          '<span class="cf-name">' + esc(name) + '</span>' +
          '<span class="cf-meta">' + grp.length + ' 个文件 · ' + peers + ' 人在线</span>' +
          '<span class="cf-ops">' +
            '<button class="collab-btn ghost" data-gact="glink" title="复制整组邀请链接（打开后列出组内全部文件）"><i class="bi bi-clipboard"></i> 组链接</button>' +
            '<button class="collab-btn danger" data-gact="gstop" title="停止整组分享">停止全部</button>' +
          '</span>' +
        '</div>' +
        '<div class="cf-body">' + _treeHtml(_dirTree(grp, base), key + "|") + '</div>' +
        '</div>';
    }

    function _wireGroupOps(card, gid, rows) {
      if (!card) return;
      const glink = card.querySelector('[data-gact="glink"]');
      if (glink) glink.onclick = () => {
        copyText(location.origin + "/collab?collab=" + _enc(gid));
        toast("整组邀请链接已复制", "ok");
      };
      const gstop = card.querySelector('[data-gact="gstop"]');
      if (gstop) gstop.onclick = (e) => {
        uiConfirmPop(e.currentTarget, {
          title: "停止整组分享",
          msg: "将停止该组内全部 " + rows.length + " 个文件的协作：所有协作者断开、链接失效。确定继续？",
          okText: "全部停止", danger: true,
        }).then((ok) => {
          if (!ok) return;
          rows.forEach((r) => _endSession(r.token, { stopRoom: true }));
          toast("已停止 " + rows.length + " 个文件的分享", "ok");
        });
      };
    }

    function _wireRoomOps(box, r) {
      const row = Array.prototype.find.call(
        box.querySelectorAll(".collab-room"), (el) => el.dataset.tok === r.token);
      if (!row) return;
      const s = r.sess;
      const url = location.origin + "/?collab=" + _enc(r.token);
      const nameEl = S.overlay && S.overlay.querySelector("#cName");

      const linkBtn = row.querySelector('[data-act="link"]');
      if (linkBtn) linkBtn.onclick = () => { copyText(url); toast("邀请链接已复制", "ok"); };

      const joinBtn = row.querySelector('[data-act="join"]');
      if (joinBtn) joinBtn.onclick = () => {
        const nm = ((nameEl && nameEl.value) || "").trim() || _defaultName();
        _closeModal();
        _openPath(r.path);                 // 立刻打开该文件（不等 welcome 往返）
        _connectSession(r.token, nm, _colorFor(nm), _hostKeys()[r.token], { focus: true });
      };

      const reloadBtn = row.querySelector('[data-act="reload"]');
      if (reloadBtn && s) reloadBtn.onclick = (e) => {
        uiConfirmPop(e.currentTarget, {
          title: "重新载入",
          msg: "将丢弃「" + (r.name || "") + "」本地未同步的修改，用服务器权威内容重新填充。确定继续？",
          okText: "重新载入", danger: false,
        }).then((ok) => { if (ok) { _closeModal(); _reloadFromServer(s, r.path); } });
      };

      const stopBtn = row.querySelector('[data-act="stop"]');
      if (stopBtn) stopBtn.onclick = (e) => {
        uiConfirmPop(e.currentTarget, {
          title: "停止协作",
          msg: "关闭「" + (r.name || "") + "」后所有协作者都会断开，且邀请链接失效。",
          okText: "停止", danger: true,
        }).then((ok) => {
          if (!ok) return;
          if (s) { _endSession(r.token, { stopRoom: true }); toast("房间已关闭", "ok"); }
          else {
            fetch("/api/collab/rooms/" + _enc(r.token), { method: "DELETE" })
              .then((res) => res.json())
              .then(() => { toast("房间已关闭", "ok"); return _refreshRooms(); })
              .catch(() => toast("操作失败", "err"));
          }
        });
      };
    }

    function _extractToken(raw) {
      raw = (raw || "").trim();
      if (!raw) return "";
      if (/^[\w\-]+$/.test(raw)) return raw;             // 纯令牌
      try {                                              // 链接：取 ?collab= 或末段
        const u = new URL(raw);
        const q = u.searchParams.get("collab");
        if (q) return q;
        const seg = u.pathname.split("/").filter(Boolean);
        return seg[seg.length - 1] || "";
      } catch (e) { return ""; }
    }

    /* ---------------- 房主认领密钥（localStorage 持久化） ---------------- */
    function _hostKeys() {
      try { return JSON.parse(localStorage.getItem("collabHostKeys") || "{}"); }
      catch (e) { return {}; }
    }
    function _saveHostKey(token, key) {
      if (!token || !key) return;
      try {
        const m = _hostKeys(); m[token] = key;
        localStorage.setItem("collabHostKeys", JSON.stringify(m));
      } catch (e) {}
    }

    /* ---------------- 创建 / 加入 ---------------- */
    /* 读取右侧「共享限制」输入：指定用户 / 人数上限 / 有效时间（秒），未填=不限 */
    function _readLimits() {
      const q = (id) => S.overlay && S.overlay.querySelector(id);
      const users = ((q("#cLimitUsers") || {}).value || "")
        .split(/[,，;；\s]+/).map((x) => x.trim()).filter(Boolean);
      const mp = parseInt((q("#cLimitPeers") || {}).value, 10);
      const ttl = parseInt((q("#cLimitTtl") || {}).value, 10);
      return {
        allowedUsers: users.length ? users : null,
        maxPeers: mp > 0 ? mp : null,
        expiresIn: ttl > 0 ? ttl : null,
      };
    }

    function _createAndConnect(name) {
      if (!active || !active.path) { toast("请先打开一个文件", "warn"); return; }
      const path = active.path;
      const existing = _listSessions().find((s) => s.room.path === path);
      if (existing) { _openSessionFile(existing); toast("该文件已在协作中", "ok"); return; }
      const nm = (name || "").trim() || _defaultName();
      const limits = _readLimits();
      fetch("/api/collab/rooms", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(Object.assign({ path }, limits)),
      }).then((r) => r.json()).then((d) => {
        if (d.error) { toast(d.error, "err"); return; }
        _saveHostKey(d.token, d.hostKey);
        _connectSession(d.token, nm, _randColor(), d.hostKey, { focus: true });
        _refreshRooms();
      }).catch(() => toast("创建协作会话失败", "err"));
    }

    /* ---------------- 会话（一个共享文件一条连接） ---------------- */
    function _newSession(token, name, color) {
      const s = {
        token, ws: null, room: { token, path: null, name: null },
        myId: null, myName: name, myColor: color,
        localVersion: 0, cm: null, marks: {}, applyingRemote: false,
        cursorTimer: null, pending: [], peers: [], peerInfo: {}, wantFocus: false, reloading: false,
        opSeq: 0,     // 本会话发出的操作自增序号：回显按 id 精确出队
        editedBy: {},                  // 行级归属图例：谁改过当前文件（含「你」）
        tagMarks: [],                  // 改动处的「作者标签」书签（bookmark + widget）
        inkMarks: [],                  // 改动文字的加粗着色标记（字符级）
        // allowOpen=false（刷新自动恢复）：不自动打开文件、不抢标签，等用户自己打开后再绑定
        allowOpen: true, _bindTimer: null,
      };
      s.onChanges = (cm, changes) => _onLocalChanges(s, cm, changes);
      s.onCursor = (cm) => _onCursorActivity(s, cm);
      S.sessions[token] = s;
      return s;
    }

    function _connectSession(token, name, color, hostKey, opts) {
      opts = opts || {};
      let s = S.sessions[token];
      if (s && _isLive(s)) {                 // 已在同步（或连接中）：仅用户主动接入/载入才打开文件
        if (opts.focus) _openSessionFile(s);
        _updateUI();
        return;
      }
      if (!s) s = _newSession(token, name, color);
      s.myName = name || s.myName;
      // 颜色统一由昵称确定：刷新 / 换页面 / 换标签颜色都不变（服务端也是同一算法）
      s.myColor = _colorFor(s.myName);
      s.wantFocus = !!opts.focus;
      s.allowOpen = opts.autoOpen !== false;  // 自动恢复时传 false：不自动打开文件/不抢焦点

      const proto = location.protocol === "https:" ? "wss" : "ws";
      const qs = "token=" + _enc(token) + "&name=" + _enc(s.myName) +
                 "&color=" + _enc(s.myColor) +
                 (hostKey ? "&host=" + _enc(hostKey) : "");
      let ws;
      try { ws = new WebSocket(proto + "://" + location.host + "/ws/collab?" + qs); }
      catch (e) { delete S.sessions[token]; toast("无法建立协作连接", "err"); return; }
      s.ws = ws;
      ws.onopen = () => _updateUI();
      ws.onmessage = (e) => {
        let m; try { m = JSON.parse(e.data); } catch (_) { return; }
        _onMsg(s, m);
      };
      ws.onclose = () => { _updateUI(); };
      // 会话已被 _endSession 摘除（主动停止/退出）时的 error 不再弹错，
      // 只对仍然在册的会话报告真正的连接故障
      ws.onerror = () => { if (S.sessions[token] === s) toast("协作连接出错", "err"); };
      _updateUI();
    }

    function _baseName(p) { return String(p == null ? "" : p).split("/").pop() || p; }

    /* 在编辑区打开或切到某会话对应的文件：标签已在就直接激活，没打开就 openFile。
       注意 openFile(path, name, ...) 内部会调用 getExt(name)，name 不能省，
       否则 getExt(undefined) 抛错、async 静默失败，文件永远打不开。 */
    function _openPath(path) {
      if (!path) return;
      const tab = findTab(path);
      if (tab && tab.cm) { try { activate(tab); } catch (e) {} return; }
      try { openFile(path, _baseName(path)).catch(() => {}); } catch (e) {}
    }

    function _openSessionFile(s) {
      _openPath(s.room && s.room.path);
    }

    function _onMsg(s, m) {
      switch (m.type) {
        case "welcome":
          s.myId = m.yourId;
          s.localVersion = m.version;
          s.pending = [];                       // 重同步后重新记账
          s.room.path = m.path;
          s.room.name = m.name || s.room.name;
          s.peers = m.peers || [];
          s.peerInfo = {};
          _rememberPeers(s, s.peers);
          s.editedBy = {};                     // 图例先清空，随后由 _paintAuthors 按服务端记录重建
          _attachToRoom(s, m.path, m.text, s.wantFocus, s.allowOpen);
          s.wantFocus = false;
          if (s.reloading) { s.reloading = false; toast("已载入最新内容", "ok"); }
          _updateUI();
          break;
        case "op":
          s.localVersion = Math.max(s.localVersion, m.version);
          if (m.by === s.myId) {
            // 自己的回显：按 id 精确出队。不再比对坐标——他人并发操作会让在途队列位置
            // 发生变化，按坐标比对会误判为分叉并触发 resync（正是光标跳回 1:1 的来源）。
            const idx = s.pending.findIndex((p) => p.id != null && p.id === m.id);
            if (idx >= 0) s.pending.splice(idx, 1);
            break;
          }
          _applyRemoteOp(s, m);
          break;
        case "cursor":
          _renderRemoteCursor(s, m);
          break;
        case "presence":
          s.peers = m.peers || [];
          _rememberPeers(s, s.peers);
          _updateUI();
          break;
        case "leave":
          _clearRemoteCursor(s, m.id);
          break;
        case "closed":
          toast(m.message || "房主已退出，协作已结束", "warn");
          _endSession(s.token, { stopRoom: false });
          break;
        case "error":
          toast(m.message || "协作错误", "err");
          _endSession(s.token, { stopRoom: false });
          break;
        default: break;
      }
    }

    /* 绑定编辑器 + 注入权威文本；focus 时把该文件标签切到前台。
       allowOpen=false（刷新自动恢复）：文件没打开时不主动打开，改为等待用户打开后再绑定。 */
    function _attachToRoom(s, path, text, focus, allowOpen) {
      if (!path) return;
      const tab = findTab(path);
      if (tab && tab.cm) { _bindSeed(s, tab, text, focus); return; }
      if (!allowOpen) { _watchBind(s); return; }
      try { openFile(path, s.room.name || _baseName(path)).catch(() => {}); } catch (e) {}
      let tries = 0;
      const t = setInterval(() => {
        tries++;
        const tb = findTab(path);
        if (tb && tb.cm) {
          clearInterval(t);
          if (S.sessions[s.token] === s) _bindSeed(s, tb, text, focus);
        } else if (tries > 30) clearInterval(t);
      }, 80);
    }

    /* 自动恢复场景：不打开文件，静默等待用户把该文件打开（标签出现）后再绑定，
       并请求一次 resync 拉取权威文本，补齐未绑定期间错过的远端操作。 */
    function _watchBind(s) {
      if (s._bindTimer) return;
      let tries = 0;
      s._bindTimer = setInterval(() => {
        tries++;
        if (S.sessions[s.token] !== s || !_isLive(s)) {
          clearInterval(s._bindTimer); s._bindTimer = null; return;
        }
        const tb = (s.room && s.room.path) ? findTab(s.room.path) : null;
        if (tb && tb.cm) {
          clearInterval(s._bindTimer); s._bindTimer = null;
          _bindCM(s, tb.cm);
          s.pending = [];
          try { s.ws.send(JSON.stringify({ type: "resync" })); } catch (e) {}
        } else if (tries > 2400) {           // 约 20 分钟仍未打开则放弃监听
          clearInterval(s._bindTimer); s._bindTimer = null;
        }
      }, 500);
    }

    function _bindSeed(s, tab, text, focus) {
      _bindCM(s, tab.cm);
      _seed(s, tab.cm, text);
      if (focus && active !== tab) { try { activate(tab); } catch (e) {} }
      _paintAuthors(s);                      // 重绘服务端记录的行级归属（刷新后不丢）
    }

    function _seed(s, cm, text) {
      // 保留光标与滚动位置：重同步 / 载入时不再让光标跳回第 1 行第 1 列
      let cur = null, scroll = null;
      try { cur = cm.getCursor(); scroll = cm.getScrollInfo(); } catch (e) {}
      s.applyingRemote = true;
      cm.setValue(text == null ? "" : text);
      _clearTags(s);                         // 重灌文档：旧的作者标签随之作废
      _clearAllInk(s);                       // 文字着色标记同样作废
      try { cm.clearHistory(); } catch (e) {}
      try {
        if (cur) {
          const doc = cm.getDoc();
          const line = Math.max(0, Math.min(cur.line, doc.lastLine()));
          const ch = Math.max(0, Math.min(cur.ch, doc.getLine(line).length));
          cm.setCursor({ line: line, ch: ch });
        }
        if (scroll) cm.scrollTo(scroll.left, scroll.top);
      } catch (e) {}
      s.applyingRemote = false;
    }

    function _bindCM(s, cm) {
      if (s._bindTimer) { clearInterval(s._bindTimer); s._bindTimer = null; }
      if (s.cm && s.cm !== cm) {
        try { s.cm.off("changes", s.onChanges); s.cm.off("cursorActivity", s.onCursor); } catch (e) {}
      }
      s.cm = cm;
      cm.off("changes", s.onChanges);
      cm.off("cursorActivity", s.onCursor);
      cm.on("changes", s.onChanges);
      cm.on("cursorActivity", s.onCursor);
      _updateUI();
    }

    function _onLocalChanges(s, cm, changes) {
      if (s.applyingRemote || cm !== s.cm) return;
      // 自己改了这些行 → 立刻标注为「你」：整行淡色底 + 行末名字标签 + 改动字符加粗着色。
      // 这一段不依赖连接状态：本地标注必须即时可见，不能等 WebSocket 就绪。
      try {
        changes.forEach((c) => {
          const span = Math.max(c.to.line - c.from.line, (c.text || []).length - 1);
          _markLines(cm, s, c.from.line, c.from.line + span, _ME);
          // 只给自己真正敲进去的那几个字加粗着色（不动这一行原本的代码）
          const ins = (c.text || []).join("\n");
          const f = cm.indexFromPos(c.from);
          _markChars(cm, s, f, f + ins.length, _ME);
        });
      } catch (e) {}
      if (!_isOpen(s)) return;                 // 未连接：本地已标注，但无法上报操作
      // CodeMirror 的 change.from / change.to 都是「修改前」文档坐标，而
      // indexFromPos 会按「修改后」的行长裁剪。删除使行变短时直接对 c.to 调
      // indexFromPos 会把终点裁小，导致删除只同步一小段（表现为「删不掉」）。
      // 用 from + 实际被删文本长度，才能得到与 from 同坐标系（修改前）的终点。
      const ops = changes.map((c) => {
        const from = cm.indexFromPos(c.from);
        const removed = (c.removed || []).join("\n").length;
        return { from: from, to: from + removed, text: c.text.join("\n") };
      }).filter((o) => o.from !== o.to || o.text !== "");
      if (!ops.length) return;
      ops.forEach((o) => { o.id = ++s.opSeq; });   // 自增 id：服务端原样回显，用于精确出队
      s.pending = s.pending.concat(ops);
      s.ws.send(JSON.stringify({ type: "op", base: s.localVersion, ops }));
    }

    function _onCursorActivity(s, cm) {
      if (!_isOpen(s) || cm !== s.cm) return;
      clearTimeout(s.cursorTimer);
      s.cursorTimer = setTimeout(() => {
        if (!_isOpen(s)) return;
        const a = cm.getCursor("anchor"), h = cm.getCursor("head");
        s.ws.send(JSON.stringify({
          type: "cursor", base: s.localVersion,
          from: cm.indexFromPos(a), to: cm.indexFromPos(h),
        }));
      }, 80);
    }

    /* 客户端 OT 变换：与服务端 _transform 同一套语义（含 delta 修正）。
       把 inc 折算到 other 已应用之后的坐标系。 */
    function _otT(inc, other) {
      const of = other.from, ot = other.to, otext = other.text || "";
      const delta = otext.length - (ot - of);
      let f = inc.from, t = inc.to; const txt = inc.text || "";
      if (f <= of) {
        if (t <= of) return { from: f, to: t, text: txt };       // 完全在前
        return { from: f, to: Math.max(t, ot) + delta, text: txt }; // 左重叠
      }
      if (f >= ot) return { from: f + delta, to: t + delta, text: txt }; // 完全在后
      return { from: of + otext.length, to: Math.max(t, ot) + delta, text: txt }; // 起点被吞
    }

    function _applyRemoteOp(s, m) {
      const cm = s.cm; if (!cm) return;
      // 远端 op 是服务端坐标系；本地若有在途 op（已上报未回显，其效果已在
      // 本地文本里），必须先把远端 op 依次对每个在途 op 折算、同时反向更新
      // 在途 op，才能套到本地文本上——绝不能丢 op，否则删除/插入会凭空消失
      let op = { from: m.from, to: m.to, text: m.text || "" };
      if (s.pending.length) {
        const np = [];
        for (const p of s.pending) {
          np.push(_otT(p, op));      // 在途 op 对远端 op 折算（用折算前的远端 op）
          op = _otT(op, p);          // 远端 op 对在途 op 折算
        }
        s.pending = np;
      }
      s.applyingRemote = true;
      cm.replaceRange(op.text, cm.posFromIndex(op.from), cm.posFromIndex(op.to));
      s.applyingRemote = false;
      // 归属：行级（整行淡色底 + 末尾作者标签；纯删除也要标，否则遗留标签会停在原地）
      // 与字符级（只给本次真正写入的那几个字加粗着色，原代码不动）
      const start = cm.posFromIndex(op.from).line;
      const n = (String(op.text).match(/\n/g) || []).length;
      const info = (s.peerInfo && s.peerInfo[m.by]) || { name: "协作者", color: "#6cb6ff" };
      const who = { key: m.by, name: info.name, color: info.color };
      _markLines(cm, s, start, start + n, who);
      _markChars(cm, s, op.from, op.from + String(op.text || "").length, who);
    }

    /* ---------------- 远端光标 ---------------- */
    function _renderRemoteCursor(s, m) {
      _rememberPeer(s, m.id, m.name, m.color);
      const cm = s.cm; if (!cm || m.id === s.myId) return;
      _clearRemoteCursor(s, m.id);
      const from = cm.posFromIndex(m.from), to = cm.posFromIndex(m.to);
      const el = document.createElement("span");
      el.className = "collab-caret";
      el.style.setProperty("--cc", m.color || "#6cb6ff");
      const tag = document.createElement("span");
      tag.textContent = m.name || "协作者";
      el.appendChild(tag);
      const w = cm.setBookmark(from, { widget: el, insertLeft: true });
      let mark = null;
      if (from.line !== to.line || from.ch !== to.ch)
        mark = cm.markText(from, to, { className: "collab-sel", attributes: { style: "--cc:" + (m.color || "#6cb6ff") } });
      s.marks[m.id] = { w, mark };
    }

    function _clearRemoteCursor(s, id) {
      const r = s.marks[id];
      if (!r) return;
      try { r.w && r.w.clear(); } catch (e) {}
      try { r.mark && r.mark.clear(); } catch (e) {}
      delete s.marks[id];
    }

    /* ---------------- 行级归属：这一行是谁改的 ---------------- */
    function _rememberPeer(s, id, name, color) {
      if (!id) return;
      const cur = s.peerInfo[id] || {};
      s.peerInfo[id] = { name: name || cur.name || "协作者", color: color || cur.color || "#6cb6ff" };
    }
    function _rememberPeers(s, list) {
      (list || []).forEach((p) => _rememberPeer(s, p.id, p.name, p.color));
    }
    /* 改动行的背景高亮（按作者配色）+ 右上角「谁改过」图例 */
    const _ME = { key: "me", name: "你", color: "#8ab4f8" };
    function _hexToRgba(hex, a) {
      const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || "").trim());
      if (!m) return "rgba(108,182,255," + a + ")";
      const n = parseInt(m[1], 16);
      return "rgba(" + ((n >> 16) & 255) + "," + ((n >> 8) & 255) + "," + (n & 255) + "," + a + ")";
    }
    /* 改动行高亮：用「行背景类」实现（整行铺满，且比文本标记便宜得多）。
       颜色规则按作者动态生成，避免给每个作者写死一条 CSS。 */
    const _tintSeen = {};
    const _clsWho = {};                    // 行背景类名 -> 作者（由行类反查「谁改的」，供标签使用）
    function _safeKey(k) {
      return String(k == null ? "" : k).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 24) || "x";
    }
    /* 按作者动态生成「行背景」色规则（淡色底），同一作者只生成一次 */
    function _authorClass(who) {
      const cls = "collab-tint-" + _safeKey(who.key);
      _clsWho[cls] = who;
      if (!_tintSeen[cls]) {
        _tintSeen[cls] = true;
        let st = $("collabTintStyles");
        if (!st) {
          st = document.createElement("style");
          st.id = "collabTintStyles";
          document.head.appendChild(st);
        }
        st.textContent += "." + cls + "{background:" +
          _hexToRgba(who.color || "#6cb6ff", .18) + ";}";
      }
      return cls;
    }
    /* 行背景：整行淡色底，表示「这一行被动过」（行级粒度，配合末尾的作者标签） */
    function _applyLineBg(cm, i, who) {
      _clearLineBg(cm, i);
      try { cm.addLineClass(i, "background", _authorClass(who)); } catch (e) {}
    }
    function _clearLineBg(cm, line) {
      let h = null;
      try { h = cm.getLineHandle(line); } catch (e) {}
      const cur = (h && h.bgClass) || "";
      if (!cur) return;
      Object.keys(_tintSeen).forEach((cls) => {
        if (cur.indexOf(cls) < 0) return;             // 该行没挂这个类就不用摘
        try { cm.removeLineClass(line, "background", cls); } catch (e) {}
      });
    }
    /* ---- 改动文字的加粗着色：只落在「实际被改动的字符」上，原本就有的代码不受影响 ----
       用 markText 打标记 + 内联 CSS 变量 --ca 传作者色；标记随文档编辑自动伸缩，
       其覆盖的文本被删掉时自动失效；不同作者的标记可相互嵌套（内层色优先）。 */
    function _clearAllInk(s) {
      (s.inkMarks || []).forEach((mk) => { try { mk.clear(); } catch (e) {} });
      s.inkMarks = [];
    }
    function _markChars(cm, s, from, to, who) {
      if (!cm || !who || to <= from) return;           // 纯删除：没有新文本可着色
      const style = "--ca:" + (who.color || "#6cb6ff");
      let a = from, b = to;
      // 与相邻/重叠的「同色」标记合并：连续输入的每个字不会各留一个标记
      s.inkMarks = (s.inkMarks || []).filter((mk) => {
        const r = mk.find();
        if (!r) return false;
        if (!mk.attributes || mk.attributes.style !== style) return true;
        const rf = cm.indexFromPos(r.from);
        const rt = cm.indexFromPos(r.to);
        if (rf <= b && rt >= a) {
          if (rf < a) a = rf;
          if (rt > b) b = rt;
          try { mk.clear(); } catch (e) {}
          return false;
        }
        return true;
      });
      try {
        const mk = cm.markText(cm.posFromIndex(a), cm.posFromIndex(b), {
          className: "collab-ink",
          attributes: { style: style },
        });
        s.inkMarks.push(mk);
      } catch (e) {}
    }
    /* 把 [startLine, endLine] 的行标注为 who（整行背景高亮 + 记入右上角图例）；
       同一行再次被改动时先清掉旧类 —— 最后修改者覆盖。 */
    function _markLines(cm, s, startLine, endLine, who) {
      if (!cm || !who) return;
      s.editedBy[who.key] = who;
      for (let i = startLine; i <= endLine; i++) {
        if (i < 0 || i >= cm.lineCount()) continue;
        _applyLineBg(cm, i, who);                // 整行淡色底（字符级着色由 _markChars 负责）
      }
      _refreshTags(cm, s, startLine, endLine);   // 只重建这一小段的作者标签
      _updateLegend();
    }
    /* ---- 改动处的「作者标签」：在被修改区域首行末尾挂一个小药丸 ----
       用 bookmark + widget 插入，位置由 CodeMirror 随文档增删自动跟随。 */
    function _lineTintClass(cm, i) {
      let h = null;
      try { h = cm.getLineHandle(i); } catch (e) {}
      const bg = h && h.bgClass;
      if (!bg) return null;
      const arr = String(bg).split(/\s+/);
      for (let k = 0; k < arr.length; k++) {
        if (arr[k].indexOf("collab-tint-") === 0) return arr[k];
      }
      return null;
    }
    function _clearTags(s) {
      (s.tagMarks || []).forEach((mk) => { try { mk.clear(); } catch (e) {} });
      s.tagMarks = [];
    }
    function _addTag(cm, s, line, who) {
      try {
        const node = document.createElement("span");
        node.className = "collab-tag";
        node.title = who.name + " 修改了此处";
        node.innerHTML = '<i class="dot" style="background:' + esc(who.color) + '"></i>' + esc(who.name);
        const mk = cm.setBookmark(
          { line: line, ch: cm.getLine(line).length },
          { widget: node, insertLeft: true });
        if (mk) s.tagMarks.push(mk);
      } catch (e) {}
    }
    /* 重建 [startLine, endLine] 所在「连续改动区间」内的标签。
       热路径（每次按键 / 每个远端操作）只处理这一小段，不扫整篇。 */
    function _refreshTags(cm, s, startLine, endLine) {
      if (!cm) return;
      const n = cm.lineCount();
      let ra = Math.max(0, startLine);
      let rb = Math.min(n - 1, endLine);
      while (ra > 0 && _lineTintClass(cm, ra - 1)) ra--;            // 向左扩到区间起点
      while (rb + 1 < n && _lineTintClass(cm, rb + 1)) rb++;        // 向右扩到区间终点
      s.tagMarks = (s.tagMarks || []).filter((mk) => {              // 丢掉落在此区间内的旧标签
        const p = mk.find();
        if (!p) return false;
        if (p.line >= ra && p.line <= rb) { try { mk.clear(); } catch (e) {} return false; }
        return true;
      });
      let i = ra;
      while (i <= rb) {                                             // 按连续同作者分组重建
        const cls = _lineTintClass(cm, i);
        if (!cls) { i++; continue; }
        let j = i;
        while (j + 1 <= rb && _lineTintClass(cm, j + 1) === cls) j++;
        const who = _clsWho[cls];
        // 自己改的也照样挂标签（显示为「你」）：谁改的、改在哪一行，一眼可见
        if (who) _addTag(cm, s, i, who);
        i = j + 1;
      }
    }
    /* 整篇重建（刷新 / 重新载入后按服务端行级归属重绘） */
    function _syncTags(cm, s) {
      if (!cm) return;
      _clearTags(s);
      _refreshTags(cm, s, 0, cm.lineCount() - 1);
    }
    /* 刷新 / 重新载入后从服务端拉取归属并重绘，否则「谁改的」会全部丢失。
       服务端给两份：runs=行级（行背景 + 末尾标签）、chars=字符级（只给被改的字着色）。 */
    function _paintAuthors(s) {
      const cm = s.cm;
      if (!cm || !s.token) return;
      fetch("/api/collab/" + _enc(s.token) + "/authors")
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (!d || !s.cm || cm !== s.cm) return;
          const whoOf = (sid, name, color) => ((sid && sid === s.myId)
            ? _ME
            : { key: sid, name: name || "协作者", color: color || "#6cb6ff" });
          s.editedBy = {};
          (d.runs || []).forEach((run) => {
            const who = whoOf(run[2], run[3], run[4]);
            const a = Math.max(0, run[0] | 0);
            const b = Math.min(cm.lineCount() - 1, run[1] | 0);
            for (let i = a; i <= b; i++) _applyLineBg(cm, i, who);
            s.editedBy[who.key] = who;
          });
          _clearAllInk(s);
          (d.chars || []).forEach((c) => {
            _markChars(cm, s, c[0] | 0, c[1] | 0, whoOf(c[2], c[3], c[4]));
          });
          _syncTags(cm, s);                  // 按服务端记录重建作者标签
          _updateLegend();
        })
        .catch(() => {});
    }
    /* 右上角图例：列出改过当前文件的协作者（含「你」） */
    function _updateLegend() {
      const box = $("collabLegend");
      if (!box) return;
      const s = _activeSess();
      const list = s ? Object.keys(s.editedBy).map((k) => s.editedBy[k]) : [];
      if (!list.length) {
        if (box.dataset.on === "1") { box.classList.remove("on"); box.innerHTML = ""; box.dataset.on = "0"; }
        return;
      }
      const html = '<span class="lg-hd">已改动</span>' + list.map((a) =>
        '<span class="lg" title="' + esc(a.name) + ' 改动过此文件"><span class="dot" style="background:' + esc(a.color) + '">' +
        esc(_initial(a.name)) + "</span>" + esc(a.name) + "</span>").join("");
      if (box.dataset.sig !== html) { box.innerHTML = html; box.dataset.sig = html; }
      if (box.dataset.on !== "1") { box.classList.add("on"); box.dataset.on = "1"; }
    }

    /* 从服务端重新拉取权威内容覆盖本地编辑器（修复两端不一致）。
       服务端 resync 会回发 welcome，welcome 处理会重置文本并聚焦该文件。 */
    function _reloadFromServer(s, path) {
      _openPath(path || (s && s.room && s.room.path));   // 立刻在编辑区打开 / 切到该文件
      if (!s || !_isOpen(s)) { toast("该文件未连接，无法载入最新内容", "warn"); return; }
      s.pending = [];
      s.wantFocus = true;
      s.reloading = true;
      try { s.ws.send(JSON.stringify({ type: "resync" })); toast("正在载入服务器最新内容…", "ok"); }
      catch (e) { s.reloading = false; toast("载入失败", "err"); }
    }

    /* ---------------- 结束会话 ---------------- */
    /* 清掉某个会话在编辑器里留下的全部协作标注：改动行淡色底、改动字符加粗着色、
       行末作者标签，并清空「已改动」图例。停止分享 / 协作结束后调用，让编辑器恢复正常显示。 */
    function _clearEditorMarks(s, cm) {
      cm = cm || (s && s.cm);
      if (!cm) return;
      const n = cm.lineCount();
      for (let i = 0; i < n; i++) _clearLineBg(cm, i);   // 行背景（无标注的行会直接跳过）
      if (s) {
        _clearAllInk(s);                                 // 字符级加粗着色
        _clearTags(s);                                   // 行末作者标签
        s.editedBy = {};
      }
      _updateLegend();                                   // 无会话时图例自动隐藏
    }

    function _endSession(token, opts) {
      opts = opts || {};
      const s = S.sessions[token];
      if (s) {
        if (s._bindTimer) { clearInterval(s._bindTimer); s._bindTimer = null; }
        if (s.ws) {
          // 主动关闭前先摘掉事件回调：ws.close() 是异步握手，紧随其后的
          // 「停止房间」DELETE 会在握手完成前向本连接广播 closed，连接被
          // 异常断开会触发 onerror 误报「协作连接出错」——这里摘掉即静默
          try { s.ws.onclose = s.ws.onerror = s.ws.onmessage = null; } catch (e) {}
          try { s.ws.close(); } catch (e) {}
          s.ws = null;
        }
        if (s.cm) {
          try { s.cm.off("changes", s.onChanges); s.cm.off("cursorActivity", s.onCursor); } catch (e) {}
          // 退出协作后把协作期留下的标注（改动行背景 / 字符着色 / 作者标签）全部清掉：
          // 编辑器自动恢复成正常代码编辑器显示效果
          try { _clearEditorMarks(s, s.cm); } catch (e) {}
        }
        Object.keys(s.marks).forEach((id) => _clearRemoteCursor(s, id));
        delete S.sessions[token];
      }
      if (opts.stopRoom) {
        fetch("/api/collab/rooms/" + _enc(token), { method: "DELETE" })
          .then(() => _refreshRooms())
          .catch(() => _refreshRooms());
      } else {
        _refreshRooms();
      }
      _updateUI();
    }

    /* ================= 批量分享：勾选文件夹/文件一起共同编辑 =================
       右键菜单「分享共同编辑…」打开选择器：勾选若干文件/文件夹 →
       为每个文件建一个房间（同批次共用一个「分享组」id）→ 受邀者页按组列出
       被勾选的文件，点击即可进入对应文件的共同编辑。 */
    const SHARE_SKIP_RE = /^(node_modules|\.git|__pycache__|\.venv|venv|dist|build|\.idea|\.vscode|logs?|site-packages|\.next|target)$/i;
    const SHARE_MAX_FILES = 120;
    let _shareOv = null;

    function _spClose() {
      if (_shareOv) { _shareOv.remove(); _shareOv = null; }
      document.removeEventListener("keydown", _spKey, true);
    }
    function _spKey(ev) { if (ev.key === "Escape") { ev.stopPropagation(); _spClose(); } }

    window.IDECollabSharePicker = function (rootDir) {
      _spClose();
      const ov = document.createElement("div");
      ov.className = "collab-overlay";
      ov.innerHTML =
        '<div class="collab-modal sp-modal">' +
          '<div class="collab-head"><i class="bi bi-share"></i> 分享共同编辑' +
            '<span class="sp-path">' + esc(rootDir) + '</span>' +
            '<button class="c-close" id="spClose" title="关闭 (Esc)">×</button></div>' +
          '<div class="sp-bar"><span class="sp-hint">勾选文件或文件夹（勾选文件夹＝共享其中全部文件，' +
            '最多 ' + SHARE_MAX_FILES + ' 个，自动跳过 node_modules / .git 等）</span></div>' +
          '<div class="sp-tree" id="spTree"></div>' +
          '<div class="sp-foot"><span class="sp-count" id="spCount">已勾选：0 个文件</span>' +
            '<button class="collab-btn" id="spGo">开始分享</button></div>' +
          '<div class="sp-link" id="spLink" style="display:none"></div>' +
        '</div>';
      document.body.appendChild(ov);
      _shareOv = ov;
      const pickedFiles = new Set(), pickedDirs = new Set();
      const treeEl = ov.querySelector("#spTree");
      const countEl = ov.querySelector("#spCount");
      const updCount = () => {
        countEl.textContent = "已勾选：文件 " + pickedFiles.size + " 个 · 文件夹 " + pickedDirs.size + " 个";
      };

      function mkRow(path, name, isDir, depth) {
        const item = document.createElement("div");
        item.className = "sp-item";
        const r = document.createElement("div");
        r.className = "sp-row" + (isDir ? " dir" : "");
        r.style.paddingLeft = (6 + depth * 16) + "px";
        r.innerHTML =
          '<span class="tw">' + (isDir ? '<i class="bi bi-chevron-right"></i>' : "") + '</span>' +
          '<input type="checkbox" class="sp-ck">' +
          '<span class="ic"><i class="bi ' + (isDir ? "bi-folder-fill" : "bi-file-earmark") + '"></i></span>' +
          '<span class="nm">' + esc(name) + '</span>';
        const kids = document.createElement("div");
        kids.className = "sp-kids";
        kids.style.display = "none";
        item.appendChild(r);
        item.appendChild(kids);
        const ck = r.querySelector(".sp-ck");
        if (isDir) {
          const toggleOpen = () => {
            const open = kids.style.display !== "none";
            if (!open && !kids.dataset.loaded) {
              kids.dataset.loaded = "1";
              loadDir(path, kids, depth + 1);
            }
            kids.style.display = open ? "none" : "block";
            r.querySelector(".tw").innerHTML =
              open ? '<i class="bi bi-chevron-right"></i>' : '<i class="bi bi-chevron-down"></i>';
          };
          r.querySelector(".tw").onclick = (e) => { e.stopPropagation(); toggleOpen(); };
          r.querySelector(".nm").onclick = toggleOpen;
          ck.onchange = () => {
            if (ck.checked) pickedDirs.add(path); else pickedDirs.delete(path);
            r.classList.toggle("on", ck.checked);
            updCount();
          };
        } else {
          ck.onchange = () => {
            if (ck.checked) pickedFiles.add(path); else pickedFiles.delete(path);
            r.classList.toggle("on", ck.checked);
            updCount();
          };
        }
        return item;
      }

      function loadDir(dir, box, depth) {
        box.innerHTML = '<div class="sp-row" style="padding-left:' + (6 + depth * 16) + 'px">' +
          '<span class="nm" style="color:#8a8a8a">加载中…</span></div>';
        fetch("/api/files?path=" + _enc(dir))
          .then((r) => r.json())
          .then((d) => {
            box.innerHTML = "";
            const items = (d && d.items) || [];
            if (!items.length) {
              box.innerHTML = '<div class="sp-row" style="padding-left:' + (6 + depth * 16) + 'px">' +
                '<span class="nm" style="color:#8a8a8a">（空）</span></div>';
              return;
            }
            items.sort((a, b) => (!!b.is_dir - !!a.is_dir) ||
              String(a.name || "").localeCompare(String(b.name || ""), "zh-CN"));
            items.forEach((it) => {
              const p = dir.replace(/\/+$/, "") + "/" + it.name;
              box.appendChild(mkRow(p, it.name || "", !!it.is_dir, depth));
            });
          })
          .catch(() => { box.innerHTML = '<div class="sp-row"><span class="nm" style="color:#c98">加载失败</span></div>'; });
      }

      /* 把勾选的文件夹展开成其中的文件清单（跳过依赖目录，限制数量） */
      function collectDir(dir, out, depth) {
        if (depth > 6 || out.length >= SHARE_MAX_FILES) return Promise.resolve();
        return fetch("/api/files?path=" + _enc(dir))
          .then((r) => r.json())
          .then((d) => Promise.all(((d && d.items) || []).map((it) => {
            if (out.length >= SHARE_MAX_FILES) return null;
            const p = dir.replace(/\/+$/, "") + "/" + it.name;
            if (it.is_dir) {
              if (SHARE_SKIP_RE.test(it.name)) return null;
              return collectDir(p, out, depth + 1);
            }
            if (out.indexOf(p) < 0) out.push(p);
            return null;
          })))
          .catch(() => {});
      }

      ov.querySelector("#spClose").onclick = _spClose;
      ov.addEventListener("mousedown", (e) => { if (e.target === ov) _spClose(); });
      document.addEventListener("keydown", _spKey, true);
      loadDir(rootDir, treeEl, 0);

      ov.querySelector("#spGo").onclick = async () => {
        const goBtn = ov.querySelector("#spGo");
        goBtn.disabled = true;
        goBtn.textContent = "正在创建…";
        const files = [];
        pickedFiles.forEach((f) => { if (files.indexOf(f) < 0) files.push(f); });
        for (const d of pickedDirs) await collectDir(d, files, 0);
        if (!files.length) {
          toast("请先勾选要共享的文件", "warn");
          goBtn.disabled = false; goBtn.textContent = "开始分享";
          return;
        }
        const gid = "g" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        const nm = _defaultName();
        let ok = 0, fail = 0;
        for (const f of files) {
          try {
            const r = await fetch("/api/collab/rooms", {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ path: f, group: gid }),
            });
            const d = await r.json();
            if (d.error) { fail++; continue; }
            _saveHostKey(d.token, d.hostKey);
            // 已在编辑区打开的文件立刻接上会话；没打开的等用户打开时自动载入
            const tab = findTab(f);
            if (tab && tab.cm) {
              _connectSession(d.token, nm, _colorFor(nm), d.hostKey, { autoOpen: false });
            }
            ok++;
          } catch (e) { fail++; }
        }
        _refreshRooms();
        toast("已共享 " + ok + " 个文件" + (fail ? "（失败 " + fail + " 个）" : ""), ok ? "ok" : "err");
        // 展示一条组邀请链接：打开即看到被勾选的全部文件
        const link = location.origin + "/collab?collab=" + encodeURIComponent(gid);
        const linkEl = ov.querySelector("#spLink");
        linkEl.style.display = "block";
        linkEl.innerHTML =
          '<div class="sp-linktxt">邀请链接（打开后可见上面勾选的全部文件，点击即可共同编辑）：</div>' +
          '<div class="sp-linkrow"><input readonly value="' + esc(link) + '">' +
          '<button class="collab-btn ghost" id="spCopy">复制</button></div>';
        linkEl.querySelector("#spCopy").onclick = () => { copyText(link); toast("邀请链接已复制", "ok"); };
        goBtn.textContent = "已分享 " + ok + " 个文件";
      };
    };

    /* ---------------- 对外暴露：标题栏按钮 & 链接自动加入 ---------------- */
    window.openCollab = openCollab;
    window.IDECollabAutoJoin = function (token) {
      if (!token) return;
      const hk = _hostKeys()[token];          // 本机创建过的房间：带上房主密钥
      const name = _defaultName();      // 固定用登录用户名（不再是随机的房主/访客+数字）
      _render();
      _connectSession(token, name, _randColor(), hk, { focus: true });
    };

    // 页面带 ?collab=token 时自动弹窗加入
    try {
      const t = new URLSearchParams(location.search).get("collab");
      if (t) setTimeout(() => window.IDECollabAutoJoin(t), 400);
    } catch (e) {}

    /* 刷新页面后自动恢复本机创建、且服务端仍在的所有房间（每个文件一条连接）。
       否则房主一刷新就断线，服务端宽限期一过房间仍会被回收。 */
    function _autoRejoinOwned() {
      try { if (new URLSearchParams(location.search).get("collab")) return; } catch (e) {}
      const hk = _hostKeys();
      const owned = (S.knownRooms || []).filter((r) => r.token && hk[r.token] && !S.sessions[r.token]);
      if (!owned.length) return;
      // 自动恢复只重连房间：不打开文件、不切换标签，保持用户原来的标签组与焦点
      const nm = _defaultName();              // 所有恢复的会话共用同一个昵称
      owned.forEach((r) => {
        _connectSession(r.token, nm, _randColor(), hk[r.token], { focus: false, autoOpen: false });
      });
      toast("已恢复 " + owned.length + " 个协作房间（文件已打开时自动同步）", "ok");
    }

    // 悬浮对比按钮：跟随标签切换 / 窗口尺寸变化保持显示与定位
    // 顺带 700ms 兜底：带「协作中」标记的标签若还没载入（编辑器就绪较晚、绑定失效等），补一次
    try {
      window.addEventListener("resize", _positionTopRight);
      setInterval(() => {
        _syncFab();
        try { (tabs || []).forEach((t) => _autoLoadTab(t)); } catch (e) {}
      }, 700);
      _syncFab();
    } catch (e) {}

    // 启动即拉取服务端现存房间：刷新后「协作中的文件」立即可见，并自动恢复本机房间
    _refreshRooms().then(_autoRejoinOwned);
  })();

  /* ================================================================
   * 表格查看 / 编辑（xlsx / xlsm / xls / et / csv / tsv）
   * 在 openFile（00_preamble.js）中按扩展名调用 setupSheetView；
   * 数据由 /api/sheet/read 提供，保存经 saveSheetTab → /api/sheet/write，
   * 并接入 02_ 的 saveTab（Mod+S 保存当前 / 保存全部）。
   * xls / et（WPS 表格）为只读格式，仅支持查看。
   *
   * 支持：单元格编辑、区域选择（拖选 / Shift 扩选）、整行整列选择、
   *       插入 / 删除行、插入 / 删除列、多行多列批量删除、清空内容、
   *       复制 / 粘贴（TSV）、撤销 / 重做、查找高亮、右键菜单。
   * 结构变化（增删行列）→ 保存时整表回写；纯改单元格 → 只提交差异补丁。
   * ================================================================ */

  function _shEsc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  // 列序号 → 列名：0→A, 25→Z, 26→AA
  function _shColName(i) {
    let s = "";
    i += 1;
    while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); }
    return s;
  }

  function setupSheetView(tab, host, path, name) {
    // 注意：activate(tab) 由 00_preamble.js 的 openFile 调用（闭包内函数，这里访问不到）
    tab.isSheet = true;
    tab.sheetChanges = {};
    const st = tab.sheetState = {
      active: null, writable: false, isCsv: false, ext: "", data: [], cols: 0,
      truncated: false, struct: false, orig: [], merges: [],
      aligns: {}, alignDirty: false,
    };

    let sel = null;              // 选区锚点/焦点：{ar, ac, fr, fc}
    let editing = null;          // 正在编辑的单元格 <td>
    let editSnap = false;        // 本次编辑是否已压入撤销栈
    let pvTimer = 0;             // 悬停预览的延迟计时器
    let pvNodes = [];            // 预览时插入的虚拟行 / 虚拟列节点（用于精确清理）
    let dragging = false;        // 是否正在按住鼠标拖选
    let dragKind = "";           // cell / row / col
    let dragAnchor = null;       // 拖选起点
    let dragRaf = 0;             // 拖选重绘节流
    const undoStack = [], redoStack = [];
    const UNDO_MAX = 60;

    host.innerHTML =
      '<div class="sheetv">' +
        '<div class="sheetv-toolbar">' +
          '<span class="sheetv-name"><i class="bi bi-table"></i> ' + _shEsc(name) + '</span>' +
          '<select class="sheetv-sheets"></select>' +
          '<span class="sheetv-meta"></span>' +
          '<span class="sheetv-findwrap"><i class="bi bi-search"></i>' +
            '<input class="sheetv-find" placeholder="查找内容…" title="输入关键字高亮匹配，回车跳到下一个">' +
          '</span>' +
          '<span class="sheetv-flex"></span>' +
          '<span class="sheetv-group">' +
            '<button class="sheetv-btn" data-a="undo" title="撤销 (Ctrl+Z)"><i class="bi bi-arrow-counterclockwise"></i></button>' +
            '<button class="sheetv-btn" data-a="redo" title="重做 (Ctrl+Y / Ctrl+Shift+Z)"><i class="bi bi-arrow-clockwise"></i></button>' +
          '</span>' +
          '<span class="sheetv-group">' +
            '<button class="sheetv-btn" data-a="row-above" title="在选中行上方插入一行"><i class="bi bi-plus-square"></i> 插入行</button>' +
            '<button class="sheetv-btn caret" data-a="row-menu" title="选择插入行位置：上方 / 下方"><i class="bi bi-caret-down-fill"></i></button>' +
            '<button class="sheetv-btn danger" data-a="row-del" title="删除选中行（可多选整行）"><i class="bi bi-dash-square"></i> 删除行</button>' +
          '</span>' +
          '<span class="sheetv-group">' +
            '<button class="sheetv-btn" data-a="col-left" title="在选中列左侧插入一列"><i class="bi bi-plus-square-dotted"></i> 插入列</button>' +
            '<button class="sheetv-btn caret" data-a="col-menu" title="选择插入列位置：左侧 / 右侧"><i class="bi bi-caret-down-fill"></i></button>' +
            '<button class="sheetv-btn danger" data-a="col-del" title="删除选中列（可多选整列）"><i class="bi bi-dash-square-dotted"></i> 删除列</button>' +
          '</span>' +
          '<span class="sheetv-group">' +
            '<button class="sheetv-btn" data-a="merge" title="合并选中区域为一个单元格"><i class="bi bi-bounding-box"></i> 合并</button>' +
            '<button class="sheetv-btn" data-a="unmerge" title="取消选中区域内的合并"><i class="bi bi-bounding-box-circles"></i> 取消合并</button>' +
          '</span>' +
          '<span class="sheetv-group">' +
            '<button class="sheetv-btn" data-a="align-left" title="左对齐"><i class="bi bi-text-left"></i></button>' +
            '<button class="sheetv-btn" data-a="align-center" title="水平居中"><i class="bi bi-text-center"></i></button>' +
            '<button class="sheetv-btn" data-a="align-right" title="右对齐"><i class="bi bi-text-right"></i></button>' +
            '<button class="sheetv-btn" data-a="align-reset" title="清除对齐（恢复默认）"><i class="bi bi-dash-circle"></i></button>' +
          '</span>' +
          '<span class="sheetv-group">' +
            '<button class="sheetv-btn" data-a="fill-down" title="向下填充：把选区第一行复制到下面各行，公式引用自动平移 (Ctrl+D)"><i class="bi bi-arrow-down-square"></i></button>' +
            '<button class="sheetv-btn" data-a="fill-right" title="向右填充：把选区第一列复制到右边各列，公式引用自动平移 (Ctrl+R)"><i class="bi bi-arrow-right-square"></i></button>' +
            '<button class="sheetv-btn" data-a="fill-col" title="一键填充整列：把选区首行的公式应用到该列所有行"><i class="bi bi-arrow-bar-down"></i></button>' +
          '</span>' +
          '<span class="sheetv-group">' +
            '<button class="sheetv-btn danger" data-a="clear" title="清空选中区域内容 (Delete)"><i class="bi bi-eraser"></i> 清空</button>' +
          '</span>' +
          '<span class="sheetv-tip"></span>' +
          '<button class="sheetv-save">保存</button>' +
        '</div>' +
        '<div class="sheetv-fbar">' +
          '<span class="fx">fx</span>' +
          '<span class="sheetv-fref">A1</span>' +
          '<input class="sheetv-finput" spellcheck="false" autocomplete="off" ' +
            'placeholder="输入内容或公式，如 =A1+B1、=SUM(A1:A9)、=IF(C1&gt;60,&quot;及格&quot;,&quot;不及格&quot;)">' +
        '</div>' +
        '<div class="sheetv-grid" tabindex="0"><div class="sheetv-empty">加载中…</div></div>' +
        '<div class="sheetv-quick" style="display:none">' +
          '<span class="q-info"></span>' +
          '<button data-q="copy" title="复制选区 (Ctrl+C)"><i class="bi bi-files"></i> 复制</button>' +
          '<button data-q="paste" title="粘贴到选区左上角 (Ctrl+V)"><i class="bi bi-clipboard"></i> 粘贴</button>' +
          '<button data-q="clear" title="清空选区内容 (Delete)"><i class="bi bi-eraser"></i> 清空</button>' +
          '<button data-q="row-del" class="danger" title="删除选中的整行"><i class="bi bi-dash-square"></i> 删除行</button>' +
          '<button data-q="col-del" class="danger" title="删除选中的整列"><i class="bi bi-dash-square-dotted"></i> 删除列</button>' +
        '</div>' +
      '</div>';

    const selEl = host.querySelector(".sheetv-sheets");
    const grid = host.querySelector(".sheetv-grid");
    const meta = host.querySelector(".sheetv-meta");
    const tip = host.querySelector(".sheetv-tip");
    const saveBtn = host.querySelector(".sheetv-save");
    const findEl = host.querySelector(".sheetv-find");
    const quick = host.querySelector(".sheetv-quick");
    const fref = host.querySelector(".sheetv-fref");
    const finp = host.querySelector(".sheetv-finput");

    /* ---------------- 基础工具 ---------------- */
    function markDirty() {
      if (tab.dirty) return;
      tab.dirty = true;
      if (tab.el) tab.el.classList.add("dirty");
      refreshTreeDirty();
    }
    function curCols() {
      let n = st.cols || 0;
      for (const r of st.data) if (r.length > n) n = r.length;
      return Math.max(n, 1);
    }
    function norm() {
      if (!sel) return null;
      return {
        r1: Math.min(sel.ar, sel.fr), r2: Math.max(sel.ar, sel.fr),
        c1: Math.min(sel.ac, sel.fc), c2: Math.max(sel.ac, sel.fc),
      };
    }
    function updateMeta() {
      meta.textContent = st.data.length + " 行 × " + curCols() + " 列" + (st.truncated ? "（超出上限已截断）" : "");
    }
    function syncBtns() {
      host.querySelectorAll(".sheetv-btn").forEach(b => { b.disabled = !st.writable; });
    }
    /* 结构操作前检查：表被截断时整表回写会丢数据，直接禁用 */
    function structGuard() {
      if (!st.writable) { toast("该格式为只读，无法修改", "warn"); return false; }
      if (st.truncated) { toast("表格过大已被截断加载，增删行列可能丢失未加载的数据，已禁用", "warn"); return false; }
      return true;
    }

    /* ---------------- 撤销 / 重做 ---------------- */
    function snap() {
      return {
        data: st.data.map(r => r.slice()),
        cols: st.cols,
        merges: (st.merges || []).map(m => m.slice()),
        aligns: Object.assign({}, st.aligns || {}),
      };
    }
    function pushUndo() {
      undoStack.push(snap());
      if (undoStack.length > UNDO_MAX) undoStack.shift();
      redoStack.length = 0;
    }
    function restore(s) {
      st.data = s.data.map(r => r.slice());
      st.cols = s.cols;
      st.merges = (s.merges || []).map(m => m.slice());
      const beforeAlign = JSON.stringify(st.aligns || {});
      st.aligns = Object.assign({}, s.aligns || {});
      // 只有对齐真的变了才标记（避免大文件读不到对齐时把原文件的格式清掉）
      if (JSON.stringify(st.aligns) !== beforeAlign) st.alignDirty = true;
      st.struct = true;              // 结构可能变过，保存时按整表回写
      tab.sheetChanges = {};
      markDirty();
      renderGrid();
      updateMeta();
    }
    function doUndo() {
      if (!undoStack.length) { toast("没有可撤销的操作", "warn"); return; }
      redoStack.push(snap());
      restore(undoStack.pop());
    }
    function doRedo() {
      if (!redoStack.length) { toast("没有可重做的操作", "warn"); return; }
      undoStack.push(snap());
      restore(redoStack.pop());
    }

    /* ---------------- 渲染 ---------------- */
    /* ---------------- 公式引擎（A1+B1、SUM(A1:A9) 等） ----------------
       只做本地计算与展示：保存时写回公式原文（xlsx 由 openpyxl 存成真公式，
       csv 就是文本），重新打开时后端会把公式原文带回来再算一遍 */
    let dispCache = new Map();

    function shIsFormula(v) { return typeof v === "string" && /^\s*=/.test(v); }
    function shRawAt(r, c) {
      const row = st.data[r];
      return row && row[c] != null ? row[c] : "";
    }
    function shRefOf(s) {
      const m = /^\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(String(s).trim());
      if (!m) return null;
      let c = 0;
      for (const ch of m[1].toUpperCase()) c = c * 26 + (ch.charCodeAt(0) - 64);
      return { r: parseInt(m[2], 10) - 1, c: c - 1 };
    }
    function shToNum(v) {
      if (typeof v === "number") return isNaN(v) ? 0 : v;
      if (typeof v === "boolean") return v ? 1 : 0;
      const s = String(v == null ? "" : v).replace(/,/g, "").trim();
      if (s === "") return 0;
      const n = Number(s);
      return isNaN(n) ? 0 : n;
    }
    function shRound(v) { return Math.round(v * 1e10) / 1e10; }
    function shFmt(v) {
      if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
      if (typeof v === "number") {
        if (!isFinite(v)) return "#DIV/0!";
        return String(shRound(v));
      }
      return String(v == null ? "" : v);
    }
    function shCellValue(r, c, stack) {
      const key = r + "," + c;
      if (dispCache.has(key)) return dispCache.get(key);
      const raw = shRawAt(r, c);
      if (!shIsFormula(raw)) return raw;
      if (stack.indexOf(key) >= 0) throw new Error("#CIRC");
      const s = String(raw);
      const v = shEval(s.slice(s.indexOf("=") + 1), stack.concat([key]));
      const out = typeof v === "number" ? shRound(v) : v;
      dispCache.set(key, out);
      return out;
    }
    function shDisplay(r, c) {
      try { return shFmt(shCellValue(r, c, [])); }
      catch (e) { return e && e.message === "#CIRC" ? "#循环" : "#错误"; }
    }
    /* 函数参数展开：区域 → 逐个取值 */
    function shFlat(args, stack) {
      const out = [];
      args.forEach(a => {
        if (a && typeof a === "object" && a.__range) {
          const r1 = Math.min(a.r1, a.r2), r2 = Math.max(a.r1, a.r2);
          const c1 = Math.min(a.c1, a.c2), c2 = Math.max(a.c1, a.c2);
          const maxR = Math.min(r2, r1 + 5000), maxC = Math.min(c2, c1 + 200);
          for (let r = r1; r <= maxR; r++) for (let c = c1; c <= maxC; c++) out.push(shCellValue(r, c, stack));
        } else out.push(a);
      });
      return out;
    }
    function shFn(name, args, stack) {
      const nums = () => shFlat(args, stack).map(shToNum);
      switch (name) {
        case "SUM": return nums().reduce((a, b) => a + b, 0);
        case "AVERAGE": case "AVG": {
          const n = nums(); return n.length ? n.reduce((a, b) => a + b, 0) / n.length : 0;
        }
        case "MIN": { const n = nums(); return n.length ? Math.min.apply(null, n) : 0; }
        case "MAX": { const n = nums(); return n.length ? Math.max.apply(null, n) : 0; }
        case "COUNT": return shFlat(args, stack).filter(v =>
          typeof v === "number" || (String(v == null ? "" : v).trim() !== "" && !isNaN(Number(String(v).replace(/,/g, ""))))).length;
        case "COUNTA": return shFlat(args, stack).filter(v => String(v == null ? "" : v).trim() !== "").length;
        case "ABS": return Math.abs(shToNum(args[0]));
        case "SQRT": return Math.sqrt(shToNum(args[0]));
        case "ROUND": {
          const d = args.length > 1 ? shToNum(args[1]) : 0;
          const p = Math.pow(10, d);
          return Math.round(shToNum(args[0]) * p) / p;
        }
        case "POWER": return Math.pow(shToNum(args[0]), shToNum(args[1]));
        case "CONCAT": case "CONCATENATE": return shFlat(args, stack).map(v => String(v == null ? "" : v)).join("");
        case "IF": {
          const cond = args[0];
          const truthy = typeof cond === "boolean" ? cond
            : typeof cond === "number" ? cond !== 0
            : typeof cond === "string" ? (cond !== "" && cond.toUpperCase() !== "FALSE")
            : !!cond;
          if (truthy) return args.length > 1 ? args[1] : "";
          return args.length > 2 ? args[2] : "";
        }
        case "AND": return shFlat(args, stack).every(v => shToNum(v) !== 0);
        case "OR": return shFlat(args, stack).some(v => shToNum(v) !== 0);
        case "NOT": return shToNum(args[0]) === 0;
        default: throw new Error("#NAME");
      }
    }
    function shEval(expr, stack) {
      let i = 0;
      const S = String(expr);
      const skip = () => { while (i < S.length && /\s/.test(S[i])) i++; };
      function parsePrimary() {
        skip();
        const ch = S[i];
        if (ch === "(") { i++; const v = parseExpr(); skip(); if (S[i] === ")") i++; return v; }
        if (ch === '"' || ch === "'") {
          const q = ch; i++;
          let out = "";
          while (i < S.length && S[i] !== q) out += S[i++];
          i++;
          return out;
        }
        const num = /^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(S.slice(i));
        if (num) { i += num[0].length; return parseFloat(num[0]); }
        const refM = /^\$?[A-Za-z]{1,3}\$?\d+/.exec(S.slice(i));
        if (refM) {
          const a = shRefOf(refM[0]);
          i += refM[0].length;
          skip();
          if (S[i] === ":") {
            i++; skip();
            const m2 = /^\$?[A-Za-z]{1,3}\$?\d+/.exec(S.slice(i));
            if (!m2) throw new Error("#REF");
            const b = shRefOf(m2[0]);
            i += m2[0].length;
            return { __range: true, r1: a.r, c1: a.c, r2: b.r, c2: b.c };
          }
          return shCellValue(a.r, a.c, stack);
        }
        const idM = /^[A-Za-z_\u4e00-\u9fa5][A-Za-z0-9_.\u4e00-\u9fa5]*/.exec(S.slice(i));
        if (idM) {
          const name = idM[0].toUpperCase();
          i += idM[0].length;
          skip();
          if (S[i] === "(") {
            i++;
            const args = [];
            skip();
            if (S[i] === ")") i++;
            else {
              for (;;) {
                args.push(parseExpr());
                skip();
                if (S[i] === ",") { i++; continue; }
                if (S[i] === ")") { i++; break; }
                throw new Error("#ERR");
              }
            }
            return shFn(name, args, stack);
          }
          throw new Error("#NAME");
        }
        throw new Error("#ERR");
      }
      function parseUnary() {
        skip();
        if (S[i] === "-") { i++; return -shToNum(parseUnary()); }
        if (S[i] === "+") { i++; return parseUnary(); }
        return parsePrimary();
      }
      function parsePow() {
        let v = parseUnary();
        for (;;) {
          skip();
          if (S[i] === "^") { i++; v = Math.pow(shToNum(v), shToNum(parseUnary())); continue; }
          break;
        }
        return v;
      }
      function parseMul() {
        let v = parsePow();
        for (;;) {
          skip();
          const ch = S[i];
          if (ch === "*") { i++; v = shToNum(v) * shToNum(parsePow()); }
          else if (ch === "/") { i++; const d = shToNum(parsePow()); v = d === 0 ? NaN : shToNum(v) / d; }
          else if (ch === "%") { i++; v = shToNum(v) / 100; }
          else break;
        }
        return v;
      }
      function parseAdd() {
        let v = parseMul();
        for (;;) {
          skip();
          const ch = S[i];
          if (ch === "+") { i++; v = shToNum(v) + shToNum(parseMul()); }
          else if (ch === "-") { i++; v = shToNum(v) - shToNum(parseMul()); }
          else break;
        }
        return v;
      }
      function cmp(op, a, b) {
        const x = typeof a === "number" ? a : String(a);
        const y = typeof b === "number" ? b : String(b);
        if (op === "=") return x === y;
        if (op === "<>") return x !== y;
        if (op === ">") return x > y;
        if (op === "<") return x < y;
        if (op === ">=") return x >= y;
        return x <= y;
      }
      function parseExpr() {
        let v = parseAdd();
        for (;;) {
          skip();
          const two = S.substr(i, 2);
          if (two === "<=" || two === ">=" || two === "<>") { i += 2; v = cmp(two, v, parseAdd()); continue; }
          const ch = S[i];
          if (ch === "&") { i++; v = String(v) + String(parseAdd()); continue; }
          if (ch === "=" || ch === "<" || ch === ">") { i++; v = cmp(ch, v, parseAdd()); continue; }
          return v;
        }
      }
      const out = parseExpr();
      skip();
      if (i < S.length) throw new Error("#ERR");
      return out;
    }

    /* 合并区域 → 渲染用的 {skip, span}：skip 是被覆盖的格子，span 是左上角格子的行列跨度 */
    function mergeMaps() {
      const skip = new Set(), span = new Map();
      (st.merges || []).forEach(m => {
        if (!Array.isArray(m) || m.length < 4) return;
        const r1 = Math.max(0, Math.min(m[0], st.data.length - 1));
        const c1 = Math.max(0, Math.min(m[1], curCols() - 1));
        const r2 = Math.max(r1, Math.min(m[2], st.data.length - 1));
        const c2 = Math.max(c1, Math.min(m[3], curCols() - 1));
        span.set(r1 + "," + c1, { rs: r2 - r1 + 1, cs: c2 - c1 + 1 });
        for (let r = r1; r <= r2; r++) {
          for (let c = c1; c <= c2; c++) if (r !== r1 || c !== c1) skip.add(r + "," + c);
        }
      });
      return { skip, span };
    }

    function renderGrid() {
      const nCols = curCols();
      dispCache = new Map();          // 每次重绘重算公式
      const { skip, span } = mergeMaps();
      let html = '<table class="sheetv-table"><thead><tr><th class="sheetv-corner"></th>';
      for (let c = 0; c < nCols; c++) {
        html += '<th class="sheetv-colhead" data-c="' + c + '">' + _shColName(c) + '</th>';
      }
      html += '</tr></thead><tbody>';
      st.data.forEach((row, r) => {
        html += '<tr><td class="sheetv-rownum" data-r="' + r + '">' + (r + 1) + '</td>';
        for (let c = 0; c < nCols; c++) {
          if (skip.has(r + "," + c)) continue;             // 被合并区域覆盖的格子不渲染
          const rawv = row[c] == null ? "" : row[c];
          const isFx = shIsFormula(rawv);
          const v = isFx ? shDisplay(r, c) : rawv;         // 公式显示计算结果
          const sp = span.get(r + "," + c);
          const attrs = sp ? ' rowspan="' + sp.rs + '" colspan="' + sp.cs + '"' : "";
          const al = (st.aligns || {})[r + "," + c];
          const cls = "sheetv-cell" + (sp ? " merged" : "") + (al ? " ta-" + al : "") + (isFx ? " fx" : "");
          html += '<td class="' + cls + '" data-r="' + r + '" data-c="' + c + '"' + attrs + '>' + _shEsc(v) + '</td>';
        }
        html += '</tr>';
      });
      html += '</tbody></table>';
      grid.innerHTML = html;
      pvNodes = [];                // 重绘后旧的预览节点已随 innerHTML 消失
      editing = null;
      paintSel();
      applyFind();
      syncBtns();
    }

    function cellAt(r, c) { return grid.querySelector('.sheetv-cell[data-r="' + r + '"][data-c="' + c + '"]'); }

    /* 选区高亮：单元格 + 行号列标 */
    function paintSel() {
      grid.querySelectorAll(".sel").forEach(el => el.classList.remove("sel"));
      const s = norm();
      if (!s) return;
      grid.querySelectorAll(".sheetv-cell").forEach(td => {
        const r = +td.dataset.r, c = +td.dataset.c;
        if (r >= s.r1 && r <= s.r2 && c >= s.c1 && c <= s.c2) td.classList.add("sel");
      });
      grid.querySelectorAll(".sheetv-rownum").forEach(td => {
        const r = +td.dataset.r;
        if (r >= s.r1 && r <= s.r2) td.classList.add("sel");
      });
      grid.querySelectorAll(".sheetv-colhead").forEach(th => {
        const c = +th.dataset.c;
        if (c >= s.c1 && c <= s.c2) th.classList.add("sel");
      });
      updateQuick();
      syncFBar();
    }

    /* 公式编辑栏：显示当前单元格坐标与原始内容（公式原文） */
    function cellRefName(r, c) { return _shColName(c) + (r + 1); }
    function syncFBar() {
      if (!fref || !finp) return;
      const s = norm();
      if (!s) { fref.textContent = "—"; finp.value = ""; finp.disabled = true; return; }
      const multi = s.r1 !== s.r2 || s.c1 !== s.c2;
      fref.textContent = multi
        ? cellRefName(s.r1, s.c1) + ":" + cellRefName(s.r2, s.c2)
        : cellRefName(sel.fr, sel.fc);
      finp.disabled = !st.writable || multi;
      // 正在输入框里打字时不要覆盖用户内容（只有非聚焦状态才同步显示）
      if (document.activeElement !== finp) {
        finp.value = multi ? "" : String(shRawAt(sel.fr, sel.fc) == null ? "" : shRawAt(sel.fr, sel.fc));
      }
    }

    /* 多选（超过 1 个单元格）时显示浮动快捷条，只读时禁用写操作 */
    function updateQuick() {
      if (!quick) return;
      const s = norm();
      if (!s) { quick.style.display = "none"; return; }
      const rows = s.r2 - s.r1 + 1, cols = s.c2 - s.c1 + 1;
      if (rows * cols <= 1) { quick.style.display = "none"; return; }
      quick.style.display = "";
      quick.querySelector(".q-info").textContent = "已选 " + rows + " 行 × " + cols + " 列";
      quick.querySelectorAll("button").forEach(b => {
        b.disabled = !st.writable && b.dataset.q !== "copy";
      });
    }
    function setSel(ar, ac, fr, fc) {
      sel = { ar: ar, ac: ac, fr: fr == null ? ar : fr, fc: fc == null ? ac : fc };
      clearTimeout(pvTimer);        // 选区变了，未触发的预览也作废
      pvTimer = 0;
      clearPreview();
      paintSel();
    }

    /* ---------------- 悬停预览：真实插入虚拟行 / 虚拟列 ----------------
       预览用的行、单元格是真的插进去的（视觉最直观）；
       但必须自己登记插入过的节点，清理时逐个移除 —— 不能靠类名查，
       否则多次悬停会残留，出现「一堆幽灵列、列宽全乱」的情况 */
    function clearPreview() {
      pvNodes.forEach(n => { try { n.remove(); } catch (e) { /* 已随整行移除 */ } });
      pvNodes = [];
      grid.querySelectorAll(".pv-del").forEach(el => el.classList.remove("pv-del"));
    }
    function previewInsRow(where) {
      clearPreview();
      const s = norm(); if (!s) return;
      const at = where === "above" ? s.r1 : s.r2 + 1;
      const trs = grid.querySelectorAll("tbody tr");
      const tr = document.createElement("tr");
      tr.className = "pv-row";
      let html = '<td class="sheetv-rownum pv-cell">+</td>';
      for (let c = 0; c < curCols(); c++) html += '<td class="sheetv-cell pv-cell"></td>';
      tr.innerHTML = html;
      if (trs[at]) trs[at].parentNode.insertBefore(tr, trs[at]);
      else if (trs.length) trs[trs.length - 1].parentNode.appendChild(tr);
      else {
        const tb = grid.querySelector("tbody");
        if (tb) tb.appendChild(tr);
      }
      pvNodes.push(tr);                       // 整行移除即带走所有单元格
    }
    function previewDelRow() {
      clearPreview();
      const s = norm(); if (!s) return;
      grid.querySelectorAll(".sheetv-cell").forEach(td => {
        const r = +td.dataset.r;
        if (r >= s.r1 && r <= s.r2) td.classList.add("pv-del");
      });
      grid.querySelectorAll(".sheetv-rownum").forEach(td => {
        const r = +td.dataset.r;
        if (r >= s.r1 && r <= s.r2) td.classList.add("pv-del");
      });
    }
    function previewInsCol(where) {
      clearPreview();
      const s = norm(); if (!s) return;
      const at = where === "left" ? s.c1 : s.c2 + 1;
      grid.querySelectorAll("thead tr, tbody tr").forEach(tr => {
        const head = tr.parentNode.tagName === "THEAD";
        const el = document.createElement(head ? "th" : "td");
        el.className = (head ? "sheetv-colhead" : "sheetv-cell") + " pv-cell";
        if (head) el.textContent = "+";
        tr.insertBefore(el, tr.children[at + 1] || null);
        pvNodes.push(el);
      });
    }
    function previewDelCol() {
      clearPreview();
      const s = norm(); if (!s) return;
      grid.querySelectorAll(".sheetv-cell").forEach(td => {
        const c = +td.dataset.c;
        if (c >= s.c1 && c <= s.c2) td.classList.add("pv-del");
      });
      grid.querySelectorAll(".sheetv-colhead").forEach(th => {
        const c = +th.dataset.c;
        if (c >= s.c1 && c <= s.c2) th.classList.add("pv-del");
      });
    }
    function ensureSel() {
      if (!sel) { toast("请先选择单元格 / 行 / 列", "warn"); return null; }
      return norm();
    }

    /* ---------------- 编辑单元格 ---------------- */
    function commitEdit() {
      if (!editing) return;
      const td = editing;
      const r = +td.dataset.r, c = +td.dataset.c;
      const v = (td.textContent || "").replace(/\u00a0/g, " ").replace(/\r?\n/g, " ");
      td.contentEditable = "false";
      td.classList.remove("editing");
      editing = null;
      if (!st.data[r]) st.data[r] = [];
      if (String(st.data[r][c] == null ? "" : st.data[r][c]) === v) return;
      st.data[r][c] = v;
      tab.sheetChanges[r + "," + c] = v;
      markDirty();
      refreshDisplays();       // 改完立刻刷新显示（公式要显示结果，不重建 DOM）
    }

    /* 原地刷新所有单元格的显示文本：公式显示计算结果，普通格显示原文 */
    function refreshDisplays() {
      dispCache = new Map();
      grid.querySelectorAll(".sheetv-cell").forEach(td => {
        const r = +td.dataset.r, c = +td.dataset.c;
        const rawv = shRawAt(r, c);
        const isFx = shIsFormula(rawv);
        td.textContent = isFx ? shDisplay(r, c) : (rawv == null ? "" : String(rawv));
        td.classList.toggle("fx", isFx);
      });
    }
    function startEdit(td) {
      if (!st.writable) { toast("该格式为只读，无法编辑", "warn"); return; }
      if (editing === td) return;
      commitEdit();
      const r = +td.dataset.r, c = +td.dataset.c;
      setSel(r, c, r, c);
      td.contentEditable = "true";
      td.classList.add("editing");
      td.textContent = String(shRawAt(r, c) == null ? "" : shRawAt(r, c));   // 编辑时显示原文（公式）
      editing = td;
      editSnap = false;
      td.focus();
      const range = document.createRange();
      range.selectNodeContents(td);
      const s = window.getSelection();
      s.removeAllRanges();
      s.addRange(range);
    }

    /* ---------------- 结构操作 ---------------- */
    /* 增删行列后同步调整合并区域：插入时右/下移或拉伸，删除时收缩或丢弃 */
    function shiftMerges(kind, at, n, isDelete) {
      if (!st.merges || !st.merges.length) return;
      const out = [];
      st.merges.forEach(m => {
        let r1 = m[0], c1 = m[1], r2 = m[2], c2 = m[3];
        const isRow = kind === "row";
        let a1 = isRow ? r1 : c1, a2 = isRow ? r2 : c2;
        if (!isDelete) {
          if (a1 >= at) { a1 += n; a2 += n; }
          else if (a2 >= at) a2 += n;            // 跨过插入点 → 拉伸
        } else {
          if (a1 >= at + n) { a1 -= n; a2 -= n; }
          else if (a2 >= at) {                   // 与删除范围相交 → 收缩
            a1 = Math.min(a1, at);
            a2 -= n;
            if (a2 < a1) return;                 // 被删光了
          }
        }
        if (isRow) { r1 = a1; r2 = a2; } else { c1 = a1; c2 = a2; }
        out.push([r1, c1, r2, c2]);
      });
      st.merges = out;
    }
    /* 增删行列后同步搬移对齐标记（被删掉的格子直接丢弃） */
    function shiftAligns(kind, at, n, isDelete) {
      const keys = Object.keys(st.aligns || {});
      if (!keys.length) return;
      const out = {};
      keys.forEach(k => {
        const p = k.split(",");
        let r = +p[0], c = +p[1];
        if (kind === "row") {
          if (!isDelete) { if (r >= at) r += n; }
          else {
            if (r >= at && r < at + n) return;
            if (r >= at + n) r -= n;
          }
        } else {
          if (!isDelete) { if (c >= at) c += n; }
          else {
            if (c >= at && c < at + n) return;
            if (c >= at + n) c -= n;
          }
        }
        out[r + "," + c] = st.aligns[k];
      });
      st.aligns = out;
      st.alignDirty = true;
    }
    function insertRows(n, where) {
      if (!structGuard()) return;
      const s = ensureSel(); if (!s) return;
      const at = where === "above" ? s.r1 : s.r2 + 1;
      const w = curCols();
      pushUndo();
      const rows = [];
      for (let i = 0; i < n; i++) rows.push(new Array(w).fill(""));
      st.data.splice(at, 0, ...rows);
      shiftMerges("row", at, n, false);
      shiftAligns("row", at, n, false);
      st.cols = Math.max(st.cols, w);
      st.struct = true;
      markDirty();
      renderGrid();
      updateMeta();
      setSel(at, 0, at + n - 1, w - 1);
      toast("已插入 " + n + " 行", "ok");
    }
    function insertCols(n, where) {
      if (!structGuard()) return;
      const s = ensureSel(); if (!s) return;
      const at = where === "left" ? s.c1 : s.c2 + 1;
      pushUndo();
      const w = curCols();
      for (let i = 0; i < st.data.length; i++) {
        const row = st.data[i];
        while (row.length < w) row.push("");
        row.splice(at, 0, ...new Array(n).fill(""));
      }
      shiftMerges("col", at, n, false);
      shiftAligns("col", at, n, false);
      st.cols = w + n;
      st.struct = true;
      markDirty();
      renderGrid();
      updateMeta();
      setSel(0, at, Math.max(st.data.length - 1, 0), at + n - 1);
      toast("已插入 " + n + " 列", "ok");
    }
    function deleteRows() {
      if (!structGuard()) return;
      const s = ensureSel(); if (!s) return;
      const n = s.r2 - s.r1 + 1;
      if (n >= st.data.length) { toast("至少要保留一行", "warn"); return; }
      pushUndo();
      st.data.splice(s.r1, n);
      shiftMerges("row", s.r1, n, true);
      shiftAligns("row", s.r1, n, true);
      st.struct = true;
      markDirty();
      renderGrid();
      updateMeta();
      const at = Math.min(s.r1, st.data.length - 1);
      setSel(at, s.c1, at, s.c2);
      toast("已删除 " + n + " 行", "ok");
    }
    function deleteCols() {
      if (!structGuard()) return;
      const s = ensureSel(); if (!s) return;
      const n = s.c2 - s.c1 + 1;
      if (n >= curCols()) { toast("至少要保留一列", "warn"); return; }
      pushUndo();
      st.data.forEach(row => {
        while (row.length < curCols()) row.push("");
        row.splice(s.c1, n);
      });
      shiftMerges("col", s.c1, n, true);
      shiftAligns("col", s.c1, n, true);
      st.cols = Math.max(curCols() - n, 1);
      st.struct = true;
      markDirty();
      renderGrid();
      updateMeta();
      const at = Math.min(s.c1, curCols() - 1);
      setSel(s.r1, at, s.r2, at);
      toast("已删除 " + n + " 列", "ok");
    }
    function clearSel() {
      if (!st.writable) { toast("该格式为只读", "warn"); return; }
      const s = ensureSel(); if (!s) return;
      pushUndo();
      for (let r = s.r1; r <= s.r2; r++) {
        for (let c = s.c1; c <= s.c2; c++) {
          if (!st.data[r]) st.data[r] = [];
          st.data[r][c] = "";
          tab.sheetChanges[r + "," + c] = "";
        }
      }
      markDirty();
      renderGrid();
    }

    /* ---------------- 合并单元格 / 取消合并 ---------------- */
    function mergeSel() {
      if (!st.writable) { toast("该格式为只读", "warn"); return; }
      const s = ensureSel(); if (!s) return;
      if (s.r1 === s.r2 && s.c1 === s.c2) { toast("请先选中至少两个单元格", "warn"); return; }
      // 与已有合并区域相交时不允许合并（否则 rowspan/colspan 会重叠错乱）
      const overlap = (st.merges || []).some(m =>
        !(m[2] < s.r1 || m[0] > s.r2 || m[3] < s.c1 || m[1] > s.c2));
      if (overlap) { toast("选区与已合并区域重叠，请先取消合并", "warn"); return; }
      pushUndo();
      // 非空内容用空格拼到左上角，避免合并时丢数据
      const vals = [];
      for (let r = s.r1; r <= s.r2; r++) {
        if (!st.data[r]) st.data[r] = [];
        for (let c = s.c1; c <= s.c2; c++) {
          const v = st.data[r][c];
          if (v != null && String(v).trim() !== "") vals.push(String(v).trim());
          st.data[r][c] = "";
        }
      }
      st.data[s.r1][s.c1] = vals.join(" ");
      st.merges = (st.merges || []).concat([[s.r1, s.c1, s.r2, s.c2]]);
      st.struct = true;              // 合并信息需要整表回写（xlsx）
      markDirty();
      renderGrid();
      updateMeta();
      setSel(s.r1, s.c1, s.r1, s.c1);
      toast(vals.length > 1
        ? "已合并 " + (s.r2 - s.r1 + 1) + " 行 × " + (s.c2 - s.c1 + 1) + " 列（原内容已用空格拼接）"
        : "已合并 " + (s.r2 - s.r1 + 1) + " 行 × " + (s.c2 - s.c1 + 1) + " 列", "ok");
    }
    function unmergeSel() {
      if (!st.writable) { toast("该格式为只读", "warn"); return; }
      const s = ensureSel(); if (!s) return;
      const keep = (st.merges || []).filter(m =>
        m[2] < s.r1 || m[0] > s.r2 || m[3] < s.c1 || m[1] > s.c2);
      if (keep.length === (st.merges || []).length) { toast("选区里没有合并单元格", "warn"); return; }
      pushUndo();
      st.merges = keep;
      st.struct = true;
      markDirty();
      renderGrid();
      updateMeta();
      toast("已取消合并", "ok");
    }

    /* ---------------- 对齐（左 / 居中 / 右 / 清除） ---------------- */
    function applyAlign(kind) {
      if (!st.writable) { toast("该格式为只读", "warn"); return; }
      const s = ensureSel(); if (!s) return;
      pushUndo();
      for (let r = s.r1; r <= s.r2; r++) {
        for (let c = s.c1; c <= s.c2; c++) {
          const k = r + "," + c;
          if (kind === "reset") delete st.aligns[k];
          else st.aligns[k] = kind;
        }
      }
      st.alignDirty = true;
      markDirty();
      renderGrid();
      toast(kind === "reset" ? "已清除对齐"
        : "已设为" + ({ left: "左对齐", center: "居中", right: "右对齐" }[kind] || kind), "ok");
    }

    /* ---------------- 填充（公式按相对引用自动平移） ---------------- */
    /* C2 向下填一行 → C3；$C$2 保持不动；字符串里的 "A1" 不会被改 */
    function shiftRefs(f, dr, dc) {
      if (!f || (!dr && !dc) || !shIsFormula(f)) return f;
      const parts = String(f).split(/("[^"]*"|'[^']*')/);
      return parts.map((p, i) => {
        if (i % 2) return p;                       // 引号内的文本原样保留
        // 用「前一个字符」的方式避开后行断言，兼容老浏览器
        return p.replace(/(^|[^A-Za-z0-9_])(\$?)([A-Za-z]{1,3})(\$?)(\d+)(?![\w(])/g,
          (m, pre, cAbs, letters, rAbs, digits) => {
            let col = 0;
            for (const ch of letters.toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
            let row = parseInt(digits, 10);
            if (!cAbs) col += dc;
            if (!rAbs) row += dr;
            if (col < 1 || row < 1) return pre + "#REF!";
            return pre + (cAbs ? "$" : "") + _shColName(col - 1) + (rAbs ? "$" : "") + row;
          });
      }).join("");
    }
    function fillRange(kind) {
      if (!st.writable) { toast("该格式为只读", "warn"); return; }
      const s = ensureSel(); if (!s) return;
      if (kind === "down" && s.r1 === s.r2) { toast("先选中要填充的范围（第一行作为源）", "warn"); return; }
      if (kind === "right" && s.c1 === s.c2) { toast("先选中要填充的范围（第一列作为源）", "warn"); return; }
      pushUndo();
      if (kind === "down") {
        for (let r = s.r1 + 1; r <= s.r2; r++) {
          for (let c = s.c1; c <= s.c2; c++) {
            if (!st.data[r]) st.data[r] = [];
            const src = shRawAt(s.r1, c);
            st.data[r][c] = shiftRefs(src, r - s.r1, 0);
            tab.sheetChanges[r + "," + c] = st.data[r][c];
          }
        }
      } else {
        for (let c = s.c1 + 1; c <= s.c2; c++) {
          for (let r = s.r1; r <= s.r2; r++) {
            if (!st.data[r]) st.data[r] = [];
            const src = shRawAt(r, s.c1);
            st.data[r][c] = shiftRefs(src, 0, c - s.c1);
            tab.sheetChanges[r + "," + c] = st.data[r][c];
          }
        }
      }
      markDirty();
      renderGrid();
      toast(kind === "down" ? "已向下填充" : "已向右填充", "ok");
    }

    /* 一键填充整列 / 整行：以选区首行（首列）为源，铺到表格最后一行（最后一列） */
    function fillColumnAll() {
      if (!st.writable) { toast("该格式为只读", "warn"); return; }
      const s = ensureSel(); if (!s) return;
      const lastRow = st.data.length - 1;
      if (lastRow <= s.r1) { toast("下方没有更多行了", "warn"); return; }
      pushUndo();
      for (let r = s.r1 + 1; r <= lastRow; r++) {
        if (!st.data[r]) st.data[r] = [];
        for (let c = s.c1; c <= s.c2; c++) {
          const v = shiftRefs(shRawAt(s.r1, c), r - s.r1, 0);
          st.data[r][c] = v;
          tab.sheetChanges[r + "," + c] = v;
        }
      }
      markDirty();
      renderGrid();
      setSel(s.r1, s.c1, lastRow, s.c2);
      toast("已填充整列（" + (lastRow - s.r1) + " 行）", "ok");
    }
    function fillRowAll() {
      if (!st.writable) { toast("该格式为只读", "warn"); return; }
      const s = ensureSel(); if (!s) return;
      const lastCol = curCols() - 1;
      if (lastCol <= s.c1) { toast("右侧没有更多列了", "warn"); return; }
      pushUndo();
      for (let r = s.r1; r <= s.r2; r++) {
        if (!st.data[r]) st.data[r] = [];
        while (st.data[r].length <= lastCol) st.data[r].push("");
        for (let c = s.c1 + 1; c <= lastCol; c++) {
          const v = shiftRefs(shRawAt(r, s.c1), 0, c - s.c1);
          st.data[r][c] = v;
          tab.sheetChanges[r + "," + c] = v;
        }
      }
      st.cols = Math.max(st.cols, lastCol + 1);
      markDirty();
      renderGrid();
      setSel(s.r1, s.c1, s.r2, lastCol);
      toast("已填充整行（" + (lastCol - s.c1) + " 列）", "ok");
    }

    /* ---------------- 复制 / 粘贴（TSV） ---------------- */
    function selText() {
      const s = norm(); if (!s) return "";
      const lines = [];
      for (let r = s.r1; r <= s.r2; r++) {
        const cells = [];
        for (let c = s.c1; c <= s.c2; c++) cells.push(st.data[r] && st.data[r][c] != null ? st.data[r][c] : "");
        lines.push(cells.join("\t"));
      }
      return lines.join("\n");
    }
    // 记住复制源：粘贴时按「目标 - 源」的偏移平移公式里的相对引用（同 Excel）
    let copyFrom = null, clipSig = "";
    function doCopy() {
      const txt = selText();
      if (!txt) { toast("没有可复制的内容", "warn"); return; }
      const s = norm();
      copyFrom = s ? { r1: s.r1, c1: s.c1, r2: s.r2, c2: s.c2 } : null;
      clipSig = txt;
      if (typeof copyText === "function") { copyText(txt); return; }
      navigator.clipboard.writeText(txt).then(
        () => toast("已复制选中区域", "ok"),
        () => toast("复制失败，请用浏览器快捷键", "err"));
    }
    async function doPaste() {
      if (!structGuard()) return;
      let txt = "";
      try {
        txt = await navigator.clipboard.readText();
      } catch (e) {
        toast("浏览器不允许读取剪贴板，可双击单元格后用 Ctrl+V 粘贴", "warn");
        return;
      }
      if (!txt) { toast("剪贴板为空", "warn"); return; }
      const s = norm() || { r1: 0, c1: 0, r2: 0, c2: 0 };
      const rows = txt.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n").map(l => l.split("\t"));
      pushUndo();
      // 内容是我们自己复制的 → 按「目标 - 源」偏移平移相对引用；外部复制的不动
      const fromSelf = !!(copyFrom && txt === clipSig);
      const baseR = fromSelf ? copyFrom.r1 : s.r1;
      const baseC = fromSelf ? copyFrom.c1 : s.c1;
      // 剪贴板只有一个单元格、而选区是多格 → 按 Excel 规则平铺填充
      const single = rows.length === 1 && rows[0].length === 1;
      if (single && (s.r2 > s.r1 || s.c2 > s.c1)) {
        const src = rows[0][0];
        for (let r = s.r1; r <= s.r2; r++) {
          if (!st.data[r]) st.data[r] = [];
          for (let c = s.c1; c <= s.c2; c++) {
            while (st.data[r].length <= c) st.data[r].push("");
            const v = shiftRefs(src, r - baseR, c - baseC);
            st.data[r][c] = v;
            tab.sheetChanges[r + "," + c] = v;
          }
        }
        st.cols = Math.max(st.cols, s.c2 + 1);
        markDirty();
        renderGrid();
        updateMeta();
        toast("已填充 " + (s.r2 - s.r1 + 1) + " 行 × " + (s.c2 - s.c1 + 1) + " 列", "ok");
        return;
      }
      const needRows = s.r1 + rows.length, needCols = s.c1 + Math.max(...rows.map(r => r.length));
      while (st.data.length < needRows) st.data.push([]);
      st.data.forEach(row => { while (row.length < needCols) row.push(""); });
      // 整块粘贴：整体按偏移平移公式引用（如 G3 的 =C2*2 粘到 G4 → =C3*2）
      const offR = s.r1 - baseR, offC = s.c1 - baseC;
      rows.forEach((line, i) => line.forEach((v0, j) => {
        const v = shiftRefs(v0, offR, offC);
        st.data[s.r1 + i][s.c1 + j] = v;
        tab.sheetChanges[(s.r1 + i) + "," + (s.c1 + j)] = v;
      }));
      st.cols = Math.max(st.cols, needCols);
      markDirty();
      renderGrid();
      updateMeta();
      setSel(s.r1, s.c1, s.r1 + rows.length - 1, s.c1 + Math.max(...rows.map(r => r.length)) - 1);
      toast("已粘贴 " + rows.length + " 行", "ok");
    }

    /* ---------------- 查找 ---------------- */
    function applyFind() {
      const q = (findEl.value || "").trim().toLowerCase();
      grid.querySelectorAll(".sheetv-cell.hit").forEach(td => td.classList.remove("hit"));
      if (!q) return;
      grid.querySelectorAll(".sheetv-cell").forEach(td => {
        if ((td.textContent || "").toLowerCase().includes(q)) td.classList.add("hit");
      });
    }
    function findNext() {
      const hits = [...grid.querySelectorAll(".sheetv-cell.hit")];
      if (!hits.length) { toast("没有匹配项", "warn"); return; }
      const s = norm();
      const after = hits.find(td => {
        const r = +td.dataset.r, c = +td.dataset.c;
        return !s || r > s.r2 || (r === s.r2 && c > s.c2);
      }) || hits[0];
      setSel(+after.dataset.r, +after.dataset.c, +after.dataset.r, +after.dataset.c);
      after.scrollIntoView({ block: "center", inline: "center" });
    }

    /* ---------------- 右键菜单 ---------------- */
    function showCtx(x, y) {
      let menu = document.getElementById("sheetvCtx");
      if (!menu) {
        menu = document.createElement("div");
        menu.id = "sheetvCtx";
        menu.className = "sheetv-ctx";
        document.body.appendChild(menu);
        document.addEventListener("click", () => { menu.style.display = "none"; clearPreview(); });
        window.addEventListener("resize", () => { menu.style.display = "none"; clearPreview(); });
      }
      const ro = !st.writable;
      // pv：鼠标停在该项上时，在表格里预览效果（虚拟新行/新列、待删除高亮）
      const items = [
        { t: "复制", k: "Ctrl+C", a: doCopy, ic: "bi-files" },
        { t: "粘贴", k: "Ctrl+V", a: doPaste, ic: "bi-clipboard", dis: ro },
        { sp: true },
        { t: "在上方插入行", a: () => insertRows(1, "above"), ic: "bi-plus-square", dis: ro, pv: () => previewInsRow("above") },
        { t: "在下方插入行", a: () => insertRows(1, "below"), ic: "bi-plus-square", dis: ro, pv: () => previewInsRow("below") },
        { t: "删除选中行", a: deleteRows, ic: "bi-dash-square", dis: ro, pv: previewDelRow },
        { sp: true },
        { t: "在左侧插入列", a: () => insertCols(1, "left"), ic: "bi-plus-square-dotted", dis: ro, pv: () => previewInsCol("left") },
        { t: "在右侧插入列", a: () => insertCols(1, "right"), ic: "bi-plus-square-dotted", dis: ro, pv: () => previewInsCol("right") },
        { t: "删除选中列", a: deleteCols, ic: "bi-dash-square-dotted", dis: ro, pv: previewDelCol },
        { sp: true },
        { t: "向下填充", k: "Ctrl+D", a: () => fillRange("down"), ic: "bi-arrow-down-square", dis: ro },
        { t: "向右填充", k: "Ctrl+R", a: () => fillRange("right"), ic: "bi-arrow-right-square", dis: ro },
        { t: "填充整列（到表格末尾）", a: fillColumnAll, ic: "bi-arrow-bar-down", dis: ro },
        { t: "填充整行（到表格末尾）", a: fillRowAll, ic: "bi-arrow-bar-right", dis: ro },
        { sp: true },
        { t: "合并单元格", a: mergeSel, ic: "bi-bounding-box", dis: ro },
        { t: "取消合并", a: unmergeSel, ic: "bi-bounding-box-circles", dis: ro },
        { t: "左对齐", a: () => applyAlign("left"), ic: "bi-text-left", dis: ro },
        { t: "居中", a: () => applyAlign("center"), ic: "bi-text-center", dis: ro },
        { t: "右对齐", a: () => applyAlign("right"), ic: "bi-text-right", dis: ro },
        { t: "清除对齐", a: () => applyAlign("reset"), ic: "bi-dash-circle", dis: ro },
        { sp: true },
        { t: "清空内容", k: "Delete", a: clearSel, ic: "bi-eraser", dis: ro },
      ];
      menu.innerHTML = items.map(it => it.sp
        ? '<div class="sp"></div>'
        : '<div class="it' + (it.dis ? " dis" : "") + '" data-i="' + items.indexOf(it) + '">' +
          '<span><i class="bi ' + it.ic + '"></i> ' + it.t + '</span>' +
          (it.k ? '<span class="k">' + it.k + '</span>' : '') + '</div>').join("");
      menu.querySelectorAll(".it").forEach(el => {
        const it = items[+el.dataset.i] || {};
        el.onclick = (e) => {
          e.stopPropagation();
          menu.style.display = "none";
          clearPreview();
          if (it.a) it.a();
        };
        // 悬停菜单项 → 表格里同步预览（鼠标移出该项即清除）
        if (it.pv && !it.dis) {
          el.addEventListener("mouseenter", it.pv);
          el.addEventListener("mouseleave", clearPreview);
        }
      });
      menu.style.display = "block";
      const pw = menu.offsetWidth, ph = menu.offsetHeight;
      menu.style.left = Math.max(6, Math.min(x, window.innerWidth - pw - 8)) + "px";
      menu.style.top = Math.max(6, Math.min(y, window.innerHeight - ph - 8)) + "px";
    }

    /* 插入方向菜单：工具栏「插入行 / 插入列」右侧的小箭头，用来选上方/下方、左侧/右侧 */
    function showInsertMenu(anchor, kind) {
      let menu = document.getElementById("sheetvInsMenu");
      if (!menu) {
        menu = document.createElement("div");
        menu.id = "sheetvInsMenu";
        menu.className = "sheetv-ctx";
        document.body.appendChild(menu);
        document.addEventListener("click", () => { menu.style.display = "none"; clearPreview(); });
      }
      const rowItems = [
        { t: "在上方插入行", pv: () => previewInsRow("above"), a: () => insertRows(1, "above") },
        { t: "在下方插入行", pv: () => previewInsRow("below"), a: () => insertRows(1, "below") },
      ];
      const colItems = [
        { t: "在左侧插入列", pv: () => previewInsCol("left"), a: () => insertCols(1, "left") },
        { t: "在右侧插入列", pv: () => previewInsCol("right"), a: () => insertCols(1, "right") },
      ];
      const items = kind === "row" ? rowItems : colItems;
      const icon = kind === "row" ? "bi-plus-square" : "bi-plus-square-dotted";
      menu.innerHTML = items.map((it, i) =>
        '<div class="it" data-i="' + i + '"><span><i class="bi ' + icon + '"></i> ' + it.t + '</span></div>').join("");
      menu.querySelectorAll(".it").forEach(el => {
        const it = items[+el.dataset.i];
        el.onclick = (e) => {
          e.stopPropagation();
          menu.style.display = "none";
          clearPreview();
          it.a();
        };
        el.addEventListener("mouseenter", it.pv);      // 悬停即预览
        el.addEventListener("mouseleave", clearPreview);
      });
      menu.style.display = "block";
      const r = anchor.getBoundingClientRect();
      const pw = menu.offsetWidth, ph = menu.offsetHeight;
      menu.style.left = Math.max(6, Math.min(r.left, window.innerWidth - pw - 8)) + "px";
      menu.style.top = (r.bottom + 4 + ph > window.innerHeight - 8 ? r.top - ph - 4 : r.bottom + 4) + "px";
    }

    /* ---------------- 事件绑定 ---------------- */
    grid.addEventListener("mousedown", (e) => {
      const rh = e.target.closest(".sheetv-rownum");
      const ch = e.target.closest(".sheetv-colhead");
      const corner = e.target.closest(".sheetv-corner");
      if (corner) {
        setSel(0, 0, Math.max(st.data.length - 1, 0), curCols() - 1);
        grid.focus();
        e.preventDefault();
        return;
      }
      if (rh) {
        commitEdit();
        const r = +rh.dataset.r;
        if (e.shiftKey && sel) setSel(sel.ar, 0, r, curCols() - 1);
        else setSel(r, 0, r, curCols() - 1);
        startDrag("row", { r: e.shiftKey && sel ? sel.ar : r, c: 0 });
        grid.focus();
        e.preventDefault();
        return;
      }
      if (ch) {
        commitEdit();
        const c = +ch.dataset.c;
        if (e.shiftKey && sel) setSel(0, sel.ac, Math.max(st.data.length - 1, 0), c);
        else setSel(0, c, Math.max(st.data.length - 1, 0), c);
        startDrag("col", { r: 0, c: e.shiftKey && sel ? sel.ac : c });
        grid.focus();
        e.preventDefault();
        return;
      }
      const td = e.target.closest(".sheetv-cell");
      if (td && td !== editing) {
        commitEdit();
        const r = +td.dataset.r, c = +td.dataset.c;
        if (e.shiftKey && sel) setSel(sel.ar, sel.ac, r, c);
        else setSel(r, c, r, c);
        if (e.button === 0) startDrag("cell", { r: e.shiftKey && sel ? sel.ar : r, c: e.shiftKey && sel ? sel.ac : c });
        grid.focus();
        if (e.button !== 2) e.preventDefault();     // 右键保留原样，便于弹菜单
        // preventDefault 后浏览器仍可能吞掉 dblclick，这里按点击次数兜底进入编辑
        if (e.detail >= 2 && e.button === 0) startEdit(td);
      }
    });

    grid.addEventListener("dblclick", (e) => {
      const td = e.target.closest(".sheetv-cell");
      if (td) startEdit(td);
    });

    /* ---------------- 按住拖动框选（单元格 / 整行 / 整列） ---------------- */
    function startDrag(kind, anchor) {
      dragging = true;
      dragKind = kind;
      dragAnchor = anchor;
      document.body.classList.add("sheet-drag");
    }
    function dragMove(e) {
      if (!dragging) return;
      if (!grid.isConnected) { endDrag(); return; }
      // 贴近表格边缘时自动滚动，方便拖出可视区域
      const rect = grid.getBoundingClientRect(), EDGE = 26, STEP = 16;
      if (e.clientY > rect.bottom - EDGE) grid.scrollTop += STEP;
      else if (e.clientY < rect.top + EDGE) grid.scrollTop -= STEP;
      if (e.clientX > rect.right - EDGE) grid.scrollLeft += STEP;
      else if (e.clientX < rect.left + EDGE) grid.scrollLeft -= STEP;
      if (dragRaf) return;
      dragRaf = requestAnimationFrame(() => {
        dragRaf = 0;
        if (!dragging) return;
        const el = document.elementFromPoint(e.clientX, e.clientY);
        if (!el || !el.closest) return;
        if (dragKind === "row") {
          const rh = el.closest(".sheetv-rownum");
          if (rh) setSel(dragAnchor.r, 0, +rh.dataset.r, curCols() - 1);
        } else if (dragKind === "col") {
          const ch = el.closest(".sheetv-colhead");
          if (ch) setSel(0, dragAnchor.c, Math.max(st.data.length - 1, 0), +ch.dataset.c);
        } else {
          const td = el.closest(".sheetv-cell");
          if (td) setSel(dragAnchor.r, dragAnchor.c, +td.dataset.r, +td.dataset.c);
        }
      });
    }
    function endDrag() {
      if (!dragging) return;
      dragging = false;
      dragKind = "";
      dragAnchor = null;
      if (dragRaf) { cancelAnimationFrame(dragRaf); dragRaf = 0; }
      document.body.classList.remove("sheet-drag");
    }
    document.addEventListener("mousemove", dragMove);
    document.addEventListener("mouseup", endDrag);
    window.addEventListener("blur", endDrag);      // 切走窗口时收尾，避免一直处于拖选状态

    grid.addEventListener("focusout", (e) => {
      if (editing && e.target === editing) commitEdit();
    });

    grid.addEventListener("input", () => {
      if (editing && !editSnap) { editSnap = true; pushUndo(); }
    });

    grid.addEventListener("contextmenu", (e) => {
      const cell = e.target.closest(".sheetv-cell");
      const rh = e.target.closest(".sheetv-rownum");
      const ch = e.target.closest(".sheetv-colhead");
      if (!cell && !rh && !ch) return;
      // 必须拦住冒泡：否则编辑器区域会再弹出「查找所有引用 / 复制路径」等通用右键菜单
      e.preventDefault();
      e.stopPropagation();
      commitEdit();
      // 右键落在已有选区之外 → 先切换成该单元格 / 整行 / 整列，再弹菜单
      const s = norm();
      if (cell) {
        const r = +cell.dataset.r, c = +cell.dataset.c;
        if (!s || r < s.r1 || r > s.r2 || c < s.c1 || c > s.c2) setSel(r, c, r, c);
      } else if (rh) {
        const r = +rh.dataset.r;
        if (!s || r < s.r1 || r > s.r2 || s.c2 !== curCols() - 1) setSel(r, 0, r, curCols() - 1);
      } else {
        const c = +ch.dataset.c;
        if (!s || c < s.c1 || c > s.c2 || s.r2 !== st.data.length - 1) setSel(0, c, Math.max(st.data.length - 1, 0), c);
      }
      grid.focus();
      showCtx(e.clientX, e.clientY);
    });

    grid.addEventListener("keydown", (e) => {
      if (editing) return;                        // 编辑中交给原生（含单格退格/删除）
      const k = e.key, mod = e.ctrlKey || e.metaKey;
      if (mod && (k === "c" || k === "C")) { e.preventDefault(); doCopy(); return; }
      if (mod && (k === "v" || k === "V")) { e.preventDefault(); doPaste(); return; }
      if (mod && (k === "z" || k === "Z")) { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); return; }
      if (mod && (k === "y" || k === "Y")) { e.preventDefault(); doRedo(); return; }
      if (mod && (k === "d" || k === "D")) { e.preventDefault(); fillRange("down"); return; }
      if (mod && (k === "r" || k === "R")) { e.preventDefault(); fillRange("right"); return; }
      if (k === "Delete" || k === "Backspace") { e.preventDefault(); clearSel(); return; }
      const s = norm();
      if (!s) return;
      if (k === "Enter" || k === "F2") { e.preventDefault(); const td0 = cellAt(sel.fr, sel.fc); if (td0) startEdit(td0); return; }
      let r = sel.fr, c = sel.fc;
      if (k === "ArrowUp") r = Math.max(0, r - 1);
      else if (k === "ArrowDown") r = Math.min(st.data.length - 1, r + 1);
      else if (k === "ArrowLeft") c = Math.max(0, c - 1);
      else if (k === "ArrowRight") c = Math.min(curCols() - 1, c + 1);
      else if (k === "Tab") c = Math.min(curCols() - 1, c + (e.shiftKey ? -1 : 1));
      else return;
      e.preventDefault();
      setSel(r, c, r, c);
      const td = cellAt(r, c);
      if (td) td.scrollIntoView({ block: "nearest", inline: "nearest" });
    });

    findEl.addEventListener("input", applyFind);
    findEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); findNext(); }
      if (e.key === "Escape") { findEl.value = ""; applyFind(); }
    });

    /* 公式栏输入：写回「打开输入框时的那一格」，而不是当前选区
       （否则点到别的单元格后回车，会把那一格的数据覆盖掉） */
    let fbarCell = null;
    function commitFBar() {
      if (!fbarCell) return null;
      const { r, c } = fbarCell;
      const val = finp.value;
      const cell = fbarCell;
      fbarCell = null;
      if (!st.writable) return cell;
      if (!st.data[r]) st.data[r] = [];
      if (String(st.data[r][c] == null ? "" : st.data[r][c]) !== val) {
        pushUndo();
        st.data[r][c] = val;
        markDirty();
        refreshDisplays();      // 只刷新文本，不重建 DOM（避免打断点击流程）
      }
      return cell;
    }
    finp.addEventListener("focus", () => {
      if (!st.writable || !sel) return;
      const s = norm();
      if (s && (s.r1 !== s.r2 || s.c1 !== s.c2)) return;     // 多选时不允许从公式栏编辑
      fbarCell = { r: sel.fr, c: sel.fc };
    });
    finp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const cell = commitFBar() || { r: sel ? sel.fr : 0, c: sel ? sel.fc : 0 };
        syncFBar();
        const nr = Math.min(cell.r + 1, Math.max(st.data.length - 1, 0));
        setSel(nr, cell.c, nr, cell.c);
        grid.focus();
      } else if (e.key === "Escape") {
        fbarCell = null;
        syncFBar();
        grid.focus();
      }
    });
    finp.addEventListener("blur", () => {
      if (fbarCell) commitFBar();      // 点到别处也算提交，不丢输入
      syncFBar();
    });

    host.querySelectorAll(".sheetv-btn").forEach(b => {
      b.addEventListener("click", (e) => {
        const a = b.dataset.a;
        if (a === "undo") doUndo();
        else if (a === "redo") doRedo();
        else if (a === "row-above") insertRows(1, "above");
        else if (a === "row-menu") { e.stopPropagation(); showInsertMenu(b, "row"); }
        else if (a === "row-del") deleteRows();
        else if (a === "col-left") insertCols(1, "left");
        else if (a === "col-menu") { e.stopPropagation(); showInsertMenu(b, "col"); }
        else if (a === "col-del") deleteCols();
        else if (a === "merge") mergeSel();
        else if (a === "unmerge") unmergeSel();
        else if (a === "align-left") applyAlign("left");
        else if (a === "align-center") applyAlign("center");
        else if (a === "align-right") applyAlign("right");
        else if (a === "align-reset") applyAlign("reset");
        else if (a === "fill-down") fillRange("down");
        else if (a === "fill-right") fillRange("right");
        else if (a === "fill-col") fillColumnAll();
        else if (a === "clear") clearSel();
      });
    });

    // 浮动快捷条上的按钮（多选时出现）
    if (quick) {
      quick.querySelectorAll("button").forEach(b => {
        b.addEventListener("click", () => {
          const q = b.dataset.q;
          if (q === "copy") doCopy();
          else if (q === "paste") doPaste();
          else if (q === "clear") clearSel();
          else if (q === "row-del") deleteRows();
          else if (q === "col-del") deleteCols();
        });
      });
    }

    /* 悬停行列按钮时预览效果（虚拟新行/新列、待删除高亮）。
       必须「停留」才显示：鼠标只是扫过工具栏时不弹预览，避免一闪一闪 */
    const PV_DELAY = 350;
    function pvEnter(fn) {
      clearTimeout(pvTimer);
      pvTimer = setTimeout(() => { pvTimer = 0; fn(); }, PV_DELAY);
    }
    function pvLeave() {
      clearTimeout(pvTimer);
      pvTimer = 0;
      clearPreview();
    }
    const pvMap = {
      "row-above": () => previewInsRow("above"),
      "row-del": previewDelRow,
      "col-left": () => previewInsCol("left"),
      "col-del": previewDelCol,
    };
    host.querySelectorAll(".sheetv-btn[data-a]").forEach(b => {
      const fn = pvMap[b.dataset.a];
      if (!fn) return;
      b.addEventListener("mouseenter", () => pvEnter(fn));
      b.addEventListener("mouseleave", pvLeave);
      b.addEventListener("click", pvLeave);
    });
    if (quick) {
      quick.querySelectorAll("button[data-q]").forEach(b => {
        const q = b.dataset.q;
        const fn = q === "row-del" ? previewDelRow : q === "col-del" ? previewDelCol : null;
        if (!fn) return;
        b.addEventListener("mouseenter", () => pvEnter(fn));
        b.addEventListener("mouseleave", pvLeave);
        b.addEventListener("click", pvLeave);
      });
    }

    /* ---------------- 载入 ---------------- */
    function load(sheetName) {
      grid.innerHTML = '<div class="sheetv-empty">加载中…</div>';
      const url = "/api/sheet/read?path=" + encodeURIComponent(path) +
        (sheetName ? "&sheet=" + encodeURIComponent(sheetName) : "");
      fetch(url).then(r => r.json()).then(d => {
        if (!d.ok) { grid.innerHTML = '<div class="sheetv-err">' + _shEsc(d.error || "读取失败") + '</div>'; return; }
        st.active = d.active;
        st.writable = !!d.writable;
        st.isCsv = !!d.is_csv;
        st.ext = d.ext;
        st.data = d.data || [];
        st.cols = d.cols || 0;
        st.truncated = !!d.truncated;
        st.struct = false;
        st.merges = Array.isArray(d.merges) ? d.merges.map(m => m.slice()) : [];
        st.aligns = {};
        (Array.isArray(d.aligns) ? d.aligns : []).forEach(a => {
          if (Array.isArray(a) && a.length >= 3) st.aligns[a[0] + "," + a[1]] = a[2];
        });
        st.alignDirty = false;
        // xlsx 的公式原文（读取时只给了缓存值，这里用公式文本覆盖，前端重新计算）
        (Array.isArray(d.formulas) ? d.formulas : []).forEach(f => {
          if (!Array.isArray(f) || f.length < 3) return;
          const r = f[0], c = f[1];
          while (st.data.length <= r) st.data.push([]);
          while (st.data[r].length <= c) st.data[r].push("");
          st.data[r][c] = f[2];
        });
        st.orig = st.data.map(r => r.slice());
        undoStack.length = 0;
        redoStack.length = 0;
        sel = null;
        findEl.value = "";
        const sheets = d.sheets || [];
        selEl.innerHTML = sheets.map(s => '<option' + (s === d.active ? " selected" : "") + '>' + _shEsc(s) + '</option>').join("");
        selEl.style.display = sheets.length > 1 ? "" : "none";
        saveBtn.disabled = !st.writable;
        saveBtn.textContent = st.writable ? "保存" : "只读";
        updateMeta();
        tip.textContent = st.writable ? "双击编辑 · 支持 =A1+B1 公式" : ("." + st.ext + " 为只读格式，另存为 .xlsx 后可编辑");
        tab.sheetChanges = {};
        tab.dirty = false;
        if (tab.el) tab.el.classList.remove("dirty");
        renderGrid();
        if (st.writable && st.data.length) setSel(0, 0, 0, 0);
      }).catch(e => {
        grid.innerHTML = '<div class="sheetv-err">加载失败：' + _shEsc(e.message || e) + '</div>';
      });
    }

    selEl.addEventListener("change", async () => {
      if (tab.dirty && !(await uiConfirm("切换工作表", "将丢弃当前未保存的修改，确定继续？", "继续", true))) {
        selEl.value = st.active;
        return;
      }
      load(selEl.value);
    });
    saveBtn.addEventListener("click", () => saveSheetTab(tab));

    load(null);
  }

  // 保存表格：纯改单元格 → 只提交差异补丁；增删过行列 → 整表回写
  async function saveSheetTab(tab) {
    if (!tab || !tab.isSheet) return;
    const st = tab.sheetState;
    if (!st || !st.writable) { toast("该格式为只读，无法保存（请另存为 .xlsx）", "warn"); return; }
    let changes = [];
    if (!st.struct) {
      const orig = st.orig || [];
      st.data.forEach((row, r) => {
        row.forEach((v, c) => {
          const ov = orig[r] && orig[r][c] != null ? String(orig[r][c]) : "";
          if (String(v == null ? "" : v) !== ov) changes.push([r, c, v]);
        });
      });
      if (!changes.length && !tab.dirty) { toast("没有改动", "warn"); return; }
    }
    if (st.struct && st.truncated) {
      toast("表格过大已被截断加载，整表回写会丢失未加载的数据，已取消保存", "err");
      return;
    }
    try {
      toast("正在保存 " + tab.name + " …", "info");
      const body = { path: tab.path, sheet: st.active, changes: changes };
      if (st.struct) {
        body.data = st.data;                       // 结构变化：整表回写
        body.merges = st.merges || [];             // xlsx 写进文件；csv 写侧存元数据
      }
      if (st.alignDirty) {
        body.aligns = Object.keys(st.aligns || {}).map(k => {
          const p = k.split(",");
          return [parseInt(p[0], 10), parseInt(p[1], 10), st.aligns[k]];
        });
      }
      const r = await fetch("/api/sheet/write", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      tab.sheetChanges = {};
      st.orig = st.data.map(r2 => r2.slice());
      st.struct = false;
      st.alignDirty = false;
      tab.dirty = false;
      if (tab.el) tab.el.classList.remove("dirty");
      refreshTreeDirty();
      toast("已保存：" + tab.name, "ok");
    } catch (e) {
      toast("保存失败：" + (e.message || e), "err");
    }
  }

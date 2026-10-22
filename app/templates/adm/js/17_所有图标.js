/* 后台管理：所有图标 —— 应用内全部 icon 的一览表。
 *
 * 数据来源（都是同一份线上资源，不另存副本）：
 *   · /static/vendor/seti/seti-icons.json  —— VS Code 官方 Seti 图标主题，
 *     IDE 文件树、桌面端文件管理器用的就是它（按文件名 → 扩展名 → 语言 ID 解析）；
 *   · /static/vendor/bootstrap-icons/bootstrap-icons.css —— 全部 bi-* 图标类名（正则抽取，约 2000 个）。
 *
 * 用法：切标签页 / 搜索 / 点图标复制（复制后缀或类名），改样式时直接拿去用。 */
ADM.modules.push({
    id: 'icons',
    name: '所有图标',
    subtitle: 'Seti 文件图标 + Bootstrap 图标库一览，点击图标即可复制',
    icon: 'bi-grid-3x3-gap',
    async load(el) {
        var S = { tab: 'file', q: '', limit: 240 };
        var SETI = null;      // { defs, names, exts, langs }
        var BI = [];          // 全部 bi-* 类名（不含前缀）
        var FILE_ITEMS = [];  // 文件图标列表（Seti + 兜底）
        var RULES = [];       // 自定义规则：[{match, value, icon, color, note}]
        var API_OK = true;    // 自定义图标接口是否可用（服务没重启时会失败）

        /* 兜底图标：Seti 没收录的类型，文件管理器（index/js/04_工具.js 的 FILE_ICON_MAP）
           会用这些 Bootstrap 图标 + 配色补齐，这里一并列出来，方便对照「这个后缀显示成什么」。 */
        var FALLBACK = {
            txt: ['bi-file-earmark-text', '#6d8086'], log: ['bi-file-text', '#6d8086'],
            exe: ['bi-filetype-exe', '#c05046'], msi: ['bi-filetype-exe', '#c05046'],
            dmg: ['bi-filetype-exe', '#c05046'], apk: ['bi-filetype-exe', '#8dc149'],
            iso: ['bi-file-binary', '#b5895f'], bin: ['bi-file-binary', '#6d8086'],
            pyc: ['bi-file-binary', '#6d8086'],
            rar: ['bi-file-earmark-zip', '#b5895f'], '7z': ['bi-file-earmark-zip', '#b5895f'],
            gz: ['bi-file-earmark-zip', '#b5895f'], tar: ['bi-file-earmark-zip', '#b5895f'],
            bz2: ['bi-file-earmark-zip', '#b5895f'], xz: ['bi-file-earmark-zip', '#b5895f'],
            tgz: ['bi-file-earmark-zip', '#b5895f'],
            ppt: ['bi-filetype-ppt', '#c05046'], pptx: ['bi-filetype-pptx', '#c05046'],
            sql: ['bi-database', '#519aba'], db: ['bi-database', '#519aba'],
            sqlite: ['bi-database', '#519aba'], sqlite3: ['bi-database', '#519aba'],
            db3: ['bi-database', '#519aba'],
            env: ['bi-gear', '#6d8086'], ini: ['bi-gear', '#6d8086'], conf: ['bi-gear', '#6d8086'],
            cfg: ['bi-gear', '#6d8086'], toml: ['bi-gear', '#6d8086'], properties: ['bi-gear', '#6d8086'],
            m3u: ['bi-file-earmark-play', '#dd7e2e'], m3u8: ['bi-file-earmark-play', '#dd7e2e'],
            ttf: ['bi-file-font', '#6d8086'], otf: ['bi-file-font', '#6d8086'],
            woff: ['bi-file-font', '#6d8086'], woff2: ['bi-file-font', '#6d8086'],
            eot: ['bi-file-font', '#6d8086'],
            go: ['bi-file-earmark-code', '#00add8'], rs: ['bi-file-earmark-code', '#dea584'],
            c: ['bi-file-earmark-code', '#519aba'], h: ['bi-file-earmark-code', '#519aba'],
            cpp: ['bi-file-earmark-code', '#519aba'], lua: ['bi-file-earmark-code', '#51a0cf'],
            pl: ['bi-file-earmark-code', '#519aba'], vue: ['bi-file-earmark-code', '#41b883'],
            ipynb: ['bi-file-earmark-code', '#e37933'], swift: ['bi-file-earmark-code', '#de5d43'],
            kt: ['bi-file-earmark-code', '#a97bff'], dart: ['bi-file-earmark-code', '#41b0e0'],
            dockerfile: ['bi-file-earmark-code', '#438eec'], makefile: ['bi-gear', '#6d8086'],
            license: ['bi-file-text', '#6d8086']
        };

        /* ---------------- 数据 ---------------- */
        function charOf(def) {
            return String(def.fontCharacter).replace(/\\+/g, "");
        }
        // 兜底表里这些是「文件名」而不是扩展名（点开规则时按文件名匹配）
        const FALLBACK_FILENAMES = { dockerfile: 1, makefile: 1, license: 1, "cmakelists.txt": 1 };
        // 去重要用：扩展名 → Seti 语言 ID（只需覆盖兜底表里可能和 Seti 撞车的那些）
        const SETI_LANG = {
            go: "go", mod: "go", sum: "go", rs: "rust", c: "c", h: "c",
            cpp: "cpp", cc: "cpp", hpp: "cpp", lua: "lua", pl: "perl",
            vue: "vue", swift: "swift", kt: "kotlin", dart: "dart",
            py: "python", js: "javascript", ts: "typescript"
        };
        // Seti 是否已经能画出这个键（扩展名 / 文件名 / 语言三者之一命中即算）
        function setiHasKey(key) {
            if (!SETI) return false;
            if (SETI.exts[key]) return true;
            if (SETI.names[key] || SETI.names[key + ".txt"]) return true;
            const lang = SETI_LANG[key];
            return !!(lang && SETI.langs[lang]);
        }

        function buildFileItems() {
            var out = [], seen = {};
            function add(kind, label, copy, glyph, color, tag, key, match) {
                var k = kind + '|' + label;
                if (seen[k]) return;
                seen[k] = 1;
                out.push({
                    kind: kind, label: label, copy: copy, glyph: glyph, color: color, tag: tag,
                    key: key || '',
                    match: match || (kind === 'name' ? 'name' : (kind === 'lang' ? 'lang' : 'ext'))
                });
            }
            if (SETI) {
                Object.keys(SETI.exts).forEach(function (e) {
                    var key = SETI.exts[e], d = SETI.defs[key];
                    if (d && d.fontCharacter) add('ext', '.' + e, '.' + e, charOf(d), d.fontColor || '#9da8ab', 'Seti', key);
                });
                Object.keys(SETI.names).forEach(function (n) {
                    var key = SETI.names[n], d = SETI.defs[key];
                    if (d && d.fontCharacter) add('name', n, n, charOf(d), d.fontColor || '#9da8ab', 'Seti', key);
                });
                Object.keys(SETI.langs).forEach(function (l) {
                    var key = SETI.langs[l], d = SETI.defs[key];
                    if (d && d.fontCharacter) add('lang', l, l, charOf(d), d.fontColor || '#9da8ab', 'Seti', key);
                });
            }
            Object.keys(FALLBACK).forEach(function (e) {
                // Seti 已经能画出这个类型 → 不再放进兜底区（否则同一后缀会出现两次）
                if (setiHasKey(e)) return;
                var f = FALLBACK[e];
                var isName = !!FALLBACK_FILENAMES[e];
                add('fallback', isName ? e : '.' + e, isName ? e : '.' + e,
                    'bi ' + f[0], f[1], '兜底', f[0], isName ? 'name' : 'ext');
            });
            var order = { ext: 0, name: 1, lang: 2, fallback: 3 };
            out.sort(function (a, b) {
                if (order[a.kind] !== order[b.kind]) return order[a.kind] - order[b.kind];
                return a.label.localeCompare(b.label);
            });
            return out;
        }
        function parseBi(css) {
            var seen = {}, out = [];
            String(css || '').replace(/\.bi-([a-z0-9-]+)::?before/g, function (m, n) {
                if (!seen[n]) { seen[n] = 1; out.push(n); }
                return m;
            });
            out.sort();
            return out;
        }

        /* ---------------- 渲染 ---------------- */
        function glyphHtml(it) {
            var color = it.color ? ' style="color:' + it.color + '"' : '';
            // glyph 以 "bi " 开头 = 兜底图标；否则是 seti 字形的十六进制码位
            if (String(it.glyph).indexOf('bi ') === 0) {
                return '<i class="' + it.glyph + '"' + color + '></i>';
            }
            return '<span class="ic-seti"' + color + '>&#x' + it.glyph + ';</span>';
        }
        function cellHtml(it, i) {
            var tagCls = it.tag === '兜底' ? 'ic-tag fallback' : 'ic-tag';
            // 副标题显示图标键（自定义规则里要填的就是它），找不到键时退回显示颜色
            var sub = it.key || it.color || '';
            var isFile = (it.tag !== 'Bootstrap');
            var titleTxt = isFile
                ? ('点击设置图标：' + it.copy + (it.custom ? '（已自定义，可还原）' : '') +
                   (it.key ? ' · 图标键 ' + it.key : '') + (it.color ? ' · 颜色 ' + it.color : ''))
                : ('点击复制：' + it.copy);
            return '<button class="ic-cell' + (it.custom ? ' custom' : '') + '" type="button" data-i="' + i +
                '" data-copy="' + ADM.esc(it.copy) + '" title="' + ADM.esc(titleTxt) + '">' +
                '<span class="ic-glyph">' + glyphHtml(it) + '</span>' +
                '<span class="ic-name">' + ADM.esc(it.label) + '</span>' +
                '<span class="ic-sub"><span class="' + tagCls + '">' + ADM.esc(it.tag) + '</span>' +
                ADM.esc(sub) + '</span>' +
                '</button>';
        }

        function items() {
            var list;
            if (S.tab === 'bi') {
                list = BI.map(function (n) {
                    return { label: n, copy: 'bi-' + n, glyph: 'bi bi-' + n, color: '', tag: 'Bootstrap', key: 'bi-' + n };
                });
            } else {
                // 文件图标：有自定义规则的类型，格子上直接画规则里的图标 + 打角标
                list = FILE_ITEMS.map(function (it) {
                    var m = it.match || 'ext';
                    var v = m === 'ext' ? String(it.label).replace(/^\.+/, '') : it.label;
                    var ri = ruleIndexFor(m, v);
                    var o = Object.assign({}, it, { match: m, value: v, custom: ri >= 0 });
                    if (ri >= 0) {
                        var r = RULES[ri];
                        o.key = r.icon;
                        if (String(r.icon).indexOf('bi-') === 0) {
                            o.glyph = 'bi ' + r.icon;
                            o.color = r.color || '#9da8ab';
                        } else if (SETI && SETI.defs[r.icon] && SETI.defs[r.icon].fontCharacter) {
                            o.glyph = charOf(SETI.defs[r.icon]);
                            o.color = r.color || SETI.defs[r.icon].fontColor || o.color;
                        }
                    }
                    return o;
                });
            }
            var q = S.q.toLowerCase();
            if (q) {
                list = list.filter(function (it) {
                    return (it.label + ' ' + (it.tag || '') + ' ' + (it.copy || '')).toLowerCase().indexOf(q) !== -1;
                });
            }
            return list;
        }

        /* ---------- 自定义规则 ---------- */
        // 图标字段既能填 Seti 图标键（如 _markdown），也能填 Bootstrap 类名（如 bi-filetype-md）
        function previewGlyph(icon, color) {
            icon = String(icon || '').trim();
            if (!icon) return '<span class="adm-hint">—</span>';
            var def = (SETI && SETI.defs) ? SETI.defs[icon] : null;
            if (def && def.fontCharacter) {
                return '<span class="ic-seti" style="color:' + (color || def.fontColor || '#9da8ab') + '">&#x' +
                    charOf(def) + ';</span>';
            }
            var cls = icon.indexOf('bi-') === 0 ? icon : ('bi-' + icon);
            return '<i class="bi ' + cls + '" style="color:' + (color || '#9da8ab') + '"></i>';
        }
        function ruleLabel(r) {
            return (r.match === 'name' ? '' : '.') + r.value;
        }
        async function saveRules(list) {
            var d = await ADM.api('/api/adm/icons/custom', { method: 'POST', body: { rules: list } });
            RULES = d.rules || list;
        }
        function ruleIndexFor(match, value) {
            value = String(value || '').toLowerCase();
            for (var i = 0; i < RULES.length; i++) {
                if (RULES[i].match === match && RULES[i].value === value) return i;
            }
            return -1;
        }
        // 点图标格子：已有规则 → 直接编辑；没有 → 带着当前图标预填一条新规则
        function openRuleForItem(it) {
            if (!it) return;
            var m = it.match || 'ext';
            var v = it.value != null ? it.value
                : (m === 'ext' ? String(it.label).replace(/^\.+/, '') : it.label);
            if (m === 'lang') { m = 'ext'; v = ''; }   // 语言图标没有具体后缀：让用户自己填
            var i = v ? ruleIndexFor(m, v) : -1;
            if (i >= 0) { openRuleDialog(i); return; }
            openRuleDialog(-1, { match: m, value: v, icon: it.key || '', color: '', note: '' });
        }
        // 还原默认：删掉这条规则，图标回到内置（Seti / 兜底）
        async function resetRule(idx, done) {
            var r = RULES[idx];
            if (!r) return;
            var ok = await ADM.confirm('还原默认图标',
                '确定删除「' + ADM.esc(ruleLabel(r)) + '」的自定义规则，恢复系统默认图标吗？');
            if (!ok) return;
            var list = RULES.slice();
            list.splice(idx, 1);
            try {
                await saveRules(list);
                ADM.toast('已还原默认图标', 'ok');
                if (typeof done === 'function') done(true);
                paint();
            } catch (e) {
                ADM.toast((e && e.message) || String(e), 'err');
            }
        }
        async function resetAllRules() {
            if (!RULES.length) { ADM.toast('当前没有自定义规则', 'warn'); return; }
            var ok = await ADM.confirm('全部还原',
                '确定清空全部 <b>' + RULES.length + '</b> 条自定义规则，恢复系统默认图标吗？');
            if (!ok) return;
            try {
                await saveRules([]);
                ADM.toast('已全部还原为默认图标', 'ok');
                paint();
            } catch (e) {
                ADM.toast((e && e.message) || String(e), 'err');
            }
        }

        function paintRules() {
            var box = el.querySelector('#icCustom');
            if (!box) return;
            el.querySelector('#icCount').textContent = '共 ' + RULES.length + ' 条规则';
            var h = '<div class="ic-rule-head">' +
                '<span class="adm-hint">命中规则的文件优先用自定义图标（文件名优先于扩展名），' +
                '桌面端文件管理器与 IDE 文件树都会生效。</span>' +
                '<span class="adm-spacer"></span>' +
                '<button class="adm-btn ghost" type="button" id="icRuleResetAll">' +
                    '<i class="bi bi-arrow-counterclockwise"></i> 全部还原</button>' +
                '<button class="adm-btn primary" type="button" id="icRuleAdd">' +
                    '<i class="bi bi-plus-lg"></i> 新建规则</button>' +
                '</div>';
            if (!API_OK) {
                h += '<div class="adm-hint" style="color:var(--adm-warn);margin-bottom:8px">' +
                    '自定义图标接口不可用（多半是服务还没重启）：重启一次服务后刷新本页即可正常读取 / 保存规则。' +
                    '</div>';
            }
            if (!RULES.length) {
                h += '<div class="ic-empty">还没有自定义规则。<br>' +
                    '点「新建规则」把某个后缀（如 md）或某个文件（如 README.md）换成指定图标即可。</div>';
            } else {
                h += '<div class="ic-rules">' + RULES.map(function (r, i) {
                    return '<div class="ic-rule" data-idx="' + i + '">' +
                        '<span class="ic-rule-ic">' + previewGlyph(r.icon, r.color) + '</span>' +
                        '<div class="ic-rule-main">' +
                            '<div class="ic-rule-name">' + ADM.esc(ruleLabel(r)) +
                                ' <span class="ic-tag">' + (r.match === 'name' ? '文件名' : '扩展名') + '</span></div>' +
                            '<div class="ic-rule-sub"><code>' + ADM.esc(r.icon) + '</code>' +
                                (r.color ? ' · ' + ADM.esc(r.color) : '') +
                                (r.note ? ' · ' + ADM.esc(r.note) : '') + '</div>' +
                        '</div>' +
                        '<button class="adm-btn sm ghost" type="button" data-act="edit" title="编辑">' +
                            '<i class="bi bi-pencil"></i></button>' +
                        '<button class="adm-btn sm ghost" type="button" data-act="del" title="删除">' +
                            '<i class="bi bi-trash"></i></button>' +
                        '</div>';
                }).join('') + '</div>';
            }
            box.innerHTML = h;
            box.querySelector('#icRuleAdd').addEventListener('click', function () { openRuleDialog(-1); });
            box.querySelector('#icRuleResetAll').addEventListener('click', resetAllRules);
            box.querySelectorAll('.ic-rule').forEach(function (row) {
                var i = parseInt(row.dataset.idx, 10);
                row.querySelector('[data-act="edit"]').addEventListener('click', function () { openRuleDialog(i); });
                row.querySelector('[data-act="del"]').addEventListener('click', function () { removeRule(i); });
            });
        }

        function openRuleDialog(idx, prefill) {
            var isNew = idx < 0;
            var cur = isNew
                ? (prefill || { match: 'ext', value: '', icon: '', color: '', note: '' })
                : RULES[idx];
            ADM.modal({
                title: (isNew ? '新建' : '编辑') + '自定义图标规则',
                icon: 'bi-palette',
                okText: '保存',
                footer:
                    '<button class="adm-btn ghost" type="button" id="icrCopy">' +
                        '<i class="bi bi-clipboard"></i> 复制匹配值</button>' +
                    (isNew ? '' :
                        '<button class="adm-btn ghost" type="button" id="icrReset">' +
                            '<i class="bi bi-arrow-counterclockwise"></i> 还原默认</button>'),
                html:
                    '<div class="ic-form">' +
                        '<div class="adm-field"><label>匹配方式</label>' +
                            '<select class="adm-select" id="icrMatch">' +
                                '<option value="ext"' + (cur.match === 'ext' ? ' selected' : '') + '>按扩展名（如 md）</option>' +
                                '<option value="name"' + (cur.match === 'name' ? ' selected' : '') + '>按文件名（如 README.md）</option>' +
                            '</select></div>' +
                        '<div class="adm-field"><label>匹配值</label>' +
                            '<input class="adm-input" id="icrValue" value="' + ADM.esc(cur.value) +
                                '" placeholder="md / README.md"></div>' +
                        '<div class="adm-field"><label>图标</label>' +
                            '<div class="ic-icon-row">' +
                                '<input class="adm-input" id="icrIcon" value="' + ADM.esc(cur.icon) +
                                    '" placeholder="点右侧「选择图标」，或直接粘贴图标键">' +
                                '<button class="adm-btn primary" type="button" id="icrPickBtn">' +
                                    '<i class="bi bi-grid-3x3-gap"></i> 选择图标</button>' +
                            '</div></div>' +
                        '<div class="ic-picker" id="icrPicker" style="display:none">' +
                            '<div class="ic-picker-head">' +
                                '<div class="ic-tabs">' +
                                    '<button class="adm-btn sm primary" type="button" data-pick="seti">文件图标</button>' +
                                    '<button class="adm-btn sm ghost" type="button" data-pick="bi">Bootstrap</button>' +
                                '</div>' +
                                '<input class="adm-input" id="icrPickSearch" type="search" ' +
                                    'placeholder="搜索图标…" spellcheck="false">' +
                            '</div>' +
                            '<div class="ic-picker-grid" id="icrPickGrid"></div>' +
                        '</div>' +
                        '<div class="adm-field"><label>颜色（可选）</label>' +
                            '<input class="adm-input" id="icrColor" value="' + ADM.esc(cur.color) +
                                '" placeholder="#519aba（留空用图标自带配色）"></div>' +
                        '<div class="adm-field"><label>备注（可选）</label>' +
                            '<input class="adm-input" id="icrNote" value="' + ADM.esc(cur.note || '') +
                                '" placeholder="例：公司统一用红色 Markdown 图标"></div>' +
                        '<div class="ic-preview">' +
                            '<span class="adm-hint">预览</span>' +
                            '<span id="icrPrev"></span>' +
                            '<span class="adm-hint" id="icrHint"></span>' +
                        '</div>' +
                    '</div>' +
                    '<div class="adm-hint" style="margin-top:10px;line-height:1.8">' +
                        '· 点「选择图标」直接从图标库里挑（文件图标 / Bootstrap 两栏，可搜索），选中会自动填好图标与颜色；<br>' +
                        '· 也可以手动粘贴 <b>Seti 图标键</b>（如 <code>_markdown</code>）或 <b>Bootstrap 类名</b>（如 <code>bi-filetype-md</code>）。' +
                    '</div>',
                onOpen: function (box, done) {
                    var prev = box.querySelector('#icrPrev');
                    var hint = box.querySelector('#icrHint');
                    box.querySelector('#icrCopy').addEventListener('click', function () {
                        ADM.copy(box.querySelector('#icrValue').value.trim() || '');
                    });
                    var resetBtn = box.querySelector('#icrReset');
                    if (resetBtn) resetBtn.addEventListener('click', function () { resetRule(idx, done); });
                    function refresh() {
                        var icon = box.querySelector('#icrIcon').value.trim();
                        var color = box.querySelector('#icrColor').value.trim();
                        prev.innerHTML = previewGlyph(icon, color);
                        if (!icon) { hint.textContent = ''; return; }
                        var def = (SETI && SETI.defs) ? SETI.defs[icon] : null;
                        if (def && def.fontCharacter) { hint.textContent = 'Seti 图标'; return; }
                        var cls = icon.indexOf('bi-') === 0 ? icon : ('bi-' + icon);
                        hint.textContent = BI.indexOf(cls.slice(3)) !== -1 ? 'Bootstrap 图标' : '图标未知（仍可保存，显示时按类名渲染）';
                    }
                    ['#icrIcon', '#icrColor'].forEach(function (sel) {
                        box.querySelector(sel).addEventListener('input', refresh);
                    });
                    refresh();

                    /* ---- 图标选择器：直接从图标库里点，不用记图标键 ---- */
                    var picker = box.querySelector('#icrPicker');
                    var pickGrid = box.querySelector('#icrPickGrid');
                    var pickSearch = box.querySelector('#icrPickSearch');
                    var PS = { tab: 'seti', q: '', limit: 240 };

                    function pickItems() {
                        var list;
                        if (PS.tab === 'bi') {
                            list = BI.map(function (n) {
                                return { key: 'bi-' + n, label: n, glyph: 'bi bi-' + n, color: '' };
                            });
                        } else {
                            list = FILE_ITEMS.filter(function (it) { return it.tag === 'Seti'; })
                                .map(function (it) {
                                    return { key: it.key, label: it.label, glyph: it.glyph, color: it.color };
                                });
                        }
                        var q = PS.q.toLowerCase();
                        if (q) {
                            list = list.filter(function (it) {
                                return (it.key + ' ' + it.label).toLowerCase().indexOf(q) !== -1;
                            });
                        }
                        return list;
                    }
                    function paintPicker() {
                        var list = pickItems();
                        var shown = list.slice(0, PS.limit);
                        pickGrid.innerHTML = shown.length ? shown.map(function (it) {
                            var g = String(it.glyph).indexOf('bi ') === 0
                                ? '<i class="' + it.glyph + '"' + (it.color ? ' style="color:' + it.color + '"' : '') + '></i>'
                                : '<span class="ic-seti"' + (it.color ? ' style="color:' + it.color + '"' : '') +
                                  '>&#x' + it.glyph + ';</span>';
                            return '<button class="ic-pick" type="button" data-key="' + ADM.esc(it.key) +
                                '" data-color="' + ADM.esc(it.color || '') + '" title="' + ADM.esc(it.key) + '">' +
                                '<span class="ic-pick-g">' + g + '</span>' +
                                '<span class="ic-pick-t">' + ADM.esc(it.label) + '</span></button>';
                        }).join('') : '<div class="ic-empty">没有匹配的图标</div>';
                        if (shown.length && shown.length < list.length) {
                            pickGrid.innerHTML += '<div class="ic-pick-more">仅显示前 ' + shown.length +
                                ' 个，输入关键字继续缩小范围</div>';
                        }
                        box.querySelectorAll('[data-pick]').forEach(function (b) {
                            b.className = 'adm-btn sm ' + (b.dataset.pick === PS.tab ? 'primary' : 'ghost');
                        });
                        pickGrid.querySelectorAll('[data-key]').forEach(function (b) {
                            b.addEventListener('click', function () {
                                box.querySelector('#icrIcon').value = b.dataset.key;
                                var cInp = box.querySelector('#icrColor');
                                if (!cInp.value.trim() && b.dataset.color) cInp.value = b.dataset.color;
                                refresh();
                                picker.style.display = 'none';   // 选完收起，回到表单
                            });
                        });
                    }
                    // 展开 / 收起选择器（用 onclick 赋值，重复绑定也不会叠加）
                    function togglePicker(force) {
                        if (!picker || !pickGrid) return;
                        var show = (force === undefined) ? (picker.style.display === 'none') : !!force;
                        picker.style.display = show ? '' : 'none';
                        if (show) {
                            paintPicker();
                            try { picker.scrollIntoView({ block: 'nearest' }); } catch (e) { }
                        }
                    }
                    var pickBtn = box.querySelector('#icrPickBtn');
                    if (pickBtn) pickBtn.onclick = function () { togglePicker(); };
                    // 预览区也能点开（万一按钮被挡住 / 没绑上，还有第二个入口）
                    var prevRow = box.querySelector('.ic-preview');
                    if (prevRow) {
                        prevRow.style.cursor = 'pointer';
                        prevRow.title = '点击打开图标选择器';
                        prevRow.onclick = function () { togglePicker(true); };
                    }
                    box.querySelectorAll('[data-pick]').forEach(function (b) {
                        b.addEventListener('click', function () {
                            if (PS.tab === b.dataset.pick) return;
                            PS.tab = b.dataset.pick;
                            PS.limit = 240;
                            paintPicker();
                        });
                    });
                    var pickTimer = null;
                    if (pickSearch) {
                        pickSearch.addEventListener('input', function () {
                            clearTimeout(pickTimer);
                            pickTimer = setTimeout(function () {
                                PS.q = pickSearch.value.trim();
                                PS.limit = 240;
                                paintPicker();
                            }, 150);
                        });
                    }
                },
                onOk: async function (box) {
                    var r = {
                        match: box.querySelector('#icrMatch').value === 'name' ? 'name' : 'ext',
                        value: box.querySelector('#icrValue').value.trim().toLowerCase(),
                        icon: box.querySelector('#icrIcon').value.trim(),
                        color: box.querySelector('#icrColor').value.trim(),
                        note: box.querySelector('#icrNote').value.trim()
                    };
                    if (r.match === 'ext') r.value = r.value.replace(/^\.+/, '');
                    if (!r.value) { ADM.toast('请填写匹配值', 'warn'); return false; }
                    if (!r.icon) { ADM.toast('请填写图标', 'warn'); return false; }
                    if (r.color && !/^#[0-9a-fA-F]{6}$/.test(r.color)) { ADM.toast('颜色要写成 #RRGGBB', 'warn'); return false; }
                    var dup = RULES.some(function (x, i) {
                        return i !== idx && x.match === r.match && x.value === r.value;
                    });
                    if (dup) { ADM.toast('同样的匹配值已经有一条规则了', 'warn'); return false; }
                    var list = RULES.slice();
                    if (isNew) list.push(r); else list[idx] = r;
                    try {
                        await saveRules(list);
                        ADM.toast(isNew ? '已添加规则' : '已保存规则', 'ok');
                        paint();      // 停在当前页：图标格子会立刻换成新图标并打上「已自定义」角标
                    } catch (e) {
                        var msg = (e && e.message) || String(e);
                        if (/404|405|Not Found/i.test(msg)) {
                            msg = '接口未就绪：请重启一次服务后再保存（新增的自定义图标接口要重启才生效）';
                        }
                        ADM.toast(msg, 'err');
                        return false;
                    }
                }
            });
        }

        async function removeRule(idx) {
            var r = RULES[idx];
            if (!r) return;
            var ok = await ADM.confirm('删除规则', '确定删除规则「' + ADM.esc(ruleLabel(r)) + '」吗？');
            if (!ok) return;
            var list = RULES.slice();
            list.splice(idx, 1);
            try {
                await saveRules(list);
                ADM.toast('已删除规则', 'ok');
                paint();
            } catch (e) {
                ADM.toast((e && e.message) || String(e), 'err');
            }
        }

        function paint() {
            var custom = (S.tab === 'custom');
            el.querySelector('#icGrid').style.display = custom ? 'none' : '';
            el.querySelector('#icCustom').style.display = custom ? '' : 'none';
            el.querySelector('#icSearch').style.display = custom ? 'none' : '';
            el.querySelector('#icMore').style.display = 'none';
            el.querySelectorAll('[data-ic-tab]').forEach(function (b) {
                b.className = 'adm-btn sm ' + (b.dataset.icTab === S.tab ? 'primary' : 'ghost');
            });
            // 每个标签页说明自己管哪些地方，免得搞混
            var scope = el.querySelector('#icScope');
            if (scope) {
                scope.style.display = custom ? 'none' : '';
                scope.innerHTML = (S.tab === 'bi')
                    ? '<i class="bi bi-info-circle"></i> 适用范围：界面通用图标（<b>标题栏 / 工具栏 / 侧栏活动栏 / 按钮 / 菜单 / 面板头</b>），' +
                      '以及文件图标的<b>兜底</b>（Seti 未收录的后缀）—— 它不参与「文件类型识别」。'
                    : '<i class="bi bi-info-circle"></i> 适用范围：<b>桌面端文件管理器</b>（列表 / 图标 / 树型 / 全盘搜索结果）与 <b>IDE</b>' +
                      '（文件树、标签页、Git 面板、快速打开、搜索结果、状态栏项目图标）；未命中的类型用 Bootstrap 图标兜底。';
            }
            if (custom) { paintRules(); return; }

            var grid = el.querySelector('#icGrid');
            var list = items();
            var shown = list.slice(0, S.limit);
            grid.innerHTML = shown.length
                ? shown.map(cellHtml).join('')
                : '<div class="ic-empty">没有匹配的图标</div>';
            var fileTab = (S.tab === 'file');
            grid.querySelectorAll('[data-copy]').forEach(function (b) {
                b.addEventListener('click', function () {
                    // 文件图标格子：点一下弹出悬浮框设置图标；Bootstrap 页仍是复制类名
                    if (fileTab) openRuleForItem(shown[parseInt(b.dataset.i, 10)]);
                    else ADM.copy(b.dataset.copy);
                });
            });
            el.querySelector('#icCount').textContent =
                '共 ' + list.length + ' 个' + (shown.length < list.length ? '（已显示 ' + shown.length + '）' : '');
            el.querySelector('#icMore').style.display = shown.length < list.length ? '' : 'none';
        }

        /* ---------------- 骨架 ---------------- */
        el.innerHTML = ADM.loading('正在加载图标数据…');

        try {
            var res = await Promise.all([
                ADM.api('/static/vendor/seti/seti-icons.json').catch(function () { return null; }),
                fetch('/static/vendor/bootstrap-icons/bootstrap-icons.css')
                    .then(function (r) { return r.ok ? r.text() : ''; })
                    .catch(function () { return ''; }),
                ADM.api('/api/icons/custom').catch(function () { return null; })
            ]);
            var j = res[0] || {};
            SETI = {
                defs: j.iconDefinitions || {},
                names: j.fileNames || {},
                exts: j.fileExtensions || {},
                langs: j.languageIds || {}
            };
            FILE_ITEMS = buildFileItems();
            BI = parseBi(res[1]);
            RULES = (res[2] && res[2].rules) || [];
            API_OK = !!res[2];      // 接口没通（多半是服务还没重启）时，自定义页给出提示
        } catch (e) {
            el.innerHTML = '<div class="adm-card"><div class="adm-hint">图标数据加载失败：' +
                ADM.esc((e && e.message) || e) + '</div></div>';
            return;
        }

        el.innerHTML =
            '<div class="adm-section">' +
                ADM.sectionHead('bi-grid-3x3-gap', '图标总览',
                    '<span class="adm-hint" id="icCount"></span>') +
                '<div class="adm-card">' +
                    '<div class="ic-toolbar">' +
                        '<div class="ic-tabs">' +
                            '<button class="adm-btn sm primary" type="button" data-ic-tab="file">' +
                                '<i class="bi bi-file-earmark"></i> 文件图标</button>' +
                            '<button class="adm-btn sm ghost" type="button" data-ic-tab="bi">' +
                                '<i class="bi bi-bootstrap"></i> Bootstrap 图标</button>' +
                            '<button class="adm-btn sm ghost" type="button" data-ic-tab="custom">' +
                                '<i class="bi bi-palette"></i> 自定义</button>' +
                        '</div>' +
                        '<input class="adm-input" id="icSearch" type="search" spellcheck="false" ' +
                            'placeholder="搜索：.py / markdown / alarm …">' +
                    '</div>' +
                    '<div class="adm-hint ic-scope" id="icScope"></div>' +
                    '<div class="ic-grid" id="icGrid"></div>' +
                    '<div id="icCustom" style="display:none"></div>' +
                    '<div style="text-align:center;margin-top:10px">' +
                        '<button class="adm-btn ghost" id="icMore" type="button" style="display:none">加载更多</button>' +
                    '</div>' +
                '</div>' +
            '</div>' +
            '<div class="adm-hint" style="line-height:1.8">' +
                '· 「文件图标」来自 VS Code 官方 <b>Seti</b> 图标主题（<code>/static/vendor/seti/</code>），' +
                '与 IDE 文件树、桌面端文件管理器是同一份数据；<br>' +
                '· 标 <span class="ic-tag fallback">兜底</span> 的是 Seti 未收录的类型，' +
                '由 Bootstrap 图标 + 对应配色补齐；<br>' +
                '· 点「文件图标」里的任一图标 = 弹出悬浮框给它设置自定义图标（可「还原默认」）；' +
                '「Bootstrap 图标」页点一下是复制类名；<br>' +
                '· 「自定义」页可以给某个后缀 / 文件名指定图标（Seti 图标键或 Bootstrap 类名 + 颜色），' +
                '保存后桌面端文件管理器与 IDE 文件树重开即生效。' +
            '</div>';

        el.querySelectorAll('[data-ic-tab]').forEach(function (b) {
            b.addEventListener('click', function () {
                if (S.tab === b.dataset.icTab) return;
                S.tab = b.dataset.icTab;
                S.limit = 240;
                paint();
            });
        });
        var inp = el.querySelector('#icSearch');
        var timer = null;
        inp.addEventListener('input', function () {
            clearTimeout(timer);
            timer = setTimeout(function () {
                S.q = inp.value.trim();
                S.limit = 240;
                paint();
            }, 150);
        });
        el.querySelector('#icMore').addEventListener('click', function () {
            S.limit += 240;
            paint();
        });

        paint();
    }
});

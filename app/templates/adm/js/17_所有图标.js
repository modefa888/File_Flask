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
        var LINKS = [];       // 阿里图标库：[{name, url}]
        var ALI = {};         // url -> [图标类名...]（按需拉取后缓存）
        var AI_LIST = [];     // 已保存的 AI 图标：[{id, name, prompt, style, svg}]
        var AI_DRAFT = [];    // 刚生成、还没保存的候选图标
        var AI_STYLE = "line";   // 生成风格：用标签按钮选，不用下拉（下拉展开会挡住下面的结果）
        var AI_COUNT = 4;        // 一次生成几个
        var AI_PROMPT = "";      // 描述框内容（重绘后保留，不会白输）
        var AI_KEEP = false;     // 保留原色：让模型用彩色画，保存后不被规则颜色覆盖
        var AI_BUSY = false;     // 生成中：状态放模块里，切到别的标签页也不会丢 / 不会重复点
        var SVG_CODE = "";       // 手动粘贴的 SVG 源码
        var SVG_NAME = "";       // 手动粘贴时的图标名
        var SVG_KEEP = false;    // 手动粘贴：保留原色
        var SVG_PREVIEW = "";    // 清洗后的预览 SVG

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

        /* ---------------- 阿里图标库（iconfont） ---------------- */
        function injectIconfont() {
            LINKS.forEach(function (l) {
                if (!l || !l.url) return;
                if (document.querySelector('link[data-icfont="' + l.url + '"]')) return;
                var lk = document.createElement('link');
                lk.rel = 'stylesheet';
                lk.href = l.url;
                lk.setAttribute('data-icfont', l.url);
                document.head.appendChild(lk);
            });
        }
        // 通过后端代理读 CDN 上的 CSS（浏览器直连会被 CORS 挡），解析出图标类名
        function loadAliClasses(url) {
            if (ALI[url]) return Promise.resolve(ALI[url]);
            return ADM.api('/api/icons/iconfont/css?url=' + encodeURIComponent(url))
                .then(function (d) { ALI[url] = (d && d.classes) || []; return ALI[url]; })
                .catch(function () { ALI[url] = []; return []; });
        }
        // 所有库的类名（合并去重）
        function aliClasses() {
            var seen = {}, out = [];
            LINKS.forEach(function (l) {
                (ALI[l.url] || []).forEach(function (c) {
                    if (!seen[c]) { seen[c] = 1; out.push(c); }
                });
            });
            return out;
        }

        /* ---------------- 渲染 ---------------- */
        function glyphHtml(it) {
            var color = it.color ? ' style="color:' + it.color + '"' : '';
            if (it.svg) return aiSvgHtml(it.svg, it.color || '');   // AI 生成的内联 SVG
            var g = String(it.glyph);
            // glyph 三种约定："bi bi-xxx" = Bootstrap；"ali icon-xxx" = 阿里图标库；否则是 seti 字形码位
            if (g.indexOf('bi ') === 0) return '<i class="' + g + '"' + color + '></i>';
            if (g.indexOf('ali ') === 0) return '<i class="iconfont ' + g.slice(4) + '"' + color + '></i>';
            return '<span class="ic-seti"' + color + '>&#x' + g + ';</span>';
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
                        if (String(r.icon).indexOf('ai:') === 0) {
                            var aiIcon = AI_LIST.filter(function (x) { return x.id === r.icon.slice(3); })[0];
                            if (aiIcon) { o.svg = aiIcon.svg; o.color = r.color || ''; }
                        } else if (String(r.icon).indexOf('ali:') === 0) {
                            o.glyph = 'ali ' + r.icon.slice(4);
                            o.color = r.color || '';
                        } else if (String(r.icon).indexOf('bi-') === 0) {
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
            if (icon.indexOf('ali:') === 0) {   // 阿里图标库：ali:icon-xxx
                return '<i class="iconfont ' + icon.slice(4) + '"' +
                    (color ? ' style="color:' + color + '"' : '') + '></i>';
            }
            if (icon.indexOf('ai:') === 0) {    // AI 生成：ai:ai_xxx
                var hit = AI_LIST.filter(function (x) { return x.id === icon.slice(3); })[0];
                if (!hit) return '<span class="adm-hint">图标已删除</span>';
                return aiSvgHtml(hit.svg, hit.keepColor ? '' : color);   // 保留原色的图标不吃规则颜色
            }
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

        /* 规则排序：把第 from 条挪到 to 位（拖拽 / 上移下移都走这里），立刻落库。
           匹配是按「扩展名 / 文件名」查表的，顺序只影响这里的展示顺序；后端按数组顺序原样保存。 */
        async function moveRule(from, to) {
            if (from === to || to < 0 || to >= RULES.length) return;
            var list = RULES.slice();
            var item = list.splice(from, 1)[0];
            list.splice(to, 0, item);
            RULES = list;
            paint();
            try {
                await saveRules(list);
                ADM.toast("顺序已保存", "ok");
            } catch (e) {
                ADM.toast((e && e.message) || String(e), "err");
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
                h += '<div class="ic-rules ic-rules-grid">' + RULES.map(function (r, i) {
                    return '<div class="ic-rule-card" data-idx="' + i + '" draggable="true" ' +
                        'title="拖动这张卡片可以调整顺序">' +
                        '<span class="ic-rule-grip"><i class="bi bi-grip-vertical"></i></span>' +
                        '<span class="ic-rule-ic">' + previewGlyph(r.icon, r.color) + '</span>' +
                        '<div class="ic-rule-name">' + ADM.esc(ruleLabel(r)) + '</div>' +
                        '<div class="ic-rule-sub">' +
                            '<span class="ic-tag">' + (r.match === 'name' ? '文件名' : '扩展名') + '</span>' +
                            (r.color
                                ? '<span class="ic-rule-color"><i style="background:' + ADM.esc(r.color) + '"></i>' +
                                  ADM.esc(r.color) + '</span>'
                                : '') +
                        '</div>' +
                        '<div class="ic-rule-note">' +
                            ADM.esc(r.note || r.icon) + '</div>' +
                        '<div class="ic-rule-acts">' +
                            '<button class="adm-btn sm ghost" type="button" data-act="up" title="上移"' +
                                (i === 0 ? ' disabled' : '') + '><i class="bi bi-arrow-up"></i></button>' +
                            '<button class="adm-btn sm ghost" type="button" data-act="down" title="下移"' +
                                (i === RULES.length - 1 ? ' disabled' : '') + '><i class="bi bi-arrow-down"></i></button>' +
                            '<button class="adm-btn sm ghost" type="button" data-act="edit" title="编辑">' +
                                '<i class="bi bi-pencil"></i></button>' +
                            '<button class="adm-btn sm ghost" type="button" data-act="del" title="删除">' +
                                '<i class="bi bi-trash"></i></button>' +
                        '</div>' +
                        '</div>';
                }).join('') + '</div>';
            }
            box.innerHTML = h;
            box.querySelector('#icRuleAdd').addEventListener('click', function () { openRuleDialog(-1); });
            box.querySelector('#icRuleResetAll').addEventListener('click', resetAllRules);
            var dragFrom = -1;
            box.querySelectorAll('.ic-rule-card').forEach(function (card) {
                var i = parseInt(card.dataset.idx, 10);
                card.querySelector('[data-act="edit"]').addEventListener('click', function () { openRuleDialog(i); });
                card.querySelector('[data-act="del"]').addEventListener('click', function () { removeRule(i); });
                card.querySelector('[data-act="up"]').addEventListener('click', function () { moveRule(i, i - 1); });
                card.querySelector('[data-act="down"]').addEventListener('click', function () { moveRule(i, i + 1); });
                // 拖拽排序：拖到哪张卡上就插到它的位置
                card.addEventListener('dragstart', function (e) {
                    dragFrom = i;
                    card.classList.add('dragging');
                    try {
                        e.dataTransfer.effectAllowed = 'move';
                        e.dataTransfer.setData('text/plain', String(i));
                    } catch (err) { /* 忽略 */ }
                });
                card.addEventListener('dragend', function () {
                    card.classList.remove('dragging');
                    box.querySelectorAll('.ic-rule-card').forEach(function (c) { c.classList.remove('over'); });
                });
                card.addEventListener('dragover', function (e) {
                    e.preventDefault();
                    try { e.dataTransfer.dropEffect = 'move'; } catch (err) { /* 忽略 */ }
                    card.classList.add('over');
                });
                card.addEventListener('dragleave', function () { card.classList.remove('over'); });
                card.addEventListener('drop', function (e) {
                    e.preventDefault();
                    card.classList.remove('over');
                    if (dragFrom >= 0 && dragFrom !== i) moveRule(dragFrom, i);
                    dragFrom = -1;
                });
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
                                    '" placeholder="点「选择图标」挑，或粘贴 _markdown / bi-filetype-md / ali:icon-xxx / ai:ai_xxx">' +
                                '<button class="adm-btn primary" type="button" id="icrPickBtn">' +
                                    '<i class="bi bi-grid-3x3-gap"></i> 选择图标</button>' +
                            '</div></div>' +
                        '<div class="ic-picker" id="icrPicker" style="display:none">' +
                            '<div class="ic-picker-head">' +
                                '<div class="ic-tabs">' +
                                    '<button class="adm-btn sm primary" type="button" data-pick="seti">文件图标</button>' +
                                    '<button class="adm-btn sm ghost" type="button" data-pick="bi">Bootstrap</button>' +
                                    '<button class="adm-btn sm ghost" type="button" data-pick="ali">阿里图标</button>' +
                                    '<button class="adm-btn sm ghost" type="button" data-pick="ai">AI 图标</button>' +
                                '</div>' +
                                '<input class="adm-input" id="icrPickSearch" type="search" ' +
                                    'placeholder="搜索图标…" spellcheck="false">' +
                            '</div>' +
                            '<div class="ic-picker-grid" id="icrPickGrid"></div>' +
                        '</div>' +
                        '<div class="adm-field"><label>颜色（可选）</label>' +
                            '<div class="ic-color-row">' +
                                '<input class="adm-input" id="icrColor" value="' + ADM.esc(cur.color) +
                                    '" placeholder="#519aba（留空用图标自带配色）" spellcheck="false">' +
                                '<input class="ic-color-pick" type="color" id="icrColorPick" ' +
                                    'value="' + ADM.esc(/^#[0-9a-fA-F]{6}$/.test(cur.color) ? cur.color : '#519aba') + '" ' +
                                    'title="打开选色器">' +
                            '</div>' +
                            '<div class="ic-color-presets" id="icrColorPresets">' +
                                ['#519aba', '#2f81f7', '#4ec9b0', '#8bc34a', '#dcdcaa', '#f5a623',
                                 '#e06c75', '#e91e63', '#c586c0', '#9e9e9e'].map(function (c) {
                                    return '<button class="ic-cchip" type="button" data-color="' + c +
                                        '" title="' + c + '" style="background:' + c + '"></button>';
                                }).join('') +
                                '<button class="ic-cchip ic-cchip-clear" type="button" data-color="" ' +
                                    'title="清空：用图标自带配色">×</button>' +
                            '</div></div>' +
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
                        '· 点「选择图标」直接从图标库里挑（文件图标 / Bootstrap / 阿里图标 三栏，可搜索），选中会自动填好图标与颜色；<br>' +
                        '· 也可以手动粘贴 <b>Seti 图标键</b>（<code>_markdown</code>）、<b>Bootstrap 类名</b>（<code>bi-filetype-md</code>）' +
                        '<b>阿里图标</b>（<code>ali:icon-folder</code>）或 <b>AI 图标</b>（<code>ai:ai_xxx</code>，先用「AI 图标」页生成并保存）。' +
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
                        if (icon.indexOf('ai:') === 0) { hint.textContent = 'AI 生成图标'; return; }
                        if (icon.indexOf('ali:') === 0) { hint.textContent = '阿里图标库'; return; }
                        var def = (SETI && SETI.defs) ? SETI.defs[icon] : null;
                        if (def && def.fontCharacter) { hint.textContent = 'Seti 图标'; return; }
                        var cls = icon.indexOf('bi-') === 0 ? icon : ('bi-' + icon);
                        hint.textContent = BI.indexOf(cls.slice(3)) !== -1 ? 'Bootstrap 图标' : '图标未知（仍可保存，显示时按类名渲染）';
                    }
                    ['#icrIcon', '#icrColor'].forEach(function (sel) {
                        box.querySelector(sel).addEventListener('input', refresh);
                    });
                    refresh();

                    /* ---- 颜色：系统取色器 + 常用色快选（与文本框双向同步） ---- */
                    var colorInp = box.querySelector('#icrColor');
                    var colorPick = box.querySelector('#icrColorPick');
                    function syncColorPick() {
                        if (!colorPick) return;
                        var v = (colorInp.value || '').trim();
                        if (/^#[0-9a-fA-F]{6}$/.test(v)) colorPick.value = v;   // 手输合法色值时同步色块
                    }
                    if (colorPick) {
                        colorPick.addEventListener('input', function () {
                            colorInp.value = colorPick.value;
                            refresh();
                        });
                        syncColorPick();
                    }
                    colorInp.addEventListener('input', syncColorPick);
                    box.querySelectorAll('#icrColorPresets [data-color]').forEach(function (b) {
                        b.addEventListener('click', function () {
                            colorInp.value = b.dataset.color;    // 空串 = 清空，用图标自带配色
                            syncColorPick();
                            refresh();
                        });
                    });

                    /* ---- 图标选择器：直接从图标库里点，不用记图标键 ---- */
                    var picker = box.querySelector('#icrPicker');
                    var pickGrid = box.querySelector('#icrPickGrid');
                    var pickSearch = box.querySelector('#icrPickSearch');
                    var PS = { tab: 'seti', q: '', limit: 240 };

                    function pickItems() {
                        var list;
                        if (PS.tab === 'ai') {          // AI 生成的图标：内联 SVG 预览
                            list = AI_LIST.map(function (it) {
                                // 带上默认色，选中后「颜色」框会自动填上（不然规则存成无色，列表里看是灰的）；
                                // 「保留原色」的图标不带颜色，避免覆盖它自己的配色
                                return {
                                    key: 'ai:' + it.id, label: it.name, svg: it.svg, glyph: '',
                                    color: it.keepColor ? '' : '#519aba'
                                };
                            });
                        } else if (PS.tab === 'ali') {
                            list = aliClasses().map(function (c) {
                                return { key: 'ali:' + c, label: c, glyph: 'ali ' + c, color: '' };
                            });
                        } else if (PS.tab === 'bi') {
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
                            var g = glyphHtml(it);
                            return '<button class="ic-pick" type="button" data-key="' + ADM.esc(it.key) +
                                '" data-color="' + ADM.esc(it.color || '') + '" title="' + ADM.esc(it.key) + '">' +
                                '<span class="ic-pick-g">' + g + '</span>' +
                                '<span class="ic-pick-t">' + ADM.esc(it.label) + '</span></button>';
                        }).join('') : '<div class="ic-empty">' +
                            (PS.q ? '没有匹配的图标'
                                : PS.tab === 'ai' ? '还没有 AI 图标：先到上面「AI 图标」页生成并保存。'
                                : PS.tab === 'ali' ? '还没有阿里图标库：先到「阿里图标」页添加一个库。'
                                : '没有匹配的图标') + '</div>';
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
                                if (!cInp.value.trim() && b.dataset.color) {
                                    cInp.value = b.dataset.color;
                                    colorInp.dispatchEvent(new Event('input'));   // 顺手同步取色器色块
                                }
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
                            if (PS.tab === 'ali' && LINKS.length) {
                                // 阿里图标的类名要先去 CDN 拉一次，拿到后再画
                                loadAllAli().then(function () { if (PS.tab === 'ali') paintPicker(); });
                            }
                            paintPicker();
                        });
                    });
                    if (LINKS.length) loadAllAli();   // 预取，切到阿里页签时不用等
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

        /* ---------- 阿里图标库（iconfont） ---------- */
        function loadAllAli() {
            return Promise.all(LINKS.map(function (l) { return loadAliClasses(l.url); }));
        }
        function aliCellHtml(c) {
            return '<button class="ic-cell" type="button" data-ali="' + ADM.esc(c) +
                '" title="点击复制：ali:' + ADM.esc(c) + '">' +
                '<span class="ic-glyph"><i class="iconfont ' + ADM.esc(c) + '"></i></span>' +
                '<span class="ic-name">' + ADM.esc(c) + '</span>' +
                '<span class="ic-sub"><span class="ic-tag">阿里</span>ali:' + ADM.esc(c) + '</span>' +
                '</button>';
        }
        function renderAliGrid() {
            var grid = el.querySelector('#icAliGrid');
            var hint = el.querySelector('#icAliHint');
            if (!grid) return;
            var cls = aliClasses();
            if (!cls.length) {
                grid.innerHTML = '';
                if (hint) {
                    hint.innerHTML = '没读到图标：确认地址是项目里「Font class」的 <code>.css</code>，' +
                        '并且服务器能访问外网（后端要去拉一次 CSS 才能解析类名）。';
                }
                return;
            }
            if (hint) {
                hint.innerHTML = '共 <b>' + cls.length + '</b> 个图标，点击复制 <code>ali:类名</code>；' +
                    '也可以在规则弹窗的「选择图标 → 阿里图标」里直接挑。';
            }
            grid.innerHTML = cls.map(aliCellHtml).join('');
            grid.querySelectorAll('[data-ali]').forEach(function (b) {
                b.addEventListener('click', function () { ADM.copy('ali:' + b.dataset.ali); });
            });
        }
        function updateLibCounts() {
            el.querySelectorAll('[data-lib-count]').forEach(function (sp) {
                var l = LINKS[parseInt(sp.dataset.libCount, 10)];
                if (!l) return;
                var n = (ALI[l.url] || []).length;
                sp.textContent = n ? (n + ' 个图标') : '读取失败';
            });
        }
        function paintAli() {
            var box = el.querySelector('#icAli');
            el.querySelector('#icCount').textContent = LINKS.length ? ('共 ' + LINKS.length + ' 个图标库') : '未配置';
            var h = '<div class="ic-rule-head">' +
                '<span class="adm-hint">把 iconfont.cn 项目里的「Font class」CSS 地址加进来，就能用它的图标。</span>' +
                '<span class="adm-spacer"></span>' +
                '<button class="adm-btn primary" type="button" id="icAliAdd">' +
                    '<i class="bi bi-plus-lg"></i> 添加图标库</button>' +
                '</div>';
            if (!LINKS.length) {
                h += '<div class="ic-empty">还没有配置阿里图标库。<br>' +
                    '在 <b>iconfont.cn</b> 打开项目 → 「Font class」→ 复制 <code>//at.alicdn.com/t/c/font_xxx.css</code> 这样的地址，' +
                    '点「添加图标库」粘进来即可。</div>';
            } else {
                h += '<div class="ic-libs">' + LINKS.map(function (l, i) {
                    return '<div class="ic-lib">' +
                        '<div class="ic-lib-main">' +
                            '<div class="ic-lib-name">' + ADM.esc(l.name) + '</div>' +
                            '<div class="ic-lib-url" title="' + ADM.esc(l.url) + '">' + ADM.esc(l.url) + '</div>' +
                        '</div>' +
                        '<span class="ic-tag" data-lib-count="' + i + '">读取中…</span>' +
                        '<button class="adm-btn sm ghost" type="button" data-lib-refresh="' + i + '" title="重新读取图标">' +
                            '<i class="bi bi-arrow-clockwise"></i></button>' +
                        '<button class="adm-btn sm ghost" type="button" data-lib-del="' + i + '" title="删除图标库">' +
                            '<i class="bi bi-trash"></i></button>' +
                    '</div>';
                }).join('') + '</div>' +
                '<div class="adm-hint" id="icAliHint" style="margin:8px 0">正在读取图标…</div>' +
                '<div class="ic-grid" id="icAliGrid"></div>';
            }
            box.innerHTML = h;
            var addBtn = box.querySelector('#icAliAdd');
            if (addBtn) addBtn.addEventListener('click', openIconfontDialog);
            box.querySelectorAll('[data-lib-del]').forEach(function (b) {
                b.addEventListener('click', function () { removeLib(parseInt(b.dataset.libDel, 10)); });
            });
            box.querySelectorAll('[data-lib-refresh]').forEach(function (b) {
                b.addEventListener('click', function () {
                    var l = LINKS[parseInt(b.dataset.libRefresh, 10)];
                    if (!l) return;
                    delete ALI[l.url];
                    loadAliClasses(l.url).then(function () {
                        if (S.tab === 'ali') { renderAliGrid(); updateLibCounts(); }
                    });
                });
            });
            if (LINKS.length) {
                loadAllAli().then(function () {
                    if (S.tab !== 'ali') return;
                    renderAliGrid();
                    updateLibCounts();
                });
            }
        }

        function openIconfontDialog() {
            ADM.modal({
                title: '添加阿里图标库',
                icon: 'bi-bag',
                okText: '添加',
                html:
                    '<div class="ic-form">' +
                        '<div class="adm-field"><label>名称</label>' +
                            '<input class="adm-input" id="icfName" placeholder="例：我的业务图标"></div>' +
                        '<div class="adm-field"><label>Font class 地址</label>' +
                            '<input class="adm-input" id="icfUrl" placeholder="//at.alicdn.com/t/c/font_1234567_abcdef.css"></div>' +
                    '</div>' +
                    '<div class="adm-hint" style="margin-top:10px;line-height:1.8">' +
                        '· iconfont.cn → 进入项目 → 顶部「Font class」→ 复制那行 <code>//at.alicdn.com/t/c/font_xxx.css</code>；<br>' +
                        '· 只接受 at.alicdn.com 的地址（这份 CSS 会被注入页面，来源必须可信）；<br>' +
                        '· 服务器需要能访问外网，后端会拉一次 CSS 解析出图标类名。' +
                    '</div>',
                onOk: async function (box) {
                    var name = box.querySelector('#icfName').value.trim();
                    var url = box.querySelector('#icfUrl').value.trim();
                    if (!url) { ADM.toast('请填写 CSS 地址', 'warn'); return false; }
                    try {
                        var d = await ADM.api('/api/adm/icons/iconfont', {
                            method: 'POST', body: { links: LINKS.concat([{ name: name, url: url }]) }
                        });
                        LINKS = d.links || LINKS;
                        injectIconfont();
                        ADM.toast('已添加图标库', 'ok');
                        paint();
                    } catch (e) {
                        var msg = (e && e.message) || String(e);
                        if (/404|405|Not Found/i.test(msg)) msg = '接口未就绪：请重启一次服务后再试';
                        ADM.toast(msg, 'err');
                        return false;
                    }
                }
            });
        }

        async function removeLib(i) {
            var l = LINKS[i];
            if (!l) return;
            var ok = await ADM.confirm('删除图标库', '确定删除「' + ADM.esc(l.name) + '」吗？' +
                '<br><span class="adm-hint">用到它的自定义规则会显示为未知图标。</span>');
            if (!ok) return;
            var list = LINKS.slice();
            list.splice(i, 1);
            try {
                var d = await ADM.api('/api/adm/icons/iconfont', { method: 'POST', body: { links: list } });
                LINKS = d.links || list;
                ADM.toast('已删除图标库', 'ok');
                paint();
            } catch (e) {
                ADM.toast((e && e.message) || String(e), 'err');
            }
        }

        /* ---------- AI 生成图标 ---------- */
        function aiSvgHtml(svg, color) {
            // 没有可显示的图形时给个明确占位，别留一块空白让人以为「坏了」
            if (!svg) return '<span class="ic-ai-empty" title="这个图标没有可显示的图形，重新生成一个">?</span>';
            return '<span class="ai-ic"' + (color ? ' style="color:' + color + '"' : '') + '>' +
                svg + '</span>';
        }
        /* 风格表：对齐 iconfont「AI 创作」的常见风格 + 项目自带的 Seti 主题，后端 _AI_ICON_STYLES 用同一套 key */
        function aiStyles() {
            return [["seti", "Seti 主题"], ["line", "线性"], ["thin", "纤巧线性"], ["detail", "详细线性"],
                    ["hairline", "极细线"], ["fill", "面性"], ["round", "简约圆形"], ["minimal", "极简"],
                    ["doodle", "涂鸦风"], ["hand", "手绘风"], ["sketch", "描画风"], ["pixel", "像素"]];
        }
        /* 每个风格配一个示意图标（卡片上的效果预览，纯展示，不参与生成）。
           统一用「星星」做母题，跟 iconfont 的风格选择一致，粗细 / 填充 / 造型差异一眼可辨。 */
        var AI_STAR = "M12 3.4l2.6 5.5 6 .8-4.4 4.2 1.1 5.9-5.3-2.9-5.3 2.9 1.1-5.9L3.4 9.7l6-.8z";
        var AI_STYLE_DEMO = {
            seti: '<svg viewBox="0 0 24 24"><path d="M6 2h8l6 6v14H6z" fill="#519aba" opacity=".16"/>' +
                '<path d="M6 2h8l6 6v14H6z" fill="none" stroke="#519aba" stroke-width="1.6"/>' +
                '<path d="M14 2v6h6" fill="none" stroke="#519aba" stroke-width="1.6"/>' +
                '<path d="M9 13h6M9 16h4" stroke="#c586c0" stroke-width="1.6" stroke-linecap="round"/></svg>',
            line: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
                'stroke-linejoin="round"><path d="' + AI_STAR + '"/></svg>',
            thin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" ' +
                'stroke-linejoin="round"><path d="' + AI_STAR + '"/></svg>',
            detail: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linejoin="round">' +
                '<path d="' + AI_STAR + '" stroke-width="1.4"/>' +
                '<path d="M12 8.6l1.3 2.8 3 .4-2.2 2 .6 3-2.7-1.5-2.7 1.5.6-3-2.2-2 3-.4z" stroke-width=".9"/></svg>',
            hairline: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width=".8" ' +
                'stroke-linejoin="round"><path d="' + AI_STAR + '"/></svg>',
            fill: '<svg viewBox="0 0 24 24"><path d="' + AI_STAR + '" fill="currentColor"/></svg>',
            round: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" ' +
                'stroke-linejoin="round" stroke-linecap="round"><path d="M12 4.2l2.2 4.9 5.3.7-3.9 3.6 1 5.3' +
                '-4.6-2.5-4.6 2.5 1-5.3-3.9-3.6 5.3-.7z"/></svg>',
            minimal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" ' +
                'stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
            doodle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
                'stroke-linecap="round"><path d="M12 4.2c4.4 0 7.9 2.6 7.9 6.3S16.4 16.8 12 16.8' +
                's-6.6-2.1-6.6-4.8 2.6-4.6 5.5-4.6 4.7 1.7 4.7 3.9-2 3.3-4.3 3.3-3.3-1.3-3.3-2.7"/></svg>',
            hand: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
                'stroke-linecap="round" stroke-linejoin="round"><path d="M8.6 18.4c-.8-3.4-.2-6.6 1.8-8.8 ' +
                '1.6-1.8 3.4-3 4.2-4.4.6 1.7.3 3.7 1.3 5.3 1 1.7 2.1 3 1.7 5.2-.3 1.9-1.8 3.1-3.6 3.3' +
                '-1.9.2-4.1-.4-5.4-.6z"/></svg>',
            sketch: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ' +
                'stroke-linecap="round"><path d="M4.8 19l5-12M9.4 19l5-12M14 19l5-12M6.6 8h10.6"/></svg>',
            pixel: '<svg viewBox="0 0 24 24"><path fill="currentColor" ' +
                'd="M10 3h4v3h3v3h3v4h-3v3h-3v3h-4v-3H7v-3H4v-4h3V6h3z"/></svg>'
        };
        async function aiGenerate() {
            if (AI_BUSY) { ADM.toast('上一次还在生成，稍等一下', 'warn'); return; }
            var box = el.querySelector('#icAi');
            var prompt = (box.querySelector('#icAiPrompt').value || '').trim();
            if (!prompt) { ADM.toast('先写一句图标描述', 'warn'); return; }
            AI_PROMPT = prompt;
            var style = AI_STYLE;
            var count = AI_COUNT;
            AI_BUSY = true;
            paint();      // 立刻切到「生成中」；之后切到别的标签页再回来，状态还在，也不会重复发起
            try {
                var d = await ADM.api('/api/adm/icons/ai/generate', {
                    method: 'POST',
                    body: { prompt: prompt, style: style, count: count, keepColor: !!AI_KEEP }
                });
                AI_DRAFT = (d.icons || []).map(function (it) {
                    return {
                        name: it.name || '', svg: it.svg, prompt: prompt, style: style,
                        keepColor: (it.keepColor === undefined ? !!AI_KEEP : !!it.keepColor)
                    };
                });
                if (!AI_DRAFT.length) {
                    ADM.toast('模型没返回能画的 SVG，换个描述或风格再试一次', 'err');
                } else {
                    ADM.toast('生成了 ' + AI_DRAFT.length + ' 个图标', 'ok');
                }
            } catch (e) {
                var msg = (e && e.message) || String(e);
                if (/404|405|Not Found/i.test(msg)) msg = '接口未就绪：请重启一次服务后再试';
                ADM.toast(msg, 'err');
            } finally {
                AI_BUSY = false;
                paint();  // 成功 / 失败 / 期间切过标签，都统一回到正常状态
            }
        }
        async function aiSaveDrafts(list) {
            list = (list || []).filter(Boolean);
            if (!list.length) return;
            var icons = AI_LIST.concat(list.map(function (d) {
                return {
                    name: d.name || 'AI 图标', svg: d.svg, prompt: d.prompt || '',
                    style: d.style || 'line', keepColor: !!d.keepColor
                };
            }));
            try {
                var r = await ADM.api('/api/adm/icons/ai/save', { method: 'POST', body: { icons: icons } });
                AI_LIST = r.icons || icons;
                AI_DRAFT = AI_DRAFT.filter(function (d) { return list.indexOf(d) === -1; });
                ADM.toast('已保存到图标库', 'ok');
                paint();
            } catch (e) {
                var msg = (e && e.message) || String(e);
                if (/404|405|Not Found/i.test(msg)) msg = '接口未就绪：请重启一次服务后再试';
                ADM.toast(msg, 'err');
            }
        }
        async function aiDelete(i) {
            var it = AI_LIST[i];
            if (!it) return;
            var ok = await ADM.confirm('删除 AI 图标', '确定删除「' + ADM.esc(it.name) + '」吗？' +
                '<br><span class="adm-hint">用到它的自定义规则会显示为未知图标。</span>');
            if (!ok) return;
            var list = AI_LIST.slice();
            list.splice(i, 1);
            try {
                var r = await ADM.api('/api/adm/icons/ai/save', { method: 'POST', body: { icons: list } });
                AI_LIST = r.icons || list;
                ADM.toast('已删除', 'ok');
                paint();
            } catch (e) {
                ADM.toast((e && e.message) || String(e), 'err');
            }
        }
        /* ---------- 手动粘贴 SVG ----------
           先交给后端清洗校验（去脚本 / 外链 / on* 事件、必须有可绘制元素），确认能画出来再入库。 */
        async function svgClean() {
            var code = (SVG_CODE || "").trim();
            if (!code) { ADM.toast("先粘贴一段 SVG 代码", "warn"); return null; }
            try {
                var d = await ADM.api("/api/adm/icons/ai/svg", {
                    method: "POST", body: { svg: code, keepColor: !!SVG_KEEP }
                });
                return d.svg || "";
            } catch (e) {
                var msg = (e && e.message) || String(e);
                if (/404|405|Not Found/i.test(msg)) msg = "接口未就绪：请重启一次服务后再试";
                ADM.toast(msg, "err");
                return null;
            }
        }
        async function svgPastePreview() {
            var svg = await svgClean();
            if (!svg) return;
            SVG_PREVIEW = svg;
            paint();
            ADM.toast("SVG 可用，可以保存了", "ok");
        }
        async function svgPasteSave() {
            var svg = await svgClean();
            if (!svg) return;
            var name = (SVG_NAME || "").trim() || "手动图标";
            var icons = AI_LIST.concat([{
                name: name, svg: svg, prompt: "", style: "svg", keepColor: !!SVG_KEEP
            }]);
            try {
                var r = await ADM.api("/api/adm/icons/ai/save", { method: "POST", body: { icons: icons } });
                AI_LIST = r.icons || icons;
                SVG_CODE = ""; SVG_NAME = ""; SVG_PREVIEW = "";
                ADM.toast("已保存「" + name + "」", "ok");
                paint();
            } catch (e) {
                ADM.toast((e && e.message) || String(e), "err");
            }
        }

        function bindAi(box) {
            var ta = box.querySelector('#icAiPrompt');
            if (ta) ta.oninput = function () { AI_PROMPT = ta.value; };
            var keep = box.querySelector('#icAiKeep');
            if (keep) keep.onchange = function () { AI_KEEP = keep.checked; };
            // 手动粘贴 SVG：输入内容记在模块变量里，切标签页回来不丢
            var sc = box.querySelector('#icSvgCode');
            if (sc) sc.oninput = function () { SVG_CODE = sc.value; };
            var sn = box.querySelector('#icSvgName');
            if (sn) sn.oninput = function () { SVG_NAME = sn.value; };
            var sk = box.querySelector('#icSvgKeep');
            if (sk) sk.onchange = function () { SVG_KEEP = sk.checked; };
            var spb = box.querySelector('#icSvgPrevBtn');
            if (spb) spb.onclick = svgPastePreview;
            var ssb = box.querySelector('#icSvgSaveBtn');
            if (ssb) ssb.onclick = svgPasteSave;
            // 风格 / 数量：就地切换高亮，不重绘（否则已输入的描述会丢）
            box.querySelectorAll('[data-ai-style]').forEach(function (b) {
                b.onclick = function () {
                    AI_STYLE = b.dataset.aiStyle;
                    box.querySelectorAll('[data-ai-style]').forEach(function (x) { x.classList.remove('on'); });
                    b.classList.add('on');
                    // Seti 主题本身就是彩色的：选它时顺手把「保留原色」打开，否则配色会被压成单色
                    if (AI_STYLE === 'seti') {
                        AI_KEEP = true;
                        var k = box.querySelector('#icAiKeep');
                        if (k) k.checked = true;
                    }
                };
            });
            box.querySelectorAll('[data-ai-count]').forEach(function (b) {
                b.onclick = function () {
                    AI_COUNT = parseInt(b.dataset.aiCount, 10) || 4;
                    box.querySelectorAll('[data-ai-count]').forEach(function (x) { x.classList.remove('on'); });
                    b.classList.add('on');
                };
            });
            var gen = box.querySelector('#icAiGen');
            if (gen) gen.onclick = aiGenerate;
            var all = box.querySelector('#icAiSaveAll');
            if (all) all.onclick = function () { aiSaveDrafts(AI_DRAFT.slice()); };
            var clr = box.querySelector('#icAiClear');
            if (clr) clr.onclick = function () { AI_DRAFT = []; paint(); };
            box.querySelectorAll('[data-ai-save]').forEach(function (b) {
                b.onclick = function () { aiSaveDrafts([AI_DRAFT[parseInt(b.dataset.aiSave, 10)]]); };
            });
            box.querySelectorAll('[data-ai-del]').forEach(function (b) {
                b.onclick = function () { aiDelete(parseInt(b.dataset.aiDel, 10)); };
            });
            box.querySelectorAll('[data-ai-copy]').forEach(function (b) {
                b.onclick = function () { ADM.copy('ai:' + b.dataset.aiCopy); };
            });
        }
        function paintAi() {
            var box = el.querySelector('#icAi');
            el.querySelector('#icCount').textContent = '已保存 ' + AI_LIST.length + ' 个';
            var h = '<div class="ic-rule-head">' +
                '<span class="adm-hint">写一句话让 AI 画成 SVG 图标；保存后可在「自定义」里给文件类型用（图标值 <code>ai:id</code>）。</span>' +
                '<span class="adm-spacer"></span></div>' +
                '<div class="ic-ai-form">' +
                    '<textarea class="adm-textarea" id="icAiPrompt" rows="2" ' +
                        'placeholder="例：购物车、云盘上传、数据库备份（多个用逗号分隔，最多 4 个）">' +
                        ADM.esc(AI_PROMPT) + '</textarea>' +
                    '<div class="ic-ai-label">风格</div>' +
                    '<div class="ic-ai-styles" id="icAiStyles">' + aiStyles().map(function (s) {
                        return '<button class="ic-style-card' + (AI_STYLE === s[0] ? ' on' : '') + '" type="button" ' +
                            'data-ai-style="' + s[0] + '" title="' + s[1] + '">' +
                            '<span class="ic-style-thumb">' + (AI_STYLE_DEMO[s[0]] || '') + '</span>' +
                            '<span class="ic-style-name">' + s[1] + '</span></button>';
                    }).join('') + '</div>' +
                    '<div class="ic-ai-row">' +
                        '<span class="ic-ai-label" style="margin-top:0">数量</span>' +
                        [1, 2, 4].map(function (n) {
                            return '<button class="ic-style' + (AI_COUNT === n ? ' on' : '') + '" type="button" ' +
                                'data-ai-count="' + n + '">' + n + ' 个</button>';
                        }).join('') +
                    '</div>' +
                    // 生成按钮单独一行、靠右，避免被上面的控件挤掉 / 被挡住
                    '<div class="ic-ai-actions">' +
                        '<label class="ic-ai-keep" title="让模型直接用彩色绘制（多色）；保存后规则里的「颜色」不再覆盖它">' +
                            '<input type="checkbox" id="icAiKeep"' + (AI_KEEP ? ' checked' : '') + '> 保留原色</label>' +
                        '<button class="adm-btn primary ic-ai-gen' + (AI_BUSY ? ' busy' : '') + '" ' +
                            'type="button" id="icAiGen"' + (AI_BUSY ? ' disabled' : '') + '>' +
                            (AI_BUSY
                                ? '<span class="ic-ai-spin"></span> 生成中…'
                                : '<i class="bi bi-stars"></i> 生成') + '</button>' +
                    '</div>' +
                '</div>';
            /* 手动粘贴 SVG：不走 AI，直接导入自己手里的图标代码 */
            h += '<div class="ic-svg-paste">' +
                '<div class="ic-ai-label">或者直接粘贴 SVG 代码（不需要 AI）</div>' +
                '<textarea class="adm-textarea" id="icSvgCode" rows="3" spellcheck="false" ' +
                    'placeholder="把完整的 &lt;svg&gt;…&lt;/svg&gt; 粘进来（可从 iconfont 或其它图标站导出）；' +
                    '保存前会自动清洗：去掉脚本 / 外链 / on* 事件属性">' +
                    ADM.esc(SVG_CODE) + '</textarea>' +
                '<div class="ic-ai-row">' +
                    '<input class="adm-input" id="icSvgName" value="' + ADM.esc(SVG_NAME) + '" ' +
                        'placeholder="图标名称（可选）" style="max-width:200px">' +
                    '<label class="ic-ai-keep"><input type="checkbox" id="icSvgKeep"' +
                        (SVG_KEEP ? ' checked' : '') + '> 保留原色</label>' +
                    '<span class="adm-spacer"></span>' +
                    '<button class="adm-btn ghost" type="button" id="icSvgPrevBtn">预览</button>' +
                    '<button class="adm-btn primary" type="button" id="icSvgSaveBtn">保存到图标库</button>' +
                '</div>' +
                (SVG_PREVIEW
                    ? '<div class="ic-svg-prev"><span class="ai-ic" style="color:#519aba">' + SVG_PREVIEW +
                      '</span><span class="adm-hint">预览（已清洗，' + SVG_PREVIEW.length + ' 字符）</span></div>'
                    : '') +
                '</div>';
            if (AI_DRAFT.length) {
                h += '<div class="ic-ai-draft">' +
                    '<div class="ic-ai-label">本次生成（还没保存）</div>' +
                    '<div class="ic-grid">' + AI_DRAFT.map(function (d, i) {
                        return '<div class="ic-cell ai-cell">' +
                            '<span class="ic-glyph">' + aiSvgHtml(d.svg) + '</span>' +
                            '<span class="ic-name">' + ADM.esc(d.name || 'AI 图标') + '</span>' +
                            '<span class="ic-sub"><button class="adm-btn sm primary" type="button" data-ai-save="' + i + '">保存</button></span>' +
                            '</div>';
                    }).join('') + '</div>' +
                    '<div class="ic-ai-actions">' +
                        '<button class="adm-btn ghost" type="button" id="icAiSaveAll">全部保存</button>' +
                        '<button class="adm-btn ghost" type="button" id="icAiClear">清空</button></div>' +
                    '</div>';
            }
            h += '<div class="adm-hint" style="margin:14px 0 6px">图标库（点击图标复制 <code>ai:id</code>）</div>';
            h += AI_LIST.length
                ? '<div class="ic-grid">' + AI_LIST.map(function (it, i) {
                    return '<div class="ic-cell ai-cell" title="点击图标复制：ai:' + ADM.esc(it.id) + '">' +
                        '<span class="ic-glyph" data-ai-copy="' + ADM.esc(it.id) + '">' + aiSvgHtml(it.svg) + '</span>' +
                        '<span class="ic-name">' + ADM.esc(it.name) + '</span>' +
                        '<span class="ic-sub"><span class="ic-tag">' + (it.style === 'svg' ? '手动' : 'AI') + '</span>' +
                            (it.keepColor ? '<span class="ic-tag">原色</span>' : '') +
                            '<button class="adm-btn sm ghost" type="button" data-ai-del="' + i + '" title="删除">' +
                            '<i class="bi bi-trash"></i></button></span>' +
                        '</div>';
                    }).join('') + '</div>'
                : '<div class="ic-empty">还没有 AI 图标，上面写个描述点「生成」试试。</div>';
            box.innerHTML = h;
            bindAi(box);
        }

        function paint() {
            var custom = (S.tab === 'custom');
            var ali = (S.tab === 'ali');
            var ai = (S.tab === 'ai');
            el.querySelector('#icGrid').style.display = (custom || ali || ai) ? 'none' : '';
            el.querySelector('#icCustom').style.display = custom ? '' : 'none';
            el.querySelector('#icAli').style.display = ali ? '' : 'none';
            el.querySelector('#icAi').style.display = ai ? '' : 'none';
            el.querySelector('#icSearch').style.display = (custom || ali || ai) ? 'none' : '';
            el.querySelector('#icMore').style.display = 'none';
            el.querySelectorAll('[data-ic-tab]').forEach(function (b) {
                b.className = 'adm-btn sm ' + (b.dataset.icTab === S.tab ? 'primary' : 'ghost');
                // 生成中：AI 页签右上角挂一颗呼吸点，切到别的标签也看得到还在跑
                b.dataset.busy = (AI_BUSY && b.dataset.icTab === 'ai') ? '1' : '';
            });
            // 每个标签页说明自己管哪些地方，免得搞混
            var scope = el.querySelector('#icScope');
            if (scope) {
                scope.style.display = (custom || ali || ai) ? 'none' : '';
                scope.innerHTML = (S.tab === 'bi')
                    ? '<i class="bi bi-info-circle"></i> 适用范围：界面通用图标（<b>标题栏 / 工具栏 / 侧栏活动栏 / 按钮 / 菜单 / 面板头</b>），' +
                      '以及文件图标的<b>兜底</b>（Seti 未收录的后缀）—— 它不参与「文件类型识别」。'
                    : '<i class="bi bi-info-circle"></i> 适用范围：<b>桌面端文件管理器</b>（列表 / 图标 / 树型 / 全盘搜索结果）与 <b>IDE</b>' +
                      '（文件树、标签页、Git 面板、快速打开、搜索结果、状态栏项目图标）；未命中的类型用 Bootstrap 图标兜底。';
            }
            if (custom) { paintRules(); return; }
            if (ali) { paintAli(); return; }
            if (ai) { paintAi(); return; }

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
                ADM.api('/api/icons/custom').catch(function () { return null; }),
                ADM.api('/api/adm/icons/ai').catch(function () { return null; })
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
            LINKS = (res[2] && res[2].iconfont) || [];
            injectIconfont();       // 把已配置的阿里图标库 CSS 注入页面
            AI_LIST = (res[3] && res[3].icons) || [];
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
                            '<button class="adm-btn sm ghost" type="button" data-ic-tab="ali">' +
                                '<i class="bi bi-bag"></i> 阿里图标</button>' +
                            '<button class="adm-btn sm ghost" type="button" data-ic-tab="ai">' +
                                '<i class="bi bi-stars"></i> AI 图标</button>' +
                        '</div>' +
                        '<input class="adm-input" id="icSearch" type="search" spellcheck="false" ' +
                            'placeholder="搜索：.py / markdown / alarm …">' +
                    '</div>' +
                    '<div class="adm-hint ic-scope" id="icScope"></div>' +
                    '<div class="ic-grid" id="icGrid"></div>' +
                    '<div id="icCustom" style="display:none"></div>' +
                    '<div id="icAli" style="display:none"></div>' +
                    '<div id="icAi" style="display:none"></div>' +
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

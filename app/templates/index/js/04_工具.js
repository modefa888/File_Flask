        // ========== 工具 ==========
        function formatSize(bytes) {
            if (bytes < 1024) return bytes + ' B';
            if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
            if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
            return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
        }

        /* ========== 兜底图标表：Bootstrap 图标 + IDE 同款配色 ==========
           只在「seti 图标数据还没取到」或「seti 没收录这个类型」时使用；
           配色直接对齐 IDE 资源管理器（ide/js/00_preamble.js 的 iconFor），两个页面观感一致。
           值格式：[Bootstrap 图标类, 颜色]。 */
        const FILE_ICON_MAP = {
            // 文档
            pdf: ["bi-filetype-pdf", "#c05046"],
            doc: ["bi-filetype-doc", "#519aba"], docx: ["bi-filetype-docx", "#519aba"], rtf: ["bi-file-richtext", "#519aba"],
            txt: ["bi-file-earmark-text", "#6d8086"], log: ["bi-file-text", "#6d8086"], lrc: ["bi-file-text", "#6d8086"],
            md: ["bi-filetype-md", "#519aba"], markdown: ["bi-filetype-md", "#519aba"], mdx: ["bi-filetype-md", "#519aba"],
            xls: ["bi-file-earmark-spreadsheet", "#8dc149"], xlsx: ["bi-file-earmark-spreadsheet", "#8dc149"],
            xlsm: ["bi-file-earmark-spreadsheet", "#8dc149"], xlsb: ["bi-file-earmark-spreadsheet", "#8dc149"],
            et: ["bi-file-earmark-spreadsheet", "#8dc149"], ett: ["bi-file-earmark-spreadsheet", "#8dc149"],
            ods: ["bi-file-earmark-spreadsheet", "#8dc149"], csv: ["bi-file-earmark-spreadsheet", "#8dc149"],
            tsv: ["bi-file-earmark-spreadsheet", "#8dc149"],
            ppt: ["bi-filetype-ppt", "#c05046"], pptx: ["bi-filetype-pptx", "#c05046"],
            // 代码 / 配置
            py: ["bi-filetype-py", "#519aba"], pyw: ["bi-filetype-py", "#519aba"], pyc: ["bi-file-binary", "#6d8086"],
            js: ["bi-filetype-js", "#cbcb41"], mjs: ["bi-filetype-js", "#cbcb41"], cjs: ["bi-filetype-js", "#cbcb41"],
            jsx: ["bi-filetype-js", "#519aba"], ts: ["bi-filetype-js", "#519aba"], tsx: ["bi-filetype-js", "#519aba"],
            html: ["bi-filetype-html", "#e37933"], htm: ["bi-filetype-html", "#e37933"],
            css: ["bi-filetype-css", "#519aba"], scss: ["bi-filetype-css", "#e37933"],
            sass: ["bi-filetype-css", "#e37933"], less: ["bi-filetype-css", "#519aba"],
            json: ["bi-filetype-json", "#cbcb41"], xml: ["bi-filetype-xml", "#8dc149"],
            yml: ["bi-filetype-yml", "#a074c4"], yaml: ["bi-filetype-yml", "#a074c4"],
            ini: ["bi-gear", "#6d8086"], cfg: ["bi-gear", "#6d8086"], conf: ["bi-gear", "#6d8086"],
            env: ["bi-gear", "#6d8086"], toml: ["bi-gear", "#6d8086"], properties: ["bi-gear", "#6d8086"],
            sh: ["bi-terminal", "#4ec9b0"], bash: ["bi-terminal", "#4ec9b0"], zsh: ["bi-terminal", "#4ec9b0"],
            bat: ["bi-terminal", "#4ec9b0"], cmd: ["bi-terminal", "#4ec9b0"], ps1: ["bi-terminal", "#4ec9b0"],
            sql: ["bi-database", "#519aba"], db: ["bi-database", "#519aba"],
            sqlite: ["bi-database", "#519aba"], sqlite3: ["bi-database", "#519aba"], db3: ["bi-database", "#519aba"],
            java: ["bi-filetype-java", "#c05046"], jar: ["bi-filetype-java", "#c05046"],
            class: ["bi-filetype-java", "#6d8086"],
            go: ["bi-file-earmark-code", "#00add8"], mod: ["bi-file-earmark-code", "#00add8"],
            sum: ["bi-file-earmark-code", "#00add8"],
            rs: ["bi-file-earmark-code", "#dea584"], c: ["bi-file-earmark-code", "#519aba"],
            h: ["bi-file-earmark-code", "#519aba"], cpp: ["bi-file-earmark-code", "#519aba"],
            cc: ["bi-file-earmark-code", "#519aba"], hpp: ["bi-file-earmark-code", "#519aba"],
            cs: ["bi-filetype-cs", "#519aba"], php: ["bi-filetype-php", "#a074c4"],
            rb: ["bi-filetype-rb", "#c05046"], lua: ["bi-file-earmark-code", "#51a0cf"],
            pl: ["bi-file-earmark-code", "#519aba"], vue: ["bi-file-earmark-code", "#41b883"],
            ipynb: ["bi-file-earmark-code", "#e37933"], swift: ["bi-file-earmark-code", "#de5d43"],
            kt: ["bi-file-earmark-code", "#a97bff"], dart: ["bi-file-earmark-code", "#41b0e0"],
            // 图片
            png: ["bi-image", "#a074c4"], jpg: ["bi-image", "#a074c4"], jpeg: ["bi-image", "#a074c4"],
            gif: ["bi-image", "#a074c4"], svg: ["bi-image", "#a074c4"], webp: ["bi-image", "#a074c4"],
            bmp: ["bi-image", "#a074c4"], ico: ["bi-image", "#a074c4"], tiff: ["bi-image", "#a074c4"],
            tif: ["bi-image", "#a074c4"], heic: ["bi-image", "#a074c4"], raw: ["bi-image", "#a074c4"],
            psd: ["bi-image", "#519aba"], ai: ["bi-image", "#dd7e2e"],
            // 视频 / 音频
            mp4: ["bi-film", "#dd7e2e"], webm: ["bi-film", "#dd7e2e"], mkv: ["bi-film", "#dd7e2e"],
            avi: ["bi-film", "#dd7e2e"], mov: ["bi-film", "#dd7e2e"], wmv: ["bi-film", "#dd7e2e"],
            flv: ["bi-film", "#dd7e2e"], m4v: ["bi-film", "#dd7e2e"], rmvb: ["bi-film", "#dd7e2e"],
            mp3: ["bi-music-note", "#519aba"], wav: ["bi-music-note", "#519aba"], flac: ["bi-music-note", "#519aba"],
            aac: ["bi-music-note", "#519aba"], m4a: ["bi-music-note", "#519aba"], ogg: ["bi-music-note", "#519aba"],
            ape: ["bi-music-note", "#519aba"],
            m3u: ["bi-file-earmark-play", "#dd7e2e"], m3u8: ["bi-file-earmark-play", "#dd7e2e"],
            // 压缩包 / 安装包 / 镜像
            zip: ["bi-file-earmark-zip", "#b5895f"], tar: ["bi-file-earmark-zip", "#b5895f"],
            gz: ["bi-file-earmark-zip", "#b5895f"], rar: ["bi-file-earmark-zip", "#b5895f"],
            "7z": ["bi-file-earmark-zip", "#b5895f"], bz2: ["bi-file-earmark-zip", "#b5895f"],
            xz: ["bi-file-earmark-zip", "#b5895f"], tgz: ["bi-file-earmark-zip", "#b5895f"],
            exe: ["bi-filetype-exe", "#c05046"], msi: ["bi-filetype-exe", "#c05046"],
            dmg: ["bi-filetype-exe", "#c05046"], apk: ["bi-filetype-exe", "#8dc149"],
            iso: ["bi-file-binary", "#b5895f"], bin: ["bi-file-binary", "#6d8086"],
            // 字体
            ttf: ["bi-file-font", "#6d8086"], otf: ["bi-file-font", "#6d8086"],
            woff: ["bi-file-font", "#6d8086"], woff2: ["bi-file-font", "#6d8086"], eot: ["bi-file-font", "#6d8086"]
        };
        // 没有扩展名但一眼能认出来的文件（同样 [图标, 颜色]）
        const FILE_NAME_ICONS = {
            dockerfile: ["bi-file-earmark-code", "#438eec"], makefile: ["bi-gear", "#6d8086"],
            "cmakelists.txt": ["bi-gear", "#6d8086"], license: ["bi-file-text", "#6d8086"],
            readme: ["bi-file-text", "#6d8086"]
        };

        /* ========== Seti 官方文件图标（与 IDE 资源管理器完全同一套） ==========
           数据/字体都在 /static/vendor/seti/（seti-icons.json + seti.woff），
           这里按 VS Code theme-seti 的规则解析：fileNames → fileExtensions → languageIds，
           命中的字形用 fontCharacter + fontColor 画出来，所以文件管理器里的图标与 IDE 文件树一模一样。
           图标数据是异步取的：首屏先用下面的 Bootstrap 彩色兜底，取到后自动重绘一次。 */
        let SETI = null, _setiLoading = false;
        const SETI_LANG = {
            py: "python", pyw: "python", ipy: "python",
            js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
            ts: "typescript", tsx: "typescript",
            html: "html", htm: "html", css: "css", scss: "scss", sass: "sass", less: "less",
            json: "json", md: "markdown", markdown: "markdown",
            yml: "yaml", yaml: "yaml", sh: "shellscript", bash: "shellscript", zsh: "shellscript",
            xml: "xml", xsl: "xml",
            gitignore: "ignore", gitattributes: "ignore", gitmodules: "ignore", dockerignore: "ignore",
            go: "go", mod: "go", sum: "go", rs: "rust",
            java: "java", jar: "java", php: "php", phtml: "php",
            rb: "ruby", rake: "ruby", gemspec: "ruby", erb: "erb",
            c: "c", h: "c", cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp", inl: "cpp",
            cs: "csharp", csx: "csharp", kt: "kotlin", kts: "kotlin", swift: "swift", lua: "lua",
            r: "r", dart: "dart", vue: "vue", ex: "elixir", exs: "elixir",
            hs: "haskell", lhs: "haskell", jl: "julia", pl: "perl", pm: "perl",
            tf: "terraform", tfvars: "terraform", gradle: "gradle", groovy: "groovy", gvy: "groovy",
            clj: "clojure", cljs: "clojure", cljc: "clojure", edn: "clojure", elm: "elm",
            fs: "fsharp", fsx: "fsharp", fsi: "fsharp", m: "objective-c", mm: "objective-cpp",
            ml: "ocaml", mli: "ocaml", bat: "bat", cmd: "bat",
            ps1: "powershell", psm1: "powershell", psd1: "powershell",
            tex: "latex", ltx: "latex", sty: "latex", bib: "latex",
            properties: "properties", dotenv: "dotenv", styl: "stylus", pcss: "postcss",
            handlebars: "handlebars", hbs: "handlebars", njk: "nunjucks", mustache: "mustache"
        };
        const SHEET_ICON_ALIAS = {   // 表格类复用 xls / csv 的官方图标
            et: "xls", ett: "xls", xlsx: "xls", xlsm: "xls", xltx: "xls", xltm: "xls", xlsb: "xls", ods: "xls", tsv: "csv"
        };
        const SETI_NAME_ALIAS = { "go.mod": "_go2", "go.sum": "_go2", "go.work": "_go2", "go.work.sum": "_go2" };
        function _loadSetiIcons() {
            if (SETI || _setiLoading) return;
            _setiLoading = true;
            fetch("/static/vendor/seti/seti-icons.json")
                .then(r => r.ok ? r.json() : Promise.reject(new Error("http " + r.status)))
                .then(j => {
                    SETI = { defs: j.iconDefinitions || {}, names: j.fileNames || {}, exts: j.fileExtensions || {},
                             langs: j.languageIds || {} };
                    _setiLoading = false;
                    // 数据到位：按当前视图重绘一次（首屏用的是兜底图标）
                    if (typeof applyFiltersAndSort === "function" && fileItems.length) applyFiltersAndSort();
                })
                .catch(() => { _setiLoading = false; });
        }

        /* ---------- 自定义图标规则（后台「所有图标 → 自定义」里配置） ----------
           规则：{match: 'ext'|'name', value, icon, color}；文件名优先于扩展名。
           命中就覆盖 Seti / 兜底图标，未命中照旧。 */
        let CUSTOM_ICONS = { ext: {}, name: {} };
        let AI_SVG = {};      // 后台 AI 生成图标：id -> 内联 SVG（只含规则用到的）
        const AI_ICON_COLOR = "#519aba";   // 规则没写颜色时 AI 图标的默认色（SVG 用 currentColor 上色）
        // 阿里图标库：把后台配置的 CSS 注入页面（图标字形要靠它），每份只注入一次
        function _injectIconfont(l) {
            if (!l || !l.url) return;
            if (document.querySelector('link[data-ali-icon="' + l.url + '"]')) return;
            const lk = document.createElement("link");
            lk.rel = "stylesheet";
            lk.href = l.url;
            lk.setAttribute("data-ali-icon", l.url);
            document.head.appendChild(lk);
        }
        function _loadCustomIcons() {
            fetch("/api/icons/custom")
                .then(r => r.ok ? r.json() : null)
                .then(d => {
                    if (!d) return;
                    (d.iconfont || []).forEach(_injectIconfont);
                    AI_SVG = d.ai || {};        // AI 图标的 SVG 内容随规则一起下发
                    if (!d.rules) return;
                    const exts = {}, names = {};
                    d.rules.forEach(function (r) {
                        if (!r || !r.value || !r.icon) return;
                        if (r.match === "name") names[r.value] = r; else exts[r.value] = r;
                    });
                    CUSTOM_ICONS = { ext: exts, name: names };
                    if (typeof applyFiltersAndSort === "function" && fileItems.length) applyFiltersAndSort();
                })
                .catch(function () { /* 未登录 / 接口不可用：忽略，用内置图标 */ });
        }
        function customRuleFor(item) {
            if (!item) return null;
            const lower = String(item.name || "").toLowerCase();
            return CUSTOM_ICONS.name[lower] || CUSTOM_ICONS.ext[fileExtOf(item)] || null;
        }
        // 规则里的图标：bi-xxx = Bootstrap 图标；其余当作 Seti 图标键
        function ruleGlyphHtml(rule, extraClass) {
            const cls = extraClass ? " " + extraClass : "";
            const icon = String(rule.icon || "");
            const color = rule.color || "";
            if (icon.indexOf("ai:") === 0) {    // 后台 AI 生成的图标：ai:ai_xxx（内联 SVG）
                const e = AI_SVG[icon.slice(3)];
                if (!e || !e.svg) return "";
                // keep=true（生成时选了「保留原色」）用 SVG 自己的配色；否则显式给颜色，
                // 不给就会继承正文灰色，看着像「没有颜色」
                const c = e.keep ? "" : (color || AI_ICON_COLOR);
                return `<span class="ai-ic${cls}"${c ? ` style="color:${c}"` : ""}>${e.svg}</span>`;
            }
            if (icon.indexOf("ali:") === 0) {   // 阿里图标库：ali:icon-xxx
                return `<i class="iconfont ${icon.slice(4)}${cls}"${color ? ` style="color:${color}"` : ""}></i>`;
            }
            if (icon.indexOf("bi-") === 0) {
                return `<i class="bi ${icon}${cls}"${color ? ` style="color:${color}"` : ""}></i>`;
            }
            const def = SETI && SETI.defs ? SETI.defs[icon] : null;
            if (def && def.fontCharacter) {
                const code = String(def.fontCharacter).replace(/\\+/g, "");
                return `<span class="seti-ic${cls}" style="color:${color || def.fontColor || "#9da8ab"}">&#x${code};</span>`;
            }
            return "";   // Seti 数据还没到：先退回内置图标，数据到位后会重绘
        }

        // 取扩展名（列表项自带 ext，没有就从文件名里切）
        function fileExtOf(item) {
            let ext = String((item && item.ext) || '').toLowerCase();
            if (!ext && item && item.name) {
                const nm = String(item.name);
                const dot = nm.lastIndexOf('.');
                ext = dot > 0 ? nm.slice(dot + 1).toLowerCase() : '';
            }
            return ext;
        }
        // 按 seti 规则解析出图标定义：文件名 → 扩展名 → 语言 ID
        function setiIconDef(name, ext) {
            const lower = String(name || "").toLowerCase();
            const key = SHEET_ICON_ALIAS[ext] || ext;
            let def = SETI.defs[SETI.names[lower]] || SETI.defs[SETI_NAME_ALIAS[lower]] || SETI.defs[SETI.exts[key]];
            if (!def && SETI_LANG[ext]) def = SETI.defs[SETI.langs[SETI_LANG[ext]]];
            return def || null;
        }

        /* 兜底图标：返回 [Bootstrap 图标类, 颜色] */
        function fileIconFallback(item) {
            if (!item) return ["bi-file-earmark", "#8a8a8a"];
            const ext = fileExtOf(item);
            if (ext && FILE_ICON_MAP[ext]) return FILE_ICON_MAP[ext];
            const lname = String(item.name || '').toLowerCase();
            if (FILE_NAME_ICONS[lname]) return FILE_NAME_ICONS[lname];
            if (lname.startsWith("readme")) return ["bi-file-text", "#6d8086"];
            if (lname.startsWith(".")) return ["bi-file-earmark", "#6d8086"];   // 其它隐藏文件
            return ["bi-file-earmark", "#8a8a8a"];                              // 认不出来：灰色通用文件
        }

        /* 统一入口：返回图标 HTML —— 优先 seti（与 IDE 文件树完全一致），未命中 / 未加载时用彩色 Bootstrap 图标。
           extraClass 用来带各视图自己的尺寸类（file-icon / tree-icon …）。 */
        function fileIconHtml(item, extraClass) {
            const cls = extraClass ? " " + extraClass : "";
            if (item && item.is_dir) return `<i class="bi bi-folder-fill text-warning${cls}"></i>`;
            if (item) {
                const rule = customRuleFor(item);    // 后台自定义规则优先级最高
                if (rule) {
                    const h = ruleGlyphHtml(rule, extraClass);
                    if (h) return h;
                }
                if (SETI) {
                    const def = setiIconDef(item.name, fileExtOf(item));
                    if (def && def.fontCharacter) {
                        const code = String(def.fontCharacter).replace(/\\+/g, "");
                        return `<span class="seti-ic${cls}" style="color:${def.fontColor || "#9da8ab"}">&#x${code};</span>`;
                    }
                }
            }
            const fb = fileIconFallback(item);
            return `<i class="bi ${fb[0]}${cls}" style="color:${fb[1]}"></i>`;
        }
        // 列表视图用（行内小图标）
        function getFileIcon(item) {
            return fileIconHtml(item, "file-icon");
        }
        _loadSetiIcons();     // 启动就去取图标数据（几十 KB），到位后自动按 seti 重绘一次
        _loadCustomIcons();   // 后台配置的自定义图标规则（未登录 / 无规则时静默忽略）

        function getTypeBadge(item) {
            if (item.is_dir) return `<span class="file-type-badge dir">📁 目录</span>`;
            return `<span class="file-type-badge">${item.type || '未知'}</span>`;
        }

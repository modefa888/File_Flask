  /* ================================================================
     代码补全 / 智能提示（仿 VS Code IntelliSense）
     ----------------------------------------------------------------
     候选来源（按优先级从高到低）：
       ① 当前文件里定义的符号（def / class / function / const / import 名 …）
       ② 当前语言的关键字与内置对象
       ③ 常用标准库 / 框架的模块成员表、常见类的成员表
       ④ 「.」之后按对象类型补全成员（self. / 模块别名. / 已知类实例.）
       ⑤ 文档中出现过的单词（兜底：就是「编辑器里已经打过的词」）
     触发方式：
       · 输入标识符字符或「.」时自动弹出（设置里可关）
       · Ctrl+Space（或 Alt+/）手动弹出
     依赖 CodeMirror 官方 show-hint 插件（vendor/codemirror/show-hint.min.js）。
     ================================================================ */

  /* ---------- 候选类型：图标 + 中文名（图标风格对齐 VS Code 的字母块） ---------- */
  const CMP_KIND_CN = { f: "函数", m: "方法", c: "类", v: "变量", p: "属性", o: "模块", k: "关键字", d: "常量" };
  const CMP_KIND_ICON = { f: "ƒ", m: "ƒ", c: "C", v: "abc", p: "F", o: "M", k: "K", d: "=" };

  /* ---------- 语言判定：扩展名 → 语言代号 ---------- */
  const CMP_EXT_LANG = {
    py: "py", pyw: "py", pyi: "py",
    js: "js", jsx: "js", mjs: "js", cjs: "js", ts: "js", tsx: "js", vue: "js",
    html: "html", htm: "html", xhtml: "html",
    css: "css", scss: "css", less: "css",
    json: "json", jsonc: "json",
    md: "md", markdown: "md", mdx: "md",
    sql: "sql",
    sh: "sh", bash: "sh", zsh: "sh", ksh: "sh",
    yml: "yaml", yaml: "yaml",
    php: "php", java: "java", go: "go", rb: "ruby", lua: "lua",
    c: "c", h: "c", cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp",
    rs: "rs", xml: "xml", svg: "xml",
    properties: "properties", ini: "properties", cfg: "properties", conf: "properties", env: "properties",
    dockerfile: "properties", gitignore: "properties", txt: "text",
  };
  function cmpLangOf(ext) { return CMP_EXT_LANG[String(ext || "").toLowerCase()] || "text"; }

  /* ---------- 关键字 / 内置对象表 ---------- */
  const _w = (s) => String(s).split(/\s+/).filter(Boolean);

  const CMP_LANG_KW = {
    py: _w("False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case"),
    js: _w("await async break case catch class const continue debugger default delete do else export extends finally for function if import in instanceof let new of return static super switch this throw try typeof var void while with yield true false null undefined NaN Infinity delete get set"),
    sql: _w("SELECT FROM WHERE INSERT INTO VALUES UPDATE SET DELETE CREATE TABLE VIEW INDEX DROP ALTER ADD COLUMN PRIMARY KEY FOREIGN REFERENCES NOT NULL DEFAULT UNIQUE CHECK JOIN LEFT RIGHT INNER OUTER FULL CROSS ON AS AND OR IN BETWEEN LIKE IS EXISTS GROUP BY ORDER HAVING LIMIT OFFSET DISTINCT UNION ALL CASE WHEN THEN ELSE END WITH RECURSIVE BEGIN COMMIT ROLLBACK TRANSACTION IF EXISTS AUTOINCREMENT INTEGER TEXT REAL BLOB NUMERIC VARCHAR DATE DATETIME BOOLEAN CAST COUNT SUM AVG MIN MAX UPPER LOWER LENGTH TRIM SUBSTR ROUND COALESCE NULLIF"),
    sh: _w("if then else elif fi for while do done case esac function return break continue local export readonly declare unset shift source echo printf read cd pwd ls cp mv rm mkdir rmdir touch cat head tail grep sed awk find xargs sort uniq cut tr wc chmod chown ps kill curl wget tar gzip zip unzip git python python3 pip node npm npx docker systemctl sudo test exit set trap eval exec"),
    php: _w("function class extends implements public private protected static return if else elseif endif foreach as while for switch case default break continue try catch finally throw new clone namespace use require require_once include include_once echo print isset unset empty array list global const define abstract interface trait instanceof clone yield match fn"),
    java: _w("public private protected static final abstract synchronized volatile transient native class interface enum extends implements import package return if else for while do switch case default break continue try catch finally throw throws new this super instanceof null true false void int long double float boolean char String byte short var record"),
    go: _w("package import func var const type struct interface map chan go defer select range return if else for switch case default break continue fallthrough goto nil true false make new len cap append copy delete panic recover close string int int64 float64 bool byte rune error"),
    ruby: _w("def end class module if elsif else unless while until for in do begin rescue ensure raise return yield break next redo retry self nil true false and or not require require_relative attr_accessor attr_reader attr_writer include extend lambda proc puts print p new"),
    lua: _w("local function end if then elseif else for while do repeat until return break nil true false and or not in pairs ipairs require print type tostring tonumber table string math io os error pcall setmetatable getmetatable self"),
    c: _w("int char float double void long short signed unsigned struct union enum typedef const static extern register volatile sizeof return if else for while do switch case default break continue goto NULL include define ifdef ifndef endif pragma"),
    cpp: _w("int char float double void long short signed unsigned bool struct class union enum typedef const static extern inline virtual override final template typename namespace using public private protected new delete this return if else for while do switch case default break continue try catch throw nullptr auto friend operator explicit constexpr mutable noexcept"),
    rs: _w("fn let mut const static struct enum impl trait for while loop match if else return use mod pub crate self super as where dyn ref move async await unsafe extern type in break continue Box Vec String Option Some None Result Ok Err println"),
    css: _w("display position top right bottom left width height min-width max-width min-height max-height margin padding border border-radius background background-color background-image color font font-size font-weight font-family line-height text-align text-decoration text-transform letter-spacing white-space overflow overflow-x overflow-y opacity z-index box-shadow transform transition animation flex flex-direction justify-content align-items align-content align-self gap grid grid-template-columns cursor content visibility box-sizing object-fit filter backdrop-filter user-select pointer-events none auto block inline flex grid absolute relative fixed sticky hidden visible solid dashed dotted transparent center left right nowrap relative"),
    properties: _w("true false null"),
    json: _w("true false null"),
    yaml: _w("true false null yes no on off"),
  };

  // Python 内置函数 / 异常 / 魔术方法（kind: f 函数、c 类）
  const CMP_PY_BUILTIN = _w("abs aiter all anext any ascii bin bool breakpoint bytearray bytes callable chr classmethod compile complex delattr dict dir divmod enumerate eval exec filter float format frozenset getattr globals hasattr hash help hex id input int isinstance issubclass iter len list locals map max memoryview min next object oct open ord pow print property range repr reversed round set setattr slice sorted staticmethod str sum super tuple type vars zip");
  const CMP_PY_EXC = _w("Exception BaseException ValueError TypeError KeyError IndexError AttributeError RuntimeError StopIteration StopAsyncIteration FileNotFoundError OSError ImportError ModuleNotFoundError NameError ZeroDivisionError NotImplementedError PermissionError TimeoutError ConnectionError UnicodeDecodeError SystemExit KeyboardInterrupt Warning DeprecationWarning");
  const CMP_PY_MAGIC = _w("__init__ __str__ __repr__ __len__ __iter__ __next__ __enter__ __exit__ __call__ __eq__ __ne__ __lt__ __hash__ __contains__ __getitem__ __setitem__ __getattr__ __setattr__ __name__ __main__ __file__ __doc__ __dict__ __slots__ __all__ __version__");

  // JS 全局对象
  const CMP_JS_GLOBAL = _w("console document window globalThis Math JSON Object Array String Number Boolean Symbol BigInt Promise Map Set WeakMap WeakSet Date RegExp Error TypeError RangeError SyntaxError ReferenceError EvalError URIError ArrayBuffer DataView Int8Array Uint8Array Uint8ClampedArray Int16Array Uint16Array Int32Array Uint32Array Float32Array Float64Array BigInt64Array Proxy Reflect Intl Atomics fetch Request Response Headers FormData URL URLSearchParams Blob File FileReader AbortController AbortSignal TextEncoder TextDecoder localStorage sessionStorage navigator location history crypto performance setTimeout setInterval clearTimeout clearInterval queueMicrotask requestAnimationFrame cancelAnimationFrame structuredClone parseInt parseFloat isNaN isFinite encodeURIComponent decodeURIComponent encodeURI decodeURI alert confirm prompt btoa atob");

  /* ---------- 模块成员表：模块名 → 成员（空格分隔） ---------- */
  const CMP_PY_MODULES = {
    os: "getcwd chdir listdir scandir mkdir makedirs rmdir removedirs remove rename replace walk stat lstat access chmod getenv putenv environ sep linesep pathsep curdir pardir devnull name path system popen getpid getppid getuid cpu_count urandom link symlink readlink fspath fsencode fsdecode utime truncate path",
    "os.path": "join split splitext splitdrive basename dirname abspath realpath exists isfile isdir islink ismount getsize getmtime getctime samefile isabs normpath relpath expanduser expandvars commonprefix sep altsep",
    sys: "argv path exit stdin stdout stderr version version_info platform maxsize modules executable byteorder getrecursionlimit setrecursionlimit getsizeof getdefaultencoding getfilesystemencoding settrace implementation flags ps1 ps2",
    json: "load loads dump dumps JSONDecodeError JSONEncoder JSONDecoder",
    re: "match fullmatch search findall finditer sub subn split compile escape purge Pattern Match IGNORECASE MULTILINE DOTALL VERBOSE ASCII UNICODE",
    time: "time sleep localtime gmtime mktime strftime strptime asctime ctime perf_counter monotonic process_time time_ns struct_time",
    datetime: "datetime date time timedelta timezone tzinfo now utcnow today strptime strftime fromtimestamp fromisoformat isoformat combine astimezone timestamp",
    pathlib: "Path PurePath PosixPath WindowsPath PurePosixPath PureWindowsPath",
    math: "ceil floor sqrt pow exp log log2 log10 sin cos tan asin acos atan atan2 pi e tau inf nan factorial gcd lcm fsum isclose hypot degrees radians dist prod comb perm",
    random: "random randint randrange choice choices shuffle sample uniform gauss seed getrandbits triangular randbytes betavariate expovariate gammavariate",
    subprocess: "run Popen call check_call check_output getoutput getstatusoutput PIPE STDOUT DEVNULL CalledProcessError CompletedProcess TimeoutExpired",
    shutil: "copy copy2 copyfile copymode copystat copytree move rmtree make_archive unpack_archive get_archive_formats which disk_usage chown",
    io: "open BytesIO StringIO TextIOWrapper BufferedReader BufferedWriter FileIO SEEK_SET SEEK_CUR SEEK_END",
    glob: "glob iglob escape has_magic",
    csv: "reader writer DictReader DictWriter register_dialect unregister_dialect get_dialect field_size_limit QUOTE_MINIMAL QUOTE_ALL excel tab",
    sqlite3: "connect complete Connection Cursor Row Error IntegrityError OperationalError ProgrammingError PARSE_DECLTYPES PARSE_COLNAMES version",
    urllib: "request parse error robotparser",
    "urllib.parse": "urlparse urlunparse urlsplit urlunsplit urljoin urlencode parse_qs parse_qsl quote unquote quote_plus unquote_plus urldefrag",
    "urllib.request": "urlopen Request build_opener install_opener urlretrieve urlcleanup ProxyHandler HTTPHandler HTTPSHandler",
    hashlib: "md5 sha1 sha224 sha256 sha384 sha512 new pbkdf2_hmac scrypt file_digest blake2b blake2s algorithms_available algorithms_guaranteed",
    base64: "b64encode b64decode urlsafe_b64encode urlsafe_b64decode b32encode b32decode b16encode b16decode encodebytes decodebytes standard_b64encode standard_b64decode",
    logging: "getLogger basicConfig debug info warning error critical exception log disable shutdown addLevelName getLevelName FileHandler StreamHandler Formatter Handler Logger NOTSET DEBUG INFO WARNING ERROR CRITICAL",
    threading: "Thread Lock RLock Event Condition Semaphore BoundedSemaphore Timer Barrier current_thread main_thread active_count enumerate get_ident local",
    asyncio: "run create_task gather wait wait_for sleep ensure_future get_event_loop new_event_loop set_event_loop Queue Lock Event Semaphore StreamReader StreamWriter start_server open_connection to_thread CancelledError TimeoutError",
    typing: "List Dict Tuple Set FrozenSet Optional Union Any Callable Iterable Iterator Sequence Mapping MutableMapping TypeVar Generic NewType Literal Final ClassVar Protocol TypedDict Annotated cast overload get_type_hints",
    dataclasses: "dataclass field asdict astuple replace fields is_dataclass make_dataclass InitVar KW_ONLY",
    collections: "OrderedDict defaultdict Counter deque namedtuple ChainMap UserDict UserList UserString abc",
    itertools: "count cycle repeat chain compress dropwhile takewhile filterfalse groupby starmap product permutations combinations combinations_with_replacement accumulate tee islice zip_longest pairwise batched",
    functools: "wraps lru_cache cache partial partialmethod reduce cmp_to_key total_ordering cached_property singledispatch singledispatchmethod",
    argparse: "ArgumentParser Namespace Action FileType ArgumentGroup RawTextHelpFormatter ArgumentDefaultsHelpFormatter BooleanOptionalAction SUPPRESS",
    unittest: "TestCase main mock skip skipIf expectedFailure assertEqual assertTrue assertRaises assertIn assertIsNone",
    pytest: "fixture mark raises approx skip parametrize main warns",
    requests: "get post put patch delete head options request Session session Response HTTPError ConnectionError Timeout TooManyRedirects exceptions codes",
    flask: "Flask Blueprint request jsonify render_template render_template_string redirect url_for session make_response abort flash send_file send_from_directory current_app g stream_with_context Response Request copy_current_request_context",
    numpy: "array asarray arange linspace logspace zeros ones zeros_like ones_like eye identity empty full random mean median std var sum prod cumsum cumprod min max argmin argmax sort argsort unique where concatenate stack hstack vstack split reshape transpose expand_dims squeeze dot matmul inner outer linalg fft clip round abs sqrt exp log sin cos tan floor ceil isnan isinf logical_and logical_or ndarray float64 int64",
    pandas: "DataFrame Series read_csv read_excel read_json read_sql read_table read_parquet concat merge join pivot_table crosstab to_datetime to_numeric date_range isna notna isnull notnull unique factorize get_dummies Index MultiIndex Timestamp Timedelta Categorical melt wide_to_long set_option reset_option",
  };

  /* ---------- 常见类的成员表：类名 → 成员 ---------- */
  const CMP_PY_MEMBERS = {
    Path: "cwd home expanduser exists is_file is_dir is_symlink is_socket is_fifo is_block_device is_char_device is_mount is_absolute is_relative_to iterdir glob rglob walk mkdir rmdir unlink touch stat lstat chmod samefile rename replace resolve absolute read_text write_text read_bytes write_bytes open joinpath with_name with_stem with_suffix relative_to match as_posix as_uri owner group hardlink_to link_to symlink_to readlink name stem suffix suffixes parent parents parts root anchor drive",
    ArgumentParser: "add_argument add_argument_group add_mutually_exclusive_group add_subparsers parse_args parse_known_args parse_intermixed_args error exit print_help print_usage format_help format_usage set_defaults get_default register description epilog prog usage",
    Flask: "route add_url_rule register_blueprint get post put delete patch before_request after_request teardown_request errorhandler register_error_handler run test_client test_request_context app_context request_context jinja_env config url_map static_folder template_folder json",
    DataFrame: "head tail info describe shape columns index dtypes values loc iloc at iat to_dict to_csv to_excel to_json to_sql to_numpy to_string sort_values sort_index groupby agg aggregate apply map drop dropna fillna isnull notnull isin merge join pivot pivot_table reset_index set_index rename astype copy sample query where mask assign insert pop iterrows itertuples drop_duplicates duplicated nlargest nsmallest corr cov plot",
    Series: "head tail describe shape index values loc iloc to_dict to_list to_frame to_csv map apply astype drop dropna fillna isnull notnull isin value_counts unique nunique sort_values sort_index sum mean median std var min max idxmin idxmax cumsum shift rolling diff pct_change between clip round replace where mask rename",
    Counter: "most_common elements subtract update total copy clear keys values items get pop setdefault",
    deque: "append appendleft pop popleft extend extendleft rotate clear count index insert remove maxlen reverse copy",
    Thread: "start join run is_alive daemon name ident native_id",
    Match: "group groups groupdict start end span expand",
  };

  /* ---------- JS 全局对象成员表 ---------- */
  const CMP_JS_MEMBERS = {
    console: "log info warn error debug table trace dir group groupEnd groupCollapsed time timeEnd timeLog count countReset assert clear",
    document: "getElementById querySelector querySelectorAll createElement createElementNS createTextNode createDocumentFragment getElementsByClassName getElementsByTagName addEventListener removeEventListener body head documentElement title cookie location readyState write writeln execCommand activeElement hidden visibilityState createRange implementation documentElement",
    window: "addEventListener removeEventListener setTimeout setInterval clearTimeout clearInterval requestAnimationFrame cancelAnimationFrame fetch alert confirm prompt open close scrollTo scrollBy scrollIntoView innerWidth innerHeight outerWidth outerHeight location localStorage sessionStorage history navigator document matchMedia getComputedStyle requestIdleCallback postMessage devicePixelRatio",
    Math: "abs ceil floor round trunc sign max min pow sqrt cbrt exp log log2 log10 sin cos tan asin acos atan atan2 hypot random imul clz32 fround PI E LN2 LN10 LOG2E LOG10E SQRT2 SQRT1_2",
    JSON: "parse stringify",
    Object: "keys values entries assign fromEntries create defineProperty defineProperties getOwnPropertyNames getOwnPropertyDescriptor getPrototypeOf setPrototypeOf freeze isFrozen seal isSealed preventExtensions isExtensible prototype hasOwn is",
    Array: "from of isArray fromAsync prototype",
    String: "fromCharCode fromCodePoint raw prototype",
    Number: "isInteger isFinite isNaN parseFloat parseInt MAX_SAFE_INTEGER MIN_SAFE_INTEGER EPSILON MAX_VALUE MIN_VALUE isSafeInteger",
    Promise: "resolve reject all allSettled any race withResolvers",
    Date: "now parse UTC",
    localStorage: "getItem setItem removeItem clear key length",
    sessionStorage: "getItem setItem removeItem clear key length",
    location: "href protocol host hostname port pathname search hash origin assign replace reload toString",
    history: "pushState replaceState back forward go length state",
    navigator: "userAgent language languages platform clipboard geolocation onLine hardwareConcurrency",
    performance: "now mark measure getEntriesByName getEntriesByType timeOrigin",
    Map: "set get has delete clear size forEach keys values entries",
    Set: "add has delete clear size forEach keys values entries",
    URLSearchParams: "get getAll set append delete has toString entries keys values sort",
    fetch: "then catch finally",
  };

  /* ================================================================
     一、文档扫描：符号 / 单词 / 变量类型推断
     ================================================================ */

  // 从源码里抠出「定义的符号」。都是启发式正则：够用、不追求编译器级精度。
  function cmpExtractSymbols(text, lang) {
    const out = [];
    const seen = Object.create(null);
    const add = (name, kind, detail) => {
      if (!name || !/^[A-Za-z_$\u4e00-\u9fff][\w$\u4e00-\u9fff]*$/.test(name)) return;
      const key = kind + ":" + name;
      if (seen[key]) return;
      seen[key] = 1;
      out.push({ text: name, kind: kind, detail: detail || "" });
    };
    let m;
    if (lang === "py") {
      const reDef = /^([ \t]*)(?:async[ \t]+)?def[ \t]+([A-Za-z_]\w*)[ \t]*(\([^)\n]*\))?/gm;
      while ((m = reDef.exec(text))) add(m[2], m[1] ? "m" : "f", "def " + m[2] + (m[3] || "()"));
      const reCls = /^([ \t]*)class[ \t]+([A-Za-z_]\w*)/gm;
      while ((m = reCls.exec(text))) add(m[2], "c", "class " + m[2]);
      const reImp = /^[ \t]*import[ \t]+([^\n#]+)/gm;
      while ((m = reImp.exec(text))) {
        m[1].split(",").forEach(p => {
          const t = p.trim(); if (!t) return;
          const parts = t.split(/\s+as\s+/);
          add((parts[1] || parts[0].split(".")[0]).trim(), "o", "import " + parts[0].trim());
        });
      }
      const reFrom = /^[ \t]*from[ \t]+([\w.]+)[ \t]+import[ \t]+([^\n#]+)/gm;
      while ((m = reFrom.exec(text))) {
        m[2].replace(/[()]/g, "").split(",").forEach(p => {
          const t = p.trim(); if (!t || t === "*") return;
          const parts = t.split(/\s+as\s+/);
          add((parts[1] || parts[0]).trim(), "v", "from " + m[1] + " import " + parts[0].trim());
        });
      }
      const reVar = /^[ \t]*([A-Za-z_]\w*)[ \t]*(?::[^=\n]+)?=[^=]/gm;
      while ((m = reVar.exec(text))) add(m[1], "v", "");
      const reSelf = /^[ \t]+self\.([A-Za-z_]\w*)[ \t]*=[^=]/gm;
      while ((m = reSelf.exec(text))) add(m[1], "p", "实例属性");
    } else if (lang === "js") {
      const reFn = /(?:^|[\s;{(,=])(?:async[ \t]+)?function[ \t]+([A-Za-z_$][\w$]*)[ \t]*(\([^)\n]*\))?/g;
      while ((m = reFn.exec(text))) add(m[1], "f", "function " + m[1] + (m[2] || "()"));
      const reCls = /(?:^|[\s;{])(?:export[ \t]+)?(?:default[ \t]+)?class[ \t]+([A-Za-z_$][\w$]*)/g;
      while ((m = reCls.exec(text))) add(m[1], "c", "class " + m[1]);
      const reVar = /(?:^|[\s;{(,])(?:export[ \t]+)?(?:const|let|var)[ \t]+([A-Za-z_$][\w$]*)/g;
      while ((m = reVar.exec(text))) add(m[1], "v", "");
      const reMethod = /^[ \t]+(?:async[ \t]+)?([A-Za-z_$][\w$]*)[ \t]*\([^)\n]*\)[ \t]*\{/gm;
      while ((m = reMethod.exec(text))) add(m[1], "m", "");
      const reKey = /^[ \t]*["']?([A-Za-z_$][\w$-]*)["']?[ \t]*:/gm;   // 对象字面量 / JSON 键
      while ((m = reKey.exec(text))) add(m[1], "p", "");
    } else if (lang === "md") {
      const reH = /^#{1,6}[ \t]+(.+?)[ \t]*#*$/gm;
      while ((m = reH.exec(text))) add(m[1].trim(), "c", "标题");
    } else if (lang === "sql") {
      const reT = /\bCREATE[ \t]+(?:TEMP(?:ORARY)?[ \t]+)?(?:TABLE|VIEW|INDEX)[ \t]+(?:IF[ \t]+NOT[ \t]+EXISTS[ \t]+)?["'`]?([\w.]+)/gi;
      while ((m = reT.exec(text))) add(m[1], "c", "表 / 视图");
      const reF = /\b(?:AS|FUNCTION)[ \t]+([\w]+)[ \t]*\(/gi;
      while ((m = reF.exec(text))) add(m[1], "f", "");
    } else if (lang === "css") {
      const reSel = /^[ \t]*([.#][\w-]+)/gm;
      while ((m = reSel.exec(text))) add(m[1], "c", "选择器");
      const reVar = /--([\w-]+)[ \t]*:/g;
      while ((m = reVar.exec(text))) add("--" + m[1], "v", "CSS 变量");
    } else if (lang === "html") {
      const reId = /\bid=["']([^"']+)["']/g;
      while ((m = reId.exec(text))) add(m[1], "v", "id");
      const reCls = /\bclass=["']([^"']+)["']/g;
      while ((m = reCls.exec(text))) String(m[1]).split(/\s+/).forEach(c => add(c, "v", "class"));
    }
    return out;
  }

  // 文档里出现过的单词（按出现次数排序，截断上限，避免大文件卡顿）
  function cmpScanWords(text) {
    const re = /[A-Za-z_$\u4e00-\u9fff][\w$\u4e00-\u9fff]*/g;
    const cnt = Object.create(null);
    let m, n = 0;
    while ((m = re.exec(text))) {
      const w = m[0];
      if (w.length < 2) continue;
      cnt[w] = (cnt[w] || 0) + 1;
      if (++n > 60000) break;
    }
    const keys = Object.keys(cnt);
    keys.sort((a, b) => cnt[b] - cnt[a] || a.length - b.length || (a < b ? -1 : 1));
    return keys.slice(0, 4000).map(w => ({ text: w, freq: cnt[w] }));
  }

  // 变量 → 类型/模块 的推断表（用于「obj.」成员补全）
  function cmpAliasMap(text, lang) {
    const map = Object.create(null);
    let m;
    if (lang === "py") {
      const reImp = /^[ \t]*import[ \t]+([^\n#]+)/gm;
      while ((m = reImp.exec(text))) {
        m[1].split(",").forEach(p => {
          const t = p.trim(); if (!t) return;
          const parts = t.split(/\s+as\s+/);
          const mod = parts[0].trim();
          const alias = (parts[1] || mod.split(".")[0]).trim();
          if (/^[A-Za-z_]\w*$/.test(alias)) map[alias] = { mod: mod };
        });
      }
      const reFrom = /^[ \t]*from[ \t]+([\w.]+)[ \t]+import[ \t]+([^\n#]+)/gm;
      while ((m = reFrom.exec(text))) {
        const mod = m[1];
        m[2].replace(/[()]/g, "").split(",").forEach(p => {
          const t = p.trim(); if (!t || t === "*") return;
          const parts = t.split(/\s+as\s+/);
          const orig = parts[0].trim();
          const nm = (parts[1] || orig).trim();
          if (!/^[A-Za-z_]\w*$/.test(nm)) return;
          map[nm] = CMP_PY_MEMBERS[orig] ? { cls: orig } : { mod: mod + "." + orig };
        });
      }
      // 变量 = 调用（按被调用者猜类型）：parser = argparse.ArgumentParser(…) / p = Path(…)
      const reCall = /^[ \t]*([A-Za-z_]\w*)[ \t]*=[ \t]*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)[ \t]*\(/gm;
      while ((m = reCall.exec(text))) {
        const v = m[1], fn = m[2], last = fn.split(".").pop();
        if (CMP_PY_MEMBERS[last]) map[v] = { cls: last };
        else if (!map[v]) map[v] = { mod: fn.replace(/\.[A-Za-z_]\w*$/, "") };
      }
      const reAsn = /^[ \t]*([A-Za-z_]\w*)[ \t]*=[ \t]*([A-Za-z_]\w*)[ \t]*$/gm;
      while ((m = reAsn.exec(text))) if (CMP_PY_MODULES[m[2]] && !map[m[1]]) map[m[1]] = { mod: m[2] };
    } else if (lang === "js") {
      const reNew = /(?:^|[\s;{(,])(?:const|let|var)[ \t]+([A-Za-z_$][\w$]*)[ \t]*=[ \t]*new[ \t]+([A-Za-z_$][\w$]*)/g;
      while ((m = reNew.exec(text))) map[m[1]] = { cls: m[2] };
      const reLib = /(?:^|[\s;,{])(?:const|let|var)[ \t]+([A-Za-z_$][\w$]*)[ \t]*=[ \t]*([A-Za-z_$][\w$]*)[ \t]*[;\n]/g;
      while ((m = reLib.exec(text))) if (CMP_JS_MEMBERS[m[2]] && !map[m[1]]) map[m[1]] = { mod: m[2] };
    }
    return map;
  }

  // 文档索引（符号 + 单词 + 类型推断），按「文档是否改动」缓存，避免每次按键全量重扫
  function cmpIndex(cm, lang) {
    let rec = cm._cmpIdx;
    if (rec && !cm._cmpIdxDirty && rec.lang === lang) return rec;
    const text = cm.getValue();
    const small = text.length <= 800 * 1024;      // 超大文件放弃索引，只补全关键字
    rec = {
      lang: lang,
      symbols: small ? cmpExtractSymbols(text, lang) : [],
      words: small ? cmpScanWords(text) : [],
      map: small ? cmpAliasMap(text, lang) : Object.create(null),
    };
    cm._cmpIdx = rec;
    cm._cmpIdxDirty = false;
    return rec;
  }

  /* ================================================================
     二、匹配与排序（前缀 > 忽略大小写前缀 > 驼峰缩写 > 模糊子序列）
     ================================================================ */

  function cmpMatch(name, prefix) {
    if (!prefix) return { tier: 0, pos: [] };
    const n = String(name), p = String(prefix);
    if (n.startsWith(p)) {
      const pos = []; for (let i = 0; i < p.length; i++) pos.push(i);
      return { tier: 0, pos: pos };
    }
    const nl = n.toLowerCase(), pl = p.toLowerCase();
    if (nl.startsWith(pl)) {
      const pos = []; for (let i = 0; i < p.length; i++) pos.push(i);
      return { tier: 1, pos: pos };
    }
    // 驼峰 / 下划线缩写：pa → parse_args（取每个词的首字母）
    const heads = [];
    for (let i = 0; i < n.length; i++) {
      const c = n[i];
      if (i === 0 || c === "_" || c === "$" || c === "-" ||
          (/[A-Z]/.test(c) && /[a-z0-9]/.test(n[i - 1] || ""))) heads.push(i);
    }
    const initials = heads.map(i => n[i].toLowerCase()).join("");
    if (initials.startsWith(pl)) {
      return { tier: 2, pos: heads.slice(0, p.length) };
    }
    // 模糊：按顺序逐个命中（允许跳过字符）
    const pos = [];
    let k = 0, gap = 0;
    for (let i = 0; i < n.length && k < p.length; i++) {
      if (n[i].toLowerCase() === pl[k]) { pos.push(i); k++; gap = 0; }
      else if (++gap > 14) return null;
    }
    if (k < p.length) return null;
    return { tier: 3, pos: pos };
  }

  /* ================================================================
     三、候选列表构建
     ================================================================ */

  function cmpFromTable(str, kind, detail) {
    return _w(str).map(n => ({ text: n, kind: kind, detail: detail || "" }));
  }

  // 按前缀过滤 + 排序。rank 数值越小越靠前。
  function cmpRank(cands, prefix, limit) {
    const best = new Map();
    for (const c of cands) {
      const mt = cmpMatch(c.text, prefix);
      if (!mt) continue;
      const score = mt.tier * 10000 + (c.weight || 0) * 500 + Math.max(0, 60 - Math.min(60, c.freq || 1)) * 3
        + Math.min(c.text.length, 40) + (c.freq ? -Math.min(30, c.freq) : 0);
      const prev = best.get(c.text);
      if (prev === undefined || score < prev.score) best.set(c.text, { c: c, score: score, pos: mt.pos });
    }
    const arr = Array.from(best.values());
    arr.sort((a, b) => a.score - b.score || (a.c.text < b.c.text ? -1 : a.c.text > b.c.text ? 1 : 0));
    return arr.slice(0, limit || 200).map(r => Object.assign({}, r.c, { pos: r.pos }));
  }

  // 通用补全（没有「.」的场景）
  function cmpGeneral(cm, lang, prefix) {
    const idx = cmpIndex(cm, lang);
    const cands = [];
    // ① 文件内定义的符号：权重最高
    for (const s of idx.symbols) cands.push({ text: s.text, kind: s.kind, detail: s.detail, weight: 0 });
    // ② 关键字 / 内置对象
    const kws = CMP_LANG_KW[lang] || [];
    for (const k of kws) cands.push({ text: k, kind: "k", detail: "", weight: 1 });
    if (lang === "py") {
      for (const b of CMP_PY_BUILTIN) cands.push({ text: b, kind: "f", detail: "内置函数", weight: 2 });
      for (const b of CMP_PY_EXC) cands.push({ text: b, kind: "c", detail: "内置异常", weight: 2 });
      for (const b of CMP_PY_MAGIC) cands.push({ text: b, kind: "m", detail: "魔术方法", weight: 2 });
    } else if (lang === "js") {
      for (const b of CMP_JS_GLOBAL) cands.push({ text: b, kind: "v", detail: "全局对象", weight: 2 });
    }
    // ③ 文档里出现过的单词：兜底（就是「你已经打过的词」）
    for (const w of idx.words) cands.push({ text: w.text, kind: "v", detail: "", weight: 3, freq: w.freq });
    return cmpRank(cands, prefix, 200);
  }

  // 当前光标所在 Python 类的成员（self. / cls. 用）
  function cmpPyClassMembers(cm, cur) {
    const lines = cm.getValue().split("\n");
    const curIndent = ((lines[cur.line] || "").match(/^[ \t]*/) || [""])[0].length;
    let clsName = "", clsLine = -1, clsIndent = -1;
    for (let i = Math.min(cur.line, lines.length - 1); i >= 0; i--) {
      const m = /^([ \t]*)class[ \t]+([A-Za-z_]\w*)/.exec(lines[i] || "");
      if (m) { clsName = m[2]; clsLine = i; clsIndent = m[1].length; break; }
      if (/^[ \t]*(?:def|async[ \t]+def)[ \t]+\w+/.test(lines[i] || "") && ((lines[i].match(/^[ \t]*/) || [""])[0].length) === 0) break;
    }
    if (clsLine < 0) return null;
    const out = [], seen = Object.create(null);
    const push = (name, kind, detail) => {
      if (!name || seen[name]) return;
      seen[name] = 1;
      out.push({ text: name, kind: kind, detail: detail || "" });
    };
    for (let i = clsLine + 1; i < lines.length; i++) {
      const l = lines[i] || "";
      if (!l.trim()) continue;
      const ind = ((l.match(/^[ \t]*/) || [""])[0]).length;
      if (ind <= clsIndent) break;                                  // 类定义结束
      let m = /^[ \t]*(?:async[ \t]+)?def[ \t]+([A-Za-z_]\w*)[ \t]*(\([^)\n]*\))?/.exec(l);
      if (m) { push(m[1], "m", "def " + m[1] + (m[2] || "()")); continue; }
      m = /^[ \t]*self\.([A-Za-z_]\w*)/.exec(l);
      if (m) { push(m[1], "p", "实例属性"); continue; }
      m = /^[ \t]*([A-Za-z_]\w*)[ \t]*(?::[^=\n]+)?=[^=]/.exec(l);
      if (m) push(m[1], "p", "类属性");
    }
    return out.length ? out : null;
  }

  // 解析「对象.」里的对象，给出成员候选；解析不出来返回 null（前端退回通用补全）
  function cmpResolveMembers(cm, objPath, lang, cur) {
    const parts = objPath.split(".");
    const base = parts[0], last = parts[parts.length - 1];
    if (lang === "py") {
      if (base === "self" || base === "cls") return cmpPyClassMembers(cm, cur);
      const idx = cmpIndex(cm, "py");
      const info = idx.map[last] || idx.map[base] || null;
      if (info && info.cls && CMP_PY_MEMBERS[info.cls]) return cmpFromTable(CMP_PY_MEMBERS[info.cls], "m");
      if (info && info.mod && CMP_PY_MODULES[info.mod]) return cmpFromTable(CMP_PY_MODULES[info.mod], "f");
      if (CMP_PY_MEMBERS[last]) return cmpFromTable(CMP_PY_MEMBERS[last], "m");     // pathlib.Path.
      if (CMP_PY_MODULES[objPath]) return cmpFromTable(CMP_PY_MODULES[objPath], "f"); // os.path.
      if (CMP_PY_MODULES[base]) return cmpFromTable(CMP_PY_MODULES[base], "f");
      return null;
    }
    if (lang === "js") {
      const idx = cmpIndex(cm, "js");
      const info = idx.map[last] || idx.map[base] || null;
      if (info && info.mod && CMP_JS_MEMBERS[info.mod]) return cmpFromTable(CMP_JS_MEMBERS[info.mod], "f");
      if (CMP_JS_MEMBERS[last]) return cmpFromTable(CMP_JS_MEMBERS[last], "m");
      if (CMP_JS_MEMBERS[base]) return cmpFromTable(CMP_JS_MEMBERS[base], "f");
      return null;
    }
    return null;
  }

  /* ================================================================
     四、show-hint 接入
     ================================================================ */

  // 光标处是否适合弹补全：字符串 / 注释里不弹
  function cmpTokenUsable(cm, pos) {
    let tok = null;
    try { tok = cm.getTokenAt(pos, true); } catch (_) {}
    const ty = (tok && tok.type) || "";
    if (/comment|string/.test(ty)) return false;
    const line = (cm.getLine(pos.line) || "").slice(0, pos.ch);
    if (/^[ \t]*(#|\/\/|\*|--)/.test(line) && line.trim().length <= 2) return false;
    return true;
  }

  function cmpHighlight(name, pos) {
    if (!pos || !pos.length) return null;
    const set = new Set(pos);
    let out = "", bold = false;
    for (let i = 0; i < name.length; i++) {
      const hit = set.has(i);
      if (hit !== bold) { out += hit ? "<b>" : "</b>"; bold = hit; }
      out += esc(name[i]);
    }
    return bold ? out + "</b>" : out;
  }

  // 每一项的渲染：色块图标 + 名称（命中处加粗）+ 右侧灰色说明
  function cmpRenderItem(li, cm, item) {
    const ic = document.createElement("span");
    ic.className = "ide-cmp-ic ic-" + (item.kind || "v") + (String(CMP_KIND_ICON[item.kind] || "").length > 1 ? " wide" : "");
    ic.textContent = CMP_KIND_ICON[item.kind] || CMP_KIND_ICON.v;
    const nm = document.createElement("span");
    nm.className = "ide-cmp-nm";
    nm.innerHTML = cmpHighlight(item.text, item.pos) || esc(item.text);
    const dt = document.createElement("span");
    dt.className = "ide-cmp-dt";
    dt.textContent = item.detail || CMP_KIND_CN[item.kind] || "";
    li.appendChild(ic); li.appendChild(nm); li.appendChild(dt);
  }

  // 真正的补全函数（交给 show-hint 调用）
  function ideCompleteHint(cm) {
    if (IDE_SETTINGS.codeComplete === false || !cm._cmpState) return null;
    const cur = cm.getCursor();
    if (cm.somethingSelected() || cm.getOption("readOnly")) return null;
    const line = cm.getLine(cur.line) || "";
    const before = line.slice(0, cur.ch);
    const wm = /[A-Za-z_$\u4e00-\u9fff][\w$\u4e00-\u9fff]*$/.exec(before);
    const prefix = wm ? wm[0] : "";
    const from = { line: cur.line, ch: cur.ch - prefix.length };
    const head = before.slice(0, before.length - prefix.length);
    const lang = cm._cmpState.lang;
    let list = null;
    if (prefix && from.ch > 0 && head.charAt(head.length - 1) === ".") {
      // 「.」之后：按对象类型给成员
      const em = /([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)$/.exec(head.slice(0, -1));
      const members = em && em[1] ? cmpResolveMembers(cm, em[1], lang, cur) : null;
      if (members) list = cmpRank(members, prefix, 200);
    } else if (prefix === "" && head.charAt(head.length - 1) === ".") {
      const em = /([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)$/.exec(head.slice(0, -1));
      const members = em && em[1] ? cmpResolveMembers(cm, em[1], lang, cur) : null;
      if (members) list = cmpRank(members, "", 200);
    }
    if (!list) list = cmpGeneral(cm, lang, prefix);        // 通用补全 / 对象类型未知时的兜底
    if (!list || !list.length) return null;
    for (const it of list) { it.render = cmpRenderItem; }
    return { list: list, from: from, to: cur };
  }

  // 输入时自动弹出（设置里可关）；粘贴、多字符输入、字符串/注释里都不弹
  function cmpAutoTrigger(cm, chg) {
    if (IDE_SETTINGS.codeComplete === false || IDE_SETTINGS.autoComplete === false) return;
    if (cm.state.completionActive) return;                 // 已弹出：show-hint 自己会随输入刷新
    if (cm.somethingSelected() || cm.getOption("readOnly")) return;
    const t = chg.text;
    if (!t || t.length !== 1 || t[0].length !== 1) return;  // 粘贴 / 换行不触发
    const ch = t[0];
    if (!/[A-Za-z_$\u4e00-\u9fff.]/.test(ch)) return;
    if (!cmpTokenUsable(cm, { line: chg.from.line, ch: chg.from.ch + 1 })) return;
    cm.showHint();
  }

  // 把补全能力挂到一个 CodeMirror 实例上（重复调用无副作用）
  function cmAttachCompletion(cm, ext) {
    if (!cm || cm._cmpState || typeof cm.showHint !== "function") return;
    cm._cmpState = { lang: cmpLangOf(ext), ext: ext };
    cm._cmpIdxDirty = true;
    cm.setOption("hintOptions", {
      hint: ideCompleteHint,
      completeSingle: false,        // 即便只剩一个候选也不自动插入，不打断输入
      alignWithWord: true,
      closeOnUnfocus: true,
      closeOnPick: true,
      completeOnSingleClick: true,
      updateOnCursorActivity: true,
      closeCharacters: /[\s()\[\]{};:>,=]/,
    });
    const keys = Object.assign({}, cm.getOption("extraKeys") || {});
    const press = (c) => { if (IDE_SETTINGS.codeComplete !== false) c.showHint(); };
    keys["Ctrl-Space"] = press;
    keys["Alt-/"] = press;                                  // 备用键：某些输入法占用 Ctrl+Space
    cm.setOption("extraKeys", keys);
    cm.on("change", () => { cm._cmpIdxDirty = true; });
    cm.on("inputRead", (c, chg) => cmpAutoTrigger(c, chg));
  }

  // 关掉所有已弹出的补全列表（设置里关闭补全 / 切换文件时用）
  function ideCompleteCloseAll() {
    tabs.forEach(t => {
      const cm = t && t.cm;
      if (cm && cm.state && cm.state.completionActive) {
        try { cm.state.completionActive.close(); } catch (_) {}
      }
    });
  }

  // 页面加载时可能已有编辑器（会话恢复），补挂一次；之后新开的文件由 openFile 调用
  tabs.forEach(t => { if (t && t.cm) cmAttachCompletion(t.cm, getExt(t.name)); });

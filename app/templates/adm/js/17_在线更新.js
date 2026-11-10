/* 后台管理：在线更新（从 GitHub 检查更新 / 拉取代码 / 重启服务）。 */
ADM.modules.push({
    id: 'update',
    name: '在线更新',
    subtitle: '支持 Git 拉取与上传 ZIP 包两种更新方式，更新后自动重启',
    icon: 'bi-cloud-arrow-down',
    async load(el) {
        var STEPS = [
            ['init', '准备'],
            ['backup', '备份'],
            ['fetch', '拉取代码'],
            ['merge', '合并'],
            ['deps', '依赖'],
            ['restart', '重启']
        ];
        /* ZIP 包更新没有 fetch 阶段，文案单独一套 */
        var ZIP_STEPS = [
            ['init', '校验压缩包'],
            ['backup', '备份代码'],
            ['merge', '解压覆盖'],
            ['deps', '依赖'],
            ['restart', '重启']
        ];
        /* 手动备份任务只有两步 */
        var BACKUP_STEPS = [
            ['init', '扫描文件'],
            ['backup', '打包压缩']
        ];
        /* 恢复备份：先给当前代码做快照，再覆盖 */
        var RESTORE_STEPS = [
            ['init', '校验备份'],
            ['backup', '备份当前'],
            ['merge', '还原文件'],
            ['deps', '依赖'],
            ['restart', '重启']
        ];
        /* store.db 同步：校验来源 → 备份 → 补表结构 → 逐表同步 */
        var DB_SYNC_STEPS = [
            ['init', '校验来源'],
            ['backup', '备份当前库'],
            ['schema', '结构更新'],
            ['merge', '同步数据'],
            ['done', '完成']
        ];
        var DB_LIGHT_STEPS = [
            ['init', '准备'],
            ['done', '完成']
        ];
        var DONE_TEXT = {
            init: 'Git 仓库初始化完成',
            zip: 'ZIP 包更新完成',
            backup: '代码备份完成',
            restore: '已恢复到所选备份',
            dbsync: 'store.db 同步完成',
            dbschema: '表结构已是最新',
            dbbackup: '快照已保存',
            dbdelete: '快照已删除'
        };
        /* 任务 action → 后端任务 kind（决定进度面板的步骤文案） */
        var DB_KIND_OF = {
            sync: 'dbsync', restore: 'dbsync', schema: 'dbschema',
            backup: 'dbbackup', delete: 'dbdelete'
        };

        function stepsFor(kind) {
            if (kind === 'zip') return ZIP_STEPS;
            if (kind === 'backup') return BACKUP_STEPS;
            if (kind === 'restore') return RESTORE_STEPS;
            if (kind === 'dbsync') return DB_SYNC_STEPS;
            if (kind === 'dbschema' || kind === 'dbbackup' || kind === 'dbdelete') return DB_LIGHT_STEPS;
            return STEPS;
        }
        var RESTART_TIPS = {
            exec: '默认。适合 <b>python run.py</b> 或打包后的可执行文件：用 os.execv 原地替换进程，端口基本不中断。',
            exit: '更新后直接退出进程，由 <b>systemd / supervisor / pm2</b> 自动重启拉起。服务单元必须配置了自动重启。',
            command: '执行下面填写的命令来重启服务。systemd 请用 <b>systemd-run --no-block</b> 脱离进程组。',
            none: '只更新代码，不重启。新代码需要你手动重启服务后才会生效。'
        };

        /* 每次进入模块都是一份新的闭包状态：切走 / 再切回来不会串状态 */
        var S = {
            cfg: null, local: null, env: null,
            updateAvailable: false, runId: '', busy: false,
            zipFile: null,
            dbFile: null, store: null,
            inspect: null, inspectBusy: false, inspectSeq: 0, picked: {},
            sfx: 'git',                /* 当前任务写入哪个 Tab 的进度面板 */
            poll: null, wait: null
        };

        /* 两种更新方式用 Tab 切换；各面板先拼成字符串，最后统一塞进容器 */
        var GIT_PANEL = `
    <section class="upd-versions">
        <div class="adm-card upd-ver">
            <div class="upd-ver-head">
                <span><i class="bi bi-hdd-network"></i> 本地版本</span>
                <span class="adm-badge mute" id="uLocalBadge">读取中</span>
            </div>
            <div class="upd-ver-sha" id="uLocalSha">—</div>
            <div class="upd-ver-meta" id="uLocalMeta">—</div>
        </div>

        <div class="upd-arrow"><i class="bi bi-arrow-right"></i></div>

        <div class="adm-card upd-ver">
            <div class="upd-ver-head">
                <span><i class="bi bi-github"></i> 远端版本</span>
                <span class="adm-badge mute" id="uRemoteBadge">未检查</span>
            </div>
            <div class="upd-ver-sha" id="uRemoteSha">—</div>
            <div class="upd-ver-meta" id="uRemoteMeta">点击「检查更新」获取远端最新提交</div>
        </div>

        <div class="upd-actions">
            <button class="adm-btn git" id="uBtnInit" type="button" style="display:none">
                <i class="bi bi-git"></i> 初始化 Git 仓库
            </button>
            <button class="adm-btn ghost" id="uBtnCfg" type="button">
                <i class="bi bi-sliders"></i> 更新配置
            </button>
            <button class="adm-btn ghost" id="uBtnCheck" type="button">
                <i class="bi bi-cloud-arrow-down"></i> 检查更新
            </button>
            <button class="adm-btn primary" id="uBtnApply" type="button" disabled>
                <i class="bi bi-download"></i> 立即更新
            </button>
        </div>
    </section>

    <div class="adm-hint" id="uEnvLine"></div>

    <section class="adm-card">
        <div class="adm-section-head">
            <h3><i class="bi bi-journal-code"></i> 更新内容</h3>
            <span class="adm-spacer"></span>
            <span class="adm-hint" id="uCommitCount"></span>
        </div>
        <div class="upd-commit-list" id="uCommitList">
            <div class="upd-empty">检查更新后，这里会列出远端待拉取的提交。</div>
        </div>
    </section>`;

        var ZIP_PANEL = `
    <section class="adm-card upd-zip-card">
        <div class="adm-section-head">
            <h3><i class="bi bi-file-earmark-zip"></i> 上传源码压缩包</h3>
            <span class="adm-spacer"></span>
            <span class="adm-hint">连不上 GitHub / 不想用 Git 时用这个</span>
        </div>
        <div class="upd-zip-row">
            <input type="file" id="uZipFile" accept=".zip,application/zip" hidden>
            <label class="adm-btn ghost upd-zip-pick" for="uZipFile">
                <i class="bi bi-folder2-open"></i> 选择 ZIP
            </label>
            <span class="upd-zip-name" id="uZipName">未选择文件</span>
            <button class="adm-btn primary" id="uBtnZip" type="button" disabled>
                <i class="bi bi-upload"></i> 上传并更新
            </button>
        </div>
        <div class="upd-tip">支持 GitHub「Download ZIP」的源码包（外层目录可有可无）。只覆盖压缩包里存在的文件，
            自动跳过 <code>data/</code>、<code>.env</code>、虚拟环境、日志、<code>__pycache__</code>；
            覆盖前会把当前代码整份打包备份到 <code>data/update_backup/</code>，重启方式沿用上面的配置。</div>
    </section>`;

        var BACKUP_PANEL = `
    <section class="adm-card">
        <div class="adm-section-head">
            <h3><i class="bi bi-clock-history"></i> 备份记录</h3>
            <span class="adm-spacer"></span>
            <span class="adm-hint upd-bk-dir" id="uBkDir"></span>
            <button class="adm-btn ghost sm" id="uBtnBkRefresh" type="button" style="margin-left:8px">
                <i class="bi bi-arrow-repeat"></i> 刷新
            </button>
            <button class="adm-btn primary sm" id="uBtnBkNow" type="button" style="margin-left:8px">
                <i class="bi bi-archive"></i> 立即备份
            </button>
        </div>
        <div class="upd-bk-list" id="uBkList">
            <div class="upd-empty">正在读取备份记录…</div>
        </div>
        <div class="upd-tip upd-bk-tip">备份保存在 <code>data/update_backup/</code>，包含代码与
            <code>.env</code>，不含 data/、日志、虚拟环境。点「恢复」会把代码还原到该备份版本：
            恢复前会先给当前代码做一份 <code>restore_*.zip</code> 快照，恢复后按配置的重启方式重启。</div>
    </section>`;

        /* store.db 数据同步 / 更新：状态 + 导出 + 三类来源的同步操作 + 服务器快照 */
        var DB_PANEL = `
    <section class="adm-card">
        <div class="adm-section-head">
            <h3><i class="bi bi-database"></i> 本地 store.db</h3>
            <span class="adm-spacer"></span>
            <span class="adm-hint upd-bk-dir" id="uDbPath"></span>
            <button class="adm-btn ghost sm" id="uBtnDbRefresh" type="button" style="margin-left:8px">
                <i class="bi bi-arrow-repeat"></i> 刷新
            </button>
            <a class="adm-btn ghost sm" id="uBtnDbExport" href="/api/adm/update/store/export">
                <i class="bi bi-download"></i> 下载快照
            </a>
            <button class="adm-btn primary sm" id="uBtnDbBackup" type="button" style="margin-left:8px">
                <i class="bi bi-archive"></i> 备份到服务器
            </button>
        </div>
        <div class="upd-db-stats" id="uDbStats"><div class="upd-empty">正在读取 store.db 状态…</div></div>
        <div class="upd-db-acts">
            <button class="adm-btn ghost sm" id="uBtnDbSchema" type="button">
                <i class="bi bi-wrench"></i> 检查并更新表结构
            </button>
            <span class="adm-hint" id="uDbSchemaHint">代码升级后补齐新增的表 / 列，可重复执行</span>
        </div>
    </section>
    <section class="adm-card">
        <div class="adm-section-head"><h3><i class="bi bi-arrow-left-right"></i> 数据同步</h3></div>
        <div class="upd-form upd-db-form">
            <div class="upd-field wide">
                <label for="uDbFile">来源一：上传另一台机器导出的 .db 快照</label>
                <div class="upd-db-drop" id="uDbDrop">
                    <input id="uDbFile" type="file" accept=".db,.sqlite,.sqlite3" hidden>
                    <div class="upd-db-drop-icon"><i class="bi bi-cloud-arrow-up"></i></div>
                    <div class="upd-db-drop-main">
                        <div class="upd-db-drop-title" id="uDbFileName">点击选择，或把 .db 文件拖到这里</div>
                        <div class="upd-db-drop-sub" id="uDbFileSub">支持 store.db / .sqlite 快照，最大 512MB</div>
                    </div>
                    <button class="adm-btn ghost sm" id="uBtnDbClear" type="button" style="display:none">
                        <i class="bi bi-x-lg"></i> 移除
                    </button>
                </div>
                <div class="upd-tip">先在另一台机器点「下载快照」拿到 .db 文件；已选择文件时优先于远程 URL。</div>
            </div>
            <div class="upd-field wide">
                <label for="uDbUrl">来源二：远程 URL（可下载 .db 快照的直链）</label>
                <input class="adm-input mono" id="uDbUrl" type="text"
                    placeholder="http://192.168.1.2:5001/xxx/store.db">
                <div class="upd-tip">填写远程地址时可选填 Token（作为 <code>Authorization: Bearer</code> 发送）。上传文件优先于远程 URL。</div>
            </div>
            <div class="upd-field">
                <label for="uDbToken">远程 Token（可选）</label>
                <input class="adm-input" id="uDbToken" type="password" placeholder="需要鉴权的下载源才填">
            </div>
            <div class="upd-field">
                <label for="uDbMode">同步模式</label>
                <select class="adm-select" id="uDbMode">
                    <option value="merge">合并补齐（保留本地已有）</option>
                    <option value="replace">覆盖更新（同主键以来源为准）</option>
                    <option value="overwrite">整库替换（先清空本地表）</option>
                </select>
                <div class="upd-tip">按主键 / 唯一键判断重复；同步前会自动备份当前库并补齐表结构。</div>
            </div>
            <div class="upd-field wide">
                <label for="uDbTables">同步范围（由下方勾选自动填入，可手动编辑；留空 = 全部共有表）</label>
                <input class="adm-input mono" id="uDbTables" type="text" placeholder="favorites, users, cron_tasks …">
            </div>
            <div class="upd-field wide">
                <label class="upd-check"><input type="checkbox" id="uDbSkipCache" checked>
                <span>跳过可重建的缓存 / 日志表（目录缓存、操作日志、AI 用量、封面索引等）</span></label>
            </div>
            <div class="upd-form-foot">
                <button class="adm-btn primary" id="uBtnDbInspect" type="button">
                    <i class="bi bi-clipboard2-data"></i> 校验并预览差异
                </button>
                <span class="adm-hint">选好文件会自动校验；也可填远程 URL 后点此校验。确认差异后再同步。</span>
            </div>
        </div>
        <div class="upd-tip upd-bk-tip">通过 SQLite ATTACH 按「两边共有的表 + 共有的列」逐表搬运，不会替换 store.db 文件本身；每次同步前都会把当前库快照存到 <code>data/update_backup/</code>。</div>
    </section>
    <section class="adm-card upd-db-diff" id="uDbDiffCard" style="display:none">
        <div class="adm-section-head">
            <h3><i class="bi bi-table"></i> 校验结果 · 逐表差异</h3>
            <span class="adm-spacer"></span>
            <span class="adm-hint upd-bk-dir" id="uDbDiffSource"></span>
        </div>
        <div class="upd-db-diff-summary" id="uDbDiffSummary"></div>
        <div class="upd-db-diff-tools">
            <label class="upd-check"><input type="checkbox" id="uDbDiffOnlyDiff" checked>
                <span>只显示有差异 / 结构不同的表</span></label>
            <span class="adm-spacer"></span>
            <button class="adm-btn ghost sm" id="uBtnDbPickAll" type="button">全选可见</button>
            <button class="adm-btn ghost sm" id="uBtnDbPickDiff" type="button">仅选差异表</button>
            <button class="adm-btn ghost sm" id="uBtnDbPickNone" type="button">清空选择</button>
        </div>
        <div class="upd-db-diff-list" id="uDbDiffList"></div>
        <div class="upd-form-foot">
            <button class="adm-btn primary" id="uBtnDbApply" type="button">
                <i class="bi bi-arrow-left-right"></i> 按勾选的表开始同步
            </button>
            <span class="adm-hint" id="uDbDiffHint">勾选的表会写入上方「只同步这些表」。</span>
        </div>
    </section>
    <section class="adm-card">
        <div class="adm-section-head">
            <h3><i class="bi bi-clock-history"></i> 服务器快照</h3>
            <span class="adm-spacer"></span>
            <span class="adm-hint" id="uDbBkDir"></span>
        </div>
        <div class="upd-bk-list" id="uDbBkList"><div class="upd-empty">正在读取快照…</div></div>
        <div class="upd-tip upd-bk-tip">快照是一致性 .db 文件，可下载留存，也可点「恢复」按上面的同步模式把数据同步回来；只保留最近 10 份。</div>
    </section>`;

        /* 每个 Tab 各自一份「执行进度」面板：sfx 用来区分元素 ID（git / zip / bk / db） */
        function progressPanel(sfx) {
            return `
    <section class="adm-card upd-progress-card">
        <div class="adm-section-head">
            <h3><i class="bi bi-activity"></i> 执行进度</h3>
            <span class="adm-spacer"></span>
            <span class="adm-hint" id="uRunState_${sfx}">空闲</span>
        </div>
        <div class="upd-steps" id="uRunSteps_${sfx}"></div>
        <div class="upd-bar">
            <div class="upd-bar-in" id="uProgressBar_${sfx}"></div>
        </div>
        <div class="upd-log" id="uRunLog_${sfx}">等待开始…</div>
    </section>`;
        }
        /* 任务类型 → 所属 Tab 的进度面板后缀 */
        var TAB_OF = {
            update: 'git', init: 'git', restart: 'git', zip: 'zip', backup: 'bk', restore: 'bk',
            dbsync: 'db', dbschema: 'db', dbbackup: 'db', dbdelete: 'db'
        };
        /* 每个 Tab 回显「上次结果」时，在这些类型里取最近完成的一条 */
        var TAB_KINDS = { git: ['update', 'init', 'restart'], zip: ['zip'], bk: ['backup', 'restore'] };

        var CFG_PANEL = `
<div class="upd-mask" id="uCfgMask"></div>

<div class="adm-card upd-cfg-card" id="uCfgCard" role="dialog" aria-modal="true" aria-labelledby="uCfgTitle">
    <div class="adm-section-head">
        <h3 id="uCfgTitle"><i class="bi bi-gear"></i> 更新配置</h3>
        <span class="adm-spacer"></span>
        <span class="adm-hint">令牌加密保存，页面不会回显明文</span>
        <button class="upd-modal-close" id="uCfgClose" type="button" title="关闭">
            <i class="bi bi-x-lg"></i>
        </button>
    </div>

    <form class="upd-form" id="uCfgForm" autocomplete="off">
        <div class="upd-field wide">
            <label for="uRepo">GitHub 仓库</label>
            <input class="adm-input mono" id="uRepo" type="text"
                placeholder="owner/repo 或 https://github.com/owner/repo">
            <div class="upd-tip">留空则自动使用本地仓库的 <b>origin</b> 远端。支持粘贴浏览器地址栏里的仓库链接。</div>
        </div>

        <div class="upd-field">
            <label for="uBranch">跟随分支</label>
            <input class="adm-input mono" id="uBranch" type="text" placeholder="留空 = 当前分支">
            <div class="upd-tip">例如 <b>main</b> / <b>master</b>。</div>
        </div>

        <div class="upd-field">
            <label for="uToken">访问令牌（PAT）</label>
            <input class="adm-input mono" id="uToken" type="password" autocomplete="new-password"
                placeholder="公开仓库可留空">
            <div class="upd-tip">私有仓库需要具备 <b>repo</b> 读取权限；填写后 GitHub API 限额也更高。</div>
        </div>

        <div class="upd-field">
            <label for="uApiBase">API 地址</label>
            <input class="adm-input mono" id="uApiBase" type="text" placeholder="https://api.github.com">
            <div class="upd-tip">服务器访问不了 GitHub API 时可填镜像地址。</div>
        </div>

        <div class="upd-field">
            <label for="uProxy">API 代理</label>
            <input class="adm-input mono" id="uProxy" type="text" placeholder="http://127.0.0.1:7890">
            <div class="upd-tip">同时用于 GitHub API 与 git 拉取（http.proxy / https.proxy）。</div>
        </div>

        <div class="upd-field wide">
            <label for="uRemoteUrl">Git 拉取地址（可选）</label>
            <input class="adm-input mono" id="uRemoteUrl" type="text"
                placeholder="ssh://git@ssh.github.com:443/owner/repo.git">
            <div class="upd-tip">默认使用仓库的 HTTPS 地址。github.com 的 HTTPS 连不上时填这里：
                SSH 443（<b>ssh://git@ssh.github.com:443/owner/repo.git</b>）或加速镜像。
                只影响 git 拉取，GitHub API 检查仍按上面的仓库地址走。</div>
        </div>

        <div class="upd-field">
            <label for="uMethod">检查方式</label>
            <select class="adm-select" id="uMethod">
                <option value="auto">自动（先 API，失败回退 git）</option>
                <option value="api">GitHub API（提交信息最完整）</option>
                <option value="git">仅 git（不依赖 API / 不占限额）</option>
            </select>
            <div class="upd-tip">API 被墙或限流时选「仅 git」。</div>
        </div>

        <div class="upd-field">
            <label for="uRestart">更新后重启方式</label>
            <select class="adm-select" id="uRestart">
                <option value="exec">原地替换进程（python run.py）</option>
                <option value="exit">退出进程，由守护进程拉起</option>
                <option value="command">执行自定义重启命令</option>
                <option value="none">不自动重启</option>
            </select>
            <div class="upd-tip" id="uRestartTip"></div>
        </div>

        <div class="upd-field wide" id="uRestartCmdField">
            <label for="uRestartCmd">自定义重启命令</label>
            <input class="adm-input mono" id="uRestartCmd" type="text"
                placeholder="systemd-run --no-block systemctl restart file-flask">
            <div class="upd-tip">在项目目录下以 shell 执行。systemd 建议用
                <b>systemd-run --no-block</b> 脱离当前服务的进程组。</div>
        </div>

        <div class="upd-field wide">
            <label class="upd-check">
                <input type="checkbox" id="uInstallDeps">
                <span><b>自动安装依赖</b><br>更新内容包含 requirements.txt 时执行
                    <code>pip install -r requirements.txt</code>（优先使用当前虚拟环境）。</span>
            </label>
        </div>

        <div class="upd-field wide">
            <label class="upd-check">
                <input type="checkbox" id="uBackup">
                <span><b>更新前自动备份代码</b><br>拉取 / 覆盖之前把当前源码打包成 zip 存到
                    <code>data/update_backup/</code>（保留最近 10 份，不含 data/、日志、虚拟环境），
                    备份失败会中止更新。也可以随时点「备份代码」手动备份。</span>
            </label>
        </div>

        <div class="upd-field wide">
            <label class="upd-check">
                <input type="checkbox" id="uHardReset">
                <span><b>允许强制覆盖本地改动</b><br>开启后可在更新时选择
                    <code>git reset --hard</code>，丢弃服务器上尚未提交的修改。请谨慎使用。</span>
            </label>
        </div>

        <div class="upd-field wide">
            <div id="uProbeResult"></div>
        </div>

        <div class="upd-form-foot">
            <button class="adm-btn primary" id="uBtnSave" type="submit">
                <i class="bi bi-check2-circle"></i> 保存配置
            </button>
            <button class="adm-btn ghost" id="uBtnProbe" type="button">
                <i class="bi bi-plug"></i> 连接测试
            </button>
            <span class="adm-hint" id="uSaveHint"></span>
        </div>
    </form>`;

        /* 「仅重启 / 备份代码」与更新方式无关，放到 Tab 行右侧，不占更新操作列 */
        var TOP_ACTIONS = `
        <div class="upd-top-actions">
            <button class="adm-btn ghost sm" id="uBtnRestart" type="button">
                <i class="bi bi-arrow-clockwise"></i> 仅重启
            </button>
            <button class="adm-btn ghost sm" id="uBtnBackup" type="button">
                <i class="bi bi-archive"></i> 备份代码
            </button>
        </div>`;

        el.innerHTML =
            '<div class="upd-wrap">' +
                '<div class="upd-top">' +
                    ADM.tabs([
                        {
                            id: 'git', name: 'Git / GitHub 更新', icon: 'bi-github',
                            content: '<div class="upd-pane">' + GIT_PANEL + progressPanel('git') + '</div>'
                        },
                        {
                            id: 'zip', name: 'ZIP 包更新', icon: 'bi-file-earmark-zip',
                            content: '<div class="upd-pane">' + ZIP_PANEL + progressPanel('zip') + '</div>'
                        },
                        {
                            id: 'backup', name: '备份', icon: 'bi-clock-history',
                            content: '<div class="upd-pane">' + BACKUP_PANEL + progressPanel('bk') + '</div>',
                            onShow: function () { loadBackups(); }
                        },
                        {
                            id: 'dbsync', name: 'store.db 同步', icon: 'bi-database',
                            content: '<div class="upd-pane">' + DB_PANEL + progressPanel('db') + '</div>',
                            onShow: function () { loadStoreStatus(); }
                        }
                    ], { key: 'upd-method' }) +
                    TOP_ACTIONS +
                '</div>' +
            '</div>' +
            CFG_PANEL;

        ADM.mountTables(el);
        ADM.mountTabs(el);                 /* 两个更新方式用 Tab 切换，选中项会记住 */

        /* ------------------------------------------------------------ 工具 */
        /* el 是 #admView 容器本身，切模块时它不会断开；用模块根节点判断是否还在页面上 */
        var root = el.querySelector('.upd-wrap');
        function q(id) { return el.querySelector('#' + id); }
        /* 当前 Tab 进度面板里的元素：uRunLog → uRunLog_git / uRunLog_zip / uRunLog_bk */
        function pq(id) { return q(id + '_' + S.sfx); }
        function alive() { return !!(root && root.isConnected); }
        function toast(msg, tone) { ADM.toast(msg, tone || 'ok'); }

        function pad(n) { return n < 10 ? '0' + n : '' + n; }

        function fmtTime(ts) {
            if (!ts) return '';
            var d = new Date(ts * 1000);
            return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
        }

        function fmtDate(v) {
            if (!v) return '';
            var d = (typeof v === 'number') ? new Date(v * 1000) : new Date(v);
            if (isNaN(d.getTime())) return String(v);
            return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
                ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
        }

        function stopPoll() {
            if (S.poll) { clearInterval(S.poll); S.poll = null; }
        }

        function stopWait() {
            if (S.wait) { clearInterval(S.wait); S.wait = null; }
        }

        /* ------------------------------------------------------------ 渲染 */
        function renderLocal(local) {
            if (!local) return;
            q('uLocalSha').textContent = local.short || '—';
            var c = local.commit || {};
            var bits = [];
            if (local.branch) bits.push('分支 <b>' + ADM.esc(local.branch) + '</b>');
            if (c.message) bits.push(ADM.esc(c.message));
            if (c.author) bits.push(ADM.esc(c.author));
            if (c.date) bits.push(fmtDate(c.date));
            q('uLocalMeta').innerHTML = bits.length ? bits.join(' · ') : (ADM.esc(local.error) || '—');

            var badge = q('uLocalBadge');
            var initBtn = q('uBtnInit');
            /* 没有 .git，或仓库是空的（上次初始化中途失败）：都还需要初始化 */
            var needInit = !local.has_git || !local.sha;
            if (initBtn) initBtn.style.display = needInit ? '' : 'none';
            if (!local.has_git) {
                badge.className = 'adm-badge bad';
                badge.textContent = '非 Git 仓库';
            } else if (!local.sha) {
                badge.className = 'adm-badge warn';
                badge.textContent = '仓库为空';
            } else if (local.dirty) {
                badge.className = 'adm-badge warn';
                badge.textContent = '有未提交改动';
            } else {
                badge.className = 'adm-badge ok';
                badge.textContent = '就绪';
            }

            if (local.dirty && local.dirty_files && local.dirty_files.length) {
                q('uLocalMeta').innerHTML += '<br><span class="adm-hint">改动：' +
                    ADM.esc(local.dirty_files.join('、')) + '</span>';
            }
        }

        function renderEnv(env) {
            if (!env) return;
            var bits = [];
            bits.push(env.git ? 'Git 可用' : '未安装 Git');
            bits.push('Python ' + env.python);
            bits.push('目录 ' + env.root);
            if (env.frozen) bits.push('打包运行');
            if (!env.can_exec) bits.push('自动替换进程不可用');
            q('uEnvLine').textContent = bits.join(' · ');
            if (!env.can_exec && env.can_exec_reason) q('uEnvLine').title = env.can_exec_reason;
        }

        function fillConfig(cfg) {
            if (!cfg) return;
            q('uRepo').value = cfg.repo || '';
            q('uRemoteUrl').value = cfg.remote_url || '';
            q('uBranch').value = cfg.branch || '';
            q('uToken').value = cfg.token || '';
            q('uToken').placeholder = cfg.token_set ? '已保存（留空则保持不变）' : '公开仓库可留空';
            q('uApiBase').value = cfg.api_base || 'https://api.github.com';
            q('uProxy').value = cfg.proxy || '';
            q('uMethod').value = cfg.method || 'auto';
            q('uRestart').value = cfg.restart_mode || 'exec';
            q('uRestartCmd').value = cfg.restart_cmd || '';
            q('uInstallDeps').checked = !!cfg.install_deps;
            q('uBackup').checked = cfg.backup_before_update !== false;
            q('uHardReset').checked = !!cfg.hard_reset;
            toggleRestartCmd();
        }

        function collectConfig() {
            return {
                repo: q('uRepo').value.trim(),
                remote_url: q('uRemoteUrl').value.trim(),
                branch: q('uBranch').value.trim(),
                token: q('uToken').value.trim(),
                api_base: q('uApiBase').value.trim(),
                proxy: q('uProxy').value.trim(),
                method: q('uMethod').value,
                restart_mode: q('uRestart').value,
                restart_cmd: q('uRestartCmd').value.trim(),
                install_deps: q('uInstallDeps').checked,
                backup_before_update: q('uBackup').checked,
                hard_reset: q('uHardReset').checked
            };
        }

        function toggleRestartCmd() {
            var mode = q('uRestart').value;
            q('uRestartCmdField').style.display = mode === 'command' ? '' : 'none';
            q('uRestartTip').innerHTML = RESTART_TIPS[mode] || '';
        }

        function renderCommits(list) {
            var box = q('uCommitList');
            if (!list || !list.length) {
                box.innerHTML = '<div class="upd-empty">没有待拉取的提交。</div>';
                q('uCommitCount').textContent = '';
                return;
            }
            var rows = list.slice().reverse().map(function (c) {
                var sha = c.short || (c.sha || '').slice(0, 7);
                return '<div class="upd-commit">' +
                    '<div class="upd-commit-sha">' + ADM.esc(sha) + '</div>' +
                    '<div><div class="upd-commit-msg">' + ADM.esc(c.message || '(无提交说明)') + '</div>' +
                    '<div class="upd-commit-meta">' + ADM.esc(c.author || '未知作者') +
                    (c.date ? ' · ' + ADM.esc(fmtDate(c.date)) : '') + '</div></div>' +
                    '<div class="upd-commit-date">' + ADM.esc(fmtDate(c.date)) + '</div>' +
                    '</div>';
            }).join('');
            box.innerHTML = rows;
            q('uCommitCount').textContent = '共 ' + list.length + ' 个提交' +
                (list.length >= 30 ? '（最多显示最近 60 个）' : '');
        }

        function renderCheck(res) {
            var remote = res.remote || null;
            if (res.error) {
                q('uRemoteBadge').className = 'adm-badge bad';
                q('uRemoteBadge').textContent = '检查失败';
                q('uRemoteSha').textContent = '—';
                q('uRemoteMeta').textContent = res.error;
                q('uRemoteMeta').title = res.error;
                q('uBtnApply').disabled = true;
                S.updateAvailable = false;
                renderCommits([]);
                toast(res.error, 'err');
                if (/仓库|令牌|分支|origin|Git/i.test(String(res.error))) openCfg();
                return;
            }
            q('uRemoteSha').textContent = remote && remote.short ? remote.short : '—';
            var bits = [];
            if (remote && remote.message) bits.push(ADM.esc(remote.message));
            if (remote && remote.author) bits.push(ADM.esc(remote.author));
            if (remote && remote.date) bits.push(fmtDate(remote.date));
            if (res.repo) bits.push('仓库 <b>' + ADM.esc(res.repo) + '</b> @ ' + ADM.esc(res.branch || ''));
            bits.push('来源 ' + (res.method === 'api' ? 'GitHub API' : 'git'));
            if (res.status) bits.push('状态 ' + ADM.esc(res.status));
            q('uRemoteMeta').innerHTML = bits.join(' · ');
            if (res.hint) {
                q('uRemoteMeta').innerHTML += '<br><span class="adm-hint">' + ADM.esc(res.hint) + '</span>';
            }

            var badge = q('uRemoteBadge');
            S.updateAvailable = !!res.update_available;
            if (res.update_available) {
                badge.className = 'adm-badge warn';
                badge.textContent = '有 ' + (res.behind || res.commits.length || 1) + ' 个新提交';
            } else if (res.status === 'ahead') {
                badge.className = 'adm-badge info';
                badge.textContent = '本地领先';
            } else {
                badge.className = 'adm-badge ok';
                badge.textContent = '已是最新';
            }
            q('uBtnApply').disabled = !S.updateAvailable || S.busy;
            renderCommits(res.commits || []);
        }

        /* 渲染某个 Tab 的「上次结果」：sfx 是面板后缀（git / zip / bk） */
        function renderLast(sfx, last) {
            if (!last) return;
            var localSha = (S.local && S.local.sha) || '';
            var ok = last.status === 'done' ||
                (last.status === 'restarting' && last.to && last.to === localSha);
            var log = q('uRunLog_' + sfx);
            if (!log) return;
            var head = '<span class="ln"><span class="t">上次</span><span class="' +
                (ok ? 'ok' : 'warn') + '">' +
                (ok ? '上次操作已完成' : '上次操作状态：' + ADM.esc(last.status || '未知')) +
                (last.to ? '（→ ' + ADM.esc(String(last.to).slice(0, 7)) + '）' : '') +
                ' ' + ADM.esc(fmtDate(last.finished_at)) + '</span></span>';
            var lines = (last.events || []).map(function (ev) {
                return '<span class="ln"><span class="t">' + ADM.esc(fmtTime(ev.t)) + '</span>' +
                    '<span class="' + ADM.esc(ev.level || 'info') + '">' + ADM.esc(ev.text) + '</span></span>';
            }).join('');
            log.innerHTML = head + lines;
            log.scrollTop = log.scrollHeight;
            q('uRunState_' + sfx).textContent = ok ? '上次已完成' : '上次：' + (last.status || '未知');
        }

        /* 渲染某个 Tab 的实时进度 */
        function renderRun(run, sfx) {
            if (!run) return;
            sfx = sfx || S.sfx;
            var p = Math.max(0, Math.min(100, run.progress || 0));
            var bar = q('uProgressBar_' + sfx);
            if (!bar) return;
            bar.style.width = p + '%';
            bar.className = 'upd-bar-in' +
                (run.status === 'error' ? ' error' : (run.status === 'done' ? ' done' : ''));

            var steps = stepsFor(run.kind);
            var order = steps.map(function (s) { return s[0]; });
            var cur = order.indexOf(run.step);
            q('uRunSteps_' + sfx).innerHTML = steps.map(function (s, i) {
                var cls = 'upd-step';
                if (run.status === 'done' || (cur >= 0 && i < cur)) cls += ' done';
                else if (i === cur && run.status === 'running') cls += ' active';
                return '<span class="' + cls + '">' + ADM.esc(s[1]) + '</span>';
            }).join('');

            var stateText = {
                running: '执行中 ' + p + '%',
                done: '已完成',
                error: '失败',
                restarting: '正在重启…'
            }[run.status] || run.status;
            q('uRunState_' + sfx).textContent = stateText;

            var lines = (run.events || []).map(function (ev) {
                return '<span class="ln"><span class="t">' + ADM.esc(fmtTime(ev.t)) + '</span>' +
                    '<span class="' + ADM.esc(ev.level || 'info') + '">' + ADM.esc(ev.text) + '</span></span>';
            }).join('');
            var log = q('uRunLog_' + sfx);
            log.innerHTML = lines || '<span class="ln dim">等待输出…</span>';
            log.scrollTop = log.scrollHeight;
        }

        /* ------------------------------------------------------------ 轮询 */
        function startPoll(runId, kind) {
            stopPoll();
            S.runId = runId;
            S.sfx = TAB_OF[kind] || S.sfx || 'git';
            S.poll = setInterval(tick, 1200);
            tick();
        }

        async function tick() {
            if (!alive()) { stopPoll(); stopWait(); return; }
            if (!S.runId) return;
            try {
                /* store.db 任务有独立的进度接口，代码更新任务沿用在线更新的 */
                var statusUrl = (S.sfx === 'db')
                    ? '/api/adm/update/store/task?run_id='
                    : '/api/adm/update/status?run_id=';
                var run = await ADM.api(statusUrl + encodeURIComponent(S.runId));
                if (!alive()) { stopPoll(); return; }
                renderRun(run, S.sfx);
                if (run.status === 'done') {
                    stopPoll();
                    setBusy(false);
                    toast(DONE_TEXT[run.kind] || '操作完成', 'ok');
                    if (run.kind === 'init') {
                        refreshAfterInit();
                    } else if (run.kind === 'zip' || run.kind === 'restore') {
                        reloadState().catch(function () { });
                    }
                    if (run.kind === 'backup' || run.kind === 'restore') loadBackups();
                    if (S.sfx === 'db') {
                        loadStoreStatus();
                        /* 同步完成后用同一来源重新比对，差异面板立即反映最新状态 */
                        if (S.inspect && S.inspect.src_token && run.action === 'sync') {
                            inspectStore({ token: S.inspect.src_token, silent: true });
                        }
                    }
                } else if (run.status === 'error') {
                    stopPoll();
                    setBusy(false);
                    toast(run.error || '执行失败', 'err');
                } else if (run.status === 'restarting') {
                    stopPoll();
                    waitServer();
                }
            } catch (e) {
                /* 任务不存在或网络中断：代码更新任务多半是进程正在重启 */
                stopPoll();
                if (S.sfx === 'db') {
                    /* store.db 同步不会重启服务，任务丢失只可能是服务重启过 */
                    setBusy(false);
                    toast('同步任务状态丢失（服务可能已重启）', 'warn');
                    loadStoreStatus();
                    return;
                }
                waitServer();
            }
        }

        function waitServer() {
            if (S.wait) return;
            pq('uRunState').textContent = '等待服务恢复…';
            toast('服务正在重启，等待恢复…', 'warn');
            var tries = 0;
            S.wait = setInterval(async function () {
                if (!alive()) { stopWait(); return; }
                tries++;
                try {
                    await ADM.api('/api/adm/update?ts=' + Date.now());
                    stopWait();
                    toast('服务已恢复，正在刷新…', 'ok');
                    setTimeout(function () { ADM.reload(); }, 800);
                } catch (e) {
                    if (tries >= 60) {
                        stopWait();
                        setBusy(false);
                        toast('服务在 2 分钟内没有恢复，请到服务器检查日志', 'err');
                    }
                }
            }, 2000);
        }

        function setBusy(busy) {
            S.busy = !!busy;
            q('uBtnInit').disabled = S.busy;
            q('uBtnCheck').disabled = S.busy;
            q('uBtnRestart').disabled = S.busy;
            q('uBtnBackup').disabled = S.busy;
            q('uBtnBkNow').disabled = S.busy;
            q('uBtnBkRefresh').disabled = S.busy;
            q('uBtnSave').disabled = S.busy;
            q('uBtnZip').disabled = S.busy || !S.zipFile;
            q('uBtnApply').disabled = S.busy || !S.updateAvailable;
            ['uBtnDbRefresh', 'uBtnDbBackup', 'uBtnDbSchema', 'uBtnDbInspect', 'uBtnDbApply'].forEach(function (id) {
                var btn = q(id);
                if (btn) btn.disabled = S.busy;
            });
        }

        /* ------------------------------------------------------------ 连接测试 */
        function probeLine(name, r) {
            var ok = !!(r && r.ok);
            var detail;
            if (ok) {
                detail = '连接正常 · ' + r.ms + ' ms';
                if (name === 'GitHub API' && r.remaining !== null && r.remaining !== undefined) {
                    detail += ' · 剩余 ' + r.remaining + '/' + (r.limit || '?') + ' 次';
                }
            } else {
                detail = '连接失败 · ' + ((r && r.error) || '未知错误');
            }
            return '<div style="margin:5px 0"><span class="adm-badge ' + (ok ? 'ok' : 'bad') + '">' +
                ADM.esc(name) + '</span> <span class="adm-hint">' + ADM.esc(detail) + '</span></div>';
        }

        async function probeConn() {
            var btn = q('uBtnProbe');
            btn.disabled = true;
            q('uProbeResult').innerHTML = '<span class="adm-hint">正在测试 GitHub API 与 git 拉取地址…</span>';
            try {
                var res = await ADM.api('/api/adm/update/probe', {
                    method: 'POST',
                    body: collectConfig()
                });
                if (!alive()) return;
                q('uProbeResult').innerHTML =
                    probeLine('GitHub API', res.api) +
                    probeLine('git 拉取', res.git) +
                    '<div class="adm-hint" style="margin-top:4px">git 地址：' + ADM.esc(res.git.url || '—') + '</div>';
                var okAll = res.api.ok && res.git.ok;
                toast(okAll ? '两条链路都正常' : '有链路不通，请看下方结果', okAll ? 'ok' : 'warn');
            } catch (e) {
                if (!alive()) return;
                q('uProbeResult').textContent = '测试失败：' + e.message;
                toast(e.message, 'err');
            } finally {
                if (alive()) btn.disabled = false;
            }
        }

        /* ------------------------------------------------------------ 配置悬浮框 */
        function openCfg() {
            q('uCfgCard').classList.add('is-open');
            q('uCfgMask').classList.add('is-open');
            document.body.classList.add('upd-lock');
            setTimeout(function () {
                var input = q('uRepo');
                if (input && !input.value) input.focus();
            }, 80);
        }

        function closeCfg() {
            q('uCfgCard').classList.remove('is-open');
            q('uCfgMask').classList.remove('is-open');
            document.body.classList.remove('upd-lock');
        }

        function isCfgOpen() {
            return q('uCfgCard').classList.contains('is-open');
        }

        /* ------------------------------------------------------------ 动作 */
        async function saveConfig(silent) {
            var res = await ADM.api('/api/adm/update/config', {
                method: 'POST',
                body: collectConfig()
            });
            S.cfg = res.config || S.cfg;
            if (!silent) {
                q('uSaveHint').textContent = '已保存 ' + new Date().toLocaleTimeString();
                toast('配置已保存', 'ok');
            }
            return res;
        }

        async function checkUpdate() {
            setBusy(true);
            q('uRemoteBadge').className = 'adm-badge mute';
            q('uRemoteBadge').textContent = '检查中…';
            try {
                await saveConfig(true);
                var res = await ADM.api('/api/adm/update/check', { method: 'POST', body: {} });
                if (!alive()) return;
                renderCheck(res);
                if (res.ok && !res.error) {
                    toast(res.update_available ? '发现新版本' : '已是最新版本',
                        res.update_available ? 'ok' : 'warn');
                }
            } catch (e) {
                if (!alive()) return;
                toast(e.message, 'err');
                q('uRemoteBadge').className = 'adm-badge bad';
                q('uRemoteBadge').textContent = '检查失败';
                q('uRemoteMeta').textContent = e.message;
                if (/仓库|令牌|分支|origin|Git/i.test(String(e.message))) openCfg();
            } finally {
                if (alive()) setBusy(false);
            }
        }

        /* 只重读本地状态（徽标 / 版本号 / 目录），不打断当前进度日志 */
        async function reloadState() {
            var st = await ADM.api('/api/adm/update?ts=' + Date.now());
            if (!alive()) return null;
            S.cfg = st.config;
            S.local = st.local;
            S.env = st.env;
            renderLocal(st.local);
            renderEnv(st.env);
            return st;
        }

        /* 初始化完成后：顺手检查一次远端 */
        async function refreshAfterInit() {
            try {
                var st = await reloadState();
                if (st && st.local && st.local.has_git) checkUpdate();
            } catch (e) {
                /* 刷新失败不影响已完成的初始化结果 */
            }
        }

        /* ------------------------------------------------------------ ZIP 包更新 */
        function fmtSize(n) {
            if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(2) + ' MB';
            if (n >= 1024) return (n / 1024).toFixed(0) + ' KB';
            return n + ' B';
        }

        /* 上传用 XHR：fetch 拿不到上传进度，ZIP 包一般有几 MB，有进度条体验更好 */
        function uploadZip(fd, onProgress) {
            return new Promise(function (resolve, reject) {
                var xhr = new XMLHttpRequest();
                xhr.open('POST', '/api/adm/update/zip');
                xhr.upload.onprogress = function (ev) {
                    if (ev.lengthComputable && onProgress) {
                        onProgress(Math.round(ev.loaded / ev.total * 100));
                    }
                };
                xhr.onload = function () {
                    var d = null;
                    try { d = JSON.parse(xhr.responseText || '{}'); } catch (e) { }
                    if (xhr.status === 401) {
                        location.href = '/login?next=/admin';
                        return reject(new Error('登录已过期，请重新登录'));
                    }
                    if (xhr.status === 413) {
                        return reject(new Error('文件超过服务器允许的上传大小（32MB）'));
                    }
                    if (xhr.status >= 200 && xhr.status < 300 && d && d.ok) return resolve(d);
                    reject(new Error((d && d.error) || ('上传失败（HTTP ' + xhr.status + '）')));
                };
                xhr.onerror = function () { reject(new Error('网络错误，上传中断')); };
                xhr.onabort = function () { reject(new Error('上传已取消')); };
                xhr.send(fd);
            });
        }

        function resetZipPick() {
            S.zipFile = null;
            q('uZipFile').value = '';
            q('uZipName').textContent = '未选择文件';
            q('uBtnZip').disabled = true;
        }

        async function zipUpdate() {
            var f = S.zipFile;
            if (!f) {
                toast('请先选择一个 ZIP 压缩包', 'warn');
                return;
            }
            if (!/\.zip$/i.test(f.name)) {
                toast('只支持 .zip 压缩包', 'err');
                return;
            }
            var go = await ADM.confirm('上传 ZIP 并更新',
                '将把 <code>' + ADM.esc(f.name) + '</code> 解压后覆盖到项目目录（' +
                ADM.esc((S.env && S.env.root) || '项目根目录') + '）。<br>' +
                '<span class="adm-hint">覆盖前会把当前代码整份备份到 <code>data/update_backup/</code>；' +
                'data/、.env、虚拟环境、日志不会被覆盖；更新完按配置的重启方式重启服务。</span>', '上传并更新');
            if (!go) return;
            setBusy(true);
            S.sfx = 'zip';                             /* ZIP 更新写自己的进度面板 */
            pq('uRunState').textContent = '上传中 0%';
            pq('uRunLog').innerHTML = '<span class="ln dim">正在上传 ' + ADM.esc(f.name) + '…</span>';
            pq('uProgressBar').style.width = '0%';
            pq('uProgressBar').className = 'upd-bar-in';
            var fd = new FormData();
            fd.append('file', f);
            try {
                var res = await uploadZip(fd, function (pct) {
                    if (!alive()) return;
                    pq('uRunState').textContent = '上传中 ' + pct + '%';
                    pq('uProgressBar').style.width = Math.round(pct * 0.2) + '%';
                });
                if (!alive()) return;
                pq('uRunLog').innerHTML = '<span class="ln ok">上传完成，开始解压更新…</span>';
                resetZipPick();
                startPoll(res.run_id, 'zip');
            } catch (e) {
                if (!alive()) return;
                setBusy(false);
                pq('uRunState').textContent = '上传失败';
                pq('uRunLog').innerHTML = '<span class="ln error">' + ADM.esc(e.message) + '</span>';
                toast(e.message, 'err');
            }
        }

        async function initRepo() {
            if (!q('uRepo').value.trim()) {
                toast('请先填写 GitHub 仓库地址', 'warn');
                openCfg();
                return;
            }
            var go = await ADM.confirm('初始化 Git 仓库',
                '当前目录不是 Git 仓库（多为下载 ZIP 解压安装），将在项目目录下执行：<br>' +
                '<code>git init</code> → 关联 <b>origin</b> → <code>git fetch</code> → 强制切换到远端分支。<br>' +
                '<span class="adm-hint">服务器上与版本库同名的文件会被<b>远端版本覆盖</b>，手工改过的代码会丢失，' +
                '建议先备份；data/、.env、虚拟环境、日志不在版本库内，不会被删除。</span>', '开始初始化');
            if (!go) return;
            setBusy(true);
            S.sfx = 'git';
            pq('uRunLog').innerHTML = '<span class="ln dim">正在初始化 Git 仓库…</span>';
            try {
                await saveConfig(true);
                var res = await ADM.api('/api/adm/update/init', { method: 'POST', body: {} });
                if (!alive()) return;
                startPoll(res.run_id, 'init');
            } catch (e) {
                if (!alive()) return;
                setBusy(false);
                toast(e.message, 'err');
            }
        }

        async function applyUpdate() {
            if (!S.updateAvailable) return;
            var reset = false;
            if (S.local && S.local.dirty) {
                var files = (S.local.dirty_files || []).join('、');
                var goDirty = await ADM.confirm('服务器有未提交的本地改动',
                    '以下文件有本地改动：<br><code>' + ADM.esc(files) + '</code><br>' +
                    '<span class="adm-hint">继续更新可能失败，确定继续？</span>', '继续更新');
                if (!goDirty) return;
            }
            if (S.cfg && S.cfg.hard_reset) {
                reset = !!(await ADM.confirm('强制覆盖模式已开启',
                    '点「确定」= 丢弃本地未提交改动（<code>git reset --hard</code>）后再更新；<br>' +
                    '点「取消」= 先尝试安全的快进合并。', '丢弃并更新'));
            }
            var go = await ADM.confirm('开始更新',
                '将从远端拉取代码并重启服务，过程中服务可能短暂不可用。', '开始更新');
            if (!go) return;
            setBusy(true);
            S.sfx = 'git';
            pq('uRunLog').innerHTML = '<span class="ln dim">正在启动更新任务…</span>';
            try {
                var res = await ADM.api('/api/adm/update/apply', {
                    method: 'POST',
                    body: { reset: reset }
                });
                if (!alive()) return;
                startPoll(res.run_id, 'update');
            } catch (e) {
                if (!alive()) return;
                setBusy(false);
                toast(e.message, 'err');
            }
        }

        /* 手动备份：把当前代码打包到 data/update_backup/（更新前也会自动做一次） */
        async function backupNow() {
            var go = await ADM.confirm('备份当前代码',
                '将把项目源码打包成 zip 存到 <code>data/update_backup/</code>。<br>' +
                '<span class="adm-hint">不含 data/（运行数据、上传的文件）、logs/、虚拟环境、.git、' +
                '__pycache__；.env 会一起备份，方便回滚。保留最近 10 份。</span>', '开始备份');
            if (!go) return;
            setBusy(true);
            S.sfx = 'bk';                              /* 手动备份写备份 Tab 自己的面板 */
            pq('uRunLog').innerHTML = '<span class="ln dim">正在打包当前代码…</span>';
            pq('uRunState').textContent = '备份中…';
            try {
                var res = await ADM.api('/api/adm/update/backup', { method: 'POST', body: {} });
                if (!alive()) return;
                startPoll(res.run_id, 'backup');
            } catch (e) {
                if (!alive()) return;
                setBusy(false);
                toast(e.message, 'err');
            }
        }

        /* ------------------------------------------------------------ 备份记录 */
        function renderBackups(data) {
            var list = (data && data.backups) || [];
            q('uBkDir').textContent = (data && data.dir) ? '目录 ' + data.dir : '';
            q('uBkDir').title = (data && data.dir) || '';
            if (!list.length) {
                q('uBkList').innerHTML =
                    '<div class="upd-empty">还没有备份记录。执行一次更新会自动备份，也可以点「立即备份」。</div>';
                return;
            }
            q('uBkList').innerHTML = list.map(function (b, i) {
                var badge = b.tag === 'manual' ? 'info' : (b.tag === 'restore' ? 'mute' : 'warn');
                var meta = [
                    '<span class="adm-badge ' + badge + '">' + ADM.esc(b.label || b.tag) + '</span>',
                    ADM.esc(fmtDate(b.ts)),
                    ADM.esc(fmtSize(b.size)),
                    b.files >= 0 ? (ADM.esc(String(b.files)) + ' 个文件') : '文件数未知'
                ].join(' · ');
                return '<div class="upd-bk">' +
                    '<div class="upd-bk-main">' +
                        '<div class="upd-bk-name">' + ADM.esc(b.name) +
                            (i === 0 ? ' <span class="adm-badge ok">最新</span>' : '') + '</div>' +
                        '<div class="upd-bk-meta">' + meta + '</div>' +
                    '</div>' +
                    '<div class="upd-bk-acts">' +
                        '<button class="adm-btn ghost sm" type="button" data-bk-restore="' +
                            ADM.esc(b.name) + '"><i class="bi bi-clock-history"></i> 恢复</button>' +
                        '<a class="adm-btn ghost sm" href="/api/adm/update/backup/download?name=' +
                            encodeURIComponent(b.name) + '"><i class="bi bi-download"></i> 下载</a>' +
                        '<button class="adm-btn danger sm" type="button" data-bk-del="' +
                            ADM.esc(b.name) + '"><i class="bi bi-trash"></i> 删除</button>' +
                    '</div>' +
                '</div>';
            }).join('');
        }

        async function loadBackups() {
            try {
                var data = await ADM.api('/api/adm/update/backups?ts=' + Date.now());
                if (!alive()) return;
                renderBackups(data);
            } catch (e) {
                if (!alive()) return;
                q('uBkList').innerHTML =
                    '<div class="upd-empty">读取备份记录失败：' + ADM.esc(e.message) + '</div>';
            }
        }

        async function restoreBackup(name) {
            var go = await ADM.confirm('恢复到该备份',
                '将把项目代码还原成 <code>' + ADM.esc(name) + '</code> 里的内容。<br>' +
                '<span class="adm-hint">恢复前会自动给当前代码再做一份快照（<code>restore_*.zip</code>），' +
                '恢复错了还能再回来；备份之后新增的文件不会被删除；完成后按配置的重启方式重启。</span>',
                '开始恢复');
            if (!go) return;
            setBusy(true);
            S.sfx = 'bk';                              /* 恢复备份写备份 Tab 自己的面板 */
            pq('uRunState').textContent = '恢复中…';
            pq('uRunLog').innerHTML = '<span class="ln dim">正在恢复到 ' + ADM.esc(name) + '…</span>';
            try {
                var res = await ADM.api('/api/adm/update/restore', {
                    method: 'POST',
                    body: { name: name }
                });
                if (!alive()) return;
                startPoll(res.run_id, 'restore');
            } catch (e) {
                if (!alive()) return;
                setBusy(false);
                toast(e.message, 'err');
            }
        }

        async function deleteBackup(name) {
            var go = await ADM.confirm('删除备份',
                '确定删除 <code>' + ADM.esc(name) + '</code> 吗？删除后无法找回。', '删除');
            if (!go) return;
            try {
                await ADM.api('/api/adm/update/backup/delete', {
                    method: 'POST',
                    body: { name: name }
                });
                if (!alive()) return;
                toast('备份已删除', 'ok');
                loadBackups();
            } catch (e) {
                if (!alive()) return;
                toast(e.message, 'err');
            }
        }

        async function restartOnly() {
            var okRestart = await ADM.confirm('重启服务',
                '只重启服务，不拉取代码。<br>' +
                '<span class="adm-hint">重启期间服务会短暂不可用（几秒到十几秒）。</span>', '立即重启');
            if (!okRestart) return;
            setBusy(true);
            S.sfx = 'git';
            try {
                var res = await ADM.api('/api/adm/update/restart', { method: 'POST', body: {} });
                if (!alive()) return;
                startPoll(res.run_id, 'restart');
            } catch (e) {
                if (!alive()) return;
                setBusy(false);
                toast(e.message, 'err');
            }
        }

        /* ------------------------------------------------------------ store.db 同步 / 更新 */
        function dbFormParams() {
            return {
                mode: q('uDbMode').value,
                skip_cache: q('uDbSkipCache').checked,
                tables: q('uDbTables').value.trim()
            };
        }
        var DB_MODE_TEXT = { merge: '合并补齐', replace: '覆盖更新', overwrite: '整库替换' };

        /* 选完文件自动校验：只上传一次，之后用 src_token 复用；勾选表后才执行同步 */
        async function inspectStore(opts) {
            opts = opts || {};
            var f = S.dbFile;
            var url = q('uDbUrl').value.trim();
            var params = dbFormParams();
            params.tables = '';          // 差异报告始终覆盖全部表，不受同步范围影响
            var req;
            if (opts.token) {
                req = { body: Object.assign({}, params, {
                    src_token: opts.token,
                    display_name: (S.inspect && S.inspect.source && S.inspect.source.name) || '已校验来源'
                }) };
            } else if (opts.name) {
                req = { body: Object.assign({}, params, { name: opts.name }) };
            } else if (f) {
                var fd = new FormData();
                fd.append('file', f);
                fd.append('mode', params.mode);
                fd.append('skip_cache', params.skip_cache ? 'true' : 'false');
                fd.append('tables', params.tables || '');
                req = { form: fd };
            } else if (url) {
                req = { body: Object.assign({}, params, { url: url, token: q('uDbToken').value }) };
            } else {
                toast('请选择 .db 文件或填写远程 URL', 'warn');
                return;
            }
            S.inspectBusy = true;
            var seq = ++S.inspectSeq;
            q('uDbDiffCard').style.display = '';
            q('uDbDiffSummary').innerHTML = '<div class="upd-empty">正在校验来源并逐表比对，请稍候…</div>';
            q('uDbDiffList').innerHTML = '';
            q('uBtnDbInspect').disabled = true;
            try {
                var res = await ADM.api('/api/adm/update/store/inspect', {
                    method: 'POST', body: req.body, form: req.form
                });
                if (!alive() || seq !== S.inspectSeq) return;   // 已有更新的校验，丢弃旧结果
                S.inspect = res;
                renderDbDiff(res);
                if (!opts.silent) toast('校验完成，请确认差异后同步', 'ok');
            } catch (e) {
                if (!alive() || seq !== S.inspectSeq) return;
                q('uDbDiffSummary').innerHTML =
                    '<div class="upd-empty">校验失败：' + ADM.esc(e.message) + '</div>';
                q('uDbDiffList').innerHTML = '';
                toast(e.message, 'err');
            } finally {
                if (seq === S.inspectSeq) {
                    S.inspectBusy = false;
                    if (alive()) q('uBtnDbInspect').disabled = false;
                }
            }
        }

        function dbDiffBadge(t) {
            if (t.skip) return '<span class="adm-badge mute">跳过</span>';
            if (t.status === 'diff') return '<span class="adm-badge warn">有差异</span>';
            if (t.status === 'schema') return '<span class="adm-badge warn">结构不同</span>';
            if (t.status === 'src_only') return '<span class="adm-badge info">仅来源</span>';
            if (t.status === 'local_only') return '<span class="adm-badge mute">仅本地</span>';
            if (t.status === 'large') return '<span class="adm-badge info">数据量大</span>';
            return '<span class="adm-badge ok">一致</span>';
        }

        function renderDbDiff(res) {
            var sum = res.summary || {};
            var srcName = (res.source && res.source.name) || '';
            q('uDbDiffSource').textContent = '来源 ' + srcName + ' · ' +
                fmtSize(res.source ? res.source.size : 0);
            q('uDbDiffSource').title = srcName;
            var cells = [
                ['来源 / 本地表', (sum.src_tables || 0) + ' / ' + (sum.local_tables || 0)],
                ['有差异', (sum.diff || 0) + ' 张'],
                ['结构不同', (sum.schema || 0) + ' 张'],
                ['数据一致', (sum.same || 0) + ' 张'],
                ['仅来源 / 仅本地', (sum.src_only || 0) + ' / ' + (sum.local_only || 0)],
                ['可同步 / 跳过', (sum.syncable || 0) + ' / ' + (sum.skipped || 0)],
                ['预计变更行', (sum.change || 0).toLocaleString() + ' 行'],
                ['同步模式', ADM.esc(DB_MODE_TEXT[res.mode] || res.mode || '—')]
            ];
            q('uDbDiffSummary').innerHTML = cells.map(function (c) {
                return '<div class="upd-db-stat"><span>' + c[0] + '</span><b>' + c[1] + '</b></div>';
            }).join('');
            S.picked = {};
            (res.tables || []).forEach(function (t) {
                S.picked[t.name] = !t.skip && t.status !== 'same' &&
                    t.status !== 'local_only' && t.status !== 'src_only';
            });
            renderDbDiffRows(res);
            if (sum.estimated) toast(sum.estimated + ' 张表数据较大，仅按行数估算差异', 'warn');
        }

        function renderDbDiffRows(res) {
            var only = q('uDbDiffOnlyDiff').checked;
            var rows = (res.tables || []).filter(function (t) {
                return !only || t.status !== 'same';
            });
            if (!rows.length) {
                q('uDbDiffList').innerHTML = '<div class="upd-empty">没有符合筛选条件的表。</div>';
                updatePickedTables();
                return;
            }
            var max = 1;
            rows.forEach(function (t) {
                max = Math.max(max, t.local_rows || 0, t.src_rows || 0);
            });
            q('uDbDiffList').innerHTML = rows.map(function (t) {
                var lw = Math.max(1, Math.round((t.local_rows || 0) / max * 100));
                var sw = Math.max(1, Math.round((t.src_rows || 0) / max * 100));
                var chips = '';
                if ((t.src_only_cols || []).length) {
                    chips += '<span class="upd-db-chip add">来源多列：' +
                        ADM.esc(t.src_only_cols.join('、')) + '</span>';
                }
                if ((t.local_only_cols || []).length) {
                    chips += '<span class="upd-db-chip del">本地多列：' +
                        ADM.esc(t.local_only_cols.join('、')) + '</span>';
                }
                chips += t.src_diff >= 0
                    ? '<span class="upd-db-chip">来源多 ' + t.src_diff + ' 行 · 本地多 ' + t.local_diff + ' 行</span>'
                    : '<span class="upd-db-chip mute">数据量大，未逐行比对</span>';
                if (t.skip_reason) {
                    chips += '<span class="upd-db-chip mute">' + ADM.esc(t.skip_reason) + '</span>';
                }
                return '<div class="upd-db-row' + (t.skip ? ' is-skip' : '') + '">' +
                    '<label class="upd-db-pick"><input type="checkbox" data-db-table="' +
                        ADM.esc(t.name) + '"' + (S.picked[t.name] ? ' checked' : '') +
                        (t.skip ? ' disabled' : '') + '></label>' +
                    '<div class="upd-db-row-main">' +
                        '<div class="upd-db-row-head"><b>' + ADM.esc(t.name) + '</b>' + dbDiffBadge(t) +
                            '<span class="adm-hint">预计变更 ' + (t.change || 0).toLocaleString() + ' 行</span></div>' +
                        '<div class="upd-db-bars">' +
                            '<div class="upd-db-bar"><i class="local" style="width:' + lw + '%"></i>' +
                                '<span>本地 ' + (t.local_rows || 0).toLocaleString() + '</span></div>' +
                            '<div class="upd-db-bar"><i class="src" style="width:' + sw + '%"></i>' +
                                '<span>来源 ' + (t.src_rows || 0).toLocaleString() + '</span></div>' +
                        '</div>' +
                        '<div class="upd-db-chips">' + chips + '</div>' +
                    '</div>' +
                '</div>';
            }).join('');
            updatePickedTables();
        }

        function updatePickedTables() {
            if (!S.inspect) return;
            var names = (S.inspect.tables || []).filter(function (t) {
                return S.picked[t.name];
            }).map(function (t) { return t.name; });
            q('uDbTables').value = names.join(', ');
            q('uDbDiffHint').textContent = '已勾选 ' + names.length +
                ' 张表；范围已写入上方输入框，可直接编辑后同步。';
        }

        async function syncSelected() {
            if (S.inspectBusy) { toast('正在校验来源，请稍候', 'warn'); return; }
            if (!S.inspect) { toast('请先校验来源', 'warn'); return; }
            /* 勾选结果已写入输入框，也允许手动微调后再同步 */
            var names = q('uDbTables').value.split(/[,，\s]+/).filter(function (x) { return x; });
            if (!names.length) { toast('请至少勾选一张表', 'warn'); return; }
            var mode = q('uDbMode').value;
            var extra = (mode === 'overwrite')
                ? '<b>整库替换会清空选中表的数据，务必确认已备份！</b>'
                : '同步前会自动备份当前库并补齐表结构。';
            var go = await ADM.confirm('按勾选的表开始同步',
                '来源：<b>' + ADM.esc(S.inspect.source.name) + '</b><br>已勾选 <b>' + names.length +
                '</b> 张表 · 模式：' + ADM.esc(DB_MODE_TEXT[mode] || mode) + '<br>' +
                '<span class="adm-hint">' + extra + '</span>', '开始同步');
            if (!go) return;
            var params = dbFormParams();
            params.action = 'sync';
            params.src_token = S.inspect.src_token;
            params.tables = names.join(',');
            runDbTask(params, false);
        }

        function renderStoreStatus(st) {
            q('uDbPath').textContent = '文件 ' + (st.path || '');
            q('uDbPath').title = st.path || '';
            q('uDbBkDir').textContent = st.backup_dir ? '目录 ' + st.backup_dir : '';
            q('uDbBkDir').title = st.backup_dir || '';
            var missing = st.missing_tables || [];
            var health = missing.length
                ? '<span class="adm-badge warn">缺 ' + missing.length + ' 张表</span>'
                : '<span class="adm-badge ok">表结构完整</span>';
            var cells = [
                ['文件大小', ADM.esc(fmtSize(st.size || 0))],
                ['表数量', ADM.esc(String(st.table_count || 0)) + ' 张'],
                ['总行数', (st.row_count || 0).toLocaleString() + ' 行'],
                ['WAL 大小', ADM.esc(fmtSize(st.wal_size || 0))],
                ['最后修改', ADM.esc(fmtDate(st.mtime) || '—')],
                ['结构检查', health]
            ];
            q('uDbStats').innerHTML = cells.map(function (c) {
                return '<div class="upd-db-stat"><span>' + c[0] + '</span><b>' + c[1] + '</b></div>';
            }).join('');
            q('uDbSchemaHint').textContent = missing.length
                ? '检测到缺少：' + missing.join('、') + '，点左侧按钮补齐'
                : '代码升级后补齐新增的表 / 列，可重复执行';
        }

        function renderStoreBackups(list) {
            if (!list.length) {
                q('uDbBkList').innerHTML =
                    '<div class="upd-empty">还没有快照。点「备份到服务器」或执行一次同步会自动生成。</div>';
                return;
            }
            q('uDbBkList').innerHTML = list.map(function (b, i) {
                return '<div class="upd-bk">' +
                    '<div class="upd-bk-main">' +
                        '<div class="upd-bk-name">' + ADM.esc(b.name) +
                            (i === 0 ? ' <span class="adm-badge ok">最新</span>' : '') + '</div>' +
                        '<div class="upd-bk-meta">' +
                            '<span class="adm-badge info">' + ADM.esc(b.label || '快照') + '</span> · ' +
                            ADM.esc(fmtDate(b.ts)) + ' · ' + ADM.esc(fmtSize(b.size)) +
                        '</div>' +
                    '</div>' +
                    '<div class="upd-bk-acts">' +
                        '<button class="adm-btn ghost sm" type="button" data-db-restore="' +
                            ADM.esc(b.name) + '"><i class="bi bi-arrow-counterclockwise"></i> 恢复</button>' +
                        '<a class="adm-btn ghost sm" href="/api/adm/update/store/backup/download?name=' +
                            encodeURIComponent(b.name) + '"><i class="bi bi-download"></i> 下载</a>' +
                        '<button class="adm-btn danger sm" type="button" data-db-del="' +
                            ADM.esc(b.name) + '"><i class="bi bi-trash"></i> 删除</button>' +
                    '</div>' +
                '</div>';
            }).join('');
        }

        async function loadStoreStatus() {
            try {
                var st = await ADM.api('/api/adm/update/store?ts=' + Date.now());
                if (!alive()) return;
                S.store = st;
                renderStoreStatus(st);
                renderStoreBackups(st.backups || []);
            } catch (e) {
                if (!alive()) return;
                var msg = '<div class="upd-empty">读取失败：' + ADM.esc(e.message) + '</div>';
                q('uDbStats').innerHTML = msg;
                q('uDbBkList').innerHTML = msg;
            }
        }

        /* 所有 store.db 操作都跑在后台任务里，统一复用本 Tab 的进度面板轮询 */
        async function runDbTask(params, withFile) {
            setBusy(true);
            S.sfx = 'db';
            pq('uRunState').textContent = '执行中…';
            pq('uRunLog').innerHTML = '<span class="ln dim">正在启动 store.db 任务…</span>';
            try {
                var res;
                if (withFile) {
                    var fd = new FormData();
                    fd.append('file', S.dbFile);
                    fd.append('mode', params.mode);
                    fd.append('skip_cache', params.skip_cache ? 'true' : 'false');
                    fd.append('tables', params.tables || '');
                    res = await ADM.api('/api/adm/update/store/upload', { method: 'POST', form: fd });
                } else {
                    res = await ADM.api('/api/adm/update/store/task', { method: 'POST', body: params });
                }
                if (!alive()) return;
                startPoll(res.run_id, DB_KIND_OF[params.action] || 'dbsync');
            } catch (e) {
                if (!alive()) return;
                setBusy(false);
                pq('uRunLog').innerHTML = '<span class="ln error">' + ADM.esc(e.message) + '</span>';
                toast(e.message, 'err');
            }
        }

        async function restoreStoreBackup(name) {
            /* 恢复也先走校验：把服务器快照当作来源做差异预览，确认后才同步 */
            await inspectStore({ name: name });
        }

        async function deleteStoreBackup(name) {
            var go = await ADM.confirm('删除快照',
                '确定删除 <code>' + ADM.esc(name) + '</code> 吗？删除后无法找回。', '删除');
            if (!go) return;
            runDbTask({ action: 'delete', name: name }, false);
        }

        /* ------------------------------------------------------------ 启动 */
        async function boot() {
            try {
                var st = await ADM.api('/api/adm/update');
                if (!alive()) return;
                S.cfg = st.config;
                S.local = st.local;
                S.env = st.env;
                fillConfig(st.config);
                renderLocal(st.local);
                renderEnv(st.env);
                if (st.run && st.run.status === 'running') {
                    S.sfx = TAB_OF[st.run.kind] || 'git';
                    renderRun(st.run, S.sfx);
                    startPoll(st.run.id, st.run.kind);
                } else if (st.run && st.run.status === 'restarting') {
                    S.sfx = TAB_OF[st.run.kind] || 'git';
                    renderRun(st.run, S.sfx);
                    waitServer();
                } else {
                    /* st.last 是 {任务类型: 上次结果}：每个 Tab 取自己类型里最近的一条回显 */
                    var allLast = st.last || {};
                    Object.keys(TAB_KINDS).forEach(function (sfx) {
                        var best = null;
                        (TAB_KINDS[sfx] || []).forEach(function (k) {
                            var it = allLast[k];
                            if (it && (!best || (it.finished_at || 0) > (best.finished_at || 0))) best = it;
                        });
                        if (best) renderLast(sfx, best);
                    });
                }
                if (st.local && (!st.local.has_git || !st.local.sha)) {
                    toast(st.local.has_git ? '本地仓库为空，请点「初始化 Git 仓库」补齐'
                        : (st.local.error || '当前目录不是 Git 仓库'), 'warn');
                    /* 初始化需要仓库地址：没配置过就直接把配置框弹出来 */
                    if (!st.config.repo) openCfg();
                } else if (st.local && !st.config.repo && !st.local.origin) {
                    /* 既没配置仓库、本地也没有 origin：不打开配置框就没法检查 */
                    openCfg();
                }
                loadBackups();      /* 备份 Tab 的列表（切到该 Tab 时也会再刷新一次） */
                loadStoreStatus();  /* 初始就选中 store.db Tab 时 onShow 不会触发，这里主动加载 */
                /* store.db 任务进行中刷新了页面：续上进度轮询（不与代码更新任务抢同一个定时器） */
                if (!(st.run && st.run.status === 'running')) {
                    ADM.api('/api/adm/update/store/task').then(function (run) {
                        if (!alive() || !run || run.status !== 'running') return;
                        S.sfx = 'db';
                        setBusy(true);
                        renderRun(run, 'db');
                        startPoll(run.id, run.kind);
                    }).catch(function () { });
                }
            } catch (e) {
                if (!alive()) return;
                toast(e.message, 'err');
            }
        }

        /* ------------------------------------------------------------ 事件 */
        q('uCfgForm').addEventListener('submit', async function (e) {
            e.preventDefault();
            try {
                await saveConfig(false);
                if (alive()) closeCfg();
            } catch (err) {
                toast(err.message, 'err');
            }
        });
        q('uBtnInit').addEventListener('click', initRepo);
        q('uZipFile').addEventListener('change', function () {
            var f = (this.files && this.files[0]) || null;
            S.zipFile = f;
            q('uZipName').textContent = f ? (f.name + ' · ' + fmtSize(f.size)) : '未选择文件';
            q('uBtnZip').disabled = !f || S.busy;
        });
        q('uBtnZip').addEventListener('click', zipUpdate);
        q('uBtnCfg').addEventListener('click', openCfg);
        q('uBtnProbe').addEventListener('click', probeConn);
        q('uCfgClose').addEventListener('click', closeCfg);
        q('uCfgMask').addEventListener('click', closeCfg);
        q('uRestart').addEventListener('change', toggleRestartCmd);
        q('uBtnCheck').addEventListener('click', checkUpdate);
        q('uBtnApply').addEventListener('click', applyUpdate);
        q('uBtnRestart').addEventListener('click', restartOnly);
        q('uBtnBackup').addEventListener('click', backupNow);
        q('uBtnBkNow').addEventListener('click', backupNow);
        q('uBtnBkRefresh').addEventListener('click', loadBackups);
        /* 备份记录是动态渲染的，用事件委托绑定「恢复 / 删除」 */
        q('uBkList').addEventListener('click', function (e) {
            var r = e.target.closest('[data-bk-restore]');
            if (r) { restoreBackup(r.dataset.bkRestore); return; }
            var d = e.target.closest('[data-bk-del]');
            if (d) deleteBackup(d.dataset.bkDel);
        });
        /* 隐藏原生 file input：自定义拖放区负责展示已选文件与移除 */
        function setDbFile(f) {
            if (f && !/\.(db|sqlite|sqlite3)$/i.test(f.name || '')) {
                toast('请选择 .db / .sqlite / .sqlite3 数据库文件', 'warn');
                return;
            }
            if (f && f.size > 512 * 1024 * 1024) {
                toast('文件超过 512MB，无法上传', 'warn');
                return;
            }
            S.dbFile = f || null;
            q('uDbDrop').classList.toggle('has-file', !!f);
            q('uDbFileName').textContent = f ? f.name : '点击选择，或把 .db 文件拖到这里';
            q('uDbFileSub').textContent = f
                ? ('已选择 · ' + fmtSize(f.size) + ' · 点击可重新选择')
                : '支持 store.db / .sqlite 快照，最大 512MB';
            q('uBtnDbClear').style.display = f ? '' : 'none';
            if (f) {
                inspectStore({ file: true });       /* 选完文件立即上传校验并预览差异 */
            } else {
                S.inspect = null;
                q('uDbDiffCard').style.display = 'none';
            }
        }
        q('uDbDrop').addEventListener('click', function (e) {
            if (e.target.closest('#uBtnDbClear')) return;
            q('uDbFile').click();
        });
        q('uDbFile').addEventListener('change', function () {
            setDbFile((this.files && this.files[0]) || null);
        });
        q('uBtnDbClear').addEventListener('click', function (e) {
            e.stopPropagation();
            q('uDbFile').value = '';
            setDbFile(null);
        });
        ['dragenter', 'dragover'].forEach(function (evt) {
            q('uDbDrop').addEventListener(evt, function (e) {
                e.preventDefault();
                e.stopPropagation();
                q('uDbDrop').classList.add('drag-over');
            });
        });
        ['dragleave', 'drop'].forEach(function (evt) {
            q('uDbDrop').addEventListener(evt, function (e) {
                e.preventDefault();
                e.stopPropagation();
                q('uDbDrop').classList.remove('drag-over');
                if (evt === 'drop') {
                    var files = e.dataTransfer && e.dataTransfer.files;
                    if (files && files.length) setDbFile(files[0]);
                }
            });
        });
        q('uBtnDbRefresh').addEventListener('click', loadStoreStatus);
        q('uBtnDbBackup').addEventListener('click', function () {
            runDbTask({ action: 'backup' }, false);
        });
        q('uBtnDbSchema').addEventListener('click', function () {
            runDbTask({ action: 'schema' }, false);
        });
        q('uBtnDbInspect').addEventListener('click', function () { inspectStore(); });
        q('uBtnDbApply').addEventListener('click', syncSelected);
        q('uBtnDbPickAll').addEventListener('click', function () {
            Array.prototype.forEach.call(q('uDbDiffList').querySelectorAll('[data-db-table]'), function (b) {
                if (!b.disabled) { b.checked = true; S.picked[b.dataset.dbTable] = true; }
            });
            updatePickedTables();
        });
        q('uBtnDbPickDiff').addEventListener('click', function () {
            if (!S.inspect) return;
            (S.inspect.tables || []).forEach(function (t) {
                S.picked[t.name] = !t.skip && ['diff', 'schema', 'large'].indexOf(t.status) >= 0;
            });
            renderDbDiffRows(S.inspect);
        });
        q('uBtnDbPickNone').addEventListener('click', function () {
            Object.keys(S.picked).forEach(function (k) { S.picked[k] = false; });
            if (S.inspect) renderDbDiffRows(S.inspect);
        });
        q('uDbDiffOnlyDiff').addEventListener('change', function () {
            if (S.inspect) renderDbDiffRows(S.inspect);
        });
        q('uDbDiffList').addEventListener('change', function (e) {
            var box = e.target.closest('[data-db-table]');
            if (!box) return;
            S.picked[box.dataset.dbTable] = box.checked;
            updatePickedTables();
        });
        /* 模式 / 跳过缓存变了：用同一来源重新分析，不必重传文件 */
        ['uDbMode', 'uDbSkipCache'].forEach(function (id) {
            q(id).addEventListener('change', function () {
                if (S.inspect && S.inspect.src_token && !S.inspectBusy) {
                    inspectStore({ token: S.inspect.src_token, silent: true });
                }
            });
        });
        q('uDbBkList').addEventListener('click', function (e) {
            var r = e.target.closest('[data-db-restore]');
            if (r) { restoreStoreBackup(r.dataset.dbRestore); return; }
            var d = e.target.closest('[data-db-del]');
            if (d) deleteStoreBackup(d.dataset.dbDel);
        });

        /* Esc 关闭配置框；模块被切走时移除监听，避免重复绑定 */
        function onKey(e) {
            if (!alive()) {
                document.removeEventListener('keydown', onKey);
                return;
            }
            if (e.key === 'Escape' && isCfgOpen()) closeCfg();
        }
        document.addEventListener('keydown', onKey);

        /* 模块被替换 / 切走时清理定时器与遮罩锁（el 的内容被下个模块覆盖 → root 断开） */
        function cleanup() {
            stopPoll();
            stopWait();
            document.body.classList.remove('upd-lock');
            document.removeEventListener('keydown', onKey);
        }
        var observer = new MutationObserver(function () {
            if (!alive()) {
                cleanup();
                observer.disconnect();
            }
        });
        observer.observe(el, { childList: true });

        boot();
    }
});

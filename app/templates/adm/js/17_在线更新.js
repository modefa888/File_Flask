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
        var DONE_TEXT = {
            init: 'Git 仓库初始化完成',
            zip: 'ZIP 包更新完成',
            backup: '代码备份完成',
            restore: '已恢复到所选备份'
        };

        function stepsFor(kind) {
            if (kind === 'zip') return ZIP_STEPS;
            if (kind === 'backup') return BACKUP_STEPS;
            if (kind === 'restore') return RESTORE_STEPS;
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

        /* 每个 Tab 各自一份「执行进度」面板：sfx 用来区分元素 ID（git / zip / bk） */
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
        var TAB_OF = { update: 'git', init: 'git', restart: 'git', zip: 'zip', backup: 'bk', restore: 'bk' };
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
                var run = await ADM.api('/api/adm/update/status?run_id=' + encodeURIComponent(S.runId));
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
                } else if (run.status === 'error') {
                    stopPoll();
                    setBusy(false);
                    toast(run.error || '执行失败', 'err');
                } else if (run.status === 'restarting') {
                    stopPoll();
                    waitServer();
                }
            } catch (e) {
                /* 任务不存在或网络中断：很可能是进程正在重启 */
                stopPoll();
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

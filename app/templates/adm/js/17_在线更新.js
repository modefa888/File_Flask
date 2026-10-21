/* 后台管理：在线更新（从 GitHub 检查更新 / 拉取代码 / 重启服务）。 */
ADM.modules.push({
    id: 'update',
    name: '在线更新',
    subtitle: '从 GitHub 检查最新提交，拉取代码并重启服务',
    icon: 'bi-cloud-arrow-down',
    async load(el) {
        var STEPS = [
            ['init', '准备'],
            ['fetch', '拉取代码'],
            ['merge', '合并'],
            ['deps', '依赖'],
            ['restart', '重启']
        ];
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
            poll: null, wait: null
        };

        el.innerHTML = `
<div class="upd-wrap">
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
            <button class="adm-btn ghost" id="uBtnCfg" type="button">
                <i class="bi bi-sliders"></i> 更新配置
            </button>
            <button class="adm-btn ghost" id="uBtnCheck" type="button">
                <i class="bi bi-cloud-arrow-down"></i> 检查更新
            </button>
            <button class="adm-btn primary" id="uBtnApply" type="button" disabled>
                <i class="bi bi-download"></i> 立即更新
            </button>
            <button class="adm-btn ghost" id="uBtnRestart" type="button">
                <i class="bi bi-arrow-clockwise"></i> 仅重启
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
    </section>

    <section class="adm-card upd-progress-card">
        <div class="adm-section-head">
            <h3><i class="bi bi-activity"></i> 执行进度</h3>
            <span class="adm-spacer"></span>
            <span class="adm-hint" id="uRunState">空闲</span>
        </div>
        <div class="upd-steps" id="uRunSteps"></div>
        <div class="upd-bar">
            <div class="upd-bar-in" id="uProgressBar"></div>
        </div>
        <div class="upd-log" id="uRunLog">等待开始…</div>
    </section>
</div>

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
    </form>
</div>`;

        /* ------------------------------------------------------------ 工具 */
        /* el 是 #admView 容器本身，切模块时它不会断开；用模块根节点判断是否还在页面上 */
        var root = el.querySelector('.upd-wrap');
        function q(id) { return el.querySelector('#' + id); }
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
            if (!local.has_git) {
                badge.className = 'adm-badge bad';
                badge.textContent = '非 Git 仓库';
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

        function renderLast(last) {
            if (!last) return;
            var localSha = (S.local && S.local.sha) || '';
            var ok = last.status === 'done' ||
                (last.status === 'restarting' && last.to && last.to === localSha);
            var log = q('uRunLog');
            var head = '<span class="ln"><span class="t">上次</span><span class="' +
                (ok ? 'ok' : 'warn') + '">' +
                (ok ? '上次更新已完成' : '上次更新状态：' + ADM.esc(last.status || '未知')) +
                (last.to ? '（→ ' + ADM.esc(String(last.to).slice(0, 7)) + '）' : '') +
                ' ' + ADM.esc(fmtDate(last.finished_at)) + '</span></span>';
            var lines = (last.events || []).map(function (ev) {
                return '<span class="ln"><span class="t">' + ADM.esc(fmtTime(ev.t)) + '</span>' +
                    '<span class="' + ADM.esc(ev.level || 'info') + '">' + ADM.esc(ev.text) + '</span></span>';
            }).join('');
            log.innerHTML = head + lines;
            log.scrollTop = log.scrollHeight;
            q('uRunState').textContent = ok ? '上次更新已完成' : '上次更新：' + (last.status || '未知');
        }

        function renderRun(run) {
            if (!run) return;
            var p = Math.max(0, Math.min(100, run.progress || 0));
            var bar = q('uProgressBar');
            bar.style.width = p + '%';
            bar.className = 'upd-bar-in' +
                (run.status === 'error' ? ' error' : (run.status === 'done' ? ' done' : ''));

            var order = STEPS.map(function (s) { return s[0]; });
            var cur = order.indexOf(run.step);
            q('uRunSteps').innerHTML = STEPS.map(function (s, i) {
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
            q('uRunState').textContent = stateText;

            var lines = (run.events || []).map(function (ev) {
                return '<span class="ln"><span class="t">' + ADM.esc(fmtTime(ev.t)) + '</span>' +
                    '<span class="' + ADM.esc(ev.level || 'info') + '">' + ADM.esc(ev.text) + '</span></span>';
            }).join('');
            q('uRunLog').innerHTML = lines || '<span class="ln dim">等待输出…</span>';
            q('uRunLog').scrollTop = q('uRunLog').scrollHeight;
        }

        /* ------------------------------------------------------------ 轮询 */
        function startPoll(runId) {
            stopPoll();
            S.runId = runId;
            S.poll = setInterval(tick, 1200);
            tick();
        }

        async function tick() {
            if (!alive()) { stopPoll(); stopWait(); return; }
            if (!S.runId) return;
            try {
                var run = await ADM.api('/api/adm/update/status?run_id=' + encodeURIComponent(S.runId));
                if (!alive()) { stopPoll(); return; }
                renderRun(run);
                if (run.status === 'done') {
                    stopPoll();
                    setBusy(false);
                    toast('操作完成', 'ok');
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
            q('uRunState').textContent = '等待服务恢复…';
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
            q('uBtnCheck').disabled = S.busy;
            q('uBtnRestart').disabled = S.busy;
            q('uBtnSave').disabled = S.busy;
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

        async function applyUpdate() {
            if (!S.updateAvailable) return;
            var reset = false;
            if (S.local && S.local.dirty) {
                var files = (S.local.dirty_files || []).join('、');
                if (!confirm('服务器上有未提交的本地改动：\n' + files +
                    '\n\n继续更新可能失败。是否继续？')) return;
            }
            if (S.cfg && S.cfg.hard_reset) {
                reset = confirm('已开启「允许强制覆盖」。\n\n' +
                    '点「确定」= 丢弃本地未提交改动（git reset --hard）后更新；\n' +
                    '点「取消」= 先尝试安全的快进合并。');
            }
            if (!confirm('开始更新？过程中服务可能短暂不可用。')) return;
            setBusy(true);
            q('uRunLog').innerHTML = '<span class="ln dim">正在启动更新任务…</span>';
            try {
                var res = await ADM.api('/api/adm/update/apply', {
                    method: 'POST',
                    body: { reset: reset }
                });
                if (!alive()) return;
                startPoll(res.run_id);
            } catch (e) {
                if (!alive()) return;
                setBusy(false);
                toast(e.message, 'err');
            }
        }

        async function restartOnly() {
            if (!confirm('只重启服务（不拉取代码）？')) return;
            setBusy(true);
            try {
                var res = await ADM.api('/api/adm/update/restart', { method: 'POST', body: {} });
                if (!alive()) return;
                startPoll(res.run_id);
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
                    renderRun(st.run);
                    startPoll(st.run.id);
                } else if (st.run && st.run.status === 'restarting') {
                    renderRun(st.run);
                    waitServer();
                } else if (st.last) {
                    renderLast(st.last);
                }
                if (st.local && !st.local.has_git) {
                    toast(st.local.error || '当前目录不是 Git 仓库', 'warn');
                } else if (st.local && !st.config.repo && !st.local.origin) {
                    /* 既没配置仓库、本地也没有 origin：不打开配置框就没法检查 */
                    openCfg();
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
        q('uBtnCfg').addEventListener('click', openCfg);
        q('uBtnProbe').addEventListener('click', probeConn);
        q('uCfgClose').addEventListener('click', closeCfg);
        q('uCfgMask').addEventListener('click', closeCfg);
        q('uRestart').addEventListener('change', toggleRestartCmd);
        q('uBtnCheck').addEventListener('click', checkUpdate);
        q('uBtnApply').addEventListener('click', applyUpdate);
        q('uBtnRestart').addEventListener('click', restartOnly);

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

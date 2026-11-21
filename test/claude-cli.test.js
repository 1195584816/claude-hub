// 找 Claude Code + 没装时的一键安装(lib/claude-cli.js)。
//
// 这组测试是为 2026-11-13 那一幕建的:三月在别人电脑上装了总控,点「新会话」,
// 看到的是一屏 PowerShell 红字「无法将 claude 项识别为 cmdlet…」—— 那台电脑没装 Claude Code。
//
// 钉住的几件事:
//   · 官方安装器把 claude.exe 放在 用户目录\.local\bin,而且**不加 PATH** —— 那里也要找,开终端时要补进去
//   · 补 PATH 是**追加**:已经能找到 claude 的电脑,找到的必须还是原来那一个
//   · npm 装的是 claude.cmd / claude.ps1,不是 exe —— 也得认
//   · 检测本身出任何岔子都只能当成「装了」:绝不能因为检测有毛病就不让人开会话
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cli = require('../lib/claude-cli');

const HOME = 'C:\\Users\\demo';
const LB = 'C:\\Users\\demo\\.local\\bin';
const has = (...files) => { const s = new Set(files.map(f => f.toLowerCase())); return (p) => s.has(String(p).toLowerCase()); };
const W = (env, files) => ({ env, home: HOME, exists: has(...files), platform: 'win32' });

test('哪儿都没有 → 没装', () => {
  assert.deepEqual(cli.findClaude(W({ Path: 'C:\\Windows;C:\\Tools' }, ['C:\\Tools\\node.exe'])), { found: false });
  assert.deepEqual(cli.findClaude(W({}, [])), { found: false });
});

test('PATH 里有:exe / cmd / ps1 / bat / com 都认,名字不对的不认', () => {
  for (const n of ['claude.exe', 'claude.cmd', 'claude.ps1', 'claude.bat', 'claude.com']) {
    const r = cli.findClaude(W({ Path: 'C:\\Windows;C:\\npm' }, ['C:\\npm\\' + n]));
    assert.deepEqual(r, { found: true, path: 'C:\\npm\\' + n, via: 'path' }, n);
  }
  for (const n of ['claude', 'claude.txt', 'claude-code.exe', 'xclaude.exe']) {
    assert.equal(cli.findClaude(W({ Path: 'C:\\npm' }, ['C:\\npm\\' + n])).found, false, n);
  }
});

test('环境变量名大小写:Path / PATH / path 都得读得到;带引号、带空项的 PATH 也行', () => {
  for (const k of ['Path', 'PATH', 'path']) {
    assert.equal(cli.findClaude(W({ [k]: 'C:\\npm' }, ['C:\\npm\\claude.cmd'])).found, true, k);
  }
  assert.equal(cli.findClaude(W({ Path: ';;"C:\\Program Files\\x" ; C:\\npm ;' }, ['C:\\npm\\claude.cmd'])).found, true);
  assert.equal(cli.findClaude(W({ Path: '"C:\\Program Files\\x"' }, ['C:\\Program Files\\x\\claude.exe'])).found, true);
});

test('PATH 里没有、官方安装目录里有(安装器不加 PATH 的那种情况)→ 算装了', () => {
  const r = cli.findClaude(W({ Path: 'C:\\Windows' }, [LB + '\\claude.exe']));
  assert.deepEqual(r, { found: true, path: LB + '\\claude.exe', via: 'localbin' });
});

test('两处都有:以 PATH 里那个为准(和终端里敲 claude 的结果一致)', () => {
  const r = cli.findClaude(W({ Path: 'C:\\npm' }, ['C:\\npm\\claude.cmd', LB + '\\claude.exe']));
  assert.equal(r.path, 'C:\\npm\\claude.cmd');
  assert.equal(r.via, 'path');
});

test('查文件时出岔子:不往外抛,而且按「装了」算(拿不准就别挡人)', async () => {
  const boom = () => { throw new Error('EPERM'); };
  assert.deepEqual(cli.findClaude({ env: { Path: 'C:\\npm' }, home: HOME, exists: boom, platform: 'win32' }), { found: true, via: 'unsure' });
  assert.deepEqual(await cli.findClaudeAsync({ env: { Path: 'C:\\npm' }, home: HOME, exists: async () => { throw new Error('EPERM'); }, platform: 'win32' }), { found: true, via: 'unsure' });
});

test('默认用 lstat 判断文件在不在,不用 existsSync(「应用执行别名」那种壳 existsSync 看不见)', async () => {
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-cli-'));
  fs.writeFileSync(path.join(dir, 'claude.cmd'), '');
  const realExists = fs.existsSync;
  fs.existsSync = () => false;                 // 模拟 existsSync 对这种文件说「没有」
  let a, b;
  try {
    a = cli.findClaude({ env: { Path: dir }, home: path.join(dir, 'nohome'), platform: 'win32' });
    b = await cli.findClaudeAsync({ env: { Path: dir }, home: path.join(dir, 'nohome'), platform: 'win32' });
  } finally { fs.existsSync = realExists; }
  assert.equal(a.found, true); assert.equal(a.via, 'path');
  assert.equal(b.found, true); assert.equal(b.via, 'path');
  // 真的没有的目录 / 文件:明确判成没装
  assert.deepEqual(cli.findClaude({ env: { Path: path.join(dir, 'nope') + ';' + dir + '\\claude.cmd' }, home: path.join(dir, 'nohome'), platform: 'win32' }), { found: false });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('异步检测:找得到 / 找不到的结果和同步版一致', async () => {
  const cases = [
    [{ Path: 'C:\\npm' }, ['C:\\npm\\claude.cmd']],
    [{ Path: 'C:\\Windows' }, [LB + '\\claude.exe']],
    [{ Path: 'C:\\Windows' }, []],
    [{ Path: 'C:\\npm' }, ['C:\\npm\\claude.cmd', LB + '\\claude.exe']],
  ];
  for (const [env, files] of cases) {
    const ex = has(...files);
    assert.deepEqual(await cli.findClaudeAsync({ env, home: HOME, exists: async (p) => ex(p), platform: 'win32' }), cli.findClaude(W(env, files)));
  }
});

test('异步检测:查文件卡住(PATH 里有连不上的网络盘)→ 到点就当成装了,不陪着等', async () => {
  let asked = 0;
  const t0 = Date.now();
  const r = await cli.findClaudeAsync({ env: { Path: '\\\\dead\\share;C:\\npm' }, home: HOME, platform: 'win32', timeoutMs: 80,
    exists: (p) => { asked++; return new Promise(() => {}); } });
  assert.deepEqual(r, { found: true, via: 'timeout' });
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(asked, 1, '卡在第一个就不该再往下问');
  // 很慢但没卡死:超时之后不再接着查后面的位置
  let n = 0;
  const r2 = await cli.findClaudeAsync({ env: { Path: 'C:\\a;C:\\b;C:\\c' }, home: HOME, platform: 'win32', timeoutMs: 60,
    exists: (p) => { n++; return new Promise((res) => setTimeout(() => res(false), 45)); } });
  assert.equal(r2.via, 'timeout');
  const seen = n;
  await new Promise((res) => setTimeout(res, 200));
  assert.ok(n <= seen + 1, '超时后还在一个个查:' + seen + ' → ' + n);
  assert.ok(n < 16);
});

test('给界面的回答:只有明确查完确实没有才说没装;装了 / 超时 / 出岔子都说装了', async () => {
  const base = { home: HOME, platform: 'win32' };
  const miss = await cli.checkForUi(Object.assign({ env: { Path: 'C:\\Windows' }, exists: async () => false }, base));
  assert.equal(miss.found, false);
  assert.equal(miss.installCmd, cli.installCommand('win32'));
  assert.equal(miss.doc, cli.INSTALL_DOC);
  assert.equal(miss.unsure, false);
  const hit = await cli.checkForUi(Object.assign({ env: { Path: 'C:\\npm' }, exists: async (p) => p === 'C:\\npm\\claude.cmd' }, base));
  assert.deepEqual(hit, { found: true, unsure: false, installCmd: '', doc: cli.INSTALL_DOC });
  // 没查明白才放行的要带 unsure:界面这次放行,但不把「装了」记死
  const slow = await cli.checkForUi(Object.assign({ env: { Path: 'C:\\npm' }, exists: () => new Promise(() => {}), timeoutMs: 50 }, base));
  assert.deepEqual(slow, { found: true, unsure: true, installCmd: '', doc: cli.INSTALL_DOC });
  const bad = await cli.checkForUi(Object.assign({ env: { Path: 'C:\\npm' }, exists: async () => { throw new Error('x'); } }, base));
  assert.deepEqual(bad, { found: true, unsure: true, installCmd: '', doc: cli.INSTALL_DOC });
  const worse = await cli.checkForUi({ env: null, home: null, platform: 'win32' });     // 连参数都是坏的
  assert.equal(worse.found, true); assert.equal(worse.unsure, true);
  // 非 Windows 没装:说没装,但不给一键安装命令
  const mac = await cli.checkForUi({ env: { PATH: '/usr/bin' }, home: '/Users/u', platform: 'darwin', exists: async () => false });
  assert.deepEqual(mac, { found: false, unsure: false, installCmd: '', doc: cli.INSTALL_DOC });
  assert.equal(cli.DEFAULT_TIMEOUT_MS, 1500, '界面最多等 1.5 秒');
});

test('系统报的错怎么算:明确「没有」(ENOENT / ENOTDIR)才算没有;没权限、说不清的错一律按「有」算', async () => {
  const realSync = fs.lstatSync, realAsync = fs.promises.lstat;
  const mk = (code) => { const e = new Error(code); e.code = code; return e; };
  const run = async (code) => {
    fs.lstatSync = () => { throw mk(code); };
    fs.promises.lstat = async () => { throw mk(code); };
    try {
      return [cli.findClaude({ env: { Path: 'C:\\x' }, home: HOME, platform: 'win32' }).found,
        (await cli.findClaudeAsync({ env: { Path: 'C:\\x' }, home: HOME, platform: 'win32' })).found];
    } finally { fs.lstatSync = realSync; fs.promises.lstat = realAsync; }
  };
  for (const code of ['ENOENT', 'ENOTDIR']) assert.deepEqual(await run(code), [false, false], code);
  for (const code of ['EPERM', 'EACCES', 'UNKNOWN', 'EBUSY', 'ENAMETOOLONG', 'EIO', undefined]) assert.deepEqual(await run(code), [true, true], String(code));
});

test('自动化接口用哪个 claude:老规矩不变,只给「只装了官方版」的电脑多一条兜底', async () => {
  const A = 'C:\\Users\\demo\\AppData\\Roaming';
  const npm = A + '\\npm\\claude.cmd';
  const exe = LB + '\\claude.exe';
  const f = (env, files) => { const ex = has(...files); return cli.agentClaudeCmd({ env, home: HOME, exists: async (p) => ex(p), platform: 'win32' }); };
  assert.equal(await f({ APPDATA: A, Path: 'C:\\x' }, [npm, exe, 'C:\\x\\claude.cmd']), npm, 'npm 那个在就用它');
  assert.equal(await f({ APPDATA: A, Path: 'C:\\x' }, [exe, 'C:\\x\\claude.cmd']), 'claude.cmd', 'PATH 里有 claude.cmd(比如代理包装)就必须还是它,不许被官方 exe 抢走');
  assert.equal(await f({ APPDATA: A, Path: 'C:\\w;C:\\x' }, [exe, 'C:\\x\\claude.cmd']), 'claude.cmd', 'PATH 靠后的目录也要看到');
  assert.equal(await f({ APPDATA: A, Path: 'C:\\x' }, [exe]), exe, '哪儿都没有 claude.cmd、只有官方 exe 时才用 exe');
  assert.equal(await f({ APPDATA: A, Path: 'C:\\x' }, []), 'claude.cmd');
  assert.equal(await f({ Path: 'C:\\x' }, []), 'claude.cmd');
  assert.equal(await f({ Path: 'C:\\x' }, [exe]), exe);
});

test('自动化接口挑命令:查文件卡住或出岔子 → 限时内回到老行为 claude.cmd,绝不卡住启动', async () => {
  const A = 'C:\\Users\\demo\\AppData\\Roaming';
  const exe = LB + '\\claude.exe';
  // 第一个 PATH 目录是连不上的网络盘:卡住 → 到点回 'claude.cmd'(不许因为后面有官方 exe 就一直等)
  const t0 = Date.now();
  let asked = 0;
  const r = await cli.agentClaudeCmd({ env: { APPDATA: A, Path: '\\\\dead\\share;C:\\x' }, home: HOME, platform: 'win32', timeoutMs: 80,
    exists: (p) => { asked++; return p.startsWith('\\\\dead') ? new Promise(() => {}) : Promise.resolve(p === exe); } });
  assert.equal(r, 'claude.cmd');
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(asked, 2, '问完 npm 那个、卡在网络盘上,就不该再往下');
  // 出岔子:回老行为,不抛
  assert.equal(await cli.agentClaudeCmd({ env: { APPDATA: A, Path: 'C:\\x' }, home: HOME, platform: 'win32', exists: async () => { throw new Error('x'); } }), 'claude.cmd');
  assert.equal(await cli.agentClaudeCmd({ env: null, home: null, platform: 'win32' }), 'claude.cmd');
  // 返回的是 Promise(同步版会在启动时卡住主进程)
  assert.ok(cli.agentClaudeCmd({ env: { Path: '' }, home: HOME, exists: async () => false }) instanceof Promise);
});

test('补 PATH 只看本机用户目录那一个文件,不扫 PATH(它在开终端的路上,不能被网络盘拖住)', () => {
  const asked = [];
  cli.withClaudeOnPath({ Path: '\\\\dead\\share;C:\\a;C:\\b' }, { home: HOME, exists: (p) => { asked.push(p); return false; }, platform: 'win32' });
  assert.deepEqual(asked, [LB + '\\claude.exe']);
});

test('补 PATH:官方目录有 claude 而 PATH 里没有 → 追加到**末尾**,原来的顺序一个不动', () => {
  const env = { Path: 'C:\\Windows;C:\\npm', OTHER: '1' };
  const out = cli.withClaudeOnPath(env, { home: HOME, exists: has(LB + '\\claude.exe'), platform: 'win32' });
  assert.equal(out.Path, 'C:\\Windows;C:\\npm;' + LB);
  assert.equal(out.OTHER, '1');
  assert.equal(env.Path, 'C:\\Windows;C:\\npm', '不许改传进来的那个对象');
  assert.ok(!('PATH' in out), '不许另造一个大写的 PATH —— Windows 上两个键并存,子进程用哪个说不准');
  // 追加之后,PATH 里原来就有的那个 claude 仍然先被找到
  const r = cli.findClaude({ env: out, home: HOME, exists: has('C:\\npm\\claude.cmd', LB + '\\claude.exe'), platform: 'win32' });
  assert.equal(r.path, 'C:\\npm\\claude.cmd');
});

test('补 PATH:补完之后,原来找不到的现在按 PATH 就能找到', () => {
  const files = [LB + '\\claude.exe'];
  const before = cli.findClaude(W({ Path: 'C:\\Windows' }, files));
  assert.equal(before.via, 'localbin');
  const out = cli.withClaudeOnPath({ Path: 'C:\\Windows' }, { home: HOME, exists: has(...files), platform: 'win32' });
  assert.equal(cli.findClaude(W(out, files)).via, 'path');
});

test('补 PATH:已经在里面(大小写 / 结尾斜杠不同也算)就不重复加;官方目录里没有 claude 就不加', () => {
  for (const p of [LB, LB.toUpperCase(), LB + '\\', 'C:/Users/demo/.local/bin'.replace(/\//g, '\\')]) {
    const out = cli.withClaudeOnPath({ Path: 'C:\\Windows;' + p }, { home: HOME, exists: has(LB + '\\claude.exe'), platform: 'win32' });
    assert.equal(out.Path, 'C:\\Windows;' + p, p);
  }
  const out2 = cli.withClaudeOnPath({ Path: 'C:\\Windows' }, { home: HOME, exists: has(), platform: 'win32' });
  assert.equal(out2.Path, 'C:\\Windows');
});

test('补 PATH:PATH 结尾带分号、PATH 是空的、压根没有 PATH,都拼得对', () => {
  const o = { home: HOME, exists: has(LB + '\\claude.exe'), platform: 'win32' };
  assert.equal(cli.withClaudeOnPath({ Path: 'C:\\Windows;' }, o).Path, 'C:\\Windows;' + LB);
  assert.equal(cli.withClaudeOnPath({ Path: '' }, o).Path, LB);
  assert.equal(cli.withClaudeOnPath({}, o).PATH, LB);
});

test('补 PATH:查文件抛错时原样返回,不抛', () => {
  const out = cli.withClaudeOnPath({ Path: 'C:\\Windows' }, { home: HOME, exists: () => { throw new Error('EPERM'); }, platform: 'win32' });
  assert.deepEqual(out, { Path: 'C:\\Windows' });
});

test('一键安装的命令:用的是官方那一句,装完用完整路径启动;非 Windows 不提供', () => {
  assert.equal(cli.INSTALL_PS, 'irm https://claude.ai/install.ps1 | iex');
  const c = cli.installCommand('win32');
  const parts = c.split('; ');
  // 官方那一句原样放进**单独的 powershell 进程**:官方脚本失败时是 exit 1,同一个进程里跑的话后面的中文说明轮不到
  assert.equal(parts[1], "powershell.exe -NoProfile -ExecutionPolicy Bypass -Command '" + cli.INSTALL_PS + "'");
  assert.equal(c.split(cli.INSTALL_PS).length, 2, '官方命令只出现一次');
  assert.match(c, /downloads\.claude\.ai/, '没装上的提示要点出真正下载用的那个地址');
  assert.ok(c.includes("Join-Path $env:USERPROFILE '.local\\bin\\claude.exe'"));
  assert.match(c, /if \(Test-Path \$c\) \{[^}]*& \$c \}/, '装上了才启动,而且用完整路径(不依赖 PATH)');
  assert.match(c, /else \{[^}]*没装上/, '没装上要说人话');
  assert.ok(!/https?:\/\/(?!claude\.ai\/install\.ps1)/.test(c), '命令里只许出现官方安装地址');
  assert.equal(cli.installCommand('darwin'), '');
  assert.equal(cli.installCommand('linux'), '');
  assert.match(cli.INSTALL_DOC, /^https:\/\/code\.claude\.com\//);
});

test('非 Windows:只认叫 claude 的文件,也看 ~/.local/bin', () => {
  const ex = has('/usr/local/bin/claude');
  assert.equal(cli.findClaude({ env: { PATH: '/usr/bin:/usr/local/bin' }, home: '/home/u', exists: ex, platform: 'linux' }).path, '/usr/local/bin/claude');
  assert.equal(cli.findClaude({ env: { PATH: '/usr/bin' }, home: '/home/u', exists: has('/home/u/.local/bin/claude'), platform: 'linux' }).via, 'localbin');
  assert.equal(cli.findClaude({ env: { PATH: '/usr/bin' }, home: '/home/u', exists: has('/usr/bin/claude.exe'), platform: 'linux' }).found, false);
});

// ---------- 接线 ----------
test('接线:终端和版本检查都用补过 PATH 的环境;检测出错一律当成装了;界面的闸门能跳过', () => {
  const root = path.join(__dirname, '..');
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const pre = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(main, /pty\.spawn\('powershell\.exe',[^\n]*\n[^\n]*env: claudeCli\.withClaudeOnPath\(px\.env\)/, '内嵌终端要用补过 PATH 的环境');
  assert.match(main, /exec\('claude --version', \{ timeout: 20000, env: claudeCli\.withClaudeOnPath\(process\.env\) \}/, '版本检查也要用补过 PATH 的环境');
  const h = main.split(/\r?\n/).find(l => l.includes("ipcMain.handle('claude:check'"));
  assert.ok(h, 'main.js 缺 claude:check');
  assert.ok(/try\s*\{/.test(h) && /catch\s*\{\s*return \{ found: true, unsure: true \}/.test(h), '检测出错要当成装了(放行),而且标成没查明白');
  assert.ok(pre.includes("claudeCheck: () => ipcRenderer.invoke('claude:check')"));
  // 界面:查不出来 / 没有这个接口 / 接口抛错,都放行
  const a = html.indexOf('async function claudeReady(');
  const b = html.indexOf('\n}', a);
  assert.ok(a > 0 && b > a);
  const fn = html.slice(a, b);
  assert.ok(fn.includes('if (claudeOk || !hub.claudeCheck) return true;'));
  assert.ok(/catch\s*\{\s*return true;\s*\}/.test(fn), '接口抛错要放行');
  assert.ok(fn.includes('c.found !== false'), '只有明确说没找到才拦');
  assert.ok(html.includes('if (!skipCheck && needsClaude(cmdOverride) && !(await claudeReady('), '开会话前要过这道闸;一键安装自己要能跳过;不跑 claude 的不拦');
  // needsClaude:从页面里截真源码来跑
  const m = /^const needsClaude = (.*);\s*(?:\/\/.*)?$/m.exec(html);
  assert.ok(m, 'index.html 里找不到 needsClaude');
  const needsClaude = eval(m[1]);
  for (const c of [undefined, '', 'claude', 'claude --worktree', 'claude --permission-mode plan', 'claude update; claude --version', 'claude --resume "x"']) assert.equal(needsClaude(c), true, String(c));
  for (const c of ['codex', 'gemini', 'claudex', 'claude-foo', 'npm run dev', 'npx claude', ' claude', 'echo claude', 'codex; claude', cli.installCommand('win32')]) assert.equal(needsClaude(c), false, String(c));
  // 这一轮验收补的几处
  assert.match(h, /async \(\) => \{ try \{ return await claudeCli\.checkForUi\(\); \}/, '检测要走异步限时的那个,不许在主进程里同步查');
  assert.ok(main.includes('claudeCmd: await claudeCli.agentClaudeCmd(),'), '自动化接口的 claude 命令(异步的,要 await)');
  assert.ok(!/claudeCli\.findClaude\(/.test(main), '主进程里不许出现同步扫 PATH 的调用(会卡住窗口)');
  // 已经开着的会话直接切过去,这一步必须在闸前面(不然装了又卸的电脑连切标签都被拦)
  const ot = html.slice(html.indexOf('async function openTerm('));
  assert.ok(ot.indexOf('if (ex) { activateTerm(ex.id); return; }') < ot.indexOf('!(await claudeReady('), '切到已开的标签要排在闸前面');
  assert.ok(/if \(t\) \{ (t\.exited = true; )?t\.clInstall = false; t\.term\.write\(/.test(html), '安装进程结束后要摘掉「正在安装」的标记');
  assert.ok(html.includes('if (cmdOverride && clInfo && cmdOverride === clInfo.installCmd) {'), '内嵌终端起不来时,一键安装不许落到外部终端去跑裸 claude');
  assert.ok(main.includes("exec('claude --no-session-persistence -p \"/usage\"', { timeout: 90000, env: claudeCli.withClaudeOnPath(px.env),"), '额度查询也要补 PATH');
  assert.ok(main.includes("{ detached: true, stdio: 'ignore', env: claudeCli.withClaudeOnPath(px.env) }"), '外部终端兜底也要补 PATH');
  assert.ok(html.includes("await openTerm(t.projPath, t.projShort, t.sid || '', t.title || t.projShort, '', true); n++;"), '恢复上次的标签不许过这道闸(判错会把标签列表清空)');
  assert.ok(html.includes('onclick="dismissClaudeMissing()" id="clclose"'));
  assert.ok(html.includes("if (document.getElementById('clbox').classList.contains('open')) { dismissClaudeMissing(); return; }"), 'Esc 要能关掉这张卡');
});

// ---------- 界面那道闸的行为:从 index.html 里截真源码(<claude-gate> 两个标记之间)来跑 ----------
function loadGate(over = {}) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const a = html.indexOf('// <claude-gate>'), b = html.indexOf('// </claude-gate>');
  assert.ok(a > 0 && b > a, 'index.html 里找不到 <claude-gate> 标记');
  const els = {};
  const el = (id) => els[id] || (els[id] = { innerHTML: '', textContent: '', _open: false,
    classList: { add() { els[id]._open = true; }, remove() { els[id]._open = false; }, contains() { return els[id]._open; } } });
  const env = Object.assign({
    check: async () => ({ found: false, installCmd: 'INSTALL', doc: 'DOC' }),
    opened: [], termTabs: [], activated: [], external: [], checks: 0,
  }, over);
  const hub = { claudeCheck: () => { env.checks++; return env.check(); }, openExternal: (u) => env.external.push(u) };
  if (over.noApi) delete hub.claudeCheck;
  const openTerm = async (...args) => { env.opened.push(args); if (env.onOpen) env.onOpen(args); };
  const activateTerm = (id) => env.activated.push(id);
  const api = new Function('hub', 'document', 'openTerm', 'termTabs', 'activateTerm',
    html.slice(a, b) + '\nreturn { claudeReady, claudeRecheck, claudeInstall, claudeForceOpen, dismissClaudeMissing, state: () => ({ ok: claudeOk, queued: clQueue.length }) };'
  )(hub, { getElementById: el }, openTerm, env.termTabs, activateTerm);
  return Object.assign(api, { env, els, isOpen: () => el('clbox')._open });
}
const ARGS = (n) => ({ projPath: 'C:\\p' + n, projShort: 'P' + n, sid: 's' + n, title: 'T' + n, cmdOverride: '' });

test('闸:找得到 → 放行,而且之后不再问', async () => {
  const g = loadGate({ check: async () => ({ found: true }) });
  assert.equal(await g.claudeReady(ARGS(1)), true);
  assert.equal(await g.claudeReady(ARGS(2)), true);
  assert.equal(g.env.checks, 1);
  assert.equal(g.isOpen(), false);
});

test('闸:接口抛错 / 没有这个接口 / 回答看不懂 → 一律放行', async () => {
  const g1 = loadGate({ check: async () => { throw new Error('boom'); } });
  assert.equal(await g1.claudeReady(ARGS(1)), true);
  assert.equal(g1.isOpen(), false);
  const g2 = loadGate({ noApi: true });
  assert.equal(await g2.claudeReady(ARGS(1)), true);
  for (const weird of [null, undefined, {}, { found: 0 }, { found: 'no' }, 'x']) {
    const g = loadGate({ check: async () => weird });
    assert.equal(await g.claudeReady(ARGS(1)), true, JSON.stringify(weird));
  }
});

test('闸:明确没装 → 拦下并出卡片;卡片上有一键安装、重新检测、直接打开', async () => {
  const g = loadGate();
  assert.equal(await g.claudeReady(ARGS(1)), false);
  assert.equal(g.isOpen(), true);
  assert.equal(g.env.opened.length, 0);
  const html = g.els.clBody.innerHTML;
  assert.ok(html.includes('claudeInstall()') && html.includes('一键安装'));
  assert.ok(html.includes('claudeRecheck()'));
  assert.ok(html.includes('claudeForceOpen()') && html.includes('直接打开'), '必须留一个不靠检测的出口');
});

test('闸:「直接打开」→ 被拦下的每一次都开出来(带原参数、跳过检测),以后不再问', async () => {
  const g = loadGate();
  await g.claudeReady(ARGS(1)); await g.claudeReady(ARGS(2)); await g.claudeReady(ARGS(3));
  g.claudeForceOpen();
  assert.equal(g.isOpen(), false);
  assert.deepEqual(g.env.opened, [1, 2, 3].map(n => ['C:\\p' + n, 'P' + n, 's' + n, 'T' + n, '', true]));
  const n = g.env.checks;
  assert.equal(await g.claudeReady(ARGS(4)), true);
  assert.equal(g.env.checks, n, '用户说装了就信他,不再检测');
});

test('闸:「重新检测」—— 还没有就留在卡片上并说明;有了就把拦下的都开出来;查不出来也放行', async () => {
  let found = false;
  const g = loadGate({ check: async () => found ? { found: true } : { found: false, installCmd: 'INSTALL', doc: 'DOC' } });
  await g.claudeReady(ARGS(1)); await g.claudeReady(ARGS(2));
  await g.claudeRecheck();
  assert.equal(g.isOpen(), true);
  assert.equal(g.env.opened.length, 0);
  assert.match(g.els.clErr.textContent, /还是没找到/);
  assert.match(g.els.clErr.textContent, /直接打开/, '要告诉用户还有别的路');
  found = true;
  await g.claudeRecheck();
  assert.equal(g.isOpen(), false);
  assert.deepEqual(g.env.opened.map(a => a[2]), ['s1', 's2']);
  assert.ok(g.env.opened.every(a => a[5] === true));
  assert.equal(g.state().queued, 0);

  const g2 = loadGate();
  await g2.claudeReady(ARGS(1));
  g2.env.check = async () => { throw new Error('boom'); };
  await g2.claudeRecheck();
  assert.equal(g2.isOpen(), false);
  assert.equal(g2.env.opened.length, 1);
});

test('闸:关掉卡片(X / Esc)= 这几次不开了;之后放行不会把攒下的旧会话一起开出来', async () => {
  const g = loadGate();
  await g.claudeReady(ARGS(1)); await g.claudeReady(ARGS(1));
  g.dismissClaudeMissing();
  assert.equal(g.isOpen(), false);
  assert.equal(g.state().queued, 0);
  await g.claudeReady(ARGS(2));
  g.claudeForceOpen();
  assert.deepEqual(g.env.opened.map(a => a[2]), ['s2']);
});

test('闸:「一键安装」—— 用安装命令开一个新标签(跳过检测、不带旧会话号);已经在装就切过去,不开第二个', async () => {
  const g = loadGate();
  g.env.onOpen = () => g.env.termTabs.push({ id: 't' + g.env.termTabs.length });
  g.env.termTabs.push({ id: 'old' });
  await g.claudeReady(ARGS(1)); await g.claudeReady(ARGS(2));
  await g.claudeInstall();
  assert.equal(g.isOpen(), false);
  assert.deepEqual(g.env.opened, [['C:\\p1', 'P1', '', '安装 Claude Code', 'INSTALL', true]]);
  assert.equal(g.state().queued, 0, '装完安装标签里会直接启动 claude,被拦下的不用再开');
  assert.equal(g.env.termTabs.find(t => t.clInstall).id, 't1', '要标在新开的那个标签上');
  assert.ok(!g.env.termTabs[0].clInstall);
  // 安装还在跑时又点了新会话 → 卡片上的按钮变成「去看看」,点了只是切过去
  await g.claudeReady(ARGS(3));
  assert.ok(g.els.clBody.innerHTML.includes('正在安装,去看看'));
  await g.claudeInstall();
  assert.equal(g.env.opened.length, 1, '不许并发跑第二个安装器');
  assert.deepEqual(g.env.activated, ['t1']);
  // 安装标签关掉以后,又可以重新装
  g.env.termTabs.splice(1, 1);
  await g.claudeReady(ARGS(4));
  assert.ok(g.els.clBody.innerHTML.includes('>一键安装<'));
});

test('闸:没查明白才放行的(超时 / 出岔子)—— 这次放行,但不记死,下次还查', async () => {
  let ans = { found: true, unsure: true };
  const g = loadGate({ check: async () => ans });
  assert.equal(await g.claudeReady(ARGS(1)), true);
  assert.equal(g.state().ok, false);
  assert.equal(await g.claudeReady(ARGS(2)), true);
  assert.equal(g.env.checks, 2);
  ans = { found: false, installCmd: 'INSTALL', doc: 'DOC' };      // 后来查明白了:确实没装
  assert.equal(await g.claudeReady(ARGS(3)), false);
  assert.equal(g.isOpen(), true);
});

test('闸:同一次开会话被拦多回只留一份;不同的各留一份;最多攒 20 个', async () => {
  const g = loadGate();
  await g.claudeReady(ARGS(1)); await g.claudeReady(ARGS(1)); await g.claudeReady(ARGS(1));
  await g.claudeReady(Object.assign(ARGS(1), { cmdOverride: 'claude --worktree' }));
  assert.equal(g.state().queued, 2);
  for (let i = 2; i <= 40; i++) await g.claudeReady(ARGS(i));
  assert.equal(g.state().queued, 20);
  g.claudeForceOpen();
  assert.equal(g.env.opened.length, 20);
  assert.deepEqual(g.env.opened[1], ['C:\\p1', 'P1', 's1', 'T1', 'claude --worktree', true], '接着开的时候命令不能丢');
});

test('闸:「重新检测」找到了要记住;等结果时卡片已经被关掉的话,不许再把它弹回来', async () => {
  let found = false;
  const g = loadGate({ check: async () => found ? { found: true } : { found: false, installCmd: 'INSTALL', doc: 'DOC' } });
  await g.claudeReady(ARGS(1));
  found = true;
  await g.claudeRecheck();
  const n = g.env.checks;
  assert.equal(await g.claudeReady(ARGS(2)), true);
  assert.equal(g.env.checks, n, '重新检测通过后不该再问');

  let release;
  const gate = new Promise((r) => { release = r; });
  const g2 = loadGate();
  await g2.claudeReady(ARGS(1));
  g2.env.check = () => gate.then(() => ({ found: false, installCmd: 'INSTALL', doc: 'DOC' }));
  const p = g2.claudeRecheck();
  g2.dismissClaudeMissing();
  release(); await p;
  assert.equal(g2.isOpen(), false, '用户已经关掉了,迟到的「还是没找到」不许把卡片弹回来');
});

test('闸:「一键安装」时安装标签没开出来(内嵌终端起不来)→ 被拦下的留着,不当成已经在装', async () => {
  const g = loadGate();          // 假的 openTerm 不往 termTabs 里加东西 = 没开出标签
  await g.claudeReady(ARGS(1)); await g.claudeReady(ARGS(2));
  await g.claudeInstall();
  assert.equal(g.env.opened.length, 1);
  assert.equal(g.state().queued, 2, '没开出安装标签就不能把被拦下的丢掉');
  assert.ok(!g.env.termTabs.some(t => t.clInstall));
});

test('闸:已有安装在跑时点「去看看」→ 切过去,并且把攒下的清掉(不然之后会一次开出一堆)', async () => {
  const g = loadGate();
  g.env.termTabs.push({ id: 'inst', clInstall: true });
  await g.claudeReady(ARGS(1)); await g.claudeReady(ARGS(2));
  await g.claudeInstall();
  assert.deepEqual(g.env.activated, ['inst']);
  assert.equal(g.env.opened.length, 0);
  assert.equal(g.state().queued, 0);
});

test('闸:没有安装命令(非 Windows)→ 卡片上不出「一键安装」,别的出口都在', async () => {
  const g = loadGate({ check: async () => ({ found: false, installCmd: '', doc: 'DOC' }) });
  await g.claudeReady(ARGS(1));
  const html = g.els.clBody.innerHTML;
  assert.ok(!html.includes('claudeInstall()'));
  assert.ok(html.includes('claudeRecheck()') && html.includes('claudeForceOpen()'));
  await g.claudeInstall();
  assert.equal(g.env.opened.length, 0);
});

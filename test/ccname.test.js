// 总控里起的会话名同步成 Claude Code 自己的会话名(2026-11-19,lib/ccname.js + main.js ccAutoSync + index.html <cc-input-empty>)。
// 别的会话互相找、@ 对方用的是 Claude Code 那套名字;总控改名以前只在「改名那一刻终端开着」时才同步。
// 复核(子代理)查出来、这里都有用例守着的:中文弯引号注入、改不过来无限重试、旧登记 / 认错标签往别的程序里打字、
// 「最后一下是回车」不等于输入框是空的、覆盖人在 Claude 里亲手起的名、老版本不认 --name。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const cc = require('../lib/ccname');

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const SID = '4c489632-219f-4e4c-b403-282e8d609d28';

test('wantName:去控制字符 / 换行,双引号和中文弯引号都换成 ASCII 单引号,空白收成一个,限长', () => {
  assert.equal(cc.wantName('  虚拟人 '), '虚拟人');
  assert.equal(cc.wantName('a\nb\r\tc'), 'a b c');
  assert.equal(cc.wantName('说"你好"'), "说'你好'");
  assert.equal(cc.wantName('三月的‘测试’'), "三月的'测试'");
  assert.equal(cc.wantName('“引号”‚‛'), "'引号'''");
  assert.equal(cc.wantName(null), '');
  assert.equal(cc.wantName('x'.repeat(200)).length, 80);
});

test('nameArg:PowerShell 单引号字符串,所有单引号(含弯引号)都写两遍,截不断也注入不了', () => {
  assert.equal(cc.nameArg('TMS'), " --name 'TMS'");
  assert.equal(cc.nameArg("三月's 项目"), " --name '三月''s 项目'");
  assert.equal(cc.nameArg('三月的‘测试’'), " --name '三月的''测试'''");
  assert.equal(cc.nameArg('a‘;Write-Output INJECTED;‘'), " --name 'a'';Write-Output INJECTED;'''");
  // 引号里面不能再有任何会被 PowerShell 当成单引号的字符落单
  for (const t of ['a‘b', 'a’b', 'a‚b', 'a‛b', "a'b", 'a"b']) {
    const inner = cc.nameArg(t).slice(" --name '".length, -1);
    assert.doesNotMatch(inner.replace(/''/g, ''), /['\u2018-\u201b]/, t);
  }
  assert.equal(cc.nameArg('  '), '');
});

test('withName:本机认 --name 才加;只给默认的 claude --resume "会话号" 补;自定义命令不动', () => {
  assert.equal(cc.withName(`claude --resume "${SID}"`, '虚拟人', true), `claude --resume "${SID}" --name '虚拟人'`);
  assert.equal(cc.withName(`claude --resume "${SID}"`, '虚拟人', false), `claude --resume "${SID}"`, '老版本 / 还没问出来:不加,免得起不来');
  assert.equal(cc.withName(`claude --resume "${SID}"`, '虚拟人'), `claude --resume "${SID}"`);
  assert.equal(cc.withName(`claude --resume "${SID}"`, '', true), `claude --resume "${SID}"`);
  for (const c of ['claude', 'claude --worktree', 'claude --permission-mode plan', `claude --resume "${SID}" --fork-session`, 'claude update; claude --version'])
    assert.equal(cc.withName(c, '虚拟人', true), c);
});

const NOW = 1e7;
const base = (o = {}) => Object.assign({
  metas: [{ id: 't1', sid: SID, claude: true }],
  titles: { [SID]: '虚拟人' },
  cc: { [SID]: { name: 'claude-31', nameSource: 'derived', status: 'idle', pid: 4242, startedAt: NOW - 3600e3 } },
  inputs: {}, attempts: {}, now: NOW,
}, o);
const ccWith = (o) => ({ [SID]: Object.assign({ name: 'claude-31', nameSource: 'derived', status: 'idle', pid: 4242, startedAt: NOW - 3600e3 }, o) });

test('pickSync:总控改过名、还是自动编号、空闲、没人打字 → 挑出来(带上登记的 pid 供核进程)', () => {
  assert.deepEqual(cc.pickSync(base()), [{ id: 't1', sid: SID, name: '虚拟人', pid: 4242 }]);
});

test('pickSync:这些情况都不挑', () => {
  const no = (o, why) => assert.deepEqual(cc.pickSync(base(o)), [], why);
  no({ titles: {} }, '总控没改过名:留默认编号');
  no({ cc: ccWith({ name: '虚拟人' }) }, '已经对上');
  no({ cc: {} }, 'Claude 还没起来');
  no({ cc: ccWith({ nameSource: 'user', name: '我在 Claude 里起的' }) }, '人在 Claude 里亲手起过名:不覆盖,不来回打架');
  no({ cc: ccWith({ status: 'busy' }) }, '忙');
  no({ cc: ccWith({ status: 'shell' }) }, '在跑命令');
  no({ cc: ccWith({ status: 'waiting' }) }, '弹着权限确认 / 菜单');
  no({ cc: ccWith({ status: '' }) }, '没有 status、而且不是刚启动的:老版本可能根本不写 status');
  no({ metas: [{ id: 't1', sid: '', claude: true }] }, '还没认出会话号');
  no({ metas: [{ id: 't1', sid: SID, claude: false }] }, 'codex / gemini 标签');
  no({ metas: [{ id: 't1', sid: SID, claude: true }, { id: 't2', sid: SID, claude: true }] }, '认重了:拿不准');
  no({ inputs: { t1: { at: NOW - 60000, enter: false } } }, '最后一下不是回车');
  no({ inputs: { t1: { at: NOW - 3000, enter: true } } }, '刚发完,等一会儿');
  no({ attempts: { [SID]: { name: '虚拟人', n: 1, at: NOW - 30000 } } }, '刚试过');
  no({ attempts: { [SID]: { name: '虚拟人', n: 2, at: NOW - 3600e3 } } }, '同一个名字试满两次还对不上:停,不再隔两分钟打一次');
});

test('pickSync:刚启动没 status 的、过了重试间隔的、换了新名字的 → 照样挑', () => {
  assert.equal(cc.pickSync(base({ cc: ccWith({ status: undefined, startedAt: NOW - 10000 }) })).length, 1, '刚起来一分钟以内、还没聊过');
  assert.equal(cc.pickSync(base({ attempts: { [SID]: { name: '虚拟人', n: 1, at: NOW - 200000 } } })).length, 1);
  assert.equal(cc.pickSync(base({ attempts: { [SID]: { name: '旧名字', n: 2, at: NOW - 1000 } } })).length, 1, '总控又改了个新名字:重新算次数');
  assert.equal(cc.pickSync(base({ inputs: { t1: { at: NOW - 20000, enter: true } } })).length, 1);
});

test('pickSync:总控刚改的名字(pending)哪怕 Claude 那边已经是 user 也要同步;别的 user 名照样不碰', () => {
  const u = ccWith({ nameSource: 'user', name: '上次自动改的名' });
  assert.equal(cc.pickSync(base({ cc: u, pending: { [SID]: '虚拟人' } })).length, 1, '标签上第二次改名');
  assert.equal(cc.pickSync(base({ cc: u, pending: { [SID]: '别的名字' } })).length, 0, 'pending 和总控名对不上:不当真');
  assert.equal(cc.pickSync(base({ cc: u })).length, 0);
  assert.equal(cc.pickSync(base({ cc: ccWith({ status: undefined }), pending: { [SID]: '虚拟人' } })).length, 1, '人刚改的名:没 status(没聊过的老会话)也放行,靠读画面兜底');
  assert.equal(cc.pickSync(base({ cc: ccWith({ status: undefined }) })).length, 0, '纯自动的不放行');
  assert.equal(cc.pickSync(base({ cc: Object.assign(u, { [SID]: Object.assign({}, u[SID], { status: 'busy' }) }), pending: { [SID]: '虚拟人' } })).length, 0, 'pending 也要过空闲这一关');
});

test('inputQuiet:从没输入过、或者最后一下是回车且过了 15 秒才算安静', () => {
  assert.equal(cc.inputQuiet(undefined, NOW), true);
  assert.equal(cc.inputQuiet({ at: NOW - 20000, enter: true }, NOW), true);
  assert.equal(cc.inputQuiet({ at: NOW - 2000, enter: true }, NOW), false);
  assert.equal(cc.inputQuiet({ at: NOW - 600000, enter: false }, NOW), false);
});

test('isDescendant:登记的 Claude 进程要还活着,而且顺着父进程能走到这个终端的 powershell', () => {
  const parents = { 100: 1, 200: 100, 300: 200, 400: 300, 999: 50 };   // powershell 100 → cmd 200 → node 300 → claude 400
  assert.equal(cc.isDescendant(400, 100, parents), true);
  assert.equal(cc.isDescendant(200, 100, parents), true);
  assert.equal(cc.isDescendant(999, 100, parents), false, '别的终端里的');
  assert.equal(cc.isDescendant(555, 100, parents), false, '进程已经没了(旧登记)');
  assert.equal(cc.isDescendant(0, 100, parents), false);
  assert.equal(cc.isDescendant(400, 0, parents), false);
  assert.equal(cc.isDescendant(400, 100, {}), false, '进程表没查出来:不认');
  const loop = { 1: 2, 2: 1 };
  assert.equal(cc.isDescendant(1, 100, loop), false, '父子成环也不会死循环');
});

test('isAutoReply:终端自己回的话不算人打字;真按键算', () => {
  for (const s of ['\x1b[?1;2c', '\x1b[>0;276;0c', '\x1b[12;40R', '\x1b[0n', '\x1b[I', '\x1b[O', '\x1b[?2004;1$y',
    '\x1b]11;rgb:1717/1b1b/2020\x07', '\x1b]10;rgb:e8e8/eded/f2f2\x1b\\', '\x1bP>|xterm.js(6.0.0)\x1b\\', '\x1b[<0;10;5M', '\x1b[<0;10;5m',
    '\x1b[?1;2c\x1b[12;40R'])
    assert.equal(cc.isAutoReply(s), true, JSON.stringify(s));
  for (const s of ['a', '你好', '\r', '\x1b[A', '\x1b[B', '\x1b[1;5C', '\x1b[3~', '\x1bOA', '\x1b[H', '\x03', '\x1b', 'abc\x1b[I', ''])
    assert.equal(cc.isAutoReply(s), false, JSON.stringify(s));
});

test('matchUnbound:新标签没有会话号时,按目录 + 启动时间唯一对上 Claude Code 登记;有歧义 / 不是 Claude 标签不认', () => {
  const T = 1e6;
  const reg = {
    a: { name: 'claude-project-fa', cwd: 'F:\\claude-project', startedAt: T + 3000 },
    old: { name: 'claude-31', cwd: 'F:\\claude-project', startedAt: T - 3600e3 },
    other: { name: 'comfyui-ca', cwd: 'F:\\claude-project\\本地comfyui', startedAt: T + 3000 },
    bound: { name: '虚拟人', cwd: 'F:\\claude-project', startedAt: T + 4000 },
  };
  const metas = [{ id: 't1', sid: '', projPath: 'f:\\Claude-Project\\', spawnAt: T }, { id: 't9', sid: 'bound', projPath: 'F:\\claude-project', spawnAt: T }];
  assert.deepEqual(cc.matchUnbound(metas, reg), { t1: { sid: 'a', name: 'claude-project-fa' } });
  const reg2 = { a: reg.a, b: { name: 'claude-project-b9', cwd: 'F:\\claude-project', startedAt: T + 5000 } };
  const m2 = [{ id: 't1', sid: '', projPath: 'F:\\claude-project', spawnAt: T }, { id: 't2', sid: '', projPath: 'F:\\claude-project', spawnAt: T + 1000 }];
  assert.deepEqual(cc.matchUnbound(m2, reg2), {}, '同一目录差不多同时开了两个');
  assert.deepEqual(cc.matchUnbound([{ id: 't1', sid: '', projPath: 'F:\\claude-project', spawnAt: T - 70000 }], { a: reg.a }), {});
  assert.deepEqual(cc.matchUnbound([{ id: 't1', sid: '', projPath: 'F:\\claude-project' }], { a: reg.a }), {});
  assert.deepEqual(cc.matchUnbound([{ id: 't1', sid: '', projPath: 'F:\\claude-project', spawnAt: T, claude: false }], { a: reg.a }), {}, 'codex 标签');
});

test('endsWithEnter', () => {
  assert.equal(cc.endsWithEnter('hello\r'), true);
  assert.equal(cc.endsWithEnter('hello'), false);
  assert.equal(cc.endsWithEnter('\x1b[A'), false);
  assert.equal(cc.endsWithEnter(''), false);
});

// ---------- 界面:读画面判断输入框空不空 ----------
function cutBlock(a, b) { const i = HTML.indexOf(a), j = HTML.indexOf(b); assert.ok(i >= 0 && j > i, a); return HTML.slice(i, j); }
const { ccInputEmpty, ccInputState } = new Function(cutBlock('// <cc-input-empty>', '// </cc-input-empty>') + '\nreturn { ccInputEmpty, ccInputState };')();
// rows:每行一个字符串;dim 的部分用 {d:'文字'} 标。照摸底实测(2.1.327)的样子造
function fakeTerm(rows, { type = 'normal', cols = 60 } = {}) {
  const lines = rows.map(r => {
    const cells = [];
    for (const part of [].concat(r)) {
      const dim = typeof part === 'object';
      for (const ch of Array.from(dim ? part.d : part)) cells.push({ ch, dim });
    }
    return cells;
  });
  return { cols, buffer: { active: { type, length: lines.length, getLine: (y) => lines[y] && {
    translateToString: () => lines[y].map(c => c.ch).join(''),
    getCell: (x) => { const c = lines[y][x]; return c ? { getChars: () => c.ch, isDim: () => (c.dim ? 1 : 0) } : { getChars: () => '', isDim: () => 0 }; },
  } } } };
}
const RULE = '─'.repeat(50);
const TAIL = ['  ⬆ /gsd-update │ Opus 5.5 │ claude-project', '  ⏵⏵ auto mode on (shift+tab to cycle)'];

test('输入框:空的(只有 ❯ 和暗色占位提示)才算空', () => {
  assert.equal(ccInputEmpty(fakeTerm(['输出…', '', RULE, ['❯\u00a0', { d: 'Try "how does <filepath> work?"' }], RULE, ...TAIL])), true);
  assert.equal(ccInputEmpty(fakeTerm([RULE, '❯\u00a0', RULE, ...TAIL])), true, '没有占位提示也算空');
  assert.equal(ccInputEmpty(fakeTerm([RULE, '❯\u00a0', '─'.repeat(30) + ' 总控同步测试 ──', ...TAIL])), true, '起了名以后横线上带名字(实测)');
  assert.equal(ccInputEmpty(fakeTerm(['── 虚拟人 ' + '─'.repeat(30), '❯\u00a0', RULE, ...TAIL])), true);
});

test('输入框:聊过的会话开头是 > 不是 ❯(2026-11-21 三月实测),也认;三种状态分清', () => {
  assert.equal(ccInputState(fakeTerm(['输出…', '─'.repeat(40) + ' 总控 ─', '>\u00a0', RULE, ...TAIL])), 'empty');
  assert.equal(ccInputState(fakeTerm([RULE, '> 还没发的草稿', RULE, ...TAIL])), 'text');
  assert.equal(ccInputState(fakeTerm([RULE, '  1. Yes', '  2. No', RULE])), 'unknown', '菜单 / 确认框');
  assert.equal(ccInputState(fakeTerm(['PS F:\\claude-project> ', ...TAIL])), 'unknown', '回到了 PowerShell');
  assert.equal(ccInputState({}), 'unknown');
  assert.equal(ccInputEmpty(fakeTerm([RULE, '>\u00a0', RULE, ...TAIL])), true);
});

test('输入框:有字(哪怕光标在开头)、多行草稿、认不出结构、全屏模式 —— 都算不空', () => {
  assert.equal(ccInputEmpty(fakeTerm([RULE, '❯\u00a0hello 草稿', RULE, ...TAIL])), false);
  assert.equal(ccInputEmpty(fakeTerm([RULE, ['❯\u00a0', { d: 'Try' }], '  第二行草稿', RULE, ...TAIL])), false, '多行草稿');
  assert.equal(ccInputEmpty(fakeTerm([RULE, ['❯\u00a0', 'x', { d: 'Try' }], RULE, ...TAIL])), false);
  assert.equal(ccInputEmpty(fakeTerm([RULE, ['❯\u00a0', { d: '[Pasted text #1 +29 lines]' }], RULE, ...TAIL])), false, '粘贴折叠块哪怕是暗色也算不空');
  assert.equal(ccInputEmpty(fakeTerm([RULE, ['❯\u00a0', { d: '[Image #1]' }], RULE, ...TAIL])), false, '贴图块');
  assert.equal(ccInputEmpty(fakeTerm(['PS F:\\claude-project> ', ...TAIL])), false, 'Claude 已经退了,回到 PowerShell');
  assert.equal(ccInputEmpty(fakeTerm([RULE, '  1. Yes', '  2. No', RULE])), false, '没有 ❯ 开头(菜单 / 确认框)');
  assert.equal(ccInputEmpty(fakeTerm([RULE, '❯\u00a0', RULE], { type: 'alternate' })), false, '全屏模式');
  assert.equal(ccInputEmpty(fakeTerm([RULE, RULE, ...TAIL])), false, '两条横线挨着,中间没有输入行');
  assert.equal(ccInputEmpty({}), false, '拿到的不是终端也不抛');
});

test('接线:主进程核进程再交界面;界面读画面才打字;不发 Ctrl+U;--name 先问版本;外部终端不加;只认 Claude 标签', () => {
  assert.match(MAIN, /const cmd = ccname\.withName\(cmdOverride \? cmdOverride : \(sid \? `claude --resume "\$\{sid\}"` : 'claude'\), sid \? data\.loadTitles\(\)\[sid\] : '', ccNameSupported\);/);
  assert.match(MAIN, /\/\/ 外部终端\(wt\)不加 --name[^\n]*\r?\n  const cmd = sid \? `claude --resume "\$\{sid\}"` : 'claude';/);
  assert.match(MAIN, /let ccNameSupported = false, ccNameProbe = null;/);
  assert.match(MAIN, /'-ExecutionPolicy', 'Bypass', '-Command', 'claude --help'/, '问版本也要 Bypass,和开终端一致');
  assert.match(MAIN, /if \(sid && ccNameProbe\) await Promise\.race\(\[ccNameProbe, new Promise\(r => setTimeout\(r, 4000\)\)\]\);/, '恢复会话前最多等 4 秒问出来');
  assert.match(MAIN, /const ok = data\.setCustomTitle\(sid, title\);\r?\n    if \(ok\) ccWant\(sid, title\);/, '总控改名 = 记成待同步');
  assert.match(MAIN, /ccname\.isDescendant\(t\.pid, p\.pid, parents\) && ccname\.inputQuiet\(termInputs\.get\(t\.id\), now2\)/, '查完进程表再核一次输入');
  assert.match(MAIN, /ipcMain\.on\('cc:typed'/, '界面真打出去了才计数');
  assert.match(MAIN, /probeNameFlag\(\);\r?\n    setInterval\(ccAutoSync, 20e3\);/);
  const fn = MAIN.slice(MAIN.indexOf('async function ccAutoSync'), MAIN.indexOf('let ccNameSupported'));
  assert.match(fn, /ccname\.isDescendant\(t\.pid, p\.pid, parents\)/);
  assert.match(fn, /win\.webContents\.send\('cc:tryRename'/);
  assert.doesNotMatch(fn, /\.write\(/, '主进程自己不往终端里打字,交给界面看过画面再打');
  assert.match(MAIN, /function noteInput\(id, d\) \{\r?\n  if \(ccname\.isAutoReply\(d\)\) return;/);
  assert.match(MAIN, /ipcMain\.on\('term:input', \(e, id, data\) => \{ const p = terms\.get\(id\); if \(p\) \{ noteInput\(id, data\); p\.write\(data\); \} \}\);/);
  assert.match(MAIN, /write\(id, d\) \{ const p = terms\.get\(id\); if \(p\) \{ noteInput\(id, d\);/);
  assert.match(MAIN, /termMeta\.delete\(id\); termInputs\.delete\(id\);/);
  assert.match(MAIN, /const isClaude = \/\^claude\(\\s\|\$\)\/\.test\(cmd\) && !\/\^claude \(update\|install\)\\b\/\.test\(cmd\);/);
  const ui = HTML.slice(HTML.indexOf('hub.onCcTryRename('), HTML.indexOf('hub.onCcTryRename(') + 900);
  assert.match(ui, /if \(!t \|\| t\.sid !== it\.sid \|\| !ccInputEmpty\(t\.term\)\) continue;/);
  assert.match(ui, /if \(t\.composing \|\| Date\.now\(\) - \(t\.lastKeyAt \|\| 0\) < 3000\) continue;/, '刚按过键 / 输入法组字中不打');
  assert.match(ui, /ccSend\(t, '\/rename ' \+ it\.name\);[^\n]*\r?\n\s*if \(hub\.ccTyped\) hub\.ccTyped\(it\.sid, it\.name\);/);
  const sync = HTML.slice(HTML.indexOf('function syncCcName'), HTML.indexOf('async function refreshCcSess'));
  assert.doesNotMatch(sync, /termInput|\\x15/, '会话列表改名也不许直接 Ctrl+U + 打字,走同一道闸');
  assert.match(sync, /hub\.ccWant\(sid, name\)/);
  assert.doesNotMatch(ui, /\\x15/, '自动改名不许发 Ctrl+U');
  assert.match(HTML, /!before\.has\(x\.sid\) && !termTabs\.some\(o => o\.id !== tabId && o\.sid === x\.sid\)/);
  assert.match(HTML, /if \(!sid && needsClaude\(cmdOverride\) && !\/\^claude \(update\|install\)\\b\/\.test\(cmdOverride \|\| ''\)\) \{/, 'codex / gemini / 更新标签不去认 Claude 的会话号');
  assert.match(HTML, /if \(sig !== ccTabSig && !document\.querySelector\('#termTabs input\.trn'\) && !dnd\) \{\r?\n\s*ccTabSig = sig; renderTermTabs\(\);\r?\n\s*if \(leftTab === 'act'\) renderProjects\(\);/);
  // 左边「进行中」行带上 @名字和可点的会话号(2026-11-20)
  const act = cutBlock('function actIdHtml(t) {', 'function renderActive() {');
  const actIdHtml = new Function('ccSess', 'termCc', 'esc', act + '\nreturn actIdHtml;')(
    { [SID]: { name: 'claude-31' } }, { t9: { name: 'claude-project-4e' }, t8: { name: 'claude-project-5f', sid: '55555555-5555-4555-8555-555555555555' } }, (x) => String(x));
  assert.match(actIdHtml({ id: 't8', sid: '', title: '新会话' }), /^ · <span class="sidcopy"[^>]*>55555555<\/span> · @claude-project-5f$/, '新标签用登记里对出来的会话号');
  assert.match(actIdHtml({ id: 't1', sid: SID, title: 'TMS' }), /^ · <span class="sidcopy"[^>]*onclick="copySid\('4c489632-219f-4e4c-b403-282e8d609d28', event, 't1'\)">4c489632<\/span> · @claude-31$/);
  assert.equal(actIdHtml({ id: 't9', sid: '', title: '新会话' }), ' · @claude-project-4e', '还没认出会话号:先显示默认编号');
  assert.equal(actIdHtml({ id: 't1', sid: SID, title: 'claude-31' }).includes('@'), false, '名字和标题一样就不重复写');
  assert.match(HTML, /<div class="t2">\$\{esc\(pj \? pj\.short : t\.projShort\)\}\$\{actIdHtml\(t\)\}<\/div>/);
});

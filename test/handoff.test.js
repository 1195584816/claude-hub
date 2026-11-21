// 2026-11-20 / 11-21:交接并清空 / /clear 后标签跟上新会话号 / 复制会话号。
// 都从源码里按标记截出来真跑(main.js <cc-follow-sid>、index.html <handoff-clear>、<sid-copy>、<term-auto-reply>)。
const test = require('node:test');
const { mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ccname = require('../lib/ccname');

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
function cut(src, a, b) { const i = src.indexOf(a), j = src.indexOf(b); assert.ok(i >= 0 && j > i, a); return src.slice(i, j); }
const tmpRoots = [];
test.after(() => { for (const d of tmpRoots) try { fs.rmSync(d, { recursive: true, force: true }); } catch {} });

const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';

// ---------- /clear 后跟上新会话号 ----------
// parents:{ pid: 父 pid }(假进程表);terms:终端 id → { pid }(终端的 powershell)
function loadFollow(parents = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-follow-'));
  tmpRoots.push(home);
  const dir = path.join(home, '.claude', 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  const reg = (pid, sid, name = '总控开发') => fs.writeFileSync(path.join(dir, pid + '.json'), JSON.stringify({ pid, sessionId: sid, name }));
  const termMeta = new Map(), terms = new Map(), sent = [], titles = {};
  const data = { loadTitles: () => Object.assign({}, titles), setCustomTitle: (sid, t) => { titles[sid] = t; return true; } };
  const win = { isDestroyed: () => false, webContents: { send: (ch, x) => sent.push([ch, x]) } };
  const SID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  let asked = 0;
  const processParents = async () => { asked++; return parents; };
  const api = new Function('fs', 'path', 'os', 'termMeta', 'terms', 'data', 'win', 'SID_RE', 'processParents', 'ccname',
    cut(MAIN, '// <cc-follow-sid>', '// </cc-follow-sid>') + '\nreturn { ccFollowSids, termCcPid };')(
    fs, path, { homedir: () => home }, termMeta, terms, data, win, SID_RE, processParents, ccname);
  return { api, reg, termMeta, terms, sent, titles, asked: () => asked };
}

test('/clear 之后:同一个 Claude 进程换了会话号(名字没变)→ 标签跟着换,总控名抄给新会话号', async () => {
  const f = loadFollow({ 4242: 100, 100: 1 });          // claude 4242 是终端 powershell 100 的子进程
  f.terms.set('t1', { pid: 100 });
  f.termMeta.set('t1', { sid: A, claude: true });
  f.titles[A] = '总控开发';
  f.reg(4242, A);
  await f.api.ccFollowSids();
  assert.equal(f.api.termCcPid.get('t1').pid, 4242);
  assert.deepEqual(f.sent, []);
  f.reg(4242, B);                                        // 会话里 /clear 了,名字保留
  await f.api.ccFollowSids();
  assert.equal(f.termMeta.get('t1').sid, B);
  assert.equal(f.titles[B], '总控开发', '会话列表里名字不丢');
  assert.deepEqual(f.sent, [['term:sidChanged', { id: 't1', sid: B, oldSid: A }]]);
  await f.api.ccFollowSids();
  assert.equal(f.sent.length, 1, '没再变就不再报');
  assert.equal(f.asked(), 1, '认出来以后不再查进程表');
});

test('/clear 跟随:同一个会话号登记在好几个进程上,只认这个终端的子进程(别的窗口 /clear 不影响这个标签)', async () => {
  const f = loadFollow({ 5000: 900, 900: 1, 4242: 100, 100: 1 });   // 5000 是外部窗口里的,4242 才是这个终端的
  f.terms.set('t1', { pid: 100 });
  f.termMeta.set('t1', { sid: A, claude: true });
  f.reg(5000, A); f.reg(4242, A);
  await f.api.ccFollowSids();
  assert.equal(f.api.termCcPid.get('t1').pid, 4242);
  f.reg(5000, B);                                        // 外部窗口里那个 /clear 了
  await f.api.ccFollowSids();
  assert.equal(f.termMeta.get('t1').sid, A, '不能被别人的 /clear 带跑');
});

test('/clear 跟随:会话里 /resume 到别的对话(名字也变了)→ 跟着换号,但不把总控名抄过去', async () => {
  const f = loadFollow({ 7: 100, 100: 1 });
  f.terms.set('t1', { pid: 100 });
  f.termMeta.set('t1', { sid: A, claude: true });
  f.titles[A] = '总控开发';
  f.reg(7, A, '总控开发');
  await f.api.ccFollowSids();
  f.reg(7, B, '另一段对话');
  await f.api.ccFollowSids();
  assert.equal(f.termMeta.get('t1').sid, B);
  assert.equal(f.titles[B], undefined);
});

test('/clear 跟随:不是 Claude 标签、还没认出会话号、不是这个终端的子进程、会话号不像样 —— 都不动;新会话号已有名字不覆盖', async () => {
  const f = loadFollow({ 1: 100, 100: 1 });
  f.terms.set('codex', { pid: 100 }); f.terms.set('new', { pid: 100 });
  f.termMeta.set('codex', { sid: A, claude: false });
  f.termMeta.set('new', { sid: '', claude: true });
  f.reg(1, A);
  await f.api.ccFollowSids(); f.reg(1, B); await f.api.ccFollowSids();
  assert.equal(f.termMeta.get('codex').sid, A);
  assert.deepEqual(f.sent, []);

  const o = loadFollow({ 9: 555, 555: 1 });              // 登记的进程不是这个终端的
  o.terms.set('t1', { pid: 100 });
  o.termMeta.set('t1', { sid: A, claude: true });
  o.reg(9, A); await o.api.ccFollowSids();
  assert.equal(o.api.termCcPid.has('t1'), false);

  const g = loadFollow({ 7: 100, 100: 1 });
  g.terms.set('t1', { pid: 100 });
  g.termMeta.set('t1', { sid: A, claude: true });
  g.titles[A] = '旧名'; g.titles[B] = '已经有名';
  g.reg(7, A); await g.api.ccFollowSids();
  g.reg(7, 'not-a-uuid'); await g.api.ccFollowSids();
  assert.equal(g.termMeta.get('t1').sid, A, '会话号不像样不跟');
  g.reg(7, B); await g.api.ccFollowSids();
  assert.equal(g.titles[B], '已经有名');
});

// ---------- 交接并清空 ----------
// state():输入框状态 'empty' | 'text' | 'unknown';/clear 打进去后模拟主进程报来新会话号
function loadHandoff({ state = () => 'empty', status = 'idle', sidAfterClear = B } = {}) {
  const typed = [], toasts = [], raw = [];
  let fileAt = 0;
  const btn = { textContent: '' };
  const t = { id: 't1', claude: true, sid: A, projPath: 'F:\\proj\\', term: {}, lastKeyAt: 0 };
  const termTabs = [t];
  const ccSessObj = { [A]: { status }, [B]: { status: 'idle' } };
  const hub = {
    termInput: (id, s) => {
      if (s === '\r' && typed.length) { typed[typed.length - 1] += '\r'; raw.push(s); if (typed[typed.length - 1] === '/clear\r' && sidAfterClear) setTimeout(() => { t.sid = sidAfterClear; }, 2000); return; }
      typed.push(s); raw.push(s);
    },
    pathInfo: async () => (fileAt ? { exists: true, mtimeMs: fileAt } : { exists: false }),
    ccSessions: async () => ccSessObj,
  };
  const document = { getElementById: () => btn };
  const api = new Function('hub', 'termTabs', 'activeTerm', 'ccInputEmpty', 'ccInputState', 'hubToast', 'document', 'ccSess',
    cut(HTML, '// <cc-send>', '// </cc-send>') + cut(HTML, '// <handoff-clear>', '// </handoff-clear>') + '\nreturn { handoffClear, hoPath };')(
    hub, termTabs, 't1', (term) => state() === 'empty', (term) => state(), (m) => toasts.push(m), document, ccSessObj);
  return { api, typed, raw, toasts, btn, t, writeFile: () => { fileAt = Date.now(); }, ccSessObj };
}
async function tick(ms) { for (let k = 0; k < ms / 500; k++) { mock.timers.tick(500); for (let i = 0; i < 8; i++) await Promise.resolve(); } }
async function settle(p, maxMs = 120000) {      // 推进假时钟直到流程结束(避免测试卡死)
  let done = false; p.then(() => { done = true; }, () => { done = true; });
  for (let ms = 0; ms < maxMs && !done; ms += 500) await tick(500);
  assert.ok(done, '流程没结束');
}

test('交接路径:项目目录下 交接_日期_时分_清空前.md', () => {
  const { api } = loadHandoff();
  assert.match(api.hoPath('F:\\claude-project\\claude-hub\\'), /^F:\\claude-project\\claude-hub\\交接_\d{4}-\d\d-\d\d_\d{4}_清空前\.md$/);
});

test('交接并清空:点一下只是待确认;再点 → 写交接 → 写完清空 → 会话号换了才让新上下文读交接', async (t0) => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1e9 }); t0.after(() => mock.timers.reset());
  const h = loadHandoff();
  await h.api.handoffClear();
  assert.equal(h.typed.length, 0, '第一下不动手');
  assert.equal(h.btn.textContent, '再点一次确认');
  const p = h.api.handoffClear();
  await tick(1000);
  assert.match(h.typed[0], /^请把这次会话的工作写成一份交接文件,存到 F:\\proj\\交接_.*_清空前\.md .*\r$/);
  assert.equal(h.raw[1], '\r', '文字和回车分开发(长文字连着回车会被当成粘贴)');
  await tick(9000);
  assert.equal(h.typed.length, 1, '交接文件没写好之前不清空');
  h.t.lastKeyAt = Date.now();          // 中途人点了终端 / 切窗口回来 / 批准了权限确认 —— 不再算停止
  h.writeFile();
  await settle(p);
  assert.equal(h.typed[1], '/clear\r');
  assert.match(h.typed[2], /^先读交接文件 F:\\proj\\交接_.*_清空前\.md ,读完按里面写的接着做/);
  assert.equal(h.typed.length, 3);
  assert.equal(h.btn.textContent, '🧾 交接并清空');
});

test('交接并清空:/clear 之后会话号一直没变(没真清空)→ 不往旧上下文里塞「读交接」', async (t0) => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1e9 }); t0.after(() => mock.timers.reset());
  const h = loadHandoff({ sidAfterClear: null });
  await h.api.handoffClear();
  const p = h.api.handoffClear();
  for (let i = 0; i < 8; i++) await Promise.resolve();
  h.writeFile();
  await settle(p);
  assert.deepEqual(h.typed.slice(1), ['/clear\r']);
  assert.match(h.toasts.at(-1), /会话号没变/);
});

test('交接并清空:Claude 停下了却没在约定路径写文件 → 几次之后停下提示,不白等 20 分钟', async (t0) => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1e9 }); t0.after(() => mock.timers.reset());
  const h = loadHandoff();
  await h.api.handoffClear();
  const p = h.api.handoffClear();
  await settle(p, 60000);
  assert.equal(h.typed.length, 1);
  assert.match(h.toasts.at(-1), /没在约定的位置写交接文件/);
});

test('交接并清空:不开始的情况 —— 输入框有字 / 认不出输入框 / Claude 在忙 / 不是 Claude 标签 / 进程已结束 / 没认出会话号', async () => {
  for (const [o, re] of [[{ state: () => 'text' }, /输入框里有字/], [{ state: () => 'unknown' }, /认不出/], [{ status: 'busy' }, /还在忙/]]) {
    const h = loadHandoff(o);
    await h.api.handoffClear(); await h.api.handoffClear();
    assert.equal(h.typed.length, 0);
    assert.match(h.toasts.at(-1), re);
  }
  for (const patch of [{ claude: false }, { exited: true }, { sid: '' }]) {
    const h = loadHandoff();
    Object.assign(h.t, patch);
    await h.api.handoffClear(); await h.api.handoffClear();
    assert.equal(h.typed.length, 0, JSON.stringify(patch));
  }
});

test('交接并清空:写交接期间再点一下按钮 → 停下,不打 /clear', async (t0) => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1e9 }); t0.after(() => mock.timers.reset());
  const h = loadHandoff();
  await h.api.handoffClear();
  const p = h.api.handoffClear();
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await tick(2000);
  await h.api.handoffClear();          // 按钮这时是「■ 停止交接」
  h.writeFile();
  await settle(p);
  assert.equal(h.typed.length, 1, '不许再往里打 /clear');
});

test('交接并清空:输入框里一直有字(人在打字)→ 一直等着不打 /clear;人点停止就收', async (t0) => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1e9 }); t0.after(() => mock.timers.reset());
  let n = 0;
  const h = loadHandoff({ state: () => (++n <= 1 ? 'empty' : 'text') });   // 开始时空,之后一直有字
  await h.api.handoffClear();
  const p = h.api.handoffClear();
  for (let i = 0; i < 8; i++) await Promise.resolve();
  h.writeFile();
  await tick(30000);
  assert.ok(!h.typed.includes('/clear\r'));
  await h.api.handoffClear();          // 停止
  await settle(p);
  assert.ok(!h.typed.includes('/clear\r'));
});

test('确认要在同一个标签上:A 上点了第一下,换到别的标签再点不算确认', async () => {
  const h = loadHandoff();
  await h.api.handoffClear();          // 在 t1 上点了第一下
  h.t.id = 't2';                       // 模拟:当前标签换成了另一个(activeTerm 闭包里还是 't1',这里改 id 让查找失败)
  await h.api.handoffClear();
  assert.equal(h.typed.length, 0);
});

// ---------- 终端自己回的话不算按键 ----------
test('onData:焦点上报 / 鼠标上报 / 查询应答不更新「刚按过键」;正则和 lib/ccname.js 是同一份', () => {
  const isTermAutoReply = new Function(cut(HTML, '// <term-auto-reply>', '// </term-auto-reply>') + '\nreturn isTermAutoReply;')();
  for (const s of ['\x1b[I', '\x1b[O', '\x1b[<0;10;5M', '\x1b[12;40R', '\x1b[?1;2c']) assert.equal(isTermAutoReply(s), true, JSON.stringify(s));
  for (const s of ['a', '\r', '\x1b[A', '你好']) assert.equal(isTermAutoReply(s), false, JSON.stringify(s));
  for (const s of ['\x1b[I', '\x1b[<0;1;1m', 'x', '\x1b[3~']) assert.equal(isTermAutoReply(s), ccname.isAutoReply(s));
  assert.match(HTML, /if \(tt && !isTermAutoReply\(d\)\) tt\.lastKeyAt = Date\.now\(\);/);
});

test('接线:按钮、会话号跟随、标签记下是不是 Claude / 进程结束', () => {
  assert.match(HTML, /id="hoBtn" onclick="handoffClear\(\)"/);
  assert.match(HTML, /hub\.onTermSidChanged\(\(\{ id, sid \}\) =>/);
  assert.match(HTML, /linkColor, claude: needsClaude\(cmdOverride\)/);
  assert.match(HTML, /hub\.onTermExit\(m => \{ const t = termTabs\.find\(x => x\.id === m\.id\); if \(t\) \{ t\.exited = true;/);
  assert.match(MAIN, /setInterval\(ccFollowSids, 5e3\);/);
  assert.match(MAIN, /termInputs\.delete\(id\); termCcPid\.delete\(id\);/);
  assert.match(MAIN, /path: x, mtimeMs: st\.mtimeMs \}/);
});

// ---------- 复制会话号 ----------
test('复制会话号:会话名 + @名字 + 完整会话号 + 记录文件路径;缺的部分就不写', () => {
  const { sidCopyText } = new Function(cut(HTML, '// <sid-copy>', '// </sid-copy>') + '\nreturn { sidCopyText };')();
  const jsonl = 'C:\\Users\\x\\.claude\\projects\\F--claude-project\\' + A + '.jsonl';
  assert.equal(sidCopyText(A, '总控开发', '总控开发', jsonl), '会话「总控开发」(别的会话喊它 @总控开发,会话号 ' + A + ',记录文件 ' + jsonl + ')');
  assert.equal(sidCopyText(A, '', '', ''), '会话「11111111」(会话号 ' + A + ')');
  assert.match(HTML, /class="sidcopy"[^>]*onclick="copySid\('\$\{s\.sid\}', event\)"/);
  assert.match(HTML, /label: '复制会话号\(给别的会话用\)', run: \(\) => copySid\(t\.sid\)/);
  assert.match(HTML, /onclick="copySid\('\$\{sid\}', event, '\$\{t\.id\}'\)"/, '进行中列表带上标签 id');
});

test('交接并清空:「写交接」那句发出去后输入框一直有字(没发出去)→ 马上停下提示,不空等', async (t0) => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1e9 }); t0.after(() => mock.timers.reset());
  let started = false;
  const h = loadHandoff({ state: () => (started ? 'text' : 'empty') });
  await h.api.handoffClear();
  const p = h.api.handoffClear();
  started = true;
  await settle(p, 30000);
  assert.match(h.toasts.at(-1), /没发出去/);
  assert.ok(!h.typed.includes('/clear\r'));
});

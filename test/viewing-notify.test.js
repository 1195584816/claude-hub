// 「人已经在会话里了,它的完成通知就别进铃铛」+ 顶栏不常驻显示小九 API。
//
// 2026-11-14 三月:「通知这个,就是用户如果点过左侧的会话了,通知里就别出现了,因为他已经进去了。」
// 点会话 / 切标签时清未读早就有;漏的是:人**正待在**某个会话里,它又完成一轮,新记录照样进未读。
//
// 和 unread-feed.test.js 一样,直接从 index.html 里截真源码来跑。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const between = (a, b) => { const i = SRC.indexOf(a), j = SRC.indexOf(b); assert.ok(i >= 0 && j > i, '找不到标记 ' + a); return SRC.slice(i, j); };
const pickLine = (name) => { const m = new RegExp('^const ' + name + ' = .*$', 'm').exec(SRC); assert.ok(m, '找不到 const ' + name); return m[0]; };

function loadFeed(state) {
  const body = [
    pickLine('leaf'), pickLine('fkey'),
    'let projects = __s.projects, feedList = __s.feedList, unread = __s.unread;',
    'let seen = __s.seen || {};',
    'const __store = {}; const store = { get: (k, d) => (k in __store ? __store[k] : d), set: (k, v) => { __store[k] = v; } };',
    between('// <pure-unread-logic>', '// </pure-unread-logic>'),
    'return { processFeed, totalUnread, feedGroups, get unread(){ return unread; }, get seen(){ return seen; } };'
  ].join('\n');
  return new Function('__s', body)(state);
}
// viewingRec 依赖页面上的几样东西,这里给假的
function loadViewing(env) {
  const document = { getElementById: () => ({ classList: { contains: () => !!env.termOn } }) };
  const body = [pickLine('leaf'), between('// <viewing-rec>', '// </viewing-rec>'), 'return viewingRec;'].join('\n');
  return new Function('document', '__e', 'const termTabs = __e.termTabs; let activeTerm = __e.activeTerm; let restoring = !!__e.restoring;\n' + body)(document, env);
}

const P = 'F:\\proj\\alpha', Q = 'F:\\proj\\beta';
const projects = [{ path: P, short: 'alpha' }, { path: Q, short: 'beta' }];
const REC = (sid, ts, cwd, task = '做完了') => ({ sid, ts, task, cwd, proj: String(cwd).split('\\').pop(), result: '', tok: 1 });

// ---------- 进不进未读 ----------
test('人就在这个会话里:它的新完成记录不进未读,铃铛数不涨', () => {
  const m = loadFeed({ projects, feedList: [], unread: {} });
  const list = [REC('s1', '2026-11-14 10:00:00', P)];
  const added = m.processFeed(list, (r) => r.sid === 's1');
  assert.deepEqual(Object.keys(m.unread), []);
  assert.equal(added.length, 1, '仍然算「新来的」:认领会话号、刷新列表、提示音都靠它');
  assert.ok(Object.keys(m.seen).length === 1, '要记成见过,不然下一轮又当新的');
  // 同一条记录下次再扫到(此时人已经切走了)也不许再冒出来
  const again = m.processFeed(list, () => false);
  assert.equal(again.length, 0);
  assert.deepEqual(Object.keys(m.unread), []);
});

test('人在别的会话里:照常进未读', () => {
  const m = loadFeed({ projects, feedList: [], unread: {} });
  m.processFeed([REC('s1', '2026-11-14 10:00:00', P), REC('s2', '2026-11-14 10:01:00', Q)], (r) => r.sid === 's1');
  assert.deepEqual(Object.keys(m.unread), ['s2']);
});

test('不传 viewing(启动时那次)、viewing 抛不出东西:和以前一样全部进未读', () => {
  const m = loadFeed({ projects, feedList: [], unread: {} });
  m.processFeed([REC('s1', '2026-11-14 10:00:00', P)]);
  assert.deepEqual(Object.keys(m.unread), ['s1']);
  const m2 = loadFeed({ projects, feedList: [], unread: {} });
  m2.processFeed([REC('s1', '2026-11-14 10:00:00', P)], () => false);
  assert.deepEqual(Object.keys(m2.unread), ['s1']);
});

test('人在会话里时来的新一轮,不许把这个会话以前攒下的未读顺手删掉或改掉', () => {
  const old = { projPath: Q, projLeaf: 'beta', sid: 's9', ts: '2026-11-14 09:00:00', task: '别的会话', cwd: Q };
  const m = loadFeed({ projects, feedList: [], unread: { s9: old } });
  m.processFeed([REC('s1', '2026-11-14 10:00:00', P)], (r) => r.sid === 's1');
  assert.deepEqual(m.unread, { s9: old });
});

// ---------- 怎么算「人就在里面」 ----------
const tabs = () => [{ id: 't1', sid: 's1', projPath: P }, { id: 't2', sid: 's2', projPath: Q }, { id: 't3', sid: '', projPath: Q }];

test('在里面:终端区开着,当前标签的会话号就是这条记录的', () => {
  const v = loadViewing({ termTabs: tabs(), activeTerm: 't1', termOn: true });
  assert.equal(v(REC('s1', 'x', P)), true);
  assert.equal(v(REC('s2', 'x', Q)), false, '当前标签是别的会话');
  assert.equal(v(REC('s1', 'x', Q)), true, '认会话号,不认目录');
});

test('不算在里面:只开着面板没进终端区 / 正在恢复上次的标签 / 没有当前标签 / 记录是空的', () => {
  assert.equal(loadViewing({ termTabs: tabs(), activeTerm: 't1', termOn: false })(REC('s1', 'x', P)), false);
  assert.equal(loadViewing({ termTabs: tabs(), activeTerm: 't1', termOn: true, restoring: true })(REC('s1', 'x', P)), false);
  assert.equal(loadViewing({ termTabs: tabs(), activeTerm: 'gone', termOn: true })(REC('s1', 'x', P)), false);
  assert.equal(loadViewing({ termTabs: [], activeTerm: null, termOn: true })(REC('s1', 'x', P)), false);
  assert.equal(loadViewing({ termTabs: tabs(), activeTerm: 't1', termOn: true })(null), false);
  assert.equal(loadViewing({ termTabs: tabs(), activeTerm: 't1', termOn: true })(REC('', 'x', P)), false, '记录没有会话号,对不上');
});

test('新开的会话还没拿到会话号:一律不算在里面(按目录猜会把同项目别的会话的完成吞掉)', () => {
  const v = loadViewing({ termTabs: tabs(), activeTerm: 't3', termOn: true });      // t3:beta 目录下的新会话,还没有会话号
  assert.equal(v(REC('s-new', 'x', Q)), false, '同目录也不算:它可能是外部终端 / 手机上另一个会话的');
  assert.equal(v(REC('s2', 'x', Q)), false);
  assert.equal(v({ sid: 's-new', proj: 'beta' }), false);
  assert.equal(v(REC('', 'x', Q)), false);
});

test('整条链路:人停在没有会话号的新标签上,同项目两个别的会话完成 → 两条都要进未读', () => {
  const v = loadViewing({ termTabs: tabs(), activeTerm: 't3', termOn: true });
  const m = loadFeed({ projects, feedList: [], unread: {} });
  m.processFeed([REC('ext-1', '2026-11-14 10:00:00', Q), REC('ext-2', '2026-11-14 10:01:00', Q)], v);
  assert.deepEqual(Object.keys(m.unread).sort(), ['ext-1', 'ext-2']);
});

// ---------- 接线 + 小九 API ----------
test('接线:收到新完成记录时带上「人在不在里面」;启动那次不带', () => {
  assert.ok(SRC.includes('const added = processFeed(list, viewingRec);'));
  assert.ok(SRC.includes('processFeed(feedList);'), '启动时那次处理不该带 viewing(那时还没有当前标签)');
});

test('小九 API:顶栏默认不显示,只在有任务排队或执行时露出来;新装的电脑默认不开这个接口', () => {
  assert.ok(SRC.includes('<div class="agentpill" id="agentpill" style="display:none"'), '一开始就该是藏着的');
  const a = SRC.indexOf('function renderAgentStatus(s) {'), b = SRC.indexOf('async function refreshAgentStatus()');
  const els = {};
  const document = { getElementById: () => els.pill };
  const render = new Function('document', SRC.slice(a, b) + '\nreturn renderAgentStatus;')(document);
  const show = (s) => { els.pill = { className: '', textContent: '', title: '', style: { display: 'x' }, classList: { add() {} } }; render(s); return els.pill.style.display; };
  assert.equal(show({ enabled: true, ok: true, running: 0, queued: 0, host: '127.0.0.1', port: 8765 }), 'none', '就绪时不显示');
  assert.equal(show({ enabled: false }), 'none', '关着时不显示');
  assert.equal(show({ enabled: true, ok: false, error: '端口被占' }), '', '开着却没起来:要显示(只有主动开了接口的人会遇到,不说他没处知道)');
  assert.equal(show({ enabled: false, ok: false, error: 'x' }), 'none', '关着的时候就算带着错误信息也不显示');
  assert.equal(show({ enabled: true, ok: true, running: 1, queued: 0 }), '', '有任务在跑时显示');
  assert.equal(show({ enabled: true, ok: true, running: 0, queued: 2 }), '', '有任务排队时显示');
});

test('小九 API 配置:只有文件真的不存在(新装)才默认关;文件在但读坏了 / 带 BOM / 缺 token,不许被悄悄关掉', () => {
  const os = require('node:os');
  const crypto = require('node:crypto');
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const fnSrc = main.slice(main.indexOf('function loadAgentConfig()'), main.indexOf('async function startAgentControl()'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-agentcfg-'));
  const file = path.join(dir, 'agent-api.json');
  const writeJsonAtomic = (p, v) => fs.writeFileSync(p, JSON.stringify(v, null, 2));
  const load = new Function('fs', 'crypto', 'AGENT_CFG', 'HUB_HOME', 'writeJsonAtomic', fnSrc + '\nreturn loadAgentConfig;')(fs, crypto, file, dir, writeJsonAtomic);
  const TOKEN = 'a'.repeat(64);

  // 新装:没有文件 → 关着,而且把文件建出来(用户才有东西可改)
  let c = load();
  assert.equal(c.enabled, false);
  assert.ok(fs.existsSync(file) && c.token.length === 64 && c.host === '127.0.0.1');
  // 用户照 README 把 enabled 改成 true → 开,令牌和端口不变
  const tok = c.token;
  fs.writeFileSync(file, JSON.stringify(Object.assign({}, c, { enabled: true, port: 9100 })));
  c = load();
  assert.deepEqual([c.enabled, c.token, c.port], [true, tok, 9100]);
  // 同样的内容但文件带 BOM(PowerShell / 记事本存盘常见)→ 照样读得出来,不重置
  fs.writeFileSync(file, '﻿' + JSON.stringify({ enabled: true, port: 9100, token: tok }));
  c = load();
  assert.deepEqual([c.enabled, c.token, c.port], [true, tok, 9100], '带 BOM 不许被当成坏文件重置');
  // 老用户的文件:没有 enabled 字段 → 开着
  fs.writeFileSync(file, JSON.stringify({ port: 8765, token: TOKEN }));
  assert.equal(load().enabled, true);
  // 老用户明确关过 → 保持关
  fs.writeFileSync(file, JSON.stringify({ enabled: false, port: 8765, token: TOKEN }));
  assert.equal(load().enabled, false);
  // 文件在,但读坏了(多了个逗号)或缺 token → 重建,但必须还是**开着**的(老行为),不能顺带关掉
  for (const broken of ['{"enabled":true,"port":8765,"token":"' + TOKEN + '",}', '{"enabled":true,"port":8765}', 'not json', '']) {
    fs.writeFileSync(file, broken);
    assert.equal(load().enabled, true, JSON.stringify(broken.slice(0, 30)));
  }
  // 无论文件里写什么,只监听本机
  fs.writeFileSync(file, JSON.stringify({ enabled: true, host: '0.0.0.0', port: 8765, token: TOKEN }));
  assert.equal(load().host, '127.0.0.1');
  fs.rmSync(dir, { recursive: true, force: true });
});

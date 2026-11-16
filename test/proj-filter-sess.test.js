// 左栏筛选框也能按「改过名的会话」找到项目。
//
// 2026-11-16 三月:「我改了会话名,为什么搜不到」。他在左栏输 st,只出来 rust修复 这个项目,
// 改名成 stripe 的会话(在「自动搭节点」项目里)出不来 —— 那个框以前只比对项目名 / 路径 / 分组。
// 现在:项目清单里带上每个项目「改过名的会话」,筛选时会话名中了也留下这个项目,并把中的会话亮出来。
// 只认手动改过名的:自动标题要逐个读会话文件,几十个项目全读一遍会卡。
//
// 界面那段直接从真源码里截出来跑;数据层在子进程里跑,APPDATA / 用户目录都指到临时目录,不碰真实数据。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const between = (src, a, b) => { const i = src.indexOf(a), j = src.indexOf(b); assert.ok(i >= 0 && j > i, '找不到标记 ' + a); return src.slice(i, j); };

function loadUi(projects) {
  const src = between(HTML, '// <proj-filter-hit>', '// </proj-filter-hit>');
  return new Function('projects', src + '\nreturn { projFilterHit, noteSessName };')(projects);
}

// ---------- 界面:该留哪些行 ----------
test('没输字:项目照常显示,会话行一条不亮', () => {
  const { projFilterHit } = loadUi([]);
  assert.deepEqual(projFilterHit('', '自动搭节点 f:\\x 科学xx', ['stripe', 'tms-11-14']), { show: true, sess: [false, false] });
});

test('三月的原场景:输 st,rust修复 靠项目名留下,自动搭节点 靠会话 stripe 留下', () => {
  const { projFilterHit } = loadUi([]);
  assert.deepEqual(projFilterHit('st', 'rust修复 f:\\rust 虚拟定位', []), { show: true, sess: [] });
  assert.deepEqual(projFilterHit('st', '自动搭节点 f:\\jiedian 科学xx', ['tms-11-14', 'stripe', '神3']), { show: true, sess: [false, true, false] });
});

test('项目名和会话名都没中:这一行收走', () => {
  const { projFilterHit } = loadUi([]);
  assert.deepEqual(projFilterHit('zzz', '自动搭节点 f:\\jiedian', ['stripe']), { show: false, sess: [false] });
});

test('项目名中了、会话名没中:项目留下,但不亮无关的会话', () => {
  const { projFilterHit } = loadUi([]);
  assert.deepEqual(projFilterHit('节点', '自动搭节点 f:\\jiedian', ['stripe']), { show: true, sess: [false] });
});

test('没有改过名的会话 / 传进来的是空:不炸', () => {
  const { projFilterHit } = loadUi([]);
  assert.deepEqual(projFilterHit('st', 'stripe-proj', undefined), { show: true, sess: [] });
  assert.deepEqual(projFilterHit('st', undefined, [undefined, null]), { show: false, sess: [false, false] });
});

// ---------- 界面:改完名当场跟上 ----------
test('改一个已经在清单里的会话名:原地换成新名字,不多出一条', () => {
  const projects = [{ path: 'A', named: [{ sid: 's1', title: '旧名' }] }, { path: 'B', named: [] }];
  loadUi(projects).noteSessName('s1', 'stripe', 'B');
  assert.deepEqual(projects[0].named, [{ sid: 's1', title: 'stripe' }]);
  assert.deepEqual(projects[1].named, []);
});

test('第一次给会话改名:记到它所在的项目上', () => {
  const projects = [{ path: 'A' }, { path: 'B', named: [{ sid: 'old', title: 'x' }] }];
  const ui = loadUi(projects);
  ui.noteSessName('s9', 'stripe', 'A');
  ui.noteSessName('s8', '神3', 'B');
  assert.deepEqual(projects[0].named, [{ sid: 's9', title: 'stripe' }]);
  assert.deepEqual(projects[1].named, [{ sid: 's8', title: '神3' }, { sid: 'old', title: 'x' }]);
});

test('没有 sid、名字是空、项目找不到:什么都不动', () => {
  const projects = [{ path: 'A', named: [] }];
  const ui = loadUi(projects);
  ui.noteSessName('', 'x', 'A');
  ui.noteSessName('s1', '', 'A');
  ui.noteSessName('s1', 'x', '不存在');
  assert.deepEqual(projects, [{ path: 'A', named: [] }]);
});

test('界面接线:项目行里带会话行,筛选用的是 projFilterHit,三个改名入口都跟上', () => {
  assert.match(HTML, /class="psess"[^>]*data-sid=/);
  const apply = HTML.slice(HTML.indexOf('function applyProjFilter()'), HTML.indexOf('function applySessFilter()'));
  assert.match(apply, /projFilterHit\(q, row\.dataset\.q/);
  const renames = HTML.split('await hub.renameSession(').length - 1;
  const notes = HTML.split('noteSessName(').length - 2;   // 减掉函数定义那一处
  assert.equal(renames, 3);
  assert.equal(notes, 3, '每个改名入口后面都要 noteSessName');
});

// ---------- 数据层:项目清单带上改过名的会话 ----------
function runGetProjects(setup) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-pfs-'));
  try {
    const home = path.join(tmp, 'home'), appdata = path.join(tmp, 'appdata');
    const hubDir = path.join(appdata, 'claude-hub');
    fs.mkdirSync(hubDir, { recursive: true });
    const projDir = (slug) => { const d = path.join(home, '.claude', 'projects', slug); fs.mkdirSync(d, { recursive: true }); return d; };
    const sess = (slug, sid, cwd, size) => {
      const line = JSON.stringify({ type: 'user', cwd, message: { content: 'hi' } }) + '\n';
      fs.writeFileSync(path.join(projDir(slug), sid + '.jsonl'), size === 'tiny' ? '{}' : line.repeat(4));
    };
    setup({ hubDir, sess, projDir });
    const out = execFileSync(process.execPath, ['-e',
      'const d=require(' + JSON.stringify(path.join(ROOT, 'lib', 'data.js')) + ');process.stdout.write(JSON.stringify(d.getProjects()))'],
      { env: { ...process.env, APPDATA: appdata, USERPROFILE: home, HOME: home }, encoding: 'utf8' });
    return JSON.parse(out);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

test('getProjects:只带改过名的会话,名字去首尾空格,空名和别的项目的不带', () => {
  const list = runGetProjects(({ hubDir, sess }) => {
    fs.writeFileSync(path.join(hubDir, 'projects.json'), JSON.stringify([
      { name: 'A', path: 'X:\\a', sessSlug: 'X--a' },
      { name: 'B', path: 'X:\\b', sessSlug: 'X--b' },
    ]));
    sess('X--a', 'a1', 'X:\\a'); sess('X--a', 'a2', 'X:\\a'); sess('X--a', 'a3', 'X:\\a');
    sess('X--a', 'a4', 'X:\\a', 'tiny');
    sess('X--b', 'b1', 'X:\\b');
    fs.writeFileSync(path.join(hubDir, 'session-titles.json'), JSON.stringify({
      a1: ' stripe ', a3: '   ', a4: '空壳', b1: '神3', gone: '会话文件已经没了', a2: 123,
    }));
  });
  const A = list.find(p => p.name === 'A'), B = list.find(p => p.name === 'B');
  assert.deepEqual(A.named, [{ sid: 'a1', title: 'stripe' }]);
  assert.deepEqual(B.named, [{ sid: 'b1', title: '神3' }]);
  assert.equal(A.sessCount, 3, '会话计数不受影响');
});

test('getProjects:没有 session-titles.json / 文件读坏了,项目清单照常出,named 是空', () => {
  for (const bad of [null, '{坏的']) {
    const list = runGetProjects(({ hubDir, sess }) => {
      fs.writeFileSync(path.join(hubDir, 'projects.json'), JSON.stringify([{ name: 'A', path: 'X:\\a', sessSlug: 'X--a' }]));
      sess('X--a', 'a1', 'X:\\a');
      if (bad) fs.writeFileSync(path.join(hubDir, 'session-titles.json'), bad);
    });
    assert.equal(list.length, 1);
    assert.deepEqual(list[0].named, []);
    assert.equal(list[0].sessCount, 1);
  }
});

test('getProjects:两个项目共用一个会话目录时,改过名的会话只记到它真正所在的项目上', () => {
  const list = runGetProjects(({ hubDir, sess }) => {
    fs.writeFileSync(path.join(hubDir, 'projects.json'), JSON.stringify([
      { name: 'A', path: 'X:\\甲', sessSlug: 'X---' },
      { name: 'B', path: 'X:\\乙', sessSlug: 'X---' },
    ]));
    sess('X---', 's1', 'X:\\甲'); sess('X---', 's2', 'X:\\乙');
    fs.writeFileSync(path.join(hubDir, 'session-titles.json'), JSON.stringify({ s1: '甲的会话', s2: '乙的会话' }));
  });
  assert.deepEqual(list.find(p => p.name === 'A').named, [{ sid: 's1', title: '甲的会话' }]);
  assert.deepEqual(list.find(p => p.name === 'B').named, [{ sid: 's2', title: '乙的会话' }]);
});

// ====================================================================
// 第一轮验收(2026-11-16)打回来的:两个必须修 + 一批「改坏了测试也不红」的地方。
// ====================================================================
const MAIN = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const escAttr = new Function(between(HTML, '// <esc-attr>', '// </esc-attr>') + '\nreturn escAttr;')();
const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

test('escAttr:引号、尖括号、& 都转掉;空值给空串', () => {
  assert.equal(escAttr('fix "login" bug'), 'fix &quot;login&quot; bug');
  assert.equal(escAttr("it's <b> & co"), 'it&#39;s &lt;b&gt; &amp; co');
  assert.equal(escAttr(null), '');
  assert.equal(escAttr(undefined), '');
});

// ---------- 会话行的 HTML ----------
function loadPsess() {
  const src = between(HTML, '// <proj-filter-hit>', '// </proj-filter-hit>');
  return new Function('projects', 'esc', 'escAttr', 'ico', src + '\nreturn psessHtml;')([], esc, escAttr, () => '<i></i>');
}
// 把一段 HTML 里某个标签的属性抠出来(够测试用的极简解析:属性值都是双引号包着的)
function attrs(html) {
  const out = {};
  const open = html.slice(0, html.indexOf('>'));
  for (const m of open.matchAll(/([a-z-]+)="([^"]*)"/g)) if (!(m[1] in out)) out[m[1]] = m[2];
  return out;
}
const unescAttr = s => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

test('会话行:名字带英文双引号也完整进 data-q,不会断成别的属性(验收复现 A)', () => {
  const html = loadPsess()({ named: [{ sid: 's1', title: 'Fix "Login" bug' }] });
  const a = attrs(html);
  assert.equal(unescAttr(a['data-q']), 'fix "login" bug');
  assert.equal(a['data-sid'], 's1');
  assert.deepEqual(Object.keys(a).sort(), ['class', 'data-q', 'data-sid', 'onclick', 'style', 'title']);
});

test('会话行:名字里塞 onclick 注不进去,真的 onclick 还是唯一那个(验收复现 B)', () => {
  const html = loadPsess()({ named: [{ sid: 's1', title: 'zz" onclick="window.__xss=1' }] });
  const openTag = html.slice(0, html.indexOf('>'));     // 只看标签本身;正文里的引号是普通字,不算属性
  assert.equal((openTag.match(/ onclick="/g) || []).length, 1);
  const a = attrs(html);
  assert.match(a.onclick, /^event\.stopPropagation\(\);goNamedSess\(this\.closest\('\.proj'\)\.dataset\.path, this\.dataset\.sid\)$/);
  assert.ok(!/<span>[^<]*<[a-z]/i.test(html), '正文里的尖括号也得转掉');
});

test('会话行:正文转义、data-q 转小写、默认藏着;没有改过名的会话就什么都不出', () => {
  const f = loadPsess();
  const html = f({ named: [{ sid: 's1', title: 'Stripe <b>' }, { sid: 's2', title: '神3' }] });
  assert.equal((html.match(/class="psess"/g) || []).length, 2);
  assert.match(html, /<span>Stripe &lt;b&gt;<\/span>/);
  assert.equal(unescAttr(attrs(html)['data-q']), 'stripe <b>');
  assert.equal(attrs(html).style, 'display:none');
  assert.equal(f({}), '');
  assert.equal(f({ named: [] }), '');
  assert.equal(f(null), '');
  assert.match(HTML, /\$\{psessHtml\(p\)\}/, '项目行里要真的用上它');
});

// ---------- 筛选真跑:假 DOM ----------
function fakeLeft(q, groups) {
  const mk = (o) => Object.assign({ style: { display: 'INIT' } }, o);
  const grs = groups.map(g => {
    const rows = g.map(r => {
      const subs = (r.sess || []).map(s => mk({ dataset: { q: s } }));
      return mk({ name: r.name, dataset: { q: r.q }, subs, querySelectorAll: (sel) => { assert.equal(sel, '.psess'); return subs; } });
    });
    return mk({ rows, querySelectorAll: (sel) => { assert.equal(sel, '.proj'); return rows; } });
  });
  const hint = { textContent: '' }, col = { cls: {}, classList: { toggle: (c, on) => { col.cls[c] = on; } } };
  const document = {
    getElementById: (id) => id === 'projFilter' ? { value: q } : id === 'colProj' ? col : null,
    querySelectorAll: (sel) => { assert.equal(sel, '#colProj .pgrp'); return grs; },
    querySelector: (sel) => sel === '#colProj .sechint' ? hint : null,
  };
  const src = between(HTML, '// <proj-filter-hit>', '// </proj-filter-hit>') + '\n' + between(HTML, '// <proj-filter-apply>', '// </proj-filter-apply>');
  const all = groups.flat();
  new Function('document', 'projects', 'projFilter', src + '\napplyProjFilter();')(document, all, '');
  const vis = (x) => x.style.display === '';
  return {
    rows: Object.fromEntries(grs.flatMap(g => g.rows).map(r => [r.name, vis(r) ? r.subs.filter(vis).map(s => s.dataset.q) : null])),
    groups: grs.map(vis), hint: hint.textContent, filtering: col.cls.filtering,
  };
}
const LEFT = [
  [{ name: '自动搭节点', q: '自动搭节点 f:\\jiedian 科学xx', sess: ['tms-11-14', 'stripe', '神3'] }],
  [{ name: 'rust修复', q: 'rust修复 f:\\rust 虚拟定位', sess: [] }],
  [{ name: '三月导航', q: '三月导航 f:\\daohang 导航站', sess: ['改版'] }],
];

test('真跑筛选:输 st —— 自动搭节点 靠会话留下并只亮 stripe,rust修复 靠项目名留下,三月导航 整组收走', () => {
  const r = fakeLeft('  ST ', LEFT);
  assert.deepEqual(r.rows, { '自动搭节点': ['stripe'], 'rust修复': [], '三月导航': null });
  assert.deepEqual(r.groups, [true, true, false]);
  assert.equal(r.hint, '2 / 3 个');
  assert.equal(r.filtering, true);
});

test('真跑筛选:清空 —— 项目全回来,会话行一条不亮', () => {
  const r = fakeLeft('', LEFT);
  assert.deepEqual(r.rows, { '自动搭节点': [], 'rust修复': [], '三月导航': [] });
  assert.deepEqual(r.groups, [true, true, true]);
  assert.equal(r.filtering, false);
  assert.equal(r.hint, '拖动排序 · 右键分组');
});

test('真跑筛选:只有会话名中的项目也算进计数', () => {
  const r = fakeLeft('改版', LEFT);
  assert.deepEqual(r.rows, { '自动搭节点': null, 'rust修复': null, '三月导航': ['改版'] });
  assert.equal(r.hint, '1 / 3 个');
});

// ---------- 重绘左栏不抢筛选框的焦点 ----------
function runFocusBlock(focused) {
  const log = [];
  const oldBox = { value: 'Pay', selectionStart: 2, selectionEnd: 3 };
  const newBox = { value: 'pay', focus: () => log.push('focus'), setSelectionRange: (a, b) => log.push('sel ' + a + ',' + b) };
  let cur = oldBox;
  const document = { getElementById: (id) => id === 'projFilter' ? cur : null, activeElement: focused ? oldBox : {} };
  const restore = new Function('document', between(HTML, '// <proj-filter-focus>', '// </proj-filter-focus>') + '\nreturn restoreFilterFocus;')(document);
  cur = newBox;          // 重绘:框被重建成了新的
  restore();
  return { log, value: newBox.value };
}

test('重绘左栏:他正在筛选框里,重建后焦点、光标、原样的字都还回去(验收必须修 1)', () => {
  assert.deepEqual(runFocusBlock(true), { log: ['focus', 'sel 2,3'], value: 'Pay' });
});

test('重绘左栏:焦点不在筛选框,就不去抢', () => {
  assert.deepEqual(runFocusBlock(false), { log: [], value: 'pay' });
});

test('重绘左栏:还焦点这一步真的接在 renderProjects 里,而且在重新套筛选之前', () => {
  const body = HTML.slice(HTML.indexOf('function renderProjects()'), HTML.indexOf('// ===== 列表筛选框'));
  const a = body.indexOf('// <proj-filter-focus>'), b = body.indexOf('el.innerHTML ='), c = body.indexOf('restoreFilterFocus();'), d = body.indexOf('applyProjFilter();');
  assert.ok(a > 0 && a < b && b < c && c < d, '顺序:先记焦点 → 重绘 → 还焦点 → 套筛选');
});

// ---------- 点会话行 ----------
// 假的 selProj / openTerm 都真的「等一拍」再动手,和真程序一样有空档 —— 同步的假货测不出抢跑。
const tick = () => new Promise(r => setTimeout(r, 5));
function goHarness(o) {
  o = o || {};
  const calls = [];
  const state = { curPath: 'A', curSid: '', curSess: [], termTabs: o.termTabs || [] };
  const src = between(HTML, '// </proj-filter-hit>', '// <proj-filter-apply>').replace(/^\/\/ <\/proj-filter-hit>/, '');
  const go = new Function('state', 'selProj', 'openTerm', 'projects', 'with (state) {' + src + '\nreturn goNamedSess; }')(
    state,
    async (p, sid) => {
      calls.push('sel ' + p + ' ' + sid);
      await tick();
      state.curPath = o.endPath || p; state.curSid = o.endSid || sid; state.curSess = o.curSess || [];
    },
    async (...a) => { calls.push('open ' + a.join('|')); await tick(); state.termTabs.push({ sid: a[2] }); },
    [{ path: 'A', short: '甲', named: [{ sid: 's1', title: 'stripe' }, { sid: 's2', title: '神3' }] }]);
  return { go, calls };
}
const runGo = async (o) => { const h = goHarness(o); await h.go('A', (o && 'sid' in o) ? o.sid : 's1'); return h.calls; };

test('点会话行:会话在中间列表里 —— 只定位,不另开终端(列表是等 selProj 回来才有的)', async () => {
  assert.deepEqual(await runGo({ curSess: [{ sid: 's1' }] }), ['sel A s1']);
});

test('点会话行:会话已经开着终端 —— 只定位(selProj 会跳过去),不重复开', async () => {
  assert.deepEqual(await runGo({ termTabs: [{ sid: 's1' }] }), ['sel A s1']);
});

test('点会话行:会话太老、不在最近 40 条里 —— 直接接着开起来,名字用他改的那个', async () => {
  assert.deepEqual(await runGo({}), ['sel A s1', 'open A|甲|s1|stripe']);
});

test('点会话行:等的时候他切去了别的项目 / 换点了别的会话 / 这条不在清单里 —— 什么都不开', async () => {
  assert.deepEqual(await runGo({ endPath: 'B' }), ['sel A s1']);
  assert.deepEqual(await runGo({ endSid: 's2' }), ['sel A s1']);
  assert.deepEqual(await runGo({ sid: '不认识' }), ['sel A 不认识']);
  assert.deepEqual(await runGo({ sid: '' }), []);
});

test('点会话行:双击 / 手快连点同一条 —— 只开一个终端(第二轮验收必须修)', async () => {
  const h = goHarness();
  await Promise.all([h.go('A', 's1'), h.go('A', 's1'), h.go('A', 's1')]);
  assert.deepEqual(h.calls, ['sel A s1', 'open A|甲|s1|stripe']);
  // 开完以后再点:标签已经在了,只定位
  await h.go('A', 's1');
  assert.deepEqual(h.calls, ['sel A s1', 'open A|甲|s1|stripe', 'sel A s1']);
});

test('点会话行:openTerm 抛错也要把闸放开,下次还能点', async () => {
  const state = { curPath: 'A', curSid: '', curSess: [], termTabs: [] };
  const src = between(HTML, '// </proj-filter-hit>', '// <proj-filter-apply>').replace(/^\/\/ <\/proj-filter-hit>/, '');
  let n = 0;
  const go = new Function('state', 'selProj', 'openTerm', 'projects', 'with (state) {' + src + '\nreturn goNamedSess; }')(
    state, async (p, sid) => { state.curSid = sid; }, async () => { n++; throw new Error('开不起来'); },
    [{ path: 'A', short: '甲', named: [{ sid: 's1', title: 'stripe' }] }]);
  await assert.rejects(go('A', 's1'));
  await assert.rejects(go('A', 's1'));
  assert.equal(n, 2);
});

// ---------- 接线 ----------
test('接线:三个改名入口都是「记名字 + 重绘左栏」,项目传对', () => {
  assert.equal((HTML.match(/noteSessName\([^)]*\); renderProjects\(\);/g) || []).length, 3);
  assert.equal((HTML.match(/noteSessName\(t\.sid, [^,]+, t\.projPath\)/g) || []).length, 2, '终端标签两个入口用标签自己的项目');
  const rn = HTML.slice(HTML.indexOf('async function rnCommit('), HTML.indexOf('// ===== 会话名同步'));
  assert.ok(rn.indexOf('const projAtStart = curPath;') > 0 && rn.indexOf('const projAtStart = curPath;') < rn.indexOf('await hub.renameSession('), '项目要在 await 之前记下');
  assert.match(rn, /noteSessName\(sid, v, projAtStart\)/);
});

test('同类:别的属性里塞用户敲的字,也都走 escAttr', () => {
  for (const s of ['data-q="${escAttr((s.title + \' \' + s.sid).toLowerCase())}"', 'class="srn" value="${escAttr(s.title)}"',
    'class="trn" value="${escAttr(t.title)}"', 'title="${escAttr(t.title)}(按住拖动排序', 'value="${escAttr(val || \'\')}"']) {
    assert.ok(HTML.includes(s), '应该有:' + s);
  }
  assert.equal(HTML.split('value="${escAttr(f.value || \'\')}"').length - 1, 2, '表单弹窗两处');
  assert.ok(!/(value|title|placeholder|data-[a-z]+)="[^"\n]*\$\{esc\(/.test(HTML), '属性里不该再有用 esc 的(它不转引号),一律 escAttr');
});

test('本机接口的项目清单不带 named(字段保持原样)', () => {
  assert.match(MAIN, /getProjects: \(\) => data\.getProjects\(\)\.map\(\(\{ named, \.\.\.rest \}\) => rest\)/);
  assert.ok(!/getProjects: \(\) => data\.getProjects\(\),/.test(MAIN));
});

// ---------- 数据层补 ----------
test('getProjects:改过名的会话按最近活动排,新的在前', () => {
  const list = runGetProjects(({ hubDir, sess, projDir }) => {
    fs.writeFileSync(path.join(hubDir, 'projects.json'), JSON.stringify([{ name: 'A', path: 'X:\\a', sessSlug: 'X--a' }]));
    const now = Date.now() / 1000;
    for (const [sid, ago] of [['old', 9000], ['new', 10], ['mid', 500]]) {
      sess('X--a', sid, 'X:\\a');
      fs.utimesSync(path.join(projDir('X--a'), sid + '.jsonl'), now - ago, now - ago);
    }
    fs.writeFileSync(path.join(hubDir, 'session-titles.json'), JSON.stringify({ old: '老的', new: '新的', mid: '中间' }));
  });
  assert.deepEqual(list[0].named.map(x => x.title), ['新的', '中间', '老的']);
});

test('getProjects:标题表里是 null / 数组 / 一个字符串 —— 清单照常,计数和最近活动时间都不受影响', () => {
  for (const bad of ['null', '[1,2]', '"x"', '7']) {
    const list = runGetProjects(({ hubDir, sess }) => {
      fs.writeFileSync(path.join(hubDir, 'projects.json'), JSON.stringify([{ name: 'A', path: 'X:\\a', sessSlug: 'X--a' }]));
      sess('X--a', 'a1', 'X:\\a'); sess('X--a', 'a2', 'X:\\a'); sess('X--a', 'a3', 'X:\\a');
      fs.writeFileSync(path.join(hubDir, 'session-titles.json'), bad);
    });
    assert.deepEqual(list[0].named, [], bad);
    assert.equal(list[0].sessCount, 3, bad);
    assert.ok(list[0].lastActive > Date.now() - 60e3, bad + ':最近活动时间要算到最新那个文件');
  }
});

// ---------- 第二轮验收补的 ----------
test('界面拿的项目清单要原样带着 named(只有本机接口那份去掉)', () => {
  assert.ok(MAIN.includes("ipcMain.handle('hub:projects', () => data.getProjects());"));
});

// 标题表内容不是个对象时,读会话列表、改名都不能炸;改名要写出一份正常的表
function runData(bad, js) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-pfs-'));
  try {
    const home = path.join(tmp, 'home'), appdata = path.join(tmp, 'appdata');
    const hubDir = path.join(appdata, 'claude-hub'), sdir = path.join(home, '.claude', 'projects', 'X--a');
    fs.mkdirSync(hubDir, { recursive: true }); fs.mkdirSync(sdir, { recursive: true });
    fs.writeFileSync(path.join(hubDir, 'projects.json'), JSON.stringify([{ name: 'A', path: 'X:\\a', sessSlug: 'X--a' }]));
    fs.writeFileSync(path.join(sdir, 's1.jsonl'), (JSON.stringify({ type: 'user', cwd: 'X:\\a', message: { content: '第一句话' } }) + '\n').repeat(4));
    fs.writeFileSync(path.join(hubDir, 'session-titles.json'), bad);
    const out = execFileSync(process.execPath, ['-e', 'const d=require(' + JSON.stringify(path.join(ROOT, 'lib', 'data.js')) + ');' + js],
      { env: { ...process.env, APPDATA: appdata, USERPROFILE: home, HOME: home }, encoding: 'utf8' });
    return { out: JSON.parse(out), titles: fs.readFileSync(path.join(hubDir, 'session-titles.json'), 'utf8') };
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

test('标题表是 null / 数组 / 字符串 / 数字:会话列表照常出,标题退回自动的', () => {
  for (const bad of ['null', '[1,2]', '"x"', '7']) {
    const r = runData(bad, "process.stdout.write(JSON.stringify(d.getSessions('X--a','', 'X:\\\\a', false).map(s=>[s.sid,s.title])))");
    assert.deepEqual(r.out, [['s1', '第一句话']], bad);
  }
});

test('标题表是 null / 数组 / 字符串 / 数字:改名能成,写回去的是一份正常的表', () => {
  for (const bad of ['null', '[1,2]', '"x"', '7']) {
    const r = runData(bad, "process.stdout.write(JSON.stringify(d.setCustomTitle('s1','新名字')))");
    assert.equal(r.out, true, bad);
    assert.deepEqual(JSON.parse(r.titles), { s1: '新名字' }, bad);
  }
});

test('标题表正常时:改名只动这一条,别的名字原样留着', () => {
  const r = runData(JSON.stringify({ other: '别的会话', s1: '旧名' }), "process.stdout.write(JSON.stringify(d.setCustomTitle('s1','新名字')))");
  assert.deepEqual(JSON.parse(r.titles), { other: '别的会话', s1: '新名字' });
});

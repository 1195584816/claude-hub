// 顶栏「当前会话上下文占用」的读数逻辑。
// 为什么要测:这段要在主进程里被定时调用,而且喂给它的是几十 MB 的真实转录
// —— 读错了会在顶栏显示一个假数字,比不显示更坏。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const usage = require('../lib/usage.js');

// ---- 造一个假的会话目录 ----
let ROOT;
test.before(() => {
  ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxnow-'));
});
test.after(() => {
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {}
});

function asst(inT, cr, cw, ts, model) {
  return JSON.stringify({
    type: 'assistant', timestamp: ts,
    message: {
      model: model || 'claude-opus-5',
      usage: { input_tokens: inT, cache_read_input_tokens: cr, cache_creation_input_tokens: cw, output_tokens: 7 }
    }
  });
}
function userLine(txt) {
  return JSON.stringify({ type: 'user', message: { content: txt } });
}
// 官方每次压缩往转录里写的那条,形状照抄他自己转录里的原文
function boundary(trigger, preTokens, postTokens, ts) {
  return JSON.stringify({
    type: 'system', subtype: 'compact_boundary', timestamp: ts, isSidechain: false,
    compactMetadata: { trigger: trigger, preTokens: preTokens, postTokens: postTokens }
  });
}
function write(name, lines) {
  const fp = path.join(ROOT, name + '.jsonl');
  fs.writeFileSync(fp, lines.join('\n') + '\n', 'utf8');
  return fp;
}

test('取的是最后一轮,不是累计 —— 三轮加起来 60 万,读数必须是最后那轮的 25 万', () => {
  write('s1', [
    asst(100000, 50000, 10000, '2026-11-10T01:00:00Z'),
    userLine('接着干'),
    asst(120000, 60000, 20000, '2026-11-10T02:00:00Z'),
    userLine('再来'),
    asst(50000, 190000, 10000, '2026-11-10T03:00:00Z')
  ]);
  const r = usage.sessionContext(ROOT, 's1');
  assert.ok(r, '应该读到');
  assert.strictEqual(r.ctx, 50000 + 190000 + 10000, '口径 = input + cache_read + cache_creation');
  assert.strictEqual(r.model, 'opus-5', 'model 应该剥掉 claude- 前缀');
});

test('最后几行是 user / 工具结果时,要往上找到最近一条 assistant', () => {
  write('s2', [
    asst(80000, 20000, 0, '2026-11-10T01:00:00Z'),
    userLine('后面还有一堆非 assistant 的行'),
    userLine('再一行'),
    userLine('又一行')
  ]);
  const r = usage.sessionContext(ROOT, 's2');
  assert.strictEqual(r.ctx, 100000);
});

test('只倒读尾部:前面塞 1.5MB 垃圾,仍要读到末尾那轮(而且不会把整文件读进内存)', () => {
  const filler = [];
  // 每行约 2KB 的 user 行,堆到 1.5MB 以上 —— 超过 512KB 的倒读窗口
  const blob = 'x'.repeat(2000);
  for (let i = 0; i < 800; i++) filler.push(userLine(blob));
  const fp = write('s3', [
    asst(999999, 999999, 999999, '2026-01-01T00:00:00Z'),   // 这条在窗口外,绝不能被读到
    ...filler,
    asst(30000, 7000, 3000, '2026-11-10T05:00:00Z')
  ]);
  assert.ok(fs.statSync(fp).size > 1.5 * 1024 * 1024, '测试数据得真的超过倒读窗口');
  const r = usage.sessionContext(ROOT, 's3');
  assert.strictEqual(r.ctx, 40000, '必须是末尾那轮,不是窗口外那条天文数字');
});

test('倒读切口把第一行切坏了也不许崩 —— 坏行跳过,继续往上找', () => {
  // 构造:让 512KB 的切口正好落在某一行中间
  const blob = 'y'.repeat(2000);
  const lines = [];
  for (let i = 0; i < 400; i++) lines.push(userLine(blob));
  lines.push(asst(12000, 3000, 0, '2026-11-10T06:00:00Z'));
  for (let i = 0; i < 100; i++) lines.push(userLine(blob));
  lines.push(asst(21000, 4000, 0, '2026-11-10T07:00:00Z'));
  write('s4', lines);
  const r = usage.sessionContext(ROOT, 's4');
  assert.ok(r, '不许返回 null');
  assert.strictEqual(r.ctx, 25000);
});

test('一行 usage 都没有 / 文件不存在 / 空文件 → 返回 null,不抛', () => {
  write('s5', [userLine('全是用户消息'), userLine('没有 assistant')]);
  assert.strictEqual(usage.sessionContext(ROOT, 's5'), null);
  fs.writeFileSync(path.join(ROOT, 's6.jsonl'), '', 'utf8');
  assert.strictEqual(usage.sessionContext(ROOT, 's6'), null);
  assert.strictEqual(usage.sessionContext(ROOT, '根本不存在'), null);
});

test('usage 全是 0 的轮次不算 —— 会话刚建还没真跑时别显示 0%', () => {
  write('s7', [asst(0, 0, 0, '2026-11-10T08:00:00Z')]);
  assert.strictEqual(usage.sessionContext(ROOT, 's7'), null);
});

test('compactWindow:读得出 settings.json 里的值,读不到就退回官方默认 100 万', () => {
  const w = usage.compactWindow();
  assert.strictEqual(typeof w, 'number');
  assert.ok(w > 0, '必须是正数');
  // 真机上三月设了 30 万;就算哪天他改回 auto,这里也只能是 100 万默认值
  assert.ok(w === 1000000 || (w >= 100000 && w <= 1000000), '应落在官方允许区间内,实得 ' + w);
});

test('liveContext:坏输入(null / 空 / 带路径穿越)一律返回 null,不抛不越狱', () => {
  for (const bad of [null, undefined, '', '..', '../..', 'a/../../b', 'x\\..\\..\\y']) {
    let r, threw = false;
    try { r = usage.liveContext(bad); } catch { threw = true; }
    assert.strictEqual(threw, false, '输入 ' + JSON.stringify(bad) + ' 不许抛异常');
    assert.strictEqual(r, null, '输入 ' + JSON.stringify(bad) + ' 必须是 null');
  }
});

// ---- 可控夹具:把 paths 指到临时目录,不碰 ~/.claude ----
// lib/paths.js 导出的是同一个对象,而 liveContext/compactWindow 每次都 require('./paths').XXX,
// 所以直接改属性就能造出完全可控的场景。用完必须还原。
const P = require('../lib/paths.js');
let SAVED;
function useFixture() {
  if (!SAVED) SAVED = { pj: P.CLAUDE_PROJECTS, st: P.CLAUDE_SETTINGS, uc: P.USAGE_CACHE };
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxfix-'));
  P.CLAUDE_PROJECTS = path.join(base, 'projects');
  P.CLAUDE_SETTINGS = path.join(base, 'settings.json');
  // 账本缓存也必须换掉:sessionUsage 会往这个文件写,跑测试不能污染他真实的账本
  P.USAGE_CACHE = path.join(base, 'usage-cache.json');
  fs.mkdirSync(P.CLAUDE_PROJECTS, { recursive: true });
  return base;
}
function restoreFixture() { if (SAVED) { P.CLAUDE_PROJECTS = SAVED.pj; P.CLAUDE_SETTINGS = SAVED.st; P.USAGE_CACHE = SAVED.uc; } }
function sess(slug, sid, lines, ageMs) {
  const d = path.join(P.CLAUDE_PROJECTS, slug);
  fs.mkdirSync(d, { recursive: true });
  const fp = path.join(d, sid + '.jsonl');
  fs.writeFileSync(fp, lines.join('\n') + '\n', 'utf8');
  if (ageMs) { const t = (Date.now() - ageMs) / 1000; fs.utimesSync(fp, t, t); }
  return fp;
}
function settings(obj) { fs.writeFileSync(P.CLAUDE_SETTINGS, JSON.stringify(obj), 'utf8'); }

test('liveContext:sid 非法时必须返回 null,不许退回「目录里最新那个」', (t) => {
  // 原来这条靠"真机上恰好有个会话 60 秒内动过"才成立,多数时候 live 是 undefined,
  // 退化成"不存在的目录返回 null" —— 等于没测 sid 守卫。改成可控夹具。
  const base = useFixture();
  t.after(() => { restoreFixture(); try { fs.rmSync(base, { recursive: true, force: true }); } catch {} });
  sess('proj', 'good', [asst(100000, 0, 0, '2026-11-10T09:00:00Z')]);
  sess('proj', 'other', [asst(260000, 0, 0, '2026-11-10T09:00:00Z')]);
  settings({ autoCompactWindow: 300000 });

  assert.ok(usage.liveContext('proj', 'good'), '合法 sid 必须读得到(否则这条测试是空的)');
  assert.strictEqual(usage.liveContext('proj', 'good').ctx, 100000);
  for (const bad of ['../../../../etc/passwd', 'a/b', 'x..y/z', '带空格 的', '..', 'a.b']) {
    let r, threw = false;
    try { r = usage.liveContext('proj', bad); } catch { threw = true; }
    assert.strictEqual(threw, false, 'sid=' + bad + ' 不许抛');
    assert.strictEqual(r, null, 'sid=' + bad + ' 必须是 null,而不是兜底到 other 那 26 万');
  }
});

test('liveContext:空 sid 的 60 秒兜底闸', (t) => {
  const base = useFixture();
  t.after(() => { restoreFixture(); try { fs.rmSync(base, { recursive: true, force: true }); } catch {} });
  settings({ autoCompactWindow: 300000 });
  sess('fresh', 'a', [asst(150000, 0, 0, '2026-11-10T09:00:00Z')]);                 // 刚写,算"在动"
  sess('stale', 'b', [asst(150000, 0, 0, '2026-11-10T09:00:00Z')], 5 * 60 * 1000);  // 5 分钟没动
  const f = usage.liveContext('fresh', '');
  assert.ok(f && f.ctx === 150000, '60 秒内动过的必须给数');
  assert.strictEqual(f.fallback, true, '走兜底分支要标出来');
  assert.strictEqual(usage.liveContext('stale', ''), null, '超过 60 秒没动的不许给数');
});

test('liveContext:slug 不许越出 ~/.claude/projects(拿一个真能读出数的外部目录来验)', () => {
  // 这条才是真正的穿越测试。以前那几条「通过」是因为穿越到的目录里恰好没有 .jsonl,
  // 换成一个确实放了合法转录的外部目录,没有校验的话就会被读出来。
  const P = require('../lib/paths.js');
  write('escape', [asst(123456, 0, 0, '2026-11-10T09:00:00Z')]);
  // 先证明这个目录本身是读得出数的,否则这条测试等于没测
  assert.ok(usage.sessionContext(ROOT, 'escape'), '外部目录本身必须读得出数,不然测试是空的');
  const rel = path.relative(P.CLAUDE_PROJECTS, ROOT);   // 形如 ..\..\..\Temp\ctxnow-xxxx
  assert.ok(rel.startsWith('..'), '构造出来的 slug 必须真的是往外跑的: ' + rel);
  assert.strictEqual(usage.liveContext(rel, 'escape'), null, '越界 slug 必须被挡住');
  assert.strictEqual(usage.liveContext(rel, ''), null, '越界 slug 走兜底分支也必须被挡住');
});

test('单行比倒读窗口还长时要放大窗口重读,不能直接认输', () => {
  // 真实场景:某一轮贴进来一大段日志/大图,assistant 那一行自己就超过 512KB。
  // 原来的实现会在这一轮里让顶栏读数凭空消失。
  const big = 'z'.repeat(900 * 1024);
  const line = JSON.stringify({
    type: 'assistant', timestamp: '2026-11-10T10:00:00Z',
    message: { model: 'claude-opus-5', padding: big,
      usage: { input_tokens: 11000, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0 } }
  });
  const fp = path.join(ROOT, 'huge.jsonl');
  fs.writeFileSync(fp, line + '\n', 'utf8');
  assert.ok(fs.statSync(fp).size > 512 * 1024, '这一行得真的超过 512KB');
  const r = usage.sessionContext(ROOT, 'huge');
  assert.ok(r, '放大窗口后必须读到,不许返回 null');
  assert.strictEqual(r.ctx, 13000);
});

// ⚠️ 口径警告(2026-11-10 被验收抓到):`compactMetadata.preTokens` **不是药丸读数**。
// 药丸读的是「压缩前最后一条 assistant 的 in+cache_read+cache_creation」,比 preTokens 低,
// 全量扫 205 份转录、77 次 trigger:"auto" 实测:中位低 0.360%,最大一次低 20.85%。
// 所以夹具必须喂**药丸口径**那个数,喂 preTokens 的测试会"一边绿着一边放过它要守的失败"。
// 下面每一对都是同一次压缩的 [preTokens, 药丸读数]。
const AC_300K = [            // settings 配 30 万(算出来 thr=287000)那天
  [267847, 266446], [292422, 291344], [278053, 277388], [271643, 269191],
  [264276, 251644], [268400, 265265], [267212, 264390], [256688, 255743], [213934, 213267],
];
const AC_1M = [              // 稳定 100 万那段(thr=987000)
  [1011598, 995010], [1007031, 993575], [1003890, 991560], [1001253, 990583],
  [1005203, 994900], [1002680, 993202], [1005954, 996589],
];

test('⭐ 没有实测校准时,红线只是估算 —— 这个缺口必须钉死,不许再说"保证压缩时已经红了"', (t) => {
  // 这条用例的作用是**不让这个缺口被遗忘**。它断言的是「现状确实会漏」,
  // 补救措施是下面那条实测校准的用例。
  // 根因:官方真实窗口 = min(模型自己的窗口, 配置值),而模型窗口是服务端下发的,客户端读不到。
  const base = useFixture();
  t.after(() => { restoreFixture(); try { fs.rmSync(base, { recursive: true, force: true }); } catch {} });
  settings({ autoCompactWindow: 300000 });
  const worst = AC_300K.reduce((a, b) => (b[1] < a[1] ? b : a));   // [264276, 251644]
  sess('nocal', 's', [asst(worst[1], 0, 0, '2026-11-10T09:00:00Z')]);
  const r = usage.liveContext('nocal', 's', 300000);
  assert.strictEqual(r.calib, 0, '这个会话没压过,所以没有校准值');
  assert.ok(r.redAt > worst[1],
    '已知缺口:估算红线 ' + r.redAt + ' 晚于实测压缩点 ' + worst[1] + ' —— 这一刻药丸还不是红的');
  assert.strictEqual(r.level, 'ok', '而且连橙都没到(读数 ' + worst[1] + ' < 收尾线 30 万)');
  // 但估算红线也不能定得太晚:对绝大多数压缩点还是要来得及
  const caught = AC_300K.filter(p => p[1] >= r.redAt).length;
  assert.ok(caught >= AC_300K.length - 3,
    '估算红线至少要盖住 ' + (AC_300K.length - 3) + '/' + AC_300K.length + ' 次,实得 ' + caught);
});

test('⭐ 实测校准:这个会话自己压过一次之后,分母和红线换成实测值', (t) => {
  const base = useFixture();
  t.after(() => { restoreFixture(); try { fs.rmSync(base, { recursive: true, force: true }); } catch {} });
  settings({ autoCompactWindow: 300000 });
  const [pre, pill] = [264276, 251644];   // 11-10 12:51 那次,他自己转录里的真实一对
  // 真实形状:...assistant(251644) → compact_boundary(auto, preTokens 264276) → assistant(26410) → ...
  sess('cal', 's', [
    // ⚠️ 照真实形状拆开:他紧贴 auto boundary 前那一行是 in=2 / cache_read=995787 /
    //    cache_creation=1647 —— **99.8% 的读数来自 cache_read**。夹具要是写成 asst(N,0,0),
    //    把公式 inT+cr+cw 改成 inT+cw 全套测试照样绿(第六轮验收 P2-4 实测存活)。
    asst(2, pill - 2 - 1647, 1647, '2026-11-10T12:48:54Z'),
    boundary('auto', pre, 26410, '2026-11-10T12:51:15Z'),
    asst(26410, 0, 0, '2026-11-10T12:52:00Z'),
    asst(240000, 0, 0, '2026-11-10T13:20:00Z'),
  ]);
  usage.sessionUsage(path.join(P.CLAUDE_PROJECTS, 'cal'), 's');   // 让账本解析一遍
  assert.strictEqual(usage.autoCompactPoint(path.join(P.CLAUDE_PROJECTS, 'cal'), 's'), pill,
    '记下来的必须是药丸口径(' + pill + '),不是 preTokens(' + pre + ')');
  const r = usage.liveContext('cal', 's', 300000);
  assert.strictEqual(r.calib, pill, '校准值要透出来给提示框用');
  assert.strictEqual(r.eff, pill, '分母换成实测压缩点,而不是算出来的 287000');
  assert.strictEqual(r.redAt, Math.round(pill * 0.95), '红线 = 实测点往前留 5%');
  assert.strictEqual(r.ctx, 240000, '当前读数仍然取最后一条 assistant');
  assert.strictEqual(r.level, 'hot', '24 万已经过了校准后的红线 ' + r.redAt + ',必须红');
  // 校准之后,那个"漏掉"的压缩点再来一次就抓得到了
  sess('cal2', 's', [
    asst(pill, 0, 0, '2026-11-10T12:48:54Z'),
    boundary('auto', pre, 26410, '2026-11-10T12:51:15Z'),
    asst(pill, 0, 0, '2026-11-10T13:40:00Z'),
  ]);
  usage.sessionUsage(path.join(P.CLAUDE_PROJECTS, 'cal2'), 's');
  assert.strictEqual(usage.liveContext('cal2', 's', 300000).level, 'hot',
    '同样的读数,校准过就必须是红的 —— 这才是对上一条缺口的补救');
});

test('一次性回填:已经解析完的老会话也要补上实测压缩点,而且不许动用量数字', (t, done) => {
  // 为什么必须有这条:parseNew 是增量的,只看新追加的字节。
  // 他机器上 222 个会话在加这段逻辑之前就全解析完了 —— 没有回填,校准功能是死的(实测 0/222)。
  const base = useFixture();
  settings({ autoCompactWindow: 300000 });
  const dir = path.join(P.CLAUDE_PROJECTS, 'bf');
  sess('bf', 'old', [
    asst(251644, 0, 0, '2026-11-10T12:48:54Z'),
    boundary('auto', 264276, 26410, '2026-11-10T12:51:15Z'),
    asst(240000, 0, 0, '2026-11-10T13:20:00Z'),
  ]);
  sess('bf', 'nocompact', [asst(100000, 0, 0, '2026-11-10T13:00:00Z')]);
  // 模拟「老账本」:已经解析完(size 对得上),但没有 ac 字段
  const st = fs.statSync(path.join(dir, 'old.jsonl'));
  const cachePath = P.USAGE_CACHE;
  fs.writeFileSync(cachePath, JSON.stringify({
    old: { size: st.size, in: 111, out: 222, cw: 333, cr: 444, h: { '2026-11-10T12': { 'opus-5': 9 } }, slug: 'bf' },
    nocompact: { size: 1, in: 1, out: 2, cw: 3, cr: 4, h: {}, slug: 'bf' }
  }), 'utf8');
  usage.backfillCompactPoints([dir], (found, total) => {
    try {
      assert.strictEqual(total, 2, '两个会话都该排进回填队列');
      assert.strictEqual(found, 1, '只有压过的那个有实测点');
      assert.strictEqual(usage.autoCompactPoint(dir, 'old'), 251644, '补上的必须是药丸口径');
      assert.strictEqual(usage.autoCompactPoint(dir, 'nocompact'), 0, '没压过的保持 0');
      const r = usage.liveContext('bf', 'old', 300000);
      assert.strictEqual(r.calib, 251644);
      assert.strictEqual(r.level, 'hot', '回填之后 24 万就该是红的了');
      // ⚠️ 回填绝不许碰用量数字 —— 那是顶栏 🔥 累计和明细的来源。
      // 必须查内存里那个 entry 对象:save() 有 800ms 防抖,这会儿去读盘读到的还是写进去的原值,
      // 回填把 in 改成 0 也看不出来(第一版就是这么漏过变异验证的)。
      const after = usage.sessionUsage(dir, 'old');
      assert.strictEqual(after.in, 111, 'in 不许变');
      assert.strictEqual(after.out, 222, 'out 不许变');
      assert.strictEqual(after.cw, 333, 'cw 不许变');
      assert.strictEqual(after.cr, 444, 'cr 不许变');
      assert.deepStrictEqual(after.h, { '2026-11-10T12': { 'opus-5': 9 } }, '小时分布不许变');
      // 只跑一次。故意塞一个刚进账本的新会话:新条目在 sessionUsage 里就带 ac:0,
      // 所以不该再被扫 —— 少了那个初始化,它就会进第二轮队列,t2 不会是 0。
      sess('bf', 'fresh', [asst(5000, 0, 0, '2026-11-10T14:00:00Z')]);
      usage.sessionUsage(dir, 'fresh');
      usage.backfillCompactPoints([dir], (f2, t2) => {
        try { assert.strictEqual(t2, 0, '第二次必须直接跳过,别再扫一遍几个 GB'); } catch (e) { return done(e); }
        restoreFixture(); try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
        done();
      });
    } catch (e) { restoreFixture(); done(e); }
  });
});

test('实测点会过期:窗口配大之后,旧的低压缩点必须自动作废,不能一直虚假报红', (t) => {
  // 真实场景:11-09 把 autoCompactWindow 配成 30 万,好几个会话在 26 万左右被压;
  // 11-10 改回 100 万,这些会话的真实上限变成 98.7 万。
  // 要是还按 26 万报红,就是纯噪音 —— 而噪音会让这颗药丸整个失去可信度。
  const base = useFixture();
  t.after(() => { restoreFixture(); try { fs.rmSync(base, { recursive: true, force: true }); } catch {} });
  settings({ autoCompactWindow: 1000000 });
  const dir = path.join(P.CLAUDE_PROJECTS, 'stale');
  sess('stale', 's', [
    asst(264390, 0, 0, '2026-11-09T20:00:00Z'),
    boundary('auto', 267212, 26000, '2026-11-09T20:01:00Z'),
    asst(400000, 0, 0, '2026-11-10T15:00:00Z'),      // 换成 100 万之后一路爬到 40 万都没压
  ]);
  usage.sessionUsage(dir, 's');
  assert.strictEqual(usage.autoCompactPoint(dir, 's'), 264390, '账本里确实记着那个旧点');
  const r = usage.liveContext('stale', 's', 0);
  assert.strictEqual(r.calib, 0, '读数 40 万 > 旧点 26.4 万 × 1.15,这个点必须作废');
  assert.strictEqual(r.eff, 987000, '作废后分母退回算出来的硬上限');
  assert.strictEqual(r.level, 'ok', '40 万离 100 万窗口的红线还远,不该报红');
  // 还没超出 1.15 倍的时候不许提前作废 —— 否则校准就白做了。
  // ⚠️ sid 必须和上面那份不同:账本是按 sid 建索引的,同名会把上一份的 size/ac 喂过来
  // (两份文件字节数恰好一样时 `st.size <= entry.size` 直接 return,第二份根本没被解析 —— 验收抓到)
  sess('fresh', 's2', [
    asst(264390, 0, 0, '2026-11-09T20:00:00Z'),
    boundary('auto', 267212, 26000, '2026-11-09T20:01:00Z'),
    asst(280000, 0, 0, '2026-11-10T15:00:00Z'),      // 26.4万 × 1.15 = 304049,还没到
  ]);
  usage.sessionUsage(path.join(P.CLAUDE_PROJECTS, 'fresh'), 's2');
  const r2 = usage.liveContext('fresh', 's2', 0);
  assert.strictEqual(r2.calib, 264390, '没超过 1.15 倍就还得当真');
  assert.strictEqual(r2.level, 'hot', '28 万已经过了校准红线 ' + r2.redAt);
});

test('手动 /compact 不许当成校准值(preTokens 可以是任意小的数)', (t) => {
  const base = useFixture();
  t.after(() => { restoreFixture(); try { fs.rmSync(base, { recursive: true, force: true }); } catch {} });
  settings({ autoCompactWindow: 1000000 });
  // ⚠️ 当前读数必须贴近那个手动压缩点,否则作废规则(ctx > calib×1.15)会先把它干掉,
  // 这条用例就测不到"手动点被当成校准值"这个错误了 —— 第一版写成 30 万,变异验证直接漏过。
  sess('man', 's', [
    asst(50000, 0, 0, '2026-11-10T09:00:00Z'),
    boundary('manual', 52000, 9000, '2026-11-10T09:01:00Z'),
    asst(52000, 0, 0, '2026-11-10T10:00:00Z'),
  ]);
  usage.sessionUsage(path.join(P.CLAUDE_PROJECTS, 'man'), 's');
  const r = usage.liveContext('man', 's', 0);
  assert.strictEqual(r.calib, 0, '手动压缩不是阈值证据,不许拿来当分母');
  assert.strictEqual(r.eff, 987000, '分母仍然是算出来的硬上限');
  assert.strictEqual(r.level, 'ok', '5.2 万远没到 100 万窗口的红线(要是认了手动点,这里会是红)');
});

test('回填只跑一次:已经有 ac 字段的条目一个都不许再扫', (t) => {
  // 他机器上 186 份转录扫一遍 6GB 要一分多钟,每次启动都扫等于白烧磁盘
  const base = useFixture();
  t.after(() => { restoreFixture(); try { fs.rmSync(base, { recursive: true, force: true }); } catch {} });
  const dir = path.join(P.CLAUDE_PROJECTS, 'once');
  sess('once', 'a', [asst(1000, 0, 0, '2026-11-10T09:00:00Z')]);
  sess('once', 'b', [asst(2000, 0, 0, '2026-11-10T09:00:00Z')]);
  fs.writeFileSync(P.USAGE_CACHE, JSON.stringify({
    a: { size: 1, in: 1, out: 1, cw: 1, cr: 1, h: {}, slug: 'once', ac: 0 },      // 扫过了(没测到)
    b: { size: 1, in: 1, out: 1, cw: 1, cr: 1, h: {}, slug: 'once', ac: 123456 }  // 扫过了(测到了)
  }), 'utf8');
  let got = null;
  usage.backfillCompactPoints([dir], (found, total) => { got = { found, total }; });
  assert.deepStrictEqual(got, { found: 0, total: 0 }, '必须同步直接返回 0/0,一个文件都不碰');
});

test('⭐ 同一个会话目录被多个项目共用时,绝不许重复读一遍', (t) => {
  // 真实数据:会话目录名把路径里非 [A-Za-z0-9-] 的字符全换成 '-',中文一字一杠,
  // 所以他 49 个项目只对应 37 个目录,最狠的一个 slug 被 8 个项目共用。
  // 不去重的话队列从 186 涨到 924,首次启动多读 9.57GB、多花 70 秒(验收 P1-2 实测)。
  const base = useFixture();
  t.after(() => { restoreFixture(); try { fs.rmSync(base, { recursive: true, force: true }); } catch {} });
  const dir = path.join(P.CLAUDE_PROJECTS, 'dup');
  sess('dup', 'one', [
    asst(100000, 0, 0, '2026-11-10T09:00:00Z'),
    boundary('auto', 101000, 9000, '2026-11-10T09:01:00Z'),
  ]);
  const st = fs.statSync(path.join(dir, 'one.jsonl'));
  fs.writeFileSync(P.USAGE_CACHE, JSON.stringify({
    one: { size: st.size, in: 5, out: 6, cw: 7, cr: 8, h: {}, slug: 'dup' }
  }), 'utf8');
  let got = null;
  usage.backfillCompactPoints([dir, dir, path.join(P.CLAUDE_PROJECTS, 'dup', '..', 'dup'), dir], (f, tt) => { got = { f: f, t: tt }; });
  // 同步断言不了(回填是异步分步的),放到下一拍
  return new Promise((res, rej) => setTimeout(() => {
    try {
      assert.ok(got, '回调必须到达');
      assert.strictEqual(got.t, 1, '四个写法都是同一个目录,队列里只能有 1 份');
      assert.strictEqual(got.f, 1, '实测点只该被记一次');
      assert.strictEqual(usage.autoCompactPoint(dir, 'one'), 100000);
      res();
    } catch (e) { rej(e); }
  }, 120));
});

test('⭐ 同一个 sid 从两个路径进了队列,也只许读一次', (t) => {
  // 去重按 path.resolve 比,挡不住 junction / 符号链接 ——
  // 两个不同写法指向同一份转录时,靠的是「这个条目已经有 ac 了就跳过」这道闸。
  const base = useFixture();
  t.after(() => { restoreFixture(); try { fs.rmSync(base, { recursive: true, force: true }); } catch {} });
  const lines = [
    asst(100000, 0, 0, '2026-11-10T09:00:00Z'),
    boundary('auto', 101000, 9000, '2026-11-10T09:01:00Z'),
  ];
  sess('ln1', 's', lines);
  sess('ln2', 's', lines);           // 同一个 sid,两个目录(模拟同一份转录的两个路径)
  const d1 = path.join(P.CLAUDE_PROJECTS, 'ln1'), d2 = path.join(P.CLAUDE_PROJECTS, 'ln2');
  const st = fs.statSync(path.join(d1, 's.jsonl'));
  fs.writeFileSync(P.USAGE_CACHE, JSON.stringify({
    s: { size: st.size, in: 9, out: 9, cw: 9, cr: 9, h: {}, slug: 'ln1' }
  }), 'utf8');
  return new Promise((res, rej) => {
    usage.backfillCompactPoints([d1, d2], (found, total) => {
      try {
        assert.strictEqual(total, 2, '两个目录各排一份');
        assert.strictEqual(found, 1, '第二份必须被跳过 —— 同一个会话不许读两遍');
        res();
      } catch (e) { rej(e); }
    });
  });
});

test('⭐ 压缩点前一轮 usage 全是 0 时,实测点不许丢(真实数据里 77 次压缩丢 4 次)', (t) => {
  // 他真实转录里有 354 行 assistant 的 usage 全是 0,其中 4 行恰好紧贴在 compact_boundary 前面。
  // parseNew 当时无条件写 lastCtx,0 一写进去 `lastCtx > 0` 就不成立,整条实测点丢掉。
  // 丢掉的 3 个都在 99.5 万那一档 —— 正是他现在这套配置的区间。
  // 而回填是一次性的,以后的实测点只能靠 parseNew 拿,这个洞恰好开在唯一的长期通道上。
  const base = useFixture();
  t.after(() => { restoreFixture(); try { fs.rmSync(base, { recursive: true, force: true }); } catch {} });
  settings({ autoCompactWindow: 1000000 });
  const dir = path.join(P.CLAUDE_PROJECTS, 'zero');
  sess('zero', 's', [
    asst(999085, 0, 0, '2026-11-10T15:00:00Z'),
    asst(0, 0, 0, '2026-11-10T15:00:30Z'),                    // usage 全 0 的那一轮
    boundary('auto', 1007323, 30000, '2026-11-10T15:01:00Z'),
    asst(950000, 0, 0, '2026-11-10T15:30:00Z'),
  ]);
  usage.sessionUsage(dir, 's');
  assert.strictEqual(usage.autoCompactPoint(dir, 's'), 999085, '要取 0 之前那一轮的读数,不能被 0 冲掉');
  const r = usage.liveContext('zero', 's', 0);
  assert.strictEqual(r.calib, 999085);
  assert.strictEqual(r.level, 'hot', '95 万已经过了校准红线 ' + r.redAt);
});

test('⭐ parseNew 和回填对同一份字节必须得出同一个实测点', (t) => {
  // 同一个语义写了两遍(增量解析一份、流式回填一份),口径一漂移就是静默丢数据。
  // 这条交叉断言能钉死整类漂移,不用一个个猜。
  const base = useFixture();
  t.after(() => { restoreFixture(); try { fs.rmSync(base, { recursive: true, force: true }); } catch {} });
  const lines = [
    asst(500000, 0, 0, '2026-11-10T10:00:00Z'),
    asst(0, 0, 0, '2026-11-10T10:00:10Z'),
    boundary('manual', 9, 9, '2026-11-10T10:00:20Z'),
    asst(3, 624193 - 3 - 2048, 2048, '2026-11-10T10:01:00Z'),   // 同上:cache_read 占大头才是真形状
    asst(0, 0, 0, '2026-11-10T10:01:10Z'),
    boundary('auto', 754349, 60000, '2026-11-10T10:02:00Z'),
    asst(300000, 0, 0, '2026-11-10T10:30:00Z'),
  ];
  sess('x1', 'a', lines);
  sess('x2', 'b', lines);
  const d1 = path.join(P.CLAUDE_PROJECTS, 'x1'), d2 = path.join(P.CLAUDE_PROJECTS, 'x2');
  usage.sessionUsage(d1, 'a');                       // 走 parseNew
  const byParse = usage.autoCompactPoint(d1, 'a');
  // 走回填:造一个「已经解析到 EOF、但没有 ac 字段」的老条目。
  // ⚠️ 不能靠写账本文件来注入 —— 路径没变时模块用的是内存里那份,写盘根本不会被读回来。
  // 直接改 sessionUsage 返回的那个 entry 对象(它就是内存里的条目)。
  const e2 = usage.sessionUsage(d2, 'b');
  delete e2.ac; e2.acPre = 0; e2.lastCtx = 0;
  return new Promise((res, rej) => {
    usage.backfillCompactPoints([d2], () => {
      try {
        const byBackfill = usage.autoCompactPoint(d2, 'b');
        assert.strictEqual(byParse, 624193, 'parseNew:取 auto 压缩前最近一个非 0 读数');
        assert.strictEqual(byBackfill, byParse, '两条通道必须一个数');
        res();
      } catch (e) { rej(e); }
    });
  });
});

test('⭐ 实测点比硬上限还高一截时必须作废:窗口被改小之后,该红的时候一定要红', (t) => {
  // 数字全部取自他自己的转录:同一个会话 11-10 06:31 压在 608177;
  // 把窗口改成 30 万之后,官方实测 287745 就会压。
  // 只有「读数超过实测点 1.15 倍」这一条作废判据的话,读数永远到不了 608177×1.15,
  // 这个过大的实测点永不作废 → 药丸显示 47% 全绿,然后被压。
  const base = useFixture();
  t.after(() => { restoreFixture(); try { fs.rmSync(base, { recursive: true, force: true }); } catch {} });
  settings({ autoCompactWindow: 300000 });
  const dir = path.join(P.CLAUDE_PROJECTS, 'shrink');
  sess('shrink', 's', [
    asst(608177, 0, 0, '2026-11-10T06:30:00Z'),
    boundary('auto', 609654, 60000, '2026-11-10T06:31:32Z'),
    asst(287745, 0, 0, '2026-11-10T16:00:00Z'),
  ]);
  usage.sessionUsage(dir, 's');
  assert.strictEqual(usage.autoCompactPoint(dir, 's'), 608177, '账本里确实记着那个过大的点');
  const r = usage.liveContext('shrink', 's', 0);
  assert.strictEqual(r.calib, 0, '实测点 60.8 万 > 硬上限 28.7 万 × 1.15,必须作废');
  assert.strictEqual(r.eff, 287000, '分母退回算出来的硬上限');
  assert.strictEqual(r.level, 'hot', '28.7 万必须是红的 —— 官方就是在这个数上压的');
});

test('⭐ 压缩前一刻绝不许从红翻成灰(100 万窗口下会真实踩到)', (t) => {
  // 100 万窗口的硬上限是 987000,而实测药丸读到 99.5 万 / 99.6 万时官方就压了 —— 都超过硬上限。
  // 上一版判据是 pct>100 就"阈值待定"(灰、不报警),
  // 等于在最危险的那一刻把警报关掉。这条是这个功能的生死线。
  const base = useFixture();
  t.after(() => { restoreFixture(); try { fs.rmSync(base, { recursive: true, force: true }); } catch {} });
  settings({ autoCompactWindow: 1000000 });
  let n = 0, over = 0;
  for (const [, pill] of AC_1M) {
    const slug = 'oneM' + (n++);
    sess(slug, 's', [asst(pill, 0, 0, '2026-11-10T09:00:00Z')]);
    const r = usage.liveContext(slug, 's', 300000);
    if (r.pct > 100) over++;
    assert.strictEqual(r.level, 'hot',
      '实测压在药丸读数 ' + pill + '(' + r.pct + '%)时档位必须还是红,实得 ' + r.level);
  }
  assert.ok(over >= 5, '这批点里至少 5 个确实超过硬上限,用例才有意义,实得 ' + over);
  // 大幅超出才算分母算错
  sess('way', 's', [asst(2000000, 0, 0, '2026-11-10T09:00:00Z')]);
  const w = usage.liveContext('way', 's', 0);
  assert.strictEqual(w.level, 'unk', '200 万(203%)才该判"阈值待定"');
  assert.strictEqual(w.thrUnknown, true);
});

test('⭐ 分母算不准时,绝不许把三月自己的收尾线一起关掉', (t) => {
  // 2026-11-10 被验收抓到:第一版把 unk 判在 warn 前面,
  // 结果「阈值算不准」把用户自己定的那条线也一起静默了。
  // 实证:他 11-10 有个会话整段跑在 thr 的 193%(读数 553256),收尾线全程是死的。
  const base = useFixture();
  t.after(() => { restoreFixture(); try { fs.rmSync(base, { recursive: true, force: true }); } catch {} });
  settings({ autoCompactWindow: 300000 });
  sess('unkw', 's', [asst(553256, 0, 0, '2026-11-10T11:33:00Z')]);
  const r = usage.liveContext('unkw', 's', 300000);
  assert.ok(r.pct > 115, '这个读数确实大幅超出分母(' + r.pct + '%),用例才有意义');
  assert.strictEqual(r.thrUnknown, true, '分母要标成不可信');
  assert.strictEqual(r.level, 'warn', '但收尾线是绝对 token 数,必须照样报橙,实得 ' + r.level);
  // 没过收尾线的才是灰
  sess('unkg', 's', [asst(553256, 0, 0, '2026-11-10T11:33:00Z')]);
  assert.strictEqual(usage.liveContext('unkg', 's', 0).level, 'unk', '没设收尾线时才只报数');
});

test('收尾提醒线独立于官方压缩线(100 万窗口下也要按 30 万提醒)', (t) => {
  const base = useFixture();
  t.after(() => { restoreFixture(); try { fs.rmSync(base, { recursive: true, force: true }); } catch {} });
  settings({ autoCompactWindow: 1000000 });   // 官方红线会在 88.8 万,太晚了
  sess('rm', 's', [asst(310000, 0, 0, '2026-11-10T09:00:00Z')]);
  const over = usage.liveContext('rm', 's', 300000);
  assert.strictEqual(over.level, 'warn', '31 万 > 收尾线 30 万,必须变橙');
  assert.ok(over.pct < 40, '此时离官方压缩还很远(' + over.pct + '%),橙完全靠收尾线触发');
  assert.strictEqual(over.remindAt, 300000);

  sess('rm2', 's', [asst(290000, 0, 0, '2026-11-10T09:00:00Z')]);
  assert.strictEqual(usage.liveContext('rm2', 's', 300000).level, 'ok', '29 万 < 收尾线,不该橙');
  // 关掉收尾线:只剩官方红线
  assert.strictEqual(usage.liveContext('rm', 's', 0).level, 'ok', '收尾线关掉后 31 万不该报任何警');
  // 红线优先于收尾线
  sess('rm3', 's', [asst(900000, 0, 0, '2026-11-10T09:00:00Z')]);
  assert.strictEqual(usage.liveContext('rm3', 's', 300000).level, 'hot', '压缩逼近时要红,不是橙');
});

test('ctxLevel 的边界:恰好等于线算不算', () => {
  const mk = (ctx, pct, redAt) => ({ ctx, pct, redAt, thr: 987000 });
  assert.strictEqual(usage.ctxLevel(mk(888300, 90, 888300), 300000), 'hot', '恰好等于红线就算红');
  assert.strictEqual(usage.ctxLevel(mk(888299, 90, 888300), 300000), 'warn', '差 1 就不算红');
  assert.strictEqual(usage.ctxLevel(mk(300000, 30, 888300), 300000), 'warn', '恰好等于收尾线就算橙');
  assert.strictEqual(usage.ctxLevel(mk(299999, 30, 888300), 300000), 'ok', '差 1 就不算橙');
  assert.strictEqual(usage.ctxLevel(mk(1, 115, 888300), 0), 'ok', '恰好 115% 还不算阈值待定');
  assert.strictEqual(usage.ctxLevel(mk(1, 116, 888300), 0), 'unk', '116% 才算');
  assert.strictEqual(usage.ctxLevel(null, 300000), 'ok', 'null 不许抛');
  assert.strictEqual(usage.ctxLevel({ ctx: 0 }, 300000), 'ok', '没读到数不许报警');
  // 字段坏掉时缺省必须是「报警」,不是「正常」
  assert.strictEqual(usage.ctxLevel({ ctx: 9999999, pct: 50 }, 0), 'unk', '没有 redAt 就不许说正常');
  assert.strictEqual(usage.ctxLevel(mk(9999999, 50, 0), 0), 'unk', 'redAt=0 同理');
  assert.strictEqual(usage.ctxLevel(mk(9999999, NaN, 888300), 0), 'unk', 'pct 是 NaN 同理');
  assert.strictEqual(usage.ctxLevel(mk(9999999, 50, 0), 300000), 'warn', 'redAt 坏了也不许吃掉收尾线');
  // 收尾线比红线还大的组合(窗口配小 + 收尾线选 80 万):红必须压过橙
  assert.strictEqual(usage.ctxLevel(mk(900000, 99, 888300), 800000), 'hot', '红优先于橙');
});

test('compactWindow:按版本号的键不许前缀命中到另一个模型(实测复现过的错配)', (t) => {
  const base = useFixture();
  t.after(() => { restoreFixture(); try { fs.rmSync(base, { recursive: true, force: true }); } catch {} });

  settings({ autoCompactWindow: 300000, modelSettings: { 'claude-opus-5': { autoCompactWindow: 150000 } } });
  assert.strictEqual(usage.compactWindow('claude-opus-5'), 150000, '精确命中要生效');
  assert.strictEqual(usage.compactWindow('claude-opus-5-5'), 300000,
    'opus-5 和 opus-5-5 是两个模型,不许把 opus-5 的 15 万套到 opus-5-5 上');

  settings({ autoCompactWindow: 300000, modelSettings: { opus: { autoCompactWindow: 200000 } } });
  assert.strictEqual(usage.compactWindow('claude-opus-5-5'), 200000, '不带数字的族别名应该命中');
  assert.strictEqual(usage.compactWindow('claude-sonnet-5-5'), 300000, '别名不该命中别的族');
  for (const m of ['o', 'u', 'opusopus', '']) {
    assert.strictEqual(usage.compactWindow(m), 300000, 'model=' + JSON.stringify(m) + ' 不该命中 opus 的配置');
  }

  // 越界值要夹到边界,不能当"没配"然后退到默认 100 万(那是往大了差 20 倍,比往小了差危险)
  settings({ autoCompactWindow: 50000 });
  assert.strictEqual(usage.compactWindow(), 100000, '低于下限夹到 10 万,不是退回 100 万');
  settings({ autoCompactWindow: 5000000 });
  assert.strictEqual(usage.compactWindow(), 1000000, '高于上限夹到 100 万');
  // "auto" 和坏输入 → 官方默认 100 万,且不抛
  for (const v of ['auto', null, true, {}, '300000']) {
    settings({ autoCompactWindow: v });
    assert.strictEqual(usage.compactWindow(), 1000000, 'autoCompactWindow=' + JSON.stringify(v) + ' 应退到默认');
  }
  fs.writeFileSync(P.CLAUDE_SETTINGS, '{坏 JSON', 'utf8');
  assert.strictEqual(usage.compactWindow(), 1000000, '坏 JSON 不许抛');
});

test('超长行后面还跟着完整行时,照样要放大窗口(这是最常见的情形)', () => {
  // 第一版的 sawLine 判据是"有没有完整行",而超长 assistant 行后面几乎总跟着 tool_result,
  // 于是 complete>0 成立、直接认输 —— 那个兜底在真实场景下等于没做。
  const big = 'z'.repeat(900 * 1024);
  const line = JSON.stringify({
    type: 'assistant', timestamp: '2026-11-10T10:00:00Z',
    message: { model: 'claude-opus-5', padding: big,
      usage: { input_tokens: 29000, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0 } }
  });
  write('hugemid', [userLine('前面一行'), line, userLine('后面还有完整行'), userLine('再一行')]);
  const r = usage.sessionContext(ROOT, 'hugemid');
  assert.ok(r, '超长行后面有完整行时也必须读到,不许认输');
  assert.strictEqual(r.ctx, 31000);
});

// ───── 第三轮验收点出来的测试缺口:这几件事本来改坏了都不会红 ─────

test('uniqDirs:大小写 / 尾斜杠 / .. 折叠 都算同一个目录', () => {
  // 原来「四个写法」那条用例其实是虚的:path.join 会当场把 .. 折叠掉,
  // 四个参数在进函数之前就已经是同一个字符串了,path.resolve + 小写那段根本没走到(验收抓到)。
  const win = (p) => p.split('/').join(String.fromCharCode(92));   // 用真正的反斜杠,别让测试绕开 win32 语义
  assert.strictEqual(usage.uniqDirs([win('F:/a/b'), win('f:/a/b'), win('F:/a/b/'), win('F:/a/x/../b')]).length, 1);
  assert.strictEqual(usage.uniqDirs([win('F:/a/b'), win('F:/a/c')]).length, 2);
  assert.deepStrictEqual(usage.uniqDirs([]), []);
  assert.deepStrictEqual(usage.uniqDirs(null), []);
  assert.strictEqual(usage.uniqDirs([win('F:/a/b')])[0], win('F:/a/b'), '留下的必须是原始写法,别把路径改了');
});

test('warmup 也必须去重:同一个目录传三遍,不许把活干三遍', (t) => {
  // 启动时读 6GB 的是 warmup,去重一掉就是白烧 70 秒 ——
  // 而且悄无声息。原来这个函数一条用例都没有(验收抓到)。
  const base = useFixture();
  t.after(() => { restoreFixture(); try { fs.rmSync(base, { recursive: true, force: true }); } catch {} });
  const dir = path.join(P.CLAUDE_PROJECTS, 'w');
  sess('w', 'a', [asst(1000, 0, 0, '2026-11-10T09:00:00Z')]);
  sess('w', 'b', [asst(2000, 0, 0, '2026-11-10T09:00:00Z')]);
  assert.strictEqual(usage.warmup([dir, dir, dir]), 2, '两个文件就是两份活,不是六份');
});

test('回填中途必须落盘:跑一半被强杀也不许全白跑', (t, done) => {
  // 他的账本第一次回填要扫 180 多个会话、一分多钟。中途不落盘的话,
  // 这一分钟里关掉 App 就等于全白跑 —— 而且下次启动照样再扫一遍。
  // 落盘次数直接数 rename(原子写就这一步),比看时间戳稳。
  const base = useFixture();
  const dir = path.join(P.CLAUDE_PROJECTS, 'flush');
  const cur = {};
  for (let i = 0; i < 26; i++) {
    const sid = 's' + i;
    sess('flush', sid, [
      asst(100000 + i, 0, 0, '2026-11-10T09:00:00Z'),
      boundary('auto', 101000 + i, 9000, '2026-11-10T09:01:00Z'),
    ]);
    cur[sid] = { size: fs.statSync(path.join(dir, sid + '.jsonl')).size, in: 1, out: 1, cw: 1, cr: 1, h: {}, slug: 'flush' };
  }
  const cachePath = P.USAGE_CACHE;
  fs.writeFileSync(cachePath, JSON.stringify(cur), 'utf8');
  const realRename = fs.renameSync;
  let renames = 0;
  fs.renameSync = function (a, b) { if (String(b) === cachePath) renames++; return realRename.apply(fs, arguments); };
  usage.backfillCompactPoints([dir], () => {
    const n = renames;
    fs.renameSync = realRename;
    try {
      assert.ok(n >= 2, '26 个会话至少该落盘两次(中途一次 + 收尾一次),实际 ' + n);
      const onDisk = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      const withAc = Object.keys(onDisk).filter(k => onDisk[k] && onDisk[k].ac > 0).length;
      assert.strictEqual(withAc, 26, '收尾那次必须把全部实测点写进盘里');
      restoreFixture(); try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
      done();
    } catch (e) { restoreFixture(); done(e); }
  });
});

test('回填不许漏掉第二次才出现的新目录(这是去掉全局标记的唯一理由)', (t, done) => {
  const base = useFixture();
  const dA = path.join(P.CLAUDE_PROJECTS, 'A'), dB = path.join(P.CLAUDE_PROJECTS, 'B');
  sess('A', 'a', [asst(100000, 0, 0, '2026-11-10T09:00:00Z'), boundary('auto', 101000, 9000, '2026-11-10T09:01:00Z')]);
  sess('B', 'b', [asst(200000, 0, 0, '2026-11-10T09:00:00Z'), boundary('auto', 201000, 9000, '2026-11-10T09:01:00Z')]);
  const mk = (slug, sid) => ({ size: fs.statSync(path.join(P.CLAUDE_PROJECTS, slug, sid + '.jsonl')).size, in: 1, out: 1, cw: 1, cr: 1, h: {}, slug: slug });
  fs.writeFileSync(P.USAGE_CACHE, JSON.stringify({ a: mk('A', 'a'), b: mk('B', 'b') }), 'utf8');
  usage.backfillCompactPoints([dA], (f1) => {
    try {
      assert.strictEqual(f1, 1, '第一轮只给了 A');
      assert.strictEqual(usage.autoCompactPoint(dB, 'b'), 0, 'B 这会儿还没被扫');
    } catch (e) { restoreFixture(); return done(e); }
    // 第二轮把 B 也带上(项目被移出又加回来、或者当时目录不存在)
    usage.backfillCompactPoints([dA, dB], (f2) => {
      try {
        assert.strictEqual(f2, 1, 'B 必须被扫到 —— 全局标记那版会永久漏掉它');
        assert.strictEqual(usage.autoCompactPoint(dB, 'b'), 200000);
        restoreFixture(); try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
        done();
      } catch (e) { restoreFixture(); done(e); }
    });
  });
});

test('回填不许把 parseNew 刚记下的实测点覆盖回 0', (t, done) => {
  // 那 80 秒里会话正好被压的话,parseNew 会记下新点;而它只看新追加的字节,
  // 那条 boundary 已经被消费过 —— 回填一覆盖就是永久丢失。
  const base = useFixture();
  const dir = path.join(P.CLAUDE_PROJECTS, 'race');
  sess('race', 's', [asst(500000, 0, 0, '2026-11-10T09:00:00Z')]);     // 文件里没有 boundary
  const e = usage.sessionUsage(dir, 's');
  delete e.ac;                 // 模拟老条目:解析到 EOF 了但没有 ac 字段
  e.ac = undefined;
  // 模拟「回填排好队之后,parseNew 抢先记上了一个点」
  usage.backfillCompactPoints([dir], () => {
    try {
      assert.strictEqual(usage.autoCompactPoint(dir, 's'), 777777, '已经有的实测点不许被扫出来的 0 覆盖');
      restoreFixture(); try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
      done();
    } catch (err) { restoreFixture(); done(err); }
  });
  e.ac = 777777;               // 队列已建好、文件还在读的时候插进来
});

test('读失败的会话不许记成「扫过了没压过」,下次还得再扫', (t, done) => {
  // 把 s.jsonl 做成一个目录 —— readdir 照样把它当会话排进队列,
  // 但 createReadStream 打开目录必然报错。这时候要是把 ac 写成 0,这个会话就永久不再被扫了。
  const base = useFixture();
  const dir = path.join(P.CLAUDE_PROJECTS, 'bad');
  sess('bad', 'ok', [asst(100000, 0, 0, '2026-11-10T09:00:00Z'), boundary('auto', 101000, 9000, '2026-11-10T09:01:00Z')]);
  fs.mkdirSync(path.join(dir, 'broken.jsonl'));   // 名字对得上、但根本读不了
  const okSize = fs.statSync(path.join(dir, 'ok.jsonl')).size;
  fs.writeFileSync(P.USAGE_CACHE, JSON.stringify({
    ok: { size: okSize, in: 1, out: 1, cw: 1, cr: 1, h: {}, slug: 'bad' },
    broken: { size: 0, in: 2, out: 2, cw: 2, cr: 2, h: {}, slug: 'bad' },
  }), 'utf8');
  usage.backfillCompactPoints([dir], (f1, t1) => {
    try {
      assert.strictEqual(t1, 2, '两个条目都该排进队列');
      assert.strictEqual(f1, 1, '只有能读的那个测出了实测点');
      const okE = usage.sessionUsage(dir, 'ok');
      assert.strictEqual(okE.ac, 100000, '好的那个照常写上');
      const badE = usage.sessionUsage(dir, 'broken');
      assert.strictEqual(typeof badE.ac, 'undefined', '读失败的不许落下 ac 字段(落了就等于记成「没压过」)');
      assert.strictEqual(badE.in, 2, '读失败也不许动它的用量数字');
    } catch (e) { restoreFixture(); return done(e); }
    // 第二轮:好的那个该被跳过,坏的那个必须还在队列里
    usage.backfillCompactPoints([dir], (f2, t2) => {
      try {
        assert.strictEqual(t2, 1, '读失败的会话下次必须再排一次队(实际 ' + t2 + ')');
        assert.strictEqual(f2, 0);
        restoreFixture(); try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
        done();
      } catch (e) { restoreFixture(); done(e); }
    });
  });
});

// ───── 第四轮验收点出来的缺口:这 7 件事改坏了,原来 35 条测试一条都不会红 ─────

test('⭐ liveContext 必须先把账本喂新:实测点不许冻在启动那一刻', (t, done) => {
  // 验收实测:ac 只有「切项目」和启动 warmup 会更新。他开着客户端在一个项目里干一整天,
  // 期间会话压了好几次,药丸用的还是早上那个点 —— 删掉这一句喂新,35 条测试全绿。
  const base = useFixture();
  settings({ autoCompactWindow: 1000000 });
  const dir = path.join(P.CLAUDE_PROJECTS, 'feed');
  sess('feed', 's', [asst(300000, 0, 0, '2026-11-10T09:00:00Z')]);
  usage.warmup([dir], () => {
    try {
      assert.strictEqual(usage.autoCompactPoint(dir, 's'), 0, '这会儿还没压过');
      // 会话接着跑并压了一次 —— 转录追加了,但没有任何人再去调 sessionUsage
      fs.appendFileSync(path.join(dir, 's.jsonl'), [
        asst(620000, 0, 0, '2026-11-10T09:30:00Z'),
        boundary('auto', 625000, 9000, '2026-11-10T09:31:00Z'),
        asst(9000, 0, 0, '2026-11-10T09:32:00Z'),
      ].join('\n') + '\n', 'utf8');
      const r = usage.liveContext('feed', 's');
      assert.ok(r, '必须读得到');
      assert.strictEqual(r.calib, 620000, 'liveContext 不喂账本的话实测点永远是 0,分母一整天都是错的');
      assert.strictEqual(r.eff, 620000, '分母要跟着换成实测值');
      restoreFixture(); try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
      done();
    } catch (e) { restoreFixture(); done(e); }
  });
});

test('⭐ 8MB 闸关上之后必须有人来开,否则这个会话从此永久停更', (t, done) => {
  // delta 是「累计未解析字节」,跳过并不推进 entry.size,下一拍只会更大 → 永久跳过。
  // 他一个会话一天写 85MB(约 34MB/小时),这道闸几小时内必被某一拍跨过;
  // 而 warmup 只在启动后 3 秒跑一次,全程没有第二次兜底。
  const base = useFixture();
  settings({ autoCompactWindow: 1000000 });
  const dir = path.join(P.CLAUDE_PROJECTS, 'big');
  sess('big', 's', [asst(100000, 0, 0, '2026-11-10T09:00:00Z')]);
  const fp = path.join(dir, 's.jsonl');
  usage.sessionUsage(dir, 's');                       // 先把 size 推到当前
  const pad = new Array(2001).join('x');              // 2000 字节
  let chunk = '';
  for (let i = 0; i < 4300; i++) chunk += '{"pad":"' + pad + '"}\n';   // ≈ 8.7MB
  chunk += asst(640000, 0, 0, '2026-11-10T09:30:00Z') + '\n' + boundary('auto', 645000, 9000, '2026-11-10T09:31:00Z') + '\n';
  fs.appendFileSync(fp, chunk, 'utf8');
  try {
    const e0 = usage.sessionUsage(dir, 's', true);    // light 这一拍:超闸,不解析,但要安排兜底
    assert.ok(fs.statSync(fp).size - e0.size > 8 * 1024 * 1024, '夹具得真的超过 8MB 闸');
    assert.ok(!e0.ac, 'light 这一拍本来就不该当场解析');
  } catch (e) { restoreFixture(); return done(e); }
  setTimeout(() => {
    try {
      assert.strictEqual(usage.sessionUsage(dir, 's', true).ac, 640000, '延后一拍的兜底必须把它追上');
      restoreFixture(); try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
      done();
    } catch (e) { restoreFixture(); done(e); }
  }, 60);
});

test('⭐ 账本读不出来时,绝不许把它覆盖成空的(222 个会话的累计就这一份,没有备份)', (t, done) => {
  // 原来 load() 是 `catch { cache = {} }` —— 占用/坏块/半截文件一律当成「还没有账本」,
  // 下一次 save 就把 {} 原子地写回去。规矩:先另存 .bad-*,存不下来就锁死写入。
  const base = useFixture();
  const dir = path.join(P.CLAUDE_PROJECTS, 'keep');
  sess('keep', 's', [asst(100000, 0, 0, '2026-11-10T09:00:00Z')]);
  const good = {};
  for (let i = 0; i < 222; i++) good['old' + i] = { size: 1, in: 11, out: 1, cw: 1, cr: 1, h: {}, slug: 'keep', ac: 0 };
  const full = JSON.stringify(good);
  const broken = full.slice(0, full.length - 60);     // 半截 JSON:读得出字节,parse 不过
  fs.writeFileSync(P.USAGE_CACHE, broken, 'utf8');
  usage.sessionUsage(dir, 's');                        // 触发 load
  usage.backfillCompactPoints([dir], () => {           // 空队列 → 立刻 saveNow
    try {
      const dirOf = path.dirname(P.USAGE_CACHE);
      const bad = fs.readdirSync(dirOf).filter(f => f.indexOf('usage-cache.json.bad-') === 0);
      assert.strictEqual(bad.length, 1, '坏账本必须被整份另存一份证据(实际 ' + bad.length + ' 份)');
      assert.strictEqual(fs.readFileSync(path.join(dirOf, bad[0]), 'utf8'), broken, '证据副本必须是原封不动的那些字节');
    } catch (e) { restoreFixture(); return done(e); }
    restoreFixture(); try { fs.rmSync(base, { recursive: true, force: true }); } catch {}

    // 第二段:连证据副本都存不下来(文件被独占)→ 一个字节都不许写
    const base2 = useFixture();
    const dir2 = path.join(P.CLAUDE_PROJECTS, 'keep2');
    sess('keep2', 's', [asst(100000, 0, 0, '2026-11-10T09:00:00Z')]);
    fs.writeFileSync(P.USAGE_CACHE, broken, 'utf8');
    const realCopy = fs.copyFileSync;
    fs.copyFileSync = function () { throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); };
    usage.sessionUsage(dir2, 's');
    usage.backfillCompactPoints([dir2], () => {
      fs.copyFileSync = realCopy;
      try {
        assert.strictEqual(fs.readFileSync(P.USAGE_CACHE, 'utf8'), broken,
          '留不下证据就必须锁死写入 —— 宁可这一程不记账,也不许把读不出来的那份顶掉');
        restoreFixture(); try { fs.rmSync(base2, { recursive: true, force: true }); } catch {}
        done();
      } catch (e) { restoreFixture(); done(e); }
    });
  });
});

test('⭐ parseNew 必须分块读:块边界切在半行和中文字符中间都不许错', (t) => {
  // 他最大的转录 730,420,457 字节,已经超过 Node 字符串上限 536,870,888。
  // 原来是「整段增量一次 toString」,entry.size 一旦清零就直接抛 ERR_STRING_TOO_LONG,
  // 被 catch 吞掉 → 那个会话的用量永久记不进来,而且每次启动白卡 2.3 秒。
  const base = useFixture();
  t.after(() => { restoreFixture(); try { fs.rmSync(base, { recursive: true, force: true }); } catch {} });
  const dir = path.join(P.CLAUDE_PROJECTS, 'chunk');
  const rows = [];
  // 模型名故意用中文:它会进 entry.h 的键,也在 JSON.parse 的范围内 ——
  // 块边界切坏多字节字符的话,这一行会整条解析失败,in/h 立刻对不上。
  for (let i = 0; i < 40; i++) rows.push(asst(1000 + i, 2000 + i, 3000 + i, '2026-11-10T0' + (i % 9) + ':00:00Z', i % 3 ? 'claude-opus-5' : '中文模型名-5-5'));
  rows.splice(20, 0, '{"type":"user","text":"中文中文中文中文中文中文中文中文中文"}');   // 多字节,故意让块边界切进去
  rows.push(boundary('auto', 99999, 9000, '2026-11-10T09:00:00Z'));
  sess('chunk', 's', rows);
  const one = JSON.parse(JSON.stringify(usage.sessionUsage(dir, 's')));
  assert.ok(one.ac > 0 && one.in > 0, '基准本身得读出东西,不然这条测试是空的');

  fs.copyFileSync(path.join(dir, 's.jsonl'), path.join(dir, 's2.jsonl'));
  const realRead = fs.readSync;
  let maxLen = 0;
  fs.readSync = function (fd, b, off, len, pos) { if (len > maxLen) maxLen = len; return realRead.apply(fs, arguments); };
  process.env.HUB_PARSE_CHUNK = '7';
  let two;
  try { two = JSON.parse(JSON.stringify(usage.sessionUsage(dir, 's2'))); }
  finally { delete process.env.HUB_PARSE_CHUNK; fs.readSync = realRead; }
  for (const k of ['in', 'out', 'cw', 'cr', 'ac', 'acPre', 'lastCtx', 'size']) {
    assert.strictEqual(two[k], one[k], k + ':7 字节一块读出来的必须和一次性读完全相同');
  }
  assert.deepStrictEqual(two.h, one.h, '小时分布也必须一样');
  assert.ok(maxLen <= 7, '单次读取必须被块大小夹住(实际 ' + maxLen + ')');
});

test('⭐ 回填也只许认 trigger:auto —— 手动 /compact 的点会造成长期假红', (t, done) => {
  // parseNew 那边有这条测试,回填这边没有:把 `m.trigger === 'auto'` 删掉,35 条全绿。
  // 他 205 份转录里有 37 个会话「最后一次压缩是手动的」,一旦手动点被当成天花板,
  // 那个会话的药丸就会长期假红 —— 噪音一多,整颗药丸就失信了。
  const base = useFixture();
  const dir = path.join(P.CLAUDE_PROJECTS, 'trg');
  sess('trg', 's', [
    asst(500000, 0, 0, '2026-11-10T09:00:00Z'),
    boundary('auto', 505000, 9000, '2026-11-10T09:01:00Z'),      // 自动的在前
    asst(52000, 0, 0, '2026-11-10T09:10:00Z'),
    boundary('manual', 53000, 9000, '2026-11-10T09:11:00Z'),     // 手动的在后,顺序很关键
    asst(60000, 0, 0, '2026-11-10T09:20:00Z'),
  ]);
  const fp = path.join(dir, 's.jsonl');
  fs.writeFileSync(P.USAGE_CACHE, JSON.stringify({
    s: { size: fs.statSync(fp).size, in: 1, out: 1, cw: 1, cr: 1, h: {}, slug: 'trg' }
  }), 'utf8');
  usage.backfillCompactPoints([dir], () => {
    try {
      assert.strictEqual(usage.autoCompactPoint(dir, 's'), 500000, '只许留自动那次的 50 万,不许是手动那次的 5.2 万');
      restoreFixture(); try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
      done();
    } catch (e) { restoreFixture(); done(e); }
  });
});

test('⭐ 同步打不开文件那条路,也不许记成「扫过了没压过」', (t, done) => {
  // 已有的那条用例把 broken.jsonl 做成目录,走的是 rl.on('error') 异步那条路;
  // createReadStream 同步抛(占用/权限)走的是另一个 catch,原来一条测试都没覆盖。
  const base = useFixture();
  const dir = path.join(P.CLAUDE_PROJECTS, 'syncfail');
  sess('syncfail', 's', [asst(100000, 0, 0, '2026-11-10T09:00:00Z'), boundary('auto', 101000, 9000, '2026-11-10T09:01:00Z')]);
  const fp = path.join(dir, 's.jsonl');
  fs.writeFileSync(P.USAGE_CACHE, JSON.stringify({
    s: { size: fs.statSync(fp).size, in: 3, out: 3, cw: 3, cr: 3, h: {}, slug: 'syncfail' }
  }), 'utf8');
  const real = fs.createReadStream;
  fs.createReadStream = function (p) {
    if (String(p) === fp) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
    return real.apply(fs, arguments);
  };
  usage.backfillCompactPoints([dir], (f1, t1) => {
    try {
      assert.strictEqual(t1, 1, '它该被排进队列');
      assert.strictEqual(f1, 0, '读都没读到,不可能测出实测点');
      assert.strictEqual(typeof usage.sessionUsage(dir, 's').ac, 'undefined', '同步抛这条路也不许落下 ac 字段');
    } catch (e) { fs.createReadStream = real; restoreFixture(); return done(e); }
    fs.createReadStream = real;
    usage.backfillCompactPoints([dir], (f2, t2) => {       // 这回读得了
      try {
        assert.strictEqual(t2, 1, '上回读失败的,这回必须还在队列里');
        assert.strictEqual(f2, 1);
        assert.strictEqual(usage.autoCompactPoint(dir, 's'), 100000);
        restoreFixture(); try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
        done();
      } catch (e) { restoreFixture(); done(e); }
    });
  });
});

test('⭐ sid 守卫:穿越目标里真放一份能读出数的转录,照样必须返回 null', (t) => {
  // 原来那条「sid 非法」的用例,6 个坏 sid 全都指向不存在的文件 ——
  // 有没有正则都返回 null,等于没测(和 slug 那条自己批评过的毛病同款,横向漏了 sid)。
  const base = useFixture();
  t.after(() => { restoreFixture(); try { fs.rmSync(base, { recursive: true, force: true }); } catch {} });
  settings({ autoCompactWindow: 300000 });
  sess('g', 'ok', [asst(111111, 0, 0, '2026-11-10T09:00:00Z')]);
  const dir = path.join(P.CLAUDE_PROJECTS, 'g');
  // 给每个坏 sid 在磁盘上真备好它会读到的那个文件
  const bads = ['a/b', 'x..y/z', '带空格 的', 'a.b', '..'];
  for (const b of bads) {
    const target = path.join(dir, b + '.jsonl');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, asst(999001, 0, 0, '2026-11-10T09:00:00Z') + '\n', 'utf8');
  }
  // 先证明这些文件确实读得出数,否则这条测试还是空的
  assert.ok(usage.sessionContext(dir, 'a.b'), '夹具必须真的读得出数(绕开守卫直接调 sessionContext)');
  assert.strictEqual(usage.liveContext('g', 'ok').ctx, 111111, '合法 sid 要照常给数');
  for (const b of bads.concat(['../../../../etc/passwd'])) {
    let r, threw = false;
    try { r = usage.liveContext('g', b); } catch { threw = true; }
    assert.strictEqual(threw, false, 'sid=' + b + ' 不许抛');
    assert.strictEqual(r, null, 'sid=' + b + ' 必须是 null,哪怕那个文件真的在、真的读得出 99.9 万');
  }
});

test('⭐ 账本有内容时必须留一份滚动备份(原子写救不了「写进去的内容本身是空的」)', (t, done) => {
  const base = useFixture();
  const dir = path.join(P.CLAUDE_PROJECTS, 'bak');
  sess('bak', 's', [asst(100000, 0, 0, '2026-11-10T09:00:00Z')]);
  const prev = { oldone: { size: 1, in: 42, out: 1, cw: 1, cr: 1, h: {}, slug: 'bak', ac: 0 } };
  fs.writeFileSync(P.USAGE_CACHE, JSON.stringify(prev), 'utf8');
  usage.sessionUsage(dir, 's');
  usage.backfillCompactPoints([dir], () => {                 // 空队列 → 立刻落盘
    try {
      const bak = P.USAGE_CACHE + '.bak';
      assert.ok(fs.existsSync(bak), '落盘前必须把原来那份备份出来');
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(bak, 'utf8')), prev, '备份必须是落盘之前那份内容');
      restoreFixture(); try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
      done();
    } catch (e) { restoreFixture(); done(e); }
  });
});

test('⭐ 默认块大小必须远低于 Node 字符串上限', () => {
  // 分块本身是为了绕开 ERR_STRING_TOO_LONG。块大小要是被调回 512MB 以上,等于白改。
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'usage.js'), 'utf8');
  const at = src.indexOf("function parseChunk");
  assert.ok(at > 0, "找不到默认块大小(parseChunk)");
  const line = src.slice(at, src.indexOf(String.fromCharCode(10), at));
  const expr = line.slice(line.lastIndexOf(":") + 1, line.lastIndexOf(";"));
  const def = Function("return (" + expr + ")")();
  assert.ok(def > 0, '块大小必须是正数');
  assert.ok(def < require('buffer').constants.MAX_STRING_LENGTH / 4,
    '默认块 ' + def + ' 必须远低于字符串上限 ' + require('buffer').constants.MAX_STRING_LENGTH);
});

test('⭐ 转录最后一行没有换行符时,那一行也必须算进来', (t) => {
  // 正在写的转录末尾本来就可能是半行。分块读之后「最后一截」是单独交给 handleLine 的,
  // 丢掉它等于每次都少算最新那一轮 —— 而最新那一轮恰好就是药丸要读的那个数。
  const base = useFixture();
  t.after(() => { restoreFixture(); try { fs.rmSync(base, { recursive: true, force: true }); } catch {} });
  const dir = path.join(P.CLAUDE_PROJECTS, 'nonl');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 's.jsonl'), [
    asst(111000, 0, 0, '2026-11-10T09:00:00Z'),
    boundary('auto', 112000, 9000, '2026-11-10T09:01:00Z'),
    asst(222000, 0, 0, '2026-11-10T09:02:00Z'),      // 末行,后面**没有**换行符
  ].join(String.fromCharCode(10)), 'utf8');
  const e = usage.sessionUsage(dir, 's');
  assert.strictEqual(e.ac, 111000, '压缩点照常');
  assert.strictEqual(e.lastCtx, 222000, '末行(没有换行符)必须算进来');
  assert.strictEqual(e.in, 111000 + 222000, '累计也要含末行');
});

test('⭐ 同一个 sid 出现在两个目录下时,绝不许把 A 的实测点贴到 B 的药丸上', (t, done) => {
  // 会话目录名是「路径里非 [A-Za-z0-9-] 的字符全换成 -」,中文一字一杠 ——
  // 他 49 个项目里有 12 个撞在 5 个 slug 上。account 是按 sid 存的,所以两个目录会争同一条。
  // autoCompactPoint 靠 entry.slug 挡这件事;而 liveContext 里「先喂账本再读实测点」
  // 会把 entry.slug 改写成当前目录名 —— 顺序搞错就等于把这道校验废掉(第四轮验收 P2-2)。
  const base = useFixture();
  settings({ autoCompactWindow: 1000000 });
  const dA = path.join(P.CLAUDE_PROJECTS, 'dirA'), dB = path.join(P.CLAUDE_PROJECTS, 'dirB');
  // A 目录:同一个 sid,压过一次(很低的点)
  sess('dirA', 'same', [
    asst(240000, 0, 0, '2026-11-10T09:00:00Z'),
    boundary('auto', 245000, 9000, '2026-11-10T09:01:00Z'),
    asst(9000, 0, 0, '2026-11-10T09:02:00Z'),
  ]);
  // B 目录:同一个 sid,从没压过,读数正常
  // ⚠️ B 的文件必须比 A 的大:小了就会触发「变短整份重算」,ac 被顺手清成 0,
  // 这条用例也就分辨不出「喂账本之前到底有没有校验 slug」了(补变异时踩到)。
  sess('dirB', 'same', [
    asst(100000 + 0, 0, 0, '2026-11-10T09:10:00Z'),
    asst(100000 + 1, 0, 0, '2026-11-10T09:11:00Z'),
    asst(100000 + 2, 0, 0, '2026-11-10T09:12:00Z'),
    asst(100000 + 3, 0, 0, '2026-11-10T09:13:00Z'),
    asst(100000 + 4, 0, 0, '2026-11-10T09:14:00Z'),
    asst(100000 + 5, 0, 0, '2026-11-10T09:15:00Z'),
    asst(260000, 0, 0, '2026-11-10T09:20:00Z'),
  ]);
  usage.sessionUsage(dA, 'same');                       // 账本里这条现在属于 A
  try {
    assert.strictEqual(usage.autoCompactPoint(dA, 'same'), 240000, 'A 自己读得到');
    assert.strictEqual(usage.autoCompactPoint(dB, 'same'), 0, 'B 不许拿 A 的实测点');
    const r = usage.liveContext('dirB', 'same');
    assert.ok(r, 'B 必须读得到自己的读数');
    assert.strictEqual(r.ctx, 260000);
    assert.strictEqual(r.calib, 0, 'liveContext 在 B 上也不许用上 A 的实测点(分母会凭空缩到 24 万)');
    assert.strictEqual(r.eff, 987000, '分母要退回算出来的硬上限');
  } catch (e) { restoreFixture(); return done(e); }
  restoreFixture(); try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
  done();
});

test('⭐ 窗口配得很小时,红线要取「再减 2 万」那一支(文档专门解释了它,原来没测)', (t) => {
  const base = useFixture();
  t.after(() => { restoreFixture(); try { fs.rmSync(base, { recursive: true, force: true }); } catch {} });
  const dir = path.join(P.CLAUDE_PROJECTS, 'small');
  sess('small', 's', [asst(50000, 0, 0, '2026-11-10T09:00:00Z')]);
  settings({ autoCompactWindow: 150000 });
  const r = usage.liveContext('small', 's');
  // thr = 150000 - 13000 = 137000;两支分别是 137000-20000=117000 和 round(137000*0.9)=123300
  assert.strictEqual(r.thr, 137000);
  assert.strictEqual(r.redAt, 117000, '小窗口下必须取更早的那一支(减 2 万),不是 90%');
  restoreFixture();
  const base2 = useFixture();
  t.after(() => { restoreFixture(); try { fs.rmSync(base2, { recursive: true, force: true }); } catch {} });
  const dir2 = path.join(P.CLAUDE_PROJECTS, 'big2');
  sess('big2', 's', [asst(50000, 0, 0, '2026-11-10T09:00:00Z')]);
  settings({ autoCompactWindow: 1000000 });
  const r2 = usage.liveContext('big2', 's');
  assert.strictEqual(r2.thr, 987000);
  assert.strictEqual(r2.redAt, 888300, '大窗口下取 90% 那一支');
  void dir; void dir2;
});

test('⭐ 转录变短(被重建/被外部工具改过)时必须整份重算,不许双计', (t) => {
  const base = useFixture();
  t.after(() => { restoreFixture(); try { fs.rmSync(base, { recursive: true, force: true }); } catch {} });
  const dir = path.join(P.CLAUDE_PROJECTS, 'shrink');
  sess('shrink', 's', [
    asst(100000, 0, 0, '2026-11-10T09:00:00Z'),
    boundary('auto', 101000, 9000, '2026-11-10T09:01:00Z'),
    asst(200000, 0, 0, '2026-11-10T09:02:00Z'),
  ]);
  const e1 = usage.sessionUsage(dir, 's');
  assert.strictEqual(e1.in, 300000);
  assert.strictEqual(e1.ac, 100000);
  // 换成一份更短的(同一个 sid)
  sess('shrink', 's', [asst(70000, 0, 0, '2026-11-10T10:00:00Z')]);
  const e2 = usage.sessionUsage(dir, 's');
  assert.strictEqual(e2.in, 70000, '变短了就得从头算,不许在旧累计上继续加');
  assert.strictEqual(e2.ac, 0, '旧的实测点也必须跟着清掉(那次压缩在新文件里不存在了)');
  assert.strictEqual(e2.lastCtx, 70000);
  assert.deepStrictEqual(Object.keys(e2.h), ['2026-11-10T' + String(new Date('2026-11-10T10:00:00Z').getHours()).padStart(2, '0')]);
});

test('⭐ 倒读窗口打不开文件时必须一次就认输,不许一路放大重试', (t) => {
  // scanCtxTail 读失败时 sawLine 故意报 true,就是为了不去放大窗口重试一个读不了的文件。
  // 报 false 的话会连着读 4 次(512KB → 4MB → 8MB),每次都失败。
  const base = useFixture();
  t.after(() => { restoreFixture(); try { fs.rmSync(base, { recursive: true, force: true }); } catch {} });
  const dir = path.join(P.CLAUDE_PROJECTS, 'locked');
  const pad = new Array(2001).join('y');
  const rows = [];
  for (let i = 0; i < 400; i++) rows.push('{"pad":"' + pad + '"}');   // ≈ 800KB,大于首个倒读窗口
  rows.push(asst(123456, 0, 0, '2026-11-10T09:00:00Z'));
  sess('locked', 's', rows);
  const fp = path.join(dir, 's.jsonl');
  assert.ok(usage.sessionContext(dir, 's'), '先证明它本来读得出来,不然这条测试是空的');
  const realOpen = fs.openSync;
  let opens = 0;
  fs.openSync = function (p) {
    if (String(p) === fp) { opens++; throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); }
    return realOpen.apply(fs, arguments);
  };
  let r, threw = false;
  try { r = usage.sessionContext(dir, 's'); } catch { threw = true; } finally { fs.openSync = realOpen; }
  assert.strictEqual(threw, false, '不许抛');
  assert.strictEqual(r, null, '读不了就是 null');
  assert.strictEqual(opens, 1, '只许试一次(实际 ' + opens + ' 次)—— 放大重试一个打不开的文件纯属白烧');
});

test('⭐ 回填不许用自己的流式快照盖掉 parseNew 已经推进过的 lastCtx', (t, done) => {
  // 回填一个会话要几十毫秒到几秒,这期间 parseNew 可能已经把 lastCtx 推到更新的位置。
  // 用旧快照盖回去的话,下一次压缩记下的实测点就偏旧一轮 —— 分母直接错一轮的量。
  const base = useFixture();
  const dir = path.join(P.CLAUDE_PROJECTS, 'lastctx');
  sess('lastctx', 's', [asst(500000, 0, 0, '2026-11-10T09:00:00Z')]);   // 没有 boundary → ac 会是 0
  const fp = path.join(dir, 's.jsonl');
  fs.writeFileSync(P.USAGE_CACHE, JSON.stringify({
    s: { size: fs.statSync(fp).size, in: 1, out: 1, cw: 1, cr: 1, h: {}, slug: 'lastctx' }   // 老条目:没有 ac 字段
  }), 'utf8');
  const e = usage.sessionUsage(dir, 's');
  usage.backfillCompactPoints([dir], () => {
    try {
      assert.strictEqual(e.lastCtx, 888888, 'parseNew 刚推进到 888888,回填不许把它盖回 500000');
      assert.strictEqual(e.ac, 0, 'ac 照常补成 0(这个会话确实没压过)');
      restoreFixture(); try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
      done();
    } catch (err) { restoreFixture(); done(err); }
  });
  e.lastCtx = 888888;        // 队列已建好、文件还在读的时候,parseNew 抢先推进了
});

// ===== 第五轮验收打回补的用例 =====

test('⭐ 账本坏掉时,滚动备份不许被坏数据覆盖(它唯一该起作用的场景就是这个)', (t) => {
  // .bak 的源是**盘上那份**,而「读失败」这条路恰恰是盘上那份已经坏了的时候才走到的。
  // 不挡住就是:坏的两份(.bak + .bad-*)、好的零份。第五轮验收 P1-1 实测过。
  const base = useFixture();
  t.after(() => { restoreFixture(); try { fs.rmSync(base, { recursive: true, force: true }); } catch {} });
  const GOOD = JSON.stringify({ old: { size: 10, in: 999999, out: 1, cw: 0, cr: 0, h: {}, slug: 'x', ac: 0 } });
  fs.writeFileSync(P.USAGE_CACHE, GOOD, 'utf8');
  fs.writeFileSync(P.USAGE_CACHE + '.bak', GOOD, 'utf8');          // 上一程留下的好备份
  fs.writeFileSync(P.USAGE_CACHE, '{"old":{"size":10,"in":99', 'utf8');   // 现在是半截的
  const dir = path.join(P.CLAUDE_PROJECTS, 'bakguard');
  sess('bakguard', 's', [asst(12345, 0, 0, '2026-11-10T09:00:00Z')]);
  usage.sessionUsage(dir, 's');
  usage.saveNow && usage.saveNow();
  // 不管写没写成,.bak 必须还是那份好的
  assert.strictEqual(fs.readFileSync(P.USAGE_CACHE + '.bak', 'utf8'), GOOD,
    '读失败之后绝不许再拿盘上那份去刷 .bak');
  const bad = fs.readdirSync(path.dirname(P.USAGE_CACHE)).filter(f => f.indexOf('.bad-') >= 0);
  assert.strictEqual(bad.length, 1, '坏账本要另存一份证据(实际 ' + JSON.stringify(bad) + ')');
  assert.ok(!/[.]$/.test(bad[0]), '.bad-* 的文件名不许以点结尾(Win32 会把尾点吃掉,他手工抢救时点不开):' + bad[0]);
});

test('⭐ 账本读失败不许锁死整个进程 —— 占用过去之后要能自己恢复', (t, done) => {
  // 原来失败分支把 cache 设成 {}(真值),load() 再也不进那个分支 → writeLocked 永不解除。
  // 杀毒/备份软件几百毫秒的占用,就能让他一整天的用量一条都不落盘。第五轮验收 P2-1。
  process.env.HUB_LEDGER_RETRY_MS = '250';
  const base = useFixture();
  const fin = (err) => {
    delete process.env.HUB_LEDGER_RETRY_MS;
    restoreFixture(); try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
    done(err);
  };
  const OLD = JSON.stringify({ old: { size: 1, in: 111, out: 0, cw: 0, cr: 0, h: {}, slug: 'x', ac: 0 } });
  fs.writeFileSync(P.USAGE_CACHE, OLD, 'utf8');
  const dir = path.join(P.CLAUDE_PROJECTS, 'relock');
  sess('relock', 's', [asst(1800000, 0, 0, '2026-11-10T09:00:00Z')]);
  const rf = fs.readFileSync, cf = fs.copyFileSync;
  let busy = true;
  fs.readFileSync = function (p) { if (busy && String(p) === P.USAGE_CACHE) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); return rf.apply(fs, arguments); };
  fs.copyFileSync = function (a) { if (busy && String(a) === P.USAGE_CACHE) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); return cf.apply(fs, arguments); };
  usage.sessionUsage(dir, 's');            // 这一拍 load 失败 → 锁死
  // ⚠️ 再记一个**冷会话**:锁死期间盘上一个字都没写,所以它只活在内存里,而且后面再也没人查它。
  //    不加这一条的话,把 Object.assign(j, mine) 改成 cache = j 全套测试照样绿 ——
    //  因为 s 会被重新查询、从第 0 字节整份重算,总数照样对(第六轮验收 P3-1,和 1249 那条同一个陷阱)。
  const cdir = path.join(P.CLAUDE_PROJECTS, 'relockcold');
  sess('relockcold', 'c', [asst(555000, 0, 0, '2026-11-10T09:30:00Z')]);
  usage.sessionUsage(cdir, 'c');
  busy = false; fs.readFileSync = rf; fs.copyFileSync = cf;
  setTimeout(() => {                        // 过了重试间隔
    try {
      fs.appendFileSync(path.join(dir, 's.jsonl'), asst(2000, 0, 0, '2026-11-10T10:00:00Z') + String.fromCharCode(10), 'utf8');
      usage.sessionUsage(dir, 's');
      usage.saveNow();
      const j = JSON.parse(fs.readFileSync(P.USAGE_CACHE, 'utf8'));
      assert.ok(j.s, '占用过去之后新数据必须落盘(否则就是整程锁死)');
      assert.strictEqual(j.s.in, 1802000);
      assert.ok(j.old && j.old.in === 111, '重读成功时要把盘上那份当底,老条目不许丢');
      assert.ok(j.c, '锁死期间记下的冷会话必须还在(内存里那份不许被盘上那份整个顶掉)');
      assert.strictEqual(j.c.in, 555000, '冷会话的累计也必须完整');
      fin();
    } catch (e) { fin(e); }
  }, 400);
});

test('⭐ 账本一直读不出来:证据副本只许留一份,内存里的累计也不许被清掉', (t, done) => {
  // 两件事一起盯:
  // ① 重试每 60 秒一次,不加「已经存过」的标记就会每分钟多攒一份坏账本副本,磁盘堆到没完。
  //    (数文件个数靠不住 —— .bad-* 的时间戳只精确到秒,一秒内重试几次会写成同一个名字;
  //     所以直接数 copyFileSync 的调用次数。)
  // ② 重试又失败时,内存里这一程算出来的东西必须继续留着;清成 {} 等于这段时间白记。
  //
  // ⚠️ 这条第一版只断言了「被反复查询的那个会话 e.in 对不对」—— 抓不住清空内存。
  //    因为 parseNew 对新条目是从第 0 字节整份重算的:内存清了,下次查它照样算得出正确总数。
  //    **断言必须落在算不回来的东西上** —— 另一个会话,记完就再也没人去查它。
  //    看的是 totalsBySlug()(不带时间过滤地走整个账本),它正是项目列表 tok 列的数据源:
  //    内存一清,那一列就全变 0。
  process.env.HUB_LEDGER_RETRY_MS = '120';
  const base = useFixture();
  const realCopy = fs.copyFileSync;
  const fin = (err) => {
    fs.copyFileSync = realCopy;
    delete process.env.HUB_LEDGER_RETRY_MS;
    restoreFixture(); try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
    done(err);
  };
  let badCopies = 0;
  fs.copyFileSync = function (a, b) { if (String(b).indexOf('.bad-') >= 0) badCopies++; return realCopy.apply(fs, arguments); };
  fs.writeFileSync(P.USAGE_CACHE, '{"broken":', 'utf8');
  // 冷会话:只在最开头记一次,后面一次都不再查 —— 它只能活在内存里
  const cold = path.join(P.CLAUDE_PROJECTS, 'badcold');
  sess('badcold', 'c', [asst(777000, 0, 0, '2026-11-10T08:00:00Z')]);
  usage.sessionUsage(cold, 'c');
  const coldBase = usage.totalsBySlug().badcold;
  const dir = path.join(P.CLAUDE_PROJECTS, 'badpile');
  sess('badpile', 's', [asst(1000, 0, 0, '2026-11-10T09:00:00Z')]);
  usage.sessionUsage(dir, 's');
  let n = 0, truth = 1000;
  const tick = () => {
    if (++n > 4) {
      try {
        assert.strictEqual(badCopies, 1, '一程只许存一份证据副本,实际存了 ' + badCopies + ' 次');
        const e = usage.sessionUsage(dir, 's');
        assert.strictEqual(e.in, truth, '重试一直失败,反复查的那个会话累计必须完整(实际 ' + e.in + ' / ' + truth + ')');
        // 换成**另一份**坏内容 → 必须为它再留一份证据(他手动把 .bak 拷回来就是这个形状:
        // 盘上换了一份,而这一刻还读不出来。只认布尔值的话既不留证据又照样解锁,
        // 会把他刚恢复的好数据覆盖掉 —— 第八轮验收 P3-3。)
        fs.writeFileSync(P.USAGE_CACHE, '{"另一份坏的":[1,2,3', 'utf8');
        const before2 = badCopies;
        usage.sessionUsage(dir, 's');
        assert.strictEqual(badCopies, before2, '同一拍内不该重复拷(还没到重试间隔)');
        const by = usage.totalsBySlug();
        assert.ok(coldBase > 0, '前提:冷会话一开始就该记上(实际 ' + coldBase + ')');
        assert.strictEqual(by.badcold, coldBase,
          '没人再去查的那个会话也必须还在内存里(项目列表 tok 列读的就是它,实际 ' + by.badcold + ' / ' + coldBase + ')');
        fin();
      } catch (err) { fin(err); }
      return;
    }
    // 注意:**不要**每拍重写这个文件 —— 那会让 size:mtimeMs 签名变化,
    // 按新语义(第八轮 P3-3「证据要认文件身份」)本来就该为新内容再留一份证据。
    // 这里要测的是「同一份坏文件只许留一份」,所以让它保持不动。
    const v = n * 1000;
    truth += v;
    fs.appendFileSync(path.join(dir, 's.jsonl'), asst(v, 0, 0, '2026-11-10T1' + n + ':00:00Z') + String.fromCharCode(10), 'utf8');
    usage.sessionUsage(dir, 's');
    setTimeout(tick, 150);
  };
  setTimeout(tick, 150);
});
test('⭐ 账本解析出来不是对象(数组 / null / 数字)一律当读失败', (t) => {
  // 这条是第四轮 P1-1「三道防线」里的第一道,但当时一条测试都没有:
  // 第五轮验收把整条校验删掉、或者只删 Array.isArray 那半条,50 条用例全绿。
  for (const junk of ['[]', 'null', '42', '"abc"']) {
    const base = useFixture();
    fs.writeFileSync(P.USAGE_CACHE, junk, 'utf8');
    const dir = path.join(P.CLAUDE_PROJECTS, 'junk');
    sess('junk', 's', [asst(7000, 0, 0, '2026-11-10T09:00:00Z')]);
    const e = usage.sessionUsage(dir, 's');
    const bad = fs.readdirSync(path.dirname(P.USAGE_CACHE)).filter(f => f.indexOf('.bad-') >= 0);
    restoreFixture();
    try {
      assert.strictEqual(e.in, 7000, junk + ':照常解析自己这条');
      assert.strictEqual(bad.length, 1, junk + ' 必须被当成「坏账本」留证据(实际 ' + bad.length + ' 份)');
    } finally { try { fs.rmSync(base, { recursive: true, force: true }); } catch {} }
  }
});

test('⭐ parseNew 读到一半抛异常,下一拍不许重复计数', (t) => {
  // 分块之前是「整段 toString 再逐行累加」,toString 在任何累加之前抛,所以老代码天然安全。
  // 分块把解析和提交交错了 —— 中途抛异常、entry.size 还是旧值 → 下一拍从同一个偏移重读。
  // 第五轮验收实测:1200 字节的文件多算 25%,方向是把用量**报高**。
  const old = process.env.HUB_PARSE_CHUNK;
  process.env.HUB_PARSE_CHUNK = '200';
  const base = useFixture();
  t.after(() => {
    if (old === undefined) delete process.env.HUB_PARSE_CHUNK; else process.env.HUB_PARSE_CHUNK = old;
    restoreFixture(); try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
  });
  const dir = path.join(P.CLAUDE_PROJECTS, 'midfail');
  const rows = [];
  for (let i = 0; i < 6; i++) rows.push(asst(1000, 0, 0, '2026-11-10T0' + i + ':00:00Z'));
  sess('midfail', 's', rows);
  const real = fs.readSync;
  let n = 0;
  fs.readSync = function () { n++; if (n === 4) throw Object.assign(new Error('EIO'), { code: 'EIO' }); return real.apply(fs, arguments); };
  let e;
  try { e = usage.sessionUsage(dir, 's'); } finally { fs.readSync = real; }
  assert.ok(e.in > 0 && e.in < 6000, '前提:这一拍确实只读进去了一部分(实际 ' + e.in + ')');
  assert.ok(e.size > 0, '已经消费掉的字节必须提交到 entry.size(实际 ' + e.size + ')');
  const e2 = usage.sessionUsage(dir, 's');
  assert.strictEqual(e2.in, 6000, '重试之后必须正好是真值,不许双计');
  assert.strictEqual(e2.size, fs.statSync(path.join(dir, 's.jsonl')).size);
});

test('⭐ 文件变短但新文件仍然很大时,light 模式必须走延后,而且延后要算对', (t, done) => {
  // 变短的代价是「整个新文件」,不是 delta。只看 delta 的话 delta < 0 必然小于闸门 →
  // 恒走同步那一支,8MB 闸形同虚设:liveContext 是 15 秒一跳的 IPC,
  // 他那份 730MB 整份重算要 9 秒,主进程(含终端 IO)整个冻住。第五轮验收 P2-3。
  const base = useFixture();
  const fin = (err) => { restoreFixture(); try { fs.rmSync(base, { recursive: true, force: true }); } catch {} done(err); };
  const dir = path.join(P.CLAUDE_PROJECTS, 'shrinkbig');
  const pad = new Array(2001).join('z');
  const rows = [];
  for (let i = 0; i < 13000; i++) rows.push(JSON.stringify({ type: 'user', pad: pad }));
  rows.push(asst(180000, 0, 0, '2026-11-10T09:00:00Z'));
  sess('shrinkbig', 's', rows);
  const fp = path.join(dir, 's.jsonl');
  const e1 = usage.sessionUsage(dir, 's');
  assert.strictEqual(e1.in, 180000);
  const keep = rows.slice(0, 6000);
  keep.push(asst(90000, 0, 0, '2026-11-10T10:00:00Z'));
  fs.writeFileSync(fp, keep.join(String.fromCharCode(10)) + String.fromCharCode(10), 'utf8');
  const sz = fs.statSync(fp).size;
  assert.ok(sz > 8 * 1024 * 1024, '前提:截短之后仍然在 8MB 以上(实际 ' + sz + ')');
  const t0 = Date.now();
  const e2 = usage.sessionUsage(dir, 's', true);
  const ms = Date.now() - t0;
  try {
    assert.notStrictEqual(e2.size, sz, 'light 模式下不许在这一拍里同步整份重算(耗时 ' + ms + 'ms)');
  } catch (err) { return fin(err); }
  // 延后那一支要分多拍读完,而且结果必须正确
  let waited = 0;
  const poll = () => {
    if (e2.size === sz) {
      try {
        assert.strictEqual(e2.in, 90000, '整份重算之后必须只剩新文件里那一轮,不许在旧累计上加');
        assert.strictEqual(e2.lastCtx, 90000);
        fin();
      } catch (err) { fin(err); }
      return;
    }
    if ((waited += 60) > 8000) return fin(new Error('延后的追赶没跑完:size=' + e2.size + ' 应为 ' + sz));
    setTimeout(poll, 60);
  };
  setTimeout(poll, 60);
});

test('⭐ 原子写:目标文件在任何时刻都不许消失(不许先删再 rename)', (t) => {
  // 第五轮验收的变异 L14 把 atomic-json 改成「先 unlink 目标再 rename」—— 留出一个
  // 「文件不存在」的窗口,原子性就破了,而 50 条用例全绿。这条用例专门盯住它。
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atom-'));
  t.after(() => { try { fs.rmSync(base, { recursive: true, force: true }); } catch {} });
  const fp = path.join(base, 'x.json');
  fs.writeFileSync(fp, JSON.stringify({ v: 1 }), 'utf8');
  const realUnlink = fs.unlinkSync, realRename = fs.renameSync, realFsync = fs.fsyncSync;
  let unlinkedTarget = 0, renames = 0, existedBeforeRename = null, fsyncs = 0;
  fs.fsyncSync = function () { fsyncs++; return realFsync.apply(fs, arguments); };
  fs.unlinkSync = function (p) { if (String(p) === fp) unlinkedTarget++; return realUnlink.apply(fs, arguments); };
  fs.renameSync = function (a, b) {
    if (String(b) === fp) { renames++; existedBeforeRename = fs.existsSync(fp); }
    return realRename.apply(fs, arguments);
  };
  try { require('../lib/atomic-json.js').writeJsonAtomic(fp, { v: 2 }); }
  finally { fs.unlinkSync = realUnlink; fs.renameSync = realRename; fs.fsyncSync = realFsync; }
  assert.strictEqual(unlinkedTarget, 0, '不许删目标文件(删了就有一个它不存在的窗口)');
  assert.strictEqual(renames, 1, '必须正好一次 rename');
  assert.ok(fsyncs >= 1, '临时文件必须 fsync 之后才 rename —— 不然断电时 rename 已落盘、内容还在页缓存里,拿到的是一个长度对但内容空的文件');
  assert.strictEqual(existedBeforeRename, true, 'rename 之前目标必须还在(旧内容),这才是「原地顶替」');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(fp, 'utf8')), { v: 2 });
});

test('⭐ 有实测点时,百分比的分母必须是实测点,不是算出来的硬上限', (t) => {
  // 第五轮验收的变异 C10 把 pct 的分母从 eff 换成 thr,50 条用例全绿 ——
  // 也就是说工具提示里「已到 X%」那个数可以悄悄算错而没人发现。
  const base = useFixture();
  t.after(() => { restoreFixture(); try { fs.rmSync(base, { recursive: true, force: true }); } catch {} });
  settings({ autoCompactWindow: 1000000 });
  sess('pctcalib', 's', [
    asst(300000, 0, 0, '2026-11-10T09:00:00Z'),
    boundary('auto', 301000, 9000, '2026-11-10T09:01:00Z'),
    asst(240000, 0, 0, '2026-11-10T09:02:00Z'),
  ]);
  const dir = path.join(P.CLAUDE_PROJECTS, 'pctcalib');
  usage.sessionUsage(dir, 's');
  const r = usage.liveContext('pctcalib', 's');
  assert.strictEqual(r.calib, 300000, '前提:实测点读到了');
  assert.strictEqual(r.eff, 300000);
  assert.strictEqual(r.pct, 80, '240000 / 300000 = 80%(拿 987000 当分母会算成 24%)');
});

test('⭐ 分块的「已消费字节数」必须按字节算、而且要含换行符(少一个字节就丢一整行)', (t) => {
  // 上一条用例用的是等值的行,少算一个字节只会让下一拍从行中间开始、那半行解析失败被丢掉,
  // 而丢掉的恰好是已经算过的那一行 —— 总数歪打正着还是对的,变异就漏过去了。
  // 这条用不同的值 + 中文模型名:少一个字节会丢掉一整行(总数变小),
  // 按字符数算(ln.length)在中文面前会少算一大截(丢更多行)。
  const old = process.env.HUB_PARSE_CHUNK;
  process.env.HUB_PARSE_CHUNK = '220';
  const base = useFixture();
  t.after(() => {
    if (old === undefined) delete process.env.HUB_PARSE_CHUNK; else process.env.HUB_PARSE_CHUNK = old;
    restoreFixture(); try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
  });
  const dir = path.join(P.CLAUDE_PROJECTS, 'bytes');
  const rows = [];
  let truth = 0;
  for (let i = 1; i <= 8; i++) {
    const v = i * 1000;                 // 每行不一样 —— 丢一行总数立刻不对
    truth += v;
    rows.push(asst(v, 0, 0, '2026-11-10T0' + i + ':00:00Z', '克劳德-作品-五点五'));   // 中文:字节数 ≠ 字符数
  }
  sess('bytes', 's', rows);
  const fp = path.join(dir, 's.jsonl');
  const real = fs.readSync;
  let n = 0;
  fs.readSync = function () { n++; if (n === 3) throw Object.assign(new Error('EIO'), { code: 'EIO' }); return real.apply(fs, arguments); };
  let e;
  try { e = usage.sessionUsage(dir, 's'); } finally { fs.readSync = real; }
  assert.ok(e.in > 0 && e.in < truth, '前提:这一拍只读进去一部分(实际 ' + e.in + ' / ' + truth + ')');
  // entry.size 必须正好停在某个完整行的边界上 —— 用文件内容自己验一遍
  const head = fs.readFileSync(fp).subarray(0, e.size).toString('utf8');
  assert.ok(e.size === 0 || head.endsWith(String.fromCharCode(10)),
    'entry.size 必须落在行边界(当前落在「' + head.slice(-12) + '」后面)');
  const e2 = usage.sessionUsage(dir, 's');
  assert.strictEqual(e2.in, truth, '接着读完必须正好是真值:一行不丢、一行不重');
});

test('⭐ 延后的追赶必须分多拍,不许一拍把几百 MB 全读完', (t, done) => {
  // 分块只封住了内存,没封住阻塞时长:他那份 730MB 整份解析要 9 秒,
  // 全压在一拍里主进程(含终端 IO)整个冻住。所以延后那一支要按单拍预算分多次。
  // 怎么验「分了多拍」:parseNew 每次调用开一次文件句柄 —— 数 openSync 的次数就行。
  const base = useFixture();
  const fin = (err) => { fs.openSync = realOpen; restoreFixture(); try { fs.rmSync(base, { recursive: true, force: true }); } catch {} done(err); };
  const dir = path.join(P.CLAUDE_PROJECTS, 'bigcatch');
  const pad = new Array(2001).join('q');
  const rows = [];
  for (let i = 0; i < 13000; i++) rows.push(JSON.stringify({ type: 'user', pad: pad }));   // ≈ 25MB
  rows.push(asst(123000, 0, 0, '2026-11-10T09:00:00Z'));
  sess('bigcatch', 's', rows);
  const fp = path.join(dir, 's.jsonl');
  const sz = fs.statSync(fp).size;
  assert.ok(sz > 3 * 8 * 1024 * 1024, '前提:文件要大于三个单拍预算(实际 ' + sz + ')');
  const realOpen = fs.openSync;
  let opens = 0;
  fs.openSync = function (p) { if (String(p) === fp) opens++; return realOpen.apply(fs, arguments); };
  const e = usage.sessionUsage(dir, 's', true);    // 全新条目 + light → 必须走延后
  try {
    assert.strictEqual(opens, 0, 'light 模式下这一拍不许读盘');
    assert.strictEqual(e.size, 0);
  } catch (err) { return fin(err); }
  let waited = 0;
  const poll = () => {
    if (e.size === sz) {
      try {
        assert.ok(opens >= 3, '必须分多拍读完(openSync 实际只有 ' + opens + ' 次 —— 等于一拍读完,主进程会冻住)');
        assert.strictEqual(e.in, 123000, '分多拍也必须一行不丢、一行不重');
        assert.strictEqual(e.lastCtx, 123000);
        fin();
      } catch (err) { fin(err); }
      return;
    }
    if ((waited += 60) > 10000) return fin(new Error('追赶没跑完:size=' + e.size + ' 应为 ' + sz + ',openSync ' + opens + ' 次'));
    setTimeout(poll, 60);
  };
  setTimeout(poll, 60);
});

test('⭐ 单行比单拍预算还长时,追赶必须照样往前走(不许原地打转)', (t, done) => {
  // 延后追赶是「读够 LIGHT_MAX 就交回事件循环」。但如果这一拍里**一个换行符都没碰到**,
  // 就一个字节也提交不了、entry.size 不动 —— 下一拍从同一个偏移再读,
  // setTimeout(step, 0) 原地打转把主进程烧满。
  // 触发条件是单行 > 8MB:实测他 212 份转录最长的一行 5.33MB,还没过线,但余量只有 1.5 倍,
  // 贴一张大图或一次大的工具输出就过线。所以预算只许在**行边界**上生效。
  const base = useFixture();
  const fin = (err) => { restoreFixture(); try { fs.rmSync(base, { recursive: true, force: true }); } catch {} done(err); };
  const dir = path.join(P.CLAUDE_PROJECTS, 'longline');
  const pad = new Array(9 * 1024 * 1024 + 1).join('q');      // 一行 9MB > LIGHT_MAX 8MB
  sess('longline', 's', [JSON.stringify({ type: 'user', pad: pad }), asst(456000, 0, 0, '2026-11-11T09:00:00Z')]);
  const fp = path.join(dir, 's.jsonl');
  const sz = fs.statSync(fp).size;
  const e = usage.sessionUsage(dir, 's', true);               // 全新条目 + light → 走延后
  try { assert.strictEqual(e.size, 0, '前提:light 这一拍不许读盘'); } catch (err) { return fin(err); }
  let waited = 0;
  const poll = () => {
    if (e.size === sz) {
      try {
        assert.strictEqual(e.in, 456000, '长行跨过去之后,后面的行一行不丢');
        assert.strictEqual(e.lastCtx, 456000);
        fin();
      } catch (err) { fin(err); }
      return;
    }
    // 不前进就会一直停在 0 —— 这里不能无限等,等够了就当失败
    if ((waited += 60) > 8000) return fin(new Error('追赶卡住了:size=' + e.size + ' 应为 ' + sz + '(单行比预算长 → 一个字节都没提交 → 原地打转)'));
    setTimeout(poll, 60);
  };
  setTimeout(poll, 60);
});

test('⭐ 锁死之后账本文件被删掉(ENOENT),必须解锁 —— 不然整程一个字节都不落盘', (t, done) => {
  // 第六轮验收 P1-1。链路:① 读账本报非 ENOENT(杀毒/备份占用 EBUSY)
  // ② .bad-* 证据副本也拷不出来(同一个句柄锁,copyFileSync 必然同错)→ writeLocked=true
  // ③ 那个文件随后消失(杀毒隔离就是直接删;或者他看到警告自己把坏账本删了)
  // → 重试那一拍读到 ENOENT,原来只把 loadOk/lockedAt 清零、**没清 writeLocked**,
  // 于是 retry 的前提 `!loadOk && lockedAt>0` 永远不成立、fresh 也不成立(cache 非空),
  // load() 再也进不来 → writeLocked 永远挂着 → 他这一整程的用量一条都不落盘,还是静默的。
  process.env.HUB_LEDGER_RETRY_MS = '200';
  const base = useFixture();
  const rf = fs.readFileSync, cf = fs.copyFileSync;
  const fin = (err) => {
    fs.readFileSync = rf; fs.copyFileSync = cf;
    delete process.env.HUB_LEDGER_RETRY_MS;
    restoreFixture(); try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
    done(err);
  };
  fs.writeFileSync(P.USAGE_CACHE, '{"zz":{"size":1,"in":1,"out":0,"cw":0,"cr":0,"h":{},"slug":"z"}}', 'utf8');
  const dir = path.join(P.CLAUDE_PROJECTS, 'enoent');
  sess('enoent', 's', [asst(321000, 0, 0, '2026-11-11T09:00:00Z')]);
  let busy = true;
  fs.readFileSync = function (p) { if (busy && String(p) === P.USAGE_CACHE) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); return rf.apply(fs, arguments); };
  fs.copyFileSync = function (a) { if (busy && String(a) === P.USAGE_CACHE) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); return cf.apply(fs, arguments); };
  usage.sessionUsage(dir, 's');              // 读失败 + 证据拷不出来 → 锁死
  busy = false; fs.readFileSync = rf; fs.copyFileSync = cf;
  try { fs.rmSync(P.USAGE_CACHE, { force: true }); } catch {}   // 文件被删掉了
  setTimeout(() => {                          // 过了重试间隔
    try {
      fs.appendFileSync(path.join(dir, 's.jsonl'), asst(4000, 0, 0, '2026-11-11T10:00:00Z') + String.fromCharCode(10), 'utf8');
      usage.sessionUsage(dir, 's');
      usage.saveNow();
      assert.ok(fs.existsSync(P.USAGE_CACHE), '账本文件必须被重新写出来(还锁着就一个字节都没有)');
      const j = JSON.parse(fs.readFileSync(P.USAGE_CACHE, 'utf8'));
      assert.ok(j.s, 'ENOENT 之后必须解锁,新数据要能落盘');
      assert.strictEqual(j.s.in, 325000);
      fin();
    } catch (e) { fin(e); }
  }, 320);
});

test('⭐ 末尾半行不许当成「已消费」 —— 那一轮的用量会永久丢', (t) => {
  // 第六轮验收 P2-1。大的 tool_result 行有好几 MB(他最长 5.33MB),官方 appendFile 会拆成多次 write,
  // 读者完全能看到半行。半行 JSON.parse 失败、一个数都不计,而 entry.size 要是照样推到 st.size,
  // 这一行补全之后下一拍从它后面开始读 —— 这一轮的 in/out/cw/cr 永久不计、lastCtx 停在上一轮。
  const base = useFixture();
  t.after(() => { restoreFixture(); try { fs.rmSync(base, { recursive: true, force: true }); } catch {} });
  const dir = path.join(P.CLAUDE_PROJECTS, 'tail');
  const NL = String.fromCharCode(10);
  const full = asst(50000, 0, 0, '2026-11-11T09:10:00Z');
  const half = full.slice(0, 40);                       // 官方才写了一半,没有换行符
  sess('tail', 's', [asst(1000, 0, 0, '2026-11-11T09:00:00Z')]);
  const fp = path.join(dir, 's.jsonl');
  fs.appendFileSync(fp, half, 'utf8');                  // 文件现在以半行结尾
  const e = usage.sessionUsage(dir, 's');
  assert.strictEqual(e.in, 1000, '完整的那一行要算上');
  assert.ok(e.size < fs.statSync(fp).size, 'entry.size 不许推过那半行(推过去它就永远不会被读了)');
  assert.strictEqual(e.lastCtx, 1000);
  // 官方把这一行写完
  fs.appendFileSync(fp, full.slice(40) + NL, 'utf8');
  const e2 = usage.sessionUsage(dir, 's');
  assert.strictEqual(e2.in, 51000, '补全之后那一行必须被算上,一个 token 都不许丢');
  assert.strictEqual(e2.lastCtx, 50000, 'lastCtx 也要跟上(它是红线校准的输入)');
  assert.strictEqual(e2.size, fs.statSync(fp).size);
});

test('⭐ 正在写的半行不许被当成坏尾巴吞掉;真的永久坏了才消费(判据带时间,不是拍数)', (t, done) => {
  // 第六轮这条的判据是「上一拍也扣在这个大小」—— 第七轮验收指出它没有时间成分:
  // 生产里连续两次 parseNew 可以只隔几毫秒(改收尾线会换掉 ctxCache 的 key,2 秒缓存直接被绕过,
  // 立刻再读一次;切项目/切会话/绑会话/关终端同样)。于是正在写的那半行会在 4 毫秒内被吞掉,
  // 那一轮永久不计,而且 lastCtx 停在旧值 → 紧随其后的 compact_boundary 会把一个偏小的假实测点
  // 写进 entry.ac,污染校准唯一的长期数据通道。实测 in 应 501000 实得 1000。
  process.env.HUB_HOLD_MAX_MS = '150';
  const base = useFixture();
  const fin = (err) => {
    delete process.env.HUB_HOLD_MAX_MS;
    restoreFixture(); try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
    done(err);
  };
  const dir = path.join(P.CLAUDE_PROJECTS, 'badtail');
  sess('badtail', 's', [asst(2000, 0, 0, '2026-11-11T09:00:00Z')]);
  const fp = path.join(dir, 's.jsonl');
  const full = asst(500000, 0, 0, '2026-11-11T09:30:00Z');
  fs.appendFileSync(fp, full.slice(0, 40), 'utf8');        // 官方才写了一半
  const sz = fs.statSync(fp).size;
  try {
    const e1 = usage.sessionUsage(dir, 's');
    assert.ok(e1.size < sz, '第一拍:扣着不消费');
    const e2 = usage.sessionUsage(dir, 's');               // 紧接着再来一拍(几毫秒)
    assert.ok(e2.size < sz, '⭐ 几毫秒之内的第二拍也必须继续扣着 —— 这才是「正在写」的常态');
    assert.strictEqual(e2.in, 2000, '半行一个数都不许计');
  } catch (e) { return fin(e); }
  // 情形甲:它其实是正在写 —— 补全之后必须一个 token 都不丢
  setTimeout(() => {
    try {
      fs.appendFileSync(fp, full.slice(40) + String.fromCharCode(10), 'utf8');
      const e3 = usage.sessionUsage(dir, 's');
      assert.strictEqual(e3.in, 502000, '补全之后那一行必须被算上');
      assert.strictEqual(e3.lastCtx, 500000, 'lastCtx 要跟上(它是实测压缩点的输入)');
      assert.strictEqual(e3.size, fs.statSync(fp).size);
    } catch (e) { return fin(e); }
    // 情形乙:换一个会话,半行永远补不全(写到一半被强杀)→ 扣够时间就消费,别每拍白读
    const d2 = path.join(P.CLAUDE_PROJECTS, 'badtail2');
    sess('badtail2', 't', [asst(3000, 0, 0, '2026-11-11T09:00:00Z')]);
    const fp2 = path.join(d2, 't.jsonl');
    fs.appendFileSync(fp2, '{"type":"assistant","message":{"usa', 'utf8');
    const sz2 = fs.statSync(fp2).size;
    const a = usage.sessionUsage(d2, 't');
    try { assert.ok(a.size < sz2, '先扣着'); } catch (e) { return fin(e); }
    setTimeout(() => {                                     // 扣过头了
      try {
        const b = usage.sessionUsage(d2, 't');
        assert.strictEqual(b.size, sz2, '扣够时间、文件也没再长 → 判定永久坏尾,消费掉,别一直白读');
        assert.strictEqual(b.in, 3000, '坏行本身不计任何数');
        fin();
      } catch (e) { fin(e); }
    }, 230);
  }, 20);
});
test('⭐ readSync 读出 0 字节(stat 之后被截短)时,entry.size 不许跳到那个过期的大小', (t) => {
  // 第六轮验收 P3-3。原来 `if (got <= 0) break;` 之后照样 done=true、entry.size=st.size,
  // 把没读过的字节整段跳过去。
  const base = useFixture();
  const real = fs.readSync;
  t.after(() => { fs.readSync = real; restoreFixture(); try { fs.rmSync(base, { recursive: true, force: true }); } catch {} });
  const dir = path.join(P.CLAUDE_PROJECTS, 'shortread');
  sess('shortread', 's', [
    asst(11000, 0, 0, '2026-11-11T09:00:00Z'),
    asst(22000, 0, 0, '2026-11-11T09:10:00Z')
  ]);
  fs.readSync = function () { return 0; };               // 一个字节都读不出来
  const e = usage.sessionUsage(dir, 's');
  fs.readSync = real;
  assert.strictEqual(e.in, 0, '什么都没读到,就什么都不该计');
  assert.strictEqual(e.size, 0, 'entry.size 不许往前跳(跳了这两行就永远读不到了)');
  const e2 = usage.sessionUsage(dir, 's');
  assert.strictEqual(e2.in, 33000, '能读了之后必须一行不丢地补上');
});

test('⭐ 损坏事件进行中:两个备份槽都不许碰', (t) => {
  // loadOk 这道闸管的就是这一段:盘上那份读不出来,它不配当备份源。
  // (第五轮验收 P1-1:不加这个条件,每次因损坏而恢复都必然把好备份覆盖成坏数据。)
  const base = useFixture();
  t.after(() => { restoreFixture(); try { fs.rmSync(base, { recursive: true, force: true }); } catch {} });
  const good = JSON.stringify({ keep: { size: 1, in: 42, out: 0, cw: 0, cr: 0, h: {}, slug: 'k' } });
  fs.writeFileSync(P.USAGE_CACHE + '.bak', good, 'utf8');
  fs.writeFileSync(P.USAGE_CACHE + '.bak2', good, 'utf8');
  fs.writeFileSync(P.USAGE_CACHE, '{"坏了":', 'utf8');
  const dir = path.join(P.CLAUDE_PROJECTS, 'duringbad');
  sess('duringbad', 's', [asst(9000, 0, 0, '2026-11-11T09:00:00Z')]);
  usage.sessionUsage(dir, 's');     // load 失败 → 存 .bad-* → 允许继续写账本
  usage.saveNow();
  usage.saveNow();
  assert.strictEqual(fs.readFileSync(P.USAGE_CACHE + '.bak', 'utf8'), good, '.bak 不许动');
  assert.strictEqual(fs.readFileSync(P.USAGE_CACHE + '.bak2', 'utf8'), good, '.bak2 也不许动');
  const bad = fs.readdirSync(path.dirname(P.USAGE_CACHE)).filter(f => f.indexOf('.bad-') >= 0);
  assert.strictEqual(bad.length, 1, '证据副本留一份');
});
test('⭐ 账本的头号数字(项目列表 tok 列 / 趋势图)要有绝对值断言', (t) => {
  // 第六轮验收 P2-5:原来整套测试里一处绝对值断言都没有 —— `entry.cw += cw` 改成 `+= 0`、
  // 小时桶 `inT+cw+outT` 改成 `inT+outT`、`tot = inT+cr+cw` 改成 `inT+cw`,三个变异全部存活。
  // 1249 那条是「拿值跟自己比」,只能抓被清空,抓不到算得对不对。
  const base = useFixture();
  t.after(() => { restoreFixture(); try { fs.rmSync(base, { recursive: true, force: true }); } catch {} });
  // ⚠️ 别直接用 new Date():行时间戳(T1)和 aggregates() 取今天(T2)之间要是跨过本地午夜,
  //    这一行就落进「昨天 23 点」桶而 today 已经是新的一天 → 断言假红。
  //    窗口只有 1~5 毫秒(每天一次),但钉到本地小时的正中间就有 ~29 分钟余量。第七轮验收指出。
  const _t = new Date(); _t.setMinutes(30, 0, 0);
  const now = _t.toISOString();
  const IN = 13000, CR = 777000, CW = 2500, OUT = 7;   // OUT 是 asst() 里写死的 output_tokens
  const dir = path.join(P.CLAUDE_PROJECTS, 'abs');
  sess('abs', 's', [asst(IN, CR, CW, now)]);
  const e = usage.sessionUsage(dir, 's');
  assert.strictEqual(e.in, IN, 'in');
  assert.strictEqual(e.cr, CR, 'cache_read 要单独记住(它占真实读数的大头)');
  assert.strictEqual(e.cw, CW, 'cache_creation');
  assert.strictEqual(e.out, OUT, 'out');
  assert.strictEqual(e.lastCtx, IN + CR + CW, '瞬时占用口径 = in + cache_read + cache_creation');
  // 项目列表 tok 列读的就是这个:口径 = in + cw + out(不含便宜的缓存读)
  assert.strictEqual(usage.totalsBySlug().abs, IN + CW + OUT, 'totalsBySlug 的绝对值');
  // 🔥 胶囊/趋势图口径:处理量同样是 in + cw + out
  const agg = usage.aggregates();
  assert.strictEqual(agg.today.proc, IN + CW + OUT, 'aggregates().today.proc 的绝对值');
  assert.strictEqual(agg.last5h.proc, IN + CW + OUT, 'aggregates().last5h.proc 的绝对值');
  assert.strictEqual(agg.today.out, OUT, '输出单独一列');
  // ⚠️ 再来一条**不传时钟**的:把 new Date(nowMs || Date.now()) 改成 new Date(nowMs),
  //    aggregates 有上面几条兜住,dailySeries 却没有 —— 而 main.js 调的正是 dailySeries(30)(不传),
  //    一坏就是 Invalid Date → lday() 出 NaN-NaN-NaN → 30 天趋势图全空,还是静默(第八轮 P2-3)。
  const ser0 = usage.dailySeries(2);
  assert.strictEqual(ser0.length, 2, "不传时钟也要给出 2 根柱子");
  assert.ok(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(ser0[1].day), "日期键不能是 NaN-NaN-NaN(实际 " + ser0[1].day + ")");
  assert.strictEqual(ser0[1].proc, IN + CW + OUT, "不传时钟时,今天那根柱子的绝对值");
});

test('⭐ 延后追赶跑完之后,下一次大跳变必须还能再追一次', (t, done) => {
  // 第六轮验收 P2-6:`catchingUp.delete(fp)` 删掉以后全套测试照样绿。
  // 后果正是这套延后机制本来要修的那个 P1:fp 永远留在集合里 →
  // 以后任何一次 >8MB 的跳变都走 `!catchingUp.has(fp)` 的 false 分支被整个跳过,
  // 而且没有任何人会再把它打开 —— 这个会话的用量和实测压缩点从此停更。
  const base = useFixture();
  const fin = (err) => { restoreFixture(); try { fs.rmSync(base, { recursive: true, force: true }); } catch {} done(err); };
  const dir = path.join(P.CLAUDE_PROJECTS, 'twice');
  const NL = String.fromCharCode(10);
  const pad = new Array(2001).join('w');
  const bulk = () => {
    const rows = [];
    for (let i = 0; i < 5500; i++) rows.push(JSON.stringify({ type: 'user', pad: pad }));
    return rows.join(NL) + NL;                     // ≈ 10.5MB > LIGHT_MAX
  };
  sess('twice', 's', [asst(100000, 0, 0, '2026-11-11T09:00:00Z')]);
  const fp = path.join(dir, 's.jsonl');
  fs.appendFileSync(fp, bulk(), 'utf8');
  const e = usage.sessionUsage(dir, 's', true);    // 第一轮:必须延后
  const sz1 = fs.statSync(fp).size;
  const waitFor = (want, next) => {
    let waited = 0;
    const poll = () => {
      if (e.size === want) return next();
      if ((waited += 60) > 15000) return fin(new Error('追赶没跑完: size=' + e.size + ' 应为 ' + want));
      setTimeout(poll, 60);
    };
    setTimeout(poll, 60);
  };
  try { assert.strictEqual(e.size, 0, '前提:第一拍不读盘'); } catch (err) { return fin(err); }
  waitFor(sz1, () => {
    try { assert.strictEqual(e.in, 100000, '第一轮追完:数对'); } catch (err) { return fin(err); }
    // 第二轮:再来一次大跳变
    fs.appendFileSync(fp, bulk() + asst(260000, 0, 0, '2026-11-11T11:00:00Z') + NL, 'utf8');
    const sz2 = fs.statSync(fp).size;
    const e2 = usage.sessionUsage(dir, 's', true);
    waitFor(sz2, () => {
      try {
        assert.strictEqual(e2.in, 360000, '第二轮也必须追上(一行不丢、一行不重)');
        assert.strictEqual(e2.lastCtx, 260000, '实测点要跟着更新');
        fin();
      } catch (err) { fin(err); }
    });
  });
});

test('⭐ 证据副本后来拷成功了,锁必须跟着解开(不然还是整程不落盘)', (t, done) => {
  // 第七轮验收 P1-1。第六轮只堵了 ENOENT 那个出口,这里是第二个:
  // 第 1 拍 EBUSY + 拷贝同错 → 锁死、badSaved=false;
  // 第 2 拍读还是失败(换成永久性的 EIO/坏块),但这次**拷成功了** → 证据安全落地,
  // 而「只置位」的 `if (!saved) writeLocked = true` 不会复位 → 以后每拍都因 badSaved 跳过拷贝
  // → 锁永远挂着。锁的条件该是「**这一刻**还没留下证据」,不是「曾经没留下过」。
  process.env.HUB_LEDGER_RETRY_MS = '150';
  const base = useFixture();
  const rf = fs.readFileSync, cf = fs.copyFileSync;
  const fin = (err) => {
    fs.readFileSync = rf; fs.copyFileSync = cf;
    delete process.env.HUB_LEDGER_RETRY_MS;
    restoreFixture(); try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
    done(err);
  };
  fs.writeFileSync(P.USAGE_CACHE, '{"坏了":', 'utf8');
  const dir = path.join(P.CLAUDE_PROJECTS, 'unlockevi');
  sess('unlockevi', 's', [asst(91000, 0, 0, '2026-11-11T09:00:00Z')]);
  let copyFails = true;
  fs.readFileSync = function (p) { if (String(p) === P.USAGE_CACHE) throw Object.assign(new Error('EIO'), { code: 'EIO' }); return rf.apply(fs, arguments); };
  fs.copyFileSync = function (a) { if (copyFails && String(a) === P.USAGE_CACHE) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); return cf.apply(fs, arguments); };
  usage.sessionUsage(dir, 's');     // 读失败 + 证据也拷不出来 → 锁死
  copyFails = false;                 // 占用过去了,拷贝能成了;但读依然失败
  setTimeout(() => {
    try {
      fs.appendFileSync(path.join(dir, 's.jsonl'), asst(900, 0, 0, '2026-11-11T10:00:00Z') + String.fromCharCode(10), 'utf8');
      usage.sessionUsage(dir, 's');  // 这一拍重试:读还是 EIO,但证据拷成功 → 必须解锁
      usage.saveNow();
      const dirn = path.dirname(P.USAGE_CACHE);
      const bad = fs.readdirSync(dirn).filter(f => f.indexOf('.bad-') >= 0);
      assert.strictEqual(bad.length, 1, '前提:证据副本这次确实存下来了');
      const raw = rf(P.USAGE_CACHE, 'utf8');
      assert.notStrictEqual(raw, '{"坏了":', '证据已经留下,就必须允许继续写 —— 盘上不该还是那份读不出来的原件');
      const j = JSON.parse(raw);
      assert.ok(j.s && j.s.in === 91900, '新数据要落盘(实际 ' + JSON.stringify(j.s && j.s.in) + ')');
      fin();
    } catch (e) { fin(e); }
  }, 260);
});

test('⭐ readSync 抛异常时不许泄漏文件句柄(三处同形代码都要有 finally)', (t) => {
  // 第七轮验收 P2-3。parseNew 本来是对的,sessionTimeline 和 scanCtxTail 当时漏改了:
  // closeSync 写在 try 内部,readSync 一抛句柄就泄漏。scanCtxTail 挂在 15 秒一跳的刷新上,
  // 一次调用窗口放大最多开 4 次句柄 —— 转录被间歇占用时攒到 EMFILE,顶栏彻底读不出数。
  // 实测泄漏 250 个句柄、closeSync 零次。
  const base = useFixture();
  const ro = fs.openSync, rc = fs.closeSync, rr = fs.readSync;
  t.after(() => {
    fs.openSync = ro; fs.closeSync = rc; fs.readSync = rr;
    restoreFixture(); try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
  });
  const dir = path.join(P.CLAUDE_PROJECTS, 'fdleak');
  sess('fdleak', 's', [asst(5000, 0, 0, '2026-11-11T09:00:00Z')]);
  const fp = path.join(dir, 's.jsonl');
  for (const call of [
    ['sessionContext(走 scanCtxTail)', () => usage.sessionContext(dir, 's')],
    ['sessionTimeline', () => usage.sessionTimeline(dir, 's', 10)],
    // parseNew 是最老、最常走的那处,原来反而没进这个循环(第八轮验收 P2-4)
    ['parseNew(走 sessionUsage)', () => usage.sessionUsage(dir, 's')]
  ]) {
    let opens = 0, closes = 0;
    const fds = [];
    fs.openSync = function (p) { const fd = ro.apply(fs, arguments); if (String(p) === fp) { opens++; fds.push(fd); } return fd; };
    fs.closeSync = function (fd) { if (fds.indexOf(fd) >= 0) closes++; return rc.apply(fs, arguments); };
    fs.readSync = function () { throw Object.assign(new Error('EIO'), { code: 'EIO' }); };
    try { call[1](); } catch {}
    fs.readSync = rr; fs.openSync = ro; fs.closeSync = rc;
    assert.ok(opens > 0, call[0] + ':前提是它真的开了句柄(实际 ' + opens + ')');
    assert.strictEqual(closes, opens, call[0] + ':开了 ' + opens + ' 个句柄,只关了 ' + closes + ' 个');
  }
});

test('⭐ 最后一行比窗口还长、而且这一拍还读短了:必须放大窗口重读,不许认输', (t) => {
  // 第七轮验收 P3-6:两处尾读都写成 buf.toString('utf8'),忽略返回值。
  // 文件在 statSync 之后变短(或者读短了)时,Buffer.alloc 留下的零字节会被一起解析进去。
  //
  // ⚠️ 说明:这条用例守的是**放大窗口那条重读路**,不是「按字节截断」那个修复。
  // 查清过:零字节确实会让 scanCtxTail 末尾那个 complete 计数偏 1,但偏不动结果 ——
  // complete 本该为 0 的那唯一一种窗口(整个窗口就是一行的碎片 + 换行),碎片必然大于 64KB,
  // 于是 headHuge 那道检查已经先把它判成「要放大窗口」。两个判据在那一点上重合。
  // ⚠️ 第八轮验收补了一句:上面这个理由**只在满读(n === len)时成立** —— 真短读时碎片可以远小于 64KB,
  // 那种情况下两种写法的差别是「带截断 → complete=0 → 多走几轮放大窗口再认输」对
  // 「不带 → 当场认输」,**最终都返回 null**,所以对外仍然不可观测,只差额外几次读。
  // 另外在 sessionTimeline 那一侧按字节截断是**严格更好**的:文件在 statSync 之后变短时,
  // 零字节会糊掉最后一行 = 最新那一轮从明细里消失。方向是对的,只是这条用例不守它。
  // 所以「按字节截断」是个**等价变异**(测不出来),它的价值是去掉隐患 + 和 lib/data.js 口径一致。
  // 下面是原来那段推理,留着备查:
  // scanCtxTail 末尾要数「这段尾部里有没有哪怕一条完整的行」:
  //   let complete = lines.length - 1;  if (lines[last] === '') complete--;
  // 窗口正好停在换行符上时,最后一个元素本该是空串、complete 减到 0 → sawLine=false
  // → 调用方放大窗口重读(这个兜底专门对付「最后一行比窗口还长」——他贴大图那一轮,
  //    实测他最长的一行 5.33MB)。而带上零字节,最后一个元素不是空串 → complete 停在 1
  // → sawLine=true → **当场认输**,顶栏那一刻读不出数。
  const base = useFixture();
  const rr = fs.readSync;
  t.after(() => { fs.readSync = rr; restoreFixture(); try { fs.rmSync(base, { recursive: true, force: true }); } catch {} });
  const dir = path.join(P.CLAUDE_PROJECTS, 'nulpad');
  const NL2 = String.fromCharCode(10);
  const TAIL = 40;                                  // 末尾这 40 字节假装没读到
  const huge = JSON.stringify({ type: 'user', pad: new Array(700 * 1024).join('z') });
  sess('nulpad', 's', [
    asst(123456, 0, 0, '2026-11-11T09:00:00Z'),     // 要找的就是这条
    huge                                            // 比 512KB 的初始窗口还长
  ]);
  const fp = path.join(dir, 's.jsonl');
  fs.appendFileSync(fp, new Array(TAIL).join('q'), 'utf8');   // 末尾一小截,没有换行
  // 读短 TAIL 字节:于是窗口文本正好停在 huge 那行的换行符上,后面全是 Buffer.alloc 的零字节
  fs.readSync = function (fd, buf, off, len, pos) {
    const n = rr.apply(fs, arguments);
    return Math.max(0, n - TAIL);
  };
  const r = usage.sessionContext(dir, 's');
  fs.readSync = rr;
  assert.ok(r, '⭐ 窗口里一条完整行都没有 → 必须放大窗口重读,不许当场认输');
  assert.strictEqual(r.ctx, 123456, '放大之后要找到那条 assistant 的读数');
});

test('⭐ 短读时尾巴即使是合法 JSON 也不许计(偏移要退回去,算了就等于下一拍重复计)', (t) => {
  // 第七轮验收 P2-8:handleLine(rest) 已经把 rest 计进 entry,而 shortRead 那一支
  // 又把偏移退回 rest 之前 → 下一拍重读同一条记录 → **报高**。
  // 真实触发场景是「statSync 之后文件被外部截短」,所以这里把 statSync 报大一点来复现
  // —— 直接桩 readSync 是造不出短读的:第一次调用就会把整个文件读完,循环根本不会再转。
  const base = useFixture();
  const rs = fs.statSync;
  t.after(() => { fs.statSync = rs; restoreFixture(); try { fs.rmSync(base, { recursive: true, force: true }); } catch {} });
  const dir = path.join(P.CLAUDE_PROJECTS, 'shorttail');
  const NL2 = String.fromCharCode(10);
  sess('shorttail', 's', [
    asst(10000, 0, 0, '2026-11-11T09:00:00Z'),
    asst(20000, 0, 0, '2026-11-11T09:10:00Z')
  ]);
  const fp = path.join(dir, 's.jsonl');
  fs.appendFileSync(fp, asst(40000, 0, 0, '2026-11-11T09:20:00Z'), 'utf8');   // 第三行合法 JSON、没有结尾换行
  const real = rs(fp).size;
  fs.statSync = function (p) { const st = rs.apply(fs, arguments); if (String(p) === fp) { const o = Object.create(st); o.size = real + 50; return o; } return st; };
  const e = usage.sessionUsage(dir, 's');     // 读到真实末尾 → 再读一次返回 0 → shortRead
  fs.statSync = rs;
  assert.ok(e.size < real, '前提:短读时偏移要退回已提交的位置(实际 ' + e.size + ' / ' + real + ')');
  // 第九轮验收 P3-3:这一支和 else 支给的 entry.size 一样,只有 tailHold 不同 ——
  // 不断言它的话,「删掉 tailOk && shortRead 这一支」那条变异就存活(落进 else 会把
  // 那个**偏大的过期 st.size** 记成扣行记号并写进账本 JSON)。
  assert.strictEqual(e.tailHold, undefined, '短读那一支不许记扣行记号(记下来的会是偏大的过期值)');
  const e2 = usage.sessionUsage(dir, 's');
  assert.strictEqual(e2.in, 70000, '三行各算一次,一个 token 都不许多(实际 ' + e2.in + ')');
  assert.strictEqual(e2.size, real);
});
test('⭐ 转录变短重算时,扣半行的记号必须一起清掉', (t) => {
  // 第七轮验收 P2-7:变短重置清了 size/in/out/cw/cr/h/ac/acPre/lastCtx,漏了 tailHold/tailAt。
  // 留着旧记号的后果:转录被重建后恰好等于上次 hold 的字节数时,正在写的半行会被直接吞掉
  // (而且旧的 tailAt 可能已经是几分钟前,时间闸也挡不住)。
  const base = useFixture();
  t.after(() => { restoreFixture(); try { fs.rmSync(base, { recursive: true, force: true }); } catch {} });
  const dir = path.join(P.CLAUDE_PROJECTS, 'holdreset');
  const NL2 = String.fromCharCode(10);
  const full = asst(400000, 0, 0, '2026-11-11T09:30:00Z');
  sess('holdreset', 's', [
    asst(1000, 0, 0, '2026-11-11T09:00:00Z'),
    asst(3000, 0, 0, '2026-11-11T09:10:00Z')
  ]);
  const fp = path.join(dir, 's.jsonl');
  fs.appendFileSync(fp, full.slice(0, 40), 'utf8');
  const e = usage.sessionUsage(dir, 's');
  assert.strictEqual(e.in, 4000, '前提:两行完整的都算上了');
  assert.strictEqual(e.tailHold, fs.statSync(fp).size, '前提:现在扣着半行,记号记的是当前大小');
  assert.ok(e.tailAt > 0, '前提:扣的时刻也记下来了');
  // 转录被重建成更短的一份 → 触发整份重算
  fs.writeFileSync(fp, asst(2000, 0, 0, '2026-11-11T11:00:00Z') + NL2, 'utf8');
  const e2 = usage.sessionUsage(dir, 's');
  assert.strictEqual(e2.in, 2000, '变短 → 从头整份重算');
  assert.strictEqual(e2.tailHold, undefined, '⭐ 旧的扣行记号必须清掉,不许留到下一份转录上');
  assert.strictEqual(e2.tailAt, undefined, '⭐ 扣的时刻也要一起清');
  assert.strictEqual(e2.size, fs.statSync(fp).size);
});
test('⭐ 同一个小时里的多条 assistant 必须相加,不是互相覆盖', (t) => {
  // 第七轮验收 P2-5 里最严重的那条:把 `entry.h[hk] || (entry.h[hk] = {})` 改成
  // `(entry.h[hk] = {})`(每行都重建小时桶,只留本小时最后一条),123 条测试全绿 ——
  // 而真 bug 的话 🔥 胶囊、今日、近 5 小时、近 7 天、30 天趋势图全部只剩真值的几十分之一,还完全静默。
  // 根因是 aggregates()/dailySeries() 原来用 new Date(),测试没法钉时钟;现在加了 nowMs 形参。
  const base = useFixture();
  t.after(() => { restoreFixture(); try { fs.rmSync(base, { recursive: true, force: true }); } catch {} });
  // 钉在本地时间某天的 12:00,前后都留足余量(不要贴午夜,否则跨天会假红)
  // ⚠️ 锚点必须是一个**固定的过去日期**,不能是「今天」:
  // 原来写的 2026-11-11 恰好就是当天,于是「忽略 nowMs、永远用 Date.now()」这个变异侥幸存活,
  // 而且用例的成败会跟着运行日期漂(第八轮验收 P2-3 附带)。
  // 2026-05-20 在太平洋夏令时中段,离春秋两次跳钟都远。
  const anchor = new Date(2026, 4, 20, 12, 0, 0, 0);
  const at = (h, m) => new Date(2026, 4, 20, h, m, 0, 0).toISOString();
  const dir = path.join(P.CLAUDE_PROJECTS, 'buckets');
  sess('buckets', 's', [
    asst(1000, 0, 100, at(12, 5)),     // 本小时第一条
    asst(2000, 0, 200, at(12, 40)),    // 本小时第二条 —— 覆盖式写法会把上一条吃掉
    asst(4000, 0, 400, at(9, 30)),     // 3 小时前:在 5 小时窗内
    asst(8000, 0, 800, at(3, 30))      // 8.5 小时前:在窗外,但还是今天
  ]);
  usage.sessionUsage(dir, 's');
  const O = 7;                          // asst() 里写死的 output_tokens
  const one = (i, c) => i + c + O;
  const agg = usage.aggregates(anchor.getTime());
  assert.strictEqual(agg.last5h.proc, one(1000, 100) + one(2000, 200) + one(4000, 400),
    '近 5 小时 = 12 点那两条相加 + 9 点那条(3 点那条在窗外)');
  assert.strictEqual(agg.today.proc, one(1000, 100) + one(2000, 200) + one(4000, 400) + one(8000, 800),
    '今日 = 四条全算上');
  assert.strictEqual(agg.today.out, O * 4, '今日输出 = 四条的 output');
  assert.strictEqual(agg.last5h.out, O * 3, '近 5 小时输出 = 三条');
  // 按模型那块面板读的是 models
  const mk = Object.keys(agg.models);
  assert.strictEqual(mk.length, 1, '一个模型一个 key(实际 ' + mk.join(',') + ')');
  assert.strictEqual(agg.models[mk[0]], one(1000, 100) + one(2000, 200) + one(4000, 400) + one(8000, 800),
    '按模型的合计也要相加');
  // 趋势图
  const ser = usage.dailySeries(7, anchor.getTime());
  const today = ser[ser.length - 1];
  assert.strictEqual(today.proc, agg.today.proc, '趋势图最后一根柱子要和「今日」一致');
  assert.strictEqual(ser.length, 7, '要 7 根柱子');
});

test('⭐ 跨天的那条不许算进「今日」,窗外的那条不许算进「近 5 小时」', (t) => {
  // 和上一条配对:上面钉住「该算的都算上」,这条钉住「不该算的别混进来」。
  // `if (day === today)` 改成 `if (true)`、`if (keys5.has(hk))` 改成 `if (true)`、
  // 5 小时窗口改成 4 小时,这三个变异原来全部存活。
  const base = useFixture();
  t.after(() => { restoreFixture(); try { fs.rmSync(base, { recursive: true, force: true }); } catch {} });
  const anchor = new Date(2026, 4, 20, 12, 0, 0, 0);
  const dir = path.join(P.CLAUDE_PROJECTS, 'edges');
  sess('edges', 's', [
    asst(1000, 0, 0, new Date(2026, 4, 20, 12, 10, 0, 0).toISOString()),   // 今天、窗内
    asst(2000, 0, 0, new Date(2026, 4, 20, 8, 10, 0, 0).toISOString()),    // 今天、4 小时前(窗内)
    asst(4000, 0, 0, new Date(2026, 4, 19, 23, 10, 0, 0).toISOString()),   // 昨天
    asst(8000, 0, 0, new Date(2026, 4, 13, 12, 10, 0, 0).toISOString())     // 7 天前(周窗外)
  ]);
  usage.sessionUsage(dir, 's');
  const O = 7;
  const agg = usage.aggregates(anchor.getTime());
  assert.strictEqual(agg.today.proc, (1000 + O) + (2000 + O), '今日只算今天那两条');
  assert.strictEqual(agg.last5h.proc, (1000 + O) + (2000 + O), '近 5 小时:12 点和 8 点都在「当前小时+前 4 小时」里');
  assert.strictEqual(agg.week.proc, (1000 + O) + (2000 + O) + (4000 + O), '近 7 天含昨天,不含 7 天前那条');
  const ser = usage.dailySeries(7, anchor.getTime());
  const byDay = {}; for (const d of ser) byDay[d.day] = d.proc;
  const keys = Object.keys(byDay).sort();
  assert.strictEqual(byDay[keys[keys.length - 1]], (1000 + O) + (2000 + O), '趋势图今天那根');
  assert.strictEqual(byDay[keys[keys.length - 2]], 4000 + O, '趋势图昨天那根');
});

test('⭐ 账本读不出来时,备份里的孤儿条目必须被补回来(这是整条链子的根因修法)', (t) => {
  // 第十轮验收 P1-1 的根因。前五轮(五~九)都在修「备份该怎么选」,而真正的病根是:
  // 任何一次损坏之后 cache={},warmup 只能按**还在盘上的转录**重建 —— 他 229 条里只有 194 条
  // 还有转录,剩下 35 条孤儿占 14.3% 字节、**16.4% 累计 token(173.8 亿)**,从此永久消失。
  // 账本一变差,后面不管怎么挑备份都是在挑残次品。补回来之后账本**不会变差**,
  // 「好备份被更差的数据顶掉」这个形状就不存在了。
  process.env.HUB_BAK_EVERY_MS = '0';
  const base = useFixture();
  t.after(() => {
    delete process.env.HUB_BAK_EVERY_MS;
    restoreFixture(); try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
  });
  // 备份里有三条「转录已经不在盘上」的孤儿
  const orphans = {};
  for (let i = 0; i < 3; i++) orphans['gone' + i] = { size: 9, in: 1000000 + i, out: 5, cw: 7, cr: 9, h: {}, slug: 'g' + i, ac: 123 };
  fs.writeFileSync(P.USAGE_CACHE + '.bak', JSON.stringify(orphans), 'utf8');
  // 账本本身坏掉(损坏那条路),而且盘上只有一个会话的转录
  fs.writeFileSync(P.USAGE_CACHE, '{"坏了":', 'utf8');
  const dir = path.join(P.CLAUDE_PROJECTS, 'merge');
  sess('merge', 's', [asst(8000, 0, 0, '2026-11-11T09:00:00Z')]);
  const e = usage.sessionUsage(dir, 's');
  assert.strictEqual(e.in, 8000, '新会话照常算');
  usage.saveNow();
  const j = JSON.parse(fs.readFileSync(P.USAGE_CACHE, 'utf8'));
  for (let i = 0; i < 3; i++) {
    assert.ok(j['gone' + i], '⭐ 孤儿条目 gone' + i + ' 必须被补回账本(它的转录已经不在盘上,只有备份里还有)');
    assert.strictEqual(j['gone' + i].in, 1000000 + i, '补回来的数值要原样');
    assert.strictEqual(j['gone' + i].ac, 123, 'ac 这类字段也要带回来');
  }
  assert.ok(j.s && j.s.in === 8000, '新会话也在');
  // 注意:这一程账本是读不出来的(loadOk=false),所以**本来就不该做任何备份** ——
  // 盘上那份不配当备份源(第五轮 P1-1 那道闸)。这里顺手把它钉住。
  assert.ok(!fs.existsSync(P.USAGE_CACHE + '.bak2'), '损坏进行中不许碰备份槽');
  assert.strictEqual(fs.readFileSync(P.USAGE_CACHE + '.bak', 'utf8'), JSON.stringify(orphans), '.bak 也不许动');
  // 已经算出来的条目不许被备份里的旧值盖掉
  const stale = { s: { size: 1, in: 1, out: 1, cw: 1, cr: 1, h: {}, slug: 'merge' } };
  fs.writeFileSync(P.USAGE_CACHE + '.bak2', JSON.stringify(stale), 'utf8');
  const e2 = usage.sessionUsage(dir, 's');
  assert.strictEqual(e2.in, 8000, '⭐ 只补**缺的**键,绝不覆盖算出来的值');
});

test('⭐ 账本缺了备份里的键时,最全那份不许被覆盖(高水位判据看键集合,不看字节数)', (t) => {
  // 字节数两头都错(第十轮验收 P1-1 实测):
  //   · 「更大但更差」:损坏后重建的残本熬过约 25 天就能靠新用量把字节数长回去 → 放行覆盖;
  //   · 「更好但更小」:变短重算清掉一条的 h 之后,键集合完整、数字最新,却比三个月前那份小。
  // 换键数 / token 总和也救不了(都是 26~28 天同一个数量级)。只有「集合包含」不会误放行。
  process.env.HUB_BAK_EVERY_MS = '0';
  const base = useFixture();
  t.after(() => {
    delete process.env.HUB_BAK_EVERY_MS;
    restoreFixture(); try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
  });
  const dir = path.join(P.CLAUDE_PROJECTS, 'superset');
  sess('superset', 's', [asst(3000, 0, 0, '2026-11-11T09:00:00Z')]);
  usage.sessionUsage(dir, 's');
  usage.saveNow();
  // 现在**事后**放一份 .bak:里面有一个账本没有的键,而且字节数比账本大得多
  // (load 已经跑过,所以不会被 mergeBackups 补进来 —— 这正是要守的那个状态)
  const bigger = { s: { size: 1, in: 1, out: 0, cw: 0, cr: 0, h: {}, slug: 'superset' } };
  for (let i = 0; i < 40; i++) bigger['extra' + i] = { size: 1, in: 500 + i, out: 0, cw: 0, cr: 0, h: {}, slug: 'x' + i };
  const raw = JSON.stringify(bigger);
  fs.writeFileSync(P.USAGE_CACHE + '.bak', raw, 'utf8');
  assert.ok(raw.length > fs.statSync(P.USAGE_CACHE).size, '前提:.bak 比账本大');
  usage.saveNow();
  assert.strictEqual(fs.readFileSync(P.USAGE_CACHE + '.bak', 'utf8'), raw,
    '⭐ 账本缺了 .bak 里的 40 个键 → 一个字节都不许动它');
  assert.ok(fs.existsSync(P.USAGE_CACHE + '.bak2'), '近期槽照刷,新数据不许没人管');
  const b2 = JSON.parse(fs.readFileSync(P.USAGE_CACHE + '.bak2', 'utf8'));
  assert.ok(b2.s && b2.s.in === 3000, '.bak2 装的是最新那份');
  // 反面:.bak 的键集合是账本的子集时,必须刷新(不然备份永远停在老地方)
  const sub = JSON.stringify({ s: { size: 1, in: 1, out: 0, cw: 0, cr: 0, h: {}, slug: 'superset' } });
  fs.writeFileSync(P.USAGE_CACHE + '.bak', sub, 'utf8');
  usage.saveNow();
  const after = fs.readFileSync(P.USAGE_CACHE + '.bak', 'utf8');
  assert.notStrictEqual(after, sub, '⭐ 账本的键集合覆盖得住 .bak 时,.bak 必须刷新');
  assert.strictEqual(after, fs.readFileSync(P.USAGE_CACHE, 'utf8'), '.bak 要和盘上那份一致');
});
test('⭐ 证据副本要认文件身份:盘上换成另一份坏的,必须再留一份', (t, done) => {
  // 第八轮验收 P3-3。只认布尔值的话:他看到数字不对、手动把 .bak 拷回来,
  // 而这一刻文件仍读不出来(占用还没过去)→ 第二拍既不给新内容留证据,
  // 又因为旧标记解锁 → 把他刚恢复的好数据覆盖掉。
  process.env.HUB_LEDGER_RETRY_MS = '150';
  const base = useFixture();
  const realCopy = fs.copyFileSync;
  const fin = (err) => {
    fs.copyFileSync = realCopy;
    delete process.env.HUB_LEDGER_RETRY_MS;
    restoreFixture(); try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
    done(err);
  };
  let copies = 0;
  fs.copyFileSync = function (a, b) { if (String(b).indexOf('.bad-') >= 0) copies++; return realCopy.apply(fs, arguments); };
  fs.writeFileSync(P.USAGE_CACHE, '{"第一份坏的":', 'utf8');
  const dir = path.join(P.CLAUDE_PROJECTS, 'sigevi');
  sess('sigevi', 's', [asst(6000, 0, 0, '2026-11-11T09:00:00Z')]);
  usage.sessionUsage(dir, 's');
  try { assert.strictEqual(copies, 1, '第一份:留一份证据'); } catch (e) { return fin(e); }
  setTimeout(() => {
    try {
      usage.sessionUsage(dir, 's');
      assert.strictEqual(copies, 1, '同一份文件重试,不许再攒副本');
      // 换成另一份坏的(内容和长度都不同)
      fs.writeFileSync(P.USAGE_CACHE, '{"换成另一份坏的,长度也不一样":[1,2,3,4,5', 'utf8');
    } catch (e) { return fin(e); }
    setTimeout(() => {
      try {
        usage.sessionUsage(dir, 's');
        assert.strictEqual(copies, 2, '⭐ 盘上换了一份 → 必须为新内容再留一份证据(实际 ' + copies + ')');
        fin();
      } catch (e) { fin(e); }
    }, 200);
  }, 200);
});

test('⭐ 扣半行的宽限期默认值(不设 env 也得是分钟级,不能是 0)', (t, done) => {
  // 第八轮验收 P2-1:唯一关心这段的用例自己设了 HUB_HOLD_MAX_MS,
  // 所以 holdMaxMs() 的**默认 60 秒**完全没人钉 —— 改成 0 全套绿,
  // 而默认值一旦是 0,第二拍(毫秒级)就把正在写的半行当坏尾吞掉 = 第七轮 P2-1 原样复发。
  // 参考:他一条 5.33MB 的行追加实测 5~7ms,60 秒是最坏值的约 8000 倍,余量充足。
  delete process.env.HUB_HOLD_MAX_MS;            // 就是要走默认值
  const base = useFixture();
  const fin = (err) => { restoreFixture(); try { fs.rmSync(base, { recursive: true, force: true }); } catch {} done(err); };
  const dir = path.join(P.CLAUDE_PROJECTS, 'holddef');
  sess('holddef', 's', [asst(1000, 0, 0, '2026-11-11T09:00:00Z')]);
  const fp = path.join(dir, 's.jsonl');
  const full = asst(700000, 0, 0, '2026-11-11T09:30:00Z');
  fs.appendFileSync(fp, full.slice(0, 40), 'utf8');
  const sz = fs.statSync(fp).size;
  const e = usage.sessionUsage(dir, 's');
  try { assert.ok(e.size < sz, '第一拍扣着'); } catch (err) { return fin(err); }
  setTimeout(() => {
    try {
      const e2 = usage.sessionUsage(dir, 's');
      assert.ok(e2.size < sz, '⭐ 200 毫秒之后(没设 env)必须还在扣着 —— 默认宽限期不能是 0');
      assert.strictEqual(e2.in, 1000, '半行一个数都不许计');
      fin();
    } catch (err) { fin(err); }
  }, 200);
});

test('⭐ 文件又长了就说明还在写:哪怕扣过了期也不许消费那半行', (t, done) => {
  // 第八轮验收 P2-2:把 `entry.tailHold === st.size &&` 从过期分支里删掉照样全绿。
  // 它**不是等价变异** —— 真实触发:记号落下后他切去别的项目十分钟(这个会话没人读),
  // 回来时 st.size 已经变了、而 tailAt 是十分钟前 → 立刻吞掉正在写的那半行。
  process.env.HUB_HOLD_MAX_MS = '120';
  const base = useFixture();
  const fin = (err) => {
    delete process.env.HUB_HOLD_MAX_MS;
    restoreFixture(); try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
    done(err);
  };
  const dir = path.join(P.CLAUDE_PROJECTS, 'grewagain');
  sess('grewagain', 's', [asst(2000, 0, 0, '2026-11-11T09:00:00Z')]);
  const fp = path.join(dir, 's.jsonl');
  const full = asst(600000, 0, 0, '2026-11-11T09:30:00Z');
  fs.appendFileSync(fp, full.slice(0, 30), 'utf8');
  const e = usage.sessionUsage(dir, 's');
  try { assert.ok(e.size < fs.statSync(fp).size, '先扣着'); } catch (err) { return fin(err); }
  setTimeout(() => {                                  // 扣过头了
    try {
      fs.appendFileSync(fp, full.slice(30, 60), 'utf8');   // 但文件又长了 → 还在写
      const sz = fs.statSync(fp).size;
      const e2 = usage.sessionUsage(dir, 's');
      assert.ok(e2.size < sz, '⭐ 文件又长了就是还在写,过期也不许消费(实际 size=' + e2.size + '/' + sz + ')');
      assert.strictEqual(e2.in, 2000, '半行一个数都不许计');
      // 补全之后必须一个 token 不丢
      fs.appendFileSync(fp, full.slice(60) + String.fromCharCode(10), 'utf8');
      const e3 = usage.sessionUsage(dir, 's');
      assert.strictEqual(e3.in, 602000, '补全之后要算上');
      assert.strictEqual(e3.tailHold, undefined, '干净收尾时记号要清掉(别留在账本 JSON 里)');
      assert.strictEqual(e3.tailAt, undefined);
      fin();
    } catch (err) { fin(err); }
  }, 200);
});

test('⭐ light 延后那条路上变短重算,旧的扣行记号也不许活下来', (t, done) => {
  // 第八轮验收对「claim (a)」的反驳,我接受:我原来论证「变短重置里的 clearHold 是等价变异」,
  // 漏了 done === false 那条早退 —— light 模式下「变短 + 单拍预算用光」时 return false
  // 发生在循环内部,`if (done)` 整块被跳过,旧记号就活过了这次调用,
  // 而且会被 saveNow() 写进账本、跨进程存活(指向一份已经不存在的转录)。
  const base = useFixture();
  const fin = (err) => { restoreFixture(); try { fs.rmSync(base, { recursive: true, force: true }); } catch {} done(err); };
  const dir = path.join(P.CLAUDE_PROJECTS, 'shrinklight');
  const NL = String.fromCharCode(10);
  const pad = new Array(2001).join('y');
  const bulk = (n) => { const r = []; for (let i = 0; i < n; i++) r.push(JSON.stringify({ type: 'user', pad: pad })); return r.join(NL) + NL; };
  const full = asst(300000, 0, 0, '2026-11-11T09:30:00Z');
  sess('shrinklight', 's', [asst(5000, 0, 0, '2026-11-11T09:00:00Z')]);
  const fp = path.join(dir, 's.jsonl');
  fs.appendFileSync(fp, bulk(6500), 'utf8');          // ≈ 12.5MB
  fs.appendFileSync(fp, full.slice(0, 40), 'utf8');   // 以半行结尾 → 记号落下
  usage.sessionUsage(dir, 's');                        // 非 light:整份读完,留下记号
  const e = usage.sessionUsage(dir, 's');
  try {
    assert.ok(e.tailHold > 0, '前提:记号已经落下(实际 ' + e.tailHold + ')');
  } catch (err) { return fin(err); }
  // 转录被重建成更短的一份,但仍然很大 → light 走延后,第一拍只读 8MB 就让出
  fs.writeFileSync(fp, asst(7000, 0, 0, '2026-11-11T11:00:00Z') + NL + bulk(5200), 'utf8');
  const sz = fs.statSync(fp).size;
  usage.sessionUsage(dir, 's', true);
  // light + 变短 → 走延后,parseNew 还没跑(重置在下一拍里),所以不能在这儿就断言。
  // 要等**第一拍落地之后**再看 —— 那一拍 return false 发生在循环内部、末尾那段「推到哪」被整个跳过,
  // 正是旧记号可能活下来的那一刻。
  let waited = 0, checked = false;
  const poll = () => {
    if (!checked && e.size > 0) {
      checked = true;
      try {
        assert.strictEqual(e.tailHold, undefined, '⭐ 第一拍(还没读完)之后旧记号就不许还在 —— done=false 那条早退会让它活下来并落盘');
        assert.strictEqual(e.tailAt, undefined);
      } catch (err) { return fin(err); }
    }
    if (e.size === sz) {
      try {
        assert.ok(checked, '前提:确实观察到了「读了一部分还没读完」那一拍');
        assert.strictEqual(e.in, 7000, '追完之后数对');
        fin();
      } catch (err) { fin(err); }
      return;
    }
    if ((waited += 15) > 15000) return fin(new Error('追赶没跑完: ' + e.size + '/' + sz));
    setTimeout(poll, 15);
  };
  setTimeout(poll, 5);
});

test('⭐ 短读 + 半行尾巴 + 记号过期:偏移绝不许推到那个「偏大的」文件大小上', (t, done) => {
  // 第八轮验收 P3-1。`!tailOk && shortRead` 这个组合会落进「过期消费」那一支
  // (前两支都要求 tailOk)。而短读时 st.size 是 statSync 留下的**过期大值** ——
  // 让这一支消费掉就等于把从未读到的字节整段跳过去,那几轮用量永久不计。
  process.env.HUB_HOLD_MAX_MS = '120';
  const base = useFixture();
  const rs = fs.statSync;
  const fin = (err) => {
    fs.statSync = rs;
    delete process.env.HUB_HOLD_MAX_MS;
    restoreFixture(); try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
    done(err);
  };
  const dir = path.join(P.CLAUDE_PROJECTS, 'shorthold');
  const NL = String.fromCharCode(10);
  sess('shorthold', 's', [asst(3000, 0, 0, '2026-11-11T09:00:00Z')]);
  const fp = path.join(dir, 's.jsonl');
  const full = asst(900000, 0, 0, '2026-11-11T09:30:00Z');
  fs.appendFileSync(fp, full.slice(0, 35), 'utf8');      // 以半行结尾
  const real = rs(fp).size;
  const INFLATE = 120;
  // statSync 一直报一个偏大的值 → 读到真实末尾之后再读一次得到 0 → shortRead
  fs.statSync = function (p) {
    const st = rs.apply(fs, arguments);
    if (String(p) === fp) { const o = Object.create(st); o.size = real + INFLATE; return o; }
    return st;
  };
  const e = usage.sessionUsage(dir, 's');
  try {
    assert.strictEqual(e.in, 3000, '完整那一行要算上');
    assert.ok(e.size < real, '第一拍:偏移只许停在已提交的位置');
    assert.strictEqual(e.tailHold, real + INFLATE, '前提:记号记下的是那个偏大的值');
  } catch (err) { return fin(err); }
  setTimeout(() => {                                      // 让记号过期
    try {
      const e2 = usage.sessionUsage(dir, 's');
      assert.ok(e2.size <= real,
        '⭐ 偏移绝不许推到偏大的 ' + (real + INFLATE) + ' 上(实际 ' + e2.size + ',真实文件 ' + real + ')');
      // 恢复真实的 statSync:剩下的字节必须还能被读到
      fs.statSync = rs;
      fs.appendFileSync(fp, full.slice(35) + NL, 'utf8');
      const e3 = usage.sessionUsage(dir, 's');
      assert.strictEqual(e3.in, 903000, '补全之后一个 token 都不许丢');
      fin();
    } catch (err) { fin(err); }
  }, 200);
});

test('⭐ 量备份槽时失败要「关闸」不是「放行」(只有确实不存在才算放行)', (t) => {
  // 第九轮验收 P2-1。这个模块的立论就是「Windows 上杀毒/备份软件会短暂占用这个目录的文件」,
  // 而原来量 .bak 用的是裸 catch {} —— EBUSY/EPERM/EIO 一起吞掉,
  // .bak 正被占着的那一刻这道闸悄悄消失,残本直接覆盖好 .bak。
  // 本文件其它所有错误路径都是「失败即关闸」,只有这一处相反。
  // ⚠️ 第十轮判据从「量字节数」换成「读内容比键集合」,所以这里桩的是 readFileSync。
  process.env.HUB_BAK_EVERY_MS = '0';
  const base = useFixture();
  const rf = fs.readFileSync;
  t.after(() => {
    fs.readFileSync = rf;
    delete process.env.HUB_BAK_EVERY_MS;
    restoreFixture(); try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
  });
  const dir = path.join(P.CLAUDE_PROJECTS, 'statbusy');
  sess('statbusy', 's', [asst(5500, 0, 0, '2026-11-11T09:00:00Z')]);
  usage.sessionUsage(dir, 's');
  usage.saveNow();
  const good = JSON.stringify({ keep: { size: 1, in: 777, out: 0, cw: 0, cr: 0, h: {}, slug: 'k' } });
  fs.writeFileSync(P.USAGE_CACHE + '.bak', good, 'utf8');
  // 读 .bak 的那一下报 EBUSY(文件在那儿,只是被占着)
  fs.readFileSync = function (p) {
    if (String(p) === P.USAGE_CACHE + '.bak') throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
    return rf.apply(fs, arguments);
  };
  usage.saveNow();
  fs.readFileSync = rf;
  assert.strictEqual(fs.readFileSync(P.USAGE_CACHE + '.bak', 'utf8'), good,
    '⭐ 读不出来就不许动它 —— 占用是常态,不是「没有旧备份」');
  assert.ok(fs.existsSync(P.USAGE_CACHE + '.bak2'), '近期槽照刷,不受影响');
});
test('⭐ 备份必须先拷到 .tmp 再 rename;失败要清掉 tmp;而且不许连账本一起不写', (t) => {
  // 三件事一条用例:
  //  ① 机制:账本本身坚持原子写,而「最后一道防线」的备份原来是裸 copyFileSync ——
  //     磁盘满 / 中途被强杀就留下半截的 .bak,正是「好备份被更差的数据顶掉」那一族(第九轮 P2-2)。
  //     ⚠️ 上一版只断言「没有 .tmp 残留」,而直写也不会产生 .tmp,所以照样绿 —— 等于没测。
  //     要数 copyFileSync 的目标是不是 .tmp、后面有没有跟一次 rename。
  //  ② rename 失败要把 tmp 清掉(上一版让 copyFileSync 抛,tmp 压根没造出来,也没测到)。
  //  ③ 备份这一步失败,账本本身仍然必须落盘(验收把跳过备份写成 return 放在 writeCache 里,
  //     会把账本的原子写一起跳掉,而 136 条用例照样全绿)。
  process.env.HUB_BAK_EVERY_MS = '0';
  const base = useFixture();
  const rc = fs.copyFileSync, rr = fs.renameSync, ru = fs.unlinkSync;
  t.after(() => {
    fs.copyFileSync = rc; fs.renameSync = rr; fs.unlinkSync = ru;
    delete process.env.HUB_BAK_EVERY_MS;
    restoreFixture(); try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
  });
  const dir = path.join(P.CLAUDE_PROJECTS, 'bakatomic');
  sess('bakatomic', 's', [asst(4321, 0, 0, '2026-11-11T09:00:00Z')]);
  usage.sessionUsage(dir, 's');
  usage.saveNow();   // 先让账本文件存在 —— 第一拍它还不存在,statSync 抛,整段备份会被跳过
  // ---- ① 机制
  const copies = [], renames = [];
  fs.copyFileSync = function (a, b) { if (String(b).indexOf('.bak') >= 0) copies.push(String(b)); return rc.apply(fs, arguments); };
  fs.renameSync = function (a, b) { if (String(b).indexOf('.bak') >= 0) renames.push([String(a), String(b)]); return rr.apply(fs, arguments); };
  usage.saveNow();
  fs.copyFileSync = rc; fs.renameSync = rr;
  assert.ok(copies.length >= 1, '前提:这一拍确实做了备份');
  for (const c of copies) assert.ok(/[.]tmp$/.test(c), '⭐ 拷贝的目标必须是 .tmp(实际 ' + c + ')');
  assert.strictEqual(renames.length, copies.length, '⭐ 每一次拷贝后面都要跟一次 rename');
  for (const [a, b] of renames) assert.strictEqual(a, b + '.tmp', 'rename 的来源就是刚拷的那个 tmp');
  assert.ok(fs.existsSync(P.USAGE_CACHE + '.bak'), '备份文件要真的落地');
  // ---- ② rename 失败 → tmp 必须被清掉
  const unlinked = [];
  fs.renameSync = function (a, b) { if (String(b).indexOf('.bak') >= 0) throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); return rr.apply(fs, arguments); };
  fs.unlinkSync = function (p) { unlinked.push(String(p)); return ru.apply(fs, arguments); };
  usage.saveNow();
  fs.renameSync = rr; fs.unlinkSync = ru;
  assert.ok(unlinked.some(p => /[.]tmp$/.test(p)), '⭐ rename 失败后要把 tmp 清掉(实际清了: ' + unlinked.join(',') + ')');
  assert.ok(!fs.existsSync(P.USAGE_CACHE + '.bak.tmp'), '不许留下 .tmp 残骸');
  assert.ok(!fs.existsSync(P.USAGE_CACHE + '.bak2.tmp'));
  // ---- ③ 备份彻底失败也不许连账本一起不写
  // ⚠️ 这里**不能**先把账本删掉:那样 statSync 会先抛,整段备份在到达「跳过」那一步之前就跳出去了,
  //    于是「把账本的原子写也一起跳掉」这个变异反而测不到。改成让账本**有新内容要写**。
  fs.appendFileSync(path.join(dir, 's.jsonl'), asst(1000, 0, 0, '2026-11-11T10:00:00Z') + String.fromCharCode(10), 'utf8');
  usage.sessionUsage(dir, 's');
  fs.copyFileSync = function () { throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }); };
  usage.saveNow();
  fs.copyFileSync = rc;
  assert.ok(fs.existsSync(P.USAGE_CACHE), '备份失败不许连账本一起不写');
  const j = JSON.parse(fs.readFileSync(P.USAGE_CACHE, 'utf8'));
  assert.strictEqual(j.s && j.s.in, 5321, '⭐ 备份这一步失败时,账本的新数据必须照样落盘');
});
test('⭐ closeSync 自己抛异常时,解析结果不许跟着丢(三处尾读都要包一层)', (t) => {
  // 第九轮验收 P3-4:把三处 finally 里的内层 try 全拆掉,136 条用例照样全绿。
  // ⚠️ 上一版这条也是空的:异常会被 sessionUsage 的 catch {} 吞掉,而夹具最后一行**带换行符**
  //    → entry.size 靠逐行提交已经到位,`if (done) entry.size = st.size` 那句跳不跳都一样。
  //    必须让最后一行**不带换行符**:那时 committed < st.size,这句才是唯一把偏移推到位的地方,
  //    跳掉就等于下一拍把最后那条记录**重读一遍 = 重复计数**。
  const base = useFixture();
  const rcl = fs.closeSync;
  t.after(() => { fs.closeSync = rcl; restoreFixture(); try { fs.rmSync(base, { recursive: true, force: true }); } catch {} });
  const dir = path.join(P.CLAUDE_PROJECTS, 'closethrow');
  sess('closethrow', 's', [asst(12000, 0, 0, '2026-11-11T09:00:00Z')]);
  const fp = path.join(dir, 's.jsonl');
  fs.appendFileSync(fp, asst(34000, 0, 0, '2026-11-11T09:10:00Z'), 'utf8');   // 没有结尾换行
  const want = fs.statSync(fp).size;
  const boom = () => { fs.closeSync = function (fd) { try { rcl.apply(fs, arguments); } catch {} throw Object.assign(new Error('EBADF'), { code: 'EBADF' }); }; };
  boom();
  let threw = null, e = null;
  try { e = usage.sessionUsage(dir, 's'); } catch (err) { threw = err; }
  fs.closeSync = rcl;
  assert.strictEqual(threw, null, 'closeSync 抛了不许把异常顶出 sessionUsage');
  assert.strictEqual(e.in, 46000, '两行都要算上');
  assert.strictEqual(e.size, want, '⭐ entry.size 必须照样推到位(不然下一拍会把最后那条重读一遍)');
  const e2 = usage.sessionUsage(dir, 's');
  assert.strictEqual(e2.in, 46000, '⭐ 再读一拍不许重复计数');
  // 另两处尾读:同样不许把异常顶出去
  // ⚠️ 另两处不能断言「没抛出来」—— 它们各自有 catch 兜底(scanCtxTail 返回 {hit:null},
  //    sessionTimeline 返回空数组),所以不包内层 try 也不会把异常顶出去,只是**结果退化成空**。
  //    要断言的是**拿到了真数据**。
  boom();
  let r1 = null, rows = null, t1 = null, t2 = null;
  try { r1 = usage.sessionContext(dir, 's'); } catch (err) { t1 = err; }
  try { rows = usage.sessionTimeline(dir, 's', 5); } catch (err) { t2 = err; }
  fs.closeSync = rcl;
  assert.strictEqual(t1, null, 'sessionContext 不许把异常顶出来');
  assert.strictEqual(t2, null, 'sessionTimeline 不许把异常顶出来');
  assert.ok(r1 && r1.ctx === 34000, '⭐ sessionContext 要拿到真读数,不许退化成 null(实际 ' + JSON.stringify(r1) + ')');
  assert.ok(rows && rows.length > 0, '⭐ sessionTimeline 要拿到真明细,不许退化成空数组');
});
test('⭐ 证据签名两个分量都要算:只看长度 / 只看时间都不行', (t, done) => {
  // 第九轮验收对「认文件身份」那条的补强。上一版只造了「内容和长度都变」,
  // 所以 size-only 和 mtime-only 两个变异各自都没被钉住。这一版两头都夹:
  //   甲 换一份**等长**的坏文件(只看长度 → 漏);
  //   乙 换一份**长度不同、但把 mtime 改回原值**的(只看时间 → 漏)。
  process.env.HUB_LEDGER_RETRY_MS = '120';
  const base = useFixture();
  const realCopy = fs.copyFileSync;
  const fin = (err) => {
    fs.copyFileSync = realCopy;
    delete process.env.HUB_LEDGER_RETRY_MS;
    restoreFixture(); try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
    done(err);
  };
  let copies = 0;
  fs.copyFileSync = function (a, b) { if (String(b).indexOf('.bad-') >= 0) copies++; return realCopy.apply(fs, arguments); };
  const FIXED = new Date(Math.floor(Date.now() / 1000) * 1000);   // 整秒,utimesSync 能精确回设
  const A = '{"坏的甲":[1,2';
  const B = '{"坏的乙":[3,4';            // 和 A 字节长度相同
  assert.strictEqual(Buffer.byteLength(A, 'utf8'), Buffer.byteLength(B, 'utf8'), '前提:甲乙等长');
  fs.writeFileSync(P.USAGE_CACHE, A, 'utf8');
  const dir = path.join(P.CLAUDE_PROJECTS, 'sig2');
  sess('sig2', 's', [asst(1200, 0, 0, '2026-11-11T09:00:00Z')]);
  usage.sessionUsage(dir, 's');
  try { assert.strictEqual(copies, 1, '第一份:留一份证据'); } catch (e) { return fin(e); }
  setTimeout(() => {
    try {
      fs.writeFileSync(P.USAGE_CACHE, B, 'utf8');
      // ⚠️ 把 mtime 钉成**整秒**:utimesSync 只能设到整毫秒,而原生 mtime 带小数,
      //    不先钉一下的话下面「把 mtime 按回原值」永远差那个小数位 —— 只看时间的变异就夹不住。
      fs.utimesSync(P.USAGE_CACHE, FIXED, FIXED);
    } catch (e) { return fin(e); }
    setTimeout(() => {
      let keep;
      try {
        usage.sessionUsage(dir, 's');
        assert.strictEqual(copies, 2, '⭐ 等长但换了内容 → 必须再留一份(只看长度会漏,实际 ' + copies + ')');
        // 乙:长度变了,但把 mtime 按回原值 —— 只看时间的话会漏
        keep = fs.statSync(P.USAGE_CACHE);
        fs.writeFileSync(P.USAGE_CACHE, '{"坏的丙":[5,6,7,8,9', 'utf8');
        fs.utimesSync(P.USAGE_CACHE, FIXED, FIXED);   // 按回同一个整秒 → mtime 一模一样
        const now = fs.statSync(P.USAGE_CACHE);
        assert.strictEqual(now.mtimeMs, keep.mtimeMs, '前提:mtime 真的被按回去了');
        assert.notStrictEqual(now.size, keep.size, '前提:长度确实变了');
      } catch (e) { return fin(e); }
      setTimeout(() => {
        try {
          usage.sessionUsage(dir, 's');
          assert.strictEqual(copies, 3, '⭐ mtime 没变但长度变了 → 也必须再留一份(只看时间会漏,实际 ' + copies + ')');
          fin();
        } catch (e) { fin(e); }
      }, 200);
    }, 200);
  }, 200);
});

test('⭐ 备份节流:不设 env 时默认十分钟,而且备份完要记下时间', (t) => {
  // 第九轮验收 H1-8 / H1-11 都存活 —— 因为所有备份用例都设了 HUB_BAK_EVERY_MS,
  // 等于只测了「被覆盖」那条路。默认值一旦退成 0、或者备份完不记时间,
  // 就变成每 800ms 拷一次 463KB(每天约 570MB),而且「让 .bak 比当前写入更老」这个窗口消失
  // —— 第八轮那条「1.6 秒后 .bak 就被顶掉」正是这个窗口没了的后果。
  delete process.env.HUB_BAK_EVERY_MS;            // 就是要走默认值
  const base = useFixture();
  const rc = fs.copyFileSync;
  t.after(() => { fs.copyFileSync = rc; restoreFixture(); try { fs.rmSync(base, { recursive: true, force: true }); } catch {} });
  const dir = path.join(P.CLAUDE_PROJECTS, 'throttle');
  sess('throttle', 's', [asst(2468, 0, 0, '2026-11-11T09:00:00Z')]);
  usage.sessionUsage(dir, 's');
  usage.saveNow();                                 // 账本落地(这一拍文件还不存在,不会备份)
  let n = 0;
  fs.copyFileSync = function (a, b) { if (String(b).indexOf('.bak') >= 0) n++; return rc.apply(fs, arguments); };
  usage.saveNow();                                 // 第一次备份
  const after1 = n;
  usage.saveNow();
  usage.saveNow();
  fs.copyFileSync = rc;
  assert.ok(after1 > 0, '前提:这一拍确实备份了(实际 ' + after1 + ')');
  assert.strictEqual(n, after1, '⭐ 紧接着的两拍不许再备份 —— 默认间隔是十分钟,而且备份完要记下时间');
});

test('⭐ 连文件信息都读不出来时,证据副本也只许留一份', (t, done) => {
  // 第九轮验收 P2-3。签名取不到时如果留空串,`saved = (sig !== '' && badSig === sig)` 永远为假
  // → 每次重试都重拷一份证据(实测 6 拍 6 份;生产节奏每分钟一份 × 463KB ≈ 27MB/小时)。
  // 而 badSig 这个改动的全部目的就是堵「攒副本」,堵住它的只有那个 sig !== ''。
  process.env.HUB_LEDGER_RETRY_MS = '120';
  const base = useFixture();
  const rf = fs.readFileSync, rs = fs.statSync, rc = fs.copyFileSync;
  const fin = (err) => {
    fs.readFileSync = rf; fs.statSync = rs; fs.copyFileSync = rc;
    delete process.env.HUB_LEDGER_RETRY_MS;
    restoreFixture(); try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
    done(err);
  };
  let copies = 0;
  fs.copyFileSync = function (a, b) { if (String(b).indexOf('.bad-') >= 0) copies++; return rc.apply(fs, arguments); };
  fs.writeFileSync(P.USAGE_CACHE, '{"坏了":', 'utf8');
  const dir = path.join(P.CLAUDE_PROJECTS, 'statfail');
  sess('statfail', 's', [asst(1500, 0, 0, '2026-11-11T09:00:00Z')]);
  const boom = (p) => { throw Object.assign(new Error('EIO'), { code: 'EIO' }); };
  fs.readFileSync = function (p) { if (String(p) === P.USAGE_CACHE) return boom(p); return rf.apply(fs, arguments); };
  fs.statSync = function (p) { if (String(p) === P.USAGE_CACHE) return boom(p); return rs.apply(fs, arguments); };
  usage.sessionUsage(dir, 's');
  try { assert.strictEqual(copies, 1, '第一拍:留一份证据'); } catch (e) { return fin(e); }
  let n = 0;
  const tick = () => {
    if (++n > 3) {
      try {
        assert.strictEqual(copies, 1, '⭐ 文件信息一直读不出来,证据副本也只许有一份(实际 ' + copies + ')');
        fin();
      } catch (e) { fin(e); }
      return;
    }
    usage.sessionUsage(dir, 's');
    setTimeout(tick, 150);
  };
  setTimeout(tick, 150);
});

test('⭐ 字节数够、键集合缺的那种残本(实测的 86% 场景)必须被拦住', (t) => {
  // 第十轮验收点名的缺口:整套用例**分辨不出新设计和旧设计** —— 把第九轮被否掉的
  // 50% 字节阈值原封不动放回去,照样全绿。因为现有两条用例用的都是「小很多」或「大很多」,
  // 任何阈值都能过。真正要拦的是**中间那一段**:
  //   他账本 229 条里 194 条还有转录,35 条孤儿占 14.3% 字节 →
  //   损坏后重建的残本约为原来的 86%,再熬约 25 天(孤儿 66,223 字节 ÷ 2,678 字节/天)
  //   靠新用量就能**超过**原来的字节数 —— 任何字节阈值都会放行,而它少了 16.4% 的累计 token。
  //
  // 怎么造出「内存里缺着那几条」:让 .bak 在 **load 那一刻**正被占着(读不出来 → 合并跳过),
  // 到备份那一刻又能读了。这是真实场景(杀毒扫一下就这样),而且不用给生产代码加测试专用口子。
  process.env.HUB_BAK_EVERY_MS = '0';
  const base = useFixture();
  const rf = fs.readFileSync;
  t.after(() => {
    fs.readFileSync = rf;
    delete process.env.HUB_BAK_EVERY_MS;
    restoreFixture(); try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
  });
  const mkEntry = (n, fat) => ({
    size: 1, in: n, out: 0, cw: 0, cr: 0, slug: 'z',
    h: fat ? { '2026-11-11T09': { 'opus-5': 123456, _out: 7 } } : {}
  });
  // .bak:20 条瘦条目,其中 4 条是账本里没有的孤儿
  const bak = {};
  for (let i = 0; i < 16; i++) bak['有' + i] = mkEntry(100 + i, false);
  for (let i = 0; i < 4; i++) bak['孤儿' + i] = mkEntry(9000 + i, false);
  const bakRaw = JSON.stringify(bak);
  // 账本:同样那 16 条,但**缺 4 条孤儿**;每条塞胖一点,让字节数反超 .bak
  const cur = {};
  for (let i = 0; i < 16; i++) cur['有' + i] = mkEntry(100 + i, true);
  const curRaw = JSON.stringify(cur);
  assert.ok(curRaw.length > bakRaw.length,
    '前提:账本字节数**反超**了 .bak(' + curRaw.length + ' vs ' + bakRaw.length + ')—— 任何字节阈值都会放行');
  fs.writeFileSync(P.USAGE_CACHE + '.bak', bakRaw, 'utf8');
  fs.writeFileSync(P.USAGE_CACHE, curRaw, 'utf8');
  // load 那一刻 .bak 读不出来 → 合并跳过 → 内存里就缺那 4 条
  fs.readFileSync = function (p) {
    if (String(p) === P.USAGE_CACHE + '.bak') throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
    return rf.apply(fs, arguments);
  };
  const dir = path.join(P.CLAUDE_PROJECTS, 'eightysix');
  sess('eightysix', 's', [asst(3000, 0, 0, '2026-11-11T09:00:00Z')]);
  const e = usage.sessionUsage(dir, 's');
  fs.readFileSync = rf;                       // 占用过去了,备份那一刻能读
  assert.strictEqual(e.in, 3000, '新会话照常算');
  const rows = usage.exportRows();
  assert.ok(rows.indexOf('有0') >= 0, '前提:盘上那 16 条读进来了');
  assert.strictEqual(rows.indexOf('孤儿0'), -1, '前提:这一程没能把孤儿并回来(.bak 当时被占着)');
  usage.saveNow();
  const after = fs.readFileSync(P.USAGE_CACHE + '.bak', 'utf8');
  assert.strictEqual(after, bakRaw,
    '⭐ 账本字节数更大但缺了 4 条孤儿 → .bak 一个字节都不许动(字节阈值在这里必然放行)');
  assert.ok(fs.existsSync(P.USAGE_CACHE + '.bak2'), '近期槽照刷');
});

test('⭐ 账本读得出来但是残本时,也要从两个备份槽把缺的条目补回来(而且不许盖掉算出来的值)', (t) => {
  // 损坏后重建的残本是**合法 JSON**,下一程读得通 —— 这条路比「读不出来」那条更常见,
  // 因为它正是「损坏 → 重建 → 重启」之后的稳定状态。两个槽都要看:
  // .bak 是最全的那份,.bak2 是最新的那份,孤儿可能只在其中一边。
  const base = useFixture();
  t.after(() => { restoreFixture(); try { fs.rmSync(base, { recursive: true, force: true }); } catch {} });
  const mk = (n) => ({ size: 9, in: n, out: 1, cw: 2, cr: 3, h: {}, slug: 'g', ac: 55 });
  // 注意 s 这条:它的转录**还在盘上**,所以合并必须跳过它(否则会带着一个旧偏移进来,
  // parseNew 从那个偏移接着读,数就错了)。只有转录没了的才算孤儿。
  fs.writeFileSync(P.USAGE_CACHE + '.bak', JSON.stringify({
    只在bak: mk(700000),
    都有: mk(999),
    s: Object.assign(mk(1), { slug: 'rebuilt' })   // 它的转录确实在 projects/rebuilt/s.jsonl
  }), 'utf8');
  // 两个槽都有「都有」这一条,值不同:先看 .bak(最全那份)→ 它必须赢。
  // 这条钉住合并里的「已经有就跳过」:没有它,.bak2 会把 .bak 的值盖掉。
  fs.writeFileSync(P.USAGE_CACHE + '.bak2', JSON.stringify({
    只在bak2: mk(800000),
    都有: mk(111)
  }), 'utf8');
  // 账本本身完全正常(残本:只有一条)
  fs.writeFileSync(P.USAGE_CACHE, JSON.stringify({ 本来就有: mk(300) }), 'utf8');
  const dir = path.join(P.CLAUDE_PROJECTS, 'rebuilt');
  sess('rebuilt', 's', [asst(66000, 0, 0, '2026-11-11T09:00:00Z')]);
  const e = usage.sessionUsage(dir, 's');
  assert.strictEqual(e.in, 66000, '⭐ 转录还在盘上的那条不许被备份里的旧值/旧偏移污染');
  const rows = usage.exportRows();
  assert.ok(rows.indexOf('只在bak') >= 0, '⭐ 只在 .bak 里的孤儿要补回来');
  assert.ok(rows.indexOf('只在bak2') >= 0, '⭐ 只在 .bak2 里的孤儿也要补回来(不能只看 .bak)');
  assert.ok(rows.indexOf('本来就有') >= 0, '账本自己那条还在');
  const byd = {};
  for (const ln of rows.split(String.fromCharCode(13) + String.fromCharCode(10)).slice(1)) { const c = ln.split(','); if (c[0]) byd[c[0]] = Number(c[2]); }
  assert.strictEqual(byd['都有'], 999, '⭐ 两个槽都有同一条时,.bak(最全那份)优先,不许被 .bak2 盖掉');
});

test('⭐ 两个备份槽都失败时,不许把节流吃掉(下一拍还得再试)', (t) => {
  // 第十轮验收 P2-2:bakCopy 自己吞异常并返回 undefined,所以两个槽全失败时
  // lastBakAt 照样被记上 —— 杀毒扫一下目录那一拍两份都没拷成,却白送十分钟空窗;
  // 占用有周期性的话备份会长期饿死。
  const base = useFixture();
  const rc = fs.copyFileSync;
  t.after(() => { fs.copyFileSync = rc; restoreFixture(); try { fs.rmSync(base, { recursive: true, force: true }); } catch {} });
  const dir = path.join(P.CLAUDE_PROJECTS, 'nothrottle');
  sess('nothrottle', 's', [asst(1234, 0, 0, '2026-11-11T09:00:00Z')]);
  usage.sessionUsage(dir, 's');
  usage.saveNow();                                  // 让账本文件存在
  let tries = 0;
  fs.copyFileSync = function (a, b) {
    if (String(b).indexOf('.bak') >= 0) { tries++; throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); }
    return rc.apply(fs, arguments);
  };
  usage.saveNow();
  const first = tries;
  usage.saveNow();
  const second = tries;
  fs.copyFileSync = rc;
  assert.ok(first > 0, '前提:第一拍确实试过备份(实际 ' + first + ')');
  assert.ok(second > first, '⭐ 全失败就不许记时间 —— 下一拍必须再试(实际第二拍又试了 ' + (second - first) + ' 次)');
});

test('⭐ 同一秒内留两份证据,必须是两个文件(不许互相顶掉)', (t, done) => {
  // 第十轮验收 P3-1:名字只到秒,同一秒内第二份会把第一份(往往是最值钱的原件)顶掉,
  // 而日志两次都说「已另存」—— 在这条路上说假话。
  // 现有那几条断言只数 copyFileSync 的调用次数,没有一处验证盘上**真的多了一个文件**。
  process.env.HUB_LEDGER_RETRY_MS = '30';
  const base = useFixture();
  const fin = (err) => {
    delete process.env.HUB_LEDGER_RETRY_MS;
    restoreFixture(); try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
    done(err);
  };
  const dirn = path.dirname(P.USAGE_CACHE);
  fs.writeFileSync(P.USAGE_CACHE, '{"甲最值钱":[1,2', 'utf8');
  const dir = path.join(P.CLAUDE_PROJECTS, 'twobad');
  sess('twobad', 's', [asst(2222, 0, 0, '2026-11-11T09:00:00Z')]);
  usage.sessionUsage(dir, 's');
  setTimeout(() => {
    try {
      fs.writeFileSync(P.USAGE_CACHE, '{"乙":[3,4,5,6', 'utf8');   // 同一秒内换一份
      usage.sessionUsage(dir, 's');
      const bad = fs.readdirSync(dirn).filter(f => f.indexOf('.bad-') >= 0);
      assert.strictEqual(bad.length, 2, '⭐ 两份证据必须是两个文件(实际 ' + bad.length + ' 个: ' + bad.join(',') + ')');
      const texts = bad.map(f => fs.readFileSync(path.join(dirn, f), 'utf8'));
      assert.ok(texts.some(x => x.indexOf('甲最值钱') >= 0), '⭐ 第一份原件不许被顶掉');
      assert.ok(texts.some(x => x.indexOf('乙') >= 0), '第二份也要在');
      fin();
    } catch (e) { fin(e); }
  }, 60);
});

test('⭐ 旧备份自己坏了的时候,不许因为「保不住它」而让账本永远刷不进去', (t) => {
  // 高水位判据要读 .bak 的内容。它要是坏的(半截 JSON),就谈不上「键集合」——
  // 这时必须当成「不值得保」,照常用好账本盖掉它;否则备份永远停在一份坏文件上。
  process.env.HUB_BAK_EVERY_MS = '0';
  const base = useFixture();
  t.after(() => {
    delete process.env.HUB_BAK_EVERY_MS;
    restoreFixture(); try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
  });
  fs.writeFileSync(P.USAGE_CACHE + '.bak', '{"坏掉的备份":', 'utf8');
  const dir = path.join(P.CLAUDE_PROJECTS, 'badbak');
  sess('badbak', 's', [asst(4567, 0, 0, '2026-11-11T09:00:00Z')]);
  usage.sessionUsage(dir, 's');
  usage.saveNow();
  usage.saveNow();
  const after = fs.readFileSync(P.USAGE_CACHE + '.bak', 'utf8');
  assert.notStrictEqual(after, '{"坏掉的备份":', '⭐ 坏备份必须被好账本盖掉,不然备份永远刷不进去');
  const j = JSON.parse(after);
  assert.ok(j.s && j.s.in === 4567, '盖上去的是当前账本');
});

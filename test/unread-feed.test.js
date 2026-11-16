// 未读(铃铛角标 / 抽屉列表)的口径一致性。
//
// 这组测试是为 2026-11-05 那个 bug 建的:三月点完了所有通知,抽屉显示「都清完了 ✓」,
// 右上角铃铛却还挂着一个「1」,而且点左边任何会话都消不掉。
//
// 根因:角标数的是 localStorage 里那张 unread 表(永久、无上限),
// 抽屉画的却是 done-feed 最后 N 条记录里筛出来的未读组。
// 一个未读会话的记录被后面的会话挤出那个窗口之后,它就成了"孤儿":
// 角标算它、抽屉画不出它、任何点击都碰不到它。
//
// 测试直接从 index.html 里截真源码来跑(两条 <pure-unread-logic> 标记之间),
// 所以实现一改、测试立刻跟着变,不会出现"测试过了但线上是另一份代码"。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
// 测试数据里的日期一律相对「今天」:未读提醒只留 14 天,写死的日期过了保留期整条测试就红(2026-11-15 炸过一次)。
const DAY = (() => { const d = new Date(Date.now() - 2 * 86400e3); const p = n => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); })();

const SRC = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function pickBlock() {
  const a = SRC.indexOf('// <pure-unread-logic>');
  const b = SRC.indexOf('// </pure-unread-logic>');
  assert.ok(a >= 0 && b > a, 'index.html 里找不到 <pure-unread-logic> 标记 —— 实现被挪走了?');
  return SRC.slice(a, b);
}
function pickLine(name) {
  const m = new RegExp('^const ' + name + ' = .*$', 'm').exec(SRC);
  assert.ok(m, 'index.html 里找不到 const ' + name);
  return m[0];
}

// 把真源码装进一个干净的作用域,外部依赖(projects / feedList / unread)由测试喂。
// saveUnread 只是把表写进 localStorage,这儿给个空壳;其余全是真实现。
function load(state) {
  const body = [
    pickLine('leaf'),
    pickLine('fkey'),
    'let projects = __s.projects, feedList = __s.feedList, unread = __s.unread;',
    'let seen = __s.seen || {};',
    // saveUnread 本身也在截取块里(它只是把表写进 localStorage),给它一个假的 store 就行
    'const __store = {}; const store = { get: (k, d) => (k in __store ? __store[k] : d), set: (k, v) => { __store[k] = v; } };',
    pickBlock(),
    'return { feedGroups, totalUnread, unreadOf, projOfRec, unreadCwd, pruneUnread, processFeed,',
    '         get unread(){ return unread; }, get seen(){ return seen; }, get store(){ return __store; } };'
  ].join('\n');
  return new Function('__s', body)(state);
}

const REC = (sid, ts, task, cwd) => ({ sid, ts, task, cwd, proj: leafOf(cwd), result: '', tok: 100 });
const leafOf = p => String(p || '').split('\\').pop();
const UN = (sid, ts, task, cwd) => ({ projPath: cwd, projLeaf: leafOf(cwd), sid, ts, task, cwd });

const P_RADAR = 'F:\\claude-project\\项目雷达';
const P_COMFY = 'F:\\claude-project\\本地comfyui';
const projects = [
  { path: P_RADAR, short: '项目雷达' },
  { path: P_COMFY, short: '本地comfyui' }
];

test('记录还在 feed 窗口里时,角标数和抽屉未读卡数一致', () => {
  const unread = { s1: UN('s1', `${DAY} 21:10:45`, '看看X', P_RADAR) };
  const feedList = [REC('s1', `${DAY} 21:10:45`, '看看X', P_RADAR)];
  const m = load({ projects, feedList, unread });
  const { un } = m.feedGroups();
  assert.strictEqual(un.length, 1);
  assert.strictEqual(m.totalUnread(), un.length, '铃铛和抽屉必须数同一份东西');
});

test('同一会话多轮只算一组', () => {
  const unread = { s1: UN('s1', `${DAY} 22:00:00`, '第三轮', P_COMFY) };
  const feedList = [
    REC('s1', `${DAY} 22:00:00`, '第三轮', P_COMFY),
    REC('s1', `${DAY} 21:50:00`, '第二轮', P_COMFY),
    REC('s1', `${DAY} 21:40:00`, '第一轮', P_COMFY)
  ];
  const m = load({ projects, feedList, unread });
  const { un } = m.feedGroups();
  assert.strictEqual(un.length, 1);
  assert.strictEqual(un[0].turns.length, 3, '三轮应该折进同一张卡');
  assert.strictEqual(m.totalUnread(), 1);
});

// ↓↓↓ 这条就是他报的 bug ↓↓↓
test('孤儿未读:记录被挤出 feed 窗口,抽屉仍然必须画出来', () => {
  const unread = { orphan: UN('orphan', `${DAY} 21:10:45`, '看看X', P_RADAR) };
  // feed 窗口里全是别的会话,把它挤出去了
  const feedList = [
    REC('other', `${DAY} 22:28:58`, '可以,做吧', P_COMFY),
    REC('other', `${DAY} 22:20:00`, '继续', P_COMFY)
  ];
  const m = load({ projects, feedList, unread });
  const { un } = m.feedGroups();
  assert.strictEqual(un.length, 1, '抽屉里必须还有这张卡,否则角标点不掉');
  assert.strictEqual(m.totalUnread(), un.length, '角标说 1 条,抽屉就得给得出 1 张卡');
});

test('孤儿卡片要带得出 sid 和工作目录,否则「进入」跳不了', () => {
  const unread = { orphan: UN('orphan', `${DAY} 21:10:45`, '看看X', P_RADAR) };
  const m = load({ projects, feedList: [], unread });
  const r = m.feedGroups().un[0].latest;
  assert.strictEqual(r.sid, 'orphan');
  assert.strictEqual(r.cwd, P_RADAR, 'cwd 必须是会话真实工作目录,拿父项目路径去 resume 会找错转录');
  assert.strictEqual(r.task, '看看X');
  assert.ok(r.orphan, '要标出来是孤儿,卡片上才好说明它为什么没有正文');
});

test('老数据没存 cwd:projPath 就是会话目录时,直接用它', () => {
  const old = { projPath: P_RADAR, projLeaf: '项目雷达', sid: 'o2', ts: `${DAY} 21:10:45`, task: 'x' };
  const m = load({ projects, feedList: [], unread: { o2: old } });
  assert.strictEqual(m.feedGroups().un[0].latest.cwd, P_RADAR);
});

// 他机器上的真实情况:项目雷达 / claude-hub 这些子目录都没单独登记成项目,
// 只有伞形的 F:\claude-project 登记了(卖AI·总控大本营),所以老数据的 projPath 全是伞形目录。
test('老数据没存 cwd:projPath 是伞形父目录时,一个字都不许猜', () => {
  const old = { projPath: 'F:\\claude-project', projLeaf: '项目雷达', sid: 'o3', ts: `${DAY} 21:10:45`, task: 'x' };
  const m = load({ projects, feedList: [], unread: { o3: old } });
  const r = m.feedGroups().un[0].latest;
  assert.strictEqual(r.cwd, '', '拿伞形目录当 cwd 会在 slug F--claude-project 里找转录,那儿根本没有这个会话');
  assert.strictEqual(m.unreadCwd(old), '');
  // 卡片仍然该显示真实文件夹名,不该变成「卖AI·总控大本营」
  assert.strictEqual(r.proj, '项目雷达');
});

test('pruneUnread:ts 坏掉的条目当成刚到的,不许当最旧的先删', () => {
  // 日期必须相对「今天」算:原来写死成 2026-11-01~05,到 11-15 那天最早一批刚好超过 14 天保留期,
  // 被 TTL 那一步先清掉 41 条,这条测试就红了(产品代码没毛病,是测试自己埋的定时炸弹)。
  const daysAgo = (n) => new Date(Date.now() - n * 86400e3).toISOString().slice(0, 19).replace('T', ' ');
  const unread = {};
  for (let i = 0; i < 205; i++) unread['s' + i] = UN('s' + i, daysAgo(1 + i % 5), 't', P_RADAR);
  unread['刚到的没ts'] = { projPath: P_RADAR, projLeaf: '项目雷达', sid: 'x', task: '刚到' };
  const m = load({ projects, feedList: [], unread });
  m.pruneUnread();
  assert.ok(m.unread['刚到的没ts'], '刚进来的提醒不能因为没时间戳就被当成最旧的删掉');
  assert.strictEqual(Object.keys(m.unread).length, 200);
});

test('pruneUnread:超过 14 天的清掉,没有 ts 的不碰', () => {
  const old = new Date(Date.now() - 20 * 86400e3).toISOString().slice(0, 19).replace('T', ' ');
  const unread = {
    旧: UN('旧', old, 't', P_RADAR),
    新: UN('新', new Date().toISOString().slice(0, 19).replace('T', ' '), 't', P_RADAR),
    没ts: { projPath: P_RADAR, projLeaf: '项目雷达', sid: '没ts', task: 't' }
  };
  const m = load({ projects, feedList: [], unread });
  assert.strictEqual(m.pruneUnread(), 1);
  assert.deepStrictEqual(Object.keys(m.unread).sort(), ['新', '没ts']);
});

// getFeed 返回的是新→旧。原来每轮整体覆盖,最后落表的反而是最旧那一轮,
// 孤儿卡就会显示半天前的时间和任务,TTL 也从那一轮算起、提前过期。
test('processFeed:同一会话多轮一起进来,表里留的必须是最新那一轮', () => {
  const feedList = [
    REC('s1', `${DAY} 22:00:00`, '第三轮(最新)', P_COMFY),
    REC('s1', `${DAY} 21:00:00`, '第二轮', P_COMFY),
    REC('s1', `${DAY} 20:00:00`, '第一轮(最旧)', P_COMFY)
  ];
  const m = load({ projects, feedList, unread: {} });
  m.processFeed(feedList);
  assert.strictEqual(m.unread.s1.ts, `${DAY} 22:00:00`);
  assert.strictEqual(m.unread.s1.task, '第三轮(最新)');
  assert.strictEqual(m.unread.s1.cwd, P_COMFY, '新数据必须把真实 cwd 存下来');
});

test('processFeed:看过的记录不会被重新标成未读', () => {
  const feedList = [REC('s1', `${DAY} 22:00:00`, '跑完了', P_COMFY)];
  const seen = { [REC('s1', `${DAY} 22:00:00`, '跑完了', P_COMFY).ts + '|s1|本地comfyui']: Date.now() };
  const m = load({ projects, feedList, unread: {}, seen });
  m.processFeed(feedList);
  assert.strictEqual(Object.keys(m.unread).length, 0);
});

test('孤儿被清掉之后,角标和抽屉同时归零', () => {
  const unread = { orphan: UN('orphan', `${DAY} 21:10:45`, '看看X', P_RADAR) };
  const m = load({ projects, feedList: [], unread });
  delete m.unread.orphan;
  assert.strictEqual(m.feedGroups().un.length, 0);
  assert.strictEqual(m.totalUnread(), 0);
});

test('已读的记录进已读区,不进未读区', () => {
  const feedList = [REC('s1', `${DAY} 22:00:00`, '跑完了', P_COMFY)];
  const m = load({ projects, feedList, unread: {} });
  const { un, rd } = m.feedGroups();
  assert.strictEqual(un.length, 0);
  assert.strictEqual(rd.length, 1);
  assert.strictEqual(m.totalUnread(), 0);
});

test('未读在前、已读在后,各自按时间倒序', () => {
  const unread = { s2: UN('s2', `${DAY} 21:00:00`, '旧的未读', P_RADAR) };
  const feedList = [
    REC('s1', `${DAY} 22:00:00`, '新的已读', P_COMFY),
    REC('s2', `${DAY} 21:00:00`, '旧的未读', P_RADAR),
    REC('s3', `${DAY} 20:00:00`, '更旧的已读', P_COMFY)
  ];
  const m = load({ projects, feedList, unread });
  const { un, rd } = m.feedGroups();
  assert.deepStrictEqual(un.map(g => g.latest.sid), ['s2']);
  assert.deepStrictEqual(rd.map(g => g.latest.sid), ['s1', 's3']);
});

test('项目红点和孤儿:孤儿同样要算进它所属项目的未读数', () => {
  const unread = { orphan: UN('orphan', `${DAY} 21:10:45`, '看看X', P_RADAR) };
  const m = load({ projects, feedList: [], unread });
  assert.strictEqual(m.unreadOf(projects[0]).cnt, 1, '项目雷达应该挂着红点');
  assert.strictEqual(m.unreadOf(projects[1]).cnt, 0);
});

// 检查点回退 / 撤销的安全性(lib/checkpoints.js + main.js 的 ckpt:* 接线)。
//
// 背景:2026-11-18 上游审查。回退和撤销会写、会删用户项目里的文件,审查列出几处会弄丢文件的地方:
//   1. readOrNull 不分错误:文件被锁(EBUSY / EPERM)被记成 existed:false,撤销时被 unlink。
//      → 只把 ENOENT 当不存在;备份时任一文件读不了就放弃这次回退。
//   2. 记「回退后的样子」失败被吞掉后,撤销照样删 existed:false 的文件。→ 没记成就一律不删。
//   4. 备份清单靠解析 jsonl 推,推不准时照常回退,事后却恢复不了。→ 推不准就拒绝;确认框列出会动的文件。
//   5. 会话还在跑时也能回退;回退 / 撤销没有互斥。→ 总控里开着或最近有写入(现在是 5 分钟)就拒绝;按会话加锁。
//   7. 回退备份只增不删;git diff 会跑用户配置的外部对比程序。→ 清理旧备份;加 --no-ext-diff --no-textconv。
// 同日第二轮审查(#4):
//   · 撤销放回文件那段没有 try/catch:一个文件写不进去整个撤销抛错,界面说「撤销失败」,前面的文件其实已被覆盖。
//     → 每个文件单独 try,写不进去计入 skipped,照常返回。
//   · 没记成回退后的样子时,撤销直接覆盖,回退后用户自己改的内容丢了。→ 覆盖前先另存到 pre-undo-<时间>/。
//   · 「在跑」窗口 1 分钟太短 → 5 分钟;openInHubMsg 比 slug 区分大小写 → 不分。
// 「读不了的文件」用目录冒充:readFile 一个目录报 EISDIR,和被锁一样是「不是不存在、但读不了」。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ck = require('../lib/checkpoints');

const SID = 'b4f1e144-9dbd-4b6f-9002-6a79401686f9';
const Q1 = '6d9dced9-fc80-4427-9508-e7d776944754';
const Q2 = '7e0e0000-0000-4000-8000-000000000002';
const NOPE = '00000000-0000-4000-8000-00000000dead';
const tmpRoots = [];
test.after(() => { for (const d of tmpRoots) try { fs.rmSync(d, { recursive: true, force: true }); } catch {} });
const iso = (minAgo) => new Date(Date.now() - minAgo * 60e3).toISOString();

// 两轮:Q1 改 a.txt、新建 b.txt;Q2 新建 c.txt。磁盘上现在 a = v2、b、c 都在
function fixture(extraLines = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-ckpt-safe-'));
  tmpRoots.push(root);
  const proj = path.join(root, 'proj'), home = path.join(root, 'claude'), slug = 'C--proj';
  fs.mkdirSync(proj, { recursive: true });
  fs.mkdirSync(path.join(home, 'projects', slug), { recursive: true });
  const hist = path.join(home, 'file-history', SID);
  fs.mkdirSync(hist, { recursive: true });
  fs.writeFileSync(path.join(hist, 'aaaa@v1'), 'v1\n');
  fs.writeFileSync(path.join(hist, 'aaaa@v2'), 'v2\n');
  fs.writeFileSync(path.join(hist, 'bbbb@v2'), 'b\n');
  fs.writeFileSync(path.join(proj, 'a.txt'), 'v2\n');
  fs.writeFileSync(path.join(proj, 'b.txt'), 'b\n');
  fs.writeFileSync(path.join(proj, 'c.txt'), 'c\n');
  const L = [
    { type: 'mode', cwd: proj },
    { type: 'file-history-snapshot', messageId: Q1, snapshot: { messageId: Q1, trackedFileBackups: {}, timestamp: iso(30) } },
    { type: 'user', uuid: Q1, timestamp: iso(30), cwd: proj, message: { role: 'user', content: '改 a,建 b' } },
    { type: 'file-history-delta', snapshotMessageId: Q1, trackingPath: 'a.txt', backup: { backupFileName: 'aaaa@v1', realParentDir: proj } },
    { type: 'file-history-delta', snapshotMessageId: Q1, trackingPath: 'b.txt', backup: { backupFileName: null, realParentDir: proj } },
    { type: 'file-history-snapshot', messageId: Q2, snapshot: { messageId: Q2, trackedFileBackups: { 'a.txt': { backupFileName: 'aaaa@v2', realParentDir: proj }, 'b.txt': { backupFileName: 'bbbb@v2', realParentDir: proj } }, timestamp: iso(20) } },
    { type: 'user', uuid: Q2, timestamp: iso(20), message: { role: 'user', content: '建 c' } },
    { type: 'file-history-delta', snapshotMessageId: Q2, trackingPath: 'c.txt', backup: { backupFileName: null, realParentDir: proj } },
    ...extraLines
  ];
  const jsonl = path.join(home, 'projects', slug, SID + '.jsonl');
  fs.writeFileSync(jsonl, L.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join('\n') + '\n');
  const old = (Date.now() - 10 * 60e3) / 1000;
  fs.utimesSync(jsonl, old, old);                       // 十分钟前写的:会话没在跑
  return { root, proj, home, slug, hist, jsonl, P: path.join(home, 'projects'), bk: path.join(root, 'rewind-backups') };
}
const rel = (f, changes) => changes.map(c => [path.relative(f.proj, c.path), c.kind]).sort();

// ---------- 4. 先算出会动哪些文件,推不准就拒绝 ----------
test('planRewind:列出回退会动的文件(改 / 删 / 恢复),和现在一样的不列', async () => {
  const f = fixture();
  const p1 = await ck.planRewind(f.P, f.home, f.slug, SID, Q1);
  assert.equal(p1.ok, true, p1.msg);
  assert.deepEqual(rel(f, p1.changes), [['a.txt', '改'], ['b.txt', '删'], ['c.txt', '删']]);
  const p2 = await ck.planRewind(f.P, f.home, f.slug, SID, Q2);
  assert.deepEqual(rel(f, p2.changes), [['c.txt', '删']]);                // a、b 和 Q2 那一刻一样
  fs.unlinkSync(path.join(f.proj, 'a.txt'));
  const p3 = await ck.planRewind(f.P, f.home, f.slug, SID, Q2);
  assert.deepEqual(rel(f, p3.changes), [['a.txt', '恢复'], ['c.txt', '删']]);
});

test('planRewind:推不准就拒绝 —— 没这个检查点 / 有看不懂的检查点数据 / 备份不见了 / 文件读不了', async () => {
  let f = fixture();
  assert.equal((await ck.planRewind(f.P, f.home, f.slug, SID, NOPE)).ok, false);

  f = fixture([{ type: 'file-history-delta', snapshotMessageId: Q2, trackingPath: 'x.txt' }]);   // 缺 backup
  let r = await ck.planRewind(f.P, f.home, f.slug, SID, Q1);
  assert.equal(r.ok, false); assert.match(r.msg, /看不懂/);
  f = fixture([{ type: 'file-history-something-new', foo: 1 }]);                               // 新类型
  assert.equal((await ck.planRewind(f.P, f.home, f.slug, SID, Q1)).ok, false);
  f = fixture(['{"type":"file-history-delta", 坏掉的行']);
  assert.equal((await ck.planRewind(f.P, f.home, f.slug, SID, Q1)).ok, false);

  f = fixture();
  fs.unlinkSync(path.join(f.hist, 'aaaa@v1'));
  r = await ck.planRewind(f.P, f.home, f.slug, SID, Q1);
  assert.equal(r.ok, false); assert.match(r.msg, /备份文件不见了/);

  f = fixture();
  fs.unlinkSync(path.join(f.proj, 'a.txt')); fs.mkdirSync(path.join(f.proj, 'a.txt'));      // 读不了(EISDIR)
  r = await ck.planRewind(f.P, f.home, f.slug, SID, Q1);
  assert.equal(r.ok, false); assert.match(r.msg, /读不了/);
});

test('planRewind:相对路径、又没有目录和会话 cwd —— 位置推不出来,拒绝', async () => {
  const parsed = ck.parse([
    JSON.stringify({ type: 'file-history-snapshot', messageId: Q1, snapshot: { trackedFileBackups: { 'a.txt': { backupFileName: null } } } }),
    JSON.stringify({ type: 'user', uuid: Q1, message: { content: 'x' } })
  ].join('\n'));
  const r = await ck.planFromParsed(parsed, os.tmpdir(), Q1);
  assert.equal(r.ok, false);
  assert.match(r.msg, /推不出来/);
});

// ---------- 1. 只有 ENOENT 才算不存在 ----------
test('备份时有文件读不了:整个放弃、抛错、不留半份备份', async () => {
  const f = fixture();
  fs.unlinkSync(path.join(f.proj, 'b.txt')); fs.mkdirSync(path.join(f.proj, 'b.txt'));
  await assert.rejects(ck.backupBeforeRewind(f.P, f.home, f.slug, SID, Q1, f.bk, 111), /读不了/);
  assert.equal(fs.existsSync(path.join(f.bk, '111')), false);
});

test('真不存在的文件照常记成 existed:false;清单里带上 slug(撤销时用来判断会话在不在跑)', async () => {
  const f = fixture();
  fs.unlinkSync(path.join(f.proj, 'c.txt'));
  const bid = await ck.backupBeforeRewind(f.P, f.home, f.slug, SID, Q1, f.bk, 222);
  const m = await ck.readManifest(f.bk, bid);
  assert.equal(m.slug, f.slug);
  assert.deepEqual(m.files.map(x => [path.basename(x.path), x.existed]).sort(), [['a.txt', true], ['b.txt', true], ['c.txt', false]]);
});

// ---------- 2. 没记成回退后的样子:一律不删 ----------
test('记「回退后的样子」时有文件读不了:抛错、不标 recorded;撤销时不删任何文件', async () => {
  const f = fixture();
  fs.unlinkSync(path.join(f.proj, 'c.txt'));
  const bid = await ck.backupBeforeRewind(f.P, f.home, f.slug, SID, Q1, f.bk, 333);   // c 不存在 → existed:false
  // 「回退」:a 回到 v1,b 被锁住读不了;之后有人建了 c
  fs.writeFileSync(path.join(f.proj, 'a.txt'), 'v1\n');
  fs.unlinkSync(path.join(f.proj, 'b.txt')); fs.mkdirSync(path.join(f.proj, 'b.txt'));
  await assert.rejects(ck.recordAfterRewind(f.bk, bid));
  assert.notEqual((await ck.readManifest(f.bk, bid)).recorded, true);
  fs.rmdirSync(path.join(f.proj, 'b.txt'));
  fs.writeFileSync(path.join(f.proj, 'c.txt'), '后来建的');
  const r = await ck.undoRewind(f.bk, bid);
  assert.equal(fs.readFileSync(path.join(f.proj, 'c.txt'), 'utf8'), '后来建的', '没记成就不许删');
  assert.deepEqual(r.kept.map(p => path.basename(p)), ['c.txt']);
  assert.equal(r.removed, 0);
  assert.equal(fs.readFileSync(path.join(f.proj, 'a.txt'), 'utf8'), 'v2\n');
});

test('记成了:撤销时现在读不了的文件不碰(算 skipped),不会被当成不存在删掉', async () => {
  const f = fixture();
  fs.unlinkSync(path.join(f.proj, 'c.txt'));
  const bid = await ck.backupBeforeRewind(f.P, f.home, f.slug, SID, Q1, f.bk, 444);
  fs.writeFileSync(path.join(f.proj, 'c.txt'), '回退冒出来的');
  await ck.recordAfterRewind(f.bk, bid, { jsonlMtime: 5 });
  const m = await ck.readManifest(f.bk, bid);
  assert.equal(m.recorded, true);
  assert.equal(m.jsonlMtime, 5);
  fs.unlinkSync(path.join(f.proj, 'c.txt')); fs.mkdirSync(path.join(f.proj, 'c.txt'));   // 撤销时被锁
  const r = await ck.undoRewind(f.bk, bid);
  assert.ok(fs.statSync(path.join(f.proj, 'c.txt')).isDirectory());
  assert.deepEqual(r.skipped.map(p => path.basename(p)), ['c.txt']);
  assert.equal(r.removed, 0);
});

// ---------- 5. 会话还在跑就不许动 ----------
test('sessionBusy:5 分钟内有写入算在跑;since 之前的写入(回退自己写的)不算', async () => {
  const f = fixture();
  assert.equal(ck.BUSY_MS, 5 * 60e3);
  assert.equal(await ck.sessionBusy(f.P, f.home, f.slug, SID), false);   // 十分钟前写的
  const t3 = (Date.now() - 3 * 60e3) / 1000;
  fs.utimesSync(f.jsonl, t3, t3);
  assert.equal(await ck.sessionBusy(f.P, f.home, f.slug, SID), true, '外部终端里跑了三分钟命令没写记录,也算在跑');
  fs.appendFileSync(f.jsonl, '\n');
  assert.equal(await ck.sessionBusy(f.P, f.home, f.slug, SID), true);
  const mt = await ck.sessionMtime(f.P, f.home, f.slug, SID);
  assert.equal(await ck.sessionBusy(f.P, f.home, f.slug, SID, Date.now(), 60000, mt), false);
});

test('main.js 接线:回退 / 撤销按会话加锁、会话在跑就拒绝、重新算清单和确认过的比、回退后记修改时间', () => {
  const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const rew = MAIN.slice(MAIN.indexOf("ipcMain.handle('ckpt:rewind'"), MAIN.indexOf("ipcMain.handle('ckpt:undo'"));
  const undo = MAIN.slice(MAIN.indexOf("ipcMain.handle('ckpt:undo'"));
  assert.match(rew, /if \(ckptBusy\.has\(sid\)\) return/);
  assert.match(rew, /finally \{ ckptBusy\.delete\(sid\); \}/);
  assert.ok(rew.indexOf('ckptRunningMsg(') < rew.indexOf('backupBeforeRewind('), '先判断在不在跑,再备份');
  assert.ok(rew.indexOf('planRewind(') < rew.indexOf('backupBeforeRewind('), '先算清单,推不准就不备份不回退');
  assert.match(rew, /plan\.changes\.some\(c => !ok\.has\(c\.path\.toLowerCase\(\)\)\)/);
  assert.match(rew, /recordAfterRewind\(P\.REWIND_BACKUPS, bid, \{ jsonlMtime \}\)/);
  assert.match(undo, /ckptBusy\.has\(sid\)/);
  assert.match(MAIN, /ckpt\.sessionBusy\(.*ckpt\.BUSY_MS, since\)/);
  assert.match(undo, /ckptRunningMsg\(m\.slug, sid, Number\(m\.jsonlMtime\) \|\| 0\)/);
  assert.match(MAIN, /ckpt\.openInHubMsg\(\[\.\.\.termMeta\.values\(\)\], slug, sid, data\.slugOf\)/);
  assert.match(MAIN, /ckpt\.cleanBackups\(P\.REWIND_BACKUPS\)\.catch\(\(\) => \{\}\)/);
});

// ---------- 7. 旧备份清理、git diff 不跑外部程序 ----------
test('cleanBackups:超过 14 天的删,最新 10 份不管多旧都留;不是我们建的目录不碰', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-ckpt-clean-'));
  tmpRoots.push(root);
  const now = Date.now(), DAY = 86400e3;
  const ids = [];
  for (let i = 0; i < 15; i++) ids.push(String(now - (i < 3 ? i : 20 + i) * DAY));   // 3 份新的、12 份 20 天以上的
  for (const id of ids) fs.mkdirSync(path.join(root, id));
  fs.mkdirSync(path.join(root, 'notes'));
  const n = await ck.cleanBackups(root, now);
  assert.equal(n, 5);
  const left = fs.readdirSync(root);
  assert.ok(left.includes('notes'));
  assert.deepEqual(left.filter(x => x !== 'notes').sort(), ids.slice(0, 10).sort());
  assert.equal(await ck.cleanBackups(path.join(root, 'nope')), 0);                       // 目录不存在:不抛
});

test('git diff --no-index 带 --no-ext-diff --no-textconv(不跑用户配置的外部对比程序)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'checkpoints.js'), 'utf8');
  assert.match(src, /\['diff', '--no-index', '--no-color', '--no-ext-diff', '--no-textconv', '--', a, b\]/);
});

// 2026-11-17 打包实测:审查第 5 条只拦住了「标签认领到会话号的」。新开的会话标签要等 Claude Code 写出会话记录
// 才认领会话号,界面只盯开标签后的 30 秒(bindNewSid),第一句话发得晚就一直认领不上;主进程的 termMeta.sid
// 对新会话从来是空的。结果会话就在总控里开着、一分钟没写入,回退照样放行 —— 实测弹出了确认框。
// → 同一个项目目录里有还没认出会话号的标签时,拿不准它是不是这个会话,一律拒绝。
test('总控里开着:会话号对上就拒绝;同项目有没认出会话号的标签也拒绝;别的项目的不算', () => {
  const slugOf = (p) => String(p).replace(/[^A-Za-z0-9-]/g, '-');   // 假依赖:main 传的是 data.slugOf
  const slug = slugOf('C:\\proj');
  assert.equal(ck.openInHubMsg([], slug, SID, slugOf), '');
  assert.match(ck.openInHubMsg([{ projPath: 'D:\\other', sid: SID }], slug, SID, slugOf), /正在总控里开着/);
  assert.match(ck.openInHubMsg([{ projPath: 'C:\\proj', sid: '' }], slug, SID, slugOf), /还没认出是哪个会话/);
  // 同项目里别的、已经认出会话号的标签:不拦
  assert.equal(ck.openInHubMsg([{ projPath: 'C:\\proj', sid: NOPE }], slug, SID, slugOf), '');
  // 别的项目里没认出会话号的标签:不拦
  assert.equal(ck.openInHubMsg([{ projPath: 'D:\\other', sid: '' }], slug, SID, slugOf), '');
  // 老备份没有 slug:只能按会话号认
  assert.equal(ck.openInHubMsg([{ projPath: 'C:\\proj', sid: '' }], '', SID, slugOf), '');
  assert.equal(ck.openInHubMsg([null, undefined], slug, SID, slugOf), '');
});

test('main.js:回退 / 撤销都走 openInHubMsg;界面认领到会话号会告诉主进程(term:bindSid)', () => {
  const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(MAIN, /ck(pt)?\.openInHubMsg\(\[\.\.\.termMeta\.values\(\)\], slug, sid, data\.slugOf\)/);
  assert.doesNotMatch(MAIN, /ckptOpenInHub/);
  assert.match(MAIN, /ipcMain\.on\('term:bindSid'/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8'), /termBindSid: \(id, sid\) => ipcRenderer\.send\('term:bindSid', id, sid\)/);
});

// ---------- 第二轮审查:撤销逐个文件、没记成先另存、大小写 ----------
// 换掉 fs.promises.writeFile:路径命中 bad 时报 EBUSY(冒充被编辑器独占 / 杀毒在扫)
async function withWriteFail(bad, fn) {
  const orig = fs.promises.writeFile;
  fs.promises.writeFile = function (p, ...rest) {
    if (bad(String(p))) return Promise.reject(Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' }));
    return orig.call(this, p, ...rest);
  };
  try { return await fn(); } finally { fs.promises.writeFile = orig; }
}

test('撤销时有文件写不进去:不抛错,那个算 skipped,别的照样放回', async () => {
  const f = fixture();
  const bid = await ck.backupBeforeRewind(f.P, f.home, f.slug, SID, Q1, f.bk, 555);   // a = v2、b、c 都在
  // 「回退」到 Q1 之前:a 回到 v1,b、c 被删
  fs.writeFileSync(path.join(f.proj, 'a.txt'), 'v1\n');
  fs.unlinkSync(path.join(f.proj, 'b.txt')); fs.unlinkSync(path.join(f.proj, 'c.txt'));
  await ck.recordAfterRewind(f.bk, bid, { jsonlMtime: 1 });
  const r = await withWriteFail(p => path.basename(p) === 'b.txt', () => ck.undoRewind(f.bk, bid));
  assert.deepEqual(r.skipped.map(p => path.basename(p)), ['b.txt']);
  assert.equal(r.restored, 2);
  assert.equal(fs.readFileSync(path.join(f.proj, 'a.txt'), 'utf8'), 'v2\n');
  assert.equal(fs.readFileSync(path.join(f.proj, 'c.txt'), 'utf8'), 'c\n');
  assert.equal(fs.existsSync(path.join(f.proj, 'b.txt')), false);
});

test('没记成回退后的样子:覆盖前先把现在的内容另存;和备份一样的不另存', async () => {
  const f = fixture();
  const bid = await ck.backupBeforeRewind(f.P, f.home, f.slug, SID, Q1, f.bk, 666);
  fs.writeFileSync(path.join(f.proj, 'a.txt'), '回退之后我自己改的\n');    // 回退后(没记成 recorded)用户改了 a;b、c 没变
  const r = await ck.undoRewind(f.bk, bid, 777);
  assert.equal(fs.readFileSync(path.join(f.proj, 'a.txt'), 'utf8'), 'v2\n');
  assert.deepEqual(r.saved.map(x => path.basename(x.path)), ['a.txt']);
  assert.equal(path.basename(path.dirname(r.saved[0].copy)), 'pre-undo-777');
  assert.equal(fs.readFileSync(r.saved[0].copy, 'utf8'), '回退之后我自己改的\n');
  assert.equal(r.restored, 3);
  assert.deepEqual(r.skipped, []);
});

test('没记成、另存失败:不覆盖(算 skipped),用户改的内容还在', async () => {
  const f = fixture();
  const bid = await ck.backupBeforeRewind(f.P, f.home, f.slug, SID, Q1, f.bk, 888);
  fs.writeFileSync(path.join(f.proj, 'a.txt'), '我改的\n');
  const r = await withWriteFail(p => p.includes('pre-undo-'), () => ck.undoRewind(f.bk, bid));
  assert.equal(fs.readFileSync(path.join(f.proj, 'a.txt'), 'utf8'), '我改的\n');
  assert.deepEqual(r.skipped.map(p => path.basename(p)), ['a.txt']);
  assert.deepEqual(r.saved, []);
});

test('openInHubMsg:会话号、项目目录的大小写不同也认得出', () => {
  const slugOf = (p) => String(p).replace(/[^A-Za-z0-9-]/g, '-');
  assert.match(ck.openInHubMsg([{ projPath: 'c:\\Proj\\', sid: '' }], 'C--proj', SID, slugOf), /还没认出是哪个会话/);
  assert.match(ck.openInHubMsg([{ projPath: 'D:\\x', sid: SID.toUpperCase() }], 'C--proj', SID, slugOf), /正在总控里开着/);
});

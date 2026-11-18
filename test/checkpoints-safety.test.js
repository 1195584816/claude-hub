// 检查点回退 / 撤销的安全性(lib/checkpoints.js + main.js 的 ckpt:* 接线)。
//
// 背景:2026-11-18 上游审查。回退和撤销会写、会删用户项目里的文件,审查列出几处会弄丢文件的地方:
//   1. readOrNull 不分错误:文件被锁(EBUSY / EPERM)被记成 existed:false,撤销时被 unlink。
//      → 只把 ENOENT 当不存在;备份时任一文件读不了就放弃这次回退。
//   2. 记「回退后的样子」失败被吞掉后,撤销照样删 existed:false 的文件。→ 没记成就一律不删。
//   4. 备份清单靠解析 jsonl 推,推不准时照常回退,事后却恢复不了。→ 推不准就拒绝;确认框列出会动的文件。
//   5. 会话还在跑时也能回退;回退 / 撤销没有互斥。→ 总控里开着或一分钟内有写入就拒绝;按会话加锁。
//   7. 回退备份只增不删;git diff 会跑用户配置的外部对比程序。→ 清理旧备份;加 --no-ext-diff --no-textconv。
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
const iso = (minAgo) => new Date(Date.now() - minAgo * 60e3).toISOString();

// 两轮:Q1 改 a.txt、新建 b.txt;Q2 新建 c.txt。磁盘上现在 a = v2、b、c 都在
function fixture(extraLines = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-ckpt-safe-'));
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
test('sessionBusy:一分钟内有写入算在跑;since 之前的写入(回退自己写的)不算', async () => {
  const f = fixture();
  assert.equal(await ck.sessionBusy(f.P, f.home, f.slug, SID), false);
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
  assert.match(undo, /ckptRunningMsg\(m\.slug, sid, Number\(m\.jsonlMtime\) \|\| 0\)/);
  assert.match(MAIN, /const ckptOpenInHub = \(sid\) => \[\.\.\.termMeta\.values\(\)\]\.some\(m => m && m\.sid === sid\)/);
  assert.match(MAIN, /ckpt\.cleanBackups\(P\.REWIND_BACKUPS\)\.catch\(\(\) => \{\}\)/);
});

// ---------- 7. 旧备份清理、git diff 不跑外部程序 ----------
test('cleanBackups:超过 14 天的删,最新 10 份不管多旧都留;不是我们建的目录不碰', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-ckpt-clean-'));
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

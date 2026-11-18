// writeJsonAtomicAsync(lib/atomic-json.js):2026-11-18 上游审查要求 agents:launch 里的写文件改成异步(硬规矩 2),
// 加了这个和同步版一样「写临时文件 → fsync → 改名」的异步版。钉住:写得对、覆盖旧文件、失败时不留临时文件也不动原文件。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeJsonAtomic, writeJsonAtomicAsync } = require('../lib/atomic-json');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hub-atomic-'));

test('异步版:写出来和同步版一样,目录不存在会建,旧文件被整份替换', async () => {
  const d = tmp(), a = path.join(d, 'sub', 'a.json'), b = path.join(d, 'b.json');
  await writeJsonAtomicAsync(a, { x: [1, '中文'] });
  writeJsonAtomic(b, { x: [1, '中文'] });
  assert.equal(fs.readFileSync(a, 'utf8'), fs.readFileSync(b, 'utf8'));
  await writeJsonAtomicAsync(a, ['新的']);
  assert.deepEqual(JSON.parse(fs.readFileSync(a, 'utf8')), ['新的']);
  assert.deepEqual(fs.readdirSync(path.join(d, 'sub')), ['a.json'], '不留临时文件');
});

test('异步版:写不成时抛错,原文件不动,不留临时文件', async () => {
  const d = tmp(), f = path.join(d, 'a.json');
  fs.writeFileSync(f, '"旧的"');
  const circular = {}; circular.self = circular;                 // JSON.stringify 会抛
  await assert.rejects(writeJsonAtomicAsync(f, circular));
  assert.equal(fs.readFileSync(f, 'utf8'), '"旧的"');
  assert.deepEqual(fs.readdirSync(d), ['a.json']);
});

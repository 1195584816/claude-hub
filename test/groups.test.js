// 左栏「全部项目」的分组默认收起(2026-11-21 三月:「全部项目别默认展开」)。截 index.html 里真的 grpIsClosed 跑。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const i = HTML.indexOf('function grpIsClosed(name, hasCur) {');
const j = HTML.indexOf('function toggleGrp(name) {');
assert.ok(i >= 0 && j > i);
const load = (grpClosed) => new Function('grpClosed', HTML.slice(i, j) + '\nreturn grpIsClosed;')(grpClosed);

test('分组:没点过的默认收起;当前项目所在的组没被手动收起时自动展开;手动点过的按点的', () => {
  const f = load({ 视频: false, 翻墙: true });
  assert.equal(f('住宅IP', false), true, '没点过 = 收起');
  assert.equal(f('住宅IP', true), false, '当前项目在里面 = 撑开');
  assert.equal(f('视频', false), false, '手动展开过');
  assert.equal(f('翻墙', true), true, '手动收起过,当前项目在里面也照样收起');
});

test('接线:画分组、菜单、展开全部都走 grpIsClosed;展开全部逐组记成展开(不是清空)', () => {
  assert.match(HTML, /const closed = grpIsClosed\(g\.name, g\.items\.some\(p => p\.path === curPath\)\);/);
  assert.match(HTML, /grpClosed\[name\] = !grpIsClosed\(name, hasCur\);/);
  assert.doesNotMatch(HTML, /label: '展开全部分组', run: \(\) => \{ grpClosed = \{\};/);
});

// 2026-11-17 自查:onclick="f('${...}')" 里只用 escAttr 不够 —— 它把 ' 转成 &#39;,
// 浏览器解析属性时又还原成 ',照样把 JS 字符串截断。要先 escJs 再 escAttr。截 index.html 的真源码测。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const between = (a, b) => { const i = SRC.indexOf(a), j = SRC.indexOf(b, i); assert.ok(i >= 0 && j > i, '找不到标记 ' + a); return SRC.slice(i, j); };

const escAttr = new Function(between('// <esc-attr>', '// </esc-attr>') + '\nreturn escAttr;')();
const escJsLine = SRC.match(/^const escJs = .*$/m)[0];
const escJs = new Function(escJsLine + '\nreturn escJs;')();
// 模拟浏览器:先按 HTML 解出属性值,再把它当 JS 执行,看 f 收到的是不是原样
const htmlDecode = (s) => s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const runOnclick = (attr) => { let got; new Function('f', htmlDecode(attr))((x) => { got = x; }); return got; };

test('onclick 里的参数:escJs 再 escAttr 能原样送到;只用 escAttr 会截断', () => {
  for (const v of ["it's", 'a\\b', `x'); alert(1); ('`, '"<&>"', '中文 id']) {
    assert.equal(runOnclick(`f('${escAttr(escJs(v))}')`), v, JSON.stringify(v));
  }
  assert.throws(() => runOnclick(`f('${escAttr("it's")}')`));   // 修之前的写法:JS 语法错
});

test('左侧功能栏的几页里,onclick 拼字符串参数一律 escAttr(escJs(…))', () => {
  const pages = between('// ===== Agents 页 =====', "let lastProxyNote = '';");
  const bad = pages.match(/onclick="[a-zA-Z]+\('\$\{escAttr\((?!escJs\()/g);
  assert.equal(bad, null, '还有只用 escAttr 的:' + JSON.stringify(bad));
});

// 终端里能点的路径 / 网址常驻上色(2026-11-19)。
// index.html 里两条 <link-color> 标记之间的真源码截出来,喂假的 xterm 终端 + 假的链接识别跑。
// 假终端照真 xterm 的规矩:registerDecoration 不看当前是哪个缓冲区(子代理读源码确认:
// CoreBrowserTerminal.registerDecoration 直接交给 DecorationService,DOM 渲染器按行号找颜色),
// marker 跟着行走,回滚区满了往上挤时所有 marker.line 一起减,挤出去的 marker 自动作废。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
function cut(a, b) {
  const i = HTML.indexOf(a), j = HTML.indexOf(b);
  assert.ok(i >= 0 && j > i, '找不到 ' + a);
  return HTML.slice(i, j);
}
function load() {
  return new Function(cut('// <link-color>', '// </link-color>') + '\nreturn { linkColorAttach, linkKind, LINK_COLORS };')();
}

// 假终端:lines[i] = { text, wrapped };光标在最后一行
function fakeTerm(lines, { cols = 40, rows = 10 } = {}) {
  const decos = [], markers = [], bufSubs = [];
  const buf = {
    type: 'normal', viewportY: 0, baseY: 0, get cursorY() { return lines.length - 1; }, get length() { return lines.length; },
    getLine: (y) => lines[y] && { isWrapped: !!lines[y].wrapped, translateToString: () => lines[y].text },
  };
  const term = {
    cols, rows, buffer: { get active() { return buf; }, onBufferChange: (f) => { bufSubs.push(f); return { dispose() {} }; } },
    onRender: () => ({ dispose() {} }), onScroll: () => ({ dispose() {} }),
    registerMarker: (off) => {
      const m = { line: buf.baseY + buf.cursorY + off, isDisposed: false, dispose() { this.isDisposed = true; } };
      markers.push(m); return m;
    },
    registerDecoration: (o) => {                       // 真 xterm:不看缓冲区类型,照样挂
      const d = Object.assign({ disposed: false, dispose() { this.disposed = true; } }, o);
      decos.push(d); return d;
    },
  };
  // 回滚区满了:顶上挤掉 k 行,底下进来 k 行
  const trim = (k, newLines) => {
    lines.splice(0, k); lines.push(...newLines);
    for (const m of markers) { m.line -= k; if (m.line < 0) m.isDisposed = true; }
  };
  const switchTo = (type) => { buf.type = type; for (const f of bufSubs) f(); };
  const live = () => decos.filter(d => !d.disposed && !d.marker.isDisposed);
  return { term, buf, decos, markers, live, trim, switchTo, lines };
}
// 假链接识别:linksByLine[1 基行号] = [{ text, range, isDir }];hook 可以在回调前做手脚(模拟等磁盘时终端继续写)
function fakeProvider(linksByLine, hook) {
  const calls = [];
  return {
    calls,
    provideLinks: (n, cb) => {
      calls.push(n);
      const go = () => cb(typeof linksByLine === 'function' ? linksByLine(n) : linksByLine[n]);
      if (hook) Promise.resolve().then(() => hook(n)).then(go); else go();
    },
  };
}
const L = (text, sx, sy, ex, ey, isDir = false) => ({ text, isDir, range: { start: { x: sx, y: sy }, end: { x: ex, y: ey } } });

test('按类型分颜色', () => {
  const { linkKind, LINK_COLORS } = load();
  assert.equal(linkKind('https://x.com/a.mp4', false), 'url');
  assert.equal(linkKind('G:\\成片\\第1期.MP4', false), 'video');
  assert.equal(linkKind('G:\\成片\\a.mov', false), 'video');
  assert.equal(linkKind('C:\\pastes\\paste-1.png', false), 'image');
  assert.equal(linkKind('C:\\a\\b.JPEG', false), 'image');
  assert.equal(linkKind('C:\\a\\视频.mp4', true), 'dir', '目录名带扩展名也按目录');
  assert.equal(linkKind('C:\\a\\CLAUDE.md', false), 'file');
  for (const c of Object.values(LINK_COLORS)) assert.match(c, /^#[0-9a-f]{6}$/i, 'xterm 只认 #RRGGBB');
  assert.notEqual(LINK_COLORS.video, LINK_COLORS.file);
  assert.notEqual(LINK_COLORS.image, LINK_COLORS.file);
  assert.notEqual(LINK_COLORS.dir, LINK_COLORS.file);
});

test('一行里几条链接各染各的,x / width 对,目录看链接带的 isDir', async () => {
  const { linkColorAttach, LINK_COLORS } = load();
  const f = fakeTerm([{ text: '看 C:\\a.mp4 和 C:\\dir 还有 C:\\b.png' }, { text: '>' }]);
  const p = fakeProvider({ 1: [L('C:\\a.mp4', 3, 1, 10, 1), L('C:\\dir', 14, 1, 19, 1, true), L('C:\\b.png', 24, 1, 31, 1)] });
  const lc = linkColorAttach(f.term, p);
  await lc.scan();
  assert.deepEqual(f.live().map(x => [x.x, x.width, x.foregroundColor]),
    [[2, 8, LINK_COLORS.video], [13, 6, LINK_COLORS.dir], [23, 8, LINK_COLORS.image]]);
  assert.equal(f.live()[0].marker.line, 0, 'marker 挂在这一行上');
  lc.dispose();
});

test('跨行的链接:每一行只染落在自己这行的那一段', async () => {
  const { linkColorAttach } = load();
  const f = fakeTerm([{ text: 'x'.repeat(30) + 'C:\\aaaaaaa' }, { text: 'bb.mp4 说明', wrapped: true }, { text: '>' }], { cols: 40 });
  const link = L('C:\\aaaaaaabb.mp4', 31, 1, 6, 2);
  const lc = linkColorAttach(f.term, fakeProvider({ 1: [link], 2: [link] }));
  await lc.scan();
  assert.deepEqual(f.live().map(x => [x.marker.line, x.x, x.width]), [[0, 30, 10], [1, 0, 6]]);
  lc.dispose();
});

test('路径开头正好折到下一行(首行只到 F:),首行那一截也要问、也要染', async () => {
  const { linkColorAttach } = load();
  const f = fakeTerm([{ text: 'x'.repeat(38) + 'F:' }, { text: '\\a.mp4', wrapped: true }, { text: '>' }], { cols: 40 });
  const link = L('F:\\a.mp4', 39, 1, 6, 2);
  const p = fakeProvider({ 1: [link], 2: [link] });
  const lc = linkColorAttach(f.term, p);
  await lc.scan();
  assert.ok(p.calls.includes(1), '首行没有完整的 F:\\ 也得问');
  assert.deepEqual(f.live().map(x => [x.marker.line, x.x, x.width]), [[0, 38, 2], [1, 0, 6]]);
  lc.dispose();
});

test('行没变不重挂;行变了先撤旧颜色再重算', async () => {
  const { linkColorAttach } = load();
  const f = fakeTerm([{ text: 'C:\\a.mp4' }, { text: '>' }]);
  const links = { 1: [L('C:\\a.mp4', 1, 1, 8, 1)] };
  const p = fakeProvider(links);
  const lc = linkColorAttach(f.term, p);
  await lc.scan();
  await lc.scan();
  assert.equal(f.decos.length, 1, '没变就不重挂');
  assert.equal(p.calls.filter(n => n === 1).length, 1, '没变也不重新问链接');
  f.lines[0].text = '重画成了别的字 C:\\不存在';
  delete links[1];
  await lc.scan();
  assert.equal(f.live().length, 0, '旧颜色要撤掉,不能染在新字上');
});

test('跨行路径只有第二行变了(边打边折行):第一行的颜色也要跟着补上', async () => {
  const { linkColorAttach } = load();
  const f = fakeTerm([{ text: 'x'.repeat(30) + 'C:\\aaaaaaa' }, { text: 'bb', wrapped: true }, { text: '>' }], { cols: 40 });
  let done = false;
  const link = L('C:\\aaaaaaabb.mp4', 31, 1, 6, 2);
  const lc = linkColorAttach(f.term, fakeProvider((n) => (done && n <= 2 ? [link] : [])));
  await lc.scan();
  assert.equal(f.live().length, 0, '路径还没打完,查不到');
  f.lines[1].text = 'bb.mp4';           // 只有第二行变了
  done = true;
  await lc.scan();
  assert.deepEqual(f.live().map(x => [x.marker.line, x.x, x.width]).sort(), [[0, 30, 10], [1, 0, 6]]);
  lc.dispose();
});

test('有路径样子但一条链接都没有的行:记一笔,下次不白扫', async () => {
  const { linkColorAttach } = load();
  const f = fakeTerm([{ text: 'F:\\没有这个\\a.mp4' }, { text: '>' }]);
  const p = fakeProvider({});
  const lc = linkColorAttach(f.term, p);
  await lc.scan(); await lc.scan(); await lc.scan();
  assert.equal(p.calls.filter(n => n === 1).length, 1);
  assert.equal(f.decos.length, 0);
  lc.dispose();
});

test('没有路径 / 网址影子、也不挨着折行的行不去问链接识别', async () => {
  const { linkColorAttach } = load();
  const f = fakeTerm([{ text: '普通的一行字' }, { text: '又一行 abc' }, { text: '>' }]);
  const p = fakeProvider({});
  const lc = linkColorAttach(f.term, p);
  await lc.scan();
  assert.deepEqual(p.calls, []);
  lc.dispose();
});

test('① 切到备用缓冲区(全屏程序):颜色立刻全撤,不然会印到全屏画面同一位置;切回来重新上色', async () => {
  const { linkColorAttach } = load();
  const f = fakeTerm([{ text: 'PS F:\\proj> claude' }, { text: '>' }]);
  const lc = linkColorAttach(f.term, fakeProvider({ 1: [L('F:\\proj', 4, 1, 10, 1, true)] }));
  await lc.scan();
  assert.equal(f.live().length, 1);
  f.switchTo('alternate');
  assert.equal(f.live().length, 0, '切过去当场就撤,不等下一轮');
  await lc.scan();
  assert.equal(f.live().length, 0, '全屏期间不上色');
  f.switchTo('normal');
  await lc.scan();
  assert.equal(f.live().length, 1, '切回来重新上色');
  lc.dispose();
});

// 注:「行号挪了就作废这一轮」和「等完再比一次这行的字」是两道闸,后一道单独就能把这个场景拦住,
// 所以变异检验时只关前一道这条照样过 —— 前一道是给「挤上来的行恰好和原来同字」留的保险。
test('② 等磁盘的工夫回滚区挤掉了几行:颜色挂在对的行上,不重复', async () => {
  const { linkColorAttach } = load();
  const f = fakeTerm([{ text: 'C:\\a.mp4' }, { text: '中间' }, { text: 'C:\\b.png' }, { text: '>' }]);
  // 按当前内容出链接:哪一行写着什么就给什么
  const linksNow = (n) => {
    const t = f.lines[n - 1] && f.lines[n - 1].text;
    return t && t.startsWith('C:\\') ? [L(t, 1, n, t.length, n)] : [];
  };
  let trimmed = false;
  const p = fakeProvider(linksNow, () => { if (!trimmed) { trimmed = true; f.trim(1, [{ text: '新来的一行' }]); } });
  const lc = linkColorAttach(f.term, p);
  await lc.scan();                       // 第一轮中途挤掉一行 → 作废
  await lc.scan();                       // 重扫
  const byLine = f.live().map(d => [d.marker.line, f.lines[d.marker.line].text, d.width]);
  assert.deepEqual(byLine, [[1, 'C:\\b.png', 8]], JSON.stringify(byLine));
  lc.dispose();
});

test('扫描进行中关掉终端:之后不再往上挂东西', async () => {
  const { linkColorAttach } = load();
  const f = fakeTerm([{ text: 'C:\\a.mp4' }, { text: '>' }]);
  let lc;
  const p = fakeProvider({ 1: [L('C:\\a.mp4', 1, 1, 8, 1)] }, () => lc.dispose());
  lc = linkColorAttach(f.term, p);
  await lc.scan();
  assert.equal(f.decos.length, 0);
});

test('接线:识别链接的同一个对象拿去上色;关标签先拆上色;链接对象带 isDir', () => {
  assert.match(HTML, /const linkProv = termLinkProvider\(term\);\s*\n\s*term\.registerLinkProvider\(linkProv\);[^\n]*\n\s*const linkColor = linkColorAttach\(term, linkProv\);/);
  assert.match(HTML, /projShort, term, fit, pane, linkColor[,\s}]/);
  assert.match(HTML, /if \(termTabs\[i\]\.linkColor\) termTabs\[i\]\.linkColor\.dispose\(\);[^\n]*\r?\n\s*try \{ termTabs\[i\]\.term\.dispose\(\); \}/);
  const pure = cut('// <pure-termlink-logic>', '// </pure-termlink-logic>');
  assert.match(pure, /isDir = !!r\.isDir;/);
  assert.match(pure, /\n\s*isDir,/);
});

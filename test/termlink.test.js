// 终端里「路径/链接可点击」的边界口径。
//
// 这组测试是为 2026-11-09 那个 bug 建的:三月说「可点击路径链接把后面的汉字也吃进去了」。
//
// 根因有两条,都是「没问清楚就猜边界」:
//   ① 下标错位。text 是把每个格子的 getChars() 拼起来的,正则给的 m.index 是【码元】下标;
//      chars[] 却是按【格子】存的。一个格子可能吐出 2 个码元 —— 表情(📄 代理对)、
//      带变体选择符的 ⚠️(U+26A0 U+FE0F)、组合字。行里只要出现过一个,后面所有链接的
//      下标就整体错开:下划线开头少盖一个字母、结尾多吃一个汉字;错到行尾外链接直接消失。
//      Claude Code 的输出里这些符号遍地都是,所以他天天撞。
//   ② 磁盘查不到时回退 guess 还照划。查不到就等于不知道右边界在哪,
//      末段没扩展名的话,后面跟的中文说明会被整段圈进下划线。
//
// 验收又查出同一处的三条(都已修,下面都有用例守着):
//   ③ 削字跨过了末段的反斜杠 → 塌到存在的祖先目录上,"查不到就不划"的承诺失效
//   ④ 削字上限写死 24 → 目录后跟 ≥25 个汉字时削不到真目录名,整条链接消失
//   ⑤ 空白(NULL)格和宽字符后半格都返回空串,一视同仁跳过会把两边的文字粘成一条
//   ⑥ 结束列没算宽字符的后半格 → 末字是汉字时下划线只盖左半格
//
// 测试直接从 index.html 里截真源码来跑(两条 <pure-termlink-logic> 标记之间),
// 再造一个假的 xterm buffer 驱动它,所以测的就是他机器上跑的那份实现。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function pickBlock() {
  const a = SRC.indexOf('// <pure-termlink-logic>');
  const b = SRC.indexOf('// </pure-termlink-logic>');
  assert.ok(a >= 0 && b > a, 'index.html 里找不到 <pure-termlink-logic> 标记 —— 实现被挪走了?');
  return SRC.slice(a, b);
}

// 假磁盘:只有这些路径"存在"
const DISK = new Set();
function mkHub() {
  const one = (x) => {
    if (!DISK.has(x)) return null;
    const isFile = /\.[A-Za-z0-9]{1,8}$/.test(x);
    return { exists: true, isDir: !isFile, isFile, path: x };
  };
  return {
    pathInfo: async (p) => {
      if (Array.isArray(p)) {
        for (const x of p) { const r = one(String(x || '')); if (r) return r; }
        return { exists: false, isDir: false, isFile: false, path: '' };
      }
      return one(String(p || '')) || { exists: false, isDir: false, isFile: false, path: String(p || '') };
    }
  };
}
function load() {
  return new Function('hub', pickBlock() + '\nreturn { termLinkProvider, cleanUrlTail, pathCandidates };')(mkHub());
}

// ---- 假 xterm buffer ----
// 照真 xterm 的规矩排:
//   · 宽字符占两格,后半格 getChars()==='' 且 getWidth()===0
//   · 空白(NULL)格 getChars()==='' 但 getWidth()===1
//   · 变体选择符/零宽连接符并进前一个格子(所以那一格会吐出 2 个码元)
//   · getCell(越界) 返回 undefined(xterm.d.ts 明写)
// 宽度表按 xterm 默认的 UnicodeV6 provider:cp >= 0x10000 时只有
// 0x20000-0x2FFFD / 0x30000-0x3FFFD 才算宽 —— 也就是说 📄(U+1F4C4)在它眼里是【窄】的,
// 正好是"一个格子吐 2 个码元"的纯净样本。
function isWide(cp) {
  if (cp >= 0x10000) return (cp >= 0x20000 && cp <= 0x2fffd) || (cp >= 0x30000 && cp <= 0x3fffd);
  return (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0x303e) ||
         (cp >= 0x3041 && cp <= 0x33ff) || (cp >= 0x3400 && cp <= 0x4dbf) ||
         (cp >= 0x4e00 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) ||
         (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe6f) ||
         (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6);
}
const NUL = '\u0000';   // 在用例文本里写它 = 一个真正的空白格
function toCells(s) {
  const cells = [];
  const cps = Array.from(s);
  for (let i = 0; i < cps.length; i++) {
    if (cps[i] === NUL) { cells.push({ ch: '', w: 1 }); continue; }
    let ch = cps[i];
    while (i + 1 < cps.length && /[\ufe0f\ufe0e\u200d\u20e3]/.test(cps[i + 1])) ch += cps[++i];
    const w = isWide(ch.codePointAt(0)) ? 2 : 1;
    cells.push({ ch, w });
    if (w === 2) cells.push({ ch: '', w: 0 });       // 后半格
  }
  return cells;
}
function width(s) { return toCells(s).length; }      // 占多少列(含后半格)
function mkTerm(rows, cols, extra) {
  const lines = rows.map(r => ({ cells: toCells(r.text), wrapped: !!r.wrapped }));
  return {
    ...(extra || {}),
    cols,
    buffer: { active: {
      getLine: (i) => {
        const L = lines[i];
        if (!L) return undefined;
        return {
          isWrapped: L.wrapped,
          getCell: (c) => {
            if (c < 0 || c >= cols) return undefined;        // 真 xterm 越界返回 undefined
            const cell = L.cells[c] || { ch: '', w: 1 };     // 行里没写满的部分 = 空白格
            return { getChars: () => cell.ch, getWidth: () => cell.w };
          }
        };
      }
    } }
  };
}

// 把 range 还原成"屏幕上真正被下划线盖住的那串字" —— 这才是三月眼睛看到的东西。
// 只断言 link.text 是不够的:错位 bug 里 text 是对的,盖住的格子是错的。
function covered(term, cols, link) {
  let s = '';
  for (let y = link.range.start.y; y <= link.range.end.y; y++) {
    const line = term.buffer.active.getLine(y - 1);
    if (!line) break;
    const x0 = y === link.range.start.y ? link.range.start.x : 1;
    const x1 = y === link.range.end.y ? link.range.end.x : cols;
    for (let x = x0; x <= x1; x++) {
      const c = line.getCell(x - 1);
      if (c) s += c.getChars();
    }
  }
  return s;
}
function links(rows, cols, hoverLine, extra) {
  const api = load();
  const term = mkTerm(rows, cols, extra);
  return new Promise(res => {
    api.termLinkProvider(term).provideLinks(hoverLine, (ls) => {
      res((ls || []).map(l => ({
        text: l.text, cover: covered(term, cols, l), range: l.range, activate: l.activate
      })));
    });
  });
}

const P = 'F:\\claude-project\\claude-hub\\index.html';
const CN = 'F:\\claude-project\\视频复刻\\CLAUDE.md';
const DIR = 'F:\\claude-project\\claude-hub';
const CNDIR = 'F:\\claude-project\\视频复刻';
test.beforeEach(() => {
  DISK.clear();
  [P, CN, DIR, CNDIR, 'F:\\claude-project'].forEach(x => DISK.add(x));
});

test('路径独占一行:下划线正好盖住整条路径', async () => {
  const r = await links([{ text: P }], 120, 1);
  assert.equal(r.length, 1);
  assert.equal(r[0].text, P);
  assert.equal(r[0].cover, P);
});

test('路径后面紧跟汉字:汉字不进下划线', async () => {
  const r = await links([{ text: P + '里写了渲染逻辑' }], 120, 1);
  assert.equal(r.length, 1);
  assert.equal(r[0].cover, P, '下划线盖到后面的中文说明里去了');
});

test('行首有汉字(宽字符占两格):列号仍然对得上', async () => {
  const r = await links([{ text: '我改了 ' + P + ' 这个文件' }], 120, 1);
  assert.equal(r.length, 1);
  assert.equal(r[0].cover, P);
});

// —— 根因① 的复现 ——
test('行首有 📄(1 格 2 码元):链接不该整体右移', async () => {
  const r = await links([{ text: '📄 ' + P }], 120, 1);
  assert.equal(r.length, 1, '错位把结束格推到行尾之外,链接整条消失了');
  assert.equal(r[0].cover, P);
});

test('行首有 ⚠️(基字符+变体选择符):开头不该少一个字母、结尾不该多吃一个汉字', async () => {
  const r = await links([{ text: '⚠️ ' + P + '后面还有汉字' }], 120, 1);
  assert.equal(r.length, 1);
  assert.equal(r[0].cover, P);
});

test('表情 + 中文路径 + 尾部汉字:三样凑一块也要准', async () => {
  const r = await links([{ text: '📄 已写入 ' + CN + '里的第三节' }], 120, 1);
  assert.equal(r.length, 1);
  assert.equal(r[0].cover, CN);
});

test('多个表情累积错位:仍然准', async () => {
  const r = await links([{ text: '✅ 📄 🤖 ⚠️ ' + P + ',然后呢' }], 140, 1);
  assert.equal(r.length, 1);
  assert.equal(r[0].cover, P);
});

// —— 根因② ——
test('磁盘上查不到的路径:一个字都不划', async () => {
  const r = await links([{ text: 'F:\\不存在的目录名后面紧跟中文说明' }], 120, 1);
  assert.equal(r.length, 0, '查不到就不知道右边界在哪,不许猜着划');
});

// —— 验收查出的 ③:不许塌到祖先目录 ——
// 这条才是真的在守承诺。上面那条用的是根目录下的路径,祖先只剩 F: 会被长度闸挡掉,
// 过了也说明不了问题 —— 必须拿一个【祖先真实存在】的二级路径来试。
test('末段不存在时,不许塌到存在的祖先目录上', async () => {
  const r = await links([{ text: 'F:\\claude-project\\某个不存在的目录' }], 120, 1);
  assert.equal(r.length, 0, '削过了头,把存在的父目录 F:\\claude-project 划成了链接');
});

test('末段不存在时,也不许塌到存在的上一层项目目录', async () => {
  const r = await links([{ text: 'F:\\claude-project\\claude-hub\\这个文件不存在' }], 120, 1);
  assert.equal(r.length, 0);
});

// —— 验收查出的 ④:削字不许被写死的上限截停 ——
test('目录后面跟 30 个汉字:照样削得到真目录名', async () => {
  const tail = '一二三四五六七八九十'.repeat(3);
  const r = await links([{ text: CNDIR + tail }], 200, 1);
  assert.equal(r.length, 1, '写死 24 次上限的话,削不到真目录名,链接整条消失');
  assert.equal(r[0].cover, CNDIR);
});

test('末段是中文目录名:削到磁盘认领的那一层为止', async () => {
  const r = await links([{ text: DIR + '目录下的那个文件' }], 120, 1);
  assert.equal(r.length, 1);
  assert.equal(r[0].cover, DIR);
});

// —— 验收查出的 ⑥:结束列要含宽字符的后半格 ——
test('路径以汉字结尾:下划线要盖满整个格子,不是半格', async () => {
  const r = await links([{ text: CNDIR + ' 这个目录' }], 120, 1);
  assert.equal(r.length, 1);
  const g = r[0].range;
  assert.equal(g.end.x - g.start.x + 1, width(CNDIR),
    '结束列没算宽字符后半格 —— 末字「刻」只有左半边有下划线,鼠标停右半格还不认链接');
});

test('路径以 ASCII 结尾:结束列不该多算', async () => {
  const r = await links([{ text: P + ' 改完了' }], 120, 1);
  const g = r[0].range;
  assert.equal(g.end.x - g.start.x + 1, width(P));
});

// —— 验收查出的 ⑤:空白格不能和宽字符后半格混为一谈 ——
test('两条路径中间隔着空白格:各划各的,不被粘成一条', async () => {
  const r = await links([{ text: P + NUL + NUL + NUL + CN }], 200, 1);
  assert.equal(r.length, 2, '空白格被当成宽字符后半格跳过了,两条路径粘成一条,结果一条都划不出来');
  assert.deepEqual(r.map(x => x.cover).sort(), [P, CN].sort());
});

test('软换行:长路径被劈成两行仍然可点,且两行加起来正好是整条', async () => {
  const head = '0123456789012345678901234567890123456789';
  const r = await links(
    [{ text: head + P.slice(0, 20) }, { text: P.slice(20), wrapped: true }], 60, 2);
  assert.equal(r.length, 1);
  assert.equal(r[0].cover, P);
});

test('URL:后面紧跟的汉字不进链接,前面有表情也不错位', async () => {
  const u = 'https://github.com/anthropics/claude-code';
  const r = await links([{ text: '📄 见 ' + u + '这个仓库' }], 140, 1);
  assert.equal(r.length, 1);
  assert.equal(r[0].text, u);
  assert.equal(r[0].cover, u);
});

test('引号包起来的带空格路径:引号本身不进下划线', async () => {
  const q = 'C:\\Program Files\\Git\\bin\\git.exe';
  DISK.add(q);
  const r = await links([{ text: '跑的是 "' + q + '" 这个' }], 140, 1);
  assert.equal(r.length, 1);
  assert.equal(r[0].cover, q);
});

test('一行里两条路径:各划各的,不串台', async () => {
  const r = await links([{ text: '⚠️ ' + P + ' 和 ' + CN + ' 都改了' }], 200, 1);
  assert.equal(r.length, 2);
  assert.deepEqual(r.map(x => x.cover).sort(), [P, CN].sort());
});

// —— 复验查出的残余:末段第一个字会被 TRIM_TAIL 剥掉时,祖先又漏出来 ——
test('末段以点号开头又不存在:仍然不许塌到祖先目录', async () => {
  const r = await links([{ text: 'F:\\claude-project\\.备份目录' }], 120, 1);
  assert.equal(r.length, 0,
    '削到只剩 "\\.备份" 时 TRIM_TAIL 把点号连同反斜杠一起剥了,祖先 F:\\claude-project 又漏出来');
});

test('中文说明长达 60 字:削字不许被任何写死的上限截停', async () => {
  const tail = '一二三四五六七八九十'.repeat(6);
  const r = await links([{ text: CNDIR + tail }], 400, 1);
  assert.equal(r.length, 1, '候选清单被按条数砍过,正确答案排在队尾就被丢掉了');
  assert.equal(r[0].cover, CNDIR);
});

// —— 复验查出的新问题:剪行尾空白把真实的空格也剪了 ——
test('软换行正好断在路径里的空格上:链接不许断', async () => {
  const q = 'C:\\Program Files\\Git\\bin\\git.exe';
  DISK.add(q);
  // 12 列。第一行最后一格是路径里【真实的】空格(不是填充),第二三行是续行。
  const r = await links([
    { text: '"C:\\Program ' },
    { text: 'Files\\Git\\bi', wrapped: true },
    { text: 'n\\git.exe"', wrapped: true }
  ], 12, 2);
  assert.equal(r.length, 1, '行尾那个真实空格被当成填充剪掉了,两行粘成 C:\\ProgramFiles\\... 谁也对不上');
  assert.equal(r[0].cover, q);
});

// —— 拖选时不许顺手把文件打开 ——
test('有选区时 activate 直接返回,不去开文件', async () => {
  const r = await links([{ text: P }], 120, 1, { hasSelection: () => true });
  assert.equal(r.length, 1);
  // 沙箱里没有 openTermLink,真去调就会 ReferenceError —— 不抛就说明被闸住了
  assert.doesNotThrow(() => r[0].activate({ preventDefault() {} }, P));
});

test('没有选区时 activate 照常往下走', async () => {
  const r = await links([{ text: P }], 120, 1, { hasSelection: () => false });
  assert.throws(() => r[0].activate({ preventDefault() {} }, P), /openTermLink/,
    '这条反过来证明上一条不是因为别的原因没抛');
});

test('file:line:col 这种最常见的输出:只划到文件名为止', async () => {
  const r = await links([{ text: '报错在 ' + P + ':2695:12 这儿' }], 140, 1);
  assert.equal(r.length, 1);
  assert.equal(r[0].cover, P);
});

// 2026-11-19:ConPTY 在宽字符排到行尾放不下时,最后一格补一个【真】空格、把字挪到下一行。
// 不扔掉这个补位空格,「…\测试 视频.mp4」在空格处断开,路径既点不了也上不了色。
test('ConPTY 行尾补位空格:宽字符折到下一行时,路径照样连成一条', async () => {
  const p = 'F:\\a\\测试视频.mp4';
  DISK.add(p);
  const row1 = 'X F:\\a\\测试 ';                   // 最后一格是补位空格
  const cols = width(row1);
  const r = await links([{ text: row1 }, { text: '视频.mp4 说明', wrapped: true }], cols, 1);
  assert.equal(r.length, 1);
  assert.equal(r[0].text, p);
  assert.equal(r[0].range.start.y, 1);
  assert.equal(r[0].range.end.y, 2);
});

test('ConPTY 行尾补位空格:下一行开头是窄字符时,那个空格是真内容,不吞', async () => {
  DISK.add('F:\\a\\xy.txt');
  const row1 = 'X F:\\a\\x ';
  const r = await links([{ text: row1 }, { text: 'y.txt', wrapped: true }], width(row1), 1);
  assert.ok(!r.some(l => l.text === 'F:\\a\\xy.txt'), JSON.stringify(r.map(l => l.text)));
});

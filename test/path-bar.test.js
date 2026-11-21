// 终端里路径旁的小工具条:打开 / 打开所在文件夹 / 拖到微信(2026-11-19)。
//
// 主进程那段(两条 <drag-file> 标记之间)原样截出来,喂假的 ipcMain / app / shell 跑:
//   · 只许拖真存在的普通文件(绝对路径);目录、不存在、相对路径、非字符串一律不拖
//   · startDrag 必须带非空图标:系统给这个文件的图标拿不到时,用总控程序(exe)的图标
//     (build\icon.ico 不会被打进安装版,不能拿它兜底 —— 子代理复核查出来的)
//   · 打开所在文件夹:不存在 / 相对路径不开
// 界面那段(<path-bar>)也原样截出来,用假计时器 + 最小的 DOM 桩跑计时和收放逻辑。
const test = require('node:test');
const { mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MAIN = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const PRELOAD = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');

function cut(src, a, b) {
  const i = src.indexOf(a), j = src.indexOf(b);
  assert.ok(i >= 0 && j > i, '找不到标记 ' + a);
  return src.slice(i, j);
}

const tmpRoots = [];
test.after(() => { for (const d of tmpRoots) try { fs.rmSync(d, { recursive: true, force: true }); } catch {} });

// ======================= 主进程 =======================
function img(empty) { return { isEmpty: () => empty }; }

function loadMain({ fileIcon = img(false), exeIcon = img(false), throwOnDrag = false } = {}) {
  const handles = {}, ons = {}, calls = { drag: [], shown: [], asked: [] };
  const ipcMain = { handle: (k, f) => { handles[k] = f; }, on: (k, f) => { ons[k] = f; } };
  const app = {
    getFileIcon: async (p) => {
      calls.asked.push(p);
      const v = p === process.execPath ? exeIcon : fileIcon;
      if (v === 'throw') throw new Error('x');
      return v;
    },
  };
  const shell = { showItemInFolder: (p) => calls.shown.push(p) };
  new Function('ipcMain', 'app', 'shell', 'fs', 'path', 'process', cut(MAIN, '// <drag-file>', '// </drag-file>'))(
    ipcMain, app, shell, fs, path, process);
  const sender = { startDrag: (o) => { if (throwOnDrag) throw new Error('boom'); calls.drag.push(o); } };
  const drag = async (p) => { await ons['hub:dragFile']({ sender }, p); await new Promise(r => setImmediate(r)); };
  return { handles, calls, drag };
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-pathbar-'));
  tmpRoots.push(root);
  const file = path.join(root, '第1-2段连起来.mp4');
  fs.writeFileSync(file, 'x');
  return { root, file };
}

test('拖文件:真存在的普通文件 → startDrag 带上文件和图标', async () => {
  const f = fixture();
  const m = loadMain();
  await m.drag(f.file);
  assert.equal(m.calls.drag.length, 1);
  assert.equal(m.calls.drag[0].file, f.file);
  assert.ok(!m.calls.drag[0].icon.isEmpty());
});

test('拖文件:目录、不存在、相对路径、非字符串都不拖', async () => {
  const f = fixture();
  const m = loadMain();
  for (const p of [f.root, path.join(f.root, '没有这个.mp4'), '第1-2段连起来.mp4', '.\\a.mp4', null, 42, { path: f.file }]) await m.drag(p);
  assert.equal(m.calls.drag.length, 0);
  assert.equal(await m.handles['hub:prepDrag'](null, f.root), false);
  assert.equal(await m.handles['hub:prepDrag'](null, 'rel.txt'), false);
});

test('拖文件:系统图标拿不到(空 / null / 抛错)就用总控程序的图标', async () => {
  for (const fileIcon of [img(true), null, 'throw']) {
    const f = fixture();
    const m = loadMain({ fileIcon });
    await m.drag(f.file);
    assert.equal(m.calls.drag.length, 1, String(fileIcon));
    assert.deepEqual(m.calls.asked, [f.file, process.execPath]);
    assert.ok(!m.calls.drag[0].icon.isEmpty());
  }
  assert.doesNotMatch(cut(MAIN, '// <drag-file>', '// </drag-file>'), /createFromPath|icon\.ico'/, '别再拿 build\\icon.ico 兜底:安装版里没有它');
});

test('拖文件:两种图标都拿不到就不拖(startDrag 带空图标会抛错)', async () => {
  const f = fixture();
  const m = loadMain({ fileIcon: img(true), exeIcon: 'throw' });
  await m.drag(f.file);
  assert.equal(m.calls.drag.length, 0);
  assert.equal(await m.handles['hub:prepDrag'](null, f.file), false);
});

test('拖文件:悬停时先取好的图标,真拖时直接用,不再问系统', async () => {
  const f = fixture();
  const m = loadMain();
  assert.equal(await m.handles['hub:prepDrag'](null, f.file), true);
  await m.drag(f.file);
  assert.deepEqual(m.calls.asked, [f.file]);
  assert.equal(m.calls.drag.length, 1);
});

test('拖文件:startDrag 抛错不往外冒', async () => {
  const f = fixture();
  await loadMain({ throwOnDrag: true }).drag(f.file);
});

test('打开所在文件夹:文件和目录都行;不存在、相对路径不开', async () => {
  const f = fixture();
  const m = loadMain();
  assert.equal(await m.handles['hub:showInFolder'](null, f.file), true);
  assert.equal(await m.handles['hub:showInFolder'](null, f.root), true);
  assert.equal(await m.handles['hub:showInFolder'](null, path.join(f.root, '没有.mp4')), false);
  assert.equal(await m.handles['hub:showInFolder'](null, '第1-2段连起来.mp4'), false);
  assert.equal(await m.handles['hub:showInFolder'](null, undefined), false);
  assert.deepEqual(m.calls.shown, [f.file, f.root]);
});

// ======================= 界面 =======================
function fakeEl(extra = {}) {
  const ls = {}, cls = new Set();
  return Object.assign({
    style: {}, offsetWidth: 240, offsetHeight: 34,
    classList: { add: c => cls.add(c), remove: c => cls.delete(c), contains: c => cls.has(c) },
    addEventListener: (k, f) => { (ls[k] = ls[k] || []).push(f); },
    fire: (k, e) => { for (const f of ls[k] || []) f(e); },
  }, extra);
}
// target:mousemove 时鼠标下面是什么('bar' / 'xterm' / 'other')
function target(kind) { return { closest: (sel) => (sel === '.pathbar' && kind === 'bar') || (sel === '.xterm' && kind === 'xterm') || (sel === 'button' && kind === 'button') ? {} : null }; }

function loadUi({ disk = {}, dragFile = true } = {}) {
  const calls = { dragFile: [], prep: [], open: [], toast: [], shown: [], focus: 0 };
  const drag = fakeEl();
  const bar = fakeEl({ querySelector: () => drag });
  const docLs = {}, winLs = {};
  const document = {
    createElement: () => bar,
    body: { appendChild: () => {} },
    addEventListener: (k, f) => { (docLs[k] = docLs[k] || []).push(f); },
  };
  const window = { innerWidth: 1600, addEventListener: (k, f) => { (winLs[k] = winLs[k] || []).push(f); } };
  const hub = {
    showInFolder: async (p) => { calls.shown.push(p); return true; },
    prepDrag: async (p) => { calls.prep.push(p); return true; },
  };
  if (dragFile) hub.dragFile = (p) => calls.dragFile.push(p);
  const resolvePath = async (p) => (disk[p] ? { exists: true, path: p, isDir: disk[p] === 'dir' } : { exists: false, path: p, isDir: false });
  const termTabs = [{ id: 't1', term: { focus: () => { calls.focus++; } } }];
  const api = new Function('document', 'window', 'hub', 'resolvePath', 'openTermLink', 'hubToast', 'termTabs', 'activeTerm',
    cut(HTML, '// <path-bar>', '// </path-bar>')
    + '\nreturn { pathBarShow, pathBarHide, pathBarOwnDrop, st: () => ({ pbPath, pbDrag, on: !!pbEl && pbEl.classList.contains("on") }) };')(
    document, window, hub, resolvePath, (p) => calls.open.push(p), (m) => calls.toast.push(m), termTabs, 't1');
  const fireDoc = (k, e) => { for (const f of docLs[k] || []) f(e); };
  const fireWin = (k, e) => { for (const f of winLs[k] || []) f(e); };
  return { api, calls, bar, drag, fireDoc, fireWin };
}

const ev = (x = 400, y = 300) => ({ clientX: x, clientY: y });
const FILE = 'G:\\deskbox\\小桃\\第1-2段连起来.mp4', DIR = 'G:\\deskbox\\小桃', FILE2 = 'F:\\a\\b.txt';
// 推进假时钟,再让 resolvePath 的 await 跑完
async function tick(ms) { mock.timers.tick(ms); for (let i = 0; i < 5; i++) await Promise.resolve(); }

test('界面:停 250ms 才弹;不到 250ms 就离开不弹', async (t) => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] }); t.after(() => mock.timers.reset());
  const u = loadUi({ disk: { [FILE]: 'file' } });
  u.api.pathBarShow(ev(), FILE);
  await tick(200);
  u.api.pathBarHide();                // xterm 的 leave
  await tick(600);
  assert.equal(u.api.st().on, false);
  u.api.pathBarShow(ev(), FILE);
  await tick(260);
  assert.equal(u.api.st().on, true);
  assert.equal(u.api.st().pbPath, FILE);
  assert.notEqual(u.drag.style.display, 'none', '文件给拖拽把手');
  assert.deepEqual(u.calls.prep, [FILE]);
});

test('界面:目录不给拖拽把手;没有 hub.dragFile 也不给', async (t) => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] }); t.after(() => mock.timers.reset());
  const u = loadUi({ disk: { [DIR]: 'dir' } });
  u.api.pathBarShow(ev(), DIR); await tick(260);
  assert.equal(u.api.st().on, true);
  assert.equal(u.drag.style.display, 'none');
  const u2 = loadUi({ disk: { [FILE]: 'file' }, dragFile: false });
  u2.api.pathBarShow(ev(), FILE); await tick(260);
  assert.equal(u2.drag.style.display, 'none');
});

test('界面:Claude 在刷新的区域里同一条路径不停 leave/hover,照样能弹出来', async (t) => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] }); t.after(() => mock.timers.reset());
  const u = loadUi({ disk: { [FILE]: 'file' } });
  u.api.pathBarShow(ev(), FILE);
  for (let i = 0; i < 5; i++) { await tick(80); u.api.pathBarHide(); u.api.pathBarShow(ev(), FILE); }   // 每 80ms 重绘一次
  assert.equal(u.api.st().on, true);
});

test('界面:离开路径 350ms 内进到工具条上不收;不进就收', async (t) => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] }); t.after(() => mock.timers.reset());
  const u = loadUi({ disk: { [FILE]: 'file' } });
  u.api.pathBarShow(ev(), FILE); await tick(260);
  u.api.pathBarHide(); await tick(200);
  u.bar.fire('mouseenter', {});
  await tick(1000);
  assert.equal(u.api.st().on, true);
  u.bar.fire('mouseleave', {});
  await tick(400);
  assert.equal(u.api.st().on, false);
});

test('界面:A 显示着时移到 B,工具条换成 B;resolvePath 期间离开不弹', async (t) => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] }); t.after(() => mock.timers.reset());
  const u = loadUi({ disk: { [FILE]: 'file', [FILE2]: 'file' } });
  u.api.pathBarShow(ev(), FILE); await tick(260);
  u.api.pathBarHide(); u.api.pathBarShow(ev(400, 340), FILE2); await tick(260);
  assert.equal(u.api.st().pbPath, FILE2);
  assert.equal(u.api.st().on, true);
  const u2 = loadUi({ disk: { [FILE]: 'file' } });
  u2.api.pathBarShow(ev(), FILE);
  mock.timers.tick(250);              // 计时到了,resolvePath 还没回来
  u2.api.pathBarHide(true);
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(u2.api.st().on, false);
});

test('界面:按键只收工具条,不拦键;鼠标离开终端和工具条也收', async (t) => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] }); t.after(() => mock.timers.reset());
  const u = loadUi({ disk: { [FILE]: 'file' } });
  u.api.pathBarShow(ev(), FILE); await tick(260);
  let prevented = 0, stopped = 0;
  u.fireDoc('keydown', { key: 'a', preventDefault: () => prevented++, stopPropagation: () => stopped++ });
  assert.equal(u.api.st().on, false);
  assert.equal(prevented + stopped, 0);
  u.api.pathBarShow(ev(), FILE); await tick(260);
  u.fireDoc('mousemove', { buttons: 0, target: target('xterm') });
  assert.equal(u.api.st().on, true, '还在终端上(xterm 自己会发 leave)');
  u.fireDoc('mousemove', { buttons: 0, target: target('other') });
  await tick(200);
  u.fireDoc('mousemove', { buttons: 0, target: target('other') });   // 一直在动也不重新计时
  await tick(200);
  assert.equal(u.api.st().on, false, '终端被关掉 / 鼠标挪出去了');
  // 从路径往工具条挪,途中经过标签栏:350ms 内进到工具条就不收
  u.api.pathBarShow(ev(), FILE); await tick(260);
  u.api.pathBarHide();
  u.fireDoc('mousemove', { buttons: 0, target: target('other') });
  await tick(150);
  u.bar.fire('mouseenter', {});
  await tick(1000);
  assert.equal(u.api.st().on, true, '路过标签栏进到工具条上,不该收');
});

test('界面:点按钮不抢焦点,点完把焦点还给终端;打开所在文件夹走 showInFolder', async (t) => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] }); t.after(() => mock.timers.reset());
  const u = loadUi({ disk: { [FILE]: 'file' } });
  u.api.pathBarShow(ev(), FILE); await tick(260);
  let prevented = 0;
  u.bar.fire('mousedown', { target: target('button'), preventDefault: () => prevented++ });
  assert.equal(prevented, 1);
  u.bar.fire('click', { target: { closest: () => ({ dataset: { a: 'dir' } }) } });
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.deepEqual(u.calls.shown, [FILE]);
  assert.equal(u.calls.focus, 1);
  assert.match(u.calls.toast[0], /已打开所在文件夹:小桃/);
  u.api.pathBarShow(ev(), FILE); await tick(260);
  u.bar.fire('click', { target: { closest: () => ({ dataset: { a: 'open' } }) } });
  assert.deepEqual(u.calls.open, [FILE]);
});

test('界面:拖拽期间工具条不收;落回终端不填路径;拖完鼠标一动就收', async (t) => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] }); t.after(() => mock.timers.reset());
  const u = loadUi({ disk: { [FILE]: 'file' } });
  u.api.pathBarShow(ev(), FILE); await tick(260);
  let prevented = 0;
  u.drag.fire('dragstart', { preventDefault: () => prevented++ });
  assert.equal(prevented, 1, '浏览器自己的拖拽要拦掉');
  assert.deepEqual(u.calls.dragFile, [FILE]);
  u.bar.fire('mouseleave', {});
  await tick(1000);
  assert.equal(u.api.st().on, true, '拖拽期间不收');
  assert.equal(u.api.pathBarOwnDrop([FILE.toLowerCase()]), true, '自己拖出去又落回终端');
  assert.equal(u.calls.focus, 1, '按住把手时终端丢了焦点,落下后还回去');
  u.fireDoc('mousemove', { buttons: 0, target: target('xterm') });
  assert.equal(u.api.st().on, false);
  assert.equal(u.api.st().pbDrag, null);
  assert.equal(u.api.pathBarOwnDrop([FILE]), false, '拖拽结束后别人拖进来的同名文件照常填');
});

test('界面:拖完松手(没落回终端)后鼠标一动就收,之后外面拖进来的文件照常填', async (t) => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] }); t.after(() => mock.timers.reset());
  const u = loadUi({ disk: { [FILE]: 'file' } });
  u.api.pathBarShow(ev(), FILE); await tick(260);
  u.drag.fire('dragstart', { preventDefault: () => {} });
  await tick(1500);                    // 拖到微信里松手
  u.fireDoc('mousemove', { buttons: 0, target: target('other') });
  assert.equal(u.api.st().on, false);
  assert.equal(u.calls.focus, 1, '拖完把焦点还给终端');
  assert.equal(u.api.pathBarOwnDrop([FILE]), false);
  assert.equal(u.api.pathBarOwnDrop(['C:\\x.txt', FILE]), false);
});

test('接线:preload 三个口;只有路径链接挂工具条;终端 drop 先问 pathBarOwnDrop;切 / 关标签收工具条', () => {
  assert.match(PRELOAD, /showInFolder: \(p\) => ipcRenderer\.invoke\('hub:showInFolder', p\)/);
  assert.match(PRELOAD, /prepDrag: \(p\) => ipcRenderer\.invoke\('hub:prepDrag', p\)/);
  assert.match(PRELOAD, /dragFile: \(p\) => ipcRenderer\.send\('hub:dragFile', p\)/);
  const link = cut(HTML, '// <pure-termlink-logic>', '// </pure-termlink-logic>');
  assert.match(link, /hover: h\.kind === 'path' \? \(ev, s\) => pathBarShow\(ev, s\) : undefined/);
  assert.match(link, /leave: h\.kind === 'path' \? \(\) => pathBarHide\(\) : undefined/);
  assert.match(HTML, /if \(pathBarOwnDrop\(paths\)\) return;/);
  assert.match(HTML, /function activateTerm\(id\) \{\r?\n  pathBarHide\(true\);/);
  assert.match(HTML, /function closeTerm\(id, ev\) \{\r?\n  if \(ev\) ev\.stopPropagation\(\);\r?\n  pathBarHide\(true\);/);
});

test('界面:拖进微信后切回总控(期间没有 mousemove),窗口拿回焦点就清掉拖拽状态,不误吞外面拖进来的同一个文件', async (t) => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] }); t.after(() => mock.timers.reset());
  const u = loadUi({ disk: { [FILE]: 'file' } });
  u.api.pathBarShow(ev(), FILE); await tick(260);
  u.drag.fire('dragstart', { preventDefault: () => {} });
  await tick(5000);
  u.fireWin('focus', {});
  assert.equal(u.api.st().pbDrag, null);
  assert.equal(u.api.st().on, false);
  assert.equal(u.api.pathBarOwnDrop([FILE]), false, '资源管理器拖进来的同一个文件照常填');
});

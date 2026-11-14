// 设置里不再有写死的模型下拉和思考努力下拉;软件不再往 ~/.claude/settings.json 写 model / effortLevel。
//
// 2026-11-14 用户反馈「咋没有 Claude Fable 5.2」。下拉是写死的,每出一个新模型就过时一次。
// 三月定:模型下拉不要了,提示用户在会话里用 /model(官方列表);软件完全不管模型。
// 思考努力同理一起删:顶层 effortLevel 对 Opus 5.5 之后的模型已经不生效,那个下拉是摆设。
// 顺带消掉的老毛病:以前只要点保存 / 点通知渠道的「测试」,就会把 model 和 effortLevel 写进用户的
// settings.json,没设过的人被写成 opus + high。
//
// 和 viewing-notify.test.js 一样,直接从真源码里截出来跑。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const HTML = read('index.html'), MAIN = read('main.js'), PRELOAD = read('preload.js');
const between = (src, a, b) => { const i = src.indexOf(a), j = src.indexOf(b); assert.ok(i >= 0 && j > i, '找不到标记 ' + a); return src.slice(i, j); };
const noComments = (s) => s.replace(/\/\/.*$/gm, '');

// ---------- 主进程:只读 ----------
function loadMain(fileText) {
  const handlers = {};
  const writes = [];
  const fakeFs = {
    readFileSync: () => { if (fileText === null) throw new Error('ENOENT'); return fileText; },
    writeFileSync: (p, txt) => { writes.push(txt); },
  };
  const ipcMain = { handle: (name, fn) => { handlers[name] = fn; } };
  new Function('fs', 'ipcMain', 'SETTINGS', between(MAIN, '// <global-cfg>', '// </global-cfg>'))(fakeFs, ipcMain, 'X:\\settings.json');
  return { handlers, get: () => handlers['hub:getGlobalCfg'](), writes };
}

test('主进程:写设置的接口整个没了,这一块只剩一个只读接口,读的时候一个字都不写', () => {
  const m = loadMain(JSON.stringify({ model: 'claude-fable-5-2', effortLevel: 'xhigh' }));
  assert.deepEqual(Object.keys(m.handlers), ['hub:getGlobalCfg']);
  assert.deepEqual(m.get(), { model: 'claude-fable-5-2' });
  assert.equal(m.writes.length, 0);
});

test('主进程 / 预加载 / 界面:哪儿都不许再出现 saveGlobalCfg', () => {
  for (const [name, src] of [['main.js', MAIN], ['preload.js', PRELOAD], ['index.html', HTML]]) {
    assert.equal(noComments(src).includes('saveGlobalCfg'), false, name + ' 里还有 saveGlobalCfg');
  }
  assert.ok(PRELOAD.includes("getGlobalCfg: () => ipcRenderer.invoke('hub:getGlobalCfg')"));
});

test('主进程:没有任何地方把 model / effortLevel 赋进要写回 settings.json 的对象', () => {
  const code = noComments(MAIN);
  assert.equal(/\.model\s*=[^=]/.test(code), false);
  assert.equal(/\.effortLevel\s*=[^=]/.test(code), false);
});

test('主进程:读不了(没有 / 坏了)带 err;带 BOM 读得出;model 不是字符串当成没有', () => {
  assert.deepEqual(loadMain(null).get(), { model: '', err: true }, '读不到要带 err,界面才不会说成「没指定」');
  assert.equal(loadMain('{ 坏的 json').get().err, true);
  assert.deepEqual(loadMain('\uFEFF' + JSON.stringify({ model: 'opus' })).get(), { model: 'opus' });
  assert.deepEqual(loadMain(JSON.stringify({ model: { a: 1 } })).get(), { model: '' });
  assert.deepEqual(loadMain(JSON.stringify({})).get(), { model: '' });
});

// ---------- 界面:两个下拉都没了 ----------
test('界面:模型下拉、自定义输入框、思考努力下拉都没了,换成 /model /effort 的说明和按钮', () => {
  for (const id of ['g_model', 'g_model_custom', 'g_effort']) {
    assert.equal(HTML.includes('id="' + id + '"'), false, id + ' 元素不许再有');
    assert.equal(HTML.includes("'" + id + "'"), false, '也不许再有人去取 ' + id + '(一取就抛,整个保存跟着坏)');
  }
  assert.equal(/<option value="(claude-|opus|sonnet|haiku|fable|medium|high|xhigh)/.test(HTML), false, '设置里不许再出现写死的模型 / 思考档位选项');
  assert.ok(HTML.includes(`onclick="typeSlashCmd('/model')"`));
  assert.ok(HTML.includes(`onclick="typeSlashCmd('/effort')"`));
  assert.ok(HTML.includes('id="g_model_now"'));
});

test('界面:删掉的元素和函数,不管用哪种引号都不许再被提到(一提就是运行时抛错)', () => {
  const code = noComments(HTML);
  for (const w of ['g_effort', 'g_model_custom', 'gEffort0', 'effortToSave', 'saveEffort', 'typeModelCmd']) {
    assert.equal(code.includes(w), false, 'index.html 里还有 ' + w);
  }
  assert.equal(/g_model(?!_now)/.test(code), false, 'index.html 里还有 g_model');
});

test('主进程:全文件没有任何地方写 settings.json(钩子安装走的是别的模块)', () => {
  assert.equal(noComments(MAIN).includes('writeFileSync(SETTINGS'), false);
});

test('界面:保存函数里不碰模型和思考努力', () => {
  const i = HTML.indexOf('async function saveCfgSilent()');
  const body = noComments(HTML.slice(i, HTML.indexOf('await hub.saveNotifyCfg', i)));
  assert.ok(i > 0 && body.length > 50);
  assert.equal(/model|effort|GlobalCfg/i.test(body), false);
});

// ---------- 界面上的两个小函数(真跑) ----------
function loadCmd(env) {
  const calls = { input: [], toast: [], closed: 0, activated: [] };
  const hub = { termInput: (id, s) => calls.input.push([id, s]) };
  const fn = new Function('hub', 'hubToast', 'closeSettings', 'activateTerm', '__e',
    'const termTabs = __e.termTabs; let activeTerm = __e.activeTerm;\n' +
    between(HTML, '// <model-cmd>', '// </model-cmd>') +
    '\nreturn { modelNowText, typeSlashCmd };');
  const api = fn(hub, (s) => calls.toast.push(s), () => { calls.closed++; }, (id) => calls.activated.push(id), env);
  return { ...api, calls };
}
const NOTAB = { termTabs: [], activeTerm: null };
const TWO = { termTabs: [{ id: 't1', title: '甲' }, { id: 't2', title: '乙' }], activeTerm: 't2' };

test('「默认模型」那行字:有就照实显示,没有就说没指定,读不到就说读不到', () => {
  const { modelNowText } = loadCmd(NOTAB);
  assert.ok(modelNowText('claude-fable-5-2').includes('claude-fable-5-2'));
  assert.ok(modelNowText('').includes('没指定'));
  assert.ok(modelNowText(undefined).includes('没指定'));
  assert.ok(modelNowText({ a: 1 }).includes('没指定'), '不是字符串不许显示成 [object Object]');
  assert.ok(modelNowText('', true).includes('读不到'));
  assert.equal(modelNowText('opus', true).includes('opus'), false);
});

test('按钮:有当前会话 → 只把命令本身填进去,不回车、不清他打了一半的字', () => {
  for (const cmd of ['/model', '/effort']) {
    const m = loadCmd(TWO);
    m.typeSlashCmd(cmd);
    assert.deepEqual(m.calls.input, [['t2', cmd]]);
    assert.equal(m.calls.closed, 1, '要把设置关掉,不然看不见终端');
    assert.deepEqual(m.calls.activated, ['t2']);
    assert.equal(m.calls.toast.length, 1);
    assert.ok(m.calls.toast[0].includes('乙'), '分屏时要说清填进了哪个会话');
    assert.ok(m.calls.toast[0].includes(cmd));
  }
});

test('按钮:没有当前会话 → 只提示,什么都不往终端里送,设置也不关', () => {
  for (const env of [NOTAB, { termTabs: [{ id: 't1' }], activeTerm: 'gone' }]) {
    const m = loadCmd(env);
    m.typeSlashCmd('/effort');
    assert.deepEqual(m.calls.input, []);
    assert.equal(m.calls.closed, 0);
    assert.equal(m.calls.toast.length, 1);
    assert.ok(m.calls.toast[0].includes('/effort'));
  }
});

test('按钮:只认 /model 和 /effort,别的东西(带回车的、别的命令、空的)一律不送', () => {
  for (const bad of ['/model\r', '/clear', 'rm -rf x\r', '', undefined, '/MODEL', ' /model']) {
    const m = loadCmd(TWO);
    m.typeSlashCmd(bad);
    assert.deepEqual(m.calls.input, [], JSON.stringify(bad));
    assert.equal(m.calls.closed, 0);
    assert.deepEqual(m.calls.toast, []);
  }
});

// ---------- 打开设置 ----------
test('打开设置:把 settings.json 里现在的模型照实显示出来;读不到就照实说', () => {
  const now = { textContent: '' };
  const document = { getElementById: (id) => { assert.equal(id, 'g_model_now'); return now; } };
  const run = new Function('document', 'gc', 'modelNowText', between(HTML, '// <global-cfg-ui>', '// </global-cfg-ui>'));
  const fake = (m, err) => (err ? 'ERR' : 'NOW:' + (m || ''));
  run(document, { model: 'claude-fable-5-2' }, fake);
  assert.equal(now.textContent, 'NOW:claude-fable-5-2');
  run(document, { model: '', err: true }, fake);
  assert.equal(now.textContent, 'ERR');
  run(document, {}, fake);
  assert.equal(now.textContent, 'NOW:');
});

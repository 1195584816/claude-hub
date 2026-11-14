// 总控终端跟随 Windows 系统代理(lib/sysproxy.js)。
//
// 为 2026-11-13 那一幕建的:别人电脑上 TMS 连着、出口没问题,总控里的 Claude Code 照样
// 「Failed to connect to api.anthropic.com: Status 403」—— Claude Code 不看系统代理,只认 HTTPS_PROXY。
//
// 钉住的边界(哪条不满足都必须原样返回 —— 宁可不设,也不乱设):
//   · 用户自己设过代理变量(不分大小写)→ 一个字不动
//   · 系统代理没开 / 只有 SOCKS / 地址看不懂 → 不设
//   · 端口连不上 → 不设(开关开着却指向死端口的情况真发生过)
//   · 限时、永不抛:注册表卡住、探测卡住、什么都抛错,开终端都不受影响
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const sp = require('../lib/sysproxy');

const REG = (enable, server) => [
  '',
  'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
  '    CertificateRevocation    REG_DWORD    0x1',
  '    ProxyEnable    REG_DWORD    ' + enable,
  server == null ? '' : '    ProxyServer    REG_SZ    ' + server,
  '    ProxyOverride    REG_SZ    localhost;127.*;<local>',
  '    User Agent    REG_SZ    Mozilla/4.0 (compatible; MSIE 8.0; Win32)',
  ''
].join('\r\n');
const mk = (regText, probeResult = true, extra = {}) => {
  const calls = { query: 0, probe: [] };
  const s = sp.create(Object.assign({
    platform: 'win32',
    query: async () => { calls.query++; return regText; },
    probeFn: async (h, p) => { calls.probe.push(h + ':' + p); return probeResult; },
  }, extra));
  return { s, calls };
};

test('解析 ProxyServer:共用一个地址的写法', () => {
  assert.deepEqual(sp.parseProxyServer('127.0.0.1:10808'), { url: 'http://127.0.0.1:10808', host: '127.0.0.1', port: 10808 });
  assert.deepEqual(sp.parseProxyServer('  127.0.0.1:2080  '), { url: 'http://127.0.0.1:2080', host: '127.0.0.1', port: 2080 });
  assert.deepEqual(sp.parseProxyServer('http://proxy.corp.local:8080/'), { url: 'http://proxy.corp.local:8080', host: 'proxy.corp.local', port: 8080 });
  assert.deepEqual(sp.parseProxyServer('[::1]:7890'), { url: 'http://[::1]:7890', host: '::1', port: 7890 });
});

test('解析 ProxyServer:分协议的写法 —— 只认 https= 那一项;只写了 http= 或 socks= 的不用', () => {
  assert.equal(sp.parseProxyServer('http=1.2.3.4:80;https=5.6.7.8:443;socks=9.9.9.9:1080').url, 'http://5.6.7.8:443');
  assert.equal(sp.parseProxyServer('HTTPS=127.0.0.1:7890').url, 'http://127.0.0.1:7890');
  // 只声明了 http= :Windows 的意思是 HTTPS 直连,那个代理未必肯转发 HTTPS —— 不拿它凑数
  assert.equal(sp.parseProxyServer('http=1.2.3.4:80;socks=9.9.9.9:1080'), null);
  assert.equal(sp.parseProxyServer('http=1.2.3.4:80'), null);
  assert.equal(sp.parseProxyServer('https=;http=1.1.1.1:8'), null);
  assert.equal(sp.parseProxyServer('socks=127.0.0.1:1080'), null);
  assert.equal(sp.parseProxyServer('ftp=1.2.3.4:21'), null);
});

test('系统里的「不走代理」名单翻译成 NO_PROXY 条目', () => {
  // 三月这台电脑上的真实值(v2rayN 设系统代理时写的)
  const real = '<local>;localhost;127.*;10.*;172.16.*;172.17.*;172.18.*;172.19.*;172.20.*;172.21.*;172.22.*;172.23.*;172.24.*;172.25.*;172.26.*;172.27.*;172.28.*;172.29.*;172.30.*;172.31.*;192.168.*';
  assert.deepEqual(sp.parseOverride(real), ['localhost', '127.0.0.0/8', '10.0.0.0/8', '192.168.0.0/16', '172.16.0.0/12']);
  // 172 段不全就各写各的,不许擅自合成整个 /12
  assert.deepEqual(sp.parseOverride('172.16.*;172.20.*'), ['172.16.0.0/16', '172.20.0.0/16']);
  assert.deepEqual(sp.parseOverride('172.15.*;172.32.*'), ['172.15.0.0/16', '172.32.0.0/16'], '16–31 之外的 172 段不是私网,照普通网段写');
  // 凑够十六条但不是 16–31 这十六条(多了 172.15、少了 172.31):不许合成 /12 —— 那会把没列出来的 172.31 也放行
  const sixteen = [15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30].map(n => '172.' + n + '.*').join(';');
  const got = sp.parseOverride(sixteen);
  assert.ok(!got.includes('172.16.0.0/12'));
  assert.equal(got.length, 16);
  assert.ok(got.includes('172.15.0.0/16') && got.includes('172.30.0.0/16') && !got.includes('172.31.0.0/16'));
  assert.deepEqual(sp.parseOverride('192.168.1.*;*.corp.example.com;nas;gitlab.local;10.1.2.3'), ['192.168.1.0/24', '.corp.example.com', 'nas', 'gitlab.local', '10.1.2.3']);
  assert.deepEqual(sp.parseOverride('<local>;<-loopback>'), []);
  assert.deepEqual(sp.parseOverride('a.com, b.com  c.com;A.COM'), ['a.com', 'b.com', 'c.com'], '分隔符有分号、逗号、空格几种;重复的只留一个');
  // 认不出的、带怪字符的一律不要(这些会进环境变量)
  assert.deepEqual(sp.parseOverride('*;ex*ample.com;a.com:8080;$(calc);`x`;a b;"q";999.*;300.1.*;-bad;bad-;x&y;[::1]'), ['a', 'b']);
  assert.deepEqual(sp.parseOverride(''), []);
  assert.deepEqual(sp.parseOverride(null), []);
  assert.equal(sp.parseOverride(Array.from({ length: 200 }, (_, i) => 'h' + i + '.example.com').join(';')).length, 40, '条数有上限');
});

test('解析 ProxyServer:SOCKS、看不懂的、带怪字符的一律不要(这个值会进环境变量)', () => {
  for (const bad of ['', null, undefined, 'socks5://127.0.0.1:1080', 'socks://127.0.0.1:1080', '127.0.0.1', '127.0.0.1:', ':8080',
    '127.0.0.1:0', '127.0.0.1:70000', '127.0.0.1:80a', 'a b:80', '127.0.0.1:80;rm -rf', '127.0.0.1:80 & calc', 'user:pass@1.2.3.4:80',
    '$(calc):80', '`x`:80', '"127.0.0.1":80', 'x'.repeat(400) + ':80', 'http://127.0.0.1:80/path?x=1']) {
    assert.equal(sp.parseProxyServer(bad), null, String(bad));
  }
});

test('解析注册表输出:开关和地址', () => {
  const OV = 'localhost;127.*;<local>';
  assert.deepEqual(sp.parseRegOutput(REG('0x1', '127.0.0.1:10808')), { enable: true, server: '127.0.0.1:10808', override: OV });
  assert.deepEqual(sp.parseRegOutput(REG('0x0', '127.0.0.1:10808')), { enable: false, server: '127.0.0.1:10808', override: OV });
  assert.deepEqual(sp.parseRegOutput(REG('0x00000001', 'http=a:1;https=b:2')), { enable: true, server: 'http=a:1;https=b:2', override: OV });
  assert.deepEqual(sp.parseRegOutput(REG('0x1', null)), { enable: true, server: '', override: OV });
  assert.deepEqual(sp.parseRegOutput(''), { enable: false, server: '', override: '' });
  assert.deepEqual(sp.parseRegOutput(null), { enable: false, server: '', override: '' });
  // 名字只是「像」的不算(ProxyEnableX / MyProxyServer);名字里带空格、后半截恰好是我们要的也不算
  const none = { enable: false, server: '', override: '' };
  assert.deepEqual(sp.parseRegOutput('    ProxyEnableX    REG_DWORD    0x1\r\n    MyProxyServer    REG_SZ    1.1.1.1:1'), none);
  assert.deepEqual(sp.parseRegOutput('    Foo ProxyServer    REG_SZ    evil:1\r\n    Bar ProxyEnable    REG_DWORD    0x1'), none);
  assert.deepEqual(sp.parseRegOutput('ProxyServer    REG_SZ    1.1.1.1:1'), none, '值行都是缩进的;顶格的不是值');
});

test('系统代理开着、能连上、环境里没人设过 → 只给这份环境带上 HTTPS_PROXY / HTTP_PROXY / NO_PROXY', async () => {
  const { s, calls } = mk(REG('0x1', '127.0.0.1:2080'));
  const env = { Path: 'C:\\Windows', FOO: '1' };
  const r = await s.envFor(env);
  assert.equal(r.applied, 'http://127.0.0.1:2080');
  // NO_PROXY = 本机三样 + 系统「不走代理」名单翻译过来的(这份假注册表里是 localhost;127.*;<local>)
  assert.deepEqual(r.env, { Path: 'C:\\Windows', FOO: '1', HTTPS_PROXY: 'http://127.0.0.1:2080', HTTP_PROXY: 'http://127.0.0.1:2080', NO_PROXY: 'localhost,127.0.0.1,::1,127.0.0.0/8' });
  assert.deepEqual(env, { Path: 'C:\\Windows', FOO: '1' }, '不许改传进来的那个对象(那可能是 process.env)');
  assert.deepEqual(calls.probe, ['127.0.0.1:2080'], '要先探一下端口');
});

test('用户自己设过代理变量(任意一个、任意大小写)→ 一个字不动,连注册表都不去读', async () => {
  for (const k of ['HTTPS_PROXY', 'https_proxy', 'Https_Proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) {
    const { s, calls } = mk(REG('0x1', '127.0.0.1:2080'));
    const env = { [k]: 'http://my.proxy:1', X: '1' };
    const r = await s.envFor(env);
    assert.deepEqual(r, { env: { [k]: 'http://my.proxy:1', X: '1' }, applied: '' }, k);
    assert.equal(calls.query, 0, k);
  }
  // 设成空串不算设过
  const { s } = mk(REG('0x1', '127.0.0.1:2080'));
  assert.equal((await s.envFor({ HTTPS_PROXY: '  ' })).applied, 'http://127.0.0.1:2080');
});

test('用户设过 NO_PROXY(任意大小写)→ 保留他的,不覆盖也不另加一个', async () => {
  for (const k of ['NO_PROXY', 'no_proxy']) {
    const { s } = mk(REG('0x1', '127.0.0.1:2080'));
    const r = await s.envFor({ [k]: 'example.com' });
    assert.equal(r.env[k], 'example.com');
    assert.equal(Object.keys(r.env).filter(x => x.toLowerCase() === 'no_proxy').length, 1);
    assert.equal(r.env.HTTPS_PROXY, 'http://127.0.0.1:2080');
  }
});

test('不该设的情况:开关关着 / 没有地址 / 只有 SOCKS / 地址看不懂 → 原样返回', async () => {
  for (const reg of [REG('0x0', '127.0.0.1:2080'), REG('0x1', null), REG('0x1', 'socks=127.0.0.1:1080'), REG('0x1', 'socks5://127.0.0.1:1080'), REG('0x1', 'garbage'), '', 'ERROR: 系统找不到指定的注册表项或值。']) {
    const { s, calls } = mk(reg);
    const r = await s.envFor({ X: '1' });
    assert.deepEqual(r, { env: { X: '1' }, applied: '' }, reg.slice(0, 60));
    assert.equal(calls.probe.length, 0, '用不了的地址不该去探:' + reg.slice(0, 40));
  }
});

test('系统代理开着但端口连不上(开关开着却指向死端口)→ 不设', async () => {
  const { s, calls } = mk(REG('0x1', '127.0.0.1:2080'), false);
  const r = await s.envFor({ X: '1' });
  assert.deepEqual(r, { env: { X: '1' }, applied: '' });
  assert.deepEqual(calls.probe, ['127.0.0.1:2080']);
});

test('读注册表抛错 / 探测抛错 → 不设,不往外抛', async () => {
  const a = sp.create({ platform: 'win32', query: async () => { throw new Error('reg.exe not found'); }, probeFn: async () => true });
  assert.deepEqual(await a.envFor({ X: '1' }), { env: { X: '1' }, applied: '' });
  const b = sp.create({ platform: 'win32', query: async () => REG('0x1', '127.0.0.1:2080'), probeFn: async () => { throw new Error('boom'); } });
  assert.deepEqual(await b.envFor({ X: '1' }), { env: { X: '1' }, applied: '' });
  const c = sp.create({ platform: 'win32', query: () => { throw new Error('sync boom'); }, probeFn: async () => true });
  assert.deepEqual(await c.envFor({ X: '1' }), { env: { X: '1' }, applied: '' });
  assert.deepEqual(await a.envFor(null), { env: {}, applied: '' });
  assert.deepEqual(await a.envFor(undefined), { env: {}, applied: '' });
});

test('读注册表或探测卡住 → 限时内原样返回,开终端不陪着等', async () => {
  for (const hang of ['query', 'probe']) {
    const s = sp.create({ platform: 'win32', timeoutMs: 80,
      query: hang === 'query' ? () => new Promise(() => {}) : async () => REG('0x1', '127.0.0.1:2080'),
      probeFn: hang === 'probe' ? () => new Promise(() => {}) : async () => true });
    const t0 = Date.now();
    const r = await Promise.race([s.envFor({ X: '1' }), new Promise((res) => setTimeout(() => res('hung'), 1500))]);
    assert.notEqual(r, 'hung', hang + ' 卡住时没按时返回');
    assert.deepEqual(r, { env: { X: '1' }, applied: '' });
    assert.ok(Date.now() - t0 < 1000);
  }
  assert.equal(sp.TOTAL_TIMEOUT_MS, 2000, '默认最多等 2 秒');
});

test('非 Windows:什么都不做,连查都不查', async () => {
  for (const platform of ['darwin', 'linux']) {
    const { s, calls } = mk(REG('0x1', '127.0.0.1:2080'), true, { platform });
    assert.deepEqual(await s.envFor({ X: '1' }), { env: { X: '1' }, applied: '' });
    assert.equal(calls.query, 0);
  }
});

test('几秒内连着开很多终端:注册表只读一次;过了这几秒会重新读(代理关了,新终端就不带)', async () => {
  let t = 1000000, reg = REG('0x1', '127.0.0.1:2080');
  const calls = { query: 0 };
  const s = sp.create({ platform: 'win32', now: () => t, query: async () => { calls.query++; return reg; }, probeFn: async () => true });
  for (let i = 0; i < 12; i++) assert.equal((await s.envFor({})).applied, 'http://127.0.0.1:2080');
  assert.equal(calls.query, 1);
  reg = REG('0x0', '127.0.0.1:2080');          // 用户把代理关了
  t += 2000;
  assert.equal((await s.envFor({})).applied, 'http://127.0.0.1:2080', '缓存期内还是上次的');
  t += 2000;
  assert.equal((await s.envFor({})).applied, '', '过了缓存期要重新读');
  assert.equal(calls.query, 2);
  assert.equal((await s.envFor({})).applied, '', '重新读到「关了」之后,不许又把旧地址翻出来用');
  assert.equal((await s.envFor({})).applied, '');
  assert.equal(calls.query, 2);
});

test('同时开很多终端(还没查完又有人问):大家等同一次,注册表只读一次、端口只探一次', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const calls = { query: 0, probe: 0 };
  const s = sp.create({ platform: 'win32', query: async () => { calls.query++; await gate; return REG('0x1', '127.0.0.1:2080'); }, probeFn: async () => { calls.probe++; return true; } });
  const ps = Array.from({ length: 8 }, () => s.envFor({}));
  await new Promise((r) => setImmediate(r));
  release();
  const rs = await Promise.all(ps);
  assert.ok(rs.every(r => r.applied === 'http://127.0.0.1:2080'));
  assert.equal(calls.query, 1);
  assert.equal(calls.probe, 1);
});

test('系统「不走代理」名单会带进 NO_PROXY;探不通 / 没开时不带任何东西', async () => {
  const reg = REG('0x1', '127.0.0.1:2080').replace('localhost;127.*;<local>', '<local>;10.*;192.168.*;*.corp.example.com');
  const { s } = mk(reg);
  const r = await s.envFor({});
  assert.equal(r.env.NO_PROXY, 'localhost,127.0.0.1,::1,10.0.0.0/8,192.168.0.0/16,.corp.example.com');
  const { s: s2 } = mk(reg, false);
  assert.deepEqual((await s2.envFor({ X: '1' })).env, { X: '1' });
});

test('真的去连一下端口:开着的连得上,关着的连不上,不通的地址按时放弃', async () => {
  const srv = net.createServer((c) => c.destroy());
  await new Promise((res) => srv.listen(0, '127.0.0.1', res));
  const port = srv.address().port;
  assert.equal(await sp.probe('127.0.0.1', port), true);
  await new Promise((res) => srv.close(res));
  assert.equal(await sp.probe('127.0.0.1', port), false);
  const t0 = Date.now();
  assert.equal(await sp.probe('192.0.2.1', 9, 200), false);     // TEST-NET-1,必然不通
  assert.ok(Date.now() - t0 < 1500);
});

test('接线:开终端和查额度都先过一遍系统代理,再补 PATH;界面只提示一次', () => {
  const root = path.join(__dirname, '..');
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.ok(main.includes("const sysProxy = require('./lib/sysproxy').create();"));
  // 终端环境:净化 + 过系统代理
  const te = main.slice(main.indexOf('function termEnv()'), main.indexOf('async function spawnTerm('));
  assert.ok(te.includes('return sysProxy.envFor(env);'), '终端环境要过系统代理');
  assert.ok(/CLAUDE_\?CODE/.test(te), '终端环境要去掉 CLAUDE_CODE 标记');
  const st = main.slice(main.indexOf('async function spawnTerm('), main.indexOf('function spawnTermWith('));
  assert.ok(st.includes('return spawnTermWith(await termEnv(), projPath, title, sid, cmdOverride);'));
  // 真正起进程的那个函数必须是同步的:里面一个 await 都不许有(有了就会在查重和登记之间留出空档)
  const sw = main.slice(main.indexOf('function spawnTermWith('), main.indexOf("ipcMain.handle('term:open'"));
  assert.ok(!main.includes('async function spawnTermWith('), 'spawnTermWith 不许是 async');
  assert.ok(!/\bawait\b/.test(sw.replace(/\/\/[^\n]*/g, '')), 'spawnTermWith 里不许有 await');
  assert.ok(sw.includes('env: claudeCli.withClaudeOnPath(px.env)'), '传给终端的必须是带了代理的那份环境');
  assert.ok(sw.includes('return { ok: true, id, proxy: px.applied };'));
  assert.ok(sw.indexOf('terms.set(id, p);') > 0 && sw.indexOf('termMeta.set(id,') > 0, '起完进程要当场登记');
  // 手机端:先等环境,再「查重 → 开」,这两步之间不许有 await(连点两下同一个会话不能开出两个进程)
  const mo = main.slice(main.indexOf('async open(projPath, short, sid, title) {'), main.indexOf("ipcMain.handle('mobile:qr'"));
  const iEnv = mo.indexOf('const px = await termEnv();'), iLoop = mo.indexOf('for (const [id, m] of termMeta)'), iSpawn = mo.indexOf('const r = spawnTermWith(px,');
  assert.ok(iEnv > 0 && iLoop > iEnv && iSpawn > iLoop, '顺序必须是:等环境 → 查重 → 开');
  assert.ok(!/\bawait\b/.test(mo.slice(iLoop, iSpawn + 30)), '查重和开之间不许有 await');
  assert.ok(!/await spawnTerm\(/.test(mo), '手机端不许再走异步的 spawnTerm(那样查重和开之间就有空档)');
  // 别的几处跑 claude 的地方也跟着系统代理
  const q = main.slice(main.indexOf("ipcMain.handle('hub:quota'"), main.indexOf("ipcMain.handle('hub:timeline'"));
  assert.ok(q.includes('const px = await sysProxy.envFor(env);') && q.includes('env: claudeCli.withClaudeOnPath(px.env)'), '查额度也要跟着系统代理');
  const oc = main.slice(main.indexOf("ipcMain.handle('hub:openCli'"), main.indexOf("ipcMain.handle('hub:openDir'"));
  assert.ok(oc.includes('const px = await sysProxy.envFor(process.env);') && oc.includes('env: claudeCli.withClaudeOnPath(px.env)'), '外部终端兜底也要跟着系统代理');
  assert.ok(main.includes('envFn: async () => (await sysProxy.envFor(process.env)).env,'), '自动化接口也要跟着系统代理');
  assert.ok(html.includes("if (r.proxy && r.proxy !== lastProxyNote) { lastProxyNote = r.proxy; hubToast('终端已跟随系统代理 ' + r.proxy.replace(/^http:\\/\\//, '')); }"), '同一个代理地址只提示一次,而且真的要提示');
});

// ---------- 自动化接口:每个任务现算环境 ----------
test('自动化接口:给了 envFn 就用它现算的环境(仍然去掉 CLAUDE_CODE 标记);它出错就退回固定那份;不给则和以前一样同步起进程', async () => {
  const { EventEmitter } = require('node:events');
  const { PassThrough } = require('node:stream');
  const { createClaudeRunner } = require('../lib/agent-api');
  const mkSpawn = (seen) => (cmd, args, opts) => {
    seen.push(opts.env);
    const c = new EventEmitter(); c.stdout = new PassThrough(); c.stderr = new PassThrough(); c.stdin = new PassThrough(); c.kill = () => {};
    setImmediate(() => { c.stdout.end(JSON.stringify({ type: 'result', result: 'ok', session_id: 's', is_error: false })); c.emit('close', 0); });
    return c;
  };
  const req = { mode: 'new', prompt: 'hi', projectPath: process.cwd() };
  const fixed = { A: '1', CLAUDE_CODE_X: 'drop', CLAUDECODE: 'drop' };

  let seen = [];
  await createClaudeRunner({ spawnFn: mkSpawn(seen), env: fixed, envFn: async () => ({ B: '2', HTTPS_PROXY: 'http://127.0.0.1:2080', CLAUDE_CODE_Y: 'drop' }) })(req);
  assert.deepEqual(seen[0], { B: '2', HTTPS_PROXY: 'http://127.0.0.1:2080' });

  for (const bad of [async () => { throw new Error('x'); }, async () => null, async () => 'str', () => { throw new Error('sync'); }]) {
    seen = [];
    await createClaudeRunner({ spawnFn: mkSpawn(seen), env: fixed, envFn: bad })(req);
    assert.deepEqual(seen[0], { A: '1' }, 'envFn 不靠谱时要退回固定那份');
  }

  seen = [];
  const p = createClaudeRunner({ spawnFn: mkSpawn(seen), env: fixed })(req);
  assert.equal(seen.length, 1, '不给 envFn 时必须和以前一样:调用当下就起进程');
  await p;
  assert.deepEqual(seen[0], { A: '1' });
});

test('自动化接口:起进程那段代码里抛错 → 这次任务必须有个了结(失败),不许永远挂着把后面的任务堵死', async () => {
  const { EventEmitter } = require('node:events');
  const { createClaudeRunner } = require('../lib/agent-api');
  // 进程没起成功时 child.stdout 可能是 null:后面 child.stdout.on(...) 会抛 TypeError
  const brokenSpawn = () => { const c = new EventEmitter(); c.stdout = null; c.stderr = null; c.stdin = null; c.kill = () => {}; return c; };
  const req = { mode: 'new', prompt: 'hi', projectPath: process.cwd() };
  for (const opts of [{ spawnFn: brokenSpawn }, { spawnFn: brokenSpawn, envFn: async () => ({ A: '1' }) }]) {
    const settled = await Promise.race([
      createClaudeRunner(opts)(req).then(() => 'resolved', () => 'rejected'),
      new Promise((res) => setTimeout(() => res('hung'), 800)),
    ]);
    assert.notEqual(settled, 'hung', (opts.envFn ? '给了' : '没给') + ' envFn 时挂住了');
  }
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'agent-api.js'), 'utf8') + fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.ok(!/new Promise\(\s*async\b/.test(src), 'new Promise 的执行器不许写成 async(里面抛错会让它永远挂着)');
});

test('不走代理名单:大写转小写;恰好凑够十六条但含 172.32 的不合并;超长的单条不要', () => {
  assert.deepEqual(sp.parseOverride('NAS;*.Corp.Example.COM;GitLab.Local'), ['nas', '.corp.example.com', 'gitlab.local']);
  const with32 = [16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 32].map(n => '172.' + n + '.*').join(';');
  const got = sp.parseOverride(with32);
  assert.ok(!got.includes('172.16.0.0/12'), '少了 172.31、多了 172.32,不是那十六条');
  assert.ok(got.includes('172.32.0.0/16') && !got.includes('172.31.0.0/16'));
  assert.equal(got.length, 16);
  const long = 'a'.repeat(97) + '.com';          // 101 个字符
  assert.deepEqual(sp.parseOverride(long + ';ok.com'), ['ok.com']);
  assert.deepEqual(sp.parseOverride('a'.repeat(96) + '.com'), ['a'.repeat(96) + '.com'], '正好 100 个字符的留着');
});

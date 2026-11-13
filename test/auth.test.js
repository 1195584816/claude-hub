// 登录注册(lib/auth.js)。全程不打真网络:请求函数换成下面的假实现。
//
// 这里钉的几件事(设计见 docs/私_登录注册设计_v1.md 第 4 节):
//   · 退出必须带 scope=local —— 不带是全局登出,会把这个账号在博客 / TMS / 别的电脑上的登录一起踢掉
//   · 令牌文件走「临时文件 + 改名」,写失败不许把旧令牌弄坏
//   · 启动续期失败不许抛、不许卡住;令牌被废才算退出,只是断网要留着登录
//   · 记使用(hub_users)失败只记日志,不影响登录;绝不碰 TMS 的 app_users
//   · 日志里不许出现 anon key 和令牌
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const authLib = require('../lib/auth');

const UID = '11111111-2222-3333-4444-555555555555';
const EMAIL = 'someone@example.com';
const sess = (n) => ({ access_token: 'at' + n, refresh_token: 'rt' + n, expires_in: 3600, user: { id: UID, email: EMAIL } });

// 假的 https.request:handler(call) 返回 {status, json} / 抛错 / 'timeout' / Promise
function fakeNet(handler) {
  const calls = [];
  const request = (opts, cb) => {
    const req = new EventEmitter();
    let body = '';
    req.write = (d) => { body += d; };
    req.destroy = (e) => { if (e) setImmediate(() => req.emit('error', e)); };
    req.end = () => {
      const call = { method: opts.method, path: opts.path, host: opts.hostname, headers: opts.headers || {}, timeout: opts.timeout, body: body ? JSON.parse(body) : null };
      calls.push(call);
      Promise.resolve().then(() => handler(call, calls.length)).then((out) => {
        if (out === 'timeout') { req.emit('timeout'); return; }
        const res = new EventEmitter();
        res.statusCode = out.status; res.headers = {};
        cb(res);
        const text = out.json === undefined ? '' : JSON.stringify(out.json);
        // cut:响应头和半截正文发出来以后连接断了 —— 不会有 end
        if (out.cut) { setImmediate(() => { res.emit('data', text.slice(0, 5)); res.emit(out.cut); }); return; }
        setImmediate(() => { res.emit('data', Buffer.from(text)); res.emit('end'); res.emit('close'); });
      }, (e) => req.emit('error', e));
    };
    return req;
  };
  return { request, calls };
}

// 默认的假服务器:登录/续期/注册都成功,hub_users 可读可写
function okServer(over = {}) {
  let n = 0;
  return (c) => {
    for (const k of Object.keys(over)) if (c.path.includes(k)) return over[k](c);
    if (c.path.startsWith('/auth/v1/token')) return { status: 200, json: sess(++n) };
    if (c.path.startsWith('/auth/v1/signup')) return { status: 200, json: { id: UID, email: EMAIL, identities: [{ id: 'x' }], confirmation_sent_at: '2026-11-13T00:00:00Z' } };
    if (c.path.startsWith('/auth/v1/logout')) return { status: 204 };
    if (c.path.startsWith('/rest/v1/hub_users') && c.method === 'GET') return { status: 200, json: [] };
    if (c.path.startsWith('/rest/v1/hub_users') && c.method === 'POST') return { status: 201 };
    return { status: 404, json: { message: 'unexpected ' + c.path } };
  };
}

function setup(handler, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-auth-'));
  const file = path.join(dir, 'auth.json');
  const net = fakeNet(handler || okServer());
  const logs = [];
  const auth = authLib.create(Object.assign({
    file, request: net.request, log: (...a) => logs.push(a.map(String).join(' ')),
    meta: () => ({ appVersion: '9.9.9', platform: 'win32' })
  }, extra));
  return { dir, file, net, logs, auth, read: () => JSON.parse(fs.readFileSync(file, 'utf8')) };
}
const authCalls = (net) => net.calls.filter(c => c.path.startsWith('/auth/'));

// ---------- 登录 ----------
test('登录成功:打对端点、带 apikey、令牌落盘、密码不落盘', async () => {
  const t = setup();
  const r = await t.auth.signIn('  ' + EMAIL + ' ', 'pw-secret-1');
  assert.equal(r.ok, true);
  assert.equal(r.email, EMAIL);
  const c = t.net.calls[0];
  assert.equal(c.host, 'qzpvogxvlescfwpqahsn.supabase.co');
  assert.equal(c.method, 'POST');
  assert.equal(c.path, '/auth/v1/token?grant_type=password');
  assert.deepEqual(c.body, { email: EMAIL, password: 'pw-secret-1' });   // 邮箱去掉首尾空格
  assert.equal(c.headers.apikey, authLib.ANON_KEY);
  assert.equal(c.timeout, 15000, '请求要带 15 秒超时');
  const saved = t.read();
  assert.equal(saved.refreshToken, 'rt1');
  assert.equal(saved.email, EMAIL);
  assert.equal(saved.userId, UID);
  const raw = fs.readFileSync(t.file, 'utf8');
  assert.ok(!raw.includes('pw-secret-1'), '密码不许写进文件');
  assert.ok(!raw.includes('at1'), '访问令牌不落盘,只存续期令牌');
  await t.auth.idle();
  assert.ok(t.logs.every(l => !l.includes('pw-secret-1') && !l.includes(EMAIL)), '密码和邮箱不许进日志');
  assert.deepEqual(t.auth.status(), { loggedIn: true, email: EMAIL, offline: false });
});

test('密码不对:中文提示,不落盘,仍是未登录', async () => {
  const t = setup(okServer({ '/auth/v1/token': () => ({ status: 400, json: { error_code: 'invalid_credentials', msg: 'Invalid login credentials' } }) }));
  const r = await t.auth.signIn(EMAIL, 'wrong-pw');
  assert.equal(r.ok, false);
  assert.equal(r.error, '邮箱或密码不对');
  assert.equal(fs.existsSync(t.file), false);
  assert.equal(t.auth.status().loggedIn, false);
});

test('邮箱没验证:提示去邮箱点确认', async () => {
  const t = setup(okServer({ '/auth/v1/token': () => ({ status: 400, json: { error_code: 'email_not_confirmed', msg: 'Email not confirmed' } }) }));
  const r = await t.auth.signIn(EMAIL, 'pw-secret-1');
  assert.equal(r.ok, false);
  assert.match(r.error, /还没验证/);
});

test('邮箱或密码格式不对:不发请求', async () => {
  const t = setup();
  for (const [e, p] of [['', 'pw-secret-1'], ['no-at-sign', 'pw-secret-1'], [EMAIL, '12345'], [EMAIL, 'x'.repeat(73)], [null, undefined], [{}, []]]) {
    const a = await t.auth.signIn(e, p);
    const b = await t.auth.signUp(e, p);
    assert.equal(a.ok, false); assert.equal(b.ok, false);
    assert.ok(a.error && b.error);
  }
  assert.equal(t.net.calls.length, 0);
});

test('登录时网络不通:返回人话,不抛,不带出请求细节', async () => {
  const t = setup(() => { throw new Error('connect ECONNREFUSED headers=' + authLib.ANON_KEY); });
  const r = await t.auth.signIn(EMAIL, 'pw-secret-1');
  assert.equal(r.ok, false);
  assert.match(r.error, /网络/);
  assert.ok(!r.error.includes(authLib.ANON_KEY));
  assert.ok(t.logs.length >= 1);
  assert.ok(t.logs.every(l => !l.includes('pw-secret-1') && !l.includes(EMAIL)), '密码和邮箱不许进日志');
});

test('响应发到一半连接断了 / 对端一直不回:请求要结束,不许永远挂着', async () => {
  for (const cut of ['aborted', 'close', 'error']) {
    const t = setup(okServer({ '/auth/v1/token': () => ({ status: 200, json: sess(1), cut }) }));
    const r = await Promise.race([t.auth.signIn(EMAIL, 'pw-secret-1'), new Promise((res) => setTimeout(() => res('hung'), 1000))]);
    assert.notEqual(r, 'hung', cut + ' 之后请求没结束');
    assert.equal(r.ok, false);
    assert.match(r.error, /网络/);
    assert.equal(t.auth.status().loggedIn, false);
  }
  // 连事件都没有、纯粹不回:靠总时限收场
  const t = setup(okServer({ '/auth/v1/token': () => new Promise(() => {}) }), { timeoutMs: 60 });
  const t0 = Date.now();
  const r = await Promise.race([t.auth.signIn(EMAIL, 'pw-secret-1'), new Promise((res) => setTimeout(() => res('hung'), 2000))]);
  assert.notEqual(r, 'hung', '总时限没生效');
  assert.equal(r.ok, false);
  assert.ok(Date.now() - t0 < 1500);
});

test('服务器回的未知报错里带令牌:给界面的提示也要打码', async () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJlLXh4eA';
  const t = setup(okServer({ '/auth/v1/token': () => ({ status: 500, json: { msg: 'unexpected failure token=' + jwt } }) }));
  const r = await t.auth.signIn(EMAIL, 'pw-secret-1');
  assert.equal(r.ok, false);
  assert.match(r.error, /unexpected failure/);
  assert.ok(!r.error.includes(jwt));
});

test('密码上限按字节算:25 个汉字(75 字节)本地就拦下,24 个(72 字节)放行', async () => {
  const t = setup();
  const a = await t.auth.signIn(EMAIL, '密'.repeat(25));
  assert.equal(a.ok, false);
  assert.equal(t.net.calls.length, 0);
  const b = await t.auth.signIn(EMAIL, '密'.repeat(24));
  assert.equal(b.ok, true);
});

test('连着登录两次:后点的那次算数,先点的晚回来也不许盖掉', async () => {
  let releaseA;
  const gateA = new Promise((r) => { releaseA = r; });
  const mk = (tag, email) => ({ status: 200, json: { access_token: 'at-' + tag, refresh_token: 'rt-' + tag, expires_in: 3600, user: { id: UID, email } } });
  const t = setup(okServer({ '/auth/v1/token': (c) => c.body.email === 'a@example.com' ? gateA.then(() => mk('A', 'a@example.com')) : mk('B', 'b@example.com') }));
  const pa = t.auth.signIn('a@example.com', 'pw-secret-1');
  await new Promise((r) => setImmediate(r));
  const rb = await t.auth.signIn('b@example.com', 'pw-secret-1');
  assert.equal(rb.ok, true);
  releaseA();
  const ra = await pa;
  assert.equal(ra.ok, false);
  assert.equal(ra.stale, true);
  assert.equal(t.auth.status().email, 'b@example.com');
  assert.equal(t.read().refreshToken, 'rt-B');
});

test('先点的登录断网、期间又登录成功了别的:先点的那次得到「被取代」,不是「网络连不上」', async () => {
  let failA;
  const gateA = new Promise((_, rej) => { failA = rej; });
  const t = setup(okServer({ '/auth/v1/token': (c) => c.body.email === 'a@example.com' ? gateA : ({ status: 200, json: sess(2) }) }));
  const pa = t.auth.signIn('a@example.com', 'pw-secret-1');
  await new Promise((r) => setImmediate(r));
  assert.equal((await t.auth.signIn(EMAIL, 'pw-secret-1')).ok, true);
  failA(new Error('ECONNRESET'));
  const ra = await pa;
  assert.equal(ra.stale, true);
  assert.equal(t.auth.status().email, EMAIL);
});

test('服务器只给了访问令牌、没给续期令牌:不算登录成功(存不下来的登录没有意义)', async () => {
  const half = { status: 200, json: { access_token: 'at1', expires_in: 3600, user: { id: UID, email: EMAIL } } };
  const t = setup(okServer({ '/auth/v1/token': () => half, '/auth/v1/signup': () => half }));
  const a = await t.auth.signIn(EMAIL, 'pw-secret-1');
  assert.equal(a.ok, false);
  assert.equal(fs.existsSync(t.file), false);
  assert.equal(t.auth.status().loggedIn, false);
  await t.auth.signUp(EMAIL, 'pw-secret-1');
  assert.equal(fs.existsSync(t.file), false, '注册也一样:没有续期令牌就不算登录');
  assert.equal(t.auth.status().loggedIn, false);
  // 启动续期遇到同样的回答:不算续上,但令牌留着
  const old = JSON.stringify({ v: 1, refreshToken: 'rt-old', userId: UID, email: EMAIL });
  fs.writeFileSync(t.file, old);
  await t.auth.restore();
  assert.equal(fs.readFileSync(t.file, 'utf8'), old);
  assert.deepEqual(t.auth.status(), { loggedIn: true, email: EMAIL, offline: true });
});

test('请求体长度按字节算(密码里有中文时字符数 ≠ 字节数)', async () => {
  const t = setup();
  await t.auth.signIn(EMAIL, '密码密码密码');
  const c = t.net.calls[0];
  const bytes = Buffer.byteLength(JSON.stringify(c.body));
  assert.notEqual(bytes, JSON.stringify(c.body).length, '夹具没造出「字节数 ≠ 字符数」');
  assert.equal(c.headers['Content-Length'], bytes);
});

// ---------- 注册 ----------
test('注册还没回来时又去登录了:注册那次得到「被取代」;晚回来的注册会话不许盖掉登录', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const t = setup(okServer({
    '/auth/v1/signup': () => gate.then(() => ({ status: 200, json: { access_token: 'at-up', refresh_token: 'rt-up', expires_in: 3600, user: { id: UID, email: 'up@example.com' } } })),
  }));
  const pu = t.auth.signUp('up@example.com', 'pw-secret-1');
  await new Promise((r) => setImmediate(r));
  assert.equal((await t.auth.signIn(EMAIL, 'pw-secret-1')).ok, true);
  release();
  const ru = await pu;
  assert.equal(ru.ok, false);
  assert.equal(ru.stale, true);
  assert.equal(t.auth.status().email, EMAIL);
  assert.equal(t.read().refreshToken, 'rt1');

  // 反过来:登录在路上时点了注册,晚回来的登录不许生效
  let release2;
  const gate2 = new Promise((r) => { release2 = r; });
  const t2 = setup(okServer({ '/auth/v1/token': () => gate2.then(() => ({ status: 200, json: sess(1) })) }));
  const pi = t2.auth.signIn(EMAIL, 'pw-secret-1');
  await new Promise((r) => setImmediate(r));
  assert.equal((await t2.auth.signUp('up@example.com', 'pw-secret-1')).needConfirm, true);
  release2();
  assert.equal((await pi).stale, true);
  assert.equal(t2.auth.status().loggedIn, false);
  assert.equal(fs.existsSync(t2.file), false);
});

test('注册断网:人话提示;期间被别的操作取代则是「被取代」', async () => {
  const t = setup(okServer({ '/auth/v1/signup': () => { throw new Error('ECONNRESET'); } }));
  const r = await t.auth.signUp(EMAIL, 'pw-secret-1');
  assert.equal(r.ok, false);
  assert.equal(r.stale, undefined);
  assert.match(r.error, /网络/);
  let fail;
  const gate = new Promise((_, rej) => { fail = rej; });
  const t2 = setup(okServer({ '/auth/v1/signup': () => gate }));
  const pu = t2.auth.signUp('up@example.com', 'pw-secret-1');
  await new Promise((res) => setImmediate(res));
  await t2.auth.signIn(EMAIL, 'pw-secret-1');
  fail(new Error('ECONNRESET'));
  assert.equal((await pu).stale, true);
});

test('注册(要验证邮箱):打 /auth/v1/signup,提示去邮箱确认,不算已登录', async () => {
  const t = setup();
  const r = await t.auth.signUp(EMAIL, 'pw-secret-1');
  assert.deepEqual(r, { ok: true, needConfirm: true, email: EMAIL });
  const c = t.net.calls[0];
  assert.equal(c.method, 'POST');
  assert.equal(c.path, '/auth/v1/signup');
  assert.deepEqual(c.body, { email: EMAIL, password: 'pw-secret-1' });
  assert.equal(fs.existsSync(t.file), false);
  assert.equal(t.auth.status().loggedIn, false);
});

test('注册(服务器直接给了会话):当场登录并落盘', async () => {
  const t = setup(okServer({ '/auth/v1/signup': () => ({ status: 200, json: sess(7) }) }));
  const r = await t.auth.signUp(EMAIL, 'pw-secret-1');
  assert.equal(r.ok, true);
  assert.equal(r.needConfirm, undefined);
  assert.equal(t.read().refreshToken, 'rt7');
  assert.equal(t.auth.status().loggedIn, true);
});

test('注册:已注册过 / 密码太短 / 太频繁 都给中文提示', async () => {
  const cases = [
    [{ status: 200, json: { id: UID, email: EMAIL, identities: [] } }, /已经注册过/],          // 开着邮箱验证时,老邮箱返回一个没有 identities 的假用户
    [{ status: 422, json: { error_code: 'user_already_exists', msg: 'User already registered' } }, /已经注册过/],
    [{ status: 422, json: { error_code: 'weak_password', msg: 'Password should be at least 6 characters.' } }, /密码/],
    [{ status: 429, json: { error_code: 'over_email_send_rate_limit', msg: 'email rate limit exceeded' } }, /频繁/],
  ];
  for (const [resp, re] of cases) {
    const t = setup(okServer({ '/auth/v1/signup': () => resp }));
    const r = await t.auth.signUp(EMAIL, 'pw-secret-1');
    assert.equal(r.ok, false);
    assert.match(r.error, re);
    assert.equal(fs.existsSync(t.file), false);
  }
});

// ---------- 退出 ----------
test('退出:必须是 scope=local,带当前令牌,本地文件删掉', async () => {
  const t = setup();
  await t.auth.signIn(EMAIL, 'pw-secret-1');
  await t.auth.idle();
  const r = await t.auth.signOut();
  assert.equal(r.ok, true);
  await t.auth.idle();
  const outs = t.net.calls.filter(c => c.path.startsWith('/auth/v1/logout'));
  assert.equal(outs.length, 1);
  assert.equal(outs[0].path, '/auth/v1/logout?scope=local');   // 整条路径相等:多一个少一个参数都不行
  assert.equal(outs[0].method, 'POST');
  assert.equal(outs[0].headers.Authorization, 'Bearer at1');
  assert.equal(fs.existsSync(t.file), false);
  assert.deepEqual(t.auth.status(), { loggedIn: false, email: '', offline: false });
});

test('退出时网络不通:本地照样退出,不抛', async () => {
  const t = setup(okServer({ '/auth/v1/logout': () => { throw new Error('ECONNRESET'); } }));
  await t.auth.signIn(EMAIL, 'pw-secret-1');
  const r = await t.auth.signOut();
  assert.equal(r.ok, true);
  assert.equal(fs.existsSync(t.file), false);
  assert.equal(t.auth.status().loggedIn, false);
  await t.auth.idle();                                         // 后台那次通知失败也不许变成未处理的异常
});

test('退出不等服务器:通知卡住时也马上返回,而且通知发出去之前本地已经清干净', async () => {
  let seenAtCall = null;
  let t;
  t = setup(okServer({ '/auth/v1/logout': () => { seenAtCall = { file: fs.existsSync(t.file), loggedIn: t.auth.status().loggedIn }; return new Promise(() => {}); } }));
  await t.auth.signIn(EMAIL, 'pw-secret-1');
  const r = await Promise.race([t.auth.signOut(), new Promise((res) => setTimeout(() => res('stuck'), 500))]);
  assert.notEqual(r, 'stuck');
  assert.equal(r.ok, true);
  await new Promise((res) => setTimeout(res, 20));
  assert.deepEqual(seenAtCall, { file: false, loggedIn: false });
});

test('启动续期还没回来时点了退出:晚回来的续期成功不许把人重新登回去', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const t = setup(okServer({ 'grant_type=refresh_token': () => gate.then(() => ({ status: 200, json: sess(9) })) }));
  fs.writeFileSync(t.file, JSON.stringify({ v: 1, refreshToken: 'rt-old', userId: UID, email: EMAIL }));
  const p = t.auth.restore();
  await new Promise((r) => setImmediate(r));
  assert.equal(t.auth.status().loggedIn, true, '续期在路上时就该显示这个账号');
  await t.auth.signOut();
  release();
  await p;
  assert.equal(t.auth.status().loggedIn, false);
  assert.equal(fs.existsSync(t.file), false);
});

test('没登录时点退出:不发任何请求', async () => {
  const t = setup();
  const r = await t.auth.signOut();
  await t.auth.idle();
  assert.equal(r.ok, true);
  assert.equal(t.net.calls.length, 0);
});

test('退出时服务器不受理(比如访问令牌已过期):留一条日志,本地照样退出', async () => {
  const t = setup(okServer({ '/auth/v1/logout': () => ({ status: 401, json: { msg: 'invalid JWT' } }) }));
  await t.auth.signIn(EMAIL, 'pw-secret-1');
  await t.auth.idle();
  const n = t.logs.length;
  await t.auth.signOut();
  await t.auth.idle();
  assert.equal(t.logs.length, n + 1);
  assert.match(t.logs[n], /401/);
  assert.equal(fs.existsSync(t.file), false);
});

test('退出时令牌文件删不掉(被别的程序占着):把里面的令牌抹掉;连抹都抹不掉就如实告诉调用方', async () => {
  const t = setup();
  await t.auth.signIn(EMAIL, 'pw-secret-1');
  await t.auth.idle();
  const realUnlink = fs.unlinkSync, realWrite = fs.writeFileSync;
  let unlinks = 0;
  fs.unlinkSync = (p) => { if (p === t.file) { unlinks++; const e = new Error('EPERM: operation not permitted, unlink'); e.code = 'EPERM'; throw e; } return realUnlink(p); };
  let r;
  try { r = await t.auth.signOut(); } finally { fs.unlinkSync = realUnlink; }
  assert.equal(unlinks, 1, '夹具没走到删文件那一步');
  assert.deepEqual(r, { ok: true });
  assert.ok(!fs.readFileSync(t.file, 'utf8').includes('rt1'), '删不掉也得把令牌抹掉');
  // 下次启动:抹过的文件不算登录,也不发请求
  const before = t.net.calls.length;
  await t.auth.restore();
  assert.equal(t.auth.status().loggedIn, false);
  assert.equal(authCalls(t.net).filter(c => c.path.includes('refresh_token')).length, 0);
  assert.ok(t.net.calls.length >= before);

  // 删不掉、也写不进去
  const t2 = setup();
  await t2.auth.signIn(EMAIL, 'pw-secret-1');
  await t2.auth.idle();
  const n = t2.logs.length;
  fs.unlinkSync = (p) => { if (p === t2.file) { const e = new Error('EPERM unlink'); e.code = 'EPERM'; throw e; } return realUnlink(p); };
  fs.writeFileSync = (p, ...a) => { if (p === t2.file) throw new Error('EBUSY write'); return realWrite(p, ...a); };
  let r2;
  try { r2 = await t2.auth.signOut(); } finally { fs.unlinkSync = realUnlink; fs.writeFileSync = realWrite; }
  assert.deepEqual(r2, { ok: true, persisted: false });
  assert.equal(t2.auth.status().loggedIn, false, '这次运行里照样算退出');
  assert.ok(t2.logs.slice(n).some(l => l.includes('EBUSY')), '没清掉要记日志');
});

test('文件本来就不存在时退出:算清干净了,不去硬写一个空文件', async () => {
  const t = setup();
  await t.auth.signIn(EMAIL, 'pw-secret-1');
  await t.auth.idle();
  fs.unlinkSync(t.file);
  const r = await t.auth.signOut();
  assert.deepEqual(r, { ok: true });
  assert.equal(fs.existsSync(t.file), false);
});

// ---------- 令牌文件 ----------
test('令牌文件:先写同目录临时文件再改名', async () => {
  const t = setup();
  const real = fs.renameSync;
  const renames = [];
  fs.renameSync = (a, b) => { renames.push([a, b]); return real(a, b); };
  try { await t.auth.signIn(EMAIL, 'pw-secret-1'); } finally { fs.renameSync = real; }
  const mine = renames.filter(([, b]) => b === t.file);
  assert.equal(mine.length, 1, '令牌文件必须经过一次改名落盘');
  assert.equal(path.dirname(mine[0][0]), t.dir);
  assert.match(path.basename(mine[0][0]), /\.tmp$/);
});

test('令牌文件写失败:旧令牌一个字节不变,不留临时文件,本次登录照样算数', async () => {
  const t = setup();
  const old = JSON.stringify({ v: 1, refreshToken: 'rt-old', userId: UID, email: 'old@example.com' });
  fs.writeFileSync(t.file, old);
  const real = fs.renameSync;
  let thrown = 0;
  fs.renameSync = (a, b) => { if (b === t.file) { thrown++; throw new Error('EPERM rename'); } return real(a, b); };
  let r;
  try { r = await t.auth.signIn(EMAIL, 'pw-secret-1'); } finally { fs.renameSync = real; }
  assert.equal(thrown, 1, '夹具没走到改名那一步');
  assert.equal(fs.readFileSync(t.file, 'utf8'), old);
  assert.deepEqual(fs.readdirSync(t.dir), ['auth.json']);
  assert.equal(r.ok, true);
  assert.equal(r.persisted, false);
  assert.equal(t.auth.status().loggedIn, true);
  assert.ok(t.logs.some(l => l.includes('EPERM')), '写失败要记日志');
});

// ---------- 启动时续期 ----------
test('启动:没有令牌文件 → 未登录,一个请求都不发', async () => {
  const t = setup();
  await t.auth.restore();
  assert.equal(t.auth.status().loggedIn, false);
  assert.equal(t.net.calls.length, 0);
});

test('启动:令牌文件是坏的 → 未登录,不抛,不发请求', async () => {
  for (const junk of ['', '{bad json', '[]', '{"refreshToken":123}', 'null']) {
    const t = setup();
    fs.writeFileSync(t.file, junk);
    await t.auth.restore();
    assert.equal(t.auth.status().loggedIn, false);
    assert.equal(t.net.calls.length, 0);
  }
});

test('启动:续期成功 → 换下来的新令牌落盘,显示已登录', async () => {
  const t = setup();
  fs.writeFileSync(t.file, JSON.stringify({ v: 1, refreshToken: 'rt-old', userId: UID, email: EMAIL }));
  await t.auth.restore();
  const c = t.net.calls[0];
  assert.equal(c.path, '/auth/v1/token?grant_type=refresh_token');
  assert.deepEqual(c.body, { refresh_token: 'rt-old' });
  assert.equal(t.read().refreshToken, 'rt1');     // 旧令牌用过一次就作废,不存新的下次就登不上了
  assert.deepEqual(t.auth.status(), { loggedIn: true, email: EMAIL, offline: false });
});

test('启动:服务器明确说令牌作废 → 删文件,回到未登录', async () => {
  const bodies = [
    { error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token: Refresh Token Not Found' },
    { error_code: 'refresh_token_already_used', msg: 'Invalid Refresh Token: Already Used' },
    // 下面几条只给错误码、文字故意写成认不出的:每个错误码都得单独认得
    { error_code: 'refresh_token_not_found', msg: 'x' },
    { error_code: 'refresh_token_already_used', msg: 'x' },
    { error_code: 'session_expired', msg: 'x' },
    { error_code: 'user_banned', msg: 'x' },
    { error_code: 'user_not_found', msg: 'x' },
    { error_code: 'session_not_found', msg: 'x' },
    { error_code: 'session_not_found', msg: 'Session not found' },
    { error: 'invalid_grant', error_description: 'Invalid Refresh Token: Refresh Token Not Found' },   // 老版本服务端没有 error_code
  ];
  for (const json of bodies) {
    const t = setup(okServer({ '/auth/v1/token': () => ({ status: 400, json }) }));
    fs.writeFileSync(t.file, JSON.stringify({ v: 1, refreshToken: 'rt-old', userId: UID, email: EMAIL }));
    await t.auth.restore();
    assert.equal(fs.existsSync(t.file), false, JSON.stringify(json));
    assert.equal(t.auth.status().loggedIn, false);
  }
});

test('启动:不是「令牌作废」的报错(网关 401 / 403 / 限流 / 别的 400)→ 令牌留着', async () => {
  const resps = [
    { status: 401, json: { message: 'Invalid API key', hint: 'Double check your Supabase `anon` or `service_role` API key.' } },
    { status: 401, json: { error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token' } },   // 状态码不是 400 就不认
    { status: 403, json: { msg: 'Forbidden' } },
    { status: 429, json: { error_code: 'over_request_rate_limit', msg: 'Request rate limit reached' } },
    { status: 400, json: { error_code: 'validation_failed', msg: 'Could not read body' } },
    { status: 200, json: { weird: true } },
  ];
  for (const resp of resps) {
    const t = setup(okServer({ '/auth/v1/token': () => resp }));
    const old = JSON.stringify({ v: 1, refreshToken: 'rt-old', userId: UID, email: EMAIL });
    fs.writeFileSync(t.file, old);
    await t.auth.restore();
    assert.equal(fs.readFileSync(t.file, 'utf8'), old, JSON.stringify(resp));
    assert.deepEqual(t.auth.status(), { loggedIn: true, email: EMAIL, offline: true });
  }
});

test('启动:续期的回答里没带用户信息 → 用本地存的邮箱和用户号补上', async () => {
  const t = setup(okServer({ '/auth/v1/token': () => ({ status: 200, json: { access_token: 'at5', refresh_token: 'rt5', expires_in: 3600 } }) }));
  fs.writeFileSync(t.file, JSON.stringify({ v: 1, refreshToken: 'rt-old', userId: UID, email: EMAIL }));
  await t.auth.restore();
  await t.auth.idle();
  assert.deepEqual(t.auth.status(), { loggedIn: true, email: EMAIL, offline: false });
  const saved = t.read();
  assert.equal(saved.email, EMAIL);
  assert.equal(saved.userId, UID);
  assert.ok(t.net.calls.some(c => c.path.startsWith('/rest/v1/hub_users?user_id=eq.' + UID)), '记使用要用补上的用户号');
});

test('启动:断网 / 超时 / 服务器 500 → 不抛,令牌文件原样留着,仍显示这个账号(离线)', async () => {
  const modes = [() => { throw new Error('getaddrinfo ENOTFOUND'); }, () => 'timeout', () => ({ status: 500, json: { msg: 'boom' } })];
  for (const mode of modes) {
    const t = setup(okServer({ '/auth/v1/token': mode }));
    const old = JSON.stringify({ v: 1, refreshToken: 'rt-old', userId: UID, email: EMAIL });
    fs.writeFileSync(t.file, old);
    await t.auth.restore();                                   // 抛了这里就红
    assert.equal(fs.readFileSync(t.file, 'utf8'), old);
    assert.deepEqual(t.auth.status(), { loggedIn: true, email: EMAIL, offline: true });
  }
});

test('启动续期还没回来时用户登录了别的账号:迟到的续期结果不许盖掉新登录', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const t = setup(okServer({
    'grant_type=refresh_token': () => gate.then(() => ({ status: 400, json: { msg: 'Invalid Refresh Token' } })),
    'grant_type=password': () => ({ status: 200, json: { access_token: 'at-new', refresh_token: 'rt-new', expires_in: 3600, user: { id: UID, email: 'new@example.com' } } }),
  }));
  fs.writeFileSync(t.file, JSON.stringify({ v: 1, refreshToken: 'rt-old', userId: UID, email: EMAIL }));
  const p = t.auth.restore();
  await new Promise((r) => setImmediate(r));
  const r = await t.auth.signIn('new@example.com', 'pw-secret-1');
  assert.equal(r.ok, true);
  release();
  await p;
  assert.equal(t.auth.status().email, 'new@example.com');
  assert.equal(t.read().refreshToken, 'rt-new');
});

// ---------- 记使用(hub_users) ----------
test('登录后记一次使用:写 hub_users,次数 +1,不覆盖首次时间,带版本和平台', async () => {
  const t = setup(okServer({
    '/rest/v1/hub_users?': (c) => c.method === 'GET' ? { status: 200, json: [{ login_count: 4, first_seen: '2026-01-01T00:00:00Z' }] } : { status: 201 },
  }));
  await t.auth.signIn(EMAIL, 'pw-secret-1');
  await t.auth.idle();
  const rest = t.net.calls.filter(c => c.path.startsWith('/rest/'));
  assert.equal(rest.length, 2);
  assert.equal(rest[0].method, 'GET');
  assert.ok(rest[0].path.startsWith('/rest/v1/hub_users?user_id=eq.' + UID));
  assert.equal(rest[0].headers.Authorization, 'Bearer at1');
  assert.equal(rest[1].method, 'POST');
  assert.equal(rest[1].path, '/rest/v1/hub_users');
  assert.match(rest[1].headers.Prefer, /resolution=merge-duplicates/);
  assert.equal(rest[1].body.user_id, UID);
  assert.equal(rest[1].body.login_count, 5);
  assert.equal(rest[1].body.first_seen, '2026-01-01T00:00:00Z');
  assert.equal(rest[1].body.app_version, '9.9.9');
  assert.equal(rest[1].body.platform, 'win32');
  assert.equal(rest[1].body.email, EMAIL);
});

test('第一次记使用:次数是 1,带最近使用时间,不带首次时间(让数据库自己填)', async () => {
  const t = setup();
  const t0 = Date.now();
  await t.auth.signIn(EMAIL, 'pw-secret-1');
  await t.auth.idle();
  const post = t.net.calls.find(c => c.path === '/rest/v1/hub_users' && c.method === 'POST');
  assert.equal(post.body.login_count, 1);
  assert.ok(!('first_seen' in post.body));
  const seen = Date.parse(post.body.last_seen);
  assert.ok(seen >= t0 - 1000 && seen <= Date.now() + 1000, 'last_seen 要是现在');
  assert.equal(post.headers.Authorization, 'Bearer at1');
});

test('服务器没给用户号:不记使用(没法知道写哪一行)', async () => {
  const t = setup(okServer({ '/auth/v1/token': () => ({ status: 200, json: { access_token: 'at1', refresh_token: 'rt1', expires_in: 3600, user: { email: EMAIL } } }) }));
  const r = await t.auth.signIn(EMAIL, 'pw-secret-1');
  await t.auth.idle();
  assert.equal(r.ok, true);
  assert.equal(t.net.calls.filter(c => c.path.startsWith('/rest/')).length, 0);
});

test('启动续期只刷新最近使用时间,登录次数不涨', async () => {
  const t = setup(okServer({
    '/rest/v1/hub_users?': (c) => c.method === 'GET' ? { status: 200, json: [{ login_count: 4, first_seen: '2026-01-01T00:00:00Z' }] } : { status: 201 },
  }));
  fs.writeFileSync(t.file, JSON.stringify({ v: 1, refreshToken: 'rt-old', userId: UID, email: EMAIL }));
  await t.auth.restore();
  await t.auth.idle();
  const post = t.net.calls.find(c => c.path === '/rest/v1/hub_users' && c.method === 'POST');
  assert.ok(post, '续期成功也要记一次最近使用');
  assert.equal(post.body.login_count, 4);
});

test('绝不碰 TMS 的 app_users 表', async () => {
  const t = setup();
  await t.auth.signIn(EMAIL, 'pw-secret-1');
  await t.auth.idle();
  await t.auth.restore();
  await t.auth.idle();
  await t.auth.signOut();
  await t.auth.idle();
  assert.ok(t.net.calls.length >= 6);
  assert.ok(t.net.calls.every(c => !c.path.includes('app_users')));
});

test('记使用失败(表没建 / 断网):登录照样成功、令牌照样落盘,只记日志', async () => {
  const fails = [() => ({ status: 404, json: { message: 'relation "public.hub_users" does not exist' } }), () => { throw new Error('ECONNRESET'); }];
  for (const f of fails) {
    const t = setup(okServer({ '/rest/v1/hub_users': f }));
    const r = await t.auth.signIn(EMAIL, 'pw-secret-1');
    await t.auth.idle();                                       // 抛了这里就红
    assert.equal(r.ok, true);
    assert.equal(t.read().refreshToken, 'rt1');
    assert.equal(t.auth.status().loggedIn, true);
    assert.ok(t.logs.length >= 1, '失败要留一条日志');
    assert.ok(t.net.calls.some(c => c.path.startsWith('/rest/v1/hub_users')), '夹具没走到记使用那一步');
  }
});

test('读旧记录失败(500 / 表没建 404 / 回的不是数组)就不写:硬写会把累计次数重置成 1', async () => {
  for (const resp of [{ status: 500, json: { message: 'boom' } }, { status: 404, json: { code: 'PGRST205' } }, { status: 200, json: { not: 'array' } }]) {
    const t = setup(okServer({ '/rest/v1/hub_users': (c) => c.method === 'GET' ? resp : { status: 201 } }));
    await t.auth.signIn(EMAIL, 'pw-secret-1');
    await t.auth.idle();
    const rest = t.net.calls.filter(c => c.path.startsWith('/rest/'));
    assert.deepEqual(rest.map(c => c.method), ['GET'], JSON.stringify(resp));
  }
});

test('登录不等记使用:记使用卡住时登录照样马上返回', async () => {
  const t = setup(okServer({ '/rest/v1/hub_users': () => new Promise(() => {}) }));
  const r = await Promise.race([t.auth.signIn(EMAIL, 'pw-secret-1'), new Promise((res) => setTimeout(() => res('stuck'), 500))]);
  assert.notEqual(r, 'stuck');
  assert.equal(r.ok, true);
});

// ---------- 日志 ----------
test('日志里不出现 anon key 和令牌', async () => {
  const leak = 'socket hang up; headers={"apikey":"' + authLib.ANON_KEY + '","Authorization":"Bearer at1"}';
  const t = setup(okServer({ '/rest/v1/hub_users': () => { throw new Error(leak); } }));
  await t.auth.signIn(EMAIL, 'pw-secret-1');
  await t.auth.idle();
  assert.ok(t.logs.length >= 1, '夹具没产生日志');
  assert.ok(t.logs.some(l => l.includes('socket hang up')), '日志应该保留错误本身');
  for (const l of t.logs) {
    assert.ok(!l.includes(authLib.ANON_KEY), 'anon key 进了日志');
    assert.ok(!l.includes('eyJ'), 'JWT 进了日志');
    assert.ok(!/Bearer at1/.test(l), '访问令牌进了日志');
  }
});

test('打码函数:不是 anon key 的 JWT 也抹掉;超长截断', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJlLXh4eA';
  const out = authLib.redact('a ' + jwt + ' b Bearer abc.def-123 c');
  assert.ok(!out.includes(jwt));
  assert.ok(!out.includes('abc.def-123'));
  assert.match(out, /^a .* b .* c$/);
  assert.ok(authLib.redact('x'.repeat(5000)).length <= 300);
  assert.equal(authLib.redact(null), '');
});

// ---------- 走系统代理的那层(lib/auth-net.js) ----------
test('auth-net:把 Electron 的 net.request 包成 auth.js 认得的样子', async () => {
  const { electronRequest } = require('../lib/auth-net');
  const made = [];
  const fakeNetMod = {
    request(o) {
      const r = new EventEmitter();
      r.o = o; r.body = ''; r.aborted = false;
      r.write = (d) => { r.body += d; };
      r.abort = () => { r.aborted = true; };
      r.end = () => {
        if (o.path.includes('boom')) { setImmediate(() => r.emit('error', new Error('net::ERR_PROXY_CONNECTION_FAILED'))); return; }
        if (o.path.includes('hang')) return;
        const res = new EventEmitter(); res.statusCode = 200;
        r.emit('response', res);
        setImmediate(() => { res.emit('data', Buffer.from(JSON.stringify(sess(3)))); res.emit('end'); });
      };
      made.push(r);
      return r;
    }
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-auth-'));
  const auth = authLib.create({ file: path.join(dir, 'auth.json'), request: electronRequest(fakeNetMod), log: () => {}, timeoutMs: 60 });
  const r = await auth.signIn(EMAIL, 'pw-secret-1');
  assert.equal(r.ok, true);
  const o = made[0].o;
  assert.equal(o.protocol, 'https:');
  assert.equal(o.hostname, 'qzpvogxvlescfwpqahsn.supabase.co');
  assert.equal(o.method, 'POST');
  assert.equal(o.path, '/auth/v1/token?grant_type=password');
  assert.equal(o.headers.apikey, authLib.ANON_KEY);
  assert.equal(o.headers['Content-Type'], 'application/json');
  assert.ok(!('Content-Length' in o.headers), 'net 不许自己设 Content-Length');
  assert.deepEqual(JSON.parse(made[0].body), { email: EMAIL, password: 'pw-secret-1' });
  await auth.idle();

  // 出错事件要传得回来;到总时限要真的把请求掐掉
  const shim = electronRequest(fakeNetMod);
  const e1 = await new Promise((res) => { const q = shim({ method: 'GET', hostname: 'h', port: 443, path: '/boom', headers: {} }, () => {}); q.on('error', res); q.end(); });
  assert.match(e1.message, /ERR_PROXY/);
  const before = made.length;
  const auth2 = authLib.create({ file: path.join(dir, 'auth2.json'), request: (o2, cb) => shim(Object.assign({}, o2, { path: '/hang' }), cb), log: () => {}, timeoutMs: 60 });
  const r2 = await Promise.race([auth2.signIn(EMAIL, 'pw-secret-1'), new Promise((res) => setTimeout(() => res('hung'), 1500))]);
  assert.notEqual(r2, 'hung');
  assert.equal(r2.ok, false);
  assert.equal(made[before].aborted, true, '超时后要 abort 掉底层请求');
});

// ---------- 接线 ----------
test('接线:启动续期不许被等;账号的每个通道都兜住异常;状态变了要推给界面', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(main, /auth\.restore\(\)\.then\(pushAuth/, '启动时要调一次续期,完成后推状态');
  assert.ok(!/await\s+auth\.restore\(/.test(main), '启动续期不许 await —— 会拖住启动');
  const handlers = main.split(/\r?\n/).filter(l => l.includes("ipcMain.handle('auth:"));
  assert.equal(handlers.length, 4);
  for (const l of handlers) assert.ok(/try\s*\{/.test(l) && /catch/.test(l), '没兜异常:' + l.slice(0, 60));
  const status = handlers.find(l => l.includes("'auth:status'"));
  assert.ok(!/await/.test(status), '问状态不许等网络');
  for (const ch of ['signIn', 'signUp', 'signOut']) assert.ok(handlers.find(l => l.includes("'auth:" + ch + "'")).includes('pushAuth()'), ch + ' 之后没推状态');
  assert.match(main, /require\('\.\/lib\/auth-net'\)\.electronRequest\(/, '账号请求要走系统代理那一层');
  assert.match(main, /try \{ auth = require\('\.\/lib\/auth'\)\.create\(/, '账号模块起不来不许带崩主进程');
  const push = main.split(/\r?\n/).find(l => l.startsWith('function pushAuth()'));
  assert.ok(push && /try\s*\{/.test(push) && push.includes('isDestroyed()'), '推状态要防窗口已经没了');
  const pre = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  assert.ok(pre.includes("ipcRenderer.on('auth:changed'"));
  assert.ok(pre.includes("authSignIn: (email, password) => ipcRenderer.invoke('auth:signIn', email, password)"), '登录要把邮箱和密码都传过去');
  assert.ok(pre.includes("authSignUp: (email, password) => ipcRenderer.invoke('auth:signUp', email, password)"), '注册要把邮箱和密码都传过去');
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.ok(html.includes('try { initAuth(); } catch {}'), '界面上账号初始化出错不许连累后面的启动步骤');
  const yml = fs.readFileSync(path.join(__dirname, '..', 'electron-builder.yml'), 'utf8');
  assert.ok(yml.includes('"!auth.json"'), '打包排除表里要有 auth.json');
});

test('接线:preload 暴露的 auth 通道在 main.js 里都有处理函数;令牌文件在 .gitignore 里', () => {
  const root = path.join(__dirname, '..');
  const pre = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const used = [...pre.matchAll(/invoke\('(auth:[a-zA-Z]+)'/g)].map(m => m[1]).sort();
  assert.deepEqual(used, ['auth:signIn', 'auth:signOut', 'auth:signUp', 'auth:status']);
  for (const ch of used) assert.ok(main.includes("ipcMain.handle('" + ch + "'"), 'main.js 缺 ' + ch);
  assert.ok(fs.readFileSync(path.join(root, '.gitignore'), 'utf8').split(/\r?\n/).includes('auth.json'));
  assert.equal(path.basename(require('../lib/paths').AUTH), 'auth.json');
});

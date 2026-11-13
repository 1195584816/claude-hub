// 账号:登录 / 注册 / 退出 / 启动时续期。和作者博客、TMS 是同一套 Supabase 账号。
//
// 定位:登录只是为了知道有谁在用,**不卡任何功能** —— 这里出任何错都只能降级成「未登录」
// 或者「离线」,不许抛到外面去、不许拖住启动。
//
// 纯 HTTPS 调 Supabase 的 REST 接口,不引 @supabase/supabase-js。
// anon key 是本来就放在客户端里的公开值(数据靠服务端的行级权限保护),但仍然不往日志里写。
const https = require('https');
const fs = require('fs');
const { writeJsonAtomic } = require('./atomic-json');

const SUPABASE_URL = 'https://qzpvogxvlescfwpqahsn.supabase.co';
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InF6cHZvZ3h2bGVzY2Z3cHFhaHNuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc5MzMyMzMsImV4cCI6MjA4MzUwOTIzM30.2uadJyp_KJNxRuFm1NIkuRPrTzq0-lBfuH3gb20LXGc';
// claude-hub 自己的使用记录表。不能和 TMS 共用 app_users:那张表一人一行(主键 user_id),
// 往里写会盖掉同一个人在 TMS 的版本号和最近使用时间,还会让他出现在 TMS 的「软件用户」名单里。
const USAGE_TABLE = 'hub_users';
const NET_ERR = '网络连不上,检查一下网络再试';
const STALE = { ok: false, stale: true, error: '这次操作被后面的操作取代了' };
// 续期时服务器明确说「这个令牌没用了」的几种说法。只有这些才删本地令牌。
const REVOKED_CODES = new Set(['refresh_token_not_found', 'refresh_token_already_used', 'session_not_found', 'session_expired', 'user_banned', 'user_not_found']);

// 进日志 / 进界面之前过一遍:anon key、任何 JWT、Bearer 后面的令牌都抹掉
function redact(s) {
  return String(s == null ? '' : s)
    .split(ANON_KEY).join('[anon-key]')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[jwt]')
    .replace(/Bearer\s+[^\s"',}]+/gi, 'Bearer [token]')
    .slice(0, 300);
}

const errMsg = (j) => String((j && (j.error_description || j.msg || j.message || j.error)) || '');
const errCode = (j) => String((j && (j.error_code || j.code)) || '');

function authErr(r, fallback) {
  const j = (r && r.json) || {};
  const msg = errMsg(j);
  const code = errCode(j);
  if (/email not confirmed/i.test(msg) || code === 'email_not_confirmed') return '邮箱还没验证 —— 请去注册邮箱里点确认链接,再回来登录';
  if (/invalid login credentials/i.test(msg) || code === 'invalid_credentials') return '邮箱或密码不对';
  if (/already registered/i.test(msg) || code === 'user_already_exists' || code === 'email_exists') return '这个邮箱已经注册过了,直接登录就行';
  if (/longer than 72/i.test(msg)) return '密码太长了,换个短一点的';
  if (/password should be|weak/i.test(msg) || code === 'weak_password') return '密码太短或太简单,换一个再试';
  if ((r && r.status === 429) || /rate limit/i.test(msg)) return '操作太频繁了,过一会儿再试';
  if (/signups? not allowed|signup.*disabled/i.test(msg) || code === 'signup_disabled') return '暂时不开放注册';
  if (/validate email|invalid.*email|email.*invalid/i.test(msg) || code === 'email_address_invalid') return '邮箱格式不对,或者这个邮箱收不了信';
  return redact(msg) || (fallback + '(' + (r ? r.status : '?') + ')');
}

// 续期失败是不是「令牌真的作废了」。别的失败(网关 401、限流、5xx……)一律不算 ——
// 否则哪天网关抖一下、或者换了 anon key,所有人本地的登录都会被删掉。
function isRevoked(r) {
  if (!r || r.status !== 400) return false;
  return REVOKED_CODES.has(errCode(r.json)) || /invalid refresh token/i.test(errMsg(r.json));
}

function checkCreds(email, password) {
  if (typeof email !== 'string' || typeof password !== 'string') return { error: '请填邮箱和密码' };
  const e = email.trim();
  if (e.length < 3 || e.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return { error: '邮箱格式不对' };
  if (password.length < 6) return { error: '密码至少 6 位' };
  // 服务器按字节算上限(bcrypt 的 72 字节),一个汉字 3 个字节
  if (Buffer.byteLength(password, 'utf8') > 72) return { error: '密码太长了,换个短一点的' };
  return { email: e, password };
}

// file:令牌文件的位置(必须由调用方给 —— 测试才不会写到真的用户数据目录里)
// request:默认 https.request;主进程里换成走系统代理的那个(lib/auth-net.js),测试里换成假的
// meta:() => ({ appVersion, platform }),记使用时带上
function create({ file, request = https.request, log = console.error, meta = () => ({}), timeoutMs = 15000 } = {}) {
  if (!file) throw new Error('auth.create 需要 file');
  let mem = null;                       // { accessToken, refreshToken, userId, email, offline }
  let gen = 0;                          // 每次登录 / 注册 / 退出 +1:晚回来的旧结果对不上号就作废(后点的赢)
  let touchP = Promise.resolve();
  let outP = Promise.resolve();
  const say = (what, e) => { try { log('[auth] ' + what + ':' + redact(e && e.message ? e.message : e)); } catch {} };

  function sbFetch(pathAndQuery, { method = 'GET', token, body, prefer } = {}) {
    return new Promise((resolve, reject) => {
      let done = false, timer = null, req = null;
      const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); fn(v); };
      const fail = (e) => finish(reject, e instanceof Error ? e : new Error('连接中断'));
      const kill = (why) => { fail(new Error(why)); try { req.destroy(); } catch {} };
      const u = new URL(SUPABASE_URL + pathAndQuery);
      const data = body != null ? JSON.stringify(body) : null;
      const headers = { apikey: ANON_KEY, Accept: 'application/json' };
      if (token) headers.Authorization = 'Bearer ' + token;
      if (prefer) headers.Prefer = prefer;
      if (data != null) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
      try {
        req = request({ hostname: u.hostname, port: 443, path: u.pathname + u.search, method, headers, timeout: timeoutMs }, (res) => {
          const chunks = [];
          res.on('data', (c) => { chunks.push(Buffer.from(c)); });
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let j = null; try { j = JSON.parse(text); } catch {}
            finish(resolve, { status: res.statusCode, json: j, text });
          });
          // 响应发到一半断了:不会有 end,不处理的话这个请求永远不结束
          res.on('aborted', () => fail(new Error('连接中断')));
          res.on('error', fail);
          res.on('close', () => fail(new Error('连接中断')));
        });
      } catch (e) { fail(e); return; }
      // 总时限兜底:上面的 timeout 只管「连接空闲」,对端一点点挤数据时它不触发
      timer = setTimeout(() => kill('网络超时'), Math.round(timeoutMs * 4 / 3));
      if (timer.unref) timer.unref();
      req.on('error', fail);
      req.on('timeout', () => kill('网络超时'));
      if (data != null) req.write(data);
      req.end();
    });
  }

  const norm = (j) => {
    const u = j.user || {};
    return { accessToken: j.access_token, refreshToken: j.refresh_token, userId: u.id || '', email: u.email || '' };
  };

  // 令牌落盘。只存续期用的那一个 —— 访问令牌一小时就过期,只留在内存里。
  function save() {
    try {
      writeJsonAtomic(file, { v: 1, refreshToken: mem.refreshToken, userId: mem.userId, email: mem.email, savedAt: new Date().toISOString() });
      return true;
    } catch (e) { say('令牌没存上(下次启动要重新登录)', e); return false; }
  }
  function load() {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!j || typeof j !== 'object' || typeof j.refreshToken !== 'string' || !j.refreshToken) return null;
      return { refreshToken: j.refreshToken, userId: typeof j.userId === 'string' ? j.userId : '', email: typeof j.email === 'string' ? j.email : '' };
    } catch { return null; }
  }
  // 清掉内存和盘上的令牌。返回 false = 盘上那份没清掉(下次启动会被当成还登录着)。
  function clear() {
    mem = null;
    try { fs.unlinkSync(file); return true; } catch (e) { if (e && e.code === 'ENOENT') return true; }
    // 删不掉(被杀毒 / 备份 / 索引之类的程序占着):退一步,把里面的令牌抹成空的
    try { fs.writeFileSync(file, '{}'); return true; }
    catch (e) { say('登录文件没清掉(下次启动可能又自动登录)', e); return false; }
  }

  // 拿到一份新会话:记进内存、落盘、顺手记一次使用(不等它,卡住也不拖登录)
  function adopt(tok, { bump }) {
    mem = { accessToken: tok.accessToken, refreshToken: tok.refreshToken, userId: tok.userId, email: tok.email, offline: false };
    const persisted = save();
    touchP = touch(tok.accessToken, tok.userId, tok.email, bump).catch((e) => say('记使用失败', e));
    return persisted;
  }

  // 记一次使用。bump=true 是真的输了密码登录,次数 +1;启动续期只刷新最近使用时间。
  // 读旧值再写回(没用数据库自增):同一个账号同时写的概率极低,差一次不影响看「谁在用」。
  async function touch(token, userId, email, bump) {
    if (!token || !userId) return;
    const r = await sbFetch('/rest/v1/' + USAGE_TABLE + '?user_id=eq.' + encodeURIComponent(userId) + '&select=login_count,first_seen', { token });
    // 读不出来就不写 —— 硬写会把累计次数重置成 1。表还没建(404)也走这里。
    if (r.status !== 200 || !Array.isArray(r.json)) { say('记使用失败', '读 ' + USAGE_TABLE + ' 返回 ' + r.status + ' ' + r.text); return; }
    const old = r.json[0];
    const m = meta() || {};
    const row = { user_id: userId, last_seen: new Date().toISOString(), login_count: old ? (bump ? (old.login_count || 0) + 1 : (old.login_count || 1)) : 1, app_version: String(m.appVersion || '').slice(0, 32), platform: String(m.platform || '').slice(0, 16) };
    if (email) row.email = email;
    if (old && old.first_seen) row.first_seen = old.first_seen;      // 别把首次时间盖掉
    const w = await sbFetch('/rest/v1/' + USAGE_TABLE, { token, method: 'POST', body: row, prefer: 'resolution=merge-duplicates,return=minimal' });
    if (w.status < 200 || w.status >= 300) say('记使用失败', '写 ' + USAGE_TABLE + ' 返回 ' + w.status + ' ' + w.text);
  }

  async function signIn(email, password) {
    const c = checkCreds(email, password);
    if (c.error) return { ok: false, error: c.error };
    const g = ++gen;
    let r;
    try { r = await sbFetch('/auth/v1/token?grant_type=password', { method: 'POST', body: { email: c.email, password: c.password } }); }
    catch (e) { say('登录请求失败', e); return g === gen ? { ok: false, error: NET_ERR } : STALE; }
    if (g !== gen) return STALE;
    if (r.status === 200 && r.json && r.json.access_token && r.json.refresh_token) {
      const persisted = adopt(norm(r.json), { bump: true });
      return { ok: true, email: mem.email, persisted };
    }
    return { ok: false, error: authErr(r, '登录失败') };
  }

  // 注册。这个 Supabase 项目开着邮箱验证:成功时拿不到会话,要用户去邮箱点确认再回来登录。
  // (哪天服务端关了验证、直接给会话,这里也认 —— 当场登录。)
  async function signUp(email, password) {
    const c = checkCreds(email, password);
    if (c.error) return { ok: false, error: c.error };
    const g = ++gen;
    let r;
    try { r = await sbFetch('/auth/v1/signup', { method: 'POST', body: { email: c.email, password: c.password } }); }
    catch (e) { say('注册请求失败', e); return g === gen ? { ok: false, error: NET_ERR } : STALE; }
    if (g !== gen) return STALE;
    const j = r.json || {};
    if (r.status === 200 && j.access_token && j.refresh_token) {
      const persisted = adopt(norm(j), { bump: true });
      return { ok: true, email: mem.email, persisted };
    }
    if (r.status === 200 && (j.id || (j.user && j.user.id))) {
      // 开着邮箱验证时,拿已注册的邮箱再注册,服务端不报错,而是回一个没有 identities 的假用户(防止被人探测邮箱)
      const ids = j.identities || (j.user && j.user.identities);
      if (Array.isArray(ids) && ids.length === 0) return { ok: false, error: '这个邮箱已经注册过了,直接登录就行' };
      return { ok: true, needConfirm: true, email: c.email };
    }
    return { ok: false, error: authErr(r, '注册失败') };
  }

  // 退出:只退这台电脑。⚠️ 必须带 scope=local —— 不带的话 Supabase 默认是 global,
  // 会把这个账号在博客、TMS、别的电脑上的登录一起踢掉。
  // 先清本地、立刻返回;通知服务器放后台(断网时要等十几秒,不能让界面陪着等)。
  // 离线状态下手里没有访问令牌,通知不了服务器 —— 本地令牌删了就算退出。
  async function signOut() {
    ++gen;
    const token = mem && mem.accessToken;
    const wiped = clear();
    if (token) outP = sbFetch('/auth/v1/logout?scope=local', { method: 'POST', token }).then(
      (r) => { if (r.status < 200 || r.status >= 300) say('退出时服务器没受理', '返回 ' + r.status); },
      (e) => say('退出时没通知到服务器', e));
    return wiped ? { ok: true } : { ok: true, persisted: false };
  }

  // 启动时调一次:有令牌就悄悄续期。永不抛。
  //   服务器明确说令牌作废 → 删文件,回到未登录
  //   别的任何失败(断网 / 超时 / 网关报错 / 5xx)→ 令牌留着,照样显示这个账号,下次启动再续
  async function restore() {
    try {
      const saved = load();
      if (!saved) return;
      const g = gen;
      // 先同步记进内存:界面一问状态就能看到这个账号,不用等网络
      const m = mem = { accessToken: '', refreshToken: saved.refreshToken, userId: saved.userId, email: saved.email, offline: false };
      let r = null;
      try { r = await sbFetch('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: saved.refreshToken } }); }
      catch (e) { say('启动续期没连上', e); }
      if (g !== gen) return;            // 等的这会儿用户已经自己登录 / 退出了,这份结果作废
      if (r && r.status === 200 && r.json && r.json.access_token && r.json.refresh_token) {
        const tok = norm(r.json);
        if (!tok.email) tok.email = saved.email;
        if (!tok.userId) tok.userId = saved.userId;
        adopt(tok, { bump: false });
      } else if (isRevoked(r)) {
        clear();
      } else {
        m.offline = true;
        if (r) say('启动续期失败', '返回 ' + r.status + ' ' + errMsg(r.json));
      }
    } catch (e) { say('启动续期出错', e); }
  }

  const status = () => ({ loggedIn: !!mem, email: mem ? mem.email : '', offline: !!(mem && mem.offline) });
  const idle = () => Promise.all([touchP, outP]);   // 测试用:等后台那几件事跑完

  return { signIn, signUp, signOut, restore, status, idle };
}

module.exports = { create, redact, SUPABASE_URL, ANON_KEY, USAGE_TABLE };

// 手机控制台服务:HTTP + SSE(不引第三方 WebSocket 依赖)
// 安全:默认关闭 / 配对码换令牌 / 设备白名单可踢 / 失败锁定 / 公网模式额外警示
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const P = require('./paths');

const DEVICES = path.join(P.APP_DATA, 'mobile-devices.json');

let server = null, bridge = null, opts = { port: 8730, readonly: false };
let pairCode = '', pairExpire = 0, failCount = 0, failUntil = 0;
let devices = load();
const sse = new Set();          // 活跃的 SSE 连接

function load() { try { return JSON.parse(fs.readFileSync(DEVICES, 'utf8')); } catch { return []; } }
function save() { try { fs.writeFileSync(DEVICES, JSON.stringify(devices, null, 2), 'utf8'); } catch {} }

function newPairCode() {
  pairCode = String(Math.floor(100000 + Math.random() * 900000));
  pairExpire = Date.now() + 10 * 60e3;      // 10 分钟有效
  return pairCode;
}
function lanIPs() {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const k in ifs) for (const a of ifs[k] || []) {
    if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}
function authOf(req, url) {
  const t = url.searchParams.get('token') || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!t) return null;
  const d = devices.find(x => x.token === t);
  if (d) { d.lastSeen = Date.now(); }
  return d || null;
}
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise(resolve => {
    let b = '';
    req.on('data', c => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
  });
}

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of [...sse]) { try { res.write(payload); } catch { sse.delete(res); } }
}

function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  res.setHeader('X-Content-Type-Options', 'nosniff');

  // 手机页面本体(不需要令牌,页面内自己再配对)
  if (p === '/' || p === '/index.html') {
    let html = '';
    try { html = fs.readFileSync(path.join(__dirname, '..', 'mobile.html'), 'utf8'); } catch { html = '<h1>mobile.html 缺失</h1>'; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  // 配对:6 位码换长期令牌
  if (p === '/api/pair' && req.method === 'POST') {
    readBody(req).then(b => {
      if (Date.now() < failUntil) return json(res, 429, { ok: false, msg: '尝试过多,请稍后再试' });
      if (!pairCode || Date.now() > pairExpire) return json(res, 403, { ok: false, msg: '配对码已过期,请在电脑端重新生成' });
      if (String(b.code || '').trim() !== pairCode) {
        if (++failCount >= 5) { failUntil = Date.now() + 10 * 60e3; failCount = 0; }
        return json(res, 403, { ok: false, msg: '配对码不对' });
      }
      const token = crypto.randomBytes(24).toString('hex');
      const dev = {
        token, name: String(b.name || '手机').slice(0, 20),
        ua: String(req.headers['user-agent'] || '').slice(0, 120),
        ip: req.socket.remoteAddress, at: Date.now(), lastSeen: Date.now()
      };
      devices.push(dev); save();
      failCount = 0;
      pairCode = '';                                  // 一次性,用完即失效
      broadcast('devices', devices.length);
      json(res, 200, { ok: true, token, readonly: opts.readonly });
    });
    return;
  }

  const dev = authOf(req, url);
  if (!dev) return json(res, 401, { ok: false, msg: '未配对或令牌失效' });

  // 全局状态:项目 / 会话 / 运行中终端 / 最近完成
  if (p === '/api/state') { json(res, 200, Object.assign({ ok: true, readonly: opts.readonly }, bridge.state())); return; }

  // 终端输出流(SSE)
  if (p === '/api/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no'
    });
    res.write('retry: 3000\n\n');
    const id = url.searchParams.get('id') || '';
    if (id) { const hist = bridge.history(id); if (hist) res.write(`event: hist\ndata: ${JSON.stringify({ id, data: hist })}\n\n`); }
    res._termId = id;
    sse.add(res);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
    req.on('close', () => { clearInterval(ping); sse.delete(res); });
    return;
  }

  if (opts.readonly && req.method === 'POST' && p !== '/api/ping') return json(res, 403, { ok: false, msg: '当前是只读模式' });

  // 发指令到终端
  if (p === '/api/input' && req.method === 'POST') {
    readBody(req).then(b => { bridge.write(b.id, b.data || ''); json(res, 200, { ok: true }); });
    return;
  }
  // 打开会话(恢复或新建)
  if (p === '/api/open' && req.method === 'POST') {
    readBody(req).then(async b => {
      const r = await bridge.open(b.projPath, b.short || '', b.sid || '', b.title || '');
      json(res, 200, r);
    });
    return;
  }
  if (p === '/api/ping') { json(res, 200, { ok: true, t: Date.now() }); return; }

  json(res, 404, { ok: false });
}

function start(o, br) {
  stop();
  opts = Object.assign({ port: 8730, readonly: false }, o || {});
  bridge = br;
  return new Promise(resolve => {
    server = http.createServer(handle);
    server.on('error', e => resolve({ ok: false, msg: String(e.message || e) }));
    server.listen(opts.port, '0.0.0.0', () => {
      newPairCode();
      resolve({ ok: true, port: opts.port, code: pairCode, ips: lanIPs() });
    });
  });
}
function stop() {
  for (const r of [...sse]) { try { r.end(); } catch {} }
  sse.clear();
  if (server) { try { server.close(); } catch {} server = null; }
}
function status() {
  return {
    running: !!server, port: opts.port, readonly: opts.readonly,
    code: (pairCode && Date.now() < pairExpire) ? pairCode : '',
    ips: lanIPs(), clients: sse.size,
    devices: devices.map(d => ({ name: d.name, ua: d.ua, ip: d.ip, at: d.at, lastSeen: d.lastSeen, token: d.token.slice(0, 8) }))
  };
}
function regenCode() { return newPairCode(); }
function kick(tokenPrefix) {
  devices = devices.filter(d => !d.token.startsWith(tokenPrefix));
  save();
  return devices.length;
}
function setReadonly(v) { opts.readonly = !!v; }
// 主进程把终端输出喂进来 → 推给所有订阅该终端的手机
function pushTermData(id, data) {
  const payload = `event: data\ndata: ${JSON.stringify({ id, data })}\n\n`;
  for (const res of [...sse]) {
    if (res._termId && res._termId !== id) continue;
    try { res.write(payload); } catch { sse.delete(res); }
  }
}
function pushEvent(ev, data) { broadcast(ev, data); }

module.exports = { start, stop, status, regenCode, kick, setReadonly, pushTermData, pushEvent };

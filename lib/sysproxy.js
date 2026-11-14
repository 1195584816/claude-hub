// 让总控终端里的 Claude Code 跟着 Windows 系统代理走。
//
// 为什么要有这个:Claude Code **不看系统代理**,只认 HTTPS_PROXY / HTTP_PROXY 环境变量,而且不支持 SOCKS
// (官方文档 code.claude.com/docs/en/network-config,2026-11-13 核对)。
// 而 TMS / v2rayN / Clash 的常用模式恰恰是「开一个本机端口 + 设成系统代理」—— 浏览器认,Claude Code 不认,
// 于是它直连出去,Anthropic 看到真实 IP 返回 403(2026-11-13 三月在别人电脑上:出口没问题、TMS 连着,照样 403)。
// 另一条路是 TUN,但 TUN 接管整机流量,三月明确不要(「一用其他软件网站都会走代理,很难受」)。
//
// 做法:**每次开终端时**读一下系统代理,开着、是 HTTP 代理、端口真能连上,就只给这个终端带上
// HTTPS_PROXY / HTTP_PROXY。不改 Windows 的全局环境变量 —— 别的软件不受影响;代理关了,下次开的终端就不带。
//
// 守住的边界(哪条不满足都原样返回,宁可不设也不乱设):
//   · 环境里已经有人设过代理变量(任意大小写)→ 不动。用户自己的配置永远优先。
//   · 系统代理没开 / 只有 SOCKS / 地址看不懂 / 是 PAC 脚本 → 不设。
//   · 地址连不上(开关开着却指向一个死端口,这种事发生过)→ 不设,免得把本来能直连的人搞断。
//   · 整个过程限时,超时、出任何岔子都当成「没有系统代理」,绝不拖住或挡住开终端。
const { execFile } = require('child_process');
const net = require('net');
const path = require('path');

const KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
const PROXY_VARS = ['https_proxy', 'http_proxy', 'all_proxy'];   // 判断「已经有人设过」时看这三个(不分大小写)
const DEFAULT_NO_PROXY = 'localhost,127.0.0.1,::1';
const MAX_NO_PROXY = 40;
const TOTAL_TIMEOUT_MS = 2000;
const PROBE_TIMEOUT_MS = 500;
const CACHE_MS = 3000;

// 把注册表里的 ProxyServer 变成 Claude Code 认的 http://host:port;认不出或用不了就返回 null。
// Windows 的写法有两种:
//   "127.0.0.1:10808"                                   —— 所有协议共用一个(HTTP 代理)
//   "http=1.2.3.4:80;https=1.2.3.4:443;socks=1.2.3.4:1080" —— 分协议
function parseProxyServer(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s || s.length > 300) return null;
  let hp = '';
  if (s.includes('=')) {
    const map = {};
    for (const part of s.split(';')) {
      const i = part.indexOf('=');
      if (i > 0) map[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim();
    }
    // 分协议写法里只认 https= 那一项。只写了 http= 的话,Windows 的意思是「HTTPS 直连」,
    // 那个代理未必肯转发 HTTPS —— 不拿它凑数(宁可不设)。只有 socks= 的同理用不了。
    hp = map.https || '';
  } else {
    hp = s;
  }
  if (!hp) return null;
  if (/^socks/i.test(hp)) return null;       // Claude Code 不支持 SOCKS
  hp = hp.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  // 主机名 / IPv4 / [IPv6] + 端口;别的字符一律不认(这个值会进环境变量)
  const m = /^(\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+):(\d{1,5})$/.exec(hp);
  if (!m) return null;
  const port = Number(m[2]);
  if (!(port >= 1 && port <= 65535)) return null;
  return { url: 'http://' + m[1] + ':' + port, host: m[1].replace(/^\[|\]$/g, ''), port };
}

// 把系统里的「不走代理」名单(ProxyOverride)翻译成 NO_PROXY 的条目。
// 为什么要翻:代理软件设系统代理时都会带一份名单(本机、局域网网段……),浏览器照着它直连。
// 我们替终端带上 HTTPS_PROXY 之后,如果把这份名单丢了,终端里 git / npm / curl 访问局域网的东西
// (内网 GitLab、NAS、自建中转)就会被送去代理 —— 代理是全局模式的话直接连不上。
//   <local>           → 跳过(意思是「不带点的主机名」,NO_PROXY 表达不了)
//   10.* / 192.168.*  → 10.0.0.0/8 / 192.168.0.0/16(curl、git、pip、Go 写的工具认这种写法)
//   172.16.* … 172.31.* 十六条都在 → 合成 172.16.0.0/12
//   *.example.com     → .example.com
//   普通主机名 / IP   → 原样
//   别的带 * 的、带怪字符的 → 丢掉
// 注意:不是所有工具都认网段写法(Node 系的多数不认)。认的工具直连;不认的仍会把请求交给代理软件,
// 由代理软件自己的规则决定 —— 比完全不带这份名单强,但不是百分之百等同于浏览器的行为。
function parseOverride(raw) {
  const out = [];
  const seen = new Set();
  const add = (v) => { if (v && v.length <= 100 && !seen.has(v) && out.length < MAX_NO_PROXY) { seen.add(v); out.push(v); } };
  const toks = String(raw == null ? '' : raw).slice(0, 4000).split(/[;,\s]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
  const b172 = new Set();
  for (const t of toks) {
    let m;
    if (t.startsWith('<')) continue;
    if ((m = /^(\d{1,3})\.\*$/.exec(t))) { if (+m[1] <= 255) add(m[1] + '.0.0.0/8'); continue; }
    if ((m = /^(\d{1,3})\.(\d{1,3})\.\*$/.exec(t))) {
      if (+m[1] > 255 || +m[2] > 255) continue;
      if (m[1] === '172' && +m[2] >= 16 && +m[2] <= 31) { b172.add(+m[2]); continue; }
      add(m[1] + '.' + m[2] + '.0.0/16'); continue;
    }
    if ((m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\*$/.exec(t))) { if (+m[1] <= 255 && +m[2] <= 255 && +m[3] <= 255) add(m[1] + '.' + m[2] + '.' + m[3] + '.0/24'); continue; }
    if ((m = /^\*(\.[a-z0-9-]+(?:\.[a-z0-9-]+)*)$/.exec(t))) { add(m[1]); continue; }
    if (/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(t)) { add(t); continue; }      // 普通主机名 / IPv4
    // 其余(别处带 *、带端口、带怪字符)一律不要
  }
  if (b172.size === 16) add('172.16.0.0/12');
  else for (const n of [...b172].sort((a, b) => a - b)) add('172.' + n + '.0.0/16');
  return out;
}

// 解析 `reg query <键>` 的输出,取 ProxyEnable、ProxyServer、ProxyOverride
function parseRegOutput(text) {
  const out = { enable: false, server: '', override: '' };
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^\s+(\S+)\s+(REG_\w+)\s*(.*)$/.exec(line);
    if (!m) continue;
    const name = m[1].toLowerCase(), val = m[3].trim();
    if (name === 'proxyenable') out.enable = /^(0x0*1|1)$/i.test(val);
    else if (name === 'proxyserver') out.server = val;
    else if (name === 'proxyoverride') out.override = val;
  }
  return out;
}

function regQuery() {
  return new Promise((resolve, reject) => {
    const exe = path.win32.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', 'reg.exe');
    execFile(exe, ['query', KEY], { timeout: 1500, windowsHide: true, encoding: 'utf8' }, (err, stdout) => {
      if (err) reject(err); else resolve(stdout);
    });
  });
}

// 端口真能连上才算数
function probe(host, port, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let done = false;
    const fin = (v) => { if (done) return; done = true; try { sock.destroy(); } catch {} resolve(v); };
    const sock = net.connect({ host, port });
    sock.setTimeout(timeoutMs, () => fin(false));
    sock.once('connect', () => fin(true));
    sock.once('error', () => fin(false));
  });
}

function hasProxyVar(env) {
  return Object.keys(env || {}).some(k => PROXY_VARS.includes(k.toLowerCase()) && String(env[k] || '').trim() !== '');
}
function hasVar(env, name) {
  return Object.keys(env || {}).some(k => k.toLowerCase() === name && String(env[k] || '').trim() !== '');
}

function create({ platform = process.platform, query = regQuery, probeFn = probe, now = Date.now, timeoutMs = TOTAL_TIMEOUT_MS } = {}) {
  let cache = { at: 0, value: null };
  let inflight = null;

  // 当前可用的系统代理:{ url, host, port, noProxy } 或 null。
  // 几秒内重复问直接用上次的;正在查的时候又有人问,就等同一次(一下子开十几个终端只读一次注册表)。
  function current() {
    if (platform !== 'win32') return Promise.resolve(null);
    if (cache.at && now() - cache.at < CACHE_MS) return Promise.resolve(cache.value);
    if (inflight) return inflight;
    inflight = (async () => {
      let value = null;
      try {
        const reg = parseRegOutput(await query());
        const p = reg.enable ? parseProxyServer(reg.server) : null;
        if (p && await probeFn(p.host, p.port)) value = Object.assign(p, { noProxy: parseOverride(reg.override) });
      } catch { value = null; }
      cache = { at: now(), value };
      return value;
    })();
    const done = () => { inflight = null; };
    inflight.then(done, done);
    return inflight;
  }

  // 给一份环境变量,返回 { env, applied }。applied = 实际带上的代理地址,没带就是 ''。
  // 永不抛、限时;任何不确定都原样返回。
  async function envFor(env) {
    const out = Object.assign({}, env);
    try {
      if (hasProxyVar(out)) return { env: out, applied: '' };
      let timer = null;
      const late = new Promise((res) => { timer = setTimeout(() => res(null), timeoutMs); });
      let p;
      try { p = await Promise.race([current(), late]); } finally { clearTimeout(timer); }
      if (!p) return { env: out, applied: '' };
      out.HTTPS_PROXY = p.url;
      out.HTTP_PROXY = p.url;
      // 不走代理的名单:本机地址(本机的开发服务、总控自己的本机接口)+ 系统里那份名单翻译过来的。用户设过就不动。
      if (!hasVar(out, 'no_proxy')) {
        const list = DEFAULT_NO_PROXY.split(',');
        for (const v of (p.noProxy || [])) if (!list.includes(v)) list.push(v);
        out.NO_PROXY = list.join(',');
      }
      return { env: out, applied: p.url };
    } catch { return { env: Object.assign({}, env), applied: '' }; }
  }

  return { current, envFor };
}

module.exports = { create, parseProxyServer, parseRegOutput, parseOverride, hasProxyVar, probe, DEFAULT_NO_PROXY, TOTAL_TIMEOUT_MS };

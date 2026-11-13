#!/usr/bin/env node
/**
 * Claude Code 通知钩子 —— 全套逻辑的唯一真相。
 *
 * 为什么是这个文件、为什么用 node:
 *   1. 钩子是 Claude Code 拉起的纯 node 进程,读不了 app.asar。所以逻辑不能放在
 *      lib/ 下让钩子去 require,必须反过来:逻辑住在这里,lib/notify.js 当薄壳。
 *      这样"界面转发"和"钩子转发"两套文案不可能再漂移。
 *   2. 不再经 PowerShell 中继。PS 读 stdin 必须手动按 UTF-8 字节解(走 [Console]::In
 *      会用系统 GBK 解码把中文路径全毁掉),而且 .ps1 里不能写中文。node 读 stdin
 *      默认就是 UTF-8,一种语言搞完。
 *
 * 三种用法:
 *   node claude-notify-hook.js --event Stop           # settings.json 的 Stop 钩子
 *   node claude-notify-hook.js --event Notification   # settings.json 的 Notification 钩子
 *   node claude-notify-hook.js --send <记录json>      # 自己派生的后台进程,只管发外部通知
 *
 * 被 require 时只导出函数,不执行任何副作用。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const net = require('net');
const tls = require('tls');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');

// ---------- 路径(自己推导,不 require ../lib/paths:装到 ~/.claude/hooks 后那条相对路径不存在) ----------
const HOME = os.homedir();
const CLAUDE_HOME = path.join(HOME, '.claude');
const APP_DATA = (process.platform === 'win32' && process.env.APPDATA)
  ? path.join(process.env.APPDATA, 'claude-hub')
  : path.join(HOME, '.claude-hub');

const P = {
  FEED: path.join(CLAUDE_HOME, 'hooks', 'done-feed.jsonl'),
  LOG: path.join(CLAUDE_HOME, 'hooks', 'notify.log'),
  CFG: path.join(APP_DATA, 'notify-config.json'),       // 和界面同一份,不再分裂
  SPOOL: path.join(APP_DATA, 'notify-spool.jsonl'),     // 发失败的存这儿,下次补发
  PRESENCE: path.join(APP_DATA, 'presence.json'),       // 客户端写:窗口有没有焦点、在看哪个会话
  PROJECTS: path.join(APP_DATA, 'projects.json'),       // 他在界面上改的项目显示名在这儿
  SESS_TITLES: path.join(APP_DATA, 'session-titles.json'), // 会话名也是他改的,也在这儿
  WAIT_ACK: path.join(APP_DATA, 'wait-ack.json')        // 哪些会话"已经提醒过、还没被理",见下面的重复闸
};

const FEED_KEEP = 100;
const LOG_MAX = 512 * 1024;
const TASK_MAX = 300;
const RESULT_MAX = 2000;     // 采集时存宽,发送时按通道各自裁

// ---------- 配置 ----------
const DEFAULTS = {
  wecom: { enabled: false, key: '' },
  feishu: { enabled: false, webhook: '' },
  serverchan: { enabled: false, sendkey: '' },
  telegram: {
    enabled: false, token: '', chatId: '',
    // TG 被墙。node 核心 https 从不读 HTTPS_PROXY,必须自己走 CONNECT 隧道。
    proxy: { enabled: true, host: '127.0.0.1', port: 10808 }
  },
  routing: {
    waitToExternal: true,          // "在等你" -> 推外部(TG/企微/飞书/Server酱)
    doneToExternal: false,         // "跑完了" -> 默认不推,免得被淹
    waitToToast: true,             // "在等你" -> 总控台右上角弹提示卡
    stopQuestionIsStrong: false,   // Stop 正文像在提问时也算强提醒(启发式,默认关)
    skipWhenFocused: true,         // 窗口正开着这个会话就别打扰
    oneWaitPerTurn: true           // 同一个会话提醒过就不再提,直到他理了(见 waitNotified)
  },
  dnd: { enabled: false, from: '23:00', to: '08:00' },
  mute: {}                         // { '<项目绝对路径>': true }
};

function deepDefaults(cfg, def) {
  const out = Array.isArray(def) ? (Array.isArray(cfg) ? cfg : def) : {};
  if (Array.isArray(def)) return out;
  for (const k of Object.keys(def)) {
    const d = def[k], c = cfg ? cfg[k] : undefined;
    if (d && typeof d === 'object' && !Array.isArray(d)) out[k] = deepDefaults(c, d);
    else out[k] = (c === undefined || c === null) ? d : c;
  }
  // 配置里多出来的键(比如 mute 的各个项目)原样保留
  if (cfg && typeof cfg === 'object') for (const k of Object.keys(cfg)) if (!(k in out)) out[k] = cfg[k];
  return out;
}

function loadCfg() {
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(P.CFG, 'utf8')); } catch {}
  return deepDefaults(raw, DEFAULTS);
}

// ---------- 日志(有上限,不让它涨成几百兆) ----------
function log(msg) {
  try {
    fs.appendFileSync(P.LOG, new Date().toISOString().slice(5, 19).replace('T', ' ') + ' ' + msg + '\n', 'utf8');
    const st = fs.statSync(P.LOG);
    if (st.size > LOG_MAX) {
      const txt = fs.readFileSync(P.LOG, 'utf8');
      fs.writeFileSync(P.LOG, txt.slice(-Math.floor(LOG_MAX / 2)), 'utf8');
    }
  } catch {}
}

// ---------- 判别"在等你" ----------
// 取自 claude.exe 内嵌的 notification_type 枚举。这几种都是"它停在那儿等人答"。
const STRONG_TYPES = new Set([
  'permission_prompt',          // 权限弹窗出现 6 秒还没人答才发(期间答了就取消)
  'idle_prompt',                // 空闲到阈值,且过了"人还在不在"的门控
  'agent_needs_input',
  'elicitation_dialog',
  'elicitation_url_dialog',
  'worker_permission_prompt'
]);

// 纯噪音:不是在等你,别写进完成流
const IGNORE_TYPES = new Set([
  'auth_success', 'computer_use_enter', 'computer_use_exit',
  'quota_auto_resume_start', 'quota_auto_resume_end', 'model_refusal_fallback'
]);

const RE_ASK = /[?？]\s*$|请(?:你)?(?:确认|选择|决定|拍板|定一下)|要不要|是否需要|你(?:定|选)|等你(?:拍板|确认|回|点头)|哪一?个更|怎么(?:办|选)/;

function looksLikeQuestion(text) {
  if (!text) return false;
  const tail = String(text).slice(-240);
  return RE_ASK.test(tail);
}

// ---------- 把文件夹名换成他在客户端里改过的显示名 ----------
// 钩子原来只有 path.basename(cwd),所以他在界面上重命名项目或会话之后,
// 弹框和外部推送里还是老名字(2026-10-23 他指出来的)。
// 显示名就在 %APPDATA%\claude-hub 下那两个 JSON 里,直接读,实时的。
function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }
function normPath(p) { return String(p || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase(); }

function displayNames(cwd, sid) {
  const own = cwd ? path.basename(cwd) : 'Claude';
  const out = { projName: own, sess: '' };
  const list = readJson(P.PROJECTS);
  if (Array.isArray(list) && cwd) {
    const c = normPath(cwd);
    const hit = list
      .filter(p => p && p.path)
      .filter(p => { const pp = normPath(p.path); return c === pp || c.startsWith(pp + '\\'); })
      .sort((a, b) => String(b.path).length - String(a.path).length)[0];
    if (hit) {
      const short = String(hit.short || hit.name || own).trim() || own;
      // 和界面同一条规则:项目可能登记在伞形目录上(「卖AI·总控大本营」= F:\claude-project),
      // 子目录别冒充父项目,带上真实文件夹,否则又回到"卡片挂错名"那个老毛病
      out.projName = normPath(hit.path) === c ? short : short + ' › ' + own;
    }
  }
  const titles = readJson(P.SESS_TITLES);
  if (titles && sid && typeof titles[sid] === 'string') out.sess = titles[sid].trim();
  return out;
}

// ---------- 认出"无人值守的机器会话" ----------
// 定时任务 / 批量调用跑出来的会话:提示词是程序灌进去的,不是他敲的,
// 结果往往是一坨给机器看的 JSON。这种东西占着通知位毫无意义 —— 他永远不会点"进入"。
// 判别依据是实测比出来的(feed 里 9 个会话,4 机器 5 真人,两个信号零交叉):
//   机器:第一条记录是 queue-operation,且全程没有 ai-title
//   真人:第一条是 mode / last-prompt / permission-mode,都有 ai-title
// 两个信号都成立才算。只认一个的话,他哪天真在会话开头排了条消息就会被误杀。
// 只读头部 64KB —— 转录动辄几百 MB,这一下必须廉价。
function isMachineSession(tp) {
  if (!tp) return false;
  let text = '';
  try {
    const fd = fs.openSync(tp, 'r');
    const take = Math.min(fs.fstatSync(fd).size, 64 * 1024);
    const buf = Buffer.alloc(take);
    fs.readSync(fd, buf, 0, take, 0);
    fs.closeSync(fd);
    text = buf.toString('utf8');
  } catch { return false; }
  const lines = text.split('\n').filter(l => l.trim() && l.trim()[0] === '{');
  if (!lines.length) return false;
  let first = '';
  try { first = JSON.parse(lines[0]).type || ''; } catch { return false; }
  if (first !== 'queue-operation') return false;
  // 末行可能被 64KB 截断,解析失败跳过就好
  for (const ln of lines) {
    try { if (JSON.parse(ln).type === 'ai-title') return false; } catch {}
  }
  return true;
}

// ---------- 从转录尾部取"他上一条指令"和"干了什么" ----------
// Stop 载荷里已经带 last_assistant_message,所以不用再倒扫整个转录找回复。
// "他上一条指令"载荷里没有,但转录里有现成的 last-prompt 记录
// (Claude Code 为自己的 resume 维护的),比扫 user 消息又准又便宜 —— 实测
// 这个会话转录 49.5MB,最后 1MB 里 59 条 user 全是工具结果、一条真人文本都没有。
function scanTail(tp) {
  const out = { task: '', lastAssistant: '', tools: [], tok: 0, turnFound: false };
  if (!tp) return out;
  let text = '';
  try {
    const fd = fs.openSync(tp, 'r');
    const size = fs.fstatSync(fd).size;
    const take = Math.min(size, 2 * 1024 * 1024);
    const buf = Buffer.alloc(take);
    fs.readSync(fd, buf, 0, take, size - take);
    fs.closeSync(fd);
    text = buf.toString('utf8');
  } catch { return out; }

  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const ln = lines[i].trim();
    if (!ln || ln[0] !== '{') continue;
    let e = null;
    try { e = JSON.parse(ln); } catch { continue; }
    if (!e || e.isSidechain || e.isMeta || e.isCompactSummary) continue;

    // 最省事的那条路:现成的最后一条真人指令
    if (e.type === 'last-prompt' && !out.task && e.lastPrompt) {
      out.task = String(e.lastPrompt).replace(/\s+/g, ' ').trim();
      continue;
    }

    if (e.type === 'assistant') {
      const m = e.message || {};
      if (!out.tok && m.usage) {
        const u = m.usage;
        out.tok = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0);
      }
      const parts = [].concat(m.content || []);
      for (const c of parts) {
        if (c && c.type === 'text' && !out.lastAssistant) {
          const t = String(c.text || '').replace(/\s+/g, ' ').trim();
          if (t) out.lastAssistant = t;
        }
        if (c && c.type === 'tool_use' && c.name) out.tools.push(c.name);
      }
      continue;
    }
    if (e.type !== 'user') continue;

    const c = (e.message || {}).content;
    let t = '';
    if (typeof c === 'string') t = c;
    else if (c) t = [].concat(c).filter(x => x && x.type === 'text').map(x => x.text).join(' ');
    // 工具结果也走 user 类型,但 content 里没有 text 块 -> 上面天然过滤掉了
    t = t
      .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, ' ')
      .replace(/<command-name>[\s\S]*?<\/command-name>/g, ' ')
      .replace(/<command-message>[\s\S]*?<\/command-message>/g, ' ')
      .replace(/<command-args>[\s\S]*?<\/command-args>/g, ' ')
      .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, ' ')
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ')
      .replace(/<pasted_content[^>]*>[\s\S]*?<\/pasted_content>/g, '[粘贴内容] ')
      .replace(/\s+/g, ' ').trim();
    if (!t || t[0] === '<') continue;
    // 找到真人指令就是这一轮的起点,再往前的工具调用不算"这一轮干的"
    if (!out.task) out.task = t;
    out.turnFound = true;
    break;
  }
  // 没扫到这一轮的起点(转录太大、这一轮工具太多),工具统计就会把上几轮也算进去。
  // 宁可不说,也不要报一个"动了 Bash×33"的假数。
  if (!out.turnFound) out.tools = [];
  return out;
}

function tally(names) {
  const m = new Map();
  for (const n of names) m.set(n, (m.get(n) || 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
    .map(([n, c]) => c > 1 ? `${n}×${c}` : n).join(' ');
}

function cut(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// ---------- 组装记录 ----------
function buildRecord(event, payload, cfg) {
  const cwd = payload.cwd || process.env.CLAUDE_PROJECT_DIR || '';
  const proj = cwd ? path.basename(cwd) : 'Claude';
  const names = displayNames(cwd, payload.session_id || '');
  const ntype = payload.notification_type || '';

  if (event === 'Notification' && IGNORE_TYPES.has(ntype)) return null;

  const scan = scanTail(payload.transcript_path);
  // Stop 自带 last_assistant_message:官方注释原文说它就是为了"免得去读转录"
  const result = event === 'Stop'
    ? (payload.last_assistant_message || scan.lastAssistant)
    : scan.lastAssistant;

  const bg = [].concat(payload.background_tasks || []).length;

  let level, reason;
  if (event === 'Notification') {
    level = STRONG_TYPES.has(ntype) ? 'wait' : 'done';
    reason = 'notification:' + (ntype || '?');
  } else if (bg > 0) {
    // 载荷里 background_tasks 就是为了分清"真干完了"和"在等后台活儿醒过来"
    level = 'bg';
    reason = 'background_tasks=' + bg;
  } else if (cfg.routing.stopQuestionIsStrong && looksLikeQuestion(result)) {
    level = 'wait';
    reason = 'stop+问句启发式';
  } else {
    level = 'done';
    reason = 'stop';
  }

  return {
    ts: new Date().toLocaleString('sv-SE').replace('T', ' ').slice(0, 19),   // sv-SE 天然是 YYYY-MM-DD HH:mm:ss
    level, reason, event, ntype,
    // proj 保持文件夹名不动 —— 界面的 projOfRec 兜底、fkey 做未读键都靠它。
    // 显示名另起字段,老记录没有这俩字段时下游自动退回 proj。
    proj, cwd,
    projName: names.projName,
    sess: names.sess,
    sid: payload.session_id || '',
    task: cut(scan.task, TASK_MAX),
    result: cut(result, RESULT_MAX),
    did: tally(scan.tools),
    msg: payload.message || '',
    tok: scan.tok || 0,
    bg
  };
}

// ---------- 免打扰闸 ----------
function inQuietHours(dnd, now) {
  if (!dnd || !dnd.enabled) return false;
  const hm = (s) => { const [h, m] = String(s || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0); };
  const cur = now.getHours() * 60 + now.getMinutes();
  const a = hm(dnd.from), b = hm(dnd.to);
  return a <= b ? (cur >= a && cur < b) : (cur >= a || cur < b);   // 跨午夜
}

function presence() {
  try {
    const p = JSON.parse(fs.readFileSync(P.PRESENCE, 'utf8'));
    // 客户端崩了会留下过期的 presence,超过 2 分钟不认
    if (!p || !p.at || Date.now() - p.at > 120000) return null;
    return p;
  } catch { return null; }
}

// ---------- "一个会话、一条指令,只提醒一次" ----------
// idle_prompt 不是一次性事件,Claude Code 按定时器一直发 —— 实测他一个会话弹了
// 131 次系统通知。所以提醒出去一次就记下来,同一个会话不再重复提。
//
// 什么算"该重新提醒了"?判据是 rec.task,也就是转录里他最后那条真人指令。
// 他又说了一句话 -> task 变了 -> 这是新的一轮,该提醒。
// 为什么不用"一轮跑完(level=done)"当复位信号:后台任务醒过来也会跑出一个 done,
// 他人根本没动,闸就被白白打开了 —— 他真实日志里这种 done 一大把。
// 为什么不是"他点了通知就复位":点了=他看见了,更不该再提。所以看见等同于提醒过。
//
// 状态必须落文件:钩子每次都是个新进程,内存留不住。
const ACK_TTL = 12 * 3600 * 1000;      // 这么久都没动静就当过期清掉,别让文件只涨不减
const NO_TASK_QUIET = 10 * 60 * 1000;  // 连他的指令都读不出来时的兜底间隔(宁可多响,不能哑)

function readAck() {
  try { return JSON.parse(fs.readFileSync(P.WAIT_ACK, 'utf8')) || {}; } catch { return {}; }
}
function writeAck(m) {
  try {
    fs.mkdirSync(path.dirname(P.WAIT_ACK), { recursive: true });
    fs.writeFileSync(P.WAIT_ACK, JSON.stringify(m), 'utf8');
  } catch {}
}
/** 这条「等你拍板」是不是重复的(同一个会话、同一条指令已经提醒过/他已经看见过) */
function isRepeatWait(rec) {
  if (!rec || !rec.sid) return false;
  const e = readAck()[rec.sid];
  if (!e || !e.at || Date.now() - e.at >= ACK_TTL) return false;
  const now = String(rec.task || '').trim();
  const old = String(e.task || '').trim();
  if (now || old) return now === old;          // 指令没变 = 还是那一轮 = 重复
  return Date.now() - e.at < NO_TASK_QUIET;    // 两边都读不到指令,只能按时间兜
}
/** 记下"这个会话这一轮他已经知道了" —— 提醒发出去了,或者他正开着它看 */
function markWaitSeen(rec) {
  if (!rec || !rec.sid) return;
  const m = readAck();
  for (const k of Object.keys(m)) {
    const e = m[k];
    if (!e || !e.at || Date.now() - e.at > ACK_TTL) delete m[k];
  }
  const prev = m[rec.sid];
  const task = String(rec.task || '').trim();
  m[rec.sid] = { at: Date.now(), task, n: (prev && prev.task === task ? (prev.n || 0) : 0) + 1 };
  writeAck(m);
}

/** 返回 { external:bool, toast:bool, why:string } */
function gate(rec, cfg) {
  const r = cfg.routing;
  if (rec.level === 'bg') return { external: false, toast: false, why: '后台活儿还在跑,不算完成' };
  if (cfg.mute && cfg.mute[rec.cwd]) return { external: false, toast: false, why: '该项目已静音' };
  if (inQuietHours(cfg.dnd, new Date())) return { external: false, toast: false, why: '免打扰时段' };

  if (r.skipWhenFocused) {
    const p = presence();
    if (p && p.focused && rec.sid && p.sid === rec.sid) {
      return { external: false, toast: false, why: '你正开着这个会话' };
    }
  }
  if (rec.level === 'wait') return { external: !!r.waitToExternal, toast: !!r.waitToToast, why: '' };
  return { external: !!r.doneToExternal, toast: false, why: '' };
}

// ---------- 文案(四个通道共用一个,不再各写一套) ----------
const LIMITS = { telegram: 3900, wecom: 1800, feishu: 1800, serverchan: 1800 };

function fmt(rec, channel) {
  const head = rec.level === 'wait' ? '🔴 等你拍板' : '✅ 跑完了';
  // projName 是他在客户端里改过的名字;老记录没这字段就退回文件夹名
  const lines = [`${head} · ${rec.projName || rec.proj}`, ''];
  // 同一个项目他常开好几个会话,光有项目名分不清是哪个
  if (rec.sess) lines.push('会话:' + rec.sess);
  if (rec.level === 'wait' && rec.msg) lines.push('· ' + rec.msg);
  if (rec.task) lines.push('你让它:' + rec.task);
  if (rec.result) lines.push('它说:' + rec.result);
  if (rec.did) lines.push('动了:' + rec.did);
  lines.push('', rec.ts + (rec.cwd ? '  ' + rec.cwd : ''));
  let s = lines.join('\n');
  const lim = LIMITS[channel] || 1800;
  if (s.length > lim) {
    // 超长就只砍"它说"那段,头尾信息保住
    const over = s.length - lim + 1;
    s = s.replace(rec.result, cut(rec.result, Math.max(80, rec.result.length - over)));
  }
  return s.length > lim ? s.slice(0, lim) : s;
}

// ---------- 传输层 ----------
function httpsPost(url, body, contentType) {
  return new Promise((resolve) => {
    try {
      const u = new URL(url);
      const payload = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
      const req = https.request({
        hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
        headers: { 'Content-Type': contentType || 'application/json', 'Content-Length': payload.length },
        timeout: 10000
      }, (res) => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => resolve({ status: res.statusCode, body: d }));
      });
      req.on('error', e => resolve({ status: 0, body: String(e.message || e) }));
      req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '超时' }); });
      req.write(payload);
      req.end();
    } catch (e) { resolve({ status: 0, body: String(e.message || e) }); }
  });
}

/**
 * 建一条到 host:443 的 HTTP CONNECT 隧道,握手完成后把 TLS socket 交回去。
 * 代理连不上就明确报"代理不可达",绝不退回直连 —— 直连只会挂满超时。
 */
function connectTunnel(proxy, host, cb) {
  let settled = false;
  const fin = (err, sock) => { if (!settled) { settled = true; cb(err, sock); } };
  const raw = net.connect({ host: proxy.host, port: Number(proxy.port) });
  raw.setTimeout(6000);
  raw.on('timeout', () => { raw.destroy(); fin(new Error(`代理无响应 ${proxy.host}:${proxy.port}`)); });
  raw.on('error', e => fin(new Error(`代理不可达 ${proxy.host}:${proxy.port} (${e.code || e.message})`)));
  raw.on('connect', () => {
    raw.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`);
    let head = '';
    const onData = (chunk) => {
      head += chunk.toString('latin1');
      if (head.indexOf('\r\n\r\n') === -1) return;
      raw.removeListener('data', onData);
      if (!/^HTTP\/1\.[01] 200/.test(head)) {
        raw.destroy();
        return fin(new Error('隧道被拒:' + head.split('\r\n')[0]));
      }
      raw.setTimeout(0);
      // servername 必须给:不给 SNI,TLS 握手直接被拒
      const sock = tls.connect({ socket: raw, servername: host });
      sock.once('secureConnect', () => fin(null, sock));
      sock.once('error', e => fin(new Error('TLS 握手失败:' + e.message)));
    };
    raw.on('data', onData);
  });
}

/**
 * 经隧道 POST。TG 被墙,而 node 核心 https 从不读 HTTPS_PROXY,所以隧道必须自己建。
 * 10808 是混合端口(HTTP+SOCKS),CONNECT 直接可用,不用实现 SOCKS。
 *
 * ⚠️ 这里踩过一个实测出来的坑:把隧道 socket 用 options.socket 或 createConnection
 * 的同步形态直接塞给 https.request,两种都不行 —— node 会在 TLS 握手完成之前
 * 就把请求字节写出去,症状是一边卡满超时、一边报 "wrong version number"。
 * 正确做法是自定义 Agent、用 createConnection 的【回调】形态,
 * 由 node 自己决定什么时候写请求(https-proxy-agent 也是这么做的)。
 */
function proxyPost(proxy, host, pathname, body) {
  return new Promise((resolve) => {
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    class TunnelAgent extends https.Agent {
      createConnection(opts, cb) { connectTunnel(proxy, host, cb); }
    }
    const req = https.request({
      host, path: pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length },
      agent: new TunnelAgent({ keepAlive: false }),
      timeout: 20000
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', e => resolve({ status: 0, body: String(e.message || e) }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '隧道内超时' }); });
    req.write(payload);
    req.end();
  });
}

// ---------- 各通道 ----------
async function sendTelegram(cfg, rec) {
  const tg = cfg.telegram;
  if (!tg.token || !tg.chatId) return { ok: false, msg: '没填 token 或 chatId' };
  const body = {
    chat_id: tg.chatId,
    text: fmt(rec, 'telegram'),
    disable_web_page_preview: true
    // 故意不给 parse_mode:路径里的 _ * [ 会让 Markdown 解析直接 400
  };
  const r = (tg.proxy && tg.proxy.enabled)
    ? await proxyPost(tg.proxy, 'api.telegram.org', `/bot${tg.token}/sendMessage`, body)
    : await httpsPost(`https://api.telegram.org/bot${tg.token}/sendMessage`, body);
  if (r.status !== 200) return { ok: false, msg: `HTTP ${r.status} ${cut(r.body, 160)}` };
  let j = null; try { j = JSON.parse(r.body); } catch {}
  return j && j.ok ? { ok: true, msg: 'ok' } : { ok: false, msg: cut(r.body, 160) };
}

async function sendWecom(cfg, rec) {
  const r = await httpsPost(
    'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=' + encodeURIComponent(cfg.wecom.key),
    { msgtype: 'text', text: { content: fmt(rec, 'wecom') } });
  if (r.status !== 200) return { ok: false, msg: `HTTP ${r.status} ${cut(r.body, 160)}` };
  let j = null; try { j = JSON.parse(r.body); } catch {}
  // 企微返回 200 但 errcode≠0 也是失败 —— 旧版只看 HTTP 200,所以一直在谎报成功
  return j && j.errcode === 0 ? { ok: true, msg: 'ok' } : { ok: false, msg: cut(r.body, 160) };
}

async function sendFeishu(cfg, rec) {
  const r = await httpsPost(cfg.feishu.webhook, { msg_type: 'text', content: { text: fmt(rec, 'feishu') } });
  if (r.status !== 200) return { ok: false, msg: `HTTP ${r.status} ${cut(r.body, 160)}` };
  let j = null; try { j = JSON.parse(r.body); } catch {}
  if (j && (j.code === 0 || j.StatusCode === 0)) return { ok: true, msg: 'ok' };
  return { ok: false, msg: cut(r.body, 160) };
}

async function sendServerchan(cfg, rec) {
  const title = (rec.level === 'wait' ? '等你拍板 · ' : '跑完了 · ') + rec.proj;
  const body = 'title=' + encodeURIComponent(title) + '&desp=' + encodeURIComponent(fmt(rec, 'serverchan'));
  const r = await httpsPost(
    'https://sctapi.ftqq.com/' + encodeURIComponent(cfg.serverchan.sendkey) + '.send',
    body, 'application/x-www-form-urlencoded');
  if (r.status !== 200) return { ok: false, msg: `HTTP ${r.status} ${cut(r.body, 160)}` };
  let j = null; try { j = JSON.parse(r.body); } catch {}
  return j && (j.code === 0 || j.data) ? { ok: true, msg: 'ok' } : { ok: false, msg: cut(r.body, 160) };
}

const CHANNELS = {
  telegram: { send: sendTelegram, ready: c => c.telegram.enabled && c.telegram.token && c.telegram.chatId },
  wecom: { send: sendWecom, ready: c => c.wecom.enabled && c.wecom.key },
  feishu: { send: sendFeishu, ready: c => c.feishu.enabled && c.feishu.webhook },
  serverchan: { send: sendServerchan, ready: c => c.serverchan.enabled && c.serverchan.sendkey }
};

/** 发一条记录到所有启用的通道。only 指定时只发那一个(测试按钮用)。 */
async function sendAll(rec, only) {
  const cfg = loadCfg();
  const names = only ? [only] : Object.keys(CHANNELS);
  const results = {};
  for (const n of names) {
    const ch = CHANNELS[n];
    if (!ch) continue;
    if (!only && !ch.ready(cfg)) continue;        // 测试按钮即使没勾 enabled 也要能发
    try { results[n] = await ch.send(cfg, rec); }
    catch (e) { results[n] = { ok: false, msg: String(e.message || e) }; }
  }
  const any = Object.keys(results).length > 0;
  return {
    ok: any && Object.values(results).every(r => r.ok),
    any, results,
    msg: Object.entries(results).map(([k, v]) => `${k}:${v.ok ? 'ok' : v.msg}`).join(' | ') || '没有启用任何通道'
  };
}

// ---------- 补发队列 ----------
function spoolPush(rec) {
  try {
    let lines = [];
    try { lines = fs.readFileSync(P.SPOOL, 'utf8').split('\n').filter(Boolean); } catch {}
    lines.push(JSON.stringify({ rec, tries: (rec.__tries || 0) + 1 }));
    fs.writeFileSync(P.SPOOL, lines.slice(-50).join('\n') + '\n', 'utf8');
  } catch {}
}

async function spoolFlush() {
  let lines = [];
  try { lines = fs.readFileSync(P.SPOOL, 'utf8').split('\n').filter(Boolean); } catch { return; }
  if (!lines.length) return;
  const keep = [];
  for (const ln of lines.slice(-20)) {
    let item = null;
    try { item = JSON.parse(ln); } catch { continue; }
    if (!item || !item.rec) continue;
    if (item.tries >= 5) { log('补发放弃(试了5次) ' + item.rec.proj); continue; }
    const r = await sendAll(item.rec);
    if (r.ok) log('补发成功 ' + item.rec.proj + ' ' + item.rec.ts);
    else keep.push(JSON.stringify({ rec: item.rec, tries: item.tries + 1 }));
  }
  try {
    if (keep.length) fs.writeFileSync(P.SPOOL, keep.join('\n') + '\n', 'utf8');
    else fs.unlinkSync(P.SPOOL);
  } catch {}
}

// ---------- 完成流落盘 ----------
function appendFeed(rec) {
  try {
    fs.mkdirSync(path.dirname(P.FEED), { recursive: true });
    fs.appendFileSync(P.FEED, JSON.stringify(rec) + '\n', 'utf8');
    const lines = fs.readFileSync(P.FEED, 'utf8').split('\n').filter(Boolean);
    if (lines.length > FEED_KEEP) fs.writeFileSync(P.FEED, lines.slice(-FEED_KEEP).join('\n') + '\n', 'utf8');
  } catch (e) { log('写完成流失败 ' + e.message); }
}

// ---------- 入口 ----------
function readStdin() {
  return new Promise((resolve) => {
    let buf = Buffer.alloc(0);
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(buf.toString('utf8')); } };
    // 钩子超时也就十几秒,stdin 要是一直不关就别干等
    const t = setTimeout(done, 5000);
    process.stdin.on('data', c => { buf = Buffer.concat([buf, c]); });
    process.stdin.on('end', () => { clearTimeout(t); done(); });
    process.stdin.on('error', () => { clearTimeout(t); done(); });
  });
}

async function mainHook(event) {
  const raw = await readStdin();
  let payload = null;
  try { payload = JSON.parse(raw); } catch {
    log(`[${event}] 载荷解析失败 len=${raw.length} head=${raw.slice(0, 120)}`);
    return;
  }
  // 机器会话在这儿就掐掉:不记 feed、不亮红点、不弹框、不发 TG。
  // 放在 buildRecord 之前,连那 2MB 的尾部扫描都省了。
  if (isMachineSession(payload.transcript_path)) {
    log(`[${event}] 跳过机器会话 sid=${String(payload.session_id || '').slice(0, 8)} cwd=${payload.cwd || ''}`);
    return;
  }
  const cfg = loadCfg();
  const rec = buildRecord(event, payload, cfg);
  if (!rec) { log(`[${event}] 忽略 ntype=${payload.notification_type}`); return; }

  appendFeed(rec);
  const g = gate(rec, cfg);

  // 重复闸:gate 保持纯函数,状态读写都集中在这一处。
  // 只有"他真的知道了"才记账 —— 提醒确实发出去了,或者他正开着这个会话看着。
  // 被免打扰/静音挡掉的不记,那种情况他其实没收到,不能当成已经提醒过。
  if (rec.level === 'wait') {
    const pz = presence();
    const looking = !!(pz && pz.focused && rec.sid && pz.sid === rec.sid);
    if (cfg.routing.oneWaitPerTurn !== false && isRepeatWait(rec)) {
      if (g.toast || g.external) {
        g.toast = false; g.external = false;
        g.why = '这一轮已经提醒过了,等你说句话再提';
      }
    } else if (g.toast || g.external || looking) {
      markWaitSeen(rec);
    }
  }

  log(`[${event}] ${rec.level} ${rec.proj} ${rec.reason}` +
      ` 外部=${g.external ? 'Y' : 'N'} 弹框=${g.toast ? 'Y' : 'N'}` + (g.why ? ' (' + g.why + ')' : ''));

  // 弹框由客户端做(它在盯 done-feed.jsonl),这里只打标记
  if (g.toast) {
    try { fs.writeFileSync(path.join(APP_DATA, 'toast-pending.json'), JSON.stringify(rec), 'utf8'); } catch {}
  }

  // 外部转发可能要走代理、要几秒 —— 派生后台进程去发,钩子立刻退出,绝不拖住对话收尾
  if (g.external) {
    try {
      const tmp = path.join(os.tmpdir(), 'claude-notify-' + Date.now() + '-' + process.pid + '.json');
      fs.writeFileSync(tmp, JSON.stringify(rec), 'utf8');
      const child = spawn(process.execPath, [__filename, '--send', tmp], { detached: true, stdio: 'ignore' });
      child.unref();
    } catch (e) { log('派生转发进程失败 ' + e.message); }
  }
}

async function mainSend(file) {
  let rec = null;
  try { rec = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return; }
  await spoolFlush();                       // 先把上次没发出去的补上
  const r = await sendAll(rec);
  log('转发 ' + rec.proj + ' -> ' + r.msg);
  if (r.any && !r.ok) spoolPush(rec);       // 有通道失败就进队列,下次补
  try { fs.unlinkSync(file); } catch {}
}

if (require.main === module) {
  const argv = process.argv;
  const get = (k) => { const i = argv.indexOf(k); return i > -1 ? argv[i + 1] : null; };
  const event = get('--event');
  const sendFile = get('--send');
  const p = sendFile ? mainSend(sendFile) : (event ? mainHook(event) : Promise.resolve());
  // 钩子永远 exit 0:通知挂了不能影响 Claude 本身
  p.then(() => process.exit(0)).catch((e) => { log('未捕获 ' + (e && e.message)); process.exit(0); });
}

module.exports = {
  DEFAULTS, loadCfg, deepDefaults, fmt, sendAll, buildRecord, gate,
  looksLikeQuestion, isMachineSession, displayNames, STRONG_TYPES, PATHS: P,
  isRepeatWait, markWaitSeen
};

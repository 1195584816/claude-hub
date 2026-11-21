// 总控里起的会话名 → Claude Code 自己的会话名(别的会话互相找、@ 它用的就是这个)。
// 2026-11-19 三月:「我改完会话名,其他会话也应该都能互相认识才对」。
//
// 两套名字原来是分开的:
//   总控改名   → %APPDATA%\claude-hub\session-titles.json,只有总控自己看得见
//   Claude Code → ~/.claude/sessions/<pid>.json 的 name(没改过是 claude-31 / comfyui-ca 这种自动编号)
// 以前只在「改名那一刻终端正开着」时往里打一句 /rename,终端没开、总控重启恢复、改名早于这个功能的,都对不上。
//
// 现在两条路(都走官方入口,不碰 ~/.claude 里的任何文件):
//   ① 总控开 / 恢复会话时,启动命令带上 --name '名字'(官方参数,和 /rename 一样)—— nameArg()
//   ② 已经开着、名字对不上的:pickSync() 挑出「空闲、人没在打字、还是自动编号」的,主进程核过登记的 Claude 进程确实是
//      这个终端里跑的,再交给界面读终端画面确认输入框是空的,才输入 /rename 名字(不发 Ctrl+U)。任何一步拿不准就不动
//
// 名字里的控制字符、换行去掉;双引号换成单引号(经 node-pty 拼进 powershell -Command 时双引号会被拆开);
// 比较「对不对得上」用的也是清理后的这一份,不然清理过的名字永远对不上,会一直重复改。

const MAX = 80;
// 名字清理:控制字符、换行去掉;双引号(含中文弯双引号)换成单引号;
// ⚠️ 中文弯单引号 ‘ ’ ‚ ‛ 也统一成 ASCII ' —— PowerShell 把它们也当单引号(复核实测:标题「三月的‘测试’」会把名字截断、
// 多出来的「测试」被 Claude 当成一句话发出去;`a‘;Write-Output X;‘` 能执行中间那条命令)。中文输入法打引号默认就是弯的。
// 比较「对不对得上」和 /rename 用的都是清理后的这一份
function wantName(title) {
  let s = String(title == null ? '' : title);
  s = s.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/["“-‟″‶]/g, "'")
    .replace(/[‘-‛′‵]/g, "'")
    .replace(/\s+/g, ' ').trim();
  if (s.length > MAX) s = s.slice(0, MAX).trim();
  return s;
}

// 拼在 claude 命令后面的那一截;PowerShell 单引号字符串里单引号写两遍
function nameArg(title) {
  const n = wantName(title);
  return n ? ` --name '${n.replace(/'/g, "''")}'` : '';
}

// 给「claude --resume "会话号"」这种默认命令补 --name。自定义命令(worktree、计划模式、分叉…)不动。
// supported:本机 Claude Code 认不认 --name(启动时问一次 claude --help,见 main.js)。老版本不认的话加了会直接起不来,
// 所以拿不准(还没问完 / 问不出来)一律不加
function withName(cmd, title, supported) {
  const c = String(cmd || '');
  if (!supported) return c;
  if (!/^claude --resume "[0-9a-fA-F-]{36}"$/.test(c)) return c;
  return c + nameArg(title);
}

const QUIET_MS = 15000;      // 最后一次输入之后至少过这么久
const RETRY_MS = 120000;     // 同一个会话改过一次没生效,隔这么久才再试
const MAX_TRIES = 2;         // 同一个会话、同一个目标名最多自动试这么多次,还对不上就停(不再隔两分钟打一次)
const FRESH_MS = 60000;      // 登记里没有 status 的,只认刚启动这么久以内的(那时它一定停在输入框)

// metas:[{ id, sid, claude }](总控里开着的终端);titles:{ sid: 总控名 };cc:{ sid: { name, nameSource, status, startedAt } };
// inputs:{ id: { at, enter } };attempts:{ sid: { name, n, at } }(at = 上次去问的时间,n = 界面真打出去的次数)
// 只挑「还是自动编号(nameSource 不是 user)」的:人在 Claude 里亲手 /rename 过的不去覆盖,免得两边来回改
// pending:{ sid: 总控刚改的名字 } —— 人刚在总控里改了名,哪怕 Claude 那边 nameSource 已经是 user
// (自动改过一次、或者带 --name 恢复的都是 user)也要同步;仍然要过空闲、没人打字、核进程、输入框为空这几关
function pickSync({ metas, titles, cc, inputs, attempts, now, pending }) {
  const out = [];
  // 同一个会话号挂在两个终端上 = 新会话认重了,拿不准是哪个,都不动
  const seen = {};
  for (const m of metas || []) if (m && m.sid) seen[m.sid] = (seen[m.sid] || 0) + 1;
  for (const m of metas || []) {
    if (!m || !m.sid || m.claude === false) continue;
    if (seen[m.sid] > 1) continue;
    const want = wantName((titles || {})[m.sid]);
    if (!want) continue;                                   // 总控里没改过名:不动,让它用自己的默认编号
    const c = (cc || {})[m.sid];
    if (!c || !c.name || c.name === want) continue;         // Claude 还没起来 / 已经对上了
    // 人在 Claude 里亲手起过名:不覆盖 —— 除非这个名字就是总控刚改的(pending),那是人刚下的指令
    if (c.nameSource === 'user' && (pending || {})[m.sid] !== want) continue;
    // 忙(busy)、在跑命令(shell)、在等人确认 / 弹着菜单(waiting):都不动。
    // 没有 status 的(刚启动还没聊过一轮)只认刚起来一分钟以内的 —— 老版本可能根本不写 status,不能一律当空闲
    // 人刚在总控里改的名(pending)放宽一点:没 status 也行(没聊过一轮的会话 /rename 之后一直没有 status,2026-11-19 实测),
    // 反正最后还要过界面读画面「输入框是空的」那一关(菜单、确认框画面上没有空的 ❯ 输入行,过不去)
    const asked = (pending || {})[m.sid] === want;
    if (c.status ? c.status !== 'idle' : !(asked || (c.startedAt && now - c.startedAt < FRESH_MS))) continue;
    if (!inputQuiet((inputs || {})[m.id], now)) continue;   // 人刚打过字,或者最后一下不是回车
    const a = (attempts || {})[m.sid];
    if (a && a.name === want) {
      if (a.n >= MAX_TRIES) continue;
      if (now - a.at < RETRY_MS) continue;
    }
    out.push({ id: m.id, sid: m.sid, name: want, pid: c.pid || 0 });
  }
  return out;
}

// 这个终端的输入是不是「安静」的:从没输入过,或者最后一下是回车、而且过了 QUIET_MS
function inputQuiet(inp, now) {
  return !inp || (inp.enter && now - inp.at >= QUIET_MS);
}

// 登记里的 Claude 进程是不是这个终端里跑的:pid 还活着(在进程表里),而且顺着父进程往上能走到终端的 powershell。
// parents:{ pid: 父 pid }(整张进程表)。三月本机 claude 走 claude.cmd 包一层,所以要往上走好几层
function isDescendant(pid, rootPid, parents) {
  if (!pid || !rootPid || !parents || !(pid in parents)) return false;
  let cur = pid;
  for (let i = 0; i < 8; i++) {
    const up = parents[cur];
    if (!up) return false;
    if (up === rootPid) return true;
    cur = up;
  }
  return false;
}

// 一次输入算不算「以回车结束」(粘贴多行 / 方向键这些都不算)
function endsWithEnter(data) {
  return /\r$/.test(String(data || ''));
}

// 这段「输入」是不是终端自己回的话,不是人按的键(2026-11-19 实测踩到):
// Claude Code 启动时会问终端「你是什么终端 / 光标在哪 / 支持什么」,xterm 的回答和键盘输入走同一条 term:input,
// 不排除的话会被记成「人打了字、没按回车」,自动改名就永远不动。认这几类:
//   设备属性 ESC[?…c / ESC[>…c、光标位置 ESC[行;列R、状态 ESC[…n、焦点 ESC[I / ESC[O、模式查询 ESC[?…$y、
//   OSC 回答 ESC]…BEL|ST、DCS 回答 ESC P…ST、鼠标上报 ESC[<…M|m(鼠标不往输入框里打字)
// 方向键(ESC[A)、Home/End、Del(ESC[3~)这些真按键不在里面,照样算输入。
const AUTO_REPLY = /^(?:\x1b\[\?[\d;]*c|\x1b\[>[\d;]*c|\x1b\[\d+;\d+R|\x1b\[\d*n|\x1b\[[IO]|\x1b\[\?[\d;]*\$y|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1bP[^\x1b]*\x1b\\|\x1b\[<[\d;]*[Mm])+$/;
function isAutoReply(data) {
  const s = String(data || '');
  return !!s && AUTO_REPLY.test(s);
}

// 新开的会话在发第一句话之前没有会话记录,总控认不出它是哪个会话,标签上就没法显示「@默认编号」。
// Claude Code 一启动就在 ~/.claude/sessions 里登记了(会话号、目录、启动时间、名字),
// 拿「同一个目录 + 总控开这个终端之后一分钟内启动的」去对:一个终端只对上一条、那条也只对上这一个终端,才算认出来;
// 有歧义(同一目录差不多同时开了两个)就不认,宁可先不显示。已经认出会话号的终端、被它们占着的登记都不参与。
// metas:[{ id, sid, projPath, spawnAt }];reg:{ sessionId: { name, cwd, startedAt } }。返回 { 终端 id: { sid, name } }
const normDir = (p) => String(p || '').replace(/[\\/]+$/, '').toLowerCase();
function matchUnbound(metas, reg) {
  const taken = new Set((metas || []).filter(m => m && m.sid).map(m => m.sid));
  const cands = {}, claim = {};
  for (const m of metas || []) {
    if (!m || m.sid || !m.spawnAt || m.claude === false) continue;   // codex / gemini / 更新命令的标签不认
    const list = [];
    for (const [sid, r] of Object.entries(reg || {})) {
      if (taken.has(sid) || !r || !r.startedAt) continue;
      if (normDir(r.cwd) !== normDir(m.projPath)) continue;
      if (r.startedAt < m.spawnAt - 2000 || r.startedAt > m.spawnAt + 60000) continue;
      list.push(sid);
      claim[sid] = (claim[sid] || 0) + 1;
    }
    cands[m.id] = list;
  }
  const out = {};
  for (const [id, list] of Object.entries(cands)) {
    if (list.length === 1 && claim[list[0]] === 1) out[id] = { sid: list[0], name: reg[list[0]].name };
  }
  return out;
}

module.exports = { wantName, nameArg, withName, pickSync, inputQuiet, isDescendant, endsWithEnter, isAutoReply, matchUnbound, QUIET_MS, RETRY_MS, MAX_TRIES, FRESH_MS };

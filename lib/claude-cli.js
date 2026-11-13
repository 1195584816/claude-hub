// 找这台电脑上的 Claude Code,以及没装时怎么装。
//
// 背景:总控本身不带 Claude Code,开会话就是在内嵌终端里敲一句 `claude`。
// 没装的电脑上那一句只会换来一屏 PowerShell 红字(2026-11-13 三月在别人电脑上看到的第一眼)。
//
// 几个坑(前两条来自官方文档 code.claude.com/docs/en/setup 和 troubleshoot-install,2026-11-13 核对):
//   1. 官方安装器把 claude.exe 装到 %USERPROFILE%\.local\bin,但**不会把这个目录加进 PATH**
//      —— 所以「装完了终端里仍然找不到 claude」是正常现象,得自己去那个目录找、自己补进 PATH。
//   2. npm 装的是 claude.cmd / claude.ps1,不是 .exe —— 找的时候几种后缀都要认。
//   3. 「应用执行别名」(WindowsApps 里那种 0 字节的壳)用 existsSync 看是「不存在」,PowerShell 却能运行
//      —— 所以判断「有没有这个文件」用 lstat,不用 existsSync。
//   4. PATH 里有连不上的网络路径时,查一次文件要等几十秒 —— 给界面用的检测必须异步 + 限时,超时当成「装了」。
//
// ⭐ 总原则:这里判错的代价不对称。把「装了」判成「没装」会挡住本来能用的人,
//    把「没装」判成「装了」只是回到老样子(红字)。所以一切拿不准的情况都往「装了」判。
const fs = require('fs');
const os = require('os');
const path = require('path');

const INSTALL_DOC = 'https://code.claude.com/docs/en/setup';
// 官方的 Windows(PowerShell)安装命令,一个字都不要改。不需要 Node、不需要 Git、不需要管理员。
const INSTALL_PS = 'irm https://claude.ai/install.ps1 | iex';
const WIN_NAMES = ['claude.exe', 'claude.cmd', 'claude.bat', 'claude.com', 'claude.ps1'];
const DEFAULT_TIMEOUT_MS = 1500;      // 界面等检测结果最多等这么久;健康的电脑实测十来毫秒

// 只有系统明确说「没有这个文件 / 这段路径不是目录」才算没有;别的报错(没权限、路径怪异……)说明拿不准,按「有」算。
const gone = (e) => !!e && (e.code === 'ENOENT' || e.code === 'ENOTDIR');
const lstatSync = (p) => { try { fs.lstatSync(p); return true; } catch (e) { return !gone(e); } };
const lstatAsync = async (p) => { try { await fs.promises.lstat(p); return true; } catch (e) { return !gone(e); } };

// Windows 的环境变量名不分大小写,但拷成普通对象之后就分了(常见的是 'Path')。找到真正用的那个键。
function pathKey(env) {
  return Object.keys(env).find(k => k.toLowerCase() === 'path') || 'PATH';
}
function localBinDir(home, win) {
  return win ? path.win32.join(home, '.local', 'bin') : path.posix.join(home, '.local', 'bin');
}
function splitPath(env, win) {
  return String(env[pathKey(env)] || '').split(win ? ';' : ':').map(s => s.trim().replace(/^"|"$/g, '')).filter(Boolean);
}
const norm = (p) => String(p).replace(/[\\/]+$/, '').toLowerCase();

// 按顺序列出所有该看的位置:先 PATH(和终端里敲 claude 的结果一致),最后是官方安装器的固定位置。
function candidates({ env = process.env, home = os.homedir(), platform = process.platform } = {}) {
  const win = platform === 'win32';
  const join = win ? path.win32.join : path.posix.join;
  const names = win ? WIN_NAMES : ['claude'];
  const out = [];
  for (const dir of splitPath(env, win)) for (const n of names) out.push({ path: join(dir, n), via: 'path' });
  out.push({ path: join(localBinDir(home, win), win ? 'claude.exe' : 'claude'), via: 'localbin' });
  return out;
}

// 同步版:给不怕卡的地方用(启动自动化接口时挑命令、测试)。
function findClaude(opts = {}) {
  const exists = opts.exists || lstatSync;
  try {
    for (const c of candidates(opts)) {
      if (exists(c.path)) return { found: true, path: c.path, via: c.via };
    }
  } catch { return { found: true, via: 'unsure' }; }    // 查的过程出了岔子 = 拿不准 = 按装了算
  return { found: false };
}

// 异步 + 限时版:给界面用。到点还没查完(多半是 PATH 里有连不上的网络路径)就当成「装了」。
async function findClaudeAsync(opts = {}) {
  const exists = opts.exists || lstatAsync;
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  let stop = false, timer = null;
  const scan = (async () => {
    for (const c of candidates(opts)) {
      if (stop) break;
      let ok = false;
      try { ok = await exists(c.path); } catch { return { found: true, via: 'unsure' }; }   // 拿不准 = 按装了算
      if (ok) return { found: true, path: c.path, via: c.via };
    }
    return { found: false };
  })();
  const late = new Promise((res) => { timer = setTimeout(() => { stop = true; res({ found: true, via: 'timeout' }); }, timeoutMs); });
  try { return await Promise.race([scan, late]); } finally { clearTimeout(timer); }
}

// 界面问「装没装」时主进程的回答。只有**明确查完、确实没有**才说没装;出任何岔子都说装了。
async function checkForUi(opts = {}) {
  try {
    const r = await findClaudeAsync(opts);
    const missing = !!r && r.found === false;
    // unsure = 没查明白(超时 / 出岔子)才放行的。界面这次放行,但下次开会话还要再查,不把「装了」记死。
    const unsure = !missing && (!r || r.via === 'timeout' || r.via === 'unsure');
    return { found: !missing, unsure, installCmd: missing ? installCommand(opts.platform) : '', doc: INSTALL_DOC };
  } catch { return { found: true, unsure: true, installCmd: '', doc: INSTALL_DOC }; }
}

// 开终端用的环境:官方安装目录里有 claude、而 PATH 里没有这个目录时,把它**追加到末尾**。
// 追加而不是插到前面:已经能找到 claude 的电脑,找到的还是原来那一个,行为不变。
function withClaudeOnPath(env, { home = os.homedir(), exists = lstatSync, platform = process.platform } = {}) {
  const out = Object.assign({}, env);
  try {
    const win = platform === 'win32';
    const dir = localBinDir(home, win);
    const exe = (win ? path.win32.join : path.posix.join)(dir, win ? 'claude.exe' : 'claude');
    if (!exists(exe)) return out;
    if (splitPath(out, win).some(d => norm(d) === norm(dir))) return out;
    const k = pathKey(out);
    const cur = String(out[k] || '');
    const sep = win ? ';' : ':';
    out[k] = cur ? cur.replace(new RegExp('\\' + sep + '+$'), '') + sep + dir : dir;
  } catch {}
  return out;
}

// 自动化接口(小九)用哪个命令去调 claude。原来的规矩一条不动:
//   先用 %APPDATA%\npm\claude.cmd;没有就用 'claude.cmd' 让系统按 PATH 找。
// 只多一条兜底:PATH 里压根没有 claude.cmd、而官方安装目录里有 claude.exe(= 只用官方安装器装的电脑)时,用那个 exe。
//
// ⚠️ 必须异步 + 限时。它在启动时被调;第一版是同步扫 PATH,PATH 里有连不上的网络路径、
//    又没装 npm 版的老用户每次启动窗口会冻住二十多秒(验收实测 24 秒)—— 和上面界面检测是同一个坑。
// 拿不准(超时 / 出岔子)一律回 'claude.cmd',也就是老行为。
async function agentClaudeCmd({ env = process.env, home = os.homedir(), exists = lstatAsync, platform = process.platform, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  let stop = false, timer = null;
  const pick = (async () => {
    const appdata = env.APPDATA || env.AppData || env.appdata;
    if (appdata) { const npm = path.win32.join(appdata, 'npm', 'claude.cmd'); if (await exists(npm)) return npm; }
    for (const d of splitPath(env, platform === 'win32')) {
      if (stop) return 'claude.cmd';
      if (await exists(path.win32.join(d, 'claude.cmd'))) return 'claude.cmd';
    }
    const exe = path.win32.join(localBinDir(home, true), 'claude.exe');
    if (!stop && await exists(exe)) return exe;
    return 'claude.cmd';
  })().catch(() => 'claude.cmd');
  const late = new Promise((res) => { timer = setTimeout(() => { stop = true; res('claude.cmd'); }, timeoutMs); });
  try { return await Promise.race([pick, late]); } catch { return 'claude.cmd'; } finally { clearTimeout(timer); }
}

// 内嵌终端里跑的一键安装:官方安装命令 → 装上了就直接用完整路径启动(不依赖 PATH)→ 进入 Claude 自己的首次登录引导。
// 官方那一句放在**单独的 powershell 进程**里跑:官方脚本失败时是 `exit 1`,和我们写在同一个进程里的话,
// 它一退出整个终端就没了,后面那句中文说明根本轮不到(验收时实测过)。
// 只有 Windows 有;别的平台返回空串,界面上就不显示「一键安装」。
function installCommand(platform = process.platform) {
  if (platform !== 'win32') return '';
  return [
    "Write-Host '正在用官方安装程序安装 Claude Code ...'",
    "powershell.exe -NoProfile -ExecutionPolicy Bypass -Command '" + INSTALL_PS + "'",
    "$c = Join-Path $env:USERPROFILE '.local\\bin\\claude.exe'",
    "if (Test-Path $c) { Write-Host ''; Write-Host '装好了,正在启动 Claude Code。第一次会让你在浏览器里登录 Claude 账号。' -ForegroundColor Green; & $c }"
    + " else { Write-Host ''; Write-Host '没装上(上面如果有英文报错,那是官方安装程序说的原因)。最常见的是这台电脑连不上 claude.ai 或 downloads.claude.ai —— 检查网络或代理后,关掉这个标签再点一次「一键安装」。' -ForegroundColor Yellow }"
  ].join('; ');
}

module.exports = { findClaude, findClaudeAsync, checkForUi, withClaudeOnPath, agentClaudeCmd, installCommand, candidates, pathKey, INSTALL_DOC, INSTALL_PS, DEFAULT_TIMEOUT_MS };

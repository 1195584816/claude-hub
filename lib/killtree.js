// 带超时地跑一个外部命令,超时就把**整棵进程树**杀掉。
//
// 为什么不用 exec / execFile 自带的 timeout:那个只杀直接子进程。我们跑的是 powershell.exe / cmd.exe,
// 真正干活的 claude.exe 是它的子进程 —— Windows 上杀了外壳,claude 照样在后台跑:
//   · MCP 页「重新检测」每超时一次就多留一个 claude;
//   · 检查点回退超时后 claude 还在改文件,我们却以为「没回退」(见 test/killtree.test.js)。
// 所以自己计时,到点用 taskkill /T /F 连子带孙一起结束。
const { exec, execFile } = require('child_process');

// then:taskkill 跑完(不管成没成)之后调用。外壳必须留到 taskkill 跑完再杀 —— 先杀外壳,/T 就找不到它下面的子孙了
function killTree(pid, then) {
  const next = () => { if (then) { try { then(); } catch {} } };
  if (!pid) return next();
  if (process.platform === 'win32') {
    try { execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, next); } catch { next(); }
  } else {
    try { process.kill(pid, 'SIGKILL'); } catch {}
    next();
  }
}

// 杀进程之后最多再等这么久:taskkill 没杀掉(权限不够、进程卡在内核里)时 exec 的回调可能永远不来,
// 不兜底的话调用方的 Promise 就永远不返回(2026-11-18 上游审查)。到点就按「超时、没杀掉」返回。
const KILL_GRACE_MS = 5000;

// args 为 null 时 file 是整条命令(走 shell,同 exec);否则同 execFile。
// 返回 { err, stdout, stderr, timedOut, canceled, killFailed } —— 不 reject。stdin 立刻关掉(claude 不会干等管道输入)。
// opts.cancel:传一个空对象进来,这里会给它挂上 kill(),调用方随时可以把整棵进程树结束掉(结果标 canceled)。
function runKillable(file, args, opts, timeoutMs, graceMs = KILL_GRACE_MS) {
  return new Promise(resolve => {
    let timedOut = false, canceled = false, timer = null, grace = null, settled = false, out = '', errOut = '';
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(grace);
      resolve(Object.assign({ canceled }, r));
    };
    const done = (err, stdout, stderr) => finish({ err, stdout: String(stdout || ''), stderr: String(stderr || ''), timedOut, killFailed: false });
    const o = Object.assign({ windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, opts || {});
    const cancel = o.cancel && typeof o.cancel === 'object' ? o.cancel : null;
    delete o.timeout; delete o.cancel;
    const c = args ? execFile(file, args, o, done) : exec(file, o, done);
    // 兜底返回时也带上已经收到的输出
    try { c.stdout.on('data', d => { out += d; }); c.stderr.on('data', d => { errOut += d; }); } catch {}
    const stop = () => {
      if (settled || grace) return;
      killTree(c.pid, () => { try { c.kill('SIGKILL'); } catch {} });
      grace = setTimeout(() => finish({ err: new Error('没能结束进程'), stdout: out, stderr: errOut, timedOut, killFailed: true }), graceMs);
    };
    if (timeoutMs > 0) timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    if (cancel) cancel.kill = () => { if (!settled) { canceled = true; clearTimeout(timer); stop(); } };
    try { c.stdin.end(); } catch {}
  });
}

module.exports = { killTree, runKillable, KILL_GRACE_MS };

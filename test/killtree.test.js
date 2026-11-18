// 超时要连孙子进程一起杀(lib/killtree.js)。
//
// 背景:2026-11-17 自查发现,MCP 检测和检查点回退都是 exec/execFile 自带的 timeout ——
// 它只杀直接子进程(powershell.exe / cmd.exe),真正干活的 claude.exe 是孙子,Windows 上照样活着:
//   · 「重新检测」超时一次就在后台多留一个 claude;
//   · 回退超时后 claude 还在改文件,我们却当成「没回退」把备份删了。
// 这里用一个「外壳 → node 孙子(写下自己的 pid 然后睡 60 秒)」的结构真跑一遍,看超时后孙子还在不在。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runKillable } = require('../lib/killtree');

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function grandchild() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-kt-'));
  const js = path.join(d, 'sleeper.js');
  const pidFile = path.join(d, 'pid');
  fs.writeFileSync(js, `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 60000);`);
  return { js, pidFile };
}
async function waitPid(pidFile) {
  for (let i = 0; i < 100 && !fs.existsSync(pidFile); i++) await sleep(50);
  return +fs.readFileSync(pidFile, 'utf8');
}

test('超时:经 shell(cmd.exe)起的孙子进程也被杀掉,结果标成 timedOut', async () => {
  const { js, pidFile } = grandchild();
  const p = runKillable(`node "${js}"`, null, {}, 1500);
  const pid = await waitPid(pidFile);
  assert.ok(alive(pid), '孙子进程应该先起来了');
  const r = await p;
  assert.equal(r.timedOut, true);
  for (let i = 0; i < 40 && alive(pid); i++) await sleep(100);
  assert.equal(alive(pid), false, '超时后孙子进程还活着');
});

test('超时:经 powershell.exe 起的孙子进程也被杀掉', { skip: process.platform !== 'win32' }, async () => {
  const { js, pidFile } = grandchild();
  const p = runKillable('powershell.exe', ['-NoProfile', '-Command', `node '${js}'`], {}, 3000);
  const pid = await waitPid(pidFile);
  const r = await p;
  assert.equal(r.timedOut, true);
  for (let i = 0; i < 40 && alive(pid); i++) await sleep(100);
  assert.equal(alive(pid), false, '超时后孙子进程还活着');
});

// 2026-11-18 上游审查:taskkill 没杀掉时 exec 的回调可能永远不来,Promise 就永远不返回。
// 换一个假的 child_process 重新加载 killtree:子进程永远不结束,taskkill 报错 —— 到点也要返回 killFailed。
test('超时后杀不掉:兜底时间到了也返回(killFailed),不会永远挂着', async () => {
  const cp = require('node:child_process');
  const { EventEmitter } = require('node:events');
  const orig = { exec: cp.exec, execFile: cp.execFile };
  const fake = () => { const c = new EventEmitter(); c.pid = 4242; c.stdin = { end() {} }; c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.kill = () => false; setTimeout(() => c.stdout.emit('data', '半截输出'), 5); return c; };
  let taskkill = 0;
  cp.exec = () => fake();
  cp.execFile = (file, args, o, cb) => { if (/taskkill/i.test(file)) { taskkill++; setTimeout(() => cb(new Error('拒绝访问')), 5); return fake(); } return fake(); };
  const key = require.resolve('../lib/killtree');
  delete require.cache[key];
  try {
    const kt = require('../lib/killtree');
    const t0 = Date.now();
    const r = await kt.runKillable('whatever', null, {}, 50, 200);
    assert.equal(r.timedOut, true);
    assert.equal(r.killFailed, true);
    assert.equal(r.stdout, '半截输出');
    assert.ok(Date.now() - t0 < 2000);
    if (process.platform === 'win32') assert.equal(taskkill, 1);
  } finally {
    cp.exec = orig.exec; cp.execFile = orig.execFile;
    delete require.cache[key];
  }
});

test('不超时:正常拿到输出和退出码,stdin 已关(不会干等)', async () => {
  const r = await runKillable(process.execPath, ['-e', 'process.stdin.on("end",()=>{console.log("got-eof");process.exit(3)});process.stdin.resume()'], {}, 10000);
  assert.equal(r.timedOut, false);
  assert.match(r.stdout, /got-eof/);
  assert.equal(r.err && r.err.code, 3);
});

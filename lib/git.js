// Git 状态与改动查看(只读,不做任何写操作)
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

function run(args, cwd, timeout) {
  return new Promise(resolve => {
    execFile('git', args, { cwd, timeout: timeout || 15000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, stdout) => resolve(err ? '' : String(stdout || '')));
  });
}

function isRepo(cwd) {
  try { return fs.existsSync(path.join(cwd, '.git')); } catch { return false; }
}

async function status(cwd) {
  if (!cwd || !isRepo(cwd)) return { repo: false };
  const [branchRaw, statRaw, aheadRaw, lastRaw] = await Promise.all([
    run(['rev-parse', '--abbrev-ref', 'HEAD'], cwd),
    run(['status', '--porcelain=v1', '-uall'], cwd),
    run(['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'], cwd),
    run(['log', '-1', '--pretty=%h|%s|%cr|%an'], cwd)
  ]);
  const files = statRaw.split('\n').filter(Boolean).map(l => {
    const code = l.slice(0, 2);
    const file = l.slice(3).trim();
    let kind = '改';
    if (code.includes('?')) kind = '新';
    else if (code.includes('A')) kind = '增';
    else if (code.includes('D')) kind = '删';
    else if (code.includes('R')) kind = '改名';
    return { code: code.trim(), kind, file, staged: code[0] !== ' ' && code[0] !== '?' };
  });
  let ahead = 0, behind = 0;
  const am = aheadRaw.trim().split(/\s+/);
  if (am.length === 2) { ahead = +am[0] || 0; behind = +am[1] || 0; }
  const lp = lastRaw.trim().split('|');
  return {
    repo: true,
    branch: branchRaw.trim(),
    files,
    ahead, behind,
    last: lp.length >= 3 ? { hash: lp[0], subject: lp[1], when: lp[2], author: lp[3] || '' } : null
  };
}

// 单文件 diff(未暂存优先,其次已暂存,再次未跟踪文件直接读内容)
async function diff(cwd, file) {
  if (!cwd || !isRepo(cwd)) return '';
  let d = await run(['diff', '--no-color', '--', file], cwd);
  if (!d.trim()) d = await run(['diff', '--no-color', '--cached', '--', file], cwd);
  if (!d.trim()) {
    try {
      const fp = path.join(cwd, file);
      const st = fs.statSync(fp);
      if (st.size < 512 * 1024) {
        const body = fs.readFileSync(fp, 'utf8').split('\n').slice(0, 400).map(l => '+' + l).join('\n');
        d = '新文件(未跟踪)\n' + body;
      } else d = '(新文件,超过 512KB 不预览)';
    } catch {}
  }
  return d.slice(0, 400000);
}

module.exports = { status, diff, isRepo };

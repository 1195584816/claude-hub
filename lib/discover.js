// 首次启动自动发现项目:扫 ~/.claude/projects,从会话记录里读真实 cwd 反推项目目录
// 让新用户装上即用,不需要手写任何配置
const fs = require('fs');
const path = require('path');
const P = require('./paths');

function readCwd(fp) {
  try {
    const st = fs.statSync(fp);
    const fd = fs.openSync(fp, 'r');
    const buf = Buffer.alloc(Math.min(st.size, 32768));
    fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const m = buf.toString('utf8').match(/"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    return m ? m[1].replace(/\\\\/g, '\\') : '';
  } catch { return ''; }
}

function discover() {
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(P.CLAUDE_PROJECTS, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); } catch { return out; }
  for (const slug of dirs) {
    const dir = path.join(P.CLAUDE_PROJECTS, slug);
    let files = [];
    try { files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')); } catch { continue; }
    if (!files.length) continue;
    // 取最新的会话读 cwd(最能代表项目当前位置)
    const newest = files.map(f => {
      let m = 0; try { m = fs.statSync(path.join(dir, f)).mtimeMs; } catch {}
      return { f, m };
    }).sort((a, b) => b.m - a.m)[0];
    const cwd = readCwd(path.join(dir, newest.f));
    if (!cwd || !fs.existsSync(cwd)) continue;
    const name = path.basename(cwd) || cwd;
    out.push({
      name, short: name, role: '', line: '未分组',
      path: cwd, memSlug: slug, sessSlug: slug, mainSession: '',
      stack: [], deploy: '', highlights: [], pitfalls: []
    });
  }
  // 同一个目录只留一个;按最近活跃排序
  const seen = new Set();
  return out.filter(p => {
    const k = p.path.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// 没有项目清单时自动生成一份
function ensureProjects() {
  try {
    if (fs.existsSync(P.PROJECTS_JSON)) {
      const cur = JSON.parse(fs.readFileSync(P.PROJECTS_JSON, 'utf8'));
      if (Array.isArray(cur) && cur.length) return { created: false, count: cur.length };
    }
  } catch {}
  const list = discover();
  try { fs.writeFileSync(P.PROJECTS_JSON, JSON.stringify(list, null, 2), 'utf8'); } catch {}
  return { created: true, count: list.length };
}

// 找出"磁盘上有会话但清单里没有"的项目,供界面提示用户一键添加
function findNew(existing) {
  const have = new Set((existing || []).map(p => String(p.path).toLowerCase()));
  return discover().filter(p => !have.has(p.path.toLowerCase())).map(p => {
    // 补上会话数和最近活跃，界面才判断得出哪些值得导、哪些是垃圾(比如临时目录)
    let n = 0, last = 0;
    try {
      const dir = path.join(P.CLAUDE_PROJECTS, p.sessSlug);
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.jsonl')) continue;
        n++;
        try { const m = fs.statSync(path.join(dir, f)).mtimeMs; if (m > last) last = m; } catch {}
      }
    } catch {}
    return Object.assign({}, p, { sessCount: n, lastActive: last });
  }).sort((a, b) => b.lastActive - a.lastActive);
}

module.exports = { discover, ensureProjects, findNew };

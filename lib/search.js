// 全局会话搜索:跨所有项目搜对话内容(逐文件流式扫描,不整包读入)
const fs = require('fs');
const path = require('path');
// 会话标题的算法只能有一份 —— 直接用数据层那个,别在这儿抄一遍免得漂
const data = require('./data');

function stripTags(t) {
  return String(t || '')
    .replace(/<[a-z-]+>[\s\S]*?<\/[a-z-]+>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function textOf(e) {
  const c = e && e.message && e.message.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter(x => x && x.type === 'text').map(x => x.text).join(' ');
  return '';
}

/**
 * @param {Array} projects  [{short, path, sessSlug}]
 * @param {string} q        关键词(空格分隔=同时包含)
 * @param {object} opt      { role:'all'|'user'|'assistant', limit:80, projPath:'' 只搜某项目 }
 */
function searchSessions(projects, q, opt) {
  opt = opt || {};
  const limit = opt.limit || 80;
  const terms = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return { hits: [], scanned: 0, took: 0 };
  const t0 = Date.now();
  const PROJ = require('./paths').CLAUDE_PROJECTS;
  const hits = [];
  let scanned = 0;

  const targets = opt.projPath ? projects.filter(p => p.path === opt.projPath) : projects;
  const seenDir = new Set();
  // 他在界面上改过的会话名(整个搜索只读一次)
  let custom = {};
  try { custom = data.loadTitles(); } catch {}

  outer:
  for (const p of targets) {
    const dir = path.join(PROJ, p.sessSlug || '');
    if (seenDir.has(dir)) continue;
    seenDir.add(dir);
    let files = [];
    try { files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      const fp = path.join(dir, f);
      let st; try { st = fs.statSync(fp); } catch { continue; }
      scanned++;
      let raw = '';
      try {
        // 大文件只读尾部 20MB(近期内容),避免卡顿
        const take = Math.min(st.size, 20 * 1024 * 1024);
        const fd = fs.openSync(fp, 'r');
        const buf = Buffer.alloc(take);
        fs.readSync(fd, buf, 0, take, st.size - take);
        fs.closeSync(fd);
        raw = buf.toString('utf8');
      } catch { continue; }
      if (!terms.every(t => raw.toLowerCase().includes(t))) continue;   // 整文件粗筛,快
      // 结果按会话聚合要显示会话名/时间。只有粗筛过了才算 —— 没命中的文件
      // 一个字节都不多读,sessionTitle 那 64KB 只花在真的要显示的会话上。
      const sid = f.replace(/\.jsonl$/, '');
      let sess = '';
      try { sess = custom[sid] || data.sessionTitle(fp); } catch {}
      // 命中文件才逐行精扫
      const lines = raw.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const ln = lines[i];
        if (!ln || ln[0] !== '{') continue;
        const low = ln.toLowerCase();
        if (!terms.every(t => low.includes(t))) continue;
        let e; try { e = JSON.parse(ln); } catch { continue; }
        if (!e || (e.type !== 'user' && e.type !== 'assistant')) continue;
        if (e.isSidechain || e.isMeta) continue;
        if (opt.role && opt.role !== 'all' && e.type !== opt.role) continue;
        const txt = stripTags(textOf(e));
        if (!txt) continue;
        const lowTxt = txt.toLowerCase();
        const at = lowTxt.indexOf(terms[0]);
        if (at < 0) continue;
        hits.push({
          proj: p.short, projPath: p.path, sessSlug: p.sessSlug, sid,
          sess, mtime: st.mtimeMs,                 // 按会话聚合时显示会话名和最近活动
          role: e.type, ts: e.timestamp || '',
          snippet: txt.slice(Math.max(0, at - 60), at + 140)
        });
        if (hits.length >= limit) break outer;
      }
    }
  }
  return { hits, scanned, took: Date.now() - t0 };
}

module.exports = { searchSessions };

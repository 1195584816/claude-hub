// 检查点:读 Claude Code 自己的文件检查点(/rewind 用的同一份数据),给「检查点」页用。
//
// 数据都是 Claude Code 写的,这里**只读**:
//   ~/.claude/projects/<slug>/<会话>.jsonl 里
//     file-history-snapshot  每条用户提问一条:messageId = 那条提问,trackedFileBackups = 那一刻已被跟踪的文件
//                            (isSnapshotUpdate 的是对同一条的补充)
//     file-history-delta     这一轮第一次被改动的文件:snapshotMessageId 指向这一轮的提问,
//                            backup 是改动前的样子(backupFileName 为 null = 那时这个文件还不存在)
//   ~/.claude/file-history/<会话>/<backupFileName>  备份的文件内容
// 所以「提问 M 那一刻文件 F 的样子」= 快照 M 里的 F,没有就看 delta 里 snapshotMessageId=M 的 F。
//
// 真正回退文件用官方命令:claude --resume <会话> --rewind-files <提问 id>(和 /rewind 同一套逻辑)。
// 它在非交互方式下要 CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING=1 才肯做 —— 只给这一条命令设,不改任何配置。
// 回退前把会被动到的文件当前的样子先存一份到 APP_DATA(rewind-backups),撤销就是把这份放回去。
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { runKillable } = require('./killtree');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG = /^[A-Za-z0-9-]+$/;
const BACKUP_NAME = /^[0-9a-f]+@v\d+$/i;

// 提问的文字:字符串,或 [{type:'text',text}] —— 只有工具结果的那种不是提问
function promptText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  if (content.some(c => c && c.type === 'tool_result')) return null;
  const t = content.filter(c => c && c.type === 'text').map(c => c.text || '').join('\n');
  return t || null;
}

// 给人看的提问:斜杠命令显示成命令本身,去掉系统塞进来的标签
function displayPrompt(t) {
  const s = String(t || '');
  const cmd = s.match(/<command-name>([^<]*)<\/command-name>/);
  if (cmd) { const args = s.match(/<command-args>([^<]*)<\/command-args>/); return (cmd[1] + ' ' + (args ? args[1] : '')).trim(); }
  return s.replace(/<[a-z-]+>[\s\S]*?<\/[a-z-]+>/g, '').replace(/\s+/g, ' ').trim();
}

// 解析一份会话记录 → 按出现顺序的快照,每个带上「那一刻各文件的样子」
function parse(text) {
  const prompts = new Map();
  const order = [];                 // 快照 messageId,按第一次出现的顺序
  const snaps = new Map();          // messageId → { at, files: { key: { backup, dir } } }
  const deltas = new Map();         // snapshotMessageId → { key: { backup, dir } }(同一文件只认第一条)
  let cwd = '';
  let odd = 0;                      // 看不懂的检查点数据条数:有就说明我们推出来的文件清单可能不全,回退要拒绝
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    let x; try { x = JSON.parse(line); } catch { if (/"file-history-/.test(line)) odd++; continue; }
    if (!x || typeof x !== 'object') continue;
    if (!cwd && typeof x.cwd === 'string') cwd = x.cwd;
    if (x.type === 'user' && x.uuid && x.message && !x.isMeta) {
      const t = promptText(x.message.content);
      if (t !== null) prompts.set(x.uuid, { text: t, at: Date.parse(x.timestamp) || 0 });
    } else if (x.type === 'file-history-snapshot' && x.snapshot && x.messageId) {
      const files = {};
      for (const [k, v] of Object.entries(x.snapshot.trackedFileBackups || {})) {
        if (v && typeof v === 'object') files[k] = { backup: v.backupFileName || null, dir: v.realParentDir || '' };
        else odd++;
      }
      const old = snaps.get(x.messageId);
      if (old) Object.assign(old.files, files);
      else { order.push(x.messageId); snaps.set(x.messageId, { at: Date.parse(x.snapshot.timestamp) || 0, files }); }
    } else if (x.type === 'file-history-delta' && x.snapshotMessageId && x.trackingPath && x.backup) {
      const d = deltas.get(x.snapshotMessageId) || {};
      if (!(x.trackingPath in d)) d[x.trackingPath] = { backup: x.backup.backupFileName || null, dir: x.backup.realParentDir || '' };
      deltas.set(x.snapshotMessageId, d);
    } else if (typeof x.type === 'string' && x.type.startsWith('file-history-')) {
      odd++;                        // 认识的类型但缺字段,或者 Claude Code 新加的类型
    }
  }
  const list = order.map(id => {
    const s = snaps.get(id);
    const files = Object.assign({}, deltas.get(id) || {}, s.files);
    const p = prompts.get(id);
    return { id, at: s.at || (p && p.at) || 0, prompt: p ? displayPrompt(p.text) : null, files };
  });
  return { cwd, snaps: list, odd };
}

// realParentDir 是文件自己所在的目录(不是相对路径的起点):有它就用「它 + 文件名」,没有才拿会话 cwd 拼相对路径
const absOf = (key, f, cwd) => path.isAbsolute(key) ? key : (f.dir ? path.join(f.dir, path.basename(key)) : path.join(cwd || '', key));

// 每个检查点这一轮改了哪些文件:这一刻的样子 vs 下一个快照的样子(最后一个跟磁盘比,要读文件,由调用方给 readSame)
// 返回只含「提问」的检查点(/exit 之类没有提问的快照只当下一刻的参照)
async function checkpoints(parsed, readSame) {
  const { snaps, cwd } = parsed;
  const out = [];
  for (let i = 0; i < snaps.length; i++) {
    const s = snaps[i];
    if (s.prompt === null) continue;
    const next = snaps[i + 1] || null;
    const files = [];
    for (const [key, f] of Object.entries(s.files)) {
      const abs = absOf(key, f, cwd);
      let after;   // 'same' | 'changed' | 'deleted'
      if (next && key in next.files) {
        const nb = next.files[key].backup;
        after = nb === f.backup ? 'same' : (nb === null ? 'deleted' : 'changed');
      } else if (next) {
        after = 'same';                                // 下一刻没记:这一轮没动过它
      } else {
        after = await readSame(f.backup, abs);         // 最后一个:和磁盘上现在的比
      }
      if (after === 'same') continue;
      const kind = f.backup === null ? '新' : (after === 'deleted' ? '删' : '改');
      files.push({ key, abs, kind });
    }
    out.push({ id: s.id, at: s.at, prompt: s.prompt, files });
  }
  return out;
}

// ---------- 带磁盘的部分 ----------
function sessionPaths(projectsDir, claudeHome, slug, sid) {
  if (!SLUG.test(String(slug || '')) || !UUID.test(String(sid || ''))) throw new Error('会话参数不对');
  return { jsonl: path.join(projectsDir, slug, sid + '.jsonl'), histDir: path.join(claudeHome, 'file-history', sid) };
}

// 只有「文件不存在」(ENOENT / ENOTDIR)才返回 null。被锁(EBUSY / EPERM)、没权限等一律抛出 ——
// 以前全当成「不存在」,被锁的文件在备份清单里记成 existed:false,撤销时就被 unlink 掉了(2026-11-18 上游审查)。
async function readMaybe(p) {
  try { return await fs.promises.readFile(p); }
  catch (e) { if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return null; throw e; }
}

// 解析结果按「文件 + 大小 + 修改时间」缓存:会话记录动辄几 MB,点一个文件看改动、回退时都要用,不该每次重读重解析。
// 会话还在写(大小/时间变了)就重新解析;只留最近几份。
const parsedCache = new Map();
async function loadParsed(jsonl) {
  const st = await fs.promises.stat(jsonl);
  const key = jsonl + '|' + st.size + '|' + st.mtimeMs;
  const hit = parsedCache.get(key);
  if (hit) return hit;
  const parsed = parse(await fs.promises.readFile(jsonl, 'utf8'));
  for (const k of parsedCache.keys()) if (k.startsWith(jsonl + '|')) parsedCache.delete(k);
  parsedCache.set(key, parsed);
  while (parsedCache.size > 4) parsedCache.delete(parsedCache.keys().next().value);
  return parsed;
}
// 会话的工作目录(回退要在那里跑 claude)
async function sessionCwd(projectsDir, claudeHome, slug, sid) {
  return (await loadParsed(sessionPaths(projectsDir, claudeHome, slug, sid).jsonl)).cwd;
}

async function list(projectsDir, claudeHome, slug, sid) {
  const sp = sessionPaths(projectsDir, claudeHome, slug, sid);
  const parsed = await loadParsed(sp.jsonl);
  // 只是给人看「这一轮改了什么」:读不了(被锁等)就当改过,照样列出来
  const readSame = async (backup, abs) => {
    try {
      const now = await readMaybe(abs);
      if (backup === null) return now === null ? 'same' : 'changed';
      if (now === null) return 'deleted';
      if (!BACKUP_NAME.test(backup)) return 'changed';
      const old = await readMaybe(path.join(sp.histDir, backup));
      return old && old.equals(now) ? 'same' : 'changed';
    } catch { return 'changed'; }
  };
  return { cwd: parsed.cwd, items: (await checkpoints(parsed, readSame)).reverse() };   // 新的在上
}

// 某个检查点里某个文件这一轮的改动(统一 diff 文本)
async function diff(projectsDir, claudeHome, slug, sid, id, key, tmpDir) {
  const sp = sessionPaths(projectsDir, claudeHome, slug, sid);
  const parsed = await loadParsed(sp.jsonl);
  const i = parsed.snaps.findIndex(s => s.id === id);
  if (i < 0 || !(key in parsed.snaps[i].files)) return '(找不到这个检查点或文件)';
  const f = parsed.snaps[i].files[key];
  const next = parsed.snaps[i + 1];
  const side = (backup) => (backup !== null && BACKUP_NAME.test(backup)) ? path.join(sp.histDir, backup) : null;
  const before = side(f.backup);
  let after;
  if (next && key in next.files) after = side(next.files[key].backup);
  else after = absOf(key, f, parsed.cwd);                         // 最后一个:磁盘上现在的
  await fs.promises.mkdir(tmpDir, { recursive: true });
  const empty = path.join(tmpDir, 'empty');
  await fs.promises.writeFile(empty, '');
  const exists = async (p) => { try { await fs.promises.access(p); return true; } catch { return false; } };
  const a = before && await exists(before) ? before : empty;
  const b = after && await exists(after) ? after : empty;
  return gitDiffNoIndex(a, b);
}

function gitDiffNoIndex(a, b) {
  return new Promise(resolve => {
    // 有差异时 git 返回 1,不算错;只有拿不到输出才说明
    // --no-ext-diff / --no-textconv:不跑用户 git 配置里的外部对比程序和转换器(那是任意命令)
    execFile('git', ['diff', '--no-index', '--no-color', '--no-ext-diff', '--no-textconv', '--', a, b], { timeout: 15000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      const out = String(stdout || '');
      if (!out && err && err.code !== 1) return resolve('(没能生成对比:需要能运行 git)');
      // 去掉头上那几行临时路径,只留改动块
      resolve(out.split('\n').filter((l, i) => !(i < 5 && /^(diff --git|index |--- |\+\+\+ |new file|deleted file)/.test(l))).join('\n').slice(0, 400000) || '(内容相同)');
    });
  });
}

// 这个会话跟踪过的所有文件(绝对路径,不分大小写去重)。位置推不出来的(相对路径、又没有目录和 cwd)直接抛错
function trackedFiles(parsed, fromIndex = 0) {
  const seen = new Map();
  for (let j = fromIndex; j < parsed.snaps.length; j++) for (const [key, f] of Object.entries(parsed.snaps[j].files)) {
    if (!path.isAbsolute(key) && !f.dir && !parsed.cwd) throw new Error('有文件的位置推不出来:' + key);
    const abs = absOf(key, f, parsed.cwd);
    if (!seen.has(abs.toLowerCase())) seen.set(abs.toLowerCase(), { abs, backup: f.backup });
  }
  return seen;
}

// 回退到提问 id 之前,会动哪些文件。拿不准就拒绝(ok:false + msg),不照常回退:
//   · 找不到这个检查点、会话记录里有看不懂的检查点数据(推出来的清单可能不全)
//   · 文件位置推不出来、Claude Code 的备份名看不懂或备份文件不见了
//   · 读文件出错(被锁、没权限) —— 不知道它现在是什么样
// 每个文件「那一刻的样子」= 从这个快照往后第一次出现它时记的备份(中间没被 Claude 改过,所以一样)。
// 返回 changes:[{ path, kind: '改' | '删' | '恢复' }],和磁盘上现在一样的不列。
async function planFromParsed(parsed, histDir, id) {
  const i = parsed.snaps.findIndex(s => s.id === id);
  if (i < 0) return { ok: false, msg: '会话记录里找不到这条提问的检查点' };
  if (parsed.odd) return { ok: false, msg: `会话记录里有 ${parsed.odd} 条看不懂的检查点数据,推不准会动哪些文件,不回退` };
  let targets;
  try { targets = trackedFiles(parsed, i); } catch (e) { return { ok: false, msg: e.message }; }
  const changes = [];
  try {
    for (const t of targets.values()) {
      if (t.backup !== null && !BACKUP_NAME.test(t.backup)) return { ok: false, msg: '检查点里的备份名看不懂:' + t.backup };
      const now = await readMaybe(t.abs);
      if (t.backup === null) { if (now !== null) changes.push({ path: t.abs, kind: '删' }); continue; }
      const old = await readMaybe(path.join(histDir, t.backup));
      if (old === null) return { ok: false, msg: 'Claude Code 的备份文件不见了:' + t.backup };
      if (now === null) changes.push({ path: t.abs, kind: '恢复' });
      else if (!old.equals(now)) changes.push({ path: t.abs, kind: '改' });
    }
  } catch (e) { return { ok: false, msg: '读不了文件(' + (e.code || e.message) + '):' + (e.path || '') }; }
  return { ok: true, changes };
}
async function planRewind(projectsDir, claudeHome, slug, sid, id) {
  const sp = sessionPaths(projectsDir, claudeHome, slug, sid);
  return planFromParsed(await loadParsed(sp.jsonl), sp.histDir, id);
}

// 回退前把这个会话跟踪过的所有文件现在的样子存一份,返回备份 id。
// 任何一个文件读不了(被锁等)就整个放弃、删掉这份不完整的备份、抛错 —— 调用方就不回退了。
async function backupBeforeRewind(projectsDir, claudeHome, slug, sid, id, backupRoot, now = Date.now()) {
  const sp = sessionPaths(projectsDir, claudeHome, slug, sid);
  const parsed = await loadParsed(sp.jsonl);
  const seen = trackedFiles(parsed);
  const bid = String(now);
  const dir = path.join(backupRoot, bid);
  await fs.promises.mkdir(dir, { recursive: true });
  try {
    const files = [];
    let n = 0;
    for (const { abs } of seen.values()) {
      let buf;
      try { buf = await readMaybe(abs); }
      catch (e) { throw new Error('备份时读不了 ' + abs + '(' + (e.code || e.message) + '),这次不回退'); }
      if (buf === null) { files.push({ path: abs, existed: false }); continue; }
      const stored = String(n++);
      await fs.promises.writeFile(path.join(dir, stored), buf);
      files.push({ path: abs, existed: true, stored });
    }
    await fs.promises.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ slug, sid, id, at: now, files }, null, 2));
  } catch (e) {
    try { await fs.promises.rm(dir, { recursive: true, force: true }); } catch {}
    throw e;
  }
  return bid;
}

// 文件内容的指纹;不存在 = null;读不了就抛错
const crypto = require('crypto');
async function fingerprint(p) {
  const buf = await readMaybe(p);
  return buf === null ? null : crypto.createHash('sha256').update(buf).digest('hex');
}

// 回退刚做完时,记下每个文件「回退后的样子」(指纹),全部记成了才标 recorded。撤销时靠它认出「回退之后又被人改过」的文件。
// extra 里放会话记录当时的修改时间(撤销时判断会话是不是又在跑了)。任何一个文件读不了就抛错,不标 recorded。
async function recordAfterRewind(backupRoot, bid, extra = {}) {
  const mf = path.join(backupRoot, checkBid(bid), 'manifest.json');
  const m = JSON.parse(await fs.promises.readFile(mf, 'utf8'));
  for (const f of m.files || []) if (f && typeof f.path === 'string') f.after = await fingerprint(f.path);
  Object.assign(m, extra, { recorded: true });
  await fs.promises.writeFile(mf, JSON.stringify(m, null, 2));
}
function checkBid(bid) { if (!/^\d+$/.test(String(bid || ''))) throw new Error('备份 id 不对'); return String(bid); }
async function readManifest(backupRoot, bid) {
  return JSON.parse(await fs.promises.readFile(path.join(backupRoot, checkBid(bid), 'manifest.json'), 'utf8'));
}

// 撤销回退:按备份放回去(备份时不存在的文件,现在有了就删掉)。
//   · 回退之后又被改过的文件(现在的指纹 ≠ 回退刚做完时的)、现在读不了的文件,一律不碰 → skipped
//   · 没记成「回退后的样子」(recorded 不是 true)时**一律不删**:不知道那个文件是回退弄出来的还是人后来建的 → kept
//   · 每个文件单独 try:一个写不进去(被编辑器独占、杀毒正在扫)计入 skipped,接着做别的,最后照常返回。
//     以前中途抛错停下,界面只说「撤销失败」,前面的文件其实已经被覆盖了(2026-11-18 上游审查)
//   · 没记成时也认不出「回退之后被人改过」的文件:放回前先把现在的内容另存到 <备份>/pre-undo-<时间>/(列在 saved 里),
//     另存不了就不覆盖(skipped)。和备份一模一样的不用另存
async function undoRewind(backupRoot, bid, now = Date.now()) {
  const dir = path.join(backupRoot, checkBid(bid));
  const m = await readManifest(backupRoot, bid);
  const recorded = m.recorded === true;
  let restored = 0, removed = 0;
  const skipped = [], kept = [], saved = [];
  const saveDir = path.join(dir, 'pre-undo-' + Math.floor(Number(now) || 0));
  for (const f of m.files || []) {
    if (!f || typeof f.path !== 'string' || !path.isAbsolute(f.path)) continue;
    if (recorded) {
      let cur;
      try { cur = await fingerprint(f.path); } catch { skipped.push(f.path); continue; }
      if (cur !== f.after) { skipped.push(f.path); continue; }
    }
    if (f.existed && /^\d+$/.test(String(f.stored))) {
      try {
        const want = await fs.promises.readFile(path.join(dir, String(f.stored)));
        if (!recorded) {
          const cur = await readMaybe(f.path);              // 读不了(不是不存在)会抛 → skipped,不覆盖
          if (cur && cur.equals(want)) { restored++; continue; }
          if (cur) {
            const copy = path.join(saveDir, String(f.stored));
            await fs.promises.mkdir(saveDir, { recursive: true });
            await fs.promises.writeFile(copy, cur);
            saved.push({ path: f.path, copy });
          }
        }
        await fs.promises.mkdir(path.dirname(f.path), { recursive: true });
        await fs.promises.writeFile(f.path, want);
        restored++;
      } catch { skipped.push(f.path); }
    } else if (!f.existed) {
      if (!recorded) { kept.push(f.path); continue; }
      try { await fs.promises.unlink(f.path); removed++; }
      catch (e) { if (!(e && e.code === 'ENOENT')) skipped.push(f.path); }
    }
  }
  return { restored, removed, skipped, kept, saved };
}

// 回退备份只增不删会越攒越多:超过 keepDays 天的删掉,但最新的 keepLatest 份不管多旧都留着。
// 只认纯数字名字的目录(我们自己建的),别的不碰。
async function cleanBackups(backupRoot, now = Date.now(), { keepDays = 14, keepLatest = 10 } = {}) {
  let names;
  try { names = await fs.promises.readdir(backupRoot); } catch { return 0; }
  const ids = names.filter(n => /^\d+$/.test(n)).sort((a, b) => Number(b) - Number(a));
  let n = 0;
  for (const id of ids.slice(keepLatest)) {
    if (now - Number(id) <= keepDays * 86400e3) continue;
    try { await fs.promises.rm(path.join(backupRoot, id), { recursive: true, force: true }); n++; } catch {}
  }
  return n;
}

// 官方回退。env 由调用方给(已补 PATH、已去掉 CLAUDE_CODE 标记);这里只加开关。
function rewindCommand(sid, id) {
  if (!UUID.test(String(sid || '')) || !UUID.test(String(id || ''))) throw new Error('参数不对');
  return `claude --resume "${sid}" --rewind-files "${id}"`;
}
// 回退的结果分三种,决定那份「回退前备份」要不要留:
//   ok        claude 说 rewound —— 留着,给「撤销」用
//   untouched claude 在动手**之前**就拒绝了,只认官方这几句原话(没开开关 / 没这个检查点 / 不是提问 / 没这个会话)
//             —— 文件肯定没动,备份可以删
//   unsure    其余一切:超时、中途报错、找不到 claude、输出看不懂 —— 文件可能已经回退了一部分,备份必须留着(拿不准就放行)
// 以前还认 ENOENT / command not found:回退做到一半报「某文件 ENOENT」也会被判成没动、删掉备份(2026-11-18 上游审查)
const UNTOUCHED = /File rewinding is not enabled|No file checkpoint found|is not a user message in this session|No conversation found/i;
function classifyRewind({ err, stdout, stderr, timedOut, killFailed }) {
  const out = (String(stdout || '') + String(stderr || '')).trim();
  const msg = out || (err ? String(err.message || err) : '');
  if (timedOut) return { state: 'unsure', msg: (killFailed ? '等了 60 秒 claude 还没回退完,而且没能结束它,它可能还在后台改文件。' : '等了 60 秒 claude 还没回退完,已强行结束。') + (out ? '\n' + out : '') };
  if (!err && /rewound/i.test(out)) return { state: 'ok', msg };
  if (UNTOUCHED.test(msg)) return { state: 'untouched', msg };
  return { state: 'unsure', msg };
}
async function runRewind(sid, id, cwd, env, timeoutMs = 60000) {
  const cmd = rewindCommand(sid, id);
  // 超时要连 claude.exe 一起杀(只杀 cmd.exe 的话 claude 还在后台改文件)
  const r = await runKillable(cmd, null, { cwd, env: Object.assign({}, env, { CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: '1' }) }, timeoutMs);
  return classifyRewind(r);
}

// 会话是不是在总控里开着。metas:主进程 termMeta 里每个终端的 { projPath, sid }。
// 新开的会话标签要等 Claude Code 写出会话记录才认得出会话号,认出之前 sid 是空的 —— 这时只知道它在哪个目录,
// 同一个项目(slug 对得上)里有这样的标签,就拿不准它是不是要回退的这个会话,一律拒绝。
// slugOf 由调用方传(data.slugOf,和 Claude Code 的目录名算法是同一份);slug 为空(老备份)只按会话号认。
// 比较不分大小写:Windows 路径不分大小写,同一个项目打开时盘符 / 目录名大小写可能和会话目录名不一样(2026-11-18 上游审查)。
function openInHubMsg(metas, slug, sid, slugOf) {
  const list = (metas || []).filter(Boolean);
  const lc = (x) => String(x || '').toLowerCase();
  if (list.some(m => m.sid && lc(m.sid) === lc(sid))) return '这个会话正在总控里开着。先关掉它的终端标签,或者在会话里用 /rewind。';
  if (slug && list.some(m => !m.sid && m.projPath && lc(slugOf(String(m.projPath).replace(/[\\/]+$/, ''))) === lc(slug))) {
    return '这个项目里有新开的会话标签还没认出是哪个会话(可能就是这一个)。先关掉它的终端标签再回退。';
  }
  return '';
}

// 会话是不是还在跑:会话记录在 activeMs 内有写入。since 给了的话,只有比它新的写入才算(回退本身也会写一笔)
// 窗口 5 分钟:外部终端里 Claude 跑一个几分钟的命令时,会话记录可能很久不写(2026-11-18 上游审查,原来是 1 分钟)。
// 即便如此也只是猜,外部终端里开着、但很久没动的会话认不出来 —— 确认框里写明了。
const BUSY_MS = 5 * 60e3;
async function sessionBusy(projectsDir, claudeHome, slug, sid, now = Date.now(), activeMs = BUSY_MS, since = 0) {
  const st = await fs.promises.stat(sessionPaths(projectsDir, claudeHome, slug, sid).jsonl);
  return st.mtimeMs > since && now - st.mtimeMs < activeMs;
}
async function sessionMtime(projectsDir, claudeHome, slug, sid) {
  return (await fs.promises.stat(sessionPaths(projectsDir, claudeHome, slug, sid).jsonl)).mtimeMs;
}

module.exports = { parse, checkpoints, displayPrompt, promptText, list, diff, planFromParsed, planRewind, backupBeforeRewind, recordAfterRewind, readManifest, sessionCwd, openInHubMsg, sessionBusy, sessionMtime, BUSY_MS, undoRewind, cleanBackups, rewindCommand, runRewind, classifyRewind, UUID };

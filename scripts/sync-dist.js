#!/usr/bin/env node
/**
 * 把源码刷进解包的打包版,让「改完重启」真的能看到变化。
 *
 * 为什么需要这个:三月日常跑的是 dist2\ClaudeHub-win32-x64\ClaudeHub.exe,
 * 它读 resources\app\ 下自己那一份副本。2026-10-20 就栽在这儿 ——
 * 源码改了两批、重启了好几次,程序里一点动静没有,因为副本停在 10-17。
 *
 *   node scripts/sync-dist.js          真的刷过去
 *   node scripts/sync-dist.js --check  只报告差异,一个字节都不动
 *
 * 规则:逐字节比对,不同才覆盖;只认 app 真正会加载的那几类文件。
 * 复制完当场重读校验,不靠"cp 没报错"就宣布成功。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CHECK = process.argv.includes('--check');

// app 会加载的:根目录的 .js/.html,外加 lib/ 和 hooks/ 整个目录。
// 刻意不做"整棵树镜像"—— 那会把 node_modules、dist、缓存、备份一起糊过去。
const ROOT_EXT = ['.js', '.html'];
// package.json 也得跟上 —— Electron 启动时读它的 main / version,
// 不同步的话以后改版本号又是一次"改了没反应"
const ROOT_FILES = ['package.json'];
// build/ 放窗口图标(icon.ico)。main.js 用绝对路径引它,解包版不同步的话
// BrowserWindow 拿不到图标又不报错 —— 又是一次"改了没反应"。
// docs/ 放手册:hub:guide 读 docs\使用说明.md,hub:openDoc 开 docs\guide.html。
// 2026-11-09 发现解包版那份还停在 7 月 26 日(源码 19KB、副本 6KB),
// 改了手册界面上纹丝不动 —— 同一个坑第二次,所以把 docs 也纳进来。
const DIRS = ['lib', 'hooks', 'build', 'docs'];
const SKIP_NAMES = new Set(['node_modules', '.git', 'test', 'scripts', 'pastes', 'design-ref', 'docs', '.github']);

function targets() {
  // 只看项目根下一层的 dist*,不递归 —— 打包目录里还套着好几层旧打包,别去碰
  const out = [];
  for (const d of fs.readdirSync(ROOT)) {
    if (!d.startsWith('dist')) continue;
    const app = path.join(ROOT, d, 'ClaudeHub-win32-x64', 'resources', 'app');
    if (fs.existsSync(path.join(app, 'package.json'))) out.push(app);
  }
  return out;
}

function sourceFiles() {
  const list = [];
  for (const f of fs.readdirSync(ROOT)) {
    if (SKIP_NAMES.has(f) || f.startsWith('dist')) continue;
    const p = path.join(ROOT, f);
    let st; try { st = fs.statSync(p); } catch { continue; }
    if (st.isFile() && (ROOT_EXT.includes(path.extname(f)) || ROOT_FILES.includes(f))) list.push(f);
  }
  for (const d of DIRS) {
    const dir = path.join(ROOT, d);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      let st; try { st = fs.statSync(p); } catch { continue; }
      // 备份文件不许跟进解包版:上面那句注释说了「不把备份糊过去」,但这个循环原来照收不误,
      // 2026-11-10 把 lib/usage.js.bak-r4 真的同步进了 app 目录(第四轮改完才发现)。
      if (/[.]bak/i.test(f)) continue;   // .bak / .bak-r4 / .bak2 / .bak-20261110 全算
      if (st.isFile()) list.push(d + '/' + f);
    }
  }
  return list.sort();
}

function same(a, b) {
  try {
    const x = fs.statSync(a), y = fs.statSync(b);
    if (x.size !== y.size) return false;
    return fs.readFileSync(a).equals(fs.readFileSync(b));
  } catch { return false; }
}

const apps = targets();
if (!apps.length) {
  console.log('没找到解包的打包版(dist*/ClaudeHub-win32-x64/resources/app),不用同步。');
  process.exit(0);
}

const files = sourceFiles();
let changed = 0, added = 0, failed = 0, skipped = 0;

for (const app of apps) {
  console.log('目标: ' + app);
  for (const rel of files) {
    const s = path.join(ROOT, rel);
    const d = path.join(app, rel.replace(/\//g, path.sep));
    const exists = fs.existsSync(d);
    if (exists && same(s, d)) { skipped++; continue; }
    const tag = exists ? '改' : '新';
    if (CHECK) {
      console.log('  [' + tag + '] ' + rel + (exists ? '  (' + fs.statSync(d).size + ' -> ' + fs.statSync(s).size + ' 字节)' : ''));
      exists ? changed++ : added++;
      continue;
    }
    try {
      fs.mkdirSync(path.dirname(d), { recursive: true });
      fs.copyFileSync(s, d);
      if (!same(s, d)) throw new Error('复制后内容对不上');
      console.log('  ✅ [' + tag + '] ' + rel + '  (' + fs.statSync(d).size + ' 字节)');
      exists ? changed++ : added++;
    } catch (e) {
      console.log('  ❌ ' + rel + '  ' + e.message + '(文件被占用?先关掉 ClaudeHub)');
      failed++;
    }
  }
}

console.log('');
console.log((CHECK ? '[只检查] ' : '') + '改 ' + changed + ' 个,新增 ' + added + ' 个,已一致 ' + skipped + ' 个' + (failed ? ',失败 ' + failed + ' 个' : ''));
if (failed) process.exit(1);
if (!CHECK && (changed || added)) console.log('→ 重启 ClaudeHub 才会生效。');
if (CHECK && (changed || added)) process.exit(1);   // 给 CI / 钩子用:有差异就非 0

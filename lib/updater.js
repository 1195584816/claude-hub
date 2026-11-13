// 自动更新:GitHub Releases 为准,国内自动挑可用的免费加速镜像(全程零费用)
// 策略:先并发探测各源的 latest.yml,谁先通用谁;都不通就静默跳过,不打扰用户
const https = require('https');
const http = require('http');

const REPO = { owner: 'Teminuosi', name: 'claude-hub' };

// 免费公共加速前缀(拼在 GitHub 地址前面)。挂了就自动跳过,不影响主流程
const MIRRORS = [
  '',                                   // GitHub 原始
  'https://ghfast.top/',
  'https://gh-proxy.com/',
  'https://ghproxy.net/'
];

function head(url, timeout) {
  return new Promise(resolve => {
    let done = false;
    const finish = v => { if (!done) { done = true; resolve(v); } };
    try {
      const lib = url.startsWith('http:') ? http : https;
      const req = lib.get(url, { timeout: timeout || 6000, headers: { 'User-Agent': 'ClaudeHub' } }, res => {
        // 3xx 也算通(加速站常用跳转)
        finish(res.statusCode >= 200 && res.statusCode < 400);
        res.destroy();
      });
      req.on('error', () => finish(false));
      req.on('timeout', () => { req.destroy(); finish(false); });
    } catch { finish(false); }
    setTimeout(() => finish(false), (timeout || 6000) + 500);
  });
}

// 选出当前网络下可用且最快的下载前缀
async function pickMirror() {
  const base = `https://github.com/${REPO.owner}/${REPO.name}/releases/latest`;
  const results = await Promise.all(MIRRORS.map(async m => {
    const t0 = Date.now();
    const ok = await head(m ? m + base : base);
    return { m, ok, ms: Date.now() - t0 };
  }));
  const good = results.filter(r => r.ok).sort((a, b) => a.ms - b.ms);
  return good.length ? good[0] : null;
}

// 接 electron-updater(打包后才有意义;开发态直接跳过)
function setup(win, log) {
  let autoUpdater;
  try { ({ autoUpdater } = require('electron-updater')); } catch { return { ok: false, msg: 'electron-updater 未安装' }; }
  autoUpdater.autoDownload = false;          // 先问用户
  autoUpdater.autoInstallOnAppQuit = true;
  const send = (ch, payload) => { try { if (win && !win.isDestroyed()) win.webContents.send(ch, payload); } catch {} };

  autoUpdater.on('update-available', i => send('upd:available', { version: i.version, notes: String(i.releaseNotes || '').slice(0, 2000) }));
  autoUpdater.on('update-not-available', () => send('upd:none', {}));
  autoUpdater.on('download-progress', p => send('upd:progress', { percent: Math.round(p.percent), speed: Math.round(p.bytesPerSecond / 1024) }));
  autoUpdater.on('update-downloaded', i => send('upd:ready', { version: i.version }));
  autoUpdater.on('error', e => send('upd:error', { msg: String(e && e.message || e).slice(0, 300) }));

  return {
    ok: true,
    async check() {
      const pick = await pickMirror();
      if (!pick) { send('upd:error', { msg: '连不上更新源(GitHub 与镜像都不通)' }); return { ok: false }; }
      if (pick.m) {
        // 走加速前缀:把 feed 指向镜像后的 releases 地址
        autoUpdater.setFeedURL({
          provider: 'generic',
          url: `${pick.m}https://github.com/${REPO.owner}/${REPO.name}/releases/latest/download`
        });
      }
      if (log) log('更新源:' + (pick.m || 'GitHub 原始') + ' (' + pick.ms + 'ms)');
      try { await autoUpdater.checkForUpdates(); return { ok: true, mirror: pick.m || 'github' }; }
      catch (e) { return { ok: false, msg: String(e) }; }
    },
    download() { try { autoUpdater.downloadUpdate(); } catch {} },
    installNow() { try { autoUpdater.quitAndInstall(false, true); } catch {} }
  };
}

module.exports = { setup, pickMirror, MIRRORS, REPO };

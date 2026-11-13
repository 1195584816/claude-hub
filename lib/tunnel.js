// 公网穿透:cloudflared 免费 Quick Tunnel(不需要账号,给一个临时 https 域名)
// 注意:开了就等于把手机控制台暴露到公网 —— 只靠配对令牌保护,界面上必须给足警示
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const P = require('./paths');

const BIN = path.join(P.APP_DATA, 'cloudflared.exe');
const DL = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe';
const MIRRORS = ['', 'https://ghfast.top/', 'https://gh-proxy.com/', 'https://ghproxy.net/'];

let proc = null, publicUrl = '', lastErr = '';

function found() {
  return new Promise(resolve => {
    if (fs.existsSync(BIN)) return resolve(BIN);
    execFile('cloudflared', ['--version'], { timeout: 8000, windowsHide: true }, err => resolve(err ? '' : 'cloudflared'));
  });
}

function download(onProgress) {
  return new Promise(resolve => {
    let idx = 0;
    const tryOne = () => {
      if (idx >= MIRRORS.length) return resolve({ ok: false, msg: '所有下载源都不通' });
      const url = MIRRORS[idx++] + DL;
      const tmp = BIN + '.part';
      const file = fs.createWriteStream(tmp);
      const get = (u, depth) => {
        if (depth > 5) { file.close(); tryOne(); return; }
        https.get(u, { timeout: 20000, headers: { 'User-Agent': 'ClaudeHub' } }, res => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { res.destroy(); return get(res.headers.location, depth + 1); }
          if (res.statusCode !== 200) { res.destroy(); file.close(); try { fs.unlinkSync(tmp); } catch {} return tryOne(); }
          const total = +res.headers['content-length'] || 0;
          let got = 0;
          res.on('data', c => { got += c.length; if (onProgress && total) onProgress(Math.round(got / total * 100)); });
          res.pipe(file);
          file.on('finish', () => {
            file.close(() => {
              try { fs.renameSync(tmp, BIN); resolve({ ok: true, path: BIN }); }
              catch (e) { resolve({ ok: false, msg: String(e) }); }
            });
          });
        }).on('error', () => { file.close(); try { fs.unlinkSync(tmp); } catch {} tryOne(); });
      };
      get(url, 0);
    };
    tryOne();
  });
}

function start(port) {
  return new Promise(async resolve => {
    stop();
    const bin = await found();
    if (!bin) return resolve({ ok: false, need: 'download', msg: '未安装 cloudflared' });
    publicUrl = ''; lastErr = '';
    try {
      proc = spawn(bin, ['tunnel', '--url', 'http://127.0.0.1:' + port, '--no-autoupdate'], { windowsHide: true });
    } catch (e) { return resolve({ ok: false, msg: String(e) }); }
    const onOut = buf => {
      const s = String(buf);
      const m = s.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
      if (m && !publicUrl) { publicUrl = m[0]; resolve({ ok: true, url: publicUrl }); }
      if (/error|failed/i.test(s)) lastErr = s.slice(0, 200);
    };
    proc.stdout.on('data', onOut);
    proc.stderr.on('data', onOut);
    proc.on('exit', () => { proc = null; });
    setTimeout(() => { if (!publicUrl) resolve({ ok: false, msg: lastErr || '隧道启动超时' }); }, 45000);
  });
}
function stop() {
  if (proc) { try { proc.kill(); } catch {} proc = null; }
  publicUrl = '';
}
function status() { return { running: !!proc, url: publicUrl, installed: fs.existsSync(BIN) }; }

module.exports = { start, stop, status, download, found };

// 独立转发器:被 Stop 钩子调用,把完成记录推到企业微信/飞书/Server酱
// 不依赖客户端安装位置,只需 node。用法:node notify-forward.js --file <rec.json> --config <notify-config.json>
const fs = require('fs');
const https = require('https');

function arg(name) { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : ''; }

function post(url, body, contentType) {
  return new Promise(resolve => {
    try {
      const u = new URL(url);
      const payload = typeof body === 'string' ? body : JSON.stringify(body);
      const req = https.request({
        hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
        headers: { 'Content-Type': contentType || 'application/json' }, timeout: 8000
      }, res => { res.resume(); res.on('end', () => resolve(res.statusCode === 200)); });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.write(payload);
      req.end();
    } catch { resolve(false); }
  });
}

(async () => {
  const recFile = arg('--file'), cfgFile = arg('--config');
  let rec, cfg;
  try { rec = JSON.parse(fs.readFileSync(recFile, 'utf8')); } catch { process.exit(0); }
  try { cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8')); } catch { process.exit(0); }

  let text = `✅ Claude 任务完成 [${rec.proj}] ${rec.ts || ''}`;
  if (rec.task) text += `\n指令:${rec.task}`;
  if (rec.result) text += `\n答复:${rec.result}`;
  if (rec.tok) text += `\n本轮约 ${rec.tok} tokens`;

  const jobs = [];
  if (cfg.wecom && cfg.wecom.enabled && cfg.wecom.key)
    jobs.push(post('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=' + encodeURIComponent(cfg.wecom.key), { msgtype: 'text', text: { content: text } }));
  if (cfg.feishu && cfg.feishu.enabled && cfg.feishu.webhook)
    jobs.push(post(cfg.feishu.webhook, { msg_type: 'text', content: { text } }));
  if (cfg.serverchan && cfg.serverchan.enabled && cfg.serverchan.sendkey)
    jobs.push(post('https://sctapi.ftqq.com/' + encodeURIComponent(cfg.serverchan.sendkey) + '.send',
      'title=' + encodeURIComponent(`Claude完成[${rec.proj}]`) + '&desp=' + encodeURIComponent(text),
      'application/x-www-form-urlencoded'));

  await Promise.all(jobs);
  try { fs.unlinkSync(recFile); } catch {}
  process.exit(0);
})();


const S = { token: localStorage.getItem('hubtoken') || '', view: 'list', term: null, readonly: false, es: null, buf: '' };
const $ = h => { document.getElementById('app').innerHTML = h; };
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
async function api(p, opt) {
  const url = p + (p.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(S.token);
  const r = await fetch(url, opt || {});
  if (r.status === 401) { S.token = ''; localStorage.removeItem('hubtoken'); renderPair(); throw new Error('unauth'); }
  return r.json();
}
function post(p, body) { return api(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }

// ===== 配对 =====
function renderPair(msg) {
  $(`<div class="pair">
    <h2>连接到电脑</h2>
    <p>在电脑的 Claude 总控里打开<br><b>⚙️ 设置 → 手机控制台</b>,把 6 位配对码填进来</p>
    <input id="code" inputmode="numeric" maxlength="6" placeholder="······">
    <button onclick="doPair()">连接</button>
    <div class="msg">${esc(msg || '')}</div>
  </div>`);
  setTimeout(() => document.getElementById('code').focus(), 200);
}
async function doPair() {
  const code = document.getElementById('code').value.trim();
  if (code.length !== 6) return renderPair('请输入 6 位数字');
  try {
    const r = await fetch('/api/pair', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, name: (navigator.userAgent.match(/(iPhone|iPad|Android|Windows|Mac)/) || ['手机'])[0] })
    }).then(x => x.json());
    if (!r.ok) return renderPair(r.msg || '连接失败');
    S.token = r.token; S.readonly = r.readonly;
    localStorage.setItem('hubtoken', r.token);
    loadList();
  } catch (e) { renderPair('连不上电脑,检查是否同一 WiFi'); }
}

// ===== 列表 =====
async function loadList() {
  S.view = 'list';
  if (S.es) { S.es.close(); S.es = null; }
  let d;
  try { d = await api('/api/state'); } catch { return; }
  S.readonly = d.readonly;
  const runs = d.terminals || [], projs = d.projects || [], feed = d.feed || [];
  $(`<div class="top"><b>Claude 总控</b><span class="sub">${S.readonly ? '只读模式 · ' : ''}${runs.length} 个在跑</span></div>
  <div class="body">
    ${runs.length ? `<div class="sec">进行中</div>` + runs.map(t => `
      <div class="card" onclick="openTerm('${t.id}','${esc(t.title).replace(/'/g, "\\'")}')">
        <div class="row"><i class="dot run"></i><span class="t1">${esc(t.title)}</span></div>
        <div class="t2">${esc(t.proj)}</div>
      </div>`).join('') : ''}
    ${feed.length ? `<div class="sec">最近完成</div>` + feed.slice(0, 6).map(f => `
      <div class="card">
        <div class="row"><i class="dot done"></i><span class="t1">${esc(f.proj)}</span><span class="badge">${esc(String(f.ts).slice(11, 16))}</span></div>
        <div class="t2">${esc(String(f.task || '').slice(0, 60))}</div>
      </div>`).join('') : ''}
    <div class="sec">全部项目</div>
    ${projs.map(p => `
      <div class="card" onclick="openProj('${esc(p.path).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}','${esc(p.short).replace(/'/g, "\\'")}')">
        <div class="row"><i class="dot ${p.status}"></i><span class="t1">${esc(p.short)}</span>
        ${p.unread ? `<span class="badge red">${p.unread}</span>` : ''}</div>
        <div class="t2">${p.sessCount} 个会话${p.running ? ' · ' + p.running + ' 在跑' : ''}</div>
      </div>`).join('') || '<div class="empty">还没有项目</div>'}
  </div>`);
}
async function openProj(projPath, short) {
  if (S.readonly) return alert('只读模式不能开会话');
  const r = await post('/api/open', { projPath, short });
  if (r && r.id) openTerm(r.id, short);
}

// ===== 终端 =====
function openTerm(id, title) {
  S.view = 'term'; S.term = id; S.buf = '';
  $(`<div class="top"><span class="back" onclick="loadList()">‹ 返回</span><b style="font-size:14px">${esc(title || '会话')}</b></div>
  <div class="term" id="out"></div>
  ${S.readonly ? '' : `<div class="bar">
    <span class="key y" onclick="send('y\\r')">y 同意</span>
    <span class="key n" onclick="send('n\\r')">n 拒绝</span>
    <span class="key" onclick="send('\\r')">回车</span>
    <span class="key" onclick="send('\\x1b')">Esc</span>
    <span class="key" onclick="send('继续\\r')">继续</span>
    <span class="key" onclick="send('\\x03')">Ctrl+C</span>
    <span class="key" onclick="send('\\x1b[A')">↑</span>
  </div>
  <div class="inbar">
    <input id="cmd" placeholder="输入指令…" onkeydown="if(event.key==='Enter')sendInput()">
    <button onclick="sendInput()">发送</button>
  </div>`)}`);
  if (S.es) S.es.close();
  S.es = new EventSource('/api/stream?token=' + encodeURIComponent(S.token) + '&id=' + encodeURIComponent(id));
  S.es.addEventListener('hist', e => { const m = JSON.parse(e.data); S.buf = m.data || ''; paint(); });
  S.es.addEventListener('data', e => { const m = JSON.parse(e.data); if (m.id === S.term) { S.buf += m.data; if (S.buf.length > 60000) S.buf = S.buf.slice(-40000); paint(); } });
}
// 去掉 ANSI 控制序列,手机上只看纯文本
function clean(s) {
  return String(s)
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\x1b[()][0-9A-B]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
}
function paint() {
  const el = document.getElementById('out');
  if (!el) return;
  const near = el.scrollTop + el.clientHeight > el.scrollHeight - 80;
  el.textContent = clean(S.buf).split('\n').slice(-400).join('\n');
  if (near) el.scrollTop = el.scrollHeight;
}
function send(d) { if (S.term) post('/api/input', { id: S.term, data: d }); }
function sendInput() {
  const i = document.getElementById('cmd');
  if (!i || !i.value.trim()) return;
  send(i.value + '\r');
  i.value = '';
}
// 启动
if (S.token) loadList().catch(() => renderPair()); else renderPair();
setInterval(() => { if (S.view === 'list' && S.token) loadList().catch(() => {}); }, 8000);

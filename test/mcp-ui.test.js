// 2026-11-17 自查:MCP 页按行号记「选中的服务器」,重新读配置后行序一变,「移除」就删到别的服务器。
// 改成按 范围+名称 记。截 index.html 的真源码测。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const between = (a, b) => { const i = SRC.indexOf(a), j = SRC.indexOf(b, i); assert.ok(i >= 0 && j > i, '找不到标记 ' + a); return SRC.slice(i, j); };

// 2026-11-18 上游审查:打开 MCP 页 / 换项目会自动跑 claude mcp list,它会把每个服务器真的启动一遍 ——
// 包括陌生仓库 .mcp.json 里没批准过的。改成只在用户点「检测连接」时跑,换项目时结束正在跑的那次。
test('MCP 页只在用户点「检测连接」时才跑 claude mcp list', () => {
  const calls = SRC.match(/(?<!function )mcCheck\(\)/g) || [];
  // 只剩按钮上的那一处
  assert.equal(calls.length, 1, '除了按钮,不许有别处调用 mcCheck():' + calls.length);
  assert.match(SRC, /<button class="btn ghost sm" onclick="mcCheck\(\)"/);
  assert.doesNotMatch(between('async function mcOpen()', 'async function mcLoad()'), /mcCheck/);
  const pick = between('function mcPickProj(', '// 表格的一行');
  assert.doesNotMatch(pick, /mcCheck/);
  assert.match(pick, /hub\.mcpStatusCancel\(\)/);
});

test('MCP 选中的服务器按「范围 + 名称」认,行序变了也还是它', () => {
  const env = { mcSel: null, mcRows: [] };
  const f = new Function('env', `with (env) { ${between('// <mc-sel>', '// </mc-sel>')}; return { mcKey, mcSelRow }; }`)(env);
  env.mcRows = [{ scope: 'user', name: 'a' }, { scope: 'local', name: 'b' }, { scope: 'project', name: 'b' }];
  env.mcSel = f.mcKey(env.mcRows[1]);
  env.mcRows = [{ scope: 'project', name: 'b' }, { scope: 'user', name: 'new' }, { scope: 'local', name: 'b' }, { scope: 'user', name: 'a' }];
  assert.deepEqual(f.mcSelRow(), { scope: 'local', name: 'b' });   // 同名不同范围不会认错
  env.mcRows = env.mcRows.filter(r => r.scope !== 'local');
  assert.equal(f.mcSelRow(), null);                                  // 被删了就是没选中,不会落到别的行上
  const body = between('async function mcRemove()', 'async function mcImport()');
  assert.match(body, /const s = mcSelRow\(\);/);
  assert.doesNotMatch(SRC, /mcRows\[mcSel\]/);
});

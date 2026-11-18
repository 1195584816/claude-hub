// 2026-11-17 自查:「在会话里用 /rewind」原来固定等 2.5 秒就往终端里填字:Claude 起得慢就被启动画面吞掉,
// 停在「信任这个文件夹吗」时还会落进对话框。改成看屏幕判断(ckPromptState)。截 index.html 的真源码测。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const between = (a, b) => { const i = SRC.indexOf(a), j = SRC.indexOf(b, i); assert.ok(i >= 0 && j > i, '找不到标记 ' + a); return SRC.slice(i, j); };

// 2026-11-18 上游审查:回退要先列出会动的文件让人确认(不再是「点两下」);会话在总控里开着就不许点;撤销也有忙碌判断
test('回退:先要清单(ckptPlan)再确认,确认时把看过的清单交给主进程;会话开着时按钮不可点', () => {
  const rew = between('async function ckRewind()', 'async function ckRewindConfirm()');
  assert.match(rew, /hub\.ckptPlan\(/);
  assert.doesNotMatch(rew, /hub\.ckptRewind\(/);
  assert.match(rew, /ckOpenMsg\(termTabs, ckSid, pj\.path\)/);
  const conf = between('async function ckRewindConfirm()', 'async function ckUndoRewind()');
  assert.match(conf, /hub\.ckptRewind\(pj\.sessSlug, ckSid, it\.id, ckPlan\.changes\.map\(c => c\.path\)\)/);
  assert.match(between('function ckRenderMain()', 'function ckGit()'), /id="ckRewBtn" onclick="ckRewind\(\)" \$\{!open && !ckBusy/);
  assert.match(between('function ckPlanBar(', 'async function ckRewind()'), /ckPlan\.changes/);
  assert.match(between('async function ckUndoRewind()', '// <ck-prompt>'), /if \(!ckUndo \|\| ckBusy\) return;/);
  assert.doesNotMatch(SRC, /ckRewArm/);
});

const ckPromptState = new Function(between('// <ck-prompt>', '// </ck-prompt>') + '\nreturn ckPromptState;')();
test('看屏幕判断 Claude Code 能不能接输入', () => {
  // 真实画面片段(实测)
  assert.equal(ckPromptState([' ▐▛███▜▌   Claude Code v2.1.326', '', '❯ 从1数到80,每行一个数字', '']), 'ready');
  assert.equal(ckPromptState(['──────', '> ', '──────', '  ? for shortcuts']), 'ready');
  assert.equal(ckPromptState(['│ > Try "fix lint errors"', '']), 'ready');
  assert.equal(ckPromptState(['Do you trust the files in this folder?', '', '❯ 1. Yes, proceed', '  2. No, exit']), 'trust');
  assert.equal(ckPromptState(['Is this a project you created or one you trust? (Quick safety check) trust this folder', '❯ 1. Yes, I trust this folder']), 'trust');
  assert.equal(ckPromptState(['❯ 1. Yes', '  2. No']), 'wait');      // 选项菜单不是输入行
  assert.equal(ckPromptState(['', 'Resuming conversation…', '']), 'wait');
  assert.equal(ckPromptState([]), 'wait');
  const body = between('async function ckRewindInSession()', 'async function ckFork()');
  assert.doesNotMatch(body, /setTimeout\(r, 2500\)/);
  assert.match(body, /ckPromptState\(/);
});

// 2026-11-17 打包实测:新开的会话标签没认出会话号(sid 空)时,界面只按会话号比,开着照样弹出回退确认框。
// 同项目里有没认出会话号的标签就当开着;认领到会话号时要告诉主进程(主进程的 termMeta 靠它判断)。
const ckOpenMsg = new Function(between('// <ck-open>', '// </ck-open>') + '\nreturn ckOpenMsg;')();
test('会话开着的判断:会话号对上;同项目有没认出会话号的标签;别的情况不算', () => {
  const S = 'b4f1e144-9dbd-4b6f-9002-6a79401686f9', O = '00000000-0000-4000-8000-00000000dead';
  assert.match(ckOpenMsg([{ sid: S, projPath: 'D:\\x' }], S, 'C:\\proj'), /正在总控里开着/);
  assert.match(ckOpenMsg([{ sid: '', projPath: 'c:\\Proj\\' }], S, 'C:\\proj'), /还没认出是哪个会话/);
  assert.equal(ckOpenMsg([{ sid: O, projPath: 'C:\\proj' }], S, 'C:\\proj'), '');
  assert.equal(ckOpenMsg([{ sid: '', projPath: 'D:\\other' }], S, 'C:\\proj'), '');
  assert.equal(ckOpenMsg([{ sid: '', projPath: 'C:\\proj' }], '', 'C:\\proj'), '');
  assert.match(between('function ckRenderMain()', 'function ckGit()'), /const openMsg = ckOpenMsg\(termTabs, ckSid, pj && pj\.path\)/);
  // 两处认领会话号(bindNewSid 轮询、完成通知)都要告诉主进程
  assert.equal((SRC.match(/hub\.termBindSid\(t\.id, t\.sid\)/g) || []).length, 2);
});

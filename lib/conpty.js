// 内嵌终端要不要用 node-pty 自带的新版 ConPTY(conpty.dll + OpenConsole.exe)。
//
// 只在 Win10(内部版本号 < 22000)上用:Win10 自带的 ConPTY 太老,会吞掉滚出屏幕的行、把输入行里的中文画错位
// (实测见 test/conpty.test.js)。Win11 自带的够新,用不着换 —— 换了反而会让 Claude Code 进全屏模式、接管鼠标,
// 改变现有用户的滚轮、拖选即复制、右键复制、路径点击和手机端回放。
// 拿不准就放行:不是 Windows、版本号读不出来,一律按原来的行为(系统自带的)。
'use strict';

const WIN11_BUILD = 22000;

// release 是 os.release() 的结果,Windows 上形如 "10.0.19045"
function useBundledConpty(platform, release) {
  if (platform !== 'win32') return false;
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(release || ''));
  if (!m) return false;
  if (Number(m[1]) !== 10) return false;          // 不认识的大版本:不动
  const build = Number(m[3]);
  return build > 0 && build < WIN11_BUILD;
}

module.exports = { useBundledConpty, WIN11_BUILD };

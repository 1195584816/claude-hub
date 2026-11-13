// 外部通知转发 —— 这里只是薄壳。
//
// 真正的逻辑(文案、各通道传输、免打扰闸、补发队列)全在 hooks/claude-notify-hook.js。
// 为什么反过来依赖:钩子是 Claude Code 拉起的纯 node 进程,读不了 app.asar,
// 所以逻辑不能住在 lib/ 下。Electron 读 asar 内的文件没问题,于是由这边去 require 它。
// 这样界面转发和钩子转发用的是同一份文案,不可能再漂移。
const hook = require('../hooks/claude-notify-hook.js');

module.exports = {
  send: hook.sendAll,
  fmt: hook.fmt,
  loadCfg: hook.loadCfg,
  deepDefaults: hook.deepDefaults,
  DEFAULTS: hook.DEFAULTS,
  PATHS: hook.PATHS
};

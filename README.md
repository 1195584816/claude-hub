# Claude 总控 · ClaudeHub

> 给 Claude Code 重度用户的桌面驾驶舱:**项目 / 会话 / 记忆一屏掌控,内嵌真终端,任务完成主动通知你,还能算清每一分 token 花在哪。**

Claude Code 很强,但项目一多就散了:会话记在哪、哪个跑完了、这个月烧了多少额度、上次那个坑记在哪条记忆里——全靠脑子记。ClaudeHub 把这些收进一个窗口。

![截图占位:把主界面截图放到 docs/screenshot.png](docs/screenshot.png)

## 它能干什么

**看得见全局**
- 左栏所有项目,可分组、可拖动排序;状态灯一眼看出:🟢 正在跑 / 🔴 有完成没看 / ⚪ 空闲
- 每个项目的会话列表、记忆、CLAUDE.md、技能,全在一个界面里翻

**跑得动活**
- **内嵌真终端**:跑的就是真的 `claude` CLI,TUI、权限弹窗、斜杠命令原样都在
- 多标签 / 多会话并排分屏 / 专注模式(终端占满,两侧鼠标滑出)
- **Ctrl+V 直接贴图**:截图自动存盘并把路径填进输入框,回车就能让 Claude 看图
- 一键 worktree 隔离开会话;也能用 codex / gemini 打开同一项目

**算得清账**
- 每个会话、每个项目、全部项目的 token 累计,点开看**逐轮消耗明细**
- 近 30 天趋势图、CSV 导出
- 直读官方订阅额度(当前会话 / 本周 / Fable 各自百分比 + 重置时间)

**不会漏活**
- 任何会话干完:提示音 + 顶栏横幅 + 未读红点,点一下直达那条会话
- 可转发到**企业微信群机器人 / 飞书机器人 / Server酱(微信)**——出门也知道跑完没

**找得到东西**
- **Ctrl+F 全局搜索**:跨所有项目搜对话内容,支持"只搜我说的 / 只搜 Claude 说的"
- Git 状态常驻:分支、未提交改动数、红绿 diff 直接看

## 安装

到 [Releases](../../releases) 下载 `ClaudeHub-x.y.z-win-x64.exe` 双击安装。目前仅 Windows;macOS / Linux 欢迎 PR。

首次启动会**自动扫描 `~/.claude/projects`** 生成你的项目列表,不用手写任何配置。

### 完成通知需要一步手动配置

通知依赖 Claude Code 的 Stop 钩子。把 `hooks/claude-done-notify.ps1` 放到 `~/.claude/hooks/`,并在 `~/.claude/settings.json` 里加:

```json
{
  "hooks": {
    "Stop": [{ "hooks": [{
      "type": "command",
      "command": "powershell.exe -NoProfile -ExecutionPolicy Bypass -File %USERPROFILE%\\.claude\\hooks\\claude-done-notify.ps1",
      "timeout": 30
    }]}]
  }
}
```

## 自己构建

```bash
npm install
npm start                 # 开发运行
npx electron-builder --win   # 打安装包
```

## 数据放在哪 / 隐私

- 客户端自己的配置在 `%APPDATA%/claude-hub/`(项目清单、通知配置、用量缓存)
- 会话与记忆**只读你本机的 `~/.claude/`**,原样不动
- **不登录:没有任何遥测、不上传任何数据**,所有统计都在本地算
- **登录是可选的**,可以跳过,登不登录功能完全一样。登录只是让作者知道有多少人在用。
  登录后会发给作者账号服务器的只有这几样:**邮箱、客户端版本号、系统平台(如 win32)、登录次数、首次和最近使用时间**。
  会话内容、项目、记忆、用量统计一律不上传。登录状态存在 `%APPDATA%/claude-hub/auth.json`,退出登录即删除

## 和其它 Claude Code GUI 的区别

| | ClaudeHub | Opcode/Claudia | 官方桌面版 |
|---|---|---|---|
| 内嵌真终端 | ✅ | ✅ | ✅ |
| 本地 token 账本(逐轮/逐项目) | ✅ | 部分 | ❌ |
| 官方订阅额度显示 | ✅ | ❌ | ❌ |
| 完成通知转发(企微/飞书/微信) | ✅ | ❌ | ❌ |
| 跨项目记忆/技能浏览与编辑 | ✅ | 部分 | ❌ |
| 中文优先 | ✅ | ❌ | 部分 |
| 维护状态 | 活跃 | 已停更 | 官方 |

## 小九 / 外部代理本机控制 API

ClaudeHub内置仅监听`127.0.0.1`的机器控制API，可按项目和会话ID提交Claude任务、携带本机附件、查询状态与最终回复。默认使用`fork`模式继承历史但不占用GUI原会话，也不会覆盖终端里的未发送草稿。

完整接口与安全说明见：[docs/agent-api.md](docs/agent-api.md)。

## License

[AGPL-3.0](LICENSE)。个人和公司内部使用完全自由;若你基于它二次开发并对外提供服务或分发,需同样开源你的修改。商业授权可联系作者。

## 致谢

xterm.js · node-pty · Electron · MiSans

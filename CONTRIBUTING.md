# 参与开发

欢迎一起改。流程很简单:**在你自己的 fork 里拉分支改,改完提合并请求,我们审核通过后合进 `main`,由维护者发版。**

## 流程

1. 在 GitHub 上点 **Fork**,把仓库复制到你自己的账号下。
2. 克隆你的 fork,拉一个分支:

   ```bash
   git clone https://github.com/<你的用户名>/claude-hub.git
   cd claude-hub
   git remote add upstream https://github.com/Teminuosi/claude-hub.git
   git checkout -b fix/一句话说明
   ```

3. 改代码,跑测试(见下面)。
4. 推到你的 fork,在 GitHub 上向 `Teminuosi/claude-hub` 的 `main` 提合并请求(Pull Request)。
5. 自动测试会跑一遍;维护者审核,可能会提修改意见。
6. 通过后由维护者合并。**发版(改版本号、打标签、出安装包)只由维护者做**,合并请求里不要改版本号。

开工前先同步一下上游,免得冲突:

```bash
git fetch upstream
git rebase upstream/main
```

一个合并请求只做一件事。想做比较大的改动(新功能、改交互、动数据格式),**先开个 Issue 说一下想法**,对齐了再写,免得白做。

## 跑起来

需要 Windows、Node.js 22 或更新、已经装好的 Claude Code。

```bash
npm install
npm start
```

注意两点:

- **程序是单实例的**。如果你电脑上已经开着安装版的 ClaudeHub,先把它退掉,再 `npm start`。
- **开发运行用的是你的真实数据**:`%APPDATA%\claude-hub`(项目清单、通知配置、用量缓存)和 `~/.claude`(Claude Code 自己的会话和设置)。改到读写这些文件的代码时,先备份。

`.npmrc` 里配的是国内镜像;不在国内的话可以把那两行删掉(别提交这个改动)。

## 测试

```bash
npm test
```

只用 Node 自带的测试框架,不需要先 `npm install`。必须全绿才能提合并请求。

- **改了行为就要补测试。** 修 bug 的话,先写一条能复现它的测试,再修。
- 界面逻辑大多写在 `index.html` 里。要测的那一段用一对注释标记包起来(例如 `// <pure-unread-logic>` … `// </pure-unread-logic>`),测试里把这一段**真源码截出来跑**,不要照着抄一份逻辑到测试里。参考 `test/viewing-notify.test.js`。
- **测试数据里的日期一律相对今天算**,不要写死。有些逻辑带保留期(比如未读提醒只留 14 天),写死的日期过了期整条测试就会红。
- 测试不许读写真实的 `%APPDATA%\claude-hub` 和 `~/.claude`,用临时目录或假对象。

## 几条硬规矩

每一条背后都有一次真实事故。

1. **拿不准就放行。** 检测「装没装」「有没有代理」「人在不在看」这类东西,超时、抛错、看不懂的时候,一律回到原来的行为。挡住本来能用的人、吞掉本该给的提醒,比多提示一次糟得多。
2. **主进程和启动路径上不许有同步的文件 / 注册表探测。** 用户的 PATH 里有连不上的网络盘时,一次 `existsSync` 能卡二十多秒。
3. **把同步函数改成 async 之前,重查所有「先查后做」的调用方。** 中间多出来的 `await` 就是别人能插进来的空档。`spawnTermWith` 必须保持同步。
4. **不要写 `new Promise(async …)`。** 里面抛错不会变成 rejected,而是永远挂着,串行队列就堵死了。
5. **不要替用户改 Claude Code 的配置。** 软件不往 `~/.claude/settings.json` 写任何东西:模型、思考努力交给官方的 `/model`、`/effort`;通知钩子只把脚本放进 `~/.claude/hooks`,`settings.json` 里那一段由用户自己加。改 PATH 只能往后追加;用户已有的代理环境变量一个字不动。唯一的例外是 MCP 页的添加 / 移除:只能调用官方的 `claude mcp add-json` / `claude mcp remove`,不直接改任何配置文件,而且只在用户自己点按钮时才执行,不能自动跑。
6. **保存设置时只写用户真动过的值。** 界面上显示的可能是兜底值,顺手写回去就是替用户改了配置。
7. **「没有配置」和「配置读坏了」要分开处理。** 混成一个分支,新默认值就会落到老用户头上。
8. **不要把个人数据提交进来。** `.gitignore` 里列的那些(`projects.json`、`notify-config.json`、`auth.json`、`pastes/` 等)都是个人数据;截图、日志里也别带真实路径、令牌、邮箱。
9. **只改和这件事有关的代码。** 不顺手重构、不整体格式化、不改无关的文案。

## 代码在哪

| 要找什么 | 位置 |
|---|---|
| 主进程(窗口、终端进程、IPC、通知、自动更新) | `main.js` |
| 界面(全部在一个文件里) | `index.html` |
| 主进程暴露给界面的接口 | `preload.js` |
| 手机端页面 | `mobile.html` |
| 用量统计、登录、找 Claude Code、跟随系统代理等 | `lib/` |
| 装进 `~/.claude/hooks` 的钩子 | `hooks/` |
| 测试 | `test/` |
| 打包配置 | `electron-builder.yml`、`.github/workflows/release.yml` |

`.github/workflows/` 下的文件请不要在合并请求里改;觉得流水线有问题,开 Issue 说。

## 提交信息

中文,一句话说清做了什么,前面带类型:`feat:` 新功能、`fix:` 修问题、`docs:` 文档、`test:` 测试、`refactor:` 重构。

## 许可

本项目以 [AGPL-3.0](LICENSE) 开源,同时由作者提供商业授权。**提交合并请求即表示:你同意你的贡献以 AGPL-3.0 发布,并允许项目作者把它用在本项目的商业授权版本里。** 不同意这一点的话,请先开 Issue 沟通,不要直接提交代码。

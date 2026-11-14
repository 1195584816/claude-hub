# 小九 / 外部代理本机控制 API

> 用于让Hermes、小九或其他本机自动化工具稳定调用ClaudeHub，不依赖窗口焦点，不写入内嵌终端输入框，也不会覆盖用户草稿。

## 安全边界

- 固定监听：`127.0.0.1:8765`
- 即使修改配置，也不会监听局域网或公网地址
- 所有业务接口要求：`Authorization: Bearer <token>`
- 令牌由首次启动自动生成，保存在：`%APPDATA%\claude-hub\agent-api.json`
- **新安装默认不启用**（v1.1.4 起）：把上面这个文件里的 `enabled` 改成 `true`，重启总控即可。旧版本装过、文件里已是开着的保持原样
- 文档、日志和界面都不会显示完整令牌
- 只能操作ClaudeHub项目清单中已登记的工作目录
- 附件必须是本机已存在的文件
- 请求体上限1MB，超限返回HTTP `413`并停止缓存后续数据
- 畸形请求目标返回HTTP `400`，不会逃逸为Electron主进程未处理拒绝
- stdin异步`EPIPE`会转成任务失败，不会变成主进程未处理`error`
- Windows超时任务会终止完整进程树并等待确认后才释放串行队列
- 配置和任务快照采用临时文件、fsync、原子替换；写入失败会显式返回`persistenceError`
- 提示词和附件路径通过Claude CLI标准输入发送，不拼进Shell命令

## 任务模式

| mode | 行为 | 使用建议 |
|---|---|---|
| `fork` | 继承指定会话历史，但创建新会话ID | 默认推荐；不抢占GUI中已打开的原会话，不覆盖草稿 |
| `resume` | 直接恢复原会话 | 仅在原会话没有被ClaudeHub终端占用时使用 |
| `new` | 在指定项目创建全新会话 | 与历史无关的新任务 |

## 接口

### 健康检查

```http
GET /health
```

无需令牌，只返回服务是否存活，不泄露项目和任务信息。

### 项目清单

```http
GET /api/v1/projects
Authorization: Bearer <token>
```

### 会话清单

```http
GET /api/v1/sessions?projectPath=<URL编码后的项目路径>
Authorization: Bearer <token>
```

返回与ClaudeHub界面相同过滤口径的会话列表；先从项目接口取得`projectPath`，再从本接口取得会话ID，避免靠界面标题猜测。

### 提交任务

```http
POST /api/v1/tasks
Authorization: Bearer <token>
Content-Type: application/json
```

请求示例：

```json
{
  "projectPath": "F:\\claude-project\\panel-fork\\3x-ui",
  "sessionId": "aaaddac9-792b-4eae-ad1b-890acd7036ac",
  "mode": "fork",
  "prompt": "查询历史记录并给出结论，不修改代码",
  "attachments": [
    "C:\\Users\\你的用户名\\Pictures\\issue.jpg"
  ],
  "maxTurns": 50
}
```

成功返回HTTP `202`，任务初始状态为`queued`。

### 查询全部任务

```http
GET /api/v1/tasks
Authorization: Bearer <token>
```

### 查询单个任务

```http
GET /api/v1/tasks/<taskId>
Authorization: Bearer <token>
```

状态：

- `queued`：排队中
- `running`：Claude正在执行
- `completed`：完成，读取`result`和`resultSessionId`
- `failed`：失败，读取`error`
- `cancelled`：排队时已取消

### 取消排队任务

```http
DELETE /api/v1/tasks/<taskId>
Authorization: Bearer <token>
```

当前只允许取消尚未启动的`queued`任务；已运行任务不会被误杀。

## PowerShell调用示例

以下示例只从配置文件读取令牌，不会把令牌写进脚本：

```powershell
$cfg = Get-Content "$env:APPDATA\claude-hub\agent-api.json" | ConvertFrom-Json
$headers = @{ Authorization = "Bearer $($cfg.token)" }

$body = @{
  projectPath = "F:\claude-project\panel-fork\3x-ui"
  sessionId = "aaaddac9-792b-4eae-ad1b-890acd7036ac"
  mode = "fork"
  prompt = "检查历史记录并给出结论，不修改代码"
  attachments = @()
  maxTurns = 50
} | ConvertTo-Json

$task = Invoke-RestMethod `
  -Uri "http://127.0.0.1:8765/api/v1/tasks" `
  -Method Post -Headers $headers -ContentType "application/json" -Body $body

$taskId = $task.task.id
Invoke-RestMethod `
  -Uri "http://127.0.0.1:8765/api/v1/tasks/$taskId" `
  -Headers $headers
```

## 持久化

任务快照保存在：

```text
%APPDATA%\claude-hub\agent-tasks\<taskId>.json
```

ClaudeHub重启后：

- 已完成任务仍可查询；
- 当时处于`queued`或`running`的任务会标记为“应用重启而中断”，不会永远卡在运行中。

## 界面状态

顶栏会显示：

- `小九 API 就绪`
- `小九 排队 N`
- `小九 执行中 N`
- `小九 API 异常`

令牌不会显示在界面上。

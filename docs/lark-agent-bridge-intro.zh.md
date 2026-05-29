# 把云端或本地 Agent 接进飞书

过去一年，很多工程团队已经把 Coding Agent 放进了日常开发流程：让它读代码、改代码、跑测试、解释报错、梳理方案。问题是，这些能力通常被锁在本地终端或 IDE 里。你需要坐在电脑前，切到对应目录，打开终端，输入 prompt，然后等它输出。

但真实的协作场景并不总发生在终端里。很多问题是在飞书 / Lark 群里被提出的：线上告警、同事贴的一段报错、PR 里的一个疑问、文档评论里的一个 TODO。如果每次都要把上下文复制到本地 agent，再把结果复制回群里，体验就会被割裂。

[`lark-agent-bridge`](https://github.com/fangpin/lark-agent-bridge) 想解决的就是这件事：把飞书 / Lark 消息桥接到本地 Coding Agent，让你可以在聊天窗口里直接驱动本地的 Claude Code、Cursor Agent，或者其它兼容的 agent wrapper。

## 项目地址

项目地址：[github](https://github.com/fangpin/lark-agent-bridge)

## 它解决了什么问题

`lark-agent-bridge` 本质上是一个运行在本机的 Node.js CLI。它连接飞书 / Lark 的长连接事件，把用户消息转换成本地 agent 的输入，再把 agent 的输出实时更新回聊天卡片。

这带来几个直接收益：

- 你可以在飞书私聊或群聊里直接让 agent 处理问题，不必手动复制上下文。
- Agent 仍然运行在你的本机，可以访问本地 repo、开发工具、测试命令和文件系统。
- 回复是流式卡片，agent 的思考、输出、工具调用状态会持续更新，不用等到最终结果才知道它在做什么。
- 每个 chat 或 topic 都有独立 session，可以保持上下文连续，不会把不同讨论混在一起。
- 失败或超时的任务会保留一键重试入口，避免一次网络抖动或 agent 异常就丢失上下文。

换句话说，它不是把一个云端 bot 接进群里，而是把你本地已经配置好的 Coding Agent 暴露成一个可协作的聊天入口。

## 基本使用方式

可以把 `lark-agent-bridge` 的使用流程理解成四步：本机启动 bridge、绑定一个飞书 / Lark bot、指定 agent 工作目录，然后在聊天里发任务。下面按第一次接入的顺序展开。

### 1. 准备本机环境

先确认本机有 Node.js 20 或更高版本：

```bash
node -v
```

然后确认你要使用的 coding agent 已经安装并登录。默认情况下，bridge 会调用本机的 `claude` 命令：

```bash
claude --version
```

如果你准备使用 Cursor Agent，则确认 `agent` 命令可用：

```bash
agent --version
```

这些命令不需要由 bridge 安装。bridge 做的是“连接聊天和本机 agent”，不是替你安装 agent 本身。

### 2. 启动 bridge

最直接的方式是全局安装后启动：

```bash
npm i -g lark-agent-bridge
lark-agent-bridge start
```

也可以不安装，直接用 npx 启动：

```bash
npx -y lark-agent-bridge@latest start
```

如果需要指定配置文件，可以加 `-c`：

```bash
npx -y lark-agent-bridge@latest start -c ~/.lark-channel/config.json
```

启动后，这个进程需要保持运行。它会持续连接飞书 / Lark 的长连接事件，把收到的消息转给本地 agent，再把结果更新回聊天卡片。

### 3. 绑定飞书 / Lark 应用

首次启动时，如果本机还没有配置应用，工具会进入扫码向导：

1. 终端里显示二维码。
2. 用飞书 / Lark 扫码授权。
3. 选择或创建一个 PersonalAgent 应用。
4. bridge 把应用凭据写入 `~/.lark-channel/config.json`。

扫码向导创建的是应用外壳。为了让 bot 真正收发消息，还需要到飞书 / Lark 开放平台确认权限和事件订阅。最小可用配置通常包括下面这些。

权限 scope：

```text
im:message
im:message:send_as_bot
im:resource
```

事件订阅：

```text
im.message.receive_v1
card.action.trigger
```

如果希望处理消息 reaction、bot 被拉群等事件，可以再打开：

```text
im:chat
im.message.reaction.created_v1
im.message.reaction.deleted_v1
im.chat.member.bot.added_v1
```

配置完成后，再次启动：

```bash
lark-agent-bridge start
```

看到 `Connected` 或“已连接”后，就可以开始使用了。私聊里可以直接发消息；群聊和话题群里默认需要 `@bot` 才会触发 agent，避免 bot 在群里误响应所有聊天。

### 4. 指定 agent 工作目录

Agent 在哪个 repo 里工作，由当前 chat / topic 的 cwd 决定。最常用的是 `/cd`：

```text
/cd /path/to/your/repo
```

随后就可以在聊天里直接发任务，例如：

```text
帮我看一下这个仓库最近的测试为什么失败
```

或者在群里：

```text
@bot 这段报错可能是什么原因？请去当前 repo 里查一下
```

如果经常在多个项目之间切换，可以保存命名工作空间：

```text
/ws save backend
/ws use backend
/ws list
```

每个 chat 或 topic 都有独立 session。切换 cwd 时会重置 session，这是为了避免 agent 带着 A 项目的上下文去操作 B 项目的文件。

### 5. 推荐工作流：一个任务一个群

在团队协作里，更推荐的用法不是把所有事情都塞进同一个大群，而是“一个任务一个群”。每个群天然对应一个独立 chat，也就对应一条独立的 agent session。这样任务上下文、卡片、文件讨论和后续追问都留在同一个地方，不会互相污染。

可以先在私聊或已有群里创建一个任务群：

```text
/new chat some-task
```

这里的 `some-task` 会作为新群名称的一部分。bridge 会创建新群、把你拉进去，并让新群继承当前 chat 的 cwd。如果当前 chat 已经 `/cd` 到某个 repo，新任务群会直接在同一个 repo 下开始工作。

进入新群后，用 `@bot` 开始任务：

```text
@bot 这个任务是修复 CI 失败，请先看一下当前仓库最近的测试问题
```

这个模式有几个好处：

- session 边界清楚：一个任务群就是一个 agent 上下文。
- 讨论沉淀清楚：需求、agent 输出、命令结果、后续追问都在同一个群里。
- 并行任务不互相干扰：不同任务开不同群，互不污染 cwd 和 session。
- 结束后容易归档：任务完成后可以直接把群当作处理记录。

如果创建群失败，通常是 bot 没有开启 `im:chat` 权限；到开放平台补上权限后再重试即可。

### 6. 常用聊天命令

日常使用里，最常用的是这些命令：

```text
/status                  查看当前 cwd、session 和 agent 状态
/new                     清空当前会话，开启新 session
/new chat <name>         新建一个任务群，并开启独立 session
/stop                    终止正在运行的任务
/retry <run-id>          重试最近失败或超时的任务
/shell <command>         在当前 cwd 执行 shell 命令并回传结果
/workers                 查看 Cursor SDK worker pool 状态
/doctor <现象描述>       读取最近日志，让 agent 帮你诊断 bridge/worker 问题
/help                    查看帮助卡片
```

几个命令的使用场景可以更具体一点：

- `/status`：确认当前 chat 绑定的是哪个 cwd、当前 session 是否存在、后端 agent 是 Claude 还是 Cursor。
- `/new chat <name>`：为一个新任务创建独立群聊，并继承当前 cwd，适合“一个任务一个群”的协作方式。
- `/stop`：agent 卡住、跑偏或正在执行不想要的操作时，立即终止当前 run。
- `/retry <run-id>`：失败卡片上通常会带重试按钮；如果只知道 run id，也可以手动重试。
- `/shell <command>`：直接在当前 cwd 执行命令，比如 `/shell git status --short` 或 `/shell npm test`，结果会回传到聊天里。
- `/doctor <现象描述>`：把最近结构化日志和你的描述交给 agent 分析，适合排查卡片卡住、worker 异常、消息没响应等问题。

`/shell`、`/cd`、`/ws`、`/doctor`、`/workers` 等命令涉及本机环境或诊断信息。团队部署时建议配置管理员白名单，避免任何群成员都能改 cwd 或执行 shell。

### 7. 使用 Cursor Agent

如果想使用 Cursor Agent，可以在 `~/.lark-channel/config.json` 里切换到 Cursor backend。默认 runtime 是 `@cursor/sdk`，bridge 会复用持久 SDK agent，并在多轮消息之间尽量 resume 原 Cursor session：

```json
{
  "preferences": {
    "agentCommand": {
      "backend": "cursor",
      "command": "agent"
    },
    "agentCursorRuntime": "sdk",
    "agentSessionPoolSize": 10,
    "agentCursorApiKey": "${CURSOR_API_KEY}",
    "agentCursorModel": "gpt-5.5-extra-high-fast"
  }
}
```

SDK 模式需要 Cursor API key。你可以直接导出环境变量：

```bash
export CURSOR_API_KEY=cursor_xxx
```

也可以把 key 加密保存到 bridge 的 keystore，再在配置里引用：

```bash
lark-agent-bridge secrets set --id cursor-api-key
```

对应的配置可以写成：

```json
{
  "preferences": {
    "agentCursorApiKey": {
      "source": "exec",
      "provider": "bridge",
      "id": "cursor-api-key"
    }
  }
}
```

如果更想走 Cursor CLI 登录态，可以强制切到 CLI runtime：

```json
{
  "preferences": {
    "agentCursorRuntime": "cli"
  }
}
```

CLI 模式下需要确保 `agent` 命令已经安装、登录，并且在 `PATH` 中可用。

Cursor backend 出问题时，优先看两个命令：

```text
/workers
/doctor workers
```

前者查看当前 SDK worker pool 的实时状态，后者会把 worker 状态和最近日志交给 agent 辅助诊断。

### 8. 接入自己的 agent wrapper

如果你有自己的 agent wrapper，也可以通过 `agentCommand` 接入。比如：

```json
{
  "preferences": {
    "agentCommand": {
      "backend": "claude",
      "command": "my-claude-wrapper",
      "args": ["--model", "gpt-5.5"],
      "claudeArgsOption": "--claude-args"
    }
  }
}
```

bridge 只关心一件事：这个命令是否能以兼容的方式接收 prompt，并输出可解析的 agent stream。这样团队可以继续使用自己的模型路由、鉴权包装或审计脚本，而不需要改 bridge 本身。

### 9. 给团队使用时的权限建议

个人使用时可以保持默认开放；团队使用时，建议至少配置管理员：

```json
{
  "preferences": {
    "access": {
      "admins": ["ou_xxxxxxxxxxxxx"]
    }
  }
}
```

这样普通成员仍然可以和 bot 对话，但敏感命令会被限制给管理员。更严格的场景还可以配置用户白名单和群白名单，只让指定用户或指定群触发 bridge。

比如只允许固定用户和固定群使用：

```json
{
  "preferences": {
    "access": {
      "allowedUsers": ["ou_xxxxxxxxxxxxx", "ou_yyyyyyyyyyyyy"],
      "allowedChats": ["oc_zzzzzzzzzzzzz"],
      "admins": ["ou_xxxxxxxxxxxxx"]
    }
  }
}
```

默认策略适合个人试用；团队长期运行时，建议至少配置 `admins`，并根据实际场景补上 `allowedUsers` 或 `allowedChats`。

### 10. 第一次使用可以这样试

如果你刚完成配置，可以按这个顺序验证：

1. 私聊 bot 发 `/status`，确认 bot 有响应。
2. 发 `/cd /path/to/repo`，切到一个本地仓库。
3. 发 `/shell git status --short`，确认 bridge 能在当前 cwd 执行命令。
4. 发“帮我总结一下这个仓库的结构”，确认 agent 能读取代码并回复。
5. 把 bot 拉到测试群，`@bot /status`，确认群里需要 @ 才会响应。
6. 故意发 `/stop` 中断一次长任务，确认卡片能进入终止状态。

跑通这几步，基本就说明“飞书消息 → 本机 bridge → 本地 agent → 聊天卡片”的链路已经工作了。

## 为什么要运行在本地

让 agent 运行在本地有一个很重要的好处：权限边界更清晰。

代码仓库、测试命令、构建环境、私有依赖、Git 状态，本来就在开发者机器上。`lark-agent-bridge` 不需要把这些东西上传到一个额外的服务里，而是让飞书消息成为本地 agent 的入口。

这也意味着你可以继续使用已有的开发习惯：

- cwd 由 `/cd` 或 `/ws use` 控制，agent 在指定项目目录里工作。
- 文件、图片会下载到本地路径，再交给 agent 读取。
- `/stop` 可以中断正在运行的任务。
- `/new` 可以清理当前会话，开启新的 agent session。
- `/status`、`/workers`、`/doctor` 可以用来排查 session、worker 和卡片更新问题。

这种架构更像是“把聊天窗口接到本地终端”，而不是“把代码交给一个远端机器人”。

## 关键设计：流式卡片、会话和工作空间

### 流式卡片

Agent 的输出通常不是一次性完成的。它可能先读文件，再搜索代码，再修改文件，最后跑测试。`lark-agent-bridge` 会把这些过程渲染成一张持续更新的卡片：

- 正在启动 agent
- 正在思考
- 正在调用工具
- 正在输出
- 已完成 / 已中断 / 已超时 / 出错

对协作者来说，这比一个长时间没有反馈的“机器人正在输入”更有用。你能看到 agent 卡在哪里，也能决定是否需要 `/stop`。

### 会话隔离

每个 chat 或 topic 都会维护自己的 agent session。这样一个群里的讨论不会污染另一个群，私聊里的上下文也不会泄漏到公开讨论里。

同时，session 会和 cwd 绑定。切换工作目录时会重置 session，这是一个保守但重要的设计：避免 agent 带着 A 项目的上下文去操作 B 项目的文件。

### 工作空间

如果你经常在多个项目之间切换，可以用 `/ws` 保存和切换命名工作空间：

```text
/ws save backend
/ws use backend
/ws list
```

这让“在哪个 repo 里执行任务”变成一个聊天命令，而不是每次都去服务器或终端里确认。

## 可靠性：不要让卡片永远卡在运行中

真实环境里，最容易出问题的地方不是“happy path”，而是各种边界情况：

- Lark 卡片更新失败
- Agent 子进程长时间没有输出
- Cursor SDK worker 返回不透明错误
- 网络抖动导致最终状态没有展示出来
- 用户快速连续发送多条消息

`lark-agent-bridge` 针对这些情况做了不少工程化处理：

- 卡片更新失败时，降级发送普通 markdown 结果。
- 失败和 idle timeout 会保留 retry 按钮。
- 快速消息会合并成一次请求，避免重复打断。
- 运行日志按天写入 `~/.lark-channel/logs/`，`/doctor` 可以读取最近 timeline 辅助诊断。
- Cursor SDK worker 有独立 pool 和恢复逻辑，worker fatal 后会优先尝试恢复原 session，而不是直接丢上下文。

这些机制的目标很简单：用户不应该看到一张永远停在“运行中”的卡片，也不应该因为一次 worker 异常就必须重启整个 bridge。

## 适合哪些场景

`lark-agent-bridge` 特别适合这些使用方式：

- 在群里 `@bot` 分析一段报错，让 agent 直接去本地 repo 查原因。
- 给 agent 发截图或日志文件，让它结合代码定位问题。
- 在私聊里让 agent 做一次小范围改动，然后把结果同步给团队。
- 在 topic 里持续讨论一个问题，让同一个 session 保持上下文。
- 用 `/doctor` 排查 bridge 自己或 Cursor SDK worker 的异常。

它不适合被当成一个完全托管的云端 SaaS bot。它的定位更轻：一个本地开发者工具，一个把 chat 和 terminal 连起来的桥。

## 展望

你不需要搭一套复杂服务，也不需要改变现有 Coding Agent。只要本地能跑 `claude`、`agent` 或你的 wrapper，就可以把它接进飞书 / Lark。

未来可以继续增强的方向包括：

- 更丰富的 agent backend 适配。
- 更细的权限控制和审计能力。
- 更稳定的卡片渲染和长文本展示。
- 更完善的 session / workspace 管理体验。
- 面向团队部署的配置模板和最佳实践。

Coding Agent 真正有价值的地方，不只是“它能写代码”，而是它能进入团队已经在使用的协作链路。`lark-agent-bridge` 做的，就是把这条链路打通。

## 项目地址

项目地址：[github](https://github.com/fangpin/lark-agent-bridge)

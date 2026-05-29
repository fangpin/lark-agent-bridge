# 把本地 Coding Agent 接进飞书

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

安装后启动：

```bash
npm i -g lark-agent-bridge
lark-agent-bridge start
```

首次启动时，工具会进入扫码向导，帮助你绑定一个飞书 / Lark PersonalAgent 应用。完成应用配置和必要权限后，你就可以在私聊里直接发消息，或在群里 `@bot` 触发 agent。

默认情况下，bridge 会调用本地的 `claude` 命令。如果你想使用 Cursor Agent，可以在配置里改成 Cursor backend：

```json
{
  "preferences": {
    "agentCommand": {
      "backend": "cursor",
      "command": "agent"
    }
  }
}
```

如果你有自己的 agent wrapper，也可以通过 `agentCommand` 接入。bridge 只关心一件事：这个命令是否能以兼容的方式接收 prompt，并输出可解析的 agent stream。

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

## 开源后的期待

把 `lark-agent-bridge` 开源并发布到 npm 后，最希望降低的是“把 agent 接进协作流”的门槛。

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

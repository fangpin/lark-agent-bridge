# Agent 抽象与多后端适配

这一章对应 `src/agent/`。bridge 的 backend 设计重点不在“支持多少模型”，而在“如何把不同执行协议都翻译成统一的 `AgentEvent` 流”。

## `AgentAdapter` 是什么

定义在 `src/agent/types.ts`。这个接口要求 backend 至少提供：

- `run(opts): AgentRun`
- `isAvailable()`
- 基本描述信息，例如 `descriptor`、`sessionKey`

可选能力包括：

- `prepareSession()`
- `canResumeSession()`
- `evictScope()`
- `workerSnapshots()`
- `shutdown()`

这说明 backend 抽象不是最小运行接口，而是把“resume、worker 复用、诊断”一并纳入了协议。

## registry / factory：配置到实例的翻译层

- `src/agent/factory.ts`
- `src/agent/registry.ts`

`createAgentRegistry(cfg)` 会读取配置里的 backend map，返回一个惰性创建的 `AgentRegistry`。这里有两个重要点：

1. registry 以 backend key 为中心，而不是写死三种 backend
2. adapter 是惰性实例化的，真正用到某个 backend 时才创建

这让 `/backend`、多聊天切换 backend、默认 backend 回退都能在统一层里完成。

## Claude：最直接的 CLI 适配

`src/agent/claude/adapter.ts` 直接 spawn `claude` 命令，并用 stream-json translator 产出 `AgentEvent`。它的几个关键设计：

- 把 bridge 运行约定注入 `BRIDGE_SYSTEM_PROMPT`
- 用 `--resume` 绑定已有 session
- `stop()` 先发 `SIGTERM`，超时后再 `SIGKILL`
- stderr 会被结构化记录，而不是静默吞掉

Claude 路径最像“包装 CLI”，但也不是薄壳，因为 bridge 还要把 card callback、OAuth 约定、quoted message 这些 bridge 语义注入进去。

## Cursor：CLI 与 SDK 双运行时

`src/agent/cursor/adapter.ts` 根据配置选择：

- `cli`
- `sdk`

这两个路径共享同一个 adapter 名义，但运行语义差别很大。

### CLI 路径

CLI 模式更像普通子进程模式，每次请求新起一条 run。

### SDK 路径

SDK 模式会启用 `CursorSdkPool`，核心目标是复用本地 agent session，避免每轮都重新 ensure/resume。`src/agent/cursor/sdk-pool.ts` 里能看到几个关键约束：

- worker 复用严格按 Cursor SDK `sessionId`
- 同一个 session 的请求要串行执行
- 只有 pool entry 已经持有目标 `agentId` 时，才能跳过 ensure
- fatal worker error 需要丢弃 worker，避免坏状态持续复用

这也是为什么 Cursor backend 额外暴露了 `workerSnapshots()` 给 `/workers` 和 `/doctor workers`。

## Codex：JSON 事件翻译而不是 CLI 文本解析

`src/agent/codex/adapter.ts` 走的是：

- `codex exec --json`
- 必要时 `resume <sessionId>`

与 Claude 相比，这里更强调：

- 用 `buildCodexPrompt()` 包裹 bridge system prompt 和 user prompt
- 明确指定无 sandbox 参数
- 把 Codex JSON 事件翻译成统一 `AgentEvent`
- 用命令/args/hash 生成稳定的 `sessionKey`

Codex 这里的 `sessionKey` 不是固定字符串，而是和命令配置相关，目的是避免不同 wrapper 或启动参数误复用同一份 session。

## `sessionKey` 的真实作用

`AgentAdapter.sessionKey` 决定 session store 如何隔离不同 backend/runtime。例子：

- `claude`
- `cursor:sdk`
- `cursor:cli`
- `codex:<hash>`

这让同一个 chat 在切 backend 时不会拿错旧 session。仓库里很多“为什么要额外带一个 key”的设计，其实都服务于这个隔离边界。

## `prepareSession()` 与 `canResumeSession()`

这两个可选接口决定了 backend 是否支持“运行前预建会话”和“恢复已有 session 时的兼容性检查”。

- Cursor SDK 会用 `prepareSession()` 预建 agent / create-chat
- `canResumeSession()` 用来识别持久化 session 是否还适用于当前 runtime

对应逻辑会在 `src/session/ensure-resume.ts` 被调用。

## 这一层的设计取舍

这套 backend 抽象没有试图抹平所有差异，而是保留了每种 backend 的强特性：

- Cursor SDK 的 worker pool
- Claude CLI 的 process kill 语义
- Codex 的 JSON event 协议

统一的地方只保留在 bridge 真正需要的界面上：`AgentEvent`、session resume、availability、shutdown。这个边界是现实而不是理想化的，所以适合继续扩 backend。

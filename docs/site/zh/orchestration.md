# 消息接入与运行编排

这一章对应 `src/bot/channel.ts` 及其队列/运行状态辅助模块。它解释的不是某个 helper，而是 bridge 最重要的运行时约束：同一个聊天 scope 里，消息怎样变成单条、有状态、可恢复的 agent run。

## 入口：`startChannel()`

`startChannel()` 在 `src/bot/channel.ts` 里创建 Lark Channel、media cache、持久队列、pending queue 和 active run registry。它同时完成三件事：

1. 绑定飞书事件回调
2. 恢复本地持久队列
3. 初始化每个 scope 的运行控制结构

这里的关键不是“建立 WebSocket”，而是把所有后续副作用都挂到同一个 bridge 实例上，包含：

- `PersistentQueue` 负责重启恢复
- `PendingQueue` 负责批量聚合和 run 期间阻塞
- `ActiveRuns` 负责中断当前 run
- `RunHistory` 负责 `/runs` 与 `/retry`

## scope：真正的串行边界

编排层所有队列都不是按“整个 bot”串行，而是按 scope 串行：

- 私聊和普通群一般是 `chatId`
- 话题群扩成 `chatId:threadId`

这样一个 topic 被卡住时，不会拖死别的 chat；同一个 topic 的消息又能稳定落在同一条 session 上。

## `PersistentQueue`：接受即落盘

`src/bot/persistent-queue.ts` 不是普通内存队列。它把被接受的 `NormalizedMessage[]` 记录成：

- `queued`
- `running`

两态记录，并用本地 JSON 文件加锁写入。实现上做了几件很谨慎的事情：

- 深拷贝 message 结构，避免原对象里混进不可序列化字段
- 锁文件附带 `pid`、`procStartTime`，尽量识别陈旧锁
- 进程重启时优先恢复已存在记录，而不是假设内存状态还在

它解决的是“run 已经被接受，但 bot 恰好重启”的可靠性边界。

## `PendingQueue`：scope 级聚合与阻塞

`src/bot/pending-queue.ts` 解决的是另一个问题：agent 正在跑时，新消息应该怎么处理。

设计要点：

- 平时按 scope 聚合消息
- run 开始后调用 `block(scope)`，暂停 flush
- run 结束后 `unblock(scope)`，把积压消息重新放回 quiet window

这样实现的结果是：

- 同一 scope 不会并发跑两个 run
- 新消息不会丢
- 用户连续发多条补充说明时，bridge 可以合并成一批 prompt

## `ActiveRuns`：中断语义

`src/bot/active-runs.ts` 很小，但责任很明确：只追踪“当前 scope 正在跑什么 run，以及它是否被中断”。

中断有两类：

- `user`：例如 `/stop`
- `lifecycle`：例如新的消息抢占旧任务

这里故意没有把更多状态塞进去，因为真正的终态仍然由 card state machine 决定。`ActiveRuns` 只负责 stop 信号和 handle 生命周期。

## `RunHistory`：给 `/runs` 与 `/retry` 留证据

`src/bot/run-history.ts` 在内存里保留最近运行：

- 原始 batch
- cwd
- agent 描述
- summary
- streamMessageId
- terminal / errorMsg

它不追求长期存档，只保留有限数量和 TTL。原因很直接：这里的目标是“给用户近期的 retry / status / runs 视图提供依据”，不是取代结构化日志。

## 运行中的关键超时

`channel.ts` 里定义了多组超时常量，用来给外部依赖设边界，例如：

- 媒体下载
- quoted message 拉取
- session 预创建
- 卡片流式更新
- final flush

这符合仓库里一贯的可靠性设计：Lark 更新、资源下载、agent 预创建这些步骤都可能卡住，但不能因为某一步卡住就把整个 scope 永远留在“运行中”。

## agent 事件如何进入 run state

编排层拿到 `AgentRun.events` 后，会持续把事件归约进 `RunState`：

- `system` 带 `sessionId` 时持久化 session，并把 footer 从 startup 推进到 thinking
- `text` / `thinking` / `progress` / `tool_use` / `tool_result` 更新 card state
- `done` / `error` 决定终态

然后再按 reply mode 调用：

- `renderCard()`
- `renderText()`
- `renderMarkdownTextElements()`

也就是说，`channel.ts` 是编排 owner，但不是渲染 owner；它负责“什么时候刷”，卡片模块负责“刷成什么样”。

## 为什么这层要这么复杂

如果没有这层拆分，bridge 很容易退化成“收到消息就起一个子进程”的 bot。那会直接丢掉下面这些能力：

- per-scope 串行
- 抢占与批量聚合
- 重启后的任务恢复
- 近期 run history 与 retry
- 卡住时还能正确清理 active run

这也是为什么这个仓库最值得先读的文件不是 adapter，而是 `src/bot/channel.ts`。

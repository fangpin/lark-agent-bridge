# 卡片状态机与渲染路径

这一章对应 `src/card/`。这里真正的核心不是“怎么拼一张卡”，而是如何把 agent 的事件流收敛成用户能读懂、能操作、终态可靠的 UI。

## `RunState`：唯一的运行中真相

`src/card/run-state.ts` 定义了 `RunState`，里面同时保存：

- 文本 block
- tool block
- todo items
- reasoning
- footer / activity
- terminal 状态

`reduce(state, evt)` 把 `AgentEvent` 逐步归约成状态。重要事件包括：

- `text`
- `thinking`
- `progress`
- `tool_use`
- `tool_result`
- `done`
- `error`

另外还有两个外部驱动函数：

- `markAgentReady()`
- `markInterrupted()`
- `markIdleTimeout()`
- `finalizeIfRunning()`

这说明 card state machine 不只消费 agent 事件，也消费 bridge 生命周期事件。

## 为什么 tool / todo / reasoning 分开建模

仓库没有把所有输出都揉进一条 markdown 字符串，而是拆成几个不同视角：

- `blocks` 保留主要输出和工具轨迹
- `todos` 单独形成任务看板
- `reasoning` 可折叠显示
- `activity` 和 `footer` 只表达当前阶段

这样做的好处是，用户不需要在一大串输出里自己猜“现在在干什么”，界面可以直接回答：

- 当前阶段是什么
- 正在跑哪个工具
- 任务看板推进到哪了
- 最终是完成、失败还是超时

## `renderCard()`：CardKit 主路径

`src/card/run-renderer.ts` 的 `renderCard()` 会按顺序组装：

1. reasoning panel
2. todo board
3. progress line
4. 文本块 / 工具块
5. 终态说明
6. stop 或 retry 按钮

这里最有价值的不是“会 render 什么组件”，而是它刻意压缩低信号信息。

## 低信号工具会被隐藏或折叠

`src/card/tool-render.ts` 里 `isLowSignalTool()` 会把很多上下文准备类工具降噪，例如：

- `read`
- `glob`
- `grep`
- 某些 `git status` / `ls` / `pwd` / `rg` / `npm typecheck`

这样做是仓库的明确产品判断：用户关心的是当前结论和关键操作，不是所有上下文采集噪音。

同时，`collapsedToolSummary()` 会把多段工具调用压成折叠面板，避免单卡内容爆炸或超出 CardKit 尺寸限制。

## `renderText()`：无按钮的 markdown 路径

`src/card/text-renderer.ts` 是另一条渲染路径，用于 markdown/text reply mode。它与 card mode 的关键差异是：

- 不渲染 collapsible panel
- 不渲染按钮
- 推理内容默认不展开
- 工具调用只保留一行摘要

这不是功能阉割，而是适配 markdown 消息能力边界。

## todo board 是一等结构，不是工具日志副产物

`src/card/todo-board-render.ts` 把 todo 列表独立渲染成任务看板。`run-state.ts` 里也专门识别 `TodoWrite` / task tool 的输入与输出，把它们转成 todo item。

这样用户看到的是：

- 多少任务完成
- 当前进行中的是哪一项

而不是一串“agent 调了某个工具”的底层过程。

## `activityText()`：阶段标签的人类化翻译

`src/card/activity-render.ts` 把 footer 和当前 activity 翻译成稳定的用户语义：

- 正在启动 Agent
- 正在思考
- 正在调用工具
- 正在输出回答

如果当前工具本身是低信号工具，就回落成“正在准备上下文”。这正是 bridge 对“不要把内部 plumbing 作为主输出”的实现。

## `dispatcher.ts`：交互卡片动作入口

`src/card/dispatcher.ts` 处理 CardKit 点击事件。它有两条主路径：

1. 内建命令，例如 `copy.code`
2. 回调到 agent 自己的按钮，靠 `__claude_cb` marker 识别

后者会把点击变成一条 synthetic message，再送回当前 scope 的 pending queue，让 agent 在同一 session 里继续处理。也就是说，卡片按钮不是前端假动作，而是 bridge session 的一部分。

## 这一层真正守住的边界

卡片层守住的是两个边界：

1. 用户界面不能被低层工具噪音淹没
2. 终态必须可靠刷出，不能只在日志里“理论上已经完成”

这也是为什么 `channel.ts` 和 `src/card/` 必须一起看。前者决定何时刷新，后者决定刷新出来的内容是否真的适合在聊天里长期使用。

# Session、Workspace 与 Worktree 绑定

这层对应 `src/session/`、`src/workspace/`、`src/backend/`、`src/utils/portable-path.ts` 和 `src/git/worktree.ts`。它解决的是 bridge 最容易“看起来能跑、实际上会串上下文”的问题。

## session 不是按 chatId 单独存，而是按 `sessionKey`

`src/session/store.ts` 里的存储结构不是：

- chatId -> sessionId

而是：

- chatId -> agents[sessionKey] -> { sessionId, cwd, updatedAt }

`sessionKey` 来自 backend：

- `claude`
- `cursor:sdk`
- `cursor:cli`
- `codex:<hash>`

这样做的原因很简单：同一个 chat 如果切到另一个 backend，不应该继承旧 backend 的 session。

## resume 时必须同时匹配 cwd

`SessionStore.resumeFor(chatId, cwd, sessionKey)` 不只看 chatId 和 sessionKey，还会校验 cwd。因为用户可能在同一个 chat 里执行过 `/cd`、`/ws use` 或 `/new worktree`。

如果 cwd 变了，继续复用旧 session 很容易让 agent 带着 A 仓库上下文去操作 B 仓库。

## `ensureResumeSession()`：恢复或预建

`src/session/ensure-resume.ts` 的流程很短，但边界很清楚：

1. 先尝试从 store 里按 `sessionKey + cwd` 找旧 session
2. 如果 backend 显式声明旧 session 不兼容，就清掉
3. 如果 backend 支持 `prepareSession()`，则预建新 session 并落盘

这让 Cursor SDK 之类需要预创建 agent/session 的 backend 能和 Claude 这种纯 run 时 resume 的 backend 共用一条桥接逻辑。

## portable path：解决“同一路径的两个名字”

`src/utils/portable-path.ts` 会把 cwd 归一化进便携路径表示，再在读取时恢复真实路径。核心目的是避免这些别名把同一工作区拆成两份：

- `~`
- `/home/...`
- `/data00/home/...`
- realpath 之后的符号链接路径

仓库在 AGENTS.md 里专门强调了这一点，因为 session / workspace 误分叉通常不是 JSON 写错，而是路径没有归一化。

## WorkspaceStore：命名工作区只存“路径映射”

`src/workspace/store.ts` 的职责很克制：

- 记录 chat 当前 cwd
- 记录命名工作区 `name -> cwd`

它不保存 session，也不理解 backend。这样 `/ws` 只是 cwd 路由层，不会把更多状态耦进去。

## BackendStore：scope 到 backend key 的绑定

`src/backend/store.ts` 只做一件事：保存某个 scope 当前选中的 backend key。这样：

- 默认 backend 走 config
- scope 有单独切换时，优先读 backend store

这和 session store 分开，是为了让“backend 选择”和“backend 对应的 session”各自独立演进。

## worktree：从 repo 拆出任务隔离空间

`src/git/worktree.ts` 覆盖：

- `buildWorktreePlan()`
- `createGitWorktree()`
- `inspectWorktreeClearTarget()`
- `removeGitWorktreeAndBranch()`

关键点不是 `git worktree add` 本身，而是安全约束：

- worktree 名有白名单校验
- 默认从 `origin/main`，找不到再回退 `origin/master`
- `/clear` 不会误删主 worktree
- 未提交修改或未合并分支会触发 safety issues

也就是说，bridge 没把 worktree 当成“顺手执行一条 git 命令”，而是当成一个需要明确安全门槛的协作边界。

## 这一层带来的真实效果

用户在聊天里看到的是 `/ws`、`/cd`、`/new worktree`，但它们真正带来的能力是：

- 一个 chat 可以稳定绑定到一个 repo 上下文
- backend 切换不会串 session
- 多个任务群可以并行而不污染上下文
- worktree 生命周期和聊天生命周期可以一起管理

对 bridge 这类“把本地工程环境暴露给聊天”的工具来说，这一层不是附加功能，而是避免上下文错乱的底座。

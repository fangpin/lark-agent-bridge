# 系统总览与代码边界

`lark-agent-bridge` 不是单一 bot 文件，而是一条从飞书消息到本地 agent 再回到卡片 UI 的完整运行链。看这个仓库时，最稳妥的方式不是按目录名扫一遍，而是按运行时阶段来理解。

## 1. 启动入口

- `src/cli/commands/start.ts`
- `src/config/store.ts`
- `src/config/secret-resolver.ts`
- `src/runtime/registry.ts`

`runStart()` 先加载配置、检查 agent 可用性、恢复 session/workspace/backend store，再启动 Lark 长连接。这里同时处理了几件很宿主化的事情：

- 首次启动时跑扫码向导
- 明文 secret 迁移到本地加密 keystore
- 重复进程检测与 `/ps` / `/exit` 对应的进程注册
- bot 热重连和 `/account change` 后的 bridge 重建

这意味着 CLI 层不是薄封装，而是整个 bridge 生命周期的 owner。

## 2. 消息编排层

- `src/bot/channel.ts`
- `src/bot/persistent-queue.ts`
- `src/bot/pending-queue.ts`
- `src/bot/active-runs.ts`
- `src/bot/run-history.ts`

这里负责把飞书事件变成“按 scope 串行、可恢复、可中断”的 run。`scope` 通常是 `chatId`，话题群时会扩展成 `chatId:threadId`。这层的核心价值不是“收消息”，而是保证下面几件事同时成立：

1. 同一 scope 同时只跑一个 agent run。
2. 新消息到来时，正在运行的 run 可以被打断或排队。
3. 进程重启后，已经接受的任务还能从持久队列恢复。
4. 用户能看到 run history、失败原因和 retry 入口。

## 3. Agent backend 层

- `src/agent/types.ts`
- `src/agent/factory.ts`
- `src/agent/registry.ts`
- `src/agent/claude/*`
- `src/agent/cursor/*`
- `src/agent/codex/*`

bridge 对上游模型并不直接建模，而是围绕 `AgentAdapter` 统一 run / session / worker 能力。当前仓库的 backend 不是等价实现：

- Claude 走 CLI stream-json
- Cursor 支持 CLI 和 SDK 两条运行时路径
- Codex 走 `codex exec --json`

因此 backend 层真正抽象的不是“同一个 API”，而是“把不同执行协议翻译成统一的 `AgentEvent` 流”。

## 4. 卡片与文本输出层

- `src/card/run-state.ts`
- `src/card/run-renderer.ts`
- `src/card/text-renderer.ts`
- `src/card/tool-render.ts`
- `src/card/todo-board-render.ts`
- `src/card/dispatcher.ts`

这一层把 agent 事件流归约成用户可见状态，再按 reply mode 输出成：

- CardKit 2.0 卡片
- 流式 markdown 卡片
- 纯文本 markdown

仓库对这层的要求很明确：不能把内部工具噪音原样抛给用户，必须压缩成“当前阶段、关键工具、任务看板、终态按钮”这类可读的界面。

## 5. Session / Workspace / Backend 绑定层

- `src/session/store.ts`
- `src/session/ensure-resume.ts`
- `src/workspace/store.ts`
- `src/backend/store.ts`
- `src/utils/portable-path.ts`
- `src/git/worktree.ts`

这层解决的是“同一个 chat 应该在什么 repo、什么 backend、什么 session 上继续工作”。它的关键不是持久化 JSON 本身，而是：

- 不同 backend 的 session 不能互串
- 同一路径在 `/home/...` 和 `/data00/home/...` 这种别名下不能被当成两个 workspace
- `/new worktree`、`/clear` 这类命令要能安全绑定到 git worktree 语义

## 6. 诊断与宿主运行时

- `src/doctor/setup.ts`
- `src/core/logger.ts`
- `src/media/cache.ts`
- `src/config/schema.ts`

bridge 是本地常驻进程，所以“诊断能不能说清楚它停在哪一步”很重要。这个仓库把结构化日志、setup diagnostics、媒体下载缓存、权限与配置 schema 都单独拉出来，就是为了把“bot 没回消息”拆成可以定位的阶段，而不是只剩一个失败提示。

## 7. GitHub Pages 站点层

- `site/src/App.tsx`
- `site/src/content/copy.ts`
- `site/src/content/docs.ts`
- `site/src/components/*`
- `.github/workflows/pages.yml`

项目主页没有掺进根目录 CLI 依赖，而是放在独立的 `site/` 子树里。这样站点可以单独 build、test 和 deploy，不会把主页的依赖与 root runtime 混在一起。

这次站点进一步把详细说明拆成了 Markdown 章节，而不是继续把长文档塞进 JSX。后续可以从这里继续读：

- [消息接入与运行编排](#docs/orchestration)
- [Agent 抽象与多后端适配](#docs/agents)
- [卡片状态机与渲染路径](#docs/cards)
- [Session、Workspace 与 Worktree 绑定](#docs/sessions)
- [配置、密钥、诊断与宿主运行时](#docs/runtime)
- [GitHub Pages 主页实现](#docs/homepage)

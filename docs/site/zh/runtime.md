# 配置、密钥、诊断与宿主运行时

这一章对应 `src/config/`、`src/cli/commands/start.ts`、`src/doctor/setup.ts`、`src/core/logger.ts`、`src/runtime/registry.ts` 和 `src/media/cache.ts`。这些模块不直接生成用户答案，但决定了 bridge 能否长期稳定跑在本机上。

## 配置 schema：把可调参数明确定义出来

`src/config/schema.ts` 是所有配置入口的契约。这里不只是 appId/appSecret，还包括：

- reply mode
- tool call 显示策略
- max concurrent runs
- idle timeout
- access control
- agent backend / cursor runtime / codex model
- worktree branch prefix

这意味着 bridge 的很多运行行为不是散落在命令处理器里，而是先通过 schema 统一约束，再由调用层读取。

## secret resolver：配置里可以不放明文 secret

`src/config/secret-resolver.ts` 支持多种 secret 输入：

- 明文
- `${ENV}`
- `env` ref
- `file` ref
- `exec` ref

其中 `exec` provider 会和本地 keystore 以及 `secrets-getter` wrapper 对接，避免在 `config.json` 里长期存明文 app secret。这个设计直接对应了 bridge 的使用场景：本地 CLI 常驻进程，但配置文件不应该变成泄露点。

## config store：原子写和 wrapper 生成

`src/config/store.ts` 做了两件重要但很容易被忽视的事：

1. 配置文件用临时文件 + rename 的原子写方式保存
2. 生成 `~/.lark-channel/secrets-getter` wrapper，给外部 secret provider 协议消费

前者是为了避免 crash 时把 `config.json` 写坏，后者是为了让 lark-cli/openclaw 风格的 secret protocol 能在不同 Node 安装方式下稳定工作。

## `runStart()`：宿主生命周期 owner

`src/cli/commands/start.ts` 的 `runStart()` 负责：

- 加载或初始化配置
- 检查 agent availability
- 恢复 session/workspace/backend state
- 垃圾回收 media 与旧日志
- 检测重复 bot 进程
- 注册当前进程
- 创建 bridge channel
- 处理 stop / restart / account change

这让 `start.ts` 成为“本机 bridge 生命周期”真正的 owner，而不仅是一个 CLI 入口文件。

## setup diagnostics：把“能不能跑”拆成明确检查项

`src/doctor/setup.ts` 的 `runSetupDiagnostics()` 会输出结构化检查结果，例如：

- config 是否完整
- app secret 能否解析
- agent 命令是否可用
- cwd 是否存在
- Cursor runtime / pool size
- sender/chat access control
- 是否存在重复 bot 进程

它的目标不是替代真实运行，而是把“启动前就能知道的问题”单独提前出来。

## 结构化日志：`/doctor` 的证据来源

`src/core/logger.ts` 会同时写：

- `~/.lark-channel/logs/YYYY-MM-DD.log` JSONL
- 终端可读的精简 stdout/stderr

JSONL 是 `/doctor` 真正依赖的证据面。日志里保留 `phase`、`event` 和上下文字段，让人能追到：

- intake
- queue
- agent
- card
- ws
- process

也正因为如此，这个仓库对日志字段非常克制，不鼓励随手 `console.log`。

## process registry：多开冲突的本地真相

`src/runtime/registry.ts` 把正在运行的 `start` 进程记录到本地 registry，支持：

- `ps`
- `stop`
- `/ps`
- `/exit`

更重要的是，启动时可以识别“同一 app 已经有别的进程连着开放平台”，避免用户不知道消息到底落到哪个进程上。

## media cache：把聊天附件变成本地文件

`src/media/cache.ts` 会把图片/文件下载到：

- `~/.lark-channel/media/<chatId>/`

并在缓存命中时复用。对 agent 来说，这一步的意义是把飞书资源变成真正可读的本地路径，而不是只留一个 file key。

## 这层为什么必须单独成章

如果只看 bot/channel 或 card，你会以为 bridge 的难点全在“消息怎么转发”。实际上本地常驻进程更难的一面在于：

- secret 如何安全保存
- 配置如何原子更新
- 进程如何注册与冲突检测
- 诊断如何输出成可操作信息
- 附件如何变成本地资源

这些都属于“宿主运行时”责任，不写清楚就很难维护。

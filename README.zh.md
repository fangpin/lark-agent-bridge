# lark-agent-bridge

把飞书 / Lark 消息和本地 coding-agent CLI（Claude Code、Cursor Agent，或其它兼容包装命令）打通的轻量 bot，用一条命令起服务，扫码绑应用，在飞书里和 agent 对话、让它读图 / 改代码。

[English README](./README.md)

## 能干什么

- 在飞书（私聊直接发；群里 `@bot`）把消息转给本地 agent，agent 在你指定的工作目录里工作
- **流式卡片**：agent 的文本和工具调用实时出现在同一张卡片上，不用傻等
- **可靠的运行 UI**：失败或超时的任务会显示一键重试；卡片更新失败时会降级成普通 markdown，避免一直卡在“运行中”
- **会话延续**：每个 chat 独立 session，对话能接着上次说
- **抢占 + 批处理**：中途发新消息会打断旧任务；快速连发几条会合并成一次请求
- **多工作空间**：`/ws` 切换不同项目，session 自己重置
- **图片 / 文件**：直接发给 bot，agent 会读本地下载的文件路径
- **卡片按钮**：`/help` `/ws list` `/status` 返回交互卡片，点按钮直接操作

对于长时间运行的 markdown 回复，bridge 会在 10 分钟后停止高频流式刷新，之后约每 30 秒用最新内容重写一次卡片。这样可以避免长时间流式更新卡住，同时让用户仍能看到最新进度；Agent 完成后一定会再更新最终卡片。

## 前置条件

- Node.js **≥ 20**
- 已安装并登录一个受支持的 coding-agent 命令。默认运行 `claude`；也可以通过 `agentCommand` 使用兼容包装命令、Cursor CLI 的 `agent` 命令，或 Codex CLI 的 `codex` 命令。
- 一个飞书 / Lark PersonalAgent 应用（首次启动的扫码向导能帮你创建）

## 安装

```bash
npm i -g lark-agent-bridge
# 或
pnpm add -g lark-agent-bridge
```

也可以不安装直接运行：

```bash
npx -y lark-agent-bridge@latest start
```

## 首次启动

```bash
lark-agent-bridge start
```

也可以用 npx 直接启动，不需要全局安装：

```bash
npx -y lark-agent-bridge@latest start
```

第一次跑会检测到没配置应用，**自动进入扫码向导**：

1. 终端渲染一个二维码
2. 用飞书 App 扫码
3. 选择 / 创建 PersonalAgent 应用
4. 成功后凭据写入 `~/.lark-channel/config.json`

### 开放平台补齐 scope 和事件订阅

向导只负责创建应用，平台侧还需要手动确认：

**权限 scope**：
- `im:message`
- `im:message:send_as_bot`
- `im:resource`

**事件订阅（使用长连接接收）**：
- `im.message.receive_v1`
- `card.action.trigger`
- `im.message.reaction.created_v1` / `deleted_v1`（可选）
- `im.chat.member.bot.added_v1`（可选）

启用以后再次 `lark-agent-bridge start`，看到 `✓ 已连接` 就可以在飞书里找 bot 对话了。

## 命令速查

### 宿主 CLI

```
lark-agent-bridge start [-c <config>]   启动 bot
lark-agent-bridge start --check            只做 setup 自检，不启动 bot
npx -y lark-agent-bridge@latest start  不安装，直接启动
lark-agent-bridge migrate                迁移旧版 config/cache 路径
lark-agent-bridge ps                    列出本机所有正在跑的 start 进程
lark-agent-bridge stop <id|#>           终止指定 start 进程（SIGTERM，2s 后 SIGKILL）
lark-agent-bridge --help                列所有命令
```

> 多开同一个 app 时，开放平台会把事件随机推到其中一个长连接。`start` 启动前会检测同 app 已有的进程，TTY 下提示 `[c]ontinue / [k]ill old / [a]bort` 三选；非 TTY 只 warn 并继续。

Host CLI 里的 `status` / `doctor` / `handover` / `workspace` / `service` 目前只是已注册的占位命令，会输出 `not implemented yet`；运行时状态和管理能力请使用下面已实现的聊天内斜杠命令。

### 在飞书里用的斜杠命令

| 命令 | 作用 |
|---|---|
| `/new` `/reset` | 清空当前 chat 的会话 |
| `/new chat [name]` | 新建群聊、拉你进群，并绑定到一个新 session |
| `/new worktree <name>` | 从 `origin/main`（或 fallback 到 `origin/master`）创建 git worktree，新建带 backend 标识的群聊，并把新群 cwd 绑定到该 worktree |
| `/clear [--force|-f]` | 在 worktree 专属群里清理当前 worktree、bridge 状态/历史和分支，然后解散群聊。默认拒绝脏工作区或未合并分支，`--force`/`-f` 会强制清理。 |
| `/resume [N]` | 列出并恢复当前 cwd 下的本地 agent 历史会话 |
| `/cd <path>` | 切换工作目录（会重置 session） |
| `/ws list` | 列所有命名工作空间（卡片 + 按钮） |
| `/ws save <name>` | 把当前 cwd 存为命名工作空间 |
| `/ws use <name>` | 切换到命名工作空间 |
| `/ws remove <name>` | 删除命名工作空间 |
| `/account` | 查看当前飞书/Lark app 绑定；`/account change` 更新 appId/secret 并重连 |
| `/status` | 当前 cwd / session / agent / 最近运行（卡片 + 按钮） |
| `/runs [run-id]` | 查看当前 chat/topic 最近运行，包括状态、失败原因、重试/终止按钮和单次详情 |
| `/backend [key\|default]` | 查看或切换当前 chat/topic 的 agent backend |
| `/doc bind <doc-url\|token> <backend\|default> <session-id>` | 指定某个云文档 @bot 时使用的 backend/session；用 `/doc status <doc-url\|token>` 查看，用 `/doc clear <doc-url\|token>` 清除 |
| `/config` | 调整偏好（消息回复方式、工具调用显示等） |
| `/stop` | 终止当前正在跑的 run（也可点卡片底部 ⏹ 终止 按钮） |
| `/timeout [N\|off\|default]` | 当前 session 的 idle 探活（分钟）；`/config` 改全局默认。详见下方"常见问题 — Claude 子进程假死" |
| `/retry <run-id>` | 重放最近失败或超时的任务；失败卡片里也有一键重试按钮 |
| `/shell <command>` | 在当前 cwd 执行 shell 命令并回传 stdout/stderr。配置管理员后仅管理员可用；限制 10 分钟和 12k 字符输出 |
| `/workers` | 查看 Cursor SDK worker pool 健康状态：状态、队列、当前 run、session/cwd 和最近错误 |
| `/ps` | 列出本机所有 start 进程，标识当前回复的是哪个 |
| `/exit <id\|#>` | 终止指定 start 进程（自己 = graceful 退出；他人 = SIGTERM） |
| `/reconnect` | 强制重连 WebSocket（网络抖动后 bot 没反应时用） |
| `/doctor [描述]` | 把最近运行日志和你的描述喂给 agent，自助诊断卡住 / 异常的原因；`/doctor setup` 会运行非变更性的 setup 自检 |
| `/doctor workers` | 直接查看当前 SDK worker pool 状态 |
| `/help` | 帮助卡片 |
| 其它 `/xxx` | 原样交给 agent |

**消息策略**：私聊 = 不需要 @，任何消息都回；**群（含话题群）= 默认要 @bot 才回**（0.1.22 起的新默认），不 @ 时 bot 完全沉默；@全员永远不响应；云文档评论必须 @bot。要恢复"群里也不强制 @"的老行为：`/config` → "群里需要 @ bot" → 选"否"。

## 数据目录

| 路径 | 内容 |
|---|---|
| `~/.lark-channel/config.json` | 应用凭据（App ID / Secret），权限 600 |
| `~/.lark-channel/sessions.json` | 每个 chat / topic 的 agent session id + cwd，按后端/runtime 隔离（以及可选的 `/timeout` 覆盖） |
| `~/.lark-channel/workspaces.json` | 工作空间映射 |
| `~/.lark-channel/processes.json` | 当前在跑的 start 进程注册中心（`ps`/`stop` 用），死进程会被自动清理 |
| `~/.lark-channel/media/<chatId>/` | 下载的图片 / 文件，24h 自动清理 |
| `~/.lark-channel/logs/YYYY-MM-DD.log` | 结构化运行日志（JSON line），按天滚动；启动时清理超过 7 天的老文件（`LARK_CHANNEL_LOG_DAYS` 环境变量可改）；`/doctor` 命令读它做诊断 |

### Setup 自检

启动前可以用 `lark-agent-bridge start --check`，聊天里可以用 `/doctor setup`，在不向 agent 发送真实 prompt 的情况下检查本地配置。自检会报告 config 是否完整、App Secret 是否能解析、backend 命令是否可运行、cwd 是否可访问、Codex wrapper 模式、Cursor runtime 设置、当前 chat 权限白名单，以及是否有重复 bot 进程。检查有超时边界，且不会发起真实模型调用，所以适合排查 wrapper/auth/PATH/secret 问题且不消耗 token。

> 升级自 0.1.11 之前的版本？跑一次 `lark-agent-bridge migrate` —— 自动把旧路径 `~/.config/lark-channel-bridge/` 和 `~/.cache/lark-channel-bridge/` 下的内容搬到新位置，并把 `config.json` 升级到新结构。

### 自定义 agent 命令

默认情况下 bridge 使用 Claude backend，并把 Claude Code 参数追加到 `claude` 后面。要使用兼容包装命令，可以在 `~/.lark-channel/config.json` 里加入 `preferences.agentCommand`：

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

配置 `claudeArgsOption` 后，bridge 会把 Claude Code 参数安全拼成一个字符串，运行类似 `my-claude-wrapper --model gpt-5.5 --claude-args "-p ... --output-format stream-json --verbose ..."` 的命令。不配置 `claudeArgsOption` 时会把 Claude 参数作为普通 argv 追加；不配置 `agentCommand` 时仍然使用默认的 `claude`。

### 单个 bot 同时配置多个 backend

一个 bridge 进程可以暴露多个 backend profile，并按 chat/topic 选择。未选择时使用 `defaultBackend`；`/backend <key>` 切换当前 chat/topic，`/backend default` 回到默认 backend。

```json
{
  "preferences": {
    "defaultBackend": "claude",
    "agentBackends": {
      "claude": { "backend": "claude", "command": "claude" },
      "codex": { "backend": "codex", "command": "codex" },
      "cursor": { "backend": "cursor", "command": "agent" }
    }
  }
}
```

不同 backend 的 session 会隔离保存。新建绑定群会把当前 backend 标识放在群名末尾，`/backend` 切换时会尽力把群名更新为新的 backend 后缀。

`/new worktree <name>` 使用 `preferences.worktreeBranchPrefix` 作为分支前缀（默认 `feat`）。例如当前 cwd 是 `~/repos/project_a`，前缀是 `pin`，名称是 `abc`，会创建分支 `pin/abc` 和 worktree 目录 `~/repos/project_a_pin_abc`。

### Cursor backend（`@cursor/sdk` 或 CLI）

要接入 Cursor Agent，配置 Cursor backend。默认 runtime 是 `@cursor/sdk`：bridge 会维护一个小型 LRU 的持久 SDK agent 池，在多轮消息之间 resume 原 Cursor session，并提供 `/workers` 和 `/doctor workers` 用于诊断 worker pool。

```json
{
  "preferences": {
    "agentCommand": {
      "backend": "cursor",
      "command": "agent"
    },
    "agentCursorRuntime": "sdk",
    "agentCursorLocalSettings": "all",
    "agentSessionPoolSize": 10,
    "agentCursorApiKey": "${CURSOR_API_KEY}",
    "agentCursorModel": "gpt-5.5-extra-high-fast"
  }
}
```

SDK 模式需要 Cursor API key：可以通过环境变量 `CURSOR_API_KEY` 提供，也可以用 `lark-agent-bridge secrets set --id cursor-api-key` 加密保存后，在 `agentCursorApiKey` 里引用。`agentCursorModel` 使用 Cursor CLI 风格的模型 id；bridge 会把已知变体映射到 SDK model-selection 结构。如果想完全手写 SDK 选择，可以直接配置 `agentCursorSdkModel`：

SDK 模式默认加载本地 Cursor settings（`"agentCursorLocalSettings": "all"`），因此本地为 Cursor 配置的 MCP server、hooks/subagents、plugins 和 skills 会对 SDK agent 可见。如果希望 SDK run 只使用 bridge 传入的 inline 配置，可以设置 `"agentCursorLocalSettings": "none"`。

```json
{
  "preferences": {
    "agentCursorSdkModel": {
      "id": "gpt-5.5",
      "params": [{ "id": "reasoning", "value": "extra-high" }]
    }
  }
}
```

如果要强制使用旧的 Cursor CLI 路径，把 `"agentCursorRuntime"` 设为 `"cli"`。CLI 模式下需要确认 `agent` 命令已安装、已登录，并且在 `PATH` 中可用；bridge 会用类似 `agent -p --output-format stream-json --trust --workspace <cwd> ...` 的方式运行。如果你明确希望 Cursor 自动允许命令，可以把 `"-f"` 或 `"--force"` 加到 `agentCommand.args`。

### Codex backend（`codex exec --json`）

要使用 Codex CLI，可以配置 Codex backend。bridge 会以非交互方式运行 `codex exec --json`，把 Codex JSONL 事件转换成流式卡片，并把 Codex `thread_id` 保存为当前 chat 的 session id，后续消息会用 `codex exec resume` 续上。

```json
{
  "preferences": {
    "agentCommand": {
      "backend": "codex",
      "command": "codex"
    },
    "agentCodexModel": "gpt-5.1-codex"
  }
}
```

如果使用 `ttadk` 这类 wrapper，并且 wrapper 通过一个 option 接收完整 Codex argv，可以配置 `codexArgsOption`。option 名不写死，按 wrapper 实际支持的名字填写；如果它复用 Claude 兼容入口，就填和 `claudeArgsOption` 一样的值：

```json
{
  "preferences": {
    "agentCommand": {
      "backend": "codex",
      "command": "ttadk",
      "args": ["--profile", "dev"],
      "codexArgsOption": "--claude-args"
    },
    "agentCodexModel": "gpt-5.1-codex"
  }
}
```

配置 `codexArgsOption` 后，bridge 会把 Codex 参数安全拼成一个字符串，例如 `ttadk --profile dev --claude-args "exec --json -C /repo --model gpt-5.1-codex ..."`。

bridge 无法在运行中替 Codex 回答交互式审批提示。用于聊天里的无人值守运行时，Codex backend 会在生成的 `codex exec --json` 调用里加入 `--dangerously-bypass-approvals-and-sandbox`。这会让 Codex 在没有审批提示和 sandbox 限制的情况下执行命令，只应在你接受该宿主机本地命令访问权限的情况下使用。

Session 会按后端/runtime 隔离。同一个 chat 在同一 cwd 下可以分别保留 Claude、Cursor SDK、Cursor CLI 的会话；bridge 启动时只会恢复当前配置后端对应的 session。隔离功能上线前的旧 session 文件会按 Cursor SDK session 迁移。

## 访问控制（可选）

默认 bot 是"开放"的：任何能找到它的人都能私聊它，群里 @bot 就触发响应。**个人自己用 / 给朋友用，这就够了**——但如果想给团队用、或者怕在大群里被滥用，可以在飞书里发 `/config`，调下面三栏中的一栏或几栏。

### 几种典型用法

**只让我自己用**

`/config` 表单里：
- "用户白名单"：填你自己的 `open_id`
- 其它两栏留空

之后非你发的消息会被 bot 静默丢弃——bot 不会回"你没权限"之类的话，免得暴露它存在。

**只让一小群同事用**

- "用户白名单"：填同事们的 `open_id`，英文逗号分隔
- 其它两栏留空

**bot 只在指定工作群里干活**

私聊不受影响；群里只有名单上的群才触发响应：
- "群白名单"：填想让 bot 工作的群 `chat_id`，英文逗号分隔
- 私聊**永远**不受此约束——意味着你随时能 DM bot 调配置

**谁都能跟 bot 聊，但只有我能改设置**

- "管理员"：填你自己的 `open_id`
- 其它两栏留空

下次别人发 `/account` `/config` `/exit` `/reconnect` `/doctor` `/workers` `/shell` `/cd` `/ws` `/doc` 这些敏感命令，会收到 `❌ 此命令仅管理员可用`。普通对话（让 bot 帮忙做事）不受影响。

**完全收紧**

三栏全填。`/config` 表单会拦下常见误配——比如管理员名单里没把你自己加进去、群白名单里没包含当前会话，提交时会被拒绝并提示原因，不会让你不小心把自己锁在外面。

### 怎么找 `open_id` 和 `chat_id`

最快的办法：让目标用户给 bot 发一条任意消息（群的话就 @bot 一下），然后在终端：

```bash
grep '"event":"enter"' ~/.lark-channel/logs/$(date +%Y-%m-%d).log | tail -5
```

每一行都带 `chatId`（= 群或私聊 ID）和 `senderId`（= 用户 `open_id`），照着复制就行。

也可以查飞书开放平台的"获取用户信息"API，但要先给你的应用加 `contact:user` scope，没必要为了几个 ID 折腾。

### 几点提醒

- 改完 `/config` **下一条消息**就生效，不用重启
- 把任何一栏设成**空字符串** = 不限制（不是"一个都不允许"）
- 想从某种受限状态回到"完全开放"，把对应栏目清空再提交即可
- 私聊不受"群白名单"约束——这是设计上故意的：万一你不小心把所有群都锁死了，**回到 bot 的私聊里发 `/config` 就能解锁**

### 高级：直接改配置文件

不太想登飞书也可以，`/config` 表单背后写的是 `~/.lark-channel/config.json` 的 `preferences.access`：

```json
{
  "preferences": {
    "access": {
      "allowedUsers": ["ou_xxxxxxxxxxxxx"],
      "allowedChats": ["oc_xxxxxxxxxxxxx"],
      "admins":       ["ou_xxxxxxxxxxxxx"]
    }
  }
}
```

手改完之后**重启 bridge** 或者**找一个被允许的会话发 `/reconnect`** 让新配置生效。日常调整还是用 `/config` 表单更省事，直接改文件主要用在"部署脚本里预填"之类的场景。

## 发布检查清单

发布使用 npmjs，不受本机公司 npm registry 配置影响：

```bash
npm test
npm version patch
npm run release:check -- --registry https://registry.npmjs.org/
npm run prepublishOnly
git push origin main
git push origin v$(node -p "require('./package.json').version")
npm publish --access public --registry https://registry.npmjs.org/
```

`release:check` 会确认 `package.json` 和 `package-lock.json` 版本一致、release commit 在 `main` 上、`HEAD` 与 `origin/main` 一致，并且相同版本还没有发布到 npmjs。默认忽略未跟踪的临时文件，但如果存在已跟踪文件改动会失败。

## 常见问题

**Claude 挂住不回复**：通常是 `claude` CLI 本身没登录，或者 session 指向了不存在的 cwd。发 `/status` 看当前状态；`/new` 重开会话往往就好。

**Claude 子进程假死（卡片停在最后一帧不动）**：从 0.1.20 起支持 idle 探活：claude 一段时间没输出就被 SIGTERM kill，卡片末尾会标 "⏱ N 分钟无响应，已自动终止"。默认关闭。开启方式：`/config` 设全局值（分钟），或 `/timeout 10` 只对当前 session 生效；`/timeout off` 关掉某个 session 的探活；`/timeout default` 清掉 session 覆盖回退到全局。

**卡片显示 agent 失败，可以重试吗？** 失败和 idle-timeout 卡片会在 bridge 保存了原始 run 的情况下显示一键重试按钮。也可以在同一个 chat / 话题里运行 `/retry <run-id>`。重试只允许在原会话范围内触发，避免一个失败任务被别的 chat 误重放。

**怎么排查卡片卡住或 Cursor SDK worker 异常？** 运行 `/doctor <现象描述>`，它会把最近结构化日志和 run timeline 喂给 agent 自诊断。timeline 覆盖 `intake -> queue -> session -> agent -> card update -> done`，能帮助判断问题停在 Lark 更新、session 准备还是 agent 本身。只看 Cursor SDK worker 状态可以运行 `/workers` 或 `/doctor workers`。

**Cursor SDK 返回没有细节的 `status=error` 怎么办？** bridge 会把这类不透明 Cursor SDK run 失败视为当前 SDK worker 的 fatal 错误：展示最终原因、丢弃该 worker，并在后续运行中使用新 worker/session。如果同一 chat / 话题里没有更新的用户消息排队，bridge 还会在原范围内自动重放一次原任务；仍失败时再回退到一键重试按钮。限流、网络和 stale-session 等可恢复路径会记录自动恢复步骤和最终失败原因。

**图片发过去 Claude 说看不到**：升级到最新版，0.1.0 之前的版本有文件名去重 bug。

## 许可

[MIT](./LICENSE)

# lark-agent-bridge

A lightweight bot that bridges Feishu / Lark messenger with your local coding-agent CLI (Claude Code, Cursor Agent, or another compatible wrapper). Run one command, scan a QR code to bind a Lark app, and talk to the agent from chat — read screenshots, edit code, anything you'd do at the terminal.

[中文 README](./README.zh.md)

## What it does

- Forwards Feishu / Lark messages (DM directly, or `@bot` in a group) to your local coding agent, running in a working directory you control.
- **Streaming card**: the agent's text and tool calls update on a single Lark card in real time — no waiting for the final reply.
- **Resilient run UI**: failed or timed-out runs show a one-click retry button; card update failures degrade to a plain markdown fallback instead of leaving a stale running card.
- **Per-chat sessions**: each chat keeps its own agent session, so conversations resume where they left off.
- **Preempt + batch**: a new message interrupts the running run; rapid-fire messages get coalesced into one request.
- **Multiple workspaces**: `/ws` switches between named project directories, with sessions tracked per workspace.
- **Images and files**: send them to the bot directly — the agent reads the locally downloaded paths.
- **Interactive cards**: `/help`, `/ws list`, `/status` return cards with buttons you can click.

For long-running markdown replies, the bridge stops high-frequency streaming refreshes after 10 minutes and then rewrites the card about every 30 seconds with the latest known content. This avoids long-lived streaming update stalls while still keeping the visible card current; the final card is always updated when the agent finishes.

## Prerequisites

- Node.js **>= 20**
- A supported coding-agent command installed and logged in. By default the bridge runs `claude`; it can also use compatible wrappers through `agentCommand`, Cursor CLI's `agent` command, or Codex CLI's `codex` command.
- A Lark / Feishu **PersonalAgent** app (the QR-code wizard on first launch can create one for you).

## Install

```bash
npm i -g lark-agent-bridge
# or
pnpm add -g lark-agent-bridge
```

Run without installing:

```bash
npx -y lark-agent-bridge@latest start
```

## First run

```bash
lark-agent-bridge start
```

Or run it directly with npx:

```bash
npx -y lark-agent-bridge@latest start
```

The first run detects there's no app configured and **opens a QR-code wizard**:

1. A QR code renders in your terminal.
2. Scan it with the Feishu / Lark app.
3. Pick or create a PersonalAgent app.
4. Credentials are written to `~/.lark-channel/config.json`.

### Granting scopes and event subscriptions

The wizard creates the app shell, but you still need to confirm a few things on the Lark Developer Console:

**Permission scopes:**
- `im:message`
- `im:message:send_as_bot`
- `im:resource`

**Event subscriptions (over long-lived WebSocket):**
- `im.message.receive_v1`
- `card.action.trigger`
- `im.message.reaction.created_v1` / `deleted_v1` (optional)
- `im.chat.member.bot.added_v1` (optional)

After enabling those, run `lark-agent-bridge start` again. Once you see `✓ Connected`, find the bot in Feishu / Lark and start chatting.

## Commands

### Host CLI

```
lark-agent-bridge start [-c <config>]   Start the bot
lark-agent-bridge start --check            Run setup diagnostics and exit
npx -y lark-agent-bridge@latest start  Start without installing
lark-agent-bridge migrate                Migrate legacy config/cache paths
lark-agent-bridge ps                    List all running start processes on this machine
lark-agent-bridge stop <id|#>           Stop a start process (SIGTERM, SIGKILL after 2s)
lark-agent-bridge --help                List all commands
```

> When the same app is started multiple times, Lark's open platform routes events to one of the live WebSocket connections at random. `start` detects existing processes for the same app and (in a TTY) prompts: `[c]ontinue / [k]ill old / [a]bort`. In non-TTY mode it warns and continues.

Host CLI entries for `status`, `doctor`, `handover`, `workspace`, and `service` are currently registered placeholders that print `not implemented yet`; use the in-chat slash commands below for the implemented runtime views and controls.

### Slash commands inside Feishu / Lark

| Command | Effect |
|---|---|
| `/new`, `/reset` | Clear the current chat's session |
| `/new chat [name]` | Create a new group chat, invite you, and bind it to a fresh session |
| `/new worktree <name>` | Create a new git worktree from `origin/main` (or `origin/master` fallback), create a backend-labeled group chat, and bind that chat cwd to the worktree. |
| `/resume [N]` | List and restore recent local agent sessions for the current cwd |
| `/cd <path>` | Switch working directory (resets session) |
| `/ws list` | List named workspaces (card + buttons) |
| `/ws save <name>` | Save current cwd as a named workspace |
| `/ws use <name>` | Switch to a named workspace |
| `/ws remove <name>` | Delete a named workspace |
| `/account` | Show the current Lark app binding; `/account change` updates appId/secret and reconnects |
| `/status` | Current cwd / session / agent / latest run (card + buttons) |
| `/runs [run-id]` | Show recent runs for the current chat/topic, including status, failure reason, retry/stop buttons, and per-run details. |
| `/backend [key\|default]` | Show or switch the current chat/topic's agent backend. |
| `/config` | Adjust preferences (reply style, tool-call display, ...) |
| `/stop` | Stop the run in progress (also the `⏹` button on the card) |
| `/timeout [N\|off\|default]` | Idle-watchdog (minutes) for the current session. `/config` sets the global default. See FAQ below. |
| `/retry <run-id>` | Replay a recent failed or timed-out run. Failed cards include a one-click retry button. |
| `/shell <command>` | Run a shell command in the current cwd and return stdout/stderr. Admin-only when admins are configured; capped at 30s and 12k chars. |
| `/workers` | Show Cursor SDK worker-pool health: status, queue count, current run, session/cwd, and recent error. |
| `/ps` | List all `start` processes on this host, marking the one replying |
| `/exit <id\|#>` | Stop a `start` process (your own → graceful; another's → SIGTERM) |
| `/reconnect` | Force a WebSocket reconnect (use when the bot stops responding after a network blip) |
| `/doctor [description]` | Feed recent logs, run timeline, and your description back to the agent for self-diagnosis. `/doctor setup` runs non-mutating setup diagnostics. |
| `/doctor workers` | Shortcut for the live SDK worker-pool view |
| `/help` | Help card |
| Any other `/xxx` | Forwarded verbatim to the agent |

**Reply policy**: in a DM, the bot replies to anything. In a **group (including topic groups), the bot only replies when `@`-mentioned** (default since 0.1.22); unmentioned messages are ignored. `@all` is never answered. Cloud-doc comments must mention the bot. To restore the older "always answer in groups" behaviour: `/config` → "Require @bot in groups" → No.

## Data directories

| Path | Content |
|---|---|
| `~/.lark-channel/config.json` | App credentials (App ID / Secret), mode 600 |
| `~/.lark-channel/sessions.json` | Agent session ids + cwd per chat / topic, isolated by backend/runtime (+ optional `/timeout` override) |
| `~/.lark-channel/workspaces.json` | Named-workspace map |
| `~/.lark-channel/processes.json` | Process registry for live `start` instances (used by `ps`/`stop`); dead PIDs are auto-pruned |
| `~/.lark-channel/media/<chatId>/` | Downloaded images / files, cleaned up after 24h |
| `~/.lark-channel/logs/YYYY-MM-DD.log` | Structured run logs (JSONL), rotated daily; older than 7 days are pruned at startup (`LARK_CHANNEL_LOG_DAYS` env var overrides). `/doctor` reads these. |

### Setup diagnostics

Use `lark-agent-bridge start --check` before starting the bot, or `/doctor setup` in chat, to verify local setup without sending a prompt to the agent. The check reports config completeness, app-secret resolvability, backend command availability, cwd accessibility, Codex wrapper mode, Cursor runtime settings, chat access allowlists, and duplicate bot processes. Checks are bounded and do not perform a real model call, so they can catch wrapper/auth/PATH/secret issues without consuming tokens.

> Upgrading from before 0.1.11? Run `lark-agent-bridge migrate` once — it moves anything under the legacy `~/.config/lark-channel-bridge/` and `~/.cache/lark-channel-bridge/` paths to the new location and upgrades `config.json` to the new schema.

### Custom agent command

By default the bridge uses the Claude backend and appends Claude Code arguments to `claude`. To use a compatible wrapper, add `preferences.agentCommand` to `~/.lark-channel/config.json`:

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

With `claudeArgsOption`, the bridge safely joins Claude Code arguments and runs commands like `my-claude-wrapper --model gpt-5.5 --claude-args "-p ... --output-format stream-json --verbose ..."`. Without `claudeArgsOption`, it appends Claude args as normal argv entries. If `agentCommand` is omitted, it keeps using plain `claude`.

### Multiple backends in one bot

A single bridge process can expose multiple backend profiles and choose one per chat/topic. `defaultBackend` is used when a chat has not selected a backend; `/backend <key>` switches the current chat/topic, and `/backend default` returns to the default.

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

Sessions are isolated by backend. New bound groups use the current backend label in the group name, and `/backend` best-effort renames group chats with the selected backend prefix.

`/new worktree <name>` uses `preferences.worktreeBranchPrefix` for the branch prefix (default `feat`). For example, from cwd `~/repos/project_a`, prefix `pin`, and name `abc`, it creates branch `pin/abc` and worktree path `~/repos/project_a_pin_abc`.

### Cursor backend (`@cursor/sdk` or CLI)

To use Cursor Agent, configure the Cursor backend. The default runtime is `@cursor/sdk`: the bridge keeps a small LRU pool of persistent SDK agents, resumes the original Cursor session across messages, and exposes `/workers` plus `/doctor workers` for worker-pool diagnosis.

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

For SDK mode, provide a Cursor API key with `CURSOR_API_KEY`, or store it encrypted with `lark-agent-bridge secrets set --id cursor-api-key` and reference it from `agentCursorApiKey`. `agentCursorModel` uses Cursor CLI-style model ids; the bridge maps known variants to the SDK model-selection shape. For full control, set `agentCursorSdkModel` directly:

SDK mode loads local Cursor settings by default (`"agentCursorLocalSettings": "all"`), so local MCP servers, hooks/subagents, plugins, and skills configured for Cursor are visible to the SDK agent. Set `"agentCursorLocalSettings": "none"` to keep SDK runs isolated to bridge-provided inline config.

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

Set `"agentCursorRuntime": "cli"` to force the legacy Cursor CLI path. In CLI mode, make sure the `agent` command is installed, logged in, and available on `PATH`; the bridge runs `agent -p --output-format stream-json --trust --workspace <cwd> ...`. If you intentionally want Cursor to auto-allow commands, add `"-f"` or `"--force"` to `agentCommand.args`.

### Codex backend (`codex exec --json`)

To use Codex CLI, configure the Codex backend. The bridge runs `codex exec --json` non-interactively, translates Codex JSONL events into streaming cards, and stores the Codex `thread_id` as the chat session id so follow-up messages resume with `codex exec resume`.

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

For wrappers such as `ttadk` that accept the generated Codex argv through one option, set `codexArgsOption`. The option name is whatever your wrapper expects; if it reuses the Claude-compatible entrypoint, use the same value you use for `claudeArgsOption`:

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

With `codexArgsOption`, the bridge safely joins Codex arguments and runs commands like `ttadk --profile dev --claude-args "exec --json -C /repo --model gpt-5.1-codex ..."`.

The bridge cannot answer Codex's interactive approval prompts mid-run. For unattended chat use, the Codex backend adds `--dangerously-bypass-approvals-and-sandbox` to the generated `codex exec --json` invocation. This lets Codex execute without approval prompts or sandbox restrictions, so use this backend only on hosts where you accept that level of local command access.

Sessions are isolated by backend/runtime. A chat can keep separate Claude, Cursor SDK, and Cursor CLI sessions for the same cwd; the bridge resumes only the session matching the backend configured at startup. Existing pre-isolation session files are treated as Cursor SDK sessions during migration.

## Access control (optional)

Out of the box the bot is **open**: anyone who can find it can DM it, any group member can `@`-mention it to trigger a run, and commands like `/account` or `/cd` are usable by all. **That's fine for personal use** — but for a shared team setup, or anywhere you don't want strangers calling `/cd /`, you can tighten three allowlists by sending `/config` inside Feishu.

### Common scenarios

**Just me**

In the `/config` form:
- **Allowed users**: your own `open_id`
- Leave the other two blank

Messages from anyone else are silently dropped — no denial reply, since that would just confirm the bot exists to outsiders.

**A small team**

- **Allowed users**: comma-separated `open_id`s of team members
- Other two blank

**Bot only responds in specific work groups**

DMs are unaffected; only listed groups trigger responses:
- **Allowed chats**: comma-separated `chat_id`s of the groups
- DMs are **always** exempt from this list — so you can always DM the bot to change config later.

**Anyone can chat with the bot, but only I can change settings**

- **Admins**: your own `open_id`
- Other two blank

Others running `/account`, `/config`, `/exit`, `/reconnect`, `/doctor`, `/workers`, `/shell`, `/cd`, or `/ws` get a `❌ 此命令仅管理员可用` reply. Normal conversation (asking the bot to do things) is unaffected.

**Lock everything down**

Fill all three. The `/config` form catches common mistakes — e.g. if your admin list doesn't include yourself, or your chat allowlist doesn't include the chat you're submitting from, the submit is rejected with a message explaining why, so you can't accidentally lock yourself out.

### Finding `open_id` and `chat_id`

Easiest path: have the target user send the bot a message (or `@`-mention it in the target group), then in your terminal:

```bash
grep '"event":"enter"' ~/.lark-channel/logs/$(date +%Y-%m-%d).log | tail -5
```

Every line carries `chatId` (group or DM id) and `senderId` (the user's `open_id`). Copy them from there.

The Feishu open-platform "Get user info" API also works but needs the `contact:user` scope, which is overkill if you just need a couple of IDs.

### Worth knowing

- Changes take effect on the **next message** — no restart needed.
- An empty field means **unrestricted**, not "nobody allowed".
- To revert a restricted list back to fully open, clear that field in `/config` and submit.
- DMs are deliberately exempt from the chat allowlist — meaning if you ever accidentally restrict the bot out of every group, **DM the bot and send `/config`** to recover.

### Advanced: editing the config file directly

The `/config` form writes to `~/.lark-channel/config.json` under `preferences.access`:

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

After a manual edit, **restart the bridge** or send **`/reconnect`** from any allowed chat to pick up the changes. The form is usually faster; direct edits make sense mostly for deployment scripts where you want to pre-seed access policy.

## Release Checklist

Publishing uses npmjs, regardless of any local company npm registry:

```bash
npm test
npm version patch
npm run release:check -- --registry https://registry.npmjs.org/
npm run prepublishOnly
git push origin main
git push origin v$(node -p "require('./package.json').version")
npm publish --access public --registry https://registry.npmjs.org/
```

`release:check` verifies that `package.json` and `package-lock.json` agree, the release commit is on `main`, `HEAD` matches `origin/main`, and the exact package version is not already present on npmjs. It ignores untracked scratch files by default but fails on tracked worktree changes.

## FAQ

**The bot stays silent / Claude never replies.** Usually the `claude` CLI itself is not logged in, or the session points to a cwd that no longer exists. Send `/status` to inspect; `/new` to start a fresh session.

**Claude subprocess looks frozen (card stuck on the last frame).** Since 0.1.20 there's an idle watchdog: if Claude emits nothing for N minutes the process is killed and the card is annotated `⏱ N min no response, auto-terminated`. Disabled by default. Enable with `/config` (global, in minutes), or `/timeout 10` to set it on the current session; `/timeout off` disables for the session; `/timeout default` clears the session override.

**The card says the agent failed. Can I retry?** Failed and idle-timeout run cards include a one-click retry button when the bridge has the original run in recent history. You can also run `/retry <run-id>` in the same chat/topic. Retries are scoped to the original conversation so a failed task cannot be replayed from another chat by accident.

**How do I debug a stuck card or Cursor SDK worker?** Run `/doctor <what happened>` to analyze recent structured logs. The doctor prompt includes a run timeline covering `intake -> queue -> session -> agent -> card update -> done`, which helps identify whether the run stopped in Lark updates, session setup, or the agent. For Cursor SDK worker health only, run `/workers` or `/doctor workers`.

**Cursor SDK returns `status=error` with no detail.** The bridge treats opaque Cursor SDK run failures as fatal to that SDK worker: it surfaces the final reason, discards the worker, and creates a fresh worker/session on the next run. If no newer user message is queued, the bridge also replays the original task once in the same chat/topic; after that it falls back to the one-click retry button. Recoverable rate-limit, network, and stale-session paths record how many automatic recovery steps happened before the final failure.

**Claude says it can't see the image I sent.** Upgrade to the latest version — releases before 0.1.0 had a filename-dedup bug.

## License

[MIT](./LICENSE)

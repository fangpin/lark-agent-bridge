# System Map and Code Boundaries

`lark-agent-bridge` is not a single bot script. It is a full runtime chain from a Lark message, through a local agent process, back into a visible card UI. The easiest way to understand the repo is to follow that runtime path.

## 1. Process start

- `src/cli/commands/start.ts`
- `src/config/store.ts`
- `src/config/secret-resolver.ts`
- `src/runtime/registry.ts`

`runStart()` owns the host lifecycle. It loads config, checks backend availability, restores session/workspace/backend stores, starts the Lark channel, and handles duplicate-process detection plus hot restart flows such as `/account change`.

## 2. Message orchestration

- `src/bot/channel.ts`
- `src/bot/persistent-queue.ts`
- `src/bot/pending-queue.ts`
- `src/bot/active-runs.ts`
- `src/bot/run-history.ts`

This layer turns inbound messages into one active run per scope, with queueing, interruption, retry history, and restart recovery. The key design unit is the scope, usually `chatId`, or `chatId:threadId` in topic mode.

## 3. Agent backends

- `src/agent/types.ts`
- `src/agent/factory.ts`
- `src/agent/registry.ts`
- `src/agent/claude/*`
- `src/agent/cursor/*`
- `src/agent/codex/*`

The backend layer does not pretend that every provider exposes the same protocol. Instead, it normalizes Claude CLI, Cursor CLI/SDK, and Codex JSON runs into the shared `AgentEvent` stream that the bridge understands.

## 4. Card and text rendering

- `src/card/run-state.ts`
- `src/card/run-renderer.ts`
- `src/card/text-renderer.ts`
- `src/card/tool-render.ts`
- `src/card/todo-board-render.ts`
- `src/card/dispatcher.ts`

This layer owns the user-visible run state: thinking, progress, todo board, visible tool calls, terminal state, retry/stop affordances, and CardKit button callbacks.

## 5. Session, workspace, and backend binding

- `src/session/store.ts`
- `src/session/ensure-resume.ts`
- `src/workspace/store.ts`
- `src/backend/store.ts`
- `src/utils/portable-path.ts`
- `src/git/worktree.ts`

This layer answers: which cwd, which backend, and which session should a given chat resume on? It keeps backend sessions isolated, normalizes real paths, and binds worktree lifecycle to chat-level collaboration commands.

## 6. Diagnostics and host runtime

- `src/doctor/setup.ts`
- `src/core/logger.ts`
- `src/media/cache.ts`
- `src/config/schema.ts`

These files make the bridge operable as a local long-running process: setup checks, structured logs, local attachment caching, config validation, and process diagnostics.

## 7. GitHub Pages site

- `site/src/App.tsx`
- `site/src/content/copy.ts`
- `site/src/content/docs.ts`
- `site/src/components/*`
- `.github/workflows/pages.yml`

The project site is isolated under `site/`, not mixed into the CLI package. It now includes both the demo-first homepage and a Markdown-backed docs surface that follows the same implementation boundaries listed above.

Continue with:

- [Message Intake and Run Orchestration](#docs/orchestration)
- [Agent Abstraction and Multi-backend Adapters](#docs/agents)
- [Card State Machine and Rendering Paths](#docs/cards)
- [Session, Workspace, and Worktree Binding](#docs/sessions)
- [Config, Secrets, Diagnostics, and Host Runtime](#docs/runtime)
- [GitHub Pages Homepage Implementation](#docs/homepage)

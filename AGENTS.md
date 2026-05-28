# AGENTS.md

Guidance for AI agents working in this repository.

## Project Overview

`ttadk-channel-bridge` is a Node.js/TypeScript CLI that bridges Feishu/Lark messages to local coding agents such as Claude Code, TTADK-wrapped Claude, and Cursor Agent. It streams agent output into Lark cards, persists per-chat sessions, supports multiple workspaces, downloads media for local agent access, and exposes host plus in-chat slash commands.

The package is ESM-only (`"type": "module"`) and requires Node.js 20 or newer.

## Common Commands

- `npm test`: run the Vitest suite.
- `npm run typecheck`: run `tsc --noEmit` with strict settings.
- `npm run build`: build with `tsup`.
- `npm run dev`: watch-build during local development.
- `npm run prepublishOnly`: run typecheck and build before publish.

Use `npm`, not `pnpm`, unless the user explicitly asks otherwise.

## Repository Map

- `src/cli/`: command-line entrypoints and process management.
- `src/bot/`: Lark message handling, stream orchestration, run interruption, queues, reactions, and workspace/session commands.
- `src/card/`: Lark card state, rendering, templates, config/account cards, and tool-call presentation.
- `src/agent/`: agent adapter interface and backend implementations.
- `src/agent/claude/`: Claude stream-json adapter.
- `src/agent/cursor/`: Cursor CLI/SDK adapter, SDK worker pool, worker process, SDK event translation, and Cursor error formatting.
- `src/config/`: config schema, store, paths, keystore, and secret resolution.
- `src/session/`: persisted chat session ids, cwd matching, and resume helpers.
- `src/workspace/`: named workspace persistence.
- `src/media/`: downloaded image/file cache.
- `src/runtime/`: running process registry.
- `test/`: Vitest tests, usually mirroring the source area being changed.
- `vendor/`: bundled Cursor SDK packages. Avoid editing unless the task is explicitly about vendored SDK updates.

## Development Rules

- Keep changes scoped to the requested behavior. Do not refactor unrelated modules while fixing a bug.
- Preserve strict TypeScript settings. Prefer explicit types at module boundaries and for test doubles that model production interfaces.
- Use existing adapters, stores, renderers, and logger helpers instead of introducing parallel abstractions.
- Do not commit local credentials or runtime state. Files under `~/.lark-channel/` are user data, not repository fixtures.
- Treat `dist/`, `node_modules/`, local logs, and generated runtime data as build/runtime artifacts.

## Testing Expectations

- For bug fixes, add or update a focused regression test first when practical.
- Run at least the affected test file before widening verification.
- Before declaring work complete, run `npm test` and `npm run typecheck` unless the change is documentation-only or the user asks for a narrower check.
- For stream/session/card changes, prefer tests that assert event ordering and terminal/footer transitions, not only helper return values.

## Cursor SDK Notes

- SDK worker reuse is keyed strictly by Cursor SDK `sessionId`.
- Requests for the same SDK session must execute sequentially through the worker queue.
- Reused workers can skip expensive ensure/resume work only when the pool entry already has the target `agentId`.
- Only SDK-compatible session ids should be resumed with the Cursor SDK. Legacy CLI ids must be cleared and replaced with fresh SDK sessions.
- Do not surface a bare SDK wrapper error such as `sdk run failed (runId=..., status=error)` when more detail is available. Inspect `run.wait()` results, SDK error causes, `rawMessage`, `code`, `status`, `operation`, and worker stderr so cards and logs contain an actionable reason.
- Treat Cursor `ConnectError` codes carefully. For example, code `8` is resource exhaustion/rate limit, not authentication; code `16` is unauthenticated. Add regression tests for new classifications.
- If an SDK worker reports repeated empty-detail `status=error` results, improve diagnostics before adding retries. Retrying an opaque failure can hide the root cause and create duplicate user-visible runs.
- When changing SDK worker or pool behavior, check:
  - `test/agent/cursor/sdk-pool.test.ts`
  - `test/agent/cursor/adapter.test.ts`
  - `test/session/ensure-resume.test.ts`
  - `test/bot/channel.test.ts`

## Session And Workspace Persistence

- Persisted `cwd` values must be normalized through the existing portable-path helpers so `/home/...` and `/data00/home/...` do not split the same workspace.
- Session matching must compare normalized real paths, not raw strings.
- Changing `/cd`, `/ws use`, workspace store, or session store behavior should include tests for path normalization and session reset/reuse semantics.

## UI/Card Stream Notes

- `src/card/run-state.ts` owns the card state machine.
- `src/bot/channel.ts` consumes agent events and flushes card updates.
- `system` events with a `sessionId` persist the session and mark the agent as ready, moving the footer from startup to thinking.
- Keep cold-start and reused-session UI states honest: do not show ready/thinking before the backend has actually accepted the run.
- Distinguish "agent reached terminal state" from "Lark accepted the final card update". A `card.final` log should not be the only evidence that users saw the terminal UI. For streaming cards or markdown, add final-update logging and a fallback path when the Lark update cannot be confirmed.
- Streaming markdown/card updates are lossy boundaries: throttling, oversized element content, SDK best-effort `finishStreamingCard`, or Lark API failures can leave the visible card stuck in a running footer. Terminal states should force one final full-card update where possible.
- Keep user-visible stream content bounded. Long markdown bodies and long tool histories can exceed CardKit element limits or make final updates unreliable; cap rendered text and collapse or omit low-signal tool steps.
- Do not render internal progress plumbing as primary output. `TodoWrite`/`updateTodos` should become a task board, not a sequence of tool lines. Context-gathering tools such as file reads, globs, grep, and `git status/log/diff` should be hidden or summarized unless they fail or are directly relevant to the user's answer.
- Prefer stable, user-centered phase labels over raw tool names. Good cards answer: what is the agent doing, what remains, when was it last active, and how can the user stop/retry?
- Keep terminal card controls consistent: stop buttons only while running; retry buttons only for safe, recorded failed/timeout runs.

## Reliability Boundaries

- Any external service or filesystem-heavy pre-run step that can block user response needs a timeout and an explicit degradation path. This includes media downloads, quoted-message fetches, session precreation, Lark streaming updates, and final flushes.
- If a timeout fires while a run is active, stop or evict the underlying worker when safe, then surface a terminal state to the user instead of leaving a stale running card.
- Avoid awaiting Lark updates inside the agent event loop without a timeout. A hung card update must not prevent idle watchdogs, run cleanup, or queue unblocking from completing.
- When adding recovery or retry behavior, record enough run history to replay safely, and restrict replay to the original scope/session unless there is an explicit user action.

## Logging And Diagnostics

- Use `src/core/logger.ts` for structured logs.
- Prefer log fields that make production diagnosis possible: `sessionId`, `cwd`, `runId`, `pid`, `skipEnsure`, `footer`, and terminal state when relevant.
- `/doctor` relies on structured daily logs under `~/.lark-channel/logs/`, so avoid replacing structured logs with ad hoc console output.
- Log both transitions and confirmed side effects. For example, logging `terminal=done` is useful, but card/message update success or failure should have a separate event with `messageId`, mode, and relevant size/sequence fields.
- Preserve the original low-level error details in logs even when cards show a shorter message. Do not discard SDK `rawMessage`, Connect code, API response body, request id, or run id.

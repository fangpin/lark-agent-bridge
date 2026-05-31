# Codex Backend Design

## Goal

Add a first-class Codex CLI backend that lets `lark-agent-bridge` run `codex exec --json` as an agent backend with streaming events, session resume, stop support, cwd control, and optional model selection.

## Scope

This design targets the Codex CLI JSONL path only. It does not add Codex app-server, MCP server integration, worker pooling, cloud tasks, or custom UI for Codex-specific file changes.

## User-facing configuration

Users configure Codex through the existing `preferences.agentCommand` object:

```json
{
  "preferences": {
    "agentCommand": {
      "backend": "codex",
      "command": "codex",
      "args": ["--sandbox", "workspace-write", "--ask-for-approval", "never"]
    },
    "agentCodexModel": "gpt-5.1-codex"
  }
}
```

Defaults:

- `backend: "codex"` selects the new adapter.
- `command` defaults to `codex`.
- `args` are prepended to the generated `exec` invocation so advanced users can pass sandbox/approval/profile/config flags.
- `agentCodexModel` is optional; when set, the adapter passes `--model <value>`.

Recommended automation flags are `--sandbox workspace-write --ask-for-approval never`, because the bridge cannot satisfy Codex TUI approval prompts mid-run. The adapter should not force dangerous bypass flags; users can opt in through `agentCommand.args`.

## Adapter behavior

Create `src/agent/codex/adapter.ts` implementing `AgentAdapter`.

Descriptor:

- `id: "codex"`
- `displayName: "Codex CLI"`
- `sessionKey: "codex"`
- `descriptor.runtime: "json"`
- `supportsRetry: true`
- `supportsWorkers: false`

Availability check:

- Spawn `<command> --version` and return true on exit code 0.

Run command:

- Fresh run:
  - `<command> ...args exec --json -C <cwd> [--model <model>] <prompt>`
- Resume run:
  - `<command> ...args exec --json -C <cwd> [--model <model>] resume <sessionId> <prompt>`

The adapter should pass prompt as one argv entry, not shell-join it.

Stop behavior mirrors existing process-backed adapters:

- `stop()` sends `SIGTERM`.
- After `stopGraceMs` (default 5000ms), send `SIGKILL` if the process is still alive.
- `waitForExit(timeoutMs)` resolves whether the child exits naturally within the timeout.

## JSONL event translation

Create `src/agent/codex/stream-json.ts` for translating parsed JSONL events into `AgentEvent`.

Required mappings:

- `thread.started` with `thread_id` → `{ type: "system", sessionId: thread_id }`
- `item.completed` where `item.type === "agent_message"` and `item.text` is string → `{ type: "text", delta: item.text }`
- `item.started` where `item.type === "command_execution"` → `{ type: "tool_use", id, name: "Bash", input: { command } }`
- `item.completed` where `item.type === "command_execution"` → `{ type: "tool_result", id, output, isError }`
- reasoning item text/summary, when present → `{ type: "thinking", delta }`
- plan update items, when present → `{ type: "progress", label, phase: "thinking" }`
- `turn.completed` → usage event when usage exists, then `{ type: "done", sessionId }` if a thread id was seen
- `turn.failed` or top-level `error` → `{ type: "error", message }`

Unknown event shapes should not crash the stream. They may be ignored or converted to low-noise progress only when a stable label is available.

## Error handling

The adapter must preserve useful diagnostics without surfacing internal noise:

- Invalid JSONL lines are ignored unless stderr/process exit indicates failure.
- If spawn fails before a pid exists, emit `error` with `failed to spawn <commandLabel>: <message>`.
- If Codex exits non-zero without emitting a terminal error, emit `error` including exit code/signal and trimmed stderr.
- If stderr contains content, log it through the existing logger, but do not treat stderr alone as fatal.

## Session behavior

Codex sessions are isolated under `sessionKey: "codex"`, so they do not collide with Claude or Cursor sessions.

The first `thread.started.thread_id` persists through the normal `system.sessionId` path in `processAgentStream`. Follow-up messages pass that id to `codex exec resume <sessionId>`.

`canResumeSession` should accept non-empty strings for now, because Codex thread ids are version-owned by Codex CLI.

## Testing

Add focused tests:

- Config schema/factory:
  - `AgentBackend` accepts `codex`.
  - `getAgentCommand` defaults Codex command to `codex`.
  - `createAgentAdapter` returns `CodexAdapter` for Codex config.
- Adapter descriptor/command behavior:
  - descriptor fields are stable.
  - fresh run spawns `codex exec --json -C <cwd> ...`.
  - resume run spawns `codex exec --json -C <cwd> resume <sessionId> ...`.
  - stop uses the same graceful termination pattern as other process-backed adapters.
- Stream translation:
  - thread/session, text, command execution, reasoning/progress, usage/done, failed/error events.
  - unknown/invalid lines do not crash the stream.
- Session integration:
  - existing session store isolation tests should include `codex` where relevant.

Run affected tests first, then full `npm test` and `npm run typecheck`.

## Documentation

Update `README.md` and `README.zh.md`:

- Add Codex as a supported backend in prerequisites/overview where backend support is described.
- Add a Codex backend configuration section.
- Document the recommended sandbox/approval args and why approval prompts must be disabled or made non-interactive.

## Non-goals

- No Codex worker pool.
- No app-server or exec-server integration.
- No dedicated Codex `/workers` equivalent.
- No persistent run history changes beyond the existing in-memory `/runs` support.
- No forced dangerous sandbox bypass.

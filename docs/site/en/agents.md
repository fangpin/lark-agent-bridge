# Agent Abstraction and Multi-backend Adapters

This chapter maps to `src/agent/`. The real job of this layer is not “support more models”. It is “normalize very different execution protocols into one bridge-facing event stream.”

## `AgentAdapter`

Defined in `src/agent/types.ts`, the adapter contract includes:

- `run(opts): AgentRun`
- `isAvailable()`
- `descriptor`
- `sessionKey`

Optional capabilities include:

- `prepareSession()`
- `canResumeSession()`
- `evictScope()`
- `workerSnapshots()`
- `shutdown()`

That makes resume behavior, worker reuse, and diagnostics part of the abstraction, not afterthoughts.

## Registry and factory

- `src/agent/factory.ts`
- `src/agent/registry.ts`

`createAgentRegistry(cfg)` reads the configured backend map and returns a lazy registry keyed by backend name. The registry does two useful things:

- it lets chats switch backends without hard-coded branching in orchestration
- it avoids eagerly creating adapters that may never be used in this process

## Claude adapter

`src/agent/claude/adapter.ts` is the most direct CLI wrapper:

- spawn `claude`
- attach the bridge system prompt
- resume with `--resume` when a session exists
- translate stream-json lines into `AgentEvent`
- stop with SIGTERM first, then SIGKILL after a grace window

Even this path is more than a thin wrapper because it injects bridge-specific runtime rules such as card callbacks and OAuth guidance.

## Cursor adapter

`src/agent/cursor/adapter.ts` supports two runtimes:

- `cli`
- `sdk`

### CLI runtime

CLI mode behaves like a more traditional process-per-run backend.

### SDK runtime

SDK mode enables `CursorSdkPool` from `src/agent/cursor/sdk-pool.ts`. That pool is where most of the complexity lives:

- worker reuse is keyed by Cursor SDK session id
- requests for the same session run sequentially
- ensure/resume can be skipped only when the worker already owns the target agent id
- fatal worker errors poison the worker and force eviction

This is also why Cursor exposes worker snapshots to `/workers` and `/doctor workers`.

## Codex adapter

`src/agent/codex/adapter.ts` runs:

- `codex exec --json`
- `resume <sessionId>` when needed

Important differences versus the Claude path:

- prompt construction wraps the bridge system prompt explicitly
- the adapter depends on Codex JSON events rather than CLI text parsing
- the `sessionKey` includes a hash of command/args/options so mismatched wrappers do not accidentally share sessions

## Why `sessionKey` matters

`sessionKey` is the backend-facing partition key for the session store. Examples include:

- `claude`
- `cursor:sdk`
- `cursor:cli`
- `codex:<hash>`

That prevents a chat from resuming an incompatible session after a backend switch or runtime change.

## `prepareSession()` and `canResumeSession()`

These optional adapter hooks are consumed by `src/session/ensure-resume.ts`.

- `prepareSession()` lets a backend pre-create a reusable session before the main run
- `canResumeSession()` lets a backend reject stale or runtime-incompatible session ids

Cursor SDK relies on both of these hooks much more heavily than the Claude path.

## The key design tradeoff

This layer does not try to erase backend differences. It only normalizes what the bridge actually needs:

- a shared event stream
- explicit session behavior
- availability checks
- cleanup/shutdown hooks

That boundary is pragmatic, and it makes future backend additions realistic.

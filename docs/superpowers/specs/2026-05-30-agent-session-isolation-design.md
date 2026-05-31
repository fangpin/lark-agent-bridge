# Agent Session Isolation Design

## Goal

Prevent persisted sessions from one agent backend from being resumed by another backend, while preserving existing user sessions. The bridge should load the session that matches the backend selected at startup, so switching between Claude and Cursor does not mix incompatible conversation state.

## Scope

This design covers persisted chat/topic sessions in `SessionStore`, session precreation/resume via `ensureResumeSession`, and run-time session writes from agent events. It does not change workspace selection, Lark card rendering, run history, or backend-specific session creation behavior.

## Current behavior

`sessions.json` stores one flat entry per scope with `sessionId`, `cwd`, `updatedAt`, and optional `idleTimeoutMinutes`. The lookup key is only scope plus cwd. Compatibility is checked with the active adapter's `canResumeSession`, but the store does not remember which backend created the session. As a result, startup with a different backend can load a session id created by another backend.

## Proposed behavior

Each persisted scope keeps backend-specific session records. The active adapter exposes a stable session namespace:

- Claude: `claude`
- Cursor SDK: `cursor:sdk`
- Cursor CLI: `cursor:cli`

Session resume and writes use `(scope, cwd, agentKey)` instead of `(scope, cwd)`. The bridge resumes only the session whose cwd and agent key match the current adapter. If no matching session exists, it creates a fresh backend session when the adapter supports precreation.

Existing flat entries without an agent key are treated as Cursor SDK sessions during load, because the known legacy data in this project comes from Cursor SDK. This preserves existing Cursor SDK context while preventing Claude or Cursor CLI from accidentally resuming it.

## Data model

New entries preserve the existing per-scope fields that are not backend-specific, and move resumable sessions under a backend map:

```json
{
  "scope-id": {
    "updatedAt": 1772300000000,
    "idleTimeoutMinutes": 10,
    "agents": {
      "cursor:sdk": {
        "sessionId": "cursor-session-id",
        "cwd": "~/repos/project",
        "updatedAt": 1772300000000
      },
      "claude": {
        "sessionId": "claude-session-id",
        "cwd": "~/repos/project",
        "updatedAt": 1772300100000
      }
    }
  }
}
```

Legacy flat entries are normalized in memory to the equivalent `agents["cursor:sdk"]` record. On the next write, the file is persisted in the new shape.

## API changes

`AgentAdapter` gains a `sessionKey` field. Existing adapters set it from their backend/runtime configuration.

`SessionStore` changes these operations:

- `resumeFor(scope, cwd, agentKey)` returns only a matching backend session.
- `set(scope, agentKey, sessionId, cwd)` writes only that backend session and preserves timeout overrides.
- `getRaw(scope, agentKey?)` can return either the scope state or a specific backend session for `/status` and stale-cwd checks.
- `clear(scope, agentKey?)` clears only the current backend session when an agent key is provided; clearing without an agent key remains available for full scope removal.

Call sites in `ensureResumeSession`, `channel.ts`, comment handling, and slash commands pass `agent.sessionKey` when they are operating on the current agent session.

## Command semantics

Commands that start a new conversation or switch cwd should affect the current backend session by default:

- `/new` and `/reset` clear the current backend's session for the current scope.
- `/cd` and `/ws use` clear the current backend's session for the current scope, then precreate for the selected cwd when supported.
- Timeout overrides remain per scope, not per backend, because they are user preferences for the chat/topic rather than agent conversation state.

This keeps Claude and Cursor histories independent while preserving the user's existing timeout behavior.

## Error handling and logging

When a stored backend session exists but `canResumeSession` rejects it, only that backend session is cleared. Logs should include `sessionKey`, `scope`, `cwd`, and `sessionId` for resume, set, precreate, incompatible, and stale-cleared events.

If migration encounters an entry that has neither a valid session nor timeout override, it is dropped as before. Invalid backend session records are ignored without preventing other backend records in the same scope from loading.

## Testing

Add focused tests for:

- Loading a legacy flat entry and resuming it as `cursor:sdk`.
- Refusing to resume the same legacy entry as `claude`.
- Storing separate `claude` and `cursor:sdk` sessions under one scope/cwd.
- Clearing only the current backend session while preserving other backend sessions and timeout overrides.
- `ensureResumeSession` replacing only the incompatible backend session.
- Channel stream handling writing session ids under the active adapter's session key.

# Session, Workspace, and Worktree Binding

This layer spans `src/session/`, `src/workspace/`, `src/backend/`, `src/utils/portable-path.ts`, and `src/git/worktree.ts`. It prevents one of the easiest failure modes in a chat-to-local-agent bridge: mixed-up context.

## Sessions are partitioned by `sessionKey`

`src/session/store.ts` stores session state by chat and by backend session key, not just by chat id.

That means a single chat can keep isolated entries for:

- `claude`
- `cursor:sdk`
- `cursor:cli`
- `codex:<hash>`

Without that partition, backend switching would immediately risk resuming the wrong session.

## Resume requires cwd match too

`SessionStore.resumeFor(chatId, cwd, sessionKey)` checks the cwd as well as the backend key. That protects against `/cd`, `/ws use`, and `/new worktree` moving the chat onto a different repository while an older session still exists.

## `ensureResumeSession()`

`src/session/ensure-resume.ts` does three things:

1. try to resume a stored session for the current `sessionKey + cwd`
2. clear it if the backend declares it incompatible
3. pre-create a new session when the backend supports `prepareSession()`

This makes Cursor SDK-style precreated sessions and CLI-style lazy sessions fit into one orchestration path.

## Portable path normalization

`src/utils/portable-path.ts` keeps session and workspace paths stable across aliases such as:

- `~`
- `/home/...`
- `/data00/home/...`
- symlinked realpaths

This is why the repo insists on normalized real paths rather than raw input strings.

## `WorkspaceStore`

`src/workspace/store.ts` deliberately stores only:

- the current cwd for a chat
- named workspace mappings

It does not try to own sessions or backend state. That keeps `/ws` focused on cwd routing.

## `BackendStore`

`src/backend/store.ts` stores the selected backend key per scope. This is intentionally separate from session state:

- backend choice is one concern
- backend-specific session ids are another

That separation makes backend switching and session invalidation easier to reason about.

## Git worktrees

`src/git/worktree.ts` provides:

- worktree planning and validation
- create from `origin/main` or fallback `origin/master`
- safe inspection for `/clear`
- removal of the worktree and branch

The important part is the safety policy:

- validate worktree names
- do not delete the primary worktree
- block cleanup when there are uncommitted changes or unmerged commits unless forced

So worktrees are treated as a collaboration boundary, not just a convenience git command.

## What this layer enables

The visible user commands are `/cd`, `/ws`, and `/new worktree`, but the deeper effect is:

- stable repo context per chat
- backend switching without session cross-contamination
- concurrent task groups that do not leak context into each other
- worktree lifecycle tied to chat-driven collaboration flows

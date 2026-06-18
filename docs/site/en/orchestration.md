# Message Intake and Run Orchestration

This chapter maps to `src/bot/channel.ts` and the queue/run helpers around it. The core question here is not “how does the bot receive a message?”, but “how does one chat scope become one durable, interruptible, recoverable agent run?”

## `startChannel()` is the runtime hub

`startChannel()` creates the Lark channel, media cache, persistent queue, pending queue, active-run registry, and run history. It is the central owner for bridge-side orchestration after the CLI process has started.

## Scope is the serialization boundary

Queues are not global. They are scoped by:

- `chatId` for p2p and regular groups
- `chatId:threadId` for topic groups

That keeps one noisy topic from blocking unrelated chats while still preserving one active run per conversation scope.

## `PersistentQueue`: accepted work survives restarts

`src/bot/persistent-queue.ts` stores accepted batches on disk with `queued` and `running` states. Important details:

- message batches are deep-cloned into JSON-safe records
- writes are lock-protected
- stale-lock detection is intentionally defensive
- recovered records can be replayed after process restart

This is the bridge’s answer to “what if the process crashes after the run was accepted?”

## `PendingQueue`: batching while a run is active

`src/bot/pending-queue.ts` handles rapid-fire messages that arrive while a scope is still busy.

The key behavior is:

- queue normally
- `block(scope)` when a run starts
- keep accepting messages without flushing
- `unblock(scope)` when the run ends and flush again

That gives the bridge both serialization and batching instead of forcing a second concurrent run or dropping follow-up context.

## `ActiveRuns`: interruption only

`src/bot/active-runs.ts` is intentionally small. It tracks the currently running handle for a scope and provides stop semantics, with separate interrupt reasons such as `user` and `lifecycle`.

It does not own terminal UI. That remains the job of the card state machine.

## `RunHistory`: evidence for `/runs` and `/retry`

`src/bot/run-history.ts` keeps recent runs in memory with:

- batch payload
- cwd
- backend descriptor
- summary
- stream message id
- terminal state and error text

This is recent operational history, not long-term audit storage. The durable long-form evidence still lives in structured logs.

## External work always gets time bounds

`channel.ts` sets explicit timeouts around:

- media download
- quoted-context fetch
- session precreation
- streaming card updates
- final flush

This follows one of the repo’s main reliability rules: external services and filesystem-heavy steps must not leave the visible run stuck forever.

## Rendering is downstream of orchestration

Once an `AgentRun` starts, orchestration feeds events into `RunState` and then calls one of:

- `renderCard()`
- `renderText()`
- `renderMarkdownTextElements()`

So `channel.ts` decides when to update, while the card layer decides what the user sees.

## Why this layer matters

Without this orchestration layer, the bridge would degrade into “spawn a subprocess on every message”. That would lose:

- one-run-per-scope guarantees
- interrupt semantics
- restart recovery
- recent run history
- bounded cleanup when card updates or media steps stall

That is why `src/bot/channel.ts` is one of the highest-value files in the repo.

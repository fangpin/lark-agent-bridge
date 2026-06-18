# Card State Machine and Rendering Paths

This chapter maps to `src/card/`. The main problem here is not “how do we assemble a card?” It is “how do we turn an agent event stream into a readable, reliable, user-facing runtime UI?”

## `RunState` is the canonical visible state

`src/card/run-state.ts` defines `RunState` with:

- text blocks
- tool blocks
- todo items
- reasoning text
- footer and activity
- terminal status

`reduce(state, evt)` folds `AgentEvent` values into that state. Bridge lifecycle hooks such as `markAgentReady()`, `markInterrupted()`, `markIdleTimeout()`, and `finalizeIfRunning()` modify the same state machine from outside the raw agent stream.

## Why reasoning, tools, and todos are separate

The repo does not flatten everything into one markdown transcript. It keeps:

- main output in `blocks`
- planning/task progress in `todos`
- foldable thinking in `reasoning`
- current phase in `activity` and `footer`

That lets the UI answer practical questions directly:

- what is happening right now?
- what task is in progress?
- did the run finish, fail, or time out?

## `renderCard()`

`src/card/run-renderer.ts` builds CardKit output in a fixed order:

1. reasoning panel
2. todo board
3. progress line
4. grouped text/tool output
5. terminal note
6. stop or retry affordance

The important part is not just the order. It is the aggressive control over low-signal content.

## Low-signal tool activity is suppressed

`src/card/tool-render.ts` treats many context-gathering steps as low signal:

- `read`
- `glob`
- `grep`
- selected shell commands such as `git status`, `ls`, `pwd`, and some repo-inspection commands

When tool volume grows, the renderer collapses prior tools into a summary instead of expanding every input and output body. This is both a UX choice and a card-size safety measure.

## `renderText()`

`src/card/text-renderer.ts` is the markdown/text path. Compared with full card mode:

- no collapsible panels
- no buttons
- no visible reasoning stream
- tool calls collapse to short summary lines

This keeps reply modes aligned with the capabilities of their output surface rather than pretending markdown messages can behave like full cards.

## Todo board is first-class state

`src/card/todo-board-render.ts` renders todos as a dedicated task board. The reducer also recognizes todo-writing tools and task-create results and converts them into structured todo state.

That is why the visible output can say “2/5 complete, current: investigate queue replay” instead of exposing raw task-plumbing messages.

## `activityText()`

`src/card/activity-render.ts` translates internal phase state into stable user language:

- starting agent
- thinking
- running tools
- streaming answer

If the current tool is low-signal, it falls back to “preparing context” rather than surfacing raw implementation plumbing.

## `dispatcher.ts`

`src/card/dispatcher.ts` handles card actions. There are two main paths:

1. bridge-owned command callbacks such as `copy.code`
2. agent-owned callbacks marked with `__claude_cb`

The second path feeds a synthetic message back into the current scope so the agent continues in the same session after the user clicks a button on a card it created.

## What this layer really protects

The card layer protects two important boundaries:

1. the user should not drown in tool noise
2. terminal UI must be reliable, not only “finished in logs”

That is why the orchestration layer and the card layer have to be read together.

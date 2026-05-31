# Codex Wrapper Compatibility Design

## Goal

Make the Codex backend compatible with `ttadk` or any wrapper that accepts the generated Codex CLI arguments through a single option, matching Claude's existing `claudeArgsOption` behavior.

## Context

The Codex backend already builds a JSONL command shape like:

```text
codex exec --json -C <cwd> [--model <model>] [resume <sessionId>] <prompt>
```

For direct Codex CLI this works as normal argv. For `ttadk`, the bridge must be able to run a wrapper command and pass the generated Codex argv as one safely shell-joined string, the same way Claude currently supports:

```json
{
  "agentCommand": {
    "backend": "claude",
    "command": "ttadk",
    "args": ["..."],
    "claudeArgsOption": "--claude-args"
  }
}
```

## User-facing configuration

Extend `preferences.agentCommand` with `codexArgsOption?: string`.

Example for a `ttadk` wrapper that reuses the same wrapper option name as Claude:

```json
{
  "preferences": {
    "agentCommand": {
      "backend": "codex",
      "command": "ttadk",
      "args": ["...ttadk args..."],
      "codexArgsOption": "--claude-args"
    },
    "agentCodexModel": "gpt-5.1-codex"
  }
}
```

The option name is not hard-coded. Operators set it to whatever the wrapper expects.

## Command construction

Codex direct mode:

```text
<command> ...args exec --json -C <cwd> [--model <model>] <prompt>
```

Codex wrapper mode with `codexArgsOption`:

```text
<command> ...args <codexArgsOption> "exec --json -C <cwd> [--model <model>] <prompt>"
```

Rules:

- Reuse the same shell-argument quoting helper pattern as Claude.
- The prompt remains a single logical argument inside the joined Codex argument string.
- `isAvailable()` must also use the wrapper form, passing `--version` through `codexArgsOption` when configured.
- `commandLabel` remains `<command> ...args`, matching Claude; it does not include generated per-run Codex args.

## Error-event behavior adjustment

Codex top-level JSONL `error` events can be transient diagnostics during reconnect/retry paths. The bridge should not treat all top-level `error` events as terminal.

Rules:

- `turn.failed` remains terminal and maps to `AgentEvent.error`.
- Top-level `error` maps to a low-noise progress event, not terminal error.
- Process-level failures still remain terminal:
  - spawn failure
  - non-zero exit without terminal Codex event
  - signal exit without terminal Codex event
  - runtime error without terminal Codex event

This lets Codex recover internally without the bridge stopping the stream early.

## Tests

Add/update focused tests:

- Config:
  - `codexArgsOption` is accepted only for Codex backend and preserved by `getAgentCommand`.
- Factory:
  - `createAgentAdapter` passes `codexArgsOption` to `CodexAdapter`.
- Adapter:
  - Direct mode still spawns normal argv.
  - Wrapper mode runs `<wrapper> ...args <codexArgsOption> <joined-codex-args>`.
  - Wrapper availability check passes joined `--version` through `codexArgsOption`.
- Translator:
  - top-level `error` becomes progress and does not emit terminal `error`.
  - `turn.failed` still emits terminal `error`.

## Documentation

Update README and README.zh Codex sections with a `ttadk` wrapper example using `codexArgsOption`, noting that it behaves like Claude's `claudeArgsOption` and that the actual option name is configured by the operator.

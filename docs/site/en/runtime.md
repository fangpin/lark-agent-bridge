# Config, Secrets, Diagnostics, and Host Runtime

This chapter covers `src/config/`, `src/cli/commands/start.ts`, `src/doctor/setup.ts`, `src/core/logger.ts`, `src/runtime/registry.ts`, and `src/media/cache.ts`. These modules do not generate the agent’s answer directly, but they determine whether the bridge is operable as a local long-running process.

## Config schema

`src/config/schema.ts` defines more than app credentials. It also owns:

- reply mode
- tool-call visibility
- concurrency and idle timeout
- access control
- backend/runtime/model settings
- worktree branch prefix

That keeps behavior flags explicit instead of scattering them across command handlers.

## Secret resolution

`src/config/secret-resolver.ts` supports several secret forms:

- plaintext
- `${ENV}`
- `env` refs
- `file` refs
- `exec` refs

The exec-provider path integrates with the local encrypted keystore and the generated `secrets-getter` wrapper so the bridge does not have to keep long-lived app secrets in `config.json`.

## Config store and wrapper generation

`src/config/store.ts` is responsible for:

- atomic config writes via temp file + rename
- building the encrypted account config shape
- generating `~/.lark-channel/secrets-getter`

The write path is intentionally conservative because this config is part of the bridge’s local control plane.

## `runStart()` as host lifecycle owner

`src/cli/commands/start.ts` owns:

- first-run setup or config load
- backend availability check
- session/workspace/backend store restore
- media and log garbage collection
- duplicate-process detection
- process registration
- bridge startup, stop, and restart

So the CLI layer is a real lifecycle owner, not just a thin command entrypoint.

## Setup diagnostics

`src/doctor/setup.ts` breaks readiness into explicit checks such as:

- config completeness
- app secret resolution
- backend availability
- cwd accessibility
- Cursor runtime settings
- sender/chat access control
- duplicate-process warnings

Its job is to surface blocking setup issues before the user sends a real prompt to the agent.

## Structured logs

`src/core/logger.ts` writes:

- JSONL logs under `~/.lark-channel/logs/`
- a reduced human-readable stdout/stderr stream

The JSON logs are the evidence surface for `/doctor`. The phase/event structure is what makes production diagnosis possible.

## Process registry

`src/runtime/registry.ts` tracks live `start` processes so the bridge can:

- list them with `ps` or `/ps`
- stop them with `stop` or `/exit`
- detect same-app conflicts during startup

This matters because multiple live connections for the same Lark app make event routing unpredictable.

## Media cache

`src/media/cache.ts` downloads message attachments into local per-chat directories and reuses them on cache hit. That turns Lark resource keys into real local file paths the agent can read.

## Why this deserves its own chapter

If you only read the bot and card code, it is easy to miss the harder local-runtime concerns:

- safe secret handling
- atomic config mutation
- diagnosable startup state
- process conflict management
- attachment materialization into local files

Those concerns are central to a tool that bridges remote chat into a local engineering environment.

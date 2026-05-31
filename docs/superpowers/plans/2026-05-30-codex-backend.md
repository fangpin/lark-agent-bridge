# Codex Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a first-class Codex CLI backend using `codex exec --json` with streaming JSONL event translation and session resume.

**Architecture:** Extend the existing `AgentAdapter` pattern with a focused `CodexAdapter` and a Codex JSONL translator. Wire `backend: "codex"` through config and factory, keeping Codex process execution isolated in `src/agent/codex/` and reusing existing session/run/card plumbing.

**Tech Stack:** TypeScript, Node.js 20, Vitest, Codex CLI `exec --json`, existing `AgentEvent` stream model.

---

## File Structure

- `src/config/schema.ts` — accept `codex` as an agent backend, add optional `agentCodexModel`, and default Codex command to `codex`.
- `src/agent/factory.ts` — instantiate `CodexAdapter` for Codex configs.
- `src/agent/codex/stream-json.ts` — translate Codex JSONL events into `AgentEvent` values.
- `src/agent/codex/adapter.ts` — spawn `codex exec --json`, resume sessions, expose descriptor, implement stop/wait.
- `src/agent/codex/spawn-run.ts` — optional helper if the adapter grows too large; keep inside `adapter.ts` if concise.
- `test/config/schema.test.ts` — cover Codex config defaults and model preference.
- `test/agent/factory.test.ts` — cover factory selection for Codex.
- `test/agent/codex/stream-json.test.ts` — cover JSONL event translation.
- `test/agent/codex/adapter.test.ts` — cover descriptor, command construction, spawn failure, and resume command shape.
- `test/agent/adapter-descriptor.test.ts` — include Codex descriptor.
- `README.md`, `README.zh.md` — document Codex backend configuration and non-interactive approval guidance.

---

### Task 1: Config and factory wiring

**Files:**
- Modify: `src/config/schema.ts`
- Modify: `src/agent/factory.ts`
- Create: `test/config/schema.test.ts`
- Create: `test/agent/factory.test.ts`

- [ ] **Step 1: Write failing config tests**

Create `test/config/schema.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { getAgentCommand, getAgentCodexModel, type AppConfig } from '../../src/config/schema';

function cfg(preferences: AppConfig['preferences']): AppConfig {
  return {
    accounts: { app: { id: 'app', secret: 'secret', tenant: 'feishu' } },
    preferences,
  };
}

describe('agent command config', () => {
  test('defaults codex backend command to codex', () => {
    expect(getAgentCommand(cfg({ agentCommand: { backend: 'codex' } }))).toEqual({
      backend: 'codex',
      command: 'codex',
      args: [],
    });
  });

  test('preserves custom codex command and args', () => {
    expect(
      getAgentCommand(
        cfg({
          agentCommand: {
            backend: 'codex',
            command: 'codex-wrapper',
            args: ['--sandbox', 'workspace-write'],
          },
        }),
      ),
    ).toEqual({
      backend: 'codex',
      command: 'codex-wrapper',
      args: ['--sandbox', 'workspace-write'],
    });
  });

  test('reads optional codex model', () => {
    expect(getAgentCodexModel(cfg({ agentCodexModel: 'gpt-5.1-codex' }))).toBe('gpt-5.1-codex');
    expect(getAgentCodexModel(cfg({ agentCodexModel: '   ' }))).toBeUndefined();
    expect(getAgentCodexModel(cfg({}))).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run config tests to verify failure**

Run: `npm test -- test/config/schema.test.ts`

Expected: FAIL because `codex` backend and `getAgentCodexModel` do not exist yet.

- [ ] **Step 3: Add Codex config support**

In `src/config/schema.ts`, replace:

```ts
export type AgentBackend = 'claude' | 'cursor';
```

with:

```ts
export type AgentBackend = 'claude' | 'cursor' | 'codex';
```

In `AppPreferences`, after `agentCursorApiKey?: SecretInput;`, add:

```ts
  /** Default Codex model passed to `codex exec --model` when using the Codex backend. */
  agentCodexModel?: string;
```

Add this function near the Cursor model helpers:

```ts
export function getAgentCodexModel(cfg: AppConfig): string | undefined {
  const raw = cfg.preferences?.agentCodexModel?.trim();
  return raw || undefined;
}
```

Replace `getAgentCommand` with:

```ts
export function getAgentCommand(
  cfg: AppConfig,
): { backend: AgentBackend; command: string; args: string[]; claudeArgsOption?: string } {
  const raw = cfg.preferences?.agentCommand;
  const backend: AgentBackend = raw?.backend === 'cursor'
    ? 'cursor'
    : raw?.backend === 'codex'
      ? 'codex'
      : 'claude';
  const command = typeof raw?.command === 'string' && raw.command.trim()
    ? raw.command.trim()
    : backend === 'cursor'
      ? 'agent'
      : backend === 'codex'
        ? 'codex'
        : 'claude';
  const args = Array.isArray(raw?.args)
    ? raw.args.filter((arg): arg is string => typeof arg === 'string')
    : [];
  const claudeArgsOption = backend === 'claude' && typeof raw?.claudeArgsOption === 'string' && raw.claudeArgsOption.trim()
    ? raw.claudeArgsOption.trim()
    : undefined;
  return { backend, command, args, ...(claudeArgsOption ? { claudeArgsOption } : {}) };
}
```

- [ ] **Step 4: Run config tests**

Run: `npm test -- test/config/schema.test.ts`

Expected: PASS.

- [ ] **Step 5: Write failing factory test**

Create `test/agent/factory.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { createAgentAdapter } from '../../src/agent/factory';
import type { AppConfig } from '../../src/config/schema';

function cfg(preferences: AppConfig['preferences']): AppConfig {
  return {
    accounts: { app: { id: 'app', secret: 'secret', tenant: 'feishu' } },
    preferences,
  };
}

describe('createAgentAdapter', () => {
  test('creates a Codex adapter for codex backend config', async () => {
    const adapter = await createAgentAdapter(
      cfg({
        agentCommand: {
          backend: 'codex',
          command: 'codex-wrapper',
          args: ['--sandbox', 'workspace-write'],
        },
        agentCodexModel: 'gpt-5.1-codex',
      }),
    );

    expect(adapter.id).toBe('codex');
    expect(adapter.sessionKey).toBe('codex');
    expect(adapter.commandLabel).toBe('codex-wrapper --sandbox workspace-write');
    expect(adapter.descriptor).toMatchObject({
      id: 'codex',
      label: 'Codex CLI',
      runtime: 'json',
      supportsRetry: true,
      supportsWorkers: false,
    });
  });
});
```

- [ ] **Step 6: Run factory test to verify failure**

Run: `npm test -- test/agent/factory.test.ts`

Expected: FAIL because `CodexAdapter` does not exist or factory falls back to Claude.

- [ ] **Step 7: Add a minimal temporary CodexAdapter skeleton**

Create `src/agent/codex/adapter.ts`:

```ts
import type { AgentAdapter, AgentDescriptor, AgentRun, AgentRunOptions } from '../types';

export interface CodexAdapterOptions {
  command?: string;
  args?: string[];
  defaultModel?: string;
}

export class CodexAdapter implements AgentAdapter {
  readonly id = 'codex';
  readonly sessionKey = 'codex';
  readonly displayName = 'Codex CLI';

  private readonly command: string;
  private readonly prefixArgs: string[];
  private readonly defaultModel?: string;

  constructor(opts: CodexAdapterOptions = {}) {
    this.command = opts.command ?? 'codex';
    this.prefixArgs = opts.args ?? [];
    this.defaultModel = opts.defaultModel;
  }

  get commandLabel(): string {
    return [this.command, ...this.prefixArgs].join(' ');
  }

  get descriptor(): AgentDescriptor {
    return {
      id: this.id,
      label: this.displayName,
      runtime: 'json',
      sessionKey: this.sessionKey,
      commandLabel: this.commandLabel,
      supportsRetry: true,
      supportsWorkers: false,
    };
  }

  async isAvailable(): Promise<boolean> {
    return false;
  }

  canResumeSession(sessionId: string): boolean {
    return sessionId.trim().length > 0;
  }

  run(_opts: AgentRunOptions): AgentRun {
    throw new Error('CodexAdapter.run not implemented');
  }
}
```

This skeleton is replaced in Task 3.

- [ ] **Step 8: Wire factory to Codex**

In `src/agent/factory.ts`, add imports:

```ts
import { CodexAdapter } from './codex/adapter';
```

Add `getAgentCodexModel` to the config import list.

Before the final Claude return, add:

```ts
  if (command.backend === 'codex') {
    return new CodexAdapter({
      command: command.command,
      args: command.args,
      defaultModel: getAgentCodexModel(cfg),
    });
  }
```

- [ ] **Step 9: Run config and factory tests**

Run: `npm test -- test/config/schema.test.ts test/agent/factory.test.ts`

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/config/schema.ts src/agent/factory.ts src/agent/codex/adapter.ts test/config/schema.test.ts test/agent/factory.test.ts
git commit -m "feat: configure codex backend"
```

---

### Task 2: Codex JSONL event translation

**Files:**
- Create: `src/agent/codex/stream-json.ts`
- Create: `test/agent/codex/stream-json.test.ts`

- [ ] **Step 1: Write failing translator tests**

Create `test/agent/codex/stream-json.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { createCodexTranslator, translateCodexEvent } from '../../../src/agent/codex/stream-json';

describe('translateCodexEvent', () => {
  test('translates thread start into a system session event', () => {
    const translator = createCodexTranslator();

    expect([...translator.translate({ type: 'thread.started', thread_id: 'thread-1' })]).toEqual([
      { type: 'system', sessionId: 'thread-1' },
    ]);
  });

  test('translates agent messages into text deltas', () => {
    expect([
      ...translateCodexEvent({
        type: 'item.completed',
        item: { id: 'item-1', type: 'agent_message', text: 'hello' },
      }),
    ]).toEqual([{ type: 'text', delta: 'hello' }]);
  });

  test('translates command execution lifecycle into tool events', () => {
    const started = translateCodexEvent({
      type: 'item.started',
      item: { id: 'cmd-1', type: 'command_execution', command: 'npm test' },
    });
    const completed = translateCodexEvent({
      type: 'item.completed',
      item: {
        id: 'cmd-1',
        type: 'command_execution',
        command: 'npm test',
        output: 'ok',
        exit_code: 0,
      },
    });

    expect([...started]).toEqual([
      { type: 'tool_use', id: 'cmd-1', name: 'Bash', input: { command: 'npm test' } },
    ]);
    expect([...completed]).toEqual([
      { type: 'tool_result', id: 'cmd-1', output: 'ok', isError: false },
    ]);
  });

  test('marks command execution failures as tool errors', () => {
    expect([
      ...translateCodexEvent({
        type: 'item.completed',
        item: {
          id: 'cmd-1',
          type: 'command_execution',
          command: 'npm test',
          output: 'failed',
          exit_code: 1,
        },
      }),
    ]).toEqual([{ type: 'tool_result', id: 'cmd-1', output: 'failed', isError: true }]);
  });

  test('translates reasoning and plan updates into thinking/progress', () => {
    expect([
      ...translateCodexEvent({
        type: 'item.completed',
        item: { id: 'r1', type: 'reasoning', text: 'thinking' },
      }),
    ]).toEqual([{ type: 'thinking', delta: 'thinking' }]);

    expect([
      ...translateCodexEvent({
        type: 'item.completed',
        item: { id: 'p1', type: 'plan_update', text: 'checking files' },
      }),
    ]).toEqual([{ type: 'progress', phase: 'thinking', label: 'checking files' }]);
  });

  test('translates usage and done on turn completion with remembered session id', () => {
    const translator = createCodexTranslator();
    [...translator.translate({ type: 'thread.started', thread_id: 'thread-1' })];

    expect([
      ...translator.translate({
        type: 'turn.completed',
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    ]).toEqual([
      { type: 'usage', inputTokens: 10, outputTokens: 5 },
      { type: 'done', sessionId: 'thread-1' },
    ]);
  });

  test('translates failed turns and top-level errors', () => {
    expect([...translateCodexEvent({ type: 'turn.failed', error: { message: 'nope' } })]).toEqual([
      { type: 'error', message: 'nope' },
    ]);
    expect([...translateCodexEvent({ type: 'error', message: 'bad auth' })]).toEqual([
      { type: 'error', message: 'bad auth' },
    ]);
  });

  test('ignores unknown shapes', () => {
    expect([...translateCodexEvent({ type: 'unknown', item: { type: 'mystery' } })]).toEqual([]);
    expect([...translateCodexEvent(null)]).toEqual([]);
  });
});
```

- [ ] **Step 2: Run translator tests to verify failure**

Run: `npm test -- test/agent/codex/stream-json.test.ts`

Expected: FAIL because `src/agent/codex/stream-json.ts` does not exist.

- [ ] **Step 3: Implement translator**

Create `src/agent/codex/stream-json.ts`:

```ts
import type { AgentEvent } from '../types';

interface CodexRawEvent {
  type?: string;
  thread_id?: string;
  item?: CodexItem;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cached_input_tokens?: number;
    reasoning_output_tokens?: number;
  };
  error?: unknown;
  message?: string;
}

interface CodexItem {
  id?: string;
  type?: string;
  text?: string;
  summary?: string;
  command?: string;
  output?: unknown;
  exit_code?: number;
  status?: string;
}

export interface CodexTranslator {
  translate(raw: unknown): Generator<AgentEvent>;
}

export function createCodexTranslator(): CodexTranslator {
  let sessionId: string | undefined;
  return {
    *translate(raw: unknown): Generator<AgentEvent> {
      for (const event of translateCodexEvent(raw, sessionId)) {
        if (event.type === 'system' && event.sessionId) sessionId = event.sessionId;
        yield event;
      }
    },
  };
}

export function* translateCodexEvent(raw: unknown, rememberedSessionId?: string): Generator<AgentEvent> {
  if (!raw || typeof raw !== 'object') return;
  const evt = raw as CodexRawEvent;

  if (evt.type === 'thread.started' && typeof evt.thread_id === 'string' && evt.thread_id) {
    yield { type: 'system', sessionId: evt.thread_id };
    return;
  }

  if (evt.type === 'item.started' || evt.type === 'item.completed') {
    yield* translateItemEvent(evt);
    return;
  }

  if (evt.type === 'turn.completed') {
    if (evt.usage) {
      yield {
        type: 'usage',
        inputTokens: evt.usage.input_tokens,
        outputTokens: evt.usage.output_tokens,
      };
    }
    yield { type: 'done', sessionId: rememberedSessionId };
    return;
  }

  if (evt.type === 'turn.failed' || evt.type === 'error') {
    yield { type: 'error', message: errorMessage(evt.error ?? evt.message ?? evt) };
  }
}

function* translateItemEvent(evt: CodexRawEvent): Generator<AgentEvent> {
  const item = evt.item;
  if (!item || typeof item !== 'object') return;
  const id = typeof item.id === 'string' && item.id ? item.id : 'codex-item';

  if (item.type === 'agent_message' && evt.type === 'item.completed' && item.text) {
    yield { type: 'text', delta: item.text };
    return;
  }

  if (item.type === 'command_execution') {
    if (evt.type === 'item.started') {
      yield { type: 'tool_use', id, name: 'Bash', input: { command: item.command ?? '' } };
    } else if (evt.type === 'item.completed') {
      yield {
        type: 'tool_result',
        id,
        output: stringifyOutput(item.output),
        isError: typeof item.exit_code === 'number' ? item.exit_code !== 0 : item.status === 'failed',
      };
    }
    return;
  }

  if (item.type === 'reasoning' && evt.type === 'item.completed') {
    const text = item.text ?? item.summary;
    if (text) yield { type: 'thinking', delta: text };
    return;
  }

  if ((item.type === 'plan_update' || item.type === 'plan') && evt.type === 'item.completed') {
    const label = item.text ?? item.summary;
    if (label) yield { type: 'progress', phase: 'thinking', label };
  }
}

function stringifyOutput(output: unknown): string {
  if (typeof output === 'string') return output;
  if (output === undefined || output === null) return '';
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

function errorMessage(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.message === 'string') return record.message;
  }
  return String(value);
}
```

- [ ] **Step 4: Run translator tests**

Run: `npm test -- test/agent/codex/stream-json.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/codex/stream-json.ts test/agent/codex/stream-json.test.ts
git commit -m "feat: translate codex json events"
```

---

### Task 3: Codex process adapter

**Files:**
- Modify: `src/agent/codex/adapter.ts`
- Create: `test/agent/codex/adapter.test.ts`
- Modify: `test/agent/adapter-descriptor.test.ts`

- [ ] **Step 1: Write failing descriptor test**

In `test/agent/adapter-descriptor.test.ts`, add:

```ts
import { CodexAdapter } from '../../src/agent/codex/adapter';
```

Add this test inside `describe('agent descriptors', ...)`:

```ts
  test('describes Codex CLI json backend', () => {
    const adapter = new CodexAdapter({ command: 'codex-wrapper', args: ['--sandbox', 'workspace-write'] });

    expect(adapter.descriptor).toEqual({
      id: 'codex',
      label: 'Codex CLI',
      runtime: 'json',
      sessionKey: 'codex',
      commandLabel: 'codex-wrapper --sandbox workspace-write',
      supportsRetry: true,
      supportsWorkers: false,
    });
  });
```

- [ ] **Step 2: Write failing adapter tests**

Create `test/agent/codex/adapter.test.ts`:

```ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { CodexAdapter } from '../../../src/agent/codex/adapter';

function nodeCommand(script: string): { command: string; args: string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'codex-adapter-'));
  const file = join(dir, 'fake-codex.mjs');
  writeFileSync(file, script);
  return { command: process.execPath, args: [file] };
}

async function collectText(adapter: CodexAdapter, cwd: string, sessionId?: string): Promise<string[]> {
  const run = adapter.run({ prompt: 'hello', cwd, sessionId, model: 'gpt-test', stopGraceMs: 100 });
  const out: string[] = [];
  for await (const event of run.events) {
    if (event.type === 'text') out.push(event.delta);
    if (event.type === 'system' && event.sessionId) out.push(`session:${event.sessionId}`);
    if (event.type === 'done') out.push(`done:${event.sessionId ?? ''}`);
  }
  return out;
}

describe('CodexAdapter', () => {
  test('spawns codex exec json for a fresh run', async () => {
    const fake = nodeCommand(`
      const args = process.argv.slice(2);
      console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }));
      console.log(JSON.stringify({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: args.join(' ') } }));
      console.log(JSON.stringify({ type: 'turn.completed' }));
    `);
    const adapter = new CodexAdapter({ command: fake.command, args: fake.args });

    const events = await collectText(adapter, process.cwd());

    expect(events[0]).toBe('session:thread-1');
    expect(events[1]).toContain('exec --json -C');
    expect(events[1]).toContain('gpt-test');
    expect(events[1]).toContain('hello');
    expect(events[1]).not.toContain('resume thread-1');
    expect(events.at(-1)).toBe('done:thread-1');
  });

  test('spawns codex exec resume for a resumed run', async () => {
    const fake = nodeCommand(`
      const args = process.argv.slice(2);
      console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thread-2' }));
      console.log(JSON.stringify({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: args.join(' ') } }));
      console.log(JSON.stringify({ type: 'turn.completed' }));
    `);
    const adapter = new CodexAdapter({ command: fake.command, args: fake.args });

    const events = await collectText(adapter, process.cwd(), 'thread-existing');

    expect(events[1]).toContain('exec --json -C');
    expect(events[1]).toContain('resume thread-existing hello');
  });

  test('reports a missing working directory before spawning codex', async () => {
    const adapter = new CodexAdapter({ command: process.execPath });
    const missing = join(tmpdir(), `missing-codex-${process.pid}-${Date.now()}`);
    const run = adapter.run({ prompt: 'hello', cwd: missing });
    const messages: string[] = [];

    for await (const event of run.events) {
      if (event.type === 'error') messages.push(event.message);
    }

    expect(messages).toEqual([
      `working directory does not exist: ${missing}. Use /cd to switch this chat to a valid path.`,
    ]);
  });

  test('surfaces non-zero exit with stderr when codex emits no terminal error', async () => {
    const fake = nodeCommand(`
      console.error('auth failed');
      process.exit(7);
    `);
    const adapter = new CodexAdapter({ command: fake.command, args: fake.args });
    const run = adapter.run({ prompt: 'hello', cwd: process.cwd() });
    const messages: string[] = [];

    for await (const event of run.events) {
      if (event.type === 'error') messages.push(event.message);
    }

    expect(messages[0]).toContain('codex exited with code 7: auth failed');
  });

  test('accepts non-empty session ids for resume', () => {
    const adapter = new CodexAdapter();

    expect(adapter.canResumeSession?.('thread-1')).toBe(true);
    expect(adapter.canResumeSession?.('')).toBe(false);
  });
});
```

- [ ] **Step 3: Run adapter tests to verify failure**

Run: `npm test -- test/agent/codex/adapter.test.ts test/agent/adapter-descriptor.test.ts`

Expected: FAIL because `CodexAdapter.run` skeleton throws and descriptor import/test may not exist.

- [ ] **Step 4: Implement process-backed CodexAdapter**

Replace `src/agent/codex/adapter.ts` with:

```ts
import type { ChildProcessByStdio } from 'node:child_process';
import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { log } from '../../core/logger';
import type { AgentAdapter, AgentDescriptor, AgentEvent, AgentRun, AgentRunOptions } from '../types';
import { createCodexTranslator } from './stream-json';

export interface CodexAdapterOptions {
  command?: string;
  args?: string[];
  defaultModel?: string;
}

type CodexChild = ChildProcessByStdio<null, Readable, Readable>;

export class CodexAdapter implements AgentAdapter {
  readonly id = 'codex';
  readonly sessionKey = 'codex';
  readonly displayName = 'Codex CLI';

  private readonly command: string;
  private readonly prefixArgs: string[];
  private readonly defaultModel?: string;

  constructor(opts: CodexAdapterOptions = {}) {
    this.command = opts.command ?? 'codex';
    this.prefixArgs = opts.args ?? [];
    this.defaultModel = opts.defaultModel;
  }

  get commandLabel(): string {
    return [this.command, ...this.prefixArgs].join(' ');
  }

  get descriptor(): AgentDescriptor {
    return {
      id: this.id,
      label: this.displayName,
      runtime: 'json',
      sessionKey: this.sessionKey,
      commandLabel: this.commandLabel,
      supportsRetry: true,
      supportsWorkers: false,
    };
  }

  async isAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      const child = spawn(this.command, [...this.prefixArgs, '--version'], { stdio: 'ignore' });
      child.on('error', () => resolve(false));
      child.on('exit', (code) => resolve(code === 0));
    });
  }

  canResumeSession(sessionId: string): boolean {
    return sessionId.trim().length > 0;
  }

  run(opts: AgentRunOptions): AgentRun {
    if (opts.cwd) {
      const cwdError = validateWorkingDirectory(opts.cwd);
      if (cwdError) return errorRun(cwdError);
    }

    const model = opts.model ?? this.defaultModel;
    const codexArgs = [...this.prefixArgs, 'exec', '--json'];
    if (opts.cwd) codexArgs.push('-C', opts.cwd);
    if (model) codexArgs.push('--model', model);
    if (opts.sessionId) codexArgs.push('resume', opts.sessionId, opts.prompt);
    else codexArgs.push(opts.prompt);

    const child = spawn(this.command, codexArgs, {
      cwd: opts.cwd,
      env: { ...process.env, LARK_CHANNEL: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    log.info('agent', 'spawn', {
      pid: child.pid ?? null,
      command: this.commandLabel,
      cwd: opts.cwd ?? process.cwd(),
      hasSession: Boolean(opts.sessionId),
      promptChars: opts.prompt.length,
      model,
      runtime: 'codex',
    });

    const stderrChunks: Buffer[] = [];
    let stderrBuffer = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
      stderrBuffer += chunk.toString('utf8');
      let nl = stderrBuffer.indexOf('\n');
      while (nl !== -1) {
        const line = stderrBuffer.slice(0, nl);
        stderrBuffer = stderrBuffer.slice(nl + 1);
        if (line.trim()) log.warn('agent', 'stderr', { line });
        nl = stderrBuffer.indexOf('\n');
      }
    });

    let runtimeError: Error | null = null;
    child.on('error', (err) => {
      runtimeError = err;
    });
    child.on('exit', (code, signal) => {
      log.info('agent', 'exit', { pid: child.pid ?? null, code, signal, runtime: 'codex' });
    });

    const stopGraceMs = opts.stopGraceMs ?? 5000;

    return {
      events: createEventStream(child, stderrChunks, () => runtimeError, this.commandLabel),
      async stop() {
        if (child.exitCode !== null || child.signalCode !== null) return;
        log.info('agent', 'stop-sigterm', { pid: child.pid ?? null, graceMs: stopGraceMs });
        child.kill('SIGTERM');
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) {
              log.warn('agent', 'stop-sigkill', {
                pid: child.pid ?? null,
                graceMs: stopGraceMs,
                reason: 'grace-period-expired',
              });
              child.kill('SIGKILL');
            }
            resolve();
          }, stopGraceMs);
          child.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
        });
      },
      waitForExit(timeoutMs: number): Promise<boolean> {
        if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
        return new Promise<boolean>((resolve) => {
          const onExit = (): void => {
            clearTimeout(timer);
            resolve(true);
          };
          const timer = setTimeout(() => {
            child.removeListener('exit', onExit);
            resolve(false);
          }, timeoutMs);
          child.once('exit', onExit);
        });
      },
    };
  }
}

export function validateWorkingDirectory(cwd: string): string | undefined {
  try {
    if (!statSync(cwd).isDirectory()) {
      return `working directory is not a directory: ${cwd}. Use /cd to switch this chat to a valid path.`;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return `working directory does not exist: ${cwd}. Use /cd to switch this chat to a valid path.`;
    }
    return `working directory is not accessible: ${cwd}: ${(err as Error).message}`;
  }
  return undefined;
}

function errorRun(message: string): AgentRun {
  return {
    events: (async function* (): AsyncGenerator<AgentEvent> {
      yield { type: 'error', message };
    })(),
    async stop() {},
    async waitForExit() {
      return true;
    },
  };
}

async function* createEventStream(
  child: CodexChild,
  stderrChunks: Buffer[],
  getError: () => Error | null,
  commandLabel: string,
): AsyncGenerator<AgentEvent> {
  if (!child.pid) {
    const err = getError();
    yield {
      type: 'error',
      message: err ? `failed to spawn ${commandLabel}: ${err.message}` : 'spawn returned no pid',
    };
    return;
  }

  const translator = createCodexTranslator();
  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let emittedTerminal = false;
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      for (const event of translator.translate(parsed)) {
        if (event.type === 'done' || event.type === 'error') emittedTerminal = true;
        yield event;
      }
    }
  } finally {
    rl.close();
  }

  const exitCode = await new Promise<number | null>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve(child.exitCode);
    else child.once('exit', (code) => resolve(code));
  });

  const runtimeError = getError();
  if (!emittedTerminal && exitCode !== 0 && exitCode !== null) {
    const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
    const detail = stderr ? `: ${stderr.slice(0, 500)}` : '';
    yield { type: 'error', message: `codex exited with code ${exitCode}${detail}` };
  } else if (!emittedTerminal && runtimeError) {
    yield { type: 'error', message: `codex runtime error: ${runtimeError.message}` };
  }
}
```

- [ ] **Step 5: Run adapter tests**

Run: `npm test -- test/agent/codex/adapter.test.ts test/agent/adapter-descriptor.test.ts`

Expected: PASS.

- [ ] **Step 6: Run typecheck**

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/agent/codex/adapter.ts test/agent/codex/adapter.test.ts test/agent/adapter-descriptor.test.ts
git commit -m "feat: add codex process adapter"
```

---

### Task 4: Session integration and docs

**Files:**
- Modify: `README.md`
- Modify: `README.zh.md`
- Test: affected and full test suite

- [ ] **Step 1: Update English README**

In `README.md`, update prerequisites line from:

```md
- A supported coding-agent command installed and logged in. By default the bridge runs `claude`; it can also use compatible wrappers through `agentCommand`, or Cursor CLI's `agent` command.
```

to:

```md
- A supported coding-agent command installed and logged in. By default the bridge runs `claude`; it can also use compatible wrappers through `agentCommand`, Cursor CLI's `agent` command, or Codex CLI's `codex` command.
```

After the Cursor backend section, add:

```md
### Codex backend (`codex exec --json`)

To use Codex CLI, configure the Codex backend. The bridge runs `codex exec --json` non-interactively, translates Codex JSONL events into streaming cards, and stores the Codex `thread_id` as the chat session id so follow-up messages resume with `codex exec resume`.

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

The bridge cannot answer Codex's interactive approval prompts mid-run. For unattended chat use, configure Codex with non-interactive approval behavior such as `--ask-for-approval never`; keep sandboxing conservative (`workspace-write`) unless the host is externally sandboxed and you explicitly accept the risk of broader access.
```

Ensure markdown fences are balanced.

- [ ] **Step 2: Update Chinese README**

In `README.zh.md`, update prerequisites line to mention Codex CLI `codex`.

After the Cursor backend section, add a Chinese Codex section equivalent to:

```md
### Codex backend（`codex exec --json`）

要使用 Codex CLI，可以配置 Codex backend。bridge 会以非交互方式运行 `codex exec --json`，把 Codex JSONL 事件转换成流式卡片，并把 Codex `thread_id` 保存为当前 chat 的 session id，后续消息会用 `codex exec resume` 续上。

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

bridge 无法在运行中替 Codex 回答交互式审批提示。用于聊天里的无人值守运行时，建议配置非交互审批，例如 `--ask-for-approval never`；sandbox 建议保持 `workspace-write`，除非宿主环境已有外部隔离且你明确接受更高权限的风险。
```

- [ ] **Step 3: Run focused tests**

Run:

```bash
npm test -- test/config/schema.test.ts test/agent/factory.test.ts test/agent/codex/stream-json.test.ts test/agent/codex/adapter.test.ts test/agent/adapter-descriptor.test.ts test/session/ensure-resume.test.ts test/bot/channel.test.ts
```

Expected: PASS.

- [ ] **Step 4: Run full verification**

Run: `npm test`

Expected: PASS.

Run: `npm run typecheck`

Expected: PASS.

Run: `npm run build`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add README.md README.zh.md
git commit -m "docs: document codex backend"
```

If final verification required code/test fixes, add those specific files too and use:

```bash
git add README.md README.zh.md <fixed-files>
git commit -m "fix: stabilize codex backend"
```

---

## Self-Review

- Spec coverage: The plan covers Codex config, factory wiring, JSONL translation, process-backed adapter, session resume, stop/wait behavior, error handling, tests, and docs.
- Placeholder scan: No TBD/TODO placeholders remain; code snippets and commands are concrete.
- Type consistency: `AgentBackend`, `agentCodexModel`, `getAgentCodexModel`, `CodexAdapter`, `createCodexTranslator`, and `translateCodexEvent` names are consistent across tasks.

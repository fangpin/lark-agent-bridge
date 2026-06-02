# Codex Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the remaining Codex/backend setup gaps found in review so Codex behavior matches bridge safety rules and setup diagnostics are bounded and accurate.

**Architecture:** Keep changes localized to the Codex adapter/translator and setup diagnostics. Reuse existing Claude bridge prompt text, timeout utilities, secret resolver, and session-key isolation patterns; add focused regression tests for each reviewed failure mode.

**Tech Stack:** TypeScript, Node.js 20, Vitest, existing `AgentAdapter`/`AgentEvent` interfaces, Codex CLI JSONL adapter.

---

## File Structure

- `src/agent/codex/adapter.ts` — wrap Codex prompts with the bridge system prompt, add `--` separators for prompt argv, derive config-bound `sessionKey`.
- `src/agent/codex/stream-json.ts` — handle `item.updated`, remember top-level error diagnostics, expose terminal fallback signal to adapter.
- `src/doctor/setup.ts` — add bounded `agent.isAvailable`, app secret resolution check, direct Codex info status.
- `src/agent/factory.ts` — pass Codex session-key inputs if constructor shape changes.
- `test/agent/codex/adapter.test.ts` — command shape, bridge prompt, dash prompt, session key tests.
- `test/agent/codex/stream-json.test.ts` — top-level error finalization and `item.updated` tests.
- `test/doctor/setup.test.ts` — timeout, secret resolution, direct Codex info tests.
- `test/agent/adapter-descriptor.test.ts`, `test/agent/factory.test.ts` — update expected session key shape if needed.

---

### Task 1: Codex prompt contract and dash-safe argv

**Files:**
- Modify: `src/agent/codex/adapter.ts`
- Modify: `test/agent/codex/adapter.test.ts`

- [ ] **Step 1: Add failing bridge prompt and dash prompt tests**

Append to `test/agent/codex/adapter.test.ts`:

```ts
test('wraps prompts with the bridge system prompt contract', async () => {
  const fake = nodeCommand(`
    const args = process.argv.slice(2);
    console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thread-prompt' }));
    console.log(JSON.stringify({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: args.at(-1) } }));
    console.log(JSON.stringify({ type: 'turn.completed' }));
  `);
  const adapter = new CodexAdapter({ command: fake.command, args: fake.args });

  const events = await collectText(adapter, process.cwd());

  expect(events[1]).toContain('<bridge_system_prompt>');
  expect(events[1]).toContain('<user_prompt>');
  expect(events[1]).toContain('hello');
  expect(events[1]).toContain('__claude_cb');
});

test('separates resume prompts that start with dash from codex options', async () => {
  const fake = nodeCommand(`
    const args = process.argv.slice(2);
    console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thread-dash' }));
    console.log(JSON.stringify({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: JSON.stringify(args) } }));
    console.log(JSON.stringify({ type: 'turn.completed' }));
  `);
  const adapter = new CodexAdapter({ command: fake.command, args: fake.args });
  const run = adapter.run({ prompt: '--help', cwd: process.cwd(), sessionId: 'thread-existing', stopGraceMs: 100 });
  const out: string[] = [];
  for await (const event of run.events) {
    if (event.type === 'text') out.push(event.delta);
  }

  const argv = JSON.parse(out[0]!) as string[];
  const resumeIndex = argv.indexOf('resume');
  expect(argv.slice(resumeIndex, resumeIndex + 4)).toEqual(['resume', 'thread-existing', '--', expect.stringContaining('--help')]);
});
```

- [ ] **Step 2: Run adapter tests to verify failure**

Run: `npm test -- test/agent/codex/adapter.test.ts`

Expected: FAIL because Codex currently passes raw prompt and no `--` separator.

- [ ] **Step 3: Import bridge prompt and add Codex prompt wrapper**

In `src/agent/codex/adapter.ts`, add:

```ts
import { BRIDGE_SYSTEM_PROMPT } from '../claude/adapter';
```

Add helper near existing shell helpers:

```ts
export function buildCodexPrompt(prompt: string): string {
  return `<bridge_system_prompt>\n${BRIDGE_SYSTEM_PROMPT}\n</bridge_system_prompt>\n\n<user_prompt>\n${prompt}\n</user_prompt>`;
}
```

- [ ] **Step 4: Use wrapped prompt and `--` separator**

In `run(opts)`, add:

```ts
const prompt = buildCodexPrompt(opts.prompt);
```

Replace:

```ts
if (opts.sessionId) codexArgs.push('resume', opts.sessionId, opts.prompt);
else codexArgs.push(opts.prompt);
```

with:

```ts
if (opts.sessionId) codexArgs.push('resume', opts.sessionId, '--', prompt);
else codexArgs.push('--', prompt);
```

- [ ] **Step 5: Run adapter tests**

Run: `npm test -- test/agent/codex/adapter.test.ts`

Expected: PASS after updating any existing command-shape assertions to account for `--` and wrapped prompt.

---

### Task 2: Config-bound Codex session keys

**Files:**
- Modify: `src/agent/codex/adapter.ts`
- Modify: `test/agent/codex/adapter.test.ts`
- Modify: `test/agent/adapter-descriptor.test.ts`
- Modify: `test/agent/factory.test.ts`

- [ ] **Step 1: Add failing session key tests**

Append to `test/agent/codex/adapter.test.ts`:

```ts
test('isolates codex sessions by command, wrapper args, and args option', () => {
  const direct = new CodexAdapter({ command: 'codex' });
  const wrappedA = new CodexAdapter({ command: 'ttadk', args: ['--profile', 'a'], codexArgsOption: '--claude-args' });
  const wrappedB = new CodexAdapter({ command: 'ttadk', args: ['--profile', 'b'], codexArgsOption: '--claude-args' });

  expect(direct.sessionKey).toMatch(/^codex:/);
  expect(wrappedA.sessionKey).toMatch(/^codex:/);
  expect(new Set([direct.sessionKey, wrappedA.sessionKey, wrappedB.sessionKey]).size).toBe(3);
});
```

- [ ] **Step 2: Run adapter tests to verify failure**

Run: `npm test -- test/agent/codex/adapter.test.ts test/agent/adapter-descriptor.test.ts test/agent/factory.test.ts`

Expected: FAIL because sessionKey is currently fixed `codex` and descriptor/factory tests expect it.

- [ ] **Step 3: Implement stable config hash**

In `src/agent/codex/adapter.ts`, import crypto:

```ts
import { createHash } from 'node:crypto';
```

Change class field:

```ts
readonly sessionKey: string;
```

In constructor after fields are assigned, add:

```ts
this.sessionKey = codexSessionKey(this.command, this.prefixArgs, this.codexArgsOption);
```

Add helper:

```ts
function codexSessionKey(command: string, args: string[], codexArgsOption: string | undefined): string {
  const hash = createHash('sha1')
    .update(JSON.stringify({ command, args, codexArgsOption: codexArgsOption ?? '' }))
    .digest('hex')
    .slice(0, 10);
  return `codex:${hash}`;
}
```

- [ ] **Step 4: Update descriptor/factory expectations**

In `test/agent/adapter-descriptor.test.ts`, update Codex descriptor assertion:

```ts
expect(adapter.descriptor).toMatchObject({
  id: 'codex',
  label: 'Codex CLI',
  runtime: 'json',
  commandLabel: 'codex-wrapper --sandbox workspace-write',
  supportsRetry: true,
  supportsWorkers: false,
});
expect(adapter.descriptor.sessionKey).toMatch(/^codex:/);
```

In `test/agent/factory.test.ts`, update `expect(adapter.sessionKey).toBe('codex')` to:

```ts
expect(adapter.sessionKey).toMatch(/^codex:/);
```

- [ ] **Step 5: Run focused tests**

Run: `npm test -- test/agent/codex/adapter.test.ts test/agent/adapter-descriptor.test.ts test/agent/factory.test.ts test/session/ensure-resume.test.ts`

Expected: PASS.

---

### Task 3: Codex `item.updated` progress and terminal fallback for top-level errors

**Files:**
- Modify: `src/agent/codex/stream-json.ts`
- Modify: `src/agent/codex/adapter.ts`
- Modify: `test/agent/codex/stream-json.test.ts`
- Modify: `test/agent/codex/adapter.test.ts`

- [ ] **Step 1: Add failing translator tests**

Append to `test/agent/codex/stream-json.test.ts`:

```ts
test('translates command item updates into progress to refresh activity', () => {
  expect([
    ...translateCodexEvent({
      type: 'item.updated',
      item: { id: 'cmd-1', type: 'command_execution', command: 'npm test', aggregated_output: 'still running' },
    }),
  ]).toEqual([{ type: 'progress', phase: 'tool_running', label: 'npm test', detail: 'still running' }]);
});

test('records top-level codex errors without making them terminal immediately', () => {
  const translator = createCodexTranslator();

  expect([...translator.translate({ type: 'error', message: 'authentication required' })]).toEqual([
    { type: 'progress', phase: 'thinking', label: 'authentication required' },
  ]);
  expect(translator.lastTopLevelError()).toBe('authentication required');
});
```

- [ ] **Step 2: Add failing adapter terminal fallback test**

Append to `test/agent/codex/adapter.test.ts`:

```ts
test('surfaces top-level codex errors as terminal when no completion follows', async () => {
  const fake = nodeCommand(`
    console.log(JSON.stringify({ type: 'error', message: 'authentication required' }));
  `);
  const adapter = new CodexAdapter({ command: fake.command, args: fake.args });
  const run = adapter.run({ prompt: 'hello', cwd: process.cwd(), stopGraceMs: 100 });
  const events: string[] = [];

  for await (const event of run.events) {
    if (event.type === 'error') events.push(event.message);
  }

  expect(events).toEqual(['authentication required']);
});
```

- [ ] **Step 3: Run tests to verify failure**

Run: `npm test -- test/agent/codex/stream-json.test.ts test/agent/codex/adapter.test.ts`

Expected: FAIL because `item.updated` and terminal fallback are missing.

- [ ] **Step 4: Extend translator state**

In `src/agent/codex/stream-json.ts`, update `CodexTranslator`:

```ts
export interface CodexTranslator {
  translate(raw: unknown): Generator<AgentEvent>;
  lastTopLevelError(): string | undefined;
}
```

In `createCodexTranslator`, track:

```ts
let lastTopLevelError: string | undefined;
```

When processing raw object with `type === 'error'`, set `lastTopLevelError` to the message. Return the accessor.

- [ ] **Step 5: Implement `item.updated` progress**

In `translateCodexEvent`, route `item.updated` to `translateItemEvent`.

In `translateItemEvent`, for `command_execution` and `evt.type === 'item.updated'`, yield:

```ts
{
  type: 'progress',
  phase: 'tool_running',
  label: item.command ?? 'Codex command',
  detail: summarizeText(stringifyOutput(item.aggregated_output ?? item.output)),
}
```

Add helper:

```ts
function summarizeText(text: string): string | undefined {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (!compact) return undefined;
  return compact.length > 120 ? `${compact.slice(0, 120)}…` : compact;
}
```

- [ ] **Step 6: Use top-level error terminal fallback in adapter**

In `src/agent/codex/adapter.ts`, after process exit and before runtimeError fallback, add:

```ts
const topLevelError = translator.lastTopLevelError();
if (!emittedTerminal && topLevelError) {
  yield { type: 'error', message: topLevelError };
  return;
}
```

Place this after nonzero code/signal handling and before runtimeError.

- [ ] **Step 7: Run focused tests**

Run: `npm test -- test/agent/codex/stream-json.test.ts test/agent/codex/adapter.test.ts`

Expected: PASS.

---

### Task 4: Bounded setup diagnostics and app secret check

**Files:**
- Modify: `src/doctor/setup.ts`
- Modify: `test/doctor/setup.test.ts`

- [ ] **Step 1: Add failing timeout and secret tests**

Append to `test/doctor/setup.test.ts`:

```ts
test('marks agent availability as failed when it times out', async () => {
  vi.useFakeTimers();
  const pending = new Promise<boolean>(() => {});
  const resultPromise = runSetupDiagnostics({
    cfg: cfg({ agentCommand: { backend: 'codex', command: 'ttadk' } }),
    configPath: '/tmp/config.json',
    agent: agent({ isAvailable: vi.fn(() => pending) }),
    cwd: process.cwd(),
    sameAppProcesses: [],
    timeouts: { agentAvailableMs: 100, secretResolveMs: 100 },
  });

  await vi.advanceTimersByTimeAsync(100);
  const result = await resultPromise;
  vi.useRealTimers();

  expect(result.checks).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'agent.available', status: 'fail', detail: expect.stringContaining('timed out') }),
  ]));
});

test('checks that the Lark app secret can resolve without revealing it', async () => {
  const result = await runSetupDiagnostics({
    cfg: cfg({}),
    configPath: '/tmp/config.json',
    agent: agent(),
    cwd: process.cwd(),
    sameAppProcesses: [],
    resolveAppSecret: async () => 'super-secret-value',
  });

  expect(result.checks).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'app.secret', status: 'pass' }),
  ]));
  expect(JSON.stringify(result)).not.toContain('super-secret-value');
});

test('reports app secret resolution failures', async () => {
  const result = await runSetupDiagnostics({
    cfg: cfg({}),
    configPath: '/tmp/config.json',
    agent: agent(),
    cwd: process.cwd(),
    sameAppProcesses: [],
    resolveAppSecret: async () => { throw new Error('missing env'); },
  });

  expect(result.summary.status).toBe('fail');
  expect(result.checks).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'app.secret', status: 'fail', detail: expect.stringContaining('missing env') }),
  ]));
});

test('reports direct codex mode as informational, not warning', async () => {
  const result = await runSetupDiagnostics({
    cfg: cfg({ agentCommand: { backend: 'codex', command: 'codex' } }),
    configPath: '/tmp/config.json',
    agent: agent(),
    cwd: process.cwd(),
    sameAppProcesses: [],
  });

  expect(result.checks).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'codex.wrapper', status: 'info' }),
  ]));
});
```

- [ ] **Step 2: Run diagnostics tests to verify failure**

Run: `npm test -- test/doctor/setup.test.ts`

Expected: FAIL because timeout/options/secret checks and direct Codex info behavior are missing.

- [ ] **Step 3: Extend diagnostics input**

In `src/doctor/setup.ts`, import:

```ts
import { resolveAppSecret } from '../config/secret-resolver';
```

Extend `SetupDiagnosticsInput`:

```ts
  timeouts?: { agentAvailableMs?: number; secretResolveMs?: number };
  resolveAppSecret?: (cfg: AppConfig) => Promise<string>;
```

Add constants:

```ts
const DEFAULT_AGENT_AVAILABLE_TIMEOUT_MS = 5_000;
const DEFAULT_SECRET_RESOLVE_TIMEOUT_MS = 5_000;
```

Add helper:

```ts
async function withTimeoutResult<T>(promise: Promise<T>, timeoutMs: number): Promise<{ ok: true; value: T } | { ok: false; error: Error }> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then((value) => ({ ok: true as const, value })).catch((err) => ({ ok: false as const, error: err instanceof Error ? err : new Error(String(err)) })),
      new Promise<{ ok: false; error: Error }>((resolve) => {
        timer = setTimeout(() => resolve({ ok: false, error: new Error(`timed out after ${timeoutMs}ms`) }), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
```

- [ ] **Step 4: Bound `agent.isAvailable`**

Replace the availability await with:

```ts
  const availability = await withTimeoutResult(
    input.agent.isAvailable(),
    input.timeouts?.agentAvailableMs ?? DEFAULT_AGENT_AVAILABLE_TIMEOUT_MS,
  );
  const available = availability.ok ? availability.value : false;
  checks.push({
    id: 'agent.available',
    status: available ? 'pass' : 'fail',
    title: 'Agent command available',
    detail: availability.ok ? input.agent.commandLabel : `${input.agent.commandLabel}: ${availability.error.message}`,
    suggestion: available ? undefined : 'Check preferences.agentCommand.command, wrapper args, PATH, or backend login/auth.',
  });
```

- [ ] **Step 5: Add app secret check**

After `config.complete`, add:

```ts
  const secretResolver = input.resolveAppSecret ?? resolveAppSecret;
  const secretResult = await withTimeoutResult(
    secretResolver(input.cfg),
    input.timeouts?.secretResolveMs ?? DEFAULT_SECRET_RESOLVE_TIMEOUT_MS,
  );
  checks.push({
    id: 'app.secret',
    status: secretResult.ok ? 'pass' : 'fail',
    title: 'App secret',
    detail: secretResult.ok ? 'Secret resolved.' : secretResult.error.message,
    suggestion: secretResult.ok ? undefined : 'Check accounts.app.secret, env vars, file refs, or exec secret provider.',
  });
```

Do not include the secret value in detail.

- [ ] **Step 6: Make direct Codex informational**

Change Codex wrapper check status to always `info`:

```ts
status: 'info',
```

Keep the suggestion for missing `codexArgsOption` if helpful, but it must not affect summary.

- [ ] **Step 7: Run diagnostics tests**

Run: `npm test -- test/doctor/setup.test.ts`

Expected: PASS.

---

### Task 5: Verification and documentation touch-up

**Files:**
- Modify: `README.md`
- Modify: `README.zh.md`
- Test: focused and full verification

- [ ] **Step 1: Update setup diagnostics docs**

In `README.md`, update the setup diagnostics paragraph to mention app secret resolution and bounded checks:

```md
The check reports config completeness, app-secret resolvability, backend command availability, cwd accessibility, Codex wrapper mode, Cursor runtime settings, chat access allowlists, and duplicate bot processes. Checks are bounded and do not perform a real model call, so they can catch wrapper/auth/PATH/secret issues without consuming tokens.
```

In `README.zh.md`, update the equivalent paragraph:

```md
自检会报告 config 是否完整、App Secret 是否能解析、backend 命令是否可运行、cwd 是否可访问、Codex wrapper 模式、Cursor runtime 设置、当前 chat 权限白名单，以及是否有重复 bot 进程。检查有超时边界，且不会发起真实模型调用，所以适合排查 wrapper/auth/PATH/secret 问题且不消耗 token。
```

- [ ] **Step 2: Run focused tests**

Run:

```bash
npm test -- test/agent/codex/adapter.test.ts test/agent/codex/stream-json.test.ts test/agent/adapter-descriptor.test.ts test/agent/factory.test.ts test/session/ensure-resume.test.ts test/doctor/setup.test.ts test/commands/doctor-setup.test.ts test/cli/start-check.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run full verification**

Run: `npm test`

Expected: PASS.

Run: `npm run typecheck`

Expected: PASS.

Run: `npm run build`

Expected: PASS.

---

## Self-Review

- Spec coverage: The plan covers bridge system prompt, setup timeouts, app secret diagnostics, top-level error terminal fallback, dash-safe prompts, item.updated progress, direct Codex info status, and config-bound Codex session keys.
- Placeholder scan: No TBD/TODO placeholders remain; all test and code snippets are concrete.
- Type consistency: `buildCodexPrompt`, `codexSessionKey`, `lastTopLevelError`, diagnostics timeout fields, and `resolveAppSecret` injection are named consistently.

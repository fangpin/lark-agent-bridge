# Codex Wrapper Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Codex backend work through `ttadk`/wrapper commands by passing generated Codex argv through a configurable single option, and avoid failing recoverable Codex runs on transient top-level JSONL errors.

**Architecture:** Extend the existing `AgentCommandConfig` with `codexArgsOption`, mirroring Claude's `claudeArgsOption`. Keep command construction inside `CodexAdapter`, using normal argv for direct Codex and shell-joined generated argv for wrapper mode; update the Codex JSONL translator so `turn.failed` remains terminal while top-level `error` becomes progress.

**Tech Stack:** TypeScript, Node.js 20, Vitest, existing process-backed `AgentAdapter` pattern.

---

## File Structure

- `src/config/schema.ts` — add `codexArgsOption?: string` to `AgentCommandConfig`, return it only for Codex configs.
- `src/agent/factory.ts` — pass `codexArgsOption` into `CodexAdapter`.
- `src/agent/codex/adapter.ts` — add Codex argv shell joining and wrapper-mode command construction for run and availability checks.
- `src/agent/codex/stream-json.ts` — translate top-level `error` events to progress instead of terminal errors.
- `test/config/schema.test.ts` — cover `codexArgsOption` parsing and backend isolation.
- `test/agent/factory.test.ts` — verify factory passes wrapper option through observable adapter behavior.
- `test/agent/codex/adapter.test.ts` — cover direct mode remains unchanged, wrapper mode run args, wrapper mode `--version`, and no-auth fake-script behavior.
- `test/agent/codex/stream-json.test.ts` — cover transient top-level error vs terminal `turn.failed`.
- `README.md`, `README.zh.md` — document `ttadk` wrapper configuration for Codex.

---

### Task 1: Config and factory support for `codexArgsOption`

**Files:**
- Modify: `src/config/schema.ts`
- Modify: `src/agent/factory.ts`
- Modify: `test/config/schema.test.ts`
- Modify: `test/agent/factory.test.ts`

- [ ] **Step 1: Add failing config tests**

Append to `test/config/schema.test.ts`:

```ts
test('preserves codex args option only for codex backend', () => {
  expect(
    getAgentCommand(
      cfg({
        agentCommand: {
          backend: 'codex',
          command: 'ttadk',
          args: ['--profile', 'dev'],
          codexArgsOption: '--claude-args',
        },
      }),
    ),
  ).toEqual({
    backend: 'codex',
    command: 'ttadk',
    args: ['--profile', 'dev'],
    codexArgsOption: '--claude-args',
  });

  expect(
    getAgentCommand(
      cfg({
        agentCommand: {
          backend: 'claude',
          command: 'ttadk',
          codexArgsOption: '--claude-args',
        },
      }),
    ),
  ).toEqual({ backend: 'claude', command: 'ttadk', args: [] });
});
```

- [ ] **Step 2: Run config tests to verify failure**

Run: `npm test -- test/config/schema.test.ts`

Expected: FAIL because `codexArgsOption` is not typed/returned.

- [ ] **Step 3: Implement schema support**

In `src/config/schema.ts`, update `AgentCommandConfig`:

```ts
export interface AgentCommandConfig {
  backend?: AgentBackend;
  command?: string;
  args?: string[];
  claudeArgsOption?: string;
  codexArgsOption?: string;
}
```

Update `getAgentCommand` return type:

```ts
): {
  backend: AgentBackend;
  command: string;
  args: string[];
  claudeArgsOption?: string;
  codexArgsOption?: string;
} {
```

Add this after `claudeArgsOption` is computed:

```ts
  const codexArgsOption = backend === 'codex' && typeof raw?.codexArgsOption === 'string' && raw.codexArgsOption.trim()
    ? raw.codexArgsOption.trim()
    : undefined;
```

Return it:

```ts
  return {
    backend,
    command,
    args,
    ...(claudeArgsOption ? { claudeArgsOption } : {}),
    ...(codexArgsOption ? { codexArgsOption } : {}),
  };
```

- [ ] **Step 4: Run config tests**

Run: `npm test -- test/config/schema.test.ts`

Expected: PASS.

- [ ] **Step 5: Add failing factory test coverage**

In `test/agent/factory.test.ts`, update the Codex factory test config to include:

```ts
codexArgsOption: '--claude-args',
```

Then add this assertion:

```ts
expect(adapter.commandLabel).toBe('codex-wrapper --sandbox workspace-write');
```

The observable wrapper behavior is covered in Task 2 adapter tests; factory only needs to prove the option is accepted and does not break construction.

- [ ] **Step 6: Update factory wiring**

In `src/agent/factory.ts`, pass the option into CodexAdapter:

```ts
return new CodexAdapter({
  command: command.command,
  args: command.args,
  codexArgsOption: command.codexArgsOption,
  defaultModel: getAgentCodexModel(cfg),
});
```

- [ ] **Step 7: Verify Task 1**

Run: `npm test -- test/config/schema.test.ts test/agent/factory.test.ts`

Expected: PASS.

Run: `npm run typecheck`

Expected: PASS.

---

### Task 2: Codex adapter wrapper argv construction

**Files:**
- Modify: `src/agent/codex/adapter.ts`
- Modify: `test/agent/codex/adapter.test.ts`

- [ ] **Step 1: Add failing wrapper run test**

Append to `test/agent/codex/adapter.test.ts`:

```ts
test('passes generated codex args through wrapper option when configured', async () => {
  const fake = nodeCommand(`
    const args = process.argv.slice(2);
    console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thread-wrapper' }));
    console.log(JSON.stringify({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: JSON.stringify(args) } }));
    console.log(JSON.stringify({ type: 'turn.completed' }));
  `);
  const adapter = new CodexAdapter({
    command: fake.command,
    args: [...fake.args, '--profile', 'dev'],
    codexArgsOption: '--claude-args',
    defaultModel: 'gpt-wrapper',
  });

  const events = await collectText(adapter, process.cwd(), 'thread-existing');
  const argv = JSON.parse(events[1]!) as string[];

  expect(argv.slice(0, 4)).toEqual([fake.args[0], '--profile', 'dev', '--claude-args']);
  expect(argv[4]).toContain('exec --json');
  expect(argv[4]).toContain('-C');
  expect(argv[4]).toContain('--model gpt-test');
  expect(argv[4]).toContain('resume thread-existing hello');
});
```

This test uses the existing `collectText` helper, which passes `model: 'gpt-test'`; that per-run model should override `defaultModel`.

- [ ] **Step 2: Add failing wrapper availability test**

Append to `test/agent/codex/adapter.test.ts`:

```ts
test('checks wrapper availability by passing version through codex args option', async () => {
  const fake = nodeCommand(`
    const args = process.argv.slice(2);
    if (args.includes('--claude-args') && args.at(-1) === '--version') process.exit(0);
    process.exit(2);
  `);
  const adapter = new CodexAdapter({
    command: fake.command,
    args: fake.args,
    codexArgsOption: '--claude-args',
  });

  await expect(adapter.isAvailable()).resolves.toBe(true);
});
```

- [ ] **Step 3: Run adapter tests to verify failure**

Run: `npm test -- test/agent/codex/adapter.test.ts`

Expected: FAIL because CodexAdapter does not support `codexArgsOption` yet.

- [ ] **Step 4: Implement shell argument joining**

In `src/agent/codex/adapter.ts`, add the option to `CodexAdapterOptions`:

```ts
  codexArgsOption?: string;
```

Add a private field:

```ts
  private readonly codexArgsOption?: string;
```

Set it in the constructor:

```ts
this.codexArgsOption = opts.codexArgsOption;
```

Add these helpers near the top of the file:

```ts
function quoteShellArg(arg: string): string {
  if (arg.length === 0) return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

function joinShellArgs(args: string[]): string {
  return args.map(quoteShellArg).join(' ');
}
```

Add a method inside `CodexAdapter`:

```ts
  private buildProcessArgs(codexArgs: string[]): string[] {
    if (!this.codexArgsOption) return [...this.prefixArgs, ...codexArgs];
    return [...this.prefixArgs, this.codexArgsOption, joinShellArgs(codexArgs)];
  }
```

- [ ] **Step 5: Use wrapper-aware process args**

In `isAvailable()`, replace:

```ts
const child = spawn(this.command, [...this.prefixArgs, '--version'], { stdio: 'ignore' });
```

with:

```ts
const child = spawn(this.command, this.buildProcessArgs(['--version']), { stdio: 'ignore' });
```

In `run()`, replace:

```ts
const codexArgs = [...this.prefixArgs, 'exec', '--json'];
```

with:

```ts
const codexArgs = ['exec', '--json'];
```

Replace the spawn call args:

```ts
const child = spawn(this.command, this.buildProcessArgs(codexArgs), {
```

- [ ] **Step 6: Verify adapter wrapper behavior**

Run: `npm test -- test/agent/codex/adapter.test.ts`

Expected: PASS.

Run: `npm run typecheck`

Expected: PASS.

---

### Task 3: Treat Codex top-level error as non-terminal progress

**Files:**
- Modify: `src/agent/codex/stream-json.ts`
- Modify: `test/agent/codex/stream-json.test.ts`

- [ ] **Step 1: Add failing transient error test**

In `test/agent/codex/stream-json.test.ts`, replace the current top-level error expectation with two explicit tests:

```ts
test('translates top-level codex errors into non-terminal progress', () => {
  expect([...translateCodexEvent({ type: 'error', message: 'Reconnecting... 1/5' })]).toEqual([
    { type: 'progress', phase: 'thinking', label: 'Reconnecting... 1/5' },
  ]);
});

test('keeps failed turns terminal', () => {
  expect([...translateCodexEvent({ type: 'turn.failed', error: { message: 'nope' } })]).toEqual([
    { type: 'error', message: 'nope' },
  ]);
});
```

- [ ] **Step 2: Run translator tests to verify failure**

Run: `npm test -- test/agent/codex/stream-json.test.ts`

Expected: FAIL because top-level `error` currently emits terminal error.

- [ ] **Step 3: Update translator behavior**

In `src/agent/codex/stream-json.ts`, replace:

```ts
  if (evt.type === 'turn.failed' || evt.type === 'error') {
    yield { type: 'error', message: errorMessage(evt.error ?? evt.message ?? evt) };
  }
```

with:

```ts
  if (evt.type === 'turn.failed') {
    yield { type: 'error', message: errorMessage(evt.error ?? evt.message ?? evt) };
    return;
  }

  if (evt.type === 'error') {
    yield { type: 'progress', phase: 'thinking', label: errorMessage(evt.error ?? evt.message ?? evt) };
  }
```

- [ ] **Step 4: Verify translator behavior**

Run: `npm test -- test/agent/codex/stream-json.test.ts`

Expected: PASS.

Run: `npm run typecheck`

Expected: PASS.

---

### Task 4: Documentation and final verification

**Files:**
- Modify: `README.md`
- Modify: `README.zh.md`
- Test: focused and full verification

- [ ] **Step 1: Update English Codex docs**

In `README.md`, in the Codex backend section, add a wrapper example after the direct Codex config:

```md
For wrappers such as `ttadk` that accept the generated Codex argv through one option, set `codexArgsOption`. The option name is whatever your wrapper expects; if it reuses the Claude-compatible entrypoint, use the same value you use for `claudeArgsOption`:

```json
{
  "preferences": {
    "agentCommand": {
      "backend": "codex",
      "command": "ttadk",
      "args": ["--profile", "dev"],
      "codexArgsOption": "--claude-args"
    },
    "agentCodexModel": "gpt-5.1-codex"
  }
}
```

With `codexArgsOption`, the bridge safely joins Codex arguments and runs commands like `ttadk --profile dev --claude-args "exec --json -C /repo --model gpt-5.1-codex ..."`.
```

- [ ] **Step 2: Update Chinese Codex docs**

In `README.zh.md`, in the Codex backend section, add the equivalent Chinese wrapper example:

```md
如果使用 `ttadk` 这类 wrapper，并且 wrapper 通过一个 option 接收完整 Codex argv，可以配置 `codexArgsOption`。option 名不写死，按 wrapper 实际支持的名字填写；如果它复用 Claude 兼容入口，就填和 `claudeArgsOption` 一样的值：

```json
{
  "preferences": {
    "agentCommand": {
      "backend": "codex",
      "command": "ttadk",
      "args": ["--profile", "dev"],
      "codexArgsOption": "--claude-args"
    },
    "agentCodexModel": "gpt-5.1-codex"
  }
}
```

配置 `codexArgsOption` 后，bridge 会把 Codex 参数安全拼成一个字符串，例如 `ttadk --profile dev --claude-args "exec --json -C /repo --model gpt-5.1-codex ..."`。
```

- [ ] **Step 3: Run focused verification**

Run:

```bash
npm test -- test/config/schema.test.ts test/agent/factory.test.ts test/agent/codex/stream-json.test.ts test/agent/codex/adapter.test.ts test/agent/adapter-descriptor.test.ts
```

Expected: PASS.

- [ ] **Step 4: Run full verification**

Run: `npm test`

Expected: PASS.

Run: `npm run typecheck`

Expected: PASS.

Run: `npm run build`

Expected: PASS.

---

## Self-Review

- Spec coverage: The plan covers `codexArgsOption` config/factory wiring, wrapper-aware availability/run command construction, transient top-level Codex error handling, README docs, and verification.
- Placeholder scan: No TBD/TODO placeholders remain; all test/code changes are concrete.
- Type consistency: `codexArgsOption` is used consistently across config, factory, adapter options, tests, and docs.

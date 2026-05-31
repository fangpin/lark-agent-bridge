# Setup Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a shared setup diagnostics engine surfaced by `/doctor setup` in chat and `lark-agent-bridge start --check` in the terminal.

**Architecture:** Build a pure diagnostics module that returns structured checks independent of Lark UI. The CLI and chat command both call the same module, rendering results as terminal text or a Lark card; diagnostics are non-mutating and avoid real agent prompts/e2e model calls.

**Tech Stack:** TypeScript, Node.js 20, Vitest, existing config/agent/runtime/session/workspace modules, Lark CardKit templates.

---

## File Structure

- `src/doctor/setup.ts` — shared diagnostics engine and terminal renderer.
- `src/card/templates.ts` — setup diagnostics card renderer.
- `src/cli/commands/start.ts` — add `--check` option path that loads config, creates agent, runs diagnostics, prints report, exits.
- `src/cli/index.ts` — expose `start --check` option.
- `src/commands/index.ts` — add `/doctor setup` branch using the shared diagnostics and card renderer.
- `test/doctor/setup.test.ts` — unit tests for diagnostics output and terminal rendering.
- `test/card/templates.test.ts` — card renderer coverage.
- `test/commands/runs.test.ts` or new `test/commands/doctor-setup.test.ts` — chat command integration.
- `test/cli/start-check.test.ts` — CLI option behavior if existing test patterns make this practical; otherwise test `runSetupDiagnostics` directly and typecheck CLI wiring.
- `README.md`, `README.zh.md` — document `/doctor setup` and `start --check`.

---

### Task 1: Shared setup diagnostics engine

**Files:**
- Create: `src/doctor/setup.ts`
- Create: `test/doctor/setup.test.ts`

- [ ] **Step 1: Write failing diagnostics tests**

Create `test/doctor/setup.test.ts`:

```ts
import { describe, expect, test, vi } from 'vitest';
import type { AgentAdapter } from '../../src/agent/types';
import { renderSetupDiagnosticsText, runSetupDiagnostics } from '../../src/doctor/setup';
import type { AppConfig } from '../../src/config/schema';

function cfg(preferences: AppConfig['preferences'] = {}): AppConfig {
  return {
    accounts: { app: { id: 'app-id', secret: 'secret', tenant: 'feishu' } },
    preferences,
  };
}

function agent(overrides: Partial<AgentAdapter> = {}): AgentAdapter {
  return {
    id: 'codex',
    sessionKey: 'codex',
    displayName: 'Codex CLI',
    commandLabel: 'ttadk --profile dev',
    descriptor: {
      id: 'codex',
      label: 'Codex CLI',
      runtime: 'json',
      sessionKey: 'codex',
      commandLabel: 'ttadk --profile dev',
      supportsRetry: true,
      supportsWorkers: false,
    },
    isAvailable: vi.fn(async () => true),
    run: vi.fn(() => {
      throw new Error('not used');
    }),
    ...overrides,
  } as AgentAdapter;
}

describe('setup diagnostics', () => {
  test('reports config, backend, cwd, access, and process checks', async () => {
    const result = await runSetupDiagnostics({
      cfg: cfg({
        agentCommand: {
          backend: 'codex',
          command: 'ttadk',
          args: ['--profile', 'dev'],
          codexArgsOption: '--claude-args',
        },
        access: { admins: ['user-1'], allowedChats: ['chat-1'] },
      }),
      configPath: '/tmp/config.json',
      agent: agent(),
      cwd: process.cwd(),
      chat: { chatId: 'chat-1', chatMode: 'group', senderId: 'user-1' },
      sameAppProcesses: [{ id: 'abcd', pid: 1234, appId: 'app-id', tenant: 'feishu', configPath: '/tmp/config.json', startedAt: new Date().toISOString(), version: '0.1.0' }],
    });

    expect(result.summary.status).toBe('warn');
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'config.complete', status: 'pass' }),
        expect.objectContaining({ id: 'agent.available', status: 'pass' }),
        expect.objectContaining({ id: 'cwd.accessible', status: 'pass' }),
        expect.objectContaining({ id: 'codex.wrapper', status: 'info' }),
        expect.objectContaining({ id: 'access.sender', status: 'pass' }),
        expect.objectContaining({ id: 'process.conflict', status: 'warn' }),
      ]),
    );
  });

  test('reports unavailable agents and inaccessible cwd as failures', async () => {
    const result = await runSetupDiagnostics({
      cfg: cfg({ agentCommand: { backend: 'claude', command: 'missing-claude' } }),
      configPath: '/tmp/config.json',
      agent: agent({
        id: 'claude',
        sessionKey: 'claude',
        displayName: 'Claude Code',
        commandLabel: 'missing-claude',
        descriptor: {
          id: 'claude',
          label: 'Claude Code',
          runtime: 'cli',
          sessionKey: 'claude',
          commandLabel: 'missing-claude',
          supportsRetry: true,
          supportsWorkers: false,
        },
        isAvailable: vi.fn(async () => false),
      }),
      cwd: '/path/that/does/not/exist',
      sameAppProcesses: [],
    });

    expect(result.summary.status).toBe('fail');
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'agent.available', status: 'fail' }),
        expect.objectContaining({ id: 'cwd.accessible', status: 'fail' }),
      ]),
    );
  });

  test('renders terminal diagnostics with status icons and suggestions', async () => {
    const result = await runSetupDiagnostics({
      cfg: cfg({ agentCommand: { backend: 'codex', command: 'ttadk', codexArgsOption: '--claude-args' } }),
      configPath: '/tmp/config.json',
      agent: agent(),
      cwd: process.cwd(),
      sameAppProcesses: [],
    });

    const text = renderSetupDiagnosticsText(result);

    expect(text).toContain('Setup diagnostics:');
    expect(text).toContain('Codex CLI');
    expect(text).toContain('codexArgsOption');
  });
});
```

- [ ] **Step 2: Run diagnostics tests to verify failure**

Run: `npm test -- test/doctor/setup.test.ts`

Expected: FAIL because `src/doctor/setup.ts` does not exist.

- [ ] **Step 3: Implement diagnostics types and engine**

Create `src/doctor/setup.ts`:

```ts
import { stat } from 'node:fs/promises';
import type { AgentAdapter } from '../agent/types';
import type { AppConfig } from '../config/schema';
import { getAgentCommand, getAgentCursorRuntime, getAgentSessionPoolSize, isChatAllowed, isComplete, isUserAllowed } from '../config/schema';
import type { ProcessEntry } from '../runtime/registry';

export type DiagnosticStatus = 'pass' | 'warn' | 'fail' | 'info';

export interface SetupDiagnosticCheck {
  id: string;
  status: DiagnosticStatus;
  title: string;
  detail: string;
  suggestion?: string;
}

export interface SetupDiagnosticsResult {
  summary: { status: DiagnosticStatus; title: string };
  checks: SetupDiagnosticCheck[];
}

export interface SetupDiagnosticsInput {
  cfg: AppConfig;
  configPath: string;
  agent: AgentAdapter;
  cwd: string;
  chat?: { chatId: string; chatMode: 'p2p' | 'group' | 'topic'; senderId: string };
  sameAppProcesses: ProcessEntry[];
}

export async function runSetupDiagnostics(input: SetupDiagnosticsInput): Promise<SetupDiagnosticsResult> {
  const checks: SetupDiagnosticCheck[] = [];
  const command = getAgentCommand(input.cfg);

  checks.push({
    id: 'config.complete',
    status: isComplete(input.cfg) ? 'pass' : 'fail',
    title: 'Config complete',
    detail: `Loaded ${input.configPath}`,
    suggestion: isComplete(input.cfg) ? undefined : 'Run lark-agent-bridge start to complete app setup.',
  });

  checks.push({
    id: 'agent.backend',
    status: 'info',
    title: 'Agent backend',
    detail: `${input.agent.descriptor.label} / ${input.agent.descriptor.runtime} / ${input.agent.descriptor.sessionKey}`,
  });

  const available = await input.agent.isAvailable().catch(() => false);
  checks.push({
    id: 'agent.available',
    status: available ? 'pass' : 'fail',
    title: 'Agent command available',
    detail: input.agent.commandLabel,
    suggestion: available ? undefined : 'Check preferences.agentCommand.command, wrapper args, PATH, or backend login/auth.',
  });

  checks.push(await cwdCheck(input.cwd));

  if (command.backend === 'codex') {
    checks.push({
      id: 'codex.wrapper',
      status: command.codexArgsOption ? 'info' : 'warn',
      title: 'Codex wrapper mode',
      detail: command.codexArgsOption
        ? `codexArgsOption=${command.codexArgsOption}; availability check uses the wrapper path.`
        : 'Direct codex command; no codexArgsOption configured.',
      suggestion: command.codexArgsOption ? undefined : 'If running through ttadk, configure preferences.agentCommand.codexArgsOption.',
    });
  }

  if (command.backend === 'cursor') {
    const runtime = getAgentCursorRuntime(input.cfg);
    const poolSize = getAgentSessionPoolSize(input.cfg);
    checks.push({
      id: 'cursor.runtime',
      status: 'info',
      title: 'Cursor runtime',
      detail: `${runtime}; pool size ${poolSize}`,
    });
  }

  if (input.chat) {
    const userAllowed = isUserAllowed(input.cfg, input.chat.senderId);
    checks.push({
      id: 'access.sender',
      status: userAllowed ? 'pass' : 'fail',
      title: 'Sender access',
      detail: userAllowed ? 'Sender is allowed by current config.' : 'Sender is blocked by allowedUsers.',
      suggestion: userAllowed ? undefined : 'Update preferences.access.allowedUsers or ask an admin to run /config.',
    });
    const chatAllowed = input.chat.chatMode === 'p2p' || isChatAllowed(input.cfg, input.chat.chatId);
    checks.push({
      id: 'access.chat',
      status: chatAllowed ? 'pass' : 'fail',
      title: 'Chat access',
      detail: chatAllowed ? 'Chat is allowed by current config.' : 'Chat is blocked by allowedChats.',
      suggestion: chatAllowed ? undefined : 'Update preferences.access.allowedChats or DM the bot to adjust config.',
    });
  }

  checks.push({
    id: 'process.conflict',
    status: input.sameAppProcesses.length > 0 ? 'warn' : 'pass',
    title: 'Duplicate bot processes',
    detail: input.sameAppProcesses.length > 0
      ? `${input.sameAppProcesses.length} other process(es) are registered for this app.`
      : 'No other live process registered for this app.',
    suggestion: input.sameAppProcesses.length > 0 ? 'Use /ps and /exit, or lark-agent-bridge ps/stop, to remove duplicates.' : undefined,
  });

  return { summary: summarize(checks), checks };
}

async function cwdCheck(cwd: string): Promise<SetupDiagnosticCheck> {
  try {
    const st = await stat(cwd);
    if (!st.isDirectory()) {
      return { id: 'cwd.accessible', status: 'fail', title: 'Working directory', detail: `${cwd} is not a directory.`, suggestion: 'Use /cd <path> or /ws use <name> to switch cwd.' };
    }
    return { id: 'cwd.accessible', status: 'pass', title: 'Working directory', detail: cwd };
  } catch (err) {
    return { id: 'cwd.accessible', status: 'fail', title: 'Working directory', detail: `${cwd}: ${(err as Error).message}`, suggestion: 'Use /cd <path> or /ws use <name> to switch to an existing directory.' };
  }
}

function summarize(checks: SetupDiagnosticCheck[]): SetupDiagnosticsResult['summary'] {
  if (checks.some((check) => check.status === 'fail')) return { status: 'fail', title: 'Setup has blocking issues' };
  if (checks.some((check) => check.status === 'warn')) return { status: 'warn', title: 'Setup has warnings' };
  return { status: 'pass', title: 'Setup looks ready' };
}

export function renderSetupDiagnosticsText(result: SetupDiagnosticsResult): string {
  const lines = [`Setup diagnostics: ${result.summary.title}`, ''];
  for (const check of result.checks) {
    lines.push(`${statusIcon(check.status)} ${check.title}: ${check.detail}`);
    if (check.suggestion) lines.push(`   Fix: ${check.suggestion}`);
  }
  return lines.join('\n');
}

function statusIcon(status: DiagnosticStatus): string {
  if (status === 'pass') return '✓';
  if (status === 'warn') return '⚠';
  if (status === 'fail') return '✗';
  return '•';
}
```

- [ ] **Step 4: Run diagnostics tests**

Run: `npm test -- test/doctor/setup.test.ts`

Expected: PASS.

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`

Expected: PASS.

---

### Task 2: Card renderer and `/doctor setup`

**Files:**
- Modify: `src/card/templates.ts`
- Modify: `src/commands/index.ts`
- Modify: `test/card/templates.test.ts`
- Create: `test/commands/doctor-setup.test.ts`

- [ ] **Step 1: Add failing card renderer test**

Append to `test/card/templates.test.ts`:

```ts
import { setupDiagnosticsCard } from '../../src/card/templates';
import type { SetupDiagnosticsResult } from '../../src/doctor/setup';

test('setup diagnostics card renders statuses and suggestions', () => {
  const result: SetupDiagnosticsResult = {
    summary: { status: 'warn', title: 'Setup has warnings' },
    checks: [
      { id: 'agent.available', status: 'pass', title: 'Agent command available', detail: 'ttadk --profile dev' },
      { id: 'process.conflict', status: 'warn', title: 'Duplicate bot processes', detail: '1 other process', suggestion: 'Use /ps and /exit.' },
    ],
  };

  const card = setupDiagnosticsCard(result);
  const json = JSON.stringify(card);

  expect(json).toContain('Setup has warnings');
  expect(json).toContain('Agent command available');
  expect(json).toContain('Use /ps and /exit.');
});
```

If `test/card/templates.test.ts` already imports from `../../src/card/templates`, merge the import.

- [ ] **Step 2: Run card test to verify failure**

Run: `npm test -- test/card/templates.test.ts`

Expected: FAIL because `setupDiagnosticsCard` does not exist.

- [ ] **Step 3: Implement setup diagnostics card**

In `src/card/templates.ts`, import the result type:

```ts
import type { SetupDiagnosticsResult, DiagnosticStatus } from '../doctor/setup';
```

Add this exported function near other command cards:

```ts
export function setupDiagnosticsCard(result: SetupDiagnosticsResult): object {
  const elements: object[] = [divMd(`**${escapeMd(result.summary.title)}**`)];
  elements.push(HR);
  result.checks.forEach((check, index) => {
    const lines = [
      `${diagnosticIcon(check.status)} **${escapeMd(check.title)}**`,
      escapeMd(check.detail),
      check.suggestion ? `建议：${escapeMd(check.suggestion)}` : '',
    ].filter(Boolean);
    elements.push(divMd(lines.join('\n')));
    if (index < result.checks.length - 1) elements.push(HR);
  });
  return shell('🩺 Setup 自检', elements);
}

function diagnosticIcon(status: DiagnosticStatus): string {
  if (status === 'pass') return '✅';
  if (status === 'warn') return '⚠️';
  if (status === 'fail') return '❌';
  return 'ℹ️';
}
```

- [ ] **Step 4: Run card test**

Run: `npm test -- test/card/templates.test.ts`

Expected: PASS.

- [ ] **Step 5: Write failing `/doctor setup` command test**

Create `test/commands/doctor-setup.test.ts`:

```ts
import { describe, expect, test, vi } from 'vitest';
import { tryHandleCommand, type CommandContext } from '../../src/commands';

function ctx(): CommandContext {
  const send = vi.fn(async () => ({ messageId: 'sent-1' }));
  return {
    channel: { send },
    msg: {
      chatId: 'chat-1',
      messageId: 'msg-1',
      senderId: 'admin',
      content: '/doctor setup',
      rawContentType: 'text',
      resources: [],
      mentions: [],
      mentionAll: false,
      mentionedBot: true,
      createTime: Date.now(),
    },
    scope: 'chat-1',
    chatMode: 'group',
    sessions: { getRaw: () => undefined },
    workspaces: { cwdFor: () => process.cwd() },
    agent: {
      id: 'codex',
      sessionKey: 'codex',
      displayName: 'Codex CLI',
      commandLabel: 'ttadk --profile dev',
      descriptor: {
        id: 'codex',
        label: 'Codex CLI',
        runtime: 'json',
        sessionKey: 'codex',
        commandLabel: 'ttadk --profile dev',
        supportsRetry: true,
        supportsWorkers: false,
      },
      isAvailable: vi.fn(async () => true),
      run: vi.fn(() => {
        throw new Error('doctor setup must not run agent prompts');
      }),
    },
    activeRuns: { interrupt: vi.fn(() => false) },
    pending: { cancel: vi.fn(() => []) },
    runHistory: undefined,
    controls: {
      restart: async () => undefined,
      exit: async () => undefined,
      configPath: '/tmp/config.json',
      processId: 'proc',
      cfg: {
        accounts: { app: { id: 'app-id', secret: 'secret', tenant: 'feishu' } },
        preferences: {
          agentCommand: {
            backend: 'codex',
            command: 'ttadk',
            args: ['--profile', 'dev'],
            codexArgsOption: '--claude-args',
          },
          access: { admins: ['admin'], allowedChats: ['chat-1'] },
        },
      },
    },
  } as unknown as CommandContext;
}

describe('/doctor setup', () => {
  test('sends setup diagnostics card without starting a doctor agent run', async () => {
    const commandCtx = ctx();

    await expect(tryHandleCommand(commandCtx)).resolves.toBe(true);

    expect(commandCtx.agent.run).not.toHaveBeenCalled();
    expect(commandCtx.channel.send).toHaveBeenCalledWith(
      'chat-1',
      { card: expect.any(Object) },
      { replyTo: 'msg-1' },
    );
    expect(JSON.stringify(commandCtx.channel.send.mock.calls[0]![1])).toContain('Setup');
  });
});
```

- [ ] **Step 6: Run command test to verify failure**

Run: `npm test -- test/commands/doctor-setup.test.ts`

Expected: FAIL because `/doctor setup` currently runs the log-diagnosis agent path or does not render setup card.

- [ ] **Step 7: Implement `/doctor setup` branch**

In `src/commands/index.ts`, add imports:

```ts
import { setupDiagnosticsCard } from '../card/templates';
import { runSetupDiagnostics } from '../doctor/setup';
import { sameAppOthers } from '../runtime/registry';
```

If `sameAppOthers` is already imported from `../runtime/registry`, merge it into that import.

In `handleDoctor`, add after the workers branch:

```ts
  if (args.trim().toLowerCase() === 'setup') {
    const cwd = ctx.workspaces.cwdFor(ctx.scope) ?? homedir();
    const result = await runSetupDiagnostics({
      cfg: ctx.controls.cfg,
      configPath: ctx.controls.configPath,
      agent: ctx.agent,
      cwd,
      chat: { chatId: ctx.msg.chatId, chatMode: ctx.chatMode, senderId: ctx.msg.senderId },
      sameAppProcesses: sameAppOthers(ctx.controls.cfg.accounts.app.id),
    });
    await replyCard(ctx, setupDiagnosticsCard(result));
    return;
  }
```

- [ ] **Step 8: Verify card and command tests**

Run: `npm test -- test/card/templates.test.ts test/commands/doctor-setup.test.ts test/doctor/setup.test.ts`

Expected: PASS.

Run: `npm run typecheck`

Expected: PASS.

---

### Task 3: CLI `start --check`

**Files:**
- Modify: `src/cli/commands/start.ts`
- Modify: `src/cli/index.ts`
- Test: `test/doctor/setup.test.ts`

- [ ] **Step 1: Add CLI helper test**

Append to `test/doctor/setup.test.ts`:

```ts
test('terminal diagnostics show fail summary when failures exist', async () => {
  const result = await runSetupDiagnostics({
    cfg: cfg({ agentCommand: { backend: 'claude', command: 'missing-claude' } }),
    configPath: '/tmp/config.json',
    agent: agent({
      id: 'claude',
      sessionKey: 'claude',
      displayName: 'Claude Code',
      commandLabel: 'missing-claude',
      descriptor: {
        id: 'claude',
        label: 'Claude Code',
        runtime: 'cli',
        sessionKey: 'claude',
        commandLabel: 'missing-claude',
        supportsRetry: true,
        supportsWorkers: false,
      },
      isAvailable: vi.fn(async () => false),
    }),
    cwd: '/path/that/does/not/exist',
    sameAppProcesses: [],
  });

  expect(renderSetupDiagnosticsText(result)).toContain('Setup diagnostics: Setup has blocking issues');
});
```

- [ ] **Step 2: Run diagnostics tests**

Run: `npm test -- test/doctor/setup.test.ts`

Expected: PASS. This extends terminal renderer coverage before CLI wiring.

- [ ] **Step 3: Add `--check` option type**

In `src/cli/commands/start.ts`, update `StartOptions`:

```ts
export interface StartOptions {
  config?: string;
  check?: boolean;
}
```

In `src/cli/index.ts`, update the start command:

```ts
  .option('--check', 'run setup diagnostics and exit without starting the bot')
  .action(async (opts: { config?: string; check?: boolean }) => {
    await runStart(opts);
  });
```

- [ ] **Step 4: Implement check path in `runStart`**

In `src/cli/commands/start.ts`, add imports:

```ts
import { renderSetupDiagnosticsText, runSetupDiagnostics } from '../../doctor/setup';
```

After creating `agent` and before the existing availability failure block, add:

```ts
  if (opts.check) {
    const result = await runSetupDiagnostics({
      cfg,
      configPath,
      agent,
      cwd: process.cwd(),
      sameAppProcesses: sameAppOthers(cfg.accounts.app.id),
    });
    console.log(renderSetupDiagnosticsText(result));
    process.exit(result.summary.status === 'fail' ? 1 : 0);
  }
```

Keep the existing hard `agent.isAvailable()` startup check for normal start mode.

- [ ] **Step 5: Run focused verification**

Run: `npm test -- test/doctor/setup.test.ts`

Expected: PASS.

Run: `npm run typecheck`

Expected: PASS.

---

### Task 4: Documentation and final verification

**Files:**
- Modify: `README.md`
- Modify: `README.zh.md`
- Test: focused and full verification

- [ ] **Step 1: Update English README command docs**

In `README.md`, update host CLI block to include:

```md
lark-agent-bridge start --check            Run setup diagnostics and exit
```

In the slash command table, update `/doctor [description]` row to:

```md
| `/doctor [description]` | Feed recent logs, run timeline, and your description back to the agent for self-diagnosis. `/doctor setup` runs non-mutating setup diagnostics. |
```

Add a short section near FAQ or after data directories:

```md
### Setup diagnostics

Use `lark-agent-bridge start --check` before starting the bot, or `/doctor setup` in chat, to verify local setup without sending a prompt to the agent. The check reports config completeness, backend command availability, cwd accessibility, Codex wrapper mode, Cursor runtime settings, chat access allowlists, and duplicate bot processes. It does not perform a real model call, so it can catch wrapper/auth/PATH issues without consuming tokens.
```

- [ ] **Step 2: Update Chinese README command docs**

In `README.zh.md`, update the host CLI block to include:

```md
lark-agent-bridge start --check            只做 setup 自检，不启动 bot
```

Update `/doctor [描述]` row to mention `/doctor setup`.

Add equivalent Chinese section:

```md
### Setup 自检

启动前可以用 `lark-agent-bridge start --check`，聊天里可以用 `/doctor setup`，在不向 agent 发送真实 prompt 的情况下检查本地配置。自检会报告 config 是否完整、backend 命令是否可运行、cwd 是否可访问、Codex wrapper 模式、Cursor runtime 设置、当前 chat 权限白名单，以及是否有重复 bot 进程。它不会发起真实模型调用，所以适合排查 wrapper/auth/PATH 问题且不消耗 token。
```

- [ ] **Step 3: Run focused tests**

Run:

```bash
npm test -- test/doctor/setup.test.ts test/card/templates.test.ts test/commands/doctor-setup.test.ts
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

- Spec coverage: The plan covers shared diagnostics, `/doctor setup`, `start --check`, non-mutating behavior, backend availability, cwd, Codex wrapper info, Cursor runtime, chat access, duplicate processes, card/terminal rendering, and docs.
- Placeholder scan: No TBD/TODO placeholders remain; all tests and implementation snippets are concrete.
- Type consistency: `SetupDiagnosticCheck`, `SetupDiagnosticsResult`, `runSetupDiagnostics`, `renderSetupDiagnosticsText`, and `setupDiagnosticsCard` are used consistently.

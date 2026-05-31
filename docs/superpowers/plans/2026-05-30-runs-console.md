# Runs Console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a chat-local `/runs` console and enrich `/status` so users can inspect recent agent runs, retry failures, stop active work, and see stable backend capability metadata.

**Architecture:** Keep run history in the existing in-memory `RunHistory` service, extending entries with cwd/backend/summary metadata captured at run start and completion. Render the new console through `src/card/templates.ts`, dispatch actions through existing CardKit command callbacks, and expose backend display/capability metadata through `AgentAdapter` without introducing a full plugin system.

**Tech Stack:** TypeScript, Node.js 20, Vitest, existing CardKit 2.0 card templates, existing Lark channel command dispatcher.

---

## File Structure

- `src/agent/types.ts` — add a small `AgentDescriptor` interface and `descriptor` property on `AgentAdapter`.
- `src/agent/claude/adapter.ts` — expose Claude descriptor metadata.
- `src/agent/cursor/adapter.ts` — expose Cursor descriptor metadata, including runtime and worker support.
- `src/bot/run-history.ts` — extend `RunHistoryEntry`, add list/update helpers, and keep cloning behavior safe.
- `src/bot/channel.ts` — populate run history metadata at run start, after stream message creation, and at run finish.
- `src/card/templates.ts` — render `/runs` and enriched `/status` cards.
- `src/commands/index.ts` — register `/runs`, implement listing/detail behavior, pass latest run info into `/status`, and update `/help`.
- `test/agent/adapter-descriptor.test.ts` — verify backend descriptors for Claude and Cursor.
- `test/bot/run-history.test.ts` — verify listing, scope isolation, metadata updates, pruning, and clone safety.
- `test/card/templates.test.ts` — verify `/runs` and `/status` card rendering and safe action buttons.
- `test/commands/runs.test.ts` — verify `/runs`, `/runs <id>`, and `/status` command integration.
- `README.md` and `README.zh.md` — document `/runs` and enriched `/status`.

---

### Task 1: Add backend descriptor metadata

**Files:**
- Modify: `src/agent/types.ts`
- Modify: `src/agent/claude/adapter.ts`
- Modify: `src/agent/cursor/adapter.ts`
- Create: `test/agent/adapter-descriptor.test.ts`

- [ ] **Step 1: Write the failing descriptor tests**

Create `test/agent/adapter-descriptor.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { ClaudeAdapter } from '../../src/agent/claude/adapter';
import { CursorAdapter } from '../../src/agent/cursor/adapter';

describe('agent descriptors', () => {
  test('describes Claude Code for user-facing status cards', () => {
    const adapter = new ClaudeAdapter({ command: 'claude-wrapper', args: ['--fast'] });

    expect(adapter.descriptor).toEqual({
      id: 'claude',
      label: 'Claude Code',
      runtime: 'cli',
      sessionKey: 'claude',
      commandLabel: 'claude-wrapper --fast',
      supportsRetry: true,
      supportsWorkers: false,
    });
  });

  test('describes Cursor SDK when worker pooling is enabled', () => {
    const adapter = new CursorAdapter({ runtime: 'sdk', sessionPoolSize: 2, command: 'agent' });

    expect(adapter.descriptor).toEqual({
      id: 'cursor',
      label: 'Cursor Agent',
      runtime: 'sdk',
      sessionKey: 'cursor:sdk',
      commandLabel: '@cursor/sdk (agent)',
      supportsRetry: true,
      supportsWorkers: true,
    });
  });

  test('describes Cursor CLI when SDK pooling is disabled', () => {
    const adapter = new CursorAdapter({ runtime: 'sdk', sessionPoolSize: 0, command: 'agent' });

    expect(adapter.descriptor).toMatchObject({
      id: 'cursor',
      label: 'Cursor Agent',
      runtime: 'cli',
      sessionKey: 'cursor:cli',
      supportsRetry: true,
      supportsWorkers: false,
    });
  });
});
```

- [ ] **Step 2: Run the failing descriptor tests**

Run: `npm test -- test/agent/adapter-descriptor.test.ts`

Expected: FAIL with TypeScript/runtime errors because `descriptor` is not defined on the adapters.

- [ ] **Step 3: Add the descriptor type**

In `src/agent/types.ts`, add this interface above `AgentAdapter` and add the property to `AgentAdapter`:

```ts
export interface AgentDescriptor {
  id: string;
  label: string;
  runtime: string;
  sessionKey: string;
  commandLabel: string;
  supportsRetry: boolean;
  supportsWorkers: boolean;
}

export interface AgentAdapter {
  readonly id: string;
  readonly sessionKey: string;
  readonly displayName: string;
  readonly commandLabel: string;
  readonly descriptor: AgentDescriptor;
  isAvailable(): Promise<boolean>;
  run(opts: AgentRunOptions): AgentRun;
  prepareSession?(cwd: string, scope?: string): Promise<string | undefined>;
  canResumeSession?(sessionId: string): boolean;
  evictScope?(scope: string, cwd?: string): Promise<void>;
  workerSnapshots?(): WorkerSnapshot[];
  shutdown?(): Promise<void>;
}
```

- [ ] **Step 4: Implement Claude descriptor**

In `src/agent/claude/adapter.ts`, change the import to include `AgentDescriptor`:

```ts
import type { AgentAdapter, AgentDescriptor, AgentEvent, AgentRun, AgentRunOptions } from '../types';
```

Add this getter inside `ClaudeAdapter`, below `commandLabel`:

```ts
  get descriptor(): AgentDescriptor {
    return {
      id: this.id,
      label: this.displayName,
      runtime: 'cli',
      sessionKey: this.sessionKey,
      commandLabel: this.commandLabel,
      supportsRetry: true,
      supportsWorkers: false,
    };
  }
```

- [ ] **Step 5: Implement Cursor descriptor**

In `src/agent/cursor/adapter.ts`, change the import to include `AgentDescriptor`:

```ts
import type { AgentAdapter, AgentDescriptor, AgentEvent, AgentRun, AgentRunOptions, WorkerSnapshot } from '../types';
```

Add this getter inside `CursorAdapter`, below `commandLabel`:

```ts
  get descriptor(): AgentDescriptor {
    return {
      id: this.id,
      label: this.displayName,
      runtime: this.sdkPool ? 'sdk' : 'cli',
      sessionKey: this.sessionKey,
      commandLabel: this.commandLabel,
      supportsRetry: true,
      supportsWorkers: Boolean(this.sdkPool),
    };
  }
```

- [ ] **Step 6: Run descriptor tests**

Run: `npm test -- test/agent/adapter-descriptor.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/agent/types.ts src/agent/claude/adapter.ts src/agent/cursor/adapter.ts test/agent/adapter-descriptor.test.ts
git commit -m "feat: expose agent backend descriptors"
```

---

### Task 2: Extend run history records

**Files:**
- Modify: `src/bot/run-history.ts`
- Create: `test/bot/run-history.test.ts`

- [ ] **Step 1: Write failing run history tests**

Create `test/bot/run-history.test.ts`:

```ts
import { describe, expect, test, vi } from 'vitest';
import type { AgentDescriptor } from '../../src/agent/types';
import { RunHistory } from '../../src/bot/run-history';

const descriptor: AgentDescriptor = {
  id: 'claude',
  label: 'Claude Code',
  runtime: 'cli',
  sessionKey: 'claude',
  commandLabel: 'claude',
  supportsRetry: true,
  supportsWorkers: false,
};

function msg(id: string, content: string, chatId = 'chat-1') {
  return {
    messageId: id,
    chatId,
    senderId: 'user-1',
    content,
    rawContentType: 'text',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: true,
    createTime: Date.now(),
  };
}

describe('RunHistory', () => {
  test('lists recent runs for one scope with newest first', () => {
    vi.setSystemTime(1_000);
    const history = new RunHistory();
    const first = history.create('scope-a', [msg('m1', 'first prompt')], {
      cwd: '/repo/a',
      agent: descriptor,
      summary: 'first prompt',
    });
    vi.setSystemTime(2_000);
    const second = history.create('scope-a', [msg('m2', 'second prompt')], {
      cwd: '/repo/a',
      agent: descriptor,
      summary: 'second prompt',
    });
    history.create('scope-b', [msg('m3', 'other prompt')], {
      cwd: '/repo/b',
      agent: descriptor,
      summary: 'other prompt',
    });

    expect(history.list('scope-a').map((entry) => entry.runId)).toEqual([second.runId, first.runId]);
  });

  test('updates stream message id and terminal state without exposing mutable internals', () => {
    const history = new RunHistory();
    const entry = history.create('scope-a', [msg('m1', 'please fix the bug')], {
      cwd: '/repo/a',
      agent: descriptor,
      summary: 'please fix the bug',
    });

    history.update(entry.runId, { streamMessageId: 'om_123' });
    history.finish(entry.runId, 'error', 'network timeout');

    const copy = history.get(entry.runId)!;
    copy.batch[0]!.content = 'mutated';

    expect(history.get(entry.runId)).toMatchObject({
      runId: entry.runId,
      scope: 'scope-a',
      cwd: '/repo/a',
      streamMessageId: 'om_123',
      terminal: 'error',
      errorMsg: 'network timeout',
      summary: 'please fix the bug',
      agent: descriptor,
    });
    expect(history.get(entry.runId)!.batch[0]!.content).toBe('please fix the bug');
  });

  test('limits list size independently from stored retry entries', () => {
    const history = new RunHistory();
    for (let i = 0; i < 8; i++) {
      history.create('scope-a', [msg(`m${i}`, `prompt ${i}`)], {
        cwd: '/repo/a',
        agent: descriptor,
        summary: `prompt ${i}`,
      });
    }

    expect(history.list('scope-a', 3)).toHaveLength(3);
    expect(history.list('scope-a', 3)[0]!.summary).toBe('prompt 7');
  });
});
```

- [ ] **Step 2: Run failing run history tests**

Run: `npm test -- test/bot/run-history.test.ts`

Expected: FAIL because `create` does not accept metadata and `list`/`update` do not exist.

- [ ] **Step 3: Extend `RunHistoryEntry` and add metadata input**

Replace the top of `src/bot/run-history.ts` through the `RunHistoryEntry` interface with:

```ts
import type { NormalizedMessage } from '@larksuiteoapi/node-sdk';
import type { AgentDescriptor } from '../agent/types';
import type { Terminal } from '../card/run-state';

const MAX_RUNS = 50;
const TTL_MS = 6 * 60 * 60 * 1000;

export interface RunHistoryCreateMeta {
  cwd: string;
  agent: AgentDescriptor;
  summary: string;
}

export interface RunHistoryUpdate {
  streamMessageId?: string;
  summary?: string;
}

export interface RunHistoryEntry {
  runId: string;
  scope: string;
  chatId: string;
  threadId?: string;
  batch: NormalizedMessage[];
  createdAt: number;
  updatedAt: number;
  terminal: Terminal;
  cwd: string;
  agent: AgentDescriptor;
  summary: string;
  streamMessageId?: string;
  errorMsg?: string;
}
```

- [ ] **Step 4: Update create/get/list/update implementation**

Replace the `RunHistory` class in `src/bot/run-history.ts` with:

```ts
export class RunHistory {
  private readonly entries = new Map<string, RunHistoryEntry>();
  private nextId = 1;

  create(scope: string, batch: NormalizedMessage[], meta: RunHistoryCreateMeta): RunHistoryEntry {
    const first = batch[0];
    const now = Date.now();
    const entry: RunHistoryEntry = {
      runId: `run-${now.toString(36)}-${this.nextId++}`,
      scope,
      chatId: first?.chatId ?? '',
      threadId: first?.threadId,
      batch: batch.map((msg) => ({ ...msg })),
      createdAt: now,
      updatedAt: now,
      terminal: 'running',
      cwd: meta.cwd,
      agent: { ...meta.agent },
      summary: meta.summary,
    };
    this.entries.set(entry.runId, entry);
    this.prune(now);
    return cloneEntry(entry);
  }

  update(runId: string, update: RunHistoryUpdate): void {
    const entry = this.entries.get(runId);
    if (!entry) return;
    if (update.streamMessageId !== undefined) entry.streamMessageId = update.streamMessageId;
    if (update.summary !== undefined) entry.summary = update.summary;
    entry.updatedAt = Date.now();
  }

  finish(runId: string, terminal: Terminal, errorMsg?: string): void {
    const entry = this.entries.get(runId);
    if (!entry) return;
    entry.terminal = terminal;
    entry.errorMsg = errorMsg;
    entry.updatedAt = Date.now();
  }

  get(runId: string): RunHistoryEntry | undefined {
    this.prune(Date.now());
    const entry = this.entries.get(runId);
    return entry ? cloneEntry(entry) : undefined;
  }

  list(scope: string, limit = 10): RunHistoryEntry[] {
    this.prune(Date.now());
    return [...this.entries.values()]
      .filter((entry) => entry.scope === scope)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, Math.max(0, limit))
      .map(cloneEntry);
  }

  private prune(now: number): void {
    for (const [id, entry] of this.entries) {
      if (now - entry.updatedAt > TTL_MS) this.entries.delete(id);
    }
    while (this.entries.size > MAX_RUNS) {
      const oldest = this.entries.keys().next().value;
      if (!oldest) break;
      this.entries.delete(oldest);
    }
  }
}

function cloneEntry(entry: RunHistoryEntry): RunHistoryEntry {
  return {
    ...entry,
    agent: { ...entry.agent },
    batch: entry.batch.map((msg) => ({ ...msg })),
  };
}
```

- [ ] **Step 5: Run run history tests**

Run: `npm test -- test/bot/run-history.test.ts`

Expected: PASS.

- [ ] **Step 6: Run existing channel tests to expose call-site compile failures**

Run: `npm test -- test/bot/channel.test.ts`

Expected: FAIL until `runHistory.create(...)` in `src/bot/channel.ts` is updated in Task 3.

- [ ] **Step 7: Commit**

```bash
git add src/bot/run-history.ts test/bot/run-history.test.ts
git commit -m "feat: store run history metadata"
```

---

### Task 3: Populate run history metadata from the channel

**Files:**
- Modify: `src/bot/channel.ts`
- Test: `test/bot/channel.test.ts`
- Test: `test/bot/run-history.test.ts`

- [ ] **Step 1: Add a prompt summary helper test inside channel tests**

Append this test to `describe('prompt building')` or create a new `describe('run history metadata')` block in `test/bot/channel.test.ts`:

```ts
import { summarizeBatchForHistory } from '../../src/bot/channel';

// Add this test near other exported-helper tests.
test('summarizes run history from the first user message', () => {
  expect(
    summarizeBatchForHistory([
      {
        messageId: 'm1',
        chatId: 'chat-1',
        senderId: 'user-1',
        content: '请帮我看看这个报错\n第二行细节'.repeat(10),
        rawContentType: 'text',
        resources: [],
        mentions: [],
        mentionAll: false,
        mentionedBot: true,
        createTime: Date.now(),
      },
    ]),
  ).toMatch(/^请帮我看看这个报错 第二行细节/);
});
```

If the file already imports from `../../src/bot/channel`, merge `summarizeBatchForHistory` into the existing import list instead of adding a duplicate import.

- [ ] **Step 2: Run channel tests and verify compile failure**

Run: `npm test -- test/bot/channel.test.ts`

Expected: FAIL because `summarizeBatchForHistory` is not exported and `runHistory.create` still has the old call shape.

- [ ] **Step 3: Resolve cwd before creating the history entry**

In `src/bot/channel.ts`, inside `runAgentBatch`, move:

```ts
  const cwd = workspaces.cwdFor(scope) ?? homedir();
```

so it appears before the history entry creation. Then replace:

```ts
  const historyEntry = runHistory.create(scope, batch);
```

with:

```ts
  const cwd = workspaces.cwdFor(scope) ?? homedir();
  const historyEntry = runHistory.create(scope, batch, {
    cwd,
    agent: agent.descriptor,
    summary: summarizeBatchForHistory(batch),
  });
```

Remove the later duplicate `const cwd = workspaces.cwdFor(scope) ?? homedir();` line before `const sessionKey = agent.sessionKey;`.

- [ ] **Step 4: Store stream message ids after stream/send**

In `src/bot/channel.ts`, after each assignment to `streamMessageId = result.messageId;`, add:

```ts
      runHistory.update(historyEntry.runId, { streamMessageId });
```

There are two stream branches: card and markdown.

In text mode, replace:

```ts
        await channel.send(chatId, { markdown: body }, sendOpts);
```

with:

```ts
        const sent = await channel.send(chatId, { markdown: body }, sendOpts);
        runHistory.update(historyEntry.runId, { streamMessageId: sent.messageId });
```

If `channel.send` typing does not expose `messageId`, use this narrow type at the assignment point:

```ts
        const sent = (await channel.send(chatId, { markdown: body }, sendOpts)) as { messageId?: string };
        if (sent.messageId) runHistory.update(historyEntry.runId, { streamMessageId: sent.messageId });
```

- [ ] **Step 5: Export the summary helper**

Add this function near `buildPrompt` helpers in `src/bot/channel.ts`:

```ts
export function summarizeBatchForHistory(batch: NormalizedMessage[]): string {
  const text = batch
    .map((msg) => msg.content.trim())
    .filter(Boolean)
    .join(' / ')
    .replace(/\s+/g, ' ');
  if (!text) return batch.length > 1 ? `${batch.length} 条消息` : '空消息';
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}
```

- [ ] **Step 6: Run affected tests**

Run: `npm test -- test/bot/channel.test.ts test/bot/run-history.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/bot/channel.ts test/bot/channel.test.ts
git commit -m "feat: capture run metadata in history"
```

---

### Task 4: Render `/runs` console cards

**Files:**
- Modify: `src/card/templates.ts`
- Create: `test/card/templates.test.ts`

- [ ] **Step 1: Write failing card template tests**

Create `test/card/templates.test.ts`:

```ts
import { describe, expect, test, vi } from 'vitest';
import type { RunHistoryEntry } from '../../src/bot/run-history';
import { runsCard, runDetailCard } from '../../src/card/templates';

const agent = {
  id: 'claude',
  label: 'Claude Code',
  runtime: 'cli',
  sessionKey: 'claude',
  commandLabel: 'claude',
  supportsRetry: true,
  supportsWorkers: false,
};

function entry(overrides: Partial<RunHistoryEntry>): RunHistoryEntry {
  return {
    runId: 'run-1',
    scope: 'chat-1',
    chatId: 'chat-1',
    batch: [],
    createdAt: 1_000,
    updatedAt: 2_000,
    terminal: 'done',
    cwd: '/repo/project',
    agent,
    summary: 'fix failing test',
    ...overrides,
  };
}

describe('runs cards', () => {
  test('renders recent runs newest first with safe actions', () => {
    vi.setSystemTime(10_000);
    const card = runsCard({
      cwd: '/repo/project',
      entries: [
        entry({ runId: 'run-err', terminal: 'error', errorMsg: 'network timeout', createdAt: 9_000, updatedAt: 9_500 }),
        entry({ runId: 'run-live', terminal: 'running', createdAt: 8_000, updatedAt: 8_500 }),
        entry({ runId: 'run-ok', terminal: 'done', createdAt: 7_000, updatedAt: 7_500 }),
      ],
    }) as { body: { elements: unknown[] } };

    const json = JSON.stringify(card);
    expect(json).toContain('最近运行');
    expect(json).toContain('fix failing test');
    expect(json).toContain('network timeout');
    expect(json).toContain('cmd":"retry","run_id":"run-err');
    expect(json).toContain('cmd":"stop');
    expect(json).toContain('cmd":"runs.detail","run_id":"run-ok');
  });

  test('renders an empty runs card with a next step', () => {
    const card = runsCard({ cwd: '/repo/project', entries: [] });

    expect(JSON.stringify(card)).toContain('暂无运行记录');
    expect(JSON.stringify(card)).toContain('/help');
  });

  test('renders run detail with retry only for failed runs', () => {
    const failed = runDetailCard(entry({ runId: 'run-err', terminal: 'idle_timeout', errorMsg: 'idle' }));
    const done = runDetailCard(entry({ runId: 'run-ok', terminal: 'done' }));

    expect(JSON.stringify(failed)).toContain('cmd":"retry","run_id":"run-err');
    expect(JSON.stringify(done)).not.toContain('cmd":"retry","run_id":"run-ok');
  });
});
```

- [ ] **Step 2: Run failing card template tests**

Run: `npm test -- test/card/templates.test.ts`

Expected: FAIL because `runsCard` and `runDetailCard` are not exported.

- [ ] **Step 3: Add template imports and exported interfaces**

At the top of `src/card/templates.ts`, add:

```ts
import type { RunHistoryEntry } from '../bot/run-history';
```

Add these interfaces below `StatusInfo`:

```ts
export interface RunsCardInfo {
  cwd: string;
  entries: RunHistoryEntry[];
}
```

- [ ] **Step 4: Add `/runs` and detail card renderers**

Add these exported functions below `statusCard` in `src/card/templates.ts`:

```ts
export function runsCard(info: RunsCardInfo): object {
  const elements: object[] = [divMd(`当前 cwd：\`${escapeCode(info.cwd)}\``)];
  if (info.entries.length === 0) {
    elements.push(HR);
    elements.push(divMd('暂无运行记录。发送一条消息让 agent 开始工作，之后可在这里查看最近任务。'));
    elements.push(divMd('需要命令列表可发送 `/help`。'));
    return shell('🧭 最近运行', elements);
  }

  elements.push(HR);
  info.entries.forEach((entry, index) => {
    elements.push(runEntryLine(entry));
    const buttons: ButtonSpec[] = [
      { text: '详情', value: { cmd: 'runs.detail', run_id: entry.runId } },
    ];
    if (entry.terminal === 'running') {
      buttons.unshift({ text: '终止', value: { cmd: 'stop' }, style: 'danger' });
    } else if (entry.terminal === 'error' || entry.terminal === 'idle_timeout') {
      buttons.unshift({ text: '重试', value: { cmd: 'retry', run_id: entry.runId }, style: 'primary' });
    }
    elements.push(actions(buttons));
    if (index < info.entries.length - 1) elements.push(HR);
  });
  return shell('🧭 最近运行', elements);
}

export function runDetailCard(entry: RunHistoryEntry): object {
  const lines = [
    `**run**: \`${escapeCode(entry.runId)}\``,
    `**状态**: ${terminalText(entry.terminal)}`,
    `**agent**: ${escapeMd(entry.agent.label)} · ${escapeMd(entry.agent.runtime)} · \`${escapeCode(entry.agent.sessionKey)}\``,
    `**cwd**: \`${escapeCode(entry.cwd)}\``,
    `**创建**: ${timeText(entry.createdAt)} · **更新**: ${timeText(entry.updatedAt)}`,
    `**摘要**: ${escapeMd(entry.summary)}`,
    entry.streamMessageId ? `**消息**: \`${escapeCode(entry.streamMessageId)}\`` : '',
    entry.errorMsg ? `**失败原因**: ${escapeMd(entry.errorMsg)}` : '',
  ].filter(Boolean);
  const buttons: ButtonSpec[] = [{ text: '返回最近运行', value: { cmd: 'runs' } }];
  if (entry.terminal === 'running') {
    buttons.unshift({ text: '终止', value: { cmd: 'stop' }, style: 'danger' });
  } else if (entry.terminal === 'error' || entry.terminal === 'idle_timeout') {
    buttons.unshift({ text: '重试', value: { cmd: 'retry', run_id: entry.runId }, style: 'primary' });
  }
  return shell('🧭 运行详情', [divMd(lines.join('\n')), HR, actions(buttons)]);
}

function runEntryLine(entry: RunHistoryEntry): object {
  const pieces = [
    `${terminalIcon(entry.terminal)} **${escapeMd(entry.summary)}**`,
    `\`${escapeCode(shortRunId(entry.runId))}\` · ${escapeMd(entry.agent.label)} / ${escapeMd(entry.agent.runtime)} · ${formatAge(Date.now() - entry.createdAt)}前`,
  ];
  if (entry.errorMsg) pieces.push(`失败原因：${escapeMd(entry.errorMsg)}`);
  return divMd(pieces.join('\n'));
}

function terminalIcon(terminal: RunHistoryEntry['terminal']): string {
  if (terminal === 'done') return '✅';
  if (terminal === 'running') return '⏳';
  if (terminal === 'interrupted') return '⏹';
  if (terminal === 'idle_timeout') return '⏱';
  return '⚠️';
}

function terminalText(terminal: RunHistoryEntry['terminal']): string {
  if (terminal === 'done') return '已完成';
  if (terminal === 'running') return '运行中';
  if (terminal === 'interrupted') return '已中断';
  if (terminal === 'idle_timeout') return '已超时';
  return '出错';
}

function shortRunId(runId: string): string {
  return runId.length > 16 ? `${runId.slice(0, 13)}…` : runId;
}

function timeText(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

function formatAge(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
```

- [ ] **Step 5: Run card template tests**

Run: `npm test -- test/card/templates.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/card/templates.ts test/card/templates.test.ts
git commit -m "feat: render recent runs cards"
```

---

### Task 5: Add `/runs` command and card actions

**Files:**
- Modify: `src/commands/index.ts`
- Modify: `src/card/dispatcher.ts` only if `composeArgs` does not already pass `run_id` for `runs.detail`
- Create: `test/commands/runs.test.ts`

- [ ] **Step 1: Write failing command tests**

Create `test/commands/runs.test.ts`:

```ts
import { describe, expect, test, vi } from 'vitest';
import type { AgentDescriptor } from '../../src/agent/types';
import { RunHistory } from '../../src/bot/run-history';
import { tryHandleCommand, type CommandContext } from '../../src/commands';

const descriptor: AgentDescriptor = {
  id: 'claude',
  label: 'Claude Code',
  runtime: 'cli',
  sessionKey: 'claude',
  commandLabel: 'claude',
  supportsRetry: true,
  supportsWorkers: false,
};

function msg(content: string) {
  return {
    chatId: 'chat-1',
    messageId: 'msg-1',
    senderId: 'admin',
    content,
    rawContentType: 'text',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: true,
    createTime: Date.now(),
  };
}

function ctx(content: string, history = new RunHistory()): CommandContext {
  const send = vi.fn(async () => ({ messageId: 'sent-1' }));
  return {
    channel: { send },
    msg: msg(content),
    scope: 'chat-1',
    chatMode: 'p2p',
    sessions: { getRaw: () => undefined },
    workspaces: { cwdFor: () => '/repo/project' },
    agent: { displayName: 'Claude Code', sessionKey: 'claude', descriptor },
    activeRuns: { interrupt: vi.fn(() => false) },
    pending: { push: vi.fn(() => 1), cancel: vi.fn(() => []) },
    runHistory: history,
    controls: {
      restart: async () => undefined,
      exit: async () => undefined,
      configPath: '',
      processId: 'proc',
      cfg: { preferences: { access: { admins: ['admin'] } } },
    },
  } as unknown as CommandContext;
}

describe('/runs command', () => {
  test('sends a recent runs card', async () => {
    const history = new RunHistory();
    history.create('chat-1', [msg('fix the bug')], {
      cwd: '/repo/project',
      agent: descriptor,
      summary: 'fix the bug',
    });
    const commandCtx = ctx('/runs', history);

    await expect(tryHandleCommand(commandCtx)).resolves.toBe(true);

    expect(commandCtx.channel.send).toHaveBeenCalledWith(
      'chat-1',
      { card: expect.any(Object) },
      { replyTo: 'msg-1' },
    );
    expect(JSON.stringify(commandCtx.channel.send.mock.calls[0]![1])).toContain('fix the bug');
  });

  test('sends a run detail card by id', async () => {
    const history = new RunHistory();
    const entry = history.create('chat-1', [msg('fix the bug')], {
      cwd: '/repo/project',
      agent: descriptor,
      summary: 'fix the bug',
    });
    const commandCtx = ctx(`/runs ${entry.runId}`, history);

    await expect(tryHandleCommand(commandCtx)).resolves.toBe(true);

    expect(JSON.stringify(commandCtx.channel.send.mock.calls[0]![1])).toContain('运行详情');
    expect(JSON.stringify(commandCtx.channel.send.mock.calls[0]![1])).toContain(entry.runId);
  });

  test('rejects details from another scope', async () => {
    const history = new RunHistory();
    const entry = history.create('other-scope', [msg('fix the bug')], {
      cwd: '/repo/project',
      agent: descriptor,
      summary: 'fix the bug',
    });
    const commandCtx = ctx(`/runs ${entry.runId}`, history);

    await expect(tryHandleCommand(commandCtx)).resolves.toBe(true);

    expect(commandCtx.channel.send).toHaveBeenCalledWith(
      'chat-1',
      { markdown: '这个任务属于另一个会话/话题，不能在当前会话查看。' },
      { replyTo: 'msg-1' },
    );
  });
});
```

- [ ] **Step 2: Run failing command tests**

Run: `npm test -- test/commands/runs.test.ts`

Expected: FAIL because `/runs` is not registered.

- [ ] **Step 3: Register `/runs` and import templates**

In `src/commands/index.ts`, change the templates import to include the new renderers:

```ts
import { helpCard, resumeCard, runDetailCard, runsCard, statusCard, workspacesCard } from '../card/templates';
```

Add the handler entry:

```ts
  '/runs': handleRuns,
```

Place it near `/status`.

- [ ] **Step 4: Implement `handleRuns`**

Add this function above `handleStatus`:

```ts
async function handleRuns(args: string, ctx: CommandContext): Promise<void> {
  if (!ctx.runHistory) {
    await reply(ctx, '当前运行环境不支持运行记录。');
    return;
  }
  const runId = args.trim();
  if (runId) {
    const entry = ctx.runHistory.get(runId);
    if (!entry) {
      await reply(ctx, `找不到运行记录：\`${runId}\`（只保留最近若干小时的任务）。`);
      return;
    }
    if (entry.scope !== ctx.scope) {
      await reply(ctx, '这个任务属于另一个会话/话题，不能在当前会话查看。');
      return;
    }
    await replyCard(ctx, runDetailCard(entry));
    return;
  }

  const cwd = ctx.workspaces.cwdFor(ctx.scope) ?? homedir();
  await replyCard(ctx, runsCard({ cwd, entries: ctx.runHistory.list(ctx.scope, 10) }));
}
```

- [ ] **Step 5: Update help card command list**

In `src/card/templates.ts`, in `helpCard()`, add this line after `/status`:

```ts
        '- `/runs` — 查看当前 chat 最近运行、失败原因、重试/终止入口',
```

- [ ] **Step 6: Verify card action args**

`src/card/dispatcher.ts` already maps `payload.run_id` to handler args in `composeArgs`. Confirm the existing code contains:

```ts
(typeof payload.run_id === 'string' && payload.run_id)
```

If it does not, add that branch after `payload.name`.

- [ ] **Step 7: Run command tests**

Run: `npm test -- test/commands/runs.test.ts test/card/templates.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/commands/index.ts src/card/templates.ts test/commands/runs.test.ts
git commit -m "feat: add runs command"
```

---

### Task 6: Enhance `/status` with backend and latest run

**Files:**
- Modify: `src/card/templates.ts`
- Modify: `src/commands/index.ts`
- Modify: `test/card/templates.test.ts`
- Modify: `test/commands/runs.test.ts`

- [ ] **Step 1: Add failing status card test**

Append to `test/card/templates.test.ts`:

```ts
import { statusCard } from '../../src/card/templates';

test('status card includes backend capabilities and latest run', () => {
  const card = statusCard({
    cwd: '/repo/project',
    sessionId: 'session-123456789',
    sessionStale: false,
    agentName: 'Claude Code',
    scope: 'chat-1',
    chatMode: 'p2p',
    agent: {
      id: 'claude',
      label: 'Claude Code',
      runtime: 'cli',
      sessionKey: 'claude',
      commandLabel: 'claude',
      supportsRetry: true,
      supportsWorkers: false,
    },
    latestRun: entry({ runId: 'run-latest', terminal: 'error', errorMsg: 'network timeout' }),
  });

  const json = JSON.stringify(card);
  expect(json).toContain('runtime');
  expect(json).toContain('cli');
  expect(json).toContain('最近运行');
  expect(json).toContain('network timeout');
  expect(json).toContain('cmd":"runs.detail","run_id":"run-latest');
});
```

If `statusCard` is already imported in that file, merge the import.

- [ ] **Step 2: Add failing status command test**

Append to `test/commands/runs.test.ts`:

```ts
test('/status includes latest run when history exists', async () => {
  const history = new RunHistory();
  history.create('chat-1', [msg('fix the bug')], {
    cwd: '/repo/project',
    agent: descriptor,
    summary: 'fix the bug',
  });
  const commandCtx = ctx('/status', history);

  await expect(tryHandleCommand(commandCtx)).resolves.toBe(true);

  expect(JSON.stringify(commandCtx.channel.send.mock.calls[0]![1])).toContain('最近运行');
  expect(JSON.stringify(commandCtx.channel.send.mock.calls[0]![1])).toContain('fix the bug');
});
```

- [ ] **Step 3: Run failing status tests**

Run: `npm test -- test/card/templates.test.ts test/commands/runs.test.ts`

Expected: FAIL because `StatusInfo` does not accept `agent`/`latestRun`, and `handleStatus` does not pass latest history.

- [ ] **Step 4: Extend `StatusInfo`**

In `src/card/templates.ts`, add imports/types if not already present:

```ts
import type { AgentDescriptor } from '../agent/types';
import type { RunHistoryEntry } from '../bot/run-history';
```

Extend `StatusInfo`:

```ts
export interface StatusInfo {
  cwd: string;
  sessionId?: string;
  sessionStale: boolean;
  agentName: string;
  scope: string;
  chatMode: 'p2p' | 'group' | 'topic';
  agent?: AgentDescriptor;
  latestRun?: RunHistoryEntry;
}
```

- [ ] **Step 5: Render backend and latest run in `statusCard`**

Inside `statusCard`, after the existing `lines` array is built, add:

```ts
  if (info.agent) {
    lines.push(`🧩 **runtime**: ${escapeMd(info.agent.runtime)} · \`${escapeCode(info.agent.sessionKey)}\``);
    const capabilities = [
      info.agent.supportsRetry ? 'retry' : '',
      info.agent.supportsWorkers ? 'workers' : '',
    ].filter(Boolean);
    if (capabilities.length > 0) lines.push(`🛠 **能力**: ${capabilities.join(', ')}`);
  }
  if (info.latestRun) {
    lines.push(
      `🧭 **最近运行**: ${terminalIcon(info.latestRun.terminal)} ${escapeMd(info.latestRun.summary)} (${formatAge(Date.now() - info.latestRun.createdAt)}前)`,
    );
    if (info.latestRun.errorMsg) lines.push(`⚠️ **最近失败**: ${escapeMd(info.latestRun.errorMsg)}`);
  }
```

Add a `/runs` button to the actions list in `statusCard`:

```ts
      { text: '🧭 最近运行', value: { cmd: 'runs' } },
```

If the action row becomes too crowded, remove the help button from this row and keep help accessible from `/help`.

- [ ] **Step 6: Pass metadata from `handleStatus`**

In `src/commands/index.ts`, replace the `statusCard` call body with:

```ts
  const latestRun = ctx.runHistory?.list(ctx.scope, 1)[0];
  const card = statusCard({
    cwd,
    sessionId: sess?.sessionId,
    sessionStale: Boolean(sess && sess.cwd !== cwd),
    agentName: ctx.agent.displayName,
    scope: ctx.scope,
    chatMode: ctx.chatMode,
    agent: ctx.agent.descriptor,
    latestRun,
  });
```

- [ ] **Step 7: Run status tests**

Run: `npm test -- test/card/templates.test.ts test/commands/runs.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/card/templates.ts src/commands/index.ts test/card/templates.test.ts test/commands/runs.test.ts
git commit -m "feat: show latest run in status"
```

---

### Task 7: Documentation and final verification

**Files:**
- Modify: `README.md`
- Modify: `README.zh.md`
- Test: all affected tests

- [ ] **Step 1: Update English command table**

In `README.md`, in the Slash commands table, add this row after `/status`:

```md
| `/runs [run-id]` | Show recent runs for the current chat/topic, including status, failure reason, retry/stop buttons, and per-run details. |
```

Also update the `/status` row to:

```md
| `/status` | Current cwd / session / agent / latest run (card + buttons) |
```

- [ ] **Step 2: Update Chinese command table**

In `README.zh.md`, in the Slash commands table, add this row after `/status`:

```md
| `/runs [run-id]` | 查看当前 chat/topic 最近运行，包括状态、失败原因、重试/终止按钮和单次详情 |
```

Also update the `/status` row to:

```md
| `/status` | 当前 cwd / session / agent / 最近运行（卡片 + 按钮） |
```

- [ ] **Step 3: Run focused tests**

Run: `npm test -- test/agent/adapter-descriptor.test.ts test/bot/run-history.test.ts test/bot/channel.test.ts test/card/templates.test.ts test/commands/runs.test.ts test/card/renderers.test.ts test/commands/shell.test.ts`

Expected: PASS.

- [ ] **Step 4: Run full verification**

Run: `npm test`

Expected: PASS.

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit docs and verification fixes**

```bash
git add README.md README.zh.md
git commit -m "docs: document runs console"
```

If verification required code/test fixes, include those files in the same commit and use:

```bash
git add README.md README.zh.md <fixed-files>
git commit -m "fix: stabilize runs console verification"
```

---

## Self-Review

- Spec coverage: The plan covers `/runs`, run details, safe retry/stop actions, `/status` latest-run/backend metadata, backend descriptor fields, tests, and README updates.
- Placeholder scan: No `TBD`, `TODO`, or unspecified implementation steps remain; every code change step includes concrete code.
- Type consistency: `AgentDescriptor`, `RunHistoryEntry`, `runsCard`, `runDetailCard`, `summarizeBatchForHistory`, and command payload `run_id` are named consistently across tasks.

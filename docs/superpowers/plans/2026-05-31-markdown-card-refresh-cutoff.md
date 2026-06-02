# Markdown Card Refresh Cutoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop intermediate streaming refreshes for markdown reply cards after 10 minutes, show a bottom note at the cutoff, keep the agent running, and still publish the final card update.

**Architecture:** Keep the feature localized to `src/bot/channel.ts`. Add a markdown-only cutoff wrapper used by the `replyMode === 'markdown'` branch; the wrapper owns the 10-minute timer, cutoff note rendering, post-cutoff no-op behavior, and best-effort timeout handling. Existing `RunState`, card renderers, and final update flow remain unchanged.

**Tech Stack:** TypeScript ESM, Node.js timers, Vitest fake timers, `@larksuiteoapi/node-sdk` channel test doubles.

---

## File Structure

- Modify `src/bot/channel.ts`
  - Add constants for the markdown refresh cutoff duration and note text near the existing stream timeout constants.
  - Add a small `MarkdownRefreshCutoff` interface plus `createMarkdownRefreshCutoff(...)` helper near `forceFinalCardUpdate(...)` so transport-specific card update behavior stays in the channel module.
  - Use the helper only in the `replyMode === 'markdown'` branch.
- Modify `test/bot/channel.test.ts`
  - Add unit tests for the new helper through `processAgentStream`.
  - Add integration-style channel tests for markdown mode and card mode.
  - Extend `createFakeChannel` only enough to support the new stream/update test cases.
- No renderer, `RunState`, config, README, or schema changes are required.

---

### Task 1: Add the failing stream-level cutoff test

**Files:**
- Modify: `test/bot/channel.test.ts:154-398`

- [ ] **Step 1: Export the test target in imports**

Update the import from `../../src/bot/channel` at the top of `test/bot/channel.test.ts` to include `createMarkdownRefreshCutoff`:

```ts
import {
  createMarkdownRefreshCutoff,
  interruptScopeNow,
  maybeEnqueueAutoRetryForOpaqueSdkError,
  processAgentStream,
  shouldAutoRetryOpaqueSdkError,
  startChannel,
  summarizeBatchForHistory,
} from '../../src/bot/channel';
```

- [ ] **Step 2: Write the failing test**

Add this test inside `describe('processAgentStream', () => { ... })`, after the existing `refreshes running progress while the agent is silent` test and before `fails fast when the final flush hangs`:

```ts
  test('stops intermediate markdown refreshes after the 10 minute cutoff while keeping final state current', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let releaseStream!: () => void;
    const streamReleased = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    const markdownUpdates: string[] = [];
    const statesSeen: string[] = [];
    const run: AgentRun = {
      events: (async function* (): AsyncGenerator<AgentEvent> {
        yield { type: 'text', delta: 'first' };
        await vi.advanceTimersByTimeAsync(600_000);
        yield { type: 'text', delta: ' second' };
        releaseStream();
        yield { type: 'done' };
      })(),
      async stop() {},
      async waitForExit() {
        return true;
      },
    };
    const cutoff = createMarkdownRefreshCutoff(async (markdown) => {
      markdownUpdates.push(markdown);
    });

    const processing = processAgentStream(
      { run, interrupted: false },
      {} as SessionStore,
      'chat-1',
      '/tmp/project',
      'agent:test',
      undefined,
      async (state) => {
        statesSeen.push(state.terminal === 'running' ? state.blocks.map((block) => block.kind === 'text' ? block.content : '').join('') : state.terminal);
        await cutoff.flush(renderText(state));
      },
      5000,
      createInitialState('run-1'),
    );

    await streamReleased;
    await processing;
    cutoff.dispose();

    expect(markdownUpdates).toHaveLength(3);
    expect(markdownUpdates[0]).toContain('first');
    expect(markdownUpdates[1]).toContain('已运行超过 10 分钟');
    expect(markdownUpdates[1]).toContain('飞书卡片将停止自动刷新');
    expect(markdownUpdates[2]).toContain('_✅ 已完成_');
    expect(markdownUpdates[2]).toContain('first second');
    expect(statesSeen).toContain('first second');
  });
```

- [ ] **Step 3: Run test to verify it fails**

Run:

```bash
npm test -- test/bot/channel.test.ts --runInBand
```

Expected: FAIL because `createMarkdownRefreshCutoff` is not exported from `src/bot/channel.ts`.

---

### Task 2: Implement the markdown cutoff helper

**Files:**
- Modify: `src/bot/channel.ts:51-58`
- Modify: `src/bot/channel.ts:916-935`

- [ ] **Step 1: Add constants near existing timeout constants**

In `src/bot/channel.ts`, add these constants after `const PROGRESS_REFRESH_MS = 15_000;`:

```ts
const MARKDOWN_REFRESH_CUTOFF_MS = 10 * 60_000;
const MARKDOWN_REFRESH_CUTOFF_NOTE =
  '_已运行超过 10 分钟，飞书卡片将停止自动刷新；Agent 会继续在后台工作，完成后会更新最终结果。_';
```

- [ ] **Step 2: Add the helper before `forceFinalCardUpdate`**

Insert this code immediately before `async function forceFinalCardUpdate(...)`:

```ts
export interface MarkdownRefreshCutoff {
  flush(markdown: string, opts?: { final?: boolean }): Promise<void>;
  dispose(): void;
}

export function createMarkdownRefreshCutoff(
  setContent: (markdown: string) => Promise<void>,
  now: () => number = Date.now,
): MarkdownRefreshCutoff {
  const startedAt = now();
  let stopped = false;
  let cutoffSent = false;
  let latestMarkdown = '';
  let timer: NodeJS.Timeout | undefined;

  const sendCutoff = async (): Promise<void> => {
    if (cutoffSent) return;
    cutoffSent = true;
    stopped = true;
    const body = withMarkdownRefreshCutoffNote(latestMarkdown);
    try {
      await withTimeout('markdown-refresh-cutoff', STREAM_UPDATE_TIMEOUT_MS, setContent(body));
      log.info('card', 'markdown-refresh-cutoff', { elapsedMs: MARKDOWN_REFRESH_CUTOFF_MS });
    } catch (err) {
      log.warn('card', 'markdown-refresh-cutoff-failed', {
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  timer = setTimeout(() => {
    void sendCutoff();
  }, MARKDOWN_REFRESH_CUTOFF_MS);

  return {
    async flush(markdown: string, opts: { final?: boolean } = {}) {
      latestMarkdown = markdown;
      if (opts.final) {
        if (timer) clearTimeout(timer);
        timer = undefined;
        await setContent(markdown);
        return;
      }
      if (stopped) return;
      if (now() - startedAt >= MARKDOWN_REFRESH_CUTOFF_MS) {
        await sendCutoff();
        return;
      }
      await setContent(markdown);
    },
    dispose() {
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}

function withMarkdownRefreshCutoffNote(markdown: string): string {
  const body = markdown.trimEnd();
  return body ? `${body}\n\n${MARKDOWN_REFRESH_CUTOFF_NOTE}` : MARKDOWN_REFRESH_CUTOFF_NOTE;
}
```

- [ ] **Step 3: Run focused test to verify it passes**

Run:

```bash
npm test -- test/bot/channel.test.ts --runInBand
```

Expected: PASS for the new cutoff helper test and existing channel tests.

---

### Task 3: Wire the cutoff helper into markdown reply mode

**Files:**
- Modify: `src/bot/channel.ts:729-769`

- [ ] **Step 1: Update markdown branch to use the helper**

Replace the current `replyMode === 'markdown'` branch in `runAgentBatch` with this version:

```ts
    } else if (replyMode === 'markdown') {
      log.info('run', 'timeline', { runId: historyEntry.runId, step: 'card-stream-start', mode: 'markdown' });
      let cutoff: MarkdownRefreshCutoff | undefined;
      const result = await channel.stream(
        chatId,
        {
          markdown: async (ctrl) => {
            cutoff = createMarkdownRefreshCutoff((markdown) => ctrl.setContent(markdown));
            await withTimeout(
              'markdown.initial-flush',
              STREAM_UPDATE_TIMEOUT_MS,
              cutoff.flush(renderText(filterForPrefs(finalState))),
            );
            finalState = await processAgentStream(
              handle,
              sessions,
              scope,
              cwd,
              agent.sessionKey,
              idleTimeoutMs,
              async (state) => {
                finalState = state;
                await withTimeout(
                  'markdown.update',
                  STREAM_UPDATE_TIMEOUT_MS,
                  cutoff!.flush(renderText(filterForPrefs(state)), { final: state.terminal !== 'running' }),
                );
              },
              agentStopGraceMs,
              finalState,
            );
          },
        },
        sendOpts,
      ).finally(() => {
        cutoff?.dispose();
      });
      streamMessageId = result.messageId;
      runHistory.update(historyEntry.runId, { streamMessageId });
      log.info('run', 'timeline', {
        runId: historyEntry.runId,
        step: 'card-stream-done',
        mode: 'markdown',
        messageId: streamMessageId,
      });
      await forceFinalCardUpdate(channel, streamMessageId, filterForPrefs(finalState), 'markdown');
```

- [ ] **Step 2: Run TypeScript check for wiring errors**

Run:

```bash
npm run typecheck
```

Expected: PASS. If TypeScript reports that `finally` does not exist on the channel stream return type, rewrite the branch to declare `let result` before the `try/finally` and dispose in a `finally` block around the awaited `channel.stream(...)` call.

---

### Task 4: Add markdown-mode integration test

**Files:**
- Modify: `test/bot/channel.test.ts:77-152`
- Modify: `test/bot/channel.test.ts:507-535`

- [ ] **Step 1: Add a markdown stream fake inside the new test**

Add this test inside `describe('channel streamMessageId persistence', () => { ... })`, after the fallback persistence test:

```ts
  test('markdown reply mode shows a cutoff note after 10 minutes and still final-updates the card', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const messages: Record<string, (msg: NormalizedMessage) => Promise<void>> = {};
    const markdownUpdates: string[] = [];
    const finalCards: unknown[] = [];
    const fakeChannel = {
      ...createFakeChannel(messages),
      async stream(_chatId: string, payload: { markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void> }) {
        if (!payload.markdown) throw new Error('expected markdown stream');
        await payload.markdown({
          async setContent(markdown: string) {
            markdownUpdates.push(markdown);
          },
        });
        return { messageId: 'om_markdown_stream' };
      },
      async updateCard(_messageId: string, card: unknown) {
        finalCards.push(card);
      },
    } as unknown as LarkChannel;
    const cfg = markdownReplyConfig();
    vi.mocked(createLarkChannel).mockReturnValue(fakeChannel);

    await startChannel({
      cfg,
      agent: fakeAgentWithEvents(async function* (): AsyncGenerator<AgentEvent> {
        yield { type: 'text', delta: 'first' };
        await vi.advanceTimersByTimeAsync(600_000);
        yield { type: 'text', delta: ' second' };
        yield { type: 'done' };
      }),
      sessions: fakeSessions(),
      workspaces: fakeWorkspaces('/tmp/project'),
      controls: fakeControls(cfg),
    });

    const onMessage = messages.message;
    if (!onMessage) throw new Error('message handler was not registered');
    await onMessage(fakeMessage('om_original', 'original prompt'));

    await vi.runAllTimersAsync();
    await vi.waitFor(() => expect(finalCards).toHaveLength(1));

    expect(markdownUpdates.some((body) => body.includes('已运行超过 10 分钟'))).toBe(true);
    expect(markdownUpdates.some((body) => body.includes('飞书卡片将停止自动刷新'))).toBe(true);
    expect(finalCards[0]).toMatchObject({
      schema: '2.0',
      config: { streaming_mode: false, summary: { content: '已完成' } },
    });
  });
```

- [ ] **Step 2: Add test helpers near existing `fakeAgent` helper**

Add this helper after `fakeAgent(...)`:

```ts
function fakeAgentWithEvents(events: () => AsyncGenerator<AgentEvent>): AgentAdapter {
  const descriptor = {
    id: 'fake',
    label: 'Fake Agent',
    runtime: 'test',
    sessionKey: 'fake:test',
    commandLabel: 'fake',
    supportsRetry: true,
    supportsWorkers: false,
  };
  return {
    id: descriptor.id,
    sessionKey: descriptor.sessionKey,
    displayName: descriptor.label,
    commandLabel: descriptor.commandLabel,
    descriptor,
    async isAvailable() {
      return true;
    },
    run(): AgentRun {
      return {
        events: events(),
        async stop() {},
        async waitForExit() {
          return true;
        },
      };
    },
  };
}
```

Add this config helper after `cardReplyConfig()`:

```ts
function markdownReplyConfig(): AppConfig {
  return {
    ...textReplyConfig(),
    preferences: {
      ...textReplyConfig().preferences,
      messageReply: 'markdown',
    },
  };
}
```

- [ ] **Step 3: Run markdown integration test**

Run:

```bash
npm test -- test/bot/channel.test.ts --runInBand
```

Expected: PASS. If fake timers leave pending timers from `PendingQueue`, use `await vi.runOnlyPendingTimersAsync()` only after `onMessage(...)` has started the run, then `await vi.waitFor(...)` for `finalCards`.

---

### Task 5: Add card-mode unaffected regression test

**Files:**
- Modify: `test/bot/channel.test.ts:77-152`

- [ ] **Step 1: Add card stream test**

Add this test inside `describe('channel streamMessageId persistence', () => { ... })`, after the markdown cutoff test:

```ts
  test('card reply mode does not use the markdown refresh cutoff note', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const messages: Record<string, (msg: NormalizedMessage) => Promise<void>> = {};
    const cardUpdates: string[] = [];
    const fakeChannel = {
      ...createFakeChannel(messages),
      async stream(_chatId: string, payload: { card?: { initial: unknown; producer(ctrl: { update(card: unknown): Promise<void> }): Promise<void> } }) {
        if (!payload.card) throw new Error('expected card stream');
        await payload.card.producer({
          async update(card: unknown) {
            cardUpdates.push(JSON.stringify(card));
          },
        });
        return { messageId: 'om_card_stream' };
      },
      async updateCard(_messageId: string, card: unknown) {
        cardUpdates.push(JSON.stringify(card));
      },
    } as unknown as LarkChannel;
    const cfg = cardReplyConfig();
    vi.mocked(createLarkChannel).mockReturnValue(fakeChannel);

    await startChannel({
      cfg,
      agent: fakeAgentWithEvents(async function* (): AsyncGenerator<AgentEvent> {
        yield { type: 'text', delta: 'first' };
        await vi.advanceTimersByTimeAsync(600_000);
        yield { type: 'text', delta: ' second' };
        yield { type: 'done' };
      }),
      sessions: fakeSessions(),
      workspaces: fakeWorkspaces('/tmp/project'),
      controls: fakeControls(cfg),
    });

    const onMessage = messages.message;
    if (!onMessage) throw new Error('message handler was not registered');
    await onMessage(fakeMessage('om_original', 'original prompt'));

    await vi.runAllTimersAsync();
    await vi.waitFor(() => expect(cardUpdates.length).toBeGreaterThan(0));

    expect(cardUpdates.join('\n')).not.toContain('已运行超过 10 分钟');
    expect(cardUpdates.join('\n')).not.toContain('飞书卡片将停止自动刷新');
  });
```

- [ ] **Step 2: Run channel tests**

Run:

```bash
npm test -- test/bot/channel.test.ts --runInBand
```

Expected: PASS.

---

### Task 6: Run final verification

**Files:**
- No code changes.

- [ ] **Step 1: Run affected tests**

Run:

```bash
npm test -- test/bot/channel.test.ts test/card/renderers.test.ts --runInBand
```

Expected: PASS. `test/card/renderers.test.ts` should pass unchanged, confirming renderers were not changed.

- [ ] **Step 2: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Run full test suite**

Run:

```bash
npm test
```

Expected: PASS.

- [ ] **Step 4: Inspect git diff**

Run:

```bash
git diff -- src/bot/channel.ts test/bot/channel.test.ts docs/superpowers/specs/2026-05-31-markdown-card-refresh-cutoff-design.md docs/superpowers/plans/2026-05-31-markdown-card-refresh-cutoff.md
```

Expected: Diff includes only the markdown cutoff implementation, focused tests, and the approved spec/plan documents.

---

## Self-Review

- Spec coverage: The plan covers markdown-only behavior, one 10-minute note update, post-cutoff intermediate refresh suppression, continued agent execution, final-card update preservation, best-effort cutoff note failure handling, and card-mode non-regression.
- Placeholder scan: No TBD/TODO/fill-in placeholders remain; code steps include concrete snippets and commands.
- Type consistency: The helper is consistently named `createMarkdownRefreshCutoff`, returns `MarkdownRefreshCutoff`, and uses `flush(markdown, { final })` plus `dispose()` throughout.

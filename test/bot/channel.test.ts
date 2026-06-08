import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { LarkChannel, NormalizedMessage } from '@larksuiteoapi/node-sdk';
import { createLarkChannel } from '@larksuiteoapi/node-sdk';
import { AgentRegistry } from '../../src/agent/registry';
import type { AgentAdapter, AgentEvent, AgentRun, AgentRunOptions } from '../../src/agent/types';
import type { RunHandle } from '../../src/bot/active-runs';
import { ActiveRuns } from '../../src/bot/active-runs';
import {
  createMarkdownRefreshCutoff,
  interruptScopeNow,
  maybeEnqueueAutoRetryForOpaqueSdkError,
  processAgentStream,
  commentQueueScope,
  restorePersistentQueue,
  shouldAutoRetryOpaqueSdkError,
  startChannel as realStartChannel,
  summarizeBatchForHistory,
} from '../../src/bot/channel';
import { PendingQueue } from '../../src/bot/pending-queue';
import { PersistentQueue } from '../../src/bot/persistent-queue';
import { RunHistory } from '../../src/bot/run-history';
import { createInitialState } from '../../src/card/run-state';
import { renderText } from '../../src/card/text-renderer';
import type { AppConfig } from '../../src/config/schema';
import type { Controls } from '../../src/commands';
import type { SessionStore } from '../../src/session/store';
import type { WorkspaceStore } from '../../src/workspace/store';

vi.mock('@larksuiteoapi/node-sdk', async () => {
  const actual = await vi.importActual<typeof import('@larksuiteoapi/node-sdk')>('@larksuiteoapi/node-sdk');
  return {
    ...actual,
    createLarkChannel: vi.fn(),
  };
});

async function startChannel(deps: Parameters<typeof realStartChannel>[0]): ReturnType<typeof realStartChannel> {
  return realStartChannel(deps);
}

afterEach(() => {
  vi.restoreAllMocks();
});

function runWithNaturalExitAfter(timeoutNeededMs: number): {
  handle: RunHandle;
  waitTimeouts: number[];
  stopCalls: () => number;
} {
  let stopCount = 0;
  const waitTimeouts: number[] = [];
  const run: AgentRun = {
    events: (async function* (): AsyncGenerator<AgentEvent> {
      yield { type: 'done' };
    })(),
    async stop() {
      stopCount++;
    },
    async waitForExit(timeoutMs: number) {
      waitTimeouts.push(timeoutMs);
      return timeoutMs >= timeoutNeededMs;
    },
  };

  return {
    handle: { run, interrupted: false },
    waitTimeouts,
    stopCalls: () => stopCount,
  };
}

describe('summarizeBatchForHistory', () => {
  test('collapses whitespace and truncates long message content', () => {
    const batch = [
      fakeMessage('msg-1', `请帮我看看这个报错\n第二行细节 ${'x'.repeat(100)}`),
    ];

    const summary = summarizeBatchForHistory(batch);

    expect(summary).toMatch(/^请帮我看看这个报错 第二行细节 x+/);
    expect(summary).not.toContain('\n');
    expect(summary).toHaveLength(81);
    expect(summary.endsWith('…')).toBe(true);
  });
});

test('commentQueueScope uses document token', () => {
  expect(commentQueueScope({ fileToken: 'doc-token' } as never)).toBe('doc:doc-token');
});

describe('channel streamMessageId persistence', () => {
  test('runs messages with the backend selected for the scope', async () => {
    const calls: string[] = [];
    const claude = fakeNamedAgent('claude', calls);
    const codex = fakeNamedAgent('codex', calls);
    const registry = new AgentRegistry(['claude', 'codex'], 'claude', async (key) => key === 'codex' ? codex : claude);
    const backendStore = { get: () => 'codex', async flush() {} };
    const messages: Record<string, (msg: NormalizedMessage) => Promise<void>> = {};
    const fakeChannel = createFakeChannel(messages);
    vi.mocked(createLarkChannel).mockReturnValue(fakeChannel);

    await startChannel({
      cfg: textReplyConfig(),
      agentRegistry: registry,
      backendStore: backendStore as never,
      sessions: fakeSessions(),
      workspaces: fakeWorkspaces(process.cwd()),
      controls: fakeControls(textReplyConfig()),
      persistentQueue: tempPersistentQueue(),
    });

    await messages.message?.(fakeMessage('hello'));

    await vi.waitFor(() => expect(calls).toEqual(['codex']));
  });

  test('uses chat-level cwd for topic group runs while keeping topic session scope', async () => {
    const runOptions: AgentRunOptions[] = [];
    const messages: Record<string, (msg: NormalizedMessage) => Promise<void>> = {};
    const fakeChannel = {
      ...createFakeChannel(messages),
      async getChatMode() {
        return 'topic';
      },
    } as unknown as LarkChannel;
    const sessions = {
      ...fakeSessions(),
      resumeFor: vi.fn(() => undefined),
    } as unknown as SessionStore;
    const workspaces = {
      cwdFor: vi.fn((scope: string) => (scope === 'chat-1' ? '/tmp/shared-topic-cwd' : undefined)),
      async flush() {},
    } as unknown as WorkspaceStore;
    vi.mocked(createLarkChannel).mockReturnValue(fakeChannel);

    await startChannel({
      cfg: textReplyConfig(),
      agent: fakeAgent((opts) => runOptions.push(opts)),
      sessions,
      workspaces,
      controls: fakeControls(textReplyConfig()),
      persistentQueue: tempPersistentQueue(),
    });

    await messages.message?.(fakeMessage('hello', 'topic prompt', { threadId: 'thread-1' }));

    await vi.waitFor(() => expect(runOptions[0]?.cwd).toBe('/tmp/shared-topic-cwd'));
    expect(workspaces.cwdFor).toHaveBeenCalledWith('chat-1');
    expect(sessions.resumeFor).toHaveBeenCalledWith('chat-1:thread-1', '/tmp/shared-topic-cwd', 'fake:test');
  });


  test('/timeout off aborts before mutating timeout override when queued cleanup fails', async () => {
    const messages: Record<string, (msg: NormalizedMessage) => Promise<void>> = {};
    const persistentQueue = tempPersistentQueue();
    await persistentQueue.enqueue('chat-1', [fakeMessage('durable-1', 'queued durable work')], {
      id: 'durable-timeout',
      now: 1000,
    });
    const cancelQueuedScope = vi.spyOn(persistentQueue, 'cancelQueuedScope').mockRejectedValueOnce(new Error('disk cleanup failed'));
    const setIdleTimeoutMinutes = vi.fn();
    const sessions = {
      ...fakeSessions(),
      setIdleTimeoutMinutes,
      getIdleTimeoutMinutes: vi.fn(() => 15),
    } as unknown as SessionStore;
    const fakeChannel = createFakeChannel(messages);
    const send = vi.spyOn(fakeChannel, 'send');
    vi.mocked(createLarkChannel).mockReturnValue(fakeChannel);

    await startChannel({
      cfg: textReplyConfig(),
      agent: fakeAgent(() => {}),
      sessions,
      workspaces: fakeWorkspaces('/tmp/project'),
      controls: fakeControls(textReplyConfig()),
      persistentQueue,
    });

    const onMessage = messages.message;
    if (!onMessage) throw new Error('message handler was not registered');
    await onMessage(fakeMessage('timeout-off', '/timeout off'));

    expect(cancelQueuedScope).toHaveBeenCalledWith('chat-1');
    expect(setIdleTimeoutMinutes).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(
      'chat-1',
      { markdown: expect.stringContaining('清理已排队任务失败') },
      { replyTo: 'timeout-off' },
    );
    expect(await persistentQueue.recoverable()).toEqual([
      expect.objectContaining({ id: 'durable-timeout', scope: 'chat-1' }),
    ]);
  });

  test('/timeout default clears queued work before clearing timeout override', async () => {
    const messages: Record<string, (msg: NormalizedMessage) => Promise<void>> = {};
    const persistentQueue = tempPersistentQueue();
    await persistentQueue.enqueue('chat-1', [fakeMessage('durable-1', 'queued durable work')], {
      id: 'durable-timeout-success',
      now: 1000,
    });
    const cancelQueuedScope = vi.spyOn(persistentQueue, 'cancelQueuedScope');
    const clearIdleTimeoutOverride = vi.fn(() => true);
    const sessions = {
      ...fakeSessions(),
      clearIdleTimeoutOverride,
      getIdleTimeoutMinutes: vi.fn(() => 15),
    } as unknown as SessionStore;
    const fakeChannel = createFakeChannel(messages);
    vi.mocked(createLarkChannel).mockReturnValue(fakeChannel);

    await startChannel({
      cfg: textReplyConfig(),
      agent: fakeAgent(() => {}),
      sessions,
      workspaces: fakeWorkspaces('/tmp/project'),
      controls: fakeControls(textReplyConfig()),
      persistentQueue,
    });

    const onMessage = messages.message;
    if (!onMessage) throw new Error('message handler was not registered');
    await onMessage(fakeMessage('timeout-default', '/timeout default'));

    expect(cancelQueuedScope).toHaveBeenCalledWith('chat-1');
    expect(clearIdleTimeoutOverride).toHaveBeenCalledWith('chat-1');
    await vi.waitFor(async () => expect(await persistentQueue.recoverable()).toEqual([]));
  });

  test('/timeout off preserves active running durable work', async () => {
    const messages: Record<string, (msg: NormalizedMessage) => Promise<void>> = {};
    const persistentQueue = tempPersistentQueue();
    await persistentQueue.enqueue('chat-1', [fakeMessage('running-timeout', 'active durable work')], {
      id: 'running-timeout',
      now: 2000,
    });
    await persistentQueue.markRunning('running-timeout', { now: 3000 });
    const cancelQueuedScope = vi.spyOn(persistentQueue, 'cancelQueuedScope');
    const activeRuns = new ActiveRuns();
    const stop = vi.fn(async () => undefined);
    activeRuns.register('chat-1', {
      events: (async function* (): AsyncGenerator<AgentEvent> {})(),
      stop,
      async waitForExit() {
        return true;
      },
    });
    const setIdleTimeoutMinutes = vi.fn();
    const sessions = {
      ...fakeSessions(),
      setIdleTimeoutMinutes,
      getIdleTimeoutMinutes: vi.fn(() => 15),
    } as unknown as SessionStore;
    const fakeChannel = createFakeChannel(messages);
    vi.mocked(createLarkChannel).mockReturnValue(fakeChannel);

    await startChannel({
      cfg: textReplyConfig(),
      agent: fakeAgent(() => {}),
      sessions,
      workspaces: fakeWorkspaces('/tmp/project'),
      controls: fakeControls(textReplyConfig()),
      persistentQueue,
      activeRuns,
    });

    const onMessage = messages.message;
    if (!onMessage) throw new Error('message handler was not registered');
    await onMessage(fakeMessage('timeout-off-active', '/timeout off'));

    expect(cancelQueuedScope).toHaveBeenCalledWith('chat-1');
    expect(setIdleTimeoutMinutes).toHaveBeenCalledWith('chat-1', 0);
    expect(stop).not.toHaveBeenCalled();
    expect(await persistentQueue.recoverable()).toEqual([
      expect.objectContaining({ id: 'running-timeout', scope: 'chat-1', state: 'running' }),
    ]);
  });

  test('exact /stop replies with failure and leaves active run running when durable cancel fails', async () => {
    const messages: Record<string, (msg: NormalizedMessage) => Promise<void>> = {};
    const activeRuns = new ActiveRuns();
    let stopCount = 0;
    const run: AgentRun = {
      events: (async function* (): AsyncGenerator<AgentEvent> {})(),
      async stop() {
        stopCount++;
      },
      async waitForExit() {
        return true;
      },
    };
    activeRuns.register('chat-1', run);
    const persistentQueue = {
      cancelScope: vi.fn(async () => {
        throw new Error('durable stop cleanup failed');
      }),
    } as unknown as PersistentQueue;
    const fakeChannel = createFakeChannel(messages);
    const send = vi.spyOn(fakeChannel, 'send');
    vi.mocked(createLarkChannel).mockReturnValue(fakeChannel);

    await startChannel({
      cfg: textReplyConfig(),
      agent: fakeAgent(() => {}),
      sessions: fakeSessions(),
      workspaces: fakeWorkspaces('/tmp/project'),
      controls: fakeControls(textReplyConfig()),
      persistentQueue,
      activeRuns,
    });

    const onMessage = messages.message;
    if (!onMessage) throw new Error('message handler was not registered');
    await onMessage(fakeMessage('stop-fails', '/stop'));

    expect(persistentQueue.cancelScope).toHaveBeenCalledWith('chat-1');
    expect(stopCount).toBe(0);
    expect(activeRuns.interrupt('chat-1')).toBe(true);
    expect(send).toHaveBeenCalledWith(
      'chat-1',
      { markdown: expect.stringContaining('终止任务失败') },
      { replyTo: 'stop-fails' },
    );
  });

  test('runs cloud-doc comments with the backend selected for the doc scope', async () => {
    const calls: string[] = [];
    const claude = fakeNamedAgent('claude', calls);
    const codex = fakeNamedAgent('codex', calls);
    const registry = new AgentRegistry(['claude', 'codex'], 'claude', async (key) => key === 'codex' ? codex : claude);
    const backendStore = { get: (scope: string) => scope === 'doc:doc-token' ? 'codex' : undefined, async flush() {} };
    const sessions = {
      ...fakeSessions(),
      resumeFor: vi.fn((scope: string, _cwd: string, sessionKey: string) =>
        scope === 'doc:doc-token' && sessionKey === 'codex' ? 'codex-session' : undefined,
      ),
    } as unknown as SessionStore;
    const handlers: Record<string, (evt: never) => Promise<void>> = {};
    const fakeChannel = createDocCommentChannel(handlers);
    vi.mocked(createLarkChannel).mockReturnValue(fakeChannel);

    await startChannel({
      cfg: textReplyConfig(),
      agentRegistry: registry,
      backendStore: backendStore as never,
      sessions,
      workspaces: fakeWorkspaces('/tmp/doc-cwd'),
      controls: fakeControls(textReplyConfig()),
      persistentQueue: tempPersistentQueue(),
    });

    await handlers.comment?.({
      fileToken: 'doc-token',
      fileType: 'docx',
      commentId: 'comment-1',
      replyId: 'reply-1',
      mentionedBot: true,
      operator: { openId: 'ou_user' },
    } as never);

    await vi.waitFor(() => expect(calls).toEqual(['codex']));
    expect(sessions.resumeFor).toHaveBeenCalledWith('doc:doc-token', '/tmp/doc-cwd', 'codex');
  });

  test('serializes cloud-doc comments for the same document', async () => {
    const calls: string[] = [];
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const agent = fakeAgentWithEvents(async function* (): AsyncGenerator<AgentEvent> {
      calls.push('start');
      if (calls.length === 1) await firstBlocked;
      calls.push('end');
      yield { type: 'text', delta: 'comment answer' };
      yield { type: 'done' };
    });
    const handlers: Record<string, (evt: never) => Promise<void>> = {};
    const fakeChannel = createDocCommentChannel(handlers);
    vi.mocked(createLarkChannel).mockReturnValue(fakeChannel);

    await startChannel({
      cfg: textReplyConfig(),
      agent,
      sessions: fakeSessions(),
      workspaces: fakeWorkspaces('/tmp/doc-cwd'),
      controls: fakeControls(textReplyConfig()),
      persistentQueue: tempPersistentQueue(),
    });

    void handlers.comment?.({
      fileToken: 'doc-token',
      fileType: 'docx',
      commentId: 'comment-1',
      replyId: 'reply-1',
      mentionedBot: true,
      operator: { openId: 'ou_user' },
    } as never);
    void handlers.comment?.({
      fileToken: 'doc-token',
      fileType: 'docx',
      commentId: 'comment-1',
      replyId: 'reply-1',
      mentionedBot: true,
      operator: { openId: 'ou_user' },
    } as never);

    await vi.waitFor(() => expect(calls).toEqual(['start']));
    releaseFirst();
    await vi.waitFor(() => expect(calls).toEqual(['start', 'end', 'start', 'end']));
  });

  test('sends a temporary check message after text reply runs finish', async () => {
    vi.useFakeTimers();
    const messages: Record<string, (msg: NormalizedMessage) => Promise<void>> = {};
    const send = vi.fn(async (_chatId: string, payload: unknown) => {
      const markdown = (payload as { markdown?: string }).markdown;
      return { messageId: markdown === '请检查' ? 'om_check' : 'om_sent_text' };
    });
    const deleteMessage = vi.fn(async () => undefined);
    const fakeChannel = {
      ...createFakeChannel(messages),
      send,
      rawClient: {
        im: {
          v1: {
            message: { delete: deleteMessage },
            messageReaction: {
              async create() {
                return { data: { reaction_id: 'reaction-1' } };
              },
              async delete() {},
            },
          },
        },
      },
    } as unknown as LarkChannel;
    vi.mocked(createLarkChannel).mockReturnValue(fakeChannel);

    await startChannel({
      cfg: textReplyConfig(),
      agent: fakeAgent(() => {}),
      sessions: fakeSessions(),
      workspaces: fakeWorkspaces('/tmp/project'),
      controls: fakeControls(textReplyConfig()),
      persistentQueue: tempPersistentQueue(),
    });

    const onMessage = messages.message;
    if (!onMessage) throw new Error('message handler was not registered');
    await onMessage(fakeMessage('om_original', 'original prompt'));

    await vi.waitFor(() => expect(send).toHaveBeenCalledWith('chat-1', { markdown: '请检查' }));
    expect(deleteMessage).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(12 * 60 * 60 * 1000);

    expect(deleteMessage).toHaveBeenCalledWith({ path: { message_id: 'om_check' } });
    vi.useRealTimers();
  });

  test('sends the temporary check message in the source topic thread', async () => {
    vi.useFakeTimers();
    try {
      const messages: Record<string, (msg: NormalizedMessage) => Promise<void>> = {};
      const send = vi.fn(async (_chatId: string, payload: unknown) => {
        const markdown = (payload as { markdown?: string }).markdown;
        return { messageId: markdown === '请检查' ? 'om_check' : 'om_sent_text' };
      });
      const fakeChannel = {
        ...createFakeChannel(messages),
        send,
        async getChatMode() {
          return 'topic';
        },
        rawClient: {
          im: {
            v1: {
              message: { async delete() {} },
              messageReaction: {
                async create() {
                  return { data: { reaction_id: 'reaction-1' } };
                },
                async delete() {},
              },
            },
          },
        },
      } as unknown as LarkChannel;
      vi.mocked(createLarkChannel).mockReturnValue(fakeChannel);

      await startChannel({
        cfg: textReplyConfig(),
        agent: fakeAgent(() => {}),
        sessions: fakeSessions(),
        workspaces: fakeWorkspaces('/tmp/project'),
        controls: fakeControls(textReplyConfig()),
        persistentQueue: tempPersistentQueue(),
      });

      const onMessage = messages.message;
      if (!onMessage) throw new Error('message handler was not registered');
      await onMessage(fakeMessage('om_original', 'original prompt', { threadId: 'thread-1' }));

      await vi.waitFor(() =>
        expect(send).toHaveBeenCalledWith(
          'chat-1',
          { markdown: '请检查' },
          { replyTo: 'om_original', replyInThread: true },
        ),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  test('threads the temporary check message when a thread id is present even if chat mode is group', async () => {
    vi.useFakeTimers();
    try {
      const messages: Record<string, (msg: NormalizedMessage) => Promise<void>> = {};
      const send = vi.fn(async (_chatId: string, payload: unknown) => {
        const markdown = (payload as { markdown?: string }).markdown;
        return { messageId: markdown === '请检查' ? 'om_check' : 'om_sent_text' };
      });
      const sessions = {
        ...fakeSessions(),
        resumeFor: vi.fn(() => undefined),
      } as unknown as SessionStore;
      const fakeChannel = {
        ...createFakeChannel(messages),
        send,
        async getChatMode() {
          return 'group';
        },
        rawClient: {
          im: {
            v1: {
              message: { async delete() {} },
              messageReaction: {
                async create() {
                  return { data: { reaction_id: 'reaction-1' } };
                },
                async delete() {},
              },
            },
          },
        },
      } as unknown as LarkChannel;
      vi.mocked(createLarkChannel).mockReturnValue(fakeChannel);

      await startChannel({
        cfg: textReplyConfig(),
        agent: fakeAgent(() => {}),
        sessions,
        workspaces: fakeWorkspaces('/tmp/project'),
        controls: fakeControls(textReplyConfig()),
        persistentQueue: tempPersistentQueue(),
      });

      const onMessage = messages.message;
      if (!onMessage) throw new Error('message handler was not registered');
      await onMessage(fakeMessage('om_original', 'original prompt', { threadId: 'thread-1' }));

      await vi.waitFor(() =>
        expect(send).toHaveBeenCalledWith(
          'chat-1',
          { markdown: '请检查' },
          { replyTo: 'om_original', replyInThread: true },
        ),
      );
      expect(sessions.resumeFor).toHaveBeenCalledWith('chat-1:thread-1', '/tmp/project', 'fake:test');
    } finally {
      vi.useRealTimers();
    }
  });

  test('text replies persist sent message ids in run history', async () => {
    let persistedStreamMessageId: string | undefined;
    const originalUpdate = RunHistory.prototype.update;
    const update = vi.spyOn(RunHistory.prototype, 'update').mockImplementation(function (
      this: RunHistory,
      runId,
      changes,
    ) {
      originalUpdate.call(this, runId, changes);
      persistedStreamMessageId = this.get(runId)?.streamMessageId;
    });
    const messages: Record<string, (msg: NormalizedMessage) => Promise<void>> = {};
    const fakeChannel = createFakeChannel(messages);
    vi.mocked(createLarkChannel).mockReturnValue(fakeChannel);

    await startChannel({
      cfg: textReplyConfig(),
      agent: fakeAgent(() => {}),
      sessions: fakeSessions(),
      workspaces: fakeWorkspaces('/tmp/project'),
      controls: fakeControls(textReplyConfig()),
      persistentQueue: tempPersistentQueue(),
    });

    const onMessage = messages.message;
    if (!onMessage) throw new Error('message handler was not registered');
    await onMessage(fakeMessage('om_original', 'original prompt'));

    await vi.waitFor(() =>
      expect(update).toHaveBeenCalledWith(expect.any(String), { streamMessageId: 'om_sent_text' }),
    );
    expect(persistedStreamMessageId).toBe('om_sent_text');
  });

  test('fallback replies persist sent message ids in run history when streaming fails before returning', async () => {
    let persistedStreamMessageId: string | undefined;
    const originalUpdate = RunHistory.prototype.update;
    const update = vi.spyOn(RunHistory.prototype, 'update').mockImplementation(function (
      this: RunHistory,
      runId,
      changes,
    ) {
      originalUpdate.call(this, runId, changes);
      persistedStreamMessageId = this.get(runId)?.streamMessageId;
    });
    const messages: Record<string, (msg: NormalizedMessage) => Promise<void>> = {};
    const fakeChannel = {
      ...createFakeChannel(messages),
      async stream() {
        throw new Error('stream failed before message id');
      },
      async send() {
        return { messageId: 'om_fallback' };
      },
    } as unknown as LarkChannel;
    const cfg = cardReplyConfig();
    vi.mocked(createLarkChannel).mockReturnValue(fakeChannel);

    await startChannel({
      cfg,
      agent: fakeAgent(() => {}),
      sessions: fakeSessions(),
      workspaces: fakeWorkspaces('/tmp/project'),
      controls: fakeControls(cfg),
      persistentQueue: tempPersistentQueue(),
    });

    const onMessage = messages.message;
    if (!onMessage) throw new Error('message handler was not registered');
    await onMessage(fakeMessage('om_original', 'original prompt'));

    await vi.waitFor(() =>
      expect(update).toHaveBeenCalledWith(expect.any(String), { streamMessageId: 'om_fallback' }),
    );
    expect(persistedStreamMessageId).toBe('om_fallback');
  });

  test('marks group chat unread after successful final card update by default', async () => {
    const messages: Record<string, (msg: NormalizedMessage) => Promise<void>> = {};
    const markUnread = vi.fn(async () => {});
    const fakeChannel = createFinalCardChannel(messages, { markUnread });
    const cfg = cardReplyConfig();
    vi.mocked(createLarkChannel).mockReturnValue(fakeChannel);

    await startChannel({
      cfg,
      agent: fakeAgent(() => {}),
      sessions: fakeSessions(),
      workspaces: fakeWorkspaces('/tmp/project'),
      controls: fakeControls(cfg),
      persistentQueue: tempPersistentQueue(),
    });

    const onMessage = messages.message;
    if (!onMessage) throw new Error('message handler was not registered');
    await onMessage(fakeMessage('om_original', 'original prompt'));

    await vi.waitFor(() => expect(markUnread).toHaveBeenCalledOnce());
  });

  test('does not mark group chat unread when final-card unread preference is disabled', async () => {
    const messages: Record<string, (msg: NormalizedMessage) => Promise<void>> = {};
    const markUnread = vi.fn(async () => {});
    const updateCard = vi.fn(async () => {});
    const fakeChannel = createFinalCardChannel(messages, { markUnread, updateCard });
    const cfg: AppConfig = {
      ...cardReplyConfig(),
      preferences: {
        ...cardReplyConfig().preferences,
        markGroupUnreadOnFinalCard: false,
      },
    };
    vi.mocked(createLarkChannel).mockReturnValue(fakeChannel);

    await startChannel({
      cfg,
      agent: fakeAgent(() => {}),
      sessions: fakeSessions(),
      workspaces: fakeWorkspaces('/tmp/project'),
      controls: fakeControls(cfg),
      persistentQueue: tempPersistentQueue(),
    });

    const onMessage = messages.message;
    if (!onMessage) throw new Error('message handler was not registered');
    await onMessage(fakeMessage('om_original', 'original prompt'));

    await vi.waitFor(() => expect(updateCard).toHaveBeenCalledOnce());
    expect(markUnread).not.toHaveBeenCalled();
  });

  test('does not mark p2p chats unread after final card update', async () => {
    const messages: Record<string, (msg: NormalizedMessage) => Promise<void>> = {};
    const markUnread = vi.fn(async () => {});
    const updateCard = vi.fn(async () => {});
    const fakeChannel = createFinalCardChannel(messages, { chatMode: 'p2p', markUnread, updateCard });
    const cfg = cardReplyConfig();
    vi.mocked(createLarkChannel).mockReturnValue(fakeChannel);

    await startChannel({
      cfg,
      agent: fakeAgent(() => {}),
      sessions: fakeSessions(),
      workspaces: fakeWorkspaces('/tmp/project'),
      controls: fakeControls(cfg),
      persistentQueue: tempPersistentQueue(),
    });

    const onMessage = messages.message;
    if (!onMessage) throw new Error('message handler was not registered');
    await onMessage(fakeMessage('om_original', 'original prompt'));

    await vi.waitFor(() => expect(updateCard).toHaveBeenCalledOnce());
    expect(markUnread).not.toHaveBeenCalled();
  });

  test('mark-unread failure does not prevent run completion', async () => {
    const messages: Record<string, (msg: NormalizedMessage) => Promise<void>> = {};
    const updateCard = vi.fn(async () => {});
    const markUnread = vi.fn(async () => {
      throw new Error('mark unread failed');
    });
    const fakeChannel = createFinalCardChannel(messages, { markUnread, updateCard });
    const cfg = cardReplyConfig();
    vi.mocked(createLarkChannel).mockReturnValue(fakeChannel);

    await startChannel({
      cfg,
      agent: fakeAgent(() => {}),
      sessions: fakeSessions(),
      workspaces: fakeWorkspaces('/tmp/project'),
      controls: fakeControls(cfg),
      persistentQueue: tempPersistentQueue(),
    });

    const onMessage = messages.message;
    if (!onMessage) throw new Error('message handler was not registered');
    await onMessage(fakeMessage('om_original', 'original prompt'));

    await vi.waitFor(() => expect(updateCard).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(markUnread).toHaveBeenCalledOnce());
  });

  test('markdown reply mode shows a cutoff note after 10 minutes and still final-updates the card', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const messages: Record<string, (msg: NormalizedMessage) => Promise<void>> = {};
    const markdownUpdates: string[] = [];
    const finalCards: unknown[] = [];
    let resolveFinalCard!: () => void;
    const finalCardUpdated = new Promise<void>((resolve) => {
      resolveFinalCard = resolve;
    });
    const fakeChannel = {
      ...createFakeChannel(messages),
      async stream(_chatId: string, payload: { markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void> }) {
        if (!payload.markdown) throw new Error('markdown stream producer was not registered');
        await payload.markdown({
          async setContent(markdown: string) {
            markdownUpdates.push(markdown);
          },
        });
        return { messageId: 'om_markdown_stream' };
      },
      async updateCard(_messageId: string, card: unknown) {
        finalCards.push(card);
        resolveFinalCard();
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
      persistentQueue: tempPersistentQueue(),
    });

    const onMessage = messages.message;
    if (!onMessage) throw new Error('message handler was not registered');
    await onMessage(fakeMessage('om_original', 'original prompt'));
    await finalCardUpdated;

    expect(markdownUpdates.some((markdown) => markdown.includes('已运行超过 10 分钟'))).toBe(true);
    expect(markdownUpdates.some((markdown) => markdown.includes('飞书卡片将停止自动刷新'))).toBe(true);
    expect(finalCards[0]).toMatchObject({
      schema: '2.0',
      config: {
        streaming_mode: false,
        summary: { content: '已完成' },
      },
    });
  });

  test('starts periodic markdown refresh when cutoff timer fires without another flush', async () => {
    vi.useFakeTimers();
    let now = 0;
    const setContent = vi.fn(async (_markdown: string) => {});
    const updateLatest = vi.fn(async (_markdown: string) => {});
    const cutoff = createMarkdownRefreshCutoff(setContent, () => now, {
      periodicMs: 30_000,
      updateLatest,
    });

    await cutoff.flush('before cutoff');
    now += 600_000;
    await vi.advanceTimersByTimeAsync(600_000);

    now += 30_000;
    await vi.advanceTimersByTimeAsync(30_000);

    expect(updateLatest).toHaveBeenCalledOnce();
    expect(updateLatest).toHaveBeenCalledWith('before cutoff');
    cutoff.dispose();
  });

  test('markdown reply mode periodically updateCards latest content after the cutoff before final completion', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const messages: Record<string, (msg: NormalizedMessage) => Promise<void>> = {};
      let releaseStream!: () => void;
      const streamReleased = new Promise<void>((resolve) => {
        releaseStream = resolve;
      });
      let resolveStreamStarted!: () => void;
      const streamStarted = new Promise<void>((resolve) => {
        resolveStreamStarted = resolve;
      });
      let resolveStreamFinished!: () => void;
      const streamFinished = new Promise<void>((resolve) => {
        resolveStreamFinished = resolve;
      });
      const updateCard = vi.fn(async (_messageId: string, _card: unknown) => {});
      const fakeChannel = {
        ...createFakeChannel(messages),
        async stream(_chatId: string, payload: { markdown?: (ctrl: { messageId: string; setContent(markdown: string): Promise<void> }) => Promise<void> }) {
          if (!payload.markdown) throw new Error('markdown stream producer was not registered');
          resolveStreamStarted();
          await payload.markdown({
            messageId: 'om_markdown_stream',
            async setContent() {},
          });
          resolveStreamFinished();
          return { messageId: 'om_markdown_stream' };
        },
        updateCard,
      } as unknown as LarkChannel;
      const cfg = markdownReplyConfig();
      vi.mocked(createLarkChannel).mockReturnValue(fakeChannel);

      await startChannel({
        cfg,
        agent: fakeAgentWithEvents(async function* (): AsyncGenerator<AgentEvent> {
          yield { type: 'text', delta: 'first' };
          yield { type: 'text', delta: ' second' };
          await streamReleased;
          yield { type: 'done' };
        }),
        sessions: fakeSessions(),
        workspaces: fakeWorkspaces('/tmp/project'),
        controls: fakeControls(cfg),
        persistentQueue: tempPersistentQueue(),
      });

      const onMessage = messages.message;
      if (!onMessage) throw new Error('message handler was not registered');
      await onMessage(fakeMessage('om_original', 'original prompt'));
      await streamStarted;
      await vi.waitFor(() => expect(updateCard).not.toHaveBeenCalled());

      await vi.advanceTimersByTimeAsync(10 * 60_000);
      await vi.advanceTimersByTimeAsync(30_000);

      await vi.waitFor(() => expect(updateCard).toHaveBeenCalled());
      expect(updateCard.mock.calls[0]?.[0]).toBe('om_markdown_stream');
      expect(JSON.stringify(updateCard.mock.calls[0]?.[1])).toContain('first second');
      releaseStream();
      await streamFinished;
    } finally {
      vi.useRealTimers();
    }
  });

  test('re-applies the final markdown card after a delayed periodic refresh settles', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const messages: Record<string, (msg: NormalizedMessage) => Promise<void>> = {};
      const appliedCards: unknown[] = [];
      let releaseStream!: () => void;
      const streamReleased = new Promise<void>((resolve) => {
        releaseStream = resolve;
      });
      let resolveStreamStarted!: () => void;
      const streamStarted = new Promise<void>((resolve) => {
        resolveStreamStarted = resolve;
      });
      let resolvePeriodicStarted!: () => void;
      const periodicStarted = new Promise<void>((resolve) => {
        resolvePeriodicStarted = resolve;
      });
      let releasePeriodic!: () => void;
      const periodicReleased = new Promise<void>((resolve) => {
        releasePeriodic = resolve;
      });
      const fakeChannel = {
        ...createFakeChannel(messages),
        async stream(_chatId: string, payload: { markdown?: (ctrl: { messageId: string; setContent(markdown: string): Promise<void> }) => Promise<void> }) {
          if (!payload.markdown) throw new Error('markdown stream producer was not registered');
          resolveStreamStarted();
          await payload.markdown({
            messageId: 'om_markdown_stream',
            async setContent() {},
          });
          return { messageId: 'om_markdown_stream' };
        },
        async updateCard(_messageId: string, card: unknown) {
          const summary = (card as { config?: { summary?: { content?: string } } }).config?.summary?.content;
          if (summary === '运行中') {
            resolvePeriodicStarted();
            await periodicReleased;
          }
          appliedCards.push(card);
        },
      } as unknown as LarkChannel;
      const cfg = markdownReplyConfig();
      vi.mocked(createLarkChannel).mockReturnValue(fakeChannel);

      await startChannel({
        cfg,
        agent: fakeAgentWithEvents(async function* (): AsyncGenerator<AgentEvent> {
          yield { type: 'text', delta: 'first' };
          yield { type: 'text', delta: ' second' };
          await streamReleased;
          yield { type: 'done' };
        }),
        sessions: fakeSessions(),
        workspaces: fakeWorkspaces('/tmp/project'),
        controls: fakeControls(cfg),
        persistentQueue: tempPersistentQueue(),
      });

      const onMessage = messages.message;
      if (!onMessage) throw new Error('message handler was not registered');
      await onMessage(fakeMessage('om_original', 'original prompt'));
      await streamStarted;

      await vi.advanceTimersByTimeAsync(10 * 60_000);
      await vi.advanceTimersByTimeAsync(30_000);
      await periodicStarted;

      releaseStream();
      await vi.waitFor(() =>
        expect(appliedCards).toContainEqual(
          expect.objectContaining({ config: expect.objectContaining({ summary: { content: '已完成' } }) }),
        ),
      );

      releasePeriodic();

      await vi.waitFor(() => expect(appliedCards).toHaveLength(3));
      expect(appliedCards.at(-1)).toMatchObject({ config: { streaming_mode: false, summary: { content: '已完成' } } });
    } finally {
      vi.useRealTimers();
    }
  });

  test('re-applies the final markdown card after a timed-out periodic refresh resolves late', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const messages: Record<string, (msg: NormalizedMessage) => Promise<void>> = {};
      const visibleUpdates: Array<{ kind: 'card'; summary: string | undefined }> = [];
      let releaseStream!: () => void;
      const streamReleased = new Promise<void>((resolve) => {
        releaseStream = resolve;
      });
      let resolveStreamStarted!: () => void;
      const streamStarted = new Promise<void>((resolve) => {
        resolveStreamStarted = resolve;
      });
      let resolvePeriodicStarted!: () => void;
      const periodicStarted = new Promise<void>((resolve) => {
        resolvePeriodicStarted = resolve;
      });
      let releasePeriodic!: () => void;
      const periodicReleased = new Promise<void>((resolve) => {
        releasePeriodic = resolve;
      });
      const fakeChannel = {
        ...createFakeChannel(messages),
        async stream(_chatId: string, payload: { markdown?: (ctrl: { messageId: string; setContent(markdown: string): Promise<void> }) => Promise<void> }) {
          if (!payload.markdown) throw new Error('markdown stream producer was not registered');
          resolveStreamStarted();
          await payload.markdown({
            messageId: 'om_markdown_stream',
            async setContent() {},
          });
          return { messageId: 'om_markdown_stream' };
        },
        async updateCard(_messageId: string, card: unknown) {
          const summary = (card as { config?: { summary?: { content?: string } } }).config?.summary?.content;
          if (summary === '运行中') {
            resolvePeriodicStarted();
            await periodicReleased;
          }
          visibleUpdates.push({ kind: 'card', summary });
        },
      } as unknown as LarkChannel;
      const cfg = markdownReplyConfig();
      vi.mocked(createLarkChannel).mockReturnValue(fakeChannel);

      await startChannel({
        cfg,
        agent: fakeAgentWithEvents(async function* (): AsyncGenerator<AgentEvent> {
          yield { type: 'text', delta: 'first' };
          yield { type: 'text', delta: ' second' };
          await streamReleased;
          yield { type: 'done' };
        }),
        sessions: fakeSessions(),
        workspaces: fakeWorkspaces('/tmp/project'),
        controls: fakeControls(cfg),
        persistentQueue: tempPersistentQueue(),
      });

      const onMessage = messages.message;
      if (!onMessage) throw new Error('message handler was not registered');
      await onMessage(fakeMessage('om_original', 'original prompt'));
      await streamStarted;

      await vi.advanceTimersByTimeAsync(10 * 60_000);
      await vi.advanceTimersByTimeAsync(30_000);
      await periodicStarted;
      await vi.advanceTimersByTimeAsync(20_000);

      releaseStream();
      await vi.waitFor(() => expect(visibleUpdates).toContainEqual({ kind: 'card', summary: '已完成' }));

      releasePeriodic();
      await vi.waitFor(() => expect(visibleUpdates.length).toBeGreaterThanOrEqual(3));

      expect(visibleUpdates.at(-1)).toEqual({ kind: 'card', summary: '已完成' });
    } finally {
      vi.useRealTimers();
    }
  });

  test('waits for all timed-out periodic markdown refreshes before re-applying the final card', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const messages: Record<string, (msg: NormalizedMessage) => Promise<void>> = {};
      const visibleUpdates: Array<{ kind: 'card'; summary: string | undefined; refresh?: number }> = [];
      let releaseStream!: () => void;
      const streamReleased = new Promise<void>((resolve) => {
        releaseStream = resolve;
      });
      let resolveStreamStarted!: () => void;
      const streamStarted = new Promise<void>((resolve) => {
        resolveStreamStarted = resolve;
      });
      let resolveFirstPeriodicStarted!: () => void;
      const firstPeriodicStarted = new Promise<void>((resolve) => {
        resolveFirstPeriodicStarted = resolve;
      });
      let resolveSecondPeriodicStarted!: () => void;
      const secondPeriodicStarted = new Promise<void>((resolve) => {
        resolveSecondPeriodicStarted = resolve;
      });
      let releaseFirstPeriodic!: () => void;
      const firstPeriodicReleased = new Promise<void>((resolve) => {
        releaseFirstPeriodic = resolve;
      });
      let releaseSecondPeriodic!: () => void;
      const secondPeriodicReleased = new Promise<void>((resolve) => {
        releaseSecondPeriodic = resolve;
      });
      let periodicRefreshes = 0;
      const fakeChannel = {
        ...createFakeChannel(messages),
        async stream(_chatId: string, payload: { markdown?: (ctrl: { messageId: string; setContent(markdown: string): Promise<void> }) => Promise<void> }) {
          if (!payload.markdown) throw new Error('markdown stream producer was not registered');
          resolveStreamStarted();
          await payload.markdown({
            messageId: 'om_markdown_stream',
            async setContent() {},
          });
          return { messageId: 'om_markdown_stream' };
        },
        async updateCard(_messageId: string, card: unknown) {
          const summary = (card as { config?: { summary?: { content?: string } } }).config?.summary?.content;
          if (summary === '运行中') {
            periodicRefreshes += 1;
            const refresh = periodicRefreshes;
            if (refresh === 1) {
              resolveFirstPeriodicStarted();
              await firstPeriodicReleased;
            } else if (refresh === 2) {
              resolveSecondPeriodicStarted();
              await secondPeriodicReleased;
            }
            visibleUpdates.push({ kind: 'card', summary, refresh });
            return;
          }
          visibleUpdates.push({ kind: 'card', summary });
        },
      } as unknown as LarkChannel;
      const cfg = markdownReplyConfig();
      vi.mocked(createLarkChannel).mockReturnValue(fakeChannel);

      await startChannel({
        cfg,
        agent: fakeAgentWithEvents(async function* (): AsyncGenerator<AgentEvent> {
          yield { type: 'text', delta: 'first' };
          yield { type: 'text', delta: ' second' };
          await streamReleased;
          yield { type: 'done' };
        }),
        sessions: fakeSessions(),
        workspaces: fakeWorkspaces('/tmp/project'),
        controls: fakeControls(cfg),
        persistentQueue: tempPersistentQueue(),
      });

      const onMessage = messages.message;
      if (!onMessage) throw new Error('message handler was not registered');
      await onMessage(fakeMessage('om_original', 'original prompt'));
      await streamStarted;

      await vi.advanceTimersByTimeAsync(10 * 60_000);
      await vi.advanceTimersByTimeAsync(30_000);
      await firstPeriodicStarted;
      await vi.advanceTimersByTimeAsync(20_000);
      await vi.advanceTimersByTimeAsync(30_000);
      await secondPeriodicStarted;
      await vi.advanceTimersByTimeAsync(20_000);

      releaseStream();
      await vi.waitFor(() => expect(visibleUpdates).toContainEqual({ kind: 'card', summary: '已完成' }));

      releaseSecondPeriodic();
      await vi.waitFor(() => expect(visibleUpdates).toContainEqual({ kind: 'card', summary: '运行中', refresh: 2 }));

      releaseFirstPeriodic();
      await vi.waitFor(() => expect(visibleUpdates).toContainEqual({ kind: 'card', summary: '运行中', refresh: 1 }));
      await vi.waitFor(() => expect(visibleUpdates.at(-1)).toEqual({ kind: 'card', summary: '已完成' }));
    } finally {
      vi.useRealTimers();
    }
  });

  test('re-applies the final markdown card after a delayed cutoff notice settles', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const messages: Record<string, (msg: NormalizedMessage) => Promise<void>> = {};
    const markdownUpdates: string[] = [];
    const finalCards: unknown[] = [];
    let resolveCutoffNotice!: () => void;
    const cutoffNoticeStarted = new Promise<void>((resolve) => {
      resolveCutoffNotice = resolve;
    });
    let releaseCutoffNotice!: () => void;
    const cutoffNoticeReleased = new Promise<void>((resolve) => {
      releaseCutoffNotice = resolve;
    });
    const fakeChannel = {
      ...createFakeChannel(messages),
      async stream(_chatId: string, payload: { markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void> }) {
        if (!payload.markdown) throw new Error('markdown stream producer was not registered');
        await payload.markdown({
          async setContent(markdown: string) {
            markdownUpdates.push(markdown);
            if (markdown.includes('飞书卡片将停止自动刷新')) {
              resolveCutoffNotice();
              await cutoffNoticeReleased;
            }
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
        yield { type: 'done' };
      }),
      sessions: fakeSessions(),
      workspaces: fakeWorkspaces('/tmp/project'),
      controls: fakeControls(cfg),
      persistentQueue: tempPersistentQueue(),
    });

    const onMessage = messages.message;
    if (!onMessage) throw new Error('message handler was not registered');
    await onMessage(fakeMessage('om_original', 'original prompt'));
    await cutoffNoticeStarted;
    await vi.waitFor(() => expect(finalCards).toHaveLength(1));

    releaseCutoffNotice();

    await vi.waitFor(() => expect(finalCards).toHaveLength(2));
    expect(markdownUpdates.some((markdown) => markdown.includes('飞书卡片将停止自动刷新'))).toBe(true);
    expect(finalCards[0]).toMatchObject({ config: { streaming_mode: false, summary: { content: '已完成' } } });
    expect(finalCards[1]).toMatchObject({ config: { streaming_mode: false, summary: { content: '已完成' } } });
  });

  test('re-applies the final markdown card after delayed cutoff notice and periodic refresh settle', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const messages: Record<string, (msg: NormalizedMessage) => Promise<void>> = {};
      const visibleUpdates: Array<{ kind: 'markdown'; content: string } | { kind: 'card'; summary: string | undefined }> = [];
      const appliedCards: unknown[] = [];
      let releaseStream!: () => void;
      const streamReleased = new Promise<void>((resolve) => {
        releaseStream = resolve;
      });
      let resolveStreamStarted!: () => void;
      const streamStarted = new Promise<void>((resolve) => {
        resolveStreamStarted = resolve;
      });
      let resolveCutoffNoticeStarted!: () => void;
      const cutoffNoticeStarted = new Promise<void>((resolve) => {
        resolveCutoffNoticeStarted = resolve;
      });
      let releaseCutoffNotice!: () => void;
      const cutoffNoticeReleased = new Promise<void>((resolve) => {
        releaseCutoffNotice = resolve;
      });
      let resolvePeriodicStarted!: () => void;
      const periodicStarted = new Promise<void>((resolve) => {
        resolvePeriodicStarted = resolve;
      });
      let releasePeriodic!: () => void;
      const periodicReleased = new Promise<void>((resolve) => {
        releasePeriodic = resolve;
      });
      const fakeChannel = {
        ...createFakeChannel(messages),
        async stream(_chatId: string, payload: { markdown?: (ctrl: { messageId: string; setContent(markdown: string): Promise<void> }) => Promise<void> }) {
          if (!payload.markdown) throw new Error('markdown stream producer was not registered');
          resolveStreamStarted();
          await payload.markdown({
            messageId: 'om_markdown_stream',
            async setContent(markdown: string) {
              if (markdown.includes('飞书卡片将停止自动刷新')) {
                resolveCutoffNoticeStarted();
                await cutoffNoticeReleased;
              }
              visibleUpdates.push({ kind: 'markdown', content: markdown });
            },
          });
          return { messageId: 'om_markdown_stream' };
        },
        async updateCard(_messageId: string, card: unknown) {
          const summary = (card as { config?: { summary?: { content?: string } } }).config?.summary?.content;
          if (summary === '运行中') {
            resolvePeriodicStarted();
            await periodicReleased;
          }
          visibleUpdates.push({ kind: 'card', summary });
          appliedCards.push(card);
        },
      } as unknown as LarkChannel;
      const cfg = markdownReplyConfig();
      vi.mocked(createLarkChannel).mockReturnValue(fakeChannel);

      await startChannel({
        cfg,
        agent: fakeAgentWithEvents(async function* (): AsyncGenerator<AgentEvent> {
          yield { type: 'text', delta: 'first' };
          yield { type: 'text', delta: ' second' };
          await streamReleased;
          yield { type: 'done' };
        }),
        sessions: fakeSessions(),
        workspaces: fakeWorkspaces('/tmp/project'),
        controls: fakeControls(cfg),
        persistentQueue: tempPersistentQueue(),
      });

      const onMessage = messages.message;
      if (!onMessage) throw new Error('message handler was not registered');
      await onMessage(fakeMessage('om_original', 'original prompt'));
      await streamStarted;

      await vi.advanceTimersByTimeAsync(10 * 60_000);
      await cutoffNoticeStarted;
      await vi.advanceTimersByTimeAsync(30_000);
      await periodicStarted;

      releaseStream();
      await vi.waitFor(() =>
        expect(appliedCards).toContainEqual(
          expect.objectContaining({ config: expect.objectContaining({ summary: { content: '已完成' } }) }),
        ),
      );

      releasePeriodic();
      releaseCutoffNotice();

      await vi.waitFor(() => expect(appliedCards).toHaveLength(3));
      expect(visibleUpdates.at(-1)).toEqual({ kind: 'card', summary: '已完成' });
      expect(appliedCards.at(-1)).toMatchObject({ config: { streaming_mode: false, summary: { content: '已完成' } } });
    } finally {
      vi.useRealTimers();
    }
  });

  test('card reply mode does not use the markdown refresh cutoff note', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const messages: Record<string, (msg: NormalizedMessage) => Promise<void>> = {};
    const cardUpdates: string[] = [];
    let resolveUpdateCard!: () => void;
    const updateCardCalled = new Promise<void>((resolve) => {
      resolveUpdateCard = resolve;
    });
    const fakeChannel = {
      ...createFakeChannel(messages),
      async stream(
        _chatId: string,
        payload: { card?: { initial: unknown; producer(ctrl: { update(card: unknown): Promise<void> }): Promise<void> } },
      ) {
        if (!payload.card) throw new Error('card stream producer was not registered');
        cardUpdates.push(JSON.stringify(payload.card.initial));
        await payload.card.producer({
          async update(card: unknown) {
            cardUpdates.push(JSON.stringify(card));
          },
        });
        return { messageId: 'om_card_stream' };
      },
      async updateCard(_messageId: string, card: unknown) {
        cardUpdates.push(JSON.stringify(card));
        resolveUpdateCard();
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
      persistentQueue: tempPersistentQueue(),
    });

    const onMessage = messages.message;
    if (!onMessage) throw new Error('message handler was not registered');
    await onMessage(fakeMessage('om_original', 'original prompt'));
    await updateCardCalled;

    expect(cardUpdates.length).toBeGreaterThan(0);
    const joined = cardUpdates.join('\n');
    expect(joined).not.toContain('已运行超过 10 分钟');
    expect(joined).not.toContain('飞书卡片将停止自动刷新');
  });
});

describe('persistent queue recovery', () => {
  test('restores queued and running records on startup', async () => {
    const persistentQueue = tempPersistentQueue();
    await persistentQueue.enqueue('chat-1', [fakeMessage('pq-queued', 'queued prompt')], { id: 'pq-queued', now: 1000 });
    await persistentQueue.enqueue('chat-1', [fakeMessage('pq-running', 'running prompt')], { id: 'pq-running', now: 2000 });
    await persistentQueue.markRunning('pq-running');
    const prompts: string[] = [];
    const messages: Record<string, (msg: NormalizedMessage) => Promise<void>> = {};
    const fakeChannel = createFakeChannel(messages);
    vi.mocked(createLarkChannel).mockReturnValue(fakeChannel);

    await startChannel({
      cfg: textReplyConfig(),
      agent: fakeAgent((opts) => prompts.push(opts.prompt)),
      sessions: fakeSessions(),
      workspaces: fakeWorkspaces('/tmp/project'),
      controls: fakeControls(textReplyConfig()),
      persistentQueue,
    });

    await vi.waitFor(() => expect(prompts).toHaveLength(2));
    expect(prompts[0]).toContain('queued prompt');
    expect(prompts[1]).toContain('running prompt');
    await vi.waitFor(async () => expect(await persistentQueue.recoverable()).toEqual([]));
  });

  test('records accepted messages and deletes the record after completion', async () => {
    const persistentQueue = tempPersistentQueue();
    const prompts: string[] = [];
    const messages: Record<string, (msg: NormalizedMessage) => Promise<void>> = {};
    const fakeChannel = createFakeChannel(messages);
    vi.mocked(createLarkChannel).mockReturnValue(fakeChannel);

    await startChannel({
      cfg: textReplyConfig(),
      agent: fakeAgent((opts) => prompts.push(opts.prompt)),
      sessions: fakeSessions(),
      workspaces: fakeWorkspaces('/tmp/project'),
      controls: fakeControls(textReplyConfig()),
      persistentQueue,
    });

    const onMessage = messages.message;
    if (!onMessage) throw new Error('message handler was not registered');
    await onMessage(fakeMessage('om_original', 'persist me'));

    await vi.waitFor(() => expect(prompts).toHaveLength(1));
    expect(prompts[0]).toContain('persist me');
    await vi.waitFor(async () => expect(await persistentQueue.recoverable()).toEqual([]));
  });

  test('disconnect preserves active running durable records after run cleanup settles', async () => {
    const persistentQueue = tempPersistentQueue();
    const messages: Record<string, (msg: NormalizedMessage) => Promise<void>> = {};
    const send = vi.fn(async () => ({ messageId: 'om_sent' }));
    const fakeChannel = {
      ...createFakeChannel(messages),
      send,
    } as unknown as LarkChannel;
    vi.mocked(createLarkChannel).mockReturnValue(fakeChannel);
    let releaseRun!: () => void;
    const runReleased = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    const stop = vi.fn(async () => {
      releaseRun();
    });
    const bridge = await startChannel({
      cfg: textReplyConfig(),
      agent: {
        ...fakeAgent(() => {}),
        run(): AgentRun {
          return {
            events: (async function* (): AsyncGenerator<AgentEvent> {
              yield { type: 'text', delta: 'working' };
              await runReleased;
            })(),
            stop,
            async waitForExit() {
              return true;
            },
          };
        },
      },
      sessions: fakeSessions(),
      workspaces: fakeWorkspaces('/tmp/project'),
      controls: fakeControls(textReplyConfig()),
      persistentQueue,
    });

    const onMessage = messages.message;
    if (!onMessage) throw new Error('message handler was not registered');
    await onMessage(fakeMessage('durable-disconnect', 'preserve across disconnect'));
    await vi.waitFor(async () => expect((await persistentQueue.recoverable())[0]).toMatchObject({ state: 'running' }));

    await bridge.disconnect();
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith('chat-1', { markdown: '请检查' }));

    expect(stop).toHaveBeenCalled();
    expect(await persistentQueue.recoverable()).toEqual([
      expect.objectContaining({ scope: 'chat-1', state: 'running', messages: [expect.objectContaining({ messageId: 'durable-disconnect' })] }),
    ]);
  });

  test('disconnect preserves active durable record when final stream cleanup fails after lifecycle stop', async () => {
    const persistentQueue = tempPersistentQueue();
    const messages: Record<string, (msg: NormalizedMessage) => Promise<void>> = {};
    let rejectStreamAfterLifecycle!: () => void;
    const streamCanReject = new Promise<void>((resolve) => {
      rejectStreamAfterLifecycle = resolve;
    });
    const send = vi.fn(async () => ({ messageId: 'om_fallback_or_check' }));
    const fakeChannel = {
      ...createFakeChannel(messages),
      async stream() {
        await streamCanReject;
        throw new Error('final stream cleanup failed after lifecycle stop');
      },
      send,
    } as unknown as LarkChannel;
    vi.mocked(createLarkChannel).mockReturnValue(fakeChannel);
    const stop = vi.fn(async () => undefined);
    const bridge = await startChannel({
      cfg: markdownReplyConfig(),
      agent: {
        ...fakeAgent(() => {}),
        run(): AgentRun {
          return {
            events: (async function* (): AsyncGenerator<AgentEvent> {
              yield { type: 'text', delta: 'working' };
              await new Promise(() => {});
            })(),
            stop,
            async waitForExit() {
              return true;
            },
          };
        },
      },
      sessions: fakeSessions(),
      workspaces: fakeWorkspaces('/tmp/project'),
      controls: fakeControls(markdownReplyConfig()),
      persistentQueue,
    });

    const onMessage = messages.message;
    if (!onMessage) throw new Error('message handler was not registered');
    await onMessage(fakeMessage('durable-lifecycle-flush-fails', 'preserve despite failed lifecycle final flush'));
    await vi.waitFor(async () => expect((await persistentQueue.recoverable())[0]).toMatchObject({ state: 'running' }));

    const disconnecting = bridge.disconnect();
    await vi.waitFor(() => expect(stop).toHaveBeenCalled());
    rejectStreamAfterLifecycle();
    await disconnecting;
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith('chat-1', { markdown: '请检查' }));

    expect(await persistentQueue.recoverable()).toEqual([
      expect.objectContaining({
        scope: 'chat-1',
        state: 'running',
        messages: [expect.objectContaining({ messageId: 'durable-lifecycle-flush-fails' })],
      }),
    ]);
  });

  test('/stop removes persistent records for the current scope', async () => {
    const persistentQueue = tempPersistentQueue();
    const messages: Record<string, (msg: NormalizedMessage) => Promise<void>> = {};
    const fakeChannel = createFakeChannel(messages);
    vi.mocked(createLarkChannel).mockReturnValue(fakeChannel);

    await startChannel({
      cfg: textReplyConfig(),
      agent: fakeAgent(() => {}),
      sessions: fakeSessions(),
      workspaces: fakeWorkspaces('/tmp/project'),
      controls: fakeControls(textReplyConfig()),
      persistentQueue,
    });
    await persistentQueue.enqueue('chat-1', [fakeMessage('seeded', 'seeded prompt')], { id: 'seeded', now: 1000 });

    const onMessage = messages.message;
    if (!onMessage) throw new Error('message handler was not registered');
    await onMessage(fakeMessage('stop-msg', '/stop'));

    await vi.waitFor(async () => expect(await persistentQueue.recoverable()).toEqual([]));
  });

  test('durable enqueue failure sends a visible reply and does not enqueue memory work', async () => {
    const messages: Record<string, (msg: NormalizedMessage) => Promise<void>> = {};
    const sends: Array<{ chatId: string; payload: unknown; opts: unknown }> = [];
    const fakeChannel = {
      ...createFakeChannel(messages),
      async send(chatId: string, payload: unknown, opts: unknown) {
        sends.push({ chatId, payload, opts });
        return { messageId: 'enqueue-failed-reply' };
      },
    } as unknown as LarkChannel;
    vi.mocked(createLarkChannel).mockReturnValue(fakeChannel);
    const pendingPush = vi.spyOn(PendingQueue.prototype, 'push');
    const pendingPushBatch = vi.spyOn(PendingQueue.prototype, 'pushBatch');
    const runCalls: AgentRunOptions[] = [];
    const persistentQueue = {
      enqueue: vi.fn(async () => {
        throw new Error('durable enqueue failed');
      }),
      recoverable: vi.fn(async () => []),
      markRunning: vi.fn(),
      complete: vi.fn(),
      fail: vi.fn(),
      cancelScope: vi.fn(async () => 0),
    } as unknown as PersistentQueue;

    await startChannel({
      cfg: textReplyConfig(),
      agent: fakeAgent((opts) => runCalls.push(opts)),
      sessions: fakeSessions(),
      workspaces: fakeWorkspaces('/tmp/project'),
      controls: fakeControls(textReplyConfig()),
      persistentQueue,
    });

    const onMessage = messages.message;
    if (!onMessage) throw new Error('message handler was not registered');
    await onMessage(fakeMessage('msg-durable-fail', 'normal prompt'));

    expect(persistentQueue.enqueue).toHaveBeenCalledWith('chat-1', [expect.objectContaining({ messageId: 'msg-durable-fail' })]);
    expect(pendingPush).not.toHaveBeenCalled();
    expect(pendingPushBatch).not.toHaveBeenCalled();
    expect(runCalls).toEqual([]);
    expect(sends).toEqual([
      {
        chatId: 'chat-1',
        payload: { markdown: expect.stringContaining('队列持久化失败') },
        opts: { replyTo: 'msg-durable-fail' },
      },
    ]);
  });

  test('/new cancels durable and memory queued work for the reset scope', async () => {
    const persistentQueue = tempPersistentQueue();
    const messages: Record<string, (msg: NormalizedMessage) => Promise<void>> = {};
    const fakeChannel = createFakeChannel(messages);
    vi.mocked(createLarkChannel).mockReturnValue(fakeChannel);
    const pendingCancels: string[] = [];
    const originalPushBatch = PendingQueue.prototype.pushBatch;
    vi.spyOn(PendingQueue.prototype, 'pushBatch').mockImplementation(function (
      this: PendingQueue,
      scope,
      batch,
      opts = {},
    ) {
      const size = originalPushBatch.call(this, scope, batch, opts);
      this.block(scope);
      return size;
    });
    const originalCancel = PendingQueue.prototype.cancel;
    vi.spyOn(PendingQueue.prototype, 'cancel').mockImplementation(function (this: PendingQueue, scope) {
      pendingCancels.push(scope);
      return originalCancel.call(this, scope);
    });
    await persistentQueue.enqueue('chat-1', [fakeMessage('seeded', 'seeded prompt')], { id: 'seeded', now: 1000 });

    await startChannel({
      cfg: textReplyConfig(),
      agent: fakeAgent(() => {}),
      sessions: fakeSessions(),
      workspaces: fakeWorkspaces('/tmp/project'),
      controls: fakeControls(textReplyConfig()),
      persistentQueue,
    });

    await vi.waitFor(() => expect(pendingCancels).toHaveLength(0));
    const onMessage = messages.message;
    if (!onMessage) throw new Error('message handler was not registered');
    await onMessage(fakeMessage('new-msg', '/new'));

    expect(pendingCancels).toContain('chat-1');
    expect(await persistentQueue.recoverable()).toEqual([]);
  });

  test('invalid /cd preserves durable and memory queued work', async () => {
    const persistentQueue = tempPersistentQueue();
    const messages: Record<string, (msg: NormalizedMessage) => Promise<void>> = {};
    const fakeChannel = createFakeChannel(messages);
    vi.mocked(createLarkChannel).mockReturnValue(fakeChannel);
    const pendingPushes: Array<{ scope: string; messages: NormalizedMessage[]; durableId?: string }> = [];
    const originalPushBatch = PendingQueue.prototype.pushBatch;
    vi.spyOn(PendingQueue.prototype, 'pushBatch').mockImplementation(function (
      this: PendingQueue,
      scope,
      batch,
      opts = {},
    ) {
      pendingPushes.push({ scope, messages: batch, durableId: opts.durableId });
      const size = originalPushBatch.call(this, scope, batch, opts);
      this.block(scope);
      return size;
    });
    const cancel = vi.spyOn(PendingQueue.prototype, 'cancel');
    await persistentQueue.enqueue('chat-1', [fakeMessage('seeded', 'seeded prompt')], { id: 'seeded', now: 1000 });

    await startChannel({
      cfg: textReplyConfig(),
      agent: fakeAgent(() => {}),
      sessions: fakeSessions(),
      workspaces: fakeWorkspaces('/tmp/project'),
      controls: fakeControls(textReplyConfig()),
      persistentQueue,
    });

    await vi.waitFor(() => expect(pendingPushes).toHaveLength(1));
    const onMessage = messages.message;
    if (!onMessage) throw new Error('message handler was not registered');
    await onMessage(fakeMessage('bad-cd', '/cd /definitely-missing'));

    expect(cancel).not.toHaveBeenCalledWith('chat-1');
    expect(await persistentQueue.recoverable()).toEqual([
      expect.objectContaining({ id: 'seeded', scope: 'chat-1' }),
    ]);
  });
});

describe('processAgentStream', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test('uses the configured post-done grace before stopping a naturally finishing agent', async () => {
    const { handle, waitTimeouts, stopCalls } = runWithNaturalExitAfter(5000);
    const flushed: string[] = [];

    await processAgentStream(
      handle,
      {} as SessionStore,
      'chat-1',
      '/tmp',
      'agent:test',
      undefined,
      async (state) => {
        flushed.push(state.terminal);
      },
      5000,
    );

    expect(waitTimeouts).toEqual([5000]);
    expect(stopCalls()).toBe(0);
    expect(flushed).toContain('done');
  });

  test('persists a replacement session id from a done event', async () => {
    const setCalls: Array<{ scope: string; sessionKey: string; sessionId: string; cwd: string }> = [];
    const run: AgentRun = {
      events: (async function* (): AsyncGenerator<AgentEvent> {
        yield { type: 'done', sessionId: 'agent-new' };
      })(),
      async stop() {},
      async waitForExit() {
        return true;
      },
    };

    await processAgentStream(
      { run, interrupted: false },
      {
        set(scope: string, sessionKey: string, sessionId: string, cwd: string) {
          setCalls.push({ scope, sessionKey, sessionId, cwd });
        },
      } as SessionStore,
      'chat-1',
      '/tmp/project',
      'agent:test',
      undefined,
      async () => {},
      5000,
    );

    expect(setCalls).toEqual([
      { scope: 'chat-1', sessionKey: 'agent:test', sessionId: 'agent-new', cwd: '/tmp/project' },
    ]);
  });

  test('renders an agent stream exception as an error state', async () => {
    const flushed: Array<{ terminal: string; errorMsg?: string }> = [];
    const run: AgentRun = {
      events: (async function* (): AsyncGenerator<AgentEvent> {
        yield { type: 'text', delta: 'working' };
        throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
      })(),
      async stop() {},
      async waitForExit() {
        return true;
      },
    };

    await processAgentStream(
      { run, interrupted: false },
      {} as SessionStore,
      'chat-1',
      '/tmp/project',
      'agent:test',
      undefined,
      async (state) => {
        flushed.push({ terminal: state.terminal, errorMsg: state.errorMsg });
      },
      5000,
    );

    expect(flushed.at(-1)).toEqual({
      terminal: 'error',
      errorMsg: expect.stringContaining('read ECONNRESET'),
    });
  });

  test('does not convert card flush failures into agent stream errors', async () => {
    let flushCalls = 0;
    const run: AgentRun = {
      events: (async function* (): AsyncGenerator<AgentEvent> {
        yield { type: 'text', delta: 'working' };
        yield { type: 'done' };
      })(),
      async stop() {},
      async waitForExit() {
        return true;
      },
    };

    await expect(
      processAgentStream(
        { run, interrupted: false },
        {} as SessionStore,
        'chat-1',
        '/tmp/project',
        'agent:test',
        undefined,
        async () => {
          flushCalls++;
          if (flushCalls === 1) throw new Error('card update failed');
        },
        5000,
      ),
    ).rejects.toThrow('card update failed');

    expect(flushCalls).toBe(1);
  });

  test('idle watchdog also terminates a silent in-flight tool call', async () => {
    vi.useFakeTimers();
    let releaseStream!: () => void;
    const streamReleased = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    const stop = vi.fn(async () => {
      releaseStream();
    });
    const flushed: string[] = [];
    const run: AgentRun = {
      events: (async function* (): AsyncGenerator<AgentEvent> {
        yield { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'npm publish' } };
        await streamReleased;
      })(),
      stop,
      async waitForExit() {
        return true;
      },
    };
    const handle: RunHandle = { run, interrupted: false };

    const processing = processAgentStream(
      handle,
      {} as SessionStore,
      'chat-1',
      '/tmp/project',
      'agent:test',
      1000,
      async (state) => {
        flushed.push(state.terminal);
      },
      5000,
    );

    await vi.advanceTimersByTimeAsync(1000);
    releaseStream();
    await processing;

    expect(stop).toHaveBeenCalledTimes(1);
    expect(handle.interrupted).toBe(true);
    expect(flushed.at(-1)).toBe('idle_timeout');
  });

  test('refreshes running progress while the agent is silent', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let releaseStream!: () => void;
    const streamReleased = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    const flushed: Array<{ terminal: string; lastActivityAt: number; updatedAt: number }> = [];
    const run: AgentRun = {
      events: (async function* (): AsyncGenerator<AgentEvent> {
        yield { type: 'system', sessionId: 'agent-1' };
        await streamReleased;
      })(),
      async stop() {},
      async waitForExit() {
        return true;
      },
    };

    const processing = processAgentStream(
      { run, interrupted: false },
      { set() {} } as unknown as SessionStore,
      'chat-1',
      '/tmp/project',
      'agent:test',
      undefined,
      async (state) => {
        flushed.push({
          terminal: state.terminal,
          lastActivityAt: state.lastActivityAt,
          updatedAt: state.updatedAt,
        });
      },
      5000,
      createInitialState('run-1'),
    );

    await vi.advanceTimersByTimeAsync(15_000);
    releaseStream();
    await processing;

    expect(flushed).toContainEqual({
      terminal: 'running',
      lastActivityAt: 0,
      updatedAt: 15_000,
    });
  });

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
        await vi.advanceTimersByTimeAsync(599_999);
        yield { type: 'text', delta: ' second' };
        await vi.advanceTimersByTimeAsync(1);
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
        statesSeen.push(
          state.terminal === 'running'
            ? state.blocks.map((block) => (block.kind === 'text' ? block.content : '')).join('')
            : state.terminal,
        );
        await cutoff.flush(renderText(state), { final: state.terminal !== 'running' });
      },
      5000,
      createInitialState('run-1'),
    );

    await streamReleased;
    await processing;
    cutoff.dispose();

    const cutoffUpdate = markdownUpdates.find((markdown) => markdown.includes('已运行超过 10 分钟'));
    expect(markdownUpdates[0]).toContain('first');
    expect(cutoffUpdate).toContain('first second');
    expect(cutoffUpdate).toContain('飞书卡片将停止自动刷新');
    expect(markdownUpdates.at(-1)).toContain('_✅ 已完成_');
    expect(markdownUpdates.at(-1)).toContain('first second');
    expect(markdownUpdates.at(-1)).not.toContain('飞书卡片将停止自动刷新');
    expect(statesSeen).toContain('first second');
  });

  test('does not let a hanging cutoff notice block final markdown', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const writes: string[] = [];
    let cutoffNoticeStarted = false;
    const cutoff = createMarkdownRefreshCutoff(async (markdown) => {
      if (markdown.includes('飞书卡片将停止自动刷新')) {
        cutoffNoticeStarted = true;
        await new Promise(() => {});
      } else {
        writes.push(markdown);
      }
    });

    await cutoff.flush('running');
    await vi.advanceTimersByTimeAsync(600_000);
    let finalSettled = false;
    const finalFlush = cutoff.flush('final', { final: true }).then(() => {
      finalSettled = true;
    });
    await vi.advanceTimersByTimeAsync(1);

    expect(cutoffNoticeStarted).toBe(true);
    expect(finalSettled).toBe(true);
    expect(writes).toEqual(['running', 'final']);
    await finalFlush;
    cutoff.dispose();
  });

  test('does not start a cutoff notice setContent after finalizing begins', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const writes: string[] = [];
    const cutoff = createMarkdownRefreshCutoff(async (markdown) => {
      writes.push(markdown);
    });

    await cutoff.flush('running');
    vi.advanceTimersByTime(600_000);
    await cutoff.flush('final', { final: true });
    await vi.runOnlyPendingTimersAsync();
    cutoff.dispose();

    expect(writes).toEqual(['running', 'final']);
  });

  test('markdown cutoff periodically refreshes latest content after the 10 minute cutoff', async () => {
    vi.useFakeTimers();
    try {
      let now = 0;
      const setContentCalls: string[] = [];
      const updateCalls: string[] = [];
      const cutoff = createMarkdownRefreshCutoff(
        async (markdown) => {
          setContentCalls.push(markdown);
        },
        () => now,
        {
          periodicMs: 30_000,
          updateLatest: async (markdown) => {
            updateCalls.push(markdown);
          },
        },
      );

      await cutoff.flush('initial');
      now = 10 * 60_000;
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      await cutoff.flush('after cutoff 1');

      expect(setContentCalls.at(-1)).toContain('已运行超过 10 分钟');
      expect(updateCalls).toEqual([]);

      await cutoff.flush('after cutoff 2');
      await vi.advanceTimersByTimeAsync(30_000);
      expect(updateCalls).toEqual(['after cutoff 2']);

      await cutoff.flush('after cutoff 3');
      await vi.advanceTimersByTimeAsync(30_000);
      expect(updateCalls).toEqual(['after cutoff 2', 'after cutoff 3']);

      await cutoff.flush('final', { final: true });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(updateCalls).toEqual(['after cutoff 2', 'after cutoff 3']);
    } finally {
      vi.useRealTimers();
    }
  });

  test('markdown cutoff periodic refresh failures do not reject later flushes', async () => {
    vi.useFakeTimers();
    try {
      let now = 0;
      let attempts = 0;
      const setContentCalls: string[] = [];
      const cutoff = createMarkdownRefreshCutoff(
        async (markdown) => {
          setContentCalls.push(markdown);
        },
        () => now,
        {
          periodicMs: 30_000,
          updateLatest: async () => {
            attempts += 1;
            if (attempts === 1) throw new Error('update failed');
          },
        },
      );

      now = 10 * 60_000;
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      await cutoff.flush('after cutoff 1');
      await vi.advanceTimersByTimeAsync(30_000);
      await cutoff.flush('after cutoff 2');
      await vi.advanceTimersByTimeAsync(30_000);
      await cutoff.flush('final', { final: true });

      expect(attempts).toBe(2);
      expect(setContentCalls.at(-1)).toBe('final');
    } finally {
      vi.useRealTimers();
    }
  });

  test('fails fast when the final flush hangs', async () => {
    vi.useFakeTimers();
    const run: AgentRun = {
      events: (async function* (): AsyncGenerator<AgentEvent> {
        return;
      })(),
      async stop() {},
      async waitForExit() {
        return true;
      },
    };

    const processing = processAgentStream(
      { run, interrupted: false },
      {} as SessionStore,
      'chat-1',
      '/tmp/project',
      'agent:test',
      undefined,
      async (state) => {
        if (state.terminal === 'done') await new Promise(() => {});
      },
      5000,
    );

    const rejection = expect(processing).rejects.toThrow('final-flush timed out');
    await vi.advanceTimersByTimeAsync(20_000);
    await rejection;
  });
});

describe('interruptScopeNow', () => {
  test('interrupts the active run and drops queued and persistent messages immediately', async () => {
    let stopCount = 0;
    let flushCount = 0;
    const activeRuns = new ActiveRuns();
    const pending = new PendingQueue(0, () => {
      flushCount++;
    });
    const persistentQueue = tempPersistentQueue();
    await persistentQueue.enqueue('chat-1', [fakeMessage('durable-1')], { id: 'durable-1', now: 1000 });
    await persistentQueue.enqueue('chat-1', [fakeMessage('durable-2')], { id: 'durable-2', now: 2000 });
    const run: AgentRun = {
      events: (async function* (): AsyncGenerator<AgentEvent> {})(),
      async stop() {
        stopCount++;
      },
      async waitForExit() {
        return true;
      },
    };

    activeRuns.register('chat-1', run);
    pending.block('chat-1');
    pending.push('chat-1', fakeMessage('queued-1'));
    pending.push('chat-1', fakeMessage('queued-2'));

    await expect(interruptScopeNow(activeRuns, pending, persistentQueue, 'chat-1')).resolves.toEqual({
      interrupted: true,
      droppedPending: 2,
      droppedPersistent: 2,
    });
    pending.unblock('chat-1');

    expect(stopCount).toBe(1);
    expect(flushCount).toBe(0);
    expect(await persistentQueue.recoverable()).toEqual([]);
  });

  test('keeps pending messages when durable cancellation fails', async () => {
    const activeRuns = new ActiveRuns();
    const pending = new PendingQueue(1000, () => {
      throw new Error('should not flush while blocked');
    });
    pending.block('chat-1');
    pending.push('chat-1', fakeMessage('queued-1'));
    const persistentQueue = {
      async cancelScope() {
        throw new Error('disk cancel failed');
      },
    } as unknown as PersistentQueue;

    await expect(interruptScopeNow(activeRuns, pending, persistentQueue, 'chat-1')).rejects.toThrow('disk cancel failed');

    expect(pending.queuedSize('chat-1')).toBe(1);
  });
});

describe('persistent queue restore ordering', () => {
  test('connects before restore and gates live messages until older durable records can run', async () => {
    const handlers: Record<string, (msg: NormalizedMessage) => Promise<void>> = {};
    const prompts: string[] = [];
    const order: string[] = [];
    const persistentQueue = tempPersistentQueue();
    await persistentQueue.enqueue('chat-1', [fakeMessage('old-1', 'old prompt')], { id: 'old-1', now: 1000 });
    const fakeChannel = {
      ...createFakeChannel(handlers),
      async connect() {
        order.push('connect');
        order.push('live-handler-started');
        void handlers.message?.(fakeMessage('live-1', 'live prompt')).then(() => {
          order.push('live-handler-done');
        });
        expect(prompts).toEqual([]);
        expect(order).not.toContain('live-handler-done');
      },
    } as unknown as LarkChannel;
    const recoverable = vi.spyOn(persistentQueue, 'recoverable').mockImplementation(async () => {
      order.push('restore');
      return PersistentQueue.prototype.recoverable.call(persistentQueue);
    });
    vi.mocked(createLarkChannel).mockReturnValue(fakeChannel);

    await startChannel({
      cfg: textReplyConfig(),
      agent: fakeAgent((opts) => {
        prompts.push(opts.prompt);
        order.push(`prompt:${opts.prompt.includes('old prompt') ? 'old' : 'live'}`);
      }),
      sessions: fakeSessions(),
      workspaces: fakeWorkspaces('/tmp/project'),
      controls: fakeControls(textReplyConfig()),
      persistentQueue,
    });

    await vi.waitFor(() => expect(prompts).toHaveLength(2));
    expect(recoverable).toHaveBeenCalled();
    expect(order).toEqual([
      'connect',
      'live-handler-started',
      'restore',
      'prompt:old',
      'live-handler-done',
      'prompt:live',
    ]);
    expect(prompts[0]).toContain('old prompt');
    expect(prompts[1]).toContain('live prompt');
  });
});

describe('flush durable setup failures', () => {
  test('delays retry when markRunning fails before agent start instead of spinning synchronously', async () => {
    vi.useFakeTimers();
    const messages: Record<string, (msg: NormalizedMessage) => Promise<void>> = {};
    const prompts: string[] = [];
    const persistentQueue = tempPersistentQueue();
    const markRunning = vi.spyOn(persistentQueue, 'markRunning');
    markRunning.mockRejectedValueOnce(new Error('mark running failed'));
    const fakeChannel = createFakeChannel(messages);
    vi.mocked(createLarkChannel).mockReturnValue(fakeChannel);

    await startChannel({
      cfg: textReplyConfig(),
      agent: fakeAgent((opts) => prompts.push(opts.prompt)),
      sessions: fakeSessions(),
      workspaces: fakeWorkspaces('/tmp/project'),
      controls: fakeControls(textReplyConfig()),
      persistentQueue,
    });

    const onMessage = messages.message;
    if (!onMessage) throw new Error('message handler was not registered');
    await onMessage(fakeMessage('setup-fails-once', 'retry after setup failure'));
    await Promise.resolve();
    await Promise.resolve();

    expect(prompts).toEqual([]);
    expect(markRunning).toHaveBeenCalledTimes(1);
    expect(await persistentQueue.has((markRunning.mock.calls[0] ?? [''])[0] as string)).toBe(true);

    await vi.advanceTimersByTimeAsync(999);
    expect(markRunning).toHaveBeenCalledTimes(1);

    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(markRunning).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(prompts).toHaveLength(1));
    expect(prompts[0]).toContain('retry after setup failure');
    await vi.waitFor(async () => expect(await persistentQueue.recoverable()).toEqual([]));
  });

  test('treats missing durable record during markRunning as cancellation without requeue loop', async () => {
    const messages: Record<string, (msg: NormalizedMessage) => Promise<void>> = {};
    const prompts: string[] = [];
    const persistentQueue = tempPersistentQueue();
    vi.spyOn(persistentQueue, 'markRunning').mockResolvedValue(undefined);
    const fakeChannel = createFakeChannel(messages);
    vi.mocked(createLarkChannel).mockReturnValue(fakeChannel);

    await startChannel({
      cfg: textReplyConfig(),
      agent: fakeAgent((opts) => prompts.push(opts.prompt)),
      sessions: fakeSessions(),
      workspaces: fakeWorkspaces('/tmp/project'),
      controls: fakeControls(textReplyConfig()),
      persistentQueue,
    });

    const onMessage = messages.message;
    if (!onMessage) throw new Error('message handler was not registered');
    await onMessage(fakeMessage('cancelled-durable', 'cancelled prompt'));

    await vi.waitFor(() => expect(prompts).toEqual([]));
    expect(prompts).toEqual([]);
    expect(persistentQueue.markRunning).toHaveBeenCalledTimes(1);
    expect(await persistentQueue.recoverable()).toEqual([
      expect.objectContaining({ scope: 'chat-1', messages: [expect.objectContaining({ messageId: 'cancelled-durable' })] }),
    ]);
  });

  test('does not call agent.run when /stop lands after the final durable existence check', async () => {
    const messages: Record<string, (msg: NormalizedMessage) => Promise<void>> = {};
    const persistentQueue = tempPersistentQueue();
    vi.spyOn(persistentQueue, 'enqueue').mockImplementation(async (scope, batch) =>
      PersistentQueue.prototype.enqueue.call(persistentQueue, scope, batch, { id: 'race-durable', now: 1000 }),
    );
    let stopSent = false;
    const has = vi.spyOn(persistentQueue, 'has').mockImplementation(async (id: string) => {
      const exists = await PersistentQueue.prototype.has.call(persistentQueue, id);
      if (id === 'race-durable' && exists && !stopSent) {
        stopSent = true;
        await messages.message?.(fakeMessage('stop-race', '/stop'));
      }
      return exists;
    });
    const runSpy = vi.fn();
    const fakeChannel = createFakeChannel(messages);
    vi.mocked(createLarkChannel).mockReturnValue(fakeChannel);

    await startChannel({
      cfg: textReplyConfig(),
      agent: fakeAgent(runSpy),
      sessions: fakeSessions(),
      workspaces: fakeWorkspaces('/tmp/project'),
      controls: fakeControls(textReplyConfig()),
      persistentQueue,
    });

    const onMessage = messages.message;
    if (!onMessage) throw new Error('message handler was not registered');
    await onMessage(fakeMessage('race-durable', 'cancel between has and run'));

    await vi.waitFor(() => expect(has).toHaveBeenCalledWith('race-durable'));
    await vi.waitFor(() => expect(runSpy).not.toHaveBeenCalled());
    expect(stopSent).toBe(true);
    expect(runSpy).not.toHaveBeenCalled();
    expect(await persistentQueue.recoverable()).toEqual([]);
  });

  test('does not start agent when durable setup is cancelled before run', async () => {
    const messages: Record<string, (msg: NormalizedMessage) => Promise<void>> = {};
    let releasePrepare!: () => void;
    const prepareStarted = new Promise<void>((resolve) => {
      releasePrepare = resolve;
    });
    const persistentQueue = tempPersistentQueue();
    const runSpy = vi.fn();
    const agent = {
      ...fakeAgent(runSpy),
      async prepareSession() {
        await prepareStarted;
        return 'prepared-session';
      },
    } satisfies AgentAdapter;
    const fakeChannel = createFakeChannel(messages);
    vi.mocked(createLarkChannel).mockReturnValue(fakeChannel);

    await startChannel({
      cfg: textReplyConfig(),
      agent,
      sessions: fakeSessions(),
      workspaces: fakeWorkspaces('/tmp/project'),
      controls: fakeControls(textReplyConfig()),
      persistentQueue,
    });

    const onMessage = messages.message;
    if (!onMessage) throw new Error('message handler was not registered');
    await onMessage(fakeMessage('cancel-during-setup', 'cancel before run'));
    await vi.waitFor(() => expect(persistentQueue.markRunning('cancel-during-setup')).resolves.toBeUndefined());
    await persistentQueue.cancelScope('chat-1');
    releasePrepare();

    await vi.waitFor(() => expect(runSpy).not.toHaveBeenCalled());
    expect(runSpy).not.toHaveBeenCalled();
    expect(await persistentQueue.recoverable()).toEqual([]);
  });

  test('keeps older setup-failure retry ahead of newer messages for the same scope', async () => {
    vi.useFakeTimers();
    const messages: Record<string, (msg: NormalizedMessage) => Promise<void>> = {};
    const prompts: string[] = [];
    const persistentQueue = tempPersistentQueue();
    vi.spyOn(persistentQueue, 'markRunning').mockRejectedValueOnce(new Error('mark running failed'));
    const fakeChannel = createFakeChannel(messages);
    vi.mocked(createLarkChannel).mockReturnValue(fakeChannel);

    await startChannel({
      cfg: textReplyConfig(),
      agent: fakeAgent((opts) => prompts.push(opts.prompt)),
      sessions: fakeSessions(),
      workspaces: fakeWorkspaces('/tmp/project'),
      controls: fakeControls(textReplyConfig()),
      persistentQueue,
    });

    const onMessage = messages.message;
    if (!onMessage) throw new Error('message handler was not registered');
    await onMessage(fakeMessage('older-setup-fails', 'older prompt'));
    await Promise.resolve();
    await onMessage(fakeMessage('newer-during-backoff', 'newer prompt'));

    expect(prompts).toEqual([]);
    await vi.advanceTimersByTimeAsync(1001);
    await Promise.resolve();
    await Promise.resolve();

    await vi.waitFor(() => expect(prompts).toHaveLength(2));
    expect(prompts[0]).toContain('older prompt');
    expect(prompts[1]).toContain('newer prompt');
    vi.useRealTimers();
  });

  test('requeues durable batch after synchronous agent.run failure before active registration', async () => {
    const messages: Record<string, (msg: NormalizedMessage) => Promise<void>> = {};
    const prompts: string[] = [];
    let attempts = 0;
    const agent = fakeAgent((opts) => prompts.push(opts.prompt));
    const throwingThenSuccessfulAgent: AgentAdapter = {
      ...agent,
      run(opts: AgentRunOptions): AgentRun {
        attempts++;
        if (attempts === 1) throw new Error('agent run sync failed');
        return agent.run(opts);
      },
    };
    const persistentQueue = tempPersistentQueue();
    const fakeChannel = createFakeChannel(messages);
    vi.mocked(createLarkChannel).mockReturnValue(fakeChannel);

    await startChannel({
      cfg: textReplyConfig(),
      agent: throwingThenSuccessfulAgent,
      sessions: fakeSessions(),
      workspaces: fakeWorkspaces('/tmp/project'),
      controls: fakeControls(textReplyConfig()),
      persistentQueue,
    });

    const onMessage = messages.message;
    if (!onMessage) throw new Error('message handler was not registered');
    await onMessage(fakeMessage('sync-throw', 'recover after sync throw'));

    await vi.waitFor(() => expect(prompts).toHaveLength(1), { timeout: 1500 });
    expect(attempts).toBe(2);
    expect(prompts[0]).toContain('recover after sync throw');
    await vi.waitFor(async () => expect(await persistentQueue.recoverable()).toEqual([]));
  });
});

describe('opaque Cursor SDK auto retry', () => {
  test('recognizes only uninterrupted opaque SDK status errors with no queued user messages', () => {
    const state = {
      ...createInitialState('run-1'),
      terminal: 'error' as const,
      errorMsg:
        'agent 失败:sdk run failed (runId=run-1, status=error); Cursor returned no error detail | result={"status":"error"}',
    };

    expect(shouldAutoRetryOpaqueSdkError(state, false, 0)).toBe(true);
    expect(shouldAutoRetryOpaqueSdkError(state, true, 0)).toBe(false);
    expect(shouldAutoRetryOpaqueSdkError(state, false, 1)).toBe(false);
    expect(shouldAutoRetryOpaqueSdkError({ ...state, errorMsg: 'Cursor API 鉴权失败' }, false, 0)).toBe(false);
  });

  test('queues the original batch once for opaque SDK status errors', async () => {
    const flushed: NormalizedMessage[][] = [];
    const pending = new PendingQueue(1000, (_scope, batch) => {
      flushed.push(batch);
    });
    const persistentQueue = tempPersistentQueue();
    const batch = [fakeMessage('msg-1'), fakeMessage('msg-2')];
    const state = {
      ...createInitialState('run-1'),
      terminal: 'error' as const,
      errorMsg:
        'sdk run failed (runId=run-87dd74df-deb6-45ca-8862-85847622ee9a, status=error); Cursor returned no error detail',
    };
    const autoRetryKeys = new Set<string>();

    await expect(
      maybeEnqueueAutoRetryForOpaqueSdkError({
        scope: 'chat-1',
        batch,
        finalState: state,
        handleInterrupted: false,
        pending,
        autoRetryKeys,
        persistentQueue,
      }),
    ).resolves.toBe(true);
    expect(pending.queuedSize('chat-1')).toBe(2);
    const records = await persistentQueue.recoverable();
    expect(records).toHaveLength(1);
    expect(records[0]?.messages.map((msg) => msg.messageId)).toEqual(['msg-1', 'msg-2']);
    pending.cancel('chat-1');
    await persistentQueue.cancelScope('chat-1');

    await expect(
      maybeEnqueueAutoRetryForOpaqueSdkError({
        scope: 'chat-1',
        batch,
        finalState: state,
        handleInterrupted: false,
        pending,
        autoRetryKeys,
        persistentQueue,
      }),
    ).resolves.toBe(false);
    expect(pending.queuedSize('chat-1')).toBe(0);
    expect(await persistentQueue.recoverable()).toEqual([]);
    expect(flushed).toEqual([]);
  });

  test('skips auto retry when durable enqueue fails instead of falling back to memory-only', async () => {
    const flushed: NormalizedMessage[][] = [];
    const pending = new PendingQueue(1000, (_scope, batch) => {
      flushed.push(batch);
    });
    const batch = [fakeMessage('msg-1', 'trigger opaque error')];
    const state = {
      ...createInitialState('run-1'),
      terminal: 'error' as const,
      errorMsg:
        'sdk run failed (runId=run-87dd74df-deb6-45ca-8862-85847622ee9a, status=error); Cursor returned no error detail',
    };
    const persistentQueue = {
      enqueue: vi.fn(async () => {
        throw new Error('durable auto retry enqueue failed');
      }),
    } as unknown as PersistentQueue;

    await expect(
      maybeEnqueueAutoRetryForOpaqueSdkError({
        scope: 'chat-1',
        batch,
        finalState: state,
        handleInterrupted: false,
        pending,
        persistentQueue,
        autoRetryKeys: new Set<string>(),
      }),
    ).resolves.toBe(false);

    expect(persistentQueue.enqueue).toHaveBeenCalledWith('chat-1', [expect.objectContaining({ messageId: 'msg-1' })]);
    expect(pending.queuedSize('chat-1')).toBe(0);
    expect(flushed).toEqual([]);
  });

  test('benign handled commands keep durable and memory pending work queued', async () => {
    const messages: Record<string, (msg: NormalizedMessage) => Promise<void>> = {};
    const persistentQueue = tempPersistentQueue();
    await persistentQueue.enqueue('chat-1', [fakeMessage('msg-durable', 'queued durable work')], {
      id: 'durable-keep',
      now: 1000,
    });
    const pendingPushes: Array<{ scope: string; messages: NormalizedMessage[]; durableId?: string }> = [];
    const originalPushBatch = PendingQueue.prototype.pushBatch;
    const pushBatch = vi.spyOn(PendingQueue.prototype, 'pushBatch').mockImplementation(function (
      this: PendingQueue,
      scope,
      batch,
      opts = {},
    ) {
      pendingPushes.push({ scope, messages: batch, durableId: opts.durableId });
      return originalPushBatch.call(this, scope, batch, opts);
    });
    const cancel = vi.spyOn(PendingQueue.prototype, 'cancel');
    const fakeChannel = createFakeChannel(messages);
    vi.mocked(createLarkChannel).mockReturnValue(fakeChannel);

    await startChannel({
      cfg: textReplyConfig(),
      agent: fakeAgent(() => {}),
      sessions: fakeSessions(),
      workspaces: fakeWorkspaces('/tmp/project'),
      controls: fakeControls(textReplyConfig()),
      persistentQueue,
    });

    await vi.waitFor(() => expect(pendingPushes).toHaveLength(1));
    const onMessage = messages.message;
    if (!onMessage) throw new Error('message handler was not registered');
    await onMessage(fakeMessage('msg-status', '/status'));

    expect(pushBatch).toHaveBeenCalledWith('chat-1', [expect.objectContaining({ messageId: 'msg-durable' })], {
      durableId: 'durable-keep',
    });
    expect(cancel).not.toHaveBeenCalledWith('chat-1');
    expect(await persistentQueue.recoverable()).toEqual([
      expect.objectContaining({ id: 'durable-keep', scope: 'chat-1' }),
    ]);
  });

  test('run cleanup skips auto retry enqueue when original durable completion fails', async () => {
    const messages: Record<string, (msg: NormalizedMessage) => Promise<void>> = {};
    let unregistered = false;
    const activeRuns = new ActiveRuns();
    const originalUnregister = activeRuns.unregister.bind(activeRuns);
    vi.spyOn(activeRuns, 'unregister').mockImplementation((scope, run) => {
      unregistered = true;
      return originalUnregister(scope, run);
    });
    const persistentQueue = tempPersistentQueue();
    const original = await persistentQueue.enqueue('chat-1', [fakeMessage('msg-1', 'trigger opaque error')], {
      id: 'original-1',
      now: 1000,
    });
    const complete = vi.spyOn(persistentQueue, 'complete').mockRejectedValueOnce(new Error('complete failed'));
    const enqueue = vi.spyOn(persistentQueue, 'enqueue');
    const fakeChannel = createFakeChannel(messages);
    vi.mocked(createLarkChannel).mockReturnValue(fakeChannel);

    await startChannel({
      cfg: textReplyConfig(),
      agent: fakeAgentWithEvents(async function* (): AsyncGenerator<AgentEvent> {
        yield {
          type: 'error',
          message: 'sdk run failed (runId=run-1, status=error); Cursor returned no error detail',
        };
      }),
      sessions: fakeSessions(),
      workspaces: fakeWorkspaces('/tmp/project'),
      controls: fakeControls(textReplyConfig()),
      persistentQueue,
      activeRuns,
    });

    await vi.waitFor(() => expect(complete).toHaveBeenCalledWith(original.id));
    expect(enqueue).not.toHaveBeenCalled();
    expect(await persistentQueue.recoverable()).toEqual([
      expect.objectContaining({ id: original.id, scope: 'chat-1' }),
    ]);
    expect(unregistered).toBe(true);
  });

  test('setup failure requeues durable work after backoff without stranding', async () => {
    vi.useFakeTimers();
    try {
      const runPrompts: string[] = [];
      const persistentQueue = tempPersistentQueue();
      await persistentQueue.enqueue('chat-1', [fakeMessage('old-1', 'older prompt')], {
        id: 'durable-old',
        now: 1000,
      });
      const markRunning = vi.spyOn(persistentQueue, 'markRunning');
      markRunning.mockRejectedValueOnce(new Error('setup mark failed'));
      const messages: Record<string, (msg: NormalizedMessage) => Promise<void>> = {};
      const fakeChannel = createFakeChannel(messages);
      vi.mocked(createLarkChannel).mockReturnValue(fakeChannel);

      await startChannel({
        cfg: textReplyConfig(),
        agent: fakeAgent((opts) => runPrompts.push(opts.prompt)),
        sessions: fakeSessions(),
        workspaces: fakeWorkspaces('/tmp/project'),
        controls: fakeControls(textReplyConfig()),
        persistentQueue,
      });

      await vi.waitFor(() => expect(markRunning).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(998);
      expect(runPrompts).toEqual([]);

      await vi.advanceTimersByTimeAsync(2);

      await vi.waitFor(() => expect(runPrompts).toHaveLength(1));
      expect(runPrompts[0]).toContain('older prompt');
    } finally {
      vi.useRealTimers();
    }
  });

  test('setup failure keeps older durable retry ahead of newer work', async () => {
    vi.useFakeTimers();
    try {
      const runPrompts: string[] = [];
      const persistentQueue = tempPersistentQueue();
      await persistentQueue.enqueue('chat-1', [fakeMessage('old-1', 'older prompt')], {
        id: 'durable-old',
        now: 1000,
      });
      const markRunning = vi.spyOn(persistentQueue, 'markRunning');
      markRunning.mockRejectedValueOnce(new Error('setup mark failed'));
      const messages: Record<string, (msg: NormalizedMessage) => Promise<void>> = {};
      const fakeChannel = createFakeChannel(messages);
      vi.mocked(createLarkChannel).mockReturnValue(fakeChannel);

      await startChannel({
        cfg: textReplyConfig(),
        agent: fakeAgent((opts) => runPrompts.push(opts.prompt)),
        sessions: fakeSessions(),
        workspaces: fakeWorkspaces('/tmp/project'),
        controls: fakeControls(textReplyConfig()),
        persistentQueue,
      });
      await vi.waitFor(() => expect(markRunning).toHaveBeenCalledTimes(1));

      const onMessage = messages.message;
      if (!onMessage) throw new Error('message handler was not registered');
      await onMessage(fakeMessage('new-1', 'newer prompt'));

      await vi.advanceTimersByTimeAsync(1001);
      await Promise.resolve();
      await Promise.resolve();

      await vi.waitFor(() => expect(runPrompts).toHaveLength(2));
      expect(runPrompts[0]).toContain('older prompt');
      expect(runPrompts[1]).toContain('newer prompt');
    } finally {
      vi.useRealTimers();
    }
  });

  test('missing durable before run unblocks scope for later work', async () => {
    const runPrompts: string[] = [];
    const persistentQueue = tempPersistentQueue();
    await persistentQueue.enqueue('chat-1', [fakeMessage('old-1', 'missing durable')], {
      id: 'durable-missing',
      now: 1000,
    });
    const markRunning = vi.spyOn(persistentQueue, 'markRunning');
    markRunning.mockResolvedValueOnce(undefined);
    const messages: Record<string, (msg: NormalizedMessage) => Promise<void>> = {};
    const fakeChannel = createFakeChannel(messages);
    vi.mocked(createLarkChannel).mockReturnValue(fakeChannel);

    await startChannel({
      cfg: textReplyConfig(),
      agent: fakeAgent((opts) => runPrompts.push(opts.prompt)),
      sessions: fakeSessions(),
      workspaces: fakeWorkspaces('/tmp/project'),
      controls: fakeControls(textReplyConfig()),
      persistentQueue,
    });
    await vi.waitFor(() => expect(markRunning).toHaveBeenCalledWith('durable-missing'));

    const onMessage = messages.message;
    if (!onMessage) throw new Error('message handler was not registered');
    await onMessage(fakeMessage('new-1', 'new prompt after missing durable'));

    await vi.waitFor(() => expect(runPrompts).toHaveLength(1));
    expect(runPrompts[0]).toContain('new prompt after missing durable');
  });

  test('lifecycle disconnect during setup prevents agent run and preserves durable record', async () => {
    let resumeChatMode!: () => void;
    const chatModePaused = new Promise<void>((resolve) => {
      resumeChatMode = resolve;
    });
    let chatModeStarted!: () => void;
    const chatModeStartedPromise = new Promise<void>((resolve) => {
      chatModeStarted = resolve;
    });
    const runCalls: AgentRunOptions[] = [];
    const persistentQueue = tempPersistentQueue();
    await persistentQueue.enqueue('chat-1', [fakeMessage('durable-setup', 'setup prompt')], {
      id: 'durable-setup',
      now: 1000,
    });
    const messages: Record<string, (msg: NormalizedMessage) => Promise<void>> = {};
    const fakeChannel = {
      ...createFakeChannel(messages),
      async getChatMode() {
        chatModeStarted();
        await chatModePaused;
        return 'group';
      },
    } as unknown as LarkChannel;
    vi.mocked(createLarkChannel).mockReturnValue(fakeChannel);

    const bridge = await startChannel({
      cfg: textReplyConfig(),
      agent: fakeAgent((opts) => runCalls.push(opts)),
      sessions: fakeSessions(),
      workspaces: fakeWorkspaces('/tmp/project'),
      controls: fakeControls(textReplyConfig()),
      persistentQueue,
    });
    await chatModeStartedPromise;

    const disconnectPromise = bridge.disconnect();
    resumeChatMode();
    await disconnectPromise;

    expect(runCalls).toEqual([]);
    expect(await persistentQueue.recoverable()).toEqual([
      expect.objectContaining({ id: 'durable-setup', scope: 'chat-1', state: 'running' }),
    ]);
  });

  test('lifecycle disconnect during media setup prevents agent run and preserves durable record', async () => {
    const activeRuns = new ActiveRuns();
    const interrupt = vi.spyOn(activeRuns, 'interrupt');
    let resumeMedia!: () => void;
    const mediaPaused = new Promise<void>((resolve) => {
      resumeMedia = resolve;
    });
    let mediaStarted!: () => void;
    const mediaStartedPromise = new Promise<void>((resolve) => {
      mediaStarted = resolve;
    });
    const runCalls: AgentRunOptions[] = [];
    const persistentQueue = tempPersistentQueue();
    await persistentQueue.enqueue(
      'chat-1',
      [
        fakeMessage('durable-media-setup', 'setup prompt', {
          resources: [{ type: 'image', fileKey: 'lifecycle-media-setup-image' }],
        }),
      ],
      { id: 'durable-media-setup', now: 1000 },
    );
    const messages: Record<string, (msg: NormalizedMessage) => Promise<void>> = {};
    const fakeChannel = {
      ...createFakeChannel(messages),
      rawClient: {
        ...createFakeChannel(messages).rawClient,
        im: {
          v1: {
            ...createFakeChannel(messages).rawClient.im.v1,
            messageResource: {
              async get() {
                mediaStarted();
                await mediaPaused;
                return {
                  async writeFile() {},
                };
              },
            },
          },
        },
      },
    } as unknown as LarkChannel;
    vi.mocked(createLarkChannel).mockReturnValue(fakeChannel);

    const bridge = await startChannel({
      cfg: textReplyConfig(),
      agent: fakeAgent((opts) => runCalls.push(opts)),
      sessions: fakeSessions(),
      workspaces: fakeWorkspaces('/tmp/project'),
      controls: fakeControls(textReplyConfig()),
      persistentQueue,
      activeRuns,
    });
    await mediaStartedPromise;

    const disconnectPromise = bridge.disconnect();
    resumeMedia();
    await disconnectPromise;
    await delay(0);

    interrupt.mockRestore();
    expect(activeRuns.interrupt('chat-1')).toBe(false);
    expect(runCalls).toEqual([]);
    expect(await persistentQueue.recoverable()).toEqual([
      expect.objectContaining({ id: 'durable-media-setup', scope: 'chat-1', state: 'running' }),
    ]);
  });

  test('lifecycle disconnect after terminal done completes durable record', async () => {
    let terminalReached!: () => void;
    const terminalReachedPromise = new Promise<void>((resolve) => {
      terminalReached = resolve;
    });
    let releaseExit!: () => void;
    const exitReleased = new Promise<void>((resolve) => {
      releaseExit = resolve;
    });
    const persistentQueue = tempPersistentQueue();
    await persistentQueue.enqueue('chat-1', [fakeMessage('durable-terminal-done', 'terminal prompt')], {
      id: 'durable-terminal-done',
      now: 1000,
    });
    const complete = vi.spyOn(persistentQueue, 'complete');
    const stop = vi.fn(async () => {});
    const messages: Record<string, (msg: NormalizedMessage) => Promise<void>> = {};
    const fakeChannel = createFakeChannel(messages);
    vi.mocked(createLarkChannel).mockReturnValue(fakeChannel);

    const bridge = await startChannel({
      cfg: textReplyConfig(),
      agent: {
        ...fakeAgent(() => {}),
        run(): AgentRun {
          return {
            events: (async function* (): AsyncGenerator<AgentEvent> {
              yield { type: 'done' };
            })(),
            stop,
            async waitForExit() {
              terminalReached();
              await exitReleased;
              return true;
            },
          };
        },
      },
      sessions: fakeSessions(),
      workspaces: fakeWorkspaces('/tmp/project'),
      controls: fakeControls(textReplyConfig()),
      persistentQueue,
    });
    await terminalReachedPromise;
    await bridge.disconnect();
    releaseExit();

    await vi.waitFor(() => expect(complete).toHaveBeenCalledWith('durable-terminal-done'));
    await vi.waitFor(async () => expect(await persistentQueue.recoverable()).toEqual([]));
  });

  test('disconnect marks active runs lifecycle-interrupted before channel disconnect side effects', async () => {
    const activeRuns = new ActiveRuns();
    let activeHandle: RunHandle | undefined;
    const originalRegisterPreRun = activeRuns.registerPreRun.bind(activeRuns);
    vi.spyOn(activeRuns, 'registerPreRun').mockImplementation((scope) => {
      activeHandle = originalRegisterPreRun(scope);
      return activeHandle;
    });
    let allowAgentExit!: () => void;
    const agentExitGate = new Promise<void>((resolve) => {
      allowAgentExit = resolve;
    });
    const persistentQueue = tempPersistentQueue();
    await persistentQueue.enqueue('chat-1', [fakeMessage('durable-active', 'active prompt')], {
      id: 'durable-active',
      now: 1000,
    });
    const messages: Record<string, (msg: NormalizedMessage) => Promise<void>> = {};
    const fakeChannel = {
      ...createFakeChannel(messages),
      async disconnect() {
        expect(activeHandle?.interruptReason).toBe('lifecycle');
        allowAgentExit();
      },
    } as unknown as LarkChannel;
    vi.mocked(createLarkChannel).mockReturnValue(fakeChannel);

    const bridge = await startChannel({
      cfg: textReplyConfig(),
      agent: fakeAgentWithEvents(async function* (): AsyncGenerator<AgentEvent> {
        await agentExitGate;
        yield { type: 'error', message: 'stream update failed during disconnect' };
      }),
      sessions: fakeSessions(),
      workspaces: fakeWorkspaces('/tmp/project'),
      controls: fakeControls(textReplyConfig()),
      persistentQueue,
      activeRuns,
    });
    await vi.waitFor(() => expect(activeHandle).toBeDefined());

    await bridge.disconnect();

    expect(await persistentQueue.recoverable()).toEqual([
      expect.objectContaining({ id: 'durable-active', scope: 'chat-1' }),
    ]);
  });

  test('auto retry dedupe key is remembered only after retry is queued', async () => {
    const flushed: string[] = [];
    const pending = new PendingQueue(0, (_scope, batch) => {
      flushed.push(...batch.map((msg) => msg.messageId));
    });
    const batch = [fakeMessage('msg-1', 'trigger opaque error')];
    const state = {
      ...createInitialState('run-1'),
      terminal: 'error' as const,
      errorMsg:
        'sdk run failed (runId=run-87dd74df-deb6-45ca-8862-85847622ee9a, status=error); Cursor returned no error detail',
    };
    const persistentQueue = tempPersistentQueue();
    const enqueue = vi.spyOn(persistentQueue, 'enqueue');
    enqueue.mockRejectedValueOnce(new Error('durable auto retry enqueue failed'));
    const autoRetryKeys = new Set<string>();

    await expect(
      maybeEnqueueAutoRetryForOpaqueSdkError({
        scope: 'chat-1',
        batch,
        finalState: state,
        handleInterrupted: false,
        pending,
        persistentQueue,
        autoRetryKeys,
      }),
    ).resolves.toBe(false);
    await expect(
      maybeEnqueueAutoRetryForOpaqueSdkError({
        scope: 'chat-1',
        batch,
        finalState: state,
        handleInterrupted: false,
        pending,
        persistentQueue,
        autoRetryKeys,
      }),
    ).resolves.toBe(true);

    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(flushed).toEqual(['msg-1']);
    expect(autoRetryKeys.size).toBe(1);
  });
});

function tempPersistentQueue(): PersistentQueue {
  return new PersistentQueue(join(mkdtempSync(join(tmpdir(), 'channel-persistent-queue-')), 'queue.json'));
}

function fakeMessage(messageId: string, content = 'queued', overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    messageId,
    chatId: 'chat-1',
    chatType: 'group',
    senderId: 'ou_user',
    content,
    rawContentType: 'text',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: true,
    createTime: Date.now(),
    ...overrides,
  };
}

function createFinalCardChannel(
  handlers: Record<string, (msg: NormalizedMessage) => Promise<void>>,
  opts: {
    chatMode?: 'p2p' | 'group' | 'topic';
    markUnread?: () => Promise<void>;
    updateCard?: (messageId: string, card: unknown) => Promise<void>;
  } = {},
): LarkChannel {
  const base = createFakeChannel(handlers);
  return {
    ...base,
    async getChatMode() {
      return opts.chatMode ?? 'group';
    },
    async stream(_chatId: string, payload: { card?: { producer(ctrl: { update(card: unknown): Promise<void> }): Promise<void> } }) {
      if (!payload.card) throw new Error('card stream producer was not registered');
      await payload.card.producer({ update: async () => {} });
      return { messageId: 'om_card_stream' };
    },
    async updateCard(messageId: string, card: unknown) {
      await opts.updateCard?.(messageId, card);
    },
    rawClient: {
      im: {
        v1: {
          ...base.rawClient.im.v1,
          chat: {
            ...(base.rawClient.im.v1 as { chat?: object }).chat,
            async membersMePatch() {
              await opts.markUnread?.();
            },
          },
        },
      },
    },
  } as unknown as LarkChannel;
}

function createFakeChannel(handlers: Record<string, (msg: NormalizedMessage) => Promise<void>>): LarkChannel {
  return {
    botIdentity: { name: 'bot', openId: 'ou_bot' },
    on(registered: Record<string, unknown>) {
      Object.assign(handlers, registered);
    },
    async connect() {},
    async disconnect() {},
    async send(_chatId: string, payload: unknown) {
      const markdown = (payload as { markdown?: string }).markdown;
      return { messageId: markdown?.includes('agent reply') ? 'om_sent_text' : 'om_command_reply' };
    },
    async getChatMode() {
      return 'group';
    },
    getConnectionStatus() {
      return { state: 'connected', reconnectAttempts: 0 };
    },
    rawClient: {
      im: {
        v1: {
          messageReaction: {
            async create() {
              return { data: { reaction_id: 'reaction-1' } };
            },
            async delete() {},
          },
        },
      },
    },
  } as unknown as LarkChannel;
}

function createDocCommentChannel(handlers: Record<string, (evt: never) => Promise<void>>): LarkChannel {
  const base = createFakeChannel(handlers as unknown as Record<string, (msg: NormalizedMessage) => Promise<void>>);
  return {
    ...base,
    rawClient: {
      ...base.rawClient,
      request: vi.fn(async () => ({})),
      wiki: {
        v2: {
          space: {
            async getNode() {
              return { data: {} };
            },
          },
        },
      },
      drive: {
        v1: {
          fileComment: {
            async get() {
              return {
                data: {
                  is_whole: false,
                  reply_list: {
                    replies: [
                      {
                        reply_id: 'reply-1',
                        content: { elements: [{ type: 'text_run', text_run: { text: 'doc question' } }] },
                      },
                    ],
                  },
                },
              };
            },
            async create() {
              return {};
            },
          },
        },
      },
    },
  } as unknown as LarkChannel;
}

function fakeNamedAgent(key: string, calls: string[]): AgentAdapter {
  return {
    ...fakeAgent(() => calls.push(key)),
    id: key,
    sessionKey: key,
    displayName: key,
    commandLabel: key,
    descriptor: {
      id: key,
      label: key,
      runtime: 'test',
      sessionKey: key,
      commandLabel: key,
      supportsRetry: true,
      supportsWorkers: false,
    },
  };
}

function fakeAgent(onRun: (opts: AgentRunOptions) => void): AgentAdapter {
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
    run(opts: AgentRunOptions): AgentRun {
      onRun(opts);
      return {
        events: (async function* (): AsyncGenerator<AgentEvent> {
          yield { type: 'text', delta: 'agent reply' };
          yield { type: 'done' };
        })(),
        async stop() {},
        async waitForExit() {
          return true;
        },
      };
    },
  };
}

function fakeAgentWithEvents(events: () => AsyncGenerator<AgentEvent>): AgentAdapter {
  const agent = fakeAgent(() => {});
  return {
    ...agent,
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

function textReplyConfig(): AppConfig {
  return {
    accounts: { app: { id: 'app-id', secret: 'app-secret', tenant: 'feishu' } },
    preferences: {
      messageReply: 'text',
      messageReplyMigrated: true,
      requireMentionInGroup: false,
    },
  };
}

function cardReplyConfig(): AppConfig {
  return {
    ...textReplyConfig(),
    preferences: {
      ...textReplyConfig().preferences,
      messageReply: 'card',
    },
  };
}

function markdownReplyConfig(): AppConfig {
  return {
    ...textReplyConfig(),
    preferences: {
      ...textReplyConfig().preferences,
      messageReply: 'markdown',
    },
  };
}

function fakeControls(cfg: AppConfig): Controls {
  return {
    cfg,
    processId: 'test-process',
    configPath: '/tmp/config.json',
    async restart() {},
    async exit() {},
  };
}

function fakeSessions(): SessionStore {
  return {
    resumeFor() {
      return undefined;
    },
    getRaw() {
      return undefined;
    },
    clear() {},
    set() {},
    getIdleTimeoutMinutes() {
      return undefined;
    },
    async flush() {},
  } as unknown as SessionStore;
}

function fakeWorkspaces(cwd: string): WorkspaceStore {
  return {
    cwdFor() {
      return cwd;
    },
    async flush() {},
  } as unknown as WorkspaceStore;
}

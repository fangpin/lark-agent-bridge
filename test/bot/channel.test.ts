import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

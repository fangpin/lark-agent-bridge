import { describe, expect, test, vi } from 'vitest';
import type { CardActionEvent, NormalizedMessage } from '@larksuiteoapi/node-sdk';
import { PendingQueue } from '../../src/bot/pending-queue';
import { PersistentQueue } from '../../src/bot/persistent-queue';
import { handleCardAction, type CardDispatchDeps } from '../../src/card/dispatcher';

function callbackEvent(value: Record<string, unknown> = { __claude_cb: true, action: 'approve' }): CardActionEvent {
  return {
    chatId: 'chat-1',
    messageId: 'om-card',
    operator: { openId: 'ou_user', name: 'User' },
    action: { value },
  } as unknown as CardActionEvent;
}

function deps(overrides: Partial<CardDispatchDeps> = {}): CardDispatchDeps {
  const pending = new PendingQueue(1000, () => {
    throw new Error('callback should remain queued');
  });
  return {
    channel: {
      async getChatMode() {
        return 'p2p';
      },
      async send() {
        return { messageId: 'om-command-reply' };
      },
    },
    evt: callbackEvent(),
    sessions: {},
    workspaces: {
      cwdFor: vi.fn(() => '/repo'),
    },
    activeRuns: {
      interrupt: vi.fn(() => false),
    },
    agent: {
      id: 'fake',
      displayName: 'Fake Agent',
      sessionKey: 'fake:test',
      commandLabel: 'fake',
      descriptor: {
        id: 'fake',
        label: 'Fake Agent',
        runtime: 'test',
        sessionKey: 'fake:test',
        commandLabel: 'fake',
        supportsRetry: true,
        supportsWorkers: false,
      },
    },
    controls: { cfg: { preferences: { requireMentionInGroup: false } } },
    pending,
    persistentQueue: {
      enqueue: vi.fn(async (_scope: string, messages: NormalizedMessage[]) => ({
        id: 'durable-card-1',
        scope: 'chat-1',
        messages,
        state: 'queued' as const,
        createdAt: 1000,
        updatedAt: 1000,
      })),
      cancelScope: vi.fn(async () => 0),
    } as unknown as PersistentQueue,
    runHistory: {},
    chatModeCache: {
      async resolve() {
        return 'p2p';
      },
    },
    ...overrides,
  } as unknown as CardDispatchDeps;
}

describe('handleCardAction callback forwarding', () => {
  test('persists callback work before pushing it into pending queue', async () => {
    const d = deps();
    const pushBatch = vi.spyOn(d.pending, 'pushBatch');

    await handleCardAction(d);

    expect(d.persistentQueue?.enqueue).toHaveBeenCalledWith('chat-1', [expect.objectContaining({
      content: expect.stringContaining('[card-click]'),
      rawContentType: 'card_action',
    })]);
    expect(pushBatch).toHaveBeenCalledWith('chat-1', [expect.objectContaining({ rawContentType: 'card_action' })], {
      durableId: 'durable-card-1',
    });
  });

  test('sends visible failure and does not push callback work when durable enqueue fails', async () => {
    const send = vi.fn(async () => ({ messageId: 'om-failure' }));
    const d = deps({
      channel: {
        async getChatMode() {
          return 'p2p';
        },
        send,
      } as unknown as CardDispatchDeps['channel'],
      persistentQueue: {
        enqueue: vi.fn(async () => {
          throw new Error('durable enqueue failed');
        }),
        cancelScope: vi.fn(async () => 0),
      } as unknown as PersistentQueue,
    });
    const pushBatch = vi.spyOn(d.pending, 'pushBatch');

    await handleCardAction(d);

    expect(pushBatch).not.toHaveBeenCalled();
    expect(d.pending.queuedSize('chat-1')).toBe(0);
    expect(send).toHaveBeenCalledWith('chat-1', {
      markdown: expect.stringContaining('durable enqueue failed'),
    }, { replyTo: 'om-card' });
  });
});

describe('handleCardAction mutating command cleanup', () => {
  test('card backend switch cancels durable and memory queued work before mutating backend state', async () => {
    const callOrder: string[] = [];
    const backendStore = {
      get: vi.fn(() => 'claude'),
      set: vi.fn((_scope: string, _key: string) => {
        callOrder.push('backend.set');
      }),
      clear: vi.fn(),
    };
    const makeAgent = (key: string) => ({
      id: key,
      displayName: key,
      sessionKey: key,
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
      evictScope: vi.fn(async () => undefined),
    });
    const d = deps({
      evt: callbackEvent({ cmd: 'backend', arg: 'codex' }),
      agent: makeAgent('claude') as never,
      agentRegistry: {
        keys: () => ['claude', 'codex'],
        defaultKey: () => 'claude',
        has: (key: string) => ['claude', 'codex'].includes(key),
        get: async (key: string) => makeAgent(key),
        getOrDefault: async (key?: string) => makeAgent(key ?? 'claude'),
      } as never,
      backendStore: backendStore as never,
      persistentQueue: {
        enqueue: vi.fn(),
        cancelScope: vi.fn(async () => {
          callOrder.push('durable.cancel');
          return 1;
        }),
      } as unknown as PersistentQueue,
    });
    d.pending.push('chat-1', fakeMessage('msg-pending'));
    const originalCancel = d.pending.cancel.bind(d.pending);
    const cancel = vi.spyOn(d.pending, 'cancel').mockImplementation((scope) => {
      callOrder.push('memory.cancel');
      return originalCancel(scope);
    });

    await handleCardAction(d);

    expect(d.persistentQueue.cancelScope).toHaveBeenCalledWith('chat-1');
    expect(cancel).toHaveBeenCalledWith('chat-1');
    expect(backendStore.set).toHaveBeenCalledWith('chat-1', 'codex');
    expect(d.pending.queuedSize('chat-1')).toBe(0);
    expect(callOrder).toEqual(['durable.cancel', 'memory.cancel', 'backend.set']);
  });
});

describe('handleCardAction stop command cleanup', () => {
  test('card stop cancels durable records and queued memory work through the command handler', async () => {
    const d = deps({
      evt: callbackEvent({ cmd: 'stop' }),
      activeRuns: {
        interrupt: vi.fn(() => true),
      } as never,
      persistentQueue: {
        enqueue: vi.fn(),
        cancelScope: vi.fn(async () => 1),
      } as unknown as PersistentQueue,
    });
    d.pending.push('chat-1', fakeMessage('msg-pending'));
    const cancel = vi.spyOn(d.pending, 'cancel');

    await handleCardAction(d);

    expect(d.persistentQueue.cancelScope).toHaveBeenCalledWith('chat-1');
    expect(d.activeRuns.interrupt).toHaveBeenCalledWith('chat-1');
    expect(cancel).toHaveBeenCalledWith('chat-1');
    expect(d.pending.queuedSize('chat-1')).toBe(0);
  });

  test('card stop leaves memory pending queued when durable cancellation fails', async () => {
    const d = deps({
      evt: callbackEvent({ cmd: 'stop' }),
      activeRuns: {
        interrupt: vi.fn(() => true),
      } as never,
      persistentQueue: {
        enqueue: vi.fn(),
        cancelScope: vi.fn(async () => {
          throw new Error('durable cancel failed');
        }),
      } as unknown as PersistentQueue,
    });
    d.pending.push('chat-1', fakeMessage('msg-pending'));
    const cancel = vi.spyOn(d.pending, 'cancel');

    await handleCardAction(d);

    expect(d.persistentQueue.cancelScope).toHaveBeenCalledWith('chat-1');
    expect(d.activeRuns.interrupt).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalledWith('chat-1');
    expect(d.pending.queuedSize('chat-1')).toBe(1);
  });
});

function fakeMessage(messageId: string): NormalizedMessage {
  return {
    messageId,
    chatId: 'chat-1',
    chatType: 'p2p',
    senderId: 'ou_user',
    content: 'queued work',
    rawContentType: 'text',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
    createTime: Date.now(),
  };
}

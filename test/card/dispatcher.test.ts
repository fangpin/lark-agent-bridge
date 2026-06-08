import { describe, expect, test, vi } from 'vitest';
import type { CardActionEvent, NormalizedMessage } from '@larksuiteoapi/node-sdk';
import { PendingQueue } from '../../src/bot/pending-queue';
import { PersistentQueue } from '../../src/bot/persistent-queue';
import { handleCardAction, type CardDispatchDeps } from '../../src/card/dispatcher';

function callbackEvent(): CardActionEvent {
  return {
    chatId: 'chat-1',
    messageId: 'om-card',
    operator: { openId: 'ou_user', name: 'User' },
    action: { value: { __claude_cb: true, action: 'approve' } },
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
    },
    evt: callbackEvent(),
    sessions: {},
    workspaces: {},
    activeRuns: {},
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

  test('does not push callback work into memory when durable enqueue fails', async () => {
    const d = deps({
      persistentQueue: {
        enqueue: vi.fn(async () => {
          throw new Error('durable enqueue failed');
        }),
      } as unknown as PersistentQueue,
    });
    const pushBatch = vi.spyOn(d.pending, 'pushBatch');

    await handleCardAction(d);

    expect(pushBatch).not.toHaveBeenCalled();
    expect(d.pending.queuedSize('chat-1')).toBe(0);
  });
});

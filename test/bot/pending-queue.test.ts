import { describe, expect, test, vi } from 'vitest';
import type { NormalizedMessage } from '@larksuiteoapi/node-sdk';
import { PendingQueue } from '../../src/bot/pending-queue';

function msg(id: string): NormalizedMessage {
  return {
    messageId: id,
    chatId: 'chat-1',
    chatType: 'p2p',
    senderId: 'user-1',
    content: id,
    rawContentType: 'text',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
    createTime: Date.now(),
  };
}

describe('PendingQueue', () => {
  test('flushes immediately when delay is disabled', () => {
    const flushed: Array<{ scope: string; ids: string[] }> = [];
    const queue = new PendingQueue(0, (scope, batch) => {
      flushed.push({ scope, ids: batch.map((m) => m.messageId) });
    });

    const size = queue.push('chat-1', msg('m1'));

    expect(size).toBe(1);
    expect(flushed).toEqual([{ scope: 'chat-1', ids: ['m1'] }]);
  });

  test('flushes queued messages immediately after unblock when delay is disabled', () => {
    const flushed: string[][] = [];
    const queue = new PendingQueue(0, (_scope, batch) => {
      flushed.push(batch.map((m) => m.messageId));
    });

    queue.block('chat-1');
    queue.push('chat-1', msg('m1'));
    queue.push('chat-1', msg('m2'));
    expect(flushed).toEqual([]);

    queue.unblock('chat-1');

    expect(flushed).toEqual([['m1', 'm2']]);
  });

  test('flushes durable batch ids with queued messages', () => {
    vi.useFakeTimers();
    try {
      const flushed: Array<{ durableId: string | undefined; ids: string[] }> = [];
      const queue = new PendingQueue(1000, (_scope, batch, durableId) => {
        flushed.push({ durableId, ids: batch.map((m) => m.messageId) });
      });

      queue.push('chat-1', msg('m1'), { durableId: 'pq-1' });
      queue.push('chat-1', msg('m2'), { durableId: 'pq-1' });
      vi.advanceTimersByTime(1000);

      expect(flushed).toEqual([{ durableId: 'pq-1', ids: ['m1', 'm2'] }]);
    } finally {
      vi.useRealTimers();
    }
  });

  test('pushes recovered batches as one durable unit', () => {
    const flushed: Array<{ durableId: string | undefined; ids: string[] }> = [];
    const queue = new PendingQueue(0, (_scope, batch, durableId) => {
      flushed.push({ durableId, ids: batch.map((m) => m.messageId) });
    });

    const size = queue.pushBatch('chat-1', [msg('m1'), msg('m2')], { durableId: 'pq-restored' });

    expect(size).toBe(2);
    expect(flushed).toEqual([{ durableId: 'pq-restored', ids: ['m1', 'm2'] }]);
  });

  test('flushes durable messages synchronously when delay is disabled', () => {
    const flushed: Array<{ durableId: string | undefined; ids: string[] }> = [];
    const queue = new PendingQueue(0, (_scope, batch, durableId) => {
      flushed.push({ durableId, ids: batch.map((m) => m.messageId) });
    });

    const size = queue.push('chat-1', msg('m1'), { durableId: 'pq-1' });

    expect(size).toBe(1);
    expect(flushed).toEqual([{ durableId: 'pq-1', ids: ['m1'] }]);
    expect(queue.queuedSize('chat-1')).toBe(0);
    expect(queue.cancel('chat-1')).toEqual([]);
  });

  test('does not merge different durable ids into one flush', () => {
    vi.useFakeTimers();
    try {
      const flushed: Array<{ durableId: string | undefined; ids: string[] }> = [];
      const queue = new PendingQueue(1000, (_scope, batch, durableId) => {
        flushed.push({ durableId, ids: batch.map((m) => m.messageId) });
      });

      queue.push('chat-1', msg('m1'), { durableId: 'pq-1' });
      const size = queue.push('chat-1', msg('m2'), { durableId: 'pq-2' });

      expect(flushed).toEqual([{ durableId: 'pq-1', ids: ['m1'] }]);
      expect(size).toBe(1);
      expect(queue.queuedSize('chat-1')).toBe(1);

      vi.advanceTimersByTime(1000);

      expect(flushed).toEqual([
        { durableId: 'pq-1', ids: ['m1'] },
        { durableId: 'pq-2', ids: ['m2'] },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  test('keeps different durable ids separate while blocked', () => {
    const flushed: Array<{ durableId: string | undefined; ids: string[] }> = [];
    const queue = new PendingQueue(0, (_scope, batch, durableId) => {
      flushed.push({ durableId, ids: batch.map((m) => m.messageId) });
    });

    queue.block('chat-1');
    queue.push('chat-1', msg('m1'), { durableId: 'pq-1' });
    queue.push('chat-1', msg('m2'), { durableId: 'pq-2' });

    expect(flushed).toEqual([]);
    expect(queue.queuedSize('chat-1')).toBe(2);

    queue.unblock('chat-1');

    expect(flushed).toEqual([
      { durableId: 'pq-1', ids: ['m1'] },
      { durableId: 'pq-2', ids: ['m2'] },
    ]);
    expect(queue.queuedSize('chat-1')).toBe(0);
  });

  test('delays unblock even when no entry exists yet', async () => {
    vi.useFakeTimers();
    try {
      const flushed: string[][] = [];
      const queue = new PendingQueue(0, (_scope, batch) => {
        flushed.push(batch.map((m) => m.messageId));
      });

      queue.block('chat-1');
      queue.unblockAfter('chat-1', 1000);
      queue.push('chat-1', msg('m1'));

      expect(flushed).toEqual([]);
      await vi.advanceTimersByTimeAsync(999);
      expect(flushed).toEqual([]);

      await vi.advanceTimersByTimeAsync(1);

      expect(flushed).toEqual([['m1']]);
    } finally {
      vi.useRealTimers();
    }
  });

  test('cancel during delayed unblock clears blocked state for later work', async () => {
    vi.useFakeTimers();
    try {
      const flushed: string[][] = [];
      const queue = new PendingQueue(0, (_scope, batch) => {
        flushed.push(batch.map((m) => m.messageId));
      });

      queue.block('chat-1');
      queue.push('chat-1', msg('old'));
      queue.unblockAfter('chat-1', 1000);

      expect(queue.cancel('chat-1').map((m) => m.messageId)).toEqual(['old']);
      queue.push('chat-1', msg('new'));

      expect(flushed).toEqual([['new']]);
      await vi.advanceTimersByTimeAsync(1000);
      expect(flushed).toEqual([['new']]);
    } finally {
      vi.useRealTimers();
    }
  });
});

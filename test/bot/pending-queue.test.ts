import { describe, expect, test } from 'vitest';
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
});

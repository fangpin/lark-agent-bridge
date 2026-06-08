import { mkdtempSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { NormalizedMessage } from '@larksuiteoapi/node-sdk';
import { PersistentQueue } from '../../src/bot/persistent-queue';

function queueFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'persistent-queue-')), 'queue.json');
}

function msg(id: string, content = id): NormalizedMessage {
  return {
    messageId: id,
    chatId: 'chat-1',
    chatType: 'p2p',
    senderId: 'user-1',
    content,
    rawContentType: 'text',
    resources: [{ type: 'image', fileKey: `file-${id}` }],
    mentions: [{ key: `user-${id}`, name: `User ${id}` }],
    mentionAll: false,
    mentionedBot: true,
    createTime: 1_000,
    raw: { event: { message: { message_id: id } } },
  } as NormalizedMessage;
}

describe('PersistentQueue', () => {
  test('creates and reloads queued records in creation order', async () => {
    const file = queueFile();
    const queue = new PersistentQueue(file);

    const later = await queue.enqueue('scope-a', [msg('m2')], { id: 'later', now: 2_000 });
    const earlier = await queue.enqueue('scope-a', [msg('m1')], { id: 'earlier', now: 1_000 });

    const reloaded = await new PersistentQueue(file).recoverable();

    expect(reloaded.map((record) => record.id)).toEqual(['earlier', 'later']);
    expect(reloaded).toMatchObject([
      { id: earlier.id, scope: 'scope-a', state: 'queued', createdAt: 1_000, updatedAt: 1_000 },
      { id: later.id, scope: 'scope-a', state: 'queued', createdAt: 2_000, updatedAt: 2_000 },
    ]);
    expect(reloaded[0]!.messages.map((message) => message.messageId)).toEqual(['m1']);
  });

  test('marks a record running and recovers it after reload', async () => {
    const file = queueFile();
    const queue = new PersistentQueue(file);
    const record = await queue.enqueue('scope-a', [msg('m1')], { id: 'record-1', now: 1_000 });

    const running = await queue.markRunning(record.id, { now: 2_000 });
    const missing = await queue.markRunning('missing', { now: 3_000 });
    const reloaded = await new PersistentQueue(file).recoverable();

    expect(running).toMatchObject({ id: record.id, state: 'running', createdAt: 1_000, updatedAt: 2_000 });
    expect(missing).toBeUndefined();
    expect(reloaded).toMatchObject([{ id: record.id, state: 'running', createdAt: 1_000, updatedAt: 2_000 }]);
  });

  test('removes completed records', async () => {
    const file = queueFile();
    const queue = new PersistentQueue(file);
    const first = await queue.enqueue('scope-a', [msg('m1')], { id: 'first', now: 1_000 });
    await queue.enqueue('scope-a', [msg('m2')], { id: 'second', now: 2_000 });

    await expect(queue.complete(first.id)).resolves.toBe(true);
    await expect(queue.complete('missing')).resolves.toBe(false);

    const reloaded = await new PersistentQueue(file).recoverable();
    expect(reloaded.map((record) => record.id)).toEqual(['second']);
  });

  test('cancels all records for a scope only', async () => {
    const file = queueFile();
    const queue = new PersistentQueue(file);
    await queue.enqueue('scope-a', [msg('m1')], { id: 'a1', now: 1_000 });
    await queue.enqueue('scope-b', [msg('m2')], { id: 'b1', now: 2_000 });
    await queue.enqueue('scope-a', [msg('m3')], { id: 'a2', now: 3_000 });

    await expect(queue.cancelScope('scope-a')).resolves.toBe(2);
    await expect(queue.cancelScope('scope-missing')).resolves.toBe(0);

    const reloaded = await new PersistentQueue(file).recoverable();
    expect(reloaded.map((record) => record.id)).toEqual(['b1']);
  });

  test('skips malformed records while keeping valid records', async () => {
    const file = queueFile();
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        records: [
          { id: 'valid', scope: 'scope-a', messages: [msg('m1')], state: 'queued', createdAt: 1_000, updatedAt: 1_000 },
          { id: 'bad-state', scope: 'scope-a', messages: [msg('m2')], state: 'done', createdAt: 2_000, updatedAt: 2_000 },
          { id: 'bad-messages', scope: 'scope-a', messages: 'not-array', state: 'queued', createdAt: 3_000, updatedAt: 3_000 },
          { scope: 'missing-id', messages: [msg('m4')], state: 'running', createdAt: 4_000, updatedAt: 4_000 },
        ],
      }),
    );

    const records = await new PersistentQueue(file).recoverable();

    expect(records.map((record) => record.id)).toEqual(['valid']);
    expect(records[0]!.messages[0]!.messageId).toBe('m1');
  });
});

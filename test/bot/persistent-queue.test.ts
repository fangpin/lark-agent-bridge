import { mkdtempSync } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { NormalizedMessage } from '@larksuiteoapi/node-sdk';
import { PersistentQueue } from '../../src/bot/persistent-queue';
import { log } from '../../src/core/logger';

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
  afterEach(() => {
    vi.restoreAllMocks();
  });

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

  test('orders records with matching creation times by id', async () => {
    const file = queueFile();
    const queue = new PersistentQueue(file);

    await queue.enqueue('scope-a', [msg('m3')], { id: 'record-c', now: 1_000 });
    await queue.enqueue('scope-a', [msg('m1')], { id: 'record-a', now: 1_000 });
    await queue.enqueue('scope-a', [msg('m2')], { id: 'record-b', now: 1_000 });

    const reloaded = await new PersistentQueue(file).recoverable();

    expect(reloaded.map((record) => record.id)).toEqual(['record-a', 'record-b', 'record-c']);
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

  test('serializes concurrent enqueues without losing records', async () => {
    const file = queueFile();
    const queue = new PersistentQueue(file, () => 1_000);

    await Promise.all([
      queue.enqueue('scope-a', [msg('m1')], { id: 'pq-1', now: 1_000 }),
      queue.enqueue('scope-a', [msg('m2')], { id: 'pq-2', now: 1_001 }),
    ]);

    expect((await queue.recoverable()).map((record) => record.id).sort()).toEqual(['pq-1', 'pq-2']);
  });

  test('serializes concurrent enqueues from separate instances for the same file', async () => {
    const file = queueFile();
    const first = new PersistentQueue(file, () => 1_000);
    const second = new PersistentQueue(file, () => 2_000);

    await Promise.all([
      first.enqueue('scope-a', [msg('m1')], { id: 'pq-1', now: 1_000 }),
      second.enqueue('scope-a', [msg('m2')], { id: 'pq-2', now: 2_000 }),
    ]);

    expect((await new PersistentQueue(file).recoverable()).map((record) => record.id).sort()).toEqual(['pq-1', 'pq-2']);
  });

  test('rejects duplicate caller-provided ids', async () => {
    const file = queueFile();
    const queue = new PersistentQueue(file, () => 1_000);
    await queue.enqueue('scope-a', [msg('m1')], { id: 'same', now: 1_000 });

    await expect(queue.enqueue('scope-b', [msg('m2')], { id: 'same', now: 2_000 })).rejects.toThrow(
      'persistent queue id already exists: same',
    );

    expect(await queue.recoverable()).toEqual([
      expect.objectContaining({ id: 'same', scope: 'scope-a' }),
    ]);
  });

  test('skips duplicate ids from old queue files and logs the skipped records', async () => {
    const file = queueFile();
    const fail = vi.spyOn(log, 'fail').mockImplementation(() => undefined);
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        records: [
          { id: 'same', scope: 'scope-a', messages: [msg('m1')], state: 'queued', createdAt: 1_000, updatedAt: 1_000 },
          { id: 'same', scope: 'scope-b', messages: [msg('m2')], state: 'queued', createdAt: 2_000, updatedAt: 2_000 },
          { id: 'other', scope: 'scope-c', messages: [msg('m3')], state: 'queued', createdAt: 3_000, updatedAt: 3_000 },
        ],
      }),
    );

    const records = await new PersistentQueue(file).recoverable();

    expect(records.map((record) => `${record.id}:${record.scope}`)).toEqual(['same:scope-a', 'other:scope-c']);
    expect(fail).toHaveBeenCalledWith(
      'queue',
      expect.any(Error),
      expect.objectContaining({ recordId: 'same', step: 'persistent-read-record' }),
    );
  });

  test('complete ignores duplicate legacy records rather than mutating the wrong later duplicate', async () => {
    const file = queueFile();
    const queue = new PersistentQueue(file, () => 1_000);
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        records: [
          { id: 'same', scope: 'scope-a', messages: [msg('m1')], state: 'queued', createdAt: 1_000, updatedAt: 1_000 },
          { id: 'same', scope: 'scope-b', messages: [msg('m2')], state: 'queued', createdAt: 2_000, updatedAt: 2_000 },
          { id: 'other', scope: 'scope-c', messages: [msg('m3')], state: 'queued', createdAt: 3_000, updatedAt: 3_000 },
        ],
      }),
    );

    await expect(queue.complete('same')).resolves.toBe(true);

    expect((await queue.recoverable()).map((record) => `${record.id}:${record.scope}`)).toEqual(['other:scope-c']);
  });

  test('retries generated ids when a collision occurs', async () => {
    const file = queueFile();
    const queue = new PersistentQueue(file, () => 1_000);
    vi.spyOn(Math, 'random')
      .mockReturnValueOnce(0.5)
      .mockReturnValueOnce(0.5)
      .mockReturnValueOnce(0.75);

    const first = await queue.enqueue('scope-a', [msg('m1')]);
    const second = await queue.enqueue('scope-a', [msg('m2')]);

    expect(first.id).toBe('queue-rs-i');
    expect(second.id).not.toBe(first.id);
    expect((await queue.recoverable()).map((record) => record.id)).toEqual([first.id, second.id]);
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

  test('does not overwrite an unreadable or corrupt queue file during mutation', async () => {
    const file = queueFile();
    await writeFile(file, '{not valid json');
    const queue = new PersistentQueue(file);

    await expect(queue.enqueue('chat-1', [msg('m1')])).rejects.toThrow(/persistent queue/i);

    expect(await readFile(file, 'utf8')).toBe('{not valid json');
  });

  test('recovers an empty list when the queue file is missing', async () => {
    const file = queueFile();

    await expect(new PersistentQueue(file).recoverable()).resolves.toEqual([]);
  });

  test('logs top-level malformed queue files during recoverable reads', async () => {
    const file = queueFile();
    const fail = vi.spyOn(log, 'fail').mockImplementation(() => undefined);
    await writeFile(file, '[]');

    await expect(new PersistentQueue(file).recoverable()).resolves.toEqual([]);

    expect(fail).toHaveBeenCalledWith(
      'queue',
      expect.any(Error),
      expect.objectContaining({ step: 'persistent-read' }),
    );
  });

  test('logs parse-corrupt queue files during recoverable reads', async () => {
    const file = queueFile();
    const fail = vi.spyOn(log, 'fail').mockImplementation(() => undefined);
    await writeFile(file, '{not valid json');

    await expect(new PersistentQueue(file).recoverable()).resolves.toEqual([]);

    expect(fail).toHaveBeenCalledWith(
      'queue',
      expect.any(Error),
      expect.objectContaining({ step: 'persistent-read' }),
    );
  });

  test('does not overwrite a top-level malformed queue file during mutation', async () => {
    const file = queueFile();
    const malformed = JSON.stringify({ version: 2, records: [] });
    await writeFile(file, malformed);

    await expect(new PersistentQueue(file).enqueue('chat-1', [msg('m1')])).rejects.toThrow(/persistent queue/i);

    expect(await readFile(file, 'utf8')).toBe(malformed);
  });

  test('continues later mutations after a failed mutation on the same file', async () => {
    const file = queueFile();
    const queue = new PersistentQueue(file);
    await writeFile(file, '{not valid json');

    await expect(queue.enqueue('chat-1', [msg('m1')], { id: 'failed' })).rejects.toThrow(/persistent queue/i);
    await writeFile(file, JSON.stringify({ version: 1, records: [] }));
    await expect(queue.enqueue('chat-1', [msg('m2')], { id: 'recovered', now: 2_000 })).resolves.toMatchObject({
      id: 'recovered',
    });

    expect((await queue.recoverable()).map((record) => record.id)).toEqual(['recovered']);
  });

  test('concurrent writes leave one final queue file and no colliding tmp files', async () => {
    const file = queueFile();
    const queues = Array.from({ length: 10 }, (_, index) => new PersistentQueue(file, () => 1_000 + index));

    await Promise.all(
      queues.map((queue, index) => queue.enqueue('scope-a', [msg(`m${index}`)], { id: `record-${index}`, now: 1_000 + index })),
    );

    expect((await new PersistentQueue(file).recoverable()).map((record) => record.id).sort()).toEqual(
      Array.from({ length: 10 }, (_, index) => `record-${index}`).sort(),
    );
    expect((await readdir(dirname(file))).filter((name) => name.includes('.tmp-'))).toEqual([]);
  });

  test('deeply clones resources, mentions, and raw when enqueuing and recovering records', async () => {
    const file = queueFile();
    const queue = new PersistentQueue(file);
    const original = msg('m1');

    const enqueued = await queue.enqueue('scope-a', [original], { id: 'record-1', now: 1_000 });
    original.resources[0]!.fileKey = 'changed-original-resource';
    original.mentions[0]!.name = 'Changed Original Mention';
    (original.raw as { event: { message: { message_id: string } } }).event.message.message_id = 'changed-original-raw';
    enqueued.messages[0]!.resources[0]!.fileKey = 'changed-enqueued-resource';
    enqueued.messages[0]!.mentions[0]!.name = 'Changed Enqueued Mention';
    (enqueued.messages[0]!.raw as { event: { message: { message_id: string } } }).event.message.message_id = 'changed-enqueued-raw';

    const recovered = await new PersistentQueue(file).recoverable();
    recovered[0]!.messages[0]!.resources[0]!.fileKey = 'changed-recovered-resource';
    recovered[0]!.messages[0]!.mentions[0]!.name = 'Changed Recovered Mention';
    (recovered[0]!.messages[0]!.raw as { event: { message: { message_id: string } } }).event.message.message_id = 'changed-recovered-raw';

    const rerecovered = await new PersistentQueue(file).recoverable();
    expect(rerecovered[0]!.messages[0]!.resources[0]!.fileKey).toBe('file-m1');
    expect(rerecovered[0]!.messages[0]!.mentions[0]!.name).toBe('User m1');
    expect((rerecovered[0]!.messages[0]!.raw as { event: { message: { message_id: string } } }).event.message.message_id).toBe('m1');
  });

  test('preserves valid messages in a record while skipping malformed messages', async () => {
    const file = queueFile();
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        records: [
          {
            id: 'mixed-messages',
            scope: 'scope-a',
            messages: [msg('m1'), null, { messageId: 'missing-required-fields' }, msg('m2')],
            state: 'queued',
            createdAt: 1_000,
            updatedAt: 1_000,
          },
        ],
      }),
    );

    const records = await new PersistentQueue(file).recoverable();

    expect(records).toHaveLength(1);
    expect(records[0]!.id).toBe('mixed-messages');
    expect(records[0]!.messages.map((message) => message.messageId)).toEqual(['m1', 'm2']);
  });

  test('skips messages with invalid chatType while preserving valid messages', async () => {
    const file = queueFile();
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        records: [
          { id: 'valid', scope: 'scope-a', messages: [msg('m1')], state: 'queued', createdAt: 1_000, updatedAt: 1_000 },
          {
            id: 'mixed-chat-types',
            scope: 'scope-a',
            messages: [msg('m2'), { ...msg('m3'), chatType: 'invalid' }, msg('m4')],
            state: 'queued',
            createdAt: 2_000,
            updatedAt: 2_000,
          },
          {
            id: 'invalid-chat-type',
            scope: 'scope-a',
            messages: [{ ...msg('m5'), chatType: 'invalid' }],
            state: 'queued',
            createdAt: 3_000,
            updatedAt: 3_000,
          },
        ],
      }),
    );

    const records = await new PersistentQueue(file).recoverable();

    expect(records.map((record) => record.id)).toEqual(['valid', 'mixed-chat-types']);
    expect(records[0]!.messages.map((message) => message.messageId)).toEqual(['m1']);
    expect(records[1]!.messages.map((message) => message.messageId)).toEqual(['m2', 'm4']);
  });

  test('skips records when all messages are malformed', async () => {
    const file = queueFile();
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        records: [
          { id: 'valid', scope: 'scope-a', messages: [msg('m1')], state: 'queued', createdAt: 1_000, updatedAt: 1_000 },
          { id: 'bad-message', scope: 'scope-a', messages: [null], state: 'queued', createdAt: 2_000, updatedAt: 2_000 },
        ],
      }),
    );

    expect(await new PersistentQueue(file).recoverable()).toEqual([
      expect.objectContaining({ id: 'valid' }),
    ]);
  });

  test('preserves messages while filtering malformed resources and mentions', async () => {
    const file = queueFile();
    const validResource = { type: 'image', fileKey: 'file-m1' };
    const validMention = { key: 'user-m1', name: 'User m1' };
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        records: [
          {
            id: 'mixed-nested-items',
            scope: 'scope-a',
            messages: [
              {
                ...msg('m1'),
                resources: [validResource, null, { type: 'image' }],
                mentions: [validMention, null, {}],
              },
            ],
            state: 'queued',
            createdAt: 1_000,
            updatedAt: 1_000,
          },
        ],
      }),
    );

    const records = await new PersistentQueue(file).recoverable();

    expect(records).toHaveLength(1);
    expect(records[0]!.messages).toHaveLength(1);
    expect(records[0]!.messages[0]!.resources).toEqual([validResource]);
    expect(records[0]!.messages[0]!.mentions).toEqual([validMention]);
  });

  test('skips messages when resources or mentions are not arrays', async () => {
    const file = queueFile();
    const withResources = (id: string, resources: unknown): unknown => ({
      ...msg(id),
      resources,
    });
    const withMentions = (id: string, mentions: unknown): unknown => ({
      ...msg(id),
      mentions,
    });
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        records: [
          { id: 'valid', scope: 'scope-a', messages: [msg('m1')], state: 'queued', createdAt: 1_000, updatedAt: 1_000 },
          { id: 'bad-resources', scope: 'scope-a', messages: [withResources('m2', null)], state: 'queued', createdAt: 2_000, updatedAt: 2_000 },
          { id: 'bad-mentions', scope: 'scope-a', messages: [withMentions('m3', {})], state: 'queued', createdAt: 3_000, updatedAt: 3_000 },
        ],
      }),
    );

    expect(await new PersistentQueue(file).recoverable()).toEqual([
      expect.objectContaining({ id: 'valid' }),
    ]);
  });

  test('skips messages missing required normalized fields', async () => {
    const file = queueFile();
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        records: [
          { id: 'valid', scope: 'scope-a', messages: [msg('m1')], state: 'queued', createdAt: 1_000, updatedAt: 1_000 },
          {
            id: 'missing-fields',
            scope: 'scope-a',
            messages: [
              {
                messageId: 'm2',
                chatId: 'chat-1',
                chatType: 'p2p',
                senderId: 'user-1',
                rawContentType: 'text',
              },
            ],
            state: 'queued',
            createdAt: 2_000,
            updatedAt: 2_000,
          },
        ],
      }),
    );

    const records = await new PersistentQueue(file).recoverable();

    expect(records.map((record) => record.id)).toEqual(['valid']);
  });

  test('filters malformed optional normalized fields while preserving messages', async () => {
    const file = queueFile();
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        records: [
          {
            id: 'optional-fields',
            scope: 'scope-a',
            messages: [
              {
                ...msg('m1'),
                senderName: [],
                rootId: false,
                threadId: 123,
                replyToMessageId: {},
              },
              {
                ...msg('m2'),
                senderName: 'Sender Name',
                rootId: 'root-1',
                threadId: 'thread-1',
                replyToMessageId: 'reply-1',
              },
            ],
            state: 'queued',
            createdAt: 1_000,
            updatedAt: 1_000,
          },
        ],
      }),
    );

    const records = await new PersistentQueue(file).recoverable();

    expect(records).toHaveLength(1);
    expect(records[0]!.messages).toHaveLength(2);
    expect(records[0]!.messages[0]).toMatchObject({ messageId: 'm1' });
    expect(records[0]!.messages[0]).not.toHaveProperty('senderName');
    expect(records[0]!.messages[0]).not.toHaveProperty('rootId');
    expect(records[0]!.messages[0]).not.toHaveProperty('threadId');
    expect(records[0]!.messages[0]).not.toHaveProperty('replyToMessageId');
    expect(records[0]!.messages[1]).toMatchObject({
      messageId: 'm2',
      senderName: 'Sender Name',
      rootId: 'root-1',
      threadId: 'thread-1',
      replyToMessageId: 'reply-1',
    });
  });

  test('persists messages with non-json raw data without throwing', async () => {
    const file = queueFile();
    const queue = new PersistentQueue(file);
    const message = msg('m1');
    const raw: Record<string, unknown> = {
      safe: { nested: 'value' },
      list: ['kept', 1, undefined, () => 'drop', BigInt(1)],
      bigint: BigInt(2),
      fn: () => 'drop',
    };
    raw.self = raw;
    message.raw = raw;

    await expect(queue.enqueue('scope-a', [message], { id: 'record-1', now: 1_000 })).resolves.toMatchObject({
      id: 'record-1',
    });

    const recovered = await new PersistentQueue(file).recoverable();
    const recoveredRaw = recovered[0]!.messages[0]!.raw as Record<string, unknown>;
    expect(recovered).toHaveLength(1);
    expect(recoveredRaw.safe).toEqual({ nested: 'value' });
    expect(recoveredRaw).not.toHaveProperty('self');
    expect(recoveredRaw).not.toHaveProperty('bigint');
    expect(recoveredRaw).not.toHaveProperty('fn');
    expect(recoveredRaw.list).toEqual(['kept', 1]);
    expect(() => JSON.stringify(recovered)).not.toThrow();
  });
});

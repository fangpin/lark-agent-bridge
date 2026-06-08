import { dirname } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { NormalizedMessage } from '@larksuiteoapi/node-sdk';

interface FakeHandle {
  path: string;
  writeFile: ReturnType<typeof vi.fn>;
  sync: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

const fs = vi.hoisted(() => ({
  handles: [] as FakeHandle[],
  mkdir: vi.fn(),
  open: vi.fn(),
  readFile: vi.fn(),
  rename: vi.fn(),
  rm: vi.fn(),
}));

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  mkdir: fs.mkdir,
  open: fs.open,
  readFile: fs.readFile,
  rename: fs.rename,
  rm: fs.rm,
}));

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
    mentionedBot: true,
    createTime: 1_000,
    raw: { event: { message: { message_id: id } } },
  } as NormalizedMessage;
}

function makeHandle(path: string): FakeHandle {
  const handle: FakeHandle = {
    path,
    writeFile: vi.fn().mockResolvedValue(undefined),
    sync: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
  fs.handles.push(handle);
  return handle;
}

function tmpHandle(): FakeHandle {
  const handle = fs.handles.find((entry) => entry.path.includes('.tmp-'));
  if (!handle) throw new Error('missing temporary file handle');
  return handle;
}

function dirHandle(dir: string): FakeHandle {
  const handle = fs.handles.find((entry) => entry.path === dir);
  if (!handle) throw new Error('missing directory handle');
  return handle;
}

describe('PersistentQueue filesystem writes', () => {
  beforeEach(() => {
    fs.handles.length = 0;
    vi.resetModules();
    vi.clearAllMocks();
    fs.mkdir.mockResolvedValue(undefined);
    fs.readFile.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    fs.open.mockImplementation(async (path: string) => makeHandle(path));
    fs.rename.mockResolvedValue(undefined);
    fs.rm.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('syncs the file before rename and syncs the directory after rename', async () => {
    const file = '/tmp/persistent-queue-fs/queue.json';
    const dir = dirname(file);
    const { PersistentQueue } = await import('../../src/bot/persistent-queue');

    await expect(new PersistentQueue(file).enqueue('scope-a', [msg('m1')], { id: 'record-1', now: 1_000 })).resolves.toMatchObject({
      id: 'record-1',
    });

    const temp = tmpHandle();
    const directory = dirHandle(dir);
    expect(temp.writeFile).toHaveBeenCalledWith(expect.stringContaining('"record-1"'));
    expect(temp.sync).toHaveBeenCalledTimes(1);
    expect(temp.close).toHaveBeenCalledTimes(1);
    expect(fs.rename).toHaveBeenCalledWith(temp.path, file);
    expect(directory.sync).toHaveBeenCalledTimes(1);
    expect(directory.close).toHaveBeenCalledTimes(1);
    expect(temp.sync.mock.invocationCallOrder[0]).toBeLessThan(fs.rename.mock.invocationCallOrder[0]!);
    expect(fs.rename.mock.invocationCallOrder[0]).toBeLessThan(directory.sync.mock.invocationCallOrder[0]!);
    expect(fs.rm).not.toHaveBeenCalled();
  });

  test('logs and tolerates directory sync failures after rename', async () => {
    const file = '/tmp/persistent-queue-fs/queue.json';
    const dir = dirname(file);
    fs.open.mockImplementation(async (path: string) => {
      const handle = makeHandle(path);
      if (path === dir) {
        handle.sync.mockRejectedValue(new Error('dir fsync failed'));
      }
      return handle;
    });
    const [{ PersistentQueue }, { log }] = await Promise.all([
      import('../../src/bot/persistent-queue'),
      import('../../src/core/logger'),
    ]);
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);

    await expect(new PersistentQueue(file).enqueue('scope-a', [msg('m1')], { id: 'record-1', now: 1_000 })).resolves.toMatchObject({
      id: 'record-1',
    });

    const directory = dirHandle(dir);
    expect(fs.rename).toHaveBeenCalledWith(tmpHandle().path, file);
    expect(directory.sync).toHaveBeenCalledTimes(1);
    expect(directory.close).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      'queue',
      'persistent-dir-fsync-failed',
      expect.objectContaining({ dir, err: 'dir fsync failed' }),
    );
    expect(fs.rm).not.toHaveBeenCalled();
  });

  test('removes the temporary file when rename fails after writing and syncing', async () => {
    const file = '/tmp/persistent-queue-fs/queue.json';
    fs.rename.mockRejectedValue(new Error('rename failed'));
    const { PersistentQueue } = await import('../../src/bot/persistent-queue');

    await expect(new PersistentQueue(file).enqueue('scope-a', [msg('m1')], { id: 'record-1', now: 1_000 })).rejects.toThrow(
      'rename failed',
    );

    const temp = tmpHandle();
    expect(temp.writeFile).toHaveBeenCalledTimes(1);
    expect(temp.sync).toHaveBeenCalledTimes(1);
    expect(temp.close).toHaveBeenCalledTimes(1);
    expect(fs.rm).toHaveBeenCalledWith(temp.path, { force: true });
  });

  test('temp cleanup errors do not mask write failures', async () => {
    const file = '/tmp/persistent-queue-fs/queue.json';
    fs.rename.mockRejectedValue(new Error('rename failed'));
    fs.rm.mockRejectedValue(new Error('cleanup failed'));
    const [{ PersistentQueue }, { log }] = await Promise.all([
      import('../../src/bot/persistent-queue'),
      import('../../src/core/logger'),
    ]);
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);

    await expect(new PersistentQueue(file).enqueue('scope-a', [msg('m1')], { id: 'record-1', now: 1_000 })).rejects.toThrow(
      'rename failed',
    );

    expect(fs.rm).toHaveBeenCalledWith(tmpHandle().path, { force: true });
    expect(warn).toHaveBeenCalledWith(
      'queue',
      'persistent-temp-cleanup-failed',
      expect.objectContaining({ err: 'cleanup failed' }),
    );
  });
});

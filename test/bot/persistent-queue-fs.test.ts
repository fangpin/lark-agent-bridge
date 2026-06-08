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
  stat: vi.fn(),
}));

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  mkdir: fs.mkdir,
  open: fs.open,
  readFile: fs.readFile,
  rename: fs.rename,
  rm: fs.rm,
  stat: fs.stat,
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

function nonLockRmCalls(): unknown[][] {
  return fs.rm.mock.calls.filter(([path]) => !String(path).endsWith('.lock') && !String(path).endsWith('.lock.reap'));
}

describe('PersistentQueue filesystem writes', () => {
  beforeEach(() => {
    fs.handles.length = 0;
    vi.resetModules();
    vi.clearAllMocks();
    fs.mkdir.mockResolvedValue(undefined);
    fs.readFile.mockImplementation(async (path: string) => {
      if (String(path).startsWith('/proc/')) {
        throw Object.assign(new Error('missing proc stat'), { code: 'ENOENT' });
      }
      if (String(path).endsWith('.lock') || String(path).endsWith('.lock.reap')) {
        const matchingLocks = fs.handles.filter((entry) => entry.path === path);
        const lock = matchingLocks[matchingLocks.length - 1];
        const raw = lock?.writeFile.mock.calls.at(-1)?.[0];
        return typeof raw === 'string' ? raw : '';
      }
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    });
    fs.open.mockImplementation(async (path: string) => makeHandle(path));
    fs.rename.mockResolvedValue(undefined);
    fs.rm.mockResolvedValue(undefined);
    fs.stat.mockImplementation(async (path: string) => {
      if (String(path).endsWith('.lock.reap')) {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      }
      return { dev: 1, ino: 1, size: 1, mtimeMs: Date.now() - 60_000 };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('returns an empty recoverable list and logs when reading an existing file fails', async () => {
    const file = '/tmp/persistent-queue-fs/queue.json';
    const readError = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    fs.readFile.mockRejectedValue(readError);
    const [{ PersistentQueue }, { log }] = await Promise.all([
      import('../../src/bot/persistent-queue'),
      import('../../src/core/logger'),
    ]);
    const fail = vi.spyOn(log, 'fail').mockImplementation(() => undefined);

    await expect(new PersistentQueue(file).recoverable()).resolves.toEqual([]);

    expect(fail).toHaveBeenCalledWith(
      'queue',
      readError,
      expect.objectContaining({ step: 'persistent-read' }),
    );
    expect(fs.mkdir).not.toHaveBeenCalled();
    expect(fs.open).not.toHaveBeenCalled();
    expect(fs.rename).not.toHaveBeenCalled();
    expect(nonLockRmCalls()).toEqual([]);
  });

  test('rejects mutation read failures without writing or replacing the queue file', async () => {
    const file = '/tmp/persistent-queue-fs/queue.json';
    fs.readFile.mockRejectedValue(Object.assign(new Error('permission denied'), { code: 'EACCES' }));
    const { PersistentQueue } = await import('../../src/bot/persistent-queue');

    await expect(new PersistentQueue(file).enqueue('scope-a', [msg('m1')], { id: 'record-1', now: 1_000 })).rejects.toThrow(
      `persistent queue read failed: ${file}`,
    );

    expect(fs.mkdir).toHaveBeenCalledWith(dirname(file), { recursive: true });
    expect(fs.open).toHaveBeenCalledWith(`${file}.lock`, 'wx');
    expect(fs.rename).not.toHaveBeenCalled();
    expect(nonLockRmCalls()).toEqual([]);
  });

  test('uses a unique temporary path for each write', async () => {
    const file = '/tmp/persistent-queue-fs/queue.json';
    const { PersistentQueue } = await import('../../src/bot/persistent-queue');
    const queue = new PersistentQueue(file, () => 1_000);

    await queue.enqueue('scope-a', [msg('m1')], { id: 'record-1', now: 1_000 });
    await queue.enqueue('scope-a', [msg('m2')], { id: 'record-2', now: 1_000 });
    await queue.enqueue('scope-a', [msg('m3')], { id: 'record-3', now: 1_000 });

    const tmpPaths = fs.open.mock.calls
      .map(([path]) => path as string)
      .filter((path) => path.includes('.tmp-'));
    expect(tmpPaths).toHaveLength(3);
    expect(new Set(tmpPaths).size).toBe(3);
    expect(fs.rename.mock.calls.map(([tmpPath]) => tmpPath)).toEqual(tmpPaths);
    expect(nonLockRmCalls()).toEqual([]);
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
    expect(nonLockRmCalls()).toEqual([]);
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
    expect(nonLockRmCalls()).toEqual([]);
  });

  test('logs and tolerates directory close failures after successful sync', async () => {
    const file = '/tmp/persistent-queue-fs/queue.json';
    const dir = dirname(file);
    fs.open.mockImplementation(async (path: string) => {
      const handle = makeHandle(path);
      if (path === dir) {
        handle.close.mockRejectedValue(new Error('dir close failed'));
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
      'persistent-dir-close-failed',
      expect.objectContaining({ dir, err: 'dir close failed' }),
    );
    expect(nonLockRmCalls()).toEqual([]);
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

  test('removes the lock file when acquisition writes fail after creating it', async () => {
    const file = '/tmp/persistent-queue-fs/queue.json';
    const lockError = new Error('lock write failed');
    fs.open.mockImplementation(async (path: string) => {
      const handle = makeHandle(path);
      if (path === `${file}.lock`) {
        handle.writeFile.mockRejectedValue(lockError);
      }
      return handle;
    });
    const { PersistentQueue } = await import('../../src/bot/persistent-queue');

    await expect(new PersistentQueue(file).enqueue('scope-a', [msg('m1')], { id: 'record-1', now: 1_000 })).rejects.toThrow(
      'lock write failed',
    );

    const lock = fs.handles.find((entry) => entry.path === `${file}.lock`);
    expect(lock?.close).toHaveBeenCalledTimes(1);
    expect(fs.rm).toHaveBeenCalledWith(`${file}.lock`, { force: true });
    expect(fs.rename).not.toHaveBeenCalled();
  });

  test('does not remove a lock file with a different owner token on release', async () => {
    const file = '/tmp/persistent-queue-fs/queue.json';
    fs.readFile.mockImplementation(async (path: string) => {
      if (String(path).startsWith('/proc/')) {
        throw Object.assign(new Error('missing proc stat'), { code: 'ENOENT' });
      }
      if (path === `${file}.lock`) {
        return JSON.stringify({ pid: 999, token: 'different-owner', createdAt: 1 });
      }
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    });
    const [{ PersistentQueue }, { log }] = await Promise.all([
      import('../../src/bot/persistent-queue'),
      import('../../src/core/logger'),
    ]);
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);

    await expect(new PersistentQueue(file).enqueue('scope-a', [msg('m1')], { id: 'record-1', now: 1_000 })).resolves.toMatchObject({
      id: 'record-1',
    });

    expect(fs.rm).not.toHaveBeenCalledWith(`${file}.lock`, { force: true });
    expect(warn).toHaveBeenCalledWith(
      'queue',
      'persistent-lock-owner-mismatch',
      expect.objectContaining({ lockFile: `${file}.lock` }),
    );
  });

  test('acquires the reaper lock before removing and replacing a dead stale lock', async () => {
    const file = '/tmp/persistent-queue-fs/queue.json';
    const lockPath = `${file}.lock`;
    const reapPath = `${lockPath}.reap`;
    const staleLock = JSON.stringify({ pid: 99_999_999, token: 'dead', createdAt: 1 });
    const files = new Map<string, string>([[lockPath, staleLock]]);
    fs.readFile.mockImplementation(async (path: string) => {
      if (String(path).startsWith('/proc/')) {
        throw Object.assign(new Error('missing proc stat'), { code: 'ENOENT' });
      }
      const value = files.get(path);
      if (value !== undefined) return value;
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    });
    fs.open.mockImplementation(async (path: string, flags?: string) => {
      if (flags === 'wx' && files.has(path)) {
        throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      }
      const handle = makeHandle(path);
      handle.writeFile.mockImplementation(async (data: string) => {
        files.set(path, data);
      });
      return handle;
    });
    fs.rm.mockImplementation(async (path: string) => {
      if (path !== lockPath || files.get(path) === staleLock) {
        files.delete(path);
      }
    });
    const originalKill = process.kill;
    vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
      if (pid === 99_999_999) {
        throw Object.assign(new Error('missing process'), { code: 'ESRCH' });
      }
      return originalKill(pid, signal as NodeJS.Signals | number | undefined);
    }) as typeof process.kill);
    const { PersistentQueue } = await import('../../src/bot/persistent-queue');

    await expect(new PersistentQueue(file, () => 1_000, { staleLockMs: 1 }).enqueue('scope-a', [msg('m1')], { id: 'record-1', now: 1_000 })).resolves.toMatchObject({
      id: 'record-1',
    });

    const reapOpenOrder = fs.open.mock.invocationCallOrder[fs.open.mock.calls.findIndex(([path]) => path === reapPath)];
    const lockRemoveCallIndex = fs.rm.mock.calls.findIndex(([path]) => path === lockPath);
    const lockRemoveOrder = fs.rm.mock.invocationCallOrder[lockRemoveCallIndex];
    const mainLockReacquireIndex = fs.open.mock.calls.findIndex(([path], index) => (
      path === lockPath && fs.open.mock.invocationCallOrder[index]! > lockRemoveOrder!
    ));
    const mainLockReacquireOrder = fs.open.mock.invocationCallOrder[mainLockReacquireIndex];
    const reapRemoveIndex = fs.rm.mock.calls.findIndex(([path], index) => (
      path === reapPath && fs.rm.mock.invocationCallOrder[index]! > mainLockReacquireOrder!
    ));
    const reapRemoveOrder = fs.rm.mock.invocationCallOrder[reapRemoveIndex];
    expect(reapOpenOrder).toBeLessThan(lockRemoveOrder!);
    expect(lockRemoveOrder).toBeLessThan(mainLockReacquireOrder!);
    expect(mainLockReacquireOrder).toBeLessThan(reapRemoveOrder!);
  });
});

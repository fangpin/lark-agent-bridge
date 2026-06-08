import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { NormalizedMessage } from '@larksuiteoapi/node-sdk';
import { paths } from '../config/paths';
import { log } from '../core/logger';

export type PersistentQueueState = 'queued' | 'running';

export interface PersistentQueueRecord {
  id: string;
  scope: string;
  messages: NormalizedMessage[];
  state: PersistentQueueState;
  createdAt: number;
  updatedAt: number;
}

interface PersistentQueueFile {
  version: 1;
  records: PersistentQueueRecord[];
}

export interface PersistentQueueOptions {
  lockTimeoutMs?: number;
  lockPollMs?: number;
  staleLockMs?: number;
}

const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_LOCK_POLL_MS = 50;
const DEFAULT_STALE_LOCK_MS = 60_000;

type LockIdentity = Pick<Stats, 'dev' | 'ino' | 'size' | 'mtimeMs'>;

interface ParsedLockFile {
  pid?: number;
  token?: string;
  createdAt?: number;
  procStartTime?: string;
}

interface LockCandidate {
  raw: string;
  lock: ParsedLockFile | undefined;
  identity: LockIdentity;
}

function clonePlainData<T>(value: T): T {
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => clonePlainData(item)) as T;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, clonePlainData(item)]),
    ) as T;
  }
  return value;
}

function toJsonSafe(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    return undefined;
  }
  if (typeof value !== 'object') return undefined;
  if (seen.has(value)) return undefined;

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.flatMap((item) => {
        const safe = toJsonSafe(item, seen);
        return safe === undefined ? [] : [safe];
      });
    }

    return Object.fromEntries(
      Object.entries(value).flatMap(([key, item]) => {
        const safe = toJsonSafe(item, seen);
        return safe === undefined ? [] : [[key, safe]];
      }),
    );
  } finally {
    seen.delete(value);
  }
}

function cloneMessage(msg: NormalizedMessage): NormalizedMessage {
  return {
    ...msg,
    resources: clonePlainData(msg.resources),
    mentions: clonePlainData(msg.mentions),
    raw: toJsonSafe(msg.raw),
  } as NormalizedMessage;
}

function cloneRecord(record: PersistentQueueRecord): PersistentQueueRecord {
  return {
    ...record,
    messages: record.messages.map((msg) => cloneMessage(msg)),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isState(value: unknown): value is PersistentQueueState {
  return value === 'queued' || value === 'running';
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    return true;
  }
}

function parseProcStartTime(statContent: string): string | undefined {
  const endOfCommand = statContent.lastIndexOf(')');
  if (endOfCommand === -1) return undefined;
  const fieldsAfterCommand = statContent.slice(endOfCommand + 2).trim().split(/\s+/);
  return fieldsAfterCommand[19];
}

async function readProcStartTime(pid: number): Promise<string | undefined> {
  try {
    return parseProcStartTime(await readFile(`/proc/${pid}/stat`, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return undefined;
  }
}

function parseLockFile(raw: string): ParsedLockFile | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
  if (!isObject(parsed)) return undefined;
  return {
    pid: typeof parsed.pid === 'number' && Number.isFinite(parsed.pid) ? parsed.pid : undefined,
    token: typeof parsed.token === 'string' ? parsed.token : undefined,
    createdAt: typeof parsed.createdAt === 'number' && Number.isFinite(parsed.createdAt) ? parsed.createdAt : undefined,
    procStartTime: typeof parsed.procStartTime === 'string' ? parsed.procStartTime : undefined,
  };
}

function lockIdentity(stats: Stats): LockIdentity {
  return {
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
  };
}

function sameLockIdentity(left: LockIdentity, right: LockIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs;
}

function sameLockCandidate(left: LockCandidate, right: LockCandidate): boolean {
  return sameLockIdentity(left.identity, right.identity) && left.raw === right.raw;
}

type ResourceDescriptor = NormalizedMessage['resources'][number];
type MentionInfo = NormalizedMessage['mentions'][number];

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function isOptionalNumber(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value));
}

function isOptionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === 'boolean';
}

function normalizeResource(value: unknown): ResourceDescriptor | undefined {
  if (!isObject(value)) return undefined;
  if (
    value.type !== 'image' &&
    value.type !== 'file' &&
    value.type !== 'audio' &&
    value.type !== 'video' &&
    value.type !== 'sticker'
  ) return undefined;
  if (typeof value.fileKey !== 'string') return undefined;
  if (!isOptionalString(value.fileName)) return undefined;
  if (!isOptionalNumber(value.durationMs)) return undefined;
  if (!isOptionalString(value.coverImageKey)) return undefined;

  return clonePlainData(value as unknown as ResourceDescriptor);
}

function normalizeMention(value: unknown): MentionInfo | undefined {
  if (!isObject(value)) return undefined;
  if (typeof value.key !== 'string') return undefined;
  if (!isOptionalString(value.openId)) return undefined;
  if (!isOptionalString(value.userId)) return undefined;
  if (!isOptionalString(value.name)) return undefined;
  if (!isOptionalBoolean(value.isBot)) return undefined;

  return clonePlainData(value as unknown as MentionInfo);
}

function normalizeMessage(value: unknown): NormalizedMessage | undefined {
  if (!isObject(value)) return undefined;
  if (typeof value.messageId !== 'string') return undefined;
  if (typeof value.chatId !== 'string') return undefined;
  if (value.chatType !== 'p2p' && value.chatType !== 'group') return undefined;
  if (typeof value.senderId !== 'string') return undefined;
  if (typeof value.content !== 'string') return undefined;
  if (typeof value.rawContentType !== 'string') return undefined;
  if (!Array.isArray(value.resources)) return undefined;
  if (!Array.isArray(value.mentions)) return undefined;
  if (typeof value.mentionAll !== 'boolean') return undefined;
  if (typeof value.mentionedBot !== 'boolean') return undefined;
  if (typeof value.createTime !== 'number' || !Number.isFinite(value.createTime)) return undefined;

  const message: NormalizedMessage = {
    messageId: value.messageId,
    chatId: value.chatId,
    chatType: value.chatType,
    senderId: value.senderId,
    content: value.content,
    rawContentType: value.rawContentType,
    resources: value.resources.flatMap((resource) => {
      const normalized = normalizeResource(resource);
      return normalized === undefined ? [] : [normalized];
    }),
    mentions: value.mentions.flatMap((mention) => {
      const normalized = normalizeMention(mention);
      return normalized === undefined ? [] : [normalized];
    }),
    mentionAll: value.mentionAll,
    mentionedBot: value.mentionedBot,
    createTime: value.createTime,
    raw: toJsonSafe(value.raw),
  } as NormalizedMessage;

  if (typeof value.senderName === 'string') message.senderName = value.senderName;
  if (typeof value.rootId === 'string') message.rootId = value.rootId;
  if (typeof value.threadId === 'string') message.threadId = value.threadId;
  if (typeof value.replyToMessageId === 'string') message.replyToMessageId = value.replyToMessageId;

  return message;
}

function normalizeRecord(value: unknown): PersistentQueueRecord | undefined {
  if (!isObject(value)) return undefined;
  if (typeof value.id !== 'string') return undefined;
  if (typeof value.scope !== 'string') return undefined;
  if (!Array.isArray(value.messages)) return undefined;
  if (!isState(value.state)) return undefined;
  if (typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt)) return undefined;
  if (typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt)) return undefined;

  const messages = value.messages.flatMap((message) => {
    const normalized = normalizeMessage(message);
    return normalized === undefined ? [] : [normalized];
  });
  if (messages.length === 0) return undefined;

  return {
    id: value.id,
    scope: value.scope,
    messages,
    state: value.state,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function makeId(now: number): string {
  return `queue-${now.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function makeUniqueId(now: number, records: PersistentQueueRecord[]): string {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const id = makeId(now);
    if (!records.some((record) => record.id === id)) return id;
  }
  throw new Error('persistent queue could not generate unique id');
}

const mutationTails = new Map<string, Promise<unknown>>();

export class PersistentQueue {
  private readonly lockKey: string;
  private readonly lockFile: string;
  private readonly reapFile: string;
  private readonly lockTimeoutMs: number;
  private readonly lockPollMs: number;
  private readonly staleLockMs: number;
  private lockToken: string | undefined;

  constructor(
    private readonly file: string = paths.persistentQueueFile,
    private readonly now: () => number = Date.now,
    options: PersistentQueueOptions = {},
  ) {
    this.lockKey = resolve(file);
    this.lockFile = `${this.lockKey}.lock`;
    this.reapFile = `${this.lockFile}.reap`;
    this.lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    this.lockPollMs = options.lockPollMs ?? DEFAULT_LOCK_POLL_MS;
    this.staleLockMs = options.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
  }

  async enqueue(
    scope: string,
    messages: NormalizedMessage[],
    opts: { id?: string; now?: number } = {},
  ): Promise<PersistentQueueRecord> {
    return this.mutate(async () => {
      const records = await this.readRecordsForMutation();
      const timestamp = opts.now ?? this.now();
      const id = opts.id ?? makeUniqueId(timestamp, records);
      if (records.some((record) => record.id === id)) {
        throw new Error(`persistent queue id already exists: ${id}`);
      }
      const record: PersistentQueueRecord = {
        id,
        scope,
        messages: messages.map((msg) => cloneMessage(msg)),
        state: 'queued',
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      records.push(record);
      await this.writeRecords(records);
      return cloneRecord(record);
    });
  }

  async markRunning(
    id: string,
    opts: { now?: number } = {},
  ): Promise<PersistentQueueRecord | undefined> {
    return this.mutate(async () => {
      const records = await this.readRecordsForMutation();
      const record = records.find((entry) => entry.id === id);
      if (!record) return undefined;
      record.state = 'running';
      record.updatedAt = opts.now ?? this.now();
      await this.writeRecords(records);
      return cloneRecord(record);
    });
  }

  async complete(id: string): Promise<boolean> {
    return this.mutate(async () => {
      const records = await this.readRecordsForMutation();
      const index = records.findIndex((record) => record.id === id);
      if (index === -1) return false;
      records.splice(index, 1);
      await this.writeRecords(records);
      return true;
    });
  }

  async has(id: string): Promise<boolean> {
    const records = await this.readRecords();
    return records.some((record) => record.id === id);
  }

  async cancelScope(scope: string): Promise<number> {
    return this.cancelScopeExcept(scope, new Set());
  }

  async cancelScopeExcept(scope: string, keepIds: ReadonlySet<string>): Promise<number> {
    return this.mutate(async () => {
      const records = await this.readRecordsForMutation();
      const next = records.filter((record) => record.scope !== scope || keepIds.has(record.id));
      const removed = records.length - next.length;
      if (removed === 0) return 0;
      await this.writeRecords(next);
      return removed;
    });
  }

  async recoverable(): Promise<PersistentQueueRecord[]> {
    const records = await this.readRecords();
    return [...records]
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      .map((record) => cloneRecord(record));
  }

  private async mutate<T>(fn: () => Promise<T>): Promise<T> {
    const previous = mutationTails.get(this.lockKey) ?? Promise.resolve();
    const run = previous.then(() => this.withFileLock(fn), () => this.withFileLock(fn));
    const tail = run.catch(() => undefined);
    mutationTails.set(this.lockKey, tail);
    tail.finally(() => {
      if (mutationTails.get(this.lockKey) === tail) {
        mutationTails.delete(this.lockKey);
      }
    });
    return run;
  }

  private async withFileLock<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquireFileLock();
    try {
      return await fn();
    } finally {
      await this.releaseFileLock();
    }
  }

  private async acquireFileLock(): Promise<void> {
    const startedAt = Date.now();
    const lockDir = dirname(this.lockFile);
    await mkdir(lockDir, { recursive: true });

    while (true) {
      if (!(await this.reapLockExists())) {
        try {
          await this.createMainLock();
          return;
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code !== 'EEXIST') throw err;
          if (await this.tryRecoverStaleLockAndAcquire()) return;
        }
      }

      if (Date.now() - startedAt >= this.lockTimeoutMs) {
        throw new Error(`persistent queue lock timeout: ${this.file}`);
      }
      await delay(Math.max(1, this.lockPollMs));
    }
  }

  private async createLockFile(lockFile: string, token: string): Promise<void> {
    const handle = await open(lockFile, 'wx');
    let opErr: unknown;
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, token, createdAt: Date.now(), procStartTime: await readProcStartTime(process.pid) }));
      await handle.sync();
    } catch (err) {
      opErr = err;
    }

    try {
      await handle.close();
    } catch (closeErr) {
      log.warn('queue', 'persistent-lock-close-failed', {
        lockFile,
        err: closeErr instanceof Error ? closeErr.message : String(closeErr),
      });
      opErr ??= closeErr;
    }

    if (opErr) {
      try {
        await rm(lockFile, { force: true });
      } catch (cleanupErr) {
        log.warn('queue', 'persistent-lock-acquire-cleanup-failed', {
          lockFile,
          err: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
        });
      }
      throw opErr;
    }
  }

  private async createMainLock(): Promise<void> {
    const token = randomBytes(16).toString('hex');
    await this.createLockFile(this.lockFile, token);
    this.lockToken = token;
  }

  private async reapLockExists(): Promise<boolean> {
    try {
      await stat(this.reapFile);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      return true;
    }
  }

  private async readLockCandidate(): Promise<LockCandidate | undefined> {
    try {
      const [raw, stats] = await Promise.all([
        readFile(this.lockFile, 'utf8'),
        stat(this.lockFile),
      ]);
      return {
        raw,
        lock: parseLockFile(raw),
        identity: lockIdentity(stats),
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      return undefined;
    }
  }

  private async isProvablyDeadStaleLockCandidate(candidate: LockCandidate, now: number): Promise<boolean> {
    const ageMs = now - candidate.identity.mtimeMs;
    if (ageMs < this.staleLockMs) return false;

    const pid = candidate.lock?.pid;
    if (pid === undefined) return false;
    if (!isPidAlive(pid)) return true;

    const lockedProcStartTime = candidate.lock?.procStartTime;
    if (!lockedProcStartTime) return false;
    const currentProcStartTime = await readProcStartTime(pid);
    return currentProcStartTime !== undefined && currentProcStartTime !== lockedProcStartTime;
  }

  private async tryRecoverStaleLockAndAcquire(): Promise<boolean> {
    let reapAcquired = false;
    try {
      await this.createLockFile(this.reapFile, randomBytes(16).toString('hex'));
      reapAcquired = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
      log.warn('queue', 'persistent-reaper-lock-acquire-failed', {
        reapFile: this.reapFile,
        err: err instanceof Error ? err.message : String(err),
      });
      return false;
    }

    try {
      const candidate = await this.readLockCandidate();
      if (!candidate || !(await this.isProvablyDeadStaleLockCandidate(candidate, Date.now()))) return false;

      const current = await this.readLockCandidate();
      if (!current || !sameLockCandidate(candidate, current)) return false;

      try {
        await rm(this.lockFile);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          log.warn('queue', 'persistent-stale-lock-remove-failed', {
            lockFile: this.lockFile,
            err: err instanceof Error ? err.message : String(err),
          });
          return false;
        }
      }

      try {
        await this.createMainLock();
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        return false;
      }
    } finally {
      if (reapAcquired) {
        try {
          await rm(this.reapFile, { force: true });
        } catch (err) {
          log.warn('queue', 'persistent-reaper-lock-release-failed', {
            reapFile: this.reapFile,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }

  private async releaseFileLock(): Promise<void> {
    const token = this.lockToken;
    if (!token) return;

    try {
      const raw = await readFile(this.lockFile, 'utf8');
      let lock: unknown;
      try {
        lock = JSON.parse(raw) as unknown;
      } catch {
        lock = raw;
      }
      const lockToken = isObject(lock) && typeof lock.token === 'string' ? lock.token : raw;
      if (lockToken !== token) {
        log.warn('queue', 'persistent-lock-owner-mismatch', { lockFile: this.lockFile });
        return;
      }
      await rm(this.lockFile, { force: true });
    } catch (err) {
      log.warn('queue', 'persistent-lock-release-failed', {
        lockFile: this.lockFile,
        err: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.lockToken = undefined;
    }
  }

  private async readRecords(): Promise<PersistentQueueRecord[]> {
    return this.readRecordsFromFile(false);
  }

  private async readRecordsForMutation(): Promise<PersistentQueueRecord[]> {
    return this.readRecordsFromFile(true);
  }

  private async readRecordsFromFile(strict: boolean): Promise<PersistentQueueRecord[]> {
    let raw: string;
    try {
      raw = await readFile(this.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      log.fail('queue', err, { step: 'persistent-read' });
      if (strict) throw new Error(`persistent queue read failed: ${this.file}`);
      return [];
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (err) {
      log.fail('queue', err, { step: 'persistent-read' });
      if (strict) throw new Error(`persistent queue parse failed: ${this.file}`);
      return [];
    }

    if (!isObject(parsed) || parsed.version !== 1 || !Array.isArray(parsed.records)) {
      const err = new Error('persistent queue file is malformed');
      log.fail('queue', err, { step: 'persistent-read' });
      if (strict) throw new Error(`persistent queue file is malformed: ${this.file}`);
      return [];
    }

    const seenIds = new Set<string>();
    return parsed.records.flatMap((record): PersistentQueueRecord[] => {
      const normalized = normalizeRecord(record);
      if (!normalized) return [];
      if (seenIds.has(normalized.id)) {
        log.fail('queue', new Error('persistent queue duplicate record id skipped'), {
          recordId: normalized.id,
          step: 'persistent-read-record',
        });
        return [];
      }
      seenIds.add(normalized.id);
      try {
        return [cloneRecord(normalized)];
      } catch (err) {
        log.fail('queue', err, { step: 'persistent-read-record' });
        return [];
      }
    });
  }

  private async writeRecords(records: PersistentQueueRecord[]): Promise<void> {
    const data: PersistentQueueFile = {
      version: 1,
      records: records.map((record) => cloneRecord(record)),
    };
    const dir = dirname(this.file);
    await mkdir(dir, { recursive: true });
    const tmpFile = `${this.file}.tmp-${process.pid}-${Date.now()}-${randomBytes(8).toString('hex')}`;
    let renamed = false;
    try {
      const handle = await open(tmpFile, 'w');
      let opErr: unknown;
      try {
        await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`);
        await handle.sync();
      } catch (err) {
        opErr = err;
        throw err;
      } finally {
        try {
          await handle.close();
        } catch (closeErr) {
          log.warn('queue', 'persistent-temp-close-failed', {
            tmpFile,
            err: closeErr instanceof Error ? closeErr.message : String(closeErr),
          });
          if (!opErr) throw closeErr;
        }
      }
      await rename(tmpFile, this.file);
      renamed = true;
      await this.fsyncDirectory(dir);
    } finally {
      if (!renamed) {
        try {
          await rm(tmpFile, { force: true });
        } catch (err) {
          log.warn('queue', 'persistent-temp-cleanup-failed', {
            tmpFile,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }

  private async fsyncDirectory(dir: string): Promise<void> {
    let handle;
    try {
      handle = await open(dir, 'r');
      await handle.sync();
    } catch (err) {
      log.warn('queue', 'persistent-dir-fsync-failed', { dir, err: err instanceof Error ? err.message : String(err) });
    } finally {
      try {
        await handle?.close();
      } catch (err) {
        log.warn('queue', 'persistent-dir-close-failed', { dir, err: err instanceof Error ? err.message : String(err) });
      }
    }
  }
}

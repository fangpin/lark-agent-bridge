import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
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

function cloneMessage(msg: NormalizedMessage): NormalizedMessage {
  return {
    ...msg,
    resources: clonePlainData(msg.resources),
    mentions: clonePlainData(msg.mentions),
    raw: clonePlainData(msg.raw),
  };
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

function isMessage(value: unknown): value is NormalizedMessage {
  if (!isObject(value)) return false;
  return (
    typeof value.messageId === 'string' &&
    typeof value.chatId === 'string' &&
    typeof value.chatType === 'string' &&
    typeof value.senderId === 'string' &&
    typeof value.content === 'string' &&
    typeof value.rawContentType === 'string' &&
    Array.isArray(value.resources) &&
    Array.isArray(value.mentions) &&
    typeof value.mentionAll === 'boolean' &&
    typeof value.mentionedBot === 'boolean' &&
    typeof value.createTime === 'number' &&
    Number.isFinite(value.createTime)
  );
}

function isRecord(value: unknown): value is PersistentQueueRecord {
  if (!isObject(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.scope === 'string' &&
    Array.isArray(value.messages) &&
    value.messages.every(isMessage) &&
    isState(value.state) &&
    typeof value.createdAt === 'number' &&
    Number.isFinite(value.createdAt) &&
    typeof value.updatedAt === 'number' &&
    Number.isFinite(value.updatedAt)
  );
}

function makeId(now: number): string {
  return `queue-${now.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

const mutationTails = new Map<string, Promise<unknown>>();

export class PersistentQueue {
  constructor(
    private readonly file: string = paths.persistentQueueFile,
    private readonly now: () => number = Date.now,
  ) {}

  async enqueue(
    scope: string,
    messages: NormalizedMessage[],
    opts: { id?: string; now?: number } = {},
  ): Promise<PersistentQueueRecord> {
    return this.mutate(async () => {
      const records = await this.readRecords();
      const timestamp = opts.now ?? this.now();
      const record: PersistentQueueRecord = {
        id: opts.id ?? makeId(timestamp),
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
      const records = await this.readRecords();
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
      const records = await this.readRecords();
      const index = records.findIndex((record) => record.id === id);
      if (index === -1) return false;
      records.splice(index, 1);
      await this.writeRecords(records);
      return true;
    });
  }

  async cancelScope(scope: string): Promise<number> {
    return this.mutate(async () => {
      const records = await this.readRecords();
      const next = records.filter((record) => record.scope !== scope);
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
    const previous = mutationTails.get(this.file) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    mutationTails.set(this.file, run.catch(() => undefined));
    return run;
  }

  private async readRecords(): Promise<PersistentQueueRecord[]> {
    let raw: string;
    try {
      raw = await readFile(this.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      log.fail('queue', err, { step: 'persistent-read' });
      return [];
    }

    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!isObject(parsed) || parsed.version !== 1 || !Array.isArray(parsed.records)) return [];
      return parsed.records.flatMap((record): PersistentQueueRecord[] => {
        if (!isRecord(record)) return [];
        try {
          return [cloneRecord(record)];
        } catch (err) {
          log.fail('queue', err, { step: 'persistent-read-record' });
          return [];
        }
      });
    } catch (err) {
      log.fail('queue', err, { step: 'persistent-read' });
      return [];
    }
  }

  private async writeRecords(records: PersistentQueueRecord[]): Promise<void> {
    const data: PersistentQueueFile = {
      version: 1,
      records: records.map((record) => cloneRecord(record)),
    };
    await mkdir(dirname(this.file), { recursive: true });
    const tmpFile = `${this.file}.tmp-${process.pid}-${Date.now()}-${randomBytes(4).toString('hex')}`;
    await writeFile(tmpFile, `${JSON.stringify(data, null, 2)}\n`);
    await rename(tmpFile, this.file);
  }
}

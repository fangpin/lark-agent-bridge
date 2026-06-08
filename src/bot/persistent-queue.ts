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

function isRecord(value: unknown): value is PersistentQueueRecord {
  if (!isObject(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.scope === 'string' &&
    Array.isArray(value.messages) &&
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
  }

  async markRunning(
    id: string,
    opts: { now?: number } = {},
  ): Promise<PersistentQueueRecord | undefined> {
    const records = await this.readRecords();
    const record = records.find((entry) => entry.id === id);
    if (!record) return undefined;
    record.state = 'running';
    record.updatedAt = opts.now ?? this.now();
    await this.writeRecords(records);
    return cloneRecord(record);
  }

  async complete(id: string): Promise<boolean> {
    const records = await this.readRecords();
    const next = records.filter((record) => record.id !== id);
    if (next.length === records.length) return false;
    await this.writeRecords(next);
    return true;
  }

  async cancelScope(scope: string): Promise<number> {
    const records = await this.readRecords();
    const next = records.filter((record) => record.scope !== scope);
    const removed = records.length - next.length;
    if (removed === 0) return 0;
    await this.writeRecords(next);
    return removed;
  }

  async recoverable(): Promise<PersistentQueueRecord[]> {
    const records = await this.readRecords();
    return [...records]
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      .map((record) => cloneRecord(record));
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
      return parsed.records.filter(isRecord).map((record) => cloneRecord(record));
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
    const tmpFile = `${this.file}.tmp-${process.pid}`;
    await writeFile(tmpFile, `${JSON.stringify(data, null, 2)}\n`);
    await rename(tmpFile, this.file);
  }
}

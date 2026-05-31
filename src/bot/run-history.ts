import type { NormalizedMessage } from '@larksuiteoapi/node-sdk';
import type { AgentDescriptor } from '../agent/types';
import type { Terminal } from '../card/run-state';

const MAX_RUNS = 50;
const TTL_MS = 6 * 60 * 60 * 1000;

export interface RunHistoryCreateMeta {
  cwd: string;
  agent: AgentDescriptor;
  summary: string;
}

export interface RunHistoryUpdate {
  streamMessageId?: string;
  summary?: string;
}

export interface RunHistoryEntry {
  runId: string;
  scope: string;
  chatId: string;
  threadId?: string;
  batch: NormalizedMessage[];
  cwd: string;
  agent: AgentDescriptor;
  summary: string;
  createdAt: number;
  updatedAt: number;
  terminal: Terminal;
  errorMsg?: string;
  streamMessageId?: string;
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

export class RunHistory {
  private readonly entries = new Map<string, RunHistoryEntry>();
  private nextId = 1;

  create(scope: string, batch: NormalizedMessage[], meta: RunHistoryCreateMeta): RunHistoryEntry {
    const first = batch[0];
    const now = Date.now();
    const entry: RunHistoryEntry = {
      runId: `run-${now.toString(36)}-${this.nextId++}`,
      scope,
      chatId: first?.chatId ?? '',
      threadId: first?.threadId,
      batch: batch.map((msg) => cloneMessage(msg)),
      cwd: meta.cwd,
      agent: { ...meta.agent },
      summary: meta.summary,
      createdAt: now,
      updatedAt: now,
      terminal: 'running',
    };
    this.entries.set(entry.runId, entry);
    this.prune(now);
    return this.cloneEntry(entry);
  }

  update(runId: string, update: RunHistoryUpdate): void {
    const entry = this.entries.get(runId);
    if (!entry) return;
    if (update.streamMessageId !== undefined) entry.streamMessageId = update.streamMessageId;
    if (update.summary !== undefined) entry.summary = update.summary;
    entry.updatedAt = Date.now();
  }

  finish(runId: string, terminal: Terminal, errorMsg?: string): void {
    const entry = this.entries.get(runId);
    if (!entry) return;
    entry.terminal = terminal;
    entry.errorMsg = errorMsg;
    entry.updatedAt = Date.now();
  }

  get(runId: string): RunHistoryEntry | undefined {
    this.prune(Date.now());
    const entry = this.entries.get(runId);
    if (!entry) return undefined;
    return this.cloneEntry(entry);
  }

  list(scope: string, limit = 10): RunHistoryEntry[] {
    this.prune(Date.now());
    return Array.from(this.entries.values())
      .filter((entry) => entry.scope === scope)
      .sort((a, b) => b.createdAt - a.createdAt || this.runSequence(b.runId) - this.runSequence(a.runId))
      .slice(0, Math.max(0, limit))
      .map((entry) => this.cloneEntry(entry));
  }

  private cloneEntry(entry: RunHistoryEntry): RunHistoryEntry {
    return {
      ...entry,
      agent: { ...entry.agent },
      batch: entry.batch.map((msg) => cloneMessage(msg)),
    };
  }

  private runSequence(runId: string): number {
    return Number(runId.slice(runId.lastIndexOf('-') + 1));
  }

  private prune(now: number): void {
    for (const [id, entry] of this.entries) {
      if (now - entry.updatedAt > TTL_MS) this.entries.delete(id);
    }
    while (this.entries.size > MAX_RUNS) {
      const oldest = this.entries.keys().next().value;
      if (!oldest) break;
      this.entries.delete(oldest);
    }
  }
}

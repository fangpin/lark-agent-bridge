import type { NormalizedMessage } from '@larksuiteoapi/node-sdk';
import type { Terminal } from '../card/run-state';

const MAX_RUNS = 50;
const TTL_MS = 6 * 60 * 60 * 1000;

export interface RunHistoryEntry {
  runId: string;
  scope: string;
  chatId: string;
  threadId?: string;
  batch: NormalizedMessage[];
  createdAt: number;
  updatedAt: number;
  terminal: Terminal;
  errorMsg?: string;
}

export class RunHistory {
  private readonly entries = new Map<string, RunHistoryEntry>();
  private nextId = 1;

  create(scope: string, batch: NormalizedMessage[]): RunHistoryEntry {
    const first = batch[0];
    const now = Date.now();
    const entry: RunHistoryEntry = {
      runId: `run-${now.toString(36)}-${this.nextId++}`,
      scope,
      chatId: first?.chatId ?? '',
      threadId: first?.threadId,
      batch: batch.map((msg) => ({ ...msg })),
      createdAt: now,
      updatedAt: now,
      terminal: 'running',
    };
    this.entries.set(entry.runId, entry);
    this.prune(now);
    return entry;
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
    return { ...entry, batch: entry.batch.map((msg) => ({ ...msg })) };
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

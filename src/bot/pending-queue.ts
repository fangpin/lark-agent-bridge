import type { NormalizedMessage } from '@larksuiteoapi/node-sdk';
import { log } from '../core/logger';

interface PendingBatch {
  messages: NormalizedMessage[];
  durableId?: string;
}

interface PendingEntry {
  batches: PendingBatch[];
  timer?: NodeJS.Timeout;
}

export type FlushHandler = (scope: string, batch: NormalizedMessage[], durableId?: string) => void;

export interface PendingPushOptions {
  durableId?: string;
}

/**
 * Per-scope pending queue. `scope` is the session scope string (typically
 * `chatId` for p2p / regular group, `chatId:threadId` for topic groups).
 * When `delayMs` is positive, it accumulates messages within a quiet window;
 * when `delayMs` is zero, it flushes immediately.
 *
 * `block(scope)` pauses the debounce timer while an agent run is active on
 * that scope — pushed messages still accumulate but no flush fires until
 * `unblock(scope)`, which arms a fresh quiet window.
 *
 * Commands should bypass this queue — they're cheap and should be responsive.
 */
export class PendingQueue {
  private readonly map = new Map<string, PendingEntry>();
  private readonly blocked = new Set<string>();
  private readonly delayMs: number;
  private readonly onFlush: FlushHandler;

  constructor(delayMs: number, onFlush: FlushHandler) {
    this.delayMs = delayMs;
    this.onFlush = onFlush;
  }

  push(scope: string, msg: NormalizedMessage, opts: PendingPushOptions = {}): number {
    return this.pushBatch(scope, [msg], opts);
  }

  pushBatch(scope: string, messages: NormalizedMessage[], opts: PendingPushOptions = {}): number {
    let entry = this.map.get(scope);
    if (!entry) {
      entry = { batches: [] };
      this.map.set(scope, entry);
    } else if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }

    const lastBatch = entry.batches.at(-1);
    if (lastBatch && lastBatch.durableId === opts.durableId) {
      lastBatch.messages.push(...messages);
    } else {
      if (entry.batches.length > 0 && !this.blocked.has(scope)) {
        this.flush(scope);
        entry = this.map.get(scope);
        if (!entry) {
          entry = { batches: [] };
          this.map.set(scope, entry);
        }
      }
      entry.batches.push({ messages: [...messages], durableId: opts.durableId });
    }

    const size = this.queuedSize(scope);
    entry.timer = this.blocked.has(scope) ? undefined : this.scheduleFlush(scope);
    return size;
  }

  cancel(scope: string): NormalizedMessage[] {
    const entry = this.map.get(scope);
    if (!entry) return [];
    if (entry.timer) clearTimeout(entry.timer);
    this.map.delete(scope);
    return entry.batches.flatMap((batch) => batch.messages);
  }

  queuedSize(scope: string): number {
    return this.map.get(scope)?.batches.reduce((total, batch) => total + batch.messages.length, 0) ?? 0;
  }

  cancelAll(): void {
    for (const entry of this.map.values()) {
      if (entry.timer) clearTimeout(entry.timer);
    }
    this.map.clear();
    this.blocked.clear();
  }

  /** Pause the debounce timer; pushed messages keep accumulating. */
  block(scope: string): void {
    if (this.blocked.has(scope)) return;
    this.blocked.add(scope);
    const entry = this.map.get(scope);
    if (entry?.timer) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }
    log.info('queue', 'blocked', { scope, queued: this.queuedSize(scope) });
  }

  /** Resume the debounce timer; arms a fresh quiet window if anything queued. */
  unblock(scope: string): void {
    if (!this.blocked.has(scope)) return;
    this.blocked.delete(scope);
    const entry = this.map.get(scope);
    log.info('queue', 'unblocked', { scope, queued: this.queuedSize(scope) });
    if (!entry || entry.batches.length === 0) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = this.scheduleFlush(scope);
  }

  private scheduleFlush(scope: string): NodeJS.Timeout | undefined {
    if (this.delayMs <= 0) {
      this.flush(scope);
      return undefined;
    }
    return setTimeout(() => this.flush(scope), this.delayMs);
  }

  private flush(scope: string): void {
    const entry = this.map.get(scope);
    if (!entry) return;

    const batch = entry.batches.shift();
    if (!batch) {
      this.map.delete(scope);
      return;
    }

    if (entry.batches.length === 0) {
      this.map.delete(scope);
    }

    try {
      this.onFlush(scope, batch.messages, batch.durableId);
    } catch (err) {
      log.fail('queue', err, { scope, batchSize: batch.messages.length });
    }

    if (entry.batches.length > 0 && !this.blocked.has(scope)) {
      entry.timer = this.scheduleFlush(scope);
    }
  }
}

import type { NormalizedMessage } from '@larksuiteoapi/node-sdk';
import { log } from '../core/logger';

interface PendingEntry {
  messages: NormalizedMessage[];
  timer?: NodeJS.Timeout;
  durableId?: string;
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
    const existing = this.map.get(scope);
    if (existing) {
      if (existing.timer) clearTimeout(existing.timer);
      existing.messages.push(...messages);
      existing.durableId ??= opts.durableId;
      existing.timer = this.blocked.has(scope) ? undefined : this.scheduleFlush(scope);
      return existing.messages.length;
    }
    const entry: PendingEntry = { messages: [...messages], durableId: opts.durableId };
    this.map.set(scope, entry);
    if (this.blocked.has(scope)) {
      entry.timer = undefined;
    } else if (this.delayMs <= 0 && opts.durableId && messages.length === 1) {
      entry.timer = setTimeout(() => this.flush(scope), 0);
    } else {
      entry.timer = this.scheduleFlush(scope);
    }
    return entry.messages.length;
  }

  cancel(scope: string): NormalizedMessage[] {
    const entry = this.map.get(scope);
    if (!entry) return [];
    if (entry.timer) clearTimeout(entry.timer);
    this.map.delete(scope);
    return entry.messages;
  }

  queuedSize(scope: string): number {
    return this.map.get(scope)?.messages.length ?? 0;
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
    log.info('queue', 'blocked', { scope, queued: entry?.messages.length ?? 0 });
  }

  /** Resume the debounce timer; arms a fresh quiet window if anything queued. */
  unblock(scope: string): void {
    if (!this.blocked.has(scope)) return;
    this.blocked.delete(scope);
    const entry = this.map.get(scope);
    log.info('queue', 'unblocked', { scope, queued: entry?.messages.length ?? 0 });
    if (!entry || entry.messages.length === 0) return;
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
    this.map.delete(scope);
    try {
      this.onFlush(scope, entry.messages, entry.durableId);
    } catch (err) {
      log.fail('queue', err, { scope, batchSize: entry.messages.length });
    }
  }
}

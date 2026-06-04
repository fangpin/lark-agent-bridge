import { log } from '../core/logger';

interface QueueEntry<T> {
  item: T;
  worker: (item: T) => Promise<void>;
}

interface ScopeQueue<T> {
  entries: Array<QueueEntry<T>>;
  running: boolean;
  idleResolvers: Array<() => void>;
}

export class CommentQueue<T = unknown> {
  private readonly queues = new Map<string, ScopeQueue<T>>();

  push(scope: string, item: T, worker: (item: T) => Promise<void>): number {
    const queue = this.queueFor(scope);
    queue.entries.push({ item, worker });
    this.drain(scope, queue);
    return queue.entries.length + (queue.running ? 1 : 0);
  }

  cancelAll(): number {
    let dropped = 0;
    for (const queue of this.queues.values()) {
      dropped += queue.entries.length;
      queue.entries = [];
    }
    return dropped;
  }

  async drainAll(): Promise<void> {
    await Promise.all([...this.queues.values()].map((queue) => this.waitForIdle(queue)));
  }

  private queueFor(scope: string): ScopeQueue<T> {
    let queue = this.queues.get(scope);
    if (!queue) {
      queue = { entries: [], running: false, idleResolvers: [] };
      this.queues.set(scope, queue);
    }
    return queue;
  }

  private drain(scope: string, queue: ScopeQueue<T>): void {
    if (queue.running) return;
    const next = queue.entries.shift();
    if (!next) {
      const resolvers = queue.idleResolvers.splice(0);
      resolvers.forEach((resolve) => resolve());
      return;
    }
    queue.running = true;
    void next.worker(next.item)
      .catch((err) => log.fail('comment-queue', err, { scope }))
      .finally(() => {
        queue.running = false;
        this.drain(scope, queue);
      });
  }

  private waitForIdle(queue: ScopeQueue<T>): Promise<void> {
    if (!queue.running && queue.entries.length === 0) return Promise.resolve();
    return new Promise((resolve) => queue.idleResolvers.push(resolve));
  }
}

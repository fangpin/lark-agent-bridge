import { describe, expect, test, vi } from 'vitest';
import { CommentQueue } from '../../src/bot/comment-queue';

describe('CommentQueue', () => {
  test('runs same-scope comments sequentially', async () => {
    const queue = new CommentQueue<string>();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    queue.push('doc:a', 'first', async (item) => {
      order.push(`start:${item}`);
      await firstBlocked;
      order.push(`end:${item}`);
    });
    queue.push('doc:a', 'second', async (item) => {
      order.push(`start:${item}`);
      order.push(`end:${item}`);
    });

    await vi.waitFor(() => expect(order).toEqual(['start:first']));
    releaseFirst();
    await queue.drainAll();

    expect(order).toEqual(['start:first', 'end:first', 'start:second', 'end:second']);
  });

  test('runs different scopes in parallel', async () => {
    const queue = new CommentQueue<string>();
    const started: string[] = [];
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });

    queue.push('doc:a', 'a', async (item) => {
      started.push(item);
      await blocked;
    });
    queue.push('doc:b', 'b', async (item) => {
      started.push(item);
    });

    await vi.waitFor(() => expect(started).toEqual(['a', 'b']));
    release();
    await queue.drainAll();
  });

  test('cancelAll drops pending comments but lets running work finish', async () => {
    const queue = new CommentQueue<string>();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    queue.push('doc:a', 'first', async (item) => {
      order.push(item);
      await firstBlocked;
    });
    queue.push('doc:a', 'second', async (item) => {
      order.push(item);
    });

    await vi.waitFor(() => expect(order).toEqual(['first']));
    expect(queue.cancelAll()).toBe(1);
    releaseFirst();
    await queue.drainAll();

    expect(order).toEqual(['first']);
  });
});

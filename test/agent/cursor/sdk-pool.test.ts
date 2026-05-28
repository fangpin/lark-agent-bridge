import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  cachedSessionReadyEvent,
  CursorSdkPool,
  doneEventForAgent,
  poolKeyFor,
} from '../../../src/agent/cursor/sdk-pool';
import type { AgentEvent, AgentRun } from '../../../src/agent/types';

afterEach(() => {
  vi.useRealTimers();
});

describe('poolKeyFor', () => {
  test('uses only session id for reusable workers', () => {
    expect(
      poolKeyFor({
        prompt: 'hi',
        cwd: '/tmp/ws',
        sessionId: 'sess-1',
        poolKey: 'chat-abc',
      }),
    ).toBe('session:sess-1');

    expect(
      poolKeyFor({
        prompt: 'hi',
        cwd: '/tmp/other-ws',
        sessionId: 'sess-1',
        poolKey: 'chat-other',
      }),
    ).toBe('session:sess-1');
  });

  test('does not reuse workers by scope key without a session id', () => {
    const key = poolKeyFor({
      prompt: 'hi',
      cwd: '/tmp/ws',
      poolKey: 'chat-abc',
    });

    expect(key.startsWith('ephemeral:')).toBe(true);
  });

  test('generates ephemeral key when neither session nor scope is set', () => {
    const key = poolKeyFor({ prompt: 'hi', cwd: '/tmp/ws' });
    expect(key.startsWith('ephemeral:')).toBe(true);
  });

  test('preserves worker done agent id as a session event', () => {
    expect(doneEventForAgent('agent-123')).toEqual({ type: 'done', sessionId: 'agent-123' });
    expect(doneEventForAgent()).toEqual({ type: 'done' });
  });

  test('emits a cached-session ready event for reused workers', () => {
    expect(cachedSessionReadyEvent('agent-123')).toEqual({
      type: 'system',
      sessionId: 'agent-123',
    });
    expect(cachedSessionReadyEvent()).toBeUndefined();
  });

  test('records agent id without evicting an entry already keyed by that session', () => {
    const pool = new CursorSdkPool(
      { command: 'agent', prefixArgs: [], commandLabel: 'agent' },
      { model: { id: 'gpt-5.5' } },
      1,
    );
    const shutdown = vi.fn(async () => {});
    const entry = {
      key: 'session:agent-123',
      agentId: undefined as string | undefined,
      worker: {
        pid: 123,
        ensure: async () => 'agent-123',
        run: () =>
          ({
            events: (async function* () {})(),
            stop: async () => {},
            waitForExit: async () => true,
          }) satisfies AgentRun,
        stopRun: () => {},
        shutdown,
      },
      cwd: '/tmp/ws',
      lastUsed: Date.now(),
      busy: false,
      pendingRuns: 0,
    };
    const entries = (
      pool as unknown as {
        entries: Map<string, typeof entry>;
      }
    ).entries;
    entries.set(entry.key, entry);

    pool.noteSessionId({ prompt: 'hi', cwd: '/tmp/ws', sessionId: 'agent-123' }, 'agent-123');

    expect(entries.get('session:agent-123')).toBe(entry);
    expect(entry.agentId).toBe('agent-123');
    expect(shutdown).not.toHaveBeenCalled();
  });

  test('prefixes reused worker output with a ready system event', async () => {
    const pool = new CursorSdkPool(
      { command: 'agent', prefixArgs: [], commandLabel: 'agent' },
      { model: { id: 'gpt-5.5' } },
      1,
    );
    const run = vi.fn((_, __, skipEnsure: boolean) => {
      expect(skipEnsure).toBe(true);
      return {
        events: (async function* () {
          yield { type: 'text', delta: 'hello' } as const;
          yield { type: 'done' } as const;
        })(),
        stop: async () => {},
        waitForExit: async () => true,
      } satisfies AgentRun;
    });
    const entry = {
      key: 'session:agent-123',
      agentId: 'agent-123',
      worker: {
        pid: 123,
        ensure: async () => 'agent-123',
        run,
        stopRun: () => {},
        shutdown: async () => {},
      },
      cwd: '/tmp/ws',
      lastUsed: Date.now(),
      busy: false,
      pendingRuns: 0,
    };
    const entries = (
      pool as unknown as {
        entries: Map<string, typeof entry>;
      }
    ).entries;
    entries.set(entry.key, entry);

    const result = pool.run({ prompt: 'hi', cwd: '/tmp/ws', sessionId: 'agent-123' });
    const seen: AgentEvent[] = [];
    for await (const event of result.events) {
      seen.push(event);
    }

    expect(seen).toEqual([
      { type: 'system', sessionId: 'agent-123' },
      { type: 'text', delta: 'hello' },
      { type: 'done' },
    ]);
  });

  test('evicts a reused worker when stop does not settle the run stream', async () => {
    vi.useFakeTimers();
    const pool = new CursorSdkPool(
      { command: 'agent', prefixArgs: [], commandLabel: 'agent' },
      { model: { id: 'gpt-5.5' } },
      1,
    );
    const stop = vi.fn(async () => {});
    const shutdown = vi.fn(async () => {});
    const run = vi.fn(() => {
      return {
        events: (async function* () {
          await new Promise(() => {});
        })(),
        stop,
        waitForExit: async () => true,
      } satisfies AgentRun;
    });
    const entry = {
      key: 'session:agent-123',
      agentId: 'agent-123',
      worker: {
        pid: 123,
        ensure: async () => 'agent-123',
        run,
        stopRun: () => {},
        shutdown,
      },
      cwd: '/tmp/ws',
      lastUsed: Date.now(),
      busy: false,
      pendingRuns: 0,
      disposed: false,
    };
    const entries = (
      pool as unknown as {
        entries: Map<string, typeof entry>;
      }
    ).entries;
    entries.set(entry.key, entry);

    const result = pool.run({
      prompt: 'hi',
      cwd: '/tmp/ws',
      sessionId: 'agent-123',
      stopGraceMs: 100,
    });
    const stopping = result.stop();

    await vi.advanceTimersByTimeAsync(100);
    await stopping;

    expect(stop).toHaveBeenCalledTimes(1);
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(entries.has('session:agent-123')).toBe(false);
  });
});

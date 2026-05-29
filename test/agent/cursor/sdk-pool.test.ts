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

  test('evicts a reused worker after a non-recoverable fatal sdk run error', async () => {
    const pool = new CursorSdkPool(
      { command: 'agent', prefixArgs: [], commandLabel: 'agent' },
      { model: { id: 'gpt-5.5' } },
      1,
    );
    const shutdown = vi.fn(async () => {});
    const run = vi.fn(() => {
      return {
        events: (async function* () {
          yield {
            type: 'error',
            message: 'sdk run failed; permission denied',
            fatal: true,
          } as const;
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
        shutdown,
      },
      cwd: '/tmp/ws',
      lastUsed: Date.now(),
      busy: false,
      pendingRuns: 0,
      disposed: false,
      currentRunId: undefined as string | undefined,
      currentRunStartedAt: undefined as number | undefined,
      lastEventAt: undefined as number | undefined,
      lastError: undefined as string | undefined,
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
      {
        type: 'system',
        sessionId: 'agent-123',
      },
      {
        type: 'error',
        message: 'sdk run failed; permission denied',
        fatal: true,
      },
    ]);
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(entries.has('session:agent-123')).toBe(false);
  });

  test('resumes the original session once after a fatal worker error', async () => {
    const firstShutdown = vi.fn(async () => {});
    const secondShutdown = vi.fn(async () => {});
    const firstRun = vi.fn(() => {
      return {
        events: (async function* () {
          yield {
            type: 'error',
            message: 'sdk run failed; Cursor returned no error detail',
            fatal: true,
          } as const;
        })(),
        stop: async () => {},
        waitForExit: async () => true,
      } satisfies AgentRun;
    });
    const secondRun = vi.fn((opts) => {
      expect(opts.sessionId).toBe('agent-123');
      expect(opts.allowSessionReplacement).toBe(false);
      return {
        events: (async function* () {
          yield { type: 'system', sessionId: 'agent-123' } as const;
          yield { type: 'text', delta: 'continued' } as const;
          yield { type: 'done', sessionId: 'agent-123' } as const;
        })(),
        stop: async () => {},
        waitForExit: async () => true,
      } satisfies AgentRun;
    });
    const workers = [
      {
        pid: 123,
        ensure: async () => 'agent-123',
        run: firstRun,
        stopRun: () => {},
        shutdown: firstShutdown,
      },
      {
        pid: 456,
        ensure: async () => 'agent-123',
        run: secondRun,
        stopRun: () => {},
        shutdown: secondShutdown,
      },
    ];
    const factory = vi.fn(() => workers.shift()!);
    const pool = new CursorSdkPool(
      { command: 'agent', prefixArgs: [], commandLabel: 'agent' },
      { model: { id: 'gpt-5.5' } },
      1,
      factory,
    );

    const result = pool.run({ prompt: 'hi', cwd: '/tmp/ws', sessionId: 'agent-123' });
    const seen: AgentEvent[] = [];
    for await (const event of result.events) {
      seen.push(event);
    }

    expect(seen).toEqual([
      { type: 'system', sessionId: 'agent-123' },
      { type: 'text', delta: 'continued' },
      { type: 'done', sessionId: 'agent-123' },
    ]);
    expect(firstRun).toHaveBeenCalledTimes(1);
    expect(secondRun).toHaveBeenCalledTimes(1);
    expect(firstShutdown).toHaveBeenCalledTimes(1);
    expect(secondShutdown).not.toHaveBeenCalled();
  });

  test('reports running worker snapshots', () => {
    const pool = new CursorSdkPool(
      { command: 'agent', prefixArgs: [], commandLabel: 'agent' },
      { model: { id: 'gpt-5.5' } },
      1,
    );
    const entry = {
      key: 'session:agent-123',
      agentId: 'agent-123',
      worker: {
        pid: 123,
        ensure: async () => 'agent-123',
        run: () =>
          ({
            events: (async function* () {
              await new Promise(() => {});
            })(),
            stop: async () => {},
            waitForExit: async () => true,
          }) satisfies AgentRun,
        stopRun: () => {},
        shutdown: async () => {},
      },
      cwd: '/tmp/ws',
      lastUsed: Date.now(),
      busy: false,
      pendingRuns: 0,
      disposed: false,
      currentRunId: undefined as string | undefined,
      currentRunStartedAt: undefined as number | undefined,
      lastEventAt: undefined as number | undefined,
      lastError: undefined as string | undefined,
    };
    const entries = (
      pool as unknown as {
        entries: Map<string, typeof entry>;
      }
    ).entries;
    entries.set(entry.key, entry);

    pool.run({ prompt: 'hi', cwd: '/tmp/ws', sessionId: 'agent-123' });

    expect(pool.workerSnapshots()).toEqual([
      expect.objectContaining({
        key: 'session:agent-123',
        pid: 123,
        status: 'running',
        pendingRuns: 1,
        currentRunId: '1',
      }),
    ]);
  });
});

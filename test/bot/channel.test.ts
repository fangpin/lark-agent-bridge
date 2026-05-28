import { afterEach, describe, expect, test, vi } from 'vitest';
import type { AgentEvent, AgentRun } from '../../src/agent/types';
import type { RunHandle } from '../../src/bot/active-runs';
import { processAgentStream } from '../../src/bot/channel';
import { createInitialState } from '../../src/card/run-state';
import type { SessionStore } from '../../src/session/store';

function runWithNaturalExitAfter(timeoutNeededMs: number): {
  handle: RunHandle;
  waitTimeouts: number[];
  stopCalls: () => number;
} {
  let stopCount = 0;
  const waitTimeouts: number[] = [];
  const run: AgentRun = {
    events: (async function* (): AsyncGenerator<AgentEvent> {
      yield { type: 'done' };
    })(),
    async stop() {
      stopCount++;
    },
    async waitForExit(timeoutMs: number) {
      waitTimeouts.push(timeoutMs);
      return timeoutMs >= timeoutNeededMs;
    },
  };

  return {
    handle: { run, interrupted: false },
    waitTimeouts,
    stopCalls: () => stopCount,
  };
}

describe('processAgentStream', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test('uses the configured post-done grace before stopping a naturally finishing agent', async () => {
    const { handle, waitTimeouts, stopCalls } = runWithNaturalExitAfter(5000);
    const flushed: string[] = [];

    await processAgentStream(
      handle,
      {} as SessionStore,
      'chat-1',
      '/tmp',
      undefined,
      async (state) => {
        flushed.push(state.terminal);
      },
      5000,
    );

    expect(waitTimeouts).toEqual([5000]);
    expect(stopCalls()).toBe(0);
    expect(flushed).toContain('done');
  });

  test('persists a replacement session id from a done event', async () => {
    const setCalls: Array<{ scope: string; sessionId: string; cwd: string }> = [];
    const run: AgentRun = {
      events: (async function* (): AsyncGenerator<AgentEvent> {
        yield { type: 'done', sessionId: 'agent-new' };
      })(),
      async stop() {},
      async waitForExit() {
        return true;
      },
    };

    await processAgentStream(
      { run, interrupted: false },
      {
        set(scope: string, sessionId: string, cwd: string) {
          setCalls.push({ scope, sessionId, cwd });
        },
      } as SessionStore,
      'chat-1',
      '/tmp/project',
      undefined,
      async () => {},
      5000,
    );

    expect(setCalls).toEqual([
      { scope: 'chat-1', sessionId: 'agent-new', cwd: '/tmp/project' },
    ]);
  });

  test('renders an agent stream exception as an error state', async () => {
    const flushed: Array<{ terminal: string; errorMsg?: string }> = [];
    const run: AgentRun = {
      events: (async function* (): AsyncGenerator<AgentEvent> {
        yield { type: 'text', delta: 'working' };
        throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
      })(),
      async stop() {},
      async waitForExit() {
        return true;
      },
    };

    await processAgentStream(
      { run, interrupted: false },
      {} as SessionStore,
      'chat-1',
      '/tmp/project',
      undefined,
      async (state) => {
        flushed.push({ terminal: state.terminal, errorMsg: state.errorMsg });
      },
      5000,
    );

    expect(flushed.at(-1)).toEqual({
      terminal: 'error',
      errorMsg: expect.stringContaining('read ECONNRESET'),
    });
  });

  test('does not convert card flush failures into agent stream errors', async () => {
    let flushCalls = 0;
    const run: AgentRun = {
      events: (async function* (): AsyncGenerator<AgentEvent> {
        yield { type: 'text', delta: 'working' };
        yield { type: 'done' };
      })(),
      async stop() {},
      async waitForExit() {
        return true;
      },
    };

    await expect(
      processAgentStream(
        { run, interrupted: false },
        {} as SessionStore,
        'chat-1',
        '/tmp/project',
        undefined,
        async () => {
          flushCalls++;
          if (flushCalls === 1) throw new Error('card update failed');
        },
        5000,
      ),
    ).rejects.toThrow('card update failed');

    expect(flushCalls).toBe(1);
  });

  test('idle watchdog also terminates a silent in-flight tool call', async () => {
    vi.useFakeTimers();
    let releaseStream!: () => void;
    const streamReleased = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    const stop = vi.fn(async () => {
      releaseStream();
    });
    const flushed: string[] = [];
    const run: AgentRun = {
      events: (async function* (): AsyncGenerator<AgentEvent> {
        yield { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'bnpm publish' } };
        await streamReleased;
      })(),
      stop,
      async waitForExit() {
        return true;
      },
    };
    const handle: RunHandle = { run, interrupted: false };

    const processing = processAgentStream(
      handle,
      {} as SessionStore,
      'chat-1',
      '/tmp/project',
      1000,
      async (state) => {
        flushed.push(state.terminal);
      },
      5000,
    );

    await vi.advanceTimersByTimeAsync(1000);
    releaseStream();
    await processing;

    expect(stop).toHaveBeenCalledTimes(1);
    expect(handle.interrupted).toBe(true);
    expect(flushed.at(-1)).toBe('idle_timeout');
  });

  test('refreshes running progress while the agent is silent', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let releaseStream!: () => void;
    const streamReleased = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    const flushed: Array<{ terminal: string; lastActivityAt: number; updatedAt: number }> = [];
    const run: AgentRun = {
      events: (async function* (): AsyncGenerator<AgentEvent> {
        yield { type: 'system', sessionId: 'agent-1' };
        await streamReleased;
      })(),
      async stop() {},
      async waitForExit() {
        return true;
      },
    };

    const processing = processAgentStream(
      { run, interrupted: false },
      { set() {} } as unknown as SessionStore,
      'chat-1',
      '/tmp/project',
      undefined,
      async (state) => {
        flushed.push({
          terminal: state.terminal,
          lastActivityAt: state.lastActivityAt,
          updatedAt: state.updatedAt,
        });
      },
      5000,
      createInitialState('run-1'),
    );

    await vi.advanceTimersByTimeAsync(15_000);
    releaseStream();
    await processing;

    expect(flushed).toContainEqual({
      terminal: 'running',
      lastActivityAt: 0,
      updatedAt: 15_000,
    });
  });

  test('fails fast when the final flush hangs', async () => {
    vi.useFakeTimers();
    const run: AgentRun = {
      events: (async function* (): AsyncGenerator<AgentEvent> {
        return;
      })(),
      async stop() {},
      async waitForExit() {
        return true;
      },
    };

    const processing = processAgentStream(
      { run, interrupted: false },
      {} as SessionStore,
      'chat-1',
      '/tmp/project',
      undefined,
      async (state) => {
        if (state.terminal === 'done') await new Promise(() => {});
      },
      5000,
    );

    const rejection = expect(processing).rejects.toThrow('final-flush timed out');
    await vi.advanceTimersByTimeAsync(20_000);
    await rejection;
  });
});

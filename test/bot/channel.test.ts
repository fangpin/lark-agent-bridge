import { describe, expect, test } from 'vitest';
import type { AgentEvent, AgentRun } from '../../src/agent/types';
import type { RunHandle } from '../../src/bot/active-runs';
import { processAgentStream } from '../../src/bot/channel';
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
});

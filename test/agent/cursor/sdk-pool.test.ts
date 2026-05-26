import { describe, expect, test, vi } from 'vitest';
import { CursorSdkPool, doneEventForAgent, poolKeyFor } from '../../../src/agent/cursor/sdk-pool';
import type { AgentRun } from '../../../src/agent/types';

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
});

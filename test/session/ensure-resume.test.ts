import { describe, expect, test, vi } from 'vitest';
import type { AgentAdapter } from '../../src/agent/types';
import { ensureResumeSession } from '../../src/session/ensure-resume';
import { SessionStore } from '../../src/session/store';

function mockAgent(
  sessionKey: string,
  prepare?: (cwd: string) => Promise<string | undefined>,
  canResumeSession?: (sessionId: string) => boolean,
): AgentAdapter {
  return {
    id: sessionKey.split(':')[0] ?? sessionKey,
    sessionKey,
    displayName: sessionKey,
    commandLabel: sessionKey,
    descriptor: {
      id: sessionKey.split(':')[0] ?? sessionKey,
      label: sessionKey,
      runtime: 'test',
      sessionKey,
      commandLabel: sessionKey,
      supportsRetry: true,
      supportsWorkers: false,
    },
    isAvailable: async () => true,
    run: () => {
      throw new Error('not used');
    },
    prepareSession: prepare,
    canResumeSession,
  };
}

describe('ensureResumeSession', () => {
  test('returns existing session for the active agent without calling prepareSession', async () => {
    const store = new SessionStore('/tmp/unused-sessions.json');
    store.set('scope-1', 'cursor:sdk', 'sess-existing', '/tmp/project');
    const prepare = vi.fn(async () => 'sess-new');
    const agent = mockAgent('cursor:sdk', prepare);

    const id = await ensureResumeSession(agent, store, 'scope-1', '/tmp/project');

    expect(id).toBe('sess-existing');
    expect(prepare).not.toHaveBeenCalled();
  });

  test('does not return another agent backend session', async () => {
    const store = new SessionStore('/tmp/unused-sessions-2.json');
    store.set('scope-2', 'cursor:sdk', 'cursor-session', '/tmp/project');
    const agent = mockAgent('claude', async () => 'claude-session');

    const id = await ensureResumeSession(agent, store, 'scope-2', '/tmp/project');

    expect(id).toBe('claude-session');
    expect(store.resumeFor('scope-2', '/tmp/project', 'cursor:sdk')).toBe('cursor-session');
    expect(store.resumeFor('scope-2', '/tmp/project', 'claude')).toBe('claude-session');
  });

  test('pre-creates and stores a session when missing for active agent', async () => {
    const store = new SessionStore('/tmp/unused-sessions-3.json');
    const agent = mockAgent('cursor:sdk', async () => 'sess-new');

    const id = await ensureResumeSession(agent, store, 'scope-3', '/tmp/project');

    expect(id).toBe('sess-new');
    expect(store.resumeFor('scope-3', '/tmp/project', 'cursor:sdk')).toBe('sess-new');
  });

  test('does not pre-create sessions for agents that support streaming fresh runs', async () => {
    const store = new SessionStore('/tmp/unused-sessions-3b.json');
    const prepare = vi.fn(async () => 'sess-new');
    const agent = mockAgent('cursor:cli', prepare);

    const id = await ensureResumeSession(agent, store, 'scope-3b', '/tmp/project', { precreate: false });

    expect(id).toBeUndefined();
    expect(prepare).not.toHaveBeenCalled();
    expect(store.resumeFor('scope-3b', '/tmp/project', 'cursor:cli')).toBeUndefined();
  });

  test('replaces only the active agent session that the agent cannot resume', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = new SessionStore('/tmp/unused-sessions-4.json');
    store.set('scope-4', 'cursor:sdk', 'legacy-cli-session', '/tmp/project');
    store.set('scope-4', 'claude', 'claude-session', '/tmp/project');
    const agent = mockAgent('cursor:sdk', async () => 'agent-sdk-session', (sessionId) =>
      sessionId.startsWith('agent-'),
    );

    try {
      const id = await ensureResumeSession(agent, store, 'scope-4', '/tmp/project');

      expect(id).toBe('agent-sdk-session');
      expect(store.resumeFor('scope-4', '/tmp/project', 'cursor:sdk')).toBe('agent-sdk-session');
      expect(store.resumeFor('scope-4', '/tmp/project', 'claude')).toBe('claude-session');
    } finally {
      warn.mockRestore();
    }
  });
});

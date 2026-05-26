import { describe, expect, test, vi } from 'vitest';
import type { AgentAdapter } from '../../src/agent/types';
import { ensureResumeSession } from '../../src/session/ensure-resume';
import { SessionStore } from '../../src/session/store';

function mockAgent(
  prepare?: (cwd: string) => Promise<string | undefined>,
  canResumeSession?: (sessionId: string) => boolean,
): AgentAdapter {
  return {
    id: 'cursor',
    displayName: 'Cursor',
    commandLabel: 'agent',
    isAvailable: async () => true,
    run: () => {
      throw new Error('not used');
    },
    prepareSession: prepare,
    canResumeSession,
  };
}

describe('ensureResumeSession', () => {
  test('returns existing session without calling prepareSession', async () => {
    const store = new SessionStore('/tmp/unused-sessions.json');
    store.set('scope-1', 'sess-existing', '/tmp/project');
    const prepare = async () => 'sess-new';
    const agent = mockAgent(prepare);

    const id = await ensureResumeSession(agent, store, 'scope-1', '/tmp/project');

    expect(id).toBe('sess-existing');
  });

  test('pre-creates and stores a session when missing', async () => {
    const store = new SessionStore('/tmp/unused-sessions-2.json');
    const agent = mockAgent(async () => 'sess-new');

    const id = await ensureResumeSession(agent, store, 'scope-2', '/tmp/project');

    expect(id).toBe('sess-new');
    expect(store.resumeFor('scope-2', '/tmp/project')).toBe('sess-new');
  });

  test('replaces an existing session that the agent cannot resume', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = new SessionStore('/tmp/unused-sessions-3.json');
    store.set('scope-3', 'legacy-cli-session', '/tmp/project');
    const agent = mockAgent(async () => 'agent-sdk-session', (sessionId) =>
      sessionId.startsWith('agent-'),
    );

    try {
      const id = await ensureResumeSession(agent, store, 'scope-3', '/tmp/project');

      expect(id).toBe('agent-sdk-session');
      expect(store.resumeFor('scope-3', '/tmp/project')).toBe('agent-sdk-session');
    } finally {
      warn.mockRestore();
    }
  });
});

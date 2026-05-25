import { describe, expect, test } from 'vitest';
import type { AgentAdapter } from '../../src/agent/types';
import { ensureResumeSession } from '../../src/session/ensure-resume';
import { SessionStore } from '../../src/session/store';

function mockAgent(prepare?: (cwd: string) => Promise<string | undefined>): AgentAdapter {
  return {
    id: 'cursor',
    displayName: 'Cursor',
    commandLabel: 'agent',
    isAvailable: async () => true,
    run: () => {
      throw new Error('not used');
    },
    prepareSession: prepare,
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
});

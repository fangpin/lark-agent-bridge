import type { AgentAdapter } from '../agent/types';
import { log } from '../core/logger';
import type { SessionStore } from './store';

/**
 * Return a resumable Cursor session id for this scope/cwd. When none exists,
 * ask the agent backend to pre-create one so the next spawn can use --resume.
 */
export async function ensureResumeSession(
  agent: AgentAdapter,
  sessions: SessionStore,
  scope: string,
  cwd: string,
): Promise<string | undefined> {
  const existing = sessions.resumeFor(scope, cwd);
  if (existing) return existing;
  if (!agent.prepareSession) return undefined;

  const sessionId = await agent.prepareSession(cwd);
  if (!sessionId) {
    log.warn('session', 'precreate-failed', { scope, cwd });
    return undefined;
  }

  sessions.set(scope, sessionId, cwd);
  log.info('session', 'precreate', { scope, cwd, sessionId });
  return sessionId;
}

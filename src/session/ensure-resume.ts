import type { AgentAdapter } from '../agent/types';
import { log } from '../core/logger';
import type { SessionStore } from './store';

export interface EnsureResumeSessionOptions {
  precreate?: boolean;
}

export async function ensureResumeSession(
  agent: AgentAdapter,
  sessions: SessionStore,
  scope: string,
  cwd: string,
  opts: EnsureResumeSessionOptions = {},
): Promise<string | undefined> {
  const sessionKey = agent.sessionKey;
  const existing = sessions.resumeFor(scope, cwd, sessionKey);
  if (existing) {
    if (agent.canResumeSession?.(existing) === false) {
      log.warn('session', 'resume-incompatible', { scope, cwd, sessionId: existing, sessionKey });
      sessions.clear(scope, sessionKey);
    } else {
      return existing;
    }
  }
  if (opts.precreate === false || !agent.prepareSession) return undefined;

  const sessionId = await agent.prepareSession(cwd, scope);
  if (!sessionId) {
    log.warn('session', 'precreate-failed', { scope, cwd, sessionKey });
    return undefined;
  }

  sessions.set(scope, sessionKey, sessionId, cwd);
  log.info('session', 'precreate', { scope, cwd, sessionId, sessionKey });
  return sessionId;
}

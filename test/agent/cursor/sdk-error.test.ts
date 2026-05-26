import { describe, expect, test } from 'vitest';
import {
  describeSdkError,
  formatSdkErrorForIpc,
  isCursorAgentNotFoundError,
} from '../../../src/agent/cursor/sdk-error';

describe('describeSdkError', () => {
  test('classifies nested authentication errors', () => {
    const auth = Object.assign(new Error('invalid key'), {
      name: 'AuthenticationError',
      code: 'unauthenticated',
    });
    const connect = Object.assign(new Error('Error'), {
      name: 'ConnectError',
      rawMessage: 'Error',
      code: 2,
      cause: auth,
    });

    const d = describeSdkError(connect);
    expect(d.kind).toBe('auth');
    expect(d.headline).toContain('鉴权');
    expect(d.detail).toContain('ConnectError');
    expect(d.detail).toContain('AuthenticationError');
    expect(d.hint).toContain('CURSOR_API_KEY');
  });

  test('formatSdkErrorForIpc includes phase and hint', () => {
    const err = Object.assign(new Error('unauthenticated'), { code: 'unauthenticated' });
    const msg = formatSdkErrorForIpc('sdk run failed', err);
    expect(msg).toContain('sdk run failed:');
    expect(msg).toContain('CURSOR_API_KEY');
  });

  test('detects stale Cursor SDK agent ids that cannot be resumed', () => {
    const err = Object.assign(new Error('Agent agent-stale not found'), {
      name: 'ConfigurationError',
      operation: 'Agent.resume',
      isRetryable: false,
    });

    expect(isCursorAgentNotFoundError(err, 'agent-stale')).toBe(true);
    expect(isCursorAgentNotFoundError(err, 'agent-other')).toBe(false);
    expect(isCursorAgentNotFoundError(new Error('Cannot use this model'), 'agent-stale')).toBe(false);
  });
});

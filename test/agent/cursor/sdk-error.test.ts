import { describe, expect, test } from 'vitest';
import { describeSdkError, formatSdkErrorForIpc } from '../../../src/agent/cursor/sdk-error';

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
});

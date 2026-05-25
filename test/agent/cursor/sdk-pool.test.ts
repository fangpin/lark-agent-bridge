import { describe, expect, test } from 'vitest';
import { poolKeyFor } from '../../../src/agent/cursor/sdk-pool';

describe('poolKeyFor', () => {
  test('prefers session id over scope key', () => {
    expect(
      poolKeyFor({
        prompt: 'hi',
        cwd: '/tmp/ws',
        sessionId: 'sess-1',
        poolKey: 'chat-abc',
      }),
    ).toBe('/tmp/ws::session:sess-1');
  });

  test('uses scope key when no session id', () => {
    expect(
      poolKeyFor({
        prompt: 'hi',
        cwd: '/tmp/ws',
        poolKey: 'chat-abc',
      }),
    ).toBe('/tmp/ws::scope:chat-abc');
  });

  test('generates ephemeral key when neither session nor scope is set', () => {
    const key = poolKeyFor({ prompt: 'hi', cwd: '/tmp/ws' });
    expect(key.startsWith('/tmp/ws::ephemeral:')).toBe(true);
  });
});

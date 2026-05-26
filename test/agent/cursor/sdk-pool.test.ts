import { describe, expect, test } from 'vitest';
import { doneEventForAgent, poolKeyFor } from '../../../src/agent/cursor/sdk-pool';

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
});

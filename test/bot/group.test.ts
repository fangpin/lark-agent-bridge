import { describe, expect, test, vi } from 'vitest';
import { backendChatName, backendLabel, nameWithBackend, renameChatForBackend } from '../../src/bot/group';

describe('backend chat naming', () => {
  test('uses backend labels in generated chat names', () => {
    const date = new Date('2026-06-02T13:20:00+08:00');

    expect(backendChatName('codex', date)).toMatch(/ · Codex$/);
    expect(backendChatName('cursor', date)).toMatch(/ · Cursor$/);
    expect(backendChatName('claude', date)).toMatch(/ · Claude$/);
    expect(backendLabel('claude-fast')).toBe('Claude-fast');
  });

  test('appends backend label while replacing an existing backend label', () => {
    expect(nameWithBackend('Claude · Existing', 'codex')).toBe('Existing · Codex');
    expect(nameWithBackend('Existing · Claude', 'codex')).toBe('Existing · Codex');
    expect(nameWithBackend('Codex · Existing · Claude', 'cursor')).toBe('Existing · Cursor');
  });

  test('renames a chat with backend suffix while replacing an existing label', async () => {
    const update = vi.fn(async () => ({}));
    const channel = {
      rawClient: {
        im: {
          v1: {
            chat: { update },
          },
        },
      },
    };

    await renameChatForBackend(channel as never, 'chat-1', 'Claude · Existing', 'codex');

    expect(update).toHaveBeenCalledWith({
      path: { chat_id: 'chat-1' },
      data: { name: 'Existing · Codex' },
    });
  });
});

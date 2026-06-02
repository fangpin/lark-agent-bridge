import { describe, expect, test, vi } from 'vitest';
import { backendChatName, backendLabel, renameChatForBackend } from '../../src/bot/group';

describe('backend chat naming', () => {
  test('uses backend labels in generated chat names', () => {
    const date = new Date('2026-06-02T13:20:00+08:00');

    expect(backendChatName('codex', date)).toMatch(/^Codex · /);
    expect(backendChatName('cursor', date)).toMatch(/^Cursor · /);
    expect(backendChatName('claude', date)).toMatch(/^Claude · /);
    expect(backendLabel('claude-fast')).toBe('Claude-fast');
  });

  test('renames a chat with backend prefix while replacing an existing prefix', async () => {
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
      data: { name: 'Codex · Existing' },
    });
  });
});

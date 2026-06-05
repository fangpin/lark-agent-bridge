import { describe, expect, test, vi } from 'vitest';
import { tryHandleCommand, type CommandContext } from '../../src/commands';

function commandContext(content: string): CommandContext {
  const cwd = process.cwd();
  return {
    channel: { send: vi.fn(async () => ({ messageId: 'sent-1' })) },
    msg: {
      chatId: 'chat-1',
      threadId: 'thread-1',
      messageId: 'msg-1',
      senderId: 'admin',
      content,
      rawContentType: 'text',
      resources: [],
      mentions: [],
      mentionAll: false,
      mentionedBot: true,
      createTime: Date.now(),
    },
    scope: 'chat-1:thread-1',
    chatMode: 'topic',
    sessions: { clear: vi.fn(), resumeFor: vi.fn(() => undefined), set: vi.fn() },
    workspaces: {
      cwdFor: vi.fn(() => cwd),
      setCwd: vi.fn(),
    },
    agent: { sessionKey: 'fake:test', evictScope: vi.fn() },
    backendKey: 'fake',
    activeRuns: { interrupt: vi.fn(() => false) },
    controls: {
      restart: async () => undefined,
      exit: async () => undefined,
      configPath: '',
      processId: 'proc',
      cfg: { preferences: { access: { admins: ['admin'] } } },
    },
  } as unknown as CommandContext;
}

describe('topic group cwd commands', () => {
  test('/cd stores cwd on the chat scope while resetting only the topic session', async () => {
    const cwd = process.cwd();
    const ctx = commandContext(`/cd ${cwd}`);

    await expect(tryHandleCommand(ctx)).resolves.toBe(true);

    expect(ctx.workspaces.setCwd).toHaveBeenCalledWith('chat-1', cwd);
    expect(ctx.sessions.clear).toHaveBeenCalledWith('chat-1:thread-1', 'fake:test');
    expect(ctx.agent.evictScope).toHaveBeenCalledWith('chat-1:thread-1', cwd);
  });
});

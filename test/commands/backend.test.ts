import { describe, expect, test, vi } from 'vitest';
import type { AgentAdapter } from '../../src/agent/types';
import { tryHandleCommand, type CommandContext } from '../../src/commands';

function fakeAgent(key: string): AgentAdapter {
  return {
    id: key,
    sessionKey: key,
    displayName: key,
    commandLabel: key,
    descriptor: {
      id: key,
      label: key,
      runtime: 'test',
      sessionKey: key,
      commandLabel: key,
      supportsRetry: true,
      supportsWorkers: false,
    },
    isAvailable: async () => true,
    run: () => {
      throw new Error('not used');
    },
    evictScope: vi.fn(async () => undefined),
  };
}

function ctx(content: string, overrides: Partial<CommandContext> = {}): CommandContext {
  const send = vi.fn(async () => ({ messageId: 'sent-1' }));
  const update = vi.fn(async () => ({}));
  const get = vi.fn(async () => ({ data: { name: 'draft' } }));
  const agent = fakeAgent('claude');
  return {
    channel: { send, rawClient: { im: { v1: { chat: { get, update } } } } },
    msg: { chatId: 'chat-1', messageId: 'msg-1', senderId: 'admin', content, rawContentType: 'text', resources: [], mentions: [], mentionAll: false, mentionedBot: true, createTime: Date.now() },
    scope: 'chat-1',
    chatMode: 'group',
    sessions: { clear: vi.fn(), getRaw: vi.fn() },
    workspaces: { cwdFor: () => '/repo' },
    agent,
    backendKey: 'claude',
    agentRegistry: { keys: () => ['claude', 'codex'], defaultKey: () => 'claude', has: (key: string) => ['claude', 'codex'].includes(key), get: async (key: string) => fakeAgent(key), getOrDefault: async (key?: string) => fakeAgent(key ?? 'claude') },
    backendStore: { get: vi.fn(), set: vi.fn(), clear: vi.fn() },
    activeRuns: { interrupt: vi.fn(() => false) },
    controls: { restart: async () => undefined, exit: async () => undefined, configPath: '', processId: 'proc', cfg: { preferences: { access: { admins: ['admin'] } } } },
    ...overrides,
  } as unknown as CommandContext;
}

describe('/backend command', () => {
  test('lists current and available backends', async () => {
    const commandCtx = ctx('/backend');

    await expect(tryHandleCommand(commandCtx)).resolves.toBe(true);

    expect(commandCtx.channel.send).toHaveBeenCalledWith('chat-1', { markdown: expect.stringContaining('当前 backend') }, { replyTo: 'msg-1' });
  });

  test('switches backend without clearing the target backend session', async () => {
    const commandCtx = ctx('/backend codex');

    await expect(tryHandleCommand(commandCtx)).resolves.toBe(true);

    expect(commandCtx.backendStore?.set).toHaveBeenCalledWith('chat-1', 'codex');
    expect(commandCtx.sessions.clear).not.toHaveBeenCalled();
    expect(commandCtx.channel.send).toHaveBeenCalledWith('chat-1', { markdown: expect.stringContaining('已切换 backend 到 `codex`') }, { replyTo: 'msg-1' });
    expect(commandCtx.channel.send).not.toHaveBeenCalledWith('chat-1', { markdown: expect.stringContaining('session 已重置') }, { replyTo: 'msg-1' });
  });

  test('preserves the current group name when adding backend prefix', async () => {
    const commandCtx = ctx('/backend codex');

    await expect(tryHandleCommand(commandCtx)).resolves.toBe(true);

    expect(commandCtx.channel.rawClient.im.v1.chat.get).toHaveBeenCalledWith({
      path: { chat_id: 'chat-1' },
    });
    expect(commandCtx.channel.rawClient.im.v1.chat.update).toHaveBeenCalledWith({
      path: { chat_id: 'chat-1' },
      data: { name: 'Codex · draft' },
    });
  });

  test('resets to default backend', async () => {
    const commandCtx = ctx('/backend default', { backendKey: 'codex' });

    await expect(tryHandleCommand(commandCtx)).resolves.toBe(true);

    expect(commandCtx.backendStore?.clear).toHaveBeenCalledWith('chat-1');
  });

  test('rejects unknown backend keys', async () => {
    const commandCtx = ctx('/backend nope');

    await expect(tryHandleCommand(commandCtx)).resolves.toBe(true);

    expect(commandCtx.channel.send).toHaveBeenCalledWith('chat-1', { markdown: expect.stringContaining('未知 backend') }, { replyTo: 'msg-1' });
  });
});

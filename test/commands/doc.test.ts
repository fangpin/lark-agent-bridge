import { homedir } from 'node:os';
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
  const agent = fakeAgent('claude');
  const sessions = {
    clear: vi.fn(),
    getRaw: vi.fn((scope: string, sessionKey?: string) => {
      if (scope !== 'doc:doc_token_123') return undefined;
      if (sessionKey === 'codex') {
        return { sessionId: 'sess-123456789', cwd: homedir(), updatedAt: 1_000 };
      }
      return {
        updatedAt: 1_000,
        agents: {
          codex: { sessionId: 'sess-123456789', cwd: homedir(), updatedAt: 1_000 },
        },
      };
    }),
    set: vi.fn(),
  };
  return {
    channel: { send },
    msg: { chatId: 'chat-1', messageId: 'msg-1', senderId: 'admin', content, rawContentType: 'text', resources: [], mentions: [], mentionAll: false, mentionedBot: true, createTime: Date.now() },
    scope: 'chat-1',
    chatMode: 'group',
    sessions,
    workspaces: { cwdFor: vi.fn(() => undefined) },
    agent,
    backendKey: 'claude',
    agentRegistry: { keys: () => ['claude', 'codex'], defaultKey: () => 'claude', has: (key: string) => ['claude', 'codex'].includes(key), get: async (key: string) => fakeAgent(key), getOrDefault: async (key?: string) => fakeAgent(key ?? 'claude') },
    backendStore: { get: vi.fn(), set: vi.fn(), clear: vi.fn() },
    activeRuns: { interrupt: vi.fn(() => false) },
    controls: { restart: async () => undefined, exit: async () => undefined, configPath: '', processId: 'proc', cfg: { preferences: { access: { admins: ['admin'] } } } },
    ...overrides,
  } as unknown as CommandContext;
}

describe('/doc command', () => {
  test('binds a cloud doc to a backend-specific session', async () => {
    const commandCtx = ctx('/doc bind https://example.feishu.cn/docx/doc_token_123 codex sess-123456789');

    await expect(tryHandleCommand(commandCtx)).resolves.toBe(true);

    expect(commandCtx.backendStore?.set).toHaveBeenCalledWith('doc:doc_token_123', 'codex');
    expect(commandCtx.sessions.set).toHaveBeenCalledWith('doc:doc_token_123', 'codex', 'sess-123456789', homedir());
    expect(commandCtx.channel.send).toHaveBeenCalledWith('chat-1', { card: expect.any(Object) }, { replyTo: 'msg-1' });
  });

  test('shows cloud doc backend and session status', async () => {
    const backendStore = { get: vi.fn(() => 'codex'), set: vi.fn(), clear: vi.fn() };
    const commandCtx = ctx('/doc status doc_token_123', { backendStore: backendStore as never });

    await expect(tryHandleCommand(commandCtx)).resolves.toBe(true);

    const sent = vi.mocked(commandCtx.channel.send).mock.calls[0]?.[1] as { card?: object };
    const json = JSON.stringify(sent.card);
    expect(json).toContain('doc:doc_token_123');
    expect(json).toContain('codex');
    expect(json).toContain('sess-123');
  });

  test('clears cloud doc backend and saved sessions', async () => {
    const commandCtx = ctx('/doc clear doc_token_123');

    await expect(tryHandleCommand(commandCtx)).resolves.toBe(true);

    expect(commandCtx.backendStore?.clear).toHaveBeenCalledWith('doc:doc_token_123');
    expect(commandCtx.sessions.clear).toHaveBeenCalledWith('doc:doc_token_123');
  });

  test('rejects unknown backend keys', async () => {
    const commandCtx = ctx('/doc bind doc_token_123 nope sess-123456789');

    await expect(tryHandleCommand(commandCtx)).resolves.toBe(true);

    expect(commandCtx.backendStore?.set).not.toHaveBeenCalled();
    expect(commandCtx.sessions.set).not.toHaveBeenCalled();
    expect(commandCtx.channel.send).toHaveBeenCalledWith('chat-1', { markdown: expect.stringContaining('未知 backend') }, { replyTo: 'msg-1' });
  });
});

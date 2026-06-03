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
  const sessionEntries: Record<string, Record<string, { sessionId: string; cwd: string; updatedAt: number }>> = {
    'chat-1': {
      claude: { sessionId: 'chat-session-123456789', cwd: homedir(), updatedAt: 2_000 },
    },
    'doc:doc_token_123': {
      codex: { sessionId: 'sess-123456789', cwd: homedir(), updatedAt: 1_000 },
    },
  };
  const sessions = {
    clear: vi.fn(),
    getRaw: vi.fn((scope: string, sessionKey?: string) => {
      const agents = sessionEntries[scope];
      if (!agents) return undefined;
      if (sessionKey) {
        const entry = agents[sessionKey];
        return entry ? { ...entry } : undefined;
      }
      return { updatedAt: 1_000, agents };
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

  test('binds a cloud doc to the current group backend and session', async () => {
    const commandCtx = ctx('/doc bind https://example.feishu.cn/docx/doc_token_456');

    await expect(tryHandleCommand(commandCtx)).resolves.toBe(true);

    expect(commandCtx.backendStore?.clear).toHaveBeenCalledWith('doc:doc_token_456');
    expect(commandCtx.backendStore?.set).not.toHaveBeenCalled();
    expect(commandCtx.sessions.set).toHaveBeenCalledWith('doc:doc_token_456', 'claude', 'chat-session-123456789', homedir());
    expect(commandCtx.channel.send).toHaveBeenCalledWith('chat-1', { card: expect.any(Object) }, { replyTo: 'msg-1' });
  });

  test('copies the current group backend override when binding a cloud doc shortcut', async () => {
    const backendStore = {
      get: vi.fn((scope: string) => (scope === 'chat-1' ? 'codex' : undefined)),
      set: vi.fn(),
      clear: vi.fn(),
    };
    const sessions = {
      clear: vi.fn(),
      getRaw: vi.fn((scope: string, sessionKey?: string) => {
        if (scope === 'chat-1' && sessionKey === 'codex') {
          return { sessionId: 'codex-chat-session-123456789', cwd: '/tmp/project', updatedAt: 2_000 };
        }
        return undefined;
      }),
      set: vi.fn(),
    };
    const workspaces = { cwdFor: vi.fn((scope: string) => (scope === 'chat-1' ? '/tmp/project' : undefined)) };
    const commandCtx = ctx('/doc bind doc_token_456', {
      backendKey: 'codex',
      backendStore: backendStore as never,
      sessions: sessions as never,
      workspaces: workspaces as never,
    });

    await expect(tryHandleCommand(commandCtx)).resolves.toBe(true);

    expect(backendStore.set).toHaveBeenCalledWith('doc:doc_token_456', 'codex');
    expect(sessions.set).toHaveBeenCalledWith('doc:doc_token_456', 'codex', 'codex-chat-session-123456789', '/tmp/project');
  });

  test('rejects cloud doc shortcut bind when the current group has no session', async () => {
    const sessions = { clear: vi.fn(), getRaw: vi.fn(() => undefined), set: vi.fn() };
    const commandCtx = ctx('/doc bind doc_token_456', { sessions: sessions as never });

    await expect(tryHandleCommand(commandCtx)).resolves.toBe(true);

    expect(sessions.set).not.toHaveBeenCalled();
    expect(commandCtx.channel.send).toHaveBeenCalledWith(
      'chat-1',
      { markdown: expect.stringContaining('当前群还没有可绑定的 session') },
      { replyTo: 'msg-1' },
    );
  });

  test('rejects cloud doc shortcut bind outside group chats', async () => {
    const commandCtx = ctx('/doc bind doc_token_456', { chatMode: 'p2p' });

    await expect(tryHandleCommand(commandCtx)).resolves.toBe(true);

    expect(commandCtx.sessions.set).not.toHaveBeenCalled();
    expect(commandCtx.channel.send).toHaveBeenCalledWith(
      'chat-1',
      { markdown: expect.stringContaining('只能在群聊或话题群里使用') },
      { replyTo: 'msg-1' },
    );
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

  test('shows cloud doc bind shortcut and explicit examples in usage', async () => {
    const commandCtx = ctx('/doc bind');

    await expect(tryHandleCommand(commandCtx)).resolves.toBe(true);

    expect(commandCtx.channel.send).toHaveBeenCalledWith(
      'chat-1',
      {
        markdown: expect.stringContaining('/doc bind <doc-url|token>`：在群里把云文档绑定到当前群的 backend/session'),
      },
      { replyTo: 'msg-1' },
    );
    expect(commandCtx.channel.send).toHaveBeenCalledWith(
      'chat-1',
      { markdown: expect.stringContaining('/doc bind <doc-url|token> <backend|default> <session-id>`：显式指定 backend/session') },
      { replyTo: 'msg-1' },
    );
  });

  test('rejects unknown backend keys', async () => {
    const commandCtx = ctx('/doc bind doc_token_123 nope sess-123456789');

    await expect(tryHandleCommand(commandCtx)).resolves.toBe(true);

    expect(commandCtx.backendStore?.set).not.toHaveBeenCalled();
    expect(commandCtx.sessions.set).not.toHaveBeenCalled();
    expect(commandCtx.channel.send).toHaveBeenCalledWith('chat-1', { markdown: expect.stringContaining('未知 backend') }, { replyTo: 'msg-1' });
  });

  test('help mentions the cloud doc shortcut and explicit bind form', async () => {
    const commandCtx = ctx('/help');

    await expect(tryHandleCommand(commandCtx)).resolves.toBe(true);

    const sent = vi.mocked(commandCtx.channel.send).mock.calls[0]?.[1] as { card?: object };
    const json = JSON.stringify(sent.card);
    expect(json).toContain('/doc bind <doc-url|token>` — 在群里绑定到当前群 backend/session');
    expect(json).toContain('/doc bind <doc-url|token> <backend|default> <session-id>` — 显式指定云文档 backend/session');
  });
});

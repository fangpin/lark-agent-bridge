import { describe, expect, test, vi } from 'vitest';
import type { AgentAdapter } from '../../src/agent/types';
import { tryHandleCommand, type CommandContext } from '../../src/commands';
import * as worktree from '../../src/git/worktree';

function fakeAgent(key: string): AgentAdapter {
  return {
    id: key,
    sessionKey: key,
    displayName: key,
    commandLabel: key,
    descriptor: {
      id: key,
      label: key === 'codex' ? 'Codex' : key,
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
  };
}

function ctx(content: string, senderId = 'admin'): CommandContext {
  const send = vi.fn(async () => ({ messageId: 'sent-1' }));
  const create = vi.fn(async () => ({ data: { chat_id: 'chat-new' } }));
  return {
    channel: { send, rawClient: { im: { v1: { chat: { create } } } } },
    msg: { chatId: 'chat-1', messageId: 'msg-1', senderId, content, rawContentType: 'text', resources: [], mentions: [], mentionAll: false, mentionedBot: true, createTime: Date.now() },
    scope: 'chat-1',
    chatMode: 'group',
    sessions: { clear: vi.fn(), getRaw: vi.fn() },
    workspaces: { cwdFor: () => '/home/me/repos/project_a', setCwd: vi.fn() },
    agent: fakeAgent('codex'),
    backendKey: 'codex',
    backendStore: { get: vi.fn(), set: vi.fn(), clear: vi.fn() },
    activeRuns: { interrupt: vi.fn(() => false) },
    controls: { restart: async () => undefined, exit: async () => undefined, configPath: '', processId: 'proc', cfg: { preferences: { worktreeBranchPrefix: 'pin', access: { admins: ['admin'] } } } },
  } as unknown as CommandContext;
}

describe('/new worktree', () => {
  test('denies non-admin sender before creating a worktree', async () => {
    const createGitWorktree = vi.spyOn(worktree, 'createGitWorktree');
    const commandCtx = ctx('/new worktree abc', 'not-admin');

    await expect(tryHandleCommand(commandCtx)).resolves.toBe(true);

    expect(createGitWorktree).not.toHaveBeenCalled();
    expect(commandCtx.channel.send).toHaveBeenCalledWith('chat-1', { markdown: '❌ 此命令仅管理员可用。' }, { replyTo: 'msg-1' });
  });

  test('creates worktree, group chat, and binds cwd/backend to the new chat', async () => {
    vi.spyOn(worktree, 'createGitWorktree').mockResolvedValue({
      name: 'abc',
      branch: 'pin/abc',
      path: '/home/me/repos/project_a_pin_abc',
      base: 'origin/main',
    });
    const commandCtx = ctx('/new worktree abc');

    await expect(tryHandleCommand(commandCtx)).resolves.toBe(true);

    expect(worktree.createGitWorktree).toHaveBeenCalledWith('/home/me/repos/project_a', 'pin', 'abc');
    expect(commandCtx.channel.rawClient.im.v1.chat.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ name: 'Codex · abc' }),
      params: { user_id_type: 'open_id' },
    });
    expect(commandCtx.workspaces.setCwd).toHaveBeenCalledWith('chat-new', '/home/me/repos/project_a_pin_abc');
    expect(commandCtx.backendStore?.set).toHaveBeenCalledWith('chat-new', 'codex');
    expect(commandCtx.channel.send).toHaveBeenCalledWith('chat-1', { markdown: expect.stringContaining('pin/abc') }, { replyTo: 'msg-1' });
  });

  test('keeps created worktree details visible when group chat creation fails', async () => {
    vi.spyOn(worktree, 'createGitWorktree').mockResolvedValue({
      name: 'abc',
      branch: 'pin/abc',
      path: '/home/me/repos/project_a_pin_abc',
      base: 'origin/main',
    });
    const commandCtx = ctx('/new worktree abc');
    vi.mocked(commandCtx.channel.rawClient.im.v1.chat.create).mockRejectedValue(new Error('chat failed'));

    await expect(tryHandleCommand(commandCtx)).resolves.toBe(true);

    expect(worktree.createGitWorktree).toHaveBeenCalledOnce();
    expect(commandCtx.workspaces.setCwd).not.toHaveBeenCalled();
    expect(commandCtx.backendStore?.set).not.toHaveBeenCalled();
    expect(commandCtx.channel.send).toHaveBeenCalledWith(
      'chat-1',
      { markdown: expect.stringContaining('worktree 已创建，但创建群聊失败') },
      { replyTo: 'msg-1' },
    );
    expect(commandCtx.channel.send).toHaveBeenCalledWith(
      'chat-1',
      { markdown: expect.stringContaining('pin/abc') },
      { replyTo: 'msg-1' },
    );
    expect(commandCtx.channel.send).toHaveBeenCalledWith(
      'chat-1',
      { markdown: expect.stringContaining('/home/me/repos/project_a_pin_abc') },
      { replyTo: 'msg-1' },
    );
  });

  test('rejects invalid worktree names before running git', async () => {
    const createGitWorktree = vi.spyOn(worktree, 'createGitWorktree');
    const commandCtx = ctx('/new worktree fix login');

    await expect(tryHandleCommand(commandCtx)).resolves.toBe(true);

    expect(createGitWorktree).not.toHaveBeenCalled();
    expect(commandCtx.channel.send).toHaveBeenCalledWith('chat-1', { markdown: expect.stringContaining('只能包含') }, { replyTo: 'msg-1' });
  });
});

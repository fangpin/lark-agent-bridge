import { describe, expect, test, vi } from 'vitest';
import type { AgentAdapter } from '../../src/agent/types';
import { tryHandleCommand, type CommandContext } from '../../src/commands';
import * as worktree from '../../src/git/worktree';
import * as localHistory from '../../src/session/local-history';
import * as group from '../../src/bot/group';

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
  const dissolve = vi.fn(async () => undefined);
  return {
    channel: { send, rawClient: { im: { v1: { chat: { delete: dissolve } } } } },
    msg: {
      chatId: 'chat-1',
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
    scope: 'chat-1',
    chatMode: 'group',
    sessions: { clear: vi.fn(), getRaw: vi.fn() },
    workspaces: { cwdFor: vi.fn(() => '/home/me/repos/project_a_pin_abc'), clearCwd: vi.fn(() => true) },
    agent: fakeAgent('claude'),
    backendKey: 'claude',
    backendStore: { get: vi.fn(), set: vi.fn(), clear: vi.fn() },
    activeRuns: { interrupt: vi.fn(() => false) },
    controls: {
      restart: async () => undefined,
      exit: async () => undefined,
      configPath: '',
      processId: 'proc',
      cfg: { preferences: { access: { admins: ['admin'] } } },
    },
    ...overrides,
  } as unknown as CommandContext;
}

function clearTarget(overrides: Partial<worktree.WorktreeClearTarget> = {}): worktree.WorktreeClearTarget {
  return {
    path: '/home/me/repos/project_a_pin_abc',
    primaryPath: '/home/me/repos/project_a',
    branch: 'pin/abc',
    baseRef: 'origin/main',
    dirty: false,
    unmerged: false,
    safetyIssues: [],
    ...overrides,
  };
}

describe('/clear', () => {
  test('denies non-admin sender before inspecting worktree', async () => {
    const inspect = vi.spyOn(worktree, 'inspectWorktreeClearTarget');
    const commandCtx = ctx('/clear');
    commandCtx.msg.senderId = 'not-admin';

    await expect(tryHandleCommand(commandCtx)).resolves.toBe(true);

    expect(inspect).not.toHaveBeenCalled();
    expect(commandCtx.channel.send).toHaveBeenCalledWith('chat-1', { markdown: '❌ 此命令仅管理员可用。' }, { replyTo: 'msg-1' });
  });

  test('rejects p2p chats', async () => {
    const commandCtx = ctx('/clear', { chatMode: 'p2p' });

    await expect(tryHandleCommand(commandCtx)).resolves.toBe(true);

    expect(commandCtx.channel.send).toHaveBeenCalledWith('chat-1', { markdown: expect.stringContaining('只能在 worktree 专属群聊中使用') }, { replyTo: 'msg-1' });
  });

  test('rejects topic scopes', async () => {
    const commandCtx = ctx('/clear', { chatMode: 'topic', scope: 'chat-1:thread-1' });
    commandCtx.msg.threadId = 'thread-1';

    await expect(tryHandleCommand(commandCtx)).resolves.toBe(true);

    expect(commandCtx.channel.send).toHaveBeenCalledWith('chat-1', { markdown: expect.stringContaining('只能在 worktree 专属群聊中使用') }, { replyTo: 'msg-1', replyInThread: true });
  });

  test('rejects chats without a bound cwd', async () => {
    const commandCtx = ctx('/clear');
    vi.mocked(commandCtx.workspaces.cwdFor).mockReturnValue(undefined);

    await expect(tryHandleCommand(commandCtx)).resolves.toBe(true);

    expect(commandCtx.channel.send).toHaveBeenCalledWith('chat-1', { markdown: expect.stringContaining('当前群没有绑定 cwd') }, { replyTo: 'msg-1' });
  });

  test('rejects unsafe worktree state without force', async () => {
    vi.spyOn(worktree, 'inspectWorktreeClearTarget').mockResolvedValue(clearTarget({
      dirty: true,
      unmerged: true,
      safetyIssues: [
        'worktree has uncommitted or untracked changes',
        'branch has commits not merged into origin/main',
      ],
    }));
    const remove = vi.spyOn(worktree, 'removeGitWorktreeAndBranch');
    const commandCtx = ctx('/clear');

    await expect(tryHandleCommand(commandCtx)).resolves.toBe(true);

    expect(remove).not.toHaveBeenCalled();
    expect(commandCtx.channel.send).toHaveBeenCalledWith('chat-1', { markdown: expect.stringContaining('/clear --force') }, { replyTo: 'msg-1' });
  });

  test('cleans state, removes history and worktree, then dissolves the group', async () => {
    const target = clearTarget();
    vi.spyOn(worktree, 'inspectWorktreeClearTarget').mockResolvedValue(target);
    vi.spyOn(worktree, 'removeGitWorktreeAndBranch').mockResolvedValue(undefined);
    vi.spyOn(localHistory, 'removeLocalAgentHistory').mockResolvedValue(['/home/me/.claude/projects/-home-me-repos-project_a_pin_abc']);
    vi.spyOn(group, 'dissolveChat').mockResolvedValue(undefined);
    const commandCtx = ctx('/clear');

    await expect(tryHandleCommand(commandCtx)).resolves.toBe(true);

    expect(commandCtx.activeRuns.interrupt).toHaveBeenCalledWith('chat-1');
    expect(commandCtx.agent.evictScope).toHaveBeenCalledWith('chat-1', '/home/me/repos/project_a_pin_abc');
    expect(commandCtx.sessions.clear).toHaveBeenCalledWith('chat-1');
    expect(commandCtx.workspaces.clearCwd).toHaveBeenCalledWith('chat-1');
    expect(commandCtx.backendStore?.clear).toHaveBeenCalledWith('chat-1');
    expect(localHistory.removeLocalAgentHistory).toHaveBeenCalledWith('/home/me/repos/project_a_pin_abc');
    expect(worktree.removeGitWorktreeAndBranch).toHaveBeenCalledWith(target, false);
    expect(commandCtx.channel.send).toHaveBeenCalledWith('chat-1', { markdown: expect.stringContaining('即将解散当前群聊') }, { replyTo: 'msg-1' });
    expect(group.dissolveChat).toHaveBeenCalledWith(commandCtx.channel, 'chat-1');
  });

  test('force mode continues through unsafe state and removes with force', async () => {
    const unsafe = clearTarget({
      dirty: true,
      unmerged: true,
      safetyIssues: ['worktree has uncommitted or untracked changes'],
    });
    vi.spyOn(worktree, 'inspectWorktreeClearTarget').mockResolvedValue(unsafe);
    vi.spyOn(worktree, 'removeGitWorktreeAndBranch').mockResolvedValue(undefined);
    vi.spyOn(localHistory, 'removeLocalAgentHistory').mockResolvedValue([]);
    vi.spyOn(group, 'dissolveChat').mockResolvedValue(undefined);
    const commandCtx = ctx('/clear --force');

    await expect(tryHandleCommand(commandCtx)).resolves.toBe(true);

    expect(worktree.removeGitWorktreeAndBranch).toHaveBeenCalledWith(unsafe, true);
    expect(group.dissolveChat).toHaveBeenCalledWith(commandCtx.channel, 'chat-1');
  });

  test('reports Lark dissolution failure after local cleanup', async () => {
    vi.spyOn(worktree, 'inspectWorktreeClearTarget').mockResolvedValue(clearTarget());
    vi.spyOn(worktree, 'removeGitWorktreeAndBranch').mockResolvedValue(undefined);
    vi.spyOn(localHistory, 'removeLocalAgentHistory').mockResolvedValue([]);
    vi.spyOn(group, 'dissolveChat').mockRejectedValue(new Error('missing scope'));
    const commandCtx = ctx('/clear');

    await expect(tryHandleCommand(commandCtx)).resolves.toBe(true);

    expect(worktree.removeGitWorktreeAndBranch).toHaveBeenCalledOnce();
    expect(commandCtx.channel.send).toHaveBeenCalledWith('chat-1', { markdown: expect.stringContaining('本地清理已完成，但解散群聊失败') }, { replyTo: 'msg-1' });
  });

  test('stops cleanup and keeps group when git removal fails', async () => {
    vi.spyOn(worktree, 'inspectWorktreeClearTarget').mockResolvedValue(clearTarget());
    vi.spyOn(worktree, 'removeGitWorktreeAndBranch').mockRejectedValue(new Error('branch not merged'));
    vi.spyOn(localHistory, 'removeLocalAgentHistory').mockResolvedValue([]);
    const dissolve = vi.spyOn(group, 'dissolveChat');
    const commandCtx = ctx('/clear');

    await expect(tryHandleCommand(commandCtx)).resolves.toBe(true);

    expect(dissolve).not.toHaveBeenCalled();
    expect(commandCtx.channel.send).toHaveBeenCalledWith('chat-1', { markdown: expect.stringContaining('清理失败') }, { replyTo: 'msg-1' });
  });
});

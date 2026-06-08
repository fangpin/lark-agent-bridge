import { describe, expect, test, vi } from 'vitest';
import type { AgentDescriptor } from '../../src/agent/types';
import type { NormalizedMessage } from '@larksuiteoapi/node-sdk';
import { PersistentQueue } from '../../src/bot/persistent-queue';
import { RunHistory } from '../../src/bot/run-history';
import { runCommandHandler, tryHandleCommand, type CommandContext } from '../../src/commands';

const descriptor: AgentDescriptor = {
  id: 'claude',
  label: 'Claude Code',
  runtime: 'cli',
  sessionKey: 'claude',
  commandLabel: 'claude',
  supportsRetry: true,
  supportsWorkers: false,
};

function msg(content: string, overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    chatId: 'chat-1',
    chatType: 'p2p',
    messageId: 'msg-1',
    senderId: 'admin',
    content,
    rawContentType: 'text',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: true,
    createTime: Date.now(),
    ...overrides,
  };
}

function ctx(content: string, history = new RunHistory()): CommandContext {
  const send = vi.fn(async () => ({ messageId: 'sent-1' }));
  return {
    channel: { send },
    msg: msg(content),
    scope: 'chat-1',
    chatMode: 'p2p',
    sessions: { getRaw: () => undefined },
    workspaces: { cwdFor: () => '/repo/project' },
    agent: { displayName: 'Claude Code', sessionKey: 'claude', descriptor },
    activeRuns: { interrupt: vi.fn(() => false) },
    pending: { push: vi.fn(() => 1), pushBatch: vi.fn(() => 1), cancel: vi.fn(() => []) },
    persistentQueue: {
      enqueue: vi.fn(async (_scope: string, messages: NormalizedMessage[]) => ({
        id: 'durable-retry-1',
        scope: 'chat-1',
        messages,
        state: 'queued' as const,
        createdAt: 1000,
        updatedAt: 1000,
      })),
      cancelScope: vi.fn(async () => 0),
    },
    runHistory: history,
    controls: {
      restart: async () => undefined,
      exit: async () => undefined,
      configPath: '',
      processId: 'proc',
      cfg: { preferences: { access: { admins: ['admin'] } } },
    },
  } as unknown as CommandContext;
}

describe('/runs command', () => {
  test('sends a recent runs card containing existing run summary', async () => {
    const history = new RunHistory();
    history.create('chat-1', [msg('fix the bug')], {
      cwd: '/repo/project',
      agent: descriptor,
      summary: 'fix the bug',
    });
    const commandCtx = ctx('/runs', history);

    await expect(tryHandleCommand(commandCtx)).resolves.toBe(true);

    expect(commandCtx.channel.send).toHaveBeenCalledWith(
      'chat-1',
      { card: expect.any(Object) },
      { replyTo: 'msg-1' },
    );
    expect(JSON.stringify(vi.mocked(commandCtx.channel.send).mock.calls[0]![1])).toContain('fix the bug');
  });

  test('replies to topic command cards in the source thread', async () => {
    const history = new RunHistory();
    history.create('chat-1:thread-1', [msg('fix the bug', { threadId: 'thread-1' })], {
      cwd: '/repo/project',
      agent: descriptor,
      summary: 'fix the bug',
    });
    const commandCtx = ctx('/runs', history);
    commandCtx.chatMode = 'topic';
    commandCtx.scope = 'chat-1:thread-1';
    commandCtx.msg.threadId = 'thread-1';

    await expect(tryHandleCommand(commandCtx)).resolves.toBe(true);

    expect(commandCtx.channel.send).toHaveBeenCalledWith(
      'chat-1',
      { card: expect.any(Object) },
      { replyTo: 'msg-1', replyInThread: true },
    );
  });

  test('sends a run detail card by id', async () => {
    const history = new RunHistory();
    const entry = history.create('chat-1', [msg('fix the bug')], {
      cwd: '/repo/project',
      agent: descriptor,
      summary: 'fix the bug',
    });
    const commandCtx = ctx(`/runs ${entry.runId}`, history);

    await expect(tryHandleCommand(commandCtx)).resolves.toBe(true);

    expect(JSON.stringify(vi.mocked(commandCtx.channel.send).mock.calls[0]![1])).toContain('运行详情');
    expect(JSON.stringify(vi.mocked(commandCtx.channel.send).mock.calls[0]![1])).toContain(entry.runId);
  });

  test('sends a run detail card from card-dispatch-shaped detail args', async () => {
    const history = new RunHistory();
    const entry = history.create('chat-1', [msg('fix the bug')], {
      cwd: '/repo/project',
      agent: descriptor,
      summary: 'fix the bug',
    });
    const commandCtx = ctx('', history);

    await expect(runCommandHandler('runs', `detail ${entry.runId}`, commandCtx)).resolves.toBe(true);

    expect(JSON.stringify(vi.mocked(commandCtx.channel.send).mock.calls[0]![1])).toContain('运行详情');
    expect(JSON.stringify(vi.mocked(commandCtx.channel.send).mock.calls[0]![1])).toContain(entry.runId);
  });

  test('rejects details from another scope', async () => {
    const history = new RunHistory();
    const entry = history.create('other-scope', [msg('fix the bug')], {
      cwd: '/repo/project',
      agent: descriptor,
      summary: 'fix the bug',
    });
    const commandCtx = ctx(`/runs ${entry.runId}`, history);

    await expect(tryHandleCommand(commandCtx)).resolves.toBe(true);

    expect(commandCtx.channel.send).toHaveBeenCalledWith(
      'chat-1',
      { markdown: '这个任务属于另一个会话/话题，不能在当前会话查看。' },
      { replyTo: 'msg-1' },
    );
  });

  test('/status includes latest run when history exists', async () => {
    const history = new RunHistory();
    history.create('chat-1', [msg('fix the bug')], {
      cwd: '/repo/project',
      agent: descriptor,
      summary: 'fix the bug',
    });
    const commandCtx = ctx('/status', history);

    await expect(tryHandleCommand(commandCtx)).resolves.toBe(true);

    expect(JSON.stringify(vi.mocked(commandCtx.channel.send).mock.calls[0]![1])).toContain('最近运行');
    expect(JSON.stringify(vi.mocked(commandCtx.channel.send).mock.calls[0]![1])).toContain('fix the bug');
  });

  test('/status replies to topic cards in the source thread', async () => {
    const history = new RunHistory();
    history.create('chat-1:thread-1', [msg('fix the bug', { threadId: 'thread-1' })], {
      cwd: '/repo/project',
      agent: descriptor,
      summary: 'fix the bug',
    });
    const commandCtx = ctx('/status', history);
    commandCtx.chatMode = 'topic';
    commandCtx.scope = 'chat-1:thread-1';
    commandCtx.msg.threadId = 'thread-1';

    await expect(tryHandleCommand(commandCtx)).resolves.toBe(true);

    expect(commandCtx.channel.send).toHaveBeenCalledWith(
      'chat-1',
      { card: expect.any(Object) },
      { replyTo: 'msg-1', replyInThread: true },
    );
  });
});

describe('/retry command', () => {
  test.each(['done', 'running'] as const)('rejects %s runs without requeueing', async (terminal) => {
    const history = new RunHistory();
    const entry = history.create('chat-1', [msg('fix the bug')], {
      cwd: '/repo/project',
      agent: descriptor,
      summary: 'fix the bug',
    });
    history.finish(entry.runId, terminal);
    const commandCtx = ctx(`/retry ${entry.runId}`, history);

    await expect(tryHandleCommand(commandCtx)).resolves.toBe(true);

    expect(commandCtx.pending?.push).not.toHaveBeenCalled();
    expect(commandCtx.activeRuns.interrupt).not.toHaveBeenCalled();
    expect(commandCtx.channel.send).toHaveBeenCalledWith(
      'chat-1',
      { markdown: '这个任务状态不能重试；只有失败或超时的任务可以重试。' },
      { replyTo: 'msg-1' },
    );
  });

  test('cleans active durable work before interrupting and enqueueing retry', async () => {
    const history = new RunHistory();
    const entry = history.create('chat-1', [msg('fix the bug')], {
      cwd: '/repo/project',
      agent: descriptor,
      summary: 'fix the bug',
    });
    history.finish(entry.runId, 'error');
    const commandCtx = ctx(`/retry ${entry.runId}`, history);
    const callOrder: string[] = [];
    commandCtx.persistentQueue = {
      cancelScope: vi.fn(async () => {
        callOrder.push('durable.cancel');
        return 1;
      }),
      enqueue: vi.fn(async (_scope: string, messages: NormalizedMessage[]) => {
        callOrder.push('durable.enqueue');
        return {
          id: 'durable-retry-1',
          scope: 'chat-1',
          messages,
          state: 'queued' as const,
          createdAt: 1000,
          updatedAt: 1000,
        };
      }),
    } as unknown as PersistentQueue;
    commandCtx.cancelQueuedWork = vi.fn(async (scope = commandCtx.scope) => {
      await commandCtx.persistentQueue!.cancelScope(scope);
      commandCtx.pending!.cancel(scope);
    });
    commandCtx.activeRuns.interrupt = vi.fn(() => {
      callOrder.push('active.interrupt');
      return true;
    });
    commandCtx.pending!.cancel = vi.fn(() => {
      callOrder.push('memory.cancel');
      return [];
    });
    commandCtx.pending!.pushBatch = vi.fn(() => {
      callOrder.push('memory.pushBatch');
      return 1;
    });

    await expect(tryHandleCommand(commandCtx)).resolves.toBe(true);

    expect(commandCtx.persistentQueue.cancelScope).toHaveBeenCalledWith('chat-1');
    expect(commandCtx.activeRuns.interrupt).toHaveBeenCalledWith('chat-1');
    expect(commandCtx.persistentQueue.enqueue).toHaveBeenCalledWith('chat-1', [expect.objectContaining({ content: 'fix the bug' })]);
    expect(callOrder).toEqual(['durable.cancel', 'memory.cancel', 'active.interrupt', 'durable.enqueue', 'memory.pushBatch']);
  });

  test('does not interrupt or enqueue retry when active durable cleanup fails', async () => {
    const history = new RunHistory();
    const entry = history.create('chat-1', [msg('fix the bug')], {
      cwd: '/repo/project',
      agent: descriptor,
      summary: 'fix the bug',
    });
    history.finish(entry.runId, 'error');
    const commandCtx = ctx(`/retry ${entry.runId}`, history);
    commandCtx.persistentQueue = {
      cancelScope: vi.fn(async () => {
        throw new Error('durable cancel failed');
      }),
      enqueue: vi.fn(async () => {
        throw new Error('must not enqueue');
      }),
    } as unknown as PersistentQueue;
    commandCtx.cancelQueuedWork = vi.fn(async (scope = commandCtx.scope) => {
      await commandCtx.persistentQueue!.cancelScope(scope);
      commandCtx.pending!.cancel(scope);
    });

    await expect(tryHandleCommand(commandCtx)).resolves.toBe(true);

    expect(commandCtx.persistentQueue.cancelScope).toHaveBeenCalledWith('chat-1');
    expect(commandCtx.activeRuns.interrupt).not.toHaveBeenCalled();
    expect(commandCtx.persistentQueue.enqueue).not.toHaveBeenCalled();
    expect(commandCtx.pending?.pushBatch).not.toHaveBeenCalled();
    expect(commandCtx.channel.send).toHaveBeenCalledWith(
      'chat-1',
      { markdown: expect.stringContaining('清理已排队任务失败') },
      { replyTo: 'msg-1' },
    );
  });

  test.each(['error', 'idle_timeout'] as const)('requeues %s runs', async (terminal) => {
    const history = new RunHistory();
    const entry = history.create('chat-1', [msg('fix the bug')], {
      cwd: '/repo/project',
      agent: descriptor,
      summary: 'fix the bug',
    });
    history.finish(entry.runId, terminal);
    const commandCtx = ctx(`/retry ${entry.runId}`, history);

    await expect(tryHandleCommand(commandCtx)).resolves.toBe(true);

    expect(commandCtx.activeRuns.interrupt).toHaveBeenCalledWith('chat-1');
    expect(commandCtx.persistentQueue?.enqueue).toHaveBeenCalledWith('chat-1', [expect.objectContaining({ content: 'fix the bug' })]);
    expect(commandCtx.pending?.pushBatch).toHaveBeenCalledWith('chat-1', [expect.objectContaining({ content: 'fix the bug' })], {
      durableId: 'durable-retry-1',
    });
    expect(commandCtx.pending?.push).not.toHaveBeenCalled();
    expect(commandCtx.channel.send).toHaveBeenCalledWith(
      'chat-1',
      { markdown: '已重新排队上次任务（1 条消息，当前队列 1）。' },
      { replyTo: 'msg-1' },
    );
  });

  test('replies with failure and does not push retry into memory when durable enqueue fails', async () => {
    const history = new RunHistory();
    const entry = history.create('chat-1', [msg('fix the bug')], {
      cwd: '/repo/project',
      agent: descriptor,
      summary: 'fix the bug',
    });
    history.finish(entry.runId, 'error');
    const commandCtx = ctx(`/retry ${entry.runId}`, history);
    commandCtx.persistentQueue = {
      cancelScope: vi.fn(async () => 0),
      enqueue: vi.fn(async () => {
        throw new Error('durable retry enqueue failed');
      }),
    } as unknown as PersistentQueue;
    commandCtx.cancelQueuedWork = vi.fn(async (scope = commandCtx.scope) => {
      await commandCtx.persistentQueue!.cancelScope(scope);
      commandCtx.pending!.cancel(scope);
    });

    await expect(tryHandleCommand(commandCtx)).resolves.toBe(true);

    expect(commandCtx.activeRuns.interrupt).toHaveBeenCalledWith('chat-1');
    expect(commandCtx.pending?.push).not.toHaveBeenCalled();
    expect(commandCtx.pending?.pushBatch).not.toHaveBeenCalled();
    expect(commandCtx.channel.send).toHaveBeenCalledWith(
      'chat-1',
      { markdown: expect.stringContaining('重试排队失败') },
      { replyTo: 'msg-1' },
    );
  });

  test('rejects retry when current cwd differs from the recorded run cwd', async () => {
    const history = new RunHistory();
    const entry = history.create('chat-1', [msg('fix the bug')], {
      cwd: '/repo/project-a',
      agent: descriptor,
      summary: 'fix the bug',
    });
    history.finish(entry.runId, 'error');
    const commandCtx = ctx(`/retry ${entry.runId}`, history);
    commandCtx.workspaces = { cwdFor: () => '/repo/project-b' } as unknown as CommandContext['workspaces'];

    await expect(tryHandleCommand(commandCtx)).resolves.toBe(true);

    expect(commandCtx.pending?.push).not.toHaveBeenCalled();
    expect(commandCtx.activeRuns.interrupt).not.toHaveBeenCalled();
    expect(commandCtx.channel.send).toHaveBeenCalledWith(
      'chat-1',
      { markdown: '这个任务属于另一个工作目录，不能在当前 cwd 重试。' },
      { replyTo: 'msg-1' },
    );
  });

  test('rejects retry when current agent backend differs from the recorded run backend', async () => {
    const history = new RunHistory();
    const entry = history.create('chat-1', [msg('fix the bug')], {
      cwd: '/repo/project',
      agent: { ...descriptor, sessionKey: 'cursor:sdk' },
      summary: 'fix the bug',
    });
    history.finish(entry.runId, 'error');
    const commandCtx = ctx(`/retry ${entry.runId}`, history);

    await expect(tryHandleCommand(commandCtx)).resolves.toBe(true);

    expect(commandCtx.pending?.push).not.toHaveBeenCalled();
    expect(commandCtx.activeRuns.interrupt).not.toHaveBeenCalled();
    expect(commandCtx.channel.send).toHaveBeenCalledWith(
      'chat-1',
      { markdown: '这个任务属于另一个 agent 后端，不能用当前 agent 重试。' },
      { replyTo: 'msg-1' },
    );
  });
});

import { describe, expect, test, vi } from 'vitest';
import { tryHandleCommand, type CommandContext } from '../../src/commands';
import type { AgentEvent, AgentRun } from '../../src/agent/types';

function ctx(): CommandContext {
  const send = vi.fn(async () => ({ messageId: 'sent-1' }));
  return {
    channel: { send },
    msg: {
      chatId: 'chat-1',
      messageId: 'msg-1',
      senderId: 'admin',
      content: '/doctor setup',
      rawContentType: 'text',
      resources: [],
      mentions: [],
      mentionAll: false,
      mentionedBot: true,
      createTime: Date.now(),
    },
    scope: 'chat-1',
    chatMode: 'group',
    sessions: { getRaw: () => undefined },
    workspaces: { cwdFor: () => process.cwd() },
    agent: {
      id: 'codex',
      sessionKey: 'codex',
      displayName: 'Codex CLI',
      commandLabel: 'ttadk --profile dev',
      descriptor: {
        id: 'codex',
        label: 'Codex CLI',
        runtime: 'json',
        sessionKey: 'codex',
        commandLabel: 'ttadk --profile dev',
        supportsRetry: true,
        supportsWorkers: false,
      },
      isAvailable: vi.fn(async () => true),
      run: vi.fn(() => {
        throw new Error('doctor setup must not run agent prompts');
      }),
    },
    activeRuns: { interrupt: vi.fn(() => false) },
    pending: { cancel: vi.fn(() => []) },
    runHistory: undefined,
    controls: {
      restart: async () => undefined,
      exit: async () => undefined,
      configPath: '/tmp/config.json',
      processId: 'proc',
      cfg: {
        accounts: { app: { id: 'app-id', secret: 'secret', tenant: 'feishu' } },
        preferences: {
          agentCommand: {
            backend: 'codex',
            command: 'ttadk',
            args: ['--profile', 'dev'],
            codexArgsOption: '--claude-args',
          },
          access: { admins: ['admin'], allowedChats: ['chat-1'] },
        },
      },
    },
  } as unknown as CommandContext;
}

describe('/doctor setup', () => {
  test('/doctor aborts before interrupting active run when queued cleanup fails', async () => {
    const stop = vi.fn(async () => undefined);
    const run: AgentRun = {
      events: (async function* (): AsyncGenerator<AgentEvent> {
        yield { type: 'done' };
      })(),
      stop,
      waitForExit: vi.fn(async () => true),
    };
    const commandCtx = ctx();
    commandCtx.msg.content = '/doctor stuck run';
    commandCtx.cancelQueuedWork = vi.fn(async () => {
      throw new Error('durable cancel failed');
    });
    commandCtx.activeRuns = {
      interrupt: vi.fn(() => true),
      register: vi.fn(() => ({ run, interrupted: false })),
      unregister: vi.fn(),
    } as unknown as CommandContext['activeRuns'];
    commandCtx.agent.run = vi.fn(() => run);

    await expect(tryHandleCommand(commandCtx)).resolves.toBe(true);

    expect(commandCtx.cancelQueuedWork).toHaveBeenCalledWith('chat-1');
    expect(commandCtx.activeRuns.interrupt).not.toHaveBeenCalled();
    expect(commandCtx.agent.run).not.toHaveBeenCalled();
    expect(commandCtx.channel.send).toHaveBeenCalledWith(
      'chat-1',
      { markdown: expect.stringContaining('清理已排队任务失败') },
      { replyTo: 'msg-1' },
    );
  });

  test('sends setup diagnostics card without starting a doctor agent run', async () => {
    const commandCtx = ctx();

    await expect(tryHandleCommand(commandCtx)).resolves.toBe(true);

    expect(commandCtx.agent.run).not.toHaveBeenCalled();
    expect(commandCtx.channel.send).toHaveBeenCalledWith(
      'chat-1',
      { card: expect.any(Object) },
      { replyTo: 'msg-1' },
    );
    expect(JSON.stringify(vi.mocked(commandCtx.channel.send).mock.calls[0]![1])).toContain('Setup');
  });
});

import { describe, expect, test, vi } from 'vitest';
import { runShellCommand, tryHandleCommand, type CommandContext } from '../../src/commands';

function commandContext(content: string, senderId = 'user'): CommandContext {
  const send = vi.fn(async () => undefined);
  return {
    channel: { send },
    msg: {
      chatId: 'chat',
      messageId: 'msg',
      senderId,
      content,
    },
    scope: 'chat',
    chatMode: 'p2p',
    sessions: {},
    workspaces: { cwdFor: () => process.cwd() },
    agent: {},
    activeRuns: {},
    controls: {
      restart: async () => undefined,
      exit: async () => undefined,
      configPath: '',
      processId: 'proc',
      cfg: {
        preferences: {
          access: {
            admins: ['admin'],
          },
        },
      },
    },
  } as unknown as CommandContext;
}

describe('shell command', () => {
  test('runs a shell command and captures stdout and stderr', async () => {
    const result = await runShellCommand(
      "printf 'hello'; printf 'oops' >&2",
      process.cwd(),
      2000,
      1000,
    );

    expect(result.code).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.stdout).toBe('hello');
    expect(result.stderr).toBe('oops');
  });

  test('truncates combined command output', async () => {
    const result = await runShellCommand(
      "node -e \"process.stdout.write('x'.repeat(20)); process.stderr.write('y'.repeat(20))\"",
      process.cwd(),
      2000,
      10,
    );

    expect(result.truncated).toBe(true);
    expect(result.stdout.length + result.stderr.length).toBeLessThanOrEqual(10);
  });

  test('times out long running commands', async () => {
    const result = await runShellCommand("node -e \"setTimeout(() => {}, 1000)\"", process.cwd(), 100, 1000);

    expect(result.timedOut).toBe(true);
  });

  test('sends a temporary check message after shell command finishes', async () => {
    vi.useFakeTimers();
    const ctx = commandContext('/shell node -e "process.exit(0)"', 'admin');
    const send = vi.fn(async (_chatId: string, payload: unknown) => {
      const markdown = (payload as { markdown?: string }).markdown;
      return { messageId: markdown === '请检查' ? 'om_check' : 'om_shell_result' };
    });
    const deleteMessage = vi.fn(async () => undefined);
    ctx.channel = {
      send,
      rawClient: {
        im: {
          v1: {
            message: { delete: deleteMessage },
          },
        },
      },
    } as unknown as CommandContext['channel'];

    await expect(tryHandleCommand(ctx)).resolves.toBe(true);

    expect(send).toHaveBeenCalledWith('chat', expect.objectContaining({ markdown: expect.stringContaining('**/shell exit 0**') }), { replyTo: 'msg' });
    expect(send).toHaveBeenCalledWith('chat', { markdown: '请检查' });
    expect(deleteMessage).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(12 * 60 * 60 * 1000);

    expect(deleteMessage).toHaveBeenCalledWith({ path: { message_id: 'om_check' } });
    vi.useRealTimers();
  });

  test('is gated to admins', async () => {
    const ctx = commandContext('/shell echo nope');

    await expect(tryHandleCommand(ctx)).resolves.toBe(true);

    expect(ctx.channel.send).toHaveBeenCalledWith(
      'chat',
      { markdown: '❌ 此命令仅管理员可用。' },
      { replyTo: 'msg' },
    );
  });
});

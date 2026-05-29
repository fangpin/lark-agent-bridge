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

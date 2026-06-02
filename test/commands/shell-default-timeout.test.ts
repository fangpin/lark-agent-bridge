import { EventEmitter } from 'node:events';
import { describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  kill: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawn: mocks.spawn,
}));

vi.stubGlobal('process', {
  ...process,
  kill: mocks.kill,
});

import { tryHandleCommand, type CommandContext } from '../../src/commands';

function commandContext(content: string, senderId = 'admin'): CommandContext {
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

describe('shell command default timeout', () => {
  test('waits 10 minutes before timing out shell commands', async () => {
    vi.useFakeTimers();
    mocks.kill.mockReset();

    const child = new EventEmitter() as EventEmitter & {
      pid: number;
      stdout: EventEmitter;
      stderr: EventEmitter;
    };
    child.pid = 1234;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    mocks.spawn.mockReturnValueOnce(child);

    const handled = tryHandleCommand(commandContext('/shell long-running'));
    await vi.advanceTimersByTimeAsync(599_999);
    expect(mocks.kill).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.kill).toHaveBeenCalledWith(-1234, 'SIGTERM');

    child.emit('close', null, 'SIGTERM');
    await handled;

    vi.useRealTimers();
  });
});

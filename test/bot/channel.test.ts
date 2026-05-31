import { afterEach, describe, expect, test, vi } from 'vitest';
import type { LarkChannel, NormalizedMessage } from '@larksuiteoapi/node-sdk';
import { createLarkChannel } from '@larksuiteoapi/node-sdk';
import type { AgentAdapter, AgentEvent, AgentRun, AgentRunOptions } from '../../src/agent/types';
import type { RunHandle } from '../../src/bot/active-runs';
import { ActiveRuns } from '../../src/bot/active-runs';
import {
  interruptScopeNow,
  maybeEnqueueAutoRetryForOpaqueSdkError,
  processAgentStream,
  shouldAutoRetryOpaqueSdkError,
  startChannel,
  summarizeBatchForHistory,
} from '../../src/bot/channel';
import { PendingQueue } from '../../src/bot/pending-queue';
import { RunHistory } from '../../src/bot/run-history';
import { createInitialState } from '../../src/card/run-state';
import type { AppConfig } from '../../src/config/schema';
import type { Controls } from '../../src/commands';
import type { SessionStore } from '../../src/session/store';
import type { WorkspaceStore } from '../../src/workspace/store';

vi.mock('@larksuiteoapi/node-sdk', async () => {
  const actual = await vi.importActual<typeof import('@larksuiteoapi/node-sdk')>('@larksuiteoapi/node-sdk');
  return {
    ...actual,
    createLarkChannel: vi.fn(),
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

function runWithNaturalExitAfter(timeoutNeededMs: number): {
  handle: RunHandle;
  waitTimeouts: number[];
  stopCalls: () => number;
} {
  let stopCount = 0;
  const waitTimeouts: number[] = [];
  const run: AgentRun = {
    events: (async function* (): AsyncGenerator<AgentEvent> {
      yield { type: 'done' };
    })(),
    async stop() {
      stopCount++;
    },
    async waitForExit(timeoutMs: number) {
      waitTimeouts.push(timeoutMs);
      return timeoutMs >= timeoutNeededMs;
    },
  };

  return {
    handle: { run, interrupted: false },
    waitTimeouts,
    stopCalls: () => stopCount,
  };
}

describe('summarizeBatchForHistory', () => {
  test('collapses whitespace and truncates long message content', () => {
    const batch = [
      fakeMessage('msg-1', `请帮我看看这个报错\n第二行细节 ${'x'.repeat(100)}`),
    ];

    const summary = summarizeBatchForHistory(batch);

    expect(summary).toMatch(/^请帮我看看这个报错 第二行细节 x+/);
    expect(summary).not.toContain('\n');
    expect(summary).toHaveLength(81);
    expect(summary.endsWith('…')).toBe(true);
  });
});

describe('channel streamMessageId persistence', () => {
  test('text replies persist sent message ids in run history', async () => {
    let persistedStreamMessageId: string | undefined;
    const originalUpdate = RunHistory.prototype.update;
    const update = vi.spyOn(RunHistory.prototype, 'update').mockImplementation(function (
      this: RunHistory,
      runId,
      changes,
    ) {
      originalUpdate.call(this, runId, changes);
      persistedStreamMessageId = this.get(runId)?.streamMessageId;
    });
    const messages: Record<string, (msg: NormalizedMessage) => Promise<void>> = {};
    const fakeChannel = createFakeChannel(messages);
    vi.mocked(createLarkChannel).mockReturnValue(fakeChannel);

    await startChannel({
      cfg: textReplyConfig(),
      agent: fakeAgent(() => {}),
      sessions: fakeSessions(),
      workspaces: fakeWorkspaces('/tmp/project'),
      controls: fakeControls(textReplyConfig()),
    });

    const onMessage = messages.message;
    if (!onMessage) throw new Error('message handler was not registered');
    await onMessage(fakeMessage('om_original', 'original prompt'));

    await vi.waitFor(() =>
      expect(update).toHaveBeenCalledWith(expect.any(String), { streamMessageId: 'om_sent_text' }),
    );
    expect(persistedStreamMessageId).toBe('om_sent_text');
  });

  test('fallback replies persist sent message ids in run history when streaming fails before returning', async () => {
    let persistedStreamMessageId: string | undefined;
    const originalUpdate = RunHistory.prototype.update;
    const update = vi.spyOn(RunHistory.prototype, 'update').mockImplementation(function (
      this: RunHistory,
      runId,
      changes,
    ) {
      originalUpdate.call(this, runId, changes);
      persistedStreamMessageId = this.get(runId)?.streamMessageId;
    });
    const messages: Record<string, (msg: NormalizedMessage) => Promise<void>> = {};
    const fakeChannel = {
      ...createFakeChannel(messages),
      async stream() {
        throw new Error('stream failed before message id');
      },
      async send() {
        return { messageId: 'om_fallback' };
      },
    } as unknown as LarkChannel;
    const cfg = cardReplyConfig();
    vi.mocked(createLarkChannel).mockReturnValue(fakeChannel);

    await startChannel({
      cfg,
      agent: fakeAgent(() => {}),
      sessions: fakeSessions(),
      workspaces: fakeWorkspaces('/tmp/project'),
      controls: fakeControls(cfg),
    });

    const onMessage = messages.message;
    if (!onMessage) throw new Error('message handler was not registered');
    await onMessage(fakeMessage('om_original', 'original prompt'));

    await vi.waitFor(() =>
      expect(update).toHaveBeenCalledWith(expect.any(String), { streamMessageId: 'om_fallback' }),
    );
    expect(persistedStreamMessageId).toBe('om_fallback');
  });
});

describe('processAgentStream', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test('uses the configured post-done grace before stopping a naturally finishing agent', async () => {
    const { handle, waitTimeouts, stopCalls } = runWithNaturalExitAfter(5000);
    const flushed: string[] = [];

    await processAgentStream(
      handle,
      {} as SessionStore,
      'chat-1',
      '/tmp',
      'agent:test',
      undefined,
      async (state) => {
        flushed.push(state.terminal);
      },
      5000,
    );

    expect(waitTimeouts).toEqual([5000]);
    expect(stopCalls()).toBe(0);
    expect(flushed).toContain('done');
  });

  test('persists a replacement session id from a done event', async () => {
    const setCalls: Array<{ scope: string; sessionKey: string; sessionId: string; cwd: string }> = [];
    const run: AgentRun = {
      events: (async function* (): AsyncGenerator<AgentEvent> {
        yield { type: 'done', sessionId: 'agent-new' };
      })(),
      async stop() {},
      async waitForExit() {
        return true;
      },
    };

    await processAgentStream(
      { run, interrupted: false },
      {
        set(scope: string, sessionKey: string, sessionId: string, cwd: string) {
          setCalls.push({ scope, sessionKey, sessionId, cwd });
        },
      } as SessionStore,
      'chat-1',
      '/tmp/project',
      'agent:test',
      undefined,
      async () => {},
      5000,
    );

    expect(setCalls).toEqual([
      { scope: 'chat-1', sessionKey: 'agent:test', sessionId: 'agent-new', cwd: '/tmp/project' },
    ]);
  });

  test('renders an agent stream exception as an error state', async () => {
    const flushed: Array<{ terminal: string; errorMsg?: string }> = [];
    const run: AgentRun = {
      events: (async function* (): AsyncGenerator<AgentEvent> {
        yield { type: 'text', delta: 'working' };
        throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
      })(),
      async stop() {},
      async waitForExit() {
        return true;
      },
    };

    await processAgentStream(
      { run, interrupted: false },
      {} as SessionStore,
      'chat-1',
      '/tmp/project',
      'agent:test',
      undefined,
      async (state) => {
        flushed.push({ terminal: state.terminal, errorMsg: state.errorMsg });
      },
      5000,
    );

    expect(flushed.at(-1)).toEqual({
      terminal: 'error',
      errorMsg: expect.stringContaining('read ECONNRESET'),
    });
  });

  test('does not convert card flush failures into agent stream errors', async () => {
    let flushCalls = 0;
    const run: AgentRun = {
      events: (async function* (): AsyncGenerator<AgentEvent> {
        yield { type: 'text', delta: 'working' };
        yield { type: 'done' };
      })(),
      async stop() {},
      async waitForExit() {
        return true;
      },
    };

    await expect(
      processAgentStream(
        { run, interrupted: false },
        {} as SessionStore,
        'chat-1',
        '/tmp/project',
        'agent:test',
        undefined,
        async () => {
          flushCalls++;
          if (flushCalls === 1) throw new Error('card update failed');
        },
        5000,
      ),
    ).rejects.toThrow('card update failed');

    expect(flushCalls).toBe(1);
  });

  test('idle watchdog also terminates a silent in-flight tool call', async () => {
    vi.useFakeTimers();
    let releaseStream!: () => void;
    const streamReleased = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    const stop = vi.fn(async () => {
      releaseStream();
    });
    const flushed: string[] = [];
    const run: AgentRun = {
      events: (async function* (): AsyncGenerator<AgentEvent> {
        yield { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'npm publish' } };
        await streamReleased;
      })(),
      stop,
      async waitForExit() {
        return true;
      },
    };
    const handle: RunHandle = { run, interrupted: false };

    const processing = processAgentStream(
      handle,
      {} as SessionStore,
      'chat-1',
      '/tmp/project',
      'agent:test',
      1000,
      async (state) => {
        flushed.push(state.terminal);
      },
      5000,
    );

    await vi.advanceTimersByTimeAsync(1000);
    releaseStream();
    await processing;

    expect(stop).toHaveBeenCalledTimes(1);
    expect(handle.interrupted).toBe(true);
    expect(flushed.at(-1)).toBe('idle_timeout');
  });

  test('refreshes running progress while the agent is silent', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let releaseStream!: () => void;
    const streamReleased = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    const flushed: Array<{ terminal: string; lastActivityAt: number; updatedAt: number }> = [];
    const run: AgentRun = {
      events: (async function* (): AsyncGenerator<AgentEvent> {
        yield { type: 'system', sessionId: 'agent-1' };
        await streamReleased;
      })(),
      async stop() {},
      async waitForExit() {
        return true;
      },
    };

    const processing = processAgentStream(
      { run, interrupted: false },
      { set() {} } as unknown as SessionStore,
      'chat-1',
      '/tmp/project',
      'agent:test',
      undefined,
      async (state) => {
        flushed.push({
          terminal: state.terminal,
          lastActivityAt: state.lastActivityAt,
          updatedAt: state.updatedAt,
        });
      },
      5000,
      createInitialState('run-1'),
    );

    await vi.advanceTimersByTimeAsync(15_000);
    releaseStream();
    await processing;

    expect(flushed).toContainEqual({
      terminal: 'running',
      lastActivityAt: 0,
      updatedAt: 15_000,
    });
  });

  test('fails fast when the final flush hangs', async () => {
    vi.useFakeTimers();
    const run: AgentRun = {
      events: (async function* (): AsyncGenerator<AgentEvent> {
        return;
      })(),
      async stop() {},
      async waitForExit() {
        return true;
      },
    };

    const processing = processAgentStream(
      { run, interrupted: false },
      {} as SessionStore,
      'chat-1',
      '/tmp/project',
      'agent:test',
      undefined,
      async (state) => {
        if (state.terminal === 'done') await new Promise(() => {});
      },
      5000,
    );

    const rejection = expect(processing).rejects.toThrow('final-flush timed out');
    await vi.advanceTimersByTimeAsync(20_000);
    await rejection;
  });
});

describe('interruptScopeNow', () => {
  test('interrupts the active run and drops queued messages immediately', () => {
    let stopCount = 0;
    let flushCount = 0;
    const activeRuns = new ActiveRuns();
    const pending = new PendingQueue(0, () => {
      flushCount++;
    });
    const run: AgentRun = {
      events: (async function* (): AsyncGenerator<AgentEvent> {})(),
      async stop() {
        stopCount++;
      },
      async waitForExit() {
        return true;
      },
    };

    activeRuns.register('chat-1', run);
    pending.block('chat-1');
    pending.push('chat-1', fakeMessage('queued-1'));
    pending.push('chat-1', fakeMessage('queued-2'));

    expect(interruptScopeNow(activeRuns, pending, 'chat-1')).toEqual({
      interrupted: true,
      droppedPending: 2,
    });
    pending.unblock('chat-1');

    expect(stopCount).toBe(1);
    expect(flushCount).toBe(0);
  });
});

describe('opaque Cursor SDK auto retry', () => {
  test('recognizes only uninterrupted opaque SDK status errors with no queued user messages', () => {
    const state = {
      ...createInitialState('run-1'),
      terminal: 'error' as const,
      errorMsg:
        'agent 失败:sdk run failed (runId=run-1, status=error); Cursor returned no error detail | result={"status":"error"}',
    };

    expect(shouldAutoRetryOpaqueSdkError(state, false, 0)).toBe(true);
    expect(shouldAutoRetryOpaqueSdkError(state, true, 0)).toBe(false);
    expect(shouldAutoRetryOpaqueSdkError(state, false, 1)).toBe(false);
    expect(shouldAutoRetryOpaqueSdkError({ ...state, errorMsg: 'Cursor API 鉴权失败' }, false, 0)).toBe(false);
  });

  test('queues the original batch once for opaque SDK status errors', () => {
    const flushed: NormalizedMessage[][] = [];
    const pending = new PendingQueue(1000, (_scope, batch) => {
      flushed.push(batch);
    });
    const batch = [fakeMessage('msg-1'), fakeMessage('msg-2')];
    const state = {
      ...createInitialState('run-1'),
      terminal: 'error' as const,
      errorMsg:
        'sdk run failed (runId=run-87dd74df-deb6-45ca-8862-85847622ee9a, status=error); Cursor returned no error detail',
    };
    const autoRetryKeys = new Set<string>();

    expect(
      maybeEnqueueAutoRetryForOpaqueSdkError({
        scope: 'chat-1',
        batch,
        finalState: state,
        handleInterrupted: false,
        pending,
        autoRetryKeys,
      }),
    ).toBe(true);
    expect(pending.queuedSize('chat-1')).toBe(2);
    pending.cancel('chat-1');

    expect(
      maybeEnqueueAutoRetryForOpaqueSdkError({
        scope: 'chat-1',
        batch,
        finalState: state,
        handleInterrupted: false,
        pending,
        autoRetryKeys,
      }),
    ).toBe(false);
    expect(pending.queuedSize('chat-1')).toBe(0);
    expect(flushed).toEqual([]);
  });
});

function fakeMessage(messageId: string, content = 'queued'): NormalizedMessage {
  return {
    messageId,
    chatId: 'chat-1',
    chatType: 'group',
    senderId: 'ou_user',
    content,
    rawContentType: 'text',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: true,
    createTime: Date.now(),
  };
}

function createFakeChannel(handlers: Record<string, (msg: NormalizedMessage) => Promise<void>>): LarkChannel {
  return {
    botIdentity: { name: 'bot', openId: 'ou_bot' },
    on(registered: Record<string, unknown>) {
      Object.assign(handlers, registered);
    },
    async connect() {},
    async disconnect() {},
    async send(_chatId: string, payload: unknown) {
      const markdown = (payload as { markdown?: string }).markdown;
      return { messageId: markdown?.includes('agent reply') ? 'om_sent_text' : 'om_command_reply' };
    },
    async getChatMode() {
      return 'group';
    },
    rawClient: {
      im: {
        v1: {
          messageReaction: {
            async create() {
              return { data: { reaction_id: 'reaction-1' } };
            },
            async delete() {},
          },
        },
      },
    },
  } as unknown as LarkChannel;
}

function fakeAgent(onRun: (opts: AgentRunOptions) => void): AgentAdapter {
  const descriptor = {
    id: 'fake',
    label: 'Fake Agent',
    runtime: 'test',
    sessionKey: 'fake:test',
    commandLabel: 'fake',
    supportsRetry: true,
    supportsWorkers: false,
  };
  return {
    id: descriptor.id,
    sessionKey: descriptor.sessionKey,
    displayName: descriptor.label,
    commandLabel: descriptor.commandLabel,
    descriptor,
    async isAvailable() {
      return true;
    },
    run(opts: AgentRunOptions): AgentRun {
      onRun(opts);
      return {
        events: (async function* (): AsyncGenerator<AgentEvent> {
          yield { type: 'text', delta: 'agent reply' };
          yield { type: 'done' };
        })(),
        async stop() {},
        async waitForExit() {
          return true;
        },
      };
    },
  };
}

function textReplyConfig(): AppConfig {
  return {
    accounts: { app: { id: 'app-id', secret: 'app-secret', tenant: 'feishu' } },
    preferences: {
      messageReply: 'text',
      messageReplyMigrated: true,
      requireMentionInGroup: false,
    },
  };
}

function cardReplyConfig(): AppConfig {
  return {
    ...textReplyConfig(),
    preferences: {
      ...textReplyConfig().preferences,
      messageReply: 'card',
    },
  };
}

function fakeControls(cfg: AppConfig): Controls {
  return {
    cfg,
    processId: 'test-process',
    configPath: '/tmp/config.json',
    async restart() {},
    async exit() {},
  };
}

function fakeSessions(): SessionStore {
  return {
    resumeFor() {
      return undefined;
    },
    getRaw() {
      return undefined;
    },
    clear() {},
    set() {},
    getIdleTimeoutMinutes() {
      return undefined;
    },
    async flush() {},
  } as unknown as SessionStore;
}

function fakeWorkspaces(cwd: string): WorkspaceStore {
  return {
    cwdFor() {
      return cwd;
    },
    async flush() {},
  } as unknown as WorkspaceStore;
}

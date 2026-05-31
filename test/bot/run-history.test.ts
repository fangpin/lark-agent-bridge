import { describe, expect, test, vi } from 'vitest';
import type { NormalizedMessage } from '@larksuiteoapi/node-sdk';
import type { AgentDescriptor } from '../../src/agent/types';
import { RunHistory } from '../../src/bot/run-history';

const descriptor: AgentDescriptor = {
  id: 'claude',
  label: 'Claude Code',
  runtime: 'cli',
  sessionKey: 'claude',
  commandLabel: 'claude',
  supportsRetry: true,
  supportsWorkers: false,
};

function msg(id: string, content: string, chatId = 'chat-1'): NormalizedMessage {
  return {
    messageId: id,
    chatId,
    chatType: 'p2p',
    senderId: 'user-1',
    content,
    rawContentType: 'text',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: true,
    createTime: Date.now(),
  };
}

describe('RunHistory', () => {
  test('lists recent runs for one scope with newest first', () => {
    vi.setSystemTime(1_000);
    const history = new RunHistory();
    const first = history.create('scope-a', [msg('m1', 'first prompt')], {
      cwd: '/repo/a',
      agent: descriptor,
      summary: 'first prompt',
    });
    vi.setSystemTime(2_000);
    const second = history.create('scope-a', [msg('m2', 'second prompt')], {
      cwd: '/repo/a',
      agent: descriptor,
      summary: 'second prompt',
    });
    history.create('scope-b', [msg('m3', 'other prompt')], {
      cwd: '/repo/b',
      agent: descriptor,
      summary: 'other prompt',
    });

    expect(history.list('scope-a').map((entry) => entry.runId)).toEqual([second.runId, first.runId]);
  });

  test('updates stream message id and terminal state without exposing mutable internals', () => {
    const history = new RunHistory();
    const entry = history.create('scope-a', [msg('m1', 'please fix the bug')], {
      cwd: '/repo/a',
      agent: descriptor,
      summary: 'please fix the bug',
    });

    history.update(entry.runId, { streamMessageId: 'om_123' });
    history.finish(entry.runId, 'error', 'network timeout');

    const copy = history.get(entry.runId)!;
    copy.batch[0]!.content = 'mutated';

    expect(history.get(entry.runId)).toMatchObject({
      runId: entry.runId,
      scope: 'scope-a',
      cwd: '/repo/a',
      streamMessageId: 'om_123',
      terminal: 'error',
      errorMsg: 'network timeout',
      summary: 'please fix the bug',
      agent: descriptor,
    });
    expect(history.get(entry.runId)!.batch[0]!.content).toBe('please fix the bug');
  });

  test('clones nested message resources and mentions from inputs and returned entries', () => {
    const history = new RunHistory();
    const batch = [
      {
        ...msg('m1', 'please inspect image'),
        resources: [{ type: 'image' as const, fileKey: 'file-1' }],
        mentions: [{ key: 'u1', name: 'User' }],
      },
    ];

    const entry = history.create('scope-a', batch, {
      cwd: '/repo/a',
      agent: descriptor,
      summary: 'please inspect image',
    });

    batch[0]!.resources[0]!.fileKey = 'mutated-file';
    batch[0]!.mentions[0]!.name = 'Mutated User';

    const firstCopy = history.get(entry.runId)!;
    expect(firstCopy.batch[0]!.resources[0]).toMatchObject({ type: 'image', fileKey: 'file-1' });
    expect(firstCopy.batch[0]!.mentions[0]).toMatchObject({ key: 'u1', name: 'User' });

    firstCopy.batch[0]!.resources[0]!.fileKey = 'returned-file';
    firstCopy.batch[0]!.mentions[0]!.name = 'Returned User';

    const secondCopy = history.get(entry.runId)!;
    expect(secondCopy.batch[0]!.resources[0]).toMatchObject({ type: 'image', fileKey: 'file-1' });
    expect(secondCopy.batch[0]!.mentions[0]).toMatchObject({ key: 'u1', name: 'User' });
  });

  test('clones nested raw payloads from inputs and returned entries', () => {
    const history = new RunHistory();
    const raw = { event: { message: { content: { text: 'original raw' } } } };
    const batch = [
      {
        ...msg('m1', 'please preserve raw'),
        raw,
      } as NormalizedMessage,
    ];

    const entry = history.create('scope-a', batch, {
      cwd: '/repo/a',
      agent: descriptor,
      summary: 'please preserve raw',
    });

    raw.event.message.content.text = 'mutated input raw';

    const firstCopy = history.get(entry.runId)!;
    const firstRaw = firstCopy.batch[0]!.raw as typeof raw;
    expect(firstRaw.event.message.content.text).toBe('original raw');

    firstRaw.event.message.content.text = 'mutated returned raw';

    const secondCopy = history.get(entry.runId)!;
    const secondRaw = secondCopy.batch[0]!.raw as typeof raw;
    expect(secondRaw.event.message.content.text).toBe('original raw');
  });

  test('limits list size independently from stored retry entries', () => {
    const history = new RunHistory();
    for (let i = 0; i < 8; i++) {
      history.create('scope-a', [msg(`m${i}`, `prompt ${i}`)], {
        cwd: '/repo/a',
        agent: descriptor,
        summary: `prompt ${i}`,
      });
    }

    expect(history.list('scope-a', 3)).toHaveLength(3);
    expect(history.list('scope-a', 3)[0]!.summary).toBe('prompt 7');
  });
});

import { describe, expect, test } from 'vitest';
import { createCodexTranslator, translateCodexEvent } from '../../../src/agent/codex/stream-json';

describe('translateCodexEvent', () => {
  test('translates thread start into a system session event', () => {
    const translator = createCodexTranslator();

    expect([...translator.translate({ type: 'thread.started', thread_id: 'thread-1' })]).toEqual([
      { type: 'system', sessionId: 'thread-1' },
    ]);
  });

  test('translates agent messages into text deltas', () => {
    expect([
      ...translateCodexEvent({
        type: 'item.completed',
        item: { id: 'item-1', type: 'agent_message', text: 'hello' },
      }),
    ]).toEqual([{ type: 'text', delta: 'hello' }]);
  });

  test('treats upstream API rate-limit agent messages as terminal errors', () => {
    const message = 'API Error: Request rejected (429) · upstream error: {"error":{"message":"Too Many Requests","code":"-4399"}}';

    expect([
      ...translateCodexEvent({
        type: 'item.completed',
        item: { id: 'item-1', type: 'agent_message', text: message },
      }),
    ]).toEqual([{ type: 'error', message }]);
  });

  test('translates command execution lifecycle into tool events', () => {
    const started = translateCodexEvent({
      type: 'item.started',
      item: { id: 'cmd-1', type: 'command_execution', command: 'npm test' },
    });
    const completed = translateCodexEvent({
      type: 'item.completed',
      item: {
        id: 'cmd-1',
        type: 'command_execution',
        command: 'npm test',
        output: 'ok',
        exit_code: 0,
      },
    });

    expect([...started]).toEqual([
      { type: 'tool_use', id: 'cmd-1', name: 'Bash', input: { command: 'npm test' } },
    ]);
    expect([...completed]).toEqual([
      { type: 'tool_result', id: 'cmd-1', output: 'ok', isError: false },
    ]);
  });

  test('marks command execution failures as tool errors', () => {
    expect([
      ...translateCodexEvent({
        type: 'item.completed',
        item: {
          id: 'cmd-1',
          type: 'command_execution',
          command: 'npm test',
          output: 'failed',
          exit_code: 1,
        },
      }),
    ]).toEqual([{ type: 'tool_result', id: 'cmd-1', output: 'failed', isError: true }]);
  });

  test('uses aggregated output for completed command execution results', () => {
    expect([
      ...translateCodexEvent({
        type: 'item.completed',
        item: {
          id: 'cmd-1',
          type: 'command_execution',
          command: 'npm test',
          aggregated_output: 'combined output',
          exit_code: 0,
        },
      }),
    ]).toEqual([
      { type: 'tool_result', id: 'cmd-1', output: 'combined output', isError: false },
    ]);
  });

  test('translates reasoning and plan updates into thinking/progress', () => {
    expect([
      ...translateCodexEvent({
        type: 'item.completed',
        item: { id: 'r1', type: 'reasoning', text: 'thinking' },
      }),
    ]).toEqual([{ type: 'thinking', delta: 'thinking' }]);

    expect([
      ...translateCodexEvent({
        type: 'item.completed',
        item: { id: 'p1', type: 'plan_update', text: 'checking files' },
      }),
    ]).toEqual([{ type: 'progress', phase: 'thinking', label: 'checking files' }]);
  });

  test('translates usage and done on turn completion with remembered session id', () => {
    const translator = createCodexTranslator();
    [...translator.translate({ type: 'thread.started', thread_id: 'thread-1' })];

    expect([
      ...translator.translate({
        type: 'turn.completed',
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    ]).toEqual([
      { type: 'usage', inputTokens: 10, outputTokens: 5 },
      { type: 'done', sessionId: 'thread-1' },
    ]);
  });

  test('translates top-level codex errors into non-terminal progress', () => {
    expect([...translateCodexEvent({ type: 'error', message: 'Reconnecting... 1/5' })]).toEqual([
      { type: 'progress', phase: 'thinking', label: 'Reconnecting... 1/5' },
    ]);
  });

  test('treats top-level upstream API rate-limit errors as terminal errors', () => {
    const message = 'API Error: Request rejected (429) · upstream error: {"error":{"message":"Too Many Requests"}}';

    expect([...translateCodexEvent({ type: 'error', message })]).toEqual([{ type: 'error', message }]);
  });

  test('keeps failed turns terminal', () => {
    expect([...translateCodexEvent({ type: 'turn.failed', error: { message: 'nope' } })]).toEqual([
      { type: 'error', message: 'nope' },
    ]);
  });

  test('translates command item updates into progress to refresh activity', () => {
    expect([
      ...translateCodexEvent({
        type: 'item.updated',
        item: { id: 'cmd-1', type: 'command_execution', command: 'npm test', aggregated_output: 'still running' },
      }),
    ]).toEqual([{ type: 'progress', phase: 'tool_running', label: 'npm test', detail: 'still running' }]);
  });

  test('records top-level codex errors without making them terminal immediately', () => {
    const translator = createCodexTranslator();

    expect([...translator.translate({ type: 'error', message: 'authentication required' })]).toEqual([
      { type: 'progress', phase: 'thinking', label: 'authentication required' },
    ]);
    expect(translator.lastTopLevelError()).toBe('authentication required');
  });

  test('ignores unknown shapes', () => {
    expect([...translateCodexEvent({ type: 'unknown', item: { type: 'mystery' } })]).toEqual([]);
    expect([...translateCodexEvent(null)]).toEqual([]);
  });
});

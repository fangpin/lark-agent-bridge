import { describe, expect, test } from 'vitest';
import { renderCard } from '../../src/card/run-renderer';
import { initialState, reduce, type RunState } from '../../src/card/run-state';
import { renderText } from '../../src/card/text-renderer';

function doneState(): RunState {
  return {
    blocks: [{ kind: 'text', content: '任务结果', streaming: false }],
    todos: [],
    reasoning: { content: '', active: false },
    footer: null,
    terminal: 'done',
  };
}

describe('run renderers', () => {
  test('shows a starting footer before the agent is ready', () => {
    expect(renderText({ ...initialState })).toBe('_🚀 正在启动 Agent…_');
  });

  test('keeps a completed footer in markdown reply mode', () => {
    expect(renderText(doneState())).toBe('任务结果\n\n_✅ 已完成_');
  });

  test('keeps a completed footer and removes the stop button in card reply mode', () => {
    const card = renderCard(doneState()) as { body: { elements: Array<Record<string, unknown>> } };

    expect(card.body.elements.at(-1)).toMatchObject({
      tag: 'markdown',
      content: '_✅ 已完成_',
      text_size: 'notation',
    });
    expect(card.body.elements.some((element) => element.tag === 'button')).toBe(false);
  });

  test('preserves the empty-result note before the completed card footer', () => {
    const card = renderCard({ ...doneState(), blocks: [] }) as {
      body: { elements: Array<Record<string, unknown>> };
    };

    expect(card.body.elements).toMatchObject([
      { tag: 'markdown', content: '_（未返回内容）_', text_size: 'notation' },
      { tag: 'markdown', content: '_✅ 已完成_', text_size: 'notation' },
    ]);
  });

  test('turns TodoWrite calls into a task board instead of a tool block', () => {
    const state = reduce(initialState, {
      type: 'tool_use',
      id: 'tool-1',
      name: 'TodoWrite',
      input: {
        todos: [
          { id: 'explore', content: '梳理代码路径', status: 'completed' },
          { id: 'implement', content: '实现任务看板', status: 'in_progress' },
          { id: 'verify', content: '运行测试', status: 'pending' },
        ],
      },
    });

    expect(state.blocks).toEqual([]);
    expect(renderText(state)).toContain('📋 **任务看板** · 1/3 完成 · 当前: 实现任务看板');

    const card = renderCard(state) as {
      config: { summary: { content: string } };
      body: { elements: Array<Record<string, unknown>> };
    };
    expect(card.config.summary.content).toBe('正在调用工具 · 1/3 完成 · 当前: 实现任务看板');
    expect(card.body.elements[0]).toMatchObject({
      tag: 'collapsible_panel',
      expanded: true,
    });
  });

  test('merges TodoWrite updates by id when requested', () => {
    const first = reduce(initialState, {
      type: 'tool_use',
      id: 'tool-1',
      name: 'TodoWrite',
      input: {
        todos: [
          { id: 'explore', content: '梳理代码路径', status: 'in_progress' },
          { id: 'verify', content: '运行测试', status: 'pending' },
        ],
      },
    });
    const next = reduce(first, {
      type: 'tool_use',
      id: 'tool-2',
      name: 'TodoWrite',
      input: {
        merge: true,
        todos: [{ id: 'explore', content: '梳理代码路径', status: 'completed' }],
      },
    });

    expect(next.todos).toEqual([
      { id: 'explore', content: '梳理代码路径', status: 'completed' },
      { id: 'verify', content: '运行测试', status: 'pending' },
    ]);
  });
});

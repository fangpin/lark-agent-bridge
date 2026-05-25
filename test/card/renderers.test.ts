import { describe, expect, test } from 'vitest';
import { renderCard } from '../../src/card/run-renderer';
import { initialState, type RunState } from '../../src/card/run-state';
import { renderText } from '../../src/card/text-renderer';

function doneState(): RunState {
  return {
    blocks: [{ kind: 'text', content: '任务结果', streaming: false }],
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
});

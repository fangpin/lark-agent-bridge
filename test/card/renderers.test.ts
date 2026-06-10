import { describe, expect, test } from 'vitest';
import { renderCard } from '../../src/card/run-renderer';
import { createInitialState, initialState, reduce, type RunState } from '../../src/card/run-state';
import { renderText } from '../../src/card/text-renderer';

function doneState(): RunState {
  return {
    ...createInitialState(),
    blocks: [{ kind: 'text', content: '任务结果', streaming: false }],
    todos: [],
    reasoning: { content: '', active: false },
    footer: null,
    terminal: 'done',
  };
}

describe('run renderers', () => {
  test('shows a starting footer before the agent is ready', () => {
    expect(renderText({ ...initialState })).toBe('_🚀 正在启动 Agent_');
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

  test('adds code resend buttons for completed card code blocks', () => {
    const card = renderCard({
      ...doneState(),
      blocks: [
        {
          kind: 'text',
          content: 'Use this:\n\n```ts\nconst answer = 42;\n```\n\nDone.',
          streaming: false,
        },
      ],
    }) as { body: { elements: Array<Record<string, unknown>> } };

    expect(card.body.elements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tag: 'button',
          text: { tag: 'plain_text', content: '发送代码 1' },
          behaviors: [{ type: 'callback', value: { cmd: 'copy.code', code: 'const answer = 42;' } }],
        }),
      ]),
    );
    expect(JSON.stringify(card)).not.toContain('__claude_cb');
    expect(JSON.stringify(card)).not.toContain('"type":"copy"');
  });

  test('shows runtime progress for tracked running cards', () => {
    const state = createInitialState('run-1');
    const card = renderCard(state) as { body: { elements: Array<Record<string, unknown>> } };

    expect(card.body.elements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tag: 'markdown',
          content: expect.stringContaining('运行'),
        }),
      ]),
    );
  });

  test('shows a retry button on failed tracked cards', () => {
    const card = renderCard({
      ...createInitialState('run-err'),
      terminal: 'error',
      footer: null,
      errorMsg: 'network timeout',
    }) as { body: { elements: Array<Record<string, unknown>> } };

    expect(card.body.elements.at(-1)).toMatchObject({
      tag: 'button',
      behaviors: [{ type: 'callback', value: { cmd: 'retry', run_id: 'run-err' } }],
    });
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

  test('turns TaskCreate calls into a task board instead of a bare tool block', () => {
    const state = reduce(initialState, {
      type: 'tool_use',
      id: 'tool-1',
      name: 'TaskCreate',
      input: {
        subject: '修复工具展示',
        description: '让 TaskCreate 在卡片里显示具体任务内容',
        activeForm: '修复工具展示',
      },
    });

    expect(state.blocks).toEqual([]);
    expect(renderText(state)).toContain('📋 **任务看板** · 0/1 完成 · 当前: 修复工具展示');
    expect(renderText(state)).not.toContain('TaskCreate');
  });

  test('applies TaskUpdate status changes to the task board', () => {
    const created = reduce(initialState, {
      type: 'tool_use',
      id: 'tool-1',
      name: 'TaskCreate',
      input: {
        subject: '定位根因',
        description: '找出为什么任务工具没有内容',
      },
    });
    const updated = reduce(created, {
      type: 'tool_use',
      id: 'tool-2',
      name: 'TaskUpdate',
      input: {
        taskId: '1',
        status: 'completed',
      },
    });

    expect(updated.blocks).toEqual([]);
    expect(renderText(updated)).toContain('📋 **任务看板** · 1/1 完成');
    expect(renderText(updated)).not.toContain('TaskUpdate');
  });

  test('recognizes updateTodos aliases as the task board source', () => {
    const state = reduce(initialState, {
      type: 'tool_use',
      id: 'tool-1',
      name: 'updateTodos',
      input: {
        todos: [{ id: 'review', content: '优化卡片展示', status: 'in_progress' }],
      },
    });

    expect(state.blocks).toEqual([]);
    expect(renderText(state)).toContain('📋 **任务看板** · 0/1 完成 · 当前: 优化卡片展示');
  });

  test('renders every task board item instead of folding overflow items', () => {
    const state = reduce(initialState, {
      type: 'tool_use',
      id: 'tool-1',
      name: 'TodoWrite',
      input: {
        todos: Array.from({ length: 8 }, (_, index) => ({
          id: `task-${index + 1}`,
          content: `任务 ${index + 1}`,
          status: index === 0 ? 'in_progress' : 'pending',
        })),
      },
    });

    const text = renderText(state);
    expect(text).toContain('任务 1');
    expect(text).toContain('任务 8');
    expect(text).not.toContain('…还有');

    const card = renderCard(state) as { body: { elements: Array<{ elements?: Array<{ content?: string }> }> } };
    const boardMarkdown = card.body.elements[0]?.elements?.[0]?.content;
    expect(boardMarkdown).toContain('任务 1');
    expect(boardMarkdown).toContain('任务 8');
    expect(boardMarkdown).not.toContain('…还有');
  });

  test('suppresses low-signal context tools from user-facing output', () => {
    const afterRead = reduce(initialState, {
      type: 'tool_use',
      id: 'read-1',
      name: 'read',
      input: { path: '/tmp/project/src/bot/channel.ts' },
    });
    const afterShell = reduce(afterRead, {
      type: 'tool_use',
      id: 'shell-1',
      name: 'shell',
      input: { command: 'git status --short --branch' },
    });
    const done = reduce(afterShell, { type: 'done' });

    expect(renderText(done)).not.toContain('git status');
    expect(renderText(done)).not.toContain('channel.ts');

    const card = renderCard(done) as { body: { elements: Array<Record<string, unknown>> } };
    expect(JSON.stringify(card)).not.toContain('git status');
    expect(JSON.stringify(card)).not.toContain('channel.ts');
  });

  test('shows the invoked skill name in Skill tool summaries', () => {
    const state = reduce(initialState, {
      type: 'tool_use',
      id: 'skill-1',
      name: 'Skill',
      input: { skill: 'superpowers:systematic-debugging' },
    });
    const completed = reduce(state, {
      type: 'tool_result',
      id: 'skill-1',
      output: 'Launching skill: superpowers:systematic-debugging',
      isError: false,
    });
    const done = reduce(completed, { type: 'done' });

    const text = renderText(done);
    expect(text).toContain('✅ **Skill** — superpowers:systematic-debugging');
    expect(text).not.toContain('✅ **Skill**\n\n');

    const card = renderCard(done) as { body: { elements: Array<Record<string, unknown>> } };
    expect(JSON.stringify(card)).toContain('✅ **Skill** — superpowers:systematic-debugging');
  });

  test('caps markdown tool lines to keep streaming cards small', () => {
    let state = initialState;
    for (let i = 0; i < 12; i++) {
      state = reduce(state, {
        type: 'tool_use',
        id: `edit-${i}`,
        name: 'edit',
        input: { file_path: `/tmp/project/file-${i}.ts` },
      });
    }
    state = reduce(state, { type: 'done' });

    const text = renderText(state);
    expect(text).toContain('已折叠 4 个工具步骤');
    expect(text).toContain('file-7.ts');
    expect(text).not.toContain('file-8.ts');
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

  test('shows the current tool summary in the running card footer', () => {
    const state = reduce(initialState, {
      type: 'tool_use',
      id: 'tool-1',
      name: 'Bash',
      input: { command: 'npm test' },
    });
    const card = renderCard(state) as { body: { elements: Array<Record<string, unknown>> } };

    expect(card.body.elements.at(-2)).toMatchObject({
      tag: 'markdown',
      content: '⏳ **终端** — npm test',
      text_size: 'notation',
    });
  });

  test('renders progress text as a replaceable markdown footer', () => {
    const state = reduce(initialState, {
      type: 'progress',
      phase: 'thinking',
      label: 'Inspecting workspace',
    });

    expect(renderText(state)).toBe('_🧠 Inspecting workspace_');
  });
});

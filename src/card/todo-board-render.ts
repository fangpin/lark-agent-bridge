import type { TodoItem, TodoStatus } from './run-state';

const MAX_VISIBLE_TODOS = 6;
const TODO_CONTENT_MAX = 90;

export function todoSummaryText(todos: TodoItem[]): string {
  if (todos.length === 0) return '';
  const completed = todos.filter((todo) => todo.status === 'completed').length;
  const active = todos.find((todo) => todo.status === 'in_progress');
  const suffix = active ? ` · 当前: ${truncate(oneLine(active.content), 28)}` : '';
  return `${completed}/${todos.length} 完成${suffix}`;
}

export function renderTodoBoard(todos: TodoItem[], running: boolean): object | undefined {
  if (todos.length === 0) return undefined;
  return {
    tag: 'collapsible_panel',
    expanded: running,
    header: panelHeader(`📋 **任务看板** · ${todoSummaryText(todos)}`),
    border: { color: 'blue', corner_radius: '5px' },
    vertical_spacing: '8px',
    padding: '8px 8px 8px 8px',
    elements: [{ tag: 'markdown', content: renderTodoMarkdown(todos), text_size: 'notation' }],
  };
}

export function renderTodoMarkdown(todos: TodoItem[]): string {
  const visible = todos.slice(0, MAX_VISIBLE_TODOS);
  const lines = visible.map((todo) => `${statusIcon(todo.status)} ${truncate(oneLine(todo.content), TODO_CONTENT_MAX)}`);
  const hidden = todos.length - visible.length;
  if (hidden > 0) lines.push(`…还有 ${hidden} 项`);
  return lines.join('\n');
}

function panelHeader(titleMd: string): object {
  return {
    title: { tag: 'markdown', content: titleMd },
    vertical_align: 'center',
    icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', size: '16px 16px' },
    icon_position: 'follow_text',
    icon_expanded_angle: -180,
  };
}

function statusIcon(status: TodoStatus): string {
  switch (status) {
    case 'completed':
      return '✅';
    case 'in_progress':
      return '🔄';
    case 'cancelled':
      return '⏹';
    case 'pending':
      return '☐';
  }
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

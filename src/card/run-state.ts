import type { AgentEvent } from '../agent/types';

export type ToolStatus = 'running' | 'done' | 'error';

export interface ToolEntry {
  id: string;
  name: string;
  input: unknown;
  status: ToolStatus;
  output?: string;
}

export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';

export interface TodoItem {
  id: string;
  createToolId?: string;
  content: string;
  status: TodoStatus;
}

export type Block =
  | { kind: 'text'; content: string; streaming: boolean }
  | { kind: 'tool'; tool: ToolEntry };

export type FooterStatus = 'starting' | 'thinking' | 'tool_running' | 'streaming' | null;
export type ActivityEntry =
  | { kind: 'phase'; phase: Exclude<FooterStatus, null>; label?: string; detail?: string }
  | { kind: 'tool'; tool: ToolEntry };
export type Terminal = 'running' | 'done' | 'interrupted' | 'error' | 'idle_timeout';

export interface RunState {
  runId?: string;
  blocks: Block[];
  todos: TodoItem[];
  reasoning: { content: string; active: boolean };
  footer: FooterStatus;
  activity?: ActivityEntry;
  terminal: Terminal;
  errorMsg?: string;
  startedAt: number;
  updatedAt: number;
  lastActivityAt: number;
  /** Set when terminal === 'idle_timeout' — how long claude was idle before
   * the watchdog gave up (so the message can say "N 分钟无响应"). */
  idleTimeoutMinutes?: number;
}

export function createInitialState(runId?: string): RunState {
  const now = Date.now();
  return {
    runId,
    blocks: [],
    todos: [],
    reasoning: { content: '', active: false },
    footer: 'starting',
    activity: { kind: 'phase', phase: 'starting' },
    terminal: 'running',
    startedAt: now,
    updatedAt: now,
    lastActivityAt: now,
  };
}

export const initialState: RunState = createInitialState();

export function markAgentReady(state: RunState): RunState {
  if (state.footer !== 'starting') return state;
  return touch({ ...state, footer: 'thinking', activity: { kind: 'phase', phase: 'thinking' } });
}

function closeStreamingText(blocks: Block[]): Block[] {
  return blocks.map((b) =>
    b.kind === 'text' && b.streaming ? { ...b, streaming: false } : b,
  );
}

export function reduce(state: RunState, evt: AgentEvent): RunState {
  switch (evt.type) {
    case 'text': {
      const last = state.blocks[state.blocks.length - 1];
      if (last && last.kind === 'text' && last.streaming) {
        const next: Block = { ...last, content: last.content + evt.delta };
        return touch({
          ...state,
          blocks: [...state.blocks.slice(0, -1), next],
          reasoning: { ...state.reasoning, active: false },
          footer: 'streaming',
          activity: { kind: 'phase', phase: 'streaming' },
        });
      }
      return touch({
        ...state,
        blocks: [...state.blocks, { kind: 'text', content: evt.delta, streaming: true }],
        reasoning: { ...state.reasoning, active: false },
        footer: 'streaming',
        activity: { kind: 'phase', phase: 'streaming' },
      });
    }

    case 'thinking': {
      return touch({
        ...state,
        reasoning: { content: state.reasoning.content + evt.delta, active: true },
        footer: 'thinking',
        activity: {
          kind: 'phase',
          phase: 'thinking',
          detail: summarizeActivityText(evt.delta),
        },
      });
    }

    case 'progress': {
      const phase: Exclude<FooterStatus, null> = evt.phase ?? state.footer ?? 'thinking';
      return touch({
        ...state,
        footer: phase,
        activity: {
          kind: 'phase',
          phase,
          label: summarizeActivityText(evt.label),
          detail: summarizeActivityText(evt.detail),
        },
      });
    }

    case 'tool_use': {
      const tool: ToolEntry = {
        id: evt.id,
        name: evt.name,
        input: evt.input,
        status: 'running',
      };
      const todoWrite = readTodoWriteInput(evt.name, evt.input);
      if (todoWrite) {
        return touch({
          ...state,
          todos: applyTodoWrite(state.todos, todoWrite),
          reasoning: { ...state.reasoning, active: false },
          footer: 'tool_running',
          activity: { kind: 'phase', phase: 'tool_running', label: '更新任务看板' },
        });
      }
      const taskTool = readTaskToolInput(evt.name, evt.input, state.todos);
      if (taskTool) {
        return touch({
          ...state,
          todos: applyTaskTool(state.todos, taskTool, evt.id),
          reasoning: { ...state.reasoning, active: false },
          footer: 'tool_running',
          activity: { kind: 'phase', phase: 'tool_running', label: '更新任务看板' },
        });
      }
      return touch({
        ...state,
        blocks: [...closeStreamingText(state.blocks), { kind: 'tool', tool }],
        reasoning: { ...state.reasoning, active: false },
        footer: 'tool_running',
        activity: { kind: 'tool', tool },
      });
    }

    case 'tool_result': {
      const taskCreateResult = readTaskCreateResult(evt.output);
      if (taskCreateResult) {
        return touch({
          ...state,
          todos: applyTaskCreateResult(state.todos, taskCreateResult, evt.id),
        });
      }

      let completedTool: ToolEntry | undefined;
      const blocks = state.blocks.map((b) => {
        if (b.kind !== 'tool' || b.tool.id !== evt.id) return b;
        completedTool = {
          ...b.tool,
          status: evt.isError ? ('error' as const) : ('done' as const),
          output: evt.output,
        };
        return {
          ...b,
          tool: completedTool,
        };
      });
      return touch({
        ...state,
        blocks,
        activity:
          completedTool && state.activity?.kind === 'tool' && state.activity.tool.id === evt.id
            ? { kind: 'tool', tool: completedTool }
            : state.activity,
      });
    }

    case 'error': {
      return touch({ ...state, terminal: 'error', errorMsg: evt.message, footer: null, activity: undefined });
    }

    case 'done': {
      return touch({
        ...state,
        blocks: closeStreamingText(state.blocks),
        reasoning: { ...state.reasoning, active: false },
        terminal: 'done',
        footer: null,
        activity: undefined,
      });
    }

    default:
      return state;
  }
}

export function markInterrupted(state: RunState): RunState {
  return touch({
    ...state,
    blocks: closeStreamingText(state.blocks),
    reasoning: { ...state.reasoning, active: false },
    terminal: 'interrupted',
    footer: null,
    activity: undefined,
  });
}

export function markIdleTimeout(state: RunState, minutes: number): RunState {
  return touch({
    ...state,
    blocks: closeStreamingText(state.blocks),
    reasoning: { ...state.reasoning, active: false },
    terminal: 'idle_timeout',
    footer: null,
    activity: undefined,
    idleTimeoutMinutes: minutes,
  });
}

export function finalizeIfRunning(state: RunState): RunState {
  if (state.terminal !== 'running') return state;
  return touch({
    ...state,
    blocks: closeStreamingText(state.blocks),
    reasoning: { ...state.reasoning, active: false },
    terminal: 'done',
    footer: null,
    activity: undefined,
  });
}

function touch(state: RunState): RunState {
  const now = Date.now();
  return { ...state, updatedAt: now, lastActivityAt: now };
}

function readTodoWriteInput(
  name: string,
  input: unknown,
): { todos: TodoItem[]; merge: boolean } | undefined {
  if (!isTodoWriteTool(name)) return undefined;
  if (!input || typeof input !== 'object') return undefined;
  const rec = input as Record<string, unknown>;
  if (!Array.isArray(rec.todos)) return undefined;

  const todos = rec.todos.flatMap((raw, idx): TodoItem[] => {
    if (!raw || typeof raw !== 'object') return [];
    const item = raw as Record<string, unknown>;
    const content = typeof item.content === 'string' ? item.content.trim() : '';
    if (!content) return [];
    const status = readTodoStatus(item.status);
    if (!status) return [];
    const id = typeof item.id === 'string' && item.id.trim() ? item.id.trim() : String(idx + 1);
    return [{ id, content, status }];
  });

  return { todos, merge: rec.merge === true };
}

function isTodoWriteTool(name: string): boolean {
  const normalized = normalizedToolName(name);
  return normalized === 'todowrite' || normalized === 'updatetodos' || normalized === 'todoupdate';
}

function readTaskToolInput(
  name: string,
  input: unknown,
  existing: TodoItem[],
):
  | { kind: 'create'; todo: TodoItem }
  | { kind: 'update'; id: string; status?: TodoStatus; content?: string }
  | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const rec = input as Record<string, unknown>;
  const normalized = normalizedToolName(name);
  if (normalized === 'taskcreate') {
    const content = readTaskContent(rec);
    if (!content) return undefined;
    return {
      kind: 'create',
      todo: {
        id: String(existing.length + 1),
        content,
        status: 'in_progress',
      },
    };
  }
  if (normalized !== 'taskupdate') return undefined;
  const id = typeof rec.taskId === 'string' && rec.taskId.trim() ? rec.taskId.trim() : '';
  if (!id) return undefined;
  const status = readTodoStatus(rec.status);
  const content = readTaskContent(rec);
  if (!status && !content) return undefined;
  return { kind: 'update', id, status, content };
}

function readTaskContent(rec: Record<string, unknown>): string | undefined {
  for (const key of ['subject', 'description', 'activeForm']) {
    const value = rec[key];
    if (typeof value !== 'string') continue;
    const content = value.replace(/\s+/g, ' ').trim();
    if (content) return content;
  }
  return undefined;
}

function readTodoStatus(status: unknown): TodoStatus | undefined {
  return status === 'pending' ||
    status === 'in_progress' ||
    status === 'completed' ||
    status === 'cancelled'
    ? status
    : undefined;
}

function applyTodoWrite(
  existing: TodoItem[],
  update: { todos: TodoItem[]; merge: boolean },
): TodoItem[] {
  if (!update.merge) return update.todos;
  const byId = new Map(existing.map((todo) => [todo.id, todo]));
  for (const todo of update.todos) {
    byId.set(todo.id, todo);
  }
  return Array.from(byId.values());
}

function readTaskCreateResult(output: string): { taskId: string } | undefined {
  const match = output.match(/^Task #(\S+) created successfully:/);
  const taskId = match?.[1];
  if (!taskId) return undefined;
  return { taskId };
}

function applyTaskCreateResult(existing: TodoItem[], result: { taskId: string }, toolId: string): TodoItem[] {
  const pendingIndex = existing.findIndex((todo) => todo.createToolId === toolId);
  if (pendingIndex < 0) return existing;
  return existing.map((todo, index) => (index === pendingIndex ? { ...todo, id: result.taskId } : todo));
}

function applyTaskTool(
  existing: TodoItem[],
  update: { kind: 'create'; todo: TodoItem } | { kind: 'update'; id: string; status?: TodoStatus; content?: string },
  toolId: string,
): TodoItem[] {
  if (update.kind === 'create') return [...existing, { ...update.todo, createToolId: toolId }];
  return existing.map((todo) =>
    todo.id === update.id
      ? {
          ...todo,
          content: update.content ?? todo.content,
          status: update.status ?? todo.status,
        }
      : todo,
  );
}

function normalizedToolName(name: string): string {
  return name.replace(/^functions\./, '').replace(/[_\s-]/g, '').toLowerCase();
}

function summarizeActivityText(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const oneLine = value.replace(/\s+/g, ' ').trim();
  if (!oneLine) return undefined;
  return oneLine.length > 140 ? `${oneLine.slice(0, 140)}…` : oneLine;
}

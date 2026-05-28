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
  content: string;
  status: TodoStatus;
}

export type Block =
  | { kind: 'text'; content: string; streaming: boolean }
  | { kind: 'tool'; tool: ToolEntry };

export type FooterStatus = 'starting' | 'thinking' | 'tool_running' | 'streaming' | null;
export type Terminal = 'running' | 'done' | 'interrupted' | 'error' | 'idle_timeout';

export interface RunState {
  blocks: Block[];
  todos: TodoItem[];
  reasoning: { content: string; active: boolean };
  footer: FooterStatus;
  terminal: Terminal;
  errorMsg?: string;
  /** Set when terminal === 'idle_timeout' — how long claude was idle before
   * the watchdog gave up (so the message can say "N 分钟无响应"). */
  idleTimeoutMinutes?: number;
}

export const initialState: RunState = {
  blocks: [],
  todos: [],
  reasoning: { content: '', active: false },
  footer: 'starting',
  terminal: 'running',
};

export function markAgentReady(state: RunState): RunState {
  if (state.footer !== 'starting') return state;
  return { ...state, footer: 'thinking' };
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
        return {
          ...state,
          blocks: [...state.blocks.slice(0, -1), next],
          reasoning: { ...state.reasoning, active: false },
          footer: 'streaming',
        };
      }
      return {
        ...state,
        blocks: [...state.blocks, { kind: 'text', content: evt.delta, streaming: true }],
        reasoning: { ...state.reasoning, active: false },
        footer: 'streaming',
      };
    }

    case 'thinking': {
      return {
        ...state,
        reasoning: { content: state.reasoning.content + evt.delta, active: true },
        footer: 'thinking',
      };
    }

    case 'tool_use': {
      const tool: ToolEntry = {
        id: evt.id,
        name: evt.name,
        input: evt.input,
        status: 'running',
      };
      const todos = readTodoWriteInput(evt.name, evt.input);
      if (todos) {
        return {
          ...state,
          todos: applyTodoWrite(state.todos, todos),
          reasoning: { ...state.reasoning, active: false },
          footer: 'tool_running',
        };
      }
      return {
        ...state,
        blocks: [...closeStreamingText(state.blocks), { kind: 'tool', tool }],
        reasoning: { ...state.reasoning, active: false },
        footer: 'tool_running',
      };
    }

    case 'tool_result': {
      const blocks = state.blocks.map((b) => {
        if (b.kind !== 'tool' || b.tool.id !== evt.id) return b;
        return {
          ...b,
          tool: {
            ...b.tool,
            status: evt.isError ? ('error' as const) : ('done' as const),
            output: evt.output,
          },
        };
      });
      return { ...state, blocks };
    }

    case 'error': {
      return { ...state, terminal: 'error', errorMsg: evt.message, footer: null };
    }

    case 'done': {
      return {
        ...state,
        blocks: closeStreamingText(state.blocks),
        reasoning: { ...state.reasoning, active: false },
        terminal: 'done',
        footer: null,
      };
    }

    default:
      return state;
  }
}

export function markInterrupted(state: RunState): RunState {
  return {
    ...state,
    blocks: closeStreamingText(state.blocks),
    reasoning: { ...state.reasoning, active: false },
    terminal: 'interrupted',
    footer: null,
  };
}

export function markIdleTimeout(state: RunState, minutes: number): RunState {
  return {
    ...state,
    blocks: closeStreamingText(state.blocks),
    reasoning: { ...state.reasoning, active: false },
    terminal: 'idle_timeout',
    footer: null,
    idleTimeoutMinutes: minutes,
  };
}

export function finalizeIfRunning(state: RunState): RunState {
  if (state.terminal !== 'running') return state;
  return {
    ...state,
    blocks: closeStreamingText(state.blocks),
    reasoning: { ...state.reasoning, active: false },
    terminal: 'done',
    footer: null,
  };
}

function readTodoWriteInput(
  name: string,
  input: unknown,
): { todos: TodoItem[]; merge: boolean } | undefined {
  if (name !== 'TodoWrite') return undefined;
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

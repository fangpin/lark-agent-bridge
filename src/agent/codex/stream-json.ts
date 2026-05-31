import type { AgentEvent } from '../types';

interface CodexRawEvent {
  type?: string;
  thread_id?: string;
  item?: CodexItem;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cached_input_tokens?: number;
    reasoning_output_tokens?: number;
  };
  error?: unknown;
  message?: string;
}

interface CodexItem {
  id?: string;
  type?: string;
  text?: string;
  summary?: string;
  command?: string;
  aggregated_output?: unknown;
  output?: unknown;
  exit_code?: number;
  status?: string;
}

export interface CodexTranslator {
  translate(raw: unknown): Generator<AgentEvent>;
}

export function createCodexTranslator(): CodexTranslator {
  let sessionId: string | undefined;
  return {
    *translate(raw: unknown): Generator<AgentEvent> {
      for (const event of translateCodexEvent(raw, sessionId)) {
        if (event.type === 'system' && event.sessionId) sessionId = event.sessionId;
        yield event;
      }
    },
  };
}

export function* translateCodexEvent(raw: unknown, rememberedSessionId?: string): Generator<AgentEvent> {
  if (!raw || typeof raw !== 'object') return;
  const evt = raw as CodexRawEvent;

  if (evt.type === 'thread.started' && typeof evt.thread_id === 'string' && evt.thread_id) {
    yield { type: 'system', sessionId: evt.thread_id };
    return;
  }

  if (evt.type === 'item.started' || evt.type === 'item.completed') {
    yield* translateItemEvent(evt);
    return;
  }

  if (evt.type === 'turn.completed') {
    if (evt.usage) {
      yield {
        type: 'usage',
        inputTokens: evt.usage.input_tokens,
        outputTokens: evt.usage.output_tokens,
      };
    }
    yield { type: 'done', sessionId: rememberedSessionId };
    return;
  }

  if (evt.type === 'turn.failed') {
    yield { type: 'error', message: errorMessage(evt.error ?? evt.message ?? evt) };
    return;
  }

  if (evt.type === 'error') {
    const message = errorMessage(evt.error ?? evt.message);
    if (message) yield { type: 'progress', phase: 'thinking', label: message };
  }
}

function* translateItemEvent(evt: CodexRawEvent): Generator<AgentEvent> {
  const item = evt.item;
  if (!item || typeof item !== 'object') return;
  const id = typeof item.id === 'string' && item.id ? item.id : 'codex-item';

  if (item.type === 'agent_message' && evt.type === 'item.completed' && item.text) {
    yield { type: 'text', delta: item.text };
    return;
  }

  if (item.type === 'command_execution') {
    if (evt.type === 'item.started') {
      yield { type: 'tool_use', id, name: 'Bash', input: { command: item.command ?? '' } };
    } else if (evt.type === 'item.completed') {
      yield {
        type: 'tool_result',
        id,
        output: stringifyOutput(item.aggregated_output ?? item.output),
        isError: typeof item.exit_code === 'number' ? item.exit_code !== 0 : item.status === 'failed',
      };
    }
    return;
  }

  if (item.type === 'reasoning' && evt.type === 'item.completed') {
    const text = item.text ?? item.summary;
    if (text) yield { type: 'thinking', delta: text };
    return;
  }

  if ((item.type === 'plan_update' || item.type === 'plan') && evt.type === 'item.completed') {
    const label = item.text ?? item.summary;
    if (label) yield { type: 'progress', phase: 'thinking', label };
  }
}

function stringifyOutput(output: unknown): string {
  if (typeof output === 'string') return output;
  if (output === undefined || output === null) return '';
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

function errorMessage(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.message === 'string') return record.message;
  }
  return String(value);
}

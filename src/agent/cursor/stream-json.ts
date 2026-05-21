import type { AgentEvent } from '../types';

interface ContentBlock {
  type?: string;
  text?: string;
}

interface CursorRawEvent {
  type?: string;
  subtype?: string;
  session_id?: string;
  cwd?: string;
  model?: string;
  text?: string;
  message?: { content?: string | ContentBlock[] };
  usage?: { inputTokens?: number; outputTokens?: number };
  tool_call?: Record<string, { args?: unknown; result?: unknown }>;
  call_id?: string;
}

export function* translateEvent(raw: unknown): Generator<AgentEvent> {
  if (!raw || typeof raw !== 'object') return;
  const evt = raw as CursorRawEvent;

  if (evt.type === 'system' && evt.subtype === 'init') {
    yield {
      type: 'system',
      sessionId: evt.session_id,
      cwd: evt.cwd,
      model: evt.model,
    };
    return;
  }

  if (evt.type === 'thinking' && evt.subtype === 'delta' && typeof evt.text === 'string' && evt.text) {
    yield { type: 'thinking', delta: evt.text };
    return;
  }

  if (evt.type === 'assistant' && evt.message?.content) {
    const content = evt.message.content;
    if (typeof content === 'string') {
      if (content) yield { type: 'text', delta: content };
      return;
    }
    for (const block of content) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text) {
        yield { type: 'text', delta: block.text };
      }
    }
    return;
  }

  if (evt.type === 'tool_call') {
    const parsed = parseToolCall(evt);
    if (!parsed) return;
    if (evt.subtype === 'started') {
      yield { type: 'tool_use', id: parsed.id, name: parsed.name, input: parsed.args ?? {} };
    } else if (evt.subtype === 'completed') {
      yield {
        type: 'tool_result',
        id: parsed.id,
        output: stringifyToolResult(parsed.result),
        isError: isErrorResult(parsed.result),
      };
    }
    return;
  }

  if (evt.type === 'result') {
    if (evt.usage) {
      yield {
        type: 'usage',
        inputTokens: evt.usage.inputTokens,
        outputTokens: evt.usage.outputTokens,
      };
    }
    yield { type: 'done', sessionId: evt.session_id };
  }
}

function parseToolCall(evt: CursorRawEvent): { id: string; name: string; args?: unknown; result?: unknown } | undefined {
  if (!evt.call_id || !evt.tool_call) return undefined;
  const entries = Object.entries(evt.tool_call);
  const [rawName, payload] = entries[0] ?? [];
  if (!rawName || !payload || typeof payload !== 'object') return undefined;
  return {
    id: evt.call_id,
    name: rawName.replace(/ToolCall$/, ''),
    args: payload.args,
    result: payload.result,
  };
}

function stringifyToolResult(result: unknown): string {
  if (typeof result === 'string') return result;
  if (result === undefined) return '';
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

function isErrorResult(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false;
  const record = result as Record<string, unknown>;
  return record.error === true || record.is_error === true || record.isError === true || typeof record.error === 'string';
}

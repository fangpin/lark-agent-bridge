import type { AgentEvent } from '../types';

/** Minimal SDK message shape — avoids importing @cursor/sdk in the main bundle. */
export interface SdkMessageLike {
  type?: string;
  subtype?: string;
  agent_id?: string;
  call_id?: string;
  name?: string;
  status?: string;
  text?: string;
  args?: unknown;
  result?: unknown;
  message?: {
    role?: string;
    content?: Array<{ type?: string; text?: string; id?: string; name?: string; input?: unknown }>;
  };
  model?: { id?: string };
}

export function* translateSdkMessage(msg: SdkMessageLike): Generator<AgentEvent> {
  if (msg.type === 'system' && msg.subtype === 'init') {
    yield {
      type: 'system',
      sessionId: msg.agent_id,
      model: typeof msg.model?.id === 'string' ? msg.model.id : undefined,
    };
    return;
  }

  if (msg.type === 'thinking' && typeof msg.text === 'string' && msg.text) {
    yield { type: 'thinking', delta: msg.text };
    return;
  }

  if (msg.type === 'status' && typeof msg.status === 'string') {
    yield {
      type: 'progress',
      phase: phaseForSdkStatus(msg.status),
      label: labelForSdkStatus(msg.status, msg.text),
    };
    return;
  }

  if (msg.type === 'task') {
    const label = typeof msg.text === 'string' && msg.text.trim() ? msg.text : msg.status;
    if (typeof label === 'string' && label.trim()) {
      yield { type: 'progress', phase: 'thinking', label };
    }
    return;
  }

  if (msg.type === 'assistant' && msg.message?.content) {
    for (const block of msg.message.content) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text) {
        yield { type: 'text', delta: block.text };
      }
      if (block.type === 'tool_use' && block.id && block.name) {
        yield { type: 'tool_use', id: block.id, name: block.name, input: block.input ?? {} };
      }
    }
    return;
  }

  if (msg.type === 'tool_call' && msg.call_id && msg.name) {
    if (msg.status === 'running') {
      yield { type: 'tool_use', id: msg.call_id, name: msg.name, input: msg.args ?? {} };
    } else if (msg.status === 'completed' || msg.status === 'error') {
      yield {
        type: 'tool_result',
        id: msg.call_id,
        output: stringifyResult(msg.result),
        isError: msg.status === 'error' || isErrorResult(msg.result),
      };
    }
  }
}

function phaseForSdkStatus(status: string): 'starting' | 'thinking' | 'tool_running' | 'streaming' {
  switch (status) {
    case 'CREATING':
      return 'starting';
    case 'FINISHED':
      return 'streaming';
    case 'RUNNING':
    case 'ERROR':
    case 'CANCELLED':
    case 'EXPIRED':
    default:
      return 'thinking';
  }
}

function labelForSdkStatus(status: string, message: unknown): string {
  if (typeof message === 'string' && message.trim()) return message;
  switch (status) {
    case 'CREATING':
      return '正在创建 Agent';
    case 'RUNNING':
      return 'Agent 正在运行';
    case 'FINISHED':
      return 'Agent 正在收尾';
    case 'ERROR':
      return 'Agent 状态异常';
    case 'CANCELLED':
      return 'Agent 已取消';
    case 'EXPIRED':
      return 'Agent 已过期';
    default:
      return `Agent 状态: ${status}`;
  }
}

function stringifyResult(result: unknown): string {
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
  return record.error === true || record.is_error === true || typeof record.error === 'string';
}

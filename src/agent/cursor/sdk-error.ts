import { CursorAgentError } from '@cursor/sdk';

export type SdkErrorKind = 'auth' | 'rate_limit' | 'network' | 'config' | 'cancelled' | 'unknown';

export interface SdkErrorDescription {
  kind: SdkErrorKind;
  /** Single-line headline for cards and short logs. */
  headline: string;
  /** Multi-line detail for stderr / bridge logs. */
  detail: string;
  hint?: string;
}

const AUTH_HINT =
  'Cursor 需要 API Key：在 config.json 配置 preferences.agentCursorApiKey（推荐加密：' +
  'lark-channel-bridge secrets set --id cursor-api-key），或 export CURSOR_API_KEY；' +
  '也可将 agentCursorRuntime 设为 "cli" 以使用 `agent login` 会话。';

function getCause(err: unknown): unknown {
  if (!err || typeof err !== 'object') return undefined;
  if ('cause' in err && (err as { cause?: unknown }).cause !== err) {
    return (err as { cause?: unknown }).cause;
  }
  return undefined;
}

function errorName(err: unknown): string {
  if (!err || typeof err !== 'object') return 'Error';
  if ('name' in err && typeof (err as { name?: unknown }).name === 'string') {
    return (err as { name: string }).name;
  }
  return 'Error';
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === 'string') return err;
  return String(err);
}

function errorCode(err: unknown): string | number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  if ('code' in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' || typeof code === 'number') return code;
  }
  return undefined;
}

function connectRawMessage(err: unknown): string | undefined {
  if (!err || typeof err !== 'object' || !('rawMessage' in err)) return undefined;
  const raw = (err as { rawMessage?: unknown }).rawMessage;
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

function sdkExtras(err: unknown): string[] {
  if (!(err instanceof CursorAgentError)) return [];
  const parts: string[] = [];
  if (err.code) parts.push(`code=${err.code}`);
  if (err.status !== undefined) parts.push(`status=${err.status}`);
  if (err.operation) parts.push(`operation=${err.operation}`);
  if (err.endpoint) parts.push(`endpoint=${err.endpoint}`);
  if (err.requestId) parts.push(`requestId=${err.requestId}`);
  parts.push(`retryable=${err.isRetryable}`);
  return parts;
}

function classifyKind(err: unknown): SdkErrorKind {
  if (err instanceof CursorAgentError) {
    const name = errorName(err);
    if (name === 'AuthenticationError' || err.code === 'unauthenticated') return 'auth';
    if (name === 'RateLimitError') return 'rate_limit';
    if (name === 'NetworkError') return 'network';
    if (name === 'ConfigurationError') return 'config';
  }
  if (errorName(err) === 'ConfigurationError') return 'config';
  if (errorMessage(err).includes('Cannot use this model')) return 'config';
  const code = errorCode(err);
  if (code === 'unauthenticated' || code === 16) return 'auth';
  if (typeof code === 'number' && code === 8) return 'rate_limit'; // Connect Code.ResourceExhausted
  const msg = errorMessage(err).toLowerCase();
  if (msg.includes('unauthenticated') || msg.includes('authentication') || msg.includes('api key')) {
    return 'auth';
  }
  if (msg.includes('cancelled') || msg.includes('canceled')) return 'cancelled';
  if (
    msg.includes('econnrefused') ||
    msg.includes('econnreset') ||
    msg.includes('socket hang up') ||
    msg.includes('network') ||
    msg.includes('timeout')
  ) {
    return 'network';
  }
  return 'unknown';
}

function formatChainLine(err: unknown, depth: number): string {
  const name = errorName(err);
  const msg = errorMessage(err);
  const raw = connectRawMessage(err);
  const code = errorCode(err);
  const extras = sdkExtras(err);
  const bits = [`${'  '.repeat(depth)}${name}: ${msg}`];
  if (raw && raw !== msg) bits.push(`raw=${raw}`);
  if (code !== undefined) bits.push(`code=${code}`);
  if (extras.length > 0) bits.push(extras.join(', '));
  return bits.join(' | ');
}

function headlineForKind(kind: SdkErrorKind, root: unknown): string {
  const msg = errorMessage(root);
  switch (kind) {
    case 'auth':
      return msg && msg !== 'Error' ? `Cursor API 鉴权失败: ${msg}` : 'Cursor API 鉴权失败 (unauthenticated)';
    case 'rate_limit':
      return `Cursor API 限流: ${msg}`;
    case 'network':
      return `Cursor API 网络错误: ${msg}`;
    case 'config':
      return `Cursor SDK 配置错误: ${msg}`;
    case 'cancelled':
      return 'Cursor agent run cancelled';
    default:
      return msg || 'Cursor SDK error';
  }
}

/** Walk the error chain and build a multi-line diagnostic string. */
export function describeSdkError(err: unknown): SdkErrorDescription {
  const lines: string[] = [];
  let current: unknown = err;
  let depth = 0;
  let kind: SdkErrorKind = 'unknown';

  while (current && depth < 8) {
    lines.push(formatChainLine(current, depth));
    const k = classifyKind(current);
    if (k !== 'unknown') kind = k;
    current = getCause(current);
    depth += 1;
  }

  const headline = headlineForKind(kind, err);
  const hint =
    kind === 'auth'
      ? AUTH_HINT
      : kind === 'rate_limit'
        ? '稍后重试，或降低并发（maxConcurrentRuns / agentSessionPoolSize）。'
        : undefined;

  const detail = [headline, ...lines, hint].filter(Boolean).join('\n');
  return { kind, headline, detail, hint };
}

export function isCursorAgentNotFoundError(err: unknown, agentId: string): boolean {
  const msg = errorMessage(err);
  if (!msg.includes(`Agent ${agentId} not found`)) return false;
  if (errorName(err) !== 'ConfigurationError') return false;
  if (err instanceof CursorAgentError && err.operation !== 'Agent.resume') return false;
  if (
    err &&
    typeof err === 'object' &&
    'operation' in err &&
    (err as { operation?: unknown }).operation !== 'Agent.resume'
  ) {
    return false;
  }
  return true;
}

export function isCursorAgentActiveRunError(err: unknown, agentId: string): boolean {
  const msg = errorMessage(err);
  if (!msg.includes(`Agent ${agentId} already has active run`)) return false;
  if (err instanceof CursorAgentError && err.operation !== 'agent.send') return false;
  if (
    err &&
    typeof err === 'object' &&
    'operation' in err &&
    (err as { operation?: unknown }).operation !== 'agent.send'
  ) {
    return false;
  }
  return true;
}

export function isCursorRateLimitError(err: unknown): boolean {
  return describeSdkError(err).kind === 'rate_limit';
}

/** Message sent over IPC to the bridge and shown on failure cards. */
export function formatSdkErrorForIpc(phase: string, err: unknown): string {
  const d = describeSdkError(err);
  const parts = [`${phase}: ${d.headline}`];
  const rest = d.detail.split('\n').filter((line) => line !== d.headline && line !== d.hint);
  if (rest.length > 0) parts.push(...rest);
  if (d.hint) parts.push(d.hint);
  return parts.join('\n');
}

/** Full diagnostic for worker stderr (never truncated by the logger). */
export function formatSdkErrorForStderr(phase: string, err: unknown): string {
  const d = describeSdkError(err);
  return [`[sdk-worker] ${phase}`, d.detail, d.hint].filter(Boolean).join('\n');
}

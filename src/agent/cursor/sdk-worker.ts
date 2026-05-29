import { Agent } from '@cursor/sdk';
import type { SDKAgent } from '@cursor/sdk';
import {
  formatSdkErrorForIpc,
  formatSdkErrorForStderr,
  isCursorAgentActiveRunError,
  isCursorAgentNotFoundError,
  isCursorNetworkError,
  isCursorRateLimitError,
} from './sdk-error';
import { buildCursorPrompt } from './spawn-run';
import { translateSdkMessage, type SdkMessageLike } from './sdk-translate';
import type { AgentEvent } from '../types';

export interface SdkWorkerConfig {
  model: { id: string; params?: Array<{ id: string; value: string }> };
  apiKey?: string;
}

type WorkerRequest =
  | { type: 'ensure'; id: string; cwd: string; agentId?: string }
  | { type: 'run'; id: string; prompt: string }
  | { type: 'stop'; id: string }
  | { type: 'shutdown' };

type WorkerResponse =
  | { type: 'ready' }
  | { type: 'agent'; id: string; agentId: string }
  | { type: 'event'; id: string; event: AgentEvent }
  | { type: 'done'; id: string; agentId: string }
  | { type: 'error'; id?: string; message: string; fatal?: boolean };

function readConfig(): SdkWorkerConfig | undefined {
  const raw = process.env.LARK_CURSOR_SDK_CONFIG;
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as SdkWorkerConfig;
  } catch {
    return undefined;
  }
}

const config = readConfig();
let agent: SDKAgent | undefined;
let agentCwd: string | undefined;
let activeRunId: string | undefined;
let activeAbort: (() => void) | undefined;
let ensureQueue: Promise<void> = Promise.resolve();
let runQueue: Promise<void> = Promise.resolve();
let pendingRunRecoveryNotes: string[] = [];

const RATE_LIMIT_RETRY_DELAYS_MS = [1000, 2500, 5000];
const RECOVERY_NOTE_MAX = 6;

function send(msg: WorkerResponse): void {
  if (typeof process.send === 'function') process.send(msg);
}

function reportWorkerError(
  phase: string,
  err: unknown,
  runId?: string,
  recoveryNotes: string[] = [],
  fatal = false,
): void {
  process.stderr.write(`${formatSdkErrorForStderr(phase, err)}\n`);
  send({
    type: 'error',
    id: runId,
    message: withWorkerRecoveryHint(withRecoverySummary(formatSdkErrorForIpc(phase, err), recoveryNotes), fatal),
    fatal,
  });
}

async function withRecoverableRetry<T>(
  label: string,
  task: () => Promise<T>,
  recoveryNotes?: string[],
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await task();
    } catch (err) {
      const delayMs = RATE_LIMIT_RETRY_DELAYS_MS[attempt];
      const kind = isCursorRateLimitError(err)
        ? '限流'
        : isCursorNetworkError(err)
          ? '网络错误'
          : undefined;
      if (delayMs === undefined || !kind) throw err;
      addRecoveryNote(
        recoveryNotes,
        `${label} 遇到${kind}，已自动重试 ${attempt + 1}/${RATE_LIMIT_RETRY_DELAYS_MS.length} 次`,
      );
      process.stderr.write(
        `[sdk-worker] ${label} recoverable ${kind}; retrying in ${delayMs}ms (attempt ${attempt + 2})\n`,
      );
      await sleep(delayMs);
    }
  }
}

function agentOptions(cwd: string): {
  model: SdkWorkerConfig['model'];
  apiKey?: string;
  local: { cwd: string };
} {
  return {
    ...(config?.apiKey ? { apiKey: config.apiKey } : {}),
    model: config!.model,
    local: { cwd },
  };
}

function queueEnsure(task: () => Promise<void>): void {
  ensureQueue = ensureQueue.then(task).catch((err) => {
    reportWorkerError('sdk ensure failed', err);
  });
}

function queueRun(id: string, task: () => Promise<void>): void {
  runQueue = runQueue.then(task).catch((err) => {
    reportWorkerError('sdk run queue failed', err, id);
  });
}

async function ensureAgent(id: string, cwd: string, agentId?: string): Promise<void> {
  if (!config) {
    send({ type: 'error', id, message: 'sdk worker config missing' });
    return;
  }
  if (agent && agent.agentId === agentId) {
    send({ type: 'agent', id, agentId: agent.agentId });
    return;
  }
  if (agent) {
    try {
      agent.close();
    } catch {
      /* ignore */
    }
    agent = undefined;
  }

  const opts = agentOptions(cwd);
  const recoveryNotes: string[] = [];

  try {
    if (agentId) {
      try {
        agent = await withRecoverableRetry('Agent.resume', () => Agent.resume(agentId, opts), recoveryNotes);
      } catch (err) {
        if (!isCursorAgentNotFoundError(err, agentId)) throw err;
        process.stderr.write(
          `[sdk-worker] stale SDK agent ${agentId}; creating a replacement session\n`,
        );
        addRecoveryNote(
          recoveryNotes,
          `旧 SDK session 不可恢复，已自动创建 replacement session`,
        );
        agent = await withRecoverableRetry('Agent.create', () => Agent.create(opts), recoveryNotes);
      }
    } else {
      agent = await withRecoverableRetry('Agent.create', () => Agent.create(opts), recoveryNotes);
    }
    agentCwd = cwd;
    if (id.startsWith('ensure-')) stashRunRecoveryNotes(recoveryNotes);
    send({ type: 'agent', id, agentId: agent.agentId });
  } catch (err) {
    reportWorkerError('sdk agent init failed', err, id);
  }
}

async function sendPromptWithStaleSessionRecovery(
  id: string,
  prompt: string,
  recoveryNotes: string[],
): Promise<Awaited<ReturnType<SDKAgent['send']>>> {
  if (!agent) throw new Error('sdk worker agent not initialized');
  try {
    return await withRecoverableRetry('agent.send', () => agent!.send(buildCursorPrompt(prompt)), recoveryNotes);
  } catch (err) {
    const staleAgentId = agent.agentId;
    if (!agentCwd || !isCursorAgentActiveRunError(err, staleAgentId)) throw err;
    const replacementCwd = agentCwd;

    process.stderr.write(
      `[sdk-worker] SDK agent ${staleAgentId} still has an active run; creating a replacement session\n`,
    );
    addRecoveryNote(
      recoveryNotes,
      `检测到旧 SDK session 仍有 active run，已自动创建 replacement session`,
    );
    try {
      agent.close();
    } catch {
      /* ignore */
    }
    agent = await withRecoverableRetry('Agent.create', () => Agent.create(agentOptions(replacementCwd)), recoveryNotes);
    send({ type: 'event', id, event: { type: 'system', sessionId: agent.agentId, cwd: replacementCwd } });
    return await withRecoverableRetry('agent.send', () => agent!.send(buildCursorPrompt(prompt)), recoveryNotes);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function handleRun(id: string, prompt: string): Promise<void> {
  if (!agent) {
    send({ type: 'error', id, message: 'sdk worker agent not initialized' });
    return;
  }
  if (activeRunId) {
    send({ type: 'error', id, message: 'run already active in sdk worker' });
    return;
  }

  activeRunId = id;
  const recoveryNotes = consumeRunRecoveryNotes();
  let cancelled = false;
  activeAbort = () => {
    cancelled = true;
  };

  try {
    const run = await sendPromptWithStaleSessionRecovery(id, prompt, recoveryNotes);
    activeAbort = () => {
      cancelled = true;
      void run.cancel().catch(() => {});
    };

    try {
      for await (const msg of run.stream()) {
        if (cancelled) break;
        for (const event of translateSdkMessage(msg as SdkMessageLike)) {
          send({ type: 'event', id, event });
        }
      }
    } catch (streamErr) {
      reportWorkerError('sdk run stream failed', streamErr, id, recoveryNotes, true);
      return;
    }

    if (cancelled) {
      send({ type: 'error', id, message: 'run cancelled' });
      return;
    }

    const result = await run.wait();
    if (result.status === 'error') {
      const message = withWorkerRecoveryHint(withRecoverySummary(formatRunResultError(result), recoveryNotes), true);
      process.stderr.write(`[sdk-worker] ${message}\n`);
      send({
        type: 'error',
        id,
        message,
        fatal: true,
      });
      return;
    }
    send({ type: 'done', id, agentId: agent.agentId });
  } catch (err) {
    reportWorkerError('sdk run failed', err, id, recoveryNotes, true);
  } finally {
    activeRunId = undefined;
    activeAbort = undefined;
  }
}

function formatRunResultError(result: Awaited<ReturnType<Awaited<ReturnType<SDKAgent['send']>>['wait']>>): string {
  const headline = `sdk run failed (runId=${result.id}, status=${result.status})`;
  if (typeof result.result === 'string' && result.result.trim()) {
    return `${headline}: ${result.result.trim()}`;
  }
  const diagnostic = safeJson({
    id: result.id,
    status: result.status,
    result: result.result,
  });
  return `${headline}; Cursor returned no error detail${diagnostic ? ` | result=${diagnostic}` : ''}`;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value).slice(0, 1200);
  } catch {
    return '';
  }
}

function addRecoveryNote(notes: string[] | undefined, note: string): void {
  if (!notes || notes.includes(note)) return;
  notes.push(note);
  if (notes.length > RECOVERY_NOTE_MAX) notes.splice(0, notes.length - RECOVERY_NOTE_MAX);
}

function stashRunRecoveryNotes(notes: string[]): void {
  for (const note of notes) addRecoveryNote(pendingRunRecoveryNotes, note);
}

function consumeRunRecoveryNotes(): string[] {
  const notes = pendingRunRecoveryNotes;
  pendingRunRecoveryNotes = [];
  return notes;
}

function withRecoverySummary(message: string, recoveryNotes: string[]): string {
  if (recoveryNotes.length === 0) return message;
  return [
    `已自动恢复/重试 ${recoveryNotes.length} 步：`,
    ...recoveryNotes.map((note) => `- ${note}`),
    '',
    `最终失败原因：${message}`,
  ].join('\n');
}

function withWorkerRecoveryHint(message: string, fatal: boolean): string {
  if (!fatal) return message;
  return `${message}\n\n已自动丢弃当前 SDK worker，下次消息会创建新的 worker/session。`;
}

process.on('uncaughtException', (err) => {
  reportWorkerError('uncaughtException', err, activeRunId, [], true);
  activeRunId = undefined;
  activeAbort = undefined;
});

process.on('unhandledRejection', (reason) => {
  reportWorkerError('unhandledRejection', reason, activeRunId, [], true);
  activeRunId = undefined;
  activeAbort = undefined;
});

process.on('message', (msg: WorkerRequest) => {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case 'ensure':
      if (agent && msg.agentId !== undefined && agent.agentId === msg.agentId) {
        send({ type: 'agent', id: msg.id, agentId: agent.agentId });
        return;
      }
      queueEnsure(() => ensureAgent(msg.id, msg.cwd, msg.agentId));
      return;
    case 'run':
      queueRun(msg.id, () => handleRun(msg.id, msg.prompt));
      return;
    case 'stop':
      if (activeRunId === msg.id) activeAbort?.();
      return;
    case 'shutdown':
      if (activeRunId) activeAbort?.();
      if (agent) {
        try {
          agent.close();
        } catch {
          /* ignore */
        }
      }
      process.exit(0);
      return;
    default:
      return;
  }
});

if (config) {
  send({ type: 'ready' });
} else {
  send({ type: 'error', message: 'sdk worker config missing' });
}

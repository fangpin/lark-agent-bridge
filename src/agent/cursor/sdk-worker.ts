import { Agent } from '@cursor/sdk';
import type { SDKAgent } from '@cursor/sdk';
import { formatSdkErrorForIpc, formatSdkErrorForStderr } from './sdk-error';
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
  | { type: 'error'; id?: string; message: string };

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
let activeRunId: string | undefined;
let activeAbort: (() => void) | undefined;
let ensureQueue: Promise<void> = Promise.resolve();
let runQueue: Promise<void> = Promise.resolve();

function send(msg: WorkerResponse): void {
  if (typeof process.send === 'function') process.send(msg);
}

function reportWorkerError(phase: string, err: unknown, runId?: string): void {
  process.stderr.write(`${formatSdkErrorForStderr(phase, err)}\n`);
  send({ type: 'error', id: runId, message: formatSdkErrorForIpc(phase, err) });
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

  const opts = {
    ...(config.apiKey ? { apiKey: config.apiKey } : {}),
    model: config.model,
    local: { cwd },
  };

  try {
    agent = agentId ? await Agent.resume(agentId, opts) : await Agent.create(opts);
    send({ type: 'agent', id, agentId: agent.agentId });
  } catch (err) {
    reportWorkerError('sdk agent init failed', err, id);
  }
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
  let cancelled = false;
  activeAbort = () => {
    cancelled = true;
  };

  try {
    const run = await agent.send(buildCursorPrompt(prompt));
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
      reportWorkerError('sdk run stream failed', streamErr, id);
      return;
    }

    if (cancelled) {
      send({ type: 'error', id, message: 'run cancelled' });
      return;
    }

    const result = await run.wait();
    if (result.status === 'error') {
      send({
        type: 'error',
        id,
        message: result.result ?? `sdk run failed (runId=${result.id}, status=${result.status})`,
      });
      return;
    }
    send({ type: 'done', id, agentId: agent.agentId });
  } catch (err) {
    reportWorkerError('sdk run failed', err, id);
  } finally {
    activeRunId = undefined;
    activeAbort = undefined;
  }
}

process.on('uncaughtException', (err) => {
  reportWorkerError('uncaughtException', err, activeRunId);
  activeRunId = undefined;
  activeAbort = undefined;
});

process.on('unhandledRejection', (reason) => {
  reportWorkerError('unhandledRejection', reason, activeRunId);
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

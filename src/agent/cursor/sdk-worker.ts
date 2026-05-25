import { Agent, CursorAgentError } from '@cursor/sdk';
import type { SDKAgent } from '@cursor/sdk';
import { buildCursorPrompt } from './spawn-run';
import { translateSdkMessage, type SdkMessageLike } from './sdk-translate';
import type { AgentEvent } from '../types';

export interface SdkWorkerConfig {
  defaultModel: string;
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

function send(msg: WorkerResponse): void {
  if (typeof process.send === 'function') process.send(msg);
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
    model: { id: config.defaultModel },
    local: { cwd },
  };

  try {
    agent = agentId ? await Agent.resume(agentId, opts) : await Agent.create(opts);
    send({ type: 'agent', id, agentId: agent.agentId });
  } catch (err) {
    const message =
      err instanceof CursorAgentError
        ? `sdk agent init failed: ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);
    send({ type: 'error', id, message });
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

    for await (const msg of run.stream()) {
      if (cancelled) break;
      for (const event of translateSdkMessage(msg as SdkMessageLike)) {
        send({ type: 'event', id, event });
      }
    }

    if (cancelled) {
      send({ type: 'error', id, message: 'run cancelled' });
      return;
    }

    const result = await run.wait();
    if (result.status === 'error') {
      send({ type: 'error', id, message: result.result ?? 'sdk run failed' });
      return;
    }
    send({ type: 'done', id, agentId: agent.agentId });
  } catch (err) {
    const message =
      err instanceof CursorAgentError
        ? `sdk run failed: ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);
    send({ type: 'error', id, message });
  } finally {
    activeRunId = undefined;
    activeAbort = undefined;
  }
}

process.on('message', (msg: WorkerRequest) => {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case 'ensure':
      void ensureAgent(msg.id, msg.cwd, msg.agentId);
      return;
    case 'run':
      void handleRun(msg.id, msg.prompt);
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

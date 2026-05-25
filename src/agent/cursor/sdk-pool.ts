import { fork, type ChildProcess } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from '../../core/logger';
import type { AgentEvent, AgentRun, AgentRunOptions } from '../types';
import { spawnCursorRun, type CursorSpawnOptions } from './spawn-run';
import type { SdkWorkerConfig } from './sdk-worker';

const DEFAULT_POOL_SIZE = 10;

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

interface PoolEntry {
  key: string;
  worker: WorkerHandle;
  agentId?: string;
  cwd?: string;
  scopeKey?: string;
  lastUsed: number;
  busy: boolean;
}

interface WorkerHandle {
  pid: number | null;
  ensure(cwd: string, agentId: string | undefined, reqId: string): Promise<string | undefined>;
  run(opts: AgentRunOptions, runId: string): AgentRun;
  stopRun(runId: string): void;
  shutdown(): Promise<void>;
}

export function poolKeyFor(opts: AgentRunOptions): string {
  const cwd = opts.cwd ?? process.cwd();
  if (opts.sessionId) return `${cwd}::session:${opts.sessionId}`;
  if (opts.poolKey) return `${cwd}::scope:${opts.poolKey}`;
  return `${cwd}::ephemeral:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
}

export class CursorSdkPool {
  private readonly entries = new Map<string, PoolEntry>();
  private readonly spawnOpts: CursorSpawnOptions;
  private readonly sdkConfig: SdkWorkerConfig;
  private readonly maxSize: number;
  private readonly workerScript: string;
  private nextRunId = 1;
  private nextReqId = 1;

  constructor(
    spawnOpts: CursorSpawnOptions,
    sdkConfig: SdkWorkerConfig,
    maxSize = DEFAULT_POOL_SIZE,
  ) {
    this.spawnOpts = spawnOpts;
    this.sdkConfig = sdkConfig;
    this.maxSize = Math.max(1, maxSize);
    this.workerScript = resolveWorkerScript();
  }

  async ensureAgent(scope: string, cwd: string, agentId?: string): Promise<string | undefined> {
    const key = `${cwd}::scope:${scope}`;
    const entry = await this.acquireEntry(key, { prompt: '', cwd, poolKey: scope, sessionId: agentId });
    if (!entry) return undefined;
    const reqId = String(this.nextReqId++);
    const id = await entry.worker.ensure(cwd, agentId, reqId);
    if (id) {
      entry.agentId = id;
      if (agentId !== id) {
        const sessionKey = `${cwd}::session:${id}`;
        entry.key = sessionKey;
        this.entries.delete(key);
        this.entries.set(sessionKey, entry);
      }
    }
    return id;
  }

  run(opts: AgentRunOptions): AgentRun {
    const key = poolKeyFor(opts);
    const entry = this.acquireEntrySync(key, opts);
    if (!entry) {
      log.warn('agent', 'sdk-pool-busy-fallback', { key });
      return spawnCursorRun(this.spawnOpts, opts);
    }
    const runId = String(this.nextRunId++);
    entry.busy = true;
    entry.lastUsed = Date.now();
    log.info('agent', 'sdk-pool-run', {
      key: entry.key,
      sessionId: opts.sessionId ?? null,
      poolKey: opts.poolKey ?? null,
      pid: entry.worker.pid,
    });
    const inner = entry.worker.run(opts, runId);
    return {
      events: this.releaseWhenDone(entry, inner.events),
      stop: () => inner.stop(),
      waitForExit: (timeoutMs) => inner.waitForExit(timeoutMs),
    };
  }

  noteSessionId(opts: AgentRunOptions, sessionId: string): void {
    const currentKey = poolKeyFor(opts);
    const entry = this.entries.get(currentKey);
    if (!entry || entry.agentId === sessionId) return;
    const nextKey = `${opts.cwd ?? process.cwd()}::session:${sessionId}`;
    if (this.entries.has(nextKey)) {
      void this.removeEntry(currentKey);
      return;
    }
    entry.agentId = sessionId;
    entry.key = nextKey;
    this.entries.delete(currentKey);
    this.entries.set(nextKey, entry);
    log.info('agent', 'sdk-pool-rekey', { from: currentKey, to: nextKey });
  }

  async evictScope(scope: string, cwd?: string): Promise<void> {
    const suffix = `::scope:${scope}`;
    const keys = [...this.entries.keys()].filter((key) => {
      if (!key.endsWith(suffix)) return false;
      if (!cwd) return true;
      return key.startsWith(`${cwd}::`);
    });
    await Promise.all(keys.map((key) => this.removeEntry(key)));
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((key) => this.removeEntry(key)));
  }

  private async *releaseWhenDone(
    entry: PoolEntry,
    events: AsyncIterable<AgentEvent>,
  ): AsyncGenerator<AgentEvent> {
    try {
      for await (const event of events) yield event;
    } finally {
      entry.busy = false;
      entry.lastUsed = Date.now();
      this.touch(entry);
    }
  }

  private acquireEntrySync(key: string, opts: AgentRunOptions): PoolEntry | undefined {
    const existing = this.entries.get(key);
    if (existing?.busy) return undefined;
    if (existing) {
      existing.lastUsed = Date.now();
      this.touch(existing);
      return existing;
    }
    void this.evictIfNeeded();
    const worker = createWorker(this.workerScript, this.sdkConfig);
    const entry: PoolEntry = {
      key,
      worker,
      agentId: opts.sessionId,
      cwd: opts.cwd,
      scopeKey: opts.poolKey,
      lastUsed: Date.now(),
      busy: false,
    };
    this.entries.set(key, entry);
    this.touch(entry);
    log.info('agent', 'sdk-pool-create', { key, pid: worker.pid });
    return entry;
  }

  private async acquireEntry(key: string, opts: AgentRunOptions): Promise<PoolEntry | undefined> {
    const entry = this.acquireEntrySync(key, opts);
    if (!entry) return undefined;
    if (entry.agentId && opts.sessionId === entry.agentId) return entry;
    const reqId = String(this.nextReqId++);
    const agentId = await entry.worker.ensure(opts.cwd ?? process.cwd(), opts.sessionId, reqId);
    if (agentId) entry.agentId = agentId;
    return entry;
  }

  private touch(entry: PoolEntry): void {
    this.entries.delete(entry.key);
    this.entries.set(entry.key, entry);
  }

  private async evictIfNeeded(): Promise<void> {
    while (this.entries.size >= this.maxSize) {
      const victim = [...this.entries.values()].find((entry) => !entry.busy);
      if (!victim) break;
      await this.removeEntry(victim.key);
    }
  }

  private async removeEntry(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    await entry.worker.shutdown();
    log.info('agent', 'sdk-pool-evict', { key, pid: entry.worker.pid });
  }
}

function resolveWorkerScript(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'cursor-sdk-worker.js');
}

function createWorker(script: string, sdkConfig: SdkWorkerConfig): WorkerHandle {
  const child = fork(script, [], {
    env: {
      ...process.env,
      LARK_CURSOR_SDK_WORKER: '1',
      LARK_CURSOR_SDK_CONFIG: JSON.stringify(sdkConfig),
    },
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });

  const pendingRuns = new Map<
    string,
    {
      pushEvent: (event: AgentEvent) => void;
      finish: (agentId?: string) => void;
      fail: (message: string) => void;
    }
  >();

  const pendingEnsures = new Map<
    string,
    { resolve: (agentId: string | undefined) => void; reject: (msg: string) => void }
  >();

  child.on('message', (msg: WorkerResponse) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'event') {
      pendingRuns.get(msg.id)?.pushEvent(msg.event);
      return;
    }
    if (msg.type === 'done') {
      pendingRuns.get(msg.id)?.finish(msg.agentId);
      pendingRuns.delete(msg.id);
      return;
    }
    if (msg.type === 'agent') {
      pendingEnsures.get(msg.id)?.resolve(msg.agentId);
      pendingEnsures.delete(msg.id);
      return;
    }
    if (msg.type === 'error') {
      if (msg.id && pendingRuns.has(msg.id)) {
        pendingRuns.get(msg.id)?.fail(msg.message);
        pendingRuns.delete(msg.id);
      } else if (msg.id && pendingEnsures.has(msg.id)) {
        pendingEnsures.get(msg.id)?.reject(msg.message);
        pendingEnsures.delete(msg.id);
      }
    }
  });

  child.on('exit', (code, signal) => {
    log.warn('agent', 'sdk-worker-exit', { pid: child.pid ?? null, code, signal });
    for (const [id, handlers] of pendingRuns) {
      handlers.fail(`sdk worker exited (${code ?? signal ?? 'unknown'})`);
      pendingRuns.delete(id);
    }
    for (const [id, handlers] of pendingEnsures) {
      handlers.reject('sdk worker exited');
      pendingEnsures.delete(id);
    }
  });

  return {
    pid: child.pid ?? null,
    ensure(cwd, agentId, reqId) {
      return new Promise<string | undefined>((resolve, reject) => {
        pendingEnsures.set(reqId, {
          resolve: (id) => resolve(id),
          reject: (msg) => {
            log.warn('agent', 'sdk-ensure-failed', { message: msg });
            resolve(undefined);
          },
        });
        child.send?.({ type: 'ensure', id: reqId, cwd, agentId } satisfies WorkerRequest);
        setTimeout(() => {
          if (!pendingEnsures.has(reqId)) return;
          pendingEnsures.delete(reqId);
          resolve(undefined);
        }, 60_000);
      });
    },
    run(opts, runId) {
      let pushEvent: ((event: AgentEvent) => void) | undefined;
      let finish: ((agentId?: string) => void) | undefined;
      let fail: ((message: string) => void) | undefined;

      const events = (async function* (): AsyncGenerator<AgentEvent> {
        const queue: AgentEvent[] = [];
        let done = false;
        let errorMsg: string | undefined;
        let notify: (() => void) | undefined;

        pushEvent = (event) => {
          queue.push(event);
          notify?.();
        };
        finish = () => {
          done = true;
          notify?.();
        };
        fail = (message) => {
          errorMsg = message;
          done = true;
          notify?.();
        };

        pendingRuns.set(runId, {
          pushEvent: pushEvent!,
          finish: finish!,
          fail: fail!,
        });

        const cwd = opts.cwd ?? process.cwd();
        const ensureId = `ensure-${runId}`;
        child.send?.({
          type: 'ensure',
          id: ensureId,
          cwd,
          agentId: opts.sessionId,
        } satisfies WorkerRequest);

        await new Promise<void>((resolve) => {
          const onAgent = (msg: WorkerResponse): void => {
            if (msg.type === 'agent' && msg.id === ensureId) {
              child.off('message', onAgent);
              resolve();
            }
            if (msg.type === 'error' && msg.id === ensureId) {
              child.off('message', onAgent);
              errorMsg = msg.message;
              done = true;
              resolve();
            }
          };
          child.on('message', onAgent);
          setTimeout(() => {
            child.off('message', onAgent);
            if (!done) {
              errorMsg = 'sdk worker ensure timed out';
              done = true;
            }
            resolve();
          }, 60_000);
        });

        if (!errorMsg) {
          child.send?.({ type: 'run', id: runId, prompt: opts.prompt } satisfies WorkerRequest);
        }

        while (!done || queue.length > 0) {
          if (queue.length === 0) {
            await new Promise<void>((resolve) => {
              notify = resolve;
            });
            notify = undefined;
            continue;
          }
          yield queue.shift()!;
        }

        pendingRuns.delete(runId);
        if (errorMsg) yield { type: 'error', message: errorMsg };
      })();

      return {
        events,
        async stop() {
          child.send?.({ type: 'stop', id: runId } satisfies WorkerRequest);
        },
        async waitForExit() {
          return true;
        },
      };
    },
    stopRun(runId) {
      child.send?.({ type: 'stop', id: runId } satisfies WorkerRequest);
    },
    async shutdown() {
      child.send?.({ type: 'shutdown' } satisfies WorkerRequest);
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve();
          return;
        }
        child.once('exit', () => resolve());
        setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
          resolve();
        }, 5000);
      });
    },
  };
}

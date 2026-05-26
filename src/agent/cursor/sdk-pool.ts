import { fork, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
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
  lastUsed: number;
  busy: boolean;
  pendingRuns: number;
}

interface WorkerHandle {
  pid: number | null;
  ensure(cwd: string, agentId: string | undefined, reqId: string): Promise<string | undefined>;
  run(opts: AgentRunOptions, runId: string, skipEnsure?: boolean): AgentRun;
  stopRun(runId: string): void;
  shutdown(): Promise<void>;
}

/** True when the pooled worker already holds the target Cursor agent session. */
function isPoolEntryReady(entry: PoolEntry, opts: AgentRunOptions): boolean {
  if (!entry.agentId) return false;
  if (!opts.sessionId) return true;
  return entry.agentId === opts.sessionId;
}

export function poolKeyFor(opts: AgentRunOptions): string {
  if (opts.sessionId) return sessionPoolKey(opts.sessionId);
  return ephemeralPoolKey();
}

function sessionPoolKey(sessionId: string): string {
  return `session:${sessionId}`;
}

function ephemeralPoolKey(prefix = 'ephemeral'): string {
  return `${prefix}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
}

export function doneEventForAgent(agentId?: string): AgentEvent {
  return agentId ? { type: 'done', sessionId: agentId } : { type: 'done' };
}

export function cachedSessionReadyEvent(agentId?: string): AgentEvent | undefined {
  return agentId ? { type: 'system', sessionId: agentId } : undefined;
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

  async ensureAgent(cwd: string, agentId?: string): Promise<string | undefined> {
    const key = agentId ? sessionPoolKey(agentId) : ephemeralPoolKey('precreate');
    const entry = this.acquireEntrySync(key, { prompt: '', cwd, sessionId: agentId });
    if (!entry) return undefined;
    const reqId = String(this.nextReqId++);
    const id = await entry.worker.ensure(cwd, agentId, reqId);
    if (id) {
      entry.agentId = id;
      const sessionKey = sessionPoolKey(id);
      if (entry.key !== sessionKey) {
        if (this.entries.has(sessionKey)) {
          await this.removeEntry(entry.key);
        } else {
          this.entries.delete(entry.key);
          entry.key = sessionKey;
          this.entries.set(sessionKey, entry);
        }
      }
    } else {
      await this.removeEntry(entry.key);
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
    entry.pendingRuns += 1;
    entry.busy = true;
    entry.lastUsed = Date.now();
    const skipEnsure = isPoolEntryReady(entry, opts);
    log.info('agent', 'sdk-pool-run', {
      key: entry.key,
      sessionId: opts.sessionId ?? null,
      poolKey: opts.poolKey ?? null,
      pid: entry.worker.pid,
      skipEnsure,
    });
    const inner = entry.worker.run(opts, runId, skipEnsure);
    const events = skipEnsure
      ? this.withInitialEvent(cachedSessionReadyEvent(entry.agentId), inner.events)
      : inner.events;
    return {
      events: this.releaseWhenDone(entry, events),
      stop: () => inner.stop(),
      waitForExit: (timeoutMs) => inner.waitForExit(timeoutMs),
    };
  }

  noteSessionId(opts: AgentRunOptions, sessionId: string): void {
    const currentKey = poolKeyFor(opts);
    const entry = this.entries.get(currentKey);
    if (!entry || entry.agentId === sessionId) return;
    const nextKey = sessionPoolKey(sessionId);
    if (entry.key === nextKey) {
      entry.agentId = sessionId;
      return;
    }
    const existing = this.entries.get(nextKey);
    if (existing && existing !== entry) {
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
    // SDK workers are keyed only by Cursor session id. Chat/topic scope is not
    // a reuse boundary, so scope eviction cannot identify a specific worker.
    void scope;
    void cwd;
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
      entry.pendingRuns = Math.max(0, entry.pendingRuns - 1);
      entry.busy = entry.pendingRuns > 0;
      entry.lastUsed = Date.now();
      this.touch(entry);
    }
  }

  private async *withInitialEvent(
    event: AgentEvent | undefined,
    events: AsyncIterable<AgentEvent>,
  ): AsyncGenerator<AgentEvent> {
    if (event) yield event;
    yield* events;
  }

  private acquireEntrySync(key: string, opts: AgentRunOptions): PoolEntry | undefined {
    const existing = this.entries.get(key);
    if (existing) {
      existing.lastUsed = Date.now();
      this.touch(existing);
      return existing;
    }
    void this.evictIfNeeded();
    let entry!: PoolEntry;
    const worker = createWorker(this.workerScript, this.sdkConfig, () => {
      if (this.entries.get(entry.key) === entry) {
        this.entries.delete(entry.key);
        log.warn('agent', 'sdk-pool-worker-died', { key: entry.key, pid: worker.pid });
      }
    });
    entry = {
      key,
      worker,
      agentId: undefined,
      cwd: opts.cwd,
      lastUsed: Date.now(),
      busy: false,
      pendingRuns: 0,
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

/** Package root (directory containing package.json). */
function resolvePackageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    dir = dirname(dir);
  }
  return dirname(fileURLToPath(import.meta.url));
}

/**
 * Worker is built as a separate entry at dist/agent/cursor/. When sdk-pool is
 * bundled into dist/cli.js, import.meta.url points at dist/cli.js — not the
 * worker directory — so we probe known layouts instead of a single sibling path.
 */
function resolveWorkerScript(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, 'agent', 'cursor', 'cursor-sdk-worker.js'),
    join(here, 'cursor-sdk-worker.js'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return join(here, 'agent', 'cursor', 'cursor-sdk-worker.js');
}

function ipcSend(child: ChildProcess, msg: WorkerRequest): boolean {
  if (!child.connected) return false;
  try {
    return child.send(msg);
  } catch (err) {
    log.warn('agent', 'sdk-ipc-send-failed', {
      message: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

function createWorker(
  script: string,
  sdkConfig: SdkWorkerConfig,
  onDead?: () => void,
): WorkerHandle {
  const packageRoot = resolvePackageRoot();
  const child = fork(script, [], {
    cwd: packageRoot,
    env: {
      ...process.env,
      LARK_CURSOR_SDK_WORKER: '1',
      LARK_CURSOR_SDK_CONFIG: JSON.stringify(sdkConfig),
    },
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });

  child.stderr?.on('data', (chunk: Buffer | string) => {
    const text = String(chunk).trimEnd();
    if (text) log.warn('agent', 'sdk-worker-stderr', { text });
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
      log.warn('agent', 'sdk-worker-error', {
        runId: msg.id ?? null,
        message: msg.message,
      });
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
    onDead?.();
    const exitMsg = `sdk worker exited (${code ?? signal ?? 'unknown'})`;
    log.warn('agent', 'sdk-worker-error', { message: exitMsg });
    for (const [id, handlers] of pendingRuns) {
      handlers.fail(exitMsg);
      pendingRuns.delete(id);
    }
    for (const [id, handlers] of pendingEnsures) {
      handlers.reject(exitMsg);
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
        if (!ipcSend(child, { type: 'ensure', id: reqId, cwd, agentId } satisfies WorkerRequest)) {
          reject('sdk worker ipc closed');
        }
        setTimeout(() => {
          if (!pendingEnsures.has(reqId)) return;
          pendingEnsures.delete(reqId);
          log.warn('agent', 'sdk-ensure-timeout', { reqId });
          resolve(undefined);
        }, 120_000);
      });
    },
    run(opts, runId, skipEnsure = false) {
      const queue: AgentEvent[] = [];
      let done = false;
      let errorMsg: string | undefined;
      let notify: (() => void) | undefined;

      const pushEvent = (event: AgentEvent) => {
        queue.push(event);
        notify?.();
      };
      const finish = (agentId?: string) => {
        queue.push(doneEventForAgent(agentId));
        done = true;
        notify?.();
      };
      const fail = (message: string) => {
        errorMsg = message;
        done = true;
        notify?.();
      };

      pendingRuns.set(runId, {
        pushEvent,
        finish,
        fail,
      });

      const start = async () => {
        if (!skipEnsure) {
          const cwd = opts.cwd ?? process.cwd();
          const ensureId = `ensure-${runId}`;
          await new Promise<string | undefined>((resolve) => {
            pendingEnsures.set(ensureId, {
              resolve: (id) => resolve(id),
              reject: (msg) => {
                fail(msg);
                resolve(undefined);
              },
            });
            if (
              !ipcSend(child, {
                type: 'ensure',
                id: ensureId,
                cwd,
                agentId: opts.sessionId,
              } satisfies WorkerRequest)
            ) {
              pendingEnsures.delete(ensureId);
              fail('sdk worker ipc closed');
              resolve(undefined);
              return;
            }
            setTimeout(() => {
              if (!pendingEnsures.has(ensureId)) return;
              pendingEnsures.delete(ensureId);
              fail('sdk worker ensure timed out');
              resolve(undefined);
            }, 120_000);
          });
        }

        if (!errorMsg) {
          if (!ipcSend(child, { type: 'run', id: runId, prompt: opts.prompt } satisfies WorkerRequest)) {
            fail('sdk worker ipc closed');
          }
        }
      };
      void start();

      const events = (async function* (): AsyncGenerator<AgentEvent> {
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
          ipcSend(child, { type: 'stop', id: runId } satisfies WorkerRequest);
        },
        async waitForExit() {
          return true;
        },
      };
    },
    stopRun(runId) {
      ipcSend(child, { type: 'stop', id: runId } satisfies WorkerRequest);
    },
    async shutdown() {
      ipcSend(child, { type: 'shutdown' } satisfies WorkerRequest);
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

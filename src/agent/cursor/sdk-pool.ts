import { fork, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from '../../core/logger';
import type { AgentEvent, AgentRun, AgentRunOptions, WorkerSnapshot } from '../types';
import { spawnCursorRun, type CursorSpawnOptions } from './spawn-run';
import type { SdkWorkerConfig } from './sdk-worker';

const DEFAULT_POOL_SIZE = 10;

type WorkerRequest =
  | { type: 'ensure'; id: string; cwd: string; agentId?: string; allowReplacement?: boolean }
  | { type: 'run'; id: string; prompt: string; allowReplacement?: boolean }
  | { type: 'stop'; id: string }
  | { type: 'shutdown' };

type WorkerResponse =
  | { type: 'ready' }
  | { type: 'agent'; id: string; agentId: string }
  | { type: 'event'; id: string; event: AgentEvent }
  | { type: 'done'; id: string; agentId: string }
  | { type: 'error'; id?: string; message: string; fatal?: boolean };

interface PoolEntry {
  key: string;
  worker: WorkerHandle;
  agentId?: string;
  cwd?: string;
  lastUsed: number;
  busy: boolean;
  pendingRuns: number;
  disposed: boolean;
  stopping: boolean;
  currentRunId?: string;
  currentRunStartedAt?: number;
  lastEventAt?: number;
  lastError?: string;
}

interface WorkerHandle {
  pid: number | null;
  ensure(
    cwd: string,
    agentId: string | undefined,
    reqId: string,
    allowReplacement?: boolean,
  ): Promise<string | undefined>;
  run(opts: SdkRunOptions, runId: string, skipEnsure?: boolean): AgentRun;
  stopRun(runId: string): void;
  shutdown(): Promise<void>;
}

type SdkRunOptions = AgentRunOptions & { allowSessionReplacement?: boolean };
type WorkerFactory = (
  script: string,
  sdkConfig: SdkWorkerConfig,
  onDead?: () => void,
) => WorkerHandle;

interface RunningAttempt {
  entry: PoolEntry;
  inner: AgentRun;
  events: AsyncIterable<AgentEvent>;
  released: Promise<void>;
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
  private readonly workerFactory: WorkerFactory;
  private nextRunId = 1;
  private nextReqId = 1;

  constructor(
    spawnOpts: CursorSpawnOptions,
    sdkConfig: SdkWorkerConfig,
    maxSize = DEFAULT_POOL_SIZE,
    workerFactory: WorkerFactory = createWorker,
  ) {
    this.spawnOpts = spawnOpts;
    this.sdkConfig = sdkConfig;
    this.maxSize = Math.max(1, maxSize);
    this.workerScript = resolveWorkerScript();
    this.workerFactory = workerFactory;
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
    let current = this.startAttempt(entry, opts, runId);
    const stopGraceMs = opts.stopGraceMs ?? 5000;
    return {
      events: this.resumeOnceAfterFatalWorkerError(current, opts, runId, (attempt) => {
        current = attempt;
      }),
      stop: async () => {
        const attempt = current;
        attempt.entry.stopping = true;
        try {
          await attempt.inner.stop();
          const settled = await waitFor(attempt.released, stopGraceMs);
          if (settled) return;
        } finally {
          attempt.entry.stopping = false;
        }
        log.warn('agent', 'sdk-pool-stop-timeout-evict', {
          key: attempt.entry.key,
          sessionId: attempt.entry.agentId,
          runId,
          pid: attempt.entry.worker.pid,
          graceMs: stopGraceMs,
          reason: 'stop did not settle run stream before grace timeout',
        });
        await this.removeEntryFor(attempt.entry);
      },
      waitForExit: (timeoutMs) => current.inner.waitForExit(timeoutMs),
    };
  }

  private startAttempt(entry: PoolEntry, opts: SdkRunOptions, runId: string): RunningAttempt {
    entry.pendingRuns += 1;
    entry.busy = true;
    entry.lastUsed = Date.now();
    entry.currentRunId = runId;
    entry.currentRunStartedAt = entry.lastUsed;
    entry.lastEventAt = entry.lastUsed;
    entry.lastError = undefined;
    const skipEnsure = isPoolEntryReady(entry, opts);
    log.info('agent', 'sdk-pool-run', {
      key: entry.key,
      sessionId: opts.sessionId ?? null,
      poolKey: opts.poolKey ?? null,
      pid: entry.worker.pid,
      skipEnsure,
      allowSessionReplacement: opts.allowSessionReplacement !== false,
    });
    const inner = entry.worker.run(opts, runId, skipEnsure);
    let markReleased!: () => void;
    const released = new Promise<void>((resolve) => {
      markReleased = resolve;
    });
    const events = skipEnsure
      ? this.withInitialEvent(cachedSessionReadyEvent(entry.agentId), inner.events)
      : inner.events;
    return {
      entry,
      inner,
      events: this.releaseWhenDone(entry, events, markReleased),
      released,
    };
  }

  private async *resumeOnceAfterFatalWorkerError(
    firstAttempt: RunningAttempt,
    opts: AgentRunOptions,
    runId: string,
    setCurrent: (attempt: RunningAttempt) => void,
  ): AsyncGenerator<AgentEvent> {
    let attempt = firstAttempt;
    let recovered = false;
    let sessionId = opts.sessionId ?? attempt.entry.agentId;

    for (;;) {
      let fatalWorkerError: Extract<AgentEvent, { type: 'error' }> | undefined;
      for await (const event of attempt.events) {
        if ((event.type === 'system' || event.type === 'done') && event.sessionId) {
          sessionId = event.sessionId;
        }
        if (!recovered && isRecoverableFatalWorkerEvent(event)) {
          fatalWorkerError = event;
          break;
        }
        yield event;
      }

      if (!fatalWorkerError) return;
      recovered = true;

      if (!sessionId) {
        yield {
          ...fatalWorkerError,
          message: withFatalRecoveryFailure(
            fatalWorkerError.message,
            '无法确定原 SDK session，已停止自动继续',
          ),
        };
        return;
      }

      log.warn('agent', 'sdk-pool-resume-after-fatal-worker-error', {
        runId,
        sessionId,
        previousPid: attempt.entry.worker.pid,
      });
      await attempt.released;

      const retryOpts: SdkRunOptions = {
        ...opts,
        sessionId,
        allowSessionReplacement: false,
      };
      const nextEntry = this.acquireEntrySync(sessionPoolKey(sessionId), retryOpts);
      if (!nextEntry) {
        yield {
          ...fatalWorkerError,
          message: withFatalRecoveryFailure(
            fatalWorkerError.message,
            '无法启动新的 SDK worker，已停止自动继续',
          ),
        };
        return;
      }

      attempt = this.startAttempt(nextEntry, retryOpts, runId);
      setCurrent(attempt);
    }
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

  workerSnapshots(): WorkerSnapshot[] {
    const now = Date.now();
    return [...this.entries.values()].map((entry) => ({
      key: entry.key,
      pid: entry.worker.pid,
      status: entry.disposed
        ? 'disposed'
        : entry.stopping
          ? 'stopping'
        : entry.busy && entry.lastEventAt && now - entry.lastEventAt > 5 * 60_000
          ? 'stuck'
          : entry.busy
            ? 'running'
            : 'idle',
      agentId: entry.agentId,
      cwd: entry.cwd,
      pendingRuns: entry.pendingRuns,
      currentRunId: entry.currentRunId,
      startedAt: entry.currentRunStartedAt,
      lastEventAt: entry.lastEventAt,
      lastError: entry.lastError,
    }));
  }

  private async *releaseWhenDone(
    entry: PoolEntry,
    events: AsyncIterable<AgentEvent>,
    onReleased?: () => void,
  ): AsyncGenerator<AgentEvent> {
    let evictAfterRun = false;
    try {
      for await (const event of events) {
        entry.lastEventAt = Date.now();
        if (event.type === 'error') {
          entry.lastError = event.message;
          evictAfterRun ||= Boolean(event.fatal) || isPoisonedSdkWorkerError(event.message);
        }
        yield event;
      }
    } finally {
      const runId = entry.currentRunId;
      entry.pendingRuns = Math.max(0, entry.pendingRuns - 1);
      entry.busy = entry.pendingRuns > 0;
      entry.stopping = false;
      entry.lastUsed = Date.now();
      if (!entry.busy) {
        entry.currentRunId = undefined;
        entry.currentRunStartedAt = undefined;
      }
      if (!entry.disposed) this.touch(entry);
      onReleased?.();
      if (evictAfterRun && !entry.disposed) {
        log.warn('agent', 'sdk-pool-evict-after-fatal-error', {
          key: entry.key,
          sessionId: entry.agentId,
          pid: entry.worker.pid,
          runId,
          reason: 'fatal sdk run error',
        });
        await this.removeEntryFor(entry);
      }
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
    const worker = this.workerFactory(this.workerScript, this.sdkConfig, () => {
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
      disposed: false,
      stopping: false,
      currentRunId: undefined,
      currentRunStartedAt: undefined,
      lastEventAt: undefined,
      lastError: undefined,
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
    if (entry.disposed) return;
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
    await this.removeEntryFor(entry);
  }

  private async removeEntryFor(entry: PoolEntry): Promise<void> {
    entry.disposed = true;
    if (this.entries.get(entry.key) === entry) {
      this.entries.delete(entry.key);
    } else {
      for (const [key, candidate] of this.entries) {
        if (candidate === entry) this.entries.delete(key);
      }
    }
    await entry.worker.shutdown();
    log.info('agent', 'sdk-pool-evict', { key: entry.key, pid: entry.worker.pid });
  }
}

async function waitFor(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
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
    env: sdkWorkerEnv({
      LARK_CURSOR_SDK_WORKER: '1',
      LARK_CURSOR_SDK_CONFIG: JSON.stringify(sdkConfig),
    }),
    // The worker is a real file entrypoint. Parent processes launched via
    // `node -e`/stdin can carry execArgv like `--input-type=module`, which
    // makes Node reject file entrypoints during fork startup.
    execArgv: [],
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
      fail: (message: string, fatal?: boolean) => void;
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
        pendingRuns.get(msg.id)?.fail(msg.message, msg.fatal);
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
      handlers.fail(exitMsg, true);
      pendingRuns.delete(id);
    }
    for (const [id, handlers] of pendingEnsures) {
      handlers.reject(exitMsg);
      pendingEnsures.delete(id);
    }
  });

  return {
    pid: child.pid ?? null,
    ensure(cwd, agentId, reqId, allowReplacement = true) {
      return new Promise<string | undefined>((resolve, reject) => {
        pendingEnsures.set(reqId, {
          resolve: (id) => resolve(id),
          reject: (msg) => {
            log.warn('agent', 'sdk-ensure-failed', { message: msg });
            resolve(undefined);
          },
        });
        if (
          !ipcSend(child, {
            type: 'ensure',
            id: reqId,
            cwd,
            agentId,
            allowReplacement,
          } satisfies WorkerRequest)
        ) {
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
      let errorFatal = false;
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
      const fail = (message: string, fatal = false) => {
        errorMsg = message;
        errorFatal = fatal;
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
          const ensuredAgentId = await new Promise<string | undefined>((resolve) => {
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
                allowReplacement: opts.allowSessionReplacement !== false,
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
          if (
            ensuredAgentId &&
            (ensuredAgentId !== opts.sessionId || opts.allowSessionReplacement === false)
          ) {
            pushEvent({ type: 'system', sessionId: ensuredAgentId });
          }
        }

        if (!errorMsg) {
          if (
            !ipcSend(child, {
              type: 'run',
              id: runId,
              prompt: opts.prompt,
              allowReplacement: opts.allowSessionReplacement !== false,
            } satisfies WorkerRequest)
          ) {
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
        if (errorMsg) yield { type: 'error', message: errorMsg, fatal: errorFatal };
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

export function sdkWorkerEnv(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...overrides };
  const nodeOptions = sanitizeNodeOptions(env.NODE_OPTIONS);
  if (nodeOptions) {
    env.NODE_OPTIONS = nodeOptions;
  } else {
    delete env.NODE_OPTIONS;
  }
  return env;
}

function sanitizeNodeOptions(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const parts = value.split(/\s+/).filter(Boolean);
  const kept: string[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i]!;
    if (part === '--input-type') {
      i += 1;
      continue;
    }
    if (part.startsWith('--input-type=')) continue;
    kept.push(part);
  }
  return kept.length > 0 ? kept.join(' ') : undefined;
}

function isRecoverableFatalWorkerEvent(event: AgentEvent): event is Extract<AgentEvent, { type: 'error' }> {
  return event.type === 'error' && Boolean(event.fatal) && isPoisonedSdkWorkerError(event.message);
}

function isPoisonedSdkWorkerError(message: string): boolean {
  return (
    message.includes('Cursor returned no error detail') ||
    message.includes('已自动丢弃当前 SDK worker') ||
    message.includes('sdk worker exited')
  );
}

function withFatalRecoveryFailure(originalMessage: string, reason: string): string {
  return [
    `SDK worker fatal 后自动恢复失败：${reason}。`,
    '已保留原 session，不会自动创建 replacement session 或无上下文重放。',
    '可点击一键重试，或发送 `/new` 开新 session 后再试。',
    '',
    `原始错误：${originalMessage}`,
  ].join('\n');
}

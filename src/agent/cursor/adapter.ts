import { spawn } from 'node:child_process';
import { log } from '../../core/logger';
import type {
  AgentAdapter,
  AgentDescriptor,
  AgentEvent,
  AgentRun,
  AgentRunOptions,
  WorkerSnapshot,
} from '../types';
import { spawnCreateChat } from './create-chat';
import { CursorSdkPool } from './sdk-pool';
import { spawnCursorRun, type CursorSpawnOptions } from './spawn-run';
import type { CursorSdkLocalSettingSources, SdkWorkerConfig } from './sdk-worker';
import type { CursorSdkModelSelection } from './model-selection';
import {
  DEFAULT_AGENT_CURSOR_CLI_MODEL,
  DEFAULT_AGENT_CURSOR_SDK_MODEL,
} from './model-selection';

export interface CursorAdapterOptions {
  command?: string;
  args?: string[];
  runtime?: 'sdk' | 'cli';
  sessionPoolSize?: number;
  /** CLI `--model` id (e.g. `gpt-5.5-extra-high-fast`). */
  defaultCliModel?: string;
  /** SDK `ModelSelection` (e.g. `gpt-5.5` + reasoning/fast params). */
  defaultSdkModel?: CursorSdkModelSelection;
  apiKey?: string;
  localSettingSources?: CursorSdkLocalSettingSources | 'none';
}

export class CursorAdapter implements AgentAdapter {
  readonly id = 'cursor';
  readonly displayName = 'Cursor Agent';
  readonly sessionKey: string;

  private readonly command: string;
  private readonly prefixArgs: string[];
  private readonly runtime: 'sdk' | 'cli';
  private readonly effectiveRuntime: 'sdk' | 'cli';
  private readonly defaultCliModel: string;
  private readonly defaultSdkModel: CursorSdkModelSelection;
  private readonly sdkPool: CursorSdkPool | undefined;
  private readonly spawnOpts: CursorSpawnOptions;

  constructor(opts: CursorAdapterOptions = {}) {
    this.command = opts.command ?? 'agent';
    this.prefixArgs = opts.args ?? [];
    this.runtime = opts.runtime ?? 'cli';
    this.defaultCliModel = opts.defaultCliModel ?? DEFAULT_AGENT_CURSOR_CLI_MODEL;
    this.defaultSdkModel = opts.defaultSdkModel ?? DEFAULT_AGENT_CURSOR_SDK_MODEL;
    const poolSize = opts.sessionPoolSize ?? 0;
    this.effectiveRuntime = this.runtime === 'sdk' && poolSize > 0 ? 'sdk' : 'cli';
    this.sessionKey = this.effectiveRuntime === 'sdk' ? 'cursor:sdk' : 'cursor:cli';
    this.spawnOpts = {
      command: this.command,
      prefixArgs: this.prefixArgs,
      commandLabel: this.commandLabel,
      apiKey: opts.apiKey,
    };
    if (this.effectiveRuntime === 'sdk') {
      const localSettingSources = opts.localSettingSources ?? 'all';
      const sdkConfig: SdkWorkerConfig = {
        model: this.defaultSdkModel,
        ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
        ...(localSettingSources === 'all' ? { localSettingSources } : {}),
      };
      this.sdkPool = new CursorSdkPool(this.spawnOpts, sdkConfig, poolSize);
    }
  }

  get commandLabel(): string {
    return this.effectiveRuntime === 'sdk'
      ? `@cursor/sdk (${this.command})`
      : [this.command, ...this.prefixArgs].join(' ');
  }

  get descriptor(): AgentDescriptor {
    return {
      id: this.id,
      label: this.displayName,
      runtime: this.effectiveRuntime,
      sessionKey: this.sessionKey,
      commandLabel: this.commandLabel,
      supportsRetry: true,
      supportsWorkers: this.effectiveRuntime === 'sdk',
    };
  }

  async isAvailable(): Promise<boolean> {
    if (this.effectiveRuntime === 'sdk') {
      try {
        await import('@cursor/sdk');
        return true;
      } catch {
        return false;
      }
    }
    return new Promise((resolve) => {
      const child = spawn(this.command, [...this.prefixArgs, '--version'], { stdio: 'ignore' });
      child.on('error', () => resolve(false));
      child.on('exit', (code) => resolve(code === 0));
    });
  }

  async prepareSession(cwd: string, scope?: string): Promise<string | undefined> {
    void scope;
    if (this.sdkPool) {
      return this.sdkPool.ensureAgent(cwd);
    }
    return spawnCreateChat({ command: this.command, prefixArgs: this.prefixArgs });
  }

  canResumeSession(sessionId: string): boolean {
    if (!this.sdkPool) return true;
    return isCursorSdkSessionId(sessionId);
  }

  run(opts: AgentRunOptions): AgentRun {
    const runOpts = { ...opts, model: opts.model ?? this.defaultCliModel };
    if (this.sdkPool && opts.poolKey) {
      const run = this.sdkPool.run(runOpts);
      return {
        events: this.trackSessionEvents(run.events, runOpts),
        stop: () => run.stop(),
        waitForExit: (timeoutMs) => run.waitForExit(timeoutMs),
      };
    }
    return spawnCursorRun(this.spawnOpts, runOpts);
  }

  async evictScope(scope: string, cwd?: string): Promise<void> {
    await this.sdkPool?.evictScope(scope, cwd);
  }

  workerSnapshots(): WorkerSnapshot[] {
    return this.sdkPool?.workerSnapshots() ?? [];
  }

  async shutdown(): Promise<void> {
    await this.sdkPool?.shutdown();
  }

  private async *trackSessionEvents(
    events: AsyncIterable<AgentEvent>,
    opts: AgentRunOptions,
  ): AsyncGenerator<AgentEvent> {
    for await (const event of events) {
      if (event.type === 'system' && event.sessionId && this.sdkPool) {
        this.sdkPool.noteSessionId(opts, event.sessionId);
      }
      if (event.type === 'done' && event.sessionId && this.sdkPool) {
        this.sdkPool.noteSessionId(opts, event.sessionId);
      }
      yield event;
    }
  }
}

export function isCursorSdkSessionId(sessionId: string): boolean {
  return sessionId.startsWith('agent-') || sessionId.startsWith('bc-');
}

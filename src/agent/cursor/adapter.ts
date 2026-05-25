import { spawn } from 'node:child_process';
import { log } from '../../core/logger';
import type { AgentAdapter, AgentEvent, AgentRun, AgentRunOptions } from '../types';
import { spawnCreateChat } from './create-chat';
import { CursorSdkPool } from './sdk-pool';
import { spawnCursorRun } from './spawn-run';
import type { SdkWorkerConfig } from './sdk-worker';

export interface CursorAdapterOptions {
  command?: string;
  args?: string[];
  runtime?: 'sdk' | 'cli';
  sessionPoolSize?: number;
  defaultModel?: string;
  apiKey?: string;
}

export class CursorAdapter implements AgentAdapter {
  readonly id = 'cursor';
  readonly displayName = 'Cursor Agent';

  private readonly command: string;
  private readonly prefixArgs: string[];
  private readonly runtime: 'sdk' | 'cli';
  private readonly sdkPool: CursorSdkPool | undefined;
  private readonly spawnOpts: { command: string; prefixArgs: string[]; commandLabel: string };

  constructor(opts: CursorAdapterOptions = {}) {
    this.command = opts.command ?? 'agent';
    this.prefixArgs = opts.args ?? [];
    this.runtime = opts.runtime ?? 'cli';
    this.spawnOpts = {
      command: this.command,
      prefixArgs: this.prefixArgs,
      commandLabel: this.commandLabel,
    };
    const poolSize = opts.sessionPoolSize ?? 0;
    if (this.runtime === 'sdk' && poolSize > 0) {
      const sdkConfig: SdkWorkerConfig = {
        defaultModel: opts.defaultModel ?? 'composer-2.5-fast',
        ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
      };
      this.sdkPool = new CursorSdkPool(this.spawnOpts, sdkConfig, poolSize);
    }
  }

  get commandLabel(): string {
    return this.runtime === 'sdk'
      ? `@cursor/sdk (${this.command})`
      : [this.command, ...this.prefixArgs].join(' ');
  }

  async isAvailable(): Promise<boolean> {
    if (this.runtime === 'sdk') {
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
    if (this.sdkPool && scope) {
      return this.sdkPool.ensureAgent(scope, cwd);
    }
    return spawnCreateChat({ command: this.command, prefixArgs: this.prefixArgs });
  }

  run(opts: AgentRunOptions): AgentRun {
    if (this.sdkPool && opts.poolKey) {
      const run = this.sdkPool.run(opts);
      return {
        events: this.trackSessionEvents(run.events, opts),
        stop: () => run.stop(),
        waitForExit: (timeoutMs) => run.waitForExit(timeoutMs),
      };
    }
    return spawnCursorRun(this.spawnOpts, opts);
  }

  async evictScope(scope: string, cwd?: string): Promise<void> {
    await this.sdkPool?.evictScope(scope, cwd);
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

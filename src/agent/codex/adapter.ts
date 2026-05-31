import type { ChildProcessByStdio } from 'node:child_process';
import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { log } from '../../core/logger';
import type { AgentAdapter, AgentDescriptor, AgentEvent, AgentRun, AgentRunOptions } from '../types';
import { createCodexTranslator } from './stream-json';

export interface CodexAdapterOptions {
  command?: string;
  args?: string[];
  codexArgsOption?: string;
  defaultModel?: string;
}

type CodexChild = ChildProcessByStdio<null, Readable, Readable>;

function quoteShellArg(arg: string): string {
  if (arg.length === 0) return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

function joinShellArgs(args: string[]): string {
  return args.map(quoteShellArg).join(' ');
}

export class CodexAdapter implements AgentAdapter {
  readonly id = 'codex';
  readonly sessionKey = 'codex';
  readonly displayName = 'Codex CLI';

  private readonly command: string;
  private readonly prefixArgs: string[];
  private readonly codexArgsOption?: string;
  private readonly defaultModel?: string;

  constructor(opts: CodexAdapterOptions = {}) {
    this.command = opts.command ?? 'codex';
    this.prefixArgs = opts.args ?? [];
    this.codexArgsOption = opts.codexArgsOption;
    this.defaultModel = opts.defaultModel;
  }

  get commandLabel(): string {
    return [this.command, ...this.prefixArgs].join(' ');
  }

  get descriptor(): AgentDescriptor {
    return {
      id: this.id,
      label: this.displayName,
      runtime: 'json',
      sessionKey: this.sessionKey,
      commandLabel: this.commandLabel,
      supportsRetry: true,
      supportsWorkers: false,
    };
  }

  async isAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      const child = spawn(this.command, this.buildProcessArgs(['--version']), { stdio: 'ignore' });
      child.on('error', () => resolve(false));
      child.on('exit', (code) => resolve(code === 0));
    });
  }

  private buildProcessArgs(codexArgs: string[]): string[] {
    if (!this.codexArgsOption) return [...this.prefixArgs, ...codexArgs];
    return [...this.prefixArgs, this.codexArgsOption, joinShellArgs(codexArgs)];
  }

  canResumeSession(sessionId: string): boolean {
    return sessionId.trim().length > 0;
  }

  run(opts: AgentRunOptions): AgentRun {
    if (opts.cwd) {
      const cwdError = validateWorkingDirectory(opts.cwd);
      if (cwdError) return errorRun(cwdError);
    }

    const model = opts.model ?? this.defaultModel;
    const codexArgs = ['exec', '--json'];
    if (opts.cwd) codexArgs.push('-C', opts.cwd);
    if (model) codexArgs.push('--model', model);
    if (opts.sessionId) codexArgs.push('resume', opts.sessionId, opts.prompt);
    else codexArgs.push(opts.prompt);

    const child = spawn(this.command, this.buildProcessArgs(codexArgs), {
      cwd: opts.cwd,
      env: { ...process.env, LARK_CHANNEL: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    log.info('agent', 'spawn', {
      pid: child.pid ?? null,
      command: this.commandLabel,
      cwd: opts.cwd ?? process.cwd(),
      hasSession: Boolean(opts.sessionId),
      promptChars: opts.prompt.length,
      model,
      runtime: 'codex',
    });

    const stderrChunks: Buffer[] = [];
    let stderrBuffer = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
      stderrBuffer += chunk.toString('utf8');
      let nl = stderrBuffer.indexOf('\n');
      while (nl !== -1) {
        const line = stderrBuffer.slice(0, nl);
        stderrBuffer = stderrBuffer.slice(nl + 1);
        if (line.trim()) log.warn('agent', 'stderr', { line });
        nl = stderrBuffer.indexOf('\n');
      }
    });

    let runtimeError: Error | null = null;
    child.on('error', (err) => {
      runtimeError = err;
    });
    child.on('exit', (code, signal) => {
      log.info('agent', 'exit', { pid: child.pid ?? null, code, signal, runtime: 'codex' });
    });

    const stopGraceMs = opts.stopGraceMs ?? 5000;

    return {
      events: createEventStream(child, stderrChunks, () => runtimeError, this.commandLabel),
      async stop() {
        if (child.exitCode !== null || child.signalCode !== null) return;
        log.info('agent', 'stop-sigterm', { pid: child.pid ?? null, graceMs: stopGraceMs });
        child.kill('SIGTERM');
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) {
              log.warn('agent', 'stop-sigkill', {
                pid: child.pid ?? null,
                graceMs: stopGraceMs,
                reason: 'grace-period-expired',
              });
              child.kill('SIGKILL');
            }
            resolve();
          }, stopGraceMs);
          child.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
        });
      },
      waitForExit(timeoutMs: number): Promise<boolean> {
        if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
        return new Promise<boolean>((resolve) => {
          const onExit = (): void => {
            clearTimeout(timer);
            resolve(true);
          };
          const timer = setTimeout(() => {
            child.removeListener('exit', onExit);
            resolve(false);
          }, timeoutMs);
          child.once('exit', onExit);
        });
      },
    };
  }
}

export function validateWorkingDirectory(cwd: string): string | undefined {
  try {
    if (!statSync(cwd).isDirectory()) {
      return `working directory is not a directory: ${cwd}. Use /cd to switch this chat to a valid path.`;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return `working directory does not exist: ${cwd}. Use /cd to switch this chat to a valid path.`;
    }
    return `working directory is not accessible: ${cwd}: ${(err as Error).message}`;
  }
  return undefined;
}

function errorRun(message: string): AgentRun {
  return {
    events: (async function* (): AsyncGenerator<AgentEvent> {
      yield { type: 'error', message };
    })(),
    async stop() {},
    async waitForExit() {
      return true;
    },
  };
}

async function waitForSpawnError(getError: () => Error | null, child: CodexChild): Promise<Error | null> {
  const current = getError();
  if (current) return current;

  return new Promise<Error | null>((resolve) => {
    const finish = (err: Error | null): void => {
      child.removeListener('error', onError);
      clearImmediate(immediate);
      resolve(err ?? getError());
    };
    const onError = (err: Error): void => finish(err);
    const immediate = setImmediate(() => finish(null));
    child.once('error', onError);
  });
}

async function* createEventStream(
  child: CodexChild,
  stderrChunks: Buffer[],
  getError: () => Error | null,
  commandLabel: string,
): AsyncGenerator<AgentEvent> {
  if (!child.pid) {
    const err = await waitForSpawnError(getError, child);
    yield {
      type: 'error',
      message: err ? `failed to spawn ${commandLabel}: ${err.message}` : 'spawn returned no pid',
    };
    return;
  }

  const translator = createCodexTranslator();
  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let emittedTerminal = false;
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      for (const event of translator.translate(parsed)) {
        if (event.type === 'done' || event.type === 'error') emittedTerminal = true;
        yield event;
      }
    }
  } finally {
    rl.close();
  }

  const { code, signal } = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
    } else {
      child.once('exit', (code, signal) => resolve({ code, signal }));
    }
  });

  const runtimeError = getError();
  if (!emittedTerminal && code !== 0 && code !== null) {
    const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
    const detail = stderr ? `: ${stderr.slice(0, 500)}` : '';
    yield { type: 'error', message: `codex exited with code ${code}${detail}` };
  } else if (!emittedTerminal && signal !== null) {
    const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
    const detail = stderr ? `: ${stderr.slice(0, 500)}` : '';
    yield { type: 'error', message: `codex exited with signal ${signal}${detail}` };
  } else if (!emittedTerminal && runtimeError) {
    yield { type: 'error', message: `codex runtime error: ${runtimeError.message}` };
  }
}

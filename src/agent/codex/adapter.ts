import type { ChildProcessByStdio } from 'node:child_process';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { log } from '../../core/logger';
import { BRIDGE_SYSTEM_PROMPT } from '../claude/adapter';
import type { AgentAdapter, AgentAvailability, AgentDescriptor, AgentEvent, AgentRun, AgentRunOptions } from '../types';
import { createCodexTranslator } from './stream-json';

export interface CodexAdapterOptions {
  command?: string;
  args?: string[];
  codexArgsOption?: string;
  defaultModel?: string;
  availabilityTimeoutMs?: number;
  availabilityStopGraceMs?: number;
}

type CodexChild = ChildProcessByStdio<null, Readable, Readable>;
interface CodexAttempt {
  child: CodexChild;
  events: AsyncGenerator<AgentEvent>;
}

const DEFAULT_AVAILABILITY_TIMEOUT_MS = 20_000;
const DEFAULT_AVAILABILITY_STOP_GRACE_MS = 1_000;
const NO_SANDBOX_ARG = '--dangerously-bypass-approvals-and-sandbox';
const CODEX_RESPONSE_FAILED_ERROR = 'stream disconnected before completion: response.failed event received';
const AVAILABILITY_OUTPUT_MAX_CHARS = 2_000;

function quoteShellArg(arg: string): string {
  if (arg.length === 0) return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

function joinShellArgs(args: string[]): string {
  return args.map(quoteShellArg).join(' ');
}

function trimAvailabilityOutput(chunks: Buffer[]): string {
  return Buffer.concat(chunks)
    .toString('utf8')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, AVAILABILITY_OUTPUT_MAX_CHARS);
}

export function buildCodexPrompt(prompt: string): string {
  return `<bridge_system_prompt>\n${BRIDGE_SYSTEM_PROMPT}\n</bridge_system_prompt>\n\n<user_prompt>\n${prompt}\n</user_prompt>`;
}

export function buildCodexExecArgs(opts: { prompt: string; cwd?: string; model?: string; sessionId?: string }): string[] {
  const prompt = buildCodexPrompt(opts.prompt);
  const codexArgs = ['exec', '--json', NO_SANDBOX_ARG];
  if (opts.cwd) codexArgs.push('-C', opts.cwd);
  if (opts.model) codexArgs.push('--model', opts.model);
  if (opts.sessionId) codexArgs.push('resume', opts.sessionId, '--', prompt);
  else codexArgs.push('--', prompt);
  return codexArgs;
}

function codexSessionKey(command: string, args: string[], codexArgsOption: string | undefined): string {
  const hash = createHash('sha1')
    .update(JSON.stringify({ command, args, codexArgsOption: codexArgsOption ?? '' }))
    .digest('hex')
    .slice(0, 10);
  return `codex:${hash}`;
}

export class CodexAdapter implements AgentAdapter {
  readonly id = 'codex';
  readonly sessionKey: string;
  readonly displayName = 'Codex CLI';

  private readonly command: string;
  private readonly prefixArgs: string[];
  private readonly codexArgsOption?: string;
  private readonly defaultModel?: string;
  private readonly availabilityTimeoutMs: number;
  private readonly availabilityStopGraceMs: number;

  constructor(opts: CodexAdapterOptions = {}) {
    this.command = opts.command ?? 'codex';
    this.prefixArgs = opts.args ?? [];
    this.codexArgsOption = opts.codexArgsOption;
    this.defaultModel = opts.defaultModel;
    this.availabilityTimeoutMs = opts.availabilityTimeoutMs ?? DEFAULT_AVAILABILITY_TIMEOUT_MS;
    this.availabilityStopGraceMs = opts.availabilityStopGraceMs ?? DEFAULT_AVAILABILITY_STOP_GRACE_MS;
    this.sessionKey = codexSessionKey(this.command, this.prefixArgs, this.codexArgsOption);
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
    const availability = await this.checkAvailability();
    return availability.ok;
  }

  async checkAvailability(): Promise<AgentAvailability> {
    return new Promise((resolve) => {
      const child = spawn(this.command, this.buildProcessArgs(['--version']), { stdio: ['ignore', 'pipe', 'pipe'] });
      let settled = false;
      let timedOut = false;
      let timeoutTimer: NodeJS.Timeout | undefined;
      let graceTimer: NodeJS.Timeout | undefined;
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      child.stdout.on('data', (chunk: Buffer) => {
        stdoutChunks.push(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderrChunks.push(chunk);
      });

      const cleanup = (): void => {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (graceTimer) clearTimeout(graceTimer);
        child.removeListener('error', onError);
        child.removeListener('close', onClose);
      };
      const finish = (availability: AgentAvailability): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(availability);
      };
      const onError = (err: Error): void => finish({ ok: false, error: err.message });
      const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
        if (timedOut) {
          finish({ ok: false, error: `timed out after ${this.availabilityTimeoutMs}ms` });
          return;
        }
        if (code === 0) {
          finish({ ok: true });
          return;
        }
        const output = trimAvailabilityOutput(stderrChunks) || trimAvailabilityOutput(stdoutChunks);
        const suffix = output ? `: ${output}` : '';
        if (code !== null) finish({ ok: false, error: `exited with code ${code}${suffix}` });
        else finish({ ok: false, error: `exited with signal ${signal ?? 'unknown'}${suffix}` });
      };

      timeoutTimer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        graceTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGKILL');
          }
        }, this.availabilityStopGraceMs);
      }, this.availabilityTimeoutMs);

      child.on('error', onError);
      child.on('close', onClose);
    });
  }

  private buildProcessArgs(codexArgs: string[]): string[] {
    if (!this.codexArgsOption) return [...this.prefixArgs, ...codexArgs];
    return [...this.prefixArgs, this.codexArgsOption, joinShellArgs(codexArgs)];
  }

  canResumeSession(sessionId: string): boolean {
    return sessionId.trim().length > 0;
  }

  private startAttempt(opts: AgentRunOptions, sessionId?: string): CodexAttempt {
    const model = opts.model ?? this.defaultModel;
    const codexArgs = buildCodexExecArgs({
      prompt: opts.prompt,
      cwd: opts.cwd,
      model,
      sessionId,
    });

    const child = spawn(this.command, this.buildProcessArgs(codexArgs), {
      cwd: opts.cwd,
      env: { ...process.env, LARK_CHANNEL: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    log.info('agent', 'spawn', {
      pid: child.pid ?? null,
      command: this.commandLabel,
      cwd: opts.cwd ?? process.cwd(),
      hasSession: Boolean(sessionId),
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

    return {
      child,
      events: createEventStream(child, stderrChunks, () => runtimeError, this.commandLabel),
    };
  }

  run(opts: AgentRunOptions): AgentRun {
    if (opts.cwd) {
      const cwdError = validateWorkingDirectory(opts.cwd);
      if (cwdError) return errorRun(cwdError);
    }

    const stopGraceMs = opts.stopGraceMs ?? 5000;
    let currentChild: CodexChild | undefined;
    let stopped = false;

    return {
      events: this.createRetryingEventStream(opts, (child) => {
        currentChild = child;
      }, () => stopped),
      async stop() {
        stopped = true;
        const child = currentChild;
        if (!child || child.exitCode !== null || child.signalCode !== null) return;
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
        const child = currentChild;
        if (!child) return Promise.resolve(true);
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

  private async *createRetryingEventStream(
    opts: AgentRunOptions,
    setCurrentChild: (child: CodexChild) => void,
    isStopped: () => boolean,
  ): AsyncGenerator<AgentEvent> {
    let sessionId = opts.sessionId;
    for (let attemptIndex = 0; attemptIndex < 2; attemptIndex += 1) {
      const attempt = this.startAttempt(opts, sessionId);
      setCurrentChild(attempt.child);
      let shouldRetry = false;

      for await (const event of attempt.events) {
        if (event.type === 'system' && event.sessionId) sessionId = event.sessionId;
        if (
          event.type === 'error' &&
          attemptIndex === 0 &&
          !isStopped() &&
          isRetryableCodexStreamError(event.message)
        ) {
          shouldRetry = true;
          log.warn('agent', 'codex-auto-retry', {
            reason: event.message,
            sessionId: sessionId ?? null,
            command: this.commandLabel,
          });
          break;
        }
        yield event;
      }

      if (!shouldRetry) return;
      yield {
        type: 'progress',
        phase: 'thinking',
        label: 'Codex stream failed before completion; retrying once.',
      };
    }
  }
}

function isRetryableCodexStreamError(message: string | undefined): boolean {
  return Boolean(message?.includes(CODEX_RESPONSE_FAILED_ERROR));
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

export function chooseCodexTerminalError(opts: {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  runtimeError: Error | null;
  topLevelError?: string;
}): string | undefined {
  const detail = opts.stderr ? `: ${opts.stderr.slice(0, 500)}` : '';
  if (opts.code !== 0 && opts.code !== null) return `codex exited with code ${opts.code}${detail}`;
  if (opts.signal !== null) return `codex exited with signal ${opts.signal}${detail}`;
  if (opts.runtimeError) return `codex runtime error: ${opts.runtimeError.message}`;
  return opts.topLevelError;
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
      logCodexRawError(parsed);
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

  const terminalError = chooseCodexTerminalError({
    code,
    signal,
    stderr: Buffer.concat(stderrChunks).toString('utf8').trim(),
    runtimeError: getError(),
    topLevelError: translator.lastTopLevelError(),
  });
  if (!emittedTerminal && terminalError) {
    yield { type: 'error', message: terminalError };
  }
}

function logCodexRawError(parsed: unknown): void {
  if (!parsed || typeof parsed !== 'object') return;
  const record = parsed as Record<string, unknown>;
  if (record.type !== 'error' && record.type !== 'turn.failed') return;
  log.warn('agent', 'codex-raw-error', {
    codexEventType: typeof record.type === 'string' ? record.type : undefined,
    message: codexRawErrorMessage(record),
    raw: summarizeCodexRawError(record),
  });
}

function codexRawErrorMessage(record: Record<string, unknown>): string | undefined {
  const value = record.error ?? record.message;
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof (value as Record<string, unknown>).message === 'string') {
    return (value as Record<string, unknown>).message as string;
  }
  return undefined;
}

function summarizeCodexRawError(record: Record<string, unknown>): unknown {
  try {
    const json = JSON.stringify(record);
    return json.length > 2_000 ? `${json.slice(0, 2_000)}…` : record;
  } catch {
    return String(record);
  }
}

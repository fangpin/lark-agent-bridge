import { spawn } from 'node:child_process';
import { log } from '../../core/logger';

export interface CreateChatOptions {
  command: string;
  prefixArgs: string[];
  timeoutMs?: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseCreateChatOutput(stdout: string): string | undefined {
  for (const line of stdout.split(/\r?\n/)) {
    const id = line.trim();
    if (UUID_RE.test(id)) return id;
  }
  return undefined;
}

/** Run `cursor-agent create-chat` and return the new session id, if any. */
export function spawnCreateChat(opts: CreateChatOptions): Promise<string | undefined> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  return new Promise((resolve) => {
    const child = spawn(opts.command, [...opts.prefixArgs, 'create-chat'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    let stdout = '';
    let settled = false;

    const finish = (id: string | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(id);
    };

    const timer = setTimeout(() => {
      log.warn('agent', 'create-chat-timeout', { timeoutMs });
      child.kill('SIGTERM');
      finish(parseCreateChatOutput(stdout));
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      log.warn('agent', 'create-chat-error', { err: err.message });
      finish(undefined);
    });

    child.on('exit', (code) => {
      if (code !== 0) log.warn('agent', 'create-chat-exit', { code });
      finish(parseCreateChatOutput(stdout));
    });
  });
}

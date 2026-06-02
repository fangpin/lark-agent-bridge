import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { buildCodexExecArgs, CodexAdapter, chooseCodexTerminalError } from '../../../src/agent/codex/adapter';

function nodeCommand(script: string): { command: string; args: string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'codex-adapter-'));
  const file = join(dir, 'fake-codex.mjs');
  writeFileSync(file, script);
  return { command: process.execPath, args: [file, file] };
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw err;
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function collectText(adapter: CodexAdapter, cwd: string, sessionId?: string): Promise<string[]> {
  const run = adapter.run({ prompt: 'hello', cwd, sessionId, model: 'gpt-test', stopGraceMs: 100 });
  const out: string[] = [];
  for await (const event of run.events) {
    if (event.type === 'text') out.push(event.delta);
    if (event.type === 'system' && event.sessionId) out.push(`session:${event.sessionId}`);
    if (event.type === 'done') out.push(`done:${event.sessionId ?? ''}`);
  }
  return out;
}

describe('CodexAdapter', () => {
  test('builds no-sandbox exec args by default', () => {
    expect(buildCodexExecArgs({ prompt: 'hello', cwd: '/repo', model: 'gpt-test' })).toEqual([
      'exec',
      '--json',
      '--dangerously-bypass-approvals-and-sandbox',
      '-C',
      '/repo',
      '--model',
      'gpt-test',
      '--',
      expect.stringContaining('hello'),
    ]);
  });

  test('spawns codex exec json for a fresh run', async () => {
    const fake = nodeCommand(`
      const args = process.argv.slice(2);
      console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }));
      console.log(JSON.stringify({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: args.join(' ') } }));
      console.log(JSON.stringify({ type: 'turn.completed' }));
    `);
    const adapter = new CodexAdapter({
      command: fake.command,
      args: [...fake.args, '--sandbox', 'workspace-write'],
    });

    const events = await collectText(adapter, process.cwd());

    expect(events[0]).toBe('session:thread-1');
    expect(events[1]).toContain('--sandbox workspace-write exec --json --dangerously-bypass-approvals-and-sandbox -C');
    expect(events[1]).toContain('gpt-test');
    expect(events[1]).toContain('hello');
    expect(events[1]).not.toContain('resume thread-1');
    expect(events.at(-1)).toBe('done:thread-1');
  });

  test('spawns codex exec resume for a resumed run', async () => {
    const fake = nodeCommand(`
      const args = process.argv.slice(2);
      console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thread-2' }));
      console.log(JSON.stringify({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: args.join(' ') } }));
      console.log(JSON.stringify({ type: 'turn.completed' }));
    `);
    const adapter = new CodexAdapter({
      command: fake.command,
      args: [...fake.args, '--sandbox', 'workspace-write'],
    });

    const events = await collectText(adapter, process.cwd(), 'thread-existing');

    expect(events[1]).toContain('--sandbox workspace-write exec --json --dangerously-bypass-approvals-and-sandbox -C');
    expect(events[1]).toContain('resume thread-existing --');
    expect(events[1]).toContain('<user_prompt>');
    expect(events[1]).toContain('hello');
  });

  test('passes generated codex args through wrapper option when configured', async () => {
    const fake = nodeCommand(`
      const args = process.argv.slice(2);
      console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thread-wrapper' }));
      console.log(JSON.stringify({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: JSON.stringify(args) } }));
      console.log(JSON.stringify({ type: 'turn.completed' }));
    `);
    const adapter = new CodexAdapter({
      command: fake.command,
      args: [...fake.args, '--profile', 'dev'],
      codexArgsOption: '--claude-args',
      defaultModel: 'gpt-wrapper',
    });

    const events = await collectText(adapter, process.cwd(), 'thread-existing');
    const argv = JSON.parse(events[1]!) as string[];

    expect(argv.slice(0, 4)).toEqual([fake.args[0], '--profile', 'dev', '--claude-args']);
    expect(argv[4]).toContain('exec --json');
    expect(argv[4]).toContain('-C');
    expect(argv[4]).toContain('--model gpt-test');
    expect(argv[4]).toContain('resume thread-existing --');
    expect(argv[4]).toContain('<user_prompt>');
    expect(argv[4]).toContain('hello');
  });

  test('checks wrapper availability by passing version through codex args option', async () => {
    const fake = nodeCommand(`
      const args = process.argv.slice(2);
      if (args.includes('--claude-args') && args.at(-1) === '--version') process.exit(0);
      process.exit(2);
    `);
    const adapter = new CodexAdapter({
      command: fake.command,
      args: fake.args,
      codexArgsOption: '--claude-args',
    });

    await expect(adapter.isAvailable()).resolves.toBe(true);
  });

  test('reports availability stderr when wrapper exits non-zero', async () => {
    const fake = nodeCommand(`
      console.error('SSO authentication failed');
      process.exit(1);
    `);
    const adapter = new CodexAdapter({
      command: fake.command,
      args: fake.args,
    });

    await expect(adapter.checkAvailability()).resolves.toEqual({
      ok: false,
      error: expect.stringContaining('SSO authentication failed'),
    });
  });

  test('availability check kills codex wrapper that ignores SIGTERM', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-adapter-'));
    const pidFile = join(dir, 'pid.txt');
    const file = join(dir, 'fake-codex.mjs');
    writeFileSync(
      file,
      `import { writeFileSync } from 'node:fs';\nprocess.on('SIGTERM', () => {});\nconst pidFile = process.argv.find((arg) => arg.endsWith('/pid.txt'));\nif (!pidFile) throw new Error('missing pid file argument');\nwriteFileSync(pidFile, String(process.pid));\nsetTimeout(() => {}, 10_000);\n`,
    );
    const adapter = new CodexAdapter({
      command: process.execPath,
      args: [file, pidFile],
      availabilityTimeoutMs: 100,
      availabilityStopGraceMs: 30,
    });

    const startedAt = Date.now();
    await expect(adapter.isAvailable()).resolves.toBe(false);
    const elapsedMs = Date.now() - startedAt;
    const pid = Number(readFileSync(pidFile, 'utf8'));
    await delay(80);
    expect(isPidAlive(pid)).toBe(false);
    expect(elapsedMs).toBeLessThan(250);
  });

  test('reports a missing working directory before spawning codex', async () => {
    const adapter = new CodexAdapter({ command: process.execPath });
    const missing = join(tmpdir(), `missing-codex-${process.pid}-${Date.now()}`);
    const run = adapter.run({ prompt: 'hello', cwd: missing });
    const messages: string[] = [];

    for await (const event of run.events) {
      if (event.type === 'error') messages.push(event.message);
    }

    expect(messages).toEqual([
      `working directory does not exist: ${missing}. Use /cd to switch this chat to a valid path.`,
    ]);
  });

  test('surfaces non-zero exit with stderr when codex emits no terminal error', async () => {
    const fake = nodeCommand(`
      console.error('auth failed');
      process.exit(7);
    `);
    const adapter = new CodexAdapter({ command: fake.command, args: fake.args });
    const run = adapter.run({ prompt: 'hello', cwd: process.cwd() });
    const messages: string[] = [];

    for await (const event of run.events) {
      if (event.type === 'error') messages.push(event.message);
    }

    expect(messages[0]).toContain('codex exited with code 7: auth failed');
  });

  test('surfaces signal exit when codex emits no terminal event', async () => {
    const fake = nodeCommand(`
      setTimeout(() => process.kill(process.pid, 'SIGTERM'), 0);
    `);
    const adapter = new CodexAdapter({ command: fake.command, args: fake.args });
    const run = adapter.run({ prompt: 'hello', cwd: process.cwd() });
    const messages: string[] = [];

    for await (const event of run.events) {
      if (event.type === 'error') messages.push(event.message);
    }

    expect(messages[0] ?? '').toContain('codex exited with signal SIGTERM');
  });

  test('surfaces missing command spawn errors before generic no-pid diagnostics', async () => {
    const command = 'definitely-missing-codex-command-for-test';
    const adapter = new CodexAdapter({ command });
    const run = adapter.run({ prompt: 'hello', cwd: process.cwd() });
    const messages: string[] = [];

    for await (const event of run.events) {
      if (event.type === 'error') messages.push(event.message);
    }

    expect(messages[0]).toContain(`failed to spawn ${command}`);
    expect(messages[0]).not.toBe('spawn returned no pid');
  });

  test('accepts non-empty session ids for resume', () => {
    const adapter = new CodexAdapter();

    expect(adapter.canResumeSession?.('thread-1')).toBe(true);
    expect(adapter.canResumeSession?.('')).toBe(false);
  });

  test('wraps prompts with the bridge system prompt contract', async () => {
    const fake = nodeCommand(`
      const args = process.argv.slice(2);
      console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thread-prompt' }));
      console.log(JSON.stringify({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: args.at(-1) } }));
      console.log(JSON.stringify({ type: 'turn.completed' }));
    `);
    const adapter = new CodexAdapter({ command: fake.command, args: fake.args });

    const events = await collectText(adapter, process.cwd());

    expect(events[1]).toContain('<bridge_system_prompt>');
    expect(events[1]).toContain('<user_prompt>');
    expect(events[1]).toContain('hello');
    expect(events[1]).toContain('__claude_cb');
  });

  test('separates resume prompts that start with dash from codex options', async () => {
    const fake = nodeCommand(`
      const args = process.argv.slice(2);
      console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thread-dash' }));
      console.log(JSON.stringify({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: JSON.stringify(args) } }));
      console.log(JSON.stringify({ type: 'turn.completed' }));
    `);
    const adapter = new CodexAdapter({ command: fake.command, args: fake.args });
    const run = adapter.run({ prompt: '--help', cwd: process.cwd(), sessionId: 'thread-existing', stopGraceMs: 100 });
    const out: string[] = [];
    for await (const event of run.events) {
      if (event.type === 'text') out.push(event.delta);
    }

    const argv = JSON.parse(out[0]!) as string[];
    const resumeIndex = argv.indexOf('resume');
    expect(argv.slice(resumeIndex, resumeIndex + 4)).toEqual([
      'resume',
      'thread-existing',
      '--',
      expect.stringContaining('--help'),
    ]);
  });

  test('isolates codex sessions by command, wrapper args, and args option', () => {
    const direct = new CodexAdapter({ command: 'codex' });
    const wrappedA = new CodexAdapter({ command: 'ttadk', args: ['--profile', 'a'], codexArgsOption: '--claude-args' });
    const wrappedB = new CodexAdapter({ command: 'ttadk', args: ['--profile', 'b'], codexArgsOption: '--claude-args' });

    expect(direct.sessionKey).toMatch(/^codex:/);
    expect(wrappedA.sessionKey).toMatch(/^codex:/);
    expect(new Set([direct.sessionKey, wrappedA.sessionKey, wrappedB.sessionKey]).size).toBe(3);
  });

  test('surfaces top-level codex errors as terminal when no completion follows', async () => {
    const fake = nodeCommand(`
      console.log(JSON.stringify({ type: 'error', message: 'authentication required' }));
    `);
    const adapter = new CodexAdapter({ command: fake.command, args: fake.args });
    const run = adapter.run({ prompt: 'hello', cwd: process.cwd(), stopGraceMs: 100 });
    const events: string[] = [];

    for await (const event of run.events) {
      if (event.type === 'error') events.push(event.message);
    }

    expect(events).toEqual(['authentication required']);
  });

  test('retries codex response.failed stream disconnects once with the active session', async () => {
    const fake = nodeCommand(`
      const { readFileSync, writeFileSync } = await import('node:fs');
      const stateFile = process.argv[3];
      const args = process.argv.slice(4);
      const count = Number(readFileSync(stateFile, 'utf8') || '0') + 1;
      writeFileSync(stateFile, String(count));
      const resumed = args.includes('resume') ? args[args.indexOf('resume') + 1] : '';
      console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thread-retry' }));
      if (count === 1) {
        console.log(JSON.stringify({ type: 'error', message: 'stream disconnected before completion: response.failed event received' }));
        process.exit(0);
      }
      console.log(JSON.stringify({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'resumed=' + resumed } }));
      console.log(JSON.stringify({ type: 'turn.completed' }));
    `);
    const stateFile = join(tmpdir(), `codex-retry-${process.pid}-${Date.now()}.txt`);
    writeFileSync(stateFile, '0');
    const adapter = new CodexAdapter({ command: fake.command, args: [...fake.args, stateFile] });
    const run = adapter.run({ prompt: 'hello', cwd: process.cwd(), stopGraceMs: 100 });
    const events: string[] = [];

    for await (const event of run.events) {
      if (event.type === 'progress') events.push(`progress:${event.label}`);
      if (event.type === 'text') events.push(`text:${event.delta}`);
      if (event.type === 'error') events.push(`error:${event.message}`);
      if (event.type === 'done') events.push(`done:${event.sessionId ?? ''}`);
    }

    expect(readFileSync(stateFile, 'utf8')).toBe('2');
    expect(events).toContain('progress:Codex stream failed before completion; retrying once.');
    expect(events).toContain('text:resumed=thread-retry');
    expect(events).toContain('done:thread-retry');
    expect(events.some((event) => event.startsWith('error:'))).toBe(false);
  });

  test('prefers runtime errors over remembered top-level codex errors', () => {
    expect(
      chooseCodexTerminalError({
        code: 0,
        signal: null,
        stderr: '',
        runtimeError: new Error('stream exploded'),
        topLevelError: 'transient reconnect',
      }),
    ).toBe('codex runtime error: stream exploded');
  });

  test('prefers process exit diagnostics over remembered top-level codex errors', () => {
    expect(
      chooseCodexTerminalError({
        code: 7,
        signal: null,
        stderr: 'auth failed',
        runtimeError: new Error('later'),
        topLevelError: 'transient reconnect',
      }),
    ).toBe('codex exited with code 7: auth failed');
    expect(
      chooseCodexTerminalError({
        code: null,
        signal: 'SIGTERM',
        stderr: '',
        runtimeError: new Error('later'),
        topLevelError: 'transient reconnect',
      }),
    ).toBe('codex exited with signal SIGTERM');
  });
});

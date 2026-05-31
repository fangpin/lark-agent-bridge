import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { CodexAdapter } from '../../../src/agent/codex/adapter';

function nodeCommand(script: string): { command: string; args: string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'codex-adapter-'));
  const file = join(dir, 'fake-codex.mjs');
  writeFileSync(file, script);
  return { command: process.execPath, args: [file, file] };
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
    expect(events[1]).toContain('--sandbox workspace-write exec --json -C');
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

    expect(events[1]).toContain('--sandbox workspace-write exec --json -C');
    expect(events[1]).toContain('resume thread-existing hello');
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
    expect(argv[4]).toContain('resume thread-existing hello');
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
});

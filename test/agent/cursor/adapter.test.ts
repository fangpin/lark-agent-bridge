import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, test } from 'vitest';
import { CursorAdapter } from '../../../src/agent/cursor/adapter';

async function collectEvents(adapter: CursorAdapter, cwd: string): Promise<string[]> {
  const run = adapter.run({ prompt: 'hello', cwd });
  const messages: string[] = [];
  for await (const event of run.events) {
    if (event.type === 'error') messages.push(event.message);
  }
  return messages;
}

describe('CursorAdapter', () => {
  test('reports a missing working directory before spawning the cursor command', async () => {
    const missingCwd = join(tmpdir(), `lark-agent-missing-cwd-${process.pid}-${Date.now()}`);
    const adapter = new CursorAdapter({ command: process.execPath });

    const messages = await collectEvents(adapter, missingCwd);

    expect(messages).toEqual([
      `working directory does not exist: ${missingCwd}. Use /cd to switch this chat to a valid path.`,
    ]);
  });

  test('rejects legacy CLI session ids when using the SDK runtime', () => {
    const adapter = new CursorAdapter({ runtime: 'sdk', sessionPoolSize: 1 });

    expect(adapter.canResumeSession('agent-17def2a7-16a4-45c0-9560-16576b6d3688')).toBe(true);
    expect(adapter.canResumeSession('bc-example')).toBe(true);
    expect(adapter.canResumeSession('555e5524-3d1e-4efb-9b95-569bb697768f')).toBe(false);
  });

  test('uses the cli runtime metadata when sdk pooling is disabled', () => {
    const adapter = new CursorAdapter({ runtime: 'sdk', sessionPoolSize: 0, command: 'agent' });

    expect(adapter.sessionKey).toBe('cursor:cli');
    expect(adapter.commandLabel).toBe('agent');
    expect(adapter.descriptor).toMatchObject({
      runtime: 'cli',
      sessionKey: 'cursor:cli',
      commandLabel: 'agent',
      supportsWorkers: false,
    });
  });
});

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
    const missingCwd = join(tmpdir(), `ttadk-missing-cwd-${process.pid}-${Date.now()}`);
    const adapter = new CursorAdapter({ command: process.execPath });

    const messages = await collectEvents(adapter, missingCwd);

    expect(messages).toEqual([
      `working directory does not exist: ${missingCwd}. Use /cd to switch this chat to a valid path.`,
    ]);
  });
});

import { describe, expect, test } from 'vitest';
import { ClaudeAdapter } from '../../src/agent/claude/adapter';
import { CodexAdapter } from '../../src/agent/codex/adapter';
import { CursorAdapter } from '../../src/agent/cursor/adapter';

describe('agent descriptors', () => {
  test('describes Claude Code for user-facing status cards', () => {
    const adapter = new ClaudeAdapter({ command: 'claude-wrapper', args: ['--fast'] });

    expect(adapter.descriptor).toEqual({
      id: 'claude',
      label: 'Claude Code',
      runtime: 'cli',
      sessionKey: 'claude',
      commandLabel: 'claude-wrapper --fast',
      supportsRetry: true,
      supportsWorkers: false,
    });
  });

  test('describes Cursor SDK when worker pooling is enabled', () => {
    const adapter = new CursorAdapter({ runtime: 'sdk', sessionPoolSize: 2, command: 'agent' });

    expect(adapter.descriptor).toEqual({
      id: 'cursor',
      label: 'Cursor Agent',
      runtime: 'sdk',
      sessionKey: 'cursor:sdk',
      commandLabel: '@cursor/sdk (agent)',
      supportsRetry: true,
      supportsWorkers: true,
    });
  });

  test('describes Cursor CLI when SDK pooling is disabled', () => {
    const adapter = new CursorAdapter({ runtime: 'sdk', sessionPoolSize: 0, command: 'agent' });

    expect(adapter.descriptor).toMatchObject({
      id: 'cursor',
      label: 'Cursor Agent',
      runtime: 'cli',
      sessionKey: 'cursor:cli',
      supportsRetry: true,
      supportsWorkers: false,
    });
  });

  test('describes Codex CLI json backend', () => {
    const adapter = new CodexAdapter({ command: 'codex-wrapper', args: ['--sandbox', 'workspace-write'] });

    expect(adapter.descriptor).toMatchObject({
      id: 'codex',
      label: 'Codex CLI',
      runtime: 'json',
      commandLabel: 'codex-wrapper --sandbox workspace-write',
      supportsRetry: true,
      supportsWorkers: false,
    });
    expect(adapter.descriptor.sessionKey).toMatch(/^codex:/);
  });
});

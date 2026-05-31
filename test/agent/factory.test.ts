import { describe, expect, test } from 'vitest';
import { createAgentAdapter } from '../../src/agent/factory';
import type { AppConfig } from '../../src/config/schema';

function cfg(preferences: AppConfig['preferences']): AppConfig {
  return {
    accounts: { app: { id: 'app', secret: 'secret', tenant: 'feishu' } },
    preferences,
  };
}

describe('createAgentAdapter', () => {
  test('creates a Codex adapter for codex backend config', async () => {
    const adapter = await createAgentAdapter(
      cfg({
        agentCommand: {
          backend: 'codex',
          command: 'codex-wrapper',
          args: ['--profile', 'dev'],
          codexArgsOption: '--claude-args',
        },
        agentCodexModel: 'gpt-5.1-codex',
      }),
    );

    expect(adapter.id).toBe('codex');
    expect(adapter.sessionKey).toMatch(/^codex:/);
    expect(adapter.commandLabel).toBe('codex-wrapper --profile dev');
    expect(adapter.descriptor).toMatchObject({
      id: 'codex',
      label: 'Codex CLI',
      runtime: 'json',
      supportsRetry: true,
      supportsWorkers: false,
    });
  });
});

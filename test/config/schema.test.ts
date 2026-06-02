import { describe, expect, test } from 'vitest';
import {
  getAgentCommand,
  getAgentCodexModel,
  getAgentCursorLocalSettings,
  type AppConfig,
} from '../../src/config/schema';

function cfg(preferences: AppConfig['preferences']): AppConfig {
  return {
    accounts: { app: { id: 'app', secret: 'secret', tenant: 'feishu' } },
    preferences,
  };
}

describe('agent command config', () => {
  test('defaults codex backend command to codex', () => {
    expect(getAgentCommand(cfg({ agentCommand: { backend: 'codex' } }))).toEqual({
      backend: 'codex',
      command: 'codex',
      args: [],
    });
  });

  test('preserves custom codex command and args', () => {
    expect(
      getAgentCommand(
        cfg({
          agentCommand: {
            backend: 'codex',
            command: 'codex-wrapper',
            args: ['--profile', 'dev'],
          },
        }),
      ),
    ).toEqual({
      backend: 'codex',
      command: 'codex-wrapper',
      args: ['--profile', 'dev'],
    });
  });

  test('reads optional codex model', () => {
    expect(getAgentCodexModel(cfg({ agentCodexModel: 'gpt-5.1-codex' }))).toBe('gpt-5.1-codex');
    expect(getAgentCodexModel(cfg({ agentCodexModel: '   ' }))).toBeUndefined();
    expect(getAgentCodexModel(cfg({}))).toBeUndefined();
  });

  test('preserves codex args option only for codex backend', () => {
    expect(
      getAgentCommand(
        cfg({
          agentCommand: {
            backend: 'codex',
            command: 'ttadk',
            args: ['--profile', 'dev'],
            codexArgsOption: '--claude-args',
          },
        }),
      ),
    ).toEqual({
      backend: 'codex',
      command: 'ttadk',
      args: ['--profile', 'dev'],
      codexArgsOption: '--claude-args',
    });

    expect(
      getAgentCommand(
        cfg({
          agentCommand: {
            backend: 'claude',
            command: 'ttadk',
            codexArgsOption: '--claude-args',
          },
        }),
      ),
    ).toEqual({ backend: 'claude', command: 'ttadk', args: [] });
  });

  test('loads local Cursor settings by default for SDK runtime', () => {
    expect(getAgentCursorLocalSettings(cfg({}))).toBe('all');
    expect(getAgentCursorLocalSettings(cfg({ agentCursorLocalSettings: 'none' }))).toBe('none');
  });
});

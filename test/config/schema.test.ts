import { describe, expect, test } from 'vitest';
import {
  getAgentBackendConfigs,
  getAgentCommand,
  getAgentCodexModel,
  getAgentCursorLocalSettings,
  getAgentCursorRuntime,
  getDefaultAgentBackendKey,
  getMarkGroupUnreadOnFinalCard,
  getWorktreeBranchPrefix,
  type AppConfig,
} from '../../src/config/schema';

function cfg(preferences: AppConfig['preferences']): AppConfig {
  return {
    accounts: { app: { id: 'app', secret: 'secret', tenant: 'feishu' } },
    preferences,
  };
}

describe('getMarkGroupUnreadOnFinalCard', () => {
  test('defaults to enabled', () => {
    expect(getMarkGroupUnreadOnFinalCard(cfg({}))).toBe(true);
  });

  test('can be disabled explicitly', () => {
    expect(getMarkGroupUnreadOnFinalCard(cfg({ markGroupUnreadOnFinalCard: false }))).toBe(false);
  });

  test('stays enabled when explicitly true', () => {
    expect(getMarkGroupUnreadOnFinalCard(cfg({ markGroupUnreadOnFinalCard: true }))).toBe(true);
  });
});

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

  test('provides implicit default backend registry when no backend config is set', () => {
    expect(getAgentBackendConfigs(cfg({}))).toEqual({
      cursor: { backend: 'cursor', command: 'agent', args: [] },
      codex: { backend: 'codex', command: 'codex', args: [] },
      claude: { backend: 'claude', command: 'claude', args: [] },
    });
  });

  test('defaults to claude as the default backend key', () => {
    expect(getDefaultAgentBackendKey(cfg({}))).toBe('claude');
  });

  test('does not enable cursor sdk runtime when cursor is not the default backend', () => {
    expect(getAgentCursorRuntime(cfg({}))).toBe('cli');
  });

  test('resolves worktree branch prefix with validation fallback', () => {
    expect(getWorktreeBranchPrefix(cfg({}))).toBe('feat');
    expect(getWorktreeBranchPrefix(cfg({ worktreeBranchPrefix: 'pin' }))).toBe('pin');
    expect(getWorktreeBranchPrefix(cfg({ worktreeBranchPrefix: ' bad value ' }))).toBe('feat');
  });

  test('normalizes legacy single backend as the default backend config', () => {
    const config = cfg({ agentCommand: { backend: 'codex', command: 'codex' } });

    expect(getDefaultAgentBackendKey(config)).toBe('codex');
    expect(getAgentBackendConfigs(config)).toEqual({
      codex: { backend: 'codex', command: 'codex', args: [] },
    });
  });

  test('normalizes configured backend registry and default backend', () => {
    const config = cfg({
      defaultBackend: 'claude-fast',
      agentBackends: {
        'claude-fast': { backend: 'claude', command: 'claude', args: ['--fast'] },
        codex: { backend: 'codex', command: 'codex' },
      },
    });

    expect(getDefaultAgentBackendKey(config)).toBe('claude-fast');
    expect(getAgentBackendConfigs(config)).toEqual({
      'claude-fast': { backend: 'claude', command: 'claude', args: ['--fast'] },
      codex: { backend: 'codex', command: 'codex', args: [] },
    });
  });

  test('falls back to the first configured backend when default backend is missing', () => {
    const config = cfg({
      defaultBackend: 'missing',
      agentBackends: {
        cursor: { backend: 'cursor', command: 'agent' },
        codex: { backend: 'codex', command: 'codex' },
      },
    });

    expect(getDefaultAgentBackendKey(config)).toBe('cursor');
  });
});

import { describe, expect, test, vi } from 'vitest';
import type { AgentAdapter } from '../../src/agent/types';
import { renderSetupDiagnosticsText, runIncompleteSetupDiagnostics, runSetupDiagnostics } from '../../src/doctor/setup';
import type { AppConfig } from '../../src/config/schema';

function cfg(preferences: AppConfig['preferences'] = {}): AppConfig {
  return {
    accounts: { app: { id: 'app-id', secret: 'secret', tenant: 'feishu' } },
    preferences,
  };
}

function agent(overrides: Partial<AgentAdapter> = {}): AgentAdapter {
  return {
    id: 'codex',
    sessionKey: 'codex',
    displayName: 'Codex CLI',
    commandLabel: 'ttadk --profile dev',
    descriptor: {
      id: 'codex',
      label: 'Codex CLI',
      runtime: 'json',
      sessionKey: 'codex',
      commandLabel: 'ttadk --profile dev',
      supportsRetry: true,
      supportsWorkers: false,
    },
    isAvailable: vi.fn(async () => true),
    run: vi.fn(() => {
      throw new Error('not used');
    }),
    ...overrides,
  } as AgentAdapter;
}

describe('setup diagnostics', () => {
  test('reports config, backend, cwd, access, and process checks', async () => {
    const result = await runSetupDiagnostics({
      cfg: cfg({
        agentCommand: {
          backend: 'codex',
          command: 'ttadk',
          args: ['--profile', 'dev'],
          codexArgsOption: '--claude-args',
        },
        access: { admins: ['user-1'], allowedChats: ['chat-1'] },
      }),
      configPath: '/tmp/config.json',
      agent: agent(),
      cwd: process.cwd(),
      chat: { chatId: 'chat-1', chatMode: 'group', senderId: 'user-1' },
      sameAppProcesses: [{ id: 'abcd', pid: 1234, appId: 'app-id', tenant: 'feishu', configPath: '/tmp/config.json', startedAt: new Date().toISOString(), version: '0.1.0' }],
    });

    expect(result.summary.status).toBe('warn');
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'config.complete', status: 'pass' }),
        expect.objectContaining({ id: 'agent.available', status: 'pass' }),
        expect.objectContaining({ id: 'cwd.accessible', status: 'pass' }),
        expect.objectContaining({ id: 'codex.wrapper', status: 'info' }),
        expect.objectContaining({ id: 'access.sender', status: 'pass' }),
        expect.objectContaining({ id: 'process.conflict', status: 'warn' }),
      ]),
    );
  });

  test('reports unavailable agents and inaccessible cwd as failures', async () => {
    const result = await runSetupDiagnostics({
      cfg: cfg({ agentCommand: { backend: 'claude', command: 'missing-claude' } }),
      configPath: '/tmp/config.json',
      agent: agent({
        id: 'claude',
        sessionKey: 'claude',
        displayName: 'Claude Code',
        commandLabel: 'missing-claude',
        descriptor: {
          id: 'claude',
          label: 'Claude Code',
          runtime: 'cli',
          sessionKey: 'claude',
          commandLabel: 'missing-claude',
          supportsRetry: true,
          supportsWorkers: false,
        },
        isAvailable: vi.fn(async () => false),
      }),
      cwd: '/path/that/does/not/exist',
      sameAppProcesses: [],
    });

    expect(result.summary.status).toBe('fail');
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'agent.available', status: 'fail' }),
        expect.objectContaining({ id: 'cwd.accessible', status: 'fail' }),
      ]),
    );
  });

  test('renders terminal diagnostics with status icons and suggestions', async () => {
    const result = await runSetupDiagnostics({
      cfg: cfg({ agentCommand: { backend: 'codex', command: 'ttadk', codexArgsOption: '--claude-args' } }),
      configPath: '/tmp/config.json',
      agent: agent(),
      cwd: process.cwd(),
      sameAppProcesses: [],
    });

    const text = renderSetupDiagnosticsText(result);

    expect(text).toContain('Setup diagnostics:');
    expect(text).toContain('Codex CLI');
    expect(text).toContain('codexArgsOption');
  });

  test('terminal diagnostics show fail summary when failures exist', async () => {
    const result = await runSetupDiagnostics({
      cfg: cfg({ agentCommand: { backend: 'claude', command: 'missing-claude' } }),
      configPath: '/tmp/config.json',
      agent: agent({
        id: 'claude',
        sessionKey: 'claude',
        displayName: 'Claude Code',
        commandLabel: 'missing-claude',
        descriptor: {
          id: 'claude',
          label: 'Claude Code',
          runtime: 'cli',
          sessionKey: 'claude',
          commandLabel: 'missing-claude',
          supportsRetry: true,
          supportsWorkers: false,
        },
        isAvailable: vi.fn(async () => false),
      }),
      cwd: '/path/that/does/not/exist',
      sameAppProcesses: [],
    });

    expect(renderSetupDiagnosticsText(result)).toContain('Setup diagnostics: Setup has blocking issues');
  });

  test('diagnoses incomplete config without requiring an agent', () => {
    const result = runIncompleteSetupDiagnostics({ configPath: '/tmp/missing.json' });

    expect(result.summary.status).toBe('fail');
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'config.complete', status: 'fail' }),
      ]),
    );
    expect(renderSetupDiagnosticsText(result)).toContain('Setup diagnostics: Setup has blocking issues');
  });
});

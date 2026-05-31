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

  test('marks agent availability as failed when it times out', async () => {
    vi.useFakeTimers();
    const pending = new Promise<boolean>(() => {});
    const resultPromise = runSetupDiagnostics({
      cfg: cfg({ agentCommand: { backend: 'codex', command: 'ttadk' } }),
      configPath: '/tmp/config.json',
      agent: agent({ isAvailable: vi.fn(() => pending) }),
      cwd: process.cwd(),
      sameAppProcesses: [],
      timeouts: { agentAvailableMs: 100, secretResolveMs: 100 },
    });

    await vi.advanceTimersByTimeAsync(100);
    const result = await resultPromise;
    vi.useRealTimers();

    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'agent.available', status: 'fail', detail: expect.stringContaining('timed out') }),
    ]));
  });

  test('checks that the Lark app secret can resolve without revealing it', async () => {
    const result = await runSetupDiagnostics({
      cfg: cfg({}),
      configPath: '/tmp/config.json',
      agent: agent(),
      cwd: process.cwd(),
      sameAppProcesses: [],
      resolveAppSecret: async () => 'super-secret-value',
    });

    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'app.secret', status: 'pass' }),
    ]));
    expect(JSON.stringify(result)).not.toContain('super-secret-value');
  });

  test('reports app secret resolution failures without exposing provider error text', async () => {
    const result = await runSetupDiagnostics({
      cfg: cfg({}),
      configPath: '/tmp/config.json',
      agent: agent(),
      cwd: process.cwd(),
      sameAppProcesses: [],
      resolveAppSecret: async () => { throw new Error('secret is super-secret-value'); },
    });

    expect(result.summary.status).toBe('fail');
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'app.secret', status: 'fail', detail: 'Secret resolution failed.' }),
    ]));
    expect(JSON.stringify(result)).not.toContain('super-secret-value');
  });

  test('reports direct codex mode as informational, not warning', async () => {
    const result = await runSetupDiagnostics({
      cfg: cfg({ agentCommand: { backend: 'codex', command: 'codex' } }),
      configPath: '/tmp/config.json',
      agent: agent(),
      cwd: process.cwd(),
      sameAppProcesses: [],
    });

    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'codex.wrapper', status: 'info' }),
    ]));
  });
});

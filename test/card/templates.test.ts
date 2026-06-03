import { describe, expect, test, vi } from 'vitest';
import type { RunHistoryEntry } from '../../src/bot/run-history';
import { helpCard, runsCard, runDetailCard, setupDiagnosticsCard, statusCard } from '../../src/card/templates';
import type { SetupDiagnosticsResult } from '../../src/doctor/setup';

const agent = {
  id: 'claude',
  label: 'Claude Code',
  runtime: 'cli',
  sessionKey: 'claude',
  commandLabel: 'claude',
  supportsRetry: true,
  supportsWorkers: false,
};

function entry(overrides: Partial<RunHistoryEntry>): RunHistoryEntry {
  return {
    runId: 'run-1',
    scope: 'chat-1',
    chatId: 'chat-1',
    batch: [],
    createdAt: 1_000,
    updatedAt: 2_000,
    terminal: 'done',
    cwd: '/repo/project',
    agent,
    summary: 'fix failing test',
    ...overrides,
  };
}

describe('runs cards', () => {
  test('help card lists current in-chat slash commands', () => {
    const json = JSON.stringify(helpCard());

    [
      '/new',
      '/reset',
      '/new chat [name]',
      '/new worktree <name>',
      '/resume [N]',
      '/cd <path>',
      '/ws list',
      '/ws save <name>',
      '/ws use <name>',
      '/ws remove <name>',
      '/account',
      '/account change',
      '/config',
      '/status',
      '/runs [run-id]',
      '/backend [key|default]',
      '/doc bind <doc-url|token> <backend|default> <session-id>',
      '/stop',
      '/timeout [N|off|default]',
      '/retry <run-id>',
      '/shell <command>',
      '/workers',
      '/ps',
      '/exit <id|#>',
      '/reconnect',
      '/doctor [description]',
      '/doctor setup',
      '/doctor workers',
      '/help',
    ].forEach((command) => {
      expect(json).toContain(command);
    });
  });

  test('renders recent run status, summary, errors, and safe actions', () => {
    vi.setSystemTime(10_000);
    const card = runsCard({
      cwd: '/repo/project',
      entries: [
        entry({ runId: 'run-err', terminal: 'error', errorMsg: 'network timeout', createdAt: 9_000, updatedAt: 9_500 }),
        entry({ runId: 'run-timeout', terminal: 'idle_timeout', errorMsg: 'idle too long', createdAt: 8_500, updatedAt: 8_700 }),
        entry({ runId: 'run-live', terminal: 'running', createdAt: 8_000, updatedAt: 8_500 }),
        entry({ runId: 'run-ok', terminal: 'done', createdAt: 7_000, updatedAt: 7_500 }),
      ],
    });

    const json = JSON.stringify(card);
    expect(json).toContain('最近运行');
    expect(json).toContain('/repo/project');
    expect(json).toContain('fix failing test');
    expect(json).toContain('network timeout');
    expect(json).toContain('idle too long');
    expect(json).toContain('Claude Code');
    expect(json).toContain('cli');
    expect(json).toContain('⚠️');
    expect(json).toContain('⏱');
    expect(json).toContain('⏳');
    expect(json).toContain('✅');
    expect(json).toContain('出错');
    expect(json).toContain('运行中');
    expect(json).toContain('已完成');
    expect(json).toContain('cmd":"retry","run_id":"run-err');
    expect(json).toContain('cmd":"retry","run_id":"run-timeout');
    expect(json).toContain('cmd":"stop');
    expect(json).toContain('cmd":"runs.detail","run_id":"run-err');
    expect(json).toContain('cmd":"runs.detail","run_id":"run-timeout');
    expect(json).toContain('cmd":"runs.detail","run_id":"run-live');
    expect(json).toContain('cmd":"runs.detail","run_id":"run-ok');
  });

  test('renders malicious run summary and error inertly in recent runs', () => {
    const card = runsCard({
      cwd: '/repo/project',
      entries: [
        entry({
          terminal: 'error',
          summary: '[click](https://phish.example) <at id=all>',
          errorMsg: 'network [detail](https://evil.example) <at id=all>',
        }),
      ],
    });

    const json = JSON.stringify(card);
    expect(json).not.toContain('[click](https://phish.example)');
    expect(json).not.toContain('network [detail](https://evil.example)');
    expect(json).not.toContain('<at id=all>');
    expect(json).toContain('click');
    expect(json).toContain('phish.example');
    expect(json).toContain('network');
    expect(json).toContain('detail');
    expect(json).toContain('evil.example');
  });

  test('renders malicious run detail summary and error inertly', () => {
    const card = runDetailCard(
      entry({
        terminal: 'error',
        summary: '[click](https://phish.example) <at id=all>',
        errorMsg: 'network [detail](https://evil.example) <at id=all>',
      }),
    );

    const json = JSON.stringify(card);
    expect(json).not.toContain('[click](https://phish.example)');
    expect(json).not.toContain('network [detail](https://evil.example)');
    expect(json).not.toContain('<at id=all>');
    expect(json).toContain('click');
    expect(json).toContain('phish.example');
    expect(json).toContain('network');
    expect(json).toContain('detail');
    expect(json).toContain('evil.example');
  });

  test('renders an empty runs card with a next step', () => {
    const card = runsCard({ cwd: '/repo/project', entries: [] });

    expect(JSON.stringify(card)).toContain('暂无运行记录');
    expect(JSON.stringify(card)).toContain('/help');
  });

  test('renders run detail metadata with retry only for failed or timeout runs', () => {
    const idleTimeout = runDetailCard(entry({ runId: 'run-idle', terminal: 'idle_timeout', errorMsg: 'idle', streamMessageId: 'om_1' }));
    const failed = runDetailCard(entry({ runId: 'run-err', terminal: 'error', errorMsg: 'network timeout' }));
    const running = runDetailCard(entry({ runId: 'run-live', terminal: 'running' }));
    const done = runDetailCard(entry({ runId: 'run-ok', terminal: 'done' }));

    const idleJson = JSON.stringify(idleTimeout);
    expect(idleJson).toContain('run-idle');
    expect(idleJson).toContain('已超时');
    expect(idleJson).toContain('Claude Code');
    expect(idleJson).toContain('cli');
    expect(idleJson).toContain('claude');
    expect(idleJson).toContain('/repo/project');
    expect(idleJson).toContain('fix failing test');
    expect(idleJson).toContain('om_1');
    expect(idleJson).toContain('idle');
    expect(idleJson).toContain('cmd":"runs');
    expect(idleJson).toContain('cmd":"retry","run_id":"run-idle');
    expect(JSON.stringify(failed)).toContain('cmd":"retry","run_id":"run-err');
    expect(JSON.stringify(running)).toContain('cmd":"stop');
    expect(JSON.stringify(done)).not.toContain('cmd":"retry","run_id":"run-ok');
  });

  test('status card includes backend capabilities and latest run', () => {
    const card = statusCard({
      cwd: '/repo/project',
      sessionId: 'session-123456789',
      sessionStale: false,
      agentName: 'Claude Code',
      scope: 'chat-1',
      chatMode: 'p2p',
      agent,
      latestRun: entry({ runId: 'run-latest', terminal: 'error', errorMsg: 'network timeout' }),
    });

    const json = JSON.stringify(card);
    expect(json).toContain('runtime');
    expect(json).toContain('cli');
    expect(json).toContain('最近运行');
    expect(json).toContain('network timeout');
    expect(json).toContain('cmd":"runs.detail","run_id":"run-latest');
  });

  test('setup diagnostics card renders statuses and suggestions', () => {
    const result: SetupDiagnosticsResult = {
      summary: { status: 'warn', title: 'Setup has warnings' },
      checks: [
        { id: 'agent.available', status: 'pass', title: 'Agent command available', detail: 'ttadk --profile dev' },
        { id: 'process.conflict', status: 'warn', title: 'Duplicate bot processes', detail: '1 other process', suggestion: 'Use /ps and /exit.' },
      ],
    };

    const card = setupDiagnosticsCard(result);
    const json = JSON.stringify(card);

    expect(json).toContain('Setup has warnings');
    expect(json).toContain('Agent command available');
    expect(json).toContain('Use /ps and /exit.');
  });
});

import { describe, expect, test, vi } from 'vitest';
import { formatCursorRunResultError } from '../../../src/agent/cursor/sdk-run-diagnostics';

describe('formatCursorRunResultError', () => {
  test('surfaces the local run error code when run.wait returns no detail', async () => {
    const getRun = vi.fn(async () => ({
      errorCode: 'Model Blocked This model has been blocked by your team admin settings.',
    }));
    const createPlatform = vi.fn(async () => ({
      store: { getRun },
    }));

    const message = await formatCursorRunResultError(
      {
        id: 'run-1',
        status: 'error',
      },
      {
        agentId: 'agent-1',
        cwd: '/tmp/project',
        createPlatform,
      },
    );

    expect(message).toBe(
      'sdk run failed (runId=run-1, status=error): Model Blocked This model has been blocked by your team admin settings.',
    );
    expect(createPlatform).toHaveBeenCalledWith({ workspaceRef: '/tmp/project' });
    expect(getRun).toHaveBeenCalledWith('agent-1', 'run-1');
  });
});

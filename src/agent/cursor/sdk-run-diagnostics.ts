import { createAgentPlatform } from '@cursor/sdk';

interface RunResultLike {
  id: string;
  status: string;
  result?: unknown;
}

interface RunDiagnosticsRecord {
  errorCode?: unknown;
}

interface RunDiagnosticsPlatform {
  store: {
    getRun(agentId: string, runId: string): Promise<RunDiagnosticsRecord | null | undefined>;
  };
}

export interface CursorRunDiagnosticsOptions {
  agentId?: string;
  cwd?: string;
  createPlatform?: (options: { workspaceRef: string }) => Promise<RunDiagnosticsPlatform>;
}

export async function formatCursorRunResultError(
  result: RunResultLike,
  options: CursorRunDiagnosticsOptions = {},
): Promise<string> {
  const headline = `sdk run failed (runId=${result.id}, status=${result.status})`;
  if (typeof result.result === 'string' && result.result.trim()) {
    return `${headline}: ${result.result.trim()}`;
  }

  const localErrorCode = await lookupLocalRunErrorCode(result.id, options);
  if (localErrorCode) {
    return `${headline}: ${localErrorCode}`;
  }

  const diagnostic = safeJson({
    id: result.id,
    status: result.status,
    result: result.result,
  });
  return `${headline}; Cursor returned no error detail${diagnostic ? ` | result=${diagnostic}` : ''}`;
}

async function lookupLocalRunErrorCode(
  runId: string,
  options: CursorRunDiagnosticsOptions,
): Promise<string | undefined> {
  if (!options.agentId || !options.cwd) return undefined;
  const createPlatformImpl = options.createPlatform ?? createAgentPlatform;
  try {
    const platform = await createPlatformImpl({ workspaceRef: options.cwd });
    const record = await platform.store.getRun(options.agentId, runId);
    if (typeof record?.errorCode === 'string' && record.errorCode.trim()) {
      return record.errorCode.trim();
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value).slice(0, 1200);
  } catch {
    return '';
  }
}

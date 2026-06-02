import { stat } from 'node:fs/promises';
import type { AgentAdapter, AgentAvailability } from '../agent/types';
import { resolveAppSecret } from '../config/secret-resolver';
import type { AppConfig } from '../config/schema';
import {
  getAgentCommand,
  getAgentCursorRuntime,
  getAgentSessionPoolSize,
  isChatAllowed,
  isComplete,
  isUserAllowed,
} from '../config/schema';
import type { ProcessEntry } from '../runtime/registry';

export type DiagnosticStatus = 'pass' | 'warn' | 'fail' | 'info';

export interface SetupDiagnosticCheck {
  id: string;
  status: DiagnosticStatus;
  title: string;
  detail: string;
  suggestion?: string;
}

export interface SetupDiagnosticsResult {
  summary: { status: DiagnosticStatus; title: string };
  checks: SetupDiagnosticCheck[];
}

export interface SetupDiagnosticsInput {
  cfg: AppConfig;
  configPath: string;
  agent: AgentAdapter;
  cwd: string;
  chat?: { chatId: string; chatMode: 'p2p' | 'group' | 'topic'; senderId: string };
  sameAppProcesses: ProcessEntry[];
  timeouts?: { agentAvailableMs?: number; secretResolveMs?: number };
  resolveAppSecret?: (cfg: AppConfig) => Promise<string>;
}

const DEFAULT_AGENT_AVAILABLE_TIMEOUT_MS = 20_000;
const DEFAULT_SECRET_RESOLVE_TIMEOUT_MS = 5_000;

export function runIncompleteSetupDiagnostics(input: { configPath: string }): SetupDiagnosticsResult {
  const checks: SetupDiagnosticCheck[] = [
    {
      id: 'config.complete',
      status: 'fail',
      title: 'Config complete',
      detail: `Loaded ${input.configPath}`,
      suggestion: 'Run lark-agent-bridge start to complete app setup.',
    },
  ];
  return { summary: summarize(checks), checks };
}

export async function runSetupDiagnostics(input: SetupDiagnosticsInput): Promise<SetupDiagnosticsResult> {
  const checks: SetupDiagnosticCheck[] = [];
  const command = getAgentCommand(input.cfg);

  checks.push({
    id: 'config.complete',
    status: isComplete(input.cfg) ? 'pass' : 'fail',
    title: 'Config complete',
    detail: `Loaded ${input.configPath}`,
    suggestion: isComplete(input.cfg) ? undefined : 'Run lark-agent-bridge start to complete app setup.',
  });

  checks.push({
    id: 'agent.backend',
    status: 'info',
    title: 'Agent backend',
    detail: `${input.agent.descriptor.label} / ${input.agent.descriptor.runtime} / ${input.agent.descriptor.sessionKey}`,
  });

  const secretResolver = input.resolveAppSecret ?? resolveAppSecret;
  const secretResult = await withTimeoutResult(
    secretResolver(input.cfg),
    input.timeouts?.secretResolveMs ?? DEFAULT_SECRET_RESOLVE_TIMEOUT_MS,
  );
  checks.push({
    id: 'app.secret',
    status: secretResult.ok ? 'pass' : 'fail',
    title: 'App secret',
    detail: secretResult.ok ? 'Secret resolved.' : 'Secret resolution failed.',
    suggestion: secretResult.ok ? undefined : 'Check accounts.app.secret, env vars, file refs, or exec secret provider.',
  });

  const availability = await withTimeoutResult(
    checkAgentAvailability(input.agent),
    input.timeouts?.agentAvailableMs ?? DEFAULT_AGENT_AVAILABLE_TIMEOUT_MS,
  );
  const available = availability.ok ? availability.value.ok : false;
  const availabilityDetail = availability.ok
    ? availability.value.ok
      ? input.agent.commandLabel
      : `${input.agent.commandLabel}: ${availability.value.error}`
    : `${input.agent.commandLabel}: ${availability.error.message}`;
  checks.push({
    id: 'agent.available',
    status: available ? 'pass' : 'fail',
    title: 'Agent command available',
    detail: availabilityDetail,
    suggestion: available ? undefined : 'Check preferences.agentCommand.command, wrapper args, PATH, or backend login/auth.',
  });

  checks.push(await cwdCheck(input.cwd));

  if (command.backend === 'codex') {
    checks.push({
      id: 'codex.wrapper',
      status: 'info',
      title: 'Codex wrapper mode',
      detail: command.codexArgsOption
        ? `codexArgsOption=${command.codexArgsOption}; availability check uses the wrapper path.`
        : 'Direct codex command; no codexArgsOption configured.',
      suggestion: command.codexArgsOption ? undefined : 'If running through ttadk, configure preferences.agentCommand.codexArgsOption.',
    });
  }

  if (command.backend === 'cursor') {
    const runtime = getAgentCursorRuntime(input.cfg);
    const poolSize = getAgentSessionPoolSize(input.cfg);
    checks.push({
      id: 'cursor.runtime',
      status: 'info',
      title: 'Cursor runtime',
      detail: `${runtime}; pool size ${poolSize}`,
    });
  }

  if (input.chat) {
    const userAllowed = isUserAllowed(input.cfg, input.chat.senderId);
    checks.push({
      id: 'access.sender',
      status: userAllowed ? 'pass' : 'fail',
      title: 'Sender access',
      detail: userAllowed ? 'Sender is allowed by current config.' : 'Sender is blocked by allowedUsers.',
      suggestion: userAllowed ? undefined : 'Update preferences.access.allowedUsers or ask an admin to run /config.',
    });
    const chatAllowed = input.chat.chatMode === 'p2p' || isChatAllowed(input.cfg, input.chat.chatId);
    checks.push({
      id: 'access.chat',
      status: chatAllowed ? 'pass' : 'fail',
      title: 'Chat access',
      detail: chatAllowed ? 'Chat is allowed by current config.' : 'Chat is blocked by allowedChats.',
      suggestion: chatAllowed ? undefined : 'Update preferences.access.allowedChats or DM the bot to adjust config.',
    });
  }

  checks.push({
    id: 'process.conflict',
    status: input.sameAppProcesses.length > 0 ? 'warn' : 'pass',
    title: 'Duplicate bot processes',
    detail: input.sameAppProcesses.length > 0
      ? `${input.sameAppProcesses.length} other process(es) are registered for this app.`
      : 'No other live process registered for this app.',
    suggestion: input.sameAppProcesses.length > 0 ? 'Use /ps and /exit, or lark-agent-bridge ps/stop, to remove duplicates.' : undefined,
  });

  return { summary: summarize(checks), checks };
}

async function withTimeoutResult<T>(promise: Promise<T>, timeoutMs: number): Promise<{ ok: true; value: T } | { ok: false; error: Error }> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise
        .then((value) => ({ ok: true as const, value }))
        .catch((err) => ({ ok: false as const, error: err instanceof Error ? err : new Error(String(err)) })),
      new Promise<{ ok: false; error: Error }>((resolve) => {
        timer = setTimeout(() => resolve({ ok: false, error: new Error(`timed out after ${timeoutMs}ms`) }), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function checkAgentAvailability(agent: AgentAdapter): Promise<AgentAvailability> {
  if (agent.checkAvailability) return agent.checkAvailability();
  return (await agent.isAvailable()) ? { ok: true } : { ok: false, error: 'not available' };
}

async function cwdCheck(cwd: string): Promise<SetupDiagnosticCheck> {
  try {
    const st = await stat(cwd);
    if (!st.isDirectory()) {
      return {
        id: 'cwd.accessible',
        status: 'fail',
        title: 'Working directory',
        detail: `${cwd} is not a directory.`,
        suggestion: 'Use /cd <path> or /ws use <name> to switch cwd.',
      };
    }
    return { id: 'cwd.accessible', status: 'pass', title: 'Working directory', detail: cwd };
  } catch (err) {
    return {
      id: 'cwd.accessible',
      status: 'fail',
      title: 'Working directory',
      detail: `${cwd}: ${(err as Error).message}`,
      suggestion: 'Use /cd <path> or /ws use <name> to switch to an existing directory.',
    };
  }
}

function summarize(checks: SetupDiagnosticCheck[]): SetupDiagnosticsResult['summary'] {
  if (checks.some((check) => check.status === 'fail')) return { status: 'fail', title: 'Setup has blocking issues' };
  if (checks.some((check) => check.status === 'warn')) return { status: 'warn', title: 'Setup has warnings' };
  return { status: 'pass', title: 'Setup looks ready' };
}

export function renderSetupDiagnosticsText(result: SetupDiagnosticsResult): string {
  const lines = [`Setup diagnostics: ${result.summary.title}`, ''];
  for (const check of result.checks) {
    lines.push(`${statusIcon(check.status)} ${check.title}: ${check.detail}`);
    if (check.suggestion) lines.push(`   Fix: ${check.suggestion}`);
  }
  return lines.join('\n');
}

function statusIcon(status: DiagnosticStatus): string {
  if (status === 'pass') return '✓';
  if (status === 'warn') return '⚠';
  if (status === 'fail') return '✗';
  return '•';
}

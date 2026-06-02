import { resolveAgentCursorApiKey } from '../config/secret-resolver';
import type { AppConfig } from '../config/schema';
import {
  getAgentCursorCliModel,
  getAgentCursorSdkModel,
} from './cursor/model-selection';
import {
  getAgentCodexModel,
  getAgentCommand,
  getAgentCursorLocalSettings,
  getAgentCursorRuntime,
  getAgentSessionPoolSize,
} from '../config/schema';
import { ClaudeAdapter } from './claude/adapter';
import { CodexAdapter } from './codex/adapter';
import { CursorAdapter } from './cursor/adapter';
import type { AgentAdapter } from './types';

export async function createAgentAdapter(cfg: AppConfig): Promise<AgentAdapter> {
  const command = getAgentCommand(cfg);
  if (command.backend === 'cursor') {
    const apiKey = await resolveAgentCursorApiKey(cfg);
    return new CursorAdapter({
      command: command.command,
      args: command.args,
      runtime: getAgentCursorRuntime(cfg),
      sessionPoolSize: getAgentSessionPoolSize(cfg),
      defaultCliModel: getAgentCursorCliModel(cfg),
      defaultSdkModel: getAgentCursorSdkModel(cfg),
      apiKey,
      localSettingSources: getAgentCursorLocalSettings(cfg),
    });
  }
  if (command.backend === 'codex') {
    return new CodexAdapter({
      command: command.command,
      args: command.args,
      codexArgsOption: command.codexArgsOption,
      defaultModel: getAgentCodexModel(cfg),
    });
  }
  return new ClaudeAdapter(command);
}

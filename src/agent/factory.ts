import { resolveAgentCursorApiKey } from '../config/secret-resolver';
import type { AppConfig } from '../config/schema';
import {
  getAgentCursorCliModel,
  getAgentCursorSdkModel,
} from './cursor/model-selection';
import {
  getAgentCommand,
  getAgentCursorRuntime,
  getAgentSessionPoolSize,
} from '../config/schema';
import { ClaudeAdapter } from './claude/adapter';
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
    });
  }
  return new ClaudeAdapter(command);
}

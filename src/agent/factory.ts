import type { AppConfig } from '../config/schema';
import {
  getAgentCommand,
  getAgentCursorRuntime,
  getAgentSessionPoolSize,
} from '../config/schema';
import { ClaudeAdapter } from './claude/adapter';
import { CursorAdapter } from './cursor/adapter';
import type { AgentAdapter } from './types';

export function createAgentAdapter(cfg: AppConfig): AgentAdapter {
  const command = getAgentCommand(cfg);
  if (command.backend === 'cursor') {
    return new CursorAdapter({
      command: command.command,
      args: command.args,
      runtime: getAgentCursorRuntime(cfg),
      sessionPoolSize: getAgentSessionPoolSize(cfg),
    });
  }
  return new ClaudeAdapter(command);
}

import type { AppConfig } from '../config/schema';
import { getAgentCommand } from '../config/schema';
import { ClaudeAdapter } from './claude/adapter';
import { CursorAdapter } from './cursor/adapter';
import type { AgentAdapter } from './types';

export function createAgentAdapter(cfg: AppConfig): AgentAdapter {
  const command = getAgentCommand(cfg);
  if (command.backend === 'cursor') {
    return new CursorAdapter(command);
  }
  return new ClaudeAdapter(command);
}

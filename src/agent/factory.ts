import { resolveAgentCursorApiKey } from '../config/secret-resolver';
import type { AppConfig } from '../config/schema';
import {
  getAgentCursorCliModel,
  getAgentCursorSdkModel,
} from './cursor/model-selection';
import {
  getAgentBackendConfigs,
  getAgentCodexModel,
  getAgentCommand,
  getAgentCursorLocalSettings,
  getAgentCursorRuntime,
  getAgentSessionPoolSize,
  getDefaultAgentBackendKey,
  normalizeAgentCommand,
} from '../config/schema';
import { ClaudeAdapter } from './claude/adapter';
import { CodexAdapter } from './codex/adapter';
import { CursorAdapter } from './cursor/adapter';
import { AgentRegistry } from './registry';
import type { AgentAdapter } from './types';

type NormalizedAgentCommand = ReturnType<typeof normalizeAgentCommand>;

export async function createAgentAdapterFromCommand(
  cfg: AppConfig,
  command: NormalizedAgentCommand,
  backendKey: string = command.backend,
): Promise<AgentAdapter> {
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
      backendKey,
    });
  }
  return new ClaudeAdapter(command);
}

export async function createAgentAdapter(cfg: AppConfig): Promise<AgentAdapter> {
  return createAgentAdapterFromCommand(cfg, getAgentCommand(cfg));
}

export async function createAgentRegistry(cfg: AppConfig): Promise<AgentRegistry> {
  const configs = getAgentBackendConfigs(cfg);
  const defaultKey = getDefaultAgentBackendKey(cfg);
  return new AgentRegistry(Object.keys(configs), defaultKey, (key) => createAgentAdapterFromCommand(cfg, configs[key]!, key));
}

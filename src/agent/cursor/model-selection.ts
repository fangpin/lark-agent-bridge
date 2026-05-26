import type { AppConfig } from '../../config/schema';

/** SDK `ModelSelection` shape (mirrors @cursor/sdk). */
export interface CursorSdkModelSelection {
  id: string;
  params?: Array<{ id: string; value: string }>;
}

/** CLI `--model` preset → SDK base id + parameters. */
const CLI_VARIANT_TO_SDK: Record<string, CursorSdkModelSelection> = {
  'gpt-5.5-extra-high-fast': {
    id: 'gpt-5.5',
    params: [
      { id: 'context', value: '272k' },
      { id: 'reasoning', value: 'extra-high' },
      { id: 'fast', value: 'true' },
    ],
  },
  'composer-2.5-fast': {
    id: 'composer-2.5',
    params: [{ id: 'fast', value: 'true' }],
  },
};

/** Default CLI `--model` (see `agent --list-models`). */
export const DEFAULT_AGENT_CURSOR_CLI_MODEL = 'gpt-5.5-extra-high-fast';

/** Default SDK selection equivalent to GPT-5.5 Extra High Fast. */
export const DEFAULT_AGENT_CURSOR_SDK_MODEL: CursorSdkModelSelection =
  CLI_VARIANT_TO_SDK[DEFAULT_AGENT_CURSOR_CLI_MODEL]!;

/** `preferences.agentCursorModel` — passed to CLI as `--model`. */
export function getAgentCursorCliModel(cfg: AppConfig): string {
  const raw = cfg.preferences?.agentCursorModel?.trim();
  return raw || DEFAULT_AGENT_CURSOR_CLI_MODEL;
}

/**
 * `preferences.agentCursorSdkModel` if set; otherwise map CLI variant id to SDK
 * `ModelSelection`, or use the string as a base model id when already valid.
 */
export function getAgentCursorSdkModel(cfg: AppConfig): CursorSdkModelSelection {
  const explicit = cfg.preferences?.agentCursorSdkModel;
  if (explicit?.id?.trim()) {
    return {
      id: explicit.id.trim(),
      ...(explicit.params?.length ? { params: explicit.params } : {}),
    };
  }

  const cliModel = getAgentCursorCliModel(cfg);
  const mapped = CLI_VARIANT_TO_SDK[cliModel];
  if (mapped) return mapped;

  return { id: cliModel };
}

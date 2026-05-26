import { describe, expect, test } from 'vitest';
import {
  getAgentCursorCliModel,
  getAgentCursorSdkModel,
} from '../../../src/agent/cursor/model-selection';
import type { AppConfig } from '../../../src/config/schema';

function cfg(prefs: AppConfig['preferences']): AppConfig {
  return {
    accounts: {
      app: { id: 'cli_test', secret: 'x', tenant: 'feishu' },
    },
    preferences: prefs,
  };
}

describe('getAgentCursorSdkModel', () => {
  test('maps CLI variant gpt-5.5-extra-high-fast to base id + params', () => {
    const model = getAgentCursorSdkModel(
      cfg({ agentCursorModel: 'gpt-5.5-extra-high-fast' }),
    );
    expect(model.id).toBe('gpt-5.5');
    expect(model.params).toEqual(
      expect.arrayContaining([
        { id: 'reasoning', value: 'extra-high' },
        { id: 'fast', value: 'true' },
      ]),
    );
  });

  test('uses explicit agentCursorSdkModel when set', () => {
    const model = getAgentCursorSdkModel(
      cfg({
        agentCursorSdkModel: { id: 'composer-2.5', params: [{ id: 'fast', value: 'true' }] },
      }),
    );
    expect(model).toEqual({
      id: 'composer-2.5',
      params: [{ id: 'fast', value: 'true' }],
    });
  });

  test('passes through base model ids', () => {
    expect(getAgentCursorSdkModel(cfg({ agentCursorModel: 'gpt-5.5' }))).toEqual({
      id: 'gpt-5.5',
    });
  });
});

describe('getAgentCursorCliModel', () => {
  test('defaults to gpt-5.5-extra-high-fast', () => {
    expect(getAgentCursorCliModel(cfg({}))).toBe('gpt-5.5-extra-high-fast');
  });
});

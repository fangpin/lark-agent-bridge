import { describe, expect, test, vi } from 'vitest';
import { AgentRegistry } from '../../src/agent/registry';
import type { AgentAdapter } from '../../src/agent/types';

function fakeAgent(key: string): AgentAdapter {
  return {
    id: key,
    sessionKey: key,
    displayName: key,
    commandLabel: key,
    descriptor: {
      id: key,
      label: key,
      runtime: 'test',
      sessionKey: key,
      commandLabel: key,
      supportsRetry: true,
      supportsWorkers: false,
    },
    isAvailable: async () => true,
    run: () => {
      throw new Error('not used');
    },
  };
}

describe('AgentRegistry', () => {
  test('lazily creates adapters and returns the default backend', async () => {
    const create = vi.fn(async (key: string) => fakeAgent(key));
    const registry = new AgentRegistry(['claude', 'codex'], 'claude', create);

    expect(registry.keys()).toEqual(['claude', 'codex']);
    expect(registry.defaultKey()).toBe('claude');
    expect(await registry.getDefault()).toMatchObject({ id: 'claude' });
    expect(await registry.get('claude')).toBe(await registry.get('claude'));
    expect(create).toHaveBeenCalledTimes(1);
  });

  test('falls back to default when requested key is unknown', async () => {
    const registry = new AgentRegistry(['claude'], 'claude', async (key) => fakeAgent(key));

    expect(registry.has('missing')).toBe(false);
    expect(await registry.getOrDefault('missing')).toMatchObject({ id: 'claude' });
  });

  test('shuts down created adapters only', async () => {
    const shutdown = vi.fn(async () => undefined);
    const registry = new AgentRegistry(['claude', 'codex'], 'claude', async (key) => ({
      ...fakeAgent(key),
      shutdown,
    }));

    await registry.get('codex');
    await registry.shutdown();

    expect(shutdown).toHaveBeenCalledTimes(1);
  });
});

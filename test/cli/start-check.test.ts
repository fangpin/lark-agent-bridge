import { describe, expect, test } from 'vitest';
import { shouldSkipConfigMutationForCheck } from '../../src/cli/commands/start';

describe('start --check', () => {
  test('skips config mutation paths in check mode', () => {
    expect(shouldSkipConfigMutationForCheck({ check: true })).toBe(true);
    expect(shouldSkipConfigMutationForCheck({ check: false })).toBe(false);
    expect(shouldSkipConfigMutationForCheck({})).toBe(false);
  });
});

import { describe, expect, test } from 'vitest';
import {
  packageSpec,
  parseArgs,
  summarizeGitStatus,
  validatePackageVersions,
} from '../../tools/release-check.mjs';

describe('release-check helpers', () => {
  test('detects tracked changes while reporting untracked files separately', () => {
    expect(summarizeGitStatus(' M README.md\n?? scratch.txt\nA  scripts/release-check.mjs\n')).toEqual({
      trackedDirty: true,
      untracked: ['scratch.txt'],
    });
  });

  test('validates package and lockfile versions match', () => {
    expect(validatePackageVersions({ version: '1.2.3' }, { version: '1.2.3', packages: { '': { version: '1.2.3' } } })).toEqual([]);
    expect(validatePackageVersions({ version: '1.2.3' }, { version: '1.2.4', packages: { '': { version: '1.2.5' } } })).toEqual([
      'package-lock.json version is 1.2.4, expected 1.2.3',
      'package-lock root version is 1.2.5, expected 1.2.3',
    ]);
  });

  test('builds npm package specs and parses registry flags', () => {
    expect(packageSpec('lark-agent-bridge', '0.1.41')).toBe('lark-agent-bridge@0.1.41');
    expect(parseArgs(['--registry', 'https://registry.npmjs.org/', '--skip-registry'])).toMatchObject({
      registry: 'https://registry.npmjs.org/',
      skipRegistry: true,
    });
  });
});

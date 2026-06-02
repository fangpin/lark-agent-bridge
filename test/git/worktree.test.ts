import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, test } from 'vitest';
import { buildWorktreePlan, createGitWorktree, validateWorktreeName } from '../../src/git/worktree';

const execFileAsync = promisify(execFile);
const cleanupDirs: string[] = [];

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd });
}

afterEach(async () => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe('git worktree helpers', () => {
  test('accepts safe worktree names', () => {
    expect(validateWorktreeName('abc-DEF_1.2')).toBeUndefined();
  });

  test('rejects empty worktree names', () => {
    expect(validateWorktreeName('')).toBe('worktree 名不能为空。');
  });

  test('rejects unsafe worktree names', () => {
    expect(validateWorktreeName('fix login')).toContain('只能包含');
    expect(validateWorktreeName('../bad')).toContain('只能包含');
  });

  test('builds worktree plan next to cwd with prefixed branch', () => {
    expect(buildWorktreePlan('/home/me/repos/project_a', 'pin', 'abc')).toEqual({
      name: 'abc',
      branch: 'pin/abc',
      path: '/home/me/repos/project_a_pin_abc',
    });
  });

  test('creates worktree path from git top-level when cwd is a repo subdirectory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-agent-worktree-'));
    cleanupDirs.push(root);
    const repo = join(root, 'project_a');
    const subdir = join(repo, 'packages', 'app');
    await mkdir(subdir, { recursive: true });
    await git(repo, ['init']);
    await git(repo, ['commit', '--allow-empty', '-m', 'initial']);
    await git(repo, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);

    const result = await createGitWorktree(subdir, 'pin', 'abc');
    cleanupDirs.push(result.path);

    expect(result.path).toBe(join(root, 'project_a_pin_abc'));
  });
});

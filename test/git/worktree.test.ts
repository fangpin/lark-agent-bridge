import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, test } from 'vitest';
import {
  buildWorktreePlan,
  createGitWorktree,
  inspectWorktreeClearTarget,
  removeGitWorktreeAndBranch,
  validateWorktreeName,
} from '../../src/git/worktree';

const execFileAsync = promisify(execFile);
const cleanupDirs: string[] = [];

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd });
}

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
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

  test('inspects a secondary worktree clear target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-agent-worktree-clear-'));
    cleanupDirs.push(root);
    const repo = join(root, 'project_a');
    const wt = join(root, 'project_a_pin_abc');
    await mkdir(repo, { recursive: true });
    await git(repo, ['init']);
    await git(repo, ['commit', '--allow-empty', '-m', 'initial']);
    await git(repo, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    await git(repo, ['worktree', 'add', '-b', 'pin/abc', wt, 'origin/main']);
    cleanupDirs.push(wt);

    const target = await inspectWorktreeClearTarget(wt);

    expect(target.path).toBe(wt);
    expect(target.primaryPath).toBe(repo);
    expect(target.branch).toBe('pin/abc');
    expect(target.baseRef).toBe('origin/main');
    expect(target.dirty).toBe(false);
    expect(target.unmerged).toBe(false);
  });

  test('rejects the primary worktree as a clear target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-agent-worktree-primary-'));
    cleanupDirs.push(root);
    const repo = join(root, 'project_a');
    await mkdir(repo, { recursive: true });
    await git(repo, ['init']);
    await git(repo, ['commit', '--allow-empty', '-m', 'initial']);
    await git(repo, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);

    await expect(inspectWorktreeClearTarget(repo)).rejects.toMatchObject({
      code: 'primary-worktree',
    });
  });

  test('reports dirty and unmerged safety state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-agent-worktree-dirty-'));
    cleanupDirs.push(root);
    const repo = join(root, 'project_a');
    const wt = join(root, 'project_a_pin_dirty');
    await mkdir(repo, { recursive: true });
    await git(repo, ['init']);
    await git(repo, ['commit', '--allow-empty', '-m', 'initial']);
    await git(repo, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    await git(repo, ['worktree', 'add', '-b', 'pin/dirty', wt, 'origin/main']);
    cleanupDirs.push(wt);
    await git(wt, ['commit', '--allow-empty', '-m', 'worktree commit']);
    await writeFile(join(wt, 'scratch.txt'), 'dirty');

    const target = await inspectWorktreeClearTarget(wt);

    expect(target.dirty).toBe(true);
    expect(target.unmerged).toBe(true);
    expect(target.safetyIssues).toEqual([
      'worktree has uncommitted or untracked changes',
      'branch has commits not merged into origin/main',
    ]);
  });

  test('removes worktree and branch with force when requested', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-agent-worktree-remove-'));
    cleanupDirs.push(root);
    const repo = join(root, 'project_a');
    const wt = join(root, 'project_a_pin_remove');
    await mkdir(repo, { recursive: true });
    await git(repo, ['init']);
    await git(repo, ['commit', '--allow-empty', '-m', 'initial']);
    await git(repo, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    await git(repo, ['worktree', 'add', '-b', 'pin/remove', wt, 'origin/main']);
    await writeFile(join(wt, 'scratch.txt'), 'dirty');

    const target = await inspectWorktreeClearTarget(wt);
    await removeGitWorktreeAndBranch(target, true);

    await expect(gitOutput(repo, ['worktree', 'list', '--porcelain'])).resolves.not.toContain(wt);
    await expect(execFileAsync('git', ['show-ref', '--verify', '--quiet', 'refs/heads/pin/remove'], { cwd: repo })).rejects.toBeTruthy();
  });
});

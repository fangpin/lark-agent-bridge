import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export interface WorktreePlan {
  name: string;
  branch: string;
  path: string;
}

export interface WorktreeCreateResult extends WorktreePlan {
  base: 'origin/main' | 'origin/master';
}

export type WorktreeClearErrorCode =
  | 'not-git-worktree'
  | 'primary-worktree'
  | 'missing-worktree-entry'
  | 'missing-branch';

export class WorktreeClearError extends Error {
  constructor(
    readonly code: WorktreeClearErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'WorktreeClearError';
  }
}

export interface WorktreeClearTarget {
  path: string;
  primaryPath: string;
  branch: string;
  baseRef?: 'origin/main' | 'origin/master';
  dirty: boolean;
  unmerged: boolean;
  safetyIssues: string[];
}

interface WorktreeListEntry {
  path: string;
  branch?: string;
}

export function validateWorktreeName(name: string): string | undefined {
  if (!name) return 'worktree 名不能为空。';
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return 'worktree 名只能包含字母、数字、点、下划线和连字符。';
  return undefined;
}

export function buildWorktreePlan(cwd: string, prefix: string, name: string): WorktreePlan {
  const baseName = path.basename(cwd);
  const parent = path.dirname(cwd);
  return {
    name,
    branch: `${prefix}/${name}`,
    path: path.join(parent, `${baseName}_${prefix}_${name}`),
  };
}

export async function createGitWorktree(cwd: string, prefix: string, name: string): Promise<WorktreeCreateResult> {
  const validationError = validateWorktreeName(name);
  if (validationError) throw new Error(validationError);

  const gitRoot = await resolveGitTopLevel(cwd);

  const plan = buildWorktreePlan(gitRoot, prefix, name);
  if (existsSync(plan.path)) throw new Error(`worktree 路径已存在：${plan.path}`);

  const branchExists = await gitSucceeds(gitRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${plan.branch}`]);
  if (branchExists) throw new Error(`分支已存在：${plan.branch}`);

  const base = await selectBaseRef(gitRoot);
  await runGit(gitRoot, ['worktree', 'add', '-b', plan.branch, plan.path, base]);
  return { ...plan, base };
}

export async function resolveGitTopLevel(cwd: string): Promise<string> {
  const result = await runGit(cwd, ['rev-parse', '--show-toplevel']);
  return result.stdout.trim();
}

export async function inspectWorktreeClearTarget(cwd: string): Promise<WorktreeClearTarget> {
  let gitRoot: string;
  try {
    gitRoot = await resolveGitTopLevel(cwd);
  } catch (err) {
    throw new WorktreeClearError(
      'not-git-worktree',
      err instanceof Error ? err.message : '当前目录不是 git worktree。',
    );
  }

  const list = await runGit(gitRoot, ['worktree', 'list', '--porcelain']);
  const entries = parseWorktreeListPorcelain(list.stdout);
  const primary = entries[0];
  if (!primary) throw new WorktreeClearError('missing-worktree-entry', '找不到 git worktree 信息。');

  const current = entries.find((entry) => samePath(entry.path, gitRoot));
  if (!current) {
    throw new WorktreeClearError('missing-worktree-entry', `当前路径不在 git worktree 列表中：${gitRoot}`);
  }
  if (samePath(current.path, primary.path)) {
    throw new WorktreeClearError('primary-worktree', '当前目录是主 worktree，/clear 不会删除主仓库。');
  }
  if (!current.branch) {
    throw new WorktreeClearError('missing-branch', '当前 worktree 没有关联本地分支，无法安全清理。');
  }

  const dirty = (await runGit(current.path, ['status', '--porcelain', '--untracked-files=normal'])).stdout.trim().length > 0;
  const baseRef = await trySelectBaseRef(primary.path);
  const unmerged = baseRef
    ? Number((await runGit(primary.path, ['rev-list', '--count', `${baseRef}..${current.branch}`])).stdout.trim()) > 0
    : true;
  const safetyIssues = [
    dirty ? 'worktree has uncommitted or untracked changes' : '',
    unmerged ? `branch has commits not merged into ${baseRef ?? 'origin/main or origin/master'}` : '',
  ].filter(Boolean);

  return {
    path: current.path,
    primaryPath: primary.path,
    branch: current.branch,
    ...(baseRef ? { baseRef } : {}),
    dirty,
    unmerged,
    safetyIssues,
  };
}

export async function removeGitWorktreeAndBranch(target: WorktreeClearTarget, force: boolean): Promise<void> {
  await runGit(target.primaryPath, ['worktree', 'remove', ...(force ? ['--force'] : []), target.path]);
  await runGit(target.primaryPath, ['branch', force ? '-D' : '-d', target.branch]);
}

async function selectBaseRef(cwd: string): Promise<'origin/main' | 'origin/master'> {
  if (await gitSucceeds(cwd, ['show-ref', '--verify', '--quiet', 'refs/remotes/origin/main'])) {
    return 'origin/main';
  }
  if (await gitSucceeds(cwd, ['show-ref', '--verify', '--quiet', 'refs/remotes/origin/master'])) {
    return 'origin/master';
  }
  throw new Error('找不到 base ref：origin/main 或 origin/master。');
}

async function trySelectBaseRef(cwd: string): Promise<'origin/main' | 'origin/master' | undefined> {
  if (await gitSucceeds(cwd, ['show-ref', '--verify', '--quiet', 'refs/remotes/origin/main'])) {
    return 'origin/main';
  }
  if (await gitSucceeds(cwd, ['show-ref', '--verify', '--quiet', 'refs/remotes/origin/master'])) {
    return 'origin/master';
  }
  return undefined;
}

async function gitSucceeds(cwd: string, args: string[]): Promise<boolean> {
  const result = await runGit(cwd, args, { rejectOnFailure: false });
  return result.code === 0;
}

function parseWorktreeListPorcelain(output: string): WorktreeListEntry[] {
  const entries: WorktreeListEntry[] = [];
  let current: WorktreeListEntry | undefined;
  for (const line of output.split('\n')) {
    if (!line.trim()) {
      if (current) entries.push(current);
      current = undefined;
      continue;
    }
    if (line.startsWith('worktree ')) {
      if (current) entries.push(current);
      current = { path: path.resolve(line.slice('worktree '.length)) };
      continue;
    }
    if (line.startsWith('branch ') && current) {
      current.branch = normalizeBranchRef(line.slice('branch '.length));
    }
  }
  if (current) entries.push(current);
  return entries;
}

function normalizeBranchRef(ref: string): string {
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
}

function samePath(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}

async function runGit(
  cwd: string,
  args: string[],
  options: { rejectOnFailure?: boolean } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const rejectOnFailure = options.rejectOnFailure ?? true;
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, shell: false });
    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      const exitCode = code ?? 1;
      if (rejectOnFailure && exitCode !== 0) {
        reject(new Error(stderr.trim() || `git ${args.join(' ')} failed with exit code ${exitCode}`));
        return;
      }
      resolve({ code: exitCode, stdout, stderr });
    });
  });
}

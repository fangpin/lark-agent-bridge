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

async function selectBaseRef(cwd: string): Promise<'origin/main' | 'origin/master'> {
  if (await gitSucceeds(cwd, ['show-ref', '--verify', '--quiet', 'refs/remotes/origin/main'])) {
    return 'origin/main';
  }
  if (await gitSucceeds(cwd, ['show-ref', '--verify', '--quiet', 'refs/remotes/origin/master'])) {
    return 'origin/master';
  }
  throw new Error('找不到 base ref：origin/main 或 origin/master。');
}

async function gitSucceeds(cwd: string, args: string[]): Promise<boolean> {
  const result = await runGit(cwd, args, { rejectOnFailure: false });
  return result.code === 0;
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

import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

function encodeCwd(cwd: string): string {
  return cwd.replace(/\//g, '-');
}

export function claudeProjectHistoryDir(cwd: string, home: string = homedir()): string {
  return join(home, '.claude', 'projects', encodeCwd(cwd));
}

export async function removeLocalAgentHistory(cwd: string, home: string = homedir()): Promise<string[]> {
  const claudeDir = claudeProjectHistoryDir(cwd, home);
  await rm(claudeDir, { recursive: true, force: true });
  return [claudeDir];
}

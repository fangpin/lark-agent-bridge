import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { claudeProjectHistoryDir, removeLocalAgentHistory } from '../../src/session/local-history';

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'lark-agent-local-history-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('local agent history cleanup', () => {
  test('computes the Claude project history directory from cwd', () => {
    expect(claudeProjectHistoryDir('/home/me/repos/project_a_pin_abc', '/home/me')).toBe(
      '/home/me/.claude/projects/-home-me-repos-project_a_pin_abc',
    );
  });

  test('removes Claude history for a cwd and reports removed paths', async () => {
    const home = await tempRoot();
    const cwd = join(home, 'repos', 'project_a_pin_abc');
    const historyDir = claudeProjectHistoryDir(cwd, home);
    await mkdir(historyDir, { recursive: true });
    await writeFile(join(historyDir, 'session.jsonl'), 'history');

    const removed = await removeLocalAgentHistory(cwd, home);

    expect(removed).toEqual([historyDir]);
    await expect(readFile(join(historyDir, 'session.jsonl'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});

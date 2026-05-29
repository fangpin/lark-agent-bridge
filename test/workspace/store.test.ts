import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { WorkspaceStore } from '../../src/workspace/store';

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'lark-agent-workspace-store-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('WorkspaceStore', () => {
  test('persists home-relative cwd values while exposing absolute runtime paths', async () => {
    const root = await tempRoot();
    const home = join(root, 'machine-a');
    const file = join(root, 'workspaces.json');
    const store = new WorkspaceStore(file, { homeDir: home });

    store.setCwd('chat-1', join(home, 'repos', 'bridge'));
    store.saveNamed('bridge', join(home, 'repos', 'bridge'));
    await store.flush();

    const raw = JSON.parse(await readFile(file, 'utf8')) as {
      chats: Record<string, { cwd: string }>;
      named: Record<string, string>;
    };
    expect(raw.chats['chat-1']?.cwd).toBe('repos/bridge');
    expect(raw.named.bridge).toBe('repos/bridge');
    expect(store.cwdFor('chat-1')).toBe(join(home, 'repos', 'bridge'));
    expect(store.getNamed('bridge')).toBe(join(home, 'repos', 'bridge'));
  });

  test('resolves synced relative workspace paths against the current machine home', async () => {
    const root = await tempRoot();
    const file = join(root, 'workspaces.json');
    const currentHome = join(root, 'linux-home');
    await writeFile(
      file,
      JSON.stringify({
        chats: { 'chat-1': { cwd: 'repos/bridge' } },
        named: { bridge: 'repos/bridge' },
      }),
    );

    const store = new WorkspaceStore(file, { homeDir: currentHome });
    await store.load();

    expect(store.cwdFor('chat-1')).toBe(join(currentHome, 'repos', 'bridge'));
    expect(store.listNamed()).toEqual({ bridge: join(currentHome, 'repos', 'bridge') });
  });

  test('normalizes symlinked home paths for chat and named workspaces', async () => {
    const root = await tempRoot();
    const realHome = join(root, 'real-home');
    const aliasHome = join(root, 'alias-home');
    const realCwd = join(realHome, 'repos', 'bridge');
    const aliasCwd = join(aliasHome, 'repos', 'bridge');
    const file = join(root, 'workspaces.json');
    await mkdir(realCwd, { recursive: true });
    await symlink(realHome, aliasHome);
    const store = new WorkspaceStore(file, { homeDir: aliasHome });

    store.setCwd('chat-1', aliasCwd);
    store.saveNamed('bridge', aliasCwd);
    await store.flush();

    const raw = JSON.parse(await readFile(file, 'utf8')) as {
      chats: Record<string, { cwd: string }>;
      named: Record<string, string>;
    };
    expect(raw.chats['chat-1']?.cwd).toBe('repos/bridge');
    expect(raw.named.bridge).toBe('repos/bridge');
    expect(store.cwdFor('chat-1')).toBe(realCwd);
    expect(store.getNamed('bridge')).toBe(realCwd);
    expect(store.listNamed()).toEqual({ bridge: realCwd });
  });
});

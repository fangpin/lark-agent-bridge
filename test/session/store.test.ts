import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { SessionStore } from '../../src/session/store';

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ttadk-session-store-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('SessionStore', () => {
  test('persists home-relative cwd values while exposing absolute runtime entries', async () => {
    const root = await tempRoot();
    const home = join(root, 'machine-a');
    const file = join(root, 'sessions.json');
    const store = new SessionStore(file, { homeDir: home });

    store.set('chat-1', 'session-123', join(home, 'repos', 'bridge'));
    await store.flush();

    const raw = JSON.parse(await readFile(file, 'utf8')) as Record<string, { cwd: string }>;
    expect(raw['chat-1']?.cwd).toBe('repos/bridge');
    expect(store.getRaw('chat-1')?.cwd).toBe(join(home, 'repos', 'bridge'));
    expect(store.resumeFor('chat-1', join(home, 'repos', 'bridge'))).toBe('session-123');
  });

  test('matches synced relative session paths against the current machine home', async () => {
    const root = await tempRoot();
    const file = join(root, 'sessions.json');
    const currentHome = join(root, 'linux-home');
    await writeFile(
      file,
      JSON.stringify({
        'chat-1': {
          sessionId: 'session-123',
          cwd: 'repos/bridge',
          updatedAt: 123,
        },
      }),
    );

    const store = new SessionStore(file, { homeDir: currentHome });
    await store.load();

    expect(store.getRaw('chat-1')?.cwd).toBe(join(currentHome, 'repos', 'bridge'));
    expect(store.resumeFor('chat-1', join(currentHome, 'repos', 'bridge'))).toBe('session-123');
  });

  test('normalizes symlinked home paths when reading and matching sessions', async () => {
    const root = await tempRoot();
    const realHome = join(root, 'real-home');
    const aliasHome = join(root, 'alias-home');
    const realCwd = join(realHome, 'repos', 'bridge');
    const aliasCwd = join(aliasHome, 'repos', 'bridge');
    const file = join(root, 'sessions.json');
    await mkdir(realCwd, { recursive: true });
    await symlink(realHome, aliasHome);
    const store = new SessionStore(file, { homeDir: aliasHome });

    store.set('chat-1', 'session-123', aliasCwd);
    await store.flush();

    const raw = JSON.parse(await readFile(file, 'utf8')) as Record<string, { cwd: string }>;
    expect(raw['chat-1']?.cwd).toBe('repos/bridge');
    expect(store.getRaw('chat-1')?.cwd).toBe(realCwd);
    expect(store.resumeFor('chat-1', realCwd)).toBe('session-123');
    expect(store.resumeFor('chat-1', aliasCwd)).toBe('session-123');
  });
});
